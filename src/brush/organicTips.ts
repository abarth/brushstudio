import type { GrayMap } from './patterns';

/**
 * Generators for the high-resolution organic tips and the linen pattern used
 * by the Oil & Fresco brushes.
 *
 * These are deliberately larger and richer than the 128px built-in tips. The
 * design target is a dual-brush mark that never visibly repeats, which is a
 * frequency-domain problem: the dual mask is the stamp train convolved with
 * the tip, `M(f) = T(f) * S(f)`, so
 *
 * - `S` (the stamp comb) must carry no spectral line at the stamp frequency.
 *   That is Scattering's job, not the bitmap's — see presets.ts, where every
 *   dual keeps scatter/spacing >= 3 with Both Axes on.
 * - `T` (the tip) must be broadband, with no characteristic blob size, or
 *   every stamp reads as the same grain. That is this file's job: fractal
 *   noise over many octaves, domain-warped, with a large-scale density field
 *   so different regions of one tip look genuinely different.
 *
 * Three artifacts are actively designed out:
 *
 * - Square value-noise lattices from successive octaves align into a visible
 *   grid of dots, so each octave is sampled through its own rotation and the
 *   lacunarity is nudged off 2.0.
 * - A full-bleed square tip stamps its own bitmap boundary into the mask,
 *   which shows up as straight rectangular cuts once scatter separates the
 *   stamps. Every texture tip is therefore closed off by a torn vignette.
 * - The linen pattern tiles across the document, so its lattices stay
 *   periodic (no rotation) and its upsampling wraps.
 */

// ---------------------------------------------------------------------------
// noise primitives
// ---------------------------------------------------------------------------

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

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  return smooth(clamp01((x - a) / (b - a)));
}

/** One octave: a periodic value-noise lattice plus its sampling rotation. */
interface Octave {
  g: Float32Array;
  /** cell counts per axis (equal except for anisotropic, fibrous noise) */
  cx: number;
  cy: number;
  amp: number;
  cos: number;
  sin: number;
}

