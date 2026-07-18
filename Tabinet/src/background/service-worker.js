/**
 * Tabinet — background service worker (Manifest V3, module).
 *
 * Owns the tab-capture and tab-restore operations so the UI stays thin.
 * The side panel / editor talk to the worker via chrome.runtime.sendMessage.
 * Also wires the toolbar icon to open the docked side panel.
 */

import {
  addGroup,
  getGroups,
  importGroups,
  removeGroup,
  renameGroup,
  updateGroup,
} from "../lib/storage.js";

// Clicking the toolbar icon opens Tabinet's side panel (Safari-style sidebar).
function enableSidePanelOnAction() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("Tabinet setPanelBehavior:", e));
}
enableSidePanelOnAction();
chrome.runtime.onInstalled.addListener(enableSidePanelOnAction);

const isSavable = (t) => t.url && /^https?:/.test(t.url);

/** Capture the tabs of the current window into a saved group. */
async function saveCurrentWindow({ name, color } = {}) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return addGroup({ name, color, tabs: tabs.filter(isSavable) });
}

/** A stable key for a group's tabs (order-independent set of urls). */
function tabsKey(tabs) {
  return tabs
    .map((t) => t.url ?? "")
    .sort()
    .join("\n");
}

/**
 * Capture only the tabs in the active tab's Chrome tab group.
 *
 * Returns:
 *  - { status: "no-group" }        active tab is not part of a group
 *  - { status: "duplicate", group } an identical group is already saved
 *  - { status: "saved", group }     a new group was saved
 *
 * "Identical" means the same name AND the same set of tab urls, so clicking
 * Save group again on an unchanged group won't pile up duplicate copies.
 */
async function saveCurrentGroup() {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!active || active.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return { status: "no-group" };
  }

  const group = await chrome.tabGroups.get(active.groupId);
  const name = group.title || "Untitled group";
  const tabs = (await chrome.tabs.query({ groupId: active.groupId })).filter(
    isSavable,
  );

  const key = tabsKey(tabs);
  const existing = await getGroups();
  const dup = existing.find((g) => g.name === name && tabsKey(g.tabs) === key);
  if (dup) return { status: "duplicate", group: dup };

  const saved = await addGroup({ name, color: group.color, tabs });
  return { status: "saved", group: saved };
}

// Local placeholder page a restored tab points at until the user opens it.
const LAZY_PAGE = chrome.runtime.getURL("src/lazy/lazy.html");

/** Build the lazy-placeholder URL that carries the real url + title. */
function lazyUrl(tab) {
  const q = new URLSearchParams({ u: tab.url ?? "", t: tab.title ?? "" });
  return `${LAZY_PAGE}?${q.toString()}`;
}

/**
 * The real { url, title } a tab represents. A restored-but-unvisited tab sits on
 * our lazy placeholder (a chrome-extension:// url) that carries the real target
 * in ?u= / ?t=; decode that so snapshotting a restored window recovers the real
 * urls instead of dropping every not-yet-loaded tab.
 */
function effectiveTab(tab) {
  const u = tab.url ?? "";
  if (u.startsWith(LAZY_PAGE)) {
    try {
      const p = new URL(u).searchParams;
      return { url: p.get("u") || u, title: p.get("t") || tab.title || "" };
    } catch {
      return { url: u, title: tab.title ?? "" };
    }
  }
  return { url: u, title: tab.title ?? "" };
}

/** Snapshot a window's tabs into savable { url, title } records. */
function snapshotTabs(tabs) {
  return tabs.map(effectiveTab).filter((t) => /^https?:/.test(t.url));
}

/* ------------------------------------------------------------------ *
 * Active-workspace tracking
 *
 * Remembers which saved group is currently loaded in each window. Stored in
 * chrome.storage.local (not session) so the mapping survives a service-worker
 * restart AND a browser restart — the side panel reads it to show which group
 * a window is currently viewing, and the live-sync below writes the window's
 * tabs back into that group as the user browses.
 *
 * The map lives under a single key: { [windowId]: groupId }. Dead windows are
 * pruned on chrome.windows.onRemoved.
 * ------------------------------------------------------------------ */

const ACTIVE_KEY = "tabinet.active";

async function getActiveMap() {
  const data = await chrome.storage.local.get(ACTIVE_KEY);
  return data[ACTIVE_KEY] ?? {};
}

async function getActiveGroup(windowId) {
  return (await getActiveMap())[windowId];
}

