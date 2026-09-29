// full-stop passes (DIRECTION.md §5.8 Build). The composite is split into small draws, each
// scissored to the pixels it can touch and blended premultiplied over the previous ones (one large
// shader with the worlds inlined in a glyph loop compiles badly on SwiftShader):
//   paper     BONE with fibre, baked once at init and blitted                       full frame
//   world     an open window's world, once per output frame (read by all MB samples) the glyph's box
//   lines     the f768 ring (under the type) and the rule                           their boxes
//   glyph     one glyph at its live weight; an open window shows its world          one per glyph
//   row       one role/year glyph (slide + halftone print / type-on)                one per glyph
//   dot       the dot (squash/stretch ellipse)                                      dot box
//   dissolve  672–683: field's prevTex outside the growing halftone cells, 3px ring full frame
import * as sys from '../_sys.js';

const head = ctx => `${ctx.glsl.common}${ctx.glsl.noise}${ctx.glsl.sdf}${sys.SYS_GLSL}
uniform vec2 uRes;
in vec2 vUv; out vec4 o;
float PXS;                                   // one screen pixel in H (set first thing in main)
float fillAA(float d){ return clamp(0.5 - d / PXS, 0.0, 1.0); }
const float RIM = 3.0 * PX_H;                // window rims and the dissolve ring: 3px
// Temporal box filter inside one motion-blur sample: a boundary that moves linearly from a to b
// during the sample's time slice. Iaa is the antiderivative of the AA step clamp(0.5 + u/px);
// sweepIn(x, a, b) = the slice-average of 'x lies inside the boundary' (x < boundary), exact for
// the AA step, and the plain AA step when a == b.
float Iaa(float u){ float h = 0.5 * PXS; return u < -h ? 0.0 : (u > h ? u : (u + h) * (u + h) / (2.0 * PXS)); }
float sweepIn(float x, float a, float b){
  float d = b - a;
  if (abs(d) < 1e-7) return clamp(0.5 + (a - x) / PXS, 0.0, 1.0);
  return clamp((Iaa(b - x) - Iaa(a - x)) / d, 0.0, 1.0);
}
`;

// ── paper (baked once) ───────────────────────────────────────────────────────
export const paperSource = ctx => `${head(ctx)}
void main(){ vec2 p = P(vUv, uRes.x / uRes.y); o = vec4(BONE * (1.0 + paperFibre(p)), 1.0); }`;

// ── lines: the ring (768–780) and the rule, premultiplied VERM ──────────────
export const linesSource = ctx => `${head(ctx)}
uniform vec4 uRing;        // centre xy, radius at the slice start / end (H)
uniform float uRingW;      // ring width (H); 0 = off
uniform vec4 uRule;        // centre y, half width, tip x at the slice start / end (H)
uniform float uRuleX1;     // the rule's right end (H)
uniform float uRuleOn;
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  PXS = 1.0 / uRes.y;
  float a = 0.0;
  if (uRingW > 0.0) {        // its width tapers to 0 as it grows (coverage, not a fade)
    float rho = length(p - uRing.xy), h = 0.5 * uRingW;
    a = max(sweepIn(rho, uRing.z + h, uRing.w + h) - sweepIn(rho, uRing.z - h, uRing.w - h), 0.0);
  }
  if (uRuleOn > 0.0) {
    float cy = clamp((uRule.y - abs(p.y - uRule.x)) / PXS + 0.5, 0.0, 1.0);
    float cx = sweepIn(-p.x, -uRule.z, -uRule.w) * clamp((uRuleX1 - p.x) / PXS + 0.5, 0.0, 1.0);
    a = max(a, cy * cx);
  }
  if (a <= 0.0) discard;
  o = vec4(VERM * a, a);
}`;

