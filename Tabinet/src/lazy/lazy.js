/**
 * Tabinet — lazy tab placeholder.
 *
 * A restored group opens its tabs pointing here (a tiny local page) instead of
 * their real URLs, so nothing hits the network until the user actually looks at
 * the tab. When this tab becomes visible (activated) — or is clicked — it
 * replaces itself with the real URL. Using replace() keeps it out of history,
 * so Back doesn't bounce through the placeholder.
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

// If we're already the visible tab at load time, go immediately.
if (document.visibilityState === "visible") go();
