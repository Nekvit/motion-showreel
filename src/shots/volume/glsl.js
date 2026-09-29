// volume: GLSL shared by the bake, the half-res trace, the full-res glass refinement and the composite.
// Units: world units (wu); the V has cap 1 wu, baseline on the floor (y = 0), ink-centred on x = 0.
// Requires ${ctx.glsl.common}${sys.SYS_GLSL} before it (INK/BONE/VERM/COBALT/WARM, KEY3, glyphD).
import { polyGlsl } from './poly.js';

// ── The V: extruded glyph SDF + marching ────────────────────────────────────────
// verts: the V's exact polygon (poly.js, fitted to _sys's glyph SDF; wu, ink-centred) or null, in which case
// the (smoothed) glyph SDF texture stands in for it. Two distances: sdVF (the raw raster SDF, cheap) for
// every marching step, and sdV (exact) where the answer is used: hit refinement, exits, normals.
export function makeSdfGlsl(verts) {
  const d2 = verts ? `${polyGlsl(verts)}
float sdV2(vec2 xy){ vec2 g; return sdPolyG(xy, g); }
float sdV2G(vec2 xy, out vec2 g){ return sdPolyG(xy, g); }` : `
float sdV2(vec2 xy){ return glyphD(uVTex, uVMeta, vec2(xy.x + uVMeta.w, xy.y)); }
// gradient over a wide stencil: the raster's periodic sub-pixel error (≈9-texel beat along the diagonals)
// is suppressed ~20×
float sdV2G(vec2 xy, out vec2 g){
  const float e2 = 0.008;
  g = normalize(vec2(sdV2(xy + vec2(e2, 0.0)) - sdV2(xy - vec2(e2, 0.0)), sdV2(xy + vec2(0.0, e2)) - sdV2(xy - vec2(0.0, e2))) + 1e-9);
  return sdV2(xy);
}`;
  return /* glsl */`
uniform sampler2D uVTex; uniform sampler2D uVTexF; uniform vec4 uVMeta;   // smoothed / raw glyph SDF; (ox, oy, capPx, inkCx)
uniform vec3 uBMin; uniform vec3 uBMax;         // the V's bounding box (wu, with margin)
const float V_HZ = 0.146;                       // half depth: total 0.292 = the 850 stem
const float V_RND = 0.012;                      // edge rounding
const float IOR_M = 1.50, IOR_S = 1.53, IOR_L = 1.47;
${d2}
float sdV2F(vec2 xy){ return glyphD(uVTexF, uVMeta, vec2(xy.x + uVMeta.w, xy.y)); }
float sdExtrude(float d2, float z){
  vec2 w = vec2(d2 + V_RND, abs(z) - (V_HZ - V_RND));
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - V_RND;
}
float sdV(vec3 p){ return sdExtrude(sdV2(p.xy), p.z); }
float sdVF(vec3 p){ return sdExtrude(sdV2F(p.xy), p.z); }
// Normal from the extrusion's own structure (exact, smooth bevels).
vec3 nrmV(vec3 p){
  vec2 g2; float d2 = sdV2G(p.xy, g2);
  vec2 w = vec2(d2 + V_RND, abs(p.z) - (V_HZ - V_RND));
  float sz = p.z >= 0.0 ? 1.0 : -1.0;
  if (w.x > 0.0 && w.y > 0.0) return normalize(vec3(g2 * w.x, sz * w.y));
  return w.x > w.y ? vec3(g2, 0.0) : vec3(0.0, 0.0, sz);
}
vec3 safeInv(vec3 d){ return vec3(d.x >= 0.0 ? 1.0 : -1.0, d.y >= 0.0 ? 1.0 : -1.0, d.z >= 0.0 ? 1.0 : -1.0) / max(abs(d), vec3(1e-7)); }
vec2 vBox(vec3 ro, vec3 rd){
  vec3 iv = safeInv(rd); vec3 a = (uBMin - ro) * iv, b = (uBMax - ro) * iv;
  vec3 lo = min(a, b), hi = max(a, b);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}
// Sphere-trace the V from outside, only inside its box and before tMax. Hit: d < max(eps, cone·t).
// Returns t, or -1 on a miss.
// A ray that uses up its steps is crawling along a surface at grazing incidence: it hits (at its closest
// approach) rather than slipping through, which would dot grazing edges with see-through holes.
float marchV(vec3 ro, vec3 rd, float tMax, float cone, int steps){
  vec2 b = vBox(ro, rd);
  float t = max(b.x, 0.0), t1 = min(b.y, tMax);
  if (t >= t1) return -1.0;
  float tm = -1.0, dm = 1e9;
  for (int i = 0; i < 128; i++){
    if (i >= steps) break;
    float d = sdVF(ro + rd * t);
    if (d < max(0.0008, cone * t)) { tm = t; dm = 0.0; break; }
    if (d < dm) { dm = d; tm = t; }
    t += d;
    if (t > t1) return -1.0;
  }
  if (dm >= 0.006) return -1.0;
  // onto the exact surface (an exact sphere-tracing step from the raster hit, which is within ≈0.0008)
  tm += sdV(ro + rd * tm);
  return tm;
}
// March inside the glass from a surface point along d; returns the distance to the exit. The exit is
// the sign change of the SDF (bisected), with a minimum step, so a ray running parallel and close to a
// face inside the glass keeps going instead of stopping as if it had left.
float marchIn(vec3 p, vec3 d, int steps){
  float t = 0.003, tp = 0.0;
  for (int i = 0; i < 64; i++){
    if (i >= steps) break;
    float s = -sdVF(p + d * t);
    if (s < 0.0) {
      float a = tp, b = t;
      for (int k = 0; k < 6; k++){ float m = 0.5 * (a + b); if (sdVF(p + d * m) < 0.0) a = m; else b = m; }
      return 0.5 * (a + b);
    }
    tp = t;
    t += max(s, 0.018);
  }
  return t;
}
float fresnel04(float c){ return 0.04 + 0.96 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
float gBounce;   // total internal reflections along the current glass path (reset by the caller)
${verts ? PRISM_GLSL : MARCH_PATH_GLSL}
`;
}

