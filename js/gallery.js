/* The gallery screen: every analysed lift kept on this phone, newest filmed first, filterable by lift. Tap one to
 * open its analysis again (no tracking); tick two to four to compare them, or to delete them. */
import * as Store from "./store.js";
import { LIFTS } from "./analysis.js";
import { MAX, when } from "./compare.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export class Gallery {
  /** refs: { list, filters, summary, empty, bar, barText, compare, remove }; on: { open(id), compare(ids) } */
  constructor(refs, on) {
    this.r = refs;
    this.on = on;
    this.cards = [];
    this.filter = "all";
    this.sel = new Set();
    this.urls = [];
    refs.compare.addEventListener("click", () => this.on.compare([...this.sel]));
    refs.remove.addEventListener("click", async () => {
      const n = this.sel.size;
      if (!n || !confirm(`Delete ${n === 1 ? "this lift" : `these ${n} lifts`} and ${n === 1 ? "its video" : "their videos"} from this phone?`)) return;
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
    this.chips(kinds);
    this.render();
    const used = await Store.usage();
    this.r.summary.textContent = this.cards.length
      ? `${this.cards.length} ${this.cards.length === 1 ? "lift" : "lifts"}${used ? ` · ${mb(used)} on this phone` : ""}`
      : "";
  }

  chips(kinds) {
    const f = this.r.filters;
    f.replaceChildren();
    f.hidden = kinds.length < 2;
    for (const k of ["all", ...kinds]) {
      const b = el("button", null, k === "all" ? "All" : LIFTS[k] || k);
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
    this.r.list.replaceChildren(...shown.map((c) => this.item(c)));
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
    const txt = el("span", "txt");
    txt.append(el("span", "ttl", c.title), el("span", "meta", `${when(c.filmed)}${c.kg ? ` · ${c.kg} kg` : ""}`));
    if (c.tiles?.length) txt.append(el("span", "nums", c.tiles.map((t) => (t.unit ? `${t.value} ${t.unit}` : `${t.value} ${t.label.toLowerCase()}`)).join(" · ")));
    open.append(img, txt);
    open.addEventListener("click", () => this.on.open(c.id));
    const pick = el("label", "pick");
    const box = el("input");
    box.type = "checkbox";
    box.checked = this.sel.has(c.id);
    box.setAttribute("aria-label", `Select ${c.title}, ${when(c.filmed)}`);
    box.addEventListener("change", () => { box.checked ? this.sel.add(c.id) : this.sel.delete(c.id); this.bar(); });
    pick.append(box);
    li.append(open, pick);
    return li;
  }

  /** the selection bar: compare 2-4, delete any */
  bar() {
    const n = this.sel.size;
    this.r.bar.hidden = n === 0;
    this.r.barText.textContent = n < 2 ? `${n} selected · pick another to compare` : `${n} selected`;
    this.r.compare.disabled = n < 2 || n > MAX;
    for (const box of this.r.list.querySelectorAll(".pick input")) box.disabled = !box.checked && n >= MAX;
  }
}
