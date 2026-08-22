import type { BrushSettings, DynamicControl } from '../brush/types';

/** Compact one-line summary of what a brush is set to, for plate captions. */
export function describeBrush(s: BrushSettings): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const parts = [
    `${s.tip.shape} ${Math.round(s.tip.size)}px`,
    `hard ${pct(s.tip.hardness)}`,
    `spc ${pct(s.tip.spacing)}`,
    `flow ${pct(s.flow)}`,
    `opac ${pct(s.opacity)}`,
  ];
  if (s.tip.roundness < 1) parts.push(`round ${pct(s.tip.roundness)} @${Math.round(s.tip.angle)}°`);
  if (s.shape.enabled) parts.push(`shape[${s.shape.sizeControl.source}]`);
  if (s.scatter.enabled) parts.push(`scatter ${pct(s.scatter.scatter)}x${s.scatter.count}`);
  if (s.texture.enabled) parts.push(`tex ${s.texture.pattern} ${pct(s.texture.depth)}`);
  if (s.dual.enabled) parts.push(`dual ${s.dual.shape} ${Math.round(s.dual.size)}px`);
  if (s.color.enabled) parts.push('color-dyn');
  if (s.transfer.enabled) parts.push(`transfer[${s.transfer.flowControl.source}]`);
  if (s.wetEdges) parts.push('wet-edges');
  if (s.noise) parts.push('noise');
  if (s.airbrush) parts.push('build-up');
  if (s.blendMode !== 'normal') parts.push(s.blendMode);
  return parts.join(' · ');
}

const ctrl = (c: DynamicControl) => (c.source === 'fade' ? `fade/${c.fadeSteps}` : c.source);

/** The full settings, as the indented block a design note quotes. */
export function explainBrush(s: BrushSettings): string[] {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lines = [
    `tip        ${s.tip.shape} · ${Math.round(s.tip.size)}px · hardness ${pct(s.tip.hardness)} · ` +
      `spacing ${pct(s.tip.spacing)} · angle ${Math.round(s.tip.angle)}° · roundness ${pct(s.tip.roundness)}` +
      `${s.tip.flipX ? ' · flipX' : ''}${s.tip.flipY ? ' · flipY' : ''}`,
    `stroke     flow ${pct(s.flow)} · opacity ${pct(s.opacity)} · blend ${s.blendMode} · ` +
      `smoothing ${pct(s.smoothing)}`,
  ];
  if (s.shape.enabled) {
    lines.push(
      `shape      size ${ctrl(s.shape.sizeControl)} jit ${pct(s.shape.sizeJitter)} min ${pct(s.shape.minDiameter)} · ` +
        `angle ${ctrl(s.shape.angleControl)} jit ${pct(s.shape.angleJitter)} · ` +
        `roundness ${ctrl(s.shape.roundnessControl)} jit ${pct(s.shape.roundnessJitter)} min ${pct(s.shape.minRoundness)}`,
    );
  }
  if (s.scatter.enabled) {
    lines.push(
      `scatter    ${pct(s.scatter.scatter)} ${s.scatter.bothAxes ? 'both axes' : 'across stroke'} · ` +
        `count ${s.scatter.count} jit ${pct(s.scatter.countJitter)} · ${ctrl(s.scatter.scatterControl)}`,
    );
  }
  if (s.texture.enabled) {
    lines.push(
      `texture    ${s.texture.pattern} · scale ${pct(s.texture.scale)} · depth ${pct(s.texture.depth)} · ` +
        `${s.texture.mode}${s.texture.invert ? ' · inverted' : ''}` +
        `${s.texture.textureEachTip ? ` · each tip (jit ${pct(s.texture.depthJitter)}, ${ctrl(s.texture.depthControl)})` : ''}`,
    );
  }
  if (s.dual.enabled) {
    lines.push(
      `dual       ${s.dual.shape} · ${Math.round(s.dual.size)}px · spacing ${pct(s.dual.spacing)} · ` +
        `scatter ${pct(s.dual.scatter)}${s.dual.bothAxes ? ' both axes' : ''} · count ${s.dual.count} · ${s.dual.mode}`,
    );
  }
  if (s.color.enabled) {
    lines.push(
      `color      ${s.color.applyPerTip ? 'per tip' : 'per stroke'} · fg/bg ${pct(s.color.fgBgJitter)} (${ctrl(s.color.fgBgControl)}) · ` +
        `h ${pct(s.color.hueJitter)} s ${pct(s.color.satJitter)} b ${pct(s.color.briJitter)} · purity ${pct(s.color.purity)}`,
    );
  }
  if (s.transfer.enabled) {
    lines.push(
      `transfer   opacity ${ctrl(s.transfer.opacityControl)} jit ${pct(s.transfer.opacityJitter)} min ${pct(s.transfer.opacityMin)} · ` +
        `flow ${ctrl(s.transfer.flowControl)} jit ${pct(s.transfer.flowJitter)} min ${pct(s.transfer.flowMin)}`,
    );
  }
  const toggles = [
    s.noise && 'noise',
    s.wetEdges && 'wet edges',
    s.airbrush && 'build-up',
    s.pressureSize && 'always pressure size',
    s.pressureOpacity && 'always pressure opacity',
  ].filter(Boolean);
  if (toggles.length) lines.push(`toggles    ${toggles.join(' · ')}`);
  return lines;
}
