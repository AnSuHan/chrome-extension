/**
 * Regression tests: saved groups and native tab groups must not keep piling up.
 *
 *  - a switch from an untracked window backs unsaved tabs up into ONE shared
 *    backup group, skipping tabs already saved elsewhere;
 *  - "Save window" reports an identical set as a duplicate instead of saving it
 *    again, and ignores other workspaces hidden in collapsed groups;
 *  - after a browser restart, restored workspace groups are re-attached (not
 *    opened a second time), duplicate copies are folded together, and groups
 *    that aren't Tabinet's are left alone.
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
    preloadTabs: false, // keep the network/hydration side out of these cases
    language: "en",
    ...settings,
  };
  env.storage.local["tabinet.order"] = groups.map((g) => g.id);
  for (const g of groups) env.storage.local[`tabinet.g.${g.id}`] = structuredClone(g);
  const dir = `./.tmp/gen/g${++v}`;
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

const savedGroups = (env) =>
  (env.storage.local["tabinet.order"] ?? []).map((id) => env.storage.local[`tabinet.g.${id}`]);

const group = (id, name, urls) => ({
  id,
  name,
  color: "blue",
  createdAt: 0,
  tabs: urls.map((u) => ({ url: u, title: u })),
});

const A = group("a", "Work", ["https://a1.test/", "https://a2.test/"]);
const B = group("b", "Home", ["https://b1.test/", "https://b2.test/"]);

/* 1 — repeated switches from untracked windows share ONE backup group */
{
  const env = install();
  await bootWorker(env, { groups: [A, B] });

  env.addTab({ url: "https://scratch1.test/", active: true });
  env.addTab({ url: "https://a1.test/" }); // already saved in "Work"
  await send(env, { type: "RESTORE_GROUP", id: "a", switch: true, windowId: 1 });

  // Forget the window, as a fresh window / restart would, and switch again.
  delete env.storage.local["tabinet.active"];
  for (const tab of [...env.tabs.values()]) {
    await env.chrome.tabs.ungroup(tab.id);
  }
  env.addTab({ url: "https://scratch2.test/" });
  env.addTab({ url: "https://scratch1.test/" }); // already in the backup
  await send(env, { type: "RESTORE_GROUP", id: "b", switch: true, windowId: 1 });

  const backups = savedGroups(env).filter((g) => g.backup);
  assert.equal(backups.length, 1, "exactly one backup group");
  assert.equal(savedGroups(env).length, 3, "Work + Home + one backup");
  const urls = backups[0].tabs.map((t) => t.url);
  assert.ok(urls.includes("https://scratch1.test/"), "first scratch tab backed up");
  assert.ok(urls.includes("https://scratch2.test/"), "second scratch tab appended");
  assert.equal(new Set(urls).size, urls.length, "no duplicate urls inside it");
  assert.ok(!urls.includes("https://b1.test/"), "already-saved tabs are not copied");
  assert.equal(backups[0].name, "Backup (unsaved tabs)", "named from the catalog");
  ok("backups: one shared group, de-duplicated, already-saved tabs skipped");
}

/* 2 — nothing new to back up ⇒ no backup group at all */
{
  const env = install();
  await bootWorker(env, { groups: [A, B] });
  env.addTab({ url: "https://b1.test/", active: true });
  await send(env, { type: "RESTORE_GROUP", id: "a", switch: true, windowId: 1 });
  assert.equal(savedGroups(env).filter((g) => g.backup).length, 0, "no backup");
  assert.equal(savedGroups(env).length, 2, "group count unchanged");
  ok("backups: tabs that are already saved don't create a backup");
}

