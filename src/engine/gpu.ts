import type { EngineStrokeParams, PaintEngine } from '../gpu/engine';
import type { PaintBackend, StampBatch } from './types';

/**
 * The WebGPU engine behind the common renderer interface.
 *
 * Thin on purpose: `PaintEngine` already does all of this, and the only
 * reason for a wrapper is that it also does a great deal the harness does
 * not need — layers, groups, selections, transforms, undo. Reading goes
 * straight to the layer texture rather than through the compositor, which
 * for a one-layer surface is the same pixels and one pass less.
 */
export class GpuBackend implements PaintBackend {
  private engine: PaintEngine;

  constructor(engine: PaintEngine) {
    this.engine = engine;
  }

  get docWidth(): number {
    return this.engine.docWidth;
  }

  get docHeight(): number {
    return this.engine.docHeight;
  }

  ensureLayer(id: string): void {
    this.engine.ensureLayer(id);
  }

  fillLayer(id: string, rgba: [number, number, number, number]): void {
    this.engine.fillLayer(id, rgba);
  }

  beginStroke(params: EngineStrokeParams): void {
    this.engine.beginStroke(params);
  }

  drawStampBatches(batches: StampBatch[]): void {
    this.engine.drawStampBatches(batches);
  }

  endStroke(layerId: string): void {
    this.engine.endStroke(layerId);
  }

  readLayer(id: string): Promise<Uint8Array> {
    return this.engine.readLayerPixels(id);
  }

  /**
   * Each surface asks for its own device — `PaintEngine.create` has no way
   * to share one — so a multi-brush plate opens several. Releasing each as
   * its surface finishes keeps that from piling up against the browser's
   * limit on live devices.
   */
  destroy(): void {
    this.engine.device.destroy();
  }
}
