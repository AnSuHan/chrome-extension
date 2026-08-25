/**
 * Integration tests: drive src/background/service-worker.js the way the side
 * panel does (a RESTORE_GROUP message) and watch what really happens to tabs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { install, sleep } from "./fake-chrome.mjs";

let pass = 0;
const ok = (name) => {
  pass += 1;
  console.log("  ok -", name);
};

let v = 0;
async function bootWorker(env, { groups, settings = {} }) {
  env.storage.local["tabinet.settings"] = {
    area: "local",
    keepLoaded: true,
    preloadTabs: true,
    ...settings,
  };
  env.storage.local["tabinet.order"] = groups.map((g) => g.id);
  for (const g of groups) env.storage.local[`tabinet.g.${g.id}`] = g;
  // A fresh copy of the tree per case: the worker and hydrate.js register their
  // listeners on the fake chrome that exists at import time, so each case needs
  // its own module instances.
  const dir = `./.tmp/gen/${++v}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync("./.tmp/src", `${dir}/src`, { recursive: true });
  fs.writeFileSync(`${dir}/package.json`, '{ "type": "module" }');
  await import(`${dir}/src/background/service-worker.js`);
  await sleep(5);
}

function send(env, msg) {
  return new Promise((resolve) => {
    env.chrome.runtime.onMessage.fire(msg, { id: "test" }, resolve);
  });
}

/** Wait until no more tabs start loading for a beat. */
async function settle(env, ms = 120) {
  let last = -1;
  while (last !== env.log.navigated.length) {
    last = env.log.navigated.length;
    await sleep(ms);
  }
}

const group = (id, name, urls) => ({
  id,
  name,
  color: "blue",
  createdAt: 0,
  tabs: urls.map((u) => ({ url: u, title: u })),
});

const A = group("a", "Work", [
  "https://a1.test/",
  "https://a2.test/",
  "https://a3.test/",
  "https://a4.test/",
]);
const B = group("b", "Home", ["https://b1.test/", "https://b2.test/"]);

/* 1 — additive restore: every tab opens AND loads, in one window */
{
  const env = install({ navMs: 5 });
  await bootWorker(env, { groups: [A, B] });

  await send(env, { type: "RESTORE_GROUP", id: "a", windowId: 1 });
  await settle(env);

  assert.equal(env.log.created.length, 4, "4 tabs opened");
  assert.ok(
    env.log.created.every((c) => c.windowId === 1),
    "all created in the one window",
  );
  assert.equal(env.log.windowsCreated, 0, "no extra browser window");
  assert.equal(env.log.navigated.length, 4, "all 4 actually loaded");
  assert.ok(
    Object.values(env.log.via).every((x) => x === "port"),
    "loaded by the page itself (no history-leaving navigation)",
  );
  const urls = [...env.tabs.values()].map((t) => t.url).sort();
  assert.deepEqual(urls, A.tabs.map((t) => t.url).sort(), "on their real URLs");
  ok("restore: all tabs open and load in one window, none left cold");
}

/* 2 — nothing goes out for a workspace that isn't open */
{
  const env = install({ navMs: 5 });
  await bootWorker(env, { groups: [A, B] });
  await send(env, { type: "RESTORE_GROUP", id: "a", windowId: 1 });
  await settle(env);

  assert.deepEqual(env.log.fetched, [], "no pre-warm fetches at all");
  const touchedB = [...env.tabs.values()].some((t) => t.url.includes("b1.test"));
  assert.equal(touchedB, false, "workspace B never touched");
  ok("no request is made for a saved workspace that has no open tabs");
}

