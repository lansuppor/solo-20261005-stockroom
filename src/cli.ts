// stockroom 命令行入口：参数解析、结果输出与退出码约定。
//   退出码 0  成功（含幂等重复提交）
//   退出码 1  业务拒绝 / 数据读取或保存失败
//   退出码 2  未知命令或非法参数

import {
  BizError,
  DataError,
  filterLedger,
  getBalance,
  loadStore,
  registerProduct,
  saveStore,
  submitDocument,
  type DocType,
  type Item,
} from './core.ts';

export const APP_NAME = 'stockroom';

const HELP_TEXT = `${APP_NAME} — 本地多仓库存台账

用法:
  node app.ts [--help|-h]
  node app.ts register <商品编号> <商品名称> [--data-dir <目录>]
  node app.ts products [--data-dir <目录>]
  node app.ts in       --doc <单据编号> --warehouse <仓库> --item <商品编号:数量>... [--data-dir <目录>]
  node app.ts out      --doc <单据编号> --warehouse <仓库> --item <商品编号:数量>... [--data-dir <目录>]
  node app.ts transfer --doc <单据编号> --from <调出仓> --to <调入仓> --item <商品编号:数量>... [--data-dir <目录>]
  node app.ts balance  --product <商品编号> [--warehouse <仓库>] [--data-dir <目录>]
  node app.ts ledger   (--product <商品编号> | --warehouse <仓库>)... [--data-dir <目录>]

说明:
  数据默认保存在当前目录下的 data/ 中，可用 --data-dir 指定；不同目录数据互不影响。
  编号、名称、单据编号、仓库标识均去除首尾空白后使用，不能为空，且区分大小写。
  入库/出库/调拨每单可含多个商品；同单同商品的重复明细会先合并。
  单据编号在同一数据目录内全局唯一；同编号同内容重复提交返回原结果且不重复变动库存。
  仅成功提交产生流水；任一明细不合法、缺货或溢出时整单拒绝，库存保持原状。

示例:
  node app.ts register p001 螺丝
  node app.ts in --doc d1 --warehouse main --item p001:100
  node app.ts transfer --doc d2 --from main --to shop --item p001:30
  node app.ts balance --product p001
  node app.ts ledger --product p001`;

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
}

/** 参数错误：未知命令/未知选项/缺值/格式非法，退出码 2。 */
class UsageError extends Error {}

const KNOWN_GLOBAL = new Set(['--data-dir']);

function parseArgs(argv: string[], known: Set<string>, repeatable: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const allowed = new Set([...known, ...KNOWN_GLOBAL]);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      let key: string;
      let inlineValue: string | undefined;
      const eq = token.indexOf('=');
      if (eq >= 0) {
        key = token.slice(0, eq);
        inlineValue = token.slice(eq + 1);
      } else {
        key = token;
      }
      if (!allowed.has(key)) {
        throw new UsageError(`未知参数: ${token}`);
      }
      const value = inlineValue ?? argv[++i];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`参数 ${key} 缺少值`);
      }
      if (!repeatable.has(key) && options.has(key)) {
        throw new UsageError(`参数 ${key} 只能指定一次`);
      }
      const list = options.get(key) ?? [];
      list.push(value);
      options.set(key, list);
    } else {
      positionals.push(token);
    }
  }
  return { positionals, options };
}

function requireOpt(options: Map<string, string[]>, key: string): string {
  const v = options.get(key)?.[0];
  if (v === undefined) throw new UsageError(`缺少必填参数 ${key}`);
  return v;
}

/** 去首尾空白；为空属于非法参数（退出码 2）。 */
function cleanIdentifier(raw: string, label: string): string {
  const v = raw.trim();
  if (v === '') throw new UsageError(`${label}不能为空（去除首尾空白后）`);
  return v;
}

