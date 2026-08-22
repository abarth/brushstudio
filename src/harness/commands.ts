import { descriptorShape, dumpDescriptor, parseAbr } from '../brush/abr';
import { writeAbr } from '../brush/abrWrite';
import { defaultBrush, makeBrush } from '../brush/defaults';
import { registerPattern, registerTip } from '../brush/patterns';
import { PATTERNS, TIP_SHAPES, type BrushSettings } from '../brush/types';
import { describeBrush, explainBrush } from './describe';
import { measureBrush } from './metrics';
import { diffFromDefaults } from './patch';
import { renderPlate, renderTipSheet, type Plate, type PlateEntry, type PlateOptions } from './plate';
import { resolveBrush, type AssetBag, type BrushDoc, type ImageDecoder } from './brushDoc';
import { backendFactory, type BackendFactory } from './surface';
import { TEST_STROKES } from './strokes';
import type { BackendId } from '../engine/types';

/**
 * What the CLI actually asks for, independent of where it runs.
 *
 * Both front ends are thin wrappers over this: `harness/api.ts` exposes it
 * on `window` for the browser/WebGPU path, and `node/api.ts` calls it
 * directly for the CPU path. Only two things differ between them — how an
 * image file is decoded, and how a finished plate is encoded as a PNG — so
 * both are parameters here rather than assumptions.
 */

export interface CommandContext {
  /** which renderer paints the marks */
  backend?: BackendId | BackendFactory;
  /** how to turn image bytes into a tip or pattern bitmap */
  decodeImage?: ImageDecoder;
}

function toFactory(backend: CommandContext['backend']): BackendFactory | undefined {
  if (!backend) return undefined;
  return typeof backend === 'string' ? backendFactory(backend) : backend;
}

/** Accepts what either front end has to hand: base64, or the bytes. */
export function toArrayBuffer(input: string | Uint8Array | ArrayBuffer): ArrayBuffer {
  if (typeof input === 'string') return decode(input);
  if (input instanceof ArrayBuffer) return input;
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
}

export function decode(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return buf;
}

export function encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, [...bytes.subarray(i, i + 0x8000)]);
  }
  return btoa(bin);
}

async function resolveAll(docs: BrushDoc[], assets: AssetBag, ctx: CommandContext = {}) {
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    out.push(await resolveBrush(docs[i], assets, `brush-${i}`, ctx.decodeImage));
  }
  return out;
}