// ── worlds: one program per world, rendered once per output frame into the glyph's box ──────
// (q in H from the glyph's ink-box centre, p screen). Uniform control flow here, so the posterised
// worlds antialias their thresholds with fwidth.
const worldFns = world => `
#define WORLD ${world}
#if WORLD == 0
// 0 LINE: VERM ground, Ink rows at 12px pitch, thickness 35–65% on a travelling sine
vec3 wLine(vec2 q, float t){
  float pitch = 12.0 * PX_H;
  float row = floor(q.y / pitch + 0.5);
  float th = pitch * (0.5 + 0.15 * sin(TAU * (q.x / 0.14 - t * 1.25) + row * 0.55));
  return mix(VERM, INK, fillAA(abs(q.y - row * pitch) - 0.5 * th));
}
#endif
#if WORLD == 1
// 1 PLANE: COBALT ground, BONE isolines (1/80 H) of a circle ∪ a rotating bar, 3px VERM zero contour
vec3 wPlane(vec2 q, float t){
  vec2 cc = vec2(0.030 * sin(t * 2.6 + 0.4), -0.022 + 0.020 * cos(t * 1.9));
  float d = min(length(q - cc) - 0.042, sdRoundBox2(rot2(0.9 + t * 1.7) * (q - vec2(0.004, 0.028)), vec2(0.095, 0.011), 0.004));
  float per = 1.0 / 80.0;
  float iso = abs(fract(d / per + 0.5) - 0.5) * per;
  vec3 c = mix(COBALT, BONE, fillAA(iso - 0.75 * PX_H));
  return mix(c, VERM, fillAA(abs(d) - 1.5 * PX_H));
}
#endif
#if WORLD == 2
// 2 LENS: BONE ground, the Ink module grid (20px pitch, 3px lines) magnified 1.3× and bulging to
// ≈2× in the middle of the glass (the lines swell and spread there, crowd toward the rim), drifting;
// toward the rim of the glass the paper darkens through a 6px 45° Ink halftone (the lens' falloff)
vec3 wLens(vec2 q, vec2 p, float t){
  float rr = dot(q, q) / (0.13 * 0.13);
  float mag = 1.3 * (1.0 + 0.55 * max(1.0 - rr, 0.0));
  vec2 g = q / mag + vec2(0.021, 0.013) * t;
  float pitch = 20.0 * PX_H;
  vec2 f = abs(fract(g / pitch + 0.5) - 0.5) * pitch;
  float line = fillAA((min(f.x, f.y) - 1.25 * PX_H) * mag);
  float fall = 0.50 * smoothstep(0.30, 1.35, rr);
  float ht = halftone45Rho(p, 6.0, fall, 1080.0 * PXS);
  return mix(BONE, INK, max(line, ht));
}
#endif
#if WORLD == 3
// 3 VOLUME: GRAPHITE → 0.6·COBALT gradient, a diagonal BONE specular band at 1.4 (hard-edged, with a
//   halftoned falloff: printed, not airbrushed), a half-module grid of 3px COBALT lines whose VERM
//   copy is offset 3px down on the horizontal lines only (the gradient carries the window)
vec3 wVolume(vec2 q, vec2 p, float t){
  // lit from the upper left: GRAPHITE in the lower third, rising to 0.6·COBALT at the top
  float gy = clamp(0.5 + q.y / 0.16 - 0.30 * q.x / 0.16, 0.0, 1.0);
  vec3 c = mix(GRAPHITE, 0.6 * COBALT, gy);
  float pitch = 30.0 * PX_H;
  vec2 gc = abs(fract(q / pitch + 0.5) - 0.5) * pitch;
  float gvy = abs(fract((q.y + 3.0 * PX_H) / pitch + 0.5) - 0.5) * pitch;
  c = mix(c, VERM, fillAA(gvy - 1.5 * PX_H));
  c = mix(c, COBALT, fillAA(min(gc.x, gc.y) - 1.5 * PX_H));
  // the specular band sweeping left to right from the moment the window opens: a hard 10px core,
  // then 6px halftone dots shrinking to nothing over 14px on either side
  float s = abs(dot(q, vec2(0.70710678, -0.70710678)) - (-0.20 + 0.40 * fract(t * 1.1)));
  float core = fillAA(s - 5.0 * PX_H);
  float fr = clamp(1.0 - (s - 5.0 * PX_H) / (14.0 * PX_H), 0.0, 1.0);
  float dots = fr > 0.0 ? halftone45Rho(p, 6.0, 0.62 * fr, 1080.0 * PXS) : 0.0;
  return mix(c, 1.4 * BONE, max(core, dots));
}
#endif
#if WORLD == 4
// 4 FLOW: posterised VERM/Ink marbling, flow's print model on 3-octave domain-warped fbm: pulled
//   bands of ink (≈50px period, about three across the letter's height) combed and swirled by the
//   warp; Ink prints through a 4px 45° halftone band (1/3 of flow's 12px screen)
float flowV(vec2 q, float t){
  vec2 x = q * 3.4;
  vec2 w = vec2(fbm3(vec3(x, t * 0.30)), fbm3(vec3(x + vec2(5.2, 1.3), t * 0.30 + 3.1)));
  return dot(q, vec2(0.30, 1.0)) / 0.050 + 1.9 * fbm3(vec3(x * 0.9 + 1.3 * w + vec2(0.0, -t * 0.40), t * 0.18)) - t * 0.35;
}
vec3 wFlow(vec2 q, vec2 p, float t){
  // the band phase and its per-pixel gradient from explicit neighbours (fwidth is per 2×2 quad on
  // SwiftShader, which stair-steps the contours); the phase is smooth, so the AA is exact to first order
  float v = flowV(q, t);
  float vx = flowV(q + vec2(PX_H, 0.0), t) - v, vy = flowV(q + vec2(0.0, PX_H), t) - v;
  float g = max(length(vec2(vx, vy)), 1e-5);          // phase per screen px
  // ink where the band's phase lies within ±0.20 of the crest: a signed distance in px
  float s = abs(fract(v) - 0.5);                        // 0 at the crest
  float inkS = clamp(0.5 + (0.20 - s) / g, 0.0, 1.0);
  // the print's halftone fringe: separate 4px dots in the VERM just outside the solid (never merging
  // into it, a 1-px VERM gap keeps the contour clean)
  float r = clamp((0.29 - s) / 0.09, 0.0, 1.0);
  float htI = halftone45Rho(p, 4.0, 0.36 * sqrt(r), 1080.0 * PXS) * clamp(0.5 + (s - 0.20) / g - 1.0, 0.0, 1.0);
  return mix(VERM, INK, max(inkS, htI));
}
#endif
#if WORLD == 5
// 5 FIELD: INK ground, flat VERM dust in pixel-aligned 3px cells, gathered in drifting clumps with
//   empty Ink between (≈40% of the cells occupied); a few cells flare to 1.6
vec3 wField(vec2 p, float t){
  vec2 cell = floor(p / (3.0 * PX_H));
  vec2 cp = (cell + 0.5) * 3.0 * PX_H;
  float dn = snoise(vec3(cp * vec2(26.0, 20.0) + vec2(0.0, -1.2 * t), 0.45 * t));
  float occ = 0.95 * smoothstep(-0.08, 0.26, dn);
  if (hash12(cell + 311.0) >= occ) return INK;
  float h2 = hash12(cell * 1.37 + 71.0);
  float fl = step(0.72, h2) * pow(0.5 + 0.5 * sin(TAU * (t * (0.8 + 1.4 * h2) + 5.0 * h2)), 12.0);
  return VERM * mix(1.0, 1.6, fl);
}
#endif
`;

