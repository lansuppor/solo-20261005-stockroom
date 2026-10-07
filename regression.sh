#!/bin/sh
# stockroom 本地回归检查：精度边界、取消与冲销、采购待收转单与转单冲销、批量回滚、重载及历史重放、补货规则与跨仓补货建议。
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
run9 product add PA 甲件 >/dev/null
run9 product add PB 乙件 >/dev/null
run9 in S1 --wh WA --item PA:10 --item PB:5 >/dev/null      # seq1-2
run9 in S2 --wh WB --item PA:3 >/dev/null                   # seq3
run9 transfer S3 --from WA --to WB --item PA:2 >/dev/null   # seq4-5
run9 out S4 --wh WA --item PA:1 >/dev/null                  # seq6
run9 count S5 --wh WA --item PA:7:7 >/dev/null              # seq7 零差额盘点
run9 po register PO9 --supplier S --wh WA --item PA:4 >/dev/null
run9 arrival S6 --po PO9 --item PA:4 >/dev/null             # seq8
run9 return S7 --arrival S6 --item PA:1 >/dev/null          # seq9
run9 reverse S8 --orig S4 >/dev/null                        # seq10 冲销出库
run9 cancel S9 --po PO9 --item PA:1 >/dev/null              # 无库存流水
run9 reverse S10 --orig S9 >/dev/null                       # 冲销取消：无库存流水
run9 po register S1 --supplier 同名采购 --wh WB --item PB:1 >/dev/null  # 同名采购不干扰

out=$(run9 recon)
check "全库报表：PA@WA 期初/增加/减少/净变动/期末勾稽" \
  "组合 商品=PA 仓库=WA：期初 0，期间增加 15，期间减少 4，净变动 +11，期末 11" "$out"
check "全库报表：PA@WA 业务小计（含零差额盘点与冲销）" \
  "业务小计：入库 +10；出库 -1；调拨 -2；盘点 0；到货 +4；退货 -1；冲销出库 +1" "$out"
check "全库报表：PA@WB 调拨按调入方向计增" \
  "组合 商品=PA 仓库=WB：期初 0，期间增加 5，期间减少 0，净变动 +5，期末 5" "$out"
check "全库报表：零差额盘点流水保留追溯" "单据=S5	盘点	商品=PA	仓库=WA	差额=0	7->7" "$out"
check "全库报表：原单冲销状态（含终点后全部冲销）" "原单 S4 已由冲销单 S8 冲销（以终点时刻为准）" "$out"
check "全库报表：逐商品汇总跨仓合计" \
  "商品 PA（仓库：WA、WB）：期初 0，期间增加 20，期间减少 4，净变动 +16，期末 16" "$out"
check "全库报表：数据核对通过提示" "数据核对通过：完整流水 10 条余量连续" "$out"

out=$(run9 recon --from S2 --to S5)
check "指定边界：起点不含、终点含" "筛选：无（覆盖全库）" "$out"
check "指定边界：PA@WA 期初取起点后状态" \
  "组合 商品=PA 仓库=WA：期初 10，期间增加 0，期间减少 3，净变动 -3，期末 7" "$out"
check "指定边界：期间无流水但期初非零的组合仍展示" \
  "组合 商品=PB 仓库=WA：期初 5，期间增加 0，期间减少 0，净变动 0，期末 5" "$out"
check "指定边界：期间无流水的组合小计提示" "业务小计：（期间无流水）" "$out"
check "指定边界：逐商品汇总" \
  "商品 PA（仓库：WA、WB）：期初 13，期间增加 2，期间减少 3，净变动 -1，期末 12" "$out"

out=$(run9 recon --from S3 --to S3)
check "同一单作两端为空期间" "期间流水（0 条，按提交顺序）：" "$out"
check "空期间明确提示无期间流水" "（无期间流水）" "$out"
check "空期间期初等于期末" "组合 商品=PA 仓库=WA：期初 8，期间增加 0，期间减少 0，净变动 0，期末 8" "$out"

