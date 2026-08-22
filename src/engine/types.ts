import type { EngineStrokeParams } from '../gpu/engine';

/**
 * What a brush stroke needs from a renderer.
 *
 * The Photoshop-parity work — spacing, dynamics, the dual train, colour
 * jitter — is pure code in `brush/dynamics.ts` and `gpu/stroke.ts`, and ends
 * as a flat list of stamp records. A renderer only has to put those on a
 * surface, which is why there can be more than one.
 */

/** Floats per stamp: x, y, radius, alpha, angle, roundness, r, g, b, flags, depthScale. */
export interface StampBatch {
  /** the colour stroke, or the dual brush's coverage mask */
  target: 'primary' | 'dual';
  records: Float32Array;
}

/** The single call `StrokeSession` makes on a renderer. */
export interface StampTarget {
  drawStampBatches(batches: StampBatch[]): void;
}

export interface PaintBackend extends StampTarget {
  readonly docWidth: number;
  readonly docHeight: number;
  ensureLayer(id: string): void;
  fillLayer(id: string, rgba: [number, number, number, number]): void;
  beginStroke(params: EngineStrokeParams): void;
  endStroke(layerId: string): void;
  /** Flattened document pixels, premultiplied RGBA8. */
  readLayer(id: string): Promise<Uint8Array>;
  /** Frees GPU/CPU resources; renderers that need no teardown may omit it. */
  destroy?(): void;
}

/**
 * `cpu` runs everything in this process — no browser, no GPU readback, which
 * is what makes a measurement loop quick. `gpu` drives the WebGPU engine in
 * headless Chromium: slower per command, and the reference the CPU renderer
 * is checked against.
 */
export type BackendId = 'cpu' | 'gpu';
