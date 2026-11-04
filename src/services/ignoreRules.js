'use strict';

/**
 * 忽略规则：把"这些噪音我知道，不用看"的格子排除在变更列表之外。
 *
 * 规则语法（照 na-ka-na/ExcelCompare 的 --ignore1/--ignore2 的路子，但换成一行一条）：
 *
 *     <工作表>:<行>:<列>:<单元格>
 *
 * - 工作表：精确名，或 `*` 表示所有表；
 * - 行：Excel 行号，支持 `7`、`7-9`、`7,9-12`；
 * - 列：列字母，支持 `A`、`A-D`、`A,C,E`；
 * - 单元格：`B2`、`B2:D4`；
 * - 任一段可留空，留空即"这段不限制"。例如：
 *     `Sheet1::A`      该表整列 A 不看
 *     `Sheet1:1-5::`            前 5 行（表头/说明区）不看
 *     `*:::A1`                  所有表的 A1 不看
 *     `Sheet1::X,Y`         该表 X、Y 两列不看
 *
 * 一段以上的规则是"且"的关系（都要满足才算命中）。
 * 规则存 data/ignore_rules.json，按工作簿文件名分组——不同表需要的规则不一样。
 */

const path = require('path');
const contracts = require('../contracts');
const { ensureDir, readJson, writeJsonAtomic } = require('../utils/fsSafe');
const { colLetter, colIndexFromLetter, parseCellRef } = require('../utils/cellRef');

const MAX_RULES = 50;
const RULES_FILE = path.join(contracts.DATA_DIR, 'ignore_rules.json');
const WILDCARD_SHEET = '*';

/* ---------- 规则解析 ---------- */

/** "A,C,E" / "A-D" → 列号集合 */
function parseCols(text) {
  const out = new Set();
  if (!text) return out;
  for (const part of text.split(',')) {
    const s = part.trim().toUpperCase();
    if (!s) continue;
    const m = /^([A-Z]{1,3})-([A-Z]{1,3})$/.exec(s);
    if (m) {
      const from = colIndex(m[1]);
      const to = colIndex(m[2]);
      if (from < 0 || to < 0) return null;
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) out.add(i);
      continue;
    }
    if (!/^[A-Z]{1,3}$/.test(s)) return null;
    const idx = colIndex(s);
    if (idx < 0) return null;
    out.add(idx);
  }
  return out;
}

const MAX_COL_INDEX = 16383; // XFD：Excel 最大列

/** 列字母 → 0 基列号（A=0, Z=25, AA=26）；非法或超出 Excel 最大列返回 -1 */
function colIndex(letters) {
  const n = colIndexFromLetter(letters);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COL_INDEX) return -1;
  return n;
}

/** "1-5" / "7,9-12" → 行号区间数组（1 基） */
function parseRows(text) {
  const out = [];
  if (!text) return out;
  for (const part of text.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(\d+)-(\d+)$/.exec(s);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (!a || !b || a > 1048576 || b > 1048576) return null;
      out.push({ from: Math.min(a, b), to: Math.max(a, b) });
      continue;
    }
    if (!/^\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!n || n > 1048576) return null;
    out.push({ from: n, to: n });
  }
  return out;
}

/** "B2" / "B2:D4" → cell_ref 集合 */
function parseCells(text) {
  const out = new Set();
  if (!text) return out;
  for (const part of text.split(',')) {
    const s = part.trim().toUpperCase();
    if (!s) continue;
    const m = /^([A-Z]{1,3}\d+):([A-Z]{1,3}\d+)$/.exec(s);
    if (m) {
      const a = parseCellRef(m[1]);
      const b = parseCellRef(m[2]);
      if (!a || !b || a.col > MAX_COL_INDEX || b.col > MAX_COL_INDEX) return null;
      const c1 = Math.min(a.col, b.col);
      const c2 = Math.max(a.col, b.col);
      const r1 = Math.min(a.row, b.row);
      const r2 = Math.max(a.row, b.row);
      // 单元格区间最多展开 5000 格，避免一行 `A1:XFD1048576` 把内存打爆
      if ((c2 - c1 + 1) * (r2 - r1 + 1) > 5000) return null;
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) out.add(`${colLetter(c)}${r + 1}`);
      }
      continue;
    }
    const p = parseCellRef(s);
    if (!p || p.col > MAX_COL_INDEX) return null;
    out.add(s);
  }
  return out;
}

/**
 * 解析一条规则。返回 { spec, sheet, rows, cols, cells } 或 { error }。
 * 四段全空（如 `:::`）视为无效，避免"一条规则把全部变更吃掉"。
 */
