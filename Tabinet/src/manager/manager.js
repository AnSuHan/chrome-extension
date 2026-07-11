/**
 * Tabinet — group manager (full page).
 *
 * A management surface for saved groups: create, rename, recolor, reorder
 * (drag), edit the individual tabs inside a group (title/url/order/add/remove),
 * restore, delete, and Save/Load everything as a JSON file.
 *
 * Storage is manipulated directly through the shared storage layer; only tab
 * restoration is delegated to the service worker (it needs the tabs API flow).
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

const groupsEl = document.getElementById("groups");
const emptyEl = document.getElementById("empty");
const toastEl = document.getElementById("toast");

let state = []; // local mirror of saved groups, in order

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function countLabel(n) {
  return `${n} tab${n === 1 ? "" : "s"}`;
}

function buildTabRow(group, tab, index) {
  const li = document.createElement("li");
  li.className = "tab-row";
  li.dataset.index = String(index);

  const handle = document.createElement("span");
  handle.className = "tab-drag";
  handle.textContent = "⋮⋮";
  handle.title = "Drag to reorder";
  handle.addEventListener("mousedown", () => (li.draggable = true));
  li.addEventListener("dragend", () => (li.draggable = false));

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
  });

  fields.append(title, url);

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

  li.append(handle, fields, remove);
  return li;
}

function buildGroupCard(group) {
  const card = document.createElement("section");
  card.className = "group";
  card.dataset.id = group.id;

  // --- head ---
  const head = document.createElement("div");
  head.className = "group-head";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder groups";
  handle.addEventListener("mousedown", () => (card.draggable = true));
  card.addEventListener("dragend", () => (card.draggable = false));

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
  });

  const name = document.createElement("input");
  name.className = "name-input";
  name.value = group.name;
  name.placeholder = "Group name";
  name.addEventListener("change", async () => {
    group.name = name.value.trim() || group.name;
    name.value = group.name;
    await updateGroup(group.id, { name: group.name });
  });

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = countLabel(group.tabs.length);

  const actions = document.createElement("div");
  actions.className = "head-actions";

  const restore = document.createElement("button");
  restore.className = "icon-btn";
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
    render();
  });

  actions.append(restore, del);
  head.append(handle, color, name, count, actions);

  // --- tabs ---
  const list = document.createElement("ul");
  list.className = "tabs";
  group.tabs.forEach((tab, i) => list.append(buildTabRow(group, tab, i)));
  wireSortable(list, ".tab-row", (from, to) => {
    const [moved] = group.tabs.splice(from, 1);
    group.tabs.splice(to, 0, moved);
    persistTabs(group).then(render);
  });

  const addTab = document.createElement("button");
  addTab.className = "add-tab";
  addTab.type = "button";
  addTab.textContent = "+ Add tab";
  addTab.addEventListener("click", async () => {
    group.tabs.push({ title: "", url: "" });
    await persistTabs(group);
    render();
  });

  card.append(head, list, addTab);
  return card;
}

function render() {
  groupsEl.innerHTML = "";
  emptyEl.hidden = state.length > 0;
  for (const group of state) groupsEl.append(buildGroupCard(group));
}

/* ------------------------------------------------------------------ *
 * Persistence helpers
 * ------------------------------------------------------------------ */

function persistTabs(group) {
  return updateGroup(group.id, { tabs: group.tabs });
}

async function reload() {
  state = await getGroups();
  render();
}

/* ------------------------------------------------------------------ *
 * Sync toggle (local <-> chrome.storage.sync)
 * ------------------------------------------------------------------ */

const syncToggle = document.getElementById("sync-toggle");

async function refreshSyncToggle() {
  syncToggle.checked = (await getSettings()).area === "sync";
}

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
    // Most likely sync quota exceeded; revert the checkbox.
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

/* ------------------------------------------------------------------ *
 * Drag-and-drop sorting (shared by group cards and tab rows)
 * ------------------------------------------------------------------ */

function clearMarks(container, selector) {
  for (const el of container.querySelectorAll(selector)) {
    el.classList.remove("drop-before", "drop-after");
  }
}

/**
 * Wire HTML5 drag-sorting on `container`'s direct `selector` children.
 * Calls onMove(fromIndex, toIndex) with array indices after a valid drop.
 */
function wireSortable(container, selector, onMove) {
  let dragEl = null;

  container.addEventListener("dragstart", (e) => {
    const item = e.target.closest(selector);
    if (!item || item.parentElement !== container) return;
    dragEl = item;
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  });

  container.addEventListener("dragover", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    clearMarks(container, selector);
    const item = e.target.closest(selector);
    if (!item || item === dragEl || item.parentElement !== container) return;
    const rect = item.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    item.classList.add(after ? "drop-after" : "drop-before");
  });

  container.addEventListener("drop", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const item = e.target.closest(selector);
    if (item && item !== dragEl && item.parentElement === container) {
      const items = [...container.querySelectorAll(`:scope > ${selector}`)];
      const from = items.indexOf(dragEl);
      const targetIdx = items.indexOf(item);
      const rect = item.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      let to = after ? targetIdx + 1 : targetIdx;
      if (from < to) to -= 1;
      if (from !== to) onMove(from, to);
    }
    cleanup();
  });

  container.addEventListener("dragend", cleanup);

  function cleanup() {
    clearMarks(container, selector);
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
  }
}

// Group-card reordering lives on the groups container (stable across renders).
wireSortable(groupsEl, ".group", async (from, to) => {
  const [moved] = state.splice(from, 1);
  state.splice(to, 0, moved);
  await reorderGroups(state.map((g) => g.id));
  render();
});

/* ------------------------------------------------------------------ *
 * Toolbar: new group, export/import JSON
 * ------------------------------------------------------------------ */

document.getElementById("new-group-btn").addEventListener("click", async () => {
  await addEmptyGroup({ name: "New group" });
  await reload();
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

refreshSyncToggle();
reload();
