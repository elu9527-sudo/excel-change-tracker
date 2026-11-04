'use strict';

/**
 * 主键识别与按主键行对齐（可选路径）。
 *
 * 背景：daff 的表对齐是按内容启发的，遇到"同一物料多行 / 大量恒定列"就会把相邻的
 * 近似行配错（实测 08-BOM「增量数据」多出 20 条假修改）。业务表只要有一个稳定主键
 * （物料编码、序号、单据号……），按主键配对就是精确的。
 *
 * 策略是"有则用、没有不要"：
 * 1. 在两张表里各自找"能唯一确定一行"的最小列组合（1~3 列）；
 * 2. 要求两版都能找到、且键集合重合率足够高（否则说明多半是换了一张表，回退）；
 * 3. 用主键配对：同键的行按出现顺序一一对应，多出来的算整行增/删；
 *    同键组内再按内容相似度做一次微调，避免同键多行被顺序打乱；
 * 4. 任何一步不满足 → 返回 null，调用方回退到 daff 对齐。
 *
 * 重复主键是允许的（BOM 里同一父项有多行），按"出现顺序 + 相似度"配对。
 */

const MAX_KEY_COLS = 6;
const MIN_COVERAGE = 0.9; // 键列的非空比例下限
const MIN_DISTINCT = 8; // 键列至少这么多个不同值，避免把状态列/日期列当键
const MAX_DUP_RATIO = 0.05; // 允许 5% 的重复键（重复键按顺序配对）
const MIN_OVERLAP = 0.5; // 两版键集合的最小重合率
const MAX_UNPAIRED_RATIO = 0.5; // 主键对齐后未配对行占比上限，超过认为键不可靠

const SEP = '\u0001';

/** 小表也允许用主键：不同值下限随行数缩放，避免"4 行的表永远识别不到主键" */
function minDistinctFor(rows) {
  return Math.max(3, Math.min(MIN_DISTINCT, Math.ceil(rows * 0.3)));
}

/** 单列统计（跳过第 0 行：业务表首行多为横幅/表头） */
function columnStats(matrix, j) {
  let nonEmpty = 0;
  const counts = new Map();
  for (let i = 1; i < matrix.length; i++) {
    const v = matrix[i][j];
    if (v === '') continue;
    nonEmpty += 1;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return { nonEmpty, distinct: counts.size };
}

/** 组合键字符串；任一列缺失返回 null（该行视为"无键行"） */
function keyOf(row, cols) {
  const parts = [];
  for (const j of cols) {
    const v = row[j];
    if (v === '' || v === undefined || v === null) return null;
    parts.push(String(v).trim());
  }
  return parts.join(SEP);
}

/** 组合键的重复率（重复行数 / 有键行数） */
function dupRatio(matrix, cols) {
  const rows = matrix.length - 1;
  if (rows <= 0) return 1;
  const seen = new Map();
  let keyed = 0;
  let dup = 0;
  for (let i = 1; i < matrix.length; i++) {
    const k = keyOf(matrix[i], cols);
    if (k === null) continue;
    keyed += 1;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) dup += 1;
  }
  return keyed ? dup / keyed : 1;
}

function coverage(matrix, cols) {
  const rows = matrix.length - 1;
  if (rows <= 0) return 0;
  let keyed = 0;
  for (let i = 1; i < matrix.length; i++) if (keyOf(matrix[i], cols) !== null) keyed += 1;
  return keyed / rows;
}

/**
 * 单列能不能直接当主键（最常见：物料编码、序号）。命中就立刻返回，避免扫全部列。
 * 单列的重复率可由统计直接算出：(非空数 - 不同值数) / 非空数，不必再扫一遍。
 */
function singleColumnKey(gA, gB, pairs, rowsA, rowsB) {
  for (const p of pairs) {
    const sa = columnStats(gA.matrix, p.prevCol);
    const sb = columnStats(gB.matrix, p.currCol);
    if (!sa.nonEmpty || !sb.nonEmpty) continue;
    if (sa.nonEmpty / rowsA < MIN_COVERAGE || sb.nonEmpty / rowsB < MIN_COVERAGE) continue;
    if (sa.distinct < minDistinctFor(rowsA) || sb.distinct < minDistinctFor(rowsB)) continue;
    const dupA = (sa.nonEmpty - sa.distinct) / sa.nonEmpty;
    const dupB = (sb.nonEmpty - sb.distinct) / sb.nonEmpty;
    if (dupA <= MAX_DUP_RATIO && dupB <= MAX_DUP_RATIO) {
      return { prevCols: [p.prevCol], currCols: [p.currCol] };
    }
  }
  return null;
}

