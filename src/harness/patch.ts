import { defaultBrush } from '../brush/defaults';
import type { BrushPatch, BrushSettings } from '../brush/types';

/**
 * Reduces a full settings object to the smallest patch that reproduces it.
 *
 * Studying someone else's .abr is mostly a search for the few values that
 * make it distinctive; a full dump buries those in fifty defaults. What
 * comes out of here can be pasted straight into a brush document.
 */
export function diffFromDefaults(settings: BrushSettings): BrushPatch {
  const base = defaultBrush() as unknown as Record<string, unknown>;
  const full = settings as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(full)) {
    const baseValue = base[key];
    if (value !== null && typeof value === 'object') {
      const section: Record<string, unknown> = {};
      const baseSection = (baseValue ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (JSON.stringify(v) !== JSON.stringify(baseSection[k])) section[k] = v;
      }
      // an enabled section is worth spelling out even when nothing else moved
      if (Object.keys(section).length > 0) {
        if ('enabled' in (value as Record<string, unknown>)) {
          section.enabled = (value as Record<string, unknown>).enabled;
        }
        out[key] = section;
      }
    } else if (value !== baseValue) {
      out[key] = value;
    }
  }
  return out as BrushPatch;
}