check_refuse9 "起点晚于终点拒绝" "起点单据 S5 的提交顺序晚于终点单据 S2" recon --from S5 --to S2
check_refuse9 "边界单据不存在拒绝" "起点单据 NOPE 不存在或没有库存流水" recon --from NOPE
check_refuse9 "只有采购记录的编号不可用作边界" "只有采购登记记录，没有库存流水" recon --from PO9
check_refuse9 "只有取消记录的编号不可用作边界" "只有取消记录，没有库存流水" recon --from S9
check_refuse9 "冲销取消单无流水不可用作边界" "冲销取消单的冲销单，没有库存流水" recon --to S10
out=$(run9 recon --from S1)
check "同名采购单不干扰库存单定位" "期间：起点=单据 S1 全部流水完成后（不含该单）" "$out"

out=$(run9 recon --to S7)
case $out in
  *"原单 S4 已由冲销单"*) echo "FAIL - 终点之后的冲销不应影响历史报表"; FAIL=1 ;;
  *) echo "ok   - 冲销状态以终点时刻为准（终点后冲销不计）" ;;
esac
out=$(run9 recon --to S8)
check "终点含冲销单时原单状态可见" "原单 S4 已由冲销单 S8 冲销（以终点时刻为准）" "$out"

out=$(run9 recon --product PA --wh WA)
check "商品+仓库同时筛选" "筛选：商品=PA 仓库=WA" "$out"
case $out in
  *"仓库=WB"*) echo "FAIL - 筛选后不应出现其他仓库组合"; FAIL=1 ;;
  *) echo "ok   - 筛选后不含其他仓库组合" ;;
esac
out=$(run9 recon --product PX)
check "无匹配组合明确提示" "（无匹配组合：所选范围内期初、期末均为零且期间无流水）" "$out"

out=$(run9 recon --bogus x 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 未知参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run9 recon S1 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 多余位置参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run9 recon --from 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 参数缺取值退出码应为 2，实际 $code"; FAIL=1; }

# 只读：反复查询不创建或改写数据
sum1=$(cksum < "$D9/stockroom.json")
run9 recon >/dev/null
run9 recon --from S2 --to S8 --product PA >/dev/null
sum2=$(cksum < "$D9/stockroom.json")
[ "$sum1" = "$sum2" ] || { echo "FAIL - recon 改写了数据文件"; FAIL=1; }
echo "ok   - recon 只读不改写数据"
D9E="$TMP/data9e"
out=$(node "$APP" -d "$D9E" recon)
check "空库报表明确提示" "（无匹配组合" "$out"
[ ! -e "$D9E/stockroom.json" ] || { echo "FAIL - 空库 recon 不应创建数据文件"; FAIL=1; }
echo "ok   - 空库 recon 不创建数据文件"

echo "== 9. 对账报表：超安全整数合计与特殊标识 =="
D10="$TMP/data10"
run10() { node "$APP" -d "$D10" "$@"; }
run10 product add P 大件 >/dev/null
run10 in B1 --wh W --item P:${M} >/dev/null
run10 out B2 --wh W --item P:${M} >/dev/null
run10 in B3 --wh W --item P:${M} >/dev/null
out=$(run10 recon)
check "期间增加合计超安全整数完整十进制显示" \
  "期初 0，期间增加 18014398509481982，期间减少 9007199254740991，净变动 +9007199254740991，期末 9007199254740991" "$out"
check "逐商品汇总合计同样精确" \
  "商品 P（仓库：W）：期初 0，期间增加 18014398509481982，期间减少 9007199254740991" "$out"

D11="$TMP/data11"
node "$APP" -d "$D11" product add 'P:1' 冒号件 >/dev/null
node "$APP" -d "$D11" product add '__proto__' 特殊件 >/dev/null
cat > "$TMP/imp11.json" <<'EOF'
[
  {"type":"in","id":"D:1","wh":"W:1","items":[{"product":"P:1","qty":4}]},
  {"type":"in","id":"D2","wh":"W1","items":[{"product":"__proto__","qty":2}]}
]
EOF
node "$APP" -d "$D11" import --file "$TMP/imp11.json" >/dev/null
out=$(node "$APP" -d "$D11" recon --product 'P:1' --wh 'W:1')
check "含冒号标识可筛选" "组合 商品=P:1 仓库=W:1：期初 0，期间增加 4，期间减少 0，净变动 +4，期末 4" "$out"
out=$(node "$APP" -d "$D11" recon --from 'D:1')
check "含冒号单据编号可定位边界" "期间：起点=单据 D:1 全部流水完成后（不含该单）" "$out"
out=$(node "$APP" -d "$D11" recon --product '__proto__')
check "__proto__ 商品可筛选" "组合 商品=__proto__ 仓库=W1：期初 0，期间增加 2，期间减少 0，净变动 +2，期末 2" "$out"

echo "== 10. 对账报表：数据不一致拒报（不输出部分报表、不自动修复） =="
BAD10="$TMP/bad10"
mkdir -p "$BAD10"
cat > "$BAD10/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":2}},
 "entries":[
  {"seq":1,"doc":"D1","type":"in","product":"P9","wh":"W","qty":5,"before":0,"after":5},
  {"seq":2,"doc":"D2","type":"out","product":"P9","wh":"W","qty":3,"before":4,"after":1}],
 "docs":{
  "D1":{"content":{"type":"in","wh":"W","items":{"P9":5}},"resultLines":[]},
  "D2":{"content":{"type":"out","wh":"W","items":{"P9":3}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$BAD10" recon 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 余量不连续应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "余量不连续拒报" "库存流水余量不连续" "$out"
  case $out in
    *"组合 商品="*) echo "FAIL - 拒报时不应输出部分报表"; FAIL=1 ;;
    *) echo "ok   - 拒报时不输出部分报表" ;;
  esac
fi
cat > "$BAD10/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W1":0,"W2":5}},
 "entries":[
  {"seq":1,"doc":"T1","type":"transfer","product":"P9","wh":"W2","qty":5,"before":0,"after":5,"from":"W1","to":"W2"}],
 "docs":{"T1":{"content":{"type":"transfer","from":"W1","to":"W2","items":{"P9":5}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$BAD10" recon 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 调拨两端不完整应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "调拨两端不完整拒报" "调拨流水两端不完整" "$out"
fi
cat > "$BAD10/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":3}},
 "entries":[
  {"seq":1,"doc":"D1","type":"in","product":"P9","wh":"W","qty":5,"before":0,"after":5}],
 "docs":{"D1":{"content":{"type":"in","wh":"W","items":{"P9":5}},"resultLines":[]}},
 "reversals":{}}
