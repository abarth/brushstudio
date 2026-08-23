# The spectral atlas: designing a texture as a power spectrum

`docs/fractal-texture-math.md` §6 ends with a split. A texture whose identity
lives in its *phase* — cracks, cell walls, scratches, facet edges — needs a
generator and a shallow rigid mask train, because deep overlap averages
independent windows and blends that structure to mush. A texture whose
identity lives in its *spectrum* — a Gaussian field — can spend overlap
freely, because the average of independent windows of a Gaussian field is
the same field.

For that second half, the entire design surface is a **2-D power spectrum**.
Everything else is random phase. This page is the map of that surface: what
the axes are, what fractals specifically look like on it, and what each
region actually paints. It is a working notebook, not a finished theory —
entries get added as the space is swept.

Sheets referenced throughout, all regenerable with the procedure in §5:
`out/spectral-atlas{,-2,-3}.png` are the field tiles (groups A–G, H–J, K–O)
and `out/spectral-atlas{,-2,-3}-strokes.png` the painted shortlists.

## 0. Promoted: the twelve

Fifty-five spectra were swept across three rounds; twelve are now brush
families, at `tips/<name>.spec.json` with 30/55/80 depth levels in
`brushes/`. Sheets: `out/twelve-swatches.png`, `out/twelve-strokes.png`.

| family | spectrum | train | texture % | reads as |
| --- | --- | --- | --- | --- |
| **flow** | ring k=10 + wedge 18° + warp | rigid | 17.1 | water surface, current, drift |
| **whorl** | ring k=16 + wedge 12° + warp | rigid | 14.1 | fingerprint eddies, burl, turbulence |
| **drape** | β=3.0 + wedge 22° + warp | rigid 0.18 | 10.2 | hanging cloth |
| **reticule** | ring k=16 | deep | 10.0 | pumice, coral rag, even pitting |
| **labyrinth** | ring k=8 | deep | 9.9 | brain coral, dense foam |
| **sand** | ring k=10 + wedge 18° | deep | 9.5 | rippled sand, with free dislocations |
| **woodgrain** | β=2.6 + wedge 14° along + warp | rigid 0.14 | 9.5 | grain round a knot, smoke curl |
| **corduroy** | ring k=16 + wedge 12° along | deep | 8.6 | combed clay, drawn fibre |
| **herringbone** | two wedges at ±40° | deep | 7.4 | crosshatch, woven mesh |
| **tooth** | near-white 12–70 c/dia | deep | 7.2 | paper tooth, spray, film grain |
| **vesicle** | ring k=16 + lognormal σ=0.5 | deep | 5.9 | vesicular basalt, beaded glaze |
| **strata** | coarse ×9 + thin grain | deep | 5.6 | bedded sediment, weathered plank |

Every one clears the acceptance bars at depth 0.55 (ripple 1.1–2.8%, comb p-p
0.9–5.1%). Two needed their rigid train tightened past the family default
to get there — woodgrain to spacing 0.14, drape to 0.18 — because a
scale-free wedge carries coarse power right where the count staircase sits.

Three changed after the first pass at review. Vesicle's σ came down from
0.8, which had left it near-solid paint with a whisper of beading; corduroy
and woodgrain turned their crest axis 90° so the fibre runs *along* the
mark. Turning those two also caught a directional blind spot in the audit —
`texture %` used to be measured along the stroke, which read a wedge rotated
90° as having lost half its contrast — so every number in this table is from
the tiled 2-D measure that replaced it and none is comparable to a figure
quoted earlier in this page.

The selection weighted three things: measured delivered contrast, distinct
material territory (no two of the twelve are the same idea at different
settings), and review — the directional group, the rings and the lognormal
mapping were all asked for by name.

**Held in reserve** — measured, ready, and written out in §7 so the next
group can be promoted without re-deriving anything.

### Why the directional group led the selection

It was not on the map at all until `sectorDeg` existed, it produced the
highest delivered contrast of anything measured, and it covers material
ground the shipped collection cannot reach — ripple, weave, drapery, flow,
grain. As reviewed:

| candidate | spectrum | texture % | note |
| --- | --- | --- | --- |
| **flow** | ring k=10 + wedge 18° + warp | **17.6** | rigid train; the highest contrast measured anywhere here |
| **whorl** | ring k=16 + wedge 12° + warp | **15.9** | rigid train; fingerprint eddies, holds along a stroke |
| **grain** | β=2.6 + wedge 14° + warp | 12.3 | rigid train; wood grain, smoke curl |
| **sand** | ring k=10 + wedge 18° | 10.4 | deep train; ripples with free dislocations |
| **width dial** | ring k=12, wedge 5/12/30/55° | 10.4–10.5 | a family axis in its own right (§3, group M) |
| **comb** | ring k=16 + wedge 12° | 10.0 | deep train; corduroy, drawn fibre |
| **brushed** | coarse 20° + fine cross 25° | 9.5 | deep train; brushed panel |
| **herringbone** | two wedges at ±40° | 8.5 | deep train; crosshatch, woven mesh |
| **swell** | ring k=4 + wedge 30° | 7.7 | deep train; crossing wave trains |

