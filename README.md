# stockroom

本地多仓库存台账命令行工具。使用 TypeScript + Node.js 24 编写，无外部运行依赖，
数据以单个 JSON 文件保存在本地；支持指定数据目录，不同目录互不影响。

## 运行环境

- Node.js 24（直接执行 `.ts`，无需编译或安装依赖）

## 快速开始

```sh
# 登记商品
node app.ts -d ./data product add P1 螺丝
node app.ts -d ./data product add P2 螺母
node app.ts -d ./data product list

# 入库 / 出库 / 跨仓调拨（每单可含多个 --item，同商品重复明细自动合并）
node app.ts -d ./data in D1 --wh W1 --item P1:10 --item P2:3
node app.ts -d ./data out D2 --wh W1 --item P1:4
node app.ts -d ./data transfer D3 --from W1 --to W2 --item P1:2 --item P1:3

# 余量查询（指定仓库或各仓）
node app.ts -d ./data balance P1
node app.ts -d ./data balance P1 --wh W2

# 流水查询（按商品和/或仓库，按提交顺序）
node app.ts -d ./data flow --product P1
node app.ts -d ./data flow --wh W2
```

## 命令行入口与调用说明

- 无参数、`--help`、`-h`：显示应用名与完整帮助，退出码 0。
- 未知命令或非法参数：向标准错误报错，退出码 2。
- 业务拒绝（重复编号、缺货、溢出、单据内容冲突等）或数据损坏/保存失败：
  向标准错误报错，退出码非 0（1）。
- 全局选项 `-d, --data <目录>` 指定数据目录，默认 `./.stockroom`；
  数据文件为目录内的 `stockroom.json`，首次写入时自动创建。
- 也可执行 `npm link` 后使用 `stockroom` 命令（等价于 `node app.ts`）。

## 主要规则

- 商品编号、名称、单据编号、仓库标识均去除首尾空白后使用，不能为空；标识区分大小写。
- 商品编号唯一，重复登记被拒绝且不覆盖原资料。
- 入库增加目标仓余量，出库减少来源仓余量；调拨同时减来源仓、增目标仓，两仓不能相同。
- 数量必须为正安全整数；同单同商品明细先合并，再校验足量与安全整数上溢。
- 任一明细不合法则**整单拒绝**，所有库存保持原状（不部分生效）。
- 单据编号在同一数据目录内全局唯一：相同业务内容重复提交返回原结果、不重复变动；
  同编号不同内容拒绝；失败提交不占用编号。去重记录与库存、流水一起持久化。
- 流水记录单据编号、类型、涉及仓库、数量及变动前后余量；调拨两端可凭同一单据编号追溯。
- 数据文件损坏或无法读取时明确报错退出，不会当作空库覆盖；保存采用临时文件原子替换。
