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
| `src/brush/abrWrite.ts` | same path | verbatim — the `.abr` writer |
| `src/gpu/engine.ts` | same path | verbatim |
| `src/gpu/shaders.ts` | same path | verbatim |
| `src/gpu/stroke.ts` | same path | verbatim |
| `src/gpu/transfer.ts` | same path | verbatim |
| `src/color/convert.ts` | same path | verbatim |
| `src/transform/matrix.ts` | same path | verbatim |
| `src/types.ts` | same path | dropped `ToolId`, which is a tool-palette concern |

Everything under `src/harness/`, `tools/`, and `web/` is new: it is the
harness, not the engine.

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

Only `src/types.ts` is expected to differ. If you change engine code here to
fix a Photoshop-parity bug, the fix belongs upstream too — that is where it
will be exercised by a full application.

## Licence

Northlight is Apache-2.0, and so is this repository; `LICENSE` covers the
extracted code.
