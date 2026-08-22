import { parseAbr } from '../brush/abr';
import { defaultBrush, makeBrush } from '../brush/defaults';
import { registerPattern, registerTip, type GrayMap } from '../brush/patterns';
import type { BrushPatch, BrushSettings } from '../brush/types';

/**
 * The brush document: what a designer (human or agent) actually edits.
 *
 * A document is a *patch* over the engine defaults rather than a full
 * settings dump, so a file shows only the decisions that were made — the
 * diff between two revisions is the design change, nothing else.
 *
 * Sampled tips and texture patterns are declared by name in `tips` /
 * `patterns` and referenced from `settings` with an `@name` string. The
 * indirection keeps the settings block readable and lets one bitmap be
 * shared by the primary tip and the dual brush.
 */

/** Where a sampled tip's bitmap comes from. */
export type TipSource =
  /** a tip inside a Photoshop .abr file, by name or 0-based index */
  | { abr: string; tip: string | number }
  /** a grayscale image file — white is ink, black is bare */
  | { image: string }
  /** one of the engine's own procedural tips */
  | { builtin: string };

/** Where a texture pattern's bitmap comes from. */
export type PatternSource =
  | { abr: string; pattern: string | number }
  | { image: string }
  | { builtin: string };

export interface BrushDoc {
  /** stable id; the CLI defaults it to the file name */
  id?: string;
  /** the name Photoshop shows in the Brushes panel */
  name: string;
  /** design intent, references, open questions — never exported to .abr */
  notes?: string;
  tips?: Record<string, TipSource>;
  patterns?: Record<string, PatternSource>;
  settings: BrushPatch;
}

/** A file reference the CLI has already read, handed to the page as bytes. */
export interface Asset {
  /** base64 of the file's bytes */
  data: string;
  /** original path, for error messages */
  path: string;
}

/** `path` -> bytes, filled in by the CLI before the document reaches the page. */
export type AssetBag = Record<string, Asset>;

export interface ResolvedBrush {
  id: string;
  name: string;
  notes: string;
  settings: BrushSettings;
  /** non-fatal problems worth reporting back to the designer */
  warnings: string[];
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return buf;
}

const abrCache = new Map<string, ReturnType<typeof parseAbr>>();

function loadAbr(path: string, assets: AssetBag): ReturnType<typeof parseAbr> {
  const cached = abrCache.get(path);
  if (cached) return cached;
  const asset = assets[path];
  if (!asset) throw new Error(`asset not loaded: ${path}`);
  const parsed = parseAbr(decodeBase64(asset.data));
  abrCache.set(path, parsed);
  return parsed;
}

/** Decodes a grayscale image into a square alpha map (white = ink). */
export async function imageToGrayMap(bytes: ArrayBuffer): Promise<GrayMap> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const size = Math.max(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // centre a non-square image in the square, like the .abr importer does
  ctx.drawImage(bmp, (size - bmp.width) / 2, (size - bmp.height) / 2);
  const px = ctx.getImageData(0, 0, size, size).data;
  bmp.close();
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) {
    // luminance, scaled by the image's own alpha so a cut-out PNG works too
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    data[i] = Math.round((lum * px[i * 4 + 3]) / 255);
  }
  return { size, data };
}

/**
 * Names in the patch the engine does not know.
 *
 * A document is merged over the defaults, so a misspelt key is not an error
 * — it is silently inert, which is the worst possible outcome while tuning:
 * the setting appears to be there and does nothing. Every name is checked
 * against the default settings and anything unrecognised is reported, with
 * the nearest real name when there is an obvious one.
 */
function unknownKeys(patch: Record<string, unknown>): string[] {
  const base = defaultBrush() as unknown as Record<string, unknown>;
  const out: string[] = [];
  const suggest = (name: string, options: string[]): string => {
    const lower = name.toLowerCase();
    const hit = options.find(
      (o) => o.toLowerCase() === lower || o.toLowerCase().startsWith(lower.slice(0, 4)),
    );
    return hit ? ` — did you mean "${hit}"?` : '';
  };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) {
      out.push(`settings.${key} is not a brush setting${suggest(key, Object.keys(base))}`);
      continue;
    }
    const baseSection = base[key];
    if (baseSection === null || typeof baseSection !== 'object') continue;
    if (value === null || typeof value !== 'object') {
      out.push(`settings.${key} should be an object, not ${typeof value}`);
      continue;
    }
    const names = Object.keys(baseSection as Record<string, unknown>);
    for (const sub of Object.keys(value as Record<string, unknown>)) {
      if (!names.includes(sub)) {
        out.push(`settings.${key}.${sub} is not a setting${suggest(sub, names)}`);
      }
    }
  }
  return out;
}