/* 3 — workspace switch: the first tab is activated, the rest are pre-loaded */
{
  const env = install({ navMs: 5 });
  await bootWorker(env, { groups: [A, B] });

  await send(env, { type: "RESTORE_GROUP", id: "a", switch: true, windowId: 1 });
  await settle(env);

  const opened = [...env.tabs.values()].filter((t) => t.windowId === 1);
  assert.equal(opened.length, 4, "workspace opened in the same window");
  assert.equal(env.log.windowsCreated, 0, "no extra browser window");
  const active = opened.find((t) => t.active);
  assert.ok(active, "a tab was activated");
  assert.equal(env.log.navigated.length, 3, "the other 3 were pre-loaded");
  assert.ok(
    !env.log.navigated.includes(active.id),
    "the activated tab is left to load itself (it is on screen)",
  );
  assert.ok(
    opened.filter((t) => !t.active).every((t) => !t.url.includes("lazy.html")),
    "no background tab is left on the placeholder",
  );
  ok("switch: background tabs are all loaded, the active one loads itself");
}

/* 4 — switching away stops the workspace you left from loading */
{
  const env = install({ navMs: 60 });
  const C = group(
    "c",
    "Big",
    Array.from({ length: 9 }, (_, i) => `https://c${i}.test/`),
  );
  await bootWorker(env, { groups: [C, B] });
  await send(env, { type: "RESTORE_GROUP", id: "c", switch: true, windowId: 1 });
  await sleep(40);
  const isC = (id) => (env.tabs.get(id)?.url ?? "").includes("c");
  const startedForC = env.log.navigated.filter(isC).length;
  assert.ok(startedForC > 0 && startedForC < 8, `C mid-flight (${startedForC}/8)`);

  await send(env, { type: "RESTORE_GROUP", id: "b", switch: true, windowId: 1 });
  await settle(env, 200);

  const cAfter = env.log.navigated.filter((id) => (env.tabs.get(id)?.url ?? "").includes("c"));
  assert.ok(
    cAfter.length === startedForC,
    `no new C loads after the switch (${startedForC} -> ${cAfter.length})`,
  );
  const bLoaded = [...env.tabs.values()].filter((t) =>
    ["https://b1.test/", "https://b2.test/"].includes(t.url),
  );
  assert.ok(bLoaded.length >= 1, "B's tabs took over the loading");
  ok(
    `switching away stops the old workspace loading (C stopped at ${cAfter.length}/9, B loaded)`,
  );
}

/* 5 — with the setting off, nothing is pre-loaded (old behaviour) */
{
  const env = install({ navMs: 5 });
  await bootWorker(env, { groups: [A, B], settings: { preloadTabs: false } });
  await send(env, { type: "RESTORE_GROUP", id: "a", windowId: 1 });
  await settle(env);

  assert.equal(env.log.navigated.length, 0, "no tab was navigated");
  assert.deepEqual(
    env.log.fetched.sort(),
    A.tabs.map((t) => t.url).sort(),
    "open tabs are network pre-warmed instead",
  );
  assert.ok(
    [...env.tabs.values()].every((t) => t.url.includes("lazy.html")),
    "tabs stay on the placeholder until clicked",
  );
  ok('"Pre-load tabs" off ⇒ old behaviour: pre-warm only, no loading');
}

/* ------------------------------------------------------------------ *
 * The two auto-save switches, driven through the real live-sync path
 * ------------------------------------------------------------------ */

const savedUrls = (env) => env.storage.local["tabinet.g.a"].tabs.map((t) => t.url);
const SYNC = 700; // live sync coalesces for 500ms

/** Open workspace A as the window's active workspace, hydration finished. */
async function openA(env, settings) {
  await bootWorker(env, { groups: [A, B], settings });
  await send(env, { type: "RESTORE_GROUP", id: "a", switch: true, windowId: 1 });
  await settle(env);
  return [...env.tabs.values()].filter((t) => t.windowId === 1);
}

