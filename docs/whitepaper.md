# Designing brush textures in the frequency domain

*A method for building material-texture brushes for a Photoshop-parity
engine, in which the designed object is a 2-D power spectrum rather than a
picture. Written for a reader comfortable with Fourier transforms, linear
systems and point processes.*

---

## 1. The problem

A brush that imitates a *tool* can be specified geometrically: a shape, a
profile, a spacing. A brush that imitates a *material* — sponge, rust,
rippled sand, cloth — cannot, because what makes such a mark convincing is
statistical. It has a characteristic distribution of detail across scales,
it never visibly repeats, and its boundaries are ragged at every scale.
Those are statements about a spectrum, not about a shape.

This suggests an obvious program: specify the *power spectrum* of the mark,
synthesize a tip that realizes it, and let random phase supply the
particulars. The program works, but only after three obstacles are dealt
with, and each turns out to be interesting:

1. **The engine is between you and your spectrum.** A stroke is not the tip;
   it is the tip convolved with a randomized point process. That process
   both filters the texture and adds artifacts of its own.
2. **Accumulation is nonlinear, and its nonlinearity is not neutral.** How
   dabs combine decides which statistics survive to the canvas. One
   distribution is a fixed point of it; the rest are not.
3. **Spectra cannot express everything.** A stationary Gaussian field has no
   large-scale organisation by construction. Adding some costs you the
   machinery that made the spectrum reliable in the first place.

What follows is the model, the results that came out of it, and twelve
brushes built from them.

---

## 2. The stroke is exactly a convolution — in the right domain

Within a stroke the engine composites each dab with `over` into a stroke
buffer. After dabs at positions `xᵢ`,

```
1 − A(x) = Πᵢ (1 − F·t(x − xᵢ))        F = flow, t = tip bitmap ∈ [0,1]
```

Products are awkward. Move to **optical depth** `D = −ln(1 − A)`:

```
D(x) = Σᵢ τ(x − xᵢ),     τ(x) = −ln(1 − F·t(x))
```

This is exact, not a small-`F` linearization. In the optical-depth domain a
stroke is precisely `D = τ ⊛ P`, where `P(x) = Σᵢ δ(x − xᵢ)` is the dab
point process, so

```
D̂(f) = τ̂(f) · P̂(f)
```

Every spectral question about a stroke factors into a question about the
kernel we design and one about the process the settings determine. Two
caveats matter in practice. `τ` diverges at `F = 1`, so texture brushes run
at `F ≈ 0.9`. And the eye sees `A = 1 − e^(−D)`, a memoryless saturating
nonlinearity: it redistributes energy but cannot manufacture a spectral line
that `D` does not have. Suppress repetition in `D` and it stays suppressed.

## 3. The point process: one comb and one floor

The engine walks the path in steps of `Δ` and at each step emits `N` dabs,
each displaced by an independent scatter draw `r`. With
`φ(f) = E[e^(−2πi f·r)]`,

```
E|P̂(f)|² = M·N·(1 − |φ(f)|²)  +  N²·|φ(f)|²·|Σₘ e^(−2πi f_x mΔ)|²
            └── diffuse floor ──┘   └────────── the comb ──────────┘
```

The second term is a Dirichlet kernel: spectral **lines** at `f_x = k/Δ`.
That is the wallpaper artifact. The first is broadband shot noise — the
useful texture carrier. The whole of train design is making the second term
vanish while shaping the first.

The engine's scatter law (uniform radius × uniform angle) has a closed-form
characteristic function:

```
φ(f) = Λ(2π|f|S),    Λ(u) = (1/u)∫₀ᵘ J₀(v) dv,    S = scatter × diameter/2
```

At the comb fundamental, `u = π·ρ` with `ρ = scatter/spacing`, and
`|Λ| ≈ 1/(πρ)`. Hence the design rule `ρ ≥ 3` (−21 dB), and two footnotes:
scatter must act on both axes, since across-only scatter leaves `φ ≡ 1`
along `f_x` and the comb survives intact; and pushing `ρ` past 3 buys little,
because `Λ` oscillates about its `1/u` envelope rather than falling
monotonically.

