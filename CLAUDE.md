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
| `docs/brush-format.md` | the brush document format |
| `docs/abr.md` | studying and shipping Photoshop packs |
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
npm run brush -- export  brushes/pack.json -o out/P.abr
npm run dev                                            # paint with it by hand
npm test                                               # engine + harness checks
npm run typecheck
```

Every command runs the real WebGPU engine in headless Chromium, so a render
takes tens of seconds rather than milliseconds. Batch work into one command
where you can, and do not poll a render in a loop.

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
* **Reference packs are licensed work.** `refs/` is gitignored; do not
  commit someone else's `.abr`, and check the licence before shipping a
  borrowed tip bitmap.
