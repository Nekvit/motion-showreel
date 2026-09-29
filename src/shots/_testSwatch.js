// Test page: ?test=swatch — the tonemap swatch frame (DIRECTION §2.2, §7.4).
// VERM, COBALT and BONE (linear, exact EOTF) at ×0.5, ×0.75, ×1, ×1.25, ×1.5,
// ×2, ×2.5, ×3, ×4, ×6 as labelled patches on INK, each row with a continuous
// ×0→×6 ramp strip under it, plus the warm-white end point (1, .955, .90) of
// tonemap 3 (PRINT) for reference. Expected: ≤ ×1 exact hex, above 1 hue kept
// and rolling off to warm white, reached at ×4 (for the brightest channel).
const TOKENS = [['VERM', 0xFF3A1F], ['COBALT', 0x2233FF], ['BONE', 0xF1EBDF]];
const MULTS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6];
// Layout in design px (1920×1080, y down)
const X0 = 200, PW = 136, GAP = 14, Y0 = 250, PH = 196, PITCH = 262, RAMP_Y = 14, RAMP_H = 26;
const SPAN = MULTS.length * (PW + GAP) - GAP;
const WX0 = X0 + SPAN + 30, WX1 = WX0 + 96;

export default {
  id: 'test-swatch',
  init(ctx) {
    this.text = ctx.surface(ctx.W, ctx.H);
    const g = this.text.clear(), S = ctx.scale, T = ctx.text;
    g.fillStyle = '#fff';
    const mono = size => ({ family: 'JetBrains Mono', weight: 500, size: size * S });
    T.drawText(g, 'TONEMAP 3 · PRINT — SWATCH', 60 * S, 120 * S, { font: mono(26), tracking: 0.06 * 26 * S });
    T.drawText(g, 'LINEAR TOKEN × K · ≤1 EXACT HEX · >1 HUE KEPT, WARM WHITE AT 4', 60 * S, 160 * S, { font: mono(16), tracking: 0.06 * 16 * S });
    MULTS.forEach((m, i) => T.drawText(g, `×${m}`, (X0 + i * (PW + GAP) + PW / 2) * S, (Y0 - 14) * S, { font: mono(18), align: 'center' }));
    TOKENS.forEach(([name], r) => {
      T.drawText(g, name, 60 * S, (Y0 + r * PITCH + PH / 2) * S, { font: mono(18), baseline: 'middle', tracking: 0.06 * 18 * S });
      T.drawText(g, 'RAMP ×0→×6', 60 * S, (Y0 + r * PITCH + PH + RAMP_Y + RAMP_H / 2) * S, { font: mono(12), baseline: 'middle' });
    });
    T.drawText(g, 'WARM', ((WX0 + WX1) / 2) * S, (Y0 - 14) * S, { font: mono(18), align: 'center' });
    this.text.upload();
    this.prog = ctx.program(`${ctx.glsl.common}
      uniform sampler2D uText; in vec2 vUv; out vec4 o;
      const float X0=${X0}.0, PW=${PW}.0, GAP=${GAP}.0, Y0=${Y0}.0, PH=${PH}.0, PITCH=${PITCH}.0, RY=${RAMP_Y}.0, RH=${RAMP_H}.0, SPAN=${SPAN}.0, WX0=${WX0}.0, WX1=${WX1}.0;
      const float M[10]=float[10](${MULTS.map(m => m.toFixed(2)).join(',')});
      vec3 tok(int r){ return r==0 ? hexc(${TOKENS[0][1]}) : r==1 ? hexc(${TOKENS[1][1]}) : hexc(${TOKENS[2][1]}); }
      void main(){
        vec2 q=vec2(vUv.x*1920.0, (1.0-vUv.y)*1080.0);
        vec3 c=hexc(0x0E0E12);
        for(int r=0;r<3;r++){
          float y0=Y0+float(r)*PITCH;
          if(q.y>=y0 && q.y<y0+PH){
            float cx=(q.x-X0)/(PW+GAP); int ci=int(floor(cx));
            if(ci>=0 && ci<10 && (q.x-X0)-float(ci)*(PW+GAP)<PW) c=tok(r)*M[ci];
          }
          if(q.y>=y0+PH+RY && q.y<y0+PH+RY+RH && q.x>=X0 && q.x<X0+SPAN) c=tok(r)*(6.0*(q.x-X0)/SPAN);
        }
        if(q.x>=WX0 && q.x<WX1 && q.y>=Y0 && q.y<Y0+2.0*PITCH+PH) c=vec3(1.0,0.955,0.90);
        c=mix(c, hexc(0xF1EBDF), texture(uText,vUv).a);
        o=vec4(c,1.0);
      }`, 'test-swatch');
  },
  mb: () => 0,
  postOut: {},
  render(ctx, s) {
    ctx.draw(this.prog, { uText: this.text.tex }, s.target);
    ctx.setPost(s, {});
  },
};
