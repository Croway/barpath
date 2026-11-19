/* Keeping only part of a saved video, losslessly: the samples (encoded frames, audio packets) of the part are copied
 * byte for byte into a new MP4; nothing is decoded or encoded, so it's quick on a phone and the frames are the same.
 *
 * Reads a regular MP4/MOV (the camera app, a picked file: sample tables in moov) or a fragmented one (the in-app
 * camera's MediaRecorder: moof/trun), writes a regular MP4 (ftyp, moov, mdat). The new file's bytes are slices of
 * the old Blob, so nothing big is held in memory.
 *
 * A video can only start on a keyframe: the kept part starts at the last keyframe at or before `from` (phones put
 * one every ~1 s). It ends with the last frame shown at or before `to` (cut in decode order, so every kept frame
 * still decodes). Every kept frame keeps its place in time: its new time is its old time minus `offset`, the same
 * for every frame, so data timed against the old video (tracked samples, the analysed part) shifts by `offset`.
 * Other tracks (audio, metadata) keep their samples within the kept frames' times.
 *
 *   const r = await trimVideo(blob, from, to)  // to: null = the video's end
 *   r.blob, r.offset (s), r.start / r.end (the kept part, old times), r.before / r.after (bytes)
 *
 * Errors carry .code: "format" (not an MP4, e.g. WebM), "video" (no video track), "nothing" (nothing to cut).
 * Shared with Kip Lab: identical. */

const fail = (code, msg) => Object.assign(new Error(msg), { code });
const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

/** the boxes inside dv between start and end */
function* boxes(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p), hdr = 8;
    const type = fourcc(dv, p + 4);
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) throw fail("format", `bad ${type} box`);
    yield { type, start: p, end: p + size, body: p + hdr };
    p += size;
  }
}
const child = (dv, b, type) => { for (const c of boxes(dv, b.body, b.end)) if (c.type === type) return c; return null; };
const kids = (dv, b, type) => [...boxes(dv, b.body, b.end)].filter((c) => c.type === type);

/** the file's top-level boxes, reading only their headers */
async function topBoxes(blob) {
  const out = [];
  let p = 0;
  while (p + 8 <= blob.size) {
    const dv = new DataView(await blob.slice(p, p + 16).arrayBuffer());
    let size = dv.getUint32(0), hdr = 8;
    const type = fourcc(dv, 4);
    if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; } else if (size === 0) size = blob.size - p;
    if (size < hdr) throw fail("format", "not an MP4");
    out.push({ type, start: p, size, hdr });
    p += size;
  }
  return out;
}
const read = async (blob, b) => new DataView(await blob.slice(b.start, b.start + b.size).arrayBuffer());

/* ------------------------------------------------------------------ reading */
/** a track: its boxes to copy, timescale, edit, and samples { off, size, dts, dur, cto, sync } in decode order */
function readTrak(dv, trak) {
  const tkhd = child(dv, trak, "tkhd"), mdia = child(dv, trak, "mdia");
  const mdhd = mdia && child(dv, mdia, "mdhd"), hdlr = mdia && child(dv, mdia, "hdlr"), minf = mdia && child(dv, mdia, "minf");
  if (!tkhd || !mdhd || !hdlr || !minf) throw fail("format", "incomplete track");
  const v = dv.getUint8(tkhd.body);
  const id = dv.getUint32(tkhd.body + 4 + (v ? 16 : 8));
  const mv = dv.getUint8(mdhd.body), timescale = dv.getUint32(mdhd.body + 4 + (mv ? 16 : 8));
  const handler = fourcc(dv, hdlr.body + 8);
  // the edit: media time of the first edit that shows media (−1 = an empty edit, a delay before it)
  let mediaTime = 0, empty = 0;
  const elst = child(dv, trak, "edts") && child(dv, child(dv, trak, "edts"), "elst");
  if (elst) {
    const ev = dv.getUint8(elst.body), n = dv.getUint32(elst.body + 4);
    let p = elst.body + 8;
    for (let i = 0; i < n; i++) {
      const dur = ev ? Number(dv.getBigUint64(p)) : dv.getUint32(p), mt = ev ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
      p += ev ? 20 : 12;
      if (mt === -1) { empty += dur; continue; }
      mediaTime = mt;
      break;
    }
  }
  return { id, handler, timescale, mediaTime, empty, tkhd, mdia, mdhd, hdlr, minf, stbl: child(dv, minf, "stbl"), samples: [] };
}