/**
 * 找最小键列组合。返回 { prevCols, currCols } 或 null。
 * colPairs 提供 prev 列 → curr 列的映射，键列必须在两侧都映射得上。
 *
 * 选列策略：先看单列（快），不行再每步从剩余候选里挑"能把重复率压得最低"的一列
 * （而不是唯一值最多的）——像 08-BOM「增量数据」这种表，前 5 列单独看都不错、
 * 组合起来仍 47% 重复，真正起作用的是第 6 列。
 */
function detectKeyColumns(gA, gB, colPairs) {
  const pairs = colPairs.slice().sort((a, b) => a.prevCol - b.prevCol);
  if (!pairs.length) return null;

  const rowsA = Math.max(1, gA.rowCount - 1);
  const rowsB = Math.max(1, gB.rowCount - 1);

  const fast = singleColumnKey(gA, gB, pairs, rowsA, rowsB);
  if (fast) return fast;

  const candidates = [];
  for (const p of pairs) {
    const sa = columnStats(gA.matrix, p.prevCol);
    const sb = columnStats(gB.matrix, p.currCol);
    if (!sa.distinct || !sb.distinct) continue;
    if (sa.nonEmpty / rowsA < MIN_COVERAGE) continue;
    if (sb.nonEmpty / rowsB < MIN_COVERAGE) continue;
    if (sa.distinct < minDistinctFor(rowsA) || sb.distinct < minDistinctFor(rowsB)) continue;
    candidates.push(p);
  }
  if (!candidates.length) return null;

  // 行数多时按抽样评分（排序用），最终结果再全量复核，避免把大表比对拖慢一倍
  const sample = (matrix) => (matrix.length > 2000 ? matrix.filter((_, i) => i === 0 || i % 3 === 0) : matrix);

  const prevCols = [];
  const currCols = [];
  const used = new Set();
  for (let step = 0; step < MAX_KEY_COLS; step++) {
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      const c = candidates[i];
      const tryPrev = prevCols.concat(c.prevCol);
      const tryCurr = currCols.concat(c.currCol);
      if (coverage(gA.matrix, tryPrev) < MIN_COVERAGE || coverage(gB.matrix, tryCurr) < MIN_COVERAGE) continue;
      const score = Math.max(dupRatio(sample(gA.matrix), tryPrev), dupRatio(sample(gB.matrix), tryCurr));
      if (!best || score < best.score) best = { i, score, col: c };
    }
    if (!best) break;
    used.add(best.i);
    prevCols.push(best.col.prevCol);
    currCols.push(best.col.currCol);
    // 全量复核：两侧重复率都达标才认这个组合
    if (dupRatio(gA.matrix, prevCols) <= MAX_DUP_RATIO && dupRatio(gB.matrix, currCols) <= MAX_DUP_RATIO) {
      return { prevCols, currCols };
    }
    if (best.score <= 0) break; // 再加列也不会有改善
  }
  return null;
}

/** 键集合重合率：两版共有的键数 / 较少一侧的键数 */
function keyOverlap(gA, gB, prevCols, currCols) {
  const a = new Set();
  const b = new Set();
  for (let i = 1; i < gA.matrix.length; i++) {
    const k = keyOf(gA.matrix[i], prevCols);
    if (k !== null) a.add(k);
  }
  for (let i = 1; i < gB.matrix.length; i++) {
    const k = keyOf(gB.matrix[i], currCols);
    if (k !== null) b.add(k);
  }
  const min = Math.min(a.size, b.size);
  if (!min) return 0;
  let shared = 0;
  for (const k of a) if (b.has(k)) shared += 1;
  return shared / min;
}

