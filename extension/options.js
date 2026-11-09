/**
 * Tab Triage settings: the folder organizer (⚙ in the popup, or Safari Settings > Extensions > Tab Triage > Settings).
 * Folders on the left, the selected folder's groups and sites in the middle, open sites no folder covers on the right.
 * Drag to sort. Every change saves at once as the same outline text (storage.local.outline) that
 * "Edit as text" shows, so open Tab Triage views update live. Undo keeps this page's last 50 changes.
 *
 * Privacy: open tabs are read when the page opens (and when it regains focus), kept in memory only,
 * and private tabs are skipped. The only thing written is the outline, holding only sites you place.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const TT = globalThis.TT;
const org = TT && TT.org;
const $ = (s) => document.querySelector(s);
const HISTORY_MAX = 50;

const U = {
  model: { folders: [] },
  sel: 0,              // selected folder index
  saved: null,         // outline text as last loaded or written
  written: new Set(),  // texts this page wrote (so our own storage echoes are ignored)
  history: [],         // outline texts before each change, for Undo
  urls: [],            // open, non-private http(s) tab URLs (memory only)
  tabsErr: '',
  counts: new Map(),   // "<folder lower>\n<site>" -> open tabs that site covers
  unsorted: [],        // [{ site, label, n }] open sites no folder covers
  drag: null,          // what is being dragged
  editing: null,       // { kind: 'folder' | 'group', f, i, draft } rename in progress
  refocus: null,       // selector to focus after the next render
  text: false          // "Edit as text" showing
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Build an element. Strings become text, never HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const elOf = (t) => (t && t.nodeType === 1 ? t : t && t.parentElement) || null;
const isTyping = (t) => !!(t && t.closest && t.closest('input, textarea, select'));
const folderAt = (fi) => U.model.folders[fi];
const itemAt = (fi, i) => (folderAt(fi) ? folderAt(fi).items[i] : undefined);
const sitesOf = (it) => (it.kind === 'group' ? it.sites : [it.site]);
const openCount = (f, s) => U.counts.get(f.name.toLowerCase() + '\n' + s) || 0;
const outlineNow = () => TT.modelToOutline(U.model);

function status(msg, isErr) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

function clampSel() {
  const n = U.model.folders.length;
  if (U.sel >= n) U.sel = n - 1;
  if (U.sel < 0 && n) U.sel = 0;
}

// ---------------------------------------------------------------------------
// Load, save, undo
// ---------------------------------------------------------------------------

function useOutline(text) {
  const m = TT.outlineToModel(text);
  U.model = { folders: m.folders };
  U.saved = text;
  clampSel();
  return m.errors;
}

async function persist(text) {
  U.saved = text;
  U.written.add(text);
  if (U.written.size > 30) U.written = new Set([text]);
  try {
    await api.storage.local.set({ outline: text });
    return true;
  } catch (e) {
    status(`Couldn't save: ${(e && e.message) || e}`, true);
    return false;
  }
}

function remember(text) {
  U.history.push(text);
  if (U.history.length > HISTORY_MAX) U.history.shift();
}

/** One change: fn edits U.model (return false to cancel). Saves, records Undo, redraws. */
function change(fn, msg) {
  const before = outlineNow();
  const r = fn(U.model);
  if (r === false) { U.model = { folders: TT.outlineToModel(before).folders }; render(); return false; }
  const after = outlineNow();
  if (after === before) { render(); return false; }
  remember(U.saved != null ? U.saved : before);
  persist(after);
  status(msg || 'Saved.');
  render();
  return true;
}

function undo() {
  const prev = U.history.pop();
  if (prev == null) { status('Nothing to undo.'); return; }
  useOutline(prev);
  U.editing = null;
  persist(prev);
  status('Undone.');
  render();
}

function restoreDefaults() {
  if (U.saved === TT.DEFAULT_OUTLINE) { status('Already using the default folders.'); return; }
  remember(U.saved != null ? U.saved : outlineNow());
  useOutline(TT.DEFAULT_OUTLINE);
  U.editing = null;
  persist(TT.DEFAULT_OUTLINE);
  status('Default folders restored. Undo brings yours back.');
  render();
}

async function load() {
  let text = TT.DEFAULT_OUTLINE;
  try {
    const st = await api.storage.local.get('outline');
    if (typeof st.outline === 'string') text = st.outline;
  } catch (e) {
    status(`Couldn't load settings: ${(e && e.message) || e}`, true);
  }
  const errors = useOutline(text);
  await refreshTabs(false);
  render();
  if (errors.length) openText(`Some lines can't be read, so the organizer would drop them. Fix them here first. ${errors.slice(0, 2).join(' ')}`);
}

