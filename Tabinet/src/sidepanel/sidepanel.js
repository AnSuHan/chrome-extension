/**
 * Tabinet — side panel (the docked, Safari-style sidebar).
 *
 * Top section — live open tabs of this window:
 *  - click a tab to switch to it,
 *  - right-click for a menu (new tab / duplicate / close),
 *  - drag a tab to reorder the real browser tabs,
 *  - the list mirrors the window in real time via chrome.tabs events.
 *
 * Bottom section — saved groups:
 *  - open a saved tab in the current window (click it),
 *  - add the current page to a group, delete a tab, reorder tabs (drag),
 *  - move a tab to another group (drag it onto that group's header),
 *  - quick-save the window / active tab group, and create empty groups.
 *
 * Saved-group reads come from the storage layer (respects the local/sync
 * setting); tab capture/restore is delegated to the service worker.
 */

import {
  addEmptyGroup,
  getGroups,
  removeGroup,
  updateGroup,
} from "../lib/storage.js";

const COLOR_HEX = {
  grey: "#9ca3af",
  blue: "#3b82f6",
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  pink: "#ec4899",
  purple: "#a855f7",
  cyan: "#06b6d4",
  orange: "#f97316",
};

const listEl = document.getElementById("group-list");
const emptyEl = document.getElementById("empty");
const toastEl = document.getElementById("toast");
const saveWindowBtn = document.getElementById("save-window-btn");
const saveGroupBtn = document.getElementById("save-group-btn");
const newGroupBtn = document.getElementById("new-group-btn");
const editorBtn = document.getElementById("editor-btn");
const openListEl = document.getElementById("open-list");
const openCountEl = document.getElementById("open-count");
const newTabBtn = document.getElementById("new-tab-btn");
const ctxMenu = document.getElementById("ctx-menu");

// The window that hosts this side panel. Resolved once; all live-tab queries
// and events are scoped to it so the sidebar always mirrors its own window.
let panelWindowId = chrome.windows.WINDOW_ID_NONE;

const expanded = new Set(); // ids of groups shown expanded
let cache = []; // last-rendered groups

const byId = (id) => cache.find((g) => g.id === id);

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* ================================================================== *
 * Live open tabs (Safari-style sidebar)
 *
 * Mirrors the current window's tabs: click to switch, right-click to
 * create / duplicate / close, drag to reorder the real browser tabs.
 * ================================================================== */

// Resolve the tabs of the window that hosts this side panel. `currentWindow`
// works in most cases; if it comes back empty we fall back to the explicit
// window id from chrome.windows.getCurrent() so the list is never left blank.
async function queryOpenTabs() {
  let tabs = await chrome.tabs.query({ currentWindow: true });
  if (!tabs.length) {
    try {
      const win = await chrome.windows.getCurrent();
      if (win?.id != null) tabs = await chrome.tabs.query({ windowId: win.id });
    } catch (e) {
      console.error("Tabinet: window resolution failed", e);
    }
  }
  return tabs;
}

function createTab() {
  const opts = { active: true };
  if (panelWindowId !== chrome.windows.WINDOW_ID_NONE) opts.windowId = panelWindowId;
  chrome.tabs.create(opts);
}

