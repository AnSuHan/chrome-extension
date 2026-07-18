/**
 * Tabinet — background service worker (Manifest V3, module).
 *
 * Owns tab capture / restore and Safari-style workspace switching so the UI
 * stays thin. The side panel / editor talk to the worker via
 * chrome.runtime.sendMessage. Also wires the toolbar icon to the side panel.
 *
 * Workspace model — native tab groups (no reload, nothing leaks into Alt+Tab):
 *   Each loaded workspace lives as a NATIVE Chrome tab group INSIDE the window.
 *   The active workspace's group is expanded; every other loaded workspace's
 *   group is collapsed, so its tabs are hidden (only a chip remains) but stay
 *   fully loaded. Switching just collapses the current group and expands the
 *   target's — the tabs are never closed, so there is zero reload and no extra
 *   browser window (which would otherwise show up in Alt+Tab / the taskbar).
 *   A per-window LRU cap bounds how many workspaces stay loaded at once so
 *   memory can't grow without limit; evicted ones reopen lazily on return.
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

/** Snapshot a list of tabs into savable { url, title } records. */
function snapshotTabs(tabs) {
  return tabs.map(effectiveTab).filter((t) => /^https?:/.test(t.url));
}

/* ------------------------------------------------------------------ *
 * Active-workspace tracking
 *
 * Remembers which saved group is currently active (expanded) in each window.
 * Stored in chrome.storage.local (not session) so the mapping survives a
 * service-worker restart — the side panel reads it to show which workspace a
 * window is viewing, and live-sync writes that workspace's tabs back as the
 * user browses. The map lives under one key: { [windowId]: savedGroupId }.
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

// Windows currently mid-switch: their tab churn must not trigger live-sync,
// new-tab adoption, or emptied-workspace handling (that would write a half-open
// set into the wrong group, or re-enter the switch).
const switching = new Set();

/* ------------------------------------------------------------------ *
 * Workspace ↔ native-tab-group bookkeeping
 *
 * Two storage.local maps, nested by window so multiple windows each keep their
 * own loaded workspaces:
 *   tabinet.wsgroups -> { [windowId]: { [savedGroupId]: nativeTabGroupId } }
 *   tabinet.wsorder  -> { [windowId]: [savedGroupId, ...] }   // MRU-first (LRU)
 * Native tab-group ids are real browser state, so they survive a service-worker
 * restart; we validate them with chrome.tabGroups.get before trusting them.
 * ------------------------------------------------------------------ */

const WS_MAP_KEY = "tabinet.wsgroups";
const WS_ORDER_KEY = "tabinet.wsorder";
const NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;

// Per window, how many workspaces stay LOADED (grouped, in memory) at once.
// The active one + a few recent ones are kept live for zero-reload switching;
// beyond this the least-recently-used workspace's tabs are closed (it reopens
// lazily on return), so memory stays bounded no matter how many workspaces you
// accumulate. Raise to trade memory for more reload-free workspaces.
const MAX_LOADED_WORKSPACES = 3;

// Our color names line up 1:1 with chrome.tabGroups.Color; fall back defensively.
const VALID_GROUP_COLORS = new Set([
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange",
]);
const colorFor = (c) => (VALID_GROUP_COLORS.has(c) ? c : "grey");

async function getAllWs(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] ?? {};
}

async function getWsMap(windowId) {
  return (await getAllWs(WS_MAP_KEY))[windowId] ?? {};
}

async function setWsMap(windowId, map) {
  const all = await getAllWs(WS_MAP_KEY);
  if (Object.keys(map).length) all[windowId] = map;
  else delete all[windowId];
  await chrome.storage.local.set({ [WS_MAP_KEY]: all });
}

async function getWsOrder(windowId) {
  return (await getAllWs(WS_ORDER_KEY))[windowId] ?? [];
}

async function setWsOrder(windowId, order) {
  const all = await getAllWs(WS_ORDER_KEY);
  if (order.length) all[windowId] = order;
  else delete all[windowId];
  await chrome.storage.local.set({ [WS_ORDER_KEY]: all });
}

