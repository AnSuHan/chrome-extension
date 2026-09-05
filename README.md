# chrome-extension

A monorepo of Chrome extensions. Each extension lives in its own top-level
folder and is loaded independently.

## Extensions

| Extension | Folder | What it does |
|-----------|--------|--------------|
| **Tabinet** | [`Tabinet/`](./Tabinet) | Group, save, and restore your tabs — a Safari-style **docked side panel** plus a full editor, with JSON backup / optional account sync. See [Tabinet/README.md](./Tabinet/README.md). |

---

## How to load & test an extension (Chrome)

Chrome extensions in this repo are unpacked Manifest V3 extensions — no build
step. Load the extension's folder directly:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the extension folder (e.g. `Tabinet/`).
4. The extension appears in the list with its icon; pin it from the puzzle-piece
   menu so its toolbar icon is always visible.
5. After editing code, click the **↻ reload** icon on the extension's card to
   apply changes. (Reload after editing `manifest.json` or the service worker.)

> Tip: open the extension's **service worker** / **Inspect views** links on the
> `chrome://extensions` card to see console logs and errors while testing.

---

## Testing Tabinet

After loading `Tabinet/` (steps above), verify each feature:

> Requires Chrome 114+ (Side Panel API).

### Toolbar & icon
- The **Tabinet icon** (stacked blue tab cards) shows in the toolbar.
- **Click the icon → the docked side panel opens** on the side of the browser
  (Safari-style). The page you're on stays usable next to it.

### Side panel (the docked sidebar)
1. Open several normal `http(s)` tabs, then click the toolbar icon to open the
   panel.
2. Click **Save window** → a group appears in the list (with its tab count).
3. Put some tabs into a native Chrome tab group, keep one active, then click
   **Save group** → only that group's tabs are saved with its name/color.
4. **Expand** a group (click its header) → its tabs list out. **Click a tab** →
   it opens in the current window (the live browser next to the panel).
5. **Edit in the list**: **+ Add current tab** appends the current page; **×**
   deletes a tab; **drag ⋮⋮** reorders tabs, or drop onto another group's header
   to **move** the tab there. **+** (top) creates a new empty group.
6. **Open all** on a group header → reopens the whole group bundled into a native
   Chrome tab group with the saved name and color.
7. The panel refreshes live when groups change (including edits made in the
   editor). **✎** (top-right) opens the full editor.

### Editor (side panel → **✎**, or the extension's Options)
A two-pane editor: **groups list on the left**, selected group's **tabs on the
right**.
1. **+ New group** (top-left) creates an empty group and selects it.
2. Click a group in the left list to open it on the right.
3. **Reorder groups**: drag the ⠿ handle in the sidebar; delete via × on hover.
4. **Edit tabs** (right pane): change a tab's title/URL (saves automatically),
   click **↗** to open it, drag ⋮⋮ to reorder, remove with ×, **+ Add tab** to add.
5. **Move a tab between groups**: drag a tab row and drop it onto another group in
   the left sidebar (it highlights as a drop target).
6. Rename / recolor / **Restore** / delete the selected group from its header.

### JSON backup (editor → sidebar footer)
1. **Save** → downloads `tabinet-groups-YYYY-MM-DD.json`.
2. Delete a group, then **Load** with mode **Merge** (re-adds it) or
   **Replace all** (restores the file's exact set).

### Sync (optional, editor → sidebar footer)
1. Tick **Sync across devices** → groups move to your Google account
   (`chrome.storage.sync`) and appear on other Chromes signed into the
   same account.
2. Untick to move storage back to this device only.
3. If you have a lot of data, enabling sync may hit the ~100 KB sync limit —
   Tabinet keeps your data on local and shows a message. Use **Save JSON** for
   large backups.

---

## Conventions

- **Manifest V3**, no build step — plain HTML/CSS/JS loaded as unpacked.
- Each extension is self-contained in its own folder with its own `manifest.json`
  and `README.md`.
- Commits: type-prefixed subject (e.g. `Feat:`, `Fix:`) with a
  `Co-Authored-By:` trailer.
