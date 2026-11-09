# Tab Triage: how to use it

Click the Tab Triage button in Safari's toolbar.

Tabs are sorted **Folder ▸ Group ▸ Tabs**: e.g. Shopping ▸ Amazon ▸ your Amazon tabs. Folders start collapsed; a folder with only one group opens straight to its tabs.

| Action | How |
|---|---|
| Expand / collapse | Click a folder or group header. |
| Select a tab | Click anywhere on its row |
| Go to a tab | Double-click its row, or ↗ at the end of the row. Switches Safari to that tab and window; your ticks stay as they were. |
| Select a whole folder or group | Its header checkbox. While filtering, only the visible matches. Pinned tabs never. |
| Close selected | **Close N** or ⌘⌫. Always confirms. The list jumps back to the top afterwards. |
| Close a whole folder or group | ✕ on its header (appears on hover). Confirms. |
| Undo | **Undo** in the footer or ⌘Z. Each close gets its own 1-minute window; repeat to walk back. |
| Select duplicates | **Select dupes**: every blank tab, plus all but one copy of each exact duplicate (keeps a pinned copy, then the active tab, then the first) |
| Filter | Type; every word must match. `/` focuses, Esc clears. |
| Refresh | ↻ or R |
| Memory and CPU | **Usage**: Safari's memory and CPU, the Mac's memory and swap. While it's showing, closes report what Safari freed a few seconds later. Press again to re-measure. |
| Save a session | **Save session**: saves every open tab (not private ones), window by window, as `SafariSession_MMDD-HH:MM`, e.g. `SafariSession_0925-22:19`. **View sessions** in the confirmation opens the Sessions page. |
| Free memory: reload old tabs | **Refresh stale** (third row). Reloads every tab you haven't used for the number of days in the menu beside it (1+, 3+, 7+ or 14+; 3+ to start). Asks first. |
| Free memory: fresh start | **Reset tabs** (third row). Saves a session, closes every tab except pinned ones, reopens them. Asks first. Safari keeps running. |
| Roomier view | ⤢ opens the same screen in a tab |
| Organize folders | ⚙ (same page as Safari Settings > Extensions > Tab Triage > Settings) |

**Switches** (remembered across restarts): **Private** shows or hides private windows. **Sort**: Path keeps duplicates together; Order follows window and tab position. **Near-dups**: On groups `?page=1` and `?page=2` together; Off only groups exact matches.

## Freeing memory

Safari tabs that stay open for days keep growing (1 to 1.5 GB each is common). Closing other tabs doesn't shrink them; reloading does.