// Sanitize a favicon URL for safe interpolation into a CSS url("…").
function cssUrl(url) {
  return url.replace(/["\\]/g, "\\$&").replace(/\r?\n/g, "");
}

// Tabs a restored group opened sit on our lazy placeholder until visited; show
// their real destination (carried in the ?u= param) rather than the ext URL.
const LAZY_PAGE = chrome.runtime.getURL("src/lazy/lazy.html");
function realUrlOf(tab) {
  const u = tab.url ?? "";
  if (u.startsWith(LAZY_PAGE)) {
    try {
      return new URL(u).searchParams.get("u") || u;
    } catch {
      return u;
    }
  }
  return u;
}

// Globe drawn under every favicon; shows through when the favicon is missing
// or fails to load (a broken favicon layer renders transparent). Kept in sync
// with the `.otab-fav` default background in sidepanel.css.
const GLOBE_FALLBACK =
  'url("data:image/svg+xml;utf8,' +
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' " +
  "stroke='%239aa1ac' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
  "<circle cx='12' cy='12' r='9'/>" +
  "<path d='M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18'/></svg>\")";

function buildOpenTab(tab) {
  const li = document.createElement("li");
  li.className = "otab" + (tab.active ? " active" : "");
  li.dataset.id = String(tab.id);
  li.dataset.index = String(tab.index);
  li.draggable = true;

  const fav = document.createElement("span");
  fav.className = "otab-fav";
  // The favicon is layered over a globe fallback: if the favicon URL fails to
  // load, the globe underneath simply shows through (no broken-image icon).
  if (tab.favIconUrl) {
    fav.style.backgroundImage = `url("${cssUrl(tab.favIconUrl)}"), ${GLOBE_FALLBACK}`;
  }

  const url = realUrlOf(tab);
  const meta = document.createElement("span");
  meta.className = "otab-meta";
  const title = document.createElement("span");
  title.className = "otab-title";
  title.textContent = tab.title || hostOf(url) || "New tab";
  const host = document.createElement("span");
  host.className = "otab-host";
  host.textContent = hostOf(url);
  meta.append(title, host);

  const close = document.createElement("button");
  close.className = "otab-close";
  close.type = "button";
  close.textContent = "×";
  close.title = "Close tab";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.tabs.remove(tab.id);
  });

  li.append(fav, meta, close);

  // Click anywhere on the row (but the close button) activates the tab.
  li.addEventListener("click", () => activateTab(tab.id));
  return li;
}

function activateTab(id) {
  chrome.tabs.update(id, { active: true });
  if (panelWindowId !== chrome.windows.WINDOW_ID_NONE) {
    chrome.windows.update(panelWindowId, { focused: true });
  }
}

let openRenderQueued = false;
function scheduleOpenRender() {
  if (openRenderQueued) return;
  openRenderQueued = true;
  // Coalesce the burst of events a single navigation/close can emit.
  setTimeout(async () => {
    openRenderQueued = false;
    await renderOpenTabs();
  }, 40);
}

async function renderOpenTabs() {
  const tabs = await queryOpenTabs();
  tabs.sort((a, b) => a.index - b.index);
  // Remember this window so new tabs land here and events can be filtered.
  if (tabs.length) panelWindowId = tabs[0].windowId;
  openListEl.innerHTML = "";
  if (!tabs.length) {
    const li = document.createElement("li");
    li.className = "otab-empty";
    li.textContent = "No open tabs found.";
    openListEl.append(li);
  } else {
    for (const tab of tabs) openListEl.append(buildOpenTab(tab));
  }
  openCountEl.textContent = String(tabs.length);
}

/* ---- drag to reorder the real browser tabs ---- */

let openDrag = null; // { id, index, el }

function clearOpenMarks() {
  for (const el of openListEl.querySelectorAll(".drop-before, .drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

openListEl.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".otab");
  if (!row) return;
  openDrag = {
    id: Number(row.dataset.id),
    index: Number(row.dataset.index),
    el: row,
  };
  row.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
});

openListEl.addEventListener("dragover", (e) => {
  if (!openDrag) return;
  const row = e.target.closest(".otab");
  if (!row || row === openDrag.el) return;
  e.preventDefault();
  clearOpenMarks();
  row.classList.add(isAfter(e, row) ? "drop-after" : "drop-before");
});

openListEl.addEventListener("drop", (e) => {
  if (!openDrag) return;
  const row = e.target.closest(".otab");
  if (row && row !== openDrag.el) {
    e.preventDefault();
    const from = openDrag.index;
    let to = Number(row.dataset.index);
    if (isAfter(e, row)) to += 1;
    if (from < to) to -= 1;
    if (from !== to) chrome.tabs.move(openDrag.id, { index: to });
  }
  cleanupOpenDrag();
});

