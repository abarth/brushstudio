/**
 * The spectrum lab's server half: a dev-only Vite plugin that synthesizes a
 * texture tip on demand and, when a candidate is worth keeping, writes it
 * into the repo as a spec plus its brush documents.
 *
 * Everything here shells out to `tools/fractal-tip.mjs` rather than
 * reimplementing the synthesis for the browser. That is the whole point: a
 * second implementation would drift from the one the CLI and the shipped
 * tips use, and a lab that lies about what a spec paints is worse than no
 * lab. The cost is a subprocess per preview — about half a second at the
 * lab's 512px preview size, against ~2s at the 1024px the saved tips use.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const TMP = join(ROOT, 'node_modules', '.brushstudio', 'lab');

const PRIMARY = { hardness: 0.85, spacing: 0.12, sizeJitter: 0.15, minDiameter: 0.45 };
const DUAL = {
  deep: { sizeRatio: 1.3, spacing: 0.07, scatter: 0.7, count: 1 },
  rigid: { sizeRatio: 1.3, spacing: 0.28, scatter: 0.2, count: 1 },
};
/** The train's overlap compensation (docs/whitepaper.md §5.2), by train. */
const GAIN = { deep: 3, rigid: 1.7 };

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Lab parameters → a fractal-tip spec.
 *
 * One builder, server-side, so the JSON the panel shows is the JSON that
 * produced the tip rather than a client-side guess at it.
 */
export function specFromParams(p = {}) {
  const train = p.train === 'rigid' ? 'rigid' : 'deep';
  const wedge = num(p.wedge, 0);
  const band =
    p.kind === 'law'
      ? (() => {
          const beta = num(p.beta, 2.4);
          return {
            bandLoCyclesPerDia: 0.5,
            shoulderCyclesPerDia: num(p.shoulder, 2.5),
            lowSlope: 1.5,
            beta,
            kneeCyclesPerDia: 400,
            beta2: beta,
            cutCyclesPerDia: num(p.cut, 70),
            taperCyclesPerDia: num(p.cut, 70) * 1.22,
          };
        })()
      : (() => {
          const k = num(p.k, 10);
          const w = num(p.ringWidth, 8);
          return {
            bandLoCyclesPerDia: k * 0.62,
            shoulderCyclesPerDia: k,
            lowSlope: w,
            beta: 0,
            kneeCyclesPerDia: k * 1.05,
            beta2: w + 1,
            cutCyclesPerDia: k * 5,
            taperCyclesPerDia: k * 6,
          };
        })();
  if (wedge > 0) {
    band.sectorDeg = wedge;
    band.sectorAxisDeg = num(p.axis, 0);
  }
  const warpAmp = num(p.warpAmp, 0);
  const depth = num(p.depth, 0.55);
  return {
    name: p.name || 'lab',
    notes: p.notes || 'Built in the spectrum lab (npm run dev). See docs/spectral-atlas.md.',
    native: num(p.native, 1024),
    seed: Math.round(num(p.seed, 20250823)),
    outDir: '.',
    spectrum: band,
    ...(warpAmp > 0 ? { warp: { amp: warpAmp, k: num(p.warpK, 2.5) } } : {}),
    vignette: { inner: 0.84, rag: 0.18 },
    aaCanvasPx: 0.7,
    train: { size: 120, flow: 0.9, primary: PRIMARY, dual: DUAL[train] },
    levels: p.levels ?? [{ coverage: depth, depth }],
    maskMode: 'tonal',
    tonal: {
      mode: p.mode === 'lognormal' ? 'lognormal' : 'modulate',
      ...(p.mode === 'lognormal' ? { sigma: num(p.sigma, 0.5) } : {}),
      gain: num(p.gain, GAIN[train]),
      floor: 0.02,
    },
    scatterDeconv: p.scatterDeconv ?? train === 'deep',
  };
}

/** The brush document a lab spec paints through, per level. */
export function brushFromSpec(spec, level, train) {
  const cap = spec.name[0].toUpperCase() + spec.name.slice(1);
  return {
    name: `${cap} ${level}`,
    id: `${spec.name}-${level}`,
    notes: `${spec.notes} TONAL dual-gate on the ${train} train; the level is damage DEPTH, not coverage. Built in the spectrum lab.`,
    tips: { mask: { image: `../tips/${spec.name}-${level}.png` } },
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
        spacing: spec.train.dual.spacing,
        scatter: spec.train.dual.scatter,
        bothAxes: true,
        count: 1,
        mode: 'multiply',
      },
      flow: 0.9,
    },
  };
}

