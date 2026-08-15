/**
 * Tabinet — group manager (Safari-style two-pane layout).
 *
 * Left sidebar  : the list of saved groups (select, create, rename, recolor,
 *                 delete, drag-to-reorder, and drop target for moving tabs).
 * Right detail  : the selected group's tabs — edit title/url, open, reorder by
 *                 drag, delete, add. Drag a tab onto a sidebar group to move it
 *                 into that group.
 *
 * Storage is manipulated through the shared storage layer; only tab restoration
 * is delegated to the service worker (it drives the tabs API).
 */

import {
  addEmptyGroup,
  getGroups,
  getSettings,
  importGroups,
  removeGroup,
  reorderGroups,
  setArea,
  updateGroup,
  updateSettings,
} from "../lib/storage.js";

const CHROME_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

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
const detailEl = document.getElementById("detail");
const toastEl = document.getElementById("toast");

let state = []; // groups, in order
let selectedId = null;
let globalKeepLoaded = true; // the setting a group's "Default" resolves to

const byId = (id) => state.find((g) => g.id === id);
const selectedGroup = () => byId(selectedId);

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
}

/* ================================================================== *
 * Rendering — sidebar
 * ================================================================== */

function countText(n) {
  return `${n}`;
}

function buildGroupItem(group) {
  const li = document.createElement("li");
  li.className = "group-item" + (group.id === selectedId ? " selected" : "");
  li.dataset.id = group.id;

  const handle = document.createElement("span");
  handle.className = "g-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  handle.addEventListener("mousedown", () => (li.draggable = true));
  handle.addEventListener("click", (e) => e.stopPropagation());
  li.addEventListener("dragend", () => (li.draggable = false));

  const dot = document.createElement("span");
  dot.className = "g-dot";
  dot.style.background = COLOR_HEX[group.color] ?? COLOR_HEX.grey;

  const name = document.createElement("span");
  name.className = "g-name";
  name.textContent = group.name;

  const count = document.createElement("span");
  count.className = "g-count";
  count.textContent = countText(group.tabs.length);

  const del = document.createElement("button");
  del.className = "g-del";
  del.type = "button";
  del.textContent = "×";
  del.title = "Delete group";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await removeGroup(group.id);
    state = state.filter((g) => g.id !== group.id);
    if (selectedId === group.id) selectedId = state[0]?.id ?? null;
    render();
  });

  li.addEventListener("click", () => selectGroup(group.id));

  li.append(handle, dot, name, count, del);
  return li;
}

function renderSidebar() {
  listEl.innerHTML = "";
  if (state.length === 0) {
    const p = document.createElement("li");
    p.className = "sidebar-empty";
    p.textContent = "No groups yet. Create one above.";
    listEl.append(p);
    return;
  }
  for (const group of state) listEl.append(buildGroupItem(group));
}

/* ================================================================== *
 * Rendering — detail
 * ================================================================== */

function buildTabRow(group, tab, index) {
  const li = document.createElement("li");
  li.className = "tab-row";
  li.dataset.index = String(index);

  const handle = document.createElement("span");
  handle.className = "tab-drag";
  handle.textContent = "⋮⋮";
  handle.title = "Drag to reorder, or onto a group to move";
  handle.addEventListener("mousedown", () => (li.draggable = true));
  li.addEventListener("dragend", () => (li.draggable = false));

  const idx = document.createElement("span");
  idx.className = "tab-index";
  idx.textContent = String(index + 1);

  const fields = document.createElement("div");
  fields.className = "tab-fields";

  const title = document.createElement("input");
  title.className = "tab-title";
  title.placeholder = "Title";
  title.value = tab.title;
  title.addEventListener("change", () => {
    tab.title = title.value;
    persistTabs(group);
  });

  const url = document.createElement("input");
  url.className = "tab-url";
  url.placeholder = "https://…";
  url.value = tab.url;
  url.addEventListener("change", () => {
    tab.url = url.value;
    persistTabs(group);
    open.href = url.value || "#";
  });

  fields.append(title, url);

  const open = document.createElement("a");
  open.className = "tab-open";
  open.textContent = "↗";
  open.title = "Open in a new tab";
  open.target = "_blank";
  open.rel = "noreferrer";
  open.href = tab.url || "#";

  const remove = document.createElement("button");
  remove.className = "tab-remove";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove tab";
  remove.addEventListener("click", async () => {
    group.tabs.splice(index, 1);
    await persistTabs(group);
    render();
  });

  li.append(handle, idx, fields, open, remove);
  return li;
}

