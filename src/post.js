// Global post-processing chain: HDR input -> (bloom pyramid, only when bloom > 0)
// -> composite: shake/distortion/CA sampling, gain/exposure, vignette, tonemap
// (3 = PRINT), exact sRGB OETF, flash, grain, HUD overlay, dither -> 8-bit output.
// Parameters are set per frame by the active shot through ctx.post / ctx.setPost
// (reset to POST_DEFAULTS every frame). With bloom/ca/vignette/grain/dither = 0
// the composite is an exact identity for linear values <= 1: a flat fill of
// hexc(0xRRGGBB) reads back as exactly #RRGGBB.
import { FBO, Program, FS_VERT } from './gl.js';
import { common, hash } from './glsl.js';

export const POST_DEFAULTS = {
  exposure: 1.0,          // linear multiplier before tonemap
  bloom: 0.0,             // bloom mix strength (0 = pyramid skipped entirely). HDR shots only (§1.4)
  bloomThreshold: 1.05,   // max-channel value where bloom starts: flat colours (<= 1) never bloom
  bloomKnee: 0.1,
  bloomRadius: 1.0,       // 0..1.5 upsample spread
  bloomTint: [1, 1, 1],
  ca: 0.0,                // chromatic aberration strength (radial, uv units at edge). Spikes only at 480/600
  distortion: 0.0,        // barrel(+)/pincushion(-) lens distortion (only then is out-of-range uv zeroed)
  zoomBlur: 0.0,          // radial zoom blur amount (uv units), for whip/punch moves
  zoomCenter: [0.5, 0.5],
  grain: 0.03,            // film grain amount (output space, luminance-weighted)
  grainSize: 1.6,         // grain size in pixels (design px; multiplied by ctx.scale)
  vignette: 0.08,         // vignette strength (0.08 in 2D shots, <= 0.18 in HDR shots); centre untouched
  vignetteRoundness: 0.6,
  saturation: 1.0,
  contrast: 1.0,
  lift: [0, 0, 0],        // additive shadow lift (linear)
  gain: [1, 1, 1],        // multiplicative colour gain (linear)
  flash: 0.0,             // 0..1 flash towards flashColor (post-tonemap)
  flashColor: [1, 1, 1],  // sRGB-CODED (applied after the tonemap), e.g. BONE = [0.945, 0.922, 0.875]
  fade: 0.0,              // 0..1 fade to fadeColor (after tonemap; sRGB-coded colour)
  fadeColor: [0, 0, 0],
  shake: [0, 0],          // uv offset applied to the whole frame (camera shake); edge-clamped sampling
  scanlines: 0.0,
  tonemap: 3,             // 0 = none (clamp), 1 = ACES fitted, 2 = AgX-ish filmic, 3 = PRINT (§2.2)
  letterbox: 0.0,         // 0..1 fraction of the 2.39:1 letterbox bars
  letterboxColor: [0, 0, 0],
  dither: 1.0,            // output dither amplitude in 8-bit codes (1 = uniform +-0.5 code); 0 in ?clean=1
  hudAlpha: 0.55,         // engine HUD opacity (0 hides it)
};

const LEVELS = 6;

