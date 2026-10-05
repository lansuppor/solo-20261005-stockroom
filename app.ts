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
type EntryType = DocType | 'reversal';

interface LedgerEntry {
  seq: number; // 全局流水序号，即提交顺序
  doc: string; // 单据编号（冲销流水为冲销单编号）
  type: EntryType;
  product: string;
  wh: string; // 本流水条目变动余量的仓库
  qty: number; // 恒为正数，方向由 type / 出入仓决定
  before: number;
  after: number;
  from?: string; // 调拨单的调出仓（冲销调拨时沿用原单方向）
  to?: string; // 调拨单的调入仓
  ref?: string; // 冲销流水关联的原单编号
}

interface DocRecord {
  content: Record<string, unknown>; // 规范化业务内容（明细顺序无关）
  resultLines: string[]; // 原提交结果，供幂等重放
  reversedBy?: string; // 原单被成功冲销的冲销单编号（仅原始单据可能有）
}

interface Store {
  version: 1;
  products: Record<string, string>; // 编号 -> 名称（编号区分大小写）
  stock: Record<string, Record<string, number>>; // 商品 -> 仓库 -> 余量
  entries: LedgerEntry[];
  docs: Record<string, DocRecord>;
}

// 各映射一律使用无原型对象，constructor、__proto__ 等标识不会命中原型链
function emptyStore(): Store {
  return {
    version: 1,
    products: Object.create(null),
    stock: Object.create(null),
    entries: [],
    docs: Object.create(null),
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
    data = JSON.parse(raw);
  } catch {
    throw new DataError(`数据文件已损坏，无法解析 JSON：${dataPath(dataDir)}（不会作为空库覆盖）`);
  }
  return validateStore(data);
}

type BadData = (msg: string) => DataError;

/** 校验去重记录中的规范化业务内容，冲销时需据此重放原单明细。 */
function validateDocContent(docId: string, content: Record<string, unknown>, bad: BadData): void {
  const t = content.type;
  if (t === 'reverse') {
    if (typeof content.of !== 'string' || content.of.trim() === '')
      throw bad(`冲销单 ${docId} 缺少原单编号`);
    return;
  }
  if (t !== 'in' && t !== 'out' && t !== 'transfer') throw bad(`单据 ${docId} 的业务类型非法`);
  if (t === 'transfer') {
    if (
      typeof content.from !== 'string' || content.from.trim() === '' ||
      typeof content.to !== 'string' || content.to.trim() === ''
    ) throw bad(`调拨单 ${docId} 缺少调出/调入仓`);
  } else if (typeof content.wh !== 'string' || content.wh.trim() === '') {
    throw bad(`单据 ${docId} 缺少仓库标识`);
  }
  if (!isPlainObject(content.items)) throw bad(`单据 ${docId} 的明细非法`);
  for (const [pid, qty] of Object.entries(content.items)) {
    if (pid.trim() === '' || !isPosSafeInt(qty)) throw bad(`单据 ${docId} 的明细数量非法`);
  }
}

