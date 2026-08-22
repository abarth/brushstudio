import type { EngineStrokeParams } from '../gpu/engine';
import { getPattern } from './patterns';
import type { BrushSettings } from './types';

/** Maps full brush settings to the per-stroke parameters the GPU needs. */
export function engineStrokeParams(
  s: BrushSettings,
  mode: 'paint' | 'erase',
): EngineStrokeParams {
  return {
    mode,
    opacity: s.opacity,
    blendMode: mode === 'erase' ? 'normal' : s.blendMode,
    hardness: s.tip.hardness,
    tipShape: s.tip.shape,
    wetEdges: s.wetEdges,
    noise: s.noise,
    texture: s.texture.enabled
      ? {
          pattern: s.texture.pattern,
          // scale is relative to the pattern's native size, like Photoshop
          scalePx: getPattern(s.texture.pattern).size * s.texture.scale,
          brightness: s.texture.brightness,
          contrast: s.texture.contrast,
          invert: s.texture.invert,
          depth: s.texture.depth,
          mode: s.texture.mode,
          eachTip: s.texture.textureEachTip,
        }
      : null,
    dual: s.dual.enabled ? s.dual : null,
    lockTransparent: false, // set by the caller from the layer's locks
  };
}