function lattice(cx: number, cy: number, rng: () => number): Float32Array {
  const g = new Float32Array(cx * cy);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function sampleOctave(o: Octave, u: number, v: number): number {
  const x = u * o.cx;
  const y = v * o.cy;
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  let xi = fx0 % o.cx;
  let yi = fy0 % o.cy;
  if (xi < 0) xi += o.cx;
  if (yi < 0) yi += o.cy;
  const x1 = xi + 1 === o.cx ? 0 : xi + 1;
  const y1 = yi + 1 === o.cy ? 0 : yi + 1;
  const fx = smooth(x - fx0);
  const fy = smooth(y - fy0);
  const r0 = yi * o.cx;
  const r1 = y1 * o.cx;
  const a = o.g[r0 + xi];
  const b = o.g[r0 + x1];
  const c = o.g[r1 + xi];
  const d = o.g[r1 + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

interface Stack {
  layers: Octave[];
  total: number;
}

interface StackOpts {
  cellsY?: number;
  persistence?: number;
  lacunarity?: number;
  /**
   * Per-octave growth across the u axis, defaulting to `lacunarity`. Setting
   * it to 1 pins the u frequency while v keeps doubling, which buys fine
   * multi-scale striation WITHOUT the along-stroke wander that normally comes
   * with extra octaves — and that wander is what smears a combed track shut,
   * since dabs step along u between stamps.
   */
  lacunarityX?: number;
  /** rotate each octave's frame — breaks lattice alignment, breaks tiling */
  rotate?: boolean;
}

function makeStack(rng: () => number, cells: number, octaves: number, opts: StackOpts = {}): Stack {
  const {
    cellsY = cells, persistence = 0.5, lacunarity = 2,
    lacunarityX = lacunarity, rotate = false,
  } = opts;
  const layers: Octave[] = [];
  let ax = cells;
  let ay = cellsY;
  let amp = 1;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    const cx = Math.max(2, Math.round(ax));
    const cy = Math.max(2, Math.round(ay));
    // golden-ratio turns never repeat an angle across the stack
    const ang = rotate ? 0.6180339887 * (i + 1) * Math.PI : 0;
    layers.push({ g: lattice(cx, cy, rng), cx, cy, amp, cos: Math.cos(ang), sin: Math.sin(ang) });
    total += amp;
    amp *= persistence;
    ax *= lacunarityX;
    ay *= lacunarity;
  }
  return { layers, total };
}

function evalStack(s: Stack, u: number, v: number): number {
  let sum = 0;
  const du = u - 0.5;
  const dv = v - 0.5;
  for (const o of s.layers) {
    const uu = o.sin === 0 ? u : 0.5 + du * o.cos - dv * o.sin;
    const vv = o.sin === 0 ? v : 0.5 + du * o.sin + dv * o.cos;
    sum += o.amp * sampleOctave(o, uu, vv);
  }
  return sum / s.total;
}

/**
 * Ridged variant: each octave folded as 1 - |2n - 1|, which turns the smooth
 * hills of value noise into sharp creases. Thresholding the result gives the
 * connected filaments a crack network or a marble vein needs — something
 * plain fractal noise, whose level sets are rounded blobs, cannot produce.
 */
function evalRidged(s: Stack, u: number, v: number): number {
  let sum = 0;
  const du = u - 0.5;
  const dv = v - 0.5;
  for (const o of s.layers) {
    const uu = o.sin === 0 ? u : 0.5 + du * o.cos - dv * o.sin;
    const vv = o.sin === 0 ? v : 0.5 + du * o.sin + dv * o.cos;
    sum += o.amp * (1 - Math.abs(2 * sampleOctave(o, uu, vv) - 1));
  }
  return sum / s.total;
}

/**
 * Cellular (Worley) noise: one jittered feature point per grid cell, with the
 * distances to the nearest two returned.
 *
 * This is a different shape of randomness from the fbm above, and the reason
 * the organic tips needed it. Level sets of fractal noise are smooth rounded
 * blobs, so everything built from it reads as cloud or sponge. Worley's level
 * sets are cell walls, which is what lichen thalli, bone porosity, pebbles
 * and moss tufts actually look like:
 *
 *   f1 alone    -> round pores or tufts centred on the points
 *   f2 - f1     -> the walls between cells, for crusts and mosaics
 *
 * Positions use unwrapped cell coordinates while the jitter is looked up
 * wrapped, so the field is periodic without distances folding at the seam.
 */
interface Worley {
  cells: number;
  jitter: Float32Array;
  /** one random value per cell, for per-cell shading */
  value: Float32Array;
}

function makeWorley(rng: () => number, cells: number): Worley {
  const jitter = new Float32Array(cells * cells * 2);
  const value = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    jitter[i * 2] = rng();
    jitter[i * 2 + 1] = rng();
    value[i] = rng();
  }
  return { cells, jitter, value };
}

interface WorleyHit {
  f1: number;
  f2: number;
  /** value of the nearest cell */
  v: number;
}

function worley(w: Worley, u: number, v: number): WorleyHit {
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

function renderStack(size: number, s: Stack): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) out[y * size + x] = evalStack(s, x / size, v);
  }
  return out;
}

