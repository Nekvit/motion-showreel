// full-stop helpers: glyph SDF atlas (the name at wght masters 700/750/800/850/875/900, with a CPU
// twin of the shader lookup for layout checks) and the role/year print atlas.
//
// The name is rendered in GLSL from signed distance fields, one per letter and weight, so every
// glyph can be drawn at its live weight about its fixed ink centre (§5.8 Build) with exact
// antialiasing, exact window clipping and exact 3px inner rims. wght 850 is _sys.glyphSDF's own
// field (cropped, so the rest pose is bit-for-bit the system's); the other masters are rasterised the
// same way (same em size, same 360px cap raster, integer pen, _sys.sdfFromAlpha) so all fields are
// registered to the same pen origin. A live weight w is the linear blend of the two neighbouring
// masters (outlines of a variable font interpolate linearly; the blend of two nearby SDFs is the SDF
// of the interpolated outline to first order).
import * as sys from '../_sys.js';

export const CAPPX = sys.GLYPH_CAP_PX;          // 360: raster cap height of every field
export const WEIGHTS = [700, 750, 800, 850, 875, 900];   // masters: blend spans move an edge ≤ 2.7px (no visible corner rounding)
const PAD = Math.ceil(0.12 * CAPPX);              // crop padding around the ink box (texture px)

// Ink extents (texture px) from the SDF zero set, exactly like _sys.buildGlyphCPU: the first
// column/row with ink, refined by the distance of a sample 3px outside it.
function inkExtents(data, w, h) {
  const colMin = new Float32Array(w).fill(Infinity), rowMin = new Float32Array(h).fill(Infinity);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = data[y * w + x]; if (d < colMin[x]) colMin[x] = d; if (d < rowMin[y]) rowMin[y] = d; }
  const ext = (arr, n, dir) => {
    let k = dir > 0 ? 0 : n - 1;
    while (k >= 0 && k < n && arr[k] > 0) k += dir;
    if (k < 0 || k >= n) return null;
    const o = k - 3 * dir;
    return dir > 0 ? (o + 0.5) + arr[o] : (o + 0.5) - arr[o];
  };
  return { X0: ext(colMin, w, 1), X1: ext(colMin, w, -1), Y0: ext(rowMin, h, 1), Y1: ext(rowMin, h, -1) };
}

// _sys's 850 field, cropped to the ink box + PAD (GL order, row 0 = bottom).
function crop850(m) {
  const x0 = Math.max(0, Math.floor(m.ox + m.inkX0 * CAPPX) - PAD), x1 = Math.min(m.w, Math.ceil(m.ox + m.inkX1 * CAPPX) + PAD);
  const y0 = Math.max(0, Math.floor(m.oy + m.inkY0 * CAPPX) - PAD), y1 = Math.min(m.h, Math.ceil(m.oy + m.inkY1 * CAPPX) + PAD);
  const w = x1 - x0, h = y1 - y0, data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) data.set(m.data.subarray((y + y0) * m.w + x0, (y + y0) * m.w + x1), y * w);
  return { w, h, data, ox: m.ox - x0, oy: m.oy - y0, inkCx: m.inkCx, inkX0: m.inkX0, inkX1: m.inkX1 };
}

