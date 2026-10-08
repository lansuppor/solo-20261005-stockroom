#!/bin/sh
# stockroom 本地回归检查：精度边界、取消与冲销、批量回滚、重载及历史重放、补货规则与跨仓补货建议、
# 补货方案保存/执行/整案撤回、期间库存对账报表、采购待收转单、多进程写入协调。
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
    echo "FAIL - ${desc}（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
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
    echo "FAIL - ${desc}（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
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
    echo "FAIL - ${desc}（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
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

echo "== 11. 采购待收转单与整单冲销 =="
D12="$TMP/data12"
run12() { node "$APP" -d "$D12" "$@"; }
check_refuse12() { # check_refuse12 <描述> <期望错误文本> <命令...>
  desc=$1; want=$2; shift 2
  out=$(run12 "$@" 2>&1); code=$?
  if [ $code -ne 1 ]; then
    echo "FAIL - ${desc}（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
  else
    check "$desc" "$want" "$out"
  fi
}
run12 product add P1 螺丝 >/dev/null
run12 product add P2 螺母 >/dev/null
run12 product add P3 垫片 >/dev/null
run12 po register PO1 --supplier S1 --wh W1 --item P1:10 --item P2:5 >/dev/null
run12 arrival A1 --po PO1 --item P1:4 >/dev/null
# 转单：P1 转 2（待收 6->4），P2 转 5（待收 5->0），目的单 PO2 在 W2/S2 全量待收
out=$(run12 po-transfer F1 --orig PO1 --dest PO2 --supplier S2 --wh W2 --item P1:2 --item P2:5)
check "转单成功汇总两仓供应商" "采购转单 F1 提交成功：原采购单 PO1 -> 目的采购单 PO2（供应商 S2，收货仓 W2），共 2 种商品（不改库存与流水）：" "$out"
check "转单 P1 两单前后待收" "转单 P1 x2：原采购单 PO1 待收 6 -> 4；目的采购单 PO2 待收 0 -> 2" "$out"
check "转单 P2 两单前后待收" "转单 P2 x5：原采购单 PO1 待收 5 -> 0；目的采购单 PO2 待收 0 -> 5" "$out"
out=$(run12 po show PO1)
check "原单 P1 净进度（有效取消含转出）" "P1	10	4	2	4	部分到货（仍待收）" "$out"
check "原单 P2 转空即结清不误报收齐" "P2	5	0	5	0	已结清（含取消）" "$out"
check "po show 列出转出关联" "转出（本单为原单）转单 F1：至目的采购单 PO2" "$out"
out=$(run12 po show PO2)
check "目的单标注来源转单" "由采购转单 F1 自原采购单 PO1 转入创建" "$out"
check "目的单 P1 全量待收" "P1	2	0	0	2	未到货" "$out"
check "目的单 P2 全量待收" "P2	5	0	0	5	未到货" "$out"
check_refuse12 "超当前待收转出整单拒绝" "当前待收 4，本次转出 5，拒绝整单" \
  po-transfer FX --orig PO1 --dest POX --supplier SX --wh WX --item P1:5
check_refuse12 "非原单商品拒绝" "不在原采购单 PO1 的订购明细内" \
  po-transfer FY --orig PO1 --dest POY --supplier SY --wh WY --item P3:1
run12 po register POE --supplier SE --wh WE --item P1:2 >/dev/null
check_refuse12 "目的编号已被采购占用即使内容相同也拒绝" "目的采购编号 POE 已被采购占用" \
  po-transfer FZ --orig PO1 --dest POE --supplier S2 --wh W2 --item P1:2
run12 arrival F9 --po PO1 --item P1:1 >/dev/null
check_refuse12 "转单编号与到货单共用空间冲突" "单据编号 F9 已用于到货单" \
  po-transfer F9 --orig PO1 --dest POQ --supplier SQ --wh WQ --item P1:1
# 失败不占编号：FX 此前被超量拒绝，现可成功使用
out=$(run12 po-transfer FX --orig PO1 --dest POX --supplier SX --wh WX --item P1:1)
check "失败不占编号，同号可重试" "采购转单 FX 提交成功" "$out"
# 目的单按普通采购到货/取消/再转单
run12 arrival A2 --po PO2 --item P1:2 --item P2:5 >/dev/null
out=$(run12 po show PO2)
check "目的单到货后收齐" "P2	5	5	0	0	收齐" "$out"
# 转单冲销：目的单非全量待收时拒绝
check_refuse12 "目的单有到货时冲销转单拒绝" "目的采购单 PO2 商品 P1 已非全量待收" \
  reverse R1 --orig F1
# 不能把目的采购单本身拿去冲销（采购单不可冲销）
check_refuse12 "目的采购单不可冲销（转单效应不能作取消单冲销）" "是采购单，采购单不可冲销" \
  reverse RBAD1 --orig PO2
run12 reverse RA2 --orig A2 >/dev/null   # 冲销目的单到货（W2 扣回），恢复全量待收
# 历史业务已合法恢复全量待收，允许冲销转单
out=$(run12 reverse R1 --orig F1)
check "恢复全量待收后冲销转单成功" "冲销单 R1 提交成功，冲销采购转单 F1（原采购单 PO1，目的采购单 PO2），共 2 种商品：" "$out"
check "冲销移回原单 P1 待收" "原采购单 PO1 待收 2 -> 4" "$out"
check "冲销移回原单 P2 待收" "原采购单 PO1 待收 0 -> 5" "$out"
check "目的单 P1 订购量计取消、待收归零" "目的采购单 PO2 全部订购量 2 计为取消，待收 2 -> 0" "$out"
out=$(run12 po show PO1)
check "冲销后原单 P1 转出取消已移除（含 FX 的 1）" "P1	10	5	1	4	部分到货（仍待收）" "$out"
check "冲销后原单 P2 待收恢复" "P2	5	0	0	5	未到货" "$out"
out=$(run12 po show PO2)
check "目的单 P1 已结清（含取消）不误报收齐" "P1	2	0	2	0	已结清（含取消）" "$out"
check_refuse12 "关闭的目的单不能再到货" "待到货 0，本次 1，拒绝整单" arrival A3 --po PO2 --item P1:1
check_refuse12 "关闭的目的单不能再转单" "当前待收 0，本次转出 1，拒绝整单" \
  po-transfer FG --orig PO2 --dest POG --supplier SG --wh WG --item P1:1
check_refuse12 "每张转单最多冲销一次" "每张转单只能冲销一次" reverse R2 --orig F1
out=$(run12 reverse R1 --orig F1)
check "同冲销编号同原单重放返回原结果" "冲销单 R1 为重复提交" "$out"
check_refuse12 "冲销单不可冲销" "冲销单不可冲销" reverse R3 --orig R1
out=$(run12 po-transfer F1 --orig PO1 --dest PO2 --supplier S2 --wh W2 --item P1:2 --item P2:5)
check "冲销后同转单同内容重放仍只返回原结果" "采购转单 F1 为重复提交" "$out"
check "重放结果保留原文（待收 6 -> 4）" "原采购单 PO1 待收 6 -> 4" "$out"
check_refuse12 "同转单编号改内容拒绝" "已用于内容不同的单据" \
  po-transfer F1 --orig PO1 --dest PO2 --supplier S2 --wh W2 --item P1:1
# 原单待收恢复后可再次转单
out=$(run12 po-transfer F3 --orig PO1 --dest PO3 --supplier S3 --wh W3 --item P1:4 --item P2:5)
check "原单恢复后可再转单" "采购转单 F3 提交成功：原采购单 PO1 -> 目的采购单 PO3" "$out"
# 目的单也可以再转单
out=$(run12 po-transfer F4 --orig PO3 --dest PO4 --supplier S4 --wh W4 --item P1:4)
check "目的单可再转单" "采购转单 F4 提交成功：原采购单 PO3 -> 目的采购单 PO4" "$out"
# 转单与其冲销均不产生库存流水（库存流水里不应出现转单/冲销转单编号）
out=$(run12 flow --product P1)
case "$out" in
  *"单据=F1"*|*"单据=R1"*) echo "FAIL - 转单或其冲销不应产生库存流水"; echo "$out"; FAIL=1 ;;
  *) echo "ok   - 转单与其冲销不产生库存流水" ;;
esac
# po list 汇总状态随净进度
out=$(run12 po list)
check "po list 关闭目的单为已结清（含取消）" "PO2	供应商=S2	收货仓=W2	2 种商品	已结清（含取消）" "$out"
# 批量导入：转单+冲销后项用前项状态；任一项失败整批回滚
cat > "$TMP/batch12a.json" <<'EOF'
[
  {"type":"po","id":"PO9","supplier":"S9","wh":"W1","items":[{"product":"P1","qty":10}]},
  {"type":"po-transfer","id":"F90","orig":"PO9","dest":"PO10","supplier":"S10","wh":"W2","items":[{"product":"P1","qty":4}]},
  {"type":"arrival","id":"A90","po":"PO10","items":[{"product":"P1","qty":1}]},
  {"type":"reverse","id":"R90","orig":"F90"}
]
EOF
out=$(run12 import --file "$TMP/batch12a.json" 2>&1); code=$?
[ $code -eq 1 ] || { echo "FAIL - 转单冲销批量拒绝退出码应为 1，实际 $code"; FAIL=1; }
check "批量指出位置（第 4 项）与全量待收原因" "第 4 项" "$out"
check "批量拒绝原因为目的单非全量待收" "已非全量待收" "$out"
out=$(run12 po show PO9 2>&1)
check "批量回滚：PO9 未登记" "采购单 PO9 不存在" "$out"
# 修正后整批成功（目的单不得到货，直接冲销）
cat > "$TMP/batch12b.json" <<'EOF'
[
  {"type":"po","id":"PO9","supplier":"S9","wh":"W1","items":[{"product":"P1","qty":10}]},
  {"type":"po-transfer","id":"F90","orig":"PO9","dest":"PO10","supplier":"S10","wh":"W2","items":[{"product":"P1","qty":4}]},
  {"type":"reverse","id":"R90","orig":"F90"}
]
EOF
out=$(run12 import --file "$TMP/batch12b.json")
check "转单+冲销整批成功" "首次生效 3 项" "$out"
out=$(run12 import --file "$TMP/batch12b.json")
check "全部重复不改写文件（重复 3 项）" "首次生效 0 项，重复 3 项" "$out"
# 冲销引用尚未出现的转单须失败并指出位置
cat > "$TMP/batch12c.json" <<'EOF'
[
  {"type":"reverse","id":"RG","orig":"GHOST"}
]
EOF
out=$(run12 import --file "$TMP/batch12c.json" 2>&1)
check "批量冲销未出现原单指出位置" "第 1 项" "$out"
# 重启后限制仍成立
check_refuse12 "重启后转出超限仍拒绝" "当前待收 0，本次转出 1，拒绝整单" \
  po-transfer FH --orig PO2 --dest POH --supplier SH --wh WH --item P1:1
