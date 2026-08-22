import { STAMP_FLOATS } from '../../brush/dynamics';
import { getPattern, getTip, type GrayMap } from '../../brush/patterns';
import { TEXTURE_BLEND_INDEX } from '../../brush/types';
import type { EngineStrokeParams } from '../../gpu/engine';
import { BLEND_MODE_INDEX } from '../../types';
import type { PaintBackend, StampBatch } from '../types';
import {
  applyDualToAlpha,
  applyTexToAlpha,
  blendPixel,
  compositePixel,
  hash21,
  texValue,
  wetRemap,
  type RGB,
  type TexBCI,
} from './blend';

/**
 * The brush engine with the GPU taken out.
 *
 * Nothing here is a simplification of the WebGPU path: the same stamp
 * records go through the same profile, the same texture and dual-brush
 * gates, and the same stroke-into-layer merge, accumulated in the same 8-bit
 * buffers so the rounding matches too. What it drops is the *machine* — no
 * browser process, no device, and above all no readback, which is what made
 * measuring a brush slow.
 *
 * Buffers are premultiplied RGBA8, as on the GPU, except the dual mask which
 * is single-channel coverage.
 */

const FLAG_FLIP_X = 1;
const FLAG_FLIP_Y = 2;

/** Bilinear sample of a square gray map, clamped at the edges (sampLinear). */
function sampleClamped(map: GrayMap, u: number, v: number): number {
  const n = map.size;
  const x = u * n - 0.5;
  const y = v * n - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = x0 < 0 ? 0 : x0 >= n ? n - 1 : x0;
  const cy0 = y0 < 0 ? 0 : y0 >= n ? n - 1 : y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const cx1 = x1 < 0 ? 0 : x1 >= n ? n - 1 : x1;
  const cy1 = y1 < 0 ? 0 : y1 >= n ? n - 1 : y1;
  const d = map.data;
  const a = d[cy0 * n + cx0];
  const b = d[cy0 * n + cx1];
  const c = d[cy1 * n + cx0];
  const e = d[cy1 * n + cx1];
  const top = a + (b - a) * fx;
  const bot = c + (e - c) * fx;
  return (top + (bot - top) * fy) / 255;
}

/** Bilinear sample of a tiling gray map (sampRepeat). */
function sampleRepeat(map: GrayMap, u: number, v: number): number {
  const n = map.size;
  const x = u * n - 0.5;
  const y = v * n - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (i: number) => ((i % n) + n) % n;
  const rx0 = wrap(x0);
  const ry0 = wrap(y0);
  const rx1 = wrap(x0 + 1);
  const ry1 = wrap(y0 + 1);
  const d = map.data;
  const a = d[ry0 * n + rx0];
  const b = d[ry0 * n + rx1];
  const c = d[ry1 * n + rx0];
  const e = d[ry1 * n + rx1];
  const top = a + (b - a) * fx;
  const bot = c + (e - c) * fx;
  return (top + (bot - top) * fy) / 255;
}

/**
 * The analytic round tip, byte for byte the shader's `roundProfile`: a
 * Gaussian falloff rescaled to reach exactly zero at the radius, with at
 * least ~1.6px of softness kept so a 100%-hardness tip still has Photoshop's
 * anti-aliased rim.
 */
const K = 3.912; // ln(50): puts the unscaled tail at 2%
const EXP_NEG_K = Math.exp(-K);

function roundProfile(r: number, hardness: number, radiusPx: number): number {
  if (r >= 1) return 0;
  const h = Math.min(hardness, Math.max(0, 1 - 1.6 / Math.max(radiusPx, 1.6)));
  if (r <= h) return 1;
  const t = (r - h) / (1 - h);
  return (Math.exp(-K * t * t) - EXP_NEG_K) / (1 - EXP_NEG_K);
}

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const emptyBounds = (): Bounds => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 });

interface StampProgram {
  tip: GrayMap | null;
  hardness: number;
  pattern: GrayMap | null;
  texScalePx: number;
  texMode: number;
  bci: TexBCI;
  texEach: boolean;
  noise: boolean;
}

export class CpuPaintEngine implements PaintBackend {
  readonly docWidth: number;
  readonly docHeight: number;

