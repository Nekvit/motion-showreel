// Reference shot: demonstrates every engine facility a shot typically uses.
// Copy its structure; delete what you don't need.
//  - a fullscreen raymarch/2D shader with the shared GLSL library
//  - a canvas2D Surface for kinetic type, uploaded each frame
//  - a text SDF built once in init()
//  - a stateful ping-pong feedback buffer stepped deterministically
//  - compositing ctx's prevTex during the overlap window
//  - per-frame post parameters
export default {
  id: 'testcard',
  stateful: true,

  init(ctx) {
    const { glsl } = ctx;
    this.type = ctx.surface(ctx.W, ctx.H);
    // Static SDF of a word (distance in source pixels; negative inside)
    const s = ctx.surface(1024, 256);
    s.g.fillStyle = '#fff';
    ctx.text.drawText(s.g, ctx.config.name, 512, 128, { font: { family: 'Archivo', weight: 900, width: 125, size: 190 }, align: 'center', baseline: 'middle' });
    this.sdf = ctx.text.sdfTexture(ctx.gl, s.canvas);

    this.fb = ctx.pingpong(480, 270);
    this.feedback = ctx.program(`${glsl.common}${glsl.noise}
      uniform sampler2D uPrev; uniform float uTime; uniform vec2 uRes;
      in vec2 vUv; out vec4 o;
      void main(){
        vec2 p=(vUv-0.5)*vec2(uRes.x/uRes.y,1.0);
        vec2 adv=curl2(p*2.0+uTime*0.3)*0.0015;
        vec3 c=texture(uPrev, vUv-adv).rgb*0.985;
        float d=length(p-0.35*vec2(cos(uTime*1.7),sin(uTime*2.3)));
        c+=vec3(1.0,0.35,0.1)*smoothstep(0.05,0.0,d)*0.6;
        o=vec4(c,1.0);
      }`, 'testcard:feedback');

    this.main = ctx.program(`${glsl.all}
      uniform sampler2D uType, uSdf, uFeed, uPrevShot; uniform float uTime, uHasPrev, uMix;
      uniform vec2 uRes;
      in vec2 vUv; out vec4 o;
      float map(vec3 p){ p.xz*=rot2(uTime*0.6); p.xy*=rot2(uTime*0.4);
        return smin(sdRoundBox(p,vec3(0.55),0.08), sdSphere(p-vec3(0.0,0.0,0.0),0.72), 0.2) + 0.03*snoise(p*4.0+uTime); }
      vec3 nrm(vec3 p){ vec2 e=vec2(0.002,0); return normalize(vec3(map(p+e.xyy)-map(p-e.xyy),map(p+e.yxy)-map(p-e.yxy),map(p+e.yyx)-map(p-e.yyx))); }
      void main(){
        float asp=uRes.x/uRes.y;
        vec3 ro=vec3(0,0,3.2); vec3 rd=camRay(vUv,asp,ro,vec3(0),0.8,0.0);
        vec3 col=mix(hexc(0x0B0B10),hexc(0x1A1030),vUv.y);
        col+=texture(uFeed,vUv).rgb;
        float t=0.0; bool hit=false;
        for(int i=0;i<80;i++){ float d=map(ro+rd*t); if(d<0.001){hit=true;break;} t+=d; if(t>8.0)break; }
        if(hit){ vec3 p=ro+rd*t; vec3 n=nrm(p); vec3 l=normalize(vec3(0.6,0.8,0.5));
          float dif=max(dot(n,l),0.0); float fr=fresnelSchlick(max(dot(n,-rd),0.0),0.04);
          col=vec3(0.05)+dif*vec3(1.0,0.9,0.8)*0.8+iridescence(dot(n,-rd),2.0)*fr*2.5; }
        // SDF text: glow + fill
        vec2 tuv=(vUv-vec2(0.5,0.18))*vec2(asp,1.0)*vec2(1.0,4.0)*0.9+0.5;
        float d=texture(uSdf,clamp(tuv,0.0,1.0)).r;
        col+=vec3(1.0,0.4,0.15)*exp(-max(d,0.0)*0.08)*0.6;
        col=mix(col,vec3(4.0),aastep(d));
        vec4 ty=texture(uType,vUv); col=mix(col,ty.rgb,ty.a);
        if(uHasPrev>0.5){ col=mix(texture(uPrevShot,vUv).rgb,col,uMix); }
        o=vec4(col,1.0);
      }`, 'testcard:main');
  },

  reset(ctx) { this.fb.clear(0, 0, 0, 1); },

  step(ctx, s) {
    ctx.draw(this.feedback, { uPrev: this.fb.read.tex, uTime: s.t }, this.fb, { swap: true });
  },

  render(ctx, s) {
    const { ease, text } = ctx;
    // Kinetic type drawn per frame
    const g = this.type.clear();
    g.fillStyle = '#fff';
    const label = `FRAME ${String(s.frame).padStart(3, '0')}  ·  ${s.t.toFixed(2)}s  ·  BEAT ${ctx.beat.at(s.g).toFixed(2)}`;
    text.drawText(g, label, 80, ctx.H - 80, { font: { family: 'JetBrains Mono', weight: 500, size: 28 * ctx.scale }, tracking: 2 });
    const w = 62 + 63 * (0.5 + 0.5 * Math.sin(s.t * 3));
    text.drawText(g, 'KINETIC', ctx.W / 2, ctx.H * 0.3, {
      font: { family: 'Archivo', weight: 800, width: w, size: 150 * ctx.scale }, align: 'center', baseline: 'middle', tracking: -4,
      perGlyph: (gl, i) => ({ dy: Math.sin(s.t * 4 + i * 0.6) * 20 * ctx.scale, fill: i % 2 ? '#ffffff' : '#ff5a1f' }),
    });
    this.type.upload();

    ctx.draw(this.main, {
      uType: this.type.tex, uSdf: this.sdf.tex, uFeed: this.fb.read.tex, uTime: s.t,
      uPrevShot: s.prevTex, uHasPrev: s.prevTex ? 1 : 0, uMix: ease.ease.outExpo(s.f / 20),
    }, s.target);

    const p = ctx.post;
    p.bloom = 0.6;
    p.flash = ctx.beat.pulse(s.g, 12) * 0.08;
    p.ca = 0.002 + ctx.beat.pulse(s.g, 10) * 0.004;
  },
};
