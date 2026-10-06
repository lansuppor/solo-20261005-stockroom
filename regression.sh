#!/bin/sh
# stockroom 本地回归检查：精度边界、取消与冲销、批量回滚、重载及历史重放、补货规则与跨仓补货建议。
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
run product add P10 扳手 >/dev/null
run in H1 --wh W1 --item P10:3 >/dev/null
run in H2 --wh W2 --item P10:50 >/dev/null
run in H3 --wh W3 --item P10:5 >/dev/null
# 采购 4、到货 1、取消 1 -> W1 待到货合计 2（有效到货/有效取消均精确抵减）
run po register PO10 --supplier S10 --wh W1 --item P10:4 >/dev/null
run arrival J1 --po PO10 --item P10:1 >/dev/null
run cancel K1 --po PO10 --item P10:1 >/dev/null
run rule set P10 --wh W1 --min 8 --target 20 >/dev/null
run rule set P10 --wh W2 --min 2 --target 10 >/dev/null
run rule set P10 --wh W3 --min 1 --target 4 >/dev/null
run rule set P10 --wh W4 --min 10 --target 30 >/dev/null
out=$(run rule list)
check "规则列表（4 条，按商品、仓库升序）" "P10	W1	8	20" "$out"
out=$(run rule set P10 --wh W1 --min 8 --target 20)
check "同组合再次设置整体替换" "已替换补货规则" "$out"
check_refuse "下限不小于目标拒绝" "下限 20 必须小于目标 20" rule set P10 --wh W1 --min 20 --target 20
check_refuse "未登记商品拒绝设置规则" "商品未登记" rule set PX --wh W1 --min 1 --target 9
out=$(run rule set P10 --wh W1 --min 8 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 缺少 --target 退出码应为 2，实际 $code"; FAIL=1; }
# W1：实存 4（入库 3 + 到货 1）+ 待到货 2 = 预计量 6 <= 下限 8，缺口 14，全部由 W2 调拨
# W4：实存 0，缺口 30；W2 剩余 26 + W3 可供 1 = 调拨 27，采购 3
out=$(run replenish)
check "W1 预计量=实存+待到货合计并触发" "商品 P10 仓库 W1：下限 8，目标 20，实存 4，待到货合计 2，预计量 6，触发补货，缺口 14" "$out"
check "W1 从 W2 调拨 14、零采购" "调拨 W2 -> W1：14" "$out"
check "W1 调拨合计与零采购" "调拨合计 14，采购量 0" "$out"
check "W2 实存超目标部分可供调拨（自身未触发）" "商品 P10 仓库 W2：下限 2，目标 10，实存 50，待到货合计 0，预计量 50，未触发" "$out"
check "W4 触发且缺口 30" "商品 P10 仓库 W4：下限 10，目标 30，实存 0，待到货合计 0，预计量 0，触发补货，缺口 30" "$out"
check "W4 先用 W2 剩余可供量 26" "调拨 W2 -> W4：26" "$out"
check "W4 再从 W3 取 1" "调拨 W3 -> W4：1" "$out"
check "W4 剩余缺口即采购量" "调拨合计 27，采购量 3" "$out"
out2=$(run replenish)
[ "$out" = "$out2" ] || { echo "FAIL - 同状态两次 replenish 结果不一致"; FAIL=1; }
out3=$(run balance P10 --wh W2)
check "建议查询不改变库存" "余量：商品 P10 仓库 W2 = 50" "$out3"
# 冲销到货后待到货合计按新状态重算（实存扣回为 3，有效到货 0，待到货 3，预计量 6）
run reverse R9 --orig J1 >/dev/null
out=$(run replenish)
check "冲销到货后建议按新状态重算" "实存 3，待到货合计 3，预计量 6，触发补货，缺口 14" "$out"
out=$(run rule delete P10 --wh W4)
check "删除规则成功" "已删除补货规则：商品 P10 仓库 W4" "$out"
check_refuse "删除不存在的规则拒绝" "补货规则不存在" rule delete P10 --wh W4
out=$(run replenish)
check "删除后该组合不再产生需求" "规则 3 条，触发 1 条" "$out"
# 规则随数据保存，重启（新进程）后仍有效
out=$(run rule list)
check "重启后规则仍有效" "P10	W3	1	4" "$out"
# 无规则时明确提示
D6="$TMP/data6"
out=$(node "$APP" -d "$D6" replenish)
check "无规则明确提示" "未配置任何补货规则" "$out"
# 损坏数据：非法补货规则拒绝读取与覆盖
BAD6="$TMP/bad6"
mkdir -p "$BAD6"
cat > "$BAD6/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{},"arrivals":{},"cancels":{},"returns":{},
 "rules":{"P9":{"W":{"min":5,"target":5}}}}
