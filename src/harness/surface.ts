import { engineStrokeParams } from '../brush/engineParams';
import type { PointerSample } from '../brush/dynamics';
import type { BrushSettings } from '../brush/types';
import { PaintEngine } from '../gpu/engine';
import { StrokeSession } from '../gpu/stroke';
import { makeLayerMeta, type HSV, type LayerMeta } from '../types';

/**
 * A headless painting surface: one document-sized layer plus everything
 * needed to lay a stroke on it and read the pixels back.
 *
 * The engine is a real GPU engine, so it wants a canvas even when nothing is
 * ever presented to the screen; an unattached one is enough.
 */

export interface PaintOptions {
  /** foreground colour the stroke paints with */
  fg?: HSV;
  /** background colour, used by Color Dynamics' foreground/background jitter */
  bg?: HSV;
  /** seed for every jittered decision — the same seed redraws the same mark */
  seed?: number;
  /** erase instead of paint */
  erase?: boolean;
}

const DEFAULT_FG: HSV = { h: 24, s: 0.66, v: 0.22 };
const DEFAULT_BG: HSV = { h: 38, s: 0.28, v: 0.9 };

/** Deterministic PRNG — the plate must redraw identically run to run. */
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

export class Surface {
  readonly width: number;
  readonly height: number;
  private engine: PaintEngine;
  private layer: LayerMeta;
  private seq = 0;

  private constructor(engine: PaintEngine, width: number, height: number) {
    this.engine = engine;
    this.width = width;
    this.height = height;
    this.layer = makeLayerMeta({ id: 'paint', name: 'paint' });
    engine.ensureLayer(this.layer.id);
  }

  static async create(width: number, height: number): Promise<Surface> {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const engine = await PaintEngine.create(canvas, width, height);
    return new Surface(engine, width, height);
  }

  /** Paints the layer a flat colour; omit for a transparent ground. */
  fill(rgba: [number, number, number, number]): void {
    this.engine.fillLayer(this.layer.id, rgba);
  }

  clear(): void {
    this.engine.fillLayer(this.layer.id, [0, 0, 0, 0]);
  }

  /** Lays one stroke down, exactly as the app would from pointer events. */
  paint(settings: BrushSettings, samples: PointerSample[], opts: PaintOptions = {}): void {
    if (samples.length === 0) return;
    const mode = opts.erase ? 'erase' : 'paint';
    this.engine.beginStroke(engineStrokeParams(settings, mode));
    const session = new StrokeSession(this.engine, settings, {
      fg: opts.fg ?? DEFAULT_FG,
      bg: opts.bg ?? DEFAULT_BG,
      rng: mulberry32((opts.seed ?? 1) * 7919 + this.seq++ * 104729),
    });
    session.down(samples[0]);
    if (samples.length > 1) session.move(samples.slice(1));
    session.up();
    this.engine.endStroke(this.layer.id);
  }

  /** Flattened document pixels, premultiplied RGBA. */
  read(): Promise<Uint8Array> {
    return this.engine.readComposite({
      layers: [this.layer],
      activeLayerId: this.layer.id,
      view: { zoom: 1, panX: 0, panY: 0 },
    });
  }

  /**
   * Coverage only: the alpha channel of a stroke laid on nothing. Because
   * the ground is transparent, alpha is what the brush deposited and nothing
   * else — the number every metric is built on.
   */
  async readAlpha(): Promise<Uint8Array> {
    const rgba = await this.read();
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3];
    return out;
  }
}