// Rasterise `ch` at Archivo `weight`/100 at the 850 field's em size, integer pen, crop, SDF.
function rasterField(ctx, ch, weight, sizePx) {
  const fs = ctx.text.font({ family: 'Archivo', weight, width: 100, size: sizePx });
  const mg = document.createElement('canvas').getContext('2d');
  mg.font = fs;
  const adv = mg.measureText(ch).width;
  const MX = Math.ceil(0.6 * CAPPX), BY = Math.ceil(1.9 * CAPPX);
  const W0 = Math.ceil(adv) + 2 * MX, H0 = BY + Math.ceil(0.7 * CAPPX);
  const c = document.createElement('canvas'); c.width = W0; c.height = H0;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = fs; g.fillStyle = '#fff'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillText(ch, MX, BY);
  const img = g.getImageData(0, 0, W0, H0).data;
  let bx0 = W0, bx1 = -1, by0 = H0, by1 = -1;
  for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) if (img[(y * W0 + x) * 4 + 3] > 0) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < 0) { bx0 = MX; bx1 = MX; by0 = BY - 1; by1 = BY - 1; }
  const cx0 = Math.max(0, bx0 - PAD), cy0 = Math.max(0, by0 - PAD), cx1 = Math.min(W0, bx1 + 1 + PAD), cy1 = Math.min(H0, by1 + 1 + PAD);
  const w = cx1 - cx0, h = cy1 - cy0, alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = img[((y + cy0) * W0 + (x + cx0)) * 4 + 3] / 255;
  const sdfC = sys.sdfFromAlpha(alpha, w, h);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) data.set(sdfC.subarray((h - 1 - y) * w, (h - y) * w), y * w);
  const ox = MX - cx0, oy = h - (BY - cy0);
  const e = inkExtents(data, w, h);
  const inkX0 = (e.X0 - ox) / CAPPX, inkX1 = (e.X1 - ox) / CAPPX;
  return { w, h, data, ox, oy, inkCx: 0.5 * (inkX0 + inkX1), inkX0, inkX1 };
}

