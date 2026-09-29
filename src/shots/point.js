// point — FIG. 0 POINT [0, 96). DIRECTION.md §5.1.
//
// The dot is born on the first downbeat, beats twice (the first beat reveals the module grid), inhales,
// divides into four children that pinch off (smin), and the field ripples out from it as a halftone of
// vermilion dots on every cell centre, breathes on the hats, then floods: the Bone gaps shrink into
// four-point stars that die on the module corners into the 96 downbeat, leaving uniform VERM at f95
// (line's IN is its inversion).
//
// Build (§5.1): one fragment pass in paper space q = p / paperZ(frame).
//   paper (Bone + fibre) → grid (1px Ink 12% / 28%, radial reveal) → registration crosshairs (1px Ink,
//   24px arms, 8px circle, 4px notch tick = the print clock) → the mother's key-light shadow →
//   dots (flat VERM).
//   Dots: 2×2 nearest cells (the §5.1 "3×3 neighbours" reduced: every radius is < 1 module, so only the
//   four nearest cell centres can reach a pixel; identical result) + 5 analytic discs (mother + four
//   children, joined by smin). Every per-cell radius (pop spring, travelling cosine, breath, flood) is
//   evaluated on the CPU once per sample into a 36×22 float texture, so the fragment shader does only
//   geometry and AA. AA is analytic (one screen pixel in q is known exactly), with a sub-pixel correction
//   so a disc of radius → 0 has coverage → 0 (no specks at unpopped cells or at the vanished mother).
//   The paper fibre (_sys paperFibre, zero under ?clean=1) is baked once at init into a paper-space
//   texture and sampled at q, so the push carries it.
//
// Motion blur: besides the engine's N samples, the two fast radial edges (the mother, whose collapse
// runs at up to ~250 px/frame, and the grid-reveal front) are integrated analytically over each
// sample's own slice of the shutter (±0.25/N frame): the pixel coverage is the exact time average of
// a linearly moving edge under a 1px box filter, so the N slices tile into one continuous smear.
//
// Spec changes and choices where §5.1 is silent (each listed in the report):
//   - Key light (§1.4): only the mother casts the (+6,−6)px 45° Ink halftone shadow. It slides out from
//     under the dot as it lifts off the print (2–8) and back under it over 45–48, before her collapse,
//     so no halftone ever sits inside her motion blur. Children and the field are flat printed ink.
//   - Crosshairs in paper space at (±0.80, ±0.40) (§5.1: ±0.42; 0.40 = volume's wall height): at 0.42
//     the push carries the bottom pair into the engine HUD labels. Centres are snapped to pixel centres
//     and the mark is drawn in screen pixels (arms exactly ±12 px, ring r 8 px, a 1px radial notch
//     r 8.5→12.5 px outside the ring, on positions 22.5° off the arms).
//   - Mitosis: exactly §5.1's outExpo from 48 to 0 at 58, preceded by a §1.5 anticipation on the TR–BL
//     diagonal (42–48). The mother's own shutter is shortened on f1–3 and f48–49 (momShutter).
//   - Grid reveal: §5.1's R = 2.0·outExpo(·/12), its clock started at 23.75 so f24 shows the grid.
//   - Flood: an out-ease of power 1.5 over 84–95 to c/√2 (+0.6px) (§5.1: outExpo to 0.72c, which kills
//     the stars by ~90 instead of "by 95"); the last specks die on 94.
//   - Children reach the ripple formula over 54–60 (floored at 0.30c), lattice handover at 62.
//   - MB off on f0 (a crisp first frame of the reel).
import * as sys from './_sys.js';