Behind it, the **ring** group (labyrinth k=8, reticulation k=16), the
**ladder**, **tooth**, and the **lognormal cascade** as a mapping that
applies across all of them.

Two decisions carried into the promotion. The warped families ship on the
**shallow rigid train**, not the deep one (§4). And the crest axis is a
design choice per brush, not a default (§2): sand and flow put their crests
*across* a horizontal stroke, corduroy and woodgrain run them *along* it.

## 1. What makes a spectrum *fractal*

A pure power law is the only spectrum with no characteristic scale:

```
S(f) ∝ f^(−β)     ⇒     S(λf) = λ^(−β)·S(f)
```

Zoom in and the statistics are unchanged. Every other spectrum on this page
has a scale in it somewhere. Four consequences worth having in hand:

**β sets the roughness, exactly.** For a 2-D self-affine surface (fractional
Brownian motion) the exponent, the Hurst exponent and the fractal dimension
are one parameter wearing three hats:

```
β = 2H + 2        H = (β − 2)/2        D = 3 − H = 4 − β/2
```

| β | H | D | what it paints (group A) |
| --- | --- | --- | --- |
| 1.0 | — | — | salt-and-pepper; below fBm, stationary and anti-persistent |
| 2.0 | 0 | 3.0 | the roughest surface there is; grain that just begins to clump |
| 2.4 | 0.2 | 2.8 | clumped mottle — most natural weathered surfaces sit near here |
| 2.8 | 0.4 | 2.6 | cloud-like, structure at every scale but coarse-dominant |
| 3.2 | 0.6 | 2.4 | soft billows |
| 3.6 | 0.8 | 2.2 | smooth, nearly differentiable — and see the next point |

**β = 2 is the equal-variance-per-octave line.** In 2-D the number of modes
in an octave grows as `k²`, so variance per octave goes as `k^(2−β)`. At
β = 2 no scale dominates. Above it the coarse scales carry the variance;
below it the fine ones do. This is the single most useful number on the page:
it says *which end of the texture the eye will read first*.

**A real fractal is band-limited, and must be.** Nature's power laws run
between an **outer scale** (the size of the object) and an **inner scale**
(its grain). A tip has about seven octaves, and a pure law at β ≥ 3.2 puts
nearly all of its variance in the first one — group A's β = 3.6 tile is a
single bright mass, not a texture. Group B is the same slope with the
variance capped below a shoulder at 2.5 c/dia, and it is usable. **The
shoulder is not a fudge; it is the outer scale**, and every shipped spec has
one. The `cut` is the inner scale (group C: at 8 c/dia the material has no
fine detail at all and reads soft-focus; at 60 it is granular).

**Lacunarity and multifractality are the two ways past a single β.**
Lacunarity is gappiness — a ladder of discrete rungs rather than a continuum
(group D). Multifractality is a spectrum whose exponent is not one number,
and the classic generator for it is a **multiplicative cascade**, which is
also the natural fit here, for a reason that is specific to this engine:

> The mask accumulates a **geometric mean** of the stamps' damage
> (`1 − m = depth·GM(d)`, math doc §6). A lognormal damage map is therefore
> this architecture's *exact fixed point* — averaging `n` windows leaves the
> distribution lognormal with `σ/√n`, which `tonal.gain` restores exactly. A
> uniform (rank-equalized) map survives only in rank order; its shape is
> pulled toward lognormal by the same averaging.

So `tonal.mode: "lognormal"` (group G) is not a stylistic option among
others — it is the histogram this mask *wants*. `sigma` sets intermittency:
the median damage lands at `e^(−2.58σ)`, so the field reads as mostly-intact
with rare deep bites. That is the signature of cascade processes generally
(turbulence, rain, cloud edges), and it is a look the rank mapping cannot
reach.

## 2. The axes