Note what `N` does *not* do. Comb and floor scale with `N` identically in
relative terms, so **count does not fix stamping**. Count sets overlap
depth; scatter suppresses repetition. They are not interchangeable.

## 4. The scatter kernel is also a filter

Per unit stroke length the diffuse part of the spectrum is

```
S_D(f) ∝ (N/Δ)·|τ̂(f)|²·H(f),        H(f) = 1 − |φ(f)|²
```

`H` is a soft high-pass: `H ≈ (2π|f|S)²/6` for `|f| ≪ 1/S`. The same
randomization that kills the comb *averages away coarse texture*. To land a
stroke on a target spectrum `S★`, the tip must be pre-deconvolved:

```
|τ̂(f)|² ∝ S★(f)/H(f)
```

`1/H` diverges at `f → 0`, but wavelengths longer than the tip cannot be
represented in the tip at all, which caps the boost naturally. There is no
conflict with comb suppression: the comb fundamental sits at `u = πρ ≥ 9.4`,
where the boost is already ≈ 1. The two regimes are a decade apart.

## 5. Accumulation, and an impossibility result

Textures that must read as a *print* — connected walls, labyrinth voids —
cannot ride the primary train, because union over many overlapping stamps
destroys phase relationships and turns a labyrinth into dust. They ride the
**dual brush** instead: a second stamp train accumulates into a mask buffer,
and the finished mask gates the stroke once, at merge. This preserves the
tip's structure because the mask is applied, not unioned into the paint.

The mask buffer, however, still accumulates. Two encodings are available.

**Coverage cut.** The tip is a binary threshold of the field. The mask is a
union of random sets, and union coverage is `C = 1 − e^(−n̄q)`. Structure
survives; tone is a by-product of area.

**Tonal mask.** The tip carries the tone-mapped field itself, so the stroke
renders the texture as graded alpha. This is what makes "moderate damage
reads as moderate contrast" possible, and it introduces the central problem
of this paper: the accumulated tone depends on **how many stamps landed**.

### 5.1 No blend mode fixes this

The natural hope is a mean-preserving accumulation operator — one where a
dab's contribution leaves the train's average alone, so the count stops
mattering. Photoshop's Dual Brush has a *Mode* list, which looks like the
place to find one. It is not, for two reasons.

First, the mode does not govern accumulation. The mask buffer accumulates
with `over` — `m ← v + m(1−v)` — and that is not a choosable function; the
mode applies the *finished* mask to the stroke, once.

Second, at that single application the mode barely matters. With a solid
stroke interior (`cov = 1`, which is what a gated brush paints), evaluating
the engine's own blend code gives: Multiply, Subtract, Darken and Linear Burn
all reduce to exactly `tone = v`; Height is `1 − 1.5(1 − v)`, the same law
with a gain; and Overlay, Lighten, Screen, Color Dodge, Color Burn and Hard
Mix are *constant* — they cannot darken a saturated stroke at all.

So the painted tone is `f(1 − (1−v)ⁿ)` for a fixed monotone `f`. That is
strictly increasing in `n` for every `v ∈ (0,1)`, and constant in `n` only
for `v ∈ {0,1}`:

> **Count-invariance and tonal grading are mutually exclusive in any mask
> that accumulates.** A binary mask is invariant in value — but then tone
> must come from area, and area unions up by the same law.

The only exactly count-invariant channel the engine offers is one applied
*once per pixel*: the Texture panel with Texture Each Tip off, which
multiplies merged coverage by a canvas-anchored pattern however many dabs
landed. Its price is canvas anchoring — the texture stops travelling with
the stroke.

*(`tools/accumulation-survey.mjs` prints this table from the engine's blend
code, so the claim stays checkable rather than remembered.)*

### 5.2 What a tonal mask actually computes

Write the accumulation in logs. With `v = 1 − (depth·d)^(1/n̄)` per stamp,

```
ln(1 − m) = Σ ln(1 − vᵢ) = ln depth + (1/n̄)·Σ ln dᵢ
⇒  1 − m = depth · GM(d)
```

