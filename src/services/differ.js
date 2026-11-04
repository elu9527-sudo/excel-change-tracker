'use strict';

/**
 * 比对服务：纯函数，不落盘、不读文件（便于单测）。
 *
 * 行/列对齐已复用 daff 表格匹配器（经 ./rowAlign，API 依据见 rowAlign.js 头注释），
 * 此前的自写 LCS、行签名锚点、间隙 DP 与“>2000 行退化为同下标配对”全部移除。
 *
 * 流程：
 * 1. 按 sheet_name 分组；不同工作表互相对齐、不跨表配对；
 * 2. 每张表调 alignRows 得 rowPairs / prevOnlyRows / currOnlyRows / colPairs；
 * 3. rowPairs 逐对做单元格比对（按 colPairs 列映射定位，避免列插删造成列平移误报）：
 *    映射列上两版都有值且标准化不同 = modified；配对行内上一版有、当前无（或列被删）= deleted；
 *    反之（含列新增）= added；
 * 4. prevOnlyRows 整行产出 deleted；currOnlyRows 整行产出 added；
 * 5. 空值（标准化后为空）不参与比对、不产出变更；
 * 6. possible_shift 语义不变：仅当“已配对两行的相似度 < 0.5”
 *    （按列映射对齐后相同单元格数 / 两行非空单元格数的较大值）时，
 *    这两行内产出的变更标 true；未配对整行的 deleted/added 恒为 false；
 * 7. 排序不变：sheet_name → row_index → col_index → change_type；
 * 8. 行级展示字段（row_label / row_cell_count）在每张表比对后统一回填：
 *    优先取“在本列只出现一次”的最长值（业务表里通常是物料名称/客户名称），
 *    避免把“√ / 否 / 固定填充值”这类填充列当成行标签。
 *
 * version_line_id / snapshot_id / prev_snapshot_id 由上传服务在比对后补齐。
 */

const { CHANGE_TYPE, ID_PREFIX, ROW_LABEL_MAX } = require('../contracts');
const { newId } = require('../utils/fsSafe');
const { alignRows } = require('./rowAlign');
const { colLetter } = require('../utils/cellRef');