// Inside the glass the V is treated as its exact prism (polygon × |z| ≤ V_HZ; the 0.012 rounding only
// matters where the eye ray lands, which the SDF hit and normal keep). Light paths are then analytic:
// the first crossing of the outline in 2D, or a z face. The z faces are parallel planes, so a ray that
// reflects totally off one reflects totally off both, forever (a light pipe): its xy path is straight
// and its z is folded — exact at any length, so the edge-on slab shows its crisp mirrored bands.
const PRISM_GLSL = /* glsl */`
float cr2(vec2 a, vec2 b){ return a.x * b.y - a.y * b.x; }
// first crossing of the outline by o + d·t with t in (t0, t1); n: that edge's outward normal (CCW polygon)
float polyCross(vec2 o, vec2 d, float t0, float t1, out vec2 n){
  float tb = t1; vec2 eb = vec2(1.0, 0.0);
  for (int k = 0; k < POLY_N; k++){
    vec2 a = uPoly[k], e = uPoly[k + 1] - a;
    float den = cr2(d, e);
    if (abs(den) < 1e-12) continue;
    vec2 w = a - o;
    float t = cr2(w, e) / den, s = cr2(w, d) / den;
    if (t > t0 && t < tb && s >= -1e-5 && s <= 1.00001) { tb = t; eb = e; }
  }
  n = normalize(vec2(eb.y, -eb.x));
  return tb;
}
// Enter the prism from outside along o + d·t (t < tmax): t (or −1) and the outward normal there.
float prismEnter(vec3 o, vec3 d, float tmax, out vec3 n){
  float t0 = 1e-4, t1 = tmax;
  n = vec3(0.0, 0.0, 1.0);
  if (abs(d.z) < 1e-7) { if (abs(o.z) > V_HZ) return -1.0; }
  else { float a = (-V_HZ - o.z) / d.z, b = (V_HZ - o.z) / d.z; t0 = max(t0, min(a, b)); t1 = min(t1, max(a, b)); }
  if (t0 >= t1) return -1.0;
  if (sdV2(o.xy + d.xy * t0) < 0.0) { n = vec3(0.0, 0.0, d.z > 0.0 ? -1.0 : 1.0); return t0; }
  vec2 n2; float t = polyCross(o.xy, d.xy, t0, t1, n2);
  if (t >= t1) return -1.0;
  n = vec3(n2, 0.0);
  return t;
}
// One glass segment: refract in at (p, n) with direction rd, follow the path through the prism (side-face
// total internal reflections up to 5, z faces folded while they reflect totally), refract out.
// q: exit point, din: inner direction at the exit, nq: outward normal at the exit, len: path length in
// glass, w: Fresnel transmission. false if the ray stays trapped.
bool glassPath(vec3 p, vec3 n, vec3 rd, float ior, int steps, out vec3 q, out vec3 din, out vec3 nq, out float len, out float w){
  vec3 d = refract(rd, n, 1.0 / ior);
  w = 1.0 - fresnel04(dot(-rd, n));
  len = 0.0;
  vec3 x = p - n * 3e-4; x.z = clamp(x.z, -V_HZ, V_HZ);   // just inside: the hit is only within float error of the face
  bool pipe = (1.0 - d.z * d.z) * ior * ior > 1.0;
  for (int b = 0; b < 6; b++){
    vec2 n2; float tx = polyCross(x.xy, d.xy, 1e-5, 1e3, n2);
    float tz = (pipe || abs(d.z) < 1e-7) ? 1e9 : ((d.z > 0.0 ? V_HZ : -V_HZ) - x.z) / d.z;
    vec3 m; float t;
    if (tz < tx) { t = max(tz, 0.0); x += d * t; m = vec3(0.0, 0.0, d.z > 0.0 ? 1.0 : -1.0); }
    else {
      if (tx > 5e2) break;
      t = tx; x.xy += d.xy * t;
      if (pipe) {
        float u = mod(x.z + V_HZ + d.z * t, 4.0 * V_HZ);
        if (u <= 2.0 * V_HZ) x.z = u - V_HZ; else { x.z = 3.0 * V_HZ - u; d.z = -d.z; }
      } else x.z += d.z * t;
      m = vec3(n2, 0.0);
    }
    len += t;
    vec3 o = refract(d, -m, ior);
    if (dot(o, o) > 0.0) { q = x; din = d; nq = m; w *= 1.0 - fresnel04(dot(o, m)); return true; }
    d = reflect(d, m);
    gBounce += 1.0;
  }
  q = x; din = d; nq = -d; return false;
}
float glassEnter(vec3 o, vec3 d, float tmax, out vec3 n){ return prismEnter(o, d, tmax, n); }
// The eye ray's hit: the exact prism analytically, then onto its 0.012 rounding by exact sphere steps (a flat
// face is hit at once; only a ray entering an edge's rounding zone steps, and one that grazes past the
// rounding marches on). No raster error: a marched raster hit, seen at grazing incidence, keeps the
// raster's texel-periodic error, which prints as sawtooth stripes on grazing faces.
float hitV(vec3 ro, vec3 rd, float tMax, float cone){
  vec3 n; float t = prismEnter(ro, rd, tMax, n);
  if (t < 0.0) return -1.0;
  float d = 1.0;
  for (int i = 0; i < 10; i++){
    d = sdV(ro + rd * t);
    if (d < 2e-5) break;
    t += d;
    if (t > tMax) return -1.0;
  }
  return d < max(1e-4, cone * t) ? t : -1.0;
}
`;