/* 3 — Save window twice ⇒ second is a duplicate; hidden workspaces excluded */
{
  const env = install();
  await bootWorker(env, { groups: [A] });
  env.addTab({ url: "https://x1.test/", active: true });
  env.addTab({ url: "https://x2.test/" });
  env.restoreGroup({ title: "Elsewhere", collapsed: true, urls: ["https://hidden.test/"] });

  const first = await send(env, { type: "SAVE_CURRENT_WINDOW", payload: { windowId: 1 } });
  assert.equal(first.status, "saved");
  assert.deepEqual(
    first.group.tabs.map((t) => t.url).sort(),
    ["https://x1.test/", "https://x2.test/"],
    "only the visible tabs were saved",
  );
  const second = await send(env, { type: "SAVE_CURRENT_WINDOW", payload: { windowId: 1 } });
  assert.equal(second.status, "duplicate", "identical window reported as duplicate");
  assert.equal(second.group.id, first.group.id, "pointing at the existing group");
  assert.equal(savedGroups(env).length, 2, "Work + one saved window");
  ok("save window: no duplicate copies, collapsed workspaces left out");
}

/* 4 — after a restart, restored groups are re-attached, not reopened */
{
  const env = install();
  await bootWorker(env, { groups: [A, B] });
  // What Chrome restores: Work expanded (on screen), Home collapsed — both
  // under new ids, unknown to the worker. Plus a group of the user's own.
  const work = env.restoreGroup({ title: "Work", urls: A.tabs.map((t) => t.url) });
  const home = env.restoreGroup({
    title: "Home",
    collapsed: true,
    urls: B.tabs.map((t) => t.url),
  });
  const mine = env.restoreGroup({ title: "Not Tabinet", urls: ["https://mine.test/"] });
  const firstWork = [...env.tabs.values()].find((t) => t.groupId === work);
  await env.chrome.tabs.update(firstWork.id, { active: true });
  // Stale bookkeeping from the previous session, with ids that now mean
  // something else — must be thrown away, not trusted.
  env.storage.local["tabinet.wsgroups"] = { 1: { a: mine } };
  env.storage.local["tabinet.active"] = { 1: "b" };

  env.chrome.runtime.onStartup.fire();
  await sleep(20);
  assert.deepEqual(env.storage.local["tabinet.active"], { 1: "a" }, "Work is on screen");
  assert.deepEqual(
    env.storage.local["tabinet.wsgroups"],
    { 1: { a: work, b: home } },
    "both workspaces re-attached to their restored groups",
  );

  const before = env.log.created.length;
  await send(env, { type: "RESTORE_GROUP", id: "b", switch: true, windowId: 1 });
  assert.equal(env.log.created.length, before, "no tab opened: Home was reused");
  assert.equal(env.groups.get(home).collapsed, false, "Home expanded");
  assert.equal(env.groups.get(work).collapsed, true, "Work collapsed");
  assert.equal(env.groups.size, 3, "still exactly three tab groups");
  assert.ok(env.groups.has(mine), "the user's own group is untouched");
  ok("restart: workspaces re-attach to restored groups — nothing reopened");
}

/* 5 — a duplicate copy of a workspace is folded into the attached one */
{
  const env = install();
  await bootWorker(env, { groups: [A, B] });
  const work = env.restoreGroup({ title: "Work", urls: A.tabs.map((t) => t.url) });
  const dup = env.restoreGroup({
    title: "Work",
    collapsed: true,
    urls: ["https://a1.test/", "https://only-in-copy.test/"],
  });
  const firstWork = [...env.tabs.values()].find((t) => t.groupId === work);
  await env.chrome.tabs.update(firstWork.id, { active: true });

  await send(env, { type: "RESTORE_GROUP", id: "b", switch: true, windowId: 1 });

  assert.ok(!env.groups.has(dup), "the duplicate group is gone");
  const workUrls = [...env.tabs.values()]
    .filter((t) => t.groupId === work)
    .map((t) => t.url)
    .sort();
  assert.deepEqual(
    workUrls,
    ["https://a1.test/", "https://a2.test/", "https://only-in-copy.test/"],
    "its unique tab moved over; the repeated one closed",
  );
  const titled = [...env.groups.values()].filter((g) => g.title === "Work");
  assert.equal(titled.length, 1, "one Work group left");
  ok("restart: duplicate workspace copies are merged, not multiplied");
}

console.log(`\ngroup accumulation: ${pass} checks passed`);
