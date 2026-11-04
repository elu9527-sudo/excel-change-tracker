'use strict';

/**
 * ECT 前端：原生 JS + fetch，无框架、无构建链。
 * 字段全部按第 7 章契约读取，不自造别名。
 *
 * 展示口径（2026-11 调整）：
 * - 变更按"行"聚合：一条 Excel 行 = 列表里一行，展开才看字段级明细。
 *   原实现逐单元格平铺，一次删 6 行会刷出 156 行内容几乎一样的记录，人读不懂。
 * - 上下文面板改为"整行对照"：显示这一整条记录在上一版 / 本版的样子，
 *   并标出变化字段；不再是"以某格为中心 ±2 行 ±2 列"的方格邻域。
 * - 列表分页按聚合行做，并保证能翻完（原实现只请求第 1 页且无翻页控件，
 *   超过 100 条的"修改/新增"会被永久挡住）。
 */

const $ = (id) => document.getElementById(id);

const GROUP_PAGE_SIZE = 50;

const els = {
  fileInput: $('file-input'),
  uploadBtn: $('upload-btn'),
  uploadStatus: $('upload-status'),
  uploadCard: $('upload-card'),
  lineSelect: $('line-select'),
  refreshBtn: $('refresh-btn'),
  timeline: $('timeline'),
  dateFrom: $('f-date-from'),
  dateTo: $('f-date-to'),
  sheet: $('f-sheet'),
  type: $('f-type'),
  applyBtn: $('apply-btn'),
  resetBtn: $('reset-btn'),
  hitCount: $('hit-count'),
  changesBody: $('changes-body'),
  changesEmpty: $('changes-empty'),
  pager: $('pager'),
  pageInfo: $('page-info'),
  prevPage: $('prev-page'),
  nextPage: $('next-page'),
  contextBody: $('context-body'),
  ignoreInput: $('ignore-input'),
  ignoreSave: $('ignore-save'),
  ignoreClear: $('ignore-clear'),
  ignoreOff: $('ignore-off'),
  ignoreStatus: $('ignore-status'),
  ignoreSummary: $('ignore-summary'),
};

const state = {
  versionLineId: null,
  lines: [],
  cards: [],
  changes: [],
  total: 0,
  ignoredCount: 0,
  truncated: false,
  groups: [],
  groupPage: 1,
  expandedCards: new Set(),
  expandedGroups: new Set(),
  selectedKey: null,
  activeKey: null,
};

const TYPE_LABEL = { added: '新增', modified: '修改', deleted: '删除' };

/** 页面需要的接口能力：服务端 /api/health 没给全，就说明后台是旧版本 */
const NEEDED_FEATURES = ['upload_no', 'row_count', 'ignore_rules', 'formula'];

async function checkServerVersion() {
  try {
    const h = await api('/api/health');
    const got = Array.isArray(h.features) ? h.features : [];
    const missing = NEEDED_FEATURES.filter((f) => !got.includes(f));
    if (missing.length) {
      $('stale-banner').classList.remove('hidden');
      console.warn('后台版本过旧，缺少能力：', missing.join(', '));
    }
  } catch (e) {
    /* 健康检查失败不阻断页面，后续请求会自己报错 */
  }
}

/* ---------- 全局 loading 状态条（页面顶部，index.html 不动，运行时插入） ---------- */

const statusBar = document.createElement('div');
statusBar.id = 'status-bar';
statusBar.className = 'hidden';
document.body.insertBefore(statusBar, document.body.firstChild);

const busy = { barTimer: null };

function setBar(text, cls) {
  clearTimeout(busy.barTimer);
  statusBar.textContent = text;
  statusBar.className = cls;
}

/**
 * fetch 统一包装：busyLabel 决定状态条文案（“正在xxx…”灰、完成绿、失败红，
 * 结束后自动隐藏）；busyBtn 在处理期间禁用；busyRegion（默认取 busyBtn 所在面板）
 * 半透明提示。调用处不再重复写 disabled/状态条逻辑。
 */
