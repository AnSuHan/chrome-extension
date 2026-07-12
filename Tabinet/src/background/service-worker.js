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
 * Remembers which saved group is currently loaded in each window (in
 * chrome.storage.session, so it survives service-worker restarts but not a
 * browser restart). This lets a workspace switch write the window's tabs back
 * into the group they came from — instead of spawning a new "Backup —" group
 * on every switch, which used to make the group count grow without bound.
 * ------------------------------------------------------------------ */

const ACTIVE_PREFIX = "tabinet.active.";
const activeKey = (windowId) => ACTIVE_PREFIX + windowId;

async function getActiveGroup(windowId) {
  const k = activeKey(windowId);
  const data = await chrome.storage.session.get(k);
  return data[k];
}

async function setActiveGroup(windowId, id) {
  await chrome.storage.session.set({ [activeKey(windowId)]: id });
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
 *  2. open the target group's tabs (ungrouped),
 *  3. close the previously-open tabs so only the target group remains,
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

  const existing = await chrome.tabs.query({ windowId });
  const current = snapshotTabs(existing);

  // 1) Persist current tabs into their workspace (in place — no new group),
  //    concurrently with opening the target group so the write adds no latency.
  const [, { created }] = await Promise.all([
    persistCurrentTabs(windowId, current, groups),
    openGroupTabs(group, windowId),
  ]);

  // 2+3) Activate the first tab (its placeholder then loads the real page),
  //    then close the old tabs. With the new tabs not loading, closing the old
  //    ones no longer competes for network/CPU. Activate first so removing the
  //    old active tab doesn't make Chrome surface a different placeholder.
  if (created[0] != null) await chrome.tabs.update(created[0], { active: true });
  const oldIds = existing.map((t) => t.id).filter((tid) => tid != null);
  if (oldIds.length) await chrome.tabs.remove(oldIds);

  // 4) This group is now what's loaded in the window.
  await setActiveGroup(windowId, id);
}

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
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  // Keep the message channel open for the async response.
  return true;
});
