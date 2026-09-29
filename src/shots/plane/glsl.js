// plane: shaders (DIRECTION.md §5.3).
//
// One full-resolution pass per frame (per MB sample only during the re-layout, whose composition
// moves), plus a scissored SMEAR pass for moving window edges:
//  MAIN  every pixel: the window geometry (at the shutter's end on frames where it moves) and the
//        composition. Moving VERM lines (scanlines, the merge wipe) are drawn as flat streaks
//        over the shutter, the gliding dot as the hull of its start and end discs.
//  SMEAR the band each moving window edge sweeps over the shutter, flat rim colour.
// The geometry composites exactly: windows in draw order (stem > bottom > middle > top),
// each window's scanline, the merge-wipe rim over the union, the union-boundary rim (3px VERM
// straddling the edge, or 1px BONE inside it once the collapse cascade has started) and the
// detached dot on top. It leaves linear weights per (window, state) — ground / own pass /
// BEAUTY behind the wipe / flat BONE — and a premultiplied overlay colour. The composition is then
// evaluated in window space w = (p.x + truck, p.y − yArm), once per group of windows sharing a
// yArm (behind the merge wipe every window is one group at yArm 0): the element SDFs are computed
// once and all three passes (CONTOUR, MATTE, BEAUTY) derived from them.
//
// SwiftShader (the reel's renderer) notes, measured: branches are predicated (both sides always
// run), and every uniform read costs a memory load per pixel, while flat varyings are ~free. So
// the per-sample constants reach the fragment shader as flat varyings from a vertex shader, the
// code is branch-light, and the costly multi-tap path runs only where scissored.

const HULL2 = /* glsl */`
// distance to the convex hull of two discs (a, ra) and (b, rb)
float sdHull2(vec2 p, vec2 a, float ra, vec2 b, float rb){
  vec2 ba = b - a; float h = length(ba);
  if (h <= abs(ra - rb) + 1e-6) return ra > rb ? length(p - a) - ra : length(p - b) - rb;
  vec2 u = ba / h;
  vec2 q = vec2(abs(dot(p - a, vec2(-u.y, u.x))), dot(p - a, u));
  float bb = (ra - rb) / h, aa = sqrt(1.0 - bb * bb);
  float k = dot(q, vec2(-bb, aa));
  return k < 0.0 ? length(q) - ra : (k > aa * h ? length(q - vec2(0.0, h)) - rb : dot(q, vec2(aa, bb)) - ra);
}
`;

const f = x => { const s = (+x).toPrecision(9); return s.includes('.') || s.includes('e') ? s : s + '.0'; };


// Packed per-sample constants (vec4 each), forwarded as flat varyings.
export const SLOT = {
  BOX0: 0, BOX1: 1, BOX2: 2, BOX3: 3,  // centre window rects (cx, cy, hx, hy): stem, top, middle, bottom
  SCAN: 4,                             // centre scan-front x per window
  AUX: 5,                              // (-, detached dot x, y, r) at the shutter's end
  FLAT: 6,                             // centre: window interior is flat BONE
  RIMB: 7,                             // window rims are 1px BONE (collapse started)
  MISC: 8,                             // (aa, 1/aa, truck, detached-dot highlight width)
  YARM: 9,                             // composition sampling offset per window
  DOTC: 10,                            // composition dot (x, y, r, on)
  BAR: 11,                             // (cx, cy, cos, sin)
  GRIDA: 12, GRIDB: 13,                // grid column x 0..3, 4..6 + halftone rho
  RING: 14,                            // (x, y, tag row w, tag row h)
  DD: 15,                              // detached dot at the shutter's start (x, y, r, on)
  FIBR: 16,                            // fibre bake rect (x0, y0, 1/w, 1/h)
  TAG0: 17, TAG1: 18, TAG2: 19,        // per arm: GL-px origin of its tag row, atlas row y0, on
  TAGW: 20,                            // tag row widths (px) per arm: CONTOUR, MATTE, BEAUTY
  SPARE: 21,
  MOTV: 22,                            // over half the slice: bar rotation (rad), dot travel (x, y); 0
  SCANLO: 23, SCANHI: 24,              // per window: scanline smear over this frame's shutter (trailing, leading x)
  WIPEB: 25,                           // merge wipe smear over the shutter (trailing, leading x)
};
export const NC = 26;

