# Fractal-texture brushes: the signal processing

Some brushes imitate a tool; a texture brush imitates a *material* — sponge,
rust, lichen, spatter. What makes a material mark convincing is statistical:
it has a characteristic spectrum, it never repeats, and its edges are ragged
at every scale. All three are frequency-domain properties, so this page works
out the frequency-domain model of a stroke in this engine, exactly, and turns
it into design rules for building a texture family. `docs/parameters.md`
states the ρ = scatter/spacing rule; this page is where that rule and its
siblings come from.

The worked example throughout is a sponge-print family graded by coverage
(10%…90% of pixels inked), but nothing in §1–§7 is sponge-specific.

## 1. The exact linear domain

Within one stroke the engine composites every dab with `over` into the stroke
buffer (`src/engine/cpu/engine.ts`, `stamp`): after dabs at positions `x_i`,

```
1 − A(x) = Π_i (1 − F·t(x − x_i))          F = flow, t = tip bitmap in [0,1]
```

Products are miserable to analyse, so move to **optical depth**:

```
D(x) = −ln(1 − A(x)) = Σ_i τ(x − x_i)      τ(x) = −ln(1 − F·t(x))
```

The sum is exact, not a small-`F` approximation. A stroke, in the optical
depth domain, is **precisely a convolution**: `D = τ ⊛ P` where
`P(x) = Σ_i δ(x − x_i)` is the dab point process, so

```
D̂(f) = τ̂(f) · P̂(f)
```

Every spectral question about a stroke factors into a question about the dab
kernel `τ` (which we design, §6) and one about the point process `P` (which
the spacing/scatter/count settings determine, §2). Two caveats that matter:

