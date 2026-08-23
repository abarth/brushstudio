# brushstudio

A harness for designing Photoshop brushes. The brush engine and the `.abr`
reader/writer are extracted from
[northlight](https://github.com/abarth/northlight); everything in
`src/harness/`, `tools/` and `web/` is the harness built around them.

## Working here

**Read `docs/workflow.md` before designing a brush.** It is the loop this
repo exists to support, and the parts that matter most are the ones that
decide when to spend a human's attention and when not to.

Then, as needed:

| | |
| --- | --- |
| `docs/parameters.md` | what the knobs do, and the ratios between them that actually decide a mark |
| `docs/fractal-texture-math.md` | the frequency-domain model of a stroke — read before designing a natural-texture brush or a coverage-graded family |
| `docs/brush-format.md` | the brush document format |
| `docs/abr.md` | studying and shipping Photoshop packs |
| `docs/backends.md` | the two renderers, and when the default is the wrong one |
| `docs/provenance.md` | what came from northlight, and how to keep it in sync |

## Commands

```bash
npm install
npm run brush -- list                                  # tips, patterns, test strokes
npm run brush -- show    brushes/x.json                # resolved settings
npm run brush -- render  brushes/x.json --annotate     # the plate of test marks
npm run brush -- measure brushes/x.json                # numbers, not impressions
npm run brush -- compare brushes/x.json --ref refs/P.abr#"Name"
npm run brush -- inspect refs/P.abr --json             # read a pack apart
npm run brush -- export  brushes/ -o out/P.abr         # a dir, docs or a pack
npm run dev                                            # paint with it by hand

node tools/fractal-tip.mjs tips/x.spec.json --calibrate  # synthesize + calibrate texture tips
node tools/spectrum-audit.mjs brushes/x.json             # comb/spike/isotropy/β on painted marks
node tools/accumulation-survey.mjs                       # what the dual gate can and cannot do to tone

npm test                 # the harness suite, CPU renderer (~4s)
npm run test:gpu         # the same suite through WebGPU (~30s)
npm run test:parity      # do the two renderers still agree
npm run typecheck
```

Commands paint with the CPU renderer by default and run entirely in this
process: a measure is a few seconds, a four-brush plate about six. Add
`--backend gpu` to run the same work through the WebGPU engine in headless
Chromium — several times slower, and the reference when a mark's correctness
is in question. Ask it for one brush and the rows you need rather than a
whole pack; `docs/backends.md` explains the split and why that matters.

## House rules

* **A brush is a file.** Designs live in `brushes/*.json` as patches over
  the engine defaults. Do not hard-code brushes into the harness.
* **Write `notes` first.** The design intent, and later the feedback that
  shaped the brush, belong in the document — including directions that were
  tried and rejected.
* **Measure before you show.** `measure` settles repetition, breaks, dead
  pressure response and runaway build-up. Take those to a human and you have
  spent their attention on something a command answers.
* **One or two parameters per iteration**, with `--seed` held fixed. The
  ratios in `docs/parameters.md` interact; a four-parameter change that
  improves the plate teaches nothing.
* **`src/brush/` and `src/gpu/` are extracted verbatim.** Fix a
  Photoshop-parity bug there only with a matching upstream fix in mind, and
  note it in `docs/provenance.md`.
* **The panel is a table.** Every control in the try-out app is one row of
  `web/groups.ts`, with the hint and the section's ratio beside it. `npm
  test` fails when a `BrushSettings` field has no row, so a new knob goes
  into the table, not into the renderer.
* **Two renderers, one behaviour.** Touching `src/gpu/shaders.ts` or
  `src/engine/cpu/` means running `npm run test:parity`. The WebGPU engine
  is the reference; the CPU one is a transliteration and drifts if nothing
  checks it.
* **Reference packs are licensed work.** `refs/` is gitignored; do not
  commit someone else's `.abr`, and check the licence before shipping a
  borrowed tip bitmap.
