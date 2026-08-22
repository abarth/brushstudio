import { deflateSync } from 'node:zlib';

/**
 * Signal-processing primitives for texture-tip synthesis and spectral
 * audits: an FFT, radial spectra, the scatter kernel's characteristic
 * function, and a grayscale PNG writer. The math these implement is
 * docs/fractal-texture-math.md; nothing here touches the engine.
 */

/** Deterministic PRNG, same construction the engine uses. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, fed by a mulberry32. */
export function gaussians(rng) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const a = 2 * Math.PI * rng();
    spare = r * Math.sin(a);
    return r * Math.cos(a);
  };
}

/** In-place complex FFT, power-of-two length, iterative Cooley–Tukey. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 2-D FFT of an n×n complex field, in place (rows, then columns). */
export function fft2d(re, im, n, inverse = false) {
  const rr = new Float64Array(n);
  const ri = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const off = y * n;
    rr.set(re.subarray(off, off + n));
    ri.set(im.subarray(off, off + n));
    fft(rr, ri, inverse);
    re.set(rr, off);
    im.set(ri, off);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      rr[y] = re[y * n + x];
      ri[y] = im[y * n + x];
    }
    fft(rr, ri, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = rr[y];
      im[y * n + x] = ri[y];
    }
  }
}

/** Signed frequency of FFT bin i at length n, in cycles per sample. */
export const binFreq = (i, n) => (i <= n / 2 ? i : i - n) / n;

/** J₀ by quadrature — plenty accurate for the argument range Λ needs. */
export function besselJ0(v) {
  const steps = 160;
  let sum = 0;
  for (let k = 0; k < steps; k++) {
    const theta = ((k + 0.5) * Math.PI) / steps;
    sum += Math.cos(v * Math.sin(theta));
  }
  return sum / steps;
}

/**
 * Λ(u) = (1/u)·∫₀ᵘ J₀ — the characteristic function of the engine's
 * scatter draw (uniform distance × uniform angle) at u = 2π·f·S. Tabulated
 * once; beyond the table Λ ≈ 1/u and the transfer 1 − Λ² is ≈ 1 anyway.
 */
export function makeLambda(uMax = 64, du = 0.005) {
  const steps = Math.ceil(uMax / du);
  const cum = new Float64Array(steps + 1);
  let prev = besselJ0(0);
  for (let i = 1; i <= steps; i++) {
    const j = besselJ0(i * du);
    cum[i] = cum[i - 1] + ((prev + j) / 2) * du;
    prev = j;
  }
  return (u) => {
    if (u <= 1e-9) return 1;
    if (u >= uMax) return 1 / u;
    const x = u / du;
    const i = Math.floor(x);
    const c = cum[i] + (cum[i + 1] - cum[i]) * (x - i);
    return c / u;
  };
}

/**
 * Radially averaged power spectrum of an n×n real field, in log-spaced
 * bins. Returns cycles/sample bin centres and mean power per bin. The DC
 * bin and the field mean are excluded.
 */
export function radialSpectrum(field, n, bins = 48) {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let mean = 0;
  for (let i = 0; i < field.length; i++) mean += field[i];
  mean /= field.length;
  for (let i = 0; i < field.length; i++) re[i] = field[i] - mean;
  fft2d(re, im, n);
  const fMin = 1 / n;
  const fMax = 0.5 * Math.SQRT2;
  const logMin = Math.log(fMin);
  const span = Math.log(fMax) - logMin;
  const power = new Float64Array(bins);
  const count = new Float64Array(bins);
  for (let y = 0; y < n; y++) {
    const fy = binFreq(y, n);
    for (let x = 0; x < n; x++) {
      if (x === 0 && y === 0) continue;
      const fx = binFreq(x, n);
      const f = Math.hypot(fx, fy);
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((Math.log(f) - logMin) / span) * bins)));
      const i = y * n + x;
      power[b] += re[i] * re[i] + im[i] * im[i];
      count[b]++;
    }
  }
  const freq = [];
  const mag = [];
  for (let b = 0; b < bins; b++) {
    if (!count[b]) continue;
    freq.push(Math.exp(logMin + span * ((b + 0.5) / bins)));
    mag.push(power[b] / count[b]);
  }
  return { freq, power: mag };
}

/**
 * Periodic cellular (Worley) noise: one jittered feature point per cell,
 * returning the nearest two distances and the nearest cell's random value —
 * the same construction as src/brush/organicTips.ts, here for the field
 * generators that need angular structure a Gaussian field cannot make.
 */
export function makeWorley(rng, cells) {
  const jitter = new Float64Array(cells * cells * 2);
  const value = new Float64Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    jitter[i * 2] = rng();
    jitter[i * 2 + 1] = rng();
    value[i] = rng();
  }
  return { cells, jitter, value };
}

export function worley(w, u, v) {
  const n = w.cells;
  const px = u * n;
  const py = v * n;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let f1 = 1e9;
  let f2 = 1e9;
  let nearest = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const cx = ix + di;
      const cy = iy + dj;
      let wx = cx % n;
      let wy = cy % n;
      if (wx < 0) wx += n;
      if (wy < 0) wy += n;
      const k = wy * n + wx;
      const fx = cx + w.jitter[k * 2];
      const fy = cy + w.jitter[k * 2 + 1];
      const d = Math.sqrt((px - fx) * (px - fx) + (py - fy) * (py - fy));
      if (d < f1) {
        f2 = f1;
        f1 = d;
        nearest = k;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, v: w.value[nearest] };
}

// --- grayscale PNG -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit grayscale, non-interlaced — what src/node/png.ts reads back. */
export function encodeGrayPng(data, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