/** the samples of a regular track, from its sample tables */
function tableSamples(dv, t) {
  const s = t.stbl;
  if (!s) throw fail("format", "no sample table");
  const get = (type) => child(dv, s, type);
  const stsz = get("stsz"), stts = get("stts"), stsc = get("stsc"), stco = get("stco"), co64 = get("co64");
  if (!stsz || !stts || !stsc || !(stco || co64)) throw fail("format", "missing sample tables");
  const n = dv.getUint32(stsz.body + 8), fixed = dv.getUint32(stsz.body + 4);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { size: fixed || dv.getUint32(stsz.body + 12 + 4 * i), dts: 0, dur: 0, cto: 0, sync: true, off: 0 };
  // times
  let i = 0, dts = 0;
  for (let e = 0, m = dv.getUint32(stts.body + 4); e < m; e++) {
    const count = dv.getUint32(stts.body + 8 + 8 * e), delta = dv.getUint32(stts.body + 12 + 8 * e);
    for (let k = 0; k < count && i < n; k++, i++) { out[i].dts = dts; out[i].dur = delta; dts += delta; }
  }
  const ctts = get("ctts");
  if (ctts) {
    const cv = dv.getUint8(ctts.body);
    i = 0;
    for (let e = 0, m = dv.getUint32(ctts.body + 4); e < m; e++) {
      const count = dv.getUint32(ctts.body + 8 + 8 * e), o = cv ? dv.getInt32(ctts.body + 12 + 8 * e) : dv.getUint32(ctts.body + 12 + 8 * e);
      for (let k = 0; k < count && i < n; k++, i++) out[i].cto = o;
    }
  }
  const stss = get("stss");
  if (stss) {
    for (const x of out) x.sync = false;
    for (let e = 0, m = dv.getUint32(stss.body + 4); e < m; e++) { const k = dv.getUint32(stss.body + 8 + 4 * e) - 1; if (out[k]) out[k].sync = true; }
  }
  // where each sample is: chunks (stco/co64), samples per chunk (stsc)
  const nChunks = dv.getUint32((stco || co64).body + 4);
  const chunk = (c) => (stco ? dv.getUint32(stco.body + 8 + 4 * c) : Number(dv.getBigUint64(co64.body + 8 + 8 * c)));
  const runs = [];
  for (let e = 0, m = dv.getUint32(stsc.body + 4); e < m; e++) runs.push({ first: dv.getUint32(stsc.body + 8 + 12 * e) - 1, per: dv.getUint32(stsc.body + 12 + 12 * e), sdi: dv.getUint32(stsc.body + 16 + 12 * e) });
  i = 0;
  for (let r = 0; r < runs.length; r++) {
    const last = r + 1 < runs.length ? runs[r + 1].first : nChunks;
    for (let c = runs[r].first; c < last && i < n; c++) {
      let off = chunk(c);
      for (let k = 0; k < runs[r].per && i < n; k++, i++) { out[i].off = off; out[i].sdi = runs[r].sdi; off += out[i].size; }
    }
  }
  return out;
}

