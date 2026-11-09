/**
 * Tab Triage: popup and full-tab view (same page; "?view=tab" switches layout).
 *
 * Layout: Folder > Group > Tabs. Folders come from the outline in Settings;
 * unlisted sites land in Unsorted; blank/system/no-access tabs in Other.
 *
 * Flow: one tabs.query({}) snapshot -> TT.describeTab -> TT.buildTree -> render.
 * No polling. The snapshot refreshes only on Refresh, after a close, or after an undo.
 * Close, undo and go-to-tab run in background.js so they complete even if Safari
 * dismisses the popup mid-action.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const TT = globalThis.TT;
const IS_TAB_VIEW = new URLSearchParams(location.search).get('view') === 'tab';
const DEFAULT_SETTINGS = Object.freeze({ showPrivate: true, sort: 'path', nearGrouped: true, staleDays: 3 });
const UNDO_LABEL = '1 minute';
const ACCESS_HELP = 'Safari Settings > Extensions > Tab Triage > Edit Websites, then set other websites to Allow.';

/** All view state. Selections live here only; nothing about tabs is persisted by this page. */
const S = {
  raw: [],                    // last tabs.query snapshot (re-described when the outline changes, no re-query)
  records: [], byId: new Map(),
  folders: [], folderByKey: new Map(), groupByKey: new Map(),
  selected: new Set(),
  open: new Set(),            // expanded folders ("f:x") and groups ("f:x/y"); keys never collide
  filterClosed: new Set(),    // folders/groups the user collapsed while a filter is active
  tokens: [],
  settings: { ...DEFAULT_SETTINGS },
  outline: null,
  undo: { batches: [] },
  undoTimer: 0, toastTimer: 0,
  modalResolve: null, busy: false,
  banners: new Map(),
  selfPrefix: '',
  meter: { on: false, busy: false, usage: null, note: '', freed: '' } // Usage button; this page only
};
// Wait before re-measuring after a close so Safari has let go of the closed pages.
const FREED_DELAY_MS = typeof globalThis.TT_FREED_DELAY_MS === 'number' ? globalThis.TT_FREED_DELAY_MS : 4000;

const $ = (sel, root) => (root || document).querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Background messaging
// ---------------------------------------------------------------------------

async function send(msg) {
  let res;
  try { res = await api.runtime.sendMessage(msg); }
  catch (e) { throw new Error(`Background unavailable: ${(e && e.message) || e}`); }
  if (!res) throw new Error('No response from the background script. Reload the extension.');
  if (!res.ok) throw new Error(res.error || 'Background error.');
  return res;
}

// ---------------------------------------------------------------------------
// Snapshot and tree
// ---------------------------------------------------------------------------

async function refresh() {
  let tabs;
  try {
    tabs = await api.tabs.query({});
  } catch (e) {
    renderFatal(`Couldn't read Safari's tabs: ${(e && e.message) || e}`);
    return false;
  }
  const { ages } = await tabAges();
  S.raw = TT.applyAges(tabs, ages).filter((t) => !(typeof t.url === 'string' && S.selfPrefix && t.url.startsWith(S.selfPrefix)));
  describeAll();
  return true;
}

/** Tab Triage's own record of when each tab was last viewed or loaded (Safari doesn't give extensions one). */
async function tabAges() {
  try {
    const r = await send({ type: 'tabAges' });
    return { ages: r.ages || {}, since: typeof r.since === 'number' ? r.since : null };
  } catch (e) {
    return { ages: {}, since: null };
  }
}

/** Rebuild records from the current snapshot (also used when the outline changes). */
function describeAll() {
  const ctx = { outline: S.outline };
  S.records = S.raw.map((t) => TT.describeTab(t, ctx));
  S.byId = new Map(S.records.map((r) => [r.id, r]));
  for (const id of [...S.selected]) {
    const r = S.byId.get(id);
    if (!r || r.pinned) S.selected.delete(id);
  }
  regroup();
}

function regroup() {
  let recs = S.records;
  if (!S.settings.showPrivate) {
    recs = recs.filter((r) => !r.incognito);
    for (const r of S.records) if (r.incognito) S.selected.delete(r.id);
  }
  S.folders = TT.buildTree(recs, { sort: S.settings.sort, nearGrouped: S.settings.nearGrouped });
  S.folderByKey = new Map(S.folders.map((f) => [f.key, f]));
  S.groupByKey = new Map();
  for (const f of S.folders) for (const g of f.groups) S.groupByKey.set(g.key, g);
  updateAccessBanner();
  renderAll();
}

