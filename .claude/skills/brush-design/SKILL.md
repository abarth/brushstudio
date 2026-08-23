---
name: brush-design
description: Design, tune, and ship Photoshop brushes in this repository — writing brush documents, rendering test plates, measuring marks, studying reference .abr packs, and exporting a pack for Photoshop. Use whenever the task is to create a new brush, change how an existing brush's mark looks or feels, study a Photoshop brush pack, or produce a .abr file.
---

# Designing a brush

The full loop is `docs/workflow.md`; the parameter relationships are
`docs/parameters.md`. For a natural-texture brush or a coverage-graded
family, the signal-processing model (repetition, scatter kernels, coverage
math, tip synthesis) is `docs/fractal-texture-math.md`. This is the short
version and the rules that keep it from going slow.

## The loop

1. **Brief.** Write the intent into the document's `notes` before touching a
   parameter: what mark, what it does that an existing brush cannot, what
   would make it a failure. If the request is open-ended, ask the human
   *now* — which medium, what size range, a brush they already like — rather
   than after a render.
2. **Study**, if there is a reference: `npm run brush -- inspect ref.abr --json`
   gives each brush as a minimal patch. Take the *ratios*, not the numbers.
3. **Draft** `brushes/<name>.json` — a patch over the defaults, every line a
   decision.
4. **Measure**: `npm run brush -- measure brushes/<name>.json`. Fix what the
   numbers say. Do not take a warning to review unless it *is* the design.
5. **Render**: `npm run brush -- render brushes/<name>.json --annotate`.
6. **Review with the human.** Send the plate. One line on what changed, what
   you already know is wrong, and **one** specific question. Offer
   `npm run dev` so they can paint with it — its *Copy settings patch*
   button hands their tweaks back as JSON.
7. **Revise** one or two parameters at a time, `--seed` fixed, re-measuring
   between. Record what the human said in `notes`, rejected directions
   included.
8. **Ship**: `npm run brush -- export brushes/<pack>.json -o out/Pack.abr`,
   then ask them to load it in Photoshop. Where Photoshop disagrees with the
   harness, Photoshop is right; write the difference into `notes`.

## Which questions are whose

Ask the harness whether it repeats, breaks up, builds up, responds to
pressure, or survives export. Ask the human whether the mark is beautiful,
whether it is the right medium, and whether it feels right under the hand.
Spending a review round on the first column is the main way this goes slow.

## Reading `measure`

| reading | meaning |
| --- | --- |
| `repetition` ripple over ~15% with high prominence | the tip is visibly stamping — raise scatter or lower spacing |
| `worst gap` over ~0.5 diameters | the stroke breaks; usually dual spacing over 100% |
| `pressure` ink flat across the row | pressure reaches nothing — check the controls |
| `build-up` ink still climbing at 4 passes | flow is unbounded; cap with opacity if unintended |
| high `coverage`, low `density` | a uniform veil, not paint |
| low `coverage`, high `density` | scattered strands of solid colour |
| `seed spread` cv near 0 | the random dynamics are doing nothing |

## Watch out for

* Commands use the CPU renderer and take a second or two, so iterate freely.
  `--backend gpu` runs the same work through WebGPU in headless Chromium —
  several times slower, and the reference when a mark looks wrong. Ask it
  for one brush and the rows you need, not a whole pack; `docs/backends.md`
  says why.
* Hardness only shapes the round tip. Edge hardness comes from
  **flow ÷ spacing** — see `docs/parameters.md`.
* Non-repetition comes from **scatter ÷ spacing**, and scatter must be on
  both axes to touch the along-stroke beat.
* A direction-driven brush deposits nothing on a tap: direction is undefined
  until the pen moves. That is correct behaviour, not a bug.
* Sampled tips exported to `.abr` go as bitmaps. A procedural tip lands in
  Photoshop frozen at the resolution it was generated at.
