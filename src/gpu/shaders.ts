/**
 * All WGSL shaders. Layer/accumulation/stroke textures store PREMULTIPLIED
 * alpha. Compositing math runs on non-linear sRGB values, matching
 * Photoshop's default (8-bit, "Blend RGB Colors Using Gamma" off).
 */

export const FULLSCREEN_VS = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = p[vi] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return out;
}
`;

/**
 * Blend-mode library, following the PDF/ISO 32000 formulas that Photoshop
 * implements. b = backdrop, s = source, both straight (un-premultiplied).
 */
const BLEND_LIB = /* wgsl */ `
fn scr(b: vec3f, s: vec3f) -> vec3f {
  return b + s - b * s;
}

fn hardLight(b: vec3f, s: vec3f) -> vec3f {
  return select(scr(b, 2.0 * s - 1.0), b * (2.0 * s), s <= vec3f(0.5));
}

fn dodgeC(b: f32, s: f32) -> f32 {
  if (b <= 0.0) { return 0.0; }
  if (s >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - s));
}

fn burnC(b: f32, s: f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (s <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / s);
}

fn colorDodge(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(dodgeC(b.x, s.x), dodgeC(b.y, s.y), dodgeC(b.z, s.z));
}

fn colorBurn(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(burnC(b.x, s.x), burnC(b.y, s.y), burnC(b.z, s.z));
}

fn softLightC(b: f32, s: f32) -> f32 {
  if (s <= 0.5) {
    return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  }
  var d: f32;
  if (b <= 0.25) {
    d = ((16.0 * b - 12.0) * b + 4.0) * b;
  } else {
    d = sqrt(b);
  }
  return b + (2.0 * s - 1.0) * (d - b);
}

fn softLight(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(softLightC(b.x, s.x), softLightC(b.y, s.y), softLightC(b.z, s.z));
}

fn vividC(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return burnC(b, 2.0 * s); }
  return dodgeC(b, 2.0 * s - 1.0);
}

fn vividLight(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(vividC(b.x, s.x), vividC(b.y, s.y), vividC(b.z, s.z));
}

fn pinC(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return min(b, 2.0 * s); }
  return max(b, 2.0 * s - 1.0);
}

fn pinLight(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(pinC(b.x, s.x), pinC(b.y, s.y), pinC(b.z, s.z));
}

fn divideBlend(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(
    select(min(1.0, b.x / s.x), 1.0, s.x <= 0.0),
    select(min(1.0, b.y / s.y), 1.0, s.y <= 0.0),
    select(min(1.0, b.z / s.z), 1.0, s.z <= 0.0),
  );
}

// --- non-separable modes (hue / saturation / color / luminosity) ---

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.3, 0.59, 0.11));
}

fn clipColor(c0: vec3f) -> vec3f {
  var c = c0;
  let l = lum(c);
  let n = min(c.x, min(c.y, c.z));
  let x = max(c.x, max(c.y, c.z));
  if (n < 0.0) {
    c = vec3f(l) + (c - vec3f(l)) * l / max(l - n, 1e-6);
  }
  if (x > 1.0) {
    c = vec3f(l) + (c - vec3f(l)) * (1.0 - l) / max(x - l, 1e-6);
  }
  return c;
}

fn setLum(c: vec3f, l: f32) -> vec3f {
  return clipColor(c + vec3f(l - lum(c)));
}

fn satOf(c: vec3f) -> f32 {
  return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z));
}

fn setSat(c: vec3f, s: f32) -> vec3f {
  let mn = min(c.x, min(c.y, c.z));
  let mx = max(c.x, max(c.y, c.z));
  if (mx > mn) {
    return (c - vec3f(mn)) * s / (mx - mn);
  }
  return vec3f(0.0);
}