/** Bilinear upsample that wraps, so a tileable source stays tileable. */
function upsamplePeriodic(field: Float32Array, src: number, dst: number): Float32Array {
  const out = new Float32Array(dst * dst);
  const scale = src / dst;
  for (let y = 0; y < dst; y++) {
    const sy = y * scale;
    const y0 = Math.floor(sy) % src;
    const y1 = y0 + 1 === src ? 0 : y0 + 1;
    const fy = sy - Math.floor(sy);
    for (let x = 0; x < dst; x++) {
      const sx = x * scale;
      const x0 = Math.floor(sx) % src;
      const x1 = x0 + 1 === src ? 0 : x0 + 1;
      const fx = sx - Math.floor(sx);
      const a = field[y0 * src + x0];
      const b = field[y0 * src + x1];
      const c = field[y1 * src + x0];
      const d = field[y1 * src + x1];
      out[y * dst + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

function lowResField(size: number, seed: number, cells: number, octaves: number, dst: number) {
  return upsamplePeriodic(renderStack(size, makeStack(mulberry32(seed), cells, octaves)), size, dst);
}

/**
 * A torn-edged radial falloff, as a multiplier over a square field. Ragging
 * the falloff with noise keeps it from reading as a circle, which a clean
 * vignette would.
 */
function raggedVignette(size: number, seed: number, inner = 0.72, rag = 0.26): Float32Array {
  const edge = lowResField(96, seed, 5, 4, size);
  const out = new Float32Array(size * size);
  const c = (size - 1) / 2;
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    const dy = (y - c) / r;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = (x - c) / r;
      const raw = Math.sqrt(dx * dx + dy * dy);
      const d = raw * (1 + rag * (edge[i] - 0.5) * 2);
      // The ragged term can pull the falloff inward by as much as (1 - rag),
      // which leaves ink alive at the bitmap's own border — and that border
      // then stamps into the mask as a hard rectangle wherever scatter
      // separates the dabs. The raw-radius guard forces a true zero by the
      // edge regardless of how the raggedness lands.
      out[i] = smoothstep(1, inner, d) * smoothstep(1, 0.9, raw);
    }
  }
  return out;
}

const toMap = (size: number, f: Float32Array): GrayMap => {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < f.length; i++) data[i] = Math.round(clamp01(f[i]) * 255);
  return { size, data };
};

// ---------------------------------------------------------------------------
// texture tips (used as the DUAL tip)
//
// Mean coverage is the main dial here. A dark tip (sponge, ~0.32) bites hard
// and breaks the stroke into dabs; a bright one (mist, ~0.75) only modulates
// it. Overlapping dual stamps union together, so the mask brightens roughly
// as 1 - (1 - mean)^(1/spacing) — which is why the darker tips below are
// paired with longer dual spacing in presets.ts.
// ---------------------------------------------------------------------------

export const TEXTURE_TIP_SIZE = 768;
export const HERO_TIP_SIZE = 1024;

interface SpongeOpts {
  size?: number;
  seed?: number;
  cells?: number;
  octaves?: number;
  persistence?: number;
  lo?: number;
  hi?: number;
  fineCells?: number;
  fineLo?: number;
  fineHi?: number;
  floor?: number;
  warp?: number;
  clump?: number;
  vignetteInner?: number;
}

/**
 * Cellular sponge: domain-warped fractal blobs carved by a finer hole layer,
 * with a large-scale density field so one region of the tip is dense and
 * another sparse. That regional variety is what lets a scattered stamp train
 * look like different marks rather than one stamp repeated.
 */
function spongeField(o: SpongeOpts = {}): GrayMap {
  const {
    size = TEXTURE_TIP_SIZE, seed = 20260809, cells = 11, octaves = 7,
    persistence = 0.57, lo = 0.4, hi = 0.58, fineCells = 40, fineLo = 0.34,
    fineHi = 0.7, floor = 0.32, warp = 0.2, clump = 0.2, vignetteInner = 0.72,
  } = o;

  const wx = lowResField(112, seed + 11, 3, 4, size);
  const wy = lowResField(112, seed + 23, 3, 4, size);
  const cl = lowResField(96, seed + 37, 3, 3, size);

  const rng = mulberry32(seed + 51);
  const main = makeStack(rng, cells, octaves, { persistence, lacunarity: 2.13, rotate: true });
  const fine = makeStack(rng, fineCells, 4, { persistence: 0.55, lacunarity: 2.19, rotate: true });
  const vig = raggedVignette(size, seed + 73, vignetteInner);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u0 = x / size;
      const u = u0 + warp * (wx[i] - 0.5);
      const v = v0 + warp * (wy[i] - 0.5);
      const blobs = smoothstep(lo, hi, evalStack(main, u, v) + clump * (cl[i] - 0.5));
      const holes = smoothstep(fineLo, fineHi, evalStack(fine, u, v));
      out[i] = blobs * (floor + (1 - floor) * holes) * vig[i];
    }
  }
  return toMap(size, out);
}

/** The hero sponge: the largest tip, and the most broken. */
export const makeFractalSponge = () => spongeField({ size: HERO_TIP_SIZE });

/** Dense stone grit — fine, high-frequency, mostly closed. */
export const makeGraniteGrit = () =>
  spongeField({
    seed: 3140011, cells: 26, octaves: 6, persistence: 0.5,
    lo: 0.3, hi: 0.62, fineCells: 96, fineLo: 0.28, fineHi: 0.72,
    floor: 0.45, warp: 0.1, clump: 0.26,
  });

/** Soft billowing cloud — bright and low contrast, so it only modulates. */
export const makeMistBillow = () =>
  spongeField({
    seed: 778201, cells: 6, octaves: 6, persistence: 0.6,
    lo: 0.2, hi: 0.72, fineCells: 18, fineLo: 0.2, fineHi: 0.85,
    floor: 0.7, warp: 0.3, clump: 0.3, vignetteInner: 0.5,
  });

/**
 * Crazed crackle: a ridged filament network, inverted so the crust paints and
 * the cracks stay open. Reads as dried, fissured pigment.
 */