openListEl.addEventListener("dragend", cleanupOpenDrag);

function cleanupOpenDrag() {
  clearOpenMarks();
  openDrag?.el?.classList.remove("dragging");
  openDrag = null;
}

/* ---- right-click context menu ---- */

let ctxTargetId = null; // tab id the menu was opened on (null = empty area)

function showCtxMenu(x, y, tabId) {
  ctxTargetId = tabId;
  ctxMenu.hidden = false;
  // Clamp to the viewport so the menu never spills off-screen.
  const w = ctxMenu.offsetWidth;
  const h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, window.innerWidth - w - 6) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - h - 6) + "px";
  // Tab-specific items make no sense on empty area.
  const onTab = tabId != null;
  for (const item of ctxMenu.querySelectorAll('[data-act="duplicate"],[data-act="close"]')) {
    item.hidden = !onTab;
  }
}

function hideCtxMenu() {
  ctxMenu.hidden = true;
  ctxTargetId = null;
}

openListEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const row = e.target.closest(".otab");
  showCtxMenu(e.clientX, e.clientY, row ? Number(row.dataset.id) : null);
});

// Right-clicking the empty part of the section still offers "New tab".
document.getElementById("open-section").addEventListener("contextmenu", (e) => {
  if (e.target.closest(".otab")) return; // handled above
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, null);
});

ctxMenu.addEventListener("click", (e) => {
  const btn = e.target.closest(".ctx-item");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "new") {
    createTab();
  } else if (act === "duplicate" && ctxTargetId != null) {
    chrome.tabs.duplicate(ctxTargetId);
  } else if (act === "close" && ctxTargetId != null) {
    chrome.tabs.remove(ctxTargetId);
  }
  hideCtxMenu();
});

// Any click / scroll / Escape elsewhere dismisses the menu.
window.addEventListener("click", (e) => {
  if (!ctxMenu.hidden && !e.target.closest("#ctx-menu")) hideCtxMenu();
});
window.addEventListener("blur", hideCtxMenu);
document.addEventListener("scroll", hideCtxMenu, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideCtxMenu();
});

newTabBtn.addEventListener("click", createTab);

/* ---- keep the live list in sync with the browser ---- */

