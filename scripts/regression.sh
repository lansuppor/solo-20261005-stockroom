#!/usr/bin/env bash
# stockroom 本地回归检查（Node.js 24，无外部依赖）
# 覆盖：精度边界、取消与冲销、批量回滚、重载及历史重放。
# 用法：bash scripts/regression.sh
set -u
cd "$(dirname "$0")/.."

APP="node app.ts"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }

# expect_out <说明> <预期子串> <命令...>：命令须成功（退出 0）且输出含预期子串
expect_out() {
  local desc="$1" want="$2"; shift 2
  local out
  out=$("$@" 2>&1)
  if [ $? -eq 0 ] && printf '%s' "$out" | grep -qF -- "$want"; then ok "$desc"
  else bad "${desc}（输出：$(printf '%s' "$out" | tail -2)）"; fi
}

# expect_reject <说明> <预期错误子串> <命令...>：命令须以退出码 1 拒绝且标准错误含预期子串
expect_reject() {
  local desc="$1" want="$2"; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq 1 ] && printf '%s' "$out" | grep -qF -- "$want"; then ok "$desc"
  else bad "${desc}（退出码 ${rc}，输出：$(printf '%s' "$out" | tail -2)）"; fi
}

MAX=9007199254740991 # Number.MAX_SAFE_INTEGER

# ============ 1. 精度边界：反复退货、补收后的净进度 ============
D=$(mktemp -d)
$APP -d "$D" product add P1 螺丝 >/dev/null || bad "登记商品"
$APP -d "$D" po register PO1 --supplier S1 --wh W1 --item P1:$MAX >/dev/null || bad "登记采购单"
expect_out "边界：全额到货 $MAX" "待到货 0" $APP -d "$D" arrival A1 --po PO1 --item P1:$MAX
# 两次“退 1 再补收 1”：累计到货达 2^53+1（超过安全整数），累计退货 2
expect_out "边界：第 1 次退 1" "待到货 1" $APP -d "$D" return T1 --arrival A1 --item P1:1
expect_out "边界：第 1 次补收 1" "待到货 0" $APP -d "$D" arrival A2 --po PO1 --item P1:1
expect_out "边界：第 2 次退 1" "待到货 1" $APP -d "$D" return T2 --arrival A2 --item P1:1
expect_out "边界：第 2 次补收 1" "待到货 0" $APP -d "$D" arrival A3 --po PO1 --item P1:1
SHOW=$($APP -d "$D" po show PO1)
printf '%s' "$SHOW" | grep -qF "P1	$MAX	$MAX	2	0	收齐" \
  && ok "边界：有效到货仍等于订购量、待收 0、状态收齐" \
  || bad "边界：有效到货仍等于订购量、待收 0、状态收齐（${SHOW}）"
# 出库腾出容量后也不得再到货或取消 1 件
$APP -d "$D" out O1 --wh W1 --item P1:10 >/dev/null || bad "边界：出库腾出容量"
expect_reject "边界：收齐后不得再到货 1" "待到货 0" $APP -d "$D" arrival A4 --po PO1 --item P1:1
expect_reject "边界：收齐后不得再取消 1" "待到货 0" $APP -d "$D" cancel X1 --po PO1 --item P1:1
# 有效退货合计超过安全整数时显示完整十进制
D2=$(mktemp -d)
$APP -d "$D2" product add P1 螺丝 >/dev/null
$APP -d "$D2" po register PO1 --supplier S1 --wh W1 --item P1:$MAX >/dev/null
$APP -d "$D2" arrival A1 --po PO1 --item P1:$MAX >/dev/null
$APP -d "$D2" return T1 --arrival A1 --item P1:$MAX >/dev/null
$APP -d "$D2" arrival A2 --po PO1 --item P1:$MAX >/dev/null
$APP -d "$D2" return T2 --arrival A2 --item P1:$MAX >/dev/null
expect_out "边界：有效退货合计 18014398509481982 完整显示" "	18014398509481982	" $APP -d "$D2" po show PO1
rm -rf "$D" "$D2"