// Fallback for a non-polygonal glyph: the inner path is marched in the SDF.
const MARCH_PATH_GLSL = /* glsl */`
bool glassPath(vec3 p, vec3 n, vec3 rd, float ior, int steps, out vec3 q, out vec3 din, out vec3 nq, out float len, out float w){
  vec3 d = refract(rd, n, 1.0 / ior);
  w = 1.0 - fresnel04(dot(-rd, n));
  len = 0.0;
  vec3 x = p;
  for (int b = 0; b < 3; b++){
    float t = marchIn(x, d, steps);
    x += d * t; len += t;
    vec3 m = nrmV(x);
    vec3 o = refract(d, -m, ior);
    if (dot(o, o) > 0.0) { q = x; din = d; nq = m; w *= 1.0 - fresnel04(dot(o, m)); return true; }
    d = reflect(d, -m);
    x += d * 0.002;
    gBounce += 1.0;
  }
  q = x; din = d; nq = -d; return false;
}
float hitV(vec3 ro, vec3 rd, float tMax, float cone){ return marchV(ro, rd, tMax, cone, 48); }
float glassEnter(vec3 o, vec3 d, float tmax, out vec3 n){
  float t = marchV(o, d, tmax, 0.0, 36);
  n = t > 0.0 ? nrmV(o + d * t) : vec3(0.0, 0.0, 1.0);
  return t;
}
`;

