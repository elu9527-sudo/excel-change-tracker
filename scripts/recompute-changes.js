'use strict';

/**
 * 重算历史变更：把修复前（旧 cell_ref 直接比对 / 2000 行退化兜底年代）落盘的
 * changes_{snapshot_id}.json 用现行 daff 行对齐 differ 重新计算并覆盖写，
 * 同时把计数补写进快照 meta（change_count / possible_shift_count）。
 *
 * ⚠️ 运行前请先手工备份 data/ 目录（本脚本不会自动备份）：
 *    例：cp -r data data-backup-$(date +%Y%m%d-%H%M%S)   （Windows 可用“复制文件夹”）
 *
 * 读写范围（严格限定三处）：
 *   1) 只读 版本线 / 快照 / 旧 changes 的 JSON；
 *   2) 覆盖写 changes_{snapshot_id}.json；
 *   3) 覆盖写快照 JSON 的 meta（其余字段原样，cells 不动）。
 * 不删除任何快照、版本线、原始文件；不动 contracts/differ/routes/前端/文档。
 *
 * 幂等：新算法对同一对快照产出确定；业务字段（除随机 change_id 外）与现有文件
 * 完全一致时直接跳过写入——重复执行不报错、不重写、文件保持逐字节不变。
 *
 * 用法：项目根目录执行  node scripts/recompute-changes.js
 */

const path = require('path');
const fs = require('fs');

// 起头 chdir 到 process.cwd()：数据目录就是运行位置（项目根）下的 data/（contracts 的 ROOT_DIR 取自 cwd）
process.chdir(process.cwd());

const contracts = require('../src/contracts');
const versionLineRepo = require('../src/repositories/versionLineRepo');
const snapshotRepo = require('../src/repositories/snapshotRepo');
const changeRepo = require('../src/repositories/changeRepo');
const { readJson } = require('../src/utils/fsSafe');
const { diffCells } = require('../src/services/differ');
const { parseWorkbook } = require('../src/services/parser');
const { CHANGE_TYPE } = require('../src/contracts');

/**
 * --reparse：从原始文件重新解析单元格，把"公式文本"补进快照。
 * 老快照是升级前落盘的，没有 formula 字段，历史比对就看不出"公式改了但值没变"。
 * 不传这个开关时行为与以前完全一致（只重算变更，不动 cells）。
 */
const REPARSE = process.argv.includes('--reparse');
const reparsed = new Map();

function cellsOf(snapshot) {
  const id = snapshot.meta.snapshot_id;
  if (reparsed.has(id)) return reparsed.get(id);
  let cells = snapshot.cells || [];
  if (REPARSE) {
    const raw = snapshot.meta && snapshot.meta.raw_file_path;
    if (raw && fs.existsSync(raw)) {
      cells = parseWorkbook(fs.readFileSync(raw)).cells;
      console.log(`  · 重新解析 ${id}（${path.basename(raw)}）：${cells.length} 个单元格`
        + `，其中公式格 ${cells.filter((c) => c.formula).length}`);
    } else {
      console.log(`  ! ${id} 找不到原始文件，沿用旧 cells（没有公式信息）`);
    }
  }
  reparsed.set(id, cells);
  return cells;
}

function changesFile(snapshotId) {
  return path.join(contracts.CHANGES_DIR, `changes_${snapshotId}.json`);
}

function countChanges(list) {
  const c = { added: 0, modified: 0, deleted: 0, shift: 0 };
  for (const ch of list) {
    if (ch.change_type === CHANGE_TYPE.added) c.added += 1;
    else if (ch.change_type === CHANGE_TYPE.modified) c.modified += 1;
    else if (ch.change_type === CHANGE_TYPE.deleted) c.deleted += 1;
    if (ch.possible_shift) c.shift += 1;
  }
  return c;
}