* `τ` is only finite if `F < 1`. At `flow: 1` a binary tip saturates in one
  dab and the log blows up; run texture brushes at `F ≈ 0.9–0.97` so the
  analysis (and Photoshop's own accumulation) stays in range.
* The eye sees `A = 1 − e^(−D)`, a memoryless saturating nonlinearity. It
  redistributes spectral energy smoothly — broadband in, broadband out — and
  cannot manufacture a spectral line that `D` does not have. So suppress
  repetition in `D` and it stays suppressed in the visible mark. (What the
  nonlinearity *does* do is restore contrast that overlap averaging took
  away — §4.)

## 2. The dab train's spectrum

The engine walks the path in steps of `Δ = spacing × diameter × aspect` px
and at each of `M` steps emits `N = count` dabs, each displaced by an
independent scatter draw `r`. Let `φ(f) = E[e^(−2πi f·r)]` be the offset
distribution's characteristic function. Then

```
E|P̂(f)|² = M·N·(1 − |φ(f)|²)  +  N²·|φ(f)|²·|Σ_m e^(−2πi f_x mΔ)|²
            └── diffuse floor ──┘   └────────── the comb ──────────┘
```

The second term is a Dirichlet kernel: spectral lines at `f_x = k/Δ` of
height `M`, i.e. power `M²N²|φ(k/Δ)|²`. This is the wallpaper artifact —
"the same mark every Δ pixels" — and `measure`'s `repetition.prominence` is
essentially the ratio of this term to the first one. The first term is
broadband shot noise: the *useful* texture carrier. Everything below is about
making the second term vanish and shaping the first.

**The engine's scatter law.** `scatterOffset` (`src/brush/dynamics.ts`) draws
a distance uniform in `[−S, S]` with `S = scatter × diameter/2`, and (with
Both Axes) an independent uniform angle. That distribution's characteristic
function is radial and closed-form:

```
φ(f) = Λ(2π|f|·S)        Λ(u) = (1/u)·∫₀ᵘ J₀(v) dv
Λ(u) ≈ 1 − u²/12                    (u ≲ 2)
Λ(u) ≈ [1 − √(2/πu)·sin(u − π/4)]/u  (u ≳ 3; envelope 1/u)
```

At the comb's fundamental `f = 1/Δ`, `u = 2πS/Δ = π·ρ/aspect` with
`ρ = scatter/spacing`:

| ρ | \|φ(1/Δ)\| | comb power vs. unscattered |
| --- | --- | --- |
| 1 | 0.43 | −7 dB |
| 2 | 0.20 | −14 dB |
| 3 | 0.087 | −21 dB |
| 4 | 0.092 | −21 dB (Λ oscillates — more ρ is not monotonically better) |
| 5 | 0.055 | −25 dB |

That is the derivation of the `ρ ≥ 3` rule, and of two footnotes to it:
Both Axes is not optional (across-only scatter has `φ ≡ 1` along `f_x`, so
the comb survives untouched), and pushing ρ from 3 to 4 buys nothing — the
attenuation wiggles around the `1/(πρ)` envelope.

**What count does and does not do.** Both comb and floor scale with `N` the
same way in relative terms, so count does **not** fix stamping. What it sets
is the dab density — the overlap number that drives coverage (§4) and the
`1/√n` smoothness of the texture. Count is the *interaction* dial, scatter is
the *anti-repetition* dial, and they are not interchangeable.

## 3. The scatter kernel as a filter, and the deconvolution rule

Per unit stroke length the diffuse part of the stroke spectrum is

```
S_D(f) ∝ (N/Δ) · |τ̂(f)|² · H(f)         H(f) = 1 − |φ(f)|²
```

`H` is the **scatter transfer function**: the same kernel whose smearing
kills the comb also *filters the texture the dabs deliver*. It is a soft
high-pass: `H ≈ (2π|f|S)²/6` for `|f| ≪ 1/S` — coarse structure is averaged
away by the scatter cloud — rising to ≈ 1 once `2π|f|S ≳ 3`.

If the target is a stroke whose texture has a prescribed spectrum `S★(f)`
(for a natural material: a scale-free power law, §5), the dab kernel must be
**pre-deconvolved** by the scatter kernel:

```
|τ̂(f)|² ∝ S★(f) / H(f)        over the representable band |f| ∈ [1/d, ½]
```

so that after convolution with the train, `|τ̂|²·H` lands back on `S★`. Below
`1/d` (wavelengths longer than the tip) nothing can be represented in the tip
at all, which conveniently caps the `1/H → ∞` blow-up at `f → 0`.

**When the correction is large and when it is cosmetic.** The boost at the
bottom of the band, `f = 1/d`, is `1/H(2πS/d) = 1/H(π·scatter)`:

| scatter | boost at 1 cycle/diameter |
| --- | --- |
| 0.25 | ×5.6 |
| 0.5 | ×2.1 |
| 1.0 | ×1.13 |
| 1.5 | ×1.08 |

A tight-train brush (small scatter, small spacing to keep ρ ≥ 3) *needs* the
deconvolution or its coarse texture washes out; at `scatter ≥ 1` the exact
correction is a few percent plus flattening of Λ's in-band ripples — apply it
anyway (it is one multiply in the synthesis filter), but expect it to matter
at small scatter. There is no conflict between boosting low `f` and
suppressing the comb: the comb fundamental sits at `u = πρ ≥ 9.4` where the
boost is already ≈ 1. The two regimes are a decade apart.

**The mean profile deconvolves the same way.** The first moment is
`E[D](y) = (N/Δ)·(τ_proj ⊛ p_⊥)(y)`: the tip's transverse projection blurred
by the scatter marginal. That blur is what turns a torn tip edge into an
airbrush gradient when scatter is large — the quantitative form of "scatter
softens edges", and one of two reasons the sponge family keeps its scatter
well under 1.

**Load clumping — the third artifact.** The same diffuse term, evaluated on
the *dab envelope* rather than the texture, predicts an artifact the comb
math misses: the stroke's ink drifts at 1–3 diameter wavelengths, reading as
lobes or beads. The envelope spectrum lives at `k ≲ 1.5` cycles/diameter,
where the relative ripple goes as `√(H(f)/n̄)` — and `H` there is governed by
the *absolute* scatter radius: `S ≪` beat wavelength → `H → 0` (a regular
train has no energy between comb lines; the clumping *is* scatter
randomness), while `S` comparable to the wavelength passes it (`H → 1`).
Measured on this engine at `k ≈ 0.8` (the 1.3-diameter beat): scatter 0.45
→ `H = 0.18`, no visible beading; scatter 0.9 → `H = 0.59` and scatter 1.5
→ `H = 0.89`, both visibly lobed at low `n̄`. So the three artifacts pull
scatter in different directions: the **comb** fixes the ratio `ρ =
scatter/spacing ≥ 3`, **clumping** wants scatter small in absolute terms,
and **washout** (next section) wants `n̄` modest — which together push spacing
*down* rather than scatter up.

## 4. Coverage: the union of dabs

For a print-like brush (near-binary tip, `F` near 1) a pixel is inked iff at
least one dab's ink lands on it. Dab centres arrive at rate `N/Δ` per px of
travel; a pixel on the spine is reachable by any dab whose footprint covers
it, and the expected number that actually ink it is

```
μ = (N/Δ) · q · c̄
```

where `q` is the tip's ink fraction and `c̄` the mean ink chord of the tip
along the stroke (≈ 0.8·d for a round-vignetted tip). Offsets between
overlapping dabs are ~tip-sized, far beyond the texture's fine correlation
length, so hits are nearly independent and coverage follows the Poisson union
law:

```
C = 1 − e^(−μ)      ⟹      q(C) = Δ·(−ln(1 − C)) / (N·c̄)
```

This is the equation a coverage-graded family is built on: the train
(`Δ, N, scatter`) stays **identical** across the family — one scatter kernel,
one deconvolution, one feel — and only the tip's ink fraction `q` steps
through the levels. Two of its consequences are worth internalising:

* `q` is *much* smaller than `C` at the low end (with `n̄ = N·c̄/Δ ≈ 5`
  effective overlaps, 10% coverage wants a tip that is ~2% ink), and
  saturates slowly at the top (90% wants ~37%). The overlap number `n̄` is
  the exchange rate, so it must be chosen before the tips are synthesized.
* The union of `n̄` independent placements *shreds* structure: a hole
  survives only where every overlapping dab left a hole. Fine holes fill;
  only structure coarse relative to the inter-dab offsets survives to the
  canvas. Spectrally this is the flat `1/√n̄` contrast suppression of the
  diffuse floor — flat, so it cannot be fixed by spectral shaping; it is
  fixed by keeping `n̄` modest (3–8), running the tip binary (maximal
  variance per dab), and letting the `1 − e^(−D)` saturation plus the
  coverage threshold re-binarize what overlap averaged. A brush whose
  texture must survive union at `n̄` overlaps needs its holes designed
  coarser than the target print's by roughly `√n̄` — the spatial twin of the
  §3 low-frequency boost.

The Poisson formula seeds the design; it does not end it. `c̄` depends on the
vignette, the chord distribution, the scatter fringe dilutes measured
coverage, and at `q ≈ 0.4` the independence approximation strains. The
harness closes the loop: paint, measure, one or two secant steps on `q` per
level. Calibrate against the measurement, not the formula.

**Coverage needs a region, and the box is the wrong one.** A torn-edged
mark can never fill its own ink bounding box: the ragged rim zone is inside
the box and bare *by design*, which caps box coverage well short of 1 (the
family's first calibration hit that ceiling at 0.57 and could not reach its
80% and 90% labels at all). The number a coverage grade should mean is
**core-band coverage**: the inked fraction inside the FWHM band of the mean
transverse profile — interior fill, with the fractal edge zone excluded.
`tools/fractal-tip.mjs` calibrates to core and reports both; expect
`measure`'s box figure to read below the label by the edge zone's share.

**The union destroys phase, and second-order design cannot save it.** All
of the spectral machinery above controls second-order statistics. The *look*
of a material print — connected pore walls, thin membranes, a labyrinth — is
phase information, and a union of many independently placed dabs converges
toward a filtered shot noise that keeps the spectrum and loses the phase: at
`n̄ ≳ 4` a sponge print unions into an even granular dust with the right
radial spectrum and the wrong character. Overlap is only safe *below* the
scale of what must survive; prints need `n̄ ≈ 1–3` where they must stay
prints. The way out of the resulting triangle (print-through wants `n̄`
small, breaks and clumping want `n̄` large) is not a better tip — it is the
dual-brush architecture in §9, which is why the sponge family ships on it.

## 5. The target spectrum, and what "fractal" buys

A natural texture has no characteristic scale between its grain and its
extent: radially averaged, `S★(f) ∝ |f|^(−β)` with a knee at the pore/grain
frequency. For sponge prints β ≈ 2.2–2.6 over the fractal range, rolling off
steeper past the pore scale (~10–14 cycles per tip diameter). The exponent is
the *look*: β → 2 is crinkly and aerated, β → 3 is blobby and heavy.

Scale-freedom is not just fidelity to the material — it is what makes the
rest of the design work:

* **Size jitter is free decorrelation.** Rescaling a power-law texture is
  statistically a fresh sample of the same texture, so `sizeJitter` (and
  pressure-driven size) decorrelates overlapping dabs without changing the
  material. On a tip with a characteristic scale, the same jitter visibly
  changes the grain size.
* **Angle jitter closes the loophole the comb math leaves.** §2 treats dabs
  as identical translates; identical bitmaps also leave *autocorrelation
  ghosts* — the stroke correlates with itself at typical inter-dab offsets
  even when no periodic line exists. A full-turn `angleJitter` (plus flip
  jitters) makes each dab a rotated/mirrored sample, smearing the ghost
  azimuthally. An isotropic fractal tip is invariant in distribution under
  both, so the decorrelation again costs nothing visually. (The engine
  auto-mirrors *dual* stamps for exactly this reason — primary tips must opt
  in via Shape Dynamics.)
* **Thresholding preserves the family.** Level cuts of a scale-free field
  are scale-free sets, so one underlying field thresholded at nine depths
  gives nine coherent family members — the same sponge pressed harder — with
  nested ink sets and a common spectral signature.

## 6. Synthesis: building the tip in the frequency domain

The generators in `src/brush/organicTips.ts` build broadband tips from
rotated value-noise octaves — good, but only octave-quantized control over
the spectrum and none over coverage. For a graded family, synthesize the tip
directly in the frequency domain:

1. **Shape the amplitude.** On an FFT grid, set
   `|ĝ(f)| = √(S★(|f|) / H(|f|))` — target times deconvolution (§3), with
   `S★` the power law + knee and `H` evaluated with the family's actual `S`
   in tip-bitmap units. Zero the DC bin. `S★` needs **both ends closed**:
   a shoulder at the cluster frequency (flat below it — a pure power law
   pours the whole variance budget into the two or three coarsest modes and
   the tip comes out as one blob), and a *rolldown* below the shoulder
   (power ∝ `k^{+1.5}` toward DC), because sub-cluster wavelengths survive
   the train nearly untouched (§3's `H ≈ 1` there) and plateau power at
   `k ≈ 1–2` beads the stroke into clouds.
2. **Randomize phases** (one fixed seed); inverse FFT → a Gaussian field
   `g`. FFT synthesis has no lattice to break (the value-noise grid artifact
   never exists) and its periodicity is harmless in a *tip*: the bitmap
   stamps as a whole, it never tiles, and the vignette zeroes both edges of
   any wrap seam.
3. **Threshold** at the quantile that yields this level's `q` (§4), with a
   ~1px smoothstep so blob rims stay antialiased, and a light sub-pixel blur.
4. **Vignette** with a torn-edge radial falloff (same construction and
   rationale as `raggedVignette`: ink must reach true zero before the bitmap
   frame, or the frame stamps rectangles into the mark; the tear must ride
   the *same* coarse field as the texture so the rim breaks into the
   texture's own blobs rather than a clean circle).
5. **Audit the stroke, not the tip.** Thresholding is a nonlinearity: it
   whitens sparse levels and puts an edge-generated `k⁻³`-ish tail on every
   level — and a binary print *needs* that tail, so "correcting" the
   thresholded tip back toward the smooth Gaussian target deletes the pore
   band (tried; rejected — the hook survives in the tool behind
   `spectralCorrection`, default off). The pre-threshold spectrum is the
   design surface; acceptance is measured on rendered marks (§7).

**Non-Gaussian fields plug into the same machinery.** Steps 3–4 and the
calibration never ask where the field came from — any scalar field with the
right *ordering* works, and the fracture/foam/vein materials need one
(§4's phase argument). Three generators ship in `tools/fractal-tip.mjs`,
each keyed by `field.kind`:

* `cellular` (erosion): per-cell random values over stacked Worley scales —
  thresholds drop whole cells, giving angular fragments — plus a wall dip
  that keeps hairline cracks sub-threshold at high coverage.
* `pores` (foam): bubble *growth time*, `min over bubbles of (f1/r − 1)`.
  Thresholding is uniform bubble growth, so low-coverage lace thins
  everywhere and stays connected. (Absolute wall distance fails: its high
  quantiles retreat to junction pockets — dots, not a network.)
* `veins` (marble): ridges `exp(−(g/w)²)` on the zero contours of
  band-passed Gaussian octaves, each modulated by a slow field so veins wax
  and wane (an unmodulated ridge is a plateau, and sparse cuts shatter it
  into chips), all domain-warped for flow. Fat widths turn the same
  generator into smoke/agate washes.
* `faults` (slate, shards, geological patchwork): the planar faulting
  method — a sum of random half-plane steps. At low counts the fault lines
  survive as straight facet edges and level sets are polygonal; at high
  counts it converges toward a smooth fractal field.
* `scratches` (worn metal): a point process of finite, gently bent line
  segments, isotropic in orientation, lengths/widths/depths heavy-tailed —
  a wear history rather than a manufactured brushing (which is just
  `stretchX`). Sparse thresholds keep only the deepest gouges.
* `domains` (plank wood, parquet, end grain): coarse Worley domains, each
  filled with elongated angular sub-cells (stretched Worley) aligned to
  that domain's own random orientation. Per-domain stretch is the point — a
  single global stretch cannot vary orientation across the surface.
* `banded` (wood rings, onyx, damascus): the Perlin-marble construction
  `cos(carrier + turbulence)` — a striped or ringed carrier phase-modulated
  by a field with this spec's spectrum. The carrier alone is a spectral
  LINE at the band frequency; modulation depth `warp` (rms, in cycles)
  FM-spreads it — by `warp ≈ 0.5` the line is a broadband ridge, and past
  `≈ 1.5` even the banding's *look* dissolves into swirl. The audit is the
  arbiter, as ever: this is the one generator that starts from a comb and
  earns its way out.

Two cross-cutting knobs: `spectrum.stretchX` squeezes the passband in fx,
elongating structure along x for brushed metal, drag marks and striated
stone (the §7 isotropy check is then *expected* to flag the axis — by
design); and a cellular scale's `f1Weight` adds a per-cell dome — hammered
metal, orange peel, pebbled leather grain.

What is scale-structured stays a spectrum decision; what is
phase-structured becomes a generator decision; coverage, nesting,
calibration and the audit are indifferent. One warning for sparse
phase-structured masks: dual stamps mirror but cannot rotate, so a mask
with few, distinctive features repeats them visibly along the stroke — the
marble family had to densify its vein field until no single shape was
memorable. If a future engine change adds dual rotation, that constraint
relaxes.

**Tonal masks, and what is actually deconvolved.** A threshold cut throws
the field's tonal information away and renders at maximal contrast; a
TONAL mask (`maskMode: "tonal"`) ships the tone-mapped field itself, so
the gated stroke carries the texture as graded alpha and a window cut from
a stroke matches the designed height field — damage as a *delta* from the
intact material, with `depth` the contrast dial. Getting that match takes
two separate deconvolutions, and it is worth being precise about which
kernel each one undoes:

* **Second moment (spectrum):** the `1/H` division of §3 undoes the
  scatter kernel's variance filtering. It applies fully to spectral
  fields, but for the structural generators it only shapes their *fbm
  component* — Worley cells, scratch strokes, fault steps and vein ridges
  are laid in the spatial domain and are not spectrally pre-compensated.
* **First moment (value curve):** the mask buffer over-composites, so
  `n̄ ≈ c̄/Δ_dual` overlapping stamps accumulate `m = 1 − Π(1 − v)`. To
  land the accumulated mask on a target `1 − depth·damage(x)`, each stamp
  must carry `v = 1 − (depth·damage)^(1/n̄)` — without this inverse, mid
  tones compress toward white and the painted texture is flatter than the
  design.

Two approximations remain, both benign at the shipped trains and checked
by the stroke-window comparison rather than assumed: overlapping stamps
sample the SAME bitmap at small offsets, so the union is correlated (the
value inverse treats it as exact re-stamping, which it nearly is at
`S ≈ 0.35·d_dual`); and the scatter offsets smear the tonal field by the
scatter marginal — visible as a soft burnish mottle, not as lost
structure. A tonal `delta` mapping can be inverted (`invert: true`) so
the structure keeps full paint and the ground carves: scratches as darker
gouges in a mid-tone material rather than pale lines in a solid one.

Then calibrate `q` per level against painted strokes (§4). The result ships as a
plain grayscale PNG under `tips` in the brush document — the engine treats it
exactly like an `.abr`-sampled tip, and export embeds it.

## 7. Verification: what to check, by number

Repetition and texture claims are checkable claims. The 2-D audit is
`tools/spectrum-audit.mjs`: it paints a long stroke and a filled patch
(rows at randomized phase, so the fill cannot inject a lattice of its own),
FFTs the patch's central square, and reports each row below — plus 1:1
crops and a log-power image of the spectrum for the eye.

| check | tool | accept |
| --- | --- | --- |
| stamp comb | audit `comb ×` — column-integrated power at each `f_x` vs its neighbourhood (a train's line is vertical in 2-D, §2) | ≲ 3× |
| spikes | audit `spike ×` — per-annulus max vs the expected max of that annulus's broadband draw, fx/fy axis ridges excluded | ≲ 5× |
| isotropy | audit `aniso dB` — sector power spread over the texture band | ≲ 4 dB |
| spectrum | audit `beta` — radial log-log slope over 2–30 c/dia | smooth curve, no bumps; β rises with coverage (sparse prints are legitimately whiter) |
| coverage | calibration `core` (§4) | target ± 0.02 |
| breaks | `measure` → `worstGap` | < 0.5 dia (levels ≥ 30%; below that the gaps *are* the design) |
| ghosts | autocorrelation of the stroke alpha | no secondary peak beyond the texture's own correlation length |

Two readings need interpretation before they are believed:

* `measure`'s `repetition` warning is a *line-vs-median* test on the 1-D
  column-ink spectrum. Broadband low-frequency patchiness — sponge load
  variation — puts a wide bump over a low median and reads as a huge
  "prominence" with no periodicity anywhere. Check the reported period
  against the actual train step `Δ` (and the audit's `comb ×`) before
  treating it as stamping; on the shipped family the flagged "beats" sit at
  1.7–2.6 diameters while `Δ` is 0.05 diameters, and the audit's comb test
  is clean.
* The fx≈0 / fy≈0 axis ridges in the 2-D spectrum are the stroke's and the
  fill's own macro-structure (a row is coherent along its length). They are
  excluded from spike detection and reported separately.

## 8. Design procedure for a coverage family

Collecting §2–§6 into the order the decisions are actually made:

1. **Choose the architecture first.** A texture that must read as a *print*
   (connected walls, labyrinth voids) goes in the **dual slot** gating a
   solid round primary (§4's phase argument, §9's mechanics); a texture
   that reads as *grain* (dust, stipple, chalk tooth) can ride the primary
   tip directly and take the union. Everything below applies to whichever
   train carries the texture.
2. Choose that train's overlap number `n̄ = N·c̄/Δ` — ≈ 2–3 for a print
   (any deeper unions the labyrinth into dust), 3–8 for grain — and spacing
   so tear-zone alignment between neighbouring stamps cannot bare the
   stroke (the family needed stamp overlap ≈ 3 and a wide mask plateau
   before its 80–90% levels stopped breaking).
3. Keep the scatter *radius* small — clumping, §3 — and the ratio honest:
   `ρ = scatter/spacing ≥ 3` where the stamps are identical translates. A
   dual mask gets extra decorrelation the ρ rule doesn't count (automatic
   per-stamp mirroring, plus a big tip's regional variety), so ρ ≈ 2 can
   audit clean there — but the audit, not the rule, is the arbiter. Note
   count multiplies the dab *rate* without touching ρ: at fixed scatter,
   prefer earning rate from spacing (count 1) and spend count only when
   spacing bottoms out.
4. Primary-carried texture: enable full angle jitter + both flips; size
   jitter to taste — all free for an isotropic fractal tip (§5). A dual
   mask mirrors automatically and cannot rotate; the tip's own variety has
   to carry it, which is one more reason mask tips are generated large.
5. Fix flow ≈ 0.9 (§1), opacity 1. For a dual-gate, primary hardness high
   (≈ 0.85): a soft primary skirt reads as an airbrush halo under a crisp
   print.
6. Compute the deconvolution filter `1/H` from the texture train's `S`
   (§3); synthesize one field, threshold per level at `q(C_ℓ)` (§4, §6).
7. Calibrate each level's `q` against painted strokes (core-band coverage,
   §4); then run the §7 audit.
8. Only then spend a human's attention on the plates.

## 9. The other engine features, and why they are not the core

Surveyed for this design; the reasons they lost are as reusable as the
reasons the winners won.

* **Dual brush** — *the* print-texture architecture, and what the sponge
  family ships on. The mask accumulates by the same point-process math (its
  own `Δ_dual, N, S`) into its own buffer, then multiplies the finished
  stroke **once**: `A' = A·mask`. That single application is the whole
  point — the mask's pore voids cut through however densely the primary
  accumulated, so the labyrinth survives a dense paint train that would
  have averaged it away had the texture ridden the primary tip (tried
  first; rejected — it unions into granular dust, §4). The primary carries
  delivery and edge hardness (`K = flow/spacing`), the mask carries the
  texture and the per-level coverage `q`, and a mask *larger* than the
  primary (≈ 130%) lays its features across the stroke edge, which is
  where a texture-driven ragged edge comes from. Multiplying two broadband
  fields convolves their spectra — still broadband, still safe. What to
  watch: the mask train's tear zones must overlap (≈ 3 stamps deep, wide
  plateau) or high-coverage levels break; and the mask cannot rotate, so
  its non-repetition rests on scatter, auto-mirroring, and tip size.
* **Texture channel** — the only canvas-anchored stage in the engine, hence
  the only honest substrate: Masonite tooth belongs here *if* overlapping
  strokes must share their grain. The cost is periodicity: a pattern tiles,
  and a tiled pattern is a 2-D Dirac comb at the tile lattice — exactly the
  spikes this whole page exists to remove. A registered pattern the size of
  the working canvas evades it (at that point the "tile" never repeats);
  the built-in 256px patterns do not. The sponge family therefore carries
  its texture in the tip and leaves the texture channel off; a masonite
  ground variant is a deliberate later add.
* **Noise** — per-pixel hash grain, broadband and safe but material-free
  (white noise has no spatial story), and the one feature whose draw differs
  between the two renderers (`docs/backends.md`). Off.
* **Wet edges** — a coverage remap that pools ink at the rim; it re-weights
  the tonal histogram the coverage calibration just tuned. Off for the core
  family; a "wet sponge" variant is one boolean later.
* **Transfer / flow jitter** — per-dab depth wobble; adds tonal variance
  *within* blobs but cannot add the sub-band along-stroke mottle a loaded
  sponge has (that lives below `1/d`, which §3 shows the train suppresses —
  reachable only by fade/pressure/airbrush modulation, i.e. the hand).
  Mild use only.
* **Color dynamics** — orthogonal to coverage; off so the family measures
  clean.

## Appendix: symbols

| symbol | meaning |
| --- | --- |
| `d, R` | tip diameter, radius (px) |
| `Δ` | step length = `spacing × d × aspect` (px) |
| `N` | scatter count (dabs per step) |
| `S` | max scatter offset = `scatter × d/2` (px) |
| `ρ` | scatter ÷ spacing |
| `t, τ` | tip bitmap; its log-domain kernel `−ln(1 − F·t)` |
| `F` | flow |
| `A, D` | coverage; optical depth `−ln(1−A)` |
| `φ, Λ` | scatter characteristic function; `Λ(u) = (1/u)∫₀ᵘJ₀` |
| `H` | scatter transfer function `1 − |φ|²` |
| `q, C` | tip ink fraction; stroke coverage |
| `n̄, c̄` | effective overlaps `N·c̄/Δ`; mean ink chord |
| `β` | radial spectral exponent `S★ ∝ f^(−β)` |
