/**
 * The blend, texture and merge maths from `gpu/shaders.ts`, in TypeScript.
 *
 * This is a deliberate transliteration rather than a reimplementation: every
 * function below is the WGSL one with the same name, same branches, same
 * constants. When the two disagree the shader is right — it is the one that
 * paints what a human sees in the app — so keep them line-comparable, and
 * check with `npm test -- --parity` after changing either.
 */

export type RGB = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// --- separable modes -------------------------------------------------------

const scr = (b: number, s: number) => b + s - b * s;

const hardLightC = (b: number, s: number) => (s <= 0.5 ? b * (2 * s) : scr(b, 2 * s - 1));

function dodgeC(b: number, s: number): number {
  if (b <= 0) return 0;
  if (s >= 1) return 1;
  return Math.min(1, b / (1 - s));
}

function burnC(b: number, s: number): number {
  if (b >= 1) return 1;
  if (s <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
}

function softLightC(b: number, s: number): number {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
}

const vividC = (b: number, s: number) => (s <= 0.5 ? burnC(b, 2 * s) : dodgeC(b, 2 * s - 1));

const pinC = (b: number, s: number) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1));

const divideC = (b: number, s: number) => (s <= 0 ? 1 : Math.min(1, b / s));

// --- non-separable modes ---------------------------------------------------

const lum = (c: RGB) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;

function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out = c;
  if (n < 0) {
    const k = l / Math.max(l - n, 1e-6);
    out = [l + (out[0] - l) * k, l + (out[1] - l) * k, l + (out[2] - l) * k];
  }
  if (x > 1) {
    const k = (1 - l) / Math.max(x - l, 1e-6);
    out = [l + (out[0] - l) * k, l + (out[1] - l) * k, l + (out[2] - l) * k];
  }
  return out;
}

function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

const satOf = (c: RGB) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: RGB, s: number): RGB {
  const mn = Math.min(c[0], c[1], c[2]);
  const mx = Math.max(c[0], c[1], c[2]);
  if (mx > mn) {
    const k = s / (mx - mn);
    return [(c[0] - mn) * k, (c[1] - mn) * k, (c[2] - mn) * k];
  }
  return [0, 0, 0];
}

/** Order matches BLEND_MODE_INDEX and the switch in blendPixel's WGSL twin. */
export function blendPixel(mode: number, b: RGB, s: RGB): RGB {
  const each = (f: (bx: number, sx: number) => number): RGB => [
    f(b[0], s[0]),
    f(b[1], s[1]),
    f(b[2], s[2]),
  ];
  switch (mode) {
    case 1:
      return each(Math.min);
    case 2:
      return each((bx, sx) => bx * sx);
    case 3:
      return each(burnC);
    case 4:
      return each((bx, sx) => clamp01(bx + sx - 1));
    case 5:
      return each(Math.max);
    case 6:
      return each(scr);
    case 7:
      return each(dodgeC);
    case 8:
      return each((bx, sx) => Math.min(bx + sx, 1));
    case 9:
      return each((bx, sx) => hardLightC(sx, bx)); // overlay
    case 10:
      return each(softLightC);
    case 11:
      return each(hardLightC);
    case 12:
      return each(vividC);
    case 13:
      return each((bx, sx) => clamp01(bx + 2 * sx - 1));
    case 14:
      return each(pinC);
    case 15:
      return each((bx, sx) => Math.abs(bx - sx));
    case 16:
      return each((bx, sx) => bx + sx - 2 * bx * sx);
    case 17:
      return each((bx, sx) => Math.max(bx - sx, 0));
    case 18:
      return each(divideC);
    case 19:
      return setLum(setSat(s, satOf(b)), lum(b));
    case 20:
      return setLum(setSat(b, satOf(s)), lum(b));
    case 21:
      return setLum(s, lum(b));
    case 22:
      return setLum(b, lum(s));
    default:
      return s; // normal
  }
}

