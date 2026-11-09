/**
 * Tab Triage background (non-persistent event page).
 *
 * Owns every mutation so it finishes even if Safari dismisses the popup
 * mid-action (closing the active tab or opening windows can do that).
 *
 * Messages (from extension pages only):
 *   { type: 'close', tabs: [{ id, key }] } -> { closed, failed, private, unrestorable, batch }
 *   { type: 'undo' }                        -> { restored, failed, remaining }
 *   { type: 'undoState' }                   -> { batches: [{ id, count, expiresAt }] }
 *   { type: 'goto', id }                    -> {}   (switch to a tab and its window)
 *   { type: 'usage', cpu }                  -> { usage }  (Safari-wide memory/CPU from the app's
 *                                                         native handler; no tab data is sent)
 *   { type: 'saveSession' }                 -> { session }  (snapshot of every non-private tab,
 *                                                           named SafariSession_MMDD-HH:MM)
 *   { type: 'restoreSession', id, part }    -> { restored, failed, skipped }  (part: 'all' | 'pinned' | window index)
 *   { type: 'renameSession', id, name }     -> {}
 *   { type: 'deleteSession', id }           -> {}
 *   { type: 'reloadTabs', ids }             -> { reloaded, failed, skipped }  (Refresh stale: one
 *                                                         tabs.reload every ~300 ms, outside the queue)
 *   { type: 'tabAges' }                     -> { ages: { [tabId]: ms }, since }  (Tab Triage's own record of
 *                                                         when each tab was last viewed or loaded; Safari
 *                                                         doesn't give extensions tabs.Tab.lastAccessed)
 *   { type: 'resetTabs' }                   -> { name, closed, closeFailed, restored, failed, skipped, kept, error }
 *                                              (Reset tabs: save a session, close every non-pinned tab,
 *                                              reopen the session; also left in storage.local.lastReset
 *                                              for the next popup, because closing the active tab
 *                                              dismisses the one that asked)
 *
 * Undo buffer: storage.local (survives a Safari restart inside the window).
 * Expired batches are dropped silently. Private tabs are never written
 * anywhere: closing them is permanent.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const UNDO_MS = 60 * 1000;       // undo window per close batch
const MAX_BATCHES = 10;          // stacked batches kept at once
const MAX_RESTORE_WINDOWS = 5;   // restore: one window per domain, overflow merged into the 5th
const K_BATCHES = 'undoBatches';
const K_SESSIONS = 'sessions';   // saved sessions, newest first
const MAX_SESSIONS = 200;
const K_LAST_RESET = 'lastReset'; // result of the last Reset tabs, shown once by the next popup
// Gap between reloads so Safari isn't asked to reload dozens of pages at once (tests shorten it).
const RELOAD_GAP_MS = typeof globalThis.TT_RELOAD_GAP_MS === 'number' ? globalThis.TT_RELOAD_GAP_MS : 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize handlers: each does read-modify-write on storage.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const HANDLERS = {
  close: handleClose,
  undo: handleUndo,
  undoState: handleUndoState,
  goto: handleGoto,
  usage: handleUsage,
  saveSession: handleSaveSession,
  restoreSession: handleRestoreSession,
  renameSession: handleRenameSession,
  deleteSession: handleDeleteSession,
  reloadTabs: handleReloadTabs,
  resetTabs: handleResetTabs,
  tabAges: handleTabAges
};
// Slow and storage-free (usage samples CPU for a second; reloads are staggered): kept out of the
// queue so closes never wait on them.
const UNQUEUED = new Set(['usage', 'reloadTabs', 'tabAges']); // tabAges has its own queue (withUsed)
const NATIVE_APP = 'com.joshhotz.tabtriage'; // Safari ignores the name and routes to this app's extension

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || !HANDLERS[msg.type]) return undefined;
  if (sender && sender.id && sender.id !== api.runtime.id) return undefined;
  const run = UNQUEUED.has(msg.type)
    ? Promise.resolve().then(() => HANDLERS[msg.type](msg))
    : serial(() => HANDLERS[msg.type](msg));
  return run.then(
    (res) => ({ ok: true, ...res }),
    (err) => ({ ok: false, error: String((err && err.message) || err) })
  );
});

// Clear batches that expired while Safari was closed. Tab ids start over with each Safari launch,
// so tab ages start over too.
if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => { serial(prune).catch(() => {}); seedAges(true).catch(() => {}); });

// Install or update: seed the starter folder outline if none was ever saved.
if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener((details) => {
    seedAges(false).catch(() => {});
    if (!details || !globalThis.TT || (details.reason !== 'install' && details.reason !== 'update')) return;
    serial(async () => {
      const o = await api.storage.local.get('outline');
      if (typeof o.outline !== 'string') await api.storage.local.set({ outline: globalThis.TT.DEFAULT_OUTLINE });
    }).catch(() => {});
  });
}

/** Drop expired batches. */
async function prune() {
  const o = await api.storage.local.get(K_BATCHES);
  const batches = Array.isArray(o[K_BATCHES]) ? o[K_BATCHES] : [];
  const now = Date.now();
  const live = batches.filter((b) => b && b.expiresAt > now && Array.isArray(b.tabs));
  if (live.length !== batches.length) await api.storage.local.set({ [K_BATCHES]: live });
  return { batches: live };
}