EOF
out=$(node "$APP" -d "$BAD6" rule list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 非法补货规则应拒绝读取（退出码 1，实际 $code）"; FAIL=1
else
  check "非法补货规则拒绝读取" "补货规则非法" "$out"
fi
# 合法旧数据（无 rules 字段）按无规则处理并保留原结果
cat > "$BAD6/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":3}},"entries":[],"docs":{},"reversals":{},
 "purchases":{},"arrivals":{},"cancels":{},"returns":{}}
EOF
out=$(node "$APP" -d "$BAD6" replenish)
check "旧数据无 rules 字段按无规则处理" "未配置任何补货规则" "$out"
out=$(node "$APP" -d "$BAD6" balance P9 --wh W)
check "旧数据原有查询结果保留" "余量：商品 P9 仓库 W = 3" "$out"

echo "== 7. 补货方案：冻结保存、快照核对、一次性落单与重放 =="
D7="$TMP/data7"
run7() { node "$APP" -d "$D7" "$@"; }
run7 product add Q1 螺栓 >/dev/null
run7 product add Q9 干扰件 >/dev/null
run7 in E1 --wh W2 --item Q1:15 >/dev/null
run7 rule set Q1 --wh W1 --min 5 --target 20 >/dev/null
run7 rule set Q1 --wh W2 --min 2 --target 10 >/dev/null
# W1：实存 0，缺口 20；W2 可供 5 -> 调拨 5，采购 15
out=$(run7 plan save PL1 --transfer T1 --purchase PO9:华东五金)
check "方案保存成功并冻结建议" "补货方案 PL1 保存成功" "$out"
check "冻结调拨子单（数量取自建议）" "调拨子单 T1：商品 Q1，W2 -> W1，数量 5" "$out"
check "冻结采购子单（含供应商）" "采购子单 PO9：商品 Q1，收货仓 W1，供应商 华东五金，数量 15" "$out"
out=$(run7 balance Q1 --wh W2)
check "保存方案不改库存" "余量：商品 Q1 仓库 W2 = 15" "$out"
out=$(run7 po show PO9 2>&1)
check "保存方案不占采购子单编号" "采购单 PO9 不存在" "$out"
out=$(run7 plan save PL1 --purchase PO9:华东五金 --transfer T1)
check "同号同输入（顺序无关）重放返回原方案" "返回原方案（不重新计算、不改写数据）" "$out"
out=$(run7 plan save PL1 --transfer T1 --purchase PO9:其他供应商 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 同号改输入退出码应为 1，实际 $code"; FAIL=1; }
check "同号改输入拒绝" "已用于保存输入不同的补货方案" "$out"
out=$(run7 plan save PL2 --transfer T2 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 子单个数不符退出码应为 1，实际 $code"; FAIL=1; }
check "子单个数不符拒绝并说明所需数量" "共 1 条调拨与 1 个正采购缺口" "$out"
# 快照核对：规则改/增、实存变、待到货变均整案拒绝；无关商品变化不影响
run7 rule set Q1 --wh W1 --min 6 --target 20 >/dev/null
out=$(run7 plan execute PL1 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 快照失配退出码应为 1，实际 $code"; FAIL=1; }
check "规则变化整案拒绝并说明差异" "仓库 W1 的补货规则已变化：下限 5 -> 6" "$out"
check "拒绝时提示不替换为新建议" "不替换为新建议" "$out"
run7 rule set Q1 --wh W1 --min 5 --target 20 >/dev/null
run7 in E2 --wh W2 --item Q1:1 >/dev/null
out=$(run7 plan execute PL1 2>&1)
check "实存变化整案拒绝" "仓库 W2 的实存已变化：15 -> 16" "$out"
run7 out E3 --wh W2 --item Q1:1 >/dev/null
run7 po register POX --supplier S --wh W1 --item Q1:2 >/dev/null
out=$(run7 plan execute PL1 2>&1)
check "待到货合计变化整案拒绝" "仓库 W1 的待到货合计已变化：0 -> 2" "$out"
run7 cancel CX --po POX --item Q1:2 >/dev/null
run7 in E4 --wh W1 --item Q9:9 >/dev/null
run7 rule set Q9 --wh W1 --min 1 --target 2 >/dev/null
out=$(run7 plan show PL1)
check "快照失配后方案保留待执行" "（待执行）" "$out"
# 子单编号被对应空间占用（用无关商品占位，不动快照）：整案拒绝、不接管已有单据
run7 in T1 --wh W9 --item Q9:1 >/dev/null
out=$(run7 plan execute PL1 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 编号占用退出码应为 1，实际 $code"; FAIL=1; }
check "拟用编号被占用整案拒绝" "调拨子单编号 T1 已被库存单据编号空间占用" "$out"
out=$(run7 plan show PL1)
check "占用拒绝后方案保留待执行" "（待执行）" "$out"
out=$(run7 po show PO9 2>&1)
check "占用拒绝不留采购子单" "采购单 PO9 不存在" "$out"
out=$(run7 balance Q1 --wh W1)
check "占用拒绝不改库存" "余量：商品 Q1 仓库 W1 = 0" "$out"
# 编号一旦占用不会释放（T1 已被占），改用另一方案编号与新子单编号验证成功落单
run7 plan save PL3 --transfer T3 --purchase PO7:华东五金 >/dev/null
out=$(run7 plan execute PL3)
check "快照一致且编号空闲时落单成功" "补货方案 PL3 执行成功：调拨 1 单、采购 1 单已落单" "$out"
check "调拨实际减来源增目标" "调拨 Q1 W2 -> W1 5：W2 15->10；W1 0->5" "$out"
out=$(run7 balance Q1 --wh W1)
check "落单后目标仓余量可读回" "余量：商品 Q1 仓库 W1 = 5" "$out"
out=$(run7 po show PO7)
check "采购子单仅登记待收承诺" "Q1	15	0	15	未到货" "$out"
out=$(run7 flow --product Q1 --wh W1)
check "流水可读回调拨子单" "单据=T3	调拨" "$out"
out=$(run7 plan execute PL3)
check "执行后再执行返回原落单结果" "已执行，返回原落单结果（不再核对快照、不再生效，不改写数据）" "$out"
# 子单后来冲销不影响已执行方案的重放与重载
run7 reverse RV3 --orig T3 >/dev/null
out=$(run7 plan execute PL3)
check "子单冲销后重放仍返回原结果" "返回原落单结果" "$out"
out=$(run7 plan show PL3)
check "已执行状态持久（新进程重载）" "（已执行）" "$out"
# 无建议拒绝保存
out=$(run7 plan save PL9 --transfer T9 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 无建议退出码应为 1，实际 $code"; FAIL=1; }
check "无建议拒绝保存" "当前无补货建议" "$out"
# 用法错误退出 2
out=$(run7 plan save 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - plan save 缺参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run7 plan bogus 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 未知 plan 子命令退出码应为 2，实际 $code"; FAIL=1; }
# 损坏方案（已执行方案子单关联缺失）拒读拒写
BAD7="$TMP/bad7"
mkdir -p "$BAD7"
cat > "$BAD7/stockroom.json" <<'EOF'
{"version":1,"products":{"Q1":"x"},"stock":{"Q1":{"W1":5,"W2":10}},
 "entries":[{"seq":1,"doc":"T3","type":"transfer","product":"Q1","wh":"W2","qty":5,"before":15,"after":10,"from":"W2","to":"W1"},
            {"seq":2,"doc":"T3","type":"transfer","product":"Q1","wh":"W1","qty":5,"before":0,"after":5,"from":"W2","to":"W1"}],
 "docs":{"T3":{"content":{"type":"transfer","from":"W2","to":"W1","items":{"Q1":5}},"resultLines":["x"]}},
 "reversals":{},"purchases":{},"arrivals":{},"cancels":{},"returns":{},
 "rules":{"Q1":{"W1":{"min":5,"target":20},"W2":{"min":2,"target":10}}},
 "plans":{"PL3":{"input":{"transfers":["T3"],"purchases":[{"id":"PO7","supplier":"S"}]},
   "transfers":[{"docId":"T3","pid":"Q1","from":"W2","to":"W1","qty":5}],
   "purchases":[{"poId":"PO7","supplier":"S","pid":"Q1","wh":"W1","qty":15}],
   "snapshot":{"rules":{"Q1":{"W1":{"min":5,"target":20},"W2":{"min":2,"target":10}}},
               "combos":{"Q1":{"W1":{"onHand":0,"pending":"0"},"W2":{"onHand":15,"pending":"0"}}}},
   "status":"executed","resultLines":["x"]}}}
EOF
out=$(node "$APP" -d "$BAD7" plan show PL3 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 已执行方案子单关联缺失应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "已执行方案子单关联缺失拒读" "采购子单 PO7 不存在" "$out"
fi
# 旧数据（无 plans 字段）直接可用并保留历史结果
out=$(node "$APP" -d "$BAD6" plan show PL0 2>&1)
check "旧数据无 plans 字段按无方案处理" "补货方案 PL0 不存在" "$out"

echo
if [ $FAIL -eq 0 ]; then echo "全部回归检查通过"; else echo "存在失败项"; exit 1; fi