# ============ 2. 取消与冲销 ============
D=$(mktemp -d)
$APP -d "$D" product add P1 螺丝 >/dev/null
$APP -d "$D" po register PO1 --supplier S1 --wh W1 --item P1:10 >/dev/null
expect_out "取消：取消 4 后待到货 6" "待到货 6" $APP -d "$D" cancel X1 --po PO1 --item P1:4
expect_reject "取消：超过待到货量整单拒绝" "取消量超出待到货量" $APP -d "$D" cancel X2 --po PO1 --item P1:7
expect_out "取消：到货 6 后待到货 0" "待到货 0" $APP -d "$D" arrival A1 --po PO1 --item P1:6
expect_out "取消：含取消结清状态" "P1	10	6	4	0	已结清（含取消）" $APP -d "$D" po show PO1
expect_out "冲销取消：恢复待到货 4" "待到货 4" $APP -d "$D" reverse R1 --orig X1
expect_out "冲销取消后补收到货 4 收齐" "待到货 0" $APP -d "$D" arrival A2 --po PO1 --item P1:4
expect_out "冲销取消后状态收齐" "收齐" $APP -d "$D" po show PO1
# 退货与退货冲销
expect_out "退货：退 2 后待到货回升" "待到货 2" $APP -d "$D" return T1 --arrival A2 --item P1:2
expect_reject "退货：超过原到货剩余可退量拒绝" "退货超量" $APP -d "$D" return T2 --arrival A2 --item P1:3
expect_reject "冲销到货：有未冲销退货的到货单禁止冲销" "禁止冲销" $APP -d "$D" reverse R2 --orig A2
expect_out "冲销退货：恢复有效到货" "待到货 0" $APP -d "$D" reverse R3 --orig T1
expect_out "退货冲销后可冲销到货" "冲销到货" $APP -d "$D" reverse R4 --orig A2
expect_out "冲销到货后待到货回升" "P1	10	6	0	0	4	部分到货" $APP -d "$D" po show PO1
rm -rf "$D"

# ============ 3. 批量回滚 ============
D=$(mktemp -d)
$APP -d "$D" product add P1 螺丝 >/dev/null
$APP -d "$D" po register PO1 --supplier S1 --wh W1 --item P1:5 >/dev/null
F=$(mktemp)
cat > "$F" <<'JSON'
[
  {"type": "arrival", "id": "A1", "po": "PO1", "items": [{"product": "P1", "qty": 3}]},
  {"type": "arrival", "id": "A2", "po": "PO1", "items": [{"product": "P1", "qty": 9}]}
]
JSON
OUT=$($APP -d "$D" import --file "$F" 2>&1); RC=$?
{ [ $RC -eq 1 ] && printf '%s' "$OUT" | grep -qF "第 2 项" && printf '%s' "$OUT" | grep -qF "超收"; } \
  && ok "批量：后项超收整批拒绝并指出位置与原因" \
  || bad "批量：后项超收整批拒绝并指出位置与原因（退出码 ${RC}，${OUT}）"
expect_out "批量：失败不占编号（A1 可重试）" "待到货 2" $APP -d "$D" arrival A1 --po PO1 --item P1:3
expect_out "批量：进度只含重试后的一笔" "	3	" $APP -d "$D" po show PO1
# 修正后的整批可成功（A2 到货 1 后待到货 1，X1 再取消 1，两项均合法）
cat > "$F" <<'JSON'
[
  {"type": "arrival", "id": "A2", "po": "PO1", "items": [{"product": "P1", "qty": 1}]},
  {"type": "cancel",  "id": "X1", "po": "PO1", "items": [{"product": "P1", "qty": 1}]}
]
JSON
OUT=$($APP -d "$D" import --file "$F" 2>&1)
printf '%s' "$OUT" | grep -qF "首次生效 2 项" \
  && ok "批量：修正后整批成功" || bad "批量：修正后整批成功（${OUT}）"
