// lens: FIG. 3 LENS [264,384), station 2 (K). DIRECTION.md §5.4.
//
// A glass K refracts kinetic type; the weight wave (288), the latching serif flips (336–357)
// and K→V (360–372). The dot waits at the tittle, clicks in at 276, sits under the glass K
// (magnified, split VERM/COBALT by its bevel), then hops into the V's notch (NSTAR) and the
// shot ends on the silent glass V (372–383); the tail (384–395, volume's prevTex) moves only
// the glint.
//
// Build:
//  per FRAME (cached on the integer frame, shared by every MB sample):
//   1. type: one canvas band, row 1 in R and row 2 in G (unclipped glyphs, per-glyph fonts),
//      uploaded premultiplied so each channel is that row's coverage;
//   2. background coverage (R type, G hairlines) into a full-res FBO: the slot clip is applied
//      analytically at each row's hairline, and every glyph and hairline end is smeared along
//      its own path over the shutter (analytic motion blur), all displaced by the f312
//      shockwave;
//  per SAMPLE:
//   3. compose: a clear to INK, then INK/BONE from the coverage FBO over the content boxes and
//      the dot (itself sub-sampled along its path), minus the glass box;
//   4. glass SDF: half resolution, scissored to the glass box (sys.glyphD of the K swinging
//      in, rotating about J with its stem slot-cut and folding arms, the K→V front blend, or
//      the V); stores d and the slot-cut distance (fp32: the shading takes its curvature);
//   5. glass, scissored to the glass box: the bevel normal from a ring-smoothed gradient of d
//      (C1, rounds the mitre creases), the background refracted through the bevel with a
//      fold-free (1 − x)² offset (fringes on the VERM–COBALT axis, 2×2 footprint AA), the
//      tittle seen whole through the glass, 8% COBALT tint (stronger through the bevel),
//      Fresnel against the GRAPHITE→BONE studio with volume's COBALT rim light, bevel key-light
//      lines, a continuous silhouette rim, the glint streak (integrated over the shutter) and
//      the slot cut's VERM rim. Full resolution; while
//      the glass moves ≥ 2.5 px between MB samples it is shaded at half resolution and
//      composited (the sample spacing hides the difference), and its thin lines widen to tents
//      twice the local sample spacing.
//  Engine motion blur is only used while the glass itself moves (301–317, 360–371).
import * as sys from './_sys.js';

const D2R = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const glf = x => (Number.isInteger(x) ? x.toFixed(1) : String(x));   // GLSL float literal

// ── timing, in LOCAL frames (lf = global − 264) ─────────────────────────────
const RISE_DUR = 14, I_START = 3;          // rows rise 264+k (ı at 267), outExpo 14f
const TOP_RETRACT = 12;                    // top hairline, outExpo 264–276
const CLICK = 12;                          // 276: tittle click (squash to 278)
const WAVE = 24, WAVE_STAGGER = 1, WAVE_HOLD = 8;   // 288: weight wave (1f stagger: §5.4 asks for ≈1.9 H and a hard crop; 2f peaks at 1.74 H)
const K_IN = 36;                           // 300: glass K swings in
const SHOCK = 48;                          // 312: K lands, shockwave
const FLIPS = [72, 78, 84, 87, 90, 93];    // 336, 342, 348, 351, 354, 357
const GLINT0 = 72, GLINT1 = 96;            // glint pulses on 16ths
const ANTIC = 93, LIFT0 = 94, TAKEOFF = 96; // 357–360 squash (the dot rises through the glass 358–360), 360 takeoff
const EXIT = 96, DROP_DUR = 5;             // 360–370: type drops through its slots (inExpo 5f per glyph, R→L, 1f stagger; gone as the hairlines finish)
const HL_RETRACT = 100, HL_DUR = 6;        // 364–370: middle and bottom hairlines retract (inExpo)
const KV = 96, KV_DUR = 8;                 // 360–368: rotate +90° about J, J → the V's inner vertex
const CUT = 99.5, CUT_DUR = 3;             // 363.5–366.5: stem slot cut (outExpo: bites on the 364 'shhk', the stem is gone before it can dive off the frame)
const HINGE = 102, HINGE_DUR = 4;          // 366–370: arm and leg fold to the V's wall angles
const FRONT = 100, FRONT_DUR = 8;          // 364–372 (§5.4): the V rises out of the folding K
const LAND = 108;                          // 372 landing, rest by 378
const TAIL_GLINT = 108, TAIL_GLINT_DUR = 24; // 372–395: one slow glint down the left bevel

const SHUTTER = 0.5;                       // engine shutter (frames)
const TYPE_Y0 = -0.40, TYPE_Y1 = 0.30;     // canvas band (H) holding both rows
const RISE_DY = 1.3 * 0.24;                // rows rise from −1.3 cap
const EXIT_DROP = 1.3 * 0.24;              // exit fall distance (mirrors the rise)
const DESC_PAD = 4 / 1080;                 // descender admission margin below the ink
const BEV = 0.035;                         // glass bevel width (H)
const MAG = 1.1;                           // lens magnification about its centre (§5.4: 1.3; 1.1 keeps the type continuous through the flat face, the bending lives in the bevel)
const SPLIT = 0.15;                        // type dispersion: the two samples at om·BEV·(1 ± SPLIT) (§5.4)
const MAG_D = 1.2, SPLIT_D = 0.07;         // the tittle seen through the glass: magnification, crescent split
const MAXG = 16;                           // glyphs per row in the shader arrays
const LOOK = { edgeLoss: 0.14, ramp: 1.2, keyLine: 1.6, rimPx: 2.0, rimBase: 0.85, rimKey: 0.9, face: 0.025, fresP: 2.0, edgeTint: 2.5, cobRim: 1.0, refr: 1.0 };
const POST = Object.freeze({ bloom: 0.25, vignette: 0.12 });
const GLINT_AXIS = (() => { const l = Math.hypot(0.55, -0.70); return [0.55 / l, -0.70 / l]; })();

// ── GLSL ────────────────────────────────────────────────────────────────────
const SIG = sys.PAL_LIN.COBALT.map(c => -Math.log(1 + (c - 1) * 0.08));   // 8% COBALT Beer–Lambert at h = 1
const COMMON = (ctx) => /* glsl */`${ctx.glsl.common}${sys.SYS_GLSL}
uniform vec2 uRes;
uniform vec4 uShock;                                     // (ox, oy, R, amplitude)
in vec2 vUv; out vec4 o;
const float BEV = ${glf(BEV)};
vec2 shockQ(vec2 q){
  if (uShock.w <= 0.0) return q;
  vec2 v = q - uShock.xy; float r = length(v); float x = r - uShock.z;
  float a = uShock.w * sin(40.0 * x) * exp(-60.0 * x * x);
  return q + (r > 1e-6 ? v / r : vec2(0.0)) * a;
}
vec2 toUv(vec2 q){ return vec2(q.x * uRes.y / uRes.x + 0.5, q.y + 0.5); }
// the shockwave's crest, seen: a thin ring of light at R (Gaussian, widened by its travel over
// the shutter), lifting the ground toward GRAPHITE and the type above BONE
uniform vec4 uRing;                                      // (ox, oy, R, strength)
uniform vec4 uRing2;                                     // σ (H)
float ringLum(vec2 q){
  if (uRing.w <= 0.0) return 0.0;
  float x = (length(q - uRing.xy) - uRing.z) / uRing2.x;
  return uRing.w * exp(-x * x);
}
vec3 bgColor(float c, float rl){ return mix(INK + (GRAPHITE - INK) * 1.6 * rl, BONE * (1.0 + 0.7 * rl), c); }
`;

// The dot: up to 4 sub-samples along its path within this render's slice of the shutter.
const DOT_GLSL = /* glsl */`
uniform vec4 uDot[4];    // centre xy, SDF scale (r·smallest semi-axis), 0
uniform vec4 uDotM[4];   // (r·S)⁻¹ as mat2 columns
uniform vec4 uDotP;      // count, lift (on top of the glass), refraction weight, on
uniform vec4 uDotB;      // bounding circle of all sub-samples: centre, radius
float dotCov1(vec2 q, vec4 c, vec4 m, float aa){
  vec2 l = mat2(m.xy, m.zw) * (q - c.xy);
  return clamp(0.5 - (length(l) - 1.0) * c.z / aa, 0.0, 1.0);
}
float dotCov(vec2 q, float aa){
  if (uDotP.w < 0.5 || length(q - uDotB.xy) > uDotB.z) return 0.0;
  int n = int(uDotP.x); float s = 0.0;
  for (int k = 0; k < 4; k++) { if (k >= n) break; s += dotCov1(q, uDot[k], uDotM[k], aa); }
  return s / float(n);
}
`;