function validateStore(data: unknown): Store {
  const bad: BadData = (msg) =>
    new DataError(`数据文件已损坏或格式不正确（${msg}），拒绝启动以免覆盖原数据`);

  if (!isPlainObject(data)) throw bad('根节点不是对象');
  if (data.version !== 1) throw bad(`不支持的数据版本：${String(data.version)}`);

  if (!isPlainObject(data.products)) throw bad('products 不是对象');
  const products: Record<string, string> = Object.create(null);
  for (const [id, name] of Object.entries(data.products)) {
    if (id.trim() === '' || typeof name !== 'string')
      throw bad('products 中存在非法编号或名称');
    products[id] = name;
  }

  if (!isPlainObject(data.stock)) throw bad('stock 不是对象');
  const stock: Store['stock'] = Object.create(null);
  for (const [pid, whs] of Object.entries(data.stock)) {
    if (pid.trim() === '') throw bad('stock 中存在非法商品编号');
    if (!isPlainObject(whs)) throw bad(`商品 ${pid} 的库存不是对象`);
    const inner: Record<string, number> = Object.create(null);
    for (const [wh, qty] of Object.entries(whs)) {
      if (wh.trim() === '' || !isNonNegSafeInt(qty))
        throw bad(`商品 ${pid} 仓库 ${wh} 的余量非法`);
      inner[wh] = qty;
    }
    stock[pid] = inner;
  }

  if (!Array.isArray(data.entries)) throw bad('entries 不是数组');
  const entries: LedgerEntry[] = [];
  let lastSeq = 0;
  for (const e of data.entries as unknown[]) {
    if (!isPlainObject(e)) throw bad('存在非法流水条目');
    if (!isPosSafeInt(e.seq) || e.seq !== ++lastSeq) throw bad('流水序号不连续');
    if (typeof e.doc !== 'string' || e.doc.trim() === '') throw bad('流水缺少单据编号');
    if (e.type !== 'in' && e.type !== 'out' && e.type !== 'transfer' && e.type !== 'reversal')
      throw bad('流水类型非法');
    if (typeof e.product !== 'string' || e.product.trim() === '') throw bad('流水缺少商品编号');
    if (typeof e.wh !== 'string' || e.wh.trim() === '') throw bad('流水缺少仓库标识');
    if (!isPosSafeInt(e.qty)) throw bad('流水数量非法');
    if (!isNonNegSafeInt(e.before) || !isNonNegSafeInt(e.after)) throw bad('流水余量非法');
    if (e.type === 'transfer') {
      if (typeof e.from !== 'string' || e.from.trim() === '' || typeof e.to !== 'string' || e.to.trim() === '')
        throw bad('调拨流水缺少调出/调入仓');
    }
    if (e.type === 'reversal') {
      if (typeof e.ref !== 'string' || e.ref.trim() === '') throw bad('冲销流水缺少原单编号');
      if (e.from !== undefined && (typeof e.from !== 'string' || e.from.trim() === ''))
        throw bad('冲销流水的调出仓非法');
      if (e.to !== undefined && (typeof e.to !== 'string' || e.to.trim() === ''))
        throw bad('冲销流水的调入仓非法');
    }
    entries.push(e as unknown as LedgerEntry);
  }

  if (!isPlainObject(data.docs)) throw bad('docs 不是对象');
  const docs: Record<string, DocRecord> = Object.create(null);
  for (const [docId, rec] of Object.entries(data.docs)) {
    if (docId.trim() === '') throw bad('存在非法单据编号');
    if (!isPlainObject(rec) || !isPlainObject(rec.content) || !Array.isArray(rec.resultLines))
      throw bad(`单据 ${docId} 的去重记录非法`);
    if (!rec.resultLines.every((l) => typeof l === 'string')) throw bad(`单据 ${docId} 的结果记录非法`);
    validateDocContent(docId, rec.content, bad);
    if (rec.reversedBy !== undefined && (typeof rec.reversedBy !== 'string' || rec.reversedBy.trim() === ''))
      throw bad(`单据 ${docId} 的冲销标记非法`);
    docs[docId] = rec as unknown as DocRecord;
  }

  return { version: 1, products, stock, entries, docs };
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

// ---------- 业务核心 ----------

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function canonicalContent(req: DocRequest): Record<string, unknown> {
  const items: Record<string, number> = {};
  for (const pid of [...req.items.keys()].sort()) items[pid] = req.items.get(pid)!;
  if (req.type === 'transfer') return { type: req.type, from: req.from!, to: req.to!, items };
  return { type: req.type, wh: req.wh!, items };
}

function getStock(stock: Store['stock'], pid: string, wh: string): number {
  return stock[pid]?.[wh] ?? 0;
}

function setStock(stock: Store['stock'], pid: string, wh: string, qty: number): void {
  (stock[pid] ??= Object.create(null))[wh] = qty;
}

/** 深拷贝库存映射（保持无原型对象），供整单模拟使用。 */
function cloneStock(stock: Store['stock']): Store['stock'] {
  const out: Store['stock'] = Object.create(null);
  for (const [pid, whs] of Object.entries(stock)) {
    const inner: Record<string, number> = Object.create(null);
    for (const [wh, qty] of Object.entries(whs)) inner[wh] = qty;
    out[pid] = inner;
  }
  return out;
}

interface SubmitOutcome {
  duplicate: boolean;
  lines: string[];
}

/** 整单先校验、模拟，全部合法后才一次性落库；任一明细失败则全部保持原状。 */
function submitDocument(dataDir: string, store: Store, req: DocRequest): SubmitOutcome {
  const content = canonicalContent(req);
  const existed = store.docs[req.docId];
  if (existed !== undefined) {
    if (stableStringify(existed.content) !== stableStringify(content))
      throw new BizError(`单据编号 ${req.docId} 已用于业务内容不同的单据，拒绝提交`);
    return { duplicate: true, lines: existed.resultLines }; // 幂等：返回原结果，不动库存
  }

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

  // 全部明细合法：一次性提交并在保存成功后才算成功
  store.stock = draft;
  store.entries.push(...additions);
  store.docs[req.docId] = { content, resultLines: reportLines };
  saveStore(dataDir, store);

  return {
    duplicate: false,
    lines: [`${typeLabel}单 ${req.docId} 提交成功，共 ${req.items.size} 种商品：`, ...reportLines],
  };
}

// ---------- 整单冲销 ----------

interface ReversalRequest {
  docId: string; // 冲销单编号（与入/出/调拨单共用同一编号空间）
  of: string; // 被冲销的原单编号
}

function parseReverseArgs(tokens: string[]): ReversalRequest {
  const args = parseArgs(tokens, []);
  const [idRaw, ofRaw, ...extra] = args.positionals;
  if (idRaw === undefined || ofRaw === undefined || extra.length > 0)
    throw new UsageError('用法：reverse <冲销单编号> <原单编号>');
  return { docId: trimOrThrow('冲销单编号', idRaw), of: trimOrThrow('原单编号', ofRaw) };
}

/**
 * 整单冲销：按原单合并后的明细在当前余量上应用相反变动（入库扣回、出库补回、
 * 调拨从调入仓扣回并向调出仓补回）。先整体校验、模拟，全部合法才一次性落库；
 * 任一明细扣回不足或补回溢出则整单拒绝，所有仓库与商品保持原状。
 */
function submitReversal(dataDir: string, store: Store, req: ReversalRequest): SubmitOutcome {
  const content: Record<string, unknown> = { type: 'reverse', of: req.of };
  const existed = store.docs[req.docId];
  if (existed !== undefined) {
    if (stableStringify(existed.content) !== stableStringify(content))
      throw new BizError(`单据编号 ${req.docId} 已用于业务内容不同的单据，拒绝提交`);
    return { duplicate: true, lines: existed.resultLines }; // 幂等重放：即使余量已变也不再变动
  }

  const orig = store.docs[req.of];
  if (orig === undefined) throw new BizError(`原单 ${req.of} 不存在，无法冲销`);
  const oc = orig.content;
  if (oc.type === 'reverse') throw new BizError(`原单 ${req.of} 本身是冲销单，不能对冲销单再冲销`);
  const otype = oc.type as DocType; // 加载时已校验，必为 in/out/transfer
  if (orig.reversedBy !== undefined)
    throw new BizError(`原单 ${req.of} 已被冲销单 ${orig.reversedBy} 成功冲销，每张原单最多冲销一次`);

  const items = oc.items as Record<string, number>; // 原单合并后的明细
  const draft: Store['stock'] = cloneStock(store.stock);
  const additions: LedgerEntry[] = [];
  const reportLines: string[] = [];
  let seq = store.entries.length;

  for (const pid of Object.keys(items).sort()) {
    const qty = items[pid];

    if (otype === 'in') {
      // 冲销入库：从原目标仓扣回
      const wh = oc.wh as string;
      const before = getStock(draft, pid, wh);
      if (before < qty)
        throw new BizError(`冲销入库：商品 ${pid} 仓库 ${wh} 余量不足（当前 ${before}，需扣回 ${qty}），整单拒绝`);
      const after = before - qty;
      setStock(draft, pid, wh, after);
      additions.push({ seq: ++seq, doc: req.docId, type: 'reversal', product: pid, wh, qty, before, after, ref: req.of });
      reportLines.push(`冲销入库 ${pid} @${wh} -${qty}：${before} -> ${after}`);
    } else if (otype === 'out') {
      // 冲销出库：向原来源仓补回
      const wh = oc.wh as string;
      const before = getStock(draft, pid, wh);
      const after = before + qty;
      if (after > MAX_SAFE)
        throw new BizError(`冲销出库：商品 ${pid} 仓库 ${wh} 补回后余量超出安全整数范围，整单拒绝`);
      setStock(draft, pid, wh, after);
      additions.push({ seq: ++seq, doc: req.docId, type: 'reversal', product: pid, wh, qty, before, after, ref: req.of });
      reportLines.push(`冲销出库 ${pid} @${wh} +${qty}：${before} -> ${after}`);
    } else {
      // 冲销调拨：从原调入仓扣回，向原调出仓补回
      const from = oc.from as string;
      const to = oc.to as string;
      const beforeTo = getStock(draft, pid, to);
      if (beforeTo < qty)
        throw new BizError(`冲销调拨：商品 ${pid} 调入仓 ${to} 余量不足（当前 ${beforeTo}，需扣回 ${qty}），整单拒绝`);
      const afterTo = beforeTo - qty;
      const beforeFrom = getStock(draft, pid, from);
      const afterFrom = beforeFrom + qty;
      if (afterFrom > MAX_SAFE)
        throw new BizError(`冲销调拨：商品 ${pid} 调出仓 ${from} 补回后余量超出安全整数范围，整单拒绝`);
      setStock(draft, pid, to, afterTo);
      setStock(draft, pid, from, afterFrom);
      additions.push({
        seq: ++seq, doc: req.docId, type: 'reversal', product: pid, wh: to,
        qty, before: beforeTo, after: afterTo, from, to, ref: req.of,
      });
      additions.push({
        seq: ++seq, doc: req.docId, type: 'reversal', product: pid, wh: from,
        qty, before: beforeFrom, after: afterFrom, from, to, ref: req.of,
      });
      reportLines.push(
        `冲销调拨 ${pid} ${to} -> ${from} ${qty}：${to} ${beforeTo}->${afterTo}；${from} ${beforeFrom}->${afterFrom}`,
      );
    }
  }

  // 全部明细合法：一次性提交，库存、流水、冲销关系与去重记录一起保存后才算成功
  store.stock = draft;
  store.entries.push(...additions);
  store.docs[req.docId] = { content, resultLines: reportLines };
  orig.reversedBy = req.docId;
  saveStore(dataDir, store);

  return {
    duplicate: false,
    lines: [
      `冲销单 ${req.docId} 提交成功，已冲销${TYPE_LABEL[otype]}单 ${req.of}，共 ${Object.keys(items).length} 种商品：`,
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

const TYPE_LABEL: Record<EntryType, string> = { in: '入库', out: '出库', transfer: '调拨', reversal: '冲销' };

function formatEntry(e: LedgerEntry, store: Store): string {
  let signed: string;
  if (e.type === 'in') signed = `+${e.qty}`;
  else if (e.type === 'out') signed = `-${e.qty}`;
  else if (e.type === 'reversal') signed = `${e.after >= e.before ? '+' : '-'}${e.qty}`;
  else signed = `${e.wh === e.to ? '+' : '-'}${e.qty}`;
  let line = `#${e.seq}\t单据=${e.doc}\t${TYPE_LABEL[e.type]}\t商品=${e.product}\t仓库=${e.wh}\t${signed}\t${e.before}->${e.after}`;
  if (e.type === 'transfer' || (e.type === 'reversal' && e.from !== undefined && e.to !== undefined))
    line += `\t调拨=${e.from}->${e.to}`;
  if (e.type === 'reversal') line += `\t冲销原单=${e.ref}`;
  const reversedBy = store.docs[e.doc]?.reversedBy;
  if (reversedBy !== undefined) line += `\t（该单已被冲销单 ${reversedBy} 冲销）`;
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
  console.log(`流水（${scope}），共 ${rows.length} 条，按提交顺序：`);
  if (rows.length === 0) console.log('（无匹配流水）');
  else for (const e of rows) console.log(formatEntry(e, store));
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
  reverse <冲销单编号> <原单编号>            整单冲销已成功的入库/出库/调拨单
  balance <商品编号> [--wh <仓库>]           查询余量；省略 --wh 查询各仓
  flow --product <编号> [--wh <仓库>]        按商品/仓库查询流水（至少一个过滤条件）
       | --wh <仓库> [--product <编号>]
  -h, --help                                显示本帮助

规则：
  数量必须为正安全整数；同单同商品的重复明细先合并，再做足量与溢出校验；
  任一明细不合法则整单拒绝。单据编号在同一数据目录内全局唯一，相同内容重复
  提交返回原结果且不重复变动，同编号不同内容拒绝；失败提交不占用编号。
  冲销按原单合并后的明细在当前余量上应用相反变动：冲销入库从原目标仓扣回，
  冲销出库向原来源仓补回，冲销调拨从原调入仓扣回并向原调出仓补回；只能冲销
  成功的原始单据，每张原单最多成功冲销一次，冲销单编号与业务单据共用同一
  编号空间；失败的冲销不占编号、不标记原单，条件改善后可重试。

示例：
  node app.ts -d ./data product add P1 螺丝
  node app.ts -d ./data in D1 --wh W1 --item P1:10 --item P2:3
  node app.ts -d ./data out D2 --wh W1 --item P1:4
  node app.ts -d ./data transfer D3 --from W1 --to W2 --item P1:2 --item P1:3
  node app.ts -d ./data reverse R1 D2
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
      const outcome = submitDocument(dataDir, store, req);
      if (outcome.duplicate) {
        console.log(`单据 ${req.docId} 为重复提交，业务内容与原提交一致，返回原提交结果（库存与流水不变）：`);
      }
      for (const line of outcome.lines) console.log(line);
      break;
    }
    case 'reverse': {
      const req = parseReverseArgs(tokens);
      const store = loadStore(dataDir);
      const outcome = submitReversal(dataDir, store, req);
      if (outcome.duplicate) {
        console.log(`冲销单 ${req.docId} 为重复提交，与原冲销请求一致，返回原冲销结果（库存与流水不变）：`);
      }
      for (const line of outcome.lines) console.log(line);
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