async function setActiveGroup(windowId, id) {
  const map = await getActiveMap();
  map[windowId] = id;
  await chrome.storage.local.set({ [ACTIVE_KEY]: map });
}

async function clearActiveGroup(windowId) {
  const map = await getActiveMap();
  if (!(windowId in map)) return;
  delete map[windowId];
  await chrome.storage.local.set({ [ACTIVE_KEY]: map });
}

// Windows currently mid-switch: their tab churn must not trigger live-sync
// (that would write a half-open set into the wrong group).
const switching = new Set();

// Cached tab count per window, so onRemoved can detect "the window just became
// empty" without an async query that might arrive after the window is gone.
const windowTabCounts = new Map();

async function primeTabCounts() {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.id != null) windowTabCounts.set(w.id, (w.tabs ?? []).length);
    }
  } catch (e) {
    console.error("Tabinet primeTabCounts:", e);
  }
}
primeTabCounts();

/* ------------------------------------------------------------------ *
 * Stash window — keep switched-away workspaces' tabs ALIVE (no reload)
 *
 * Chrome has no "hidden tab" API, so switching workspaces used to close the old
 * tabs and reopen the target ones — which reloads them from the network every
 * time you switch back. Instead we PARK the outgoing workspace's live tabs in a
 * single minimized background window and, on return, move them straight back
 * into view. Because the tabs are never closed, their loaded state (scroll,
 * forms, logged-in pages) survives a round trip with zero reload.
 *
 * The stash window keeps a permanent about:blank "keeper" tab so it never
 * auto-closes when its last parked group is pulled back. State lives in
 * storage.local so it survives a service-worker restart:
 *   tabinet.stashWindow -> windowId
 *   tabinet.stashed      -> { [groupId]: tabId[] }
 * It is intentionally session-scoped: after a full browser restart the parked
 * tab ids are stale, so we drop them (the group then reopens lazily).
 * ------------------------------------------------------------------ */

const STASH_WIN_KEY = "tabinet.stashWindow";
const STASH_MAP_KEY = "tabinet.stashed";
const STASH_ORDER_KEY = "tabinet.stashOrder";

// How many switched-away workspaces stay LOADED in the stash window at once.
// Memory is bounded to the active workspace + up to this many parked ones; any
// older parked workspace is evicted (its tabs closed) so memory can't balloon as
// you accumulate workspaces. Evicted groups reopen lazily on return — so the
// common back-and-forth between a couple of workspaces stays reload-free while
// the memory footprint stays fixed. Raise this to trade memory for more
// reload-free workspaces.
const MAX_STASHED_ALIVE = 2;

// In-memory mirror of the stash window id, so the (synchronous) tab-event
// listeners can cheaply skip churn happening inside the stash window.
let stashWindowId = null;

async function loadStashWindowId() {
  const data = await chrome.storage.local.get(STASH_WIN_KEY);
  stashWindowId = data[STASH_WIN_KEY] ?? null;
  // Drop a stale id (window closed / browser restarted while we were asleep).
  if (stashWindowId != null) {
    const win = await chrome.windows.get(stashWindowId).catch(() => null);
    if (!win) await clearStash();
  }
}
loadStashWindowId();

async function getStashedMap() {
  const data = await chrome.storage.local.get(STASH_MAP_KEY);
  return data[STASH_MAP_KEY] ?? {};
}

async function setStashedMap(map) {
  await chrome.storage.local.set({ [STASH_MAP_KEY]: map });
}

// Most-recently-parked-first list of group ids that still hold live parked tabs.
// Drives LRU eviction so the number of loaded parked workspaces stays capped.
async function getStashOrder() {
  const data = await chrome.storage.local.get(STASH_ORDER_KEY);
  return data[STASH_ORDER_KEY] ?? [];
}

async function setStashOrder(order) {
  await chrome.storage.local.set({ [STASH_ORDER_KEY]: order });
}

async function clearStash() {
  stashWindowId = null;
  await chrome.storage.local.remove([
    STASH_WIN_KEY,
    STASH_MAP_KEY,
    STASH_ORDER_KEY,
  ]);
}

const isStashWindow = (wid) => wid != null && wid === stashWindowId;