function renderDetail() {
  detailEl.innerHTML = "";
  const group = selectedGroup();

  if (!group) {
    const box = document.createElement("div");
    box.className = "detail-empty";
    box.innerHTML =
      state.length === 0
        ? `<div class="big">📁</div><div class="t">No groups yet</div>
           <div>Create a group on the left to start adding tabs.</div>`
        : `<div class="big">👈</div><div class="t">Select a group</div>
           <div>Pick a group on the left to view and edit its tabs.</div>`;
    detailEl.append(box);
    return;
  }

  const inner = document.createElement("div");
  inner.className = "detail-inner";

  // --- header ---
  const head = document.createElement("div");
  head.className = "detail-head";

  const color = document.createElement("select");
  color.className = "color-select";
  color.title = "Group color";
  for (const c of CHROME_COLORS) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === group.color) opt.selected = true;
    color.append(opt);
  }
  color.addEventListener("change", async () => {
    group.color = color.value;
    await updateGroup(group.id, { color: color.value });
    renderSidebar();
  });

  const name = document.createElement("input");
  name.className = "name-input";
  name.value = group.name;
  name.placeholder = "Group name";
  name.addEventListener("change", async () => {
    group.name = name.value.trim() || group.name;
    name.value = group.name;
    await updateGroup(group.id, { name: group.name });
    renderSidebar();
  });

  // Whether this workspace keeps running after you switch away. Live ones
  // switch back instantly; the price is that Chrome lists every live tab group
  // in the bookmarks bar. "Default" follows the global setting on the left.
  const keep = document.createElement("select");
  keep.className = "color-select keep-select";
  keep.title =
    "Live: this workspace keeps running as a Chrome tab group when you switch " +
    "away (instant to come back to, but Chrome shows it in the bookmarks bar). " +
    "Close on switch: its tabs are saved and closed, leaving nothing behind.";
  const current =
    typeof group.keepLoaded === "boolean" ? (group.keepLoaded ? "on" : "off") : "";
  for (const [value, label] of [
    ["", `Default (${globalKeepLoaded ? "live" : "close on switch"})`],
    ["on", "Keep live"],
    ["off", "Close on switch"],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    keep.append(opt);
  }
  keep.addEventListener("change", async () => {
    const next = keep.value === "" ? null : keep.value === "on";
    if (next === null) delete group.keepLoaded;
    else group.keepLoaded = next;
    await updateGroup(group.id, { keepLoaded: next });
  });

  const actions = document.createElement("div");
  actions.className = "head-actions";

  const restore = document.createElement("button");
  restore.className = "icon-btn primary";
  restore.type = "button";
  restore.textContent = "Restore";
  restore.disabled = group.tabs.length === 0;
  restore.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RESTORE_GROUP", id: group.id });
    toast(`Restoring "${group.name}"…`);
  });

  const del = document.createElement("button");
  del.className = "icon-btn danger";
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    await removeGroup(group.id);
    state = state.filter((g) => g.id !== group.id);
    selectedId = state[0]?.id ?? null;
    render();
  });

  actions.append(restore, del);
  head.append(color, name, keep, actions);
  inner.append(head);

  // --- tabs ---
  if (group.tabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tabs-empty";
    empty.textContent = "No tabs in this group yet. Add one below.";
    inner.append(empty);
  } else {
    const ul = document.createElement("ul");
    ul.className = "tab-list";
    group.tabs.forEach((tab, i) => ul.append(buildTabRow(group, tab, i)));
    inner.append(ul);
  }

  const addTab = document.createElement("button");
  addTab.className = "add-tab";
  addTab.type = "button";
  addTab.textContent = "+ Add tab";
  addTab.addEventListener("click", async () => {
    group.tabs.push({ title: "", url: "" });
    await persistTabs(group);
    render();
    // focus the newly added row's title field
    const inputs = detailEl.querySelectorAll(".tab-title");
    inputs[inputs.length - 1]?.focus();
  });
  inner.append(addTab);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Tip: drag ⋮⋮ to reorder tabs, or drag a tab onto a group on the left to move it there.";
  inner.append(hint);

  detailEl.append(inner);
}

