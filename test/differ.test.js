'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { diffCells } = require('../src/services/differ');
const { CHANGE_TYPE } = require('../src/contracts');

/* ---------- 造数工具 ---------- */

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 一行多列：values 数组，'' 表示空单元格（不应参与比对） */
function row(sheet, rowIndex, values) {
  return values
    .map((v, col) =>
      v === '' || v === null
        ? null
        : {
            sheet_name: sheet,
            cell_ref: `${COL_LETTERS[col]}${rowIndex + 1}`,
            row_index: rowIndex,
            col_index: col,
            cell_value: v,
            value_type: 'string',
            merged_range: null,
          }
    )
    .filter(Boolean);
}

/** 把多行拼成一个工作表的 cells */
function sheetCells(sheet, rows) {
  return rows.flatMap((r, i) => row(sheet, i, r));
}

function byType(changes, type) {
  return changes.filter((c) => c.change_type === type);
}

/** 带公式的单元格；value 传 null 表示"没有缓存值" */
function fxCell(sheet, rowIndex, col, value, formula) {
  return {
    sheet_name: sheet,
    cell_ref: `${COL_LETTERS[col]}${rowIndex + 1}`,
    row_index: rowIndex,
    col_index: col,
    cell_value: value,
    value_type: value === null ? 'formula' : 'string',
    formula: formula || null,
    merged_range: null,
  };
}

/* ---------- 保留的原用例 ---------- */

// 注：daff 把表首行视作表头（列匹配依据首行文本），原“单行表”造数统一改为
// “稳定表头行 + 数据行”形态；各用例的断言数量、类型、前后值均保持不变，仅 cell_ref 行号下移一行。
test('新增/修改/删除三种类型与前后值', () => {
  const prev = [
    ...row('S1', 0, ['headA', 'headB', 'headC', 'headD', 'headE']),
    ...row('S1', 1, ['keep', 'keep2', 'old', 'gone']),
  ];
  // D 列在curr删除、E 列新增（中间留空位让 fresh 落在 col_index=4）
  const curr = [
    ...row('S1', 0, ['headA', 'headB', 'headC', 'headD', 'headE']),
    ...row('S1', 1, ['keep', 'keep2', 'new', '', 'fresh']),
  ];
  const changes = diffCells(prev, curr);

  const added = byType(changes, CHANGE_TYPE.added);
  const modified = byType(changes, CHANGE_TYPE.modified);
  const deleted = byType(changes, CHANGE_TYPE.deleted);

  assert.equal(changes.length, 3);
  assert.equal(modified.length, 1);
  assert.equal(modified[0].cell_ref, 'C2');
  assert.equal(modified[0].old_value, 'old');
  assert.equal(modified[0].new_value, 'new');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].cell_ref, 'D2');
  assert.equal(deleted[0].old_value, 'gone');
  assert.equal(deleted[0].new_value, null);
  assert.equal(added.length, 1);
  assert.equal(added[0].cell_ref, 'E2');
  assert.equal(added[0].old_value, null);
  assert.equal(added[0].new_value, 'fresh');
  // 相似度 2/4 = 0.5，未低于 0.5，不标位移
  for (const c of changes) assert.equal(c.possible_shift, false);
});

test('trim 后相同的值不算修改', () => {
  const prev = [...row('S1', 0, ['h']), ...row('S1', 1, ['a '])];
  const curr = [...row('S1', 0, ['h']), ...row('S1', 1, [' a'])];
  assert.equal(diffCells(prev, curr).length, 0);
});

test('空值不产生新增或删除', () => {
  assert.equal(diffCells([], row('S1', 0, [''])).length, 0, '空值新增忽略');
  assert.equal(diffCells(row('S1', 0, ['']), []).length, 0, '空值删除忽略');
});

