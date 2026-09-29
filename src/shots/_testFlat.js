// Test page: ?test=flat&color=VERM|COBALT|BONE|INK|GRAPHITE[&post={json deltas}]
// A full-frame flat LINEAR fill of the palette token (hexc() = exact sRGB EOTF),
// through the normal post chain (tonemap 3 PRINT). With ?clean=1 every pixel
// must read back the token's exact hex (DIRECTION §2.2 unit check, §7.3).
// `post` (optional, URL-encoded JSON) sets post deltas, e.g. {"shake":[0.004,0.003]}
// to check edge-clamped shake, or {"vignette":0.18} to check the untouched centre.
// Tokens are defined locally (the palette's source of truth is _sys.js / §1.2).
const TOKENS = { INK: 0x0E0E12, BONE: 0xF1EBDF, VERM: 0xFF3A1F, COBALT: 0x2233FF, GRAPHITE: 0x26262B };

export default {
  id: 'test-flat',
  init(ctx) {
    const key = String(ctx.query.color || 'VERM').toUpperCase();
    if (!(key in TOKENS)) throw new Error(`_testFlat: unknown color ${key}; one of ${Object.keys(TOKENS).join(', ')}`);
    this.key = key;
    this.deltas = ctx.query.post ? JSON.parse(ctx.query.post) : {};
    this.prog = ctx.program(`${ctx.glsl.common}
      out vec4 o; in vec2 vUv;
      void main(){ o=vec4(hexc(${TOKENS[key]}), 1.0); }`, 'test-flat');
  },
  mb: () => 0,
  postOut: {},
  render(ctx, s) {
    ctx.draw(this.prog, {}, s.target);
    ctx.setPost(s, this.deltas);
  },
};
