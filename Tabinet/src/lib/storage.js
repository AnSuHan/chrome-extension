/**
 * Tabinet — storage layer
 *
 * A saved group is a snapshot of a set of tabs (title, url) plus a name/color:
 *   {
 *     id: string,          // uuid-ish
 *     name: string,
 *     color: string,       // chrome tabGroups color name (e.g. "blue")
 *     createdAt: number,   // epoch ms
 *     tabs: [{ title, url }]
 *   }
 *
 * Groups are stored **sharded**: an index key holds the ordered list of ids,
 * and each group is its own item under `tabinet.g.<id>`. Sharding keeps every
 * item small, which matters for chrome.storage.sync (≈8KB per item).
 *
 * The active backend (chrome.storage.local or chrome.storage.sync) is chosen
 * by a settings record that always lives in local, so the choice itself never
 * syncs away or gets lost. Use setArea() to switch; it migrates the data over.
 */

const OLD_KEY = "tabinet.groups"; // legacy single-array format (local only)
const INDEX_KEY = "tabinet.order"; // array of group ids, in display order
const GROUP_PREFIX = "tabinet.g."; // per-group item key prefix
const SETTINGS_KEY = "tabinet.settings";
const DEFAULT_SETTINGS = { area: "local" };

const groupKey = (id) => GROUP_PREFIX + id;

/* ------------------------------------------------------------------ *
 * Settings + backend selection
 * ------------------------------------------------------------------ */

/** Read settings (always from local). */
export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] ?? {}) };
}

async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function storeFor(areaName) {
  return areaName === "sync" ? chrome.storage.sync : chrome.storage.local;
}

/** The chrome.storage area currently backing group data. */
async function area() {
  return storeFor((await getSettings()).area);
}

/* ------------------------------------------------------------------ *
 * Low-level sharded helpers
 * ------------------------------------------------------------------ */

async function getIndex(store) {
  const data = await store.get(INDEX_KEY);
  return data[INDEX_KEY] ?? [];
}

/** Read every group from a store, in index order. */
async function readAll(store) {
  const idx = await getIndex(store);
  if (idx.length === 0) return [];
  const data = await store.get(idx.map(groupKey));
  return idx.map((id) => data[groupKey(id)]).filter(Boolean);
}

/** Write a full ordered list of groups to a store (index + each item). */
async function writeAll(store, groups) {
  const items = { [INDEX_KEY]: groups.map((g) => g.id) };
  for (const g of groups) items[groupKey(g.id)] = g;
  await store.set(items);
}

/**
 * One-time migration of the legacy single-array format (local only) into the
 * sharded layout. Safe to call on any store; it no-ops unless the old key is
 * present and the new index is absent.
 */
async function migrateIfNeeded(store) {
  const data = await store.get([INDEX_KEY, OLD_KEY]);
  if (data[INDEX_KEY] !== undefined || data[OLD_KEY] === undefined) return;
  await writeAll(store, data[OLD_KEY] ?? []);
  await store.remove(OLD_KEY);
}

/* ------------------------------------------------------------------ *
 * Public API — groups
 * ------------------------------------------------------------------ */

/** Return all saved groups in their stored (user-defined) order. */
export async function getGroups() {
  const store = await area();
  await migrateIfNeeded(store);
  return readAll(store);
}

/** Add a new saved group and return it. */
export async function addGroup({ name, color, tabs }) {
  const store = await area();
  await migrateIfNeeded(store);
  const group = {
    id: crypto.randomUUID(),
    name: name?.trim() || "Untitled group",
    color: color || "grey",
    createdAt: Date.now(),
    tabs: (tabs ?? []).map((t) => ({ title: t.title ?? "", url: t.url ?? "" })),
  };
  const idx = await getIndex(store);
  await store.set({ [groupKey(group.id)]: group, [INDEX_KEY]: [group.id, ...idx] });
  return group;
}

/** Create a new empty group (no tabs) and return it. */
export async function addEmptyGroup({ name, color } = {}) {
  return addGroup({ name: name || "New group", color, tabs: [] });
}

/** Remove a saved group by id. */
export async function removeGroup(id) {
  const store = await area();
  const idx = await getIndex(store);
  await store.set({ [INDEX_KEY]: idx.filter((x) => x !== id) });
  await store.remove(groupKey(id));
}

