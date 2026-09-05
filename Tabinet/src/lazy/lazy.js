/**
 * Tabinet — lazy tab placeholder.
 *
 * A restored group opens its tabs pointing here (a tiny local page) instead of
 * their real URLs, so the whole workspace appears instantly with no network
 * stampede. A tab leaves this page when any of these happens:
 *
 *   - it becomes visible (activated) or the button is clicked — the user is
 *     looking at it now, so load immediately,
 *   - the background asks it to (TABINET_LOAD_NOW): right after a workspace
 *     opens, the service worker walks its tabs a few at a time and loads them
 *     ahead of the user, so a later click lands on an already-loaded page —
 *     see src/background/hydrate.js.
 *
 * Either way we navigate with replace(), which keeps the placeholder out of
 * history so Back doesn't bounce through it.
 *
 * The real URL and title arrive as query params: ?u=<url>&t=<title>.
 */

const params = new URLSearchParams(location.search);
const url = params.get("u") || "";
const title = params.get("t") || "";

if (title) document.title = title;

const titleEl = document.getElementById("title");
const hostEl = document.getElementById("host");
if (title && titleEl) titleEl.textContent = title;
try {
  if (hostEl) hostEl.textContent = new URL(url).hostname.replace(/^www\./, "");
} catch {
  if (hostEl) hostEl.textContent = url;
}

let navigated = false;
function go() {
  if (navigated || !url) return;
  navigated = true;
  location.replace(url);
}

// Load as soon as the tab is shown; also allow an explicit click.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") go();
});
document.getElementById("load")?.addEventListener("click", go);

// The background's turn-by-turn pre-loading. We hold a port open so it can
// reach us and, just as importantly, so it can tell we are still parked here:
// the port dies with this page the moment we navigate. Loading ourselves (via
// location.replace) is what keeps the placeholder out of the tab's history —
// otherwise the background has to navigate the tab from its side.
try {
  const port = chrome.runtime.connect({ name: "tabinet-lazy" });
  port.onMessage.addListener((msg) => {
    if (msg?.type === "TABINET_LOAD_NOW") go();
  });
  // A disconnect just means the background went to sleep; nothing to do — a
  // click, or the next pre-load pass, still loads this tab.
  port.onDisconnect.addListener(() => void chrome.runtime.lastError);
} catch {
  // No background to talk to; the placeholder still works on click.
}

// Fallback for when that port is gone (e.g. this page outlived a service-worker
// restart): a plain one-off message asking us to load.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "TABINET_LOAD_NOW") return false;
  go();
  sendResponse({ ok: navigated }); // false only if we have no URL to go to
  return false;
});

// If we're already the visible tab at load time, go immediately.
if (document.visibilityState === "visible") go();
