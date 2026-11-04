'use strict';

/**
 * 单工作表行列对齐：复用 daff（MIT）的表格匹配器，替代此前自写对齐。
 *
 * 所用 API 与依据（daff@1.4.2，动手前已读 node_modules/daff/README.md L114-157
 * 与 lib/daff.js 源码，并以探查脚本实测确认，不凭记忆）：
 *
 *   const alignment = daff.compareTables(new daff.TableView(matrixA), new daff.TableView(matrixB)).align();
 *
 *   - alignment.a2b(i)：prev 矩阵行 i → curr 矩阵行号；返回 -1（link 了但无配对）
 *     或 undefined（无键）均视为未配对。lib/daff.js coopy_Alignment.prototype.link/a2b。
 *   - alignment.b2a(j)：反向映射；alignment.ha / hb = 两侧矩阵行数（range() 在
 *     alignCore2 中以 a.get_height()/b.get_height() 设定）。
 *   - alignment.meta 是列对齐（lib/daff.js L1186 alignCore2 → alignColumns(align.meta,a,b)），
 *     meta.a2b(j) 给 prev 矩阵列 → curr 矩阵列；因此本版 daff 支持列映射，
 *     colPairs 返回真实列配对。若未来版本不再暴露列对齐，colPairs 为空数组，
 *     differ 侧自动回退“同列号比较”（本文件不依赖该假设）。
 *
 * daff 语义限制（lib/daff.js L1182+ 及实测）：
 *   TableView 把矩阵第一行当作表头：行 0 强制 0↔0 配对，且列匹配由行 0 文本决定。
 *   ECT 的真实工作表首行通常是稳定列名，该语义正好服务于列插删对齐；
 *   但“只有一行的表”（表头行即数据行）列匹配文本即数据本身，实测会把改值的列
 *   标记成 -1（列删除），列映射不可靠——调用方应知悉（单行表请保证首行稳定，
 *   或接受列按同列号语义）。
 *
 * 性能：对齐主成本在 daff 匹配。实测 25000 行 × 52 列删 1 行：
 *   默认 flags align ≈ 3.4s；关闭 count_like_a_spreadsheet 后 ≈ 2.3s
 *   （该开关让 daff 在匹配时对数字形单元格做“电子表格式”模糊计数，
 *   而 ECT 的单元格比较由 differ 自行完成，不需要该行为；实测两种设置
 *   的行/列配对结果一致，含 '1' vs '1.0' 的数字形探针）。
 */

const daff = require('daff');
const { alignByKey } = require('./keyAlign');

// 每次复用同一个 flags 实例：仅关闭数字形单元格的模糊计数以提速
const ALIGN_FLAGS = new daff.CompareFlags();
ALIGN_FLAGS.count_like_a_spreadsheet = false;

/**
 * cells → 连续矩阵：行、列取该表 min~max 连续编号；空位矩阵元为 ''，
 * cellGrid 对应位置为 null；非空但标准化后为空的单元格也按空处理（不进入 cellGrid）。
 */
function buildGrid(cells) {
  if (!cells.length) return null;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const c of cells) {
    if (c.row_index < minRow) minRow = c.row_index;
    if (c.row_index > maxRow) maxRow = c.row_index;
    if (c.col_index < minCol) minCol = c.col_index;
    if (c.col_index > maxCol) maxCol = c.col_index;
  }
  const rowCount = maxRow - minRow + 1;
  const colCount = maxCol - minCol + 1;
  const matrix = new Array(rowCount);
  const cellGrid = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    matrix[i] = new Array(colCount).fill('');
    cellGrid[i] = new Array(colCount).fill(null);
  }
  for (const c of cells) {
    const raw = c.cell_value;
    // 热路径：解析产出的 cell_value 基本都是短字符串，避免多余的 String() 包装
    const value = raw === null || raw === undefined ? '' : (typeof raw === 'string' ? raw.trim() : String(raw).trim());
    // 没有值的格子也要留在 cellGrid 里：只有公式、没有缓存值的格（value=null, formula 有值）
    // 是真实存在的单元格，丢了它就没法比"公式改没改"。
    if (value === '' && !c.formula) continue;
    const i = c.row_index - minRow;
    const j = c.col_index - minCol;
    matrix[i][j] = value;
    cellGrid[i][j] = c;
  }

  // daff 以矩阵第 0 行作为列标题来配列；业务表首行常是横幅/说明行，大片单元格为空，
  // 这些列会配不上（实测 40 列只配上 36 列），进而被误判成整列删除/新增。
  // 这里只给"空标题"补一个按列号稳定的占位名——仅用于对齐，不参与单元格比对。
  for (let j = 0; j < colCount; j++) {
    if (matrix[0][j] === '') matrix[0][j] = `~\u0000col${j}`;
  }

  return { minRow, minCol, rowCount, colCount, matrix, cellGrid };
}