out=$(run12 po show PO3)
check "重启后链式转单净进度保留（PO3 已转出 4）" "P1	4	0	4	0	已结清（含取消）" "$out"
# 补货待到货合计按精确净进度（PO4 为链式目的单，P1 全量待收 4 归集到 W4）
run12 rule set P1 --wh W4 --min 10 --target 20 >/dev/null
out=$(run12 replenish)
check "补货待到货合计含目的单净待收（W4=4）" "商品 P1 仓库 W4：下限 10，目标 20，实存 0，待到货合计 4，预计量 4，触发补货，缺口 16" "$out"
# 原单 PO1 已全部转出/到货（待收 0）；批量 PO9 的转单已冲销、待收恢复为 10，均归集 W1
run12 rule set P1 --wh W1 --min 1 --target 2 >/dev/null
out=$(run12 replenish)
check "W1 待到货合计按净进度（PO1=0，PO9 转单冲销后恢复=10）" "商品 P1 仓库 W1：下限 1，目标 2，实存 5，待到货合计 10，预计量 15，未触发" "$out"
# 损坏数据：转单与目的采购关联断裂拒读
BAD12="$TMP/bad12"
mkdir -p "$BAD12"
cat > "$BAD12/stockroom.json" <<'EOF'
{"version":1,"products":{"P1":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{
   "PO1":{"poId":"PO1","supplier":"S","wh":"W1","ordered":{"P1":10},"resultLines":[]},
   "PO2":{"poId":"PO2","supplier":"S2","wh":"W2","ordered":{"P1":3},"fromTransfer":"NOPE","resultLines":[]}},
 "arrivals":{},"cancels":{},"returns":{},"poTransfers":{}}
EOF
out=$(node "$APP" -d "$BAD12" po list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 转单关联断裂应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "转单来源缺失拒读" "来源转单 NOPE 不存在" "$out"
fi
# 旧数据无 poTransfers 字段按无转单加载
node "$APP" -d "$BAD6" po list | grep -q "采购单（0）" && echo "ok   - 旧数据无转单字段按无转单处理" || { echo "FAIL - 旧数据加载异常"; FAIL=1; }
# 格式错误退出 2
out=$(run12 po-transfer 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - po-transfer 缺参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run12 po-transfer F1 --orig PO1 --dest PO2 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - po-transfer 缺 --supplier/--wh 退出码应为 2，实际 $code"; FAIL=1; }

echo "== 12. 补货方案整案撤回 =="
D13="$TMP/data13"
run13() { node "$APP" -d "$D13" "$@"; }
check_refuse13() { # check_refuse13 <描述> <期望错误文本> <命令...>
  desc=$1; want=$2; shift 2
  out=$(run13 "$@" 2>&1); code=$?
  if [ $code -ne 1 ]; then
    echo "FAIL - ${desc}（退出码应为 1，实际 $code）"; echo "  输出: $out"; FAIL=1
  else
    check "$desc" "$want" "$out"
  fi
}
run13 product add Q1 扳手 >/dev/null
run13 in G1 --wh W1 --item Q1:3 >/dev/null
run13 in G2 --wh W2 --item Q1:12 >/dev/null
run13 rule set Q1 --wh W1 --min 8 --target 20 >/dev/null
run13 rule set Q1 --wh W2 --min 2 --target 10 >/dev/null
# W1 缺口 17：W2 调拨 2、采购 15
run13 plan save PL1 --transfer Q1:W2:W1:T1 --purchase Q1:W1:PO9:华东五金 >/dev/null
check_refuse13 "待执行方案不可撤回" "尚未执行，仅允许撤回已执行且未撤回的方案" \
  plan withdraw W0 --plan PL1 --transfer-rev T1:R1 --purchase-cancel PO9:X1
run13 plan execute PL1 >/dev/null
# 映射逐一对应：缺漏、多余、重复、彼此重号均整案拒绝
check_refuse13 "缺少采购映射拒绝" "缺少采购子单 PO9 的取消单号指定" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:R1
check_refuse13 "多余调拨映射拒绝" "多余的调拨子单指定 T2" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:R1 --transfer-rev T2:R2 --purchase-cancel PO9:X1
check_refuse13 "重复指定同一子单拒绝" "调拨子单 T1 的冲销单号重复指定" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:R1 --transfer-rev T1:R2 --purchase-cancel PO9:X1
check_refuse13 "新子单号彼此重号拒绝" "彼此不得重号" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:X1 --purchase-cancel PO9:X1
check_refuse13 "请求编号已占用拒绝" "撤回请求编号 G1 已用于入库/出库/调拨/盘点单" \
  plan withdraw G1 --plan PL1 --transfer-rev T1:R1 --purchase-cancel PO9:X1
check_refuse13 "新冲销单号已占用即使内容相同也拒绝" "已被入库/出库/调拨/盘点单占用（即使内容相同也不接管）" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:G2 --purchase-cancel PO9:X1
# 进度不符：采购子单有有效到货时拒绝；合法恢复全量待收后允许
run13 arrival A1 --po PO9 --item Q1:5 >/dev/null
check_refuse13 "采购子单非全量待收拒绝" "采购子单 PO9 商品 Q1 已非全量待收（有效到货 5，有效取消 0）" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:R1 --purchase-cancel PO9:X1
run13 reverse RA --orig A1 >/dev/null   # 冲销到货，恢复全量待收
# 调拨子单已冲销时拒绝（另案验证见下）；缺货整案拒绝且不占编号
run13 out O1 --wh W1 --item Q1:4 >/dev/null   # W1 余量 1，不足扣回调拨 2
check_refuse13 "调入仓缺货整案拒绝" "原调入仓 W1 当前余量 1 不足扣回 2" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:R1 --purchase-cancel PO9:X1
out=$(run13 plan show PL1)
check "失败后方案保持已执行未撤回" "状态 已执行，调拨 1 份、采购 1 份" "$out"
run13 reverse RO --orig O1 >/dev/null    # 恢复 W1 余量（W1 = 1+4=5）
# 失败不占编号：条件改善后同号（W1/R1/X1）重试成功
out=$(run13 plan withdraw W1 --plan PL1 --transfer-rev T1:R1 --purchase-cancel PO9:X1)
check "整案撤回成功" "撤回请求 W1 提交成功，撤回补货方案 PL1：调拨冲销 1 份、采购取消 1 份：" "$out"
check "调拨子单冲销前后值" "冲销调拨 原单=T1 商品=Q1 W1 -> W2 2：W1 5->3；W2 10->12" "$out"
check "采购子单取消完整订购量" "取消 Q1 x15：有效取消 15，待到货 0" "$out"
out=$(run13 balance Q1 --wh W2)
check "撤回后库存真实可读（W2 补回 12）" "余量：商品 Q1 仓库 W2 = 12" "$out"
out=$(run13 po show PO9)
check "撤回后采购待收归零（已结清含取消）" "Q1	15	0	15	0	已结清（含取消）" "$out"
out=$(run13 flow --product Q1 --wh W2)
check "冲销流水真实可读" "单据=R1	冲销调拨	商品=Q1	仓库=W2	+2	10->12	调拨=W2->W1	原单=T1" "$out"
out=$(run13 plan show PL1)
check "plan show 展示已撤回状态" "状态 已执行（已撤回）" "$out"
check "plan show 展示撤回关联" "调拨子单 T1 -> 冲销单 R1" "$out"
check "plan show 展示取消关联" "采购子单 PO9 -> 取消单 X1" "$out"
out=$(run13 plan list)
check "plan list 展示撤回状态与请求" "PL1	已执行（已撤回）	调拨 1 份	采购 1 份	撤回请求=W1" "$out"
# 幂等：同请求编号、同方案及子单映射重放返回原结果，不改写文件
sum1=$(cksum < "$D13/stockroom.json")
out=$(run13 plan withdraw W1 --plan PL1 --purchase-cancel PO9:X1 --transfer-rev T1:R1)
check "同号同映射重放返回原结果" "撤回请求 W1 为重复提交" "$out"
sum2=$(cksum < "$D13/stockroom.json")
[ "$sum1" = "$sum2" ] && echo "ok   - 撤回重放不改写文件" || { echo "FAIL - 撤回重放改写了文件"; FAIL=1; }
check_refuse13 "同请求编号改映射拒绝" "撤回请求编号 W1 已用于内容不同的撤回" \
  plan withdraw W1 --plan PL1 --transfer-rev T1:R2 --purchase-cancel PO9:X1
check_refuse13 "每案最多成功撤回一次" "已被撤回请求 W1 撤回，每案最多成功撤回一次" \
  plan withdraw W2 --plan PL1 --transfer-rev T1:R9 --purchase-cancel PO9:X9
check_refuse13 "撤回请求本身不可冲销" "撤回请求不可冲销" reverse RW --orig W1
check_refuse13 "撤回请求编号不能再作普通单据" "已用于方案撤回请求" in W1 --wh W1 --item Q1:1
# 撤回后 plan execute 与原子单重放仍返回原成功结果，不重新落单
out=$(run13 plan execute PL1)
check "撤回后 plan execute 重放原结果" "已执行，返回原落单结果" "$out"
out=$(run13 transfer T1 --from W2 --to W1 --item Q1:2)
check "原子单重放仍返回原结果" "为重复提交" "$out"
out=$(run13 balance Q1 --wh W2)
check "重放不重新落单（W2 仍为 12）" "余量：商品 Q1 仓库 W2 = 12" "$out"
# 新取消单可按普通规则冲销，但方案保持已撤回
out=$(run13 reverse RC --orig X1)
check "新取消单可按普通规则冲销" "冲销取消 原单=X1 采购单=PO9 商品=Q1 本次恢复取消量 15" "$out"
check_refuse13 "取消冲销后方案仍保持已撤回" "每案最多成功撤回一次" \
  plan withdraw W3 --plan PL1 --transfer-rev T1:R8 --purchase-cancel PO9:X8
# 只有调拨 / 只有采购的方案也支持
D14="$TMP/data14"
run14() { node "$APP" -d "$D14" "$@"; }
run14 product add Q1 扳手 >/dev/null
run14 in G1 --wh W2 --item Q1:50 >/dev/null
run14 rule set Q1 --wh W1 --min 8 --target 20 >/dev/null
run14 rule set Q1 --wh W2 --min 2 --target 10 >/dev/null
run14 plan save PLT --transfer Q1:W2:W1:TT1 >/dev/null
run14 plan execute PLT >/dev/null
out=$(run14 plan withdraw WT --plan PLT --transfer-rev TT1:RR1)
check "只有调拨的方案撤回" "撤回请求 WT 提交成功，撤回补货方案 PLT：调拨冲销 1 份、采购取消 0 份：" "$out"
D15="$TMP/data15"
run15() { node "$APP" -d "$D15" "$@"; }
run15 product add Q1 扳手 >/dev/null
run15 rule set Q1 --wh W1 --min 8 --target 20 >/dev/null
run15 plan save PLP --purchase Q1:W1:PP1:供应商 >/dev/null
run15 plan execute PLP >/dev/null
out=$(run15 plan withdraw WP --plan PLP --purchase-cancel PP1:CC1)
check "只有采购的方案撤回" "撤回请求 WP 提交成功，撤回补货方案 PLP：调拨冲销 0 份、采购取消 1 份：" "$out"
# 调拨子单已被冲销的方案不可撤回
D16="$TMP/data16"
run16() { node "$APP" -d "$D16" "$@"; }
run16 product add Q1 扳手 >/dev/null
run16 in G1 --wh W2 --item Q1:50 >/dev/null
run16 rule set Q1 --wh W1 --min 8 --target 20 >/dev/null
run16 rule set Q1 --wh W2 --min 2 --target 10 >/dev/null
run16 plan save PLT --transfer Q1:W2:W1:TT1 >/dev/null
run16 plan execute PLT >/dev/null
run16 reverse RV1 --orig TT1 >/dev/null
out=$(run16 plan withdraw WT --plan PLT --transfer-rev TT1:RR1 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 调拨子单已冲销应拒绝撤回（退出码 1，实际 $code）"; FAIL=1
else
  check "调拨子单已冲销拒绝撤回" "调拨子单 TT1 已被冲销单 RV1 冲销" "$out"
fi
# 特殊标识：__proto__ 与含冒号新单号正常使用
D17="$TMP/data17"
node "$APP" -d "$D17" product add '__proto__' 特殊件 >/dev/null
node "$APP" -d "$D17" rule set '__proto__' --wh W1 --min 5 --target 10 >/dev/null
node "$APP" -d "$D17" plan save '__proto__' --purchase '__proto__:W1:__proto__:供应商X' >/dev/null
node "$APP" -d "$D17" plan execute '__proto__' >/dev/null
out=$(node "$APP" -d "$D17" plan withdraw '__proto__' --plan '__proto__' --purchase-cancel '__proto__:X:1')
check "__proto__ 方案撤回（新单号含冒号）" "撤回请求 __proto__ 提交成功" "$out"
out=$(node "$APP" -d "$D17" plan show '__proto__')
check "__proto__ 撤回关联可读" "采购子单 __proto__ -> 取消单 X:1" "$out"
# 重启（新进程）后撤回状态与限制仍成立
out=$(node "$APP" -d "$D17" plan withdraw '__proto__' --plan '__proto__' --purchase-cancel '__proto__:X:1')
check "重启后撤回重放仍成立" "撤回请求 __proto__ 为重复提交" "$out"
out=$(node "$APP" -d "$D17" reverse R9 --orig '__proto__' 2>&1); code=$?
[ $code -eq 1 ] && echo "ok   - 重启后撤回请求仍不可冲销" || { echo "FAIL - 重启后撤回请求冲销限制失效"; FAIL=1; }
# 损坏数据：撤回关联缺失或内容不符拒读
BAD13="$TMP/bad13"
mkdir -p "$BAD13"
cat > "$BAD13/stockroom.json" <<'EOF'
{"version":1,"products":{"Q9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W1","ordered":{"Q9":3},"resultLines":[]}},
 "arrivals":{},"cancels":{"C9":{"poId":"PO9","qty":{"Q9":3},"resultLines":[]}},
 "returns":{},"rules":{"Q9":{"W1":{"min":1,"target":5}}},
 "plans":{"PL9":{"planId":"PL9","status":"executed","execResultLines":["x"],
   "transfers":[],"purchases":[{"poId":"PO9","supplier":"S","wh":"W1","product":"Q9","qty":3}],
   "snapshot":{"rules":{"Q9":{"W1":{"min":1,"target":5}}},"stock":{"Q9":{"W1":0}},"pending":{"Q9":{"W1":"0"}}}}},
 "planWithdrawals":{"W9":{"reqId":"W9","planId":"PL9","transferRevs":{},"purchaseCancels":{"PO9":"C9"},"resultLines":[]}}}
EOF
out=$(node "$APP" -d "$BAD13" plan list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 方案缺撤回标记应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "撤回关联断裂拒读（方案未标记）" "撤回标记不一致（关联断裂）" "$out"
fi
cat > "$BAD13/stockroom.json" <<'EOF'
{"version":1,"products":{"Q9":"x"},"stock":{},"entries":[],"docs":{},"reversals":{},
 "purchases":{"PO9":{"poId":"PO9","supplier":"S","wh":"W1","ordered":{"Q9":3},"resultLines":[]}},
 "arrivals":{},"cancels":{"C9":{"poId":"PO9","qty":{"Q9":2},"resultLines":[]}},
 "returns":{},"rules":{"Q9":{"W1":{"min":1,"target":5}}},
 "plans":{"PL9":{"planId":"PL9","status":"executed","execResultLines":["x"],"withdrawnBy":"W9",
   "transfers":[],"purchases":[{"poId":"PO9","supplier":"S","wh":"W1","product":"Q9","qty":3}],
   "snapshot":{"rules":{"Q9":{"W1":{"min":1,"target":5}}},"stock":{"Q9":{"W1":0}},"pending":{"Q9":{"W1":"0"}}}}},
 "planWithdrawals":{"W9":{"reqId":"W9","planId":"PL9","transferRevs":{},"purchaseCancels":{"PO9":"C9"},"resultLines":[]}}}
EOF
out=$(node "$APP" -d "$BAD13" plan list 2>&1); code=$?
if [ $code -ne 1 ]; then
  echo "FAIL - 取消单内容不符应拒读（退出码 1，实际 $code）"; FAIL=1
else
  check "撤回取消单内容不符拒读" "与采购子单 PO9 完整订购量不符" "$out"
fi
# 旧数据无 planWithdrawals 字段按无撤回加载并保留原结果
out=$(node "$APP" -d "$BAD6" plan list)
check "旧数据无撤回字段按无撤回处理" "（暂无补货方案）" "$out"
# 格式错误退出 2
out=$(run13 plan withdraw 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - plan withdraw 缺参数退出码应为 2，实际 $code"; FAIL=1; }
out=$(run13 plan withdraw W9 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - plan withdraw 缺 --plan 退出码应为 2，实际 $code"; FAIL=1; }
out=$(run13 plan withdraw W9 --plan PL1 --transfer-rev T1 2>&1); code=$?
[ $code -eq 2 ] || { echo "FAIL - 映射格式错误退出码应为 2，实际 $code"; FAIL=1; }

echo "== 13. 多进程写入协调：并行竞争、超时、异常退出恢复与重放 =="
export STOCKROOM_LOCK_WAIT_MS=30000   # 并行用例给足等待上限；超时用例再单独调小
D20="$TMP/data20"
node "$APP" -d "$D20" product add P1 螺丝 >/dev/null
# 并行合法入库：不丢单、不丢数量
i=1
while [ $i -le 8 ]; do
  node "$APP" -d "$D20" in "PI$i" --wh W1 --item P1:1 >/dev/null 2>&1 &
  i=$((i+1))
done
wait
out=$(node "$APP" -d "$D20" balance P1 --wh W1)
check "8 进程并行入库不丢单不丢数量" "余量：商品 P1 仓库 W1 = 8" "$out"
# 竞争有限库存的出库：8 进程抢 5 件，不能共同超量成功
node "$APP" -d "$D20" in PI9 --wh W2 --item P1:5 >/dev/null
: > "$TMP/race-out.res"
i=1
while [ $i -le 8 ]; do
  ( node "$APP" -d "$D20" out "PO$i" --wh W2 --item P1:1 >/dev/null 2>&1; echo $? ) >> "$TMP/race-out.res" &
  i=$((i+1))
done
wait
nok=$(grep -c '^0$' "$TMP/race-out.res")
nfail=$(grep -c '^1$' "$TMP/race-out.res")
if [ "$nok" -eq 5 ] && [ "$nfail" -eq 3 ]; then
  echo "ok   - 竞争有限库存的出库不超量成功（8 进程抢 5 件：5 成 3 拒）"
else
  echo "FAIL - 竞争出库结果异常（成功 $nok、拒绝 $nfail，应为 5 成 3 拒）"; FAIL=1
fi
out=$(node "$APP" -d "$D20" balance P1 --wh W2)
check "竞争出库后余量精确为 0" "余量：商品 P1 仓库 W2 = 0" "$out"
# 业务拒绝后锁已释放，后续写入立即可用
node "$APP" -d "$D20" out FAIL1 --wh W1 --item P1:999 >/dev/null 2>&1
out=$(node "$APP" -d "$D20" in AFTER1 --wh W1 --item P1:1)
check "业务拒绝后后续写入立即可用" "入库单 AFTER1 提交成功" "$out"
# 并行同编号同内容：只生效一次，其余返回原结果（双方都成功退出）
: > "$TMP/race-dup.res"
( node "$APP" -d "$D20" in DUP1 --wh W3 --item P1:7 >/dev/null 2>&1; echo $? ) >> "$TMP/race-dup.res" &
( node "$APP" -d "$D20" in DUP1 --wh W3 --item P1:7 >/dev/null 2>&1; echo $? ) >> "$TMP/race-dup.res" &
wait
out=$(node "$APP" -d "$D20" balance P1 --wh W3)
check "并行同编号同内容只生效一次" "余量：商品 P1 仓库 W3 = 7" "$out"
nok=$(grep -c '^0$' "$TMP/race-dup.res")
[ "$nok" -eq 2 ] && echo "ok   - 同内容重放方也成功返回原结果" || { echo "FAIL - 同内容并行重放应都成功（成功数 $nok）"; FAIL=1; }
# 并行同号不同内容：依编号空间拒绝，仅一个成功
: > "$TMP/race-conf.res"
( node "$APP" -d "$D20" in DUP2 --wh W3 --item P1:1 >/dev/null 2>&1; echo $? ) >> "$TMP/race-conf.res" &
( node "$APP" -d "$D20" in DUP2 --wh W3 --item P1:2 >/dev/null 2>&1; echo $? ) >> "$TMP/race-conf.res" &
wait
codes=$(sort "$TMP/race-conf.res" | tr -d '\n')
[ "$codes" = "01" ] && echo "ok   - 并行同号不同内容仅一个成功、另一个拒绝" || { echo "FAIL - 同号冲突退出码异常：$codes"; FAIL=1; }
out=$(node "$APP" -d "$D20" balance P1 --wh W3)
case $out in
  *"= 8"|*"= 9") echo "ok   - 同号冲突后只有一份内容生效" ;;
  *) echo "FAIL - 同号冲突后库存异常：$out"; FAIL=1 ;;
esac
# 竞争采购待收的到货：4+4 抢 5，不能共同超量成功
D21="$TMP/data21"
node "$APP" -d "$D21" product add P1 螺丝 >/dev/null
node "$APP" -d "$D21" po register PO1 --supplier S1 --wh W1 --item P1:5 >/dev/null
: > "$TMP/race-arr.res"
( node "$APP" -d "$D21" arrival AR1 --po PO1 --item P1:4 >/dev/null 2>&1; echo $? ) >> "$TMP/race-arr.res" &
( node "$APP" -d "$D21" arrival AR2 --po PO1 --item P1:4 >/dev/null 2>&1; echo $? ) >> "$TMP/race-arr.res" &
wait
codes=$(sort "$TMP/race-arr.res" | tr -d '\n')
[ "$codes" = "01" ] && echo "ok   - 竞争采购待收的到货不超量成功（4+4 抢 5：1 成 1 拒）" || { echo "FAIL - 竞争到货退出码异常：$codes"; FAIL=1; }
out=$(node "$APP" -d "$D21" po show PO1)
check "竞争到货后待到货精确为 1" "P1	5	4	1	部分到货" "$out"
# 首次创建数据目录的并发写入同样协调
D24="$TMP/data24"
: > "$TMP/race-init.res"
( node "$APP" -d "$D24" product add P1 螺丝 >/dev/null 2>&1; echo $? ) >> "$TMP/race-init.res" &
( node "$APP" -d "$D24" product add P2 螺母 >/dev/null 2>&1; echo $? ) >> "$TMP/race-init.res" &
wait
nok=$(grep -c '^0$' "$TMP/race-init.res")
[ "$nok" -eq 2 ] && echo "ok   - 首次创建数据目录的并发写入均成功" || { echo "FAIL - 并发首次创建成功数 $nok"; FAIL=1; }
out=$(node "$APP" -d "$D24" product list)
check "并发首次创建后两商品都在（P1）" "P1	螺丝" "$out"
check "并发首次创建后两商品都在（P2）" "P2	螺母" "$out"
# 等待上限：数据目录正忙时报标准错误退出 1，不留变动；仍存活写进程不被抢占
D22="$TMP/data22"
mkdir -p "$D22"
sleep 30 & BUSY_PID=$!
printf '%s other\n' "$BUSY_PID" > "$D22/.stockroom.json.lock"
out=$(STOCKROOM_LOCK_WAIT_MS=600 node "$APP" -d "$D22" product add P1 螺丝 2>&1 >/dev/null); code=$?
kill "$BUSY_PID" 2>/dev/null; wait "$BUSY_PID" 2>/dev/null
if [ $code -ne 1 ]; then
  echo "FAIL - 等待超时退出码应为 1，实际 $code"; FAIL=1
else
  check "等待超时明确说明数据目录正忙（不抢占仍存活写进程）" "数据目录正忙" "$out"
fi
[ ! -e "$D22/stockroom.json" ] && echo "ok   - 超时未留下本请求任何变动" || { echo "FAIL - 超时留下了数据文件"; FAIL=1; }
rm -f "$D22/.stockroom.json.lock"
# 符号链接路径与真实路径指向同一目录时共用协调；不同目录互不阻塞
D25="$TMP/data25"
mkdir -p "$D25"
ln -s "$D25" "$TMP/data25-link"
sleep 30 & BUSY2=$!
printf '%s other\n' "$BUSY2" > "$D25/.stockroom.json.lock"
out=$(STOCKROOM_LOCK_WAIT_MS=500 node "$APP" -d "$TMP/data25-link" product add P1 x 2>&1 >/dev/null); code=$?
kill "$BUSY2" 2>/dev/null; wait "$BUSY2" 2>/dev/null
[ $code -eq 1 ] && echo "ok   - 符号链接路径与真实路径共用同一把锁" || { echo "FAIL - 符号链接路径未共用锁（退出码 $code）"; FAIL=1; }
out=$(node "$APP" -d "$TMP/data26" product add P1 x 2>&1); code=$?
[ $code -eq 0 ] && echo "ok   - 不同数据目录互不阻塞" || { echo "FAIL - 不同目录被阻塞：$out"; FAIL=1; }
rm -f "$D25/.stockroom.json.lock"
# 写进程异常退出（SIGKILL）后自动恢复：遗留锁与临时文件无需手工删除，
# 遗留临时内容不被当作已提交数据
D23="$TMP/data23"
mkdir -p "$D23"
node -e 'require("node:fs").writeFileSync(process.argv[1], process.pid + " t\n"); process.kill(process.pid, "SIGKILL")' "$D23/.stockroom.json.lock" &
CRASH_PID=$!
wait $CRASH_PID 2>/dev/null
printf '{not json' > "$D23/.stockroom.json.$CRASH_PID.tmp"
out=$(node "$APP" -d "$D23" product add P1 螺丝 2>&1); code=$?
[ $code -eq 0 ] && echo "ok   - 异常退出遗留锁自动恢复，无需手工删除" || { echo "FAIL - 遗留锁未自动恢复：$out"; FAIL=1; }
[ ! -e "$D23/.stockroom.json.lock" ] && echo "ok   - 写入结束后释放锁" || { echo "FAIL - 写入结束后锁未释放"; FAIL=1; }
[ ! -e "$D23/.stockroom.json.$CRASH_PID.tmp" ] && echo "ok   - 异常遗留临时文件被清理" || { echo "FAIL - 遗留临时文件未清理"; FAIL=1; }
out=$(node "$APP" -d "$D23" product list)
check "遗留临时内容未被当作已提交数据" "P1	螺丝" "$out"
# 整批导入作为整批参与协调：与单条写入不交错生效
D27="$TMP/data27"
node "$APP" -d "$D27" product add P1 螺丝 >/dev/null
cat > "$TMP/imp-race.json" <<'EOF'
[
  {"type":"in","id":"BI1","wh":"W1","items":[{"product":"P1","qty":2}]},
  {"type":"in","id":"BI2","wh":"W1","items":[{"product":"P1","qty":3}]}
]
EOF
node "$APP" -d "$D27" import --file "$TMP/imp-race.json" >/dev/null 2>&1 &
node "$APP" -d "$D27" in BS1 --wh W1 --item P1:4 >/dev/null 2>&1 &
wait
out=$(node "$APP" -d "$D27" balance P1 --wh W1)
check "导入与单条写入不交错生效（2+3+4）" "余量：商品 P1 仓库 W1 = 9" "$out"
# 并行全重复导入：不改写数据文件、不重复生效
sum1=$(cksum < "$D27/stockroom.json")
node "$APP" -d "$D27" import --file "$TMP/imp-race.json" >/dev/null 2>&1 &
node "$APP" -d "$D27" import --file "$TMP/imp-race.json" >/dev/null 2>&1 &
wait
sum2=$(cksum < "$D27/stockroom.json")
[ "$sum1" = "$sum2" ] && echo "ok   - 并行全重复导入不改写数据文件" || { echo "FAIL - 全重复导入改写了数据文件"; FAIL=1; }
out=$(node "$APP" -d "$D27" balance P1 --wh W1)
check "重放不重复生效" "余量：商品 P1 仓库 W1 = 9" "$out"
# 并行方案执行：只落单一次，其余返回原结果
D29="$TMP/data29"
node "$APP" -d "$D29" product add Q1 扳手 >/dev/null
node "$APP" -d "$D29" rule set Q1 --wh W1 --min 5 --target 10 >/dev/null
node "$APP" -d "$D29" plan save PLP --purchase Q1:W1:PP1:供应商X >/dev/null
node "$APP" -d "$D29" plan execute PLP >/dev/null 2>&1 &
node "$APP" -d "$D29" plan execute PLP >/dev/null 2>&1 &
wait
out=$(node "$APP" -d "$D29" po show PP1)
check "并行方案执行只落单一次（待到货 10）" "Q1	10	0	10	未到货" "$out"
# 只读查询不创建协调文件
D28="$TMP/data28"
node "$APP" -d "$D28" balance P1 >/dev/null
[ ! -e "$D28" ] && echo "ok   - 只读查询不创建数据目录与协调文件" || { echo "FAIL - 只读查询创建了数据目录"; FAIL=1; }
node "$APP" -d "$D20" balance P1 >/dev/null
[ ! -e "$D20/.stockroom.json.lock" ] && echo "ok   - 只读查询不创建锁文件" || { echo "FAIL - 只读查询创建了锁文件"; FAIL=1; }
unset STOCKROOM_LOCK_WAIT_MS

echo "== 14. 异常退出并发恢复：多回收者竞争、未写完持有者信息、释放归属与崩溃重试 =="
unset STOCKROOM_LOCK_WAIT_MS

# 取一个确认已退出的进程号（PID 复用窗口在本地短时回归中可忽略）。
dead_pid() {
  sh -c 'true' & dp=$!
  wait "$dp"
  echo "$dp"
}

# 手工布置一个“已退出持有者”的新协议锁（身份文件硬链接到闸门），随后多个写请求同时回收。
setup_dead_lock() { # setup_dead_lock <数据目录>
  d=$1
  mkdir -p "$d"
  dead=$(dead_pid)
  touch "$d/.stockroom.json.lock.$dead.dead0"
  ln "$d/.stockroom.json.lock.$dead.dead0" "$d/.stockroom.json.lock"
}

echo "-- 14.1 多个恢复者竞争同一遗留占用：只能串行取得写入机会，单据全部入库、流水连续 --"
D30="$TMP/data30"
node "$APP" -d "$D30" product add P1 螺丝 >/dev/null
setup_dead_lock "$D30"
: > "$TMP/recover.res"
i=1
while [ $i -le 6 ]; do
  ( node "$APP" -d "$D30" in "RC$i" --wh W1 --item P1:$i >/dev/null 2>&1; echo "rc$i=$?" ) >> "$TMP/recover.res" &
  i=$((i+1))
done
wait
nfail=$(grep -c '=1$' "$TMP/recover.res" || true)
[ "$nfail" -eq 0 ] && echo "ok   - 6 个恢复者全部成功取得写入机会（串行回收，无失败）" || { echo "FAIL - 有恢复者失败：$(cat "$TMP/recover.res")"; FAIL=1; }
out=$(node "$APP" -d "$D30" balance P1 --wh W1)
check "6 个恢复者的成功入库全部计入余量（1+2+3+4+5+6=21）" "余量：商品 P1 仓库 W1 = 21" "$out"
nflow=$(node "$APP" -d "$D30" flow --product P1 --wh W1 | grep -c '^#')
[ "$nflow" -eq 6 ] && echo "ok   - 恢复后每笔各一条流水（共 6 条），编号全部保留" || { echo "FAIL - 流水条数异常：$nflow"; FAIL=1; }
# 流水序号 1..6 连续，且六笔编号恰为 RC1..RC6（提交顺序不要求与启动顺序一致）
seqs=$(node "$APP" -d "$D30" flow --product P1 --wh W1 | sed -n 's/^#\([0-9]*\)	.*/\1/p' | tr '\n' ' ')
[ "$seqs" = "1 2 3 4 5 6 " ] && echo "ok   - 恢复后流水序号 1..6 连续" || { echo "FAIL - 流水序号不连续：$seqs"; FAIL=1; }
docs=$(node "$APP" -d "$D30" flow --product P1 --wh W1 | sed -n 's/^#[0-9]*	单据=\([A-Z0-9]*\)	.*/\1/p' | sort | tr '\n' ' ')
[ "$docs" = "RC1 RC2 RC3 RC4 RC5 RC6 " ] && echo "ok   - 六笔编号 RC1..RC6 全部保留" || { echo "FAIL - 流水编号异常：$docs"; FAIL=1; }
nlocks=$(ls -a "$D30" | grep -c '^\.stockroom\.json\.lock' || true)
[ "$nlocks" -eq 0 ] && echo "ok   - 全部结束后锁闸门与身份文件均释放" || { echo "FAIL - 仍有协调文件残留：$(ls -a "$D30")"; FAIL=1; }
# 整批导入在遗留锁恢复后仍作为完整事务办理（与其他写入不交错）
cat > "$TMP/imp30.json" <<'EOF'
[
  {"type":"in","id":"BI30a","wh":"W1","items":[{"product":"P1","qty":100}]},
  {"type":"out","id":"BI30b","wh":"W1","items":[{"product":"P1","qty":1}]}
]
EOF
setup_dead_lock "$D30"
out=$(node "$APP" -d "$D30" import --file "$TMP/imp30.json")
check "遗留锁恢复后整批导入作为完整事务生效" "首次生效 2 项" "$out"
check "导入后余量精确（21+100-1=120）" "余量：商品 P1 仓库 W1 = 120" "$(node "$APP" -d "$D30" balance P1 --wh W1)"

echo "-- 14.2 回收者不得移走另一个请求刚取得的占用（回收/释放交错）--"
D31="$TMP/data31"
node "$APP" -d "$D31" product add P1 螺丝 >/dev/null
# 一批请求竞争回收死锁，再混入第二批新请求交错执行；最终结果必须等价某一串行顺序
setup_dead_lock "$D31"
: > "$TMP/interleave.res"
i=1
while [ $i -le 4 ]; do
  ( node "$APP" -d "$D31" in "IL$i" --wh W1 --item P1:1 >/dev/null 2>&1; echo "il$i=$?" ) >> "$TMP/interleave.res" &
  i=$((i+1))
done
sleep 0.05
i=5
while [ $i -le 8 ]; do
  ( node "$APP" -d "$D31" in "IL$i" --wh W1 --item P1:1 >/dev/null 2>&1; echo "il$i=$?" ) >> "$TMP/interleave.res" &
  i=$((i+1))
done
wait
nfail=$(grep -c '=1$' "$TMP/interleave.res" || true)
[ "$nfail" -eq 0 ] && echo "ok   - 交错两批共 8 个请求全部成功（无错删他人占用导致的失败）" || { echo "FAIL - 交错请求有失败：$(cat "$TMP/interleave.res")"; FAIL=1; }
out=$(node "$APP" -d "$D31" balance P1 --wh W1)
check "交错恢复/释放后余量精确（8 笔各 1）" "余量：商品 P1 仓库 W1 = 8" "$out"

echo "-- 14.3 持有者信息未写完时暂停超过两秒不被接管；退出后自动恢复 --"
D32="$TMP/data32"
node "$APP" -d "$D32" product add P1 螺丝 >/dev/null
# 存活持有者：闸门为空内容（身份文件名已携带 pid），维持 5 秒
sleep 5 & HOLDER=$!
touch "$D32/.stockroom.json.lock.$HOLDER.h0"
ln "$D32/.stockroom.json.lock.$HOLDER.h0" "$D32/.stockroom.json.lock"
( STOCKROOM_LOCK_WAIT_MS=400 node "$APP" -d "$D32" in WAIT1 --wh W1 --item P1:1 >/dev/null 2>&1; echo "waiter1=$?" ) > "$TMP/holder-wait.res" &
WPID=$!
wait $WPID
case $(cat "$TMP/holder-wait.res") in
  "waiter1=1") echo "ok   - 暂停超过两秒且内容为空，存活持有者仍不被接管（等待者超时退出 1）" ;;
  *) echo "FAIL - 等待者结果异常：$(cat "$TMP/holder-wait.res")"; FAIL=1 ;;
esac
out=$(STOCKROOM_LOCK_WAIT_MS=400 node "$APP" -d "$D32" in WAIT2 --wh W1 --item P1:1 2>&1); code=$?
[ $code -eq 1 ] && echo "ok   - 第二个等待者同样不抢占存活锁" || { echo "FAIL - 第二等待者异常：$out"; FAIL=1; }
check "等待期间余量始终为 0" "商品 P1 在各仓库余量均为 0" "$(node "$APP" -d "$D32" balance P1)"
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
out=$(node "$APP" -d "$D32" in AFTER --wh W1 --item P1:2); code=$?
[ $code -eq 0 ] && echo "ok   - 持有者退出后后续请求自动恢复，无需手工删文件" || { echo "FAIL - 退出后未自动恢复：$out"; FAIL=1; }
check "恢复后的提交正常入库" "余量：商品 P1 仓库 W1 = 2" "$(node "$APP" -d "$D32" balance P1 --wh W1)"
[ ! -e "$D32/.stockroom.json.lock" ] && echo "ok   - 恢复写入结束后闸门释放" || { echo "FAIL - 闸门残留"; FAIL=1; }

echo "-- 14.4 释放归属：业务拒绝/失败只释放自己的占用，删除别人的锁不得影响他人 --"
D33="$TMP/data33"
node "$APP" -d "$D33" product add P1 螺丝 >/dev/null
node "$APP" -d "$D33" in OK1 --wh W1 --item P1:5 >/dev/null
# 业务拒绝（缺货）后锁必须释放，后续写入立即可得
node "$APP" -d "$D33" out BAD1 --wh W1 --item P1:99 >/dev/null 2>&1
out=$(node "$APP" -d "$D33" in OK2 --wh W1 --item P1:1)
check "业务失败后释放归属正确，后续写入立即可用" "入库单 OK2 提交成功" "$out"
# 手工放置一个死 pid 身份文件（非闸门，不参与占用），持有者写入时应清理且不动自己的文件
dead=$(dead_pid)
touch "$D33/.stockroom.json.lock.$dead.orphan"
node "$APP" -d "$D33" in OK3 --wh W1 --item P1:1 >/dev/null
[ ! -e "$D33/.stockroom.json.lock.$dead.orphan" ] && echo "ok   - 取得写入机会后清理已退出进程的孤立身份文件" || { echo "FAIL - 孤立身份文件未清理"; FAIL=1; }
nlocks=$(ls -a "$D33" | grep -c '^\.stockroom\.json\.lock' || true)
[ "$nlocks" -eq 0 ] && echo "ok   - 清理不误伤，正常结束后无任何锁文件残留" || { echo "FAIL - 锁文件残留：$(ls -a "$D33")"; FAIL=1; }

echo "-- 14.5 原子替换前异常退出：不生效；遗留临时内容不算提交；存活临时文件不被清除 --"
D34="$TMP/data34"
node "$APP" -d "$D34" product add P1 螺丝 >/dev/null
node "$APP" -d "$D34" in BASE --wh W1 --item P1:3 >/dev/null
# 存活请求的临时文件：写一个带存活 pid 的遗留临时名，恢复写入不得删除
sleep 60 & KEEP=$!
touch "$D34/.stockroom.json.$KEEP.keep.tmp"
STOCKROOM_TEST_CRASH=before-tmp node "$APP" -d "$D34" in CRASH1 --wh W1 --item P1:100 >/dev/null 2>&1
# 进程已被 SIGKILL：留下死锁，后续写请求恢复
out=$(node "$APP" -d "$D34" in AGAIN1 --wh W1 --item P1:1); code=$?
[ $code -eq 0 ] && echo "ok   - 替换前崩溃后自动恢复且新请求成功" || { echo "FAIL - 崩溃后恢复失败：$out"; FAIL=1; }
check "崩溃请求未生效（余量仍为 3+1=4）" "余量：商品 P1 仓库 W1 = 4" "$(node "$APP" -d "$D34" balance P1 --wh W1)"
[ -e "$D34/.stockroom.json.$KEEP.keep.tmp" ] && echo "ok   - 存活请求的临时文件未被清除" || { echo "FAIL - 存活临时文件被误删"; FAIL=1; }
kill "$KEEP" 2>/dev/null; wait "$KEEP" 2>/dev/null
# 死 pid 的遗留临时文件（内容为损坏 JSON）不算提交，且在下次取得写入机会时清理
printf '{not json' > "$D34/.stockroom.json.999999.leftover.tmp"
out=$(node "$APP" -d "$D34" in AGAIN2 --wh W1 --item P1:1); code=$?
[ $code -eq 0 ] && echo "ok   - 死进程遗留损坏临时文件不影响提交" || { echo "FAIL - 遗留临时文件阻断提交：$out"; FAIL=1; }
[ ! -e "$D34/.stockroom.json.999999.leftover.tmp" ] && echo "ok   - 死进程遗留临时文件已清理" || { echo "FAIL - 遗留临时文件未清理"; FAIL=1; }
check "损坏临时内容从未被当作已提交数据（余量 5）" "余量：商品 P1 仓库 W1 = 5" "$(node "$APP" -d "$D34" balance P1 --wh W1)"
# 写临时文件之后、rename 之前崩溃同样不生效
STOCKROOM_TEST_CRASH=after-tmp node "$APP" -d "$D34" in CRASH2 --wh W1 --item P1:100 >/dev/null 2>&1
out=$(node "$APP" -d "$D34" in CRASH2 --wh W1 --item P1:7)
check "rename 前崩溃：同号重试作为新提交生效（此前不占编号）" "入库单 CRASH2 提交成功" "$out"
check "重试入库 7 件后余量为 12" "余量：商品 P1 仓库 W1 = 12" "$(node "$APP" -d "$D34" balance P1 --wh W1)"

echo "-- 14.6 原子替换后异常退出（未输出成功）：完整提交保留，重试返回原结果、不改写文件 --"
D35="$TMP/data35"
node "$APP" -d "$D35" product add P1 螺丝 >/dev/null
STOCKROOM_TEST_CRASH=after-rename node "$APP" -d "$D35" in LUCKY --wh W1 --item P1:9 >/dev/null 2>&1
# 崩溃发生在 rename 之后：数据文件应已含完整提交
check "替换后崩溃：提交已落盘（余量 9）" "余量：商品 P1 仓库 W1 = 9" "$(node "$APP" -d "$D35" balance P1 --wh W1)"
sum1=$(cksum < "$D35/stockroom.json")
out=$(node "$APP" -d "$D35" in LUCKY --wh W1 --item P1:9)
check "未输出成功的提交重试返回原结果（重复提交）" "为重复提交" "$out"
sum2=$(cksum < "$D35/stockroom.json")
[ "$sum1" = "$sum2" ] && echo "ok   - 崩溃后重放不改写数据文件" || { echo "FAIL - 重放改写了文件"; FAIL=1; }
check "重放不重复生效（余量仍为 9）" "余量：商品 P1 仓库 W1 = 9" "$(node "$APP" -d "$D35" balance P1 --wh W1)"
# 恢复后的流水连续且编号保留
nflow=$(node "$APP" -d "$D35" flow --product P1 --wh W1 | grep -c '^#')
[ "$nflow" -eq 1 ] && echo "ok   - 崩溃提交的流水保留（仅 1 条，重放不追加）" || { echo "FAIL - 流水条数异常 $nflow"; FAIL=1; }

echo "-- 14.7 忙目录中的用法错误：等待前退出 2 且不创建协调文件；等待配置边界 --"
D36="$TMP/data36"
mkdir -p "$D36"
sleep 45 & BUSY=$!
touch "$D36/.stockroom.json.lock.$BUSY.b0"
ln "$D36/.stockroom.json.lock.$BUSY.b0" "$D36/.stockroom.json.lock"
t0=$(date +%s%N)
out=$(STOCKROOM_LOCK_WAIT_MS=30000 node "$APP" -d "$D36" in 2>&1); code=$?
t1=$(date +%s%N); ms=$(( (t1-t0)/1000000 ))
if [ $code -eq 2 ] && [ $ms -lt 1000 ]; then
  echo "ok   - 忙目录中缺参数仍立即退出 2（${ms}ms），不等待"
else
  echo "FAIL - 忙目录用法错误异常（code=$code, ${ms}ms）：$out"; FAIL=1
fi
out=$(STOCKROOM_LOCK_WAIT_MS=30000 node "$APP" -d "$D36" product add 2>&1); code=$?
[ $code -eq 2 ] && echo "ok   - 忙目录中缺名称退出 2" || { echo "FAIL - code=$code $out"; FAIL=1; }
out=$(STOCKROOM_LOCK_WAIT_MS=30000 node "$APP" -d "$D36" arrival A1 --po PO1 2>&1); code=$?
[ $code -eq 2 ] && echo "ok   - 忙目录中缺明细退出 2" || { echo "FAIL - code=$code $out"; FAIL=1; }
out=$(STOCKROOM_LOCK_WAIT_MS=30000 node "$APP" -d "$D36" in D1 --wh W1 --item P1:1 --bogus 2>&1); code=$?
[ $code -eq 2 ] && echo "ok   - 忙目录中未知选项退出 2" || { echo "FAIL - code=$code $out"; FAIL=1; }
nnew=$(ls -a "$D36" | grep -c '^\.stockroom\.json\.lock\.' || true)
[ "$nnew" -eq 1 ] && echo "ok   - 用法错误未创建本请求的协调文件（仅原占用者身份文件）" || { echo "FAIL - 协调文件异常：$(ls -a "$D36")"; FAIL=1; }
# 状态校验仍在取得写入机会后：忙目录中对“编号冲突/缺货”等应等待到超时（退出 1），而非退出 2
out=$(STOCKROOM_LOCK_WAIT_MS=150 node "$APP" -d "$D36" in D1 --wh W1 --item P1:1 2>&1); code=$?
[ $code -eq 1 ] && echo "ok   - 库存状态校验仍在取得写入机会后（忙时超时退出 1）" || { echo "FAIL - code=$code $out"; FAIL=1; }
# 等待配置边界：非法/超范围在等待前退出 2
for bad in abc -1 1.5 '' 9007199254740992 99999999999999999999 ' 12'; do
  out=$(STOCKROOM_LOCK_WAIT_MS="$bad" node "$APP" -d "$D36" in Z1 --wh W1 --item P1:1 2>&1); code=$?
  [ $code -eq 2 ] && echo "ok   - 非法等待配置 '$bad' 退出 2（不转无限等待）" || { echo "FAIL - '$bad' code=$code：$out"; FAIL=1; }
done
# 0 = 仅立即尝试：忙目录立即退出 1
t0=$(date +%s%N)
out=$(STOCKROOM_LOCK_WAIT_MS=0 node "$APP" -d "$D36" in Z2 --wh W1 --item P1:1 2>&1); code=$?
t1=$(date +%s%N); ms=$(( (t1-t0)/1000000 ))
if [ $code -eq 1 ] && [ $ms -lt 500 ]; then
  echo "ok   - 等待 0 毫秒仅立即尝试，忙目录立即退出 1（${ms}ms）"
else
  echo "FAIL - 零等待异常（code=$code, ${ms}ms）：$out"; FAIL=1
fi
kill "$BUSY" 2>/dev/null; wait "$BUSY" 2>/dev/null
# 占用者退出后，所有被拒请求可正常重试，结果齐全
node "$APP" -d "$D36" product add P1 螺丝 >/dev/null
out=$(node "$APP" -d "$D36" in Z2 --wh W1 --item P1:4)
check "忙目录恢复后请求可成功" "入库单 Z2 提交成功" "$out"
check "忙目录恢复后余量正确（4）" "余量：商品 P1 仓库 W1 = 4" "$(node "$APP" -d "$D36" balance P1 --wh W1)"

echo "-- 14.8 恢复后竞争结果核对：竞争库存/采购待收不超量、同号去重、失败后已提交仍在 --"
D37="$TMP/data37"
node "$APP" -d "$D37" product add P1 螺丝 >/dev/null
node "$APP" -d "$D37" po register PO1 --supplier S1 --wh W1 --item P1:5 >/dev/null
setup_dead_lock "$D37"
: > "$TMP/rec-race.res"
# 4 个到货请求各抢 2 件（待收 5），只能 2 个成功、2 个超量拒绝；另加 2 个同号同内容请求只生效一次
( node "$APP" -d "$D37" arrival RA1 --po PO1 --item P1:2 >/dev/null 2>&1; echo "a1=$?" ) >> "$TMP/rec-race.res" &
( node "$APP" -d "$D37" arrival RA2 --po PO1 --item P1:2 >/dev/null 2>&1; echo "a2=$?" ) >> "$TMP/rec-race.res" &
( node "$APP" -d "$D37" arrival RA3 --po PO1 --item P1:2 >/dev/null 2>&1; echo "a3=$?" ) >> "$TMP/rec-race.res" &
( node "$APP" -d "$D37" arrival RA4 --po PO1 --item P1:2 >/dev/null 2>&1; echo "a4=$?" ) >> "$TMP/rec-race.res" &
( node "$APP" -d "$D37" arrival DUPA --po PO1 --item P1:1 >/dev/null 2>&1; echo "d1=$?" ) >> "$TMP/rec-race.res" &
( node "$APP" -d "$D37" arrival DUPA --po PO1 --item P1:1 >/dev/null 2>&1; echo "d2=$?" ) >> "$TMP/rec-race.res" &
wait
codes=$(sed 's/^[a-z0-9]*=//' "$TMP/rec-race.res" | sort | tr '\n' ' ')
# 合法串行结果固定为 4 个退出 0（恰两笔新到货共 4 件 + DUPA 1 件 + DUPA 重放）、
# 2 个退出 1（另外两笔到货超量拒绝）；具体哪两个 RA 编号胜出不做要求。
case "$codes" in
  0\ 0\ 0\ 0\ 1\ 1\ ) : ;;
  *) echo "FAIL - 恢复竞争出现异常退出码（只应有 4 个 0、2 个 1）：$(cat "$TMP/rec-race.res")"; FAIL=1 ;;
