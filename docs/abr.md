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

The reader it goes through is strict, which is what makes the check worth
anything: a value at a type Photoshop would refuse comes back as an issue
rather than arriving unwrapped and looking correct, and a descriptor at the
wrong class id is reported the same way. What a round trip still cannot see
is a key Photoshop wants that we never write — an absent key is not an error
to either side — and the *unit* on a value, since our reader and writer would
have to disagree about it for that to show. Those are pinned by reading the
bytes directly in `tests/cases.mjs`, against the table below.

## The descriptor we write

There is no Adobe documentation for this part of the format. The key names
below came out of real files; the types come from Photoshop's own scripting
API, which reads and writes these same descriptors through `getInteger`,
`getUnitDouble` and friends, and a key at the wrong type is a key Photoshop
refuses rather than a near miss.

Everything here has been read back out of packs Photoshop itself wrote —
49 brushes across two of them, with the reader in strict mode reporting
anything that disagreed, which is how `Cnt ` was caught being a `doub`. The
rows still marked *inferred* are the ones no pack has exercised yet.

One rule governs the whole table: **the Brush Settings panel stores
percentages as `UntF` `#Prc` unit floats, and the options bar stores whole
integers.** `toolOptions` is the options bar, which is why Opacity, Flow and
Smoothing are the only percentages in the file that are not unit floats — it
reads like an inconsistency and is not one.

**The tip** — `Brsh`, classed `computedBrush` or `sampledBrush`. Photoshop
rejects a tip at any other class with "unknown brush type".

| key | type | is |
| --- | --- | --- |
| `Dmtr` | `UntF #Pxl` | size, in pixels — *not* a percentage |
| `Hrdn` `Rndn` `Spcn` | `UntF #Prc` | hardness, roundness, spacing |
| `Angl` | `UntF #Ang` | angle, in degrees |
| `Intr` `flipX` `flipY` | `bool` | spacing on, and the tip's own flips |
| `Nm  ` `sampledData` | `TEXT` | name, and the `samp` uuid on a sampled tip |

**The preset** — classed `brushPreset`, one per brush.

| key | type | is |
| --- | --- | --- |
| `use*` (`useTipDynamics`, `useScatter`, `useTexture`, `usePaintDynamics`, `useColorDynamics`) | `bool` | the section switches |
| `minimumDiameter` `minimumRoundness` `tiltScale` | `UntF #Prc` | Shape Dynamics floors |
| `szVr` `angleDynamics` `roundnessDynamics` `scatterDynamics` `countDynamics` `opVr` `prVr` `clVr` `textureDepthDynamics` | `Objc` classed `brVr` | one dynamics object each |
| `bVTy` `fStp` | `long` | inside `brVr`: control source, fade steps |
| `jitter` `Mnm ` | `UntF #Prc` | inside `brVr`: the jitter and its minimum |
| `Cnt ` | `doub` | count — in `dualBrush` and in Scattering alike; it looks like an integer and is not one |
| `textureScale` `textureDepth` `minimumDepth` | `UntF #Prc` | Texture amounts |
| `textureBrightness` `textureContrast` | `long` | the Texture panel's integer sliders (-150..150, -50..100) |
| `textureBlendMode` `BlnM` `Md  ` | `enum` `BlnM` | blend modes |
| `H   ` `Strt` `Brgh` `purity` | `UntF #Prc` | Color Dynamics |
| `Wtdg` `Nose` `Rpt ` | `bool` | wet edges, noise, airbrush |

**The options bar** — `toolOptions`. There is no *Include Tool Settings*
flag: a preset saved with tool settings carries this descriptor and one saved
without simply has none, which is why such a brush imports painting at
whatever the tool was already set to. (Verified: one brush in a real pack has
no `toolOptions` at all, and every other brush in the same pack has one.)