/* 6 — both on (default): navigation, new tabs and closed tabs are all saved */
{
  const env = install({ navMs: 5 });
  const tabs = await openA(env, {});
  assert.deepEqual(savedUrls(env), A.tabs.map((t) => t.url), "unchanged so far");

  env.goTo(tabs[1].id, "https://moved.test/");
  await sleep(SYNC);
  assert.equal(savedUrls(env)[1], "https://moved.test/", "navigation saved");

  await env.chrome.tabs.create({ url: "https://new.test/", windowId: 1 });
  await sleep(SYNC);
  assert.equal(savedUrls(env).length, 5, "the new tab was saved");
  assert.ok(savedUrls(env).includes("https://new.test/"));

  await env.chrome.tabs.remove([tabs[0].id]);
  await sleep(SYNC);
  assert.equal(savedUrls(env).length, 4, "the closed tab was dropped");
  ok("both on: navigation, added and closed tabs are all saved");
}

/* 7 — changes on, count off: follows tabs, keeps the saved tab count */
{
  const env = install({ navMs: 5 });
  const tabs = await openA(env, { autoSaveCount: false });

  env.goTo(tabs[1].id, "https://moved.test/");
  await sleep(SYNC);
  assert.equal(savedUrls(env)[1], "https://moved.test/", "navigation saved");

  await env.chrome.tabs.create({ url: "https://new.test/", windowId: 1 });
  await sleep(SYNC);
  assert.equal(savedUrls(env).length, 4, "tab count held at 4");
  assert.ok(!savedUrls(env).includes("https://new.test/"), "new tab not saved");

  await env.chrome.tabs.remove([tabs[0].id]);
  await sleep(SYNC);
  assert.equal(savedUrls(env).length, 4, "closing a tab doesn't shrink it either");
  ok("changes on / count off: tabs are followed, the count stays put");
}

/* 8 — changes off, count on: size follows the window, urls stay as saved */
{
  const env = install({ navMs: 5 });
  const tabs = await openA(env, { autoSaveChanges: false });

  env.goTo(tabs[1].id, "https://moved.test/");
  await sleep(SYNC);
  assert.deepEqual(savedUrls(env), A.tabs.map((t) => t.url), "navigation not saved");

  await env.chrome.tabs.create({ url: "https://new.test/", windowId: 1 });
  await sleep(SYNC);
  const after = savedUrls(env);
  assert.equal(after.length, 5, "the count followed the window");
  assert.equal(after[4], "https://new.test/", "the new slot took the live url");
  assert.deepEqual(after.slice(0, 4), A.tabs.map((t) => t.url), "saved urls kept");
  ok("changes off / count on: the count follows, saved urls are kept");
}

/* 9 — both off: the saved workspace is frozen */
{
  const env = install({ navMs: 5 });
  const tabs = await openA(env, { autoSaveChanges: false, autoSaveCount: false });

  env.goTo(tabs[1].id, "https://moved.test/");
  await env.chrome.tabs.create({ url: "https://new.test/", windowId: 1 });
  await sleep(SYNC);
  await env.chrome.tabs.remove([tabs[0].id]);
  await sleep(SYNC);
  assert.deepEqual(savedUrls(env), A.tabs.map((t) => t.url), "nothing was written");
  ok("both off: the saved workspace is frozen until you save over it");
}

/* 10 — the switches also gate the save a closing workspace does */
{
  const env = install({ navMs: 5 });
  // keepLoaded off ⇒ switching away saves and closes the workspace.
  const tabs = await openA(env, { keepLoaded: false, autoSaveCount: false });
  env.goTo(tabs[1].id, "https://moved.test/");
  await env.chrome.tabs.create({ url: "https://extra.test/", windowId: 1 });
  await sleep(SYNC);

  await send(env, { type: "RESTORE_GROUP", id: "b", switch: true, windowId: 1 });
  await sleep(SYNC);
  const after = savedUrls(env);
  assert.equal(after.length, 4, "the closing save kept the saved tab count");
  assert.ok(after.includes("https://moved.test/"), "but did record the navigation");
  assert.ok(!after.includes("https://extra.test/"), "and dropped the extra tab");
  ok("closing a workspace obeys the same two switches");
}

console.log(`\nservice-worker.js: ${pass} checks passed`);