// window-space bake of sys paperFibre (smooth along x, one texel per design px along y)
export const FIBRE = { x0: -0.95, x1: 1.15, y0: -0.86, y1: 0.86, w: 160, h: 1858 };
export const FIBRE_FRAG = (lib) => /* glsl */`${lib}
uniform vec4 uR; in vec2 vUv; out vec4 o;
void main(){ vec2 w = uR.xy + vUv * uR.zw; o = vec4(paperFibre(w), 0.0, 0.0, 1.0); }`;

export const VERT = /* glsl */`
layout(location=0) in vec2 aPos;
out vec2 vUv;
uniform vec4 uC[${NC}];
${Array.from({ length: NC }, (_, i) => `flat out vec4 vC${i};`).join('\n')}
void main(){
  vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0);
  ${Array.from({ length: NC }, (_, i) => `vC${i} = uC[${i}];`).join(' ')}
}`;

// grounds: before the first scan only the pass grounds show (a lighter program).
export const FRAG = (lib, C, grounds = false) => /* glsl */`${lib}
${grounds ? '#define GROUNDS 1' : ''}
${Array.from({ length: NC }, (_, i) => `flat in vec4 vC${i};`).join('\n')}
${Object.entries(SLOT).map(([k, i]) => `#define ${k} vC${i}`).join('\n')}
uniform vec2 uRes;
uniform sampler2D uFibre, uTagTex;
in vec2 vUv;
out vec4 o;

#define uAA MISC.x
#define uIAA MISC.y
const vec2 SH = vec2(6.0, -6.0) * PX_H;        // key-light shadow offset (§1.4)
const float TAN15 = 0.267949192, COS15 = 0.965925826, SIN15 = 0.258819045;
const float COL_C = ${f(C.COL_C)}, COL_HW = ${f(C.COL_HW)}, COL_HH = ${f(C.COL_HH)};
const vec2 BAR_B = vec2(${f(C.BAR_HX)}, ${f(C.BAR_HY)});
const float BAR_R = ${f(C.BAR_R)};
const float GRID_R = ${f(C.GRID_R)}, GRID_P = ${f(C.C)};
const float RING_R = ${f(C.RING_R)}, RING_HW = ${f(C.RING_HW)};
const float ISO = 1.0 / 28.0;
const float HLW = 2.0 * PX_H;                   // highlight width
const float RIMV = 1.5 * PX_H;                  // half width of the 3px VERM rim
const float SM_HEAD = 0.05;                     // line smear: flat VERM, at most this long behind the leading edge (H)
const float HT_CELL = 8.0 / 1080.0;             // shadow halftone cell (H)

float cov(float d){ return clamp(0.5 - d * uIAA, 0.0, 1.0); }
// window rect distance, Chebyshev: sharp (mitred) rim corners, as a window frame should have
float sdB(vec2 p, vec4 b){ vec2 q = abs(p - b.xy) - b.zw; return max(q.x, q.y); }

