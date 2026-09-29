// volume: floor-space light map, baked once at init (the V and the key light never move).
//   r: caustic of rays refracted through the V at IOR 1.53 (short λ)   } normalised irradiance
//   g: caustic at IOR 1.47 (long λ)                                     } (1 = unobstructed key)
//   b: the V's soft shadow as an opaque occluder (area key, k = 10)
//   a: contact AO of the V on the floor
// Caustics: 512² rays from KEY3 through the V's SDF on the GPU (entry march, refract, inner march,
// refract out, a second arm if hit, intersect y = 0), splatted as additive gl.POINTS whose normalised
// gaussian follows each ray's own landing footprint (≥ 0.8 texel: the 1–2 px blur of §5.5), so focused
// light stays a sharp caustic line while neither the ray lattice nor lone scattered rays ever show.
// Per frame the whole thing costs one mipmapped texture fetch.
import * as sys from '../_sys.js';

export const MAP_RECT = Object.freeze({ x0: -0.85, x1: 1.65, z0: -1.15, z1: 0.45 });
export const MAP_W = 1280, MAP_H = 820;
const RAYS = 512;

export function bakeFloorMap(ctx, vUniforms, box, SDF_GLSL) {
  const gl = ctx.gl;
  const { x0, x1, z0, z1 } = MAP_RECT;
  const texel = (x1 - x0) / MAP_W;

  // ── the map texture (mipmapped RGBA16F) ──
  const levels = Math.floor(Math.log2(Math.max(MAP_W, MAP_H))) + 1;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, MAP_W, MAP_H);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const map = { tex, fb, w: MAP_W, h: MAP_H, bind() { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, MAP_W, MAP_H); return this; } };
  map.bind();
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);

  // ── light-plane grid of rays ──
  const K = sys.KEY3;
  let e1 = [-K[2], 0, K[0]]; const l1 = Math.hypot(...e1); e1 = e1.map(v => v / l1);
  const e2 = [e1[1] * K[2] - e1[2] * K[1], e1[2] * K[0] - e1[0] * K[2], e1[0] * K[1] - e1[1] * K[0]];
  const C = [0, 0.5, 0];
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const d = [x - C[0], y - C[1], z - C[2]];
    const a = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], b = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const m = 0.02; a0 -= m; a1 += m; b0 -= m; b1 += m;
  const da = (a1 - a0) / RAYS, db = (b1 - b0) / RAYS;
  const O = [C[0] + 3 * K[0], C[1] + 3 * K[1], C[2] + 3 * K[2]];

  const rays = ctx.fbo(RAYS, RAYS, { internal: gl.RGBA32F, type: gl.FLOAT, filter: gl.NEAREST, count: 2 });
  const rayProg = ctx.program(`${ctx.glsl.common}${sys.SYS_GLSL}${SDF_GLSL}
    uniform vec3 uO, uE1, uE2, uDir; uniform vec4 uRect;
    layout(location = 0) out vec4 oS; layout(location = 1) out vec4 oL;
    vec4 traceIOR(vec3 ro, vec3 rd, float ior){
      float w = 1.0; bool any = false;
      for (int seg = 0; seg < 2; seg++){
        float t = marchV(ro, rd, 50.0, 0.0, 128);
        if (t < 0.0) break;
        vec3 p = ro + rd * t; vec3 n = nrmV(p);
        vec3 q, din, nq; float len, ww;
        if (!glassPath(p, n, rd, ior, 48, q, din, nq, len, ww)) return vec4(0.0);
        any = true; w *= ww;
        rd = refract(din, -nq, ior); ro = q + rd * 0.003;
      }
      if (!any || rd.y > -1e-4) return vec4(0.0);
      float tf = -ro.y / rd.y;
      vec3 h = ro + rd * tf;
      return vec4(h.x, h.z, w, max(tf, 1e-3));   // a: distance from the glass to the floor (> 0: valid)
    }
    void main(){
      vec2 ab = uRect.xy + gl_FragCoord.xy * uRect.zw;
      vec3 ro = uO + ab.x * uE1 + ab.y * uE2;
      oS = traceIOR(ro, uDir, IOR_S);
      oL = traceIOR(ro, uDir, IOR_L);
    }`, 'volume:bake-rays');
  ctx.draw(rayProg, { ...vUniforms, uO: O, uE1: e1, uE2: e2, uDir: K.map(v => -v), uRect: [a0, b0, da, db] }, rays);

  // ── splat: one gaussian per ray, shaped by the ray's own footprint on the floor ──
  // Σ = 0.3·J·Jᵀ + σmin²·I, J = landing-position derivatives from the neighbouring rays (central
  // differences, tears > 40 texels ignored). Focused rays stay sharp (caustic lines), spread rays
  // become wide and faint, so neither the ray lattice nor lone scattered rays ever show.
  const splat = ctx.programVF(`#version 300 es
    precision highp float; precision highp int; precision highp sampler2D;
    uniform sampler2D uRays; uniform vec4 uMapRect; uniform vec2 uMapSize; uniform int uN; uniform float uNorm; uniform float uPen;
    flat out vec3 vIS; flat out float vA; flat out float vPt;
    vec2 toTex(vec2 xz){ return (xz - uMapRect.xy) * uMapRect.zw * uMapSize; }
    bool fetchP(ivec2 ij, out vec2 p){
      p = vec2(0.0);
      if (ij.x < 0 || ij.y < 0 || ij.x >= uN || ij.y >= uN) return false;
      vec4 r = texelFetch(uRays, ij, 0); p = toTex(r.xy); return r.w > 0.0;
    }
    vec2 axisJ(ivec2 ij, vec2 p0, ivec2 d){
      vec2 pa, pb; bool a = fetchP(ij + d, pa), b = fetchP(ij - d, pb);
      a = a && length(pa - p0) < 40.0; b = b && length(pb - p0) < 40.0;
      if (a && b) return 0.5 * (pa - pb);
      if (a) return pa - p0;
      if (b) return p0 - pb;
      return vec2(0.0);
    }
    void main(){
      ivec2 ij = ivec2(gl_VertexID % uN, gl_VertexID / uN);
      vec4 r = texelFetch(uRays, ij, 0);
      vIS = vec3(0.0); vA = 0.0; vPt = 1.0;
      if (r.w <= 0.0 || r.z <= 0.0) { gl_Position = vec4(3.0, 3.0, 0.0, 1.0); gl_PointSize = 1.0; return; }
      vec2 p0 = toTex(r.xy);
      vec2 ju = axisJ(ij, p0, ivec2(1, 0)), jv = axisJ(ij, p0, ivec2(0, 1));
      if (dot(ju, ju) == 0.0) ju = vec2(4.0, 0.0);
      if (dot(jv, jv) == 0.0) jv = vec2(0.0, 4.0);
      // the key is an area light: a caustic blurs with the distance its light travels from the glass
      // (penumbra ∝ distance · the source's angular radius), so focused lines stay crisp at the foot of the
      // V while grazing rays that land far away spread into a faint glow instead of long bright blades
      float pen = uPen * r.w, pen2 = 0.64 + pen * pen;
      float sxx = 0.3 * (ju.x * ju.x + jv.x * jv.x) + pen2;
      float sxy = 0.3 * (ju.x * ju.y + jv.x * jv.y);
      float syy = 0.3 * (ju.y * ju.y + jv.y * jv.y) + pen2;
      float det = sxx * syy - sxy * sxy;
      vIS = vec3(syy, -sxy, sxx) / det;
      vA = r.z * uNorm / (6.2831853 * sqrt(det));
      float emax = 0.5 * (sxx + syy) + sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);
      vPt = clamp(5.0 * sqrt(emax), 3.0, 56.0);
      gl_PointSize = vPt;
      gl_Position = vec4(p0 / uMapSize * 2.0 - 1.0, 0.0, 1.0);
    }`, `#version 300 es
    precision highp float;
    flat in vec3 vIS; flat in float vA; flat in float vPt; out vec4 o;
    void main(){
      vec2 d = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y) * vPt;
      o = vec4(vA * exp(-0.5 * (d.x * d.x * vIS.x + 2.0 * d.x * d.y * vIS.y + d.y * d.y * vIS.z)));
    }`, 'volume:bake-splat');
  const vao = gl.createVertexArray();
  const norm = (da * db) / (texel * texel) / K[1];
  map.bind();
  gl.bindVertexArray(vao);
  gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
  const rect = [x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)];
  for (const [i, mask] of [[0, [true, false, false, false]], [1, [false, true, false, false]]]) {
    gl.colorMask(...mask);
    splat.use().set({ uRays: rays.texs[i], uMapRect: rect, uMapSize: [MAP_W, MAP_H], uN: RAYS, uNorm: norm, uPen: 0.015 / texel });
    gl.drawArrays(gl.POINTS, 0, RAYS * RAYS);
  }
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);

  // ── V soft shadow (opaque occluder, area key k = 10) and contact AO ──
  gl.colorMask(false, false, true, true);
  const shProg = ctx.program(`${ctx.glsl.common}${sys.SYS_GLSL}${SDF_GLSL}
    uniform vec4 uMapRect; in vec2 vUv; out vec4 o;
    void main(){
      vec3 p = vec3(uMapRect.x + vUv.x / uMapRect.z, 0.0, uMapRect.y + vUv.y / uMapRect.w);
      float res = 1.0;
      vec2 b = vBox(p, KEY3);
      if (b.y > max(b.x, 0.0)) {
        float t = max(b.x, 0.002), ph = 1e10;
        for (int i = 0; i < 320; i++){
          float h = sdVF(p + KEY3 * t);
          if (h < 1e-4) { res = 0.0; break; }
          float y = h * h / (2.0 * ph), dd = sqrt(max(h * h - y * y, 0.0));
          res = min(res, 10.0 * dd / max(t - y, 1e-4));
          ph = h;
          t += clamp(h, 0.0015, 0.012);
          if (t > b.y) break;
        }
      }
      float vis = clamp(res, 0.0, 1.0); vis = vis * vis * (3.0 - 2.0 * vis);
      float occ = 0.0, w = 1.0;
      for (int i = 1; i <= 5; i++){ float h = 0.012 * float(i * i); occ += max(h - sdVF(p + vec3(0.0, h, 0.0)), 0.0) * w; w *= 0.65; }
      float ao = clamp(1.0 - 1.6 * occ, 0.0, 1.0);
      o = vec4(0.0, 0.0, vis, ao);
    }`, 'volume:bake-shadow');
  ctx.draw(shProg, { ...vUniforms, uMapRect: rect }, map);
  gl.colorMask(true, true, true, true);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteFramebuffer(rays.fb); rays.texs.forEach(t => gl.deleteTexture(t));   // the ray buffers are done
  gl.deleteVertexArray(vao);

  return { tex, rect, texel, levels };
}
