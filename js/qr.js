/* QR codes for short text (a link): byte mode, error correction level M, the smallest version that fits.
 * Follows ISO/IEC 18004: Reed–Solomon over GF(256), interleaved blocks, all eight masks tried and the one
 * with the lowest penalty kept. Returns the modules as rows of booleans (true = dark), no quiet zone. */

// error correction level M, per version 1-40: ECC codewords per block, and number of blocks
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const LEVEL_M = 0; // format bits for level M

/** data modules in a symbol of this version, function patterns excluded */
function rawModules(v) {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const a = Math.floor(v / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (v) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v];

/* GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 */
function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function divisor(d) {
  const r = new Array(d).fill(0);
  r[d - 1] = 1;
  let root = 1;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      r[j] = mul(r[j], root);
      if (j + 1 < d) r[j] ^= r[j + 1];
    }
    root = mul(root, 2);
  }
  return r;
}
function remainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < div.length; i++) r[i] ^= mul(div[i], f);
  }
  return r;
}

/** split the data into blocks, add each block's ECC, interleave */
function withEcc(data, v) {
  const nb = BLOCKS[v], ecc = ECC_PER_BLOCK[v], raw = Math.floor(rawModules(v) / 8);
  const short = nb - (raw % nb), shortLen = Math.floor(raw / nb), div = divisor(ecc);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += d.length;
    const e = remainder(d, div);
    if (i < short) d.push(0); // placeholder, skipped when interleaving
    blocks.push(d.concat(e));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < nb; j++) if (i !== shortLen - ecc || j >= short) out.push(blocks[j][i]);
  }
  return out;
}

/** the codewords for `bytes` in byte mode, padded to the capacity of version v */
function codewords(bytes, v) {
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export function encode(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let v = 1;
  while (v <= 40 && 4 + (v < 10 ? 8 : 16) + 8 * bytes.length > dataCodewords(v) * 8) v++;
  if (v > 40) throw new RangeError("Too long for a QR code");
  const size = 4 * v + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };

  // timing, finders, alignment
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const align = [];
  if (v > 1) {
    const n = Math.floor(v / 7) + 2, step = Math.floor((v * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    align.push(6);
    for (let p = size - 7; align.length < n; p -= step) align.splice(1, 0, p);
  }
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    const last = align.length - 1;
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (mask) => {
    const d = (LEVEL_M << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((d << 10) | r) ^ 0x5412, bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0); // reserves the format areas; rewritten once the mask is chosen
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, on); set(b, a, on);
    }
  }

  // data, in the zigzag order
  const data = withEcc(codewords(bytes, v), v);
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fixed[y][x] && k < data.length * 8) { dark[y][x] = ((data[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }
  }

  const apply = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[m](x, y)) dark[y][x] = !dark[y][x]; };
  let best = 0, low = Infinity;
  for (let m = 0; m < 8; m++) {
    apply(m);
    format(m);
    const p = penalty(dark);
    if (p < low) { low = p; best = m; }
    apply(m); // masks are their own inverse
  }
  apply(best);
  format(best);
  return dark;
}

/** ISO/IEC 18004 mask penalty: runs, 2x2 blocks, finder look-alikes, dark balance */
function penalty(q) {
  const n = q.length;
  let p = 0, darkCount = 0;
  const line = (get) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) { run++; continue; }
        if (run >= 5) p += run - 2;
        run = 1;
      }
      for (let j = 0; j + 10 < n; j++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? 1 : 0)).join("");
        if (s === "10111010000" || s === "00001011101") p += 40;
      }
    }
  };
  line((i, j) => q[i][j]);
  line((i, j) => q[j][i]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (q[y][x]) darkCount++;
    if (x + 1 < n && y + 1 < n && q[y][x] === q[y][x + 1] && q[y][x] === q[y + 1][x] && q[y][x] === q[y + 1][x + 1]) p += 3;
  }
  const total = n * n;
  p += Math.ceil(Math.abs(darkCount * 20 - total * 10) / total - 1) * 10;
  return p;
}
