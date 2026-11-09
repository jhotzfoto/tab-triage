/**
 * Tab Triage tests. Run: 04_Build_Tools/Run_Tests.command
 * 1) Unit tests for lib/grouping.js
 * 2) End-to-end smoke test: popup + background in jsdom against a mocked Safari tabs API.
 * This verifies logic and UI wiring, not Safari's real API behavior.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

// Repository layout: tests/ beside extension/. Project layout: 04_Build_Tools/tests/ under the project.
const EXT = fs.existsSync(path.join(__dirname, '..', 'extension'))
  ? path.join(__dirname, '..', 'extension')
  : path.join(__dirname, '..', '..', '02_Extension_Code');
const TT = require(path.join(EXT, 'lib', 'grouping.js'));
let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok  ' + name); }); }

async function unit() {
  console.log('Unit');
  await test('registrable domain', () => {
    assert.strictEqual(TT.registrableDomain('a.b.example.co.uk'), 'example.co.uk');
    assert.strictEqual(TT.registrableDomain('foo.github.io'), 'foo.github.io');
    assert.strictEqual(TT.registrableDomain('bucket.s3.amazonaws.com'), 'bucket.s3.amazonaws.com');
    assert.strictEqual(TT.registrableDomain('192.168.1.10'), '192.168.1.10');
    assert.strictEqual(TT.registrableDomain('localhost'), 'localhost');
  });
  await test('split domains and aliases', () => {
    assert.strictEqual(TT.domainGroup('mail.google.com').key, 'mail.google.com');
    assert.strictEqual(TT.domainGroup('www.google.com').key, 'google.com');
    assert.strictEqual(TT.domainGroup('us-east-1.console.aws.amazon.com').key, 'aws.amazon.com');
    assert.strictEqual(TT.domainGroup('gist.github.com').key, 'github.com');
    assert.strictEqual(TT.domainGroup('youtu.be').key, 'youtube.com');
    assert.strictEqual(TT.domainGroup('twitter.com').key, 'x.com');
  });
  await test('labels', () => {
    assert.strictEqual(TT.autoLabel('mail.google.com', 'google.com'), 'Gmail');
    assert.strictEqual(TT.autoLabel('lens.google.com', 'google.com'), 'Google Lens');
    assert.strictEqual(TT.autoLabel('some-cool-site.com', 'some-cool-site.com'), 'Some Cool Site');
    assert.strictEqual(TT.autoLabel('10.0.0.5', '10.0.0.5'), '10.0.0.5');
  });
  const keys = (url) => { const u = new URL(url); return TT.dedupeKeys(u, TT.domainGroup(u.hostname).reg); };
  await test('exact duplicates ignore tracking, www, slash, param order, scheme', () => {
    assert.strictEqual(keys('https://www.example.com/a/?b=2&a=1&utm_source=x').exact,
      keys('http://example.com/a?a=1&b=2&fbclid=zz').exact);
  });
  await test('YouTube: youtu.be, shorts, share tokens, timestamps collapse; different videos stay apart', () => {
    const a = keys('https://www.youtube.com/watch?v=ABC&t=30s&si=q');
    assert.strictEqual(a.exact, keys('https://youtu.be/ABC?si=zz').exact);
    assert.strictEqual(a.exact, keys('https://m.youtube.com/shorts/ABC').exact);
    assert.notStrictEqual(a.near, keys('https://www.youtube.com/watch?v=XYZ').near);
  });
  await test('near duplicates: same path, query ignored unless significant', () => {
    assert.strictEqual(keys('https://github.com/o/r?tab=readme').near, keys('https://github.com/o/r').near);
    assert.notStrictEqual(keys('https://github.com/o/r?tab=readme').exact, keys('https://github.com/o/r').exact);
    assert.notStrictEqual(keys('https://www.google.com/search?q=a').near, keys('https://www.google.com/search?q=b').near);
    assert.notStrictEqual(keys('https://www.tradingview.com/chart/x/?symbol=AAPL').near,
      keys('https://www.tradingview.com/chart/x/?symbol=TSLA').near);
  });
  await test('hash routes kept, plain anchors dropped', () => {
    assert.notStrictEqual(keys('https://app.io/#/a').exact, keys('https://app.io/#/b').exact);
    assert.notStrictEqual(keys('https://mail.google.com/mail/u/0/#inbox/AAA').exact, keys('https://mail.google.com/mail/u/0/#inbox/BBB').exact);
    assert.strictEqual(keys('https://site.com/doc#intro').exact, keys('https://site.com/doc#usage').exact);
  });
  const O = TT.compileOutline(TT.DEFAULT_OUTLINE);
  const place = (url) => { const r = TT.describeTab({ id: 1, url, title: 't' }, { outline: O }); return `${r.folderLabel} / ${r.label}`; };
  await test('default outline parses cleanly', () => {
    assert.strictEqual(O.errors.length, 0);
    assert.ok(O.folders.length >= 10);
  });
  await test('outline: named groups merge sites, bare sites get their own group', () => {
    assert.strictEqual(place('https://www.amazon.ca/dp/X'), 'Shopping / Amazon');
    assert.strictEqual(place('https://www.amazon.com/dp/Y'), 'Shopping / Amazon');
    assert.strictEqual(place('https://www.bhphotovideo.com/c/x'), 'Shopping / Electronics');
    assert.strictEqual(place('https://www.keh.com/shop'), 'Shopping / Electronics');
    assert.strictEqual(place('https://claude.ai/chat/1'), 'AI / Claude');
    assert.strictEqual(place('https://chatgpt.com/'), 'AI / ChatGPT');
  });
  await test('outline: URL piece beats domain; longer domain beats shorter', () => {
    assert.strictEqual(place('https://www.facebook.com/marketplace/item/1'), 'Shopping / Marketplaces');
    assert.strictEqual(place('https://www.facebook.com/someone'), 'Social / Facebook');
    assert.strictEqual(place('https://www.google.com/maps/place/x'), 'Travel / Maps');
    assert.strictEqual(place('https://docs.google.com/d/1'), 'Work / Google Docs');
    assert.strictEqual(place('https://www.google.com/search?q=a'), 'Google / Google');
    assert.strictEqual(place('https://developer.apple.com/x'), 'Dev / Apple Developer');
    assert.strictEqual(place('https://www.apple.com/'), 'Apple / Apple');
  });
  await test('default outline: no errors, no site listed twice, no region-only folders', () => {
    const p = TT.parseOutline(TT.DEFAULT_OUTLINE);
    assert.deepStrictEqual(p.errors, []);
    const seen = new Set();
    for (const f of p.folders) for (const e of f.entries) for (const s of e.sites) {
      assert.ok(!seen.has(s.value), 'listed twice: ' + s.value);
      seen.add(s.value);
    }
    assert.ok(!p.folders.some((f) => /canada|gov/i.test(f.name)), 'starter folders are worldwide');
  });
  await test('outline: unlisted sites go to Unsorted, one group per site', () => {
    assert.strictEqual(place('https://randomsite.io/a'), 'Unsorted / Randomsite');
  });
  await test('outline syntax: "Shopping>" folders, errors with line numbers, comments ignored', () => {
    const p = TT.parseOutline('# note\nShopping>\n  Gear: keh.com, mpb.com\n  bad site!\n  Empty:\nAI:\n  claude.ai\n  orphan.com');
    assert.deepStrictEqual(p.folders.map((f) => f.name), ['Shopping', 'AI']);
    assert.strictEqual(p.folders[0].entries[0].group, 'Gear');
    assert.strictEqual(p.errors.length, 1);
    assert.ok(p.errors[0].startsWith('Line 4'));
    assert.strictEqual(JSON.stringify(p.folders[0].entries[2]), JSON.stringify({ group: 'Empty', sites: [] }), '"Name:" alone is an empty group');
    const q = TT.parseOutline('  keh.com\nWork\n  https://www.frame.io/, localhost:3000');
    assert.ok(q.errors[0].startsWith('Line 1'));
    assert.deepStrictEqual(q.folders[0].entries[0].sites.map((x) => x.value), ['frame.io', 'localhost:3000']);
  });
  await test('organizer model: default outline round-trips with identical matches', () => {
    const m = TT.outlineToModel(TT.DEFAULT_OUTLINE);
    assert.strictEqual(m.errors.length, 0);
    const text = TT.modelToOutline(m);
    const pick = (o) => JSON.stringify(TT.compileOutline(o).matchers.map((x) => [x.folder, x.group, x.value]));
    assert.strictEqual(pick(text), pick(TT.DEFAULT_OUTLINE));
    assert.strictEqual(TT.modelToOutline(TT.outlineToModel(text)), text, 'stable after one pass');
  });
  await test('organizer ops: place, group, move, reorder, rename rules, text output', () => {
    const m = TT.outlineToModel('A\n  G: a.com\n  b.com\nB\n  c.com');
    const o = TT.org;
    assert.strictEqual(o.placeSite(m, 'https://www.keh.com/', 0, 0), 'keh.com');
    o.placeSite(m, 'c.com', 0);
    assert.strictEqual(m.folders[1].items.length, 0, 'a site lives in one place only');
    assert.strictEqual(o.groupWith(m, 'd.com', 0, 1), 'd.com');
    assert.strictEqual(JSON.stringify(m.folders[0].items[1]), JSON.stringify({ kind: 'group', name: 'B', sites: ['b.com', 'd.com'] }));
    assert.strictEqual(o.groupWith(m, 'c.com', 0, 2), null, 'not onto itself');
    o.moveItem(m, 0, 2, 1);
    o.moveItem(m, 0, 0, 0, 2);
    assert.deepStrictEqual(m.folders[0].items.map((it) => it.name), ['B', 'G']);
    assert.strictEqual(o.addFolder(m, 'A'), 2);
    assert.strictEqual(m.folders[2].name, 'A 2', 'new folder names stay unique');
    assert.strictEqual(o.renameFolder(m, 2, 'b'), false, 'no duplicate folder names');
    assert.strictEqual(o.renameFolder(m, 2, '## Reading>'), true);
    o.moveFolder(m, 2, 0);
    o.addGroup(m, 0);
    assert.strictEqual(o.placeSite(m, 'bad site', 0), null);
    o.placeSiteAt(m, 'e.com', 1, 0);
    const text = TT.modelToOutline(m);
    assert.ok(text.endsWith('\n\nReading\n  New group:\n\nA\n  e.com\n  B: b.com, d.com\n  G: a.com, keh.com\n\nB\n  c.com\n'), text);
    assert.strictEqual(TT.parseOutline(text).errors.length, 0);
    assert.strictEqual(JSON.stringify(TT.outlineToModel(text).folders), JSON.stringify(m.folders));
    assert.strictEqual(TT.cleanGroupName(' # Foo: bar.baz '), 'Foo bar baz');
    assert.strictEqual(TT.cleanFolderName('## Shop>'), 'Shop');
  });
  await test('site for a host and friendly site names', () => {
    assert.strictEqual(TT.siteForHost('www.twitter.com'), 'twitter.com', 'as typed, not the x.com it groups with');
    assert.strictEqual(TT.siteForHost('mail.google.com'), 'mail.google.com');
    assert.strictEqual(TT.siteForHost('gist.github.com'), 'github.com');
    assert.strictEqual(TT.siteForHost('shop.example.co.uk'), 'example.co.uk');
    assert.strictEqual(TT.siteLabel('amazon.ca'), 'Amazon');
    assert.strictEqual(TT.siteLabel('facebook.com/marketplace'), 'facebook.com/marketplace');
  });
  await test('session name: SafariSession_MMDD-HH:MM, 24-hour, zero-padded; same-minute saves numbered', () => {
    assert.strictEqual(TT.sessionName(new Date(2026, 8, 25, 22, 19)), 'SafariSession_0925-22:19');
    assert.strictEqual(TT.sessionName(new Date(2026, 0, 5, 9, 7)), 'SafariSession_0105-09:07');
    assert.strictEqual(TT.sessionName(new Date(2026, 11, 31, 0, 0)), 'SafariSession_1231-00:00');
    assert.strictEqual(TT.uniqueSessionName('SafariSession_0925-22:19', ['SafariSession_0925-22:19']), 'SafariSession_0925-22:19 (2)');
    assert.strictEqual(TT.uniqueSessionName('SafariSession_0925-22:20', ['SafariSession_0925-22:19']), 'SafariSession_0925-22:20');
  });
  await test('session snapshot: window order, private left out, blanks skipped, pinned kept once', () => {
    const s = TT.buildSession([
      { id: 5, windowId: 2, index: 1, url: 'https://b.com/2', title: 'B2' },
      { id: 1, windowId: 1, index: 0, url: 'https://qbo.intuit.com/', title: 'QBO', pinned: true },
      { id: 2, windowId: 1, index: 1, url: 'https://a.com/', title: 'A' },
      { id: 3, windowId: 2, index: 0, url: 'https://qbo.intuit.com/', title: 'QBO', pinned: true },
      { id: 4, windowId: 2, index: 2, url: 'https://b.com/1', title: 'B1' },
      { id: 6, windowId: 3, index: 0, url: 'https://secretbank.example/', title: 'secret', incognito: true },
      { id: 7, windowId: 1, index: 2, url: '', title: '' },
      { id: 8, windowId: 1, index: 3 },
      { id: 9, windowId: 1, index: 4, url: 'favorites://' }
    ]);
    assert.strictEqual(JSON.stringify(s.windows), JSON.stringify([
      { tabs: [{ url: 'https://a.com/', title: 'A' }] },
      { tabs: [{ url: 'https://b.com/2', title: 'B2' }, { url: 'https://b.com/1', title: 'B1' }] }
    ]));
    assert.strictEqual(JSON.stringify(s.pinned), JSON.stringify([{ url: 'https://qbo.intuit.com/', title: 'QBO' }]));
    assert.strictEqual(JSON.stringify(s.counts), JSON.stringify({ tabs: 4, windows: 2, private: 1, skipped: 3, pinned: 1 }));
    assert.ok(!JSON.stringify(s.windows).includes('secretbank'));
  });
  await test('special tabs: blank vs no access, both in Other', () => {
    const b = TT.describeTab({ id: 1, url: '', title: '' }, { outline: O });
    assert.strictEqual(b.key, 'f:__other/blank');
    const n = TT.describeTab({ id: 2 }, { outline: O });
    assert.strictEqual(n.key, 'f:__other/noaccess');
    assert.ok(n.noAccess);
    assert.strictEqual(TT.describeTab({ id: 3, url: 'favorites://' }, { outline: O }).folderKey, 'f:__other');
  });
  await test('usage text: bytes, meter line, freed line', () => {
    const GiB = 1073741824;
    assert.strictEqual(TT.fmtBytes(21.44 * GiB), '21.4 GB');
    assert.strictEqual(TT.fmtBytes(812 * 1048576), '812 MB');
    assert.strictEqual(TT.fmtBytes(undefined), '');
    const u = { ok: true, safari: { memory: 21 * GiB, cpu: 52.6, processes: 30, pages: 27 },
      mac: { ramUsed: 46.2 * GiB, ramTotal: 64 * GiB, swapUsed: 4.6 * GiB, pressure: 'warning' } };
    assert.strictEqual(TT.usageLine(u), 'Safari 21.0 GB · CPU 53% · Mac 46.2 of 64.0 GB · Swap 4.6 GB · Memory pressure warning');
    assert.strictEqual(TT.usageLine({ ok: true, safari: null, mac: { ramUsed: 46 * GiB, ramTotal: 64 * GiB } }), 'Mac 46.0 of 64.0 GB');
    assert.strictEqual(TT.usageLine(null), '');
    const b = { safari: { memory: 21 * GiB } };
    assert.strictEqual(TT.freedLine(b, { safari: { memory: 19.2 * GiB } }, 7), 'Safari freed 1.8 GB after closing 7 tabs (21.0 GB → 19.2 GB)');
    assert.strictEqual(TT.freedLine(b, { safari: { memory: 21 * GiB + 10 * 1048576 } }, 1), 'Safari memory about the same after closing 1 tab (21.0 GB)');
    assert.strictEqual(TT.freedLine(b, null, 1), '');
  });
  await test('stale tabs: older than the threshold, oldest first; active, pinned, audible and blank skipped', () => {
    const N = Date.UTC(2026, 9, 28, 12);
    const D = 86400000;
    const tabs = [
      { id: 1, lastAccessed: N - 5 * D, active: true, url: 'https://a/' },
      { id: 2, lastAccessed: N - 5 * D, url: 'https://b/' },
      { id: 3, lastAccessed: N - 10 * D, url: 'https://c/' },
      { id: 4, lastAccessed: N - 5 * D, pinned: true, url: 'https://d/' },
      { id: 5, lastAccessed: N - 5 * D, audible: true, url: 'https://e/' },
      { id: 6, lastAccessed: N - 3600e3, url: 'https://f/' },
      { id: 7, lastAccessed: N - 9 * D, url: '' },
      { id: 8, lastAccessed: N - 2 * D, url: 'https://g/' }
    ];
    assert.strictEqual(JSON.stringify(TT.staleTabs(tabs, 3, N)),
      JSON.stringify({ ids: [3, 2], days: 3, known: true, skipped: { active: 1, pinned: 1, audible: 1 } }));
    assert.deepStrictEqual(TT.staleTabs(tabs, 1, N).ids, [3, 2, 8]);
    assert.deepStrictEqual(TT.staleTabs(tabs, 7, N).ids, [3]);
    assert.deepStrictEqual(TT.staleTabs(tabs, 14, N).ids, []);
    assert.strictEqual(TT.staleTabs(tabs, 5, N).days, 3, 'only 1, 3, 7 or 14 days; anything else means 3');
    const unknown = TT.staleTabs([{ id: 1, url: 'https://a/' }, { id: 2, url: 'https://b/', lastAccessed: 0 }], 3, N);
    assert.strictEqual(unknown.known, false, "no lastAccessed from Safari: can't judge");
    assert.deepStrictEqual(TT.STALE_DAYS, [1, 3, 7, 14]);
  });

  await test("tab ages: Tab Triage's record fills lastAccessed, Safari's own value wins; date text", () => {
    const tabs = [{ id: 1 }, { id: 2, lastAccessed: 500 }, { id: 3 }];
    const out = TT.applyAges(tabs, { 1: 100, 2: 200 });
    assert.strictEqual(JSON.stringify(out.map((t) => t.lastAccessed)), JSON.stringify([100, 500, undefined]));
    assert.strictEqual(tabs[0].lastAccessed, undefined, 'input not modified');
    assert.strictEqual(TT.whenText(new Date(2026, 9, 31, 13, 5).getTime()), '31 Oct, 13:05');
  });

  await test('freed line after a reload', () => {
    const GiB = 1073741824;
    assert.strictEqual(TT.freedLine({ safari: { memory: 21 * GiB } }, { safari: { memory: 19.5 * GiB } }, 3, 'reloading'),
      'Safari freed 1.5 GB after reloading 3 tabs (21.0 GB → 19.5 GB)');
  });

  await test('buildTree: folders by size, Unsorted then Other last, dup counts, sort modes', () => {
    const recs = [
      { id: 1, url: 'https://github.com/a', windowId: 1, index: 3 },
      { id: 2, url: 'https://github.com/a?tab=x', windowId: 1, index: 1 },
      { id: 3, url: 'https://github.com/b', windowId: 1, index: 2 },
      { id: 4, url: '', windowId: 1, index: 0 },
      { id: 5, url: 'https://example.com', windowId: 1, index: 4 },
      { id: 6, url: 'https://claude.ai/x', windowId: 1, index: 5 }
    ].map((t) => TT.describeTab(t, { outline: O }));
    let f = TT.buildTree(recs, { sort: 'path', nearGrouped: true });
    assert.deepStrictEqual(f.map((x) => x.label), ['Dev', 'AI', 'Unsorted', 'Other']);
    assert.strictEqual(f[0].dupExtra, 1);
    f = TT.buildTree(recs, { sort: 'order', nearGrouped: false });
    assert.strictEqual(f[0].dupExtra, 0);
    assert.deepStrictEqual(f[0].groups[0].tabs.map((r) => r.id), [2, 3, 1]);
  });
}

// ---------------------------------------------------------------------------
// Mock Safari
// ---------------------------------------------------------------------------

function makeSafari(initialTabs) {
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let tabs = clone(initialTabs);
  let nextTab = 10000;
  let nextWin = 100;
  const store = {};
  const listeners = [];
  const installed = [];
  const windowsCreated = [];
  const calls = { tabsUpdate: [], windowsUpdate: [], reload: [], remove: [] };
  let failCreate = null; // url => true makes windows.create / tabs.create reject for that URL
  const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), fire: (...a) => ls.forEach((f) => f(...a)) }; };
  const events = { activated: ev(), updated: ev(), created: ev(), removed: ev(), focus: ev(), startup: ev() };
  // Stand-in for the app's native usage handler (04_Build_Tools/native).
  const GiB = 1073741824;
  const native = { mem: 21 * GiB, calls: [], onRemove: null, onReload: null };
  const api = {
    runtime: {
      id: 'tabtriage',
      async sendNativeMessage(app, msg) {
        native.calls.push(clone(msg));
        return {
          ok: true, v: 1, at: Date.now(),
          safari: { memory: native.mem, processes: 30, pages: 27, footprint: true, ...(msg.cpu ? { cpu: 53 } : {}) },
          mac: { ramTotal: 64 * GiB, ramUsed: 46 * GiB, swapUsed: 4.6 * GiB, swapTotal: 6 * GiB, pressure: 'normal' },
          access: { list: true, path: true, rusage: true, taskinfo: false }
        };
      },
      getURL: (p) => 'safari-web-extension://tabtriage/' + p,
      onMessage: { addListener: (f) => listeners.push(f) },
      onStartup: events.startup,
      onInstalled: { addListener: (f) => installed.push(f) },
      async sendMessage(msg) {
        for (const l of listeners) { const r = l(clone(msg), { id: 'tabtriage' }); if (r !== undefined) return clone(await r); }
        return undefined;
      },
      async openOptionsPage() {}
    },
    storage: {
      local: {
        async get(keys) {
          const ks = Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of ks) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(o) { Object.assign(store, clone(o)); }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      async query(q) {
        let r = tabs;
        if (q && typeof q === 'object') {
          for (const k of ['active', 'windowId', 'pinned']) {
            if (k in q) r = r.filter((t) => (k === 'windowId' ? t.windowId === q[k] : !!t[k] === !!q[k]));
          }
        }
        return clone(r);
      },
      onActivated: events.activated, onUpdated: events.updated, onCreated: events.created, onRemoved: events.removed,
      async remove(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        const missing = list.filter((id) => !tabs.some((t) => t.id === id));
        if (missing.length) throw new Error('No tab with id: ' + missing[0]);
        calls.remove.push(list.slice());
        tabs = tabs.filter((t) => !list.includes(t.id));
        if (native.onRemove) native.onRemove(list);
      },
      async reload(id) {
        if (!tabs.some((t) => t.id === id)) throw new Error('No tab with id: ' + id);
        calls.reload.push([id, Date.now()]);
        if (native.onReload) native.onReload(id);
      },
      async create({ windowId, url }) { if (failCreate && failCreate(url)) throw new Error('blocked: ' + url); const t = { id: nextTab++, windowId, index: 99, url, title: url }; tabs.push(t); return clone(t); },
      async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error('No tab with id: ' + id); return clone(t); },
      async update(id, props) { calls.tabsUpdate.push([id, props]); }
    },
    windows: {
      async create({ url }) { if (failCreate && failCreate(url)) throw new Error('blocked: ' + url); const w = { id: nextWin++ }; windowsCreated.push({ id: w.id, first: url }); tabs.push({ id: nextTab++, windowId: w.id, index: 0, url, title: url }); return w; },
      async update(id, props) { calls.windowsUpdate.push([id, props]); },
      onFocusChanged: events.focus
    },
    permissions: { async request() { return true; } }
  };
  const fireInstalled = async (reason) => { for (const f of installed) f({ reason }); await new Promise((r) => setTimeout(r, 20)); };
  return { api, store, calls, native, fireInstalled, getTabs: () => tabs, windowsCreated, killTab: (id) => { tabs = tabs.filter((t) => t.id !== id); }, setFailCreate: (f) => { failCreate = f; }, events };
}

function makeTabs() {
  const out = [];
  let id = 1;
  const add = (url, extra) => out.push({ id: id++, windowId: 1 + (id % 3), index: id, url, title: 'T ' + url, ...extra });
  for (let i = 0; i < 40; i++) add(`https://github.com/org/repo${i % 25}`);
  for (let i = 0; i < 30; i++) add(`https://www.youtube.com/watch?v=v${i % 20}&t=${i}`);
  for (let i = 0; i < 20; i++) add(`https://mail.google.com/mail/u/0/#inbox/${i}`);
  for (let i = 0; i < 20; i++) add(`https://docs.google.com/document/d/${i}/edit`);
  for (let i = 0; i < 25; i++) add(`https://site${i % 12}.com/page`);
  for (let i = 0; i < 10; i++) add(`https://www.wealthsimple.com/app/account/${i}`, { incognito: true });
  add('https://www.tradingview.com/chart/', { pinned: true });
  add('https://github.com/org/repo1', { pinned: true });
  add('', { title: '' });
  add(undefined, { title: undefined });
  add('https://www.youtube.com/watch?v=music', { audible: true });
  add('https://claude.ai/chat/abc');
  add('https://www.bhphotovideo.com/c/buy/lenses');
  return out;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

async function smoke() {
  console.log('Smoke (jsdom + mocked Safari API)');
  const grouping = fs.readFileSync(path.join(EXT, 'lib', 'grouping.js'), 'utf8');
  const safari = makeSafari(makeTabs());

  const bg = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  bg.window.browser = safari.api;
  bg.window.eval(grouping);
  bg.window.eval(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'));
  await safari.fireInstalled('install');

  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'safari-web-extension://tabtriage/popup.html', pretendToBeVisual: true });
  const w = dom.window;
  w.browser = safari.api;
  w.close = () => {};
  w.TT_FREED_DELAY_MS = 10; // don't wait 4 s for the after-close measurement
  const t0 = Date.now();
  w.eval(grouping);
  w.eval(fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8'));
  const d = w.document;
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(5); };
  const q = (s) => d.querySelector(s);
  const qa = (s) => [...d.querySelectorAll(s)];
  const section = (label) => qa('section.group').find((s) => s.querySelector('.glabel').textContent === label);
  await settle();
  console.log(`      init+render ${safari.getTabs().length} tabs: ${Date.now() - t0} ms (jsdom, includes script eval)`);

  const folder = (label) => qa('section.folder').find((x) => x.querySelector('.flabel').textContent === label);
  const group = (label) => qa('section.group').find((x) => x.querySelector('.glabel').textContent === label);
  const openFolder = (label) => { const f = folder(label); if (!f.classList.contains('open')) f.querySelector('.fhead .chev').click(); return folder(label); };
  const openGroup = (label) => { const g = group(label); if (!g.classList.contains('open')) g.querySelector('.ghead .chev').click(); return group(label); };

  await test('install seeds the folder outline once; update keeps edits', async () => {
    assert.strictEqual(safari.store.outline, TT.DEFAULT_OUTLINE);
    safari.store.outline = 'Mine\n  x.com';
    await safari.fireInstalled('update');
    assert.strictEqual(safari.store.outline, 'Mine\n  x.com');
    safari.store.outline = TT.DEFAULT_OUTLINE;
  });

  await test('initial render: only folders, collapsed; Unsorted and Other last; banner', () => {
    const labels = qa('.flabel').map((e) => e.textContent);
    for (const l of ['Dev', 'Watch & Listen', 'Work', 'Google', 'Trading', 'Shopping', 'AI']) assert.ok(labels.includes(l), l);
    assert.deepStrictEqual(labels.slice(-2), ['Unsorted', 'Other']);
    assert.strictEqual(qa('section.group').length, 0, 'folders start collapsed');
    assert.strictEqual(qa('.row').length, 0);
    assert.ok(/tabs in \d+ folders/.test(q('#stats').textContent));
    assert.ok(q('#banners').textContent.includes('hiding the address of 1 tab'));
  });

  await test('single-group folder opens straight to its tabs; multi-group folder shows groups', () => {
    openFolder('Dev');
    assert.strictEqual(group('GitHub').querySelectorAll('.row').length, 41);
    openFolder('Unsorted');
    assert.strictEqual(folder('Unsorted').querySelectorAll('section.group').length, 12);
    assert.strictEqual(folder('Unsorted').querySelectorAll('.row').length, 0);
  });

  await test('group select-all excludes pinned; folder box goes to partial, then full', async () => {
    group('GitHub').querySelector('.gcheck').click();
    await settle();
    assert.strictEqual(q('#btn-close').textContent, 'Close 40');
    const fbox = folder('Dev').querySelector('.fcheck');
    assert.strictEqual(fbox.checked, true);
    q('#btn-clear').click();
    openGroup('GitHub');
    group('GitHub').querySelector('.row:not(.pinned) .rcheck').click();
    assert.strictEqual(folder('Dev').querySelector('.fcheck').indeterminate, true);
    q('#btn-clear').click();
  });

  await test('bulk close: confirm, batched close, refresh, undo bar, pinned survives', async () => {
    openGroup('GitHub');
    group('GitHub').querySelector('.gcheck').click();
    const before = safari.getTabs().length;
    q('#btn-close').click();
    await settle();
    assert.strictEqual(q('#modal').hidden, false);
    assert.ok(q('#modal-msg').textContent.startsWith('Close 40 tabs'));
    q('#modal-ok').click();
    await settle();
    assert.strictEqual(safari.getTabs().length, before - 40);
    assert.ok(safari.getTabs().some((t) => t.pinned && t.url.includes('github.com')));
    assert.ok(q('#undo').textContent.includes('Closed 40 tabs'));
    assert.strictEqual(safari.store.undoBatches.length, 1);
  });

  await test('undo: restores into one window per site', async () => {
    const before = safari.getTabs().length;
    q('#btn-undo').click();
    await settle();
    assert.strictEqual(safari.getTabs().length, before + 40);
    assert.strictEqual(safari.windowsCreated.length, 1);
    assert.strictEqual(safari.store.undoBatches.length, 0);
    assert.strictEqual(q('#undo').hidden, true);
  });

  await test('close a whole folder from its header (pinned kept), private never in undo', async () => {
    const tr = folder('Trading');
    tr.querySelector('.fclose').click();
    await settle();
    assert.ok(q('#modal-msg').textContent.startsWith('Close 10 tabs in Trading'));
    assert.ok(q('#modal-note').textContent.includes("10 private tabs can't be restored"));
    q('#modal-ok').click();
    await settle();
    assert.ok(!safari.getTabs().some((t) => t.incognito));
    assert.ok(safari.getTabs().some((t) => t.pinned && t.url.includes('tradingview')));
    assert.ok(!JSON.stringify(safari.store.undoBatches || []).includes('wealthsimple'));
  });

  await test('filter: matching folders open to matches; others dim with hidden counts; empty message', async () => {
    const input = q('#q');
    input.value = 'youtube';
    input.dispatchEvent(new w.Event('input'));
    assert.ok(folder('Watch & Listen').classList.contains('open'));
    assert.ok(group('YouTube').classList.contains('open'));
    assert.ok(folder('Google').classList.contains('dim'));
    assert.ok(folder('Google').textContent.includes('20 hidden'));
    assert.strictEqual(qa('.flabel')[0].textContent, 'Watch & Listen');
    input.value = 'zzzz-nothing';
    input.dispatchEvent(new w.Event('input'));
    assert.ok(q('#list').textContent.includes('No tabs match your search'));
    input.value = '';
    input.dispatchEvent(new w.Event('input'));
  });

  await test('select-all while filtering only selects visible matches (group and folder)', async () => {
    const input = q('#q');
    input.value = 'repo1';
    input.dispatchEvent(new w.Event('input'));
    const visible = group('GitHub').querySelectorAll('.row:not(.pinned)').length;
    folder('Dev').querySelector('.fcheck').click();
    await settle();
    assert.strictEqual(q('#btn-close').textContent, `Close ${visible}`);
    q('#btn-clear').click();
    input.value = '';
    input.dispatchEvent(new w.Event('input'));
  });

  await test('select dupes keeps one per exact cluster, skips pinned, takes every blank tab', async () => {
    q('#btn-dupes').click();
    await settle();
    const n = Number((q('#btn-close').textContent.match(/\d+/) || [0])[0]);
    // github 40 over 25 repos -> 15 (+1: repo1 unpinned copies both go, pinned kept); youtube 30 over 20 -> 10;
    // site*.com 25 over 12 sites -> 13; blank 1 -> 1. Gmail #inbox/<id> tabs are all different.
    assert.strictEqual(n, 15 + 1 + 10 + 13 + 1);
    assert.ok(folder('Unsorted').classList.contains('open'), 'folders with selected dupes open');
    q('#btn-clear').click();
  });

  await test('stale tab: batch rejected, per-tab retry closes the rest', async () => {
    openFolder('Google');
    const gm = group('Gmail');
    assert.ok(gm && gm.classList.contains('open'), 'single-group folder opened to Gmail');
    gm.querySelector('.gcheck').click();
    const firstId = Number(group('Gmail').querySelector('.row').dataset.id);
    safari.killTab(firstId);
    q('#btn-close').click();
    await settle();
    q('#modal-ok').click();
    await settle();
    assert.ok(!safari.getTabs().some((t) => /mail\.google\.com/.test(t.url || '')));
    assert.ok(!q('#toast').textContent.includes("couldn't be closed"));
  });

  await test('expired undo batches are dropped silently', async () => {
    assert.ok(safari.store.undoBatches.length >= 1);
    safari.store.undoBatches.forEach((b) => { b.expiresAt = Date.now() - 1; });
    const st = await safari.api.runtime.sendMessage({ type: 'undoState' });
    assert.strictEqual(st.batches.length, 0);
    assert.strictEqual(safari.store.undoBatches.length, 0);
  });

  await test('arrow on a row jumps to that tab without ticking it', async () => {
    openFolder('Watch & Listen');
    const row = openGroup('YouTube').querySelector('.row');
    const id = Number(row.dataset.id);
    const box = row.querySelector('.rcheck');
    const before = box.checked;
    row.querySelector('.goto').click();
    await settle();
    assert.strictEqual(box.checked, before);
    assert.strictEqual(JSON.stringify(safari.calls.tabsUpdate.at(-1)), JSON.stringify([id, { active: true }]));
    assert.strictEqual(JSON.stringify(safari.calls.windowsUpdate.at(-1)[1]), JSON.stringify({ focused: true }));
  });

  await test('double-click a row switches to that tab; the selection ends where it started', async () => {
    const row = openGroup('YouTube').querySelectorAll('.row')[1];
    const id = Number(row.dataset.id);
    const box = row.querySelector('.rcheck');
    const before = box.checked;
    const title = row.querySelector('.title');
    title.click();
    title.click();
    title.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await settle();
    assert.strictEqual(box.checked, before);
    assert.strictEqual(row.classList.contains('sel'), before);
    assert.strictEqual(JSON.stringify(safari.calls.tabsUpdate.at(-1)), JSON.stringify([id, { active: true }]));
    assert.strictEqual(JSON.stringify(safari.calls.windowsUpdate.at(-1)[1]), JSON.stringify({ focused: true }));
    const n = safari.calls.tabsUpdate.length;
    row.querySelector('.rcheck').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await settle();
    assert.strictEqual(safari.calls.tabsUpdate.length, n, 'double-clicking the checkbox itself only ticks');
  });

  await test('toggles persist: sort order, near-dups off', async () => {
    q('#tg-sort').click();
    assert.strictEqual(q('#tg-sort').textContent, 'Sort: Order');
    q('#tg-near').click();
    assert.strictEqual(q('#tg-near').textContent, 'Near-dups: Off');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(safari.store.settings)), { showPrivate: true, sort: 'order', nearGrouped: false, staleDays: 3 });
  });

  await test('Usage button: Safari-wide memory and CPU, Mac memory and swap; only {type, cpu} goes to the app', async () => {
    assert.strictEqual(q('#meter').hidden, true);
    q('#btn-usage').click();
    await settle();
    assert.strictEqual(q('#meter').hidden, false);
    assert.strictEqual(q('#meter .m-line').textContent, 'Safari 21.0 GB · CPU 53% · Mac 46.0 of 64.0 GB · Swap 4.6 GB');
    assert.strictEqual(q('#btn-usage').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(JSON.stringify(safari.native.calls.at(-1)), JSON.stringify({ type: 'usage', cpu: true }));
  });

  await test('Usage meter: closing tabs reports how much memory Safari freed', async () => {
    const GiB = 1073741824;
    safari.native.onRemove = () => { safari.native.mem -= 1.8 * GiB; };
    const f = openFolder('Dev');
    const box = f.querySelector('.row .rcheck:not([disabled])');
    box.click();
    await settle();
    q('#btn-close').click();
    await settle();
    q('#modal-ok').click();
    await settle();
    await tick(40);
    await settle();
    assert.strictEqual(q('#meter .m-freed').textContent, 'Safari freed 1.8 GB after closing 1 tab (21.0 GB → 19.2 GB)');
    assert.ok(q('#meter .m-line').textContent.startsWith('Safari 19.2 GB · CPU 53%'));
    assert.strictEqual(JSON.stringify(safari.native.calls.slice(-2)), JSON.stringify([{ type: 'usage', cpu: false }, { type: 'usage', cpu: false }]));
    safari.native.onRemove = null;
  });

  await test('HTML in titles is escaped', async () => {
    const s2 = makeSafari([{ id: 1, windowId: 1, index: 0, url: 'https://evil.com/', title: '<img src=x onerror=alert(1)>' }]);
    const dom2 = new JSDOM(html, { runScripts: 'outside-only', url: 'safari-web-extension://tabtriage/popup.html' });
    dom2.window.browser = s2.api;
    dom2.window.eval(grouping);
    dom2.window.eval(fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8'));
    await settle();
    dom2.window.document.querySelector('.fhead .chev').click();
    assert.strictEqual(dom2.window.document.querySelectorAll('.row').length, 1);
    assert.strictEqual(dom2.window.document.querySelectorAll('.row img:not(.fav)').length, 0);
    dom2.window.close();
  });

  w.close(); bg.window.close();
}

// ---------------------------------------------------------------------------
// Settings organizer (options page) smoke test
// ---------------------------------------------------------------------------

async function organizer() {
  console.log('Organizer (settings page, jsdom + mocked Safari API)');
  const grouping = fs.readFileSync(path.join(EXT, 'lib', 'grouping.js'), 'utf8');
  const tabs = makeTabs();
  tabs.push({ id: 900, windowId: 9, index: 0, url: 'https://secretbank.example/login', title: 'secret', incognito: true });
  const safari = makeSafari(tabs);
  safari.store.outline = TT.DEFAULT_OUTLINE;
  const html = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'safari-web-extension://tabtriage/options.html', pretendToBeVisual: true });
  const w = dom.window;
  w.browser = safari.api;
  w.eval(grouping);
  w.eval(fs.readFileSync(path.join(EXT, 'options.js'), 'utf8'));
  const d = w.document;
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(3); };
  const q = (s) => d.querySelector(s);
  const qa = (s) => [...d.querySelectorAll(s)];
  const folderRow = (name) => qa('.frow').find((r) => r.querySelector('.fname').textContent === name);
  const card = (name) => qa('.card').find((c) => { const n = c.querySelector('.gname'); return n && n.textContent === name; });
  const traySite = (s) => q(`.usite[data-site="${s}"]`);
  const where = (url) => {
    const r = TT.describeTab({ id: 1, url, title: 't' }, { outline: TT.compileOutline(safari.store.outline) });
    return `${r.folderLabel} / ${r.label}`;
  };
  const key = (el, k, meta) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, metaKey: !!meta, bubbles: true, cancelable: true }));
  const rename = async (value) => { const inp = q('input.rename'); assert.ok(inp, 'rename box open'); inp.value = value; key(inp, 'Enter'); await settle(); };
  /** Fire a full HTML5 drag: dragstart on src (skipped for drags from outside the page), then dragover/drop on dst. */
  function drag(src, dst, outside) {
    const data = {};
    const dt = outside || {
      types: [], effectAllowed: 'all', dropEffect: 'none', setDragImage() {},
      setData(k, v) { data[k] = v; this.types = Object.keys(data); }, getData: (k) => data[k] || ''
    };
    const fire = (el, type) => {
      const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
      return ev;
    };
    if (src) fire(src, 'dragstart');
    fire(dst, 'dragenter');
    const ok = fire(dst, 'dragover').defaultPrevented;
    if (ok) fire(dst, 'drop');
    if (src) fire(src, 'dragend');
    return ok;
  }
  await settle();

  await test('layout: folders left, first folder open, Unsorted lists open sites in no folder (private skipped)', () => {
    assert.deepStrictEqual(qa('.fname').map((e) => e.textContent), TT.outlineToModel(TT.DEFAULT_OUTLINE).folders.map((f) => f.name));
    assert.strictEqual(q('.frow.sel .fname').textContent, 'Shopping');
    assert.strictEqual(q('.pname').textContent, 'Shopping');
    assert.ok(card('Amazon') && card('Electronics'));
    const sites = qa('.usite').map((e) => e.dataset.site);
    assert.strictEqual(sites.length, 12);
    assert.strictEqual(sites[0], 'site0.com', 'most open tabs first');
    assert.ok(!sites.some((s) => s.includes('secretbank')));
    assert.strictEqual(folderRow('Dev').querySelector('.fcount').textContent, '41', 'open tabs per folder');
  });

  await test('drag an Unsorted site onto a folder: saved at once, the popup places it there', async () => {
    assert.strictEqual(drag(traySite('site0.com'), folderRow('AI')), true);
    await settle();
    assert.strictEqual(where('https://site0.com/page'), 'AI / Site0');
    assert.strictEqual(traySite('site0.com'), null);
    assert.strictEqual(qa('.usite').length, 11);
    assert.ok(q('#status').textContent.includes('Added site0.com to AI.'));
    assert.strictEqual(q('#undo').disabled, false);
    assert.strictEqual(drag(folderRow('AI'), q('.card')), false, 'a folder does not drop into a group');
  });

  await test('drag onto a group card, or use Move to… into a group', async () => {
    assert.strictEqual(drag(traySite('site1.com'), card('Amazon')), true);
    await settle();
    assert.strictEqual(where('https://site1.com/page'), 'Shopping / Amazon');
    const sel = traySite('site2.com').querySelector('select.moveto');
    sel.value = [...sel.options].find((o) => o.textContent === 'Shopping › Electronics').value;
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    assert.strictEqual(where('https://site2.com/page'), 'Shopping / Electronics');
  });

  await test('Undo button and ⌘Z step back one change at a time', async () => {
    q('#undo').click();
    await settle();
    assert.strictEqual(where('https://site2.com/page'), 'Unsorted / Site2');
    key(d.body, 'z', true);
    await settle();
    assert.strictEqual(where('https://site1.com/page'), 'Unsorted / Site1');
    assert.strictEqual(where('https://site0.com/page'), 'AI / Site0');
  });

  await test('new folder and new group are named in place; an empty group is kept', async () => {
    q('#addfolder').click();
    await rename('Reading');
    assert.strictEqual(q('.frow.sel .fname').textContent, 'Reading');
    assert.strictEqual(qa('.fname').at(-1).textContent, 'Reading');
    q('[data-act="add-group"]').click();
    await rename('Later');
    assert.ok(safari.store.outline.includes('\nReading\n  Later:\n'), 'empty group saved');
    assert.strictEqual(TT.parseOutline(safari.store.outline).errors.length, 0);
  });

  await test('drop in a gap places a site there; onto a site groups the two; onto Unsorted takes it out', async () => {
    assert.strictEqual(drag(traySite('site3.com'), q('.slot[data-slot="1"]')), true);
    await settle();
    assert.strictEqual(where('https://site3.com/page'), 'Reading / Site3');
    assert.strictEqual(drag(traySite('site4.com'), q('.item[data-drop="site"]')), true);
    await settle();
    assert.strictEqual(where('https://site4.com/page'), 'Reading / Site3');
    assert.ok(card('Site3'), 'new group named after the site it was dropped on');
    assert.strictEqual(drag(card('Site3').querySelector('.chip[data-site="site4.com"]'), q('#tray')), true);
    await settle();
    assert.strictEqual(where('https://site4.com/page'), 'Unsorted / Site4');
    assert.strictEqual(drag(card('Later'), q('#tray')), true);
    await settle();
    assert.ok(!safari.store.outline.includes('Later:'));
  });

  await test('reorder groups by dropping one on another, folders in the sidebar, groups across folders', async () => {
    folderRow('Shopping').click();
    assert.strictEqual(drag(card('Stores'), card('Amazon')), true);
    await settle();
    assert.deepStrictEqual(qa('.gname').map((e) => e.textContent).slice(0, 2), ['Stores', 'Amazon']);
    assert.strictEqual(drag(folderRow('Reading'), folderRow('Shopping')), true);
    await settle();
    assert.strictEqual(qa('.fname')[0].textContent, 'Reading');
    assert.strictEqual(q('.frow.sel .fname').textContent, 'Shopping', 'selection stays put');
    assert.strictEqual(drag(card('Stores'), folderRow('Reading')), true);
    await settle();
    assert.strictEqual(where('https://www.bestbuy.ca/x'), 'Reading / Stores');
  });

  await test('rename refuses duplicates; delete folder, then Undo brings it back', async () => {
    folderRow('Reading').click();
    q('.pname').click();
    await rename('shopping');
    assert.ok(q('#status').textContent.includes("There's already a folder called shopping"));
    await rename('Later reads');
    assert.strictEqual(q('.pname').textContent, 'Later reads');
    q('[data-act="delete-folder"]').click();
    await settle();
    assert.strictEqual(folderRow('Later reads'), undefined);
    assert.strictEqual(where('https://www.bestbuy.ca/x'), 'Unsorted / Best Buy');
    q('#undo').click();
    await settle();
    assert.strictEqual(where('https://www.bestbuy.ca/x'), 'Later reads / Stores');
  });

  await test('a link dragged in from a web page files its site', async () => {
    const link = { types: ['text/uri-list'], dropEffect: 'none', getData: (k) => (k === 'text/uri-list' ? 'https://news.example.org/story/1' : '') };
    assert.strictEqual(drag(null, folderRow('Later reads'), link), true);
    await settle();
    assert.strictEqual(where('https://news.example.org/a'), 'Later reads / Example');
  });

  await test('Edit as text: unreadable lines are refused, good edits save and the organizer follows', async () => {
    q('#astext').click();
    assert.strictEqual(q('#org').hidden, true);
    const ta = q('#outline');
    assert.strictEqual(ta.value, safari.store.outline);
    const before = safari.store.outline;
    ta.value = before + '\nBroken\n  not a site!\n';
    q('#save').click();
    await settle();
    assert.ok(q('#status').textContent.startsWith('Not saved.'));
    assert.strictEqual(safari.store.outline, before);
    ta.value = before + '\nPodcasts\n  overcast.fm\n';
    q('#save').click();
    await settle();
    assert.ok(safari.store.outline.includes('Podcasts'));
    q('#back').click();
    assert.strictEqual(q('#org').hidden, false);
    assert.ok(folderRow('Podcasts'));
  });

  await test('only the outline is stored, nothing private; names render as text, not HTML', async () => {
    assert.deepStrictEqual(Object.keys(safari.store), ['outline']);
    assert.ok(!JSON.stringify(safari.store).includes('secretbank'));
    folderRow('Podcasts').click();
    q('.pname').click();
    await rename('<img src=x onerror=alert(1)>');
    assert.strictEqual(qa('#folders img, #pane img').length, 0);
    assert.ok(qa('.fname').some((e) => e.textContent.startsWith('<img')));
  });

  w.close();
}

