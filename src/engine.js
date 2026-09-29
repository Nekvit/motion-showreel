// Reel engine: owns the GL context, the timeline of shots, deterministic
// stateful-sim replay, transition overlap (prevTex), motion blur (temporal
// supersampling), post continuity across cuts (prevPost / setPost), the HUD
// overlay and the post chain. See ENGINE.md for the shot-facing contract.
import { Program, FBO, PingPong, FS_VERT, fullscreenVAO, textureFrom, dataTexture, createVAO, mat4 } from './gl.js';
import GLSL from './glsl.js';
import * as E from './ease.js';
import * as Text from './text.js';
import { Post, POST_DEFAULTS } from './post.js';
import { CONFIG } from './config.js';
import { hudState, HudRenderer, FIG } from './hud.js';

export const clonePost = () => JSON.parse(JSON.stringify(POST_DEFAULTS));

// POST_DEFAULTS ⊕ deltas (arrays copied).
export function mergePost(deltas = {}) {
  const o = clonePost();
  for (const [k, v] of Object.entries(deltas || {})) o[k] = Array.isArray(v) ? v.slice() : v;
  return o;
}

// Params never eased across a cut by ctx.setPost (flash/CA/shake are designed
// breaks; tonemap is a discrete mode; flashColor belongs to flash).
export const POST_EASE_EXEMPT = new Set(['flash', 'flashColor', 'ca', 'shake', 'tonemap']);

// Frames after a cut during which ctx.prevPost is provided (§2.2).
export const POST_EASE_FRAMES = 12;

// Params that are discrete modes: never averaged (motion blur) or eased (cuts).
export const POST_DISCRETE = new Set(['tonemap']);

// Post params of an even-N motion-blur frame: the mean of the two samples straddling the
// integer frame (sub = ∓0.25/N), which is exact at the integer frame for params that are
// linear in s.f and correct to O(1/N²) otherwise. Discrete params come from `b` (the
// sample just after the integer frame, i.e. `s.f >= F` style switches read as at F).
function midPost(a, b) {
  const o = {};
  for (const [k, v] of Object.entries(b)) o[k] = POST_DISCRETE.has(k) || !(k in a) ? (Array.isArray(v) ? v.slice() : v) : blendParam(a[k], v, 0.5);
  return o;
}

function blendParam(a, b, k) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b)) return b.map((v, j) => (typeof v === 'number' && typeof a[j] === 'number' ? a[j] + (v - a[j]) * k : v));
  return b;
}

// Motion-blur average: up to MB_CHUNK sample targets per pass, combined with the
// running mean of the previous chunks (uPrevW samples) held in the accumulator.
// Texel-exact (texelFetch), all four channels (alpha mattes are averaged too),
// evaluated in fp32 and stored in RGBA16F. A texel that is identical in every
// sample stays bit-identical (n·v/n is exact for half-float v).
const MB_CHUNK = 7;
const GL_SAVED_UNITS = 16;   // texture units saved/restored around the lazy prevTex render
const AVG_FRAG = `uniform sampler2D uS0, uS1, uS2, uS3, uS4, uS5, uS6, uAcc; uniform int uCount; uniform float uPrevW; out vec4 o;
void main(){ ivec2 p=ivec2(gl_FragCoord.xy); vec4 s=texelFetch(uS0,p,0);
  if(uCount>1) s+=texelFetch(uS1,p,0); if(uCount>2) s+=texelFetch(uS2,p,0); if(uCount>3) s+=texelFetch(uS3,p,0);
  if(uCount>4) s+=texelFetch(uS4,p,0); if(uCount>5) s+=texelFetch(uS5,p,0); if(uCount>6) s+=texelFetch(uS6,p,0);
  float n=float(uCount);
  o = uPrevW>0.0 ? (texelFetch(uAcc,p,0)*uPrevW + s)/(uPrevW+n) : s/n; }`;