function parseItems(rawItems: string[] | undefined): Item[] {
  if (rawItems === undefined || rawItems.length === 0) {
    throw new UsageError('单据至少需要一条 --item <商品编号:数量> 明细');
  }
  return rawItems.map((raw) => {
    const idx = raw.lastIndexOf(':');
    if (idx <= 0) {
      throw new UsageError(`明细格式非法: "${raw}"，应为 商品编号:数量`);
    }
    const productId = raw.slice(0, idx).trim();
    const qtyText = raw.slice(idx + 1).trim();
    if (productId === '') throw new UsageError(`明细中的商品编号不能为空: "${raw}"`);
    const qty = Number(qtyText);
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new UsageError(`明细中的数量必须为正安全整数: "${raw}"`);
    }
    return { productId, qty };
  });
}

const TYPE_LABEL: Record<DocType, string> = {
  in: '入库',
  out: '出库',
  transfer: '调拨',
};

export function main(argv: string[]): number {
  // 无参数 / --help / -h：显示应用名与帮助。
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
    console.log(HELP_TEXT);
    return 0;
  }

  const command = argv[0];
  const rest = argv.slice(1);
  const knownCommands = new Set(['register', 'products', 'in', 'out', 'transfer', 'balance', 'ledger']);
  if (!knownCommands.has(command)) {
    console.error(`${APP_NAME}: 未知命令: ${command}（使用 --help 查看帮助）`);
    return 2;
  }

  try {
    switch (command) {
      case 'register':
        return cmdRegister(rest);
      case 'products':
        return cmdProducts(rest);
      case 'in':
      case 'out':
      case 'transfer':
        return cmdSubmit(command, rest);
      case 'balance':
        return cmdBalance(rest);
      case 'ledger':
        return cmdLedger(rest);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${APP_NAME}: ${err.message}（使用 --help 查看帮助）`);
      return 2;
    }
    if (err instanceof BizError) {
      console.error(`${APP_NAME}: 拒绝: ${err.message}`);
      return 1;
    }
    if (err instanceof DataError) {
      console.error(`${APP_NAME}: ${err.message}`);
      return 1;
    }
    console.error(`${APP_NAME}: ${(err as Error).message}`);
    return 1;
  }
  return 1;
}

function dataDirOf(options: Map<string, string[]>): string {
  return options.get('--data-dir')?.[0] ?? 'data';
}

function cmdRegister(argv: string[]): number {
  const { positionals, options } = parseArgs(argv, new Set(), new Set());
  if (positionals.length !== 2) {
    throw new UsageError('register 需要两个参数: <商品编号> <商品名称>');
  }
  const id = cleanIdentifier(positionals[0], '商品编号');
  const name = cleanIdentifier(positionals[1], '商品名称');

  const dir = dataDirOf(options);
  const store = loadStore(dir);
  registerProduct(store, id, name);
  saveStore(dir, store);
  console.log(`已登记商品: ${id} (${name})`);
  return 0;
}

function cmdProducts(argv: string[]): number {
  const { positionals, options } = parseArgs(argv, new Set(), new Set());
  if (positionals.length !== 0) throw new UsageError('products 不接受位置参数');

  const store = loadStore(dataDirOf(options));
  if (store.products.length === 0) {
    console.log('（暂无已登记商品）');
    return 0;
  }
  for (const p of store.products) {
    console.log(`${p.id}\t${p.name}`);
  }
  return 0;
}

function cmdSubmit(type: DocType, argv: string[]): number {
  const known =
    type === 'transfer'
      ? new Set(['--doc', '--from', '--to', '--item'])
      : new Set(['--doc', '--warehouse', '--item']);
  const { positionals, options } = parseArgs(argv, known, new Set(['--item']));
  if (positionals.length !== 0) throw new UsageError(`${type} 不接受位置参数`);

  const docId = cleanIdentifier(requireOpt(options, '--doc'), '单据编号');
  const items = parseItems(options.get('--item'));

  let source: string | null = null;
  let target: string | null = null;
  if (type === 'transfer') {
    source = cleanIdentifier(requireOpt(options, '--from'), '调出仓标识');
    target = cleanIdentifier(requireOpt(options, '--to'), '调入仓标识');
  } else {
    const wh = cleanIdentifier(requireOpt(options, '--warehouse'), '仓库标识');
    if (type === 'in') target = wh;
    else source = wh;
  }

  const dir = dataDirOf(options);
  const store = loadStore(dir);
  const result = submitDocument(store, { id: docId, type, source, target, items });

  if (result.duplicate) {
    // 成功编号再次提交相同内容：返回原结果，不保存、不重复变动。
    console.log(
      `重复提交: 单据 ${docId} 与原提交内容一致，返回原提交结果（${TYPE_LABEL[type]}，库存与流水未变动）`,
    );
    return 0;
  }

  // 保存成功后才报告成功。
  saveStore(dir, store);
  const affected = store.ledger.filter((e) => e.docId === docId);
  console.log(`单据 ${docId} 已提交（${TYPE_LABEL[type]}），含 ${items.length} 种商品：`);
  for (const e of affected) {
    console.log(`  ${e.productId} @ ${e.warehouse}: ${e.before} -> ${e.after}`);
  }
  return 0;
}

function cmdBalance(argv: string[]): number {
  const { positionals, options } = parseArgs(
    argv,
    new Set(['--product', '--warehouse']),
    new Set(),
  );
  if (positionals.length !== 0) throw new UsageError('balance 不接受位置参数');
  const productId = cleanIdentifier(requireOpt(options, '--product'), '商品编号');
  const warehouse = options.get('--warehouse')?.[0]?.trim();
  if (warehouse !== undefined && warehouse === '') {
    throw new UsageError('仓库标识不能为空（去除首尾空白后）');
  }

  const store = loadStore(dataDirOf(options));
  if (!store.products.some((p) => p.id === productId)) {
    throw new BizError(`商品未登记: ${productId}`);
  }

  if (warehouse !== undefined) {
    // 未发生变动的组合余量为零。
    console.log(`商品 ${productId} 仓库 ${warehouse} 余量: ${getBalance(store, productId, warehouse)}`);
    return 0;
  }

  const whs = Object.keys(store.balances[productId] ?? {}).sort();
  if (whs.length === 0) {
    console.log(`商品 ${productId} 在各仓均无变动记录（余量为零）`);
    return 0;
  }
  for (const wh of whs) {
    console.log(`商品 ${productId} 仓库 ${wh} 余量: ${getBalance(store, productId, wh)}`);
  }
  return 0;
}

function cmdLedger(argv: string[]): number {
  const { positionals, options } = parseArgs(
    argv,
    new Set(['--product', '--warehouse']),
    new Set(),
  );
  if (positionals.length !== 0) throw new UsageError('ledger 不接受位置参数');
  const productId = options.get('--product')?.[0]?.trim();
  const warehouse = options.get('--warehouse')?.[0]?.trim();
  if (productId === '' || warehouse === '') {
    throw new UsageError('商品编号或仓库标识不能为空（去除首尾空白后）');
  }
  if (productId === undefined && warehouse === undefined) {
    throw new UsageError('ledger 至少需要 --product <商品编号> 或 --warehouse <仓库> 之一');
  }

  const store = loadStore(dataDirOf(options));
  if (productId !== undefined && !store.products.some((p) => p.id === productId)) {
    throw new BizError(`商品未登记: ${productId}`);
  }

  const rows = filterLedger(store, {
    productId: productId ?? undefined,
    warehouse: warehouse ?? undefined,
  });
  if (rows.length === 0) {
    console.log('（无符合条件的流水记录）');
    return 0;
  }
  console.log('序号\t单据\t类型\t商品\t仓库\t变动\t变动前\t变动后');
  for (const e of rows) {
    const sign = e.delta > 0 ? `+${e.delta}` : `${e.delta}`;
    console.log(
      `${e.seq}\t${e.docId}\t${TYPE_LABEL[e.type]}\t${e.productId}\t${e.warehouse}\t${sign}\t${e.before}\t${e.after}`,
    );
  }
  return 0;
}
