'use strict';

/**
 * 查询服务（只读）：时间线、组合筛选变更、整行上下文。
 * 版本线或快照不存在时抛 NOT_FOUND（取自 contracts）。
 *
 * 展示口径（2026-11 调整）：
 * - 变更按"行"聚合展示，所以服务端给每条变更补 row_label / row_cell_count，
 *   前端据此把同一行的多个单元格变更收成一条；
 * - 列表排序改为"新快照在前 → 行号升序 → 列号升序"，不再按 detected_at 倒序
 *   （同一批变更的时间戳只差几毫秒，倒序会把整批删除堆在前面、把修改挤到后面）；
 * - 上下文由"±2 行 ±2 列方格邻域"改为"整行上下版对照"，用户看得懂的是整条记录。
 */

const { ERROR_CODES, CHANGE_TYPE, PAGE_SIZE, CHANGES_FETCH_MAX } = require('../contracts');
const versionLineRepo = require('../repositories/versionLineRepo');
const snapshotRepo = require('../repositories/snapshotRepo');
const changeRepo = require('../repositories/changeRepo');
const snapshotCache = require('./snapshotCache');
const ignoreRules = require('./ignoreRules');
const { colLetter, parseCellRef, rowNumber } = require('../utils/cellRef');

function notFoundError() {
  const err = new Error(ERROR_CODES.NOT_FOUND.message);
  err.code = ERROR_CODES.NOT_FOUND.code;
  err.http = ERROR_CODES.NOT_FOUND.http;
  return err;
}

/** 变更这条记录"属于哪一侧快照"：删除的单元格只存在于上一版 */
function sideSnapshotId(ch) {
  return ch.change_type === CHANGE_TYPE.deleted ? ch.prev_snapshot_id : ch.snapshot_id;
}

function getTimeline(versionLineId) {
  const line = versionLineRepo.getById(versionLineId);
  if (!line) throw notFoundError();

  // 只读各快照文件的 meta 块（不再全量解析 126MB 级 cells）
  const snapshots = snapshotRepo.listByLine(versionLineId, { metaOnly: true });

  // 计数优先取 meta.change_count（上传/重算链路直接落盘）；
  // 仅当存在缺该字段的旧快照时，才回退一次 changeRepo.listByLine 聚合兼容
  let fallbackCounts = null;
  function aggregateFallback() {
    if (fallbackCounts !== null) return fallbackCounts;
    fallbackCounts = new Map();
    for (const ch of changeRepo.listByLine(versionLineId)) {
      if (!fallbackCounts.has(ch.snapshot_id)) {
        fallbackCounts.set(ch.snapshot_id, { added: 0, modified: 0, deleted: 0 });
      }
      const c = fallbackCounts.get(ch.snapshot_id);
      if (ch.change_type === CHANGE_TYPE.added) c.added += 1;
      else if (ch.change_type === CHANGE_TYPE.modified) c.modified += 1;
      else if (ch.change_type === CHANGE_TYPE.deleted) c.deleted += 1;
    }
    return fallbackCounts;
  }

  // cards 按 uploaded_at 倒序
  // "行数"：一张卡片上写"删 6 行"比"删 156 个单元格"好懂得多，但 meta 只存了单元格数，
  // 所以这里按 (工作表 + 行号) 去重算一次行数；变更文件都很小，且同一请求内只算一次。
  const rowCountCache = new Map();
  function rowCountsOf(snapshotId) {
    if (rowCountCache.has(snapshotId)) return rowCountCache.get(snapshotId);
    const sets = { added: new Set(), modified: new Set(), deleted: new Set() };
    for (const ch of changeRepo.list(snapshotId)) {
      const key = `${ch.sheet_name}\u0001${ch.row_index}`;
      if (ch.change_type === CHANGE_TYPE.added) sets.added.add(key);
      else if (ch.change_type === CHANGE_TYPE.modified) sets.modified.add(key);
      else if (ch.change_type === CHANGE_TYPE.deleted) sets.deleted.add(key);
    }
    const res = { added: sets.added.size, modified: sets.modified.size, deleted: sets.deleted.size };
    rowCountCache.set(snapshotId, res);
    return res;
  }

  const cards = snapshots
    .slice()
    .reverse()
    .map((s, idx) => {
      const m = s.meta;
      let cc = m.change_count;
      if (!cc) cc = aggregateFallback().get(m.snapshot_id) || { added: 0, modified: 0, deleted: 0 };
      return {
        snapshot_id: m.snapshot_id,
        file_name: m.file_name,
        uploaded_at: m.uploaded_at,
        is_baseline: m.is_baseline,
        parse_status: m.parse_status,
        prev_snapshot_id: m.prev_snapshot_id || null,
        // 第几次上传（1 = 第一次，基线）
        upload_no: snapshots.length - idx,
        change_count: {
          added: (cc && cc.added) || 0,
          modified: (cc && cc.modified) || 0,
          deleted: (cc && cc.deleted) || 0,
        },
        // 行数（去重后），给业务看的口径
        row_count: m.is_baseline ? { added: 0, modified: 0, deleted: 0 } : rowCountsOf(m.snapshot_id),
      };
    });

  return { version_line: line, cards };
}