// ── composition elements (window space w) ───────────────────────────────────────────
float dDot(vec2 w){ return DOTC.w > 0.5 ? length(w - DOTC.xy) - DOTC.z : 1.0; }
// COBALT column: x in [-0.30, -0.05] sheared 15 deg (leaning right), as tall as the E
float dCol(vec2 w){ return max((abs(w.x - w.y * TAN15 - COL_C) - COL_HW) * COS15, abs(w.y) - COL_HH); }
vec2 nCol(vec2 w){
  float xs = w.x - w.y * TAN15 - COL_C;
  return (abs(xs) - COL_HW) * COS15 > abs(w.y) - COL_HH ? sign(xs) * vec2(COS15, -SIN15) : vec2(0.0, sign(w.y));
}
// INK bar: rounded box, rotated
vec2 barQ(vec2 w){ vec2 v = w - BAR.xy; return vec2(BAR.z * v.x + BAR.w * v.y, -BAR.w * v.x + BAR.z * v.y); }
float dBar(vec2 w){ vec2 q = abs(barQ(w)) - BAR_B + BAR_R; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - BAR_R; }
vec2 nBar(vec2 w){
  vec2 q = barQ(w);
  vec2 e = abs(q) - BAR_B + BAR_R;
  vec2 m = max(e, 0.0);
  vec2 n = sign(q) * (max(e.x, e.y) > 0.0 ? m / max(length(m), 1e-9) : (e.x > e.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)));
  return vec2(BAR.z * n.x - BAR.w * n.y, BAR.w * n.x + BAR.z * n.y);
}
// INK dot grid 7x7, pitch c; columns individually positioned (the staggered shift). The nearest
// column is the rounded one or its neighbour towards w. Returns the vector to the nearest dot.
float gridX(int i){ return i < 4 ? (i < 2 ? (i == 0 ? GRIDA.x : GRIDA.y) : (i == 2 ? GRIDA.z : GRIDA.w)) : (i < 6 ? (i == 4 ? GRIDB.x : GRIDB.y) : GRIDB.z); }
vec2 gridV(vec2 w){
  float yj = clamp(floor(w.y / GRID_P + 0.5), -3.0, 3.0) * GRID_P;
  int i0 = int(clamp(floor((w.x - GRIDA.w) / GRID_P + 0.5), -3.0, 3.0)) + 3;
  float x0 = gridX(i0);
  float x1 = gridX(clamp(i0 + (w.x > x0 ? 1 : -1), 0, 6));
  vec2 v0 = w - vec2(x0, yj), v1 = w - vec2(x1, yj);
  return dot(v1, v1) < dot(v0, v0) ? v1 : v0;
}
// INK ring
float dRing(vec2 w){ return abs(length(w - RING.xy) - RING_R) - RING_HW; }

// 2px BONE highlight inside an edge facing the key (dot(n, KEY2) > 0.6). Its width tapers from
// 0 to 2px over dot(n, KEY2) 0.6..0.75, so on curves it thins out instead of stopping at a step,
// and on the dot and the column it sits 0.5px inside the silhouette (inset), so the edge's AA
// pixel keeps the fill colour instead of fading pale into the paper. On the Ink ring and bar it
// is flush with the edge: an inset would leave an ink hairline outside it (a double stroke).
float hlW(float d, vec2 n, float w0, float inset){
  float w = w0 * smoothstep(0.6, 0.75, dot(n, KEY2));
  float x = d + inset + 0.5 * w;
  return clamp(0.5 - (abs(x) - 0.5 * w) * uIAA, 0.0, 1.0) * clamp(w * uIAA, 0.0, 1.0);
}
float hl(float d, vec2 n){ return hlW(d, n, HLW, 0.5 * PX_H); }
float hlF(float d, vec2 n){ return hlW(d, n, HLW, 0.0); }

// Smear of a thin VERM line (scanline, wipe edge) over this frame's shutter: the line swept
// from lo to hi (left to right), a flat hard-edged VERM streak (at most SM_HEAD long behind the
// leading edge) that settles to the 3px line as it slows. No alpha ramp: 2D stays flat.
vec4 smear4(vec4 x, vec4 lo, vec4 hi){
  vec4 a = max(lo, hi - SM_HEAD);                 // hard-edged: flat VERM from a to hi (+ the rim's half width)
  return clamp(0.5 - (abs(x - 0.5 * (a + hi)) - 0.5 * (hi - a) - RIMV) * uIAA, 0.0, 1.0);
}

float dColAt(vec2 w){ return max((abs(w.x - w.y * TAN15 - COL_C) - COL_HW) * COS15, abs(w.y) - COL_HH); }
float dBarAt(vec2 w){ vec2 q = abs(barQ(w)) - BAR_B + BAR_R; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - BAR_R; }
float dDotAt(vec2 w){ return length(w - DOTC.xy) - DOTC.z + (DOTC.w > 0.5 ? 0.0 : 1.0); }

