'use strict';

/**
 * 快照读取缓存（进程内 LRU，只留最近用到的少数几个快照）。
 *
 * 背景：单快照 JSON 约 126MB，原 getContext 每次点击都全量 JSON.parse
 * （实测 425ms、堆 +120MB）；变更列表要给每一行贴"这是哪一行"的标签，
 * 也会触发同样的成本。这里把解析结果缓存住，并只做"按行抽取"的单趟扫描
 * （590k 单元格约 20ms），不额外建常驻索引，避免再翻一倍内存。
 *
 * 容量：默认 2 个（本版 + 上一版正好够整行对照）。单快照约 120MB 堆，
 * 超容量按最久未用淘汰。任何删除/重写快照的链路都应调用 invalidate。
 */

const snapshotRepo = require('../repositories/snapshotRepo');
const { ROW_LABEL_MAX } = require('../contracts');

const MAX_CACHED = 2;

const cache = new Map(); // snapshotId -> { doc, tick }
let tick = 0;

/** 取快照文档（{meta, cells}）；不存在返回 null。命中缓存时零解析成本。 */
function getDoc(snapshotId) {
  if (!snapshotId) return null;
  const hit = cache.get(snapshotId);
  if (hit) {
    hit.tick = ++tick;
    return hit.doc;
  }
  const doc = snapshotRepo.get(snapshotId);
  if (!doc || !doc.meta) return null;
  cache.set(snapshotId, { doc, tick: ++tick });
  evict();
  return doc;
}

function metaOf(snapshotId) {
  const doc = getDoc(snapshotId);
  return doc ? doc.meta : null;
}

function evict() {
  while (cache.size > MAX_CACHED) {
    let oldestKey = null;
    let oldestTick = Infinity;
    for (const [k, v] of cache) {
      if (v.tick < oldestTick) {
        oldestTick = v.tick;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    cache.delete(oldestKey);
  }
}

/** 快照被删除/重写后调用，避免后续读到旧内容。 */
function invalidate(snapshotId) {
  if (snapshotId) cache.delete(snapshotId);
}

/** 单元格值 → 单行展示文本（换行压成空格，超长截断） */
function plainText(value) {
  const s = String(value === null || value === undefined ? '' : value)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  if (s.length <= ROW_LABEL_MAX) return s;
  return s.slice(0, ROW_LABEL_MAX - 1) + '…';
}

/**
 * 行标签：用来在列表里指认"这条变更属于哪一行"。
 * 取该行最长的文本值（业务表里通常是物料名称/客户名称这类描述列），
 * 全行没有文本值时退回第一个非空值；仍然取不到返回 ''。
 */
function rowLabel(cells) {
  let best = null;
  let first = null;
  for (const c of cells) {
    const v = plainText(c.cell_value);
    if (!v) continue;
    if (first === null) first = v;
    if (best === null || v.length > best.length) best = v;
  }
  return best || first || '';
}

/**
 * 单趟扫描快照，抽取指定行的全部单元格。
 * @param {string} snapshotId
 * @param {string} sheetName
 * @param {Set<number>|Array<number>} rowIndexes 目标行（0 起算）
 * @param {{withHeader?: boolean}} [opts] withHeader=true 时同时返回首行（row_index === 0）文本
 * @returns {{rows: Map<number, Array>, header: Map<number, string>|null}}
 */
function readRows(snapshotId, sheetName, rowIndexes, opts) {
  const wanted = rowIndexes instanceof Set ? rowIndexes : new Set(rowIndexes || []);
  const withHeader = !!(opts && opts.withHeader);
  const out = { rows: new Map(), header: withHeader ? new Map() : null };
  const doc = getDoc(snapshotId);
  if (!doc || !doc.cells || !doc.cells.length) return out;

  for (const c of doc.cells) {
    if (c.sheet_name !== sheetName) continue;
    if (withHeader && c.row_index === 0) {
      const t = plainText(c.cell_value);
      if (t) out.header.set(c.col_index, t);
      continue;
    }
    if (!wanted.has(c.row_index)) continue;
    let list = out.rows.get(c.row_index);
    if (!list) {
      list = [];
      out.rows.set(c.row_index, list);
    }
    list.push(c);
  }
  for (const list of out.rows.values()) list.sort((a, b) => a.col_index - b.col_index);
  return out;
}

/**
 * 行签名：挑出"在本表内只出现一次"的 列|值，用来在另一版里唯一定位同一行。
 * 恒定列（√ / 否 / 固定填充值 这类填充值）会被自动剔除，避免假配对。
 * @returns {Set<string>} key 形如 `6|09172`
 */
function uniqueRowSignature(snapshotId, sheetName, cells) {
  const doc = getDoc(snapshotId);
  const sig = new Set();
  if (!doc || !doc.cells) return sig;

  const want = new Map(); // key -> 本行出现次数（同列同值重复时该 key 直接作废）
  for (const c of cells) {
    const v = String(c.cell_value === null || c.cell_value === undefined ? '' : c.cell_value).trim();
    if (!v) continue;
    const key = `${c.col_index}|${v}`;
    want.set(key, (want.get(key) || 0) + 1);
  }
  if (!want.size) return sig;

  const seen = new Map(); // key -> 本表出现次数
  for (const c of doc.cells) {
    if (c.sheet_name !== sheetName || c.row_index === 0) continue;
    const key = `${c.col_index}|${String(c.cell_value).trim()}`;
    if (!want.has(key)) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, timesInRow] of want) {
    if (timesInRow === 1 && seen.get(key) === 1) sig.add(key);
  }
  return sig;
}

/**
 * 在指定快照的某张表里，按签名找命中最多的那一行。
 * @returns {{row:number, score:number}|null}
 */
function findRowBySignature(snapshotId, sheetName, sig) {
  const doc = getDoc(snapshotId);
  if (!doc || !doc.cells || !sig || !sig.size) return null;

  const counts = new Map();
  for (const c of doc.cells) {
    if (c.sheet_name !== sheetName || c.row_index === 0) continue;
    const key = `${c.col_index}|${String(c.cell_value).trim()}`;
    if (!sig.has(key)) continue;
    counts.set(c.row_index, (counts.get(c.row_index) || 0) + 1);
  }
  let bestRow = null;
  let best = 0;
  for (const [row, n] of counts) {
    if (n > best || (n === best && bestRow !== null && row < bestRow)) {
      best = n;
      bestRow = row;
    }
  }
  return bestRow === null ? null : { row: bestRow, score: best };
}

module.exports = {
  getDoc,
  metaOf,
  readRows,
  rowLabel,
  plainText,
  uniqueRowSignature,
  findRowBySignature,
  invalidate,
  MAX_CACHED,
};
