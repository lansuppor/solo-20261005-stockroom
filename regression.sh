#!/bin/sh
# stockroom 本地回归检查：精度边界、取消与冲销、批量回滚、重载及历史重放、补货规则与建议。
# 用法：sh regression.sh （在仓库根目录执行；需要 Node.js 24）
set -u
cd "$(dirname "$0")"
APP="app.ts"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL=0
D="$TMP/data"

run() { node "$APP" -d "$D" "$@"; }

check() { # check <描述> <期望出现于输出中的文本> <实际输出>
  desc=$1; want=$2; got=$3
  case $got in
    *"$want"*) echo "ok   - $desc" ;;
    *) echo "FAIL - $desc"; echo "  期望包含: $want"; echo "  实际输出: $got"; FAIL=1 ;;
  esac
}

check_refuse() { # check_refuse <描述> <期望错误文本> <命令...>
  desc=$1; want=$2; shift 2
  out=$(run "$@" 2>&1); code=$?
  if [ $code -ne 1 ]; then
    echo "FAIL - $desc（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
  else
    check "$desc" "$want" "$out"
  fi
}

M=9007199254740991   # Number.MAX_SAFE_INTEGER

echo "== 1. 精度边界：订购并到货 ${M}，两次各退 1 再补收 1 =="
run product add P1 螺丝 >/dev/null
run po register PO1 --supplier S1 --wh W1 --item P1:${M} >/dev/null
run arrival A1 --po PO1 --item P1:${M} >/dev/null
run return T1 --arrival A1 --item P1:1 >/dev/null
out=$(run arrival A2 --po PO1 --item P1:1)
check "第一次补收 1 件（累计到货 2^53，精确不超收）" "待到货 0" "$out"
run return T2 --arrival A2 --item P1:1 >/dev/null
out=$(run arrival A3 --po PO1 --item P1:1)
# 累计到货 = 2^53+1（超过安全整数），有效到货必须精确等于订购量
check "第二次补收后有效到货精确等于订购量" "有效到货 ${M}/${M}，待到货 0" "$out"
out=$(run po show PO1)
check "po show 有效到货=${M} 待到货=0 状态收齐" "P1	${M}	${M}	2	0	收齐" "$out"
out=$(run po list)
check "po list 汇总状态收齐" "PO1	供应商=S1	收货仓=W1	1 种商品	收齐" "$out"
# 出库腾出入仓容量后，仍不得再到货或取消 1 件（待到货精确为 0）
run out O1 --wh W1 --item P1:100 >/dev/null
check_refuse "腾出库存后再到货 1 件须拒绝（待到货为 0）" "待到货 0，本次 1，拒绝整单" arrival A4 --po PO1 --item P1:1
check_refuse "待到货为 0 时取消 1 件须拒绝" "待到货 0，本次取消 1，拒绝整单" cancel X9 --po PO1 --item P1:1

echo "== 2. 有效退货合计超过安全整数范围时完整显示 =="
run product add P2 螺母 >/dev/null
run po register PO2 --supplier S2 --wh W2 --item P2:${M} >/dev/null
run arrival B1 --po PO2 --item P2:${M} >/dev/null
run return U1 --arrival B1 --item P2:${M} >/dev/null
run arrival B2 --po PO2 --item P2:${M} >/dev/null
run return U2 --arrival B2 --item P2:${M} >/dev/null
# 有效退货合计 = 2*(2^53-1) = 18014398509481982，超过安全整数，须完整显示
out=$(run po show PO2)
check "有效退货合计 18014398509481982 完整十进制显示" "P2	${M}	0	18014398509481982	${M}	未到货" "$out"

echo "== 3. 取消与冲销 =="
run product add P3 垫圈 >/dev/null
run po register PO3 --supplier S3 --wh W3 --item P3:10 >/dev/null
run arrival C1 --po PO3 --item P3:6 >/dev/null
out=$(run cancel X1 --po PO3 --item P3:2)
check "取消 2 件后待到货 2" "待到货 2" "$out"
check_refuse "超量取消拒绝（待到货 2 取消 3）" "待到货 2，本次取消 3，拒绝整单" cancel X2 --po PO3 --item P3:3
out=$(run reverse R1 --orig X1)
check "冲销取消恢复待到货" "待到货 4" "$out"
run return V1 --arrival C1 --item P3:2 >/dev/null
check_refuse "有未冲销退货的到货单禁止冲销" "存在未冲销的退货单 V1，禁止冲销" reverse R2 --orig C1
out=$(run reverse R3 --orig V1)
check "冲销退货恢复有效到货" "有效到货回升至 6/10，待到货 4" "$out"
out=$(run reverse R2 --orig C1)
check "退货冲销后可冲销到货" "冲销到货 原单=C1" "$out"
out=$(run po show PO3)
check "冲销后采购进度回到初始" "P3	10	0	0	0	10	未到货" "$out"
check_refuse "每张原单最多冲销一次" "已被冲销单 R2 成功冲销" reverse R4 --orig C1
out=$(run reverse R2 --orig C1)
check "成功冲销同号同原单重放返回原结果" "冲销单 R2 为重复提交" "$out"