export function makeCrackleWeb(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 90210;
  const wx = lowResField(112, seed + 11, 3, 4, size);
  const wy = lowResField(112, seed + 23, 3, 4, size);
  const cl = lowResField(96, seed + 31, 3, 3, size);

  const rng = mulberry32(seed + 47);
  const veins = makeStack(rng, 7, 5, { persistence: 0.55, lacunarity: 2.11, rotate: true });
  const grit = makeStack(rng, 60, 3, { persistence: 0.5, lacunarity: 2.17, rotate: true });
  const vig = raggedVignette(size, seed + 67, 0.74);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size + 0.14 * (wx[i] - 0.5);
      const v = v0 + 0.14 * (wy[i] - 0.5);
      // ridges near 1 are the crease lines; keep a band of them as cracks
      const crack = smoothstep(0.66, 0.9, evalRidged(veins, u, v) + 0.12 * (cl[i] - 0.5));
      const tooth = smoothstep(0.25, 0.8, evalStack(grit, u, v));
      out[i] = (1 - 0.95 * crack) * (0.42 + 0.58 * tooth) * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Dragged fibres: strongly anisotropic noise, so the holes stretch into
 * streaks along the tip's long axis. Rotated by Angle Control = Direction in
 * the presets, this reads as bristles combing through wet paint.
 */
export function makeFiberDrag(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 55512;
  const wx = lowResField(96, seed + 5, 3, 3, size);
  const wy = lowResField(96, seed + 9, 3, 3, size);

  const rng = mulberry32(seed + 29);
  // Few cells across the fibres, many along them. The anisotropy has to stay
  // moderate: push it too far and the strands run the full width as unbroken
  // bands, which reads as venetian blinds rather than bristle drag.
  const fibres = makeStack(rng, 8, 5, { cellsY: 34, persistence: 0.5, lacunarity: 2.11 });
  // a second field with the opposite anisotropy chops the strands into
  // segments of varying length
  const chop = makeStack(rng, 22, 4, { cellsY: 7, persistence: 0.5, lacunarity: 2.17 });
  const clump = lowResField(96, seed + 83, 3, 3, size);
  const vig = raggedVignette(size, seed + 61, 0.7);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size + 0.1 * (wx[i] - 0.5);
      const v = v0 + 0.2 * (wy[i] - 0.5);
      const strand = smoothstep(0.36, 0.68, evalStack(fibres, u, v) + 0.22 * (clump[i] - 0.5));
      const gap = smoothstep(0.3, 0.7, evalStack(chop, u, v));
      out[i] = (0.2 + 0.8 * strand) * (0.35 + 0.65 * gap) * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Thin filaments on open ground: only the sharpest crests of a ridged field
 * survive the threshold, so what is left is strands rather than blobs, and a
 * patch field breaks them into clumps. Mean coverage is very low by design —
 * this is the tip that makes a mark read as wispy rather than merely pale.
 */
export function makeWispFilament(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 24601;
  const wx = lowResField(96, seed + 7, 3, 3, size);
  const wy = lowResField(96, seed + 13, 3, 3, size);
  const patch = lowResField(96, seed + 19, 3, 3, size);

  const rng = mulberry32(seed + 53);
  const veins = makeStack(rng, 6, 5, { persistence: 0.54, lacunarity: 2.09, rotate: true });
  const fine = makeStack(rng, 34, 3, { persistence: 0.5, lacunarity: 2.19, rotate: true });
  const vig = raggedVignette(size, seed + 71, 0.6, 0.3);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size + 0.24 * (wx[i] - 0.5);
      const v = v0 + 0.24 * (wy[i] - 0.5);
      // A window near the top of the ridged field's actual range keeps only
      // the crest lines. Averaging 1-|2n-1| over octaves centres the field
      // near 0.5 and it rarely clears 0.8, so the window sits just above the
      // mean rather than near 1 — otherwise nothing survives at all.
      const strand = smoothstep(0.58, 0.78, evalRidged(veins, u, v));
      const grain = smoothstep(0.3, 0.75, evalStack(fine, u, v));
      // strands only appear where the patch field is open, so the tip has
      // large genuinely empty regions rather than an even haze
      const open = smoothstep(0.36, 0.6, patch[i]);
      out[i] = strand * (0.45 + 0.55 * grain) * open * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Scattered motes on open ground: the inverse of the salt tip, so the ground
 * is bare and only the specks carry ink. Radii are heavy-tailed, giving a few
 * large motes among many small ones.
 */
export function makeDustMotes(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 13372;
  const rng = mulberry32(seed);
  const haze = makeStack(rng, 16, 3, { persistence: 0.5, lacunarity: 2.13, rotate: true });
  const vig = raggedVignette(size, seed + 29, 0.55, 0.3);

  const out = new Float32Array(size * size);
  const motes = Math.round((size * size) / 620);
  for (let k = 0; k < motes; k++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = 1.5 + rng() * rng() * rng() * size * 0.045;
    const a = 0.4 + rng() * 0.6;
    const ri = Math.ceil(r + 2);
    for (let dy = -ri; dy <= ri; dy++) {
      const y = Math.round(cy + dy);
      if (y < 0 || y >= size) continue;
      for (let dx = -ri; dx <= ri; dx++) {
        const x = Math.round(cx + dx);
        if (x < 0 || x >= size) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r + 1.5) continue;
        const i = y * size + x;
        out[i] = Math.max(out[i], a * smoothstep(r + 1.5, r * 0.5, d));
      }
    }
  }
  // a faint haze between the motes keeps the mark from looking like confetti
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      out[i] = Math.min(1, out[i] + 0.16 * smoothstep(0.55, 0.9, evalStack(haze, x / size, y / size)));
      out[i] *= vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Salt flecks: a mostly closed field pitted with discrete rounded voids, like
 * salt thrown into wet pigment. The voids are placed by rejection against a
 * noise field rather than drawn on a grid, so they never line up.
 */
export function makeStippleFlecks(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 61803;
  const rng = mulberry32(seed);
  const grain = makeStack(rng, 30, 3, { persistence: 0.5, lacunarity: 2.13, rotate: true });
  const vig = raggedVignette(size, seed + 41, 0.72);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      out[i] = 0.66 + 0.34 * smoothstep(0.3, 0.75, evalStack(grain, x / size, v));
    }
  }

  const flecks = Math.round((size * size) / 1150);
  for (let k = 0; k < flecks; k++) {
    const cx = rng() * size;
    const cy = rng() * size;
    // heavy-tailed radii: many small pits, a few large ones
    const r = 2 + rng() * rng() * rng() * size * 0.055;
    const depth = 0.45 + rng() * 0.55;
    const ri = Math.ceil(r + 2);
    for (let dy = -ri; dy <= ri; dy++) {
      const y = Math.round(cy + dy);
      if (y < 0 || y >= size) continue;
      for (let dx = -ri; dx <= ri; dx++) {
        const x = Math.round(cx + dx);
        if (x < 0 || x >= size) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r + 1.5) continue;
        const i = y * size + x;
        out[i] = Math.min(out[i], 1 - depth * smoothstep(r + 1.5, r * 0.55, d));
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= vig[i];
  return toMap(size, out);
}

/**
 * Crustose lichen: cells pressed together with dark crenulated seams between
 * them. The seam comes from f2 - f1 (small only on a cell wall); warping the
 * lookup makes the walls wander the way a real thallus does, and a per-cell
 * value shades each lobe slightly differently so no two read alike.
 */
export function makeLichenCrust(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 771001;
  const wx = lowResField(96, seed + 3, 3, 3, size);
  const wy = lowResField(96, seed + 7, 3, 3, size);
  const rng = mulberry32(seed + 29);
  const cells = makeWorley(rng, 11);
  const grain = makeStack(rng, 44, 3, { persistence: 0.5, lacunarity: 2.13, rotate: true });
  const vig = raggedVignette(size, seed + 51, 0.7);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size + 0.11 * (wx[i] - 0.5);
      const v = v0 + 0.11 * (wy[i] - 0.5);
      const c = worley(cells, u, v);
      const wall = smoothstep(0.03, 0.19, c.f2 - c.f1);
      const lobe = 0.55 + 0.45 * c.v;
      const g = smoothstep(0.3, 0.78, evalStack(grain, u, v));
      out[i] = wall * lobe * (0.45 + 0.55 * g) * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Porous bone: a closed ground drilled by round pores at the feature points,
 * their radii varying per cell so the porosity is graded rather than a
 * regular perforation.
 */
export function makeBonePore(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 445009;
  const wx = lowResField(96, seed + 5, 3, 3, size);
  const wy = lowResField(96, seed + 11, 3, 3, size);
  const rng = mulberry32(seed + 37);
  const cells = makeWorley(rng, 15);
  const grain = makeStack(rng, 52, 3, { persistence: 0.5, lacunarity: 2.17, rotate: true });
  const vig = raggedVignette(size, seed + 61, 0.72);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size + 0.07 * (wx[i] - 0.5);
      const v = v0 + 0.07 * (wy[i] - 0.5);
      const c = worley(cells, u, v);
      // radius scales with the cell's own value: a few big voids, many small
      const r = 0.12 + 0.42 * c.v * c.v;
      const pore = smoothstep(r * 0.45, r, c.f1);
      const g = smoothstep(0.28, 0.8, evalStack(grain, u, v));
      out[i] = pore * (0.55 + 0.45 * g) * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Moss: dense fine tufts, clustered rather than evenly sown. A high-frequency
 * cellular field supplies the tufts and a slow fbm decides where the turf is
 * thick, so the mark has bald patches.
 */
export function makeMossTuft(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 909311;
  const patch = lowResField(96, seed + 13, 3, 3, size);
  const rng = mulberry32(seed + 41);
  const cells = makeWorley(rng, 34);
  const fuzz = makeStack(rng, 80, 2, { persistence: 0.5, lacunarity: 2.19, rotate: true });
  const vig = raggedVignette(size, seed + 71, 0.66, 0.3);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const c = worley(cells, u, v0);
      const tuft = smoothstep(0.62, 0.16, c.f1) * (0.5 + 0.5 * c.v);
      const thick = smoothstep(0.34, 0.66, patch[i]);
      const f = smoothstep(0.25, 0.8, evalStack(fuzz, u, v0));
      out[i] = tuft * thick * (0.5 + 0.5 * f) * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Bark: long grain running down the mark, split by deep fissures. The ridged
 * field is pinned in u (lacunarityX 1) so the fissures run straight along the
 * grain instead of wandering across it.
 */
export function makeBarkGrain(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 313007;
  const wy = lowResField(96, seed + 9, 3, 3, size);
  const rng = mulberry32(seed + 23);
  // 2 cells across at every octave: bark's fissures run down the grain, and
  // any real u-variation turns them into undulating marble instead
  // Fine ribs with thin splits. At 22/8 the fissures were as wide as the
  // ribs and accumulated into blobs rather than reading as grain.
  const grain = makeStack(rng, 2, 3, { cellsY: 40, persistence: 0.6, lacunarityX: 1 });
  const fissure = makeStack(rng, 2, 3, { cellsY: 16, persistence: 0.45, lacunarityX: 1 });
  const knots = makeWorley(rng, 6);
  const vig = raggedVignette(size, seed + 47, 0.7);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = v0 + 0.02 * (wy[i] - 0.5);
      // Bark is read by its splits more than its grain, so the fissures do
      // most of the work: a wide window cuts them deep and irregular, and the
      // grain only shades the ribs between them.
      const g = smoothstep(0.4, 0.62, evalStack(grain, u, v));
      const split = 1 - 0.97 * smoothstep(0.62, 0.86, evalRidged(fissure, u, v));
      const k = worley(knots, u, v);
      const knot = 0.75 + 0.25 * smoothstep(0.12, 0.5, k.f1);
      out[i] = (0.18 + 0.82 * g) * split * knot * vig[i];
    }
  }
  return toMap(size, out);
}

/**
 * Rust: corroded patches eating into a sounder ground, the pitting confined
 * to where the bloom has taken hold rather than spread evenly.
 */
export function makeRustBloom(size = TEXTURE_TIP_SIZE): GrayMap {
  const seed = 660221;
  const wx = lowResField(96, seed + 3, 3, 3, size);
  const wy = lowResField(96, seed + 17, 3, 3, size);
  const bloom = lowResField(96, seed + 31, 4, 4, size);
  const rng = mulberry32(seed + 59);
  const pits = makeWorley(rng, 26);
  const tooth = makeStack(rng, 40, 3, { persistence: 0.5, lacunarity: 2.13, rotate: true });
  const vig = raggedVignette(size, seed + 83, 0.7);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size + 0.13 * (wx[i] - 0.5);
      const v = v0 + 0.13 * (wy[i] - 0.5);
      const c = worley(pits, u, v);
      const eaten = smoothstep(0.1, 0.42, c.f1);
      // how far the corrosion has spread; outside it the ground stays sound
      const spread = smoothstep(0.38, 0.66, bloom[i]);
      const t = smoothstep(0.26, 0.78, evalStack(tooth, u, v));
      const ground = 0.5 + 0.5 * t;
      out[i] = ground * (1 - spread * (1 - eaten)) * vig[i];
    }
  }
  return toMap(size, out);
}

// ---------------------------------------------------------------------------
// primary tips (the mark's shape and edge)
//
// Edge hardness comes mostly from the preset, not the bitmap: accumulating N
// overlapping dabs gives A(r) = 1 - exp(-K * sqrt(1 - (r/R)^2) * a(r)) with
// K = flow / spacing, so a large K squares off whatever profile a(r) the tip
// has. These four supply the profiles that K then sharpens or leaves soft.
// ---------------------------------------------------------------------------

export const PRIMARY_TIP_SIZE = 640;

interface ChiselOpts {
  size?: number;
  seed?: number;
  /** ink height as a fraction of width — 1 is round */
  aspect?: number;
  /** cells across the mark; higher is finer striation */
  streakCells?: number;
  /**
   * Cells ACROSS the mark, i.e. how much the striations wander along the
   * stroke. This is what decides whether gaps between hairs survive: dabs
   * step along the stroke, so a wavy band shifts sideways as it goes and
   * twenty overlapping copies fill every gap. Near-1 keeps the hairs
   * translation-invariant along the drag, the way a real fan brush combs.
   */
  streakCellsX?: number;
  streakOctaves?: number;
  streakDepth?: number;
  /** striation threshold window; a narrow, high window separates the hairs */
  streakLo?: number;
  streakHi?: number;
  toothDepth?: number;
  edgeRag?: number;
  /** where the falloff starts: near 1 is a crisp edge, lower is feathered */
  edgeSoft?: number;
  /** superellipse exponent: high is a flat-ended chisel, 2 is an ellipse */
  power?: number;
}

/**
 * The shared primary-tip body: a superelliptical mark with a ragged outline
 * and bristle striations along its long axis. Padded square so getTipAspect
 * recovers the flattening from the ink bounding box.
 */
function chiselField(o: ChiselOpts = {}): GrayMap {
  const {
    size = PRIMARY_TIP_SIZE, seed = 7717, aspect = 472 / 768, streakCells = 40,
    streakCellsX = 5, streakOctaves = 4, streakDepth = 0.55, streakLo = 0.3,
    streakHi = 0.7, toothDepth = 0.28, edgeRag = 0.34, edgeSoft = 0.7,
    power = 2.6,
  } = o;

  const w = size;
  const h = Math.max(4, Math.round(size * aspect));
  const oy = Math.floor((size - h) / 2);

  const rng = mulberry32(seed + 5);
  // lacunarityX 1 keeps every octave as straight as the first: the extra
  // octaves subdivide the hairs instead of making them wander
  const streaks = makeStack(rng, streakCellsX, streakOctaves,
    { cellsY: streakCells, persistence: 0.55, lacunarityX: 1 });
  // rotated + off-2 lacunarity, or the tooth lattice shows as square blocks
  const tooth = makeStack(rng, 64, 3, { persistence: 0.5, lacunarity: 2.15, rotate: true });
  const edge = lowResField(96, seed + 61, 5, 4, size);

  const out = new Float32Array(size * size);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const rx = w / 2;
  const ry = h / 2;
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r = Math.pow(Math.abs(nx) ** power + Math.abs(ny) ** (power - 0.4), 1 / (power - 0.2));
      const rr = r * (1 + edgeRag * (edge[(y + oy) * size + x] - 0.5) * 2);
      const shape = smoothstep(1, edgeSoft, rr);
      const st = smoothstep(streakLo, streakHi, evalStack(streaks, x / w, v));
      const th = smoothstep(0.3, 0.7, evalStack(tooth, x / w, v));
      out[(y + oy) * size + x] = shape * (1 - streakDepth * (1 - st)) * (1 - toothDepth * (1 - th));
    }
  }
  return toMap(size, out);
}

