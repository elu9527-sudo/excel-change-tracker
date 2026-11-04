按行聚合的 Excel 新旧两版变更对比工具，本地运行、不联外网。

## 中文

- 变更按 Excel **行**聚合，卡片写「删了 N 行」而不是 N 个单元格
- 右侧整行前后对照，改动字段标黄，列名取自表头
- 行对齐：主键优先（含复合键、重复键），无可靠主键自动回退内容对齐
- 公式文本 + 缓存值一起比，删行造成的公式行号位移自动归一
- 忽略规则、50 行/页真分页、快照 LRU 缓存

## English

- Row-level change list: which records were deleted, added or modified
- Side-by-side before/after for the whole record, changed fields highlighted
- Primary-key alignment (composite and duplicate keys supported), content-based fallback
- Formula text and cached value both compared; row-shift normalisation
- Ignore rules, 50-row pagination, snapshot LRU cache

## Install / 安装

```
npm install
npm start          # http://127.0.0.1:3000
npm run demo       # 生成一对虚构样例文件 / generate a synthetic demo pair
```

Node.js 18+ (Windows / macOS / Linux). No network access required at runtime.
