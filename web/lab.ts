import { numberField, type Field } from './field';

/**
 * The spectrum lab: the parameter space of docs/spectral-atlas.md, with a
 * hand on it.
 *
 * A texture designed as a power spectrum is hard to hold in the head — β
 * trades against the shoulder, a wedge does something a stretch does not,
 * and the only way to know whether a ring at k=13 is a labyrinth or a mess
 * is to paint with one. The sweeps that built the shipped families ran a
 * CLI per candidate and looked at a contact sheet; this is the same loop
 * with the wait taken out.
 *
 * The synthesis itself is NOT here. Every preview is the real
 * `tools/fractal-tip.mjs` run by the dev server (tools/lib/lab.mjs), so
 * what you paint with is what the spec would produce — a browser
 * reimplementation would drift and quietly lie. The cost is about a second
 * per synthesis, which is why this is a button and a debounce rather than
 * a live slider.
 */

export interface LabParams {
  kind: 'ring' | 'law';
  k: number;
  ringWidth: number;
  beta: number;
  shoulder: number;
  cut: number;
  wedge: number;
  axis: number;
  warpAmp: number;
  warpK: number;
  mode: 'modulate' | 'lognormal';
  sigma: number;
  depth: number;
  train: 'deep' | 'rigid';
  seed: number;
}

export interface LabHooks {
  /** install a synthesized tip as the live brush and repaint the panel */
  apply: (pngBase64: string, label: string, train: 'deep' | 'rigid') => Promise<void>;
  status: (text: string, ms?: number) => void;
}

/** Where the atlas's promoted families sit, as somewhere to start from. */
const PRESETS: Record<string, Partial<LabParams>> = {
  sand: { kind: 'ring', k: 10, ringWidth: 8, wedge: 18, axis: 0, train: 'deep' },
  corduroy: { kind: 'ring', k: 16, ringWidth: 4, wedge: 12, axis: 90, train: 'deep' },
  labyrinth: { kind: 'ring', k: 8, ringWidth: 8, wedge: 0, train: 'deep' },
  reticule: { kind: 'ring', k: 16, ringWidth: 8, wedge: 0, train: 'deep' },
  vesicle: { kind: 'ring', k: 16, ringWidth: 8, wedge: 0, mode: 'lognormal', sigma: 0.5, train: 'deep' },
  flow: { kind: 'ring', k: 10, ringWidth: 8, wedge: 18, axis: 0, warpAmp: 0.05, warpK: 3, train: 'rigid' },
  whorl: { kind: 'ring', k: 16, ringWidth: 4, wedge: 12, axis: 0, warpAmp: 0.09, warpK: 2, train: 'rigid' },
  woodgrain: { kind: 'law', beta: 2.6, shoulder: 3, wedge: 14, axis: 90, warpAmp: 0.07, warpK: 2.5, train: 'rigid' },
  drape: { kind: 'law', beta: 3.0, shoulder: 2, wedge: 22, axis: 0, warpAmp: 0.04, warpK: 2, train: 'rigid' },
  tooth: { kind: 'law', beta: 0.6, shoulder: 12, cut: 70, wedge: 0, train: 'deep' },
  'power law': { kind: 'law', beta: 2.4, shoulder: 2.5, cut: 70, wedge: 0, train: 'deep' },
};

const DEFAULTS: LabParams = {
  kind: 'ring', k: 10, ringWidth: 8,
  beta: 2.4, shoulder: 2.5, cut: 70,
  wedge: 18, axis: 0,
  warpAmp: 0, warpK: 2.5,
  mode: 'modulate', sigma: 0.5,
  depth: 0.55, train: 'deep', seed: 20250823,
};

interface Row {
  label: string;
  hint: string;
  /** shown only when the spectrum kind / mapping makes it meaningful */
  when?: (p: LabParams) => boolean;
  field: keyof LabParams;
  min: number;
  max: number;
  step: number;
  pct?: boolean;
}

