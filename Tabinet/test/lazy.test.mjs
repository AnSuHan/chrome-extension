/** The placeholder page (src/lazy/lazy.js): how a tab leaves the placeholder. */
import assert from "node:assert/strict";

let pass = 0;
const ok = (name) => {
  pass += 1;
  console.log("  ok -", name);
};

let v = 0;
async function loadPage({ url, visible = false, connect = true }) {
  const replaced = [];
  const listeners = { message: [], port: [], doc: {} };
  globalThis.location = {
    search: `?u=${encodeURIComponent(url)}&t=${encodeURIComponent("Title")}`,
    replace: (u) => replaced.push(u),
  };
  globalThis.document = {
    title: "",
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (name, fn) => (listeners.doc[name] = fn),
    getElementById: () => ({ textContent: "", addEventListener() {} }),
  };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      connect: () => {
        if (!connect) throw new Error("no background");
        return {
          onMessage: { addListener: (fn) => listeners.port.push(fn) },
          onDisconnect: { addListener() {} },
        };
      },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
  };
  await import(`./.tmp/src/lazy/lazy.js?v=${++v}`);
  return { replaced, listeners };
}

/* 1 — the background's port signal navigates the page (via replace) */
{
  const p = await loadPage({ url: "https://one.test/x" });
  assert.deepEqual(p.replaced, [], "nothing happens until asked");
  p.listeners.port.forEach((fn) => fn({ type: "TABINET_LOAD_NOW" }));
  assert.deepEqual(p.replaced, ["https://one.test/x"], "went to the real URL");
  p.listeners.port.forEach((fn) => fn({ type: "TABINET_LOAD_NOW" }));
  assert.equal(p.replaced.length, 1, "a second signal is a no-op");
  ok("port signal → location.replace(real url), exactly once");
}

/* 2 — replace(), not assign(): no placeholder left in the tab's history */
{
  const p = await loadPage({ url: "https://two.test/" });
  p.listeners.port.forEach((fn) => fn({ type: "TABINET_LOAD_NOW" }));
  assert.equal(p.replaced[0], "https://two.test/");
  assert.equal(typeof globalThis.location.assign, "undefined", "assign unused");
  ok("navigates with replace() so Back never returns to the placeholder");
}

/* 3 — no port (no background): the one-off message still works */
{
  const p = await loadPage({ url: "https://three.test/", connect: false });
  assert.equal(p.listeners.message.length, 1, "message listener registered");
  let answer;
  p.listeners.message[0]({ type: "TABINET_LOAD_NOW" }, {}, (r) => (answer = r));
  assert.deepEqual(p.replaced, ["https://three.test/"]);
  assert.deepEqual(answer, { ok: true }, "tells the worker it is loading itself");
  ok("works without a port: the fallback message loads and confirms");
}

/* 4 — a tab the user is actually looking at loads on its own */
{
  const p = await loadPage({ url: "https://four.test/", visible: true });
  assert.deepEqual(p.replaced, ["https://four.test/"], "loaded immediately");
  ok("a visible placeholder loads itself without being asked");
}

/* 5 — becoming visible (user clicks the tab) loads it */
{
  const p = await loadPage({ url: "https://five.test/" });
  globalThis.document.visibilityState = "visible";
  p.listeners.doc.visibilitychange();
  assert.deepEqual(p.replaced, ["https://five.test/"]);
  ok("clicking an un-hydrated tab still loads it (old path intact)");
}

console.log(`\nlazy.js: ${pass} checks passed`);
