// line — FIG. 1 LINE [96, 168), station 0 (the N). DIRECTION.md §5.2.
//
// The dot is now the ground: the frame is VERM paper and the letter prints onto it as three
// halftone plates on 16ths (shadow 96, face 102, ground 108), Ink dots on the module corners — the
// exact inverse of `point`'s Bone stars dying on those corners at f95. At 120 the dots stretch into
// capsules that fuse into 19 engraved rows (a banknote line screen: each row's thickness carries the
// letter, swelling and tapering like a burin cut), the rows ripple twice (132, 138), and from 144
// they collapse — the outermost rows swell shut first, the centre row thins away, and rows ±1 close
// on the 6px VERM horizon (resolved in screen space).
//
// Build (§5.2): one fragment pass, paper space q = p / paperZ(frame).
//   Init:  D (darkness) of the 33×19 module corners, box-filtered over a 2×2 subsample per cell and
//          split into its three plates; and the settled engraving half-thickness 0.56c·√D(x, j·c)
//          of the 19 rows at 1 design px (1920 per row), with a Hann taper along x.
//   Frame: the CPU pops the plates into corner radii, packed per cell (the 4 corners of a cell in
//          one RGBA texel), and the collapse state per row pair.
//   Pixel: dot phase 1 fetch + 4 discs; capsule phase 2 fetches + 6 capsules; row phase 1 fetch
//          (the two rows that bracket the pixel, with their slopes: first-order step from the nearest
//          texel) + 2 slope-corrected edges (+1 fetch of the collapse state from 144).

import * as sys from './_sys.js';

const C = sys.C_MOD;                        // module, 1/18 H
const PXD = sys.PX;                         // one design px (H)
const TAU = Math.PI * 2;
const NK = 33, NJ = 19, OK = 16, OJ = 9;    // corners k ∈ [−16, 16], j ∈ [−9, 9]
const CK = NK - 1, CJ = NJ - 1;             // cells (k, j) ∈ [−16, 15] × [−9, 8]
const ROW_W = 1920;                         // row texels over q.x ∈ [−XR, XR] (1 design px each)
const XR = OK * C;
const CAP = 1.10, BASE = -0.55, CX = -0.18; // the letter, paper units
const EXT = [0.12, -0.12];                  // extrusion vector (towards the shadow side, lower right)
const D_GROUND = 0.10, D_SHADOW = 0.92;
const RK = 0.56 * C;                        // r = 0.56c·√D
const PLATES = [96, 102, 108];              // shadow, face, ground plate print frames (16ths)
// Plate pops are latched states (§2.2, §8.4): a cell's plate prints on the integer frame
// F0 = PLATE + delay (s.frame ≥ F0, in every MB sample) and its spring runs from F0 − PRE, so it
// STAMPS on its thud at spring(3.5/60) ≈ 0.59 scale (point's IN springs in at 0.62) and settles
// through the 16% overshoot ~5f later. The one exception is the cut frame 96 itself (s.fi = 0), where
// the 95/96 contract (≤2 codes per 32² patch, any channel) only admits ~1–3px specks: there the
// shadow plate's delay-0 cells run at the IN pre-roll; from 97 they are back on the plate clock
// (one frame into the stamp), so the shadow plate lands on 97, 1f after the kick.
const PRE = 3.5;
const PRE_IN = 0.65;
const TAPER = 0.5 * C;                      // Hann window along the rows (the burin's swell)

// ---- timing (global frames g; fractional under MB) ----
const G_LINE0 = 120, G_LINE1 = 130;         // capsule half-length 0 → c/2, outQuint
const G_GAM0 = 120, G_GAM1 = 127;           // capsule radii: dot radius → the row's per-pixel engraving thickness
const G_BLEND0 = 128, G_BLEND1 = 130;       // capsule field → row field (identical at 130: L = c/2, radius = h)
const G_CLOSE = 0.5 * C;                    // row-profile closing width: ground pinches narrower than this fill
const G_OPEN = 1.0 * C;                     // row-profile opening width: shadow slivers narrower than this don't knot
const WAVE = [132, 138];                    // row-wave pulses
const G_THIN0 = 150, G_THIN1 = 162;         // row 0 thins away
const G_END = 166;                          // rows ±1 closed on the 6px horizon
const G_PM1 = 158;                          // rows ±1 start closing (outCubic, 8f: a soft landing on the horizon)

