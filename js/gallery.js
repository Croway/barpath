/* The gallery screen: every analysed lift kept on this phone, newest filmed first, filterable by lift. Tap one to
 * open its analysis again (no tracking); tick two to four to compare them, or to delete them. */
import * as Store from "./store.js";
import { LIFTS, fmtPlain } from "./analysis.js";
import { MAX, when, dateLocale } from "./compare.js";
import { tr, num } from "./i18n.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
export const mb = (b) => (b >= 1e9 ? `${num(b / 1e9, 1)} GB` : b >= 1e7 ? `${Math.round(b / 1e6)} MB` : `${num(Math.max(0.1, b / 1e6), 1)} MB`);
const dayKey = (ms) => new Date(ms).toDateString();
const day = (ms) => {
  const d = new Date(ms), now = new Date();
  return d.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
};
const time = (ms) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
/** the card's rep count tile, if it has one (a card keeps the texts of the language it was saved in) */
const repsTile = (c) => (c.tiles || []).find((t) => !t.unit && t.label === tr("tile.reps"));
/** a headline number: "1.91 m/s", "2 reps" (a count says what it counts, singular for one) */
const tileText = (t) => {
  if (t.unit) return /^[°%]/.test(t.unit) ? `${t.value}${t.unit}` : `${t.value} ${t.unit}`;
  if (t.label === tr("tile.reps")) return tr("gallery.reps", { n: Number(t.value) });
  return `${t.value} ${t.label.toLowerCase()}`;
};
/** a card's lines: the lift and its load first (what tells a session's lifts apart), then its numbers, then what
 * the title adds (catch, depth), without saying the rep count twice (the title's part made as analysis.js does) */
export function cardLines(c) {
  const [name, ...rest] = String(c.title || "").split(" · ");
  const nums = (c.tiles || []).map(tileText);
  const reps = repsTile(c), count = reps ? tr("title.reps", { n: Number(reps.value) }) : null;
  const extra = rest.filter((q) => q !== count);
  return { title: `${name}${c.kg ? ` · ${fmtPlain(c.kg)} kg` : ""}`, nums: [...nums, ...extra].join(" · ") };
}

export class Gallery {
  /** refs: { list, filters, summary, status, empty, bar, barText, compare, remove, trim }; on: { open(id), compare(ids) } */
  constructor(refs, on) {
    this.r = refs;
    this.on = on;
    this.cards = [];
    this.filter = "all";
    this.sel = new Set();
    this.urls = [];
    this.sizes = new Map();
    this.busy = false;
    refs.trim.addEventListener("click", () => this.trim());
    refs.compare.addEventListener("click", () => this.on.compare([...this.sel]));
    refs.remove.addEventListener("click", async () => {
      const n = this.sel.size;
      if (!n || !confirm(tr("gallery.deleteConfirm", { n }))) return;
      await Store.remove([...this.sel]);
      this.sel.clear();
      await this.refresh();
    });
  }

  async count() { try { return (await Store.list()).length; } catch { return 0; } }

  async refresh() {
    try { this.cards = await Store.list(); } catch { this.cards = []; }
    const ids = new Set(this.cards.map((c) => c.id));
    for (const id of this.sel) if (!ids.has(id)) this.sel.delete(id);
    const kinds = [...new Set(this.cards.map((c) => c.lift))];
    if (this.filter !== "all" && !kinds.includes(this.filter)) this.filter = "all";
    // this app's own videos (the browser's usage is the whole site's: both apps, their offline copies)
    this.sizes = await Store.sizes().catch(() => new Map());
    this.chips(kinds);
    this.render();
    const used = [...this.sizes.values()].reduce((a, b) => a + b, 0);
    const n = this.cards.length;
    this.r.summary.textContent = !n ? "" : used ? tr("gallery.summaryUsed", { n, size: mb(used) }) : tr("gallery.summary", { n });
  }

  chips(kinds) {
    const f = this.r.filters;
    f.replaceChildren();
    f.hidden = kinds.length < 2;
    for (const k of ["all", ...kinds]) {
      const b = el("button", null, k === "all" ? tr("gallery.all") : LIFTS[k] || k);
      b.type = "button";
      b.setAttribute("aria-pressed", String(this.filter === k));
      b.addEventListener("click", () => { this.filter = k; this.chips(kinds); this.render(); });
      f.append(b);
    }
  }