const DOWN_FRAG = `${common}
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; uniform int uPrefilter;
in vec2 vUv; out vec4 o;
vec3 prefilter(vec3 c){
  float br=max(c.r,max(c.g,c.b));
  float rq=clamp(br-uThreshold+uKnee,0.0,2.0*uKnee); rq=rq*rq/(4.0*uKnee+1e-5);
  float w=max(rq,br-uThreshold)/max(br,1e-5); return c*w; }
void main(){
  // 13-tap downsample (Call of Duty: AW) with Karis average on the first level
  vec2 t=uTexel;
  vec3 a=texture(uTex,vUv+t*vec2(-2, 2)).rgb, b=texture(uTex,vUv+t*vec2(0, 2)).rgb, c=texture(uTex,vUv+t*vec2(2, 2)).rgb;
  vec3 d=texture(uTex,vUv+t*vec2(-2, 0)).rgb, e=texture(uTex,vUv).rgb,               f=texture(uTex,vUv+t*vec2(2, 0)).rgb;
  vec3 g=texture(uTex,vUv+t*vec2(-2,-2)).rgb, h=texture(uTex,vUv+t*vec2(0,-2)).rgb, i=texture(uTex,vUv+t*vec2(2,-2)).rgb;
  vec3 j=texture(uTex,vUv+t*vec2(-1, 1)).rgb, k=texture(uTex,vUv+t*vec2(1, 1)).rgb;
  vec3 l=texture(uTex,vUv+t*vec2(-1,-1)).rgb, m=texture(uTex,vUv+t*vec2(1,-1)).rgb;
  vec3 col;
  if(uPrefilter==1){
    vec3 g0=(a+b+d+e)*0.25, g1=(b+c+e+f)*0.25, g2=(d+e+g+h)*0.25, g3=(e+f+h+i)*0.25, g4=(j+k+l+m)*0.25;
    float w0=1.0/(1.0+luma(g0)), w1=1.0/(1.0+luma(g1)), w2=1.0/(1.0+luma(g2)), w3=1.0/(1.0+luma(g3)), w4=1.0/(1.0+luma(g4));
    col=(g0*w0*0.125+g1*w1*0.125+g2*w2*0.125+g3*w3*0.125+g4*w4*0.5)/(w0*0.125+w1*0.125+w2*0.125+w3*0.125+w4*0.5);
    col=prefilter(max(col,0.0));
  } else {
    col=e*0.125+(a+c+g+i)*0.03125+(b+d+f+h)*0.0625+(j+k+l+m)*0.125;
  }
  o=vec4(max(col,0.0),1.0);
}`;

const UP_FRAG = `
uniform sampler2D uTex; uniform sampler2D uBase; uniform vec2 uTexel; uniform float uRadius;
in vec2 vUv; out vec4 o;
void main(){
  vec2 t=uTexel*uRadius;
  vec3 s=texture(uTex,vUv+vec2(-t.x,t.y)).rgb + texture(uTex,vUv+vec2(0,t.y)).rgb*2.0 + texture(uTex,vUv+vec2(t.x,t.y)).rgb
       + texture(uTex,vUv+vec2(-t.x,0)).rgb*2.0 + texture(uTex,vUv).rgb*4.0 + texture(uTex,vUv+vec2(t.x,0)).rgb*2.0
       + texture(uTex,vUv+vec2(-t.x,-t.y)).rgb + texture(uTex,vUv+vec2(0,-t.y)).rgb*2.0 + texture(uTex,vUv+vec2(t.x,-t.y)).rgb;
  o=vec4(texture(uBase,vUv).rgb + s/16.0, 1.0);
}`;