echo "== 4. 批量回滚：任一项拒绝则本批不保存、不占编号 =="
cat > "$TMP/batch1.json" <<'EOF'
[
  {"type":"po","id":"PO4","supplier":"S4","wh":"W1","items":[{"product":"P1","qty":5}]},
  {"type":"arrival","id":"G1","po":"PO4","items":[{"product":"P1","qty":3}]},
  {"type":"arrival","id":"G2","po":"PO4","items":[{"product":"P1","qty":3}]}
]
EOF
out=$(run import --file "$TMP/batch1.json" 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 批量拒绝退出码应为 1，实际 $code"; FAIL=1; }
check "批量导入指出位置与原因" "第 3 项" "$out"
check "批量导入说明超收原因" "到货超收" "$out"
out=$(run po show PO4 2>&1)
check "批内前项不保存（PO4 未登记）" "采购单 PO4 不存在" "$out"
# 同号可重试：修正后整批成功
cat > "$TMP/batch2.json" <<'EOF'
[
  {"type":"po","id":"PO4","supplier":"S4","wh":"W1","items":[{"product":"P1","qty":5}]},
  {"type":"arrival","id":"G1","po":"PO4","items":[{"product":"P1","qty":3}]},
  {"type":"arrival","id":"G2","po":"PO4","items":[{"product":"P1","qty":2}]}
]
EOF
out=$(run import --file "$TMP/batch2.json")
check "修正后同号重试整批成功" "首次生效 3 项" "$out"
out=$(run import --file "$TMP/batch2.json")
check "全部重复不改写文件（重复 3 项）" "首次生效 0 项，重复 3 项" "$out"

echo "== 5. 重载及历史重放 =="
# 新进程重载：精度边界场景进度仍精确
out=$(run po show PO1)
check "重载后 PO1 进度仍精确（收齐）" "P1	${M}	${M}	2	0	收齐" "$out"
check_refuse "重载后仍不得超量到货" "待到货 0，本次 1，拒绝整单" arrival A5 --po PO1 --item P1:1
# 历史结果保留原文：A3 提交时待到货 0，重放仍返回原结果且不生效
out=$(run arrival A3 --po PO1 --item P1:1)
check "成功旧单同号同内容重放返回原结果" "为重复提交" "$out"
check "重放结果保留原文（待到货 0）" "待到货 0" "$out"
out=$(run po show PO1)
check "重放不重新生效（仍收齐）" "P1	${M}	${M}	2	0	收齐" "$out"
# 损坏数据拒绝读取：篡改有效取消使待到货为负（有效到货 1 + 有效取消 5 > 订购 5）
BAD="$TMP/bad"
mkdir -p "$BAD"
cat > "$BAD/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":1}},
 "entries":[{"seq":1,"doc":"A9","type":"arrival","product":"P9","wh":"W","qty":1,"before":0,"after":1,"po":"PO9"}],
 "docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W","ordered":{"P9":5},"resultLines":[]}},
 "arrivals":{"A9":{"poId":"PO9","wh":"W","qty":{"P9":1},"resultLines":[]}},
 "cancels":{"X9":{"poId":"PO9","qty":{"P9":5},"resultLines":[]}},
 "returns":{}}
