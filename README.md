# stockroom

本地多仓库存台账命令行工具。支持商品登记、入库/出库/跨仓调拨单据提交，以及余量与流水查询。

- TypeScript + Node.js 24，无外部运行依赖（使用 Node 内置模块，原生运行 `.ts`）
- 数据以单个 JSON 文件保存在本地，默认为 `./data/stockroom.json`
- 可用 `--data-dir <目录>` 指定数据目录，不同目录的数据互不影响

## 用法

```sh
# 帮助（无参数、--help、-h 均显示应用名与帮助）
node app.ts --help

# 商品登记与列表
node app.ts register <商品编号> <商品名称>
node app.ts products

# 库存单据（--item 可重复，每单可含多个商品）
node app.ts in       --doc <单据编号> --warehouse <仓库>            --item <商品编号:数量>...
node app.ts out      --doc <单据编号> --warehouse <仓库>            --item <商品编号:数量>...
node app.ts transfer --doc <单据编号> --from <调出仓> --to <调入仓> --item <商品编号:数量>...

# 查询：余量（指定仓库或各仓）与流水（按商品和/或仓库）
node app.ts balance --product <商品编号> [--warehouse <仓库>]
node app.ts ledger  (--product <商品编号> | --warehouse <仓库>)...
```

任一命令均可附加 `--data-dir <目录>` 指定数据目录。

## 示例

```sh
node app.ts register p001 螺丝
node app.ts register p002 螺母
node app.ts in --doc d1 --warehouse main --item p001:100 --item p002:40
node app.ts out --doc d2 --warehouse main --item p001:30
node app.ts transfer --doc d3 --from main --to shop --item p001:20
node app.ts balance --product p001            # 各仓余量
node app.ts balance --product p001 --warehouse main
node app.ts ledger --product p001             # 按商品查流水
node app.ts ledger --warehouse shop           # 按仓库查流水
```

## 规则与退出码

- 商品编号、名称、单据编号、仓库标识去除首尾空白后使用，不能为空，区分大小写。
- 重复商品编号拒绝且不覆盖原资料；未发生变动的商品-仓库组合余量视为零。
- 数量必须为正安全整数；同单同商品的重复明细先合并，再检查缺货与溢出；
  任一明细不合法、缺货或溢出则整单拒绝，所有库存与仓库保持原状。
- 单据编号在同一数据目录内全局唯一：同编号同内容重复提交返回原结果、不重复变动库存
  或追加流水（即使余量已变化）；同编号不同内容拒绝。失败提交不占用编号。
- 流水记录单据编号、类型、涉及仓库、数量及变动前后余量，按提交顺序展示；
  调拨的调出与调入两条流水可追溯至同一单据。仅成功提交产生流水。
- 数据文件不存在时自动初始化为空库；已存在但损坏或无法读取时明确报错，不会覆盖。

退出码：`0` 成功（含幂等重复提交）；`1` 业务拒绝或数据读写失败；`2` 未知命令或非法参数。