function render() {
  renderSidebar();
  renderDetail();
}

/* ================================================================== *
 * Actions
 * ================================================================== */

function persistTabs(group) {
  return updateGroup(group.id, { tabs: group.tabs });
}

function selectGroup(id) {
  selectedId = id;
  render();
}

async function reload() {
  state = await getGroups();
  if (!state.some((g) => g.id === selectedId)) {
    selectedId = state[0]?.id ?? null;
  }
  render();
}

async function moveTabToGroup(fromId, index, toId) {
  if (fromId === toId) return;
  const from = byId(fromId);
  const to = byId(toId);
  if (!from || !to) return;
  const [tab] = from.tabs.splice(index, 1);
  if (!tab) return;
  to.tabs.push(tab);
  await persistTabs(from);
  await persistTabs(to);
  toast(`Moved tab to "${to.name}".`);
  render();
}

async function reorderGroupTo(draggedId, targetId, after) {
  const from = state.findIndex((g) => g.id === draggedId);
  let to = state.findIndex((g) => g.id === targetId);
  if (from < 0 || to < 0) return;
  if (after) to += 1;
  if (from < to) to -= 1;
  if (from === to) return;
  const [g] = state.splice(from, 1);
  state.splice(to, 0, g);
  await reorderGroups(state.map((x) => x.id));
  renderSidebar();
}

async function reorderTabTo(fromIndex, targetIndex, after) {
  const group = selectedGroup();
  if (!group) return;
  let to = targetIndex;
  if (after) to += 1;
  if (fromIndex < to) to -= 1;
  if (fromIndex === to) return;
  const [t] = group.tabs.splice(fromIndex, 1);
  group.tabs.splice(to, 0, t);
  await persistTabs(group);
  renderDetail();
}

/* ================================================================== *
 * Drag & drop
 * ================================================================== */

let drag = null; // { kind: 'group'|'tab', id?, groupId?, index?, el }

function clearMarks() {
  for (const el of document.querySelectorAll(
    ".drop-before, .drop-after, .drop-into",
  )) {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  }
}

function isAfter(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

// --- sidebar: reorder groups + accept tab drops (move) ---
listEl.addEventListener("dragstart", (e) => {
  const item = e.target.closest(".group-item");
  if (!item || item.parentElement !== listEl) return;
  drag = { kind: "group", id: item.dataset.id, el: item };
  item.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
});

listEl.addEventListener("dragover", (e) => {
  if (!drag) return;
  e.preventDefault();
  clearMarks();
  const item = e.target.closest(".group-item");
  if (!item) return;
  if (drag.kind === "group") {
    if (item.dataset.id === drag.id) return;
    item.classList.add(isAfter(e, item) ? "drop-after" : "drop-before");
  } else if (drag.kind === "tab") {
    if (item.dataset.id === drag.groupId) return; // same group = no-op
    item.classList.add("drop-into");
  }
});

listEl.addEventListener("drop", (e) => {
  if (!drag) return;
  e.preventDefault();
  const item = e.target.closest(".group-item");
  if (item) {
    if (drag.kind === "group" && item.dataset.id !== drag.id) {
      reorderGroupTo(drag.id, item.dataset.id, isAfter(e, item));
    } else if (drag.kind === "tab") {
      moveTabToGroup(drag.groupId, drag.index, item.dataset.id);
    }
  }
  cleanupDrag();
});

// --- detail: reorder tabs within the selected group ---
detailEl.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".tab-row");
  if (!row) return;
  drag = {
    kind: "tab",
    groupId: selectedId,
    index: Number(row.dataset.index),
    el: row,
  };
  row.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
});

