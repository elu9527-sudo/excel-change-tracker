'use strict';

/**
 * 重建快照 meta 计数索引：遍历全部版本线的全部快照，按现存 changes_{snapshot_id}.json
 * 聚合出 change_count（added/modified/deleted）与 possible_shift_count，补写/刷进快照 meta。
 * timeline.getTimeline 依赖 meta.change_count 走“只读 meta”快路径，本脚本就是给
 * 旧快照（该字段上线前落盘的）补索引的运维工具。
 *
 * ⚠️ 运行前请先手工备份 data/ 目录（本脚本不会自动备份）：
 *    例：cp -r data data-backup-$(date +%Y%m%d-%H%M%S)
 *
 * 读写范围：只读 changes_*.json 与快照 meta；仅当计数缺失或与 changes 文件不一致时，
 * 全量读该快照并重写 meta（cells 原样）。不删除任何快照/版本线/原始文件，不改 changes 内容。
 * 幂等：计数已一致 → 跳过（重复执行零写入）；
 * 陈旧检测：meta 有计数但与 changes 文件不符（例如删除中间版本触发重算后未同步）→ 以
 *          changes 文件为准刷新索引。
 * 注意：本脚本补的是“现存 changes 文件的计数”。若某张卡的 changes 本身还是旧算法脏数据，
 *       请先跑 scripts/recompute-changes.js（用现行 differ 重算）再跑本脚本。
 *
 * 用法：项目根目录执行  node scripts/rebuild-index.js
 */

const fs = require('fs');
const path = require('path');

// 与 recompute-changes.js 同法：数据目录取运行处（项目根）的 data/
process.chdir(process.cwd());

const contracts = require('../src/contracts');
const versionLineRepo = require('../src/repositories/versionLineRepo');
const snapshotRepo = require('../src/repositories/snapshotRepo');
const { readJson } = require('../src/utils/fsSafe');
const { CHANGE_TYPE } = require('../src/contracts');

function changesFile(snapshotId) {
  return path.join(contracts.CHANGES_DIR, `changes_${snapshotId}.json`);
}

function countsFromChanges(snapshotId) {
  const list = readJson(changesFile(snapshotId), []);
  const c = { added: 0, modified: 0, deleted: 0, shift: 0 };
  if (Array.isArray(list)) {
    for (const ch of list) {
      if (ch.change_type === CHANGE_TYPE.added) c.added += 1;
      else if (ch.change_type === CHANGE_TYPE.modified) c.modified += 1;
      else if (ch.change_type === CHANGE_TYPE.deleted) c.deleted += 1;
      if (ch.possible_shift) c.shift += 1;
    }
  }
  return c;
}

function metaMatches(meta, c) {
  const mc = meta.change_count;
  if (!mc) return false;
  return mc.added === c.added && mc.modified === c.modified && mc.deleted === c.deleted
    && meta.possible_shift_count === c.shift;
}

const lines = versionLineRepo.listAll();
if (!lines.length) {
  console.log('未发现任何版本线（data/ 为空？），无需重建。');
  process.exit(0);
}

let total = 0;
let patched = 0;
let refreshed = 0;
let skipped = 0;

for (const line of lines) {
  const metas = snapshotRepo.listByLine(line.version_line_id, { metaOnly: true });
  console.log(`\n== 版本线「${line.file_name}」：${metas.length} 个快照 ==`);
  for (const doc of metas) {
    const m = doc.meta;
    total += 1;
    const c = countsFromChanges(m.snapshot_id);
    if (metaMatches(m, c)) {
      skipped += 1;
      console.log(`[${line.file_name}] ${m.snapshot_id}：${c.added}/${c.modified}/${c.deleted}(shift ${c.shift}) —— 索引已一致，跳过（幂等）`);
      continue;
    }
    const wasStale = !!m.change_count; // 有值但对不上 = 陈旧索引刷新
    // 全量读回（含 cells），仅改两个计数字段后原样写回
    const full = snapshotRepo.get(m.snapshot_id);
    if (!full) {
      console.log(`[${line.file_name}] ${m.snapshot_id}：读取失败，跳过`);
      continue;
    }
    full.meta.change_count = { added: c.added, modified: c.modified, deleted: c.deleted };
    full.meta.possible_shift_count = c.shift;
    snapshotRepo.save(full.meta, full.cells || []);
    if (wasStale) refreshed += 1; else patched += 1;
    console.log(`[${line.file_name}] ${m.snapshot_id}：meta 计数 ${wasStale ? '陈旧，已刷新为' : '缺失，已补写'} ${c.added}/${c.modified}/${c.deleted}(shift ${c.shift})`);
  }
}

console.log(`\n汇总：版本线 ${lines.length} 条，快照 ${total} 张 —— 补写 ${patched} 张，刷新 ${refreshed} 张，幂等跳过 ${skipped} 张。`);
console.log('未删除任何快照 / 版本线 / 原始文件；changes 文件内容未改动。');
