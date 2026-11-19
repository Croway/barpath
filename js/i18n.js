/* Translations. Every text the app shows comes from a catalog by key: locales/en.js is the source, and the fallback
 * for any key a translation lacks. Another language is one more file with the same keys (locales/it.js), listed in
 * LANGS. The analysis modules use tr() too and stay pure: English until setLang() picks another catalog.
 *
 *   tr("gallery.title")                 the text
 *   tr("gallery.count", { n: 3 })       {n} filled in; an entry { one, other } picks its plural form by n
 *   num(1.234, 2)                       "1.23", with the language's decimal mark ("1,23" in Italian), no grouping
 *   applyDom()                          the page's static texts: [data-i18n] (text), [data-i18n-rich] (text with
 *                                       **bold**), [data-i18n-attr="aria-label: key; placeholder: key"]
 *
 * Call tr() when a text is shown, never at a module's top level (that runs before the language is set). It's tr,
 * not t: t is time all over this code. Exports (CSV, JSON) stay English with "." decimals: they're data, not text.
 * Shared with Kip Lab: identical. */
import en from "../locales/en.js";

/** the languages there's a catalog for; add one as `it: "Italiano"` once locales/it.js exists */
export const LANGS = { en: "English" };

let lang = "en", cat = en, plural = new Intl.PluralRules("en"), dec = ".";

export const getLang = () => lang;

/** the language to use: a saved choice, else the phone's first language with a catalog, else English */
export function pickLang(saved) {
  if (saved && LANGS[saved]) return saved;
  const prefs = (typeof navigator !== "undefined" && navigator.languages) || [];
  for (const l of prefs) { const k = String(l).toLowerCase().split("-")[0]; if (LANGS[k]) return k; }
  return "en";
}

export async function setLang(l) {
  const next = LANGS[l] ? l : "en";
  cat = next === "en" ? en : (await import(`../locales/${next}.js`)).default;
  lang = next;
  plural = new Intl.PluralRules(lang);
  dec = (1.5).toLocaleString(lang).includes(",") ? "," : ".";
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export function tr(key, vars) {
  let s = cat[key] ?? en[key];
  if (s === undefined) return key;
  if (typeof s === "object") s = s[plural.select(Number(vars?.n ?? 0))] ?? s.other;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k]))) : s;
}

/** v with d decimals and the language's decimal mark; exactly toFixed() in English */
export function num(v, d = 0) {
  const s = Number(v).toFixed(d);
  return dec === "." ? s : s.replace(".", dec);
}

/** text with **bold** parts into an element, as nodes (never innerHTML) */
export function rich(el, s) {
  el.replaceChildren(...s.split("**").map((p, i) => (i % 2 ? Object.assign(document.createElement("b"), { textContent: p }) : document.createTextNode(p))));
}

/** the page's static texts in the current language */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-rich]")) rich(el, tr(el.dataset.i18nRich));
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const [a, k] = pair.split(":").map((x) => x.trim());
      if (a && k) el.setAttribute(a, tr(k));
    }
  }
}