fn blendPixel(mode: u32, b: vec3f, s: vec3f) -> vec3f {
  switch (mode) {
    case 0u: { return s; }                                          // normal
    case 1u: { return min(b, s); }                                  // darken
    case 2u: { return b * s; }                                      // multiply
    case 3u: { return colorBurn(b, s); }
    case 4u: { return clamp(b + s - 1.0, vec3f(0.0), vec3f(1.0)); } // linear burn
    case 5u: { return max(b, s); }                                  // lighten
    case 6u: { return scr(b, s); }                                  // screen
    case 7u: { return colorDodge(b, s); }
    case 8u: { return min(b + s, vec3f(1.0)); }                     // linear dodge
    case 9u: { return hardLight(s, b); }                            // overlay
    case 10u: { return softLight(b, s); }
    case 11u: { return hardLight(b, s); }
    case 12u: { return vividLight(b, s); }
    case 13u: { return clamp(b + 2.0 * s - 1.0, vec3f(0.0), vec3f(1.0)); } // linear light
    case 14u: { return pinLight(b, s); }
    case 15u: { return abs(b - s); }                                // difference
    case 16u: { return b + s - 2.0 * b * s; }                       // exclusion
    case 17u: { return max(b - s, vec3f(0.0)); }                    // subtract
    case 18u: { return divideBlend(b, s); }
    case 19u: { return setLum(setSat(s, satOf(b)), lum(b)); }       // hue
    case 20u: { return setLum(setSat(b, satOf(s)), lum(b)); }       // saturation
    case 21u: { return setLum(s, lum(b)); }                         // color
    case 22u: { return setLum(b, lum(s)); }                         // luminosity
    default: { return s; }
  }
}

/**
 * PDF compositing: source (straight color cs, alpha as_) over a premultiplied
 * backdrop, honoring the blend mode. Returns premultiplied.
 */
fn compositePixel(dst: vec4f, cs: vec3f, as_: f32, mode: u32) -> vec4f {
  let ab = dst.a;
  var cb = vec3f(0.0);
  if (ab > 0.0) { cb = dst.rgb / ab; }
  let bl = blendPixel(mode, cb, cs);
  let co = as_ * (1.0 - ab) * cs + as_ * ab * bl + (1.0 - as_) * dst.rgb;
  let ao = as_ + ab * (1.0 - as_);
  return vec4f(co, ao);
}
`;

/**
 * Texture/dual-brush modulation and wet-edge helpers shared by the stamp,
 * compositor, and commit shaders.
 */
const TEX_LIB = /* wgsl */ `
// brightness/contrast/invert packed as bci.x/.y/.z
fn texValue(raw: f32, bci: vec4f) -> f32 {
  var v = raw + bci.x;
  v = (v - 0.5) * (1.0 + bci.y * 2.0) + 0.5;
  if (bci.z > 0.5) { v = 1.0 - v; }
  return clamp(v, 0.0, 1.0);
}

// Photoshop texture modes operating on brush coverage a with texture
// value v and strength depth. Order matches TEXTURE_BLEND_INDEX.
fn applyTexToAlpha(a: f32, v: f32, mode: u32, depth: f32) -> f32 {
  switch (mode) {
    case 0u: { return a * mix(1.0, v, depth); }                      // multiply
    case 1u: { return clamp(a - (1.0 - v) * depth, 0.0, 1.0); }      // subtract
    case 2u: { return min(a, mix(1.0, v, depth)); }                  // darken
    case 3u: {                                                       // overlay
      var o: f32;
      if (a <= 0.5) { o = 2.0 * a * v; }
      else { o = 1.0 - 2.0 * (1.0 - a) * (1.0 - v); }
      return mix(a, clamp(o, 0.0, 1.0), depth);
    }
    case 4u: { return clamp(a - (1.0 - v) * depth * 1.5, 0.0, 1.0); } // height
    case 5u: { return mix(a, max(a, v), depth); }                    // lighten
    case 6u: { return mix(a, a + v - a * v, depth); }                // screen
    case 7u: {                                                       // color dodge
      var o: f32;
      if (a <= 0.0) { o = 0.0; }
      else if (v >= 1.0) { o = 1.0; }
      else { o = min(1.0, a / (1.0 - v)); }
      return mix(a, o, depth);
    }
    case 8u: {                                                       // color burn
      var o: f32;
      if (a >= 1.0) { o = 1.0; }
      else if (v <= 0.0) { o = 0.0; }
      else { o = 1.0 - min(1.0, (1.0 - a) / v); }
      return mix(a, o, depth);
    }
    case 9u: { return mix(a, clamp(a + v - 1.0, 0.0, 1.0), depth); } // linear burn
    case 10u: { return mix(a, step(1.0, a + v), depth); }            // hard mix
    default: { return a; }
  }
}

