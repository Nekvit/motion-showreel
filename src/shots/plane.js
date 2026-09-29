// plane — FIG. 2 PLANE [168, 264), station 1 (the E). DIRECTION.md §5.3.
//
// Compositing and masking: an E-shaped window shows one Bauhaus composition as three render
// passes. The horizon splits into three VERM lines (168); the outer two fly to ±0.30 and each
// line opens into an arm window (172 / 176 / 180) while the stem wipes in from the left (174):
// the E. Vertical VERM scanlines print the passes in on 16ths — CONTOUR (top, 192), MATTE
// (middle, 198), BEAUTY (bottom, 204) and the stem (210). One linear truck (0.12 H/s) drives the
// composition in every window, so elements cross the arm gaps in registration. 216: the
// composition re-lays out on a spring. 234–240: the arms swell to full frame while their
// compositions slide into registration and a VERM wipe turns every pass into BEAUTY — at the
// 240 snare the frame is one composition. 252–263: the windows collapse to the three BONE
// hairlines `lens` opens on, the stem slides out, and the dot detaches and glides to T_DOT.
//
// Build (plane/glsl.js): one full-resolution pass shades the window geometry and the composition
// (in window space, all three passes from one SDF evaluation). Motion is drawn as flat, hard-edged
// shutter smears wherever the geometry moves: the main pass draws the windows at the shutter's
// end, a scissored SMEAR pass paints the band each moving edge swept (VERM rims; BONE from the
// 252 cascade), the scanlines and the merge wipe are flat VERM streaks and the gliding dot is the
// hull of its start and end discs, so those frames need one sample. Only the re-layout's moving
// composition takes 6 (shaded once per pair of samples), with the CONTOUR arm drawn once, crisp,
// at the frame (line art animates on the frame). The merge wipe carries the registration: behind
// it every window shows the one BEAUTY at yArm 0, ahead of it the arms keep their passes and
// offsets, so nothing slides under a blur. Paper fibre is baked once at init; tags are one canvas.
import * as sys from './_sys.js';
import { FRAG, VERT, NC, SLOT, FIBRE, FIBRE_FRAG, SMEAR_FRAG } from './plane/glsl.js';

const PX = sys.PX;                          // one design px (H)
const C = sys.C_MOD;                        // module, 1/18 H
const XL = -1.3;                            // stem's left end (off-frame); the arms' once merged
const ARM_TUCK = 0.05;                      // arms' left ends sit this far under the stem's right edge
const D2R = Math.PI / 180;
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

// ── timing, LOCAL frames (f = global − 168) ─────────────────────────────────
// windows: 0 stem, 1 top, 2 middle, 3 bottom
const FLY = 10;                             // 168–178: outer lines fly to ±0.30 (outExpo)
const OPEN = [0, 4, 8, 12];                 // 172 / 176 / 180: arms open (outExpo 12f)
const OPEN_DUR = 12;
const STEM = 6, STEM_DUR = 10;              // 174: stem wipes in from the left edge (outExpo 10f)
const SCAN = [42, 24, 30, 36];              // 210 stem, 192 top, 198 middle, 204 bottom (outQuint 6f)
const SCAN_DUR = 6;
const RELAYOUT = 48;                        // 216: spring(3, 0.5); bar rotation outBack
const BAR_DUR = 12, BAR_S = 1.3;
const GRID_STAG = 0.5;                      // grid columns shift right-to-left, 0.5f apart
const MERGE = 66, MERGE_DUR = 6;            // 234–240
const COLL = [84, 84, 87, 90];              // 252 stem out / top, 255 middle, 258 bottom
const COLL_DUR = 5, STEM_OUT_DUR = 6;
const GLIDE = 84, GLIDE_DUR = 9;            // 252–261: the dot glides to T_DOT
const TAGS_OFF = 72;                        // wiped away by 240
const END = 95;                             // 263: the OUT, still
const SMEAR_DEPTH = 16;                     // px: a moving edge's smear reaches at most this far behind it

