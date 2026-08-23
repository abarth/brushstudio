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
import { numberField } from './field';
import { initLab } from './lab';
import { BLEND_CHOICES, CONTROL_CHOICES, GROUPS, type Group, type Item, type Path } from './groups';
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
 * The panel holds all 54 of the engine's settings, which is more than fits on
 * a screen, so it is built around four ideas rather than a longer list:
 *
 *   the rail    every section at once — which are on, which you have moved
 *   the reads   each section's governing ratio, computed live while you drag
 *   the field   drag it for fine, click and type for exact; the track is for
 *               seeing where a value sits, not for landing on one
 *   the dot     a value you have moved off what the document had, and a
 *               double-click on its name to put it back
 *
 * Everything else stays out of the way: the library is a popover, the patch
 * is behind a button, and a section that is switched off shows nothing but
 * its switch.
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

/** The status bar under the panel: what the thing under the pointer does. */
const setHint = (text: string) => {
  $('hint').textContent = text;
};

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
  $('brushname').textContent = LIBRARY.find((e) => e.path === current)?.name ?? 'brush';

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
    row.addEventListener('click', () => {
      $<HTMLDetailsElement>('library').open = false;
      void selectBrush(entry.path);
    });
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
/** the document as it was loaded — what a value is "changed" against */
let baseline: BrushSettings;
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
// reading and writing one setting
// ---------------------------------------------------------------------------

type Value = number | boolean | string;

const sectionOf = (from: BrushSettings, path: Path) => from[path[0]];
/** the section a path names, as a plain bag of fields */
const fieldsOf = (from: BrushSettings, path: Path) =>
  sectionOf(from, path) as unknown as Record<string, unknown>;

function getAt(path: Path, from: BrushSettings = settings): Value {
  const [, key] = path;
  if (key === undefined) return sectionOf(from, path) as Value;
  return fieldsOf(from, path)[key] as Value;
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
function controlAt(path: Path, from: BrushSettings = settings): DynamicControl {
  return fieldsOf(from, path)[path[1]!] as DynamicControl;
}

/** Has this value been moved off what the document had? */
function moved(path: Path): boolean {
  const key = path[1];
  const now = key === undefined ? sectionOf(settings, path) : fieldsOf(settings, path)[key];
  const was = key === undefined ? sectionOf(baseline, path) : fieldsOf(baseline, path)[key];
  return JSON.stringify(now) !== JSON.stringify(was);
}

/** Put one value back the way the document had it. */
function revertPath(path: Path): void {
  const [section, key] = path;
  if (key === undefined) {
    (settings as unknown as Record<string, unknown>)[section] = getAt(path, baseline);
  } else {
    const was = fieldsOf(baseline, path)[key];
    // a DynamicControl is an object; copy it rather than sharing the baseline's
    fieldsOf(settings, path)[key] =
      was !== null && typeof was === 'object' ? { ...(was as object) } : was;
  }
}

/** Every settings path a group binds, including its own switch. */
function pathsOf(group: Group): Path[] {
  const out: Path[] = group.toggle ? [[group.toggle, 'enabled']] : [];
  for (const item of group.items) {
    if (item.row === 'paint') continue;
    out.push(item.path);
    if (item.row === 'bitmap' && item.mode) out.push(item.mode);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

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
/** sections the user has folded shut by clicking the header */
const folded = new Set<string>();

/**
 * One closure per row, run after any change. Rows read their value back out
 * of the settings rather than trusting what they last wrote, so a control
 * whose state depends on another — a hardness that only the round tip uses,
 * a ratio that two sections feed — is right without every row having to know
 * who might move it.
 */
let refresh: (() => void)[] = [];

/** Wires the parts every row shares: the hint, the dot, and the revert. */
function wireRow(row: HTMLElement, label: HTMLElement, item: Item): void {
  row.addEventListener('pointerenter', () => setHint(item.hint));
  row.addEventListener('focusin', () => setHint(item.hint));
  if (item.row === 'paint') return;
  label.title = 'double-click to put this back the way the document had it';
  label.addEventListener('dblclick', () => {
    revertPath(item.path);
    if (item.row === 'bitmap' && item.mode) revertPath(item.mode);
    onChange();
  });
  refresh.push(() => {
    row.classList.toggle('set', moved(item.path));
    if ('inert' in item && item.inert) row.classList.toggle('inert', item.inert(settings));
  });
}

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
  const track = el('input');
  track.type = 'range';
  track.min = String(item.min);
  track.max = String(item.max);
  track.step = String(item.step);
  track.tabIndex = -1; // the number beside it is the keyboard target
  const field = numberField({
    min: item.min,
    max: item.max,
    step: item.step,
    pct: item.pct,
    get: () => Number(getAt(item.path)),
    set: (v) => setAt(item.path, v),
    commit: onChange,
  });
  track.addEventListener('input', () => {
    setAt(item.path, Number(track.value));
    onChange();
  });
  refresh.push(() => {
    const v = Number(getAt(item.path));
    if (track.value !== String(v)) track.value = String(v);
    field.sync();
  });
  row.append(label, track, field.node);
  wireRow(row, label, item);
  return row;
}

function checkRow(item: Item & { row: 'check' }): HTMLElement {
  const row = el('div', 'row flag');
  // the box sits where every other row's control sits, so the panel keeps one
  // vertical line of things you can operate; the name rides along after it,
  // which is also the only way "pressure → opacity" fits
  const label = el('label');
  const input = el('input');
  input.type = 'checkbox';
  const text = el('span');
  text.textContent = item.label;
  input.addEventListener('input', () => {
    setAt(item.path, input.checked);
    onChange();
  });
  refresh.push(() => {
    input.checked = !!getAt(item.path);
  });
  label.append(input, text);
  row.append(label);
  wireRow(row, label, item);
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
  });
  row.append(label, select);
  wireRow(row, label, item);
  return row;
}

