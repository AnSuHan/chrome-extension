# Tabinet

**Tab + Cabinet** — group, save, and restore your tabs. A Safari-style tab-group
manager for Chrome (Manifest V3).

## What it does

**Popup** (quick actions):

- **Save window** — snapshots every http(s) tab in the current window as a
  named, colored group.
- **Save group** — snapshots only the tabs in the active tab's Chrome tab group,
  keeping its name and color.
- **Restore** — click a saved group to reopen all its tabs, bundled into a native
  Chrome tab group with the saved name and color.
- **Rename** (✎) / **Delete** (×) — manage saved groups inline.

**Manage page** (full editor — open via *Manage / edit…* or the extension's
Options):

- **Create** empty groups; **rename** and **recolor** them.
- **Reorder groups** by dragging the ⠿ handle.
- **Edit the tabs inside a group** — change each tab's title and URL, drag ⋮⋮ to
  reorder, remove a tab (×), or **+ Add tab**.
- **Save JSON / Load JSON** — export all groups to a `.json` file, and load one
  back in either **Merge** (append) or **Replace all** mode.
- **Sync across devices** — toggle to move storage from this device to your
  Google account so groups appear on every Chrome you're signed into.

By default everything is stored locally via `chrome.storage.local`; nothing
leaves the browser. JSON files are the explicit save/backup format.

### Storage & sync

Groups are stored **sharded** — an index of ids plus one item per group — so
each item stays small. This matters for the sync backend.

| Backend | Where | Limits |
|---------|-------|--------|
| `chrome.storage.local` (default) | this device only | large (~5 MB) |
| `chrome.storage.sync` (opt-in) | your Google account, all devices | small: ~100 KB total, ~8 KB per group |

Because sync is small, enabling it can fail if you have a lot of groups/tabs —
Tabinet catches the quota error, keeps your data on `local`, and tells you. For
large or long-term backups, prefer **Save JSON**.

## Project structure

```
Tabinet/
├── manifest.json              # MV3 manifest (permissions, popup, worker)
├── README.md
├── icons/                     # icon16/48/128.png
└── src/
    ├── background/
    │   └── service-worker.js  # save / restore / remove tab operations
    ├── lib/
    │   └── storage.js         # sharded persistence (local/sync) + edit/reorder/import
    ├── manager/
    │   ├── manager.html       # full-page group editor (options_page)
    │   ├── manager.css        # editor styles (light + dark)
    │   └── manager.js         # create / rename / recolor / reorder / edit tabs / JSON
    └── popup/
        ├── popup.html         # popup markup
        ├── popup.css          # popup styles (light + dark)
        └── popup.js           # popup UI controller (thin; delegates to worker)
```

## Load it in Chrome (development)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the `Tabinet/` folder.
4. Pin the Tabinet icon and open the popup.

## Permissions

| Permission  | Why |
|-------------|-----|
| `tabs`      | Read the current window's tabs and create tabs on restore. |
| `tabGroups` | Read/bundle tabs into a named, colored Chrome tab group. |
| `storage`   | Persist saved groups (local and, if enabled, sync). |
| `downloads` | Write the JSON file when you Save your groups. |

## Roadmap

- [x] Rename saved groups from the popup
- [x] Save the *current* Chrome tab group (not just the whole window)
- [x] Export / import groups as JSON files (Merge / Replace)
- [x] Create empty groups; recolor groups
- [x] Drag-to-reorder groups
- [x] Edit tabs within a group (title/url/order/add/remove)
- [x] Optional sync via `chrome.storage.sync`

## Monorepo note

This folder is one of several Chrome extensions in this repository. Each
extension lives in its own top-level folder and is loaded independently.