EOF
out=$(node "$APP" -d "$BAD10" recon 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 末笔余量与实存不一致应拒报（退出码 1，实际 $code）"; FAIL=1
else
  check "末笔余量与当前实存不一致拒报" "末笔流水 #1 余量 5 与当前实存 3 不一致" "$out"
fi

echo "== 11. 采购待收转单与转单冲销 =="
D12="$TMP/data12"
run12() { node "$APP" -d "$D12" "$@"; }
check_refuse12() { # check_refuse12 <描述> <期望错误文本> <命令...>（在 D12 数据目录下）
  desc=$1; want=$2; shift 2
  out=$(run12 "$@" 2>&1); code=$?
  if [ $code -ne 1 ]; then
    echo "FAIL - $desc（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
  else
    check "$desc" "$want" "$out"
  fi
}
run12 product add P1 螺丝 >/dev/null
run12 product add P2 螺母 >/dev/null
run12 po register PO1 --supplier S1 --wh W1 --item P1:10 --item P2:5 >/dev/null
run12 arrival A1 --po PO1 --item P1:4 >/dev/null
run12 cancel X1 --po PO1 --item P2:1 >/dev/null
# 基本转单：P1 待到货 6 转 3；P2 待到货 4 转 2（同商品 1+1 先合并）
out=$(run12 potransfer PT1 --from PO1 --to PO2 --supplier S2 --wh W2 --item P1:3 --item P2:1 --item P2:1)
check "转单成功首行（含两单与目的供应商/收货仓）" \
  "转单 PT1 提交成功，原采购单 PO1 -> 目的采购单 PO2（供应商 S2，收货仓 W2），共 2 种商品" "$out"
check "转单逐商品说明两单前后待收（P1）" \
  "转出 P1 x3：原采购单 PO1 待到货 6 -> 3；目的采购单 PO2 待到货 0 -> 3" "$out"
check "转单同商品先合并（P2 1+1=2）" \
  "转出 P2 x2：原采购单 PO1 待到货 4 -> 2；目的采购单 PO2 待到货 0 -> 2" "$out"
out=$(run12 balance P1 --wh W1)
check "转单不改库存" "余量：商品 P1 仓库 W1 = 4" "$out"
out=$(run12 flow --product P1)
check "转单不产生库存流水" "共 1 条" "$out"
out=$(run12 po show PO1)
check "原单有效取消含转出量（不误报收齐）" "P1	10	4	3	3	部分到货（仍待收）" "$out"
check "原单展示转单关联" "转单 PT1（有效）：转出至目的采购单 PO2（供应商 S2，收货仓 W2）" "$out"
out=$(run12 po show PO2)
check "目的单订购量等于转出量" "P1	3	0	0	3	未到货" "$out"
check "目的单展示转入关联" "转单 PT1（有效）：自原采购单 PO1 转入" "$out"
# 幂等与编号规则
out=$(run12 potransfer PT1 --from PO1 --to PO2 --supplier S2 --wh W2 --item P2:2 --item P1:3)
check "同号同全部内容重放返回原结果（顺序无关）" "转单 PT1 为重复提交" "$out"
check_refuse12 "同号改内容拒绝" "已用于内容不同的单据" \
  potransfer PT1 --from PO1 --to PO2 --supplier S2 --wh W2 --item P1:4
check_refuse12 "目的编号已被采购占用即拒绝（即使内容相同）" "已被采购单占用" \
  potransfer PT2 --from PO1 --to PO2 --supplier S2 --wh W2 --item P1:1
check_refuse12 "超转出整单拒绝" "待到货 3，本次转出 4，拒绝整单" \
  potransfer PT3 --from PO1 --to PO9 --supplier S3 --wh W3 --item P1:4
check_refuse12 "原采购单不存在拒绝" "原采购单 NOPE 不存在" \
  potransfer PT4 --from NOPE --to PO8 --supplier S3 --wh W3 --item P1:1
check_refuse12 "商品不在原单内拒绝" "不在原采购单 PO1 的订购明细内" \
  potransfer PT5 --from PO1 --to PO8 --supplier S3 --wh W3 --item P3:1
out=$(run12 potransfer PT3 --from PO1 --to PO9 --supplier S3 --wh W3 --item P1:2)
check "失败不占转单编号，可重试成功" "转单 PT3 提交成功" "$out"
check_refuse12 "转单编号与到货单冲突" "已用于到货单" \
  potransfer A1 --from PO1 --to PO7 --supplier S --wh W --item P1:1
check_refuse12 "到货单编号与转单冲突" "已用于转单" arrival PT3 --po PO1 --item P1:1
out=$(run12 potransfer 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - potransfer 缺参数退出码应为 2，实际 $code"; FAIL=1; }
# 目的单可按普通采购到货、取消、再转单
run12 arrival A2 --po PO2 --item P1:1 >/dev/null
run12 cancel X2 --po PO2 --item P2:1 >/dev/null
out=$(run12 potransfer PT6 --from PO2 --to PO6 --supplier S6 --wh W6 --item P1:1)
check "目的单可再转单" "转单 PT6 提交成功，原采购单 PO2 -> 目的采购单 PO6" "$out"
check_refuse12 "目的单未全量待收禁止冲销转单" "未保持全量待收" reverse R1 --orig PT1
# 历史业务合法恢复全量待收后可冲销：先冲销目的单的到货、取消与再转单
run12 reverse RV2 --orig A2 >/dev/null
run12 reverse RV3 --orig X2 >/dev/null
run12 reverse RV4 --orig PT6 >/dev/null
out=$(run12 reverse R1 --orig PT1)
check "恢复全量待收后可冲销转单" "冲销单 R1 提交成功，冲销转单原单 PT1（原采购单 PO1，目的采购单 PO2）" "$out"
check "冲销转单恢复原单待收" "原采购单 PO1 待到货 1 -> 4（移除本转单的有效取消）" "$out"
check "冲销转单目的单全部计为取消" "目的采购单 PO2 订购 3 全部计为取消，待到货 3 -> 0" "$out"
out=$(run12 po show PO1)
check "冲销后原单待收恢复（P1 待到货 4）" "P1	10	4	2	4	部分到货（仍待收）" "$out"
out=$(run12 po show PO2)
check "冲销后目的单结清不误报收齐" "P1	3	0	3	0	已结清（含取消）" "$out"
check "目的单展示转单冲销关联" "转单 PT1（已由冲销单 R1 整单冲销" "$out"
check_refuse12 "转单冲销后目的单不可再到货" "待到货 0，本次 1，拒绝整单" arrival A9 --po PO2 --item P1:1
check_refuse12 "转单冲销后目的单不可再取消" "待到货 0，本次取消 1，拒绝整单" cancel X9 --po PO2 --item P1:1
check_refuse12 "转单冲销后目的单不可再转出" "待到货 0，本次转出 1，拒绝整单" \
  potransfer PT8 --from PO2 --to PO8 --supplier S --wh W --item P1:1
# 冲销幂等与限制
out=$(run12 reverse R1 --orig PT1)
check "成功冲销同号同原单重放返回原结果" "冲销单 R1 为重复提交" "$out"
check_refuse12 "每张转单最多冲销一次" "每张转单只能冲销一次" reverse R7 --orig PT1
check_refuse12 "同冲销编号改指其他原单拒绝" "不能改冲原单 A1" reverse R1 --orig A1
check_refuse12 "冲销单不可冲销" "冲销单不可冲销" reverse R8 --orig R1
out=$(run12 potransfer PT1 --from PO1 --to PO2 --supplier S2 --wh W2 --item P1:3 --item P2:2)
check "已冲销转单同号同内容重放仍只返回原结果" "转单 PT1 为重复提交" "$out"
# 补货建议按含转单的净进度计算（PO9 收货仓 W3 待到货 2；PO1 收货仓 W1 待到货 4）
run12 rule set P1 --wh W1 --min 3 --target 9 >/dev/null
run12 rule set P1 --wh W3 --min 5 --target 10 >/dev/null
out=$(run12 replenish)
check "补货待到货合计含转单净进度（W1）" "商品 P1 仓库 W1：下限 3，目标 9，实存 4，待到货合计 4，预计量 8，未触发" "$out"
check "补货待到货合计含转单净进度（W3）" "商品 P1 仓库 W3：下限 5，目标 10，实存 0，待到货合计 2，预计量 2，触发补货，缺口 8" "$out"
# 转单及其冲销无库存流水，不能用作对账期间边界
check_refuse12 "只有转单记录的编号不可用作边界" "只有转单记录，没有库存流水" recon --from PT3
check_refuse12 "冲销转单的冲销单不可用作边界" "是冲销转单的冲销单，没有库存流水" recon --to R1
# 有序导入：转单及冲销，后项使用前项状态
cat > "$TMP/batch-pt.json" <<'EOF'
[
  {"type":"po","id":"POI1","supplier":"SI","wh":"W1","items":[{"product":"P1","qty":8}]},
  {"type":"potransfer","id":"PTI1","from":"POI1","to":"POI2","supplier":"SI2","wh":"W2","items":[{"product":"P1","qty":3}]},
  {"type":"reverse","id":"RI1","orig":"PTI1"}
]
EOF
out=$(run12 import --file "$TMP/batch-pt.json")
check "导入转单及冲销成功" "首次生效 3 项" "$out"
out=$(run12 po show POI1)
check "导入冲销转单后原单待收恢复" "P1	8	0	0	8	未到货" "$out"
out=$(run12 import --file "$TMP/batch-pt.json")
check "全部重复不改写数据" "首次生效 0 项，重复 3 项" "$out"
# 批量回滚：第二项超转出，整批拒绝且本批目的采购不保留
cat > "$TMP/batch-pt-bad.json" <<'EOF'
[
  {"type":"potransfer","id":"PTI2","from":"POI1","to":"POI3","supplier":"S","wh":"W1","items":[{"product":"P1","qty":5}]},
  {"type":"potransfer","id":"PTI3","from":"POI1","to":"POI4","supplier":"S","wh":"W1","items":[{"product":"P1","qty":9}]}
]
EOF
out=$(run12 import --file "$TMP/batch-pt-bad.json" 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 转单批量拒绝退出码应为 1，实际 $code"; FAIL=1; }
check "批量拒绝指出位置" "第 2 项" "$out"
check "批量拒绝说明超转出原因" "转出量超出原采购单待到货量" "$out"
out=$(run12 po show POI3 2>&1)
check "批内前项目的采购不保留" "采购单 POI3 不存在" "$out"
out=$(run12 potransfer PTI2 --from POI1 --to POI3 --supplier S --wh W1 --item P1:5)
check "批量失败后新编号可复用" "转单 PTI2 提交成功" "$out"
# 损坏数据拒读：目的采购不存在、内容不一致、负待到货（转出量超订购）
BAD12="$TMP/bad12"
mkdir -p "$BAD12"
cat > "$BAD12/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W","ordered":{"P9":5},"resultLines":[]}},
 "arrivals":{},"cancels":{},"returns":{},
 "poTransfers":{"PT9":{"fromPo":"PO9","toPo":"POX","supplier":"S2","wh":"W2","qty":{"P9":3},"resultLines":[]}}}
