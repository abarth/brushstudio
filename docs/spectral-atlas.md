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

The tiles referenced throughout are `out/spectral-atlas.png`, regenerable
with the procedure at the end.

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
| anisotropy | `stretchX`, `stretchY`, per component | direction; per-band, so it can change with scale |
| composition | `components[]` | sums of bands, including deliberate gaps |
| histogram | `tonal.mode`, `sigma`, `gain` | rank-uniform vs lognormal cascade (§1) |

Two notes on anisotropy. `stretchX` is an affine squeeze of the passband, so
it turns blobs into ellipses; it does **not** select a direction of travel,
and a ring stretched on one axis gives elongated lobes rather than parallel
wave crests. Crests need an angular wedge, which is not implemented. And
because dual stamps mirror but never rotate, an anisotropic mask's axis is
**fixed to the canvas**: the fibre runs the same way whichever way the stroke
goes, so a curved stroke crosses its own grain. That is either a material
property (a brushed panel) or a defect, depending on the material.

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
| **stretchX 15** | strong single-axis squeeze | combed, dragged, brushed panel | conditional — canvas-fixed axis (§2) |
| **crossed rings** | rings on both axes | weave, basket, plaid | conditional — legible but reads regular |
| **cascade σ=1.2** | lognormal damage | intermittent, rare deep bites | needs work — too sparse at depth 0.55; wants higher depth or lower σ |
| **strata** | coarse ×9 under iso grain | bedded stone | needs work — the coarse band is buried under its own grain |
| **1–2 octave gaps** | lacunar | grain over cloud | weak — the fine band dominates; the gap does not read |
| **silt, crepe** | broad β=1.4; mid-band bump | even mottle; crumple | weak — close to cloud and agate |

## 4. Procedure

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

## 5. Open directions

* **Angular wedges.** Power inside ±θ of an axis, rather than an affine
  squeeze — the only way to get parallel wave crests (rippled sand, water,
  drapery) instead of elongated lobes.
* **Rings with a shoulder.** A ring on top of a power-law floor: cellular
  structure embedded in scale-free roughness, rather than either alone.
* **Cascade × ring.** Lognormal damage on a ring spectrum — intermittent
  cellular decay. The two most distinctive axes have not been crossed.
* **Spectra that change along the stroke.** Nothing in the engine varies the
  mask with pressure, but two brushes at different `cut` values are a pair a
  painter can switch between; a coverage-style family graded by inner scale
  rather than by depth is unexplored.