EOF
out=$(node "$APP" -d "$BAD" po show PO9 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 负待到货损坏数据应拒绝读取（退出码 1，实际 $code）"; FAIL=1
else
  check "负待到货损坏数据拒绝读取" "待到货量为负" "$out"
fi

echo "== 6. 补货规则与跨仓补货建议 =="
run product add P4 扳手 >/dev/null
run in I1 --wh WH-A --item P4:100 >/dev/null
run in I2 --wh WH-B --item P4:3 >/dev/null
run reorder set P4 --wh WH-A --min 10 --target 50 >/dev/null   # 实存 100 > 目标 50，可供 50
run reorder set P4 --wh WH-B --min 10 --target 20 >/dev/null
run reorder set P4 --wh WH-C --min 0 --target 5 >/dev/null     # 无库存记录视为零
run reorder set P4 --wh WH-D --min 0 --target 100 >/dev/null
run po register PO6 --supplier S6 --wh WH-B --item P4:4 >/dev/null  # WH-B 待收 4
out=$(run reorder list)
check "规则列表含全部组合" "P4	WH-B	10	20" "$out"
out=$(run reorder suggest)
check "WH-A 未触发（预计量高于下限）" "P4	WH-A	10	50	100	0	100	未触发" "$out"
check "WH-B 预计量=实存3+待收4=7 触发" "P4	WH-B	10	20	3	4	7	触发" "$out"
check "WH-B 从 WH-A 调拨 13、零采购" "调拨 WH-A -> WH-B：13" "$out"
check "WH-B 调拨合计与零采购" "调拨合计 13，采购量 0" "$out"
check "WH-C 缺口 5 全部由调拨补足" "调拨 WH-A -> WH-C：5" "$out"
check "WH-D 来源耗尽后剩余缺口采购（50-13-5=32）" "调拨 WH-A -> WH-D：32" "$out"
check "WH-D 采购量 68" "调拨合计 32，采购量 68" "$out"
# 取消减少待收：WH-B 待收 4->2，预计量 5，缺口 15
run cancel X6 --po PO6 --item P4:2 >/dev/null
out=$(run reorder suggest)
check "取消后待收下降、缺口增大" "P4	WH-B	10	20	3	2	5	触发" "$out"
check "取消后调拨量按新状态重算" "调拨 WH-A -> WH-B：15" "$out"
# 到货不重复计入待收：到货 2 后实存 5、待收 0，预计量仍为 5
run arrival A6 --po PO6 --item P4:2 >/dev/null
out=$(run reorder suggest)
check "到货后实存升、待收降，预计量不重复计入" "P4	WH-B	10	20	5	0	5	触发" "$out"
# 再次设置整体替换：WH-B 下限降为 1 后不再触发
out=$(run reorder set P4 --wh WH-B --min 1 --target 6)
check "再次设置整体替换" "已整体替换补货规则：商品 P4 仓库 WH-B，下限 1，目标 6" "$out"
out=$(run reorder suggest)
check "替换后 WH-B 预计量高于新下限不再触发" "P4	WH-B	1	6	5	0	5	未触发" "$out"
# 删除规则后该组合不再出现；重复删除拒绝
run reorder remove P4 --wh WH-D >/dev/null
out=$(run reorder suggest)
case $out in
  *"WH-D"*) echo "FAIL - 删除后 WH-D 不应再出现"; FAIL=1 ;;
  *) echo "ok   - 删除后 WH-D 不再产生需求" ;;
esac
check_refuse "重复删除规则拒绝" "没有补货规则，拒绝删除" reorder remove P4 --wh WH-D
check_refuse "下限不小于目标拒绝" "必须小于目标" reorder set P4 --wh WH-A --min 5 --target 5
check_refuse "未登记商品拒绝设置规则" "商品未登记，拒绝设置补货规则：PX" reorder set PX --wh WH-A --min 1 --target 2
out=$(run reorder set P4 --wh WH-A --min 1 2>&1); code=$?
if [ $code -ne 2 ]; then
  echo "FAIL - 缺少 --target 应退出 2，实际 $code"; FAIL=1
else
  check "缺少 --target 报用法错误退出 2" "必须提供 --target" "$out"
fi
# 建议只读：查询前后数据文件不变
before=$(cksum < "$D/stockroom.json")
run reorder suggest >/dev/null
after=$(cksum < "$D/stockroom.json")
if [ "$before" = "$after" ]; then echo "ok   - 建议查询不写文件"; else echo "FAIL - 建议查询改写了数据文件"; FAIL=1; fi
# 重启（新进程）后规则仍有效
out=$(run reorder list)
check "重载后规则仍有效" "P4	WH-A	10	50" "$out"
# 合法旧数据（无 reorderRules 字段）按无规则处理并保留原结果
OLD="$TMP/old"
mkdir -p "$OLD"
cat > "$OLD/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":3}},"entries":[],"docs":{}}
EOF
out=$(node "$APP" -d "$OLD" reorder suggest)
check "旧数据按无规则处理" "未配置任何补货规则，无补货建议" "$out"
out=$(node "$APP" -d "$OLD" balance P9)
check "旧数据原有查询结果保留" "仓库 W：3" "$out"
# 损坏数据：非法补货规则拒绝读取与覆盖
BAD2="$TMP/bad2"
mkdir -p "$BAD2"
cat > "$BAD2/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{},"entries":[],"docs":{},
 "reorderRules":{"P9":{"W":{"min":5,"target":5}}}}
EOF
out=$(node "$APP" -d "$BAD2" reorder suggest 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 非法补货规则应拒绝读取（退出码 1，实际 $code）"; FAIL=1
else
  check "非法补货规则拒绝读取" "下限必须小于目标" "$out"
fi
out=$(node "$APP" -d "$BAD2" reorder set P9 --wh W --min 1 --target 2 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 损坏数据上设置规则应拒绝（退出码 1，实际 $code）"; FAIL=1
else
  check "损坏数据拒绝被覆盖" "拒绝启动以免覆盖原数据" "$out"
fi

echo
if [ $FAIL -eq 0 ]; then echo "全部回归检查通过"; else echo "存在失败项"; exit 1; fi