function makeRowObject(grid, i) {
  return { matrixIndex: i, cells: grid.cellGrid[i] };
}

/**
 * 列内容签名：给若干列各收集"出现过的值"集合，用于按内容补齐列映射。
 * 只统计被点名的列，避免全表建索引。
 */
function columnSignatures(matrix, colIndexes) {
  const sets = new Map();
  for (const j of colIndexes) sets.set(j, new Set());
  for (const row of matrix) {
    for (const j of colIndexes) {
      const v = row[j];
      if (v !== '' && v !== undefined && v !== null) sets.get(j).add(v);
    }
  }
  return sets;
}

/**
 * 残差列匹配：daff 只用"首行文本"配列，而业务表首行常是横幅/说明行，
 * 空列或重复文本的列会配不上（实测某 40 列的表只配上 36 列），
 * 于是那些列被当成"整列删除/新增"，同一行既报删除又报新增，噪音压过真实变更。
 *
 * 这里按"列内容集合"的重合度补配，但要求**互为最优**：
 * 表里常有若干列内容高度相近（如都是"必填/number"这类说明列），
 * 只比"最优明显优于次优"会把它们全部拒掉；互为最优能稳定分开。
 */
function fillUnmappedColumns(colPairs, gA, gB) {
  const mappedPrev = new Set(colPairs.map((p) => p.prevCol));
  const usedCurr = new Set(colPairs.map((p) => p.currCol));
  const unmappedPrev = [];
  for (let j = 0; j < gA.colCount; j++) if (!mappedPrev.has(j)) unmappedPrev.push(j);
  const freeCurr = [];
  for (let k = 0; k < gB.colCount; k++) if (!usedCurr.has(k)) freeCurr.push(k);
  if (!unmappedPrev.length || !freeCurr.length) return colPairs;

  const sigA = columnSignatures(gA.matrix, unmappedPrev);
  const sigB = columnSignatures(gB.matrix, freeCurr);

  // 评分：值集合重合度（交集 / 较大集合），1.0 = 两列取值完全相同。
  // 业务表里常有内容完全相同的重复列（如两列都只有"备注"），
  // 因此同分时按"列位置最近"决胜——列通常保持原有先后顺序。
  const score = (A, B) => {
    if (!A.size || !B.size) return 0;
    const small = A.size <= B.size ? A : B;
    const large = A.size <= B.size ? B : A;
    let inter = 0;
    for (const v of small) if (large.has(v)) inter += 1;
    return inter / large.size;
  };
  const betterPair = (a, b) => {
    if (!b) return true;
    if (a.score !== b.score) return a.score > b.score;
    return a.distance < b.distance;
  };

  const bestCurr = new Map(); // prevCol → {k, score, distance}
  const bestPrev = new Map(); // currCol → {j, score, distance}
  for (const j of unmappedPrev) {
    let pick = null;
    for (const k of freeCurr) {
      const cand = { k, score: score(sigA.get(j), sigB.get(k)), distance: Math.abs(k - j) };
      if (betterPair(cand, pick)) pick = cand;
    }
    if (pick && pick.score > 0) bestCurr.set(j, pick);
  }
  for (const k of freeCurr) {
    let pick = null;
    for (const j of unmappedPrev) {
      const cand = { j, score: score(sigA.get(j), sigB.get(k)), distance: Math.abs(k - j) };
      if (betterPair(cand, pick)) pick = cand;
    }
    if (pick && pick.score > 0) bestPrev.set(k, pick);
  }

  for (const [j, pick] of bestCurr) {
    const back = bestPrev.get(pick.k);
    if (!back || back.j !== j) continue; // 只接受互为最优
    if (pick.score < 0.6) continue; // 重合度太低：宁可不配，交人工判断
    colPairs.push({ prevCol: j, currCol: pick.k });
  }
  return colPairs;
}

/**
 * 残留行修复：daff 采用启发式配对，个别"改了几格"的行会被留成未配对，
 * 于是同一条记录既报"整行删除"又报"整行新增"，把 1 处修改淹成几十条噪音
 * （实测：改 2 格的 BOM 行被拆成删 20 格 + 增 20 格）。
 *
 * 这里对两侧的残留行再做一次"按列映射的内容相似度"配对：
 * 相似度 = 相同单元格数 / 两行非空单元格数的较大值，要求互为最优且 ≥0.6。
 * 只处理残留行，不影响 daff 已配好的部分；配对后交给 differ 产出字段级修改。
 */