const C = sys.C_MOD;                 // module, 1/18 H
const PXD = sys.PX;                  // one design px in H (paper units at paperZ = 1)
const TAU = Math.PI * 2;
const GX = 36, GY = 22;              // cell texture: kx ∈ [−18, 17], ky ∈ [−11, 10]
const OX = 18, OY = 11;
const RHO_IN = C * Math.SQRT1_2;     // |cell centre| of the four inner cells (the children)
// Children: (direction, departure frame) — TR, TL, BL, BR at 48, 50, 52, 54 (§5.1).
const KIDS = [[1, 1, 48], [-1, 1, 50], [-1, -1, 52], [1, -1, 54]];
const R_KID = 0.30 * C;              // child radius
const HATS = [72, 78, 84, 90];       // the dots breathe on the closed hats (§3 cue list)
const KID_HANDOVER = 62;             // from here the children are identical to their lattice cells (BR lands at 62)
// Mother through the mitosis (§5.1): r = r48·(1 − outExpo((f − 48)/10)), 0 at 58 (½ at 49, ¼ at 50).
// Before it, a §1.5 anticipation on the TR–BL diagonal (the first child leaves to TR): squash across the
// diagonal 42–45 (0.82 / 1.22, area kept), then release into a stretch along it 45–48 (1.15 / 0.87)
// that relaxes as she divides.
const MOM_T0 = 48, MOM_LEN = 10;
// Grid reveal: R = 2.0·outExpo((f − 24)/12) (§5.1), its clock started at the opening of f24's shutter
// (23.75, like the snap's pre-roll) so the thump frame itself already shows the grid ≈ 290 px out.
const GRID_R = 2.0, GRID_T0 = 23.75;
// Registration crosshairs: paper-space centres (±CROSS_X, ±CROSS_Y); 24px arms, 8px circle.
const CROSS_X = 0.80, CROSS_Y = 0.40;
const CROSS_EXTENT = 14.5 * PXD;     // radius (paper units) that contains a whole mark incl. its AA and snap
// Flood: r grows to just past c/√2 over 84 → 95 with an out-ease of power 1.5 (outQuad-like attack,
// a longer tail than outQuad), so the Bone stars shrink steadily over 88–94 and die into the 96 print.
const FLOOD_0 = 84, FLOOD_LEN = 11, FLOOD_POW = 1.5;

const FIBRE_FRAG = (glsl) => /* glsl */`${glsl}
uniform float uAsp;
in vec2 vUv; out vec4 o;
void main(){ o = vec4(paperFibre(P(vUv, uAsp)), 0.0, 0.0, 1.0); }`;

// One fragment program, specialised per phase with #defines (SwiftShader executes both sides of a
// branch, so dead features must be compiled out, not skipped): F_GRID, F_REVEAL (the grid's reveal
// front is still on screen), F_CROSS, F_LAT, F_HERO, F_KIDS, F_SHADOW, F_FLAT. The crosshairs and the
// hero group are drawn by the same program with their feature compiled in, scissored to their boxes.
const FRAG = (glsl, flags) => /* glsl */`${glsl}
${flags.map(f => `#define F_${f}`).join('\n')}
uniform vec2 uRes;
uniform sampler2D uFibre;   // paperFibre at z = 1, covering the frame
uniform sampler2D uCells;   // .r = dot radius of cell (kx, ky) in q units at texel (kx+18, ky+11); ≤ 0 = absent
uniform float uZ;           // paperZ(frame)
uniform vec3 uMomO, uMomC;  // mother at this sample's shutter-slice open / close: r (≤ 0 = gone), sx, sy
uniform vec4 uKid[4];       // children: x, y, r (≤ 0 = absent), smin k
uniform vec2 uMomRot;       // mother's ellipse axes: (cos, sin) of their rotation
uniform float uCore;        // radius of the children still waiting at the origin (0 = none)
uniform vec2 uGridR;        // grid reveal radius (q) at the shutter-slice open / close
uniform vec3 uCross;        // crosshair centre |x|, |y| (q units, on a pixel centre), snap progress e
uniform vec2 uTick;         // notch-tick direction
uniform vec2 uShadow;       // mother's shadow offset (q units)
in vec2 vUv; out vec4 o;

const ivec2 CO = ivec2(${OX}, ${OY});
const ivec2 CMAX = ivec2(${GX - 1}, ${GY - 1});
float PXQ;                  // one screen pixel, in q units