/** 同键组内按相似度微调配对（组很小，O(k²) 可接受） */
function matchGroup(prevRows, currRows, colMap, gA, gB) {
  if (prevRows.length === 1 && currRows.length === 1) {
    return [{ prevRow: prevRows[0].row, currRow: currRows[0].row }];
  }
  const pairs = [];
  const usedCurr = new Set();
  for (const pr of prevRows) {
    let best = null;
    let bestScore = -1;
    for (let j = 0; j < currRows.length; j++) {
      if (usedCurr.has(j)) continue;
      let same = 0;
      let total = 0;
      for (const [pc, k] of colMap) {
        const pv = pr.matrixRow[pc];
        const cv = currRows[j].matrixRow[k];
        if (pv === '' && cv === '') continue;
        total += 1;
        if (pv === cv) same += 1;
      }
      const score = total ? same / total : 0;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best !== null) {
      usedCurr.add(best);
      pairs.push({ prevRow: pr.row, currRow: currRows[best].row });
    } else {
      pairs.push({ prevRow: pr.row, currRow: null });
    }
  }
  for (let j = 0; j < currRows.length; j++) {
    if (!usedCurr.has(j)) pairs.push({ prevRow: null, currRow: currRows[j].row });
  }
  return pairs;
}

/**
 * 按主键对齐。返回 { rowPairs, prevOnlyRows, currOnlyRows, key } 或 null（表示不该用主键）。
 */
function alignByKey(gA, gB, colPairs) {
  if (gA.rowCount < 2 || gB.rowCount < 2) return null;

  const keyCols = detectKeyColumns(gA, gB, colPairs);
  if (!keyCols) return null;
  if (keyOverlap(gA, gB, keyCols.prevCols, keyCols.currCols) < MIN_OVERLAP) return null;

  const colMap = new Map(colPairs.map((p) => [p.prevCol, p.currCol]));

  const buildSide = (g, cols) => {
    const byKey = new Map();
    const unkeyed = [];
    for (let i = 0; i < g.rowCount; i++) {
      // 第 0 行（表头/横幅）单独按 0↔0 配对，不参与主键分组，否则会被配对两次
      if (i === 0) continue;
      const row = { matrixIndex: i, cells: g.cellGrid[i] };
      const k = keyOf(g.matrix[i], cols);
      if (k === null) {
        unkeyed.push({ row, matrixRow: g.matrix[i] });
        continue;
      }
      const entry = { row, matrixRow: g.matrix[i] };
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(entry);
    }
    return { byKey, unkeyed };
  };

  const A = buildSide(gA, keyCols.prevCols);
  const B = buildSide(gB, keyCols.currCols);

  const rowPairs = [];
  const prevOnlyRows = [];
  const currOnlyRows = [];

  // 表头行（index 0）单独按 0↔0 配对，保持与 daff 语义一致
  if (gA.rowCount > 0 && gB.rowCount > 0) {
    rowPairs.push({ prevRow: { matrixIndex: 0, cells: gA.cellGrid[0] }, currRow: { matrixIndex: 0, cells: gB.cellGrid[0] } });
  }

  for (const [k, prevList] of A.byKey) {
    const currList = B.byKey.get(k);
    if (!currList) {
      for (const r of prevList) prevOnlyRows.push(r.row);
      continue;
    }
    for (const p of matchGroup(prevList, currList, colMap, gA, gB)) {
      if (p.prevRow && p.currRow) rowPairs.push(p);
      else if (p.prevRow) prevOnlyRows.push(p.prevRow);
      else if (p.currRow) currOnlyRows.push(p.currRow);
    }
  }
  for (const [k, currList] of B.byKey) {
    if (A.byKey.has(k)) continue;
    for (const r of currList) currOnlyRows.push(r.row);
  }

  // 无键行按"同一矩阵位置"配对（表头下的空行/说明行）
  const unkeyedCurr = new Map(B.unkeyed.map((e) => [e.row.matrixIndex, e]));
  for (const e of A.unkeyed) {
    const hit = unkeyedCurr.get(e.row.matrixIndex);
    if (hit) {
      rowPairs.push({ prevRow: e.row, currRow: hit.row });
      unkeyedCurr.delete(e.row.matrixIndex);
    } else {
      prevOnlyRows.push(e.row);
    }
  }
  for (const e of unkeyedCurr.values()) currOnlyRows.push(e.row);

  // 未配对行过多 → 键可能选错了，回退
  const maxRows = Math.max(gA.rowCount, gB.rowCount);
  if ((prevOnlyRows.length + currOnlyRows.length) / maxRows > MAX_UNPAIRED_RATIO) return null;

  rowPairs.sort((x, y) => x.prevRow.matrixIndex - y.prevRow.matrixIndex);
  return {
    rowPairs,
    prevOnlyRows,
    currOnlyRows,
    key: { prevCols: keyCols.prevCols, currCols: keyCols.currCols },
  };
}

module.exports = { alignByKey, detectKeyColumns };