async function api(url, options, busyOpts) {
  const { busyLabel, busyBtn, busyRegion } = busyOpts || {};
  const btns = busyBtn ? (Array.isArray(busyBtn) ? busyBtn : [busyBtn]) : [];
  const region = busyRegion || (btns[0] ? btns[0].closest('.panel') : null);
  if (busyLabel) setBar(`正在${busyLabel}…`, 'bar-processing');
  for (const b of btns) b.disabled = true;
  if (region) region.classList.add('busy-dim');
  try {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const err = new Error(data && data.message ? `[${data.code}] ${data.message}` : `请求失败（HTTP ${res.status}）`);
      if (data && data.code) err.code = data.code;
      throw err;
    }
    if (busyLabel) {
      setBar(`完成：${busyLabel}`, 'bar-ok');
      busy.barTimer = setTimeout(() => statusBar.classList.add('hidden'), 1500);
    }
    return data || {};
  } catch (e) {
    if (busyLabel) {
      setBar(`失败：${e.message || busyLabel + '失败'}`, 'bar-err');
      busy.barTimer = setTimeout(() => statusBar.classList.add('hidden'), 2600);
    }
    throw e;
  } finally {
    for (const b of btns) b.disabled = false;
    if (region) region.classList.remove('busy-dim');
  }
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '';
  return String(iso).replace('T', ' ').slice(0, 19);
}

/** 卡片上用短时间：11-04 00:35（年份只在跨年时有意义，放 title 里） */
function fmtShort(iso) {
  if (!iso) return '';
  return String(iso).replace('T', ' ').slice(5, 16);
}

function setStatus(text, isError) {
  els.uploadStatus.textContent = text || '';
  els.uploadStatus.classList.toggle('error', !!isError);
}

/** 值展示：空值明确写"空"，避免空白让人以为丢了 */
function valHtml(v) {
  if (v === null || v === undefined || v === '') return '<span class="val-empty">空</span>';
  return esc(v);
}

/** 单元格列字母：G42 → G */
function cellLetter(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref || ''));
  return m ? m[1].toUpperCase() : '';
}

/* ---------- 版本线 ---------- */

async function loadLines(keepSelection) {
  const data = await api('/api/version-lines', undefined, { busyLabel: '查询版本线', busyBtn: els.refreshBtn });
  const items = data.items || [];
  state.lines = items;
  const prev = els.lineSelect.value;
  els.lineSelect.innerHTML = '';
  if (!items.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（暂无版本线，请先上传）';
    els.lineSelect.appendChild(opt);
    state.versionLineId = null;
    return;
  }
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.version_line_id;
    opt.textContent = `${it.file_name}（${fmtTime(it.updated_at)}）`;
    els.lineSelect.appendChild(opt);
  }
  const target = keepSelection && prev && items.some((i) => i.version_line_id === prev)
    ? prev
    : (state.versionLineId && items.some((i) => i.version_line_id === state.versionLineId) ? state.versionLineId : items[0].version_line_id);
  els.lineSelect.value = target;
  state.versionLineId = target;
}

/* ---------- 按行聚合 ---------- */

/** 这条变更的单元格属于哪一版快照（删除只存在于上一版） */
function sideOf(ch) {
  return ch.change_type === 'deleted' ? ch.prev_snapshot_id : ch.snapshot_id;
}

/**
 * 把单元格级变更收成"行"：
 * key = 该行所在快照 + 工作表 + 行号。用快照区分，避免"上一版第 42 行被删"
 * 和"本版第 42 行改了编码"被错并成同一条。
 */