export class Engine {
  constructor(canvas, { width = 1920, height = 1080, fps = 60, frames = 900, timeline, scale = 1, clean = false, hud = true, query = {} } = {}) {
    this.canvas = canvas;
    this.W = Math.round(width * scale); this.H = Math.round(height * scale);
    this.scale = scale;
    canvas.width = this.W; canvas.height = this.H;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float not available');
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_half_float');
    this.gl = gl;
    this.fps = fps; this.frames = frames;
    this.timeline = timeline;
    this.clean = !!clean;
    this.vao = fullscreenVAO(gl);
    this.post = new Post(gl, this.W, this.H, this.vao, scale);
    this.targets = [];          // pool of HDR targets indexed by recursion depth
    this.warnedPost = new Set();
    this.accums = [];           // motion-blur accumulators (PingPong RGBA16F) indexed by depth
    this.sampleTargets = [];    // extra MB sample targets [depth][slot 1..MB_CHUNK-1] (slot 0 = target(depth))
    this.scratch = new FBO(gl, this.W, this.H);
    this.ctx = this.makeContext(query);
    this.hud = hud ? new HudRenderer(this.ctx) : null;
    this.hudState = null;
    // FIG[k] is the label of timeline shot k (when the timeline is the 8-shot reel)
    this.hudStarts = timeline.length === FIG.length ? timeline.map(s => s.start) : undefined;
  }