  render() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    const shown = this.cards.filter((c) => this.filter === "all" || c.lift === this.filter);
    this.r.empty.hidden = this.cards.length > 0;
    // grouped by the day they were filmed (the list is newest first)
    const days = [];
    for (const c of shown) {
      if (!days.length || days[days.length - 1].key !== dayKey(c.filmed)) days.push({ key: dayKey(c.filmed), when: c.filmed, cards: [] });
      days[days.length - 1].cards.push(c);
    }
    this.r.list.replaceChildren(...days.map((d) => {
      const li = el("li", "day"), ul = el("ul", "lifts");
      ul.append(...d.cards.map((c) => this.item(c)));
      li.append(el("h3", null, day(d.when)), ul);
      return li;
    }));
    this.bar();
  }

  item(c) {
    const li = el("li", "lift");
    li.dataset.id = c.id;
    const open = el("button", "open");
    open.type = "button";
    const img = el("img", "thumb");
    img.alt = "";
    if (c.thumb) { const u = URL.createObjectURL(c.thumb); this.urls.push(u); img.src = u; }
    const txt = el("span", "txt"), L = cardLines(c);
    const size = this.sizes.get(c.id);
    txt.append(el("span", "ttl", L.title), el("span", "meta", size ? `${time(c.filmed)} · ${mb(size)}` : time(c.filmed)));
    if (L.nums) txt.append(el("span", "nums", L.nums));
    open.append(img, txt);
    open.addEventListener("click", () => this.on.open(c.id));
    const pick = el("label", "pick");
    const box = el("input");
    box.type = "checkbox";
    box.checked = this.sel.has(c.id);
    box.setAttribute("aria-label", tr("gallery.select", { title: c.title, when: when(c.filmed) }));
    box.addEventListener("change", () => { box.checked ? this.sel.add(c.id) : this.sel.delete(c.id); this.bar(); });
    pick.append(box);
    li.append(open, pick);
    return li;
  }

  /** keep only the analysed part of the ticked videos: every cut is planned first, so the space it frees is known
   * before anything is deleted; videos already cut, or that can't be (not an MP4), are left as they are */
  async trim() {
    const ids = [...this.sel];
    if (!ids.length || this.busy) return;
    this.setBusy(true, tr("gallery.trimChecking"));
    const plans = [];
    let skipped = 0;
    for (const id of ids) {
      if (this.cards.find((c) => c.id === id)?.trimmed) { skipped++; continue; }
      try {
        const p = await Store.planTrim(id);
        if (p && p.r.after < 0.95 * p.r.before) plans.push(p); else skipped++;
      } catch { skipped++; }
    }
    const free = plans.reduce((a, p) => a + p.r.before - p.r.after, 0);
    if (!plans.length) { this.setBusy(false); this.say(tr("gallery.trimNothing", { n: ids.length })); return; }
    const ask = tr("gallery.confirmTrim", { n: plans.length, free: mb(free) }) + (skipped ? `\n\n${tr("gallery.trimSkipped", { n: skipped })}` : "");
    if (!confirm(ask)) { this.setBusy(false); return; }
    let done = 0, freed = 0;
    for (const p of plans) {
      this.r.barText.textContent = tr("gallery.trimming", { i: done + 1, n: plans.length });
      try { await Store.applyTrim(p); done++; freed += p.r.before - p.r.after; } catch { /* left as it was */ }
    }
    this.sel.clear();
    this.setBusy(false);
    await this.refresh();
    this.say(tr("gallery.trimmed", { n: done, free: mb(freed) }));
  }
  setBusy(on, text) {
    this.busy = on;
    for (const b of this.r.bar.querySelectorAll("button")) b.disabled = on;
    for (const box of this.r.list.querySelectorAll(".pick input")) box.disabled = on;
    if (on) this.r.barText.textContent = text; else this.bar();
  }
  /** a line under the summary for what just happened */
  say(text) { if (this.r.status) this.r.status.textContent = text; }

  /** the selection bar: delete or trim any, compare 2-4 */
  bar() {
    if (this.busy) return;
    const n = this.sel.size;
    this.r.bar.hidden = n === 0;
    for (const b of this.r.bar.querySelectorAll("button")) b.disabled = false;
    this.r.barText.textContent = tr(n < 2 ? "gallery.selectedPick" : "gallery.selected", { n });
    for (const box of this.r.list.querySelectorAll(".pick input")) box.disabled = false; // any number: delete, trim
    this.r.compare.disabled = n < 2 || n > MAX; // compare: 2 to MAX
  }
}
