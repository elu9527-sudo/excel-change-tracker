'use strict';

/**
 * 变更仓储：按快照分文件落盘于 contracts.CHANGES_DIR，
 * 文件名为 changes_{snapshot_id}.json；查询时按版本线聚合。
 * 变更对象字段固定：change_id、version_line_id、snapshot_id、prev_snapshot_id、
 * sheet_name、cell_ref、change_type、old_value、new_value、row_index、col_index、
 * possible_shift、detected_at。
 */

const fs = require('fs');
const path = require('path');
const { CHANGES_DIR, ERROR_CODES } = require('../contracts');
const { writeJsonAtomic, readJson } = require('../utils/fsSafe');
const snapshotRepo = require('./snapshotRepo');

function fileFor(snapshotId) {
  return path.join(CHANGES_DIR, `changes_${snapshotId}.json`);
}

function writeFailedError(detail) {
  const err = new Error(ERROR_CODES.WRITE_FAILED.message);
  err.code = ERROR_CODES.WRITE_FAILED.code;
  err.http = ERROR_CODES.WRITE_FAILED.http;
  if (detail) err.detail = String(detail && detail.message ? detail.message : detail);
  return err;
}

function save(snapshotId, changes) {
  writeJsonAtomic(fileFor(snapshotId), changes || []);
  return snapshotId;
}

/** 读某个快照的变更（供时间线统计"行数"用：一份 160 条的变更文件很小） */
function list(snapshotId) {
  const fp = fileFor(String(snapshotId || ''));
  if (!fs.existsSync(fp)) return [];
  const arr = readJson(fp, []);
  return Array.isArray(arr) ? arr : [];
}

function listByLine(versionLineId) {
  const snapshots = snapshotRepo.listByLine(versionLineId);
  const out = [];
  for (const s of snapshots) {
    const id = s.meta.snapshot_id;
    const fp = fileFor(id);
    if (!fs.existsSync(fp)) continue;
    const arr = readJson(fp, []);
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

function removeBySnapshot(snapshotId) {
  if (!snapshotId) return false;
  const fp = fileFor(snapshotId);
  try {
    if (!fs.existsSync(fp)) return false;
    fs.rmSync(fp);
    return true;
  } catch (e) {
    throw writeFailedError(e);
  }
}

module.exports = { save, list, listByLine, removeBySnapshot };