esac
ndup=$(grep -c '^d[12]=0$' "$TMP/rec-race.res" || true)
[ "$ndup" -eq 2 ] && echo "ok   - 同号同内容两个请求都成功返回（其一为去重重放）" || { echo "FAIL - 同号请求退出码异常：$(cat "$TMP/rec-race.res")"; FAIL=1; }
nra_ok=$(grep -E '^a[0-9]=0$' "$TMP/rec-race.res" | wc -l | tr -d ' ')
nra_no=$(grep -E '^a[0-9]=1$' "$TMP/rec-race.res" | wc -l | tr -d ' ')
[ "$nra_ok" -eq 2 ] && [ "$nra_no" -eq 2 ] \
  && echo "ok   - 竞争采购待收恰好两笔新到货成功（4 件）、两笔超量拒绝，不超量" \
  || { echo "FAIL - 到货竞争成败数异常（成功 $nra_ok 拒绝 $nra_no）"; FAIL=1; }
check "恢复竞争后采购精确收齐、无超收" "P1	5	5	0	收齐" "$(node "$APP" -d "$D37" po show PO1 | grep -E '^P1	')"
# 状态校验在取得写入机会后：同号不同内容按原规则拒绝（先确定性地成功提交 SDD1）
node "$APP" -d "$D37" po register PO2 --supplier S2 --wh W2 --item P1:10 >/dev/null
node "$APP" -d "$D37" arrival SDD1 --po PO2 --item P1:2 >/dev/null
setup_dead_lock "$D37"
: > "$TMP/rec-conf.res"
( node "$APP" -d "$D37" arrival SDD1 --po PO2 --item P1:3 >/dev/null 2>&1; echo "c1=$?" ) >> "$TMP/rec-conf.res" &
( node "$APP" -d "$D37" arrival SDD1 --po PO2 --item P1:4 >/dev/null 2>&1; echo "c2=$?" ) >> "$TMP/rec-conf.res" &
wait
# SDD1 已成功（2 件）：同号不同内容两个请求都必须拒绝，且不改变已提交结果
sort "$TMP/rec-conf.res" | tr '\n' ' ' | grep -q 'c1=1 c2=1' \
  && echo "ok   - 回收/释放交错下同号不同内容两个请求均拒绝（退出 1）" \
  || { echo "FAIL - 同号冲突结果异常：$(cat "$TMP/rec-conf.res")"; FAIL=1; }