/**
 * Close tabs in one tabs.remove call. If Safari rejects the batch (typically a
 * tab already closed elsewhere), retry only the ones still open, one by one.
 * Returns ids that failed to close.
 */
async function removeTabs(ids) {
  if (!ids.length) return [];
  try {
    await api.tabs.remove(ids);
    return [];
  } catch (e) {
    const open = new Set((await api.tabs.query({})).map((t) => t.id));
    const remaining = ids.filter((id) => open.has(id));
    const results = await Promise.allSettled(remaining.map((id) => api.tabs.remove(id)));
    return remaining.filter((id, i) => results[i].status === 'rejected');
  }
}

async function handleClose(msg) {
  const requested = Array.isArray(msg.tabs) ? msg.tabs : [];
  if (!requested.length) return { closed: 0, failed: 0, private: 0, unrestorable: 0, batch: null };

  const keyById = new Map(requested.map((t) => [t.id, typeof t.key === 'string' ? t.key : '']));
  const live = new Map((await api.tabs.query({})).map((t) => [t.id, t]));

  // Re-check against Safari's current state: skip tabs already gone; never close pinned tabs.
  const targets = [];
  for (const id of keyById.keys()) {
    const t = live.get(id);
    if (t && !t.pinned) targets.push(t);
  }

  const failed = new Set(await removeTabs(targets.map((t) => t.id)));
  const closed = targets.filter((t) => !failed.has(t.id));
  const priv = closed.filter((t) => t.incognito).length;
  const restorable = closed.filter((t) => !t.incognito && /^https?:\/\//i.test(t.url || ''));

  let batch = null;
  if (restorable.length) {
    const { batches } = await prune();
    const now = Date.now();
    const b = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      closedAt: now,
      expiresAt: now + UNDO_MS,
      // URL + domain group only. No titles, nothing from private windows.
      tabs: restorable.map((t) => ({ url: t.url, key: keyById.get(t.id) || '' }))
    };
    batches.push(b);
    while (batches.length > MAX_BATCHES) batches.shift();
    await api.storage.local.set({ [K_BATCHES]: batches });
    batch = { id: b.id, count: b.tabs.length, expiresAt: b.expiresAt };
  }

  return {
    closed: closed.length,
    failed: failed.size,
    private: priv,
    unrestorable: closed.length - restorable.length - priv,
    batch
  };
}

async function handleUndo() {
  const { batches } = await prune();
  const b = batches.pop();
  if (!b) return { restored: 0, failed: 0, remaining: 0 };
  // Remove from storage before reopening so a double-click can't restore twice.
  await api.storage.local.set({ [K_BATCHES]: batches });
  const { restored, failed } = await restoreTabs(b.tabs);
  return { restored, failed, remaining: batches.length };
}

/**
 * Reopen URLs, one new window per domain group (largest first). More than
 * MAX_RESTORE_WINDOWS groups: the smallest ones share the last window.
 * Order inside a window is not guaranteed.
 */
