import {
  COMMIT_SHADER,
  COMPOSITE_SHADER,
  FILL_SHADER,
  PRESENT_SHADER,
  STAMP_SHADER,
  TRANSFORM_SHADER,
} from './shaders';
import type { Mat3 } from '../transform/matrix';
import { BLEND_MODE_INDEX, type BlendMode, type LayerMeta, type Viewport } from '../types';
import {
  TEXTURE_BLEND_INDEX,
  type DualBrush,
  type PatternId,
  type TextureBlend,
  type TipShape,
} from '../brush/types';
import { getPattern, getTip } from '../brush/patterns';
import { readTextureRegion, uploadBuffer, uploadTexture } from './transfer';
import { STAMP_FLOATS } from '../brush/dynamics';

export interface EngineTextureParams {
  pattern: PatternId;
  /** pattern tile size in document pixels */
  scalePx: number;
  brightness: number;
  contrast: number;
  invert: boolean;
  depth: number;
  mode: TextureBlend;
  /** apply per stamp (true) or once over the whole stroke (false) */
  eachTip: boolean;
}

export interface EngineStrokeParams {
  mode: 'paint' | 'erase';
  /** stroke-level opacity cap, 0..1 */
  opacity: number;
  /** paint blending mode against the layer */
  blendMode: BlendMode;
  /** 0..1, for the analytic round tip */
  hardness: number;
  tipShape: TipShape;
  wetEdges: boolean;
  noise: boolean;
  texture: EngineTextureParams | null;
  dual: DualBrush | null;
  /** Lock Transparent Pixels: the stroke cannot change the layer's alpha */
  lockTransparent: boolean;
}

export interface RenderState {
  layers: LayerMeta[]; // bottom -> top
  activeLayerId: string;
  view: Viewport;
}

interface HistoryEntry {
  layerId: string;
  data: Promise<Uint8Array<ArrayBuffer>>;
}

const MAX_HISTORY = 24;
const UNIFORM_SLICE = 256;
export const MAX_LAYERS = 64;
const LAYER_U_SIZE = 80;
const STAMP_STRIDE = STAMP_FLOATS * 4; // bytes

export class PaintEngine {
  readonly device: GPUDevice;
  private _docWidth: number;
  private _docHeight: number;

  get docWidth(): number {
    return this._docWidth;
  }

  get docHeight(): number {
    return this._docHeight;
  }

  /**
   * Kept alive on purpose: if the GPUAdapter is garbage-collected, some
   * Chromium builds drop the underlying Dawn instance and every
   * queue.writeBuffer/writeTexture/mapAsync starts failing with "A valid
   * external Instance reference no longer exists".
   */
  private adapter: GPUAdapter | null = null;

  private context: GPUCanvasContext;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;

  private layers = new Map<string, GPUTexture>();
  private accum: [GPUTexture, GPUTexture];
  private scratch: GPUTexture;
  private strokeTex: GPUTexture;
  private dualStrokeTex: GPUTexture;
  private selectionTex: GPUTexture | null = null;
  private whiteTex: GPUTexture;

  private patternTextures = new Map<string, GPUTexture>();

  private compositePipeline: GPURenderPipeline;
  private stampPipeline: GPURenderPipeline;
  private stampPipelineDual: GPURenderPipeline;
  private commitPipeline: GPURenderPipeline;
  private fillPipeline: GPURenderPipeline;
  private transformPipeline: GPURenderPipeline;
  private presentPipeline: GPURenderPipeline;

  private layerUniforms: GPUBuffer;
  private stampUniforms: GPUBuffer;
  private dualStampUniforms: GPUBuffer;
  private commitUniforms: GPUBuffer;
  private fillUniforms: GPUBuffer;
  private transformUniforms: GPUBuffer;
  private viewUniforms: GPUBuffer;

  private sampLinear: GPUSampler;
  private sampNearest: GPUSampler;
  private sampRepeat: GPUSampler;

  private instanceBuf: GPUBuffer;
  private instanceCapacity = 4096; // stamps

  private stroke: EngineStrokeParams | null = null;
  /** pristine copy of the layer being interactively transformed */
  private transformSrc: GPUTexture | null = null;
  private transformLayerId: string | null = null;
  private transformUndoData: Promise<Uint8Array<ArrayBuffer>> | null = null;
  private strokeTipTex: GPUTexture | null = null;
  private strokePatternTex: GPUTexture | null = null;
  private strokeDualTipTex: GPUTexture | null = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void = () => {};

  /**
   * Set whenever GPU content changes (strokes, fills, layer edits, undo,
   * selection, resize). The render loop consumes it to skip re-compositing
   * frames where nothing moved — layer/view changes are tracked separately
   * by the caller since they live in the store, not the engine.
   */
  private dirty = true;

  markDirty(): void {
    this.dirty = true;
  }