/** Flat striated chisel — the workhorse dry-brush mark. */
export const makeBristleChisel = () => chiselField({ size: 768 });

/** Round and torn, with light striation: a general-purpose scumbling mark. */
export const makeBristleRound = () =>
  chiselField({
    seed: 424242, aspect: 0.92, streakCells: 26, streakDepth: 0.38,
    toothDepth: 0.34, edgeRag: 0.42, edgeSoft: 0.62, power: 2.1,
  });

/**
 * Crisp flat blade: nearly no edge raggedness and a hard falloff, so a high
 * flow/spacing ratio can square it off into a true hard edge.
 */
export const makeBladeFlat = () =>
  chiselField({
    seed: 131719, aspect: 0.4, streakCells: 54, streakDepth: 0.18,
    toothDepth: 0.12, edgeRag: 0.08, edgeSoft: 0.93, power: 4.5,
  });

/**
 * Splayed fan: the striations are cut all the way to zero between hairs
 * (streakDepth 1 over a narrow, high window), so unlike the other primaries
 * this tip is full of gaps before any dual mask touches it. That is what
 * drops a mark's coverage rather than just its density.
 */
export const makeFanComb = () =>
  chiselField({
    // Many fine hairs rather than a few bold ones, so the comb reads as
    // bristle grain instead of a rake. Three octaves at lacunarityX 1
    // subdivide 20 strands into 40 and 80 without bending them, and the
    // finest lands sub-pixel on canvas, fraying the strand edges. The gap
    // FRACTION is held near the coarse version's, so the pitch halves
    // without the mark filling in.
    seed: 606017, aspect: 0.5, streakCells: 20, streakCellsX: 2,
    streakOctaves: 3, streakDepth: 1, streakLo: 0.47, streakHi: 0.63,
    toothDepth: 0.2, edgeRag: 0.35, edgeSoft: 0.72, power: 3,
  });