EOF
out=$(node "$APP" -d "$BAD12" po list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 目的采购不存在应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "损坏转单（目的采购不存在）拒读" "转单 PT9 指向的目的采购单 POX 不存在" "$out"
fi
cat > "$BAD12/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W","ordered":{"P9":5},"resultLines":[]},
              "POX":{"poId":"POX","supplier":"S2","wh":"W2","ordered":{"P9":2},"resultLines":[]}},
 "arrivals":{},"cancels":{},"returns":{},
 "poTransfers":{"PT9":{"fromPo":"PO9","toPo":"POX","supplier":"S2","wh":"W2","qty":{"P9":3},"resultLines":[]}}}
EOF
out=$(node "$APP" -d "$BAD12" po list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 目的采购内容不一致应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "损坏转单（目的采购内容不一致）拒读" "与目的采购单 POX 的供应商、收货仓或订购量不一致" "$out"
fi
cat > "$BAD12/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W","ordered":{"P9":5},"resultLines":[]},
              "POX":{"poId":"POX","supplier":"S2","wh":"W2","ordered":{"P9":6},"resultLines":[]}},
 "arrivals":{},"cancels":{},"returns":{},
 "poTransfers":{"PT9":{"fromPo":"PO9","toPo":"POX","supplier":"S2","wh":"W2","qty":{"P9":6},"resultLines":[]}}}