// Create (once) the minimized background window that parks inactive workspaces.
// A permanent about:blank keeper tab keeps it from auto-closing when emptied.
async function ensureStashWindow() {
  // The service worker is torn down when idle, which drops the in-memory id.
  // Recover it from storage before creating, so a post-restart switch REUSES the
  // existing stash window instead of spawning a brand-new one every time.
  if (stashWindowId == null) await loadStashWindowId();
  if (stashWindowId != null) {
    const win = await chrome.windows.get(stashWindowId).catch(() => null);
    if (win) return stashWindowId;
    stashWindowId = null;
  }
  const win = await chrome.windows
    .create({ focused: false, state: "minimized", url: "about:blank" })
    .catch((e) => {
      console.error("Tabinet ensureStashWindow:", e);
      return null;
    });
  if (!win?.id) return null;
  stashWindowId = win.id;
  await chrome.storage.local.set({ [STASH_WIN_KEY]: win.id });
  // Force it to the background in case the platform surfaced it on creation.
  await chrome.windows
    .update(win.id, { state: "minimized", focused: false })
    .catch(() => {});
  return stashWindowId;
}

// Close a group's parked tabs and forget them; it will reopen lazily on return.
// Frees the tabs' memory. Does NOT touch the LRU order — the caller owns that.
async function closeStashedTabs(groupId) {
  const map = await getStashedMap();
  const ids = map[groupId];
  if (!ids) return;
  delete map[groupId];
  await setStashedMap(map);
  const live = ids.filter((id) => id != null);
  if (live.length) await chrome.tabs.remove(live).catch(() => {});
}

// Park a workspace's live tabs in the stash window (kept loaded, not reloaded),
// then evict the least-recently-parked workspaces beyond MAX_STASHED_ALIVE so
// the loaded-tab count — and memory — stays bounded.
async function stashGroupTabs(groupId, tabIds) {
  const ids = tabIds.filter((id) => id != null);
  if (!ids.length) return;
  const stashWin = await ensureStashWindow();
  if (stashWin == null) {
    // No stash window available — closing is the safe fallback (the snapshot was
    // already persisted, so nothing is lost; it just reloads on return).
    await chrome.tabs.remove(ids).catch(() => {});
    return;
  }
  await chrome.tabs
    .move(ids, { windowId: stashWin, index: -1 })
    .catch((e) => console.error("Tabinet stashGroupTabs:", e));
  // Moving the (formerly active) tabs in can pull the stash window forward on
  // some platforms — keep it minimized and unfocused so it never flashes up.
  await chrome.windows
    .update(stashWin, { state: "minimized", focused: false })
    .catch(() => {});
  const map = await getStashedMap();
  map[groupId] = ids;
  await setStashedMap(map);

  // Mark this group most-recently parked; evict everything past the cap so the
  // number of workspaces held in memory never grows without bound.
  const order = (await getStashOrder()).filter((g) => g !== groupId);
  order.unshift(groupId);
  const evicted = order.splice(MAX_STASHED_ALIVE);
  await setStashOrder(order);
  for (const g of evicted) await closeStashedTabs(g);
}

// Pull a workspace's parked tabs back into `windowId`. Returns the moved tab ids
// (empty when nothing was parked or the parked tabs are gone).
async function unstashGroupTabs(groupId, windowId) {
  const map = await getStashedMap();
  const ids = (map[groupId] ?? []).filter((id) => id != null);
  if (groupId in map) {
    delete map[groupId];
    await setStashedMap(map);
  }
  const order = await getStashOrder();
  const oi = order.indexOf(groupId);
  if (oi !== -1) {
    order.splice(oi, 1);
    await setStashOrder(order);
  }
  if (!ids.length || stashWindowId == null) return [];
  // Keep only tabs that are still alive and still sitting in the stash window.
  const alive = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && t.windowId === stashWindowId) alive.push(id);
  }
  if (!alive.length) return [];
  await chrome.tabs
    .move(alive, { windowId, index: -1 })
    .catch((e) => console.error("Tabinet unstashGroupTabs:", e));
  return alive;
}

// Drop a workspace's parked tabs for good (e.g. its group was deleted).
async function discardStashedGroup(groupId) {
  await closeStashedTabs(groupId);
  const order = await getStashOrder();
  const i = order.indexOf(groupId);
  if (i !== -1) {
    order.splice(i, 1);
    await setStashOrder(order);
  }
}

