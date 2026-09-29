// field — FIG. 6 FIELD [576,672), station 5 (T), stateful, overlap 12. Drop 2. (DIRECTION.md §5.7)
//
// The I becomes a T of vermilion dust. The T peels into a storm while the dot, now a comet,
// leads the camera through it, and everything converges into the name.
//
// Particles: 512×384 = 196,608 grains. State: MRT RGBA32F ping-pong
//   tex0 = (pos.xyz, –)   tex1 = (vel.xyz, phase)   phase 0 home · 1 storm · 3 lattice/flight (tex1.xyz = node)
// Static per-grain data: A = (home.xy, target.xy), B = (lockEnergy, tRelease, code, tLand)
//   code = type + 4·crossbar, type 0 VERM letter grain · 1 BONE sparkle · 2 dot-bound (comet);
//   tLand = the frame the grain lands on its target (letters; its glyph's 4f right → left wipe, glyph windows
//   2f apart right → left over 640–654). From the snap, pos.w holds the grain's lattice node (grid index).
// Grain index order: [0,ND) dot-bound · crossbar letters (non-sparkle, then sparkle) · stem letters
//   (sparkle, then non-sparkle), so the IN streaks, the comet and the sparkles are contiguous draw ranges.
// Targets: at the lattice snap (the step of 624) the nodes are read back once and the letter grains are
//   matched to the name raster's stratified slots coherently (glyph by projected x, then Hilbert order
//   inside each glyph), so every node streams into one small region of one glyph. The mapping is a pure
//   function of the (deterministic) simulation, so it is identical in every replay.
// step(): one fragment pass, physics only. Home (1px breathing hover) → release (asymmetric: the right
//   arm is drawn into the comet's wake, the left arm tumbles down and in depth, the stem erodes top-down
//   with early leakers; curl-dominated, log-normal speeds) → the storm (curl + drag, steered as a river
//   along the comet's path) → the lattice snap on 624 (the §5.7 spring ω 2π·6, ζ 0.6 onto the nearest
//   node, keeping the storm velocity, curl 20%) → an analytic flight node → target, each grain landing on its
//   own frame → rest. The comet (dot-bound grains) is analytic: plucked into the S0 disc at the tip on 600
//   (2f), then riding C(f), which passes the §5.7 knots on their frames.
// render(): prep pass (per grain: projection with this and the previous frame's camera, DOF size,
//   streak, decimation, energy, colour, coverage, layer) → sprites into Σ light / Σ coverage buffers
//   (dust; and the top layer: comet, landed type, sparkle glints, dust in front of the comet) → the
//   comet's shed sparks and its drag glow → resolve over the backplane grid → during the overlap, the
//   composite with flow's prevTex (the slash, the 6px halftone-cell dissolve, the VERM meniscus on flow's
//   ink matte).
import * as sys from './_sys.js';

// ── constants ────────────────────────────────────────────────────────────────
const F0 = 576;                          // first frame
const NX = 512, NY = 384, NG = NX * NY;  // 196,608 grains
const ND = 4096;                         // dot-bound grains (indices [0, ND))
const NLG = NG - ND;                     // letter grains
const T_CAP = 0.53, T_BASE = -0.315;     // the T: cap, baseline, ink-centred on x = 0
const SLASH_HT = 0.5 * 0.25 * T_CAP;     // §5.7: the slash is 0.25·0.53 thick (half-thickness)
const I_TOP = 0.2227;                    // top of flow's I at its OUT (measured on flow@576: rows ≥ 299.5 at 1080p)
// flow's I at its OUT (measured at 1080p: stem x 868–1051, rows 299–888) vs the dust T (877–1042, 306–882):
// the newborn stem grains sit on the I's silhouette and slide onto the T over 584–590
const I_SX = 184 / 166, I_Y0 = -0.3222, I_SY = (0.2231 + 0.3222) / (0.2167 + 0.3176), T_Y0 = -0.3176;
const CELL_PX = 6;                       // halftone-cell dissolve (design px)
const DEG = Math.PI / 180;
const D_BASE = 0.5 / Math.tan(20 * DEG); // 1.374: world z = 0 maps to screen p exactly at FOV 40°
const T_LEVEL = 0.95;                    // the dust T accumulates to ≈0.95·VERM
const DOT_LEVEL = 1.02;                  // lock level of the S0 cluster (≥1 → tonemaps to exactly #FF3A1F)
const CORE_PK = 2.5;                     // the comet core accumulates to ≈2.5
const KERN_EXT = 3.0;                    // sprite quad half-extent in σ
const PATH_F0 = 580, PATH_N = 84;        // comet path samples (frames 580…663)
const FOOT_A0 = 120;                     // sprite footprint budget (1080p px²): larger streaks/bokeh are decimated
const SNAP = 624;                        // lattice snap
const GATHER0 = 619;                     // the room assembles over 619–624: every grain picks its node (in view) and is pulled in
const REF_CAM = [624, 635];              // the cameras the room is framed for (each grain's node inside one's frustum)
const REHOME = 0.3;                      // share of in-view grains also re-homed (evens the room's density)
const LAT_W = 2 * Math.PI * 6, LAT_Z = 0.6;   // §5.7: the snap is a spring (ω 2π·6, ζ 0.6) onto the nearest node
const LAT_F = 0.6;                       // snapped-node intensity (spec ×0.35; raised: the nodes land at m ≈ 2–4 with the tighter jitter)
const LAT_JIT = 0.0015;                  // node jitter (wu; spec ≤ 0.004): a node reads as a tight cluster, not a haze
const POP = [1.4, 1.2, 1.1];             // the snap's brightness pop on 624, 625, 626
const FLY_KEEP = 0.25;                   // share of in-flight grains drawn (energy-normalised)
const FLY_F = 1.0;                       // in-flight intensity factor (× speed heat)
const LAND_LAST = 652;                   // the leftmost glyph's window starts on 652 (every glyph is on the raster by 659)
const LAND_GRID = 2;                     // glyph windows start 2f apart, right → left
const FILL = 7;                          // a glyph fills over 7f (a loose right → left front, mostly hashed: sparse → solid)
const COOL = 4;                          // a landed grain arrives hot VERM, flashes and cools to 1.0·BONE over 4f
const LAND_DOT = 660;                    // the comet lands at S0
const TAIL_N = 32, TAIL_LAG = 5;         // the comet's drag glow: ribbon along C(f − 0…5 f)
const NSPK = 1536;                       // sparks shed by the comet over 600–660
const HOVER = 0.0011;                    // the held T breathes by ≈1px
const STATIC0 = 670;                     // from here every grain is fixed on screen and cool; only the twinkle moves
const CLUMP = [0.2, 0.75, 0.72];          // grain density clumping inside the T (acceptance ramp, floor)

// ── deterministic helpers ────────────────────────────────────────────────────
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
// PCG hash, bit-identical to glsl.js pcg()
function pcg(v) {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const U32 = 1 / 4294967296;
// 2D value noise on a lattice of size s (H units), 0..1
function vnoise(x, y, s, seed) {
  const X = x / s, Y = y / s, xi = Math.floor(X), yi = Math.floor(Y), fx = X - xi, fy = Y - yi;
  const h = (i, j) => pcg((Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ seed) >>> 0) * U32;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}
// Hilbert index of (x, y) on an n×n grid (n a power of two)
function hilbert(n, x, y) {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = n - 1 - x; y = n - 1 - y; } const t = x; x = y; y = t; }
  }
  return d;
}

// Centripetal Catmull-Rom (Barry–Goldman) between P1 and P2, u ∈ [0,1].
function catmull(P0, P1, P2, P3, u) {
  const d = (a, b) => Math.max(Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5), 1e-4);
  const t0 = 0, t1 = t0 + d(P0, P1), t2 = t1 + d(P1, P2), t3 = t2 + d(P2, P3);
  const t = t1 + (t2 - t1) * u;
  const L = (A, B, ta, tb) => A.map((a, k) => (a * (tb - t) + B[k] * (t - ta)) / (tb - ta));
  const A1 = L(P0, P1, t0, t1), A2 = L(P1, P2, t1, t2), A3 = L(P2, P3, t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

// Periodic 3D gradient noise → divergence-free curl field, n³ texels, RMS |curl| = 1.
function bakeCurl(n = 32) {
  const PER = 4;                                   // noise lattice period (cells per texture period)
  const grads = [];
  let seed = 0x51f1e1d;
  const rnd = () => (seed = pcg(seed + 0x9e3779b9)) * U32;
  for (let c = 0; c < 6; c++) {                    // 3 potential components × 2 octaves
    const per = c < 3 ? PER : 2 * PER, g = new Float32Array(per * per * per * 3);
    for (let i = 0; i < per * per * per; i++) {
      let x, y, z, l;
      do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 1e-3);
      l = Math.sqrt(l); g[i * 3] = x / l; g[i * 3 + 1] = y / l; g[i * 3 + 2] = z / l;
    }
    grads.push({ per, g });
  }
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const noise = (G, x, y, z) => {
    const { per, g } = G;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    let r = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const ix = ((xi + dx) % per + per) % per, iy = ((yi + dy) % per + per) % per, iz = ((zi + dz) % per + per) % per;
      const k = ((iz * per + iy) * per + ix) * 3;
      const dot = g[k] * (xf - dx) + g[k + 1] * (yf - dy) + g[k + 2] * (zf - dz);
      r += dot * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return r;
  };
  const psi = new Float32Array(n * n * n * 3);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const X = x / n * PER, Y = y / n * PER, Z = z / n * PER, o = ((z * n + y) * n + x) * 3;
    for (let c = 0; c < 3; c++) psi[o + c] = noise(grads[c], X, Y, Z) + 0.5 * noise(grads[c + 3], 2 * X, 2 * Y, 2 * Z);
  }
  const at = (x, y, z, c) => psi[(((z + n) % n * n + (y + n) % n) * n + (x + n) % n) * 3 + c];
  const out = new Float32Array(n * n * n * 4);
  let ss = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = (c, ax) => (ax === 0 ? at(x + 1, y, z, c) - at(x - 1, y, z, c) : ax === 1 ? at(x, y + 1, z, c) - at(x, y - 1, z, c) : at(x, y, z + 1, c) - at(x, y, z - 1, c));
    const cx = d(2, 1) - d(1, 2), cy = d(0, 2) - d(2, 0), cz = d(1, 0) - d(0, 1);
    const o = ((z * n + y) * n + x) * 4;
    out[o] = cx; out[o + 1] = cy; out[o + 2] = cz; out[o + 3] = 0;
    ss += cx * cx + cy * cy + cz * cz;
  }
  const k = 1 / Math.sqrt(ss / (n * n * n));
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

const glf = x => { const s = (+x).toPrecision(9); return s.includes('.') || s.includes('e') ? s : s + '.0'; };
function f3(x) { const s = (+x).toPrecision(6); return s.includes('.') ? s : s + '.0'; }