// ── Studio: camera, analytic floor / cove / wall / ball, lights, environment, grids ─────
export const SCENE_GLSL = /* glsl */`
uniform vec3 uEye; uniform vec3 uCR; uniform vec3 uCU; uniform vec3 uCF; uniform float uTanH;
uniform vec2 uFh;           // the camera's horizontal forward (normalised, = uCF.xz for a level camera)
uniform vec4 uBall;         // centre xyz, radius
uniform vec3 uBallS;        // ellipsoid scale (sx, sy, sz)
uniform vec4 uLight;        // ambient, key irradiance, COBALT rim, overhead spot
uniform vec3 uKeyCyc;       // KEY3 turned with the yaw (camera-locked key: cyc and the ball's fill)
uniform vec3 uRimDir;       // camera-locked rim direction ((0.6, 0.3, -0.75) turned with the yaw)
uniform float uFill;        // camera-locked fill on the ball (0 at yaw 0; grows as KEY3 goes behind it)
uniform sampler2D uMap;     // floor map: r caustic IOR 1.53, g caustic IOR 1.47, b V soft shadow, a AO
uniform vec4 uMapRect;      // x0, z0, 1/width, 1/depth (wu)
uniform float uMapTexel;    // wu per map texel
uniform float uCausK;       // caustic gain
uniform vec4 uWall;         // grid pitch, line width, crosshair u, design px on the wall (wu)
uniform vec2 uCrossV;       // crosshair rows v (wu from eye height)
uniform float uCrossCoc;    // widest crosshair blur (px): soft crosshairs under the open aperture, never discs
uniform float uGridK;       // 1 = floor/wall grids drawn
uniform float uRimLobe;     // lower edge of the rim lobe: narrow in the lit studio, wide (full outline) in the blackout
uniform float uTransmit;    // 0 in the blackout: everything behind the glass is Ink, so its light path is skipped

const float CYC0 = 3.0, CYC1 = 3.5, CYCR = 0.5;
const float LOOKY = 0.6;
const float FLOOR_P = 1.0 / 9.0, FLOOR_LW = 0.0024;
// Lit cyc (camera-locked): the cove rolls the lit floor (1.0) into the wall (0.88 at its foot, 0.80 high up)
const float WALL0 = 0.88, WALL1 = 0.80;
// The studio beyond the set is dark (black flags: they give the glass its edges). The lit cyc and the key's
// pool on the floor end a few wu off the view axis (outside every primary view); secondary rays that leave
// the set see FLAG, plus two soft boxes: the key (a ≈20° disc around KEY3 whose radiance matches its
// irradiance) and an overhead box that rims the tops.
const float FLAG = 0.10;
const float SET0 = 5.5, SET1 = 11.0;
const float TOPBOX = 2.4;                        // overhead softbox radiance (reflections only)
const float CARD = 3.2;                          // the card behind the camera (glass reflections only)
const float KEY_L = 3.2;                         // key softbox radiance per unit key irradiance
const float SPOT_L = 30.0;                       // the blackout spot's lamp, seen in a mirror
const float SPOT_K = 1.18;                       // blackout spot on the ball: brightest visible diffuse = 1.0·VERM
const float BOUNCE = 0.38;                       // lit Bone floor bouncing onto the ball's underside

bool isLit(){ return uLight.y > 0.0; }
vec3 camDir(vec2 p){ return normalize(uCF + 2.0 * uTanH * (p.x * uCR + p.y * uCU)); }
vec3 glassSigma(){ return 0.35 * (vec3(1.0) - COBALT); }   // COBALT absorption, 0.35 per wu

// Escaping secondary rays: the dark studio with its overhead box (lit), or Ink with the spot's lamp
// overhead (blackout). The key box is added by keySpec() where a mirror sees it.
float gTight = 0.0;
float gRough = 0.0;     // 1 while shading the ball: its coat blurs the soft boxes a little (no hard arcs)
// A white card behind the camera (camera-locked, like the cyc), seen only by the glass: a tilted soft-edged
// window whose reflection lies across the V's faces (a Fresnel sheen with one crisp diagonal edge that
// slides as the FOV breathes and the faces turn), and which the TIR bands pick up as bright glints.
float cardA(vec3 rd){
  float back = -dot(rd, uCF);
  if (back <= 0.05) return 0.0;
  vec2 a = vec2(dot(rd, uCR), rd.y) / back;                      // tangents of the angles off the back axis
  float u = -a.x * 0.906 + a.y * 0.423, v = a.x * 0.423 + a.y * 0.906;   // upper left, edge tilted 25°
  return smoothstep(0.022, 0.030, u) * smoothstep(0.50, 0.44, u) * smoothstep(-0.30, -0.26, v) * smoothstep(0.34, 0.30, v);
}
vec3 skyCol(vec3 rd){
  if (!isLit()) return INK + WARM * (uLight.w * SPOT_L) * smoothstep(0.995, 0.9993, rd.y);
  return BONE * FLAG + WARM * (TOPBOX * (1.0 + 1.5 * gTight) * smoothstep(0.72 - 0.3 * gRough, 0.95, rd.y) + CARD * gTight * cardA(rd));
}
// The glass sees a tighter set than the camera and the ball's rough coat: its lit floor pool and cyc end
// just outside what any primary view shows of them, so strongly bent or grazing paths through the rounded
// edges and TIR bands find the dark studio and draw the glass's edges (glassParts sets gTight).
float floorFade(float r){ return smoothstep(mix(SET0, 2.4, gTight), mix(SET1, 4.6, gTight), r); }
float wallFade(float u){ return smoothstep(mix(SET0, 1.7, gTight), mix(SET1, 2.4, gTight), u); }

// Floor y = 0 (s ≤ 3), cove (radius 0.5), wall (s = 3.5, y ≥ 0.5); s = distance along the camera's
// horizontal forward. id: 1 floor, 2 cove, 3 wall, 0 escape.
float traceEnv(vec3 ro, vec3 rd, out int id, out vec3 n){
  vec2 fw = uFh;
  float so = dot(ro.xz, fw), sd = dot(rd.xz, fw);
  id = 0; n = vec3(0.0, 1.0, 0.0); float t = 1e9;
  if (rd.y < 0.0) { float tf = -ro.y / rd.y; if (tf > 0.0 && so + sd * tf <= CYC0) { t = tf; id = 1; } }
  if (sd > 1e-6) { float tw = (CYC1 - so) / sd; if (tw > 0.0 && tw < t && ro.y + rd.y * tw >= CYCR) { t = tw; id = 3; n = -vec3(fw.x, 0.0, fw.y); } }
  vec2 oc = vec2(so - CYC0, ro.y - CYCR), dd = vec2(sd, rd.y);
  float a = dot(dd, dd), b = dot(oc, dd), c = dot(oc, oc) - CYCR * CYCR, h = b * b - a * c;
  if (h > 0.0 && a > 1e-9) {
    float tc = (-b + sqrt(h)) / a; vec2 q = oc + dd * tc;
    if (tc > 0.0 && tc < t && q.x >= 0.0 && q.y <= 0.0) { t = tc; id = 2; n = normalize(vec3(-q.x * fw.x, -q.y, -q.x * fw.y)); }
  }
  return t;
}
// The ball (ellipsoid with radii r·uBallS). Returns t or 1e9.
float traceBall(vec3 ro, vec3 rd, out vec3 n){
  vec3 s = uBallS * uBall.w;
  vec3 oc = (ro - uBall.xyz) / s, dd = rd / s;
  float a = dot(dd, dd), b = dot(oc, dd), c = dot(oc, oc) - 1.0, h = b * b - a * c;
  n = vec3(0.0, 1.0, 0.0);
  if (h < 0.0) return 1e9;
  float t = (-b - sqrt(h)) / a;
  if (t <= 1e-4) return 1e9;
  n = normalize((oc + dd * t) / s);
  return t;
}
// Analytic soft shadow of the ball (IQ), k = 10 like the V's.
float ballShadow(vec3 ro, vec3 rd){
  float r = uBall.w * max(uBallS.x, uBallS.y);
  vec3 oc = ro - uBall.xyz; float b = dot(oc, rd); float c = dot(oc, oc) - r * r; float h = b * b - c;
  float d = sqrt(max(0.0, r * r - h)) - r; float t = -b - sqrt(max(h, 0.0));
  return t < 0.0 ? 1.0 : smoothstep(0.0, 1.0, 25.0 * d / t);
}
vec4 floorMap(vec2 xz, float lod){
  vec2 uv = (xz - uMapRect.xy) * uMapRect.zw;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(0.0, 0.0, 1.0, 1.0);
  vec4 m = textureLod(uMap, uv, lod);
  vec2 e = smoothstep(vec2(0.0), vec2(0.12), uv) * smoothstep(vec2(1.0), vec2(0.88), uv);   // grazing streaks fade out
  m.rg *= e.x * e.y;
  return m;
}
float mapLod(float fw){ return log2(max(fw / uMapTexel, 1.0)); }

// Dispersion only on the VERM–COBALT axis (§1.2). a: short-λ sample, b: long-λ sample (palDisperse's
// contract: an excess of a reads VERM, of b COBALT). The split is measured relative to the local
// brightness and the colour moves towards the pure token (at the brightness of the brighter sample)
// instead of adding ±(VERM − COBALT) to the base, which leaves the axis on bright Bone (amber / sky blue).
// g ∈ [0, 1] gates it: a split much wider than a fringe smears to neutral, as a real spectrum does.
// Palette guard: red and blue both well above green is neither token nor a mix of one with Bone/Ink:
// it is VERM + COBALT added (magenta). Such a colour falls back towards its own grey.
vec3 palGuard(vec3 c){
  float hi = max(c.r, c.b), e = min(c.r, c.b) - c.g - 0.08 * hi;
  return e > 0.0 ? mix(c, vec3(luma(c)), clamp(3.0 * e / max(hi, 1e-4), 0.0, 1.0)) : c;
}
vec3 dispAxis(vec3 a, vec3 b, float g){
  vec3 avg = 0.5 * (a + b);
  float la = luma(a), lb = luma(b);
  // the split is only meaningful when both samples see the same kind of thing (a brightness edge): when
  // their hues differ (the VERM ball against Bone) it smears neutral instead of tinting VERM with COBALT
  vec3 na = a / max(la, 1e-5), nb = b / max(lb, 1e-5);
  g *= 1.0 - smoothstep(0.25, 0.8, length(na - nb) / max(length(na) + length(nb), 1e-5) * 2.0);
  float k = clamp(2.2 * g * (la - lb) / max(la + lb, 1e-5), -0.7, 0.7);   // fringes read; no pixel flips to a pure token
  vec3 tint = (k > 0.0 ? VERM : COBALT) * max(la, lb);
  return palGuard(max(mix(avg, tint, abs(k)), 0.0));
}

// Lit BONE floor (no grid): ambient·AO + key·(V soft shadow + transmitted caustic)·ball shadow; the key's
// pool fades far from the set (only reflections ever see that far). Blackout: Ink.
vec3 floorLight(vec3 p, float lod){
  vec4 m = floorMap(p.xz, lod);
  if (!isLit()) return INK;                       // Bone renders as Ink in the blackout (never below it)
  vec3 caus = dispAxis(vec3(m.r), vec3(m.g), 1.0) * exp(-glassSigma() * 0.30);
  // key visibility: the V as an opaque soft occluder, a diffuse glass fill inside its shadow (§5.5
  // "shadow·0.4 + caustic"), plus the baked caustic of the light refracted through it
  // the caustic is the key's light the V redirected: it is drawn only inside the V's shadow (on the lit floor
  // it would only burn Bone to white smears), where it reads as focused lines
  vec3 E = vec3(m.b) + (1.0 - m.b) * 0.35 * exp(-glassSigma() * 0.30) + uCausK * caus * smoothstep(0.02, 0.45, 1.0 - m.b);
  float bs = mix(ballShadow(p, KEY3), 1.0, 0.7 * gRough);   // the ball's rough coat barely sees its own shadow
  return BONE * mix(uLight.x * m.a + uLight.y * KEY3.y * E * bs, vec3(FLAG), floorFade(length(p.xz)));
}
// Lit cyc, camera-locked (every yaw sees the same backdrop): a gentle studio gradient, never above BONE.
float cycLum(vec3 p, int id){
  float l = id == 2 ? mix(1.0, WALL0, smoothstep(0.0, CYCR, p.y)) : mix(WALL0, WALL1, smoothstep(CYCR, 3.0, p.y));
  // the glass also sees the black flags just outside the frame (left, right and overhead): they give its
  // edges their dark lines, as in any glass product shot (the camera never sees them)
  float fl = max(wallFade(abs(dot(p, uCR))), gTight * smoothstep(2.0, 2.6, p.y));
  return mix(l, FLAG * (1.0 - 0.6 * gTight), fl);
}
vec3 cycLight(vec3 p, int id){ return isLit() ? BONE * cycLum(p, id) : INK; }

// Box-filtered stripe |x| < w/2 over a footprint fw.
float stripCov(float x, float w, float fw){ return clamp((min(x + 0.5 * w, 0.5 * fw) - max(x - 0.5 * w, -0.5 * fw)) / fw, 0.0, 1.0); }
// Grid lines of width lw every pitch, every major-th one with opacity aMaj (else aMin), box-filtered over
// footprint fw around the nearest line; fades to the mean coverage when lines are closer than 4 px (pxw =
// unwidened pixel footprint) or the widened footprint approaches the pitch. Returns (INK opacity).
float gridAxis(float x, float pitch, float lw, float fw, float pxw, float major, float aMin, float aMaj){
  float k = floor(x / pitch + 0.5);
  float c = stripCov(x - k * pitch, lw, fw);
  float a = (mod(k, major) == 0.0 ? aMaj : aMin) * c;
  float mean = lw / pitch * mix(aMin, aMaj, 1.0 / major);
  float fade = max(smoothstep(4.0, 2.0, pitch / max(pxw, 1e-7)), smoothstep(0.45, 0.9, fw / pitch));
  return mix(a, mean, fade);
}
// Floor grid: 1/9 wu, INK 15%, every 9th line 30%, faded out between radius 1.5 and 2.3. Returns INK opacity.
// Seen through the glass the grid is drawn a little heavier (gLine: width, opacity), so its refracted,
// VERM/COBALT-split lines read at 1x the way a lens-like block of glass shows them.
vec2 gLine = vec2(1.0);
float floorGridA(vec2 xz, vec2 fw, vec2 pxw){
  float r = length(xz);
  if (r > 2.3 || uGridK == 0.0) return 0.0;
  float ax = gridAxis(xz.x, FLOOR_P, FLOOR_LW * gLine.x, fw.x, pxw.x, 9.0, 0.15, 0.30);
  float az = gridAxis(xz.y, FLOOR_P, FLOOR_LW * gLine.x, fw.y, pxw.y, 9.0, 0.15, 0.30);
  return min((1.0 - (1.0 - ax) * (1.0 - az)) * (1.0 - smoothstep(1.5, 2.3, r)) * gLine.y, 1.0);
}
// Wall coordinates: u lateral from the view axis, v from eye height.
vec2 wallUV(vec3 p){ return vec2(dot(p, uCR), p.y - LOOKY); }
// Wall grid: 60 px at f384, INK 20%, every 4th line 35%, a line through the view axis; plus the four
// registration crosshairs (24 px arms, 8 px circle, 1 px, INK), whose blur is capped (uCrossCoc) so the
// open aperture leaves soft crosshairs rather than grey discs. fwP: the unblurred pixel footprint.
// Returns INK opacity.
float wallGridA(vec2 uv, vec2 fw, float pxw, vec2 fwP){
  if (uGridK == 0.0) return 0.0;
  float P = uWall.x, lw = uWall.y * gLine.x;
  float au = gridAxis(uv.x, P, lw, fw.x, pxw, 4.0, 0.20, 0.35), av = gridAxis(uv.y, P, lw, fw.y, pxw, 4.0, 0.20, 0.35);
  // the grid dissolves into the plain cove over its last 0.15 wu (the wall starts at y = CYCR)
  float a = min((1.0 - (1.0 - au) * (1.0 - av)) * gLine.y, 1.0) * smoothstep(CYCR - LOOKY, CYCR + 0.15 - LOOKY, uv.y);
  float px = uWall.w;
  float dv1 = uv.y - uCrossV.x, dv2 = uv.y - uCrossV.y;
  vec2 q = vec2(abs(uv.x) - uWall.z, abs(dv1) < abs(dv2) ? dv1 : dv2);
  vec2 f = max(min(fw, fwP * (1.0 + uCrossCoc)), vec2(1e-6));
  if (max(abs(q.x), abs(q.y)) < 13.0 * px + max(f.x, f.y)) {
    float ring = stripCov(length(q) - 8.0 * px, px, 0.5 * (f.x + f.y));
    float arms = max(stripCov(q.y, px, f.y) * stripCov(q.x, 24.0 * px, f.x), stripCov(q.x, px, f.x) * stripCov(q.y, 24.0 * px, f.y));
    a = max(a, max(ring, arms));
  }
  return a;
}
vec3 inkMul(float a){ return mix(vec3(1.0), INK / BONE, a); }

// The key softbox seen in a mirror (warm, HDR; ≈20° radius, radiance matched to its irradiance).
vec3 keySpec(vec3 r){ return WARM * (uLight.y * KEY_L) * smoothstep(0.915 - 0.06 * gRough, 0.955, dot(r, KEY3)); }
// Camera-locked COBALT back light seen in a mirror direction (a broad soft box).
// The glass sees it as a wider strip (it hangs close behind the set), so the edges of the V and of the edge-on
// slab carry a crisp COBALT line against the Bone.
vec3 rimSpec(vec3 r){ float lo = isLit() ? mix(uRimLobe, 0.5, gTight) : uRimLobe; return COBALT * (uLight.z * 1.15) * smoothstep(lo, 0.97, dot(r, uRimDir)); }

// The ball's diffuse light: ambient·AO, the key (world-fixed, shadowed by the V), a camera-locked fill so
// the camera side stays lit when the orbit puts KEY3 behind the ball, the lit floor's bounce from below,
// and in the blackout the overhead spot (smooth Lambert-like falloff, no cone edge; top = 1.0·VERM).
vec3 ballDiffuse(vec3 n, float sh, float ao){
  float k = max(dot(n, KEY3), 0.0) * sh + uFill * max(dot(n, uKeyCyc), 0.0);
  vec3 e = vec3(uLight.x * ao + uLight.y * k);
  if (isLit()) e += BONE * (BOUNCE * (0.5 - 0.5 * n.y));
  e += vec3(uLight.w * SPOT_K * smoothstep(-0.8, 1.0, n.y));
  return VERM * e;
}
// COBALT rim on the ball: a faint kiss in the lit studio, the lower rim only in the blackout (the spot
// owns the top, which stays VERM).
float ballRimW(vec3 n){ return isLit() ? 0.12 : 0.2 * smoothstep(0.1, -0.5, n.y); }

// Secondary rays (reflections / refractions): ball (lite), floor, cove, wall; fw = world footprint.
vec3 shadeBallLite(vec3 p, vec3 n, vec3 rd){
  float F = fresnel04(dot(n, -rd));
  vec3 r = reflect(rd, n);
  float t = gTight; gTight = 0.0; gRough = 1.0;
  vec3 c = ballDiffuse(n, 1.0, 1.0) * (1.0 - F) + F * (skyCol(r) + keySpec(r) + ballRimW(n) * rimSpec(r));
  gTight = t; gRough = 0.0;
  return c;
}
// Grid-free studio colour along a secondary ray; reports where a grid would be (gid 1 floor with
// guv = xz, gid 3 wall with guv = wall uv, 2 ball, else 0) and the hit distance th (1e3 on escape), so
// the full-res passes can draw the grid crisply and measure dispersion splits.
// Written branch-free where it costs: SwiftShader executes every branch body, so each shading function is
// called exactly once and the results are selected.
vec3 envColG(vec3 ro, vec3 rd, float fw0, float spread, bool withBall, out float gid, out vec2 guv, out float th){
  vec3 nb; float tb = withBall ? traceBall(ro, rd, nb) : 1e9;
  int id; vec3 ne; float te = traceEnv(ro, rd, id, ne);
  vec3 sky = skyCol(rd);
  float tq = id == 0 ? 1.0 : te;
  vec3 p = ro + rd * tq;
  float fw = fw0 + spread * tq;
  // behind the camera the card stands on the floor (glass only)
  float card = (id == 1 && gTight > 0.5 && dot(rd.xz, uFh) < 0.0) ? cardA(rd) : 0.0;
  vec3 c = id == 1 ? floorLight(p, card > 0.0 ? 8.0 : mapLod(sqrt(fw * fw / max(abs(rd.y), 0.15)))) : cycLight(p, id);
  c = id == 0 ? sky : mix(c, sky, card);
  gid = card > 0.0 ? 0.0 : (id == 1 ? 1.0 : (id == 3 ? 3.0 : 0.0));
  guv = id == 1 ? p.xz : wallUV(p);
  th = (id == 0 || card > 0.0) ? 1e3 : te;
  if (tb < te) { gid = 2.0; th = tb; c = shadeBallLite(ro + rd * tb, nb, rd); }
  return c;
}
vec3 envCol(vec3 ro, vec3 rd, float fw0, float spread, bool withBall){
  float gid, th; vec2 guv;
  return envColG(ro, rd, fw0, spread, withBall, gid, guv, th);
}
`;