| axis | knob | what it changes |
| --- | --- | --- |
| slope | `beta`, `beta2` | roughness; which end of the scale range the eye reads first (§1) |
| outer scale | `shoulderCyclesPerDia`, `lowSlope` | the largest structure; caps coarse variance so the tip is a texture and not a blob |
| inner scale | `cutCyclesPerDia`, `taperCyclesPerDia` | how fine the material gets before it goes smooth |
| bandwidth | shoulder ≈ knee | a narrow band is a **ring**: one scale, random phase |
| anisotropy | `stretchX`, `stretchY`, per component | direction by *squeezing*: blobs become ellipses, every orientation still present |
| orientation | `sectorDeg`, `sectorAxisDeg`, per component | direction by *deletion*: one orientation survives, which is what makes crests |
| composition | `components[]` | sums of bands, including deliberate gaps |
| histogram | `tonal.mode`, `sigma`, `gain` | rank-uniform vs lognormal cascade (§1) |

Three notes on direction. **Squeezing and deleting are not the same
operation.** `stretchX` is an affine squeeze of the passband: blobs become
ellipses, but every orientation is still present, so a stretched ring gives
elongated *lobes*. A wedge (`sectorDeg`, a Gaussian half-width in degrees
about `sectorAxisDeg`) deletes all but one orientation, and that is what
produces parallel *crests* — ripples, folds, combed clay. It is the single
highest-yield knob found so far: the two highest delivered-contrast
textures measured anywhere in this atlas are both wedges.

**The axis is the wavevector, not the crest.** `sectorAxisDeg: 0` makes the
field vary along x, so the crests run vertically; add 90° to turn them.
Against a horizontal stroke those two choices read completely differently —
crests *across* the mark (hatching it) versus *along* it (a fibrous drag) —
so the axis is a brush-design decision, not a detail.

**The axis is fixed to the canvas.** Dual stamps mirror but never rotate, so
the grain runs the same way whichever way the stroke goes and a curved
stroke crosses its own grain. For sand, bedding or a brushed panel that is a
material property. For anything meant to follow the hand, it is a defect.

## 3. Catalogue

Verdicts are from the field tiles plus painted strokes at depth 0.55 on the
deep scattered train (`out/spectral-atlas-strokes.png`); `texture %` is the
audit's delivered-contrast measure.

| entry | spectrum | reads as | verdict |
| --- | --- | --- | --- |
| **ring k=8** | narrow band at 8 c/dia | labyrinth, brain coral, dense foam | **strong** — 7.3%, a scale with no pattern; nothing in the collection looks like it |
| **ring k=16** | narrow band at 16 c/dia | fine even reticulation, pumice | **strong** — 9.6%, the highest delivered contrast of any candidate |
| **ladder** | rungs at 2, 7, 24 c/dia | multi-scale clumped grain | **strong** — 6.6%, reads more "natural" than a smooth slope |
| **tooth** | near-white, 12–70 c/dia | paper grain, spray | **strong** — 8.7%, a workhorse for shading |
| **β=3.6 + outer** | steep, shoulder 2.5 | soft billow with fine grain | good — 5.9% |
| **vapour** | β=4, one octave | haze, atmosphere, soft airbrush | good — an effect, not a material |
| **frost** | notch at 1.5 + 24 c/dia | spray landing on a coarse surface | good — two scales with nothing between |
| **cut 8** | β=2.4, inner scale 8 | soft-focus wash, no fine detail | good — 4.5%, distinctive by *absence* |
| **sand** | ring k=10 + wedge 18° | rippled sand, wind-drift, water | **strong** — 10.4%, the highest delivered contrast measured; dislocations come free from the random phase |
| **comb** | ring k=16 + wedge 12° | combed clay, corduroy, drawn fibre | **strong** — 10.0%, crisp and graphic |
| **herringbone** | two wedges at ±40° | crosshatch, woven mesh, hatched shading | **strong** — 8.5% at the lowest ripple of the group (1.7%) |
| **swell** | ring k=4 + wedge 30° | crossing wave trains, interference | good — 7.7%, chunkier and more organic than sand |
| **strata (reworked)** | coarse ×9, grain at 0.18 | bedded sediment, weathered plank | good — 7.5%; the first version buried its coarse band, this one does not |
| **drape** | β=3.0 + wedge 25° | cloth folds at every scale | good — 4.7%, soft; wants more depth to read |
| **vesicle** | ring k=16 + lognormal σ=0.8 | beaded, vesicular basalt | good — 4.6%, the two most distinctive axes crossed |
| **pit** | ring k=8 + lognormal σ=1.0 | scattered round pitting | fair — 3.2%, subtle at depth 0.55 |
| **cascade σ=0.45** | lognormal, low σ | intermittent cloud with real contrast | good — the retune the sparse σ=1.2 version needed |
| **ring + power-law floor** | ring k=10 over β=2.4 | cells lost in roughness | weak — the floor swamps the cellular band |
| **ring k=2.5** | very low ring | big soft lobes | weak — coarser than the tip can carry |
| **flow / whorl / grain** | wedge + domain warp | flow lines, fingerprint eddies, wood grain | **strong** — 17.6 / 15.9 / 12.3%, but phase textures: rigid train only (§4) |
| **width dial** | ring k=12, wedge 5→55° | corrugation → ripple → broken crest → mild bias | **strong** — a legible family axis; 5° is graphic, 55° is barely directional |
| **brushed** | coarse wedge 20° + fine cross wedge 25° | brushed panel, drag over drag | good — 9.5%; two directions at two scales |
| **crest axis 90°** | the same wedges turned | grain running *along* the mark | good — softer than across (4.9% for comb) but the natural choice for a drag |
| **runs** | wedge 16° + lognormal σ=0.6 | rain, drips, weathering streaks | fair — 4.9%; the idea works, wants more depth than 0.55 |
| **stretchX 15** | strong single-axis squeeze | combed, dragged, brushed panel | conditional — canvas-fixed axis (§2) |
| **crossed rings** | rings on both axes | weave, basket, plaid | conditional — legible but reads regular |
| **cascade σ=1.2** | lognormal damage | intermittent, rare deep bites | needs work — too sparse at depth 0.55; wants higher depth or lower σ |
| **strata** | coarse ×9 under iso grain | bedded stone | needs work — the coarse band is buried under its own grain |
| **1–2 octave gaps** | lacunar | grain over cloud | weak — the fine band dominates; the gap does not read |
| **silt, crepe** | broad β=1.4; mid-band bump | even mottle; crumple | weak — close to cloud and agate |

