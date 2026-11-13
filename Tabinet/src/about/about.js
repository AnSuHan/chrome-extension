/**
 * Tabinet — version page: the installed version and the release history
 * (src/lib/changelog.js), in the user's chosen language.
 */
import { CHANGELOG } from "../lib/changelog.js";
import {
  applyI18n,
  currentLanguage,
  initI18n,
  reloadOnLanguageChange,
  t,
} from "../lib/i18n.js";

function formatDate(iso, lang) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" });
}

function buildRelease(release, installed, lang) {
  const li = document.createElement("li");
  li.className = "release" + (release.version === installed ? " current" : "");

  const head = document.createElement("div");
  head.className = "release-head";
  const ver = document.createElement("span");
  ver.className = "release-version";
  ver.textContent = `v${release.version}`;
  head.append(ver);
  if (release.version === installed) {
    const badge = document.createElement("span");
    badge.className = "current-badge";
    badge.textContent = t("aboutCurrent");
    head.append(badge);
  }
  const date = document.createElement("time");
  date.className = "release-date";
  date.dateTime = release.date;
  date.textContent = formatDate(release.date, lang);
  head.append(date);

  const ul = document.createElement("ul");
  ul.className = "notes";
  for (const note of release.notes) {
    const item = document.createElement("li");
    item.className = "note";
    const tag = document.createElement("span");
    tag.className = `tag tag--${note.type}`;
    tag.textContent = t(`aboutType_${note.type}`);
    const text = document.createElement("span");
    text.textContent = note.text[lang] ?? note.text.en;
    item.append(tag, text);
    ul.append(item);
  }

  li.append(head, ul);
  return li;
}

async function init() {
  await initI18n();
  const lang = currentLanguage();
  document.title = t("aboutPageTitle");
  applyI18n();
  reloadOnLanguageChange();

  const installed = chrome.runtime.getManifest().version;
  document.getElementById("version").textContent = `v${installed}`;

  const list = document.getElementById("releases");
  for (const release of CHANGELOG) list.append(buildRelease(release, installed, lang));
}

init();