let lastRefresh = 0;
/** Open tabs, read once per visit (no polling). Private tabs are skipped and nothing is stored. */
async function refreshTabs(redraw) {
  lastRefresh = Date.now();
  try {
    const tabs = await api.tabs.query({});
    U.urls = tabs.filter((t) => !t.incognito && typeof t.url === 'string' && /^https?:\/\//i.test(t.url)).map((t) => t.url);
    U.tabsErr = '';
  } catch (e) {
    U.urls = [];
    U.tabsErr = (e && e.message) || String(e);
  }
  if (redraw !== false && !U.text && !isTyping(document.activeElement)) render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Which open tabs each site covers, and the open sites no folder covers (Unsorted). */
function tally() {
  const comp = TT.compileOutline(outlineNow());
  const counts = new Map();
  const loose = new Map();
  for (const url of U.urls) {
    let u;
    try { u = new URL(url); } catch (e) { continue; }
    const d = TT.domainGroup(u.hostname);
    const m = TT.classify(url, d.host, comp.matchers);
    if (m) {
      const k = m.folder.toLowerCase() + '\n' + m.value;
      counts.set(k, (counts.get(k) || 0) + 1);
      continue;
    }
    const site = TT.siteForHost(u.hostname);
    if (!site) continue;
    const e = loose.get(site) || { site, label: TT.siteLabel(site), n: 0 };
    e.n++;
    loose.set(site, e);
  }
  U.counts = counts;
  U.unsorted = [...loose.values()].sort((a, b) => (b.n - a.n) || a.label.localeCompare(b.label) || a.site.localeCompare(b.site));
}

let rendering = false;

function render() {
  if (U.text || rendering) return;
  rendering = true;  // some engines fire focusout while a focused box is being replaced; ignore those
  try {
    clampSel();
    tally();
    renderSide();
    renderPane();
    renderTray();
    $('#undo').disabled = !U.history.length;
    const inp = document.querySelector('input.rename');
    if (inp) { inp.focus(); inp.select(); }
    else if (U.refocus) { const el = document.querySelector(U.refocus); if (el) el.focus(); }
    U.refocus = null;
  } finally {
    rendering = false;
  }
}

function renameInput(value, label) {
  const v = U.editing && U.editing.draft != null ? U.editing.draft : value;
  return h('input', { class: 'rename', type: 'text', value: v, maxlength: '60', 'aria-label': label, spellcheck: 'false', autocomplete: 'off' });
}

function mono(site) {
  const label = TT.siteLabel(site);
  return h('span', { class: 'mono', style: `--h:${TT.hue(site)}`, 'aria-hidden': 'true', text: (label.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase() });
}

/** "Move to…" menu. from: { fi, i, group } for a group, { fi, i, site } for a single site, { site } for an Unsorted site. */
function moveSelect(from) {
  const sel = h('select', {
    class: 'moveto', 'aria-label': 'Move to', title: 'Move to another folder or group',
    'data-fi': from.fi != null ? from.fi : '', 'data-i': from.i != null ? from.i : '', 'data-site': from.site || ''
  }, h('option', { value: '', text: 'Move to…' }));
  U.model.folders.forEach((f, fj) => {
    if (from.group) { if (fj !== from.fi) sel.append(h('option', { value: `f:${fj}`, text: f.name })); return; }
    const og = h('optgroup', { label: f.name }, h('option', { value: `f:${fj}`, text: `${f.name} (own group)` }));
    f.items.forEach((it, gj) => { if (it.kind === 'group') og.append(h('option', { value: `g:${fj}:${gj}`, text: `${f.name} › ${it.name}` })); });
    sel.append(og);
  });
  if (from.fi != null) sel.append(h('option', { value: 'unsorted', text: from.group ? 'Unsorted (delete group)' : 'Unsorted (take out)' }));
  return sel;
}

function renderSide() {
  const box = $('#folders');
  box.textContent = '';
  U.model.folders.forEach((f, fi) => {
    const open = f.items.reduce((a, it) => a + sitesOf(it).reduce((b, s) => b + openCount(f, s), 0), 0);
    box.append(h('div', {
      class: 'frow' + (fi === U.sel ? ' sel' : ''), 'data-f': fi, 'data-drag': 'folder', 'data-drop': 'folder',
      draggable: 'true', tabindex: '0', role: 'button', 'aria-current': fi === U.sel ? 'true' : null,
      title: 'Click to open, double-click to rename. Drag to reorder, or drop sites here.'
    },
      h('span', { class: 'ficon', 'aria-hidden': 'true' }),
      h('span', { class: 'fname', text: f.name }),
      open ? h('span', { class: 'fcount', text: String(open), title: plural(open, 'open tab') }) : null));
  });
}

const slot = (j) => h('div', { class: 'slot', 'data-drop': 'slot', 'data-slot': j, 'aria-hidden': 'true' });

function chip(f, s) {
  const n = openCount(f, s);
  return h('span', {
    class: 'chip', 'data-site': s, 'data-drag': 'chip', draggable: 'true',
    title: TT.siteLabel(s) + (n ? ` · ${plural(n, 'open tab')}` : '') + '. Drag to move.'
  },
    h('span', { class: 'ctext', text: s }),
    n ? h('span', { class: 'cn', text: String(n) }) : null,
    h('button', { type: 'button', class: 'cx', 'data-act': 'remove-site', 'data-site': s, 'aria-label': `Remove ${s}`, title: 'Remove (back to Unsorted)', text: '×' }));
}

function groupCard(f, fi, it, i) {
  const ed = U.editing;
  const editing = ed && ed.kind === 'group' && ed.f === fi && ed.i === i;
  const open = it.sites.reduce((a, s) => a + openCount(f, s), 0);
  return h('div', { class: 'card', 'data-i': i, 'data-drag': 'item', 'data-drop': 'group', draggable: 'true' },
    h('div', { class: 'chead' },
      h('span', { class: 'grip', 'aria-hidden': 'true', title: 'Drag to reorder' }),
      editing ? renameInput(it.name, 'Group name') : h('span', { class: 'gname', 'data-act': 'rename-group', title: 'Click to rename', text: it.name }),
      h('span', { class: 'meta', text: plural(it.sites.length, 'site') + (open ? ` · ${open} open` : '') }),
      h('span', { class: 'spacer' }),
      moveSelect({ fi, i, group: true }),
      h('button', { type: 'button', class: 'x', 'data-act': 'remove-item', 'aria-label': `Delete group ${it.name}`, title: 'Delete group (its sites go back to Unsorted)', text: '×' })),
    h('div', { class: 'chips' },
      it.sites.map((s) => chip(f, s)),
      it.sites.length ? null : h('span', { class: 'chint', text: 'Drag sites here, or type one' }),
      h('input', { type: 'text', class: 'addsite small', 'data-add': 'group', 'data-i': i, placeholder: '+ add site', 'aria-label': `Add sites to ${it.name}`, spellcheck: 'false', autocomplete: 'off' })));
}

function siteRow(f, fi, it, i) {
  const n = openCount(f, it.site);
  const label = TT.siteLabel(it.site);
  return h('div', { class: 'item', 'data-i': i, 'data-drag': 'item', 'data-drop': 'site', draggable: 'true', title: 'Drag to reorder, into a group, or onto another site to group them' },
    h('span', { class: 'grip', 'aria-hidden': 'true' }),
    mono(it.site),
    h('span', { class: 'slabel', text: label }),
    label !== it.site ? h('span', { class: 'sval', text: it.site }) : null,
    n ? h('span', { class: 'meta', text: `${n} open` }) : null,
    h('span', { class: 'spacer' }),
    moveSelect({ fi, i, site: it.site }),
    h('button', { type: 'button', class: 'x', 'data-act': 'remove-item', 'aria-label': `Remove ${it.site}`, title: 'Remove (back to Unsorted)', text: '×' }));
}

function renderPane() {
  const pane = $('#pane');
  pane.textContent = '';
  const fi = U.sel;
  const f = folderAt(fi);
  if (!f) {
    pane.append(h('p', { class: 'empty', text: 'No folders yet. Click + New folder, then drag sites into it.' }));
    return;
  }
  const ed = U.editing;
  const editing = ed && ed.kind === 'folder' && ed.f === fi;
  const nSites = f.items.reduce((a, it) => a + sitesOf(it).length, 0);
  pane.append(h('div', { class: 'phead' },
    editing ? renameInput(f.name, 'Folder name') : h('h2', { class: 'pname', 'data-act': 'rename-folder', title: 'Click to rename', text: f.name }),
    h('span', { class: 'meta', text: plural(nSites, 'site') }),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'act', 'data-act': 'rename-folder', text: 'Rename' }),
    h('button', { type: 'button', class: 'act danger', 'data-act': 'delete-folder', text: 'Delete folder' })));

  const list = h('div', { class: 'items' });
  f.items.forEach((it, i) => {
    list.append(slot(i));
    list.append(it.kind === 'group' ? groupCard(f, fi, it, i) : siteRow(f, fi, it, i));
  });
  if (f.items.length) list.append(slot(f.items.length));
  else list.append(h('p', { class: 'empty', 'data-drop': 'slot', 'data-slot': 0, text: 'Empty folder. Drag sites here from Unsorted, or add them below.' }));
  pane.append(list);

  pane.append(h('div', { class: 'newgroup', 'data-drop': 'newgroup', text: 'Drop a site here to start a new group' }));
  pane.append(h('div', { class: 'pfoot' },
    h('button', { type: 'button', class: 'add', 'data-act': 'add-group', text: '+ New group' }),
    h('input', { type: 'text', class: 'addsite', 'data-add': 'folder', placeholder: 'Add sites: keh.com, facebook.com/marketplace', 'aria-label': `Add sites to ${f.name}`, spellcheck: 'false', autocomplete: 'off' }),
    h('button', { type: 'button', 'data-act': 'add-sites', text: 'Add' })));
}

function renderTray() {
  const tray = $('#tray');
  tray.textContent = '';
  const n = U.unsorted.length;
  tray.append(h('div', { class: 'colhead', title: 'Drop here to take a site out of your folders' },
    h('span', { text: 'Unsorted' }), n ? h('span', { class: 'fcount', text: String(n) }) : null));
  tray.append(h('p', { class: 'hint', text: n ? 'Open now and in no folder. Drag onto a folder, a group, or a site.' : 'Every open site is in a folder.' }));
  if (U.tabsErr) tray.append(h('p', { class: 'hint err', text: `Couldn't read open tabs: ${U.tabsErr}` }));
  const list = h('div', { class: 'ulist' });
  for (const u of U.unsorted) {
    list.append(h('div', { class: 'item usite', 'data-site': u.site, 'data-drag': 'unsorted', draggable: 'true', title: `${u.site} · ${plural(u.n, 'open tab')}` },
      mono(u.site),
      h('span', { class: 'uname' },
        h('span', { class: 'slabel', text: u.label }),
        u.label !== u.site ? h('span', { class: 'sval', text: u.site }) : null),
      h('span', { class: 'meta', text: String(u.n) }),
      moveSelect({ site: u.site })));
  }
  tray.append(list);
  tray.append(h('p', { class: 'hint small', text: 'Drop a site or group here to take it out of your folders. Private tabs are never listed.' }));
}

// ---------------------------------------------------------------------------
// Actions (clicks, menus, typing)
// ---------------------------------------------------------------------------

const nameOf = (it) => (it.kind === 'group' ? it.name : it.site);

function selectFolder(fi) {
  if (fi === U.sel && !U.editing) return;
  U.sel = fi;
  U.editing = null;
  render();
}

function startRename(kind, f, i) {
  U.editing = { kind, f, i, draft: null };
  render();
}

function commitRename(value) {
  const ed = U.editing;
  if (!ed) return;
  U.editing = null;
  if (ed.kind === 'folder') {
    const f = folderAt(ed.f);
    const name = TT.cleanFolderName(value);
    if (!f || !name || name === f.name) { render(); return; }
    if (U.model.folders.some((x, j) => j !== ed.f && x.name.toLowerCase() === name.toLowerCase())) {
      U.editing = { ...ed, draft: value };
      status(`There's already a folder called ${name}.`, true);
      render();
      return;
    }
    change((m) => org.renameFolder(m, ed.f, name), `Renamed folder to ${name}.`);
  } else {
    const it = itemAt(ed.f, ed.i);
    const name = TT.cleanGroupName(value);
    if (!it || it.kind !== 'group' || !name || name === it.name) { render(); return; }
    change((m) => org.renameGroup(m, ed.f, ed.i, name), `Renamed group to ${name}.`);
  }
}

/** Add typed sites to folder fi: into the group at index gi, or each as its own group. */
function addSites(raw, fi, gi) {
  const parts = String(raw || '').split(/[,\s]+/).filter(Boolean);
  const f = folderAt(fi);
  if (!parts.length || !f) return false;
  const bad = parts.find((p) => { const s = TT.normSite(p); return !s || s.invalid; });
  if (bad) { status(`"${bad}" isn't a site. Use a domain like keh.com or a URL piece like facebook.com/marketplace.`, true); return false; }
  const g = gi != null ? itemAt(fi, gi) : null;
  const where = g ? `${f.name} › ${g.name}` : f.name;
  const what = parts.length === 1 ? TT.normSite(parts[0]).value : plural(parts.length, 'site');
  U.refocus = g ? `input.addsite[data-add="group"][data-i="${gi}"]` : 'input.addsite[data-add="folder"]';
  return change((m) => {
    for (const p of parts) org.placeSite(m, p, fi, g ? m.folders[fi].items.indexOf(g) : null);
  }, `Added ${what} to ${where}.`);
}

/** "Move to…" choice: f:<folder>, g:<folder>:<group>, or unsorted. */
function moveTo(v, from) {
  if (v === 'unsorted') {
    const it = itemAt(from.fi, from.i);
    if (!it) return false;
    return change((m) => org.removeItem(m, from.fi, from.i),
      it.kind === 'group' ? `Deleted group ${it.name}. Its sites are back in Unsorted.` : `Moved ${it.site} to Unsorted.`);
  }
  const [kind, a, b] = v.split(':');
  const fj = Number(a);
  const dest = folderAt(fj);
  if (!dest) return false;
  if (!from.site) {
    const it = itemAt(from.fi, from.i);
    if (!it) return false;
    return change((m) => org.moveItem(m, from.fi, from.i, fj), `Moved ${it.name} to ${dest.name}.`);
  }
  const gj = kind === 'g' ? Number(b) : null;
  const where = gj != null && dest.items[gj] ? `${dest.name} › ${dest.items[gj].name}` : dest.name;
  return change((m) => org.placeSite(m, from.site, fj, gj), `${from.fi == null ? 'Added' : 'Moved'} ${from.site} to ${where}.`);
}

function doAct(act, el) {
  const fi = U.sel;
  const f = folderAt(fi);
  const card = el.closest('[data-i]');
  const i = card ? Number(card.dataset.i) : null;
  switch (act) {
    case 'rename-folder': if (f) startRename('folder', fi); break;
    case 'delete-folder':
      if (!f) break;
      change((m) => { org.removeFolder(m, fi); U.sel = Math.min(fi, m.folders.length - 1); },
        `Deleted folder ${f.name}. Its sites are back in Unsorted. Undo brings it back.`);
      break;
    case 'rename-group': if (i != null) startRename('group', fi, i); break;
    case 'remove-item': {
      const it = itemAt(fi, i);
      if (it) change((m) => org.removeItem(m, fi, i), it.kind === 'group' ? `Deleted group ${it.name}. Its sites are back in Unsorted.` : `Removed ${it.site}.`);
      break;
    }
    case 'remove-site': {
      const s = el.dataset.site;
      change((m) => org.takeSite(m, s), `Removed ${s}.`);
      break;
    }
    case 'add-group':
      if (f) change((m) => { U.editing = { kind: 'group', f: fi, i: org.addGroup(m, fi), draft: null }; }, 'New group. Type a name, then drag sites into it.');
      break;
    case 'add-sites': {
      const inp = document.querySelector('input.addsite[data-add="folder"]');
      if (inp) addSites(inp.value, fi, null);
      break;
    }
    default: break;
  }
}

function addFolder() {
  change((m) => {
    const fi = org.addFolder(m, 'New folder');
    U.sel = fi;
    U.editing = { kind: 'folder', f: fi, draft: null };
  }, 'New folder. Type a name.');
}

document.addEventListener('click', (e) => {
  const t = elOf(e.target);
  if (!t || U.text) return;
  const act = t.closest('[data-act]');
  if (act) { doAct(act.dataset.act, act); return; }
  const row = t.closest('.frow');
  if (row) selectFolder(Number(row.dataset.f));
});

document.addEventListener('dblclick', (e) => {
  const t = elOf(e.target);
  const row = t && t.closest('.frow');
  if (row && !U.text) { U.sel = Number(row.dataset.f); startRename('folder', U.sel); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t.matches || !t.matches('select.moveto') || !t.value) return;
  moveTo(t.value, {
    fi: t.dataset.fi === '' ? null : Number(t.dataset.fi),
    i: t.dataset.i === '' ? null : Number(t.dataset.i),
    site: t.dataset.site || null
  });
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches && t.matches('input.rename') && U.editing) U.editing.draft = t.value;
});