# 全部重复不改写文件
BEFORE=$(md5 -q "$D/stockroom.json" 2>/dev/null || md5sum "$D/stockroom.json" | cut -d' ' -f1)
$APP -d "$D" import --file "$F" >/dev/null || bad "批量：全部重复仍应成功"
AFTER=$(md5 -q "$D/stockroom.json" 2>/dev/null || md5sum "$D/stockroom.json" | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] && ok "批量：全部重复不改写文件" || bad "批量：全部重复不改写文件"
rm -rf "$D" "$F"

# ============ 4. 重载 ============
D=$(mktemp -d)
$APP -d "$D" product add P1 螺丝 >/dev/null
$APP -d "$D" po register PO1 --supplier S1 --wh W1 --item P1:$MAX >/dev/null
$APP -d "$D" arrival A1 --po PO1 --item P1:$MAX >/dev/null
$APP -d "$D" return T1 --arrival A1 --item P1:1 >/dev/null
# 新进程重载后限制仍成立：只能再补收 1
expect_out "重载：重启后按精确进度补收 1" "待到货 0" $APP -d "$D" arrival A2 --po PO1 --item P1:1
expect_reject "重载：重启后仍不得超收" "超收" $APP -d "$D" arrival A3 --po PO1 --item P1:1
# 损坏数据拒绝读取且不覆盖
cp "$D/stockroom.json" "$D/backup.json"
echo '{broken' > "$D/stockroom.json"
OUT=$($APP -d "$D" po show PO1 2>&1); RC=$?
{ [ $RC -eq 1 ] && printf '%s' "$OUT" | grep -qF "损坏"; } \
  && ok "重载：损坏数据拒绝读取" || bad "重载：损坏数据拒绝读取（退出码 ${RC}，${OUT}）"
printf '%s' "$(cat "$D/stockroom.json")" | grep -qF '{broken' \
  && ok "重载：损坏文件不被覆盖" || bad "重载：损坏文件不被覆盖"
mv "$D/backup.json" "$D/stockroom.json"
expect_out "重载：合法旧数据直接加载" "收齐" $APP -d "$D" po show PO1
rm -rf "$D"

# ============ 5. 历史重放 ============
D=$(mktemp -d)
$APP -d "$D" product add P1 螺丝 >/dev/null
$APP -d "$D" po register PO1 --supplier S1 --wh W1 --item P1:5 >/dev/null
$APP -d "$D" arrival A1 --po PO1 --item P1:5 >/dev/null
$APP -d "$D" return T1 --arrival A1 --item P1:2 >/dev/null
$APP -d "$D" reverse R1 --orig T1 >/dev/null # 冲销退货，有效到货回满
# 成功旧单同号同内容重放：即使进度/库存已变化，仍返回原结果、不再生效
expect_out "重放：成功到货同号同内容返回原结果" "重复提交" $APP -d "$D" arrival A1 --po PO1 --item P1:5
expect_out "重放：已冲销退货同号同内容仍返回原结果" "重复提交" $APP -d "$D" return T1 --arrival A1 --item P1:2
expect_out "重放：成功冲销同号同原单返回原结果" "重复提交" $APP -d "$D" reverse R1 --orig T1
expect_reject "重放：同号不同内容拒绝" "内容不同" $APP -d "$D" arrival A1 --po PO1 --item P1:4
expect_reject "重放：冲销同号改指其他原单拒绝" "不能改冲" $APP -d "$D" reverse R1 --orig A1
# 重放未重复生效：有效到货仍等于订购量（退货已冲销，有效退货为 0）、库存未被重复扣减
expect_out "重放：进度未被重放改变" "P1	5	5	0	0	收齐" $APP -d "$D" po show PO1
expect_out "重放：库存未被重放改变" "= 5" $APP -d "$D" balance P1 --wh W1
rm -rf "$D"

echo
echo "回归检查完成：通过 $PASS 项，失败 $FAIL 项"
[ $FAIL -eq 0 ]