// Dual Brush gate: applied ONCE to the stroke's ACCUMULATED coverage when
// it merges into the layer (compositor preview + commit) — never per dab.
// Gating each dab and then accumulating overlapping low-flow dabs averages
// the mask's texture away (soft dilated blobs); gating the accumulated
// stroke preserves the secondary tip's marks crisply, which is what
// Photoshop renders (validated against Size_Flow_Gang.abr "06 Gritty" at
// 5% flow). Two guards on the texture math: the stroke must never escape
// the dual train's marks (applyTexToAlpha's color-burn case lets a >= 1
// pixels through any mask), and where the stroke has no coverage nothing
// paints (additive modes like screen/lighten would otherwise draw the raw
// mask onto the layer).
fn applyDualToAlpha(a: f32, v: f32, mode: u32) -> f32 {
  if (a <= 0.0) { return 0.0; }
  if (mode == 8u && v <= 0.0) { return 0.0; }
  return applyTexToAlpha(a, v, mode, 1.0);
}

// Wet edges: interior settles at ~60% while the rim stays strong.
fn wetRemap(a: f32) -> f32 {
  return clamp(0.6 * a + 0.4 * sin(3.14159265 * a), 0.0, 1.0);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}
`;

/**
 * Stroke-into-layer merge, shared by the compositor (live preview) and the
 * commit pass. Requires BLEND_LIB (compositePixel) and TEX_LIB.
 */
const MERGE_LIB = /* wgsl */ `
// Stroke -> layer merge parameters. Embedded verbatim in the compositor's
// LayerU and the commit pass's CommitU, and written by the engine's single
// fillMergeFields helper — keep the three in sync.
struct MergeU {
  blend: u32,        // stroke blend mode
  opacity: f32,      // stroke-level opacity cap
  wetEdges: f32,
  texOn: f32,        // whole-stroke texture enabled
  texScalePx: f32,
  texMode: u32,
  dualOn: f32,
  dualMode: u32,
  texBCI: vec4f,     // brightness, contrast, invert, depth
}

/**
 * Merges the live/committing stroke into a premultiplied layer pixel.
 * st: premultiplied stroke texel. patRaw: raw pattern sample (whole-stroke
 * texture, i.e. Texture with "texture each tip" off). dualV: the dual-brush
 * coverage mask sample — the Dual Brush gate applies here, once, to the
 * accumulated stroke (see applyDualToAlpha). lockAlpha is Photoshop's Lock
 * Transparent Pixels: paint is confined to existing coverage and the alpha
 * channel never changes.
 */
