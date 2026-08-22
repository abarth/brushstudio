import type { PointerSample } from '../src/brush/dynamics';
import { engineStrokeParams } from '../src/brush/engineParams';
import { getPattern, getTip } from '../src/brush/patterns';
import {
  PATTERNS,
  TIP_SHAPES,
  type BrushPatch,
  type BrushSettings,
  type ControlSource,
  type DynamicControl,
} from '../src/brush/types';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../src/color/convert';
// the scalar twin of the shader's `texValue`, so the texture swatch shows the
// same brightness/contrast/invert the stroke will be carved with
import { texValue } from '../src/engine/cpu/blend';
import { PaintEngine } from '../src/gpu/engine';
import { StrokeSession } from '../src/gpu/stroke';
import { resolveBrush, type AssetBag, type BrushDoc } from '../src/harness/brushDoc';
import { diffFromDefaults } from '../src/harness/patch';
import { makeLayerMeta, type HSV, type LayerMeta } from '../src/types';
import { BLEND_CHOICES, CONTROL_CHOICES, GROUPS, type Item, type Path } from './groups';
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
 * controls for sections that are switched off, the tip and texture bitmaps
 * shown as pictures, and every field of `BrushSettings` reachable. A knob the
 * engine has and the app does not is a knob that gets tuned by editing JSON
 * and re-rendering, which is the slow path this app exists to avoid.
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

let statusTimer = 0;

/**
 * Messages float over the canvas rather than sitting in the top bar: a
 * warning is a sentence, the bar is a fixed 34px, and one must not decide
 * the other.
 */