// ── the composition at w: all three passes from one SDF evaluation ─────────────────
// BEAUTY: Bone paper, flat fills, a hard (+6,-6)px shadow as a 45 deg Ink halftone (8px, 35%),
//   2px BONE key highlights. Layers bottom to top: column, grid, ring, bar, dot. The grid, ring
//   and bar are Ink, so shadows show on the paper and the column only. The halftone is decided
//   per cell: a whole dot where the cell centre lies in the shadow (clipped only by the elements
//   drawn above it), so a shadow reads as clean rows of round dots hugging its caster.
// MATTE: Ink ground, flat silhouettes: dot VERM, column COBALT, everything else BONE.
// CONTOUR: Bone ground, 1px Ink isolines of the union SDF (period 1/28 H), 2px Ink zero line;
//   where the dot is the nearest element its isolines are 3px VERM.
// The shadow lookups reuse the element-local vectors. Grid dots cast no shadow (a 13px dot on an
// 8px screen reads as noise).
void composition(vec2 w, vec2 p, out vec3 beauty, out vec3 contour, out vec3 matte, out vec3 paper){
#ifdef GROUNDS
  // before the first scan only the grounds show: Bone paper (and flat Bone / Ink)
  paper = BONE * (1.0 + textureLod(uFibre, (w - FIBR.xy) * FIBR.zw, 0.0).r);
  beauty = paper; contour = BONE; matte = INK; return;
#endif
  // column
  float xs = w.x - w.y * TAN15 - COL_C;
  float dcs = (abs(xs) - COL_HW) * COS15, dcy = abs(w.y) - COL_HH;
  float dc = max(dcs, dcy);
  vec2 ncol = dcs > dcy ? sign(xs) * vec2(COS15, -SIN15) : vec2(0.0, sign(w.y));
  // grid
  vec2 gv = gridV(w);
  float lg = length(gv), dg = lg - GRID_R;
  // ring
  vec2 rv = w - RING.xy; float lr = length(rv);
  float dr = abs(lr - RING_R) - RING_HW;
  // bar
  vec2 q = barQ(w);
  vec2 be = abs(q) - BAR_B + BAR_R, bm = max(be, 0.0);
  float bl = length(bm), bg = max(be.x, be.y);
  float db = (bg > 0.0 ? bl : bg) - BAR_R;
  vec2 bn = sign(q) * (bg > 0.0 ? bm / max(bl, 1e-9) : (be.x > be.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)));
  bn = vec2(BAR.z * bn.x - BAR.w * bn.y, BAR.w * bn.x + BAR.z * bn.y);
  // dot
  vec2 dv = w - DOTC.xy; float ld = length(dv);
  float on = DOTC.w > 0.5 ? 0.0 : 1.0;
  float dd = ld - DOTC.z + on;

  float kc = cov(dc), kg = cov(dg), kr = cov(dr), kb = 0.0, kd = 0.0;
  // The bar and the dot move fastest (the 216 re-layout): their coverage, and the CONTOUR
  // isolines they drive, are sub-sampled across the MB slice (4 taps; zero travel = plain).
  float dcgr = min(min(dc, dg), dr);
  for (int c = 0; c < 8; c++) {                              // the bar's fill: 8 sub-taps (its tips sweep fastest)
    float a = MOTV.x * ((float(c) + 0.5) * 0.25 - 1.0);
    vec2 ec = abs(vec2(q.x + a * q.y, q.y - a * q.x)) - BAR_B + BAR_R;
    kb += cov(length(max(ec, 0.0)) + min(max(ec.x, ec.y), 0.0) - BAR_R);
  }
  contour = vec3(0.0);
  for (int c = 0; c < 4; c++) {
    float sc = (float(c) + 0.5) * 0.5 - 1.0;
    float a = MOTV.x * sc;
    vec2 qc = vec2(q.x + a * q.y, q.y - a * q.x);             // R(-a) q, small angle
    vec2 ec = abs(qc) - BAR_B + BAR_R;
    float dbc = length(max(ec, 0.0)) + min(max(ec.x, ec.y), 0.0) - BAR_R;
    float ddc = length(dv - MOTV.yz * sc) - DOTC.z + on;
    kd += cov(ddc);
    // CONTOUR: 1px Ink isolines of the union SDF every 1/28 H, a 2px zero line; the dot's are 3px VERM
    float dn = min(dcgr, dbc);
    float du = min(ddc, dn);
    float dl = abs(du - floor(du * 28.0 + 0.5) * ISO);
    bool isDot = ddc <= dn;
    float wpx = isDot ? 1.5 : (abs(du) < 0.5 * ISO ? 1.0 : 0.5);
    contour += mix(BONE, isDot ? VERM : INK, clamp(0.5 - (dl - wpx * PX_H) * uIAA, 0.0, 1.0));
  }
  kb *= 0.125; kd *= 0.25; contour *= 0.25;
  paper = BONE * (1.0 + textureLod(uFibre, (w - FIBR.xy) * FIBR.zw, 0.0).r);
  // shadows, decided per halftone cell (45 deg lattice in window space, anchored at w = 0)
  vec2 u = w / HT_CELL; u = vec2(u.x + u.y, u.y - u.x) * 0.70710678;
  vec2 uc = floor(u) + 0.5;
  vec2 cw = vec2(uc.x - uc.y, uc.x + uc.y) * (0.70710678 * HT_CELL);   // cell centre (w)
  float rho = GRIDB.w * HT_CELL;                                        // dot radius (H)
  float htd = clamp(0.5 - (length(w - cw) - rho) * uIAA, 0.0, 1.0);    // this cell's dot
  vec2 cs = cw - SH;
  // the column receives the ring, bar and dot (and the detached dot); the paper all of them.
  // Grid dots (13px) cast none: an 8px screen can't draw them.
  float sO = min(min(abs(length(cs - RING.xy) - RING_R) - RING_HW, dBarAt(cs)), dDotAt(cs));
  // whole dots wherever the cell centre is in shadow; the casting elements are drawn on top and
  // clip them, so the shadow row hugs its caster's edge
  float onO = step(sO, 0.0);
  float htC = htd * onO;
  float htP = htd * max(onO, step(dColAt(cs), 0.0));
  // key highlights (the grid dots take none: at 13px a 2px line only chips them; the ring's is on
  // its outer edge only, so the 6px stroke stays one stroke)
  float hc = hl(dc, ncol);
  float hr = hlF(lr - RING_R - RING_HW, rv / max(lr, 1e-7));
  float hb = hlF(db, bn) * clamp(1.0 - abs(MOTV.x) * 0.35 * uIAA / 6.0, 0.0, 1.0);
  float hd = hl(dd, dv / max(ld, 1e-7));
  vec3 col = mix(paper, INK, htP);
  col = mix(col, mix(mix(COBALT, INK, htC), BONE, hc), kc);
  col = mix(col, mix(INK, BONE, max(hr, hb)), max(max(kg, kr), kb));   // the Ink layers never overlap
  beauty = mix(col, mix(VERM, BONE, hd), kd);
  matte = mix(mix(mix(INK, COBALT, kc), BONE, max(max(kg, kr), kb)), VERM, kd);
}