// Mark a workspace most-recently-used in its window (front of the LRU list).
async function touchWorkspaceOrder(windowId, savedId) {
  const order = (await getWsOrder(windowId)).filter((s) => s !== savedId);
  order.unshift(savedId);
  await setWsOrder(windowId, order);
}

// Forget all bookkeeping for a closed window.
async function cleanupWindow(windowId) {
  const mapAll = await getAllWs(WS_MAP_KEY);
  if (windowId in mapAll) {
    delete mapAll[windowId];
    await chrome.storage.local.set({ [WS_MAP_KEY]: mapAll });
  }
  const ordAll = await getAllWs(WS_ORDER_KEY);
  if (windowId in ordAll) {
    delete ordAll[windowId];
    await chrome.storage.local.set({ [WS_ORDER_KEY]: ordAll });
  }
  await clearActiveGroup(windowId);
}

// The native tab-group id currently holding `savedId` in `windowId`, or null if
// it isn't loaded (or its group was torn down behind our back).
async function loadedGroupId(windowId, savedId) {
  const gid = (await getWsMap(windowId))[savedId];
  if (gid == null) return null;
  const g = await chrome.tabGroups.get(gid).catch(() => null);
  if (g && g.windowId === windowId) return gid;
  // Stale mapping — drop it.
  const map = await getWsMap(windowId);
  delete map[savedId];
  await setWsMap(windowId, map);
  return null;
}

async function setLoadedGroupId(windowId, savedId, gid) {
  const map = await getWsMap(windowId);
  if (gid == null) delete map[savedId];
  else map[savedId] = gid;
  await setWsMap(windowId, map);
}

/**
 * Open a saved workspace as a fresh native tab group in `windowId`.
 *
 * Tabs open onto a tiny LOCAL placeholder page (see src/lazy/lazy.js) instead
 * of their real URL, so a big workspace appears instantly with zero network
 * load; each tab navigates to its real URL only when first viewed. The tabs are
 * then bundled into one native tab group titled/colored like the workspace.
 * Returns { gid, tabIds } (gid null if nothing could be opened).
 */
async function openWorkspaceGroup(group, windowId) {
  const created = await Promise.all(
    group.tabs.map((tab) =>
      chrome.tabs
        .create({ url: lazyUrl(tab), active: false, windowId })
        .then((t) => t.id)
        .catch(() => null),
    ),
  );
  const tabIds = created.filter((id) => id != null);
  if (!tabIds.length) return { gid: null, tabIds: [] };

  let gid = null;
  try {
    gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(gid, {
      title: group.name,
      color: colorFor(group.color),
      collapsed: false,
    });
  } catch (e) {
    console.error("Tabinet openWorkspaceGroup:", e);
  }
  if (gid != null) await setLoadedGroupId(windowId, group.id, gid);
  return { gid, tabIds };
}

/**
 * Ensure the outgoing active workspace's tabs are inside its native group, so
 * we can collapse them out of sight. Any stray ungrouped tabs in the window
 * (e.g. plain new tabs) are folded into that group too. Returns the group id.
 */
async function ensureWorkspaceGrouped(windowId, group) {
  const ungrouped = await chrome.tabs.query({ windowId, groupId: NONE });
  const strayIds = ungrouped.map((t) => t.id).filter((id) => id != null);
  let gid = await loadedGroupId(windowId, group.id);

  if (gid != null) {
    if (strayIds.length) {
      await chrome.tabs.group({ tabIds: strayIds, groupId: gid }).catch((e) =>
        console.error("Tabinet ensureWorkspaceGrouped add:", e),
      );
    }
    return gid;
  }
  if (!strayIds.length) return null; // nothing to group
  try {
    gid = await chrome.tabs.group({
      tabIds: strayIds,
      createProperties: { windowId },
    });
    await chrome.tabGroups.update(gid, {
      title: group.name,
      color: colorFor(group.color),
    });
  } catch (e) {
    console.error("Tabinet ensureWorkspaceGrouped create:", e);
    return null;
  }
  await setLoadedGroupId(windowId, group.id, gid);
  return gid;
}