function parseRule(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return { error: '规则为空' };
  const parts = raw.split(':');
  // 第 4 段（单元格）允许自带冒号，如 `S:::B2:C3`；其余段按第一个冒号切分
  const cellsPart = parts.length > 3 ? parts.slice(3).join(':') : '';
  const sheet = (parts[0] || '').trim();
  const rowsText = (parts[1] || '').trim();
  const colsText = (parts[2] || '').trim();
  const cellsText = cellsPart.trim();

  if (!sheet && !rowsText && !colsText && !cellsText) return { error: '四段都为空，会匹配所有变更' };

  const rows = parseRows(rowsText);
  if (rows === null) return { error: `行段写法不对：${rowsText}（支持 7 / 7-9 / 7,9-12）` };
  const cols = parseCols(colsText);
  if (cols === null) return { error: `列段写法不对：${colsText}（支持 A / A-D / A,C）` };
  const cells = parseCells(cellsText);
  if (cells === null) return { error: `单元格段写法不对：${cellsText}（支持 B2 / B2:D4，区间不超过 5000 格）` };

  return { spec: raw, sheet: sheet || WILDCARD_SHEET, rows, cols, cells };
}

/** 一条已解析规则是否命中某条变更 */
function matches(rule, change) {
  if (rule.sheet !== WILDCARD_SHEET && rule.sheet !== change.sheet_name) return false;
  if (rule.rows.length) {
    const rowNumber = change.row_index + 1;
    if (!rule.rows.some((r) => rowNumber >= r.from && rowNumber <= r.to)) return false;
  }
  if (rule.cols.size && !rule.cols.has(change.col_index)) return false;
  if (rule.cells.size && !rule.cells.has(String(change.cell_ref).toUpperCase())) return false;
  return true;
}

/** 解析一组规则文本 → { parsed, errors } */
function compile(specs) {
  const parsed = [];
  const errors = [];
  for (const spec of specs || []) {
    const one = parseRule(spec);
    if (one.error) errors.push(`${String(spec || '').trim() || '(空)'}：${one.error}`);
    else parsed.push(one);
  }
  return { parsed, errors };
}

/**
 * 过滤一批变更。返回 { kept, ignored, byRule }：
 * - ignored：被忽略的条数；
 * - byRule：每条规则命中多少条（按原文本，方便用户判断哪条规则在起作用 / 该不该留）。
 */
function applyToChanges(specs, changes) {
  const { parsed, errors } = compile(specs);
  if (!parsed.length) return { kept: changes, ignored: 0, byRule: {}, errors };
  const byRule = {};
  const kept = [];
  for (const ch of changes) {
    let hit = null;
    for (const rule of parsed) {
      if (matches(rule, ch)) { hit = rule.spec; break; }
    }
    if (hit) byRule[hit] = (byRule[hit] || 0) + 1;
    else kept.push(ch);
  }
  return { kept, ignored: changes.length - kept.length, byRule, errors };
}

/* ---------- 持久化：data/ignore_rules.json ---------- */

function readAll() {
  const doc = readJson(RULES_FILE, null);
  if (!doc || typeof doc !== 'object') return { files: {} };
  const files = doc.files && typeof doc.files === 'object' ? doc.files : {};
  return { files };
}

/** 取某个工作簿的规则（含 `*` 通配文件级规则） */
function getForFile(fileName) {
  const all = readAll();
  return (all.files[String(fileName || '')] || []).slice();
}

/** 保存某个工作簿的规则（去重、去掉空行、上限 50 条） */
function saveForFile(fileName, specs) {
  const name = String(fileName || '').trim();
  if (!name) return { ok: false, errors: ['缺少文件名'] };
  const list = [];
  for (const spec of specs || []) {
    const s = String(spec == null ? '' : spec).trim();
    if (!s) continue;
    if (!list.includes(s)) list.push(s);
  }
  const { errors } = compile(list);
  if (errors.length) return { ok: false, errors };
  if (list.length > MAX_RULES) return { ok: false, errors: [`最多 ${MAX_RULES} 条规则`] };

  const all = readAll();
  if (list.length) all.files[name] = list;
  else delete all.files[name];
  ensureDir(contracts.DATA_DIR);
  writeJsonAtomic(RULES_FILE, all);
  return { ok: true, rules: list, errors: [] };
}

module.exports = {
  parseRule,
  compile,
  matches,
  applyToChanges,
  getForFile,
  saveForFile,
  RULES_FILE,
  MAX_RULES,
};