// ── geometry (H) ────────────────────────────────────────────────────────────
const X_END = [-0.60, 0.60, 0.46, 0.60];    // stem right edge; arms end like letter strokes
const Y_ARM = [0, 0.30, 0, -0.30];
const HH_ARM = 0.11, HH_MERGE = 0.26, STEM_HH = 0.41;
const TRUCK = 0.12;                         // H/s, shared by every window
const COMP = {
  C, COL_C: -0.175, COL_HW: 0.125, COL_HH: 0.41,          // column x ∈ [−0.30, −0.05], as tall as the E
  BAR_HX: 0.35, BAR_HY: 0.015, BAR_R: 0.004,
  GRID_R: 0.006, RING_R: 0.09, RING_HW: 0.003,
};
const DOT_R = 0.16, DOT_X0 = 0.34, DOT_X1 = 0.05;
const TAG = { cap: 0.016, x: -0.58, below: 0.02, tracking: 0.06, words: ['CONTOUR', 'MATTE', 'BEAUTY'] };

export default {
  id: 'plane',

  init(ctx) {
    sys.initSys(ctx);
    this.E = ctx.ease.ease;
    this.spring = ctx.ease.spring;
    this.TD = sys.T_DOT(ctx);
    this.halfW = 0.5 * ctx.aspect;
    this.H = ctx.H;
    this.EDGE = this.halfW + (SMEAR_DEPTH + 6) * PX;   // "full width": past the frame edge by more than rim + smear + AA
    const lib = `${ctx.glsl.common}${sys.SYS_GLSL}`;
    this.progMain = ctx.programVF(VERT, FRAG(lib, COMP), 'plane');
    // before the first scan (168–191) only grounds show: a lighter program
    this.progMainG = ctx.programVF(VERT, FRAG(lib, COMP, true), 'plane:mainG');
    this.progSmear = ctx.program(SMEAR_FRAG(lib), 'plane:smear');
    this.uS0 = new Float32Array(16); this.uS1 = new Float32Array(16);
    this.buildTags(ctx);
    // paper fibre baked once in window space (the texel centres sample w exactly on the lattice)
    { const F = FIBRE;
      this.fibre = ctx.fbo(F.w, F.h);
      const dx = (F.x1 - F.x0) / F.w, dy = (F.y1 - F.y0) / F.h;
      ctx.draw(ctx.program(FIBRE_FRAG(sys.SYS_GLSL), 'plane:fibre'), { uR: [F.x0 + 0 * dx, F.y0 + 0 * dy, F.x1 - F.x0, F.y1 - F.y0] }, this.fibre);
      this.fibreR = [F.x0, F.y0, 1 / (F.x1 - F.x0), 1 / (F.y1 - F.y0)]; }
    // shadow halftone: 8px cells at 35% (§1.4), the dot radius corrected for the AA ramp (as halftone45)
    { const rho = sys.halftoneRho(sys.SHADOW_COVER), w = (1080 / ctx.H) / sys.SHADOW_CELL_PX;
      const k = clamp((0.5 - rho) / (0.5 * w)); this.htRho = Math.sqrt(Math.max(rho * rho - k * w * w / 12, 0)); }
    this.uC = new Float32Array(4 * NC);
    this.cache = ctx.fbo(ctx.W, ctx.H);       // re-layout: one pair of samples' shading
    this.cacheKey = -1;
    this.crisp = ctx.fbo(ctx.W, ctx.H);       // re-layout: the CONTOUR arm at the frame
    this.crispKey = -1;
    this.g = { box: new Float64Array(16), dot: [0, 0, 0] };
    this.gA = { box: new Float64Array(16), dot: [0, 0, 0] };
    this.gB = { box: new Float64Array(16), dot: [0, 0, 0] };
  },

  // Tag atlas: JetBrains Mono 500, cap 0.016 H, uppercase, +6% tracking (the HUD's voice),
  // one row per word, white on transparent; the shader texel-fetches it (crisp, 80% opacity).
  buildTags(ctx) {
    const spec = { family: 'JetBrains Mono', weight: 500 };
    const capPx = TAG.cap * ctx.H;
    const size = capPx / sys.capRatio(ctx, spec);
    const font = ctx.text.font({ ...spec, size });
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const track = TAG.tracking * size;
    const widths = TAG.words.map(w => [...w].reduce((a, ch) => a + probe.measureText(ch).width + track, 0));
    const PAD = 2;
    const rowH = Math.ceil(capPx * 1.25) + 2 * PAD;
    const W = Math.ceil(Math.max(...widths)) + 2 * PAD, Hc = rowH * TAG.words.length;
    const surf = ctx.surface(W, Hc);
    const g = surf.clear();
    g.fillStyle = '#fff'; g.font = font; g.textBaseline = 'alphabetic';
    TAG.words.forEach((w, r) => {
      let x = PAD;
      for (const ch of w) { g.fillText(ch, x, r * rowH + PAD + capPx); x += probe.measureText(ch).width + track; }
    });
    surf.upload();
    this.tag = { surf, rowH, W, Hc, PAD, capPx, rowW: widths.map(w => Math.ceil(w) + 2 * PAD) };
  },

  // ── window geometry at (fractional) local frame f ─────────────────────────
  geom(f, out) {
    const E = this.E, EDGE = this.EDGE, b = out.box;
    const fly = E.outExpo(f / FLY);
    const em = E.outExpo((f - MERGE) / MERGE_DUR);
    const xs = mix(-EDGE, X_END[0], E.outExpo((f - STEM) / STEM_DUR));
    for (let k = 1; k <= 3; k++) {
      const sgn = Math.sign(Y_ARM[k]);
      const yc = sgn * (1.5 * PX + (Math.abs(Y_ARM[k]) - 1.5 * PX) * fly);
      const eo = E.outExpo((f - OPEN[k]) / OPEN_DUR);
      const ec = E.outExpo((f - COLL[k]) / COLL_DUR);
      let hh = HH_ARM * eo + (HH_MERGE - HH_ARM) * em;
      hh += (PX - hh) * ec;
      const xr = mix(mix(EDGE, X_END[k], eo), EDGE, em);
      // the line's left end slides in with the opening (to just under the stem's final edge) until
      // the stem wipes over it; from then on it stays tucked under the stem
      const xo = mix(-EDGE, X_END[0] - ARM_TUCK, eo);
      const xl = mix(xs > xo ? Math.min(xo, xs - ARM_TUCK) : xo, XL, em);
      b[4 * k] = 0.5 * (xl + xr); b[4 * k + 1] = yc; b[4 * k + 2] = 0.5 * (xr - xl); b[4 * k + 3] = hh;
    }
    const slide = 0.30 * E.inQuint((f - COLL[0]) / STEM_OUT_DUR);
    b[0] = 0.5 * (XL + xs) - slide; b[1] = 0; b[2] = 0.5 * (xs - XL); b[3] = STEM_HH;
    this.detDot(f, out.dot);
    return out;
  },

  // Scanline k's leading x at t (local, fractional): from just inside the window's left edge to
  // past its right rim, outQuint over 6f.
  scanFront(k, t) {
    const x0 = (k === 0 ? -this.halfW : X_END[0]) + 1.5 * PX;
    return mix(x0, X_END[k] + 3 * PX, this.E.outQuint(clamp((t - SCAN[k]) / SCAN_DUR)));
  },
  // [trailing, leading] x swept during frame fi's shutter: [−10, −10] before (nothing printed),
  // [10, 10] after (all printed).
  scanBand(k, fi) {
    if (fi + 0.25 <= SCAN[k]) return [-10, -10];
    if (fi - 0.25 >= SCAN[k] + SCAN_DUR) return [10, 10];
    return [this.scanFront(k, fi - 0.25), this.scanFront(k, fi + 0.25)];
  },
  wipeBand(fi) {
    if (fi + 0.25 <= MERGE) return [-10, -10];
    if (fi - 0.25 >= MERGE + MERGE_DUR) return [10, 10];
    const W = t => mix(-this.EDGE - 3 * PX, this.EDGE + 3 * PX, this.E.inOutQuint(clamp((t - MERGE) / MERGE_DUR)));
    return [W(fi - 0.25), W(fi + 0.25)];
  },

  // the composition dot's screen position (window space → screen, after the merge yArm = 0)
  dotX(f) { return mix(DOT_X0, DOT_X1, this.spring((f - RELAYOUT) / 60, 3, 0.5)) - TRUCK * f / 60; },

  // the detached dot: from the (still trucking) composition position to T_DOT, inOutQuint
  detDot(f, out) {
    const E = this.E, u = (f - GLIDE) / GLIDE_DUR, e = E.inOutQuint(u);
    const T = this.TD;
    out[0] = mix(this.dotX(f), T.x, e);
    out[1] = mix(0, T.y, e);
    out[2] = mix(DOT_R, T.r, E.inOutQuint(u));
    return out;
  },

  // The composition's own motion (element positions) at f.
  comp(f) {
    const E = this.E, sp = this.spring;
    const a = sp((f - RELAYOUT) / 60, 3, 0.5);
    const gx = [];
    for (let i = 0; i < 7; i++) gx.push(-0.55 + (i - 3) * sys.C_MOD + sys.C_MOD * sp((f - RELAYOUT - (6 - i) * GRID_STAG) / 60, 3, 0.5));
    return {
      dotX: mix(DOT_X0, DOT_X1, a), ringY: -0.02 + sys.C_MOD * a, gx,
      th: (-30 + 45 * E.outBack((f - RELAYOUT) / BAR_DUR, BAR_S)) * D2R,
    };
  },

  // Does the composition move by more than 1.5px within this frame's shutter? (The truck, 1px per
  // shutter, is ignored.) The window geometry never needs samples: its motion is drawn as smears.
  contentMoving(ctx, fi) {
    if (fi < SCAN[1]) return false;             // only the grounds show
    const a = this.comp(fi - 0.25), b = this.comp(fi + 0.25);
    let d = Math.max(Math.abs(a.dotX - b.dotX), Math.abs(a.ringY - b.ringY), Math.abs(a.th - b.th) * 0.35);
    for (let i = 0; i < 7; i++) d = Math.max(d, Math.abs(a.gx[i] - b.gx[i]));
    // (from the merge on, the spring's last 2–3px per shutter go unblurred: the merge's motion is
    // its smears and the wipe, and a 3px tail can't read under them)
    return d * ctx.H > (fi >= MERGE ? 3.5 : 1.5);
  },

  // Pack the constants: window geometry at fg (the detached dot's disc at fg0 too: the streak
  // runs from fg0 to fg), composition at fc.
  pack(ctx, s, fg, fc, fg0 = fg, motHalf = 0) {
    const E = this.E, H = ctx.H, fi = s.fi;
    const detached = fi >= GLIDE;
    const rimBone = COLL.map(() => (fi >= COLL[0] ? 1 : 0));   // the cascade starts at 252: every exposed rim is a 1px BONE cut from then on
    const C = this.uC, put = (slot, v) => C.set(v, 4 * SLOT[slot]);
    const g = this.geom(fg, this.g);
    const box = [0, 1, 2, 3].map(k => Array.from(g.box.slice(4 * k, 4 * k + 4)));
    box.forEach((b, k) => put('BOX' + k, b));
    put('SCAN', [0, 0, 0, 0]);
    const sb = [0, 1, 2, 3].map(k => this.scanBand(k, fi));
    put('SCANLO', sb.map(v => v[0])); put('SCANHI', sb.map(v => v[1]));
    put('WIPEB', [...this.wipeBand(fi), 0, 0]);
    put('SPARE', [0, 0, 0, 0]);
    put('AUX', [0, g.dot[0], g.dot[1], detached ? g.dot[2] : 0]);
    const d0 = this.detDot(fg0, [0, 0, 0]);
    put('DD', detached ? [d0[0], d0[1], d0[2], 1] : [0, 0, 0, 0]);
    put('FLAT', box.map((b, k) => (rimBone[k] && b[3] < 3 * PX ? 1 : 0)));
    put('RIMB', rimBone);
    put('MISC', [1 / H, H, TRUCK * fc / 60, detached ? 2 * PX * (1 - E.inOutQuint((fg - GLIDE) / GLIDE_DUR)) : 0]);
    const c = this.comp(fc);
    // the arms keep their offsets: the merge wipe registers them (behind it everything is yArm 0)
    put('YARM', [0, 1, 2, 3].map(k => (k ? g.box[4 * k + 1] : 0)));
    put('DOTC', [c.dotX, 0, DOT_R, detached ? 0 : 1]);
    put('BAR', [0, 0.02, Math.cos(c.th), Math.sin(c.th)]);
    put('GRIDA', c.gx.slice(0, 4));
    put('GRIDB', [...c.gx.slice(4), this.htRho]);
    const T = this.tag;
    put('RING', [0.70, c.ringY, T.W, T.rowH]);
    put('FIBR', this.fibreR);
    put('TAGW', [...T.rowW, 0]);
    // the bar's and the dot's travel over ±motHalf frames around fc (sub-sampled in the shader)
    if (motHalf > 0) {
      const c0 = this.comp(fc - motHalf), c1 = this.comp(fc + motHalf);
      put('MOTV', [0.5 * (c1.th - c0.th), 0.5 * (c1.dotX - c0.dotX), 0, 0]);
    } else put('MOTV', [0, 0, 0, 0]);
    // tags: cap top 0.02 below each arm's top edge, pen at x = −0.58 (GL px, rounded: crisp)
    for (let k = 1; k <= 3; k++) {
      const top = g.box[4 * k + 1] + Math.min(g.box[4 * k + 3], HH_ARM);   // pinned once the merge swells the arm
      const ox = Math.round(TAG.x * H + 0.5 * ctx.W - T.PAD);
      const oy = Math.round((top - TAG.below + 0.5) * H - (T.rowH - T.PAD));
      put('TAG' + (k - 1), [ox, oy, T.Hc - k * T.rowH, fi < TAGS_OFF ? 1 : 0]);
    }
  },

  render(ctx, s) {
    const f = s.f, fi = s.fi, H = ctx.H;
    const tex = { uFibre: this.fibre.tex, uTagTex: this.tag.surf.tex };
    const N = s.mbN > 1 ? s.mbN : 1;
    const prog = fi < SCAN[1] ? this.progMainG : this.progMain;
    const smear = fi > 0 && fi < END;
    if (N === 1) {
      // the geometry at the shutter's end; the SMEAR pass paints what its edges swept
      this.pack(ctx, s, smear ? fi + 0.25 : fi, fi, smear ? fi - 0.25 : fi);
      ctx.draw(prog, { uC: this.uC, ...tex }, s.target);
      if (smear) this.renderSmear(ctx, s);
    } else {
      // The re-layout (216–233): the composition moves, the windows are still. Shade it once per
      // pair of samples, at the pair's centre, the bar's and the dot's coverage sub-sampled
      // across both slices (the fastest movers), and reuse it for the pair's second sample.
      const half = 0.25 / N, pair = s.mbK >> 1;
      const tc = N % 2 === 0 ? fi + ((2 * pair + 1) / N - 0.5) * 0.5 : f;
      const key = s.frame + pair / 8, fg = smear ? fi + 0.25 : fi;
      if (this.cacheKey !== key) {
        this.pack(ctx, s, fg, tc, smear ? fi - 0.25 : fi, N % 2 === 0 ? 2 * half : half);
        ctx.draw(prog, { uC: this.uC, ...tex }, this.cache);
        this.cacheKey = key;
      }
      this.blit(ctx, this.cache, s.target);
      if (smear) this.renderSmear(ctx, s);   // the merge's first frames, while the spring settles
      // CONTOUR is line art: its arm is drawn once, at the frame, and pasted into every sample
      const g = this.geom(fi, this.g), W = ctx.W, m = 3 * PX + 2 / H;
      const r = [Math.ceil((g.box[0] + g.box[2]) * H + 0.5 * W), Math.floor((g.box[5] - g.box[7] - m + 0.5) * H),
        Math.ceil((g.box[4] + g.box[6] + m) * H + 0.5 * W), Math.ceil((g.box[5] + g.box[7] + m + 0.5) * H)];
      if (fi < MERGE && this.crispKey !== s.frame) {
        this.pack(ctx, s, fi, fi, fi);
        ctx.draw(prog, { uC: this.uC, ...tex }, this.crisp);
        this.crispKey = s.frame;
      }
      if (fi < MERGE) this.blit(ctx, this.crisp, s.target, r);
    }
    ctx.setPost(s, {});
  },

  // The rim smear: the band each moving window edge sweeps during frame fi's shutter
  // [fi − 0.25, fi + 0.25], up to SMEAR_DEPTH behind its end position, is flat rim colour,
  // scissored to the swept hulls.
  renderSmear(ctx, s) {
    const fi = s.fi, H = ctx.H, W = ctx.W;
    const g0 = this.geom(fi - 0.25, this.gA), g1 = this.geom(fi + 0.25, this.gB);
    const mv = [0, 0, 0, 0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const a = g0.box.subarray(4 * k, 4 * k + 4), b = g1.box.subarray(4 * k, 4 * k + 4);
      this.uS0.set(a, 4 * k); this.uS1.set(b, 4 * k);
      const d = Math.max(Math.abs(a[0] - a[2] - b[0] + b[2]), Math.abs(a[0] + a[2] - b[0] - b[2]), Math.abs(a[1] - a[3] - b[1] + b[3]), Math.abs(a[1] + a[3] - b[1] - b[3]));
      if (d * H < 0.3) continue;
      mv[k] = 1;
      x0 = Math.min(x0, a[0] - a[2], b[0] - b[2]); x1 = Math.max(x1, a[0] + a[2], b[0] + b[2]);
      y0 = Math.min(y0, a[1] - a[3], b[1] - b[3]); y1 = Math.max(y1, a[1] + a[3], b[1] + b[3]);
    }
    if (!mv.some(Boolean)) return;
    const m = 3 * PX;
    const px0 = Math.max(0, Math.floor((x0 - m) * H + 0.5 * W)), px1 = Math.min(W, Math.ceil((x1 + m) * H + 0.5 * W));
    const py0 = Math.max(0, Math.floor((y0 - m + 0.5) * H)), py1 = Math.min(H, Math.ceil((y1 + m + 0.5) * H));
    if (px1 <= px0 || py1 <= py0) return;
    const gl = ctx.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px0, py0, px1 - px0, py1 - py0);
    const d0 = this.detDot(fi - 0.25, [0, 0, 0]), d1 = this.detDot(fi + 0.25, [0, 0, 0]), on = fi >= GLIDE;
    ctx.draw(this.progSmear, { uS0: this.uS0, uS1: this.uS1, uMv: mv, uBone: fi >= COLL[0] ? 1 : 0, uDepth: SMEAR_DEPTH * PX,
      uD0: [d0[0], d0[1], d0[2], 0], uD1: [d1[0], d1[1], on ? d1[2] : 0, 0] }, s.target, { blend: 'premult' });
    gl.disable(gl.SCISSOR_TEST);
  },

  // copy src → dst (optionally only the GL-px rect r = [x0, y0, x1, y1])
  blit(ctx, src, dst, r = null) {
    const gl = ctx.gl, W = ctx.W, H = ctx.H;
    const [x0, y0, x1, y1] = r ? [clamp(r[0], 0, W), clamp(r[1], 0, H), clamp(r[2], 0, W), clamp(r[3], 0, H)] : [0, 0, W, H];
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  },

  // §5.3 MB: 6 on 168–230 and 234–263. Every moving window edge, scanline, the wipe and the
  // gliding dot are drawn as shutter smears (identical in every sample), so samples differ only
  // where the composition itself moves (the re-layout, 216–233): 6 there, else 1 (0 = off).
  // 168 (the IN) and 263 (the OUT) are still.
  mb(f) {
    if (f <= 0 || f >= END) return 0;
    if (!this.E) return 6;
    if (this.stillMemo?.has(f)) return this.stillMemo.get(f);
    const n = this.contentMoving({ H: this.H }, f) ? 6 : 0;
    (this.stillMemo ??= new Map()).set(f, n);
    return n;
  },

  postOut: {},
};
