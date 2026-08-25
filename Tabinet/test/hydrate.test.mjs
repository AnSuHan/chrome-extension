/** Unit tests for src/background/hydrate.js against the fake Chrome API. */
import assert from "node:assert/strict";
import { install, lazyUrl, sleep } from "./fake-chrome.mjs";

let pass = 0;
const ok = (name) => {
  pass += 1;
  console.log("  ok -", name);
};

async function openLazyTabs(chrome, urls, windowId = 1) {
  const created = [];
  for (const u of urls) {
    created.push(await chrome.tabs.create({ url: lazyUrl(u), windowId }));
  }
  await sleep(5); // let the placeholder pages connect their ports
  return created;
}

/* 1 — every opened tab really loads, over its port, and none is left behind */
{
  const env = install();
  const { hydrateTabs } = await import("./.tmp/src/background/hydrate.js");
  const urls = Array.from({ length: 7 }, (_, i) => `https://ex${i}.test/p`);
  const tabs = await openLazyTabs(env.chrome, urls);

  const res = await hydrateTabs(
    tabs.map((t, i) => ({ tabId: t.id, url: urls[i] })),
    { key: "win:1" },
  );

  assert.equal(res.hydrated, 7, "all 7 tabs hydrated");
  assert.equal(env.log.navigated.length, 7);
  assert.deepEqual(
    env.log.navigated,
    tabs.map((t) => t.id),
    "loaded in tab order",
  );
  assert.ok(
    Object.values(env.log.via).every((v) => v === "port"),
    "every tab was triggered over its port (no history-leaving tabs.update)",
  );
  for (const t of tabs) {
    assert.equal(env.tabs.get(t.id).url, urls[tabs.indexOf(t)], "on real url");
  }
  assert.equal(env.log.fetched.length, 0, "hydration itself makes no fetches");
  ok("all opened tabs load, in order, via port, ending on their real URL");
}

/* 2 — pacing: never more than HYDRATE_CONCURRENCY (3) loading at once */
{
  const env = install({ navMs: 30 });
  const { hydrateTabs } = await import(
    "./.tmp/src/background/hydrate.js?v=2"
  );
  const urls = Array.from({ length: 9 }, (_, i) => `https://p${i}.test/`);
  const tabs = await openLazyTabs(env.chrome, urls);

  let maxInFlight = 0;
  const done = new Set();
  const poll = setInterval(() => {
    const inFlight = env.log.navigated.filter((id) => !done.has(id)).length;
    maxInFlight = Math.max(maxInFlight, inFlight);
  }, 3);
  env.chrome.tabs.onUpdated.addListener((id, ci) => {
    if (ci.status === "complete") done.add(id);
  });

  await hydrateTabs(
    tabs.map((t, i) => ({ tabId: t.id, url: urls[i] })),
    { key: "win:1" },
  );
  clearInterval(poll);
  assert.ok(maxInFlight <= 3, `at most 3 in flight (saw ${maxInFlight})`);
  assert.equal(env.log.navigated.length, 9);
  ok(`paced: at most 3 tabs loading at once (peak ${maxInFlight}), all 9 done`);
}

/* 3 — a tab already on a real page is left alone; so is one that isn't ours */
{
  const env = install();
  const { hydrateTabs } = await import("./.tmp/src/background/hydrate.js?v=3");
  const lazy = await env.chrome.tabs.create({ url: lazyUrl("https://a.test/") });
  const real = await env.chrome.tabs.create({ url: "https://already.test/" });
  await sleep(5);

  await hydrateTabs(
    [
      { tabId: real.id, url: "https://already.test/" },
      { tabId: lazy.id, url: "https://a.test/" },
    ],
    { key: "win:1" },
  );
  assert.deepEqual(env.log.navigated, [lazy.id], "only the placeholder loaded");
  assert.equal(env.tabs.get(real.id).url, "https://already.test/", "untouched");
  ok("tabs already showing a real page are not reloaded");
}

