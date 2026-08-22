import { parseAbr } from '../brush/abr';
import { writeAbr } from '../brush/abrWrite';
import { defaultBrush, makeBrush } from '../brush/defaults';
import { getTip, registerPattern, registerTip } from '../brush/patterns';
import { PATTERNS, TIP_SHAPES, type BrushSettings } from '../brush/types';
import { describeBrush, explainBrush } from './describe';
import { measureBrush } from './metrics';
import { diffFromDefaults } from './patch';
import { renderPlate, renderTipSheet, type PlateEntry, type PlateOptions } from './plate';
import { resolveBrush, type AssetBag, type BrushDoc } from './brushDoc';
import { Surface } from './surface';
import { TEST_STROKES } from './strokes';

/**
 * The surface the CLI drives.
 *
 * The engine is browser code — it wants WebGPU and a canvas — so every
 * command is a single page.evaluate against this object, with files already
 * read into base64 on the Node side and results handed back as JSON plus
 * PNG data URLs. Keeping the whole round trip to one call per command is
 * what makes the CLI feel like a normal tool.
 */

function decode(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return buf;
}

function encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, [...bytes.subarray(i, i + 0x8000)]);
  }
  return btoa(bin);
}

async function resolveAll(docs: BrushDoc[], assets: AssetBag) {
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    out.push(await resolveBrush(docs[i], assets, `brush-${i}`));
  }
  return out;
}

/** Renders the standard plate for a set of brush documents. */
async function plate(docs: BrushDoc[], assets: AssetBag, opts: PlateOptions = {}) {
  const resolved = await resolveAll(docs, assets);
  const entries: PlateEntry[] = resolved.map((r) => ({ label: r.name, settings: r.settings }));
  const result = await renderPlate(entries, opts);
  return { ...result, warnings: resolved.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`)) };
}

/** Renders one plate holding both a design and a reference, for comparison. */
async function comparePlate(
  docs: BrushDoc[],
  assets: AssetBag,
  refs: { abr: string; brush?: string | number; label?: string }[],
  opts: PlateOptions = {},
) {
  const resolved = await resolveAll(docs, assets);
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
function abrEntries(
  b64: string,
  path: string,
  want?: string | number,
  label = path,
): PlateEntry[] {
  const parsed = parseAbr(decode(b64));
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
function inspectAbr(b64: string, path: string) {
  const parsed = parseAbr(decode(b64));
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
        tipId: b.tipId,
        texturePatternId: b.texturePatternId,
        summary: describeBrush(settings),
        explain: explainBrush(settings),
        patch: diffFromDefaults(settings),
      };
    }),
    tips: tipStats,
    patterns: [...parsed.patterns].map(([id, p]) => ({ id, name: p.name, size: p.map.size })),
  };
}

/** Writes an .abr and immediately reads it back, reporting what did not survive. */
async function exportAbr(docs: BrushDoc[], assets: AssetBag) {
  const resolved = await resolveAll(docs, assets);
  const brushes = resolved.map((r) => ({ name: r.name, settings: r.settings }));
  const buffer = writeAbr(brushes);
  const back = parseAbr(buffer);
  const issues: string[] = [];
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
    near(s.flow, g.flow, 1e-5, 'flow', i);
    near(s.opacity, g.opacity, 1e-5, 'opacity', i);
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

async function measure(docs: BrushDoc[], assets: AssetBag, opts: { seeds?: number } = {}) {
  const resolved = await resolveAll(docs, assets);
  const out = [];
  for (const r of resolved) {
    out.push({
      id: r.id,
      name: r.name,
      summary: describeBrush(r.settings),
      metrics: await measureBrush(r.settings, opts),
      warnings: r.warnings,
    });
  }
  return out;
}

async function resolvedSettings(docs: BrushDoc[], assets: AssetBag) {
  return (await resolveAll(docs, assets)).map((r) => ({
    id: r.id,
    name: r.name,
    summary: describeBrush(r.settings),
    explain: explainBrush(r.settings),
    settings: r.settings as BrushSettings,
    warnings: r.warnings,
  }));
}

const api = {
  ready: true,
  plate,
  comparePlate,
  abrEntries,
  inspectAbr,
  exportAbr,
  measure,
  resolvedSettings,
  renderPlate,
  renderTipSheet,
  resolveBrush,
  measureBrush,
  diffFromDefaults,
  describeBrush,
  explainBrush,
  defaultBrush,
  makeBrush,
  getTip,
  registerTip,
  registerPattern,
  Surface,
  catalog: {
    tips: TIP_SHAPES,
    patterns: PATTERNS,
    strokes: TEST_STROKES.map((s) => ({ id: s.id, label: s.label, reveals: s.reveals })),
  },
};

declare global {
  interface Window {
    __brushstudio?: typeof api;
  }
}

window.__brushstudio = api;

export type BrushStudioApi = typeof api;