// ── Lit shading of primary hits (half-res trace and full-res refinement) ─────────────
export const SHADE_GLSL = /* glsl */`
float softShadowV(vec3 ro, vec3 rd){
  vec2 b = vBox(ro, rd);
  if (b.y <= max(b.x, 0.0)) return 1.0;
  float t = max(b.x, 0.004), res = 1.0;
  for (int i = 0; i < 20; i++){
    float d = sdVF(ro + rd * t);
    res = min(res, 10.0 * d / t);
    if (res < 0.01) break;
    t += clamp(d, 0.004, 0.1);
    if (t > b.y) break;
  }
  return clamp(res, 0.0, 1.0);
}
float aoV(vec3 p, vec3 n){
  float o = 0.0, w = 1.0;
  for (int i = 1; i <= 4; i++){ float h = 0.01 * float(i * i); o += (h - sdVF(p + n * h)) * w; w *= 0.6; }
  return clamp(1.0 - 3.0 * o, 0.0, 1.0);
}
// VERM matte with a clearcoat (F0 0.04): Lambert + fill + bounce, V glass shadow, 4-tap AO; the coat
// reflects the studio as a rough coat would (floor caustics and shadows mip-blurred away), the key
// softbox, and the blackout spot's lamp.
vec3 shadeBall(vec3 p, vec3 n, vec3 rd, float pixA, float tp){
  vec3 v = -rd;
  float F = fresnel04(dot(n, v));
  float sh = isLit() ? mix(0.72, 1.0, softShadowV(p + n * 0.003, KEY3)) : 1.0;   // the glass V's shadow: it transmits most of the key
  float ao = aoV(p, n);
  vec3 r = reflect(rd, n);
  gRough = 1.0;
  vec3 spec = envCol(p + n * 0.003, r, tp * pixA + 0.2, 0.25, false) + keySpec(r) * sh + ballRimW(n) * rimSpec(r);
  gRough = 0.0;
  return ballDiffuse(n, sh, ao) * (1.0 - F) + F * spec;
}
// Glass: Fresnel reflection + transmission through up to two glass segments (the second arm), the final
// exit split into IOR 1.53 / 1.47 rays; COBALT Beer–Lambert absorption. glassParts() returns the pieces
// so the caller can put the grid into each dispersed sample before they are combined (dispAxis).
struct GP {
  vec3 refl;      // F·reflection
  vec3 cS, cL;    // studio colour seen by the IOR 1.53 / 1.47 exit rays (grid-free)
  vec3 k;         // their transmission: (1 − F)·Fresnel·Beer–Lambert
  float idS, idL; // what they hit: 1 floor, 3 wall (grid), 2 ball, 0 other
  vec2 uvS, uvL;  // where (floor xz / wall uv)
  float land;     // distance travelled from the eye to the landing (for the pixel footprint)
  float g;        // dispersion gate: 1 for a fringe-sized split, → 0 for a wide one
  float flag;     // total internal reflections / rounded-edge path: unresolvable at half res
  vec3 dir;       // the direction the transmitted light finally leaves in (its spread across a pixel quad
                  // measures how strongly the glass magnifies there)
  float thru;     // 1: the path crossed both arms (a rounded edge of the far arm seen through the near one)
};
vec3 glassCombine(GP a, vec3 gS, vec3 gL){ return palGuard(a.refl + a.k * dispAxis(a.cS * gS, a.cL * gL, a.g)); }
GP glassParts(vec3 ro, vec3 rd, vec3 p, float tp, float pixA){
  GP a;
  gTight = 1.0;
  a.idS = 0.0; a.idL = 0.0; a.uvS = vec2(0.0); a.uvL = vec2(0.0); a.g = 1.0; a.land = tp; a.dir = rd; a.thru = 0.0;
  gBounce = 0.0;
  vec3 n = nrmV(p);
  vec3 v = -rd;
  float F = fresnel04(dot(n, v));
  // a grazing hit on a rounded edge is a sub-pixel feature at half res
  bool bevel = sdV2F(p.xy) + V_RND > -0.002 && abs(p.z) - (V_HZ - V_RND) > -0.002 && dot(n, v) < 0.7;
  float fw0 = tp * pixA, spread = pixA;
  vec3 r = reflect(rd, n);
  vec3 q, din, nq; float len, w;
  a.refl = vec3(0.0); a.cS = skyCol(-rd); a.cL = a.cS; a.k = vec3(1.0 - F);
#ifdef BLACKOUT
  // blackout: studio Ink, ball above the slab → the body transmits Ink (never darker than the void); its
  // light is the composite's analytic rim outline (the faces are seen at grazing incidence, where mirror
  // images of the rim and the spot's lamp would only scatter as sparkle); the composite lays the ball
  // over it where it is behind
  a.cS = INK; a.cL = INK; a.k = vec3(1.0 - F); a.refl = F * INK;
  a.flag = 0.0; gTight = 0.0;
  return a;
#else
  a.refl = F * (envCol(p + n * 0.002, r, fw0, spread, true) + keySpec(r) + rimSpec(r));
  bool ok = glassPath(p, n, rd, IOR_M, 40, q, din, nq, len, w);
  // the second arm (only a path that left the first one can enter it)
  vec3 dm = ok ? refract(din, -nq, IOR_M) : din;
  vec3 n2 = vec3(0.0, 0.0, 1.0); float t2 = ok ? glassEnter(q + dm * 0.002, dm, 3.0, n2) : -1.0, gap = 0.0;
  vec3 q2, din2, nq2; float len2, w2, b1 = gBounce;
  bool ok2 = glassPath(q + dm * (0.002 + max(t2, 0.0)), n2, dm, IOR_M, 24, q2, din2, nq2, len2, w2);
  if (t2 > 0.0 && ok2) { q = q2; din = din2; nq = nq2; len += len2; gap = t2; w *= w2; a.thru = 1.0; } else gBounce = b1;
  // one pair of dispersed exit rays (a trapped path leaves along its last direction, undispersed)
  vec3 dS = refract(din, -nq, IOR_S), dL = refract(din, -nq, IOR_L);
  if (dot(dS, dS) == 0.0) dS = dL;
  if (dot(dL, dL) == 0.0) dL = dS;
  if (!ok || dot(dS, dS) == 0.0) { dS = din; dL = din; gBounce = max(gBounce, 3.0); }
  a.dir = dS;
  float fw1 = fw0 + len * spread, thS, thL;
  a.cS = envColG(q + dS * 0.003, dS, fw1, spread, true, a.idS, a.uvS, thS);
  a.cL = envColG(q + dL * 0.003, dL, fw1, spread, true, a.idL, a.uvL, thL);
  a.k = vec3(w) * exp(-glassSigma() * len);   // w: every interface's Fresnel transmission, entry included
  a.land = tp + len + gap + 0.5 * (thS + thL);
  // the split, in pixels at the landing: a fringe (a few px) keeps its colour, a patch smears neutral
  float split = length(dS * thS - dL * thL) / (pixA * a.land);
  a.g = 1.0 - smoothstep(10.0, 40.0, split);
  a.flag = max(gBounce >= 3.0 ? 1.0 : 0.0, bevel ? 1.0 : 0.0);
  gTight = 0.0;
  return a;
#endif
}
`;
