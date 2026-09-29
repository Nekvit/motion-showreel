// Placeholder shot used while a real shot module is being built.
export function placeholder(id, hue = 0) {
  return {
    id,
    init(ctx) {
      this.surf = ctx.surface(ctx.W, ctx.H);
      this.prog = ctx.program(`${ctx.glsl.common}
        uniform sampler2D uText, uPrev; uniform float uHue, uT, uHasPrev, uMix; in vec2 vUv; out vec4 o;
        void main(){ vec3 c=0.25+0.2*cos(TAU*(uHue+vec3(0,0.33,0.67))+uT); c*=0.4+0.6*vUv.y;
          vec4 tx=texture(uText,vUv); c=mix(c,vec3(1.0),tx.a);
          if(uHasPrev>0.5) c=mix(texture(uPrev,vUv).rgb,c,uMix);
          o=vec4(c,1.0); }`, 'placeholder');
    },
    render(ctx, s) {
      const g = this.surf.clear();
      ctx.text.drawText(g, id.toUpperCase(), ctx.W / 2, ctx.H / 2, { font: { family: 'Archivo', weight: 800, width: 100, size: 120 * ctx.scale }, align: 'center', baseline: 'middle' });
      ctx.text.drawText(g, `f${s.f} · ${s.frame}`, ctx.W / 2, ctx.H * 0.62, { font: { family: 'JetBrains Mono', weight: 400, size: 32 * ctx.scale }, align: 'center' });
      this.surf.upload();
      ctx.draw(this.prog, { uText: this.surf.tex, uPrev: s.prevTex, uHasPrev: s.prevTex ? 1 : 0, uMix: Math.min(1, s.f / 10), uHue: hue, uT: s.t }, s.target);
    },
  };
}