function matches(r) {
  for (const tok of S.tokens) if (!r.hay.includes(tok)) return false;
  return true;
}
/** Tabs in scope: filter matches when filtering, else all. */
function visibleOf(g) { return S.tokens.length ? g.tabs.filter(matches) : g.tabs; }
function refreshVisible(f) {
  f.visibleCount = 0;
  for (const g of f.groups) { g.visible = visibleOf(g); f.visibleCount += g.visible.length; }
}
function folderScope(f) {
  const out = [];
  for (const g of f.groups) for (const r of (g.visible || visibleOf(g))) out.push(r);
  return out;
}
function isOpen(key, visibleCount) {
  return S.tokens.length ? visibleCount > 0 && !S.filterClosed.has(key) : S.open.has(key);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  const list = $('#list');
  const filtering = S.tokens.length > 0;
  let matched = 0;
  for (const f of S.folders) { refreshVisible(f); matched += f.visibleCount; }

  let html = '';
  if (!S.records.length) {
    html = '<div class="empty">No open tabs.</div>';
  } else if (!S.folders.length) {
    html = '<div class="empty">Only private tabs are open. Turn Private on to see them.</div>';
  } else {
    if (filtering && matched === 0) html += '<div class="empty">No tabs match your search</div>';
    // While filtering, folders with matches float to the top (stable order otherwise).
    const ordered = filtering
      ? S.folders.slice().sort((a, b) => (b.visibleCount > 0) - (a.visibleCount > 0))
      : S.folders;
    for (const f of ordered) html += folderHTML(f);
  }

  const top = list.scrollTop;
  list.innerHTML = html;
  list.scrollTop = top;
  for (const sec of list.querySelectorAll('section.group')) syncGroupCheck(sec);
  for (const fsec of list.querySelectorAll('section.folder')) syncFolderCheck(fsec);
  renderStats(matched);
  renderFooter();
}

function folderHTML(f) {
  const filtering = S.tokens.length > 0;
  const open = isOpen(f.key, f.visibleCount);
  const dim = filtering && f.visibleCount === 0;
  const hidden = f.count - f.visibleCount;
  const count = filtering ? `${f.visibleCount}/${f.count}` : String(f.count);
  return `<section class="folder${open ? ' open' : ''}${dim ? ' dim' : ''}" data-fkey="${esc(f.key)}">`
    + '<div class="fhead">'
    + `<button class="chev" type="button" aria-expanded="${open}" aria-label="Show or hide ${esc(f.label)}"></button>`
    + `<input class="fcheck" type="checkbox" aria-label="Select all in ${esc(f.label)}">`
    + `<span class="flabel">${esc(f.label)}</span>`
    + `<span class="gcount">${count}</span>`
    + (f.dupExtra ? `<span class="pill dup">${f.dupExtra} dup</span>` : '')
    + (filtering && hidden ? `<span class="pill">${hidden} hidden</span>` : '')
    + `<button class="xclose fclose" type="button" aria-label="Close all in ${esc(f.label)}">&#x2715;</button>`
    + '</div>'
    + (open ? `<div class="fbody">${f.groups.map(groupHTML).join('')}</div>` : '')
    + '</section>';
}

function groupHTML(g) {
  const filtering = S.tokens.length > 0;
  const visible = g.visible || visibleOf(g);
  const open = isOpen(g.key, visible.length);
  const dim = filtering && visible.length === 0;
  const hidden = g.tabs.length - visible.length;
  const count = filtering ? `${visible.length}/${g.tabs.length}` : String(g.tabs.length);
  const rep = g.tabs.find((r) => r.fav) || g.tabs[0];
  return `<section class="group${open ? ' open' : ''}${dim ? ' dim' : ''}" data-key="${esc(g.key)}">`
    + '<div class="ghead">'
    + `<button class="chev" type="button" aria-expanded="${open}" aria-label="Show or hide ${esc(g.label)}"></button>`
    + `<input class="gcheck" type="checkbox" aria-label="Select all in ${esc(g.label)}">`
    + favHTML(rep ? rep.fav : '', g.label)
    + `<span class="glabel">${esc(g.label)}</span>`
    + `<span class="gcount">${count}</span>`
    + (g.dupExtra ? `<span class="pill dup">${g.dupExtra} dup</span>` : '')
    + (filtering && hidden ? `<span class="pill">${hidden} hidden</span>` : '')
    + `<button class="xclose gclose" type="button" aria-label="Close all in ${esc(g.label)}">&#x2715;</button>`
    + '</div>'
    + (open ? `<div class="rows">${visible.map(rowHTML).join('')}</div>` : '')
    + '</section>';
}

function rowHTML(r) {
  const sel = S.selected.has(r.id);
  const dup = r.dupCount > 1;
  let meta = '';
  if (r.incognito) meta += '<span class="pill priv">Private</span>';
  if (r.loading) meta += '<span class="ind spin" role="img" aria-label="Loading"></span>';
  if (r.audible && !r.muted) meta += '<span class="ind" role="img" aria-label="Playing audio">&#x1F50A;</span>';
  if (r.muted) meta += '<span class="ind" role="img" aria-label="Muted">&#x1F507;</span>';
  if (r.pinned) meta += '<span class="ind" role="img" aria-label="Pinned">&#x1F4CC;</span>';
  if (dup) meta += `<span class="pill dup">&times;${r.dupCount}</span>`;
  const age = TT.ago(r.lastAccessed);
  if (age) meta += `<span class="age">${age}</span>`;
  return `<label class="row${sel ? ' sel' : ''}${r.pinned ? ' pinned' : ''}${dup ? ' dup' : ''}" data-id="${r.id}"`
    + `${dup ? ` style="--c:${TT.hue(r.cluster)}"` : ''}>`
    + `<input class="rcheck" type="checkbox"${sel ? ' checked' : ''}${r.pinned ? ' disabled' : ''} aria-label="Select ${esc(r.title)}">`
    + favHTML(r.fav, r.label)
    + `<span class="txt"><span class="title">${esc(r.title)}</span><span class="url">${esc(r.displayUrl)}</span></span>`
    + (meta ? `<span class="meta">${meta}</span>` : '')
    + '<button class="goto" type="button" aria-label="Go to this tab">&#x2197;&#xfe0e;</button>'
    + '</label>';
}

