'use strict';

/**
 * 主键识别与按主键对齐的单测。
 * 直接测 alignByKey/detectKeyColumns：它们决定"这一行和哪一行是同一条记录"，
 * 一旦阈值被改坏，下游的修改/删除/新增都会跟着错，所以必须有独立用例。
 */

const test = require('node:test');
const assert = require('node:assert');

const { alignByKey, detectKeyColumns } = require('../src/services/keyAlign');
const { alignRows, __internals } = require('../src/services/rowAlign');

const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 二维数组 → cells（第 0 行按表头处理；空字符串表示该格不写） */
function cellsOf(rows, sheet) {
  const out = [];
  rows.forEach((vals, r) => {
    vals.forEach((v, c) => {
      if (v === '' || v === null || v === undefined) return;
      out.push({
        sheet_name: sheet || 'S1',
        cell_ref: `${COLS[c]}${r + 1}`,
        row_index: r,
        col_index: c,
        cell_value: String(v),
        value_type: 'string',
        merged_range: null,
      });
    });
  });
  return out;
}

function identityPairs(colCount) {
  const pairs = [];
  for (let j = 0; j < colCount; j++) pairs.push({ prevCol: j, currCol: j });
  return pairs;
}

function align(prevRows, currRows, colCount) {
  const gA = __internals.buildGrid(cellsOf(prevRows));
  const gB = __internals.buildGrid(cellsOf(currRows));
  return alignByKey(gA, gB, identityPairs(colCount));
}

/** 走完整流水线（主键对齐 + 残留行修复），用于断言"最终有没有多出来的增/删" */
function alignFull(prevRows, currRows) {
  return alignRows(cellsOf(prevRows), cellsOf(currRows));
}

test('单列唯一（物料编码）→ 识别为主键，逐行精确配对', () => {
  const prev = [
    ['编码', '名称', '数量'],
    ['A001', '甲', 1],
    ['A002', '乙', 2],
    ['A003', '丙', 3],
  ];
  const curr = [
    ['编码', '名称', '数量'],
    ['A001', '甲', 1],
    ['A002', '乙-改', 2], // 只改名称
    ['A003', '丙', 3],
  ];
  const r = align(prev, curr, 3);
  assert.ok(r, '应当识别出主键');
  assert.deepEqual(r.key.prevCols, [0], '主键是第 1 列（编码）');
  assert.equal(r.rowPairs.length, 4, '表头 + 3 行数据全部配对');
  assert.equal(r.prevOnlyRows.length + r.currOnlyRows.length, 0, '无增删行');
});

test('主键允许重复：同键多行按出现顺序配对，不误判成增删', () => {
  const prev = [
    ['编码', '子项', '数量'],
    ['P1', 'C1', 5],
    ['P1', 'C2', 5],
    ['P1', 'C3', 6],
    ['P2', 'C1', 7],
    ['P2', 'C2', 7],
    ['P2', 'C3', 8],
    ['P3', 'C1', 9],
  ];
  const curr = [
    ['编码', '子项', '数量'],
    ['P1', 'C1', 5],
    ['P1', 'C2', 5],
    ['P1', 'C3', 6],
    ['P2', 'C1', 7],
    ['P2', 'C2', 7],
    ['P2', 'C3', 8],
    ['P3', 'C1', 9],
  ];
  curr[2][2] = 5.5; // P1/C2 的数量 5 → 5.5（主键不变的一处修改）
  const r = alignFull(prev, curr);
  assert.ok(r.key, '重复键也应能识别主键');
  const unpaired = r.prevOnlyRows.length + r.currOnlyRows.length;
  assert.equal(unpaired, 0, `重复键按顺序配对 + 少量差异补配对，不应产生增删（实际 ${unpaired}）`);
  // 配对的应当是 P1/C2 那一对（第 2 个数据行），不是错位到 P1/C1
  const target = r.rowPairs.find((p) => p.prevRow.cells[0].row_index === 2);
  assert.ok(target, '第 2 个数据行已配对');
  assert.equal(target.currRow.cells[0].row_index, 2, '配到当前版的同一行');
});

test('单列重复但组合唯一 → 识别为复合主键', () => {
  const rows = (qtyLast) => [
    ['父项', '子项', '数量'],
    ['P1', 'C1', 5],
    ['P1', 'C2', 5],
    ['P1', 'C3', 5],
    ['P2', 'C1', 5],
    ['P2', 'C2', 5],
    ['P2', 'C3', 5],
    ['P3', 'C1', 5],
    ['P3', 'C2', qtyLast],
  ];
  const r = alignFull(rows(5), rows(9));
  assert.ok(r.key, '应当识别出复合主键');
  assert.equal(r.key.prevCols.length, 2, '需要两列才能唯一：父项 + 子项');
  assert.equal(r.prevOnlyRows.length + r.currOnlyRows.length, 0);
});

test('没有任何列能当主键（全是低区分值）→ 返回 null，回退给 daff', () => {
  const prev = [
    ['状态', '标记'],
    ['是', 'A'],
    ['否', 'A'],
    ['是', 'B'],
    ['否', 'B'],
  ];
  const curr = prev.slice();
  const r = align(prev, curr, 2);
  assert.equal(r, null, '低区分列不能当主键');
});

test('两版主键几乎不重合（换了一张表）→ 返回 null', () => {
  const prev = [
    ['编码', '值'],
    ['X001', 1],
    ['X002', 2],
    ['X003', 3],
    ['X004', 4],
  ];
  const curr = [
    ['编码', '值'],
    ['Y001', 1],
    ['Y002', 2],
    ['Y003', 3],
    ['Y004', 4],
  ];
  const r = align(prev, curr, 2);
  assert.equal(r, null, '键重合率过低时不敢用主键对齐');
});

test('键列被整列改写（如编码规则调整）→ 也按"换表"处理，交回 daff', () => {
  const prev = [
    ['编码', '值'],
    ['A1', 1],
    ['A2', 2],
    ['A3', 3],
  ];
  const curr = [
    ['编码', '值'],
    ['B1', 1],
    ['B2', 2],
    ['B3', 3],
  ];
  assert.equal(align(prev, curr, 2), null);
});

test('detectKeyColumns：单列能当主键时只返回那一列（走快路径）', () => {
  const gA = __internals.buildGrid(cellsOf([['编码', '名称'], ['K1', 'a'], ['K2', 'b'], ['K3', 'c'], ['K4', 'd'], ['K5', 'e'], ['K6', 'f'], ['K7', 'g'], ['K8', 'h']]));
  const gB = __internals.buildGrid(cellsOf([['编码', '名称'], ['K1', 'a'], ['K2', 'b'], ['K3', 'c'], ['K4', 'd'], ['K5', 'e'], ['K6', 'f'], ['K7', 'g'], ['K8', 'h']]));
  const key = detectKeyColumns(gA, gB, identityPairs(2));
  assert.ok(key);
  assert.deepEqual(key.prevCols, [0]);
});