async function restoreTabs(tabs) {
  const byKey = new Map();
  for (const t of tabs) {
    if (!t || typeof t.url !== 'string') continue;
    const k = t.key || 'other';
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t.url);
  }
  let buckets = [...byKey.values()].sort((a, b) => b.length - a.length);
  if (buckets.length > MAX_RESTORE_WINDOWS) {
    const head = buckets.slice(0, MAX_RESTORE_WINDOWS - 1);
    head.push(buckets.slice(MAX_RESTORE_WINDOWS - 1).flat());
    buckets = head;
  }

  let restored = 0;
  let failed = 0;
  for (const urls of buckets) {
    let win = null;
    let i = 0;
    while (!win && i < urls.length) {
      try { win = await api.windows.create({ url: urls[i] }); restored++; } catch (e) { failed++; }
      i++;
    }
    if (!win) continue;
    const rest = urls.slice(i);
    const results = await Promise.allSettled(
      rest.map((url) => api.tabs.create({ windowId: win.id, url, active: false }))
    );
    for (const r of results) { if (r.status === 'fulfilled') restored++; else failed++; }
  }
  return { restored, failed };
}

async function handleUndoState() {
  const { batches } = await prune();
  return { batches: batches.map((b) => ({ id: b.id, count: b.tabs.length, expiresAt: b.expiresAt })) };
}

/**
 * Safari's total memory and CPU plus the Mac's memory and swap, measured by the Tab Triage
 * app's native handler (04_Build_Tools/native). Only { type, cpu } goes out: no tabs, no URLs.
 */
async function handleUsage(msg) {
  if (!api.runtime.sendNativeMessage) throw new Error("This Safari can't talk to the Tab Triage app.");
  const reply = await api.runtime.sendNativeMessage(NATIVE_APP, { type: 'usage', cpu: msg.cpu !== false });
  if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'No answer from the Tab Triage app.');
  return { usage: reply };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function loadSessions() {
  const o = await api.storage.local.get(K_SESSIONS);
  return Array.isArray(o[K_SESSIONS]) ? o[K_SESSIONS] : [];
}

/** Save every open, non-private http(s) tab, window by window. Private tabs are never written. */
async function handleSaveSession() {
  const snap = globalThis.TT.buildSession(await api.tabs.query({}));
  if (!snap.counts.tabs) throw new Error('No open web pages to save (private tabs are never saved).');
  const sessions = await loadSessions();
  const now = Date.now();
  const name = globalThis.TT.uniqueSessionName(globalThis.TT.sessionName(new Date(now)), sessions.map((s) => s.name));
  const s = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    savedAt: now,
    windows: snap.windows,
    pinned: snap.pinned
  };
  sessions.unshift(s);
  while (sessions.length > MAX_SESSIONS) sessions.pop();
  await api.storage.local.set({ [K_SESSIONS]: sessions });
  return { session: { id: s.id, name: s.name, savedAt: s.savedAt, ...snap.counts } };
}

/** Open one list of URLs as a new window, in order. */
async function openWindow(urls) {
  let restored = 0;
  let failed = 0;
  let win = null;
  let i = 0;
  while (!win && i < urls.length) {
    try { win = await api.windows.create({ url: urls[i] }); restored++; } catch (e) { failed++; }
    i++;
  }
  if (win) {
    for (const url of urls.slice(i)) {
      try { await api.tabs.create({ windowId: win.id, url, active: false }); restored++; } catch (e) { failed++; }
    }
  } else {
    failed += urls.length - i;
  }
  return { restored, failed };
}

/**
 * Reopen a saved session: every window ('all'), one window (its index), or the pinned tabs ('pinned').
 * Pinned tabs already open in Safari are skipped; the rest open as normal tabs in their own window
 * (Safari shows a pinned tab in every window, so they're saved once and never re-pinned automatically).
 */
