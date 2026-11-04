'use strict';

/**
 * 忽略规则单测：语法解析、命中判断、批量过滤、按文件持久化。
 * 持久化用临时目录（ECT_ROOT），不碰真实 data/。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ect-ignore-'));
process.env.ECT_ROOT = TMP;

const ignoreRules = require('../src/services/ignoreRules');

/** 一条变更（只带规则用得上的字段） */
function ch(sheet, rowIndex, colIndex, cellRef) {
  return { sheet_name: sheet, row_index: rowIndex, col_index: colIndex, cell_ref: cellRef };
}

/* ---------- 语法 ---------- */

test('解析：工作表 + 行 + 列 + 单元格四段', () => {
  const r = ignoreRules.parseRule('汇总:7-9:A,C:B2');
  assert.ok(!r.error, r.error);
  assert.equal(r.sheet, '汇总');
  assert.deepEqual(r.rows, [{ from: 7, to: 9 }]);
  assert.deepEqual([...r.cols].sort((a, b) => a - b), [0, 2]);
  assert.deepEqual([...r.cells], ['B2']);
});

test('解析：留空的段表示不限制，空工作表 = 通配所有表', () => {
  const r = ignoreRules.parseRule('::A-D:');
  assert.ok(!r.error, r.error);
  assert.equal(r.sheet, '*', '空工作表段按通配处理');
  assert.deepEqual([...r.cols].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.cells.size, 0);
});

test('解析：单元格区间展开', () => {
  const r = ignoreRules.parseRule('Sheet1:::B2:C3');
  assert.ok(!r.error, r.error);
  assert.deepEqual([...r.cells].sort(), ['B2', 'B3', 'C2', 'C3']);
});

test('解析：四段全空要拒绝（否则一条规则吃掉所有变更）', () => {
  for (const spec of [':::', '', '   ']) {
    const r = ignoreRules.parseRule(spec);
    assert.ok(r.error, `「${spec}」应当被拒绝`);
  }
});

test('解析：写法错误给出可读提示', () => {
  assert.ok(ignoreRules.parseRule('S:x:').error, '行段非数字要报错');
  assert.ok(ignoreRules.parseRule('S::1').error, '列段非字母要报错');
  assert.ok(ignoreRules.parseRule('S:::ZZZ9').error, '非法单元格要报错');
  assert.ok(ignoreRules.parseRule('S:::A1:XFD1048576').error, '区间过大要拒绝，避免把内存打爆');
  assert.ok(ignoreRules.parseRule('a:b:c:d:e').error, '超过四段要报错');
});

/* ---------- 命中 ---------- */

test('命中：工作表名不同就不命中；通配 * 命中所有表', () => {
  const rule = ignoreRules.parseRule('汇总::A');
  assert.equal(ignoreRules.matches(rule, ch('汇总', 0, 0, 'A1')), true);
  assert.equal(ignoreRules.matches(rule, ch('别的表', 0, 0, 'A1')), false);

  const wild = ignoreRules.parseRule('*::A');
  assert.equal(ignoreRules.matches(wild, ch('任何表', 5, 0, 'A6')), true);
});

test('命中：行号按 Excel 显示行号（row_index + 1）', () => {
  const rule = ignoreRules.parseRule('S:5-6::');
  assert.equal(ignoreRules.matches(rule, ch('S', 4, 0, 'A5')), true, '第 5 行命中');
  assert.equal(ignoreRules.matches(rule, ch('S', 5, 0, 'A6')), true, '第 6 行命中');
  assert.equal(ignoreRules.matches(rule, ch('S', 6, 0, 'A7')), false, '第 7 行不命中');
});

test('命中：多段是"且"关系', () => {
  const rule = ignoreRules.parseRule('S:1-10:C');
  assert.equal(ignoreRules.matches(rule, ch('S', 2, 2, 'C3')), true);
  assert.equal(ignoreRules.matches(rule, ch('S', 2, 1, 'B3')), false, '列不对');
  assert.equal(ignoreRules.matches(rule, ch('S', 20, 2, 'C21')), false, '行不对');
});

/* ---------- 批量过滤 ---------- */

test('过滤：只隐藏命中的条目，并统计每条规则命中多少', () => {
  const all = [
    ch('汇总', 0, 0, 'A1'),
    ch('汇总', 0, 1, 'B1'),
    ch('汇总', 5, 0, 'A6'),
    ch('Sheet2', 0, 23, 'X1'),
  ];
  const res = ignoreRules.applyToChanges(['汇总::A', 'Sheet2::X'], all);
  assert.equal(res.ignored, 3, 'A1、A6、X1 都在被忽略的列上');
  assert.equal(res.kept.length, 1);
  assert.deepEqual(res.byRule, { '汇总::A': 2, 'Sheet2::X': 1 });
  assert.deepEqual(res.kept.map((c) => c.cell_ref), ['B1']);
});

test('过滤：没有规则时原样返回，不算忽略', () => {
  const all = [ch('S', 0, 0, 'A1')];
  const res = ignoreRules.applyToChanges([], all);
  assert.equal(res.ignored, 0);
  assert.equal(res.kept, all);
});

test('过滤：规则非法时跳过该条并报告，不影响其它规则', () => {
  const all = [ch('S', 0, 0, 'A1'), ch('S', 0, 1, 'B1')];
  const res = ignoreRules.applyToChanges([':::', 'S::A'], all);
  assert.equal(res.errors.length, 1);
  assert.equal(res.ignored, 1, '合法的那条照常生效');
  assert.equal(res.kept.length, 1);
});

/* ---------- 持久化 ---------- */

test('保存 / 读取：按文件名分组，去重，清空即删除', () => {
  const saved = ignoreRules.saveForFile('物料.xlsx', ['S::A', 'S::A', ' S::B ', '']);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.rules, ['S::A', 'S::B'], '去重并去掉空行');

  assert.deepEqual(ignoreRules.getForFile('物料.xlsx'), ['S::A', 'S::B']);
  assert.deepEqual(ignoreRules.getForFile('别的.xlsx'), []);

  const cleared = ignoreRules.saveForFile('物料.xlsx', []);
  assert.equal(cleared.ok, true);
  assert.deepEqual(ignoreRules.getForFile('物料.xlsx'), []);
});

test('保存：非法规则整体拒绝，不写坏文件', () => {
  ignoreRules.saveForFile('X.xlsx', ['S::A']);
  const bad = ignoreRules.saveForFile('X.xlsx', ['S::A', ':::::']);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length);
  assert.deepEqual(ignoreRules.getForFile('X.xlsx'), ['S::A'], '原规则保持不变');
});
