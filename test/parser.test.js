'use strict';

const test = require('node:test');
const assert = require('node:assert');

const XLSX = require('xlsx');
const { parseWorkbook } = require('../src/services/parser');

function sheetToBuffer(ws, sheetName) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

/* ---------- 手工拼 xlsx：SheetJS 的写入器会丢掉"无缓存值"的公式格，
   只有手工造包才能复现 openpyxl / POI 那类第三方库生成的形态 ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 最小 ZIP（store，不压缩）：够 SheetJS 读就行 */
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);          // store
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

function xlsxWithFormulaOnly() {
  return zipStore({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c><c r="B1"><v>100</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>有缓存</t></is></c><c r="B2"><f>B1*2</f><v>200</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>无缓存</t></is></c><c r="B3"><f>B1*3</f></c></row>' +
      '</sheetData></worksheet>',
  });
}

test('公式：文本单独记录，无缓存值的公式格不再被丢弃', () => {
  const { cells } = parseWorkbook(xlsxWithFormulaOnly());
  const byRef = new Map(cells.map((c) => [c.cell_ref, c]));

  assert.equal(byRef.get('B1').formula, null, '普通数值格没有公式');
  assert.equal(byRef.get('A1').formula, null, '普通文本格没有公式');

  assert.equal(byRef.get('B2').formula, '=B1*2', '公式文本带等号');
  assert.equal(byRef.get('B2').cell_value, '200', '有缓存值时照旧记值');
  assert.equal(byRef.get('B2').value_type, 'number');

  assert.ok(byRef.has('B3'), '无缓存值的公式格必须保留，否则整类格被静默丢掉');
  assert.equal(byRef.get('B3').formula, '=B1*3');
  assert.equal(byRef.get('B3').cell_value, null);
  assert.equal(byRef.get('B3').value_type, 'formula');
});

test('基本类型解析与空单元格忽略', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['标题', 100, true, ''],
    ['文本', 3.14, false, null],
  ]);
  const { sheetNames, cells } = parseWorkbook(sheetToBuffer(ws, 'Sheet1'));

  assert.deepEqual(sheetNames, ['Sheet1']);
  const byRef = new Map(cells.map((c) => [c.cell_ref, c]));

  assert.equal(byRef.get('A1').cell_value, '标题');
  assert.equal(byRef.get('A1').value_type, 'string');
  assert.equal(byRef.get('B1').cell_value, '100');
  assert.equal(byRef.get('B1').value_type, 'number');
  assert.equal(byRef.get('C1').cell_value, 'true');
  assert.equal(byRef.get('C1').value_type, 'boolean');
  assert.equal(byRef.get('C2').cell_value, 'false');

  assert.ok(!byRef.has('D1'), '空字符串单元格不写入');
  assert.ok(!byRef.has('D2'), '空值单元格不写入');

  const a1 = byRef.get('A1');
  assert.equal(a1.sheet_name, 'Sheet1');
  assert.equal(a1.row_index, 0);
  assert.equal(a1.col_index, 0);
  assert.equal(a1.merged_range, null);
});

test('合并单元格：只记左上角取值与 merged_range，被覆盖单元格不重复入列', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['表头A', '表头B', '表头C'],
    ['a1', 'b1', 'c1'],
    ['a2', 'b2', 'c2'],
    ['a3', 'b3', 'c3'],
    ['a4', 'b4', 'c4'],
    ['a5', 'b5', 'c5'],
  ]);
  // 合并 B2:C3（0 基：r1c1 ~ r2c2）
  ws['!merges'] = [{ s: { r: 1, c: 1 }, e: { r: 2, c: 2 } }];
  ws['B2'] = { t: 's', v: '合并主值' };
  const { cells } = parseWorkbook(sheetToBuffer(ws, 'Sheet1'));
  const byRef = new Map(cells.map((c) => [c.cell_ref, c]));

  assert.equal(byRef.get('B2').cell_value, '合并主值', '取左上角单元格的值');
  assert.equal(byRef.get('B2').merged_range, 'B2:C3', 'merged_range 记录合并区域');
  assert.ok(!byRef.has('C2'), '被合并覆盖的 C2 不重复入列');
  assert.ok(!byRef.has('B3'), '被合并覆盖的 B3 不重复入列');
  assert.ok(!byRef.has('C3'), '被合并覆盖的 C3 不重复入列');
  // 区域外单元格不受影响
  assert.equal(byRef.get('A2').cell_value, 'a1');
  assert.equal(byRef.get('D2'), undefined);
});

test('日期单元格转 ISO 字符串展示', () => {
  const ws = XLSX.utils.aoa_to_sheet([['日期'], [new Date(Date.UTC(2026, 10, 3, 8, 30, 0))]]);
  const { cells } = parseWorkbook(sheetToBuffer(ws, 'Sheet1'));
  const byRef = new Map(cells.map((c) => [c.cell_ref, c]));

  assert.equal(byRef.get('A2').value_type, 'date');
  assert.match(byRef.get('A2').cell_value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO 字符串展示');
});

test('非 xlsx 内容抛出 PARSE_FAILED', () => {
  assert.throws(
    () => parseWorkbook(Buffer.from('这不是一个合法的 xlsx 文件内容')),
    (e) => e.code === 'PARSE_FAILED'
  );
});
