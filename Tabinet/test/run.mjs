/**
 * Tabinet — test runner.   node test/run.mjs
 *
 * The extension has no build step and no dependencies, so the suites run the
 * real background/page code straight from src/ against a fake of the Chrome
 * APIs (test/fake-chrome.mjs): tabs open, placeholder pages connect their port,
 * navigations complete, events fire.
 *
 * One wrinkle: src/*.js has no package.json saying "type": "module", so Node
 * would read it as CommonJS. So we stage a copy of src/ under test/.tmp/ next
 * to a package.json that marks it as ESM, and the suites import from there.
 * .tmp/ is disposable — it is rebuilt on every run and git-ignored.
 *
 * Each suite runs in its own process: the background modules register their
 * listeners on whichever fake chrome exists at import time, so a fresh process
 * is the cleanest way to give each suite a pristine world.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, ".tmp");

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.cpSync(path.join(here, "..", "src"), path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{ "type": "module" }\n');

const suites = ["hydrate.test.mjs", "lazy.test.mjs", "worker.test.mjs"];
let failed = 0;
for (const suite of suites) {
  console.log(`\n${suite}`);
  const res = spawnSync(process.execPath, [path.join(here, suite)], {
    stdio: "inherit",
    cwd: here,
  });
  if (res.status !== 0) failed += 1;
}

console.log(
  failed ? `\n${failed} suite(s) FAILED` : "\nall suites passed",
);
process.exit(failed ? 1 : 0);
