// volume: an exact polygon for the V, fitted to _sys's glyph SDF (sys.glyphSDF(stationLetter(3))).
//
// The raster SDF is accurate to ≈0.05 texel, but its residual error is periodic along diagonal edges, and a
// metre of glass seen at grazing angles magnifies it into dotted lines and per-row noise. Archivo's V (and
// any glyph built from straight strokes) is a polygon: trace the SDF's zero set (marching squares, sub-texel
// crossings), simplify it (Douglas–Peucker), refit every side by least squares and intersect neighbours for
// the corners. The fit is accepted only if every traced point lies within MAX_ERR texels of the polygon and
// the polygon is small; otherwise null is returned and the shot keeps the (smoothed) texture SDF.
const DP_TOL = 0.12;        // texels
const MAX_ERR = 0.45;       // texels
const MAX_VERTS = 48;

function traceZeroSet(data, w, h) {
  const at = (i, j) => data[j * w + i];
  // crossing on a grid edge: horizontal edge id 2·(j·w + i) between texels (i, j) and (i + 1, j),
  // vertical edge id 2·(j·w + i) + 1 between (i, j) and (i, j + 1). Positions in texel-centre units.
  const pos = new Map();
  const cross = (id) => {
    let p = pos.get(id);
    if (p) return p;
    const k = id >> 1, i = k % w, j = (k - i) / w;
    const a = at(i, j);
    if (id & 1) { const b = at(i, j + 1), t = a / (a - b); p = [i + 0.5, j + 0.5 + t]; }
    else { const b = at(i + 1, j), t = a / (a - b); p = [i + 0.5 + t, j + 0.5]; }
    pos.set(id, p);
    return p;
  };
  const adj = new Map();
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    const v0 = at(i, j) < 0, v1 = at(i + 1, j) < 0, v2 = at(i + 1, j + 1) < 0, v3 = at(i, j + 1) < 0;
    const code = (v0 ? 1 : 0) | (v1 ? 2 : 0) | (v2 ? 4 : 0) | (v3 ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const eB = 2 * (j * w + i), eT = 2 * ((j + 1) * w + i), eL = 2 * (j * w + i) + 1, eR = 2 * (j * w + i + 1) + 1;
    const E = [];
    if (v0 !== v1) E.push(eB);
    if (v1 !== v2) E.push(eR);
    if (v2 !== v3) E.push(eT);
    if (v3 !== v0) E.push(eL);
    if (E.length === 2) link(E[0], E[1]);
    else if (E.length === 4) {             // saddle: decide by the cell centre
      const c = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) < 0;
      if (c === v0) { link(eB, eR); link(eT, eL); } else { link(eB, eL); link(eR, eT); }
    }
  }
  // walk the loops, keep the longest
  const seen = new Set(); let best = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = []; let prev = -1, cur = start;
    for (let guard = 0; guard < 1e6; guard++) {
      seen.add(cur); loop.push(cross(cur));
      const nb = adj.get(cur); const next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined || next === start) break;
      prev = cur; cur = next;
      if (seen.has(cur)) break;
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

function segDist(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
  const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
  return Math.hypot(wx - ex * t, wy - ey * t);
}
function dp(pts, lo, hi, tol, keep) {
  let dm = 0, im = -1;
  for (let i = lo + 1; i < hi; i++) { const d = segDist(pts[i], pts[lo], pts[hi]); if (d > dm) { dm = d; im = i; } }
  if (dm > tol) { keep[im] = true; dp(pts, lo, im, tol, keep); dp(pts, im, hi, tol, keep); }
}