document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!rendering && t.matches && t.matches('input.rename')) commitRename(t.value);
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.matches && t.matches('input.rename')) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(t.value); }
    else if (e.key === 'Escape') { e.preventDefault(); U.editing = null; render(); }
    return;
  }
  if (t.matches && t.matches('input.addsite') && e.key === 'Enter') {
    e.preventDefault();
    addSites(t.value, U.sel, t.dataset.add === 'group' ? Number(t.dataset.i) : null);
    return;
  }
  if (t.matches && t.matches('.frow') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    selectFolder(Number(t.dataset.f));
    return;
  }
  if (U.text) {
    if (e.metaKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveText(); }
    return;
  }
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTyping(t)) { e.preventDefault(); undo(); }
});

// ---------------------------------------------------------------------------
// Drag and drop
//   Drag: folder rows, groups and single sites (in the folder pane), site chips, Unsorted sites.
//   Drop: a folder row (into that folder), a group (into it), a single site (group the two),
//   the gaps between rows (reorder / place there), "new group", Unsorted (take out).
//   Links dragged in from a web page can be dropped on folders and groups too.
// ---------------------------------------------------------------------------

const DRAG_CLASSES = ['dragging', 'drag-folder', 'drag-item', 'drag-chip', 'drag-unsorted'];
const spring = { f: -1, timer: 0 };

