/**
 * Tabinet — UI translations.
 *
 * Strings live in the standard extension catalogs, _locales/<lang>/messages.json
 * (which also localize the manifest's description). chrome.i18n.getMessage can
 * only ever answer in Chrome's own UI language, though, and Tabinet lets the
 * user pick a language in the editor — so pages load the catalog themselves:
 *
 *   await initI18n();          // once, before rendering
 *   t("key", arg1, arg2)       // "$1"/"$2" in the message are replaced
 *   applyI18n(document)        // fills [data-i18n*] attributes in markup
 *
 * Missing keys fall back to English, then to the key itself, so a half-done
 * translation never shows a blank.
 *
 * Works in the service worker too (no DOM needed for initI18n / t).
 */

import { getSettings } from "./storage.js";

/** Languages Tabinet ships, in the order the picker lists them. */
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ko", label: "한국어" },
  { code: "ja", label: "日本語" },
];
const CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
const FALLBACK = "en";

let messages = {};
let fallback = {};
let current = FALLBACK;
let loadedFor = null; // the language the catalogs above were loaded for

/** Map a setting ("auto" or a code) to a language we actually ship. */
export function resolveLanguage(pref) {
  if (pref && pref !== "auto" && CODES.includes(pref)) return pref;
  let ui = "";
  try {
    ui = chrome.i18n?.getUILanguage?.() ?? "";
  } catch {
    /* not available here */
  }
  if (!ui && typeof navigator !== "undefined") ui = navigator.language ?? "";
  ui = ui.toLowerCase();
  return CODES.find((c) => ui === c || ui.startsWith(`${c}-`)) ?? FALLBACK;
}

async function loadCatalog(lang) {
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    const json = await res.json();
    const out = {};
    for (const [key, entry] of Object.entries(json)) out[key] = entry?.message ?? "";
    return out;
  } catch (e) {
    console.warn(`Tabinet i18n: couldn't load "${lang}"`, e);
    return {};
  }
}

/**
 * Load the catalog for the chosen language (settings.language, or `lang` when
 * given). Cheap to call again — it only reloads when the language changed.
 */
export async function initI18n(lang) {
  const want = resolveLanguage(lang ?? (await getSettings()).language);
  if (loadedFor === want) return want;
  if (!Object.keys(fallback).length) fallback = await loadCatalog(FALLBACK);
  messages = want === FALLBACK ? fallback : await loadCatalog(want);
  current = want;
  loadedFor = want;
  if (typeof document !== "undefined") document.documentElement.lang = want;
  return want;
}

/** The language currently in use ("en", "ko", …). */
export function currentLanguage() {
  return current;
}

/** Translate `key`, substituting $1…$9 with the extra arguments. */
export function t(key, ...subs) {
  let s = messages[key] ?? fallback[key] ?? key;
  subs.forEach((v, i) => {
    s = s.split(`$${i + 1}`).join(String(v));
  });
  return s;
}

/**
 * Fill translatable markup under `root`:
 *   data-i18n="key"             → textContent
 *   data-i18n-html="key"        → innerHTML (our own catalog strings only)
 *   data-i18n-title="key"       → title
 *   data-i18n-placeholder="key" → placeholder
 *   data-i18n-aria-label="key"  → aria-label
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
}

/**
 * Reload the page when the language setting changes (from the editor, or on
 * another device's page), so every string — including ones baked into
 * already-rendered rows — switches together.
 */
export function reloadOnLanguageChange() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !("tabinet.settings" in changes)) return;
    const { oldValue, newValue } = changes["tabinet.settings"];
    if ((oldValue?.language ?? "auto") !== (newValue?.language ?? "auto")) {
      location.reload();
    }
  });
}