function wireOpenTabEvents() {
  chrome.tabs.onCreated.addListener(scheduleOpenRender);
  chrome.tabs.onRemoved.addListener(scheduleOpenRender);
  chrome.tabs.onMoved.addListener(scheduleOpenRender);
  chrome.tabs.onActivated.addListener(scheduleOpenRender);
  chrome.tabs.onAttached.addListener(scheduleOpenRender);
  chrome.tabs.onDetached.addListener(scheduleOpenRender);
  chrome.tabs.onReplaced.addListener(scheduleOpenRender);
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    // Only re-render on changes that are visible in the row.
    if (
      "title" in changeInfo ||
      "favIconUrl" in changeInfo ||
      "url" in changeInfo ||
      "status" in changeInfo
    ) {
      scheduleOpenRender();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Data operations
 * ------------------------------------------------------------------ */

async function addCurrentTab(groupId) {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!active || !/^https?:/.test(active.url ?? "")) {
    toast("Can't add this page.");
    return;
  }
  const g = byId(groupId);
  if (!g) return;
  g.tabs.push({ title: active.title ?? "", url: active.url });
  await updateGroup(groupId, { tabs: g.tabs });
  expanded.add(groupId);
  toast("Added current tab.");
  reload();
}

async function deleteTab(groupId, index) {
  const g = byId(groupId);
  if (!g) return;
  g.tabs.splice(index, 1);
  await updateGroup(groupId, { tabs: g.tabs });
  reload();
}

async function reorderTab(groupId, from, targetIndex, after) {
  const g = byId(groupId);
  if (!g) return;
  let to = targetIndex;
  if (after) to += 1;
  if (from < to) to -= 1;
  if (from === to) return;
  const [t] = g.tabs.splice(from, 1);
  g.tabs.splice(to, 0, t);
  await updateGroup(groupId, { tabs: g.tabs });
  reload();
}

async function moveTab(fromId, index, toId) {
  if (fromId === toId) return;
  const from = byId(fromId);
  const to = byId(toId);
  if (!from || !to) return;
  const [t] = from.tabs.splice(index, 1);
  if (!t) return;
  to.tabs.push(t);
  await updateGroup(fromId, { tabs: from.tabs });
  await updateGroup(toId, { tabs: to.tabs });
  expanded.add(toId);
  toast(`Moved tab to "${to.name}".`);
  reload();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function buildTab(group, tab, index) {
  const li = document.createElement("li");
  li.className = "tab-row";
  li.dataset.gid = group.id;
  li.dataset.index = String(index);

  const handle = document.createElement("span");
  handle.className = "tab-drag";
  handle.textContent = "⋮⋮";
  handle.title = "Drag to reorder, or onto a group to move";
  handle.addEventListener("mousedown", () => (li.draggable = true));
  li.addEventListener("dragend", () => (li.draggable = false));

  const main = document.createElement("button");
  main.className = "tab-main";
  main.type = "button";
  main.title = tab.url;

  const fav = document.createElement("span");
  fav.className = "tab-fav";

  const meta = document.createElement("span");
  meta.className = "tab-meta";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || hostOf(tab.url) || "Untitled";
  const host = document.createElement("div");
  host.className = "tab-host";
  host.textContent = hostOf(tab.url);
  meta.append(title, host);
  main.append(fav, meta);
  main.addEventListener("click", () => {
    if (tab.url) chrome.tabs.create({ url: tab.url, active: true });
  });

  const del = document.createElement("button");
  del.className = "tab-del";
  del.type = "button";
  del.textContent = "×";
  del.title = "Remove tab";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTab(group.id, index);
  });

  li.append(handle, main, del);
  return li;
}

function buildGroup(group) {
  const li = document.createElement("li");
  li.className = "group" + (expanded.has(group.id) ? " open" : "");

  const head = document.createElement("button");
  head.className = "g-head";
  head.type = "button";
  head.dataset.gid = group.id;

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▶";

  const dot = document.createElement("span");
  dot.className = "g-dot";
  dot.style.background = COLOR_HEX[group.color] ?? COLOR_HEX.grey;

  const name = document.createElement("span");
  name.className = "g-name";
  name.textContent = group.name;

  const count = document.createElement("span");
  count.className = "g-count";
  count.textContent = String(group.tabs.length);

  const restore = document.createElement("span");
  restore.className = "g-restore";
  restore.textContent = "Open all";
  restore.setAttribute("role", "button");
  restore.addEventListener("click", (e) => {
    e.stopPropagation();
    if (group.tabs.length === 0) return;
    // Workspace switch: back up the current tabs and replace them with this
    // group's tabs. `switch` + windowId tell the worker to close the old tabs.
    send({
      type: "RESTORE_GROUP",
      id: group.id,
      switch: true,
      windowId:
        panelWindowId !== chrome.windows.WINDOW_ID_NONE ? panelWindowId : undefined,
    });
    toast(`Switching to "${group.name}"…`);
  });

  // Delete the whole group straight from the header — no need to expand it.
  const del = document.createElement("span");
  del.className = "g-del";
  del.textContent = "×";
  del.setAttribute("role", "button");
  del.title = "Delete group";
  del.setAttribute("aria-label", `Delete group "${group.name}"`);
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    expanded.delete(group.id);
    await removeGroup(group.id);
    toast(`Deleted "${group.name}".`);
    reload();
  });

  head.append(caret, dot, name, count, restore, del);
  head.addEventListener("click", () => {
    if (expanded.has(group.id)) expanded.delete(group.id);
    else expanded.add(group.id);
    render(cache);
  });
  li.append(head);

  if (expanded.has(group.id)) {
    const body = document.createElement("div");
    body.className = "g-body";

    if (group.tabs.length === 0) {
      const e = document.createElement("div");
      e.className = "g-body-empty";
      e.textContent = "No tabs yet.";
      body.append(e);
    } else {
      const ul = document.createElement("ul");
      ul.className = "tab-list";
      group.tabs.forEach((tab, i) => ul.append(buildTab(group, tab, i)));
      body.append(ul);
    }

    const add = document.createElement("button");
    add.className = "add-tab-btn";
    add.type = "button";
    add.textContent = "+ Add current tab";
    add.addEventListener("click", () => addCurrentTab(group.id));
    body.append(add);

    li.append(body);
  }

  return li;
}

