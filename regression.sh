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

echo "== 7. 补货方案：保存、查看与一次性落单 =="
D7="$TMP/data7"
run7() { node "$APP" -d "$D7" "$@"; }
check_refuse7() { # check_refuse7 <描述> <期望错误文本> <命令...>（在 D7 数据目录下）
  desc=$1; want=$2; shift 2
  out=$(run7 "$@" 2>&1); code=$?
  if [ $code -ne 1 ]; then
    echo "FAIL - $desc（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
  else
    check "$desc" "$want" "$out"
  fi
}
run7 product add Q1 扳手 >/dev/null
run7 product add Q2 无关件 >/dev/null
run7 in G1 --wh W1 --item Q1:3 >/dev/null
run7 in G2 --wh W2 --item Q1:50 >/dev/null
run7 in G3 --wh W3 --item Q1:5 >/dev/null
run7 rule set Q1 --wh W1 --min 8 --target 20 >/dev/null
run7 rule set Q1 --wh W2 --min 2 --target 10 >/dev/null
run7 rule set Q1 --wh W3 --min 1 --target 4 >/dev/null
run7 rule set Q1 --wh W4 --min 10 --target 30 >/dev/null
# 建议：W1 缺口 17（全由 W2 调拨，零采购）；W4 缺口 30（W2 出 23、W3 出 1、采购 6）
out=$(run7 plan save PL1 --transfer Q1:W2:W1:T1 --transfer Q1:W2:W4:T2 --transfer Q1:W3:W4:T3 --purchase Q1:W4:PO9:华东五金)
check "保存方案成功（待执行）" "补货方案 PL1 保存成功" "$out"
check "冻结调拨来源/目标/数量" "调拨子单 T2：商品 Q1，W2 -> W4，数量 23" "$out"
check "冻结采购供应商与子单编号" "采购子单 PO9：商品 Q1，收货仓 W4，数量 6，供应商 华东五金" "$out"
out=$(run7 balance Q1 --wh W2)
check "保存不改库存" "余量：商品 Q1 仓库 W2 = 50" "$out"
out=$(run7 po list)
check "保存不登记采购" "（暂无采购单）" "$out"
# 保存不占子单编号：另一方案 PL0 的子单号仍可作为普通单据/采购单编号使用
run7 plan save PL0 --transfer Q1:W2:W1:TX1 --transfer Q1:W2:W4:TX2 --transfer Q1:W3:W4:TX3 --purchase Q1:W4:PX1:某供应商 >/dev/null
out=$(run7 in TX1 --wh W9 --item Q2:1)
check "保存不占调拨子单编号（TX1 可作普通单据）" "入库单 TX1 提交成功" "$out"
out=$(run7 po register PX1 --supplier S --wh W9 --item Q2:1)
check "保存不占采购子单编号（PX1 可作采购单）" "采购单 PX1 登记成功" "$out"
# 同号同输入重放（明细顺序无关）返回原方案；同号改输入拒绝
out=$(run7 plan save PL1 --purchase Q1:W4:PO9:华东五金 --transfer Q1:W3:W4:T3 --transfer Q1:W2:W4:T2 --transfer Q1:W2:W1:T1)
check "同号同输入重放返回原方案" "为重复保存" "$out"
check_refuse7 "同号改输入拒绝" "保存输入不同" plan save PL1 --transfer Q1:W2:W1:T1 --transfer Q1:W2:W4:T2 --transfer Q1:W3:W4:T3 --purchase Q1:W4:PO8:华东五金
check_refuse7 "缺少子单指定拒绝" "缺少采购子单指定" plan save PL2 --transfer Q1:W2:W1:T1
check_refuse7 "多指定零采购子单拒绝" "不存在该正采购缺口" plan save PL2 --transfer Q1:W2:W1:T1 --transfer Q1:W2:W4:T2 --transfer Q1:W3:W4:T3 --purchase Q1:W1:POX:SX
out=$(run7 plan show PL1)
check "查看方案状态与明细" "状态 待执行" "$out"
check "展示调拨来源与目标仓" "调拨子单 T1：商品 Q1，W2 -> W1，数量 17" "$out"
out=$(run7 plan list)
check "方案列表" "PL1	待执行	调拨 3 份	采购 1 份" "$out"
# 无关商品变化不使方案过期
run7 rule set Q2 --wh W1 --min 1 --target 9 >/dev/null
run7 in G4 --wh W1 --item Q2:2 >/dev/null
# 快照核对：实存变化整案拒绝并说明差异，恢复后可重试
run7 in G5 --wh W1 --item Q1:1 >/dev/null
check_refuse7 "实存变化整案拒绝执行" "商品 Q1 仓库 W1 实存：快照 3，当前 4" plan execute PL1
run7 reverse RV2 --orig G5 >/dev/null
# 规则增删也算变化
run7 rule set Q1 --wh W9 --min 1 --target 2 >/dev/null
check_refuse7 "新增规则使方案过期" "商品 Q1 仓库 W9 新增补货规则" plan execute PL1
run7 rule delete Q1 --wh W9 >/dev/null
# 待到货合计变化（采购登记到 W1）使方案过期
run7 po register POA --supplier SA --wh W1 --item Q1:1 >/dev/null
check_refuse7 "待到货合计变化整案拒绝" "商品 Q1 仓库 W1 待到货合计：快照 0，当前 1" plan execute PL1
run7 cancel CA --po POA --item Q1:1 >/dev/null   # 取消后待到货回到 0
# 条件恢复后执行成功：调拨实际减来源增目标，采购仅登记待收
out=$(run7 plan execute PL1)
check "一次性落单成功" "补货方案 PL1 执行成功，全部子单已落单：" "$out"
check "调拨子单实际变动" "调拨 Q1 W2 -> W1 17：W2 50->33；W1 3->20" "$out"
check "采购子单仅登记待收" "订购 Q1 x6，待到货 6" "$out"
out=$(run7 balance Q1 --wh W4)
check "落单后目标仓余量真实可读" "余量：商品 Q1 仓库 W4 = 24" "$out"
out=$(run7 po show PO9)
check "采购子单进度可查" "Q1	6	0	6	未到货" "$out"
out=$(run7 flow --product Q1 --wh W2)
check "流水含方案调拨子单" "单据=T2	调拨	商品=Q1	仓库=W2	-23	33->10" "$out"
# 已执行重放：返回原结果、不再生效、不改写文件
out=$(run7 plan execute PL1)
check "已执行重放返回原落单结果" "已执行，返回原落单结果" "$out"
out=$(run7 balance Q1 --wh W1)
check "重放不再生效" "余量：商品 Q1 仓库 W1 = 20" "$out"
out=$(run7 plan show PL1)
check "已执行状态可查" "状态 已执行" "$out"
# 子单后来被冲销也不重建
run7 reverse RV3 --orig T3 >/dev/null
out=$(run7 plan execute PL1)
check "子单冲销后重放仍只返回原结果" "已执行，返回原落单结果" "$out"
out=$(run7 balance Q1 --wh W3)
check "冲销结果真实保留（W3 补回）" "余量：商品 Q1 仓库 W3 = 5" "$out"
# 无建议拒绝保存
check_refuse7 "无触发建议拒绝保存" "当前无补货建议" plan save PLZ
# 子单编号占用：即使内容相同也整案拒绝，不接管已有单据
run7 product add Q3 垫片 >/dev/null
run7 in G6 --wh W1 --item Q3:1 >/dev/null
run7 rule set Q3 --wh W1 --min 5 --target 10 >/dev/null
run7 rule set Q3 --wh W2 --min 0 --target 2 >/dev/null
run7 in G7 --wh W2 --item Q3:5 >/dev/null
run7 plan save PL3 --transfer Q3:W2:W1:TD --purchase Q3:W1:POD:S3 >/dev/null
run7 in TD --wh W9 --item Q3:1 >/dev/null
check_refuse7 "拟用调拨编号被占用整案拒绝" "调拨子单编号 TD 已被占用" plan execute PL3
out=$(run7 plan show PL3)
check "占用拒绝后方案保留待执行" "状态 待执行" "$out"
run7 po register POD --supplier S3 --wh W9 --item Q2:8 >/dev/null   # 占用采购编号空间，不影响 Q3 快照
run7 plan save PL4 --transfer Q3:W2:W1:TD2 --purchase Q3:W1:POD:S3 >/dev/null
check_refuse7 "拟用采购编号被占用整案拒绝" "采购子单编号 POD 已被占用" plan execute PL4
# 格式错误退出 2
out=$(run7 plan save 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - plan save 缺参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run7 plan save PLX --transfer Q3:W2:W1 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 调拨子单格式错误退出码应为 2，实际 $code"; FAIL=1; }
out=$(run7 plan badsub 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 未知 plan 子命令退出码应为 2，实际 $code"; FAIL=1; }
# 特殊标识 __proto__ 正常使用
D8="$TMP/data8"
node "$APP" -d "$D8" product add __proto__ 特殊件 >/dev/null
node "$APP" -d "$D8" rule set __proto__ --wh W1 --min 5 --target 10 >/dev/null
out=$(node "$APP" -d "$D8" plan save __proto__ --purchase __proto__:W1:__proto__:供应商X)
check "__proto__ 方案保存" "补货方案 __proto__ 保存成功" "$out"
out=$(node "$APP" -d "$D8" plan execute __proto__)
check "__proto__ 方案执行" "补货方案 __proto__ 执行成功" "$out"
out=$(node "$APP" -d "$D8" po show __proto__)
check "__proto__ 采购子单可查" "采购单 __proto__：供应商 供应商X" "$out"
# 损坏方案拒读：已执行方案子单关联断裂
BAD7="$TMP/bad7"
mkdir -p "$BAD7"
cat > "$BAD7/stockroom.json" <<'EOF'
{"version":1,"products":{"Q9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{},"arrivals":{},"cancels":{},"returns":{},"rules":{"Q9":{"W1":{"min":1,"target":5}}},
 "plans":{"PL9":{"planId":"PL9","status":"executed","execResultLines":["x"],
   "transfers":[{"docId":"T9","product":"Q9","from":"W2","to":"W1","qty":3}],"purchases":[],
   "snapshot":{"rules":{"Q9":{"W1":{"min":1,"target":5}}},"stock":{"Q9":{"W1":0}},"pending":{"Q9":{"W1":"0"}}}}}}
EOF
out=$(node "$APP" -d "$BAD7" plan list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 已执行方案子单关联断裂应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "已执行方案子单关联断裂拒读" "调拨子单 T9 不存在" "$out"
fi
# 旧数据无 plans 字段直接可用
out=$(node "$APP" -d "$BAD6" plan list)
check "旧数据无 plans 字段按无方案处理" "（暂无补货方案）" "$out"
# 重启（新进程）后方案与重放限制仍成立
out=$(run7 plan execute PL1)
check "重启后已执行重放仍成立" "已执行，返回原落单结果" "$out"
check_refuse7 "重启后同号改输入仍拒绝" "保存输入不同" plan save PL1 --transfer Q1:W2:W1:T1 --transfer Q1:W2:W4:T2 --transfer Q1:W3:W4:T3 --purchase Q1:W4:PO7:别的供应商

echo "== 8. 期间库存对账报表 =="
D9="$TMP/data9"
run9() { node "$APP" -d "$D9" "$@"; }
check_refuse9() { # check_refuse9 <描述> <期望错误文本> <命令...>（在 D9 数据目录下）
  desc=$1; want=$2; shift 2
  out=$(run9 "$@" 2>&1); code=$?
  if [ $code -ne 1 ]; then
    echo "FAIL - $desc（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
  else
    check "$desc" "$want" "$out"
  fi
}
run9 product add P1 螺丝 >/dev/null
run9 product add P2 螺母 >/dev/null
run9 in D1 --wh W1 --item P1:10 --item P2:5 >/dev/null      # #1 P1@W1 +10；#2 P2@W1 +5
run9 in D2 --wh W2 --item P1:3 >/dev/null                   # #3 P1@W2 +3
run9 transfer D3 --from W1 --to W2 --item P1:2 >/dev/null   # #4 W1 -2；#5 W2 +2
run9 count C1 --wh W1 --item P2:5:5 >/dev/null              # #6 零差额盘点
run9 po register PO1 --supplier S --wh W1 --item P1:4 >/dev/null
run9 arrival A1 --po PO1 --item P1:4 >/dev/null             # #7 P1@W1 +4
run9 return T1 --arrival A1 --item P1:1 >/dev/null          # #8 P1@W1 -1
run9 out D4 --wh W1 --item P1:1 >/dev/null                  # #9 P1@W1 -1
run9 reverse R1 --orig D4 >/dev/null                        # #10 P1@W1 +1
run9 cancel X1 --po PO1 --item P1:1 >/dev/null              # 无库存流水
run9 po register D2 --supplier S2 --wh W9 --item P2:1 >/dev/null  # 同名采购不干扰库存单定位
# 全库全期间
out=$(run9 reconcile)
check "全库报表：P1@W1 期初/增减/净变动/期末" "商品 P1 仓库 W1：期初 0，期间增加 15，期间减少 4，净变动 +11，期末 11" "$out"
check "小计按业务类型与是否冲销分列" "小计（出库·冲销）：+1" "$out"
check "调拨按调出方向计减少" "小计（调拨·原单）：-2" "$out"
check "到货计入实存" "小计（到货·原单）：+4" "$out"
check "退货计入实存" "小计（退货·原单）：-1" "$out"
check "零差额盘点保留追溯（小计为 0）" "小计（盘点·原单）：0" "$out"
check "P1@W2 调入方向计增加" "商品 P1 仓库 W2：期初 0，期间增加 5，期间减少 0，净变动 +5，期末 5" "$out"
check "期间流水带采购与原到货关联" "#8	单据=T1	退货	商品=P1	仓库=W1	-1	12->11	采购单=PO1	原到货单=A1" "$out"
check "冲销流水标注原单" "#10	单据=R1	冲销出库	商品=P1	仓库=W1	+1	10->11	原单=D4" "$out"
check "逐商品汇总所选仓库" "商品 P1 汇总（所选仓库）：期初 0，期间增加 20，期间减少 4，净变动 +16，期末 16" "$out"
check "原单冲销状态（截至当前）" "原单 D4 已由冲销单 R1 冲销" "$out"
# 期间边界：起点不含、终点含
out=$(run9 reconcile --from D1 --to D3)
check "起点不含该单（期初为起点完成后状态）" "商品 P1 仓库 W1：期初 10，期间增加 0，期间减少 2，净变动 -2，期末 8" "$out"
check "终点包含该单全部流水（调拨两端不拆开）" "商品 P1 仓库 W2：期初 0，期间增加 5，期间减少 0，净变动 +5，期末 5" "$out"
check "期初非零但期间无流水的组合仍展示" "商品 P2 仓库 W1：期初 5，期间增加 0，期间减少 0，净变动 0，期末 5" "$out"
case $out in
  *"已由冲销单"*) echo "FAIL - 终点之前的报表不应含后续冲销状态"; FAIL=1 ;;
  *) echo "ok   - 终点之后的冲销不影响历史报表" ;;
esac
# 同一单作两端 = 空期间
out=$(run9 reconcile --from D3 --to D3)
check "同一单作两端提示空期间" "期间为空" "$out"
check "空期间期初等于期末" "商品 P1 仓库 W1：期初 8，期间增加 0，期间减少 0，净变动 0，期末 8" "$out"
# 冲销单与零差额盘点可作边界
out=$(run9 reconcile --from C1 --to R1 --product P1 --wh W1)
check "零差额盘点与冲销单可作边界" "商品 P1 仓库 W1：期初 8，期间增加 5，期间减少 2，净变动 +3，期末 11" "$out"
# 同名采购不干扰库存单定位（D2 是入库单，也是采购单）
out=$(run9 reconcile --from D2 --product P1 --wh W1)
check "同名采购不干扰库存单定位" "起点 D2（不含该单" "$out"
# 筛选
out=$(run9 reconcile --product P2 --wh W2)
check "无匹配组合明确提示" "无匹配的组合" "$out"
out=$(run9 reconcile --wh W2)
check "按仓库筛选" "商品 P1 仓库 W2：期初 0，期间增加 5，期间减少 0，净变动 +5，期末 5" "$out"
# 边界拒绝
check_refuse9 "采购单不能用作边界" "是采购单：采购登记不产生库存流水" reconcile --from PO1
check_refuse9 "取消单不能用作边界" "是取消单：取消不产生库存流水" reconcile --to X1
check_refuse9 "不存在的边界拒绝" "不存在或没有库存流水" reconcile --from NOPE
check_refuse9 "起点晚于终点拒绝" "首次提交顺序晚于终点单据" reconcile --from D4 --to D1
# 参数格式错误退出 2
out=$(run9 reconcile --bogus x 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 未知参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run9 reconcile D1 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 多余位置参数退出码应为 2，实际 $code"; FAIL=1; }
# 只读：反复查询不改写数据
SUM_BEFORE=$(cksum -o 3 "$D9/stockroom.json")
run9 reconcile >/dev/null
run9 reconcile --from D1 --to D3 --product P1 >/dev/null
SUM_AFTER=$(cksum -o 3 "$D9/stockroom.json")
[ "$SUM_BEFORE" = "$SUM_AFTER" ] || { echo "FAIL - reconcile 改写了数据文件"; FAIL=1; }
echo "ok   - 反复查询不创建或改写数据"
# 特殊标识：含冒号与 __proto__ 的商品/仓库/单据可定位与筛选
D10="$TMP/data10"
node "$APP" -d "$D10" product add "a:1" 冒号件 >/dev/null
node "$APP" -d "$D10" product add __proto__ 特殊件 >/dev/null
cat > "$TMP/imp10.json" <<'EOF'
[{"type":"in","id":"D:1","wh":"w:1","items":[{"product":"a:1","qty":7},{"product":"__proto__","qty":2}]},
 {"type":"out","id":"D2","wh":"w:1","items":[{"product":"__proto__","qty":1}]}]
EOF
node "$APP" -d "$D10" import --file "$TMP/imp10.json" >/dev/null
out=$(node "$APP" -d "$D10" reconcile --product "a:1")
check "含冒号商品与仓库可筛选" "商品 a:1 仓库 w:1：期初 0，期间增加 7，期间减少 0，净变动 +7，期末 7" "$out"
out=$(node "$APP" -d "$D10" reconcile --from "D:1" --product __proto__)
check "含冒号单据可作边界、__proto__ 可筛选" "商品 __proto__ 仓库 w:1：期初 2，期间增加 0，期间减少 1，净变动 -1，期末 1" "$out"
# 精度：期间增加合计超安全整数仍完整十进制显示
D11="$TMP/data11"
node "$APP" -d "$D11" product add P1 螺丝 >/dev/null
node "$APP" -d "$D11" in A1 --wh W --item P1:${M} >/dev/null
node "$APP" -d "$D11" out A2 --wh W --item P1:${M} >/dev/null
node "$APP" -d "$D11" in A3 --wh W --item P1:${M} >/dev/null
out=$(node "$APP" -d "$D11" reconcile --product P1)
check "期间增加合计超安全整数完整显示" "期间增加 18014398509481982，期间减少 ${M}，净变动 +${M}，期末 ${M}" "$out"
# 一致性核对失败：不输出部分报表、不自动修复
BAD9="$TMP/bad9"
mkdir -p "$BAD9"
cat > "$BAD9/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":8}},
 "entries":[{"seq":1,"doc":"A","type":"in","product":"P9","wh":"W","qty":5,"before":0,"after":5},
            {"seq":2,"doc":"B","type":"in","product":"P9","wh":"W","qty":3,"before":1,"after":4}],
 "docs":{"A":{"content":{"type":"in","wh":"W","items":{"P9":5}},"resultLines":[]},
         "B":{"content":{"type":"in","wh":"W","items":{"P9":3}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$BAD9" reconcile 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 余量不连续应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "余量连续性核对失败拒报" "不连续，拒绝输出报表" "$out"
  case $out in
    *"期末"*) echo "FAIL - 不一致时不应输出部分报表"; FAIL=1 ;;
    *) echo "ok   - 不一致时不输出部分报表" ;;
  esac
fi
cat > "$BAD9/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W2":2}},
 "entries":[{"seq":1,"doc":"T","type":"transfer","product":"P9","wh":"W2","qty":2,"before":0,"after":2,"from":"W1","to":"W2"}],
 "docs":{"T":{"content":{"type":"transfer","from":"W1","to":"W2","items":{"P9":2}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$BAD9" reconcile 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 调拨缺一端应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "调拨两端完整性核对失败拒报" "两端流水不完整" "$out"
fi
cat > "$BAD9/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":3}},
 "entries":[{"seq":1,"doc":"A","type":"in","product":"P9","wh":"W","qty":5,"before":0,"after":5}],
 "docs":{"A":{"content":{"type":"in","wh":"W","items":{"P9":5}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$BAD9" reconcile 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 末笔与实存不一致应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "末笔余量与实存不一致拒报" "与当前实存 3 不一致" "$out"
fi
# 旧数据（无采购/规则/方案等字段、流水与实存一致）无需迁移即可出报表
OLD9="$TMP/old9"
mkdir -p "$OLD9"
cat > "$OLD9/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":5}},
 "entries":[{"seq":1,"doc":"D1","type":"in","product":"P9","wh":"W","qty":5,"before":0,"after":5}],
 "docs":{"D1":{"content":{"type":"in","wh":"W","items":{"P9":5}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$OLD9" reconcile)
check "合法旧 JSON 无需迁移即可出报表" "商品 P9 仓库 W：期初 0，期间增加 5，期间减少 0，净变动 +5，期末 5" "$out"
# 有实存但无任何流水的组合视为末笔与实存不一致
cat > "$BAD9/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":3}},"entries":[],"docs":{},"reversals":{}}
EOF
out=$(node "$APP" -d "$BAD9" reconcile 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 有实存无流水应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "有实存无流水视为不一致拒报" "流水末笔余量 0 与当前实存 3 不一致" "$out"
fi

echo
if [ $FAIL -eq 0 ]; then echo "全部回归检查通过"; else echo "存在失败项"; exit 1; fi
