#!/usr/bin/env node
// stockroom —— 本地多仓库存台账（Node.js 24，TypeScript，无外部运行依赖）

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  resultLines: string[]; // 登记结果，供幂等重放
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
  rules: Record<string, Record<string, ReplenishRule>>; // 补货规则：商品 -> 仓库 -> 下限/目标（每组合唯一）
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
    rules: nullProto(),
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
      const ordered = nullProto<Record<string, number>>();
      for (const [pid, qty] of Object.entries(rec.ordered)) {
        if (pid.trim() === '' || !isPosSafeInt(qty)) throw bad(`采购单 ${poId} 存在非法订购明细`);
        ordered[pid] = qty;
      }
      if (Object.keys(ordered).length === 0) throw bad(`采购单 ${poId} 至少需要一种商品`);
      store.purchases[poId] = {
        poId, supplier: rec.supplier, wh: rec.wh, ordered, resultLines: rec.resultLines,
      };
    }
  }

  // arrivals 为新增字段：合法旧数据没有该字段，按空集合处理。
  // 到货单与入库/出库/调拨/盘点/冲销单共用全局唯一编号空间。
  if (data.arrivals !== undefined) {
    if (!isPlainObject(data.arrivals)) throw bad('arrivals 不是对象');
    for (const [arrId, rec] of Object.entries(data.arrivals)) {
      if (typeof arrId !== 'string' || arrId.trim() === '') throw bad('存在非法到货单编号');
      if (store.docs[arrId] !== undefined) throw bad(`到货单编号 ${arrId} 与原始库存单据编号冲突`);
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
      const origRec = store.docs[rec.orig];
      const origArr = store.arrivals[rec.orig];
      const origCan = store.cancels[rec.orig];
      const origRet = store.returns[rec.orig];
      if (origRec === undefined && origArr === undefined && origCan === undefined && origRet === undefined) {
        // 用 data.reversals 判定，避免依赖键的先后顺序（此时 store.reversals 可能尚未装全）
        if (isPlainObject((data.reversals as Record<string, unknown>)[rec.orig]))
          throw bad(`冲销单 ${rec.orig} 不可被再次冲销（冲销单不能冲销冲销单）`);
        if (store.purchases[rec.orig] !== undefined)
          throw bad(`冲销单 ${revId} 指向的 ${rec.orig} 是采购单，采购单不可冲销`);
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
  // 取消单冲销不产生库存流水（取消本身不改库存），故不要求、也不允许携带流水。
  const revIdsWithEntries = nullProto<Record<string, boolean>>();
  for (const [revId, rev] of Object.entries(store.reversals)) {
    const origDoc = store.docs[rev.orig];
    // 原单为取消单时（前面已确认必为库存单/到货单/取消单/退货单之一）不应存在任何冲销流水
    let expected: EntryType | undefined;
    if (origDoc !== undefined) expected = `${origDoc.content.type}-rev` as EntryType;
    else if (store.arrivals[rev.orig] !== undefined) expected = 'arrival-rev';
    else if (store.returns[rev.orig] !== undefined) expected = 'return-rev';
    for (const e of store.entries) {
      if (e.doc !== revId) continue;
      if (expected === undefined)
        throw bad(`冲销单 ${revId} 冲销的是取消单 ${rev.orig}，不应携带库存流水`);
      revIdsWithEntries[revId] = true;
      if (e.type !== expected)
        throw bad(`冲销单 ${revId} 的流水类型与原单 ${rev.orig} 的业务类型不一致`);
    }
    if (expected !== undefined) revIdsWithEntries[revId] ??= false;
  }
  for (const revId of Object.keys(store.reversals)) {
    if (revIdsWithEntries[revId] === false) throw bad(`冲销单 ${revId} 缺少冲销流水`);
  }

  // 采购进度不变量：有效到货 = 未冲销到货 - 未冲销退货；任一商品
  // “有效到货 + 未冲销累计取消”不得超过订购量
  // （待到货量 = 订购量 - 有效到货量 - 有效取消量，不得为负）。
  // 注意：退货释放待到货后允许再次到货，故未冲销到货总量本身可以超过订购量，
  // 甚至可以超过安全整数范围（反复退货、补收）——必须先抵减未冲销退货再校验，
  // 且全程用 BigInt 精确累计，不得因中间累计舍入而改变净量或误拒合法数据。
  for (const [poId, po] of Object.entries(store.purchases)) {
    const arrived = nullProto<Record<string, bigint>>();
    for (const [arrId, arr] of Object.entries(store.arrivals)) {
      if (arr.poId !== poId) continue;
      const isReversed = Object.values(store.reversals).some((r) => r.orig === arrId);
      if (isReversed) continue; // 已整单冲销的到货不再计入有效到货
      for (const [pid, q] of Object.entries(arr.qty)) {
        arrived[pid] = (arrived[pid] ?? 0n) + BigInt(q);
      }
    }
    // 未冲销退货抵减有效到货（前面已保证其原到货单未冲销且不超退）
    for (const [retId, ret] of Object.entries(store.returns)) {
      if (ret.poId !== poId) continue;
      const isReversed = Object.values(store.reversals).some((r) => r.orig === retId);
      if (isReversed) continue;
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
      if (can.poId !== poId) continue;
      const isReversed = Object.values(store.reversals).some((r) => r.orig === canId);
      if (isReversed) continue; // 已整单冲销的取消不再计入有效取消
      for (const [pid, q] of Object.entries(can.qty)) {
        cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
        if ((arrived[pid] ?? 0n) + cancelled[pid] > BigInt(po.ordered[pid]))
          throw bad(`采购单 ${poId} 商品 ${pid} 有效到货与有效取消合计超过订购量（待到货量为负）`);
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

  return store;
}

function saveStore(dataDir: string, store: Store): void {
  const path = dataPath(dataDir);
  const tmp = join(dataDir, `.${DATA_FILENAME}.${process.pid}.tmp`);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    throw new DataError(`保存数据失败，已有数据保持不变：${(e as Error).message}`);
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

// ---------- 整批导入文件解析 ----------

type ImportRequest =
  | { kind: 'doc'; req: DocRequest }
  | { kind: 'count'; req: CountRequest }
  | { kind: 'reverse'; docId: string; orig: string }
  | { kind: 'po'; req: PurchaseRequest }
  | { kind: 'arrival'; req: ArrivalRequest }
  | { kind: 'cancel'; req: CancelRequest }
  | { kind: 'return'; req: ReturnRequest };

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
      default:
        throw at(i, `不支持的业务类型 "${String(item.type)}"，只允许 in、out、transfer、count、reverse、po、arrival、cancel、return`);
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
  private readonly reversedOrigs = new Set<string>();
  private readonly newDocIds: string[] = [];
  private readonly newRevIds: string[] = [];
  private readonly newPoIds: string[] = [];
  private readonly newArrivalIds: string[] = [];
  private readonly newCancelIds: string[] = [];
  private readonly newReturnIds: string[] = [];

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
  }

  /** 是否有新生效单据：无新单据（全部重复）时 commit 不改写数据。 */
  get changed(): boolean {
    return (
      this.newDocIds.length +
      this.newRevIds.length +
      this.newPoIds.length +
      this.newArrivalIds.length +
      this.newCancelIds.length +
      this.newReturnIds.length > 0
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

  /** 计算某采购单各商品当前“未冲销累计取消”（仅计入尚未被整单冲销的取消单）；BigInt 精确累计。 */
  private effectiveCancelled(poId: string): Record<string, bigint> {
    const cancelled = nullProto<Record<string, bigint>>();
    for (const [canId, can] of Object.entries(this.cancels)) {
      if (can.poId !== poId || this.reversedOrigs.has(canId)) continue;
      for (const [pid, q] of Object.entries(can.qty)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
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
    // 与入库/出库/调拨/盘点/取消/冲销单共用唯一编号空间（采购单编号空间独立，不在此列）
    if (this.docs[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.revs[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于冲销单，拒绝提交`);
    if (this.cancels[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于取消单，拒绝提交`);
    if (this.returns[req.arrId] !== undefined)
      throw new BizError(`单据编号 ${req.arrId} 已用于退货单，拒绝提交`);

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
    // 与入库/出库/调拨/盘点/到货/冲销单共用唯一编号空间（采购单编号空间独立，不在此列）
    if (this.docs[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.arrivals[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于到货单，拒绝提交`);
    if (this.revs[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于冲销单，拒绝提交`);
    if (this.returns[req.canId] !== undefined)
      throw new BizError(`单据编号 ${req.canId} 已用于退货单，拒绝提交`);

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
    // 与入库/出库/调拨/盘点/到货/取消/冲销单共用唯一编号空间（采购单编号空间独立，不在此列）
    if (this.docs[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于入库/出库/调拨/盘点单，拒绝提交`);
    if (this.arrivals[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于取消单，拒绝提交`);
    if (this.revs[req.retId] !== undefined)
      throw new BizError(`单据编号 ${req.retId} 已用于冲销单，拒绝提交`);

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

  private repeatedRevSource(revId: string): 'store' | 'batch' {
    return this.base.reversals[revId] !== undefined ? 'store' : 'batch';
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
    // 编号空间与出库/入库/调拨/盘点/到货/取消/冲销单共用
    if (this.revs[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于冲销单，拒绝提交`);
    if (this.arrivals[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于取消单，拒绝提交`);
    if (this.returns[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于退货单，拒绝提交`);

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
    // 编号空间与入库/出库/调拨/到货/取消/冲销单共用
    if (this.revs[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于冲销单，拒绝提交`);
    if (this.arrivals[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于到货单，拒绝提交`);
    if (this.cancels[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于取消单，拒绝提交`);
    if (this.returns[req.docId] !== undefined)
      throw new BizError(`单据编号 ${req.docId} 已用于退货单，拒绝提交`);

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
    // 冲销单与入库/出库/调拨/盘点/到货/取消/退货共用唯一编号空间
    if (this.docs[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是入库/出库/调拨/盘点单编号，不能用作冲销单，拒绝提交`);
    if (this.arrivals[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是到货单编号，不能用作冲销单，拒绝提交`);
    if (this.cancels[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是取消单编号，不能用作冲销单，拒绝提交`);
    if (this.returns[revId] !== undefined)
      throw new BizError(`编号 ${revId} 已是退货单编号，不能用作冲销单，拒绝提交`);

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

    // 只能冲销成功的原始库存单据：不存在（含列表中尚未出现）的原单、冲销单本身均不可冲销
    const origRec = this.docs[origId];
    if (origRec === undefined) {
      if (this.revs[origId] !== undefined)
        throw new BizError(`原单 ${origId} 是冲销单，冲销单不可冲销，拒绝提交`);
      if (this.pos[origId] !== undefined)
        throw new BizError(`原单 ${origId} 是采购单，采购单不可冲销，拒绝提交`);
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
   * 统一提交：把草稿余量、新增流水、新单据去重记录、采购单、到货单、取消单、退货单
   * 与冲销关系写回 base 并原子保存。全部项均为重复时不写回、不保存（不改写数据）。
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

function runReverse(rest: string[], dataDir: string, store: Store): void {
  const args = parseArgs(rest, ['--orig']);
  const revRaw = args.positionals[0];
  if (revRaw === undefined || args.positionals.length !== 1)
    throw new UsageError('用法：reverse <冲销单编号> --orig <原单编号>');
  if (args.flags['--orig'] === undefined)
    throw new UsageError('冲销必须通过 --orig <原单编号> 指定被冲销的原单');
  const revId = trimOrThrow('冲销单编号', revRaw);
  const origId = trimOrThrow('原单编号', args.flags['--orig']);
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
 * 累计总量可超过安全整数范围（反复退货、补收），一律用 BigInt 精确累计，
 * 合计与记录枚举顺序无关；有效退货合计即使超过安全整数范围也能完整显示。
 */
function purchaseProgress(store: Store, poId: string): {
  effective: Record<string, bigint>;
  returned: Record<string, bigint>;
  cancelled: Record<string, bigint>;
  remaining: Record<string, bigint>;
} {
  const effective = nullProto<Record<string, bigint>>();
  for (const [arrId, arr] of Object.entries(store.arrivals)) {
    if (arr.poId !== poId) continue;
    const isReversed = Object.values(store.reversals).some((r) => r.orig === arrId);
    if (isReversed) continue;
    for (const [pid, q] of Object.entries(arr.qty)) effective[pid] = (effective[pid] ?? 0n) + BigInt(q);
  }
  const returned = nullProto<Record<string, bigint>>();
  for (const [retId, ret] of Object.entries(store.returns)) {
    if (ret.poId !== poId) continue;
    const isReversed = Object.values(store.reversals).some((r) => r.orig === retId);
    if (isReversed) continue;
    for (const [pid, q] of Object.entries(ret.qty)) {
      returned[pid] = (returned[pid] ?? 0n) + BigInt(q);
      effective[pid] = (effective[pid] ?? 0n) - BigInt(q); // 未冲销退货抵减有效到货
    }
  }
  const cancelled = nullProto<Record<string, bigint>>();
  for (const [canId, can] of Object.entries(store.cancels)) {
    if (can.poId !== poId) continue;
    const isReversed = Object.values(store.reversals).some((r) => r.orig === canId);
    if (isReversed) continue;
    for (const [pid, q] of Object.entries(can.qty)) cancelled[pid] = (cancelled[pid] ?? 0n) + BigInt(q);
  }
  const po = store.purchases[poId];
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
  // 该采购单是否存在取消/退货记录（含已冲销）：无取消、无退货的采购单展示行为保持不变
  const cancelIds = Object.keys(store.cancels)
    .filter((id) => store.cancels[id].poId === poId)
    .sort();
  const hasCancels = cancelIds.length > 0;
  const returnIds = Object.keys(store.returns)
    .filter((id) => store.returns[id].poId === poId)
    .sort();
  const hasReturns = returnIds.length > 0;

  console.log(`采购单 ${poId}：供应商 ${po.supplier}，收货仓 ${po.wh}，共 ${Object.keys(po.ordered).length} 种商品`);
  const cols = ['商品', '订购', '有效到货'];
  if (hasReturns) cols.push('有效退货');
  if (hasCancels) cols.push('有效取消');
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
    if (hasCancels) row.push(can);
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

/**
 * 整批导入：按列表顺序在同一份草稿上处理各项，后项可见前项生效结果；
 * 任一项失败整批拒绝（此前已保存的单据不撤销，本批任何变动均不落库）。
 * 全部重复时不改写数据。逐项输出编号、首次生效/重复（及重复来源）状态与提交结果。
 */
function runImport(rest: string[], dataDir: string): void {
  const args = parseArgs(rest, ['--file']);
  const file = args.flags['--file'];
  if (file === undefined || args.positionals.length > 0)
    throw new UsageError('用法：import --file <单据列表 JSON 文件>');

  // 先完整读取并解析文件：文件不可读/解析失败时绝不触碰已提交状态
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
  reverse <冲销单编号> --orig <原单编号>     整单冲销已成功的入库/出库/调拨/盘点/到货/取消/退货单
  import --file <单据列表.json>              整批导入有序单据列表（按顺序生效，整批成败一致）
  rule set <商品编号> --wh <仓库> \\
           --min <下限> --target <目标>                    设置补货规则（同组合再次设置整体替换）
  rule list                                 列出全部补货规则
  rule delete <商品编号> --wh <仓库>         删除补货规则
  replenish                                 跨仓补货建议（先用可调拨实存，不足再建议采购；只读）
  balance <商品编号> [--wh <仓库>]           查询余量；省略 --wh 查询各仓
  flow --product <编号> [--wh <仓库>]        按商品/仓库查询流水（至少一个过滤条件）
       | --wh <仓库> [--product <编号>]
  -h, --help                                显示本帮助

规则：
  数量必须为正安全整数；同单同商品的重复明细先合并，再做足量与溢出校验；
  任一明细不合法则整单拒绝。入库/出库/调拨/盘点/到货/取消/退货/冲销单据编号在同一数据
  目录内共用全局唯一编号空间，相同内容重复提交返回原结果且不重复变动，同编号不
  同内容或不同业务拒绝；失败提交不占用编号。采购编号独立于库存单据编号空间，
  允许与库存/到货/取消/退货/冲销单同名。所有标识与名称去首尾空白后非空、区分大小写。

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

冲销规则：
  冲销在“当前余量”上应用原单的相反变动，不回滚原单之后的其他业务、不恢复绝对
  余量：冲销入库从原目标仓扣回；冲销出库向原来源仓补回；冲销调拨从原调入仓扣
  回并向原调出仓补回；冲销盘点在当前余量上减去原盘点差额（零差额不改余量，
  但仍记录冲销关系与流水）；冲销到货从采购单收货仓扣回原数量并减少有效到货量，
  已收齐的采购相应数量重新待收（不撤掉取消）；冲销取消移除该取消单的有效取消
  量、恢复相应待收量，不改库存、不产生库存流水；冲销退货向原收货仓当前余量补
  回原退货量、恢复有效到货。数量取原单合并后的明细。任一商品扣回不足、补回后
  溢出、冲减后为负，或冲销退货后“有效到货 + 有效取消”超过订购量，则整单拒绝、
  不占用冲销单编号、原单不标记冲销，条件改善后可重试。
  只能冲销成功的原始库存单据、到货单、取消单与退货单；原单不存在、采购单、冲
  销单本身、已冲销过的原单均不能再次冲销，每张原单最多冲销一次。有未冲销退货
  的到货单禁止冲销，相关退货全部冲销后可按原规则冲销到货。冲销成功后重放原单
  （含到货单、取消单、退货单）仍只返回其最初结果，不会重新生效；重放冲销单返
  回原冲销结果，不再变动，同编号改指其他原单则拒绝。

整批导入规则：
  import --file <文件> 从本地 JSON 文件读取“有序单据对象数组”（至少一项），按
  列表顺序在同一批次中处理：新单据以此前各项生效后的余量核对并计算，后项可以
  使用前项入库/到货所得库存；到货、取消可引用导入前已登记或列表中此前登记的
  采购单，退货可引用导入前已成功或列表中此前成功的到货单，其超收/超取消/超退
  校验针对此前各项生效后的采购进度；盘点核对的是此前各项之后的账面量；冲销可
  指向导入前已成功的原单（含到货单、取消单、退货单）或列表中此前的新原单，
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
    冲销 {"type":"reverse","id":"R1","orig":"D1"}
  入出库、调拨、采购、到货、取消、退货的 qty/订购量为正安全整数，同商品明细先
  合并再校验；盘点 expected/actual 均为非负安全整数，同商品重复拒绝。库存、到
  货、取消、退货、冲销单据编号与单条命令共用唯一空间，采购编号独立；不产生批
  次编号：导入前已有或本列表此前出现的“同编号同内容”项只返回原结果，不重新
  核对、不追加流水（即使原单已冲销也不重新生效）；普通单比较类型、仓库及合并
  后商品数量，盘点比较仓库及两种数量，采购比较供应商、收货仓及订购量，到货、
  取消比较采购编号及合并数量，退货比较原到货单编号及合并数量，冲销比较原单编
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
  node app.ts -d ./data import --file ./docs.json
  node app.ts -d ./data rule set P1 --wh W1 --min 5 --target 20
  node app.ts -d ./data rule list
  node app.ts -d ./data replenish
  node app.ts -d ./data rule delete P1 --wh W1
  node app.ts -d ./data balance P1
  node app.ts -d ./data balance P1 --wh W1
  node app.ts -d ./data flow --product P1
  node app.ts -d ./data flow --wh W2`;

function printHelp(): void {
  console.log(HELP);
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
    case 'flow': {
      const store = loadStore(dataDir);
      runFlow(tokens, store);
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