// ── GLSL shared by step / prep / composite ───────────────────────────────────
function fieldGLSL(G) {
  return /* glsl */`
const float X_TIP = ${glf(G.xTip)};
const float STEM_HW = ${glf(G.stemHW)};
const vec2 BAND = vec2(${glf(G.bandLo)}, ${glf(G.bandHi)});   // crossbar rows (home space, H)
const vec2 S0 = vec2(${glf(G.S0.x)}, ${glf(G.S0.y)});
const float CELL = ${glf(CELL_PX)};
const float LAT_W = ${glf(LAT_W)}, LAT_Z = ${glf(LAT_Z)};
const float LAT_JIT = ${glf(LAT_JIT)};
// the 6px 45° halftone lattice of sys.halftone45 (anchored at q = 0)
vec2 cellUV(vec2 q){ vec2 u = q * (1080.0 / CELL); return vec2(u.x + u.y, u.y - u.x) * 0.70710678; }
vec2 cellCentre(vec2 id){ vec2 cu = id + 0.5; return vec2(cu.x - cu.y, cu.x + cu.y) * 0.70710678 * (CELL / 1080.0); }
// death frame of a (home-space) cell: the slash shatters from its tips toward the centre, hashed
float cellDeath(vec2 id){
  vec2 cq = cellCentre(id);
  float edge = clamp(abs(cq.x) / X_TIP, 0.0, 1.0);
  float h = sysHash(id + vec2(311.0, 173.0));
  return 582.0 + 3.0 * clamp(0.62 * (1.0 - edge) + 0.38 * h, 0.0, 1.0);
}
// a cell's dot shrinks over the 1.5f before its death; its grains are born as it starts to shrink
float birthFrame(vec2 home){ return cellDeath(floor(cellUV(home))) - 1.0; }
// the held T breathes: every grain orbits its home by ≈1px on its own slow period
vec3 hover(int i, float F){
  vec3 h = ihash3(i * 41 + 29);
  return ${glf(HOVER)} * vec3(sin(6.2831853 * (F / (18.0 + 14.0 * h.x) + h.y)), sin(6.2831853 * (F / (21.0 + 13.0 * h.z) + h.x)), 0.0);
}
// a standard normal from two uniforms
float gauss(vec2 u){ return sqrt(-2.0 * log(max(u.x, 1e-7))) * cos(6.2831853 * u.y); }
// ── lattice and converge ──
vec3 latticeNode(vec3 pos, int i){ return floor(pos * 18.0 + 0.5) / 18.0 + (ihash3(i * 5 + 11) - 0.5) * (2.0 * LAT_JIT); }
// a snapped grain keeps its node's grid index in pos.w (3 × 8 bits, exact in a float)
float nodeEncode(vec3 pos){ ivec3 q = clamp(ivec3(floor(pos * 18.0 + 0.5)), ivec3(-127), ivec3(127)) + 128;
  return float(q.x + 256 * q.y + 65536 * q.z); }
vec3 nodeDecode(float k, int i){ int n = int(k + 0.5);
  vec3 q = vec3(float(n & 255), float((n >> 8) & 255), float(n >> 16)) - 128.0;
  return q / 18.0 + (ihash3(i * 5 + 11) - 0.5) * (2.0 * LAT_JIT); }
// hashes shared by every grain of a lattice node (its grid index)
uint nodeKey(vec3 node){ ivec3 q = ivec3(floor(node * 18.0 + 0.5)) + 4096;
  return uint(q.x) * 73856093u ^ uint(q.y) * 19349663u ^ uint(q.z) * 83492791u; }
float nodeHash(vec3 node){ return float(pcg(nodeKey(node))) / 4294967295.0; }
vec3 nodeHash3(vec3 node){ uint k = nodeKey(node); return vec3(pcg3(uvec3(k, k * 7u + 3u, k * 13u + 11u))) / 4294967295.0; }
// a node's grains leave between 636 and 5f before they land: the lattice releases right → left
// as the glyphs fill right → left
float launchFrame(vec3 node, float tg, int i){
  // (the room empties over 636–647 as the camera pulls out: a late glyph's nodes leave early and fly longer)
  float l = 636.0 + (0.2 + 0.15 * nodeHash(node)) * (tg - 636.0) + 1.4 * (ihash(i * 23 + 1) - 0.5);
  return max(636.0, min(l, tg - 5.0));
}
// the flight: along the chord (u^2.2: it peels off the node, accelerates, arrives at speed) with a small
// arc shared by the node's whole bundle
vec3 flightPos(vec3 node, vec3 tgt, float tl, float tg, float F){
  float u = clamp((F - tl) / (tg - tl), 0.0, 1.0);
  vec3 d = tgt - node;
  vec3 r = nodeHash3(node) * 2.0 - 1.0;
  vec3 w = r - dot(r, d) / max(dot(d, d), 1e-8) * d;
  return node + d * pow(u, 2.2) + w * (0.1 * length(d) * sin(3.14159265 * u));
}
`;
}
// the comet path C(f) (uniform samples at integer frames) and the analytic comet ball
const PATH_GLSL = /* glsl */`
uniform vec3 uPath[${PATH_N}];                    // C(f) at frames PATH_F0 … PATH_F0 + PATH_N − 1
vec3 path(float f){ float u = clamp(f - ${PATH_F0}.0, 0.0, ${PATH_N - 1}.0); int k = int(min(floor(u), ${PATH_N - 2}.0));
  return mix(uPath[k], uPath[k + 1], u - float(k)); }
// the pluck: on 600 the dot-bound grains condense into the ball at the tip (a 2f snap: 18% of their
// offset left on 600, 3% on 601, none from 602)
float gatherG(float F){ return F < 600.5 ? 0.18 : (F < 601.5 ? 0.03 : 0.0); }
// a dot-bound grain: C(f) + its offset in the Vogel disc (squashed at the launch and on landing), held facing
// the camera so the dot always projects as a smooth disc, + what is left of its offset from home
vec3 cometPos(vec2 home, vec3 off, float F, vec2 sq, vec3 rightW){
  float g = gatherG(F);
  vec3 d0 = vec3(home, 0.0) - (path(600.0) + off);
  vec2 o = off.xy * sq;
  return path(F) + rightW * o.x + vec3(0.0, o.y, 0.0) + d0 * g;
}
`;

// ── camera (§5.7 World and camera) ───────────────────────────────────────────
function makeCamera(ctx, comet) {
  const E = ctx.ease.ease;
  return F => {
    // look-at (§5.7): k rises 0 → 1 over 600–612 and falls over 636–648 (inOutSine)
    const k = F < 600 ? 0 : F < 612 ? E.inOutSine((F - 600) / 12) : F < 636 ? 1 : F < 648 ? 1 - E.inOutSine((F - 636) / 12) : 0;
    // FOV 40° → 8° over 648–671 (reaches 8° on 671, the OUT frame; held through the tail)
    const fov = (F < 648 ? 40 : 40 - 32 * E.inOutSine(Math.min(1, (F - 648) / 23))) * DEG;
    let D;
    if (F < 600) D = D_BASE;
    else if (F < 636) D = lerp(D_BASE, 0.65, E.inOutCubic((F - 600) / 36));
    else if (F < 648) D = lerp(0.65, D_BASE, E.inOutCubic((F - 636) / 12));
    else D = 0.5 / Math.tan(fov / 2);
    const yaw = (F < 600 ? 0 : F < 636 ? 28 * E.inOutCubic((F - 600) / 36) : F < 656 ? 28 * (1 - E.inOutSine((F - 636) / 20)) : 0) * DEG;
    const C = comet(F);
    const L = [k * C[0], k * C[1], k * C[2]];
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const eye = [L[0] + D * sy, L[1], L[2] + D * cy];
    return { eye, fwd: [-sy, 0, -cy], right: [cy, 0, -sy], tanH: Math.tan(fov / 2), D, fov, yaw, L, zf: D };
  };
}
// world → screen px (y up) for a camera
function projPx(cam, X, W, H) {
  const d = [X[0] - cam.eye[0], X[1] - cam.eye[1], X[2] - cam.eye[2]];
  const vx = d[0] * cam.right[0] + d[2] * cam.right[2], vy = d[1], vz = d[0] * cam.fwd[0] + d[2] * cam.fwd[2];
  const s = 0.5 / (vz * cam.tanH);
  return { x: vx * s * H + W / 2, y: vy * s * H + H / 2, z: vz, s };
}

// the comet's squash (sx 1.2, sy 0.8) at the launch (600–601) and on landing (660–661), settled in 4f
const SQUASH = { 600: 1, 601: 1, 602: 0.3, 603: -0.07, 604: 0.015, 660: 1, 661: 1, 662: 0.3, 663: -0.07, 664: 0.015 };
const squash = F => { const a = SQUASH[F] ?? 0; return [1 + 0.2 * a, 1 - 0.2 * a]; };