  /** Returns whether a re-render is due, and arms the next frame as clean. */
  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    docWidth: number,
    docHeight: number,
  ) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.format = format;
    this._docWidth = docWidth;
    this._docHeight = docHeight;

    this.accum = [
      this.makeDocTexture('rgba8unorm', 'accumA'),
      this.makeDocTexture('rgba8unorm', 'accumB'),
    ];
    this.scratch = this.makeDocTexture('rgba8unorm', 'scratch');
    this.strokeTex = this.makeDocTexture('rgba8unorm', 'stroke');
    this.dualStrokeTex = this.makeDocTexture('r8unorm', 'dualStroke');

    this.whiteTex = device.createTexture({
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    uploadTexture(this.device, this.whiteTex, new Uint8Array([255]), 1, 1, 1);

    this.sampLinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.sampNearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.sampRepeat = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    this.layerUniforms = device.createBuffer({
      size: UNIFORM_SLICE * MAX_LAYERS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stampUniforms = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dualStampUniforms = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.commitUniforms = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.fillUniforms = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.transformUniforms = device.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewUniforms = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.instanceBuf = device.createBuffer({
      size: this.instanceCapacity * STAMP_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // --- pipelines ---

    const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });
    this.compositePipeline = device.createRenderPipeline({
      label: 'composite',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
              { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform', hasDynamicOffset: true },
              },
              { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
              { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            ],
          }),
        ],
      }),
      vertex: { module: compositeModule, entryPoint: 'vs' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const stampModule = device.createShaderModule({ code: STAMP_SHADER });
    const stampVertex: GPUVertexState = {
      module: stampModule,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: STAMP_STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // center
            { shaderLocation: 1, offset: 8, format: 'float32' }, // radius
            { shaderLocation: 2, offset: 12, format: 'float32' }, // alpha
            { shaderLocation: 3, offset: 16, format: 'float32' }, // angle
            { shaderLocation: 4, offset: 20, format: 'float32' }, // roundness
            { shaderLocation: 5, offset: 24, format: 'float32x3' }, // color
            { shaderLocation: 6, offset: 36, format: 'float32' }, // flags
            { shaderLocation: 7, offset: 40, format: 'float32' }, // depthScale
          ],
        },
      ],
    };
    const overBlend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const makeStampPipeline = (label: string, target: GPUTextureFormat) =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: stampVertex,
        fragment: {
          module: stampModule,
          entryPoint: 'fs',
          targets: [{ format: target, blend: overBlend }],
        },
        primitive: { topology: 'triangle-strip' },
      });
    // primary stamps accumulate premultiplied color; dual-brush stamps
    // accumulate a single-channel coverage mask
    this.stampPipeline = makeStampPipeline('stamp', 'rgba8unorm');
    this.stampPipelineDual = makeStampPipeline('stamp-dual', 'r8unorm');

    this.commitPipeline = this.makeFullscreenPipeline('commit', COMMIT_SHADER, 'rgba8unorm');
    this.fillPipeline = this.makeFullscreenPipeline('fill', FILL_SHADER, 'rgba8unorm');
    this.transformPipeline = this.makeFullscreenPipeline(
      'transform',
      TRANSFORM_SHADER,
      'rgba8unorm',
    );
    this.presentPipeline = this.makeFullscreenPipeline('present', PRESENT_SHADER, format);

    this.clearTexture(this.strokeTex);
  }

  /** Fullscreen-triangle pipeline with an auto layout (all passes but the
   * compositor, which needs a dynamic-offset uniform binding). */
  private makeFullscreenPipeline(
    label: string,
    code: string,
    format: GPUTextureFormat,
  ): GPURenderPipeline {
    const module = this.device.createShaderModule({ code });
    return this.device.createRenderPipeline({
      label,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    docWidth: number,
    docHeight: number,
  ): Promise<PaintEngine> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not available in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter found.');
    }
    const device = await adapter.requestDevice();
    void device.lost.then((info) => {
      console.error(`[northlight] WebGPU device lost (${info.reason}): ${info.message}`);
    });
    device.addEventListener('uncapturederror', (e) => {
      console.error('[northlight] WebGPU error:', (e as GPUUncapturedErrorEvent).error.message);
    });
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Could not create a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const engine = new PaintEngine(device, canvas, context, format, docWidth, docHeight);
    engine.adapter = adapter;
    void engine.adapter; // referenced only to pin the adapter's lifetime
    return engine;
  }

  // -------------------------------------------------------------------------
  // Uploads (see transfer.ts for the staging-buffer rationale)
  // -------------------------------------------------------------------------

  /** Cached single-channel texture for patterns / tip shapes / dual tiles. */
  private grayTexture(key: string, make: () => { size: number; data: Uint8Array }): GPUTexture {
    let tex = this.patternTextures.get(key);
    if (!tex) {
      const map = make();
      tex = this.device.createTexture({
        label: `gray:${key}`,
        size: [map.size, map.size],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      uploadTexture(this.device, tex, map.data, map.size, map.size, 1);
      this.patternTextures.set(key, tex);
    }
    return tex;
  }

  // -------------------------------------------------------------------------
  // Layer management
  // -------------------------------------------------------------------------

  private makeDocTexture(format: GPUTextureFormat, label: string): GPUTexture {
    return this.device.createTexture({
      label,
      size: [this._docWidth, this._docHeight],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }

  ensureLayer(id: string): void {
    if (this.layers.has(id)) return;
    const tex = this.makeDocTexture('rgba8unorm', `layer:${id}`);
    this.layers.set(id, tex);
    this.clearTexture(tex);
    this.markDirty();
  }

  fillLayer(id: string, rgba: [number, number, number, number]): void {
    const tex = this.layers.get(id);
    if (!tex) return;
    this.clearTexture(tex, rgba);
    this.markDirty();
  }

  deleteLayer(id: string): void {
    const tex = this.layers.get(id);
    if (tex) {
      tex.destroy();
      this.layers.delete(id);
    }
    this.markDirty();
    this.undoStack = this.undoStack.filter((e) => e.layerId !== id);
    this.redoStack = this.redoStack.filter((e) => e.layerId !== id);
    this.notifyHistory();
  }

  copyLayer(srcId: string, dstId: string): void {
    this.ensureLayer(dstId);
    const src = this.layers.get(srcId);
    const dst = this.layers.get(dstId);
    if (!src || !dst) return;
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: src }, { texture: dst }, [
      this.docWidth,
      this.docHeight,
    ]);
    this.device.queue.submit([enc.finish()]);    this.markDirty();
  }

  /** Clears the stroke and dual-mask textures with a single submit. */
  private clearStrokeTextures(): void {
    const enc = this.device.createCommandEncoder();
    for (const tex of [this.strokeTex, this.dualStrokeTex]) {
      const pass = enc.beginRenderPass({
        colorAttachments: [
          { view: tex.createView(), loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
  }

  private clearTexture(
    tex: GPUTexture,
    rgba: [number, number, number, number] = [0, 0, 0, 0],
  ): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] },
        },
      ],
    });
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /** `mask` is a doc-sized, single-channel coverage bitmap, or null to clear. */
  setSelectionMask(mask: Uint8Array<ArrayBuffer> | null): void {
    this.stampBindGroups = null; // stamps sample the selection texture
    this.markDirty();
    if (!mask) {
      this.selectionTex?.destroy();
      this.selectionTex = null;
      return;
    }
    if (!this.selectionTex) {
      this.selectionTex = this.device.createTexture({
        label: 'selection',
        size: [this.docWidth, this.docHeight],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    uploadTexture(this.device, this.selectionTex, mask, this.docWidth, this.docHeight, 1);
  }

  // -------------------------------------------------------------------------
  // Strokes
  // -------------------------------------------------------------------------

  /**
   * Writes the WGSL MergeU block (12 words) at `word` into a uniform slice.
   * The single source of truth for the stroke->layer merge layout, shared by
   * the compositor's LayerU and the commit pass's CommitU.
   */
  private static fillMergeFields(
    f: Float32Array,
    u: Uint32Array,
    word: number,
    stroke: EngineStrokeParams,
  ): void {
    const tex = stroke.texture;
    u[word] = BLEND_MODE_INDEX[stroke.blendMode] ?? 0;
    f[word + 1] = stroke.opacity;
    f[word + 2] = stroke.wetEdges ? 1 : 0;
    f[word + 3] = tex && !tex.eachTip ? 1 : 0;
    f[word + 4] = tex ? tex.scalePx : 256;
    u[word + 5] = tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0;
    f[word + 6] = stroke.dual ? 1 : 0;
    u[word + 7] = stroke.dual ? TEXTURE_BLEND_INDEX[stroke.dual.mode] : 0;
    f[word + 8] = tex ? tex.brightness : 0;
    f[word + 9] = tex ? tex.contrast : 0;
    f[word + 10] = tex && tex.invert ? 1 : 0;
    f[word + 11] = tex ? tex.depth : 1;
  }

  /**
   * Writes one LayerU slice (used by the compositor per layer, and by
   * mergeDown for the single merge pass): layer blend/opacity, the live
   * stroke's mode + Lock Transparent Pixels flag, doc size, and the stroke
   * merge block when a stroke is active on this layer.
   */
  private writeLayerSlice(
    buf: ArrayBuffer,
    offset: number,
    blendMode: BlendMode,
    opacity: number,
    stroke: EngineStrokeParams | null,
  ): void {
    const f = new Float32Array(buf, offset, LAYER_U_SIZE / 4);
    const u = new Uint32Array(buf, offset, LAYER_U_SIZE / 4);
    u[0] = BLEND_MODE_INDEX[blendMode] ?? 0;
    f[1] = opacity;
    u[2] = stroke ? (stroke.mode === 'erase' ? 2 : 1) : 0;
    f[3] = stroke?.lockTransparent ? 1 : 0;
    f[4] = this._docWidth;
    f[5] = this._docHeight;
    if (stroke) PaintEngine.fillMergeFields(f, u, 8, stroke);
  }

  /** StampU layout shared by the primary and dual stamp passes. */
  private fillStampUniforms(
    target: GPUBuffer,
    hardness: number,
    tipTextured: boolean,
    tex: EngineTextureParams | null,
    noise: boolean,
  ): void {
    const u = new ArrayBuffer(64);
    const f = new Float32Array(u);
    const i = new Uint32Array(u);
    f[0] = this.docWidth;
    f[1] = this.docHeight;
    f[2] = hardness;
    f[3] = tipTextured ? 1 : 0;
    f[4] = tex && tex.eachTip ? 1 : 0;
    f[5] = tex ? tex.scalePx : 256;
    f[6] = noise ? 1 : 0;
    i[7] = tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0;
    f[8] = tex ? tex.brightness : 0;
    f[9] = tex ? tex.contrast : 0;
    f[10] = tex && tex.invert ? 1 : 0;
    f[11] = tex ? tex.depth : 1;
    uploadBuffer(this.device, target, 0, u);
  }

  beginStroke(params: EngineStrokeParams): void {
    this.stroke = params;
    this.markDirty();
    this.stampBindGroups = null; // tip/pattern textures change per stroke
    this.clearStrokeTextures();

    this.strokeTipTex =
      params.tipShape === 'round'
        ? null
        : this.grayTexture(`tip:${params.tipShape}`, () => getTip(params.tipShape));
    this.strokePatternTex = params.texture
      ? this.grayTexture(`pat:${params.texture.pattern}`, () => getPattern(params.texture!.pattern))
      : null;
    this.strokeDualTipTex =
      params.dual && params.dual.shape !== 'round'
        ? this.grayTexture(`tip:${params.dual.shape}`, () => getTip(params.dual!.shape))
        : null;

    this.fillStampUniforms(
      this.stampUniforms,
      params.hardness,
      params.tipShape !== 'round',
      params.texture,
      params.noise,
    );
    if (params.dual) {
      this.fillStampUniforms(
        this.dualStampUniforms,
        params.dual.hardness,
        params.dual.shape !== 'round',
        null,
        false,
      );
    }
  }

  get strokeActive(): boolean {
    return this.stroke !== null;
  }

  get currentStroke(): EngineStrokeParams | null {
    return this.stroke;
  }

  /**
   * Bind groups for the stamp passes. Their inputs only change when a stroke
   * begins (tip/pattern textures), the selection mask changes, or the doc is
   * resized, so they are cached and rebuilt lazily instead of per draw.
   */
  private stampBindGroups: { primary: GPUBindGroup; dual: GPUBindGroup } | null = null;

  private ensureStampBindGroups(): { primary: GPUBindGroup; dual: GPUBindGroup } {
    if (this.stampBindGroups) return this.stampBindGroups;
    const white = this.whiteTex.createView();
    const selection = (this.selectionTex ?? this.whiteTex).createView();
    const make = (dual: boolean) =>
      this.device.createBindGroup({
        layout: (dual ? this.stampPipelineDual : this.stampPipeline).getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: { buffer: dual ? this.dualStampUniforms : this.stampUniforms },
          },
          { binding: 1, resource: selection },
          { binding: 2, resource: this.sampLinear },
          {
            binding: 3,
            resource: (dual ? this.strokeDualTipTex : this.strokeTipTex)?.createView() ?? white,
          },
          { binding: 4, resource: this.strokePatternTex?.createView() ?? white },
          { binding: 5, resource: this.sampRepeat },
        ],
      });
    this.stampBindGroups = { primary: make(false), dual: make(true) };
    return this.stampBindGroups;
  }

  /**
   * Draws stamp batches in order with one instance upload and one queue
   * submit for the lot. `records` are packed STAMP_FLOATS-sized instances;
   * `target` selects the primary color stroke or the dual coverage mask.
   */
  drawStampBatches(
    batches: { target: 'primary' | 'dual'; records: Float32Array }[],
  ): void {
    if (!this.stroke) return;
    const totalFloats = batches.reduce((n, b) => n + b.records.length, 0);
    const total = totalFloats / STAMP_FLOATS;
    if (total === 0) return;
    this.markDirty();

    if (total > this.instanceCapacity) {
      while (this.instanceCapacity < total) this.instanceCapacity *= 2;
      this.instanceBuf.destroy();
      this.instanceBuf = this.device.createBuffer({
        size: this.instanceCapacity * STAMP_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const combined = new Float32Array(totalFloats);
    let writeAt = 0;
    for (const b of batches) {
      combined.set(b.records, writeAt);
      writeAt += b.records.length;
    }
    uploadBuffer(this.device, this.instanceBuf, 0, combined);

    const groups = this.ensureStampBindGroups();
    const enc = this.device.createCommandEncoder();
    let byteOffset = 0;
    for (const b of batches) {
      const count = b.records.length / STAMP_FLOATS;
      if (count === 0) continue;
      const dual = b.target === 'dual';
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: (dual ? this.dualStrokeTex : this.strokeTex).createView(),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(dual ? this.stampPipelineDual : this.stampPipeline);
      pass.setVertexBuffer(0, this.instanceBuf, byteOffset);
      pass.setBindGroup(0, dual ? groups.dual : groups.primary);
      pass.draw(4, count);
      pass.end();
      byteOffset += b.records.length * 4;
    }
    this.device.queue.submit([enc.finish()]);
  }

  /** Single-batch convenience over drawStampBatches. */
  drawStamps(
    instances: Float32Array<ArrayBuffer>,
    count: number,
    target: 'primary' | 'dual' = 'primary',
  ): void {
    this.drawStampBatches([{ target, records: instances.subarray(0, count * STAMP_FLOATS) }]);
  }

  /**
   * Runs one fullscreen pass into the scratch texture and copies the result
   * into `dst` — the pattern for every pass that rewrites a layer in place
   * (a texture cannot be sampled while it is the render target).
   */
  private renderViaScratch(
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    dst: GPUTexture,
    dynamicOffsets?: number[],
  ): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.scratch.createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    if (dynamicOffsets) {
      pass.setBindGroup(0, bindGroup, dynamicOffsets);
    } else {
      pass.setBindGroup(0, bindGroup);
    }
    pass.draw(3);
    pass.end();
    enc.copyTextureToTexture(
      { texture: this.scratch },
      { texture: dst },
      [this._docWidth, this._docHeight],
    );
    this.device.queue.submit([enc.finish()]);    this.markDirty();
  }

  /** Bakes the stroke into the layer and records an undo snapshot. */
  endStroke(layerId: string): void {
    const stroke = this.stroke;
    this.stroke = null;
    const layer = this.layers.get(layerId);
    if (!stroke || !layer) return;

    // Snapshot the pre-stroke pixels for undo (read is enqueued before the
    // commit pass below, so it captures the old contents).
    this.pushUndo(layerId);

    // CommitU: mode, pad, docSize, merge block
    const u = new ArrayBuffer(64);
    const f = new Float32Array(u);
    const i = new Uint32Array(u);
    i[0] = stroke.mode === 'erase' ? 2 : 1;
    f[1] = stroke.lockTransparent ? 1 : 0;
    f[2] = this.docWidth;
    f[3] = this.docHeight;
    PaintEngine.fillMergeFields(f, i, 4, stroke);
    uploadBuffer(this.device, this.commitUniforms, 0, u);

    const bindGroup = this.device.createBindGroup({
      layout: this.commitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampNearest },
        { binding: 1, resource: layer.createView() },
        { binding: 2, resource: this.strokeTex.createView() },
        { binding: 3, resource: { buffer: this.commitUniforms } },
        { binding: 4, resource: (this.strokePatternTex ?? this.whiteTex).createView() },
        { binding: 5, resource: this.sampRepeat },
        { binding: 6, resource: this.dualStrokeTex.createView() },
      ],
    });

    this.renderViaScratch(this.commitPipeline, bindGroup, layer);
    this.clearStrokeTextures();
  }

  cancelStroke(): void {
    this.stroke = null;
    this.clearStrokeTextures();
    this.markDirty();
  }

  /**
   * Fills the layer with an opaque color, or clears it to transparency when
   * `color` is null. Restricted to the current selection mask when one is
   * set; covers the whole layer otherwise. `preserveTransparency` is Lock
   * Transparent Pixels: recolor existing coverage without touching alpha.
   * Records an undo snapshot.
   */
  fillRegion(
    layerId: string,
    color: [number, number, number] | null,
    preserveTransparency = false,
  ): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    this.pushUndo(layerId);

    const u = new ArrayBuffer(32);
    const f = new Float32Array(u);
    const i = new Uint32Array(u);
    if (color) {
      f[0] = color[0];
      f[1] = color[1];
      f[2] = color[2];
      f[3] = 1;
      i[4] = 1;
    } else {
      i[4] = 2;
    }
    f[5] = preserveTransparency ? 1 : 0;
    uploadBuffer(this.device, this.fillUniforms, 0, u);

    const bindGroup = this.device.createBindGroup({
      layout: this.fillPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampNearest },
        { binding: 1, resource: layer.createView() },
        { binding: 2, resource: (this.selectionTex ?? this.whiteTex).createView() },
        { binding: 3, resource: { buffer: this.fillUniforms } },
      ],
    });

    this.renderViaScratch(this.fillPipeline, bindGroup, layer);
  }

  // -------------------------------------------------------------------------
  // Transforms (move tool, free transform, image/canvas resize)
  // -------------------------------------------------------------------------

  /** Samples `src` through `hInv` (dst doc px -> src px) into `dst`. */
  private renderTransform(opts: {
    src: GPUTexture;
    srcW: number;
    srcH: number;
    dst: GPUTexture;
    dstW: number;
    dstH: number;
    hInv: Mat3;
    withSelection?: boolean;
    duplicate?: boolean;
    bgFill?: [number, number, number] | null;
  }): void {
    const u = new ArrayBuffer(96);
    const f = new Float32Array(u);
    const h = opts.hInv;
    f[0] = h[0]; f[1] = h[1]; f[2] = h[2];
    f[4] = h[3]; f[5] = h[4]; f[6] = h[5];
    f[8] = h[6]; f[9] = h[7]; f[10] = h[8];
    f[12] = opts.dstW;
    f[13] = opts.dstH;
    f[14] = opts.srcW;
    f[15] = opts.srcH;
    f[16] = opts.withSelection && this.selectionTex ? 1 : 0;
    f[17] = opts.duplicate ? 1 : 0;
    f[18] = opts.bgFill ? 1 : 0;
    if (opts.bgFill) {
      f[20] = opts.bgFill[0];
      f[21] = opts.bgFill[1];
      f[22] = opts.bgFill[2];
      f[23] = 1;
    }
    uploadBuffer(this.device, this.transformUniforms, 0, u);

    const bindGroup = this.device.createBindGroup({
      layout: this.transformPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampLinear },
        { binding: 1, resource: opts.src.createView() },
        { binding: 2, resource: (this.selectionTex ?? this.whiteTex).createView() },
        { binding: 3, resource: { buffer: this.transformUniforms, size: 96 } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: opts.dst.createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(this.transformPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);    this.markDirty();
  }

  /**
   * Starts an interactive transform of a layer: snapshots its pixels so every
   * preview resamples the pristine source (no cumulative degradation).
   */
  beginTransform(layerId: string): boolean {
    const layer = this.layers.get(layerId);
    if (!layer || this.transformSrc) return false;
    this.transformUndoData = this.readLayer(layerId);
    const src = this.makeDocTexture('rgba8unorm', 'transformSrc');
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: layer }, { texture: src }, [
      this._docWidth,
      this._docHeight,
    ]);
    this.device.queue.submit([enc.finish()]);
    this.transformSrc = src;
    this.transformLayerId = layerId;
    return true;
  }

  get transformActive(): boolean {
    return this.transformSrc !== null;
  }

  /** Re-renders the layer from the snapshot through `hInv` (dst -> src). */
  previewTransform(
    hInv: Mat3,
    opts: { withSelection: boolean; duplicate: boolean; bgFill: [number, number, number] | null },
  ): void {
    if (!this.transformSrc || !this.transformLayerId) return;
    const layer = this.layers.get(this.transformLayerId);
    if (!layer) return;
    this.renderTransform({
      src: this.transformSrc,
      srcW: this._docWidth,
      srcH: this._docHeight,
      dst: layer,
      dstW: this._docWidth,
      dstH: this._docHeight,
      hInv,
      ...opts,
    });
  }

  /** Commits (records undo) or cancels (restores the snapshot). */
  endTransform(commit: boolean): void {
    if (!this.transformSrc || !this.transformLayerId) return;
    const layer = this.layers.get(this.transformLayerId);
    if (!commit && layer) {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture({ texture: this.transformSrc }, { texture: layer }, [
        this._docWidth,
        this._docHeight,
      ]);
      this.device.queue.submit([enc.finish()]);
    }
    if (commit && layer && this.transformUndoData) {
      this.undoStack.push({ layerId: this.transformLayerId, data: this.transformUndoData });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.notifyHistory();
    }
    this.transformSrc.destroy();
    this.transformSrc = null;
    this.transformLayerId = null;
    this.transformUndoData = null;
    this.markDirty();
  }

  /**
   * Resizes the document. `hInv` maps new-document pixels back to old-document
   * pixels (scale for Image Size, translation for Canvas Size / Crop, rotation
   * for Image Rotation); null discards the old content. `bgFill` supplies an
   * opaque backing color per layer (the Background layer's extension color).
   * History snapshots have the old dimensions, so history is cleared.
   */
  resizeDocument(
    width: number,
    height: number,
    hInv: Mat3 | null,
    bgFill: (layerId: string) => [number, number, number] | null = () => null,
  ): void {
    const oldW = this._docWidth;
    const oldH = this._docHeight;
    this._docWidth = width;
    this._docHeight = height;

    // selection mask no longer matches; drop it before transform renders
    this.selectionTex?.destroy();
    this.selectionTex = null;

    for (const [id, oldTex] of [...this.layers]) {
      const newTex = this.makeDocTexture('rgba8unorm', `layer:${id}`);
      this.layers.set(id, newTex);
      if (hInv) {
        this.renderTransform({
          src: oldTex,
          srcW: oldW,
          srcH: oldH,
          dst: newTex,
          dstW: width,
          dstH: height,
          hInv,
          bgFill: bgFill(id),
        });
      } else {
        this.clearTexture(newTex);
      }
      oldTex.destroy();
    }

    for (const t of this.accum) t.destroy();
    this.scratch.destroy();
    this.strokeTex.destroy();
    this.dualStrokeTex.destroy();
    this.accum = [
      this.makeDocTexture('rgba8unorm', 'accumA'),
      this.makeDocTexture('rgba8unorm', 'accumB'),
    ];
    this.scratch = this.makeDocTexture('rgba8unorm', 'scratch');
    this.strokeTex = this.makeDocTexture('rgba8unorm', 'stroke');
    this.dualStrokeTex = this.makeDocTexture('r8unorm', 'dualStroke');
    this.stampBindGroups = null; // stamps render into the recreated textures
    this.clearStrokeTextures();

    this.undoStack = [];
    this.redoStack = [];
    this.notifyHistory();
    this.markDirty();
  }

  /**
   * Merges `topId` into `bottomId` using the top layer's blend mode and
   * opacity (Layer > Merge Down). Records an undo snapshot of the bottom
   * layer; the top layer should be deleted by the caller afterwards.
   */
  mergeDown(topId: string, bottomId: string, opacity: number, blendMode: BlendMode): void {
    const top = this.layers.get(topId);
    const bottom = this.layers.get(bottomId);
    if (!top || !bottom) return;
    this.pushUndo(bottomId);

    const buf = new ArrayBuffer(UNIFORM_SLICE);
    this.writeLayerSlice(buf, 0, blendMode, opacity, null);
    uploadBuffer(this.device, this.layerUniforms, 0, buf);

    const white = this.whiteTex.createView();
    const bindGroup = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampNearest },
        { binding: 1, resource: bottom.createView() },
        { binding: 2, resource: top.createView() },
        { binding: 3, resource: this.strokeTex.createView() },
        { binding: 4, resource: { buffer: this.layerUniforms, size: LAYER_U_SIZE } },
        { binding: 5, resource: white },
        { binding: 6, resource: this.sampRepeat },
        { binding: 7, resource: this.dualStrokeTex.createView() },
      ],
    });
    this.renderViaScratch(this.compositePipeline, bindGroup, bottom, [0]);
  }

  /** Replaces a layer's pixels with doc-sized premultiplied RGBA data. */
  putLayerImage(id: string, data: Uint8Array, width: number, height: number): void {
    if (width !== this._docWidth || height !== this._docHeight) return;
    this.ensureLayer(id);
    uploadTexture(this.device, this.layers.get(id)!, data, width, height, 4);    this.markDirty();
  }

  /** Raw premultiplied RGBA pixels of one layer (for bounds / flatten). */
  readLayerPixels(id: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.readLayer(id);
  }

  /**
   * Averages a size x size block of pixels centered on a document coordinate
   * (eyedropper). `source` picks a single layer texture or a fresh composite
   * of the given render state. Returns straight (un-premultiplied) RGB in
   * 0..1 plus average coverage, or null when the block is fully transparent
   * or entirely outside the document.
   */
  async sampleColor(
    x: number,
    y: number,
    size: number,
    source: { layerId: string } | { state: RenderState },
  ): Promise<{ r: number; g: number; b: number; a: number } | null> {
    let tex: GPUTexture | undefined;
    if ('layerId' in source) {
      tex = this.layers.get(source.layerId);
    } else {
      const enc = this.device.createCommandEncoder();
      tex = this.composite(enc, source.state);
      this.device.queue.submit([enc.finish()]);
    }
    if (!tex) return null;

    const half = Math.floor(size / 2);
    const x0 = Math.max(0, Math.round(x) - half);
    const y0 = Math.max(0, Math.round(y) - half);
    const x1 = Math.min(this.docWidth, Math.round(x) - half + size);
    const y1 = Math.min(this.docHeight, Math.round(y) - half + size);
    if (x1 <= x0 || y1 <= y0) return null;
    const w = x1 - x0;
    const h = y1 - y0;

    const data = await readTextureRegion(this.device, tex, x0, y0, w, h);
    if (data.length === 0) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = 0; i < w * h; i++) {
      r += data[i * 4];
      g += data[i * 4 + 1];
      b += data[i * 4 + 2];
      a += data[i * 4 + 3];
    }
    if (a <= 0) return null;
    // premultiplied: un-premultiply the alpha-weighted average
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    return {
      r: clamp01(r / a),
      g: clamp01(g / a),
      b: clamp01(b / a),
      a: clamp01(a / (255 * w * h)),
    };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private pushUndo(layerId: string): void {
    this.undoStack.push({ layerId, data: this.readLayer(layerId) });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.notifyHistory();
  }

  async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) return;
    if (!this.layers.has(entry.layerId)) {
      this.notifyHistory();
      return;
    }
    this.redoStack.push({ layerId: entry.layerId, data: this.readLayer(entry.layerId) });
    const data = await entry.data;
    this.writeLayer(entry.layerId, data);
    this.notifyHistory();
  }

  async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (!entry) return;
    if (!this.layers.has(entry.layerId)) {
      this.notifyHistory();
      return;
    }
    this.undoStack.push({ layerId: entry.layerId, data: this.readLayer(entry.layerId) });
    const data = await entry.data;
    this.writeLayer(entry.layerId, data);
    this.notifyHistory();
  }

  private notifyHistory(): void {
    this.onHistoryChange(this.undoStack.length > 0, this.redoStack.length > 0);
  }

  private readLayer(layerId: string): Promise<Uint8Array<ArrayBuffer>> {
    const layer = this.layers.get(layerId);
    if (!layer) return Promise.resolve(new Uint8Array(0));
    return this.readTexture(layer, this.docWidth, this.docHeight);
  }

  private readTexture(
    tex: GPUTexture,
    w: number,
    h: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return readTextureRegion(this.device, tex, 0, 0, w, h);
  }

  private writeLayer(layerId: string, data: Uint8Array<ArrayBuffer>): void {
    const layer = this.layers.get(layerId);
    if (!layer || data.length === 0) return;
    uploadTexture(this.device, layer, data, this.docWidth, this.docHeight, 4);    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  resize(): boolean {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      return true;
    }
    return false;
  }

  /** Runs the layer compositor into an accum texture and returns it. */
  private composite(enc: GPUCommandEncoder, state: RenderState): GPUTexture {
    const visible = state.layers.filter((l) => this.layers.has(l.id));

    // Write all per-layer uniform slices in one go.
    const buf = new ArrayBuffer(UNIFORM_SLICE * Math.max(1, visible.length));
    visible.forEach((meta, idx) => {
      const strokeHere =
        this.stroke !== null && meta.id === state.activeLayerId && meta.visible;
      this.writeLayerSlice(
        buf,
        idx * UNIFORM_SLICE,
        meta.blendMode,
        meta.opacity,
        strokeHere ? this.stroke : null,
      );
    });
    uploadBuffer(this.device, this.layerUniforms, 0, buf);

    // Clear the first accumulation target.
    let read = 0;
    const clearPass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.accum[read].createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    clearPass.end();

    const patternView = (this.strokePatternTex ?? this.whiteTex).createView();
    visible.forEach((meta, idx) => {
      if (!meta.visible) return;
      const layerTex = this.layers.get(meta.id)!;
      const bindGroup = this.device.createBindGroup({
        layout: this.compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampNearest },
          { binding: 1, resource: this.accum[read].createView() },
          { binding: 2, resource: layerTex.createView() },
          { binding: 3, resource: this.strokeTex.createView() },
          { binding: 4, resource: { buffer: this.layerUniforms, size: LAYER_U_SIZE } },
          { binding: 5, resource: patternView },
          { binding: 6, resource: this.sampRepeat },
          { binding: 7, resource: this.dualStrokeTex.createView() },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.accum[1 - read].createView(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, bindGroup, [idx * UNIFORM_SLICE]);
      pass.draw(3);
      pass.end();
      read = 1 - read;
    });

    return this.accum[read];
  }

  private encodePresent(
    enc: GPUCommandEncoder,
    accum: GPUTexture,
    view: Viewport,
    target: GPUTextureView,
    viewW: number,
    viewH: number,
  ): void {
    const u = new ArrayBuffer(64);
    const f = new Float32Array(u);
    f[0] = viewW;
    f[1] = viewH;
    f[2] = this.docWidth;
    f[3] = this.docHeight;
    f[4] = view.panX;
    f[5] = view.panY;
    f[6] = view.zoom;
    f[7] = view.zoom >= 2 ? 1 : 0; // nearest sampling when zoomed in
    f[8] = 8 * devicePixelRatio; // checker cell size
    uploadBuffer(this.device, this.viewUniforms, 0, u);

    const bindGroup = this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampLinear },
        { binding: 1, resource: this.sampNearest },
        { binding: 2, resource: accum.createView() },
        { binding: 3, resource: { buffer: this.viewUniforms } },
      ],
    });

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.118, g: 0.118, b: 0.125, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  render(state: RenderState): void {
    this.resize();
    const enc = this.device.createCommandEncoder();
    const accum = this.composite(enc, state);
    this.encodePresent(
      enc,
      accum,
      state.view,
      this.context.getCurrentTexture().createView(),
      this.canvas.width,
      this.canvas.height,
    );
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Runs the full pipeline (compositor + present pass) into an offscreen
   * texture and reads it back. Pixels are in the canvas's preferred format
   * (typically BGRA). Used by tests and available for thumbnails.
   */
  async renderOffscreen(
    state: RenderState,
    width: number,
    height: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const tex = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const enc = this.device.createCommandEncoder();
    const accum = this.composite(enc, state);
    this.encodePresent(enc, accum, state.view, tex.createView(), width, height);
    this.device.queue.submit([enc.finish()]);
    const out = await this.readTexture(tex, width, height);
    tex.destroy();
    return out;
  }

  get canvasFormat(): GPUTextureFormat {
    return this.format;
  }

  /** Canvas size in device pixels — the coordinate space of Viewport pan. */
  get viewSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  /** Flattened document pixels (premultiplied RGBA), for export. */
  async readComposite(state: RenderState): Promise<Uint8Array<ArrayBuffer>> {
    const enc = this.device.createCommandEncoder();
    const accum = this.composite(enc, state);
    this.device.queue.submit([enc.finish()]);
    return this.readTexture(accum, this.docWidth, this.docHeight);
  }
}
