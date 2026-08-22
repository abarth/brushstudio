import type { Point } from '../types';

/**
 * 3x3 homography helpers for the transform tools. Matrices are row-major
 * (9 entries) and act on column vectors: p' = M · (x, y, 1), followed by a
 * perspective divide. Affine transforms are just homographies whose last row
 * is (0, 0, 1), so scale/rotate/skew/distort/perspective all share one path.
 */
export type Mat3 = number[];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function apply(m: Mat3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 0;
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) * iw,
    y: (m[3] * p.x + m[4] * p.y + m[5]) * iw,
  };
}

export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

export function translation(dx: number, dy: number): Mat3 {
  return [1, 0, dx, 0, 1, dy, 0, 0, 1];
}

export function scaleAbout(sx: number, sy: number, cx: number, cy: number): Mat3 {
  return [sx, 0, cx - sx * cx, 0, sy, cy - sy * cy, 0, 0, 1];
}

export function rotationAbout(angle: number, cx: number, cy: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
}

/**
 * Solves the homography that maps the four `src` points onto the four `dst`
 * points (direct linear transform, gaussian elimination with partial
 * pivoting). Returns null for degenerate quads.
 */
export function homographyFromQuads(src: Point[], dst: Point[]): Mat3 | null {
  // 8 unknowns h0..h7 (h8 = 1): two equations per correspondence.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}
