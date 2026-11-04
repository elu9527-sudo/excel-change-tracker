'use strict';

/**
 * 快照仓储：一快照一 JSON 文件，结构 {meta:{...}, cells:[...]}；
 * 原始文件另存于 contracts.RAW_FILES_DIR/{version_line_id}/{snapshot_id}_{原文件名}。
 */

const fs = require('fs');
const path = require('path');
const { SNAPSHOTS_DIR, RAW_FILES_DIR, ROOT_DIR, ERROR_CODES } = require('../contracts');
const { ensureDir, writeJsonAtomic, readJson, writeFileAtomic } = require('../utils/fsSafe');

function fileFor(snapshotId) {
  return path.join(SNAPSHOTS_DIR, `${snapshotId}.json`);
}

function writeFailedError(detail) {
  const err = new Error(ERROR_CODES.WRITE_FAILED.message);
  err.code = ERROR_CODES.WRITE_FAILED.code;
  err.http = ERROR_CODES.WRITE_FAILED.http;
  if (detail) err.detail = String(detail && detail.message ? detail.message : detail);
  return err;
}

function save(snapshot, cells) {
  const doc = { meta: snapshot, cells: cells || [] };
  writeJsonAtomic(fileFor(snapshot.snapshot_id), doc);
  return doc;
}

function get(snapshotId) {
  if (!snapshotId) return null;
  return readJson(fileFor(snapshotId), null);
}

/**
 * 只读快照的 meta 块。
 * 依据：快照文件由 writeJsonAtomic 以 JSON.stringify({meta, cells}, null, 2) 写出，
 * 结构固定为 `{\n  "meta": {...}\n,\n  "cells": [...` ——顶层键 "cells" 恒以
 * `\n  "cells":`（换行+两空格）出现；pretty-print 的 JSON 字符串值内不会含裸换行，
 * meta 内部键缩进为 4 空格，因此该标记在文件中唯一，取标记前的文本补 `}` 即可
 * 得到合法 JSON。只预读头部小块（64KB 起倍增、上限 8MB），绝不整读/驻留 cells。
 * 异常/格式不符时回退：全量 JSON.parse 后立即丢弃 cells 引用（交 GC）。
 */
function readMetaOnly(filePath) {
  const MARKER = '\n  "cells":';
  const CHUNK = 64 * 1024;
  const MAX_WINDOW = 8 * 1024 * 1024;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = [];
    let window = 0;
    while (window < MAX_WINDOW) {
      const buf = Buffer.alloc(Math.min(CHUNK, MAX_WINDOW - window));
      const got = fs.readSync(fd, buf, 0, buf.length, window);
      if (got <= 0) break;
      window += got;
      const text = Buffer.concat(head.concat([buf.slice(0, got)])).toString('utf8');
      const at = text.indexOf(MARKER);
      if (at >= 0) {
        const metaJson = text.slice(0, at).replace(/,\s*$/, '');
        const doc = JSON.parse(`${metaJson}\n}`);
        return doc.meta || null;
      }
      head.push(buf.slice(0, got));
      if (got < buf.length) break; // 文件读完仍无标记：格式异常，走全量回退
    }
  } catch (e) {
    // 解析/读取异常：走全量回退
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
  const full = readJson(filePath, null);
  if (!full || !full.meta) return null;
  const meta = full.meta;
  full.cells = null; // 立即解除引用，让 GC 可回收 cells
  return meta;
}

/**
 * 按版本线取快照。opts.metaOnly=true 时返回 [{meta, cells: []}]：
 * 只解析各文件的 meta 块，不读取/驻留 cells 数据（时间线查询用）。
 */
function listByLine(versionLineId, opts) {
  const metaOnly = !!(opts && opts.metaOnly);
  const out = [];
  try {
    ensureDir(SNAPSHOTS_DIR);
    for (const f of fs.readdirSync(SNAPSHOTS_DIR).filter((x) => x.endsWith('.json'))) {
      const fp = path.join(SNAPSHOTS_DIR, f);
      if (metaOnly) {
        const meta = readMetaOnly(fp);
        if (meta && meta.version_line_id === versionLineId) out.push({ meta, cells: [] });
        continue;
      }
      const doc = readJson(fp, null);
      if (doc && doc.meta && doc.meta.version_line_id === versionLineId) out.push(doc);
    }
  } catch (e) {
    return [];
  }
  return out.sort((a, b) => String(a.meta.uploaded_at).localeCompare(String(b.meta.uploaded_at)));
}

function latestByLine(versionLineId) {
  const list = listByLine(versionLineId);
  return list.length ? list[list.length - 1] : null;
}

function saveRawFile(versionLineId, snapshotId, fileName, buffer) {
  const base = path.basename(String(fileName || 'upload.xlsx')).replace(/[\\/:*?"<>|]/g, '_');
  const target = path.join(RAW_FILES_DIR, versionLineId, `${snapshotId}_${base}`);
  writeFileAtomic(target, buffer);
  return path.relative(ROOT_DIR, target).split(path.sep).join('/');
}

function remove(snapshotId) {
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

/**
 * 删除原始文件：先做路径校验——解析后必须仍位于 RAW_FILES_DIR 内，
 * 否则视为越权路径，拒绝删除并抛 WRITE_FAILED。
 */
function removeRawFile(rawFilePath) {
  if (!rawFilePath) return false;
  const full = path.isAbsolute(rawFilePath)
    ? path.resolve(rawFilePath)
    : path.resolve(ROOT_DIR, rawFilePath);
  const baseDir = path.resolve(RAW_FILES_DIR);
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
    throw writeFailedError('原始文件路径越出快照存放目录，已拒绝删除');
  }
  try {
    if (!fs.existsSync(full)) return false;
    fs.rmSync(full);
    return true;
  } catch (e) {
    throw writeFailedError(e);
  }
}

module.exports = { save, get, listByLine, latestByLine, saveRawFile, remove, removeRawFile };
