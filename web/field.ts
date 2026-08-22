/**
 * A number you can drag or type.
 *
 * A slider is the wrong instrument for the last 5% of a decision: a 160px
 * track spanning 1–600px of tip size moves three pixels of diameter per
 * pixel of travel, so "make it 120" is not reachable by dragging. The track
 * stays, because seeing where a value sits in its range is most of what a
 * panel is for — but the readout beside it is the instrument: drag it for
 * fine adjustment, click it and type for an exact one.
 */

export interface FieldSpec {
  min: number;
  max: number;
  step: number;
  /** stored 0..1 (or -1..1), shown and typed as a percentage */
  pct?: boolean;
  get: () => number;
  set: (v: number) => void;
  /** run once the value has landed */
  commit: () => void;
}

export interface Field {
  node: HTMLInputElement;
  /** pull the displayed text back from the value, unless it is being typed */
  sync: () => void;
}

const round = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(6));

export function numberField(spec: FieldSpec): Field {
  const node = document.createElement('input');
  node.type = 'text';
  node.className = 'num';
  node.inputMode = 'decimal';
  node.spellcheck = false;
  node.title = 'drag to adjust, click to type';

  const show = (v: number) =>
    spec.pct ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100);

  /**
   * A percentage field is typed in percent: what is on screen is what you
   * type back, so "35" in a field reading "35%" means 0.35 and not 0.0035.
   */
  const parse = (text: string): number | null => {
    const n = Number(text.replace(/[%\s]/g, ''));
    if (!Number.isFinite(n)) return null;
    return spec.pct ? n / 100 : n;
  };

  const clamp = (v: number) => Math.min(spec.max, Math.max(spec.min, round(v, spec.step)));

  const apply = (v: number) => {
    spec.set(clamp(v));
    spec.commit();
  };

  let typing = false;
  const sync = () => {
    if (typing) return;
    const text = show(spec.get());
    if (node.value !== text) node.value = text;
  };
  sync();

  // one drag across the field's own width should not span the whole range;
  // half a step per pixel is fine control, widened only when the range is
  // too broad to reach in a screen's worth of travel
  const perPx = Math.max(spec.step / 2, (spec.max - spec.min) / 600);

  let from = 0;
  let at = 0;
  let dragged = false;
  node.addEventListener('pointerdown', (e) => {
    if (typing) return; // already in the field: let the caret work
    e.preventDefault(); // no focus, no text selection — this is a drag handle
    node.setPointerCapture(e.pointerId);
    from = spec.get();
    at = e.clientX;
    dragged = false;
  });
  node.addEventListener('pointermove', (e) => {
    if (!node.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - at;
    if (!dragged && Math.abs(dx) < 3) return;
    dragged = true;
    apply(from + dx * perPx * (e.shiftKey ? 0.2 : 1));
    sync();
  });
  node.addEventListener('pointerup', (e) => {
    node.releasePointerCapture(e.pointerId);
    if (dragged) return;
    // a click that did not move is a request to type
    typing = true;
    node.focus();
    node.select();
  });

  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      node.blur();
      return;
    }
    if (e.key === 'Escape') {
      typing = false;
      sync();
      node.blur();
      return;
    }
    const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    apply(spec.get() + dir * spec.step * (e.shiftKey ? 10 : 1));
    typing = false;
    sync();
    typing = true;
  });

  node.addEventListener('blur', () => {
    typing = false;
    const v = parse(node.value);
    if (v !== null) apply(v);
    sync();
  });

  return { node, sync };
}
