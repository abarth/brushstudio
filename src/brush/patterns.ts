import { ORGANIC_PATTERNS, ORGANIC_TIPS } from './organicTips';
import type { PatternId, TipShape } from './types';

/**
 * Procedural, tileable grayscale patterns (for the Texture section) and
 * sampled-style brush tip alpha maps (chalk/spatter/grain). Everything is
 * generated deterministically from fixed seeds so rendering is reproducible.
 */

export interface GrayMap {
  size: number;
  /** size*size bytes, 0..255 */
  data: Uint8Array<ArrayBuffer>;
}

/** Deterministic PRNG, exported for previews and tests. */
export function seededRng(seed: number): () => number {
  return mulberry32(seed);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Periodic (tileable) value noise on a `cells`-wide lattice. */
function noiseLattice(cells: number, rng: () => number): number[] {
  const g: number[] = [];
  for (let i = 0; i < cells * cells; i++) g.push(rng());
  return g;
}

function sampleLattice(g: number[], cells: number, u: number, v: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x) % cells;
  const y0 = Math.floor(y) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const fx = smooth(x - Math.floor(x));
  const fy = smooth(y - Math.floor(y));
  const a = g[y0 * cells + x0];
  const b = g[y0 * cells + x1];
  const c = g[y1 * cells + x0];
  const d = g[y1 * cells + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Tileable fractal noise in [0,1]. */
function fractal(size: number, seed: number, octaves: number, baseCells: number): Float32Array {
  const rng = mulberry32(seed);
  const layers: { g: number[]; cells: number; amp: number }[] = [];
  let amp = 1;
  let cells = baseCells;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ g: noiseLattice(cells, rng), cells, amp });
    total += amp;
    amp *= 0.55;
    cells *= 2;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const l of layers) v += sampleLattice(l.g, l.cells, x / size, y / size) * l.amp;
      out[y * size + x] = v / total;
    }
  }
  return out;
}

function toBytes(f: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(clamp01(f[i]) * 255);
  return out;
}

// ---------------------------------------------------------------------------
// Patterns (256x256, tileable). Value 1 = full paint, 0 = fully carved.
// ---------------------------------------------------------------------------

const PATTERN_SIZE = 256;

function makePattern(id: PatternId): GrayMap {
  // organic patterns are generated at their own, larger sizes
  const organic = ORGANIC_PATTERNS[id];
  if (organic) return organic();

  const size = PATTERN_SIZE;
  const out = new Float32Array(size * size);

  switch (id) {
    case 'paper': {
      const coarse = fractal(size, 101, 4, 4);
      const fine = fractal(size, 102, 2, 32);
      for (let i = 0; i < out.length; i++) {
        out[i] = 0.55 + (coarse[i] - 0.5) * 0.55 + (fine[i] - 0.5) * 0.45;
      }
      break;
    }
    case 'canvas': {
      const n = fractal(size, 201, 3, 8);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const wx = 0.5 + 0.5 * Math.sin((x / size) * Math.PI * 2 * 16);
          const wy = 0.5 + 0.5 * Math.sin((y / size) * Math.PI * 2 * 16 + Math.PI / 2);
          const weave = Math.max(wx, wy) * 0.6 + 0.25;
          out[y * size + x] = weave + (n[y * size + x] - 0.5) * 0.35;
        }
      }
      break;
    }
    case 'sponge': {
      // irregular holes: darker where the fractal dips
      const n = fractal(size, 301, 4, 6);
      for (let i = 0; i < out.length; i++) {
        const t = smooth(clamp01((n[i] - 0.38) / 0.3));
        out[i] = 0.15 + 0.85 * t;
      }
      break;
    }
    case 'clouds': {
      const n = fractal(size, 401, 5, 4);
      for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + (n[i] - 0.5) * 1.6);
      break;
    }
    case 'speckle': {
      out.fill(0.95);
      const rng = mulberry32(501);
      for (let k = 0; k < 900; k++) {
        const cx = rng() * size;
        const cy = rng() * size;
        const r = 1 + rng() * 3;
        const depth = 0.5 + rng() * 0.5;
        const ri = Math.ceil(r + 1);
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > r + 1) continue;
            const x = (Math.round(cx + dx) + size) % size;
            const y = (Math.round(cy + dy) + size) % size;
            const fall = clamp01(1 - d / r);
            const i = y * size + x;
            out[i] = Math.min(out[i], 0.95 - depth * fall);
          }
        }
      }
      break;
    }
  }
  return { size, data: toBytes(out) };
}

// ---------------------------------------------------------------------------
// Tip shapes (128x128 alpha maps, transparent border)
// ---------------------------------------------------------------------------

const TIP_SIZE = 128;