  private layers = new Map<string, Uint8Array>();
  private strokeTex: Uint8Array;
  private dualTex: Uint8Array;
  private stroke: EngineStrokeParams | null = null;
  private primary: StampProgram | null = null;
  private dual: StampProgram | null = null;
  /**
   * The rectangle the current stroke has touched. The GPU merges a stroke
   * into its layer with a fullscreen pass, which costs the same whatever the
   * stroke did; here that would mean walking a million pixels to commit a
   * mark sixty tall, so the merge is confined to what was actually stamped.
   */
  private bounds = emptyBounds();

  constructor(docWidth: number, docHeight: number) {
    this.docWidth = docWidth;
    this.docHeight = docHeight;
    this.strokeTex = new Uint8Array(docWidth * docHeight * 4);
    this.dualTex = new Uint8Array(docWidth * docHeight);
  }

  static create(docWidth: number, docHeight: number): CpuPaintEngine {
    return new CpuPaintEngine(docWidth, docHeight);
  }

  ensureLayer(id: string): void {
    if (!this.layers.has(id)) {
      this.layers.set(id, new Uint8Array(this.docWidth * this.docHeight * 4));
    }
  }

  fillLayer(id: string, rgba: [number, number, number, number]): void {
    this.ensureLayer(id);
    const buf = this.layers.get(id)!;
    const a = rgba[3];
    const bytes = [
      Math.round(rgba[0] * a * 255),
      Math.round(rgba[1] * a * 255),
      Math.round(rgba[2] * a * 255),
      Math.round(a * 255),
    ];
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = bytes[0];
      buf[i + 1] = bytes[1];
      buf[i + 2] = bytes[2];
      buf[i + 3] = bytes[3];
    }
  }

  beginStroke(params: EngineStrokeParams): void {
    this.stroke = params;
    this.clearStrokeBuffers();
    this.bounds = emptyBounds();
    const tex = params.texture;
    this.primary = {
      tip: params.tipShape === 'round' ? null : getTip(params.tipShape),
      hardness: params.hardness,
      pattern: tex ? getPattern(tex.pattern) : null,
      texScalePx: tex ? tex.scalePx : 256,
      texMode: tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0,
      bci: {
        brightness: tex ? tex.brightness : 0,
        contrast: tex ? tex.contrast : 0,
        invert: tex ? tex.invert : false,
        depth: tex ? tex.depth : 1,
      },
      texEach: !!tex && tex.eachTip,
      noise: params.noise,
    };
    this.dual = params.dual
      ? {
          tip: params.dual.shape === 'round' ? null : getTip(params.dual.shape),
          hardness: params.dual.hardness,
          pattern: null,
          texScalePx: 256,
          texMode: 0,
          bci: { brightness: 0, contrast: 0, invert: false, depth: 1 },
          texEach: false,
          noise: false,
        }
      : null;
  }

  /** Zeroes only what the last stroke touched. */
  private clearStrokeBuffers(): void {
    const b = this.bounds;
    if (b.x1 < b.x0) return;
    for (let y = b.y0; y <= b.y1; y++) {
      const row = y * this.docWidth;
      this.strokeTex.fill(0, (row + b.x0) * 4, (row + b.x1 + 1) * 4);
      this.dualTex.fill(0, row + b.x0, row + b.x1 + 1);
    }
  }

  drawStampBatches(batches: StampBatch[]): void {
    if (!this.stroke) return;
    for (const batch of batches) {
      const program = batch.target === 'dual' ? this.dual : this.primary;
      if (!program) continue;
      const count = batch.records.length / STAMP_FLOATS;
      for (let i = 0; i < count; i++) {
        this.stamp(batch.records, i * STAMP_FLOATS, program, batch.target === 'dual');
      }
    }
  }

  /**
   * One dab.
   *
   * The GPU draws a quad whose corners are the tip square rotated by `angle`
   * and squashed by `roundness`, interpolating a tip-space coordinate across
   * it. Here the same coordinate is recovered per pixel by inverting that
   * transform, so the two rasterise the same footprint — including the 1px
   * apron that keeps the rim anti-aliased.
   */
  private stamp(rec: Float32Array, at: number, program: StampProgram, dual: boolean): void {
    const cx = rec[at];
    const cy = rec[at + 1];
    const radius = rec[at + 2];
    const alpha = rec[at + 3];
    const angle = rec[at + 4];
    const roundness = rec[at + 5];
    const cr = rec[at + 6];
    const cg = rec[at + 7];
    const cb = rec[at + 8];
    const flags = rec[at + 9] | 0;
    const depthScale = rec[at + 10];
    if (alpha <= 0 || radius <= 0) return;

    const pad = radius + 1;
    const padY = pad * roundness;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    // AABB of the rotated rect
    const ex = Math.abs(pad * ca) + Math.abs(padY * sa);
    const ey = Math.abs(pad * sa) + Math.abs(padY * ca);
    const x0 = Math.max(0, Math.floor(cx - ex));
    const x1 = Math.min(this.docWidth - 1, Math.ceil(cx + ex));
    const y0 = Math.max(0, Math.floor(cy - ey));
    const y1 = Math.min(this.docHeight - 1, Math.ceil(cy + ey));
    if (x1 < x0 || y1 < y0) return;
    const b = this.bounds;
    if (x0 < b.x0) b.x0 = x0;
    if (x1 > b.x1) b.x1 = x1;
    if (y0 < b.y0) b.y0 = y0;
    if (y1 > b.y1) b.y1 = y1;

    const tipScale = pad / Math.max(radius, 1e-4);
    const invPad = 1 / pad;
    const invPadY = 1 / Math.max(padY, 1e-6);
    const flipX = (flags & FLAG_FLIP_X) !== 0;
    const flipY = (flags & FLAG_FLIP_Y) !== 0;
    const { tip, pattern, bci } = program;
    const texDepth = bci.depth * depthScale;
    const invTexScale = 1 / Math.max(program.texScalePx, 1);
    const width = this.docWidth;

    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx;
        // into the dab's own frame, then to the unit square the GPU
        // interpolates across
        const lx = (dx * ca + dy * sa) * invPad;
        const ly = (-dx * sa + dy * ca) * invPadY;
        if (lx < -1 || lx > 1 || ly < -1 || ly > 1) continue;

        const tx = lx * tipScale;
        const ty = ly * tipScale;
        let a: number;
        if (tip) {
          if (tx < -1 || tx > 1 || ty < -1 || ty > 1) continue; // hide the apron
          let u = tx * 0.5 + 0.5;
          let v = ty * 0.5 + 0.5;
          if (flipX) u = 1 - u;
          if (flipY) v = 1 - v;
          a = sampleClamped(tip, u < 0 ? 0 : u > 1 ? 1 : u, v < 0 ? 0 : v > 1 ? 1 : v);
        } else {
          a = roundProfile(Math.sqrt(tx * tx + ty * ty), program.hardness, radius);
        }
        if (a <= 0) continue;
        a *= alpha;

        if (program.texEach && pattern) {
          const v = texValue(
            sampleRepeat(pattern, (px + 0.5) * invTexScale, (py + 0.5) * invTexScale),
            bci,
          );
          a = applyTexToAlpha(a, v, program.texMode, texDepth);
        }
        if (program.noise) {
          const n = hash21(Math.floor((px + 0.5) * 2), Math.floor((py + 0.5) * 2));
          const t = 1 - a < 0 ? 0 : 1 - a > 1 ? 1 : 1 - a;
          a *= 1 + (n - 1) * t;
        }
        if (a <= 0) continue;

        if (dual) {
          // r8unorm target: coverage only, over-blended like the GPU
          const idx = py * width + px;
          const d = this.dualTex[idx] / 255;
          this.dualTex[idx] = Math.round(Math.min(1, a + d * (1 - a)) * 255);
        } else {
          const idx = (py * width + px) * 4;
          const inv = 1 - a;
          const buf = this.strokeTex;
          buf[idx] = Math.round(Math.min(1, cr * a + (buf[idx] / 255) * inv) * 255);
          buf[idx + 1] = Math.round(Math.min(1, cg * a + (buf[idx + 1] / 255) * inv) * 255);
          buf[idx + 2] = Math.round(Math.min(1, cb * a + (buf[idx + 2] / 255) * inv) * 255);
          buf[idx + 3] = Math.round(Math.min(1, a + (buf[idx + 3] / 255) * inv) * 255);
        }
      }
    }
  }

  /** The commit pass: `strokeMergeApply` over every pixel of the layer. */
  endStroke(layerId: string): void {
    const params = this.stroke;
    this.stroke = null;
    if (!params) return;
    this.ensureLayer(layerId);
    const layer = this.layers.get(layerId)!;
    const erase = params.mode === 'erase';
    const blend = erase ? 0 : BLEND_MODE_INDEX[params.blendMode];
    const opacity = params.opacity;
    const lockAlpha = params.lockTransparent;
    const tex = params.texture && !params.texture.eachTip ? params.texture : null;
    const pattern = tex ? getPattern(tex.pattern) : null;
    const bci: TexBCI = {
      brightness: tex ? tex.brightness : 0,
      contrast: tex ? tex.contrast : 0,
      invert: tex ? tex.invert : false,
      depth: tex ? tex.depth : 1,
    };
    const texMode = tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0;
    const invTexScale = tex ? 1 / Math.max(tex.scalePx, 1) : 0;
    const dualOn = !!params.dual;
    const dualMode = params.dual ? TEXTURE_BLEND_INDEX[params.dual.mode] : 0;

    // Lighten, Screen and Hard Mix lift coverage from zero, so a whole-stroke
    // texture in one of those paints the pattern across bare canvas — odd,
    // but it is what the shader does, and a renderer that quietly disagreed
    // would be worse than one that is faithfully strange. Those three walk
    // the whole document; everything else stays inside the stroke.
    const texPaintsBare = !!tex && (texMode === 5 || texMode === 6 || texMode === 10);
    const region = texPaintsBare
      ? { x0: 0, y0: 0, x1: this.docWidth - 1, y1: this.docHeight - 1 }
      : this.bounds;
    if (region.x1 < region.x0) return;

    const dst = new Float64Array(4);
    const out = new Float64Array(4);
    const cs: RGB = [0, 0, 0];

    for (let py = region.y0; py <= region.y1; py++) {
      for (let px = region.x0; px <= region.x1; px++) {
        const idx = (py * this.docWidth + px) * 4;
        let cov = this.strokeTex[idx + 3] / 255;
        if (cov <= 0 && !texPaintsBare) continue; // the merge would be a no-op
        if (dualOn) cov = applyDualToAlpha(cov, this.dualTex[py * this.docWidth + px] / 255, dualMode);
        if (tex && pattern) {
          const v = texValue(
            sampleRepeat(pattern, (px + 0.5) * invTexScale, (py + 0.5) * invTexScale),
            bci,
          );
          cov = applyTexToAlpha(cov, v, texMode, bci.depth);
        }
        if (params.wetEdges) cov = wetRemap(cov);
        const sa = cov * opacity;
        if (sa <= 0) continue;

        dst[0] = layer[idx] / 255;
        dst[1] = layer[idx + 1] / 255;
        dst[2] = layer[idx + 2] / 255;
        dst[3] = layer[idx + 3] / 255;

        if (erase) {
          if (lockAlpha) continue;
          layer[idx] = Math.round(dst[0] * (1 - sa) * 255);
          layer[idx + 1] = Math.round(dst[1] * (1 - sa) * 255);
          layer[idx + 2] = Math.round(dst[2] * (1 - sa) * 255);
          layer[idx + 3] = Math.round(dst[3] * (1 - sa) * 255);
          continue;
        }

        const st = this.strokeTex[idx + 3] / 255;
        if (st > 0) {
          cs[0] = this.strokeTex[idx] / 255 / st;
          cs[1] = this.strokeTex[idx + 1] / 255 / st;
          cs[2] = this.strokeTex[idx + 2] / 255 / st;
        } else {
          cs[0] = cs[1] = cs[2] = 0;
        }

        if (lockAlpha) {
          if (dst[3] <= 0) continue;
          const ab = dst[3];
          const cb: RGB = [dst[0] / ab, dst[1] / ab, dst[2] / ab];
          const bl = blend === 0 ? cs : blendPixel(blend, cb, cs);
          layer[idx] = Math.round((cb[0] + (bl[0] - cb[0]) * sa) * ab * 255);
          layer[idx + 1] = Math.round((cb[1] + (bl[1] - cb[1]) * sa) * ab * 255);
          layer[idx + 2] = Math.round((cb[2] + (bl[2] - cb[2]) * sa) * ab * 255);
          continue;
        }

        compositePixel(dst, cs, sa, blend, out);
        layer[idx] = Math.round(Math.min(1, out[0]) * 255);
        layer[idx + 1] = Math.round(Math.min(1, out[1]) * 255);
        layer[idx + 2] = Math.round(Math.min(1, out[2]) * 255);
        layer[idx + 3] = Math.round(Math.min(1, out[3]) * 255);
      }
    }
  }

  readLayer(id: string): Promise<Uint8Array> {
    this.ensureLayer(id);
    // already in main memory — the whole point of this renderer
    return Promise.resolve(this.layers.get(id)!);
  }
}