# 同号同内容重放仍返回原结果，不改进度
out=$(node "$APP" -d "$D37" arrival SDD1 --po PO2 --item P1:2)
check "SDD1 同号同内容重放返回原结果" "为重复提交" "$out"
check "重放不改变 PO2 进度（有效到货仍为 2）" "P1	10	2	8	部分到货" "$(node "$APP" -d "$D37" po show PO2 | grep -E '^P1	')"
check "PO1 已提交状态不受冲突请求影响（仍收齐）" "P1	5	5	0	收齐" "$(node "$APP" -d "$D37" po show PO1 | grep -e '^P1	')"
# 失败后再写立即可用（锁归属正确释放）
node "$APP" -d "$D37" product add P2 螺母 >/dev/null
out=$(node "$APP" -d "$D37" product list)
check "失败后的已提交状态与后续写入均正常" "P2	螺母" "$out"
nlocks=$(ls -a "$D37" | grep -c '^\.stockroom\.json\.lock' || true)
[ "$nlocks" -eq 0 ] && echo "ok   - 回收/释放交错后无锁文件残留" || { echo "FAIL - 锁残留：$(ls -a "$D37")"; FAIL=1; }

echo "== 15. 确定性同步：接任/回收/释放竞态（不靠随机并发碰运气） =="
# 通过 STOCKROOM_TEST_SYNC 同步点与 STOCKROOM_TEST_CRASH 崩溃注入，精确安排两个请求
# 先观察同一死协调者、一个接任后另一个继续处理、接任途中再退出、旧请求延迟清理。
export STOCKROOM_LOCK_WAIT_MS=30000