/** Straight source over a premultiplied backdrop; returns premultiplied. */
export function compositePixel(
  dst: Float64Array,
  cs: RGB,
  sa: number,
  mode: number,
  out: Float64Array,
): void {
  const ab = dst[3];
  const cb: RGB = ab > 0 ? [dst[0] / ab, dst[1] / ab, dst[2] / ab] : [0, 0, 0];
  const bl = mode === 0 ? cs : blendPixel(mode, cb, cs);
  const k0 = sa * (1 - ab);
  const k1 = sa * ab;
  const k2 = 1 - sa;
  out[0] = k0 * cs[0] + k1 * bl[0] + k2 * dst[0];
  out[1] = k0 * cs[1] + k1 * bl[1] + k2 * dst[1];
  out[2] = k0 * cs[2] + k1 * bl[2] + k2 * dst[2];
  out[3] = sa + ab * (1 - sa);
}

// --- texture / dual gate ---------------------------------------------------

/** brightness, contrast, invert, depth — the shader's `bci` vector. */
export interface TexBCI {
  brightness: number;
  contrast: number;
  invert: boolean;
  depth: number;
}

export function texValue(raw: number, bci: TexBCI): number {
  let v = raw + bci.brightness;
  v = (v - 0.5) * (1 + bci.contrast * 2) + 0.5;
  if (bci.invert) v = 1 - v;
  return clamp01(v);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Photoshop's texture modes acting on brush coverage. */
export function applyTexToAlpha(a: number, v: number, mode: number, depth: number): number {
  switch (mode) {
    case 0:
      return a * mix(1, v, depth);
    case 1:
      return clamp01(a - (1 - v) * depth);
    case 2:
      return Math.min(a, mix(1, v, depth));
    case 3: {
      const o = a <= 0.5 ? 2 * a * v : 1 - 2 * (1 - a) * (1 - v);
      return mix(a, clamp01(o), depth);
    }
    case 4:
      return clamp01(a - (1 - v) * depth * 1.5);
    case 5:
      return mix(a, Math.max(a, v), depth);
    case 6:
      return mix(a, a + v - a * v, depth);
    case 7: {
      const o = a <= 0 ? 0 : v >= 1 ? 1 : Math.min(1, a / (1 - v));
      return mix(a, o, depth);
    }
    case 8: {
      const o = a >= 1 ? 1 : v <= 0 ? 0 : 1 - Math.min(1, (1 - a) / v);
      return mix(a, o, depth);
    }
    case 9:
      return mix(a, clamp01(a + v - 1), depth);
    case 10:
      return mix(a, a + v >= 1 ? 1 : 0, depth);
    default:
      return a;
  }
}

/**
 * The Dual Brush gate: applied once to the stroke's accumulated coverage,
 * never per dab. Two guards, as in the shader — the stroke must never escape
 * the train's marks, and where the stroke has no coverage nothing paints.
 */
export function applyDualToAlpha(a: number, v: number, mode: number): number {
  if (a <= 0) return 0;
  if (mode === 8 && v <= 0) return 0;
  return applyTexToAlpha(a, v, mode, 1);
}

/** Wet edges: the interior settles at ~60% while the rim stays strong. */
export const wetRemap = (a: number) => clamp01(0.6 * a + 0.4 * Math.sin(Math.PI * a));

/**
 * The shader's `hash21`, evaluated in 32-bit steps.
 *
 * WGSL runs this in f32 and JavaScript in f64, and `fract(sin(x) * 43758)`
 * is chaotic enough that the difference is the whole value. Rounding each
 * step to f32 gets the two close but not identical, so a noise brush is the
 * one place the renderers visibly disagree — see docs/backends.md.
 */
export function hash21(x: number, y: number): number {
  const f = Math.fround;
  const d = f(f(x * 12.9898) + f(y * 78.233));
  const s = f(Math.sin(d));
  const v = f(s * 43758.5453);
  return v - Math.floor(v);
}
