/**
 * Tabinet — side panel (the docked, Safari-style sidebar).
 *
 * Shows saved groups, expandable to reveal their tabs. From here you can:
 *  - open a tab in the current window (click it),
 *  - add the current page to a group, delete a tab, reorder tabs (drag),
 *  - move a tab to another group (drag it onto that group's header),
 *  - quick-save the window / active tab group, and create empty groups.
 *
 * Reads come from the storage layer (respects the local/sync setting); tab
 * capture/restore is delegated to the service worker.
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
    send({ type: "RESTORE_GROUP", id: group.id });
    toast(`Opening "${group.name}"…`);
  });

  head.append(caret, dot, name, count, restore);
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

reload();