/**
 * 行级展示信息：row_label / row_cell_count 在比对时已写入变更记录，
 * 这里只补"该行属于哪一版快照"（删除的单元格只存在于上一版）。
 * 老数据（本轮之前落盘的 changes）缺这两个字段，需跑 scripts/recompute-changes.js 补齐。
 */
function withRowInfo(items) {
  for (const ch of items) {
    ch.row_snapshot_id = sideSnapshotId(ch) || null;
    if (ch.row_label === undefined || ch.row_label === null) ch.row_label = '';
    if (ch.row_cell_count === undefined || ch.row_cell_count === null) ch.row_cell_count = 0;
  }
  return items;
}

function queryChanges(params) {
  const p = params || {};
  const line = versionLineRepo.getById(p.version_line_id);
  if (!line) throw notFoundError();

  // 快照先后（uploaded_at 升序）→ 排名，用于"新批次在前"的排序
  const snaps = snapshotRepo.listByLine(p.version_line_id, { metaOnly: true });
  const rank = new Map(snaps.map((s, i) => [s.meta.snapshot_id, i]));

  let items = changeRepo.listByLine(p.version_line_id);
  const dateFrom = p.date_from ? String(p.date_from).slice(0, 10) : null;
  const dateTo = p.date_to ? String(p.date_to).slice(0, 10) : null;

  items = items.filter((ch) => {
    const day = String(ch.detected_at).slice(0, 10);
    if (dateFrom && day < dateFrom) return false;
    if (dateTo && day > dateTo) return false;
    if (p.sheet_name && ch.sheet_name !== p.sheet_name) return false;
    if (p.change_type && ch.change_type !== p.change_type) return false;
    return true;
  });

  // 忽略规则：按工作簿名生效，改规则立即影响列表（不重算、不动已落盘的变更，
  // 所以随时能关掉 ignore=0 把被隐藏的条目调出来复查）
  const ignoreSpecs = p.ignore === '0' ? [] : ignoreRules.getForFile(line.file_name);
  let ignoreInfo = { ignored: 0, byRule: {} };
  if (ignoreSpecs.length) {
    const res = ignoreRules.applyToChanges(ignoreSpecs, items);
    items = res.kept;
    ignoreInfo = { ignored: res.ignored, byRule: res.byRule };
  }

  // 排序：新快照在前；同一快照内按 表 → 行 → 列，让同一行的变更天然相邻
  items = items.slice().sort((a, b) => {
    const ra = rank.has(a.snapshot_id) ? rank.get(a.snapshot_id) : -1;
    const rb = rank.has(b.snapshot_id) ? rank.get(b.snapshot_id) : -1;
    if (ra !== rb) return rb - ra;
    const bySheet = String(a.sheet_name).localeCompare(String(b.sheet_name));
    if (bySheet) return bySheet;
    if (a.row_index !== b.row_index) return a.row_index - b.row_index;
    return a.col_index - b.col_index;
  });

  const total = items.length;
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  const rawSize = parseInt(p.page_size, 10) || PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawSize), CHANGES_FETCH_MAX);
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  withRowInfo(pageItems);

  return {
    total,
    page,
    page_size: pageSize,
    items: pageItems,
    ignored_count: ignoreInfo.ignored,
    ignore_rules: ignoreSpecs,
    ignore_by_rule: ignoreInfo.byRule,
  };
}

