'use strict';

/**
 * 解析服务：Buffer → {sheetNames, cells}。
 * 合并单元格只记左上角单元格，merged_range 形如 "B2:C3"，被覆盖单元格不重复入列；
 * 空单元格不写入 cells；解析异常抛出 PARSE_FAILED（取自 contracts）。
 */

const XLSX = require('xlsx');
const { ERROR_CODES } = require('../contracts');

function contractError(meta, detail) {
  const err = new Error(meta.message);
  err.code = meta.code;
  err.http = meta.http;
  if (detail) err.detail = String(detail);
  return err;
}

/**
 * 单元格值标准化：返回 {value(展示字符串), type}，type=null 表示跳过（空单元格）。
 */
function normalizeValue(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return null;
  const t = cell.t;
  if (t === 'b') return { value: cell.v ? 'true' : 'false', type: 'boolean' };
  if (t === 'n') {
    if (cell.v instanceof Date) return { value: cell.v.toISOString(), type: 'date' };
    return { value: String(cell.v), type: 'number' };
  }
  if (t === 'd') {
    const d = cell.v instanceof Date ? cell.v : new Date(cell.v);
    if (Number.isNaN(d.getTime())) return null;
    return { value: d.toISOString(), type: 'date' };
  }
  if (t === 'e' || t === 'z') return null;
  const s = String(cell.v);
  if (s.trim() === '') return null;
  return { value: s, type: 'string' };
}

/**
 * 单元格标准化：值 + 公式。
 *
 * 公式单独记一份 `formula`（形如 "=SUM(A1:A3)"），因为：
 * 1. 值相等不等于没改——公式从 =A1+B1 改成 =B1+A1、或者引用被换掉，缓存值可能一样；
 * 2. 公式单元格可能**没有缓存值**（脚本/第三方库生成的 xlsx 很常见），
 *    以前这类格被整类丢掉，两版比对时表现为"这一列看不出变化"或"假新增/假删除"。
 *    这种情况 value=null、type='formula'，但格子本身照样参与比对。
 */
function normalizeCell(cell) {
  if (!cell) return null;
  const f = typeof cell.f === 'string' ? cell.f.trim() : '';
  const formula = f ? (f.startsWith('=') ? f : '=' + f) : null;
  const norm = normalizeValue(cell);
  if (!norm) {
    if (formula) return { value: null, type: 'formula', formula };
    return null;
  }
  if (formula) norm.formula = formula;
  return norm;
}

function looksLikeXlsx(buffer) {
  // .xlsx 是 ZIP 容器，文件头必须是 PK\x03\x04；SheetJS 对坏字节会宽容地猜成文本，
  // 因此在解析前先验签名，保证损坏/伪装文件按契约抛 PARSE_FAILED。
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b &&
    buffer[2] === 0x03 && buffer[3] === 0x04
  );
}

function parseWorkbook(buffer) {
  let wb;
  if (!looksLikeXlsx(buffer)) {
    throw contractError(ERROR_CODES.PARSE_FAILED, '文件不是合法的 xlsx（ZIP）容器');
  }
  try {
    // sheetStubs 必须开：不开的话，只有公式、没有缓存值的格（openpyxl/POI 那类
    // 第三方库生成的 xlsx 常见）会被 SheetJS 整个吞掉，我们连"这格存在"都看不到。
    // 开了之后这类格会以 { t:'z', f:'...' } 出现，值仍是空的，不会混进真实数值。
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, bookType: 'xlsx', sheetStubs: true });
  } catch (e) {
    throw contractError(ERROR_CODES.PARSE_FAILED, e && e.message);
  }
  if (!wb.SheetNames.length) {
    throw contractError(ERROR_CODES.PARSE_FAILED, '工作簿中没有任何工作表');
  }

  const sheetNames = wb.SheetNames.slice();
  const cells = [];

  for (const name of sheetNames) {
    const ws = wb.Sheets[name] || {};
    const merges = ws['!merges'] || [];

    const covered = new Set();
    const anchorRange = new Map();
    for (const m of merges) {
      anchorRange.set(XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c }), XLSX.utils.encode_range(m));
      for (let r = m.s.r; r <= m.e.r; r += 1) {
        for (let c = m.s.c; c <= m.e.c; c += 1) {
          if (r === m.s.r && c === m.s.c) continue;
          covered.add(XLSX.utils.encode_cell({ r, c }));
        }
      }
    }

    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      if (covered.has(addr)) continue;
      const norm = normalizeCell(ws[addr]);
      if (!norm) continue;
      const pos = XLSX.utils.decode_cell(addr);
      cells.push({
        sheet_name: name,
        cell_ref: addr,
        row_index: pos.r,
        col_index: pos.c,
        cell_value: norm.value,
        value_type: norm.type,
        // 公式文本（无公式为 null）；无缓存值的公式格 value=null、type='formula'
        formula: norm.formula || null,
        merged_range: anchorRange.get(addr) || null,
      });
    }
  }

  return { sheetNames, cells };
}

module.exports = { parseWorkbook };
