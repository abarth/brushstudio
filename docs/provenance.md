# Where the engine came from

The brush engine, the `.abr` reader and the `.abr` writer in `src/` were
extracted from **[northlight](https://github.com/abarth/northlight)**, a
Photoshop-style painting app built on WebGPU. Northlight is where the
Photoshop-parity work happened — the dab dynamics, the dual-brush mask, the
texture blends, the descriptor schema for `.abr` — and brushstudio is that
engine with the app peeled off and a design harness put in its place.

## What was taken

| here | from northlight | changed |
| --- | --- | --- |
| `src/brush/types.ts` | `src/brush/types.ts` | verbatim |
| `src/brush/defaults.ts` | same path | verbatim |
| `src/brush/dynamics.ts` | same path | verbatim |
| `src/brush/patterns.ts` | same path | verbatim |
| `src/brush/organicTips.ts` | same path | verbatim |
| `src/brush/engineParams.ts` | same path | verbatim |
| `src/brush/abr.ts` | same path | verbatim — the `.abr` reader |
| `src/brush/abrWrite.ts` | same path | one fix — see below |
| `src/gpu/engine.ts` | same path | verbatim |
| `src/gpu/shaders.ts` | same path | verbatim |
| `src/gpu/stroke.ts` | same path | one change — see below |
| `src/gpu/transfer.ts` | same path | verbatim |
| `src/color/convert.ts` | same path | verbatim |
| `src/transform/matrix.ts` | same path | verbatim |
| `src/types.ts` | same path | dropped `ToolId`, which is a tool-palette concern |

Everything under `src/engine/`, `src/harness/`, `src/node/`, `tools/` and
`web/` is new: it is the harness, not the engine.

**The one change to extracted code** is in `src/gpu/stroke.ts`, which took
its renderer as a `PaintEngine` and now takes the `StampTarget` interface it
actually uses — a single method, `drawStampBatches`. That is what lets the
same stroke logic drive the WebGPU engine and the CPU renderer in
`src/engine/cpu/` (see `docs/backends.md`). It is a decoupling worth having
upstream too: nothing about turning pointer events into stamps needs to know
what draws them.

**The one Photoshop-parity fix** is in `src/brush/abrWrite.ts`, which wrote
the options-bar Opacity and Flow inside `toolOptions` as `long` where every
other percentage in the file is a `UntF` `#Prc` unit float. Photoshop ignores
a percentage at the wrong type: a brush exported from here imported with both
sliders left at whatever the tool was already set to, so a design whose whole
character is a low flow arrived as a different brush. The key spellings and
their order came from a real file and were right; only the two types were
wrong. The fix belongs upstream too — northlight writes the same packs — and
`tests/cases.mjs` reads the bytes back to hold the types in place, because a
round trip through `abr.ts` cannot: its `num()` unwraps a unit float and a
long alike, exactly as a lenient reader of other people's files should.

`src/engine/cpu/blend.ts` is a line-for-line transliteration of the WGSL in
`src/gpu/shaders.ts`. It is new code, but it is not independent: when the
shaders change it has to change with them, and `npm run test:parity` is what
catches it when that is forgotten.

**Deliberately left behind:** the React UI, the zustand store, the layer and
selection controllers, transforms, history, and northlight's own preset
library. A brush here is a file in `brushes/`, which is the whole point —
the app's built-in brush list would be someone else's design decisions
carried into this repo for no reason.

## Keeping them in sync

The copies are verbatim precisely so that they stay diffable. To pull a fix
across:

```bash
git clone https://github.com/abarth/northlight /tmp/northlight
diff -ru /tmp/northlight/src/brush src/brush
diff -ru /tmp/northlight/src/gpu src/gpu     # engine.ts, shaders.ts, stroke.ts, transfer.ts
```

Only `src/types.ts`, the `stroke.ts` signature and the `abrWrite.ts` fix
above are expected to differ. If you change engine code here to fix a
Photoshop-parity bug, the fix belongs upstream too — that is where it will be
exercised by a full application — and it belongs in `src/engine/cpu/` as
well, or the two renderers drift.

## Licence

Northlight is Apache-2.0, and so is this repository; `LICENSE` covers the
extracted code.