// Close parked tabs whose group no longer exists. The side panel deletes groups
// straight through the storage layer (not via a worker message), so this is how
// deletions from anywhere get their parked tabs cleaned up.
async function reconcileStash() {
  const map = await getStashedMap();
  const parked = Object.keys(map);
  if (!parked.length) return;
  const alive = new Set((await getGroups()).map((g) => g.id));
  for (const gid of parked) {
    if (!alive.has(gid)) await discardStashedGroup(gid);
  }
}

/**
 * Open a saved group's tabs (in `windowId`), ungrouped.
 *
 * Tabs open onto a tiny LOCAL placeholder page instead of their real URL, so a
 * big group appears instantly with zero network load. Each tab navigates to its
 * real URL only when the user actually views it (see src/lazy/lazy.js). This is
 * how Chrome's own session restore stays fast, and it sidesteps chrome.tabs.
 * discard entirely (which was fragile on freshly-created tabs).
 *
 * We deliberately do NOT bundle the tabs into a native Chrome tab group:
 * a titled tab group gets auto-saved and shown as a chip on the bookmarks bar,
 * which the user doesn't want. Tabinet keeps its own groups in storage instead.
 */
async function openGroupTabs(group, windowId) {
  // Fire every create at once; requests dispatch in array order so tabs still
  // land in order, and each create is cheap (a local page, no network).
  const created = await Promise.all(
    group.tabs.map((tab) =>
      chrome.tabs
        .create({ url: lazyUrl(tab), active: false, windowId })
        .then((t) => t.id),
    ),
  );

  return { created };
}

/** Open every tab of a saved group (ungrouped) in the current window. */
async function restoreGroup(id) {
  const groups = await getGroups();
  const group = groups.find((g) => g.id === id);
  if (!group || group.tabs.length === 0) return;
  await openGroupTabs(group);
}

/**
 * Persist the window's current tabs before we replace them, so switching back
 * and forth never loses tabs — but WITHOUT growing the group count:
 *  - if this window already has an active workspace, write the tabs back into
 *    that same group (in place);
 *  - otherwise (first switch here) adopt a matching saved group if the tabs
 *    already belong to one, and only fall back to a one-time "Backup —" group
 *    when the tabs are genuinely unsaved.
 */
async function persistCurrentTabs(windowId, current, groups) {
  if (!current.length) return; // nothing worth saving; don't empty a group

  const prevId = await getActiveGroup(windowId);
  if (prevId && groups.some((g) => g.id === prevId)) {
    await updateGroup(prevId, { tabs: current });
    return;
  }

  // No known workspace for this window. If the current tabs already match a
  // saved group, they're not lost — adopt it instead of duplicating.
  const key = tabsKey(current);
  if (groups.some((g) => tabsKey(g.tabs) === key)) return;

  await addGroup({ name: `Backup — ${new Date().toLocaleString()}`, tabs: current });
}

/**
 * Switch a window to a saved group (Safari-style workspace switch):
 *  1. write the window's current tabs back into the workspace they came from,
 *  2. bring the target group's tabs into the window — reusing the live tabs we
 *     parked in the stash window last time (no reload) when we still have them,
 *     else opening them lazily,
 *  3. PARK the previously-open tabs in the stash window (kept alive, not closed)
 *     so switching back to them doesn't reload — closing them only when they're
 *     not a tracked workspace,
 *  4. remember the target as this window's active workspace.
 */
async function switchToGroup(id, windowId) {
  const groups = await getGroups();
  const group = groups.find((g) => g.id === id);
  if (!group || group.tabs.length === 0) return;

  // Resolve the target window. Never proceed with an unknown window id — a
  // query without one spans every window and would wipe unrelated tabs.
  if (windowId == null) {
    const w = await chrome.windows.getCurrent().catch(() => null);
    windowId = w?.id;
  }
  if (windowId == null) return restoreGroup(id); // can't scope safely

  const prevId = await getActiveGroup(windowId);
  if (prevId === id) return; // already the active workspace — nothing to do

  // Freeze live-sync for this window while we tear down + rebuild its tabs, so
  // the intermediate churn isn't written back into any group.
  switching.add(windowId);
  try {
    const existing = await chrome.tabs.query({ windowId });
    const current = snapshotTabs(existing);

    // 1) Persist current tabs into their workspace (in place — no new group).
    await persistCurrentTabs(windowId, current, groups);

    // 2) Bring in the target group's tabs. If we still hold them alive in the
    //    stash window, move them straight back (zero reload); otherwise open
    //    fresh lazy placeholders.
    let targetIds = await unstashGroupTabs(id, windowId);
    if (!targetIds.length) {
      ({ created: targetIds } = await openGroupTabs(group, windowId));
    }

    // Activate the target's first tab before touching the old ones, so removing
    // the old active tab doesn't make Chrome surface some other tab first.
    if (targetIds[0] != null) {
      await chrome.tabs.update(targetIds[0], { active: true }).catch(() => {});
    }

    // 3) Park the outgoing tabs (kept alive so returning to them won't reload)
    //    when they belong to a tracked workspace; otherwise close them — they
    //    were already backed up by persistCurrentTabs.
    const oldIds = existing.map((t) => t.id).filter((tid) => tid != null);
    if (prevId && groups.some((g) => g.id === prevId)) {
      await stashGroupTabs(prevId, oldIds);
    } else if (oldIds.length) {
      await chrome.tabs.remove(oldIds);
    }

    // 4) This group is now what's loaded in the window.
    windowTabCounts.set(windowId, targetIds.length);
    await setActiveGroup(windowId, id);

    // Make sure focus stays on the user's window, never the stash window.
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  } finally {
    switching.delete(windowId);
  }
}

