'use strict';

/**
 * 版本线仓储：一版本线一 JSON 文件，落盘于 contracts.VERSION_LINES_DIR。
 * 结构：{version_line_id, file_name, latest_snapshot_id, created_at, updated_at}
 */

const fs = require('fs');
const path = require('path');
const { VERSION_LINES_DIR, ID_PREFIX, ERROR_CODES } = require('../contracts');
const { ensureDir, writeJsonAtomic, readJson, newId } = require('../utils/fsSafe');

function fileFor(versionLineId) {
  return path.join(VERSION_LINES_DIR, `${versionLineId}.json`);
}

function listJsonFiles() {
  try {
    ensureDir(VERSION_LINES_DIR);
    return fs.readdirSync(VERSION_LINES_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
}

function readAll() {
  const out = [];
  for (const f of listJsonFiles()) {
    const obj = readJson(path.join(VERSION_LINES_DIR, f), null);
    if (obj && obj.version_line_id) out.push(obj);
  }
  return out;
}

function findByName(fileName) {
  return readAll().find((o) => o.file_name === fileName) || null;
}

function getById(versionLineId) {
  if (!versionLineId) return null;
  return readJson(fileFor(versionLineId), null);
}

function create(fileName) {
  const now = new Date().toISOString();
  const obj = {
    version_line_id: newId(ID_PREFIX.VERSION_LINE),
    file_name: fileName,
    latest_snapshot_id: null,
    created_at: now,
    updated_at: now,
  };
  writeJsonAtomic(fileFor(obj.version_line_id), obj);
  return obj;
}

function updateLatest(versionLineId, snapshotId) {
  const obj = getById(versionLineId);
  if (!obj) return null;
  obj.latest_snapshot_id = snapshotId;
  obj.updated_at = new Date().toISOString();
  writeJsonAtomic(fileFor(versionLineId), obj);
  return obj;
}

function listAll() {
  return readAll().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function remove(versionLineId) {
  if (!versionLineId) return false;
  const fp = fileFor(versionLineId);
  try {
    if (!fs.existsSync(fp)) return false;
    fs.rmSync(fp);
    return true;
  } catch (e) {
    const err = new Error(ERROR_CODES.WRITE_FAILED.message);
    err.code = ERROR_CODES.WRITE_FAILED.code;
    err.http = ERROR_CODES.WRITE_FAILED.http;
    if (e && e.message) err.detail = String(e.message);
    throw err;
  }
}

module.exports = { findByName, getById, create, updateLatest, listAll, remove };
