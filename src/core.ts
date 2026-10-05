// stockroom 核心逻辑：数据模型、持久化、商品登记与库存单据处理。
// 仅使用 Node.js 内置模块，无外部运行依赖。

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_QTY = Number.MAX_SAFE_INTEGER;
const DATA_VERSION = 1;
const DATA_FILE = 'stockroom.json';

/** 业务拒绝：参数合法但业务规则不满足，退出码 1。 */
export class BizError extends Error {}

/** 数据文件缺失以外的读取/保存错误，退出码 1。。 */
export class DataError extends Error {}

export type DocType = 'in' | 'out' | 'transfer';

export interface Product {
  id: string;
  name: string;
}

export interface Item {
  productId: string;
  qty: number;
}

export interface DocRecord {
  id: string;
  type: DocType;
  source: string | null;
  target: string | null;
  items: Item[]; // 已按商品编号合并、排序
}

export interface LedgerEntry {
  seq: number;
  docId: string;
  type: DocType;
  productId: string;
  warehouse: string;
  delta: number; // 带符号变动数量
  before: number;
  after: number;
}

export interface Store {
  version: 1;
  products: Product[];
  balances: Record<string, Record<string, number>>;
  documents: Record<string, DocRecord>;
  ledger: LedgerEntry[];
  seq: number;
}

export interface SubmitInput {
  id: string;
  type: DocType;
  source: string | null;
  target: string | null;
  items: Item[];
}

export interface SubmitOutcome {
  duplicate: boolean;
  doc: DocRecord;
}

export function emptyStore(): Store {
  return {
    version: 1,
    products: [],
    balances: {},
    documents: {},
    ledger: [],
    seq: 0,
  };
}

export function resolveDataDir(dataDir: string): string {
  return resolve(dataDir);
}

export function hasProduct(store: Store, productId: string): boolean {
  return store.products.some((p) => p.id === productId);
}

export function getBalance(store: Store, productId: string, warehouse: string): number {
  return store.balances[productId]?.[warehouse] ?? 0;
}

/** 登记商品；重复编号拒绝且不覆盖原资料。 */
export function registerProduct(store: Store, id: string, name: string): void {
  if (hasProduct(store, id)) {
    throw new BizError(`商品编号已存在: ${id}（不会覆盖原资料）`);
  }
  store.products.push({ id, name });
}

function contentKey(doc: {
  type: DocType;
  source: string | null;
  target: string | null;
  items: Item[];
}): string {
  // 业务内容 = 类型 + 仓库 + 合并后的商品数量；明细顺序无关（先排序后序列化）。
  const items = doc.items
    .map((i) => [i.productId, i.qty] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([doc.type, doc.source, doc.target, items]);
}

/**
 * 提交单据。先做整单校验，全部通过才改动内存数据；
 * 重复编号且内容一致时返回原单，不重复变动库存或追加流水。
 */
export function submitDocument(store: Store, input: SubmitInput): SubmitOutcome {
  if (input.type === 'transfer' && input.source !== null && input.source === input.target) {
    throw new BizError('调拨单的调出仓与调入仓不能相同');
  }

  // 同单同商品的重复明细先合并。
  const merged = new Map<string, number>();
  for (const it of input.items) {
    const sum = (merged.get(it.productId) ?? 0) + it.qty;
    if (!Number.isSafeInteger(sum)) {
      throw new BizError(`商品 ${it.productId} 合并后的累计数量超出安全整数范围`);
    }
    merged.set(it.productId, sum);
  }
  const items: Item[] = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, qty]) => ({ productId, qty }));

  const candidate = {
    type: input.type,
    source: input.source,
    target: input.target,
    items,
  };

  // 编号去重：同编号内容一致幂等返回；同编号内容不同拒绝。
  const existing = store.documents[input.id];
  if (existing !== undefined) {
    if (contentKey(existing) === contentKey(candidate)) {
      return { duplicate: true, doc: existing };
    }
    throw new BizError(`单据编号 ${input.id} 已存在，但业务内容与原单不同`);
  }

  // 商品必须已登记。
  for (const it of items) {
    if (!hasProduct(store, it.productId)) {
      throw new BizError(`商品未登记: ${it.productId}`);
    }
  }

  // 整单预校验：缺货 / 溢出，任一不合法整单拒绝。
  for (const it of items) {
    if (input.type === 'out' || input.type === 'transfer') {
      const have = getBalance(store, it.productId, input.source as string);
      if (have < it.qty) {
        throw new BizError(
          `库存不足: 商品 ${it.productId} 在仓库 ${input.source} 需要 ${it.qty}，现有 ${have}`,
        );
      }
    }
    if (input.type === 'in' || input.type === 'transfer') {
      const have = getBalance(store, it.productId, input.target as string);
      if (have + it.qty > MAX_QTY) {
        throw new BizError(
          `数量溢出: 商品 ${it.productId} 在仓库 ${input.target} 入库后将超过安全整数上限`,
        );
      }
    }
  }

  // 全部通过，才真正改动库存并追加流水。
  const apply = (productId: string, warehouse: string, delta: number): void => {
    const before = getBalance(store, productId, warehouse);
    const after = before + delta;
    (store.balances[productId] ??= {})[warehouse] = after;
    store.seq += 1;
    store.ledger.push({
      seq: store.seq,
      docId: input.id,
      type: input.type,
      productId,
      warehouse,
      delta,
      before,
      after,
    });
  };

  for (const it of items) {
    if (input.type === 'in') {
      apply(it.productId, input.target as string, it.qty);
    } else if (input.type === 'out') {
      apply(it.productId, input.source as string, -it.qty);
    } else {
      // 调拨：先减少来源仓，再增加目标仓；两条流水可追溯到同一单据。
      apply(it.productId, input.source as string, -it.qty);
      apply(it.productId, input.target as string, it.qty);
    }
  }

  const doc: DocRecord = { id: input.id, ...candidate };
  store.documents[input.id] = doc;
  return { duplicate: false, doc };
}

