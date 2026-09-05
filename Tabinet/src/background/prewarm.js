/**
 * Tabinet — background pre-warm.
 *
 * A restored workspace opens its tabs on a local lazy placeholder, so nothing
 * hits the network until the tab is clicked. That keeps switching instant, but
 * the first click then pays for everything at once: DNS + TLS, the whole login
 * redirect chain (app -> SSO -> back), and the document download.
 *
 * So the moment a workspace comes into view we quietly request its pending
 * pages *from the service worker* — with cookies, following redirects. Nothing
 * is rendered; the point is the side effects the click would otherwise wait on:
 *
 *   - the session is (re)established and any refreshed auth cookie is already
 *     in the jar, so the click lands on the signed-in page instead of walking
 *     the redirect chain,
 *   - DNS/TLS to the host is resolved and the document sits in the HTTP cache.
 *
 * This needs host permissions (see manifest host_permissions) — without them a
 * cross-origin credentialed fetch from the worker is blocked.
 *
 * Everything here is best-effort: failures are swallowed, work is capped, and a
 * new warm run for the same key cancels the previous one.
 */

// How many pages we fetch at once. Small on purpose — a warm run must never
// compete with the page the user is actually looking at.
const WARM_CONCURRENCY = 3;

// Give up on a single page after this long; a slow host isn't worth holding a
// connection (and the service worker) open for.
const WARM_TIMEOUT_MS = 20_000;

// Don't re-request the same url more often than this. Switching back and forth
// between two workspaces should not re-hit every host each time.
const WARM_TTL_MS = 3 * 60 * 1000;

// Beyond this many pages per run we stop — a huge workspace shouldn't turn a
// switch into a download burst.
const MAX_WARM_PER_RUN = 24;

const lastWarmed = new Map(); // url -> epoch ms of the last completed warm
const runs = new Map(); // key -> AbortController of the run currently owning it

/** Drop TTL entries that can no longer suppress anything. */
function pruneWarmed(now) {
  for (const [url, at] of lastWarmed) {
    if (now - at > WARM_TTL_MS) lastWarmed.delete(url);
  }
}

/** Abort the warm run registered under `key`, if any. */
export function cancelWarm(key) {
  runs.get(key)?.abort();
  runs.delete(key);
}

/**
 * Request one page for its side effects (cookies, DNS/TLS, HTTP cache).
 *
 * The body is drained for html documents only — a response has to be read to
 * completion to land in the HTTP cache, but a saved tab may point at a PDF or
 * an installer, and downloading those would be pure waste. For non-documents we
 * bail after the headers: the session and connection are already warm by then.
 */
async function warmOne(url, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), WARM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      signal: ctrl.signal,
    });
    const type = res.headers.get("content-type") ?? "";
    if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(type)) {
      await res.arrayBuffer();
    } else {
      ctrl.abort(); // headers were enough
    }
    lastWarmed.set(url, Date.now());
    return true;
  } catch {
    return false; // best-effort: offline, blocked, aborted, timed out…
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Warm `urls` in the background. `key` scopes the run (we use one per window):
 * starting a run replaces — and aborts — the previous run under the same key,
 * so a fast switch away doesn't leave the old workspace's fetches running.
 *
 * Resolves when the run finishes; callers normally fire and forget.
 */
export async function warmUrls(urls, { key = "default" } = {}) {
  cancelWarm(key);

  const now = Date.now();
  pruneWarmed(now);
  const queue = [...new Set(urls)]
    .filter((u) => /^https?:/i.test(u))
    .filter((u) => now - (lastWarmed.get(u) ?? 0) > WARM_TTL_MS)
    .slice(0, MAX_WARM_PER_RUN);
  if (!queue.length) return { warmed: 0 };

  const ctrl = new AbortController();
  runs.set(key, ctrl);
  let warmed = 0;
  const worker = async () => {
    while (queue.length && !ctrl.signal.aborted) {
      if (await warmOne(queue.shift(), ctrl.signal)) warmed += 1;
    }
  };
  try {
    const lanes = Math.min(WARM_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: lanes }, worker));
  } finally {
    if (runs.get(key) === ctrl) runs.delete(key);
  }
  return { warmed };
}
