/**
 * A small fake of the Chrome extension APIs Tabinet touches, enough to drive
 * the background code for real: tabs open, placeholder pages connect a port,
 * navigations complete, events fire.
 */

const EXT = "chrome-extension://tabinet";
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
      update: async () => {},
      create: async () => {
        log.windowsCreated += 1;
        return { id: 999 };
      },
      onRemoved: evt(),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (gid) => ({ id: gid, windowId: 1, collapsed: false }),
      update: async () => {},
      query: async () => [],
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
      query: async ({ windowId, groupId } = {}) =>
        [...tabs.values()]
          .filter((t) => windowId == null || t.windowId === windowId)
          .filter((t) => groupId == null || t.groupId === groupId)
          .map(clone),
      update: async (id, props) => {
        const t = tabs.get(id);
        if (!t) throw new Error("No tab with id " + id);
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
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t) t.groupId = gid;
        }
        void createProperties;
        return gid;
      },
      ungroup: async (ids) => {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (t) t.groupId = -1;
        }
      },
      remove: async (ids) => {
        for (const id of [].concat(ids)) {
          ports.get(id)?.close();
          tabs.delete(id);
          onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
        }
      },
    },
  };

  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
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

  return { chrome, tabs, ports, log, storage, tick, navigate, goTo };
}

export function lazyUrl(url, title = "") {
  const q = new URLSearchParams({ u: url, t: title });
  return `${LAZY_PAGE}?${q.toString()}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