function repairUnpairedRows(rowPairs, prevOnlyRows, currOnlyRows, colPairs, gA, gB) {
  if (!prevOnlyRows.length || !currOnlyRows.length) return;
  // 残留行过多时不强行修（O(n×m) 且配对收益不确定），交人工复核更稳妥
  if (prevOnlyRows.length > 200 || currOnlyRows.length > 200) return;

  const colMap = new Map();
  const currColSet = new Set();
  for (const p of colPairs) {
    colMap.set(p.prevCol, p.currCol);
    currColSet.add(p.currCol);
  }

  const toMap = (cells) => {
    const m = new Map();
    for (const c of cells) if (c) m.set(c.col_index, c.cell_value);
    return m;
  };
  const prevRows = prevOnlyRows.map((r) => ({ row: r, cells: toMap(r.cells) }));
  const currRows = currOnlyRows.map((r) => ({ row: r, cells: toMap(r.cells) }));

  /**
   * 差异格子数（按列映射对齐后统计，含单侧缺失）。
   * 补配对的硬约束：被改的格子必须是少数。
   * 删掉一条、又插进另一条时，两行在编码/名称等关键列上全都不同，
   * 差异格数会很大——这种必须保持"删 + 增"，不能合并成"修改"。
   */
  const diffCount = (a, b) => {
    let n = 0;
    const seenCurr = new Set();
    for (const [pc, pv] of a.cells) {
      const k = colMap.get(pc);
      if (k === undefined) { n += 1; continue; }
      const cv = b.cells.get(k);
      if (cv === undefined) { n += 1; continue; }
      seenCurr.add(k);
      if (String(pv).trim() !== String(cv).trim()) n += 1;
    }
    for (const cc of b.cells.keys()) {
      if (currColSet.has(cc) && !seenCurr.has(cc)) n += 1;
    }
    return n;
  };

  const sim = (a, b) => {
    let same = 0;
    let nA = 0;
    let nB = 0;
    for (const [pc, pv] of a.cells) {
      nA += 1;
      const k = colMap.get(pc);
      if (k === undefined) continue;
      const cv = b.cells.get(k);
      if (cv === undefined) continue;
      if (String(pv).trim() === String(cv).trim()) same += 1;
    }
    // 分母只统计落在列映射内的列，避免整行宽度差异影响
    for (const cc of b.cells.keys()) if (currColSet.has(cc)) nB += 1;
    const denom = Math.max(nA, nB);
    return denom ? same / denom : 0;
  };

  const bestForPrev = prevRows.map(() => null);
  const bestForCurr = currRows.map(() => null);

  const rowIdxOf = (cells) => {
    for (const c of cells) if (c) return c.row_index;
    return -1;
  };
  // 行号整体位移的中位数：插入/删除行后，配对行的"当前行 - 上一版行"基本一致，
  // 用它给"内容同样像"的候选排序，避免把新插入的行配到几十行之外的近似重复行上。
  const offsets = rowPairs
    .map((p) => rowIdxOf(p.currRow.cells) - rowIdxOf(p.prevRow.cells))
    .sort((a, b) => a - b);
  const shift = offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0;

  const better = (a, b) => {
    if (!b) return true;
    if (a.score !== b.score) return a.score > b.score;
    return a.dist < b.dist;
  };

  for (let i = 0; i < prevRows.length; i++) {
    const pi = rowIdxOf(prevRows[i].row.cells);
    for (let j = 0; j < currRows.length; j++) {
      const s = sim(prevRows[i], currRows[j]);
      if (s <= 0) continue;
      const ci = rowIdxOf(currRows[j].row.cells);
      const cand = { idx: j, score: s, dist: Math.abs(ci - pi - shift) };
      if (better(cand, bestForPrev[i])) bestForPrev[i] = cand;
      const back = { idx: i, score: s, dist: cand.dist };
      if (better(back, bestForCurr[j])) bestForCurr[j] = back;
    }
  }

  const repairedPrev = new Set();
  const repairedCurr = new Set();
  for (let i = 0; i < prevRows.length; i++) {
    const pick = bestForPrev[i];
    if (!pick) continue;
    const back = bestForCurr[pick.idx];
    if (!back || back.idx !== i) continue; // 互为最优才算
    // 差异格必须是少数，否则是两条不同记录（删一条 + 加一条），不能合并成修改
    const size = Math.max(prevRows[i].cells.size, currRows[pick.idx].cells.size);
    const diff = diffCount(prevRows[i], currRows[pick.idx]);
    if (diff > Math.max(2, Math.ceil(size * 0.15))) continue;
    // 很窄的行（≤5 个非空格）本来就没什么可比，"差 2 格"已经足够像；
    // 宽行仍要求相似度 ≥0.6，避免把重写过的行硬并成修改
    if (size > 5 && pick.score < 0.6) continue;
    rowPairs.push({ prevRow: prevRows[i].row, currRow: currRows[pick.idx].row });
    repairedPrev.add(i);
    repairedCurr.add(pick.idx);
  }

  for (let i = prevRows.length - 1; i >= 0; i--) {
    if (repairedPrev.has(i)) prevOnlyRows.splice(prevOnlyRows.indexOf(prevRows[i].row), 1);
  }
  for (let j = currRows.length - 1; j >= 0; j--) {
    if (repairedCurr.has(j)) currOnlyRows.splice(currOnlyRows.indexOf(currRows[j].row), 1);
  }
}