// Atlas of every (letter, weight) field, shelf-packed into one R16F texture (linear, clamp).
// Returns {tex, W, H, slot(ch, weight) → {x0, y0, x1, y1, penX, penY, inkCx, inkX0, inkX1}}.
export function buildGlyphAtlas(ctx, letters) {
  const gl = ctx.gl;
  const uniq = [...new Set(letters)];
  const fields = [];
  for (const ch of uniq) {
    const m = sys.glyphSDF(ctx, ch);
    for (const wt of WEIGHTS) fields.push({ ch, wt, f: wt === 850 ? crop850(m) : rasterField(ctx, ch, wt, m.sizePx) });
  }
  const MAXW = 4096, GAP = 2;
  let x = 0, y = 0, rowH = 0, W = 0;
  for (const it of fields) {
    if (x + it.f.w > MAXW) { x = 0; y += rowH + GAP; rowH = 0; }
    it.x0 = x; it.y0 = y; x += it.f.w + GAP; rowH = Math.max(rowH, it.f.h); W = Math.max(W, x);
  }
  const H = y + rowH;
  const data = new Float32Array(W * H).fill(64);
  for (const it of fields) for (let r = 0; r < it.f.h; r++) data.set(it.f.data.subarray(r * it.f.w, (r + 1) * it.f.w), (it.y0 + r) * W + it.x0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, W, H, 0, gl.RED, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const map = new Map(), cpu = new Map();
  for (const it of fields) {
    map.set(it.ch + '|' + it.wt, Object.freeze({
      x0: it.x0, y0: it.y0, x1: it.x0 + it.f.w, y1: it.y0 + it.f.h,
      penX: it.x0 + it.f.ox, penY: it.y0 + it.f.oy, inkCx: it.f.inkCx, inkX0: it.f.inkX0, inkX1: it.f.inkX1,
    }));
    cpu.set(it.ch + '|' + it.wt, it.f);
  }
  // CPU twin of the shader's field lookup (bilinear, clamped + distance to the clamp rect), cap
  // units; (qx, qy) from the ink centre and the baseline, like the shader's qc.
  const fieldD = (f, qx, qy) => {
    const px = f.ox + (qx + f.inkCx) * CAPPX, py = f.oy + qy * CAPPX;
    const cx = Math.min(Math.max(px, 0.5), f.w - 0.5), cy = Math.min(Math.max(py, 0.5), f.h - 0.5);
    const fx = cx - 0.5, fy = cy - 0.5;
    const x0 = Math.min(Math.floor(fx), f.w - 2), y0 = Math.min(Math.floor(fy), f.h - 2);
    const tx = fx - x0, ty = fy - y0, i = y0 * f.w + x0, d = f.data;
    const v = (d[i] * (1 - tx) + d[i + 1] * tx) * (1 - ty) + (d[i + f.w] * (1 - tx) + d[i + f.w + 1] * tx) * ty;
    return (v + Math.hypot(px - cx, py - cy)) / CAPPX;
  };
  // signed distance (cap units) to `ch` at live weight w (the same master blend as the shader)
  const dist = (ch, w, qx, qy) => {
    const { wa, wb, k } = blendOf(w);
    const a = fieldD(cpu.get(ch + '|' + wa), qx, qy);
    return k > 0 ? a + (fieldD(cpu.get(ch + '|' + wb), qx, qy) - a) * k : a;
  };
  return { tex, W, H, slot: (ch, wt) => map.get(ch + '|' + wt), dist };
}

// The two neighbouring masters of a live weight and the blend between them.
export function blendOf(w) {
  let j = 0;
  while (j < WEIGHTS.length - 2 && w > WEIGHTS[j + 1]) j++;
  let wa = WEIGHTS[j], wb = WEIGHTS[j + 1], k = (w - wa) / (wb - wa);
  if (k >= 1 - 1e-6) { wa = wb; k = 0; }
  if (k < 1e-6) k = 0;
  return { wa, wb, k };
}

// Role line and year: every glyph in its own row of one canvas, drawn once at its exact final
// sub-pixel screen position (so a row sampled with zero offset is the glyph drawn straight on the
// frame: crisp), white on transparent (alpha = coverage). The shader slides and prints each row.
// Returns {surf, cw, ch, rows: [{kind: 'role'|'year', idx, x0, x1 (screen px), dY (screen y_top −
// canvas y, integer)}]}.
export function buildRoleAtlas(ctx, N) {
  const W = ctx.W, H = ctx.H;
  const toPx = (x, y) => [W / 2 + x * H, H / 2 - y * H];      // screen px, y from the top
  const roleFont = sys.fontPx(ctx, N.role.font, N.role.size);
  const yearFont = sys.fontPx(ctx, N.year.font, N.year.size);
  const items = [];
  N.role.glyphs.forEach((g, k) => { if (g.ch.trim()) items.push({ kind: 'role', idx: k, ch: g.ch, x: g.x, base: N.role.baseline, font: roleFont, em: N.role.size * H }); });
  N.year.glyphs.forEach((g, k) => items.push({ kind: 'year', idx: k, ch: g.ch, x: g.x, base: N.year.baseline, font: yearFont, em: N.year.size * H }));
  const emMax = Math.max(N.role.size, N.year.size) * H;
  const ASC = Math.ceil(1.0 * emMax) + 4, DESC = Math.ceil(0.45 * emMax) + 4, RH = ASC + DESC;
  let xmin = Infinity, xmax = -Infinity;
  for (const it of items) { const [px] = toPx(it.x, it.base); xmin = Math.min(xmin, px - 0.5 * it.em); xmax = Math.max(xmax, px + 1.5 * it.em); }
  const X0 = Math.floor(xmin), cw = Math.ceil(xmax) - X0, ch = RH * items.length;
  const surf = ctx.surface(cw, ch);
  const g = surf.clear();
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const rows = items.map((it, r) => {
    const [px, py] = toPx(it.x, it.base);
    const pyI = Math.floor(py), fy = py - pyI;
    const rowTop = r * RH;
    g.font = it.font;
    g.fillText(it.ch, px - X0, rowTop + ASC + fy);
    const adv = g.measureText(it.ch).width;
    return { kind: it.kind, idx: it.idx, x0: px - 0.45 * it.em, x1: px + adv + 0.45 * it.em, dY: pyI - (rowTop + ASC), rowTop, top: pyI - ASC, bot: pyI + DESC };
  });
  surf.upload();
  return { surf, X0, cw, ch, RH, rows };
}