const COMPOSITE_FRAG = `${common}${hash}
uniform sampler2D uScene; uniform sampler2D uBloomTex; uniform sampler2D uHudL; uniform sampler2D uHudR;
uniform vec2 uRes; uniform float uFrame;
uniform float uExposure, uBloom, uCA, uDistortion, uZoomBlur, uGrain, uGrainSize, uVignette, uVigRound;
uniform float uSaturation, uContrast, uFlash, uFade, uScan, uLetterbox, uDither, uHudAlpha;
uniform vec2 uZoomCenter, uShake;
uniform vec3 uLift, uGain, uFlashColor, uFadeColor, uBloomTint, uLetterboxColor, uHudColL, uHudColR;
uniform vec4 uHudRectL, uHudRectR;   // HUD canvases: x0, y0 (GL px, y-up), w, h
uniform int uTonemap;
in vec2 vUv; out vec4 o;

vec3 acesFitted(vec3 v){
  const mat3 ACESIn=mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
  const mat3 ACESOut=mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
  v=ACESIn*v; vec3 a=v*(v+0.0245786)-0.000090537; vec3 b=v*(0.983729*v+0.4329510)+0.238081; return saturate(ACESOut*(a/b)); }
vec3 agxish(vec3 c){
  // compact filmic curve with gentle highlight desaturation
  c=max(c,0.0); float l=luma(c);
  vec3 x=c/(1.0+c); float lm=l/(1.0+l);
  vec3 tm=mix(x, vec3(lm), smoothstep(0.6,1.0,lm)*0.35);
  return saturate(pow(tm, vec3(1.0/1.08))); }
// PRINT (DIRECTION §2.2): identity for max channel <= 1 (flat colours hit their hex
// exactly); above 1 the hue is kept and rolls off to warm white, reached at 4.
vec3 tmPrint(vec3 c){ c=max(c,0.); float m=max(c.r,max(c.g,c.b)); if(m<=1.) return c;
  float w=smoothstep(1.,4.,m); return mix(c/m, vec3(1.,.955,.90), w); }

vec2 lens(vec2 uv, float k){ vec2 p=uv-0.5; float r2=dot(p,p); return 0.5+p*(1.0+k*r2+k*0.5*r2*r2); }

vec3 sampleScene(vec2 uv){
  if(uZoomBlur<=0.0) return texture(uScene,uv).rgb;
  vec3 acc=vec3(0); float wsum=0.0;
  vec2 dir=uv-uZoomCenter;
  for(int i=0;i<12;i++){ float f=float(i)/11.0; float w=1.0-f*0.6; acc+=texture(uScene, uv-dir*uZoomBlur*f).rgb*w; wsum+=w; }
  return acc/wsum; }

// HUD label over the sRGB-coded image (texel-exact, alpha = glyph coverage).
vec3 hudOver(vec3 m, sampler2D t, vec4 r, vec3 col){
  ivec2 q=ivec2(gl_FragCoord.xy)-ivec2(r.xy);
  if(q.x<0||q.y<0||q.x>=int(r.z)||q.y>=int(r.w)) return m;
  float a=texelFetch(t,q,0).a*uHudAlpha;
  return a>0.0 ? mix(m,col,a) : m; }

void main(){
  vec2 uv=vUv+uShake;
  uv=lens(uv,uDistortion);
  vec2 c=uv-0.5;
  float r=length(c*vec2(uRes.x/uRes.y,1.0));
  vec3 col; vec2 off=vec2(0.0);
  if(uShake==vec2(0.0) && uDistortion==0.0 && uCA==0.0 && uZoomBlur<=0.0){
    // identity sampling: texel-exact pass-through (flat fills read back their exact hex)
    col=texelFetch(uScene, ivec2(gl_FragCoord.xy), 0).rgb;
  } else if(uCA==0.0){
    col=sampleScene(uv);
  } else {
    // chromatic aberration: sample R/B along the radial direction
    off=c*uCA*(0.4+r*1.6);
    col.r=sampleScene(uv+off).r;
    col.g=sampleScene(uv).g;
    col.b=sampleScene(uv-off).b;
  }
  if(uBloom>0.0){
    vec3 bl=texture(uBloomTex,uv).rgb*uBloomTint;
    if(uCA!=0.0){ bl.r=texture(uBloomTex,uv+off*2.0).r*uBloomTint.r; bl.b=texture(uBloomTex,uv-off*2.0).b*uBloomTint.b; }
    col=col+bl*uBloom*(1.0/6.0);
  }
  col=col*uGain+uLift;
  col*=uExposure;
  if(uSaturation!=1.0){ float l=luma(col); col=mix(vec3(l),col,uSaturation); }
  col=max(col,0.0);
  if(uContrast!=1.0){ col=pow(col/0.18,vec3(uContrast))*0.18; }
  // vignette (linear, pre-tonemap). Zero inside the centre disc (smoothstep ramp from 0.25).
  if(uVignette!=0.0){
    vec2 vc=(vUv-0.5)*vec2(mix(1.0,uRes.x/uRes.y,uVigRound),1.0);
    col*=1.0-uVignette*smoothstep(0.25,1.05,length(vc)*1.35);
  }
  vec3 m = uTonemap==3? tmPrint(col) : uTonemap==1? acesFitted(col) : uTonemap==2? agxish(col) : saturate(col);
  m=lin2srgb(m);                                   // exact sRGB OETF
  // flash (post-tonemap, sRGB-coded flashColor, so it can hit an exact colour)
  if(uFlash>0.0) m=mix(m, uFlashColor, saturate(uFlash));
  // grain: luminance-weighted, animated per frame, deterministic
  if(uGrain>0.0){
    vec2 gp=floor(gl_FragCoord.xy/uGrainSize);
    float n=hash13(vec3(gp, uFrame))+hash13(vec3(gp+17.0, uFrame*1.31))-1.0;
    m+=n*uGrain*(1.0-0.6*luma(m));
  }
  if(uScan>0.0){ m*=1.0-uScan*(0.5+0.5*sin(gl_FragCoord.y*PI)); }
  if(uFade>0.0) m=mix(m, uFadeColor, saturate(uFade));
  // letterbox 2.39:1
  if(uLetterbox>0.0){ float bar=(1.0-(uRes.x/uRes.y)/2.39)*0.5*uLetterbox; if(vUv.y<bar||vUv.y>1.0-bar) m=uLetterboxColor; }
  // out-of-frame after barrel distortion -> black. Shake alone samples CLAMP_TO_EDGE (no black strip).
  if(uDistortion!=0.0 && (uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0)) m*=0.0;
  // engine HUD: after tonemap, grain and vignette, before dither; unaffected by bloom/CA/distortion/shake
  if(uHudAlpha>0.0){ m=hudOver(m,uHudL,uHudRectL,uHudColL); m=hudOver(m,uHudR,uHudRectR,uHudColR); }
  // tiny dither to kill 8-bit banding in gradients (0 in ?clean=1)
  if(uDither>0.0) m+=(hash12(gl_FragCoord.xy+uFrame)-0.5)*(uDither/255.0);
  o=vec4(m,1.0);
}`;