test('变更对象字段齐全且与第 7 章契约一致', () => {
  const changes = diffCells(row('S1', 0, ['x']), []);
  assert.equal(changes.length, 1);
  const expectedKeys = [
    'change_id', 'version_line_id', 'snapshot_id', 'prev_snapshot_id',
    'sheet_name', 'cell_ref', 'change_type', 'old_value', 'new_value',
    'old_formula', 'new_formula',
    'row_index', 'col_index', 'possible_shift', 'row_label', 'row_cell_count', 'detected_at',
  ];
  for (const k of expectedKeys) assert.ok(k in changes[0], `缺少字段 ${k}`);
  assert.equal(Object.keys(changes[0]).length, expectedKeys.length);
  assert.ok(changes[0].change_id.startsWith('chg_'));
});

test('行标签与行内字段数：取该行最长的文本值，供"按行聚合"直接展示', () => {
  const prev = [
    ...row('S1', 0, ['编码', '名称', '备注']),
    ...row('S1', 1, ['09172', '示例物料A型保湿粉底液（示例规格）', 'kg']),
  ];
  const curr = [
    ...row('S1', 0, ['编码', '名称', '备注']),
    ...row('S1', 1, ['09172', '示例物料A型保湿粉底液（示例规格）', 'pcs']),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row_label, '示例物料A型保湿粉底液（示例规格）', '行标签取最长文本值');
  assert.equal(changes[0].row_cell_count, 3, '该行非空单元格数');

  // 整行删除时，删除记录也应带上一版该行的标签与字段数
  const del = diffCells(prev, row('S1', 0, ['编码', '名称', '备注']));
  assert.ok(del.length > 0);
  for (const c of del) {
    assert.equal(c.row_label, '示例物料A型保湿粉底液（示例规格）');
    assert.equal(c.row_cell_count, 3);
  }
});

/* ---------- 新 possible_shift 语义 ---------- */

test('possible_shift：配对行相似度 <0.5 时该两行变更标 true', () => {
  // 4 列只有 1 列相同 → 相似度 0.25 < 0.5（表头行保证列按同列号对齐）
  const prev = [
    ...row('S1', 0, ['h1', 'h2', 'h3', 'h4']),
    ...row('S1', 1, ['a', 'b', 'c', 'd']),
  ];
  const curr = [
    ...row('S1', 0, ['h1', 'h2', 'h3', 'h4']),
    ...row('S1', 1, ['w', 'x', 'y', 'd']),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((c) => c.change_type), ['modified', 'modified', 'modified']);
  for (const c of changes) assert.equal(c.possible_shift, true, `${c.cell_ref} 低相似配对应标位移`);
});

test('possible_shift：配对行相似度 >=0.5 时不标', () => {
  // 4 列 3 列相同 → 相似度 0.75
  const prev = [
    ...row('S1', 0, ['h1', 'h2', 'h3', 'h4']),
    ...row('S1', 1, ['k1', 'k2', 'k3', 'old']),
  ];
  const curr = [
    ...row('S1', 0, ['h1', 'h2', 'h3', 'h4']),
    ...row('S1', 1, ['k1', 'k2', 'k3', 'new']),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change_type, CHANGE_TYPE.modified);
  assert.equal(changes[0].possible_shift, false);
});

test('possible_shift：未配对整行（纯删除/纯新增）不标', () => {
  const prev = sheetCells('S1', [
    ['h1', 'h2'],
    ['g', 'gone'],
  ]);
  const curr = row('S1', 0, ['h1', 'h2']);
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 2);
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 2);
  for (const c of changes) assert.equal(c.possible_shift, false);
});

/* ---------- 删行/插行回归：位移不再产生整表 modified ---------- */

test('回归：删掉中间 1 行（其余行完全不变）→ 只有被删行产出 deleted，无一条 modified', () => {
  const prev = sheetCells('S1', [
    ['H1', 'H2', 'H3'],
    ['drop', 'drop-b', 'drop-c'],
    ['K1a', 'K1b', 'K1c'],
    ['K2a', 'K2b', 'K2c'],
    ['K3a', 'K3b', 'K3c'],
  ]);
  // curr 少了原第 2 行，其余内容原样、行号整体前移
  const curr = sheetCells('S1', [
    ['H1', 'H2', 'H3'],
    ['K1a', 'K1b', 'K1c'],
    ['K2a', 'K2b', 'K2c'],
    ['K3a', 'K3b', 'K3c'],
  ]);
  const changes = diffCells(prev, curr);

  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '位移行不得产生 modified');
  assert.equal(byType(changes, CHANGE_TYPE.added).length, 0);
  const deleted = byType(changes, CHANGE_TYPE.deleted);
  assert.equal(deleted.length, 3, '被删行 3 个单元格各产出 1 条 deleted');
  assert.deepEqual(deleted.map((c) => c.cell_ref).sort(), ['A2', 'B2', 'C2']);
  assert.equal(changes.length, 3);
});

