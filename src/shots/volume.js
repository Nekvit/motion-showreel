// FIG. 4 — VOLUME [384, 480), station 3 (V). The breath. DIRECTION.md §5.5 (+ §8.2: ball at (NOTCH_X, NOTCH, 0)).
//
// The flat glass V from `lens` is revealed as a solid in a lit Bone studio by a vermilion light sheet;
// the dot inflates into a ball through light alone; a dolly zoom opens the space; the camera orbits to
// edge-on where the V and the lifted ball read as an "i"; the lights cut and the ball falls in the dark.
//
// Passes per frame (mb(f) = 0: this shot blurs itself; every pass is a pure function of the frame).
// SwiftShader executes every branch of a shader for every pixel (an untaken branch costs as much as a taken
// one; loops stop only once all lanes are done), so the passes come in #define variants and are split by
// scissor: the objects' screen box (V ∪ ball) runs the full program, the rest of the frame a studio-only one.
//   0. init: the V's outline is fitted as an exact polygon to _sys's glyph SDF (volume/poly.js; the raster SDF
//      stands in if a glyph is not polygonal). The eye ray hits the exact prism analytically, then settles on
//      its 0.012 rounding by exact sphere steps: no raster error is ever seen at grazing incidence.
//   1. trace (half-res): analytic floor / cove / wall / ball / V. Glass = Fresnel reflection + an analytic
//      path through the exact prism (polygon × z slab; side-face TIR followed, z faces folded while they
//      reflect totally — a light pipe; ≤ 2 segments = both arms) + two exit rays at IOR 1.53 / 1.47 combined
//      on the VERM–COBALT axis + COBALT Beer–Lambert. The floor is lit from a map baked at init (caustics of
//      both IORs, the V's area-light soft shadow, contact AO). Out: grid-free colour + signed view depth
//      (< 0 = glass) and, for glass, where each dispersed exit ray landed and the transmitted fraction τ.
//   2. half-res post: glass samples whose light path is unresolvable at half res (TIR, grazing rounded
//      edges) show their local mean; from 428 the 16-tap golden-angle depth-of-field gather.
//   3. glass refinement (full-res, scissored to the V's screen box): every pixel near the glass is traced
//      again, with the grid put into each dispersed sample before they are combined (footprint = the quad's
//      landing spread); 4 rays where the half-res samples disagree, 8 where the exit direction sweeps many
//      pixel angles per pixel, 4 everywhere edge-on. Then filters: where the glass magnifies beyond any
//      sample rate a masked gaussian shows the patch's mean (edge-on: a vertical median of 7 and a footprint
//      mean of every interior slab pixel, whose paths all flip fold / TIR branches at the pixel scale), and
//      a neighbourhood clamp so no isolated dot survives.
//   4. grid (full-res): floor and wall grids + crosshairs box-filtered at full resolution, seen directly
//      (footprint from ray differentials + CoC + part of the motion) and through any unrefined glass.
//   5. composite (full-res): exact analytic surfaces, class-aware 2× upsample (glass / ball / studio), the
//      refined glass, the V's antialiased silhouette from its SDF, the light sheet against prevTex (lens),
//      the blackout's analytic slab outline, and per-pixel screen velocity (camera at t ∓ ¼ frame).
//   6. motion blur (full-res, while anything moves): tile-max / neighbour-max velocity (tile lookup jittered),
//      6–12 IGN-jittered taps along the pixel's own motion where it dominates, else the neighbourhood's, with
//      McGuire-style depth/velocity weights (depth and streak length packed in the fp32 alpha).
import * as sys from './_sys.js';
import { makeSchedule, T, RIM_DIR } from './volume/params.js';
import { makeSdfGlsl, SCENE_GLSL, SHADE_GLSL } from './volume/glsl.js';
import { fitGlyphPolygon, polyUniform } from './volume/poly.js';
import { bakeFloorMap } from './volume/bake.js';

const DEG = Math.PI / 180;
const V_HZ = 0.146, V_RND = 0.012;

// The V's SDF, gaussian-smoothed (σ in texels). Along straight edges the distance field is linear, so the
// blur leaves the surface exactly where _sys puts it and only removes the raster's periodic sub-pixel
// error, which refraction over a metre of glass would otherwise turn into striped caustics and speckled
// side faces. Blurring keeps the field 1-Lipschitz and only lowers |d| at medial ridges (safe to march).
function smoothGlyph(meta, sigma) {
  const { w, h, data } = meta, R = Math.ceil(3 * sigma);
  const k = []; let ks = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -R; i <= R; i++) a += k[i + R] * data[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -R; i <= R; i++) a += k[i + R] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = a;
  }
  return out;
}
function floatTex(gl, w, h, data) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
  const lin = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