/** What drives the value above it, and — for Fade — over how many steps. */
function controlRow(item: Item & { row: 'control' }): HTMLElement {
  const row = el('div', 'row sub');
  const label = el('label');
  label.textContent = item.label;
  const select = el('select');
  fillOptions(select, CONTROL_CHOICES, controlAt(item.path).source);
  const steps = numberField({
    min: 1,
    max: 999,
    step: 1,
    get: () => controlAt(item.path).fadeSteps,
    set: (v) => {
      controlAt(item.path).fadeSteps = v;
    },
    commit: onChange,
  });
  steps.node.title = 'fade length, in spacing steps';
  select.addEventListener('input', () => {
    controlAt(item.path).source = select.value as ControlSource;
    onChange();
  });
  refresh.push(() => {
    const ctrl = controlAt(item.path);
    if (select.value !== ctrl.source) select.value = ctrl.source;
    steps.sync();
    // hidden rather than removed, so the row does not change shape as the
    // source is cycled past Fade
    steps.node.classList.toggle('gone', ctrl.source !== 'fade');
  });
  row.append(label, select, steps.node);
  wireRow(row, label, item);
  return row;
}

/** The bitmap in a slot, the picker that changes it, and how it combines. */
function bitmapRow(item: Item & { row: 'bitmap' }): HTMLElement {
  const row = el('div', 'row bitmap');
  const side = el('div', 'side');
  const swatch = el('canvas');
  swatch.tabIndex = 0;
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
      meta.textContent = `${map.size}px tile`;
    }
  });

  row.append(swatch, side);
  // the picture is the name here, so it is also the thing you double-click
  wireRow(row, swatch, item);
  return row;
}

/** Foreground and background — the two colours Color Dynamics works between. */
function paintRow(item: Item & { row: 'paint' }): HTMLElement {
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
  wireRow(row, label, item);
  return row;
}

function buildRow(item: Item): HTMLElement {
  switch (item.row) {
    case 'slider': return sliderRow(item);
    case 'check': return checkRow(item);
    case 'choice': return choiceRow(item);
    case 'control': return controlRow(item);
    case 'bitmap': return bitmapRow(item);
    case 'paint': return paintRow(item);
  }
}

