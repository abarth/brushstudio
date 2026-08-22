#!/usr/bin/env node
/**
 * brushstudio — design Photoshop brushes from the command line.
 *
 *   npm run brush -- render brushes/my-brush.json
 *   npm run brush -- measure brushes/my-brush.json
 *   npm run brush -- inspect refs/SomePack.abr --tips out/tips.png
 *   npm run brush -- compare brushes/my-brush.json --ref refs/SomePack.abr#Chalk
 *   npm run brush -- export brushes/pack.json -o out/MyPack.abr
 *
 * Every command runs the real brush engine in a headless browser; see
 * tools/lib/page.mjs for why.
 */
import { basename, join } from 'node:path';
import { withHarness } from './lib/page.mjs';
import {
  loadAsset,
  loadDocs,
  writeBase64,
  writeOut,
  writePngDataUrl,
} from './lib/docs.mjs';

const argv = process.argv.slice(2);
const command = argv[0];

const flags = new Map();
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags.set(name, argv[++i]);
    else flags.set(name, true);
  } else if (arg === '-o') {
    flags.set('out', argv[++i]);
  } else {
    positional.push(arg);
  }
}
const flag = (name, fallback = undefined) => (flags.has(name) ? flags.get(name) : fallback);
const numFlag = (name, fallback) => (flags.has(name) ? Number(flags.get(name)) : fallback);
const boolFlag = (name) => flags.get(name) === true || flags.get(name) === 'true';
const listFlag = (name) => {
  const v = flag(name);
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
};
/** `--strokes all` draws every test mark there is. */
const strokeFlag = () => {
  const list = listFlag('strokes');
  return list?.length === 1 && list[0] === 'all' ? PLATE_STROKE_IDS : list;
};
// Kept in step with src/harness/strokes.ts by the `list` command, which is
// the only place the real catalogue is read.
const PLATE_STROKE_IDS = [
  'dabs', 'flat', 'taper', 'ladder', 'curves', 'crosshatch', 'wash', 'tilt', 'speed',
];
const verbose = boolFlag('verbose');

const OUT_DIR = flag('out-dir', 'out');
const defaultOut = (name) => join(OUT_DIR, name);

const USAGE = `brushstudio — a harness for designing Photoshop brushes

  list                                  what tips, patterns and test strokes exist
  tips                                  draw the built-in tip bitmaps to a sheet
  show    <brush.json…>                 resolved settings, expanded and checked
  render  <brush.json… | dir | pack>    draw the standard plate of test marks
  measure <brush.json…>                 numbers for the parts the eye misjudges
  compare <brush.json…> --ref A.abr[#name]
                                        one plate holding design and reference
  inspect <file.abr>                    read a Photoshop pack apart
  export  <brush.json… | pack.json>     write a .abr, then read it back to check

Common flags
  -o, --out <path>      where to write (default: ${OUT_DIR}/…)
  --json                machine-readable output
  --strokes a,b,c       which test marks to draw, or \`all\` (see \`list\`)
  --width <px>          plate width (default 1400)
  --seed <n>            redraw the same random decisions
  --dark                light ink on a dark ground
  --annotate            print what each row is for
  --seeds <n>           how many seeds \`measure\` averages over (default 4)
  --verbose             stream browser logs
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const plateOptions = () => ({
  width: numFlag('width', 1400),
  strokes: strokeFlag(),
  seed: numFlag('seed', 1),
  dark: boolFlag('dark'),
  annotate: boolFlag('annotate'),
});

/** `path/to.abr#BrushName` or `path/to.abr#3` */
function parseRef(spec, assets) {
  const hash = spec.lastIndexOf('#');
  const path = hash < 0 ? spec : spec.slice(0, hash);
  const want = hash < 0 ? undefined : spec.slice(hash + 1);
  return {
    abr: loadAsset(path, assets),
    brush: want === undefined ? undefined : /^\d+$/.test(want) ? Number(want) : want,
    label: basename(path),
  };
}

function reportWarnings(warnings) {
  if (!warnings?.length) return;
  console.error('');
  for (const w of warnings) console.error(`  warning: ${w}`);
}