// CPU twin of the shader's sdV2 (bilinear sample of the smoothed field, cap units = wu)
function sdV2cpu(V, data, x, y) {
  const px = V.ox + (x + V.inkCx) * V.capPx - 0.5, py = V.oy + y * V.capPx - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  const at = (i, j) => data[Math.min(V.h - 1, Math.max(0, j)) * V.w + Math.min(V.w - 1, Math.max(0, i))];
  return ((at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy) / V.capPx;
}
// The V's outer right edge x(y) (the edge nearest the camera once the orbit is edge-on)
function outerRight(V, data, y) {
  let x = 1.2;
  while (x > -1.2 && sdV2cpu(V, data, x, y) > 0) x -= 0.004;
  let a = x, b = x + 0.004;
  for (let i = 0; i < 30; i++) { const m = 0.5 * (a + b); if (sdV2cpu(V, data, m, y) > 0) b = m; else a = m; }
  return 0.5 * (a + b);
}
// world → (x/2th, y/2th, depth) as a column-major mat3 (rows R/2th, U/2th, F)
const camMat = c => { const k = 1 / (2 * c.th); const r0 = c.R.map(v => v * k), r1 = c.U.map(v => v * k), r2 = c.F; return [r0[0], r1[0], r2[0], r0[1], r1[1], r2[1], r0[2], r1[2], r2[2]]; };
const turn = (v, yawDeg) => { const a = yawDeg * DEG, c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; };
// world point → (gl_FragCoord x, y, depth) for camera c
function project(ctx, c, p) {
  const q = [p[0] - c.eye[0], p[1] - c.eye[1], p[2] - c.eye[2]];
  const z = q[0] * c.F[0] + q[1] * c.F[1] + q[2] * c.F[2];
  const sx = (q[0] * c.R[0] + q[1] * c.R[1] + q[2] * c.R[2]) / (z * 2 * c.th);
  const sy = (q[0] * c.U[0] + q[1] * c.U[1] + q[2] * c.U[2]) / (z * 2 * c.th);
  return [(sx / ctx.aspect + 0.5) * ctx.W, (sy + 0.5) * ctx.H, z];
}

export default {
  id: 'volume',
  postOut: { bloom: 0.8, vignette: 0.16 },
  mb() { return 0; },

  init(ctx) {
    const gl = ctx.gl;
    sys.initSys(ctx);
    this.S = makeSchedule(ctx);
    const V = sys.glyphSDF(ctx, sys.stationLetter(ctx, 3));
    const m = 0.01;
    this.box = {
      min: [V.inkX0 - V.inkCx - m, Math.min(V.inkY0, 0) - m, -sys.BALL_R - m],
      max: [V.inkX1 - V.inkCx + m, Math.max(V.inkY1, 1) + m, sys.BALL_R + m],
    };
    const sm = smoothGlyph(V, 3.0);
    this.vU = { uVTex: floatTex(gl, V.w, V.h, sm), uVTexF: V.tex, uVMeta: sys.glyphMeta4(V), uBMin: this.box.min, uBMax: this.box.max };
    // the exact polygon when the glyph is one (Archivo's V is), else the smoothed texture SDF
    this.poly = fitGlyphPolygon(V);
    const SDF_GLSL = makeSdfGlsl(this.poly && this.poly.verts);
    if (this.poly) this.vU.uPoly = polyUniform(this.poly.verts);
    // the outer right edge, extrapolated to the baseline and the cap line (the edge-on silhouette)
    const xa = outerRight(V, sm, 0.15), xb = outerRight(V, sm, 0.85);
    this.edgeR = { x0: xa + (xb - xa) * (0 - 0.15) / 0.7, x1: xa + (xb - xa) * (1 - 0.15) / 0.7 };

    this.map = bakeFloorMap(ctx, this.vU, this.box, SDF_GLSL);

    // Wall: at f384 the wall is VOL_D0 + 3.5 from the eye; k0 = wu per H there.
    const k0 = 2 * Math.tan(sys.VOL_FOV0_RAD / 2) * (sys.VOL_D0 + 3.5);
    this.wallU = { uWall: [k0 / 18, k0 / 1080, 0.80 * k0, k0 / 1080], uCrossV: [0.40 * k0, 0.0] };

    const W = ctx.W, H = ctx.H;
    this.Wh = Math.ceil(W / 2); this.Hh = Math.ceil(H / 2);
    const near = { filter: gl.NEAREST };
    // trace targets: 0 colour + signed depth, 1 (idS, idL, τ, flag), 2 (uvS, uvL): fp32 so wall/floor
    // coordinates keep sub-pixel precision for the full-res grid through the glass
    this.half = ctx.fbo(this.Wh, this.Hh, { ...near, internal: gl.RGBA32F, type: gl.FLOAT, count: 3 });
    this.half2 = ctx.fbo(this.Wh, this.Hh, near);
    this.ref2 = ctx.fbo(W, H, { ...near, internal: gl.RGBA32F, type: gl.FLOAT });
    // refined glass (fp32: alpha = −depth for a hit, −1000 − depth when unresolvable, 0.5 when the ray misses
    // the V, 1 when not refined); ref2 is the filter's ping-pong partner
    this.ref = ctx.fbo(W, H, { ...near, internal: gl.RGBA32F, type: gl.FLOAT });
    this.comp = ctx.fbo(W, H, { ...near, internal: gl.RGBA32F, type: gl.FLOAT, count: 2 });   // fp32: alpha packs depth + streak
    this.grid = ctx.fbo(W, H, near);                    // (studio grid, glass grids S / L, τ)
    this.tileSize = Math.max(8, Math.round(32 * ctx.scale));
    this.Wt = Math.ceil(W / this.tileSize); this.Ht = Math.ceil(H / this.tileSize);
    this.tile = ctx.fbo(this.Wt, this.Ht, near);
    this.tileN = ctx.fbo(this.Wt, this.Ht, near);

    const HEAD = `${ctx.glsl.common}${ctx.glsl.hash}${sys.SYS_GLSL}${SDF_GLSL}${SCENE_GLSL}`;

    // SwiftShader executes every branch of a shader for every pixel, so each pass comes in variants
    // (#defines) and is split by scissor: the objects' screen box (V ∪ ball) runs the full program, the
    // rest of the frame a studio-only one. Variants are compiled on first use.
    this.progs = new Map();
    this.variant = (key, defs, make) => {
      if (!this.progs.has(key)) this.progs.set(key, make(defs.map(d => `#define ${d}\n`).join('')));
      return this.progs.get(key);
    };
    this.traceSrc = defs => `${defs}${HEAD}${SHADE_GLSL}
      uniform vec2 uRes; uniform vec4 uSheet;
      in vec2 vUv;
      layout(location = 0) out vec4 o; layout(location = 1) out vec4 oG; layout(location = 2) out vec4 oH;
      void main(){
        oG = vec4(0.0); oH = vec4(0.0);
        vec2 p = P(vUv, uRes.x / uRes.y);
        vec3 ro = uEye, rd = camDir(p);
        float fz = dot(rd, uCF);
        float pixA = 2.0 * uTanH / uRes.y;
        int id; vec3 nE; float tE = traceEnv(ro, rd, id, nE);
        vec3 pos = ro + rd * tE;
        vec3 col = vec3(0.0);
#ifdef OBJ
        vec3 nB; float tB = traceBall(ro, rd, nB);
        float tS = min(tE, tB);
        float tV = hitV(ro, rd, tS, 0.3 * pixA);
        float th = tV > 0.0 ? tV : tS;
        pos = ro + rd * th;
#endif
        bool skip = uSheet.z > 0.5 && pos.x > uSheet.x + 0.06;     // not yet reached by the sheet: prevTex shows
#ifdef OBJ
        if (tV > 0.0) {
          if (!skip) {
            GP a = glassParts(ro, rd, pos, tV, pixA);
            col = glassCombine(a, vec3(1.0), vec3(1.0));
            oG = vec4(a.idS, a.idL, clamp(luma(col - a.refl) / max(luma(col), 1e-5), 0.0, 1.0), a.flag);
            oH = vec4(a.uvS, a.uvL);
          }
          o = vec4(col, -tV * fz); return;
        }
        if (tB < tE) { if (!skip) col = shadeBall(pos, nB, rd, pixA, tB); o = vec4(col, tB * fz); return; }
#endif
        if (id == 0) { o = vec4(skyCol(rd), 1e4); return; }
        if (!skip) {
          float fw = tE * pixA;
          col = id == 1 ? floorLight(pos, mapLod(sqrt(fw * fw / max(-rd.y, 0.02)))) : cycLight(pos, id);
        }
        o = vec4(col, tE * fz);
      }`;

    // Half-res post, every frame: (a) glass samples whose path totally-internally reflected see an image
    // that changes faster than the half-res grid can resolve (rounded edges act as cylinder lenses): show
    // their local mean (5×5 gaussian over such samples) — the full-res refinement redraws these pixels, the
    // mean only feeds the depth of field and the silhouettes' outer fringe; (b) from 428 the depth-of-field
    // gather: 16 golden-angle taps with a reach test, so sharp foreground never bleeds onto the blurred wall.
    this.dofProg = ctx.program(`${ctx.glsl.common}
      uniform sampler2D uSrc, uFlags; uniform vec2 uRes; uniform float uCocK, uFocus, uCocMax;
      in vec2 vUv; out vec4 o;
      float cocR(float z){ return min(uCocK * abs(1.0 - uFocus / max(z, 1e-3)), uCocMax) * 0.25; }   // half-res px radius
      void main(){
        ivec2 ip = ivec2(gl_FragCoord.xy), hi = ivec2(uRes) - 1;
        vec4 c0 = texelFetch(uSrc, ip, 0);
        if (c0.a < 0.0 && texelFetch(uFlags, ip, 0).w > 0.5) {
          vec3 acc = vec3(0.0); float ws = 0.0;
          for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
            ivec2 q = clamp(ip + ivec2(x, y), ivec2(0), hi);
            vec4 s = texelFetch(uSrc, q, 0);
            float w = exp(-0.35 * float(x * x + y * y)) * step(s.a, 0.0) * (texelFetch(uFlags, q, 0).w > 0.5 ? 1.0 : 0.4);
            acc += s.rgb * w; ws += w;
          }
          o = vec4(acc / max(ws, 1e-6), c0.a); return;
        }
        float R0 = c0.a < 0.0 ? 0.0 : cocR(c0.a);     // the glass V is held in focus (it spans ±0.6 wu of the focus plane)
        if (R0 < 0.3) { o = c0; return; }
        vec3 acc = c0.rgb; float ws = 1.0;
        for (int k = 0; k < 16; k++){
          float fk = float(k);
          float r = R0 * sqrt((fk + 0.5) / 16.0), a = fk * 2.39996323;
          vec2 off = r * vec2(cos(a), sin(a));
          vec4 s = texelFetch(uSrc, clamp(ivec2(floor(gl_FragCoord.xy + off)), ivec2(0), hi), 0);
          float w = clamp((s.a < 0.0 ? 0.0 : cocR(s.a)) - r + 1.0, 0.0, 1.0);    // the sample's own blur reaches us
          acc += s.rgb * w; ws += w;
        }
        o = vec4(acc / ws, c0.a);
      }`, 'volume:halfpost');

    // Full-res glass refinement (scissored to the V's screen box). The decision is taken per 2×2 quad from
    // the 3×3 half-res texels the upsample reads there, so the quad runs in lockstep and dFdx/dFdy of the
    // landing coordinates give each dispersed sample's true (refraction-magnified) footprint on the grid.
    this.refSrc = defs => `${defs}${HEAD}${SHADE_GLSL}
      uniform vec2 uRes; uniform sampler2D uHalf, uHalfG; uniform vec2 uHalfRes;
      uniform vec4 uSheet; uniform float uFull, uAllSS, uS1Hi, uCocK, uFocus, uCocMax; uniform int uSS;
      in vec2 vUv; out vec4 o;
      const float MAG_CHAOS = 3.0;
      float gridAt(float gid, vec2 uv, vec2 fw){
        gLine = vec2(1.7, 1.3);
        float a = gid == 1.0 ? floorGridA(uv, fw, fw) : (gid == 3.0 ? wallGridA(uv, fw, max(fw.x, fw.y), fw) : 0.0);
        gLine = vec2(1.0);
        return a;
      }
      void main(){
        ivec2 hc = ivec2(gl_FragCoord.xy) / 2, hm = ivec2(uHalfRes) - 1;
        float nG = 0.0, flag = 0.0, lmin = 1e9, lmax = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          ivec2 q = clamp(hc + ivec2(x, y), ivec2(0), hm);
          vec4 s = texelFetch(uHalf, q, 0);
          if (s.a < 0.0) { nG += 1.0; float l = luma(s.rgb); lmin = min(lmin, l); lmax = max(lmax, l); flag = max(flag, texelFetch(uHalfG, q, 0).w); }
        }
        bool edgy = nG < 9.0 || flag > 0.5 || lmax - lmin > 0.04 * lmax + 0.004 || uAllSS > 0.5;
        bool need = nG > 0.0 && (uFull > 0.5 || edgy);
        if (!need) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
        vec2 p = P(vUv, uRes.x / uRes.y);
        vec3 ro = uEye, rd = camDir(p);
        float fz = dot(rd, uCF), pixA = 2.0 * uTanH / uRes.y;
        int id; vec3 nE; float tE = traceEnv(ro, rd, id, nE);
        vec3 nB; float tB = traceBall(ro, rd, nB);
        float tV = hitV(ro, rd, min(tE, tB), 0.3 * pixA);
        vec3 pos = ro + rd * max(tV, 0.0);
        float zV = max(tV, 1e-3) * fz;
        bool hit = tV > 0.0 && !(uSheet.z > 0.5 && pos.x > uSheet.x + 0.06);
        GP a; a.refl = vec3(0.0); a.cS = vec3(0.0); a.cL = vec3(0.0); a.k = vec3(0.0); a.idS = 0.0; a.idL = 0.0;
        a.uvS = vec2(0.0); a.uvL = vec2(0.0); a.land = 1.0; a.g = 1.0; a.flag = 0.0; a.dir = rd; a.thru = 0.0;
        if (hit) a = glassParts(ro, rd, pos, tV, pixA);
        // every lane of the quad is here: the landings' spread across the quad = their footprint, and the
        // exit direction's spread (in pixel angles) = how strongly the glass magnifies (a rounded edge seen
        // through the other arm maps half the studio into a few pixels: no sample rate resolves that)
        vec2 fS = abs(dFdx(a.uvS)) + abs(dFdy(a.uvS)), fL = abs(dFdx(a.uvL)) + abs(dFdy(a.uvL));
        // the smaller singular value of the exit direction's screen Jacobian, in pixel angles: a rounded edge
        // magnifies hugely but in one direction only (a coherent, drawable image); only a mapping that
        // explodes in both directions (stacked grazing interfaces) is unresolvable noise
        vec3 jx = dFdx(a.dir), jy = dFdy(a.dir);
        float ja = dot(jx, jx), jb = dot(jx, jy), jc = dot(jy, jy);
        float s1 = sqrt(0.5 * (ja + jc) + sqrt(0.25 * (ja - jc) * (ja - jc) + jb * jb)) / pixA;
        float mag = sqrt(max(0.5 * (ja + jc) - sqrt(0.25 * (ja - jc) * (ja - jc) + jb * jb), 0.0)) / pixA;
        // …and a rounded edge of the far arm seen through the near one (it lies at a grazing angle behind a
        // prism: its one-directional image is already beyond resolving)
        if (a.thru > 0.5 && a.flag > 0.5 && s1 > 40.0) mag = 1e3;
        if (!hit) { o = vec4(0.0, 0.0, 0.0, tV > 0.0 ? 1.0 : 0.5); return; }   // 0.5: the pixel's ray misses the V
        float fp = pixA * a.land;                                     // plain footprint along the path
        float coc = min(uCocK * abs(1.0 - uFocus / max(a.land * fz, 1e-3)), uCocMax);
        vec2 fwS = max(fS, vec2(fp)) * (1.0 + coc), fwL = max(fL, vec2(fp)) * (1.0 + coc);
        vec3 col = glassCombine(a, inkMul(gridAt(a.idS, a.uvS, fwS)), inkMul(gridAt(a.idL, a.uvL, fwL)));
        // supersampling (rotated grid, the centre sample's footprints): the glass maps neighbouring pixels to
        // distant parts of the studio along its edges, bands and prisms; a few rays per pixel integrate that
        // instead of point-sampling it into sparkle
        float wsum = 1.0;
        // rays: 4 (rotated grid) where the half-res samples disagree, 8 (the standard 8× pattern) where the
        // exit direction sweeps many pixel angles per pixel (grazing faces, internal-reflection stripes)
        int nSS = !edgy ? 0 : (s1 > uS1Hi ? 7 : uSS);
        for (int k = 0; k < 7; k++) {
          if (k >= nSS) break;
          vec2 off = (k == 0 ? vec2(1.0, -3.0) : k == 1 ? vec2(-1.0, 3.0) : k == 2 ? vec2(5.0, 1.0) : k == 3 ? vec2(-3.0, -5.0)
                    : k == 4 ? vec2(-5.0, 5.0) : k == 5 ? vec2(-7.0, -1.0) : vec2(3.0, 7.0)) / (16.0 * uRes.y);
          if (nSS < 7) off = (k == 0 ? vec2(0.375, 0.125) : k == 1 ? vec2(-0.125, 0.375) : vec2(-0.375, -0.125)) / uRes.y;
          vec3 rk = camDir(p + off);
          float tk = hitV(ro, rk, min(tE, tB) + 0.05, 0.3 * pixA);
          if (tk <= 0.0) continue;
          GP b = glassParts(ro, rk, ro + rk * tk, tk, pixA);
          col += glassCombine(b, inkMul(gridAt(b.idS, b.uvS, fwS)), inkMul(gridAt(b.idL, b.uvL, fwL)));
          wsum += 1.0;
        }
        col /= wsum;
        o = vec4(col, -zV - (mag > MAG_CHAOS ? 1000.0 : 0.0));   // −1000: unresolvable, the filter averages it
      }`;

    // Refinement filter: where the glass magnifies beyond any sample rate (flagged by −1000 in alpha: a rounded
    // edge seen through the other arm, the stacked prisms of the edge-on arms), a pixel's colour is a random
    // point of the patch it really integrates. Those pixels show the masked gaussian mean (σ 4 px, separable,
    // over flagged neighbours only), a smooth gradient with the patch's true average; crisp paths pass through.
    // Edge-on (uMode 1, 2) the slab's image is a stack of horizontal bands: every structure runs along the
    // screen's y (the path through the V's outline depends on the height only). There the chaos is filtered
    // vertically: (1) a median of 7 rows removes impulses a few rows tall (paths flipping between fold
    // branches) without softening a band edge or any vertical line; (2) unresolvable pixels show the
    // gaussian mean of their column's glass (σ 3 px), i.e. what the pixel really integrates.
    this.refFiltProg = ctx.program(`${ctx.glsl.common}
      uniform sampler2D uRefIn; uniform vec4 uRefRect; uniform vec2 uDir; uniform float uMode; out vec4 o;
      void main(){
        ivec2 ip = ivec2(gl_FragCoord.xy);
        vec4 c = texelFetch(uRefIn, ip, 0);
        ivec2 lo = ivec2(uRefRect.xy), hi = ivec2(uRefRect.zw) - 1, d = ivec2(uDir);
        if (uMode > 2.5) {
          // neighbourhood clamp (every glass pixel): each channel held within its glass neighbours' range, so
          // an isolated dot (a path that alone took another branch) cannot print; edges and 1 px lines, whose
          // neighbours share their value, pass unchanged
          if (c.a >= 0.0) { o = c; return; }
          vec3 mn = vec3(1e9), mx = vec3(-1e9); float n = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            vec4 s = texelFetch(uRefIn, clamp(ip + ivec2(x, y), lo, hi), 0);
            if (s.a < 0.0) { mn = min(mn, s.rgb); mx = max(mx, s.rgb); n += 1.0; }
          }
          o = n >= 3.0 ? vec4(clamp(c.rgb, mn, mx), c.a) : c; return;
        }
        if (uMode > 1.5) {
          // edge-on: every path through the slab is chaotic at the pixel scale (a few ulps of the camera flip a
          // fold or TIR branch); a pixel shows the mean of the glass around it, as its true footprint integral
          // would: ±2 px, or ±4 px where unresolvable. Pixels within 4 px of the silhouette keep their value
          // (the slab's crisp edge lines)
          bool ch = c.a < -500.0;
          if (c.a >= 0.0) { o = c; return; }
          float st = ch ? 2.0 : 1.0, nG = 0.0;
          vec3 acc = vec3(0.0); float ws = 0.0;
          for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
            vec4 s = texelFetch(uRefIn, clamp(ip + ivec2(vec2(x, y) * st), lo, hi), 0);
            float w = s.a < 0.0 ? exp(-float(x * x + y * y) / 4.5) : 0.0;
            acc += s.rgb * w; ws += w;
            nG += texelFetch(uRefIn, clamp(ip + 2 * ivec2(x, y), lo, hi), 0).a < 0.0 ? 1.0 : 0.0;
          }
          vec3 m = acc / max(ws, 1e-6);
          o = vec4(ch || nG > 24.5 ? m : c.rgb, ch ? c.a + 1000.0 : c.a); return;
        }
        if (uMode > 0.5) {
          vec4 sm[7]; float lm[7]; bool allG = true;
          for (int k = 0; k < 7; k++) { sm[k] = texelFetch(uRefIn, clamp(ip + ivec2(0, k - 3), lo, hi), 0); lm[k] = luma(sm[k].rgb) + float(k) * 1e-6; allG = allG && sm[k].a < 0.0; }
          o = c;
          if (!allG) return;
          for (int k = 0; k < 7; k++) {
            int below = 0;
            for (int m = 0; m < 7; m++) below += lm[m] < lm[k] ? 1 : 0;
            if (below == 3) o.rgb = sm[k].rgb;
          }
          return;
        }
        bool chaos = c.a < -500.0;
        if (!chaos && c.a < 0.0 && uDir.x > 0.5) {
          // clean pixels inside an unresolvable patch: the flag comes from per-quad derivatives, so the patch is
          // ragged; a pixel with ≥ 6 flagged pixels in its 5×5 neighbourhood (or a flagged 4-neighbour and a
          // colour unlike theirs) belongs to it
          float nC = 0.0, n4 = 0.0; vec3 m = vec3(0.0);
          for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
            vec4 q = texelFetch(uRefIn, clamp(ip + ivec2(x, y), lo, hi), 0);
            float fl = q.a < -500.0 ? 1.0 : 0.0;
            nC += fl;
            if (abs(x) + abs(y) == 1) { n4 += fl; m += q.rgb * fl; }
          }
          m /= max(n4, 1.0);
          if (nC >= 4.0 || (n4 >= 1.0 && length(c.rgb - m) > 0.12 * length(m) + 0.01)) { chaos = true; c.a -= 1000.0; }
        }
        if (!chaos) { o = c; return; }
        vec3 acc = vec3(0.0); float ws = 0.0;
        for (int k = -10; k <= 10; k++) {
          vec4 s = texelFetch(uRefIn, clamp(ip + d * k, lo, hi), 0);
          float w = (s.a < -500.0 || k == 0) ? exp(-float(k * k) / 32.0) : 0.0;
          acc += s.rgb * w; ws += w;
        }
        o = vec4(acc / ws, uDir.y > 0.5 ? c.a + 1000.0 : c.a);   // the second (vertical) pass decodes the depth
      }`, 'volume:refinefilter');

    // Composite (full-res). Order matters for SwiftShader, whose JIT spills badly when much state is live:
    // the grids come first (from the studio hit and the glass samples' landing data), then the colours.
    this.compSrc = (defs = '') => `${defs}
${HEAD}
      uniform vec2 uRes; uniform sampler2D uHalf; uniform sampler2D uHalfG; uniform sampler2D uHalfH; uniform vec2 uHalfRes;
      uniform sampler2D uPrev; uniform float uHasPrev; uniform sampler2D uGrid; uniform sampler2D uRef; uniform vec4 uRefRect;
      uniform vec4 uSheet; uniform float uSheetFade; uniform float uCocK, uFocus, uCocMax, uMB, uMotionK, uOutline;
      uniform vec4 uOutA, uOutB; uniform float uOutR;
      in vec2 vUv;
      layout(location = 0) out vec4 o;
      layout(location = 1) out vec4 oVel;
      // Screen velocity (px over the shutter, t − ¼ → t + ¼ frame). uM*: world → (x/2th, y/2th, depth) rows.
      uniform mat3 uM0, uM1; uniform vec3 uEye0, uEye1; uniform vec4 uCycK; uniform vec3 uBall0, uBall1;
      vec2 scr(mat3 M, vec3 eye, vec3 p){ vec3 q = M * (p - eye); return q.xy / max(q.z, 1e-4); }
      vec2 velWorld(vec3 p){ return (scr(uM1, uEye1, p) - scr(uM0, uEye0, p)) * uRes.y; }
      vec2 velBall(vec3 p){ return (scr(uM1, uEye1, p - uBall.xyz + uBall1) - scr(uM0, uEye0, p - uBall.xyz + uBall0)) * uRes.y; }
      // the cyc is camera-locked: only its distance (D + s) and the FOV change
      vec2 velCyc(vec3 p){ float s = dot(p.xz, uFh); return vec2(dot(p, uCR), p.y - LOOKY) * (1.0 / ((uCycK.z + s) * uCycK.w) - 1.0 / ((uCycK.x + s) * uCycK.y)) * uRes.y; }
      // Light sheet at x = P = uSheet.x (P(f − 1) = uSheet.y, P(f − 0.3) = uSheet.w): a crisp VERM contour on
      // every surface, lit world behind it. The last 0.3 frame of travel is a faint blade behind the contour
      // (rising towards it, ≤ 0.16 of the core), so the fast sweep reads as a moving edge, never as stepped
      // lines or a pink wash; behind it the studio is fully lit at once.
      float sheetLit(float x, float fw){ return clamp((uSheet.x - x) / fw + 0.5, 0.0, 1.0); }
      float sheetWarm(float x){ return 1.0; }
      float sheetLine(float x){
        float u = (x - uSheet.x) / 0.012, t = clamp((x - uSheet.w) / max(uSheet.x - uSheet.w, 1e-4), 0.0, 1.0);
        float blade = t * t * (x > uSheet.x ? exp(-u * u) : 1.0);
        return max(exp(-u * u), 0.16 * blade) * uSheetFade;
      }
      // V coverage of a full-res ray near the silhouette: min SDF along the ray, in pixels.
      float coverV(vec3 ro, vec3 rd, float t0, float t1, float pixA){
        vec2 b = vBox(ro, rd);
        float t = max(max(b.x, t0), 0.0), te = min(b.y, t1);
        if (t >= te) return 0.0;
        float mn = 1e9;
        for (int i = 0; i < 28; i++){
          float px = t * pixA, d = sdVF(ro + rd * t);
          mn = min(mn, d / px);
          if (mn < -1.0) break;
          t += max(d, 0.4 * px);
          if (t > te) break;
        }
        return clamp(0.5 - mn, 0.0, 1.0);
      }
      // Grid seen through the glass, from the dispersed exit rays' landing coordinates of the V samples
      // (S: IOR 1.53 = g.x / h.xy, else IOR 1.47 = g.y / h.zw). Footprint = spread of neighbouring landings,
      // i.e. the true (refraction-compressed) one.
      float refrGridA(vec4 g0, vec4 g1, vec4 g2, vec4 g3, vec4 h0, vec4 h1, vec4 h2, vec4 h3, vec4 wv, bool S, float fwMin, float coc){
        vec4 ids = S ? vec4(g0.x, g1.x, g2.x, g3.x) : vec4(g0.y, g1.y, g2.y, g3.y);
        vec2 u0 = S ? h0.xy : h0.zw, u1 = S ? h1.xy : h1.zw, u2 = S ? h2.xy : h2.zw, u3 = S ? h3.xy : h3.zw;
        float b = wv.x, gid = ids.x;
        if (wv.y > b) { b = wv.y; gid = ids.y; }
        if (wv.z > b) { b = wv.z; gid = ids.z; }
        if (wv.w > b) { b = wv.w; gid = ids.w; }
        if (gid != 1.0 && gid != 3.0) return 0.0;
        vec4 m = vec4(equal(ids, vec4(gid))) * step(vec4(1e-9), wv), mw = m * wv;
        vec2 uv = (u0 * mw.x + u1 * mw.y + u2 * mw.z + u3 * mw.w) / max(dot(mw, vec4(1.0)), 1e-9);
        const vec2 BIG = vec2(1e9);
        vec2 lo = min(min(mix(BIG, u0, m.x), mix(BIG, u1, m.y)), min(mix(BIG, u2, m.z), mix(BIG, u3, m.w)));
        vec2 hi = max(max(mix(-BIG, u0, m.x), mix(-BIG, u1, m.y)), max(mix(-BIG, u2, m.z), mix(-BIG, u3, m.w)));
        vec2 fw = (dot(m, vec4(1.0)) > 1.5 ? max((hi - lo) * 0.5, vec2(fwMin)) : vec2(2.0 * fwMin)) * (1.0 + coc);
        float a = 0.0;
        if (gid == 1.0) a = floorGridA(uv, fw, fw);
        if (gid == 3.0) a = wallGridA(uv, fw, max(fw.x, fw.y), vec2(fwMin));
        return a;
      }
      // one half-res neighbour: glass (signed depth < 0), ball (depth ≈ the ball's) or studio
      void classify(vec4 s, float w, float zB, inout vec3 cV, inout vec3 cB, inout vec3 cE, inout vec4 acc, inout float zV, inout float zVmin){
        if (s.a < 0.0) { cV += s.rgb * w; acc.x += w; zV += -s.a * w; zVmin = min(zVmin, -s.a); acc.w += 1.0; }
        else if (abs(s.a - zB) < 0.25) { cB += s.rgb * w; acc.y += w; }
        else { cE += s.rgb * w; acc.z += w; }
      }
      float cross2(vec2 a, vec2 b){ return a.x * b.y - a.y * b.x; }
      float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
      void main(){
        vec2 p = P(vUv, uRes.x / uRes.y);
        vec3 ro = uEye, rd = camDir(p);
        float fz = dot(rd, uCF), pixA = 2.0 * uTanH / uRes.y;
        int id; vec3 nE; float tE = traceEnv(ro, rd, id, nE);
        float zE = id == 0 ? 1e4 : tE * fz;
        vec3 posE = ro + rd * tE;
        float coc = min(uCocK * abs(1.0 - uFocus / zE), uCocMax);
        vec2 velE = uMB > 0.5 ? ((id == 2 || id == 3) ? velCyc(posE) : velWorld(posE)) : vec2(0.0);
        vec2 hp = gl_FragCoord.xy * 0.5 - 0.5; vec2 i0 = floor(hp); vec2 fr = hp - i0;
        ivec2 hm = ivec2(uHalfRes) - 1, b0 = ivec2(i0);
        ivec2 q0 = clamp(b0, ivec2(0), hm), q1 = clamp(b0 + ivec2(1, 0), ivec2(0), hm), q2 = clamp(b0 + ivec2(0, 1), ivec2(0), hm), q3 = clamp(b0 + ivec2(1, 1), ivec2(0), hm);
        vec4 wk = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y) + 1e-4;
        ivec2 ip = ivec2(gl_FragCoord.xy);
        bool inRef = gl_FragCoord.x >= uRefRect.x && gl_FragCoord.y >= uRefRect.y && gl_FragCoord.x < uRefRect.z && gl_FragCoord.y < uRefRect.w;
        vec4 rf = inRef ? texelFetch(uRef, ip, 0) : vec4(0.0, 0.0, 0.0, 1.0);
#ifdef GRIDPASS
        // 1. the studio's own grid: box filter = pixel footprint (ray differentials) + CoC + part of the motion
        float gE = 0.0;
        if (id == 1 || id == 3) {
          vec3 rdx = camDir(p + vec2(1.0 / uRes.y, 0.0)), rdy = camDir(p + vec2(0.0, 1.0 / uRes.y));
          vec3 px_, py_;
          if (id == 1) { px_ = ro + rdx * (-ro.y / min(rdx.y, -1e-5)); py_ = ro + rdy * (-ro.y / min(rdy.y, -1e-5)); }
          else { float so = dot(ro.xz, uFh);
                 px_ = ro + rdx * ((CYC1 - so) / dot(rdx.xz, uFh)); py_ = ro + rdy * ((CYC1 - so) / dot(rdy.xz, uFh)); }
          vec2 w0 = id == 1 ? posE.xz : wallUV(posE);
          vec2 dx = (id == 1 ? px_.xz : wallUV(px_)) - w0, dy = (id == 1 ? py_.xz : wallUV(py_)) - w0;
          vec2 pxw = min(max(abs(dx), abs(dy)), vec2(1.0));
          vec2 fw = pxw * (1.0 + coc) + abs(dx * velE.x + dy * velE.y) * uMotionK;
          if (id == 1) gE = floorGridA(w0, fw, pxw);
          if (id == 3) gE = wallGridA(w0, fw, max(pxw.x, pxw.y), pxw);
        }
        float gS = 1.0, gL = 1.0, tau = 0.0;
#ifdef OBJ
        // 2. the grid through the (unrefined) glass, from the glass samples' landing data
        vec4 al = vec4(texelFetch(uHalf, q0, 0).a, texelFetch(uHalf, q1, 0).a, texelFetch(uHalf, q2, 0).a, texelFetch(uHalf, q3, 0).a);
        vec4 wv = wk * vec4(lessThan(al, vec4(0.0)));
        if (dot(wv, vec4(1.0)) > 0.0 && rf.a >= 0.0) {
          vec4 g0 = texelFetch(uHalfG, q0, 0), g1 = texelFetch(uHalfG, q1, 0), g2 = texelFetch(uHalfG, q2, 0), g3 = texelFetch(uHalfG, q3, 0);
          vec4 h0 = texelFetch(uHalfH, q0, 0), h1 = texelFetch(uHalfH, q1, 0), h2 = texelFetch(uHalfH, q2, 0), h3 = texelFetch(uHalfH, q3, 0);
          float ws = dot(wv, vec4(1.0));
          tau = dot(vec4(g0.z, g1.z, g2.z, g3.z), wv) / ws;
          float fwMin = pixA * (-dot(al, wv) / ws / fz + 3.5);
          gS = 1.0 - 0.995 * refrGridA(g0, g1, g2, g3, h0, h1, h2, h3, wv, true, fwMin, coc);
          gL = 1.0 - 0.995 * refrGridA(g0, g1, g2, g3, h0, h1, h2, h3, wv, false, fwMin, coc);
        }
#endif
        o = vec4(gE, gS, gL, tau); oVel = vec4(0.0);
#else
        vec4 gq = uGridK > 0.0 ? texelFetch(uGrid, ip, 0) : vec4(0.0, 1.0, 1.0, 0.0);
        float gE = gq.x, gS = gq.y, gL = gq.z, tau = gq.w;
        vec4 s0 = texelFetch(uHalf, q0, 0), s1 = texelFetch(uHalf, q1, 0), s2 = texelFetch(uHalf, q2, 0), s3 = texelFetch(uHalf, q3, 0);
#ifndef OBJ
        // outside the objects' box every half-res neighbour is studio: plain bilinear upsample
        vec3 col = (s0.rgb * wk.x + s1.rgb * wk.y + s2.rgb * wk.z + s3.rgb * wk.w) / dot(wk, vec4(1.0)) * inkMul(gE);
        vec3 sp = posE; vec2 vel = uMB < 0.5 ? vec2(0.0) : velE; float zF = zE;
#else
        // 3. the ball, analytic and antialiased from the ray's closest approach
        vec3 bs = uBallS * uBall.w;
        vec3 oc = (ro - uBall.xyz) / bs, dd = rd / bs;
        float tc = max(-dot(oc, dd) / dot(dd, dd), 1e-3);
        float covB = clamp(0.5 - (length(oc + dd * tc) - 1.0) * uBall.w / (tc * pixA), 0.0, 1.0);
        vec3 nB; float tBh = traceBall(ro, rd, nB);
        float tB = tBh < 1e8 ? tBh : tc;
        float zB = tB * fz;
        if (tB > tE) covB = 0.0;
        // 4. colours by class: glass / ball / studio
        vec3 cV = vec3(0.0), cB = vec3(0.0), cE = vec3(0.0);
        vec4 acc = vec4(0.0);                                   // weights of glass, ball, studio; glass count
        float zV = 0.0, zVmin = 1e9;
        classify(s0, wk.x, zB, cV, cB, cE, acc, zV, zVmin);
        classify(s1, wk.y, zB, cV, cB, cE, acc, zV, zVmin);
        classify(s2, wk.z, zB, cV, cB, cE, acc, zV, zVmin);
        classify(s3, wk.w, zB, cV, cB, cE, acc, zV, zVmin);
        float wV = acc.x, wB = acc.y, wE = acc.z; int nV = int(acc.w + 0.5);
        vec3 colA = (s0.rgb * wk.x + s1.rgb * wk.y + s2.rgb * wk.z + s3.rgb * wk.w) / dot(wk, vec4(1.0));
        vec3 col = (wE > 1e-3 ? cE / wE : colA) * inkMul(gE);
        vec3 colB = wB > 1e-3 ? cB / wB : colA;
        vec3 colV = wV > 1e-3 ? cV / wV : colA;
        zV = wV > 1e-3 ? zV / wV : 1e9;
        bool refHit = rf.a < 0.0;
        if (refHit) { colV = rf.rgb; zV = -rf.a; zVmin = min(zVmin, zV); }
        else if (nV > 0) {                     // the grid through the glass, crisp and split on the VERM–COBALT axis
          vec3 Tc = colV * tau;
          colV = colV - Tc + dispAxis(Tc * gS, Tc * gL, 1.0);
        }
        bool refMiss = inRef && abs(rf.a - 0.5) < 0.25;
        float covV = nV == 4 && !refMiss ? 1.0 : 0.0;
        if ((nV > 0 || refHit) && (nV < 4 || refMiss))
          covV = coverV(ro, rd, zVmin / fz - 0.25, min(tE, tBh) + 0.05, pixA);
        bool vFront = zV < zB;
        bool isV = covV >= 0.5 && (vFront || covB < 0.5);
        bool isB = !isV && covB >= 0.5;
        vec3 sp = isV ? ro + rd * (zV / fz) : (isB ? ro + rd * tB : posE);
        vec2 vel = uMB < 0.5 ? vec2(0.0) : (isB ? velBall(sp) : (isV ? velWorld(sp) : velE));
        // the glass is blurred less than the studio (its refractions would smear into ghost lines): half its
        // streak, at most 16 px, so at peak yaw it still reads as refraction rather than smear
        if (isV) { float lv = length(vel); vel *= min(0.5, 16.0 / max(lv, 1e-3)); }
        if (vFront) {
          col = mix(col, colB, covB);
          // blackout: the glass is a dark filter over what is behind it (the ball's underside shows through
          // the slab's top band, straight through, COBALT-tinted), plus its own reflections
          if (uTransmit < 0.5) colV += (col - INK) * exp(-glassSigma() * 0.9) * 0.85;
          col = mix(col, colV, covV);
        } else { col = mix(col, colV, covV); col = mix(col, colB, covB); }
#ifdef OUTLINE
        // blackout, edge-on: the COBALT rim outlines the slab. One analytic silhouette (the projected, rounded
        // edge-on slab: its nearest outer edge, the top and the floor line), a constant 3 px core just inside
        // it and a short inner glow; the floor line is fainter and the sides end square on it.
        if (uOutline > 0.0) {
          vec2 fp = gl_FragCoord.xy, A = uOutA.xy, B = uOutA.zw, C = uOutB.xy, D = uOutB.zw;   // BL, TL, TR, BR
          float dS = min(min(sdSeg(fp, A, B), sdSeg(fp, B, C)), sdSeg(fp, C, D)), dF = sdSeg(fp, D, A);
          float s1 = cross2(B - A, fp - A), s2 = cross2(C - B, fp - B), s3 = cross2(D - C, fp - C), s4 = cross2(A - D, fp - D);
          bool inside = (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0 && s4 <= 0.0) || (s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0 && s4 >= 0.0);
          float sd = (inside ? -min(dS, dF) : min(dS, dF)) - uOutR;
          float wEdge = mix(0.3, 1.0, smoothstep(-1.0, 1.0, dF - dS));
          float core = clamp(sd + 3.5, 0.0, 1.0) * clamp(0.5 - sd, 0.0, 1.0);
          float glow = sd < 0.0 ? 0.10 * exp(sd / 7.0) : 0.0;
          // the core sits at ≈ 1.1·COBALT (tone-mapped near the token, not whitened); bloom carries the glow
          col += COBALT * (0.55 * uLight.z * uOutline * wEdge) * (0.92 * core + glow);
        }
#endif
        float zF = isV ? zV : (isB ? zB : zE);
#endif
        // the light sheet: lit 3D where x < P, prevTex (lens) elsewhere, VERM contour on every surface
#ifdef SHEET
        {
          float xs = sp.x, fwx = 1.5 * pixA * length(sp - ro);
          vec3 prev = uHasPrev > 0.5 ? texelFetch(uPrev, ip, 0).rgb : INK;
          col = mix(prev, col * sheetWarm(xs), sheetLit(xs, fwx)) + VERM * (2.0 * sheetLine(xs));
        }
#endif
        // alpha packs depth (1/256 wu) and the half-extent streak length (px) for the motion blur taps
        o = vec4(col, uMB > 0.5 ? floor(min(zF, 60.0) * 256.0) * 128.0 + min(floor(length(vel) * 0.5 + 0.5), 127.0) : 1.0);
        oVel = vec4(vel, 0.0, 1.0);
#endif
      }`;
    // two programs from one source: the grids (a small live set) and the colours; one big shader spills

    this.tileProg = ctx.program(`
      uniform sampler2D uVel; uniform float uTile; uniform vec2 uSrcRes; out vec4 o;
      void main(){
        ivec2 t = ivec2(gl_FragCoord.xy); int ts = int(uTile);
        vec2 best = vec2(0.0); float bl = 0.0;
        for (int y = 0; y < 64; y += 2) { if (y >= ts) break;
          for (int x = 0; x < 64; x += 2) { if (x >= ts) break;
            vec2 v = texelFetch(uVel, min(t * ts + ivec2(x, y), ivec2(uSrcRes) - 1), 0).xy;
            float l = dot(v, v); if (l > bl) { bl = l; best = v; } } }
        o = vec4(best, 0.0, 1.0);
      }`, 'volume:tilemax');
    this.nbrProg = ctx.program(`
      uniform sampler2D uTileTex; uniform vec2 uRes; out vec4 o;
      void main(){
        ivec2 t = ivec2(gl_FragCoord.xy); vec2 best = vec2(0.0); float bl = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 v = texelFetch(uTileTex, clamp(t + ivec2(x, y), ivec2(0), ivec2(uRes) - 1), 0).xy;
          float l = dot(v, v); if (l > bl) { bl = l; best = v; } }
        o = vec4(best, 0.0, 1.0);
      }`, 'volume:neighbourmax');
    this.mbProg = ctx.program(`${ctx.glsl.common}
      uniform sampler2D uCol, uTileN, uVel; uniform vec2 uRes; uniform float uTile;
      out vec4 o;
      float cone(float d, float v){ return clamp(1.0 - d / v, 0.0, 1.0); }
      float cyl(float d, float v){ return 1.0 - smoothstep(0.95 * v, 1.05 * v, d); }
      float zcmp(float za, float zb){ return clamp(1.0 - (za - zb) / (0.03 * zb + 0.02), 0.0, 1.0); }   // 1: a in front of b
      void main(){
        ivec2 ip = ivec2(gl_FragCoord.xy);
        vec4 cX = texelFetch(uCol, ip, 0);
        // interleaved gradient noise: well-spread tap offsets, no per-pixel white-noise stitching on edges
        float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
        float j2 = fract(52.9829189 * fract(dot(gl_FragCoord.yx + 17.0, vec2(0.06711056, 0.00583715)))) - 0.5;
        // the tile lookup is jittered by up to ±¼ tile, so tile borders dissolve instead of printing as steps
        ivec2 tq = clamp(ivec2(floor((gl_FragCoord.xy + vec2(j, j2) * 0.5 * uTile) / uTile)), ivec2(0), ivec2(ceil(uRes / uTile)) - 1);
        vec2 vN = texelFetch(uTileN, tq, 0).xy * 0.5;             // half extents (px)
        float lN = length(vN);
        if (lN < 0.5) { o = vec4(cX.rgb, 1.0); return; }
        float lX = max(mod(cX.a, 128.0), 0.5), zX = floor(cX.a / 128.0) / 256.0;
        // a pixel that moves about as fast as its neighbourhood streaks along its own motion (fast glass
        // edges: no combing by the tile's direction); a slow one gathers along the neighbourhood's
        vec2 vX = texelFetch(uVel, ip, 0).xy * 0.5;
        vN = mix(vN, vX, smoothstep(0.4, 0.8, length(vX) / lN));
        lN = max(length(vN), 0.5);
        float ws = 1.0 / lX; vec3 acc = cX.rgb * ws;
        int n = int(clamp(ceil(lN / 1.5), 6.0, 12.0));          // taps ~ every 3 px of streak, at least 6
        float fn = float(n);
        for (int i = 0; i < 12; i++){
          if (i >= n) break;
          float t = mix(-1.0, 1.0, (float(i) + 0.5 + j) / fn);
          vec2 off = vN * t;
          vec4 cY = texelFetch(uCol, clamp(ivec2(floor(gl_FragCoord.xy + off)), ivec2(0), ivec2(uRes) - 1), 0);
          float lY = max(mod(cY.a, 128.0), 0.5), zY = floor(cY.a / 128.0) / 256.0;
          float d = length(off);
          float a = zcmp(zY, zX) * cone(d, lY) + zcmp(zX, zY) * cone(d, lX) + cyl(d, lY) * cyl(d, lX) * 2.0;
          acc += cY.rgb * a; ws += a;
        }
        o = vec4(acc / ws, 1.0);
      }`, 'volume:motionblur');
  },

  // Uniforms of the scene at in-shot frame f (fractional allowed).
  sceneUniforms(ctx, f, fi) {
    const S = this.S, c = S.cam(f), b = S.ball(f), L = S.lights(fi);
    return {
      ...this.vU, ...this.wallU,
      uEye: c.eye, uCR: c.R, uCU: c.U, uCF: c.F, uTanH: c.th, uFh: [c.F[0], c.F[2]],
      uBall: [...b.c, b.r], uBallS: b.s,
      uLight: [L.amb, L.key, L.rim, L.spot],
      uKeyCyc: turn(sys.KEY3, c.yaw), uRimDir: turn(RIM_DIR, c.yaw), uFill: fi >= T.BLACK ? 0 : S.fill(c.yaw),
      uMap: this.map.tex, uMapRect: this.map.rect, uMapTexel: this.map.texel,
      uCausK: 1.4, uGridK: fi >= T.BLACK ? 0 : 1, uCrossCoc: 3.0, uRimLobe: fi >= T.BLACK ? 0.2 : 0.72, uTransmit: fi >= T.BLACK ? 0 : 1,
      ...sys.sysUniforms(ctx),
    };
  },

  // The V's box on screen (gl_FragCoord px, even-aligned so 2×2 quads stay whole), and its area fraction.
  vRect(ctx, c) {
    const { min, max } = this.box;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
      const q = project(ctx, c, [x, y, z]);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const pad = 4;
    x0 = Math.max(0, 2 * Math.floor((x0 - pad) / 2)); y0 = Math.max(0, 2 * Math.floor((y0 - pad) / 2));
    x1 = Math.min(ctx.W, 2 * Math.ceil((x1 + pad) / 2)); y1 = Math.min(ctx.H, 2 * Math.ceil((y1 + pad) / 2));
    return { x0, y0, x1, y1, frac: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / (ctx.W * ctx.H) };
  },

  // The edge-on slab's silhouette (blackout outline): the rounded box's inset corners projected (BL, TL,
  // TR, BR in gl_FragCoord px) and the rounding radius in px. The nearest outer edge (the V's right outer
  // edge at yaw 90°) bounds the sides; the top is the nearest top corner; the bottom is the floor line.
  outline(ctx, c) {
    const { x0, x1 } = this.edgeR, r = V_RND, hz = V_HZ - r;
    const bl = project(ctx, c, [x0 - r, r, hz]), tl = project(ctx, c, [x1 - r, 1 - r, hz]);
    const tr = project(ctx, c, [x1 - r, 1 - r, -hz]), br = project(ctx, c, [x0 - r, r, -hz]);
    const pxPerWu = ctx.H / (2 * c.th * tl[2]);
    return { uOutA: [bl[0], bl[1], tl[0], tl[1]], uOutB: [tr[0], tr[1], br[0], br[1]], uOutR: r * pxPerWu - 2.5 };   // the rim line sits 2.5 px inside the rounded silhouette: its glow then ends at ≈ ±0.073 H
  },

  // The objects' screen box: the V's box ∪ the ball's (with its stretch), as vRect.
  objRect(ctx, c, b) {
    const R = this.vRect(ctx, c);
    const e = [b.r * b.s[0] + 0.01, b.r * b.s[1] + 0.01, b.r * b.s[2] + 0.01];
    let x0 = R.x0, y0 = R.y0, x1 = R.x1, y1 = R.y1;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const q = project(ctx, c, [b.c[0] + sx * e[0], b.c[1] + sy * e[1], b.c[2] + sz * e[2]]);
      x0 = Math.min(x0, q[0] - 4); x1 = Math.max(x1, q[0] + 4); y0 = Math.min(y0, q[1] - 4); y1 = Math.max(y1, q[1] + 4);
    }
    x0 = Math.max(0, 2 * Math.floor(x0 / 2)); y0 = Math.max(0, 2 * Math.floor(y0 / 2));
    x1 = Math.min(ctx.W, 2 * Math.ceil(x1 / 2)); y1 = Math.min(ctx.H, 2 * Math.ceil(y1 / 2));
    return { x0, y0, x1, y1 };
  },
  // Draw `inner` inside rect R (scissored) and `outer` over the rest of a w×h target (up to four strips).
  drawSplit(ctx, inner, outer, uniforms, target, R, w, h) {
    const gl = ctx.gl;
    gl.enable(gl.SCISSOR_TEST);
    const strips = [[0, 0, w, R.y0], [0, R.y1, w, h - R.y1], [0, R.y0, R.x0, R.y1 - R.y0], [R.x1, R.y0, w - R.x1, R.y1 - R.y0]];
    for (const [x, y, sw, sh] of strips) {
      if (sw <= 0 || sh <= 0) continue;
      gl.scissor(x, y, sw, sh); ctx.draw(outer, uniforms, target);
    }
    if (R.x1 > R.x0 && R.y1 > R.y0) { gl.scissor(R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0); ctx.draw(inner, uniforms, target); }
    gl.disable(gl.SCISSOR_TEST);
  },

  render(ctx, s) {
    const gl = ctx.gl;
    const prev = s.prevTex;          // lens (tail) during 384–395; null afterwards
    const S = this.S, f = s.f, fi = s.fi;
    const u = this.sceneUniforms(ctx, f, fi);
    const c = S.cam(f), c0 = S.cam(f - 0.25), c1 = S.cam(f + 0.25);
    const b = S.ball(f), b0 = S.ball(f - 0.25), b1 = S.ball(f + 0.25);
    const sheetOn = fi < T.SHEET1 ? 1 : 0;
    const sheet = [S.sheetP(f), S.sheetP(f - 1), sheetOn, S.sheetP(f - 0.3)];
    const black = fi >= T.BLACK;
    const V = (name, src, defs) => this.variant(name + ':' + defs.join(','), defs, d => ctx.program(src(d), 'volume:' + name));

    // the objects' box (full res) and its half-res twin; the V's own box for the glass refinement
    const O = this.objRect(ctx, c, b);
    const Oh = { x0: O.x0 / 2, y0: O.y0 / 2, x1: Math.min(this.Wh, O.x1 / 2), y1: Math.min(this.Hh, O.y1 / 2) };

    // 1. half-res trace
    const lit = black ? ['BLACKOUT'] : [];
    this.drawSplit(ctx, V('trace', this.traceSrc, ['OBJ', ...lit]), V('trace', this.traceSrc, lit), { ...u, uSheet: sheet }, this.half, Oh, this.Wh, this.Hh);

    // 2. half-res post + DOF: CoC(z) = K·|1 − D/z| (px, diameter), K set so the wall (D + 3.5) gets cocWall
    const cw = S.cocWall(f) * ctx.scale;
    const cocK = cw * (c.D + 3.5) / 3.5, cocMax = 24 * ctx.scale;
    const dof = { uCocK: cw > 0.05 ? cocK : 0, uFocus: c.D, uCocMax: cocMax };
    ctx.draw(this.dofProg, { uSrc: this.half.texs[0], uFlags: this.half.texs[1], ...dof }, this.half2);

    // 3. full-res glass refinement: every pixel near the glass, inside the V's screen box; then the filters:
    // the unresolvable pixels' masked mean (edge-on: a vertical median, then every interior slab pixel's
    // footprint mean) and a neighbourhood clamp that no isolated dot survives
    const R = this.vRect(ctx, c);
    const refRect = [R.x0, R.y0, R.x1, R.y1];
    const edgeOn = c.yaw >= 78;
    let refTex = this.ref.tex;
    if (R.x1 > R.x0 && R.y1 > R.y0) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0);
      ctx.draw(V('refine', this.refSrc, lit), { ...u, uHalf: this.half.texs[0], uHalfG: this.half.texs[1], uHalfRes: [this.Wh, this.Hh],
        uSheet: sheet, uFull: 1, uSS: 3, uS1Hi: 6, uAllSS: edgeOn && !black ? 1 : 0, ...dof }, this.ref);
      if (edgeOn) {
        ctx.draw(this.refFiltProg, { uRefIn: this.ref.tex, uRefRect: refRect, uDir: [0, 1], uMode: 1 }, this.ref2);
        ctx.draw(this.refFiltProg, { uRefIn: this.ref2.tex, uRefRect: refRect, uDir: [0, 1], uMode: 2 }, this.ref);
      } else {
        ctx.draw(this.refFiltProg, { uRefIn: this.ref.tex, uRefRect: refRect, uDir: [1, 0], uMode: 0 }, this.ref2);
        ctx.draw(this.refFiltProg, { uRefIn: this.ref2.tex, uRefRect: refRect, uDir: [0, 1], uMode: 0 }, this.ref);
      }
      ctx.draw(this.refFiltProg, { uRefIn: this.ref.tex, uRefRect: refRect, uDir: [0, 1], uMode: 3 }, this.ref2);
      refTex = this.ref2.tex;
      gl.disable(gl.SCISSOR_TEST);
    }

    // 4. grid, 5. composite (+ velocity when anything moves)
    const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const moving = d3(c0.eye, c1.eye) > 1e-6 || Math.abs(c0.th - c1.th) > 1e-7 || d3(b0.c, b1.c) > 1e-6 || Math.abs(b0.s[1] - b1.s[1]) > 1e-6;
    const outl = black ? this.outline(ctx, c) : { uOutA: [0, 0, 0, 0], uOutB: [0, 0, 0, 0], uOutR: 0 };
    const comp = {
      ...u, uHalf: this.half2.tex, uHalfG: this.half.texs[1], uHalfH: this.half.texs[2], uHalfRes: [this.Wh, this.Hh],
      uRef: refTex, uRefRect: refRect,
      uPrev: prev, uHasPrev: prev ? 1 : 0, uSheet: sheet, uSheetFade: 1,
      ...dof, uMB: moving ? 1 : 0, uMotionK: 0.3,
      uEye0: c0.eye, uEye1: c1.eye, uM0: camMat(c0), uM1: camMat(c1), uCycK: [c0.D, 2 * c0.th, c1.D, 2 * c1.th],
      uBall0: b0.c, uBall1: b1.c,
      uOutline: black ? ctx.ease.smoothstep(80, 89.5, c.yaw) : 0, ...outl,
    };
    if (u.uGridK > 0)   // the blackout has no grids: Bone renders as Ink
      this.drawSplit(ctx, V('grid', this.compSrc, ['GRIDPASS', 'OBJ']), V('grid', this.compSrc, ['GRIDPASS']), comp, this.grid, O, ctx.W, ctx.H);
    comp.uGrid = this.grid.tex;
    const cdefs = [...(sheetOn ? ['SHEET'] : []), ...(black ? ['OUTLINE'] : [])];
    const compIn = V('comp', this.compSrc, ['OBJ', ...cdefs]), compOut = V('comp', this.compSrc, cdefs);
    if (!moving) {
      this.drawSplit(ctx, compIn, compOut, comp, s.target, O, ctx.W, ctx.H);
    } else {
      this.drawSplit(ctx, compIn, compOut, comp, this.comp, O, ctx.W, ctx.H);
      // 6. motion blur
      const vel = this.comp.texs[1];
      ctx.draw(this.tileProg, { uVel: vel, uTile: this.tileSize, uSrcRes: [ctx.W, ctx.H] }, this.tile);
      ctx.draw(this.nbrProg, { uTileTex: this.tile.tex }, this.tileN);
      ctx.draw(this.mbProg, { uCol: this.comp.texs[0], uVel: vel, uTileN: this.tileN.tex, uTile: this.tileSize }, s.target);
    }
    ctx.setPost(s, { bloom: S.bloom(fi), vignette: 0.16 });
  },
};