wait_for() { # wait_for <标记文件>：等待其出现（确定性放行，不靠睡眠猜时机）
  f=$1; i=0
  until [ -e "$f" ]; do
    sleep 0.02; i=$((i+1))
    [ $i -ge 1500 ] && { echo "FAIL - 等待标记超时：$f"; FAIL=1; return 1; }
  done
}

# 布置“遗留写入占用 + 已退出回收协调者”：死闸门（旧写进程 W）与死协调者文件（C）。
# 协调者文件内容首行必须带其 pid（与真实协调者身份内容一致），否则按不可判定处理。
setup_dead_coord_lock() { # setup_dead_coord_lock <数据目录>
  d=$1; mkdir -p "$d"
  w=$(dead_pid); c=$(dead_pid)
  printf '%s dead-writer w0\n' "$w" > "$d/.stockroom.json.lock.$w.w0"
  ln "$d/.stockroom.json.lock.$w.w0" "$d/.stockroom.json.lock"     # 死闸门=旧写进程占用
  printf '%s dead-coord c0\n' "$c" > "$d/.stockroom.json.lock.$c.c0"
  ln "$d/.stockroom.json.lock.$c.c0" "$d/.stockroom.json.lock.coord" # 死协调者（接任前退出）
}
ino() { stat -f '%i' "$1"; }