/**
 * 整行上下文：给定义务上"这条变更属于哪条记录，它改前改后各是什么样"。
 *
 * 入参：
 * - snapshot_id：该行所在的那一版（删除类传上一版，其余传当前版）；
 * - other_snapshot_id：用来找对照行的另一版（可空）；
 * - cell_ref：定位行（取该 cell_ref 的行号）。
 *
 * 对照行的找法：拿本行"在本表内唯一"的若干值做签名，去另一版里找命中行。
 * 不用"整行最相似"是因为表里有大量恒定列（√ / 否 / 固定填充值），
 * 整行相似度会被这些列拉平，任何一行都能配出一个假对照。
 */
function getContext(params) {
  const p = params || {};
  const sheetName = String(p.sheet_name || '');
  const pos = parseCellRef(String(p.cell_ref || ''));
  if (!pos) throw notFoundError();

  const selfId = p.snapshot_id || null;
  const otherId = p.other_snapshot_id || null;
  const selfMeta = snapshotCache.metaOf(selfId);
  if (!selfMeta) throw notFoundError();

  const selfRows = snapshotCache.readRows(selfId, sheetName, [pos.row], { withHeader: true });
  const selfCells = selfRows.rows.get(pos.row) || [];
  if (!selfCells.length) throw notFoundError();

  // 对照行：用"本表内唯一值"做签名，找不到就认为对面没有这一行（整行删除/新增）
  let otherRowIndex = null;
  let otherCells = [];
  if (otherId && otherId !== selfId) {
    const sig = snapshotCache.uniqueRowSignature(selfId, sheetName, selfCells);
    if (sig.size) {
      const hit = snapshotCache.findRowBySignature(otherId, sheetName, sig);
      if (hit) {
        otherRowIndex = hit.row;
        const got = snapshotCache.readRows(otherId, sheetName, [hit.row]);
        otherCells = got.rows.get(hit.row) || [];
      }
    }
  }
  const otherMeta = otherId ? snapshotCache.metaOf(otherId) : null;

  // 列集合：并集；表头取首行文本（本表首行多为填写说明，取首行首段）
  const colSet = new Set();
  for (const c of selfCells) colSet.add(c.col_index);
  for (const c of otherCells) colSet.add(c.col_index);
  const headers = selfRows.header || new Map();
  const columns = [...colSet].sort((a, b) => a - b).map((col) => {
    const ref = selfCells.find((c) => c.col_index === col) || otherCells.find((c) => c.col_index === col);
    return {
      col_index: col,
      letter: colLetter(col),
      header: headers.get(col) || '',
      cell_ref: ref ? ref.cell_ref : `${colLetter(col)}${pos.row + 1}`,
    };
  });

  function pack(snapshotId, meta, rowIndex, cells) {
    return {
      snapshot_id: snapshotId,
      uploaded_at: meta ? meta.uploaded_at : null,
      file_name: meta ? meta.file_name : null,
      is_baseline: meta ? !!meta.is_baseline : false,
      row_index: rowIndex,
      row_number: rowNumber(rowIndex),
      exists: !!(cells && cells.length),
      cells: (cells || []).map((c) => ({
        cell_ref: c.cell_ref,
        col_index: c.col_index,
        letter: colLetter(c.col_index),
        value: c.cell_value,
        value_type: c.value_type,
        // 公式文本（无公式为 null）：整行对照里"值一样但公式变了"要能看见
        formula: c.formula || null,
      })),
    };
  }

  const selfSide = pack(selfId, selfMeta, pos.row, selfCells);
  const otherSide = otherId && otherMeta ? pack(otherId, otherMeta, otherRowIndex, otherCells) : null;

  // 按上传时间排成"上一版 / 本版"
  const order = [otherSide, selfSide].filter(Boolean);
  order.sort((a, b) => String(a.uploaded_at || '').localeCompare(String(b.uploaded_at || '')));

  return {
    sheet_name: sheetName,
    cell_ref: String(p.cell_ref || ''),
    row_index: pos.row,
    row_number: rowNumber(pos.row),
    row_label: snapshotCache.rowLabel(selfCells),
    columns,
    sides: order.map((s, i) => ({ ...s, role: i === order.length - 1 ? 'current' : 'previous' })),
  };
}

module.exports = { getTimeline, queryChanges, getContext };