fn strokeMergeApply(
  l: vec4f,
  st: vec4f,
  patRaw: f32,
  dualV: f32,
  mode: u32,        // 1 = paint, 2 = erase
  lockAlpha: f32,
  m: MergeU,
) -> vec4f {
  var cov = st.a;
  if (m.dualOn > 0.5) {
    cov = applyDualToAlpha(cov, dualV, m.dualMode);
  }
  if (m.texOn > 0.5) {
    cov = applyTexToAlpha(cov, texValue(patRaw, m.texBCI), m.texMode, m.texBCI.w);
  }
  if (m.wetEdges > 0.5) {
    cov = wetRemap(cov);
  }
  let sa = cov * m.opacity;
  if (mode == 2u) {
    if (lockAlpha > 0.5) { return l; }
    return l * (1.0 - sa);
  }
  var cs = vec3f(0.0);
  if (st.a > 0.0) { cs = st.rgb / st.a; }
  if (lockAlpha > 0.5) {
    if (l.a <= 0.0) { return l; }
    let cb = l.rgb / l.a;
    let cnew = mix(cb, blendPixel(m.blend, cb, cs), sa);
    return vec4f(cnew * l.a, l.a);
  }
  return compositePixel(l, cs, sa, m.blend);
}
`;

/**
 * Composites one layer over the accumulated backdrop. The in-progress stroke
 * (brush or eraser) is merged into the active layer on the fly so painting
 * previews live under the correct blend mode / opacity / texture.
 */
export const COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VS}
${BLEND_LIB}
${TEX_LIB}
${MERGE_LIB}

struct LayerU {
  blendMode: u32,      // layer blend mode
  layerOpacity: f32,
  strokeMode: u32,     // 0 = none, 1 = paint, 2 = erase
  lockAlpha: f32,      // Lock Transparent Pixels on the stroked layer
  docSize: vec2f,
  _p1: vec2f,
  merge: MergeU,       // valid when strokeMode != 0
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var accumTex: texture_2d<f32>;
@group(0) @binding(2) var layerTex: texture_2d<f32>;
@group(0) @binding(3) var strokeTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> U: LayerU;
@group(0) @binding(5) var patternTex: texture_2d<f32>;
@group(0) @binding(6) var repeatSamp: sampler;
@group(0) @binding(7) var dualTex: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let dst = textureSampleLevel(accumTex, samp, in.uv, 0.0);
  var l = textureSampleLevel(layerTex, samp, in.uv, 0.0);

  if (U.strokeMode != 0u) {
    let st = textureSampleLevel(strokeTex, samp, in.uv, 0.0);
    let patUv = in.uv * U.docSize / max(U.merge.texScalePx, 1.0);
    let patRaw = textureSampleLevel(patternTex, repeatSamp, patUv, 0.0).r;
    let dualV = textureSampleLevel(dualTex, samp, in.uv, 0.0).r;
    l = strokeMergeApply(l, st, patRaw, dualV, U.strokeMode, U.lockAlpha, U.merge);
  }

  let as_ = l.a * U.layerOpacity;
  var cs = vec3f(0.0);
  if (l.a > 0.0) { cs = l.rgb / l.a; }
  return compositePixel(dst, cs, as_, U.blendMode);
}
`;

/**
 * Brush stamp: an instanced quad per dab, accumulated OVER into the
 * premultiplied stroke texture so flow builds up where stamps overlap but
 * saturates at 1. Supports rotated/elliptical analytic round tips (with the
 * Gaussian hardness falloff) and sampled texture tips, per-stamp color
 * (Color Dynamics), per-stamp texture (Texture Each Tip), noise, and
 * selection clipping. Dual Brush stamps render through this same shader
 * into the coverage mask; the gate itself applies at merge time.
 */
