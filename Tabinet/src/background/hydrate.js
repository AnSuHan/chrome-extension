/**
 * Tabinet — background tab hydration ("no cold click").
 *
 * A restored workspace opens its tabs on a local placeholder (src/lazy), so the
 * switch itself is instant. The network pre-warm (src/background/prewarm.js)
 * then takes the sting out of the first click by getting cookies, DNS/TLS and
 * the document into the cache ahead of time — but the click still has to do the
 * real work: navigate, parse, run the page's scripts, paint. That's the cold
 * load the user feels.
 *
 * So we go one step further: once a workspace is in view we *actually load*
 * every one of its placeholder tabs in the background, a few at a time. Each
 * tab is asked to navigate itself (the placeholder replaces itself via
 * location.replace, so it leaves no Back entry); we wait for it to finish
 * before starting the next batch. By the time the user clicks a tab, the page
 * behind it is already loaded and rendered — clicking just shows it.
 *
 * Loading is paced on purpose. Firing every tab at once would turn a switch
 * into a stampede that starves the tab the user is actually reading, so we run
 * a small number of lanes and cap how many tabs one run will load.
 *
 * Everything is best-effort: failures are swallowed, a stalled page gives up
 * its lane on a timeout, and starting a run for a key cancels the previous one
 * (we key by window, so switching away stops the old workspace's loading).
 */

// The local placeholder a not-yet-loaded restored tab sits on.
const LAZY_PAGE = chrome.runtime.getURL("src/lazy/lazy.html");

// How many tabs load at once. Small on purpose — background loading must never
// compete with the tab the user is looking at.
const HYDRATE_CONCURRENCY = 3;

// Stop waiting on a single page after this long and free its lane. The tab
// keeps loading; we just no longer hold the queue for it.
const HYDRATE_TIMEOUT_MS = 30_000;

// Beyond this many tabs one run stops loading pages. Anything past the cap
// stays on its placeholder and is network-warmed instead (see prewarm.js), so a
// 200-tab workspace can't eat the machine's memory on a single switch.
const MAX_HYDRATE_PER_RUN = 60;

const runs = new Map(); // key -> run state of the run currently owning the key
const waiting = new Map(); // tabId -> callback that releases the lane holding it
const ports = new Map(); // tabId -> the live placeholder page's port

// Every placeholder page opens a port back to us as it loads; that port is how
// we tell it to go to its real URL. A port (rather than a one-off message) is
// both the reliable way to reach an extension page in a tab and proof that the
// page is still sitting there — it dies the moment the tab navigates away.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tabinet-lazy") return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

/** Release whoever is waiting on `tabId` (loaded, closed, or timed out). */
function settle(tabId) {
  const done = waiting.get(tabId);
  if (done) {
    waiting.delete(tabId);
    done();
  }
}

// A tab is done when it reports "complete" on something other than the
// placeholder — the placeholder's own completion doesn't count, or we'd hand
// the lane on before the real page had even started.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!waiting.has(tabId)) return;
  const url = tab?.url || tab?.pendingUrl || "";
  if (changeInfo.status === "complete" && !url.startsWith(LAZY_PAGE)) {
    settle(tabId);
  }
});

// A tab that goes away is done too — never hold a lane for it.
chrome.tabs.onRemoved.addListener((tabId) => settle(tabId));

/** Abort the hydration run registered under `key`, if any. */
export function cancelHydrate(key) {
  const run = runs.get(key);
  if (!run) return;
  run.cancelled = true;
  run.queue.length = 0;
  for (const tabId of run.waiting) settle(tabId);
  runs.delete(key);
}

/**
 * Get a placeholder tab onto its real page.
 *
 * Preferred path: ask the placeholder to navigate itself (over its port, else
 * by message), because it uses location.replace and so leaves no placeholder
 * entry in the tab's history. If nobody answers — the tab already navigated, or
 * it isn't our placeholder after all — we drive the navigation from here
 * instead, which costs a stale Back entry but still loads the page.
 *
 * Returns false when there was nothing to do, so the caller doesn't burn a lane
 * waiting for a load that will never start.
 */
async function startNavigation(tabId, fallbackUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const current = tab.url || tab.pendingUrl || "";
  // Already showing (or on its way to) the real page — leave it alone. This is
  // also what keeps a re-run from reloading tabs an earlier run finished.
  if (!current.startsWith(LAZY_PAGE)) return false;

  const port = ports.get(tabId);
  if (port) {
    try {
      port.postMessage({ type: "TABINET_LOAD_NOW" });
      return true;
    } catch {
      ports.delete(tabId); // page went away between the check and the send
    }
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "TABINET_LOAD_NOW" });
    if (res?.ok) return true;
  } catch {
    // Nobody listening (the page may predate a service-worker restart, so its
    // port is gone) — fall through and navigate the tab ourselves.
  }
  const url = fallbackUrl || new URL(current).searchParams.get("u") || "";
  if (!/^https?:/i.test(url)) return false;
  try {
    await chrome.tabs.update(tabId, { url });
    return true;
  } catch {
    return false;
  }
}

/** Resolve once `tabId` finishes loading, is closed, or the timeout expires. */
function whenLoaded(tabId, run) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      run.waiting.delete(tabId);
      waiting.delete(tabId);
      resolve();
    };
    const timer = setTimeout(finish, HYDRATE_TIMEOUT_MS);
    run.waiting.add(tabId);
    waiting.set(tabId, finish);
  });
}

/**
 * Load `entries` — [{ tabId, url }] of tabs still sitting on the placeholder —
 * in the background, a few at a time.
 *
 * `key` scopes the run (we use one per window): starting a run replaces — and
 * cancels — the previous run under the same key, so switching away doesn't
 * leave the workspace you left loading pages behind your back.
 *
 * Resolves when the run finishes; callers normally fire and forget.
 */
export async function hydrateTabs(entries, { key = "default" } = {}) {
  cancelHydrate(key);

  const queue = entries
    .filter((e) => e?.tabId != null && /^https?:/i.test(e.url ?? ""))
    .slice(0, MAX_HYDRATE_PER_RUN);
  if (!queue.length) return { hydrated: 0 };

  const run = { cancelled: false, queue, waiting: new Set() };
  runs.set(key, run);

  let hydrated = 0;
  const lane = async () => {
    while (queue.length && !run.cancelled) {
      const { tabId, url } = queue.shift();
      if (!(await startNavigation(tabId, url))) continue;
      if (run.cancelled) break;
      await whenLoaded(tabId, run);
      hydrated += 1;
    }
  };
  try {
    const lanes = Math.min(HYDRATE_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: lanes }, lane));
  } finally {
    if (runs.get(key) === run) runs.delete(key);
  }
  return { hydrated };
}

/** How many tabs a single run will load — the rest are left to the pre-warm. */
export const HYDRATE_LIMIT = MAX_HYDRATE_PER_RUN;
