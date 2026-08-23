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
| `tilt` | how far the pen is laid over | 0 at upright, 1 at 60° — but on an **angle** it is the tilt *azimuth* instead: the tip turns to point where the pen leans |
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

### Pose: making the mark depend on how the pen is held

A pencil worn to a facet does not draw the same line in every direction. Pull
it along the barrel and the mark is one lead wide; push it sideways and the
mark is the whole worn face. The engine can do that, and it is two settings:

* `shape.angleControl` on `tilt`, which turns the tip to the **azimuth** —
  the compass direction the pen leans.
* `tip.roundness` under 1, to give the ellipse something to be narrow about.
* `tip.angle` at **90**, because of the quarter turn below.

Four things about it are worth knowing before reaching for it.

**Pen Tilt on an angle carries a quarter turn.** Photoshop lays the tip's long
axis *across* the lean, not along it — which is what a flat nib does, since
tilting foreshortens the disc along the lean and leaves it broadest across.
A worn pencil facet is the other way round: its long axis lies along the
barrel's shadow on the page. So a facet brush wants `tip.angle: 90` to put it
back, and a nib brush wants 0. Verified against Photoshop — a tilt-bound tip
at angle 0 imports 90° out from what this engine used to draw, and the engine
now carries the quarter turn so the two agree. (The *sign* of the quarter turn
is not pinned: an ellipse at +90 and −90 is the same ellipse. It will matter
for a sampled tip that is not symmetric about its long axis.)

**Direction is not a substitute.** `direction` turns the tip to follow the
path, so the mark comes out the *same* width through every heading — the
exact opposite. Pose sources (`tilt`, `rotation`) hold the tip still in canvas
space while the stroke turns around it, which is what makes the width vary.

**Size is the ellipse's long axis.** Roundness squashes the short one, so
dropping roundness to 0.6 thins the everyday line by 40%. To flatten a tip
without changing the line it already draws, scale `tip.size` by `1 / roundness`
at the same time. Note that `texture.scale` should *not* follow that resize:
the mark on the paper did not get bigger, only the number the engine calls
Size did.

**Roundness under tilt ramps the wrong way for a pencil.** Every Control
scales its parameter *up* with its input, so roundness bound to `tilt` is
flattest upright and roundest laid over — right for a chisel marker held on
its corner, backwards for graphite, which flattens as the grip lays over.
There is no way to invert it, so a facet's depth has to be a constant. (This
is unverified against Photoshop: we write a `tiltScale` of 200% into the .abr
and never read one back, and 200% is exactly what would make `cos(2 × tilt)`
reach flat at 45°. If Photoshop flattens with tilt, the engine is the one
that is wrong.)

At zero tilt there is no azimuth to read — `atan2(0, 0)` is 0 — so a mouse,
or a pen held dead upright, gets the facet lying along the canvas x-axis.
Every probe in `measure` except the pose fan paints at zero tilt, so a
pose-driven brush's other numbers describe it pulled *along* its facet.

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