/** Favicon if Safari provides one; otherwise a colored monogram. */
function favHTML(url, label) {
  const letter = esc((String(label || '?').trim().charAt(0) || '?').toUpperCase());
  const h = TT.hue(label);
  if (url) return `<img class="fav" src="${esc(url)}" alt="" loading="lazy" decoding="async" data-l="${letter}" style="--h:${h}">`;
  return `<span class="fav mono" style="--h:${h}" aria-hidden="true">${letter}</span>`;
}

function onImgError(e) {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.classList.contains('fav')) return;
  const span = document.createElement('span');
  span.className = 'fav mono';
  span.setAttribute('aria-hidden', 'true');
  span.style.cssText = img.style.cssText;
  span.textContent = img.dataset.l || '?';
  img.replaceWith(span);
}

/** Tri-state "select all" box, based on selectable (non-pinned) tabs in scope. */
function setTri(box, closeBtn, host, scope) {
  let n = 0;
  for (const r of scope) if (S.selected.has(r.id)) n++;
  box.disabled = scope.length === 0;
  box.checked = scope.length > 0 && n === scope.length;
  box.indeterminate = n > 0 && n < scope.length;
  host.classList.toggle('has-sel', n > 0);
  closeBtn.disabled = scope.length === 0;
}
function syncGroupCheck(sec) {
  const g = S.groupByKey.get(sec.dataset.key);
  if (!g) return;
  setTri($('.gcheck', sec), $('.gclose', sec), sec, (g.visible || visibleOf(g)).filter((r) => !r.pinned));
}
function syncFolderCheck(fsec) {
  const f = S.folderByKey.get(fsec.dataset.fkey);
  if (!f) return;
  setTri($('.fcheck', fsec), $('.fclose', fsec), fsec, folderScope(f).filter((r) => !r.pinned));
}

function replaceHTML(el, html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const next = tmp.firstElementChild;
  el.replaceWith(next);
  return next;
}
function rerenderGroup(sec) {
  const g = S.groupByKey.get(sec.dataset.key);
  if (!g) return;
  g.visible = visibleOf(g);
  const next = replaceHTML(sec, groupHTML(g));
  syncGroupCheck(next);
  const fsec = next.closest('section.folder');
  if (fsec) syncFolderCheck(fsec);
}
function rerenderFolder(fsec) {
  const f = S.folderByKey.get(fsec.dataset.fkey);
  if (!f) return;
  refreshVisible(f);
  const next = replaceHTML(fsec, folderHTML(f));
  for (const sec of next.querySelectorAll('section.group')) syncGroupCheck(sec);
  syncFolderCheck(next);
}

function renderStats(matched) {
  const n = S.folders.reduce((a, f) => a + f.count, 0);
  const dup = S.folders.reduce((a, f) => a + f.dupExtra, 0);
  $('#stats').textContent = S.tokens.length
    ? `${matched} of ${n} match`
    : `${plural(n, 'tab')} in ${plural(S.folders.length, 'folder')}${dup ? `, ${dup} duplicate${dup === 1 ? '' : 's'}` : ''}`;
}

function renderFooter() {
  const n = S.selected.size;
  $('#selcount').textContent = `${n} selected`;
  const btn = $('#btn-close');
  btn.disabled = n === 0 || S.busy;
  btn.textContent = n ? `Close ${n}` : 'Close';
  $('#btn-clear').disabled = n === 0;
}

function renderToggles() {
  const s = S.settings;
  setToggle('#tg-private', `Private: ${s.showPrivate ? 'On' : 'Off'}`, s.showPrivate);
  setToggle('#tg-sort', `Sort: ${s.sort === 'order' ? 'Order' : 'Path'}`, true);
  setToggle('#tg-near', `Near-dups: ${s.nearGrouped ? 'On' : 'Off'}`, s.nearGrouped);
  const days = $('#stale-days');
  if (days) days.value = String(TT.STALE_DAYS.includes(Number(s.staleDays)) ? Number(s.staleDays) : 3);
}
function setToggle(sel, text, on) {
  if (!$(sel)) return;
  const b = $(sel);
  b.textContent = text;
  b.setAttribute('aria-pressed', String(!!on));
}

function renderFatal(msg) {
  $('#list').innerHTML = `<div class="empty err">${esc(msg)}<br><button type="button" id="btn-retry">Retry</button></div>`;
  $('#btn-retry').addEventListener('click', () => refresh());
  $('#stats').textContent = '';
  renderFooter();
}

// Banners ---------------------------------------------------------------------

function setBanner(id, text, actionText, action) {
  S.banners.set(id, { text, actionText, action });
  renderBanners();
}
function clearBanner(id) { if (S.banners.delete(id)) renderBanners(); }
function renderBanners() {
  $('#banners').innerHTML = [...S.banners.values()].map((b) => '<div class="banner">'
    + `<span>${esc(b.text)}</span>`
    + (b.actionText ? `<button type="button" data-action="${esc(b.action)}">${esc(b.actionText)}</button>` : '')
    + '</div>').join('');
}
function updateAccessBanner() {
  const n = S.records.filter((r) => r.noAccess).length;
  if (n) setBanner('access', `Safari is hiding the address of ${plural(n, 'tab')}. Grant website access to sort them.`, 'Grant access', 'grant');
  else clearBanner('access');
  if (S.outline && S.outline.errors.length) {
    setBanner('outline', `Folder settings have ${plural(S.outline.errors.length, 'problem')}; those lines are ignored.`, 'Fix', 'settings');
  } else {
    clearBanner('outline');
  }
}
async function onBannerClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'grant') {
    try {
      const ok = await api.permissions.request({ origins: ['<all_urls>'] });
      if (ok) await refresh(); else toast(ACCESS_HELP, true);
    } catch (err) {
      toast(ACCESS_HELP, true);
    }
  } else if (action === 'settings') {
    openSettings();
  }
}

