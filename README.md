# chrome-extension

A monorepo of Chrome extensions. Each extension lives in its own top-level
folder and is loaded independently.

## Extensions

| Extension | Folder | What it does |
|-----------|--------|--------------|
| **Tabinet** | [`Tabinet/`](./Tabinet) | Group, save, and restore your tabs — Safari-style tab groups, with a full editor and JSON backup / optional account sync. See [Tabinet/README.md](./Tabinet/README.md). |

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

### Toolbar & icon
- The **Tabinet icon** (stacked blue tab cards) shows in the toolbar. Hovering
  shows the tooltip "Tabinet — group, save & restore tabs".

### Popup (click the toolbar icon)
1. Open several normal `http(s)` tabs.
2. Click **Save window** → a saved group appears in the list ("N tabs").
3. Put some tabs into a native Chrome tab group, keep one of them active, then
   click **Save group** → only that group's tabs are saved with its name/color.
4. **Restore**: click a saved group → its tabs reopen bundled in a Chrome tab
   group with the saved name and color.
5. **Rename** (✎) and **Delete** (×) a group inline (buttons appear on hover).

### Manage page (popup → **Manage / edit**, or the extension's Options)
1. **+ New group** creates an empty group.
2. **Rename** (name field) and **recolor** (color dropdown) a group.
3. **Reorder groups**: drag the ⠿ handle up/down.
4. **Edit tabs**: change a tab's title/URL, drag ⋮⋮ to reorder, remove with ×,
   and **+ Add tab** to add one. Edits save automatically.

### JSON backup
1. **Save JSON** → downloads `tabinet-groups-YYYY-MM-DD.json`.
2. Delete a group, then **Load JSON** with mode **Merge** (re-adds it) or
   **Replace all** (restores the file's exact set).

### Sync (optional)
1. In the Manage page, tick **Sync across devices** → groups move to your Google
   account (`chrome.storage.sync`) and appear on other Chromes signed into the
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