## 4. The phase boundary, measured

A domain warp is the one way to give a spectral texture large-scale
organisation — but the curves it makes are *phase*, so it moves the texture
across the line this atlas is built on. That prediction is now tested rather
than argued: the same warped tip, painted on both trains.

| texture | deep train (scatter 0.7, n̄ 12) | rigid train (scatter 0.2, n̄ 3) |
| --- | --- | --- |
| whorl | 9.1% — the eddies blend into uniform hatching | **15.9%** — the eddies survive as eddies |
| flow | 10.1% | **17.6%** |

Three-quarters more delivered contrast on the rigid train, at equal or
better ripple (1.9–2.1% against 2.2–2.7%). So warping is not a free
decoration on a spectral texture: it *reclassifies* it. Add a warp and the
brush moves trains.

The converse is the useful half. An unwarped wedge is stationary and Gaussian
like everything else in §1, so it keeps the deep train and the wild scatter;
warp it and you trade that for structure the eye can follow.

## 5. Procedure

```bash
node tools/fractal-tip.mjs cand.spec.json --field 0.55    # ~1s: the damage
                                                          # map as ink on paper
node tools/spectrum-audit.mjs cand-55.json                # ~20s: painted stroke
```

Sweep with `--field` — for a spectral texture on a deep train the stroke
reproduces the field, so the preview is faithful and costs a second. Paint
only the shortlist. Judge tonal candidates on the **stroke crop**, never the
patch (math doc §7: a tonal patch bands along its own fill rows).

Exploration specs carry no `tonal.gain`, so the preview shows the design
itself. Add `gain ≈ 3` and `floor 0.02` when promoting, so the deep train
delivers that design rather than a flattened version of it (math doc §6).

**Or sweep it by hand.** `npm run dev` has two panel modes, and the second
is a **spectrum lab**: the same
parameters as a popover, synthesizing a tip you can immediately paint with,
with `copy spec` for the JSON and `keep` to write `tips/<name>.spec.json`,
all three depths, and the brush documents straight into the repo — the new
family is in the library on the next reload. The lab does not reimplement
the synthesis; each preview is a real `tools/fractal-tip.mjs` run behind a
dev-server endpoint (`tools/lib/lab.mjs`), at 512px rather than 1024 so it
comes back in about a second. A browser reimplementation would drift from
the tool that made the shipped tips, and a lab that misrepresents what a
spec paints is worse than no lab.

Beside the tip it shows what the synthesis filter is doing —
`fractal-tip --diagram` writes this for any spec, so it is available from
the CLI too:

* **three centred log-power maps**: the target `S★`, the train's transfer
  `H = 1 − Λ(2π|f|S)²`, and the `S★/H` that actually gets synthesized. `H`
  is drawn at ±8 c/dia and the other two at ±40, because the two live a
  decade apart and one shared frame renders `H` as a flat white square.
