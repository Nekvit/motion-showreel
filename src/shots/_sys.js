// _sys.js: the shared system every shot imports (DIRECTION.md §1.1, §1.2, §2.3; package 9).
//
// Pure and deterministic. Nothing here touches the DOM at import time; functions that
// need fonts or a GL context take `ctx` (the engine ctx) and cache their results.
// Full reference with signatures, units and measured values: SYS.md.
//
// Units: H = frame height. Screen coords p = (vUv - 0.5) * (aspect, 1); y up.
// "cap units" = multiples of a glyph's cap height, measured from the pen origin on the baseline.
// "px" constants are 1080p design pixels (1px = 1/1080 H); multiply by ctx.scale for real pixels.

import { common as GLSL_COMMON } from '../glsl.js';
import { sdfFromAlpha } from '../sdf.js';

// ─────────────────────────────────────────────────────────────────────────────
// Palette (§1.2)
// ─────────────────────────────────────────────────────────────────────────────

/** sRGB hex strings, usable directly as canvas fillStyle. */
export const PAL = Object.freeze({
  INK: '#0E0E12',
  BONE: '#F1EBDF',
  VERM: '#FF3A1F',
  COBALT: '#2233FF',
  GRAPHITE: '#26262B',
});

const hexToSrgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Exact piecewise sRGB EOTF (sRGB-coded 0..1 → linear). */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Exact piecewise sRGB OETF (linear → sRGB-coded 0..1). */
export function linearToSrgb(l) {
  l = Math.max(0, l);
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

/** sRGB-coded [r,g,b] in 0..1 (e.g. for post.flashColor, which is applied after the tonemap). */
export const PAL_SRGB = Object.freeze(Object.fromEntries(Object.entries(PAL).map(([k, h]) => [k, Object.freeze(hexToSrgb(h))])));
/** Linear [r,g,b] from the exact sRGB EOTF (the §1.2 "Linear" column). Author scene colours with these. */
export const PAL_LIN = Object.freeze(Object.fromEntries(Object.entries(PAL_SRGB).map(([k, c]) => [k, Object.freeze(c.map(srgbToLinear))])));
/** Warm white: the PRINT tonemap's roll-off target (linear). Only for HDR speculars (e.g. 2.2·WARM), never a fill. */
export const WARM_LIN = Object.freeze([1.0, 0.955, 0.90]);

// ─────────────────────────────────────────────────────────────────────────────
// Units, light, timing (§1.1, §1.4, §1.5, §2.3)
// ─────────────────────────────────────────────────────────────────────────────

/** One module c = 1/18 H (60 design px). */
export const C_MOD = 1 / 18;
/** One design pixel in H units (1/1080). */
export const PX = 1 / 1080;
/** 2D key-light direction (towards the light, upper left): normalize(-1, 1). */
export const KEY2 = Object.freeze([-Math.SQRT1_2, Math.SQRT1_2]);
/** 3D direction to the key light: normalize(-0.55, 0.70, 0.45). */
export const KEY3 = Object.freeze((() => { const v = [-0.55, 0.70, 0.45], l = Math.hypot(...v); return v.map(x => x / l); })());
/** 2D hard-shadow offset in design px (+6, -6) and its halftone (§1.4). */
export const SHADOW_PX = Object.freeze([6, -6]);
export const SHADOW_CELL_PX = 8;
export const SHADOW_COVER = 0.35;

/** Grid timing in frames (150 BPM at 60 fps). */
export const F32 = 3, F16 = 6, F8 = 12, BEAT = 24, BAR = 96;

/** Springs of the motion language (§1.5): [freqHz, zeta] for ctx.ease.spring(t, f, z). */
export const SPRING_DOT = Object.freeze([3.0, 0.48]);
export const SPRING_TYPE = Object.freeze([3.5, 0.45]);

/** HUD labels. Station k (letter k of the name) maps to FIG[k+1]. */
export const FIG = Object.freeze(['FIG. 0 — POINT', 'FIG. 1 — LINE', 'FIG. 2 — PLANE', 'FIG. 3 — LENS', 'FIG. 4 — VOLUME', 'FIG. 5 — FLOW', 'FIG. 6 — FIELD', 'FIG. 7 — FULL STOP']);

/** Paper push shared by `point` and `line`: 1 + 0.0004·min(frame, 168). Accepts fractional frames. */
export function paperZ(frame) { return 1 + 0.0004 * Math.min(Math.max(frame, 0), 168); }

// ─────────────────────────────────────────────────────────────────────────────
// Stem widths (§2.3 STEM): stem ÷ cap for Archivo wdth 100
// ─────────────────────────────────────────────────────────────────────────────

const STEM_TABLE = Object.freeze([[100, 0.079], [200, 0.094], [300, 0.115], [400, 0.139], [500, 0.163], [700, 0.218], [850, 0.292], [900, 0.322]].map(Object.freeze));
/** Stem width ÷ cap at `wght`, linear between the table entries, clamped to [100, 900]. */
export function stemRatio(wght) {
  const t = STEM_TABLE;
  if (wght <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (wght <= t[i][0]) { const [w0, s0] = t[i - 1], [w1, s1] = t[i]; return s0 + (s1 - s0) * (wght - w0) / (w1 - w0); }
  }
  return t[t.length - 1][1];
}
/** STEM(wght) === stemRatio(wght); STEM.table = [[wght, ratio], ...]. */
export const STEM = Object.assign(wght => stemRatio(wght), { table: STEM_TABLE });

// ─────────────────────────────────────────────────────────────────────────────
// Volume camera constants (§2.3), shared by `lens` and `volume`
// ─────────────────────────────────────────────────────────────────────────────

/** Ball radius in cap units = wu (0.073 H ÷ cap 0.50). Also the V's half depth. */
export const BALL_R = 0.146;
/** Vertical FOV at f384, in DEGREES (12°). Use VOL_FOV0_RAD for mat4.perspective / camRay. */
export const VOL_FOV0 = 12;
export const VOL_FOV0_RAD = VOL_FOV0 * Math.PI / 180;
/** Eye distance at f384: 1/tan(6°) ≈ 9.5144 wu, so the plane z = 0 spans 1 wu = 0.5 H. */
export const VOL_D0 = 1 / Math.tan(VOL_FOV0_RAD / 2);
/** Eye height and look-at height (wu). At yaw 0 world (x, y, 0) maps to screen 0.5·(x, y − 0.6). */
export const VOL_EYE_Y = 0.6;
/** Front-face (z = +0.146) scale: VOL_D0 / (VOL_D0 − 0.146) ≈ 1.01558. */
export const S_FRONT = VOL_D0 / (VOL_D0 - BALL_R);
/** Cap height (H) and baseline y (H) of the V's front face as `volume` projects it at f384. */
export const CAP_V2D = 0.5 * S_FRONT;
export const BASE_V2D = -0.30 * S_FRONT;

// ─────────────────────────────────────────────────────────────────────────────
// Clean mode (?clean=1 → no paper fibre); used by SYS_GLSL via uniform uSysClean
// ─────────────────────────────────────────────────────────────────────────────

/** True when rendering an acceptance frame (?clean=1): ctx.clean, ctx.config.clean, ctx.post.clean or the URL. */
export function isClean(ctx) {
  if (ctx) {
    if (ctx.clean != null) return !!ctx.clean;
    if (ctx.config && ctx.config.clean != null) return !!ctx.config.clean;
    if (ctx.post && ctx.post.clean != null) return !!ctx.post.clean;
  }
  try { const q = new URLSearchParams(globalThis.location?.search || ''); return q.has('clean') && q.get('clean') !== '0'; } catch { return false; }
}
/** Uniforms that SYS_GLSL reads. Spread into every ctx.draw that uses paperFibre: {...sysUniforms(ctx)}. */
export function sysUniforms(ctx) { return { uSysClean: isClean(ctx) ? 1 : 0 }; }

// ─────────────────────────────────────────────────────────────────────────────
// Halftone radius (JS mirror of the GLSL halftoneRho)
// ─────────────────────────────────────────────────────────────────────────────

// Ink fraction of one square cell covered by a centred disc of radius rho (cell units).
// Neighbouring discs only overlap inside each other's discs, so this is also the
// union coverage of the whole screen.
function discCellCover(rho) {
  if (rho <= 0.5) return Math.PI * rho * rho;
  if (rho >= Math.SQRT1_2) return 1;
  return Math.PI * rho * rho - 4 * (rho * rho * Math.acos(0.5 / rho) - 0.5 * Math.sqrt(rho * rho - 0.25));
}
/** Dot radius in cell units (0 … √½ = solid) whose screen covers `cover` (0..1) of the area. */
export function halftoneRho(cover) {
  if (cover <= 0) return 0;
  if (cover >= 1) return Math.SQRT1_2;
  if (cover <= Math.PI / 4) return Math.sqrt(cover / Math.PI);
  let lo = 0.5, hi = Math.SQRT1_2;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (lo + hi); if (discCellCover(m) < cover) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}

// ─────────────────────────────────────────────────────────────────────────────
// GLSL chunk
// ─────────────────────────────────────────────────────────────────────────────

const f = x => { const s = (+x).toPrecision(9); return s.includes('.') || s.includes('e') ? s : s + '.0'; };
const v3 = a => `vec3(${a.map(f).join(', ')})`;

/**
 * GLSL chunk. Self-contained: it includes glsl.js `common` (guarded) and its own hash.
 * Include once or many times, before or after ctx.glsl.*: `${ctx.glsl.all}${SYS_GLSL}`.
 * Declares `uniform float uSysClean;` (pass {...sysUniforms(ctx)}; unset = 0 = fibre on).
 */
export const SYS_GLSL = GLSL_COMMON + /* glsl */`
#ifndef SR_SYS
#define SR_SYS
// Palette, linear (exact sRGB EOTF of the §1.2 hexes)
const vec3 INK      = ${v3(PAL_LIN.INK)};
const vec3 BONE     = ${v3(PAL_LIN.BONE)};
const vec3 VERM     = ${v3(PAL_LIN.VERM)};
const vec3 COBALT   = ${v3(PAL_LIN.COBALT)};
const vec3 GRAPHITE = ${v3(PAL_LIN.GRAPHITE)};
const vec3 WARM     = ${v3(WARM_LIN)};     // tonemap roll-off white; HDR speculars only, never a fill
const vec2 KEY2 = vec2(${f(KEY2[0])}, ${f(KEY2[1])});   // normalize(-1, 1)
const vec3 KEY3 = ${v3(KEY3)};                          // normalize(-0.55, 0.70, 0.45)
const float C_MOD = ${f(C_MOD)};                         // 1/18 H
const float PX_H  = ${f(PX)};                            // one design pixel in H

uniform float uSysClean;   // 1 under ?clean=1 (sysUniforms(ctx)); disables paper fibre

// Screen coords from vUv: origin at frame centre, y up, units of H.
vec2 P(vec2 uv, float aspect){ return (uv - 0.5) * vec2(aspect, 1.0); }

// Integer lattice hash (deterministic on every GPU), 0..1.
float sysHash(vec2 i){
  uvec2 v = uvec2(ivec2(floor(i)) + ivec2(65536));
  v = v * 1664525u + 1013904223u; v.x += v.y * 1664525u; v.y += v.x * 1664525u; v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u; v ^= v >> 16u;
  return float(v.x ^ v.y) * (1.0 / 4294967295.0);
}
float sysVnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sysHash(i), sysHash(i + vec2(1, 0)), u.x), mix(sysHash(i + vec2(0, 1)), sysHash(i + vec2(1, 1)), u.x), u.y);
}
// Paper fibre on BONE: anisotropic 3-octave value-noise fbm at uv·(2,60) (uv of a 16:9 frame),
// p in H units (screen p, or paper q = p/paperZ). Returns a luma modulation in [-0.015, +0.015]:
//   col *= 1.0 + paperFibre(p);
// Returns 0 under ?clean=1.
float paperFibre(vec2 p){
  vec2 n = vec2(2.0 * (p.x * 0.5625 + 0.5), 60.0 * (p.y + 0.5));
  float s = 0.5714286 * sysVnoise(n) + 0.2857143 * sysVnoise(n * 2.0 + vec2(17.3, 5.1)) + 0.1428571 * sysVnoise(n * 4.0 + vec2(-9.7, 31.9));
  return (s * 2.0 - 1.0) * 0.015 * (1.0 - uSysClean);
}

// Dot radius (cell units, 0..sqrt(1/2) = solid) whose screen covers 'cover' of the area.
float halftoneRho(float cover){
  if (cover <= 0.0) return 0.0;
  if (cover >= 1.0) return 0.70710678;
  if (cover <= 0.78539816) return sqrt(cover / 3.14159265);
  float lo = 0.5, hi = 0.70710678;
  for (int i = 0; i < 14; i++){
    float m = 0.5 * (lo + hi);
    float a = 3.14159265 * m * m - 4.0 * (m * m * acos(0.5 / m) - 0.5 * sqrt(m * m - 0.25));
    if (a < cover) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}
// 45° dot screen given the dot radius rho in cell units (0 = empty, >= 0.7071 = solid).
// p in H units; cellPx in 1080p DESIGN pixels (do not multiply by ctx.scale: p·1080 already scales).
// aaPx: antialiasing footprint in design px per screen px (1080.0 / uRes.y for screen-space p).
// Returns antialiased ink coverage 0..1. Grid is anchored at p = 0.
// The 4-argument forms use no derivatives: call them inside non-uniform branches and loops.
// The 3-argument forms take aaPx from fwidth(p) and must be called in uniform control flow.
float halftone45Rho(vec2 p, float cellPx, float rho, float aaPx){
  vec2 u = p * (1080.0 / cellPx);
  u = vec2(u.x + u.y, u.y - u.x) * 0.70710678;
  float aaw = max(aaPx, 1e-4);                                          // design px per screen px
  vec2 c = fract(u) - 0.5;
  float sd = (length(c) - rho) * cellPx;                                // design px
  float cov = clamp(0.5 - sd / aaw, 0.0, 1.0);
  return rho <= 0.0 ? 0.0 : (rho >= 0.70710678 ? 1.0 : cov);
}
float halftone45Rho(vec2 p, float cellPx, float rho){
  return halftone45Rho(p, cellPx, rho, 0.5 * (fwidth(p.x) + fwidth(p.y)) * 1080.0);
}
// 45° dot screen with ink fraction 'cover' (0..1): mean coverage equals 'cover'. In the separate-dot
// regime the radius is corrected for the antialiasing ramp (a linear ramp of width w adds pi·w²/12).
float halftone45(vec2 p, float cellPx, float cover, float aaPx){
  float rho = halftoneRho(cover);
  float w = max(aaPx, 1e-4) / cellPx;                                   // ramp width, cell units
  float k = clamp((0.5 - rho) / (0.5 * w), 0.0, 1.0);                   // fade out as dots meet
  rho = sqrt(max(rho * rho - k * w * w / 12.0, 0.0));
  return halftone45Rho(p, cellPx, rho, aaPx) * step(1e-6, cover);
}
float halftone45(vec2 p, float cellPx, float cover){
  return halftone45(p, cellPx, cover, 0.5 * (fwidth(p.x) + fwidth(p.y)) * 1080.0);
}

// Dispersion only on the VERM-COBALT axis (§1.2). a: short-wavelength sample, b: long-wavelength sample.
vec3 palDisperse(vec3 a, vec3 b){ // a: short-λ sample, b: long-λ sample
  vec3 avg = .5 * (a + b); float d = luma(a) - luma(b); return max(avg + .5 * d * (VERM - COBALT), 0.); }

// Glyph SDF from sys.glyphSDF(ctx, ch). meta = vec4(ox, oy, capPx, inkCx) (glyphUniforms(meta).uGlyphMeta):
// q in cap units from the pen origin on the baseline (y up). Returns signed distance in CAP units
// (negative inside). Outside the texture: clamped sample + distance to the texture bounds.
float glyphD(sampler2D tex, vec4 meta, vec2 q){
  vec2 sz = vec2(textureSize(tex, 0));
  vec2 px = meta.xy + q * meta.z;
  vec2 pc = clamp(px, vec2(0.5), sz - 0.5);
  return (textureLod(tex, pc / sz, 0.0).r + length(px - pc)) / meta.z;
}
// Screen/world point p (H or wu) → glyph q for a glyph of cap height 'cap' on baseline 'baselineY',
// with its INK BOX centred on x = centreX (default 0).
vec2 placeGlyph(vec2 p, vec4 meta, float cap, float baselineY){ return vec2(p.x / cap + meta.w, (p.y - baselineY) / cap); }
vec2 placeGlyph(vec2 p, vec4 meta, float cap, float baselineY, float centreX){ return vec2((p.x - centreX) / cap + meta.w, (p.y - baselineY) / cap); }
// place = vec4(cap, baselineY, centreX, 0) (placeGlyph(meta, …).uniforms().uGlyphPlace)
vec2 placeGlyph(vec2 p, vec4 meta, vec4 place){ return vec2((p.x - place.z) / place.x + meta.w, (p.y - place.y) / place.x); }
// Signed distance in the units of p (H or wu) for a placed glyph.
float glyphDist(sampler2D tex, vec4 meta, vec4 place, vec2 p){ return glyphD(tex, meta, placeGlyph(p, meta, place)) * place.x; }
#endif
`;

/** GLSL uniform declarations matching glyphUniforms/placement uniforms for `prefix` (default 'uGlyph'). */
export function glyphUniformDecl(prefix = 'uGlyph') {
  return `uniform sampler2D ${prefix}Tex;\nuniform vec4 ${prefix}Meta;\nuniform vec4 ${prefix}Ink;\nuniform vec4 ${prefix}Place;\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name letters
// ─────────────────────────────────────────────────────────────────────────────

/** config.name uppercased, letters only (as an array of characters). */
export function nameLetters(ctx) {
  const name = String(ctx?.config?.name ?? 'NEKVIT');
  return [...name.toUpperCase()].filter(ch => /\p{L}/u.test(ch));
}
/** The k-th letter of config.name (uppercased, letters only), modulo its length. */
export function stationLetter(ctx, k) {
  const L = nameLetters(ctx);
  if (!L.length) throw new Error('_sys.stationLetter: config.name has no letters');
  const n = L.length;
  return L[((Math.trunc(k) % n) + n) % n];
}

// ─────────────────────────────────────────────────────────────────────────────
// Font metrics (measured at runtime; cached per font)
// ─────────────────────────────────────────────────────────────────────────────

/** The glyph face of every letterform of the name (§1.3). */
export const NAME_FONT = Object.freeze({ family: 'Archivo', weight: 850, width: 100 });
export const W1_FONT = Object.freeze({ family: 'Archivo', weight: 500, width: 100 });
export const SERIF_FONT = Object.freeze({ family: 'Instrument Serif', weight: 400, italic: true });
/** The year: Archivo 500/125 with real tabular figures (text.js 'tnum' alias; §1.3). */
export const YEAR_FONT = Object.freeze({ family: 'Archivo', weight: 500, width: 125, tnum: true });

const REF = 1000;                      // reference em size (px) for metric measurements
const _metric = new Map();             // font key → cached metrics

function need2D() {
  if (typeof document === 'undefined') throw new Error('_sys: font measurement needs a browser document');
}
function fontStr(ctx, spec, size) {
  const T = ctx?.text;
  if (T && T.font) return T.font({ ...spec, size });
  return `${spec.italic ? 'italic ' : ''}${Math.round(spec.weight ?? 400)} ${size}px "${spec.family}"`;
}
function checkFont(fs) {
  if (typeof document !== 'undefined' && document.fonts && !document.fonts.check(fs)) {
    throw new Error(`_sys: font not loaded: ${fs} (await loadFonts() before init)`);
  }
}
function rasterAlpha(str, fs, w, h, x, y) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = fs; g.fillStyle = '#fff'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillText(str, x, y);
  const d = g.getImageData(0, 0, w, h).data, a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3] / 255;
  return { a, c, g };
}

/**
 * Cap height ÷ em for a font spec {family, weight, width, italic}, measured on 'H' at 1000px:
 * flat top edge from the first ink row's coverage. Archivo 850/100 → 0.6875, Instrument Serif Italic → 0.720.
 */
export function capRatio(ctx, spec) {
  const key = 'cap|' + fontStr(ctx, spec, REF);
  if (_metric.has(key)) return _metric.get(key);
  need2D();
  const fs = fontStr(ctx, spec, REF); checkFont(fs);
  const w = 1600, h = 1300, by = 1100;
  const { a } = rasterAlpha('H', fs, w, h, 200, by);
  const rowMax = y => { let m = 0; for (let x = 0; x < w; x++) m = Math.max(m, a[y * w + x]); return m; };
  let top = -1;
  for (let y = 0; y < by && top < 0; y++) if (rowMax(y) > 0.002) top = y;
  if (top < 0) throw new Error('_sys.capRatio: empty raster for ' + fs);
  const r = (by - (top + 1 - rowMax(top))) / REF;
  _metric.set(key, r);
  return r;
}
/** Em size (in the units of `cap`) that gives cap height `cap` for this font spec. */
export function sizeForCap(ctx, spec, cap) { return cap / capRatio(ctx, spec); }

const _measure2D = { g: null };
/**
 * Advance width of one character in em units, measured at 1000px. Chrome applies the
 * variable-font deltas in whole font units, so advances of interpolated instances are
 * quantised to 0.001 em (e.g. V 850: 0.754 vs 0.753573 unrounded): ≤ 0.2 px per glyph at
 * the title size. Needs --font-render-hinting=none (tools/*.mjs) for fractional px.
 */
export function advanceEm(ctx, spec, ch) {
  const fs = fontStr(ctx, spec, REF);
  const key = 'adv|' + fs + '|' + ch;
  if (_metric.has(key)) return _metric.get(key);
  need2D(); checkFont(fs);
  const g = _measure2D.g || (_measure2D.g = document.createElement('canvas').getContext('2d'));
  g.font = fs;
  const adv = g.measureText(ch).width / REF;
  _metric.set(key, adv);
  return adv;
}

/**
 * Horizontal ink extents of one character, in em units relative to its pen origin:
 * {l, r, adv}. Scanned from a 1000px raster with sub-pixel coverage refinement.
 */
export function inkExtentsEm(ctx, spec, ch) {
  const fs = fontStr(ctx, spec, REF);
  const key = 'ink|' + fs + '|' + ch;
  if (_metric.has(key)) return _metric.get(key);
  need2D(); checkFont(fs);
  const adv = advanceEm(ctx, spec, ch);
  const ox = 500, w = Math.ceil(adv * REF) + 2 * ox, h = 1500, by = 1100;
  const { a } = rasterAlpha(ch, fs, w, h, ox, by);
  const colMax = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = a[y * w + x]; if (v > colMax[x]) colMax[x] = v; }
  let c0 = -1, c1 = -1;
  for (let x = 0; x < w; x++) if (colMax[x] > 0.002) { c0 = x; break; }
  for (let x = w - 1; x >= 0; x--) if (colMax[x] > 0.002) { c1 = x; break; }
  const res = c0 < 0 ? { l: 0, r: 0, adv } : { l: (c0 + 1 - colMax[c0] - ox) / REF, r: (c1 + colMax[c1] - ox) / REF, adv };
  _metric.set(key, res);
  return res;
}

// Pen positions (with kerning, via ctx.text.layout) of `str` for a font spec, in em units.
function penLayoutEm(ctx, spec, str) {
  const fs = fontStr(ctx, spec, REF); checkFont(fs);
  const key = 'lay|' + fs + '|' + str;
  if (_metric.has(key)) return _metric.get(key);
  let res;
  if (ctx?.text?.layout) {
    const L = ctx.text.layout(str, fs, 0);
    res = { glyphs: L.glyphs.map(g => ({ ch: g.ch, x: g.x / REF, adv: g.adv / REF, w: g.w / REF })), width: L.width / REF };
  } else {
    need2D();
    const g = document.createElement('canvas').getContext('2d'); g.font = fs;
    const chars = [...str]; let x = 0; const glyphs = [];
    for (let i = 0; i < chars.length; i++) {
      const w = g.measureText(chars[i]).width;
      const adv = i + 1 < chars.length ? g.measureText(chars[i] + chars[i + 1]).width - g.measureText(chars[i + 1]).width : w;
      glyphs.push({ ch: chars[i], x: x / REF, adv: adv / REF, w: w / REF }); x += adv;
    }
    res = { glyphs, width: x / REF };
  }
  _metric.set(key, res);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accurate signed distance field from antialiased coverage
// ─────────────────────────────────────────────────────────────────────────────

// sdfFromAlpha lives in src/sdf.js (shared with ctx.text.sdfTexture); re-exported here.
export { sdfFromAlpha };

/** R32F texture (linear if OES_texture_float_linear, clamp) from GL-ordered (row 0 = bottom) floats. */
function floatTexture(gl, w, h, data) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
  const lin = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// glyphSDF (§2.3)
// ─────────────────────────────────────────────────────────────────────────────

/** Raster cap height of every glyph SDF (px) and its padding (cap units). */
export const GLYPH_CAP_PX = 360;
export const GLYPH_PAD = 0.6;

const _glyphCPU = new Map();           // ch → CPU part (raster, sdf, metrics); context-free
const _glyphTex = new WeakMap();       // gl → Map(ch → meta with tex)

function buildGlyphCPU(ctx, ch) {
  need2D();
  const capPx = GLYPH_CAP_PX, pad = Math.ceil(GLYPH_PAD * capPx);
  const sizePx = sizeForCap(ctx, NAME_FONT, capPx);
  const fs = fontStr(ctx, NAME_FONT, sizePx); checkFont(fs);
  // generous work canvas, pen at integer (PX0, BY)
  const probe = document.createElement('canvas').getContext('2d'); probe.font = fs;
  const adv = probe.measureText(ch).width;
  const MX = Math.ceil(1.2 * capPx), BY = Math.ceil(2.2 * capPx);
  const W0 = Math.ceil(adv) + 2 * MX, H0 = BY + Math.ceil(1.4 * capPx);
  const { a: a0 } = rasterAlpha(ch, fs, W0, H0, MX, BY);
  let bx0 = W0, bx1 = -1, by0 = H0, by1 = -1;
  for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) if (a0[y * W0 + x] > 0) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < 0) { bx0 = MX; bx1 = MX; by0 = BY - 1; by1 = BY - 1; }   // blank glyph (space)
  const cx0 = Math.max(0, bx0 - pad), cy0 = Math.max(0, by0 - pad);
  const cx1 = Math.min(W0, bx1 + 1 + pad), cy1 = Math.min(H0, by1 + 1 + pad);
  const w = cx1 - cx0, h = cy1 - cy0;
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = a0[(y + cy0) * W0 + (x + cx0)];
  const sdfC = sdfFromAlpha(alpha, w, h);
  const data = new Float32Array(w * h);                     // GL order: row 0 = bottom
  for (let y = 0; y < h; y++) data.set(sdfC.subarray((h - 1 - y) * w, (h - y) * w), y * w);
  const ox = MX - cx0, oy = h - (BY - cy0);                 // pen origin, texture px from bottom-left
  // canvas with the cropped raster (white ink on transparent; pen origin at (ox, h - oy) in canvas px)
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const cg = canvas.getContext('2d');
  const img = cg.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = Math.round(alpha[i] * 255); }
  cg.putImageData(img, 0, 0);
  const m = { ch, capPx, pad: GLYPH_PAD, w, h, ox, oy, data, canvas, adv: advanceEm(ctx, NAME_FONT, ch) / capRatio(ctx, NAME_FONT), sizePx, font: NAME_FONT, fontStr: fs };
  // ink extents (cap units) from the SDF's zero set: min distance per column / row, 3px outside
  const colMin = new Float32Array(w).fill(Infinity), rowMin = new Float32Array(h).fill(Infinity);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = data[y * w + x]; if (d < colMin[x]) colMin[x] = d; if (d < rowMin[y]) rowMin[y] = d; }
  const ext = (arr, n, dir) => {                             // first index with ink scanning in dir
    let k = dir > 0 ? 0 : n - 1;
    while (k >= 0 && k < n && arr[k] > 0) k += dir;
    if (k < 0 || k >= n) return null;
    const o = k - 3 * dir;                                   // a sample 3px outside the ink
    return dir > 0 ? (o + 0.5) + arr[o] : (o + 0.5) - arr[o];
  };
  const X0 = ext(colMin, w, 1), X1 = ext(colMin, w, -1), Y0 = ext(rowMin, h, 1), Y1 = ext(rowMin, h, -1);
  if (X0 == null) { m.inkX0 = m.inkX1 = m.inkY0 = m.inkY1 = 0; }
  else { m.inkX0 = (X0 - ox) / capPx; m.inkX1 = (X1 - ox) / capPx; m.inkY0 = (Y0 - oy) / capPx; m.inkY1 = (Y1 - oy) / capPx; }
  m.inkCx = 0.5 * (m.inkX0 + m.inkX1);
  m.inkCy = 0.5 * (m.inkY0 + m.inkY1);
  m.inkW = m.inkX1 - m.inkX0;
  return m;
}

/**
 * Glyph SDF of one character at Archivo 850/100 (cached per GL context and character).
 * Returns meta:
 *   tex            R32F texture: signed distance in texture px (negative inside), linear, clamp
 *   capPx 360      raster cap height (px);  pad 0.6 (cap) of padding around the ink box
 *   w, h           texture size (px);  ox, oy: pen origin in texture px from the BOTTOM-LEFT (GL uv)
 *   inkX0, inkX1, inkY0, inkY1, inkCx, inkCy, inkW   ink box (cap units, from pen origin, y up)
 *   adv            advance width (cap units, unkerned)
 *   data           Float32Array (w·h, row 0 = bottom): the texture contents, for CPU glyphD
 *   canvas         cropped raster (white on transparent, canvas y-down; pen at (ox, h − oy))
 *   ch, sizePx, font, fontStr
 */
export function glyphSDF(ctx, ch) {
  ch = String(ch);
  let cpu = _glyphCPU.get(ch);
  if (!cpu) { cpu = buildGlyphCPU(ctx, ch); _glyphCPU.set(ch, cpu); }
  const gl = ctx?.gl;
  if (!gl) return cpu;
  let map = _glyphTex.get(gl);
  if (!map) { map = new Map(); _glyphTex.set(gl, map); }
  let meta = map.get(ch);
  if (!meta) { meta = Object.freeze({ ...cpu, tex: floatTexture(gl, cpu.w, cpu.h, cpu.data) }); map.set(ch, meta); }
  return meta;
}

/** vec4 for GLSL glyphD's `meta`: (ox, oy, capPx, inkCx). */
export function glyphMeta4(meta) { return [meta.ox, meta.oy, meta.capPx, meta.inkCx]; }
/**
 * Uniforms for one glyph: {[prefix+'Tex']: tex, [prefix+'Meta']: [ox, oy, capPx, inkCx],
 * [prefix+'Ink']: [inkX0, inkY0, inkX1, inkY1]}. Declare them with glyphUniformDecl(prefix).
 */
export function glyphUniforms(meta, prefix = 'uGlyph') {
  return { [prefix + 'Tex']: meta.tex, [prefix + 'Meta']: glyphMeta4(meta), [prefix + 'Ink']: [meta.inkX0, meta.inkY0, meta.inkX1, meta.inkY1] };
}

/** CPU mirror of GLSL glyphD: signed distance in cap units at q (cap units from the pen origin, y up). */
export function glyphD(meta, qx, qy) {
  const { w, h, data, capPx, ox, oy } = meta;
  const px = ox + qx * capPx, py = oy + qy * capPx;
  const cx = Math.min(Math.max(px, 0.5), w - 0.5), cy = Math.min(Math.max(py, 0.5), h - 0.5);
  const fx = cx - 0.5, fy = cy - 0.5;
  const x0 = Math.min(Math.floor(fx), w - 2), y0 = Math.min(Math.floor(fy), h - 2);
  const tx = fx - x0, ty = fy - y0, i = y0 * w + x0;
  const d = (data[i] * (1 - tx) + data[i + 1] * tx) * (1 - ty) + (data[i + w] * (1 - tx) + data[i + w + 1] * tx) * ty;
  return (d + Math.hypot(px - cx, py - cy)) / capPx;
}

/**
 * Place a glyph: cap height `cap`, baseline `baselineY`, ink box centred on x = centreX (default 0).
 * q = ((p.x − centreX)/cap + inkCx, (p.y − baselineY)/cap). Returns
 *   {meta, cap, baselineY, centreX, penX,
 *    q(x,y) → [qx,qy],  p(qx,qy) → [x,y],  d(x,y) → signed distance in p units,
 *    box {x0,x1,y0,y1} ink box in p units,  place [cap, baselineY, centreX, 0],
 *    uniforms(prefix='uGlyph') → glyphUniforms + {[prefix+'Place']: place}}
 */
export function placeGlyph(meta, cap, baselineY, centreX = 0) {
  const k = meta.inkCx;
  const place = [cap, baselineY, centreX, 0];
  return {
    meta, cap, baselineY, centreX, place,
    penX: centreX - k * cap,
    q: (x, y) => [(x - centreX) / cap + k, (y - baselineY) / cap],
    p: (qx, qy) => [centreX + (qx - k) * cap, baselineY + qy * cap],
    d: (x, y) => glyphD(meta, (x - centreX) / cap + k, (y - baselineY) / cap) * cap,
    box: { x0: centreX + (meta.inkX0 - k) * cap, x1: centreX + (meta.inkX1 - k) * cap, y0: baselineY + meta.inkY0 * cap, y1: baselineY + meta.inkY1 * cap },
    uniforms: (prefix = 'uGlyph') => ({ ...glyphUniforms(meta, prefix), [prefix + 'Place']: place }),
  };
}

/**
 * Centre height (cap units) at which a ball of radius rCap, dropped on the vertical line
 * x = xCap, first touches ink. Scans y down in 0.001 steps for the first glyphD ≤ rCap,
 * then bisects inside that step (exact contact). The scan starts at
 * max(1, meta.inkY1) + rCap (+0.002), a height where the ball clears all ink, so glyphs
 * rising above cap height (overshoot of O C G S Q, accents such as Ž) are touched on top
 * instead of penetrated; for flat-topped glyphs this is the §2.3 scan from 1 + rCap (a ball
 * wider than a notch still rests on its two top corners). If the start sample touches
 * anyway (raster tolerance), it climbs until clear first. Returns 1 + rCap if nothing is
 * found above y = 0.2 (the line misses the glyph).
 */
export function restY(meta, xCap, rCap) {
  const step = 0.001;
  let top = Math.max(1, Number.isFinite(meta.inkY1) ? meta.inkY1 : 1) + rCap + 0.002;
  for (let k = 0; k < 4000 && glyphD(meta, xCap, top) <= rCap; k++) top += step;
  let prev = top;
  for (let i = 1; ; i++) {
    const y = top - i * step;
    if (y < 0.2) return 1 + rCap;
    if (glyphD(meta, xCap, y) <= rCap) {
      let lo = y, hi = prev;                                 // d(lo) ≤ r < d(hi)
      for (let k = 0; k < 30; k++) { const m = 0.5 * (lo + hi); if (glyphD(meta, xCap, m) <= rCap) lo = m; else hi = m; }
      return 0.5 * (lo + hi);
    }
    prev = y;
  }
}
/** restY on the ink-box centre line: where a ball of radius rCap rests in the glyph's notch. */
export function vNotchRest(meta, rCap) { return restY(meta, meta.inkCx, rCap); }

/**
 * Where a ball of radius rCap that may also roll sideways (within ±0.1 cap of the ink centre)
 * comes to rest: the x minimising restY, i.e. touching BOTH walls of a notch. Returns
 * {x, y, dx} in cap units (dx = x − inkCx). Not the spec's NOTCH (which is restY at inkCx and
 * touches only one wall of Archivo's asymmetric V): V 850, r 0.146 → dx +0.0068, y 0.7872.
 */
const _notchXY = new WeakMap();
export function notchRestXY(meta, rCap) {
  let per = _notchXY.get(meta);
  if (!per) { per = new Map(); _notchXY.set(meta, per); }
  if (per.has(rCap)) return per.get(rCap);
  const c = meta.inkCx;
  let bx = c, by = restY(meta, c, rCap);
  for (let x = c - 0.1; x <= c + 0.1; x += 0.002) { const y = restY(meta, x, rCap); if (y < by) { bx = x; by = y; } }
  let a = bx - 0.002, b = bx + 0.002;
  for (let i = 0; i < 40; i++) {
    const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
    if (restY(meta, m1, rCap) < restY(meta, m2, rCap)) b = m2; else a = m1;
  }
  const x = 0.5 * (a + b), res = Object.freeze({ x, y: restY(meta, x, rCap), dx: x - c });
  per.set(rCap, res);
  return res;
}

/**
 * Horizontal scan for ink on the line q.y = qy, from x0 towards x1 (cap units, either
 * direction) in 0.001 steps; returns the first x (bisected) with glyphD ≤ 0, or null.
 * `lens` O_K: scanInk(K, 0.5, K.inkX1, K.inkCx) ?? K.inkCx.
 */
export function scanInk(meta, qy, x0, x1) {
  const step = 0.001 * Math.sign(x1 - x0), n = Math.floor(Math.abs(x1 - x0) / 0.001);
  if (glyphD(meta, x0, qy) <= 0) return x0;
  let prev = x0;
  for (let i = 1; i <= n; i++) {
    const x = x0 + i * step;
    if (glyphD(meta, x, qy) <= 0) {
      let a = prev, b = x;                                   // d(a) > 0 ≥ d(b)
      for (let k = 0; k < 30; k++) { const m = 0.5 * (a + b); if (glyphD(meta, m, qy) <= 0) b = m; else a = m; }
      return 0.5 * (a + b);
    }
    prev = x;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTCH / NSTAR (depend on fonts: functions of ctx, cached)
// ─────────────────────────────────────────────────────────────────────────────

let _lastCtx = null;
const remember = ctx => { if (ctx) _lastCtx = ctx; else if (!_lastCtx) throw new Error('_sys: pass ctx on the first call (fonts must be loaded)'); return ctx || _lastCtx; };
const _glIds = new WeakMap(); let _glSeq = 0;
const glId = gl => { if (!gl) return 0; if (!_glIds.has(gl)) _glIds.set(gl, ++_glSeq); return _glIds.get(gl); };
const cfgKey = ctx => JSON.stringify([glId(ctx?.gl), ctx?.config?.name, ctx?.config?.role, ctx?.config?.year]);
const _derived = new Map();
function memo(ctx, key, fn) {
  const k = key + '|' + cfgKey(ctx);
  if (!_derived.has(k)) _derived.set(k, fn());
  return _derived.get(k);
}

/**
 * NOTCH = vNotchRest(glyphSDF(stationLetter(3)), 0.146): the ball centre height in the V
 * (cap units = wu). 0.8079 for Archivo V 850. The single source; never hard-code it.
 * A FUNCTION: call NOTCH(ctx) (or initSys(ctx)) once, e.g. in init; afterwards NOTCH()
 * also works, and so does value-style use as in the spec text (`sys.NOTCH * 0.5`,
 * `${sys.NOTCH}`), which throws a clear error before the first call with ctx.
 */
export function NOTCH(ctx) {
  ctx = remember(ctx);
  // Director decision (DIRECTION.md §8): the ball rests where it touches BOTH notch walls
  // (Archivo's V notch sits slightly right of the ink centre), not at restY(inkCx).
  return memo(ctx, 'NOTCH', () => notchRestXY(glyphSDF(ctx, stationLetter(ctx, 3)), BALL_R).y);
}
/**
 * NOTCH_X: horizontal offset (cap units = wu, from the V's ink centre) of the ball's resting
 * point. The V stays ink-centred at x = 0; the ball sits at (NOTCH_X, NOTCH, 0) in `volume`
 * and at NSTAR = 0.5·(NOTCH_X, NOTCH − 0.6) on screen in `lens`/`volume`. ≈ +0.0068.
 */
export function NOTCH_X(ctx) {
  ctx = remember(ctx);
  return memo(ctx, 'NOTCH_X', () => notchRestXY(glyphSDF(ctx, stationLetter(ctx, 3)), BALL_R).dx);
}
/**
 * Ball centre on screen at f384 and f383: {x: 0.5·NOTCH_X, y: 0.5·(NOTCH − 0.6), r: 0.073} (H).
 * A function like NOTCH; after initSys(ctx) `sys.NSTAR.x / .y / .r` also read the values.
 */
export function NSTAR(ctx) {
  ctx = remember(ctx);
  return memo(ctx, 'NSTAR', () => Object.freeze({ x: 0.5 * NOTCH_X(ctx), y: 0.5 * (NOTCH(ctx) - VOL_EYE_Y), r: 0.5 * BALL_R }));
}

// ─────────────────────────────────────────────────────────────────────────────
// roleLayout (§2.3), H units
// ─────────────────────────────────────────────────────────────────────────────

/** Tittle geometry of Instrument Serif Italic 'i' (em units from the ı pen origin; verified by raster). */
export const TITTLE_EM = Object.freeze({ x: 0.2105, y: 0.6575, r: 0.0515 });

function rowLayout(ctx, spec, text, size, baseline, xStart) {
  const L = penLayoutEm(ctx, spec, text);
  const glyphs = L.glyphs.map((g, i) => ({ ch: g.ch, i, x: xStart + g.x * size, adv: g.adv * size }));
  return { text, font: spec, size, baseline, x0: xStart, x1: xStart + L.width * size, adv: L.width * size, glyphs };
}

/**
 * Role layout for `lens` (and T_DOT). All values in H, screen coords.
 *   cap = 0.24·fit (the cap of both rows); fit = 1 unless the layout would leave title-safe
 *        (see ROLE_SAFE_X): then every x and size scales by fit, baselines stay (provisional
 *        fallback rule; "Motion Design" has fit 1)
 *   w1  {text (uppercased word 1), font W1_FONT (500/100 rest), cap, size (em), baseline 0,
 *        x0 = −adv/2, x1 = +adv/2, adv, glyphs[{ch,i,x (pen),adv}]}   centred on its advance width
 *   w2  {text (words 2.., lowercased, first i → ı), font SERIF_FONT, size fs, baseline −0.30,
 *        x1 = w1.x1 (advance ends aligned), x0, adv, glyphs, iIndex, xI (pen x of ı or null)} | null
 *   fs  = cap / capRatio(Instrument Serif Italic) (em in H; 0.3333 for the measured 0.720)
 *   tittle {x: xI + 0.2105·fs, y: −0.30 + 0.6575·fs, r: 0.0515·fs} | null
 *   dotAlt {x: advEnd + 0.05·fs, y: baseline + 0.07·fs, r: 0.0515·fs} | null (only when there is no ı)
 *   T_DOT = tittle ?? dotAlt
 */
export const ROLE_CAP = 0.24;
/** Title-safe half-width (H) the role layout must fit in: 90% of the 16:9 frame (±0.80). */
export const ROLE_SAFE_X = 0.80;
export function roleLayout(ctx) {
  ctx = remember(ctx);
  return memo(ctx, 'role', () => {
    const at1 = roleLayoutAt(ctx, ROLE_CAP);
    const { w1, w2, T_DOT: d } = at1;
    const ext = Math.max(Math.abs(w1.x0), Math.abs(w1.x1), w2 ? Math.abs(w2.x0) : 0, w2 ? Math.abs(w2.x1) : 0, d ? Math.abs(d.x) + d.r : 0);
    const fit = ext > ROLE_SAFE_X ? ROLE_SAFE_X / ext : 1;
    return fit < 1 ? roleLayoutAt(ctx, ROLE_CAP * fit, fit) : at1;
  });
}
// roleLayout at a given cap (H); fit is recorded in the result.
function roleLayoutAt(ctx, CAP, fit = 1) {
  const role = String(ctx.config?.role ?? 'Motion Design');
  const words = role.trim().split(/\s+/).filter(Boolean);
  const s1 = sizeForCap(ctx, W1_FONT, CAP);
  const t1 = (words[0] || '').toUpperCase();
  const adv1 = penLayoutEm(ctx, W1_FONT, t1).width * s1;
  const w1 = rowLayout(ctx, W1_FONT, t1, s1, 0, -adv1 / 2);
  w1.cap = CAP;
  const fs = sizeForCap(ctx, SERIF_FONT, CAP);
  let w2 = null, tittle = null, dotAlt = null;
  if (words.length > 1) {
    const lower = words.slice(1).join(' ').toLowerCase();
    const chars = [...lower];
    const iIndex = chars.indexOf('i');
    if (iIndex >= 0) chars[iIndex] = 'ı';
    const t2 = chars.join('');
    const adv2 = penLayoutEm(ctx, SERIF_FONT, t2).width * fs;
    w2 = rowLayout(ctx, SERIF_FONT, t2, fs, -0.30, w1.x1 - adv2);
    w2.cap = CAP; w2.iIndex = iIndex;
    w2.xI = iIndex >= 0 ? w2.glyphs[iIndex].x : null;
    if (iIndex >= 0) tittle = Object.freeze({ x: w2.xI + TITTLE_EM.x * fs, y: -0.30 + TITTLE_EM.y * fs, r: TITTLE_EM.r * fs });
  }
  if (!tittle) {
    const row = w2 || w1;
    dotAlt = Object.freeze({ x: row.x1 + 0.05 * fs, y: row.baseline + 0.07 * fs, r: TITTLE_EM.r * fs });
  }
  return Object.freeze({ role, words, cap: CAP, fit, w1, w2, fs, tittle, dotAlt, T_DOT: tittle ?? dotAlt });
}
/**
 * T_DOT = roleLayout.tittle ?? roleLayout.dotAlt: {x, y, r} in H. A function like NOTCH;
 * after initSys(ctx) `sys.T_DOT.x / .y / .r` also read the values.
 */
export function T_DOT(ctx) { return roleLayout(ctx).T_DOT; }

// Value-style access for the three font-dependent "constants" the spec writes as values
// (NOTCH, NSTAR, T_DOT): non-enumerable number coercion / x,y,r getters on the functions.
// Before the first call with ctx they throw instead of yielding NaN / undefined.
function valueAccess(fn, name, fields) {
  const get = () => {
    if (!_lastCtx) throw new Error(`_sys.${name} used as a value before initSys(ctx) (or ${name}(ctx)) was called`);
    return fn();
  };
  if (!fields) {
    Object.defineProperty(fn, Symbol.toPrimitive, { value: hint => (hint === 'string' ? String(get()) : get()) });
    Object.defineProperty(fn, 'valueOf', { value: get });
  }
  for (const k of fields || []) Object.defineProperty(fn, k, { get: () => get()[k] });
}
valueAccess(NOTCH, 'NOTCH');
valueAccess(NOTCH_X, 'NOTCH_X');
valueAccess(NSTAR, 'NSTAR', ['x', 'y', 'r']);
valueAccess(T_DOT, 'T_DOT', ['x', 'y', 'r']);

// ─────────────────────────────────────────────────────────────────────────────
// nameLayout (§2.3), H units
// ─────────────────────────────────────────────────────────────────────────────

/** Touch interval Δ (frames) for n letters: 3·max(1, ⌊10/(n−1)⌋). */
export function touchInterval(n) { return 3 * Math.max(1, Math.floor(10 / Math.max(1, n - 1))); }

/**
 * Title layout (full-stop, field targets, HUD). All values in H, screen coords.
 *   name, letters, n, cap, yb (+0.02), blockW (measured at cap 0.20), size (em of the 850 face in H)
 *   glyphs[i] {ch, i, meta (glyphSDF), penX, adv (kerned), inkL, inkR, cx, inkB, inkT, place (placeGlyph)}
 *   penEnd, inkLeft, blockX0 (= inkLeft), blockX1 (= dot.x + r)
 *   dot  {x: penEnd + 0.2375·cap, y: yb + 0.17·cap, r: 0.17·cap}   the full stop
 *   S0   {x: inkLeft − 0.375·cap, y: yb + 0.17·cap, r}               the dot's start
 *   rule {y: yb − 0.425·cap, x0: inkLeft, x1: dot.x + r, w: 4/1080 (H), wPx: 4 (design px)}
 *   role {text (config.role as is), font SERIF_FONT, cap 0.275·cap, size, baseline yb − 0.9·cap,
 *         x (pen origin), inkL (= inkLeft), glyphs[{ch,i,x,adv}]}
 *   year {text, font YEAR_FONT (tabular figures), cap 0.20·cap, size, baseline, x0 (first pen),
 *         x1 (ink right = dot.x + r), tracking 0.04 (em), cellW (tabular digit advance),
 *         glyphs[{ch,i,x (pen), cellX (= x), adv}]}   empty config.year → no glyphs, x0 = x1
 *   yTouch[i] = yb + cap·restY(glyph_i, inkCx_i, 0.17)
 *   delta (Δ), touches[i] {i, frame: 720 + i·Δ, x: cx_i, y: yTouch[i], world: i % 6, fig: FIG[i%6 + 1]}
 */
export function nameLayout(ctx) {
  ctx = remember(ctx);
  return memo(ctx, 'name', () => {
    const letters = nameLetters(ctx);
    const name = letters.join('');
    const n = letters.length;
    if (n < 1) throw new Error('_sys.nameLayout: empty name');
    const metas = letters.map(ch => glyphSDF(ctx, ch));
    const capR = capRatio(ctx, NAME_FONT);
    const L = penLayoutEm(ctx, NAME_FONT, name);              // em units (kerned)
    const toCap = 1 / capR;                                    // em → cap units
    const penC = L.glyphs.map(g => g.x * toCap), penEndC = L.width * toCap;
    const inkLeftC = penC[0] + metas[0].inkX0;
    const DOT_DX = 0.2375, DOT_R = 0.17;
    const blockW = 0.20 * (penEndC + DOT_DX + DOT_R - inkLeftC);
    const cap = Math.min(0.20, 0.20 * 1.45 / blockW);
    const yb = 0.02;
    const X = -0.5 * (inkLeftC + penEndC + DOT_DX + DOT_R) * cap;   // pen origin of glyph 0
    const glyphs = letters.map((ch, i) => {
      const m = metas[i], penX = X + penC[i] * cap;
      const g = {
        ch, i, meta: m, penX, adv: L.glyphs[i].adv * toCap * cap,
        inkL: penX + m.inkX0 * cap, inkR: penX + m.inkX1 * cap, cx: penX + m.inkCx * cap,
        inkB: yb + m.inkY0 * cap, inkT: yb + m.inkY1 * cap,
      };
      g.place = placeGlyph(m, cap, yb, g.cx);
      return Object.freeze(g);
    });
    const penEnd = X + penEndC * cap, inkLeft = glyphs[0].inkL;
    const r = DOT_R * cap;
    const dot = Object.freeze({ x: penEnd + DOT_DX * cap, y: yb + DOT_R * cap, r });
    const S0 = Object.freeze({ x: inkLeft - 0.375 * cap, y: yb + DOT_R * cap, r });
    const blockX1 = dot.x + r;
    const rule = Object.freeze({ y: yb - 0.425 * cap, x0: inkLeft, x1: blockX1, w: 4 * PX, wPx: 4 });
    // role line: Instrument Serif Italic, config.role as is, ink-left at inkLeft
    const roleText = String(ctx.config?.role ?? 'Motion Design');
    const roleCap = 0.275 * cap, roleSize = sizeForCap(ctx, SERIF_FONT, roleCap), baseRole = yb - 0.9 * cap;
    const roleFirst = [...roleText][0] || ' ';
    const roleInkL = inkExtentsEm(ctx, SERIF_FONT, roleFirst).l * roleSize;
    const roleRow = rowLayout(ctx, SERIF_FONT, roleText, roleSize, baseRole, inkLeft - roleInkL);
    const role = Object.freeze({ ...roleRow, cap: roleCap, x: roleRow.x0, inkL: inkLeft });
    // year: Archivo 500/125 with real tabular figures (YEAR_FONT.tnum), tracking +0.04 em,
    // ink-right at blockX1. Pens from the tnum face's own advances (all digits equal).
    const yearText = String(ctx.config?.year ?? '2026');
    const yearCap = 0.20 * cap, ySize = sizeForCap(ctx, YEAR_FONT, yearCap), TRACK = 0.04;
    const yChars = [...yearText];
    let year;
    if (!yChars.length) {
      year = Object.freeze({ text: '', font: YEAR_FONT, cap: yearCap, size: ySize, baseline: baseRole, x0: blockX1, x1: blockX1, tracking: TRACK, cellW: 0, glyphs: Object.freeze([]) });
    } else {
      const YL = penLayoutEm(ctx, YEAR_FONT, yearText);
      const pens = YL.glyphs.map((g, i) => g.x + i * TRACK);                 // em, with tracking
      const lastI = yChars.length - 1;
      const inkRightEm = pens[lastI] + inkExtentsEm(ctx, YEAR_FONT, yChars[lastI]).r;
      const yX0 = blockX1 - inkRightEm * ySize;
      const yearGlyphs = YL.glyphs.map((g, i) => Object.freeze({ ch: g.ch, i, x: yX0 + pens[i] * ySize, cellX: yX0 + pens[i] * ySize, adv: g.adv * ySize }));
      year = Object.freeze({ text: yearText, font: YEAR_FONT, cap: yearCap, size: ySize, baseline: baseRole, x0: yX0, x1: blockX1, tracking: TRACK, cellW: advanceEm(ctx, YEAR_FONT, '0') * ySize, glyphs: Object.freeze(yearGlyphs) });
    }
    // touches
    const yTouch = glyphs.map(g => yb + cap * restY(g.meta, g.meta.inkCx, DOT_R));
    const delta = touchInterval(n);
    const touches = glyphs.map((g, i) => Object.freeze({ i, frame: 720 + i * delta, x: g.cx, y: yTouch[i], world: i % 6, fig: FIG[(i % 6) + 1] }));
    return Object.freeze({
      name, letters, n, cap, yb, size: cap / capR, font: NAME_FONT, blockW, glyphs,
      penStart: X, penEnd, inkLeft, blockX0: inkLeft, blockX1, dot, S0, rule, role, year,
      yTouch: Object.freeze(yTouch), delta, touches: Object.freeze(touches), touchFrames: Object.freeze(touches.map(t => t.frame)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience
// ─────────────────────────────────────────────────────────────────────────────

/** Screen coords (H units, y up, origin at centre) → canvas px of a ctx-sized Surface (y down). */
export function toCanvas(ctx, x, y) { return [ctx.W / 2 + x * ctx.H, ctx.H / 2 - y * ctx.H]; }
/** CSS font string for a font spec at an em size given in H (e.g. nameLayout(ctx).size). */
export function fontPx(ctx, spec, sizeH) { return fontStr(ctx, spec, sizeH * ctx.H); }

/**
 * Compute and cache everything font-dependent (name glyph SDFs, NOTCH, NSTAR, roleLayout,
 * nameLayout, T_DOT). Idempotent; call from any shot's init(ctx). Returns a summary object.
 */
export function initSys(ctx) {
  remember(ctx);
  const name = nameLayout(ctx), role = roleLayout(ctx);
  return { NOTCH: NOTCH(ctx), NOTCH_X: NOTCH_X(ctx), NSTAR: NSTAR(ctx), T_DOT: role.T_DOT, nameLayout: name, roleLayout: role };
}