EOF
out=$(node "$APP" -d "$BAD12" po list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 转出量超订购（负待到货）应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "损坏转单（负待到货）拒读" "待到货量为负" "$out"
fi
# 旧数据无 poTransfers 字段直接可用并保留历史结果
cat > "$BAD12/stockroom.json" <<'EOF'
{"version":1,"products":{"P9":"x"},"stock":{"P9":{"W":3}},"entries":[],"docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W","ordered":{"P9":5},"resultLines":[]}},
 "arrivals":{},"cancels":{},"returns":{}}
EOF
out=$(node "$APP" -d "$BAD12" po show PO9)
check "旧数据无 poTransfers 字段按无转单处理" "P9	5	0	5	未到货" "$out"
# 特殊标识：__proto__ 与含冒号编号可正常转单
D13="$TMP/data13"
node "$APP" -d "$D13" product add __proto__ 特殊件 >/dev/null
node "$APP" -d "$D13" po register 'PO:1' --supplier S --wh W1 --item __proto__:5 >/dev/null
out=$(node "$APP" -d "$D13" potransfer '__proto__' --from 'PO:1' --to 'PO:2' --supplier 'S:2' --wh 'W:2' --item __proto__:2)
check "__proto__ 与含冒号标识可正常转单" "转单 __proto__ 提交成功，原采购单 PO:1 -> 目的采购单 PO:2" "$out"
out=$(node "$APP" -d "$D13" reverse 'R:1' --orig '__proto__')
check "特殊标识转单可冲销" "冲销单 R:1 提交成功，冲销转单原单 __proto__" "$out"

echo
if [ $FAIL -eq 0 ]; then echo "全部回归检查通过"; else echo "存在失败项"; exit 1; fi
