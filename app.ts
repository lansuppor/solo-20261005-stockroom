#!/usr/bin/env node
// stockroom —— 本地多仓库存台账（Node.js 24，TypeScript，无外部运行依赖）

import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const APP_NAME = 'stockroom';
const DATA_FILENAME = 'stockroom.json';
const DEFAULT_DATA_DIR = '.stockroom';

class UsageError extends Error {} // 命令行用法错误 -> 退出码 2
class BizError extends Error {} // 业务拒绝 -> 退出码 1
class DataError extends Error {} // 数据读取/保存失败 -> 退出码 1

type DocType = 'in' | 'out' | 'transfer';
type EntryType =
  | DocType
  | 'count'
  | 'arrival'
  | 'return'
  | 'in-rev'
  | 'out-rev'
  | 'transfer-rev'
  | 'count-rev'
  | 'arrival-rev'
  | 'return-rev';

interface LedgerEntry {
  seq: number; // 全局流水序号，即提交顺序
  doc: string; // 单据编号（冲销流水此处为冲销单编号）
  type: EntryType;
  product: string;
  wh: string; // 本流水条目变动余量的仓库（到货为采购单收货仓）
  qty?: number; // 入库/出库/调拨/到货类流水：恒为正数，方向由类型 / 出入仓决定；盘点类流水不用此字段
  before: number;
  after: number;
  from?: string; // 调拨（或冲销调拨）的调出仓
  to?: string; // 调拨（或冲销调拨）的调入仓
  po?: string; // 到货/退货流水：所属采购单编号
  arr?: string; // 退货（及冲销退货）流水：原到货单编号
  orig?: string; // 冲销流水：被冲销的原单编号
  expected?: number; // 盘点（及冲销盘点）流水：预期账面量
  actual?: number; // 盘点（及冲销盘点）流水：实盘量
  diff?: number; // 盘点差额 = 实盘 - 账面（可正、可负、可零）；冲销盘点流水记录原差额
}

interface DocRecord {
  content: Record<string, unknown>; // 规范化业务内容（明细顺序无关）
  resultLines: string[]; // 原提交结果，供幂等重放
}

interface ReversalRecord {
  orig: string; // 被冲销的原单编号
  resultLines: string[]; // 冲销提交结果，供幂等重放
}

interface PurchaseRecord {
  poId: string;
  supplier: string;
  wh: string; // 收货仓
  ordered: Record<string, number>; // 商品 -> 订购量（合并后，正安全整数）
  fromTransfer?: string; // 目的采购单：创建它的采购转单编号（普通登记无此字段）
  resultLines: string[]; // 登记结果，供幂等重放
}

interface PoTransferRecord {
  tId: string; // 转单编号（与库存/到货/取消/退货/冲销单共用编号空间）
  origPo: string; // 原采购编号
  destPo: string; // 新目的采购编号（独立采购编号空间，由本转单创建）
  supplier: string; // 目的单供应商
  wh: string; // 目的单收货仓
  qty: Record<string, number>; // 本次转出：商品 -> 数量（合并后，正安全整数）
  resultLines: string[]; // 转单提交结果，供幂等重放
}

interface ArrivalRecord {
  poId: string; // 所属采购单
  wh: string; // 采购单收货仓（冗余自采购单，便于校验与展示）
  qty: Record<string, number>; // 本次到货：商品 -> 数量（合并后，正安全整数）
  resultLines: string[]; // 到货提交结果，供幂等重放
}

interface CancelRecord {
  poId: string; // 所属采购单
  qty: Record<string, number>; // 本次取消：商品 -> 数量（合并后，正安全整数）
  resultLines: string[]; // 取消提交结果，供幂等重放
}

interface ReturnRecord {
  arrId: string; // 原到货单编号
  poId: string; // 所属采购单（冗余自原到货单，便于校验与展示）
  wh: string; // 原到货单收货仓（退货从该仓当前余量扣减）
  qty: Record<string, number>; // 本次退货：商品 -> 数量（合并后，正安全整数）
  resultLines: string[]; // 退货提交结果，供幂等重放
}

interface ReplenishRule {
  min: number; // 下限：预计量不高于此值才触发补货（非负安全整数）
  target: number; // 目标：补货缺口 = 目标 - 预计量（非负安全整数，恒大于下限）
}

interface PlanTransfer {
  docId: string; // 调拨子单编号（与库存单据共用编号空间，执行时才占用）
  product: string;
  from: string; // 调出仓
  to: string; // 调入仓（缺货仓）
  qty: number; // 冻结的调拨数量（正安全整数）
}

interface PlanPurchase {
  poId: string; // 采购子单编号（独立采购编号空间，执行时才占用）
  supplier: string;
  wh: string; // 收货仓（缺货仓）
  product: string;
  qty: number; // 冻结的采购数量（正安全整数）
}

interface PlanSnapshot {
  // 涉及商品（出现在任一调拨/采购子单中的商品）在保存时的全部补货规则
  rules: Record<string, Record<string, ReplenishRule>>;
  // 这些商品各配置仓在保存时的实存
  stock: Record<string, Record<string, number>>;
  // 这些商品各配置仓在保存时的待到货合计（精确整数十进制字符串，可超安全整数范围）
  pending: Record<string, Record<string, string>>;
}

interface PlanRecord {
  planId: string;
  transfers: PlanTransfer[]; // 冻结的调拨子单（按建议顺序：商品、缺货仓、来源仓升序）
  purchases: PlanPurchase[]; // 冻结的采购子单（按商品、收货仓升序；零采购不建单）
  snapshot: PlanSnapshot; // 保存时冻结的核对快照
  status: 'pending' | 'executed';
  execResultLines?: string[]; // 已执行方案的落单结果原文，供重放（不再核对、不再生效）
  withdrawnBy?: string; // 已撤回方案的撤回请求编号（每案最多成功撤回一次）
}

interface PlanWithdrawalRecord {
  reqId: string; // 撤回请求编号（与库存/到货/取消/退货/转单/冲销单共用编号空间；本身不可冲销）
  planId: string; // 被撤回的方案编号
  transferRevs: Record<string, string>; // 调拨子单编号 -> 为其指定的冲销单号（逐一对应）
  purchaseCancels: Record<string, string>; // 采购子单编号 -> 为其指定的取消单号（逐一对应）
  resultLines: string[]; // 撤回提交结果，供幂等重放
}

interface Store {
  version: 1;
  products: Record<string, string>; // 编号 -> 名称（编号区分大小写；null 原型，防特殊键串改）
  stock: Record<string, Record<string, number>>; // 商品 -> 仓库 -> 余量
  entries: LedgerEntry[];
  docs: Record<string, DocRecord>; // 入库/出库/调拨/盘点单去重与结果
  reversals: Record<string, ReversalRecord>; // 冲销单去重与结果（可冲销到货单、取消单、退货单）
  purchases: Record<string, PurchaseRecord>; // 采购单登记（独立编号空间，不改库存）
  arrivals: Record<string, ArrivalRecord>; // 到货单去重与结果（与库存单共用编号空间）
  cancels: Record<string, CancelRecord>; // 取消单去重与结果（与库存单共用编号空间，不改库存与流水）
  returns: Record<string, ReturnRecord>; // 退货单去重与结果（与库存单共用编号空间）
  poTransfers: Record<string, PoTransferRecord>; // 采购待收转单去重与结果（与库存单共用编号空间，不改库存与流水）
  rules: Record<string, Record<string, ReplenishRule>>; // 补货规则：商品 -> 仓库 -> 下限/目标（每组合唯一）
  plans: Record<string, PlanRecord>; // 补货方案（独立编号空间；保存不改库存/采购/流水）
  planWithdrawals: Record<string, PlanWithdrawalRecord>; // 方案撤回请求（请求编号与库存单据共用编号空间）
}

const REV_ENTRY_TYPES = new Set<EntryType>([
  'in-rev', 'out-rev', 'transfer-rev', 'count-rev', 'arrival-rev', 'return-rev',
]);

function nullProto<T extends object>(): T {
  return Object.create(null) as T;
}

function emptyStore(): Store {
  return {
    version: 1,
    products: nullProto(),
    stock: nullProto(),
    entries: [],
    docs: nullProto(),
    reversals: nullProto(),
    purchases: nullProto(),
    arrivals: nullProto(),
    cancels: nullProto(),
    returns: nullProto(),
    poTransfers: nullProto(),
    rules: nullProto(),
    plans: nullProto(),
    planWithdrawals: nullProto(),
  };
}

// ---------- 工具 ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPosSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function trimOrThrow(label: string, raw: string): string {
  const s = raw.trim();
  if (s === '') throw new BizError(`${label}去除首尾空白后不能为空`);
  return s;
}

/** 规范化序列化：对象键排序，保证业务内容比较与明细顺序无关。 */
function stableStringify(v: unknown): string {
  if (isPlainObject(v)) {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
        .join(',') +
      '}'
    );
  }
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return JSON.stringify(v);
}

// ---------- 数据持久化 ----------

function dataPath(dataDir: string): string {
  return join(dataDir, DATA_FILENAME);
}