export default {
  id: 'field',
  stateful: true,
  postOut: { bloom: 0.8, vignette: 0.18 },
  mb() { return 0; },   // stateful: the streaks are the motion blur (§5.7 Render)

  init(ctx) {
    const gl = ctx.gl;
    sys.initSys(ctx);
    const NL = sys.nameLayout(ctx);
    this.NL = NL;
    const W = ctx.W, H = ctx.H, aspect = ctx.aspect;
    this.halfW = aspect / 2;

    // ── the T: stationLetter(5) at cap 0.53, baseline −0.315, ink-centred on x = 0 ──
    const Tm = sys.glyphSDF(ctx, sys.stationLetter(ctx, 5));
    const Tp = sys.placeGlyph(Tm, T_CAP, T_BASE, 0);
    this.tU = Tp.uniforms('uTg');
    const bx = Tp.box;
    const xTip = bx.x1;
    const PXD = 1 / 1080;
    // crossbar rows: raster rows (1080p) wider than 1.5× the stem
    const stem = sys.STEM(850) * T_CAP;
    let cb0 = null, cb1 = null;
    for (let r = Math.floor((bx.y0 + 0.5) * 1080); r <= Math.ceil((bx.y1 + 0.5) * 1080); r++) {
      const y = (r + 0.5) / 1080 - 0.5;
      let w = 0;
      for (let x = bx.x0 - 2 * PXD; x <= bx.x1 + 2 * PXD; x += PXD / 4) if (Tp.d(x, y) < 0) w++;
      if (w * PXD / 4 > 1.5 * stem) { if (cb0 === null) cb0 = y; cb1 = y; }
    }
    if (cb0 === null) { cb1 = bx.y1 - PXD / 2; cb0 = bx.y1 - 0.234 * T_CAP; }   // fallback: the top ink rows
    const bandLo = cb0 - PXD / 2, bandHi = cb1 + PXD / 2;
    const nName = NL.glyphs.length;
    // glyph windows on the 3f grid, the leftmost (next to the dot) on 660 with the comet
    this.landStep = nName > 1 ? Math.min(LAND_GRID, 15 / (nName - 1)) : 0;
    this.land0 = LAND_LAST - this.landStep * (nName - 1);
    this.G = { xTip, bandLo, bandHi, yCb: 0.5 * (bandLo + bandHi), S0: NL.S0, stemHW: 0.5 * stem };

    // ── grains: PCG rejection sampling inside the T, with density clumps (≈11px) and a ragged ±1px edge ──
    const homes = new Float32Array(NG * 2);
    let n = 0, tries = 0, inside = 0;
    const SEED = 0x7f4a7c15;
    while (n < NG) {
      const u1 = pcg(SEED + 3 * tries) * U32, u2 = pcg(SEED + 3 * tries + 1) * U32, u3 = pcg(SEED + 3 * tries + 2) * U32;
      tries++;
      const x = bx.x0 - 2 * PXD + (bx.x1 - bx.x0 + 4 * PXD) * u1, y = bx.y0 - 2 * PXD + (bx.y1 - bx.y0 + 4 * PXD) * u2;
      const d = Tp.d(x, y);
      if (d < 0) inside++;
      if (d > PXD * 1.2 * (2 * vnoise(x, y, 0.004, 0x3c1) - 1)) continue;
      const cl = 0.6 * vnoise(x, y, 0.0075, 0x9e37) + 0.4 * vnoise(x, y, 0.0036, 0x51ed);
      if (u3 > CLUMP[2] + (1 - CLUMP[2]) * smooth(CLUMP[0], CLUMP[1], cl)) continue;
      homes[2 * n] = x; homes[2 * n + 1] = y; n++;
    }
    const areaT = (bx.x1 - bx.x0 + 4 * PXD) * (bx.y1 - bx.y0 + 4 * PXD) * inside / tries;   // H²
    const inBand = y => y >= bandLo && y <= bandHi;
    // crossbar grains: the band rows, plus the ragged-edge grains just under/over it outside the stem
    const isCross = (x, y) => inBand(y) || (y >= bandLo - 2 * PXD && y <= bandHi + 2 * PXD && Math.abs(x) > 0.5 * stem);
    const isSpark = k => pcg(k * 13 + 5) * U32 < 0.1;            // 10% BONE sparkles (by sample index)
    // dot-bound: the first ND samples in the right end of the crossbar (x ≥ x_tip − 0.06); a glyph
    // with too little ink there tops up with its rightmost remaining ink (fallback: "the rightmost ink")
    const isDot = new Uint8Array(NG), order = [];
    for (let i = 0; i < NG && order.length < ND; i++) {
      const x = homes[2 * i], y = homes[2 * i + 1];
      if (x >= xTip - 0.06 && inBand(y)) { order.push(i); isDot[i] = 1; }
    }
    if (order.length < ND) {
      const rest = [];
      for (let i = 0; i < NG; i++) if (!isDot[i]) rest.push(i);
      rest.sort((a, b) => homes[2 * b] - homes[2 * a] || a - b);
      for (let k = 0; order.length < ND; k++) { order.push(rest[k]); isDot[rest[k]] = 1; }
    }
    const groups = [[], [], [], []];                              // crossbar·plain, crossbar·sparkle, stem·sparkle, stem·plain
    for (let i = 0; i < NG; i++) if (!isDot[i]) {
      const c = isCross(homes[2 * i], homes[2 * i + 1]), sp = isSpark(i);
      groups[c ? (sp ? 1 : 0) : (sp ? 2 : 3)].push(i);
    }
    for (const g of groups) for (const i of g) order.push(i);
    this.nCross = groups[0].length + groups[1].length;
    this.sparkRange = [ND + groups[0].length, groups[1].length + groups[2].length];

    // ── targets: the nameLayout NAME raster at render resolution (stratified, exact) ──
    const cov = new Float32Array(W * H), gid = new Int8Array(W * H);
    NL.glyphs.forEach((g, gi) => {
      const b = g.place.box;
      const x0 = Math.max(0, Math.floor((b.x0 / aspect + 0.5) * W) - 3), x1 = Math.min(W - 1, Math.ceil((b.x1 / aspect + 0.5) * W) + 3);
      const y0 = Math.max(0, Math.floor((b.y0 + 0.5) * H) - 3), y1 = Math.min(H - 1, Math.ceil((b.y1 + 0.5) * H) + 3);
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const x = ((px + 0.5) / W - 0.5) * aspect, y = (py + 0.5) / H - 0.5;
        const c = clamp01(0.5 - g.place.d(x, y) * H);
        if (c > cov[py * W + px]) { cov[py * W + px] = c; gid[py * W + px] = gi; }
      }
    });
    const pix = [];
    for (let i = 0; i < W * H; i++) if (cov[i] > 1 / 512) pix.push(i);
    const P = pix.length;
    this.P = P;
    // the stratified slots: letter slot l ↦ filled pixel j = ⌊l·P/N⌋ with weight cov_j / c_j
    const slotPix = new Int32Array(NLG), slotM = new Uint8Array(NLG), slotC = new Uint8Array(NLG);
    for (let l = 0; l < NLG; l++) {
      const j = Math.floor(l * P / NLG);
      const c0 = Math.ceil(j * NLG / P), cj = Math.ceil((j + 1) * NLG / P) - c0;
      slotPix[l] = j; slotM[l] = l - c0; slotC[l] = cj;
    }
    this.tgt = { W, H, aspect, cov, gid, pix, slotPix, slotM, slotC, nName };

    const dA = new Float32Array(NG * 4), dB = new Float32Array(NG * 4), st0 = new Float32Array(NG * 4);
    const Sa = this.G.stemHW / xTip;
    const r = NL.S0.r, rPx = r * H;
    const eDot = DOT_LEVEL * Math.PI * rPx * rPx / ND;       // value·px² per dot grain at the lock
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    // release front noise: ±5f value-noise fbm of the home position (+±1.5f per grain), so the peel frays and erodes
    const relNoise = (x, y) => 10 * (0.5 * vnoise(x, y, 0.03, 0x77a1) + 0.5 * vnoise(x, y, 0.011, 0x1b3d) - 0.5);
    for (let k = 0; k < NG; k++) {
      const i = order[k];
      const hx = homes[2 * i], hy = homes[2 * i + 1];
      const cross = isCross(hx, hy);
      let tx = hx, ty = hy, wLock = 0, type, tg = 0;
      if (k < ND) {                                           // dot-bound → stratified disc at S0 (Vogel)
        const rr = r * Math.sqrt((k + 0.5) / ND), th = k * GOLD;
        tx = NL.S0.x + rr * Math.cos(th); ty = NL.S0.y + rr * Math.sin(th);
        wLock = eDot; type = 2;
      } else type = isSpark(i) ? 1 : 0;                       // letters: targets are assigned at the snap
      // release: the crossbar at 600 + 14·(1 − |x|/x_tip), both tips first (the right arm is drawn into the
      // comet's wake, the left arm tumbles down and in depth); the stem column (up through the crossbar's centre) erodes top-down, with 18% early leakers
      const jit = relNoise(hx, hy) + (pcg(k * 11 + 9) * U32 - 0.5) * 3;
      const arm = cross && Math.abs(hx) > this.G.stemHW;
      let tRel;
      if (type === 2) tRel = 600;
      else if (arm) tRel = 600 + 14 * (1 - Math.abs(hx) / xTip) + 0.5 * jit;   // §5.7: both tips first
      else if (pcg(k * 7 + 31) * U32 < 0.18) tRel = 601 + 12 * pcg(k * 5 + 17) * U32;
      else tRel = 606 + 10 * (bx.y1 - hy) / T_CAP + jit;
      tRel = Math.min(622, Math.max(600, tRel));
      dA.set([hx, hy, tx, ty], k * 4);
      dB.set([wLock, tRel, type + (cross ? 4 : 0), tg], k * 4);
      st0.set([cross ? hx * Sa : hx, hy, 0, 0], k * 4);
    }
    this.dA = dA; this.dB = dB;
    this.assigned = false;
    // the comet's gather: pos − C = off·(1 − g) + (home − C(600))·g, g the spring's free response. Its spread
    // shrinks below the disc's before it settles, so the ball's energy is scaled by the inverse density ratio
    // and its sprites widen with the residual (a smooth condensing ball, not Poisson speckle)
    {
      let sx = 0, sy = 0, mx = 0, my = 0, d2 = 0;
      for (let k = 0; k < ND; k++) { mx += dA[k * 4] - xTip; my += dA[k * 4 + 1] - this.G.yCb; }
      mx /= ND; my /= ND;
      for (let k = 0; k < ND; k++) {
        const hx = dA[k * 4] - xTip - mx, hy = dA[k * 4 + 1] - this.G.yCb - my;
        sx += hx * hx; sy += hy * hy;
        const ox = dA[k * 4 + 2] - NL.S0.x, oy = dA[k * 4 + 3] - NL.S0.y;
        d2 += (dA[k * 4] - xTip - ox) ** 2 + (dA[k * 4 + 1] - this.G.yCb - oy) ** 2;
      }
      const so = r * r / 4;
      this.gatherK = [sx / ND / so, sy / ND / so];
      this.gatherD = Math.sqrt(d2 / ND);
    }
    this.texA = ctx.dataTexture(NX, NY, dA);
    this.texB = ctx.dataTexture(NX, NY, dB);
    this.texInit = ctx.dataTexture(NX, NY, st0);
    const rhoT = NG / (areaT * H * H);                        // mean grains per px² in the T
    this.eT = T_LEVEL / rhoT;                                 // value·px² of a mean (0.625) grain
    this.debug = { P, NLG, areaT, rhoT, eT: this.eT, eDot, xTip, cb0, cb1, tries, nCross: this.nCross, spark: this.sparkRange, land0: this.land0, landStep: this.landStep };

    // ── curl field 32³ (RGBA16F, repeat, linear) ──
    const curl = bakeCurl(32);
    this.curlTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.curlTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 32, 32, 32, 0, gl.RGBA, gl.FLOAT, curl);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT], [gl.TEXTURE_WRAP_R, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
    gl.bindTexture(gl.TEXTURE_3D, null);

    // ── comet path C(f): the centripetal Catmull-Rom of §5.7. It passes its knots on their frames (600, 612,
    // …, 660); between them the arc length follows a monotone C¹ cubic (PCHIP) through the knots' arc lengths,
    // from rest at the launch to rest at the landing, so the speed is continuous ──
    const PTS = [[xTip, this.G.yCb, 0], [0.45, 0.30, -0.20], [0.10, 0.05, -0.45], [-0.35, -0.10, -0.25], [-0.62, 0.03, -0.05], [NL.S0.x, NL.S0.y, 0]];
    const ext = [PTS[0].map((v, i) => 2 * v - PTS[1][i]), ...PTS, PTS[5].map((v, i) => 2 * v - PTS[4][i])];
    const cr = s => { const i = Math.min(4, Math.max(0, Math.floor(s))); return catmull(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], Math.min(1, s - i)); };
    const NS = 4000, arcL = new Float64Array(NS + 1);
    { let pp = cr(0); for (let k = 1; k <= NS; k++) { const p = cr(5 * k / NS); arcL[k] = arcL[k - 1] + Math.hypot(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]); pp = p; } }
    const Ltot = arcL[NS];
    const Ak = [0, 1, 2, 3, 4, 5].map(k => arcL[k * NS / 5]);
    const dl = [0, 1, 2, 3, 4].map(k => (Ak[k + 1] - Ak[k]) / 12);
    // Fritsch–Carlson; from rest at the launch, arriving at S0 with speed (1.6× the last span's mean): a real hit
    const mk = [0, ...[1, 2, 3, 4].map(k => 2 / (1 / dl[k - 1] + 1 / dl[k])), 1.6 * dl[4]];
    const arcAt = F => {
      const x = (F - 600) / 12, k = Math.min(4, Math.max(0, Math.floor(x))), t = x - k;
      const h00 = 2 * t ** 3 - 3 * t * t + 1, h10 = t ** 3 - 2 * t * t + t, h01 = -2 * t ** 3 + 3 * t * t, h11 = t ** 3 - t * t;
      return h00 * Ak[k] + h10 * 12 * mk[k] + h01 * Ak[k + 1] + h11 * 12 * mk[k + 1];
    };
    const sAt = a => {                                        // arc length → spline parameter
      const L = a * Ltot; let lo = 0, hi = NS;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arcL[m] <= L) lo = m; else hi = m; }
      const t = (L - arcL[lo]) / Math.max(arcL[hi] - arcL[lo], 1e-12);
      return 5 * (lo + t) / NS;
    };
    this.comet = F => {
      if (F <= 600) return PTS[0].slice();
      if (F >= LAND_DOT) return PTS[5].slice();
      return cr(sAt(arcAt(F) / Ltot));
    };
    this.cam = makeCamera(ctx, this.comet);
    this.refCam = REF_CAM.map(f => this.cam(f));
    this.morph = F => smooth(584, 590, F);
    this.pathU = [];
    for (let k = 0; k < PATH_N; k++) this.pathU.push(...this.comet(PATH_F0 + k));
    this.tailU = new Float32Array(TAIL_N * 3);
    // backplane pitch: exactly 60px on the module lines through the OUT camera (FOV 8°, f671+)
    const Dout = 0.5 / Math.tan(4 * DEG);
    this.gridPitch = sys.C_MOD * (Dout + 0.5) / Dout;

    // slash / crossbar contraction S(F): the crossbar in home space is stretched by S about x = 0
    const E = ctx.ease.ease, Sb = this.halfW / xTip;
    this.Sb = Sb;
    this.S = F => F <= 576 ? Sa : F < 579 ? Sa + (Sb - Sa) * E.outExpo((F - 576) / 3) : F < 585 ? 1 + (Sb - 1) * (1 - E.outCubic((F - 579) / 6)) : 1;
    // the slash's half-thickness: 0.25·0.53 (§5.7), retracting to the crossbar's with the width
    this.slashHT = F => { const hb = 0.5 * (bandHi - bandLo); return F < 579 ? SLASH_HT : hb + (SLASH_HT - hb) * (this.S(F) - 1) / (Sb - 1); };

    this.gather = F => {                                      // mirrors gatherG()
      const g = F < 600 ? 1 : F < 601 ? 0.18 : F < 602 ? 0.03 : 0;
      const q = (1 - g) ** 2, dens = 1 / Math.sqrt((q + g * g * this.gatherK[0]) * (q + g * g * this.gatherK[1]));
      return { uGatherE: Math.min(1, 1 / dens), uGatherS: 0.45 * Math.abs(g) * this.gatherD };
    };

    // ── GPU resources ──
    const F32 = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST, count: 2 };
    this.state = ctx.pingpong(NX, NY, F32);
    this.prep = ctx.fbo(NX, NY, { ...F32, count: 3 });
    this.accum = ctx.fbo(W, H);                               // dust: Σ light (rgb), Σ coverage (a)
    this.accumH = ctx.fbo(Math.ceil(W / 2), Math.ceil(H / 2));  // storm streaks at half resolution
    this.accumC = ctx.fbo(W, H);                              // top layer: landed type, glints, near dust, sparks
    this.accumD = ctx.fbo(W, H);                              // the comet's grains (its head, resolved over everything)
    this.stA = ctx.fbo(W, H); this.stC = ctx.fbo(W, H);       // the static cache (f ≥ 670): letters, dot
    this.stReady = false;
    this.world = ctx.fbo(W, H);
    this.edgeB = ctx.fbo(Math.ceil(W / 8), Math.ceil(H / 8)); // flow's matte: (min, max) of alpha per 8×8 block
    this.vao = gl.createVertexArray();

    // flow's core at its OUT (§5.6: the I at wght 850 about (0, −0.05)); for another letter flow uses the
    // same glyph, so the glyph SDF covers the fallback too
    const coreP = sys.placeGlyph(sys.glyphSDF(ctx, sys.stationLetter(ctx, 4)), T_CAP, T_BASE, 0);
    this.coreU = coreP.uniforms('uCore');
    const cb = coreP.box, m = 0.03;                           // the core's ink box + its 0.02 dilation + AA margin
    this.coreBox = [Math.max(Math.abs(cb.x0), Math.abs(cb.x1), bx.x1) + m, Math.min(cb.y0, bx.y0) - m, Math.max(cb.y1, bx.y1) + m];
    const FG = fieldGLSL(this.G);
    const HEAD = `${ctx.glsl.common}${ctx.glsl.hash}${sys.SYS_GLSL}${FG}`;

    // reset: initial state
    this.pReset = ctx.program(`${HEAD}
      uniform sampler2D uInit; layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
      void main(){ ivec2 ij = ivec2(gl_FragCoord.xy); o0 = texelFetch(uInit, ij, 0); o1 = vec4(0.0); }`, 'field:reset');

    // step: physics, advance one frame (dt = 1/60)
    this.pStep = ctx.program(`${HEAD}${PATH_GLSL}
      uniform sampler2D uP, uV, uA, uB; uniform highp sampler3D uCurl;
      uniform float uF, uT, uS, uCurlG, uMorph, uAspect, uRefTan; uniform vec2 uSq; uniform vec3 uRightW;
      uniform vec3 uRefEye[2], uRefFwd[2], uRefRight[2];
      layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
      const float DT = 1.0 / 60.0;
      // exact damped spring toward 0 over DT (ζ < 1)
      void spring(inout vec3 y, inout vec3 v, float w, float z){
        if (w <= 1e-4) { y += v * DT; return; }
        float wd = w * sqrt(1.0 - z * z), e = exp(-z * w * DT), c = cos(wd * DT), s = sin(wd * DT);
        vec3 y1 = e * (y * c + (v + z * w * y) / wd * s);
        vec3 v1 = e * (v * c - (z * w * v + w * w * y) / wd * s);
        y = y1; v = v1;
      }
      vec3 curlAt(vec3 p){ return texture(uCurl, (p * 1.6 + uT * 0.1) * 0.25).xyz; }
      // the room: a grain in the reference camera's view keeps its place (its nearest node); one out of view
      // (and a hashed share of the rest, evening the density) is re-homed uniformly in the frustum volume
      // (screen-uniform, depth ∝ z²) between z_v 0.22 and 2.1, in front of the backplane — near bokeh
      // layers to far fine points, all around the comet
      bool inRef(vec3 pos, int c){
        vec3 d = pos - uRefEye[c]; float vz = dot(d, uRefFwd[c]);
        vec2 sp = vec2(dot(d, uRefRight[c]), d.y) / (max(vz, 1e-3) * uRefTan);
        return vz > 0.22 && vz < 2.1 && abs(sp.x) < 0.96 * uAspect && abs(sp.y) < 0.96 && pos.z > -0.45;
      }
      vec3 roomPoint(vec3 pos, int i){
        if ((inRef(pos, 0) || inRef(pos, 1)) && ihash(i * 71 + 5) >= ${glf(REHOME)}) return pos;
        vec3 h = ihash3(i * 67 + 3);
        int c = ihash(i * 83 + 41) < 0.5 ? 0 : 1;
        vec3 re = uRefEye[c], rf = uRefFwd[c], rr = uRefRight[c];
        float z = pow(mix(0.22 * 0.22 * 0.22, 2.1 * 2.1 * 2.1, h.z), 1.0 / 3.0);
        vec2 s = (h.xy * 2.0 - 1.0) * vec2(uAspect, 1.0) * 0.97;
        vec3 dir = rf + rr * (s.x * uRefTan) + vec3(0.0, s.y * uRefTan, 0.0);
        vec3 X = re + dir * z;
        if (X.z < -0.45) X = re + dir * ((-0.45 - re.z) / dir.z);
        return X;
      }
      void main(){
        ivec2 ij = ivec2(gl_FragCoord.xy); int i = ij.y * ${NX} + ij.x;
        vec4 P = texelFetch(uP, ij, 0), V = texelFetch(uV, ij, 0), A = texelFetch(uA, ij, 0), B = texelFetch(uB, ij, 0);
        vec3 pos = P.xyz, vel = V.xyz; float ph = V.w;
        float type = mod(B.z, 4.0); bool cross = B.z >= 3.5; bool isDot = type > 1.5;
        vec3 tgt = vec3(A.zw, 0.0);
        if (uF < B.y) {                                   // at home (crossbar stretched by S during the IN)
          // (newborn grains sit on flow's I silhouette — wider stem, taller cap — and slide onto the T)
          vec2 hm = vec2(A.x * (cross ? uS : ${glf(I_SX)}), ${glf(I_Y0)} + (A.y - ${glf(T_Y0)}) * ${glf(I_SY)});
          hm = mix(hm, vec2(A.x * (cross ? uS : 1.0), A.y), uMorph);
          vec3 np = vec3(hm, 0.0) + hover(i, uF);
          o0 = vec4(np, 0.0); o1 = vec4((np - pos) * 60.0, 0.0); return;
        }
        if (isDot) {                                      // the comet (analytic)
          vec3 np = cometPos(A.xy, vec3(A.zw - S0, 0.0), uF, uSq, uRightW);
          o0 = vec4(np, 0.0); o1 = vec4((np - pos) * 60.0, 1.0); return;
        }
        bool arm = cross && abs(A.x) > STEM_HW;
        bool wake = arm && A.x > 0.0;
        bool snapped = ph > 1.5;                          // node chosen (gathering or snapped)
        if (ph < 0.5) {                                   // release: curl-dominated, the impulse secondary
          vec3 h1 = ihash3(i * 19 + 7), h2 = ihash3(i * 43 + 13);
          float spd = exp(0.75 * gauss(h2.xy) - 0.28);    // log-normal speed spread (mean 1)
          float sz = h1.z < 0.5 ? -1.0 : 1.0;
          vec3 bd; float sp, cone;
          if (wake) {                                     // right arm: drawn after the comet, along its path
            vec3 cv = path(uF + 1.0) - path(uF - 1.0);
            bd = dot(cv, cv) > 1e-10 ? normalize(cv) : normalize(vec3(0.6, 0.5, -0.4)); sp = 0.4; cone = 0.7;
          } else if (arm) {                               // left arm: flung down/out and in depth
            bd = normalize(vec3(-0.4, -0.3, sz * 0.85)); sp = 0.5; cone = 1.0;
          } else {                                        // stem: erodes into the curl
            bd = normalize(vec3(0.0, -0.1, sz * 0.7) + (h1 - 0.5)); sp = 0.25; cone = 1.2;
          }
          vec3 rr = h2.zxy * 2.0 - 1.0; vec3 pp = rr - dot(rr, bd) * bd;
          pp = dot(pp, pp) > 1e-6 ? normalize(pp) : vec3(0.0, 0.0, 1.0);
          float th = cone * sqrt(h1.x);
          vec3 dir = bd * cos(th) + pp * sin(th);
          vel = dir * (sp * spd) + curlAt(pos) * 1.3 + vec3(0.0, 0.0, (h1.y * 2.0 - 1.0) * 0.6);
          ph = 1.0;
        }
        if (snapped && uF < ${SNAP}.0) {                  // the room assembles: a stiffening pull onto the node
          vec3 node = nodeDecode(P.w, i);
          float u = (uF - ${GATHER0}.0) / ${SNAP - GATHER0}.0;
          vel += curlAt(pos) * (1.3 * 0.035 * (1.0 - u));
          vec3 y = pos - node;
          spring(y, vel, 6.2831853 * mix(3.0, 9.0, u), 0.75);
          pos = node + y;
          o0 = vec4(pos, P.w); o1 = vec4(vel, 2.0); return;
        }
        if (uF >= ${SNAP}.0) {                            // lattice: the spring (ω 2π·6, ζ 0.6) onto the node
          float key = snapped ? P.w : nodeEncode(pos);    // (a grain released after the gather: its nearest node)
          vec3 node = nodeDecode(key, i);
          if (uF < ${SNAP}.5) {                           // the lock on the downbeat: what is left of the pull
            vec3 y = pos - node; pos = node + 0.05 * y;   // snaps in; the spring keeps a short tick of overshoot
            float vl = length(vel); if (vl > 0.3) vel *= 0.3 / vl;
          }
          float tg = B.w, tl = launchFrame(node, tg, i);
          if (uF >= tl) { vec3 np = flightPos(node, tgt, tl, tg, uF); vel = (np - pos) * 60.0; pos = np; }
          else {                                          // the grain keeps its storm velocity: it whips in and overshoots
            vel += curlAt(pos) * (1.3 * 0.035 * 0.2);     // curl at 20%
            vec3 y = pos - node;
            spring(y, vel, LAT_W, LAT_Z);
            pos = node + y;
          }
          o0 = vec4(pos, key); o1 = vec4(vel, 3.0); return;
        }
        // storm: curl + drag, steered as a river along the comet's path
        vel += curlAt(pos) * (1.3 * 0.035 * uCurlG);
        vel *= 0.965;
        // each grain chases a point of the comet path inside a twisting tube. The right arm trails the
        // comet (its wake); the rest chases points that advance more slowly than the comet: the dust starts
        // ahead of it, it overtakes, and the camera riding it dives through the storm
        vec3 h = ihash3(i * 5 + 11), g = ihash3(i * 7 + 3);
        float rate = wake ? mix(0.55, 0.95, g.x) : mix(0.3, 0.85, g.x);
        float a0 = wake ? 600.0 - mix(0.0, 3.0, g.y) : 600.0 + mix(2.0, 30.0, g.y);
        float af = a0 + (uF - 600.0) * rate;
        vec3 u = normalize(ihash3(i * 13 + 1) * 2.0 - 1.0 + vec3(1e-3));
        float rad = wake ? mix(0.02, 0.18, sqrt(h.y)) : mix(0.05, 0.34, sqrt(h.y));
        float ang = 1.4 * uT * (h.z - 0.5);
        u.xy = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * u.xy;
        vec3 an0 = path(af - rate) + u * rad, an1 = path(af) + u * rad;
        vec3 av = (an1 - an0) * 60.0;
        float gain = wake ? smoothstep(B.y, B.y + 8.0, uF) : smoothstep(B.y + 6.0, B.y + 18.0, uF);
        vec3 y = pos - an0, v = vel - av;
        spring(y, v, 6.2831853 * 1.4 * gain, 0.55);
        pos = an0 + av * DT + y; vel = v + av;
        if (uF >= ${GATHER0}.0) {                         // the gather: pick this grain's node inside the room's frustum
          o0 = vec4(pos, nodeEncode(roomPoint(pos, i))); o1 = vec4(vel, 2.0); return;
        }
        o0 = vec4(pos, 0.0); o1 = vec4(vel, ph);
      }`, 'field:step');

    // prep: per grain screen-space sprite (centre px, half streak px, colour·energy, σ px, coverage, layer)
    this.pPrep = ctx.program(`${HEAD}${PATH_GLSL}
      uniform sampler2D uP, uV, uA, uB;
      uniform float uF, uScale, uET, uHeat, uTw, uPop, uLat, uGlint, uWhipK, uPF, uCool, uRDot, uGatherE, uGatherS, uStatic, uFlyKeep;
      uniform vec2 uCoreOff;       // the comet's hot core offset toward its motion (disc radii)
      uniform vec4 uComet;         // comet centre px, radius px, view depth (near dust crosses in front)
      uniform vec3 uEye, uFwd, uRight, uEyeP, uFwdP, uRightP;
      uniform vec2 uTan;           // tan(fov/2) now, previous
      uniform float uZf;
      uniform vec2 uScreen;
      layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2;
      vec3 view(vec3 X, vec3 eye, vec3 fwd, vec3 right){ vec3 d = X - eye; return vec3(dot(d, right), d.y, dot(d, fwd)); }
      vec2 toPx(vec3 v, float tanH){ vec2 p = v.xy / (v.z * tanH) * 0.5; return vec2(p.x * uScreen.y / uScreen.x + 0.5, p.y + 0.5) * uScreen; }
      void main(){
        ivec2 ij = ivec2(gl_FragCoord.xy); int i = ij.y * ${NX} + ij.x;
        o0 = vec4(-1e5); o1 = vec4(0.0); o2 = vec4(0.0);
        vec4 P = texelFetch(uP, ij, 0), V = texelFetch(uV, ij, 0), A = texelFetch(uA, ij, 0), B = texelFetch(uB, ij, 0);
        float tb = birthFrame(A.xy);
        if (uF < tb) return;                              // unborn: its cell has not started to die
        float type = mod(B.z, 4.0); bool isDot = type > 1.5; bool spark = type > 0.5 && type < 1.5;
        vec3 pos = P.xyz, tgt = vec3(A.zw, 0.0), prev;
        // mode: 0 home · 1 storm · 2 lattice · 3 flight · 4 landed · 5 comet
        int mode; float fu = 0.0;
        if (V.w < 1.5) { mode = isDot && uF >= 600.0 ? 5 : (V.w < 0.5 ? 0 : 1); prev = pos - V.xyz / 60.0; }
        else if (uF < ${SNAP}.0) { mode = 2; prev = pos - V.xyz / 60.0; }   // gathering onto its node
        else {
          vec3 node = nodeDecode(P.w, i);
          float tg = B.w, tl = launchFrame(node, tg, i);
          if (uF >= tg) { mode = 4; pos = tgt; prev = tgt; }
          else if (uF >= tl) { mode = 3; fu = (uF - tl) / (tg - tl); prev = flightPos(node, tgt, tl, tg, uF - 1.0); }
          else { mode = 2; prev = pos - V.xyz / 60.0; }
        }
        vec3 h = ihash3(i * 3 + 7);
        if (uStatic > 0.5) {
          // the static cache (f ≥ 670): every grain rests on its target at z = 0, seen by the frontal camera
          // (world z = 0 maps to screen p exactly); the twinkle is linear in sin/cos of the frame phase, so
          // the sprites accumulate its three weights once: (base, cos-part, sin-part)
          vec2 cs = vec2((tgt.x * uScreen.y / uScreen.x + 0.5) * uScreen.x, (tgt.y + 0.5) * uScreen.y);
          float sgs = max(1.6 * uScale / 2.3548, 0.6);
          if (isDot) sgs = max(sgs, 0.62 * uRDot * uScreen.y * 0.02769);
          float cz = cos(6.2831853 * h.z), sz = sin(6.2831853 * h.z);
          vec3 w = isDot ? B.x * vec3(1.025, 0.025 * cz, 0.025 * sz) : B.x * vec3(1.0, cz, sz);
          o0 = vec4(cs, 0.0, 0.0); o1 = vec4(w, sgs); o2 = vec4(isDot ? B.x / ${f3(DOT_LEVEL)} : 0.0, 0.0, 0.0, 0.0);
          return;
        }
        if (mode == 3 && ihash(i * 29 + 3) >= uFlyKeep) return;   // a hashed share of the flight is drawn
        vec3 v = view(pos, uEye, uFwd, uRight);
        if (v.z < 0.06) return;                           // behind / at the near plane
        vec3 vp = view(prev, uEyeP, uFwdP, uRightP);
        vec2 c = toPx(v, uTan.x);
        vec2 cp = vp.z > 0.02 ? toPx(vp, uTan.y) : c;
        // half streak (shutter 0.5, centred); snapped nodes strobe crisp for 3f; landed type barely smears;
        // in flight the streak follows the grain's own motion (its chord) plus 0.4 of the camera's
        vec2 hs;
        if (mode == 2 || mode == 3) {
          // snapped nodes and the flight streak with their own motion (the whip into the node, the chord), plus
          // only a part of the camera's, so the lattice reads as points with parallax, not as warp dashes
          vec3 vo = view(prev, uEye, uFwd, uRight);
          vec2 co = vo.z > 0.02 ? toPx(vo, uTan.x) : c;
          hs = 0.25 * ((c - co) + (mode == 3 ? 0.4 : (uF < ${SNAP}.0 ? 1.0 : 0.1)) * (co - cp));
        } else hs = 0.25 * (c - cp) * (mode == 4 ? 0.2 : 1.0) * uWhipK;
        if (mode == 0) { float ab = uF - tb; hs *= ab < 1.0 ? 0.0 : (ab < 2.0 ? 0.4 : 1.0); }   // no smear at birth
        if (mode == 5) { float Lc = length(hs), Lm = 10.0 * uScale; if (Lc > Lm) hs *= Lm / Lc; }
        // depth of field: s = clamp(1.6 + 24·|z_v − z_f|/z_v, 1.6, 16) design px; from 636 the focus
        // eases onto the name plane z = 0 (|z_v − z_plane|/z_v along the grain's ray), so type lands sharp.
        // Moving dust varies its size log-normally (±30%)
        float sc = 0.5 / (v.z * uTan.x);
        float bS = abs(v.z - uZf) / v.z;
        float bP = pos.z < uEye.z - 1e-4 ? abs(1.0 - uEye.z / (uEye.z - pos.z)) : 1.0;
        float sD = 1.6 + 24.0 * mix(bS, bP, uPF);
        vec3 hg = ihash3(i * 59 + 23);
        if (mode >= 1 && mode <= 3) sD *= exp(0.3 * gauss(hg.xy));
        sD = clamp(sD, 1.6, 16.0);
        if (mode == 5) sD = min(sD, 2.4);                // the head stays a crisp ball on every frame (no DOF)
        float e = 1.0;
        if (sD > 6.0 && mode != 5) {                      // energy-conserving decimation
          float keep = (6.0 / sD) * (6.0 / sD);
          if (h.x >= keep) return;
          e /= keep;
        }
        float sig = max(sD * uScale / 2.3548, 0.6);
        if (mode == 5) sig = max(sig, min(0.62 * uRDot * sc * uScreen.y * 0.02769 + uGatherS * sc * uScreen.y, 4.0 * uScale));   // ≥ 0.62 × the disc's grain spacing (+ the gather residual): a smooth disc
        float L = length(hs), sPx = sig * 2.3548;
        float bk = mode == 5 ? 0.0 : 0.85 * smoothstep(9.0, 18.0, sPx / uScale);   // Gaussian dust; only deep blur opens into bokeh
        float kx = max(bk < 1.0 ? ${f3(KERN_EXT)} * sig : 0.0, 0.5 * sPx + 1.0);
        // footprint budget (the DOF decimation's rule extended to streaks and bokeh): a sprite whose
        // quad covers A > A0 px² is kept with probability A0/A and carries A/A0 of the energy
        if (mode != 5 && mode != 4) {
          float side = 2.0 * (L + kx) + 1.0;
          float foot = L > max(kx, 3.0) ? side * (2.0 * kx + 1.0) : side * side, foot0 = ${f3(FOOT_A0)} * uScale * uScale;
          if (foot > foot0) {
            if (ihash(i * 17 + 5) >= foot0 / foot) return;
            e *= foot / foot0;
          }
        }
        float ext = kx + L;
        if (c.x < -ext || c.y < -ext || c.x > uScreen.x + ext || c.y > uScreen.y + ext) return;
        // radiance-invariant brightness: a dense region keeps its value under dolly/zoom
        e *= min(sc * sc, mode == 5 ? 16.0 : 8.0);
        e *= smoothstep(0.06, 0.12, v.z);
        // ── colour · energy ──
        float tw = sin(6.2831853 * (uF / 8.0 + h.z));      // hashed 8f twinkle
        float hv = mix(0.6, 0.8, h.y) / 0.7;              // per-grain value at rest (0.6–0.8), normalised to the T level
        float hvS = exp(0.5 * gauss(hg.zy) - 0.125);      // … once moving: log-normal (mean 1)
        float mv = smoothstep(B.y, B.y + 4.0, uF);
        // sparkles: a sparse subset glints (a sharp BONE point for ≈2f on the hashed 8f period) at rest
        float glint = ihash(i * 37 + 3) < 0.12 ? pow(0.5 + 0.5 * tw, 30.0) : 0.0;
        vec3 col; float cover, top = 0.0;
        if (mode == 4) {                                  // landed: 1.0·BONE per pixel (±5% twinkle), arriving warm white
          float en = B.x * (1.0 + 0.05 * tw);
          // it arrives as hot VERM dust, flashes warm white and cools to BONE over COOL frames
          float t = clamp((uF - B.w) / ${f3(COOL)}, 0.0, 1.0);
          vec3 hc = mix(VERM * 1.9, BONE * 1.35, smoothstep(0.0, 0.5, t));
          col = mix(hc, BONE, smoothstep(0.35, 1.0, t)) * en; cover = en; top = 1.0;
        } else if (mode == 3) {                           // in flight: the node's dust, heating as it accelerates
          float en = uET * hvS * ${f3(FLY_F)} * (1.0 + 1.5 * fu * fu) / uFlyKeep;
          col = VERM * en; cover = en / ${f3(T_LEVEL)};
        } else {
          float en;
          if (spark) en = uET * 11.0 * glint * uGlint;   // (no hot glints under the CA spike: CA would split them)
          else {
            float flare = 1.0 + 0.35 * exp(-(uF - tb) / 1.5);  // newborn grains glitter (1.35× at birth)
            // luminous dust: 4% hot grains carry 2.5× (the rest 0.9375×, the mean is kept), so the T is a
            // body of VERM with brighter specks that bloom, not an even noise fill
            float hot = ihash(i * 53 + 19) < 0.04 ? 2.5 : 0.9375;
            en = uET * mix(hv * hot, hvS * (hot > 1.0 ? 2.0 : 0.94), mv) * flare * (1.0 + uTw * tw);
          }
          if (spark) en *= 1.0 - smoothstep(2.0, 5.0, L / uScale);   // sparkles only glint at rest
          if (mode == 1) {                                // storm: fast grains heat
            float spd = length(V.xyz);
            if (spark) en *= 1.0 - smoothstep(0.15, 0.5, spd);
            else en *= 1.0 + 1.4 * uHeat * smoothstep(0.7, 2.4, spd);
          }
          if (mode == 2) {                                // nodes land at m ≈ 2–4 (a brightness pop on 624)
            // 40% of the nodes carry the light (×2.2, the rest ×0.2 — the mean is kept), so the lattice reads
            // as sparse ordered points, not as an even haze
            float lit = nodeHash(nodeDecode(P.w, i)) < 0.4 ? 2.2 : 0.2;
            en *= mix(1.0, ${f3(LAT_F)} * uPop * lit, uLat);   // (from the storm's value as the room assembles)
          }
          col = (spark ? BONE : VERM) * en;
          cover = spark ? 0.0 : en / ${f3(T_LEVEL)};
          if (spark && mode <= 2 && uF < 636.0) top = 1.0;   // glints stay uncompressed
          if (mode == 5) {                                // the comet ball: a white-hot core (leading) in a VERM disc
            vec2 dq = (A.zw - S0) / uRDot - uCoreOff;
            float r2 = dot(dq, dq);
            float rr = sqrt(r2), cm = smoothstep(0.34, 0.26, rr);   // a small hard-edged hot centre
            float val = mix(1.0 + ${f3(CORE_PK - 1)} * cm, ${f3(DOT_LEVEL)}, uCool);
            float Ec = B.x / ${f3(DOT_LEVEL)} * uGatherE;
            // the core rolls to warm white: a tight BONE heat on top of the VERM ≈2.5, flaring on the pluck
            float hot = (1.0 - uCool) * 1.2 * (1.0 + 1.2 * exp(-(uF - 600.0) / 2.0)) * smoothstep(0.22, 0.14, rr);
            col = (VERM * (val * (1.0 + 0.025 * (1.0 + tw))) + BONE * hot) * Ec;
            cover = Ec * min(val, 1.0);
            top = 1.0;
          }
        }
        // dust nearer than the comet that crosses its disc passes in front of it (the top layer)
        if (mode >= 1 && mode <= 3 && uComet.z > 0.0 && v.z < uComet.w - 0.02 && length(c - uComet.xy) < uComet.z + ext + 2.0) top = 1.0;
        if (max(col.r, max(col.g, col.b)) * e < 1e-7 && cover * e < 1e-7) return;   // dark: costs no fill
        o0 = vec4(c, hs);
        o1 = vec4(col * e, sig);
        o2 = vec4(cover * e, bk, top, 0.0);
      }`, 'field:prep');

    // sprites. The kernel is a Gaussian (FWHM = s) that opens into a soft bokeh disc (diameter s) as the
    // grain defocuses; both are swept along the streak segment and normalised to unit integral
    // (energy-conserving), evaluated in pixel space from gl_FragCoord. Non-instanced draws (instancing
    // is ~15× slower in SwiftShader): POINTS for grains whose streak is shorter than their kernel,
    // oriented quads (indexed, 4 vertices per grain) for the long streaks.
    const SPR_VS = `
      uniform sampler2D uQ0, uQ1, uQ2; uniform vec2 uRes; uniform float uScale, uDown;   // uDown: 1 full res, 0.5 half
      uniform int uPass;           // 0 points (short streaks) · 1 quads (long streaks) · 2 points (all)
      uniform int uLayer;          // 0 dust · 1 top
      flat out vec2 vC, vDir; flat out vec4 vCol; flat out vec4 vK;   // vK = (σ, half streak, bokeh radius, bokeh mix)
      bool grain(int i, out vec4 q0, out float ext){
        ivec2 ij = ivec2(i % ${NX}, i / ${NX});
        vec4 q1 = texelFetch(uQ1, ij, 0);
        q0 = texelFetch(uQ0, ij, 0);
        vC = vec2(0.0); vDir = vec2(1.0, 0.0); vCol = vec4(0.0); vK = vec4(1.0, 0.0, 1.0, 0.0); ext = 0.0;
        if (q1.a <= 0.0) return false;
        vec4 q2 = texelFetch(uQ2, ij, 0);
        if ((q2.z > 0.5) != (uLayer == 1)) return false;
        float L = length(q0.zw), sig = q1.a, sPx = sig * 2.3548;
        float bk = q2.y, R = 0.5 * sPx;
        ext = max(bk < 1.0 ? ${f3(KERN_EXT)} * sig : 0.0, R + 1.0);
        bool quad = L > max(ext, 3.0);
        if (uPass != 2 && quad != (uPass == 1)) return false;   // each path draws only its own grains
        float k = uDown;
        vC = q0.xy * k; vDir = L > 1e-4 ? q0.zw / L : vec2(1.0, 0.0);
        float sigT = max(sig * k, 0.6), RT = max(R * k, 0.8);
        vCol = vec4(q1.rgb, q2.x) * (k * k);              // energy per render px² → per target px
        vK = vec4(sigT, L * k, RT, bk);
        ext = max(bk < 1.0 ? ${f3(KERN_EXT)} * sigT : 0.0, RT + 1.0);
        return true;
      }`;
    const SPR_FS = `
      flat in vec2 vC, vDir; flat in vec4 vCol; flat in vec4 vK; out vec4 o;
      float erf_(float x){ float s = sign(x), a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
        return s * (1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a)); }
      void main(){
        vec2 d = gl_FragCoord.xy - vC;
        float a = dot(d, vDir), b = dot(d, vec2(-vDir.y, vDir.x));
        float s = vK.x, L = vK.y, R = vK.z, bk = vK.w, k = 0.0;
        if (bk < 1.0) {
          float is2 = 0.70710678 / s;
          float across = exp(-0.5 * b * b / (s * s)) * (0.39894228 / s);
          float along = L < 0.05 * s ? exp(-0.5 * a * a / (s * s)) * (0.39894228 / s)
                                     : (erf_((a + L) * is2) - erf_((a - L) * is2)) / (4.0 * L);
          k = across * along * (1.0 - bk);
        }
        if (bk > 0.0) {                                   // bokeh: a soft-edged disc swept along the streak (capsule)
          float dx = max(abs(a) - L, 0.0), dd = sqrt(dx * dx + b * b);
          float cov = smoothstep(R + 0.5, R - 1.5 - 0.12 * R, dd) * (0.9 + 0.15 * smoothstep(R - 3.0, R - 1.0, dd));
          k += bk * cov / (3.14159265 * R * R * 0.9 + 4.0 * R * L);
        }
        o = vCol * k;
      }`;
    this.pPoints = ctx.programVF(`${SPR_VS}
      void main(){
        vec4 q0; float ext;
        bool ok = grain(gl_VertexID, q0, ext);
        float L = vK.y;
        gl_PointSize = 1.0;
        if (!ok) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        gl_PointSize = min(2.0 * (L + ext) + 1.0, 1023.0);
        gl_Position = vec4(vC / (uRes * uDown) * 2.0 - 1.0, 0.0, 1.0);
      }`, SPR_FS, 'field:points');
    this.pQuads = ctx.programVF(`${SPR_VS}
      void main(){
        vec4 q0; float ext;
        bool ok = grain(gl_VertexID >> 2, q0, ext);
        float L = vK.y;
        if (!ok) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        int k = gl_VertexID & 3;
        vec2 cr = vec2((k & 1) == 0 ? -1.0 : 1.0, (k & 2) == 0 ? -1.0 : 1.0);
        vec2 px = vC + vDir * (cr.x * (L + ext + 0.5)) + vec2(-vDir.y, vDir.x) * (cr.y * (ext + 0.5));
        gl_Position = vec4(px / (uRes * uDown) * 2.0 - 1.0, 0.0, 1.0);
      }`, SPR_FS, 'field:quads');
    // the comet's shed sparks: analytic (emitted from the back of the head over 600–660 at a rate that
    // follows the comet's speed, ejected backward and sideways with drag), white-hot → VERM → dust
    this.pSparks = ctx.programVF(`${ctx.glsl.hash}${PATH_GLSL}
      uniform float uF, uScale, uR, uZf, uPF, uK;
      uniform vec3 uEye, uFwd, uRight, uEyeP, uFwdP, uRightP; uniform vec2 uTan, uScreen;
      flat out vec2 vC, vDir; flat out vec4 vCol; flat out vec4 vK;
      vec3 view(vec3 X, vec3 eye, vec3 fwd, vec3 right){ vec3 d = X - eye; return vec3(dot(d, right), d.y, dot(d, fwd)); }
      vec2 toPx(vec3 v, float tanH){ vec2 p = v.xy / (v.z * tanH) * 0.5; return vec2(p.x * uScreen.y / uScreen.x + 0.5, p.y + 0.5) * uScreen; }
      const vec3 VERM_ = vec3(1.0, 0.0423, 0.0137);
      void main(){
        int j = gl_VertexID >> 2, q = gl_VertexID & 3;
        vC = vec2(0.0); vDir = vec2(1.0, 0.0); vCol = vec4(0.0); vK = vec4(1.0, 0.0, 1.0, 0.0);
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vec3 h = ihash3(j * 97 + 5), h2 = ihash3(j * 31 + 77);
        float fe = 600.0 + 60.0 * (float(j) + h.x) / ${NSPK}.0;
        float life = mix(5.0, 14.0, h.y), tau = uF - fe;
        if (tau < 0.0 || tau >= life || fe > 659.0) return;
        vec3 cv = path(fe + 0.5) - path(fe - 0.5); float spd = length(cv);   // wu per frame
        if (h.z > smoothstep(0.002, 0.014, spd)) return;  // it sheds while it flies fast
        vec3 dir = cv / max(spd, 1e-6);
        vec3 rr = normalize(h2 * 2.0 - 1.0 + vec3(1e-3)); vec3 side = rr - dot(rr, dir) * dir;
        vec3 p0 = path(fe) + (0.8 * side - 0.9 * dir) * uR * mix(0.6, 1.0, h2.x);   // off the trailing limb
        vec3 v0 = -dir * spd * mix(0.05, 0.45, h2.y) + side * spd * mix(0.1, 0.7, h2.z);
        const float KD = 0.18;
        float g = (1.0 - exp(-KD * tau)) / KD, gp = (1.0 - exp(-KD * max(tau - 1.0, 0.0))) / KD - max(1.0 - tau, 0.0);
        vec3 X = p0 + v0 * g, Xp = p0 + v0 * gp;
        vec3 v = view(X, uEye, uFwd, uRight), vp = view(Xp, uEyeP, uFwdP, uRightP);
        if (v.z < 0.08) return;
        vec2 c = toPx(v, uTan.x), cp = vp.z > 0.02 ? toPx(vp, uTan.y) : c;
        vec2 hs = 0.25 * (c - cp);
        float L = length(hs);
        float bS = abs(v.z - uZf) / v.z, bP = X.z < uEye.z - 1e-4 ? abs(1.0 - uEye.z / (uEye.z - X.z)) : 1.0;
        float sD = clamp(1.6 + 24.0 * mix(bS, bP, uPF), 1.6, 6.0);
        float sig = max(sD * uScale / 2.3548, 0.6);
        float a = tau / life;
        float pk = 2.8 * pow(1.0 - a, 1.6) + 0.15;         // white-hot at the head, VERM, then dust
        float E = pk * 2.5066 * sig * (2.0 * L + 2.5066 * sig);
        vC = c; vDir = L > 1e-4 ? hs / L : vec2(1.0, 0.0);
        vCol = vec4(VERM_ * (E * uK), 0.0);
        vK = vec4(sig, L, 1.0, 0.0);
        float ext = 3.0 * sig;
        vec2 cr = vec2((q & 1) == 0 ? -1.0 : 1.0, (q & 2) == 0 ? -1.0 : 1.0);
        vec2 px = c + vDir * (cr.x * (L + ext + 0.5)) + vec2(-vDir.y, vDir.x) * (cr.y * (ext + 0.5));
        gl_Position = vec4(px / uScreen * 2.0 - 1.0, 0.0, 1.0);
      }`, SPR_FS, 'field:sparks');
    // quad index buffer: grain i uses vertices 4i … 4i+3
    const idx = new Uint32Array(NG * 6);
    for (let i = 0; i < NG; i++) idx.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 2, 4 * i + 1, 4 * i + 3], i * 6);
    this.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.quadVAO);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // the comet's drag glow: a soft VERM ribbon along C(f − lag), lag 0.5…5 f (triangle strip); its root is
    // as wide as the head and it swells with the comet's speed
    this.pTail = ctx.programVF(`
      uniform vec3 uTail[${TAIL_N}];
      uniform vec3 uEye, uFwd, uRight; uniform float uTanH, uR, uSpd; uniform vec2 uRes;
      out float vD, vW, vU, vF;
      vec3 view(vec3 X){ vec3 d = X - uEye; return vec3(dot(d, uRight), d.y, dot(d, uFwd)); }
      vec2 toPx(vec3 v){ vec2 p = v.xy / (v.z * uTanH) * 0.5; return vec2(p.x * uRes.y / uRes.x + 0.5, p.y + 0.5) * uRes; }
      void main(){
        int k = gl_VertexID >> 1; float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
        int ka = max(k - 1, 0), kb = min(k + 1, ${TAIL_N - 1});
        vec3 v = view(uTail[k]), va = view(uTail[ka]), vb = view(uTail[kb]);
        vU = float(k) / ${TAIL_N - 1}.0; vD = 0.0; vW = 1.0; vF = 0.0;
        if (v.z < 0.08 || va.z < 0.08 || vb.z < 0.08) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec2 c = toPx(v), t = toPx(vb) - toPx(va);
        float tl = length(t); t = tl > 1e-3 ? t / tl : vec2(1.0, 0.0);
        float rPx = uR / (v.z * uTanH) * 0.5 * uRes.y;
        float w = max(rPx * (1.0 + 0.7 * uSpd * vU) * pow(1.0 - vU, 0.45), 0.75);
        vW = w; vD = side * (w + 1.5);
        vF = clamp(0.5 * tl / (0.35 * w + 0.5), 0.0, 1.0);   // a ribbon foreshortened onto itself fades (no stacking)
        gl_Position = vec4((c + vec2(-t.y, t.x) * vD) / uRes * 2.0 - 1.0, 0.0, 1.0);
      }`, `${HEAD}
      in float vD, vW, vU, vF; uniform float uVal; out vec4 o;
      void main(){
        float x = abs(vD) / vW;
        float a = exp(-2.2 * x * x) * clamp(vW + 0.5 - abs(vD), 0.0, 1.0);
        float k = a * smoothstep(0.02, 0.2, vU) * pow(1.0 - vU, 1.3) * uVal * vF;
        o = vec4(VERM * k, 0.6 * min(k, 1.0));
      }`, 'field:tail');

    // backplane grid at z = −0.5 (GRAPHITE on INK), box-filtered, fog fade-in 612–630; resolve the grains
    this.pGrid = ctx.program(`${HEAD}
      in vec2 vUv; out vec4 o; uniform vec2 uRes;
      uniform vec3 uEye, uFwd, uRight; uniform float uTanH, uPitch, uFog, uStatic; uniform vec2 uTwSC;
      uniform vec3 uKnee;          // dust ceiling: knee, asymptote, mix
      uniform sampler2D uAcc, uAccH, uAccC, uAccD;
      uniform vec3 uHead; uniform vec2 uHeadSq; uniform float uHeadK;
      // coverage of lines of width w, pitch p, centred at k·p + c0, box-filtered over [u − f/2, u + f/2]
      float lines(float u, float f, float p, float w, float c0){
        float s0 = u - 0.5 * f + 0.5 * w - c0, s1 = u + 0.5 * f + 0.5 * w - c0;
        float I0 = floor(s0 / p) * w + min(mod(s0, p), w), I1 = floor(s1 / p) * w + min(mod(s1, p), w);
        return clamp((I1 - I0) / max(f, 1e-7), 0.0, 1.0);
      }
      void main(){
        vec2 p = P(vUv, uRes.x / uRes.y);
        vec3 col = INK;
        vec3 dir = uFwd + uRight * (2.0 * p.x * uTanH) + vec3(0.0, 2.0 * p.y * uTanH, 0.0);
        float t = (-0.5 - uEye.z) / dir.z;
        vec3 X = uEye + dir * t;
        vec2 fx = vec2(abs(dFdx(X.x)) + abs(dFdy(X.x)), abs(dFdx(X.y)) + abs(dFdy(X.y)));
        if (t > 0.0 && uFog > 0.0) {
          float w1 = uPitch / 60.0, w2 = 2.0 * uPitch / 60.0, c1 = 0.5 * w1;
          float cx = max(lines(X.x, fx.x, uPitch, w1, c1), lines(X.x, fx.x, 4.0 * uPitch, w2, 0.0));
          float cy = max(lines(X.y, fx.y, uPitch, w1, c1), lines(X.y, fx.y, 4.0 * uPitch, w2, 0.0));
          float g = 1.0 - (1.0 - cx) * (1.0 - cy);
          float dist = t * length(dir);
          float vis = clamp(uFog * 1.6 - 0.6 * clamp((dist - 0.8) / 1.6, 0.0, 1.0), 0.0, 1.0);
          vis = vis * vis * (3.0 - 2.0 * vis);
          col = mix(INK, GRAPHITE, g * vis);
        }
        vec4 acc = texelFetch(uAcc, ivec2(gl_FragCoord.xy), 0), cm = texelFetch(uAccC, ivec2(gl_FragCoord.xy), 0);
        if (uStatic > 0.5) {                              // the static cache: letters BONE·T, the dot VERM·T (±twinkle)
          float T = acc.r + 0.05 * (uTwSC.x * acc.g + uTwSC.y * acc.b);
          acc = vec4(BONE * T, T);
          cm = vec4(VERM * (cm.r + uTwSC.x * cm.g + uTwSC.y * cm.b), cm.a);
        } else {
          acc += texture(uAccH, vUv);
          // the dust ceiling (§1.4: accumulated dust ≤ 4): a soft knee, then a rational roll-off to the asymptote
          vec3 L = acc.rgb;
          float m = max(L.r, max(L.g, L.b));
          if (m > uKnee.x) {
            float mc = uKnee.x + (m - uKnee.x) / (1.0 + (m - uKnee.x) / (uKnee.y - uKnee.x));
            m = m * mix(1.0, mc / m, uKnee.z);
            L *= m / max(L.r, max(L.g, L.b));
          }
          if (m > 3.2) L *= (3.2 + 0.8 * (1.0 - exp(-(m - 3.2) / 0.8))) / m;
          acc.rgb = L;
        }
        col = col * (1.0 - clamp(acc.a, 0.0, 1.0)) + acc.rgb;   // grains occlude the backplane
        col = col * (1.0 - clamp(cm.a, 0.0, 1.0)) + cm.rgb;
        if (uStatic < 0.5) {                              // the comet's head, over everything
          vec4 hd = texelFetch(uAccD, ivec2(gl_FragCoord.xy), 0);
          if (uHeadK > 0.0) {
            vec2 q = (gl_FragCoord.xy - uHead.xy) / (uHead.z * uHeadSq);
            float d = length(q), cov = clamp((1.0 - d) * uHead.z * min(uHeadSq.x, uHeadSq.y) + 0.5, 0.0, 1.0);
            vec4 an = vec4(hd.rgb / max(hd.a, 0.35) * cov, cov);
            hd = mix(hd, an, uHeadK);
          }
          col = col * (1.0 - clamp(hd.a, 0.0, 1.0)) + hd.rgb;
        }
        o = vec4(col, 1.0);
      }`, 'field:grid');

    // flow's ink matte: (min, max) of prevTex.a over each 8×8 block + a 3px margin (so the meniscus only
    // searches for the matte edge where there is one)
    this.pEdge = ctx.program(`
      uniform sampler2D uPrev; uniform vec2 uSrc; out vec4 o;
      void main(){
        vec2 b = floor(gl_FragCoord.xy) * 8.0; float lo = 1.0, hi = 0.0;
        for (int y = 0; y < 5; y++) for (int x = 0; x < 5; x++) {
          float a = texture(uPrev, (b + vec2(-3.0 + 3.5 * float(x), -3.0 + 3.5 * float(y)) + 0.5) / uSrc).a;
          lo = min(lo, a); hi = max(hi, a);
        }
        o = vec4(lo, hi, 0.0, 1.0);
      }`, 'field:edge');

    // composite with flow (576–587): the §5.7 mask (flow's ink matte, the slash, the dust, the core's cell
    // dissolve), the slash, the 3px VERM meniscus on the matte edge
    this.pComp = ctx.program(`${HEAD}
      in vec2 vUv; out vec4 o; uniform vec2 uRes;
      uniform sampler2D uPrev, uWorld, uEdge;
      uniform float uF, uS, uSlo, uShi, uRim, uYcb, uHT, uTop; uniform vec3 uCoreBox;   // |x| < .x, .y < y < .z
      ${sys.glyphUniformDecl('uCore')}
      ${sys.glyphUniformDecl('uTg')}
      void main(){
        vec4 prev = texture(uPrev, vUv);
        if (uF < 576.5) { o = vec4(prev.rgb, 1.0); return; }   // IN: flow's frame
        vec2 p = P(vUv, uRes.x / uRes.y);
        float px = 1.0 / uRes.y;
        vec3 world = texture(uWorld, vUv).rgb;
        // (the slash, the dissolve and the core live only in the slash rows and the core's box)
        float bLo = uYcb - uHT, bHi = max(uYcb + uHT, uTop);
        bool nearBand = p.y > bLo - 2.0 * px && p.y < bHi + 2.0 * px;
        bool nearCore = abs(p.x) < uCoreBox.x && p.y > uCoreBox.y && p.y < uCoreBox.z;
        float slashA = 0.0, coreIn = 0.0, coreM = 0.0, alive = 1.0;
        if (nearBand || nearCore) {
          // halftone-cell dissolve: round 6px dots in screen space; each dies with the home-space cell under
          // its centre (the crossbar band is stretched by S about x = 0), shrinking over its last 1.5f
          vec2 cc = cellCentre(floor(cellUV(p)));
          vec2 qc = cc.y >= BAND.x && cc.y <= BAND.y ? vec2(cc.x / uS, cc.y) : cc;
          float rho = 0.70710678 * clamp((cellDeath(floor(cellUV(qc))) - uF) / 1.5, 0.0, 1.0);
          alive = halftone45Rho(p, CELL, rho, 1080.0 / uRes.y);
          // the slash: 0.25·cap thick on the crossbar's centre line, out to the frame edges (its top edge flush
          // with the top of flow's I, so the T has no notch on the cap line); ends box-blurred over the
          // half-frame shutter
          float bandCov = clamp((p.y - bLo) / px + 0.5, 0.0, 1.0) * clamp((bHi - p.y) / px + 0.5, 0.0, 1.0);
          float lo = min(uSlo, uShi), hi = max(uSlo, uShi);
          float endCov = clamp((hi - abs(p.x)) / max(hi - lo, px), 0.0, 1.0);
          slashA = bandCov * endCov * alive;
        }
        if (nearCore) {
          // flow's core (its station letter: cap 0.53, baseline −0.315) dilated by 0.02 turns into the stem's
          // grains through the same cell dissolve (no crossfade)
          coreIn = clamp(0.5 - (glyphDist(uCoreTex, uCoreMeta, uCorePlace, p) - 0.02) / px, 0.0, 1.0);
          coreM = coreIn * (1.0 - alive);
        }
        float dustA = smoothstep(0.05, 0.3, max(world.r, max(world.g, world.b)));
        float mPrev = smoothstep(0.45, 0.6, prev.a);
        // (the slash is painted over the union, so where it overlaps flow's I no INK seam shows through)
        float mask = max(mPrev, max(dustA, coreM));
        vec3 col = mix(prev.rgb, world, mask);
        col = mix(col, VERM, slashA);
        // 3px VERM meniscus at 1.6 on flow's matte edge (a = 0.525): the distance to the contour, searched
        // along 8 directions only in blocks the edge passes through
        vec2 eb = texelFetch(uEdge, ivec2(gl_FragCoord.xy) / 8, 0).rg;
        float rim = 0.0;
        if (uRim > 0.0 && eb.x < 0.525 && eb.y > 0.525 && coreIn < 1.0) {
          float s0 = prev.a - 0.525, dmin = 9.0;
          vec2 texel = 1.0 / uRes;
          for (int k = 0; k < 8; k++) {
            vec2 dv = vec2(cos(0.78539816 * float(k)), sin(0.78539816 * float(k)));
            float sPrev = s0;
            for (int r = 1; r <= 3; r++) {
              float s = texture(uPrev, vUv + dv * (float(r) * texel)).a - 0.525;
              if (sign(s) != sign(sPrev)) { dmin = min(dmin, float(r - 1) + sPrev / (sPrev - s)); break; }
              sPrev = s;
            }
          }
          rim = clamp(0.5 * uRim - dmin + 0.5, 0.0, 1.0) * clamp(uRim, 0.0, 1.0);
          rim *= (1.0 - slashA) * (1.0 - coreIn);
        }
        col = mix(col, VERM * 1.6, rim);
        o = vec4(col, 1.0);
      }`, 'field:comp');
  },

  reset(ctx) {
    ctx.draw(this.pReset, { uInit: this.texInit }, this.state, { swap: true });
  },

  step(ctx, s) {
    const F = s.frame;
    ctx.draw(this.pStep, {
      uP: this.state.read.texs[0], uV: this.state.read.texs[1], uA: this.texA, uB: this.texB, uCurl: this.curlTex,
      uF: F, uT: (F - F0) / 60, uS: this.S(F), uMorph: this.morph(F), uAspect: ctx.aspect,
      uRefEye: [...this.refCam[0].eye, ...this.refCam[1].eye], uRefFwd: [...this.refCam[0].fwd, ...this.refCam[1].fwd],
      uRefRight: [...this.refCam[0].right, ...this.refCam[1].right], uRefTan: this.refCam[0].tanH,
      uCurlG: F < SNAP ? 1 : 0,
      uSq: squash(F), uRightW: this.cam(F).right,
      uPath: this.pathU,
    }, this.state, { swap: true });
    if (F === SNAP && !this.assigned) this.assign(ctx);
  },

  // The coherent target assignment (once, at the snap). The nodes are read back; every letter grain's node
  // is projected with the camera of 648; the grains are split into glyph groups by projected x (the
  // rightmost grains → the rightmost glyph, in the glyphs' slot counts) and matched to their glyph's
  // stratified slots in Hilbert order (each normalised to its box), so a node's bundle lands in one small
  // region of one glyph. Each grain lands at its glyph's window start (on the 3f grid, right → left) + a
  // stratified rank over FILL frames. The mapping is a pure function of the deterministic simulation.
  assign(ctx) {
    const gl = ctx.gl, T = this.tgt;
    const st = new Float32Array(NG * 4);
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.state.read.fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, NX, NY, gl.RGBA, gl.FLOAT, st);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    // each grain's node (its grid index is kept in pos.w from the snap on)
    for (let l = 0; l < NLG; l++) {
      const o = (ND + l) * 4, n = Math.round(st[o + 3]);
      st[o] = ((n & 255) - 128) / 18; st[o + 1] = (((n >> 8) & 255) - 128) / 18; st[o + 2] = ((n >> 16) - 128) / 18;
    }
    const cam = this.cam(648);
    const sx = new Float64Array(NLG), sy = new Float64Array(NLG);
    for (let l = 0; l < NLG; l++) {
      const o = (ND + l) * 4;
      const dx = st[o] - cam.eye[0], dy = st[o + 1] - cam.eye[1], dz = st[o + 2] - cam.eye[2];
      const vz = Math.max(dx * cam.fwd[0] + dz * cam.fwd[2], 0.1), s = 0.5 / (vz * cam.tanH);
      sx[l] = (dx * cam.right[0] + dz * cam.right[2]) * s; sy[l] = dy * s;
    }
    const nG = T.nName, B18 = 262144;
    // glyph slot counts and slot lists (glyph index = left → right)
    const slotsOf = Array.from({ length: nG }, () => []);
    for (let l = 0; l < NLG; l++) slotsOf[T.gid[T.pix[T.slotPix[l]]]].push(l);
    // grains by projected x
    const kx = new Float64Array(NLG);
    for (let l = 0; l < NLG; l++) kx[l] = Math.round(clamp01((sx[l] + 4) / 8) * 1048575) * B18 + l;
    kx.sort();
    const dA = this.dA, dB = this.dB, W = T.W, H = T.H, aspect = T.aspect;
    let off = 0;
    for (let g = 0; g < nG; g++) {
      const slots = slotsOf[g], n = slots.length;
      const grains = new Int32Array(n);
      for (let m = 0; m < n; m++) grains[m] = kx[off + m] % B18;
      off += n;
      // normalise the group's projected positions (mean ± 2.2σ) and the glyph's slots (its pixel box)
      let mx = 0, my = 0, vx = 0, vy = 0;
      for (const l of grains) { mx += sx[l]; my += sy[l]; }
      mx /= n; my /= n;
      for (const l of grains) { vx += (sx[l] - mx) ** 2; vy += (sy[l] - my) ** 2; }
      const rx = 2.2 * Math.sqrt(vx / n) + 1e-6, ry = 2.2 * Math.sqrt(vy / n) + 1e-6;
      const q = v => Math.max(0, Math.min(1023, Math.floor(v * 1024)));
      const kg = new Float64Array(n);
      for (let m = 0; m < n; m++) { const l = grains[m]; kg[m] = hilbert(1024, q(0.5 + 0.5 * (sx[l] - mx) / rx), q(0.5 + 0.5 * (sy[l] - my) / ry)) * B18 + m; }
      kg.sort();
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const l of slots) { const pi = T.pix[T.slotPix[l]], px = pi % W, py = (pi / W) | 0; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
      const ks = new Float64Array(n);
      for (let m = 0; m < n; m++) {
        const pi = T.pix[T.slotPix[slots[m]]], px = pi % W, py = (pi / W) | 0;
        ks[m] = hilbert(1024, q((px - x0 + 0.5) / (x1 - x0 + 1)), q((py - y0 + 0.5) / (y1 - y0 + 1))) * B18 + m;
      }
      ks.sort();
      const rank = nG - 1 - g;                                  // the rightmost glyph lands first
      for (let m = 0; m < n; m++) {
        const l = grains[kg[m] % B18], sl = slots[ks[m] % B18];
        const j = T.slotPix[sl], pi = T.pix[j], px = pi % W, py = (pi / W) | 0;
        const k = ND + l, o = k * 4;
        dA[o + 2] = ((px + 0.5) / W - 0.5) * aspect; dA[o + 3] = (py + 0.5) / H - 0.5;
        dB[o] = T.cov[pi] / T.slotC[sl];
        // a right → left wipe across the glyph (toward S0), softened by a stratified per-pixel hash
        const r = 0.45 * (1 - (px - x0 + 0.5) / (x1 - x0 + 1)) + 0.55 * ((pcg(j * 2654435761 + 7) * U32 + T.slotM[sl] / T.slotC[sl]) % 1);
        dB[o + 3] = this.land0 + this.landStep * rank + FILL * r;
      }
    }
    const up = (tex, data) => {
      const u = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, data);
      gl.bindTexture(gl.TEXTURE_2D, u);
    };
    up(this.texA, dA); up(this.texB, dB);
    this.assigned = true;
  },

  render(ctx, s) {
    const gl = ctx.gl, E = ctx.ease.ease;
    const F = s.frame;
    const prevTex = s.fi < 12 ? s.prevTex : null;
    const cam = this.cam(F), camP = this.cam(F - 1);

    // from 670 the grains are static on screen: resolve the cached accumulation with this frame's twinkle
    if (F >= STATIC0) {
      if (!this.stReady) this.buildStatic(ctx, cam);
      const ph = 2 * Math.PI * F / 8;
      ctx.draw(this.pGrid, {
        uEye: cam.eye, uFwd: cam.fwd, uRight: cam.right, uTanH: cam.tanH, uPitch: this.gridPitch, uFog: 1, uKnee: [9, 10, 0],
        uStatic: 1, uTwSC: [Math.sin(ph), Math.cos(ph)], uAcc: this.stA.tex, uAccH: this.stA.tex, uAccC: this.stC.tex,
      }, s.target);
      this.composite(ctx, s, null, F);
      return;
    }
    // before 581 no grain is born (cells start dying over 581–584) and the fog is 0: the world is flat INK
    if (F < 581) {
      const ink = sys.PAL_LIN.INK;
      this.world.clear(ink[0], ink[1], ink[2], 1);
      this.composite(ctx, s, prevTex, F);
      return;
    }

    // the comet on screen (for the dust that crosses in front of it) and its hot core's lead
    const C = this.comet(F), cpx = projPx(cam, C, ctx.W, ctx.H);
    const C1 = this.comet(F - 1), c1px = projPx(cam, C1, ctx.W, ctx.H);
    let coreOff = [0, 0];
    { const dx = cpx.x - c1px.x, dy = cpx.y - c1px.y, l = Math.hypot(dx, dy); if (l > 1e-3) { const a = 0.12 * smooth(1, 12, l); coreOff = [a * dx / l, a * dy / l]; } }
    const cometOn = F >= 604 && F < 650 && cpx.z > 0.1;
    const rC = this.NL.S0.r * cpx.s * ctx.H;

    // 1) per-grain sprite parameters
    ctx.draw(this.pPrep, {
      uP: this.state.read.texs[0], uV: this.state.read.texs[1], uA: this.texA, uB: this.texB,
      uF: F, uScale: ctx.scale, uET: this.eT, uStatic: 0,
      uHeat: smooth(600, 606, F) * (1 - smooth(630, 636, F)),
      uTw: F < 600 ? 0.3 : 0.15,
      uPop: F === SNAP ? POP[0] : F === SNAP + 1 ? POP[1] : F === SNAP + 2 ? POP[2] : 1,
      uLat: smooth(GATHER0, SNAP, F), uGlint: 1 - smooth(596, 599, F) * (1 - smooth(604, 607, F)),
      uWhipK: 1 - 0.7 * smooth(602, 605, F) * (1 - smooth(610, 614, F)),   // a fast shutter through the whip
      uPF: smooth(636, 644, F), ...this.gather(F), uCool: smooth(654, LAND_DOT, F), uRDot: this.NL.S0.r,
      uFlyKeep: FLY_KEEP, uCoreOff: [0, 0],
      uComet: cometOn ? [cpx.x, cpx.y, rC, cpx.z] : [0, 0, 0, 0],
      uEye: cam.eye, uFwd: cam.fwd, uRight: cam.right, uEyeP: camP.eye, uFwdP: camP.fwd, uRightP: camP.right,
      uTan: [cam.tanH, camP.tanH], uZf: cam.zf, uScreen: [ctx.W, ctx.H],
      uPath: this.pathU,
    }, this.prep);

    // 2) grains → Σ light / Σ coverage: the dust (full res + half-res storm streaks) and the top layer
    const su = { uQ0: this.prep.texs[0], uQ1: this.prep.texs[1], uQ2: this.prep.texs[2], uRes: [ctx.W, ctx.H], uScale: ctx.scale };
    const [s0, sn] = this.sparkRange;
    const pts = (a, b) => { if (b > a) gl.drawArrays(gl.POINTS, a, b - a); };
    const quads = (a, b) => { if (b > a) gl.drawElements(gl.TRIANGLES, (b - a) * 6, gl.UNSIGNED_INT, a * 24); };
    const a0 = F >= 600 ? ND : 0;                           // from the peel the comet is in the top layer
    this.accum.clear(0, 0, 0, 0);
    ctx.setBlend('add');
    gl.bindVertexArray(this.vao);
    this.pPoints.use().set({ ...su, uDown: 1, uPass: 0, uLayer: 0 });
    pts(a0, NG);
    // long streaks exist while things move: the contracting crossbar (581–585) and 600 … the last landing
    const streaksIN = F >= 581 && F <= 585, streaks = F >= 600 && F <= LAND_LAST + FILL;
    const fullQ = F >= 636;                                  // converge streaks at full resolution (crisp)
    if (streaks && fullQ) {
      gl.bindVertexArray(this.quadVAO);
      this.pQuads.use().set({ ...su, uDown: 1, uPass: 1, uLayer: 0 });
      quads(ND, NG);
    }
    this.accumH.clear(0, 0, 0, 0);
    if (streaksIN || (streaks && !fullQ)) {
      ctx.setBlend('add');
      gl.bindVertexArray(this.quadVAO);
      this.pQuads.use().set({ ...su, uDown: this.accumH.w / ctx.W, uPass: 1, uLayer: 0 });
      if (streaksIN) quads(0, ND + this.nCross); else quads(a0, NG);
    }
    this.accumC.clear(0, 0, 0, 0);
    ctx.setBlend('add');
    gl.bindVertexArray(this.vao);
    this.pPoints.use().set({ ...su, uDown: 1, uPass: 2, uLayer: 1 });
    if (F < 604) pts(s0, s0 + sn);
    else pts(ND, NG);
    // the comet's shed sparks and drag glow (toned down while the lattice carries the frame; out by 666)
    const sparkK = (1 - 0.6 * smooth(621, 624, F) * (1 - smooth(634, 640, F))) * (1 - smooth(658, 665, F));
    if (F > 600 && F < LAND_DOT + 6) {
      gl.bindVertexArray(this.quadVAO);
      this.pSparks.use().set({
        uF: F, uScale: ctx.scale, uR: this.NL.S0.r, uZf: cam.zf, uPF: smooth(636, 644, F), uPath: this.pathU,
        uEye: cam.eye, uFwd: cam.fwd, uRight: cam.right, uEyeP: camP.eye, uFwdP: camP.fwd, uRightP: camP.right,
        uTan: [cam.tanH, camP.tanH], uScreen: [ctx.W, ctx.H], uK: sparkK,
      });
      gl.drawElements(gl.TRIANGLES, NSPK * 6, gl.UNSIGNED_INT, 0);
    }
    if (F > 600 && F < LAND_DOT + TAIL_LAG) {
      for (let k = 0; k < TAIL_N; k++) {
        const c = this.comet(F - (0.5 + (TAIL_LAG - 0.5) * k / (TAIL_N - 1)));
        this.tailU.set(c, k * 3);
      }
      const spd = Math.hypot(cpx.x - c1px.x, cpx.y - c1px.y) / (60 * ctx.scale);
      gl.bindVertexArray(this.vao);
      this.pTail.use().set({ uTail: this.tailU, uEye: cam.eye, uFwd: cam.fwd, uRight: cam.right, uTanH: cam.tanH, uR: this.NL.S0.r, uRes: [ctx.W, ctx.H], uVal: 0.8, uSpd: Math.min(1, spd) });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 2 * TAIL_N);
    }
    this.accumD.clear(0, 0, 0, 0);
    if (F >= 600) {
      gl.bindVertexArray(this.vao);
      this.pPoints.use().set({ ...su, uDown: 1, uPass: 2, uLayer: 1 });
      pts(0, ND);
    }
    gl.bindVertexArray(null);
    ctx.setBlend(null);
    // the head: from 602 its silhouette is an analytic antialiased ellipse (the squash), the grains give only
    // its interior (light per coverage); it hands back to the raw grains as the dot cools into the lock
    const sq = squash(F);
    const headK = F < 602 ? 0 : 1 - smooth(LAND_DOT + 1, LAND_DOT + 6, F);
    ctx.draw(this.pGrid, {
      uHead: [cpx.x, cpx.y, rC], uHeadSq: sq, uHeadK: cpx.z > 0.08 ? headK : 0, uAccD: this.accumD.tex,
      uEye: cam.eye, uFwd: cam.fwd, uRight: cam.right, uTanH: cam.tanH, uPitch: this.gridPitch, uFog: clamp01((F - 612) / 18),
      uKnee: this.knee(F), uStatic: 0, uTwSC: [0, 0],
      uAcc: this.accum.tex, uAccH: this.accumH.tex, uAccC: this.accumC.tex,
    }, prevTex ? this.world : s.target);

    // 3) the IN: composite over flow's frame; post
    this.composite(ctx, s, prevTex, F);
  },

  // the dust ceiling by phase: [knee, asymptote, mix]. The held T keeps its soft VERM body (knee 1.1);
  // the newborn glitter and the storm let dense cores run hot; nothing ever passes ≈3.9 (§1.4 dust ≤ 4)
  knee(F) {
    if (F < 600) return [1.1, 1.35, lerp(0.3, 0.6, smooth(584, 589, F))];
    const s1 = smooth(600, 606, F), s2 = smooth(622, 625, F), s3 = smooth(636, 642, F);
    const K = lerp(lerp(lerp(1.1, 1.8, s1), 2.4, s2), 2.2, s3), A = lerp(lerp(lerp(1.35, 3.3, s1), 3.8, s2), 3.6, s3);
    return [K, A, lerp(0.6, 1, s1)];
  },

  // the static cache (f ≥ 670): letters' (base, cos, sin) twinkle weights and the dot's, accumulated once.
  // Its content depends on nothing but the static per-grain data, so it is identical whichever frame builds it.
  buildStatic(ctx, cam) {
    const gl = ctx.gl;
    ctx.draw(this.pPrep, {
      uP: this.state.read.texs[0], uV: this.state.read.texs[1], uA: this.texA, uB: this.texB,
      uF: STATIC0, uScale: ctx.scale, uET: this.eT, uStatic: 1, uRDot: this.NL.S0.r, uScreen: [ctx.W, ctx.H],
      uEye: cam.eye, uFwd: cam.fwd, uRight: cam.right, uEyeP: cam.eye, uFwdP: cam.fwd, uRightP: cam.right, uTan: [cam.tanH, cam.tanH], uZf: cam.zf,
      uPath: this.pathU,
    }, this.prep);
    const su = { uQ0: this.prep.texs[0], uQ1: this.prep.texs[1], uQ2: this.prep.texs[2], uRes: [ctx.W, ctx.H], uScale: ctx.scale, uDown: 1, uPass: 2, uLayer: 0 };
    ctx.setBlend('add');
    gl.bindVertexArray(this.vao);
    this.stA.clear(0, 0, 0, 0);
    this.pPoints.use().set(su);
    gl.drawArrays(gl.POINTS, ND, NG - ND);
    this.stC.clear(0, 0, 0, 0);
    this.pPoints.use().set(su);
    gl.drawArrays(gl.POINTS, 0, ND);
    gl.bindVertexArray(null);
    ctx.setBlend(null);
    this.stReady = true;
  },

  composite(ctx, s, prevTex, F) {
    const E = ctx.ease.ease;
    if (prevTex) {
      ctx.draw(this.pEdge, { uPrev: prevTex, uSrc: [ctx.W, ctx.H] }, this.edgeB);
      ctx.draw(this.pComp, {
        uPrev: prevTex, uWorld: this.world.tex, uEdge: this.edgeB.tex, uF: F, uS: this.S(F),
        uSlo: this.G.xTip * this.S(F - 0.5), uShi: this.G.xTip * this.S(F), uYcb: this.G.yCb, uHT: this.slashHT(F), uTop: I_TOP,
        uRim: 3 * ctx.scale * E.outExpo((F - F0) / 3), uCoreBox: this.coreBox, ...this.coreU, ...this.tU,
      }, s.target);
    }
    // post: bloom 0.8, vignette 0.18 (eased from flow over 576–588); the CA spike at 600 decays to 0.0015
    // over 8f (§5.7), then out by 616, so no white-hot pop or landing type carries a fringe
    const ca = F < 600 ? 0 : F < 608 ? lerp(0.005, 0.0015, E.outCubic((F - 600) / 8)) : 0.0015 * (1 - smooth(608, 616, F));
    ctx.setPost(s, { bloom: 0.8, vignette: 0.18, ca });
  },
};