// ---------------------------------------------------------------------------
// Sessions: Save session in the popup, then the sessions page
// ---------------------------------------------------------------------------

async function sessions() {
  console.log('Sessions (popup + sessions page, jsdom + mocked Safari API)');
  const grouping = fs.readFileSync(path.join(EXT, 'lib', 'grouping.js'), 'utf8');
  const safari = makeSafari(makeTabs());
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(4); };

  const bg = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  bg.window.browser = safari.api;
  bg.window.eval(grouping);
  bg.window.eval(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'));
  const FIXED = new Date(2026, 8, 25, 22, 19, 5).getTime();
  bg.window.eval(`Date.now = () => ${FIXED};`); // both saves land in the same minute

  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const pop = new JSDOM(html, { runScripts: 'outside-only', url: 'safari-web-extension://tabtriage/popup.html', pretendToBeVisual: true });
  pop.window.browser = safari.api;
  pop.window.close = () => {};
  pop.window.eval(grouping);
  pop.window.eval(fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8'));
  await settle();
  const pq = (s) => pop.window.document.querySelector(s);

  await test('Save session: named SafariSession_MMDD-HH:MM, window by window, private tabs never written', async () => {
    pq('#btn-session').click();
    await settle();
    const all = safari.store.sessions;
    assert.strictEqual(all.length, 1);
    const s = all[0];
    assert.strictEqual(s.name, 'SafariSession_0925-22:19');
    assert.strictEqual(s.windows.length, 3);
    assert.strictEqual(s.windows.reduce((a, w) => a + w.tabs.length, 0), 138);
    assert.strictEqual(s.pinned.length, 2);
    assert.ok(!JSON.stringify(all).includes('wealthsimple'), 'the only Wealthsimple tabs are private');
    assert.strictEqual(pq('#toast').textContent,
      'Saved SafariSession_0925-22:19: 140 tabs from 3 windows, 2 pinned. 10 private tabs not saved, 2 blank or hidden tabs skipped. View sessions');
    pq('#btn-session').click();
    await settle();
    assert.strictEqual(safari.store.sessions[0].name, 'SafariSession_0925-22:19 (2)', 'same minute: numbered, newest first');
    pq('#toast .link').click();
    await settle();
    assert.ok(safari.getTabs().some((t) => t.url === 'safari-web-extension://tabtriage/sessions.html'), 'View sessions opens the page');
  });

  const shtml = fs.readFileSync(path.join(EXT, 'sessions.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const page = new JSDOM(shtml, { runScripts: 'outside-only', url: 'safari-web-extension://tabtriage/sessions.html', pretendToBeVisual: true });
  page.window.browser = safari.api;
  page.window.eval(fs.readFileSync(path.join(EXT, 'sessions.js'), 'utf8'));
  await settle();
  const q = (s) => page.window.document.querySelector(s);
  const qa = (s) => [...page.window.document.querySelectorAll(s)];

  await test('sessions page: lists newest first; Restore asks once, then opens every window (pinned already open skipped)', async () => {
    assert.deepStrictEqual(qa('.sname').map((e) => e.textContent), ['SafariSession_0925-22:19 (2)', 'SafariSession_0925-22:19']);
    q('.sess .chev').click();
    assert.deepStrictEqual(qa('.sess.open .wname').map((e) => e.textContent), ['Pinned', 'Window 1', 'Window 2', 'Window 3']);
    assert.strictEqual(qa('.sess.open .tabs li').length, 140);
    assert.strictEqual(qa('.sess.open .tabs a').every((a) => /^https:/.test(a.getAttribute('href'))), true);
    const wins = safari.windowsCreated.length;
    const before = safari.getTabs().length;
    q('.sess [data-act="restore"]').click();
    assert.strictEqual(q('.sess [data-act="restore"]').textContent, 'Open 140 tabs?');
    assert.strictEqual(safari.windowsCreated.length, wins, 'nothing opens on the first click');
    q('.sess [data-act="restore"]').click();
    await settle();
    assert.strictEqual(safari.windowsCreated.length, wins + 3);
    assert.strictEqual(safari.getTabs().length, before + 138);
    assert.strictEqual(q('#status').textContent, 'Opened 138 tabs. 2 pinned tabs already open.');
  });

  await test('sessions page: open one window, rename, delete (asks once)', async () => {
    const wins = safari.windowsCreated.length;
    q('.sess.open [data-act="restore-part"][data-part="0"]').click();
    await settle();
    assert.strictEqual(safari.windowsCreated.length, wins + 1);
    q('.sess [data-act="rename"]').click();
    const inp = q('input.rename');
    inp.value = 'Before cleanup';
    inp.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert.strictEqual(safari.store.sessions[0].name, 'Before cleanup');
    assert.strictEqual(q('.sname').textContent, 'Before cleanup');
    const del = () => qa('.sess')[1].querySelector('[data-act="delete"]');
    del().click();
    assert.strictEqual(del().textContent, 'Delete?');
    del().click();
    await settle();
    assert.strictEqual(safari.store.sessions.length, 1);
    assert.strictEqual(qa('.sess').length, 1);
  });

  page.window.close(); bg.window.close();
}

// ---------------------------------------------------------------------------
// Memory relief: Refresh stale and Reset tabs
// ---------------------------------------------------------------------------

async function memory() {
  console.log('Memory relief (Refresh stale, Reset tabs; jsdom + mocked Safari API)');
  const grouping = fs.readFileSync(path.join(EXT, 'lib', 'grouping.js'), 'utf8');
  const bgCode = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const popCode = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(4); };
  const GiB = 1073741824;
  const NOW = Date.now();
  const D = 86400000;
  const GAP = 25;
  const memTabs = () => [
    { id: 1, windowId: 1, index: 0, url: 'https://github.com/a', title: 'A', active: true, lastAccessed: NOW - 6 * D },
    { id: 2, windowId: 1, index: 1, url: 'https://github.com/b', title: 'B', lastAccessed: NOW - 5 * D },
    { id: 3, windowId: 1, index: 2, url: 'https://www.tradingview.com/chart/', title: 'TV', pinned: true, lastAccessed: NOW - 9 * D },
    { id: 4, windowId: 1, index: 3, url: 'https://www.youtube.com/watch?v=m', title: 'Music', audible: true, lastAccessed: NOW - 8 * D },
    { id: 5, windowId: 1, index: 4, url: 'https://claude.ai/chat/x', title: 'Claude', lastAccessed: NOW - 3600e3 },
    { id: 6, windowId: 2, index: 0, url: 'https://news.ycombinator.com/', title: 'HN', active: true, lastAccessed: NOW - 60e3 },
    { id: 7, windowId: 2, index: 1, url: 'https://www.bhphotovideo.com/c/x', title: 'B&H', lastAccessed: NOW - 10 * D },
    { id: 8, windowId: 2, index: 2, url: '', title: '', lastAccessed: NOW - 12 * D },
    { id: 9, windowId: 3, index: 0, url: 'https://www.wealthsimple.com/app', title: 'WS', incognito: true, active: true, lastAccessed: NOW - 4 * D },
    { id: 10, windowId: 3, index: 1, url: 'https://www.wealthsimple.com/app/tfsa', title: 'TFSA', incognito: true, lastAccessed: NOW - 4 * D }
  ];
  const doms = [];
  function setup(tabs) {
    const safari = makeSafari(tabs);
    const bg = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    bg.window.browser = safari.api;
    bg.window.TT_RELOAD_GAP_MS = GAP;
    bg.window.eval(grouping);
    bg.window.eval(bgCode);
    doms.push(bg);
    return { safari, popup: () => openPopup(safari) };
  }
  async function openPopup(safari) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'safari-web-extension://tabtriage/popup.html', pretendToBeVisual: true });
    dom.window.browser = safari.api;
    dom.window.close = () => {};
    dom.window.TT_FREED_DELAY_MS = 10;
    dom.window.eval(grouping);
    dom.window.eval(popCode);
    doms.push(dom);
    await settle();
    const q = (sel) => dom.window.document.querySelector(sel);
    return { w: dom.window, q };
  }

  const A = setup(memTabs());
  const P = await A.popup();

  await test('Refresh stale: 3 days by default; confirm names the count and the skips; reloads oldest first, ~gap apart', async () => {
    assert.strictEqual(P.q('#stale-days').value, '3');
    assert.strictEqual(P.q('#btn-stale').textContent, 'Refresh stale');
    P.q('#btn-stale').click();
    await settle();
    assert.strictEqual(P.q('#modal').hidden, false);
    assert.strictEqual(P.q('#modal-msg').textContent, 'Reload 3 tabs open 3+ days?');
    assert.strictEqual(P.q('#modal-note').textContent, 'Unsaved form text will be lost. Skipped: 2 active tabs, 1 pinned, 1 playing audio.');
    assert.strictEqual(P.q('#modal-ok').textContent, 'Reload 3');
    P.q('#modal-ok').click();
    await tick(GAP * 3 + 40);
    await settle();
    const r = A.safari.calls.reload;
    assert.deepStrictEqual(r.map((x) => x[0]), [7, 2, 10], 'oldest first; private stale tabs reload too');
    assert.ok(r[1][1] - r[0][1] >= GAP - 5 && r[2][1] - r[1][1] >= GAP - 5, 'staggered');
    assert.ok(P.q('#toast').textContent.startsWith('Reloaded 3 tabs.'));
  });

  await test('Refresh stale: threshold choice is saved; Cancel reloads nothing; nothing stale says so', async () => {
    const sel = P.q('#stale-days');
    sel.value = '7';
    sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
    await settle();
    assert.strictEqual(A.safari.store.settings.staleDays, 7);
    const n = A.safari.calls.reload.length;
    P.q('#btn-stale').click();
    await settle();
    assert.strictEqual(P.q('#modal-msg').textContent, 'Reload 1 tab open 7+ days?');
    P.q('#modal-cancel').click();
    await settle();
    assert.strictEqual(A.safari.calls.reload.length, n);
    sel.value = '14';
    sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
    P.q('#btn-stale').click();
    await settle();
    assert.strictEqual(P.q('#modal').hidden, true);
    assert.strictEqual(P.q('#toast').textContent, 'No tabs unused for 14+ days.');
    const again = await A.popup();
    assert.strictEqual(again.q('#stale-days').value, '14', 'a new popup remembers it');
    sel.value = '3';
    sel.dispatchEvent(new P.w.Event('change', { bubbles: true }));
  });

  await test('Refresh stale with the Usage meter on: "Safari freed X after reloading N tabs"', async () => {
    P.q('#btn-usage').click();
    await settle();
    A.safari.native.onReload = () => { A.safari.native.mem -= 0.5 * GiB; };
    P.q('#btn-stale').click();
    await settle();
    P.q('#modal-ok').click();
    await tick(GAP * 3 + 60);
    await settle();
    assert.strictEqual(P.q('#meter .m-freed').textContent, 'Safari freed 1.5 GB after reloading 3 tabs (21.0 GB → 19.5 GB)');
    A.safari.native.onReload = null;
  });

  await test("Safari reports no lastAccessed: Tab Triage's own record is used; right after it starts nothing is stale, and it says from when", async () => {
    const B = setup(memTabs().map(({ lastAccessed, ...t }) => t));
    const p = await B.popup();
    p.q('#btn-stale').click();
    await settle();
    assert.strictEqual(p.q('#modal').hidden, true);
    const since = B.safari.store.tabUsedSince;
    assert.strictEqual(typeof since, 'number');
    assert.strictEqual(p.q('#toast').textContent,
      `No tabs unused for 3+ days yet. Tab Triage started counting ${TT.whenText(since)}; tabs can count as stale from ${TT.whenText(since + 3 * D)}.`);
    assert.strictEqual(B.safari.calls.reload.length, 0);
    assert.strictEqual(JSON.stringify(Object.keys(B.safari.store.tabUsed).map(Number).sort((a, b) => a - b)),
      JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]), 'private tabs (9, 10) never written');
  });

  await test('tracked ages: viewing, loading or focusing a tab makes it fresh; old ones reload', async () => {
    const B = setup(memTabs().map(({ lastAccessed, ...t }) => t));
    const p = await B.popup();
    const used = B.safari.store.tabUsed;
    for (const k of Object.keys(used)) used[k] = NOW - 5 * D; // as if tracked 5 days ago
    B.safari.events.activated.fire({ tabId: 2, windowId: 1 });       // viewed
    B.safari.events.updated.fire(5, { status: 'complete' }, { id: 5, incognito: false }); // reloaded
    await settle();
    p.q('#btn-stale').click();
    await settle();
    assert.strictEqual(p.q('#modal-msg').textContent, 'Reload 1 tab open 3+ days?', 'only B&H (7) is old, unused and not skipped');
    p.q('#modal-ok').click();
    await tick(40);
    await settle();
    assert.strictEqual(JSON.stringify(B.safari.calls.reload.map((x) => x[0])), JSON.stringify([7]));
    B.safari.events.focus.fire(2);                                    // window 2 to the front: its active tab is fresh
    await settle();
    assert.ok(B.safari.store.tabUsed[6] > NOW - D);
    B.safari.events.removed.fire(4);
    await settle();
    assert.ok(!(4 in B.safari.store.tabUsed), 'closed tabs are dropped');
  });

  await test('a Safari launch starts the ages over (tab ids restart then)', async () => {
    const B = setup(memTabs().map(({ lastAccessed, ...t }) => t));
    await B.safari.api.runtime.sendMessage({ type: 'tabAges' });
    for (const k of Object.keys(B.safari.store.tabUsed)) B.safari.store.tabUsed[k] = NOW - 9 * D;
    B.safari.store.tabUsedSince = NOW - 9 * D;
    B.safari.events.startup.fire();
    await settle();
    assert.ok(Object.values(B.safari.store.tabUsed).every((v) => v > NOW - D));
    assert.ok(B.safari.store.tabUsedSince > NOW - D);
  });

  await test('Reset tabs: confirm warns about private tabs; saves, closes every non-pinned tab in one batch, reopens; session removed when all came back', async () => {
    const C = setup(memTabs());
    const p = await C.popup();
    assert.strictEqual(p.q('#btn-reset').textContent, 'Reset tabs');
    p.q('#btn-reset').click();
    await settle();
    assert.strictEqual(p.q('#modal-msg').textContent, "Reset 9 tabs? They close and reopen fresh, which frees the memory they've built up.");
    assert.strictEqual(p.q('#modal-note').textContent, "Your tabs are saved as a session first. Pinned tabs stay open. 2 private tabs will close and can't be restored. 1 blank or Safari page won't come back. Unsaved form text will be lost.");
    assert.strictEqual(p.q('#modal-ok').textContent, 'Reset 9');
    p.q('#modal-ok').click();
    await settle();
    await settle();
    assert.strictEqual(C.safari.calls.remove.length, 1, 'one batched close');
    assert.deepStrictEqual(C.safari.calls.remove[0].slice().sort((a, b) => a - b), [1, 2, 4, 5, 6, 7, 8, 9, 10]);
    const after = C.safari.getTabs();
    assert.ok(after.some((t) => t.id === 3 && t.pinned), 'pinned tab never closed');
    assert.ok(!after.some((t) => t.incognito), 'private tabs closed');
    assert.deepStrictEqual(after.filter((t) => t.id !== 3).map((t) => t.url).sort(),
      ['https://claude.ai/chat/x', 'https://github.com/a', 'https://github.com/b', 'https://news.ycombinator.com/',
        'https://www.bhphotovideo.com/c/x', 'https://www.youtube.com/watch?v=m']);
    assert.strictEqual(C.safari.windowsCreated.length, 2, 'one new window per saved window');
    assert.strictEqual(C.safari.store.sessions.length, 0, 'everything came back: snapshot removed');
    assert.strictEqual(C.safari.store.lastReset, null, 'result shown once, then cleared');
    assert.strictEqual(p.q('#toast').textContent, 'Reset done: closed 9 tabs and reopened 6 (1 pinned stayed open).');
    assert.ok(!JSON.stringify(C.safari.store).includes('wealthsimple'), 'nothing about private tabs stored');
  });

  await test('Reset tabs: a page that fails to reopen keeps the session in Sessions; the next popup reports it once', async () => {
    const E = setup(memTabs());
    E.safari.setFailCreate((url) => url.includes('bhphotovideo'));
    const res = await E.safari.api.runtime.sendMessage({ type: 'resetTabs' }); // its popup is gone by now
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.kept, true);
    assert.strictEqual(E.safari.store.sessions.length, 1);
    const name = E.safari.store.sessions[0].name;
    assert.ok(/^SafariSession_\d{4}-\d{2}:\d{2}$/.test(name));
    const p = await E.popup();
    assert.strictEqual(p.q('#toast').textContent,
      `Reset closed 9 tabs but reopened 5, 1 failed to open. They're saved as ${name} in Sessions. View sessions`);
    assert.ok(p.q('#toast').classList.contains('err'));
    assert.strictEqual(E.safari.store.lastReset, null);
    const p2 = await E.popup();
    assert.ok(!p2.q('#toast').textContent.includes('Reset'), 'reported once only');
  });

  await test("Reset tabs: if the session can't be saved, nothing is closed", async () => {
    const F = setup([
      { id: 1, windowId: 1, index: 0, url: 'https://www.wealthsimple.com/app', title: 'WS', incognito: true, active: true },
      { id: 2, windowId: 1, index: 1, url: '', title: '' }
    ]);
    const p = await F.popup();
    p.q('#btn-reset').click();
    await settle();
    assert.strictEqual(p.q('#modal-note').textContent, "Your tabs are saved as a session first. 1 private tab will close and can't be restored. 1 blank or Safari page won't come back. Unsaved form text will be lost.");
    p.q('#modal-ok').click();
    await settle();
    assert.strictEqual(F.safari.calls.remove.length, 0);
    assert.strictEqual(F.safari.getTabs().length, 2);
    assert.ok(p.q('#toast').textContent.startsWith("Reset didn't run: No open web pages to save"));
  });

  for (const d of doms) d.window.close();
}

(async () => {
  try {
    await unit();
    await smoke();
    await organizer();
    await sessions();
    await memory();
    console.log(`\n${passed} passed`);
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL', e);
    process.exit(1);
  }
})();
