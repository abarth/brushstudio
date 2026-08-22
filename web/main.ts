import type { PointerSample } from '../src/brush/dynamics';
import { engineStrokeParams } from '../src/brush/engineParams';
import { getPattern, getTip } from '../src/brush/patterns';
import { PATTERNS, TIP_SHAPES, type BrushPatch, type BrushSettings } from '../src/brush/types';
// the scalar twin of the shader's `texValue`, so the texture swatch shows the
// same brightness/contrast/invert the stroke will be carved with
import { texValue } from '../src/engine/cpu/blend';
import { PaintEngine } from '../src/gpu/engine';
import { StrokeSession } from '../src/gpu/stroke';
import { resolveBrush, type AssetBag, type BrushDoc } from '../src/harness/brushDoc';
import { diffFromDefaults } from '../src/harness/patch';
import { makeLayerMeta, type LayerMeta } from '../src/types';
import { drawSwatch } from './swatch';

/**
 * The try-out app: the half of the loop a plate cannot do.
 *
 * A contact sheet answers "what does this brush do"; only a hand on a stylus
 * answers "does it feel right", which is the question that actually decides
 * whether a brush is finished. Tweaks made here come back out as a settings
 * patch, so a reviewer's fiddling lands in the brush document rather than
 * being described in prose and re-guessed.
 *
 * The panel is built for someone who already knows the engine: no prose, no
 * controls for sections that are switched off, and the tip and texture
 * bitmaps shown as pictures, because "fiber-drag" and "wisp-filament" are two
 * words until you have seen them.
 */

/**
 * The document is sized to the window at 1:1 rather than to a fixed canvas
 * scaled to fit. A brush is judged at the size it will be used at, and a
 * 60%-scaled preview hides exactly the grain and edge detail the reviewer
 * is here to look at.
 */
const DOC = { width: 1600, height: 1100 };
const PAPER: [number, number, number, number] = [0.965, 0.949, 0.918, 1];
const DARK_PAPER: [number, number, number, number] = [0.11, 0.107, 0.115, 1];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');

let statusTimer = 0;

/**
 * Messages float over the canvas rather than sitting in the top bar: a
 * warning is a sentence, the bar is a fixed 34px, and one must not decide
 * the other.
 */
function setStatus(text: string, ms = 3000): void {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('on', text !== '');
  clearTimeout(statusTimer);
  if (text && ms > 0) statusTimer = window.setTimeout(() => el.classList.remove('on'), ms);
}

// ---------------------------------------------------------------------------
// the library
// ---------------------------------------------------------------------------

// Brush documents live in the repo, so the library is just the folder — and
// it is globbed deep, so a pack that grows past a screenful can be filed into
// subfolders without the app needing to know.
const docModules = import.meta.glob('/brushes/**/*.json', { eager: true, import: 'default' }) as Record<
  string,
  BrushDoc & { brushes?: string[] }
>;

interface Entry {
  path: string;
  name: string;
  /** subfolder under brushes/, '' at the root — shown so names can repeat */
  folder: string;
  /** the document's notes, as a hover: intent belongs in the file, not the UI */
  notes: string;
}

const LIBRARY: Entry[] = Object.keys(docModules)
  .filter((path) => docModules[path]?.settings) // packs list brushes, they are not one
  .map((path) => {
    const rel = path.replace(/^\/brushes\//, '');
    const cut = rel.lastIndexOf('/');
    return {
      path,
      name: docModules[path].name ?? rel,
      folder: cut < 0 ? '' : rel.slice(0, cut),
      notes: docModules[path].notes ?? '',
    };
  })
  .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));

let current = '';
let shown: Entry[] = LIBRARY;

function renderLibrary(): void {
  const query = $<HTMLInputElement>('search').value.trim().toLowerCase();
  shown = query
    ? LIBRARY.filter((e) => `${e.folder}/${e.name}`.toLowerCase().includes(query))
    : LIBRARY;
  $('count').textContent = query ? `${shown.length}/${LIBRARY.length}` : String(LIBRARY.length);

  const list = $('brushes');
  list.textContent = '';
  if (shown.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no match';
    list.append(empty);
    return;
  }
  for (const entry of shown) {
    const row = document.createElement('li');
    row.className = entry.path === current ? 'on' : '';
    if (entry.notes) row.title = entry.notes;
    const name = document.createElement('span');
    name.textContent = entry.name;
    row.append(name);
    if (entry.folder) {
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = entry.folder;
      row.append(where);
    }
    row.addEventListener('click', () => void selectBrush(entry.path));
    if (entry.path === current) queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }));
    list.append(row);
  }
}