// Close a loaded workspace's tabs and forget its group (reopens lazily later).
async function closeWorkspaceTabs(windowId, savedId) {
  const gid = (await getWsMap(windowId))[savedId];
  await setLoadedGroupId(windowId, savedId, null);
  const order = (await getWsOrder(windowId)).filter((s) => s !== savedId);
  await setWsOrder(windowId, order);
  if (gid == null) return;
  const tabs = await chrome.tabs.query({ windowId, groupId: gid }).catch(() => []);
  const ids = tabs.map((t) => t.id).filter((id) => id != null);
  if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
}

// Enforce the per-window loaded-workspace cap by evicting the least-recently
// used ones. The active/target workspace sits at the front, so it's never hit.
async function evictWorkspaces(windowId) {
  const order = await getWsOrder(windowId);
  if (order.length <= MAX_LOADED_WORKSPACES) return;
  const evicted = order.slice(MAX_LOADED_WORKSPACES);
  for (const savedId of evicted) await closeWorkspaceTabs(windowId, savedId);
}

/** Open every tab of a saved group (ungrouped, additive) in the current window. */
async function restoreGroup(id) {
  const groups = await getGroups();
  const group = groups.find((g) => g.id === id);
  if (!group || group.tabs.length === 0) return;
  await Promise.all(
    group.tabs.map((tab) =>
      chrome.tabs.create({ url: lazyUrl(tab), active: false }).catch(() => {}),
    ),
  );
}

/**
 * Persist unsaved ungrouped tabs before we clear them, so a first-ever switch
 * from a not-yet-tracked window never loses them: adopt a matching saved group
 * if the tabs already belong to one, else drop a one-time "Backup —" group.
 */
async function persistUnsavedTabs(current, groups) {
  if (!current.length) return;
  const key = tabsKey(current);
  if (groups.some((g) => tabsKey(g.tabs) === key)) return; // already saved
  await addGroup({ name: `Backup — ${new Date().toLocaleString()}`, tabs: current });
}

/**
 * Switch a window to a saved workspace (Safari-style):
 *  1. bring the target workspace into view — reuse its already-loaded native
 *     group (expand it → zero reload) when present, else open it fresh,
 *  2. hide the OUTGOING workspace by collapsing its native group (its tabs are
 *     kept alive, just not visible), grouping any stray ungrouped tabs first,
 *  3. bound memory by evicting least-recently-used loaded workspaces,
 *  4. remember the target as this window's active workspace.
 */
async function switchToGroup(id, windowId) {
  const groups = await getGroups();
  const group = groups.find((g) => g.id === id);
  if (!group || group.tabs.length === 0) return;

  if (windowId == null) {
    const w = await chrome.windows.getCurrent().catch(() => null);
    windowId = w?.id;
  }
  if (windowId == null) return restoreGroup(id); // can't scope safely

  const prevId = await getActiveGroup(windowId);
  if (prevId === id) {
    // Already active — just make sure it's expanded and focused.
    const gid = await loadedGroupId(windowId, id);
    if (gid != null) await chrome.tabGroups.update(gid, { collapsed: false }).catch(() => {});
    return;
  }

  switching.add(windowId);
  try {
    // 1) Bring the target into view: reuse its loaded group (no reload) or open.
    let gid = await loadedGroupId(windowId, id);
    let firstTabId = null;
    if (gid != null) {
      await chrome.tabGroups.update(gid, { collapsed: false }).catch(() => {});
      const tabs = await chrome.tabs.query({ windowId, groupId: gid });
      firstTabId = tabs[0]?.id ?? null;
    } else {
      const opened = await openWorkspaceGroup(group, windowId);
      gid = opened.gid;
      firstTabId = opened.tabIds[0] ?? null;
    }
    if (firstTabId != null) {
      await chrome.tabs.update(firstTabId, { active: true }).catch(() => {});
    }

    // 2) Hide the outgoing workspace. If it's a tracked workspace, group its
    //    (now-ungrouped) tabs and collapse them out of sight. Otherwise the
    //    ungrouped tabs are unsaved scratch — back them up and clear them.
    if (prevId && groups.some((g) => g.id === prevId)) {
      const prevGroup = groups.find((g) => g.id === prevId);
      const prevGid = await ensureWorkspaceGrouped(windowId, prevGroup);
      if (prevGid != null) {
        await chrome.tabGroups.update(prevGid, { collapsed: true }).catch(() => {});
        await touchWorkspaceOrder(windowId, prevId);
      }
    } else {
      const ungrouped = await chrome.tabs.query({ windowId, groupId: NONE });
      await persistUnsavedTabs(snapshotTabs(ungrouped), groups);
      const ids = ungrouped.map((t) => t.id).filter((tid) => tid != null);
      if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
    }

    // 3) Mark target most-recent, then enforce the memory cap.
    await touchWorkspaceOrder(windowId, id);
    await evictWorkspaces(windowId);

    // 4) Record the active workspace and keep focus on this window.
    await setActiveGroup(windowId, id);
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  } finally {
    switching.delete(windowId);
  }
}