// One geometry tap (see the header): accumulates weights and the overlay.
${HULL2}
void tap(vec2 p, vec4 B0, vec4 B1, vec4 B2, vec4 B3, vec4 A, vec4 fl,
         inout vec4 wG, inout vec4 wP, inout vec4 wB, inout float wOut, inout float wFlat, inout vec3 over){
  vec4 d = vec4(sdB(p, B0), sdB(p, B1), sdB(p, B2), sdB(p, B3));
  // union-boundary rim, in the style of the nearest window
  float du = min(min(d.x, d.y), min(d.z, d.w));
  float rb = step(0.5, dot(RIMB, vec4(equal(d, vec4(du)))));
  float rim = mix(clamp(0.5 - (abs(du) - RIMV) * uIAA, 0.0, 1.0),
                  clamp(0.5 - (abs(du + 0.5 * PX_H) - 0.5 * PX_H) * uIAA, 0.0, 1.0), rb);
  // interiors in draw order: stem > bottom > middle > top
  vec4 c = clamp(0.5 - d * uIAA, 0.0, 1.0);
  float rem = 1.0 - c.x;
  float e3 = c.w * rem; rem -= e3;
  float e2 = c.z * rem; rem -= e2;
  float e1 = c.y * rem; rem -= e1;
  // the merge wipe: its smear over the shutter; behind its leading edge every window shows the
  // merged composition (BEAUTY at yArm 0): the wipe itself carries the registration
  float wipeRim = smear4(vec4(p.x), WIPEB.xxxx, WIPEB.yyyy).x * (1.0 - rem);
  float wiped = clamp(0.5 - (p.x - WIPEB.y) * uIAA, 0.0, 1.0);
  // the detached dot: the hull of its discs at the shutter's start (DD) and end (A), one flat
  // VERM shape (a tapered streak while it glides, the disc when still)
  vec2 v = p - A.yz; float l = length(v);
  float dotc = A.w > 0.0 ? cov(sdHull2(p, DD.xy, DD.z, A.yz, A.w)) : 0.0;
  // its highlight tapers from 2px to nothing during the glide (MISC.w = width); none on a streak
  float hdd = hlW(l - A.w, v / max(l, 1e-7), MISC.w, 0.5 * PX_H) * step(length(A.yz - DD.xy) + abs(A.w - DD.z), PX_H);
  vec3 dotCol = mix(VERM, BONE, MISC.w > 0.0 ? hdd : 0.0);
  float att = (1.0 - wipeRim) * (1.0 - rim) * (1.0 - dotc);
  over += (VERM * wipeRim * (1.0 - rim) + mix(VERM, BONE, rb) * rim) * (1.0 - dotc) + dotCol * dotc;
  wOut += rem * att;
  vec4 e = vec4(c.x, e1, e2, e3) * att;
  vec4 sc = smear4(vec4(p.x), SCANLO, SCANHI);                          // scanline smear in its window
  over += VERM * dot(e, sc);
  e *= 1.0 - sc;
  wFlat += dot(e, fl);
  e *= 1.0 - fl;
  wB.x += dot(e, vec4(1.0)) * wiped;   // behind the wipe every window is the one BEAUTY, registered (yArm 0)
  e *= 1.0 - wiped;
  vec4 r = clamp(0.5 - (vec4(p.x) - SCANHI) * uIAA, 0.0, 1.0);         // behind the scan's leading edge
  wP += e * r;
  wG += e * (1.0 - r);
}

