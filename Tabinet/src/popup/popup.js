/**
 * Tabinet — popup UI controller.
 *
 * The popup is intentionally thin: it renders saved groups and delegates
 * every real action (save / restore / remove / rename / import) to the
 * service worker. Export is handled here since it only reads state.
 */

const listEl = document.getElementById("group-list");
const emptyEl = document.getElementById("empty");
const toastEl = document.getElementById("toast");
const saveWindowBtn = document.getElementById("save-window-btn");
const saveGroupBtn = document.getElementById("save-group-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const manageBtn = document.getElementById("manage-btn");

/** Map chrome tabGroups color names to display colors for the dot. */
const COLOR_MAP = {
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

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2500);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

/** Swap a group's name label for an inline text input to rename it. */
function startRename(group, nameEl) {
  const input = document.createElement("input");
  input.className = "group-name-input";
  input.value = group.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== group.name) {
      await send({ type: "RENAME_GROUP", id: group.id, name: input.value });
    }
    refresh();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
  // Don't let clicks inside the input bubble up to the restore handler.
  input.addEventListener("click", (e) => e.stopPropagation());
}

function render(groups) {
  listEl.innerHTML = "";
  emptyEl.hidden = groups.length > 0;

  for (const group of groups) {
    const li = document.createElement("li");
    li.className = "group-item";
    li.title = "Click to restore";

    const dot = document.createElement("span");
    dot.className = "group-dot";
    dot.style.background = COLOR_MAP[group.color] ?? COLOR_MAP.grey;

    const meta = document.createElement("div");
    meta.className = "group-meta";
    const name = document.createElement("div");
    name.className = "group-name";
    name.textContent = group.name;
    const sub = document.createElement("div");
    sub.className = "group-sub";
    sub.textContent = `${group.tabs.length} tab${group.tabs.length === 1 ? "" : "s"}`;
    meta.append(name, sub);

    const edit = document.createElement("button");
    edit.className = "group-remove";
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "Rename group";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(group, name);
    });

    const remove = document.createElement("button");
    remove.className = "group-remove is-delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Delete group";
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      await send({ type: "REMOVE_GROUP", id: group.id });
      refresh();
    });

    li.addEventListener("click", () => {
      send({ type: "RESTORE_GROUP", id: group.id });
    });

    li.append(dot, meta, edit, remove);
    listEl.append(li);
  }
}

async function refresh() {
  const res = await send({ type: "LIST_GROUPS" });
  render(res?.groups ?? []);
}

saveWindowBtn.addEventListener("click", async () => {
  saveWindowBtn.disabled = true;
  await send({ type: "SAVE_CURRENT_WINDOW", payload: {} });
  saveWindowBtn.disabled = false;
  toast("Window saved.");
  refresh();
});

saveGroupBtn.addEventListener("click", async () => {
  saveGroupBtn.disabled = true;
  const res = await send({ type: "SAVE_CURRENT_GROUP" });
  saveGroupBtn.disabled = false;
  if (res?.ok) {
    toast(`Saved group "${res.group.name}".`);
    refresh();
  } else {
    toast("Active tab isn't in a group.");
  }
});

exportBtn.addEventListener("click", async () => {
  const res = await send({ type: "LIST_GROUPS" });
  const groups = res?.groups ?? [];
  if (groups.length === 0) {
    toast("Nothing to export.");
    return;
  }
  const blob = new Blob([JSON.stringify(groups, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  await chrome.downloads.download({
    url,
    filename: `tabinet-groups-${stamp}.json`,
    saveAs: true,
  });
  // Revoke shortly after so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

manageBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = ""; // allow re-importing the same file later
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const groups = Array.isArray(parsed) ? parsed : parsed.groups;
    const res = await send({ type: "IMPORT_GROUPS", groups, mode: "merge" });
    toast(`Imported ${res?.count ?? 0} group(s).`);
    refresh();
  } catch {
    toast("Import failed: invalid JSON.");
  }
});

refresh();
