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

## 0. Shortlist for promotion

**The directional group is the strongest thing in this atlas and is where to
start when these become brushes.** It was not on the map at all until
`sectorDeg` existed, it produced the highest delivered contrast of anything
measured, and it covers material ground the shipped collection cannot reach —
ripple, weave, drapery, flow, grain. Reviewed and wanted:

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

Two decisions are already made for whoever promotes these. The warped three
ship on the **shallow rigid train**, not the deep one (§4). And the crest
axis is a design choice per brush, not a default (§2).

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

## 6. Open directions

* **A family graded by inner scale.** `cut` at 8 / 20 / 60 c/dia is a real
  progression — soft-focus to granular — and is orthogonal to the depth dial
  every family currently uses. So is the wedge-width dial (§3, group M).
* **Warp strength as a dial.** `warp.amp` from 0 to 0.09 runs straight
  ripple → flow → whorl on one spectrum. Untested as a graded family, and it
  crosses the phase boundary partway along, which makes the train choice
  interesting rather than obvious.
* **Runs and drips, deeper.** The wedge × cascade idea reads at depth 0.55
  but wants 0.8; and a wedge whose cascade is anisotropic too (long in the
  run direction) would give the tapering streak a real drip has.
* **Rotating the wedge axis across the field**, rather than warping after
  synthesis. Warping bends crests already laid down; a rotating axis would
  keep them locally straight while the *direction* drifts — closer to
  bedding, brushed curves, and hair.
* **Two-material spectra.** Every entry here is one material. A spectrum
  whose two components have different *tonal* treatments — one rank, one
  lognormal — has not been tried and is the obvious way to get corrosion
  sitting on a surface rather than replacing it.