**The mask computes the geometric mean of the stamps' damage.** Three
consequences follow, and all three showed up as visible defects before they
were understood:

1. **The value curve.** To land the accumulation on a target `1 − depth·d`,
   each stamp must carry `v = 1 − (depth·d)^(1/n̄)`. Without this inverse,
   mid-tones compress toward white and the painted texture is flatter than
   the design.
2. **Contrast falls as `1/√n̄`.** The log-contrast of `n̄` near-independent
   samples shrinks by that factor. It is recoverable — but only by stretching
   `ln d` *about its own mean*, `d ← G·(d/G)^gain` with `G` the geometric
   mean. A naive `d^gain` scales spread and mean together and measurably
   *lightens* the mark instead of sharpening it (agate: 4.8% → 2.9% delivered
   contrast at a naive gain of 2, against 6.5% at a mean-preserving gain of 3).
3. **The tails are dangerous.** A geometric mean is dragged to zero by any
   single near-zero sample, so one stamp landing its field minimum sets
   `m → 1` and punches a full-ink speck through the whole stack. Bounding
   `ln d` from below removes them. Past `n̄ ≈ 6` such a floor is effectively
   mandatory.

### 5.3 The multiplicative cascade is the fixed point

Point (2) says a rank-uniform damage map does not survive averaging in
*shape* — only in rank order. Ask instead which distribution *is* preserved.
If `ln d ~ N(μ, σ²)`, then `ln GM` of `n` samples is `N(μ, σ²/n)`: the
geometric mean of a lognormal is lognormal, with the same median and `σ/√n`.

> A **lognormal damage map is this architecture's exact fixed point.**
> Overlap changes only `σ`, which `gain` restores precisely.

This is a pleasing coincidence with the physics. Lognormal statistics are
the signature of **multiplicative cascades** — the standard multifractal
model for turbulence, cloud edges and rain. A mask that accumulates
multiplicatively wants a multiplicatively-generated texture. `σ` sets
intermittency: the median damage lands at `e^(−2.58σ)`, so the field reads
as mostly-intact material with rare deep bites, a look the rank mapping
cannot reach at all.

### 5.4 Consequences for the train

The count variance is what remains. `n(x)` decorrelates over one stamp
footprint, so its wander arrives as light and dark discs at *exactly stroke
width* — the most conspicuous scale a stroke owns. Measured on one family:

| dual scatter | n̄ | stamp-scale ripple | train line | delivered texture |
| --- | --- | --- | --- | --- |
| 0.7 | 3 | 3.9% | — | 9.0% |
| 0.2 | 3 | 2.1% | 6.6% | 7.3% |
| 0.45 | 6 | 1.7% | 2.2% | 5.7% |
| 0.7 | 12 | 2.1% | 0.9% | 3.9% |

So scatter is bought with overlap, at `1/√n̄` in both directions: the
artifacts fall and the delivered contrast falls with them. Two further
effects belong to the same budget. Field content coarser than a stamp makes
each stamp tint its whole footprint (random mirror flips re-randomize the
sign), which a high-pass above ~1.4 c/dia removes identically. And even a
perfectly rigid train leaves a *deterministic* residue: `n(x)` steps between
`⌊n̄⌋` and `⌈n̄⌉` with period `Δ`, giving a tone line of amplitude
`≈ tone·|ln tone|/n̄`.

## 6. Phase and spectrum: where the method stops

Averaging `n̄` independent windows of a field is benign if the field is
stationary and Gaussian — the average of independent windows of a Gaussian
field is the same field, up to variance that `gain` restores. It is fatal if
the field's identity lives in its *phase*: facet edges, crack networks,
scratch lines, cell walls. Stamps arrive mirror-flipped as well as offset,
so the accumulation is not a convolution; no amplitude filter can undo it,
and gain only produces high-contrast mush.

This gives a sharp classification rule:

> **Spectrum-defined textures** (Gaussian fields) may spend overlap freely
> and take the wild scatter. **Phase-defined textures** want a shallow rigid
> train and get their variety from the tip, the mirror flips and the
> vignette's tearing.