export const worldSource = (ctx, world) => `${head(ctx)}
${worldFns(world)}
uniform vec4 uBox;         // the glyph's box (GL px): x, y, w, h
uniform vec2 uFull;        // frame size (px)
uniform vec2 uQ0;          // world origin (H): the glyph's ink-box centre
uniform float uT;          // seconds: the worlds' clock
uniform float uTL;         // seconds since this glyph's touch
void main(){
  PXS = 1.0 / uFull.y;
  vec2 p = (gl_FragCoord.xy + uBox.xy - 0.5 * uFull) / uFull.y;
  vec2 q = p - uQ0;
#if WORLD == 0
  vec3 c = wLine(q, uT);
#elif WORLD == 1
  vec3 c = wPlane(q, uT);
#elif WORLD == 2
  vec3 c = wLens(q, p, uT);
#elif WORLD == 3
  vec3 c = wVolume(q, p, uTL);
#elif WORLD == 4
  vec3 c = wFlow(q, p, uT);
#else
  vec3 c = wField(p, uT);
#endif
  o = vec4(c, 1.0);
}`;

// ── name ─────────────────────────────────────────────────────────────────────
export const glyphSource = (ctx, world) => `${head(ctx)}
#define WORLD ${world}
uniform sampler2D uAtlas; uniform vec2 uAtlasInv;
uniform vec4 uPA; uniform vec4 uRA; uniform vec4 uPB; uniform vec4 uRB;   // weight-blended fields (pen xy, inkCx, k) and clamp rects (atlas px)
uniform vec4 uG;           // ink centre x, baseline, cap, world id
uniform vec4 uGI;          // iris centre xy, radius at the slice start / end (H)
uniform vec4 uShut;        // shutter y (H) at the slice start / end, on
uniform sampler2D uWorld;  // this frame's world, laid out over the glyph's box
uniform vec4 uBox;         // the glyph's box (GL px)
uniform float uWorldDx;    // px: the glyph's sideways push since the world was laid out
uniform float uSlam;       // H: the slam's ink band inside the window rim (the heavier silhouette)
const float CAPPX = ${sys.GLYPH_CAP_PX.toFixed(1)};

float slotD(vec4 pen, vec4 rect, vec2 qc){
  vec2 x = pen.xy + vec2(qc.x + pen.z, qc.y) * CAPPX;
  vec2 c = clamp(x, rect.xy + 0.5, rect.zw - 0.5);
  return textureLod(uAtlas, c * uAtlasInv, 0.0).r + length(x - c);
}
// signed distance (H) to the glyph at its live weight, ink box centred on its fixed centre
float gD(vec2 p){
  vec2 qc = vec2(p.x - uG.x, p.y - uG.y) / uG.z;
  float d = slotD(uPA, uRA, qc);
  if (uPA.w > 0.0) d = mix(d, slotD(uPB, uRB, qc), uPA.w);
  return d * (uG.z / CAPPX);
}

void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  PXS = 1.0 / uRes.y;
  float d = gD(p);
  float cov = fillAA(d);
  if (cov <= 0.0) discard;
  vec3 g = INK;
#if WORLD >= 0
  float rho = length(p - uGI.xy);
  float win = sweepIn(rho, uGI.z, uGI.w);              // the iris (time-filtered within the MB sample)
  float shut = 1.0, rimS = 0.0;
  if (uShut.z > 0.0) {                                  // windows stay only above the shutter; its edge is a 3px VERM line
    shut = sweepIn(-p.y, -uShut.x, -uShut.y);                          // above the (moving) shutter
    rimS = max(shut - sweepIn(-p.y, -uShut.x - RIM, -uShut.y - RIM), 0.0);
  }
  float w = win * shut;
  float dW = d + uSlam;                                 // the window's edge, inset by the slam's ink band
  if (w > 0.0) {
    ivec2 tc = clamp(ivec2(gl_FragCoord.xy) - ivec2(uBox.xy) - ivec2(int(floor(uWorldDx + 0.5)), 0), ivec2(0), ivec2(uBox.zw) - 1);
    vec3 wc = texelFetch(uWorld, tc, 0).rgb;
#if WORLD == 2
    // the glass bevel: a 4px dispersion split inside the rim, COBALT on the edges that face the key
    // light and VERM on the others (a hard edge where the facing flips); laid under the rim, no seam
    float e = 1.5 * PX_H, BEV = 4.0 * PX_H;
    vec2 nrm = vec2(gD(p + vec2(e, 0.0)) - d, gD(p + vec2(0.0, e)) - d);
    nrm /= max(length(nrm), 1e-9);
    float lit = clamp(0.5 + dot(nrm, KEY2) * BEV / PXS, 0.0, 1.0);
    wc = mix(wc, mix(VERM, COBALT, lit), 1.0 - fillAA(d + RIM + BEV));
#elif WORLD == 5
    wc = mix(INK, wc, fillAA(d + 2.0 * RIM));           // a 3px Ink gap inside the rim: the letter's edge survives the dust
#endif
    float rimG = 1.0 - fillAA(dW + RIM);                // 3px inner rim along the glyph edge
    float rimI = max(win - sweepIn(rho, uGI.z - RIM, uGI.w - RIM), 0.0);   // the iris edge
    wc = mix(wc, VERM, clamp(max(rimG, max(rimI, rimS)), 0.0, 1.0));
    g = mix(INK, wc, w * (uSlam > 0.0 ? fillAA(dW) : 1.0));
  }
#endif
  o = vec4(g * cov, cov);
}`;

