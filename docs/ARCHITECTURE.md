# 架构说明

单进程 Node.js + Express，前端是原生 JS（无框架、无构建步骤）。所有数据落在本地 JSON 文件，没有数据库、没有外网调用。

## 一次上传发生了什么

```
POST /api/upload
  → multer 收文件（≤20MB，仅 .xlsx）
  → parser.parseWorkbook         xlsx → [{sheet, row, col, value, type, formula}]
  → snapshotRepo.save            落 data/snapshots/snap_*.json，写版本线
  →（若是该文件名的第二版起）
     differ.diffCellsDetailed    与上一版逐格比对
       ├─ rowAlign.align         列映射 + 行对齐
       │    ├─ keyAlign.findKeys 主键识别（成功则按主键配对）
       │    └─ repairUnpairedRows 补配对（把"改了几格"从删/加里救回）
       ├─ 单元格比较              值 / 类型 / 公式文本
       └─ labelChanges           为每个变更行算 row_label
  → changeRepo.save              data/changes/changes_snap_*.json
  → 刷新索引、写日志
```

比对失败不影晌快照落盘：卡片会显示 `parse_status`，可重算（`scripts/recompute-changes.js`）。

## 存储结构

```
data/
  version_lines/vl_*.json      { version_line_id, file_name, latest_snapshot_id, created_at }
  snapshots/snap_*.json        { snapshot_id, file_name, uploaded_at, sheet_names, cells[], meta }
  changes/changes_snap_*.json  { snapshot_id, changes[] }
  raw_files/                   原始上传文件
  ignore_rules.json            { [file_name]: [rule, ...] }（上限 50 条/文件）
logs/app.log
```

单元格快照字段：`sheet_name, cell_ref, row_index, col_index, value, type, formula`。体积约为原 xlsx 的 20 倍（6.4MB → 约 126MB），这是主要磁盘成本。

变更记录字段：`snapshot_id, sheet_name, cell_ref, row_index, col_index, change_type, old_value, new_value, old_formula, new_formula, row_label, row_cell_count, possible_shift, detected_at`。

**行视图是查询时聚合的**：按 `(sheet_name, row_index)` 归并，`row_label` 直接读记录里的字段，所以列表不必解析大快照。

## 行对齐的三个闸门

### 1. 主键识别（`keyAlign.js`）

先试单列，再贪心拼复合键（每次挑"重复率下降最多"的列，最多 6 列）。认作主键需要同时满足：

| 条件 | 阈值 |
|---|---|
| 列覆盖率（该列非空占比） | ≥ 90% |
| 不同值个数 | ≥ max(3, min(8, 30% 行数)) |
| 重复率 | ≤ 5% |
| 两版键集合重合率 | ≥ 50% |
| 未配对行占比 | ≤ 50% |

任何一条不满足就不认主键、回退内容对齐 —— 硬按不可靠的键配对比内容对齐更糟（会把整表判成全删全加）。

主键重复（一个物料多行）按**出现顺序**配对；表头行固定 0 ↔ 0，不参与分组。

### 2. 列映射（`rowAlign.js`）

表头为空 → 补占位列名；daff 漏配的列按"两列内容集合的重合度"补配，要求互为最优、同分按列位置距离决胜（同名重复列靠这个区分）。

### 3. 补配对（`repairUnpairedRows.js` 内联于 rowAlign）

daff 会把"同行改了几格"判成"删一行 + 加一行"。对残留未配对行按列映射内容相似度补配对，要求：相似度 ≥ 0.6，且差异格数 ≤ max(2, 15% 列数)。差异太大就保留真实的删/加。

## 公式处理

`parser.js` 用 `XLSX.read(..., { sheetStubs: true })`，否则"只有公式没有缓存值"的格会被 SheetJS 丢掉。

比对时：值、类型、公式文本任一变化即 `modified`。公式另做**行位移归一** —— 若配对行号差为 Δ，把旧公式里的行引用整体平移 Δ 再比，避免删 6 行导致 2591 条 `=VLOOKUP(G23813,…)` 全被算成修改（真实踩过）。

公式本身不重算（HyperFormula 是 GPLv3/商业双授权，未引入）。缓存值只在 Excel 存盘时存在。

## 忽略规则

`工作表:行:列:单元格` 四段，任一段空 = 不限制，支持 `*`、区间、列表。**只在查询时过滤**（`/api/changes`），不改落盘记录；`ignore=0` 看全量。四段全空拒绝（`INVALID_RULE`），单条规则单元格上限 5000。

## 前端

`public/app.js` 单文件，无框架。四个面板，行聚合在浏览器里做：

- 一次性取回变更（上限 `CHANGES_FETCH_MAX = 5000`），按 `(sheet,row)` 聚合
- 每页 50 行（`GROUP_PAGE_SIZE`），展开看字段明细
- 右侧整行对照：`/api/context` 返回两版的整行单元格 + 列头文字
- 服务端版本落后时（`/api/health` 的 `features` 缺项）顶部给提示条，而不是把 `undefined` 印到页面上

## 错误码

`INVALID_FORMAT` 400 · `INVALID_RULE` 400 · `EMPTY_FILE` 400 · `FILE_TOO_LARGE` 413 · `PARSE_FAILED` 422 · `NOT_FOUND` 404 · `WRITE_FAILED` 500 · `INTERNAL` 500

## 性能实测

| 场景 | 数据 |
|---|---|
| 25,000 行 × 52 列比对 | 约 1.6~1.8 秒（含主键识别） |
| 单快照 `JSON.parse` | 126MB 约 425ms，RSS 约 400MB |
| 行标签计算 | 59 万单元格约 60ms |
| 单测 | 56 项，`npm test` 全过 |

## 测试策略

- `test/*.test.js`：纯函数与装配层单测（parser / differ / rowAlign / keyAlign / ignoreRules / 删除版本）
- `scripts/smoke.js`：端到端造两版文件，走完整上传链路并核对变更计数
- `scripts/check-contracts.js`：契约检查，防止硬编码目录、错误码漂移

单测全部使用内存里构造的数据，**不依赖任何真实 Excel 文件**；仓库里也不含任何业务数据。