The rule was tested by *moving a texture across it*. A domain warp bends
straight crests into flow lines — the one way to give a stationary field
large-scale organisation, and an injection of phase. The identical warped tip
painted on both trains:

| texture | deep train (scatter 0.7, n̄ 12) | rigid train (scatter 0.2, n̄ 3) |
| --- | --- | --- |
| whorl | 9.1% — eddies blend into uniform hatching | **15.9%** — eddies survive |
| flow | 10.1% | **17.6%** |

Three-quarters more delivered contrast on the rigid train, at equal or
better ripple. Warping does not decorate a spectral texture; it
**reclassifies** it, and the brush must change trains.

## 7. The design surface

For the spectral half, the design surface is a 2-D power spectrum and
nothing else. Its axes:

| axis | what it changes |
| --- | --- |
| slope `β` | roughness (below) |
| outer scale | the largest structure; caps coarse variance |
| inner scale | how fine the material gets before going smooth |
| bandwidth | a narrow band is a **ring**: one scale, random phase |
| orientation | squeeze (`stretchX`) vs delete (`sectorDeg`) — not the same operation |
| composition | sums of bands, including deliberate gaps |
| histogram | rank-uniform vs lognormal cascade (§5.3) |

### 7.1 What "fractal" means here, precisely

A pure power law is the only scale-invariant spectrum: `S(λf) = λ^(−β)S(f)`.
For a 2-D self-affine surface the exponent, the Hurst exponent and the
fractal dimension are one parameter in three costumes:

```
β = 2H + 2        H = (β − 2)/2        D = 3 − H = 4 − β/2
```

Two corollaries do real design work. **`β = 2` is the equal-variance-per-
octave line**: mode count per octave grows as `k²`, so variance per octave
goes as `k^(2−β)`. Above it the coarse scales carry the texture; below, the
fine ones. It tells you which end of the material the eye reads first.

And **a real fractal is band-limited, necessarily**. A tip spans about seven
octaves; a pure law at `β ≥ 3.2` puts nearly all its variance in the first
one and paints a single blob rather than a texture. Capping the variance
below a shoulder makes the same slope usable. The shoulder is not a fudge —
**it is the outer scale**, and the physical fractals being imitated all have
one.

Beyond a single exponent there are two directions: **lacunarity** (gaps in
the ladder — discrete rungs rather than a continuum) and **multifractality**
(§5.3).

### 7.2 Orientation: squeezing is not deleting

`stretchX` squeezes the passband affinely. A ring becomes an ellipse:
elongated *lobes*, with every orientation still present. An **angular
wedge** — a Gaussian window in `arg f` — deletes all but one orientation, and
that is what produces parallel *crests*. The difference is not subtle: the
two highest delivered-contrast textures measured across a 55-spectrum sweep
are both wedges, and the whole ripple / weave / drapery / grain family exists
only on the far side of it.

Two operational notes. The wedge axis is the **wavevector**, so `0°` puts
crests across a horizontal stroke and `90°` along it; against a real mark
those read completely differently. And because dual stamps mirror but never
rotate, an anisotropic mask's axis is **fixed to the canvas** — a material
property for bedding or a brushed panel, a defect for anything meant to
follow the hand.

## 8. Verification

Repetition and texture claims are checkable claims, and on this project the
checks repeatedly overturned impressions. Three of the measures are computed
on a painted stroke in absolute tone rather than relative to a spectral
floor, because a near-flat tonal mark has almost no floor and floor-relative
statistics explode over structure no viewer can see — a 20× spectral spike
that measures 0.4% of tone, below one 8-bit gray step.

| measure | what it catches | bar |
| --- | --- | --- |
| `ripple %` | std/mean of the core tone smoothed at the stamp diameter | ≲ 3% |
| `comb p-p %` | strongest periodic line over 2–24 c/dia, in excess of its spectral neighbourhood | ≲ 5% |
| `texture %` | band-limited RMS over 5–30 c/dia on tiled 2-D windows | compare within a family |
| `spike ×`, `comb ×`, `aniso dB` | periodicity and anisotropy of a filled patch | for coverage cuts |