Its **class is the tool the preset was bound to** — `PbTl` paintbrush, `PcTl`
pencil, `ErTl` eraser, `SmTl` smudge — because saving with tool settings
binds the preset to the tool in use at the time. `inspect` names the tool
when it is not the brush, which is worth knowing before reading a plate: this
engine paints a smudge preset as though it were a brush.

The descriptor also carries the *tool's own* dynamics — `szVr`, `opVr`,
`prVr`, `clVr` — and which of them appear depends on the tool: the pencil has
no flow, the smudge tool has strength rather than opacity. None are read
here; the Brush Settings panel's copies are what the engine paints from.

What a pack puts in this descriptor otherwise varies by Photoshop version:
of the two read so far, one carries the smoothing keys and no tool dynamics,
the other carries the tool dynamics and no smoothing keys. Only `flow`,
`Opct` and `Md  ` appear in both.

| key | type | is | evidence |
| --- | --- | --- | --- |
| `Opct` | `long` | Opacity, 0..100 | `getInteger(stringIDToTypeID('opacity'))` |
| `flow` | `long` | Flow, 0..100 | `getInteger(stringIDToTypeID('flow'))` |
| `Smoo` | `long` | Smoothing amount, 0..100 | `putInteger(stringIDToTypeID('smooth'), n)` |
| `smoothingValue` | `doub` | the same amount over 255 | `putDouble(…'smoothingValue', n / 100 * 255)` |
| `smoothing` | `bool` | smoothing on | |
| `Md  ` | `enum` `BlnM` | paint blend mode | |
| `usePressureOverridesSize` / `…Opacity` | `bool` | the pressure override buttons | |

**Still unsettled**, and marked here so nobody re-derives it from scratch:

* `smoothingValue`'s 0..255 scale rests on one Adobe forum recipe. Of the two
  packs read so far, one has Smoothing at 0 on every brush and the other has
  no smoothing keys at all, so neither says anything about the scale. `Smoo`
  is written and read first, so this only matters if Photoshop prefers the
  other key.

## What a pack can tell you

`inspect` reports what the reader refused, which is the fastest way to check
this table against a file Photoshop itself wrote:

```bash
npm run brush -- inspect refs/SomePack.abr          # a `descriptor issues` section, when there is one
npm run brush -- inspect refs/SomePack.abr --json   # every issue, structured
npm run brush -- inspect refs/SomePack.abr --dump 0 # the raw descriptor of one brush
```

`--dump` is the one to reach for when a brush imports wrong and nothing is
*reported*: a reader can flag a key at the wrong type, but not a key that is
simply absent, since most of them legitimately are. Dump the same brush from
a pack Photoshop wrote and from one we wrote, and diff the two.

Three kinds show up there. A **type** or **class** issue on a real pack means
our table is wrong and should be corrected — Photoshop wrote that file, so it
is right by definition. A **not read** list names keys the pack carries that
we do not model; that is where a missing feature announces itself, and where
an undocumented flag like *Include Tool Settings* would appear if it exists.

## What does not cross over

The engine is a Photoshop-parity engine, not Photoshop, and a few things
have no representation in the file format:

* **`notes`** are ours; they never enter the file.
* **Engine-only tips and patterns** are exported as *bitmaps*, so Photoshop
  gets the mark but not the generator. A procedural tip therefore lands as a
  fixed sampled tip at the resolution it was generated at.
* **Photoshop-only features** the engine does not model — bristle tips,
  erodible tips, airbrush cones, brush poses, the Mixer Brush's wet and mix
  dynamics (`wtVr`, `mxVr`), Protect Texture, the tool's own dynamics inside
  `toolOptions`, and the CC2018 smoothing refinements beside the Smoothing
  amount — are neither read nor written.
* **Presets for another tool** — a pack often carries smudge, eraser and
  pencil presets beside its brushes. They read fine and `inspect` names them,
  but every plate here paints them as a brush, which for a smudge preset is
  not the mark Photoshop would make.
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