/** Status line above the footer. action: optional { label, run } shown as a link-style button. */
function toast(msg, isErr, action) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    el.append(' ', b);
  }
  el.classList.toggle('err', !!isErr);
  el.hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 7000 : action ? 8000 : 2500);
}

function setBusy(on) {
  S.busy = on;
  document.body.classList.toggle('busy', on);
  renderFooter();
}

// Usage meter -------------------------------------------------------------------
// Safari-wide numbers from the Tab Triage app. Measured only when asked (Usage button) and
// around a close while the meter is showing. Never per tab: Safari doesn't expose that.

async function fetchUsage(cpu) {
  try { return (await send({ type: 'usage', cpu })).usage; }
  catch (e) { S.meter.note = `Couldn't measure: ${e.message}`; renderMeter(); return null; }
}

async function measureUsage() {
  const m = S.meter;
  if (m.busy) return;
  m.on = true; m.busy = true; m.note = 'Measuring…'; m.freed = '';
  renderMeter();
  const u = await fetchUsage(true);
  m.busy = false;
  if (u) { m.usage = u; m.note = u.error || ''; }
  renderMeter();
}

function renderMeter() {
  const m = S.meter;
  const el = $('#meter');
  el.hidden = !m.on;
  $('#btn-usage').setAttribute('aria-pressed', String(m.on));
  if (!m.on) return;
  const line = TT.usageLine(m.usage);
  el.innerHTML = (line ? `<span class="m-line">${esc(line)}</span>` : '')
    + (m.freed ? `<span class="m-freed">${esc(m.freed)}</span>` : '')
    + (m.note ? `<span class="m-note">${esc(m.note)}</span>` : '');
  const s = m.usage && m.usage.safari;
  el.title = s
    ? `Safari's memory as Activity Monitor counts it, across ${s.processes} processes (${s.pages} page processes). `
      + 'CPU is percent of one core, summed. Safari-wide: Safari does not say which process is which tab.'
      + (s.shared ? ' On this macOS, Safari shares its web processes with other apps (Mail and others), so this includes them.' : '')
    : '';
}

