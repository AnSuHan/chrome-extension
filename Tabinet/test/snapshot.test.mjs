/** The auto-save policy: src/lib/storage.js mergeTabs / resolveAutoSave. */
import assert from "node:assert/strict";
import { mergeTabs, resolveAutoSave } from "./.tmp/src/lib/storage.js";

let pass = 0;
const ok = (name) => {
  pass += 1;
  console.log("  ok -", name);
};

const t = (u) => ({ url: u, title: u });
const urls = (list) => (list ?? []).map((x) => x.url);

const saved = [t("https://a/"), t("https://b/"), t("https://c/")];

/* both on — the saved copy simply follows the window */
{
  const live = [t("https://a2/"), t("https://b/"), t("https://c/"), t("https://d/")];
  const out = mergeTabs(saved, live, { changes: true, count: true });
  assert.deepEqual(urls(out), urls(live));
  ok("both on: saved copy follows the window exactly");
}

/* changes only — navigation is saved, a new tab is not */
{
  const live = [t("https://a2/"), t("https://b/"), t("https://c/"), t("https://new/")];
  const out = mergeTabs(saved, live, { changes: true, count: false });
  assert.equal(out.length, 3, "tab count stays as saved");
  assert.deepEqual(urls(out), ["https://a2/", "https://b/", "https://c/"]);
  ok("changes only: navigation saved, added tab ignored");
}

/* changes only — a closed tab doesn't shrink the saved workspace */
{
  const live = [t("https://a/"), t("https://c/")];
  const out = mergeTabs(saved, live, { changes: true, count: false });
  assert.equal(out.length, 3, "still three saved tabs");
  assert.equal(out[2].url, "https://c/", "the empty slot falls back to the saved url");
  ok("changes only: closing a tab never shrinks the saved workspace");
}

/* count only — the size follows the window, urls stay as saved */
{
  const live = [t("https://a2/"), t("https://b/"), t("https://c/"), t("https://new/")];
  const out = mergeTabs(saved, live, { changes: false, count: true });
  assert.deepEqual(urls(out), [
    "https://a/", // kept: this tab's navigation is not saved
    "https://b/",
    "https://c/",
    "https://new/", // no saved url for this slot, so the live one is taken
  ]);
  ok("count only: size follows the window, saved urls are kept");
}

/* neither — nothing may be written at all */
{
  const live = [t("https://x/")];
  assert.equal(mergeTabs(saved, live, { changes: false, count: false }), null);
  ok("both off: nothing is written (null)");
}

/* defaults: absent settings mean both on */
{
  assert.deepEqual(resolveAutoSave(undefined), { changes: true, count: true });
  assert.deepEqual(resolveAutoSave({}), { changes: true, count: true });
  assert.deepEqual(resolveAutoSave({ autoSaveChanges: false }), {
    changes: false,
    count: true,
  });
  assert.deepEqual(resolveAutoSave({ autoSaveCount: false }), {
    changes: true,
    count: false,
  });
  ok("the two switches are independent and default to on");
}

console.log(`\nstorage.js (auto-save policy): ${pass} checks passed`);
