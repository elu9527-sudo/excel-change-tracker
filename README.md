# Excel 变更对比（excel-change-tracker）

[![test](https://github.com/elu9527-sudo/excel-change-tracker/actions/workflows/test.yml/badge.svg)](https://github.com/elu9527-sudo/excel-change-tracker/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

上传同一份业务表的新旧两版，逐格对比，**按行告诉你哪条记录被删了、哪条是新加的、哪些字段的值变了**。

跑在本机、只开 `127.0.0.1`、数据不出机器，适合内部主数据导入前的复核：ERP/MES 导入模板改完一版，先看清楚动了什么，再导入。

```
上传新版 → 自动和上一版逐格比对 → 一行一条记录的变化清单 → 点开看整行前后对照
```

![界面截图](docs/screenshot.png)

## 为什么不是直接 `diff` 两个 xlsx

业务表不是代码。直接做单元格级 diff，会得到这样的输出：

```
删除 156 条
  K40  kg → (空)     L40  pcs → (空)     M40  是 → (空)   ... 共 26 个字段
```

实际只删了 **6 行**。业务员看到"删除 156"会去找 156 行，找不到；看到 `K40` 不知道是哪个字段。这个工具做的事：

- **按行聚合**：一条 Excel 记录一行，写「删除 · 第 40 行 · 示例物料A · 整行被删除」
- **数字说行数**：卡片写"删了 6 行"，单元格数只作附注
- **整行前后对照**：右侧并排显示这一行的每个字段，改了的标黄，列名来自表头
- **认行不认位置**：有主键按主键配对，没有就按内容相似度配对，插删行不会连带把下面几十行判成"改过"

## 特性

- **主键优先对齐**：自动识别主键（含复合键，最多 6 列）；主键重复时按出现顺序配对；主键不可靠（整列被改写、两版重合率低）自动回退内容对齐
- **公式比对**：值一样但公式从 `=B2*2` 改成 `=B2*3` 也算修改；删行导致的公式行号整体位移会被归一，不刷假变更
- **按行分页**：50 行一页，改动多也不会被"删除"记录挤满首页
- **忽略规则**：模板里必填但不必看的列（比如打勾的「是否启用」列）可以规则化隐藏，查询时生效，随时可关
- **快照缓存**：大表点开对照不必每次重解析整份快照
- **零外网依赖**：不调用任何在线服务，Excel 只在本机读写

## 快速开始

要求 Node.js **18+**（Windows / macOS / Linux 均可）。

```bash
git clone https://github.com/elu9527-sudo/excel-change-tracker.git
cd excel-change-tracker
npm install
npm start            # 打开 http://127.0.0.1:3000
```

没有现成的 Excel 也能试：先生成一对虚构的演示文件

```bash
npm run demo         # 生成 demo/第1版/sample-materials.xlsx 与 demo/第2版/sample-materials.xlsx
```

然后在界面里**先传第 1 版，再传第 2 版**，会看到 4 行变化（改 2 行、删 1 行、加 1 行）。

## 界面怎么用

1. **上传新版 Excel**：只支持 `.xlsx`，单个 ≤ 20MB。**文件名别改** —— 同一个文件名视为同一份文件的不同版本。
2. **看哪个文件**：按文件名分组，选一个。
3. **上传记录**：一次上传一张卡片，写「第 2 次上传 · 11-04 00:35 · 比上一版：删了 1 行 / 加了 1 行 / 改了 1 行」。
4. **改了什么**：按行列出变化，点任意一行，右侧显示这条记录的**整行前后对照**，变了的字段标黄。

筛选用日期范围、工作表名、变化类型；「忽略规则」折叠面板里可以临时隐藏不关心的列。

### 忽略规则写法

`工作表:行:列:单元格`，四段任一段留空表示"不限制"，支持 `*`、区间和列表：

| 规则 | 含义 |
|---|---|
| `Sheet1::A` | Sheet1 的 A 列全部不看 |
| `Sheet1:1-5::` | Sheet1 前 5 行不看 |
| `*:1-3::` | 所有工作表的前 3 行不看（表头常在这几行） |
| `物料:A,C,D` | 物料表的 A、C、D 三列不看 |
| `物料:2-100;B2:C5` | 行与单元格混写 |

规则存在 `data/ignore_rules.json`，**只在查询时过滤**，不改动已落盘的比对结果；`/api/changes?ignore=0` 可看全量。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 上传 `.xlsx`，解析、比对、落快照 |
| GET | `/api/version-lines` | 版本线列表（按文件名分组） |
| GET | `/api/timeline?version_line_id=` | 上传记录卡片（含行数、单元格数） |
| GET | `/api/changes?version_line_id=&ignore=` | 变更列表（单元格级，`ignore=0` 关掉忽略规则） |
| GET | `/api/context?snapshot_id=&row_index=&sheet_name=` | 整行前后对照（可传 `other_snapshot_id` 指定对照版本） |
| GET/POST | `/api/ignore-rules` | 读取/保存忽略规则 |
| DELETE | `/api/snapshots/:snapshot_id` | 删除某一版（连带其变更记录） |
| GET | `/api/health` | 健康检查 + 接口能力清单 |

## 工作原理

比对分三层，任一层失败自动降级，不硬套规则：

1. **列对齐**：用 [daff](https://github.com/paulfitz/daff) 做列映射；表头为空的列补占位列名；漏配的列按"列内容集合重合度"补配，要求互为最优、同分按列位置距离决胜。
2. **行对齐**：
   - 有可靠主键 → 按主键配对（复合键贪心挑选，要求列覆盖率 ≥ 90%、不同值 ≥ max(3, min(8, 30% 行数))、重复率 ≤ 5%、两版键重合率 ≥ 50%）。重复主键按出现顺序配对。
   - 无可靠主键 → 内容对齐（daff），再用相似度 ≥ 0.6 且差异格数 ≤ max(2, 15%) 的规则把"改了几格"的行从"删 + 加"里救回来。
3. **单元格比对**：值、类型、公式文本三者任一变化即为修改。公式按配对行号差平移后再比，避免删行造成整列公式"看起来都变了"。
4. **行标签**：从该行非空单元格里挑"本列唯一且最长"的文本作为指认名（挑不到就补最低频文本），写入变更记录，列表查询不必再解析大快照。

数据结构上是"每格一条变更"，**行视图是查询时的聚合**，所以既能按行读，也能展开到字段级。

## 数据都存在哪

全部在项目目录下，`data/` 与 `logs/` 已在 `.gitignore` 里，**不会入库**：

```
data/
  version_lines/   版本线
  snapshots/       解析后的单元格快照（JSON，体积约为原 xlsx 的 20 倍）
  changes/         变更记录
  raw_files/       原始上传文件
  ignore_rules.json
logs/app.log
```

快照是体积大头：6.4MB 的 xlsx 约 126MB 快照。长期使用建议定期清理旧版本（界面上"删除这版"）。

## 已知限制

- **公式不重算**：只比较公式文本与 Excel 里缓存的计算结果。文件存盘时没算过的公式，缓存值就是空的。
- **工作表改名** = 整表删 + 整表加（不视为同一张表改名）。
- **重复上传同一份文件**仍会新建一版（0 变更卡片）。
- **上传同步执行**：解析 + 比对 + 落盘都在请求线程里，几百 MB 的表会让页面等一会。
- **单版变更超过 5000 条**时界面只取前 5000 条。
- **极端行跨度**（例如 A1 和 XFD1048576 都有值）会按矩形分配内存，可能吃满内存。
- **合并单元格**结构变化会产生"删 + 加"噪音。

## 开发与测试

```bash
npm test        # node --test，56 项单测
npm run check   # 契约检查：contracts 键完整、无硬编码目录/错误码
npm run smoke   # 端到端冒烟：造两版文件走完整上传链路
npm run demo    # 生成虚构演示文件
```

便携打包（Windows，产出 `dist/ECT-portable.zip`，内含 node.exe，双击 `启动.bat` 即用）：

```bash
node scripts/make-portable.js
```

## 目录结构

```
src/
  server.js          Express 入口
  routes.js          HTTP 路由
  contracts.js       常量、枚举、错误码
  services/
    parser.js        xlsx → 单元格数组（含公式）
    differ.js        比对、行标签、公式位移归一
    rowAlign.js      列对齐、补配对
    keyAlign.js      主键识别与按主键配对
    timeline.js      时间线、按行聚合、整行对照
    ignoreRules.js   忽略规则
    snapshotCache.js 快照 LRU
    upload.js        上传编排
  repositories/      快照/变更/版本线读写
public/              前端（原生 JS，无框架、无构建）
scripts/             冒烟、检查、打包、演示文件生成
test/                node --test 单测
```

## 许可

[MIT](LICENSE)