detailEl.addEventListener("dragover", (e) => {
  if (drag?.kind !== "tab") return;
  e.preventDefault();
  clearMarks();
  const row = e.target.closest(".tab-row");
  if (!row || row === drag.el) return;
  row.classList.add(isAfter(e, row) ? "drop-after" : "drop-before");
});

detailEl.addEventListener("drop", (e) => {
  if (drag?.kind !== "tab") return;
  e.preventDefault();
  const row = e.target.closest(".tab-row");
  if (row && row !== drag.el) {
    reorderTabTo(drag.index, Number(row.dataset.index), isAfter(e, row));
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

/* ================================================================== *
 * Toolbar: new group, sync toggle, JSON save/load
 * ================================================================== */

document.getElementById("new-group-btn").addEventListener("click", async () => {
  const g = await addEmptyGroup({ name: "New group" });
  await reload();
  selectGroup(g.id);
  detailEl.querySelector(".name-input")?.focus();
});

const syncToggle = document.getElementById("sync-toggle");
const keepLoadedToggle = document.getElementById("keep-loaded-toggle");

async function refreshSettingsToggles() {
  const settings = await getSettings();
  syncToggle.checked = settings.area === "sync";
  globalKeepLoaded = settings.keepLoaded !== false;
  keepLoadedToggle.checked = globalKeepLoaded;
  renderDetail(); // the per-group "Default (…)" label depends on it
}

keepLoadedToggle.addEventListener("change", async () => {
  globalKeepLoaded = keepLoadedToggle.checked;
  await updateSettings({ keepLoaded: globalKeepLoaded });
  renderDetail(); // the per-group selector shows what "Default" resolves to
  toast(
    keepLoadedToggle.checked
      ? "Workspaces stay live in the background — Chrome shows them in the bookmarks bar."
      : "Workspaces close when you switch away — nothing left in the bookmarks bar.",
  );
});

syncToggle.addEventListener("change", async () => {
  const target = syncToggle.checked ? "sync" : "local";
  syncToggle.disabled = true;
  try {
    await setArea(target);
    await reload();
    toast(
      target === "sync"
        ? "Sync enabled — groups now live in your Google account."
        : "Sync disabled — groups now stored on this device only.",
    );
  } catch (err) {
    syncToggle.checked = target !== "sync";
    toast(
      target === "sync"
        ? "Couldn't enable sync: too much data for sync storage (~100KB limit). Kept local."
        : "Couldn't switch storage. Kept previous setting.",
    );
    console.error("Tabinet setArea failed:", err);
  } finally {
    syncToggle.disabled = false;
  }
});

document.getElementById("export-btn").addEventListener("click", async () => {
  if (state.length === 0) {
    toast("Nothing to save.");
    return;
  }
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  await chrome.downloads.download({
    url,
    filename: `tabinet-groups-${stamp}.json`,
    saveAs: true,
  });
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

const importFile = document.getElementById("import-file");
document
  .getElementById("import-btn")
  .addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = "";
  if (!file) return;
  const mode = document.getElementById("import-mode").value;
  try {
    const parsed = JSON.parse(await file.text());
    const groups = Array.isArray(parsed) ? parsed : parsed.groups;
    const count = await importGroups(groups, { mode });
    await reload();
    toast(
      mode === "replace"
        ? `Replaced with ${count} group(s).`
        : `Merged in ${count} group(s).`,
    );
  } catch {
    toast("Load failed: not a valid Tabinet JSON file.");
  }
});

refreshSettingsToggles();
reload();
