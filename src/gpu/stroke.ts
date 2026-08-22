import type { StampTarget } from '../engine/types';
import type { BrushSettings } from '../brush/types';
import {
  dualSpacingPx,
  dynamicColor,
  emitDualStamps,
  emitStamps,
  stampDiameter,
  type PointerSample,
  type StampContext,
} from '../brush/dynamics';
import { getTipAspect } from '../brush/patterns';
import { hsvToRgb, type RGB } from '../color/convert';
import type { HSV } from '../types';

export interface StrokeSessionOptions {
  fg: HSV;
  bg: HSV;
  /** injectable for deterministic tests; defaults to Math.random */
  rng?: () => number;
}

const zeroRng = () => 0;

/**
 * Turns a stream of pointer samples into brush stamps: distance-based spacing
 * (re-evaluated per stamp so pressure-driven size changes spacing too),
 * linear interpolation of pen state along segments, EMA smoothing, stroke
 * direction tracking for Direction controls, airbrush build-up, and all the
 * per-stamp dynamics (via brush/dynamics.ts).
 */
export class StrokeSession {
  private engine: StampTarget;
  private settings: BrushSettings;
  private fg: HSV;
  private bg: HSV;
  private rng: () => number;

  private last: PointerSample | null = null;
  private smoothed: PointerSample | null = null;
  private residual = 0; // distance carried since the last stamp
  private stepIndex = 0;
  private direction = 0;
  private initialDirection = 0;
  private initialDirectionSet = false;
  private strokeColor: RGB;
  /** total path length walked so far (drives the dual train positions) */
  private pathDist = 0;
  /** path distance at which the next dual mask stamp is due */
  private dualNext = 0;
  /**
   * Pending stamp batches in emission order. The dual mask gates the stroke
   * at composite time, so ordering between mask and dab batches is not
   * load-bearing; batching just keeps draw calls large.
   */
  private queue: { target: 'primary' | 'dual'; records: number[] }[] = [];
  private airbrushTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The pen-down dab, held back until the first segment establishes a stroke
   * direction. Direction is only known once the pen has moved, so emitting it
   * at pen-down would orient it along the default (rightwards) — visible as a
   * horizontal stub at the start of every curved stroke for any brush whose
   * angle follows Direction. Only deferred when a control actually needs it,
   * so plain brushes keep depositing the instant the pen lands.
   */
  private pendingDown: PointerSample | null = null;

  constructor(engine: StampTarget, settings: BrushSettings, opts: StrokeSessionOptions) {
    this.engine = engine;
    this.settings = settings;
    this.fg = opts.fg;
    this.bg = opts.bg;
    this.rng = opts.rng ?? Math.random;

    // Color Dynamics without "apply per tip" varies the color once per stroke.
    const cd = settings.color;
    this.strokeColor =
      cd.enabled && !cd.applyPerTip
        ? dynamicColor(cd, this.fg, this.bg, this.contextAt(defaultSample(0, 0, 1)), this.rng)
        : hsvToRgb(this.fg);
  }

  /** Does any dynamic read the stroke direction? */
  private usesDirection(): boolean {
    const s = this.settings;
    return [
      s.shape.sizeControl, s.shape.angleControl, s.shape.roundnessControl,
      s.scatter.scatterControl, s.transfer.opacityControl, s.transfer.flowControl,
      s.color.fgBgControl, s.texture.depthControl,
    ].some((c) => c.source === 'direction' || c.source === 'initial-direction');
  }

  /** Emits the held-back pen-down dab, now that a direction exists. */
  private flushPendingDown(): void {
    const at = this.pendingDown;
    if (!at) return;
    this.pendingDown = null;
    if (!this.initialDirectionSet) this.initialDirection = this.direction;
    this.emit(at.x, at.y, at);
  }

  private contextAt(sample: PointerSample): StampContext {
    return {
      sample,
      direction: this.direction,
      initialDirection: this.initialDirection,
      stepIndex: this.stepIndex,
    };
  }

  /** Batch records for `target`, merging with the queue tail when possible. */
  private queueFor(target: 'primary' | 'dual'): number[] {
    const tail = this.queue[this.queue.length - 1];
    if (tail && tail.target === target) return tail.records;
    const batch = { target, records: [] as number[] };
    this.queue.push(batch);
    return batch.records;
  }

  private emit(x: number, y: number, sample: PointerSample): void {
    emitStamps(
      this.settings,
      this.contextAt(sample),
      x,
      y,
      { strokeColor: this.strokeColor, fg: this.fg, bg: this.bg, rng: this.rng },
      this.queueFor('primary'),
    );
  }

  private emitDual(x: number, y: number, sample: PointerSample): void {
    const dual = this.settings.dual;
    if (!dual.enabled) return;
    emitDualStamps(dual, this.contextAt(sample), x, y, this.rng, this.queueFor('dual'));
  }