  makeContext(query) {
    const gl = this.gl, self = this;
    const ctx = {
      gl, W: this.W, H: this.H, aspect: this.W / this.H, fps: this.fps, scale: this.scale,
      config: CONFIG, glsl: GLSL, ease: E, text: Text, mat4,
      vao: this.vao,
      post: clonePost(),
      prevPost: null,
      POST_DEFAULTS,
      clean: this.clean,          // ?clean=1: shots multiply paper fibre by 0 (uClean is auto-set in ctx.draw)
      query: { ...query },        // page query parameters (test shots read e.g. ctx.query.color)
      shared: {},
      FS_VERT,
      // Fullscreen fragment program. `frag` should declare `in vec2 vUv; out vec4 o;` (or any out name).
      program: (frag, label = 'shot') => new Program(gl, FS_VERT, frag, label),
      // Custom vertex+fragment program (for instanced/geometry drawing). Attribute 0 is aPos.
      programVF: (vert, frag, label = 'shot') => new Program(gl, vert, frag, label),
      fbo: (w, h, opts) => new FBO(gl, w ?? self.W, h ?? self.H, opts),
      pingpong: (w, h, opts) => new PingPong(gl, w ?? self.W, h ?? self.H, opts),
      surface: (w, h, opts) => new Text.Surface(gl, w ?? self.W, h ?? self.H, opts),
      textureFrom: (src, opts) => textureFrom(gl, src, opts),
      dataTexture: (w, h, data, opts) => dataTexture(gl, w, h, data, opts),
      createVAO: desc => createVAO(gl, desc),
      // Draw a fullscreen pass. target: FBO | PingPong (writes .write then swaps if swap=true) | null (canvas)
      // uRes (target size), uAspect, uClean and uSysClean (1 in ?clean=1) are provided automatically when declared.
      draw(prog, uniforms = {}, target = null, { blend = null, swap = false, clear = false } = {}) {
        let fb = target;
        if (target instanceof PingPong) fb = target.write;
        if (fb) fb.bind(); else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, self.W, self.H); }
        if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
        const w = fb ? fb.w : self.W, h = fb ? fb.h : self.H;
        prog.use().set({ uRes: [w, h], uAspect: w / h, uClean: ctx.clean ? 1 : 0, uSysClean: ctx.clean ? 1 : 0, ...uniforms });
        ctx.setBlend(blend);
        gl.bindVertexArray(self.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        ctx.setBlend(null);
        if (swap && target instanceof PingPong) target.swap();
      },
      // blend: null | 'add' | 'alpha' | 'premult' | 'multiply' | 'screen' | 'max'
      setBlend(mode) {
        if (!mode) { gl.disable(gl.BLEND); return; }
        gl.enable(gl.BLEND);
        gl.blendEquation(mode === 'max' ? gl.MAX : gl.FUNC_ADD);
        switch (mode) {
          case 'add': gl.blendFunc(gl.ONE, gl.ONE); break;
          case 'alpha': gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
          case 'premult': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
          case 'multiply': gl.blendFunc(gl.DST_COLOR, gl.ZERO); break;
          case 'screen': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
          case 'max': gl.blendFunc(gl.ONE, gl.ONE); break;
          default: throw new Error('unknown blend ' + mode);
        }
      },
      // Copy a texture into a target (optionally with a uv transform: [scaleX, scaleY, offX, offY]).
      blit(tex, target = null, uvXform = [1, 1, 0, 0]) {
        ctx.draw(self.blitProg, { uTex: tex, uXf: uvXform }, target);
      },
      // Post continuity (§2.2). Sets ctx.post = POST_DEFAULTS ⊕ deltas and, while
      // s.f < easeFrames and ctx.prevPost exists, eases every numeric param (arrays
      // component-wise) as mix(prevPost.p, own.p, inOutSine(min(s.f/easeFrames, 1))),
      // except flash, flashColor, ca, shake, tonemap and the keys in `exempt`.
      // During an overlap window it reads s.prevTex first if needed (so prevPost is
      // the outgoing shot's params this frame). easeFrames: 0 opts out (the 480 cut);
      // easeFrames > 12 eases from the previous shot's postOut once ctx.prevPost ends.
      setPost(s, deltas = {}, { exempt = [], easeFrames = POST_EASE_FRAMES } = {}) {
        for (const key of Object.keys(deltas || {})) {
          if (!(key in POST_DEFAULTS) && !self.warnedPost.has(key)) { self.warnedPost.add(key); console.warn(`ctx.setPost: unknown post param "${key}"`); }
        }
        const own = mergePost(deltas);
        if (easeFrames > 0 && s && s.f < easeFrames) {
          if (!ctx.prevPost && s.inOverlap) void s.prevTex;
          // ctx.prevPost exists for the first POST_EASE_FRAMES (12) frames only; a longer
          // ease continues from the previous shot's postOut (the zero-overlap source).
          const pp = ctx.prevPost ?? (easeFrames > POST_EASE_FRAMES ? self.postOutBefore(s.index, s.fi) : null);
          if (pp) {
            const k = E.ease.inOutSine(Math.min(Math.max(s.f, 0) / easeFrames, 1));
            for (const key of Object.keys(own)) {
              if (POST_EASE_EXEMPT.has(key) || exempt.includes(key) || !(key in pp)) continue;
              own[key] = blendParam(pp[key], own[key], k);
            }
          }
        }
        ctx.post = own;
        return own;
      },
      beat: null, // filled below from config
    };
    const spb = 60 / CONFIG.bpm;
    ctx.beat = {
      bpm: CONFIG.bpm,
      spb,                                   // seconds per beat
      fpb: spb * this.fps,                   // frames per beat
      // beat index (float) at global seconds g
      at: g => (g - CONFIG.beatOffset) / spb,
      // 1 on the beat, decaying exponentially afterwards (sharpness k)
      pulse: (g, k = 8) => { const b = (g - CONFIG.beatOffset) / spb; const f = b - Math.floor(b); return b < 0 ? 0 : Math.exp(-f * k); },
      // global frame of beat index i
      frameOf: i => Math.round((CONFIG.beatOffset + i * spb) * this.fps),
    };
    this.blitProg = new Program(gl, FS_VERT, `uniform sampler2D uTex; uniform vec4 uXf; in vec2 vUv; out vec4 o; void main(){ o=texture(uTex, vUv*uXf.xy+uXf.zw); }`, 'blit');
    this.avgProg = new Program(gl, FS_VERT, AVG_FRAG, 'engine:mb-average');
    return ctx;
  }

  async init(onProgress) {
    for (let i = 0; i < this.timeline.length; i++) {
      const s = this.timeline[i];
      s.index = i;
      s.dur = (s.end - s.start) / this.fps;
      s.lastStep = -Infinity;
      if (s.module.init) await s.module.init(this.ctx, s);
      onProgress?.(i + 1, this.timeline.length, s.id);
    }
    this.gl.finish();
  }

  target(depth) {
    while (this.targets.length <= depth) this.targets.push(new FBO(this.gl, this.W, this.H));
    return this.targets[depth];
  }

  // HDR target for MB sample slot j at depth (slot 0 is the depth's normal target).
  sampleTarget(depth, j) {
    if (j === 0) return this.target(depth);
    while (this.sampleTargets.length <= depth) this.sampleTargets.push([]);
    const pool = this.sampleTargets[depth];
    while (pool.length < j) pool.push(new FBO(this.gl, this.W, this.H));
    return pool[j - 1];
  }

  accum(depth) {
    while (this.accums.length <= depth) this.accums.push(new PingPong(this.gl, this.W, this.H));
    return this.accums[depth];
  }

  // Which shot owns frame n (the one whose [start,end) contains n).
  shotAt(n) {
    const tl = this.timeline;
    for (let i = 0; i < tl.length; i++) if (n >= tl[i].start && n < tl[i].end) return i;
    return n < 0 ? 0 : tl.length - 1;
  }

  // Motion-blur sample count for shot i at integer in-shot frame fi (0 = off).
  // Stateful shots are exempt: never supersampled.
  mbCount(i, fi) {
    const m = this.timeline[i].module;
    if (m.stateful || typeof m.mb !== 'function') return 0;
    return Math.max(0, Math.floor(Number(m.mb(fi)) || 0));
  }

  // ctx.prevPost that a shot sees before reading s.prevTex: the previous shot's
  // postOut (⊕ defaults) for the first 12 frames after a cut that is not covered
  // by an overlap window (a zero-overlap cut); otherwise null.
  cutPrevPost(i, fi) {
    const s = this.timeline[i];
    if (i === 0 || fi < 0 || fi >= POST_EASE_FRAMES || fi < (s.overlap ?? 0)) return null;
    return mergePost(this.timeline[i - 1].module.postOut ?? {});
  }

  // The previous shot's postOut ⊕ defaults, for a long setPost ease (easeFrames > 12)
  // after ctx.prevPost has ended: in-shot frames ≥ 0 outside the overlap window.
  postOutBefore(i, fi) {
    const s = this.timeline[i];
    if (!(i > 0) || fi < 0 || fi < (s.overlap ?? 0)) return null;
    return mergePost(this.timeline[i - 1].module.postOut ?? {});
  }

  // Build the per-frame state object for shot i at global frame n, sub-frame
  // offset `sub` (frames; motion-blur samples only). `cache` holds the lazily
  // rendered prevTex, shared by all MB samples of one output frame.
  state(i, n, depth, sub = 0, cache = null, mbN = 0, mbK = 0) {
    const s = this.timeline[i];
    const fi = n - s.start;
    const f = fi + sub;
    const t = f / this.fps;
    const self = this;
    const pc = cache ?? { done: false, tex: null, post: null };
    const inWindow = i > 0 && fi < (s.overlap ?? 0) && fi >= -(s.preroll ?? 0);
    return {
      id: s.id, index: i, frame: n, fi, f, t, sub, mbN, mbK, dur: s.dur, local: t / s.dur, g: (n + sub) / this.fps, dt: 1 / this.fps,
      fps: this.fps, tail: n >= s.end, frames: s.end - s.start, overlap: s.overlap ?? 0, inOverlap: inWindow,
      target: this.target(depth),
      // prevTex: output of the previous shot at this same (integer) global frame, rendered on
      // first access and cached for every MB sample of this frame (only while this shot's
      // `overlap` window is active; otherwise null). Reading it sets ctx.prevPost. The
      // nested render saves and restores the caller's GL state (framebuffer, viewport,
      // program, VAO, blend/depth/cull/colorMask, texture units), so it may be read anywhere.
      get prevTex() {
        if (!pc.done) {
          pc.done = true;
          if (inWindow) {
            const saved = self.saveGL();
            try { const r = self.renderShot(i - 1, n, depth + 1); pc.tex = r.tex; pc.post = r.post; } finally { self.restoreGL(saved); }
          }
        }
        if (pc.tex) self.ctx.prevPost = pc.post;
        return pc.tex;
      },
    };
  }

  // GL state a shot may have bound when it reads s.prevTex (restored after the nested render).
  saveGL() {
    const gl = this.gl, units = [];
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    for (let u = 0; u < GL_SAVED_UNITS; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      units.push([gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.TEXTURE_BINDING_3D), gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY)]);
    }
    gl.activeTexture(active);
    const e = cap => gl.isEnabled(cap), P = k => gl.getParameter(k);
    return {
      fb: P(gl.FRAMEBUFFER_BINDING), rfb: P(gl.READ_FRAMEBUFFER_BINDING), vp: P(gl.VIEWPORT), prog: P(gl.CURRENT_PROGRAM),
      vao: P(gl.VERTEX_ARRAY_BINDING), abuf: P(gl.ARRAY_BUFFER_BINDING), active, units,
      blend: e(gl.BLEND), depth: e(gl.DEPTH_TEST), cull: e(gl.CULL_FACE), scissor: e(gl.SCISSOR_TEST),
      bf: [P(gl.BLEND_SRC_RGB), P(gl.BLEND_DST_RGB), P(gl.BLEND_SRC_ALPHA), P(gl.BLEND_DST_ALPHA)],
      be: [P(gl.BLEND_EQUATION_RGB), P(gl.BLEND_EQUATION_ALPHA)], mask: P(gl.COLOR_WRITEMASK), dmask: P(gl.DEPTH_WRITEMASK),
    };
  }
  restoreGL(st) {
    const gl = this.gl, en = (cap, on) => (on ? gl.enable(cap) : gl.disable(cap));
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, st.fb); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, st.rfb);
    gl.viewport(st.vp[0], st.vp[1], st.vp[2], st.vp[3]);
    gl.useProgram(st.prog); gl.bindVertexArray(st.vao); gl.bindBuffer(gl.ARRAY_BUFFER, st.abuf);
    st.units.forEach(([t2, t3, ta], u) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, t2); gl.bindTexture(gl.TEXTURE_3D, t3); gl.bindTexture(gl.TEXTURE_2D_ARRAY, ta); });
    gl.activeTexture(st.active);
    en(gl.BLEND, st.blend); en(gl.DEPTH_TEST, st.depth); en(gl.CULL_FACE, st.cull); en(gl.SCISSOR_TEST, st.scissor);
    gl.blendFuncSeparate(st.bf[0], st.bf[1], st.bf[2], st.bf[3]); gl.blendEquationSeparate(st.be[0], st.be[1]);
    gl.colorMask(st.mask[0], st.mask[1], st.mask[2], st.mask[3]); gl.depthMask(st.dmask);
  }

  // Keep stateful shots' simulations in lockstep: replay from the shot's first
  // frame whenever we jump, so any frame renders identically in isolation.
  ensureState(i, n, depth) {
    const s = this.timeline[i];
    const m = s.module;
    if (!m.stateful) return;
    const first = s.start - (s.preroll ?? 0);
    const target = n;
    if (s.lastStep > target || s.lastStep < first - 1 || s.lastStep === -Infinity) {
      m.reset?.(this.ctx, this.state(i, first, depth));
      s.lastStep = first - 1;
    }
    for (let k = s.lastStep + 1; k <= target; k++) {
      const st = this.state(i, k, depth);
      m.step?.(this.ctx, st);
      s.lastStep = k;
    }
  }

  // Render shot i at global frame n into the depth's HDR target (or, with motion
  // blur, the depth's accumulator). Returns { tex, fbo, post }: the final HDR image
  // and the post params the shot set (for MB, the integer frame's params: sample
  // (N−1)/2 for odd N, which sits exactly on the integer frame; for even N the mean of
  // samples N/2−1 and N/2, at ∓0.25/N, with discrete params from sample N/2).
  // ctx.post / ctx.prevPost of the caller are preserved.
  renderShot(i, n, depth = 0) {
    const s = this.timeline[i], m = s.module, ctx = this.ctx, gl = this.gl;
    this.ensureState(i, n, depth);
    const fi = n - s.start;
    const N = this.mbCount(i, fi);
    const savedPost = ctx.post, savedPrev = ctx.prevPost;
    const cache = { done: false, tex: null, post: null };
    const cutPrev = this.cutPrevPost(i, fi);
    const sample = (sub, k, target) => {
      ctx.post = clonePost();
      ctx.prevPost = cache.tex ? cache.post : cutPrev;
      const st = this.state(i, n, depth, sub, cache, N, k);
      st.target = target;
      // Clean slate each render: shots must not rely on leftover GL state.
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
      target.clear(0, 0, 0, 1);
      m.render(ctx, st);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
      return ctx.post;
    };
    let out, post;
    if (N <= 1) {
      out = this.target(depth);
      post = sample(0, 0, out);
    } else {
      // Each sample renders into its own target; every MB_CHUNK samples (and at the end)
      // one pass folds them into the accumulator's running mean.
      const acc = this.accum(depth), kc = N >> 1, even = N % 2 === 0;
      let done = 0, pBefore = null;
      for (let k = 0; k < N; k++) {
        const slot = k % MB_CHUNK;
        // shutter 0.5: sample k at s.t + ((k+0.5)/N − 0.5)·0.5/60 s
        const p = sample(((k + 0.5) / N - 0.5) * 0.5, k, this.sampleTarget(depth, slot));
        if (even && k === kc - 1) pBefore = p;
        if (k === kc) post = even ? midPost(pBefore, p) : p;
        if (slot === MB_CHUNK - 1 || k === N - 1) {
          const cnt = slot + 1, u = { uCount: cnt, uPrevW: done, uAcc: acc.read.tex };
          for (let j = 0; j < MB_CHUNK; j++) u['uS' + j] = this.sampleTarget(depth, j < cnt ? j : 0).tex;
          ctx.draw(this.avgProg, u, acc, { swap: true });
          done += cnt;
        }
      }
      out = acc.read;
    }
    ctx.post = savedPost; ctx.prevPost = savedPrev;
    return { tex: out.tex, fbo: out, post };
  }

  // Render global frame n to the canvas. Deterministic.
  renderFrame(n) {
    n = Math.max(0, Math.min(this.frames - 1, Math.floor(n)));
    const i = this.shotAt(n);
    const ctx = this.ctx;
    ctx.post = clonePost();
    ctx.prevPost = null;
    ctx.frame = n;
    const r = this.renderShot(i, n, 0);
    ctx.post = r.post;
    let p = r.post;
    if (this.clean) p = { ...p, grain: 0, dither: 0, vignette: 0 };
    let hud = null;
    if (this.hud) { this.hudState = hudState(n, CONFIG, this.hudStarts); hud = this.hud.update(this.hudState); }
    this.post.run(r.tex, p, n, null, hud);
    this.currentFrame = n;
    this.currentShot = this.timeline[i].id;
    this.lastPost = p;
    this.lastHDR = r.fbo;
    return n;
  }
}
