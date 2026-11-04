'use strict';

/**
 * E07 端到端冒烟（退出码 0 = 通过）：不启动 HTTP，直接调用 services。
 * 四步：上传基线 → 上传第二版（含新增/修改/删除）→ 查 timeline → 带筛选查 changes。
 * 全程在系统临时目录运行，不影响正式数据目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 先切到临时目录，再加载 contracts（其 ROOT_DIR 取当前工作目录），数据全部落临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ect-smoke-'));
process.chdir(tmpDir);

const XLSX = require('xlsx');
const contracts = require('../src/contracts');
const { handleUpload } = require('../src/services/upload');
const timelineService = require('../src/services/timeline');

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
}
function assertEqual(actual, expected, msg) {
  assert(String(actual) === String(expected), `${msg}（期望 ${expected}，实际 ${actual}）`);
}

function buildWorkbook(rows, sheetName) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

const FILE_NAME = 'smoke_master.xlsx';
// 基线：表头 + 8 行数据；b1/b2 等锚点行把“删除区”“插入区”隔开
const v1Rows = [
  ['name', 'value', 'note'],
  ['a', 1, 'x'],
  ['b1', 'vb1', 'nb1'],
  ['c1', 3, 'z1'],
  ['c2', 4, 'z2'],
  ['m', 5, 'mm'],
  ['b2', 'vb2', 'nb2'],
  ['t', 9, 'tt'],
];
// 第二版：a 行改 1 列、m 行改 1 列（2 条 modified）；删掉 c1/c2 两行（6 条 deleted）；
// 在 b2 与 t 之间插入 i1/i2 两行（6 条 added）；删除与插入位于互不相同的锚点间隙。
// 行对齐修复后：整表位移不应产生任何 modified 误报，位移疑似（possible_shift）应为 0。
const v2Rows = [
  ['name', 'value', 'note'],
  ['a', 1, 'x2'],
  ['b1', 'vb1', 'nb1'],
  ['m', 5, 'MM'],
  ['b2', 'vb2', 'nb2'],
  ['i1', 7, 'ni1'],
  ['i2', 8, 'ni2'],
  ['t', 9, 'tt'],
];

let card1 = null;
let card2 = null;

function step(n, name, fn) {
  fn();
  console.log(`[SMOKE ${n}/4] PASS - ${name}`);
}

try {
  step(1, '上传基线', () => {
    card1 = handleUpload({ fileName: FILE_NAME, buffer: buildWorkbook(v1Rows, 'S1') });
    assertEqual(card1.is_baseline, true, '首次上传 is_baseline');
    assertEqual(card1.parse_status, contracts.PARSE_STATUS.success, '基线 parse_status');
    assertEqual(card1.version_line_id, card1.version_line_id, '版本线已生成');
    assert(
      card1.change_count.added + card1.change_count.modified + card1.change_count.deleted === 0,
      '基线不生成变更'
    );
  });

  step(2, '上传第二版并比对（新增/修改/删除）', () => {
    card2 = handleUpload({ fileName: FILE_NAME, buffer: buildWorkbook(v2Rows, 'S1') });
    assertEqual(card2.is_baseline, false, '第二版非基线');
    assertEqual(card2.parse_status, contracts.PARSE_STATUS.compared, '第二版 parse_status');
    assertEqual(card2.version_line_id, card1.version_line_id, '同文件名归入同版本线');
    assertEqual(card2.change_count.added, 6, '新增条数（插入 2 行 × 3 列）');
    assertEqual(card2.change_count.modified, 2, '修改条数（a 行与 m 行各 1 列）');
    assertEqual(card2.change_count.deleted, 6, '删除条数（c1/c2 两行 × 3 列）');
    assert(
      card2.change_count.added >= 1 && card2.change_count.modified >= 1 && card2.change_count.deleted >= 1,
      '新增/删除/修改各至少 1 条'
    );
    assertEqual(card2.possible_shift_count, 0, '行对齐后位移误报为 0');
  });

  step(3, '查询 timeline', () => {
    const tl = timelineService.getTimeline(card2.version_line_id);
    assertEqual(tl.cards.length, 2, '版本卡片数');
    assertEqual(tl.cards[0].snapshot_id, card2.snapshot_id, '卡片按上传时间倒序，最新在前');
    assertEqual(tl.cards[0].change_count.added, 6, '最新卡片新增统计');
    assertEqual(tl.cards[0].change_count.deleted, 6, '最新卡片删除统计');
    assertEqual(tl.cards[1].is_baseline, true, '末位卡片为基线');
    assertEqual(tl.cards[1].change_count.modified, 0, '基线无变更统计');
  });

  step(4, '带筛选查询 changes', () => {
    const all = timelineService.queryChanges({ version_line_id: card2.version_line_id });
    assertEqual(all.total, 14, '全量命中条数');

    const added = timelineService.queryChanges({
      version_line_id: card2.version_line_id,
      change_type: contracts.CHANGE_TYPE.added,
    });
    assertEqual(added.total, 6, '按变更类型筛选命中');
    assert(added.items.every((c) => c.change_type === contracts.CHANGE_TYPE.added), '筛选结果类型一致');

    const deleted = timelineService.queryChanges({
      version_line_id: card2.version_line_id,
      change_type: contracts.CHANGE_TYPE.deleted,
    });
    assertEqual(deleted.total, 6, '删除类型筛选命中');

    const sheet = timelineService.queryChanges({ version_line_id: card2.version_line_id, sheet_name: 'S1' });
    assertEqual(sheet.total, 14, '按工作表筛选命中');

    const today = new Date().toISOString().slice(0, 10);
    const byDate = timelineService.queryChanges({
      version_line_id: card2.version_line_id,
      date_from: today,
      date_to: today,
      change_type: contracts.CHANGE_TYPE.modified,
    });
    assertEqual(byDate.total, 2, '日期 + 类型组合筛选命中');

    const none = timelineService.queryChanges({ version_line_id: card2.version_line_id, sheet_name: '不存在的工作表' });
    assertEqual(none.total, 0, '无匹配时命中 0 条');

    const paged = timelineService.queryChanges({ version_line_id: card2.version_line_id, page: 2, page_size: 3 });
    assertEqual(paged.items.length, 3, '分页 page_size 生效');
  });

  console.log('SMOKE 全部通过');
  process.chdir(os.tmpdir());
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  console.error(`SMOKE 失败：${e && e.message}`);
  process.chdir(os.tmpdir());
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