export const STAMP_SHADER = /* wgsl */ `
${TEX_LIB}

struct StampU {
  docSize: vec2f,
  hardness: f32,
  tipTextured: f32,
  texEach: f32,
  texScalePx: f32,
  noise: f32,
  texMode: u32,
  texBCI: vec4f,       // brightness, contrast, invert, depth
  _p0: vec2f,
  _p1: vec2f,
}

@group(0) @binding(0) var<uniform> SU: StampU;
@group(0) @binding(1) var selTex: texture_2d<f32>;
@group(0) @binding(2) var clampSamp: sampler;
@group(0) @binding(3) var tipTex: texture_2d<f32>;
@group(0) @binding(4) var patternTex: texture_2d<f32>;
@group(0) @binding(5) var repeatSamp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) tipPos: vec2f,   // tip space: unit circle
  @location(1) docPos: vec2f,
  @location(2) alpha: f32,
  @location(3) radius: f32,
  @location(4) color: vec3f,
  @location(5) flags: f32,
  @location(6) depthScale: f32,
}

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) center: vec2f,
  @location(1) radius: f32,
  @location(2) alpha: f32,
  @location(3) angle: f32,
  @location(4) roundness: f32,
  @location(5) color: vec3f,
  @location(6) flags: f32,
  @location(7) depthScale: f32,
) -> VSOut {
  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];
  let pad = radius + 1.0; // 1px apron for the anti-aliased rim
  let off = vec2f(c.x * pad, c.y * pad * roundness);
  let ca = cos(angle);
  let sa = sin(angle);
  let doc = center + vec2f(off.x * ca - off.y * sa, off.x * sa + off.y * ca);
  var out: VSOut;
  out.tipPos = c * pad / max(radius, 1e-4);
  out.docPos = doc;
  var ndc = doc / SU.docSize * 2.0 - 1.0;
  ndc.y = -ndc.y;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.alpha = alpha;
  out.radius = radius;
  out.color = color;
  out.flags = flags;
  out.depthScale = depthScale;
  return out;
}

fn roundProfile(r: f32, hardness: f32, radiusPx: f32) -> f32 {
  if (r >= 1.0) { return 0.0; }
  // Keep at least ~1.6 physical pixels of falloff so hard brushes stay
  // anti-aliased (Photoshop's 100%-hardness tip has the same soft rim).
  let h = min(hardness, max(0.0, 1.0 - 1.6 / max(radiusPx, 1.6)));
  if (r <= h) { return 1.0; }
  let t = (r - h) / (1.0 - h);
  // Gaussian falloff rescaled to hit zero at the radius. k = ln(50) puts the
  // unscaled tail at 2% — the closest published fit to Photoshop's soft round.
  let k = 3.912;
  return (exp(-k * t * t) - exp(-k)) / (1.0 - exp(-k));
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  var a: f32;
  if (SU.tipTextured > 0.5) {
    var uv = in.tipPos * 0.5 + vec2f(0.5);
    let f = u32(in.flags + 0.5);
    if ((f & 1u) != 0u) { uv.x = 1.0 - uv.x; }
    if ((f & 2u) != 0u) { uv.y = 1.0 - uv.y; }
    a = textureSampleLevel(tipTex, clampSamp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).r;
    // hide the apron outside the tip square
    if (abs(in.tipPos.x) > 1.0 || abs(in.tipPos.y) > 1.0) { a = 0.0; }
  } else {
    a = roundProfile(length(in.tipPos), SU.hardness, in.radius);
  }
  a = a * in.alpha;

  if (SU.texEach > 0.5) {
    let v = texValue(
      textureSampleLevel(patternTex, repeatSamp, in.docPos / max(SU.texScalePx, 1.0), 0.0).r,
      SU.texBCI,
    );
    a = applyTexToAlpha(a, v, SU.texMode, SU.texBCI.w * in.depthScale);
  }
  if (SU.noise > 0.5) {
    let n = hash21(floor(in.docPos * 2.0));
    a = a * mix(1.0, n, clamp(1.0 - a, 0.0, 1.0));
  }
  a = a * textureSampleLevel(selTex, clampSamp, in.docPos / SU.docSize, 0.0).r;
  return vec4f(in.color * a, a);
}
`;

/**
 * Bakes the finished stroke into the layer (rendered into a scratch texture,
 * then copied back). Same merge math as the compositor preview.
 */
export const COMMIT_SHADER = /* wgsl */ `
${FULLSCREEN_VS}
${BLEND_LIB}
${TEX_LIB}
${MERGE_LIB}

struct CommitU {
  mode: u32,           // 1 = paint, 2 = erase
  lockAlpha: f32,      // Lock Transparent Pixels
  docSize: vec2f,
  merge: MergeU,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var strokeTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: CommitU;
@group(0) @binding(4) var patternTex: texture_2d<f32>;
@group(0) @binding(5) var repeatSamp: sampler;
@group(0) @binding(6) var dualTex: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let l = textureSampleLevel(layerTex, samp, in.uv, 0.0);
  let st = textureSampleLevel(strokeTex, samp, in.uv, 0.0);
  let patUv = in.uv * U.docSize / max(U.merge.texScalePx, 1.0);
  let patRaw = textureSampleLevel(patternTex, repeatSamp, patUv, 0.0).r;
  let dualV = textureSampleLevel(dualTex, samp, in.uv, 0.0).r;
  return strokeMergeApply(l, st, patRaw, dualV, U.mode, U.lockAlpha, U.merge);
}
`;

/**
 * Selection fill / clear: writes an opaque color (mode 1) or transparency
 * (mode 2) into the layer wherever the selection mask covers, leaving other
 * pixels untouched. Rendered into the scratch texture and copied back, like
 * the commit pass.
 */