/** the samples of a fragmented file, from its movie fragments (moof: tfhd, tfdt, trun) */
async function fragmentSamples(blob, tops, tracks, trex) {
  const next = new Map(tracks.map((t) => [t.id, 0])); // each track's decode time after its last fragment
  for (const top of tops) {
    if (top.type !== "moof") continue;
    const dv = await read(blob, top), moof = { body: top.hdr, end: top.size };
    for (const traf of kids(dv, moof, "traf")) {
      const tfhd = child(dv, traf, "tfhd");
      if (!tfhd) continue;
      const f = dv.getUint32(tfhd.body) & 0xffffff, id = dv.getUint32(tfhd.body + 4), t = tracks.find((x) => x.id === id);
      if (!t) continue;
      const d = trex.get(id) || { sdi: 1, dur: 0, size: 0, flags: 0 };
      let p = tfhd.body + 8, base = top.start;
      if (f & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
      let sdi = d.sdi, dur = d.dur, size = d.size, flags = d.flags;
      if (f & 0x2) { sdi = dv.getUint32(p); p += 4; }
      if (f & 0x8) { dur = dv.getUint32(p); p += 4; }
      if (f & 0x10) { size = dv.getUint32(p); p += 4; }
      if (f & 0x20) { flags = dv.getUint32(p); p += 4; }
      const tfdt = child(dv, traf, "tfdt");
      let dts = tfdt ? (dv.getUint8(tfdt.body) ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4)) : next.get(id);
      let dataEnd = base;
      for (const trun of kids(dv, traf, "trun")) {
        const tv = dv.getUint8(trun.body), tf = dv.getUint32(trun.body) & 0xffffff, n = dv.getUint32(trun.body + 4);
        let q = trun.body + 8, off = dataEnd, first = null;
        if (tf & 0x1) { off = base + dv.getInt32(q); q += 4; }
        if (tf & 0x4) { first = dv.getUint32(q); q += 4; }
        for (let k = 0; k < n; k++) {
          const s = { dur, size, cto: 0, sdi, off, dts };
          let fl = k === 0 && first !== null ? first : flags;
          if (tf & 0x100) { s.dur = dv.getUint32(q); q += 4; }
          if (tf & 0x200) { s.size = dv.getUint32(q); q += 4; }
          if (tf & 0x400) { fl = dv.getUint32(q); q += 4; }
          if (tf & 0x800) { s.cto = tv ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
          s.sync = !(fl & 0x10000);
          t.samples.push(s);
          off += s.size; dts += s.dur;
        }
        dataEnd = off;
      }
      next.set(id, dts);
    }
  }
}

/* ------------------------------------------------------------------ writing */
const u8 = (...a) => Uint8Array.from(a);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const i32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const cc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function cat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...parts) => { const body = cat(parts); return cat([u32(8 + body.length), cc(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const copy = (dv, b) => new Uint8Array(dv.buffer, dv.byteOffset + b.start, b.end - b.start).slice();

/** a copy of a tkhd/mdhd/mvhd with its duration replaced */
function withDuration(dv, b, dur, at) {
  const out = copy(dv, b), v = out[b.body - b.start], o = new DataView(out.buffer), p = b.body - b.start + 4 + at(v);
  if (v) o.setBigUint64(p, BigInt(Math.round(dur))); else o.setUint32(p, Math.min(0xffffffff, Math.round(dur)));
  return out;
}
const MVHD = (v) => (v ? 20 : 12), MDHD = (v) => (v ? 20 : 12), TKHD = (v) => (v ? 24 : 16);

function stbl(dv, t, kept, offsets) {
  const n = kept.length, runs = (vals) => { const r = []; for (const v of vals) { if (r.length && r[r.length - 1][1] === v) r[r.length - 1][0]++; else r.push([1, v]); } return r; };
  const stts = runs(kept.map((s) => s.dur));
  const parts = [copy(dv, child(dv, t.stbl, "stsd")), full("stts", 0, 0, u32(stts.length), ...stts.flatMap(([c, d]) => [u32(c), u32(d)]))];
  if (kept.some((s) => s.cto)) {
    const neg = kept.some((s) => s.cto < 0), ct = runs(kept.map((s) => s.cto));
    parts.push(full("ctts", neg ? 1 : 0, 0, u32(ct.length), ...ct.flatMap(([c, o]) => [u32(c), neg ? i32(o) : u32(o)])));
  }
  if (!kept.every((s) => s.sync)) {
    const sync = kept.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
    parts.push(full("stss", 0, 0, u32(sync.length), ...sync.map(u32)));
  }
  // one sample per chunk: the samples go where the copy puts them
  const sdi = runs(kept.map((s) => s.sdi || 1));
  let first = 1;
  const stsc = sdi.map(([c, d]) => { const e = [u32(first), u32(1), u32(d)]; first += c; return e; });
  parts.push(full("stsc", 0, 0, u32(stsc.length), ...stsc.flat()));
  parts.push(full("stsz", 0, 0, u32(0), u32(n), ...kept.map((s) => u32(s.size))));
  const big = offsets.some((o) => o > 0xffffffff);
  parts.push(big ? full("co64", 0, 0, u32(n), ...offsets.map(u64)) : full("stco", 0, 0, u32(n), ...offsets.map(u32)));
  return box("stbl", ...parts);
}

/* ------------------------------------------------------------------ the cut */
export async function trimVideo(blob, from, to = null) {
  const tops = await topBoxes(blob);
  const moovTop = tops.find((b) => b.type === "moov"), ftypTop = tops.find((b) => b.type === "ftyp");
  if (!moovTop) throw fail("format", "no moov");
  const dv = await read(blob, moovTop), moov = { body: moovTop.hdr, end: moovTop.size };
  const mvhd = child(dv, moov, "mvhd");
  if (!mvhd) throw fail("format", "no mvhd");
  const movieScale = dv.getUint32(mvhd.body + 4 + (dv.getUint8(mvhd.body) ? 16 : 8));
  const tracks = kids(dv, moov, "trak").map((b) => readTrak(dv, b));
  const mvex = child(dv, moov, "mvex");
  if (mvex) {
    const trex = new Map();
    for (const x of kids(dv, mvex, "trex")) trex.set(dv.getUint32(x.body + 4), { sdi: dv.getUint32(x.body + 8), dur: dv.getUint32(x.body + 12), size: dv.getUint32(x.body + 16), flags: dv.getUint32(x.body + 20) });
    for (const t of tracks) if (t.stbl) t.samples.push(...tableSamples(dv, t).filter((s) => s.size)); // a fragmented file's moov is usually empty
    await fragmentSamples(blob, tops, tracks, trex);
    // players read fragmented files without their edit lists (FFmpeg's demuxer, which Chrome plays files with)
    for (const t of tracks) { t.mediaTime = 0; t.empty = 0; }
  } else {
    for (const t of tracks) t.samples = tableSamples(dv, t);
  }
  const vid = tracks.find((t) => t.handler === "vide" && t.samples.length);
  if (!vid) throw fail("video", "no video track");

  // the video's frames on the old timeline (seconds), as players show them
  const ptsOf = (t, s) => (s.dts + s.cto - t.mediaTime) / t.timescale + t.empty / movieScale;
  const V = vid.samples;
  const fromT = Math.max(0, from || 0), toT = to === null || to === undefined ? Infinity : to;
  let k = 0;
  for (let i = 0; i < V.length; i++) if (V[i].sync && ptsOf(vid, V[i]) <= fromT + 1e-6) k = i;
  let j = k;
  for (let i = k; i < V.length; i++) if (ptsOf(vid, V[i]) <= toT + 1e-6) j = i;
  if (k === 0 && j === V.length - 1) throw fail("nothing", "nothing to cut");
  const keptV = V.slice(k, j + 1);
  // the part starts at the keyframe. (Frames decoded after it but shown before it, an open GOP's leading frames,
  // may need the cut-off part to decode: the edit below starts the new video at the keyframe, so they're not shown.)
  const start = ptsOf(vid, keptV[0]);
  const shown = keptV.map((s) => ptsOf(vid, s)).filter((p) => p >= start - 1e-9);
  const end = Math.max(...shown) + keptV[keptV.length - 1].dur / vid.timescale;

  // new times: the keyframe decodes at 0; an edit takes out its reorder delay (B-frames), so it's shown at 0 too.
  // old shown time − offset = new shown time, for every frame.
  const d0 = keptV[0].dts, newMediaTime = Math.max(0, keptV[0].cto);
  const offset = (d0 - vid.mediaTime + newMediaTime) / vid.timescale + vid.empty / movieScale;
  const span = Math.max(...keptV.map((s) => s.dts - d0 + s.cto + s.dur)) - newMediaTime; // what the edit shows
  const kept = new Map([[vid, keptV.map((s) => ({ ...s, dts: s.dts - d0 }))]]);
  for (const t of tracks) {
    if (t === vid) continue;
    const ks = t.samples.filter((s) => { const p = ptsOf(t, s); return p >= start - 1e-6 && p < end - 1e-6; });
    if (ks.length) kept.set(t, ks.map((s) => ({ ...s, dts: s.dts - ks[0].dts })));
  }

  // where the samples go: in the old file's order (keeps audio and video interleaved), runs of adjacent bytes as one
  // slice of the old Blob
  const all = [];
  for (const [t, ks] of kept) for (const s of ks) all.push({ t, s });
  all.sort((a, b) => a.s.off - b.s.off);
  const ftyp = ftypTop && !mvex ? copy(await read(blob, ftypTop), { start: 0, end: ftypTop.size }) : box("ftyp", cc("isom"), u32(512), cc("isom"), cc("iso2"), cc("avc1"), cc("mp41"));

  const build = (dataStart) => {
    let o = dataStart;
    for (const a of all) { a.s.newOff = o; o += a.s.size; }
    let movieDur = 0;
    const traks = [];
    for (const [t, ks] of kept) {
      const mediaDur = ks.reduce((a, s) => a + s.dur, 0), trackDur = (mediaDur * movieScale) / t.timescale;
      movieDur = Math.max(movieDur, trackDur);
      const minfParts = [...boxes(dv, t.minf.body, t.minf.end)].filter((c) => c.type !== "stbl").map((c) => copy(dv, c));
      const mdiaParts = [...boxes(dv, t.mdia.body, t.mdia.end)].filter((c) => !["mdhd", "minf"].includes(c.type)).map((c) => copy(dv, c));
      const edit = t === vid && newMediaTime > 0
        ? [box("edts", full("elst", 0, 0, u32(1), u32(Math.round((span * movieScale) / t.timescale)), i32(newMediaTime), u32(0x10000)))]
        : [];
      traks.push(box("trak", withDuration(dv, t.tkhd, trackDur, TKHD), ...edit,
        box("mdia", withDuration(dv, t.mdhd, mediaDur, MDHD), ...mdiaParts, box("minf", ...minfParts, stbl(dv, t, ks, ks.map((s) => s.newOff))))));
    }
    const rest = [...boxes(dv, moov.body, moov.end)].filter((c) => !["mvhd", "trak", "mvex"].includes(c.type)).map((c) => copy(dv, c));
    return box("moov", withDuration(dv, mvhd, movieDur, MVHD), ...traks, ...rest);
  };
  const dataBytes = all.reduce((a, x) => a + x.s.size, 0), mdatHdr = dataBytes + 8 > 0xffffffff ? 16 : 8;
  let moovOut = build(ftyp.length + 8 + mdatHdr);
  moovOut = build(ftyp.length + moovOut.length + mdatHdr); // the offsets only change the moov's size by co64 vs stco
  const slices = [];
  for (const a of all) {
    const prev = slices[slices.length - 1];
    if (prev && prev.end === a.s.off) prev.end += a.s.size; else slices.push({ start: a.s.off, end: a.s.off + a.s.size });
  }
  const mdat = mdatHdr === 8 ? cat([u32(dataBytes + 8), cc("mdat")]) : cat([u32(1), cc("mdat"), u64(dataBytes + 16)]);
  const out = new Blob([ftyp, moovOut, mdat, ...slices.map((s) => blob.slice(s.start, s.end))], { type: "video/mp4" });
  return { blob: out, offset, start, end, before: blob.size, after: out.size };
}