function payloadFrom(el) {
  const kind = el.dataset.drag;
  if (kind === 'folder') return folderAt(Number(el.dataset.f)) ? { kind, f: Number(el.dataset.f) } : null;
  if (kind === 'item') {
    const i = Number(el.dataset.i);
    const it = itemAt(U.sel, i);
    return it ? { kind, f: U.sel, i, group: it.kind === 'group', site: it.kind === 'site' ? it.site : null } : null;
  }
  if (kind === 'chip' || kind === 'unsorted') return el.dataset.site ? { kind, site: el.dataset.site } : null;
  return null;
}

/** A drag from outside the page (a link). Its URL is only readable on drop. */
function externalPayload(e) {
  const types = e.dataTransfer && e.dataTransfer.types ? [...e.dataTransfer.types] : [];
  return types.includes('text/uri-list') || types.includes('text/plain') ? { kind: 'link', site: '(link)' } : null;
}

function siteFromDropped(dt) {
  if (!dt) return null;
  const raw = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (/^https?:$/.test(u.protocol)) return TT.siteForHost(u.hostname) || null;
  } catch (e) { /* not a URL: maybe a bare domain */ }
  const s = TT.normSite(raw);
  return s && !s.invalid && s.type === 'domain' && (s.value.includes('.') || s.value === 'localhost') ? s.value : null;
}

