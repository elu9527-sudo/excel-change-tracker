'use strict';

/**
 * 单元格坐标工具：列号 ↔ 列字母、cell_ref 解析。
 * 展示层要告诉用户"这是哪一列"，而库里只存 col_index / cell_ref，
 * 这里统一换算，避免前端各写一套。
 */

/** 0 → A，25 → Z，26 → AA（与 Excel 一致） */
function colLetter(colIndex) {
  const n = Number(colIndex);
  if (!Number.isInteger(n) || n < 0) return '';
  let rest = n;
  let out = '';
  while (rest >= 0) {
    out = String.fromCharCode(65 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
  }
  return out;
}

/** A → 0，AA → 26；非法输入返回 NaN */
function colIndexFromLetter(letters) {
  const s = String(letters || '').toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return NaN;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "G42" → { row: 41, col: 6 }（行号按 0 起算，与解析层 row_index 一致）；非法返回 null */
function parseCellRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref || '').trim());
  if (!m) return null;
  const col = colIndexFromLetter(m[1]);
  const row1 = parseInt(m[2], 10);
  if (Number.isNaN(col) || !Number.isFinite(row1) || row1 < 1) return null;
  return { row: row1 - 1, col };
}

/** 行号（0 起算）→ Excel 里给人看的行号（1 起算） */
function rowNumber(rowIndex) {
  const n = Number(rowIndex);
  return Number.isFinite(n) ? n + 1 : null;
}

module.exports = { colLetter, colIndexFromLetter, parseCellRef, rowNumber };