// ── role line and year ───────────────────────────────────────────────────────
export const rowSource = ctx => `${head(ctx)}
uniform sampler2D uRole; uniform vec2 uRoleSize; uniform float uRoleX0; uniform float uRoleRH;
uniform vec4 uRow;         // dY (screen y_top − canvas y), slide (px, up), row top (canvas px), halftone rho (≥ .7071 solid)
uniform float uSlideH;     // slide (H)
uniform float uMaskY;      // role glyphs show only below the rule: y < rule.y − 3px (H)
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  PXS = 1.0 / uRes.y;
  vec2 fc = gl_FragCoord.xy;
  vec2 c = vec2(fc.x - uRoleX0, uRes.y - fc.y + uRow.y - uRow.x);
  if (c.y < uRow.z || c.y > uRow.z + uRoleRH) discard;
  float a = textureLod(uRole, vec2(c.x / uRoleSize.x, 1.0 - c.y / uRoleSize.y), 0.0).a;
  if (uRow.w < 0.7071) a *= halftone45Rho(p - vec2(0.0, uSlideH), 6.0, uRow.w, 1080.0 * PXS);
  a *= clamp((uMaskY - p.y) / PXS + 0.5, 0.0, 1.0);
  if (a <= 0.0) discard;
  o = vec4(INK * a, a);
}`;