function targetOf(e) {
  const el = elOf(e.target);
  const t = el && el.closest('[data-drop]');
  if (!t) return null;
  const kind = t.dataset.drop;
  if (kind === 'folder') return { kind, el: t, f: Number(t.dataset.f) };
  if (kind === 'group' || kind === 'site') return { kind, el: t, i: Number(t.dataset.i) };
  if (kind === 'slot') return { kind, el: t, j: Number(t.dataset.slot) };
  return { kind, el: t };
}

function accepts(p, t) {
  if (!p || !t) return false;
  const site = p.site;
  switch (t.kind) {
    case 'folder':
      if (p.kind === 'folder') return p.f !== t.f;
      if (p.kind === 'item') return p.f !== t.f;
      return !!site;
    case 'group': {
      const g = itemAt(U.sel, t.i);
      if (!g || p.kind === 'folder') return false;
      if (p.kind === 'item') return p.i !== t.i;           // a group takes its place; a site goes in
      return !!site && !g.sites.includes(site);
    }
    case 'site': {
      const s = itemAt(U.sel, t.i);
      if (!s || p.kind === 'folder') return false;
      if (p.kind === 'item') return p.i !== t.i;           // a group takes its place; a site groups with it
      return !!site && s.site !== site;
    }
    case 'slot':
      if (p.kind === 'folder' || !folderAt(U.sel)) return false;
      if (p.kind === 'item') return t.j !== p.i && t.j !== p.i + 1;
      return !!site;
    case 'newgroup': return !!site && p.kind !== 'folder' && !!folderAt(U.sel);
    case 'unsorted': return p.kind === 'item' || p.kind === 'chip';
    default: return false;
  }
}