function loadStore(dataDir: string): Store {
  let raw: string;
  try {
    raw = readFileSync(dataPath(dataDir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore(); // 尚不存在 -> 空库
    throw new DataError(`无法读取数据文件 ${dataPath(dataDir)}：${(e as Error).message}`);
  }

  let data: unknown;
  try {
    // JSON.parse 将 "__proto__" 保留为普通自有属性（不设置原型）；随后 validateStore
    // 会把全部容器重新装入 null 原型对象，constructor 等特殊键同样安全。
    data = JSON.parse(raw);
  } catch {
    throw new DataError(`数据文件已损坏，无法解析 JSON：${dataPath(dataDir)}（不会作为空库覆盖）`);
  }
  return validateStore(data);
}

function validateStore(data: unknown): Store {
  const bad = (msg: string): DataError =>
    new DataError(`数据文件已损坏或格式不正确（${msg}），拒绝启动以免覆盖原数据`);

  if (!isPlainObject(data)) throw bad('根节点不是对象');
  if (data.version !== 1) throw bad(`不支持的数据版本：${String(data.version)}`);

  // 重新装入 null 原型容器：即使磁盘数据来自普通对象，constructor/__proto__ 等键也安全
  const store = emptyStore();

  if (!isPlainObject(data.products)) throw bad('products 不是对象');
  for (const [id, name] of Object.entries(data.products)) {
    if (typeof id !== 'string' || id.trim() === '' || typeof name !== 'string')
      throw bad('products 中存在非法编号或名称');
    store.products[id] = name;
  }

  if (!isPlainObject(data.stock)) throw bad('stock 不是对象');
  for (const [pid, whs] of Object.entries(data.stock)) {
    if (!isPlainObject(whs)) throw bad(`商品 ${pid} 的库存不是对象`);
    const whMap = nullProto<Record<string, number>>();
    for (const [wh, qty] of Object.entries(whs)) {
      if (typeof wh !== 'string' || wh.trim() === '' || !isNonNegSafeInt(qty))
        throw bad(`商品 ${pid} 仓库 ${String(wh)} 的余量非法`);
      whMap[wh] = qty;
    }
    store.stock[pid] = whMap;
  }

  if (!Array.isArray(data.entries)) throw bad('entries 不是数组');
  let lastSeq = 0;
  for (const e of data.entries as unknown[]) {
    if (!isPlainObject(e)) throw bad('存在非法流水条目');
    if (!isPosSafeInt(e.seq) || e.seq !== ++lastSeq) throw bad('流水序号不连续');
    if (typeof e.doc !== 'string' || e.doc.trim() === '') throw bad('流水缺少单据编号');
    const isRev = REV_ENTRY_TYPES.has(e.type as EntryType);
    const isOrig =
      e.type === 'in' || e.type === 'out' || e.type === 'transfer' || e.type === 'count' ||
      e.type === 'arrival' || e.type === 'return';
    if (!isRev && !isOrig) throw bad('流水类型非法');
    if (typeof e.product !== 'string' || e.product.trim() === '') throw bad('流水缺少商品编号');
    if (typeof e.wh !== 'string' || e.wh.trim() === '') throw bad('流水缺少仓库标识');
    if (!isNonNegSafeInt(e.before) || !isNonNegSafeInt(e.after)) throw bad('流水余量非法');
    if (e.type === 'count' || e.type === 'count-rev') {
      if (!isNonNegSafeInt(e.expected) || !isNonNegSafeInt(e.actual))
        throw bad('盘点流水账面/实盘量非法');
      if (typeof e.diff !== 'number' || !Number.isSafeInteger(e.diff)) throw bad('盘点流水差额非法');
      if (e.diff !== e.actual - e.expected) throw bad('盘点流水差额与账面、实盘量不一致');
      const applied = e.type === 'count' ? e.diff : -e.diff; // 冲销盘点应用反向差额
      if (e.after - e.before !== applied) throw bad('盘点流水差额与前后余量不一致');
      if (e.qty !== undefined || e.from !== undefined || e.to !== undefined || e.po !== undefined ||
          e.arr !== undefined)
        throw bad('盘点流水不应携带数量、调拨、采购或退货字段');
    } else {
      if (!isPosSafeInt(e.qty)) throw bad('流水数量非法');
      if (e.expected !== undefined || e.actual !== undefined || e.diff !== undefined)
        throw bad('非盘点流水不应携带盘点字段');
      const delta = e.after - e.before;
      if (e.type === 'transfer' || e.type === 'transfer-rev') {
        if (typeof e.from !== 'string' || e.from.trim() === '' || typeof e.to !== 'string' || e.to.trim() === '')
          throw bad('调拨流水缺少调出/调入仓');
        if (e.po !== undefined || e.arr !== undefined) throw bad('调拨流水不应携带采购或退货字段');
        // 调拨：调入仓增加；冲销调拨：原调入仓扣回、原调出仓补回
        const expect = (e.wh === e.to) === (e.type === 'transfer') ? e.qty : -e.qty;
        if (delta !== expect) throw bad('流水差额与前后余量不一致');
      } else {
        if (e.from !== undefined || e.to !== undefined) throw bad('非调拨流水不应携带调拨字段');
        // 到货入收货仓、冲销退货补回为增；退货从收货仓扣减、冲销到货扣回为减
        const increases =
          e.type === 'in' || e.type === 'out-rev' || e.type === 'arrival' || e.type === 'return-rev';
        if (delta !== (increases ? e.qty : -e.qty)) throw bad('流水差额与前后余量不一致');
        if (e.type === 'arrival' || e.type === 'arrival-rev') {
          if (typeof e.po !== 'string' || e.po.trim() === '') throw bad('到货流水缺少采购单编号');
          if (e.arr !== undefined) throw bad('到货流水不应携带原到货单字段');
        } else if (e.type === 'return' || e.type === 'return-rev') {
          if (typeof e.po !== 'string' || e.po.trim() === '') throw bad('退货流水缺少采购单编号');
          if (typeof e.arr !== 'string' || e.arr.trim() === '') throw bad('退货流水缺少原到货单编号');
        } else if (e.po !== undefined || e.arr !== undefined) {
          throw bad('非到货/退货流水不应携带采购或退货字段');
        }
      }
    }
    if (isRev) {
      if (typeof e.orig !== 'string' || e.orig.trim() === '') throw bad('冲销流水缺少原单编号');
    } else if (e.orig !== undefined) {
      throw bad('原始单据流水不应携带冲销标记');
    }
    store.entries.push(e as unknown as LedgerEntry);
  }

  if (!isPlainObject(data.docs)) throw bad('docs 不是对象');
  for (const [docId, rec] of Object.entries(data.docs)) {
    if (typeof docId !== 'string' || docId.trim() === '') throw bad('存在非法单据编号');
    if (!isPlainObject(rec) || !isPlainObject(rec.content) || !Array.isArray(rec.resultLines))
      throw bad(`单据 ${docId} 的去重记录非法`);
    if (!rec.resultLines.every((l) => typeof l === 'string')) throw bad(`单据 ${docId} 的结果记录非法`);
    const c = rec.content;
    if (c.type !== 'in' && c.type !== 'out' && c.type !== 'transfer' && c.type !== 'count')
      throw bad(`单据 ${docId} 的业务类型非法`);
    if (!isPlainObject(c.items)) throw bad(`单据 ${docId} 的明细非法`);
    for (const [pid, item] of Object.entries(c.items)) {
      if (pid.trim() === '') throw bad(`单据 ${docId} 存在非法明细`);
      if (c.type === 'count') {
        if (!isPlainObject(item) || !isNonNegSafeInt(item.expected) || !isNonNegSafeInt(item.actual))
          throw bad(`单据 ${docId} 存在非法盘点明细`);
      } else if (!isPosSafeInt(item)) {
        throw bad(`单据 ${docId} 存在非法明细`);
      }
    }
    if (c.type === 'transfer') {
      if (typeof c.from !== 'string' || c.from.trim() === '' || typeof c.to !== 'string' || c.to.trim() === '')
        throw bad(`单据 ${docId} 的调拨仓非法`);
    } else if (typeof c.wh !== 'string' || c.wh.trim() === '') {
      throw bad(`单据 ${docId} 的仓库非法`);
    }
    store.docs[docId] = rec as unknown as DocRecord;
  }

  // purchases 为新增字段：合法旧数据没有该字段，按空集合处理。
  // 采购单编号独立于库存单据编号空间，允许与入库/到货/冲销单同名。
  if (data.purchases !== undefined) {
    if (!isPlainObject(data.purchases)) throw bad('purchases 不是对象');
    for (const [poId, rec] of Object.entries(data.purchases)) {
      if (typeof poId !== 'string' || poId.trim() === '') throw bad('存在非法采购单编号');
      if (
        !isPlainObject(rec) ||
        typeof rec.supplier !== 'string' || rec.supplier.trim() === '' ||
        typeof rec.wh !== 'string' || rec.wh.trim() === '' ||
        !isPlainObject(rec.ordered) ||
        !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string')
      )
        throw bad(`采购单 ${poId} 的记录非法`);
      if (rec.poId !== undefined && rec.poId !== poId) throw bad(`采购单 ${poId} 的内嵌编号不一致`);
      let fromTransfer: string | undefined;
      if (rec.fromTransfer !== undefined) {
        if (typeof rec.fromTransfer !== 'string' || rec.fromTransfer.trim() === '')
          throw bad(`采购单 ${poId} 的转单来源编号非法`);
        fromTransfer = rec.fromTransfer;
      }
      const ordered = nullProto<Record<string, number>>();
      for (const [pid, qty] of Object.entries(rec.ordered)) {
        if (pid.trim() === '' || !isPosSafeInt(qty)) throw bad(`采购单 ${poId} 存在非法订购明细`);
        ordered[pid] = qty;
      }
      if (Object.keys(ordered).length === 0) throw bad(`采购单 ${poId} 至少需要一种商品`);
      store.purchases[poId] = {
        poId, supplier: rec.supplier, wh: rec.wh, ordered,
        ...(fromTransfer !== undefined ? { fromTransfer } : {}),
        resultLines: rec.resultLines,
      };
    }
  }

  // poTransfers 为新增字段：合法旧数据没有该字段，按空集合处理。
  // 采购待收转单与入库/出库/调拨/盘点/到货/取消/退货/冲销单共用全局唯一编号空间；
  // 转单把原采购单的部分待收承诺转出：原单形成有效取消，同时新建一张目的采购单
  // （目的采购编号仍属独立采购编号空间）。转单不改库存、不产生库存流水。
  if (data.poTransfers !== undefined) {
    if (!isPlainObject(data.poTransfers)) throw bad('poTransfers 不是对象');
    const destSeen = nullProto<Record<string, string>>();
    for (const [tId, rec] of Object.entries(data.poTransfers)) {
      if (typeof tId !== 'string' || tId.trim() === '') throw bad('存在非法采购转单编号');
      if (store.docs[tId] !== undefined) throw bad(`采购转单编号 ${tId} 与原始库存单据编号冲突`);
      if (
        !isPlainObject(rec) ||
        typeof rec.tId !== 'string' || rec.tId.trim() === '' ||
        typeof rec.origPo !== 'string' || rec.origPo.trim() === '' ||
        typeof rec.destPo !== 'string' || rec.destPo.trim() === '' ||
        typeof rec.supplier !== 'string' || rec.supplier.trim() === '' ||
        typeof rec.wh !== 'string' || rec.wh.trim() === '' ||
        !isPlainObject(rec.qty) ||
        !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string')
      )
        throw bad(`采购转单 ${tId} 的记录非法`);
      if (rec.tId !== tId) throw bad(`采购转单 ${tId} 的内嵌编号不一致`);
      const qty = nullProto<Record<string, number>>();
      for (const [pid, q] of Object.entries(rec.qty)) {
        if (pid.trim() === '' || !isPosSafeInt(q)) throw bad(`采购转单 ${tId} 存在非法转出明细`);
        qty[pid] = q;
      }
      if (Object.keys(qty).length === 0) throw bad(`采购转单 ${tId} 至少需要一种商品`);
      if (rec.origPo === rec.destPo) throw bad(`采购转单 ${tId} 的原采购与目的采购不能相同`);
      const origPo = store.purchases[rec.origPo];
      if (origPo === undefined) throw bad(`采购转单 ${tId} 指向的原采购单 ${rec.origPo} 不存在`);
      const destPo = store.purchases[rec.destPo];
      if (destPo === undefined) throw bad(`采购转单 ${tId} 的目的采购单 ${rec.destPo} 不存在`);
      if (destPo.fromTransfer !== tId)
        throw bad(`采购转单 ${tId} 的目的采购单 ${rec.destPo} 未由该转单创建（关联断裂）`);
      if (destPo.supplier !== rec.supplier || destPo.wh !== rec.wh)
        throw bad(`采购转单 ${tId} 与目的采购单 ${rec.destPo} 的供应商或收货仓不一致`);
      if (stableStringify(destPo.ordered) !== stableStringify(qty))
        throw bad(`采购转单 ${tId} 与目的采购单 ${rec.destPo} 的订购明细不一致`);
      if (destSeen[rec.destPo] !== undefined)
        throw bad(`目的采购单 ${rec.destPo} 由多张转单关联（${destSeen[rec.destPo]}、${tId}）`);
      destSeen[rec.destPo] = tId;
      for (const [pid, q] of Object.entries(qty)) {
        if (origPo.ordered[pid] === undefined)
          throw bad(`采购转单 ${tId} 含原采购单 ${rec.origPo} 未订购的商品 ${pid}`);
        if (q > origPo.ordered[pid])
          throw bad(`采购转单 ${tId} 商品 ${pid} 转出量超过原采购订购量`);
      }
      store.poTransfers[tId] = {
        tId, origPo: rec.origPo, destPo: rec.destPo,
        supplier: rec.supplier, wh: rec.wh, qty, resultLines: rec.resultLines,
      };
    }
    // 采购单的转单来源必须能找到对应转单，且该转单确实以本单为目的单
    for (const [poId, po] of Object.entries(store.purchases)) {
      if (po.fromTransfer === undefined) continue;
      const t = store.poTransfers[po.fromTransfer];
      if (t === undefined) throw bad(`采购单 ${poId} 的来源转单 ${po.fromTransfer} 不存在（关联断裂）`);
      if (t.destPo !== poId) throw bad(`采购单 ${poId} 与来源转单 ${po.fromTransfer} 的目的单不一致`);
    }
  } else {
    // 没有转单集合时，任何采购单都不得携带转单来源
    for (const [poId, po] of Object.entries(store.purchases)) {
      if (po.fromTransfer !== undefined)
        throw bad(`采购单 ${poId} 携带转单来源 ${po.fromTransfer}，但转单集合不存在（关联断裂）`);
    }
  }

  // arrivals 为新增字段：合法旧数据没有该字段，按空集合处理。
  // 到货单与入库/出库/调拨/盘点/冲销单共用全局唯一编号空间。
  if (data.arrivals !== undefined) {
    if (!isPlainObject(data.arrivals)) throw bad('arrivals 不是对象');
    for (const [arrId, rec] of Object.entries(data.arrivals)) {
      if (typeof arrId !== 'string' || arrId.trim() === '') throw bad('存在非法到货单编号');
      if (store.docs[arrId] !== undefined) throw bad(`到货单编号 ${arrId} 与原始库存单据编号冲突`);
      if (store.poTransfers[arrId] !== undefined) throw bad(`到货单编号 ${arrId} 与采购转单编号冲突`);
      if (
        !isPlainObject(rec) ||
        typeof rec.poId !== 'string' || rec.poId.trim() === '' ||
        typeof rec.wh !== 'string' || rec.wh.trim() === '' ||
        !isPlainObject(rec.qty) ||
        !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string')
      )
        throw bad(`到货单 ${arrId} 的记录非法`);
      const qty = nullProto<Record<string, number>>();
      for (const [pid, q] of Object.entries(rec.qty)) {
        if (pid.trim() === '' || !isPosSafeInt(q)) throw bad(`到货单 ${arrId} 存在非法到货明细`);
        qty[pid] = q;
      }
      if (Object.keys(qty).length === 0) throw bad(`到货单 ${arrId} 至少需要一种商品`);
      const po = store.purchases[rec.poId];
      if (po === undefined) throw bad(`到货单 ${arrId} 指向的采购单 ${rec.poId} 不存在`);
      if (rec.wh !== po.wh) throw bad(`到货单 ${arrId} 的收货仓与采购单 ${rec.poId} 不一致`);
      for (const [pid, q] of Object.entries(qty)) {
        if (po.ordered[pid] === undefined)
          throw bad(`到货单 ${arrId} 含采购单 ${rec.poId} 未订购的商品 ${pid}`);
        if (q > po.ordered[pid])
          throw bad(`到货单 ${arrId} 商品 ${pid} 到货量超过订购量`);
      }
      store.arrivals[arrId] = { poId: rec.poId, wh: rec.wh, qty, resultLines: rec.resultLines };
    }
  }

  // cancels 为新增字段：合法旧数据没有该字段，按空集合处理。
  // 取消单与入库/出库/调拨/盘点/到货/冲销单共用全局唯一编号空间；
  // 取消只减少待收承诺，不改库存、不产生库存流水。
  if (data.cancels !== undefined) {
    if (!isPlainObject(data.cancels)) throw bad('cancels 不是对象');
    for (const [canId, rec] of Object.entries(data.cancels)) {
      if (typeof canId !== 'string' || canId.trim() === '') throw bad('存在非法取消单编号');
      if (store.docs[canId] !== undefined) throw bad(`取消单编号 ${canId} 与原始库存单据编号冲突`);
      if (store.arrivals[canId] !== undefined) throw bad(`取消单编号 ${canId} 与到货单编号冲突`);
      if (store.poTransfers[canId] !== undefined) throw bad(`取消单编号 ${canId} 与采购转单编号冲突`);
      if (
        !isPlainObject(rec) ||
        typeof rec.poId !== 'string' || rec.poId.trim() === '' ||
        !isPlainObject(rec.qty) ||
        !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string')
      )
        throw bad(`取消单 ${canId} 的记录非法`);
      const qty = nullProto<Record<string, number>>();
      for (const [pid, q] of Object.entries(rec.qty)) {
        if (pid.trim() === '' || !isPosSafeInt(q)) throw bad(`取消单 ${canId} 存在非法取消明细`);
        qty[pid] = q;
      }
      if (Object.keys(qty).length === 0) throw bad(`取消单 ${canId} 至少需要一种商品`);
      const po = store.purchases[rec.poId];
      if (po === undefined) throw bad(`取消单 ${canId} 指向的采购单 ${rec.poId} 不存在`);
      for (const [pid, q] of Object.entries(qty)) {
        if (po.ordered[pid] === undefined)
          throw bad(`取消单 ${canId} 含采购单 ${rec.poId} 未订购的商品 ${pid}`);
        if (q > po.ordered[pid])
          throw bad(`取消单 ${canId} 商品 ${pid} 取消量超过订购量`);
      }
      store.cancels[canId] = { poId: rec.poId, qty, resultLines: rec.resultLines };
    }
  }

  // returns 为新增字段：合法旧数据没有该字段，按无退货处理。
  // 退货单与入库/出库/调拨/盘点/到货/取消/冲销单共用全局唯一编号空间；
  // 退货引用一张原到货单，采购单与收货仓取原到货，只退原到货明细内商品。
  if (data.returns !== undefined) {
    if (!isPlainObject(data.returns)) throw bad('returns 不是对象');
    for (const [retId, rec] of Object.entries(data.returns)) {
      if (typeof retId !== 'string' || retId.trim() === '') throw bad('存在非法退货单编号');
      if (store.docs[retId] !== undefined) throw bad(`退货单编号 ${retId} 与原始库存单据编号冲突`);
      if (store.arrivals[retId] !== undefined) throw bad(`退货单编号 ${retId} 与到货单编号冲突`);
      if (store.cancels[retId] !== undefined) throw bad(`退货单编号 ${retId} 与取消单编号冲突`);
      if (store.poTransfers[retId] !== undefined) throw bad(`退货单编号 ${retId} 与采购转单编号冲突`);
      if (
        !isPlainObject(rec) ||
        typeof rec.arrId !== 'string' || rec.arrId.trim() === '' ||
        typeof rec.poId !== 'string' || rec.poId.trim() === '' ||
        typeof rec.wh !== 'string' || rec.wh.trim() === '' ||
        !isPlainObject(rec.qty) ||
        !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string')
      )
        throw bad(`退货单 ${retId} 的记录非法`);
      const qty = nullProto<Record<string, number>>();
      for (const [pid, q] of Object.entries(rec.qty)) {
        if (pid.trim() === '' || !isPosSafeInt(q)) throw bad(`退货单 ${retId} 存在非法退货明细`);
        qty[pid] = q;
      }
      if (Object.keys(qty).length === 0) throw bad(`退货单 ${retId} 至少需要一种商品`);
      const arr = store.arrivals[rec.arrId];
      if (arr === undefined) throw bad(`退货单 ${retId} 指向的原到货单 ${rec.arrId} 不存在`);
      if (rec.poId !== arr.poId) throw bad(`退货单 ${retId} 的采购单与原到货单 ${rec.arrId} 不一致`);
      if (rec.wh !== arr.wh) throw bad(`退货单 ${retId} 的收货仓与原到货单 ${rec.arrId} 不一致`);
      for (const [pid, q] of Object.entries(qty)) {
        if (arr.qty[pid] === undefined)
          throw bad(`退货单 ${retId} 含原到货单 ${rec.arrId} 没有的商品 ${pid}`);
        if (q > arr.qty[pid]) throw bad(`退货单 ${retId} 商品 ${pid} 退货量超过原到货量`);
      }
      store.returns[retId] = { arrId: rec.arrId, poId: rec.poId, wh: rec.wh, qty, resultLines: rec.resultLines };
    }
  }

  // reversals 为新增字段：合法旧数据没有该字段，按空集合处理。
  // 原单既可以是入库/出库/调拨/盘点单，也可以是到货单、取消单、退货单；冲销单不可冲销。
  if (data.reversals !== undefined) {
    if (!isPlainObject(data.reversals)) throw bad('reversals 不是对象');
    for (const [revId, rec] of Object.entries(data.reversals)) {
      if (typeof revId !== 'string' || revId.trim() === '') throw bad('存在非法冲销单编号');
      if (!isPlainObject(rec) || typeof rec.orig !== 'string' || rec.orig.trim() === '' ||
          !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string'))
        throw bad(`冲销单 ${revId} 的记录非法`);
      if (store.docs[revId] !== undefined) throw bad(`冲销单编号 ${revId} 与原始库存单据编号冲突`);
      if (store.arrivals[revId] !== undefined) throw bad(`冲销单编号 ${revId} 与到货单编号冲突`);
      if (store.cancels[revId] !== undefined) throw bad(`冲销单编号 ${revId} 与取消单编号冲突`);
      if (store.returns[revId] !== undefined) throw bad(`冲销单编号 ${revId} 与退货单编号冲突`);
      if (store.poTransfers[revId] !== undefined) throw bad(`冲销单编号 ${revId} 与采购转单编号冲突`);
      const origRec = store.docs[rec.orig];
      const origArr = store.arrivals[rec.orig];
      const origCan = store.cancels[rec.orig];
      const origRet = store.returns[rec.orig];
      const origTr = store.poTransfers[rec.orig];
      if (origRec === undefined && origArr === undefined && origCan === undefined &&
          origRet === undefined && origTr === undefined) {
        // 用 data.reversals 判定，避免依赖键的先后顺序（此时 store.reversals 可能尚未装全）
        if (isPlainObject((data.reversals as Record<string, unknown>)[rec.orig]))
          throw bad(`冲销单 ${rec.orig} 不可被再次冲销（冲销单不能冲销冲销单）`);
        if (store.purchases[rec.orig] !== undefined)
          throw bad(`冲销单 ${revId} 指向的 ${rec.orig} 是采购单，采购单不可冲销`);
        // 用 data.planWithdrawals 判定（planWithdrawals 在 plans 之后校验，此处尚未装入 store）
        if (isPlainObject(data.planWithdrawals) &&
            isPlainObject((data.planWithdrawals as Record<string, unknown>)[rec.orig]))
          throw bad(`冲销单 ${revId} 指向的 ${rec.orig} 是方案撤回请求，撤回请求不可冲销`);
        throw bad(`冲销单 ${revId} 指向的原单 ${rec.orig} 不存在`);
      }
      store.reversals[revId] = { orig: rec.orig, resultLines: rec.resultLines };
    }
    // 每张原单最多被成功冲销一次（库存单与到货单统一校验）
    const origSeen = nullProto<Record<string, string>>();
    for (const [revId, rec] of Object.entries(store.reversals)) {
      if (origSeen[rec.orig] !== undefined)
        throw bad(`原单 ${rec.orig} 被多张冲销单关联（${origSeen[rec.orig]}、${revId}）`);
      origSeen[rec.orig] = revId;
    }
    // 冲销单不可冲销：冲销关系不能指向另一张冲销单
    for (const rec of Object.values(store.reversals)) {
      if (store.reversals[rec.orig] !== undefined)
        throw bad(`冲销单 ${rec.orig} 不可被再次冲销`);
    }
    // 冲销流水必须能找到所属冲销单
    for (const e of store.entries) {
      if (REV_ENTRY_TYPES.has(e.type) && store.reversals[e.doc] === undefined)
        throw bad(`流水引用了不存在的冲销单 ${e.doc}`);
    }
  }

  // 到货流水必须能找到所属到货单，且逐项数量/采购单/收货仓与记录一致；
  // 逐商品合计用 BigInt 精确累计，避免多条流水合计超过安全整数范围时舍入误判
  const arrivalEntrySeen = nullProto<Record<string, Record<string, bigint>>>();
  for (const e of store.entries) {
    if (e.type !== 'arrival') continue;
    const arr = store.arrivals[e.doc];
    if (arr === undefined) throw bad(`流水引用了不存在的到货单 ${e.doc}`);
    if (e.po !== arr.poId) throw bad(`到货单 ${e.doc} 流水的采购单编号与记录不一致`);
    if (e.wh !== arr.wh) throw bad(`到货单 ${e.doc} 流水的收货仓与记录不一致`);
    const perProduct = (arrivalEntrySeen[e.doc] ??= nullProto<Record<string, bigint>>());
    perProduct[e.product] = (perProduct[e.product] ?? 0n) + BigInt(e.qty!);
  }
  for (const [arrId, arr] of Object.entries(store.arrivals)) {
    const seen = arrivalEntrySeen[arrId];
    if (seen === undefined) throw bad(`到货单 ${arrId} 缺少到货流水`);
    for (const [pid, q] of Object.entries(arr.qty)) {
      if (seen[pid] !== BigInt(q)) throw bad(`到货单 ${arrId} 商品 ${pid} 的流水数量与记录不一致`);
    }
    for (const pid of Object.keys(seen)) {
      if (arr.qty[pid] === undefined) throw bad(`到货单 ${arrId} 的流水含记录中没有的商品 ${pid}`);
    }
  }

  // 冲销到货流水逐项数量必须与原到货单一致
  for (const e of store.entries) {
    if (e.type !== 'arrival-rev') continue;
    const rev = store.reversals[e.doc];
    if (rev === undefined) throw bad(`冲销到货流水引用了不存在的冲销单 ${e.doc}`);
    const arr = store.arrivals[rev.orig];
    if (arr === undefined) throw bad(`冲销单 ${e.doc} 指向的到货原单 ${rev.orig} 不存在`);
    if (e.po !== arr.poId) throw bad(`冲销单 ${e.doc} 流水的采购单编号与原到货单不一致`);
    if (arr.qty[e.product] !== e.qty)
      throw bad(`冲销单 ${e.doc} 商品 ${e.product} 的冲销量与原到货单不一致`);
  }

  // 退货流水必须能找到所属退货单，且逐项数量/原到货单/采购单/收货仓与记录一致（合计同样精确累计）
  const returnEntrySeen = nullProto<Record<string, Record<string, bigint>>>();
  for (const e of store.entries) {
    if (e.type !== 'return') continue;
    const ret = store.returns[e.doc];
    if (ret === undefined) throw bad(`流水引用了不存在的退货单 ${e.doc}`);
    if (e.arr !== ret.arrId) throw bad(`退货单 ${e.doc} 流水的原到货单编号与记录不一致`);
    if (e.po !== ret.poId) throw bad(`退货单 ${e.doc} 流水的采购单编号与记录不一致`);
    if (e.wh !== ret.wh) throw bad(`退货单 ${e.doc} 流水的收货仓与记录不一致`);
    const perProduct = (returnEntrySeen[e.doc] ??= nullProto<Record<string, bigint>>());
    perProduct[e.product] = (perProduct[e.product] ?? 0n) + BigInt(e.qty!);
  }
  for (const [retId, ret] of Object.entries(store.returns)) {
    const seen = returnEntrySeen[retId];
    if (seen === undefined) throw bad(`退货单 ${retId} 缺少退货流水`);
    for (const [pid, q] of Object.entries(ret.qty)) {
      if (seen[pid] !== BigInt(q)) throw bad(`退货单 ${retId} 商品 ${pid} 的流水数量与记录不一致`);
    }
    for (const pid of Object.keys(seen)) {
      if (ret.qty[pid] === undefined) throw bad(`退货单 ${retId} 的流水含记录中没有的商品 ${pid}`);
    }
  }

  // 冲销退货流水逐项数量必须与原退货单一致
  for (const e of store.entries) {
    if (e.type !== 'return-rev') continue;
    const rev = store.reversals[e.doc];
    if (rev === undefined) throw bad(`冲销退货流水引用了不存在的冲销单 ${e.doc}`);
    const ret = store.returns[rev.orig];
    if (ret === undefined) throw bad(`冲销单 ${e.doc} 指向的退货原单 ${rev.orig} 不存在`);
    if (e.arr !== ret.arrId) throw bad(`冲销单 ${e.doc} 流水的原到货单编号与原退货单不一致`);
    if (e.po !== ret.poId) throw bad(`冲销单 ${e.doc} 流水的采购单编号与原退货单不一致`);
    if (ret.qty[e.product] !== e.qty)
      throw bad(`冲销单 ${e.doc} 商品 ${e.product} 的冲销量与原退货单不一致`);
  }

  // 退货不变量：同一原到货单的未冲销累计退货不得超过原到货量；
  // 有未冲销退货的到货单禁止冲销（已冲销到货的全部退货必须已冲销）
  for (const [retId, ret] of Object.entries(store.returns)) {
    const retReversed = Object.values(store.reversals).some((r) => r.orig === retId);
    if (retReversed) continue;
    if (Object.values(store.reversals).some((r) => r.orig === ret.arrId))
      throw bad(`到货单 ${ret.arrId} 已整单冲销，但其退货单 ${retId} 未冲销（有未冲销退货的到货单禁止冲销）`);
    const arr = store.arrivals[ret.arrId];
    const sumByPid = nullProto<Record<string, bigint>>();
    for (const [otherId, other] of Object.entries(store.returns)) {
      if (other.arrId !== ret.arrId) continue;
      if (Object.values(store.reversals).some((r) => r.orig === otherId)) continue;
      for (const [pid, q] of Object.entries(other.qty)) sumByPid[pid] = (sumByPid[pid] ?? 0n) + BigInt(q);
    }
    for (const [pid, sum] of Object.entries(sumByPid)) {
      if (sum > BigInt(arr.qty[pid]))
        throw bad(`到货单 ${ret.arrId} 商品 ${pid} 未冲销累计退货 ${sum} 超过原到货量 ${arr.qty[pid]}`);
    }
  }

  // 冲销流水类型必须与原单业务类型一致（入库→in-rev、到货→arrival-rev、退货→return-rev 等）；
  // 取消单冲销与采购转单冲销不产生库存流水（取消、转单本身不改库存），故不允许携带流水。
  const revIdsWithEntries = nullProto<Record<string, boolean>>();
  for (const [revId, rev] of Object.entries(store.reversals)) {
    const origDoc = store.docs[rev.orig];
    // 原单为取消单或采购转单时（前面已确认必为库存单/到货单/取消单/退货单/采购转单之一）不应存在任何冲销流水
    let expected: EntryType | undefined;
    if (origDoc !== undefined) expected = `${origDoc.content.type}-rev` as EntryType;
    else if (store.arrivals[rev.orig] !== undefined) expected = 'arrival-rev';
    else if (store.returns[rev.orig] !== undefined) expected = 'return-rev';
    for (const e of store.entries) {
      if (e.doc !== revId) continue;
      if (expected === undefined)
        throw bad(
          store.poTransfers[rev.orig] !== undefined
            ? `冲销单 ${revId} 冲销的是采购转单 ${rev.orig}，不应携带库存流水`
            : `冲销单 ${revId} 冲销的是取消单 ${rev.orig}，不应携带库存流水`,
        );
      revIdsWithEntries[revId] = true;
      if (e.type !== expected)
        throw bad(`冲销单 ${revId} 的流水类型与原单 ${rev.orig} 的业务类型不一致`);
    }
    if (expected !== undefined) revIdsWithEntries[revId] ??= false;
  }
  for (const revId of Object.keys(store.reversals)) {
    if (revIdsWithEntries[revId] === false) throw bad(`冲销单 ${revId} 缺少冲销流水`);
  }

  // 采购进度不变量：
  // 有效到货 = 未冲销到货 - 未冲销退货（采购转单不产生到货，目的单初始全量待收）；
  // 有效取消 = 未冲销取消单 + 本单作为原单由未冲销转单转出的量
  //           + 本单作为目的单且来源转单已冲销时的全部订购量。
  // 任一商品“有效到货 + 有效取消”不得超过订购量
  // （待到货量 = 订购量 - 有效到货量 - 有效取消量，不得为负）。
  // 注意：退货释放待到货后允许再次到货，故未冲销到货总量本身可以超过订购量，
  // 甚至可以超过安全整数范围（反复退货、补收）——必须先抵减未冲销退货再校验，
  // 且全程用 BigInt 精确累计，不得因中间累计舍入而改变净量或误拒合法数据。
  const revOfOrig = nullProto<Record<string, string>>(); // 原单 -> 冲销单（每张原单至多一张）
  for (const [revId, rec] of Object.entries(store.reversals)) revOfOrig[rec.orig] = revId;
  for (const [poId, po] of Object.entries(store.purchases)) {
    const arrived = nullProto<Record<string, bigint>>();
    for (const [arrId, arr] of Object.entries(store.arrivals)) {
      if (arr.poId !== poId || revOfOrig[arrId] !== undefined) continue;
      for (const [pid, q] of Object.entries(arr.qty)) {
        arrived[pid] = (arrived[pid] ?? 0n) + BigInt(q);
      }
    }
    // 未冲销退货抵减有效到货（前面已保证其原到货单未冲销且不超退）
    for (const [retId, ret] of Object.entries(store.returns)) {
      if (ret.poId !== poId || revOfOrig[retId] !== undefined) continue;
      for (const [pid, q] of Object.entries(ret.qty)) {
        arrived[pid] = (arrived[pid] ?? 0n) - BigInt(q);
        if (arrived[pid] < 0n)
          throw bad(`采购单 ${poId} 商品 ${pid} 未冲销累计退货超过有效到货量`);
      }
    }
    for (const [pid, q] of Object.entries(arrived)) {
      if (q > BigInt(po.ordered[pid] ?? 0))
        throw bad(`采购单 ${poId} 商品 ${pid} 有效到货（未冲销到货减未冲销退货）超过订购量`);
    }
    const cancelled = nullProto<Record<string, bigint>>();
    for (const [canId, can] of Object.entries(store.cancels)) {
      if (can.poId !== poId || revOfOrig[canId] !== undefined) continue; // 已整单冲销的取消不再计入有效取消
      for (const [pid, q] of Object.entries(can.qty)) {
        cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
        if ((arrived[pid] ?? 0n) + cancelled[pid] > BigInt(po.ordered[pid]))
          throw bad(`采购单 ${poId} 商品 ${pid} 有效到货与有效取消合计超过订购量（待到货量为负）`);
      }
    }
    // 转出：本单作为原单由未冲销转单转出的量计入有效取消（转单冲销后移除）
    for (const t of Object.values(store.poTransfers)) {
      if (t.origPo !== poId || revOfOrig[t.tId] !== undefined) continue;
      for (const [pid, q] of Object.entries(t.qty)) {
        cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
        if ((arrived[pid] ?? 0n) + cancelled[pid] > BigInt(po.ordered[pid]))
          throw bad(`采购单 ${poId} 商品 ${pid} 有效到货与有效取消（含转出）合计超过订购量（待到货量为负）`);
      }
    }
    // 目的单的来源转单已冲销：目的单全部订购量计为取消（待收归零、整单关闭）
    if (po.fromTransfer !== undefined && revOfOrig[po.fromTransfer] !== undefined) {
      for (const [pid, q] of Object.entries(po.ordered)) {
        cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
        if ((arrived[pid] ?? 0n) + cancelled[pid] > BigInt(q))
          throw bad(`采购单 ${poId} 商品 ${pid} 在来源转单冲销后有效到货与有效取消合计超过订购量（待到货量为负）`);
      }
    }
  }

  // rules 为新增字段：合法旧数据没有该字段，按无规则处理。
  // 规则按（商品, 仓库）唯一存放；商品必须已登记，仓库无需登记；
  // 下限与目标均为非负安全整数且下限小于目标，非法规则视为损坏数据，拒绝读取与覆盖。
  if (data.rules !== undefined) {
    if (!isPlainObject(data.rules)) throw bad('rules 不是对象');
    for (const [pid, whs] of Object.entries(data.rules)) {
      if (typeof pid !== 'string' || pid.trim() === '') throw bad('rules 中存在非法商品编号');
      if (store.products[pid] === undefined) throw bad(`补货规则指向未登记商品 ${pid}`);
      if (!isPlainObject(whs)) throw bad(`商品 ${pid} 的补货规则不是对象`);
      const whMap = nullProto<Record<string, ReplenishRule>>();
      for (const [wh, rule] of Object.entries(whs)) {
        if (typeof wh !== 'string' || wh.trim() === '')
          throw bad(`商品 ${pid} 的补货规则存在非法仓库标识`);
        if (
          !isPlainObject(rule) ||
          !isNonNegSafeInt(rule.min) ||
          !isNonNegSafeInt(rule.target) ||
          rule.min >= rule.target
        )
          throw bad(`商品 ${pid} 仓库 ${wh} 的补货规则非法（下限与目标须为非负安全整数且下限小于目标）`);
        whMap[wh] = { min: rule.min, target: rule.target };
      }
      if (Object.keys(whMap).length === 0) throw bad(`商品 ${pid} 的补货规则为空`);
      store.rules[pid] = whMap;
    }
  }

  // plans 为新增字段：合法旧数据没有该字段，按无方案处理。
  // 方案编号独立空间；损坏方案（结构非法、快照非法）或已执行方案的子单关联断裂
  // （子单不存在或内容与冻结不符）一律视为损坏数据，拒绝读取与覆盖。
  if (data.plans !== undefined) {
    if (!isPlainObject(data.plans)) throw bad('plans 不是对象');
    for (const [planId, rec] of Object.entries(data.plans)) {
      if (typeof planId !== 'string' || planId.trim() === '') throw bad('存在非法方案编号');
      if (!isPlainObject(rec)) throw bad(`方案 ${planId} 的记录非法`);
      if (rec.planId !== undefined && rec.planId !== planId) throw bad(`方案 ${planId} 的内嵌编号不一致`);
      if (rec.status !== 'pending' && rec.status !== 'executed') throw bad(`方案 ${planId} 的状态非法`);
      if (!Array.isArray(rec.transfers) || !Array.isArray(rec.purchases))
        throw bad(`方案 ${planId} 的子单记录非法`);
      if (rec.transfers.length + rec.purchases.length === 0)
        throw bad(`方案 ${planId} 不含任何子单`);

      const transfers: PlanTransfer[] = [];
      const seenDoc = new Set<string>();
      for (const t of rec.transfers as unknown[]) {
        if (
          !isPlainObject(t) ||
          typeof t.docId !== 'string' || t.docId.trim() === '' ||
          typeof t.product !== 'string' || t.product.trim() === '' ||
          typeof t.from !== 'string' || t.from.trim() === '' ||
          typeof t.to !== 'string' || t.to.trim() === '' ||
          !isPosSafeInt(t.qty)
        )
          throw bad(`方案 ${planId} 存在非法调拨子单`);
        if (t.from === t.to) throw bad(`方案 ${planId} 的调拨子单 ${t.docId} 调出仓与调入仓相同`);
        if (seenDoc.has(t.docId)) throw bad(`方案 ${planId} 的调拨子单编号 ${t.docId} 重复`);
        seenDoc.add(t.docId);
        transfers.push({ docId: t.docId, product: t.product, from: t.from, to: t.to, qty: t.qty });
      }

      const purchases: PlanPurchase[] = [];
      const seenPo = new Set<string>();
      for (const p of rec.purchases as unknown[]) {
        if (
          !isPlainObject(p) ||
          typeof p.poId !== 'string' || p.poId.trim() === '' ||
          typeof p.supplier !== 'string' || p.supplier.trim() === '' ||
          typeof p.wh !== 'string' || p.wh.trim() === '' ||
          typeof p.product !== 'string' || p.product.trim() === '' ||
          !isPosSafeInt(p.qty)
        )
          throw bad(`方案 ${planId} 存在非法采购子单`);
        if (seenPo.has(p.poId)) throw bad(`方案 ${planId} 的采购子单编号 ${p.poId} 重复`);
        seenPo.add(p.poId);
        purchases.push({ poId: p.poId, supplier: p.supplier, wh: p.wh, product: p.product, qty: p.qty });
      }

      // 快照：涉及商品的全部补货规则、各配置仓实存与待到货合计（十进制字符串）
      if (!isPlainObject(rec.snapshot)) throw bad(`方案 ${planId} 缺少快照`);
      const snap = rec.snapshot;
      if (!isPlainObject(snap.rules) || !isPlainObject(snap.stock) || !isPlainObject(snap.pending))
        throw bad(`方案 ${planId} 的快照非法`);
      const snapRules = nullProto<Record<string, Record<string, ReplenishRule>>>();
      const snapStock = nullProto<Record<string, Record<string, number>>>();
      const snapPending = nullProto<Record<string, Record<string, string>>>();
      for (const [pid, whs] of Object.entries(snap.rules)) {
        if (typeof pid !== 'string' || pid.trim() === '') throw bad(`方案 ${planId} 快照存在非法商品编号`);
        if (store.products[pid] === undefined) throw bad(`方案 ${planId} 快照涉及未登记商品 ${pid}`);
        if (!isPlainObject(whs)) throw bad(`方案 ${planId} 快照中商品 ${pid} 的规则不是对象`);
        const ruleMap = nullProto<Record<string, ReplenishRule>>();
        for (const [wh, rule] of Object.entries(whs)) {
          if (typeof wh !== 'string' || wh.trim() === '') throw bad(`方案 ${planId} 快照存在非法仓库标识`);
          if (
            !isPlainObject(rule) ||
            !isNonNegSafeInt(rule.min) ||
            !isNonNegSafeInt(rule.target) ||
            rule.min >= rule.target
          )
            throw bad(`方案 ${planId} 快照中商品 ${pid} 仓库 ${wh} 的补货规则非法`);
          ruleMap[wh] = { min: rule.min, target: rule.target };
        }
        snapRules[pid] = ruleMap;
      }
      if (Object.keys(snapRules).length === 0) throw bad(`方案 ${planId} 快照不含任何商品规则`);
      for (const [pid, whs] of Object.entries(snap.stock)) {
        if (snapRules[pid] === undefined || !isPlainObject(whs))
          throw bad(`方案 ${planId} 快照实存与规则不一致`);
        const m = nullProto<Record<string, number>>();
        for (const [wh, qty] of Object.entries(whs)) {
          if (snapRules[pid][wh] === undefined || !isNonNegSafeInt(qty))
            throw bad(`方案 ${planId} 快照实存与规则不一致`);
          m[wh] = qty;
        }
        if (Object.keys(m).length !== Object.keys(snapRules[pid]).length)
          throw bad(`方案 ${planId} 快照实存与规则不一致`);
        snapStock[pid] = m;
      }
      for (const [pid, whs] of Object.entries(snap.pending)) {
        if (snapRules[pid] === undefined || !isPlainObject(whs))
          throw bad(`方案 ${planId} 快照待到货与规则不一致`);
        const m = nullProto<Record<string, string>>();
        for (const [wh, v] of Object.entries(whs)) {
          if (snapRules[pid][wh] === undefined || typeof v !== 'string' || !/^\d+$/.test(v))
            throw bad(`方案 ${planId} 快照待到货与规则不一致`);
          m[wh] = v;
        }
        if (Object.keys(m).length !== Object.keys(snapRules[pid]).length)
          throw bad(`方案 ${planId} 快照待到货与规则不一致`);
        snapPending[pid] = m;
      }
      if (
        Object.keys(snapStock).length !== Object.keys(snapRules).length ||
        Object.keys(snapPending).length !== Object.keys(snapRules).length
      )
        throw bad(`方案 ${planId} 快照与规则不一致`);
      for (const t of transfers) {
        if (snapRules[t.product] === undefined)
          throw bad(`方案 ${planId} 的调拨子单 ${t.docId} 商品 ${t.product} 不在快照规则内`);
      }
      for (const p of purchases) {
        if (snapRules[p.product] === undefined)
          throw bad(`方案 ${planId} 的采购子单 ${p.poId} 商品 ${p.product} 不在快照规则内`);
      }

      // 已执行方案：子单关联必须完整且内容与冻结一致，否则视为损坏数据
      let execResultLines: string[] | undefined;
      if (rec.status === 'executed') {
        if (!Array.isArray(rec.execResultLines) || !rec.execResultLines.every((l) => typeof l === 'string'))
          throw bad(`已执行方案 ${planId} 的落单结果非法`);
        execResultLines = rec.execResultLines;
        for (const t of transfers) {
          const doc = store.docs[t.docId];
          if (doc === undefined) throw bad(`已执行方案 ${planId} 的调拨子单 ${t.docId} 不存在`);
          const c = doc.content;
          const items = c.items as Record<string, unknown>;
          const keys = Object.keys(items);
          if (
            c.type !== 'transfer' || c.from !== t.from || c.to !== t.to ||
            keys.length !== 1 || keys[0] !== t.product || items[t.product] !== t.qty
          )
            throw bad(`已执行方案 ${planId} 的调拨子单 ${t.docId} 内容与冻结方案不一致`);
        }
        for (const p of purchases) {
          const po = store.purchases[p.poId];
          if (po === undefined) throw bad(`已执行方案 ${planId} 的采购子单 ${p.poId} 不存在`);
          const keys = Object.keys(po.ordered);
          if (
            po.supplier !== p.supplier || po.wh !== p.wh ||
            keys.length !== 1 || keys[0] !== p.product || po.ordered[p.product] !== p.qty
          )
            throw bad(`已执行方案 ${planId} 的采购子单 ${p.poId} 内容与冻结方案不一致`);
        }
      } else if (rec.execResultLines !== undefined) {
        throw bad(`待执行方案 ${planId} 不应携带落单结果`);
      }

      // 撤回标记：仅已执行方案可携带；与 planWithdrawals 的关联一致性在下方统一校验
      let withdrawnBy: string | undefined;
      if (rec.withdrawnBy !== undefined) {
        if (typeof rec.withdrawnBy !== 'string' || rec.withdrawnBy.trim() === '')
          throw bad(`方案 ${planId} 的撤回请求编号非法`);
        if (rec.status !== 'executed') throw bad(`待执行方案 ${planId} 不应携带撤回标记`);
        withdrawnBy = rec.withdrawnBy;
      }

      store.plans[planId] = {
        planId, transfers, purchases,
        snapshot: { rules: snapRules, stock: snapStock, pending: snapPending },
        status: rec.status,
        ...(execResultLines !== undefined ? { execResultLines } : {}),
        ...(withdrawnBy !== undefined ? { withdrawnBy } : {}),
      };
    }
  }

  // planWithdrawals 为新增字段：合法旧数据没有该字段，按无撤回处理。
  // 撤回请求编号与库存/到货/取消/退货/转单/冲销单共用全局唯一编号空间；
  // 撤回关联（方案标记、子单映射、新冲销单/取消单内容与归属）缺失或不符一律视为
  // 损坏数据，拒绝读取与覆盖。
  if (data.planWithdrawals !== undefined) {
    if (!isPlainObject(data.planWithdrawals)) throw bad('planWithdrawals 不是对象');
    for (const [reqId, rec] of Object.entries(data.planWithdrawals)) {
      if (typeof reqId !== 'string' || reqId.trim() === '') throw bad('存在非法撤回请求编号');
      if (store.docs[reqId] !== undefined) throw bad(`撤回请求编号 ${reqId} 与原始库存单据编号冲突`);
      if (store.arrivals[reqId] !== undefined) throw bad(`撤回请求编号 ${reqId} 与到货单编号冲突`);
      if (store.cancels[reqId] !== undefined) throw bad(`撤回请求编号 ${reqId} 与取消单编号冲突`);
      if (store.returns[reqId] !== undefined) throw bad(`撤回请求编号 ${reqId} 与退货单编号冲突`);
      if (store.poTransfers[reqId] !== undefined) throw bad(`撤回请求编号 ${reqId} 与采购转单编号冲突`);
      if (store.reversals[reqId] !== undefined) throw bad(`撤回请求编号 ${reqId} 与冲销单编号冲突`);
      if (
        !isPlainObject(rec) ||
        typeof rec.planId !== 'string' || rec.planId.trim() === '' ||
        !isPlainObject(rec.transferRevs) ||
        !isPlainObject(rec.purchaseCancels) ||
        !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string')
      )
        throw bad(`撤回请求 ${reqId} 的记录非法`);
      if (rec.reqId !== undefined && rec.reqId !== reqId) throw bad(`撤回请求 ${reqId} 的内嵌编号不一致`);

      const plan = store.plans[rec.planId];
      if (plan === undefined) throw bad(`撤回请求 ${reqId} 指向的方案 ${rec.planId} 不存在（关联断裂）`);
      if (plan.status !== 'executed') throw bad(`撤回请求 ${reqId} 指向的方案 ${rec.planId} 未执行（关联断裂）`);
      if (plan.withdrawnBy !== reqId)
        throw bad(`撤回请求 ${reqId} 与方案 ${rec.planId} 的撤回标记不一致（关联断裂）`);

      // 子单映射逐一对应：无缺漏、多余或重复项
      const transferRevs = nullProto<Record<string, string>>();
      for (const [docId, revId] of Object.entries(rec.transferRevs)) {
        if (docId.trim() === '' || typeof revId !== 'string' || revId.trim() === '')
          throw bad(`撤回请求 ${reqId} 的调拨冲销映射非法`);
        transferRevs[docId] = revId;
      }
      const purchaseCancels = nullProto<Record<string, string>>();
      for (const [poId, canId] of Object.entries(rec.purchaseCancels)) {
        if (poId.trim() === '' || typeof canId !== 'string' || canId.trim() === '')
          throw bad(`撤回请求 ${reqId} 的采购取消映射非法`);
        purchaseCancels[poId] = canId;
      }
      const planT = new Set(plan.transfers.map((t) => t.docId));
      const planP = new Set(plan.purchases.map((p) => p.poId));
      for (const docId of Object.keys(transferRevs)) {
        if (!planT.has(docId)) throw bad(`撤回请求 ${reqId} 的调拨子单 ${docId} 不属于方案 ${rec.planId}`);
      }
      for (const docId of planT) {
        if (transferRevs[docId] === undefined)
          throw bad(`撤回请求 ${reqId} 缺少方案 ${rec.planId} 调拨子单 ${docId} 的冲销映射`);
      }
      for (const poId of Object.keys(purchaseCancels)) {
        if (!planP.has(poId)) throw bad(`撤回请求 ${reqId} 的采购子单 ${poId} 不属于方案 ${rec.planId}`);
      }
      for (const poId of planP) {
        if (purchaseCancels[poId] === undefined)
          throw bad(`撤回请求 ${reqId} 缺少方案 ${rec.planId} 采购子单 ${poId} 的取消映射`);
      }

      // 新子单（冲销单号、取消单号）彼此不得重号，且内容与归属必须与撤回一致
      const newIds = new Set<string>([reqId]);
      for (const t of plan.transfers) {
        const revId = transferRevs[t.docId];
        if (newIds.has(revId)) throw bad(`撤回请求 ${reqId} 的新子单编号 ${revId} 重复`);
        newIds.add(revId);
        const rev = store.reversals[revId];
        if (rev === undefined) throw bad(`撤回请求 ${reqId} 的冲销单 ${revId} 不存在（关联断裂）`);
        if (rev.orig !== t.docId)
          throw bad(`撤回请求 ${reqId} 的冲销单 ${revId} 冲销的是 ${rev.orig}，并非调拨子单 ${t.docId}`);
      }
      for (const p of plan.purchases) {
        const canId = purchaseCancels[p.poId];
        if (newIds.has(canId)) throw bad(`撤回请求 ${reqId} 的新子单编号 ${canId} 重复`);
        newIds.add(canId);
        const can = store.cancels[canId];
        if (can === undefined) throw bad(`撤回请求 ${reqId} 的取消单 ${canId} 不存在（关联断裂）`);
        if (can.poId !== p.poId)
          throw bad(`撤回请求 ${reqId} 的取消单 ${canId} 属于采购单 ${can.poId}，并非采购子单 ${p.poId}`);
        const po = store.purchases[p.poId];
        if (po === undefined)
          throw bad(`撤回请求 ${reqId} 的采购子单 ${p.poId} 不存在（关联断裂）`);
        // 取消单内容必须是该采购子单的完整订购量（撤回取消全部订购、待收归零）
        for (const [pid, q] of Object.entries(po.ordered)) {
          if (can.qty[pid] !== q)
            throw bad(`撤回请求 ${reqId} 的取消单 ${canId} 商品 ${pid} 数量与采购子单 ${p.poId} 完整订购量不符`);
        }
        for (const pid of Object.keys(can.qty)) {
          if (po.ordered[pid] === undefined)
            throw bad(`撤回请求 ${reqId} 的取消单 ${canId} 含采购子单 ${p.poId} 未订购的商品 ${pid}`);
        }
      }

      store.planWithdrawals[reqId] = {
        reqId, planId: rec.planId, transferRevs, purchaseCancels, resultLines: rec.resultLines,
      };
    }
    // 反向一致性：携带撤回标记的方案必须能找到对应撤回请求，且该请求确实指向本方案
    for (const [planId, plan] of Object.entries(store.plans)) {
      if (plan.withdrawnBy === undefined) continue;
      const w = store.planWithdrawals[plan.withdrawnBy];
      if (w === undefined)
        throw bad(`方案 ${planId} 的撤回请求 ${plan.withdrawnBy} 不存在（关联断裂）`);
      if (w.planId !== planId)
        throw bad(`方案 ${planId} 与撤回请求 ${plan.withdrawnBy} 的方案指向不一致（关联断裂）`);
    }
  } else {
    // 没有撤回集合时，任何方案都不得携带撤回标记
    for (const [planId, plan] of Object.entries(store.plans)) {
      if (plan.withdrawnBy !== undefined)
        throw bad(`方案 ${planId} 携带撤回标记 ${plan.withdrawnBy}，但撤回集合不存在（关联断裂）`);
    }
  }

  return store;
}

function saveStore(dataDir: string, store: Store): void {
  const path = dataPath(dataDir);
  // 临时文件名携带进程号与随机标识：同进程多次保存互不覆盖，崩溃后的遗留文件
  // 也能凭进程号确认持有者已退出后再清理，绝不清除存活请求的临时文件。
  const tmp = join(dataDir, `.${DATA_FILENAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  // 仅供本地回归检查使用的崩溃注入点（未设置时完全无作用）：
  //   before-tmp  原子替换前（尚未写临时文件）被 kill，遗留锁、业务不生效
  //   after-tmp   临时文件写完、rename 之前被 kill，遗留锁与临时文件、业务不生效
  //   after-rename 原子替换之后、输出成功之前被 kill，完整提交保留
  const crashPoint = process.env.STOCKROOM_TEST_CRASH;
  if (crashPoint === 'before-tmp') process.kill(process.pid, 'SIGKILL');
  let fd: number;
  try {
    mkdirSync(dataDir, { recursive: true });
    fd = openSync(tmp, 'wx'); // 原子创建：同名（极小概率）直接失败而不是覆盖他人内容
    try {
      writeFileSync(fd, JSON.stringify(store, null, 2) + '\n', 'utf8');
      fsyncSync(fd); // 内容落盘后再 rename，保证替换后即完整提交
    } finally {
      closeSync(fd);
    }
    if (crashPoint === 'after-tmp') process.kill(process.pid, 'SIGKILL');
    renameSync(tmp, path);
    if (crashPoint === 'after-rename') process.kill(process.pid, 'SIGKILL');
  } catch (e) {
    try {
      unlinkSync(tmp); // 写入失败不留下本请求的半成品临时文件
    } catch {
      /* 临时文件不存在也无妨 */
    }
    throw new DataError(`保存数据失败，已有数据保持不变：${(e as Error).message}`);
  }
}

// ---------- 多进程写入协调 ----------
//
// 同一数据目录的写请求用目录内的锁文件串行化：取得写入机会后才读取最新已提交
// 状态，业务校验、去重与原子保存（临时文件 + rename）都在持有锁期间完成，因此
// 并发请求的最终结果等价于某个完整串行执行顺序，流水序号与该顺序一致。锁文件
// 位于数据目录内部，相对、绝对及符号链接路径经 realpath 归一后指向同一目录时
// 共用同一把锁；不同目录各有自己的锁，互不阻塞。只读查询不创建也不检查锁文件。
//
// 锁协议（固定闸门 + 按进程命名的身份文件 + 唯一回收协调者）：
//   - 每个写进程先 O_EXCL 创建自己的身份文件
//     .stockroom.json.lock.<pid>.<nonce> 并写完整持有者信息（pid 在“文件名”里，
//     内容在发布前写好），再用 link() 把它硬链接到固定闸门名
//     .stockroom.json.lock：闸门已存在时 link 原子失败（EEXIST），不存在时原子
//     成功，谁也不会覆盖谁。
//   - 判定占用：闸门存在时取其 inode，找到与之同 inode 的身份文件（或协调者
//     文件），其记录的 pid 仍存活就一律等待——哪怕内容暂时不完整，或持有者建锁
//     后暂停很久，文件年龄与内容完整度从不作为接管依据。
//   - 持有者进程退出后闸门成为遗留物。多个等待者先竞争唯一的“回收协调者”文件
//     .stockroom.json.lock.coord（硬链接原子认领，存活期间稳定唯一，死协调者按
//     死 pid 回收）：只有协调者能动闸门。
//   - 接任是一次“只增链接”的原子无缝替换：协调者先把自己的身份文件额外 link 成
//     交接锚点 .stockroom.json.lock.take.<pid>.<nonce>（持有期间稳定保留，作为
//     闸门 inode 的第二硬链接），再 rename(锚点, 闸门) 覆盖旧死闸门。接任者自始
//     至终保留自己身份文件的原名，它是闸门 inode 的稳定硬链接，因此“闸门是否
//     仍属于本请求”始终可凭 inode 判定，不依赖协调者文件内容。
//   - 回收死协调者时绝不凭“先前读到的死 pid”动手：搬走协调者文件后必须重新读
//     回其内容并复核 pid 仍已退出，且该 pid 不是本进程；若文件已被接任者换成
//     新的存活内容（inode/内容已变），立即把刚搬走的文件用**只增链接的 link**
//     还原（coord 名缺失时 link 成功，已被第三者重新认领时 link 得 EEXIST：绝不
//     rename 覆盖第三者的有效占用）并退出竞争。即使两个恢复者都已确认旧协调者
//     退出、先到的一方也已建立存活占用，迟到方也不可能凭旧判断移走或覆盖它。
//   - 协调者名暂时缺失（正被迟到者搬走、尚未还原）绝不产生第二份有效接任资格：
//     此时只有“闸门仍属同一已退出进程且没有任何同 inode 硬链接”才允许认领，
//     且接任 rename 前还要再次确认协调者名仍是自己（inode 相同）、闸门仍属同一
//     死进程；任一变化都立即让贤并重轮。已失去资格（协调者被搬走/被他人重认）
//     的请求绝不会凭此前检查继续替换闸门。
//   - 接任 rename 之后仍做一次末点复核：若这期间第三者已取得有效占用（本请求的
//     协调者/闸门归属被改），绝不进入业务，而是把闸门无缝交回——存活第三者则
//     直接删本请求多余的闸门名（其同 inode 的身份/协调者硬链接仍在），已退出
//     的继任者则把它的死闸门收成回收物后重轮回收。因此多个恢复者只能串行取得
//     写入机会，迟到还原与接任交接全程没有可覆盖他人占用的窗口。
//   - 接任者在接任 rename 之前或之后再次退出都不影响后续：它的身份/锚点/协调者
//     文件都带自己的死 pid，闸门成为新的遗留占用，下一个写请求自动重复同一
//     回收流程，无需等待或手工删除任何文件。
//   - 释放只作用于本请求的占用：release 只在闸门 inode 仍等于自己身份 inode 时
//     删除闸门，并只删本进程自己的身份/锚点/协调者文件；较早请求的结束、业务
//     失败或超时清理与新请求接任交错时，绝不会删除后来请求的闸门、身份或协调者
//     文件。仍存活的写进程无论写多久都不会被抢占。
//   - 异常退出若发生在原子替换之前，本次业务变动完全不生效；发生在替换之后，
//     完整提交已保留（即使来不及输出成功），重试按已有结果去重。遗留临时文件、
//     身份/锚点/协调者文件与回收物凭 pid 确认持有者已退出后由后续写入者清理，
//     存活请求的文件一律不动。
//
// 等待有上限（默认 10 秒，可用环境变量 STOCKROOM_LOCK_WAIT_MS 按毫秒调整）：
// 只接受十进制非负安全整数，0 表示仅尝试立即取得；非法或超出安全整数范围的
// 配置在任何等待前报标准错误并以退出码 2 结束，绝不退化为无限等待。超时明确
// 报错并以退出码 1 结束。

const LOCK_GATE = `.${DATA_FILENAME}.lock`; // 固定闸门名（也兼容旧版单文件锁）
const LOCK_COORD = `.${DATA_FILENAME}.lock.coord`; // 回收协调者（稳定、唯一）
const LOCK_PREFIX = `.${DATA_FILENAME}.lock.`; // 各进程身份文件此前缀
const TAKE_PREFIX = `.${DATA_FILENAME}.lock.take.`; // 接任时的交接锚点（身份文件的额外硬链接）
const COORD_PREFIX = `.${DATA_FILENAME}.lock.coord.reclaimed.`; // 死协调者回收物
const RECLAIM_PREFIX = `.${DATA_FILENAME}.lock.reclaimed.`; // 旧版本闸门回收物
const TMP_PREFIX = `.${DATA_FILENAME}.`;
const LOCK_WAIT_DEFAULT_MS = 10_000;
const LOCK_POLL_MS = 50;
const COORD_POLL_MS = 30; // 等待现任回收协调者时的轮询间隔

interface WriteLock {
  release(): void;
}

/** 解析并校验等待上限：仅接受纯十进制非负安全整数；0 = 仅立即尝试；非法配置抛用法错误（退出 2）。 */
function lockWaitLimitMs(): number {
  const raw = process.env.STOCKROOM_LOCK_WAIT_MS;
  if (raw === undefined) return LOCK_WAIT_DEFAULT_MS;
  // 必须整体是数字（含空白、小数点、符号均拒绝），避免把非法值悄悄解释为 0 或无限等待
  if (!/^\d+$/.test(raw))
    throw new UsageError(
      `环境变量 STOCKROOM_LOCK_WAIT_MS 必须是非负整数毫秒（0 表示仅尝试立即取得），实际为：${raw}`,
    );
  const n = Number(raw);
  if (!Number.isSafeInteger(n))
    throw new UsageError(
      `环境变量 STOCKROOM_LOCK_WAIT_MS 超出安全整数范围，拒绝启动（不能转换为无限等待）：${raw}`,
    );
  return n;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // 存在但无权发信号：视为存活
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 轮询等待某文件出现（仅供确定性回归的同步钩子使用）。 */
function waitForFile(path: string, timeoutMs = 60_000): void {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      statSync(path);
      return;
    } catch {
      if (Date.now() >= end) return;
      sleepSync(10);
    }
  }
}

/**
 * 仅供本地回归检查使用的确定性同步钩子（未设置 STOCKROOM_TEST_SYNC 时完全无作用）。
 * 配置为单个对象或对象数组：{"point":"<同步点>","signal":"<到达时创建的文件>","wait":"<继续前等待出现的文件>"}。
 * 数组时取第一个 point 匹配的项，便于一个进程在多个同步点上受控。
 * 先 signal 后 wait：到达进程先留下到达标记（内容为其 pid），再阻塞直到测试驱动放行，
 * 从而可精确安排交错，而非靠随机并发碰运气。
 * 同步点：coord-dead（读到旧协调者已死、搬走其文件前）、coord-moved（已搬走协调者
 * 文件、读回复核前，协调者名此刻缺失）、coord-restore（发现搬走的是存活接任者、已
 * 只增链接地还原其协调者文件后）、coord-restore-busy（发现搬走的是存活文件但协调者
 * 名已被第三者重新认领、未覆盖而让贤后）、coord-won（当选回收协调者、接任闸门前）、
 * coord-lost（接任前末点复核发现协调者资格已丢失、让贤重轮前）、
 * take-before（接任 rename 前）、take-after（接任 rename 后、进入业务前）、
 * take-recheck（接任 rename 后末点复核发现资格丢失、交回占用前）、
 * release-before（释放闸门前）。
 */
function testSync(point: string): void {
  const raw = process.env.STOCKROOM_TEST_SYNC;
  if (raw === undefined) return;
  let cfgs: Array<{ point?: string; signal?: string; wait?: string }>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    cfgs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }
  const cfg = cfgs.find((c) => c && c.point === point);
  if (cfg === undefined) return;
  if (cfg.signal) {
    try {
      writeFileSync(cfg.signal, `${process.pid}\n`);
    } catch {
      /* 测试钩子失败不影响正常流程 */
    }
  }
  if (cfg.wait) waitForFile(cfg.wait);
}

/** 把（可能含符号链接的）数据目录归一为真实路径，使同一目录的不同写法共用一把锁。 */
function resolveDataDir(dataDir: string): string {
  try {
    return realpathSync.native(dataDir);
  } catch {
    // 目录尚不存在：先归一父目录（父目录本身可能是符号链接），再拼上待创建的末级
    const abs = resolve(dataDir);
    const slash = Math.max(abs.lastIndexOf('/'), 0);
    const parent = abs.slice(0, slash) || '/';
    const base = abs.slice(slash + 1);
    try {
      return join(realpathSync.native(parent), base);
    } catch {
      return abs;
    }
  }
}

/** 读取锁身份文件名中的 pid（.stockroom.json.lock.<pid>.<nonce>）；无法解析返回 null。 */
function lockNamePid(name: string): number | null {
  if (!name.startsWith(LOCK_PREFIX)) return null;
  const rest = name.slice(LOCK_PREFIX.length);
  if (rest === 'coord' || rest.startsWith('coord.')) return null; // 协调者文件，不是任何进程的身份文件
  if (rest.startsWith('take.')) return null; // 接任锚点，由 takeNamePid 解析
  const dot = rest.indexOf('.');
  const part = dot < 0 ? rest : rest.slice(0, dot);
  return /^\d+$/.test(part) ? Number(part) : null;
}

/** 接任锚点文件名中的 pid（.stockroom.json.lock.take.<pid>.<nonce>）；无法解析返回 null。 */
function takeNamePid(name: string): number | null {
  if (!name.startsWith(TAKE_PREFIX)) return null;
  const rest = name.slice(TAKE_PREFIX.length);
  const part = rest.split('.')[0] ?? '';
  return /^\d+$/.test(part) ? Number(part) : null;
}

/** 读取协调者文件内容首行记录的 pid；读不到或无法解析返回 null（调用方一律等待，绝不擅动）。 */
function readCoordPid(coordPath: string): number | null {
  try {
    const m = /^(\d+)/.exec(readFileSync(coordPath, 'utf8'));
    if (m === null) return null;
    const pid = Number(m[1]);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 尝试成为本目录唯一的“回收协调者”：把本进程的身份文件硬链接到固定协调者名。
 * 返回 true 表示当选；false 表示已有存活协调者（调用方应等待，不得自行回收闸门）。
 * 协调者在整个闸门持有期间保持唯一：其他进程在其存活期间只能等待，从根本上
 * 杜绝两个回收者并发替换闸门。
 *
 * 死协调者的回收严格防止“凭先前判断误删接任者/第三者”：搬走协调者文件后必须
 * 重新读回其内容，复核记录的 pid 仍已退出且不是本进程——因为先到的恢复者可能
 * 已用同一协调者名完成接任（coord 仍是闸门 inode 的存活硬链接）。一旦发现搬走
 * 的其实是存活者的文件，只用**只增链接的 link** 把它还原到协调者名：
 *   - 协调者名仍缺失（先到者的身份文件还是闸门硬链接、尚未重发 coord）：link
 *     原子成功，先到者的 coord 恢复，本进程退出竞争；
 *   - 协调者名已被“第三个”请求重新认领（迟到搬走与本进程还原之间第三者参与
 *     竞争）：link 得 EEXIST，绝不 rename 覆盖第三者。第三者存活则直接让贤；
 *     它也已退出（极端连环退出）则先把其死协调者收成回收物再重试 link，始终
 *     不删任何存活占用。
 * 因此协调者名暂时缺失也绝不会形成两份有效接任资格，迟到还原不可能覆盖第三者
 * 已建立的存活占用。
 */
function tryBecomeCoordinator(dir: string, idPath: string): boolean {
  const coordPath = join(dir, LOCK_COORD);
  for (;;) {
    try {
      linkSync(idPath, coordPath);
      // 仅供回归：当选协调者后、接任闸门前崩溃（遗留死协调者 + 旧死闸门）。
      if (process.env.STOCKROOM_TEST_CRASH === 'after-coord') process.kill(process.pid, 'SIGKILL');
      testSync('coord-won'); // 当选（唯一）回收协调者；调用方随后做接任末点复核
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new DataError(`无法获取数据目录写入机会（认领回收协调文件失败）：${(e as Error).message}`);
    }
    // 已有协调者：仅当能确认其 pid 已退出时才考虑回收；任何无法判定的情况一律等待。
    const seenPid = readCoordPid(coordPath);
    if (seenPid === null || seenPid === process.pid || pidAlive(seenPid)) return false;
    testSync('coord-dead');
    const trash = `${COORD_PREFIX}${process.pid}.${Math.random().toString(36).slice(2)}`;
    const trashPath = join(dir, trash);
    try {
      renameSync(coordPath, trashPath); // 与其他回收死协调者的进程原子决胜
    } catch {
      return false; // 他人已处理：下一轮由 link 的 EEXIST 判定新协调者
    }
    // 仅供回归：已把协调者文件搬走、尚未读回复核（协调者名此刻缺失）。
    testSync('coord-moved');
    // 关键复核：搬走后重新读取“被搬走的文件”。它可能已不是先前那个死协调者
    // （接任者把 coord 换成了自己的存活硬链接，而我们恰好在其接任之后才完成
    // 这次 rename）。
    const movedPid = readCoordPid(trashPath);
    if (movedPid === null || movedPid === process.pid || pidAlive(movedPid)) {
      // 搬走的是存活接任者（或不可判定）的文件：只增链接地还原，绝不 rename 覆盖。
      // trashPath 只是该存活 inode 的一个“额外硬链接”（其本进程身份文件始终还在），
      // 故无论还原成败，本进程让贤时都删掉自己的临时回收名，绝不留下残留。
      let restored = false;
      try {
        linkSync(trashPath, coordPath); // 协调者名仍缺失：原子还原存活接任者的 coord
        restored = true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') {
          // 协调者名已被第三个请求重新认领：绝不覆盖。第三者存活则让贤；第三者
          // 也已退出（连环退出）则把其死协调者改名收走（不强删，可能是闸门
          // inode），再把存活接任者的文件 link 回协调者名。
          const thirdPid = readCoordPid(coordPath);
          if (thirdPid !== null && thirdPid !== process.pid && !pidAlive(thirdPid)) {
            const thirdTrash = `${COORD_PREFIX}${process.pid}.${Math.random().toString(36).slice(2)}`;
            const thirdTrashPath = join(dir, thirdTrash);
            try {
              renameSync(coordPath, thirdTrashPath);
              linkSync(trashPath, coordPath);
              restored = true;
              // 死第三者回收物仅当不是当前闸门 inode 时立即清除；否则留给下任
              // 持有者在闸门移走后凭死 pid 清理（绝不误删占用本身）。
              try {
                if (statSync(thirdTrashPath).ino !== statSync(join(dir, LOCK_GATE)).ino)
                  unlinkSync(thirdTrashPath);
              } catch { /* 忽略：交由 cleanStaleFiles 凭死 pid 清理 */ }
            } catch {
              restored = false; // 又被他人认领或操作失败：让贤，遗留物凭死 pid 清理
            }
          }
        }
        // 其他 link 错误或存活第三者占用：restored 保持 false，让贤。
      }
      try { unlinkSync(trashPath); } catch { /* 本进程临时回收名：删除无碍，存活者身份文件仍在 */ }
      testSync(restored ? 'coord-restore' : 'coord-restore-busy');
      return false; // 迟到者让贤：先到接任者/第三者的有效占用一律不动
    }
    try {
      unlinkSync(trashPath); // 搬走的确认为死协调者：删除回收物
    } catch {
      /* 忽略；后续 cleanStaleFiles 按死 pid 清理 */
    }
    // 循环回到 link 重试：只有一个进程能成功，其余看到新的存活协调者。
  }
}

/**
 * 固定闸门的当前属主裁决。
 * 依次按“与闸门同 inode 的文件名”定位属主 pid：
 *   1) 进程身份文件 .stockroom.json.lock.<pid>.<nonce>（新协议，接任也保留原名，
 *      是最稳定的归属锚点）；
 *   2) 接任交接锚点 .stockroom.json.lock.take.<pid>.<nonce>（接任瞬间的额外硬链接）；
 *   3) 协调者文件（pid 记录在内容首行）。
 * 都没有匹配时回退旧式单文件锁内容 pid。归属只取决于这些记录的 pid 是否存活，
 * 内容无法解析则一律视为不可回收，绝不按文件年龄抢占存活进程。
 * 返回 exists=false 表示闸门刚好缺失；stale=true 表示属主 pid 可确认已退出；
 * ownerPid 为裁决到的属主进程号（无法判定为 null），ino 为闸门当前 inode。
 * 接任者在 rename 前后比对两次裁决的 ino 与 ownerPid，即可发现闸门是否已被
 * 第三者换掉，绝不凭一次旧检查继续替换。
 */
function gateVerdict(dir: string): { exists: boolean; ino?: number | bigint; stale: boolean; ownerPid: number | null } {
  const gatePath = join(dir, LOCK_GATE);
  let gateIno: number | bigint;
  try {
    gateIno = statSync(gatePath).ino;
  } catch {
    return { exists: false, stale: false, ownerPid: null }; // 闸门刚好被释放：调用方下一轮重试
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { exists: true, ino: gateIno, stale: false, ownerPid: null };
  }
  // 1)+2) 身份文件与接任锚点：pid 在文件名里，inode 与闸门相同即属主。
  for (const name of names) {
    const pid = lockNamePid(name) ?? takeNamePid(name);
    if (pid === null) continue;
    try {
      if (statSync(join(dir, name)).ino === gateIno)
        return { exists: true, ino: gateIno, stale: !pidAlive(pid), ownerPid: pid };
    } catch {
      /* 文件刚被删除：忽略 */
    }
  }
  // 3) 协调者文件是闸门 inode 的硬链接时，pid 记录在内容首行。
  const coordPid = readCoordPid(join(dir, LOCK_COORD));
  if (coordPid !== null) {
    try {
      if (statSync(join(dir, LOCK_COORD)).ino === gateIno)
        return { exists: true, ino: gateIno, stale: !pidAlive(coordPid), ownerPid: coordPid };
    } catch {
      /* 协调者不存在或不可读：继续旧式回退判定 */
    }
  }
  // 旧式单文件锁：仅当能读到明确且已退出的 pid 才回收
  try {
    const m = /^(\d+) /m.exec(readFileSync(gatePath, 'utf8'));
    if (m === null) return { exists: true, ino: gateIno, stale: false, ownerPid: null };
    const pid = Number(m[1]);
    return { exists: true, ino: gateIno, stale: !pidAlive(pid), ownerPid: pid };
  } catch {
    return { exists: true, ino: gateIno, stale: false, ownerPid: null };
  }
}

/**
 * 取得写入机会后清理异常退出写进程遗留的临时文件、孤立锁身份/接任锚点文件与
 * 各类回收物。只有文件名（或协调者内容）中 pid 已退出的才删除；并且**任何**与
 * 现存闸门同 inode 的文件都绝不删除——那一定是当前占用本身的硬链接（身份、
 * 接任锚点或协调者）。存活等待者的身份文件与现任协调者文件凭存活 pid 一律保留。
 */
function cleanStaleFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  let gateIno: number | bigint | undefined;
  try {
    gateIno = statSync(join(dir, LOCK_GATE)).ino;
  } catch {
    gateIno = undefined;
  }
  for (const name of names) {
    let pidPart: number | null = null;
    if (name.startsWith(TMP_PREFIX) && name.endsWith('.tmp')) {
      const s = name.slice(TMP_PREFIX.length, -'.tmp'.length).split('.')[0];
      if (/^\d+$/.test(s)) pidPart = Number(s);
    } else if (name === LOCK_COORD) {
      pidPart = readCoordPid(join(dir, name)); // 固定协调者：pid 在内容首行
    } else if (name.startsWith(COORD_PREFIX)) {
      const s = name.slice(COORD_PREFIX.length).split('.')[0]; // 死协调者回收物
      if (/^\d+$/.test(s)) pidPart = Number(s);
    } else if (name.startsWith(RECLAIM_PREFIX)) {
      const s = name.slice(RECLAIM_PREFIX.length).split('.')[0]; // 旧版闸门回收物
      if (/^\d+$/.test(s)) pidPart = Number(s);
    } else {
      pidPart = lockNamePid(name) ?? takeNamePid(name); // 身份文件或接任锚点
    }
    if (pidPart === null || pidAlive(pidPart)) continue;
    if (gateIno !== undefined) {
      try {
        if (statSync(join(dir, name)).ino === gateIno) continue; // 当前占用的任一硬链接：绝不清理
      } catch {
        /* 文件消失：继续尝试删除也无妨 */
      }
    }
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* 清理失败不影响本次写入 */
    }
  }
}

/**
 * 获取数据目录的写入机会（固定闸门硬链接认领 + 稳定协调者无缝回收 + 异常退出恢复）。
 * 成功返回后调用方独占该目录的写权限，必须在 finally 中 release()；
 * 结束或失败都只释放本请求自己的锁。
 */
function acquireWriteLock(dataDirRaw: string): WriteLock {
  const limit = lockWaitLimitMs(); // 非法配置在此即抛用法错误（退出 2），不进入等待
  const dir = resolveDataDir(dataDirRaw);
  try {
    mkdirSync(dir, { recursive: true }); // 首次使用：先建目录再竞争锁，并发创建同样安全
  } catch (e) {
    throw new DataError(`无法创建数据目录 ${dataDirRaw}：${(e as Error).message}`);
  }
  const nonce = makeIdentity(dir); // O_EXCL 创建本进程身份文件，pid 在文件名中
  return claimGate(dir, dataDirRaw, nonce, limit);
}

function makeIdentity(dir: string): string {
  for (let tries = 0; tries < 3; tries++) {
    const nonce = Math.random().toString(36).slice(2);
    const idPath = join(dir, `${LOCK_PREFIX}${process.pid}.${nonce}`);
    try {
      // 先写完整持有者信息再发布：身份文件的所有硬链接（闸门/协调者）被观察到时，
      // 其内容与文件名都已完整；即使本进程随后暂停，存活 pid 也使其绝不被接管。
      const fd = openSync(idPath, 'wx');
      try {
        writeFileSync(fd, `${process.pid} ${new Date().toISOString()} ${nonce}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return nonce;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new DataError(`无法获取数据目录写入机会（创建锁身份文件失败）：${(e as Error).message}`);
    }
  }
  throw new DataError('无法获取数据目录写入机会：锁身份文件反复创建冲突');
}

/**
 * 用本进程的身份文件原子认领固定闸门。闸门被死进程遗留时，等待者先竞争唯一的
 * “回收协调者”文件（硬链接原子认领，存活期间稳定唯一，死协调者按死 pid 回收）：
 *   - 只有协调者会动闸门，且只在 gateVerdict 确认死 pid 后动手；存活持有者的
 *     闸门在其存在期间不会被任何等待者替换（非协调者只能等待）；
 *   - 接任是一次只增链接的原子“替换 rename”：先把身份文件额外 link 成交接
 *     锚点，再 rename(锚点, 闸门) 覆盖旧死闸门。身份文件原名始终保留，是闸门
 *     inode 的稳定硬链接；闸门名全程存在、inode 被整体换成新持有者，没有“闸门
 *     短暂缺失被他人插队”的空隙，回收者绝不可能移走另一个请求刚取得的闸门；
 *   - 接任 rename 的“前”与“后”都做末点复核：rename 前要求协调者名仍是本进程
 *     身份硬链接、闸门仍是先前裁决到的同一死属主（inode 与 pid 均未变）；rename
 *     后要求闸门已是本进程 inode 且协调者名仍属本请求。失去资格就让贤，rename
 *     后发现第三者已取得资格则无缝交还闸门（存活第三者）或收回死继任者，绝不
 *     带着失效资格进入业务；
 *   - 协调者在持有闸门期间一直保留协调者文件，与闸门一起释放；它在接任前或
 *     接任后崩溃，死协调者、死锚点与死闸门都由后续写入者凭死 pid 清理并接任，
 *     多个恢复者依旧只能串行取得写入机会，无需等待或手工删文件。
 */
function claimGate(dir: string, dataDirRaw: string, nonce: string, limit: number): WriteLock {
  const idName = `${LOCK_PREFIX}${process.pid}.${nonce}`;
  const idPath = join(dir, idName);
  const takeName = `${TAKE_PREFIX}${process.pid}.${nonce}`;
  const takePath = join(dir, takeName);
  const gatePath = join(dir, LOCK_GATE);
  const coordPath = join(dir, LOCK_COORD);
  const deadline = Date.now() + limit;

  const safeUnlink = (p: string): void => {
    try { unlinkSync(p); } catch { /* 已不存在：忽略 */ }
  };
  const removeIdentity = (): void => safeUnlink(idPath);
  // 让出/异常路径上释放协调者（仅当它仍是本进程身份文件的硬链接时）。
  // 身份文件原名在整个流程中保留，故这里的 inode 归属判定始终可靠。
  const releaseCoordIfMine = (): void => {
    try {
      if (statSync(coordPath).ino === statSync(idPath).ino) unlinkSync(coordPath);
    } catch { /* 已不存在：忽略 */ }
  };
  // 放弃本次取得机会时的统一清理：只删本进程自己的身份/锚点/协调者文件。
  const abandon = (): void => {
    releaseCoordIfMine();
    safeUnlink(takePath);
    removeIdentity();
  };

  const finish = (heldCoord: boolean): WriteLock => {
    cleanStaleFiles(dir); // 取得写入机会后清理已退出进程遗留的临时/身份/锚点/协调文件
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        testSync('release-before');
        // 以本进程身份文件的 inode 作为唯一自身锚点：只有闸门仍指向本请求时才
        // 删闸门，绝不删除后来接任者已建立的占用。
        let selfIno: number | bigint | undefined;
        try {
          selfIno = statSync(idPath).ino;
        } catch {
          selfIno = undefined;
        }
        if (selfIno !== undefined) {
          try {
            if (statSync(gatePath).ino === selfIno) unlinkSync(gatePath);
          } catch { /* 闸门已缺失：本就无需释放 */ }
        }
        // 只删除本进程自己的身份、锚点与协调者文件。
        safeUnlink(idPath);
        safeUnlink(takePath); // 正常接任后锚点已 rename 成闸门，此处通常不存在
        if (heldCoord) {
          try {
            if (selfIno !== undefined && statSync(coordPath).ino === selfIno) {
              unlinkSync(coordPath);
            } else {
              const cp = readCoordPid(coordPath); // 身份文件缺失时兜底：凭内容 pid
              if (cp === process.pid) unlinkSync(coordPath);
            }
          } catch { /* 遗留协调者由后续写入者凭死 pid 回收 */ }
        }
      },
    };
  };

  const busyError = (): DataError =>
    new DataError(
      `数据目录正忙：等待写入机会超过 ${limit} 毫秒仍未获得（另一进程正在写入 ${dataDirRaw}）；` +
        `本次请求未做任何改动，请稍后重试`,
    );

  let amCoordinator = false; // 本进程是否已成为唯一回收协调者

  // 协调者名是否仍是本进程身份文件的硬链接（接任资格仍在本请求）。
  const coordStillMine = (): boolean => {
    try {
      return statSync(coordPath).ino === statSync(idPath).ino;
    } catch {
      return false; // 协调者名缺失或身份文件缺失：资格已不在本请求
    }
  };
  // 失去资格/让贤时的统一处理：只放弃本进程自己的协调者名、接任锚点与“本进程
  // 自己 inode 的闸门名”，绝不删他人的闸门、身份或协调者文件。
  // （接任 rename 后才发现资格丢失时，闸门可能指向本进程 inode：那是本请求自己
  // 的占用，让贤必须一并收走；若闸门已被换成他人 inode 则绝不触碰。）
  const standDown = (): void => {
    releaseCoordIfMine();
    try {
      if (statSync(gatePath).ino === statSync(idPath).ino) unlinkSync(gatePath);
    } catch { /* 闸门缺失或不属本进程：不动 */ }
    safeUnlink(takePath);
    amCoordinator = false;
  };
  // 接任 rename 后发现协调者名被死进程占据（或缺失）时，把它收回并换成本进程
  // 的硬链接。仅当回收物不是当前闸门 inode 时才立即删除（此时闸门属本进程，死
  // 协调者不可能与闸门同 inode，但仍保留这层保护，绝不误删占用本身）。
  const reclaimDeadCoord = (): boolean => {
    const cp = readCoordPid(coordPath);
    if (cp !== null && cp !== process.pid && !pidAlive(cp)) {
      const dtName = `${COORD_PREFIX}${process.pid}.${Math.random().toString(36).slice(2)}`;
      const dtPath = join(dir, dtName);
      try {
        renameSync(coordPath, dtPath);
        if (statSync(dtPath).ino !== statSync(gatePath).ino) unlinkSync(dtPath);
      } catch {
        return false;
      }
    }
    try {
      linkSync(idPath, coordPath);
      return true;
    } catch {
      return false; // 协调者名已被他人认领：下一轮按存活/死亡裁决
    }
  };

  for (;;) {
    // 1) 原子认领固定闸门：闸门不存在时 link 成功即持有；存在时 EEXIST。
    //    （前一持有者/协调者崩溃导致闸门缺失时，新请求由此直接取得。）
    try {
      linkSync(idPath, gatePath);
      const heldCoord = amCoordinator;
      amCoordinator = false;
      return finish(heldCoord);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        abandon();
        throw new DataError(`无法获取数据目录写入机会（认领锁闸门失败）：${(e as Error).message}`);
      }
    }

    // 2) 闸门被占且属已退出进程：竞争唯一回收协调者，只有协调者能回收闸门。
    //    先记录“本次打算替换的死闸门”裁决（inode + 属主 pid），接任 rename
    //    前后都要据此复核，绝不凭一次旧检查替换已变化的闸门。
    const verdict = gateVerdict(dir);
    if (verdict.exists && verdict.stale) {
      if (!amCoordinator) amCoordinator = tryBecomeCoordinator(dir, idPath);
      if (amCoordinator) {
        // 先把身份文件额外 link 成交接锚点（只增链接，不动闸门），随后在 rename
        // 前的“最窄一点”做末点复核。身份文件原名保留，闸门全程存在。
        let anchorReady = false;
        try {
          linkSync(idPath, takePath);
          anchorReady = true;
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') {
            // 极小概率同名残留：仅当它已是本进程身份的硬链接时续用，否则报错让出。
            let same = false;
            try {
              same = statSync(takePath).ino === statSync(idPath).ino;
            } catch {
              same = false;
            }
            if (same) anchorReady = true;
          }
          if (!anchorReady) {
            abandon();
            throw new DataError(`无法获取数据目录写入机会（创建接任锚点失败）：${(e2 as Error).message}`);
          }
        }
        // 仅供回归：接任锚点已建、闸门 rename 之前崩溃（取得写入机会前退出）。
        if (process.env.STOCKROOM_TEST_CRASH === 'after-take-link') process.kill(process.pid, 'SIGKILL');
        // 到此为止闸门尚未改动；回归可在此暂停，恢复后仍要做下面的末点复核。
        testSync('take-before');
        // 末点复核（接任 rename 之前的最窄一点）：
        //   - 协调者名必须仍是本进程身份 inode（迟到回收者可能已把它搬走、
        //     第三者也可能已重新认领）；
        //   - 闸门必须仍是本轮先前裁决到的“同一个死属主”（inode 与 pid 均未变）。
        // 任一不满足说明本请求的接任资格已丢失，立即让贤并重轮——绝不会凭
        // 此前的检查继续替换闸门。
        const fresh = gateVerdict(dir);
        const sameDeadGate =
          fresh.exists &&
          fresh.stale &&
          fresh.ino === verdict.ino &&
          fresh.ownerPid === verdict.ownerPid;
        if (!coordStillMine() || !sameDeadGate) {
          testSync('coord-lost'); // 接任前最窄一点发现资格丢失：让贤，绝不替换闸门
          standDown();
        } else {
          // 资格完整：把锚点原子 rename 覆盖到闸门名，无缝接任。
          try {
            renameSync(takePath, gatePath); // 覆盖旧死闸门：唯一协调者 + 死属主，单方向、无竞争空隙
          } catch (e3) {
            abandon();
            throw new DataError(`无法获取数据目录写入机会（接任锁闸门失败）：${(e3 as Error).message}`);
          }
          // 仅供回归：接任 rename 完成、进入业务前崩溃（接任者已取得写入机会后退出，
          // 留下新死闸门 + 死协调者/身份/锚点，后续请求须自动再接任）。
          if (process.env.STOCKROOM_TEST_CRASH === 'after-take-rename') process.kill(process.pid, 'SIGKILL');
          // 末点复核（接任 rename 之后）：闸门必须已是本进程身份 inode，且协调者
          // 名仍属本请求，才允许进入业务。极端调度下第三者可能在“检查→rename”
          // 之间取得资格：发现后绝不进入业务，而是无缝交回或让贤重轮。
          let selfIno: number | bigint | undefined;
          try {
            selfIno = statSync(idPath).ino;
          } catch {
            selfIno = undefined;
          }
          const after = gateVerdict(dir);
          if (selfIno !== undefined && after.exists && after.ino === selfIno && coordStillMine()) {
            testSync('take-after');
            return finish(true); // 协调者身份随闸门持有到 release
          }
          testSync('take-recheck'); // rename 后发现资格不完整：放弃/收回占用，绝不进入业务
          if (selfIno !== undefined && after.exists && after.ino === selfIno) {
            // 闸门名在本进程 inode 上，但协调者名缺失或已易主。
            const cp = readCoordPid(coordPath);
            if (cp !== null && cp !== process.pid && pidAlive(cp)) {
              // 存活第三者持有协调资格（正常协议不可达：协调资格只能对死闸门认领）。
              // 稳妥起见只收走“本进程自己 inode 的闸门”，绝不把第三者强推上闸门，
              // 随后作为普通等待者重轮——绝不与任何人并发开展业务。
              standDown();
            } else if (reclaimDeadCoord()) {
              // 无存活第三者（协调者名缺失或为死继任者）：本进程身份硬链接已合法
              // 锚定闸门，收回/补建协调者名后正常持有。
              testSync('take-after');
              return finish(true);
            } else {
              standDown(); // 协调者名被他人抢先认领：让贤重轮
            }
          } else {
            // 闸门已不属本进程（被合法持有者占据）：只放弃本进程协调/锚点，
            // 绝不触碰他人闸门，作为等待者重轮。
            standDown();
          }
        }
      }
      if (amCoordinator) {
        // 自己是协调者但闸门已被合法存活持有者占据（接任前状态变化）：让贤。
        standDown();
      }
    } else if (amCoordinator) {
      // 自己是协调者但闸门属于存活进程：让贤并等待。
      standDown();
    }

    // 3) 闸门属于存活进程（或等待现任协调者完成回收）：在等待上限内轮询。
    if (limit === 0 || Date.now() >= deadline) {
      abandon();
      throw busyError();
    }
    sleepSync(COORD_POLL_MS);
  }
}