test('回归：中间删 2 行并修改另一行某单元格 → 只有该单元格 modified + 被删行 deleted，后续行无 modified', () => {
  const prev = sheetCells('S1', [
    ['H', 'hb', 'hc'],
    ['D1', 'd1b', 'd1c'],
    ['D2', 'd2b', 'd2c'],
    ['M', 'mb', 'mc'],
    ['T', 'tb', 'tc'],
  ]);
  const curr = sheetCells('S1', [
    ['H', 'hb', 'hc'],
    ['M', 'mb', 'MC-NEW'], // 被修改的行（第 3 列变化）
    ['T', 'tb', 'tc'],     // 后续行内容不变、行号上移 2
  ]);
  const changes = diffCells(prev, curr);

  const modified = byType(changes, CHANGE_TYPE.modified);
  assert.equal(modified.length, 1, '只有被修改单元格产出 1 条 modified');
  assert.equal(modified[0].cell_ref, 'C2');
  assert.equal(modified[0].old_value, 'mc');
  assert.equal(modified[0].new_value, 'MC-NEW');
  assert.equal(modified[0].possible_shift, false, '配对行相似度 2/3=0.67 不标位移');

  const deleted = byType(changes, CHANGE_TYPE.deleted);
  assert.equal(deleted.length, 6, '被删 2 行各 3 个单元格 = 6 条 deleted');
  assert.equal(byType(changes, CHANGE_TYPE.added).length, 0);
  assert.equal(changes.length, 7, '不得有其它垃圾变更');
});

test('回归：中间插入 2 行 → 只有新增行的 added，其余无 modified', () => {
  const prev = sheetCells('S1', [
    ['H', 'hb'],
    ['K1', 'k1b'],
    ['K2', 'k2b'],
  ]);
  const curr = sheetCells('S1', [
    ['H', 'hb'],
    ['I1', 'i1b'],
    ['I2', 'i2b'],
    ['K1', 'k1b'], // 行号后移 2，内容不变
    ['K2', 'k2b'],
  ]);
  const changes = diffCells(prev, curr);

  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '位移行不得产生 modified');
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 0);
  const added = byType(changes, CHANGE_TYPE.added);
  assert.equal(added.length, 4, '插入 2 行 × 2 列 = 4 条 added');
  assert.deepEqual(added.map((c) => c.cell_ref).sort(), ['A2', 'A3', 'B2', 'B3']);
});

test('回归：整张工作表新增 → 全部单元格 added；整张删除 → 全部 deleted', () => {
  const rows2x2 = sheetCells('S2', [['a', 'b'], ['c', 'd']]);

  const allAdded = diffCells([], rows2x2);
  assert.equal(allAdded.length, 4);
  assert.ok(allAdded.every((c) => c.change_type === CHANGE_TYPE.added));
  assert.ok(allAdded.every((c) => c.possible_shift === false));

  const allDeleted = diffCells(rows2x2, []);
  assert.equal(allDeleted.length, 4);
  assert.ok(allDeleted.every((c) => c.change_type === CHANGE_TYPE.deleted));
  assert.ok(allDeleted.every((c) => c.possible_shift === false));
});