/** Rename a saved group. */
export async function renameGroup(id, name) {
  return updateGroup(id, { name });
}

/**
 * Patch a group by id. Accepts any of { name, color, tabs }.
 * Tabs, if provided, are normalized to { title, url } records.
 */
export async function updateGroup(id, patch = {}) {
  const store = await area();
  const data = await store.get(groupKey(id));
  const current = data[groupKey(id)];
  if (!current) return;
  const updated = { ...current };
  if (typeof patch.name === "string") {
    updated.name = patch.name.trim() || current.name;
  }
  if (typeof patch.color === "string") updated.color = patch.color;
  if (Array.isArray(patch.tabs)) {
    updated.tabs = patch.tabs.map((t) => ({
      title: t.title ?? "",
      url: t.url ?? "",
    }));
  }
  await store.set({ [groupKey(id)]: updated });
}

/**
 * Rewrite group order to match `orderedIds`. Ids not in the stored set are
 * ignored; stored ids missing from the list are appended in existing order
 * (defensive against stale UIs).
 */
export async function reorderGroups(orderedIds) {
  const store = await area();
  const idx = await getIndex(store);
  const known = new Set(idx);
  const next = orderedIds.filter((id) => known.has(id));
  const included = new Set(next);
  for (const id of idx) if (!included.has(id)) next.push(id);
  await store.set({ [INDEX_KEY]: next });
}

/** Normalize an arbitrary object into a valid saved-group record. */
function coerceGroup(raw) {
  if (!raw || !Array.isArray(raw.tabs)) return null;
  return {
    id: typeof raw.id === "string" ? raw.id : crypto.randomUUID(),
    name: (typeof raw.name === "string" && raw.name.trim()) || "Untitled group",
    color: typeof raw.color === "string" ? raw.color : "grey",
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    tabs: raw.tabs
      .filter((t) => t && typeof t.url === "string")
      .map((t) => ({ title: t.title ?? "", url: t.url })),
  };
}

/**
 * Import groups from parsed JSON.
 * - mode "merge" (default): appends imported groups, re-issuing colliding ids.
 * - mode "replace": overwrites all existing groups with the imported set.
 * Returns the number of groups imported.
 */
export async function importGroups(rawGroups, { mode = "merge" } = {}) {
  const store = await area();
  await migrateIfNeeded(store);
  const incoming = (Array.isArray(rawGroups) ? rawGroups : [])
    .map(coerceGroup)
    .filter(Boolean);

  if (mode === "replace") {
    const oldIdx = await getIndex(store);
    if (oldIdx.length) await store.remove(oldIdx.map(groupKey));
    await writeAll(store, incoming);
    return incoming.length;
  }

  const idx = await getIndex(store);
  const seen = new Set(idx);
  const items = {};
  const newIds = [...idx];
  let added = 0;
  for (const g of incoming) {
    if (seen.has(g.id)) g.id = crypto.randomUUID();
    seen.add(g.id);
    items[groupKey(g.id)] = g;
    newIds.push(g.id);
    added += 1;
  }
  items[INDEX_KEY] = newIds;
  await store.set(items);
  return added;
}

/* ------------------------------------------------------------------ *
 * Public API — backend switching (local <-> sync)
 * ------------------------------------------------------------------ */

/**
 * Switch the active storage backend to `target` ("local" | "sync"), copying
 * all groups over first. If the write to the target fails (e.g. sync quota
 * exceeded), the switch is aborted and the error is rethrown — existing data
 * in the current area is left untouched.
 */
export async function setArea(target) {
  const current = (await getSettings()).area;
  if (current === target) return;

  const from = storeFor(current);
  const to = storeFor(target);

  await migrateIfNeeded(from);
  const idx = await getIndex(from);
  const groups = await readAll(from);

  // May throw QUOTA_BYTES / QUOTA_BYTES_PER_ITEM on sync — let it propagate.
  await writeAll(to, groups);

  await patchSettings({ area: target });

  // Clear the old area so it can't resurrect stale copies later.
  await from.remove([INDEX_KEY, ...idx.map(groupKey)]);
}