/** Picks an entry out of a parsed .abr by name (case-insensitive) or index. */
function pick<T>(entries: [string, T][], want: string | number, what: string): [string, T] {
  if (typeof want === 'number') {
    const hit = entries[want];
    if (!hit) throw new Error(`${what} index ${want} out of range (${entries.length} available)`);
    return hit;
  }
  const lower = want.toLowerCase();
  const hit = entries.find(([id, value]) => {
    const name = (value as { name?: string }).name;
    return id.toLowerCase() === lower || (name && name.toLowerCase() === lower);
  });
  if (hit) return hit;
  throw new Error(`${what} "${want}" not found`);
}

/**
 * Registers every bitmap the document declares and rewrites the `@name`
 * references in `settings` to the ids the engine now knows.
 */
export async function resolveBrush(
  doc: BrushDoc,
  assets: AssetBag,
  fallbackId = 'brush',
): Promise<ResolvedBrush> {
  const warnings: string[] = [];
  const id = doc.id ?? fallbackId;
  const alias = new Map<string, string>();

  for (const [key, src] of Object.entries(doc.tips ?? {})) {
    const engineId = `tip:${id}:${key}`;
    if ('builtin' in src) {
      alias.set(key, src.builtin);
      continue;
    }
    if ('image' in src) {
      const asset = assets[src.image];
      if (!asset) throw new Error(`tip "${key}": asset not loaded: ${src.image}`);
      registerTip(engineId, await imageToGrayMap(decodeBase64(asset.data)));
    } else {
      const abr = loadAbr(src.abr, assets);
      // an .abr names brushes, not tips, so look the tip up through its brush
      const byBrush = abr.brushes.find(
        (b) => typeof src.tip === 'string' && b.name.toLowerCase() === src.tip.toLowerCase(),
      );
      const tipId = byBrush?.tipId
        ? byBrush.tipId
        : pick([...abr.tips], src.tip, `tip in ${src.abr}`)[0];
      const map = abr.tips.get(tipId);
      if (!map) throw new Error(`tip "${key}": ${src.abr} has no bitmap for ${tipId}`);
      registerTip(engineId, map);
    }
    alias.set(key, engineId);
  }

  for (const [key, src] of Object.entries(doc.patterns ?? {})) {
    const engineId = `pattern:${id}:${key}`;
    if ('builtin' in src) {
      alias.set(key, src.builtin);
      continue;
    }
    if ('image' in src) {
      const asset = assets[src.image];
      if (!asset) throw new Error(`pattern "${key}": asset not loaded: ${src.image}`);
      registerPattern(engineId, await imageToGrayMap(decodeBase64(asset.data)), key);
    } else {
      const abr = loadAbr(src.abr, assets);
      const [, pat] = pick([...abr.patterns], src.pattern, `pattern in ${src.abr}`);
      registerPattern(engineId, pat.map, pat.name || key);
    }
    alias.set(key, engineId);
  }

  const deref = (value: unknown, where: string): unknown => {
    if (typeof value !== 'string' || !value.startsWith('@')) return value;
    const key = value.slice(1);
    const hit = alias.get(key);
    if (!hit) throw new Error(`${where}: "@${key}" is not declared in tips/patterns`);
    return hit;
  };

  const patch = JSON.parse(JSON.stringify(doc.settings ?? {})) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [section, values] of Object.entries(patch)) {
    if (!values || typeof values !== 'object') continue;
    for (const key of ['shape', 'pattern']) {
      if (key in values) values[key] = deref(values[key], `settings.${section}.${key}`);
    }
  }

  warnings.push(...unknownKeys(patch));

  const settings = makeBrush(patch as BrushPatch);
  if (settings.texture.enabled && settings.texture.depth === 0) {
    warnings.push('texture is enabled but depth is 0 — it will have no effect');
  }
  if (settings.dual.enabled && settings.dual.spacing > 1) {
    warnings.push(
      `dual spacing ${(settings.dual.spacing * 100).toFixed(0)}% > 100% — the mask train ` +
        'will leave gaps the stroke cannot paint through',
    );
  }
  if (settings.tip.spacing > 1) {
    warnings.push(
      `tip spacing ${(settings.tip.spacing * 100).toFixed(0)}% > 100% — dabs will not abut`,
    );
  }
  return { id, name: doc.name ?? id, notes: doc.notes ?? '', settings, warnings };
}