const FRAG = (lib) => /* glsl */`${lib}
uniform vec2 uRes;
uniform sampler2D uCell;     // ${CK}×${CJ}: radii (q) of the corners (k,j) (k+1,j) (k,j+1) (k+1,j+1) of cell (k,j); ≤ 0 = none
uniform sampler2D uRow;      // ${ROW_W}×${CJ}: (h_j, dh_j/dx, h_j+1, dh_j+1/dx) of the rows bracketing cell row j
uniform sampler2D uColl;     // ${CJ}×1: (e_j, target_j, e_j+1, target_j+1) collapse state; target < 0 = thin to 0
uniform float uCollapse;     // > 0 once any row has started to collapse (f ≥ 144)
uniform float uZ;            // paperZ(frame)
uniform float uL;            // capsule half-length (q)
uniform float uBeta;         // 0 = dots/capsules, 1 = per-pixel engraved rows
uniform float uGam;          // capsule radius: 0 = the corner's dot radius, 1 = the row's per-pixel thickness
uniform vec2 uWave;          // (amplitude q, phase in cycles)
in vec2 vUv; out vec4 o;

float PXQ;                   // one screen pixel in q units

// Capsule (segment ±L on the x axis, radius r); a disc at L = 0. Sub-pixel correction: as r → 0 the
// coverage → 0 (it tracks the area), so the pops are born speck-free. r ≤ 0: absent.
float capD(vec2 d, float L, float r){
  return r > 0.0 ? length(vec2(max(abs(d.x) - L, 0.0), d.y)) - r + 0.5 * max(PXQ - r, 0.0) : 1.0;
}
float discD(vec2 d, float r){
  return r > 0.0 ? length(d) - r + 0.5 * max(PXQ - r, 0.0) : 1.0;
}
// Collapse of one row: (half-thickness, slope) → mix toward max(h, target), or toward 0.
vec2 collapse(vec2 h, vec2 T){
  if (T.y < 0.0) return h * (1.0 - T.x);
  return mix(h, h.x > T.y ? h : vec2(T.y, 0.0), T.x);
}
// Signed distance to one edge of a row: e = distance from the row's centre line (≥ 0, toward the
// pixel), h = (half-thickness, its slope), s = slope of that edge. Divided by the edge slope so
// steep swells antialias like straight edges.
float rowD(float e, vec2 h, float s){
  return (e - h.x) * inversesqrt(1.0 + s * s) + 0.5 * max(PXQ - 2.0 * h.x, 0.0);
}

void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  vec2 q = p / uZ;
  PXQ = 1.0 / (uRes.y * uZ);

  // the two engraved rows that bracket the pixel (row wave displaces them; only from 132, after the blend)
  float y = q.y, dy = 0.0;
  if (uWave.x > 0.0) {
    float w = TAU * (q.x / 0.9 - uWave.y);
    y -= uWave.x * sin(w);
    dy = uWave.x * cos(w) * ${(TAU / 0.9).toFixed(9)};             // slope of the displacement
  }
  int j0 = clamp(int(floor(y / C_MOD)), -${OJ}, ${OJ - 1});
  vec2 h0 = vec2(0.0), h1 = vec2(0.0);
  if (uGam > 0.0) {
    // nearest texel + first-order step along its stored slope (one fetch; continuous to << 0.01px)
    float ux = (q.x + ${XR.toFixed(9)}) * ${(ROW_W / (2 * XR)).toFixed(6)} - 0.5, ix = floor(ux + 0.5);
    vec4 H = texelFetch(uRow, ivec2(clamp(int(ix), 0, ${ROW_W - 1}), j0 + ${OJ}), 0);
    float tx = (ux - ix) * ${(2 * XR / ROW_W).toFixed(9)};           // q units from the texel centre
    h0 = vec2(H.x + H.y * tx, H.y); h1 = vec2(H.z + H.w * tx, H.w);
  }

  // dots → capsules on the module corners (no wave before 132, so y = q.y and j0 is the cell row)
  float dc = 1.0;
  if (uBeta < 1.0) {
    float y0 = float(j0) * C_MOD;
    if (uL <= 0.0) {
      // a dot (r <= 0.62c incl. the pop overshoot) only reaches into the cells it is a corner of
      int k0 = clamp(int(floor(q.x / C_MOD)), -${OK}, ${OK - 1});
      vec4 R = texelFetch(uCell, ivec2(k0 + ${OK}, j0 + ${OJ}), 0);
      vec2 b = q - vec2(float(k0) * C_MOD, y0);
      dc = min(min(discD(b, R.x), discD(b - vec2(C_MOD, 0.0), R.y)),
               min(discD(b - vec2(0.0, C_MOD), R.z), discD(b - vec2(C_MOD), R.w)));
    } else {
      // a capsule reaches c/2 + 0.62c along x: the nearest corner column +-1. As it draws out, its
      // radius eases from the dot's to the row's per-pixel engraving thickness (uGam), so the beads
      // thin into the burin line instead of leaving lumps; at L = c/2, uGam = 1 the union IS the row.
      int kx = clamp(int(floor(q.x / C_MOD + 0.5)), -${OK - 1}, ${OK - 1});
      vec4 A = texelFetch(uCell, ivec2(kx - 1 + ${OK}, j0 + ${OJ}), 0);   // (kx-1, kx) x (j0, j0+1)
      vec4 B = texelFetch(uCell, ivec2(kx + ${OK}, j0 + ${OJ}), 0);       // (kx, kx+1) x (j0, j0+1)
      vec3 r0 = vec3(A.x, A.y, B.y), r1 = vec3(A.z, A.w, B.w);
      r0 = mix(r0, vec3(h0.x), uGam * step(0.0, r0));                   // (absent corners stay absent)
      r1 = mix(r1, vec3(h1.x), uGam * step(0.0, r1));
      vec2 b = q - vec2(float(kx) * C_MOD, y0);
      vec2 u = vec2(C_MOD, 0.0), v = vec2(0.0, C_MOD);
      dc = min(min(capD(b + u, uL, r0.x), capD(b, uL, r0.y)), capD(b - u, uL, r0.z));
      dc = min(dc, min(min(capD(b + u - v, uL, r1.x), capD(b - v, uL, r1.y)), capD(b - u - v, uL, r1.z)));
    }
  }
  // engraved rows
  float dr = 1.0;
  if (uBeta > 0.0) {
    if (uCollapse > 0.0) {
      vec4 T = texelFetch(uColl, ivec2(j0 + ${OJ}, 0), 0);
      h0 = collapse(h0, T.xy); h1 = collapse(h1, T.zw);
    }
    float e0 = y - float(j0) * C_MOD;                              // above row j0's centre line
    dr = min(rowD(e0, h0, dy + h0.y), rowD(C_MOD - e0, h1, dy - h1.y));   // upper edge of j0, lower edge of j0+1
  }
  float d = mix(dc, dr, uBeta);
  float cov = clamp(0.5 - d / PXQ, 0.0, 1.0);
  o = vec4(mix(VERM, INK, cov), 1.0);
}`;