/* ------------------------------------------------------------------ *
 * Live workspace sync
 *
 * While a window has an active workspace, mirror its live tabs back into that
 * saved group as the user browses — navigating within a tab, opening/closing/
 * reordering tabs all keep the stored snapshot current. This means the saved
 * group always reflects the real, up-to-date pages (incl. the URL a login flow
 * finally lands on), so closing and reopening never loses where you were.
 * ------------------------------------------------------------------ */

const syncTimers = new Map(); // windowId -> timeout id

function scheduleWorkspaceSync(windowId) {
  if (windowId == null || switching.has(windowId) || isStashWindow(windowId)) {
    return;
  }
  clearTimeout(syncTimers.get(windowId));
  // Coalesce the burst of events a single navigation/close emits.
  syncTimers.set(
    windowId,
    setTimeout(() => {
      syncTimers.delete(windowId);
      syncWorkspace(windowId).catch((e) =>
        console.error("Tabinet syncWorkspace:", e),
      );
    }, 500),
  );
}

async function syncWorkspace(windowId) {
  if (switching.has(windowId)) return;
  const activeId = await getActiveGroup(windowId);
  if (!activeId) return;

  const groups = await getGroups();
  if (!groups.some((g) => g.id === activeId)) {
    // The active group was deleted elsewhere — stop tracking this window.
    await clearActiveGroup(windowId);
    return;
  }

  const tabs = snapshotTabs(await chrome.tabs.query({ windowId }));
  // Never overwrite a saved group with an empty set — an emptied window is
  // handled as a workspace switch (see handleEmptiedWorkspace), not a wipe.
  if (!tabs.length) return;
  await updateGroup(activeId, { tabs });
}

/**
 * The active workspace's tabs were all closed. Instead of letting the window
 * (and possibly Chrome) close, load another saved group into it so the window
 * survives and the user lands somewhere sensible. The just-emptied group keeps
 * its last saved snapshot (we never persist an empty set over it).
 */
async function handleEmptiedWorkspace(windowId, activeId) {
  if (switching.has(windowId)) return;
  switching.add(windowId);
  try {
    // The emptied group's tabs were closed (not parked); drop any stale entry.
    await discardStashedGroup(activeId);
    const groups = await getGroups();
    const next = groups.find((g) => g.id !== activeId && g.tabs.length > 0);
    if (next) {
      // Reuse the next group's parked tabs (no reload) when we still hold them.
      let ids = await unstashGroupTabs(next.id, windowId);
      if (!ids.length) ({ created: ids } = await openGroupTabs(next, windowId));
      if (ids[0] != null) {
        await chrome.tabs.update(ids[0], { active: true }).catch(() => {});
      }
      windowTabCounts.set(windowId, ids.length);
      await setActiveGroup(windowId, next.id);
    } else {
      // Nothing to switch to — just keep a blank tab so the window stays open.
      await chrome.tabs.create({ windowId });
      windowTabCounts.set(windowId, 1);
      await clearActiveGroup(windowId);
    }
  } catch (e) {
    // The window was already gone (e.g. it was the last window and Chrome is
    // quitting) — nothing we can do; just drop the stale mapping.
    console.warn("Tabinet handleEmptiedWorkspace:", e);
    await clearActiveGroup(windowId).catch(() => {});
  } finally {
    switching.delete(windowId);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const wid = tab.windowId;
  if (wid == null || isStashWindow(wid)) return;
  windowTabCounts.set(wid, (windowTabCounts.get(wid) ?? 0) + 1);
  scheduleWorkspaceSync(wid);
});