function buildGroups(changes) {
  const map = new Map();
  for (const ch of changes) {
    const side = sideOf(ch) || '';
    const key = `${side}|${ch.sheet_name}|${ch.row_index}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        side,
        sheet: ch.sheet_name,
        rowIndex: ch.row_index,
        rowNumber: ch.row_index + 1,
        label: ch.row_label || '',
        cellCount: ch.row_cell_count || 0,
        changes: [],
        types: { added: 0, modified: 0, deleted: 0 },
      };
      map.set(key, g);
    }
    g.changes.push(ch);
    g.types[ch.change_type] = (g.types[ch.change_type] || 0) + 1;
    if (!g.label && ch.row_label) g.label = ch.row_label;
    if (!g.cellCount && ch.row_cell_count) g.cellCount = ch.row_cell_count;
  }
  return [...map.values()];
}

/** 类型徽章：只说"删除/修改/新增"，数字留给"具体变化"那一列，避免"删除 26"被读成删了 26 行 */
function groupBadges(g) {
  const out = [];
  if (g.types.deleted) out.push('<span class="type-tag deleted">删除</span>');
  if (g.types.modified) out.push('<span class="type-tag modified">修改</span>');
  if (g.types.added) out.push('<span class="type-tag added">新增</span>');
  return out.join(' ');
}

/** 截短长文本，用于一行内的"改前 → 改后" */
function brief(v, limit) {
  const max = limit || 18;
  if (v === null || v === undefined) return '（空）';
  const s = String(v).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!s) return '（空）';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** 某个类型涉及的列，最多列 4 个 */
function lettersOf(g, type) {
  const letters = g.changes.filter((c) => c.change_type === type).map((c) => cellLetter(c.cell_ref));
  const uniq = [...new Set(letters)];
  return uniq.slice(0, 4).join('、') + (uniq.length > 4 ? ` 等 ${uniq.length} 列` : '');
}

/** 一条修改怎么说人话：`G 列 06706 → 8765`；只有公式变时说"公式从…改成…" */
function changePhrase(ch) {
  const col = cellLetter(ch.cell_ref);
  if (isFormulaOnly(ch)) return `${col} 列 公式 ${brief(ch.old_formula, 14)} → ${brief(ch.new_formula, 14)}`;
  return `${col} 列 ${brief(ch.old_value)} → ${brief(ch.new_value)}`;
}

/**
 * 这一行到底发生了什么。用业务话讲，不出现"字段数/单元格变更/按行聚合"这类词：
 * 结论（整行删除/新增）优先，其次"改了哪几处、改成什么"。
 */
function groupSummary(g) {
  const { added, modified, deleted } = g.types;
  const isWhole = (n) => g.cellCount && n >= g.cellCount;

  if (deleted && isWhole(deleted)) return `整行被删除（共 ${deleted} 个字段）`;
  if (added && isWhole(added)) return `整行是新增的（共 ${added} 个字段）`;

  const parts = [];
  if (deleted) parts.push(`删掉 ${deleted} 个字段（${lettersOf(g, 'deleted')}）`);
  if (added) parts.push(`多了 ${added} 个字段（${lettersOf(g, 'added')}）`);
  if (modified) {
    const items = g.changes.filter((c) => c.change_type === 'modified');
    const shown = items.slice(0, 2).map(changePhrase).join('；');
    const more = items.length > 2 ? `　等 ${items.length} 处` : '';
    parts.push(`${items.length === 1 ? '' : `改了 ${items.length} 处：`}${shown}${more}`);
  }
  return parts.join('；');
}

/** 组内挑一个用于定位整行的变更：优先修改，其次新增，最后删除 */
function anchorChange(g) {
  return g.changes.find((c) => c.change_type === 'modified')
    || g.changes.find((c) => c.change_type === 'added')
    || g.changes[0];
}

/* ---------- 时间线 ---------- */

/** 公式行：值下面挂一行等宽小字；没有公式就不显示 */
function fxHtml(f) {
  if (!f) return '';
  return `<div class="fx-line" title="${esc(f)}">${esc(f)}</div>`;
}

/** 值相同、只有公式变了 —— 这种情况要在"类型"旁边标出来，否则看不出为什么算修改 */
function isFormulaOnly(ch) {
  if (ch.change_type !== 'modified') return false;
  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim());
  return norm(ch.old_value) === norm(ch.new_value)
    && (ch.old_formula || '') !== (ch.new_formula || '');
}

function changeRowHtml(ch) {
  const fxOnly = isFormulaOnly(ch);
  // 公式有差异就显示（尤其"值没变、只有公式变了"的时候，公式才是唯一线索）；
  // 公式完全相同的就不用重复显示两遍同样的东西。
  const showFx = (ch.old_formula || '') !== (ch.new_formula || '');
  return `
    <tr class="ct-${esc(ch.change_type)}">
      <td><span class="type-tag ${esc(ch.change_type)}">${TYPE_LABEL[ch.change_type] || esc(ch.change_type)}</span>${fxOnly ? '<span class="fx-tag">公式</span>' : ''}</td>
      <td class="col-cell">${esc(cellLetter(ch.cell_ref))} 列</td>
      <td title="${esc(ch.old_value)}">${valHtml(ch.old_value)}${showFx ? fxHtml(ch.old_formula) : ''}</td>
      <td title="${esc(ch.new_value)}">${valHtml(ch.new_value)}${showFx ? fxHtml(ch.new_formula) : ''}</td>
      <td>${ch.possible_shift ? '<span class="shift-flag">这条可能是插删行造成的错位，请核对</span>' : ''}</td>
    </tr>`;
}

function groupRowsHtml(g, opts) {
  const o = opts || {};
  const open = state.expandedGroups.has(g.key);
  const selected = state.activeKey === g.key;
  const toggleLabel = o.detail === false
    ? ''
    : `<button type="button" class="row-toggle" data-toggle="${esc(g.key)}">${open ? '收起' : `展开 ${g.changes.length}`}</button>`;
  const detail = o.detail === false ? '' : `
    <tr class="grp-detail ${open ? '' : 'hidden'}" data-detail="${esc(g.key)}">
      <td colspan="5">
        <table class="detail-table">
          <thead><tr><th>变化</th><th>哪一列</th><th>改之前</th><th>改之后</th><th></th></tr></thead>
          <tbody>${g.changes.map(changeRowHtml).join('')}</tbody>
        </table>
      </td>
    </tr>`;
  return `
    <tr class="grp-row ${selected ? 'selected' : ''}" data-group="${esc(g.key)}">
      <td class="col-type">${groupBadges(g)}</td>
      <td class="col-pos">第 ${g.rowNumber} 行${g.types.deleted && !g.types.added && !g.types.modified ? '<span class="pos-note">旧版</span>' : (g.types.added && !g.types.deleted && !g.types.modified ? '<span class="pos-note">新版</span>' : '')}</td>
      <td class="col-label" title="${esc(g.label)}">${g.label ? esc(g.label) : '<span class="val-empty">（这一行没有文本内容）</span>'}</td>
      <td class="col-sum">${esc(groupSummary(g))}</td>
      <td class="col-act">${toggleLabel}</td>
    </tr>${detail}`;
}

function renderTimeline() {
  if (!state.cards.length) {
    els.timeline.innerHTML = '<p class="hint">还没有上传过文件。请在第 1 步选择新版 Excel 并上传。</p>';
    return;
  }
  els.timeline.innerHTML = state.cards.map((card, idx) => {
    // upload_no 由接口给出；万一连的是旧版后端（没这个字段），按"最新在前"的次序自己推，
    // 不把 undefined 直接印到页面上。
    const uploadNo = card.upload_no || (state.cards.length - idx);
    const mine = state.changes.filter((c) => c.snapshot_id === card.snapshot_id);
    const rc = card.row_count || { added: 0, modified: 0, deleted: 0 };
    const cc = card.change_count || { added: 0, modified: 0, deleted: 0 };

    // 卡片只说"这一版比上一版动了什么"，明细留给第 4 步
    let headLine;
    if (card.is_baseline) {
      headLine = '<span class="card-delta plain">第一次上传，作为以后对比的底本</span>';
    } else if (!rc.added && !rc.modified && !rc.deleted) {
      headLine = '<span class="card-delta plain">和上一版一模一样，没有变化</span>';
    } else {
      const bits = [];
      if (rc.deleted) bits.push(`<span class="chip deleted">删了 ${rc.deleted} 行</span>`);
      if (rc.added) bits.push(`<span class="chip added">加了 ${rc.added} 行</span>`);
      if (rc.modified) bits.push(`<span class="chip modified">改了 ${rc.modified} 行</span>`);
      const cellTotal = cc.added + cc.modified + cc.deleted;
      headLine = `<span class="card-delta">比上一版：${bits.join('')}</span>`
        + `<span class="card-cells" title="单元格级的变更总数，仅作参考">涉及 ${cellTotal} 个单元格</span>`;
    }

    let bodyHtml;
    if (card.is_baseline) {
      bodyHtml = '<p class="hint">这是第一版，没有可对比的上一版。</p>';
    } else if (!mine.length) {
      bodyHtml = '<p class="hint">这一版在当前筛选条件下没有可显示的变更。</p>';
    } else {
      const groups = mine.slice().sort((a, b) => a.row_index - b.row_index);
      const built = buildGroups(groups);
      const shown = built.slice(0, 5);
      const more = built.length > shown.length
        ? `<p class="hint">还有 ${built.length - shown.length} 行变化，见下面第 4 步的完整清单。</p>`
        : '';
      bodyHtml = `<table class="changes-table compact"><tbody>${shown.map((g) => groupRowsHtml(g, { detail: false })).join('')}</tbody></table>${more}`;
    }
    return `
      <div class="card ${state.expandedCards.has(card.snapshot_id) ? 'open' : ''}" data-snapshot="${esc(card.snapshot_id)}">
        <div class="card-head">
          <span class="card-no">第 ${uploadNo} 次上传</span>
          <span class="card-time" title="${esc(fmtTime(card.uploaded_at))}">${esc(fmtShort(card.uploaded_at))}</span>
          ${headLine}
          <button type="button" class="card-delete" data-snapshot="${esc(card.snapshot_id)}" title="删除这一版的上传记录（不影响你的 Excel 文件）">删除这版</button>
        </div>
        <div class="card-body">${bodyHtml}</div>
      </div>`;
  }).join('');

  els.timeline.querySelectorAll('.card-head').forEach((head) => {
    head.addEventListener('click', () => {
      const snapshotId = head.parentElement.dataset.snapshot;
      if (state.expandedCards.has(snapshotId)) state.expandedCards.delete(snapshotId);
      else state.expandedCards.add(snapshotId);
      renderTimeline();
    });
  });

  els.timeline.querySelectorAll('.card-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // 不触发卡片展开/收起
      deleteVersionCard(btn);
    });
  });

  els.timeline.querySelectorAll('.card-body tr[data-group]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const g = state.allGroupsByKey ? state.allGroupsByKey.get(tr.dataset.group) : null;
      selectGroup(tr, g);
    });
  });
}

/** 删除单个版本节点：确认后调 DELETE /api/snapshots/{id}，成功后整页数据刷新（非浏览器整页刷新） */
async function deleteVersionCard(btn) {
  const snapshotId = btn.dataset.snapshot;
  const card = state.cards.find((c) => c.snapshot_id === snapshotId);
  if (!card) return;
  const ok = window.confirm(
    `删除版本「${card.file_name} ${fmtTime(card.uploaded_at)}」？该版本的变更记录与原始文件会一并删除，下一版本将重新比对。`
  );
  if (!ok) return;
  try {
    const result = await api(
      `/api/snapshots/${encodeURIComponent(snapshotId)}`,
      { method: 'DELETE' },
      { busyLabel: '删除版本', busyBtn: btn, busyRegion: els.timeline.closest('.panel') }
    );
    await refreshAll();
    if (result && result.version_line_removed) setStatus('删除成功，该版本线已删除');
    else setStatus('删除成功');
  } catch (e) {
    setStatus(e.message || '删除失败', true);
  }
}

async function loadTimeline() {
  if (!state.versionLineId) { state.cards = []; renderTimeline(); return; }
  const data = await api(
    `/api/timeline?version_line_id=${encodeURIComponent(state.versionLineId)}`,
    undefined,
    { busyLabel: '查询时间线', busyBtn: els.refreshBtn, busyRegion: els.timeline.closest('.panel') }
  );
  state.cards = data.cards || [];
  renderTimeline();
}

/* ---------- 变更列表（按行聚合 + 分页） ---------- */

/** 当前版本线对应的文件名（忽略规则按文件名存） */
function currentFileName() {
  const hit = (state.lines || []).find((l) => l.version_line_id === state.versionLineId);
  return hit ? hit.file_name : '';
}

let ignoreLoadedFor = null;

async function loadIgnoreRules(force) {
  const fileName = currentFileName();
  if (!fileName) {
    state.ignoredCount = 0;
    els.ignoreInput.value = '';
    els.ignoreSummary.textContent = '';
    return;
  }
  if (!force && ignoreLoadedFor === fileName) return;
  try {
    const data = await api(`/api/ignore-rules?file_name=${encodeURIComponent(fileName)}`);
    els.ignoreInput.value = (data.rules || []).join('\n');
    ignoreLoadedFor = fileName;
    updateIgnoreSummary(0);
  } catch (e) {
    els.ignoreStatus.textContent = `规则读取失败：${e.message}`;
  }
}

function updateIgnoreSummary(ignored) {
  const count = (els.ignoreInput.value.split('\n').filter((s) => s.trim())).length;
  const parts = [];
  if (count) parts.push(`${count} 条规则`);
  if (ignored) parts.push(`隐藏 ${ignored} 条`);
  els.ignoreSummary.textContent = parts.length ? `（${parts.join(' · ')}）` : '';
}

async function saveIgnoreRules() {
  const fileName = currentFileName();
  if (!fileName) { els.ignoreStatus.textContent = '先选一个版本线'; return; }
  const rules = els.ignoreInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    const data = await api('/api/ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName, rules }),
    });
    els.ignoreInput.value = (data.rules || []).join('\n');
    els.ignoreStatus.className = 'status';
    els.ignoreStatus.textContent = rules.length ? `已保存 ${data.rules.length} 条` : '规则已清空';
    await loadChanges();
  } catch (e) {
    els.ignoreStatus.className = 'status error';
    els.ignoreStatus.textContent = e.message;
  }
}

async function loadChanges() {
  if (!state.versionLineId) {
    state.changes = []; state.total = 0; state.groups = []; state.ignoredCount = 0;
    renderChangesTable(); renderTimeline();
    return;
  }
  await loadIgnoreRules(false);
  const q = new URLSearchParams({ version_line_id: state.versionLineId, page: '1', page_size: '5000' });
  if (els.dateFrom.value) q.set('date_from', els.dateFrom.value);
  if (els.dateTo.value) q.set('date_to', els.dateTo.value);
  if (els.sheet.value.trim()) q.set('sheet_name', els.sheet.value.trim());
  if (els.type.value) q.set('change_type', els.type.value);
  if (els.ignoreOff.checked) q.set('ignore', '0');
  const data = await api(`/api/changes?${q.toString()}`, undefined, {
    busyLabel: '查询变更',
    busyBtn: [els.applyBtn, els.resetBtn],
    busyRegion: els.changesBody.closest('.panel'),
  });
  state.changes = data.items || [];
  state.total = data.total || 0;
  state.ignoredCount = els.ignoreOff.checked ? 0 : (data.ignored_count || 0);
  updateIgnoreSummary(state.ignoredCount);
  state.truncated = state.total > state.changes.length;
  state.groups = buildGroups(state.changes);
  state.allGroupsByKey = new Map(state.groups.map((g) => [g.key, g]));
  const pages = Math.max(1, Math.ceil(state.groups.length / GROUP_PAGE_SIZE));
  if (state.groupPage > pages) state.groupPage = pages;
  renderChangesTable();
  renderTimeline();
}

function renderChangesTable() {
  const totalGroups = state.groups.length;
  const ignoredNote = state.ignoredCount ? `（已按忽略规则隐藏 ${state.ignoredCount} 条）` : '';
  if (!state.changes.length) {
    els.hitCount.textContent = state.ignoredCount ? `没有可显示的变化${ignoredNote}` : '';
  } else {
    const shownNote = state.truncated ? '（只取到前 5000 条，请用筛选缩小范围）' : '';
    els.hitCount.textContent = `共 ${totalGroups} 行有变化${ignoredNote}　·　涉及 ${state.total} 个字段${shownNote}`;
  }

  const pages = Math.max(1, Math.ceil(totalGroups / GROUP_PAGE_SIZE));
  const page = Math.min(state.groupPage, pages);
  const start = (page - 1) * GROUP_PAGE_SIZE;
  const shown = state.groups.slice(start, start + GROUP_PAGE_SIZE);

  els.changesBody.innerHTML = shown.map((g) => groupRowsHtml(g, { detail: true })).join('');
  els.changesEmpty.classList.toggle('hidden', totalGroups > 0);

  els.pager.classList.toggle('hidden', pages <= 1);
  els.pageInfo.textContent = `第 ${page} / ${pages} 页（共 ${totalGroups} 行）`;
  els.prevPage.disabled = page <= 1;
  els.nextPage.disabled = page >= pages;

  els.changesBody.querySelectorAll('tr[data-group]').forEach((tr) => {
    tr.addEventListener('click', () => selectGroup(tr, state.allGroupsByKey.get(tr.dataset.group)));
  });
  els.changesBody.querySelectorAll('button[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.toggle;
      if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
      else state.expandedGroups.add(key);
      renderChangesTable();
    });
  });
}

function selectGroup(tr, group) {
  if (!group) return;
  document.querySelectorAll('.changes-table tr.selected').forEach((x) => x.classList.remove('selected'));
  if (tr) tr.classList.add('selected');
  state.activeKey = group.key;
  showContext(group);
}

/* ---------- 整行对照面板 ---------- */

async function showContext(group) {
  if (!group) return;
  const ch = anchorChange(group);
  if (!ch) return;
  const selfId = sideOf(ch);          // 该行所在的快照
  const otherId = ch.change_type === 'deleted' ? ch.snapshot_id : ch.prev_snapshot_id;

  const q = new URLSearchParams({
    snapshot_id: selfId,
    sheet_name: ch.sheet_name,
    cell_ref: ch.cell_ref,
  });
  if (otherId && otherId !== selfId) q.set('other_snapshot_id', otherId);

  try {
    const data = await api(`/api/context?${q.toString()}`, undefined, {
      busyLabel: '读取整行',
      busyRegion: els.contextBody.closest('.panel'),
    });
    renderContext(group, data);
  } catch (e) {
    els.contextBody.innerHTML = `<p class="hint">整行读取失败：${esc(e.message)}</p>`;
  }
}

function renderContext(group, data) {
  const sides = data.sides || [];
  const prev = sides.find((s) => s.role === 'previous') || null;
  const curr = sides.find((s) => s.role === 'current') || null;

  const mapOf = (side, key) => {
    const m = new Map();
    for (const c of (side && side.cells) || []) m.set(c.col_index, c[key]);
    return m;
  };
  const pm = mapOf(prev, 'value');
  const cm = mapOf(curr, 'value');
  const pf = mapOf(prev, 'formula');
  const cf = mapOf(curr, 'formula');
  const columns = data.columns || [];

  let banner = '';
  if (curr && !curr.exists) {
    banner = '<div class="ctx-banner danger">这条记录在新版里没有了 → 整行被删除</div>';
  } else if (prev && !prev.exists) {
    banner = '<div class="ctx-banner success">这条记录在旧版里没有 → 是新加的</div>';
  } else if (!prev) {
    banner = '<div class="ctx-banner">这是第一版，没有可对比的旧版</div>';
  }

  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim());
  // 整个一侧都不存在（整行删除/新增）时，不给每个字段都刷黄底——横幅已经说明了，
  // 逐行高亮只会把 26 个字段全刷成黄的，反而看不出重点。
  const bothExist = !!(prev && prev.exists && curr && curr.exists);
  const rows = columns.map((col) => {
    const hasP = pm.has(col.col_index);
    const hasC = cm.has(col.col_index);
    const pv = hasP ? pm.get(col.col_index) : null;
    const cv = hasC ? cm.get(col.col_index) : null;
    const pfv = hasP ? pf.get(col.col_index) : null;
    const cfv = hasC ? cf.get(col.col_index) : null;
    // 值相同但公式变了也算变化（否则"只有公式被改"的格在整行里看不出高亮）
    const changed = bothExist && (hasP !== hasC || norm(pv) !== norm(cv) || norm(pfv) !== norm(cfv));
    return `
      <tr class="${changed ? 'ctx-diff' : ''}">
        <td class="ctx-col"><b>${esc(col.letter || '')}</b>${col.header ? `<span class="ctx-head-text" title="${esc(col.header)}">${esc(col.header)}</span>` : ''}</td>
        <td class="ctx-val">${hasP ? valHtml(pv) + fxHtml(pfv) : '<span class="val-empty">—</span>'}</td>
        <td class="ctx-val">${hasC ? valHtml(cv) + fxHtml(cfv) : '<span class="val-empty">—</span>'}</td>
      </tr>`;
  }).join('');

  const headOf = (side, fallback) => {
    if (!side) return `<span class="ctx-side">${fallback}</span>`;
    const when = fmtTime(side.uploaded_at);
    return `<span class="ctx-side ${side.role === 'current' ? 'curr' : 'prev'}">${side.role === 'current' ? '本版' : '上一版'} ${esc(when)}</span>`;
  };

  // 变了哪几格：直接列在表头上方，省得用户在整行里逐行找黄底
  const changeBits = (group.changes || []).map((c) => {
    const letter = cellLetter(c.cell_ref);
    if (c.change_type === 'modified') {
      const norm2 = (v) => (v === null || v === undefined ? '' : String(v).trim());
      if (norm2(c.old_value) === norm2(c.new_value) && (c.old_formula || c.new_formula)) {
        return `${letter} 列：公式 ${esc(c.old_formula || '（无）')} → ${esc(c.new_formula || '（无）')}`;
      }
      return `${letter} 列：${esc(c.old_value)} → ${esc(c.new_value)}`;
    }
    if (c.change_type === 'added') return `${letter} 列：新增 ${esc(c.new_value)}`;
    return `${letter} 列：删除 ${esc(c.old_value)}`;
  });
  const shownBits = changeBits.slice(0, 4);
  const moreBits = changeBits.length > shownBits.length ? `　等 ${changeBits.length} 处` : '';
  const summary = changeBits.length
    ? `<div class="ctx-changes"><b>改了什么</b>：${shownBits.join('；')}${moreBits}</div>`
    : '';

  els.contextBody.innerHTML = `
    <div class="ctx-title">
      第 ${group.rowNumber} 行 · ${group.label ? esc(group.label) : '<span class="val-empty">（这一行没有文字内容）</span>'}
    </div>
    <div class="ctx-sub">工作表「${esc(data.sheet_name || group.sheet)}」 · 这条记录有 ${columns.length} 个字段 · 黄色底就是改了的地方</div>
    ${summary}
    ${banner}
    <div class="ctx-sides">${headOf(prev, '（没有上一版）')}${headOf(curr, '（没有本版）')}</div>
    <div class="ctx-scroll">
      <table class="ctx-row-table">
        <thead><tr><th>字段</th><th>改之前</th><th>改之后</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // 变化字段常在行尾（如 K/L 列）：表格自动滚到第一处差异，标题与摘要保持可见
  const scroller = els.contextBody.querySelector('.ctx-scroll');
  const firstDiff = els.contextBody.querySelector('tr.ctx-diff');
  if (scroller && firstDiff) {
    requestAnimationFrame(() => {
      const delta = firstDiff.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 28);
    });
  }
}

