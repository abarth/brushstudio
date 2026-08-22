/**
 * The behaviour suite, written once and run against either renderer.
 *
 * The function below is self-contained on purpose: `tests/run.mjs` calls it
 * directly for the CPU renderer, and ships its source into the browser for
 * the WebGPU one. Anything it closed over would not survive that trip.
 */
export async function runCases(BS, backend = 'cpu') {
  const out = [];
  const test = async (name, fn) => {
    try {
      await fn();
      out.push({ name, ok: true });
    } catch (err) {
      out.push({ name, ok: false, detail: err.message });
    }
  };
  const assert = (cond, message) => {
    if (!cond) throw new Error(message);
  };
  const near = (a, b, tol, message) => {
    if (Math.abs(a - b) > tol) throw new Error(`${message}: ${a} vs ${b} (tol ${tol})`);
  };
  const doc = (settings, extra = {}) => ({ name: 'test', settings, ...extra });
  const factory = BS.backendFactory(backend);
  const measure = (settings, opts = {}) => BS.measureBrush(settings, { ...opts, backend: factory });
  const hash = (bytes) => {
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const paint = async (settings, samples, size = [400, 200], seed = 5) => {
    const surface = await BS.Surface.create(size[0], size[1], factory);
    surface.clear();
    surface.paint(settings, samples, { seed });
    const alpha = await surface.readAlpha();
    surface.destroy();
    return alpha;
  };
  const line = (y, pressure = 0.8, x0 = 40, x1 = 360, step = 3) => {
    const pts = [];
    for (let x = x0; x <= x1; x += step) {
      pts.push({ x, y, pressure, tiltX: 0, tiltY: 0, twist: 0 });
    }
    return pts;
  };
  const inkOf = (alpha) => alpha.reduce((a, v) => a + v, 0) / alpha.length / 255;
  const bandHeight = (alpha, w, h) => {
    let top = h;
    let bottom = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > 8) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          break;
        }
      }
    }
    return bottom < top ? 0 : bottom - top + 1;
  };

  // --- the engine puts ink where it is asked to -----------------------------

  await test('a default brush deposits ink', async () => {
    const alpha = await paint(BS.defaultBrush(), line(100));
    assert(inkOf(alpha) > 0.01, 'the stroke deposited nothing');
  });

  await test('the same seed redraws the same mark', async () => {
    const settings = BS.makeBrush({
      tip: { shape: 'spatter', size: 30 },
      scatter: { enabled: true, scatter: 2, count: 3, bothAxes: true },
    });
    const a = await paint(settings, line(100), [400, 200], 11);
    const b = await paint(settings, line(100), [400, 200], 11);
    assert(hash(a) === hash(b), 'two runs at one seed differed');
  });

  await test('a different seed moves a jittered mark', async () => {
    const settings = BS.makeBrush({
      tip: { shape: 'spatter', size: 30 },
      scatter: { enabled: true, scatter: 2, count: 3, bothAxes: true },
    });
    const a = await paint(settings, line(100), [400, 200], 11);
    const b = await paint(settings, line(100), [400, 200], 12);
    assert(hash(a) !== hash(b), 'the seed had no effect on a scattered brush');
  });

  // --- the knobs do what the docs say --------------------------------------

  await test('pressure drives size when Shape Dynamics says so', async () => {
    const settings = BS.makeBrush({
      tip: { size: 60, spacing: 0.1 },
      shape: { enabled: true, sizeControl: { source: 'pressure', fadeSteps: 25 }, minDiameter: 0 },
    });
    const light = await paint(settings, line(100, 0.2), [400, 200]);
    const heavy = await paint(settings, line(100, 1), [400, 200]);
    const lightH = bandHeight(light, 400, 200);
    const heavyH = bandHeight(heavy, 400, 200);
    assert(heavyH > lightH * 2, `heavy ${heavyH}px was not much wider than light ${lightH}px`);
  });

  await test('hardness narrows the falloff band', async () => {
    const soft = await measure(BS.makeBrush({ tip: { size: 60, hardness: 0 } }), { seeds: 1 });
    const hard = await measure(BS.makeBrush({ tip: { size: 60, hardness: 1 } }), { seeds: 1 });
    assert(
      hard.dab.edgeWidth < soft.dab.edgeWidth,
      `hard edge ${hard.dab.edgeWidth} was not tighter than soft ${soft.dab.edgeWidth}`,
    );
  });

  await test('spacing over 100% leaves gaps a stroke cannot fill', async () => {
    const tight = await measure(BS.makeBrush({ tip: { size: 40, spacing: 0.1 } }), { seeds: 1 });
    const loose = await measure(BS.makeBrush({ tip: { size: 40, spacing: 2 } }), { seeds: 1 });
    assert(tight.flat.coverage > 0.9, `tight spacing only covered ${tight.flat.coverage}`);
    assert(loose.flat.coverage < tight.flat.coverage, 'loose spacing did not open the mark up');
    assert(
      loose.repetition.amplitude > 0.3,
      `a train of separated dabs rippled only ${loose.repetition.amplitude}`,
    );
    assert(
      loose.repetition.worstGap > tight.repetition.worstGap,
      `loose gap ${loose.repetition.worstGap} vs tight ${tight.repetition.worstGap}`,
    );
  });

  await test('opacity caps one stroke; flow keeps building inside it', async () => {
    // A path that doubles back over itself: within a single stroke, opacity
    // is the ceiling no amount of overlap may cross, while flow alone
    // happily accumulates past it.
    const there = line(100, 0.9, 60, 340, 4);
    const andBack = [...there, ...there.slice().reverse()];
    const peak = (alpha) => Math.max(...alpha) / 255;

    const capped = await paint(
      BS.makeBrush({ tip: { size: 40, spacing: 0.15, hardness: 1 }, flow: 0.35, opacity: 0.5 }),
      andBack,
    );
    const free = await paint(
      BS.makeBrush({ tip: { size: 40, spacing: 0.15, hardness: 1 }, flow: 0.35, opacity: 1 }),
      andBack,
    );
    assert(peak(capped) <= 0.55, `a 50% stroke reached ${peak(capped)}`);
    assert(peak(free) > 0.8, `an uncapped stroke only reached ${peak(free)}`);
  });

  // --- the measurements mean what they claim -------------------------------

  await test('a smooth round brush measures as non-repeating', async () => {
    const m = await measure(BS.makeBrush({ tip: { size: 40, spacing: 0.1 } }), { seeds: 1 });
    assert(m.repetition.amplitude < 0.05, `ripple was ${m.repetition.amplitude}`);
    near(m.repetition.worstGap, 0, 0.01, 'a solid stroke reported a gap');
  });

  await test('a dual mask with gappy spacing shows up as a break', async () => {
    const m = await measure(
      BS.makeBrush({
        tip: { size: 40, spacing: 0.1 },
        dual: { enabled: true, shape: 'grain', size: 30, spacing: 1.8, scatter: 0 },
      }),
      { seeds: 2 },
    );
    assert(
      m.repetition.worstGap > 0.2,
      `a gappy dual train reported worstGap ${m.repetition.worstGap}`,
    );
  });

  await test('scatter widens the band without filling it', async () => {
    const plain = await measure(BS.makeBrush({ tip: { shape: 'spatter', size: 40 } }), { seeds: 1 });
    const spread = await measure(
      BS.makeBrush({
        tip: { shape: 'spatter', size: 40 },
        scatter: { enabled: true, scatter: 2.5, bothAxes: true, count: 2 },
      }),
      { seeds: 1 },
    );
    assert(spread.flat.widthPx > plain.flat.widthPx * 1.5, 'scatter did not widen the mark');
    assert(spread.flat.coverage < plain.flat.coverage, 'scatter did not open the mark up');
  });

  // --- brush documents ------------------------------------------------------

  await test('a document is a patch: omitted fields keep their defaults', async () => {
    const resolved = await BS.resolveBrush(doc({ tip: { size: 77 } }), {});
    assert(resolved.settings.tip.size === 77, 'the patch was not applied');
    assert(
      resolved.settings.tip.spacing === BS.defaultBrush().tip.spacing,
      'spacing was not defaulted',
    );
  });

  await test('a builtin tip alias resolves through @name', async () => {
    const resolved = await BS.resolveBrush(
      doc({ tip: { shape: '@chisel' } }, { tips: { chisel: { builtin: 'bristle-chisel' } } }),
      {},
    );
    assert(resolved.settings.tip.shape === 'bristle-chisel', `got ${resolved.settings.tip.shape}`);
  });

  await test('an undeclared @name is an error, not a silent fallback', async () => {
    let threw = false;
    try {
      await BS.resolveBrush(doc({ tip: { shape: '@nope' } }), {});
    } catch {
      threw = true;
    }
    assert(threw, 'an unknown tip reference was accepted');
  });

  await test('a misspelt setting is reported, not silently ignored', async () => {
    const resolved = await BS.resolveBrush(doc({ tip: { spacng: 0.2 } }), {});
    assert(
      resolved.warnings.some((w) => w.includes('spacng') && w.includes('spacing')),
      `warnings were ${JSON.stringify(resolved.warnings)}`,
    );
  });

  await test('a dual train that cannot abut is warned about', async () => {
    const resolved = await BS.resolveBrush(
      doc({ dual: { enabled: true, shape: 'grain', spacing: 1.5 } }),
      {},
    );
    assert(
      resolved.warnings.some((w) => w.includes('dual spacing')),
      `warnings were ${JSON.stringify(resolved.warnings)}`,
    );
  });

  await test('the minimal patch reproduces the settings it came from', async () => {
    const settings = BS.makeBrush({
      tip: { shape: 'chalk', size: 90, spacing: 0.08, roundness: 0.85 },
      texture: { enabled: true, pattern: 'canvas', depth: 0.55 },
      transfer: { enabled: true, flowMin: 0.15 },
      flow: 0.6,
    });
    const rebuilt = BS.makeBrush(BS.diffFromDefaults(settings));
    assert(
      JSON.stringify(rebuilt) === JSON.stringify(settings),
      'a settings object did not survive diff + rebuild',
    );
  });

  // --- Photoshop files ------------------------------------------------------

  await test('a computed brush survives an .abr round trip', async () => {
    const result = await BS.exportAbr(
      [doc({ tip: { size: 45, spacing: 0.17, angle: 30, roundness: 0.6 }, flow: 0.4, opacity: 0.8 })],
      {},
    );
    assert(result.issues.length === 0, result.issues.join('; '));
    assert(result.bytes > 0, 'the writer produced no bytes');
  });

  await test('a sampled tip and a texture pattern are embedded', async () => {
    const result = await BS.exportAbr(
      [
        doc({
          tip: { shape: 'bristle-chisel', size: 120 },
          texture: { enabled: true, pattern: 'linen', depth: 0.4 },
          dual: { enabled: true, shape: 'fiber-drag', size: 90, spacing: 0.3 },
        }),
      ],
      {},
    );
    assert(result.issues.length === 0, result.issues.join('; '));
    assert(result.tips >= 2, `expected the primary and dual tips, got ${result.tips}`);
    assert(result.patterns >= 1, 'the texture pattern was not embedded');
  });

  await test('what we write, we can read back apart', async () => {
    const written = await BS.exportAbr([{ name: 'Round One', settings: { tip: { size: 33 } } }], {});
    const report = BS.inspectAbr(written.abr, 'written.abr');
    assert(report.brushes.length === 1, `read ${report.brushes.length} brushes`);
    assert(report.brushes[0].name === 'Round One', `name came back as ${report.brushes[0].name}`);
    near(report.brushes[0].patch.tip.size, 33, 0.05, 'size did not survive');
  });

  // --- plates ---------------------------------------------------------------

  await test('a plate renders every row it was asked for', async () => {
    const plate = await BS.renderPlate([doc({ tip: { size: 30 } })].map((d) => ({
      label: d.name,
      settings: BS.makeBrush(d.settings),
    })), { width: 500, strokes: ['flat', 'taper'], backend });
    assert(plate.rows.length === 2, `plate had ${plate.rows.length} rows`);
    assert(plate.width === 500 && plate.height > 100, `plate was ${plate.width}x${plate.height}`);
  });

  await test('a scattered brush gets a row tall enough to hold it', async () => {
    const mk = (settings) => [{ label: 'x', settings: BS.makeBrush(settings) }];
    const tight = await BS.renderPlate(mk({ tip: { size: 30 } }), {
      width: 400,
      strokes: ['flat'],
      backend,
    });
    const wide = await BS.renderPlate(
      mk({ tip: { size: 30 }, scatter: { enabled: true, scatter: 3, bothAxes: true } }),
      { width: 400, strokes: ['flat'], backend },
    );
    assert(
      wide.height > tight.height * 1.5,
      `${wide.height} was not much taller than ${tight.height}`,
    );
  });

  return out;
}