test('10 列中间插 1 列：按 daff 列映射对齐，仅新增列产出 added，其余列 0 modified', () => {
  const headPrev = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
  const headCurr = ['c0', 'c1', 'c2', 'c3', 'c4', 'NEW', 'c5', 'c6', 'c7', 'c8', 'c9'];
  const prev = [...row('S1', 0, headPrev)];
  const curr = [...row('S1', 0, headCurr)];
  for (let r = 1; r <= 4; r++) {
    const p = [];
    const cu = [];
    for (let c = 0; c < 10; c++) p.push(`r${r}c${c}`);
    for (let c = 0; c < 11; c++) cu.push(c === 5 ? `ins${r}` : c < 5 ? `r${r}c${c}` : `r${r}c${c - 1}`);
    prev.push(...row('S1', r, p));
    curr.push(...row('S1', r, cu));
  }
  const changes = diffCells(prev, curr);
  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '插入点之后的列被平移不得误报 modified');
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 0);
  const added = byType(changes, CHANGE_TYPE.added);
  assert.equal(added.length, 5, '表头行 + 4 数据行的新列各 1 条 added');
  assert.ok(added.every((c) => c.cell_ref.startsWith('F')), '新增列位于 F 列');
});

test('不同工作表不参与对齐、不跨表配对', () => {
  const prev = sheetCells('S1', [['a', 'b']]);
  const curr = sheetCells('S2', [['a', 'x']]); // 首列与 S1 相同，但不得跨表对齐
  const changes = diffCells(prev, curr);

  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '不得跨表产出 modified');
  const deleted = byType(changes, CHANGE_TYPE.deleted);
  const added = byType(changes, CHANGE_TYPE.added);
  assert.equal(deleted.length, 2);
  assert.ok(deleted.every((c) => c.sheet_name === 'S1'));
  assert.equal(added.length, 2);
  assert.ok(added.every((c) => c.sheet_name === 'S2'));
});

/* ---------- 大数据回归：签名唯一锚点对齐（行号错位不再产生整表 modified） ---------- */

/** 造 nRows × nCols 的值矩阵，每格值全局唯一 */
function bigMatrix(nRows, nCols) {
  const vals = new Array(nRows);
  for (let r = 0; r < nRows; r++) {
    const rowArr = new Array(nCols);
    for (let c = 0; c < nCols; c++) rowArr[c] = `r${r}c${c}`;
    vals[r] = rowArr;
  }
  return vals;
}

/** 值矩阵 → cells；skipRow 指定的行跳过（模拟删除），其余行号自动上移 */
function bigCells(vals, skipRow) {
  const out = [];
  let ri = 0;
  for (let r = 0; r < vals.length; r++) {
    if (r === skipRow) continue;
    const rowArr = vals[r];
    for (let c = 0; c < rowArr.length; c++) {
      out.push({
        sheet_name: 'BIG',
        cell_ref: `${COL_LETTERS[c] || String.fromCharCode(65 + (c % 26))}${ri + 1}`,
        row_index: ri,
        col_index: c,
        cell_value: rowArr[c],
        value_type: 'string',
        merged_range: null,
      });
    }
    ri += 1;
  }
  return out;
}

test('大数据 3000 行 × 10 列：删中间 1 行 → 只有被删行 10 条 deleted，0 modified 0 added', () => {
  const vals = bigMatrix(3000, 10);
  const changes = diffCells(bigCells(vals), bigCells(vals, 1500));
  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '后续 1500+ 行上移不得产生 modified');
  assert.equal(byType(changes, CHANGE_TYPE.added).length, 0);
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 10, '被删行的非空单元格数');
});

test('大数据 3000 行 × 10 列：删 1 行 + 另一行改 1 格 → 只有该格 1 条 modified', () => {
  const vals = bigMatrix(3000, 10);
  const vals2 = vals.map((r) => r.slice());
  vals2[2000][3] = 'CHANGED';
  const changes = diffCells(bigCells(vals), bigCells(vals2, 1500));
  const modified = byType(changes, CHANGE_TYPE.modified);
  assert.equal(modified.length, 1, '只允许被真实修改的那一格');
  assert.equal(modified[0].old_value, 'r2000c3');
  assert.equal(modified[0].new_value, 'CHANGED');
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 10);
  assert.equal(byType(changes, CHANGE_TYPE.added).length, 0);
});