// --- sections and the rail ------------------------------------------------

const changesIn = (group: Group) => pathsOf(group).filter(moved).length;
const isOn = (group: Group) =>
  !group.toggle || !!(settings[group.toggle] as { enabled: boolean }).enabled;

function buildSection(group: Group): HTMLElement {
  const box = el('section', 'group');
  box.id = `sec-${group.short}`;
  const head = el('header');
  const line = el('div', 'line');
  const title = el('h2');
  title.textContent = group.title;
  const count = el('span', 'count');
  const reads = el('p', 'reads');
  const body = el('div', 'body');

  let toggle: HTMLInputElement | null = null;
  if (group.toggle) {
    toggle = el('input');
    toggle.type = 'checkbox';
    toggle.title = `switch ${group.title} on or off`;
    toggle.addEventListener('input', () => {
      (settings[group.toggle!] as { enabled: boolean }).enabled = toggle!.checked;
      // switching a section on is a request to work on it
      if (toggle!.checked) folded.delete(group.title);
      onChange();
    });
    line.append(toggle);
  }
  // the title folds the section by hand; the switch decides whether it does
  // anything at all. Two different questions, two different targets.
  title.addEventListener('click', () => {
    if (folded.has(group.title)) folded.delete(group.title);
    else folded.add(group.title);
    onChange();
  });
  line.append(title, count);
  head.append(line);
  if (group.reads) head.append(reads);
  box.append(head, body);
  for (const item of group.items) body.append(buildRow(item));

  refresh.push(() => {
    const on = isOn(group);
    const open = on && !folded.has(group.title);
    box.classList.toggle('off', !on);
    box.classList.toggle('shut', !open);
    if (toggle) toggle.checked = on;
    const n = changesIn(group);
    count.textContent = n ? String(n) : '';
    box.classList.toggle('set', n > 0);
    if (group.reads) {
      const read = open ? group.reads(settings) : null;
      reads.textContent = read?.text ?? '';
      reads.classList.toggle('warn', !!read?.warn);
      reads.hidden = !read;
    }
  });
  return box;
}

