/* The gallery's storage, on this device only (IndexedDB): every analysed lift is kept so it can be reopened and
 * compared. Three stores, so the list stays light:
 *   lifts   the card: id, filmed / saved times, name, title, lift, headline numbers, thumbnail (Blob)
 *   data    what analyse() needs to run again: samples, plate, the part, settings, frame rate
 *   videos  the video file itself (Blob), only read when the lift is opened or compared */
const NAME = "barpath", VERSION = 1, STORES = ["lifts", "data", "videos"];
let opening = null;

function db() {
  opening ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: "id" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = null; reject(r.error); };
  });
  return opening;
}
/** run fn(stores) in one transaction; resolves with what fn returned (requests become their results) once it commits */
async function tx(names, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(names, mode);
    const out = fn(Object.fromEntries(names.map((n) => [n, t.objectStore(n)])));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : Array.isArray(out) ? out.map((q) => q?.result) : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage full or unavailable"));
  });
}

export const available = () => typeof indexedDB !== "undefined";
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** every lift's card, the most recently filmed first */
export async function list() {
  const all = await tx(["lifts"], "readonly", (s) => s.lifts.getAll());
  return all.sort((a, b) => b.filmed - a.filmed || b.saved - a.saved);
}
/** save a lift: card and data always, the video only when given (it never changes for an id) */
export function put(card, data, video) {
  return tx(video ? STORES : ["lifts", "data"], "readwrite", (s) => {
    s.lifts.put(card);
    s.data.put({ ...data, id: card.id });
    if (video) s.videos.put({ id: card.id, blob: video });
  });
}
/** merge changes into a saved lift's card and data (the lift picked, plate size, …) */
export function update(id, card, data) {
  return tx(["lifts", "data"], "readwrite", (s) => {
    const a = s.lifts.get(id), b = s.data.get(id);
    a.onsuccess = () => a.result && s.lifts.put({ ...a.result, ...card });
    b.onsuccess = () => b.result && s.data.put({ ...b.result, ...data });
  });
}
export async function get(id) {
  const [card, data, video] = await tx(STORES, "readonly", (s) => [s.lifts.get(id), s.data.get(id), s.videos.get(id)]);
  return card && data && video ? { card, data, video: video.blob } : null;
}
export function remove(ids) {
  return tx(STORES, "readwrite", (s) => { for (const id of [].concat(ids)) for (const n of STORES) s[n].delete(id); });
}
/** bytes used on this device, when the browser says */
export async function usage() {
  try { return (await navigator.storage.estimate()).usage ?? null; } catch { return null; }
}