echo "-- 15.1 两请求先都确认旧协调者已死；A 接任后 B 才继续，B 不得移走 A 的存活占用 --"
D40="$TMP/data40"; SY="$TMP/sy40"; rm -rf "$D40" "$SY"; mkdir -p "$SY"
node "$APP" -d "$D40" product add P1 螺丝 >/dev/null
setup_dead_coord_lock "$D40"
# A：在“搬走死协调者前”停下等放行；接任 rename 后持锁再停下（持有存活占用）。
STOCKROOM_TEST_SYNC='[{"point":"coord-dead","signal":"'$SY'/a-dead","wait":"'$SY'/a-go"},{"point":"take-after","signal":"'$SY'/a-taken","wait":"'$SY'/a-finish"}]' \
  node "$APP" -d "$D40" in A1 --wh W1 --item P1:10 >"$SY/a.out" 2>&1 &
AP=$!
wait_for "$SY/a-dead"
# B：同样在“搬走死协调者前”停下（此时 A、B 都仅凭旧信息认定协调者 C 已死）。
STOCKROOM_TEST_SYNC='[{"point":"coord-dead","signal":"'$SY'/b-dead","wait":"'$SY'/b-go"},{"point":"coord-restore","signal":"'$SY'/b-restored"}]' \
  node "$APP" -d "$D40" in B1 --wh W1 --item P1:7 >"$SY/b.out" 2>&1 &
