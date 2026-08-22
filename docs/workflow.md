# The design loop

A brush is not finished when the parameters look reasonable. It is finished
when a person who paints says the mark is right. Everything here is built
around that: the harness exists to make every step *before* that judgement
cheap and honest, so the human's attention is spent only where it is the
scarce resource.

```
   brief ──▶ study ──▶ draft ──▶ measure ──▶ render ──▶ REVIEW ──▶ revise ──▶ ship
     ▲                             │                      │           │
     └───────── the human ─────────┴──────────────────────┴───────────┘
```

## 1. Brief — before any parameters

Write the design intent into the document's `notes` first:

* what mark this is (a loaded oil brush, a dry chalk, a spray)
* what it should do that an existing brush cannot
* what would make it a failure

A brief you cannot write is a brief you should ask about. When the request
is open-ended — "make me some nice brushes" — put the question to the human
*before* spending a render: which medium, what size range, and is there a
brush they already like. One question up front beats three rounds of guessing.

## 2. Study — copy ratios, not numbers

If there is a reference pack, read it apart:

```bash
npm run brush -- inspect refs/SomePack.abr --json
npm run brush -- inspect refs/SomePack.abr --render out/ref.png
```

`--json` gives each brush as a minimal patch, so what makes it distinctive
is visible at a glance. Take the *relationships* from it — flow over
spacing, scatter over spacing, dual size against tip size — rather than the
raw values, which are tied to that pack's tip bitmaps. `docs/parameters.md`
explains why those particular ratios are the ones that carry over.

## 3. Draft

Write `brushes/<name>.json`. Keep it a patch: every line in the file should
be a decision. See `docs/brush-format.md`.

## 4. Measure — before showing anyone

```bash
npm run brush -- measure brushes/<name>.json
```

This is the step that keeps the human's time for things only a human can
judge. The numbers settle the objective failures outright:

| what you see | what it means |
| --- | --- |
| `repetition` prominence ≫ 1 with ripple over ~10% | the tip is visibly stamping — raise scatter, or lower spacing |
| `worst gap` above ~0.5 diameters | the stroke breaks — usually dual spacing over 100% |
| `pressure` ink flat across the row | pressure is not reaching anything; check the controls |
| `build-up` ink still climbing at 4 passes | flow is unbounded; cap it with opacity if that is not wanted |
| `coverage` high, `density` low | a uniform veil, not paint |
| `coverage` low, `density` high | scattered strands of solid colour |
| `seed spread` cv near 0 | the random dynamics are not doing anything |

Fix what the numbers say, then measure again. Do not take a brush to review
with a warning still on it unless the warning is the design.

## 5. Render

```bash
npm run brush -- render brushes/<name>.json --annotate
```

The plate always draws the same marks in the same order, so two revisions
diff as images and a design sits next to a reference honestly:

```bash
npm run brush -- compare brushes/<name>.json --ref refs/SomePack.abr#"Rough Bristle"
```

Keep `--seed` fixed while iterating, so a change in the plate is a change in
the brush. Vary the seed only when you are specifically testing whether the
brush survives bad luck.

## 6. Review — the human step

Send the plate. Keep the note short and make it easy to answer:

* one line on what changed since last time
* what you already know is wrong (do not make them find it)
* **one** specific question — "is the chalk grain too coarse at 90px, or
  should the tooth be finer?" beats "what do you think?"

Offer the hands-on path too, because a plate cannot answer how a brush
*feels*:

```bash
npm run dev      # paint with it, tweak the sliders, copy the patch back
```

The try-out app's **Copy settings patch** button emits exactly the JSON a
brush document takes, so a reviewer's fiddling comes back as a diff instead
of a description.

## 7. Revise

Change **one or two** parameters per iteration and re-measure. The
relationships in `docs/parameters.md` interact; a four-parameter change that
improves the plate teaches you nothing about which of the four did it.

Record what the human said in `notes` — especially rejected directions. The
next revision, by you or by someone else, should not have to re-learn it.

## 8. Ship

```bash
npm run brush -- export brushes/<pack>.json -o out/Pack.abr
```

Export verifies its own round trip. Then ask the human to load the file in
Photoshop and draw with it: the harness is a very good model of Photoshop's
engine, and a model is not the thing. Where they disagree, Photoshop is
right — write the difference into `notes`.

## Which questions are whose

| ask the harness | ask the human |
| --- | --- |
| does it repeat? break up? build up? | is the mark beautiful |
| does pressure do anything | is it the right medium for the job |
| did the export survive | does it feel right under the hand |
| is it the size it claims | is it worth shipping |

Spending a human round on a question in the left column is the main way this
loop goes slow.
