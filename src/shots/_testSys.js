// Test / reference shot for _sys.js (package 9): `node tools/render.mjs --test sys --frames 0,720,738,768`.
// Draws the title layout purely from _sys: the name via GLSL glyphDist (one glyph SDF per letter,
// placed with placeGlyph), its (+6,-6)px 45° halftone shadow, the rule, the full stop, S0, the
// touch schedule (on a touch frame the dot sits at that touch point), and the role/year lines
// from a canvas Surface. Doubles as a usage example for shot authors.
import * as sys from './_sys.js';

export default {
  id: 'test-sys',

  init(ctx) {
    sys.initSys(ctx);
    const N = this.N = sys.nameLayout(ctx);
    // static canvas layer: role line and year, glyph by glyph at the layout positions
    this.surf = ctx.surface(ctx.W, ctx.H);
    const g = this.surf.clear();
    g.fillStyle = '#fff';
    g.font = sys.fontPx(ctx, N.role.font, N.role.size);
    for (const gl of N.role.glyphs) g.fillText(gl.ch, ...sys.toCanvas(ctx, gl.x, N.role.baseline));
    g.font = sys.fontPx(ctx, N.year.font, N.year.size);
    for (const gl of N.year.glyphs) g.fillText(gl.ch, ...sys.toCanvas(ctx, gl.x, N.year.baseline));
    this.surf.upload();

    let decl = '', dist = 'float d = 1e9, ds = 1e9;\n';
    N.glyphs.forEach((_, i) => {
      decl += sys.glyphUniformDecl('uG' + i);
      dist += `d = min(d, glyphDist(uG${i}Tex, uG${i}Meta, uG${i}Place, p));\n`;
      dist += `ds = min(ds, glyphDist(uG${i}Tex, uG${i}Meta, uG${i}Place, p - SH));\n`;
    });
    this.prog = ctx.program(`${ctx.glsl.common}${sys.SYS_GLSL}${decl}
      uniform sampler2D uType; uniform vec2 uRes;
      uniform vec3 uDot, uS0; uniform vec4 uRule; uniform vec3 uTouch[${N.n}];
      in vec2 vUv; out vec4 o;
      float fill(float d, float px){ return clamp(0.5 - d / px, 0.0, 1.0); }
      void main(){
        vec2 p = P(vUv, uRes.x / uRes.y);
        float px = 1.0 / uRes.y;                       // one real pixel in H
        const vec2 SH = vec2(6.0, -6.0) * PX_H;        // key-light shadow offset (§1.4)
        ${dist}
        vec3 col = BONE * (1.0 + paperFibre(p));
        col = mix(col, INK, fill(ds, px) * halftone45(p, 8.0, 0.35));   // hard shadow as 35% halftone
        col = mix(col, INK, fill(d, px));
        col = mix(col, INK, texture(uType, vUv).a);                      // role + year
        // rule: 4px VERM, centred on uRule.x, from uRule.y to uRule.z
        float dr = max(abs(p.y - uRule.x) - 0.5 * uRule.w, max(uRule.y - p.x, p.x - uRule.z));
        col = mix(col, VERM, fill(dr, px));
        // S0 as a 3px ring, touch points as 1px ink rings, the dot
        col = mix(col, VERM, fill(abs(length(p - uS0.xy) - uS0.z) - 1.5 * PX_H, px));
        for (int i = 0; i < ${N.n}; i++) col = mix(col, INK, 0.5 * fill(abs(length(p - uTouch[i].xy) - uTouch[i].z) - 0.5 * PX_H, px));
        col = mix(col, VERM, fill(length(p - uDot.xy) - uDot.z, px));
        o = vec4(col, 1.0);
      }`, 'test-sys');
    this.uni = { uType: this.surf.tex, uS0: [N.S0.x, N.S0.y, N.S0.r], uRule: [N.rule.y, N.rule.x0, N.rule.x1, N.rule.w], uTouch: N.touches.flatMap(t => [t.x, t.y, N.dot.r]) };
    N.glyphs.forEach((gl, i) => Object.assign(this.uni, gl.place.uniforms('uG' + i)));
  },

  render(ctx, s) {
    const N = this.N;
    const t = N.touches.find(t => t.frame === Math.floor(s.frame));
    const dot = t ? [t.x, t.y, N.dot.r] : [N.dot.x, N.dot.y, N.dot.r];
    ctx.draw(this.prog, { ...this.uni, uDot: dot, ...sys.sysUniforms(ctx) }, s.target);
  },
};