Two traps worth recording. A tonal *patch* bands along its own fill rows,
because overlapping rows multiply on a graded mask — judge tonal textures on
the stroke, never the fill. And a measure computed along the stroke is blind
to structure running along the stroke: an early `texture %` did per-row FFTs
and reported a 45% contrast loss when a wedge was turned 90° and nothing had
changed but the angle.

## 9. Twelve brushes

Each is one spectrum. `deep` is scatter 0.7 at `n̄ ≈ 12`; `rigid` is
scatter 0.2 at `n̄ ≈ 3`, chosen by §6 rather than by preference.

| brush | spectrum | train | texture % | what it paints |
| --- | --- | --- | --- | --- |
| flow | ring k=10 + wedge 18° + warp | rigid | 17.1 | water surface, current |
| whorl | ring k=16 + wedge 12° + warp | rigid | 14.1 | fingerprint eddies, burl |
| drape | β=3.0 + wedge 22° + warp | rigid | 10.2 | hanging cloth |
| reticule | ring k=16 | deep | 10.0 | pumice, even pitting |
| labyrinth | ring k=8 | deep | 9.9 | brain coral, dense foam |
| sand | ring k=10 + wedge 18° | deep | 9.5 | rippled sand |
| woodgrain | β=2.6 + wedge 14° (along) + warp | rigid | 9.5 | grain round a knot |
| corduroy | ring k=16 + wedge 12° (along) | deep | 8.6 | combed clay, drawn fibre |
| herringbone | two wedges at ±40° | deep | 7.4 | crosshatch, woven mesh |
| tooth | near-white 12–70 c/dia | deep | 7.2 | paper tooth, spray |
| vesicle | ring k=16 + lognormal σ=0.5 | deep | 5.9 | vesicular basalt |
| strata | coarse ×9 + thin grain | deep | 5.6 | bedded sediment |

Three are worth reading as arguments rather than entries:

**labyrinth** is a narrow ring and nothing else — one spatial scale, random
phase. It has a characteristic frequency and *no periodicity*, and the audit
finds neither spike nor comb. A scale is not a pattern; conflating the two
costs you an entire region of the design space.

**vesicle** is the same ring carried by a lognormal damage map instead of a
rank-uniform one, and it is the only entry whose *histogram* rather than
spectrum distinguishes it — mostly-intact material with scattered beads,
reachable only through §5.3.

**drape** earned its place by being fixed rather than by measuring well. As
an unwarped wedge it delivered 4.7%; a light warp plus the resulting move to
the rigid train took it to 10.2%. The theory predicted the direction and the
size of the gain before the brush was painted.

Two families needed their rigid train tightened past the default (woodgrain
to spacing 0.14, drape to 0.18): a scale-free wedge carries coarse power
exactly where §5.4's count staircase sits, and the residual line was audible
at 7–9% of tone until the overlap was deepened.

## 10. Open problems

* **Cancelling the staircase exactly.** §5.4's residue is deterministic, so
  an envelope whose translates sum to a constant (a COLA condition on the
  vignette, hop = half the envelope width) would remove it identically
  rather than dividing it by `n̄`. Untried.
* **Families whose levels change train.** Sweeping warp strength runs
  straight ripple → flow → whorl and crosses the phase boundary partway
  along, so the levels would not share a train. No family does this yet.
* **Rotating the wedge axis across the field**, rather than warping after
  synthesis. Warping bends crests already laid down; a drifting axis keeps
  them locally straight while the direction changes — closer to bedding,
  hair, and brushed curves.
* **Two-material spectra**, where two components get different *tonal*
  treatments — one rank, one lognormal. The obvious route to corrosion
  sitting *on* a surface rather than replacing it.
* **Engine constraints worth lifting.** Dual stamps mirror but never rotate,
  which is what pins anisotropy to the canvas and makes sparse iconic motifs
  recur along a stroke. Dual rotation would relax both at once.

---

*Companion documents: `docs/fractal-texture-math.md` (the derivations and
the acceptance procedure in full), `docs/spectral-atlas.md` (the swept map
of the spectrum space and the catalogue), `docs/parameters.md` (the engine's
knobs and the ratios between them).*