// ---------- 参数解析 ----------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
  multi: Record<string, string[]>;
}

function parseArgs(
  tokens: string[],
  singles: string[],
  multis: string[] = [],
): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {}, multi: {} };
  const singleSet = new Set(singles);
  const multiSet = new Set(multis);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      let key = tok;
      let value: string | undefined;
      const eq = tok.indexOf('=');
      if (eq >= 0) {
        key = tok.slice(0, eq);
        value = tok.slice(eq + 1);
      }
      if (!singleSet.has(key) && !multiSet.has(key)) throw new UsageError(`未知参数：${tok}`);
      if (value === undefined) {
        if (i + 1 >= tokens.length) throw new UsageError(`参数 ${key} 缺少取值`);
        value = tokens[++i];
      }
      if (multiSet.has(key)) (out.multi[key] ??= []).push(value);
      else if (out.flags[key] !== undefined) throw new UsageError(`参数 ${key} 重复指定`);
      else out.flags[key] = value;
    } else {
      out.positionals.push(tok);
    }
  }
  return out;
}

function parseItem(raw: string, merged: Map<string, number>): void {
  const idx = raw.indexOf(':');
  if (idx <= 0) throw new BizError(`明细格式应为 “商品编号:数量”：${raw}`);
  const pid = trimOrThrow('商品编号', raw.slice(0, idx));
  const qtyRaw = raw.slice(idx + 1).trim();
  if (!/^\d+$/.test(qtyRaw)) throw new BizError(`商品 ${pid} 的数量必须为正安全整数：${qtyRaw}`);
  const qty = Number(qtyRaw);
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new BizError(`商品 ${pid} 的数量必须为正安全整数：${qtyRaw}`);
  const sum = (merged.get(pid) ?? 0) + qty; // 同单同商品先合并
  if (!Number.isSafeInteger(sum)) throw new BizError(`商品 ${pid} 累计数量超出安全整数范围`);
  merged.set(pid, sum);
}

interface DocRequest {
  type: DocType;
  docId: string;
  wh?: string;
  from?: string;
  to?: string;
  items: Map<string, number>;
}

function parseDocArgs(type: DocType, tokens: string[]): DocRequest {
  const args = parseArgs(tokens, type === 'transfer' ? ['--from', '--to'] : ['--wh'], ['--item']);
  const docId = args.positionals[0];
  if (docId === undefined || args.positionals.length !== 1)
    throw new UsageError(`用法：单据命令需要且仅需要一个单据编号`);

  const items = new Map<string, number>();
  for (const raw of args.multi['--item'] ?? []) parseItem(raw, items);
  if (items.size === 0) throw new UsageError('单据至少需要一条 --item 商品编号:数量 明细');

  const req: DocRequest = { type, docId: trimOrThrow('单据编号', docId), items };
  if (type === 'transfer') {
    if (args.flags['--from'] === undefined || args.flags['--to'] === undefined)
      throw new UsageError('调拨单必须提供 --from <调出仓> 与 --to <调入仓>');
    req.from = trimOrThrow('调出仓标识', args.flags['--from']);
    req.to = trimOrThrow('调入仓标识', args.flags['--to']);
    if (req.from === req.to) throw new BizError('调拨单的调出仓与调入仓不能相同');
  } else {
    if (args.flags['--wh'] === undefined) throw new UsageError('入库/出库单必须提供 --wh <仓库>');
    req.wh = trimOrThrow('仓库标识', args.flags['--wh']);
  }
  return req;
}

interface CountItem {
  expected: number; // 预期账面量
  actual: number; // 实盘量
}

interface CountRequest {
  docId: string;
  wh: string;
  items: Map<string, CountItem>;
}

function parseNonNegInt(label: string, raw: string): number {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) throw new BizError(`${label}必须为非负安全整数：${raw}`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new BizError(`${label}必须为非负安全整数：${raw}`);
  return n;
}

