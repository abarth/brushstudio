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

  await test('a facet bound to the pen pose turns with the barrel', async () => {
    // An elliptical tip already draws a narrow mark along its long axis and
    // a wide one across it. What Pen Tilt on the angle adds is whose axis it
    // is: the pen's, not the canvas's — so the same fan of headings has to
    // come out the same when the barrel moves.
    //
    // Which way round it lands is Photoshop's convention and is pinned here
    // in both directions, because it is not the obvious one: a bare tilt
    // binding puts the long axis ACROSS the lean, and a tip meant to lie
    // along the barrel needs 90 in tip.angle to get there.
    const facet = { tip: { size: 24, roundness: 0.5, spacing: 0.05 } };
    const tilt = { enabled: true, angleControl: { source: 'tilt', fadeSteps: 25 } };

    const across = await measure(BS.makeBrush({ ...facet, shape: tilt }), { seeds: 1 });
    assert(
      across.pose.anisotropy > 1.3,
      `a half-round facet measured only ${across.pose.anisotropy}x wide-to-narrow`,
    );
    assert(across.pose.followsPen, 'a tilt-bound facet did not follow the pen');
    assert(
      across.pose.narrowestDeg === 90,
      `angle 0 should lay the facet across the lean, narrow at 90°, not ${across.pose.narrowestDeg}°`,
    );

    const along = await measure(
      BS.makeBrush({ tip: { ...facet.tip, angle: 90 }, shape: tilt }),
      { seeds: 1 },
    );
    assert(along.pose.followsPen, 'the turned facet did not follow the pen');
    assert(
      along.pose.narrowestDeg === 0,
      `angle 90 should lay the facet along the barrel, narrow at 0°, not ${along.pose.narrowestDeg}°`,
    );

    // the same ellipse pinned to the canvas: just as anisotropic, and the
    // fan stays where it is when the pen turns
    const pinned = await measure(BS.makeBrush(facet), { seeds: 1 });
    assert(
      pinned.pose.anisotropy > 1.3,
      `the pinned control measured only ${pinned.pose.anisotropy}x`,
    );
    assert(!pinned.pose.followsPen, 'a fixed tip angle should not follow the pen');
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

  await test('every value is written at the type Photoshop stores it at', async () => {
    // Two panels, two conventions, and the file has to match both: the Brush
    // Settings panel keeps percentages as '#Prc' unit floats, while
    // toolOptions mirrors the options bar, where Opacity, Flow and Smoothing
    // are whole integers — Photoshop's own scripting API reads those back
    // with getInteger. The reader refuses a value at the wrong type now, so
    // the round trip below catches most of this; the bytes are what pin the
    // unit, which nothing else can see. docs/abr.md carries the whole table.
    const written = await BS.exportAbr([doc({
      tip: { size: 33, hardness: 0.5, spacing: 0.2, roundness: 0.75, angle: 30 },
      flow: 0.4,
      opacity: 0.8,
      smoothing: 0.2,
    })], {});
    const bytes = typeof written.abr === 'string'
      ? Uint8Array.from(atob(written.abr), (c) => c.charCodeAt(0))
      : new Uint8Array(written.abr);
    // a descriptor key is u32 length + ascii, where a four-character key
    // writes its length as 0; the type follows, and a unit float its unit
    const typeOf = (key) => {
      const len = key.length === 4 ? 0 : key.length;
      const needle = [len >> 24 & 255, len >> 16 & 255, len >> 8 & 255, len & 255,
        ...[...key].map((c) => c.charCodeAt(0))];
      for (let i = 0; i + needle.length + 8 <= bytes.length; i++) {
        if (needle.every((b, k) => bytes[i + k] === b)) {
          const at = i + needle.length;
          const type = String.fromCharCode(...bytes.subarray(at, at + 4));
          return type === 'UntF'
            ? type + String.fromCharCode(...bytes.subarray(at + 4, at + 8))
            : type;
        }
      }
      return 'missing';
    };
    const expected = {
      Dmtr: 'UntF#Pxl',
      Hrdn: 'UntF#Prc',
      Angl: 'UntF#Ang',
      Rndn: 'UntF#Prc',
      Spcn: 'UntF#Prc',
      minimumDiameter: 'UntF#Prc',
      flow: 'long',
      Opct: 'long',
      Smoo: 'long',
      smoothingValue: 'doub',
      textureBrightness: 'missing', // no texture on this brush
    };
    for (const [key, want] of Object.entries(expected)) {
      assert(typeOf(key) === want, `${key} was written as ${typeOf(key)}, wanted ${want}`);
    }
    assert(written.issues.length === 0, written.issues.join('; '));
  });

  await test('the descriptor has the shape of one Photoshop wrote', async () => {
    // Transcribed from `inspect --dump 0` of a pack Photoshop itself wrote:
    // a computed round brush, Shape Dynamics on, every other section off, and
    // the options bar set. Types only — two brushes share no values — so what
    // this pins is the schema: every key Photoshop writes, at the type it
    // writes it, and nothing it does not write. It is the check that caught
    // us omitting the five smoothing booleans and naming a computed tip.
    const dyn = (name) => ({
      [name]: 'Objc brVr',
      [`${name}.bVTy`]: 'long',
      [`${name}.fStp`]: 'long',
      [`${name}.jitter`]: 'UntF #Prc',
      [`${name}.Mnm`]: 'UntF #Prc',
    });
    const PHOTOSHOP = {
      Nm: 'TEXT',
      Brsh: 'Objc computedBrush',
      'Brsh.Dmtr': 'UntF #Pxl',
      'Brsh.Hrdn': 'UntF #Prc',
      'Brsh.Angl': 'UntF #Ang',
      'Brsh.Rndn': 'UntF #Prc',
      'Brsh.Spcn': 'UntF #Prc',
      'Brsh.Intr': 'bool',
      'Brsh.flipX': 'bool',
      'Brsh.flipY': 'bool',
      useTipDynamics: 'bool',
      flipX: 'bool',
      flipY: 'bool',
      brushProjection: 'bool',
      minimumDiameter: 'UntF #Prc',
      minimumRoundness: 'UntF #Prc',
      tiltScale: 'UntF #Prc',
      ...dyn('szVr'),
      ...dyn('angleDynamics'),
      ...dyn('roundnessDynamics'),
      useScatter: 'bool',
      dualBrush: 'Objc dualBrush',
      'dualBrush.useDualBrush': 'bool',
      brushGroup: 'Objc brushGroup',
      'brushGroup.useBrushGroup': 'bool',
      useTexture: 'bool',
      usePaintDynamics: 'bool',
      useColorDynamics: 'bool',
      Wtdg: 'bool',
      Nose: 'bool',
      Rpt: 'bool',
      useBrushSize: 'bool',
      useBrushPose: 'bool',
      toolOptions: 'Objc PbTl',
      'toolOptions.brushPreset': 'bool',
      'toolOptions.flow': 'long',
      'toolOptions.Smoo': 'long',
      'toolOptions.Md': 'enum',
      'toolOptions.Opct': 'long',
      'toolOptions.smoothing': 'bool',
      'toolOptions.smoothingValue': 'doub',
      'toolOptions.smoothingRadiusMode': 'bool',
      'toolOptions.smoothingCatchup': 'bool',
      'toolOptions.smoothingCatchupAtEnd': 'bool',
      'toolOptions.smoothingZoomCompensation': 'bool',
      'toolOptions.pressureSmoothing': 'bool',
      'toolOptions.usePressureOverridesSize': 'bool',
      'toolOptions.usePressureOverridesOpacity': 'bool',
      'toolOptions.useLegacy': 'bool',
    };

    // the same brush: round tip, Shape Dynamics on, nothing else
    const written = await BS.exportAbr([doc({
      tip: { size: 175, hardness: 1, spacing: 0.05 },
      shape: { enabled: true },
      flow: 0.1,
      opacity: 0.8,
      smoothing: 0,
    })], {});
    const ours = BS.abrShape(written.abr);

    const wrong = Object.keys(PHOTOSHOP)
      .filter((k) => ours[k] !== PHOTOSHOP[k])
      .map((k) => `${k}: Photoshop ${PHOTOSHOP[k]}, ours ${ours[k] ?? 'missing'}`);
    const extra = Object.keys(ours).filter((k) => !(k in PHOTOSHOP));
    assert(!wrong.length, wrong.join('; '));
    assert(!extra.length, `keys Photoshop does not write: ${extra.join(', ')}`);
  });

  await test('two descriptors can be held against each other by shape', async () => {
    // The one question a reader cannot answer about itself: a key at the
    // wrong type gets reported, but a key we never write looks exactly like
    // one that is legitimately absent. Comparing shapes is what shows it.
    const plain = await BS.exportAbr([doc({ tip: { size: 20 } })], {});
    const textured = await BS.exportAbr([doc({
      tip: { size: 20 },
      texture: { enabled: true, pattern: 'paper', depth: 0.4 },
    })], {});

    const same = BS.compareAbrDescriptors(plain.abr, plain.abr);
    assert(
      !same.onlyInReference.length && !same.onlyInOurs.length && !same.differing.length,
      'a file came out different from itself',
    );

    const diff = BS.compareAbrDescriptors(plain.abr, textured.abr);
    const missing = diff.onlyInReference.map((r) => r.key);
    assert(missing.includes('textureScale'), `reference-only keys were ${missing.join(', ')}`);
    assert(missing.includes('Txtr.Idnt'), `reference-only keys were ${missing.join(', ')}`);
    assert(!diff.onlyInOurs.length, `ours had extra keys: ${JSON.stringify(diff.onlyInOurs)}`);
  });

  await test('a preset saved for another tool is read, not refused', async () => {
    // Saving a preset with tool settings binds it to the tool in use, and the
    // class of toolOptions is which tool that was: a real pack carries
    // smudge, eraser and pencil presets beside the brushes. They are ordinary
    // presets and have to read as such — only the mark they make differs.
    const written = await BS.exportAbr([doc({ flow: 0.4 })], {});
    const bytes = typeof written.abr === 'string'
      ? Uint8Array.from(atob(written.abr), (c) => c.charCodeAt(0))
      : new Uint8Array(written.abr);
    const n = [...'PbTl'].map((c) => c.charCodeAt(0));
    let at = -1;
    for (let i = 0; i + 4 <= bytes.length && at < 0; i++) {
      if (n.every((b, k) => bytes[i + k] === b)) at = i;
    }
    assert(at >= 0, 'the toolOptions class was not written');
    bytes.set([...'SmTl'].map((c) => c.charCodeAt(0)), at); // same length, no reflow

    const report = BS.inspectAbr(bytes, 'smudge.abr');
    assert(
      !report.issues.some((i) => i.kind === 'class'),
      `a tool class was refused: ${JSON.stringify(report.issues)}`,
    );
    assert(report.brushes[0].tool === 'SmTl', `tool came back ${report.brushes[0].tool}`);
    assert(report.brushes[0].patch.flow === 0.4, 'the options bar was not read');
  });

  await test('a count survives as the double Photoshop stores it as', async () => {
    // Count looks like an integer and is not one: a real pack stores it as a
    // 'doub', and reading it as a long left every dual brush we imported
    // sitting at a count of 1.
    const written = await BS.exportAbr([doc({
      scatter: { enabled: true, count: 4 },
      dual: { enabled: true, shape: 'grain', count: 3, spacing: 0.3 },
    })], {});
    assert(written.issues.length === 0, written.issues.join('; '));
    const { patch } = BS.inspectAbr(written.abr, 'counts.abr').brushes[0];
    assert(patch.scatter.count === 4, `scatter count came back ${patch.scatter.count}`);
    assert(patch.dual.count === 3, `dual count came back ${patch.dual.count}`);
  });

  await test('a value at the wrong type is refused, not unwrapped', async () => {
    // Everything the round-trip check is worth rests on the reader being
    // able to tell a value Photoshop would refuse from one it would read.
    // Here the options-bar Flow is rewritten as a '#Prc' unit float — the
    // type the Brush Settings panel uses, and the wrong one for this
    // descriptor — and has to come back reported and unread, not quietly
    // correct, which is what the old reader did with it.
    const written = await BS.exportAbr([doc({ flow: 0.4 })], {});
    const bytes = typeof written.abr === 'string'
      ? Uint8Array.from(atob(written.abr), (c) => c.charCodeAt(0))
      : new Uint8Array(written.abr);
    const find = (needle) => {
      const n = [...needle].map((c) => c.charCodeAt(0));
      for (let i = 0; i + n.length <= bytes.length; i++) {
        if (n.every((b, k) => bytes[i + k] === b)) return i;
      }
      return -1;
    };
    const at = find('\u0000\u0000\u0000\u0000flow') + 8; // just past the key
    assert(bytes[at] === 0x6c, 'flow was not a long to begin with');

    // 'long' + i32 is 8 bytes; 'UntF' + '#Prc' + f64 is 16
    const swap = new Uint8Array(16);
    swap.set([...'UntF#Prc'].map((c) => c.charCodeAt(0)));
    new DataView(swap.buffer).setFloat64(8, 40);
    const patched = new Uint8Array(bytes.length + 8);
    patched.set(bytes.subarray(0, at));
    patched.set(swap, at);
    patched.set(bytes.subarray(at + 8), at + 16);
    // the 'desc' section header carries its own length, and it sits before
    // the bytes we grew
    const descLen = find('8BIMdesc') + 8;
    const view = new DataView(patched.buffer);
    view.setUint32(descLen, view.getUint32(descLen) + 8);

    const report = BS.inspectAbr(patched, 'patched.abr');
    const issue = report.issues.find((i) => i.where === 'toolOptions.flow');
    assert(issue, `no issue was reported: ${JSON.stringify(report.issues)}`);
    assert(issue.kind === 'type', `issue was ${JSON.stringify(issue)}`);
    assert(
      report.brushes[0].patch.flow === undefined,
      `the refused value was read anyway: ${report.brushes[0].patch.flow}`,
    );
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