/** Renders the standard plate for a set of brush documents. */
export async function plate(
  docs: BrushDoc[],
  assets: AssetBag,
  opts: PlateOptions & CommandContext = {},
): Promise<Plate & { warnings: string[] }> {
  const resolved = await resolveAll(docs, assets, opts);
  const entries: PlateEntry[] = resolved.map((r) => ({ label: r.name, settings: r.settings }));
  const result = await renderPlate(entries, opts);
  return { ...result, warnings: resolved.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`)) };
}

/** Renders one plate holding both a design and a reference, for comparison. */
export async function comparePlate(
  docs: BrushDoc[],
  assets: AssetBag,
  refs: { abr: string; brush?: string | number; label?: string }[],
  opts: PlateOptions & CommandContext = {},
): Promise<Plate> {
  const resolved = await resolveAll(docs, assets, opts);
  const entries: PlateEntry[] = resolved.map((r) => ({ label: r.name, settings: r.settings }));
  for (const ref of refs) {
    const asset = assets[ref.abr];
    if (!asset) throw new Error(`asset not loaded: ${ref.abr}`);
    for (const entry of abrEntries(asset.data, ref.abr, ref.brush, ref.label)) {
      entries.push(entry);
    }
  }
  return renderPlate(entries, opts);
}

/**
 * Registers an .abr's bitmaps and turns its brushes into plate entries.
 * `path` keys the bitmap registry so two packs cannot collide; `label` is
 * what the plate prints, which wants to be short.
 */
export function abrEntries(
  abr: string | Uint8Array | ArrayBuffer,
  path: string,
  want?: string | number,
  label = path,
): PlateEntry[] {
  const parsed = parseAbr(toArrayBuffer(abr));
  const prefix = `abr:${path}`;
  for (const [id, map] of parsed.tips) registerTip(`${prefix}:${id}`, map);
  for (const [id, pat] of parsed.patterns) {
    registerPattern(`${prefix}:${id}`, pat.map, pat.name || id);
  }
  const entries: PlateEntry[] = [];
  parsed.brushes.forEach((brush, i) => {
    if (want !== undefined) {
      const named = typeof want === 'string' && brush.name.toLowerCase() === want.toLowerCase();
      if (!named && want !== i) return;
    }
    const settings = makeBrush(brush.settings);
    if (brush.tipId) {
      settings.tip.shape = `${prefix}:${brush.tipId}`;
      if (!brush.settings.tip?.size) {
        const map = parsed.tips.get(brush.tipId);
        if (map) settings.tip.size = Math.min(map.size, 300);
      }
    }
    if (settings.dual.enabled && parsed.tips.has(settings.dual.shape)) {
      settings.dual.shape = `${prefix}:${settings.dual.shape}`;
    }
    if (settings.texture.enabled && brush.texturePatternId) {
      settings.texture.pattern = `${prefix}:${brush.texturePatternId}`;
    }
    entries.push({ label: `${brush.name || `#${i}`} — ${label}`, settings });
  });
  return entries;
}

/** Reads an .abr apart: names, minimal patches, tips and patterns. */
export function inspectAbr(abr: string | Uint8Array | ArrayBuffer, path: string) {
  const parsed = parseAbr(toArrayBuffer(abr));
  const prefix = `abr:${path}`;
  for (const [id, map] of parsed.tips) registerTip(`${prefix}:${id}`, map);
  const tipStats = [...parsed.tips].map(([id, map]) => {
    let sum = 0;
    let inked = 0;
    for (const v of map.data) {
      sum += v;
      if (v > 8) inked++;
    }
    return {
      id,
      size: map.size,
      meanAlpha: +(sum / map.data.length / 255).toFixed(4),
      coverage: +(inked / map.data.length).toFixed(4),
    };
  });
  return {
    version: parsed.version,
    brushes: parsed.brushes.map((b, i) => {
      const settings = makeBrush(b.settings);
      // Name the bitmaps the brush actually uses: a pack's whole character
      // often lives in its sampled tip, and "round" would hide that.
      if (b.tipId) settings.tip.shape = `sampled:${b.tipId.slice(0, 8)}`;
      if (settings.dual.enabled && parsed.tips.has(settings.dual.shape)) {
        settings.dual.shape = `sampled:${settings.dual.shape.slice(0, 8)}`;
      }
      if (settings.texture.enabled && b.texturePatternId) {
        const pat = parsed.patterns.get(b.texturePatternId);
        settings.texture.pattern = pat?.name || `pattern:${b.texturePatternId.slice(0, 8)}`;
      }
      return {
        index: i,
        name: b.name,
        // which tool the preset was saved for; a smudge or eraser preset
        // paints a different mark than the plate will show
        tool: b.tool,
        tipId: b.tipId,
        texturePatternId: b.texturePatternId,
        summary: describeBrush(settings),
        explain: explainBrush(settings),
        patch: diffFromDefaults(settings),
      };
    }),
    tips: tipStats,
    patterns: [...parsed.patterns].map(([id, p]) => ({ id, name: p.name, size: p.map.size })),
    // What the file holds that Photoshop's format does not describe: a key
    // at the wrong type, a descriptor at the wrong class, or a key we do not
    // read at all. On someone else's pack this is the interesting part —
    // it is the pack telling us where our schema is wrong or incomplete.
    issues: parsed.issues,
  };
}

/**
 * Every brush's descriptor as text, for holding two files side by side: a
 * pack Photoshop wrote and one we did, diffed key by key.
 */
export function dumpAbr(abr: string | Uint8Array | ArrayBuffer, only?: number) {
  const parsed = parseAbr(toArrayBuffer(abr));
  return parsed.brushes.flatMap((b, i) => {
    if (only !== undefined && only !== i) return [];
    return [
      `[${i}] ${b.name} — ${b.raw ? b.raw.classId : '(no descriptor)'} {`,
      ...(b.raw ? dumpDescriptor(b.raw) : []),
      '}',
    ];
  });
}

/** Picks a brush out of a parsed pack by index, by name, or the first one. */
function pickBrush(abr: string | Uint8Array | ArrayBuffer, want?: number | string) {
  const parsed = parseAbr(toArrayBuffer(abr));
  const index = parsed.brushes.findIndex((b, i) => {
    if (want === undefined) return i === 0;
    if (typeof want === 'string') return b.name.toLowerCase() === want.toLowerCase();
    return i === want;
  });
  if (index < 0) throw new Error(`no brush ${JSON.stringify(want)} in that pack`);
  return { index, brush: parsed.brushes[index] };
}

/**
 * Holds one brush's descriptor against another's and reports the difference
 * in shape: keys one file has and the other does not, and keys they share at
 * different types.
 *
 * This is the question a reader cannot answer on its own. It reports a key at
 * the wrong type, but a key we never write at all looks exactly like a key
 * that is legitimately absent — and when a brush imports wrong with nothing
 * reported, the missing key is the only place left to look.
 */
export function compareAbrDescriptors(
  ours: string | Uint8Array | ArrayBuffer,
  reference: string | Uint8Array | ArrayBuffer,
  opts: { ours?: number | string; reference?: number | string } = {},
) {
  const a = pickBrush(ours, opts.ours);
  const b = pickBrush(reference, opts.reference);
  const shapeA = a.brush.raw ? descriptorShape(a.brush.raw) : {};
  const shapeB = b.brush.raw ? descriptorShape(b.brush.raw) : {};
  const side = (x: typeof a) => ({
    index: x.index,
    name: x.brush.name,
    classId: x.brush.raw?.classId ?? '(none)',
  });
  return {
    ours: side(a),
    reference: side(b),
    onlyInReference: Object.keys(shapeB)
      .filter((k) => !(k in shapeA))
      .map((key) => ({ key, type: shapeB[key] })),
    onlyInOurs: Object.keys(shapeA)
      .filter((k) => !(k in shapeB))
      .map((key) => ({ key, type: shapeA[key] })),
    differing: Object.keys(shapeA)
      .filter((k) => k in shapeB && shapeA[k] !== shapeB[k])
      .map((key) => ({ key, ours: shapeA[key], reference: shapeB[key] })),
  };
}

/** Writes an .abr and immediately reads it back, reporting what did not survive. */
export async function exportAbr(docs: BrushDoc[], assets: AssetBag, ctx: CommandContext = {}) {
  const resolved = await resolveAll(docs, assets, ctx);
  const brushes = resolved.map((r) => ({ name: r.name, settings: r.settings }));
  const buffer = writeAbr(brushes);
  const back = parseAbr(buffer);
  // Reading our own bytes with a strict reader is what makes this check
  // worth anything: a value at a type Photoshop would refuse now comes back
  // as an issue instead of arriving unwrapped and looking correct.
  const issues: string[] = back.issues
    .filter((i) => i.kind !== 'unknown')
    .map((i) => `${i.brush >= 0 ? `[${i.brush}] ` : ''}${i.where}: ${i.message}`);
  const near = (a: number, b: number, tol: number, what: string, i: number) => {
    if (Math.abs(a - b) > tol) issues.push(`[${i}] ${what}: wrote ${a}, read ${b}`);
  };
  const eq = (a: unknown, b: unknown, what: string, i: number) => {
    if (a !== b) issues.push(`[${i}] ${what}: wrote ${JSON.stringify(a)}, read ${JSON.stringify(b)}`);
  };
  if (back.brushes.length !== brushes.length) {
    issues.push(`brush count: wrote ${brushes.length}, read ${back.brushes.length}`);
  }
  back.brushes.forEach((got, i) => {
    const s = brushes[i]?.settings;
    if (!s) return;
    const g = makeBrush(got.settings);
    eq(brushes[i].name, got.name, 'name', i);
    near(s.tip.size, g.tip.size, 0.02, 'tip.size', i);
    near(s.tip.spacing, g.tip.spacing, 1e-5, 'tip.spacing', i);
    near(s.tip.angle, g.tip.angle, 1e-5, 'tip.angle', i);
    near(s.tip.roundness, g.tip.roundness, 1e-5, 'tip.roundness', i);
    eq(s.shape.enabled, g.shape.enabled, 'shape.enabled', i);
    eq(s.scatter.enabled, g.scatter.enabled, 'scatter.enabled', i);
    eq(s.dual.enabled, g.dual.enabled, 'dual.enabled', i);
    eq(s.texture.enabled, g.texture.enabled, 'texture.enabled', i);
    eq(s.transfer.enabled, g.transfer.enabled, 'transfer.enabled', i);
    // the options bar holds whole percentages, so half a percent is the
    // tightest these three can round-trip: anything worse is a lost value,
    // not a rounded one
    near(s.flow, g.flow, 0.005, 'flow', i);
    near(s.opacity, g.opacity, 0.005, 'opacity', i);
    near(s.smoothing, g.smoothing, 0.005, 'smoothing', i);
    eq(s.blendMode, g.blendMode, 'blendMode', i);
    if (s.tip.shape !== 'round' && (!got.tipId || !back.tips.has(got.tipId))) {
      issues.push(`[${i}] sampled tip did not survive the round trip`);
    }
    if (s.texture.enabled && !got.texturePatternId) {
      issues.push(`[${i}] texture pattern did not survive the round trip`);
    }
  });
  return {
    abr: encode(buffer),
    bytes: buffer.byteLength,
    names: brushes.map((b) => b.name),
    tips: back.tips.size,
    patterns: back.patterns.size,
    issues,
    warnings: resolved.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`)),
  };
}

