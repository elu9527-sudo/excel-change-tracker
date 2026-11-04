'use strict';

/**
 * 上传编排：校验 → 解析（先解析后落盘，失败不产生任何快照/变更，规范 E08）
 * → 版本线识别/创建 → 与上一快照比对 → 原子落盘。
 * 落盘顺序：raw 文件 → snapshot → changes → version_line，任一步失败返回 WRITE_FAILED。
 */

const crypto = require('crypto');
const {
  ERROR_CODES,
  ALLOWED_EXT,
  MAX_FILE_SIZE,
  PARSE_STATUS,
  CHANGE_TYPE,
  ID_PREFIX,
} = require('../contracts');
const { newId } = require('../utils/fsSafe');
const logger = require('../utils/logger');
const { parseWorkbook } = require('./parser');
const { diffCells, diffCellsDetailed } = require('./differ');
const versionLineRepo = require('../repositories/versionLineRepo');
const snapshotRepo = require('../repositories/snapshotRepo');
const changeRepo = require('../repositories/changeRepo');

function contractError(meta, detail) {
  const err = new Error(meta.message);
  err.code = meta.code;
  err.http = meta.http;
  if (detail) err.detail = String(detail);
  return err;
}

function hasAllowedExt(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return ALLOWED_EXT.some((ext) => lower.endsWith(ext));
}

function handleUpload({ fileName, buffer }) {
  // 1. 校验：后缀、非空、大小
  if (!fileName || fileName === '.' || fileName === '..' || fileName.includes('/') || fileName.includes('\\') || !hasAllowedExt(fileName)) {
    throw contractError(ERROR_CODES.INVALID_FORMAT);
  }
  if (!buffer || buffer.length === 0) {
    throw contractError(ERROR_CODES.EMPTY_FILE);
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw contractError(ERROR_CODES.FILE_TOO_LARGE);
  }

  // 2. 先解析；解析失败立即抛出，不写任何快照与变更，上一有效快照保持可用
  let parsed;
  try {
    parsed = parseWorkbook(buffer);
  } catch (e) {
    logger.error('upload', 'parse_failed', `${fileName}: ${e.message}`);
    throw e;
  }

  // 3. 版本线：按文件名精确匹配，找不到就创建
  let line = versionLineRepo.findByName(fileName);
  if (!line) line = versionLineRepo.create(fileName);

  const prev = snapshotRepo.latestByLine(line.version_line_id);
  const isBaseline = !prev;
  const snapshotId = newId(ID_PREFIX.SNAPSHOT);
  const uploadedAt = new Date().toISOString();
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // 4. 比对（基线不比对）
  let changes = [];
  let alignedBy = {};
  if (!isBaseline) {
    const result = diffCellsDetailed(prev.cells || [], parsed.cells);
    changes = result.changes;
    alignedBy = result.keys;
    for (const ch of changes) {
      ch.version_line_id = line.version_line_id;
      ch.snapshot_id = snapshotId;
      ch.prev_snapshot_id = prev.meta.snapshot_id;
    }
  }

  // 5. 落盘：raw → snapshot → changes → version_line
  const parseStatus = isBaseline ? PARSE_STATUS.success : PARSE_STATUS.compared;
  try {
    const rawPath = snapshotRepo.saveRawFile(line.version_line_id, snapshotId, fileName, buffer);
    const meta = {
      snapshot_id: snapshotId,
      version_line_id: line.version_line_id,
      file_name: fileName,
      file_hash: fileHash,
      uploaded_at: uploadedAt,
      file_size: buffer.length,
      sheet_count: parsed.sheetNames.length,
      is_baseline: isBaseline,
      raw_file_path: rawPath,
      parse_status: parseStatus,
      prev_snapshot_id: isBaseline ? null : prev.meta.snapshot_id,
      // 新增计数字段：daff 算完直接落 meta（历史数据由 scripts/recompute-changes.js 补齐）
      change_count: {
        added: changes.filter((c) => c.change_type === CHANGE_TYPE.added).length,
        modified: changes.filter((c) => c.change_type === CHANGE_TYPE.modified).length,
        deleted: changes.filter((c) => c.change_type === CHANGE_TYPE.deleted).length,
      },
      possible_shift_count: changes.filter((c) => c.possible_shift).length,
      // 每张表按哪些列认行（有主键的表才有值，没有的走内容对齐）
      aligned_by: alignedBy,
    };
    snapshotRepo.save(meta, parsed.cells);
    if (!isBaseline) changeRepo.save(snapshotId, changes);
    versionLineRepo.updateLatest(line.version_line_id, snapshotId);
  } catch (e) {
    logger.error('upload', 'write_failed', `${fileName}: ${e.message}`);
    if (e && e.code && e.http) throw e;
    throw contractError(ERROR_CODES.WRITE_FAILED, e && e.message);
  }

  // 6. 上传结果卡片（第 7.3 节契约）
  const countOf = (type) => changes.filter((c) => c.change_type === type).length;
  const card = {
    file_name: fileName,
    version_line_id: line.version_line_id,
    snapshot_id: snapshotId,
    uploaded_at: uploadedAt,
    is_baseline: isBaseline,
    parse_status: parseStatus,
    change_count: {
      added: countOf(CHANGE_TYPE.added),
      modified: countOf(CHANGE_TYPE.modified),
      deleted: countOf(CHANGE_TYPE.deleted),
    },
    possible_shift_count: changes.filter((c) => c.possible_shift).length,
    aligned_by: alignedBy,
    message: isBaseline ? '基线版本已创建，无上一版本可比对' : '比对完成',
  };
  const keyDesc = Object.entries(alignedBy).map(([s, k]) => `${s}:${k}`).join(',') || '无主键(内容对齐)';
  logger.info('upload', `ok ${fileName} snapshot=${snapshotId} keys=${keyDesc}`);
  return card;
}

module.exports = { handleUpload };