const ROWS: Row[] = [
  { label: 'ring k', hint: 'the one scale, in cycles per tip diameter — a narrow band is a scale, not a pattern', field: 'k', min: 2, max: 40, step: 0.5, when: (p) => p.kind === 'ring' },
  { label: 'ring width', hint: 'how sharply the band falls away; higher is narrower, so the scale is more singular', field: 'ringWidth', min: 1, max: 14, step: 0.5, when: (p) => p.kind === 'ring' },
  { label: 'beta', hint: 'the power-law slope. 2 is equal variance per octave; above it the coarse scales dominate, below it the fine ones', field: 'beta', min: 0, max: 4.5, step: 0.1, when: (p) => p.kind === 'law' },
  { label: 'shoulder', hint: 'the OUTER scale, in c/dia: the largest structure. Without it a steep slope paints one blob', field: 'shoulder', min: 0.5, max: 24, step: 0.5, when: (p) => p.kind === 'law' },
  { label: 'cut', hint: 'the INNER scale, in c/dia: where the material stops having detail. 8 is soft focus, 60 is granular', field: 'cut', min: 6, max: 80, step: 1, when: (p) => p.kind === 'law' },
  { label: 'wedge', hint: 'angular half-width in degrees; 0 is isotropic. A wedge DELETES orientations, which is what makes crests rather than lobes', field: 'wedge', min: 0, max: 90, step: 1 },
  { label: 'wedge axis', hint: 'the direction of the wavevector, so 0 puts crests ACROSS a horizontal stroke and 90 along it', field: 'axis', min: 0, max: 180, step: 5, when: (p) => p.wedge > 0 },
  { label: 'warp', hint: 'domain warp: bends crests into flow and whorls. It injects PHASE, so a warped texture belongs on the rigid train', field: 'warpAmp', min: 0, max: 0.15, step: 0.005 },
  { label: 'warp scale', hint: 'how coarse the warp field is; lower is broader swirls', field: 'warpK', min: 1, max: 6, step: 0.5, when: (p) => p.warpAmp > 0 },
  { label: 'sigma', hint: 'cascade intermittency: median damage lands at e^(-2.58 sigma), so higher is rarer and deeper', field: 'sigma', min: 0.2, max: 2, step: 0.05, when: (p) => p.mode === 'lognormal' },
  { label: 'depth', hint: 'the damage dial — how much of the material is carved away', field: 'depth', min: 0.1, max: 0.95, step: 0.05, pct: true },
  { label: 'seed', hint: 'a different draw of the same statistics', field: 'seed', min: 1, max: 99999999, step: 1 },
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '') => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