void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  vec4 wG = vec4(0.0), wP = vec4(0.0), wB = vec4(0.0);   // per window: ground, own pass, BEAUTY (wiped)
  float wOut = 0.0, wFlat = 0.0;
  vec3 over = vec3(0.0);                                  // premultiplied overlays (rims, scanlines, dot)
  tap(p, BOX0, BOX1, BOX2, BOX3, AUX, FLAT, wG, wP, wB, wOut, wFlat, over);
  vec3 col = wOut * INK + wFlat * BONE + over;
  // tags (arms are disjoint in y: one texel fetch)
  vec2 fc = gl_FragCoord.xy;
  vec4 T = fc.y >= TAG1.y + RING.w ? TAG0 : (fc.y >= TAG2.y + RING.w ? TAG1 : TAG2);
  vec2 q = floor(fc - T.xy);
  float tg = (T.w > 0.5 && q.x >= 0.0 && q.y >= 0.0 && q.x < RING.z && q.y < RING.w)
    ? 0.8 * texelFetch(uTagTex, ivec2(int(q.x), int(T.z + q.y)), 0).a : 0.0;
  vec3 ta = vec3(T == TAG0 ? tg : 0.0, T == TAG1 ? tg : 0.0, T == TAG2 ? tg : 0.0);
  // a plate of the pass's ground behind each tag (its row + 2px): the pass never runs through the letters
  float pl = (T.w > 0.5 && q.x >= -2.0 && q.y >= -2.0 && q.x < (T == TAG0 ? TAGW.x : (T == TAG1 ? TAGW.y : TAGW.z)) + 2.0 && q.y < RING.w + 2.0) ? 1.0 : 0.0;
  vec3 pa = vec3(T == TAG0 ? pl : 0.0, T == TAG1 ? pl : 0.0, T == TAG2 ? pl : 0.0);
  // the composition, once per group of windows sharing a yArm (heaviest group first)
  vec4 tot = wG + wP + wB;
  vec4 done = vec4(0.0);
  for (int it = 0; it < 3; it++) {
    vec4 r = tot * (1.0 - done);
    float m = max(max(r.x, r.y), max(r.z, r.w));
    if (m < 1e-6) break;
    float ya = r.x == m ? YARM.x : (r.y == m ? YARM.y : (r.z == m ? YARM.z : YARM.w));
    vec4 grp = (1.0 - done) * vec4(lessThan(abs(YARM - ya), vec4(1e-6)));
    done += grp;
    vec3 b, cn, mt, pp;
    composition(vec2(p.x + MISC.z, p.y - ya), p, b, cn, mt, pp);
    vec4 G = wG * grp, Q = wP * grp, W = wB * grp;
    col += G.x * pp + (Q.x + W.x) * b;                                            // stem, and everything wiped: BEAUTY                                            // stem: BEAUTY
    col += G.y * mix(BONE, INK, ta.x) + Q.y * mix(mix(cn, BONE, pa.x), INK, ta.x);   // top: CONTOUR
    col += G.z * mix(INK, BONE, ta.y) + Q.z * mix(mix(mt, INK, pa.y), BONE, ta.y);   // middle: MATTE
    col += G.w * mix(pp, INK, ta.z) + Q.w * mix(mix(b, pp, pa.z), INK, ta.z);        // bottom: BEAUTY
  }
  o = vec4(col, 1.0);
}`;


// Smear of the window rims over this frame's shutter (the main pass draws the geometry at the
// shutter's end): the band some moving box's edge sweeps between the shutter's start (uS0) and end
// (uS1), up to uDepth behind the edge's end position, is flat rim colour (VERM; 1px-BONE rims from
// 252 smear BONE), hard-edged, so a fast edge reads as one bold stroke that thins back to the rim
// as it settles. Swept = inside the hull of a moving box's two states, and not deep inside the
// union at both ends (interiors that stay covered).
export const SMEAR_FRAG = (lib) => /* glsl */`${lib}
uniform vec4 uS0[4], uS1[4];
uniform vec4 uMv;
uniform float uBone, uDepth;
uniform vec4 uD0, uD1;              // the detached dot's discs (start, end; r 0 = none): drawn above, never smeared over
uniform vec2 uRes;
in vec2 vUv; out vec4 o;
float sdB(vec2 p, vec4 b){ vec2 q = abs(p - b.xy) - b.zw; return max(q.x, q.y); }
${HULL2}
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  float iaa = uRes.y, rv = 1.5 * PX_H, eps = 0.25 * PX_H;
  float du0 = 1e9, du1 = 1e9;
  for (int k = 0; k < 4; k++) { du0 = min(du0, sdB(p, uS0[k])); du1 = min(du1, sdB(p, uS1[k])); }
  float sw = 0.0;
  for (int k = 0; k < 4; k++) {
    vec4 a = uS0[k], b = uS1[k];
    vec2 lo = min(a.xy - a.zw, b.xy - b.zw), hi = max(a.xy + a.zw, b.xy + b.zw);
    float dh = sdB(p, vec4(0.5 * (lo + hi), 0.5 * (hi - lo)));
    // distance to this box's edges that moved during the shutter (at their end position)
    vec2 e0 = b.xy - b.zw, e1 = b.xy + b.zw;
    vec2 m0 = step(eps, abs(e0 - (a.xy - a.zw))), m1 = step(eps, abs(e1 - (a.xy + a.zw)));
    float de = 1e9;
    de = min(de, mix(1e9, abs(p.x - e0.x), m0.x));
    de = min(de, mix(1e9, abs(p.x - e1.x), m1.x));
    de = min(de, mix(1e9, abs(p.y - e0.y), m0.y));
    de = min(de, mix(1e9, abs(p.y - e1.y), m1.y));
    float lead = clamp(0.5 - (max(de, abs(du1)) - rv - uDepth) * iaa, 0.0, 1.0);
    sw = max(sw, uMv[k] * clamp(0.5 - (dh - rv) * iaa, 0.0, 1.0) * lead);
  }
  float inside = clamp(0.5 - (max(du0, du1) + rv) * iaa, 0.0, 1.0);
  float dot = uD1.z > 0.0 ? clamp(0.5 - sdHull2(p, uD0.xy, uD0.z, uD1.xy, uD1.z) * iaa, 0.0, 1.0) : 0.0;
  float a = sw * (1.0 - inside) * (1.0 - dot);
  o = vec4(mix(VERM, BONE, uBone) * a, a);
}`;