function emptyResult() {
  return { rowPairs: [], prevOnlyRows: [], currOnlyRows: [], colPairs: [] };
}

function rowsOf(grid) {
  const out = [];
  for (let i = 0; i < grid.rowCount; i++) out.push(makeRowObject(grid, i));
  return out;
}

/**
 * 对齐同一张工作表的前后两版单元格。
 * 返回 { rowPairs, prevOnlyRows, currOnlyRows, colPairs }：
 * - rowPairs：daff 确认为同一行（含“被修改的行”配对）的配对，元素 { prevRow, currRow }，
 *   行对象 { matrixIndex, cells }（cells 按矩阵列位，元素为原始 cell 或 null）；
 * - prevOnlyRows / currOnlyRows：无配对行（整行删除 / 整行新增）；
 * - colPairs：矩阵列号配对 { prevCol, currCol }（仅列映射中实际存在的配对）。
 * 某侧无单元格时不调 daff（该侧全为未配对行）；两侧都无则返回空结果。
 */
function alignRows(prevCells, currCells) {
  const gA = buildGrid(prevCells || []);
  const gB = buildGrid(currCells || []);

  if (!gA && !gB) return emptyResult();
  if (!gA) return { rowPairs: [], prevOnlyRows: [], currOnlyRows: rowsOf(gB), colPairs: [] };
  if (!gB) return { rowPairs: [], prevOnlyRows: rowsOf(gA), currOnlyRows: [], colPairs: [] };

  const alignment = daff.compareTables(
    new daff.TableView(gA.matrix),
    new daff.TableView(gB.matrix),
    ALIGN_FLAGS
  ).align();

  const rowPairs = [];
  const prevOnlyRows = [];
  const usedB = new Set();
  for (let i = 0; i < gA.rowCount; i++) {
    const b = alignment.a2b(i);
    if (typeof b === 'number' && b >= 0 && b < gB.rowCount) {
      rowPairs.push({ prevRow: makeRowObject(gA, i), currRow: makeRowObject(gB, b) });
      usedB.add(b);
    } else {
      prevOnlyRows.push(makeRowObject(gA, i));
    }
  }
  const currOnlyRows = [];
  for (let j = 0; j < gB.rowCount; j++) {
    if (!usedB.has(j)) currOnlyRows.push(makeRowObject(gB, j));
  }

  const colPairs = [];
  const meta = alignment.meta;
  if (meta && typeof meta.a2b === 'function') {
    for (let j = 0; j < gA.colCount; j++) {
      const k = meta.a2b(j);
      if (typeof k === 'number' && k >= 0 && k < gB.colCount) {
        colPairs.push({ prevCol: j, currCol: k });
      }
    }
  }
  // 首行是横幅/说明行、或列标题为空/重复时，daff 会漏配列；用列内容把漏配的补回来，
  // 否则这些列会被误判成"整列删除/新增"，把真实变更淹没。
  fillUnmappedColumns(colPairs, gA, gB);

  // 有可靠主键（物料编码/序号这类）就按主键配对：精确、不受近似重复行干扰；
  // 没有或不可靠（覆盖不足、键重合率低、未配对行过多）返回 null，回退到 daff 的配对。
  const byKey = alignByKey(gA, gB, colPairs);
  if (byKey) {
    // 主键列本身被改过的行会变成"删一条+加一条"，这里按"差异格数很少"的规则补回来；
    // 真正的删+增差异太大，不会被误并。
    repairUnpairedRows(byKey.rowPairs, byKey.prevOnlyRows, byKey.currOnlyRows, colPairs, gA, gB);
    return {
      rowPairs: byKey.rowPairs,
      prevOnlyRows: byKey.prevOnlyRows,
      currOnlyRows: byKey.currOnlyRows,
      colPairs,
      key: byKey.key,
    };
  }

  // daff 偶尔把"改了几格"的行留成未配对 → 补回配对，交给 differ 出字段级修改
  repairUnpairedRows(rowPairs, prevOnlyRows, currOnlyRows, colPairs, gA, gB);

  return { rowPairs, prevOnlyRows, currOnlyRows, colPairs, key: null };
}

module.exports = { alignRows, __internals: { fillUnmappedColumns, buildGrid } };

