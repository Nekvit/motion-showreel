// TEST ONLY (never imported by volume.js): a stand-in for `lens` OUT (DIRECTION §5.4 OUT), so the
// volume IN cut can be judged while `lens` is being built. Ink ground; the 2D glass V at CAP_V2D /
// BASE_V2D, ink-centred, showing only Fresnel rims, bevel highlights and a COBALT tint; the flat VERM
// disc r 0.073 at NSTAR; in the tail (372–395) one slow glint down the left bevel.
import * as sys from '../_sys.js';

export default {
  id: 'lens-standin',
  postOut: { bloom: 0.25, vignette: 0.12 },
  mb() { return 0; },
  init(ctx) {
    sys.initSys(ctx);
    const V = sys.glyphSDF(ctx, sys.stationLetter(ctx, 3));
    this.u = { ...sys.placeGlyph(V, sys.CAP_V2D, sys.BASE_V2D, 0).uniforms('uV') };
    const ns = sys.NSTAR(ctx);
    this.u.uDot = [ns.x, ns.y, ns.r];
    this.u.uKc = [0, sys.BASE_V2D + sys.CAP_V2D * V.inkCy];
    this.prog = ctx.program(`${ctx.glsl.common}${sys.SYS_GLSL}${sys.glyphUniformDecl('uV')}
      uniform vec2 uRes; uniform vec3 uDot; uniform vec2 uKc; uniform float uGlint;
      in vec2 vUv; out vec4 o;
      float dV(vec2 p){ return glyphDist(uVTex, uVMeta, uVPlace, p); }
      float hB(vec2 p){ return smoothstep(0.0, 0.035, -dV(p)); }
      vec3 bg(vec2 q){ float dd = length(q - uDot.xy) - uDot.z; return mix(INK, VERM, clamp(0.5 - dd * uRes.y, 0.0, 1.0)); }
      void main(){
        vec2 p = P(vUv, uRes.x / uRes.y);
        float px = 1.0 / uRes.y;
        float d = dV(p);
        vec3 col = bg(p);
        if (d < 2.0 * px) {
          float e = 1.5 * px;
          float h = hB(p);
          vec2 g = vec2(hB(p + vec2(e, 0.0)) - hB(p - vec2(e, 0.0)), hB(p + vec2(0.0, e)) - hB(p - vec2(0.0, e))) / (2.0 * e);
          vec3 n = normalize(vec3(-g * 0.9 * 0.035, 1.0));
          vec2 q = uKc + (p - uKc) / 1.3;
          vec3 a = bg(q + n.xy * 0.035 * 1.15), b = bg(q + n.xy * 0.035 * 0.85);
          vec3 tr = palDisperse(a, b) * mix(vec3(1.0), COBALT, 0.08 * h);
          float F = 0.04 + 0.96 * pow(1.0 - n.z, 5.0);
          vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
          vec3 env = mix(GRAPHITE, BONE, 0.5 + 0.5 * r.y) + 2.0 * WARM * exp(-8.0 * length(r.xy - vec2(-0.55, 0.70)));
          float s = dot(p - uKc, normalize(vec2(0.55, -0.70)));
          float gl = h * (1.0 - h) * 4.0 * exp(-pow((s - uGlint) / 0.02, 2.0)) * 1.8 * step(n.x, 0.0);
          vec3 glass = tr * (1.0 - F) + F * env + WARM * gl + COBALT * 0.08 * h;
          col = mix(col, glass, clamp(0.5 - d / px, 0.0, 1.0));
        }
        float dd = length(p - uDot.xy) - uDot.z;
        col = mix(col, VERM, clamp(0.5 - dd / px, 0.0, 1.0));
        o = vec4(col, 1.0);
      }`, 'lens-standin');
  },
  render(ctx, s) {
    const u = Math.min(Math.max((s.frame - 372) / 24, 0), 1);
    ctx.draw(this.prog, { ...this.u, uGlint: -0.35 + 0.7 * u }, s.target);
    ctx.setPost(s, { bloom: 0.25, vignette: 0.12 });
  },
};