/** Fit the glyph's outline; returns { verts: [[x, y], …] (wu, ink-centred, CCW), maxErr (texels) } or null. */
export function fitGlyphPolygon(meta) {
  const { data, w, h, ox, oy, capPx, inkCx } = meta;
  const pts = traceZeroSet(data, w, h);
  const n = pts.length;
  if (n < 16) return null;
  // Douglas–Peucker on the closed loop, split at the two mutually farthest points
  let i0 = 0, i1 = 0, dmax = 0;
  for (let i = 0; i < n; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > dmax) { dmax = d; i1 = i; } }
  const ring = [...pts.slice(i0), ...pts.slice(0, i0), pts[i0]];
  const keep = new Array(ring.length).fill(false); keep[0] = keep[i1] = keep[ring.length - 1] = true;
  dp(ring, 0, i1, DP_TOL, keep); dp(ring, i1, ring.length - 1, DP_TOL, keep);
  const idx = []; for (let i = 0; i < ring.length - 1; i++) if (keep[i]) idx.push(i);
  if (idx.length < 3 || idx.length > MAX_VERTS) return null;
  // least-squares line per side (inner 80% of its points), corners = neighbouring lines' intersections
  const m = idx.length, lines = [];
  for (let k = 0; k < m; k++) {
    const a = idx[k], b = k + 1 < m ? idx[k + 1] : ring.length - 1;
    const len = b - a, s0 = a + Math.floor(0.1 * len), s1 = b - Math.floor(0.1 * len);
    let cx = 0, cy = 0, c = 0;
    for (let i = s0; i <= s1; i++) { cx += ring[i][0]; cy += ring[i][1]; c++; }
    cx /= c; cy /= c;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = s0; i <= s1; i++) { const dx = ring[i][0] - cx, dy = ring[i][1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);             // principal direction
    lines.push({ cx, cy, dx: Math.cos(th), dy: Math.sin(th) });
  }
  const verts = [];
  for (let k = 0; k < m; k++) {
    const L0 = lines[(k + m - 1) % m], L1 = lines[k];
    const det = L0.dx * L1.dy - L0.dy * L1.dx;
    if (Math.abs(det) < 1e-3) { verts.push(ring[idx[k]].slice()); continue; }
    const t = ((L1.cx - L0.cx) * L1.dy - (L1.cy - L0.cy) * L1.dx) / det;
    verts.push([L0.cx + L0.dx * t, L0.cy + L0.dy * t]);
  }
  // validate against every traced point
  let maxErr = 0;
  for (const p of pts) {
    let d = Infinity;
    for (let k = 0; k < m; k++) d = Math.min(d, segDist(p, verts[k], verts[(k + 1) % m]));
    maxErr = Math.max(maxErr, d);
  }
  if (!(maxErr <= MAX_ERR)) return null;
  // texels → wu (cap units), ink-centred like the shader's sdV2; counter-clockwise
  let V = verts.map(([x, y]) => [(x - ox) / capPx - inkCx, (y - oy) / capPx]);
  let area = 0; for (let k = 0; k < m; k++) { const a = V[k], b = V[(k + 1) % m]; area += a[0] * b[1] - a[1] * b[0]; }
  if (area < 0) V = V.reverse();
  return { verts: dropSlivers(V, 0.006), maxErr };
}

// Remove the fit's sub-texel corner facets and spikes (edges shorter than minLen wu): the two ends of the
// shortest edge merge into the corner of its neighbours' lines (or its midpoint if that corner is far).
// The rounded 0.012 edge hides them on the surface; inside the glass, where the path is traced against the
// exact polygon, they would only scatter rays into single-pixel sparkle.
function dropSlivers(V, minLen) {
  V = V.map(p => p.slice());
  for (let guard = 0; guard < 64 && V.length > 3; guard++) {
    const n = V.length;
    let km = -1, lm = minLen;
    for (let k = 0; k < n; k++) { const a = V[k], b = V[(k + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l < lm) { lm = l; km = k; } }
    if (km < 0) break;
    const p0 = V[(km + n - 1) % n], a = V[km], b = V[(km + 1) % n], p1 = V[(km + 2) % n];
    const d0 = [a[0] - p0[0], a[1] - p0[1]], d1 = [p1[0] - b[0], p1[1] - b[1]];
    const det = d0[0] * d1[1] - d0[1] * d1[0];
    const mid = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
    let c = mid;
    if (Math.abs(det) > 1e-9) {
      const t = ((b[0] - p0[0]) * d1[1] - (b[1] - p0[1]) * d1[0]) / det;
      const q = [p0[0] + d0[0] * t, p0[1] + d0[1] * t];
      if (Math.hypot(q[0] - mid[0], q[1] - mid[1]) < 2 * minLen) c = q;
    }
    V.splice(km, 1, c);
    V.splice((km + 1) % V.length, 1);
  }
  return V;
}

/** GLSL: exact signed distance to the polygon (negative inside) and its gradient; one loop over a uniform
 *  array (uPoly = polyUniform(verts)) keeps the inlined code small and costs no per-call array copy. */
export function polyGlsl(verts) {
  const n = verts.length;
  return `
const int POLY_N = ${n};
uniform vec2 uPoly[${n + 1}];
float sdPolyG(vec2 p, out vec2 g){
  float d = 1e20, s = 1.0; vec2 gq = vec2(0.0, 1.0);
  for (int k = 0; k < POLY_N; k++){
    vec2 a = uPoly[k], e = uPoly[k + 1] - a, w = p - a;
    vec2 q = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0); float dd = dot(q, q);
    if (dd < d) { d = dd; gq = q; }
    bool c0 = p.y >= a.y, c1 = p.y < a.y + e.y, c2 = e.x * w.y > e.y * w.x;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) s = -s;
  }
  float r = sqrt(d);
  g = s * gq / max(r, 1e-9);
  return s * r;
}`;
}
/** The polygon's vertices (closed: the first repeated) as the flat array for uPoly. */
export const polyUniform = verts => [...verts, verts[0]].flat();