/* ---------- 上传 ---------- */

async function doUpload() {
  const file = els.fileInput.files[0];
  if (!file) { setStatus('请先选择 .xlsx 文件', true); return; }
  const form = new FormData();
  form.append('file', file);
  try {
    const card = await api('/api/upload', { method: 'POST', body: form }, {
      busyLabel: '上传',
      busyBtn: els.uploadBtn,
      busyRegion: els.uploadBtn.closest('.panel'),
    });
    const cc = card.change_count || {};
    els.uploadCard.textContent =
      `${card.file_name}：${card.message}｜新增 ${cc.added}、修改 ${cc.modified}、删除 ${cc.deleted}` +
      (card.possible_shift_count ? `（位移疑似 ${card.possible_shift_count} 条）` : '');
    els.uploadCard.classList.remove('hidden');
    setStatus('上传成功');
    await loadLines(true);
    await loadTimeline();
    await loadChanges();
  } catch (e) {
    setStatus(e.message || '上传失败', true);
    els.uploadCard.classList.add('hidden');
  } finally {
    els.fileInput.value = '';
  }
}

async function refreshAll() {
  try {
    setStatus('');
    await loadLines(true);
    await loadTimeline();
    await loadChanges();
  } catch (e) {
    setStatus(e.message || '加载失败', true);
  }
}