function clearOver() { document.querySelectorAll('.over').forEach((el) => el.classList.remove('over')); }

function stopSpring() { clearTimeout(spring.timer); spring.f = -1; }

function endDrag() {
  U.drag = null;
  stopSpring();
  document.body.classList.remove(...DRAG_CLASSES);
  document.querySelectorAll('.over, .lifting').forEach((el) => el.classList.remove('over', 'lifting'));
}

function dropOn(p, t) {
  const fi = U.sel;
  const f = folderAt(fi);
  const verb = p.kind === 'unsorted' || p.kind === 'link' ? 'Added' : 'Moved';
  const takesPlace = (i, j) => (i < j ? j + 1 : j);  // drop on a row: land where it was
  switch (t.kind) {
    case 'folder': {
      const dest = folderAt(t.f);
      if (p.kind === 'folder') {
        const moving = folderAt(p.f);
        return change((m) => { org.moveFolder(m, p.f, takesPlace(p.f, t.f)); U.sel = m.folders.indexOf(f); }, `Moved folder ${moving.name}.`);
      }
      if (p.kind === 'item') {
        const it = itemAt(p.f, p.i);
        return change((m) => org.moveItem(m, p.f, p.i, t.f), `Moved ${nameOf(it)} to ${dest.name}.`);
      }
      return change((m) => org.placeSite(m, p.site, t.f, null), `${verb} ${p.site} to ${dest.name}.`);
    }
    case 'group': {
      const g = itemAt(fi, t.i);
      if (p.kind === 'item' && p.group) return change((m) => org.moveItem(m, fi, p.i, fi, takesPlace(p.i, t.i)), `Moved ${itemAt(fi, p.i).name}.`);
      return change((m) => org.placeSite(m, p.site, fi, t.i), `${verb} ${p.site} to ${f.name} › ${g.name}.`);
    }
    case 'site': {
      const target = itemAt(fi, t.i);
      if (p.kind === 'item' && p.group) return change((m) => org.moveItem(m, fi, p.i, fi, takesPlace(p.i, t.i)), `Moved ${itemAt(fi, p.i).name}.`);
      return change((m) => org.groupWith(m, p.site, fi, t.i), `Grouped ${p.site} with ${target.site}. Click the group name to rename it.`);
    }
    case 'slot':
      if (p.kind === 'item') return change((m) => org.moveItem(m, fi, p.i, fi, t.j), `Moved ${nameOf(itemAt(fi, p.i))}.`);
      return change((m) => org.placeSiteAt(m, p.site, fi, t.j), `${verb} ${p.site} to ${f.name}.`);
    case 'newgroup':
      return change((m) => {
        const gi = org.newGroupWith(m, p.site, fi);
        if (gi >= 0) U.editing = { kind: 'group', f: fi, i: gi, draft: null };
      }, `New group with ${p.site}. Type a name.`);
    case 'unsorted': {
      if (p.kind === 'chip') return change((m) => org.takeSite(m, p.site), `Moved ${p.site} to Unsorted.`);
      const it = itemAt(p.f, p.i);
      return change((m) => org.removeItem(m, p.f, p.i),
        it.kind === 'group' ? `Deleted group ${it.name}. Its sites are back in Unsorted.` : `Moved ${it.site} to Unsorted.`);
    }
    default: return false;
  }
}

