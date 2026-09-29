// flow — FIG. 5 FLOW [480,576), station 4 (I), stateful. The drop. (DIRECTION.md §5.6)
//
// The letter's weight is a moving wall that shoves wet pigment, rendered as a screen print.
//
// Simulation (reset at f480, one step per frame, dt = 1/60), in PAPER space q (H units):
//   velocity 384×216 RG16F (H/s) · pressure 20 Jacobi iterations (warm-started) with
//   Neumann BCs on the obstacle · dye 512×288 RGBA16F (R = vermilion, G = ink, B = "airborne"
//   tracer: splash pigment in flight carries weight and falls back), MacCormack advection with
//   min/max clamping · dissipation R 0.999, G 1.0 · vorticity confinement ε = 8
//   (Δv = dt·ε·ω_cell·N) · moving wall: velocity inside the obstacle = (dw/dt)·sign(x)·x̂ ·
//   every step's splats in ONE pass per field (uniform vec4 uS[40], uC[40], + uE[40]: each splat is a
//   segment, so a moving emitter lays a continuous streak) · splat speed ≤ 1.5 H/s.
//   Ink carries weight (Boussinesq) so the pours drape over the shoulders. Inside the wall the dye
//   is extrapolated from its nearest face (ghost pigment), so a moving wall pushes pigment.
// Analytic elements (drawn in the final pass, entering the sim as splats where they land): the crown's
//   droplets and ligaments, the pour streams and their necking tails.
// Render: prep (dye res: pigment, the flood front's offset field) → wet-light heights blurred in two
//   widths (erosion mask, broad domes) + gradient → one full-res screen-print pass (bicubic dye, fwidth
//   thresholds, 12px 45° screen-space halftone band, the flood front as a per-pixel distance with an
//   asymmetric profile, the I flat VERM on its own separation (a Bone trap), its whole-dot key shadow,
//   wet glints printed as paper knock-outs inside the pigment).
//   The final pass is unblended and writes the ink matte a = smoothstep(.55,.95,G_eff) into alpha
//   (for `field`); there are no blended draws.
import * as sys from './_sys.js';