/* ------------------------------------------------------------------ *
 * Live workspace sync
 *
 * While a window has an active workspace, mirror the tabs in that workspace's
 * native group back into the saved group as the user browses — so the stored
 * snapshot always reflects the real, up-to-date pages (including where a login
 * flow finally lands). Only the ACTIVE group's tabs are synced; collapsed
 * (background) workspaces keep the snapshot they were frozen with.
 * ------------------------------------------------------------------ */

const syncTimers = new Map(); // windowId -> timeout id

function scheduleWorkspaceSync(windowId) {
  if (windowId == null || switching.has(windowId)) return;
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
    await clearActiveGroup(windowId); // deleted elsewhere — stop tracking
    return;
  }

  // The active workspace's tabs are those in its native group, or — before it
  // has been grouped — the window's ungrouped tabs.
  const gid = await loadedGroupId(windowId, activeId);
  const query = gid != null ? { windowId, groupId: gid } : { windowId, groupId: NONE };
  const tabs = snapshotTabs(await chrome.tabs.query(query));
  // Never overwrite a saved group with an empty set — an emptied workspace is
  // handled as a switch (see handleEmptiedWorkspace), not a wipe.
  if (!tabs.length) return;
  await updateGroup(activeId, { tabs });
}

/**
 * The active workspace's tabs were all closed. Switch the window to another
 * loaded workspace (expand its collapsed group — no reload) if one exists, else
 * open the next saved group, else leave a blank tab so the window survives. The
 * just-emptied group keeps its last saved snapshot.
 */
async function handleEmptiedWorkspace(windowId, activeId) {
  if (switching.has(windowId)) return;
  switching.add(windowId);
  try {
    // The emptied workspace's tabs are gone; forget its (now-empty) group.
    await closeWorkspaceTabs(windowId, activeId);

    // Prefer another workspace already loaded in this window (zero reload).
    const order = await getWsOrder(windowId);
    let nextId = null;
    for (const sid of order) {
      if (sid === activeId) continue;
      if ((await loadedGroupId(windowId, sid)) != null) {
        nextId = sid;
        break;
      }
    }
    if (nextId != null) {
      const gid = await loadedGroupId(windowId, nextId);
      await chrome.tabGroups.update(gid, { collapsed: false }).catch(() => {});
      const tabs = await chrome.tabs.query({ windowId, groupId: gid });
      if (tabs[0]?.id != null) {
        await chrome.tabs.update(tabs[0].id, { active: true }).catch(() => {});
      }
      await touchWorkspaceOrder(windowId, nextId);
      await setActiveGroup(windowId, nextId);
      return;
    }

    // Nothing loaded — open the next non-empty saved group lazily.
    const groups = await getGroups();
    const next = groups.find((g) => g.id !== activeId && g.tabs.length > 0);
    if (next) {
      const { tabIds } = await openWorkspaceGroup(next, windowId);
      if (tabIds[0] != null) {
        await chrome.tabs.update(tabIds[0], { active: true }).catch(() => {});
      }
      await touchWorkspaceOrder(windowId, next.id);
      await setActiveGroup(windowId, next.id);
    } else {
      await chrome.tabs.create({ windowId }).catch(() => {});
      await clearActiveGroup(windowId);
    }
  } catch (e) {
    console.warn("Tabinet handleEmptiedWorkspace:", e);
    await clearActiveGroup(windowId).catch(() => {});
  } finally {
    switching.delete(windowId);
  }
}

