import type { BrushPatch, BrushSettings, DynamicControl } from './types';

export const offControl = (): DynamicControl => ({ source: 'off', fadeSteps: 25 });
export const pressureControl = (): DynamicControl => ({ source: 'pressure', fadeSteps: 25 });

export function defaultBrush(): BrushSettings {
  return {
    tip: {
      shape: 'round',
      size: 40,
      hardness: 0,
      angle: 0,
      roundness: 1,
      spacing: 0.25,
      flipX: false,
      flipY: false,
    },
    shape: {
      enabled: false,
      sizeJitter: 0,
      sizeControl: pressureControl(),
      minDiameter: 0,
      angleJitter: 0,
      angleControl: offControl(),
      roundnessJitter: 0,
      roundnessControl: offControl(),
      minRoundness: 0.25,
      flipXJitter: false,
      flipYJitter: false,
    },
    scatter: {
      enabled: false,
      bothAxes: false,
      scatter: 1,
      scatterControl: offControl(),
      count: 1,
      countJitter: 0,
    },
    texture: {
      enabled: false,
      pattern: 'paper',
      scale: 1,
      brightness: 0,
      contrast: 0,
      invert: false,
      mode: 'multiply',
      depth: 1,
      textureEachTip: false,
      depthJitter: 0,
      depthControl: offControl(),
    },
    dual: {
      enabled: false,
      shape: 'spatter',
      hardness: 1,
      mode: 'multiply',
      size: 40,
      spacing: 0.25,
      scatter: 0,
      bothAxes: true,
      count: 1,
      countJitter: 0,
    },
    color: {
      enabled: false,
      applyPerTip: true,
      fgBgJitter: 0,
      fgBgControl: offControl(),
      hueJitter: 0,
      satJitter: 0,
      briJitter: 0,
      purity: 0,
    },
    transfer: {
      enabled: false,
      opacityJitter: 0,
      opacityControl: offControl(),
      opacityMin: 0,
      flowJitter: 0,
      flowControl: offControl(),
      flowMin: 0,
    },
    noise: false,
    wetEdges: false,
    airbrush: false,
    smoothing: 0.15,
    opacity: 1,
    flow: 1,
    blendMode: 'normal',
    pressureSize: false,
    pressureOpacity: false,
  };
}

/** Deep-merges a preset patch over the defaults (one level of nesting). */
export function makeBrush(patch: BrushPatch): BrushSettings {
  return mergeBrush(defaultBrush(), patch);
}

export function mergeBrush(base: BrushSettings, patch: BrushPatch): BrushSettings {
  const baseRec = base as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseRec };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(baseRec[key] as object), ...value };
    } else {
      out[key] = value;
    }
  }
  return out as unknown as BrushSettings;
}