/* 4 — no port (e.g. after a worker restart): message, then tabs.update */
{
  const env = install({ sendMessageWorks: true });
  const { hydrateTabs } = await import("./.tmp/src/background/hydrate.js?v=4");
  const t = await env.chrome.tabs.create({ url: lazyUrl("https://m.test/") });
  await sleep(5);
  env.ports.get(t.id)?.close(); // pretend the port died with the worker
  await hydrateTabs([{ tabId: t.id, url: "https://m.test/" }], { key: "k" });
  assert.equal(env.log.via[t.id], "message", "fell back to tabs.sendMessage");

  const env2 = install({ sendMessageWorks: false });
  const { hydrateTabs: h2 } = await import("./.tmp/src/background/hydrate.js?v=5");
  const t2 = await env2.chrome.tabs.create({ url: lazyUrl("https://u.test/") });
  await sleep(5);
  env2.ports.get(t2.id)?.close();
  await h2([{ tabId: t2.id, url: "https://u.test/" }], { key: "k" });
  assert.equal(env2.log.via[t2.id], "update", "last resort: worker navigates");
  assert.equal(env2.tabs.get(t2.id).url, "https://u.test/");
  ok("falls back message → tabs.update when the page's port is gone");
}

/* 5 — switching away cancels the run in flight */
{
  const env = install({ navMs: 40 });
  const mod = await import("./.tmp/src/background/hydrate.js?v=6");
  const urls = Array.from({ length: 9 }, (_, i) => `https://c${i}.test/`);
  const tabs = await openLazyTabs(env.chrome, urls);

  const run = mod.hydrateTabs(
    tabs.map((t, i) => ({ tabId: t.id, url: urls[i] })),
    { key: "win:1" },
  );
  await sleep(10);
  mod.cancelHydrate("win:1");
  await run;
  const started = env.log.navigated.length;
  await sleep(80);
  assert.ok(started < 9, `cancelled early (${started}/9 started)`);
  assert.equal(env.log.navigated.length, started, "nothing started after cancel");
  ok(`cancel stops the queue (${started}/9 loaded, no stragglers)`);
}

/* 6 — a tab closed mid-load releases its lane instead of stalling the queue */
{
  const env = install({ navMs: 10_000 }); // this page never finishes
  const mod = await import("./.tmp/src/background/hydrate.js?v=7");
  const urls = ["https://slow.test/", "https://x1.test/", "https://x2.test/"];
  const tabs = await openLazyTabs(env.chrome, urls);
  const run = mod.hydrateTabs(
    tabs.map((t, i) => ({ tabId: t.id, url: urls[i] })),
    { key: "win:1" },
  );
  await sleep(10);
  await env.chrome.tabs.remove([tabs[0].id]); // user closes the stuck tab
  await Promise.race([run, sleep(300)]);
  assert.ok(env.log.navigated.includes(tabs[1].id), "the queue kept moving");
  mod.cancelHydrate("win:1");
  await run;
  ok("a closed tab frees its lane; the rest keep loading");
}

/* 7 — the per-run cap is honoured */
{
  const env = install();
  const mod = await import("./.tmp/src/background/hydrate.js?v=8");
  const urls = Array.from({ length: 70 }, (_, i) => `https://big${i}.test/`);
  const tabs = await openLazyTabs(env.chrome, urls);
  const res = await mod.hydrateTabs(
    tabs.map((t, i) => ({ tabId: t.id, url: urls[i] })),
    { key: "win:1" },
  );
  assert.equal(mod.HYDRATE_LIMIT, 60);
  assert.equal(res.hydrated, 60, "stops at the cap");
  assert.equal(env.log.navigated.length, 60);
  ok("caps one run at 60 tabs (the rest stay on their placeholder)");
}

console.log(`\nhydrate.js: ${pass} checks passed`);