* **the radial view**, where the interaction is legible: `S★` and `S★/H` on
  log-log axes with `H` behind them on a linear 0–1 scale, and the two
  frequencies the train puts on the axis — `2/scatter`, below which the
  scatter cloud averages structure away, and `1/spacing`, where its comb
  sits.
* **both tips**, deconvolved and not, whenever the train is one we correct
  for.

The last of those is worth looking at once, because it makes a claim from
§3 concrete: at the deep train's scatter 0.7, `H` is already 0.98 by
k = 3 and 1.00 by k = 10, so `1/H` is doing *nothing* to a texture band
that starts at k = 10. The deconvolution earns its place on tight-train
brushes with coarse content; on a wide-scatter ring it is a formality, and
the two tips are indistinguishable.

## 6. The next group

Eight candidates were swept, measured and left out of the twelve — not
because they failed but because the twelve already covered their territory
or beat them on contrast. They are the obvious second set, and each is one
`tips/<name>.spec.json` away. Spectra are given in the same shorthand the
promoted specs use: `ring(k, w)` is a narrow band at `k` c/dia with
`lowSlope: w`; `outer(β, sh)` is a power law with its shoulder at `sh`.

| candidate | spectrum | train | texture % | why it is worth having |
| --- | --- | --- | --- | --- |
| **swell** | `ring(4, 4)` + wedge 30° | deep | 7.7 | crossing wave trains — the only coarse directional entry; sand and corduroy are both fine-scale |
| **brushed** | `outer(2.6, 3)` wedge 20° + `ring(30, 4)` wedge 25° at 90°, w 0.5 | deep | 9.5 | two directions at two scales: a drag over a drag, which is what a brushed panel actually is |
| **width dial** | `ring(12, 6)` + wedge 5 / 12 / 30 / 55° | deep | 10.4–10.5 | a **family axis orthogonal to depth**: corrugation → ripple → broken crest → mild bias. The only candidate here that is a *dimension* rather than a texture |
| **vapour** | `outer(4.0, 0.9)`, cut 20 | deep | 1.3 | haze and soft airbrushing; an effect rather than a material, and the only entry with no fine detail at all |
| **frost** | `outer(3.2, 1.5)` cut 6 + `outer(1.0, 24)` from 16, w 0.8 | deep | 7.2 | a notch: fine spray sitting *on* a coarse surface, which the eye reads as two materials rather than one continuum |
| **cut-8** | `outer(2.4, 2.5)`, cut 8 | deep | 4.5 | distinctive by *absence* — a soft-focus wash with no grain, which nothing in the twelve provides |
| **ladder** | `ring(2, 5)` + `ring(7, 5)` w 0.8 + `ring(24, 5)` w 0.6 | deep | 6.6 | discrete rungs instead of a continuum; reads more "natural" than a smooth slope for reasons §1 calls lacunarity |
| **cascade σ=0.45** | `outer(2.6, 2.5)`, lognormal | deep | — | the retuned intermittent cloud; the lognormal mapping applied to a plain power law rather than to a ring |

Three of these are more interesting as *dimensions* than as single brushes,
and that is the note to carry forward. The width dial is one; so is
`warp.amp` swept 0 → 0.09 on a fixed spectrum, which runs straight ripple →
flow → whorl and **crosses the phase boundary partway along** (§4), so the
train would have to change mid-family — the first family here whose levels
would not share a train. So is `cut` at 8 / 20 / 60, which grades a material
from soft-focus to granular without touching its depth.

## 7. Open directions

* **Runs and drips, deeper.** The wedge × cascade idea reads at depth 0.55
  but wants 0.8; and a wedge whose cascade is anisotropic too (long in the
  run direction) would give the tapering streak a real drip has.
* **Rotating the wedge axis across the field**, rather than warping after
  synthesis. Warping bends crests already laid down; a rotating axis would
  keep them locally straight while the *direction* drifts — closer to
  bedding, brushed curves, and hair.
* **A fibre family on the PRIMARY train.** A primary tip rotates, so
  `angleControl: direction` makes a directional texture follow the hand
  rather than stay pinned to the canvas — the one thing the dual gate cannot
  do, and the standing caveat on every wedge in this atlas (§2). Tested on
  corduroy and it works well at spacing ≈ 0.3; the cost is that union
  averages in the paint, so texture contrast and stroke density stop being
  separate dials (whitepaper §5.4). It needs tips re-solved for `n̄ ≈ 1`, so
  it is a second family rather than a setting on this one.
* **Two-material spectra.** Every entry here is one material. A spectrum
  whose two components have different *tonal* treatments — one rank, one
  lognormal — has not been tried and is the obvious way to get corrosion
  sitting on a surface rather than replacing it.