async function main() {
  switch (command) {
    case 'list': {
      const catalog = await withHarness((page) => page.evaluate(() => window.__brushstudio.catalog), {
        verbose,
      });
      if (boolFlag('json')) {
        console.log(JSON.stringify(catalog, null, 2));
        break;
      }
      console.log('built-in tips');
      for (const t of catalog.tips) console.log(`  ${t.id.padEnd(18)} ${t.label}`);
      console.log('\nbuilt-in texture patterns');
      for (const p of catalog.patterns) console.log(`  ${p.id.padEnd(18)} ${p.label}`);
      console.log('\ntest strokes (--strokes)');
      for (const s of catalog.strokes) {
        console.log(`  ${s.id.padEnd(12)} ${s.label}\n  ${' '.repeat(12)} ${s.reveals}`);
      }
      break;
    }

    case 'tips': {
      const out = flag('out', defaultOut('builtin-tips.png'));
      const sheet = await withHarness(
        (page) =>
          page.evaluate(
            (dark) =>
              window.__brushstudio.renderTipSheet(
                window.__brushstudio.catalog.tips.map((t) => ({ id: t.id, label: t.label })),
                { dark },
              ),
            boolFlag('dark'),
          ),
        { verbose },
      );
      writePngDataUrl(out, sheet.png);
      console.log(`wrote ${out}  ${sheet.width}x${sheet.height}  (${sheet.rows.length} tips)`);
      break;
    }

    case 'show': {
      if (positional.length === 0) fail('show needs at least one brush document');
      const { docs, assets } = loadDocs(positional);
      const out = await withHarness(
        (page) =>
          page.evaluate(
            ([docs, assets]) => window.__brushstudio.resolvedSettings(docs, assets),
            [docs, assets],
          ),
        { verbose },
      );
      if (boolFlag('json')) {
        console.log(JSON.stringify(out, null, 2));
        break;
      }
      for (const brush of out) {
        console.log(`\n${brush.name}  [${brush.id}]`);
        for (const line of brush.explain) console.log(`  ${line}`);
        reportWarnings(brush.warnings);
      }
      break;
    }

    case 'render': {
      if (positional.length === 0) fail('render needs at least one brush document');
      const { docs, assets, packs } = loadDocs(positional);
      const stem =
        packs[0]?.name ?? `${docs[0].id}${docs.length > 1 ? `-and-${docs.length - 1}-more` : ''}`;
      const out = flag('out', defaultOut(`${String(stem).replace(/[^\w. -]+/g, '-')}.png`));
      const result = await withHarness(
        (page) =>
          page.evaluate(
            ([docs, assets, opts]) => window.__brushstudio.plate(docs, assets, opts),
            [docs, assets, plateOptions()],
          ),
        { verbose },
      );
      writePngDataUrl(out, result.png);
      console.log(`wrote ${out}  ${result.width}x${result.height}  (${docs.length} brush(es))`);
      reportWarnings(result.warnings);
      break;
    }

    case 'compare': {
      if (positional.length === 0) fail('compare needs at least one brush document');
      if (!flags.has('ref')) fail('compare needs --ref <file.abr>[#brush]');
      const { docs, assets } = loadDocs(positional);
      const refSpecs = String(flag('ref')).split(',');
      const refs = refSpecs.map((spec) => parseRef(spec, assets));
      const out = flag('out', defaultOut(`${docs[0].id}-vs-ref.png`));
      const result = await withHarness(
        (page) =>
          page.evaluate(
            ([docs, assets, refs, opts]) =>
              window.__brushstudio.comparePlate(docs, assets, refs, opts),
            [docs, assets, refs, plateOptions()],
          ),
        { verbose },
      );
      writePngDataUrl(out, result.png);
      console.log(`wrote ${out}  ${result.width}x${result.height}`);
      for (const row of result.rows) console.log(`  ${row}`);
      break;
    }

    case 'measure': {
      if (positional.length === 0) fail('measure needs at least one brush document');
      const { docs, assets } = loadDocs(positional);
      const seeds = numFlag('seeds', 4);
      const rows = await withHarness(
        (page) =>
          page.evaluate(
            ([docs, assets, opts]) => window.__brushstudio.measure(docs, assets, opts),
            [docs, assets, { seeds }],
          ),
        { verbose },
      );
      if (boolFlag('json')) {
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      for (const row of rows) {
        const m = row.metrics;
        console.log(`\n${row.name}  [${row.id}]`);
        console.log(`  ${row.summary}`);
        console.log(
          `  flat stroke    width ${m.flat.widthPx}px · coverage ${m.flat.coverage} · ` +
            `density ${m.flat.density} · ink ${m.flat.ink} · grain ${m.flat.grain}`,
        );
        console.log(
          `  repetition     beat every ${m.repetition.periodInDiameters} diameters · ` +
            `${m.repetition.prominence}x above the noise floor · ripple ` +
            `${(m.repetition.amplitude * 100).toFixed(0)}% · worst gap ` +
            `${m.repetition.worstGap} diameters`,
        );
        console.log(
          `  dab            ${m.dab.boxPx[0]}x${m.dab.boxPx[1]}px · core ` +
            `${m.dab.coreBoxPx[0]}x${m.dab.coreBoxPx[1]}px · peak ${m.dab.peakAlpha} · ` +
            `edge ${m.dab.edgeWidth} of radius`,
        );
        console.log(`  radial profile ${m.dab.radialProfile.map((v) => v.toFixed(2)).join(' ')}`);
        const pr = m.pressureResponse;
        console.log(
          `  pressure       width ${pr.map((p) => p.widthPx).join('/')}px  ` +
            `ink ${pr.map((p) => p.ink.toFixed(2)).join('/')}`,
        );
        console.log(
          `  build-up       1/2/4 passes → ink ` +
            `${m.buildup.map((b) => b.ink.toFixed(3)).join(' / ')} ` +
            `(x${m.buildup.map((b) => b.ratio).join(' / x')})`,
        );
        console.log(`  seed spread    mean ink ${m.seedSpread.mean} · cv ${m.seedSpread.cv}`);
        reportWarnings([...row.warnings, ...m.warnings]);
      }
      break;
    }

    case 'inspect': {
      if (positional.length === 0) fail('inspect needs an .abr file');
      const assets = {};
      const path = loadAsset(positional[0], assets);
      const result = await withHarness(
        async (page) => {
          const report = await page.evaluate(
            ([b64, path]) => window.__brushstudio.inspectAbr(b64, path),
            [assets[path].data, basename(path)],
          );
          const extra = {};
          if (flags.has('tips')) {
            extra.tipSheet = await page.evaluate(
              ([tips, path]) =>
                window.__brushstudio.renderTipSheet(
                  tips.map((t) => ({ id: `abr:${path}:${t.id}`, label: t.id.slice(0, 8) })),
                ),
              [report.tips, basename(path)],
            );
          }
          if (flags.has('render')) {
            extra.plate = await page.evaluate(
              ([b64, path, want, opts]) =>
                window.__brushstudio.renderPlate(
                  window.__brushstudio.abrEntries(b64, path, want),
                  opts,
                ),
              [
                assets[path].data,
                basename(path),
                flags.has('only')
                  ? /^\d+$/.test(flag('only'))
                    ? Number(flag('only'))
                    : flag('only')
                  : undefined,
                plateOptions(),
              ],
            );
          }
          return { report, extra };
        },
        { verbose },
      );

      if (flags.has('tips')) {
        const p = flag('tips') === true ? defaultOut('tips.png') : flag('tips');
        writePngDataUrl(p, result.extra.tipSheet.png);
        console.error(`wrote ${p}`);
      }
      if (flags.has('render')) {
        const p = flag('render') === true ? defaultOut('abr-plate.png') : flag('render');
        writePngDataUrl(p, result.extra.plate.png);
        console.error(`wrote ${p}`);
      }
      if (boolFlag('json')) {
        console.log(JSON.stringify(result.report, null, 2));
        break;
      }
      const r = result.report;
      console.log(`${basename(path)} — ABR v${r.version}`);
      console.log(`${r.brushes.length} brush(es), ${r.tips.length} tip(s), ${r.patterns.length} pattern(s)\n`);
      for (const b of r.brushes) {
        console.log(`  [${b.index}] ${b.name}`);
        console.log(`      ${b.summary}`);
      }
      console.log('\ntips');
      for (const t of r.tips) {
        console.log(
          `  ${t.id.slice(0, 10).padEnd(12)} ${String(t.size).padStart(4)}px  ` +
            `coverage ${t.coverage.toFixed(3)}  mean ${t.meanAlpha.toFixed(3)}`,
        );
      }
      if (r.patterns.length) {
        console.log('\npatterns');
        for (const p of r.patterns) {
          console.log(`  ${p.id.slice(0, 10).padEnd(12)} ${String(p.size).padStart(4)}px  ${p.name}`);
        }
      }
      console.log('\nrun again with --json for every brush\'s settings as a patch');
      break;
    }

    case 'export': {
      if (positional.length === 0) fail('export needs brush documents or a pack file');
      const { docs, assets, packs } = loadDocs(positional);
      const name = packs[0]?.name ?? docs[0].id;
      const out = flag('out', defaultOut(`${String(name).replace(/[^\w. -]+/g, '-')}.abr`));
      const result = await withHarness(
        (page) =>
          page.evaluate(
            ([docs, assets]) => window.__brushstudio.exportAbr(docs, assets),
            [docs, assets],
          ),
        { verbose },
      );
      writeBase64(out, result.abr);
      console.log(
        `wrote ${out} — ${(result.bytes / 1024).toFixed(0)} KB, ${result.names.length} brush(es), ` +
          `${result.tips} tip(s), ${result.patterns} pattern(s)`,
      );
      for (const n of result.names) console.log(`  ${n}`);
      reportWarnings(result.warnings);
      if (result.issues.length) {
        console.error(`\nround-trip issues (${result.issues.length}):`);
        for (const issue of result.issues) console.error(`  ${issue}`);
        process.exitCode = 1;
      } else {
        console.log('\nround-trip: every checked setting survived');
      }
      break;
    }

    default:
      console.log(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  if (verbose) console.error(err.stack);
  process.exit(1);
});