/** 业务指纹：除随机 change_id 外的全部字段，用于幂等比较 */
function fingerprint(list) {
  return list
    .map((c) => [
      c.version_line_id, c.snapshot_id, c.prev_snapshot_id,
      c.sheet_name, c.cell_ref, c.change_type,
      c.old_value, c.new_value, c.row_index, c.col_index,
      c.old_formula, c.new_formula,
      c.possible_shift, c.row_label, c.row_cell_count, c.detected_at,
    ].join('|'))
    .join('\n');
}

function metaCountsEqual(meta, counts) {
  const mc = meta.change_count;
  if (!mc) return false;
  return mc.added === counts.added && mc.modified === counts.modified && mc.deleted === counts.deleted
    && meta.possible_shift_count === counts.shift;
}

const lines = versionLineRepo.listAll();
if (!lines.length) {
  console.log('未发现任何版本线（data/ 为空？），无需重算。');
  process.exit(0);
}

let totalCards = 0;
let rewrote = 0;
let skipped = 0;

for (const line of lines) {
  const snaps = snapshotRepo.listByLine(line.version_line_id); // uploaded_at 升序
  if (snaps.length <= 1) {
    console.log(`[${line.file_name}] 仅有基线快照，无后续版本，跳过`);
    continue;
  }
  console.log(`\n== 版本线「${line.file_name}」：${snaps.length} 个快照（首张基线跳过）==`);

  // --reparse 时基线也要补公式，否则第一次比对仍是"旧 cells vs 新 cells"
  if (REPARSE) {
    const base = snaps[0];
    const baseCells = cellsOf(base);
    if (baseCells !== (base.cells || [])) {
      snapshotRepo.save(base.meta, baseCells);
      console.log(`  · 基线 ${base.meta.snapshot_id} 已回写带公式的 cells`);
    }
  }

  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    totalCards += 1;

    const prevCells = cellsOf(prev);
    const currCells = cellsOf(curr);

    // 修复前：现存的 changes 文件（可能是旧算法脏数据，也可能不存在/已正确）
    const oldList = readJson(changesFile(curr.meta.snapshot_id), []);
    const before = countChanges(Array.isArray(oldList) ? oldList : []);

    // 新算法重算：与上传链路同口径（prev/curr 全量单元格）
    const newChanges = diffCells(prevCells, currCells);
    for (const ch of newChanges) {
      ch.version_line_id = curr.meta.version_line_id;
      ch.snapshot_id = curr.meta.snapshot_id;
      ch.prev_snapshot_id = prev.meta.snapshot_id;
      ch.detected_at = curr.meta.uploaded_at; // 保持原上传时间，日期筛选不漂移
    }
    const after = countChanges(newChanges);

    const idempotent = !(REPARSE && currCells !== (curr.cells || []))
      && fingerprint(oldList) === fingerprint(newChanges)
      && metaCountsEqual(curr.meta, after);
    if (idempotent) {
      skipped += 1;
      console.log(`[${line.file_name}] ${curr.meta.snapshot_id}：前 ${before.added}/${before.modified}/${before.deleted}(shift ${before.shift})`
        + ` = 后 ${after.added}/${after.modified}/${after.deleted}(shift ${after.shift}) —— 已一致，跳过（幂等）`);
      continue;
    }

    // 覆盖写 changes + 补写 meta 计数（cells 原样回写，其余 meta 字段不动）
    changeRepo.save(curr.meta.snapshot_id, newChanges);
    curr.meta.change_count = { added: after.added, modified: after.modified, deleted: after.deleted };
    curr.meta.possible_shift_count = after.shift;
    snapshotRepo.save(curr.meta, currCells);
    rewrote += 1;

    console.log(`[${line.file_name}] ${curr.meta.snapshot_id}：前 ${before.added}/${before.modified}/${before.deleted}(shift ${before.shift})`
      + ` → 后 ${after.added}/${after.modified}/${after.deleted}(shift ${after.shift}) —— 已重写`);
  }
}

console.log(`\n汇总：版本线 ${lines.length} 条，参与重算卡片 ${totalCards} 张，重写 ${rewrote} 张，幂等跳过 ${skipped} 张。`);
console.log('未删除任何快照 / 版本线 / 原始文件。如需回退，请用运行前的 data/ 备份。');