// Pass 1, once per frame: background coverage. R = type (both rows, slot-clipped at their
// hairlines, smeared per glyph over the shutter), G = hairlines (left ends smeared).
const BG_FRAG = (ctx) => `${COMMON(ctx)}
uniform sampler2D uType; uniform vec4 uTypeBand;   // y0, y1, on, 0
uniform vec4 uGA[${2 * MAXG}];   // per glyph: path offsets from the canvas pose at shutter start (xy) and centre (zw)
uniform vec4 uGC[${2 * MAXG}];   // per glyph: offset at shutter end (xy), x where its zone starts, 0
uniform vec4 uGD[${2 * MAXG}];   // per glyph: descender admission depth, its x range, 0
uniform vec4 uRowN;              // glyph counts (row 1, row 2), smear taps (row 1, row 2)
uniform vec4 uLines;             // row 1 line y, row 2 line y
uniform vec4 uHL0, uHL1, uHL2;   // hairlines: y, left end at shutter start / centre / end
uniform vec4 uHLon;
float rowCov(vec2 q, int r, float lineY, float aa){
  int n = int(uRowN[r]); if (n <= 0) return 0.0;
  int b0 = r * ${MAXG};
  float cd = 0.0;
  for (int i = 0; i < ${MAXG}; i++) { if (i >= n) break; vec4 d = uGD[b0 + i]; if (q.x >= d.y && q.x <= d.z) cd = max(cd, d.x); }
  float m = clamp((q.y - (lineY - cd)) / aa + 0.5, 0.0, 1.0);    // the slot: nothing below the line
  if (m <= 0.0) return 0.0;
  vec4 A = uGA[b0]; vec2 B = uGC[b0].xy;
  for (int i = 1; i < ${MAXG}; i++) { if (i >= n) break; if (q.x >= uGC[b0 + i].z) { A = uGA[b0 + i]; B = uGC[b0 + i].xy; } }
  int K = int(uRowN[2 + r]);
  float sx = uRes.y / uRes.x, v0 = uTypeBand.x, dv = uTypeBand.y - uTypeBand.x, acc = 0.0;
  for (int k = 0; k < 128; k++) {
    if (k >= K) break;
    float t = (float(k) + 0.5) / float(K);
    vec2 off = t < 0.5 ? mix(A.xy, A.zw, 2.0 * t) : mix(A.zw, B, 2.0 * t - 1.0);
    vec2 c = q - off;
    float v = (c.y - v0) / dv;
    if (v > 0.0 && v < 1.0) { vec4 tx = textureLod(uType, vec2(c.x * sx + 0.5, v), 0.0); acc += r == 0 ? tx.r : tx.g; }
  }
  return m * min(acc / float(K), 1.0);
}
float rampR(float x, float a, float b, float aa){ float lo = min(a, b); return clamp((x - lo + 0.5 * aa) / (abs(b - a) + aa), 0.0, 1.0); }
float hlCov(vec2 q, vec4 h, float on, float aa){
  if (on < 0.5) return 0.0;
  float vy = clamp(0.5 - (abs(q.y - h.x) - PX_H) / aa, 0.0, 1.0);
  if (vy <= 0.0) return 0.0;
  return vy * 0.5 * (rampR(q.x, h.y, h.z, aa) + rampR(q.x, h.z, h.w, aa));
}
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y); float aa = 1.0 / uRes.y;
  vec2 q = shockQ(p);
  float t = 0.0;
  if (uTypeBand.z > 0.5) t = max(rowCov(q, 0, uLines.x, aa), rowCov(q, 1, uLines.y, aa));
  float hl = max(hlCov(q, uHL0, uHLon.x, aa), max(hlCov(q, uHL1, uHLon.y, aa), hlCov(q, uHL2, uHLon.z, aa)));
  o = vec4(t, hl, 0.0, 1.0);
}`;

// Pass 2, per sample: INK/BONE from the coverage, plus the dot (when uDotP.w).
const COMP_FRAG = (ctx) => `${COMMON(ctx)}${DOT_GLSL}
uniform sampler2D uBg;
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y); float aa = 1.0 / uRes.y;
  vec2 c = textureLod(uBg, vUv, 0.0).rg;
  vec3 col = bgColor(max(c.r, c.g), ringLum(p));
  if (uDotP.w > 0.5) col = mix(col, VERM, dotCov(shockQ(p), aa));
  o = vec4(col, 1.0);
}`;

// Pass 4b (full resolution, over the glass box) when the glass was shaded at half resolution:
// background + premultiplied glass + the dot.
const GCOMP_FRAG = (ctx) => `${COMMON(ctx)}${DOT_GLSL}
uniform sampler2D uBg; uniform sampler2D uGlassLo;
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y); float aa = 1.0 / uRes.y;
  vec2 c = textureLod(uBg, vUv, 0.0).rg;
  vec4 G = textureLod(uGlassLo, vUv, 0.0);
  vec3 col = bgColor(max(c.r, c.g), ringLum(p)) * (1.0 - G.a) + G.rgb;
  col = mix(col, VERM, dotCov(shockQ(p), aa) * (1.0 - G.a * (1.0 - uDotP.y)));
  o = vec4(col, 1.0);
}`;

// Pass 3 (half resolution, scissored to the glass box): the glass SDF d (H) and the slot-cut
// distance. The glass pass takes the bevel normal from central differences of this texture.
const PRE_FRAG = (ctx) => `${COMMON(ctx)}
uniform sampler2D uKTex; uniform vec4 uKMeta;
uniform sampler2D uVTex; uniform vec4 uVMeta;
uniform vec4 uKX;      // K pivot on screen (x, y), cos θ, sin θ
uniform vec4 uKQ;      // K pivot in cap units (x, y), cap, mode (1 K, 2 K→V front, 3 V)
uniform vec4 uCut;     // slot cut in K space: stem edge x, J.y, kept half-width, on
uniform vec4 uVP;      // V placement: cap, baseline, centreX, 0
uniform vec4 uFront;   // front y, half band, 0, 0
uniform vec4 uHinge;   // fold angle of the left (arm) and right (leg) side about J (rad), 0, 0
float smaxk(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
float sdK(vec2 p, out float dCut){
  vec2 v = p - uKX.xy;
  if (uHinge.x != 0.0 || uHinge.y != 0.0) {
    // arm and leg fold about J toward the V's wall angles (above J only; across J's vertical,
    // i.e. inside the notch, the two folds blend)
    float a = mix(uHinge.x, uHinge.y, smoothstep(-0.02, 0.02, v.x)) * smoothstep(-0.02, 0.04, v.y);
    float ca = cos(a), sa = sin(a); v = vec2(ca * v.x + sa * v.y, -sa * v.x + ca * v.y);
  }
  v = vec2(uKX.z * v.x + uKX.w * v.y, -uKX.w * v.x + uKX.z * v.y);   // R(−θ)
  vec2 q = uKQ.xy + v / uKQ.z;
  float d = glyphD(uKTex, uKMeta, q);
  float dr = max(q.x - uCut.x, uCut.z - abs(q.y - uCut.y));          // slot region, negative inside
  dCut = uCut.w > 0.5 ? -dr * uKQ.z : 1.0;
  return (uCut.w > 0.5 ? smaxk(d, -dr, 0.012) : d) * uKQ.z;
}
float sdV(vec2 p){ return glyphDist(uVTex, uVMeta, vec4(uVP.xyz, 0.0), p); }
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  float dCut = 1.0, d;
  if (uKQ.w > 2.5) d = sdV(p);
  else if (uKQ.w < 1.5) d = sdK(p, dCut);
  else {
    // the V below the rising front, the rotated K above it
    float wF = 1.0 - smoothstep(uFront.x - uFront.y, uFront.x + uFront.y, p.y);
    float dk = sdK(p, dCut);
    dCut = mix(dCut, 1.0, wF);
    d = mix(dk, sdV(p), wF);
  }
  o = vec4(d, dCut, 0.0, 1.0);
}`;

