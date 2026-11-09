/**
 * Tab Triage: saved sessions. Opened from "View sessions" after Save session in the popup,
 * or from Sessions on the Folders page. Reads storage.local.sessions; every change goes
 * through background.js, so one place writes it.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (s) => document.querySelector(s);
const CONFIRM_MS = 4000;

const V = {
  sessions: [],
  open: new Set(),    // expanded session ids
  confirm: '',        // "<id>:all" or "<id>:del" armed for a second click
  confirmTimer: 0,
  editing: ''         // session id being renamed
};

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
const tabCount = (s) => (s.windows || []).reduce((a, w) => a + w.tabs.length, 0) + (s.pinned || []).length;
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const when = (ts) => new Date(ts).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
});

function status(msg, isErr) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

async function send(msg) {
  let res;
  try { res = await api.runtime.sendMessage(msg); }
  catch (e) { throw new Error(`Tab Triage's background didn't answer: ${(e && e.message) || e}`); }
  if (!res) throw new Error('No answer from Tab Triage. Reload the extension.');
  if (!res.ok) throw new Error(res.error || 'Something went wrong.');
  return res;
}

async function load() {
  try {
    const o = await api.storage.local.get('sessions');
    V.sessions = Array.isArray(o.sessions) ? o.sessions : [];
  } catch (e) {
    status(`Couldn't read saved sessions: ${(e && e.message) || e}`, true);
  }
  render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const list = $('#list');
  list.textContent = '';
  if (!V.sessions.length) {
    list.append(h('p', { class: 'empty', text: 'No saved sessions yet. Click Save session now, or Save session in the Tab Triage popup.' }));
    return;
  }
  for (const s of V.sessions) list.append(card(s));
  const inp = document.querySelector('input.rename');
  if (inp) { inp.focus(); inp.select(); }
}

function card(s) {
  const n = tabCount(s);
  const open = V.open.has(s.id);
  const pins = (s.pinned || []).length;
  const armedAll = V.confirm === `${s.id}:all`;
  const armedDel = V.confirm === `${s.id}:del`;
  return h('section', { class: 'sess' + (open ? ' open' : ''), 'data-id': s.id },
    h('div', { class: 'shead' },
      h('button', { type: 'button', class: 'chev', 'data-act': 'toggle', 'aria-expanded': String(open), 'aria-label': open ? 'Hide tabs' : 'Show tabs' }),
      V.editing === s.id
        ? h('input', { class: 'rename', type: 'text', value: s.name, maxlength: '80', 'aria-label': 'Session name', spellcheck: 'false', autocomplete: 'off' })
        : h('h2', { class: 'sname', 'data-act': 'toggle', title: 'Show or hide its tabs', text: s.name }),
      h('span', { class: 'meta', text: `${plural(n, 'tab')} · ${plural((s.windows || []).length, 'window')}${pins ? ` · ${pins} pinned` : ''} · ${when(s.savedAt)}` }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: armedAll ? 'primary' : null, 'data-act': 'restore', title: 'Open every saved window again', text: armedAll ? `Open ${plural(n, 'tab')}?` : 'Restore' }),
      h('button', { type: 'button', 'data-act': 'rename', text: 'Rename' }),
      h('button', { type: 'button', class: 'danger' + (armedDel ? ' armed' : ''), 'data-act': 'delete', text: armedDel ? 'Delete?' : 'Delete' })),
    open ? body(s) : null);
}

function body(s) {
  const b = h('div', { class: 'sbody' });
  if ((s.pinned || []).length) b.append(win('pinned', 'Pinned', s.pinned));
  (s.windows || []).forEach((w, i) => b.append(win(i, `Window ${i + 1}`, w.tabs)));
  return b;
}

function win(part, label, tabs) {
  return h('div', { class: 'win' },
    h('div', { class: 'whead' },
      h('span', { class: 'wname', text: label }),
      h('span', { class: 'meta', text: plural(tabs.length, 'tab') }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'small', 'data-act': 'restore-part', 'data-part': String(part), text: part === 'pinned' ? 'Open pinned' : 'Open window' })),
    h('ol', { class: 'tabs' }, tabs.map((t) => h('li', {},
      /^https?:\/\//i.test(t.url)
        ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', title: t.url, text: t.title || t.url })
        : h('span', { class: 'bad', text: t.title || t.url }),
      h('span', { class: 'host', text: hostOf(t.url) })))));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function arm(key) {
  V.confirm = key;
  clearTimeout(V.confirmTimer);
  V.confirmTimer = setTimeout(() => { V.confirm = ''; render(); }, CONFIRM_MS);
  render();
}

function disarm() { V.confirm = ''; clearTimeout(V.confirmTimer); }

async function restore(id, part) {
  const s = V.sessions.find((x) => x.id === id);
  status(`Opening ${s ? s.name : 'session'}…`);
  try {
    const r = await send({ type: 'restoreSession', id, part });
    const notes = [];
    if (r.skipped) notes.push(`${plural(r.skipped, 'pinned tab')} already open`);
    if (r.failed) notes.push(`${plural(r.failed, 'tab')} couldn't open`);
    status(`Opened ${plural(r.restored, 'tab')}.${notes.length ? ' ' + notes.join(', ') + '.' : ''}`, !!r.failed);
  } catch (e) {
    status(`Couldn't restore: ${e.message}`, true);
  }
}

async function saveNow() {
  const btn = $('#save');
  btn.disabled = true;
  try {
    const { session: s } = await send({ type: 'saveSession' });
    const notes = [];
    if (s.private) notes.push(`${plural(s.private, 'private tab')} not saved`);
    if (s.skipped) notes.push(`${plural(s.skipped, 'blank or hidden tab')} skipped`);
    status(`Saved ${s.name}: ${plural(s.tabs, 'tab')} from ${plural(s.windows, 'window')}.${notes.length ? ' ' + notes.join(', ') + '.' : ''}`);
    await load();
  } catch (e) {
    status(`Couldn't save: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function commitRename(value) {
  const id = V.editing;
  if (!id) return;
  V.editing = '';
  const s = V.sessions.find((x) => x.id === id);
  const name = String(value || '').trim();
  if (!s || !name || name === s.name) { render(); return; }
  try {
    await send({ type: 'renameSession', id, name });
    s.name = name.slice(0, 80);
    status(`Renamed to ${s.name}.`);
  } catch (e) {
    status(`Couldn't rename: ${e.message}`, true);
  }
  render();
}

async function onClick(e) {
  const t = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  const btn = t && t.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.sess').dataset.id;
  const act = btn.dataset.act;
  if (act !== 'restore' && act !== 'delete') disarm();
  switch (act) {
    case 'toggle':
      if (V.open.has(id)) V.open.delete(id); else V.open.add(id);
      render();
      break;
    case 'restore':
      if (V.confirm === `${id}:all`) { disarm(); render(); await restore(id, 'all'); } else arm(`${id}:all`);
      break;
    case 'restore-part': {
      const p = btn.dataset.part;
      await restore(id, p === 'pinned' ? 'pinned' : Number(p));
      break;
    }
    case 'rename':
      V.editing = id;
      render();
      break;
    case 'delete':
      if (V.confirm === `${id}:del`) {
        disarm();
        try {
          const s = V.sessions.find((x) => x.id === id);
          await send({ type: 'deleteSession', id });
          V.sessions = V.sessions.filter((x) => x.id !== id);
          status(`Deleted ${s ? s.name : 'the session'}.`);
        } catch (err) {
          status(`Couldn't delete: ${err.message}`, true);
        }
        render();
      } else {
        arm(`${id}:del`);
      }
      break;
    default: break;
  }
}

let renaming = false;
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!(t.matches && t.matches('input.rename'))) return;
  if (e.key === 'Enter') { e.preventDefault(); renaming = true; commitRename(t.value).finally(() => { renaming = false; }); }
  else if (e.key === 'Escape') { e.preventDefault(); V.editing = ''; render(); }
});
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!renaming && t.matches && t.matches('input.rename') && V.editing) commitRename(t.value);
});

$('#list').addEventListener('click', onClick);
$('#save').addEventListener('click', saveNow);
$('#folders').addEventListener('click', async () => {
  try { await api.runtime.openOptionsPage(); }
  catch (e) { try { await api.tabs.create({ url: api.runtime.getURL('options.html') }); } catch (e2) { status(`Couldn't open Folders: ${(e2 && e2.message) || e2}`, true); } }
});

if (api && api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((ch, area) => {
    if (area && area !== 'local') return;
    if (!ch || !ch.sessions || V.editing) return;
    V.sessions = Array.isArray(ch.sessions.newValue) ? ch.sessions.newValue : [];
    render();
  });
}

if (api && api.storage && api.runtime) load();
else status('Open this page from the Tab Triage popup.', true);