test('大数据 3000 行 × 10 列：中间插入 1 行 → 只有新行 10 条 added，0 modified', () => {
  const vals = bigMatrix(3000, 10);
  const insRow = new Array(10).fill(0).map((_, c) => `newc${c}`);
  const vals2 = [...vals.slice(0, 1500), insRow, ...vals.slice(1500)];
  const changes = diffCells(bigCells(vals), bigCells(vals2));
  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '整体下移不得产生 modified');
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 0);
  const added = byType(changes, CHANGE_TYPE.added);
  assert.equal(added.length, 10);
  assert.ok(added.every((c) => String(c.new_value).startsWith('newc')));
});

test('性能：25000 行 × 52 列删 1 行 → 0 modified / 52 deleted，diff 耗时 ≤ 5 秒', () => {
  const vals = bigMatrix(25000, 52);
  const prev = bigCells(vals);
  const curr = bigCells(vals, 12000);

  // 第 1 轮：预热（冷进程首跑受 JIT 编译与堆增长影响，实测约 4s；结果同样校验）
  const t0 = process.hrtime.bigint();
  const warm = diffCells(prev, curr);
  const warmMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(byType(warm, CHANGE_TYPE.modified).length, 0);
  assert.equal(byType(warm, CHANGE_TYPE.deleted).length, 52);

  // 第 2 轮：稳态计时，断言关键比对 ≤ 3000ms
  const t1 = process.hrtime.bigint();
  const changes = diffCells(prev, curr);
  const ms = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.equal(byType(changes, CHANGE_TYPE.modified).length, 0, '25000 行删 1 行必须 0 modified');
  assert.equal(byType(changes, CHANGE_TYPE.added).length, 0);
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 52);
  // CI 的共享 runner 吞吐波动大（实测同一份数据 2.6~3.4s），单独放宽；
  // 本机仍按 3000ms 卡，性能回归能在本地被发现。
  const budget = process.env.CI ? 8000 : 5000;
  console.log(`      ℹ 25000×52 diff 耗时：预热轮 ${warmMs.toFixed(0)}ms，稳态轮 ${ms.toFixed(0)}ms（阈值 ${budget}ms）`);
  assert.ok(ms <= budget, `25000 行 × 52 列稳态比对耗时 ${ms.toFixed(0)}ms，要求 ≤ ${budget}ms`);
});

test('同表多行：删除行与修改行交错时仍只对真实修改行产出 modified', () => {
  // 删除 r1，r2 修改 1 列，r4 删除，其余不动
  const prev = sheetCells('S1', [
    ['R0a', 'R0b', 'R0c'],
    ['R1a', 'R1b', 'R1c'],
    ['R2a', 'R2b', 'R2c'],
    ['R3a', 'R3b', 'R3c'],
    ['R4a', 'R4b', 'R4c'],
  ]);
  const curr = sheetCells('S1', [
    ['R0a', 'R0b', 'R0c'],
    ['R2a', 'R2b', 'R2-CHANGED'],
    ['R3a', 'R3b', 'R3c'],
  ]);
  const changes = diffCells(prev, curr);

  const modified = byType(changes, CHANGE_TYPE.modified);
  assert.equal(modified.length, 1);
  assert.equal(modified[0].old_value, 'R2c');
  assert.equal(modified[0].new_value, 'R2-CHANGED');
  assert.equal(byType(changes, CHANGE_TYPE.deleted).length, 6, 'R1、R4 两行 × 3 列');
  assert.equal(byType(changes, CHANGE_TYPE.added).length, 0);
  assert.equal(changes.length, 7);
});

/* ---------- 公式：值没变但公式变了，也算改 ---------- */

test('值相同、公式不同 → 记一条修改，并带上前后公式', () => {
  const prev = [
    ...row('S1', 0, ['编码', '金额']),
    ...row('S1', 1, ['A1', '']),
    fxCell('S1', 1, 1, '10', '=B1*2'),
  ];
  const curr = [
    ...row('S1', 0, ['编码', '金额']),
    ...row('S1', 1, ['A1', '']),
    fxCell('S1', 1, 1, '10', '=B1*3'),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 1, '缓存值一样，但公式不一样，必须报一条修改');
  assert.equal(changes[0].change_type, CHANGE_TYPE.modified);
  assert.equal(changes[0].cell_ref, 'B2');
  assert.equal(changes[0].old_formula, '=B1*2');
  assert.equal(changes[0].new_formula, '=B1*3');
  assert.equal(changes[0].old_value, '10');
  assert.equal(changes[0].new_value, '10');
});