/** The rail: every section at once — what is on, and where you have been. */
function buildRail(): void {
  const rail = $('rail');
  rail.textContent = '';
  for (const group of GROUPS) {
    const chip = el('button', 'chip');
    const dot = el('i');
    const name = el('span');
    name.textContent = group.short;
    const count = el('span', 'count');
    chip.append(dot, name, count);
    chip.title = `go to ${group.title}`;
    chip.addEventListener('click', () => {
      folded.delete(group.title);
      onChange();
      $(`sec-${group.short}`).scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    refresh.push(() => {
      chip.classList.toggle('on', isOn(group));
      const n = changesIn(group);
      chip.classList.toggle('set', n > 0);
      count.textContent = n ? String(n) : '';
    });
    rail.append(chip);
  }
}

function buildControls(): void {
  const host = $('controls');
  host.textContent = '';
  refresh = [];
  buildRail();
  for (const group of GROUPS) host.append(buildSection(group));
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
  const total = GROUPS.reduce((n, group) => n + changesIn(group), 0);
  $('changes').textContent = total ? `${total} changed` : '';
  $<HTMLButtonElement>('revert').disabled = total === 0;
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
    baseline = JSON.parse(JSON.stringify(settings)) as BrushSettings;
    docTips = Object.keys(doc.tips ?? {}).map((name) => [name, resolved.aliases[name]]);
    docPatterns = Object.keys(doc.patterns ?? {}).map((name) => [name, resolved.aliases[name]]);
    aliasBack = new Map(Object.entries(resolved.aliases).map(([name, id]) => [id, name]));
    current = path;
    folded.clear();
    renderLibrary();
    buildControls();
    onChange();
    setStatus(resolved.warnings.join(' · '), 6000);
  } catch (err) {
    setStatus(`${docModules[path]?.name ?? path}: ${(err as Error).message}`, 0);
  }
}

/**
 * Paint with a tip the spectrum lab just synthesized.
 *
 * The lab hands back PNG bytes, so this is the library's own path with the
 * document made up on the spot rather than read from `brushes/`: the same
 * `resolveBrush`, so the tip is registered and the settings are resolved
 * exactly as a saved brush's would be. Each synthesis gets a fresh engine
 * id, because a tip is uploaded once per id and reusing one would paint
 * with the previous bitmap.
 */
let labSerial = 0;

async function applyLabTip(png: string, label: string, train: 'deep' | 'rigid'): Promise<void> {
  const id = `spectrum-lab-${++labSerial}`;
  const doc: BrushDoc = {
    name: label,
    id,
    tips: { mask: { image: id } },
    settings: {
      tip: { shape: 'round', size: 120, hardness: 0.85, spacing: 0.12 },
      shape: {
        enabled: true,
        sizeControl: { source: 'pressure', fadeSteps: 25 },
        sizeJitter: 0.15,
        minDiameter: 0.45,
      },
      dual: {
        enabled: true,
        shape: '@mask',
        size: 156,
        spacing: train === 'deep' ? 0.07 : 0.28,
        scatter: train === 'deep' ? 0.7 : 0.2,
        bothAxes: true,
        count: 1,
        mode: 'multiply',
      },
      flow: 0.9,
    } as BrushPatch,
  };
  const resolved = await resolveBrush(doc, { [id]: { path: id, data: png } }, id);
  settings = resolved.settings;
  baseline = JSON.parse(JSON.stringify(settings)) as BrushSettings;
  docTips = [['mask', resolved.aliases.mask]];
  docPatterns = [];
  aliasBack = new Map(Object.entries(resolved.aliases).map(([name, engineId]) => [engineId, name]));
  current = '';
  folded.clear();
  renderLibrary();
  buildControls();
  onChange();
  $('brushname').textContent = label;
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
  initLab({ apply: applyLabTip, status: setStatus });
}

// --- chrome ---------------------------------------------------------------

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
$<HTMLDetailsElement>('library').addEventListener('toggle', function () {
  if (this.open) search.focus();
});

// one popover open at a time, and a click anywhere else shuts it
const pops = [...document.querySelectorAll<HTMLDetailsElement>('details.pop')];
document.addEventListener('pointerdown', (e) => {
  for (const pop of pops) if (pop.open && !pop.contains(e.target as Node)) pop.open = false;
});
for (const pop of pops) {
  pop.addEventListener('click', (e) => {
    // a command is a one-shot; the toggles are worth staying open for
    if ((e.target as HTMLElement).tagName === 'BUTTON') pop.open = false;
  });
}

/**
 * The panel has two modes, because the spectrum lab is a place you work
 * rather than a menu you pick from — its loop is tweak, synthesize, paint,
 * tweak, and it needs the room and the persistence that a popover cannot
 * give it. The brush stays live across the switch: whatever the lab last
 * synthesized is still what the canvas paints with, so flipping back to
 * `brush` is how you inspect and adjust a lab tip's engine settings.
 */
function setMode(mode: 'brush' | 'lab'): void {
  document.querySelector('aside')!.dataset.mode = mode;
  $('mode-brush').classList.toggle('on', mode === 'brush');
  $('mode-lab').classList.toggle('on', mode === 'lab');
}
$('mode-brush').addEventListener('click', () => setMode('brush'));
$('mode-lab').addEventListener('click', () => setMode('lab'));
setMode('brush');

$('controls').addEventListener('pointerleave', () => setHint(''));
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
$('revert').addEventListener('click', () => {
  settings = JSON.parse(JSON.stringify(baseline)) as BrushSettings;
  onChange();
});
$('showpatch').addEventListener('click', () => {
  const patch = $('patch');
  patch.hidden = !patch.hidden;
  $('showpatch').classList.toggle('on', !patch.hidden);
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