// ── the dot ──────────────────────────────────────────────────────────────────
export const dotSource = ctx => `${head(ctx)}
uniform vec4 uDotC[4];     // centre xy, r: four sub-positions inside the MB sample's time slice
uniform vec4 uDotM[4];     // inverse deformations (mat2, column-major)
float cover(vec2 p, vec4 C, vec4 Mv){
  mat2 Mi = mat2(Mv.xy, Mv.zw);
  vec2 q = Mi * (p - C.xy);
  float l = length(q);
  vec2 g = (q / max(l, 1e-7)) * Mi;                     // ∇|Mi·d|
  return fillAA((l - C.z) / max(length(g), 1e-4));
}
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  PXS = 1.0 / uRes.y;
  float a = 0.25 * (cover(p, uDotC[0], uDotM[0]) + cover(p, uDotC[1], uDotM[1]) + cover(p, uDotC[2], uDotM[2]) + cover(p, uDotC[3], uDotM[3]));
  if (a <= 0.0) discard;
  o = vec4(VERM * a, a);
}`;

// ── the dissolve (premultiplied over the crisp layer) ────────────────────────
// final = mix(mix(prev, crisp, cov), VERM·v, ring): src.rgb = prev·(1−cov)(1−ring) + VERM·v·ring,
// src.a = 1 − cov·(1 − ring).
export const dissolveSource = ctx => `${head(ctx)}
uniform sampler2D uPrev;
uniform vec4 uDiss;        // global frame, ring value, S0 xy
void main(){
  vec2 p = P(vUv, uRes.x / uRes.y);
  PXS = 1.0 / uRes.y;
  // disc k covers in_k; its 3px ring band shows only where no OTHER disc covers the pixel, so
  // rings are cut away as the discs merge (the final 0.75c discs overlap each corner by < 3px, so
  // a union-SDF ring would never clear there)
  const float c = 1.0 / 18.0;
  vec2 cell = floor(p / c);
  float in1 = 0.0, in2 = 0.0, ring = 0.0, bandTop = 0.0;
  float ins[9], bands[9];
  for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) {
    int idx = (j + 1) * 3 + (k + 1);
    vec2 cc = (cell + vec2(float(k), float(j)) + 0.5) * c;
    float u = (uDiss.x - (672.0 + length(cc - uDiss.zw) / 0.24)) / 5.0;
    float rad = 0.75 * c * easeOutExpo(u);
    float d = u > 0.0 ? length(p - cc) - rad : 1e9;
    float a = fillAA(d);
    // the ring rides the front: it narrows to nothing as the disc passes 0.56c → 0.66c (the cell's
    // half-diagonal is 0.707c), so no hairline VERM crosses survive in the wake at the cell corners
    float rw = RIM * clamp((0.66 * c - rad) / (0.10 * c), 0.0, 1.0);
    ins[idx] = a; bands[idx] = rw > 0.0 ? a - fillAA(d + rw) : 0.0;
    if (a > in1) { in2 = in1; in1 = a; } else if (a > in2) in2 = a;
  }
  for (int i = 0; i < 9; i++) ring = max(ring, bands[i] * (1.0 - (ins[i] >= in1 ? in2 : in1)));
  float cov = in1 + in2 * (1.0 - in1);                  // ≈ union coverage (exact where discs are apart or deep)
  cov = max(cov, in1);
  vec3 prev = texture(uPrev, vUv).rgb;
  o = vec4(prev * (1.0 - cov) * (1.0 - ring) + VERM * uDiss.y * ring, 1.0 - cov * (1.0 - ring));
}`;