/** While the meter is showing: memory before a close (or reload), then again a few seconds after. */
async function usageBeforeClose() {
  return S.meter.on && !S.meter.busy ? fetchUsage(false) : null;
}
function usageAfterClose(before, closed, verb) {
  if (!before || !closed) return;
  setTimeout(async () => {
    const after = await fetchUsage(false);
    if (!after) return;
    const cpu = S.meter.usage && S.meter.usage.safari ? S.meter.usage.safari.cpu : undefined;
    S.meter.usage = after;
    if (after.safari && typeof cpu === 'number') after.safari.cpu = cpu; // keep the last CPU reading
    S.meter.freed = TT.freedLine(before, after, closed, verb);
    S.meter.note = '';
    renderMeter();
  }, FREED_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function onListClick(e) {
  const go = e.target.closest('.goto');
  if (go) {
    e.preventDefault();
    e.stopPropagation();
    gotoTab(Number(go.closest('.row').dataset.id));
    return;
  }
  const fhead = e.target.closest('.fhead');
  if (fhead) {
    const fsec = fhead.parentElement;
    if (e.target.closest('.fclose')) { e.preventDefault(); closeFolder(fsec.dataset.fkey); return; }
    if (e.target.closest('.fcheck')) return; // handled in change
    toggleFolder(fsec);
    return;
  }
  const head = e.target.closest('.ghead');
  if (!head) return;
  const sec = head.parentElement;
  if (e.target.closest('.gclose')) { e.preventDefault(); closeGroup(sec.dataset.key); return; }
  if (e.target.closest('.gcheck')) return;
  toggleGroup(sec);
}

/**
 * Double-click a tab row: switch Safari to that tab and window (same as ↗).
 * The two clicks before it tick and untick the row, so the selection ends where it started.
 */
function onListDblClick(e) {
  const row = e.target.closest('.row');
  if (!row || e.target.closest('.goto, .rcheck')) return;
  e.preventDefault();
  const s = window.getSelection && window.getSelection();
  if (s && s.removeAllRanges) s.removeAllRanges();
  gotoTab(Number(row.dataset.id));
}

/** Flip open state for a folder/group key. Returns false if there is nothing to show. */
function flipOpen(key, visibleCount) {
  if (S.tokens.length) {
    if (!visibleCount) return false;
    if (S.filterClosed.has(key)) S.filterClosed.delete(key); else S.filterClosed.add(key);
  } else if (S.open.has(key)) {
    S.open.delete(key);
  } else {
    S.open.add(key);
  }
  return true;
}

function toggleFolder(fsec) {
  const f = S.folderByKey.get(fsec.dataset.fkey);
  if (!f) return;
  const wasOpen = isOpen(f.key, f.visibleCount);
  if (!flipOpen(f.key, f.visibleCount)) return;
  // A folder holding a single group opens straight to its tabs.
  if (!wasOpen && !S.tokens.length && f.groups.length === 1) S.open.add(f.groups[0].key);
  rerenderFolder(fsec);
}

function toggleGroup(sec) {
  const g = S.groupByKey.get(sec.dataset.key);
  if (!g) return;
  if (!flipOpen(g.key, (g.visible || visibleOf(g)).length)) return;
  rerenderGroup(sec);
}

function onListChange(e) {
  const t = e.target;
  if (t.classList.contains('rcheck')) {
    const row = t.closest('.row');
    const id = Number(row.dataset.id);
    const r = S.byId.get(id);
    if (!r || r.pinned) { t.checked = false; return; }
    if (t.checked) S.selected.add(id); else S.selected.delete(id);
    row.classList.toggle('sel', t.checked);
    syncGroupCheck(row.closest('section.group'));
    syncFolderCheck(row.closest('section.folder'));
    renderFooter();
  } else if (t.classList.contains('gcheck')) {
    const sec = t.closest('section.group');
    const g = S.groupByKey.get(sec.dataset.key);
    if (!g) return;
    toggleAll(visibleOf(g));
    rerenderGroup(sec);
    renderFooter();
  } else if (t.classList.contains('fcheck')) {
    const fsec = t.closest('section.folder');
    const f = S.folderByKey.get(fsec.dataset.fkey);
    if (!f) return;
    refreshVisible(f);
    toggleAll(folderScope(f));
    rerenderFolder(fsec);
    renderFooter();
  }
}

/** Select every selectable tab in scope, or clear them if all were already selected. */
function toggleAll(scope) {
  const sel = scope.filter((r) => !r.pinned);
  const allOn = sel.length > 0 && sel.every((r) => S.selected.has(r.id));
  for (const r of sel) { if (allOn) S.selected.delete(r.id); else S.selected.add(r.id); }
}

function setFilter(value) {
  const next = String(value || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (next.join(' ') === S.tokens.join(' ')) return;
  S.tokens = next;
  S.filterClosed.clear();
  $('#list').scrollTop = 0;
  renderAll();
}

/**
 * Select every exact duplicate except one per cluster (within visible scope), plus every blank tab.
 * Kept copy: a pinned one, else the active tab, else the most recently used, else the first.
 */
function selectDupes() {
  let added = 0;
  for (const f of S.folders) {
    for (const g of f.groups) {
      const clusters = new Map();
      for (const r of visibleOf(g)) {
        if (!clusters.has(r.exact)) clusters.set(r.exact, []);
        clusters.get(r.exact).push(r);
      }
      for (const list of clusters.values()) {
        const blank = list[0].exact === 'blank';
        if (list.length < 2 && !blank) continue;
        const keep = blank ? null : (list.find((r) => r.pinned) || list.find((r) => r.active)
          || list.slice().sort((a, b) => b.lastAccessed - a.lastAccessed)[0]);
        for (const r of list) {
          if (r === keep || r.pinned || S.selected.has(r.id)) continue;
          S.selected.add(r.id);
          added++;
          S.open.add(g.key);
          S.open.add(f.key);
        }
      }
    }
  }
  renderAll();
  toast(added ? `Selected ${plural(added, 'tab')} (duplicates and blanks).` : 'No duplicates or blank tabs to select.');
}

function closeSelected() {
  if (!S.selected.size || S.busy) return undefined;
  const hiddenN = S.tokens.length
    ? [...S.selected].filter((id) => { const r = S.byId.get(id); return r && !matches(r); }).length
    : 0;
  return requestClose([...S.selected], null, hiddenN);
}

function closeGroup(key) {
  const g = S.groupByKey.get(key);
  if (!g || S.busy) return undefined;
  const ids = visibleOf(g).filter((r) => !r.pinned).map((r) => r.id);
  return ids.length ? requestClose(ids, g.label, 0) : undefined;
}

function closeFolder(fkey) {
  const f = S.folderByKey.get(fkey);
  if (!f || S.busy) return undefined;
  refreshVisible(f);
  const ids = folderScope(f).filter((r) => !r.pinned).map((r) => r.id);
  return ids.length ? requestClose(ids, f.label, 0) : undefined;
}

async function requestClose(ids, scopeLabel, hiddenN) {
  const recs = ids.map((id) => S.byId.get(id)).filter((r) => r && !r.pinned);
  if (!recs.length) return;
  const n = recs.length;
  const groupsN = new Set(recs.map((r) => r.key)).size;
  const priv = recs.filter((r) => r.incognito).length;
  const nonWeb = recs.filter((r) => !r.incognito && !r.restorable).length;
  const msg = scopeLabel
    ? `Close ${plural(n, 'tab')} in ${scopeLabel}?`
    : `Close ${plural(n, 'tab')} across ${plural(groupsN, 'group')}?`;
  const notes = [];
  if (hiddenN) notes.push(`${hiddenN} of them ${hiddenN === 1 ? 'is' : 'are'} hidden by the current filter.`);
  if (priv) notes.push(`${plural(priv, 'private tab')} can't be restored.`);
  if (nonWeb) notes.push(`${plural(nonWeb, 'non-web tab')} can't be restored.`);
  if (n - priv - nonWeb > 0) notes.push(`Undo is available for ${UNDO_LABEL}.`);

  if (!(await confirmModal(msg, notes.join(' '), `Close ${n}`))) return;

  setBusy(true);
  const before = await usageBeforeClose();
  let res;
  try {
    res = await send({ type: 'close', tabs: recs.map((r) => ({ id: r.id, key: r.key })) });
  } catch (e) {
    setBusy(false);
    toast(e.message, true);
    return;
  }
  for (const r of recs) S.selected.delete(r.id);
  await refresh();
  $('#list').scrollTop = 0;
  setBusy(false);
  if (res.failed) toast(`${plural(res.failed, 'tab')} couldn't be closed.`, true);
  usageAfterClose(before, res.closed);
  await loadUndo();
}

function confirmModal(message, note, okText) {
  if (S.modalResolve) S.modalResolve(false);
  $('#modal-msg').textContent = message;
  $('#modal-note').textContent = note || '';
  $('#modal-ok').textContent = okText;
  $('#modal').hidden = false;
  $('#modal-ok').focus();
  return new Promise((resolve) => { S.modalResolve = resolve; });
}
function resolveModal(ok) {
  const r = S.modalResolve;
  S.modalResolve = null;
  $('#modal').hidden = true;
  if (r) r(ok);
}

// Undo ------------------------------------------------------------------------

async function loadUndo() {
  let st;
  try { st = await send({ type: 'undoState' }); } catch (e) { return; }
  S.undo = { batches: st.batches || [] };
  renderUndo();
}

function renderUndo() {
  clearInterval(S.undoTimer);
  const el = $('#undo');
  const b = S.undo.batches;
  if (!b.length) { el.hidden = true; el.innerHTML = ''; return; }
  const latest = b[b.length - 1];
  el.hidden = false;
  el.innerHTML = `<span>Closed ${plural(latest.count, 'tab')}${b.length > 1 ? ` <em>+${b.length - 1} earlier</em>` : ''}</span>`
    + '<button type="button" class="link" id="btn-undo">Undo</button><span class="t"></span>';
  const t = $('.t', el);
  const tick = () => {
    const ms = latest.expiresAt - Date.now();
    if (ms <= 0) { clearInterval(S.undoTimer); loadUndo(); return; }
    const s = Math.ceil(ms / 1000);
    t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  S.undoTimer = setInterval(tick, 1000);
}

async function doUndo() {
  if (S.busy || !S.undo.batches.length) return;
  setBusy(true);
  let res;
  try {
    res = await send({ type: 'undo' });
  } catch (e) {
    setBusy(false);
    toast(e.message, true);
    return;
  }
  await refresh();
  setBusy(false);
  toast(res.failed
    ? `Restored ${res.restored}, ${res.failed} failed to reopen.`
    : `Restored ${plural(res.restored, 'tab')}.`, !!res.failed);
  await loadUndo();
}

// Other actions -----------------------------------------------------------------

async function gotoTab(id) {
  try {
    await send({ type: 'goto', id });
  } catch (e) {
    toast(`Couldn't switch to that tab (it may be closed). Press R to refresh.`, true);
    return;
  }
  if (!IS_TAB_VIEW) window.close();
}

async function openTabView() {
  const base = api.runtime.getURL('popup.html');
  try {
    const tabs = await api.tabs.query({});
    const existing = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(base));
    if (existing) {
      await api.tabs.update(existing.id, { active: true });
      await api.windows.update(existing.windowId, { focused: true });
    } else {
      await api.tabs.create({ url: `${base}?view=tab` });
    }
  } catch (e) {
    toast(`Couldn't open the tab view: ${(e && e.message) || e}`, true);
    return;
  }
  if (!IS_TAB_VIEW) window.close();
}

/** Save every open, non-private tab as a session named SafariSession_MMDD-HH:MM. */
async function saveSession() {
  const btn = $('#btn-session');
  btn.disabled = true;
  try {
    const { session: s } = await send({ type: 'saveSession' });
    const notes = [];
    if (s.private) notes.push(`${plural(s.private, 'private tab')} not saved`);
    if (s.skipped) notes.push(`${plural(s.skipped, 'blank or hidden tab')} skipped`);
    toast(`Saved ${s.name}: ${plural(s.tabs, 'tab')} from ${plural(s.windows, 'window')}`
      + (s.pinned ? `, ${s.pinned} pinned` : '') + (notes.length ? `. ${notes.join(', ')}.` : '.'),
      false, { label: 'View sessions', run: openSessions });
  } catch (e) {
    toast(`Couldn't save the session: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// Memory relief ---------------------------------------------------------------
// Long-open Safari tabs keep growing (1-1.5 GB each is common) and only a reload or close gives the
// memory back. Both actions run in background.js so they finish even if this popup goes away.

const daysText = (d) => `${d}+ day${d === 1 ? '' : 's'}`;

/** Every tab Safari reports right now, minus Tab Triage's own pages. */
async function liveTabs() {
  const tabs = await api.tabs.query({});
  return tabs.filter((t) => !(typeof t.url === 'string' && S.selfPrefix && t.url.startsWith(S.selfPrefix)));
}

/** Refresh stale: reload tabs unused for the chosen number of days, ~300 ms apart. */
async function refreshStale() {
  if (S.busy) return;
  let tabs;
  try { tabs = await liveTabs(); } catch (e) { toast(`Couldn't read Safari's tabs: ${e.message}`, true); return; }
  const { ages, since } = await tabAges();
  const now = Date.now();
  const st = TT.staleTabs(TT.applyAges(tabs, ages), S.settings.staleDays, now);
  if (!st.known) {
    toast("Couldn't tell when tabs were last used (Tab Triage's record isn't available). Try again in a moment.", true);
    return;
  }
  const skips = [];
  if (st.skipped.active) skips.push(plural(st.skipped.active, 'active tab'));
  if (st.skipped.pinned) skips.push(`${st.skipped.pinned} pinned`);
  if (st.skipped.audible) skips.push(`${st.skipped.audible} playing audio`);
  if (!st.ids.length) {
    // Only when the ages are Tab Triage's own record (Safari gave none): say from when tabs can be stale.
    const ownRecord = !tabs.some((t) => typeof t.lastAccessed === 'number' && t.lastAccessed > 0);
    const ready = ownRecord && since ? since + st.days * 86400000 : 0;
    toast(ready > now
      ? `No tabs unused for ${daysText(st.days)} yet. Tab Triage started counting ${TT.whenText(since)}; tabs can count as stale from ${TT.whenText(ready)}.`
      : `No tabs unused for ${daysText(st.days)}` + (skips.length ? ` (skipped ${skips.join(', ')}).` : '.'));
    return;
  }
  const n = st.ids.length;
  const note = 'Unsaved form text will be lost.' + (skips.length ? ` Skipped: ${skips.join(', ')}.` : '');
  if (!(await confirmModal(`Reload ${plural(n, 'tab')} open ${daysText(st.days)}?`, note, `Reload ${n}`))) return;

  setBusy(true);
  const before = await usageBeforeClose();
  toast(`Reloading ${plural(n, 'tab')}…`);
  let res;
  try {
    res = await send({ type: 'reloadTabs', ids: st.ids });
  } catch (e) {
    setBusy(false);
    toast(`Refresh stale stopped: ${e.message}`, true);
    return;
  }
  setBusy(false);
  const extra = [];
  if (res.failed) extra.push(`${res.failed} failed`);
  if (res.skipped) extra.push(`${res.skipped} skipped (closed or now in use)`);
  toast(`Reloaded ${plural(res.reloaded, 'tab')}` + (extra.length ? `; ${extra.join(', ')}.` : '.'), !!res.failed);
  usageAfterClose(before, res.reloaded, 'reloading');
  await refresh();
}

/** Reset tabs: save a session, close every non-pinned tab, reopen the session. Safari keeps running. */
async function resetTabs() {
  if (S.busy) return;
  let tabs;
  try { tabs = await liveTabs(); } catch (e) { toast(`Couldn't read Safari's tabs: ${e.message}`, true); return; }
  const closing = tabs.filter((t) => !t.pinned);
  if (!closing.length) { toast('Nothing to reset: only pinned tabs are open.'); return; }
  const pinned = tabs.length - closing.length;
  const priv = closing.filter((t) => t.incognito).length;
  const web = closing.filter((t) => !t.incognito && /^https?:\/\//i.test(t.url || '')).length;
  const gone = closing.length - priv - web; // blank tabs, Safari pages, hidden addresses
  const n = closing.length;
  const notes = ['Your tabs are saved as a session first.'];
  if (pinned) notes.push('Pinned tabs stay open.');
  if (priv) notes.push(`${plural(priv, 'private tab')} will close and can't be restored.`);
  if (gone) notes.push(`${plural(gone, 'blank or Safari page')} won't come back.`);
  notes.push('Unsaved form text will be lost.');
  const msg = `Reset ${plural(n, 'tab')}? They close and reopen fresh, which frees the memory they've built up.`;
  if (!(await confirmModal(msg, notes.join(' '), `Reset ${n}`))) return;

  setBusy(true);
  toast(`Resetting ${plural(n, 'tab')}…`);
  let res;
  try {
    res = await send({ type: 'resetTabs' });
  } catch (e) {
    setBusy(false);
    toast(`Reset didn't run: ${e.message}`, true);
    return;
  }
  // Usually this page is gone by now (closing the active tab dismisses the popup); the next one shows it.
  setBusy(false);
  showResetResult(res);
  await refresh();
}

/** One line on how the last Reset went. Shown once: here, or by the next popup. */
function showResetResult(r) {
  if (!r) return;
  api.storage.local.set({ lastReset: null }).catch(() => {});
  const extra = r.closeFailed ? ` ${plural(r.closeFailed, 'tab')} couldn't be closed.` : '';
  if (!r.kept) {
    toast(`Reset done: closed ${plural(r.closed, 'tab')} and reopened ${r.restored}`
      + (r.skipped ? ` (${r.skipped} pinned stayed open)` : '') + `.${extra}`);
    return;
  }
  const why = r.error ? `couldn't reopen your tabs (${r.error})` : `reopened ${r.restored}, ${r.failed} failed to open`;
  toast(`Reset closed ${plural(r.closed, 'tab')} but ${why}. They're saved as ${r.name} in Sessions.${extra}`,
    true, { label: 'View sessions', run: openSessions });
}

/** A Reset that finished after its popup closed: report it once, if it's recent. */
async function checkLastReset() {
  try {
    const { lastReset: r } = await api.storage.local.get('lastReset');
    if (r && typeof r.at === 'number' && Date.now() - r.at < 30 * 60 * 1000) showResetResult(r);
    else if (r) api.storage.local.set({ lastReset: null }).catch(() => {});
  } catch (e) {
    // Storage unavailable: nothing to report.
  }
}

/** Saved sessions page, in a tab (reuses one if it's already open). */
async function openSessions() {
  const url = api.runtime.getURL('sessions.html');
  try {
    const tabs = await api.tabs.query({});
    const existing = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(url));
    if (existing) {
      await api.tabs.update(existing.id, { active: true });
      await api.windows.update(existing.windowId, { focused: true });
    } else {
      await api.tabs.create({ url });
    }
  } catch (e) {
    toast(`Couldn't open saved sessions: ${(e && e.message) || e}`, true);
    return;
  }
  if (!IS_TAB_VIEW) window.close();
}

async function openSettings() {
  try {
    await api.runtime.openOptionsPage();
  } catch (e) {
    try { await api.tabs.create({ url: api.runtime.getURL('options.html') }); } catch (e2) {
      toast(`Couldn't open settings: ${(e2 && e2.message) || e2}`, true);
      return;
    }
  }
  if (!IS_TAB_VIEW) window.close();
}

function toggleSetting(k) {
  S.settings[k] = !S.settings[k];
  saveSettings();
}
function saveSettings() {
  renderToggles();
  regroup();
  api.storage.local.set({ settings: S.settings }).catch(() => {});
}

function setOutline(text) {
  S.outline = TT.compileOutline(typeof text === 'string' ? text : TT.DEFAULT_OUTLINE);
}

/** Folders edited in Settings: re-describe the existing snapshot (no Safari query). */
function onStorageChanged(changes, area) {
  if (area !== 'local' || !changes.outline) return;
  setOutline(changes.outline.newValue);
  describeAll();
}

function onKey(e) {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); resolveModal(false); }
    else if (e.key === 'Enter') { e.preventDefault(); resolveModal(true); }
    return;
  }
  const q = $('#q');
  const inSearch = e.target === q;
  const searchEmpty = !q.value;
  if (e.key === '/' && !inSearch) { e.preventDefault(); q.focus(); q.select(); return; }
  if (e.key === 'Escape' && S.tokens.length) { e.preventDefault(); q.value = ''; setFilter(''); return; }
  if (e.metaKey && (e.key === 'Backspace' || e.key === 'Delete') && (!inSearch || searchEmpty)) {
    e.preventDefault(); closeSelected(); return;
  }
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'z' && (!inSearch || searchEmpty)) {
    e.preventDefault(); doUndo(); return;
  }
  if (!inSearch && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'r') refresh();
}