- **Refresh stale** reloads tabs you haven't used for 1, 3, 7 or 14 days (pick in the menu beside it; it remembers). It never reloads the tab you're on in each window, pinned tabs, or tabs playing audio. It asks first: "Reload 12 tabs open 3+ days?" Pages reload one after another, about a third of a second apart. Anything typed into a form on those pages and not sent is lost.
- **Reset tabs** gives every page a fresh start without quitting Safari: it saves a session, closes every tab except pinned ones, then reopens the session in the same windows. It asks first and warns that private tabs will close for good (they're never saved). Blank tabs and Safari pages don't come back. The popup closes while it works; open it again to see how it went. If everything came back, the temporary session is removed; if anything didn't, it stays in **Sessions** so you can reopen it.
- With **Usage** showing first, Refresh stale reports what Safari freed a few seconds after the last reload.
- Safari doesn't tell extensions when a tab was last used, so Tab Triage keeps track itself (a tab counts as used when you look at it or it reloads). Counting starts when Tab Triage is installed or updated and again each time Safari restarts; until then Refresh stale tells you the date from which tabs can count as stale. Private tabs are tracked only in memory, so they rarely count as stale.

## Sessions

Open with **View sessions** (after Save session) or **Sessions** on the Folders page. Newest first.

| To | Do |
|---|---|
| Save now | **Save session now** (same as the popup button). Two saves in the same minute: the second gets " (2)". |
| See what's in one | Click its name or ▸. Tabs are listed per window; click a title to open just that page. |
| Reopen everything | **Restore**, then click again to confirm ("Open 140 tabs?"). Each saved window opens as a new Safari window. |
| Reopen part | **Open window** under a window, or **Open pinned**. Pinned tabs already open are skipped. |
| Rename / delete | **Rename** (Enter saves, Esc cancels). **Delete**, then click again to confirm. |

Private tabs are never saved. Blank tabs, Safari pages and tabs Safari hides the address of are skipped. Pinned tabs show in every Safari window, so they're saved once. Sessions are kept inside Tab Triage on this Mac (up to 200); removing the extension removes them.

## Organizing folders (⚙)

Three columns: **Folders** on the left, the selected folder's groups and sites in the middle, **Unsorted** on the right (every site open right now that no folder covers, with its tab count; private tabs never listed). Every change saves immediately; open Tab Triage windows update on their own.

| To | Do |
|---|---|
| File an open site | Drag it from Unsorted onto a folder (own group), onto a group card (joins it), or onto a single site (the two become a group named after it). Or use its ⌄ Move to… menu. |
| Drop into a group in another folder | Drag the Unsorted site over that folder and hold for a moment: the folder opens. Then drop on the group. |
| Start a group | **+ New group** (type its name), or drop a site on "Drop a site here to start a new group". |
| Move things | Drag site chips between groups; drag a group or single site onto another folder in the sidebar; or use Move to…. |
| Reorder | Drag a group or site onto another (it takes that place) or into the gap between rows. Drag folders up and down the sidebar. |
| Take something out | Drop it on Unsorted, click ×, or Move to… > Unsorted. Its tabs go back to Unsorted. |
| Rename | Click the folder or group name (or double-click a folder in the sidebar). Enter saves, Esc cancels. |
| Add a site that isn't open | Type it in a group's "+ add site" box or the box at the bottom (several: separate with commas or spaces). |
| Undo | **Undo** or ⌘Z, up to 50 steps (while the page is open). Restore defaults is undoable too. |
| Bulk edit | **Edit as text**: the outline below. |

## Edit as text

The same folders as one text box, written the way you'd sketch it:

```
Shopping
  Amazon: amazon.com, amazon.co.uk
  Electronics: bhphotovideo.com, newegg.com
AI
  claude.ai, chatgpt.com
```

- Folder names start at the left edge (`Shopping`, `Shopping>` or `Shopping:` all work).
- Indented `Name: site, site` puts those sites in one group called Name.
- Indented `site, site` gives each site its own group (named automatically: claude.ai becomes Claude).
- A site is a domain (`google.com` also covers `mail.google.com`) or a piece of a URL with `/` or `*` (`facebook.com/marketplace`).
- The most specific match wins: `facebook.com/marketplace` beats `facebook.com`; `docs.google.com` beats `google.com`.
- Sites you haven't listed land in **Unsorted**. Blank tabs, Safari pages and hidden tabs land in **Other**.
- `Name:` with nothing after it is an empty group, waiting for sites.
- Tab key indents. ⌘S saves. Problems are shown with their line number and nothing is saved until they're fixed. **Back to organizer** asks for a second click if you have unsaved edits.
- Using the organizer rewrites this text in a tidy standard layout (your own `#` comment lines aren't kept). The matches stay the same.

Starter folders: Shopping (Amazon, Electronics, Marketplaces, Stores), Work, AI, Trading, Money, Dev, Google, Apple, Microsoft, Social, Watch & Listen, News, Travel. They're only a starting point: rename, move or delete anything.

## Updating

Download the new version and run `Build_and_Install.command` again (or replace the prebuilt app). Your folders, settings and sessions stay: they live in Safari, not in the app.

## Known limits

- Private tabs closed here are permanent. Nothing about them is saved anywhere.
- Undo reopens the URL. Page history, scroll position and form contents are gone.
- Pinned tabs can't be closed from Tab Triage.
- Favicons and "last used" ages appear only if Safari exposes them; otherwise letter icons and no age.
- Tabs in inactive Safari Tab Groups or other Profiles may not appear. Untested.
- Usage is Safari-wide. When Safari is part of macOS itself rather than installed separately, its web processes are shared with other apps (Mail and others), and the numbers include them.
- Safari doesn't say which process is which tab, so there are no per-tab numbers. "Freed" is Safari's total before minus after, so other activity in those seconds shows up too.
- Undo and ↗ switch windows, which dismisses the popup. The action still completes; the ⤢ tab view stays open.
- If you move or delete Tab Triage.app, Safari loses the extension. Keep it in Applications.