  /** Spacing distance for the current pen state (control-scaled, no jitter).
   * Like the dual train (see dualSpacingPx), Photoshop's spacing is a
   * percentage of the tip MARK's short side, so a squat sampled tip packs
   * its dabs tighter than a round tip of the same size. */
  private spacingPx(sample: PointerSample): number {
    const d = stampDiameter(this.settings, this.contextAt(sample), zeroRng);
    const aspect = getTipAspect(this.settings.tip.shape);
    return Math.max(this.settings.tip.spacing * d * aspect, 0.5);
  }

  down(sample: PointerSample): void {
    this.last = sample;
    this.smoothed = sample;
    this.residual = 0;
    this.stepIndex = 0;
    this.pathDist = 0;
    this.emitDual(sample.x, sample.y, sample);
    this.dualNext = dualSpacingPx(this.settings.dual);
    this.pendingDown = null;
    if (this.usesDirection()) {
      this.pendingDown = sample;
    } else {
      this.emit(sample.x, sample.y, sample);
    }
    this.flush();

    if (this.settings.airbrush) {
      // Build-up: keep depositing while the pointer is held, Photoshop-style.
      this.airbrushTimer = setInterval(() => {
        const at = this.smoothed;
        if (!at) return;
        // a held pen never establishes a direction; deposit it as-is
        this.flushPendingDown();
        this.stepIndex++;
        // build-up dabs reuse the existing dual mask; the train only
        // advances with pen travel
        this.emit(at.x, at.y, at);
        this.flush();
      }, 40);
    }
  }

  move(inputs: PointerSample[]): void {
    if (!this.last || !this.smoothed) return;
    // smoothing strength -> EMA blend factor (0 = raw input)
    const k = 1 - Math.min(this.settings.smoothing, 0.95) * 0.9;
    for (const raw of inputs) {
      const pt: PointerSample = {
        x: this.smoothed.x + (raw.x - this.smoothed.x) * k,
        y: this.smoothed.y + (raw.y - this.smoothed.y) * k,
        pressure: raw.pressure,
        tiltX: raw.tiltX,
        tiltY: raw.tiltY,
        twist: raw.twist,
      };
      this.smoothed = pt;
      this.segment(this.last, pt);
      this.last = pt;
    }
    this.flush();
  }

  up(): void {
    this.stopAirbrush();
    // a tap that never moved still deposits its dab, at the default direction
    this.flushPendingDown();
    this.flush();
  }

  cancel(): void {
    this.stopAirbrush();
    this.pendingDown = null;
    this.queue = [];
  }

  private stopAirbrush(): void {
    if (this.airbrushTimer !== null) {
      clearInterval(this.airbrushTimer);
      this.airbrushTimer = null;
    }
  }

  private segment(a: PointerSample, b: PointerSample): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return;

    this.direction = Math.atan2(dy, dx);
    if (!this.initialDirectionSet && dist > 1) {
      this.initialDirection = this.direction;
      this.initialDirectionSet = true;
    }
    this.flushPendingDown();

    const lerpSample = (t: number): PointerSample => ({
      x: a.x + dx * t,
      y: a.y + dy * t,
      pressure: a.pressure + (b.pressure - a.pressure) * t,
      tiltX: a.tiltX + (b.tiltX - a.tiltX) * t,
      tiltY: a.tiltY + (b.tiltY - a.tiltY) * t,
      twist: a.twist + (b.twist - a.twist) * t,
    });

    // The dual mask train walks the path at its own spacing. The mask gates
    // the stroke when it merges into the layer, so a stamp that lands after
    // some dabs still reveals them — no need to run ahead of the pen.
    if (this.settings.dual.enabled) {
      const end = this.pathDist + dist;
      const step = dualSpacingPx(this.settings.dual);
      for (let guard = 0; guard < 10000 && this.dualNext <= end; guard++) {
        const f = (this.dualNext - this.pathDist) / dist;
        const at = lerpSample(f);
        this.emitDual(at.x, at.y, at);
        this.dualNext += step;
      }
    }

    let travelled = 0;
    // Hard cap so a pathological event can't hang the tab.
    for (let guard = 0; guard < 10000; guard++) {
      const here = lerpSample(travelled / dist);
      const need = this.spacingPx(here) - this.residual;
      if (travelled + need > dist) {
        this.residual += dist - travelled;
        break;
      }
      travelled += need;
      this.residual = 0;
      this.stepIndex++;
      const at = lerpSample(travelled / dist);
      this.emit(at.x, at.y, at);
    }

    this.pathDist += dist;
  }

  private flush(): void {
    const batches = this.queue
      .filter((batch) => batch.records.length > 0)
      .map((batch) => ({ target: batch.target, records: new Float32Array(batch.records) }));
    this.queue = [];
    if (batches.length > 0) this.engine.drawStampBatches(batches);
  }
}

function defaultSample(x: number, y: number, pressure: number): PointerSample {
  return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0 };
}