export function initLab(hooks: LabHooks): void {
  const params: LabParams = { ...DEFAULTS };
  const panel = document.getElementById('lab');
  if (!panel) return;
  const sheet = panel.querySelector('.sheet') as HTMLElement;
  const fields: { row: Row; wrap: HTMLElement; field: Field }[] = [];
  let lastSpec: unknown = null;
  let busy = false;
  let queued = false;
  let timer = 0;

  // --- header: preset, spectrum kind, mapping, train ------------------------
  const choice = <T extends string>(
    label: string,
    hint: string,
    options: T[],
    get: () => T,
    set: (v: T) => void,
  ) => {
    const wrap = el('label', 'labrow');
    const name = el('span', 'labname');
    name.textContent = label;
    name.title = hint;
    const sel = el('select');
    for (const o of options) {
      const opt = el('option');
      opt.value = o;
      opt.textContent = o;
      sel.append(opt);
    }
    sel.value = get();
    sel.addEventListener('change', () => {
      set(sel.value as T);
      refresh();
      schedule();
    });
    wrap.append(name, sel);
    sheet.append(wrap);
    return sel;
  };

  const presetSel = choice(
    'start from',
    'the promoted families, as somewhere to stand',
    ['—', ...Object.keys(PRESETS)],
    () => '—',
    (v) => {
      const preset = PRESETS[v];
      if (!preset) return;
      Object.assign(params, DEFAULTS, preset);
    },
  );
  choice('spectrum', 'a narrow ring is one scale; a power law is all of them', ['ring', 'law'] as const,
    () => params.kind, (v) => (params.kind = v));
  choice('mapping', 'rank-uniform, or the lognormal cascade this mask accumulates toward', ['modulate', 'lognormal'] as const,
    () => params.mode, (v) => (params.mode = v));
  choice('train', 'deep is scatter 0.7 at n=12; rigid is 0.2 at n=3 and is where warped textures belong',
    ['deep', 'rigid'] as const, () => params.train, (v) => (params.train = v));

  // --- the numeric rows -----------------------------------------------------
  for (const row of ROWS) {
    const wrap = el('label', 'labrow');
    const name = el('span', 'labname');
    name.textContent = row.label;
    name.title = row.hint;
    const field = numberField({
      min: row.min,
      max: row.max,
      step: row.step,
      pct: row.pct,
      get: () => params[row.field] as number,
      set: (v) => ((params[row.field] as number) = v),
      commit: () => {
        refresh();
        schedule();
      },
    });
    wrap.append(name, field.node);
    sheet.append(wrap);
    fields.push({ row, wrap, field });
  }

  // --- actions --------------------------------------------------------------
  const acts = el('div', 'labacts');
  const shoot = el('button');
  shoot.textContent = 'synthesize';
  shoot.title = 'run the real fractal-tip and paint with the result';
  const nameBox = el('input');
  nameBox.type = 'text';
  nameBox.placeholder = 'name to keep it under';
  nameBox.spellcheck = false;
  const keep = el('button');
  keep.textContent = 'keep';
  keep.title = 'write tips/<name>.spec.json, synthesize all three depths, and write the brush documents';
  const copy = el('button');
  copy.textContent = 'copy spec';
  copy.title = 'the spec JSON, ready to paste into tips/';
  acts.append(shoot, copy, nameBox, keep);
  sheet.append(acts);

  const preview = el('img', 'labshot');
  preview.alt = 'the synthesized tip';
  sheet.append(preview);

  function refresh(): void {
    presetSel.value = '—';
    for (const { row, wrap } of fields) wrap.hidden = row.when ? !row.when(params) : false;
    for (const { field } of fields) field.sync();
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = window.setTimeout(() => void synth(), 400);
  }

  async function synth(): Promise<void> {
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    shoot.disabled = true;
    shoot.textContent = 'synthesizing…';
    try {
      const res = await fetch('/__lab/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...params, native: 512 }),
      });
      const out = (await res.json()) as { png?: string; spec?: unknown; error?: string };
      if (!res.ok || out.error) throw new Error(out.error ?? `HTTP ${res.status}`);
      lastSpec = out.spec;
      preview.src = `data:image/png;base64,${out.png}`;
      await hooks.apply(out.png!, `lab · ${params.kind} ${params.wedge > 0 ? `wedge ${params.wedge}°` : 'isotropic'}`, params.train);
    } catch (e) {
      hooks.status(`spectrum lab: ${(e as Error).message}`, 6000);
    } finally {
      busy = false;
      shoot.disabled = false;
      shoot.textContent = 'synthesize';
      if (queued) {
        queued = false;
        void synth();
      }
    }
  }

  shoot.addEventListener('click', () => void synth());
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(lastSpec ?? {}, null, 1));
    hooks.status('spec copied — save it as tips/<name>.spec.json');
  });
  keep.addEventListener('click', () => {
    const name = nameBox.value.trim();
    if (!name) {
      hooks.status('give it a name first', 4000);
      return;
    }
    keep.disabled = true;
    keep.textContent = 'writing…';
    void (async () => {
      try {
        const res = await fetch('/__lab/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, params }),
        });
        const out = (await res.json()) as { written?: string[]; error?: string };
        if (!res.ok || out.error) throw new Error(out.error ?? `HTTP ${res.status}`);
        hooks.status(`kept: ${out.written!.length} files — reload to see ${name} in the library`, 8000);
      } catch (e) {
        hooks.status(`keep failed: ${(e as Error).message}`, 8000);
      } finally {
        keep.disabled = false;
        keep.textContent = 'keep';
      }
    })();
  });

  refresh();
}