export async function measure(
  docs: BrushDoc[],
  assets: AssetBag,
  opts: { seeds?: number } & CommandContext = {},
) {
  const resolved = await resolveAll(docs, assets, opts);
  const out = [];
  for (const r of resolved) {
    out.push({
      id: r.id,
      name: r.name,
      summary: describeBrush(r.settings),
      metrics: await measureBrush(r.settings, {
        seeds: opts.seeds,
        backend: toFactory(opts.backend),
      }),
      warnings: r.warnings,
    });
  }
  return out;
}

export async function resolvedSettings(
  docs: BrushDoc[],
  assets: AssetBag,
  ctx: CommandContext = {},
) {
  return (await resolveAll(docs, assets, ctx)).map((r) => ({
    id: r.id,
    name: r.name,
    summary: describeBrush(r.settings),
    explain: explainBrush(r.settings),
    settings: r.settings as BrushSettings,
    warnings: r.warnings,
  }));
}

export const CATALOG = {
  tips: TIP_SHAPES,
  patterns: PATTERNS,
  strokes: TEST_STROKES.map((s) => ({ id: s.id, label: s.label, reveals: s.reveals })),
};

export { renderPlate, renderTipSheet, measureBrush, resolveBrush, diffFromDefaults };
export { describeBrush, explainBrush, defaultBrush, makeBrush };
export { Surface, backendFactory, cpuBackend } from './surface';
export { getTip, registerTip, registerPattern } from '../brush/patterns';