async function handleRestoreSession(msg) {
  const s = (await loadSessions()).find((x) => x.id === msg.id);
  if (!s) throw new Error('That session is gone.');
  const part = msg.part == null ? 'all' : msg.part;
  const lists = [];
  let skipped = 0;
  if (part === 'all' || part === 'pinned') {
    const open = new Set((await api.tabs.query({})).filter((t) => t.pinned && !t.incognito).map((t) => t.url));
    const pins = (s.pinned || []).filter((p) => { const dup = open.has(p.url); if (dup) skipped++; return !dup; }).map((p) => p.url);
    if (part === 'pinned') lists.push(pins);
    else if (pins.length) lists.push(pins);
  }
  if (part === 'all') for (const w of s.windows || []) lists.push(w.tabs.map((t) => t.url));
  else if (typeof part === 'number' && s.windows && s.windows[part]) lists.push(s.windows[part].tabs.map((t) => t.url));
  let restored = 0;
  let failed = 0;
  for (const urls of lists) {
    if (!urls.length) continue;
    const r = await openWindow(urls.filter((u) => /^https?:\/\//i.test(u)));
    restored += r.restored;
    failed += r.failed;
  }
  return { restored, failed, skipped };
}

async function handleRenameSession(msg) {
  const name = String(msg.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  if (!name) throw new Error('A session needs a name.');
  const sessions = await loadSessions();
  const s = sessions.find((x) => x.id === msg.id);
  if (!s) throw new Error('That session is gone.');
  s.name = name;
  await api.storage.local.set({ [K_SESSIONS]: sessions });
  return {};
}

async function handleDeleteSession(msg) {
  const sessions = await loadSessions();
  const left = sessions.filter((x) => x.id !== msg.id);
  if (left.length !== sessions.length) await api.storage.local.set({ [K_SESSIONS]: left });
  return {};
}

// ---------------------------------------------------------------------------
// Memory relief: Refresh stale and Reset tabs
// ---------------------------------------------------------------------------

/**
 * Refresh stale: reload the given tabs one at a time, RELOAD_GAP_MS apart. Each tab is re-checked
 * against Safari first: gone, or now active / pinned / playing audio, means it's skipped.
 */
async function handleReloadTabs(msg) {
  const ids = Array.isArray(msg.ids) ? msg.ids.filter((id) => Number.isInteger(id)) : [];
  const live = new Map((await api.tabs.query({})).map((t) => [t.id, t]));
  let reloaded = 0;
  let failed = 0;
  let skipped = 0;
  for (const id of ids) {
    const t = live.get(id);
    if (!t || t.active || t.pinned || t.audible) { skipped++; continue; }
    if (reloaded + failed > 0) await sleep(RELOAD_GAP_MS);
    try { await api.tabs.reload(id); reloaded++; } catch (e) { failed++; }
  }
  return { reloaded, failed, skipped };
}

/**
 * Reset tabs: a fresh start for every page without quitting Safari.
 * 1. Save a session with the normal saver (if that fails, nothing is closed).
 * 2. Close every non-pinned tab, private ones included, in one batch: their page processes exit.
 * 3. Restore that session (pinned tabs stayed open, so restore skips them).
 * Fully restored: the session is deleted. Anything failed: it stays in Sessions.
 * Nothing about private tabs is stored: they're counted in `closed` only.
 */
async function handleResetTabs() {
  const { session } = await handleSaveSession();
  const targets = (await api.tabs.query({})).filter((t) => !t.pinned);
  const closeFailed = await removeTabs(targets.map((t) => t.id));
  let restored = 0;
  let failed = 0;
  let skipped = 0;
  let error = '';
  try {
    ({ restored, failed, skipped } = await handleRestoreSession({ id: session.id, part: 'all' }));
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const kept = !!error || failed > 0 || restored + skipped < session.tabs;
  if (!kept) await handleDeleteSession({ id: session.id });
  const result = {
    at: Date.now(),
    name: session.name,
    closed: targets.length - closeFailed.length,
    closeFailed: closeFailed.length,
    restored,
    failed,
    skipped,
    kept,
    error
  };
  await api.storage.local.set({ [K_LAST_RESET]: result });
  return result;
}

// ---------------------------------------------------------------------------
// Tab ages (for Refresh stale)
// Safari doesn't give extensions tabs.Tab.lastAccessed, so Tab Triage records it: a tab is "used" when
// it's shown (activated, or its window comes to the front) or finishes (re)loading. Event-driven, no polling.
// Normal tabs: storage.local.tabUsed { [tabId]: ms }. Private tabs: memory only, never written; they're
// forgotten when Safari unloads this page, so they rarely count as stale.
// Ages count from when tracking started (tabUsedSince): install, or each Safari launch.
// ---------------------------------------------------------------------------

const K_USED = 'tabUsed';
const K_SINCE = 'tabUsedSince';
const privUsed = new Map();
let usedChain = Promise.resolve();

/** Serialized read-modify-write of the tabUsed map. fn(map) returns true if it changed it. */
function withUsed(fn) {
  const p = usedChain.then(async () => {
    const o = await api.storage.local.get(K_USED);
    const map = o[K_USED] && typeof o[K_USED] === 'object' ? o[K_USED] : {};
    if (await fn(map)) await api.storage.local.set({ [K_USED]: map });
    return map;
  });
  usedChain = p.catch(() => {});
  return p;
}

function markUsed(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const now = Date.now();
  if (tab.incognito) { privUsed.set(tab.id, now); return; }
  withUsed((m) => { m[tab.id] = now; return true; }).catch(() => {});
}

/** Give every open tab an age if it has none (now), drop closed tabs. reset: forget everything first. */
async function seedAges(reset) {
  const tabs = await api.tabs.query({});
  const now = Date.now();
  if (reset) privUsed.clear();
  const open = new Set(tabs.map((t) => t.id));
  for (const id of [...privUsed.keys()]) if (!open.has(id)) privUsed.delete(id);
  for (const t of tabs) if (t.incognito && !privUsed.has(t.id)) privUsed.set(t.id, now);
  const map = await withUsed((m) => {
    let changed = false;
    if (reset) { for (const k of Object.keys(m)) delete m[k]; changed = true; }
    for (const k of Object.keys(m)) if (!open.has(Number(k))) { delete m[k]; changed = true; }
    for (const t of tabs) if (!t.incognito && typeof m[t.id] !== 'number') { m[t.id] = now; changed = true; }
    return changed;
  });
  const o = await api.storage.local.get(K_SINCE);
  if (reset || typeof o[K_SINCE] !== 'number') await api.storage.local.set({ [K_SINCE]: now });
  return map;
}

async function handleTabAges() {
  const map = await seedAges(false);
  const o = await api.storage.local.get(K_SINCE);
  const ages = { ...map };
  for (const [id, ms] of privUsed) ages[id] = ms;
  return { ages, since: typeof o[K_SINCE] === 'number' ? o[K_SINCE] : null };
}

if (api.tabs.onActivated) {
  api.tabs.onActivated.addListener((info) => { api.tabs.get(info.tabId).then(markUsed, () => {}); });
}
if (api.tabs.onUpdated) {
  api.tabs.onUpdated.addListener((tabId, change, tab) => { if (change && change.status === 'complete') markUsed(tab); });
}
if (api.tabs.onCreated) api.tabs.onCreated.addListener((tab) => markUsed(tab));
if (api.tabs.onRemoved) {
  api.tabs.onRemoved.addListener((tabId) => {
    privUsed.delete(tabId);
    withUsed((m) => { if (!(tabId in m)) return false; delete m[tabId]; return true; }).catch(() => {});
  });
}
if (api.windows && api.windows.onFocusChanged) {
  api.windows.onFocusChanged.addListener((windowId) => {
    if (typeof windowId !== 'number' || windowId < 0) return;
    api.tabs.query({ active: true, windowId }).then((tabs) => tabs.forEach(markUsed), () => {});
  });
}

/** Bring a tab to the front. Runs here because focusing a window dismisses the popup. */
async function handleGoto(msg) {
  const id = Number(msg.id);
  const tab = await api.tabs.get(id); // rejects if the tab was closed elsewhere
  await api.tabs.update(id, { active: true });
  await api.windows.update(tab.windowId, { focused: true });
  return {};
}
