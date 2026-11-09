/**
 * Tab Triage: grouping, labels, folders (outline), duplicate detection.
 *
 * Pure functions, no browser APIs. The same file runs in the popup
 * (exposed as globalThis.TT) and in Node tests (module.exports).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Domain grouping
  // ---------------------------------------------------------------------------

  /**
   * Multi-label public suffixes, plus hosting platforms where every subdomain
   * is a separate site. Compact subset of the Public Suffix List; anything not
   * listed falls back to "last two labels".
   */
  const PUBLIC_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'nhs.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr',
    'com.br', 'com.mx', 'com.ar', 'com.co', 'co.in', 'gov.in', 'com.sg', 'com.hk', 'com.tw',
    'com.cn', 'co.za', 'com.tr', 'co.il', 'com.my', 'com.ph', 'com.vn', 'co.th', 'com.pk',
    'gc.ca', 'on.ca', 'qc.ca', 'bc.ca', 'ab.ca', 'mb.ca', 'sk.ca', 'ns.ca', 'nb.ca',
    'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
    'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'wordpress.com', 'tumblr.com',
    'substack.com', 'myshopify.com', 'notion.site', 'wixsite.com', 'carrd.co', 'glitch.me',
    'fly.dev', 'onrender.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com',
    's3.amazonaws.com', 'streamlit.app', 'hf.space', 'readthedocs.io', 'gitbook.io', 'webflow.io'
  ]);

  /** Registrable domains that host unrelated apps on subdomains; split one level down. */
  const SPLIT_DOMAINS = new Set([
    'google.com', 'google.ca', 'apple.com', 'microsoft.com', 'live.com', 'office.com',
    'amazon.com', 'amazon.ca', 'adobe.com', 'yahoo.com', 'mozilla.org', 'atlassian.net',
    'zoom.us', 'sharepoint.com', 'stackexchange.com', 'cloudflare.com', 'salesforce.com',
    'force.com', 'intuit.com'
  ]);

  /** Domains that are the same site under another name. */
  const GROUP_ALIASES = {
    'youtu.be': 'youtube.com', 'twitter.com': 'x.com', 'threads.net': 'threads.com',
    'rbcroyalbank.com': 'rbc.com', 'githubusercontent.com': 'github.com', 'redd.it': 'reddit.com'
  };

  /** Human labels keyed by group key (registrable domain or split subdomain). */
  const LABELS = {
    // Google
    'google.com': 'Google', 'google.ca': 'Google', 'mail.google.com': 'Gmail',
    'docs.google.com': 'Google Docs', 'drive.google.com': 'Google Drive',
    'calendar.google.com': 'Google Calendar', 'meet.google.com': 'Google Meet',
    'photos.google.com': 'Google Photos', 'maps.google.com': 'Google Maps',
    'news.google.com': 'Google News', 'cloud.google.com': 'Google Cloud',
    'myaccount.google.com': 'Google Account', 'accounts.google.com': 'Google Account',
    'gemini.google.com': 'Gemini', 'keep.google.com': 'Google Keep',
    'translate.google.com': 'Google Translate', 'support.google.com': 'Google Support',
    'script.google.com': 'Apps Script', 'play.google.com': 'Google Play',
    'workspace.google.com': 'Google Workspace', 'admin.google.com': 'Google Admin',
    'chat.google.com': 'Google Chat', 'analytics.google.com': 'Google Analytics',
    // Apple
    'apple.com': 'Apple', 'developer.apple.com': 'Apple Developer',
    'support.apple.com': 'Apple Support', 'apps.apple.com': 'App Store',
    'music.apple.com': 'Apple Music', 'discussions.apple.com': 'Apple Community',
    'appstoreconnect.apple.com': 'App Store Connect', 'tv.apple.com': 'Apple TV',
    'icloud.com': 'iCloud',
    // Microsoft / Amazon / Adobe / Mozilla
    'microsoft.com': 'Microsoft', 'learn.microsoft.com': 'Microsoft Learn',
    'outlook.live.com': 'Outlook', 'outlook.office.com': 'Outlook', 'live.com': 'Microsoft',
    'office.com': 'Microsoft 365', 'sharepoint.com': 'SharePoint',
    'amazon.com': 'Amazon', 'amazon.ca': 'Amazon', 'aws.amazon.com': 'AWS',
    'music.amazon.com': 'Amazon Music', 'primevideo.com': 'Prime Video',
    'adobe.com': 'Adobe', 'helpx.adobe.com': 'Adobe Help', 'community.adobe.com': 'Adobe Community',
    'stock.adobe.com': 'Adobe Stock', 'behance.net': 'Behance',
    'mozilla.org': 'Mozilla', 'developer.mozilla.org': 'MDN', 'addons.mozilla.org': 'Firefox Add-ons',
    'bugzilla.mozilla.org': 'Bugzilla',
    // Dev
    'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'stackoverflow.com': 'Stack Overflow',
    'stackexchange.com': 'Stack Exchange', 'npmjs.com': 'npm', 'pypi.org': 'PyPI',
    'vercel.com': 'Vercel', 'netlify.com': 'Netlify', 'cloudflare.com': 'Cloudflare',
    'dash.cloudflare.com': 'Cloudflare Dashboard', 'webkit.org': 'WebKit', 'w3.org': 'W3C',
    'caniuse.com': 'Can I Use', 'huggingface.co': 'Hugging Face', 'localhost': 'Localhost',
    // AI
    'claude.ai': 'Claude', 'anthropic.com': 'Anthropic', 'chatgpt.com': 'ChatGPT',
    'openai.com': 'OpenAI', 'perplexity.ai': 'Perplexity',
    // Social / comms
    'youtube.com': 'YouTube', 'reddit.com': 'Reddit', 'x.com': 'X', 'instagram.com': 'Instagram',
    'facebook.com': 'Facebook', 'linkedin.com': 'LinkedIn', 'threads.com': 'Threads',
    'bsky.app': 'Bluesky', 'tiktok.com': 'TikTok', 'pinterest.com': 'Pinterest',
    'discord.com': 'Discord', 'slack.com': 'Slack', 'whatsapp.com': 'WhatsApp',
    'messenger.com': 'Messenger', 'zoom.us': 'Zoom', 'calendly.com': 'Calendly',
    // Work / files
    'notion.so': 'Notion', 'notion.site': 'Notion', 'figma.com': 'Figma', 'canva.com': 'Canva',
    'dropbox.com': 'Dropbox', 'box.com': 'Box', 'wetransfer.com': 'WeTransfer',
    'frame.io': 'Frame.io', 'vimeo.com': 'Vimeo', 'trello.com': 'Trello', 'asana.com': 'Asana',
    'atlassian.net': 'Atlassian',
    // Money / markets
    'wealthsimple.com': 'Wealthsimple', 'tradingview.com': 'TradingView', 'yahoo.com': 'Yahoo',
    'finance.yahoo.com': 'Yahoo Finance', 'questrade.com': 'Questrade', 'cibc.com': 'CIBC',
    'rbc.com': 'RBC', 'td.com': 'TD', 'scotiabank.com': 'Scotiabank', 'bmo.com': 'BMO',
    'wise.com': 'Wise', 'paypal.com': 'PayPal', 'stripe.com': 'Stripe', 'intuit.com': 'Intuit',
    'quickbooks.intuit.com': 'QuickBooks', 'seekingalpha.com': 'Seeking Alpha',
    'bloomberg.com': 'Bloomberg', 'reuters.com': 'Reuters', 'cnbc.com': 'CNBC',
    'marketwatch.com': 'MarketWatch', 'finviz.com': 'Finviz', 'sec.gov': 'SEC',
    'investing.com': 'Investing.com', 'ycombinator.com': 'Hacker News',
    // Canada / news
    'canada.ca': 'Canada.ca', 'cra-arc.gc.ca': 'CRA', 'ontario.ca': 'Ontario',
    'toronto.ca': 'City of Toronto', 'cbc.ca': 'CBC', 'theglobeandmail.com': 'Globe and Mail',
    'thestar.com': 'Toronto Star', 'nytimes.com': 'NYT', 'theverge.com': 'The Verge',
    'bbc.com': 'BBC', 'bbc.co.uk': 'BBC', 'cnn.com': 'CNN', 'theguardian.com': 'Guardian',
    'wikipedia.org': 'Wikipedia', 'medium.com': 'Medium', 'substack.com': 'Substack',
    // Shopping / gear
    'kijiji.ca': 'Kijiji', 'bestbuy.ca': 'Best Buy', 'bestbuy.com': 'Best Buy',
    'bhphotovideo.com': 'B&H', 'adorama.com': 'Adorama', 'ebay.com': 'eBay', 'ebay.ca': 'eBay',
    'etsy.com': 'Etsy', 'walmart.ca': 'Walmart', 'costco.ca': 'Costco', 'keh.com': 'KEH',
    'mpb.com': 'MPB', 'henrys.com': "Henry's", 'vistek.ca': 'Vistek',
    'fujifilm-x.com': 'Fujifilm', 'fujifilm.com': 'Fujifilm', 'captureone.com': 'Capture One',
    'dpreview.com': 'DPReview', 'petapixel.com': 'PetaPixel', 'fstoppers.com': 'Fstoppers',
    'cined.com': 'CineD', 'shopify.com': 'Shopify',
    // Media / travel
    'netflix.com': 'Netflix', 'spotify.com': 'Spotify', 'twitch.tv': 'Twitch', 'crave.ca': 'Crave',
    'disneyplus.com': 'Disney+', 'uber.com': 'Uber', 'airbnb.com': 'Airbnb',
    'booking.com': 'Booking.com', 'expedia.com': 'Expedia', 'aircanada.com': 'Air Canada'
  };

  const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

  /** example.co.uk from a.b.example.co.uk; IPs and single labels pass through. */
  function registrableDomain(host) {
    if (!host) return '';
    if (IP_RE.test(host) || host.includes(':') || host.startsWith('[')) return host;
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    for (const n of [3, 2]) {
      if (labels.length > n && PUBLIC_SUFFIXES.has(labels.slice(-n).join('.'))) {
        return labels.slice(-(n + 1)).join('.');
      }
    }
    return labels.slice(-2).join('.');
  }

  /**
   * Group key for a hostname. Registrable domain by default; for SPLIT_DOMAINS,
   * the first subdomain level is kept (mail.google.com, aws.amazon.com).
   */
  function domainGroup(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\d*\./, '');
    let reg = registrableDomain(host);
    reg = GROUP_ALIASES[reg] || reg;
    let key = reg;
    if (SPLIT_DOMAINS.has(reg) && host !== reg && host.endsWith('.' + reg)) {
      const subs = host.slice(0, -(reg.length + 1)).split('.');
      const sub1 = subs[subs.length - 1];
      if (sub1 && sub1 !== 'www' && sub1 !== 'm') key = sub1 + '.' + reg;
    }
    return { host, reg, key };
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function prettify(reg) {
    if (IP_RE.test(reg) || reg.includes(':')) return reg;
    const first = reg.split('.')[0] || reg;
    return first.split(/[-_]/).filter(Boolean).map(cap).join(' ') || reg;
  }

  /** Human label for a group key: dictionary, else "Parent Sub", else prettified domain. */
  function autoLabel(key, reg) {
    if (LABELS[key]) return LABELS[key];
    const regLabel = LABELS[reg] || prettify(reg);
    if (key !== reg && key.endsWith('.' + reg)) return regLabel + ' ' + cap(key.slice(0, -(reg.length + 1)));
    return regLabel;
  }

  // ---------------------------------------------------------------------------
  // Folders: an editable outline (Settings) that sorts groups into parent folders
  // ---------------------------------------------------------------------------

  const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  /** Starter outline, seeded on first install. Users edit it in Settings. */
  const DEFAULT_OUTLINE = [
    '# Tab Triage folders',
    '# Folder names start at the left edge. Sites go on indented lines under their folder.',
    '#   Name: site, site   puts those sites in one group called Name',
    '#   site, site         gives each site its own group',
    '# A site is a domain (covers its subdomains: google.com covers mail.google.com)',
    '# or a piece of a URL containing / or * (e.g. facebook.com/marketplace).',
    '# The most specific match wins. Anything not listed lands in Unsorted.',
    '',
    'Shopping',
    '  Amazon: amazon.com, amazon.co.uk, amazon.ca, amazon.de, amazon.fr, amazon.it, amazon.es, amazon.nl, amazon.co.jp, amazon.com.au, amazon.in, amazon.com.mx, amazon.com.br, amzn.to',
    '  Electronics: bhphotovideo.com, adorama.com, keh.com, mpb.com, newegg.com, currys.co.uk, mediamarkt.de, jbhifi.com.au',
    '  Marketplaces: ebay.com, ebay.co.uk, ebay.ca, ebay.de, ebay.com.au, facebook.com/marketplace, craigslist.org, etsy.com, aliexpress.com, temu.com',
    '  Stores: bestbuy.com, bestbuy.ca, walmart.com, target.com, costco.com, ikea.com, homedepot.com, argos.co.uk',
    '',
    'Work',
    '  docs.google.com, drive.google.com, calendar.google.com',
    '  office.com, microsoft365.com, outlook.com, outlook.live.com, teams.microsoft.com, sharepoint.com',
    '  notion.so, notion.site, figma.com, canva.com, slack.com, zoom.us, calendly.com',
    '  asana.com, trello.com, atlassian.net, monday.com, airtable.com, dropbox.com, box.com, wetransfer.com, frame.io',
    '',
    'AI',
    '  claude.ai, anthropic.com, chatgpt.com, openai.com, gemini.google.com, perplexity.ai',
    '  copilot.microsoft.com, grok.com, mistral.ai, deepseek.com, poe.com, huggingface.co',
    '',
    'Trading',
    '  tradingview.com, finance.yahoo.com, investing.com, marketwatch.com, seekingalpha.com, finviz.com, sec.gov',
    '  robinhood.com, etoro.com, interactivebrokers.com, schwab.com, fidelity.com, wealthsimple.com, coinbase.com, binance.com',
    '',
    'Money',
    '  paypal.com, wise.com, revolut.com, stripe.com, americanexpress.com, capitalone.com',
    '  chase.com, bankofamerica.com, wellsfargo.com, hsbc.com, barclays.co.uk, intuit.com, xero.com',
    '',
    'Dev',
    '  github.com, githubusercontent.com, gitlab.com, stackoverflow.com, stackexchange.com',
    '  developer.apple.com, developer.mozilla.org, npmjs.com, pypi.org',
    '  vercel.com, netlify.com, cloudflare.com, webkit.org, caniuse.com, localhost',
    '',
    'Google',
    '  google.com, google.co.uk, google.ca, google.de, google.fr, google.es, google.it, google.com.au, google.co.in, google.co.jp',
    '',
    'Apple',
    '  apple.com, icloud.com',
    '',
    'Microsoft',
    '  microsoft.com, bing.com, msn.com, live.com',
    '',
    'Social',
    '  facebook.com, instagram.com, x.com, twitter.com, threads.com, threads.net, bsky.app, mastodon.social',
    '  linkedin.com, reddit.com, tiktok.com, pinterest.com, snapchat.com, discord.com, messenger.com, whatsapp.com, web.telegram.org',
    '',
    'Watch & Listen',
    '  youtube.com, youtu.be, vimeo.com, netflix.com, disneyplus.com, primevideo.com, max.com, hulu.com, tv.apple.com',
    '  spotify.com, music.apple.com, soundcloud.com, deezer.com, twitch.tv',
    '',
    'News',
    '  nytimes.com, washingtonpost.com, wsj.com, ft.com, bbc.com, bbc.co.uk, cnn.com, theguardian.com',
    '  reuters.com, apnews.com, aljazeera.com, bloomberg.com, cnbc.com, news.google.com',
    '  theverge.com, techcrunch.com, arstechnica.com, news.ycombinator.com',
    '  wikipedia.org, medium.com, substack.com',
    '',
    'Travel',
    '  Maps: google.com/maps, maps.google.com, maps.apple.com',
    '  airbnb.com, booking.com, expedia.com, tripadvisor.com, skyscanner.net, skyscanner.com, kayak.com, uber.com, lyft.com',
    ''
  ].join('\n');

  /** One site entry: a domain ("keh.com") or a URL piece with / or * ("facebook.com/marketplace"). */
  function normSite(raw) {
    let v = String(raw).trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\d*\./, '');
    if (/^[^/*]+\/$/.test(v)) v = v.slice(0, -1);
    if (!v) return null;
    if (/[\s,]/.test(v)) return { invalid: raw };
    if (v.includes('/') || v.includes('*') || v.includes(':')) return { type: 'pattern', value: v };
    if (!/^[a-z0-9.-]+$/.test(v) || v.startsWith('.') || v.startsWith('-')) return { invalid: raw };
    return { type: 'domain', value: v.replace(/\.$/, '') };
  }

  /**
   * Parse the outline text.
   * Unindented line = folder ("Shopping", "Shopping>" and "Shopping:" all work).
   * Indented line  = "Name: site, site" (one named group) or "site, site" (one group per site).
   * Blank lines and lines starting with # are ignored.
   * Returns { folders: [{ name, entries: [{ group, sites }] }], errors: [string] }.
   */
  function parseOutline(text) {
    const folders = [];
    const errors = [];
    let cur = null;
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      if (!/^\s/.test(line)) {
        const name = trimmed.replace(/\s*[>:]\s*$/, '').trim().slice(0, 60);
        if (!name) { errors.push(`Line ${i + 1}: folder name is empty.`); return; }
        cur = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
        if (!cur) { cur = { name, entries: [] }; folders.push(cur); }
        return;
      }
      if (!cur) { errors.push(`Line ${i + 1}: indented line comes before any folder.`); return; }
      let group = null;
      let list = trimmed;
      const named = trimmed.match(/^([^:.*/,]+):(?:\s+(.*))?$/);
      if (named) { group = named[1].trim().slice(0, 60); list = named[2] || ''; }
      const sites = [];
      for (const part of list.split(/[,\s]+/)) {
        if (!part) continue;
        const site = normSite(part);
        if (!site) continue;
        if (site.invalid) { errors.push(`Line ${i + 1}: "${site.invalid}" isn't a site.`); continue; }
        sites.push(site);
      }
      // "Name:" with nothing after it is an empty group the organizer keeps for you to fill.
      if (!sites.length && !(group && !list.trim())) { errors.push(`Line ${i + 1}: no sites listed.`); return; }
      cur.entries.push({ group, sites });
    });
    return { folders, errors };
  }

  /**
   * Compile the outline into ordered matchers: URL pieces first (in outline order),
   * then domains longest first, so the most specific entry always wins.
   */
  function compileOutline(text) {
    const parsed = parseOutline(text);
    const patterns = [];
    const domains = [];
    for (const f of parsed.folders) {
      for (const e of f.entries) {
        for (const site of e.sites) {
          const m = { folder: f.name, group: e.group, value: site.value };
          if (site.type === 'pattern') {
            m.re = new RegExp(site.value.split('*').map(escapeRe).join('.*'), 'i');
            patterns.push(m);
          } else {
            domains.push(m);
          }
        }
      }
    }
    domains.sort((a, b) => b.value.length - a.value.length);
    return { matchers: patterns.concat(domains), folders: parsed.folders, errors: parsed.errors };
  }

  // ---------------------------------------------------------------------------
  // Organizer model (Settings drag-and-drop). Pure; round-trips with the outline text,
  // which stays the stored format. Every op mutates the model it's given.
  // ---------------------------------------------------------------------------

  const OUTLINE_HEADER = DEFAULT_OUTLINE.split('\n').filter((l) => l.startsWith('#')).join('\n');

  /** Names the outline can hold: folders can't start with # or end in > / :; groups can't hold : . * / , */
  function cleanFolderName(s) {
    return String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/^[\s#]+/, '').slice(0, 60).replace(/[\s>:]+$/, '').trim();
  }
  function cleanGroupName(s) {
    return String(s || '').replace(/[:.*/,\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, 60).trim();
  }
  function uniqueName(base, taken) {
    const lower = new Set(taken.map((t) => t.toLowerCase()));
    if (!lower.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }

  /**
   * Outline text -> { folders: [{ name, items }], errors }.
   * items: { kind: 'group', name, sites: [value] } (one named group) or { kind: 'site', site } (own group).
   */
  function outlineToModel(text) {
    const p = parseOutline(text);
    return {
      errors: p.errors,
      folders: p.folders.map((f) => ({
        name: f.name,
        items: f.entries.flatMap((e) => (e.group
          ? [{ kind: 'group', name: e.group, sites: e.sites.map((s) => s.value) }]
          : e.sites.map((s) => ({ kind: 'site', site: s.value }))))
      }))
    };
  }

  /** Model -> outline text. Named groups one per line ("Name:" alone when empty); runs of single sites 6 to a line. */
  function modelToOutline(model) {
    const out = [OUTLINE_HEADER, ''];
    for (const f of model.folders) {
      out.push(f.name);
      const run = [];
      const flush = () => { while (run.length) out.push('  ' + run.splice(0, 6).join(', ')); };
      for (const it of f.items) {
        if (it.kind === 'site') { run.push(it.site); continue; }
        flush();
        out.push(`  ${it.name}:` + (it.sites.length ? ' ' + it.sites.join(', ') : ''));
      }
      flush();
      out.push('');
    }
    return out.join('\n');
  }

  /**
   * The site entry that covers a hostname: its split subdomain (mail.google.com) or its
   * registrable domain as typed (twitter.com, not the x.com it's grouped with).
   */
  function siteForHost(hostname) {
    const d = domainGroup(hostname);
    return d.key !== d.reg ? d.key : registrableDomain(d.host);
  }

  /** Friendly name for a site entry: "Amazon" for amazon.ca; URL pieces show as typed. */
  function siteLabel(value) {
    if (/[/*:]/.test(value)) return value;
    const d = domainGroup(value);
    return autoLabel(d.key, d.reg);
  }

  const org = {
    /** Take a site out of wherever it is (a site lives in one place only). */
    takeSite(m, site) {
      for (const f of m.folders) {
        for (let i = f.items.length - 1; i >= 0; i--) {
          const it = f.items[i];
          if (it.kind === 'site') { if (it.site === site) f.items.splice(i, 1); }
          else { const j = it.sites.indexOf(site); if (j >= 0) it.sites.splice(j, 1); }
        }
      }
    },
    /** Put a site in folder fi: into the group at item index gi, or as its own group. Returns the value or null. */
    placeSite(m, raw, fi, gi) {
      const s = normSite(raw);
      const f = m.folders[fi];
      if (!s || s.invalid || !f) return null;
      const target = gi != null && gi >= 0 && f.items[gi] && f.items[gi].kind === 'group' ? f.items[gi] : null;
      org.takeSite(m, s.value);
      if (target) target.sites.push(s.value); else f.items.push({ kind: 'site', site: s.value });
      return s.value;
    },
    /** placeSite as its own group, landing just before the item now at index `at` (default: end). */
    placeSiteAt(m, raw, fi, at) {
      const f = m.folders[fi];
      const before = f && at != null ? f.items[at] : null;
      const v = org.placeSite(m, raw, fi, null);
      if (v == null) return null;
      const idx = before ? f.items.indexOf(before) : -1;
      if (idx >= 0) f.items.splice(idx, 0, f.items.pop());
      return v;
    },
    /** Drop a site onto the single site at item i: the two become one group in its place, named after it. */
    groupWith(m, raw, fi, i) {
      const s = normSite(raw);
      const f = m.folders[fi];
      const target = f && f.items[i];
      if (!s || s.invalid || !target || target.kind !== 'site' || target.site === s.value) return null;
      org.takeSite(m, s.value);
      const taken = f.items.filter((it) => it.kind === 'group').map((it) => it.name);
      const name = uniqueName(cleanGroupName(siteLabel(target.site)) || 'New group', taken);
      f.items.splice(f.items.indexOf(target), 1, { kind: 'group', name, sites: [target.site, s.value] });
      return s.value;
    },
    /** A new group at the end of folder fi holding just this site, named after it. Returns its index or -1. */
    newGroupWith(m, raw, fi) {
      const s = normSite(raw);
      const f = m.folders[fi];
      if (!s || s.invalid || !f) return -1;
      org.takeSite(m, s.value);
      const taken = f.items.filter((it) => it.kind === 'group').map((it) => it.name);
      f.items.push({ kind: 'group', name: uniqueName(cleanGroupName(siteLabel(s.value)) || 'New group', taken), sites: [s.value] });
      return f.items.length - 1;
    },
    /** Move item i of folder fromF to folder toF (at index toI, default: end). */
    moveItem(m, fromF, i, toF, toI) {
      const src = m.folders[fromF];
      const dst = m.folders[toF];
      if (!src || !dst || !src.items[i]) return;
      const [it] = src.items.splice(i, 1);
      let at = toI == null || toI < 0 ? Infinity : toI;
      if (fromF === toF && at !== Infinity && at > i) at -= 1;
      dst.items.splice(Math.min(at, dst.items.length), 0, it);
    },
    removeItem(m, fi, i) { if (m.folders[fi]) m.folders[fi].items.splice(i, 1); },
    addFolder(m, name) {
      m.folders.push({ name: uniqueName(cleanFolderName(name) || 'New folder', m.folders.map((f) => f.name)), items: [] });
      return m.folders.length - 1;
    },
    renameFolder(m, fi, name) {
      const n = cleanFolderName(name);
      if (!n || !m.folders[fi]) return false;
      if (m.folders.some((f, i) => i !== fi && f.name.toLowerCase() === n.toLowerCase())) return false;
      m.folders[fi].name = n;
      return true;
    },
    removeFolder(m, fi) { m.folders.splice(fi, 1); },
    /** Move folder `from` so it sits before the folder currently at `before` (folders.length = end). */
    moveFolder(m, from, before) {
      if (from === before || from + 1 === before) return;
      const [f] = m.folders.splice(from, 1);
      m.folders.splice(before > from ? before - 1 : before, 0, f);
    },
    addGroup(m, fi, name) {
      const f = m.folders[fi];
      const taken = f.items.filter((it) => it.kind === 'group').map((it) => it.name);
      f.items.push({ kind: 'group', name: uniqueName(cleanGroupName(name) || 'New group', taken), sites: [] });
      return f.items.length - 1;
    },
    renameGroup(m, fi, gi, name) {
      const it = m.folders[fi] && m.folders[fi].items[gi];
      const n = cleanGroupName(name);
      if (!it || it.kind !== 'group' || !n) return false;
      it.name = n;
      return true;
    }
  };

  /** First matcher for a URL/host, or null. host: lowercase, no "www.". */
  function classify(url, host, matchers) {
    for (const m of matchers || []) {
      if (m.re) { if (m.re.test(url)) return m; }
      else if (host === m.value || host.endsWith('.' + m.value)) return m;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Duplicate keys
  // ---------------------------------------------------------------------------

  /** Tracking params ignored everywhere (utm_* handled by prefix). */
  const TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid',
    'yclid', 'twclid', '_hsenc', '_hsmi', 'mkt_tok', 'ref_src', 'ref_url', 'spm', '_ga', '_gl'
  ]);

  /** Per-site params that never change what the page is (share tokens, timestamps). */
  const AMAZON_NOISE = ['ref', 'ref_', 'pd_rd_w', 'pd_rd_r', 'pd_rd_wg', 'pf_rd_r', 'pf_rd_p',
    'psc', 'th', 'qid', 'sr', 'crid', 'sprefix', 'dib', 'dib_tag', 'content-id'];
  const DOMAIN_IGNORED = {
    'youtube.com': new Set(['si', 'feature', 'pp', 't', 'ab_channel', 'embeds_referring_euri']),
    'spotify.com': new Set(['si', 'nd', 'context']),
    'instagram.com': new Set(['igsh', 'img_index']),
    'x.com': new Set(['s', 't']),
    'linkedin.com': new Set(['trk', 'trackingid', 'lipi', 'original_referer', 'refid']),
    'amazon.com': new Set(AMAZON_NOISE),
    'amazon.ca': new Set(AMAZON_NOISE)
  };

  /**
   * Params that define which page you're on, for sites that route by query.
   * Near-duplicate keys keep only these; everywhere else near = path only.
   */
  const SIG_RULES = [
    [/^youtube\.com$/, /^\/watch$/, ['v']],
    [/^youtube\.com$/, /^\/results$/, ['search_query']],
    [/^youtube\.com$/, /^\/playlist$/, ['list']],
    [/^google\.[a-z.]+$/, /^\/search$/, ['q', 'tbm', 'udm']],
    [/^bing\.com$/, /^\/search$/, ['q']],
    [/^duckduckgo\.com$/, /^\/$/, ['q']],
    [/^amazon\.[a-z.]+$/, /^\/s$/, ['k']],
    [/^github\.com$/, /^\/search$/, ['q', 'type']],
    [/^x\.com$/, /^\/search$/, ['q']],
    [/^reddit\.com$/, /\/search$/, ['q']],
    [/^ycombinator\.com$/, /^\/item$/, ['id']],
    [/^facebook\.com$/, /^\/(watch|profile\.php|photo)/, ['v', 'id', 'fbid']],
    [/^wikipedia\.org$/, /^\/w\/index\.php$/, ['title', 'search']],
    [/^ebay\.[a-z.]+$/, /^\/sch/, ['_nkw']],
    [/^tradingview\.com$/, /^\/chart/, ['symbol']]
  ];

  function significantParams(reg, path) {
    for (const [regRe, pathRe, params] of SIG_RULES) {
      if (regRe.test(reg) && pathRe.test(path)) return params;
    }
    return null;
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /**
   * exact: same page (scheme, www/m., trailing slash, tracking params, param order ignored).
   * near:  same path, ignoring query, except params that pick the page (YouTube v=, search q=).
   */
  function dedupeKeys(u, reg) {
    let host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^(www\d*|m|mobile)\./, '');
    let path = u.pathname || '/';
    const params = new URLSearchParams(u.search);
    if (host === 'youtu.be') {
      const id = path.slice(1).split('/')[0];
      host = 'youtube.com'; path = '/watch';
      if (id) params.set('v', id);
    } else if (host === 'youtube.com' && path.startsWith('/shorts/')) {
      const id = path.split('/')[2];
      path = '/watch';
      if (id) params.set('v', id);
    }
    const baseReg = GROUP_ALIASES[reg] || reg;
    path = path.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
    const port = u.port ? ':' + u.port : '';
    // Fragments that route (#/x, #!x, Gmail's #inbox/id) are part of the page; plain anchors (#intro) are not.
    const hashRoute = /^#[!/]/.test(u.hash) || u.hash.includes('/') ? u.hash : '';
    const ignored = DOMAIN_IGNORED[baseReg];
    const kept = [];
    for (const [k, v] of params) {
      const kl = k.toLowerCase();
      if (kl.startsWith('utm_') || TRACKING_PARAMS.has(kl) || (ignored && ignored.has(kl))) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
    const qs = (pairs) => (pairs.length
      ? '?' + pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
      : '');
    const base = host + port + path + hashRoute;
    const sig = significantParams(baseReg, path);
    return {
      exact: base + qs(kept),
      near: base + (sig ? qs(kept.filter(([k]) => sig.includes(k))) : '')
    };
  }

  // ---------------------------------------------------------------------------
  // Tab records and groups
  // ---------------------------------------------------------------------------

  const safeFav = (u) => (typeof u === 'string' && /^(https?:|data:image\/)/i.test(u) ? u : '');

  const UNSORTED = { key: 'f:__unsorted', label: 'Unsorted' };
  const OTHER = { key: 'f:__other', label: 'Other' };

  /**
   * Normalize a browser tabs.Tab into a flat record.
   * ctx: { outline: compileOutline(...) }
   * Every record lands in a folder (outline match, else Unsorted; blank/system/no-access tabs in Other)
   * and a group inside it (key "<folderKey>/<group>").
   *
   * Safari leaves url undefined when the extension lacks website access for
   * that tab ("No access"); a blank new tab has url "".
   */
  function describeTab(t, ctx) {
    const matchers = (ctx && ctx.outline && ctx.outline.matchers) || [];
    const rawUrl = typeof t.url === 'string' ? (t.url || (typeof t.pendingUrl === 'string' ? t.pendingUrl : '')) : null;
    const r = {
      id: t.id, windowId: t.windowId || 0, index: t.index || 0,
      pinned: !!t.pinned, audible: !!t.audible, muted: !!(t.mutedInfo && t.mutedInfo.muted),
      loading: t.status === 'loading', incognito: !!t.incognito, active: !!t.active,
      lastAccessed: typeof t.lastAccessed === 'number' ? t.lastAccessed : 0,
      fav: safeFav(t.favIconUrl), url: rawUrl || '', title: '', displayUrl: '',
      folderKey: OTHER.key, folderLabel: OTHER.label,
      key: '', reg: '', label: '', noAccess: false,
      exact: '', near: '', restorable: false, hay: '', cluster: '', dupCount: 1
    };

    let u = null;
    if (rawUrl && /^https?:\/\//i.test(rawUrl)) { try { u = new URL(rawUrl); } catch (e) { u = null; } }

    if (rawUrl === null) {
      r.noAccess = true;
      r.key = OTHER.key + '/noaccess'; r.label = 'No access';
      r.exact = r.near = 'id:' + t.id;
      r.title = t.title || 'Hidden tab';
      r.displayUrl = 'Address hidden by Safari';
    } else if (!u) {
      const blank = rawUrl === '' || /^about:blank$/i.test(rawUrl);
      r.key = OTHER.key + '/blank'; r.label = 'Blank & Safari pages';
      r.exact = r.near = blank ? 'blank' : rawUrl;
      r.displayUrl = blank ? 'Blank tab' : rawUrl;
      r.title = t.title || (blank ? 'New Tab' : rawUrl);
    } else {
      const d = domainGroup(u.hostname);
      const k = dedupeKeys(u, d.reg);
      const m = classify(rawUrl, d.host, matchers);
      const folder = m ? { key: 'f:' + m.folder.toLowerCase(), label: m.folder } : UNSORTED;
      r.folderKey = folder.key; r.folderLabel = folder.label;
      if (m && m.group) { r.key = folder.key + '/' + m.group.toLowerCase(); r.label = m.group; }
      else { r.key = folder.key + '/' + d.key; r.label = autoLabel(d.key, d.reg); }
      r.reg = d.reg; r.exact = k.exact; r.near = k.near;
      r.displayUrl = d.host + (u.port ? ':' + u.port : '')
        + (u.pathname === '/' && !u.search ? '' : u.pathname) + u.search;
      r.title = t.title || r.displayUrl;
      r.restorable = !r.incognito;
    }
    r.hay = (r.title + ' ' + r.url).toLowerCase();
    return r;
  }

  /**
   * Group records by r.key. opts: { sort: 'path' | 'order', nearGrouped: boolean }
   * 'path' puts duplicates next to each other; 'order' = window, then tab position.
   * Sets r.cluster / r.dupCount and g.dupExtra (tabs beyond the first in each cluster).
   */
  function buildGroups(records, opts) {
    const o = opts || {};
    const byOrder = (a, b) => (a.windowId - b.windowId) || (a.index - b.index);
    const byPath = (a, b) => cmp(a.near, b.near) || cmp(a.exact, b.exact) || byOrder(a, b);
    const map = new Map();
    for (const r of records) {
      let g = map.get(r.key);
      if (!g) {
        g = { key: r.key, label: r.label, folderKey: r.folderKey, folderLabel: r.folderLabel, tabs: [], dupExtra: 0, visible: null };
        map.set(r.key, g);
      }
      g.tabs.push(r);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.tabs.sort(o.sort === 'order' ? byOrder : byPath);
      const counts = new Map();
      for (const r of g.tabs) {
        r.cluster = o.nearGrouped === false ? r.exact : r.near;
        counts.set(r.cluster, (counts.get(r.cluster) || 0) + 1);
      }
      for (const r of g.tabs) r.dupCount = counts.get(r.cluster);
      for (const c of counts.values()) if (c > 1) g.dupExtra += c - 1;
    }
    return groups;
  }

  const FOLDER_LAST = { 'f:__unsorted': 1, 'f:__other': 2 };
  const GROUP_FIRST = { 'f:__other/blank': 1, 'f:__other/noaccess': 2 };

  /**
   * Folder > group > tabs. Folders and groups: most tabs first.
   * "Unsorted" then "Other" always last.
   */
  function buildTree(records, opts) {
    const map = new Map();
    for (const g of buildGroups(records, opts)) {
      let f = map.get(g.folderKey);
      if (!f) { f = { key: g.folderKey, label: g.folderLabel, groups: [], count: 0, dupExtra: 0, visibleCount: 0 }; map.set(g.folderKey, f); }
      f.groups.push(g);
      f.count += g.tabs.length;
      f.dupExtra += g.dupExtra;
    }
    const folders = [...map.values()];
    for (const f of folders) {
      f.groups.sort((a, b) => ((GROUP_FIRST[a.key] || 0) - (GROUP_FIRST[b.key] || 0))
        || (b.tabs.length - a.tabs.length) || cmp(a.label.toLowerCase(), b.label.toLowerCase()));
    }
    folders.sort((a, b) => ((FOLDER_LAST[a.key] || 0) - (FOLDER_LAST[b.key] || 0))
      || (b.count - a.count) || cmp(a.label.toLowerCase(), b.label.toLowerCase()));
    return folders;
  }

  // ---------------------------------------------------------------------------
  // Small shared helpers
  // ---------------------------------------------------------------------------

  /** Stable 0–359 hue from a string (monogram and duplicate-cluster colors). */
  function hue(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  /** Compact age: "now", "5m", "3h", "2d", "4mo". Empty when unknown. */
  function ago(ts, now) {
    if (!ts) return '';
    const s = ((now || Date.now()) - ts) / 1000;
    if (s < 60) return 'now';
    const m = s / 60; if (m < 60) return Math.floor(m) + 'm';
    const h = m / 60; if (h < 24) return Math.floor(h) + 'h';
    const d = h / 24; if (d < 30) return Math.floor(d) + 'd';
    return Math.floor(d / 30) + 'mo';
  }

  // ---------------------------------------------------------------------------
  // Usage meter text (numbers come from the app's native handler; Safari-wide, never per tab)
  // ---------------------------------------------------------------------------

  const GB = 1073741824;
  const MB = 1048576;

  /** "21.4 GB" at 1 GB and up, else "812 MB". Empty when unknown. */
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    return n >= GB ? (n / GB).toFixed(1) + ' GB' : Math.round(n / MB) + ' MB';
  }

  /** One line: "Safari 21.4 GB · CPU 53% · Mac 46.2 of 64.0 GB · Swap 4.6 GB". */
  function usageLine(u) {
    if (!u || u.ok !== true) return '';
    const parts = [];
    const s = u.safari;
    if (s && typeof s.memory === 'number') {
      parts.push(`Safari ${fmtBytes(s.memory)}`);
      if (typeof s.cpu === 'number') parts.push(`CPU ${Math.round(s.cpu)}%`);
    }
    const m = u.mac || {};
    if (typeof m.ramUsed === 'number' && typeof m.ramTotal === 'number') {
      parts.push(`Mac ${fmtBytes(m.ramUsed).replace(' GB', '')} of ${fmtBytes(m.ramTotal)}`);
    }
    if (typeof m.swapUsed === 'number') parts.push(`Swap ${fmtBytes(m.swapUsed)}`);
    if (m.pressure === 'warning' || m.pressure === 'critical') parts.push(`Memory pressure ${m.pressure}`);
    return parts.join(' · ');
  }

  /**
   * Before/after a close or reload: "Safari freed 1.8 GB after closing 7 tabs (21.4 GB → 19.6 GB)".
   * verb: 'closing' (default) or 'reloading'.
   */
  function freedLine(before, after, closed, verb) {
    const a = before && before.safari && before.safari.memory;
    const b = after && after.safari && after.safari.memory;
    if (typeof a !== 'number' || typeof b !== 'number') return '';
    const what = `after ${verb || 'closing'} ${closed} tab${closed === 1 ? '' : 's'}`;
    const d = a - b;
    if (Math.abs(d) < 50 * MB) return `Safari memory about the same ${what} (${fmtBytes(b)})`;
    return d > 0
      ? `Safari freed ${fmtBytes(d)} ${what} (${fmtBytes(a)} → ${fmtBytes(b)})`
      : `Safari memory rose ${fmtBytes(-d)} ${what} (${fmtBytes(a)} → ${fmtBytes(b)})`;
  }

  // ---------------------------------------------------------------------------
  // Sessions: a saved snapshot of every open (non-private) tab, window by window
  // ---------------------------------------------------------------------------

  const pad2 = (n) => String(n).padStart(2, '0');

  /** "SafariSession_0925-22:19": month, day, 24-hour time, local clock. */
  function sessionName(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `SafariSession_${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** Same-minute saves: "SafariSession_0925-22:19 (2)". */
  function uniqueSessionName(base, taken) {
    const set = new Set(taken);
    if (!set.has(base)) return base;
    for (let n = 2; ; n++) if (!set.has(`${base} (${n})`)) return `${base} (${n})`;
  }

  /**
   * Snapshot tabs.query({}) into { windows: [{ tabs: [{ url, title }] }], pinned: [{ url, title }], counts }.
   * Private tabs are left out entirely (only counted). Only http(s) pages are kept: blank tabs,
   * Safari pages and tabs whose address Safari hides can't be reopened. Pinned tabs show up in every
   * Safari window, so they are kept once, in `pinned`. Windows and tabs keep Safari's order.
   */
  function buildSession(tabs) {
    const byWin = new Map();
    const pinned = [];
    const pinnedSeen = new Set();
    const counts = { tabs: 0, windows: 0, private: 0, skipped: 0, pinned: 0 };
    const sorted = [...(tabs || [])].sort((a, b) => ((a.windowId || 0) - (b.windowId || 0)) || ((a.index || 0) - (b.index || 0)));
    for (const t of sorted) {
      if (!t) continue;
      if (t.incognito) { counts.private++; continue; }
      const url = typeof t.url === 'string' ? t.url : '';
      if (!/^https?:\/\//i.test(url)) { counts.skipped++; continue; }
      const entry = { url, title: String(t.title || '').slice(0, 300) };
      if (t.pinned) {
        if (!pinnedSeen.has(url)) { pinnedSeen.add(url); pinned.push(entry); }
        continue;
      }
      const w = t.windowId || 0;
      if (!byWin.has(w)) byWin.set(w, []);
      byWin.get(w).push(entry);
    }
    const windows = [...byWin.values()].map((list) => ({ tabs: list }));
    counts.windows = windows.length;
    counts.pinned = pinned.length;
    counts.tabs = windows.reduce((a, w) => a + w.tabs.length, 0) + pinned.length;
    return { windows, pinned, counts };
  }

  // ---------------------------------------------------------------------------
  // Memory relief: which tabs count as stale (Refresh stale)
  // ---------------------------------------------------------------------------

  const DAY_MS = 86400000;
  const STALE_DAYS = [1, 3, 7, 14];

  /**
   * Tabs not used for `days` days: tab.lastAccessed older than now minus that many days.
   * Never the active tab of a window, a pinned tab, a tab playing audio, or a blank tab.
   * Returns { ids (oldest first), days, known, skipped: { active, pinned, audible } }.
   * known is false when Safari reports lastAccessed for none of the tabs: nothing can be judged.
   */
  function staleTabs(tabs, days, now) {
    const d = STALE_DAYS.includes(Number(days)) ? Number(days) : 3;
    const cutoff = (typeof now === 'number' ? now : Date.now()) - d * DAY_MS;
    const out = { ids: [], days: d, known: false, skipped: { active: 0, pinned: 0, audible: 0 } };
    const stale = [];
    for (const t of tabs || []) {
      if (!t || typeof t.lastAccessed !== 'number' || !(t.lastAccessed > 0)) continue;
      out.known = true;
      if (t.lastAccessed > cutoff) continue;
      if (t.url === '' || /^about:blank$/i.test(t.url || '')) continue;
      if (t.active) { out.skipped.active++; continue; }
      if (t.pinned) { out.skipped.pinned++; continue; }
      if (t.audible) { out.skipped.audible++; continue; }
      stale.push(t);
    }
    stale.sort((a, b) => a.lastAccessed - b.lastAccessed);
    out.ids = stale.map((t) => t.id);
    return out;
  }

  /**
   * Safari doesn't give extensions tabs.Tab.lastAccessed, so Tab Triage keeps its own record
   * ({ [tabId]: ms } from background.js). Fill lastAccessed from it; Safari's own value wins if it has one.
   */
  function applyAges(tabs, ages) {
    const a = ages && typeof ages === 'object' ? ages : {};
    return (tabs || []).map((t) => {
      if (!t || (typeof t.lastAccessed === 'number' && t.lastAccessed > 0)) return t;
      const v = a[t.id];
      return typeof v === 'number' && v > 0 ? { ...t, lastAccessed: v } : t;
    });
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "28 Oct, 13:55" (local clock, 24-hour). */
  function whenText(ms) {
    const d = new Date(ms);
    if (!isFinite(d.getTime())) return '';
    return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  const TT = {
    registrableDomain, domainGroup, autoLabel, dedupeKeys,
    parseOutline, compileOutline, classify, describeTab, buildGroups, buildTree,
    hue, ago, fmtBytes, usageLine, freedLine, DEFAULT_OUTLINE,
    normSite, outlineToModel, modelToOutline, cleanFolderName, cleanGroupName, org, siteForHost, siteLabel,
    sessionName, uniqueSessionName, buildSession, staleTabs, STALE_DAYS, applyAges, whenText
  };
  root.TT = TT;
  if (typeof module !== 'undefined' && module.exports) module.exports = TT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