function runTip(specPath, extra = []) {
  return new Promise((ok, bad) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools/fractal-tip.mjs'), specPath, ...extra], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.resume();
    child.on('error', bad);
    child.on('close', (code) =>
      code === 0 ? ok() : bad(new Error(err.split('\n').filter(Boolean).slice(-3).join(' ') || `exit ${code}`)),
    );
  });
}

const pct = (level) => Math.round(level.coverage * 100);

async function synthOne(params, name, extra = []) {
  const spec = specFromParams({ ...params, name, native: params.native ?? 512 });
  const specPath = join(TMP, `${name}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 1));
  await runTip(specPath, extra);
  return { spec, png: readFileSync(join(TMP, `${name}-${pct(spec.levels[0])}.png`)) };
}

/**
 * Synthesize for these parameters, with everything the lab shows alongside
 * the tip: the spectrum diagram, the radial curves behind it, and — when
 * the train is one we deconvolve for — the same texture synthesized WITHOUT
 * the 1/H correction, so the two can be put side by side.
 */
export async function preview(params) {
  mkdirSync(TMP, { recursive: true });
  const { spec, png } = await synthOne(params, 'preview', ['--diagram']);
  const diagram = readFileSync(join(TMP, 'preview.diagram.png'));
  const radial = JSON.parse(readFileSync(join(TMP, 'preview.diagram.json'), 'utf8'));
  const raw = spec.scatterDeconv
    ? (await synthOne({ ...params, scatterDeconv: false }, 'preview-raw')).png
    : null;
  return {
    png,
    raw,
    diagram,
    radial,
    // the caller shows this JSON, so hand back the spec as it will be SAVED —
    // full size and all three depths — not the cut-down preview one
    spec: specFromParams({ ...params, native: 1024, levels: LEVELS }),
  };
}

const LEVELS = [
  { coverage: 0.3, depth: 0.3 },
  { coverage: 0.55, depth: 0.55 },
  { coverage: 0.8, depth: 0.8 },
];

/**
 * Keep a candidate: write `tips/<name>.spec.json`, synthesize all three
 * depths into `tips/`, and write the three brush documents. The app's
 * library is a glob over `brushes/`, so the new family is in the picker on
 * the next reload.
 */
export async function save(name, params) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) {
    throw new Error('name must be lowercase letters, digits and dashes');
  }
  const train = params.train === 'rigid' ? 'rigid' : 'deep';
  const spec = specFromParams({ ...params, name, native: 1024, levels: LEVELS });
  const specPath = join(ROOT, 'tips', `${name}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 1));
  await runTip(specPath);
  const written = [`tips/${name}.spec.json`];
  for (const level of LEVELS) {
    const p = pct(level);
    writeFileSync(
      join(ROOT, 'brushes', `${name}-${p}.json`),
      JSON.stringify(brushFromSpec(spec, p, train), null, 2) + '\n',
    );
    written.push(`tips/${name}-${p}.png`, `brushes/${name}-${p}.json`);
  }
  return written;
}

function body(req) {
  return new Promise((ok, bad) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) bad(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(raw || '{}'));
      } catch (e) {
        bad(e);
      }
    });
  });
}

/**
 * The Vite plugin. Dev server only — these endpoints write into the working
 * tree, which is exactly what the lab is for and exactly what a built,
 * served bundle must never do.
 */
export function spectrumLab() {
  return {
    name: 'brushstudio-spectrum-lab',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__lab/preview', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const out = await preview(await body(req));
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                png: out.png.toString('base64'),
                raw: out.raw ? out.raw.toString('base64') : null,
                diagram: out.diagram.toString('base64'),
                radial: out.radial,
                spec: out.spec,
              }),
            );
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e.message ?? e) }));
          }
        })();
      });
      server.middlewares.use('/__lab/save', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const { name, params } = await body(req);
            const written = await save(name, params ?? {});
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ written }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e.message ?? e) }));
          }
        })();
      });
    },
    buildEnd() {
      rmSync(TMP, { recursive: true, force: true });
    },
  };
}
