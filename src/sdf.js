// Signed distance fields from antialiased coverage masks (package 9).
// Pure JS, no DOM: imported by src/text.js (ctx.text.sdfTexture) and src/shots/_sys.js
// (glyphSDF), and importable from Node.
//
// sdfFromAlpha(alpha, w, h) -> Float32Array: distance in source px to the 0.5-coverage
// edge, NEGATIVE inside, same (row 0 = top) order as the input. Accuracy against
// analytic shapes: mean |error| ~0.04 px, max ~0.3 px (at sharp corners); no jump at
// the zero crossing (slope 1 across the edge).

// Distance (px) from a pixel centre to the edge through it, from its coverage a and the
// unit coverage gradient (gx, gy) (Gustavson & Strand 2011, "edtaa"). >0 when a < 0.5.
function edgedf(gx, gy, a) {
  if (gx === 0 || gy === 0) return 0.5 - a;
  gx = Math.abs(gx); gy = Math.abs(gy);
  if (gx < gy) { const t = gx; gx = gy; gy = t; }
  const a1 = 0.5 * gy / gx;
  if (a < a1) return 0.5 * (gx + gy) - Math.sqrt(2 * gx * gy * a);
  if (a < 1 - a1) return (0.5 - a) * gx;
  return -0.5 * (gx + gy) + Math.sqrt(2 * gx * gy * (1 - a));
}

/**
 * Signed distance field of an antialiased coverage mask, accurate to ~0.05 px.
 * alpha: Float32Array (w·h, row 0 = TOP, canvas order), 0..1.
 * Returns Float32Array (w·h, same order): distance in source px to the 0.5-coverage edge,
 * NEGATIVE inside (1e4 where the mask has no edge at all). Sub-pixel edge points from
 * coverage + Sobel normal, then nearest-edge-point propagation: `rounds` passes (default 1)
 * of one forward and one backward 8-neighbour raster sweep.
 */
const NBX = [1, -1, 0, 0], NBY = [0, 0, 1, -1];
export function sdfFromAlpha(alpha, w, h, rounds = 1) {
  const N = w * h, BIG = 1e30;
  const sx = new Float64Array(N).fill(BIG), sy = new Float64Array(N).fill(BIG), d2 = new Float64Array(N).fill(BIG);
  const A = (x, y) => alpha[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const S2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = alpha[i];
      if (a > 0 && a < 1) {
        const gx = (A(x + 1, y - 1) + S2 * A(x + 1, y) + A(x + 1, y + 1)) - (A(x - 1, y - 1) + S2 * A(x - 1, y) + A(x - 1, y + 1));
        const gy = (A(x - 1, y + 1) + S2 * A(x, y + 1) + A(x + 1, y + 1)) - (A(x - 1, y - 1) + S2 * A(x, y - 1) + A(x + 1, y - 1));
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-9) {
          const nx = gx / gl, ny = gy / gl, df = edgedf(nx, ny, a);
          sx[i] = x + 0.5 + nx * df; sy[i] = y + 0.5 + ny * df; d2[i] = df * df;
        } else { sx[i] = x + 0.5; sy[i] = y + 0.5; d2[i] = 0; }
      } else {
        // hard pixel next to a hard pixel of the other class: the edge is on their shared side
        const inside = a >= 0.5;
        for (let k = 0; k < 4; k++) {
          const dx = NBX[k], dy = NBY[k], xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const b = alpha[yy * w + xx];
          if ((b >= 0.5) !== inside && (b <= 0 || b >= 1)) { sx[i] = x + 0.5 + 0.5 * dx; sy[i] = y + 0.5 + 0.5 * dy; d2[i] = 0.25; break; }
        }
      }
    }
  }
  const test = (i, px, py, j) => {
    const X = sx[j]; if (X === BIG) return;
    const dx = px - X, dy = py - sy[j], dd = dx * dx + dy * dy;
    if (dd < d2[i]) { d2[i] = dd; sx[i] = X; sy[i] = sy[j]; }
  };
  for (let round = 0; round < rounds; round++) {
    for (let y = 0; y < h; y++) {
      const py = y + 0.5;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, px = x + 0.5;
        if (y > 0) { if (x > 0) test(i, px, py, i - w - 1); test(i, px, py, i - w); if (x < w - 1) test(i, px, py, i - w + 1); }
        if (x > 0) test(i, px, py, i - 1);
      }
      for (let x = w - 2; x >= 0; x--) test(y * w + x, x + 0.5, py, y * w + x + 1);
    }
    for (let y = h - 1; y >= 0; y--) {
      const py = y + 0.5;
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x, px = x + 0.5;
        if (y < h - 1) { if (x < w - 1) test(i, px, py, i + w + 1); test(i, px, py, i + w); if (x > 0) test(i, px, py, i + w - 1); }
        if (x < w - 1) test(i, px, py, i + 1);
      }
      for (let x = 1; x < w; x++) test(y * w + x, x + 0.5, py, y * w + x - 1);
    }
  }
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = d2[i] >= BIG ? 1e4 : Math.sqrt(d2[i]);
    out[i] = alpha[i] >= 0.5 ? -d : d;
  }
  return out;
}
