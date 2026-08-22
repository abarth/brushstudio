# The brush document

A brush is a JSON file in `brushes/`. It is a **patch over the engine
defaults**, not a full settings dump: a document shows only the decisions
that were made, so the diff between two revisions is the design change and
nothing else.

```json
{
  "name": "Dry Chalk 90",
  "notes": "Why this brush exists and what the tricky parts are.",
  "settings": {
    "tip": { "shape": "chalk", "size": 90, "spacing": 0.08 },
    "texture": { "enabled": true, "pattern": "canvas", "depth": 0.55 }
  }
}
```

| field | meaning |
| --- | --- |
| `name` | what Photoshop shows in the Brushes panel |
| `id` | stable handle; defaults to the file name |
| `notes` | design intent — read by humans and agents, never exported |
| `settings` | the patch; anything omitted keeps its default |
| `tips` | sampled tip bitmaps this brush needs (see below) |
| `patterns` | texture pattern bitmaps this brush needs |

Run `npm run brush -- show brushes/thing.json` to see the resolved settings
in full, with the defaults filled in.

## Bringing in bitmaps

`settings.tip.shape` and `settings.texture.pattern` normally name one of the
engine's built-ins (`npm run brush -- list`). To use a bitmap from somewhere
else, declare it under `tips` / `patterns` and reference it with `@name`:

```json
{
  "name": "Borrowed Bristle",
  "tips": {
    "bristle": { "abr": "../refs/SomePack.abr", "tip": "Rough Bristle 60" },
    "mine":    { "image": "../tips/scan.png" }
  },
  "patterns": {
    "grain": { "abr": "../refs/SomePack.abr", "pattern": "Coarse Weave" }
  },
  "settings": {
    "tip": { "shape": "@bristle", "size": 120 },
    "dual": { "enabled": true, "shape": "@mine", "size": 130 },
    "texture": { "enabled": true, "pattern": "@grain", "depth": 0.4 }
  }
}
```

Sources:

| source | form | notes |
| --- | --- | --- |
| Photoshop pack | `{ "abr": "path.abr", "tip": "Name or index" }` | tips are looked up by the brush that uses them, or by index |
| pattern in a pack | `{ "abr": "path.abr", "pattern": "Name or index" }` | |
| image file | `{ "image": "path.png" }` | grayscale, **white is ink**; non-square is centred in a square |
| engine built-in | `{ "builtin": "bristle-chisel" }` | an alias, useful when a document wants a stable local name |

Paths are relative to the document. Everything a document references is
embedded when it is exported, so the resulting `.abr` stands alone in
Photoshop. The try-out app lists a document's own bitmaps under these names,
above the engine's built-ins, and writes a picked one back as `@name`.

## Packs

A pack is what becomes one `.abr` file:

```json
{
  "name": "Brushstudio Starters",
  "brushes": ["round-soft.json", "chalk-dry.json"]
}
```

`render`, `measure` and `export` all accept a pack, a directory, or a list
of brush documents.

## What the engine defaults to

Everything a document does not mention. In short: a 40px soft round tip at
25% spacing, every dynamics section off, flow and opacity at 100%, blend
mode normal, smoothing 15%. `npm run brush -- show` on any document prints
the resolved result, and `docs/parameters.md` explains the units.