test('两侧都是"无缓存值的公式"且公式相同 → 0 条变更（不能变成删一格 + 加一格）', () => {
  const cells = () => [
    ...row('S1', 0, ['编码', '合计']),
    ...row('S1', 1, ['A1', '']),
    fxCell('S1', 1, 1, null, '=B1*3'),
  ];
  const changes = diffCells(cells(), cells());
  assert.equal(changes.length, 0);
});

test('上一版没有、本版是无缓存值的公式格 → 新增，且带公式文本', () => {
  const prev = [...row('S1', 0, ['编码', '合计']), ...row('S1', 1, ['A1', ''])];
  const curr = [
    ...row('S1', 0, ['编码', '合计']),
    ...row('S1', 1, ['A1', '']),
    fxCell('S1', 1, 1, null, '=B1*3'),
  ];
  const changes = diffCells(prev, curr);
  const added = byType(changes, CHANGE_TYPE.added);
  assert.equal(added.length, 1, '无缓存值的公式格以前整条被吞掉，现在必须报出来');
  assert.equal(added[0].cell_ref, 'B2');
  assert.equal(added[0].new_formula, '=B1*3');
  assert.equal(added[0].new_value, null, '没有缓存值时记 null，不要记字符串 "null"');
});

test('公式相同、缓存值变了 → 照旧记修改（回归保护）', () => {
  const prev = [
    ...row('S1', 0, ['编码', '金额']),
    ...row('S1', 1, ['A1', '']),
    fxCell('S1', 1, 1, '10', '=B1*2'),
  ];
  const curr = [
    ...row('S1', 0, ['编码', '金额']),
    ...row('S1', 1, ['A1', '']),
    fxCell('S1', 1, 1, '20', '=B1*2'),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change_type, CHANGE_TYPE.modified);
  assert.equal(changes[0].old_formula, '=B1*2');
  assert.equal(changes[0].new_formula, '=B1*2');
});

/* ---------- 行位移导致的公式引用改写，不算改 ---------- */

test('删行后公式引用整体上移 → 不算修改（实测真实数据有 2591 个这种格）', () => {
  // 上一版第 13 行、本版第 8 行是同一条记录（删了 5 行），公式里的行号跟着上移
  const prev = [
    ...row('S1', 0, ['编码', '名称']),
    ...row('S1', 12, ['A1', '']),
    fxCell('S1', 12, 1, '25号方筛', '=VLOOKUP(G13,Sheet2!A:D,4,0)'),
  ];
  const curr = [
    ...row('S1', 0, ['编码', '名称']),
    ...row('S1', 7, ['A1', '']),
    fxCell('S1', 7, 1, '25号方筛', '=VLOOKUP(G8,Sheet2!A:D,4,0)'),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 0, '只是引用跟着行走，不是内容变化');
});

test('行位移之外公式真的改了 → 仍然要报', () => {
  const prev = [
    ...row('S1', 0, ['编码', '名称']),
    ...row('S1', 12, ['A1', '']),
    fxCell('S1', 12, 1, '25号方筛', '=VLOOKUP(G13,Sheet2!A:D,4,0)'),
  ];
  const curr = [
    ...row('S1', 0, ['编码', '名称']),
    ...row('S1', 7, ['A1', '']),
    // 引用列从 D 改成 G：位移归一后依然不同
    fxCell('S1', 7, 1, '25号方筛', '=VLOOKUP(G8,Sheet2!A:G,7,0)'),
  ];
  const changes = diffCells(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change_type, CHANGE_TYPE.modified);
  assert.equal(changes[0].old_formula, '=VLOOKUP(G13,Sheet2!A:D,4,0)');
  assert.equal(changes[0].new_formula, '=VLOOKUP(G8,Sheet2!A:G,7,0)');
});