/** Form controls inside draggable rows stay usable: no drag starts from them. */
document.addEventListener('mousedown', (e) => {
  const t = elOf(e.target);
  if (!t) return;
  const allow = !t.closest('input, select, textarea, button');
  for (let n = t.closest('[data-drag]'); n; n = n.parentElement && n.parentElement.closest('[data-drag]')) n.draggable = allow;
}, true);

document.addEventListener('dragstart', (e) => {
  const t = elOf(e.target);
  const el = t && t.closest('[data-drag]');
  const p = el && !U.text ? payloadFrom(el) : null;
  if (!p) return;
  U.drag = p;
  el.classList.add('lifting');
  const dt = e.dataTransfer;
  if (dt) {
    dt.effectAllowed = 'move';
    const label = p.site || (p.kind === 'folder' ? folderAt(p.f).name : itemAt(p.f, p.i).name);
    try { dt.setData('text/plain', label); } catch (err) { /* some drags refuse data; the payload lives in U.drag */ }
  }
  // Changing layout inside dragstart can cancel the drag in WebKit, so the gaps open a tick later.
  setTimeout(() => { if (U.drag === p) document.body.classList.add('dragging', 'drag-' + p.kind); }, 0);
});

function onDragOver(e) {
  if (U.text) return;
  const p = U.drag || externalPayload(e);
  const t = targetOf(e);
  if (!accepts(p, t)) { clearOver(); stopSpring(); return; }
  e.preventDefault();
  if (U.drag && e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (!t.el.classList.contains('over')) { clearOver(); t.el.classList.add('over'); }
  // Hovering a folder with an Unsorted site opens it, so you can drop straight into one of its groups.
  if (t.kind === 'folder' && p.kind === 'unsorted' && t.f !== U.sel) {
    if (spring.f !== t.f) {
      stopSpring();
      spring.f = t.f;
      spring.timer = setTimeout(() => {
        if (!U.drag || spring.f < 0) return;
        U.sel = spring.f;
        renderSide();
        renderPane();
      }, 700);
    }
  } else if (t.kind !== 'folder') {
    stopSpring();
  }
}
document.addEventListener('dragenter', onDragOver);
document.addEventListener('dragover', onDragOver);

document.addEventListener('dragleave', (e) => {
  const el = elOf(e.target);
  if (el && el.classList.contains('over') && !(e.relatedTarget && el.contains(e.relatedTarget))) el.classList.remove('over');
});

document.addEventListener('drop', (e) => {
  if (U.text) return;
  const p = U.drag || externalPayload(e);
  const t = targetOf(e);
  endDrag();
  if (!accepts(p, t)) return;
  e.preventDefault();
  if (p.kind === 'link') {
    const site = siteFromDropped(e.dataTransfer);
    if (!site) { status("That isn't a web address Tab Triage can file.", true); return; }
    p.site = site;
    if (!accepts(p, t)) return;
  }
  dropOn(p, t);
});

document.addEventListener('dragend', endDrag);

// ---------------------------------------------------------------------------
// Edit as text (the V1.1 outline editor, kept for bulk edits)
// ---------------------------------------------------------------------------

const ta = $('#outline');
let checkTimer = 0;

function setMode(text) {
  U.text = text;
  U.editing = null;
  $('#org').hidden = text;
  $('#textmode').hidden = !text;
  for (const id of ['#undo', '#astext', '#restore']) $(id).hidden = text;
}

function checkText() {
  const p = TT.parseOutline(ta.value);
  if (p.errors.length) {
    status(p.errors.slice(0, 3).join(' ') + (p.errors.length > 3 ? ` (+${p.errors.length - 3} more)` : ''), true);
    return p;
  }
  const groups = p.folders.reduce((a, f) => a + f.entries.reduce((b, e) => b + (e.group ? 1 : e.sites.length), 0), 0);
  const sites = p.folders.reduce((a, f) => a + f.entries.reduce((b, e) => b + e.sites.length, 0), 0);
  status(`${plural(p.folders.length, 'folder')}, ${plural(groups, 'group')}, ${plural(sites, 'site')}.`);
  return p;
}

function openText(msg) {
  setMode(true);
  ta.value = U.saved != null ? U.saved : outlineNow();
  checkText();
  if (msg) status(msg, true);
  ta.focus();
}

let discardArmed = false;

/** Back to the organizer. Unsaved text edits need a second click, so they're never dropped silently. */
function closeText() {
  if (ta.value !== U.saved && !discardArmed) {
    discardArmed = true;
    status('You have unsaved text edits. Save them, or click Back again to discard them.', true);
    return;
  }
  discardArmed = false;
  setMode(false);
  const bad = U.saved != null ? TT.parseOutline(U.saved).errors.length : 0;
  status(bad ? `Heads up: ${plural(bad, 'unreadable line')} will be dropped at your next change here.` : '', !!bad);
  render();
}

async function saveText() {
  const p = checkText();
  if (p.errors.length) { status('Not saved. ' + $('#status').textContent, true); return; }
  const text = ta.value;
  if (text === U.saved) { status('No changes to save.'); return; }
  remember(U.saved != null ? U.saved : outlineNow());
  useOutline(text);
  discardArmed = false;
  if (await persist(text)) status('Saved. Open Tab Triage views update automatically.');
}

ta.addEventListener('input', () => { discardArmed = false; clearTimeout(checkTimer); checkTimer = setTimeout(checkText, 250); });
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = ta;
    ta.value = value.slice(0, a) + '  ' + value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + 2;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('#undo').addEventListener('click', undo);
$('#astext').addEventListener('click', () => openText());
$('#back').addEventListener('click', closeText);
$('#save').addEventListener('click', saveText);
$('#restore').addEventListener('click', restoreDefaults);
$('#addfolder').addEventListener('click', addFolder);
$('#sessions').addEventListener('click', async () => {
  const url = api.runtime.getURL('sessions.html');
  try {
    const open = (await api.tabs.query({})).find((t) => typeof t.url === 'string' && t.url.startsWith(url));
    if (open) { await api.tabs.update(open.id, { active: true }); await api.windows.update(open.windowId, { focused: true }); }
    else await api.tabs.create({ url });
  } catch (e) {
    status(`Couldn't open Sessions: ${(e && e.message) || e}`, true);
  }
});

window.addEventListener('focus', () => { if (!U.text && Date.now() - lastRefresh > 1000) refreshTabs(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !U.text && Date.now() - lastRefresh > 1000) refreshTabs();
});

if (api && api.storage && api.storage.onChanged) {
  // Another settings tab (or a text save) changed the outline: follow it, unless it's our own write echoing back.
  api.storage.onChanged.addListener((ch, area) => {
    if (area && area !== 'local') return;
    const v = ch && ch.outline && ch.outline.newValue;
    if (typeof v !== 'string' || v === U.saved || U.written.has(v) || U.text) return;
    useOutline(v);
    U.editing = null;
    status('Updated from another Tab Triage window.');
    render();
  });
}

if (api && api.storage && api.tabs && TT) load();
else status('Open this page from Safari Settings > Extensions > Tab Triage.', true);
