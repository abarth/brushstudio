# Two renderers

Marks can be painted two ways, and the choice is about who is looking.

| | `cpu` (default) | `gpu` |
| --- | --- | --- |
| runs in | this Node process | headless Chromium, WebGPU |
| used by | the CLI, the test suite, agents | the try-out app (`npm run dev`), `--backend gpu` |
| needs | nothing | a browser, and a GPU or SwiftShader |
| authority | a transliteration | **the reference** — it is what a painter sees |

Measured on a four-core container with no GPU, so Chromium is running WebGPU
on SwiftShader — the worst case for the `gpu` column, and the case CI and
most sandboxes are actually in:

| | `cpu` | `gpu` |
| --- | --- | --- |
| `measure` the four starter brushes, 3 seeds | 4.3s | 20s |
| `render` one brush, four rows, no crosshatch | 1.8s | 7.2s |
| `render` the four-brush pack, every row | 6.6s | many minutes |
| the test suite (21 cases) | 3.5s | 26s |
| the parity check (10 brushes, both renderers) | — | 11s |

A GitHub Actions runner — four cores, also no GPU — puts the last two at 34s
and 9s, so these are not the numbers of an unusually slow machine. Only the
pack plate row is the sort of thing that would look different on real
hardware, and it is already the row you are told not to ask for.

The pack plate is the one row that is a different order of magnitude, and
the reason is worth knowing because it is not about fill rate. Baking a stroke into its layer is
a **fullscreen pass** on the GPU: it costs the same whether the stroke
crossed the whole page or laid a mark sixty pixels tall. So a plate's GPU
cost scales with the *number of strokes on it*, and the stroke count is not
evenly spread — the crosshatch row alone draws over a hundred short strokes
per brush, which is why a four-row plate without it renders in seconds and a
full pack plate does not. The CPU renderer merges only the rectangle each
stroke actually touched, so it barely notices.

For a spot-check on the reference renderer, ask for the rows that answer
your question — `--strokes flat,curves` on one brush — rather than a whole
pack. That is a seven-second command; the pack is not.

## Why there are two

The engine came from a painting app, where a stroke has to appear under a
moving stylus and the pixels never leave the GPU. A design harness wants the
opposite: it paints a mark and immediately asks *what does the alpha channel
say*, and pulling a texture back out of a browser's GPU process costs
200–1200ms a time. `measure` does that fifteen times. Nearly all of the
harness's original run time was readback, not painting — a stroke itself
takes about 10ms either way.

That readback cost is not a SwiftShader artefact: it is a round trip through
the browser's GPU process, and a real GPU shortens it without removing it.
A renderer in the same process has nothing to round-trip.

So the CPU renderer is not a cut-down version for when no GPU is around. It
is the one that fits how the harness works: the pixels are already in a
JavaScript array, there is nothing to read back, and a full measurement pass
finishes before a browser would have finished starting.

## What they share

Everything above the rasteriser, which is most of what makes these brushes
Photoshop-like:

* spacing, the dab train, and pen-state interpolation (`gpu/stroke.ts`)
* every dynamic — shape, scattering, colour, transfer (`brush/dynamics.ts`)
* the tip and pattern bitmaps (`brush/patterns.ts`, `brush/organicTips.ts`)
* the test marks, the plate, and every measurement

A stroke ends as a flat list of stamp records either way. All a renderer
does is put them on a surface. `src/engine/cpu/blend.ts` is a deliberate
line-for-line transliteration of the WGSL in `src/gpu/shaders.ts` — same
function names, same branches, same constants — so the two can be read side
by side.

## Where they differ

Not by design, but they do:

* **Arithmetic width.** WGSL works in `f32`, JavaScript in `f64`. Both
  accumulate into 8-bit buffers, so a half-a-level rounding difference
  becomes a level or two after a couple of hundred overlapping dabs.
* **Noise.** The `noise` toggle hashes with `fract(sin(x) * 43758.5453)`,
  which is chaotic by construction: at `f32` and at `f64` it produces
  different numbers, not nearby ones. A noise brush therefore has different
  grain on the two renderers — the same *character*, a different draw. This
  is the one place the difference is visible rather than numerical.

`npm run test:parity` paints ten brushes with both renderers inside one page
and reports how far apart they landed. It is a real check with real
tolerances, and it runs in CI: a change to either renderer that pulls them
apart fails there.

## Choosing

Use the default. Reach for `--backend gpu` when:

* a mark looks wrong and you want to know whether the CPU renderer is the
  reason — the GPU one is what the app paints, so it decides;
* you have changed `src/gpu/shaders.ts` or `src/engine/cpu/`, in which case
  run `npm run test:parity` too;
* a brush uses `noise` and you care about the exact grain.

```bash
npm run brush -- measure brushes/x.json --backend gpu
npm test                 # the suite, CPU
npm run test:gpu         # the same suite, WebGPU
npm run test:parity      # do they agree
```

The interactive app always uses WebGPU. It is drawing under a pointer at
full canvas size on a real GPU, which is exactly the case the engine was
written for.
