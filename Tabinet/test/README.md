# Tabinet tests

No dependencies, no build step:

```sh
node test/run.mjs
```

The suites exercise the real code in `src/` against `fake-chrome.mjs`, a small
stand-in for the Chrome extension APIs Tabinet uses — tabs open, placeholder
pages connect their port, navigations complete, events fire.

| suite | covers |
|---|---|
| `hydrate.test.mjs` | `src/background/hydrate.js` — background loading: order, pacing (≤3 at once), the port → message → `tabs.update` fallback chain, cancellation, closed tabs, the 60-tab cap. |
| `lazy.test.mjs` | `src/lazy/lazy.js` — how a placeholder leaves the placeholder: the port signal, `replace()` (no Back entry), the message fallback, and the click/visible path. |
| `worker.test.mjs` | `src/background/service-worker.js` end to end, driven by a `RESTORE_GROUP` message: every tab opens **and loads** in one window, nothing is requested for a workspace that isn't open, switching away cancels the old workspace's loading, and the "Pre-load tabs" setting turns it all off. |

`test/.tmp/` is a staged copy of `src/` (see the header of `run.mjs`); it is
rebuilt on every run and git-ignored.