function makeTip(shape: TipShape): GrayMap {
  // the organic Oil & Fresco tips are much larger than the 128px built-ins
  const organic = ORGANIC_TIPS[shape];
  if (organic) return organic();

  const size = TIP_SIZE;
  const out = new Float32Array(size * size);
  const cx = size / 2;
  const r = size / 2 - 2;

  const circle = (x: number, y: number, soft = 0.06) => {
    const d = Math.hypot(x - cx, y - cx) / r;
    return clamp01((1 - d) / soft);
  };

  switch (shape) {
    case 'round': {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) out[y * size + x] = circle(x, y);
      break;
    }
    case 'chalk': {
      // grainy, torn-edged disc
      const n = fractal(size, 601, 4, 8);
      const g = fractal(size, 602, 2, 32);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const edge = circle(x, y, 0.35); // wide soft rim to modulate
          const tear = clamp01((n[i] - 0.25) * 2.2);
          const grain = 0.55 + g[i] * 0.65;
          out[i] = clamp01(edge * tear * grain * 1.35);
        }
      }
      break;
    }
    case 'spatter': {
      // many droplets inside the tip radius
      const rng = mulberry32(701);
      for (let k = 0; k < 170; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * r * 0.92;
        const bx = cx + Math.cos(ang) * rad;
        const by = cx + Math.sin(ang) * rad;
        const br = 1.5 + rng() * rng() * 9;
        const a = 0.45 + rng() * 0.55;
        const ri = Math.ceil(br + 1);
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            const x = Math.round(bx + dx);
            const y = Math.round(by + dy);
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const d = Math.hypot(dx, dy);
            const fall = clamp01((br - d) / 1.5);
            const i = y * size + x;
            out[i] = Math.max(out[i], a * fall);
          }
        }
      }
      break;
    }
    case 'grain': {
      const g = fractal(size, 801, 3, 24);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const body = circle(x, y, 0.25);
          const speck = clamp01((g[i] - 0.35) * 2.8);
          out[i] = clamp01(body * speck * 1.2);
        }
      }
      break;
    }
  }
  return { size, data: toBytes(out) };
}

const patternCache = new Map<PatternId, GrayMap>();
const tipCache = new Map<TipShape, GrayMap>();
/** Sampled tips registered at runtime (e.g. imported from .abr files). */
const registeredTips = new Map<string, GrayMap>();
/** Patterns registered at runtime (e.g. imported from .abr patt sections). */
const registeredPatterns = new Map<string, { map: GrayMap; label: string }>();

const BUILTIN_PATTERNS: PatternId[] = [
  'paper', 'canvas', 'sponge', 'clouds', 'speckle', ...Object.keys(ORGANIC_PATTERNS),
];

export function getPattern(id: PatternId): GrayMap {
  const registered = registeredPatterns.get(id);
  if (registered) return registered.map;
  let p = patternCache.get(id);
  if (!p) {
    p = makePattern(BUILTIN_PATTERNS.includes(id) ? id : 'paper');
    patternCache.set(id, p);
  }
  return p;
}

/** Registers an imported pattern (square grayscale map) under an id. */
export function registerPattern(id: string, map: GrayMap, label: string): void {
  registeredPatterns.set(id, { map, label });
}

export function isRegisteredPattern(id: string): boolean {
  return registeredPatterns.has(id);
}

/** UI options for all registered (imported) patterns. */
export function registeredPatternOptions(): { id: string; label: string }[] {
  return [...registeredPatterns].map(([id, { label }]) => ({ id, label }));
}

const BUILTIN_TIPS: TipShape[] = [
  'round', 'chalk', 'spatter', 'grain', ...Object.keys(ORGANIC_TIPS),
];

export function getTip(shape: TipShape): GrayMap {
  const registered = registeredTips.get(shape);
  if (registered) return registered;
  let t = tipCache.get(shape);
  if (!t) {
    t = makeTip(BUILTIN_TIPS.includes(shape) ? shape : 'round');
    tipCache.set(shape, t);
  }
  return t;
}

/** Registers a sampled tip (square alpha map) under an id, e.g. from an ABR. */
export function registerTip(id: string, map: GrayMap): void {
  registeredTips.set(id, map);
  tipAspectCache.delete(id);
}

const tipAspectCache = new Map<string, number>();

/**
 * Short/long side ratio of the tip's ink bounding box, in (0, 1]. Sampled
 * ABR tips are stored cropped to their ink but padded square here, so the
 * bounding box recovers the mark's true shape (e.g. "Chalk 44 pixels" is
 * 44x32 -> 0.727). Round and square marks are 1.
 */
export function getTipAspect(shape: TipShape): number {
  if (shape === 'round') return 1;
  const cached = tipAspectCache.get(shape);
  if (cached !== undefined) return cached;
  const { size, data } = getTip(shape);
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  let aspect = 1;
  if (maxX >= minX && maxY >= minY) {
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    aspect = Math.min(w, h) / Math.max(w, h);
  }
  tipAspectCache.set(shape, aspect);
  return aspect;
}

export function isRegisteredTip(id: string): boolean {
  return registeredTips.has(id);
}