// Pass 4 (full resolution, scissored to the glass box).
const GLASS_FRAG = (ctx) => `${COMMON(ctx)}${DOT_GLSL}
uniform sampler2D uBg; uniform sampler2D uPre;
uniform vec2 uKc;      // lens centre
uniform vec4 uGlint;   // stripe position at the start and end of this render's shutter slice, gain, mode (1 pulses, 2 tail)
uniform vec4 uGlint2;  // σ, tail mask: x limit, 0, 0
uniform vec4 uRim;     // refraction strength (fades out as the K turns over), cut rim on, cut rim width (px), hairline refraction weight
uniform vec4 uMB1;     // glass motion between MB samples: pivot Δ (H), Δθ, 0
uniform vec4 uMB2;     // fold Δ (left, right), front Δy, front y
uniform vec4 uPiv;     // pivot (J or the ink centre), 1 = half-res pass (premultiplied glass only), 0
uniform vec4 uDotS;    // tittle through the glass: crescent split vector (H), magnification centre
const vec2 GA = vec2(${GLINT_AXIS[0].toFixed(7)}, ${GLINT_AXIS[1].toFixed(7)});
const vec3 SIG = vec3(${SIG.map(v => v.toFixed(7)).join(', ')});
const float EDGE_LOSS = ${glf(LOOK.edgeLoss)}, RAMP = ${glf(LOOK.ramp)}, KEY_LINE = ${glf(LOOK.keyLine)}, RIM_PX = ${glf(LOOK.rimPx)};
const float RIM_BASE = ${glf(LOOK.rimBase)}, RIM_KEY = ${glf(LOOK.rimKey)}, FACE = ${glf(LOOK.face)}, FRES_P = ${glf(LOOK.fresP)};
const float EDGE_TINT = ${glf(LOOK.edgeTint)}, COB_RIM = ${glf(LOOK.cobRim)};
const float REFR = ${glf(LOOK.refr)}, MAG = ${glf(MAG)}, MAG_D = ${glf(MAG_D)}, SPLIT = ${glf(SPLIT)};
const vec3 RIMD = vec3(${(() => { const v = [0.6, 0.3, -0.75], l = Math.hypot(...v); return v.map(x => (x / l).toFixed(7)).join(', '); })()});   // volume's COBALT rim light
float bgCov(vec2 q){ vec2 c = textureLod(uBg, toUv(q), 0.0).rg; return max(c.r, c.g * uRim.w); }
// The studio the bevels reflect (§5.4): a vertical GRAPHITE→BONE gradient, the key's soft
// highlight from the upper left (≤ 2.0) and, from behind on the right, volume's COBALT rim light.
vec3 envAt(vec3 r){
  r = normalize(r);
  vec3 e = mix(GRAPHITE, BONE, smoothstep(-0.35, 0.75, r.y));
  e += WARM * (2.0 - BONE.r) * pow(max(dot(r, KEY3), 0.0), 24.0);
  e += COBALT * COB_RIM * pow(max(dot(r, RIMD), 0.0), 6.0);
  return e;
}
// how far this pixel of glass travels between MB samples (design px): the pivot's translation,
// the rotation about it, the arm/leg fold about J and the K→V front
float mbSpread(vec2 p){
  vec2 v = p - uPiv.xy;
  vec2 dp = uMB1.xy + uMB1.z * vec2(-v.y, v.x);
  float fold = mix(abs(uMB2.x), abs(uMB2.y), step(0.0, v.x)) * length(v) * smoothstep(-0.02, 0.04, v.y);
  float u = (p.y - uMB2.w) / 0.15;
  float fr = abs(uMB2.z) * exp(-u * u);
  return (length(dp) + fold + fr) * 1080.0;
}
float erfA(float x){ float x2 = x * x; return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2))); }
// mean of exp(−((x − s)/σ)²) while s moves linearly from s0 to s1
float stripe(float x, float s0, float s1, float sg){
  float ds = s1 - s0;
  if (abs(ds) < 0.05 * sg) { float u = (x - 0.5 * (s0 + s1)) / sg; return exp(-u * u); }
  return 0.8862269 * sg * (erfA((x - s0) / sg) - erfA((x - s1) / sg)) / ds;
}
// The bevel's slope direction: the gradient of d smoothed over two rings (≈ 3 and 8 px), so the
// normal field is C1 (no stair-steps from the half-res SDF) and rounds over the creases of the
// mitred bevel (the medial axis at convex corners) instead of flipping across them. z = its
// length: 1 on a plain edge, < 1 on a crease.
vec3 gradS(vec2 uv){
  vec2 t = 1.0 / vec2(textureSize(uPre, 0));
  float th = 1.0 / float(textureSize(uPre, 0).y);
  vec2 g = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 0.7853982;
    vec2 u = vec2(cos(a), sin(a));
    g += (texture(uPre, uv + u * t * 1.5).x - texture(uPre, uv - u * t * 1.5).x) * u / (4.0 * 1.5 * th);
    g += (texture(uPre, uv + u * t * 4.0).x - texture(uPre, uv - u * t * 4.0).x) * u / (4.0 * 4.0 * th);
  }
  g *= 0.5;
  return vec3(g, length(g));
}
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y); float aa = 1.0 / uRes.y;
  vec2 c0 = textureLod(uBg, vUv, 0.0).rg;
  vec3 col = bgColor(max(c0.r, c0.g), ringLum(p));
  vec4 G = texture(uPre, vUv);
  float d = G.x;
  float cov = clamp(0.5 - d / aa, 0.0, 1.0);
  // (uniform control flow down to the refracted lookups: their footprint comes from derivatives)
  vec3 gg = gradS(vUv);
  vec2 g = gg.z > 1e-6 ? gg.xy / gg.z : vec2(0.0);
  float crease = smoothstep(0.35, 0.85, gg.z);
  // (the smoothed gradient already rounds the reflex corners: no curvature fade is needed)
  const float kfade = 1.0;
  float x = clamp(-d / BEV, 0.0, 1.0);
  float h = x * x * (3.0 - 2.0 * x);
  float dh = 6.0 * x * (1.0 - x) / BEV * crease;  // |∇h| (H⁻¹); flat along a crease's ridge
  vec3 n = normalize(vec3(g * dh * 0.9, 1.0));    // n = normalize(−∇h·0.9, 1): tilts outward
  // refraction, magnified about the lens centre; the two samples split along the VERM–COBALT
  // axis: light seen only by the short-λ sample is COBALT, only by the long-λ sample VERM.
  // Each is a 2×2 box over the pixel's footprint in the background (the bevel minifies it).
  float kr = uRim.x;
  // The offset follows the bevel's depth, (1 − x)², not n: it leaves the flat face without a fold
  // (§5.4's n·0.035 turns over 5× faster than the pixels at the bevel's inner edge, which mirrors
  // the type into hard seams); the compression gathers at the rim, as on a real glass edge.
  float om = REFR * (1.0 - x) * (1.0 - x) * mix(0.35, 1.0, crease);
  vec2 base = uKc + (p - uKc) / mix(1.0, MAG, kr), off = g * BEV * om * kfade * kr;
  vec2 qa = base + off * (1.0 + SPLIT), qb = base + off * (1.0 - SPLIT);
  vec2 jx = 0.25 * dFdx(qa), jy = 0.25 * dFdy(qa);
  float ca = 0.25 * (bgCov(qa + jx + jy) + bgCov(qa + jx - jy) + bgCov(qa - jx + jy) + bgCov(qa - jx - jy));
  float cb = 0.25 * (bgCov(qb + jx + jy) + bgCov(qb + jx - jy) + bgCov(qb - jx + jy) + bgCov(qb - jx - jy));
  if (cov <= 0.0) {
    if (uPiv.z > 0.5) { o = vec4(0.0); return; }
    col = mix(col, VERM, dotCov(shockQ(p), aa));
    o = vec4(col, 1.0); return;
  }
  float body = min(ca, cb);
  vec3 tr = bgColor(body, ringLum(base)) + (COBALT - INK) * (ca - body) + (VERM - INK) * (cb - body);
  float edge = 4.0 * h * (1.0 - h);
  tr *= 1.0 - EDGE_LOSS * edge;                    // the thick edge's internal loss
  // the tittle under the glass: seen whole through the lens (magnified about its own centre),
  // a VERM disc with a COBALT crescent split along the bevel normal at its centre
  if (uDotP.z > 0.0 && length(p - uDotS.zw) < uDotB.z * MAG_D + 0.02) {
    vec2 qd = uDotS.zw + (p - uDotS.zw) / MAG_D;
    float cV = dotCov(shockQ(qd), aa / MAG_D), cC = dotCov(shockQ(qd + uDotS.xy), aa / MAG_D);
    tr = mix(tr, VERM, cV * uDotP.z);
    tr = mix(tr, COBALT, max(cC - cV, 0.0) * uDotP.z);
  }
  // 8% COBALT Beer–Lambert tint driven by h; the bevel is seen through more glass, so it
  // tints more
  tr *= exp(-SIG * (h + EDGE_TINT * edge));

  // Fresnel against the studio. The reflection sees the bevel as a physical ramp (≈ 1.2 bevel
  // widths tall), not the lens's steep refraction normal; its falloff is softened (FRES_P < 5)
  // so the ramp reads as a band of reflected studio: BONE on the upper bevels, GRAPHITE on the
  // lower ones, COBALT where they face volume's rim light. The flat face carries a faint veil.
  vec3 nb = normalize(vec3(g * dh * BEV * RAMP, 1.0));
  float F = mix(FACE, 1.0, pow(1.0 - nb.z, FRES_P));
  vec3 glass = mix(tr, envAt(reflect(vec3(0.0, 0.0, -1.0), nb)), F);
  // (thin bright lines on fast-moving glass would strobe across MB samples: they widen to a
  // tent twice the local sample spacing, which sums evenly over the samples, and their gain
  // drops, like the energy of a real blurred line)
  float sp = mbSpread(p), rw = max(RIM_PX, 2.5 * sp), spreadK = RIM_PX / rw;
  float wMove = smoothstep(0.5 * RIM_PX, 1.5 * RIM_PX, 2.0 * sp);
  // bevel highlights: the key light on the ramp (Blinn): thin lines along key-facing edges
  vec3 hk = normalize(KEY3 + vec3(0.0, 0.0, 1.0));
  glass += WARM * KEY_LINE * spreadK * kfade * pow(max(dot(nb, hk), 0.0), mix(160.0, 30.0, 1.0 - spreadK)) * step(0.001, dh);
  // silhouette rim: a continuous band rw px wide inside the edge, brightest where the edge
  // faces the key
  float din = -d / PX_H;
  float rimFlat = clamp((d + RIM_PX * PX_H) / aa + 0.5, 0.0, 1.0);
  float rimTent = clamp(1.0 - abs(din - 0.5 * rw) / (0.5 * rw), 0.0, 1.0) * 2.0 * spreadK;
  float rim = clamp(mix(rimFlat, rimTent, wMove), 0.0, 1.0);
  float lit = max(dot(g, KEY2), 0.0);
  glass = mix(glass, BONE * (RIM_BASE + RIM_KEY * lit), rim);

  // glint: a light streak on the bevel, h(1−h)-shaped across it, the stripe across the glint
  // axis normalize(0.55, −0.70) integrated over the shutter
  if (uGlint.w > 0.5) {
    float st = stripe(dot(p - uKc, GA), uGlint.x, uGlint.y, uGlint2.x);
    float gli = edge * crease * st * 1.8 * uGlint.z;
    // the tail's slow glint runs down the left outer bevel only
    if (uGlint.w > 1.5) gli *= (1.0 - smoothstep(-0.45, -0.2, g.x)) * (1.0 - smoothstep(uGlint2.y - 0.01, uGlint2.y, p.x));
    glass += WARM * gli * kfade;
  }
  // 3px VERM rim along the slot cut (the cut is a wipe edge), widened like the silhouette rim
  if (uRim.y > 0.5) {
    float wpx = max(uRim.z, 2.5 * sp), w = wpx * PX_H;
    if (G.y < w + aa) {
      float band = clamp(0.5 - (abs(G.y + 0.5 * w) - 0.5 * w) / aa, 0.0, 1.0) * 3.0 / wpx;
      float tent = clamp(1.0 - abs(-G.y / PX_H - 0.5 * wpx) / (0.5 * wpx), 0.0, 1.0) * 6.0 / wpx;
      glass = mix(glass, VERM * 2.0, clamp(mix(band, tent, smoothstep(3.0, 6.0, wpx)), 0.0, 1.0));
    }
  }
  if (uPiv.z > 0.5) { o = vec4(glass * cov, cov); return; }
  col = mix(col, glass, cov);
  // the dot itself: visible where the glass does not cover it, and on top once it has risen
  col = mix(col, VERM, dotCov(shockQ(p), aa) * (1.0 - cov * (1.0 - uDotP.y)));
  o = vec4(col, 1.0);
}`;