// Disc distance with a sub-pixel correction: at r = 0 the centre sits 0.5 px outside (coverage 0),
// at r ≥ 1 px it is exact; in between coverage tracks the area. Keeps births and deaths speck-free.
float discD(vec2 d, float r){ return length(d) - r + 0.5 * max(PXQ - r, 0.0); }
float cover(float d){ return clamp(0.5 - d / PXQ, 0.0, 1.0); }
// Time-averaged cover() of an edge whose distance moves linearly from d0 to d1 across the shutter
// slice: the exact mean of the 1px box-filter ramp (∫clamp = 0.5·clamp(u)² + max(u − 1, 0)).
float Hc(float u){ float c = clamp(u, 0.0, 1.0); return 0.5 * c * c + max(u - 1.0, 0.0); }
float avgCover(float d0, float d1){
  float u0 = 0.5 - d0 / PXQ, u1 = 0.5 - d1 / PXQ, du = u1 - u0;
  return abs(du) < 1e-3 ? clamp(0.5 * (u0 + u1), 0.0, 1.0) : clamp((Hc(u1) - Hc(u0)) / du, 0.0, 1.0);
}
// 1px line, box-filtered: coverage of a pixel whose centre is d from the line's centre (w = one pixel).
float line1(float d, float w){ return clamp(1.0 - abs(d) / w, 0.0, 1.0); }

#if defined(F_HERO) || defined(F_SHADOW)
// Ellipse (semi-axes ab) distance, iq's first-order approximation (exact on the axes).
float ellipseD(vec2 p, vec2 ab){
  float k1 = length(p / (ab * ab));
  float k0 = length(p / ab);
  return k1 < 1e-9 ? -min(ab.x, ab.y) : k0 * (k0 - 1.0) / k1;
}
// The mother (r, sx, sy); r ≤ 0 is a zero-radius disc (coverage 0), so her death is continuous.
float momD(vec2 q, vec3 m){
  float rm = m.x * min(m.y, m.z);
  vec2 qr = vec2(dot(q, uMomRot), dot(q, vec2(-uMomRot.y, uMomRot.x)));
  return rm <= 1e-7 ? length(q) + 0.5 * PXQ : ellipseD(qr, m.x * m.yz) + 0.5 * max(PXQ - rm, 0.0);
}
// Her time-averaged coverage over the shutter slice.
float momCover(vec2 q){ return avgCover(momD(q, uMomO), momD(q, uMomC)); }
#endif

#ifdef F_HERO
float sminP(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
  return k <= 1e-6 ? min(a, b) : mix(b, a, h) - k * h * (1.0 - h);
}
float kidD(vec2 q, float dm, vec4 K){ return K.z > 0.0 ? sminP(dm, discD(q - K.xy, K.z), K.w) : 1e9; }
// The hero group: the mother's smear, and each child joined by smin to her smallest extent in the
// slice (which lies inside the smear's fully covered core, so the union has no step).
float heroCover(vec2 q){
  float dO = momD(q, uMomO), dC = momD(q, uMomC);
  float c = avgCover(dO, dC);
#ifdef F_KIDS
  float dm = max(dO, dC);
  if (uCore > 0.0) dm = min(dm, discD(q, uCore));
  c = max(c, cover(min(min(kidD(q, dm, uKid[0]), kidD(q, dm, uKid[1])), min(kidD(q, dm, uKid[2]), kidD(q, dm, uKid[3])))));
#endif
  return c;
}
#endif

#ifdef F_LAT
// The field: the four nearest cell centres.
float cellD(vec2 q, ivec2 c){
  float r = texelFetch(uCells, clamp(c + CO, ivec2(0), CMAX), 0).r;
  return r > 0.0 ? discD(q - (vec2(c) + 0.5) * C_MOD, r) : 1e9;
}
float lattice(vec2 q){
  ivec2 c0 = ivec2(floor(q / C_MOD - 0.5));
  return min(min(cellD(q, c0), cellD(q, c0 + ivec2(1, 0))), min(cellD(q, c0 + ivec2(0, 1)), cellD(q, c0 + ivec2(1, 1))));
}
#endif

#ifdef F_GRID
// Grid: coverage of the nearest 1px line of pitch P through x (lines at k·P).
// Perceptual coverage (as the crosshairs): a line split over two pixels keeps the weight of an aligned one.
float gridLine(float x, float P){ float c = line1((x / P - floor(x / P + 0.5)) * P, PXQ); return 1.0 - pow(1.0 - c, 2.2); }
#endif

