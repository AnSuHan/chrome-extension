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

/**
 * Capture only the tabs in the active tab's Chrome tab group.
 * Returns null if the active tab is not part of a group.
 */
async function saveCurrentGroup() {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!active || active.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return null;
  }

  const group = await chrome.tabGroups.get(active.groupId);
  const tabs = await chrome.tabs.query({ groupId: active.groupId });
  return addGroup({
    name: group.title || "Untitled group",
    color: group.color,
    tabs: tabs.filter(isSavable),
  });
}

/** Open every tab of a saved group in a fresh Chrome tab group. */
async function restoreGroup(id) {
  const groups = await getGroups();
  const group = groups.find((g) => g.id === id);
  if (!group || group.tabs.length === 0) return;

  const created = [];
  for (const tab of group.tabs) {
    const t = await chrome.tabs.create({ url: tab.url, active: false });
    created.push(t.id);
  }

  // Bundle the freshly opened tabs into a native Chrome tab group.
  const groupId = await chrome.tabs.group({ tabIds: created });
  await chrome.tabGroups.update(groupId, {
    title: group.name,
    color: group.color,
  });
  return groupId;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "SAVE_CURRENT_WINDOW":
        sendResponse({ ok: true, group: await saveCurrentWindow(msg.payload) });
        break;
      case "SAVE_CURRENT_GROUP": {
        const group = await saveCurrentGroup();
        sendResponse(
          group
            ? { ok: true, group }
            : { ok: false, error: "active tab is not in a group" },
        );
        break;
      }
      case "RESTORE_GROUP":
        await restoreGroup(msg.id);
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