BP=$!
wait_for "$SY/b-dead"
# 放行 A：A 回收死协调者、接任闸门并停在存活持有状态。
touch "$SY/a-go"; wait_for "$SY/a-taken"
sleep 0.2 # 确保 A 已停稳在 take-after（此时闸门/协调者/身份都是 A 的存活硬链接）
gate_ino_before=$(ino "$D40/.stockroom.json.lock")
a_id=$(ls "$D40"/.stockroom.json.lock."$AP".* 2>/dev/null | head -1)
[ -n "$a_id" ] && [ "$(ino "$a_id")" = "$gate_ino_before" ] \
  && echo "ok   - A 接任后身份文件是闸门同 inode 的存活锚点" \
  || { echo "FAIL - A 接任后身份锚点异常：$a_id"; FAIL=1; }
# 放行迟到者 B：它将凭“先前 C 已死”的判断搬走 coord，但搬走的其实是 A 的存活文件。
touch "$SY/b-go"; wait_for "$SY/b-restored"
# B 必须已还原：闸门仍是 A 的存活占用，coord 也被还原为同一 inode。
gate_ino_after=$(ino "$D40/.stockroom.json.lock")
[ "$gate_ino_before" = "$gate_ino_after" ] \
  && echo "ok   - 迟到者 B 未移走 A 刚取得的闸门（inode 不变）" \
  || { echo "FAIL - B 搬走了 A 的闸门（$gate_ino_before -> ${gate_ino_after}）"; FAIL=1; }
[ -e "$D40/.stockroom.json.lock.coord" ] && [ "$(ino "$D40/.stockroom.json.lock.coord")" = "$gate_ino_after" ] \
  && echo "ok   - B 把误搬走的存活协调者文件原子还原（coord 仍指向 A）" \
  || { echo "FAIL - 存活协调者文件未正确还原"; FAIL=1; }
kill -0 "$AP" 2>/dev/null && echo "ok   - A 在 B 的迟到清理后仍存活持锁" || { echo "FAIL - A 意外退出"; FAIL=1; }
# 放行 A 完成提交并释放；B 随后串行取得写入机会完成自己的单据。
touch "$SY/a-finish"
wait "$AP"; ac=$?
wait "$BP"; bc=$?
[ $ac -eq 0 ] && echo "ok   - A 完成提交（退出 0）" || { echo "FAIL - A 退出 ${ac}：$(cat "$SY/a.out")"; FAIL=1; }
[ $bc -eq 0 ] && echo "ok   - B 等待 A 释放后串行接任并提交（退出 0）" || { echo "FAIL - B 退出 ${bc}：$(cat "$SY/b.out")"; FAIL=1; }
out=$(node "$APP" -d "$D40" balance P1 --wh W1)
check "接任竞态后两笔数量全部保留（10+7=17）" "余量：商品 P1 仓库 W1 = 17" "$out"
nflow=$(node "$APP" -d "$D40" flow --product P1 --wh W1 | grep -c '^#')
[ "$nflow" -eq 2 ] && echo "ok   - 接任竞态后恰好两笔流水（失败/等待不占编号）" || { echo "FAIL - 流水条数 $nflow"; FAIL=1; }
seqs=$(node "$APP" -d "$D40" flow --product P1 --wh W1 | sed -n 's/^#\([0-9]*\)	.*/\1/p' | tr '\n' ' ')
[ "$seqs" = "1 2 " ] && echo "ok   - 接任竞态后流水序号 1、2 连续" || { echo "FAIL - 流水序号不连续：$seqs"; FAIL=1; }
docs=$(node "$APP" -d "$D40" flow --product P1 --wh W1 | sed -n 's/^#[0-9]*	单据=\([A-Z0-9]*\)	.*/\1/p' | sort | tr '\n' ' ')
[ "$docs" = "A1 B1 " ] && echo "ok   - 接任竞态后两笔编号 A1、B1 齐全" || { echo "FAIL - 流水编号异常：$docs"; FAIL=1; }
nlocks=$(ls -a "$D40" | grep -c '^\.stockroom\.json\.lock' || true)
[ "$nlocks" -eq 0 ] && echo "ok   - 接任竞态结束后闸门/身份/协调文件全部释放" || { echo "FAIL - 锁残留：$(ls -a "$D40")"; FAIL=1; }