// Count the tabs currently belonging to a window's active workspace.
async function activeWorkspaceTabCount(windowId, activeId) {
  const gid = await loadedGroupId(windowId, activeId);
  const query = gid != null ? { windowId, groupId: gid } : { windowId, groupId: NONE };
  const tabs = await chrome.tabs.query(query).catch(() => []);
  return tabs.length;
}

/**
 * A plain new tab (Ctrl+T, sidebar "new tab", a link opened in a new tab) lands
 * ungrouped. Fold it into the active workspace's group so it belongs to that
 * workspace — otherwise it would stay visible after we collapse the group on the
 * next switch, leaking into the next workspace's view.
 */
async function adoptTabIntoActiveGroup(tab) {
  if (tab.groupId != null && tab.groupId !== NONE) return; // already grouped
  const windowId = tab.windowId;
  const activeId = await getActiveGroup(windowId);
  if (!activeId) return;
  const gid = await loadedGroupId(windowId, activeId);
  if (gid == null) return; // active workspace isn't grouped yet; it IS the visible set
  await chrome.tabs.group({ tabIds: [tab.id], groupId: gid }).catch(() => {});
}

/**
 * Close a deleted workspace's loaded tabs across every window, and forget it.
 * The side panel / editor delete groups straight through the storage layer, so
 * a storage.onChanged listener drives this on any deletion.
 */
async function reconcileWorkspaces() {
  const alive = new Set((await getGroups()).map((g) => g.id));
  const mapAll = await getAllWs(WS_MAP_KEY);
  for (const [windowId, map] of Object.entries(mapAll)) {
    for (const savedId of Object.keys(map)) {
      if (!alive.has(savedId)) await closeWorkspaceTabs(Number(windowId), savedId);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */

chrome.tabs.onCreated.addListener((tab) => {
  const wid = tab.windowId;
  if (wid == null || switching.has(wid)) return; // our own switch churn
  adoptTabIntoActiveGroup(tab).catch((e) =>
    console.error("Tabinet adoptTab:", e),
  );
  scheduleWorkspaceSync(wid);
});

chrome.tabs.onRemoved.addListener((_tabId, info) => {
  const wid = info.windowId;
  if (info.isWindowClosing) return; // whole window going away; leave it be
  (async () => {
    const activeId = await getActiveGroup(wid);
    if (!activeId) return;
    if ((await activeWorkspaceTabCount(wid, activeId)) <= 0) {
      await handleEmptiedWorkspace(wid, activeId);
    } else {
      scheduleWorkspaceSync(wid);
    }
  })().catch((e) => console.error("Tabinet onRemoved:", e));
});

chrome.tabs.onMoved.addListener((_tabId, info) =>
  scheduleWorkspaceSync(info.windowId),
);

chrome.tabs.onAttached.addListener((_tabId, info) =>
  scheduleWorkspaceSync(info.newWindowId),
);

chrome.tabs.onDetached.addListener((_tabId, info) =>
  scheduleWorkspaceSync(info.oldWindowId),
);

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // A finished navigation (or a lazy placeholder resolving to its real URL) is
  // the interesting signal — that's when the stored URL should update.
  if (changeInfo.url || changeInfo.status === "complete") {
    scheduleWorkspaceSync(tab.windowId);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearTimeout(syncTimers.get(windowId));
  syncTimers.delete(windowId);
  cleanupWindow(windowId).catch((e) => console.error("Tabinet onRemoved(win):", e));
});

// A deletion in the side panel / editor writes straight to storage; prune any
// loaded tabs for groups that no longer exist. "tabinet.order" is the storage
// layer's group index key, which changes on add/remove.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if ((areaName === "local" || areaName === "sync") && "tabinet.order" in changes) {
    reconcileWorkspaces().catch((e) =>
      console.error("Tabinet reconcileWorkspaces:", e),
    );
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
        // "Open all" switches workspace (collapse current + show target); other
        // callers (editor) keep the additive restore.
        if (msg.switch) await switchToGroup(msg.id, msg.windowId);
        else await restoreGroup(msg.id);
        sendResponse({ ok: true });
        break;
      case "REMOVE_GROUP":
        await removeGroup(msg.id); // reconcileWorkspaces (storage.onChanged) cleans tabs
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