/* ---------- 事件绑定 ---------- */

els.uploadBtn.addEventListener('click', doUpload);
els.refreshBtn.addEventListener('click', refreshAll);
els.lineSelect.addEventListener('change', async () => {
  state.versionLineId = els.lineSelect.value || null;
  state.expandedCards.clear();
  state.expandedGroups.clear();
  state.groupPage = 1;
  state.activeKey = null;
  await loadTimeline();
  await loadChanges();
});
els.applyBtn.addEventListener('click', () => {
  state.groupPage = 1;
  loadChanges().catch((e) => setStatus(e.message, true));
});
els.resetBtn.addEventListener('click', () => {
  els.dateFrom.value = '';
  els.dateTo.value = '';
  els.sheet.value = '';
  els.type.value = '';
  state.groupPage = 1;
  loadChanges().catch((e) => setStatus(e.message, true));
});
els.prevPage.addEventListener('click', () => {
  if (state.groupPage > 1) { state.groupPage -= 1; renderChangesTable(); }
});
els.nextPage.addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(state.groups.length / GROUP_PAGE_SIZE));
  if (state.groupPage < pages) { state.groupPage += 1; renderChangesTable(); }
});
els.ignoreSave.addEventListener('click', () => {
  saveIgnoreRules().catch((e) => setStatus(e.message, true));
});
els.ignoreClear.addEventListener('click', () => {
  els.ignoreInput.value = '';
  saveIgnoreRules().catch((e) => setStatus(e.message, true));
});
els.ignoreOff.addEventListener('change', () => {
  state.groupPage = 1;
  loadChanges().catch((e) => setStatus(e.message, true));
});

refreshAll();
checkServerVersion();