/** Feathered plume: a wide, gentle falloff for genuinely soft edges. */
export const makePlumeSoft = () =>
  chiselField({
    seed: 998001, aspect: 0.86, streakCells: 14, streakDepth: 0.14,
    toothDepth: 0.14, edgeRag: 0.3, edgeSoft: 0.2, power: 2,
  });

// ---------------------------------------------------------------------------
// texture pattern
// ---------------------------------------------------------------------------

export const LINEN_SIZE = 512;

/**
 * A woven linen tooth. Texture is anchored to the document rather than the
 * stroke, so it adds canvas grain without contributing any along-stroke
 * periodicity of its own. Tileable, hence no rotated octaves.
 */
export function makeLinenPattern(size = LINEN_SIZE): GrayMap {
  const seed = 515151;
  const threads = 26;
  const warpAmt = 0.035;

  const wx = lowResField(64, seed + 3, 4, 3, size);
  const wy = lowResField(64, seed + 9, 4, 3, size);

  const rng = mulberry32(seed + 17);
  // slub (thread thickness) varies fast across the threads, slowly along them
  const slubU = makeStack(rng, threads, 1, { cellsY: 3 });
  const slubV = makeStack(rng, 3, 1, { cellsY: threads });
  const mottle = makeStack(rng, 5, 4, { persistence: 0.55 });
  const grit = makeStack(rng, 90, 2, {});

  const out = new Float32Array(size * size);
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    const v0 = y / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u0 = x / size;
      const u = u0 + warpAmt * (wx[i] - 0.5);
      const v = v0 + warpAmt * (wy[i] - 0.5);

      const warpTh = 0.5 + 0.5 * Math.sin(tau * threads * u);
      const weftTh = 0.5 + 0.5 * Math.sin(tau * threads * v);
      const cloth =
        (warpTh * (0.55 + 0.45 * evalStack(slubU, u, v0)) +
          weftTh * (0.55 + 0.45 * evalStack(slubV, u0, v))) *
        0.5;

      // The woven component stays deliberately low: pushed harder it reads as
      // a printed halftone grid over dense strokes rather than as cloth.
      const val =
        0.5 +
        0.16 * (cloth - 0.5) +
        0.5 * (evalStack(mottle, u0, v0) - 0.5) +
        0.14 * (evalStack(grit, u0, v0) - 0.5);
      out[i] = 0.5 + (val - 0.5) * 1.35;
    }
  }
  return toMap(size, out);
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Tip id -> generator. Everything here is built lazily and cached by patterns.ts. */
export const ORGANIC_TIPS: Record<string, () => GrayMap> = {
  // texture tips, for the Dual Brush slot
  'sponge-fractal': makeFractalSponge,
  'granite-grit': makeGraniteGrit,
  'crackle-web': makeCrackleWeb,
  'fiber-drag': makeFiberDrag,
  'mist-billow': makeMistBillow,
  'stipple-flecks': makeStippleFlecks,
  'wisp-filament': makeWispFilament,
  'dust-motes': makeDustMotes,
  'lichen-crust': makeLichenCrust,
  'bone-pore': makeBonePore,
  'moss-tuft': makeMossTuft,
  'bark-grain': makeBarkGrain,
  'rust-bloom': makeRustBloom,
  // primary tips, for the Brush Tip Shape slot
  'bristle-chisel': makeBristleChisel,
  'bristle-round': makeBristleRound,
  'blade-flat': makeBladeFlat,
  'plume-soft': makePlumeSoft,
  'fan-comb': makeFanComb,
};

export const ORGANIC_PATTERNS: Record<string, () => GrayMap> = {
  linen: makeLinenPattern,
};