function setStatus(text: string, ms = 3000): void {
  const node = $('status');
  node.textContent = text;
  node.classList.toggle('on', text !== '');
  clearTimeout(statusTimer);
  if (text && ms > 0) statusTimer = window.setTimeout(() => node.classList.remove('on'), ms);
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
    const empty = el('li', 'empty');
    empty.textContent = 'no match';
    list.append(empty);
    return;
  }
  for (const entry of shown) {
    const row = el('li', entry.path === current ? 'on' : '');
    if (entry.notes) row.title = entry.notes;
    const name = el('span');
    name.textContent = entry.name;
    row.append(name);
    if (entry.folder) {
      const where = el('span', 'where');
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
let erasing = false;

const hex = (c: HSV) => `#${rgbToHex(hsvToRgb(c))}`;
const toHsv = (value: string) => rgbToHsv(hexToRgb(value) ?? { r: 0, g: 0, b: 0 });

/**
 * The paint. Not part of a brush document — a brush is a mark, not a colour —
 * but Color Dynamics blends between these two and jitters around them, so a
 * panel that cannot set them cannot show what that whole section does.
 */
const ink = { fg: hex({ h: 24, s: 0.62, v: 0.2 }), bg: hex({ h: 38, s: 0.28, v: 0.9 }) };

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
  engine.beginStroke(engineStrokeParams(settings, erasing ? 'erase' : 'paint'));
  session = new StrokeSession(engine, settings, { fg: toHsv(ink.fg), bg: toHsv(ink.bg) });
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

type Value = number | boolean | string;

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

/** A `DynamicControl` is the one settings value that is an object. */
function controlAt(path: Path): DynamicControl {
  const [section, key] = path;
  return (settings[section] as unknown as Record<string, DynamicControl>)[key!];
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

/**
 * One closure per row, run after any change. Rows read their value back out
 * of the settings rather than trusting what they last wrote, so a control
 * whose state depends on another — a hardness that only the round tip uses —
 * is right without every row having to know who might move it.
 */
let refresh: (() => void)[] = [];

const inertly = (row: HTMLElement, item: Item) => {
  if (!('inert' in item) || !item.inert) return;
  // dimmed, not disabled: the value is still the brush's, and worth setting
  // before flipping the switch that gives it teeth
  row.classList.toggle('inert', item.inert(settings));
};

function fillOptions(
  select: HTMLSelectElement,
  options: readonly { id: string; label: string }[],
  value: string,
  declared: [string, string][] = [],
): void {
  const add = (parent: HTMLElement, id: string, label: string) => {
    const option = el('option');
    option.value = id;
    option.textContent = label;
    parent.append(option);
  };
  // an id neither list covers — a bitmap left over from another document —
  // still has to show, or the picker would quietly misreport the brush
  if (value && !declared.some(([, id]) => id === value) && !options.some((o) => o.id === value)) {
    add(select, value, value);
  }
  if (declared.length) {
    const mine = el('optgroup');
    mine.label = 'this brush';
    for (const [name, id] of declared) add(mine, id, `@${name}`);
    const builtin = el('optgroup');
    builtin.label = 'built-in';
    for (const option of options) add(builtin, option.id, option.label);
    select.append(mine, builtin);
  } else {
    for (const option of options) add(select, option.id, option.label);
  }
  select.value = value;
}

// --- the rows -------------------------------------------------------------

function sliderRow(item: Item & { row: 'slider' }): HTMLElement {
  const row = el('div', 'row');
  const label = el('label');
  label.textContent = item.label;
  const input = el('input');
  input.type = 'range';
  input.min = String(item.min);
  input.max = String(item.max);
  input.step = String(item.step);
  const out = el('output');
  // the readout comes from the setting, not from the slider: a borrowed .abr
  // can carry a size past the end of the track, and a clamped number on
  // screen would be a lie about the brush
  const show = (v: number) => {
    out.textContent = item.pct ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    setAt(item.path, v);
    show(v);
    onChange();
  });
  refresh.push(() => {
    const v = Number(getAt(item.path));
    if (input.value !== String(v)) input.value = String(v);
    show(v);
    inertly(row, item);
  });
  row.append(label, input, out);
  return row;
}

function checkRow(item: Item & { row: 'check' }): HTMLElement {
  const row = el('label', 'check');
  const input = el('input');
  input.type = 'checkbox';
  input.addEventListener('input', () => {
    setAt(item.path, input.checked);
    onChange();
  });
  refresh.push(() => {
    input.checked = !!getAt(item.path);
    inertly(row, item);
  });
  row.append(input, document.createTextNode(` ${item.label}`));
  return row;
}

function choiceRow(item: Item & { row: 'choice' }): HTMLElement {
  const row = el('div', 'row wide');
  const label = el('label');
  label.textContent = item.label;
  const select = el('select');
  fillOptions(select, item.options, String(getAt(item.path)));
  select.addEventListener('input', () => {
    setAt(item.path, select.value);
    onChange();
  });
  refresh.push(() => {
    const v = String(getAt(item.path));
    if (select.value !== v) select.value = v;
    inertly(row, item);
  });
  row.append(label, select);
  return row;
}

/** What drives the value above it, and — for Fade — over how many steps. */
function controlRow(item: Item & { row: 'control' }): HTMLElement {
  const row = el('div', 'row sub');
  const label = el('label');
  label.textContent = item.label;
  const select = el('select');
  fillOptions(select, CONTROL_CHOICES, controlAt(item.path).source);
  const steps = el('input');
  steps.type = 'number';
  steps.min = '1';
  steps.max = '999';
  steps.title = 'fade length, in spacing steps';
  select.addEventListener('input', () => {
    controlAt(item.path).source = select.value as ControlSource;
    onChange();
  });
  steps.addEventListener('input', () => {
    controlAt(item.path).fadeSteps = Math.max(1, Math.round(Number(steps.value) || 1));
    onChange();
  });
  refresh.push(() => {
    const ctrl = controlAt(item.path);
    if (select.value !== ctrl.source) select.value = ctrl.source;
    if (steps.value !== String(ctrl.fadeSteps)) steps.value = String(ctrl.fadeSteps);
    // hidden rather than removed, so the row does not change shape as the
    // source is cycled past Fade
    steps.classList.toggle('gone', ctrl.source !== 'fade');
    inertly(row, item);
  });
  row.append(label, select, steps);
  return row;
}

/** The bitmap in a slot, the picker that changes it, and how it combines. */
function bitmapRow(item: Item & { row: 'bitmap' }): HTMLElement {
  const row = el('div', 'bitmap');
  const swatch = el('canvas');
  const side = el('div');
  const select = el('select');
  const meta = el('div', 'meta');
  const isTip = item.of === 'tip';

  fillOptions(
    select,
    isTip ? TIP_SHAPES : PATTERNS,
    String(getAt(item.path)),
    isTip ? docTips : docPatterns,
  );
  select.addEventListener('input', () => {
    setAt(item.path, select.value);
    onChange();
  });
  side.append(select, meta);

  if (item.mode) {
    const mode = el('label', 'mode');
    const caption = el('span');
    caption.textContent = 'mode';
    const pick = el('select');
    fillOptions(pick, BLEND_CHOICES, String(getAt(item.mode)));
    pick.addEventListener('input', () => {
      setAt(item.mode!, pick.value);
      onChange();
    });
    refresh.push(() => {
      const v = String(getAt(item.mode!));
      if (pick.value !== v) pick.value = v;
    });
    mode.append(caption, pick);
    side.append(mode);
  }

  let drawn = '';
  refresh.push(() => {
    const id = String(getAt(item.path));
    const tex = settings.texture;
    // a swatch is a few hundred thousand pixels; only redraw one whose
    // picture has actually changed, so dragging a slider stays cheap
    const key = isTip ? id : [id, tex.brightness, tex.contrast, tex.invert, tex.scale].join('|');
    if (key === drawn) return;
    drawn = key;
    if (select.value !== id) select.value = id;
    if (isTip) {
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
  });

  row.append(swatch, side);
  return row;
}

/** Foreground and background — the two colours Color Dynamics works between. */
function paintRow(): HTMLElement {
  const row = el('div', 'row paint');
  const label = el('label');
  label.textContent = 'fg / bg';
  const pair = el('div', 'pair');
  const wells = (['fg', 'bg'] as const).map((which) => {
    const well = el('input');
    well.type = 'color';
    well.title = which === 'fg' ? 'foreground' : 'background';
    well.addEventListener('input', () => {
      ink[which] = well.value;
    });
    pair.append(well);
    return [which, well] as const;
  });
  const swap = el('button');
  swap.textContent = '⇄';
  swap.title = 'swap foreground and background';
  swap.addEventListener('click', () => {
    [ink.fg, ink.bg] = [ink.bg, ink.fg];
    onChange();
  });
  refresh.push(() => {
    for (const [which, well] of wells) if (well.value !== ink[which]) well.value = ink[which];
  });
  row.append(label, pair, swap);
  return row;
}

function buildRow(item: Item): HTMLElement {
  switch (item.row) {
    case 'slider': return sliderRow(item);
    case 'check': return checkRow(item);
    case 'choice': return choiceRow(item);
    case 'control': return controlRow(item);
    case 'bitmap': return bitmapRow(item);
    case 'paint': return paintRow();
  }
}

function buildControls(): void {
  const host = $('controls');
  host.textContent = '';
  refresh = [];
  for (const group of GROUPS) {
    const box = el('div', 'group');
    const head = el('h2');
    head.textContent = group.title;
    const body = el('div', 'body');

    if (group.toggle) {
      const flag = () => settings[group.toggle!] as { enabled: boolean };
      const on = el('input');
      on.type = 'checkbox';
      on.checked = !!flag().enabled;
      // a section that is off is collapsed to its switch: its controls reach
      // nothing, and reading them as if they did is the confusing part
      box.classList.toggle('off', !on.checked);
      on.addEventListener('input', () => {
        flag().enabled = on.checked;
        box.classList.toggle('off', !on.checked);
        onChange();
      });
      head.prepend(on);
    }
    box.append(head, body);
    for (const item of group.items) body.append(buildRow(item));
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

/** Every control ends here: re-read the panel, re-emit the patch. */
function onChange(): void {
  for (const run of refresh) run();
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
    onChange();
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
  // a command is a one-shot; the toggles are worth staying open for
  if ((e.target as HTMLElement).tagName === 'BUTTON') menu.open = false;
});
document.addEventListener('pointerdown', (e) => {
  if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
});

$('clear').addEventListener('click', clear);
$('erase').addEventListener('input', (e) => {
  erasing = (e.target as HTMLInputElement).checked;
  canvas.classList.toggle('erasing', erasing);
});
$('dark').addEventListener('input', (e) => {
  dark = (e.target as HTMLInputElement).checked;
  // the ground and the paint change together, so a dark page does not get
  // painted in ink chosen to sit on a pale one
  [ink.fg, ink.bg] = [ink.bg, ink.fg];
  onChange();
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
  const out = el('canvas');
  out.width = DOC.width;
  out.height = DOC.height;
  out.getContext('2d')!.putImageData(img, 0, 0);
  const link = el('a');
  link.href = out.toDataURL('image/png');
  link.download = 'brushstudio.png';
  link.click();
});
$('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText($('patch').textContent ?? '');
  setStatus('settings patch copied — paste it into the brush document');
});

void boot();