export function filterLedger(
  store: Store,
  filter: { productId?: string; warehouse?: string },
): LedgerEntry[] {
  return store.ledger.filter(
    (e) =>
      (filter.productId === undefined || e.productId === filter.productId) &&
      (filter.warehouse === undefined || e.warehouse === filter.warehouse),
  );
}

// ---------- 持久化 ----------

/** 读取数据目录；目录或文件不存在时返回空库（不写盘），损坏则明确失败。 */
export function loadStore(dataDir: string): Store {
  const dir = resolveDataDir(dataDir);
  const file = join(dir, DATA_FILE);

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyStore();
    }
    throw new DataError(`无法读取数据文件 ${file}: ${(err as Error).message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new DataError(`数据文件已损坏（JSON 解析失败）${file}: ${(err as Error).message}`);
  }
  return validateStore(data, file);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asValidType(v: unknown, where: string): DocType {
  if (v === 'in' || v === 'out' || v === 'transfer') return v;
  throw new DataError(`数据文件已损坏: ${where} 的单据类型非法`);
}

/** 严格校验数据结构，并依据流水重算余量核对一致性。 */
function validateStore(data: unknown, file: string): Store {
  const fail = (msg: string): never => {
    throw new DataError(`数据文件已损坏 ${file}: ${msg}`);
  };
  if (!isObject(data) || data.version !== DATA_VERSION) fail('缺少正确的 version 字段');

  if (!Array.isArray(data.products)) fail('products 必须为数组');
  const products: Product[] = [];
  const productIds = new Set<string>();
  for (const raw of data.products) {
    if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
      fail('商品记录格式非法');
    }
    if (raw.id.trim() === '' || raw.name.trim() === '') fail('存在空的商品编号或名称');
    if (productIds.has(raw.id)) fail(`商品编号重复: ${raw.id}`);
    productIds.add(raw.id);
    products.push({ id: raw.id, name: raw.name });
  }

  const documents: Record<string, DocRecord> = {};
  if (!isObject(data.documents)) fail('documents 必须为对象');
  for (const [docId, raw] of Object.entries(data.documents)) {
    if (docId.trim() === '') fail('存在空的单据编号');
    if (!isObject(raw)) fail(`单据 ${docId} 格式非法`);
    const type = asValidType(raw.type, `单据 ${docId}`);
    if (typeof raw.source !== 'string' && raw.source !== null) fail(`单据 ${docId} 的 source 非法`);
    if (typeof raw.target !== 'string' && raw.target !== null) fail(`单据 ${docId} 的 target 非法`);
    const nonEmpty = (v: string | null): boolean => v !== null && v.trim() !== '';
    if (type === 'in' && (raw.source !== null || !nonEmpty(raw.target))) {
      fail(`入库单 ${docId} 的仓库字段非法`);
    }
    if (type === 'out' && (raw.target !== null || !nonEmpty(raw.source))) {
      fail(`出库单 ${docId} 的仓库字段非法`);
    }
    if (
      type === 'transfer' &&
      (!nonEmpty(raw.source) || !nonEmpty(raw.target) || raw.source === raw.target)
    ) {
      fail(`调拨单 ${docId} 的仓库字段非法`);
    }
    if (!Array.isArray(raw.items)) fail(`单据 ${docId} 的明细必须为数组`);
    const items: Item[] = [];
    const itemIds = new Set<string>();
    for (const line of raw.items) {
      if (
        !isObject(line) ||
        typeof line.productId !== 'string' ||
        typeof line.qty !== 'number' ||
        !Number.isSafeInteger(line.qty) ||
        line.qty <= 0
      ) {
        fail(`单据 ${docId} 存在非法明细`);
      }
      if (!productIds.has(line.productId)) fail(`单据 ${docId} 引用了未登记商品 ${line.productId}`);
      if (itemIds.has(line.productId)) fail(`单据 ${docId} 的明细存在重复商品 ${line.productId}`);
      itemIds.add(line.productId);
      items.push({ productId: line.productId, qty: line.qty });
    }
    if (items.length === 0) fail(`单据 ${docId} 没有任何明细`);
    documents[docId] = { id: docId, type, source: raw.source, target: raw.target, items };
  }

  if (!Array.isArray(data.ledger)) fail('ledger 必须为数组');
  const rebuilt: Record<string, Record<string, number>> = {};
  const ledger: LedgerEntry[] = [];
  const entriesByDoc = new Map<string, Array<[string, string, number]>>();
  let expectedSeq = 0;
  for (const raw of data.ledger) {
    if (!isObject(raw)) fail('流水记录格式非法');
    const seq = raw.seq;
    const docId = raw.docId;
    const type = asValidType(raw.type, '流水');
    if (
      typeof seq !== 'number' ||
      typeof docId !== 'string' ||
      typeof raw.productId !== 'string' ||
      typeof raw.warehouse !== 'string' ||
      typeof raw.delta !== 'number' ||
      typeof raw.before !== 'number' ||
      typeof raw.after !== 'number'
    ) {
      fail('流水记录字段类型非法');
    }
    expectedSeq += 1;
    if (seq !== expectedSeq) fail(`流水序号不连续: 期望 ${expectedSeq}，实际 ${seq}`);
    const doc = documents[docId];
    if (doc === undefined) fail(`流水引用了不存在的单据 ${docId}`);
    if (type !== doc.type) fail(`流水 ${seq} 的类型与单据 ${docId} 不一致`);
    if (!productIds.has(raw.productId)) fail(`流水 ${seq} 引用了未登记商品`);
    if (
      typeof raw.delta !== 'number' ||
      !Number.isSafeInteger(raw.delta) ||
      raw.delta === 0 ||
      !Number.isSafeInteger(raw.before) ||
      !Number.isSafeInteger(raw.after) ||
      raw.before < 0 ||
      raw.after < 0 ||
      raw.before + raw.delta !== raw.after
    ) {
      fail(`流水 ${seq} 的余量变动不成立`);
    }
    const cur = rebuilt[raw.productId]?.[raw.warehouse] ?? 0;
    if (cur !== raw.before) fail(`流水 ${seq} 的变动前余量与历史不一致`);
    (rebuilt[raw.productId] ??= {})[raw.warehouse] = raw.after;
    const triple: [string, string, number] = [raw.productId, raw.warehouse, raw.delta];
    const list = entriesByDoc.get(docId) ?? [];
    list.push(triple);
    entriesByDoc.set(docId, list);
    ledger.push({
      seq,
      docId,
      type,
      productId: raw.productId,
      warehouse: raw.warehouse,
      delta: raw.delta,
      before: raw.before,
      after: raw.after,
    });
  }

  if (data.seq !== expectedSeq) fail('seq 与流水条数不一致');

  // 逐单对账：每张单据的流水（商品、仓库、带符号数量）必须与单据明细完全吻合。
  for (const [docId, doc] of Object.entries(documents)) {
    const got = (entriesByDoc.get(docId) ?? []).map(([p, w, d]) => `${p}|${w}|${d}`).sort();
    const want: string[] = [];
    for (const it of doc.items) {
      if (doc.type === 'in') want.push(`${it.productId}|${doc.target}|${it.qty}`);
      else if (doc.type === 'out') want.push(`${it.productId}|${doc.source}|${-it.qty}`);
      else {
        want.push(`${it.productId}|${doc.source}|${-it.qty}`);
        want.push(`${it.productId}|${doc.target}|${it.qty}`);
      }
    }
    want.sort();
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
      fail(`单据 ${docId} 的流水与明细不一致`);
    }
  }

  if (!isObject(data.balances)) fail('balances 必须为对象');
  for (const [pid, whs] of Object.entries(data.balances)) {
    if (!productIds.has(pid)) fail(`余量引用了未登记商品 ${pid}`);
    if (!isObject(whs)) fail(`商品 ${pid} 的余量必须为对象`);
    for (const [wh, qty] of Object.entries(whs)) {
      if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 0) {
        fail(`商品 ${pid} 仓库 ${wh} 的余量非法`);
      }
      if (rebuilt[pid]?.[wh] !== qty) fail(`商品 ${pid} 仓库 ${wh} 的余量与流水不一致`);
    }
    for (const wh of Object.keys(rebuilt[pid] ?? {})) {
      if (!(wh in whs)) fail(`商品 ${pid} 仓库 ${wh} 缺少余量记录`);
    }
  }
  for (const pid of Object.keys(rebuilt)) {
    if (!(pid in data.balances)) fail(`商品 ${pid} 缺少余量记录`);
  }

  return { version: 1, products, balances: data.balances as Store['balances'], documents, ledger, seq: data.seq };
}

/** 原子保存：先写临时文件并 fsync，再 rename；保存失败不影响原有数据文件。 */
export function saveStore(dataDir: string, store: Store): void {
  const dir = resolveDataDir(dataDir);
  const file = join(dir, DATA_FILE);
  const tmp = join(dir, `.${DATA_FILE}.tmp-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(store, null, 2) + '\n';
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件清理失败可忽略
    }
    throw new DataError(`保存数据失败: ${(err as Error).message}`);
  }
}
