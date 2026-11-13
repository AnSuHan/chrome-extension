/**
 * A small fake of the Chrome extension APIs Tabinet touches, enough to drive
 * the background code for real: tabs open, placeholder pages connect a port,
 * navigations complete, events fire.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = "chrome-extension://tabinet";
// The extension root (Tabinet/), for serving its own files (e.g. _locales).
const EXT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LAZY_PAGE = `${EXT}/src/lazy/lazy.html`;

const tick = () => new Promise((r) => setTimeout(r, 0));

function evt() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => listeners.forEach((fn) => fn(...args)),
    count: () => listeners.length,
  };
}

export function install({ navMs = 5, sendMessageWorks = false } = {}) {
  const log = {
    navigated: [], // tabId order in which pages actually started loading
    via: {}, // tabId -> "port" | "message" | "update"
    fetched: [], // urls the network pre-warm requested
    created: [], // {url, windowId}
    windowsCreated: 0,
  };

  const tabs = new Map();
  const groups = new Map(); // gid -> { id, windowId, title, color, collapsed }
  const ports = new Map(); // tabId -> the placeholder's port (page side)
  let nextTabId = 1;
  let nextGroupId = 100;

  const onUpdated = evt();
  const onRemoved = evt();
  const onCreated = evt();
  const onConnect = evt();
  const storage = { local: {}, sync: {} };

  const clone = (t) => ({ ...t });

  function realUrlOf(lazy) {
    return new URL(lazy).searchParams.get("u") ?? "";
  }

  /** The placeholder page navigating itself (or being navigated). */
  async function navigate(tabId, via) {
    const t = tabs.get(tabId);
    if (!t || log.via[tabId]) return;
    log.via[tabId] = via;
    log.navigated.push(tabId);
    ports.get(tabId)?.close(); // the page dies with the navigation
    setTimeout(() => {
      const tab = tabs.get(tabId);
      if (!tab) return;
      tab.url = realUrlOf(tab.url) || tab.url;
      tab.status = "complete";
      onUpdated.fire(tabId, { status: "complete", url: tab.url }, clone(tab));
    }, navMs);
  }

  const chrome = {
    runtime: {
      getURL: (p) => `${EXT}/${p}`,
      lastError: undefined,
      onInstalled: evt(),
      onStartup: evt(),
      getManifest: () => ({ version: "0.0.0-test" }),
      onMessage: evt(),
      onConnect,
      connect: () => {
        throw new Error("pages connect, not the worker");
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      local: {
        get: async (keys) => {
          const ks = keys == null ? Object.keys(storage.local) : [].concat(keys);
          const out = {};
          for (const k of ks) if (k in storage.local) out[k] = storage.local[k];
          return out;
        },
        set: async (items) => Object.assign(storage.local, items),
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete storage.local[k];
        },
      },
      sync: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: evt(),
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      getAll: async () => [{ id: 1, type: "normal" }],
      update: async () => {},
      create: async () => {
        log.windowsCreated += 1;
        return { id: 999 };
      },
      onRemoved: evt(),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (gid) => {
        const g = groups.get(gid);
        if (!g) throw new Error("No group with id: " + gid);
        return { ...g };
      },
      update: async (gid, props) => {
        const g = groups.get(gid);
        if (!g) throw new Error("No group with id: " + gid);
        Object.assign(g, props);
        return { ...g };
      },
      query: async ({ windowId, collapsed } = {}) =>
        [...groups.values()]
          .filter((g) => windowId == null || g.windowId === windowId)
          .filter((g) => collapsed == null || g.collapsed === collapsed)
          .map((g) => ({ ...g })),
      onUpdated: evt(),
      onRemoved: evt(),
    },
    tabs: {
      TAB_ID_NONE: -1,
      onUpdated,
      onRemoved,
      onCreated,
      onMoved: evt(),
      onAttached: evt(),
      onDetached: evt(),
      onActivated: evt(),
      create: async ({ url, windowId = 1, active = false }) => {
        const tab = {
          id: nextTabId++,
          url,
          windowId,
          active,
          groupId: -1,
          status: "complete",
        };
        tabs.set(tab.id, tab);
        log.created.push({ url, windowId });
        onCreated.fire(clone(tab));
        // A placeholder page opens its port to the worker as it loads.
        if (url.startsWith(LAZY_PAGE)) {
          setTimeout(() => {
            let closed = false;
            const pageSide = {
              name: "tabinet-lazy",
              sender: { tab: { id: tab.id } },
              onMessage: evt(),
              onDisconnect: evt(),
              postMessage: (msg) => {
                if (closed) throw new Error("port closed");
                if (msg?.type === "TABINET_LOAD_NOW") navigate(tab.id, "port");
              },
              close: () => {
                if (closed) return;
                closed = true;
                ports.delete(tab.id);
                pageSide.onDisconnect.fire();
              },
            };
            ports.set(tab.id, pageSide);
            onConnect.fire(pageSide);
          }, 0);
        }
        return clone(tab);
      },
      get: async (id) => {
        const t = tabs.get(id);
        if (!t) throw new Error("No tab with id " + id);
        return clone(t);
      },
      query: async ({ windowId, groupId, active } = {}) =>
        [...tabs.values()]
          .filter((t) => windowId == null || t.windowId === windowId)
          .filter((t) => groupId == null || t.groupId === groupId)
          .filter((t) => active == null || t.active === active)
          .map(clone),
      update: async (id, props) => {
        const t = tabs.get(id);
        if (!t) throw new Error("No tab with id " + id);
        if (props.active) {
          for (const o of tabs.values()) if (o.windowId === t.windowId) o.active = false;
        }
        if (props.active != null) t.active = props.active;
        if (props.url) navigate(id, "update");
        return clone(t);
      },
      sendMessage: async (id, msg) => {
        if (!sendMessageWorks) throw new Error("Could not establish connection");
        if (msg?.type === "TABINET_LOAD_NOW") {
          navigate(id, "message");
          return { ok: true };
        }
        return undefined;
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const gid = groupId ?? nextGroupId++;
        if (!groups.has(gid)) {
          if (groupId != null) throw new Error("No group with id: " + gid);
          const windowId = createProperties?.windowId ?? tabs.get(tabIds[0])?.windowId ?? 1;
          groups.set(gid, { id: gid, windowId, title: "", color: "grey", collapsed: false });
        }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t) t.groupId = gid;
        }
        pruneGroups();
        return gid;
      },
      ungroup: async (ids) => {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (t) t.groupId = -1;
        }
        pruneGroups();
      },
      remove: async (ids) => {
        for (const id of [].concat(ids)) {
          ports.get(id)?.close();
          tabs.delete(id);
          onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
        }
        pruneGroups();
      },
    },
  };

  // Chrome drops a tab group the moment its last tab leaves it.
  function pruneGroups() {
    for (const gid of groups.keys()) {
      if (![...tabs.values()].some((t) => t.groupId === gid)) groups.delete(gid);
    }
  }

  /**
   * Put tabs into a native group as a browser restart would restore it: a
   * group with a title/colour, unknown to the worker's bookkeeping.
   */
  function restoreGroup({ windowId = 1, title, color = "blue", collapsed = false, urls }) {
    const gid = nextGroupId++;
    groups.set(gid, { id: gid, windowId, title, color, collapsed });
    for (const url of urls) {
      const tab = { id: nextTabId++, url, windowId, active: false, groupId: gid, status: "complete" };
      tabs.set(tab.id, tab);
    }
    return gid;
  }

  /** A plain tab that was already open (not created through the worker). */
  function addTab({ windowId = 1, url, active = false, groupId = -1 }) {
    const tab = { id: nextTabId++, url, windowId, active, groupId, status: "complete" };
    tabs.set(tab.id, tab);
    return tab.id;
  }

  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    // The extension's own files (translation catalogs) come off disk and are
    // not network traffic, so they stay out of log.fetched.
    if (String(url).startsWith(`${EXT}/`)) {
      const file = path.join(EXT_ROOT, String(url).slice(EXT.length + 1));
      const body = fs.readFileSync(file, "utf8");
      return { json: async () => JSON.parse(body), text: async () => body };
    }
    log.fetched.push(url);
    return {
      headers: { get: () => "text/html" },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  /** The user (or a page) navigating a tab somewhere new. */
  function goTo(tabId, url) {
    const t = tabs.get(tabId);
    if (!t) return;
    ports.get(tabId)?.close();
    t.url = url;
    t.status = "complete";
    onUpdated.fire(tabId, { status: "complete", url }, clone(t));
  }

  return {
    chrome,
    tabs,
    groups,
    ports,
    log,
    storage,
    tick,
    navigate,
    goTo,
    restoreGroup,
    addTab,
  };
}

export function lazyUrl(url, title = "") {
  const q = new URLSearchParams({ u: url, t: title });
  return `${LAZY_PAGE}?${q.toString()}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