void main(){
#ifdef F_FLAT
  o = vec4(VERM, 1.0); return;   // the flood has covered every module corner: exactly what the full pass yields
#endif
  vec2 p = P(vUv, uRes.x / uRes.y);
  vec2 q = p / uZ;
  PXQ = 1.0 / (uRes.y * uZ);

  // paper
  vec3 col = BONE * (1.0 + texture(uFibre, q / vec2(uRes.x / uRes.y, 1.0) + 0.5).r);

#ifdef F_GRID
  // grid: minor 1px Ink 12%, every 4th line 28%, revealed inside R around the origin
  {
    float cx = gridLine(q.x, C_MOD), cy = gridLine(q.y, C_MOD);
    float Cx = gridLine(q.x, 4.0 * C_MOD), Cy = gridLine(q.y, 4.0 * C_MOD);
    float a = max(0.12 * (1.0 - (1.0 - cx) * (1.0 - cy)), 0.28 * (1.0 - (1.0 - Cx) * (1.0 - Cy)));
#ifdef F_REVEAL
    float lq = length(q);
    a *= avgCover(lq - uGridR.x, lq - uGridR.y);
#endif
    col = mix(col, INK, a);
  }
#endif

#ifdef F_CROSS
  // registration crosshairs at (±0.80, ±0.40), paper space: 1px Ink, 24px arms, 8px circle, 4px notch tick
  {
    // in screen pixels about the mark's centre (a pixel centre): the mark is a print mark, pixel-true
    vec2 d = (q - vec2(q.x < 0.0 ? -uCross.x : uCross.x, q.y < 0.0 ? -uCross.y : uCross.y)) / PXQ;
    float e = uCross.z;
    float L = 12.0 * e, R = 8.0 * e;
    // arms: ±L from the centre pixel, symmetric (the end pixels get the same partial coverage)
    float arms = max(line1(d.y, 1.0) * clamp(L + 0.5 - abs(d.x), 0.0, 1.0),
                     line1(d.x, 1.0) * clamp(L + 0.5 - abs(d.y), 0.0, 1.0));
    // the ring follows the arms in: while it is smaller than ~4px it would close into a blob
    float ring = line1(length(d) - R, 1.0) * smoothstep(0.45, 0.8, e);
      // the print-clock notch: a 2px Ink radial stub standing out of the ring (r R+0.5 → R+5), a bezel
    // tick; 2px so its off-axis antialiasing still reads as a solid mark at 1:1
    float t = clamp(dot(d, uTick), R + 0.5, R + 5.0 * e);
    float tick = clamp(1.5 - length(d - uTick * t), 0.0, 1.0) * smoothstep(0.55, 0.95, e);
    // perceptual coverage: a hairline split over two pixels carries the same visual weight as a
    // pixel-aligned one (linear-light mixing would read it, and the ring, much lighter)
    float a = max(max(arms, ring), tick);
    col = mix(col, INK, 1.0 - pow(1.0 - a, 2.2));
  }
#endif

  float cov = 0.0;
#ifdef F_LAT
  cov = cover(lattice(q));
#endif
#ifdef F_HERO
  cov = max(cov, heroCover(q));
#endif
#ifdef F_SHADOW
  // the mother's key-light shadow: (+6,−6)px, 45° Ink halftone (8px cells, 35%), under the dots; only
  // where the dots' (time-averaged) coverage leaves it
  // The dots shrink towards the shadow's outer edge (tone ramps over its outer 3 design px), so no
  // dot is ever cut in half by it: the crescent's thin ends taper into small whole dots.
  {
    float depth = -momD(q - uShadow, uMomC) * 1080.0;
    float tone = 0.35 * smoothstep(0.0, 3.0, depth);
    col = mix(col, INK, max(momCover(q - uShadow) - cov, 0.0) * halftone45(q, 8.0, tone, 1080.0 * PXQ));
  }
#endif
  col = mix(col, VERM, cov);
  o = vec4(col, 1.0);
}`;

export default {
  id: 'point',

  init(ctx) {
    sys.initSys(ctx);
    const glsl = this.glsl = `${ctx.glsl.common}${sys.SYS_GLSL}`;
    this.progs = new Map();
    // paper fibre, baked once (x varies slowly: a quarter-width texture is plenty)
    const gl = ctx.gl;
    this.fibre = ctx.fbo(Math.ceil(ctx.W / 4), ctx.H, { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT });
    ctx.draw(ctx.program(FIBRE_FRAG(glsl), 'point:fibre'), { uAsp: ctx.W / ctx.H, ...sys.sysUniforms(ctx) }, this.fibre);

    this.cellData = new Float32Array(GX * GY);
    this.cellTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, GX, GY, 0, gl.RED, gl.FLOAT, this.cellData);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    // per-cell constants: centre radius ρ, and whether it is one of the four children's cells
    this.cellRho = new Float32Array(GX * GY);
    this.cellKid = new Uint8Array(GX * GY);
    this.cellVis = new Uint8Array(GX * GY);
    for (let iy = 0; iy < GY; iy++) for (let ix = 0; ix < GX; ix++) {
      const kx = ix - OX, ky = iy - OY, i = iy * GX + ix;
      this.cellRho[i] = Math.hypot((kx + 0.5) * C, (ky + 0.5) * C);
      this.cellKid[i] = (kx === 0 || kx === -1) && (ky === 0 || ky === -1) ? 1 : 0;
      // cells whose disc can reach the frame (|q| ≤ frame half-size at paperZ ≥ 1, plus one module)
      this.cellVis[i] = Math.abs((kx + 0.5) * C) <= ctx.W / ctx.H / 2 + C && Math.abs((ky + 0.5) * C) <= 0.5 + C ? 1 : 0;
    }
    // each crosshair: the texel of its nearest cell centre, and the distance to it
    this.crossCells = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const mx = sx * CROSS_X, my = sy * CROSS_Y;
      const kx = Math.floor(mx / C), ky = Math.floor(my / C);
      this.crossCells.push([(ky + OY) * GX + (kx + OX), Math.hypot(mx - (kx + 0.5) * C, my - (ky + 0.5) * C)]);
    }
    // compile every shader variant the shot will use (MB sub-frames included) up front
    for (let f = -0.25; f <= 95.25; f += 0.0625) {
      const st = this.state(ctx, f, Math.round(f), ctx.H, 6);
      for (const v of [st.base, st.cross, st.hero]) if (v) this.variant(ctx, v);
    }
  },

  variant(ctx, flags) {
    const key = flags.join(',');
    if (!this.progs.has(key)) this.progs.set(key, ctx.program(FRAG(this.glsl, flags), `point:${key}`));
    return this.progs.get(key);
  },

  // Everything the frame needs, as a pure function of the (fractional) in-shot frame f, the integer
  // frame fi, the target height H and the MB sample count N (this sample owns ±0.25/N frame).
  state(ctx, f, fi, H, N) {
    const { ease: E, spring } = ctx.ease;
    const z = sys.paperZ(f);                        // point starts at global frame 0
    const pxq = 1 / (H * z);                        // one screen pixel in q units
    const hw = N >= 2 ? 0.25 / N : 0;               // half the shutter slice of this sample, frames

    // ── mother at the slice's open and close: spring birth, heartbeat squash, inhale, mitosis
    // Her own shutter is shortened where her edge is fastest (birth f1–3, collapse f48–49), so her rim
    // keeps the hardness of the crisp f0 instead of smearing into a soft glow (§1.2: no gradients).
    const ms = momShutter(fi), mf = g => fi + (g - fi) * ms;
    const mom = g => [momR(E, spring, g), ...heartbeat(E, g)];
    const momO = mom(mf(f - hw)), momC = mom(mf(f + hw));

    // ── ripple: per-cell radius
    const breath = 1 + 0.08 * HATS.reduce((a, h) => a + hatPulse(f - h), 0);
    const flood = f > FLOOD_0 ? 1 - (1 - Math.min(1, (f - FLOOD_0) / FLOOD_LEN)) ** FLOOD_POW : 0;
    // flood target: just past the corner distance c/√2 (so f95 is full cover at any scale); ≈ 0.71c
    const rEnd = RHO_IN + 0.6 * pxq;
    const wavePh = (f - 54) / 24;
    const formula = rho => C * (0.30 + 0.12 * Math.cos(TAU * (rho / 0.22 - wavePh)));
    const popAt = rho => { const u = f - 54 - 24 * rho / 1.1; return u > 0 ? spring(u / 60, 4, 0.45) : 0; };
    // the last stars finish cleanly: once a star's half-diagonal (≈ c/√2 − r) is under 1.2 px it shrinks
    // twice as fast, and under 0.6 px it is gone (no sub-pixel Bone specks on the last flood frames)
    const finish = r => {
      const v = r * breath + (rEnd - r * breath) * flood, g = (RHO_IN - v) / pxq;
      return flood <= 0 || g >= 1.2 ? v : g < 0.6 ? rEnd : RHO_IN - (g - 0.6) * 2 * pxq;
    };
    const handover = f >= KID_HANDOVER;

    const data = this.cellData;
    let alive = 0, minVis = Infinity;
    for (let i = 0; i < GX * GY; i++) {
      let r = -1;
      if ((handover || !this.cellKid[i]) && f > 54) {
        const rho = this.cellRho[i], pop = popAt(rho);
        if (pop > 0) { r = finish(formula(rho) * pop); alive = 1; }
      }
      data[i] = r;
      if (this.cellVis[i]) minVis = Math.min(minVis, r);
    }
    // every point is within c/√2 of its nearest cell centre, so once every visible cell's radius clears
    // c/√2 by 0.5 px (+0.05 margin) every pixel's coverage clamps to 1: the frame is exactly uniform VERM
    const flat = handover && minVis >= RHO_IN + 0.55 * pxq;
    // a crosshair wholly inside one cell's disc (by 0.6 px) is invisible: compile the marks out
    const crossHidden = this.crossCells.every(([i, dist]) => data[i] - dist >= CROSS_EXTENT + 0.6 * pxq);

    // ── children: depart on 48/50/52/54 to (±c/2, ±c/2) with outBack over 8f, r 0.30c, joined to the
    // mother (and the children still waiting at the origin) by smin k = 0.06(1 − e). k blends in over the
    // first 1.5f of travel, so a child still at the origin unions with plain min (smin of concentric discs
    // would inflate the core). They reach the ripple formula at 60; the lattice takes them at 62, when
    // the last (BR) has landed.
    const kids = [];
    const popIn = popAt(RHO_IN), Fin = formula(RHO_IN);
    const rA = R_KID + (Fin - R_KID) * popIn, rB = Fin * popIn;
    // §5.1: they ease to the formula over 54–60; floored at their own size until the formula overtakes
    // them (~58.5), since the formula's pop starts from 0 (a literal blend dips them to 0.23c at 57)
    const rBl = rA + (rB - rA) * E.inOutSine((f - 54) / 6);
    const rk = f > 54 ? finish(f < 60 ? Math.max(rBl, R_KID) : rBl) : R_KID;
    for (const [dx, dy, t0] of KIDS) {
      if (f < 44 || handover) { kids.push(0, 0, -1, 0); continue; }
      const e = f > t0 ? E.outBack((f - t0) / 8) : 0;
      kids.push(e * dx * C / 2, e * dy * C / 2, rk, 0.06 * Math.max(0, 1 - e) * Math.min(1, Math.max(0, f - t0) / 1.5));
    }
    // the body the departing children pinch off: the mother, plus the children still waiting at the origin
    const core = f >= 44 && f < 54 ? rk : 0;
    const momOn = momO[0] > 0 || momC[0] > 0;
    const heroOn = !handover && (momOn || f >= 44);
    // the mother's shadow: slides out from under her as she lifts off the print (2–8), and back under
    // her in step with her collapse (outExpo from 48), so it never exists at child scale
    // (retracted 45–48, before the collapse, so no halftone ever sits inside her motion blur)
    const shK = momOn ? E.inOutSine((f - 2) / 6) * (1 - E.inOutSine((f - 45) / 3)) : 0;

    // ── grid reveal, at the slice's open and close
    const gridAt = g => (g > GRID_T0 ? GRID_R * E.outExpo((g - GRID_T0) / 12) : 0);
    const gridR = [gridAt(f - hw), gridAt(f + hw)];
    // ── crosshairs: latched on the integer frame (a 24px mark needs no blur). The snap (outExpo, 4f)
    // carries a 0.25f pre-roll so f0 shows it begun (≈35%), like the dot's pre-roll. The print-clock
    // tick steps 45° clockwise on every 8th, 0–84 (inOutBack s 1.3 over 2f, centred so the anticipation
    // shows on 12k−1 and the click lands on the 8th itself, 12k, with its overshoot; settled by 12k+1),
    // on positions 22.5° off the arms so it never hides in one: 112.5° → 67.5° on the f0 step.
    const snap = E.outExpo((fi + 0.25) / 4);
    let steps = 0;
    for (let k = 0; k <= 7; k++) steps += E.inOutBack((fi - 12 * k + 1.5) / 2, 1.3);
    const tick = Math.PI * 0.625 - Math.PI * 0.25 * steps;

    // bounding radius of the hero group (mother ellipse, children incl. outBack overshoot, smin bulge)
    const momExt = Math.max(momO[0] * Math.max(momO[1], momO[2]), momC[0] * Math.max(momC[1], momC[2]));
    const bound = Math.max(momExt, f >= 44 ? Math.SQRT1_2 * C * 1.12 + rk : 0) + 0.02;

    // shader variants: the full-frame base pass, and the scissored crosshair and hero passes. The reveal
    // is compiled out once its front has passed the frame corner in the whole shutter slice.
    const corner = Math.hypot(ctx.W / ctx.H / 2, 0.5) / z;
    const gridOn = gridR[0] > 0 || gridR[1] > 0, reveal = Math.min(gridR[0], gridR[1]) < corner + 0.6 * pxq;
    const common = [...(gridOn ? ['GRID'] : []), ...(gridOn && reveal ? ['REVEAL'] : []), ...(alive ? ['LAT'] : [])];
    const base = flat ? ['FLAT'] : common;
    const cross = !flat && snap > 0 && !crossHidden ? ['CROSS', ...common] : null;
    const hero = heroOn ? ['HERO', ...(f >= 44 ? ['KIDS'] : []), ...(shK > 0 ? ['SHADOW'] : []), ...common] : null;
    const rot = f > 41 ? Math.PI / 4 : 0;
    return { z, momO, momC, rot, core, kids, shK, gridR, snap, tick, bound, base, cross, hero };
  },

  render(ctx, s) {
    const st = this.state(ctx, s.f, s.fi, ctx.H, s.mbN);
    const gl = ctx.gl, W = ctx.W, H = ctx.H;
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GX, GY, gl.RED, gl.FLOAT, this.cellData);
    const sh = [sys.SHADOW_PX[0] * PXD * st.shK, sys.SHADOW_PX[1] * PXD * st.shK];
    const cq = crossQ(sys.paperZ(s.fi), W, H);
    const U = {
      uFibre: this.fibre.tex,
      uCells: this.cellTex,
      uZ: st.z,
      uMomO: st.momO,
      uMomC: st.momC,
      uKid: st.kids,
      uMomRot: [Math.cos(st.rot), Math.sin(st.rot)],
      uCore: st.core,
      uGridR: st.gridR,
      uCross: [cq[0] / st.z, cq[1] / st.z, st.snap],
      uTick: [Math.cos(st.tick), Math.sin(st.tick)],
      uShadow: sh,
    };
    ctx.draw(this.variant(ctx, st.base), U, s.target);
    gl.enable(gl.SCISSOR_TEST);
    if (st.cross) {
      // the four marks: the base program with the crosshair compiled in, over a box around each
      const prog = this.variant(ctx, st.cross), b = Math.ceil(CROSS_EXTENT * st.z * H) + 3;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const cx = Math.round(W / 2 + sx * cq[0] * H), cy = Math.round(H / 2 + sy * cq[1] * H);
        gl.scissor(cx - b, cy - b, 2 * b, 2 * b);
        ctx.draw(prog, U, s.target);
      }
    }
    if (st.hero) {
      // the hero group and its shadow: the same program with the hero compiled in, over its bounding box
      // (no crosshair reaches it: the marks sit at |x| ≥ 0.78)
      const hpx = Math.ceil((st.bound + Math.hypot(...sh)) * st.z * H) + 3;
      const x0 = Math.max(0, Math.floor(W / 2) - hpx), y0 = Math.max(0, Math.floor(H / 2) - hpx);
      gl.scissor(x0, y0, Math.min(W, Math.ceil(W / 2) + hpx) - x0, Math.min(H, Math.ceil(H / 2) + hpx) - y0);
      ctx.draw(this.variant(ctx, st.hero), U, s.target);
    }
    gl.disable(gl.SCISSOR_TEST);
    ctx.setPost(s, {});
  },

  // §5.1 MB: 6 on 0–12, 22–40, 48–62 and 84–95; 0 elsewhere. Extended over 42–47, the pre-division
  // anticipation (its squash and release are shape changes as fast as the heartbeat's). Except f0, the reel's first frame, a crisp
  // still of the dot (its blur starts with the motion, on f1, with a shortened shutter:
  // momShutter).
  mb(f) { return (f >= 1 && f <= 12) || (f >= 22 && f <= 40) || (f >= 42 && f <= 62) || (f >= 84 && f <= 95) ? 6 : 0; },

  postOut: {},
};

// A crosshair centre on the screen (H units, the (+,+) mark; the others mirror it): its paper position
// (±0.80, ±0.40) pushed by z, snapped to a pixel centre so the 1px hairlines stay crisp. It steps a
// whole pixel every ~3 frames (x) / ~6 frames (y) as the push carries it, instead of smearing across
// two pixels. W and H are even, so the mirrored marks land on pixel centres too.
function crossQ(z, W, H) {
  return [(Math.floor(W / 2 + CROSS_X * z * H) + 0.5 - W / 2) / H, (Math.floor(H / 2 + CROSS_Y * z * H) + 0.5 - H / 2) / H];
}

// The mother's radius (before the heartbeat squash): the spring birth with its 5f pre-roll
// (0.657 at f0, 1.178 at f6), then the §5.1 collapse r48·(1 − outExpo((f − 48)/10)), 0 at 58.
function momR(E, spring, f) {
  let r = 0.11 * spring(f / 60 + 5 / 60, ...sys.SPRING_DOT);
  if (f > MOM_T0) r *= 1 - E.outExpo((f - MOM_T0) / MOM_LEN);
  return Math.max(r, 0);
}

// Fraction of the shutter the mother's own edge integrates over (1 = the full 0.5-frame shutter).
function momShutter(fi) {
  return fi <= 1 ? 0.35 : fi === 2 ? 0.6 : fi === 3 ? 0.85 : fi === 47 ? 0.5 : fi === 48 ? 0.25 : fi === 49 ? 0.5 : 1;
}

// Heartbeat (§5.1, f22–40): squash into each thump (a cusp on 24 and on 30), release into the stretch.
// Keys are (sx, sy) exactly as specified.
function heartbeat(E, f) {
  const K = [
    [22, 1.00, 1.00, null],
    [24, 1.12, 0.88, E.inQuad],      // squash into the first thump
    [27, 0.90, 1.10, E.outCubic],    // stretch
    [28, 0.90, 1.10, null],          // hold
    [30, 1.05, 0.95, E.inQuad],      // second, smaller squash
    [33, 0.97, 1.03, E.outCubic],    // rebound
    [40, 1.00, 1.00, E.inOutSine],   // settle to rest by 40
    // pre-division anticipation (axes rotated 45°: sx along the TR–BL diagonal)
    [42, 1.00, 1.00, null],
    [45, 0.82, 1.22, E.inOutSine],   // squash across the diagonal
    [46, 0.82, 1.22, null],          // hold
    [48, 1.15, 0.87, E.inOutSine],   // release into a stretch along it: the first bud leaves TR
    [54, 1.00, 1.00, E.inOutSine],   // relax while she divides
  ];
  if (f <= K[0][0] || f >= K[K.length - 1][0]) return [1, 1];
  if (f > 40 && f <= 42) return [1, 1];
  for (let i = 1; i < K.length; i++) {
    const [t1, x1, y1, e] = K[i], [t0, x0, y0] = K[i - 1];
    if (f <= t1) {
      const k = e ? e((f - t0) / (t1 - t0)) : 1;
      return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
    }
  }
  return [1, 1];
}

// A breath on a closed hat: up over 1.5f, back down by 6f (the next hat).
function hatPulse(u) {
  if (u <= 0 || u >= 6) return 0;
  if (u < 1.5) return Math.sin(0.5 * Math.PI * u / 1.5);
  return 0.5 + 0.5 * Math.cos(Math.PI * (u - 1.5) / 4.5);
}
