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
type EntryType = DocType | 'count' | 'in-rev' | 'out-rev' | 'transfer-rev' | 'count-rev';

interface LedgerEntry {
  seq: number; // 全局流水序号，即提交顺序
  doc: string; // 单据编号（冲销流水此处为冲销单编号）
  type: EntryType;
  product: string;
  wh: string; // 本流水条目变动余量的仓库
  qty?: number; // 入库/出库/调拨类流水：恒为正数，方向由类型 / 出入仓决定；盘点类流水不用此字段
  before: number;
  after: number;
  from?: string; // 调拨（或冲销调拨）的调出仓
  to?: string; // 调拨（或冲销调拨）的调入仓
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

interface Store {
  version: 1;
  products: Record<string, string>; // 编号 -> 名称（编号区分大小写；null 原型，防特殊键串改）
  stock: Record<string, Record<string, number>>; // 商品 -> 仓库 -> 余量
  entries: LedgerEntry[];
  docs: Record<string, DocRecord>; // 入库/出库/调拨单去重与结果
  reversals: Record<string, ReversalRecord>; // 冲销单去重与结果
}

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
    const isRev =
      e.type === 'in-rev' || e.type === 'out-rev' || e.type === 'transfer-rev' || e.type === 'count-rev';
    const isOrig = e.type === 'in' || e.type === 'out' || e.type === 'transfer' || e.type === 'count';
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
      if (e.qty !== undefined || e.from !== undefined || e.to !== undefined)
        throw bad('盘点流水不应携带数量或调拨字段');
    } else {
      if (!isPosSafeInt(e.qty)) throw bad('流水数量非法');
      if (e.expected !== undefined || e.actual !== undefined || e.diff !== undefined)
        throw bad('非盘点流水不应携带盘点字段');
      const delta = e.after - e.before;
      if (e.type === 'transfer' || e.type === 'transfer-rev') {
        if (typeof e.from !== 'string' || e.from.trim() === '' || typeof e.to !== 'string' || e.to.trim() === '')
          throw bad('调拨流水缺少调出/调入仓');
        // 调拨：调入仓增加；冲销调拨：原调入仓扣回、原调出仓补回
        const expect = (e.wh === e.to) === (e.type === 'transfer') ? e.qty : -e.qty;
        if (delta !== expect) throw bad('流水差额与前后余量不一致');
      } else {
        const increases = e.type === 'in' || e.type === 'out-rev';
        if (delta !== (increases ? e.qty : -e.qty)) throw bad('流水差额与前后余量不一致');
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

  // reversals 为新增字段：合法旧数据没有该字段，按空集合处理
  if (data.reversals !== undefined) {
    if (!isPlainObject(data.reversals)) throw bad('reversals 不是对象');
    for (const [revId, rec] of Object.entries(data.reversals)) {
      if (typeof revId !== 'string' || revId.trim() === '') throw bad('存在非法冲销单编号');
      if (!isPlainObject(rec) || typeof rec.orig !== 'string' || rec.orig.trim() === '' ||
          !Array.isArray(rec.resultLines) || !rec.resultLines.every((l) => typeof l === 'string'))
        throw bad(`冲销单 ${revId} 的记录非法`);
      const origRec = store.docs[rec.orig];
      if (origRec === undefined) throw bad(`冲销单 ${revId} 指向的原单 ${rec.orig} 不存在`);
      if (store.docs[revId] !== undefined) throw bad(`冲销单编号 ${revId} 与原始单据编号冲突`);
      store.reversals[revId] = { orig: rec.orig, resultLines: rec.resultLines };
    }
    // 每张原单最多被成功冲销一次
    const origSeen = nullProto<Record<string, string>>();
    for (const [revId, rec] of Object.entries(store.reversals)) {
      if (origSeen[rec.orig] !== undefined)
        throw bad(`原单 ${rec.orig} 被多张冲销单关联（${origSeen[rec.orig]}、${revId}）`);
      origSeen[rec.orig] = revId;
    }
    // 冲销流水必须能找到所属冲销单
    for (const e of store.entries) {
      if ((e.type === 'in-rev' || e.type === 'out-rev' || e.type === 'transfer-rev' || e.type === 'count-rev') &&
          store.reversals[e.doc] === undefined)
        throw bad(`流水引用了不存在的冲销单 ${e.doc}`);
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

interface SubmitOutcome {
  duplicate: boolean;
  lines: string[];
}

/** 整单先校验、模拟，全部合法后才一次性应用到内存（不保存）；任一明细失败则全部保持原状。 */
function applyDocument(store: Store, req: DocRequest): SubmitOutcome {
  const content = canonicalContent(req);
  const existed = store.docs[req.docId];
  if (existed !== undefined) {
    if (stableStringify(existed.content) !== stableStringify(content))
      throw new BizError(`单据编号 ${req.docId} 已用于业务内容不同的单据，拒绝提交`);
    return { duplicate: true, lines: existed.resultLines }; // 幂等：返回原结果，不动库存
  }
  // 编号空间与出库/入库/调拨/冲销单共用
  if (store.reversals[req.docId] !== undefined)
    throw new BizError(`单据编号 ${req.docId} 已用于冲销单，拒绝提交`);

  for (const pid of req.items.keys()) {
    if (store.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
  }

  const draft: Store['stock'] = cloneStock(store.stock);
  const additions: LedgerEntry[] = [];
  const reportLines: string[] = [];
  let seq = store.entries.length;
  const typeLabel = req.type === 'in' ? '入库' : req.type === 'out' ? '出库' : '调拨';

  for (const pid of [...req.items.keys()].sort()) {
    const qty = req.items.get(pid)!;

    if (req.type === 'in') {
      const wh = req.wh!;
      const before = getStock(draft, pid, wh);
      const after = before + qty;
      if (after > MAX_SAFE) throw new BizError(`商品 ${pid} 入库后余量超出安全整数范围，拒绝整单`);
      setStock(draft, pid, wh, after);
      additions.push({ seq: ++seq, doc: req.docId, type: 'in', product: pid, wh, qty, before, after });
      reportLines.push(`入库 ${pid} @${wh} +${qty}：${before} -> ${after}`);
    } else if (req.type === 'out') {
      const wh = req.wh!;
      const before = getStock(draft, pid, wh);
      if (before < qty)
        throw new BizError(`商品 ${pid} 仓库 ${wh} 余量不足（当前 ${before}，需出库 ${qty}），拒绝整单`);
      const after = before - qty;
      setStock(draft, pid, wh, after);
      additions.push({ seq: ++seq, doc: req.docId, type: 'out', product: pid, wh, qty, before, after });
      reportLines.push(`出库 ${pid} @${wh} -${qty}：${before} -> ${after}`);
    } else {
      const from = req.from!;
      const to = req.to!;
      const beforeFrom = getStock(draft, pid, from);
      if (beforeFrom < qty)
        throw new BizError(`商品 ${pid} 调出仓 ${from} 余量不足（当前 ${beforeFrom}，需调拨 ${qty}），拒绝整单`);
      const afterFrom = beforeFrom - qty;
      const beforeTo = getStock(draft, pid, to);
      const afterTo = beforeTo + qty;
      if (afterTo > MAX_SAFE) throw new BizError(`商品 ${pid} 调入后余量超出安全整数范围，拒绝整单`);
      setStock(draft, pid, from, afterFrom);
      setStock(draft, pid, to, afterTo);
      additions.push({
        seq: ++seq, doc: req.docId, type: 'transfer', product: pid, wh: from,
        qty, before: beforeFrom, after: afterFrom, from, to,
      });
      additions.push({
        seq: ++seq, doc: req.docId, type: 'transfer', product: pid, wh: to,
        qty, before: beforeTo, after: afterTo, from, to,
      });
      reportLines.push(
        `调拨 ${pid} ${from} -> ${to} ${qty}：${from} ${beforeFrom}->${afterFrom}；${to} ${beforeTo}->${afterTo}`,
      );
    }
  }

  // 全部明细合法：一次性应用到内存（由调用方决定何时保存）
  store.stock = draft;
  store.entries.push(...additions);
  store.docs[req.docId] = { content, resultLines: reportLines };

  return {
    duplicate: false,
    lines: [`${typeLabel}单 ${req.docId} 提交成功，共 ${req.items.size} 种商品：`, ...reportLines],
  };
}

function canonicalCountContent(req: CountRequest): Record<string, unknown> {
  const items: Record<string, unknown> = nullProto();
  for (const pid of [...req.items.keys()].sort()) {
    const it = req.items.get(pid)!;
    items[pid] = { expected: it.expected, actual: it.actual };
  }
  return { type: 'count', wh: req.wh, items };
}

/**
 * 整单盘点校正：首次提交先逐项核对当前余量与预期账面量，任一不符整单拒绝并
 * 说明冲突商品及当前量；全部相符才把列出的商品校正为实盘量（差额 = 实盘 - 账面，
 * 可增、可减、可为零），未列出的商品及其他仓库不变。同编号同内容重放只返回原
 * 结果，即使余量改变或盘点已冲销也不再核对、不再生效。
 */
function applyCount(store: Store, req: CountRequest): SubmitOutcome {
  const content = canonicalCountContent(req);
  const existed = store.docs[req.docId];
  if (existed !== undefined) {
    if (stableStringify(existed.content) !== stableStringify(content))
      throw new BizError(`单据编号 ${req.docId} 已用于业务内容不同的单据，拒绝提交`);
    return { duplicate: true, lines: existed.resultLines }; // 幂等：返回原结果，不动库存
  }
  // 编号空间与入库/出库/调拨/冲销单共用
  if (store.reversals[req.docId] !== undefined)
    throw new BizError(`单据编号 ${req.docId} 已用于冲销单，拒绝提交`);

  const pids = [...req.items.keys()].sort();
  for (const pid of pids) {
    if (store.products[pid] === undefined) throw new BizError(`商品未登记，拒绝整单：${pid}`);
  }

  // 账面核对：任一商品的当前余量与预期账面量不符，整单拒绝并说明冲突商品及当前量
  const conflicts: string[] = [];
  for (const pid of pids) {
    const current = getStock(store.stock, pid, req.wh);
    const expected = req.items.get(pid)!.expected;
    if (current !== expected)
      conflicts.push(`商品 ${pid}：当前余量 ${current}，预期账面量 ${expected}`);
  }
  if (conflicts.length > 0)
    throw new BizError(`盘点单 ${req.docId} 账面核对不符，拒绝整单：\n${conflicts.join('\n')}`);

  const draft: Store['stock'] = cloneStock(store.stock);
  const additions: LedgerEntry[] = [];
  const reportLines: string[] = [];
  let seq = store.entries.length;

  for (const pid of pids) {
    const { expected, actual } = req.items.get(pid)!;
    const before = getStock(draft, pid, req.wh); // 核对通过，与预期账面量一致
    const after = actual;
    const diff = actual - expected; // 差额 = 实盘 - 账面，可增、可减、可为零
    setStock(draft, pid, req.wh, after);
    additions.push({
      seq: ++seq, doc: req.docId, type: 'count', product: pid, wh: req.wh,
      expected, actual, diff, before, after,
    });
    reportLines.push(
      `盘点 ${pid} @${req.wh} 账面=${expected} 实盘=${actual} 差额=${fmtSigned(diff)}：${before} -> ${after}`,
    );
  }

  // 全部明细合法：一次性应用到内存（由调用方决定何时保存）
  store.stock = draft;
  store.entries.push(...additions);
  store.docs[req.docId] = { content, resultLines: reportLines };

  return {
    duplicate: false,
    lines: [`盘点单 ${req.docId} 提交成功，仓库 ${req.wh}，共 ${pids.length} 种商品：`, ...reportLines],
  };
}

/**
 * 整单冲销：在“当前余量”上应用原单的相反变动（不回滚历史、不恢复绝对余量）。
 * 任一商品扣回不足或补回后溢出，则整单拒绝、不留任何痕迹；成功后库存/流水/冲销
 * 关系/结果一起应用到内存（由调用方决定何时保存）。
 */
function applyReversal(store: Store, revId: string, origId: string): SubmitOutcome {
  const existed = store.reversals[revId];
  if (existed !== undefined) {
    if (existed.orig !== origId)
      throw new BizError(
        `冲销单编号 ${revId} 已用于冲销原单 ${existed.orig}，不能改冲原单 ${origId}，拒绝提交`,
      );
    return { duplicate: true, lines: existed.resultLines }; // 幂等重放：返回原冲销结果，不再变动
  }
  // 冲销单与入库/出库/调拨/盘点共用唯一编号空间
  if (store.docs[revId] !== undefined)
    throw new BizError(`编号 ${revId} 已是入库/出库/调拨/盘点单编号，不能用作冲销单，拒绝提交`);

  // 只能冲销成功的原始库存单据：不存在的原单、冲销单本身均不可冲销
  const origRec = store.docs[origId];
  if (origRec === undefined)
    throw new BizError(`原单 ${origId} 不存在或不是成功的原始库存单据，拒绝冲销`);

  for (const [existingRev, rec] of Object.entries(store.reversals)) {
    if (rec.orig === origId)
      throw new BizError(`原单 ${origId} 已被冲销单 ${existingRev} 成功冲销，每张原单只能冲销一次`);
  }

  const c = origRec.content;
  const type = c.type as DocType | 'count';
  const items = c.items as Record<string, number>;
  const pids = Object.keys(items).sort();

  const draft: Store['stock'] = cloneStock(store.stock);
  const additions: LedgerEntry[] = [];
  const reportLines: string[] = [];
  let seq = store.entries.length;
  const typeLabel = type === 'in' ? '入库' : type === 'out' ? '出库' : type === 'transfer' ? '调拨' : '盘点';
  const revType = `${type}-rev` as EntryType;

  for (const pid of pids) {
    if (type === 'count') {
      // 冲销盘点：在当前余量上减去原盘点差额（不恢复原账面绝对值）；零差额不改余量但须记录
      const wh = c.wh as string;
      const item = (c.items as Record<string, { expected: number; actual: number }>)[pid];
      const diff = item.actual - item.expected;
      const before = getStock(draft, pid, wh);
      const after = before - diff;
      if (after < 0)
        throw new BizError(
          `冲销盘点原单 ${origId}：商品 ${pid} 仓库 ${wh} 当前余量 ${before} 冲减差额 ${fmtSigned(diff)} 后为负，拒绝整单`,
        );
      if (after > MAX_SAFE)
        throw new BizError(
          `冲销盘点原单 ${origId}：商品 ${pid} 仓库 ${wh} 冲减差额 ${fmtSigned(diff)} 后超出安全整数范围，拒绝整单`,
        );
      setStock(draft, pid, wh, after);
      additions.push({
        seq: ++seq, doc: revId, type: revType, product: pid, wh,
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
      const before = getStock(draft, pid, wh);
      if (before < qty)
        throw new BizError(
          `冲销入库原单 ${origId}：商品 ${pid} 仓库 ${wh} 当前余量 ${before} 不足扣回 ${qty}，拒绝整单`,
        );
      const after = before - qty;
      setStock(draft, pid, wh, after);
      additions.push({
        seq: ++seq, doc: revId, type: revType, product: pid, wh, qty, before, after, orig: origId,
      });
      reportLines.push(`冲销入库 原单=${origId} 商品=${pid} @${wh} -${qty}：${before} -> ${after}`);
    } else if (type === 'out') {
      // 冲销出库：向原来源仓补回
      const wh = c.wh as string;
      const before = getStock(draft, pid, wh);
      const after = before + qty;
      if (after > MAX_SAFE)
        throw new BizError(
          `冲销出库原单 ${origId}：商品 ${pid} 仓库 ${wh} 补回后余量超出安全整数范围，拒绝整单`,
        );
      setStock(draft, pid, wh, after);
      additions.push({
        seq: ++seq, doc: revId, type: revType, product: pid, wh, qty, before, after, orig: origId,
      });
      reportLines.push(`冲销出库 原单=${origId} 商品=${pid} @${wh} +${qty}：${before} -> ${after}`);
    } else {
      // 冲销调拨：从原调入仓扣回，向原调出仓补回
      const from = c.from as string;
      const to = c.to as string;
      const beforeTo = getStock(draft, pid, to);
      if (beforeTo < qty)
        throw new BizError(
          `冲销调拨原单 ${origId}：商品 ${pid} 原调入仓 ${to} 当前余量 ${beforeTo} 不足扣回 ${qty}，拒绝整单`,
        );
      const afterTo = beforeTo - qty;
      const beforeFrom = getStock(draft, pid, from);
      const afterFrom = beforeFrom + qty;
      if (afterFrom > MAX_SAFE)
        throw new BizError(
          `冲销调拨原单 ${origId}：商品 ${pid} 原调出仓 ${from} 补回后余量超出安全整数范围，拒绝整单`,
        );
      setStock(draft, pid, to, afterTo);
      setStock(draft, pid, from, afterFrom);
      additions.push({
        seq: ++seq, doc: revId, type: revType, product: pid, wh: to,
        qty, before: beforeTo, after: afterTo, from, to, orig: origId,
      });
      additions.push({
        seq: ++seq, doc: revId, type: revType, product: pid, wh: from,
        qty, before: beforeFrom, after: afterFrom, from, to, orig: origId,
      });
      reportLines.push(
        `冲销调拨 原单=${origId} 商品=${pid} ${to} -> ${from} ${qty}：` +
          `${to} ${beforeTo}->${afterTo}；${from} ${beforeFrom}->${afterFrom}`,
      );
    }
  }

  // 全部明细合法：库存、流水、冲销关系、结果一次性应用到内存（由调用方决定何时保存）
  store.stock = draft;
  store.entries.push(...additions);
  store.reversals[revId] = { orig: origId, resultLines: reportLines };

  return {
    duplicate: false,
    lines: [
      `冲销单 ${revId} 提交成功，冲销${typeLabel}原单 ${origId}，共 ${pids.length} 种商品：`,
      ...reportLines,
    ],
  };
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
  'in-rev': '冲销入库',
  'out-rev': '冲销出库',
  'transfer-rev': '冲销调拨',
  'count-rev': '冲销盘点',
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
    // 符号必须与前后余量一致：入库/冲销出库/调入方向为增，其余为减
    const increases =
      e.type === 'in' || e.type === 'out-rev' ||
      ((e.type === 'transfer' || e.type === 'transfer-rev') &&
        (e.type === 'transfer') === (e.wh === e.to));
    signed = `${increases ? '+' : '-'}${e.qty}`;
    line = `#${e.seq}\t单据=${e.doc}\t${TYPE_LABEL[e.type]}\t商品=${e.product}\t仓库=${e.wh}\t${signed}\t${e.before}->${e.after}`;
    if (e.type === 'transfer' || e.type === 'transfer-rev') line += `\t调拨=${e.from}->${e.to}`;
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
  const outcome = applyReversal(store, revId, origId);
  if (!outcome.duplicate) saveStore(dataDir, store); // 保存成功才报告成功
  if (outcome.duplicate) {
    console.log(
      `冲销单 ${revId} 为重复提交，原单为 ${origId}，返回原冲销结果（库存与流水不再变动）：`,
    );
  }
  for (const line of outcome.lines) console.log(line);
}

// ---------- 整批导入 ----------

type BatchItem =
  | { kind: 'doc'; req: DocRequest }
  | { kind: 'count'; req: CountRequest }
  | { kind: 'reverse'; revId: string; origId: string };

/** 解析入出库/调拨明细数组：同商品先合并，数量须为正安全整数。 */
function parseBatchQtyItems(raw: unknown, at: string): Map<string, number> {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new BizError(`${at}：items 必须是非空数组，元素为 {"product":"商品编号","qty":数量}`);
  const merged = new Map<string, number>();
  for (const it of raw as unknown[]) {
    if (!isPlainObject(it) || typeof it.product !== 'string')
      throw new BizError(`${at}：明细必须是 {"product":"商品编号","qty":数量} 对象`);
    const pid = trimOrThrow(`${at} 的商品编号`, it.product);
    if (!isPosSafeInt(it.qty))
      throw new BizError(`${at}：商品 ${pid} 的数量必须为正安全整数：${JSON.stringify(it.qty)}`);
    const sum = (merged.get(pid) ?? 0) + it.qty; // 同单同商品先合并
    if (!Number.isSafeInteger(sum)) throw new BizError(`${at}：商品 ${pid} 累计数量超出安全整数范围`);
    merged.set(pid, sum);
  }
  return merged;
}

/** 解析盘点明细数组：两种数量均为非负安全整数，同商品重复拒绝。 */
function parseBatchCountItems(raw: unknown, at: string): Map<string, CountItem> {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new BizError(
      `${at}：items 必须是非空数组，元素为 {"product":"商品编号","expected":账面量,"actual":实盘量}`,
    );
  const items = new Map<string, CountItem>();
  for (const it of raw as unknown[]) {
    if (!isPlainObject(it) || typeof it.product !== 'string')
      throw new BizError(`${at}：明细必须是 {"product":"商品编号","expected":账面量,"actual":实盘量} 对象`);
    const pid = trimOrThrow(`${at} 的商品编号`, it.product);
    if (!isNonNegSafeInt(it.expected))
      throw new BizError(`${at}：商品 ${pid} 的预期账面量必须为非负安全整数：${JSON.stringify(it.expected)}`);
    if (!isNonNegSafeInt(it.actual))
      throw new BizError(`${at}：商品 ${pid} 的实盘量必须为非负安全整数：${JSON.stringify(it.actual)}`);
    if (items.has(pid)) throw new BizError(`${at}：盘点单中商品 ${pid} 重复出现，拒绝整批`);
    items.set(pid, { expected: it.expected, actual: it.actual });
  }
  return items;
}

function batchTrimId(raw: unknown, label: string, at: string): string {
  if (typeof raw !== 'string') throw new BizError(`${at}：缺少${label}（字符串）`);
  return trimOrThrow(`${at} 的${label}`, raw);
}

/** 解析列表中的一项；任何不合法都抛出带位置（第几项）的 BizError，整批拒绝。 */
function parseBatchItem(raw: unknown, index: number): BatchItem {
  const at = `第 ${index} 项`;
  if (!isPlainObject(raw)) throw new BizError(`${at}：单据必须是对象`);
  const t = raw.type;
  if (t !== 'in' && t !== 'out' && t !== 'transfer' && t !== 'count' && t !== 'reverse')
    throw new BizError(`${at}：type 必须是 in / out / transfer / count / reverse 之一`);
  const docId = batchTrimId(raw.doc, '单据编号', at);

  if (t === 'reverse') {
    return { kind: 'reverse', revId: docId, origId: batchTrimId(raw.orig, '原单编号', at) };
  }
  if (t === 'count') {
    const wh = batchTrimId(raw.wh, '仓库标识', at);
    return { kind: 'count', req: { docId, wh, items: parseBatchCountItems(raw.items, at) } };
  }
  const items = parseBatchQtyItems(raw.items, at);
  if (t === 'transfer') {
    const from = batchTrimId(raw.from, '调出仓标识', at);
    const to = batchTrimId(raw.to, '调入仓标识', at);
    if (from === to) throw new BizError(`${at}：调拨单的调出仓与调入仓不能相同`);
    return { kind: 'doc', req: { type: 'transfer', docId, from, to, items } };
  }
  const wh = batchTrimId(raw.wh, '仓库标识', at);
  return { kind: 'doc', req: { type: t, docId, wh, items } };
}

/**
 * 整批导入：按列表顺序逐项应用（后项以前项生效后的余量核对与计算），
 * 任一项失败则整批拒绝、不保存任何本批变动；全部通过且有新生效单据时
 * 一次性保存，保存成功后才输出各项结果；全部重复时不改写数据。
 */
function runImport(rest: string[], dataDir: string, store: Store): void {
  const args = parseArgs(rest, []);
  const [file, ...extra] = args.positionals;
  if (file === undefined || extra.length > 0) throw new UsageError('用法：import <单据列表文件>');

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new DataError(`无法读取导入文件 ${file}：${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new UsageError(`导入文件不是合法 JSON：${file}`);
  }
  if (!Array.isArray(data)) throw new UsageError('导入文件必须是 JSON 数组（有序单据列表）');
  if (data.length === 0) throw new UsageError('导入文件至少需要包含一项单据');

  const items = data.map((it, i) => parseBatchItem(it, i + 1));

  // 顺序应用：任一项抛出即整批拒绝，内存中的本批变动随进程退出全部丢弃，不保存
  const applied: { item: BatchItem; outcome: SubmitOutcome }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      let outcome: SubmitOutcome;
      if (item.kind === 'doc') outcome = applyDocument(store, item.req);
      else if (item.kind === 'count') outcome = applyCount(store, item.req);
      else outcome = applyReversal(store, item.revId, item.origId);
      applied.push({ item, outcome });
    } catch (e) {
      if (e instanceof BizError) throw new BizError(`第 ${i + 1} 项：${e.message}`);
      throw e;
    }
  }

  const newCount = applied.filter((a) => !a.outcome.duplicate).length;
  if (newCount > 0) saveStore(dataDir, store); // 有新生效单据：整批保存成功才报告成功

  const docIdOf = (it: BatchItem): string =>
    it.kind === 'reverse' ? it.revId : it.req.docId;
  const labelOf = (it: BatchItem): string =>
    it.kind === 'doc'
      ? it.req.type === 'in'
        ? '入库单'
        : it.req.type === 'out'
          ? '出库单'
          : '调拨单'
      : it.kind === 'count'
        ? '盘点单'
        : '冲销单';

  console.log(
    `整批导入 ${file}：共 ${items.length} 项，首次生效 ${newCount} 项，重复 ${items.length - newCount} 项` +
      (newCount > 0 ? '，已整批保存' : '，全部为重复，数据未改写'),
  );
  applied.forEach(({ item, outcome }, i) => {
    console.log(
      `[${i + 1}] ${labelOf(item)} ${docIdOf(item)}：` +
        (outcome.duplicate ? '重复，返回原结果（不再生效）' : '首次生效'),
    );
    for (const line of outcome.lines) console.log(line);
  });
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
  reverse <冲销单编号> --orig <原单编号>     整单冲销已成功的入库/出库/调拨/盘点单
  import <文件>                             整批导入：从 JSON 文件按顺序提交有序单据列表
  balance <商品编号> [--wh <仓库>]           查询余量；省略 --wh 查询各仓
  flow --product <编号> [--wh <仓库>]        按商品/仓库查询流水（至少一个过滤条件）
       | --wh <仓库> [--product <编号>]
  -h, --help                                显示本帮助

规则：
  数量必须为正安全整数；同单同商品的重复明细先合并，再做足量与溢出校验；
  任一明细不合法则整单拒绝。单据编号（含冲销单）在同一数据目录内共用全局唯一
  编号空间，相同内容重复提交返回原结果且不重复变动，同编号不同内容拒绝；失败
  提交不占用编号。

盘点规则：
  盘点单逐项给出某仓库中已登记商品的预期账面量与实盘量（均为非负安全整数），
  同商品重复出现拒绝。首次提交先逐项核对当前余量与预期账面量，任一不符整单
  拒绝并说明冲突商品及当前量；全部相符才把列出的商品校正为实盘量（差额 =
  实盘 - 账面，可增、可减、可为零；全零差额仍记为成功单据并逐项追加流水），
  未列出的商品及其他仓库不变。同编号同内容重放只返回原结果，即使余量改变或
  盘点已冲销也不再核对、不再生效；同编号不同内容或其他业务拒绝。

冲销规则：
  冲销在“当前余量”上应用原单的相反变动，不回滚原单之后的其他业务、不恢复绝对
  余量：冲销入库从原目标仓扣回；冲销出库向原来源仓补回；冲销调拨从原调入仓扣
  回并向原调出仓补回；冲销盘点在当前余量上减去原盘点差额（零差额不改余量，
  但仍记录冲销关系与流水）。数量取原单合并后的明细。任一商品扣回不足、补回后
  溢出或冲减后为负则整单拒绝、不占用冲销单编号、原单不标记冲销，条件改善后
  可重试。
  只能冲销成功的原始单据；原单不存在、冲销单本身、已冲销过的原单均不能再次冲
  销，每张原单最多冲销一次。冲销成功后重放原单仍只返回其最初结果，不会重新生
  效；重放冲销单返回原冲销结果，不再变动，同编号改指其他原单则拒绝。

整批导入（import）：
  import <文件> 从 JSON 文件读取有序单据列表，按列表顺序逐项提交：后项以前项
  生效后的余量核对并计算（后项可用前项入库所得库存，盘点核对此前各项之后的
  账面量，冲销可指向导入前已成功的原单或列表中此前的新原单）。文件必须是非空
  JSON 数组，元素为下列对象之一（标识去首尾空白后非空、区分大小写）：
    {"type":"in"|"out","doc":"编号","wh":"仓库",
     "items":[{"product":"商品编号","qty":数量}, ...]}
    {"type":"transfer","doc":"编号","from":"调出仓","to":"调入仓",
     "items":[{"product":"商品编号","qty":数量}, ...]}
    {"type":"count","doc":"编号","wh":"仓库",
     "items":[{"product":"商品编号","expected":预期账面量,"actual":实盘量}, ...]}
    {"type":"reverse","doc":"冲销单编号","orig":"原单编号"}
  与单条命令共用唯一编号空间与去重规则：同编号同内容项（导入前已有或本列表
  此前出现）只返回原结果、不重新生效；同编号不同内容或不同业务整批拒绝。
  全部项通过才生效：有新生效单据时整批一次性保存，全部重复时不改写数据；
  任一项不合法整批拒绝并指出位置与原因，本批新库存、流水、编号与冲销关系均
  不保留，纠正后可复用这些新编号。

示例：
  node app.ts -d ./data product add P1 螺丝
  node app.ts -d ./data in D1 --wh W1 --item P1:10 --item P2:3
  node app.ts -d ./data out D2 --wh W1 --item P1:4
  node app.ts -d ./data transfer D3 --from W1 --to W2 --item P1:2 --item P1:3
  node app.ts -d ./data count C1 --wh W1 --item P1:1:5 --item P2:3:3
  node app.ts -d ./data reverse R1 --orig D3
  node app.ts -d ./data reverse R2 --orig C1
  node app.ts -d ./data import ./examples/import.json
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
      const outcome = applyDocument(store, req);
      if (!outcome.duplicate) saveStore(dataDir, store); // 保存成功才报告成功
      if (outcome.duplicate) {
        console.log(`单据 ${req.docId} 为重复提交，业务内容与原提交一致，返回原提交结果（库存与流水不变）：`);
      }
      for (const line of outcome.lines) console.log(line);
      break;
    }
    case 'count': {
      const req = parseCountArgs(tokens);
      const store = loadStore(dataDir);
      const outcome = applyCount(store, req);
      if (!outcome.duplicate) saveStore(dataDir, store); // 保存成功才报告成功
      if (outcome.duplicate) {
        console.log(`盘点单 ${req.docId} 为重复提交，业务内容与原提交一致，返回原提交结果（库存与流水不变）：`);
      }
      for (const line of outcome.lines) console.log(line);
      break;
    }
    case 'reverse': {
      const store = loadStore(dataDir);
      runReverse(tokens, dataDir, store);
      break;
    }
    case 'import': {
      const store = loadStore(dataDir);
      runImport(tokens, dataDir, store);
      break;
    }
    case 'balance': {
      const store = loadStore(dataDir);
      runBalance(tokens, store);
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