async function loadAssets(path: string, doc: BrushDoc): Promise<AssetBag> {
  const assets: AssetBag = {};
  for (const section of ['tips', 'patterns'] as const) {
    for (const src of Object.values(doc[section] ?? {})) {
      for (const field of ['abr', 'image'] as const) {
        const value = (src as Record<string, unknown>)[field];
        if (typeof value !== 'string') continue;
        const url = new URL(value, new URL(path, location.origin)).pathname;
        const bytes = await (await fetch(url)).arrayBuffer();
        let bin = '';
        const u8 = new Uint8Array(bytes);
        for (let i = 0; i < u8.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, [...u8.subarray(i, i + 0x8000)]);
        }
        assets[url] = { path: url, data: btoa(bin) };
        (src as Record<string, unknown>)[field] = url;
      }
    }
  }
  return assets;
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

const layer: LayerMeta = makeLayerMeta({ id: 'paint', name: 'paint' });
let engine: PaintEngine;
let settings: BrushSettings;
let session: StrokeSession | null = null;
let dark = false;

const view = { zoom: 1, panX: 0, panY: 0 };
const state = () => ({ layers: [layer], activeLayerId: layer.id, view });

function fit(): void {
  const { width, height } = engine.viewSize;
  // 1:1 whenever the document fits, so marks are seen at their real size;
  // only shrink when the window is smaller than the document.
  view.zoom = Math.min(1, width / DOC.width, height / DOC.height);
  view.panX = (width - DOC.width * view.zoom) / 2;
  view.panY = (height - DOC.height * view.zoom) / 2;
}

function draw(): void {
  engine.resize();
  fit();
  engine.render(state());
}

function clear(): void {
  engine.fillLayer(layer.id, dark ? DARK_PAPER : PAPER);
  draw();
}

/** Canvas point -> document point. */
function toDoc(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio;
  return {
    x: ((e.clientX - rect.left) * dpr - view.panX) / view.zoom,
    y: ((e.clientY - rect.top) * dpr - view.panY) / view.zoom,
  };
}

function toSample(e: PointerEvent): PointerSample {
  const p = toDoc(e);
  return {
    x: p.x,
    y: p.y,
    // a mouse reports 0.5 while held; a stylus reports the real thing
    pressure: e.pointerType === 'mouse' ? 0.65 : e.pressure || 0.5,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    twist: e.twist ?? 0,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  engine.beginStroke(engineStrokeParams(settings, 'paint'));
  session = new StrokeSession(engine, settings, {
    fg: dark ? { h: 40, s: 0.08, v: 0.96 } : { h: 24, s: 0.62, v: 0.2 },
    bg: dark ? { h: 24, s: 0.62, v: 0.2 } : { h: 38, s: 0.28, v: 0.9 },
  });
  session.down(toSample(e));
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!session) return;
  const events = e.getCoalescedEvents?.() ?? [e];
  session.move(events.map(toSample));
  draw();
});

