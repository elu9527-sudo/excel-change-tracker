'use strict';

/**
 * 版本管理：删除时间线上的单个版本节点（快照）。
 *
 * 关键约束（防止删除中间版本后 prev_snapshot_id 悬空、变更失真）：
 * - 被删版本若有下一版本且下一版本仍有前序版本：用 diffCells(上一快照, 下一快照) 重算下一版本的变更，
 *   detected_at 固定取下一版本自身的 uploaded_at（不能用当前时间，否则日期筛选会漂移）；
 * - 被删版本是基线且有下一版本：下一版本转为新基线，其旧变更文件删除（变更清零）；
 * - 删除目标快照的顺序：changes 文件 → 快照 JSON → 原始文件（路径校验在仓储内完成，越权路径拒绝并抛错）；
 * - 版本线 latest_snapshot_id 同步为剩余快照的最后一个；剩余为 0 时删除版本线 JSON。
 */

const { ERROR_CODES, PARSE_STATUS, CHANGE_TYPE } = require('../contracts');
const logger = require('../utils/logger');
const { diffCells } = require('./differ');
const snapshotCache = require('./snapshotCache');
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

function deleteSnapshot({ snapshot_id } = {}) {
  const target = snapshotRepo.get(snapshot_id);
  if (!target) throw contractError(ERROR_CODES.NOT_FOUND);

  const versionLineId = target.meta.version_line_id;
  const all = snapshotRepo.listByLine(versionLineId); // uploaded_at 升序
  const idx = all.findIndex((s) => s.meta.snapshot_id === snapshot_id);
  const prev = idx > 0 ? all[idx - 1] : null;
  const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

  let recomputedSnapshotId = null;

  if (next && prev) {
    // 下一版本改用更早的存活快照重新比对
    const changes = diffCells(prev.cells || [], next.cells || []);
    for (const ch of changes) {
      ch.version_line_id = versionLineId;
      ch.snapshot_id = next.meta.snapshot_id;
      ch.prev_snapshot_id = prev.meta.snapshot_id;
      ch.detected_at = next.meta.uploaded_at;
    }
    changeRepo.save(next.meta.snapshot_id, changes);
    next.meta.prev_snapshot_id = prev.meta.snapshot_id;
    next.meta.parse_status = PARSE_STATUS.compared;
    next.meta.is_baseline = false;
    // 同步 meta 计数索引（timeline.getTimeline 只读 meta 快路径，索引必须跟着变更点走）
    next.meta.change_count = {
      added: changes.filter((c) => c.change_type === CHANGE_TYPE.added).length,
      modified: changes.filter((c) => c.change_type === CHANGE_TYPE.modified).length,
      deleted: changes.filter((c) => c.change_type === CHANGE_TYPE.deleted).length,
    };
    next.meta.possible_shift_count = changes.filter((c) => c.possible_shift).length;
    snapshotRepo.save(next.meta, next.cells || []);
    snapshotCache.invalidate(next.meta.snapshot_id);
    recomputedSnapshotId = next.meta.snapshot_id;
  } else if (next && !prev) {
    // 删除的是基线：下一版本转为新基线，变更与计数索引一并清零
    next.meta.is_baseline = true;
    next.meta.parse_status = PARSE_STATUS.success;
    next.meta.prev_snapshot_id = null;
    next.meta.change_count = { added: 0, modified: 0, deleted: 0 };
    next.meta.possible_shift_count = 0;
    snapshotRepo.save(next.meta, next.cells || []);
    snapshotCache.invalidate(next.meta.snapshot_id);
    changeRepo.removeBySnapshot(next.meta.snapshot_id);
  }

  // 目标快照：先 changes，再快照 JSON，再原始文件（仓储内做“必须位于原始目录内”的路径校验）
  changeRepo.removeBySnapshot(snapshot_id);
  snapshotRepo.remove(snapshot_id);
  snapshotCache.invalidate(snapshot_id);
  snapshotRepo.removeRawFile(target.meta.raw_file_path);

  const remaining = snapshotRepo.listByLine(versionLineId);
  let versionLineRemoved = false;
  if (remaining.length === 0) {
    versionLineRepo.remove(versionLineId);
    versionLineRemoved = true;
  } else {
    versionLineRepo.updateLatest(versionLineId, remaining[remaining.length - 1].meta.snapshot_id);
  }

  logger.info(
    'delete_snapshot',
    `ok deleted=${snapshot_id} line=${versionLineId} recomputed=${recomputedSnapshotId || '-'} remaining=${remaining.length} lineRemoved=${versionLineRemoved}`
  );

  return {
    deleted_snapshot_id: snapshot_id,
    version_line_id: versionLineId,
    recomputed_snapshot_id: recomputedSnapshotId,
    remaining_count: remaining.length,
    version_line_removed: versionLineRemoved,
  };
}

module.exports = { deleteSnapshot };
