# Working with `.abr` files

An `.abr` is Photoshop's brush pack: sampled tip bitmaps, texture patterns,
and a descriptor holding names and dynamics. brushstudio both reads and
writes them, which is what makes the loop closed — you can study a pack a
professional shipped and then ship one of your own the same way.

## Studying a pack

```bash
npm run brush -- inspect refs/SomePack.abr                    # names + summaries
npm run brush -- inspect refs/SomePack.abr --json             # every setting, as a patch
npm run brush -- inspect refs/SomePack.abr --tips out/tips.png    # the tip bitmaps
npm run brush -- inspect refs/SomePack.abr --render out/pack.png  # draw its marks
```

`--json` is the one to reach for when copying an idea: each brush comes back
as the **minimal patch** against the engine defaults, so the few values that
make it distinctive are not buried in fifty defaults. Paste the interesting
part straight into a brush document.

`--render` runs the pack's brushes through the same test strokes your own
designs get, which is the only honest way to compare them.

Drop reference packs in `refs/`. They are ignored by git by default — most
are licensed, and a repo is not a good place to redistribute them.

## Borrowing a tip

Tip bitmaps inside a pack are addressed through the brush that uses them:

```json
"tips": { "flat": { "abr": "../refs/SomePack.abr", "tip": "Flat Bristle 45" } }
```

Check the licence of anything you borrow. A tip bitmap is the part of a
brush someone actually drew.

## Exporting

```bash
npm run brush -- export brushes/my-pack.json -o out/MyPack.abr
```

The writer emits version 6.2 files with the three sections a real Photoshop
file carries — `samp` (tip bitmaps), `patt` (patterns), `desc` (the
descriptor). Every tip and pattern the pack references is embedded.

Export always **reads its own bytes back** and reports anything that did not
survive; a non-empty issue list is a bug, not a warning. What round-trips is
checked per brush: name, tip geometry, the enabled state of every dynamics
section, flow, opacity, blend mode, and that sampled tips and patterns
resolve.

## What does not cross over

The engine is a Photoshop-parity engine, not Photoshop, and a few things
have no representation in the file format:

* **`notes`** are ours; they never enter the file.
* **Engine-only tips and patterns** are exported as *bitmaps*, so Photoshop
  gets the mark but not the generator. A procedural tip therefore lands as a
  fixed sampled tip at the resolution it was generated at.
* **Photoshop-only features** the engine does not model — bristle tips,
  erodible tips, airbrush cones, brush poses — are neither read nor written.
  A pack using them will import with those brushes reduced to what is
  representable, which `inspect` will show plainly.

## Verifying against the real thing

The harness is a very good model of Photoshop's engine, and a model is still
not the thing. Before shipping a pack, load the exported `.abr` in Photoshop
and draw the same test marks by hand. When they disagree, Photoshop is
right — record what differed in the brush's `notes` so the next revision
starts from the truth.

If a pack fails to load in Photoshop at all, export the brushes one at a
time: the error message names neither the brush nor the section, so a ladder
of single-brush files localises it in one pass instead of a bisect.