function render(groups) {
  cache = groups;
  listEl.innerHTML = "";
  emptyEl.hidden = groups.length > 0;
  for (const group of groups) listEl.append(buildGroup(group));
}

async function reload() {
  render(await getGroups());
}

/* ------------------------------------------------------------------ *
 * Drag & drop: reorder tabs, and move tabs between groups
 * ------------------------------------------------------------------ */

let drag = null; // { gid, index, el }

function clearMarks() {
  for (const el of listEl.querySelectorAll(
    ".drop-before, .drop-after, .drop-into",
  )) {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  }
}

function isAfter(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

listEl.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".tab-row");
  if (!row) return;
  drag = {
    gid: row.dataset.gid,
    index: Number(row.dataset.index),
    el: row,
  };
  row.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
});

listEl.addEventListener("dragover", (e) => {
  if (!drag) return;
  clearMarks();
  const row = e.target.closest(".tab-row");
  const head = e.target.closest(".g-head");
  if (row && row !== drag.el && row.dataset.gid === drag.gid) {
    e.preventDefault();
    row.classList.add(isAfter(e, row) ? "drop-after" : "drop-before");
  } else if (head && head.dataset.gid !== drag.gid) {
    e.preventDefault();
    head.classList.add("drop-into");
  }
});

listEl.addEventListener("drop", (e) => {
  if (!drag) return;
  const row = e.target.closest(".tab-row");
  const head = e.target.closest(".g-head");
  if (row && row !== drag.el && row.dataset.gid === drag.gid) {
    e.preventDefault();
    reorderTab(drag.gid, drag.index, Number(row.dataset.index), isAfter(e, row));
  } else if (head && head.dataset.gid !== drag.gid) {
    e.preventDefault();
    moveTab(drag.gid, drag.index, head.dataset.gid);
  }
  cleanupDrag();
});

document.addEventListener("dragend", cleanupDrag);

function cleanupDrag() {
  clearMarks();
  if (drag?.el) {
    drag.el.classList.remove("dragging");
    drag.el.draggable = false;
  }
  drag = null;
}

/* ------------------------------------------------------------------ *
 * Toolbar actions
 * ------------------------------------------------------------------ */

saveWindowBtn.addEventListener("click", async () => {
  saveWindowBtn.disabled = true;
  const res = await send({ type: "SAVE_CURRENT_WINDOW", payload: {} });
  saveWindowBtn.disabled = false;
  if (res?.group) expanded.add(res.group.id);
  toast("Saved this window.");
  reload();
});

saveGroupBtn.addEventListener("click", async () => {
  saveGroupBtn.disabled = true;
  const res = await send({ type: "SAVE_CURRENT_GROUP" });
  saveGroupBtn.disabled = false;
  if (res?.ok) {
    expanded.add(res.group.id);
    toast(`Saved group "${res.group.name}".`);
    reload();
  } else {
    toast("Active tab isn't in a group.");
  }
});

newGroupBtn.addEventListener("click", async () => {
  const g = await addEmptyGroup({ name: "New group" });
  expanded.add(g.id);
  toast("Created a new group.");
  reload();
});

editorBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Keep the panel live: re-render when groups change (saves, edits in the editor,
// sync updates from another device).
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local" || areaName === "sync") reload();
});

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

function init() {
  wireOpenTabEvents();
  renderOpenTabs();
  reload();
}

init();