function parseCountArgs(tokens: string[]): CountRequest {
  const args = parseArgs(tokens, ['--wh'], ['--item']);
  const docId = args.positionals[0];
  if (docId === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：count <单据编号> --wh <仓库> --item <商品编号:预期账面量:实盘量> [...]');
  if (args.flags['--wh'] === undefined) throw new UsageError('盘点单必须提供 --wh <仓库>');

  const items = new Map<string, CountItem>();
  for (const raw of args.multi['--item'] ?? []) {
    const parts = raw.split(':');
    if (parts.length !== 3)
      throw new BizError(`盘点明细格式应为 “商品编号:预期账面量:实盘量”：${raw}`);
    const pid = trimOrThrow('商品编号', parts[0]);
    const expected = parseNonNegInt(`商品 ${pid} 的预期账面量`, parts[1]);
    const actual = parseNonNegInt(`商品 ${pid} 的实盘量`, parts[2]);
    if (items.has(pid)) throw new BizError(`盘点单中商品 ${pid} 重复出现，拒绝提交`);
    items.set(pid, { expected, actual });
  }
  if (items.size === 0)
    throw new UsageError('盘点单至少需要一条 --item 商品编号:预期账面量:实盘量 明细');

  return { docId: trimOrThrow('单据编号', docId), wh: trimOrThrow('仓库标识', args.flags['--wh']), items };
}

// ---------- 采购单与到货参数 ----------

interface PurchaseRequest {
  poId: string;
  supplier: string;
  wh: string;
  items: Map<string, number>; // 合并后的订购量
}

interface ArrivalRequest {
  arrId: string;
  poId: string;
  items: Map<string, number>; // 合并后的本次到货量
}

interface CancelRequest {
  canId: string;
  poId: string;
  items: Map<string, number>; // 合并后的本次取消量
}

interface ReturnRequest {
  retId: string;
  arrId: string; // 原到货单编号（采购单与收货仓取原到货）
  items: Map<string, number>; // 合并后的本次退货量
}

interface TransferRequest {
  tId: string; // 转单编号（与库存/到货/取消/退货/冲销单共用编号空间）
  origPoId: string; // 原采购编号
  destPoId: string; // 新目的采购编号（独立采购编号空间，必须未被占用）
  supplier: string; // 目的单供应商
  wh: string; // 目的单收货仓
  items: Map<string, number>; // 合并后的本次转出量
}

function parsePurchaseArgs(tokens: string[]): PurchaseRequest {
  const args = parseArgs(tokens, ['--supplier', '--wh'], ['--item']);
  const poRaw = args.positionals[0];
  if (poRaw === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：po register <采购编号> --supplier <供应商名称> --wh <收货仓> --item <商品编号:订购量> [...]');
  if (args.flags['--supplier'] === undefined) throw new UsageError('采购单必须提供 --supplier <供应商名称>');
  if (args.flags['--wh'] === undefined) throw new UsageError('采购单必须提供 --wh <收货仓>');

  const items = new Map<string, number>();
  for (const raw of args.multi['--item'] ?? []) parseItem(raw, items);
  if (items.size === 0) throw new UsageError('采购单至少需要一条 --item 商品编号:订购量 明细');

  return {
    poId: trimOrThrow('采购编号', poRaw),
    supplier: trimOrThrow('供应商名称', args.flags['--supplier']),
    wh: trimOrThrow('收货仓标识', args.flags['--wh']),
    items,
  };
}

function parseArrivalArgs(tokens: string[]): ArrivalRequest {
  const args = parseArgs(tokens, ['--po'], ['--item']);
  const arrRaw = args.positionals[0];
  if (arrRaw === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：arrival <到货单编号> --po <采购编号> --item <商品编号:到货量> [...]');
  if (args.flags['--po'] === undefined) throw new UsageError('到货必须通过 --po <采购编号> 指定所属采购单（收货仓取采购单）');

  const items = new Map<string, number>();
  for (const raw of args.multi['--item'] ?? []) parseItem(raw, items);
  if (items.size === 0) throw new UsageError('到货单至少需要一条 --item 商品编号:到货量 明细');

  return { arrId: trimOrThrow('到货单编号', arrRaw), poId: trimOrThrow('采购编号', args.flags['--po']), items };
}

function parseCancelArgs(tokens: string[]): CancelRequest {
  const args = parseArgs(tokens, ['--po'], ['--item']);
  const canRaw = args.positionals[0];
  if (canRaw === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：cancel <取消单编号> --po <采购编号> --item <商品编号:取消量> [...]');
  if (args.flags['--po'] === undefined) throw new UsageError('取消必须通过 --po <采购编号> 指定所属采购单');

  const items = new Map<string, number>();
  for (const raw of args.multi['--item'] ?? []) parseItem(raw, items);
  if (items.size === 0) throw new UsageError('取消单至少需要一条 --item 商品编号:取消量 明细');

  return { canId: trimOrThrow('取消单编号', canRaw), poId: trimOrThrow('采购编号', args.flags['--po']), items };
}

function parseReturnArgs(tokens: string[]): ReturnRequest {
  const args = parseArgs(tokens, ['--arrival'], ['--item']);
  const retRaw = args.positionals[0];
  if (retRaw === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：return <退货单编号> --arrival <原到货单编号> --item <商品编号:退货量> [...]');
  if (args.flags['--arrival'] === undefined)
    throw new UsageError('退货必须通过 --arrival <原到货单编号> 指定原到货单（采购单与收货仓取原到货）');

  const items = new Map<string, number>();
  for (const raw of args.multi['--item'] ?? []) parseItem(raw, items);
  if (items.size === 0) throw new UsageError('退货单至少需要一条 --item 商品编号:退货量 明细');

  return {
    retId: trimOrThrow('退货单编号', retRaw),
    arrId: trimOrThrow('原到货单编号', args.flags['--arrival']),
    items,
  };
}

function parseTransferArgs(tokens: string[]): TransferRequest {
  const args = parseArgs(tokens, ['--orig', '--dest', '--supplier', '--wh'], ['--item']);
  const tRaw = args.positionals[0];
  if (tRaw === undefined || args.positionals.length !== 1)
    throw new UsageError(
      '用法：po-transfer <转单编号> --orig <原采购编号> --dest <新目的采购编号> ' +
        '--supplier <供应商> --wh <收货仓> --item <商品编号:转出量> [...]',
    );
  for (const [k, label] of [['--orig', '原采购编号'], ['--dest', '新目的采购编号'], ['--supplier', '供应商名称'], ['--wh', '收货仓']] as const) {
    if (args.flags[k] === undefined) throw new UsageError(`采购转单必须提供 ${k} <${label}>`);
  }

  const items = new Map<string, number>();
  for (const raw of args.multi['--item'] ?? []) parseItem(raw, items);
  if (items.size === 0) throw new UsageError('采购转单至少需要一条 --item 商品编号:转出量 明细');

  return {
    tId: trimOrThrow('转单编号', tRaw),
    origPoId: trimOrThrow('原采购编号', args.flags['--orig']),
    destPoId: trimOrThrow('新目的采购编号', args.flags['--dest']),
    supplier: trimOrThrow('供应商名称', args.flags['--supplier']),
    wh: trimOrThrow('收货仓标识', args.flags['--wh']),
    items,
  };
}

// ---------- 整批导入文件解析 ----------

type ImportRequest =
  | { kind: 'doc'; req: DocRequest }
  | { kind: 'count'; req: CountRequest }
  | { kind: 'reverse'; docId: string; orig: string }
  | { kind: 'po'; req: PurchaseRequest }
  | { kind: 'arrival'; req: ArrivalRequest }
  | { kind: 'cancel'; req: CancelRequest }
  | { kind: 'return'; req: ReturnRequest }
  | { kind: 'transfer'; req: TransferRequest };

/** 读取导入文件：无法读取属于读写失败（退出 1），不改变任何已提交状态。 */
function readImportFile(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new DataError(`无法读取导入文件 ${file}：${(e as Error).message}（不会改变任何已提交数据）`);
  }
}

/**
 * 解析整批导入文件。文件级结构错误（非合法 JSON、根不是数组、空列表）属于文件
 * 格式错误（退出 2）；逐项格式不合法属于业务拒绝（退出 1），指出位置与原因。
 */
function parseImportFile(raw: string): ImportRequest[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`导入文件不是合法 JSON：${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new UsageError('导入文件格式错误：根节点必须是单据对象组成的有序数组');
  if (data.length === 0) throw new UsageError('导入文件格式错误：单据列表至少包含一项');

  const out: ImportRequest[] = [];
  // 顶层位置一律标注 1 起序号，便于纠正
  const at = (i: number, msg: string): BizError => new BizError(`第 ${i + 1} 项：${msg}`);

  const requireString = (obj: Record<string, unknown>, key: string, label: string, i: number): string => {
    const v = obj[key];
    if (v === undefined) throw at(i, `缺少${label}字段 "${key}"`);
    if (typeof v !== 'string') throw at(i, `${label}字段 "${key}" 必须是字符串`);
    const s = v.trim();
    if (s === '') throw at(i, `${label}去除首尾空白后不能为空`);
    return s;
  };

  const checkUnknown = (obj: Record<string, unknown>, allowed: readonly string[], i: number): void => {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) throw at(i, `含不支持的字段 "${k}"（允许字段：${allowed.join('、')}）`);
    }
  };

  const parseQtyItems = (obj: Record<string, unknown>, i: number): Map<string, number> => {
    const v = obj.items;
    if (v === undefined) throw at(i, '缺少商品明细字段 "items"');
    if (!Array.isArray(v)) throw at(i, '"items" 必须是明细对象数组');
    if (v.length === 0) throw at(i, '商品明细至少一项');
    const merged = new Map<string, number>();
    v.forEach((entry, j) => {
      if (!isPlainObject(entry)) throw at(i, `第 ${j + 1} 条明细不是对象`);
      const e = entry as Record<string, unknown>;
      checkUnknown(e, ['product', 'qty'], i);
      const pid = e.product;
      if (typeof pid !== 'string') throw at(i, `第 ${j + 1} 条明细缺少商品编号字段 "product" 或不是字符串`);
      const p = pid.trim();
      if (p === '') throw at(i, `第 ${j + 1} 条明细的商品编号去空白后不能为空`);
      if (!isPosSafeInt(e.qty)) throw at(i, `商品 ${p} 的数量必须为正安全整数`);
      const sum = (merged.get(p) ?? 0) + (e.qty as number); // 同单同商品先合并
      if (!Number.isSafeInteger(sum)) throw at(i, `商品 ${p} 累计数量超出安全整数范围`);
      merged.set(p, sum);
    });
    return merged;
  };

  const parseCountItems = (obj: Record<string, unknown>, i: number): Map<string, CountItem> => {
    const v = obj.items;
    if (v === undefined) throw at(i, '缺少商品明细字段 "items"');
    if (!Array.isArray(v)) throw at(i, '"items" 必须是明细对象数组');
    if (v.length === 0) throw at(i, '商品明细至少一项');
    const items = new Map<string, CountItem>();
    v.forEach((entry, j) => {
      if (!isPlainObject(entry)) throw at(i, `第 ${j + 1} 条明细不是对象`);
      const e = entry as Record<string, unknown>;
      checkUnknown(e, ['product', 'expected', 'actual'], i);
      const pid = e.product;
      if (typeof pid !== 'string') throw at(i, `第 ${j + 1} 条明细缺少商品编号字段 "product" 或不是字符串`);
      const p = pid.trim();
      if (p === '') throw at(i, `第 ${j + 1} 条明细的商品编号去空白后不能为空`);
      if (!isNonNegSafeInt(e.expected)) throw at(i, `商品 ${p} 的预期账面量必须为非负安全整数`);
      if (!isNonNegSafeInt(e.actual)) throw at(i, `商品 ${p} 的实盘量必须为非负安全整数`);
      if (items.has(p)) throw at(i, `盘点明细中商品 ${p} 重复出现，拒绝提交`); // 盘点不合并
      items.set(p, { expected: e.expected, actual: e.actual });
    });
    return items;
  };

  data.forEach((rawItem, i) => {
    if (!isPlainObject(rawItem)) throw at(i, '不是单据对象');
    const item = rawItem as Record<string, unknown>;
    if (item.type === undefined) throw at(i, '缺少业务类型字段 "type"');
    if (typeof item.type !== 'string') throw at(i, '业务类型字段 "type" 必须是字符串');

    switch (item.type) {
      case 'in':
      case 'out': {
        checkUnknown(item, ['type', 'id', 'wh', 'items'], i);
        const docId = requireString(item, 'id', '单据编号', i);
        const wh = requireString(item, 'wh', '仓库标识', i);
        out.push({ kind: 'doc', req: { type: item.type, docId, wh, items: parseQtyItems(item, i) } });
        break;
      }
      case 'transfer': {
        checkUnknown(item, ['type', 'id', 'from', 'to', 'items'], i);
        const docId = requireString(item, 'id', '单据编号', i);
        const from = requireString(item, 'from', '调出仓标识', i);
        const to = requireString(item, 'to', '调入仓标识', i);
        if (from === to) throw at(i, '调拨单的调出仓与调入仓不能相同');
        out.push({ kind: 'doc', req: { type: 'transfer', docId, from, to, items: parseQtyItems(item, i) } });
        break;
      }
      case 'count': {
        checkUnknown(item, ['type', 'id', 'wh', 'items'], i);
        const docId = requireString(item, 'id', '单据编号', i);
        const wh = requireString(item, 'wh', '仓库标识', i);
        out.push({ kind: 'count', req: { docId, wh, items: parseCountItems(item, i) } });
        break;
      }
      case 'reverse': {
        checkUnknown(item, ['type', 'id', 'orig'], i);
        const docId = requireString(item, 'id', '冲销单编号', i);
        const orig = requireString(item, 'orig', '原单编号', i);
        out.push({ kind: 'reverse', docId, orig });
        break;
      }
      case 'po': {
        checkUnknown(item, ['type', 'id', 'supplier', 'wh', 'items'], i);
        const poId = requireString(item, 'id', '采购编号', i);
        const supplier = requireString(item, 'supplier', '供应商名称', i);
        const wh = requireString(item, 'wh', '收货仓标识', i);
        out.push({ kind: 'po', req: { poId, supplier, wh, items: parseQtyItems(item, i) } });
        break;
      }
      case 'arrival': {
        checkUnknown(item, ['type', 'id', 'po', 'items'], i);
        const arrId = requireString(item, 'id', '到货单编号', i);
        const poId = requireString(item, 'po', '采购编号', i);
        out.push({ kind: 'arrival', req: { arrId, poId, items: parseQtyItems(item, i) } });
        break;
      }
      case 'cancel': {
        checkUnknown(item, ['type', 'id', 'po', 'items'], i);
        const canId = requireString(item, 'id', '取消单编号', i);
        const poId = requireString(item, 'po', '采购编号', i);
        out.push({ kind: 'cancel', req: { canId, poId, items: parseQtyItems(item, i) } });
        break;
      }
      case 'return': {
        checkUnknown(item, ['type', 'id', 'arrival', 'items'], i);
        const retId = requireString(item, 'id', '退货单编号', i);
        const arrId = requireString(item, 'arrival', '原到货单编号', i);
        out.push({ kind: 'return', req: { retId, arrId, items: parseQtyItems(item, i) } });
        break;
      }
      case 'po-transfer': {
        checkUnknown(item, ['type', 'id', 'orig', 'dest', 'supplier', 'wh', 'items'], i);
        const tId = requireString(item, 'id', '转单编号', i);
        const origPoId = requireString(item, 'orig', '原采购编号', i);
        const destPoId = requireString(item, 'dest', '新目的采购编号', i);
        const supplier = requireString(item, 'supplier', '供应商名称', i);
        const wh = requireString(item, 'wh', '收货仓标识', i);
        if (origPoId === destPoId) throw at(i, '采购转单的原采购与目的采购不能相同');
        out.push({ kind: 'transfer', req: { tId, origPoId, destPoId, supplier, wh, items: parseQtyItems(item, i) } });
        break;
      }
      default:
        throw at(i, `不支持的业务类型 "${String(item.type)}"，只允许 in、out、transfer、count、reverse、po、arrival、cancel、return、po-transfer`);
    }
  });

  return out;
}

// ---------- 业务核心 ----------

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** 带符号数量文本：正数加 +，负数保留 -，零为 0。 */
function fmtSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function canonicalContent(req: DocRequest): Record<string, unknown> {
  const items: Record<string, number> = nullProto();
  for (const pid of [...req.items.keys()].sort()) items[pid] = req.items.get(pid)!;
  if (req.type === 'transfer') return { type: req.type, from: req.from!, to: req.to!, items };
  return { type: req.type, wh: req.wh!, items };
}

function getStock(stock: Store['stock'], pid: string, wh: string): number {
  return stock[pid]?.[wh] ?? 0;
}

function setStock(stock: Store['stock'], pid: string, wh: string, qty: number): void {
  (stock[pid] ??= nullProto<Record<string, number>>())[wh] = qty;
}

/**
 * 深拷贝余量草稿。必须自建 null 原型容器：structuredClone 不保留 null 原型，
 * 普通对象在 "__proto__"/"constructor" 等商品或仓库键下会发生原型串改。
 */
function cloneStock(stock: Store['stock']): Store['stock'] {
  const out = nullProto<Store['stock']>();
  for (const pid of Object.keys(stock)) {
    const whMap = nullProto<Record<string, number>>();
    for (const wh of Object.keys(stock[pid])) whMap[wh] = stock[pid][wh];
    out[pid] = whMap;
  }
  return out;
}

function canonicalCountContent(req: CountRequest): Record<string, unknown> {
  const items: Record<string, unknown> = nullProto();
  for (const pid of [...req.items.keys()].sort()) {
    const it = req.items.get(pid)!;
    items[pid] = { expected: it.expected, actual: it.actual };
  }
  return { type: 'count', wh: req.wh, items };
}

/** 采购单规范化内容：明细按商品编号排序，比较时与明细顺序无关。 */
function canonicalPurchaseContent(req: PurchaseRequest): {
  supplier: string;
  wh: string;
  ordered: Record<string, number>;
} {
  const ordered: Record<string, number> = nullProto();
  for (const pid of [...req.items.keys()].sort()) ordered[pid] = req.items.get(pid)!;
  return { supplier: req.supplier, wh: req.wh, ordered };
}

/** 到货明细规范化：合并后数量按商品编号排序。 */
function canonicalArrivalItems(items: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = nullProto();
  for (const pid of [...items.keys()].sort()) out[pid] = items.get(pid)!;
  return out;
}

interface ApplyOutcome {
  duplicate: boolean;
  header: string; // 结果首行汇总
  lines: string[]; // 逐项明细结果
  repeatedFrom?: 'store' | 'batch'; // 重复项来自导入前已存数据，还是本批此前各项
}

/**
 * 账务模拟器：单条命令与整批导入共用。所有变动先落在草稿余量与新增流水上，
 * 编号去重视图（docs/revs）在模拟期间即时更新但不写回 base，全部项通过后由
 * commit 一次性落库；模拟途中抛错则 base 与磁盘均不受影响。
 */
class Ledger {
  private readonly base: Store;
  private readonly draft: Store['stock'];
  private readonly additions: LedgerEntry[] = [];
  private seq: number;
  private readonly docs: Record<string, DocRecord> = nullProto();
  private readonly revs: Record<string, ReversalRecord> = nullProto();
  private readonly pos: Record<string, PurchaseRecord> = nullProto();
  private readonly arrivals: Record<string, ArrivalRecord> = nullProto();
  private readonly cancels: Record<string, CancelRecord> = nullProto();
  private readonly returns: Record<string, ReturnRecord> = nullProto();
  private readonly transfers: Record<string, PoTransferRecord> = nullProto();
  private readonly withdrawals: Record<string, PlanWithdrawalRecord> = nullProto();
  private readonly reversedOrigs = new Set<string>();
  private readonly newDocIds: string[] = [];
  private readonly newRevIds: string[] = [];
  private readonly newPoIds: string[] = [];
  private readonly newArrivalIds: string[] = [];
  private readonly newCancelIds: string[] = [];
  private readonly newReturnIds: string[] = [];
  private readonly newTransferIds: string[] = [];
  private readonly newWithdrawalIds: string[] = [];
  private readonly withdrawnPlanMarks = new Map<string, string>(); // 方案编号 -> 撤回请求编号（commit 时写回）

  constructor(store: Store) {
    this.base = store;
    this.draft = cloneStock(store.stock);
    this.seq = store.entries.length;
    for (const [id, rec] of Object.entries(store.docs)) this.docs[id] = rec;
    for (const [id, rec] of Object.entries(store.reversals)) {
      this.revs[id] = rec;
      this.reversedOrigs.add(rec.orig);
    }
    for (const [id, rec] of Object.entries(store.purchases)) this.pos[id] = rec;
    for (const [id, rec] of Object.entries(store.arrivals)) this.arrivals[id] = rec;
    for (const [id, rec] of Object.entries(store.cancels)) this.cancels[id] = rec;
    for (const [id, rec] of Object.entries(store.returns)) this.returns[id] = rec;
    for (const [id, rec] of Object.entries(store.poTransfers)) this.transfers[id] = rec;
    for (const [id, rec] of Object.entries(store.planWithdrawals)) this.withdrawals[id] = rec;
  }

  /** 是否有新生效单据：无新单据（全部重复）时 commit 不改写数据。 */
  get changed(): boolean {
    return (
      this.newDocIds.length +
      this.newRevIds.length +
      this.newPoIds.length +
      this.newArrivalIds.length +
      this.newCancelIds.length +
      this.newReturnIds.length +
      this.newTransferIds.length +
      this.newWithdrawalIds.length > 0
    );
  }

  /** 重建原始单据结果首行，供幂等重放。 */
  private docHeader(docId: string, rec: DocRecord): string {
    const c = rec.content;
    const n = Object.keys(c.items as Record<string, unknown>).length;
    return c.type === 'count'
      ? `盘点单 ${docId} 提交成功，仓库 ${c.wh as string}，共 ${n} 种商品：`
      : `${c.type === 'in' ? '入库' : c.type === 'out' ? '出库' : '调拨'}单 ${docId} 提交成功，共 ${n} 种商品：`;
  }

  /** 重建冲销单结果首行，供幂等重放。 */
  private revHeader(revId: string, rec: ReversalRecord): string {
    const origDoc = this.docs[rec.orig];
    if (origDoc !== undefined) {
      const type = origDoc.content.type as string;
      const label = type === 'in' ? '入库' : type === 'out' ? '出库' : type === 'transfer' ? '调拨' : '盘点';
      const n = Object.keys(origDoc.content.items as Record<string, unknown>).length;
      return `冲销单 ${revId} 提交成功，冲销${label}原单 ${rec.orig}，共 ${n} 种商品：`;
    }
    const origCan = this.cancels[rec.orig];
    if (origCan !== undefined) {
      const n = Object.keys(origCan.qty).length;
      return `冲销单 ${revId} 提交成功，冲销取消原单 ${rec.orig}（采购单 ${origCan.poId}），共 ${n} 种商品：`;
    }
    const origRet = this.returns[rec.orig];
    if (origRet !== undefined) {
      const n = Object.keys(origRet.qty).length;
      return `冲销单 ${revId} 提交成功，冲销退货原单 ${rec.orig}（原到货单 ${origRet.arrId}，采购单 ${origRet.poId}），共 ${n} 种商品：`;
    }
    const origTr = this.transfers[rec.orig];
    if (origTr !== undefined) {
      const n = Object.keys(origTr.qty).length;
      return `冲销单 ${revId} 提交成功，冲销采购转单 ${rec.orig}（原采购单 ${origTr.origPo}，目的采购单 ${origTr.destPo}），共 ${n} 种商品：`;
    }
    // 原单为到货单（能进入去重视图的冲销单必然指向存在的原单）
    const arr = this.arrivals[rec.orig];
    const n = Object.keys(arr.qty).length;
    return `冲销单 ${revId} 提交成功，冲销到货原单 ${rec.orig}（采购单 ${arr.poId}），共 ${n} 种商品：`;
  }

  private repeatedPoSource(poId: string): 'store' | 'batch' {
    return this.base.purchases[poId] !== undefined ? 'store' : 'batch';
  }

  private repeatedArrivalSource(arrId: string): 'store' | 'batch' {
    return this.base.arrivals[arrId] !== undefined ? 'store' : 'batch';
  }

  /**
   * 计算某采购单各商品当前“有效到货”：未冲销累计到货 - 未冲销累计退货。
   * 采购转单不产生到货（目的单初始仍全量待收），故不影响有效到货。
   * 累计总量可超过安全整数范围（反复退货、补收），必须用 BigInt 精确累计，
   * 不得因中间累计舍入而改变净量；单票数量本身仍为正安全整数。
   */
  private effectiveArrived(poId: string): Record<string, bigint> {
    const arrived = nullProto<Record<string, bigint>>();
    for (const [arrId, arr] of Object.entries(this.arrivals)) {
      if (arr.poId !== poId || this.reversedOrigs.has(arrId)) continue;
      for (const [pid, q] of Object.entries(arr.qty)) arrived[pid] = (arrived[pid] ?? 0n) + BigInt(q);
    }
    // 未冲销退货抵减有效到货（有未冲销退货的到货单禁止冲销，故其原到货必然计入上行）
    for (const [retId, ret] of Object.entries(this.returns)) {
      if (ret.poId !== poId || this.reversedOrigs.has(retId)) continue;
      for (const [pid, q] of Object.entries(ret.qty)) arrived[pid] = (arrived[pid] ?? 0n) - BigInt(q);
    }
    return arrived;
  }

  /**
   * 计算某采购单各商品当前“有效取消”（BigInt 精确累计），三部分：
   * 1) 未冲销取消单的取消量；
   * 2) 本单作为原单由未冲销采购转单转出的量（转出量在原单计入有效取消）；
   * 3) 本单作为目的单且其来源转单已被冲销：目的单全部订购量计为取消（待收归零）。
   */
  private effectiveCancelled(poId: string): Record<string, bigint> {
    const cancelled = nullProto<Record<string, bigint>>();
    for (const [canId, can] of Object.entries(this.cancels)) {
      if (can.poId !== poId || this.reversedOrigs.has(canId)) continue;
      for (const [pid, q] of Object.entries(can.qty)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
    }
    for (const t of Object.values(this.transfers)) {
      if (t.origPo !== poId || this.reversedOrigs.has(t.tId)) continue;
      for (const [pid, q] of Object.entries(t.qty)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
    }
    const po = this.pos[poId];
    if (po?.fromTransfer !== undefined && this.reversedOrigs.has(po.fromTransfer)) {
      for (const [pid, q] of Object.entries(po.ordered)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
    }
    return cancelled;
  }

  /**
   * 采购单登记：只登记订购信息，不改动任何库存，登记成功后内容不可修改。
   * 采购单编号独立于库存单据编号空间，允许与入库/到货/冲销单同名；
   * 同号同内容重放返回原登记结果且不重置到货进度，同号不同内容拒绝。
   */
  applyPurchase(req: PurchaseRequest): ApplyOutcome {
    const content = canonicalPurchaseContent(req);
    const existed = this.pos[req.poId];
    if (existed !== undefined) {
      if (
        existed.supplier !== req.supplier ||
        existed.wh !== req.wh ||
        stableStringify(existed.ordered) !== stableStringify(content.ordered as Record<string, number>)
      )
        throw new BizError(`采购编号 ${req.poId} 已用于内容不同的采购单，拒绝提交且不重置到货进度`);
      return {
        duplicate: true,
        header: this.poHeader(req.poId, existed),
        lines: existed.resultLines,
        repeatedFrom: this.repeatedPoSource(req.poId),
      };
    }

    for (const pid of req.items.keys()) {
      if (this.base.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
    }

    const ordered: Record<string, number> = nullProto();
    const reportLines: string[] = [];
    for (const pid of [...req.items.keys()].sort()) {
      const qty = req.items.get(pid)!;
      ordered[pid] = qty;
      reportLines.push(`订购 ${pid} x${qty}，待到货 ${qty}`);
    }

    this.pos[req.poId] = {
      poId: req.poId, supplier: req.supplier, wh: req.wh, ordered, resultLines: reportLines,
    };
    this.newPoIds.push(req.poId);

    return { duplicate: false, header: this.poHeader(req.poId, this.pos[req.poId]), lines: reportLines };
  }

  private poHeader(poId: string, rec: PurchaseRecord): string {
    return `采购单 ${poId} 登记成功，供应商 ${rec.supplier}，收货仓 ${rec.wh}，共 ${Object.keys(rec.ordered).length} 种商品（登记不改动库存）：`;
  }

  /**
   * 采购到货：独立到货单编号，引用已登记采购单，可分次收部分商品；
   * 仅能收采购单内商品，并入采购单收货仓。各商品“未冲销累计到货 + 本次”
   * 不得超过订购量；任一明细非法、超收或库存溢出整单拒绝。
   * 到货单与入库/出库/调拨/盘点/冲销单共用唯一编号空间；普通入库不能绑定采购。
   */
  applyArrival(req: ArrivalRequest): ApplyOutcome {
    const existed = this.arrivals[req.arrId];
    if (existed !== undefined) {
      if (
        existed.poId !== req.poId ||
        stableStringify(existed.qty) !== stableStringify(canonicalArrivalItems(req.items))
      )
        throw new BizError(`到货单编号 ${req.arrId} 已用于内容不同的单据，拒绝提交`);
      return {
        duplicate: true,
        header: this.arrivalHeader(req.arrId, existed),
        lines: existed.resultLines,
        repeatedFrom: this.repeatedArrivalSource(req.arrId),
      };
    }
    // 与入库/出库/调拨/盘点/取消/退货/转单/冲销单共用唯一编号空间（采购单编号空间独立，不在此列）
    if (this.docs[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.revs[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于冲销单，拒绝提交`);
    if (this.cancels[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于取消单，拒绝提交`);
    if (this.returns[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于退货单，拒绝提交`);
    if (this.transfers[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于采购转单，拒绝提交`);
    if (this.withdrawals[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于方案撤回请求，拒绝提交`);

    const po = this.pos[req.poId];
    if (po === undefined) throw new BizError(`采购单 ${req.poId} 不存在，拒绝到货`);

    for (const [pid] of req.items) {
      if (this.base.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
      if (po.ordered[pid] === undefined)
        throw new BizError(`商品 ${pid} 不在采购单 ${req.poId} 的订购明细内，拒绝整单`);
    }

    const arrivedBefore = this.effectiveArrived(req.poId); // 未冲销累计到货
    const cancelledBefore = this.effectiveCancelled(req.poId); // 未冲销累计取消
    const pids = [...req.items.keys()].sort();
    const wh = po.wh;

    // 超收与溢出先整单校验、模拟，任一商品失败则不登记任何到货
    const reportLines: string[] = [];
    const planned = new Map<string, { before: number; after: number; qty: number }>();

    for (const pid of pids) {
      const qty = req.items.get(pid)!;
      const cancelled = cancelledBefore[pid] ?? 0n;
      const arrivedEff = arrivedBefore[pid] ?? 0n;
      const ordered = BigInt(po.ordered[pid]);
      const cumulative = arrivedEff + BigInt(qty); // 含本次的有效到货（BigInt 精确累计）
      // 待到货量 = 订购量 - 有效到货量 - 有效取消量；本次到货只能使用扣除有效取消后的待到货量
      if (cumulative + cancelled > ordered)
        throw new BizError(
          `商品 ${pid} 到货超收：订购 ${po.ordered[pid]}，此前有效到货 ${arrivedEff}，` +
            `有效取消 ${cancelled}，待到货 ${ordered - arrivedEff - cancelled}，本次 ${qty}，拒绝整单`,
        );
      const before = getStock(this.draft, pid, wh);
      const after = before + qty;
      if (after > MAX_SAFE)
        throw new BizError(`商品 ${pid} 到货并入仓库 ${wh} 后余量超出安全整数范围，拒绝整单`);
      planned.set(pid, { before, after, qty });
    }

    const qtyRecord: Record<string, number> = nullProto();
    for (const pid of pids) {
      const { before, after, qty } = planned.get(pid)!;
      setStock(this.draft, pid, wh, after);
      this.additions.push({
        seq: ++this.seq, doc: req.arrId, type: 'arrival', product: pid, wh,
        qty, before, after, po: req.poId,
      });
      const cumulative = (arrivedBefore[pid] ?? 0n) + BigInt(qty);
      const remaining = BigInt(po.ordered[pid]) - cumulative - (cancelledBefore[pid] ?? 0n);
      qtyRecord[pid] = qty;
      reportLines.push(
        `到货 ${pid} @${wh} +${qty}：库存 ${before} -> ${after}；有效到货 ${cumulative}/${po.ordered[pid]}，待到货 ${remaining}`,
      );
    }

    this.arrivals[req.arrId] = { poId: req.poId, wh, qty: qtyRecord, resultLines: reportLines };
    this.newArrivalIds.push(req.arrId);

    return { duplicate: false, header: this.arrivalHeader(req.arrId, this.arrivals[req.arrId]), lines: reportLines };
  }

  private arrivalHeader(arrId: string, rec: ArrivalRecord): string {
    return `到货单 ${arrId} 提交成功，采购单 ${rec.poId}，收货仓 ${rec.wh}，共 ${Object.keys(rec.qty).length} 种商品：`;
  }

  private repeatedCancelSource(canId: string): 'store' | 'batch' {
    return this.base.cancels[canId] !== undefined ? 'store' : 'batch';
  }

  /**
   * 采购取消：独立取消单编号，引用已登记采购单，可分次取消部分商品；
   * 仅能取消采购单内商品。各商品“未冲销累计取消 + 本次”不得超过当前待到货量
   * （订购量 - 有效到货量 - 有效取消量）；任一明细超量整单拒绝。
   * 成功只减少待收承诺，不改原订购内容、库存或库存流水。
   * 取消单与入库/出库/调拨/盘点/到货/冲销单共用唯一编号空间。
   */
  applyCancel(req: CancelRequest): ApplyOutcome {
    const existed = this.cancels[req.canId];
    if (existed !== undefined) {
      if (
        existed.poId !== req.poId ||
        stableStringify(existed.qty) !== stableStringify(canonicalArrivalItems(req.items))
      )
        throw new BizError(`取消单编号 ${req.canId} 已用于内容不同的单据，拒绝提交`);
      // 同号同采购同合并数量重放：即使进度已变化或该取消已被冲销，也只返回原结果
      return {
        duplicate: true,
        header: this.cancelHeader(req.canId, existed),
        lines: existed.resultLines,
        repeatedFrom: this.repeatedCancelSource(req.canId),
      };
    }
    // 与入库/出库/调拨/盘点/到货/退货/转单/冲销单共用唯一编号空间（采购单编号空间独立，不在此列）
    if (this.docs[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.arrivals[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于到货单，拒绝提交`);
    if (this.revs[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于冲销单，拒绝提交`);
    if (this.returns[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于退货单，拒绝提交`);
    if (this.transfers[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于采购转单，拒绝提交`);
    if (this.withdrawals[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于方案撤回请求，拒绝提交`);

    const po = this.pos[req.poId];
    if (po === undefined) throw new BizError(`采购单 ${req.poId} 不存在，拒绝取消`);

    for (const [pid] of req.items) {
      if (this.base.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
      if (po.ordered[pid] === undefined)
        throw new BizError(`商品 ${pid} 不在采购单 ${req.poId} 的订购明细内，拒绝整单`);
    }

    const arrived = this.effectiveArrived(req.poId); // 未冲销累计到货
    const cancelledBefore = this.effectiveCancelled(req.poId); // 未冲销累计取消
    const pids = [...req.items.keys()].sort();

    // 先整单校验：任一商品本次取消量超过当前待到货量则整单拒绝、不登记任何取消
    for (const pid of pids) {
      const qty = req.items.get(pid)!;
      const remaining =
        BigInt(po.ordered[pid]) - (arrived[pid] ?? 0n) - (cancelledBefore[pid] ?? 0n);
      if (BigInt(qty) > remaining)
        throw new BizError(
          `商品 ${pid} 取消量超出待到货量：订购 ${po.ordered[pid]}，有效到货 ${arrived[pid] ?? 0n}，` +
            `有效取消 ${cancelledBefore[pid] ?? 0n}，待到货 ${remaining}，本次取消 ${qty}，拒绝整单`,
        );
    }

    const qtyRecord: Record<string, number> = nullProto();
    const reportLines: string[] = [];
    for (const pid of pids) {
      const qty = req.items.get(pid)!;
      const effAfter = (cancelledBefore[pid] ?? 0n) + BigInt(qty); // 含本次的有效取消
      const remainingAfter = BigInt(po.ordered[pid]) - (arrived[pid] ?? 0n) - effAfter;
      qtyRecord[pid] = qty;
      reportLines.push(
        `取消 ${pid} x${qty}：有效取消 ${effAfter}，待到货 ${remainingAfter}（只减少待收承诺，不改库存）`,
      );
    }

    this.cancels[req.canId] = { poId: req.poId, qty: qtyRecord, resultLines: reportLines };
    this.newCancelIds.push(req.canId);

    return { duplicate: false, header: this.cancelHeader(req.canId, this.cancels[req.canId]), lines: reportLines };
  }

  private cancelHeader(canId: string, rec: CancelRecord): string {
    return `取消单 ${canId} 提交成功，采购单 ${rec.poId}，共 ${Object.keys(rec.qty).length} 种商品（只减少待收承诺，不改库存与流水）：`;
  }

  private repeatedReturnSource(retId: string): 'store' | 'batch' {
    return this.base.returns[retId] !== undefined ? 'store' : 'batch';
  }

  /**
   * 采购退货：独立退货单编号，引用一张已成功且未冲销的原到货单，采购单与收货仓
   * 取原到货；只退原到货明细内商品，退货量为正安全整数、同商品先合并（顺序无关）。
   * 各商品本次退货量不得超过“原到货量 - 该到货单关联的未冲销累计退货量”，并从
   * 原收货仓当前余量扣减；超退、缺货或明细非法整单拒绝、不占编号。
   * 退货抵减有效到货（有效到货 = 未冲销到货 - 未冲销退货），相应数量重新待到货、
   * 等待补收；不改订购与取消。退货单与库存/到货/取消/冲销单共用唯一编号空间。
   * 同号同原到货同合并数量重放返回原结果——即使进度已变化、该退货或原到货已
   * 冲销也不再校验、不再生效；同号不同内容或其他业务拒绝。
   */
  applyReturn(req: ReturnRequest): ApplyOutcome {
    const existed = this.returns[req.retId];
    if (existed !== undefined) {
      if (
        existed.arrId !== req.arrId ||
        stableStringify(existed.qty) !== stableStringify(canonicalArrivalItems(req.items))
      )
        throw new BizError(`退货单编号 ${req.retId} 已用于内容不同的单据，拒绝提交`);
      return {
        duplicate: true,
        header: this.returnHeader(req.retId, existed),
        lines: existed.resultLines,
        repeatedFrom: this.repeatedReturnSource(req.retId),
      };
    }
    // 与入库/出库/调拨/盘点/到货/取消/转单/冲销单共用唯一编号空间（采购单编号空间独立，不在此列）
    if (this.docs[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.arrivals[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于取消单，拒绝提交`);
    if (this.revs[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于冲销单，拒绝提交`);
    if (this.transfers[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于采购转单，拒绝提交`);
    if (this.withdrawals[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于方案撤回请求，拒绝提交`);

    const arr = this.arrivals[req.arrId];
    if (arr === undefined) throw new BizError(`原到货单 ${req.arrId} 不存在，拒绝退货`);
    if (this.reversedOrigs.has(req.arrId))
      throw new BizError(`原到货单 ${req.arrId} 已整单冲销，不能再对其退货，拒绝整单`);

    const poId = arr.poId;
    const wh = arr.wh;
    const po = this.pos[poId];
    const pids = [...req.items.keys()].sort();

    // 该原到货单各商品此前未冲销累计退货量
    const returnedBefore = nullProto<Record<string, number>>();
    for (const [retId, ret] of Object.entries(this.returns)) {
      if (ret.arrId !== req.arrId || this.reversedOrigs.has(retId)) continue;
      for (const [pid, q] of Object.entries(ret.qty)) returnedBefore[pid] = (returnedBefore[pid] ?? 0) + q;
    }
    const arrivedEff = this.effectiveArrived(poId); // 有效到货（未冲销到货 - 未冲销退货）
    const cancelled = this.effectiveCancelled(poId); // 未冲销累计取消

    // 先整单校验：只能退原到货明细商品、不超退、原收货仓当前余量充足；任一失败不登记任何退货
    for (const pid of pids) {
      const qty = req.items.get(pid)!;
      if (arr.qty[pid] === undefined)
        throw new BizError(`商品 ${pid} 不在原到货单 ${req.arrId} 的明细内，拒绝整单`);
      const allow = arr.qty[pid] - (returnedBefore[pid] ?? 0);
      if (qty > allow)
        throw new BizError(
          `商品 ${pid} 退货超量：原到货 ${arr.qty[pid]}，此前未冲销累计退货 ${returnedBefore[pid] ?? 0}，` +
            `可退 ${allow}，本次 ${qty}，拒绝整单`,
        );
      const before = getStock(this.draft, pid, wh);
      if (before < qty)
        throw new BizError(`商品 ${pid} 原收货仓 ${wh} 当前余量 ${before} 不足退货 ${qty}，拒绝整单`);
    }

    const qtyRecord: Record<string, number> = nullProto();
    const reportLines: string[] = [];
    for (const pid of pids) {
      const qty = req.items.get(pid)!;
      const before = getStock(this.draft, pid, wh);
      const after = before - qty;
      setStock(this.draft, pid, wh, after);
      this.additions.push({
        seq: ++this.seq, doc: req.retId, type: 'return', product: pid, wh,
        qty, before, after, po: poId, arr: req.arrId,
      });
      // 退货后有效到货下降，相应数量重新待到货、等待补收
      const effAfter = (arrivedEff[pid] ?? 0n) - BigInt(qty);
      const remaining = BigInt(po.ordered[pid]) - effAfter - (cancelled[pid] ?? 0n);
      qtyRecord[pid] = qty;
      reportLines.push(
        `退货 ${pid} @${wh} -${qty}：库存 ${before} -> ${after}；有效到货降至 ${effAfter}/${po.ordered[pid]}，待到货 ${remaining}（等待补收）`,
      );
    }

    this.returns[req.retId] = { arrId: req.arrId, poId, wh, qty: qtyRecord, resultLines: reportLines };
    this.newReturnIds.push(req.retId);

    return { duplicate: false, header: this.returnHeader(req.retId, this.returns[req.retId]), lines: reportLines };
  }

  private returnHeader(retId: string, rec: ReturnRecord): string {
    return `退货单 ${retId} 提交成功，原到货单 ${rec.arrId}（采购单 ${rec.poId}），收货仓 ${rec.wh}，共 ${Object.keys(rec.qty).length} 种商品：`;
  }

  private repeatedTransferSource(tId: string): 'store' | 'batch' {
    return this.base.poTransfers[tId] !== undefined ? 'store' : 'batch';
  }

  /**
   * 采购待收转单：把原采购单的部分当前待收量转给一张新的目的采购单（重新安排
   * 供应商或收货仓）。成功同时减少原单待收（转出量计入原单有效取消）并新建目的
   * 采购单（目的订购量等于转出量，初始全量待收，可按普通采购到货、取消或再转单）。
   * 原订购与有效到货不变，不改库存、不产生库存流水。
   * 原采购须存在、至少一项原单内商品；目的采购编号必须未被占用（即使内容相同也
   * 拒绝）；各商品转出量不得超过原单当前待收量（订购-有效到货-有效取消，精确净
   * 进度）；任一不符整单拒绝。转单与库存/到货/取消/退货/冲销单共用唯一编号空间，
   * 采购编号独立。同转单编号同全部内容重放返回原结果，不重新校验、不再生效；
   * 改内容或业务拒绝，失败不占用本次新编号。
   */
  applyTransfer(req: TransferRequest): ApplyOutcome {
    const existed = this.transfers[req.tId];
    if (existed !== undefined) {
      if (
        existed.origPo !== req.origPoId ||
        existed.destPo !== req.destPoId ||
        existed.supplier !== req.supplier ||
        existed.wh !== req.wh ||
        stableStringify(existed.qty) !== stableStringify(canonicalArrivalItems(req.items))
      )
        throw new BizError(`采购转单编号 ${req.tId} 已用于内容不同的单据，拒绝提交`);
      return {
        duplicate: true,
        header: this.transferHeader(req.tId, existed),
        lines: existed.resultLines,
        repeatedFrom: this.repeatedTransferSource(req.tId),
      };
    }
    // 与入库/出库/调拨/盘点/到货/取消/退货/冲销单共用唯一编号空间（采购单编号空间独立）
    if (this.docs[req.tId] !== undefined)
      throw new BizError(`单据编号 ${req.tId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.arrivals[req.tId] !== undefined)
      throw new BizError(`单据编号 ${req.tId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.tId] !== undefined)
      throw new BizError(`单据编号 ${req.tId} 已用于取消单，拒绝提交`);
    if (this.returns[req.tId] !== undefined)
      throw new BizError(`单据编号 ${req.tId} 已用于退货单，拒绝提交`);
    if (this.revs[req.tId] !== undefined)
      throw new BizError(`单据编号 ${req.tId} 已用于冲销单，拒绝提交`);
    if (this.withdrawals[req.tId] !== undefined)
      throw new BizError(`单据编号 ${req.tId} 已用于方案撤回请求，拒绝提交`);

    const origPo = this.pos[req.origPoId];
    if (origPo === undefined) throw new BizError(`原采购单 ${req.origPoId} 不存在，拒绝转单`);
    if (req.origPoId === req.destPoId)
      throw new BizError(`采购转单 ${req.tId} 的原采购与目的采购不能相同，拒绝整单`);
    // 目的编号必须未被采购占用：即使已有内容相同的采购单也拒绝，不接管、不续用
    if (this.pos[req.destPoId] !== undefined)
      throw new BizError(`目的采购编号 ${req.destPoId} 已被采购占用（即使内容相同也拒绝转单），拒绝整单`);

    for (const pid of req.items.keys()) {
      if (this.base.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
      if (origPo.ordered[pid] === undefined)
        throw new BizError(`商品 ${pid} 不在原采购单 ${req.origPoId} 的订购明细内，拒绝整单`);
    }

    // 原单当前待收量 = 订购 - 有效到货 - 有效取消（有效取消含此前未冲销转出；BigInt 精确净进度）
    const arrived = this.effectiveArrived(req.origPoId);
    const cancelledBefore = this.effectiveCancelled(req.origPoId);
    const pids = [...req.items.keys()].sort();
    for (const pid of pids) {
      const qty = BigInt(req.items.get(pid)!);
      const remaining =
        BigInt(origPo.ordered[pid]) - (arrived[pid] ?? 0n) - (cancelledBefore[pid] ?? 0n);
      if (qty > remaining)
        throw new BizError(
          `商品 ${pid} 转出量超过原采购单 ${req.origPoId} 当前待收量：订购 ${origPo.ordered[pid]}，` +
            `有效到货 ${arrived[pid] ?? 0n}，有效取消 ${cancelledBefore[pid] ?? 0n}，` +
            `当前待收 ${remaining}，本次转出 ${qty}，拒绝整单`,
        );
    }

    const qtyRecord: Record<string, number> = nullProto();
    const destOrdered: Record<string, number> = nullProto();
    const destResultLines: string[] = [];
    const reportLines: string[] = [];
    for (const pid of pids) {
      const qty = req.items.get(pid)!;
      qtyRecord[pid] = qty;
      destOrdered[pid] = qty;
      destResultLines.push(`订购 ${pid} x${qty}，待到货 ${qty}`);
      const origBefore =
        BigInt(origPo.ordered[pid]) - (arrived[pid] ?? 0n) - (cancelledBefore[pid] ?? 0n);
      reportLines.push(
        `转单 ${pid} x${qty}：原采购单 ${req.origPoId} 待收 ${origBefore} -> ${origBefore - BigInt(qty)}；` +
          `目的采购单 ${req.destPoId} 待收 0 -> ${qty}（转出计入原单有效取消，不改库存与流水）`,
      );
    }

    // 新建目的采购单：目的订购量等于转出量，标记来源转单（目的单可按普通采购继续业务）
    this.pos[req.destPoId] = {
      poId: req.destPoId, supplier: req.supplier, wh: req.wh, ordered: destOrdered,
      fromTransfer: req.tId, resultLines: destResultLines,
    };
    this.newPoIds.push(req.destPoId);
    this.transfers[req.tId] = {
      tId: req.tId, origPo: req.origPoId, destPo: req.destPoId,
      supplier: req.supplier, wh: req.wh, qty: qtyRecord, resultLines: reportLines,
    };
    this.newTransferIds.push(req.tId);

    return { duplicate: false, header: this.transferHeader(req.tId, this.transfers[req.tId]), lines: reportLines };
  }

  private transferHeader(tId: string, rec: PoTransferRecord): string {
    return (
      `采购转单 ${tId} 提交成功：原采购单 ${rec.origPo} -> 目的采购单 ${rec.destPo}` +
      `（供应商 ${rec.supplier}，收货仓 ${rec.wh}），共 ${Object.keys(rec.qty).length} 种商品（不改库存与流水）：`
    );
  }

  /**
   * 整单冲销采购转单：仅当目的单所有商品仍“全量待收”（按精确净进度：有效到货、
   * 有效取消均为零；历史业务已合法恢复全量待收也允许）才允许。成功仅移除本转单
   * 在原单形成的有效取消（原单待收相应回升），并把目的单全部订购量计为取消、
   * 待收归零；保留两单及全部历史，不撤销后续业务，不改库存、不产生库存流水。
   * 每张转单最多冲销一次，冲销单不可冲销；转出形成的关闭不能用取消单冲销代替。
   */
  private applyTransferReversal(revId: string, origId: string, t: PoTransferRecord): ApplyOutcome {
    if (this.reversedOrigs.has(origId)) {
      let existingRev = '';
      for (const [r, rec] of Object.entries(this.revs)) {
        if (rec.orig === origId) {
          existingRev = r;
          break;
        }
      }
      throw new BizError(`采购转单 ${origId} 已被冲销单 ${existingRev} 成功冲销，每张转单只能冲销一次`);
    }

    // 目的单必须仍全量待收：有效到货（未冲销到货-未冲销退货）与有效取消均为零
    const destArrived = this.effectiveArrived(t.destPo);
    const destCancelled = this.effectiveCancelled(t.destPo);
    const pids = Object.keys(t.qty).sort();
    for (const pid of pids) {
      const got = destArrived[pid] ?? 0n;
      const can = destCancelled[pid] ?? 0n;
      if (got !== 0n || can !== 0n)
        throw new BizError(
          `冲销采购转单 ${origId}：目的采购单 ${t.destPo} 商品 ${pid} 已非全量待收` +
            `（有效到货 ${got}，有效取消 ${can}），拒绝冲销；请先恢复其全量待收`,
        );
    }

    const origPo = this.pos[t.origPo];
    const origArrived = this.effectiveArrived(t.origPo);
    const origCancelledBefore = this.effectiveCancelled(t.origPo); // 含本转单：其尚未被冲销，仍计入
    const reportLines: string[] = [];
    for (const pid of pids) {
      const qty = BigInt(t.qty[pid]);
      // 移除本转单在原单形成的有效取消后，原单待收回升
      const origBefore =
        BigInt(origPo.ordered[pid]) - (origArrived[pid] ?? 0n) - (origCancelledBefore[pid] ?? 0n);
      reportLines.push(
        `冲销转单 原单=${origId} 商品=${pid} 恢复转出量 ${t.qty[pid]}：` +
          `原采购单 ${t.origPo} 待收 ${origBefore} -> ${origBefore + qty}；` +
          `目的采购单 ${t.destPo} 全部订购量 ${t.qty[pid]} 计为取消，待收 ${t.qty[pid]} -> 0` +
          `（保留两单及历史，不改库存、不撤销后续业务）`,
      );
    }

    // 登记冲销关系：原单转出的有效取消随之移除；目的单全部订购量自此计为取消（待收归零）
    this.revs[revId] = { orig: origId, resultLines: reportLines };
    this.newRevIds.push(revId);
    this.reversedOrigs.add(origId);

    return {
      duplicate: false,
      header: `冲销单 ${revId} 提交成功，冲销采购转单 ${origId}（原采购单 ${t.origPo}，目的采购单 ${t.destPo}），共 ${pids.length} 种商品：`,
      lines: reportLines,
    };
  }

  private repeatedRevSource(revId: string): 'store' | 'batch' {
    return this.base.reversals[revId] !== undefined ? 'store' : 'batch';
  }

  /**
   * 整案撤回已执行补货方案：为每条调拨子单登记一张普通冲销单（在当前余量上
   * 从原调入仓扣回、向原调出仓补回，追加普通冲销流水），为每张采购子单登记一张
   * 普通取消单（取消完整订购量、待收归零，不改库存与流水）。不恢复库存快照，
   * 不删除原单或后续业务。仅允许已执行且未撤回的方案：各调拨子单须未冲销，
   * 各采购子单所有商品须全量待收（有效到货与有效取消均为零，按当前精确净进度
   * 判断，不核对保存快照；历史业务经合法操作恢复此状态也允许）。
   * 请求编号与新子单号共用全局单据编号空间，彼此不得重号；首次撤回不接管已占
   * 编号（即使内容相同也拒绝）；撤回请求本身不可冲销。任一校验或子单失败整案
   * 拒绝：本次库存、进度、流水、编号、冲销关系及撤回标记均不保留，失败不占
   * 编号，可同号重试。每案最多成功撤回一次；同请求编号、同方案及子单映射
   * 重放返回原结果，不再校验、生效或改写文件。
   */
  applyWithdraw(req: WithdrawRequest): ApplyOutcome {
    const existed = this.withdrawals[req.reqId];
    if (existed !== undefined) {
      if (
        existed.planId !== req.planId ||
        !sameStringMapping(existed.transferRevs, req.transferRevs) ||
        !sameStringMapping(existed.purchaseCancels, req.purchaseCancels)
      )
        throw new BizError(`撤回请求编号 ${req.reqId} 已用于内容不同的撤回，拒绝提交`);
      return {
        duplicate: true,
        header: this.withdrawalHeader(existed),
        lines: existed.resultLines,
        repeatedFrom: 'store',
      };
    }
    // 请求编号与入库/出库/调拨/盘点/到货/取消/退货/转单/冲销单共用唯一编号空间
    if (this.docs[req.reqId] !== undefined)
      throw new BizError(`撤回请求编号 ${req.reqId} 已用于入库/出库/调拨/盘点单，拒绝撤回`);
    if (this.arrivals[req.reqId] !== undefined)
      throw new BizError(`撤回请求编号 ${req.reqId} 已用于到货单，拒绝撤回`);
    if (this.cancels[req.reqId] !== undefined)
      throw new BizError(`撤回请求编号 ${req.reqId} 已用于取消单，拒绝撤回`);
    if (this.returns[req.reqId] !== undefined)
      throw new BizError(`撤回请求编号 ${req.reqId} 已用于退货单，拒绝撤回`);
    if (this.transfers[req.reqId] !== undefined)
      throw new BizError(`撤回请求编号 ${req.reqId} 已用于采购转单，拒绝撤回`);
    if (this.revs[req.reqId] !== undefined)
      throw new BizError(`撤回请求编号 ${req.reqId} 已用于冲销单，拒绝撤回`);

    const plan = this.base.plans[req.planId];
    if (plan === undefined) throw new BizError(`补货方案 ${req.planId} 不存在，拒绝撤回`);
    if (plan.status !== 'executed')
      throw new BizError(`补货方案 ${req.planId} 尚未执行，仅允许撤回已执行且未撤回的方案，整案拒绝`);
    const priorWithdrawal = plan.withdrawnBy ?? this.withdrawnPlanMarks.get(req.planId);
    if (priorWithdrawal !== undefined)
      throw new BizError(
        `补货方案 ${req.planId} 已被撤回请求 ${priorWithdrawal} 撤回，每案最多成功撤回一次，整案拒绝`,
      );

    // 子单映射逐一对应：无缺漏、多余（重复项在解析阶段拒绝）
    const problems: string[] = [];
    const planT = new Set(plan.transfers.map((t) => t.docId));
    const planP = new Set(plan.purchases.map((p) => p.poId));
    for (const docId of planT) {
      if (!req.transferRevs.has(docId)) problems.push(`缺少调拨子单 ${docId} 的冲销单号指定`);
    }
    for (const docId of req.transferRevs.keys()) {
      if (!planT.has(docId)) problems.push(`多余的调拨子单指定 ${docId}（方案 ${req.planId} 无此调拨子单）`);
    }
    for (const poId of planP) {
      if (!req.purchaseCancels.has(poId)) problems.push(`缺少采购子单 ${poId} 的取消单号指定`);
    }
    for (const poId of req.purchaseCancels.keys()) {
      if (!planP.has(poId)) problems.push(`多余的采购子单指定 ${poId}（方案 ${req.planId} 无此采购子单）`);
    }
    if (problems.length > 0)
      throw new BizError(`撤回映射与方案 ${req.planId} 的子单不对应，整案拒绝：\n${problems.join('\n')}`);

    // 请求编号与全部新子单号彼此不得重号；首次撤回不接管已占编号（即使内容相同也拒绝）
    const claimed = new Map<string, string>([[req.reqId, '撤回请求编号']]);
    const claim = (id: string, use: string): void => {
      const prev = claimed.get(id);
      if (prev !== undefined)
        throw new BizError(`编号 ${id} 在本次撤回中同时用作${prev}与${use}，彼此不得重号，整案拒绝`);
      claimed.set(id, use);
      if (id === req.reqId) return; // 请求编号占用情况已在上方检查
      if (this.docs[id] !== undefined)
        throw new BizError(`${use} ${id} 已被入库/出库/调拨/盘点单占用（即使内容相同也不接管），整案拒绝`);
      if (this.arrivals[id] !== undefined)
        throw new BizError(`${use} ${id} 已被到货单占用（即使内容相同也不接管），整案拒绝`);
      if (this.cancels[id] !== undefined)
        throw new BizError(`${use} ${id} 已被取消单占用（即使内容相同也不接管），整案拒绝`);
      if (this.returns[id] !== undefined)
        throw new BizError(`${use} ${id} 已被退货单占用（即使内容相同也不接管），整案拒绝`);
      if (this.transfers[id] !== undefined)
        throw new BizError(`${use} ${id} 已被采购转单占用（即使内容相同也不接管），整案拒绝`);
      if (this.revs[id] !== undefined)
        throw new BizError(`${use} ${id} 已被冲销单占用（即使内容相同也不接管），整案拒绝`);
      if (this.withdrawals[id] !== undefined)
        throw new BizError(`${use} ${id} 已被方案撤回请求占用（即使内容相同也不接管），整案拒绝`);
    };
    for (const [docId, revId] of req.transferRevs) claim(revId, `调拨子单 ${docId} 的冲销单号`);
    for (const [poId, canId] of req.purchaseCancels) claim(canId, `采购子单 ${poId} 的取消单号`);

    // 撤回条件：各调拨子单须未冲销
    for (const t of plan.transfers) {
      if (this.reversedOrigs.has(t.docId)) {
        let existingRev = '';
        for (const [r, rec] of Object.entries(this.revs)) {
          if (rec.orig === t.docId) {
            existingRev = r;
            break;
          }
        }
        throw new BizError(
          `调拨子单 ${t.docId} 已被冲销单 ${existingRev} 冲销，不满足撤回条件（各调拨子单须未冲销），整案拒绝`,
        );
      }
    }
    // 各采购子单所有商品须全量待收：有效到货与有效取消均为零（当前精确净进度，不核对快照）
    for (const p of plan.purchases) {
      const arrived = this.effectiveArrived(p.poId);
      const cancelled = this.effectiveCancelled(p.poId);
      const po = this.pos[p.poId]!; // 已执行方案的采购子单在加载校验时保证存在
      for (const pid of Object.keys(po.ordered).sort()) {
        const got = arrived[pid] ?? 0n;
        const can = cancelled[pid] ?? 0n;
        if (got !== 0n || can !== 0n)
          throw new BizError(
            `采购子单 ${p.poId} 商品 ${pid} 已非全量待收（有效到货 ${got}，有效取消 ${can}），` +
              `不满足撤回条件，整案拒绝；请先经合法操作恢复全量待收`,
          );
      }
    }

    // 在当前余量上冲销全部调拨（追加普通冲销流水），并取消全部采购的完整订购量
    // （待收归零，不改库存与流水）；任一子单失败整案不留变动
    const lines: string[] = [];
    for (const t of plan.transfers) {
      const revId = req.transferRevs.get(t.docId)!;
      const outcome = this.applyReversal(revId, t.docId);
      lines.push(`调拨子单 ${t.docId} 由冲销单 ${revId} 整单冲销：`, ...outcome.lines);
    }
    for (const p of plan.purchases) {
      const canId = req.purchaseCancels.get(p.poId)!;
      const po = this.pos[p.poId]!; // 已执行方案的采购子单在加载校验时保证存在
      const outcome = this.applyCancel({ canId, poId: p.poId, items: new Map(Object.entries(po.ordered)) });
      lines.push(`采购子单 ${p.poId} 由取消单 ${canId} 取消完整订购量（待收归零，不改库存）：`, ...outcome.lines);
    }

    const transferRevs: Record<string, string> = nullProto();
    for (const [docId, revId] of req.transferRevs) transferRevs[docId] = revId;
    const purchaseCancels: Record<string, string> = nullProto();
    for (const [poId, canId] of req.purchaseCancels) purchaseCancels[poId] = canId;
    const record: PlanWithdrawalRecord = {
      reqId: req.reqId, planId: req.planId, transferRevs, purchaseCancels, resultLines: lines,
    };
    this.withdrawals[req.reqId] = record;
    this.newWithdrawalIds.push(req.reqId);
    this.withdrawnPlanMarks.set(req.planId, req.reqId);

    return { duplicate: false, header: this.withdrawalHeader(record), lines };
  }

  private withdrawalHeader(rec: PlanWithdrawalRecord): string {
    return (
      `撤回请求 ${rec.reqId} 提交成功，撤回补货方案 ${rec.planId}：` +
      `调拨冲销 ${Object.keys(rec.transferRevs).length} 份、采购取消 ${Object.keys(rec.purchaseCancels).length} 份：`
    );
  }

  private repeatedDocSource(docId: string): 'store' | 'batch' {
    return this.base.docs[docId] !== undefined ? 'store' : 'batch';
  }

  /** 整单先校验、模拟，全部合法后才登记到草稿；任一明细失败则整批保持原状。 */
  applyDoc(req: DocRequest): ApplyOutcome {
    const content = canonicalContent(req);
    const existed = this.docs[req.docId];
    if (existed !== undefined) {
      if (stableStringify(existed.content) !== stableStringify(content))
        throw new BizError(`单据编号 ${req.docId} 已用于业务内容不同的单据，拒绝提交`);
      return { duplicate: true, header: this.docHeader(req.docId, existed), lines: existed.resultLines, repeatedFrom: this.repeatedDocSource(req.docId) };
    }
    // 编号空间与出库/入库/调拨/盘点/到货/取消/退货/转单/冲销单共用
    if (this.revs[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于冲销单，拒绝提交`);
    if (this.arrivals[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于取消单，拒绝提交`);
    if (this.returns[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于退货单，拒绝提交`);
    if (this.transfers[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于采购转单，拒绝提交`);
    if (this.withdrawals[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于方案撤回请求，拒绝提交`);

    for (const pid of req.items.keys()) {
      if (this.base.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
    }

    const reportLines: string[] = [];
    const typeLabel = req.type === 'in' ? '入库' : req.type === 'out' ? '出库' : '调拨';

    for (const pid of [...req.items.keys()].sort()) {
      const qty = req.items.get(pid)!;

      if (req.type === 'in') {
        const wh = req.wh!;
        const before = getStock(this.draft, pid, wh);
        const after = before + qty;
        if (after > MAX_SAFE) throw new BizError(`商品 ${pid} 入库后余量超出安全整数范围，拒绝整单`);
        setStock(this.draft, pid, wh, after);
        this.additions.push({ seq: ++this.seq, doc: req.docId, type: 'in', product: pid, wh, qty, before, after });
        reportLines.push(`入库 ${pid} @${wh} +${qty}：${before} -> ${after}`);
      } else if (req.type === 'out') {
        const wh = req.wh!;
        const before = getStock(this.draft, pid, wh);
        if (before < qty)
          throw new BizError(`商品 ${pid} 仓库 ${wh} 余量不足（当前 ${before}，需出库 ${qty}），拒绝整单`);
        const after = before - qty;
        setStock(this.draft, pid, wh, after);
        this.additions.push({ seq: ++this.seq, doc: req.docId, type: 'out', product: pid, wh, qty, before, after });
        reportLines.push(`出库 ${pid} @${wh} -${qty}：${before} -> ${after}`);
      } else {
        const from = req.from!;
        const to = req.to!;
        const beforeFrom = getStock(this.draft, pid, from);
        if (beforeFrom < qty)
          throw new BizError(`商品 ${pid} 调出仓 ${from} 余量不足（当前 ${beforeFrom}，需调拨 ${qty}），拒绝整单`);
        const afterFrom = beforeFrom - qty;
        const beforeTo = getStock(this.draft, pid, to);
        const afterTo = beforeTo + qty;
        if (afterTo > MAX_SAFE) throw new BizError(`商品 ${pid} 调入后余量超出安全整数范围，拒绝整单`);
        setStock(this.draft, pid, from, afterFrom);
        setStock(this.draft, pid, to, afterTo);
        this.additions.push({
          seq: ++this.seq, doc: req.docId, type: 'transfer', product: pid, wh: from,
          qty, before: beforeFrom, after: afterFrom, from, to,
        });
        this.additions.push({
          seq: ++this.seq, doc: req.docId, type: 'transfer', product: pid, wh: to,
          qty, before: beforeTo, after: afterTo, from, to,
        });
        reportLines.push(
          `调拨 ${pid} ${from} -> ${to} ${qty}：${from} ${beforeFrom}->${afterFrom}；${to} ${beforeTo}->${afterTo}`,
        );
      }
    }

    // 全部明细合法：登记到模拟视图；真正落库由 commit 统一完成
    this.docs[req.docId] = { content, resultLines: reportLines };
    this.newDocIds.push(req.docId);

    const header = `${typeLabel}单 ${req.docId} 提交成功，共 ${req.items.size} 种商品：`;
    return { duplicate: false, header, lines: reportLines };
  }

  /**
   * 整单盘点校正：首次提交先逐项核对当前（草稿）余量与预期账面量，任一不符整单拒绝
   * 并说明冲突商品及当前量；全部相符才把列出的商品校正为实盘量（差额 = 实盘 - 账面，
   * 可增、可减、可为零），未列出的商品及其他仓库不变。同编号同内容重放只返回原
   * 结果，即使余量改变或盘点已冲销也不再核对、不再生效。
   */
  applyCount(req: CountRequest): ApplyOutcome {
    const content = canonicalCountContent(req);
    const existed = this.docs[req.docId];
    if (existed !== undefined) {
      if (stableStringify(existed.content) !== stableStringify(content))
        throw new BizError(`单据编号 ${req.docId} 已用于业务内容不同的单据，拒绝提交`);
      return { duplicate: true, header: this.docHeader(req.docId, existed), lines: existed.resultLines, repeatedFrom: this.repeatedDocSource(req.docId) };
    }
    // 编号空间与入库/出库/调拨/到货/取消/退货/转单/冲销单共用
    if (this.revs[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于冲销单，拒绝提交`);
    if (this.arrivals[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于取消单，拒绝提交`);
    if (this.returns[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于退货单，拒绝提交`);
    if (this.transfers[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于采购转单，拒绝提交`);
    if (this.withdrawals[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于方案撤回请求，拒绝提交`);

    const pids = [...req.items.keys()].sort();
    for (const pid of pids) {
      if (this.base.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
    }

    // 账面核对：任一商品的当前余量与预期账面量不符，整单拒绝并说明冲突商品及当前量
    const conflicts: string[] = [];
    for (const pid of pids) {
      const current = getStock(this.draft, pid, req.wh);
      const expected = req.items.get(pid)!.expected;
      if (current !== expected)
        conflicts.push(`商品 ${pid}：当前余量 ${current}，预期账面量 ${expected}`);
    }
    if (conflicts.length > 0)
      throw new BizError(`盘点单 ${req.docId} 账面核对不符，拒绝整单：\n${conflicts.join('\n')}`);

    const reportLines: string[] = [];

    for (const pid of pids) {
      const { expected, actual } = req.items.get(pid)!;
      const before = getStock(this.draft, pid, req.wh); // 核对通过，与预期账面量一致
      const after = actual;
      const diff = actual - expected; // 差额 = 实盘 - 账面，可增、可减、可为零
      setStock(this.draft, pid, req.wh, after);
      this.additions.push({
        seq: ++this.seq, doc: req.docId, type: 'count', product: pid, wh: req.wh,
        expected, actual, diff, before, after,
      });
      reportLines.push(
        `盘点 ${pid} @${req.wh} 账面=${expected} 实盘=${actual} 差额=${fmtSigned(diff)}：${before} -> ${after}`,
      );
    }

    this.docs[req.docId] = { content, resultLines: reportLines };
    this.newDocIds.push(req.docId);

    const header = `盘点单 ${req.docId} 提交成功，仓库 ${req.wh}，共 ${pids.length} 种商品：`;
    return { duplicate: false, header, lines: reportLines };
  }

  /**
   * 整单冲销：在“当前余量”上应用原单的相反变动（不回滚历史、不恢复绝对余量）。
   * 原单可以是导入前已成功的单据，也可以是本批此前已模拟生效的新原单；
   * 冲销单不可冲销，每张原单最多冲销一次。
   */
  applyReversal(revId: string, origId: string): ApplyOutcome {
    const existed = this.revs[revId];
    if (existed !== undefined) {
      if (existed.orig !== origId)
        throw new BizError(
          `冲销单编号 ${revId} 已用于冲销原单 ${existed.orig}，不能改冲原单 ${origId}，拒绝提交`,
        );
      return { duplicate: true, header: this.revHeader(revId, existed), lines: existed.resultLines, repeatedFrom: this.repeatedRevSource(revId) };
    }
    // 冲销单与入库/出库/调拨/盘点/到货/取消/退货/采购转单共用唯一编号空间
    if (this.docs[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是入库/出库/调拨/盘点单编号，不能用作冲销单，拒绝提交`);
    if (this.arrivals[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是到货单编号，不能用作冲销单，拒绝提交`);
    if (this.cancels[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是取消单编号，不能用作冲销单，拒绝提交`);
    if (this.returns[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是退货单编号，不能用作冲销单，拒绝提交`);
    if (this.transfers[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是采购转单编号，不能用作冲销单，拒绝提交`);
    if (this.withdrawals[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是方案撤回请求编号，不能用作冲销单，拒绝提交`);

    // 到货原单：整单冲销到货——从当前收货仓扣回原数量并减少有效到货量，
    // 收齐采购重新待收；不撤销后续业务。到货冲销与库存单冲销分开处理。
    const origArr = this.arrivals[origId];
    if (origArr !== undefined) return this.applyArrivalReversal(revId, origId, origArr);

    // 取消原单：整单冲销取消——移除其有效取消量、恢复相应待收量；
    // 不改库存、不产生库存流水，也不撤销后续业务。
    const origCan = this.cancels[origId];
    if (origCan !== undefined) return this.applyCancelReversal(revId, origId, origCan);

    // 退货原单：整单冲销退货——向原收货仓当前余量补回原退货量、恢复有效到货；
    // 不撤销后续业务。
    const origRet = this.returns[origId];
    if (origRet !== undefined) return this.applyReturnReversal(revId, origId, origRet);

    // 采购转单原单：整单冲销转单——移除原单的有效取消（恢复其待收），
    // 目的单全部订购量计为取消、待收归零；不改库存、不产生库存流水，不撤销后续业务。
    const origTr = this.transfers[origId];
    if (origTr !== undefined) return this.applyTransferReversal(revId, origId, origTr);

    // 只能冲销成功的原始库存单据：不存在（含列表中尚未出现）的原单、冲销单本身均不可冲销
    const origRec = this.docs[origId];
    if (origRec === undefined) {
      if (this.revs[origId] !== undefined)
        throw new BizError(`原单 ${origId} 是冲销单，冲销单不可冲销，拒绝提交`);
      if (this.pos[origId] !== undefined)
        throw new BizError(`原单 ${origId} 是采购单，采购单不可冲销，拒绝提交`);
      if (this.withdrawals[origId] !== undefined)
        throw new BizError(`原单 ${origId} 是方案撤回请求，撤回请求不可冲销，拒绝提交`);
      throw new BizError(`原单 ${origId} 不存在或尚未在本列表中出现，拒绝冲销`);
    }

    if (this.reversedOrigs.has(origId)) {
      let existingRev = '';
      for (const [r, rec] of Object.entries(this.revs)) {
        if (rec.orig === origId) {
          existingRev = r;
          break;
        }
      }
      throw new BizError(`原单 ${origId} 已被冲销单 ${existingRev} 成功冲销，每张原单只能冲销一次`);
    }

    const c = origRec.content;
    const type = c.type as DocType | 'count';
    const items = c.items as Record<string, number>;
    const pids = Object.keys(items).sort();
    const typeLabel = type === 'in' ? '入库' : type === 'out' ? '出库' : type === 'transfer' ? '调拨' : '盘点';
    const revType = `${type}-rev` as EntryType;
    const reportLines: string[] = [];

    for (const pid of pids) {
      if (type === 'count') {
        // 冲销盘点：在当前余量上减去原盘点差额（不恢复原账面绝对值）；零差额不改余量但须记录
        const wh = c.wh as string;
        const item = (c.items as Record<string, { expected: number; actual: number }>)[pid];
        const diff = item.actual - item.expected;
        const before = getStock(this.draft, pid, wh);
        const after = before - diff;
        if (after < 0)
          throw new BizError(
            `冲销盘点原单 ${origId}：商品 ${pid} 仓库 ${wh} 当前余量 ${before} 冲减差额 ${fmtSigned(diff)} 后为负，拒绝整单`,
          );
        if (after > MAX_SAFE)
          throw new BizError(
            `冲销盘点原单 ${origId}：商品 ${pid} 仓库 ${wh} 冲减差额 ${fmtSigned(diff)} 后超出安全整数范围，拒绝整单`,
          );
        setStock(this.draft, pid, wh, after);
        this.additions.push({
          seq: ++this.seq, doc: revId, type: revType, product: pid, wh,
          expected: item.expected, actual: item.actual, diff, before, after, orig: origId,
        });
        reportLines.push(
          `冲销盘点 原单=${origId} 商品=${pid} @${wh} 反向差额=${fmtSigned(-diff)}：${before} -> ${after}`,
        );
        continue;
      }
      const qty = items[pid]; // 原单同商品合并后的数量

      if (type === 'in') {
        // 冲销入库：从原目标仓扣回
        const wh = c.wh as string;
        const before = getStock(this.draft, pid, wh);
        if (before < qty)
          throw new BizError(
            `冲销入库原单 ${origId}：商品 ${pid} 仓库 ${wh} 当前余量 ${before} 不足扣回 ${qty}，拒绝整单`,
          );
        const after = before - qty;
        setStock(this.draft, pid, wh, after);
        this.additions.push({
          seq: ++this.seq, doc: revId, type: revType, product: pid, wh, qty, before, after, orig: origId,
        });
        reportLines.push(`冲销入库 原单=${origId} 商品=${pid} @${wh} -${qty}：${before} -> ${after}`);
      } else if (type === 'out') {
        // 冲销出库：向原来源仓补回
        const wh = c.wh as string;
        const before = getStock(this.draft, pid, wh);
        const after = before + qty;
        if (after > MAX_SAFE)
          throw new BizError(
            `冲销出库原单 ${origId}：商品 ${pid} 仓库 ${wh} 补回后余量超出安全整数范围，拒绝整单`,
          );
        setStock(this.draft, pid, wh, after);
        this.additions.push({
          seq: ++this.seq, doc: revId, type: revType, product: pid, wh, qty, before, after, orig: origId,
        });
        reportLines.push(`冲销出库 原单=${origId} 商品=${pid} @${wh} +${qty}：${before} -> ${after}`);
      } else {
        // 冲销调拨：从原调入仓扣回，向原调出仓补回
        const from = c.from as string;
        const to = c.to as string;
        const beforeTo = getStock(this.draft, pid, to);
        if (beforeTo < qty)
          throw new BizError(
            `冲销调拨原单 ${origId}：商品 ${pid} 原调入仓 ${to} 当前余量 ${beforeTo} 不足扣回 ${qty}，拒绝整单`,
          );
        const afterTo = beforeTo - qty;
        const beforeFrom = getStock(this.draft, pid, from);
        const afterFrom = beforeFrom + qty;
        if (afterFrom > MAX_SAFE)
          throw new BizError(
            `冲销调拨原单 ${origId}：商品 ${pid} 原调出仓 ${from} 补回后余量超出安全整数范围，拒绝整单`,
          );
        setStock(this.draft, pid, to, afterTo);
        setStock(this.draft, pid, from, afterFrom);
        this.additions.push({
          seq: ++this.seq, doc: revId, type: revType, product: pid, wh: to,
          qty, before: beforeTo, after: afterTo, from, to, orig: origId,
        });
        this.additions.push({
          seq: ++this.seq, doc: revId, type: revType, product: pid, wh: from,
          qty, before: beforeFrom, after: afterFrom, from, to, orig: origId,
        });
        reportLines.push(
          `冲销调拨 原单=${origId} 商品=${pid} ${to} -> ${from} ${qty}：` +
            `${to} ${beforeTo}->${afterTo}；${from} ${beforeFrom}->${afterFrom}`,
        );
      }
    }

    // 全部明细合法：登记冲销关系到模拟视图；库存、流水、关系由 commit 一次性落库
    this.revs[revId] = { orig: origId, resultLines: reportLines };
    this.newRevIds.push(revId);
    this.reversedOrigs.add(origId);

    return {
      duplicate: false,
      header: `冲销单 ${revId} 提交成功，冲销${typeLabel}原单 ${origId}，共 ${pids.length} 种商品：`,
      lines: reportLines,
    };
  }

  /**
   * 整单冲销到货：从采购单收货仓的“当前余量”扣回原到货数量，并把该到货单从
   * 有效到货中剔除（采购单相应数量重新待收）；不回滚、不撤销其后发生的其他业务。
   * 任一商品当前余量不足扣回则整单拒绝，不改进度、不登记冲销关系，同号可重试。
   * 每张到货单最多冲销一次；冲销单本身不可冲销。
   */
  private applyArrivalReversal(revId: string, origId: string, origArr: ArrivalRecord): ApplyOutcome {
    if (this.reversedOrigs.has(origId)) {
      let existingRev = '';
      for (const [r, rec] of Object.entries(this.revs)) {
        if (rec.orig === origId) {
          existingRev = r;
          break;
        }
      }
      throw new BizError(`到货原单 ${origId} 已被冲销单 ${existingRev} 成功冲销，每张到货单只能冲销一次`);
    }

    // 有未冲销退货的到货单禁止冲销；相关退货全部冲销后才可按原规则冲销到货
    for (const [retId, ret] of Object.entries(this.returns)) {
      if (ret.arrId === origId && !this.reversedOrigs.has(retId))
        throw new BizError(`到货单 ${origId} 存在未冲销的退货单 ${retId}，禁止冲销；请先冲销全部相关退货`);
    }

    const poId = origArr.poId;
    const wh = origArr.wh;
    const po = this.pos[poId];
    const pids = Object.keys(origArr.qty).sort();
    const reportLines: string[] = [];
    const arrivedBefore = this.effectiveArrived(poId); // 不含本到货单：其尚未被冲销，仍计入
    const cancelledBefore = this.effectiveCancelled(poId); // 未冲销累计取消

    // 先整单校验扣回可行性：任一商品不足则不登记任何变动
    for (const pid of pids) {
      const qty = origArr.qty[pid];
      const before = getStock(this.draft, pid, wh);
      if (before < qty)
        throw new BizError(
          `冲销到货原单 ${origId}：商品 ${pid} 收货仓 ${wh} 当前余量 ${before} 不足扣回 ${qty}，拒绝整单`,
        );
    }

    for (const pid of pids) {
      const qty = origArr.qty[pid];
      const before = getStock(this.draft, pid, wh);
      const after = before - qty;
      setStock(this.draft, pid, wh, after);
      this.additions.push({
        seq: ++this.seq, doc: revId, type: 'arrival-rev', product: pid, wh,
        qty, before, after, po: poId, orig: origId,
      });
      // 冲销后有效到货 = 原有效到货 - 本单数量；待到货相应回升
      const effAfter = (arrivedBefore[pid] ?? 0n) - BigInt(qty);
      const remainingAfter = BigInt(po.ordered[pid]) - effAfter - (cancelledBefore[pid] ?? 0n);
      reportLines.push(
        `冲销到货 原单=${origId} 采购单=${poId} 商品=${pid} @${wh} -${qty}：${before} -> ${after}；有效到货降至 ${effAfter}/${po.ordered[pid]}，待到货 ${remainingAfter}`,
      );
    }

    // 全部商品扣回成功：登记冲销关系（该到货单自此不计入有效到货）；由 commit 一次性落库
    this.revs[revId] = { orig: origId, resultLines: reportLines };
    this.newRevIds.push(revId);
    this.reversedOrigs.add(origId);

    return {
      duplicate: false,
      header: `冲销单 ${revId} 提交成功，冲销到货原单 ${origId}（采购单 ${poId}），共 ${pids.length} 种商品：`,
      lines: reportLines,
    };
  }

  /**
   * 整单冲销取消：把该取消单从有效取消中剔除，相应数量恢复为待到货；
   * 不改库存、不产生库存流水，也不撤销其后发生的其他业务（包括其后的到货与取消）。
   * 每张取消单最多冲销一次；冲销单本身不可冲销。
   */
  private applyCancelReversal(revId: string, origId: string, origCan: CancelRecord): ApplyOutcome {
    if (this.reversedOrigs.has(origId)) {
      let existingRev = '';
      for (const [r, rec] of Object.entries(this.revs)) {
        if (rec.orig === origId) {
          existingRev = r;
          break;
        }
      }
      throw new BizError(`取消原单 ${origId} 已被冲销单 ${existingRev} 成功冲销，每张取消单只能冲销一次`);
    }

    const poId = origCan.poId;
    const po = this.pos[poId];
    const pids = Object.keys(origCan.qty).sort();
    const arrived = this.effectiveArrived(poId); // 未冲销累计到货（不受取消冲销影响）
    const cancelledBefore = this.effectiveCancelled(poId); // 含本取消单：其尚未被冲销，仍计入
    const reportLines: string[] = [];

    for (const pid of pids) {
      const qty = origCan.qty[pid];
      // 冲销后有效取消 = 原有效取消 - 本单数量；待到货相应回升
      const effAfter = (cancelledBefore[pid] ?? 0n) - BigInt(qty);
      const remainingAfter = BigInt(po.ordered[pid]) - (arrived[pid] ?? 0n) - effAfter;
      reportLines.push(
        `冲销取消 原单=${origId} 采购单=${poId} 商品=${pid} 本次恢复取消量 ${qty}：` +
          `有效取消降至 ${effAfter}，待到货 ${remainingAfter}（不改库存）`,
      );
    }

    // 登记冲销关系（该取消单自此不计入有效取消）；由 commit 一次性落库
    this.revs[revId] = { orig: origId, resultLines: reportLines };
    this.newRevIds.push(revId);
    this.reversedOrigs.add(origId);

    return {
      duplicate: false,
      header: `冲销单 ${revId} 提交成功，冲销取消原单 ${origId}（采购单 ${poId}），共 ${pids.length} 种商品：`,
      lines: reportLines,
    };
  }

  /**
   * 整单冲销退货：向原收货仓的“当前余量”补回原退货数量，并把该退货单从有效退货中
   * 剔除（有效到货相应恢复）；不回滚、不撤销其后发生的其他业务。
   * 任一商品补回后余量溢出，或恢复后“有效到货 + 有效取消”超过订购量，整单拒绝、
   * 不改进度、不登记冲销关系，同号可重试。每张退货单最多冲销一次；冲销单本身不可冲销。
   */
  private applyReturnReversal(revId: string, origId: string, origRet: ReturnRecord): ApplyOutcome {
    if (this.reversedOrigs.has(origId)) {
      let existingRev = '';
      for (const [r, rec] of Object.entries(this.revs)) {
        if (rec.orig === origId) {
          existingRev = r;
          break;
        }
      }
      throw new BizError(`退货原单 ${origId} 已被冲销单 ${existingRev} 成功冲销，每张退货单只能冲销一次`);
    }

    const arrId = origRet.arrId;
    const poId = origRet.poId;
    const wh = origRet.wh;
    const po = this.pos[poId];
    const pids = Object.keys(origRet.qty).sort();
    const arrivedEff = this.effectiveArrived(poId); // 含本退货的抵减：其尚未被冲销，仍计入
    const cancelled = this.effectiveCancelled(poId); // 未冲销累计取消

    // 先整单校验：补回不溢出；恢复有效到货后与有效取消合计不得超过订购量
    for (const pid of pids) {
      const qty = origRet.qty[pid];
      const before = getStock(this.draft, pid, wh);
      const after = before + qty;
      if (after > MAX_SAFE)
        throw new BizError(
          `冲销退货原单 ${origId}：商品 ${pid} 原收货仓 ${wh} 补回后余量超出安全整数范围，拒绝整单`,
        );
      const effAfter = (arrivedEff[pid] ?? 0n) + BigInt(qty);
      if (effAfter + (cancelled[pid] ?? 0n) > BigInt(po.ordered[pid]))
        throw new BizError(
          `冲销退货原单 ${origId}：商品 ${pid} 恢复后有效到货 ${effAfter} 与有效取消 ${cancelled[pid] ?? 0n}` +
            ` 合计超过订购量 ${po.ordered[pid]}，拒绝整单`,
        );
    }

    const reportLines: string[] = [];
    for (const pid of pids) {
      const qty = origRet.qty[pid];
      const before = getStock(this.draft, pid, wh);
      const after = before + qty;
      setStock(this.draft, pid, wh, after);
      this.additions.push({
        seq: ++this.seq, doc: revId, type: 'return-rev', product: pid, wh,
        qty, before, after, po: poId, arr: arrId, orig: origId,
      });
      // 冲销后有效到货 = 原有效到货 + 本单退货量；待到货相应回落
      const effAfter = (arrivedEff[pid] ?? 0n) + BigInt(qty);
      const remainingAfter = BigInt(po.ordered[pid]) - effAfter - (cancelled[pid] ?? 0n);
      reportLines.push(
        `冲销退货 原单=${origId} 原到货单=${arrId} 采购单=${poId} 商品=${pid} @${wh} +${qty}：${before} -> ${after}；有效到货回升至 ${effAfter}/${po.ordered[pid]}，待到货 ${remainingAfter}`,
      );
    }

    // 全部商品补回成功：登记冲销关系（该退货单自此不计入有效退货）；由 commit 一次性落库
    this.revs[revId] = { orig: origId, resultLines: reportLines };
    this.newRevIds.push(revId);
    this.reversedOrigs.add(origId);

    return {
      duplicate: false,
      header: `冲销单 ${revId} 提交成功，冲销退货原单 ${origId}（原到货单 ${arrId}，采购单 ${poId}），共 ${pids.length} 种商品：`,
      lines: reportLines,
    };
  }

  /**
   * 统一提交：把草稿余量、新增流水、新单据去重记录、采购单、到货单、取消单、退货单、
   * 冲销关系、方案撤回请求与方案撤回标记写回 base 并原子保存。
   * 全部项均为重复时不写回、不保存（不改写数据）。
   */
  commit(dataDir: string): void {
    if (!this.changed) return;
    this.base.stock = this.draft;
    this.base.entries.push(...this.additions);
    for (const id of this.newDocIds) this.base.docs[id] = this.docs[id];
    for (const id of this.newRevIds) this.base.reversals[id] = this.revs[id];
    for (const id of this.newPoIds) this.base.purchases[id] = this.pos[id];
    for (const id of this.newArrivalIds) this.base.arrivals[id] = this.arrivals[id];
    for (const id of this.newCancelIds) this.base.cancels[id] = this.cancels[id];
    for (const id of this.newReturnIds) this.base.returns[id] = this.returns[id];
    for (const id of this.newTransferIds) this.base.poTransfers[id] = this.transfers[id];
    for (const id of this.newWithdrawalIds) this.base.planWithdrawals[id] = this.withdrawals[id];
    for (const [planId, reqId] of this.withdrawnPlanMarks) this.base.plans[planId].withdrawnBy = reqId;
    saveStore(dataDir, this.base);
  }
}

// ---------- 各命令处理 ----------

function runProduct(rest: string[], dataDir: string, store: Store): void {
  const sub = rest[0];
  const tokens = rest.slice(1);
  if (sub === 'add') {
    const args = parseArgs(tokens, []);
    const [idRaw, nameRaw, ...extra] = args.positionals;
    if (idRaw === undefined || nameRaw === undefined || extra.length > 0)
      throw new UsageError('用法：product add <商品编号> <商品名称>');
    const id = trimOrThrow('商品编号', idRaw);
    const name = trimOrThrow('商品名称', nameRaw);
    if (store.products[id] !== undefined)
      throw new BizError(`商品编号 ${id} 已存在（${store.products[id]}），拒绝重复登记且不覆盖原资料`);
    store.products[id] = name;
    saveStore(dataDir, store);
    console.log(`已登记商品：${id}\t${name}`);
  } else if (sub === 'list' || sub === 'ls') {
    const args = parseArgs(tokens, []);
    if (args.positionals.length > 0) throw new UsageError('用法：product list');
    const ids = Object.keys(store.products).sort();
    console.log(`已登记商品（${ids.length}）：`);
    if (ids.length === 0) {
      console.log('（暂无已登记商品）');
    } else {
      console.log('编号\t名称');
      for (const id of ids) console.log(`${id}\t${store.products[id]}`);
    }
  } else {
    throw new UsageError(sub === undefined ? '用法：product <add|list> …' : `未知 product 子命令：${sub}`);
  }
}

function runBalance(rest: string[], store: Store): void {
  const args = parseArgs(rest, ['--wh']);
  const [pidRaw, ...extra] = args.positionals;
  if (pidRaw === undefined || extra.length > 0) throw new UsageError('用法：balance <商品编号> [--wh <仓库>]');
  const pid = trimOrThrow('商品编号', pidRaw);

  if (args.flags['--wh'] !== undefined) {
    const wh = trimOrThrow('仓库标识', args.flags['--wh']);
    const qty = getStock(store.stock, pid, wh); // 未发生变动的组合余量为 0
    console.log(`余量：商品 ${pid} 仓库 ${wh} = ${qty}`);
    return;
  }

  const map = store.stock[pid] ?? {};
  const whs = Object.keys(map).filter((w) => map[w] !== 0).sort();
  if (whs.length === 0) {
    console.log(`商品 ${pid} 在各仓库余量均为 0`);
    return;
  }
  console.log(`商品 ${pid} 各仓余量：`);
  let total = 0;
  for (const wh of whs) {
    console.log(`仓库 ${wh}：${map[wh]}`);
    total += map[wh];
  }
  console.log(`合计：${total}`);
}

const TYPE_LABEL: Record<EntryType, string> = {
  in: '入库',
  out: '出库',
  transfer: '调拨',
  count: '盘点',
  arrival: '到货',
  return: '退货',
  'in-rev': '冲销入库',
  'out-rev': '冲销出库',
  'transfer-rev': '冲销调拨',
  'count-rev': '冲销盘点',
  'arrival-rev': '冲销到货',
  'return-rev': '冲销退货',
};

function formatEntry(e: LedgerEntry): string {
  let line: string;
  if (e.type === 'count' || e.type === 'count-rev') {
    const applied = e.type === 'count' ? e.diff! : -e.diff!; // 冲销盘点应用反向差额
    line =
      `#${e.seq}\t单据=${e.doc}\t${TYPE_LABEL[e.type]}\t商品=${e.product}\t仓库=${e.wh}` +
      `\t差额=${fmtSigned(applied)}\t${e.before}->${e.after}\t账面=${e.expected}\t实盘=${e.actual}`;
  } else {
    let signed: string;
    // 符号必须与前后余量一致：入库/冲销出库/到货/冲销退货/调入方向为增，其余为减
    const increases =
      e.type === 'in' || e.type === 'out-rev' || e.type === 'arrival' || e.type === 'return-rev' ||
      ((e.type === 'transfer' || e.type === 'transfer-rev') &&
        (e.type === 'transfer') === (e.wh === e.to));
    signed = `${increases ? '+' : '-'}${e.qty}`;
    line = `#${e.seq}\t单据=${e.doc}\t${TYPE_LABEL[e.type]}\t商品=${e.product}\t仓库=${e.wh}\t${signed}\t${e.before}->${e.after}`;
    if (e.type === 'transfer' || e.type === 'transfer-rev') line += `\t调拨=${e.from}->${e.to}`;
    if (e.po !== undefined) line += `\t采购单=${e.po}`;
    if (e.arr !== undefined) line += `\t原到货单=${e.arr}`;
  }
  if (e.orig !== undefined) line += `\t原单=${e.orig}`;
  return line;
}

function runFlow(rest: string[], store: Store): void {
  const args = parseArgs(rest, ['--product', '--wh']);
  if (args.positionals.length > 0) throw new UsageError('用法：flow (--product <商品编号> | --wh <仓库>)…');
  const product = args.flags['--product'];
  const wh = args.flags['--wh'];
  if (product === undefined && wh === undefined)
    throw new UsageError('flow 至少需要一个过滤条件：--product <商品编号> 和/或 --wh <仓库>');
  const pid = product === undefined ? undefined : trimOrThrow('商品编号', product);
  const wid = wh === undefined ? undefined : trimOrThrow('仓库标识', wh);

  const rows = store.entries.filter(
    (e) => (pid === undefined || e.product === pid) && (wid === undefined || e.wh === wid),
  );
  const scope = [pid !== undefined ? `商品=${pid}` : null, wid !== undefined ? `仓库=${wid}` : null]
    .filter(Boolean)
    .join(' ');
  console.log(`流水（${scope}），共 ${rows.length} 条，按提交顺序（冲销流水标注原单编号）：`);
  if (rows.length === 0) console.log('（无匹配流水）');
  else for (const e of rows) console.log(formatEntry(e));

  // 附：范围内原始单据的冲销状态
  const origDocs = new Set(rows.filter((e) => e.orig === undefined).map((e) => e.doc));
  const status: string[] = [];
  for (const docId of [...origDocs].sort()) {
    for (const [revId, rec] of Object.entries(store.reversals)) {
      if (rec.orig === docId) status.push(`原单 ${docId} 已由冲销单 ${revId} 冲销`);
    }
  }
  for (const line of status) console.log(line);
}

// ---------- 期间库存对账报表 ----------

/** 带符号 BigInt 文本：正数加 +，负数保留 -，零为 0。 */
function fmtSignedBig(n: bigint): string {
  return n > 0n ? `+${n}` : String(n);
}

const ENTRY_TYPE_ORDER: EntryType[] = [
  'in', 'out', 'transfer', 'count', 'arrival', 'return',
  'in-rev', 'out-rev', 'transfer-rev', 'count-rev', 'arrival-rev', 'return-rev',
];

/**
 * 出报表前核对完整库存流水（只读核对，不自动修复）：
 * 1) 同一（商品, 仓库）的流水按提交顺序余量连续（上笔后量 = 下笔前量）；
 * 2) 调拨/冲销调拨同一单据同一商品两端完整（调出、调入各一条，数量与方向一致）；
 * 3) 每个组合末笔余量与当前实存一致（双向：有流水无实存、有实存无流水均不允许）。
 * 任一不一致明确报错（数据损坏，退出 1），不输出部分报表。
 */
function verifyLedgerIntegrity(store: Store): void {
  const lastByCombo = new Map<string, LedgerEntry>();
  for (const e of store.entries) {
    const key = JSON.stringify([e.product, e.wh]);
    const prev = lastByCombo.get(key);
    if (prev !== undefined && prev.after !== e.before)
      throw new DataError(
        `库存流水余量不连续：商品 ${e.product} 仓库 ${e.wh} 流水 #${prev.seq} 后余量 ${prev.after}，` +
          `流水 #${e.seq} 前余量 ${e.before}，数据不一致，拒绝输出对账报表（不自动修复）`,
      );
    lastByCombo.set(key, e);
  }
  for (const [key, e] of lastByCombo) {
    const [pid, wh] = JSON.parse(key) as [string, string];
    const cur = getStock(store.stock, pid, wh);
    if (e.after !== cur)
      throw new DataError(
        `商品 ${pid} 仓库 ${wh} 末笔流水 #${e.seq} 余量 ${e.after} 与当前实存 ${cur} 不一致，` +
          `数据不一致，拒绝输出对账报表（不自动修复）`,
      );
  }
  for (const pid of Object.keys(store.stock)) {
    for (const wh of Object.keys(store.stock[pid])) {
      if (store.stock[pid][wh] !== 0 && !lastByCombo.has(JSON.stringify([pid, wh])))
        throw new DataError(
          `商品 ${pid} 仓库 ${wh} 当前实存 ${store.stock[pid][wh]} 没有任何库存流水支撑，` +
            `数据不一致，拒绝输出对账报表（不自动修复）`,
        );
    }
  }
  // 调拨两端完整性：同一单据同一商品的调拨（或冲销调拨）必须调出、调入各一条，数量与方向一致
  const sides = new Map<string, LedgerEntry[]>();
  for (const e of store.entries) {
    if (e.type !== 'transfer' && e.type !== 'transfer-rev') continue;
    const key = JSON.stringify([e.doc, e.product, e.type]);
    const list = sides.get(key);
    if (list === undefined) sides.set(key, [e]);
    else list.push(e);
  }
  for (const [key, list] of sides) {
    const [doc, product, type] = JSON.parse(key) as [string, string, EntryType];
    const label = TYPE_LABEL[type];
    if (list.length !== 2)
      throw new DataError(
        `${label}流水两端不完整：单据 ${doc} 商品 ${product} 只有 ${list.length} 条流水，` +
          `数据不一致，拒绝输出对账报表（不自动修复）`,
      );
    const [a, b] = list;
    const whPair = [a.wh, b.wh].sort();
    const expect = [a.from!, a.to!].sort();
    if (
      a.from !== b.from || a.to !== b.to || a.qty !== b.qty ||
      whPair[0] !== expect[0] || whPair[1] !== expect[1]
    )
      throw new DataError(
        `${label}流水两端不一致：单据 ${doc} 商品 ${product} 的调出/调入仓或数量不符，` +
          `数据不一致，拒绝输出对账报表（不自动修复）`,
      );
  }
}

interface ReconCombo {
  pid: string;
  wh: string;
  begin: number; // 期初余量（起点单据全部流水完成后的状态；无起点为零）
  end: number; // 期末余量（终点单据全部流水完成后；无终点为当前实存）
  inc: bigint; // 期间增加非负合计（精确整数）
  dec: bigint; // 期间减少非负合计（精确整数）
  subtotals: Map<EntryType, bigint>; // 期间内各业务类型（区分是否冲销）带符号净变动
  hasFlow: boolean; // 期间内是否有流水
}

/**
 * 期间库存对账报表（只读：不创建或改写数据、历史结果及关联）。
 * 起点表示该单全部流水完成后的状态（期间不含起点），终点包含该单全部流水；
 * 同一单作两端为空期间；不指定起点从零库存开始，不指定终点截至当前。
 * 边界仅接受已成功且有库存流水的单据（冲销单、零差额盘点可用；只有采购或取消
 * 记录的编号不可用；同名采购单不干扰库存单定位），按首次提交顺序（流水序号）
 * 比较，起点晚于终点或单据不存在拒绝。先确定全局边界再按商品/仓库筛选，
 * 不拆开多商品单据或调拨两端。
 */
function runRecon(rest: string[], store: Store): void {
  const args = parseArgs(rest, ['--from', '--to', '--product', '--wh']);
  if (args.positionals.length > 0)
    throw new UsageError(
      '用法：recon [--from <起点单据编号>] [--to <终点单据编号>] [--product <商品编号>] [--wh <仓库>]',
    );
  const fromId =
    args.flags['--from'] === undefined ? undefined : trimOrThrow('起点单据编号', args.flags['--from']);
  const toId =
    args.flags['--to'] === undefined ? undefined : trimOrThrow('终点单据编号', args.flags['--to']);
  const pid =
    args.flags['--product'] === undefined ? undefined : trimOrThrow('商品编号', args.flags['--product']);
  const wid = args.flags['--wh'] === undefined ? undefined : trimOrThrow('仓库标识', args.flags['--wh']);

  // 出报表前核对完整库存流水；不一致明确报错，不输出部分报表、不自动修复
  verifyLedgerIntegrity(store);

  // 边界定位（全局）：仅接受有库存流水的单据编号；采购编号空间独立，同名采购不干扰定位
  const docLastSeq = nullProto<Record<string, number>>();
  for (const e of store.entries) docLastSeq[e.doc] = e.seq;
  const boundary = (id: string, label: string): number => {
    const seq = docLastSeq[id];
    if (seq !== undefined) return seq;
    if (store.purchases[id] !== undefined)
      throw new BizError(`${label}单据 ${id} 只有采购登记记录，没有库存流水，不能用作期间边界`);
    if (store.cancels[id] !== undefined)
      throw new BizError(`${label}单据 ${id} 只有取消记录，没有库存流水，不能用作期间边界`);
    if (store.poTransfers[id] !== undefined)
      throw new BizError(`${label}单据 ${id} 只有采购转单记录，没有库存流水，不能用作期间边界`);
    if (store.planWithdrawals[id] !== undefined)
      throw new BizError(`${label}单据 ${id} 只有方案撤回请求记录，没有库存流水，不能用作期间边界`);
    if (store.reversals[id] !== undefined) {
      const orig = store.reversals[id].orig;
      if (store.poTransfers[orig] !== undefined)
        throw new BizError(`${label}单据 ${id} 是冲销采购转单的冲销单，没有库存流水，不能用作期间边界`);
      throw new BizError(`${label}单据 ${id} 是冲销取消单的冲销单，没有库存流水，不能用作期间边界`);
    }
    throw new BizError(`${label}单据 ${id} 不存在或没有库存流水，不能用作期间边界`);
  };
  const startBound = fromId === undefined ? 0 : boundary(fromId, '起点');
  const endBound = toId === undefined ? Number.POSITIVE_INFINITY : boundary(toId, '终点');
  if (startBound > endBound)
    throw new BizError(`起点单据 ${fromId} 的提交顺序晚于终点单据 ${toId}，期间无效，拒绝生成报表`);

  // 先确定全局边界，再按商品/仓库筛选；期间 = (起点末笔流水, 终点末笔流水]
  const beginOf = nullProto<Record<string, Record<string, number>>>();
  const endOf = nullProto<Record<string, Record<string, number>>>();
  const combos = new Map<string, ReconCombo>();
  const periodEntries: LedgerEntry[] = [];
  for (const e of store.entries) {
    if (e.seq <= startBound) (beginOf[e.product] ??= nullProto<Record<string, number>>())[e.wh] = e.after;
    if (e.seq <= endBound) (endOf[e.product] ??= nullProto<Record<string, number>>())[e.wh] = e.after;
    const match = (pid === undefined || e.product === pid) && (wid === undefined || e.wh === wid);
    if (!match) continue;
    const key = JSON.stringify([e.product, e.wh]);
    if (e.seq <= endBound && !combos.has(key)) {
      combos.set(key, {
        pid: e.product, wh: e.wh, begin: 0, end: 0,
        inc: 0n, dec: 0n, subtotals: new Map(), hasFlow: false,
      });
    }
    if (e.seq > startBound && e.seq <= endBound) periodEntries.push(e);
  }
  for (const c of combos.values()) {
    c.begin = beginOf[c.pid]?.[c.wh] ?? 0;
    c.end = endOf[c.pid]?.[c.wh] ?? 0;
  }
  for (const e of periodEntries) {
    const c = combos.get(JSON.stringify([e.product, e.wh]))!;
    c.hasFlow = true;
    const delta = BigInt(e.after) - BigInt(e.before);
    if (delta > 0n) c.inc += delta;
    else c.dec += -delta;
    c.subtotals.set(e.type, (c.subtotals.get(e.type) ?? 0n) + delta);
  }

  // 原单冲销状态以终点时刻为准：终点之后的冲销不影响历史报表
  const revLastSeq = nullProto<Record<string, number>>();
  for (const e of store.entries) if (REV_ENTRY_TYPES.has(e.type)) revLastSeq[e.doc] = e.seq;
  const reversedByEnd = nullProto<Record<string, string>>();
  for (const [revId, rec] of Object.entries(store.reversals)) {
    const seq = revLastSeq[revId];
    if (seq !== undefined && seq <= endBound) reversedByEnd[rec.orig] = revId;
  }

  const fromDesc = fromId === undefined ? '零库存（无起点）' : `单据 ${fromId} 全部流水完成后（不含该单）`;
  const toDesc = toId === undefined ? '当前（无终点）' : `单据 ${toId} 全部流水完成后（含该单）`;
  const scope = [pid !== undefined ? `商品=${pid}` : null, wid !== undefined ? `仓库=${wid}` : null]
    .filter(Boolean)
    .join(' ');
  console.log('期间库存对账报表：');
  console.log(`期间：起点=${fromDesc}；终点=${toDesc}`);
  console.log(scope === '' ? '筛选：无（覆盖全库）' : `筛选：${scope}`);
  console.log(
    `数据核对通过：完整流水 ${store.entries.length} 条余量连续、调拨两端完整、末笔余量与当前实存一致`,
  );

  // 展示期初或期末非零及期间有流水的组合，按商品、仓库标识升序
  const shown = [...combos.values()]
    .filter((c) => c.begin !== 0 || c.end !== 0 || c.hasFlow)
    .sort((a, b) =>
      a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : a.wh < b.wh ? -1 : a.wh > b.wh ? 1 : 0,
    );
  if (shown.length === 0) {
    console.log('（无匹配组合：所选范围内期初、期末均为零且期间无流水）');
  }
  for (const c of shown) {
    const net = c.inc - c.dec;
    if (BigInt(c.begin) + net !== BigInt(c.end))
      throw new DataError(
        `商品 ${c.pid} 仓库 ${c.wh} 期初 ${c.begin} + 净变动 ${net} 与期末 ${c.end} 不符，` +
          `数据不一致，拒绝输出对账报表（不自动修复）`,
      );
    console.log(
      `组合 商品=${c.pid} 仓库=${c.wh}：期初 ${c.begin}，期间增加 ${c.inc}，期间减少 ${c.dec}，` +
        `净变动 ${fmtSignedBig(net)}，期末 ${c.end}（期初 + 增加 - 减少 = 期末）`,
    );
    const parts: string[] = [];
    for (const t of ENTRY_TYPE_ORDER) {
      const v = c.subtotals.get(t);
      if (v !== undefined) parts.push(`${TYPE_LABEL[t]} ${fmtSignedBig(v)}`);
    }
    console.log(parts.length === 0 ? '  业务小计：（期间无流水）' : `  业务小计：${parts.join('；')}`);
  }

  // 期间匹配流水按提交顺序列出（含采购、原到货及冲销关联）
  console.log(`期间流水（${periodEntries.length} 条，按提交顺序）：`);
  if (periodEntries.length === 0) console.log('（无期间流水）');
  else for (const e of periodEntries) console.log(formatEntry(e));
  const origDocs = new Set(periodEntries.filter((e) => e.orig === undefined).map((e) => e.doc));
  for (const docId of [...origDocs].sort()) {
    const revId = reversedByEnd[docId];
    if (revId !== undefined) console.log(`原单 ${docId} 已由冲销单 ${revId} 冲销（以终点时刻为准）`);
  }

  // 逐商品汇总所选仓库（精确整数累计，超安全整数仍完整十进制显示）
  if (shown.length > 0) {
    const byProduct = new Map<string, { begin: bigint; inc: bigint; dec: bigint; end: bigint; whs: Set<string> }>();
    for (const c of shown) {
      const s = byProduct.get(c.pid) ?? { begin: 0n, inc: 0n, dec: 0n, end: 0n, whs: new Set<string>() };
      s.begin += BigInt(c.begin);
      s.inc += c.inc;
      s.dec += c.dec;
      s.end += BigInt(c.end);
      s.whs.add(c.wh);
      byProduct.set(c.pid, s);
    }
    console.log('逐商品汇总（所选仓库范围）：');
    for (const [pid2, s] of [...byProduct.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const whList = [...s.whs].sort().join('、');
      console.log(
        `商品 ${pid2}（仓库：${whList}）：期初 ${s.begin}，期间增加 ${s.inc}，期间减少 ${s.dec}，` +
          `净变动 ${fmtSignedBig(s.inc - s.dec)}，期末 ${s.end}`,
      );
    }
  }
}

function runReverse(rest: string[], dataDir: string, store: Store): void {
  const { revId, origId } = parseReverseArgs(rest);
  const ledger = new Ledger(store);
  const outcome = ledger.applyReversal(revId, origId);
  ledger.commit(dataDir);
  if (outcome.duplicate) {
    console.log(
      `冲销单 ${revId} 为重复提交，原单为 ${origId}，返回原冲销结果（库存与流水不再变动）：`,
    );
  } else {
    console.log(outcome.header);
  }
  for (const line of outcome.lines) console.log(line);
}

/**
 * 计算采购单各商品的有效到货（未冲销到货-未冲销退货）、有效退货、有效取消与待到货量。
 * 有效取消含两部分采购转单效应：本单作为原单由未冲销转单转出的量；
 * 本单作为目的单且来源转单已冲销时的全部订购量（目的单整单关闭、待收归零）。
 * 累计总量可超过安全整数范围（反复退货、补收），一律用 BigInt 精确累计，
 * 合计与记录枚举顺序无关；有效退货合计即使超过安全整数范围也能完整显示。
 */
function purchaseProgress(store: Store, poId: string): {
  effective: Record<string, bigint>;
  returned: Record<string, bigint>;
  cancelled: Record<string, bigint>;
  remaining: Record<string, bigint>;
} {
  const revOfOrig = nullProto<Record<string, string>>();
  for (const [revId, rec] of Object.entries(store.reversals)) revOfOrig[rec.orig] = revId;
  const effective = nullProto<Record<string, bigint>>();
  for (const [arrId, arr] of Object.entries(store.arrivals)) {
    if (arr.poId !== poId || revOfOrig[arrId] !== undefined) continue;
    for (const [pid, q] of Object.entries(arr.qty)) effective[pid] = (effective[pid] ?? 0n) + BigInt(q);
  }
  const returned = nullProto<Record<string, bigint>>();
  for (const [retId, ret] of Object.entries(store.returns)) {
    if (ret.poId !== poId || revOfOrig[retId] !== undefined) continue;
    for (const [pid, q] of Object.entries(ret.qty)) {
      returned[pid] = (returned[pid] ?? 0n) + BigInt(q);
      effective[pid] = (effective[pid] ?? 0n) - BigInt(q); // 未冲销退货抵减有效到货
    }
  }
  const cancelled = nullProto<Record<string, bigint>>();
  for (const [canId, can] of Object.entries(store.cancels)) {
    if (can.poId !== poId || revOfOrig[canId] !== undefined) continue;
    for (const [pid, q] of Object.entries(can.qty)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
  }
  const po = store.purchases[poId];
  // 转出：本单作为原单由未冲销转单转出的量计入有效取消
  for (const t of Object.values(store.poTransfers)) {
    if (t.origPo !== poId || revOfOrig[t.tId] !== undefined) continue;
    for (const [pid, q] of Object.entries(t.qty)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
  }
  // 目的单的来源转单已冲销：全部订购量计为取消、待收归零
  if (po.fromTransfer !== undefined && revOfOrig[po.fromTransfer] !== undefined) {
    for (const [pid, q] of Object.entries(po.ordered)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
  }
  const remaining = nullProto<Record<string, bigint>>();
  for (const [pid, ordered] of Object.entries(po.ordered)) {
    remaining[pid] = BigInt(ordered) - (effective[pid] ?? 0n) - (cancelled[pid] ?? 0n);
  }
  return { effective, returned, cancelled, remaining };
}

/**
 * 单商品采购状态。无取消时保持原有展示（未到货/部分到货/收齐）；
 * 有取消时区分仍待收与已结清：待到货为零但含取消的结清不报“收齐”，
 * 取消永远不计作到货。进度量以 BigInt 精确比较。
 */
function poStatus(ordered: number, effective: bigint, cancelled = 0n): string {
  const remaining = BigInt(ordered) - effective - cancelled;
  if (cancelled === 0n) {
    if (effective === 0n) return '未到货';
    if (remaining > 0n) return '部分到货';
    return '收齐';
  }
  if (remaining > 0n) return effective === 0n ? '未到货（仍待收）' : '部分到货（仍待收）';
  return effective === BigInt(ordered) ? '收齐' : '已结清（含取消）';
}

function printPurchase(store: Store, poId: string, po: PurchaseRecord): void {
  const { effective, returned, cancelled, remaining } = purchaseProgress(store, poId);
  const revOfOrig = nullProto<Record<string, string>>();
  for (const [revId, rec] of Object.entries(store.reversals)) revOfOrig[rec.orig] = revId;
  // 该采购单是否存在取消/退货/转单记录（含已冲销）：无相关记录的采购单展示行为保持不变
  const cancelIds = Object.keys(store.cancels)
    .filter((id) => store.cancels[id].poId === poId)
    .sort();
  const hasCancels = cancelIds.length > 0;
  const returnIds = Object.keys(store.returns)
    .filter((id) => store.returns[id].poId === poId)
    .sort();
  const hasReturns = returnIds.length > 0;
  // 本单作为原单的转出记录、作为目的单的转入记录
  const outTransferIds = Object.keys(store.poTransfers)
    .filter((id) => store.poTransfers[id].origPo === poId)
    .sort();
  const inTransferId = po.fromTransfer;
  const hasTransfers = outTransferIds.length > 0 || inTransferId !== undefined;

  const origin =
    inTransferId !== undefined
      ? `（由采购转单 ${inTransferId} 自原采购单 ${store.poTransfers[inTransferId]?.origPo ?? '?'} 转入创建）`
      : '';
  console.log(`采购单 ${poId}：供应商 ${po.supplier}，收货仓 ${po.wh}，共 ${Object.keys(po.ordered).length} 种商品${origin}`);
  const cols = ['商品', '订购', '有效到货'];
  if (hasReturns) cols.push('有效退货');
  if (hasCancels || hasTransfers) cols.push('有效取消');
  cols.push('待到货', '状态');
  console.log(cols.join('\t'));
  for (const pid of Object.keys(po.ordered).sort()) {
    const ordered = po.ordered[pid];
    const got = effective[pid] ?? 0n;
    const ret = returned[pid] ?? 0n;
    const can = cancelled[pid] ?? 0n;
    const wait = remaining[pid];
    // BigInt 直接插值：超过安全整数范围的合计仍显示完整十进制整数
    const row: (string | number | bigint)[] = [pid, ordered, got];
    if (hasReturns) row.push(ret);
    if (hasCancels || hasTransfers) row.push(can);
    row.push(wait, poStatus(ordered, got, can));
    console.log(row.join('\t'));
  }

  // 到货/冲销关联
  const links: string[] = [];
  for (const arrId of Object.keys(store.arrivals).sort()) {
    const arr = store.arrivals[arrId];
    if (arr.poId !== poId) continue;
    let revId = '';
    for (const [r, rec] of Object.entries(store.reversals)) {
      if (rec.orig === arrId) {
        revId = r;
        break;
      }
    }
    const detail = Object.keys(arr.qty)
      .sort()
      .map((pid) => `${pid} x${arr.qty[pid]}`)
      .join('，');
    links.push(
      revId === ''
        ? `到货单 ${arrId}（有效）：${detail}`
        : `到货单 ${arrId}（已由冲销单 ${revId} 整单冲销，不计入有效到货）：${detail}`,
    );
  }
  if (links.length > 0) {
    console.log('到货记录：');
    for (const l of links) console.log(`  ${l}`);
  } else {
    console.log('到货记录：（暂无）');
  }

  // 取消/冲销关联（仅存在取消记录时展示；取消只减少待收承诺，不计作到货）
  if (hasCancels) {
    const cancelLinks: string[] = [];
    for (const canId of cancelIds) {
      const can = store.cancels[canId];
      let revId = '';
      for (const [r, rec] of Object.entries(store.reversals)) {
        if (rec.orig === canId) {
          revId = r;
          break;
        }
      }
      const detail = Object.keys(can.qty)
        .sort()
        .map((pid) => `${pid} x${can.qty[pid]}`)
        .join('，');
      cancelLinks.push(
        revId === ''
          ? `取消单 ${canId}（有效）：${detail}`
          : `取消单 ${canId}（已由冲销单 ${revId} 整单冲销，不计入有效取消）：${detail}`,
      );
    }
    console.log('取消记录：');
    for (const l of cancelLinks) console.log(`  ${l}`);
  }

  // 退货/冲销关联（仅存在退货记录时展示；退货抵减有效到货，退回数量等待补收）
  if (hasReturns) {
    console.log('退货记录：');
    for (const retId of returnIds) {
      const ret = store.returns[retId];
      let revId = '';
      for (const [r, rec] of Object.entries(store.reversals)) {
        if (rec.orig === retId) {
          revId = r;
          break;
        }
      }
      const detail = Object.keys(ret.qty)
        .sort()
        .map((pid) => `${pid} x${ret.qty[pid]}`)
        .join('，');
      console.log(
        revId === ''
          ? `  退货单 ${retId}（有效）：原到货单 ${ret.arrId}，${detail}`
          : `  退货单 ${retId}（已由冲销单 ${revId} 整单冲销，不计入有效退货）：原到货单 ${ret.arrId}，${detail}`,
      );
    }
  }

  // 采购转单关联：本单作为原单的转出、作为目的单的转入，及其冲销单
  if (hasTransfers) {
    console.log('采购转单记录：');
    if (inTransferId !== undefined) {
      const t = store.poTransfers[inTransferId];
      const revId = revOfOrig[inTransferId] ?? '';
      const detail = Object.keys(t.qty)
        .sort()
        .map((pid) => `${pid} x${t.qty[pid]}`)
        .join('，');
      console.log(
        revId === ''
          ? `  转入（本单为目的单）转单 ${inTransferId}：自原采购单 ${t.origPo}，供应商 ${t.supplier}，收货仓 ${t.wh}，${detail}`
          : `  转入（本单为目的单）转单 ${inTransferId}（已由冲销单 ${revId} 整单冲销：本单全部订购量计为取消、待收归零）：自原采购单 ${t.origPo}，${detail}`,
      );
    }
    for (const tId of outTransferIds) {
      const t = store.poTransfers[tId];
      const revId = revOfOrig[tId] ?? '';
      const detail = Object.keys(t.qty)
        .sort()
        .map((pid) => `${pid} x${t.qty[pid]}`)
        .join('，');
      console.log(
        revId === ''
          ? `  转出（本单为原单）转单 ${tId}：至目的采购单 ${t.destPo}，供应商 ${t.supplier}，收货仓 ${t.wh}，${detail}（转出量计入本单有效取消）`
          : `  转出（本单为原单）转单 ${tId}（已由冲销单 ${revId} 整单冲销：转出量已移回本单待收）：至目的采购单 ${t.destPo}，${detail}`,
      );
    }
  }
}

function runPo(rest: string[], dataDir: string, store: Store): void {
  const sub = rest[0];
  const tokens = rest.slice(1);
  if (sub === 'register') {
    const req = parsePurchaseArgs(tokens);
    const ledger = new Ledger(store);
    const outcome = ledger.applyPurchase(req);
    ledger.commit(dataDir);
    if (outcome.duplicate) {
      console.log(`采购单 ${req.poId} 为重复登记，内容与原登记一致，返回原登记结果（不重置到货进度、不改库存）：`);
    } else {
      console.log(outcome.header);
    }
    for (const line of outcome.lines) console.log(line);
    return;
  }
  if (sub === 'show') {
    const args = parseArgs(tokens, []);
    const [poRaw, ...extra] = args.positionals;
    if (poRaw === undefined || extra.length > 0) throw new UsageError('用法：po show <采购编号>');
    const poId = trimOrThrow('采购编号', poRaw);
    const po = store.purchases[poId];
    if (po === undefined) throw new BizError(`采购单 ${poId} 不存在`);
    printPurchase(store, poId, po);
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const args = parseArgs(tokens, []);
    if (args.positionals.length > 0) throw new UsageError('用法：po list');
    const ids = Object.keys(store.purchases).sort();
    console.log(`采购单（${ids.length}）：`);
    if (ids.length === 0) {
      console.log('（暂无采购单）');
      return;
    }
    for (const poId of ids) {
      const po = store.purchases[poId];
      const { cancelled, remaining } = purchaseProgress(store, poId);
      const pids = Object.keys(po.ordered).sort();
      const anyCancelled = pids.some((pid) => (cancelled[pid] ?? 0n) > 0n);
      // 单张采购单汇总状态：全部结清（待到货为零）时，无取消为收齐、含取消为已结清；
      // 全部仍完全待到货为未到货；否则部分到货。无取消采购的展示行为保持不变。
      let overall: string;
      if (pids.every((pid) => remaining[pid] === 0n)) overall = anyCancelled ? '已结清（含取消）' : '收齐';
      else if (pids.every((pid) => remaining[pid] === BigInt(po.ordered[pid]))) overall = '未到货';
      else overall = '部分到货';
      console.log(`${poId}\t供应商=${po.supplier}\t收货仓=${po.wh}\t${Object.keys(po.ordered).length} 种商品\t${overall}`);
    }
    return;
  }
  throw new UsageError(sub === undefined ? '用法：po <register|show|list> …' : `未知 po 子命令：${sub}`);
}

// ---------- 补货规则与跨仓补货建议 ----------

/**
 * 补货规则维护：set 设置（同组合再次设置整体替换）、list 查看、delete 删除。
 * 规则按（商品, 仓库）唯一；商品必须已登记，仓库无需登记；
 * 下限与目标均为非负安全整数且下限小于目标。规则随数据文件原子保存，
 * 保存成功后才报告成功，失败保留已提交状态。
 */
function runRule(rest: string[], dataDir: string, store: Store): void {
  const sub = rest[0];
  const tokens = rest.slice(1);
  if (sub === 'set') {
    const args = parseArgs(tokens, ['--wh', '--min', '--target']);
    const [pidRaw, ...extra] = args.positionals;
    if (pidRaw === undefined || extra.length > 0)
      throw new UsageError('用法：rule set <商品编号> --wh <仓库> --min <下限> --target <目标>');
    if (args.flags['--wh'] === undefined) throw new UsageError('补货规则必须提供 --wh <仓库>');
    if (args.flags['--min'] === undefined) throw new UsageError('补货规则必须提供 --min <下限>');
    if (args.flags['--target'] === undefined) throw new UsageError('补货规则必须提供 --target <目标>');
    const pid = trimOrThrow('商品编号', pidRaw);
    const wh = trimOrThrow('仓库标识', args.flags['--wh']);
    const min = parseNonNegInt('下限', args.flags['--min']);
    const target = parseNonNegInt('目标', args.flags['--target']);
    if (min >= target) throw new BizError(`下限 ${min} 必须小于目标 ${target}，拒绝设置`);
    if (store.products[pid] === undefined) throw new BizError(`商品未登记，拒绝设置补货规则：${pid}`);
    const byWh = (store.rules[pid] ??= nullProto<Record<string, ReplenishRule>>());
    const replaced = byWh[wh] !== undefined;
    byWh[wh] = { min, target }; // 同组合再次设置：整体替换原规则
    saveStore(dataDir, store);
    console.log(
      replaced
        ? `已替换补货规则：商品 ${pid} 仓库 ${wh}，下限 ${min}，目标 ${target}（原规则已整体替换）`
        : `已设置补货规则：商品 ${pid} 仓库 ${wh}，下限 ${min}，目标 ${target}`,
    );
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const args = parseArgs(tokens, []);
    if (args.positionals.length > 0) throw new UsageError('用法：rule list');
    const pids = Object.keys(store.rules).sort();
    const total = pids.reduce((n, p) => n + Object.keys(store.rules[p]).length, 0);
    console.log(`补货规则（${total}）：`);
    if (total === 0) {
      console.log('（暂无补货规则）');
      return;
    }
    console.log('商品\t仓库\t下限\t目标');
    for (const pid of pids) {
      for (const wh of Object.keys(store.rules[pid]).sort()) {
        const r = store.rules[pid][wh];
        console.log(`${pid}\t${wh}\t${r.min}\t${r.target}`);
      }
    }
    return;
  }
  if (sub === 'delete' || sub === 'del') {
    const args = parseArgs(tokens, ['--wh']);
    const [pidRaw, ...extra] = args.positionals;
    if (pidRaw === undefined || extra.length > 0)
      throw new UsageError('用法：rule delete <商品编号> --wh <仓库>');
    if (args.flags['--wh'] === undefined) throw new UsageError('删除补货规则必须提供 --wh <仓库>');
    const pid = trimOrThrow('商品编号', pidRaw);
    const wh = trimOrThrow('仓库标识', args.flags['--wh']);
    const byWh = store.rules[pid];
    if (byWh === undefined || byWh[wh] === undefined)
      throw new BizError(`商品 ${pid} 仓库 ${wh} 的补货规则不存在，无法删除`);
    const removed = byWh[wh];
    delete byWh[wh];
    if (Object.keys(byWh).length === 0) delete store.rules[pid]; // 不留下空商品条目
    saveStore(dataDir, store);
    console.log(`已删除补货规则：商品 ${pid} 仓库 ${wh}（原下限 ${removed.min}，目标 ${removed.target}）`);
    return;
  }
  throw new UsageError(sub === undefined ? '用法：rule <set|list|delete> …' : `未知 rule 子命令：${sub}`);
}

interface ReplenishSuggestion {
  pid: string;
  wh: string;
  min: number;
  target: number;
  onHand: number; // 本仓实存（非负安全整数）
  pending: bigint; // 本仓待到货合计（精确整数，可超安全整数范围）
  projected: bigint; // 预计量 = 实存 + 待到货合计
  triggered: boolean; // 预计量不高于下限才触发
  gap: bigint; // 缺口 = 目标 - 预计量（仅触发时为正）
  transfers: { from: string; qty: bigint }[]; // 各调拨来源及数量（来源仓升序）
  transferTotal: bigint; // 调拨合计
  purchase: bigint; // 采购量 = 调拨后剩余缺口（可为零）
}

/**
 * 各（商品, 仓库）组合的待到货合计：按采购单收货仓归集（不限供应商），
 * 待到货 = 订购 - 有效到货 - 有效取消；BigInt 精确累计，超安全整数合计不舍入。
 * 补货建议与方案快照/核对共用同一计算，保证口径一致。
 */
function pendingTotals(store: Store): Record<string, Record<string, bigint>> {
  const pendingByCombo = nullProto<Record<string, Record<string, bigint>>>();
  for (const poId of Object.keys(store.purchases)) {
    const po = store.purchases[poId];
    const { remaining } = purchaseProgress(store, poId); // 待到货 = 订购 - 有效到货 - 有效取消
    for (const [pid, wait] of Object.entries(remaining)) {
      if (wait === 0n) continue;
      const byWh = (pendingByCombo[pid] ??= nullProto<Record<string, bigint>>());
      byWh[po.wh] = (byWh[po.wh] ?? 0n) + wait;
    }
  }
  return pendingByCombo;
}

/**
 * 跨仓补货建议（只读计算，不写文件、不改库存或采购；同状态结果一致）：
 * 每个已配置（商品, 仓库）组合的预计量 = 本仓实存 + 本仓待到货合计
 * （收货仓为本仓的全部采购单：待到货 = 订购 - 有效到货 - 有效取消，不限供应商；
 * 其他仓库存不计入）。预计量不高于下限才触发，缺口 = 目标 - 预计量。
 * 按商品分别分配：同商品其他已配置仓实存超过自身目标的部分可供调拨（待收不可调，
 * 未配置仓既不产生需求也不提供调拨）；缺货仓、来源仓各按标识升序依次取量，
 * 整份建议对来源的累计分配不超过可供量；剩余缺口即采购量。
 * 合计、比较与分配一律用 BigInt 精确整数计算。
 */
function computeReplenish(store: Store): ReplenishSuggestion[] {
  // 各（商品, 仓库）组合的待到货合计：按采购单收货仓归集（不限供应商）
  const pendingByCombo = pendingTotals(store);

  const combos: ReplenishSuggestion[] = [];
  for (const pid of Object.keys(store.rules).sort()) {
    for (const wh of Object.keys(store.rules[pid]).sort()) {
      const rule = store.rules[pid][wh];
      const onHand = getStock(store.stock, pid, wh); // 无库存记录视为零
      const pending = pendingByCombo[pid]?.[wh] ?? 0n;
      const projected = BigInt(onHand) + pending;
      const triggered = projected <= BigInt(rule.min); // 不高于下限才触发
      combos.push({
        pid, wh, min: rule.min, target: rule.target, onHand, pending, projected,
        triggered, gap: triggered ? BigInt(rule.target) - projected : 0n,
        transfers: [], transferTotal: 0n, purchase: 0n,
      });
    }
  }

  // 按商品分别分配调拨：缺货仓与来源仓均按标识升序（combos 已按商品、仓库升序）
  const byProduct = new Map<string, ReplenishSuggestion[]>();
  for (const c of combos) {
    const list = byProduct.get(c.pid) ?? [];
    list.push(c);
    byProduct.set(c.pid, list);
  }
  for (const list of byProduct.values()) {
    // 可供调拨量 = 实存 - 自身目标（仅实存超过目标的部分；待收不可调）
    const sources = list
      .filter((c) => BigInt(c.onHand) > BigInt(c.target))
      .map((c) => ({ wh: c.wh, available: BigInt(c.onHand) - BigInt(c.target) }));
    for (const deficit of list) {
      if (!deficit.triggered) continue;
      let rest = deficit.gap;
      for (const src of sources) {
        if (rest === 0n) break;
        if (src.wh === deficit.wh || src.available === 0n) continue; // 缺货仓实存必低于目标，防御性跳过
        const take = src.available < rest ? src.available : rest;
        deficit.transfers.push({ from: src.wh, qty: take });
        deficit.transferTotal += take;
        src.available -= take; // 整份建议对来源的累计分配不超过可供量
        rest -= take;
      }
      deficit.purchase = rest; // 剩余缺口即采购量（可为零）
    }
  }
  return combos;
}

function runReplenish(rest: string[], store: Store): void {
  const args = parseArgs(rest, []);
  if (args.positionals.length > 0) throw new UsageError('用法：replenish');
  if (Object.keys(store.rules).length === 0) {
    console.log('未配置任何补货规则，无补货建议（可先用 rule set 为商品与仓库设置下限与目标）。');
    return;
  }
  const combos = computeReplenish(store);
  const triggeredCount = combos.filter((c) => c.triggered).length;
  console.log(`补货建议（规则 ${combos.length} 条，触发 ${triggeredCount} 条）：`);
  for (const c of combos) {
    console.log(
      `商品 ${c.pid} 仓库 ${c.wh}：下限 ${c.min}，目标 ${c.target}，实存 ${c.onHand}，` +
        `待到货合计 ${c.pending}，预计量 ${c.projected}，` +
        (c.triggered ? `触发补货，缺口 ${c.gap}` : '未触发'),
    );
    if (c.triggered) {
      for (const t of c.transfers) console.log(`  调拨 ${t.from} -> ${c.wh}：${t.qty}`);
      console.log(`  调拨合计 ${c.transferTotal}，采购量 ${c.purchase}`);
    }
  }
  if (triggeredCount === 0) console.log('所有组合预计量均高于下限，无缺货，无需补货。');
}

// ---------- 补货方案：保存、查看与一次性落单 ----------

interface PlanSaveSpec {
  planId: string;
  transfers: { product: string; from: string; to: string; docId: string }[];
  purchases: { product: string; wh: string; poId: string; supplier: string }[];
}

/** 方案保存输入的规范化串：明细顺序无关，用于同号重放比较。 */
function canonicalPlanSpec(spec: {
  transfers: { product: string; from: string; to: string; docId: string }[];
  purchases: { product: string; wh: string; poId: string; supplier: string }[];
}): string {
  const t = spec.transfers.map((x) => [x.product, x.from, x.to, x.docId]).sort();
  const p = spec.purchases.map((x) => [x.product, x.wh, x.poId, x.supplier]).sort();
  return stableStringify({ t, p });
}

function canonicalPlanSpecOf(plan: PlanRecord): string {
  return canonicalPlanSpec({
    transfers: plan.transfers.map((t) => ({ product: t.product, from: t.from, to: t.to, docId: t.docId })),
    purchases: plan.purchases.map((p) => ({ product: p.product, wh: p.wh, poId: p.poId, supplier: p.supplier })),
  });
}

interface WithdrawRequest {
  reqId: string; // 撤回请求编号（与库存/到货/取消/退货/转单/冲销单共用编号空间）
  planId: string; // 被撤回的方案编号
  transferRevs: Map<string, string>; // 调拨子单编号 -> 冲销单号（逐一对应，顺序无关）
  purchaseCancels: Map<string, string>; // 采购子单编号 -> 取消单号（逐一对应，顺序无关）
}

/** 子单映射比较：键集合与逐键取值均一致（与输入顺序无关）。 */
function sameStringMapping(rec: Record<string, string>, input: Map<string, string>): boolean {
  const keys = Object.keys(rec);
  if (keys.length !== input.size) return false;
  for (const k of keys) {
    if (input.get(k) !== rec[k]) return false;
  }
  return true;
}

/**
 * 解析 plan withdraw 参数。标识去首尾空白后非空、区分大小写；
 * 缺参数、映射段格式不对属于用法错误（退出 2）；同一子单重复指定属于业务拒绝（退出 1）。
 * 映射段格式为 “子单编号:新单号”，按首个冒号切分，新单号可含冒号。
 */
function parsePlanWithdrawArgs(tokens: string[]): WithdrawRequest {
  const args = parseArgs(tokens, ['--plan'], ['--transfer-rev', '--purchase-cancel']);
  const [reqRaw, ...extra] = args.positionals;
  if (reqRaw === undefined || extra.length > 0)
    throw new UsageError(
      '用法：plan withdraw <请求编号> --plan <方案编号> ' +
        '--transfer-rev <调拨子单编号>:<冲销单号> [...] --purchase-cancel <采购子单编号>:<取消单号> [...]',
    );
  if (args.flags['--plan'] === undefined) throw new UsageError('撤回必须提供 --plan <方案编号>');

  const parseMapping = (raw: string, keyLabel: string, valueLabel: string): [string, string] => {
    const idx = raw.indexOf(':');
    if (idx <= 0) throw new UsageError(`映射格式应为 “${keyLabel}:${valueLabel}”：${raw}`);
    const key = trimOrThrow(keyLabel, raw.slice(0, idx));
    const value = trimOrThrow(valueLabel, raw.slice(idx + 1));
    return [key, value];
  };

  const transferRevs = new Map<string, string>();
  for (const raw of args.multi['--transfer-rev'] ?? []) {
    const [docId, revId] = parseMapping(raw, '调拨子单编号', '冲销单号');
    if (transferRevs.has(docId)) throw new BizError(`调拨子单 ${docId} 的冲销单号重复指定，拒绝撤回`);
    transferRevs.set(docId, revId);
  }
  const purchaseCancels = new Map<string, string>();
  for (const raw of args.multi['--purchase-cancel'] ?? []) {
    const [poId, canId] = parseMapping(raw, '采购子单编号', '取消单号');
    if (purchaseCancels.has(poId)) throw new BizError(`采购子单 ${poId} 的取消单号重复指定，拒绝撤回`);
    purchaseCancels.set(poId, canId);
  }

  return {
    reqId: trimOrThrow('撤回请求编号', reqRaw),
    planId: trimOrThrow('方案编号', args.flags['--plan']),
    transferRevs,
    purchaseCancels,
  };
}

/**
 * 解析 plan save 参数。标识去首尾空白后非空、区分大小写；
 * 格式错误（缺参数、明细段数不对、同一调拨/采购重复指定）属于用法错误（退出 2），
 * 子单编号在方案内重复使用属于业务拒绝（退出 1）。
 */
function parsePlanSaveArgs(tokens: string[]): PlanSaveSpec {
  const args = parseArgs(tokens, [], ['--transfer', '--purchase']);
  const [planRaw, ...extra] = args.positionals;
  if (planRaw === undefined || extra.length > 0)
    throw new UsageError(
      '用法：plan save <方案编号> --transfer <商品>:<来源仓>:<目标仓>:<子单编号> [...] ' +
        '--purchase <商品>:<收货仓>:<子单编号>:<供应商> [...]',
    );
  const planId = trimOrThrow('方案编号', planRaw);

  const transfers: PlanSaveSpec['transfers'] = [];
  const seenTransfer = new Set<string>();
  for (const raw of args.multi['--transfer'] ?? []) {
    const parts = raw.split(':');
    if (parts.length !== 4)
      throw new UsageError(`调拨子单格式应为 “商品:来源仓:目标仓:子单编号”：${raw}`);
    const product = trimOrThrow('商品编号', parts[0]);
    const from = trimOrThrow('来源仓标识', parts[1]);
    const to = trimOrThrow('目标仓标识', parts[2]);
    const docId = trimOrThrow('调拨子单编号', parts[3]);
    const key = `${product}\0${from}\0${to}`;
    if (seenTransfer.has(key)) throw new UsageError(`调拨子单 ${key} 重复指定`);
    seenTransfer.add(key);
    transfers.push({ product, from, to, docId });
  }

  const purchases: PlanSaveSpec['purchases'] = [];
  const seenPurchase = new Set<string>();
  for (const raw of args.multi['--purchase'] ?? []) {
    const parts = raw.split(':');
    if (parts.length < 4)
      throw new UsageError(`采购子单格式应为 “商品:收货仓:子单编号:供应商”：${raw}`);
    const product = trimOrThrow('商品编号', parts[0]);
    const wh = trimOrThrow('收货仓标识', parts[1]);
    const poId = trimOrThrow('采购子单编号', parts[2]);
    const supplier = trimOrThrow('供应商名称', parts.slice(3).join(':')); // 供应商可含冒号
    const key = `${product}\0${wh}`;
    if (seenPurchase.has(key)) throw new UsageError(`采购子单 ${key} 重复指定`);
    seenPurchase.add(key);
    purchases.push({ product, wh, poId, supplier });
  }

  const seenDoc = new Set<string>();
  for (const t of transfers) {
    if (seenDoc.has(t.docId)) throw new BizError(`调拨子单编号 ${t.docId} 在方案中重复使用，拒绝保存`);
    seenDoc.add(t.docId);
  }
  const seenPo = new Set<string>();
  for (const p of purchases) {
    if (seenPo.has(p.poId)) throw new BizError(`采购子单编号 ${p.poId} 在方案中重复使用，拒绝保存`);
    seenPo.add(p.poId);
  }

  return { planId, transfers, purchases };
}

/** 方案状态文本：待执行 / 已执行 / 已执行（已撤回）。 */
function planStatusLabel(plan: PlanRecord): string {
  if (plan.status !== 'executed') return '待执行';
  return plan.withdrawnBy !== undefined ? '已执行（已撤回）' : '已执行';
}

/** 打印方案明细（调拨来源/目标仓/商品/数量、采购供应商与子单编号、状态及撤回关联）。 */
function printPlan(plan: PlanRecord, store: Store): void {
  console.log(
    `补货方案 ${plan.planId}：状态 ${planStatusLabel(plan)}，` +
      `调拨 ${plan.transfers.length} 份、采购 ${plan.purchases.length} 份`,
  );
  for (const t of plan.transfers)
    console.log(`  调拨子单 ${t.docId}：商品 ${t.product}，${t.from} -> ${t.to}，数量 ${t.qty}`);
  for (const p of plan.purchases)
    console.log(`  采购子单 ${p.poId}：商品 ${p.product}，收货仓 ${p.wh}，数量 ${p.qty}，供应商 ${p.supplier}`);
  if (plan.withdrawnBy !== undefined) {
    const w = store.planWithdrawals[plan.withdrawnBy];
    if (w !== undefined) {
      console.log(`撤回状态：已撤回（撤回请求 ${w.reqId}，方案保持已撤回，不能再次撤回）；子单关联：`);
      for (const t of plan.transfers)
        console.log(`  调拨子单 ${t.docId} -> 冲销单 ${w.transferRevs[t.docId]}`);
      for (const p of plan.purchases)
        console.log(`  采购子单 ${p.poId} -> 取消单 ${w.purchaseCancels[p.poId]}`);
    }
  }
}

/**
 * 保存补货方案：按当前补货建议的触发、来源分配与采购数量冻结完整方案，
 * 用户只为每条调拨与每个正采购缺口指定子单编号（采购项同时指定供应商），不能改量；
 * 零采购不建采购子单，无触发建议拒绝保存。保存只登记方案与快照，
 * 不改库存、采购与流水，也不占用任何子单编号。
 * 同号同输入重放返回原方案（不重新计算）；同号改输入拒绝。
 */
function runPlanSave(tokens: string[], dataDir: string, store: Store): void {
  const spec = parsePlanSaveArgs(tokens);
  const specKey = canonicalPlanSpec(spec);

  const existed = store.plans[spec.planId];
  if (existed !== undefined) {
    if (canonicalPlanSpecOf(existed) !== specKey)
      throw new BizError(`方案编号 ${spec.planId} 已存在且保存输入不同，拒绝保存（不重新计算、不覆盖原方案）`);
    console.log(`补货方案 ${spec.planId} 为重复保存，保存输入与原方案一致，返回原方案（不重新计算）：`);
    printPlan(existed, store);
    return;
  }

  // 当前补货建议：触发组合的调拨分配与正采购缺口即方案必须覆盖的全部内容
  const combos = computeReplenish(store);
  const needTransfer = new Map<string, { product: string; from: string; to: string; qty: bigint }>();
  const needPurchase = new Map<string, { product: string; wh: string; qty: bigint }>();
  for (const c of combos) {
    if (!c.triggered) continue;
    for (const t of c.transfers)
      needTransfer.set(`${c.pid}\0${t.from}\0${c.wh}`, { product: c.pid, from: t.from, to: c.wh, qty: t.qty });
    if (c.purchase > 0n) needPurchase.set(`${c.pid}\0${c.wh}`, { product: c.pid, wh: c.wh, qty: c.purchase });
  }
  if (needTransfer.size === 0 && needPurchase.size === 0)
    throw new BizError('当前无补货建议（无触发组合），拒绝保存方案');

  const specTransfer = new Map(spec.transfers.map((t) => [`${t.product}\0${t.from}\0${t.to}`, t.docId]));
  const specPurchase = new Map(spec.purchases.map((p) => [`${p.product}\0${p.wh}`, p]));
  const problems: string[] = [];
  for (const key of needTransfer.keys()) {
    if (!specTransfer.has(key)) problems.push(`缺少调拨子单指定：${key}`);
  }
  for (const key of needPurchase.keys()) {
    if (!specPurchase.has(key)) problems.push(`缺少采购子单指定：${key}`);
  }
  for (const key of specTransfer.keys()) {
    if (!needTransfer.has(key)) problems.push(`调拨子单指定与当前建议不符：${key}`);
  }
  for (const key of specPurchase.keys()) {
    if (!needPurchase.has(key)) problems.push(`采购子单指定与当前建议不符（不存在该正采购缺口）：${key}`);
  }
  if (problems.length > 0)
    throw new BizError(`保存输入与当前补货建议不一致，拒绝保存：\n${problems.join('\n')}`);

  // 冻结：数量取建议值（调拨量不超来源可供量、采购量不超缺口，均为安全整数）
  const toSafe = (q: bigint, label: string): number => {
    if (q > BigInt(MAX_SAFE)) throw new BizError(`${label}超出安全整数范围，拒绝保存`);
    return Number(q);
  };
  const transfers: PlanTransfer[] = [];
  const purchases: PlanPurchase[] = [];
  for (const c of combos) {
    if (!c.triggered) continue;
    for (const t of c.transfers) {
      const docId = specTransfer.get(`${c.pid}\0${t.from}\0${c.wh}`)!;
      transfers.push({ docId, product: c.pid, from: t.from, to: c.wh, qty: toSafe(t.qty, `调拨 ${c.pid} ${t.from} -> ${c.wh} 数量`) });
    }
    if (c.purchase > 0n) {
      const p = specPurchase.get(`${c.pid}\0${c.wh}`)!;
      purchases.push({ poId: p.poId, supplier: p.supplier, wh: c.wh, product: c.pid, qty: toSafe(c.purchase, `采购 ${c.pid} @${c.wh} 数量`) });
    }
  }

  // 快照：涉及商品的全部补货规则，以及这些配置仓的实存与待到货合计（精确整数）
  const involved = new Set<string>();
  for (const t of transfers) involved.add(t.product);
  for (const p of purchases) involved.add(p.product);
  const comboByKey = new Map(combos.map((c) => [`${c.pid}\0${c.wh}`, c]));
  const snapRules = nullProto<Record<string, Record<string, ReplenishRule>>>();
  const snapStock = nullProto<Record<string, Record<string, number>>>();
  const snapPending = nullProto<Record<string, Record<string, string>>>();
  for (const pid of [...involved].sort()) {
    const ruleMap = nullProto<Record<string, ReplenishRule>>();
    const stockMap = nullProto<Record<string, number>>();
    const pendMap = nullProto<Record<string, string>>();
    for (const wh of Object.keys(store.rules[pid]).sort()) {
      const r = store.rules[pid][wh];
      ruleMap[wh] = { min: r.min, target: r.target };
      stockMap[wh] = getStock(store.stock, pid, wh);
      pendMap[wh] = comboByKey.get(`${pid}\0${wh}`)!.pending.toString();
    }
    snapRules[pid] = ruleMap;
    snapStock[pid] = stockMap;
    snapPending[pid] = pendMap;
  }

  store.plans[spec.planId] = {
    planId: spec.planId, transfers, purchases,
    snapshot: { rules: snapRules, stock: snapStock, pending: snapPending },
    status: 'pending',
  };
  saveStore(dataDir, store);

  console.log(
    `补货方案 ${spec.planId} 保存成功（保存不改库存、采购与流水，子单编号未占用）：`,
  );
  printPlan(store.plans[spec.planId], store);
  console.log('已冻结涉及商品的补货规则、配置仓实存与待到货合计快照；首次执行前将按值核对，任一变化整案拒绝。');
}

/**
 * 快照核对：涉及商品的补货规则（增删改均算变化）、各配置仓实存与待到货合计
 * 与冻结值逐项按值比较；无关商品的变化不影响方案。返回全部差异（空数组 = 一致）。
 */
function planSnapshotDiffs(store: Store, plan: PlanRecord): string[] {
  const diffs: string[] = [];
  const snap = plan.snapshot;
  for (const pid of Object.keys(snap.rules)) {
    const cur = store.rules[pid] ?? nullProto<Record<string, ReplenishRule>>();
    for (const [wh, s] of Object.entries(snap.rules[pid])) {
      const c = cur[wh];
      if (c === undefined)
        diffs.push(`商品 ${pid} 仓库 ${wh} 的补货规则已删除（快照下限 ${s.min}，目标 ${s.target}）`);
      else if (c.min !== s.min || c.target !== s.target)
        diffs.push(
          `商品 ${pid} 仓库 ${wh} 的补货规则已变化：快照下限 ${s.min}、目标 ${s.target}，当前下限 ${c.min}、目标 ${c.target}`,
        );
    }
    for (const [wh, c] of Object.entries(cur)) {
      if (snap.rules[pid][wh] === undefined)
        diffs.push(`商品 ${pid} 仓库 ${wh} 新增补货规则（下限 ${c.min}，目标 ${c.target}）`);
    }
  }
  for (const [pid, whs] of Object.entries(snap.stock)) {
    for (const [wh, v] of Object.entries(whs)) {
      const cur = getStock(store.stock, pid, wh);
      if (cur !== v) diffs.push(`商品 ${pid} 仓库 ${wh} 实存：快照 ${v}，当前 ${cur}`);
    }
  }
  const pendingNow = pendingTotals(store);
  for (const [pid, whs] of Object.entries(snap.pending)) {
    for (const [wh, v] of Object.entries(whs)) {
      const cur = (pendingNow[pid]?.[wh] ?? 0n).toString();
      if (cur !== v) diffs.push(`商品 ${pid} 仓库 ${wh} 待到货合计：快照 ${v}，当前 ${cur}`);
    }
  }
  return diffs;
}

/**
 * 一次性落单：首次执行前按值核对冻结快照（规则增删、实存或待到货合计任一变化
 * 整案拒绝并说明差异，不替换为新建议）；随后检查全部拟用子单编号未被对应空间
 * 占用（即使内容相同也拒绝，不接管已有单据），再按冻结内容生成普通调拨单
 * （实际减来源、增目标）与采购单（仅登记待收承诺）。全部子单、方案关联、执行
 * 状态与原结果一次原子保存后才报成功；任一失败不留任何变动，方案保留待执行，
 * 条件改善后可重试。已执行方案重放只返回原落单结果，不再核对、不再生效、不改写文件。
 */
function runPlanExecute(tokens: string[], dataDir: string, store: Store): void {
  const args = parseArgs(tokens, []);
  const [planRaw, ...extra] = args.positionals;
  if (planRaw === undefined || extra.length > 0) throw new UsageError('用法：plan execute <方案编号>');
  const planId = trimOrThrow('方案编号', planRaw);
  const plan = store.plans[planId];
  if (plan === undefined) throw new BizError(`补货方案 ${planId} 不存在`);

  if (plan.status === 'executed') {
    console.log(`补货方案 ${planId} 已执行，返回原落单结果（不再核对快照、不再生效、不改写文件）：`);
    for (const line of plan.execResultLines!) console.log(line);
    return;
  }

  const diffs = planSnapshotDiffs(store, plan);
  if (diffs.length > 0)
    throw new BizError(
      `补货方案 ${planId} 已过期，快照与当前状态不一致，整案拒绝执行（不替换为新建议）：\n${diffs.join('\n')}`,
    );

  // 子单编号占用检查：任一拟用编号已被对应空间占用即整案拒绝（即使内容相同也不接管）
  for (const t of plan.transfers) {
    if (
      store.docs[t.docId] !== undefined || store.arrivals[t.docId] !== undefined ||
      store.cancels[t.docId] !== undefined || store.returns[t.docId] !== undefined ||
      store.poTransfers[t.docId] !== undefined ||
      store.reversals[t.docId] !== undefined ||
      store.planWithdrawals[t.docId] !== undefined
    )
      throw new BizError(`调拨子单编号 ${t.docId} 已被占用，整案拒绝执行（不接管已有单据）`);
  }
  for (const p of plan.purchases) {
    if (store.purchases[p.poId] !== undefined)
      throw new BizError(`采购子单编号 ${p.poId} 已被占用，整案拒绝执行（不接管已有单据）`);
  }

  // 模拟执行：任一子单失败（缺货、溢出、编号冲突）整案不留变动
  const ledger = new Ledger(store);
  const lines: string[] = [];
  for (const t of plan.transfers) {
    const outcome = ledger.applyDoc({
      type: 'transfer', docId: t.docId, from: t.from, to: t.to,
      items: new Map([[t.product, t.qty]]),
    });
    lines.push(outcome.header, ...outcome.lines);
  }
  for (const p of plan.purchases) {
    const outcome = ledger.applyPurchase({
      poId: p.poId, supplier: p.supplier, wh: p.wh,
      items: new Map([[p.product, p.qty]]),
    });
    lines.push(outcome.header, ...outcome.lines);
  }

  // 全部子单通过：方案关联、执行状态与原结果随子单一次原子保存
  plan.status = 'executed';
  plan.execResultLines = lines;
  ledger.commit(dataDir);

  console.log(`补货方案 ${planId} 执行成功，全部子单已落单：`);
  for (const line of lines) console.log(line);
}

/**
 * 整案撤回已执行的补货方案：为每条调拨子单指定冲销单号、为每张采购子单指定
 * 取消单号（逐一对应，无缺漏、多余或重复，顺序无关），在当前余量上冲销全部
 * 调拨并取消全部采购的完整订购量。全部变化、关联、撤回状态一次原子保存后才
 * 报成功；任一失败不保留本次任何变动、不占编号，可同号重试。同请求编号、同
 * 方案及子单映射重放返回原结果，不再校验、生效或改写文件。
 */
function runPlanWithdraw(tokens: string[], dataDir: string, store: Store): void {
  const req = parsePlanWithdrawArgs(tokens);
  const ledger = new Ledger(store);
  const outcome = ledger.applyWithdraw(req);
  ledger.commit(dataDir);
  if (outcome.duplicate) {
    console.log(
      `撤回请求 ${req.reqId} 为重复提交，方案与子单映射与原撤回一致，返回原撤回结果（库存、进度与流水不再变动）：`,
    );
  } else {
    console.log(outcome.header);
  }
  for (const line of outcome.lines) console.log(line);
}

function runPlan(rest: string[], dataDir: string, store: Store): void {
  const sub = rest[0];
  const tokens = rest.slice(1);
  if (sub === 'save') {
    runPlanSave(tokens, dataDir, store);
    return;
  }
  if (sub === 'execute' || sub === 'exec') {
    runPlanExecute(tokens, dataDir, store);
    return;
  }
  if (sub === 'withdraw') {
    runPlanWithdraw(tokens, dataDir, store);
    return;
  }
  if (sub === 'show') {
    const args = parseArgs(tokens, []);
    const [planRaw, ...extra] = args.positionals;
    if (planRaw === undefined || extra.length > 0) throw new UsageError('用法：plan show <方案编号>');
    const planId = trimOrThrow('方案编号', planRaw);
    const plan = store.plans[planId];
    if (plan === undefined) throw new BizError(`补货方案 ${planId} 不存在`);
    printPlan(plan, store);
    if (plan.withdrawnBy !== undefined)
      console.log('方案已撤回：调拨已冲销、采购已取消，可通过 balance、flow、po show 查询真实结果。');
    else if (plan.status === 'executed')
      console.log('子单已落单，可通过 balance、flow、po show 查询真实结果。');
    else
      console.log('首次执行前将按值核对冻结快照：规则增删、实存或待到货合计任一变化整案拒绝。');
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const args = parseArgs(tokens, []);
    if (args.positionals.length > 0) throw new UsageError('用法：plan list');
    const ids = Object.keys(store.plans).sort();
    console.log(`补货方案（${ids.length}）：`);
    if (ids.length === 0) {
      console.log('（暂无补货方案）');
      return;
    }
    for (const id of ids) {
      const plan = store.plans[id];
      const withdrawn =
        plan.withdrawnBy !== undefined ? `\t撤回请求=${plan.withdrawnBy}` : '';
      console.log(
        `${id}\t${planStatusLabel(plan)}\t调拨 ${plan.transfers.length} 份\t采购 ${plan.purchases.length} 份${withdrawn}`,
      );
    }
    return;
  }
  throw new UsageError(sub === undefined ? '用法：plan <save|show|list|execute|withdraw> …' : `未知 plan 子命令：${sub}`);
}

function runArrival(rest: string[], dataDir: string, store: Store): void {
  const req = parseArrivalArgs(rest);
  const ledger = new Ledger(store);
  const outcome = ledger.applyArrival(req);
  ledger.commit(dataDir);
  if (outcome.duplicate) {
    console.log(`到货单 ${req.arrId} 为重复提交，采购单与合并数量与原提交一致，返回原到货结果（库存、进度与流水不再变动）：`);
  } else {
    console.log(outcome.header);
  }
  for (const line of outcome.lines) console.log(line);
}

function runCancel(rest: string[], dataDir: string, store: Store): void {
  const req = parseCancelArgs(rest);
  const ledger = new Ledger(store);
  const outcome = ledger.applyCancel(req);
  ledger.commit(dataDir);
  if (outcome.duplicate) {
    console.log(`取消单 ${req.canId} 为重复提交，采购单与合并数量与原提交一致，返回原取消结果（进度、库存与流水不再变动）：`);
  } else {
    console.log(outcome.header);
  }
  for (const line of outcome.lines) console.log(line);
}

function runReturn(rest: string[], dataDir: string, store: Store): void {
  const req = parseReturnArgs(rest);
  const ledger = new Ledger(store);
  const outcome = ledger.applyReturn(req);
  ledger.commit(dataDir);
  if (outcome.duplicate) {
    console.log(`退货单 ${req.retId} 为重复提交，原到货单与合并数量与原提交一致，返回原退货结果（库存、进度与流水不再变动）：`);
  } else {
    console.log(outcome.header);
  }
  for (const line of outcome.lines) console.log(line);
}

function runPoTransfer(rest: string[], dataDir: string, store: Store): void {
  const req = parseTransferArgs(rest);
  const ledger = new Ledger(store);
  const outcome = ledger.applyTransfer(req);
  ledger.commit(dataDir);
  if (outcome.duplicate) {
    console.log(`采购转单 ${req.tId} 为重复提交，全部内容与原提交一致，返回原转单结果（两单待收与流水不再变动）：`);
  } else {
    console.log(outcome.header);
  }
  for (const line of outcome.lines) console.log(line);
}

/**
 * 整批导入：按列表顺序在同一份草稿上处理各项，后项可见前项生效结果；
 * 任一项失败整批拒绝（此前已保存的单据不撤销，本批任何变动均不落库）。
 * 全部重复时不改写数据。逐项输出编号、首次生效/重复（及重复来源）状态与提交结果。
 */
function runImport(rest: string[], dataDir: string): void {
  const { file } = parseImportArgs(rest);

  // 命令行参数已在等待前校验；取得写入机会后才读取并解析导入文件，
  // 文件不可读/解析失败时绝不触碰已提交状态。
  const requests = parseImportFile(readImportFile(file));

  // 参数与文件格式均确认无误后才打开本地数据；损坏数据在此被拒绝且不报告成功
  const store = loadStore(dataDir);
  const ledger = new Ledger(store);
  // 模拟阶段收集输出：只有整批通过并完成保存后才向用户报告，绝不报告部分成功
  const blocks: string[] = [];
  let newCount = 0;

  requests.forEach((r, i) => {
    const pos = `第 ${i + 1}/${requests.length} 项`;
    // 模拟阶段的业务拒绝同样标注列表位置与原因
    const apply = (): ApplyOutcome => {
      switch (r.kind) {
        case 'doc': return ledger.applyDoc(r.req);
        case 'count': return ledger.applyCount(r.req);
        case 'reverse': return ledger.applyReversal(r.docId, r.orig);
        case 'po': return ledger.applyPurchase(r.req);
        case 'arrival': return ledger.applyArrival(r.req);
        case 'cancel': return ledger.applyCancel(r.req);
        case 'return': return ledger.applyReturn(r.req);
        case 'transfer': return ledger.applyTransfer(r.req);
      }
    };
    let outcome: ApplyOutcome;
    try {
      outcome = apply();
    } catch (e) {
      if (e instanceof BizError) throw new BizError(`第 ${i + 1} 项：${e.message}`);
      throw e;
    }
    const id =
      r.kind === 'reverse' ? r.docId
      : r.kind === 'po' ? r.req.poId
      : r.kind === 'arrival' ? r.req.arrId
      : r.kind === 'cancel' ? r.req.canId
      : r.kind === 'return' ? r.req.retId
      : r.kind === 'transfer' ? r.req.tId
      : r.req.docId;

    let status: string;
    if (outcome.duplicate) {
      const where = outcome.repeatedFrom === 'batch' ? '（本批此前已出现）' : '（导入前已存在）';
      status = `重复${where}，返回原提交结果，不重新核对库存、不追加流水`;
    } else {
      status = '首次生效';
      newCount++;
    }
    blocks.push([`[${pos}] 单据 ${id}：${status}`, outcome.header, ...outcome.lines].join('\n'));
  });

  // 全部项通过：有新生效单据时整批一次性保存；全部重复则不改写数据
  ledger.commit(dataDir);

  console.log(`整批导入完成：共 ${requests.length} 项，首次生效 ${newCount} 项，重复 ${requests.length - newCount} 项。`);
  for (const block of blocks) console.log(block);
}

// ---------- 帮助与入口 ----------

const HELP = `${APP_NAME} —— 本地多仓库存台账

用法：
  node app.ts [-d, --data <数据目录>] <命令> [参数]

全局选项：
  -d, --data <目录>   数据目录（默认 ./.stockroom）；不同目录的数据互不影响

命令：
  product add <编号> <名称>                 登记商品（编号唯一、区分大小写，去空白后不能为空）
  product list                              列出已登记商品
  in <单据编号> --wh <仓库> --item <编号:数量> [...]       入库
  out <单据编号> --wh <仓库> --item <编号:数量> [...]      出库（余量不足整单拒绝）
  transfer <单据编号> --from <源仓> --to <目标仓> \\
           --item <编号:数量> [...]                        跨仓调拨（两仓不能相同）
  count <单据编号> --wh <仓库> \\
        --item <编号:预期账面量:实盘量> [...]              整单盘点校正（先核对账面再按实盘校正）
  po register <采购编号> --supplier <供应商> --wh <收货仓> \\
        --item <编号:订购量> [...]                         登记采购单（不改库存，成功后不可修改）
  po show <采购编号>                                      查询采购单进度与到货/取消/冲销关联
  po list                                                 列出全部采购单及汇总状态
  arrival <到货单编号> --po <采购编号> \\
        --item <编号:到货量> [...]                         采购分批到货入收货仓（可分次、可部分）
  cancel <取消单编号> --po <采购编号> \\
        --item <编号:取消量> [...]                         取消未到货数量（只减少待收承诺，不改库存）
  return <退货单编号> --arrival <原到货单编号> \\
        --item <编号:退货量> [...]                         采购部分退货（从原收货仓扣减，退回后等待补收）
  po-transfer <转单编号> --orig <原采购编号> --dest <新目的采购编号> \\
        --supplier <供应商> --wh <收货仓> \\
        --item <编号:转出量> [...]                         采购待收转单：重排待收商品的供应商/收货仓（不改库存）
  reverse <冲销单编号> --orig <原单编号>     整单冲销已成功的入库/出库/调拨/盘点/到货/取消/退货/采购转单
  import --file <单据列表.json>              整批导入有序单据列表（按顺序生效，整批成败一致）
  rule set <商品编号> --wh <仓库> \\
           --min <下限> --target <目标>                    设置补货规则（同组合再次设置整体替换）
  rule list                                 列出全部补货规则
  rule delete <商品编号> --wh <仓库>         删除补货规则
  replenish                                 跨仓补货建议（先用可调拨实存，不足再建议采购；只读）
  plan save <方案编号> --transfer <商品>:<来源仓>:<目标仓>:<子单编号> [...]
        --purchase <商品>:<收货仓>:<子单编号>:<供应商> [...]     按当前补货建议冻结并保存补货方案（不改库存与采购）
  plan show <方案编号>                        查看补货方案明细与待执行/已执行状态
  plan list                                   列出全部补货方案
  plan execute <方案编号>                     一次性落单：核对照快照后生成全部调拨单与采购单（原子）
  plan withdraw <请求编号> --plan <方案编号> \\
        --transfer-rev <调拨子单编号>:<冲销单号> [...] \\
        --purchase-cancel <采购子单编号>:<取消单号> [...]   整案撤回已执行方案（冲销全部调拨、取消全部采购）
  balance <商品编号> [--wh <仓库>]           查询余量；省略 --wh 查询各仓
  flow --product <编号> [--wh <仓库>]        按商品/仓库查询流水（至少一个过滤条件）
       | --wh <仓库> [--product <编号>]
  recon [--from <起点单据>] [--to <终点单据>]
        [--product <编号>] [--wh <仓库>]     期间库存对账报表（只读；起点不含、终点含）
  -h, --help                                显示本帮助

规则：
  数量必须为正安全整数；同单同商品的重复明细先合并，再做足量与溢出校验；
  任一明细不合法则整单拒绝。入库/出库/调拨/盘点/到货/取消/退货/采购转单/冲销
  单据编号在同一数据目录内共用全局唯一编号空间，相同内容重复提交返回原结果且不
  重复变动，同编号不同内容或不同业务拒绝；失败提交不占用编号。采购编号独立于库存
  单据编号空间，允许与库存/到货/取消/退货/转单/冲销单同名。所有标识与名称去首尾
  空白后非空、区分大小写。

多进程协调：
  同一数据目录的写命令自动串行执行（目录内固定锁闸门与按进程命名的锁身份
  文件；取得写入机会后才读取最新已提交状态，导入、方案执行与撤回为完整事务
  不交错）。等待上限默认 10 秒，可用 STOCKROOM_LOCK_WAIT_MS 设置非负安全
  整数毫秒（0 表示仅立即尝试；非法或超范围配置在等待前报标准错误退出 2，
  不会变成无限等待），超时报告“数据目录正忙”并退出 1。缺少参数、未知选项
  等用法错误也在等待前退出 2 且不创建协调文件。锁持有者仍存活时（即使其
  持有者信息尚未写完）绝不被按文件年龄或内容接管；持有者异常退出后由后续
  写请求凭进程号自动回收遗留锁与临时文件，多个等待者串行取得写入机会，回收
  与释放都只作用于本请求自己的占用，无需手工删除文件；原子替换前崩溃不生效，
  替换后完整提交保留，同号同内容重试只返回原结果。只读查询不参与协调，
  不创建协调文件。

采购与到货规则：
  po register 登记采购单（编号、供应商、收货仓及至少一种已登记商品的订购量），
  登记只记录订购信息、绝不改动库存，成功后内容不可修改；同号同内容重放返回原
  登记结果且不重置到货进度、不清除取消记录，同号不同内容拒绝。
  arrival 以独立到货单编号引用采购单，收货仓取采购单登记的收货仓，只能收采购
  单内商品；可分多次、每次只收部分商品。待到货量 = 订购量 - 有效到货量 -
  有效取消量，各商品本次到货只能使用扣除有效取消后的待到货量，超收、明细非法
  或入仓后余量溢出，整单拒绝、不占用到货编号；其他库存业务（出入库、调拨、
  盘点）不影响采购进度，普通入库不能事后绑定采购。
  到货成功同时更新库存与采购进度，逐项输出本次数量、库存前后量、累计到货量与
  待到货量。同号同采购同合并数量重放返回原结果，收齐、库存已变化或原到货已冲
  销后重放也不再生效；同号不同内容或不同业务拒绝。
  cancel 以独立取消单编号引用采购单，可分次取消部分商品的未到货数量：商品必须
  在该采购单内，取消量为正安全整数、同商品先合并；有效取消量只计未冲销取消单，
  任一商品本次取消量超过当前待到货量整单拒绝、不占用取消编号。成功只减少待收
  承诺，不改原订购内容、库存或库存流水。同号同采购同合并数量重放返回原结果，
  即使进度已变化或该取消已冲销也不重新校验、不再生效；同号不同内容或不同业务
  拒绝。
  return 以独立退货单编号引用一张已成功且未冲销的原到货单，采购单与收货仓取原
  到货；只退原到货明细内商品，退货量为正安全整数、同商品先合并（顺序无关）。
  各商品本次退货量不得超过“原到货量 - 关联未冲销退货量”，并从原收货仓当前余
  量扣减；超退、缺货或明细非法整单拒绝、不占用退货编号。退货抵减有效到货
  （有效到货 = 未冲销到货 - 未冲销退货），相应数量重新待到货、等待补收；不改
  订购与取消，其他库存业务不影响采购进度。同号同原到货同合并数量重放返回原结
  果——即使进度已变化、该退货或原到货已冲销也不再校验、不再生效；同号不同内
  容或不同业务拒绝。退货成功逐项输出本次数量、库存前后量、有效到货与待到货量。
  po show 显示供应商、收货仓、各商品订购/有效到货/有效退货/有效取消/待到货量及
  仍待收、收齐、已结清状态（取消、退货均不计作到货、不会误报收齐），并列出到
  货单、取消单、退货单与冲销单关联；flow 可凭采购单编号追溯到货、退货与各自
  冲销流水。进度按精确整数计算：反复退货、补收下累计到货或退货可超过安全整数
  上限，净进度不受影响；有效退货合计超安全整数时仍显示完整十进制整数。

采购待收转单规则：
  po-transfer 以独立转单编号把原采购单（--orig）的部分当前待收量转给一张新的
  目的采购单（--dest），重新安排供应商（--supplier）或收货仓（--wh），至少一项
  原单内商品、数量为正安全整数、同商品先合并（溢出拒绝），明细顺序无关。原采购
  须存在；目的采购编号必须未被采购占用——即使已有内容相同的采购单也拒绝、不接管。
  各商品转出量不得超过原单当前待收量（待收 = 订购 - 有效到货 - 有效取消，
  有效到货 = 未冲销到货 - 未冲销退货；按精确净进度计算），任一不符整单拒绝、不占
  用本次新编号。成功同时减少原单待收（转出量计入原单有效取消）并新建目的采购单
  （目的订购量等于转出量、初始全量待收，可按普通采购到货、取消或再转单）；原订购
  与有效到货不变，不改库存或库存流水。转单与库存/到货/取消/退货/冲销单共用编号
  空间，采购编号独立。同转单编号同全部内容重放返回原结果，不重新校验、不再生效或
  改写文件（即使进度改变或已冲销）；改内容或业务拒绝。结果逐商品说明数量及两单
  操作前后待收。
  reverse 可整单冲销一张转单（--orig 转单编号）：仅当目的单所有商品仍全量待收
  （有效到货、有效取消均为零；历史业务已合法恢复全量待收也允许）才允许。成功仅
  移除本转单在原单形成的有效取消（原单待收回升），并把目的单全部订购量计为取消、
  待收归零；保留两单及历史，不撤销后续业务，不改库存、不产生流水。转出和目的单
  关闭不能作为取消单冲销；每张转单最多冲销一次，冲销单不可冲销。po show 展示真实
  净进度与转单、两单及冲销关联，取消/转单均不误报收齐。

冲销规则：
  冲销在“当前余量”上应用原单的相反变动，不回滚原单之后的其他业务、不恢复绝对
  余量：冲销入库从原目标仓扣回；冲销出库向原来源仓补回；冲销调拨从原调入仓扣
  回并向原调出仓补回；冲销盘点在当前余量上减去原盘点差额（零差额不改余量，
  但仍记录冲销关系与流水）；冲销到货从采购单收货仓扣回原数量并减少有效到货量，
  已收齐的采购相应数量重新待收（不撤掉取消）；冲销取消移除该取消单的有效取消
  量、恢复相应待收量，不改库存、不产生库存流水；冲销退货向原收货仓当前余量补
  回原退货量、恢复有效到货；冲销采购转单仅移除本转单在原单形成的有效取消（原单
  待收回升），并把目的单全部订购量计为取消、待收归零（仅当目的单仍全量待收才允许，
  不改库存、不产生流水、不撤销后续业务）。数量取原单合并后的明细。任一商品扣回不足、补回后
  溢出、冲减后为负，冲销退货后“有效到货 + 有效取消”超过订购量，或目的单并非全
  量待收，则整单拒绝、
  不占用冲销单编号、原单不标记冲销，条件改善后可重试。
  只能冲销成功的原始库存单据、到货单、取消单、退货单与采购转单；原单不存在、采购单、冲
  销单本身、已冲销过的原单均不能再次冲销，每张原单最多冲销一次。转出与目的单的
  关闭不能单独作为取消单冲销（只能由转单冲销整体处理）。有未冲销退货
  的到货单禁止冲销，相关退货全部冲销后可按原规则冲销到货。冲销成功后重放原单
  （含到货单、取消单、退货单）仍只返回其最初结果，不会重新生效；重放冲销单返
  回原冲销结果，不再变动，同编号改指其他原单则拒绝。

整批导入规则：
  import --file <文件> 从本地 JSON 文件读取“有序单据对象数组”（至少一项），按
  列表顺序在同一批次中处理：新单据以此前各项生效后的余量核对并计算，后项可以
  使用前项入库/到货所得库存；到货、取消、转单可引用导入前已登记或列表中此前登记的
  采购单（转单的目的采购由本项新建、编号必须此前未被占用），退货可引用导入前已成功或列表中此前成功的到货单，其超收/超取消/超退/超转出校验针对此前各项生效后的
  采购进度；盘点核对的是此前各项之后的账面量；冲销可
  指向导入前已成功的原单（含到货单、取消单、退货单、采购转单）或列表中此前的新原单，
  冲销转单时该转单须为此前成功项、且其目的单仍全量待收；
  尚未出现且未保存的原单不可引用。每张原单最多冲销一次，冲销单不可冲销。每项
  格式（标识去首尾空白后非空、区分大小写）：
    入库 {"type":"in","id":"D1","wh":"W1","items":[{"product":"P1","qty":10}]}
    出库 {"type":"out","id":"D2","wh":"W1","items":[{"product":"P1","qty":4}]}
    调拨 {"type":"transfer","id":"D3","from":"W1","to":"W2","items":[{"product":"P1","qty":2}]}
    盘点 {"type":"count","id":"C1","wh":"W1","items":[{"product":"P1","expected":8,"actual":5}]}
    采购 {"type":"po","id":"PO1","supplier":"S1","wh":"W1","items":[{"product":"P1","qty":10}]}
    到货 {"type":"arrival","id":"A1","po":"PO1","items":[{"product":"P1","qty":6}]}
    取消 {"type":"cancel","id":"X1","po":"PO1","items":[{"product":"P1","qty":2}]}
    退货 {"type":"return","id":"T1","arrival":"A1","items":[{"product":"P1","qty":1}]}
    转单 {"type":"po-transfer","id":"F1","orig":"PO1","dest":"PO2","supplier":"S2","wh":"W2","items":[{"product":"P1","qty":2}]}
    冲销 {"type":"reverse","id":"R1","orig":"D1"}
  入出库、调拨、采购、到货、取消、退货、转单的 qty/订购量/转出量为正安全整数，同商品明细先
  合并再校验；盘点 expected/actual 均为非负安全整数，同商品重复拒绝。库存、到
  货、取消、退货、转单、冲销单据编号与单条命令共用唯一空间，采购编号独立；不产生批
  次编号：导入前已有或本列表此前出现的“同编号同内容”项只返回原结果，不重新
  核对、不追加流水（即使原单已冲销也不重新生效）；普通单比较类型、仓库及合并
  后商品数量，盘点比较仓库及两种数量，采购比较供应商、收货仓及订购量，到货、
  取消比较采购编号及合并数量，退货比较原到货单编号及合并数量，转单比较原采购、
  目的采购、供应商、收货仓及合并转出量，冲销比较原单编
  号，明细顺序无关。同编号不同内容或不同业务整批拒绝。
  整批成功须全部项通过，有新生效单据时整批一次性保存；全部重复时不改写数据。
  任一项格式不合法、缺货、账面冲突、超收、超取消、超退、溢出、编号冲突或非法
  冲销，整批拒绝并指出位置和原因：此前已保存的单据不撤销，本批新库存、采购进
  度、流水、编号与冲销关系均不保留，纠正后可复用这些新编号。文件无法读取、数
  据损坏或保存失败均不改变已提交状态，也不报告部分成功。文件格式或参数错误
  退出 2，业务拒绝及读写失败退出 1。

补货规则与跨仓补货建议：
  rule set 为已登记商品与仓库设置唯一补货规则（下限与目标均为非负安全整数且
  下限小于目标；仓库无需登记），同组合再次设置整体替换；rule list 查看、
  rule delete 删除。规则随数据文件原子保存，保存成功后才报告成功，重启及其
  他命令保存后仍有效。
  replenish 取当前已提交状态逐组合计算：预计量 = 本仓实存 + 本仓待到货合计
  （收货仓为本仓的全部采购单，不限供应商；待到货 = 订购 - 有效到货 - 有效
  取消；其他仓库存不计入，无库存记录视为零）。预计量不高于下限才触发，缺口
  = 目标 - 预计量。按商品分别分配：同商品其他已配置仓实存超过自身目标的部
  分可供调拨（待收不可调；未配置仓既不产生需求也不提供调拨），缺货仓、来源
  仓各按标识升序依次取量，整份建议对来源的累计分配不超过可供量；剩余缺口即
  采购量（可为零）。逐组合输出下限、目标、实存、待到货合计、预计量与触发情
  况，触发项列出各调拨来源及数量、调拨合计与采购量；无规则或无缺货明确提示。
  建议查询不写文件、不改变库存或采购，同状态结果一致；合计、比较与分配按精
  确整数计算，超安全整数合计完整十进制显示。

补货方案：
  plan save 按当前补货建议的触发、来源分配与采购数量冻结完整方案：为每条调
  拨指定子单编号（--transfer 商品:来源仓:目标仓:子单编号），为每个正采购缺
  口指定子单编号与供应商（--purchase 商品:收货仓:子单编号:供应商），不能自
  行改量；零采购不建采购子单，无触发建议拒绝保存。保存只登记方案与快照，
  不改库存、采购与流水，也不占用子单编号。方案编号使用独立空间；同号同保
  存输入重放返回原方案（不重新计算，明细顺序无关），同号改输入拒绝。保存
  时冻结涉及商品的全部补货规则及其配置仓实存与待到货合计快照。
  plan execute 首次执行前按值核对快照（规则增删、实存或待到货合计任一变化
  整案拒绝并说明差异，不替换为新建议；无关商品变化不影响），再检查全部拟
  用子单编号未被对应空间占用（即使内容相同也拒绝，不接管已有单据），然后
  按冻结内容生成普通调拨单（实际减来源、增目标）与采购单（仅登记待收承
  诺）。全部子单、方案关联、执行状态与原结果一次原子保存后才报成功；任一
  失败不留本次库存、采购、流水、编号或执行标记，方案保留待执行可重试。已
  执行方案重放只返回原落单结果，不再核对、不再生效、不改写文件；其子单后
  来冲销、取消或到货也不重建。
  plan withdraw 整案撤回已执行且未撤回的方案：为每条调拨子单指定冲销单号、
  为每张采购子单指定取消单号（逐一对应，无缺漏、多余或重复，顺序无关）。
  请求编号与新子单号同库存/到货/取消/退货/转单/冲销单共用全局编号空间，
  彼此不得重号；首次撤回不接管已占编号（即使内容相同也拒绝）；撤回请求本
  身不可冲销。撤回条件按当前精确净进度判断（不核对保存快照，规则变化不阻
  止撤回）：各调拨子单须未冲销，各采购子单所有商品须全量待收（有效到货与
  有效取消均为零；历史业务经合法操作恢复此状态也允许）。成功在当前余量上
  冲销全部调拨（追加普通冲销流水），并取消全部采购的完整订购量、待收归零
  （不改库存与流水）；不恢复库存快照，不删除原单或后续业务。缺货、溢出、
  进度不符或编号冲突均整案拒绝并说明子单与原因，本次变动与编号均不保留，
  可同号重试；全部变化、关联与撤回标记一次原子保存后才报成功。每案最多成
  功撤回一次；同请求编号、同方案及子单映射重放返回原结果，不再校验、生效
  或改写文件；撤回后 plan execute 及原子单重放仍返回原成功结果，新取消单
  可按普通规则冲销，但方案保持已撤回。plan show/list 展示撤回状态与请求、
  原子单、新子单关联。

期间库存对账报表：
  recon 生成可追溯的期间库存对账报表（只读，不创建或改写数据、历史结果及关联）。
  --from 指定起点单据（期间不含起点，表示该单全部流水完成后的状态），--to 指
  定终点单据（含该单全部流水）；不指定起点从零库存开始，不指定终点截至当前；
  同一单作两端为空期间。边界仅接受已成功且有库存流水的单据（冲销单、零差额
  盘点可用；只有采购或取消记录的编号不可用；同名采购单不干扰库存单定位），
  按首次提交顺序比较而非编号排序；单据不存在或起点晚于终点拒绝（退出 1）。
  可按 --product、--wh 单独或同时筛选，不筛选覆盖全库；先确定全局边界再筛
  选，不拆开多商品单据或调拨两端。每个商品仓库组合展示期初、期间增加与减少
  的非负合计、净变动与期末（期初 + 增加 - 减少 = 期末），并按业务类型及是
  否冲销分别列出带符号净变动小计；调拨按各仓实际方向统计，到货、退货及反向
  冲销计入实存，采购登记、取消及其冲销不计入；盘点按实际差额统计，零差额仍
  保留追溯；已冲销原单保留当时变动，冲销只在其发生的期间计入。期间匹配流水
  按提交顺序列出（含采购、原到货及冲销关联），原单冲销状态以终点时刻为准；
  组合按商品、仓库标识升序，展示期初或期末非零及期间有流水的组合，无匹配明
  确提示；逐商品汇总所选仓库，累计量及合计用精确整数，超安全整数仍完整十进
  制显示。出报表前核对完整流水余量连续性、调拨两端完整性及末笔余量与当前实
  存一致，不一致明确报错（退出 1），不输出部分报表、不自动修复。

示例：
  node app.ts -d ./data product add P1 螺丝
  node app.ts -d ./data in D1 --wh W1 --item P1:10 --item P2:3
  node app.ts -d ./data out D2 --wh W1 --item P1:4
  node app.ts -d ./data transfer D3 --from W1 --to W2 --item P1:2 --item P1:3
  node app.ts -d ./data count C1 --wh W1 --item P1:1:5 --item P2:3:3
  node app.ts -d ./data po register PO1 --supplier 华东五金 --wh W1 --item P1:10 --item P1:2
  node app.ts -d ./data arrival A1 --po PO1 --item P1:7
  node app.ts -d ./data cancel X1 --po PO1 --item P1:2
  node app.ts -d ./data arrival A2 --po PO1 --item P1:3
  node app.ts -d ./data po show PO1
  node app.ts -d ./data po list
  node app.ts -d ./data reverse R1 --orig D3
  node app.ts -d ./data reverse R2 --orig C1
  node app.ts -d ./data reverse R3 --orig A1
  node app.ts -d ./data reverse R4 --orig X1
  node app.ts -d ./data return T1 --arrival A2 --item P1:1
  node app.ts -d ./data reverse R5 --orig T1
  node app.ts -d ./data po-transfer F1 --orig PO1 --dest PO2 --supplier 华南五金 --wh W2 --item P1:2
  node app.ts -d ./data reverse R6 --orig F1
  node app.ts -d ./data import --file ./docs.json
  node app.ts -d ./data rule set P1 --wh W1 --min 5 --target 20
  node app.ts -d ./data rule list
  node app.ts -d ./data replenish
  node app.ts -d ./data rule delete P1 --wh W1
  node app.ts -d ./data plan save PL1 --transfer P1:W2:W1:T1 --purchase P1:W1:PO9:华东五金
  node app.ts -d ./data plan show PL1
  node app.ts -d ./data plan list
  node app.ts -d ./data plan execute PL1
  node app.ts -d ./data plan withdraw W1 --plan PL1 --transfer-rev T1:R9 --purchase-cancel PO9:X9
  node app.ts -d ./data balance P1
  node app.ts -d ./data balance P1 --wh W1
  node app.ts -d ./data flow --product P1
  node app.ts -d ./data flow --wh W2
  node app.ts -d ./data recon
  node app.ts -d ./data recon --from D2 --to A1 --product P1
  node app.ts -d ./data recon --to D3 --wh W1`;

function printHelp(): void {
  console.log(HELP);
}

/** 可能改变数据的命令（须先取得写入机会）；其余为只读查询，不创建协调文件。 */
function isWriteCommand(cmd: string, tokens: string[]): boolean {
  switch (cmd) {
    case 'in':
    case 'out':
    case 'transfer':
    case 'count':
    case 'reverse':
    case 'arrival':
    case 'cancel':
    case 'return':
    case 'po-transfer':
    case 'import':
      return true;
    case 'product':
      return tokens[0] === 'add';
    case 'po':
      return tokens[0] === 'register';
    case 'rule':
      return tokens[0] === 'set' || tokens[0] === 'delete' || tokens[0] === 'del';
    case 'plan':
      return (
        tokens[0] === 'save' || tokens[0] === 'execute' || tokens[0] === 'exec' || tokens[0] === 'withdraw'
      );
    default:
      return false;
  }
}

function run(argv: string[]): void {
  // 先抽出全局 -d/--data，其余按命令解析
  let dataDir = DEFAULT_DATA_DIR;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-d' || t === '--data') {
      if (i + 1 >= argv.length) throw new UsageError(`参数 ${t} 缺少数据目录取值`);
      dataDir = argv[++i];
    } else if (t.startsWith('--data=')) {
      dataDir = t.slice('--data='.length);
    } else {
      rest.push(t);
    }
  }

  if (rest.length === 0) {
    printHelp();
    return;
  }
  const cmd = rest[0];
  if ((cmd === '-h' || cmd === '--help') && rest.length === 1) {
    printHelp();
    return;
  }

  const tokens = rest.slice(1);
  // 仅凭命令行即可判断的用法错误（缺参数、未知选项、错误的明细格式等）必须在
  // 等待写入机会之前报出（退出 2），不创建任何协调文件；解析中顺带发现的业务
  // 类错误（如调拨两仓相同、标识为空白）不抢在等待前抛出，仍由取得写入机会后
  // 的同一套校验判定（退出 1）。库存、采购进度等需要读取已提交状态的业务校验
  // 当然也在取得写入机会之后完成。
  try {
    validateCli(cmd, tokens);
  } catch (e) {
    if (e instanceof UsageError) throw e;
  }
  // 写命令：先取得同一数据目录的写入机会，取得后才读取最新已提交状态，结束或
  // 失败都释放占用；只读命令不创建协调文件，直接读取当前已提交状态。
  const lock = isWriteCommand(cmd, tokens) ? acquireWriteLock(dataDir) : undefined;
  try {
    dispatch(cmd, tokens, dataDir);
  } finally {
    lock?.release();
  }
}

/**
 * 纯命令行校验：只检查“无需读取已提交状态”即可判定的用法错误（退出 2）。
 * 涉及库存余量、采购进度、编号占用、快照等已提交状态的业务拒绝不在此判定，
 * 仍由取得写入机会后的各命令处理（退出 1）。
 */
function validateCli(cmd: string, tokens: string[]): void {
  switch (cmd) {
    case 'in':
    case 'out':
    case 'transfer':
      parseDocArgs(cmd, tokens);
      return;
    case 'count':
      parseCountArgs(tokens);
      return;
    case 'reverse':
      parseReverseArgs(tokens);
      return;
    case 'arrival':
      parseArrivalArgs(tokens);
      return;
    case 'cancel':
      parseCancelArgs(tokens);
      return;
    case 'return':
      parseReturnArgs(tokens);
      return;
    case 'po-transfer':
      parseTransferArgs(tokens);
      return;
    case 'import':
      parseImportArgs(tokens);
      return;
    case 'product': {
      const sub = tokens[0];
      if (sub === 'add') {
        const args = parseArgs(tokens.slice(1), []);
        const [idRaw, nameRaw, ...extra] = args.positionals;
        if (idRaw === undefined || nameRaw === undefined || extra.length > 0)
          throw new UsageError('用法：product add <商品编号> <商品名称>');
        trimOrThrow('商品编号', idRaw);
        trimOrThrow('商品名称', nameRaw);
      } else if (sub === 'list' || sub === 'ls') {
        const args = parseArgs(tokens.slice(1), []);
        if (args.positionals.length > 0) throw new UsageError('用法：product list');
      } else {
        throw new UsageError(sub === undefined ? '用法：product <add|list> …' : `未知 product 子命令：${sub}`);
      }
      return;
    }
    case 'po': {
      const sub = tokens[0];
      if (sub === 'register') {
        parsePurchaseArgs(tokens.slice(1));
      } else if (sub === 'show') {
        const args = parseArgs(tokens.slice(1), []);
        const [poRaw, ...extra] = args.positionals;
        if (poRaw === undefined || extra.length > 0) throw new UsageError('用法：po show <采购编号>');
        trimOrThrow('采购编号', poRaw);
      } else if (sub === 'list' || sub === 'ls') {
        const args = parseArgs(tokens.slice(1), []);
        if (args.positionals.length > 0) throw new UsageError('用法：po list');
      } else {
        throw new UsageError(sub === undefined ? '用法：po <register|show|list> …' : `未知 po 子命令：${sub}`);
      }
      return;
    }
    case 'rule': {
      const sub = tokens[0];
      if (sub === 'set') {
        const args = parseArgs(tokens.slice(1), ['--wh', '--min', '--target']);
        const [pidRaw, ...extra] = args.positionals;
        if (pidRaw === undefined || extra.length > 0)
          throw new UsageError('用法：rule set <商品编号> --wh <仓库> --min <下限> --target <目标>');
        if (args.flags['--wh'] === undefined) throw new UsageError('补货规则必须提供 --wh <仓库>');
        if (args.flags['--min'] === undefined) throw new UsageError('补货规则必须提供 --min <下限>');
        if (args.flags['--target'] === undefined) throw new UsageError('补货规则必须提供 --target <目标>');
        trimOrThrow('商品编号', pidRaw);
        trimOrThrow('仓库标识', args.flags['--wh']);
        parseNonNegInt('下限', args.flags['--min']);
        parseNonNegInt('目标', args.flags['--target']);
      } else if (sub === 'list' || sub === 'ls') {
        const args = parseArgs(tokens.slice(1), []);
        if (args.positionals.length > 0) throw new UsageError('用法：rule list');
      } else if (sub === 'delete' || sub === 'del') {
        const args = parseArgs(tokens.slice(1), ['--wh']);
        const [pidRaw, ...extra] = args.positionals;
        if (pidRaw === undefined || extra.length > 0)
          throw new UsageError('用法：rule delete <商品编号> --wh <仓库>');
        if (args.flags['--wh'] === undefined) throw new UsageError('删除补货规则必须提供 --wh <仓库>');
        trimOrThrow('商品编号', pidRaw);
        trimOrThrow('仓库标识', args.flags['--wh']);
      } else {
        throw new UsageError(sub === undefined ? '用法：rule <set|list|delete> …' : `未知 rule 子命令：${sub}`);
      }
      return;
    }
    case 'plan': {
      const sub = tokens[0];
      if (sub === 'save') {
        parsePlanSaveArgs(tokens.slice(1));
      } else if (sub === 'execute' || sub === 'exec') {
        const args = parseArgs(tokens.slice(1), []);
        const [planRaw, ...extra] = args.positionals;
        if (planRaw === undefined || extra.length > 0) throw new UsageError('用法：plan execute <方案编号>');
        trimOrThrow('方案编号', planRaw);
      } else if (sub === 'withdraw') {
        parsePlanWithdrawArgs(tokens.slice(1));
      } else if (sub === 'show') {
        const args = parseArgs(tokens.slice(1), []);
        const [planRaw, ...extra] = args.positionals;
        if (planRaw === undefined || extra.length > 0) throw new UsageError('用法：plan show <方案编号>');
        trimOrThrow('方案编号', planRaw);
      } else if (sub === 'list' || sub === 'ls') {
        const args = parseArgs(tokens.slice(1), []);
        if (args.positionals.length > 0) throw new UsageError('用法：plan list');
      } else {
        throw new UsageError(
          sub === undefined ? '用法：plan <save|show|list|execute|withdraw> …' : `未知 plan 子命令：${sub}`,
        );
      }
      return;
    }
    case 'balance': {
      const args = parseArgs(tokens, ['--wh']);
      const [pidRaw, ...extra] = args.positionals;
      if (pidRaw === undefined || extra.length > 0)
        throw new UsageError('用法：balance <商品编号> [--wh <仓库>]');
      trimOrThrow('商品编号', pidRaw);
      if (args.flags['--wh'] !== undefined) trimOrThrow('仓库标识', args.flags['--wh']);
      return;
    }
    case 'flow': {
      const args = parseArgs(tokens, ['--product', '--wh']);
      if (args.positionals.length > 0)
        throw new UsageError('用法：flow (--product <商品编号> | --wh <仓库>)…');
      if (args.flags['--product'] === undefined && args.flags['--wh'] === undefined)
        throw new UsageError('flow 至少需要一个过滤条件：--product <商品编号> 和/或 --wh <仓库>');
      if (args.flags['--product'] !== undefined) trimOrThrow('商品编号', args.flags['--product']);
      if (args.flags['--wh'] !== undefined) trimOrThrow('仓库标识', args.flags['--wh']);
      return;
    }
    case 'recon': {
      const args = parseArgs(tokens, ['--from', '--to', '--product', '--wh']);
      if (args.positionals.length > 0)
        throw new UsageError(
          '用法：recon [--from <起点单据编号>] [--to <终点单据编号>] [--product <商品编号>] [--wh <仓库>]',
        );
      for (const [k, label] of [['--from', '起点单据编号'], ['--to', '终点单据编号'], ['--product', '商品编号'], ['--wh', '仓库标识']] as const) {
        if (args.flags[k] !== undefined) trimOrThrow(label, args.flags[k]);
      }
      return;
    }
    case 'replenish': {
      const args = parseArgs(tokens, []);
      if (args.positionals.length > 0) throw new UsageError('用法：replenish');
      return;
    }
    default:
      throw new UsageError(`未知命令：${cmd}（使用 --help 查看可用命令）`);
  }
}

/** reverse 的纯命令行解析（抽出以便等待前校验复用）。 */
function parseReverseArgs(tokens: string[]): { revId: string; origId: string } {
  const args = parseArgs(tokens, ['--orig']);
  const revRaw = args.positionals[0];
  if (revRaw === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：reverse <冲销单编号> --orig <原单编号>');
  if (args.flags['--orig'] === undefined)
    throw new UsageError('冲销必须通过 --orig <原单编号> 指定被冲销的原单');
  return {
    revId: trimOrThrow('冲销单编号', revRaw),
    origId: trimOrThrow('原单编号', args.flags['--orig']),
  };
}

/** import 的纯命令行解析；导入文件内容本身在取得写入机会后才读取与解析。 */
function parseImportArgs(tokens: string[]): { file: string } {
  const args = parseArgs(tokens, ['--file']);
  if (args.flags['--file'] === undefined || args.positionals.length > 0)
    throw new UsageError('用法：import --file <单据列表 JSON 文件>');
  return { file: args.flags['--file'] };
}

function dispatch(cmd: string, tokens: string[], dataDir: string): void {
  switch (cmd) {
    case 'product': {
      const store = loadStore(dataDir);
      runProduct(tokens, dataDir, store);
      break;
    }
    case 'in':
    case 'out':
    case 'transfer': {
      const req = parseDocArgs(cmd, tokens);
      const store = loadStore(dataDir);
      const ledger = new Ledger(store);
      const outcome = ledger.applyDoc(req);
      ledger.commit(dataDir);
      if (outcome.duplicate) {
        console.log(`单据 ${req.docId} 为重复提交，业务内容与原提交一致，返回原提交结果（库存与流水不变）：`);
      } else {
        console.log(outcome.header);
      }
      for (const line of outcome.lines) console.log(line);
      break;
    }
    case 'count': {
      const req = parseCountArgs(tokens);
      const store = loadStore(dataDir);
      const ledger = new Ledger(store);
      const outcome = ledger.applyCount(req);
      ledger.commit(dataDir);
      if (outcome.duplicate) {
        console.log(`盘点单 ${req.docId} 为重复提交，业务内容与原提交一致，返回原提交结果（库存与流水不变）：`);
      } else {
        console.log(outcome.header);
      }
      for (const line of outcome.lines) console.log(line);
      break;
    }
    case 'reverse': {
      const store = loadStore(dataDir);
      runReverse(tokens, dataDir, store);
      break;
    }
    case 'po': {
      const store = loadStore(dataDir);
      runPo(tokens, dataDir, store);
      break;
    }
    case 'arrival': {
      const store = loadStore(dataDir);
      runArrival(tokens, dataDir, store);
      break;
    }
    case 'cancel': {
      const store = loadStore(dataDir);
      runCancel(tokens, dataDir, store);
      break;
    }
    case 'return': {
      const store = loadStore(dataDir);
      runReturn(tokens, dataDir, store);
      break;
    }
    case 'po-transfer': {
      const store = loadStore(dataDir);
      runPoTransfer(tokens, dataDir, store);
      break;
    }
    case 'import': {
      runImport(tokens, dataDir);
      break;
    }
    case 'balance': {
      const store = loadStore(dataDir);
      runBalance(tokens, store);
      break;
    }
    case 'rule': {
      const store = loadStore(dataDir);
      runRule(tokens, dataDir, store);
      break;
    }
    case 'replenish': {
      const store = loadStore(dataDir);
      runReplenish(tokens, store);
      break;
    }
    case 'plan': {
      const store = loadStore(dataDir);
      runPlan(tokens, dataDir, store);
      break;
    }
    case 'flow': {
      const store = loadStore(dataDir);
      runFlow(tokens, store);
      break;
    }
    case 'recon': {
      const store = loadStore(dataDir);
      runRecon(tokens, store);
      break;
    }
    default:
      throw new UsageError(`未知命令：${cmd}（使用 --help 查看可用命令）`);
  }
}

try {
  run(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`${APP_NAME}: ${e.message}`);
    process.exit(2);
  }
  if (e instanceof BizError || e instanceof DataError) {
    console.error(`${APP_NAME}: ${e.message}`);
    process.exit(1);
  }
  console.error(`${APP_NAME}: 发生未预期错误：${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
}