const endStroke = () => {
  if (!session) return;
  session.up();
  session = null;
  engine.endStroke(layer.id);
  draw();
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('pointerleave', endStroke);
window.addEventListener('resize', draw);

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

type Path = [keyof BrushSettings, string?];
type Value = number | boolean | string;

interface Slider {
  label: string;
  path: Path;
  min: number;
  max: number;
  step: number;
  /** shown as a percentage rather than a raw number */
  pct?: boolean;
}

/** A bitmap slot: which tip or pattern the section is stamping. */
interface Bitmap {
  path: Path;
  kind: 'tip' | 'pattern';
}

interface Group {
  title: string;
  /** the section's `enabled` flag, when it has one */
  toggle?: keyof BrushSettings;
  bitmap?: Bitmap;
  sliders: Slider[];
  checks?: { label: string; path: Path }[];
}

const GROUPS: Group[] = [
  {
    title: 'tip',
    bitmap: { path: ['tip', 'shape'], kind: 'tip' },
    sliders: [
      { label: 'size', path: ['tip', 'size'], min: 1, max: 600, step: 1 },
      { label: 'hardness', path: ['tip', 'hardness'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'spacing', path: ['tip', 'spacing'], min: 0.01, max: 2, step: 0.01, pct: true },
      { label: 'roundness', path: ['tip', 'roundness'], min: 0.05, max: 1, step: 0.01, pct: true },
      { label: 'angle', path: ['tip', 'angle'], min: -180, max: 180, step: 1 },
    ],
    checks: [
      { label: 'flip X', path: ['tip', 'flipX'] },
      { label: 'flip Y', path: ['tip', 'flipY'] },
    ],
  },
  {
    title: 'stroke',
    sliders: [
      { label: 'flow', path: ['flow'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'opacity', path: ['opacity'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'smoothing', path: ['smoothing'], min: 0, max: 0.95, step: 0.01, pct: true },
    ],
    checks: [
      { label: 'wet edges', path: ['wetEdges'] },
      { label: 'noise', path: ['noise'] },
      { label: 'build-up', path: ['airbrush'] },
    ],
  },
  {
    title: 'shape dynamics',
    toggle: 'shape',
    sliders: [
      { label: 'size jitter', path: ['shape', 'sizeJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'min diameter', path: ['shape', 'minDiameter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'angle jitter', path: ['shape', 'angleJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'round jitter', path: ['shape', 'roundnessJitter'], min: 0, max: 1, step: 0.01, pct: true },
    ],
  },
  {
    title: 'scattering',
    toggle: 'scatter',
    sliders: [
      { label: 'scatter', path: ['scatter', 'scatter'], min: 0, max: 10, step: 0.05, pct: true },
      { label: 'count', path: ['scatter', 'count'], min: 1, max: 16, step: 1 },
      { label: 'count jitter', path: ['scatter', 'countJitter'], min: 0, max: 1, step: 0.01, pct: true },
    ],
    checks: [{ label: 'both axes', path: ['scatter', 'bothAxes'] }],
  },
  {
    title: 'texture',
    toggle: 'texture',
    bitmap: { path: ['texture', 'pattern'], kind: 'pattern' },
    sliders: [
      { label: 'depth', path: ['texture', 'depth'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'scale', path: ['texture', 'scale'], min: 0.1, max: 4, step: 0.05, pct: true },
      { label: 'contrast', path: ['texture', 'contrast'], min: -1, max: 1, step: 0.01, pct: true },
      { label: 'brightness', path: ['texture', 'brightness'], min: -1, max: 1, step: 0.01, pct: true },
    ],
    checks: [
      { label: 'invert', path: ['texture', 'invert'] },
      { label: 'each tip', path: ['texture', 'textureEachTip'] },
    ],
  },
  {
    title: 'dual brush',
    toggle: 'dual',
    bitmap: { path: ['dual', 'shape'], kind: 'tip' },
    sliders: [
      { label: 'size', path: ['dual', 'size'], min: 1, max: 600, step: 1 },
      { label: 'spacing', path: ['dual', 'spacing'], min: 0.01, max: 2, step: 0.01, pct: true },
      { label: 'scatter', path: ['dual', 'scatter'], min: 0, max: 10, step: 0.05, pct: true },
      { label: 'count', path: ['dual', 'count'], min: 1, max: 16, step: 1 },
    ],
    checks: [{ label: 'both axes', path: ['dual', 'bothAxes'] }],
  },
  {
    title: 'transfer',
    toggle: 'transfer',
    sliders: [
      { label: 'opacity jit', path: ['transfer', 'opacityJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'opacity min', path: ['transfer', 'opacityMin'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'flow jitter', path: ['transfer', 'flowJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'flow min', path: ['transfer', 'flowMin'], min: 0, max: 1, step: 0.01, pct: true },
    ],
  },
  {
    title: 'color dynamics',
    toggle: 'color',
    sliders: [
      { label: 'fg/bg jitter', path: ['color', 'fgBgJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'hue jitter', path: ['color', 'hueJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'sat jitter', path: ['color', 'satJitter'], min: 0, max: 1, step: 0.01, pct: true },
      { label: 'bri jitter', path: ['color', 'briJitter'], min: 0, max: 1, step: 0.01, pct: true },
    ],
    checks: [{ label: 'per tip', path: ['color', 'applyPerTip'] }],
  },
];

function getAt(path: Path): Value {
  const [section, key] = path;
  const value = settings[section];
  if (key === undefined) return value as Value;
  return (value as unknown as Record<string, Value>)[key];
}

function setAt(path: Path, value: Value): void {
  const [section, key] = path;
  if (key === undefined) {
    (settings as unknown as Record<string, unknown>)[section] = value;
  } else {
    (settings[section] as unknown as Record<string, unknown>)[key] = value;
  }
}

/**
 * The bitmaps the current document declares: `@name` against the id the
 * engine registered it under. Documents name their own tips and patterns, so
 * a borrowed .abr bitmap has to appear in the picker under the name the
 * document gave it — and go back into the patch under that name too.
 */
let docTips: [string, string][] = [];
let docPatterns: [string, string][] = [];
/** engine id -> the document's name for it, the reverse of the two above */
let aliasBack = new Map<string, string>();

/** Redraws for the swatches on screen, run whenever a control moves. */
let repaint: (() => void)[] = [];

function fillOptions(select: HTMLSelectElement, kind: 'tip' | 'pattern', value: string): void {
  const declared = kind === 'tip' ? docTips : docPatterns;
  const builtin = kind === 'tip' ? TIP_SHAPES : PATTERNS;
  const add = (parent: HTMLElement, id: string, label: string) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    parent.append(option);
  };
  // an id the lists do not cover — a bitmap left over from another document —
  // still has to show, or the picker would quietly misreport the brush
  if (value && !declared.some(([, id]) => id === value) && !builtin.some((b) => b.id === value)) {
    add(select, value, value);
  }
  if (declared.length) {
    const group = document.createElement('optgroup');
    group.label = 'this brush';
    for (const [name, id] of declared) add(group, id, `@${name}`);
    select.append(group);
  }
  const group = document.createElement('optgroup');
  group.label = 'built-in';
  for (const item of builtin) add(group, String(item.id), item.label);
  select.append(group);
  select.value = value;
}

/** The bitmap in a slot, beside the picker that changes it. */
function bitmapRow(spec: Bitmap): HTMLElement {
  const row = document.createElement('div');
  row.className = 'bitmap';
  const swatch = document.createElement('canvas');
  const side = document.createElement('div');
  const select = document.createElement('select');
  const meta = document.createElement('div');
  meta.className = 'meta';

  fillOptions(select, spec.kind, String(getAt(spec.path)));
  select.addEventListener('input', () => {
    setAt(spec.path, select.value);
    showPatch();
  });

  let drawn = '';
  const paint = () => {
    const id = String(getAt(spec.path));
    const tex = settings.texture;
    // a swatch is a few hundred thousand pixels; only redraw one whose
    // picture has actually changed, so dragging a slider stays cheap
    const key =
      spec.kind === 'tip'
        ? id
        : [id, tex.brightness, tex.contrast, tex.invert, tex.scale].join('|');
    if (key === drawn) return;
    drawn = key;
    if (select.value !== id) select.value = id;
    if (spec.kind === 'tip') {
      const map = getTip(id);
      drawSwatch(swatch, map);
      // the round tip is analytic — the engine samples no bitmap for it, and
      // the hardness slider, not a picture, is what shapes its rim
      meta.textContent = id === 'round' ? 'analytic — no bitmap' : `${map.size}px`;
    } else {
      const map = getPattern(id);
      const bci = {
        brightness: tex.brightness,
        contrast: tex.contrast,
        invert: tex.invert,
        depth: tex.depth,
      };
      drawSwatch(swatch, map, (v) => texValue(v, bci));
      // scale is relative to the pattern's own size, so what matters is the
      // tile it lands on the canvas at, against the tip diameter
      meta.textContent = `${map.size}px tile → ${Math.round(map.size * tex.scale)}px`;
    }
  };
  paint();
  repaint.push(paint);

  side.append(select, meta);
  row.append(swatch, side);
  return row;
}

function buildControls(): void {
  const host = $('controls');
  host.textContent = '';
  repaint = [];
  for (const group of GROUPS) {
    const box = document.createElement('div');
    box.className = 'group';
    const head = document.createElement('h2');
    head.textContent = group.title;
    const body = document.createElement('div');
    body.className = 'body';

    if (group.toggle) {
      const flag = () => settings[group.toggle!] as { enabled: boolean };
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = !!flag().enabled;
      // a section that is off is collapsed to its switch: its sliders reach
      // nothing, and reading them as if they did is the confusing part
      box.classList.toggle('off', !on.checked);
      on.addEventListener('input', () => {
        flag().enabled = on.checked;
        box.classList.toggle('off', !on.checked);
        showPatch();
      });
      head.prepend(on);
    }
    box.append(head, body);

    if (group.bitmap) body.append(bitmapRow(group.bitmap));

    for (const slider of group.sliders) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = slider.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(slider.step);
      input.value = String(getAt(slider.path));
      const out = document.createElement('output');
      const show = () => {
        const v = Number(input.value);
        out.textContent = slider.pct ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100);
      };
      show();
      input.addEventListener('input', () => {
        setAt(slider.path, Number(input.value));
        show();
        showPatch();
      });
      row.append(label, input, out);
      body.append(row);
    }

    for (const check of group.checks ?? []) {
      const row = document.createElement('label');
      row.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!getAt(check.path);
      input.addEventListener('input', () => {
        setAt(check.path, input.checked);
        showPatch();
      });
      row.append(input, document.createTextNode(` ${check.label}`));
      body.append(row, document.createElement('br'));
    }
    host.append(box);
  }
}

/**
 * Puts the document's own names back on its bitmaps.
 *
 * The settings carry engine ids, which are private to this session; a
 * document writes `@name`. This is the inverse of the dereference
 * `resolveBrush` does on the way in, so what the panel offers to copy is
 * what the file can hold.
 */
function reAlias(patch: BrushPatch): BrushPatch {
  for (const section of Object.values(patch as Record<string, unknown>)) {
    if (!section || typeof section !== 'object') continue;
    const values = section as Record<string, unknown>;
    for (const key of ['shape', 'pattern']) {
      const value = values[key];
      if (typeof value === 'string' && aliasBack.has(value)) values[key] = `@${aliasBack.get(value)}`;
    }
  }
  return patch;
}

function showPatch(): void {
  for (const paint of repaint) paint();
  $('patch').textContent = JSON.stringify(reAlias(diffFromDefaults(settings)), null, 2);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function selectBrush(path: string): Promise<void> {
  const doc = JSON.parse(JSON.stringify(docModules[path])) as BrushDoc;
  try {
    const assets = await loadAssets(path, doc);
    const resolved = await resolveBrush(doc, assets, path);
    settings = resolved.settings;
    docTips = Object.keys(doc.tips ?? {}).map((name) => [name, resolved.aliases[name]]);
    docPatterns = Object.keys(doc.patterns ?? {}).map((name) => [name, resolved.aliases[name]]);
    aliasBack = new Map(Object.entries(resolved.aliases).map(([name, id]) => [id, name]));
    current = path;
    renderLibrary();
    buildControls();
    showPatch();
    setStatus(resolved.warnings.join(' · '), 6000);
  } catch (err) {
    setStatus(`${docModules[path]?.name ?? path}: ${(err as Error).message}`, 0);
  }
}

async function boot(): Promise<void> {
  if (!navigator.gpu) {
    setStatus('this browser has no WebGPU — try Chrome, Edge, or a recent Safari', 0);
    return;
  }
  // Match the document to the window before the engine allocates textures.
  DOC.width = Math.max(900, Math.floor(canvas.clientWidth * devicePixelRatio));
  DOC.height = Math.max(600, Math.floor(canvas.clientHeight * devicePixelRatio));
  engine = await PaintEngine.create(canvas, DOC.width, DOC.height);
  engine.ensureLayer(layer.id);

  renderLibrary();
  if (LIBRARY.length === 0) {
    setStatus('no brush documents in brushes/', 0);
    return;
  }
  await selectBrush(LIBRARY[0].path);
  clear();
}

const search = $<HTMLInputElement>('search');
search.addEventListener('input', renderLibrary);
// arrow keys walk the filtered list without leaving the filter box: type two
// letters, arrow to the one you meant
search.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const at = shown.findIndex((entry) => entry.path === current);
  const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (next && next.path !== current) void selectBrush(next.path);
});

const menu = $<HTMLDetailsElement>('menu');
menu.addEventListener('click', (e) => {
  // a command is a one-shot; only the ground toggle is worth staying open for
  if ((e.target as HTMLElement).tagName === 'BUTTON') menu.open = false;
});
document.addEventListener('pointerdown', (e) => {
  if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
});

$('clear').addEventListener('click', clear);
$('dark').addEventListener('input', (e) => {
  dark = (e.target as HTMLInputElement).checked;
  clear();
});
$('save').addEventListener('click', async () => {
  const data = await engine.readComposite(state());
  const img = new ImageData(DOC.width, DOC.height);
  for (let i = 0; i < DOC.width * DOC.height; i++) {
    const a = data[i * 4 + 3];
    const inv = a > 0 ? 255 / a : 0;
    img.data[i * 4] = Math.min(255, data[i * 4] * inv);
    img.data[i * 4 + 1] = Math.min(255, data[i * 4 + 1] * inv);
    img.data[i * 4 + 2] = Math.min(255, data[i * 4 + 2] * inv);
    img.data[i * 4 + 3] = a;
  }
  const out = document.createElement('canvas');
  out.width = DOC.width;
  out.height = DOC.height;
  out.getContext('2d')!.putImageData(img, 0, 0);
  const link = document.createElement('a');
  link.href = out.toDataURL('image/png');
  link.download = 'brushstudio.png';
  link.click();
});
$('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText($('patch').textContent ?? '');
  setStatus('settings patch copied — paste it into the brush document');
});

void boot();