// Deterministic integer hash → [0, 1).
function hash3(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export default {
  id: 'line',

  init(ctx) {
    sys.initSys(ctx);
    this.prog = ctx.program(FRAG(`${ctx.glsl.common}${sys.SYS_GLSL}`), 'line');
    ctx.gl.pixelStorei(ctx.gl.UNPACK_FLIP_Y_WEBGL, false);
    ctx.gl.pixelStorei(ctx.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    // ── the letter: stationLetter(0) at cap 1.10 (paper units), baseline −0.55, ink-centred on x = −0.18
    const meta = sys.glyphSDF(ctx, sys.stationLetter(ctx, 0));
    const G = sys.placeGlyph(meta, CAP, BASE, CX);
    const icx = CX, icy = BASE + meta.inkCy * CAP;           // ink centre (paper units)
    const faceD = (x, y) => 0.46 + 0.10 * ((x - icx) / CAP - (y - icy) / CAP);
    const dFace = (x, y) => G.d(x, y);
    // extrusion: inside the glyph shifted by t·EXT, t = 1/8 … 8/8 (union = min of the distances)
    const dExt = (x, y) => { let m = Infinity; for (let t = 1; t <= 8; t++) m = Math.min(m, G.d(x - EXT[0] * t / 8, y - EXT[1] * t / 8)); return m; };

    // ── per-corner plate darkness (shadow, face, ground), box-filtered over a 2×2 subsample per cell
    this.plateD = new Float32Array(NK * NJ * 3);
    this.delay = new Float32Array(NK * NJ * 3);
    for (let j = -OJ; j <= OJ; j++) for (let k = -OK; k <= OK; k++) {
      const i = (j + OJ) * NK + (k + OK);
      let Ds = 0, Df = 0, Dg = 0;
      for (const sx of [-0.25, 0.25]) for (const sy of [-0.25, 0.25]) {
        const x = (k + sx) * C, y = (j + sy) * C;
        if (dFace(x, y) <= 0) Df += faceD(x, y) / 4;
        else if (dExt(x, y) <= 0) Ds += D_SHADOW / 4;
        else Dg += D_GROUND / 4;
      }
      this.plateD.set([Ds, Df, Dg], i * 3);
      // hashed 0/1f delay per cell on the shadow and face plates; the ground plate (the field) prints as
      // one clean spring so it settles early and the face/ground edge is crisp for the 110+ read
      for (let pl = 0; pl < 2; pl++) this.delay[i * 3 + pl] = hash3(k + 101, j + 211, pl + 7) < 0.5 ? 0 : 1;
    }
    this.radius = new Float32Array(NK * NJ);
    this.cellData = new Float32Array(CK * CJ * 4);
    this.cellTex = ctx.dataTexture(CK, CJ, this.cellData);
    this.collData = new Float32Array(CJ * 4);
    this.collTex = ctx.dataTexture(CJ, 1, this.collData);

    // ── the rows' settled engraving half-thickness 0.56c·√D(x, j·c). D is sampled on the row line at
    // 1 design px (region edges antialiased over 1px by their SDFs) and smoothed along x with a Hann
    // window TAPER wide: the burin's swell, so thickness changes at the letter's edges are S-curves.
    const NS = Math.round(TAPER / PXD) | 1;                   // odd: the window is centred on the texel
    const HW = [];
    for (let t = 0; t < NS; t++) HW.push(0.5 - 0.5 * Math.cos(TAU * (t + 0.5) / NS));
    const hwSum = HW.reduce((a, b) => a + b, 0);
    const NO = Math.round(G_OPEN / PXD) | 1;                  // opening window (odd)
    const dx = 2 * XR / ROW_W, PAD = NS + NO;
    const half = new Float32Array(ROW_W * NJ);
    const raw = new Float32Array(ROW_W + 2 * PAD), raw2 = new Float32Array(raw.length), tmp = new Float32Array(raw.length);
    const NC = Math.round(G_CLOSE / PXD) | 1;
    // 1-D flat morphology: dst[i] = op over src[i − ⌊n/2⌋ … i + ⌊n/2⌋] (clamped)
    const morph = (src, dst, n, op) => {
      const hn = n >> 1;
      for (let i = 0; i < src.length; i++) {
        let m = src[i];
        for (let t = Math.max(0, i - hn); t <= Math.min(src.length - 1, i + hn); t++) m = op(m, src[t]);
        dst[i] = m;
      }
    };
    for (let j = -OJ; j <= OJ; j++) {
      const y = j * C;
      for (let i = 0; i < raw.length; i++) {
        const x = -XR + (i - PAD + 0.5) * dx;
        const ff = Math.min(1, Math.max(0, 0.5 - dFace(x, y) / PXD));
        const fe = ff >= 1 ? 0 : Math.min(1, Math.max(0, 0.5 - dExt(x, y) / PXD));
        raw[i] = ff * faceD(x, y) + (1 - ff) * (fe * D_SHADOW + (1 - fe) * D_GROUND);
      }
      // opening (erode, then dilate) over NO px: an extrusion sliver narrower than c (where the diagonal's
      // shadow only peeks out below its lower edge) would smooth into a bulb-then-pinch knot; opened, the
      // row runs face → ground in one clean swell like on the stems. Wide regions keep their edges exactly.
      // Before that, a closing over NC px fills the pinch where a ground wedge closes to a point between
      // the diagonal and a stem (a sub-c/2 dip would read as a nick in the row).
      morph(raw, tmp, NC, Math.max); morph(tmp, raw2, NC, Math.min);           // close
      morph(raw2, tmp, NO, Math.min); morph(tmp, raw2, NO, Math.max);          // open
      for (let i = 0; i < ROW_W; i++) {
        let D = 0;
        for (let t = 0; t < NS; t++) D += HW[t] * raw2[i + PAD + t - (NS >> 1)];   // taps i−⌊NS/2⌋ … i+⌊NS/2⌋
        half[(j + OJ) * ROW_W + i] = RK * Math.sqrt(D / hwSum);
      }
    }
    // pack the bracketing row pair (j, j+1) of every cell row with the slopes dh/dx (central differences)
    const slope = (j, i) => (half[(j + OJ) * ROW_W + Math.min(i + 1, ROW_W - 1)] - half[(j + OJ) * ROW_W + Math.max(i - 1, 0)]) / (2 * dx);
    const pair = new Float32Array(ROW_W * CJ * 4);
    for (let j = -OJ; j < OJ; j++) for (let i = 0; i < ROW_W; i++) {
      const o = ((j + OJ) * ROW_W + i) * 4;
      pair[o] = half[(j + OJ) * ROW_W + i]; pair[o + 1] = slope(j, i);
      pair[o + 2] = half[(j + 1 + OJ) * ROW_W + i]; pair[o + 3] = slope(j + 1, i);
    }
    this.rowTex = ctx.dataTexture(ROW_W, CJ, pair);
  },

  // Everything the frame needs, as a pure function of the (fractional) global frame g and the
  // integer frame F (the plate latches).
  state(ctx, g, F) {
    const { ease: E, spring } = ctx.ease;
    const z = sys.paperZ(g);

    // plates: each pops with spring(4, 0.5) plus a hashed 0/1f delay per cell, latched on the integer
    // frame; overprints add area, so a cell's radius is 0.56c·√(Σ D_plate·pop²) (a single-plate cell
    // pops exactly with the spring)
    const pd = this.plateD, dl = this.delay, R = this.radius;
    for (let i = 0; i < NK * NJ; i++) {
      let a = 0;
      for (let pl = 0; pl < 3; pl++) {
        const D = pd[i * 3 + pl];
        if (D <= 0) continue;
        const F0 = PLATES[pl] + dl[i * 3 + pl];
        if (F < F0) continue;                                // bare VERM until its plate prints
        const u = g - F0 + (F === PLATES[0] ? PRE_IN : PRE); // (only the shadow plate prints at 96)
        if (u <= 0) continue;
        const s = spring(u / 60, 4, 0.5);
        a += D * s * s;
      }
      R[i] = a > 0 ? RK * Math.sqrt(a) : -1;
    }
    const cd = this.cellData;
    for (let j = 0; j < CJ; j++) for (let k = 0; k < CK; k++) {
      const o = (j * CK + k) * 4, c = j * NK + k;
      cd[o] = R[c]; cd[o + 1] = R[c + 1]; cd[o + 2] = R[c + NK]; cd[o + 3] = R[c + NK + 1];
    }

    const L = g > G_LINE0 ? 0.5 * C * E.outQuint((g - G_LINE0) / (G_LINE1 - G_LINE0)) : 0;
    const gam = E.inOutSine((g - G_GAM0) / (G_GAM1 - G_GAM0));
    const beta = E.inOutSine((g - G_BLEND0) / (G_BLEND1 - G_BLEND0));
    const b = u => (u >= 0 && u <= 6 ? Math.sin(Math.PI * u / 6) : 0);
    const A = F >= 144 ? 0 : 0.18 * C * (b(g - WAVE[0]) + b(g - WAVE[1]));   // A = 0 from 144 (all samples)
    const phase = (g - 120) / 24;

    // collapse: |j| ≥ 2 swell to c (outExpo, 6f, outermost first from 144 on the 2f grid); row 0 thins
    // over 150–162; rows ±1 swell until their inner edges sit at ±3px in SCREEN space by 166.
    const row = j => {
      const a = Math.abs(j);
      if (a >= 2) {
        const s0 = 144 + 2 * (9 - a);
        return [g > s0 ? E.outExpo((g - s0) / 6) : 0, 0.5 * C + 4 * PXD];   // +4px: neighbours overlap early in the ease (no hairline seams)
      }
      if (a === 1) return [g > G_PM1 ? E.outCubic((g - G_PM1) / (G_END - G_PM1)) : 0, C - 3 * PXD / z];
      return [E.inOutSine((g - G_THIN0) / (G_THIN1 - G_THIN0)), -1];
    };
    const cl = this.collData;
    for (let j = -OJ; j < OJ; j++) cl.set([...row(j), ...row(j + 1)], (j + OJ) * 4);
    return { z, L, gam, beta, A, phase };
  },

  render(ctx, s) {
    const g = s.frame - s.fi + s.f;                         // global frame, fractional under MB
    const st = this.state(ctx, g, s.frame);
    const gl = ctx.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);          // float uploads: never inherit a flip
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CK, CJ, gl.RGBA, gl.FLOAT, this.cellData);
    gl.bindTexture(gl.TEXTURE_2D, this.collTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CJ, 1, gl.RGBA, gl.FLOAT, this.collData);
    ctx.draw(this.prog, {
      uCell: this.cellTex, uRow: this.rowTex, uColl: this.collTex,
      uCollapse: g > 144 ? 1 : 0, uZ: st.z, uL: st.L, uGam: Math.max(st.gam, st.beta > 0 ? 1 : 0), uBeta: st.beta, uWave: [st.A, st.phase],
    }, s.target);
    ctx.setPost(s, {});
  },

  // §5.2 MB: 6 on 96–114, 120–130 and 132–166 (in-shot 0–18, 24–34, 36–69). 166–167 is the hold:
  // no samples there, so 166 is the exact final band (identical to 167).
  mb(f) { return (f >= 0 && f <= 18) || (f >= 24 && f <= 34) || (f >= 36 && f <= 69) ? 6 : 0; },

  postOut: {},
};