export class Post {
  constructor(gl, W, H, vao, scale = H / 1080) {
    this.gl = gl; this.W = W; this.H = H; this.vao = vao; this.scale = scale;
    this.down = new Program(gl, FS_VERT, DOWN_FRAG, 'post:down');
    this.up = new Program(gl, FS_VERT, UP_FRAG, 'post:up');
    this.comp = new Program(gl, FS_VERT, COMPOSITE_FRAG, 'post:composite');
    this.mips = [];
    this.ups = [];
    let w = W, h = H;
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
      this.mips.push(new FBO(gl, w, h, { wrap: gl.CLAMP_TO_EDGE }));
      this.ups.push(new FBO(gl, w, h, { wrap: gl.CLAMP_TO_EDGE }));
    }
    // 1x1 transparent texture bound to the HUD samplers when there is no HUD
    this.blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  pass(prog, uniforms, fbo) {
    const gl = this.gl;
    if (fbo) fbo.bind(); else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H); }
    prog.use().set(uniforms);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // hud (optional): { texL, texR, rectL:[x0,y0,w,h], rectR, colL:[r,g,b], colR } (GL px, sRGB-coded colours)
  run(sceneTex, p, frame, outFBO = null, hud = null) {
    const gl = this.gl;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    let bloomTex = this.blank;
    if (p.bloom > 0) {
      let src = sceneTex, sw = this.W, sh = this.H;
      for (let i = 0; i < LEVELS; i++) {
        this.pass(this.down, { uTex: src, uTexel: [1 / sw, 1 / sh], uThreshold: p.bloomThreshold, uKnee: p.bloomKnee, uPrefilter: i === 0 ? 1 : 0 }, this.mips[i]);
        src = this.mips[i].tex; sw = this.mips[i].w; sh = this.mips[i].h;
      }
      let up = this.mips[LEVELS - 1];
      for (let i = LEVELS - 2; i >= 0; i--) {
        this.pass(this.up, { uTex: up.tex, uBase: this.mips[i].tex, uTexel: [1 / up.w, 1 / up.h], uRadius: p.bloomRadius }, this.ups[i]);
        up = this.ups[i];
      }
      bloomTex = up.tex;
    }
    const hudOn = !!hud && p.hudAlpha > 0;
    this.pass(this.comp, {
      uScene: sceneTex, uBloomTex: bloomTex, uRes: [this.W, this.H], uFrame: frame,
      uExposure: p.exposure, uBloom: p.bloom, uCA: p.ca, uDistortion: p.distortion, uZoomBlur: p.zoomBlur, uZoomCenter: p.zoomCenter,
      uGrain: p.grain, uGrainSize: Math.max(1e-3, p.grainSize * this.scale), uVignette: p.vignette, uVigRound: p.vignetteRoundness,
      uSaturation: p.saturation, uContrast: p.contrast, uLift: p.lift, uGain: p.gain,
      uFlash: p.flash, uFlashColor: p.flashColor, uFade: p.fade, uFadeColor: p.fadeColor, uShake: p.shake,
      uScan: p.scanlines, uTonemap: p.tonemap, uBloomTint: p.bloomTint, uLetterbox: p.letterbox, uLetterboxColor: p.letterboxColor,
      uDither: p.dither ?? 1,
      uHudAlpha: hudOn ? p.hudAlpha : 0,
      uHudL: hudOn ? hud.texL : this.blank, uHudR: hudOn ? hud.texR : this.blank,
      uHudRectL: hudOn ? hud.rectL : [0, 0, 0, 0], uHudRectR: hudOn ? hud.rectR : [0, 0, 0, 0],
      uHudColL: hudOn ? hud.colL : [0, 0, 0], uHudColR: hudOn ? hud.colR : [0, 0, 0],
    }, outFBO);
  }
}