function normValue(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/** 公式文本（无公式为 ''） */
function normFormula(cell) {
  return cell && cell.formula ? String(cell.formula).trim() : '';
}

/**
 * 把公式里的行号整体平移（用来对齐"行被删掉/插入后 Excel 自动重写了引用"这件事）。
 * 只处理引号外的 A1 引用，引号里的文本（"G000000174" 这类编码）原样保留。
 */
function shiftFormulaRows(formula, shift) {
  if (!shift) return formula;
  let out = '';
  let inQuote = false;
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') { inQuote = !inQuote; out += ch; i += 1; continue; }
    if (inQuote) { out += ch; i += 1; continue; }
    const rest = formula.slice(i);
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/.exec(rest);
    if (m) {
      const row = Number(m[4]);
      const newRow = row + shift;
      // 前面不能紧挨着字母数字（否则是标识符/编码的一部分，不是单元格引用）
      const prevCh = i > 0 ? formula[i - 1] : '';
      const isBoundary = !/[A-Za-z0-9_]/.test(prevCh);
      if (isBoundary && newRow >= 1 && newRow <= 1048576) {
        out += `${m[1]}${m[2]}${m[3]}${newRow}`;
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 两格内容是否不同：值不同 **或** 公式不同都算改动。
 *
 * 公式比较有个坑：行被删除/插入后，Excel 会把整片公式的引用一起改写
 * （实测同一份物料表删掉 6 行，2591 个 VLOOKUP 的引用行号整体上移 5 行）。
 * 这是"同一行内容没变，只是位置变了"，不能算修改。所以这里比对两种口径：
 * 原文相同 → 没变；把上一版公式按行位移归一再比 → 也相同 → 没变；
 * 两种口径都不同，才算真的改了公式。这样即使把"命名区域 HA5"误当单元格引用平移，
 * 也会因为原文相同而不会误报。
 */
function cellsDiffer(pc, cc, deltaRow) {
  if (normValue(pc.cell_value) !== normValue(cc.cell_value)) return true;
  const pf = normFormula(pc);
  const cf = normFormula(cc);
  if (pf === cf) return false;
  if (deltaRow && shiftFormulaRows(pf, -deltaRow) === cf) return false;
  return true;
}

/** 单元格值 → 单行展示文本（换行压成空格） */
function plain(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function groupBySheet(cells) {
  const bySheet = new Map();
  for (const c of cells) {
    if (!bySheet.has(c.sheet_name)) bySheet.set(c.sheet_name, []);
    bySheet.get(c.sheet_name).push(c);
  }
  return bySheet;
}

/* ---------- 变更对象（字段与第 7 章契约一致） ---------- */

function makeChange(type, posCell, prevCell, currCell, shift) {
  // cell_value 可能是 null（只有公式、没有缓存值的格）：这里保持 null，
  // 不要 String(null) 写成字符串 "null"，否则界面上会显示一个假的 "null"。
  const valOf = (cell) => {
    if (!cell) return null;
    const v = cell.cell_value;
    return v === null || v === undefined ? null : String(v);
  };
  return {
    change_id: newId(ID_PREFIX.CHANGE),
    version_line_id: null,
    snapshot_id: null,
    prev_snapshot_id: null,
    sheet_name: posCell.sheet_name,
    cell_ref: posCell.cell_ref,
    change_type: type,
    old_value: valOf(prevCell),
    new_value: valOf(currCell),
    // 公式单独记：值相同但公式变了也能看出来（无公式为 null）
    old_formula: prevCell && prevCell.formula ? prevCell.formula : null,
    new_formula: currCell && currCell.formula ? currCell.formula : null,
    row_index: posCell.row_index,
    col_index: posCell.col_index,
    possible_shift: !!shift,
    // 行级展示字段：先占位，比对完整张表后由 labelChanges 统一回填
    row_label: '',
    row_cell_count: 0,
    detected_at: new Date().toISOString(),
  };
}

/* ---------- 行对相似度与单元格比对 ---------- */

function rowCellCount(row) {
  let n = 0;
  for (const c of row.cells) if (c) n += 1;
  return n;
}

/** 相似度：按列映射对齐后“值相同的单元格数”/ 两行非空单元格数的较大值 */
function rowSimilarity(prevRow, currRow, colMap) {
  let same = 0;
  for (const [prevCol, currCol] of colMap) {
    const pc = prevRow.cells[prevCol];
    const cc = currRow.cells[currCol];
    if (pc && cc && normValue(pc.cell_value) === normValue(cc.cell_value)) same += 1;
  }
  const denom = Math.max(rowCellCount(prevRow), rowCellCount(currRow));
  return denom === 0 ? 0 : same / denom;
}

/** 两行的 Excel 行号差（上一版行号 - 本版行号），用于公式引用位移归一 */
function rowOffset(prevRow, currRow) {
  let a = null;
  let b = null;
  for (const c of prevRow.cells) if (c) { a = c.row_index; break; }
  for (const c of currRow.cells) if (c) { b = c.row_index; break; }
  return a !== null && b !== null ? a - b : 0;
}

/** 已配对两行之间的单元格比对；相似度 < 0.5 时这两行产出的变更全标 possible_shift */
function diffRowPair(prevRow, currRow, colMap, currMapped, out) {
  const shift = rowSimilarity(prevRow, currRow, colMap) < 0.5;
  const delta = rowOffset(prevRow, currRow);
  const currConsumed = new Set();

  for (let j = 0; j < prevRow.cells.length; j++) {
    const pc = prevRow.cells[j];
    const k = colMap.get(j);
    const cc = k === undefined ? null : currRow.cells[k] || null;
    if (k !== undefined && cc) currConsumed.add(k);

    if (!pc) {
      // prev 该列本行无值：仅当映射列在 curr 有值 → added（值新增）
      if (k !== undefined && cc) out.push(makeChange(CHANGE_TYPE.added, cc, null, cc, shift));
      continue;
    }
    if (!cc) {
      // 列被删除（无映射）或本行值被清空 → deleted
      out.push(makeChange(CHANGE_TYPE.deleted, pc, pc, null, shift));
      continue;
    }
    if (cellsDiffer(pc, cc, delta)) {
      out.push(makeChange(CHANGE_TYPE.modified, cc, pc, cc, shift));
    }
  }

  // curr 中不属于任何列映射的列（列插入）且有值 → added
  for (let k = 0; k < currRow.cells.length; k++) {
    if (currMapped.has(k) || currConsumed.has(k)) continue;
    const cc = currRow.cells[k];
    if (cc) out.push(makeChange(CHANGE_TYPE.added, cc, null, cc, shift));
  }
}

/**
 * 快速路径：列映射为恒等（两侧列宽一致、逐列对齐，最常见形态，含全部大表场景）。
 * 单趟扫描顺带记录待产出列（无变更的大多数行零额外分配），末尾按相似度打标。
 */
function diffRowPairIdentity(prevRow, currRow, out) {
  const a = prevRow.cells;
  const b = currRow.cells;
  const n = a.length;
  const delta = rowOffset(prevRow, currRow);
  let same = 0;
  let nA = 0;
  let nB = 0;
  let pending = null;
  for (let j = 0; j < n; j++) {
    const pc = a[j];
    const cc = b[j];
    if (pc) {
      nA += 1;
      if (cc) {
        nB += 1;
        if (cellsDiffer(pc, cc, delta)) (pending || (pending = [])).push(j);
        else same += 1;
      } else {
        (pending || (pending = [])).push(j);
      }
    } else if (cc) {
      nB += 1;
      (pending || (pending = [])).push(j);
    }
  }
  if (!pending) return;
  const denom = nA > nB ? nA : nB;
  const shift = denom !== 0 && same / denom < 0.5;
  for (const j of pending) {
    const pc = a[j];
    const cc = b[j];
    if (pc && cc) out.push(makeChange(CHANGE_TYPE.modified, cc, pc, cc, shift));
    else if (pc) out.push(makeChange(CHANGE_TYPE.deleted, pc, pc, null, shift));
    else out.push(makeChange(CHANGE_TYPE.added, cc, null, cc, shift));
  }
}

/** 未配对整行：prev 侧全部 deleted，curr 侧全部 added（possible_shift 恒为 false） */
function pushWholeRow(type, row, out) {
  for (const cell of row.cells) {
    if (!cell) continue;
    out.push(type === CHANGE_TYPE.deleted ? makeChange(type, cell, cell, null, false) : makeChange(type, cell, null, cell, false));
  }
}

/* ---------- 行级展示字段回填 ---------- */

/** 行对象 → Excel 行号（0 起算）；空行返回 null */
function rowIndexOf(cells) {
  for (const c of cells) if (c) return c.row_index;
  return null;
}

/**
 * 统计指定 (列|值) 在整张表里出现几次（只统计 targets 内的值，避免全量建索引）。
 * 用于判断某个值是不是"填充列常值"。
 */
function countOccurrences(targets, cells) {
  const counts = new Map();
  if (!targets.size) return counts;
  for (const c of cells) {
    if (c.row_index === 0) continue;
    const key = `${c.col_index}|${c.cell_value}`;
    if (!targets.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * 从一行的单元格里挑出最能指认这一行的值：
 * 先只在“本列唯一”的值里挑最长的（名称类），挑不到再退回全行最长值。
 * 若挑到的是短代码（如物料编码 03587），再把该行最长的一段非代码文本补在后面，
 * 显示成「03587 · 示例物料A」，比单个编码好认。
 */
function pickLabel(cells, counts) {
  let uniqueBest = '';
  let rareBest = '';
  let rareCount = Infinity;
  let anyBest = '';
  let first = '';
  for (const c of cells) {
    if (!c) continue;
    const v = plain(c.cell_value);
    if (!v) continue;
    if (!first) first = v;
    if (v.length > anyBest.length) anyBest = v;
    const times = counts.get(`${c.col_index}|${c.cell_value}`);
    if (times === 1 && v.length > uniqueBest.length) uniqueBest = v;
    // 没有唯一值时，退而取"本列出现最少"的值（重复行也能指认到名称/编码）
    if (times !== undefined && (times < rareCount || (times === rareCount && v.length > rareBest.length))) {
      rareBest = v;
      rareCount = times;
    }
  }
  let label = uniqueBest || rareBest || anyBest || first;
  if (!label) return '';

  // 短代码补名称：代码本身不足以让人认出这是哪条记录。
  // 补的名称要挑"本列出现次数最少"的文本，否则会补上 固定填充值 这类填充值。
  const codeLike = /^[0-9A-Za-z][0-9A-Za-z\-#._/]*$/.test(label) && label.length <= 16;
  if (codeLike) {
    let name = '';
    let nameCount = Infinity;
    for (const c of cells) {
      if (!c) continue;
      const v = plain(c.cell_value);
      if (!v || v === label) continue;
      if (/^[0-9A-Za-z][0-9A-Za-z\-#._/]*$/.test(v)) continue; // 跳过其它代码/短值
      const times = counts.get(`${c.col_index}|${c.cell_value}`);
      if (times === undefined || times > 100) continue; // 填充列常值不配当名称
      if (times < nameCount || (times === nameCount && v.length > name.length)) {
        name = v;
        nameCount = times;
      }
    }
    if (name) label = `${label} · ${name}`;
  }

  return label.length > ROW_LABEL_MAX ? label.slice(0, ROW_LABEL_MAX - 1) + '…' : label;
}

/**
 * 回填一张表的行级展示字段。
 * - 变更落在哪一侧：deleted 取上一版行，其余取当前版行；
 * - 只对"出现过的行"收集候选值，再单趟统计这些值在本表的出现次数；
 * - 每张表的这一趟扫描约几十毫秒（59 万单元格实测 60ms），不改变比对结论。
 */
function labelChanges(changes, prevCells, currCells, rowsBySide) {
  if (!changes.length) return;

  const wantedRows = new Map(); // side -> Set(rowIndex)
  for (const ch of changes) {
    const side = ch.change_type === CHANGE_TYPE.deleted ? 'prev' : 'curr';
    if (!wantedRows.has(side)) wantedRows.set(side, new Set());
    wantedRows.get(side).add(ch.row_index);
  }

  const targetsBySide = new Map();
  const countsBySide = new Map();
  for (const [side, rows] of wantedRows) {
    const cellsByRow = rowsBySide[side] || new Map();
    const targets = new Set();
    for (const rowIndex of rows) {
      const cells = cellsByRow.get(rowIndex) || [];
      for (const c of cells) {
        if (!c) continue;
        if (plain(c.cell_value)) targets.add(`${c.col_index}|${c.cell_value}`);
      }
    }
    targetsBySide.set(side, targets);
    countsBySide.set(side, countOccurrences(targets, side === 'prev' ? prevCells : currCells));
  }

  for (const ch of changes) {
    const side = ch.change_type === CHANGE_TYPE.deleted ? 'prev' : 'curr';
    const cells = (rowsBySide[side] || new Map()).get(ch.row_index) || [];
    let n = 0;
    for (const c of cells) if (c) n += 1;
    ch.row_cell_count = n;
    ch.row_label = pickLabel(cells, countsBySide.get(side) || new Map());
  }
}

/** 行对象数组 → Map(Excel 行号 → cells) */
function indexRows(rows, into) {
  for (const row of rows) {
    const ri = rowIndexOf(row.cells);
    if (ri !== null) into.set(ri, row.cells);
  }
  return into;
}

/* ---------- 单表比对 ---------- */

function diffSheet(prevCells, currCells, out, keys) {
  const alignment = alignRows(prevCells, currCells);
  const { rowPairs, prevOnlyRows, currOnlyRows, colPairs } = alignment;
  const sheetChanges = [];
  if (keys && alignment.key) {
    const sheetName = (prevCells[0] || currCells[0]).sheet_name;
    keys[sheetName] = alignment.key.prevCols.map(colLetter).join('+');
  }

  if (rowPairs.length) {
    // 恒等列映射快速路径：colPairs 逐列 prevCol===currCol 且两侧列宽一致
    const prevWidth = rowPairs[0].prevRow.cells.length;
    const currWidth = rowPairs[0].currRow.cells.length;
    let identity = colPairs.length === prevWidth && prevWidth === currWidth;
    if (identity) {
      for (const p of colPairs) {
        if (p.prevCol !== p.currCol) {
          identity = false;
          break;
        }
      }
    }
    if (identity) {
      for (const pair of rowPairs) diffRowPairIdentity(pair.prevRow, pair.currRow, sheetChanges);
    } else {
      const colMap = new Map();
      const currMapped = new Set();
      for (const p of colPairs) {
        colMap.set(p.prevCol, p.currCol);
        currMapped.add(p.currCol);
      }
      for (const pair of rowPairs) diffRowPair(pair.prevRow, pair.currRow, colMap, currMapped, sheetChanges);
    }
  }

  for (const row of prevOnlyRows) pushWholeRow(CHANGE_TYPE.deleted, row, sheetChanges);
  for (const row of currOnlyRows) pushWholeRow(CHANGE_TYPE.added, row, sheetChanges);

  if (sheetChanges.length) {
    const prevRows = indexRows(rowPairs.map((p) => p.prevRow), indexRows(prevOnlyRows, new Map()));
    const currRows = indexRows(rowPairs.map((p) => p.currRow), indexRows(currOnlyRows, new Map()));
    labelChanges(sheetChanges, prevCells, currCells, { prev: prevRows, curr: currRows });
  }

  out.push(...sheetChanges);
}

function diffCells(prevCells, currCells) {
  return diffCellsDetailed(prevCells, currCells).changes;
}

/**
 * 同 diffCells，额外返回"本次每张表是按哪些列做行对齐的"（keys）。
 * 有主键的表按主键对齐，没有的走 daff 内容对齐；把它记进日志和快照元数据，
 * 出问题时能立刻看出"这张表当时是按什么认行的"。
 */
function diffCellsDetailed(prevCells, currCells) {
  const prevBySheet = groupBySheet(prevCells || []);
  const currBySheet = groupBySheet(currCells || []);
  const changes = [];
  const keys = {};

  const sheetNames = [...new Set([...prevBySheet.keys(), ...currBySheet.keys()])];
  for (const sheetName of sheetNames) {
    diffSheet(prevBySheet.get(sheetName) || [], currBySheet.get(sheetName) || [], changes, keys);
  }

  changes.sort(
    (a, b) =>
      String(a.sheet_name).localeCompare(String(b.sheet_name)) ||
      a.row_index - b.row_index ||
      a.col_index - b.col_index ||
      String(a.change_type).localeCompare(String(b.change_type))
  );
  return { changes, keys };
}

module.exports = { diffCells, diffCellsDetailed };