export const FILL_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct FillU {
  color: vec4f,   // premultiplied fill color
  mode: u32,      // 1 = fill, 2 = erase
  lockAlpha: f32, // Lock Transparent Pixels: alpha never changes
  _p1: f32,
  _p2: f32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var selTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: FillU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let l = textureSampleLevel(layerTex, samp, in.uv, 0.0);
  let cov = textureSampleLevel(selTex, samp, in.uv, 0.0).r;
  if (U.lockAlpha > 0.5) {
    // fill only the existing coverage; clears cannot touch locked alpha
    if (U.mode == 2u || l.a <= 0.0) { return l; }
    let cnew = mix(l.rgb / l.a, U.color.rgb, cov);
    return vec4f(cnew * l.a, l.a);
  }
  if (U.mode == 2u) {
    return l * (1.0 - cov);
  }
  return mix(l, U.color, cov);
}
`;

/**
 * Layer transform (move / free transform / image & canvas resize): samples a
 * pristine source texture through an inverse homography (destination doc px
 * -> source px) and writes into the target layer. Modes:
 *   - hasSel: only the selected pixels float and transform; the rest of the
 *     layer stays put (unless duplicate, which keeps the original too).
 *   - bgFill: composites the result over an opaque color (Background layer).
 */
export const TRANSFORM_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct TransformU {
  row0: vec4f,      // inverse homography, rows (dst -> src)
  row1: vec4f,
  row2: vec4f,
  dstSize: vec2f,
  srcSize: vec2f,
  flags: vec4f,     // x = hasSel, y = duplicate, z = bgFill
  bgColor: vec4f,   // premultiplied opaque fill
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var selTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: TransformU;

fn srcAt(p: vec2f) -> vec4f {
  if (p.x < 0.0 || p.y < 0.0 || p.x >= U.srcSize.x || p.y >= U.srcSize.y) {
    return vec4f(0.0);
  }
  return textureSampleLevel(srcTex, samp, p / U.srcSize, 0.0);
}

fn selAt(p: vec2f, size: vec2f) -> f32 {
  if (p.x < 0.0 || p.y < 0.0 || p.x >= size.x || p.y >= size.y) {
    return 0.0;
  }
  return textureSampleLevel(selTex, samp, p / size, 0.0).r;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let p = in.uv * U.dstSize;
  let w = U.row2.x * p.x + U.row2.y * p.y + U.row2.z;
  let iw = select(1.0 / w, 0.0, abs(w) < 1e-12);
  let q = vec2f(
    (U.row0.x * p.x + U.row0.y * p.y + U.row0.z) * iw,
    (U.row1.x * p.x + U.row1.y * p.y + U.row1.z) * iw,
  );

  var out: vec4f;
  if (U.flags.x > 0.5) {
    // float only the selected pixels
    let src = srcAt(q) * selAt(q, U.srcSize);
    var rem = srcAt(p);
    if (U.flags.y < 0.5) {
      rem = rem * (1.0 - selAt(p, U.srcSize)); // cut the original
    }
    out = src + rem * (1.0 - src.a);
  } else {
    let src = srcAt(q);
    if (U.flags.y > 0.5) {
      out = src + srcAt(p) * (1.0 - src.a);
    } else {
      out = src;
    }
  }
  if (U.flags.z > 0.5) {
    out = out + U.bgColor * (1.0 - out.a);
  }
  return out;
}
`;

/**
 * Final present pass: applies the viewport transform, draws the transparency
 * checkerboard under the document and the pasteboard around it.
 */
export const PRESENT_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct ViewU {
  viewSize: vec2f,
  docSize: vec2f,
  offset: vec2f,
  zoom: f32,
  nearest: f32,
  checker: f32,
  _pad: vec3f,
}

@group(0) @binding(0) var sampLinear: sampler;
@group(0) @binding(1) var sampNearest: sampler;
@group(0) @binding(2) var accumTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: ViewU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let screen = in.uv * U.viewSize;
  let doc = (screen - U.offset) / U.zoom;
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= U.docSize.x || doc.y >= U.docSize.y) {
    return vec4f(0.118, 0.118, 0.125, 1.0); // pasteboard
  }
  let uv = doc / U.docSize;
  let cLin = textureSampleLevel(accumTex, sampLinear, uv, 0.0);
  let cNear = textureSampleLevel(accumTex, sampNearest, uv, 0.0);
  let c = select(cLin, cNear, U.nearest > 0.5);
  // screen-fixed transparency checkerboard
  let cell = floor(screen / U.checker);
  let odd = (cell.x + cell.y) - 2.0 * floor((cell.x + cell.y) / 2.0);
  let check = select(0.78, 0.62, odd > 0.5);
  return vec4f(c.rgb + vec3f(check) * (1.0 - c.a), 1.0);
}
`;
