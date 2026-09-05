/* Screenshot harness: a minimal chrome.* stand-in so the real Tabinet UI
   (unmodified sidepanel.js / manager.js / storage.js) renders with sample
   data for store screenshots. Not shipped with the extension. */
(function () {
  const F = new URL("../../fav/", location.href).href;
  const t = (title, url, fav) => ({ title, url, fav });

  const GROUPS = [
    {
      id: "g-work", name: "Work", color: "blue", createdAt: Date.now() - 86400000 * 6,
      tabs: [
        t("Sidebar spec — Tabinet docs", "https://tabinet.app/docs/sidebar-spec", "tabinet"),
        t("Pull requests · tabinet", "https://github.com/pulls", "github.com"),
        t("Design system / Components", "https://figma.com/file/components", "figma.com"),
        t("Sprint board", "https://notion.so/sprint-board", "notion.so"),
        t("Why is my service worker terminated?", "https://stackoverflow.com/q/66618136", "stackoverflow.com"),
      ],
    },
    {
      id: "g-research", name: "Research", color: "purple", createdAt: Date.now() - 86400000 * 12,
      tabs: [
        t("Attention Is All You Need", "https://arxiv.org/abs/1706.03762", "arxiv.org"),
        t("Chrome Side Panel API", "https://developer.mozilla.org/en-US/docs/Web", "developer.mozilla.org"),
        t("Tab (interface) — Wikipedia", "https://en.wikipedia.org/wiki/Tab", "en.wikipedia.org"),
        t("Structured concurrency", "https://en.wikipedia.org/wiki/Structured_concurrency", "en.wikipedia.org"),
      ],
    },
    {
      id: "g-reading", name: "Reading list", color: "orange", createdAt: Date.now() - 86400000 * 3,
      tabs: [
        t("Hacker News", "https://news.ycombinator.com/", "news.ycombinator.com"),
        t("The cost of a cold tab", "https://developer.mozilla.org/en-US/docs/Performance", "developer.mozilla.org"),
        t("Build your own database", "https://github.com/topics/database", "github.com"),
      ],
    },
    {
      id: "g-trip", name: "Trip planning", color: "green", createdAt: Date.now() - 86400000 * 20,
      tabs: [
        t("Kyoto — Wikipedia", "https://en.wikipedia.org/wiki/Kyoto", "en.wikipedia.org"),
        t("Itinerary draft", "https://docs.google.com/document/d/itinerary", "docs.google.com"),
        t("Walking tour footage", "https://youtube.com/watch?v=kyoto", "youtube.com"),
      ],
    },
    {
      id: "g-design", name: "Design refs", color: "pink", createdAt: Date.now() - 86400000 * 30,
      tabs: [
        t("Sidebar patterns", "https://figma.com/community/sidebar", "figma.com"),
        t("Icon set", "https://github.com/feathericons/feather", "github.com"),
      ],
    },
  ];

  const strip = (g) => ({
    id: g.id, name: g.name, color: g.color, createdAt: g.createdAt,
    tabs: g.tabs.map(({ title, url }) => ({ title, url })),
  });

  // Live tabs of the window = the active workspace ("Work").
  const active = GROUPS[0];
  const OPEN_TABS = active.tabs.map((tab, i) => ({
    id: 100 + i, index: i, windowId: 1, groupId: -1, active: i === 0,
    title: tab.title, url: tab.url, favIconUrl: F + tab.fav + ".png",
  }));

  const seed = { "tabinet.order": GROUPS.map((g) => g.id), "tabinet.active": { 1: active.id },
    "tabinet.settings": { area: "local", keepLoaded: true, preloadTabs: true,
      autoSaveChanges: true, autoSaveCount: true },
    "tabinetHideDockHint": true };
  for (const g of GROUPS) seed["tabinet.g." + g.id] = strip(g);

  const areas = { local: { ...seed }, sync: {} };
  function mkArea(name) {
    const db = areas[name];
    return {
      async get(keys) {
        if (keys == null) return { ...db };
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (k in db) out[k] = db[k];
        if (!Array.isArray(keys) && typeof keys === "object") for (const k of list) if (!(k in out)) out[k] = keys[k];
        return out;
      },
      async set(items) { Object.assign(db, items); },
      async remove(keys) { for (const k of [].concat(keys)) delete db[k]; },
      async getBytesInUse() { return JSON.stringify(db).length; },
    };
  }

  const noopEvent = { addListener() {}, removeListener() {} };
  window.chrome = {
    runtime: {
      id: "mock", lastError: null,
      getURL: (p) => new URL(p, location.href).href,
      sendMessage: async () => ({ ok: true }),
      openOptionsPage() {},
      onMessage: noopEvent,
    },
    storage: { local: mkArea("local"), sync: mkArea("sync"), onChanged: noopEvent },
    tabs: {
      async query() { return OPEN_TABS.slice(); },
      async get(id) { return OPEN_TABS.find((t) => t.id === id); },
      create() {}, remove() {}, update() {}, move() {}, duplicate() {}, discard() {},
      onCreated: noopEvent, onRemoved: noopEvent, onUpdated: noopEvent, onMoved: noopEvent,
      onActivated: noopEvent, onAttached: noopEvent, onDetached: noopEvent, onReplaced: noopEvent,
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query() { return []; },
      update() {}, move() {},
      onCreated: noopEvent, onRemoved: noopEvent, onUpdated: noopEvent,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async getCurrent() { return { id: 1 }; },
      update() {},
    },
    downloads: { download() {} },
    sidePanel: { open() {}, setOptions() {} },
  };

  window.__TABINET_SAMPLE__ = { GROUPS, OPEN_TABS, F };
})();
