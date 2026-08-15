# Tabinet

**Tab + Cabinet** — group, save, and restore your tabs. A Safari-style tab-group
manager for Chrome (Manifest V3).

Current version: **1.0.0** — see [CHANGELOG.md](CHANGELOG.md) for the release
history and known limitations.

## What it does

Two surfaces: a **docked side panel** for everyday use, and a **full-page editor**
for detailed changes.

**Side panel** — the Safari-style sidebar. **Click the toolbar icon to dock it**
on the side of the browser; the page you're browsing stays usable on the other
side.

- **Save window** — snapshots every http(s) tab in the current window as a
  named, colored group.
- **Save group** — snapshots only the tabs in the active tab's Chrome tab group,
  keeping its name and color.
- **New group** (`+`) — create an empty group to fill.
- **Browse & open** — each saved group expands to show its tabs. **Click a tab to
  open it** in the current window; **Open all** loads the whole group as the
  window's **active workspace** (the previous tabs are saved back into their own
  group first, then closed). The **Open tabs** header shows a *Viewing &lt;group&gt;*
  badge, and the active group is highlighted with a *Reopen* button.
- **Live workspace sync** — while a group is the active workspace, browsing in it
  (navigating, opening, closing, reordering tabs) is mirrored straight back into
  the saved group, so it always reflects where you actually are — including the
  URL a login flow lands on. Close *all* of a workspace's tabs and Tabinet loads
  another group instead of letting the window (and Chrome) close.
- **Rename / recolor inline** — **double-click a group's name** (or click the ✎)
  to rename it right in the sidebar; **click the color dot** for a quick palette.
- **Edit tabs right in the list**:
  - **+ Add current tab** — append the page you're on to a group.
  - **×** — delete a tab.
  - **drag ⋮⋮** — reorder tabs within a group, or drop onto another group's
    header to **move** the tab there.
- **✎** (top-right) opens the full editor (rename, recolor, JSON, sync). The
  panel updates live as groups change (saves, edits, sync from another device).

**Editor** — a two-pane editor (open via the panel's ✎ or the extension's
Options):

- **Left sidebar** — the list of all groups. Click to select, **+ New group** to
  create, drag the ⠿ handle to **reorder**, hover for delete (×). The colored dot
  and count mirror each group.
- **Right pane** — the selected group's tabs:
  - **Edit** each tab's title and URL inline; **↗** opens it in a new tab.
  - **Reorder** tabs by dragging the ⋮⋮ handle.
  - **Move a tab to another group** by dragging it onto that group in the sidebar.
  - **+ Add tab** appends a new blank tab; **×** removes one.
  - Rename / recolor / **Restore** / delete the group from the header.
- **Save JSON / Load JSON** (sidebar footer) — export all groups to a `.json`
  file, and load one back in either **Merge** (append) or **Replace all** mode.
- **Sync across devices** — toggle to move storage from this device to your
  Google account so groups appear on every Chrome you're signed into.
- **Keep workspaces live in the background** (on by default) — the workspace
  you switch away from keeps running as a Chrome tab group, so
  switching back is instant — but Chrome lists every live tab group in the
  **bookmarks bar**. Turn it off and Tabinet creates no tab groups at all:
  nothing shows up in the bookmarks bar (or the tab strip), and workspaces
  reopen — pre-warmed — when you switch back. Each group's header has a
  **Default / Keep live / Close on switch** selector to override it per
  workspace.

  The bookmarks-bar row is Chrome's own feature, so no extension can hide it:
  to remove it entirely, right-click the bookmarks bar and uncheck **Show tab
  groups**. Chips left over from earlier sessions stay until you right-click
  and delete them once.

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
├── manifest.json              # MV3 manifest (side_panel, options_page, worker)
├── README.md
├── icons/                     # icon16/48/128.png
└── src/
    ├── background/
    │   └── service-worker.js  # opens the side panel; save/restore tab operations
    ├── lib/
    │   └── storage.js         # sharded persistence (local/sync) + edit/reorder/import
    ├── sidepanel/
    │   ├── sidepanel.html     # docked sidebar (default surface)
    │   ├── sidepanel.css      # sidebar styles (light + dark)
    │   └── sidepanel.js       # browse groups, open tabs, quick save
    └── manager/
        ├── manager.html       # full-page two-pane editor (options_page)
        ├── manager.css        # editor styles (light + dark)
        └── manager.js         # create / rename / recolor / reorder / edit / move / JSON
```

## Load it in Chrome (development)

Requires Chrome 114+ (Side Panel API).

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the `Tabinet/` folder.
4. Pin the Tabinet icon. **Click it to open the docked side panel.**

## Permissions

| Permission  | Why |
|-------------|-----|
| `tabs`      | Read the current window's tabs and open/create tabs. |
| `tabGroups` | Read/bundle tabs into a named, colored Chrome tab group. |
| `storage`   | Persist saved groups (local and, if enabled, sync). |
| `downloads` | Write the JSON file when you Save your groups. |
| `sidePanel` | Show the docked sidebar and open it from the toolbar icon. |
| host access (`http`/`https`) | Pre-warm a workspace's pages when you switch to it, so clicking a tab opens an already-signed-in page almost instantly. Tabinet only requests pages you saved yourself; nothing is sent anywhere. |

## Roadmap

- [x] Save the *current* Chrome tab group (not just the whole window)
- [x] Export / import groups as JSON files (Merge / Replace)
- [x] Create empty groups; recolor groups
- [x] Drag-to-reorder groups; move tabs between groups
- [x] Edit tabs within a group (title/url/order/add/remove)
- [x] Optional sync via `chrome.storage.sync`
- [x] Docked side panel: browse groups & open tabs in the live window

## Monorepo note

This folder is one of several Chrome extensions in this repository. Each
extension lives in its own top-level folder and is loaded independently.