function bindEvents() {
  const list = $('#list');
  list.addEventListener('click', onListClick);
  list.addEventListener('dblclick', onListDblClick);
  list.addEventListener('change', onListChange);
  list.addEventListener('error', onImgError, true);
  $('#q').addEventListener('input', (e) => setFilter(e.target.value));
  $('#btn-refresh').addEventListener('click', () => refresh());
  $('#btn-dupes').addEventListener('click', selectDupes);
  $('#btn-usage').addEventListener('click', measureUsage);
  $('#btn-session').addEventListener('click', saveSession);
  $('#btn-stale').addEventListener('click', refreshStale);
  $('#btn-reset').addEventListener('click', resetTabs);
  $('#stale-days').addEventListener('change', (e) => {
    S.settings.staleDays = Number(e.target.value) || 3;
    api.storage.local.set({ settings: S.settings }).catch(() => {});
  });
  $('#btn-tabview').addEventListener('click', openTabView);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-clear').addEventListener('click', () => { S.selected.clear(); renderAll(); });
  $('#btn-close').addEventListener('click', closeSelected);
  $('#tg-private').addEventListener('click', () => toggleSetting('showPrivate'));
  $('#tg-near').addEventListener('click', () => toggleSetting('nearGrouped'));
  $('#tg-sort').addEventListener('click', () => {
    S.settings.sort = S.settings.sort === 'order' ? 'path' : 'order';
    saveSettings();
  });
  $('#undo').addEventListener('click', (e) => { if (e.target.closest('#btn-undo')) doUndo(); });
  $('#banners').addEventListener('click', onBannerClick);
  $('#modal-ok').addEventListener('click', () => resolveModal(true));
  $('#modal-cancel').addEventListener('click', () => resolveModal(false));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') resolveModal(false); });
  document.addEventListener('keydown', onKey);
  if (api.storage && api.storage.onChanged) api.storage.onChanged.addListener(onStorageChanged);
}

async function init() {
  if (!api || !api.tabs || !TT) {
    document.body.innerHTML = '<p class="empty err">Tab Triage has to run as a Safari extension.</p>';
    return;
  }
  if (IS_TAB_VIEW) {
    document.body.classList.add('tabview');
    $('#btn-tabview').hidden = true;
  }
  S.selfPrefix = api.runtime.getURL('');
  bindEvents();
  let outlineText;
  try {
    const st = await api.storage.local.get(['settings', 'outline']);
    S.settings = { ...DEFAULT_SETTINGS, ...(st.settings && typeof st.settings === 'object' ? st.settings : {}) };
    outlineText = st.outline;
  } catch (e) {
    // Storage unavailable: defaults.
  }
  setOutline(outlineText);
  renderToggles();
  await refresh();
  $('#q').focus();
  loadUndo();
  checkLastReset();
}

init();