export default {
  id: 'lens',

  init(ctx) {
    sys.initSys(ctx);
    const R = this.R = sys.roleLayout(ctx);
    this.TD = sys.T_DOT(ctx);
    this.NS = sys.NSTAR(ctx);
    this.K = sys.glyphSDF(ctx, sys.stationLetter(ctx, 2));
    this.V = sys.glyphSDF(ctx, sys.stationLetter(ctx, 3));
    const K = this.K, V = this.V;
    // J = O_K: scan q.y = 0.5 from inkR leftward (the arm/leg crotch); else the ink-box centre
    const ok = sys.scanInk(K, 0.5, K.inkX1, K.inkCx);
    this.QJ = ok != null ? [ok, 0.5] : [K.inkCx, K.inkCy];
    this.QC = [K.inkCx, K.inkCy];
    // The slot cut (364–368) removes the stem, which lies below J once the K is rotated. The
    // stem's right edge (cap units): scan q.y = 0.92 (above the arm's root) rightward from the
    // left ink edge. A letter without a separable left stem falls back to §5.4's rule: cut
    // whatever lies below J after the rotation (q.x < J.x).
    let sx = K.inkX0 + 0.01;
    while (sx < this.QJ[0] && sys.glyphD(K, sx, 0.92) <= 0) sx += 0.0025;
    this.cutX = sx + 0.02 < this.QJ[0] ? sx + 0.02 : this.QJ[0];

    // The V: its inner vertex (the notch bottom, on the two-wall ball axis x = inkCx + NOTCH_X)
    // is where the rotated K's crotch J lands, and its wall angles are where the K's arm and
    // leg fold to.
    const xN = V.inkCx + sys.NOTCH_X(ctx);
    let yv = V.inkY1;
    while (yv > 0 && sys.glyphD(V, xN, yv) > 0) yv -= 0.002;
    let lo = Math.max(yv, 0), hi = yv + 0.002;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (sys.glyphD(V, xN, m) > 0) hi = m; else lo = m; }
    const vIn = yv > 0 ? lo : V.inkCy;
    this.J1 = [(xN - V.inkCx) * sys.CAP_V2D, sys.BASE_V2D + vIn * sys.CAP_V2D];
    const wallX = (y, dir) => sys.scanInk(V, y, xN, dir < 0 ? V.inkX0 - 0.1 : V.inkX1 + 0.1);
    const angV = dir => { const a = wallX(vIn + 0.15, dir), b = wallX(vIn + 0.55, dir); return a != null && b != null ? Math.atan2(0.4, b - a) : Math.PI / 2 - dir * 0.3; };
    const edgeK = y => sys.scanInk(K, y, K.inkX1 + 0.1, K.inkX0);
    const angK = (y0, y1) => { const a = edgeK(y0), b = edgeK(y1); return a != null && b != null ? Math.atan2(y1 - y0, b - a) : null; };
    const arm = angK(0.70, 0.90), leg = angK(0.38, 0.10);   // K-space directions of the crotch's inner edges
    // after the +90° rotation the arm is the left side of the V, the leg the right side
    this.hingeL = arm != null ? angV(-1) - (arm + Math.PI / 2) : 0;
    this.hingeR = leg != null ? angV(1) - (leg + Math.PI / 2) : 0;
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    this.hingeL = clamp(wrap(this.hingeL), -0.9, 0.9); this.hingeR = clamp(wrap(this.hingeR), -0.9, 0.9);

    // measurement (1000 px reference; advances incl. kerning with the next glyph, like text.layout)
    this.mc = document.createElement('canvas').getContext('2d');
    this.mcache = new Map();

    // row 1 (w1): per-glyph fonts; row 2 (w2): static roleLayout positions
    const w1 = R.w1;
    this.w1 = w1.glyphs.map(g => g.ch);
    this.w1size = w1.size;
    this.line1 = w1.baseline ?? 0;
    this.serifSize = sys.sizeForCap(ctx, sys.SERIF_FONT, w1.cap);
    const n = this.w1.length;
    this.flipAt = this.w1.map((_, k) => n >= 6 ? FLIPS[Math.floor(k * 6 / n)] : FLIPS[n > 1 ? Math.round(k * 5 / (n - 1)) : 0]);
    // flip states: pens after each distinct flip frame (rest fonts), eased 4f outExpo from the next frame
    const frames = [...new Set(this.flipAt)].sort((a, b) => a - b);
    const restFonts = st => this.w1.map((_, k) => (this.flipAt[k] <= st ? 'serif' : { weight: 500, width: 100 }));
    let prev = this.pens(ctx, restFonts(-1));
    this.flipSteps = frames.map(fr => { const P = this.pens(ctx, restFonts(fr)); const dx = P.x.map((x, k) => x - prev.x[k]); prev = P; return { fr, dx }; });

    this.w2 = R.w2 ? R.w2.glyphs.map(g => ({ ch: g.ch, x: g.x })) : [];
    this.w2iIndex = R.w2 ? R.w2.iIndex : -1;
    this.line2 = R.w2 ? (R.w2.baseline ?? -0.30) : -0.30;

    // canvas band for the type
    this.bandH = Math.round((TYPE_Y1 - TYPE_Y0) * ctx.H);
    this.typeY1 = TYPE_Y0 + this.bandH / ctx.H;
    this.surf = ctx.surface(ctx.W, this.bandH);
    this.typeKey = '';

    // K→V geometry
    this.J0 = this.kPoint(0.40, -0.30, 0.5, 0, this.QC, this.QJ);        // O_K at rest
    const tS = SHOCK / 60, sp = ctx.ease.spring(tS - K_IN / 60, 2.4, 0.62);
    this.shockO = this.kPoint(0.40 + (1 - sp), -0.30, 0.5, -14 * D2R * (1 - sp), this.QC, this.QJ);
    this.vTop = sys.BASE_V2D + sys.CAP_V2D * V.inkY1;
    this.vBase = sys.BASE_V2D + sys.CAP_V2D * V.inkY0;
    this.vBox = [(V.inkX0 - V.inkCx) * sys.CAP_V2D, this.vBase, (V.inkX1 - V.inkCx) * sys.CAP_V2D, this.vTop];
    this.vC = [0, sys.BASE_V2D + sys.CAP_V2D * V.inkCy];
    // tail glint: from the top of the V's left bevel to its bottom, along the glint axis
    const pr = (x, y) => (x - this.vC[0]) * GLINT_AXIS[0] + (y - this.vC[1]) * GLINT_AXIS[1];
    const vbx = (V.inkX0 - V.inkCx) * sys.CAP_V2D;
    const lowX = sys.scanInk(V, 0.03, V.inkX0 - 0.1, xN);
    this.tailS = [pr(vbx, this.vTop) - 0.09, pr(lowX != null ? (lowX - V.inkCx) * sys.CAP_V2D : 0, this.vBase) + 0.06];
    this.tailX = this.J1[0] - 0.03;          // the tail glint stays left of the notch

    this.bgProg = ctx.program(BG_FRAG(ctx), 'lens:bg');
    this.compProg = ctx.program(COMP_FRAG(ctx), 'lens:comp');
    this.preProg = ctx.program(PRE_FRAG(ctx), 'lens:glass-sdf');
    this.glassProg = ctx.program(GLASS_FRAG(ctx), 'lens:glass');
    this.gcompProg = ctx.program(GCOMP_FRAG(ctx), 'lens:glass-comp');
    this.glassLo = ctx.fbo(Math.ceil(ctx.W / 2), Math.ceil(ctx.H / 2));   // fast glass, premultiplied
    this.bg = ctx.fbo(ctx.W, ctx.H);                                   // background coverage, per frame
    this.bgKey = null;
    this.pre = ctx.fbo(Math.ceil(ctx.W / 2), Math.ceil(ctx.H / 2), { internal: ctx.gl.RGBA32F, type: ctx.gl.FLOAT });   // fp32 (curvature), linear

    // motion-blur samples per frame: only where the glass moves, ≈5 px spacing, capped at §5.4's 6
    // (thin lines widen to the spacing in the shader; fast glass is shaded at half resolution)
    this.mbTable = [];
    for (let f = 0; f < 132; f++) {
      let N = 0;
      if ((f >= K_IN + 1 && f < SHOCK + 6) || (f >= KV && f < LAND)) {
        const a = this.glassState(ctx, f - 0.25), b = this.glassState(ctx, f + 0.25);
        const px = this.glassTravel(a, b) * ctx.H / ctx.scale;   // design px over the shutter
        N = clamp(Math.ceil(px / 5), 4, 6);   // §5.4: 6
      }
      this.mbTable.push(N);
    }
  },

  // screen position of K-space point qP for a K placed with its pivot qPiv at the transform
  // (ink-box centre X, baseline, cap, rotation θ about the ink-box centre)
  kPoint(X, base, cap, th, qPiv, qP) {
    const cx = X, cy = base + cap * this.K.inkCy;
    const vx = (qP[0] - qPiv[0]) * cap, vy = (qP[1] - qPiv[1]) * cap;
    const c = Math.cos(th), s = Math.sin(th);
    return [cx + c * vx - s * vy, cy + s * vx + c * vy];
  },

  // text measurement at 1000 px
  font1000(ctx, spec) {
    return spec === 'serif' || spec === 'w2' ? ctx.text.font({ ...sys.SERIF_FONT, size: 1000 }) : ctx.text.font({ family: 'Archivo', weight: spec.weight, width: spec.width, size: 1000 });
  },
  adv(ctx, spec, str) {
    const f = this.font1000(ctx, spec);
    const key = f + '|' + str;
    let v = this.mcache.get(key);
    if (v == null) { this.mc.font = f; v = this.mc.measureText(str).width / 1000; this.mcache.set(key, v); }
    return v;
  },
  // ink box of one glyph in em: [left of pen, right of pen, descent below baseline]
  inkEm(ctx, spec, ch) {
    const f = this.font1000(ctx, spec);
    const key = 'ink|' + f + '|' + ch;
    let v = this.mcache.get(key);
    if (v == null) { this.mc.font = f; const m = this.mc.measureText(ch); v = [m.actualBoundingBoxLeft / 1000, m.actualBoundingBoxRight / 1000, m.actualBoundingBoxDescent / 1000]; this.mcache.set(key, v); }
    return v;
  },
  fontSize(spec) { return spec === 'serif' ? this.serifSize : spec === 'w2' ? this.R.fs : this.w1size; },
  // pens of w1 for per-glyph fonts, centred on the advance width. Advance of glyph i includes
  // its kerning with glyph i+1, measured in glyph i's font.
  pens(ctx, fonts) {
    const ch = this.w1, n = ch.length, adv = [];
    for (let i = 0; i < n; i++) {
      const s = this.fontSize(fonts[i]);
      const a = i + 1 < n ? this.adv(ctx, fonts[i], ch[i] + ch[i + 1]) - this.adv(ctx, fonts[i], ch[i + 1]) : this.adv(ctx, fonts[i], ch[i]);
      adv.push(a * s);
    }
    const W = adv.reduce((a, b) => a + b, 0);
    const x = []; let acc = -W / 2;
    for (let i = 0; i < n; i++) { x.push(acc); acc += adv[i]; }
    return { x, adv, W };
  },

  // ── type ───────────────────────────────────────────────────────────────────
  waveFont(ctx, i, tf) {
    const sp = ctx.ease.spring;
    const tau = (tf - WAVE - WAVE_STAGGER * i) / 60;
    const a = sp(tau, 3.5, 0.45) - sp(tau - WAVE_HOLD / 60, 3.5, 0.45);
    return { weight: clamp(500 + 400 * a, 100, 900), width: ctx.text.snapWidth(clamp(100 + 25 * a, 100, 125)) };
  },

  // glyph poses of both rows at local time tf; fi latches the discrete states (fonts, flips)
  typePose(ctx, tf, fi) {
    const E = ctx.ease.ease, n1 = this.w1.length;
    const waveFonts = this.w1.map((_, i) => this.waveFont(ctx, i, tf));
    const P = this.pens(ctx, waveFonts);
    const xs = P.x.slice();
    // after each flip the word re-measures and re-centres with outExpo over 4f from the next frame
    // (from the moment its shutter opens, so the negative frame stays crisp and the smear is continuous)
    for (const st of this.flipSteps) { const k = E.outExpo((tf - st.fr - 1 + SHUTTER / 2) / 4); if (k > 0) for (let i = 0; i < n1; i++) xs[i] += st.dx[i] * k; }
    const rows = [
      this.w1.map((ch, i) => ({ ch, x: xs[i], font: fi > this.flipAt[i] ? 'serif' : this.waveFont(ctx, i, fi), neg: fi === this.flipAt[i], cellW: P.adv[i] })),
      this.w2.map(g => ({ ch: g.ch, x: g.x, font: 'w2' })),
    ];
    for (let r = 0; r < 2; r++) {
      const row = rows[r], n = row.length;
      row.forEach((g, k) => {
        const start = r === 1 && k === this.w2iIndex ? I_START : k;
        const e = tf < start ? 0 : E.outExpo((tf - start) / RISE_DUR);
        const dur = DROP_DUR;
        const xe = (tf - (EXIT + (n - 1 - k))) / dur;
        const drop = xe > 0 ? EXIT_DROP * E.inExpo(Math.min(xe, 1)) : 0;
        g.dy = -RISE_DY * (1 - e) - drop;
        g.start = start; g.dropping = xe > 0;
      });
    }
    return rows;
  },

  // the frame's type: canvas poses (the most visible of the shutter's start/centre/end poses)
  // plus each glyph's path relative to it
  typeFrame(ctx, fi, w) {
    const t0 = fi - w, t1 = fi + w;
    const P0 = this.typePose(ctx, t0, fi), Pm = this.typePose(ctx, fi, fi), P1 = this.typePose(ctx, t1, fi);
    const lines = [this.line1, this.line2], asc = [0.27, 0.30];
    const rows = [[], []];
    const restDy = 2 / 1080;
    for (let r = 0; r < 2; r++) {
      Pm[r].forEach((g, k) => {
        const a = P0[r][k], b = P1[r][k];
        const ys = [a.dy, g.dy, b.dy];
        if (Math.max(...ys) + asc[r] < -0.002) return;     // below its slot for the whole shutter
        const ai = ys.indexOf(Math.max(...ys));
        const anc = [a, g, b][ai];
        const ax = anc.x, ay = lines[r] + anc.dy;
        // descenders are admitted only at rest: the slot opens below the line over 3f once the
        // glyph is within 2 px of rest, and closes as soon as it starts to drop
        const spec = r === 0 ? g.font : 'w2';
        const size = this.fontSize(spec), ink = this.inkEm(ctx, spec, g.ch);
        const desc = Math.max(ink[2] * size, 0);
        let depth = 0;
        if (desc > 0.001 && !a.dropping) {
          const tRest = g.start + RISE_DUR * Math.log2(RISE_DY / restDy) / 10;
          depth = (desc + DESC_PAD) * clamp((t0 - tRest) / 3);
        }
        rows[r].push({
          ch: g.ch, font: g.font, neg: !!g.neg, cellW: g.cellW, x: ax, y: ay,
          A: [a.x - ax, a.dy - anc.dy], M: [g.x - ax, g.dy - anc.dy], B: [b.x - ax, b.dy - anc.dy],
          ink: [g.x - ink[0] * size - 0.01, g.x + ink[1] * size + 0.01], depth,
          cx: g.x + (r === 0 ? g.cellW : this.adv(ctx, 'w2', g.ch) * this.R.fs) / 2,
        });
      });
    }
    return rows;
  },

  drawType(ctx, rows) {
    const key = rows.map((row, r) => row.map(o => `${r}${o.ch}${typeof o.font === 'string' ? o.font : o.font.weight.toFixed(3) + '/' + o.font.width}${o.neg ? '!' : ''}:${o.x.toFixed(6)},${o.y.toFixed(6)}`).join(';')).join('|');
    if (key === this.typeKey) return;
    this.typeKey = key;
    const H = ctx.H, W = ctx.W, g = this.surf.clear();
    const Y1 = this.typeY1;
    const X = x => W / 2 + x * H, Y = y => (Y1 - y) * H;
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    for (let r = 0; r < 2; r++) {
      const color = r === 0 ? '#ff0000' : '#00ff00';
      for (const o of rows[r]) {
        const spec = r === 0 ? o.font : 'w2';
        let fs;
        if (spec === 'w2' || spec === 'serif') fs = ctx.text.font({ ...sys.SERIF_FONT, size: this.fontSize(spec) * H });
        else fs = ctx.text.font({ family: 'Archivo', weight: spec.weight, width: spec.width, size: this.w1size * H });
        g.save();
        g.fillStyle = color;
        g.globalCompositeOperation = 'lighter';
        if (o.neg) {
          // single negative frame: a Bone advance cell with the new (serif) glyph cut out in Ink
          g.fillRect(X(o.x), Y(o.y + 0.275), o.cellW * H, (0.275 + 0.035) * H);
          g.font = ctx.text.font({ ...sys.SERIF_FONT, size: this.serifSize * H });
          const sa = this.adv(ctx, 'serif', o.ch) * this.serifSize;
          g.globalCompositeOperation = 'destination-out';
          g.fillStyle = '#fff';
          g.fillText(o.ch, X(o.x + (o.cellW - sa) / 2), Y(o.y));
        } else {
          g.font = fs;
          g.fillText(o.ch, X(o.x), Y(o.y));
        }
        g.restore();
      }
    }
    // premultiplied upload: each channel is its row's coverage
    ctx.textureFrom(this.surf.canvas, { tex: this.surf.tex, premultiply: true });
  },

  // ── the frame's background (type + hairlines, analytic motion blur), cached per frame ──────
  hairlines(ctx, tf) {
    const E = ctx.ease.ease, xr = 0.8889 + 0.02;
    return [mix(-xr, xr, E.outExpo(tf / TOP_RETRACT)), mix(-xr, xr, E.inExpo((tf - HL_RETRACT) / HL_DUR))];
  },

  shockAt(tf) {
    const amp = tf >= SHOCK ? 0.012 * Math.exp(-(tf - SHOCK) / 10) : 0;
    return [this.shockO[0], this.shockO[1], 1.4 * Math.max(tf - SHOCK, 0) / 60, amp < 1e-5 ? 0 : amp];
  },

  // the crest's ring of light (strength ≤ 0.9, gone by ≈ 343), smeared analytically over the shutter
  ringAt(tf, w) {
    if (tf < SHOCK) return { ring: [0, 0, 0, 0], ring2: [0.004, 0, 0, 0] };
    const sg = 0.004, L = 1.4 * 2 * w / 60, se = Math.sqrt(sg * sg + L * L / 6);
    let k = 0.9 * Math.exp(-(tf - SHOCK) / 9) * sg / se;
    if (k < 0.03) k = 0;
    return { ring: [this.shockO[0], this.shockO[1], 1.4 * (tf - SHOCK) / 60, k], ring2: [se, 0, 0, 0] };
  },

  frameBackground(ctx, fi) {
    const key = fi;
    if (this.bgKey === key) return this.frame;
    const w = fi >= 1 ? SHUTTER / 2 : 0;      // the IN frame holds plane's OUT still
    const shock = this.shockAt(fi);
    const xr = 0.8889 + 0.02;
    const h0 = this.hairlines(ctx, fi - w), hm = this.hairlines(ctx, fi), h1 = this.hairlines(ctx, fi + w);
    const HL = [[0.30, h0[0], hm[0], h1[0]], [this.line1, h0[1], hm[1], h1[1]], [this.line2, h0[1], hm[1], h1[1]]];
    const HLon = HL.map(h => (Math.min(h[1], h[3]) < xr ? 1 : 0));
    const rows = fi < EXIT + 16 ? this.typeFrame(ctx, fi, w) : [[], []];
    const any = rows[0].length + rows[1].length > 0;
    if (any) this.drawType(ctx, rows);
    // per-glyph arrays (zones by centre midpoints) and the smear tap count per row
    const GA = new Float32Array(8 * MAXG), GC = new Float32Array(8 * MAXG), GD = new Float32Array(8 * MAXG);
    const rowN = [0, 0, 1, 1];
    const pxH = ctx.H;
    const boxes = [], pad = shock[3] + 0.006;
    for (let r = 0; r < 2; r++) {
      const row = rows[r].slice(0, MAXG);
      rowN[r] = row.length;
      let maxLen = 0, x0 = 9, x1 = -9;
      row.forEach((o, i) => {
        const j = (r * MAXG + i) * 4;
        GA.set([o.A[0], o.A[1], o.M[0], o.M[1]], j);
        const zone = i === 0 ? -9 : 0.5 * (row[i - 1].cx + o.cx);
        GC.set([o.B[0], o.B[1], zone, 0], j);
        GD.set([o.depth, o.ink[0], o.ink[1], 0], j);
        const len = Math.hypot(o.M[0] - o.A[0], o.M[1] - o.A[1]) + Math.hypot(o.B[0] - o.M[0], o.B[1] - o.M[1]);
        maxLen = Math.max(maxLen, len);
        const span = Math.max(Math.abs(o.A[0]), Math.abs(o.B[0]), Math.abs(o.M[0]));
        x0 = Math.min(x0, o.ink[0] - span - 0.02); x1 = Math.max(x1, o.ink[1] + span + 0.02);
        if (o.neg) { x0 = Math.min(x0, o.x - 0.01); x1 = Math.max(x1, o.x + o.cellW + 0.01); }
      });
      rowN[2 + r] = clamp(Math.ceil(maxLen * pxH / 1.25), 1, 128);
      if (row.length) {
        const ly = r === 0 ? this.line1 : this.line2, desc = Math.max(0, ...row.map(o => o.depth));
        boxes.push([x0, ly - desc - 0.004, x1, ly + (r === 0 ? 0.30 : 0.31)]);
      }
    }
    for (let i = 0; i < 3; i++) if (HLon[i]) boxes.push([Math.min(HL[i][1], HL[i][3]) - 0.004, HL[i][0] - 0.004, 0.95, HL[i][0] + 0.004]);
    const padded = boxes.map(b => [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
    const ring = this.ringAt(fi, w);
    // the ring is composed over its own box (the coverage pass does not need it)
    const cboxes = padded.slice();
    if (ring.ring[3] > 0) { const e = ring.ring[2] + 4 * ring.ring2[0]; cboxes.push([ring.ring[0] - e, ring.ring[1] - e, ring.ring[0] + e, ring.ring[1] + e]); }
    // render the coverage
    const gl = ctx.gl;
    this.bg.bind(); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const U = {
      uType: this.surf.tex, uTypeBand: [TYPE_Y0, this.typeY1, any ? 1 : 0, 0],
      uGA: GA, uGC: GC, uGD: GD, uRowN: rowN, uLines: [this.line1, this.line2, 0, 0],
      uHL0: HL[0], uHL1: HL[1], uHL2: HL[2], uHLon: [...HLon, 0], uShock: shock,
    };
    gl.enable(gl.SCISSOR_TEST);
    for (const b of padded) {
      const r = this.pxRect(ctx, b, ctx.W, ctx.H, 2);
      if (r[2] > 0 && r[3] > 0) { gl.scissor(...r); ctx.draw(this.bgProg, U, this.bg); }
    }
    gl.disable(gl.SCISSOR_TEST);
    this.bgKey = key;
    this.frame = { boxes: cboxes, shock, ring };
    return this.frame;
  },

  // pixel rect a minus pixel rect b (either may be null/empty): up to 4 rects
  subtract(a, b) {
    if (!(a[2] > 0 && a[3] > 0)) return [];
    if (!b || !(b[2] > 0 && b[3] > 0)) return [a];
    const ax1 = a[0] + a[2], ay1 = a[1] + a[3], bx1 = b[0] + b[2], by1 = b[1] + b[3];
    if (b[0] >= ax1 || bx1 <= a[0] || b[1] >= ay1 || by1 <= a[1]) return [a];
    const out = [], y0 = Math.max(a[1], b[1]), y1 = Math.min(ay1, by1);
    if (b[1] > a[1]) out.push([a[0], a[1], a[2], b[1] - a[1]]);
    if (by1 < ay1) out.push([a[0], by1, a[2], ay1 - by1]);
    if (b[0] > a[0]) out.push([a[0], y0, b[0] - a[0], y1 - y0]);
    if (bx1 < ax1) out.push([bx1, y0, ax1 - bx1, y1 - y0]);
    return out.filter(r => r[2] > 0 && r[3] > 0);
  },

  // H-unit box → GL pixel rect (bottom-left origin) of a w×h target, margin m px
  pxRect(ctx, bx, w, h, m) {
    const x0 = Math.max(0, Math.floor((bx[0] * ctx.H / ctx.W + 0.5) * w) - m), x1 = Math.min(w, Math.ceil((bx[2] * ctx.H / ctx.W + 0.5) * w) + m);
    const y0 = Math.max(0, Math.floor((bx[1] + 0.5) * h) - m), y1 = Math.min(h, Math.ceil((bx[3] + 0.5) * h) + m);
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  },

  // ── the dot ────────────────────────────────────────────────────────────────
  // ballistic hop T_DOT → NSTAR, apex 0.10 above the higher end; u ∈ [0,1]. Returns x, y, dx/du, dy/du.
  hop(u) {
    const T = this.TD, N = this.NS;
    const y0 = T.y, y1 = N.y, A = Math.max(y0, y1) + 0.10 - y0, B = y1 - y0;
    const s = Math.sqrt(2 * A) + Math.sqrt(Math.max(2 * A - 2 * B, 0));
    const g = s * s, v = Math.sqrt(2 * g * A);
    return [mix(T.x, N.x, u), y0 + v * u - 0.5 * g * u * u, N.x - T.x, v - g * u];
  },
  // R diag(st, 1/st) Rᵀ: a volume-preserving stretch along the velocity
  stretchAlong(vx, vy) {
    const st = 1 + 0.16 * clamp(Math.hypot(vx, vy) / 0.9);
    const ang = Math.atan2(vy, vx), c = Math.cos(ang), s = Math.sin(ang), a = st, b = 1 / st;
    return [a * c * c + b * s * s, (a - b) * c * s, (a - b) * c * s, a * s * s + b * c * c];
  },
  dotAt(ctx, tf) {
    const E = ctx.ease.ease, sp = ctx.ease.spring;
    const T = this.TD, N = this.NS;
    let cx = T.x, cy = T.y, r = T.r, S;
    const norm = M => { const det = M[0] * M[3] - M[1] * M[2], k = 1 / Math.sqrt(det); return M.map(v => v * k); };
    if (tf < TAKEOFF) {
      // tittle click (276–278, then the dot spring back); anticipation squash (357–360) on its bottom
      let amt = 0;
      if (tf >= CLICK) amt = tf < CLICK + 2 ? E.outQuad((tf - CLICK) / 2) : 1 - sp((tf - CLICK - 2) / 60, ...sys.SPRING_DOT);
      if (tf >= ANTIC) { amt = E.inOutSine((tf - ANTIC) / (TAKEOFF - ANTIC)); cy = T.y - r * 0.2 * amt; }
      S = [1 + 0.2 * amt, 0, 0, 1 - 0.2 * amt];
    } else if (tf < LAND) {
      const u = (tf - TAKEOFF) / (LAND - TAKEOFF);
      const [x, y, vx, vy] = this.hop(u);
      cx = x; cy = y;
      r = mix(T.r, N.r, E.outQuint(u));
      // squash (1.2, 0.8) → stretch along the velocity over the first 2f
      const Sv = this.stretchAlong(vx, vy), k = E.outCubic((tf - TAKEOFF) / 2);
      S = norm([mix(1.2, Sv[0], k), mix(0, Sv[1], k), mix(0, Sv[2], k), mix(0.8, Sv[3], k)]);
    } else {
      // landing: contact at exactly 372 with the flight's stretch, into the 1.25/0.8 squash
      // (peak at 373), a damped rebound, at rest by 378
      cx = N.x; cy = N.y; r = N.r;
      const tau = tf - LAND;
      const [, , vx, vy] = this.hop(1);
      const Se = this.stretchAlong(vx, vy), k = E.outCubic(clamp(tau / 1.0));
      let a = 0;
      if (tau < 1) a = E.outQuad(clamp(tau));
      else if (tau < 6) { const u = (tau - 1) / 5; a = Math.exp(-3 * u) * Math.cos(1.5 * Math.PI * u); }
      const Q = [1 + 0.25 * a, 0, 0, 1 - 0.2 * a];
      const B0 = [mix(Se[0], 1, k), mix(Se[1], 0, k), mix(Se[2], 0, k), mix(Se[3], 1, k)];
      S = norm([B0[0] * Q[0], B0[1] * Q[3], B0[2] * Q[0], B0[3] * Q[3]]);
      cy = N.y - 0.35 * r * 0.2 * a;
    }
    // ellipse = c + r·S·(unit circle); the shader maps back with M = (r·S)⁻¹ (column-major mat2)
    const det = S[0] * S[3] - S[1] * S[2];
    const inv = [S[3] / det, -S[1] / det, -S[2] / det, S[0] / det].map(v => v / r);   // row-major
    const M = [inv[0], inv[2], inv[1], inv[3]];                                        // → columns
    const tr = S[0] * S[0] + S[1] * S[1] + S[2] * S[2] + S[3] * S[3];
    const q = Math.sqrt(Math.max(tr * tr - 4 * det * det, 0));
    const smin = Math.sqrt(Math.max((tr - q) / 2, 1e-8)), smax = Math.sqrt(Math.max((tr + q) / 2, 1e-8));
    return { c: [cx, cy], M, R: r * smin, r, smax };
  },
  // the dot's layer: under the glass until it rises through it (358–360); on top from takeoff on
  dotLift(ctx, tf) { return tf >= TAKEOFF ? 1 : ctx.ease.ease.inOutSine((tf - LIFT0) / (TAKEOFF - LIFT0)); },

  // ── the glass ──────────────────────────────────────────────────────────────
  glassState(ctx, tf) {
    const E = ctx.ease.ease;
    const st = { mode: 0, KX: [0, 0, 1, 0], KQ: [0, 0, 1, 0], cut: [0, 0, 0, 0], front: [9, 0.04, 0, 0], hinge: [0, 0, 0, 0], box: [0, 0, 0, 0], Kc: [0, 0], th: 0, piv: [0, 0], cap: 0.5 };
    if (tf < K_IN) return st;
    const cap0 = 0.5, K = this.K;
    const boxOf = (piv, qPiv, cap, th) => [[K.inkX0, K.inkY0], [K.inkX1, K.inkY0], [K.inkX0, K.inkY1], [K.inkX1, K.inkY1]].map(qp => {
      const vx = (qp[0] - qPiv[0]) * cap, vy = (qp[1] - qPiv[1]) * cap, c = Math.cos(th), s = Math.sin(th);
      return [piv[0] + c * vx - s * vy, piv[1] + s * vx + c * vy];
    });
    let pts, Kc;
    const vb = this.vBox, vPts = [[vb[0], vb[1]], [vb[2], vb[3]]];
    if (tf < KV) {
      const spv = ctx.ease.spring((tf - K_IN) / 60, 2.4, 0.62);
      const X = 0.40 + 1.0 * (1 - spv), th = -14 * D2R * (1 - spv);
      const piv = [X, -0.30 + cap0 * K.inkCy];
      st.mode = 1; st.th = th; st.piv = piv; st.cap = cap0;
      st.KX = [piv[0], piv[1], Math.cos(th), Math.sin(th)];
      st.KQ = [this.QC[0], this.QC[1], cap0, 1];
      pts = boxOf(piv, this.QC, cap0, th);
      Kc = piv;
    } else {
      const eb = E.inOutBack(clamp((tf - KV) / KV_DUR), 1.3);
      const th = 90 * D2R * eb, cap = mix(cap0, sys.CAP_V2D, eb);
      const piv = [mix(this.J0[0], this.J1[0], eb), mix(this.J0[1], this.J1[1], eb)];
      st.mode = 1; st.th = th; st.piv = piv; st.cap = cap;
      st.KX = [piv[0], piv[1], Math.cos(th), Math.sin(th)];
      st.KQ = [this.QJ[0], this.QJ[1], cap, 1];
      pts = boxOf(piv, this.QJ, cap, th);
      const cvx = (this.QC[0] - this.QJ[0]) * cap, cvy = (this.QC[1] - this.QJ[1]) * cap;
      Kc = [piv[0] + Math.cos(th) * cvx - Math.sin(th) * cvy, piv[1] + Math.sin(th) * cvx + Math.cos(th) * cvy];
      if (tf >= CUT) {
        // slot mask over the (now horizontal) stem, sweeping from its ends toward J
        st.cut = [this.cutX, this.QJ[1], 0.49 * (1 - E.outExpo(clamp((tf - CUT) / CUT_DUR))), 1];
      }
      const hk = E.inOutCubic((tf - HINGE) / HINGE_DUR);
      if (hk > 0) { st.hinge = [this.hingeL * hk, this.hingeR * hk, 0, 0]; pts = pts.concat(vPts); }
      if (tf >= FRONT) {
        // §5.4's front formula puts the V BELOW the front, so the front rises: from below the V,
        // through J (its inner vertex) to above its top. The V grows up out of the folded K and its
        // notch walls close around the ball as it drops in at 372.
        const fx = E.inOutSine((tf - FRONT) / FRONT_DUR);
        st.mode = 2;
        st.front = [mix(this.vBase - 0.10, this.vTop + 0.05, fx), 0.04, 0, 0];
        Kc = [mix(Kc[0], this.vC[0], fx), mix(Kc[1], this.vC[1], fx)];
        pts = pts.concat(vPts);
        if (tf >= FRONT + FRONT_DUR) st.mode = 3;
      }
    }
    if (st.mode === 3 || tf >= LAND) { st.mode = 3; pts = vPts; Kc = this.vC.slice(); }
    st.KQ[3] = st.mode;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), m = 0.012;
    st.box = [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
    st.Kc = Kc;
    st.pts = pts;
    return st;
  },
  // how far the glass's edges travel between two states (H): the pivot's translation plus the
  // rotation at the glyph's reach, plus the front's travel
  glassTravel(a, b) {
    if (!a.mode || !b.mode) return 0;
    const dp = Math.hypot(b.piv[0] - a.piv[0], b.piv[1] - a.piv[1]);
    const dth = Math.abs(b.th - a.th) * 0.36 + Math.abs(b.hinge[0] - a.hinge[0]) * 0.3 + Math.abs(b.hinge[1] - a.hinge[1]) * 0.3;
    const df = a.mode === 2 || b.mode === 2 ? Math.abs(b.front[0] - a.front[0]) * 0.6 : 0;
    return dp + dth + df;
  },
  glint(tf, st) {
    const proj = st.pts.map(p => (p[0] - st.Kc[0]) * GLINT_AXIS[0] + (p[1] - st.Kc[1]) * GLINT_AXIS[1]);
    const s0 = Math.min(...proj) - 0.06, s1 = Math.max(...proj) + 0.06;
    if (tf >= GLINT0 && tf < GLINT1) return { s: mix(s0, s1, (tf - GLINT0) / 6 - Math.floor((tf - GLINT0) / 6)), mode: 1, wrap: [s0, s1] };
    if (tf >= TAIL_GLINT && tf < TAIL_GLINT + TAIL_GLINT_DUR) return { s: mix(this.tailS[0], this.tailS[1], (tf - TAIL_GLINT) / TAIL_GLINT_DUR), mode: 2 };
    return { s: 0, mode: 0 };
  },

  // the tittle's crescent split: the bevel normal at the dot's centre (K pose of this sample)
  dotSplit(st, c) {
    if (st.mode !== 1) return [0, 0];
    const K = this.K, cs = Math.cos(st.th), sn = Math.sin(st.th);
    const v = [c[0] - st.KX[0], c[1] - st.KX[1]];
    const q = [st.KQ[0] + (cs * v[0] + sn * v[1]) / st.cap, st.KQ[1] + (-sn * v[0] + cs * v[1]) / st.cap];
    const d = sys.glyphD(K, q[0], q[1]) * st.cap, e = 0.003;
    const gq = [sys.glyphD(K, q[0] + e, q[1]) - sys.glyphD(K, q[0] - e, q[1]), sys.glyphD(K, q[0], q[1] + e) - sys.glyphD(K, q[0], q[1] - e)];
    const gl = Math.hypot(gq[0], gq[1]); if (gl < 1e-9 || d >= 0) return [0, 0];
    const g = [(cs * gq[0] - sn * gq[1]) / gl, (sn * gq[0] + cs * gq[1]) / gl];
    const x = clamp(-d / BEV), dh = 6 * x * (1 - x) / BEV * 0.9, nxy = dh / Math.hypot(dh, 1);
    return [g[0] * nxy * BEV * SPLIT_D, g[1] * nxy * BEV * SPLIT_D];
  },

  render(ctx, s) {
    const fi = s.fi, tf = s.f, gl = ctx.gl, E = ctx.ease.ease;
    const frame = this.frameBackground(ctx, fi);
    // this render's slice of the shutter: one MB sample's share, or the whole shutter when the
    // engine does not supersample this frame (sub-sampled analytically below)
    const half = s.mbN > 1 ? SHUTTER / (2 * s.mbN) : (fi >= 1 ? SHUTTER / 2 : 0);
    const tc = s.mbN > 1 ? tf : fi;
    // dot sub-samples
    const moving = (tc >= CLICK - 1 && tc < CLICK + 6) || (tc >= ANTIC - 1 && tc < LAND + 7);
    const nd = moving && half > 0 ? 4 : 1;
    const ds = [];
    for (let k = 0; k < nd; k++) ds.push(this.dotAt(ctx, nd > 1 ? tc + ((k + 0.5) / nd - 0.5) * 2 * half : tc));
    const uDot = new Float32Array(16), uDotM = new Float32Array(16);
    ds.forEach((d, k) => { uDot.set([d.c[0], d.c[1], d.R, 0], 4 * k); uDotM.set(d.M, 4 * k); });
    const lift = this.dotLift(ctx, tc);
    let bx0 = 9, by0 = 9, bx1 = -9, by1 = -9;
    for (const d of ds) { const e = d.r * d.smax * 1.05 + 0.004 + frame.shock[3]; bx0 = Math.min(bx0, d.c[0] - e); bx1 = Math.max(bx1, d.c[0] + e); by0 = Math.min(by0, d.c[1] - e); by1 = Math.max(by1, d.c[1] + e); }
    const dotBox = [bx0, by0, bx1, by1];
    const uDotB = [(bx0 + bx1) / 2, (by0 + by1) / 2, Math.hypot(bx1 - bx0, by1 - by0) / 2, 0];
    const gs = this.glassState(ctx, tc);
    const glassOn = gs.mode > 0;
    const refr = glassOn && tc < TAKEOFF ? 1 - lift : 0;
    const dc = [ds.reduce((a, d) => a + d.c[0], 0) / nd, ds.reduce((a, d) => a + d.c[1], 0) / nd];
    const split = refr > 0 ? this.dotSplit(gs, dc) : [0, 0];
    const U = {
      uBg: this.bg.tex, uShock: frame.shock, uRing: frame.ring.ring, uRing2: frame.ring.ring2,
      uDot, uDotM, uDotP: [nd, lift, refr, 1], uDotS: [split[0], split[1], dc[0], dc[1]], uDotB,
    };
    // compose: INK everywhere (a clear), the background's content boxes and the dot's box, minus
    // the glass box (the glass pass shades that whole box itself)
    const I = sys.PAL_LIN.INK;
    const rg = glassOn ? this.pxRect(ctx, gs.box, ctx.W, ctx.H, 2) : null;
    s.target.bind();
    gl.clearColor(I[0], I[1], I[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    const compose = (box, u) => {
      for (const r of this.subtract(this.pxRect(ctx, box, ctx.W, ctx.H, 2), rg)) { gl.scissor(...r); ctx.draw(this.compProg, u, s.target); }
    };
    for (const b of frame.boxes) compose(b, { ...U, uDotP: [nd, lift, refr, 0] });
    compose(dotBox, U);
    if (glassOn) {
      const rp = this.pxRect(ctx, gs.box, this.pre.w, this.pre.h, 3);
      if (rg[2] > 0 && rg[3] > 0) {
        gl.scissor(...rp);
        ctx.draw(this.preProg, {
          uShock: frame.shock, uKTex: this.K.tex, uKMeta: sys.glyphMeta4(this.K), uVTex: this.V.tex, uVMeta: sys.glyphMeta4(this.V),
          uKX: gs.KX, uKQ: gs.KQ, uCut: gs.cut, uVP: [sys.CAP_V2D, sys.BASE_V2D, 0, 0], uFront: gs.front, uHinge: gs.hinge,
        }, this.pre);
        // glass motion between MB samples: thin lines widen to it (per pixel, in the shader)
        let MB1 = [0, 0, 0, 0], MB2 = [0, 0, 0, gs.front[0]], cutW = 3;
        if (s.mbN > 1) {
          const k = 1 / s.mbN, a = this.glassState(ctx, tf - k * SHUTTER / 2), b = this.glassState(ctx, tf + k * SHUTTER / 2);
          if (a.mode && b.mode) {
            MB1 = [b.piv[0] - a.piv[0], b.piv[1] - a.piv[1], b.th - a.th, 0];
            MB2 = [b.hinge[0] - a.hinge[0], b.hinge[1] - a.hinge[1], b.mode === 2 || a.mode === 2 ? b.front[0] - a.front[0] : 0, gs.front[0]];
            if (gs.cut[3] > 0) cutW = Math.max(3, Math.abs(a.cut[2] - b.cut[2]) * gs.cap * 1080 * 2);
          }
        }
        // glint, integrated over this render's shutter slice
        const g0 = this.glint(tc - half, gs), g1 = this.glint(tc + half, gs), gm = this.glint(tc, gs);
        let s0 = g0.s, s1 = g1.s;
        if (gm.mode === 1 && (g0.mode !== 1 || s1 < s0)) s0 = gm.wrap[0];   // a new pulse began inside the slice
        if (gm.mode === 1 && g1.mode !== 1) s1 = gm.s;
        if (gm.mode === 2 && g0.mode !== 2) s0 = gm.s;
        if (gm.mode === 2 && g1.mode !== 2) s1 = gm.s;
        const hlRefr = 1 - clamp((tc - (KV + 2)) / 2);    // hairlines stop refracting as the K turns over them
        // the lens lets go of the type as the K turns over (360–364): the rotating glass reads as
        // a clean silhouette over the exiting type, not a churn of refracted fragments
        const kRefr = 1 - E.inOutSine(clamp((tc - KV) / 4));
        const UG = {
          ...U, uPre: this.pre.tex, uKc: gs.Kc,
          uGlint: [s0, s1, 1, gm.mode], uGlint2: [gm.mode === 2 ? 0.045 : 0.03, this.tailX, 0, 0],
          uRim: [kRefr, gs.cut[3] > 0 && gs.cut[2] > 0 ? 1 : 0, cutW, hlRefr], uMB1: MB1, uMB2: MB2,
        };
        // fast glass (≥ 2.5 px between samples): shaded at half resolution, where the samples'
        // spacing hides it anyway, then composited at full resolution
        const fastPx = s.mbN > 1 ? this.glassTravel(this.glassState(ctx, tf - SHUTTER / (2 * s.mbN)), this.glassState(ctx, tf + SHUTTER / (2 * s.mbN))) * 1080 : 0;
        if (fastPx >= 2.5) {
          gl.scissor(...rp);
          ctx.draw(this.glassProg, { ...UG, uPiv: [gs.piv[0], gs.piv[1], 1, 0] }, this.glassLo);
          gl.scissor(...rg);
          ctx.draw(this.gcompProg, { ...U, uGlassLo: this.glassLo.tex }, s.target);
        } else {
          gl.scissor(...rg);
          ctx.draw(this.glassProg, { ...UG, uPiv: [gs.piv[0], gs.piv[1], 0, 0] }, s.target);
        }
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    ctx.setPost(s, POST);
  },

  // Motion blur: the type, hairlines, dot and glint are blurred analytically over the shutter
  // (every frame from 265 on), so the engine supersamples only while the glass itself moves:
  // the K swinging in (301–317) and K→V (360–371), with ≈5 px sample spacing (4–12; see
  // init). Frame 264 is the IN frame (identical to plane's OUT); the tail is still: no MB.
  mb(f) { return this.mbTable ? (this.mbTable[f] ?? 0) : 0; },

  postOut: POST,
};