echo "-- 15.2 接任者在接任途中再次退出：取得写入机会前/后退出，后续请求均自动恢复 --"
crash_takeover() { # crash_takeover <崩溃点> <数据目录> <崩溃单号> <恢复单号>
  cp=$1; d=$2; crid=$3; okid=$4
  node "$APP" -d "$d" product add P1 螺丝 >/dev/null
  setup_dead_lock "$d"
  STOCKROOM_TEST_CRASH="$cp" node "$APP" -d "$d" in "$crid" --wh W1 --item P1:100 >/dev/null 2>&1 &
  wait $! 2>/dev/null # 接任者按注入点 SIGKILL 退出（后台执行以抑制作业报告）
  # 接任者已死：后续请求必须自动回收（死闸门+死协调者+死身份/锚点），无需手工删文件。
  out=$(node "$APP" -d "$d" in "$okid" --wh W1 --item P1:4 2>&1); code=$?
  [ $code -eq 0 ] && echo "ok   - 接任者崩于 $cp 后自动恢复，$okid 成功" || { echo "FAIL - $cp 后恢复失败：$out"; FAIL=1; }
  out=$(node "$APP" -d "$d" balance P1 --wh W1)
  check "${cp}：崩溃接任者业务不生效、恢复笔完整（余量 4）" "余量：商品 P1 仓库 W1 = 4" "$out"
  nflow=$(node "$APP" -d "$d" flow --product P1 --wh W1 | grep -c '^#')
  [ "$nflow" -eq 1 ] && echo "ok   - ${cp}：崩溃接任者不占流水/编号（仅恢复笔 1 条）" || { echo "FAIL - $cp 流水条数 $nflow"; FAIL=1; }
  docs=$(node "$APP" -d "$d" flow --product P1 --wh W1 | sed -n 's/^#[0-9]*	单据=\([A-Z0-9]*\)	.*/\1/p' | tr '\n' ' ')
  [ "$docs" = "$okid " ] && echo "ok   - ${cp}：流水只有恢复单 ${okid}，崩溃单 $crid 未占编号" || { echo "FAIL - $cp 流水编号异常：$docs"; FAIL=1; }
  nlocks=$(ls -a "$d" | grep -c '^\.stockroom\.json\.lock' || true)
  [ "$nlocks" -eq 0 ] && echo "ok   - ${cp}：恢复后无任何协调文件残留（含死锚点/死身份）" || { echo "FAIL - $cp 锁残留：$(ls -a "$d")"; FAIL=1; }
}
crash_takeover after-coord        "$TMP/data41" CR1 OK1   # 当选协调者后、接任闸门前退出
crash_takeover after-take-link    "$TMP/data42" CR2 OK2   # 接任锚点已建、rename 闸门前退出
crash_takeover after-take-rename  "$TMP/data43" CR3 OK3   # 接任闸门后（已取得机会）、业务前退出

echo "-- 15.3 较早请求延迟结束/超时清理与新请求接任交错：只清理自己的占用 --"
D44="$TMP/data44"; SY="$TMP/sy44"; rm -rf "$D44" "$SY"; mkdir -p "$SY"
node "$APP" -d "$D44" product add P1 螺丝 >/dev/null
# A 完成业务提交后、释放闸门前停住（存活持有者，数据已落盘）。
STOCKROOM_TEST_SYNC='{"point":"release-before","signal":"'$SY'/a-rel","wait":"'$SY'/a-go"}' \
  node "$APP" -d "$D44" in EARLY --wh W1 --item P1:5 >"$SY/a.out" 2>&1 &
AP=$!
wait_for "$SY/a-rel"
# 存活持有者即使“暂停很久”也不被接管：只读查询能读到已提交的 5 件，闸门仍是 A。
check "A 提交后、释放前暂停期间数据已完整落盘" "余量：商品 P1 仓库 W1 = 5" "$(node "$APP" -d "$D44" balance P1 --wh W1)"
before=$(ls "$D44"/.stockroom.json.lock* 2>/dev/null)
# 超时请求 T（等待 0.15s）：退出 1，其 abandon 清理只能删自己的身份文件。
out=$(STOCKROOM_LOCK_WAIT_MS=150 node "$APP" -d "$D44" in TIMEOUT1 --wh W1 --item P1:1 2>&1); code=$?
[ $code -eq 1 ] && echo "ok   - 存活持有者暂停期间新请求等待超时退出 1" || { echo "FAIL - 超时请求退出码 ${code}：$out"; FAIL=1; }
after=$(ls "$D44"/.stockroom.json.lock* 2>/dev/null)
[ "$before" = "$after" ] && echo "ok   - 超时清理未删除持有者的闸门/身份（只清自己）" || { echo "FAIL - 超时清理误删：before=[$before] after=[$after]"; FAIL=1; }
check "超时请求不生效、不占编号" "余量：商品 P1 仓库 W1 = 5" "$(node "$APP" -d "$D44" balance P1 --wh W1)"
kill -0 "$AP" 2>/dev/null && echo "ok   - A 经历超时请求交错后仍存活持锁" || { echo "FAIL - A 意外退出：$(cat "$SY/a.out")"; FAIL=1; }
# 新请求 B 在 A 释放前任由等待；A 一释放即接任提交，A 的延迟释放不得影响 B 的占用。
node "$APP" -d "$D44" in LATE --wh W1 --item P1:3 >"$SY/b.out" 2>&1 &
BP=$!
sleep 0.3
touch "$SY/a-go"; wait "$AP"; wait "$BP"
grep -q '入库单 LATE 提交成功' "$SY/b.out" \
  && echo "ok   - A 延迟释放后 B 立即接任并提交" || { echo "FAIL - B 未成功接任：$(cat "$SY/b.out")"; FAIL=1; }
check "较早请求的提交保留、新请求数量完整（5+3=8）" "余量：商品 P1 仓库 W1 = 8" "$(node "$APP" -d "$D44" balance P1 --wh W1)"
nflow=$(node "$APP" -d "$D44" flow --product P1 --wh W1 | grep -c '^#')
[ "$nflow" -eq 2 ] && echo "ok   - 超时不占编号，只有 EARLY、LATE 两笔流水" || { echo "FAIL - 流水条数 $nflow"; FAIL=1; }
seqs=$(node "$APP" -d "$D44" flow --product P1 --wh W1 | sed -n 's/^#\([0-9]*\)	.*/\1/p' | tr '\n' ' ')
[ "$seqs" = "1 2 " ] && echo "ok   - 延迟释放/接任交错下流水序号 1、2 连续" || { echo "FAIL - 流水序号：$seqs"; FAIL=1; }
nlocks=$(ls -a "$D44" | grep -c '^\.stockroom\.json\.lock' || true)
[ "$nlocks" -eq 0 ] && echo "ok   - 延迟释放交错后无协调文件残留" || { echo "FAIL - 锁残留：$(ls -a "$D44")"; FAIL=1; }

echo "-- 15.4 确定性接任交错下竞争采购待收不超量、同号同内容只生效一次、重放返回原结果 --"
D45="$TMP/data45"; SY="$TMP/sy45"; rm -rf "$D45" "$SY"; mkdir -p "$SY"
node "$APP" -d "$D45" product add P1 螺丝 >/dev/null
node "$APP" -d "$D45" po register PO1 --supplier S1 --wh W1 --item P1:5 >/dev/null
setup_dead_lock "$D45"
# A 从死闸门接任、到货 4 后持锁暂停；B 在 A 存活持有期间只能等待。
STOCKROOM_TEST_SYNC='{"point":"take-after","signal":"'$SY'/a-taken","wait":"'$SY'/a-go"}' \
  node "$APP" -d "$D45" arrival AR1 --po PO1 --item P1:4 >"$SY/a.out" 2>&1 &
AP=$!
wait_for "$SY/a-taken"
( node "$APP" -d "$D45" arrival AR2 --po PO1 --item P1:4 >"$SY/b.out" 2>&1; echo $? >"$SY/b.code" ) &
BP=$!
sleep 0.3
touch "$SY/a-go"; wait "$AP"; wait "$BP"
[ "$(cat "$SY/b.code")" = "1" ] && echo "ok   - A 到货 4 接任提交后，B 再到货 4 超量被整单拒绝" || { echo "FAIL - B 码=$(cat "$SY/b.code")：$(cat "$SY/b.out")"; FAIL=1; }
out=$(node "$APP" -d "$D45" arrival AR3 --po PO1 --item P1:1)
check "剩余待收 1 由 AR3 精确收齐" "待到货 0" "$out"
out=$(node "$APP" -d "$D45" po show PO1)
check "接任交错下采购不超量（有效到货 5/5，收齐）" "P1	5	5	0	收齐" "$out"
# 同号同内容重放只返回原结果、不再生效、不改文件
sum1=$(cksum < "$D45/stockroom.json")
out=$(node "$APP" -d "$D45" arrival AR1 --po PO1 --item P1:4)
check "AR1 同号同内容重放返回原结果" "为重复提交" "$out"
sum2=$(cksum < "$D45/stockroom.json")
[ "$sum1" = "$sum2" ] && echo "ok   - 接任交错后重放不改写数据文件" || { echo "FAIL - 重放改写文件"; FAIL=1; }
# 同号改内容拒绝
out=$(node "$APP" -d "$D45" arrival AR1 --po PO1 --item P1:3 2>&1); code=$?
[ $code -eq 1 ] && echo "ok   - 接任交错后同号改内容仍拒绝（退出 1）" || { echo "FAIL - 改内容码 ${code}：$out"; FAIL=1; }
check "拒绝不影响已提交进度（仍 5/5 收齐）" "P1	5	5	0	收齐" "$(node "$APP" -d "$D45" po show PO1)"
narr=$(node "$APP" -d "$D45" flow --product P1 --wh W1 | grep -c '单据=AR' || true)
[ "$narr" -eq 2 ] && echo "ok   - 流水中只有 AR1、AR3 两次到货（AR2 超量不占编号）" || { echo "FAIL - 到货流水数 $narr"; FAIL=1; }
nlocks=$(ls -a "$D45" | grep -c '^\.stockroom\.json\.lock' || true)
[ "$nlocks" -eq 0 ] && echo "ok   - 采购接任竞态后无协调文件残留" || { echo "FAIL - 锁残留：$(ls -a "$D45")"; FAIL=1; }
unset STOCKROOM_LOCK_WAIT_MS

echo
if [ $FAIL -eq 0 ]; then echo "全部回归检查通过"; else echo "存在失败项"; exit 1; fi
