# The parameters, and the relationships that matter

Photoshop's brush panel is a long list of independent-looking sliders. It
isn't. A handful of *ratios* between them decide what a mark looks like, and
almost every "why does my brush look fake" question is one of those ratios
being wrong. This page is the shortlist worth knowing before turning knobs.

Names below are the fields of a brush document's `settings`; the Photoshop
panel name is given where it differs.

## The ratios

### Edge hardness comes from flow ÷ spacing, not from Hardness

Hardness only shapes the analytic round tip. What squares off the flank of a
stroke is how many dabs pile up per unit of travel. Stack `N` overlapping
dabs of flow `f` and coverage approaches

```
A(r) = 1 − exp(−K · a(r)),      K = flow / spacing
```

for a tip profile `a(r)`. Large `K` drives the middle of the mark to full
opacity and leaves a sharp flank; small `K` lets the stroke keep the tip's
own falloff and stays translucent.

* `K ≥ 10` — loaded, opaque, hard-flanked. A palette knife.
* `K ≈ 2–4` — a brush that reads as paint but still glazes.
* `K ≤ 1.5` — a wash. Long translucent tails, because `N` collapses at the
  ends of a stroke where the pen lifts.

Two brushes with the same `K` behave alike even at very different flow, so
change flow and spacing *together* when you want a different feel and
*separately* when you want a different edge.

### Non-repetition comes from scatter ÷ spacing

A stamp train is a comb in the spectrum: a line at the stamping frequency is
exactly the "same mark every N pixels" artifact. Jitter attenuates that line
by the characteristic function of the offset distribution, which falls off
with

```
ρ = scatter / spacing
```

Keep `ρ ≥ 3` and the periodic component drops below a tenth of an
unscattered train — under the threshold where an eye picks the beat out.
`brushstudio measure` reports this directly as `repetition`: a `prominence`
near 1 means no line at all, and it is the number to watch when a brush
"looks stamped".

Scatter on **both axes** is not optional here. Across-stroke-only scatter
leaves the along-stroke coordinate untouched, and along-stroke is the axis
the beat lives on.

### Spacing is measured against the mark, not the setting

Spacing is a percentage of the tip mark's short side, so a squat sampled tip
packs its dabs tighter than a round tip at the same nominal size. A tip that
is 3:1 wide will feel roughly three times as densely stamped as a round one
at identical settings — budget for it rather than being surprised by it.

### Size jitter fights minimum diameter

`shape.sizeJitter` reduces size *downward* from the current size, and
`shape.minDiameter` floors it. Set both high and the jitter has almost no
room to act; the mark stops varying and the brush goes dead. If a brush is
meant to breathe, keep `minDiameter` under about `1 − sizeJitter`.

### Dual brush is a gate, not a second layer of paint

The secondary tip stamps into a coverage mask, and every primary dab is
multiplied by that mask. Consequences worth internalising:

* Dual **spacing above 100%** leaves holes the primary can never paint
  through — a broken stroke, not a textured one.
* Dual **size** scales with primary size, like Photoshop, so a dual brush
  stays coherent when you resize.
* The mask is where organic breakup comes from without touching the tip
  bitmap, which is why nearly every convincing oil brush uses one.

### Texture applies once per stroke by default

`texture.textureEachTip: false` (the Photoshop default) applies the pattern
to the finished stroke, so the grain stays registered to the canvas and
overlapping strokes agree with each other. Turning it on applies the pattern
per stamp, which enables depth jitter but makes the grain travel with the
brush — right for a stamping tool, wrong for anything meant to read as paper
showing through.

## The controls

Every dynamic has a **Control** source, which is the same list everywhere:

| source | driven by | notes |
| --- | --- | --- |
| `off` | nothing | the value is used flat |
| `fade` | stamp count | dies out over `fadeSteps` spacing steps |
| `pressure` | stylus pressure | the default for size and flow |
| `tilt` | how far the pen is laid over | 0 at upright, 1 at 60° |
| `rotation` | barrel rotation / twist | rarely available on cheap tablets |
| `direction` | stroke tangent | rotates a tip to follow the path |
| `initial-direction` | tangent at pen-down | fixes an orientation per stroke |

Two traps:

* **Direction is undefined at pen-down.** The engine holds the first dab
  back until the pen has actually moved, so a curved stroke does not start
  with a horizontal stub. Nothing to configure — but it explains why a
  direction-driven brush deposits nothing on a tap.
* **`tilt` needs a stylus.** A mouse reports no tilt, so a tilt-driven brush
  measures as a dead flat row on the `tilt` test stroke. That is the tool,
  not the brush.

## Opacity vs. flow

* **Flow** deposits per stamp and accumulates within a stroke.
* **Opacity** caps the whole stroke, so a single 50% stroke never
  self-darkens where it crosses itself.

`measure`'s `build-up` row is the check: `1 / 2 / 4` passes over the same
path, reported as absolute ink and as a ratio to the first pass. Ink that
flattens means something is capping it; ink that keeps climbing means flow
is in charge. Note that opacity caps *within* a stroke — four separate
passes still stack, exactly as they do in Photoshop.

## Quick reference: units in a brush document

| field | unit |
| --- | --- |
| `tip.size`, `dual.size` | document pixels |
| `tip.spacing`, `dual.spacing` | fraction of diameter (`0.25` = Photoshop's 25%) |
| `tip.hardness`, jitters, depths, flow, opacity | `0..1` |
| `tip.angle` | degrees, `-180..180` |
| `tip.roundness` | `0.01..1` (1 is a circle) |
| `scatter.scatter`, `dual.scatter` | fraction of diameter, `0..10` (Photoshop shows 0–1000%) |
| `scatter.count`, `dual.count` | stamps per spacing step, `1..16` |
| `texture.scale` | multiple of the pattern's native tile size |
| `color.hueJitter` | fraction of ±180° |