chrome.tabs.onRemoved.addListener((_tabId, info) => {
  const wid = info.windowId;
  if (isStashWindow(wid)) return; // stash churn is ours; never treat as a wipe
  const prev = windowTabCounts.get(wid) ?? 1;
  const remaining = Math.max(0, prev - 1);
  windowTabCounts.set(wid, remaining);

  if (info.isWindowClosing) return; // whole window going away; leave it be

  (async () => {
    const activeId = await getActiveGroup(wid);
    if (!activeId) return;
    if (remaining <= 0) await handleEmptiedWorkspace(wid, activeId);
    else scheduleWorkspaceSync(wid);
  })().catch((e) => console.error("Tabinet onRemoved:", e));
});

chrome.tabs.onMoved.addListener((_tabId, info) => {
  if (isStashWindow(info.windowId)) return;
  scheduleWorkspaceSync(info.windowId);
});

chrome.tabs.onAttached.addListener((_tabId, info) => {
  if (isStashWindow(info.newWindowId)) return;
  windowTabCounts.set(
    info.newWindowId,
    (windowTabCounts.get(info.newWindowId) ?? 0) + 1,
  );
  scheduleWorkspaceSync(info.newWindowId);
});

chrome.tabs.onDetached.addListener((_tabId, info) => {
  if (isStashWindow(info.oldWindowId)) return;
  const prev = windowTabCounts.get(info.oldWindowId) ?? 1;
  windowTabCounts.set(info.oldWindowId, Math.max(0, prev - 1));
  scheduleWorkspaceSync(info.oldWindowId);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (isStashWindow(tab.windowId)) return;
  // A finished navigation (or a lazy placeholder resolving to its real URL)
  // is the interesting signal — that's when the stored URL should update.
  if (changeInfo.url || changeInfo.status === "complete") {
    scheduleWorkspaceSync(tab.windowId);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  // The stash window went away (user closed it, or the browser restarted) —
  // its parked tabs are gone, so forget all stash bookkeeping.
  if (isStashWindow(windowId)) {
    clearStash().catch(() => {});
    return;
  }
  windowTabCounts.delete(windowId);
  clearTimeout(syncTimers.get(windowId));
  syncTimers.delete(windowId);
  clearActiveGroup(windowId).catch(() => {});
});

// The group list changed (a delete may have happened in the side panel or the
// editor, which write straight to storage). Prune parked tabs for any group
// that no longer exists. "tabinet.order" is the storage layer's group index key.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if ((areaName === "local" || areaName === "sync") && "tabinet.order" in changes) {
    reconcileStash().catch((e) => console.error("Tabinet reconcileStash:", e));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "SAVE_CURRENT_WINDOW":
        sendResponse({ ok: true, group: await saveCurrentWindow(msg.payload) });
        break;
      case "SAVE_CURRENT_GROUP": {
        const res = await saveCurrentGroup();
        sendResponse({ ok: res.status !== "no-group", ...res });
        break;
      }
      case "RESTORE_GROUP":
        // The sidebar's "Open all" switches workspace (persist current tabs
        // in place + close old); other callers (editor) keep additive restore.
        if (msg.switch) await switchToGroup(msg.id, msg.windowId);
        else await restoreGroup(msg.id);
        sendResponse({ ok: true });
        break;
      case "REMOVE_GROUP":
        // Close any tabs still parked for this group before dropping it, so the
        // stash window doesn't keep orphaned tabs alive.
        await discardStashedGroup(msg.id);
        await removeGroup(msg.id);
        sendResponse({ ok: true });
        break;
      case "RENAME_GROUP":
        await renameGroup(msg.id, msg.name);
        sendResponse({ ok: true });
        break;
      case "IMPORT_GROUPS": {
        const count = await importGroups(msg.groups, { mode: msg.mode });
        sendResponse({ ok: true, count });
        break;
      }
      case "LIST_GROUPS":
        sendResponse({ ok: true, groups: await getGroups() });
        break;
      case "GET_ACTIVE_GROUP":
        sendResponse({ ok: true, activeId: await getActiveGroup(msg.windowId) });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  // Keep the message channel open for the async response.
  return true;
});
