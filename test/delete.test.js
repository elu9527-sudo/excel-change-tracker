'use strict';

/**
 * 删除版本节点集成测试。
 * 与 scripts/smoke.js 同法：先 chdir 到系统临时目录再 require 模块，
 * 全部数据落临时目录，跑完清理，不触碰项目真实数据目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ect-delete-'));
process.chdir(tmpDir);

const { test, after } = require('node:test');
const assert = require('node:assert');

const XLSX = require('xlsx');
const contracts = require('../src/contracts');
const { handleUpload } = require('../src/services/upload');
const timelineService = require('../src/services/timeline');
const { deleteSnapshot } = require('../src/services/versionAdmin');
const versionLineRepo = require('../src/repositories/versionLineRepo');
const snapshotRepo = require('../src/repositories/snapshotRepo');

after(() => {
  process.chdir(os.tmpdir());
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------- 造数 ---------- */

function wb(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, ws, 'S1');
  return XLSX.write(book, { bookType: 'xlsx', type: 'buffer' });
}

const snapFile = (id) => path.join(contracts.SNAPSHOTS_DIR, `${id}.json`);
const changesFile = (id) => path.join(contracts.CHANGES_DIR, `changes_${id}.json`);

const LINE_A = 'del_line_a.xlsx';
// v1：基线；v2：把 a 行第 2 列 1→9；v3：再把 b 行第 2 列 2→7
const c1 = handleUpload({ fileName: LINE_A, buffer: wb([['k', 'v'], ['a', 1], ['b', 2]]) });
const c2 = handleUpload({ fileName: LINE_A, buffer: wb([['k', 'v'], ['a', 9], ['b', 2]]) });
const c3 = handleUpload({ fileName: LINE_A, buffer: wb([['k', 'v'], ['a', 9], ['b', 7]]) });
const VL_A = c1.version_line_id;

// 删除前记录 v2 的原始文件路径
const v2Raw = path.resolve(contracts.ROOT_DIR, snapshotRepo.get(c2.snapshot_id).meta.raw_file_path);

/* ---------- 断言 ---------- */

test('删除不存在的 snapshot_id 抛 NOT_FOUND', () => {
  assert.throws(
    () => deleteSnapshot({ snapshot_id: 'snap_ghost_404' }),
    (e) => e.code === contracts.ERROR_CODES.NOT_FOUND.code
  );
});

test('前置：v2/v3 各自只有 1 条 modified（对上一版本）', () => {
  assert.equal(c2.change_count.modified, 1);
  assert.equal(c3.change_count.modified, 1);
  assert.equal(c2.change_count.added + c2.change_count.deleted, 0);
});

test('删除中间版本 v2 → v3 按“v3 对 v1”重算，prev 指向 v1，卡片数 2，v2 文件已删', () => {
  const res = deleteSnapshot({ snapshot_id: c2.snapshot_id });

  assert.equal(res.deleted_snapshot_id, c2.snapshot_id);
  assert.equal(res.version_line_id, VL_A);
  assert.equal(res.recomputed_snapshot_id, c3.snapshot_id, '下一版本被重算');
  assert.equal(res.remaining_count, 2);
  assert.equal(res.version_line_removed, false);

  // v3 的 meta 重指到 v1
  const v3 = snapshotRepo.get(c3.snapshot_id);
  assert.equal(v3.meta.prev_snapshot_id, c1.snapshot_id);
  assert.equal(v3.meta.parse_status, contracts.PARSE_STATUS.compared);
  assert.equal(v3.meta.is_baseline, false);

  // v3 的变更 = v3 对 v1：a 行 1→9 与 b 行 2→7，共 2 条 modified
  const tl = timelineService.getTimeline(VL_A);
  assert.equal(tl.cards.length, 2, '卡片数变 2');
  const v3card = tl.cards.find((x) => x.snapshot_id === c3.snapshot_id);
  assert.deepEqual(v3card.change_count, { added: 0, modified: 2, deleted: 0 });

  const q = timelineService.queryChanges({ version_line_id: VL_A });
  assert.equal(q.total, 2);
  for (const ch of q.items) {
    assert.equal(ch.change_type, contracts.CHANGE_TYPE.modified);
    assert.equal(ch.snapshot_id, c3.snapshot_id);
    assert.equal(ch.prev_snapshot_id, c1.snapshot_id, '重算后的变更 prev 指向 v1');
    assert.equal(ch.detected_at, c3.uploaded_at, 'detected_at 固定为 v3 原上传时间');
  }
  assert.deepEqual(q.items.map((x) => x.cell_ref), ['B2', 'B3']);
  assert.deepEqual(q.items.map((x) => [x.old_value, x.new_value]), [['1', '9'], ['2', '7']]);

  // v2 的快照 JSON、changes 文件、原始文件都已不存在
  assert.ok(!fs.existsSync(snapFile(c2.snapshot_id)), 'v2 快照 JSON 已删除');
  assert.ok(!fs.existsSync(changesFile(c2.snapshot_id)), 'v2 changes 文件已删除');
  assert.ok(!fs.existsSync(v2Raw), 'v2 原始文件已删除');
});

test('删除最后一个快照 → 版本线 latest_snapshot_id 指向剩余最后一个', () => {
  const res = deleteSnapshot({ snapshot_id: c3.snapshot_id });
  assert.equal(res.recomputed_snapshot_id, null, '无下一版本，不重算');
  assert.equal(res.remaining_count, 1);
  assert.equal(res.version_line_removed, false);

  const line = versionLineRepo.getById(VL_A);
  assert.equal(line.latest_snapshot_id, c1.snapshot_id);
  assert.ok(!fs.existsSync(snapFile(c3.snapshot_id)));
});

test('删除唯一快照 → version_line_removed=true，版本线列表为空', () => {
  const res = deleteSnapshot({ snapshot_id: c1.snapshot_id });
  assert.equal(res.version_line_removed, true);
  assert.equal(res.remaining_count, 0);
  assert.equal(versionLineRepo.getById(VL_A), null);
  assert.equal(versionLineRepo.listAll().length, 0);
});

test('删除基线 → 下一版本变为新基线，is_baseline=true 且变更为 0', () => {
  const LINE_B = 'del_line_b.xlsx';
  const b1 = handleUpload({ fileName: LINE_B, buffer: wb([['k', 'v'], ['z', 1]]) });
  const b2 = handleUpload({ fileName: LINE_B, buffer: wb([['k', 'v'], ['z', 2]]) });
  assert.equal(b2.change_count.modified, 1, '前置：b2 对 b1 有 1 条修改');

  const res = deleteSnapshot({ snapshot_id: b1.snapshot_id });
  assert.equal(res.recomputed_snapshot_id, null, '基线删除路径不做重算，只做转基线');
  assert.equal(res.remaining_count, 1);

  const after2 = snapshotRepo.get(b2.snapshot_id);
  assert.equal(after2.meta.is_baseline, true, 'b2 转为新基线');
  assert.equal(after2.meta.parse_status, contracts.PARSE_STATUS.success);
  assert.equal(after2.meta.prev_snapshot_id, null);
  assert.ok(!fs.existsSync(changesFile(b2.snapshot_id)), '新基线的旧 changes 文件已删除');

  const tl = timelineService.getTimeline(b2.version_line_id);
  assert.equal(tl.cards.length, 1);
  assert.equal(tl.cards[0].is_baseline, true);
  assert.deepEqual(tl.cards[0].change_count, { added: 0, modified: 0, deleted: 0 });
});
