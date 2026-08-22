import type { PointerSample } from '../src/brush/dynamics';
import { engineStrokeParams } from '../src/brush/engineParams';
import type { BrushSettings } from '../src/brush/types';
import { PaintEngine } from '../src/gpu/engine';
import { StrokeSession } from '../src/gpu/stroke';
import { resolveBrush, type AssetBag, type BrushDoc } from '../src/harness/brushDoc';
import { describeBrush } from '../src/harness/describe';
import { diffFromDefaults } from '../src/harness/patch';
import { makeLayerMeta, type LayerMeta } from '../src/types';

/**
 * The try-out app: the half of the loop a plate cannot do.
 *
 * A contact sheet answers "what does this brush do"; only a hand on a stylus
 * answers "does it feel right", which is the question that actually decides
 * whether a brush is finished. Tweaks made here come back out as a settings
 * patch, so a reviewer's fiddling lands in the brush document rather than
 * being described in prose and re-guessed.
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
const status = $('status');

// Brush documents live in the repo, so the picker is just the folder.
const docModules = import.meta.glob('/brushes/*.json', { eager: true, import: 'default' }) as Record<
  string,
  BrushDoc & { brushes?: string[] }
>;

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

interface Slider {
  label: string;
  path: Path;
  min: number;
  max: number;
  step: number;
  /** shown as a percentage rather than a raw number */
  pct?: boolean;
}

interface Group {
  title: string;
  /** the section's `enabled` flag, when it has one */
  toggle?: keyof BrushSettings;
  sliders: Slider[];
  checks?: { label: string; path: Path }[];
}

const GROUPS: Group[] = [
  {
    title: 'tip',
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

function getAt(path: Path): number | boolean {
  const [section, key] = path;
  const value = settings[section];
  if (key === undefined) return value as number | boolean;
  return (value as unknown as Record<string, number | boolean>)[key];
}

function setAt(path: Path, value: number | boolean): void {
  const [section, key] = path;
  if (key === undefined) {
    (settings as unknown as Record<string, unknown>)[section] = value;
  } else {
    (settings[section] as unknown as Record<string, unknown>)[key] = value;
  }
}

function buildControls(): void {
  const host = $('controls');
  host.textContent = '';
  for (const group of GROUPS) {
    const box = document.createElement('div');
    box.className = 'group';
    const head = document.createElement('h2');
    head.textContent = group.title;
    if (group.toggle) {
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = !!(settings[group.toggle] as { enabled?: boolean }).enabled;
      on.addEventListener('input', () => {
        (settings[group.toggle!] as { enabled: boolean }).enabled = on.checked;
        showPatch();
      });
      head.prepend(on);
    }
    box.append(head);

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
      box.append(row);
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
      box.append(row, document.createElement('br'));
    }
    host.append(box);
  }
}

function showPatch(): void {
  $('patch').textContent = JSON.stringify(diffFromDefaults(settings), null, 2);
  status.textContent = describeBrush(settings);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function selectBrush(path: string): Promise<void> {
  const doc = JSON.parse(JSON.stringify(docModules[path])) as BrushDoc;
  const assets = await loadAssets(path, doc);
  const resolved = await resolveBrush(doc, assets, path);
  settings = resolved.settings;
  $('notes').textContent = resolved.notes || '';
  buildControls();
  showPatch();
}

async function boot(): Promise<void> {
  if (!navigator.gpu) {
    status.textContent = 'this browser has no WebGPU — try Chrome, Edge, or a recent Safari';
    return;
  }
  // Match the document to the window before the engine allocates textures.
  DOC.width = Math.max(900, Math.floor(canvas.clientWidth * devicePixelRatio));
  DOC.height = Math.max(600, Math.floor(canvas.clientHeight * devicePixelRatio));
  engine = await PaintEngine.create(canvas, DOC.width, DOC.height);
  engine.ensureLayer(layer.id);

  const picker = $<HTMLSelectElement>('brush');
  const paths = Object.keys(docModules)
    .filter((p) => docModules[p]?.settings) // packs list brushes, they are not one
    .sort();
  for (const path of paths) {
    const option = document.createElement('option');
    option.value = path;
    option.textContent = docModules[path].name ?? path;
    picker.append(option);
  }
  picker.addEventListener('change', () => void selectBrush(picker.value));
  if (paths.length === 0) {
    status.textContent = 'no brush documents in brushes/';
    return;
  }
  await selectBrush(paths[0]);
  clear();
}

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
  status.textContent = 'settings patch copied — paste it into the brush document';
});

void boot();