// ── constants ────────────────────────────────────────────────────────────────
const A = 16 / 9;                               // paper/sim aspect (the frame)
const VEL_W = 384, VEL_H = 216;                 // velocity grid (h = 1/216 H)
const DYE_W = 512, DYE_H = 288;                 // dye grid
const JACOBI = 20;
const MAX_SPLATS = 40;
const EPS_VORT = 8;
const DT = 1 / 60;
const CEN = [0, -0.05];                         // the I's centre and the push centre c
const HALF_H = 0.25;                            // the I's half-height
const TOP = CEN[1] + HALF_H;                    // the I's top face (y 0.20): the ball's contact point
const SPLAT_CAP = 1.5;                          // H/s
const GRAV = 1.8;                               // H/s² per unit ink load (Boussinesq)
const GRAV_AIR = 7.0;                           // H/s² per unit airborne tracer (thrown splash pigment)
const AIR_DECAY = 0.955;                        // per step: the splash lands and loses its extra weight
const VEL_DAMP = 0.985;                         // per step (heavy, viscous ink; loose enough to marble)
const IMP = 0.3;                                // impact impulse: 0.45 H/s peak (the crown carries the splash)
const CROWN_T = 9;                              // 489: the analytic crown hands over to the sim (one stamp)
const LIP_PX = 4;                               // §1.2 the cut: a VERM lip (≥ 3 px after AA) ahead of every ink front
const CROWN_G = 14.0;                           // H/s²: the crown's droplets fly ballistic arcs (short, snappy)

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// deterministic hash in [0,1) of integers (frame, index, salt)
function hash3(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ── GLSL ─────────────────────────────────────────────────────────────────────
// Obstacle: the I box (or, for another letter, its glyph SDF dilated by w − w850), in paper q.
const FLOOD_KY = 1.35;                          // the flood's vertical distance stretch (see dFlood)
const OBS_GLSL = /* glsl */`
uniform vec4 uObs;        // (w, dw/dt, halfH, cy)
#ifdef FLOW_GLYPH
uniform sampler2D uGTex; uniform vec4 uGMeta; uniform vec4 uGPlace; uniform float uW850;
float dObs(vec2 q){ return glyphDist(uGTex, uGMeta, uGPlace, q) - (uObs.x - uW850); }
vec2 nObs(vec2 q){ const float e = 0.004;
  vec2 g = vec2(dObs(q + vec2(e, 0)) - dObs(q - vec2(e, 0)), dObs(q + vec2(0, e)) - dObs(q - vec2(0, e)));
  return g / max(length(g), 1e-6); }
vec2 vWall(vec2 q){ return uObs.y * nObs(q); }
vec2 nFace(vec2 q){ return nObs(q); }
float dCheb(vec2 q){ return dObs(q); }
float dFlood(vec2 q){ return dObs(q); }
#else
float dObs(vec2 q){ vec2 d = abs(q - vec2(0.0, uObs.w)) - uObs.xz; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
vec2 vWall(vec2 q){ return vec2(uObs.y * (q.x < 0.0 ? -1.0 : 1.0), 0.0); }
// outward normal of the nearest face (inside the box: the closer of the side and end faces)
vec2 nFace(vec2 q){ vec2 l = q - vec2(0.0, uObs.w); vec2 d = abs(l) - uObs.xz;
  return d.x > d.y ? vec2(l.x < 0.0 ? -1.0 : 1.0, 0.0) : vec2(0.0, l.y < 0.0 ? -1.0 : 1.0); }
// Chebyshev (square) offset distance: the film and the trap keep the Archivo I's square corners
float dCheb(vec2 q){ vec2 d = abs(q - vec2(0.0, uObs.w)) - uObs.xz; return max(d.x, d.y); }
// the flood's metric: the box distance with its vertical part stretched, so the ink bursts SIDEWAYS
// out of the walls and the frame's top and bottom flood last (never a halo hugging the letter)
float dFlood(vec2 q){ vec2 d = abs(q - vec2(0.0, uObs.w)) - uObs.xz; d.y *= ${FLOOD_KY.toFixed(3)};
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
#endif
`;

const SIM_HEAD = /* glsl */`
in vec2 vUv; out vec4 o;
const float AS = ${A.toFixed(9)};
vec2 Q(vec2 uv){ return (uv - 0.5) * vec2(AS, 1.0); }
`;

// ── weight schedule (§5.6) ───────────────────────────────────────────────────
function makeSchedule(ctx) {
  const { spring, ease } = ctx.ease;
  const W300 = 0.25 * sys.STEM(300), W850 = 0.25 * sys.STEM(850), W900 = 0.25 * sys.STEM(900);
  const PEAK0 = 0.089, CAP = 0.095;
  // 504 / 528: the §5.6 spring(5, 0.4), time-scaled ×1.6 so the shove HITS (peak on the 4th frame, the
  // same 25 % overshoot, ≈ 0.0936 ≤ 0.095); released over 12f from the peak, back at 300 exactly by
  // +16.5f (≤ 18f), clamped to the axis range [300, cap] (§1.5: type axes clamp at their limits).
  const pump = tau => {
    const s = spring(tau * 1.6 / 60, 5, 0.4);
    const e = 1 - ease.inOutSine(clamp01((tau - 4.5) / 12));
    return Math.min(CAP, Math.max(W300, W300 + (W900 - W300) * s * e));
  };
  const w = f => {
    if (f < 0) return W850;
    if (f < 4) return W850 + (PEAK0 - W850) * Math.sin(Math.PI / 2 * f / 4);   // 480: 850 → peak 0.089 within 4f
    if (f < 20) return PEAK0 + (W300 - PEAK0) * ease.outCubic((f - 4) / 16);    // … relaxes to 300 by 500
    // The springs leave one frame before their kick, so the wall is visibly moving ON the beat
    // (a spring starting at rest on 504 would first show motion at 505: a frame behind the thump).
    if (f < 23) return W300;
    if (f < 47) return pump(f - 23);                                             // 504
    if (f < 71) return pump(f - 47);                                             // 528
    const tau = f - 71;                                                          // 552: spring to 900,
    const sp = W300 + (W900 - W300) * spring(tau / 60, 5, 0.4);                  // settle to 850 by 564, hold
    return mix(sp, W850, smooth(6.5, 13, tau));   // … 850 exactly by 564
  };
  const dwdt = f => (w(f + 0.01) - w(f - 0.01)) / 0.02 * 60;                     // H/s
  return { w, dwdt, W300, W850, W900 };
}

// S(f) = 1 + 0.10·exp(−(f−480)/5) + 0.06·inOutSine((f−480)/96)
function scaleAt(ctx, f) { return 1 + 0.10 * Math.exp(-Math.max(f, 0) / 5) + 0.06 * ctx.ease.ease.inOutSine(f / 96); }
// flood radius R(f) = mix(0.02, 1.15, inQuad((f−552)/36)) for f ≥ 552
// (k > 1 only for a fallback glyph whose far corners lie farther than an I's: the same timeline, stretched)
function floodR(f, k = 1) { const u = clamp01((f - 72) / 36); return f < 72 ? -1 : 0.02 + (1.15 - 0.02) * k * u * u; }
// the rupture snares (558, 564, 567, 570, 573) each jolt the front forward (monotone: ink never recedes)
const SNARES = [78, 84, 87, 90, 93];
// Lurch-and-hold: each snare bumps the front 0.03 forward in 2f; the front then holds until R(f)
// catches up (R_eff = running max of R + bump), so it is monotone, ≥ R, and keeps R's average pace.
const bump = f => SNARES.reduce((a, k) => a + 0.03 * (smooth(k - 1, k + 1.5, f) - smooth(k + 1.5, k + 7.5, f)), 0);
function floodReff(f, k = 1) {
  if (f < 72) return -1;
  let m = -1;
  for (let g = 72; g < f; g += 0.25) m = Math.max(m, floodR(g, k) + bump(g));
  return Math.max(m, floodR(f, k) + bump(f));
}
// Front shaping (all but `hold` only ever pull the front FORWARD, so the coverage bound is untouched):
//   fingers at the rupture nozzles' heights, a low-frequency one-sided tide, a pull toward existing
//   ink; `hold` keeps the uniform part of the front inside the film until ≈562 and releases it by 570,
//   so the rupture's first ten frames are the sim's jets (the box-shaped halo never shows as a keyline).
const lobeA = f => 0.10 * smooth(75, 79, f) - 0.06 * smooth(88, 100, f);   // recedes slower than R grows
const tideA = f => 0.06 * smooth(78, 94, f);           // subtracts 0 … 2·tideA
const holdB = f => 0.10 * (1 - smooth(72, 84, f));     // 0 from 564: long before the 584 guarantee
// the swell: the threshold on the sim ink's broad blur falls from 0.62 (≈ its own edge) to 0.06 (≈ +1.6σ)
const swellT = f => f < 71 ? -1 : mix(0.62, 0.06, smooth(71, 84, f));
const inkBias = f => 0.08 * smooth(74, 88, f);

const FLOOD_BAND = 0.05;      // outside the front: the halftone band (0.36 → 0.2 over 0.45·band) just beyond R
const FRONT_RAMP_PX = 3;      // inside the front: ½ → 1 within 3 design px (alpha lands on the printed edge)
const FILM_W = 0.007;         // VERM meniscus hugging the core (≤ 0.02)
const TRAP_PX = 2.5;          // the Bone trap that keeps the I on its own separation (480–555)
const KICK_GAIN = 2.5;        // kick splat speed = gain·dw/dt (H/s per H/s), capped at 1.5
const MAX_CAPS = 40;          // analytic capsules drawn in the final pass (crown droplets + ligaments, pour streams)
const POURS = [12, 36, 60];   // 492, 516, 540: the stream LANDS on the beat (it leaves the top edge 3f earlier)
const POUR_X = [0.004, 0.02, -0.026];   // each pour lands off-centre: the third breaks left
const SHADOW_RHO = Math.sqrt(sys.SHADOW_COVER / Math.PI);   // dot radius (cell units) of the 35% screen

// the crown's analytic floor: where a droplet's arc meets the blot (the pooled top face, then the
// shoulders' lobes falling away to either side); its landing splat carries airborne tracer, so it
// sinks on into the pigment rather than hanging where it met the floor
const POUR_TOP = 0.62;                          // the pour's column starts above the frame
// the stream's radius at height y: it necks as it falls (continuity: r ∝ v^-½, v ∝ √fall)
const pourR = y => 0.0058 + 0.0085 * Math.pow(clamp01((y - TOP) / (0.52 - TOP)), 0.7);
const crownFloor = x => Math.abs(x) < 0.10 ? TOP + 0.014 : TOP - 0.02 - 0.35 * (Math.abs(x) - 0.10);

export default {
  id: 'flow',
  stateful: true,
  postOut: { bloom: 0.6, vignette: 0.14 },
  mb() { return 0; },   // stateful: no supersampling (§2.2)

  init(ctx) {
    const gl = ctx.gl;
    sys.initSys(ctx);
    this.sch = makeSchedule(ctx);
    // station letter 4; 'I' is the analytic box, any other letter its glyph SDF (fallback §5.6)
    this.letter = sys.stationLetter(ctx, 4);
    this.glyphMode = this.letter !== 'I';
    this.halfW = f => this.sch.w(f);
    this.dObsCPU = (x, y, f) => {   // mirror of GLSL dObs (paper coords)
      const dx = Math.abs(x - CEN[0]) - this.sch.w(f), dy = Math.abs(y - CEN[1]) - HALF_H;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
    };
    this.dFloodCPU = (x, y, f) => {   // mirror of GLSL dFlood
      const dx = Math.abs(x - CEN[0]) - this.sch.w(f), dy = (Math.abs(y - CEN[1]) - HALF_H) * FLOOD_KY;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
    };
    const def = this.glyphMode ? '#define FLOW_GLYPH\n' : '';
    this.obsExtra = {};
    if (this.glyphMode) {
      const m = sys.glyphSDF(ctx, this.letter);
      const pl = sys.placeGlyph(m, 0.5, -0.30, 0);
      Object.assign(this.obsExtra, { uGTex: m.tex, uGMeta: sys.glyphMeta4(m), uGPlace: pl.place, uW850: this.sch.W850 });
      this.halfW = f => 0.5 * 0.5 * m.inkW + this.sch.w(f) - this.sch.W850;
      this.dObsCPU = (x, y, f) => pl.d(x, y) - (this.sch.w(f) - this.sch.W850);
      this.dFloodCPU = this.dObsCPU;
    }
    // rupture nozzles: 8 per wall at hashed heights, all below 0.8·halfH above the centre (nothing
    // leaves the top corners); the upper ones aim outward and down
    this.noz = [13, 11].map(salt => [...Array(8).keys()].map(j => {
      const y = CEN[1] - HALF_H + 0.03 + (1.8 * HALF_H - 0.03) * (j + 0.2 + 0.6 * hash3(j, salt, 1)) / 8;
      const u = (y - CEN[1]) / HALF_H;
      return { y, a: hash3(j, salt, 6) ** 2, ang: -0.32 * Math.max(0, u) + 0.24 * (hash3(j, salt, 4) - 0.5) };
    }));
    // pours: how strongly the stream breaks to each side (the third breaks left)
    this.pourK = [0, 1, 2].map(pi => [0, 1].map(side => pi === 2 ? [1.4, 0.35][side] : pi === 1 ? [0.6, 1.3][side] : 0.75 + 0.5 * hash3(pi, side, 53)));
    // The crown (§5.6), analytic until CROWN_T: ONE continuous sheet (a smooth union, k 0.02, of the pooled
    // pad, two walls with thick bases and thin, outward-curling lips, and the spill over each shoulder),
    // asymmetric (the strong side rises first, taller and leaning further out; the other 1.5f later,
    // steeper and shorter). Drops leave the rim and the pool on ligaments (joined to the sheet by a
    // small smooth union) that pinch off into separate drops flying ballistic arcs (g 9 H/s²); each
    // enters the sim where its arc meets the blot. At CROWN_T the sheet is stamped into the dye once
    // and the flow takes it over (a 1/216-H grid cannot pinch a sheet into drops).
    const strong = hash3(0, 0, 77) < 0.5 ? -1 : 1;             // the side the ball broke toward
    this.strong = strong;
    this.petals = [-1, 1].map(sx => {
      const big = sx === strong, h = n => hash3(sx + 2, 9, n);
      return { sx, big, t0: big ? 0 : 1.5, bx: sx * (big ? 0.036 : 0.028) + 0.006 * (h(1) - 0.5), by: TOP + 0.004,
        phi: big ? 0.98 + 0.06 * h(2) : 1.18 + 0.06 * h(2), L: big ? 0.17 : 0.125, r0: big ? 0.034 : 0.028, r1: 0.0075,
        bend: big ? 0.42 : 0.30, fall: big ? 0.036 : 0.030, spill: 1.0 + 0.35 * h(4) };
    });
    this.crown = [];
    for (const P of this.petals) {
      const sx = P.sx, s2 = sx + 2, nH = P.big ? 2 : 1;
      for (let k = 0; k < nH; k++) {                             // from the pool: steep, fast
        const h = n => hash3(s2, 20 + k, n), el = [1.36, 1.02][k] + 0.12 * (h(1) - 0.5), v = 1.3 + 0.2 * h(2);
        this.crown.push({ n0: P.t0, pool: true, ax: sx * (0.014 + 0.02 * k) + 0.006 * h(3), ay: TOP + 0.012, vx: sx * v * Math.cos(el), vy: v * Math.sin(el),
          r: (P.big ? 0.012 : 0.010) + 0.003 * h(4), pinch: 4 + 1.5 * h(5), P });
      }
      for (let k = 0; k < 3; k++) {                              // off the rim, fanning outward
        const h = n => hash3(s2, 30 + k, n), n0 = P.t0 + 2 + 0.8 * k + 0.5 * h(6);
        const rim = this.wallAt(P, n0).rim;
        const el = rim.a + 0.35 - 0.3 * k + 0.16 * (h(1) - 0.5), v = (0.85 + 0.4 * h(2)) * (P.big ? 1.1 : 0.95);
        this.crown.push({ n0, rimA: true, ax: rim.x, ay: rim.y, vx: sx * v * Math.cos(el), vy: v * Math.sin(el),
          r: 0.0065 + 0.0045 * h(4), pinch: 2.5 + 2 * h(5), P });
      }
      for (let k = 0; k < 2; k++) {                              // flung low over the shoulder
        const h = n => hash3(s2, 40 + k, n), el = [0.40, 0.08][k] + 0.14 * (h(1) - 0.5), v = 0.85 + 0.4 * h(2);
        this.crown.push({ n0: P.t0 + 1 + k, ax: sx * (0.085 + 0.012 * k), ay: TOP + 0.01, vx: sx * v * Math.cos(el), vy: v * Math.sin(el),
          r: 0.006 + 0.004 * h(4), pinch: 2 + 1.5 * h(5), P });
      }
    }
    for (const d of this.crown) {
      d.pinch = Math.min(d.pinch, CROWN_T - d.n0);               // every ligament has let go by the hand-over
      d.land = 60;
      for (let n = Math.ceil(d.n0) + 3; n < 60; n++) {
        const P = this.dropAt(d, n);
        if (P.vy < 0 && P.y <= crownFloor(P.x)) { d.land = n; break; }
      }
    }
    // the pours' tails: after the stream stops (τ 5) it necks into 3 drops that fall onto the I
    this.pourDrops = POURS.map((K, pi) => [0, 1, 2].map(k => {
      for (let t = 6; t < 20; t++) { const D = this.pourPiece(k, t); if (D.p > 0.5 && D.c - D.hl <= TOP + 0.012) return { land: t, G: 0.45 }; }
      return { land: 99, G: 0 };
    }));
    // the rupture's spears (on the snares 552, 558, 564, 570 and between): 3 per wall at staggered frames,
    // hashed heights (from the nozzles), headings and lengths
    this.spears = [[72, -1], [73, 1], [78, -1], [81, 1], [87, -1], [84, 1], [90, 1]].map(([f0, sx], i) => {
      const nz = this.noz[sx > 0 ? 1 : 0][Math.floor(8 * hash3(i, sx + 2, 91))];
      return { f0, sx, y: nz.y, ang: nz.ang + 0.2 * (hash3(i, 3, 93) - 0.5), L: 0.20 + 0.16 * hash3(i, 5, 95), r: 0.016 + 0.008 * hash3(i, 7, 97) };
    });
    // the front's fingers: 6 per wall at hashed heights, widths, amplitudes and onsets (two dropped)
    this.fingers = [0, 1].map(side => [...Array(6).keys()].map(j => {
      const h = n => hash3(j, side + 5, n);
      return { y: CEN[1] - HALF_H + 2 * HALF_H * (j + 0.15 + 0.7 * h(1)) / 6, w: 0.018 + 0.03 * h(2),
        a: h(3) < 0.3 ? 0 : 0.35 + 0.65 * h(4), on: 76 + 8 * h(5) };
    }));
    const nz = this.noz.flat();
    this.nozY = Float32Array.from(nz, n => n.y); this.nozA = Float32Array.from(nz, n => n.a);   // [left 0..7, right 0..7]

    const pre = `${ctx.glsl.common}${sys.SYS_GLSL}${def}${OBS_GLSL}`;

    const RG = { internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT };
    const R1 = { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT };
    this.vel = ctx.pingpong(VEL_W, VEL_H, RG);
    this.prs = ctx.pingpong(VEL_W, VEL_H, R1);
    this.div = ctx.fbo(VEL_W, VEL_H, RG);           // (divergence, obstacle-neighbour mask)
    this.curl = ctx.fbo(VEL_W, VEL_H, R1);
    this.dye = ctx.pingpong(DYE_W, DYE_H);          // RGBA16F
    this.dyeHat = ctx.fbo(DYE_W, DYE_H);
    this.prep = ctx.fbo(DYE_W, DYE_H);
    this.blurA = ctx.fbo(DYE_W, DYE_H);             // (ink σ≈9px, height σ≈26px, ink σ≈26px)
    this.blurB = ctx.fbo(DYE_W, DYE_H);
    this.grad = ctx.fbo(DYE_W, DYE_H);

    // splat record: uS = (x, y, r, kind), uC = (vx, vy, R, G), uE = (ex, ey, 0, 0): a segment from
    // (x, y) to (x + ex, y + ey) (a point when e = 0), so a moving emitter lays a continuous streak.
    //   kind −1: radial impulse (|v| = C.x) biased sideways and down (a point)
    //   kind 0…1: a plain splat that also lays `kind` of airborne tracer (B)
    //   kind 3: a painted shape: a tapered capsule (radius r → uE.z along the segment) max-blended into the
    //           dye with airborne tracer uE.w (no velocity): the crown's walls, fingers and lips
    //   kind 2: a cored jet: ink sheath (G, radius r) around a VERM core (R, radius 0.6r) that
    //           displaces the ink it is fired through, so a jet reads inside the black
    const SPLAT_DECL = `uniform vec4 uS[${MAX_SPLATS}]; uniform vec4 uC[${MAX_SPLATS}]; uniform vec4 uE[${MAX_SPLATS}]; uniform int uN;
      vec3 segRel(vec2 q, vec4 S, vec4 E){ vec2 pa = q - S.xy; float h = clamp(dot(pa, E.xy) / max(dot(E.xy, E.xy), 1e-12), 0.0, 1.0); return vec3(pa - E.xy * h, h); }`;

    // 1) velocity: pigment weight + all of this step's splats in one pass + moving wall
    this.pSplatVel = ctx.program(`${pre}${SIM_HEAD}${SPLAT_DECL}
      uniform sampler2D uVel, uDye; uniform float uCap, uGrav, uGravAir;
      void main(){
        vec2 q = Q(vUv);
        vec2 v = texelFetch(uVel, ivec2(gl_FragCoord.xy), 0).xy;
        // heavy ink sinks (it pours, drapes over the shoulders, runs down the walls); thrown splash
        // pigment (the airborne tracer) arcs and falls back into the blot
        vec3 dy = texture(uDye, vUv).rgb;
        v.y -= uGrav * min(dy.g, 1.2) + uGravAir * min(dy.b, 1.0);
        vec2 add = vec2(0.0);
        for (int i = 0; i < ${MAX_SPLATS}; i++){
          if (i >= uN) break;
          vec4 S = uS[i], C = uC[i];
          if (C.x == 0.0 && C.y == 0.0) continue;
          vec2 sv;
          float g;
          if (S.w < -0.5) {                                                   // impact: radial, biased
            vec2 rel = q - S.xy; g = exp(-dot(rel, rel) / (S.z * S.z));
            vec2 dir = vec2(rel.x + (rel.x < 0.0 ? -0.5 : 0.5) * S.z, min(rel.y, 0.0) - 0.35 * S.z);
            sv = C.x * normalize(dir);
          } else { vec2 rel = segRel(q, S, uE[i]).xy; g = exp(-dot(rel, rel) / (S.z * S.z)); sv = C.xy; }
          float sp = length(sv); if (sp > uCap) sv *= uCap / sp;
          add += sv * g;
        }
        v += add;
        if (dObs(q) < 0.0) v = vWall(q);
        o = vec4(v, 0.0, 1.0);
      }`, 'flow:splatVel');

    // 2) curl (per-cell velocity difference, H/s)
    this.pCurl = ctx.program(`${SIM_HEAD}
      uniform sampler2D uVel;
      vec2 V(ivec2 p){ return texelFetch(uVel, clamp(p, ivec2(0), ivec2(${VEL_W - 1}, ${VEL_H - 1})), 0).xy; }
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy);
        float L = V(p + ivec2(-1, 0)).y, R = V(p + ivec2(1, 0)).y, B = V(p + ivec2(0, -1)).x, T = V(p + ivec2(0, 1)).x;
        o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0); }`, 'flow:curl');

    // 3) vorticity confinement ε = 8: Δv = dt·ε·ω·N (N = ∇|ω| normalised)
    this.pVort = ctx.program(`${pre}${SIM_HEAD}
      uniform sampler2D uVel, uCurl; uniform float uEps, uDt;
      float W(ivec2 p){ return texelFetch(uCurl, clamp(p, ivec2(0), ivec2(${VEL_W - 1}, ${VEL_H - 1})), 0).r; }
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy); vec2 q = Q(vUv);
        float L = W(p + ivec2(-1, 0)), R = W(p + ivec2(1, 0)), B = W(p + ivec2(0, -1)), T = W(p + ivec2(0, 1)), C = W(p);
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 1e-4;
        force *= uEps * C; force.y = -force.y;
        vec2 v = texelFetch(uVel, p, 0).xy + force * uDt;
        if (dObs(q) < 0.0) v = vWall(q);
        o = vec4(v, 0.0, 1.0); }`, 'flow:vort');

    // 4) divergence (cell units) + obstacle-neighbour mask (L1 R2 B4 T8; 15 inside)
    this.pDiv = ctx.program(`${pre}${SIM_HEAD}
      uniform sampler2D uVel;
      const vec2 HC = vec2(${(A / VEL_W).toFixed(9)}, ${(1 / VEL_H).toFixed(9)});
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy); vec2 q = Q(vUv);
        if (dObs(q) < 0.0) { o = vec4(0.0, 15.0, 0.0, 1.0); return; }
        vec2 C = texelFetch(uVel, p, 0).xy;
        vec2 qL = q - vec2(HC.x, 0.0), qR = q + vec2(HC.x, 0.0), qB = q - vec2(0.0, HC.y), qT = q + vec2(0.0, HC.y);
        bool oL = dObs(qL) < 0.0, oR = dObs(qR) < 0.0, oB = dObs(qB) < 0.0, oT = dObs(qT) < 0.0;
        float uL = p.x == 0 ? -C.x : (oL ? vWall(qL).x : texelFetch(uVel, p + ivec2(-1, 0), 0).x);
        float uR = p.x == ${VEL_W - 1} ? -C.x : (oR ? vWall(qR).x : texelFetch(uVel, p + ivec2(1, 0), 0).x);
        float vB = p.y == 0 ? -C.y : (oB ? vWall(qB).y : texelFetch(uVel, p + ivec2(0, -1), 0).y);
        float vT = p.y == ${VEL_H - 1} ? -C.y : (oT ? vWall(qT).y : texelFetch(uVel, p + ivec2(0, 1), 0).y);
        float m = (oL ? 1.0 : 0.0) + (oR ? 2.0 : 0.0) + (oB ? 4.0 : 0.0) + (oT ? 8.0 : 0.0);
        o = vec4(0.5 * (uR - uL + vT - vB), m, 0.0, 1.0); }`, 'flow:div');

    // 5) Jacobi (Neumann on the obstacle and at the frame edges)
    this.pJacobi = ctx.program(`${SIM_HEAD}
      uniform sampler2D uP, uDiv; uniform float uWarm;
      float Pp(ivec2 p){ return texelFetch(uP, clamp(p, ivec2(0), ivec2(${VEL_W - 1}, ${VEL_H - 1})), 0).r; }
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy);
        vec2 dm = texelFetch(uDiv, p, 0).rg; int m = int(dm.y + 0.5);
        float pC = Pp(p) * uWarm;
        float pL = (m & 1) != 0 ? pC : Pp(p + ivec2(-1, 0)) * uWarm;
        float pR = (m & 2) != 0 ? pC : Pp(p + ivec2(1, 0)) * uWarm;
        float pB = (m & 4) != 0 ? pC : Pp(p + ivec2(0, -1)) * uWarm;
        float pT = (m & 8) != 0 ? pC : Pp(p + ivec2(0, 1)) * uWarm;
        o = vec4((pL + pR + pB + pT - dm.x) * 0.25, 0.0, 0.0, 1.0); }`, 'flow:jacobi');

    // 6) subtract the pressure gradient; wall velocity inside the obstacle
    this.pGrad = ctx.program(`${pre}${SIM_HEAD}
      uniform sampler2D uP, uDiv, uVel;
      float Pp(ivec2 p){ return texelFetch(uP, clamp(p, ivec2(0), ivec2(${VEL_W - 1}, ${VEL_H - 1})), 0).r; }
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy); vec2 q = Q(vUv);
        int m = int(texelFetch(uDiv, p, 0).g + 0.5);
        float pC = Pp(p);
        float pL = (m & 1) != 0 ? pC : Pp(p + ivec2(-1, 0));
        float pR = (m & 2) != 0 ? pC : Pp(p + ivec2(1, 0));
        float pB = (m & 4) != 0 ? pC : Pp(p + ivec2(0, -1));
        float pT = (m & 8) != 0 ? pC : Pp(p + ivec2(0, 1));
        vec2 v = texelFetch(uVel, p, 0).xy - 0.5 * vec2(pR - pL, pT - pB);
        if (dObs(q) < 0.0) v = vWall(q);
        o = vec4(v, 0.0, 1.0); }`, 'flow:grad');

    // 7) velocity self-advection (semi-Lagrangian) + viscosity-like damping
    this.pAdvVel = ctx.program(`${pre}${SIM_HEAD}
      uniform sampler2D uVel; uniform float uDt, uDiss;
      void main(){ vec2 q = Q(vUv);
        vec2 v = texelFetch(uVel, ivec2(gl_FragCoord.xy), 0).xy;
        vec2 n = texture(uVel, vUv - v * uDt / vec2(AS, 1.0)).xy * uDiss;
        if (dObs(q) < 0.0) n = vWall(q);
        o = vec4(n, 0.0, 1.0); }`, 'flow:advVel');

    // 8) dye forward advection φ̂ = A(φ)
    this.pAdvA = ctx.program(`${SIM_HEAD}
      uniform sampler2D uVel, uDye; uniform float uDt;
      void main(){ vec2 v = texture(uVel, vUv).xy;
        o = texture(uDye, vUv - v * uDt / vec2(AS, 1.0)); }`, 'flow:advA');

    // 9) MacCormack correction + clamp, dissipation, all dye splats in one pass
    this.pAdvB = ctx.program(`${pre}${SIM_HEAD}${SPLAT_DECL}
      uniform sampler2D uVel, uDye, uHat; uniform float uDt; uniform vec4 uDiss;
      vec4 D(ivec2 p){ return texelFetch(uDye, clamp(p, ivec2(0), ivec2(${DYE_W - 1}, ${DYE_H - 1})), 0); }
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy); vec2 q = Q(vUv);
        vec2 off = texture(uVel, vUv).xy * uDt / vec2(AS, 1.0);
        vec4 phi = texelFetch(uDye, p, 0), hat = texelFetch(uHat, p, 0);
        vec4 til = texture(uHat, vUv + off);
        vec4 r = hat + 0.5 * (phi - til);
        vec2 st = (vUv - off) * vec2(${DYE_W}.0, ${DYE_H}.0) - 0.5; ivec2 i0 = ivec2(floor(st));
        vec4 a = D(i0), b = D(i0 + ivec2(1, 0)), c = D(i0 + ivec2(0, 1)), d = D(i0 + ivec2(1, 1));
        r = clamp(r, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
        r *= uDiss;
        for (int i = 0; i < ${MAX_SPLATS}; i++){
          if (i >= uN) break;
          vec4 S = uS[i], C = uC[i];
          if (C.z == 0.0 && C.w == 0.0 && S.w <= 0.0) continue;
          vec4 E = uE[i]; vec3 rh = segRel(q, S, E); float d2 = dot(rh.xy, rh.xy);
          if (S.w > 2.5) {                           // painted shape: a tapered capsule, max-blended (a crisp silhouette)
            float rr = mix(S.z, E.z, rh.z), gp = exp(-d2 / (rr * rr));
            r.rgb = max(r.rgb, vec3(C.zw, E.w) * gp);
            continue;
          }
          float g = exp(-d2 / (S.z * S.z));
          if (S.w > 1.5) {                           // cored jet: VERM core displaces the ink it is fired through
            float gc = exp(-d2 / (0.36 * S.z * S.z));   // core radius 0.6·r
            r.r += C.z * gc; r.g += C.w * g - 2.2 * gc;
          } else r.rgb += vec3(C.zw, max(S.w, 0.0)) * g;
        }
        // ghost pigment: inside the wall the dye is extrapolated from just outside its nearest face, so
        // pigment rides an advancing wall (never eaten) and a retreating wall drags it back (never stale)
        float dq = dObs(q);
        if (dq < 0.0) {
          vec2 qo = q + nFace(q) * (-dq + 1.5 / ${DYE_H}.0);
          r = texture(uHat, qo / vec2(AS, 1.0) + 0.5);
        }
        // the top edge is open: ink there drains out of the frame
        if (p.y >= ${DYE_H - 3}) r.g = 0.0;
        o = vec4(clamp(r.rgb, 0.0, 1.5), 1.0); }`, 'flow:advB');

    // ── render: prep at dye res (paper space): (R, G_sim, 0, front offset) ──
    // The front offset n(q) is smooth, so it is sampled from dye res; the front itself (dObs + n − R)
    // is resolved per pixel in the final pass. It is evaluated only in a band around R.
    this.pPrep = ctx.program(`${pre}${ctx.glsl.noise}${SIM_HEAD}
      uniform sampler2D uDye; uniform float uF, uR, uBand, uLobe, uTide, uHold, uBias;
      uniform vec4 uFin[12];   // the front's fingers (y, half-width, amplitude, 0): left 0–5, right 6–11
      void main(){ vec2 q = Q(vUv);
        vec2 dy = texelFetch(uDye, ivec2(gl_FragCoord.xy), 0).rg;
        float off = 0.0;
        if (uR > -0.5) {
          float d = dFlood(q);
          float lo = uR - 0.04 - uHold - 0.03;
          float hi = uR + uBand + uLobe + 2.0 * uTide + uBias + 0.04 + 0.03;
          if (d > lo && d < hi) {
            off = 0.04 * fbm(6.0 * q + 0.02 * uF) + uHold;
            // the bottom corners (the HUD's boxes) take only the plain R(f) front: no fingers, no tide
            float hud = 1.0 - 0.85 * smoothstep(-0.30, -0.42, q.y) * smoothstep(0.45, 0.65, abs(q.x));
            if (uLobe > 0.0) {   // fingers leaving the walls (hashed heights, widths, amplitudes, onsets), wavering
              int k0 = q.x < 0.0 ? 0 : 6;
              float y = q.y + 0.025 * snoise(vec2(4.0 * q.x, 3.0 * q.y + 0.01 * uF));
              float lob = 0.0;
              for (int j = 0; j < 6; j++) { vec4 Fn = uFin[k0 + j]; float e = (y - Fn.x) / Fn.y;
                lob += Fn.z * exp(-e * e * abs(e)); }    // rounded fingertips (|e|³: no flat plateau, no straight step)
              off -= uLobe * min(lob, 1.0) * hud;
            }
            if (uTide > 0.0) {   // a low-frequency, one-sided tide: 0 … 2·uTide ahead of R
              float t = 0.5 * snoise(2.5 * q + vec2(0.013, -0.006) * uF) + 0.25 * snoise(5.0 * q + vec2(7.1, 3.3));
              off -= uTide * clamp(1.0 + t / 0.75, 0.0, 2.0) * hud;
            }
          }
        }
        o = vec4(dy.r, dy.g, 0.0, off); }`, 'flow:prep');

    // Wet light, blurred at dye res in two widths at once:
    //   .r: ink coverage, σ ≈ 9 px → its 0.9 contour runs ≈ 12 px inside every ink edge (the highlight's path)
    //   .g: height max(0.55·any, ink), σ ≈ 26 px → only large, calm ink bodies carry a highlight
    // (the procedural flood never enters: it prints matte)
    const TAPS = (src, ch, k) => `(${src}(vUv).${ch} * 0.2270270270
        + (${src}(vUv + t * ${(1.3846153846 * k).toFixed(6)}).${ch} + ${src}(vUv - t * ${(1.3846153846 * k).toFixed(6)}).${ch}) * 0.3162162162
        + (${src}(vUv + t * ${(3.2307692308 * k).toFixed(6)}).${ch} + ${src}(vUv - t * ${(3.2307692308 * k).toFixed(6)}).${ch}) * 0.0702702703)`;
    const BLUR = (dir, first) => `${SIM_HEAD}
      uniform sampler2D uSrc;
      ${first ? `vec3 H(vec2 uv){ vec2 d = texture(uSrc, uv).rg; float hi = smoothstep(0.35, 0.65, d.g);
        float ha = max(hi, smoothstep(0.30, 0.60, d.r)); return vec3(hi, max(0.55 * ha, hi), hi); }`
      : 'vec3 H(vec2 uv){ return texture(uSrc, uv).rgb; }'}
      void main(){ vec2 t = ${dir} / vec2(textureSize(uSrc, 0));
        o = vec4(${TAPS('H', 'x', 1)}, ${TAPS('H', 'y', 3)}, ${TAPS('H', 'z', 3)}, 1.0); }`;
    this.pBlurX0 = ctx.program(BLUR('vec2(1.0, 0.0)', true), 'flow:blurX0');
    this.pBlurX = ctx.program(BLUR('vec2(1.0, 0.0)', false), 'flow:blurX');
    this.pBlurY = ctx.program(BLUR('vec2(0.0, 1.0)', false), 'flow:blurY');
    this.pGradH = ctx.program(`${SIM_HEAD}
      uniform sampler2D uSrc;
      void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 mx = ivec2(${DYE_W - 1}, ${DYE_H - 1});
        vec2 c = texelFetch(uSrc, p, 0).rg;
        float l = texelFetch(uSrc, clamp(p - ivec2(1, 0), ivec2(0), mx), 0).r, r = texelFetch(uSrc, clamp(p + ivec2(1, 0), ivec2(0), mx), 0).r;
        float b = texelFetch(uSrc, clamp(p - ivec2(0, 1), ivec2(0), mx), 0).r, t = texelFetch(uSrc, clamp(p + ivec2(0, 1), ivec2(0), mx), 0).r;
        o = vec4(c.r, (r - l) * 0.5, (t - b) * 0.5, c.g); }   // (ink cover, its ∇ per dye texel, broad height)`, 'flow:gradH');

    // analytic capsules (see caps()): (dVerm, dInk, dSpear, dSpearCore) in paper units
    const CAPS_GLSL = `
      uniform vec4 uCapA[${MAX_CAPS}], uCapB[${MAX_CAPS}];   // (a, b), (ra, rb, group, yClip)
      uniform int uCapN;
      float csmin(float a, float b, float k){ float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
      vec4 capsD(vec2 q){
        float dV = 1e3, dK = 1e3, dSh = 1e3, dLg = 1e3, dSp = 1e3, dSc = 1e3;
        for (int i = 0; i < ${MAX_CAPS}; i++) {
          if (i >= uCapN) break;
          vec4 C = uCapA[i], B = uCapB[i];
          vec2 pa = q - C.xy, ba = C.zw - C.xy;
          float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
          float l = length(pa - ba * h), rr = mix(B.x, B.y, h), clip = B.w - q.y;
          float dd = max(l - rr, clip);
          int g = int(B.z + 0.5);
          if (g == 0) dV = min(dV, dd);
          else if (g == 1) dK = min(dK, dd);
          else if (g == 2) dSh = csmin(dSh, dd, 0.02);
          else if (g == 3) dLg = min(dLg, dd);
          else { dSp = min(dSp, dd); dSc = min(dSc, max(l - 0.42 * rr, clip)); }
        }
        return vec4(min(dV, csmin(dSh, dLg, 0.008)), dK, dSp, dSc);
      }`;
    // the crown's hand-over: its sheet stamped into the dye (VERM 1.3, airborne 0.35), soft over ~1 texel
    this.pStamp = ctx.program(`${pre}${SIM_HEAD}${CAPS_GLSL}
      uniform sampler2D uDye;
      void main(){ vec2 q = Q(vUv); vec4 r = texelFetch(uDye, ivec2(gl_FragCoord.xy), 0);
        float c = clamp(0.5 - (capsD(q).x - 0.003) / ${(1.2 / DYE_H).toFixed(6)}, 0.0, 1.0);
        o = vec4(max(r.r, 1.3 * c), r.g, max(r.b, 0.35 * c), 1.0); }`, 'flow:stamp');

    // ── final full-res screen-print pass (unblended; writes the ink matte into alpha) ──
    this.pFinal = ctx.program(`${pre}${CAPS_GLSL}
      in vec2 vUv; out vec4 o;
      uniform vec2 uRes;
      uniform sampler2D uPrep, uGrad, uBlur;
      uniform float uS, uFilm, uR, uBand, uRamp, uBias, uTrap, uGlint, uSwell, uLip, uSmooth;
      uniform vec2 uShOff; uniform float uShCell, uShRho;
      uniform vec4 uCapBox;
      const float AS = ${A.toFixed(9)};
      const vec2 CEN = vec2(${CEN[0].toFixed(3)}, ${CEN[1].toFixed(3)});
      // cubic B-spline via 4 bilinear taps (Sigg & Hadwiger)
      vec4 bicubic(sampler2D t, vec2 uv){
        vec2 ts = vec2(textureSize(t, 0));
        vec2 st = uv * ts - 0.5; vec2 i = floor(st), f = st - i;
        vec2 f2 = f * f, f3 = f2 * f;
        vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
        vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
        vec2 g0 = w0 + w1, g1 = w2 + w3;
        vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / ts, h1 = (i + 1.0 + w3 / g1 + 0.5) / ts;
        return g0.y * (g0.x * texture(t, vec2(h0.x, h0.y)) + g1.x * texture(t, vec2(h1.x, h0.y)))
             + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, vec2(h1.x, h1.y)));
      }
      float aa(float x){ return clamp(0.5 + x / max(fwidth(x), 1e-5), 0.0, 1.0); }
      // §1.4 hard key shadow of the I (SHADOW_PX offset, 45° ink screen, SHADOW_CELL_PX cells, SHADOW_COVER),
      // in SCREEN space. The offset strip is thinner than a cell, so the screen is phased to the I's
      // corner and gated to whole dots: one clean row of equal dots, never a dot sliced by the strip edge.
      float shadowDots(vec2 p, float pxs){
#ifdef FLOW_GLYPH
        vec2 qs = CEN + (p - uShOff * PX_H - CEN) / uS;
        float inSh = clamp(0.5 - dObs(qs) * uS / pxs, 0.0, 1.0);
        return inSh > 0.0 ? inSh * halftone45Rho(p, uShCell, uShRho, 1080.0 * pxs) : 0.0;
#else
        vec2 hS = uObs.xz * uS;                                        // the I's half extents on screen
        vec2 ab = abs(uShOff) * PX_H;
        vec2 cor = vec2(hS.x + 0.5 * ab.x, uObs.w - hS.y - 0.5 * ab.y);   // centre of the strip's corner
        vec2 u = p - cor;
        float pitch = uShCell * 1.41421356 * PX_H;                     // lattice step along an axis
        float r = uShRho * uShCell * PX_H;
        float sh = 0.0;
        float kR = (2.0 * hS.y - 0.5 * ab.y - r) / pitch, kF = (2.0 * hS.x - 0.5 * ab.x - r) / pitch;
        // the 45° lattice's two rows: the strip's own and its staggered neighbour half a pitch further
        // out along the offset, so the shadow prints as a zig-zag screen, not a perforated keyline
        for (int L = 0; L < 2; L++) {
          float of = 0.5 * float(L);
          vec2 uRt = u - vec2(of * pitch, 0.0);                            // right strip (stagger: further right)
          if (abs(uRt.x) < r + pxs && uRt.y > -r - pxs) {
            float k = clamp(floor(uRt.y / pitch - of + 0.5), 0.0, floor(kR - of));
            sh = max(sh, clamp(0.5 - (length(uRt - vec2(0.0, (k + of) * pitch)) - r) / pxs, 0.0, 1.0));
          }
          vec2 uFt = u + vec2(0.0, of * pitch);                            // foot strip (stagger: further down)
          if (abs(uFt.y) < r + pxs && uFt.x < r + pxs) {
            float k = clamp(floor(-uFt.x / pitch - of + 0.5), 0.0, floor(kF - of));
            sh = max(sh, clamp(0.5 - (length(uFt + vec2((k + of) * pitch, 0.0)) - r) / pxs, 0.0, 1.0));
          }
        }
        return sh;
#endif
      }
      void main(){
        vec2 p = P(vUv, uRes.x / uRes.y);
        vec2 q = CEN + (p - CEN) / uS;                        // paper coords (push and punch)
        vec2 uvq = q / vec2(AS, 1.0) + 0.5;
        float pxs = 1.0 / uRes.y;                             // one screen pixel (screen H)
        float pxq = pxs / uS;                                 // … in paper units
        float aaS = 1080.0 * pxs;                             // design px per screen px
        vec4 F = bicubic(uPrep, uvq);
        float Rv = F.r, Gs = F.g;
        // the printed ink is the dye's ink leaned toward its σ≈9px blur: bead chains and stamp scallops
        // fuse into one outline (a gap between two beads fills; a thin ligament, still > .5, survives)
        vec4 Hg = texture(uGrad, uvq);
        Gs = mix(Gs, Hg.x, uSmooth);
        float d = dObs(q), dC = dCheb(q);
        // late meniscus: a square VERM film of width uFilm hugging the core; the flood starts beyond it
        float inFilm = uFilm > 0.0 ? clamp(0.5 - (dC - uFilm) / pxq, 0.0, 1.0) : 0.0;
        float keep = 1.0 - inFilm;
        // the flood: signed distance to its front, resolved per pixel. Inside, ½ → 1 within uRamp (so the
        // matte's edge sits on the printed edge); outside, the halftone band starts where its dots just
        // separate (0.36) and thins to 0.2 over 0.45·band: one printed edge for the ink, the matte and the rim.
        // A VERM lip (§1.2 the cut, LIP_PX) runs just ahead of the front; the halftone band starts beyond it.
        float fl = 0.0, flSolid = 0.0, lip = 0.0;
        float lipQ = uLip * PX_H / uS;
        if (uR > -0.5) {
          float dF = dFlood(q) + F.a - uBias * clamp(Gs, 0.0, 1.0) - uR;
          flSolid = clamp(0.5 - dF / pxq, 0.0, 1.0);
          float dB = dF - lipQ;
          fl = dF < 0.0 ? 0.5 + 0.5 * smoothstep(0.0, uRamp, -dF) : (dB < 0.0 ? 0.0 : clamp(0.36 - 0.16 * dB / (0.45 * uBand), 0.0, 0.36));
          lip = clamp(0.5 - dB / pxq, 0.0, 1.0) * (1.0 - flSolid);
        }
        // the swell (rupture): every sim ink body grows and merges, as a falling threshold on its broad
        // blur (σ ≈ 26 px), with the same VERM lip ahead of it: the black bursts out of the blot itself
        float swSolid = 0.0;
        if (uSwell > 0.0) {
          float bI = bicubic(uBlur, uvq).b;
          float sd = (uSwell - bI) / max(fwidth(bI), 1e-5);   // screen px outside the swollen edge
          swSolid = clamp(0.5 - sd, 0.0, 1.0);
          lip = max(lip, clamp(0.5 - (sd - uLip / aaS), 0.0, 1.0) * (1.0 - swSolid));
        }
        lip *= 1.0 - swSolid;
        float Gv = max(max(Gs, fl), swSolid);
        float Gin = Gv * keep;
        float Rin = max(Rv, inFilm);
        // along the film, the ink's AA edge sits on the film's VERM (one straight edge, no jogs)
        if (uFilm > 0.0 && Gv >= 0.5 && dC < uFilm + 2.0 * pxq) Rin = 1.0;
        // posterise: INK where G > .5; else VERM where R > .45; else BONE paper with fibre
        // (fwidth thresholds in uniform control flow; everything below branches on coherent regions)
        float inkSolid = max(aa(Gs * keep - 0.5), max(flSolid, swSolid) * keep);
        float vermSolid = aa(Rin - 0.45);
        float matte = smoothstep(0.55, 0.95, Gin);
        // which pigment's band prints as the screen: a crisp (1 px) decision, never a blend of the two
        float domInkAA = aa(Gin - Rin);
        // wet light: the ink's blurred cover and the screen rate at which it changes (uniform control flow)
        float fwB = max(fwidth(Hg.x), 1e-5);
        float inI = clamp(0.5 - d / pxq, 0.0, 1.0);
        vec3 col = INK;
        float capK = 0.0;
        if (inI < 1.0) {
          float domInk = domInkAA;
          float htInk = 0.0, htVerm = 0.0;
          // the 0.2–0.5 band as a 45° screen of 12 px cells ON SCREEN, dot radius ∝ √((v − 0.2)/0.3),
          // solid (√½) at the top of the band
          if (Gin > 0.2 && inkSolid < 1.0) htInk = halftone45Rho(p, 12.0, 0.70710678 * sqrt(min((Gin - 0.2) / 0.3, 1.0)), aaS);
          if (Rin > 0.2 && vermSolid < 1.0) htVerm = halftone45Rho(p, 12.0, 0.70710678 * sqrt(min((Rin - 0.2) / 0.25, 1.0)), aaS);
          float vermCov = max(max(vermSolid, htVerm * (1.0 - domInk)), lip * keep);
          float inkCov = max(inkSolid, htInk * domInk * (1.0 - lip));
          vec3 paper = BONE * (1.0 + paperFibre(q));
          col = mix(mix(paper, VERM, vermCov), INK, inkCov);
          // wet light on the SIM ink (the procedural flood prints matte), drawn the way a screen print draws
          // gloss: a paper knock-out stroke that runs ≈ 12 px inside the ink's edge where that edge faces the
          // key light (upper left), thickest where it faces it squarely and tapering to points either side.
          // Only large ink bodies carry one (the broad height), never within 14 px of the I, so it never
          // touches paper or the letter; it dries by thinning and shortening to nothing (never a fade).
          if (uGlint > 0.0) {
            float solid = inkSolid * (1.0 - flSolid);
            if (solid > 0.0 && Hg.w > 0.6) {
              vec2 nOut = -Hg.yz / max(length(Hg.yz), 1e-6);
              float lit = dot(nOut, KEY2);
              float wHalf = 2.6 * uGlint * smoothstep(0.45 + 0.4 * (1.0 - uGlint), 0.93, lit) * smoothstep(0.6, 0.8, Hg.w);
              float dpx = abs(Hg.x - 0.9) / fwB;
              float st = clamp(wHalf - dpx + 0.5, 0.0, 1.0) * clamp((d * uS / PX_H - 14.0) / 4.0, 0.0, 1.0) * step(0.3, wHalf);
              col = mix(col, paper, st * solid);
            }
          }
          // the analytic ink and pigment: the crown's droplets and ligaments (VERM), the pour streams (INK)
          if (uCapN > 0 && q.x > uCapBox.x && q.y > uCapBox.y && q.x < uCapBox.z && q.y < uCapBox.w) {
            vec4 cd = capsD(q);
            capK = clamp(0.5 - min(cd.y, cd.z) / pxq, 0.0, 1.0);
            col = mix(col, VERM, clamp(0.5 - cd.x / pxq, 0.0, 1.0));
            col = mix(col, INK, capK);
            col = mix(col, VERM, clamp(0.5 - cd.w / pxq, 0.0, 1.0));
          }
          // the trap: a Bone knock-out between the I (and its film) and any pigment, so the letter
          // prints on its own separation and never melts into same-colour pigment
          if (uTrap > 0.0 && dC < uFilm + uTrap + pxq) col = mix(col, paper, clamp(0.5 - (dC - uFilm - uTrap) / pxq, 0.0, 1.0));
          // the I's hard key-light shadow (whole dots) over paper and VERM; where ink meets the letter the
          // trap already separates it (dots there would print as a zipper), and the film covers it late
          float sh = shadowDots(p, pxs);
          if (sh > 0.0) col = mix(col, INK, sh * keep * (1.0 - inkCov));
        }
        // the I: solid, flat VERM (its wet read is the pigment's light around it)
        col = mix(col, VERM, inI);
        // alpha: the ink matte (0 on the core and its film)
        float a = max(matte, capK) * (1.0 - inI);
        o = vec4(col, a);
      }`, 'flow:final');

    // coverage assertion (§5.6): at f587 flood = 1 everywhere outside the core + 0.02 (+ its film)
    this.assertFlood(ctx);

    // compile every program now (SwiftShader JITs on first draw), so a replay never pays for it
    this.warm = ctx.fbo(64, 36);
    this.reset(ctx);
    this.step(ctx, { fi: 0 });
    this.draw(ctx, 2, this.warm);
    this.draw(ctx, 100, this.warm);
    ctx.draw(this.pStamp, { uDye: this.dye.read.tex, uCapA: new Float32Array(MAX_CAPS * 4), uCapB: new Float32Array(MAX_CAPS * 4), uCapN: 0,
      uObs: [0.07, 0, HALF_H, CEN[1]], ...this.obsExtra }, this.warm);
    this.reset(ctx);
  },

  // Coverage assertion (§5.6): flood ≥ .95 everywhere outside the core by f584 and = 1 at f587.
  // dObs is 1-Lipschitz, so its max over the frame is bounded by a 1/64-H grid max + half a diagonal.
  // Only the fbm term can hold the front back after f570 (fingers, tide and ink bias pull it forward).
  assertFlood(ctx) {
    const FBM_MAX = 0.97;   // 5-octave simplex fbm, weights 0.5…0.03125
    const RAMP = FRONT_RAMP_PX / 1080;   // the inner ramp in paper units (S ≥ 1)
    const G = 1 / 64, slack = G * Math.SQRT1_2;
    const box = (x, y, f) => { const dx = Math.abs(x - CEN[0]) - this.sch.w(f), dy = (Math.abs(y - CEN[1]) - HALF_H) * FLOOD_KY;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0); };
    const dMaxOf = (fn, f) => {
      const S = scaleAt(ctx, f);
      let dMax = 0;
      for (let py = -0.5; py <= 0.5 + 1e-9; py += G) for (let px = -A / 2; px <= A / 2 + 1e-9; px += G) {
        dMax = Math.max(dMax, fn(CEN[0] + (px - CEN[0]) / S, CEN[1] + (py - CEN[1]) / S, f));
      }
      return dMax + slack;
    };
    // fallback letters: stretch R(f) so the farthest point floods when it would for the I
    this.kFlood = this.glyphMode ? Math.max(1, (dMaxOf(this.dFloodCPU, 104) + 0.1) / (dMaxOf(box, 104) + 0.1)) : 1;
    const check = (f, gMin) => {
      // fl = ½ + ½·smoothstep(0, ramp, −dF) ≥ gMin ⇔ −dF ≥ t·ramp with smoothstep(t) = 2·gMin − 1
      const t = gMin >= 1 ? 1 : 0.8045;
      if (holdB(f) > 0) return false;
      const need = dMaxOf(this.dFloodCPU, f) + 0.04 * FBM_MAX + t * RAMP;
      const ok = floodR(f, this.kFlood) >= need;
      if (!ok) console.error(`flow: flood coverage assertion FAILED at f${480 + f}: R ${floodR(f, this.kFlood).toFixed(3)} < ${need.toFixed(3)}`);
      return ok;
    };
    this.floodOK = check(104, 0.95) && check(107, 1.0);
  },

  reset(ctx) {
    this.vel.clear(0, 0, 0, 1); this.prs.clear(0, 0, 0, 1); this.dye.clear(0, 0, 0, 1);
  },

  // a crown droplet at in-shot time n (frames): head position and velocity (ballistic from its anchor)
  dropAt(d, n) {
    const t = Math.max(n - (d.n0 || 0), 0) * DT;
    return { x: d.ax + d.vx * t, y: d.ay + d.vy * t - 0.5 * CROWN_G * t * t, vx: d.vx, vy: d.vy - CROWN_G * t };
  },

  // a crown wall at in-shot time n: three tapered segments (thick base → thin lip curling outward →
  // a bulbed rim), growing outExpo-like, then falling outward as it collapses. Returns its capsules
  // (group 2: the smooth-union sheet) and its rim (x, y, the lip's heading a from horizontal-outward).
  wallAt(P, n) {
    const t = n - P.t0;
    if (t <= 0) return { caps: [], rim: { x: P.bx, y: P.by, a: P.phi } };
    const e = 1 - Math.exp(-t / 1.8), L = P.L * e;
    const phi = P.phi - P.fall * Math.max(0, t - 3.5) ** 2;
    const r0 = P.r0 * (1 - 0.3 * e) * Math.min(1, 0.5 + t / 2), r1 = P.r1, rm = mix(r0, r1, 0.45);
    const a0 = phi + 0.25 * P.bend, a1 = phi - 0.5 * P.bend, a2 = phi - 1.5 * P.bend;
    const p0 = [P.bx, P.by];
    const p1 = [p0[0] + P.sx * 0.45 * L * Math.cos(a0), p0[1] + 0.45 * L * Math.sin(a0)];
    const p2 = [p1[0] + P.sx * 0.40 * L * Math.cos(a1), p1[1] + 0.40 * L * Math.sin(a1)];
    const p3 = [p2[0] + P.sx * 0.15 * L * Math.cos(a2), p2[1] + 0.15 * L * Math.sin(a2)];
    return {
      caps: [[...p0, ...p1, r0, rm, 2, -1], [...p1, ...p2, rm, r1, 2, -1], [...p2, ...p3, r1, 1.45 * r1, 2, -1]],
      rim: { x: p3[0], y: p3[1], a: a2 },
    };
  },

  // the crown sheet at in-shot time n (before the hand-over): pad + walls + the spill over each shoulder
  crownSheet(n, handOver = false) {
    if ((n >= CROWN_T && !handOver) || n < 0) return [];
    const C = [], wI = this.sch.w(n), st = this.strong;
    const g = Math.min(1, 0.45 + n / 2.5);
    C.push([-0.045 * g + 0.006 * st, TOP + 0.007, 0.045 * g + 0.006 * st, TOP + 0.007, 0.013 * g, 0.013 * g, 2, -1]);   // the pooled pad
    for (const P of this.petals) {
      C.push(...this.wallAt(P, n).caps);
      const t = n - P.t0 + 1;
      if (t <= 0) continue;
      const sx = P.sx, xs = sx * (wI + 0.003), k = Math.min(1, t / 2);
      C.push([P.bx, P.by + 0.002, mix(P.bx, xs, k), TOP + 0.004, 0.013, 0.011, 2, -1]);                 // over the top face
      const drop = (0.004 + P.spill * 1.05 * Math.max(0, t - 1) * DT) * k;                                  // down the wall face
      C.push([xs, TOP + 0.002, sx * (wI + 0.009), TOP - drop, 0.011, 0.0085, 2, -1]);
    }
    return C;
  },

  // a pour's column piece j (0 lowest … 2 top) at τ > 5 frames after the stream landed: the fed column
  // stops, falls as one, and necks into three elongated drops from the top down. Centre, half-length, radius.
  pourPiece(j, tau) {
    const t = Math.max(0, tau - 5), YT = TOP + 0.01, len0 = POUR_TOP - YT;
    const p = smooth(0.5 + 1.1 * (2 - j), 2.5 + 1.1 * (2 - j), t);
    const fall = 0.045 * t + 0.0012 * t * t;
    const c = YT + (j + 0.5) / 3 * len0 - fall;
    return { c, hl: len0 / 6 * (1 - 0.5 * p), r: pourR(c) * (1 + 0.35 * p), p };
  },

  // every analytic capsule of in-shot frame f: [ax, ay, bx, by, ra, rb, group, yClip]
  //   group 0: VERM drop (hard edge) · 1: INK · 2: VERM sheet (smooth union k 0.02) · 3: VERM ligament
  //   (smooth union k 0.008 with the sheet) · 4: rupture spear (INK with a VERM core)
  caps(f) {
    const C = [];
    C.push(...this.crownSheet(f));
    // the crown's drops: a ligament (tapered from the rim or the pool to the drop) until it pinches,
    // then the drop alone, stretched a little along its velocity, to its landing frame
    if (f >= 0 && f < 40) for (const d of this.crown) {
      if (f >= d.land || f <= d.n0) continue;
      const H = this.dropAt(d, f);
      if (f - d.n0 < d.pinch) {
        const A = d.rimA ? this.wallAt(d.P, f).rim : { x: d.ax, y: d.ay };
        C.push([A.x, A.y, H.x, H.y, d.rimA ? 0.0035 : 0.006, d.r, 3, -1]);
      } else {
        const st = 0.6 * DT;
        C.push([H.x, H.y, H.x - H.vx * st, H.y - H.vy * st, d.r, 0.6 * d.r, 0, -1]);
      }
    }
    // the pours: a stream that necks as it falls (r ∝ 1/√fall), wavering 1–2 px, cut in from above the
    // frame to land ON the beat; a flat splash spreading sideways on the I's top; then the fed column
    // stops, falls and necks into three drops from the top down
    POURS.forEach((K, pi) => {
      const tau = f - K, x0 = POUR_X[pi], YT = TOP + 0.01;
      if (tau < -3 || tau > 16) return;
      const wob = y => x0 + 0.0013 * smooth(YT, YT + 0.12, y) * (Math.sin(24 * y - 1.4 * tau + 2.1 * pi) + 0.5 * Math.sin(57 * y + 2.3 * tau + pi));
      const column = (yA, yB, rHead) => {       // yA above yB
        const N = 6;
        for (let i = 0; i < N; i++) {
          const ya = mix(yA, yB, i / N), yb = mix(yA, yB, (i + 1) / N);
          C.push([wob(ya), ya, wob(yb), yb, pourR(ya), i === N - 1 ? Math.max(pourR(yb), rHead) : pourR(yb), 1, YT]);
        }
      };
      if (tau < 0) {
        const u = (tau + 3) / 3, yH = POUR_TOP - (POUR_TOP - YT) * u ** 1.3;
        column(POUR_TOP + 0.06, yH, 1.35 * pourR(yH));
      } else if (tau <= 5) column(POUR_TOP + 0.06, YT - 0.012, 0);
      else for (let j = 0; j < 3; j++) {
        const D = this.pourPiece(j, tau);
        if (D.c + D.hl + D.r < YT) continue;
        C.push([wob(D.c + D.hl), D.c + D.hl, wob(D.c - D.hl), D.c - D.hl, D.r * (1 - 0.25 * D.p), D.r, 1, YT]);
      }
      if (tau >= 0 && tau < 9) for (const sx of [-1, 1]) {       // the landing splash: flat, spreading sideways
        const kc = this.pourK[pi][sx > 0 ? 1 : 0], u = tau + 1;
        const sp = 0.05 * kc * (1 - Math.exp(-u / 1.6)), lift = 0.014 * kc * Math.sin(Math.PI * Math.min(1, u / 5));
        const droop = 0.035 * smooth(2, 7, tau), k = 1 - smooth(3, 8, tau);
        const kl = 0.35 + 0.65 * k;   // it retracts into the pool as it thins (never a stick)
        C.push([x0, YT - 0.002, x0 + sx * sp * kl, YT + 0.002 + (lift - droop) * kl, 0.011 * k, 0.006 * k, 1, -1]);
      }
    });
    // the rupture's spears: long tapered jets fired out of the walls at staggered frames (on the snares)
    for (const sp of this.spears) {
      const t = f - sp.f0;
      if (t <= 0 || t > 7) continue;
      const xw = sp.sx * (this.sch.w(f) + 0.004);
      const sT = sp.L * (1 - Math.exp(-t / 2.6)), sB = 0.5 * sp.L * smooth(3, 7, t);
      const cx = sp.sx * Math.cos(sp.ang), cy = Math.sin(sp.ang);
      C.push([xw + cx * sB, sp.y + cy * sB, xw + cx * sT, sp.y + cy * sT, sp.r * (1 - 0.55 * smooth(3, 7, t)), 0.0022, 4, -1]);
    }
    if (C.length > MAX_CAPS) console.warn(`flow: ${C.length} capsules at f${480 + f} (max ${MAX_CAPS})`);
    return C.slice(0, MAX_CAPS);
  },

  // Every splat of in-shot frame f: {x, y, r, kind, vx, vy, R, G, ex, ey} (paper coords, H/s, amounts)
  splats(f) {
    const L = [], { w, dwdt } = this.sch;
    const wf = this.halfW(f);   // the wall face (the I's half-width, or the dilated glyph's ink half-width)
    const push = (x, y, r, kind, vx, vy, R, G, ex = 0, ey = 0, r1 = 0, air = 0) => L.push({ x, y, r, kind, vx, vy, R, G, ex, ey, r1, air });

    // ── 480, the impact at (0, 0.20): the splash is the analytic crown (caps) until CROWN_T ──
    // Here only the flow under it: a radial impulse (0.45 H/s peak, decaying over 4f; below §5.6's 1.5 H/s)
    // and no dye: §5.6's VERM pad (r 0.09) is the crown's pooled pad, which enters the dye at CROWN_T.
    if (f <= 5) {
      const dec = [1, 0.62, 0.36, 0.16, 0, 0][f];
      if (dec > 0) push(0, TOP, 0.07, -1, IMP * 1.5 * dec, 0, 0, 0);         // radial impulse
    }
    // the hand-over (CROWN_T): the sheet is stamped into the dye (see step) and keeps moving: its walls
    // fall outward and down, the spill runs on down the wall faces
    if (f === CROWN_T) for (const P of this.petals) {
      const W = this.wallAt(P, f), sx = P.sx;
      for (const c of W.caps) push(c[0], c[1], 0.028, 0, sx * 0.7, -0.45, 0, 0, c[2] - c[0], c[3] - c[1]);
      push(sx * (wf + 0.012), TOP, 0.022, 0, sx * 0.1, -1.1, 0, 0, 0, -0.05);
    }
    // the crown lands: each droplet enters the sim where its arc meets the blot, still falling
    for (const d of this.crown) if (f === d.land) {
      const P = this.dropAt(d, f);
      push(P.x, P.y, 0.006 + 0.6 * d.r, 0.5, 0.3 * P.vx, 0.3 * P.vy, 0.9, 0);
    }

    // ── kicks 480, 504, 528, 552: 4 splats per wall, squeezed OUT OF the wall face ──
    // Hashed heights (irregular, different every kick), radii 0.035–0.065 (mean 0.05), angles and
    // speeds (±30 %); mirrored across the fold (the blot stays a Rorschach) with a little asymmetry.
    // At 480 the shove travels DOWN the wall from the impact (1–3f late at the foot, less VERM there)
    // and the sides differ by ±20 %; at 552 the upper splats aim down (no curls off the top corners).
    [0, 23, 47, 71].forEach((k, kk) => {   // wall-motion starts (480 impact; springs lead 504/528/552 by 1f)
      // VERM 0.5 on the frame the wall travels fastest, in proportion to each frame's travel
      const dwMax = Math.max(1e-6, ...[1, 2, 3, 4, 5, 6, 7, 8].map(t => w(k + t) - w(k + t - 1)));
      for (let j = 0; j < 4; j++) {
        const yb = CEN[1] - HALF_H + 2 * HALF_H * (j + 0.5 + 0.8 * (hash3(kk, j, 31) - 0.5)) / 4;
        const r0 = 0.035 + 0.03 * hash3(kk, j, 33);
        const u = (yb - CEN[1]) / HALF_H;
        const ang = kk === 3 ? 0.4 * (hash3(kk, j, 35) - 0.5) - 0.3 * Math.max(0, u)
                             : 0.55 * (hash3(kk, j, 35) - 0.5) + 0.2 * u;
        const sp0 = 0.7 + 0.6 * hash3(kk, j, 37);
        for (const sx of [-1, 1]) {
          const side = sx > 0 ? 1 : 0;
          const asym = kk === 0 ? 0.22 : 0.08;
          const as = 1 + 2 * asym * (hash3(kk, j, 39 + side) - 0.5);
          const y = yb + (kk === 0 ? 0.05 * (hash3(kk, j, 45 + side) - 0.5) : 0);
          const delay = kk === 0 ? 1 + Math.round(2 * (TOP - y) / (2 * HALF_H)) : 0;
          const tk = f - k - delay;
          if (tk < 0 || tk > 7) continue;
          const base = Math.min(SPLAT_CAP, KICK_GAIN * Math.max(dwdt(k + tk), 0));
          const vm = kk === 3 ? (y > 0.05 ? 0 : 1) : 1;
          // The VERM goes in on the frames the wall travels fastest, dense enough that each splat prints a solid
          // drop with a halftone falloff (never a ghost disc of screen alone)
          const tr = Math.max(0, w(k + tk) - w(k + tk - 1)) / dwMax;
          const verm = tk < 1 || kk === 0 ? 0 : (tr > 0.45 ? 0.75 * vm : 0);   // 480: velocity only (its splash is the crown)
          if (base <= 0 && !verm) continue;
          const r = r0 * (kk === 0 ? as : 1), sp = base * sp0 * as;
          push(sx * (wf + 0.4 * r), y, r, 0, sx * sp * Math.cos(ang), sp * Math.sin(ang), verm, 0);
        }
      }
    });

    // 552: the wall's corners would curl the pooled ink up over the shoulders (horns); a lid of
    // downward flow holds it down while the wall springs out
    if (f >= 71 && f <= 80) for (const sx of [-1, 1]) push(sx * (wf + 0.035), TOP + 0.035, 0.05, 0, sx * 0.5, -1.0, 0, 0);

    // ── pours at 492, 516, 540 (6f each): the stream (analytic, see caps) lands ON the beat ──
    // The spec deposit (G 1.2 per frame, r 0.035 at (x0, 0.21), −1.2 H/s) on all six frames; the wall
    // splits it into two unequal shoulder curtains (per pour: one breaks right, one left).
    POURS.forEach((K, pi) => {
      const tau = f - K, x0 = POUR_X[pi];
      if (tau < 0 || tau > 24) return;
      if (tau <= 5) {
        // the deposit lands flat: the spec's G 1.2 per frame at 0.21, −1.2 H/s, laid as a short horizontal
        // bar (≈ the r 0.035 splat's area) so it spreads sideways instead of doming up
        push(x0 - 0.03, 0.208, 0.014, 0, 0, -1.2, 0, 1.2, 0.06, 0);
        for (const sx of [-1, 1]) {
          const kc = this.pourK[pi][sx > 0 ? 1 : 0];
          push(sx * Math.min(wf + 0.02, 0.06) + x0, 0.195, 0.03, 0, sx * 0.55 * kc, -1.1 * kc, 0, 0);
        }
      }
      // the tail's drops land in the pool
      for (const dr of this.pourDrops[pi]) if (tau === dr.land) push(x0, TOP + 0.015, 0.02, 0, 0, -1.5, 0, dr.G);
      // the drape: from the landing, a curtain runs down each wall face (hashed, unequal speeds and
      // depths 7–16f), and most sides keep a thin drip running on below it
      for (const sx of [-1, 1]) {
        const side = sx > 0 ? 1 : 0, kc = this.pourK[pi][side];
        const v = 1.3 + 0.6 * hash3(pi, side + 1, 61), stop = 7 + Math.floor(10 * hash3(pi, side + 1, 63));
        if (tau <= stop) push(sx * (wf + 0.014), TOP - 0.01 - v * tau * DT, 0.02, 0, sx * 0.08, -v, 0, 0.55 * Math.min(1.25, 0.45 + 0.6 * kc), 0, v * DT);
        else if (hash3(pi, side + 1, 65) < 0.7 && tau <= stop + 7) {
          push(sx * (wf + 0.012), TOP - 0.01 - v * stop * DT - 1.1 * (tau - stop) * DT, 0.011, 0, 0, -1.1, 0, 0.35, 0, 1.1 * DT);   // a streak, never a bead chain
        }
      }
    });

    // ── rupture 552–587: 8 ink splats per wall per frame, outward 0.8 → 1.5 H/s (inQuad), through 587 ──
    // Eight persistent nozzles per wall (hashed heights and radii, slow drift), each laid as a continuous
    // streak whose pressure flickers on a hashed 16th (the flicker only ever adds speed). They are plain
    // ink: they push the blot out; the visible jets are the spears (analytic, see caps), which enter the
    // sim as cored jets (a VERM core in an ink sheath) when they spend themselves.
    if (f >= 72) {
      const u = clamp01((f - 72) / 35), sp = 0.8 + 0.7 * u * u;
      for (const [side, sx] of [[0, -1], [1, 1]]) for (let j = 0; j < 8; j++) {
        const salt = sx > 0 ? 11 : 13, nz = this.noz[side][j];
        const y = nz.y + 0.01 * Math.sin(0.21 * f + 6.28 * hash3(j, salt, 2));
        const fl = hash3(Math.floor(f / 6), j, salt + 3);
        const spj = Math.min(SPLAT_CAP, sp * (1 + 0.25 * fl)), r = 0.009 + 0.008 * hash3(j, salt, 8), len = spj * DT;
        const cx = sx * Math.cos(nz.ang), cy = Math.sin(nz.ang);
        push(sx * (wf + 0.012), y, r, 0, cx * spj, cy * spj, 0, 1.25 + 0.2 * fl, cx * len, cy * len);
      }
    }
    for (const sp of this.spears) if (f === sp.f0 + 7) {
      const xw = sp.sx * (wf + 0.004), sB = 0.5 * sp.L, cx = sp.sx * Math.cos(sp.ang), cy = Math.sin(sp.ang);
      const sT = sp.L * (1 - Math.exp(-7 / 2.6));
      push(xw + cx * sB, sp.y + cy * sB, 0.008, 2, cx * 1.2, cy * 1.2, 1.3, 1.4, cx * (sT - sB), cy * (sT - sB));
    }
    if (L.length > MAX_SPLATS) console.warn(`flow: ${L.length} splats at f${480 + f} (max ${MAX_SPLATS})`);
    return L.slice(0, MAX_SPLATS);
  },

  step(ctx, s) {
    const f = s.fi;
    const { w, dwdt } = this.sch;
    const obs = { uObs: [w(f), dwdt(f), HALF_H, CEN[1]], ...this.obsExtra };
    const L = this.splats(f);
    const uS = new Float32Array(MAX_SPLATS * 4), uC = new Float32Array(MAX_SPLATS * 4), uE = new Float32Array(MAX_SPLATS * 4);
    L.forEach((sp, i) => { uS.set([sp.x, sp.y, sp.r, sp.kind], i * 4); uC.set([sp.vx, sp.vy, sp.R, sp.G], i * 4); uE.set([sp.ex, sp.ey, sp.r1, sp.air], i * 4); });
    const spl = { uS, uC, uE, uN: L.length };

    ctx.draw(this.pSplatVel, { uVel: this.vel.read.tex, uDye: this.dye.read.tex, uGrav: GRAV * DT, uGravAir: GRAV_AIR * DT, uCap: SPLAT_CAP, ...spl, ...obs }, this.vel, { swap: true });
    ctx.draw(this.pCurl, { uVel: this.vel.read.tex }, this.curl);
    ctx.draw(this.pVort, { uVel: this.vel.read.tex, uCurl: this.curl.tex, uEps: EPS_VORT, uDt: DT, ...obs }, this.vel, { swap: true });
    ctx.draw(this.pDiv, { uVel: this.vel.read.tex, ...obs }, this.div);
    for (let i = 0; i < JACOBI; i++) {
      ctx.draw(this.pJacobi, { uP: this.prs.read.tex, uDiv: this.div.tex, uWarm: i === 0 ? 0.8 : 1.0 }, this.prs, { swap: true });
    }
    ctx.draw(this.pGrad, { uP: this.prs.read.tex, uDiv: this.div.tex, uVel: this.vel.read.tex, ...obs }, this.vel, { swap: true });
    // dye: advected by the projected (divergence-free) velocity
    ctx.draw(this.pAdvA, { uVel: this.vel.read.tex, uDye: this.dye.read.tex, uDt: DT }, this.dyeHat);
    ctx.draw(this.pAdvB, { uVel: this.vel.read.tex, uDye: this.dye.read.tex, uHat: this.dyeHat.tex, uDt: DT, uDiss: [0.999, 1.0, AIR_DECAY, 1.0], ...spl, ...obs }, this.dye, { swap: true });
    // the crown's hand-over: its sheet, as drawn at CROWN_T, enters the dye once
    if (f === CROWN_T) {
      const C = this.crownSheet(f, true), uCapA = new Float32Array(MAX_CAPS * 4), uCapB = new Float32Array(MAX_CAPS * 4);
      C.forEach((c, i) => { uCapA.set(c.slice(0, 4), i * 4); uCapB.set(c.slice(4, 8), i * 4); });
      ctx.draw(this.pStamp, { uDye: this.dye.read.tex, uCapA, uCapB, uCapN: C.length, ...obs }, this.dye, { swap: true });
    }
    // velocity self-advection for the next step (heavy ink: damped)
    ctx.draw(this.pAdvVel, { uVel: this.vel.read.tex, uDt: DT, uDiss: VEL_DAMP, ...obs }, this.vel, { swap: true });
  },

  // the image of in-shot frame f into target (no post)
  draw(ctx, f, target) {
    const { w, dwdt } = this.sch;
    const obs = { uObs: [w(f), dwdt(f), HALF_H, CEN[1]], ...this.obsExtra };
    const S = scaleAt(ctx, f);
    // f587 is 100% ink outside the core by construction (asserted analytically in init; the override
    // only matters for a letter whose assertion failed)
    const R = f >= 107 && !this.floodOK ? 1e3 : floodReff(f, this.kFlood);
    // the halftone fringe grows in with the rupture and closes over 571–576: the front is one solid
    // printed edge by the cut (field keys its own edge on it)
    const band = 1e-3 + FLOOD_BAND * smooth(72, 80, f) * (1 - smooth(91, 96, f));
    const k = this.kFlood;
    const front = { uR: R, uBand: band, uBias: inkBias(f) };
    const uFin = new Float32Array(48);
    this.fingers.forEach((side, si) => side.forEach((F, j) => uFin.set([F.y, F.w, F.a * smooth(F.on, F.on + 6, f), 0], (si * 6 + j) * 4)));
    ctx.draw(this.pPrep, { uDye: this.dye.read.tex, uF: f, ...front, uLobe: lobeA(f) * k, uTide: tideA(f) * k, uHold: holdB(f),
      uFin, ...obs }, this.prep);
    const glint = 1 - smooth(71, 76, f);                 // the highlights dry away over 551–556
    const swell = swellT(f);
    {   // always: the print smoothing, the glints (to 556) and the swell (from 551) all read it
      ctx.draw(this.pBlurX0, { uSrc: this.dye.read.tex }, this.blurA);
      ctx.draw(this.pBlurY, { uSrc: this.blurA.tex }, this.blurB);
      ctx.draw(this.pBlurX, { uSrc: this.blurB.tex }, this.blurA);   // twice: broad, calm domes
      ctx.draw(this.pBlurY, { uSrc: this.blurA.tex }, this.blurB);
      ctx.draw(this.pGradH, { uSrc: this.blurB.tex }, this.grad);
    }
    const C = this.caps(f);
    const uCapA = new Float32Array(MAX_CAPS * 4), uCapB = new Float32Array(MAX_CAPS * 4), box = [1e3, 1e3, -1e3, -1e3];
    C.forEach((c, i) => {
      uCapA.set(c.slice(0, 4), i * 4); uCapB.set(c.slice(4, 8), i * 4);
      const m = Math.max(c[4], c[5]) + 0.01;
      box[0] = Math.min(box[0], c[0] - m, c[2] - m); box[1] = Math.min(box[1], c[1] - m, c[3] - m);
      box[2] = Math.max(box[2], c[0] + m, c[2] + m); box[3] = Math.max(box[3], c[1] + m, c[3] + m);
    });
    ctx.draw(this.pFinal, {
      uCapA, uCapB, uCapN: C.length, uCapBox: box,
      uPrep: this.prep.tex, uGrad: this.grad.tex, uBlur: this.blurB.tex, uS: S, ...front, uSwell: swell, uLip: LIP_PX, uSmooth: 0.45,
      uFilm: FILM_W * smooth(72, 80, f), uRamp: FRONT_RAMP_PX * sys.PX / S,
      uTrap: TRAP_PX * sys.PX / S * (1 - smooth(72, 76, f)),
      uGlint: glint,
      uShOff: sys.SHADOW_PX, uShCell: sys.SHADOW_CELL_PX, uShRho: SHADOW_RHO,
      ...obs,
    }, target);
  },

  render(ctx, s) {
    const f = s.f;
    this.draw(ctx, f, s.target);
    // post: bloom 0.6, vignette 0.14; the 480 cut is exempt from easing (the flash is the break)
    const deltas = { bloom: 0.6, vignette: 0.14 };
    if (s.fi < 16) {
      const u = clamp01(f / 10);
      const flash = 1 - ctx.ease.ease.outQuad(u);
      const ca = 0.008 * (1 - u) * (1 - u);
      const amp = 5 * Math.exp(-Math.max(f, 0) / 3);                     // px (design) → uv below
      const th = 2 * Math.PI * hash3(s.fi, 480, 5);
      Object.assign(deltas, { flash, flashColor: sys.PAL_SRGB.BONE.slice(), ca, shake: [amp * Math.cos(th) / 1920, amp * Math.sin(th) / 1080] });
    }
    ctx.setPost(s, deltas, { easeFrames: 0 });
  },
};
