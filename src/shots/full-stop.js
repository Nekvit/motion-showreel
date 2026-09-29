// full-stop — FIG. 7 FULL STOP [672,900), overlap 12. Title. (DIRECTION.md §5.8)
//
// Four events: resolve (672), skip and windows (720), land with lock and rule (768), role line
// (792); then stillness 812–899. Layout: _sys.nameLayout, INK type on BONE paper with fibre.
//
// Build (full-stop/frag.js): the paper is baked once and blitted; everything else is a small draw
// scissored to the pixels it can touch and blended premultiplied on top (one big shader with the
// worlds inlined compiles badly on SwiftShader, which also runs untaken branches: the glyph program is
// specialised per world). The name is drawn from signed distance fields packed in one atlas
// (full-stop/atlas.js) at wght masters 700/750/800/850/875/900: each glyph is its own draw at its live
// weight (a blend of the two neighbouring masters) about its fixed ink centre, so windows clip to the
// live glyph and their 3px rims are exact; worlds are evaluated only inside open windows, once per
// output frame into a small per-glyph texture that all motion-blur samples read. The role line and
// the year come from a static print atlas (one row per glyph) that the shader slides and
// halftone-prints with per-glyph uniforms. The dot is an analytic ellipse (squash/stretch as a 2×2
// deformation). Fast edges (dot, iris, rule tip) are box-filtered analytically over each motion-blur
// sample's time slice, so the 6 samples join without stepping. Frames whose content is static
// (684–707, 812–899) are rendered once and cached: the cache holds exactly what a fresh render
// produces, so isolated renders are bit-identical.
//
// Deliberate choices where the spec is silent or self-contradictory (see the report):
//  - no key-light halftone shadow on the title (it read as a perforated outline on the poster);
//  - window glyphs relax 900 → 850 (no undershoot) on the type spring from the final takeoff (754),
//    so the 768 slam 850 → 900 is a visible punch rather than a no-op on glyphs already at 900; on the
//    slam the extra weight shows as an ink band inside the (still open) window rims;
//  - the name sits exactly on _sys.nameLayout until the hit (field's dust letters register on it).
//    Archivo 850's K and V touch at the cap line there (a _sys kerning matter), so an optical kern
//    comes in under the slam (768.25–769.3) and holds through the poster; while glyphs are pushed
//    toward wght 900, pairs that would close below 0.035 cap grow apart (this.ex);
//  - the dot lands at 767.75 (every sample of 768 shows the clean squash; the fall smears on 767),
//    the S0 tuck starts at 707.75 (it registers on its cue frame 708);
//  - the window iris opens 0.5f after the touch and is exposed, like the 768 shutter, with a short
//    effective shutter, so its 3px VERM edge stays a hard edge while it moves; the ring likewise;
//  - the 4px rule is snapped to whole pixels (crisp in 4:2:0).
import * as sys from './_sys.js';
import { buildGlyphAtlas, buildRoleAtlas, blendOf } from './full-stop/atlas.js';
import { paperSource, linesSource, glyphSource, worldSource, rowSource, dotSource, dissolveSource } from './full-stop/frag.js';

const F0 = 672;
// Global key frames (§3 cue list / §5.8)
const K = {
  RES_END: 684,     // dissolve done
  SQ0: 707.75,      // the S0 tuck starts (the 708 cue: every MB sample of 708 already squashes)
  HOP: 712,         // hop to glyph 0
  TOUCH0: 720,      // first touch
  OFF: 754,         // final hop takes off
  LANDT: 767.75,    // the dot's contact (every MB sample of 768 shows the landed squash)
  LAND: 768,        // final hit
  SHUT_END: 772,    // windows shut bottom → top, y_b + cap·inQuad((f−768)/4): closed at 772
  RULE_END: 780,
  DIP0: 772,        // the rule's weight dips start here, travelling right → left
  ROLE: 792,
  REST: 800,        // every spring is sub-pixel: snap to the exact rest pose
  STILL: 812,       // stillness (only grain moves)
};
const PXH = 1 / 1080;
const RT2 = Math.SQRT1_2;
const MIN_GAP = 0.036, MIN_GAP900 = 0.035;   // optical minimum ink gaps (cap units) after the hit (850) / at 900
const SLAM0 = 768.25, SLAM1 = 768.75, SLAM2 = 769.3;   // the slam: every MB sample of 768 is the clean landing; 769 all at 900
const SLAM_BAND = 5;                          // px: the slam's extra weight shown as an ink band inside the window rim
const IRIS_LAG = 0.5, IRIS_SMEAR = 2;         // frames / px: the window iris (see draw)
const RING_SMEAR = 1.5;                       // px: the ring's travel inside one frame's shutter, at most
const FINAL_CLEAR = 4;                        // px: the final hop's minimum clearance from the ink

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const outExpo = x => (x = clamp(x), x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const EXPO_N = 1 / (1 - Math.pow(2, -10));   // 1/outExpo(1−): removes outExpo's final 0.1% jump
const outQuint = x => (x = clamp(x), 1 - Math.pow(1 - x, 5));
const inOutSine = x => (x = clamp(x), 0.5 - 0.5 * Math.cos(Math.PI * x));

// Piecewise curve through [frame, value, ease?] keys; the ease (default inOutSine, zero slope at
// both keys) shapes the segment arriving at its key.
function keyCurve(keys) {
  return f => {
    if (f <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [f1, v1, e = inOutSine] = keys[i], [f0, v0] = keys[i - 1];
      if (f <= f1) return f1 > f0 ? lerp(v0, v1, e((f - f0) / (f1 - f0))) : v1;
    }
    return keys[keys.length - 1][1];
  };
}

// Ballistic hop A → B over frames [fa, fb] whose apex is at height apexY: y a parabola (constant
// gravity) with its vertex at apexY; x linear in time, or timed by a power ease (out: the dot is
// carried clear first and drops onto its target, e.g. into a notch; in: it rises out of a notch
// before it travels).
function makeHop(A, B, fa, fb, apexY) {
  const sa = Math.sqrt(Math.max(apexY - A[1], 1e-9)), sb = Math.sqrt(Math.max(apexY - B[1], 1e-9));
  return { A, B, fa, fb, D: fb - fa, a: 2 * sa * (sa + sb), b: -(sa + sb) * (sa + sb), ease: 'lin', p: 1 };
}
function xEase(kind, p, u, k = 0) {       // [E(u), E'(u)]
  // carry: an out-ease blended with linear, so x still moves at k × the mean speed on arrival
  if (kind === 'carry') return [(1 - k) * (1 - Math.pow(1 - u, p)) + k * u, (1 - k) * p * Math.pow(1 - u, p - 1) + k];
  if (kind === 'out') return [1 - Math.pow(1 - u, p), p * Math.pow(1 - u, p - 1)];
  if (kind === 'in') return [Math.pow(u, p), p * Math.pow(u, p - 1)];
  if (kind === 'inout') return u < 0.5 ? [0.5 * Math.pow(2 * u, p), p * Math.pow(2 * u, p - 1)] : [1 - 0.5 * Math.pow(2 * (1 - u), p), p * Math.pow(2 * (1 - u), p - 1)];
  return [u, 1];
}
function hopAt(h, f) {
  const u = clamp((f - h.fa) / h.D), [xe, dxe] = xEase(h.ease, h.p, u, h.k);
  return {
    x: lerp(h.A[0], h.B[0], xe), y: h.A[1] + h.a * u + h.b * u * u,
    vx: (h.B[0] - h.A[0]) * dxe / h.D, vy: (h.a + 2 * h.b * u) / h.D,     // H per frame
  };
}

// Symmetric 2×2 stretch s1 along unit axis a, s2 across it, as [m00, m10, m01, m11] (column-major).
function axisScale(ax, ay, s1, s2) {
  return [s1 * ax * ax + s2 * ay * ay, (s1 - s2) * ax * ay, (s1 - s2) * ax * ay, s1 * ay * ay + s2 * ax * ax];
}
function mul2(A, B) {   // column-major 2×2
  return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3]];
}
// Scissor box [x, y, w, h] (GL px, bottom-left origin) covering [x0, x1] × [y0, y1], clipped to the frame.
function pxBox(x0, y0, x1, y1, W, H) {
  const a = clamp(Math.floor(x0) - 1, 0, W), b = clamp(Math.floor(y0) - 1, 0, H);
  const c = clamp(Math.ceil(x1) + 1, 0, W), d = clamp(Math.ceil(y1) + 1, 0, H);
  return [a, b, Math.max(0, c - a), Math.max(0, d - b)];
}
function copyFBO(gl, src, dst) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
  gl.blitFramebuffer(0, 0, src.w, src.h, 0, 0, dst.w, dst.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
function inv2(M) {
  const det = M[0] * M[3] - M[2] * M[1];
  return [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
}
// unit gradient of a glyph's 850 field (pen-relative cap units)
function gradD(meta, qx, qy, e = 0.002) {
  const gx = sys.glyphD(meta, qx + e, qy) - sys.glyphD(meta, qx - e, qy);
  const gy = sys.glyphD(meta, qx, qy + e) - sys.glyphD(meta, qx, qy - e);
  const l = Math.hypot(gx, gy) || 1;
  return [gx / l, gy / l];
}

export default {
  id: 'full-stop',

  init(ctx) {
    sys.initSys(ctx);
    const N = this.N = sys.nameLayout(ctx);
    const spring = this.spring = ctx.ease.spring;
    const n = N.n, cap = N.cap, yb = N.yb, r = N.dot.r, rCap = r / cap;
    const W = ctx.W, H = ctx.H, X = x => W / 2 + x * H, Y = y => H / 2 + y * H;

    // ── glyph fields; optical spacing; per-glyph scissor boxes ──
    this.atlas = buildGlyphAtlas(ctx, N.letters);
    this.space();
    this.glyphBox = N.glyphs.map((g, i) => {
      const s9 = this.atlas.slot(g.ch, 900), m = 4 * PXH;
      const cs = [0, 1].flatMap(kf => [this.cxAt(i, 850, kf), this.cxAt(i, 900, kf)]);
      const c0 = Math.min(...cs), c1 = Math.max(...cs);
      return pxBox(X(c0 + (s9.inkX0 - s9.inkCx) * cap - m), Y(yb + g.meta.inkY0 * cap - m), X(c1 + (s9.inkX1 - s9.inkCx) * cap + m), Y(yb + g.meta.inkY1 * cap + m), W, H);
    });

    // ── touches: contact normals (from the 850 field) and iris centres (contact points) ──
    // A touch on the centre line that lands on one wall of a symmetric notch (Archivo's V) rests
    // where the dot touches BOTH walls instead (§8.2, notchRestXY) and squeezes between them.
    this.touch = N.touches.map((t, i) => {
      const meta = N.glyphs[i].meta, qx = meta.inkCx, qy = (t.y - yb) / cap;
      const nrm = gradD(meta, qx, qy);
      let x = t.x, y = t.y, walls = null;
      if (Math.abs(nrm[0]) > 0.3) {
        const nr = sys.notchRestXY(meta, rCap);
        if (Math.abs(nr.dx) < 0.03) {
          const gL = gradD(meta, nr.x - 0.35 * rCap, nr.y), gR = gradD(meta, nr.x + 0.35 * rCap, nr.y);
          if (gL[0] > 0.3 && gR[0] < -0.3 && Math.abs(gL[0] + gR[0]) < 0.3 && Math.abs(gL[1] - gR[1]) < 0.3 && gL[1] > 0.1 && gR[1] > 0.1) {
            walls = [0.5 * (gL[0] - gR[0]), 0.5 * (gL[1] + gR[1])];
            x += nr.dx * cap; y = yb + nr.y * cap;
          }
        }
      }
      const cxI = walls ? x : x - r * nrm[0], cyI = walls ? y - r : y - r * nrm[1];
      return { f: t.frame, x, y, n: nrm, walls, cx: cxI, cy: cyI };
    });
    const T = this.touch, last = n - 1, TL = T[last].f;

    // ── the dot's path: hops (§5.8) ─────────────────────────────────────────
    const S0 = [N.S0.x, N.S0.y], P = T.map(t => [t.x, t.y]), DOT = [N.dot.x, N.dot.y];
    this.hops = [makeHop(S0, P[0], K.HOP, T[0].f, Math.max(S0[1], P[0][1]) + 0.06)];
    for (let i = 0; i < last; i++) this.hops.push(makeHop(P[i], P[i + 1], T[i].f, T[i + 1].f, Math.max(P[i][1], P[i + 1][1]) + 0.035));
    this.finalHop = makeHop(P[last], DOT, K.OFF, K.LANDT, 0.30);
    this.hops.push(this.finalHop);
    // contact deformations: sigma(f) along the contact normal (sigma 1 = sx 1.2 / sy 0.8)
    const up = [0, 1], cdef = i => (T[i].walls ? { walls: T[i].walls } : { n: T[i].n });
    const outCubic = x => 1 - Math.pow(1 - clamp(x), 3);
    this.contacts = [{ f0: K.SQ0, f1: K.HOP + 1, n: up, An: 0.2, At: 0.2, s: keyCurve([[K.SQ0, 0], [K.SQ0 + 2.75, 1, outQuint], [K.HOP, -0.3], [K.HOP + 1, 0]]) }];
    for (let i = 0; i < last; i++) this.contacts.push({ f0: T[i].f - 1, f1: T[i].f + 1, ...cdef(i), An: 0.2, At: 0.2, s: keyCurve([[T[i].f - 1, 0], [T[i].f, 1], [T[i].f + 1, 0]]) });
    const settle = Math.min(TL + 1.5, 751.5);
    const lastKeys = [[TL - 1, 0], [TL, 1], [settle, 0.45]];
    if (settle < 751) lastKeys.push([751, 0.45]);
    lastKeys.push([753.2, 1, outCubic], [K.OFF, -0.3], [K.OFF + 1, 0]);
    this.contacts.push({ f0: TL - 1, f1: K.OFF + 1, ...cdef(last), An: 0.2, At: 0.2, s: keyCurve(lastKeys) });
    this.landing = { f0: K.LANDT, n: up, An: 0.28, At: 0.30, s: f => 1 - spring((f - K.LANDT) / 60, 4, 0.5) };

    // The dot touches ink only at its touches. Every touch-and-go hop keeps x linear in time (the
    // same near-constant horizontal pace through the whole skip); if its flight would graze the live
    // ink, its apex is raised in small steps instead. The final hop keeps x as close to linear as
    // clears the last glyph by FINAL_CLEAR px (at most a mild out-ease), so the dot arrives on a
    // diagonal with carried momentum; only then is its apex raised.
    const finList = [['lin', 1, 0], ['carry', 3, 0.45], ['carry', 3, 0.4], ['carry', 3, 0.35], ['carry', 3, 0.3], ['carry', 4, 0.3], ['carry', 4, 0.25], ['carry', 4, 0.2], ['out', 2, 0], ['out', 2.5, 0]];
    this.hopClear = this.hops.map(h => {
      const fin = h === this.finalHop, list = fin ? finList : [['lin', 1, 0]];
      const need = fin ? FINAL_CLEAR * PXH : -2.5 * PXH, base = [h.a, h.b];
      const apex0 = h.A[1] + base[0] * base[0] / (-4 * base[1]);
      // candidates in order of preference: linear x with the apex raised up to +0.03; then (a notch
      // cannot be entered sideways at constant x speed) x linear until the last few % of the hop
      // (out 1.15…1.5: E'(0.9) ≥ 0.8), with the apex raised up to +0.08
      const cand = [];
      if (fin) for (let bump = 0; bump <= 0.0301; bump += 0.01) for (const [e, p, k] of list) cand.push([bump, e, p, k]);   // apex 0.30 first
      else {
        for (let bump = 0; bump <= 0.0301; bump += 0.005) cand.push([bump, 'lin', 1, 0]);
        for (let bump = 0; bump <= 0.0801; bump += 0.005) for (const p of [1.15, 1.3, 1.5]) for (const e of ['out', 'in']) cand.push([bump, e, p, 0]);
      }
      let best = null;
      for (const [bump, e, p, k] of cand) {
        Object.assign(h, makeHop(h.A, h.B, h.fa, h.fb, apex0 + bump));
        {
          h.ease = e; h.p = p; h.k = k;
          const c = this.hopClearance(h, fin ? 1 : 0.15);
          if (!best || c.min > best.c.min) best = { e, p, k, c, a: h.a, b: h.b };
          if (c.min >= need) { h.bump = bump; return c; }
        }
      }
      Object.assign(h, { ease: best.e, p: best.p, k: best.k, a: best.a, b: best.b });
      console.warn(`full-stop: the hop f${h.fa}–${h.fb} grazes glyph ${best.c.i} at f${best.c.f.toFixed(2)} (${(best.c.min * H).toFixed(1)}px)`);
      return best.c;
    });

    // ── rule and the weight dips it triggers ────────────────────────────────
    const R = N.rule;
    const yPx = (0.5 - R.y) * H, half = 2 * ctx.scale;
    this.ruleY = 0.5 - (Math.round(yPx - half) + half) / H;             // pixel-aligned 4px rule
    // §5.8: glyph i dips from max(t_pass,i, 772). The tip passes most centres before 772, so a small
    // right → left stagger (≤ 0.4f per glyph) keeps the wave travelling with the rule
    const dstep = n > 1 ? Math.min(0.4, 2 / (n - 1)) : 0;
    const tPass = cx => K.LAND - 12 * Math.log2(Math.max(1e-6, 1 - clamp((R.x1 - cx) / (R.x1 - R.x0)))) / 10;
    this.dip0 = N.glyphs.map((g, i) => Math.max(tPass(g.cx), K.DIP0 + (n - 1 - i) * dstep));

    // ── role line and year ──────────────────────────────────────────────────
    this.roleAtlas = buildRoleAtlas(ctx, N);
    const nc = [...N.role.text].length;
    this.roleStep = nc > 1 ? Math.min(1.5, 8 / (nc - 1)) : 0;

    // ── programs, baked paper, world cache, static-frame cache ──────────────
    this.progPaper = ctx.program(paperSource(ctx), 'full-stop:paper');
    this.progLines = ctx.program(linesSource(ctx), 'full-stop:lines');
    // the glyph program specialised per world (-1: plain ink); SwiftShader runs untaken branches masked
    this.progGlyph = [-1, 0, 1, 2, 3, 4, 5].map(w => ctx.program(glyphSource(ctx, w), 'full-stop:glyph' + w));
    this.progWorld = [0, 1, 2, 3, 4, 5].map(w => ctx.program(worldSource(ctx, w), 'full-stop:world' + w));
    this.progRow = ctx.program(rowSource(ctx), 'full-stop:row');
    this.progDot = ctx.program(dotSource(ctx), 'full-stop:dot');
    this.progDiss = ctx.program(dissolveSource(ctx), 'full-stop:dissolve');
    this.glyphStatic = { uAtlas: this.atlas.tex, uAtlasInv: [1 / this.atlas.W, 1 / this.atlas.H] };
    this.rowStatic = { uRole: this.roleAtlas.surf.tex, uRoleSize: [this.roleAtlas.cw, this.roleAtlas.ch], uRoleX0: this.roleAtlas.X0, uRoleRH: this.roleAtlas.RH, uMaskY: this.ruleY - 3 * PXH };
    // worlds change slowly: each open window's world is evaluated once per output frame into a
    // texture the size of the glyph's box, and every MB sample of that frame reads it
    this.worldFbo = this.glyphBox.map(b => ctx.fbo(Math.max(1, b[2]), Math.max(1, b[3])));
    this.worldKey = this.glyphBox.map(() => null);
    this.paper = ctx.fbo(W, H);
    ctx.draw(this.progPaper, {}, this.paper);
    this.cache = ctx.fbo(W, H);
    this.cacheKey = null;
  },

  // Optical spacing. this.dxK[i]: the post-hit kern shift of glyph i. this.ex[kf][k]: extra
  // separation the pair (k, k+1) needs at wght 900 (without / with the kern), applied in proportion
  // to each glyph's weight above 850.
  space() {
    const N = this.N, n = N.n, cap = N.cap;
    this.dxK = new Array(n).fill(0);
    this.ex = [0, 1].map(() => new Array(Math.max(n - 1, 0)).fill(0));
    const gaps = (w, kf) => [...Array(n - 1)].map((_, k) => this.gap(k, w, this.cxAt(k, w, kf), w, this.cxAt(k + 1, w, kf)));
    this.gap850 = n > 1 ? gaps(850, 0) : [];
    // Until the hit the name sits exactly on _sys.nameLayout (field's dust letters register on it
    // through the dissolve). Archivo 850's K–V pair touches at the cap line there, so an optical kern
    // (this.dxK: pairs closer than MIN_GAP cap are opened, the space taken from the loosest pairs,
    // glyphs 0 and n−1 fixed) comes in under the 768 slam and holds through the poster.
    for (let it = 0; it < 4 && n >= 3; it++) {
      const g = gaps(850, 1), need = g.map(v => Math.max(0, MIN_GAP * cap - v));
      const tot = need.reduce((a, b) => a + b, 0);
      if (tot < 0.05 * PXH) break;
      const slack = g.map((v, k) => (need[k] > 0 ? 0 : Math.max(0, v - 2 * MIN_GAP * cap)));
      const S = slack.reduce((a, b) => a + b, 0);
      if (S <= 0) break;
      const give = Math.min(tot, S);
      let acc = 0;
      for (let k = 0; k < n - 1; k++) { acc += need[k] * (give / tot) - slack[k] * (give / S); this.dxK[k + 1] += acc; }
      this.dxK[n - 1] = 0;
    }
    for (const kf of [0, 1]) for (let it = 0; it < 2 && n >= 2; it++) {
      const g = gaps(900, kf);
      g.forEach((v, k) => { this.ex[kf][k] += Math.max(0, MIN_GAP900 * cap - v); });
    }
    this.gapNow = n > 1 ? { g850: gaps(850, 0), g900: gaps(900, 0), g850K: gaps(850, 1), g900K: gaps(900, 1) } : null;
  },

  // Ink centre x of glyph i at live weight w, with the optical kern in by kf (0 before the hit, 1 after).
  cxAt(i, w, kf = 0) {
    const t = clamp((w - 850) / 50), e0 = this.ex[0], e1 = this.ex[1];
    const ex = k => lerp(e0[k], e1[k], kf);
    const push = t * (0.5 * (i > 0 ? ex(i - 1) : 0) - 0.5 * (i < e0.length ? ex(i) : 0));
    return this.N.glyphs[i].cx + kf * this.dxK[i] + push;
  },
  kern(f) { return f <= SLAM0 ? 0 : inOutSine((f - SLAM0) / (SLAM2 - SLAM0)); },   // in with the slam, at rest by 769.3

  // Minimum ink gap (H) between glyphs k and k+1 at weights wi, wj with ink centres ci, cj:
  // min over points of d_i + d_j (the two distances meet on the segment between the closest points).
  gap(k, wi, ci, wj, cj) {
    const N = this.N, cap = N.cap, yb = N.yb, A = this.atlas, gi = N.glyphs[k], gj = N.glyphs[k + 1];
    const si = A.slot(gi.ch, 900), sj = A.slot(gj.ch, 900);
    const R = ci + (si.inkX1 - si.inkCx) * cap, L = cj + (sj.inkX0 - sj.inkCx) * cap;
    const x0 = Math.min(R, L) - 0.12 * cap, x1 = Math.max(R, L) + 0.12 * cap;
    const y0 = N.yb + Math.min(gi.meta.inkY0, gj.meta.inkY0) * cap, y1 = N.yb + Math.max(gi.meta.inkY1, gj.meta.inkY1) * cap;
    const D = (x, y) => (A.dist(gi.ch, wi, (x - ci) / cap, (y - yb) / cap) + A.dist(gj.ch, wj, (x - cj) / cap, (y - yb) / cap)) * cap;
    let best = Infinity, bx = 0, by = 0;
    const h = 2 * PXH;
    for (let y = y0; y <= y1; y += h) for (let x = x0; x <= x1; x += h) { const d = D(x, y); if (d < best) { best = d; bx = x; by = y; } }
    for (let s = h / 2; s > 0.05 * PXH; s /= 2) for (let rep = 0; rep < 3; rep++) {
      for (const [ox, oy] of [[s, 0], [-s, 0], [0, s], [0, -s]]) { const d = D(bx + ox, by + oy); if (d < best) { best = d; bx += ox; by += oy; } }
    }
    return best;
  },

  // Smallest distance (H) between the flying dot (flight shape: its largest semi-axis) and the live
  // ink over hop h, away from its two contacts (skip0 frames after takeoff): {min, f, i}.
  hopClearance(h, skip0 = 0.15) {
    const N = this.N, cap = N.cap, yb = N.yb, A = this.atlas, r = N.dot.r;
    let res = { min: Infinity, f: h.fa, i: -1 };
    for (let f = h.fa + skip0; f <= h.fb - 0.15; f += 0.05) {
      const s = hopAt(h, f), sp = Math.hypot(s.vx, s.vy);
      const env = clamp((f - h.fa) / 1.2) * clamp((h.fb - f) / 0.6);
      const smax = 1 + Math.min(0.16, 2.0 * sp) * env;
      for (let i = 0; i < N.n; i++) {
        const w = this.weight(i, f), g = N.glyphs[i];
        const dd = A.dist(g.ch, w, (s.x - this.cxAt(i, w)) / cap, (s.y - yb) / cap) * cap - r * smax;
        if (dd < res.min) res = { min: dd, f, i };
      }
    }
    return res;
  },

  // Live weight of glyph i at global frame f (clamped to the axis range the atlas covers).
  weight(i, f) {
    if (f >= K.REST) return 850;
    const spring = this.spring, Ti = this.touch[i].f;
    const win = g => {                 // window: type-axis spring to 900 from the touch; relaxes from the final takeoff
      if (g < Ti) return 0;
      let a = Math.min(spring((g - Ti) / 60, 3.5, 0.45), 1);
      if (g > K.OFF) a = Math.max(0, a - spring((g - K.OFF) / 60, 3.5, 0.45));   // relaxes to 850, never thinner
      return 50 * a;
    };
    let w;
    if (f < K.LAND) w = 850 + win(f);
    else {
      // the slam: → 900 over 768.25–768.75, held through every MB sample of 769, released with spring(4, 0.5)
      w = f < SLAM1 ? lerp(850 + win(K.LAND), 900, clamp((f - SLAM0) / (SLAM1 - SLAM0))) : f < SLAM2 ? 900 : 850 + 50 * (1 - spring((f - SLAM2) / 60, 4, 0.5));
      const t0 = this.dip0[i];
      if (f > t0 && f < t0 + 10) w -= 150 * Math.pow(Math.sin(Math.PI * (f - t0) / 10), 2);
    }
    return clamp(w, 700, 900);
  },

  // The dot at global frame f: {x, y, M (2×2, disc → ellipse)}.
  dot(f) {
    const N = this.N, r = N.dot.r;
    let x, y, vx = 0, vy = 0, env = 0;
    const T = this.touch, last = T.length - 1;
    if (f < K.HOP) { x = N.S0.x; y = N.S0.y; }
    else if (f >= K.LANDT) { x = N.dot.x; y = N.dot.y; }
    else if (f >= T[last].f && f < K.OFF) { x = T[last].x; y = T[last].y; }
    else {
      const h = this.hops.find(h => f >= h.fa && f < h.fb) || this.finalHop;
      const s = hopAt(h, f);
      x = s.x; y = s.y; vx = s.vx; vy = s.vy;
      env = clamp((f - h.fa) / 1.2) * clamp((h.fb - f) / 0.6);
    }
    // flight: stretch along the velocity (volume-preserving)
    let M = [1, 0, 0, 1];
    const sp = Math.hypot(vx, vy);
    if (sp > 1e-6 && env > 0) {
      const lam = Math.min(0.16, 2.0 * sp) * env;
      M = axisScale(vx / sp, vy / sp, 1 + lam, 1 / (1 + lam));
    }
    // contact: squash along the contact normal, anchored at the contact point; in a notch the dot
    // is squeezed between both walls (narrower and taller) and stays tangent to them
    let c = null, sig = 0;
    if (f >= K.LANDT) { if (f < K.REST) { c = this.landing; sig = c.s(f); } }
    else for (const k of this.contacts) if (f >= k.f0 && f <= k.f1) { c = k; sig = k.s(f); break; }
    if (c && sig !== 0) {
      if (c.walls) {
        const sx = 1 - 0.16 * sig, sy = 1 / sx, [wx, wy] = c.walls;
        M = mul2([sx, 0, 0, sy], M);
        y += r * (Math.hypot(sx * wx, sy * wy) - 1) / wy;
      } else {
        const sn = 1 - c.An * sig, st = 1 + c.At * sig;
        M = mul2(axisScale(c.n[0], c.n[1], sn, st), M);
        x -= c.n[0] * r * (1 - sn); y -= c.n[1] * r * (1 - sn);
      }
    }
    return { x, y, M };
  },

  mb(fi) {
    const g = F0 + fi;
    return (g >= 708 && g <= 784) || (g >= K.ROLE && g < K.STILL) ? 6 : 0;
  },

  postOut: { bloom: 0.15, vignette: 0.08 },

  render(ctx, s) {
    const prev = s.inOverlap ? s.prevTex : null;
    const f = Math.min(F0 + s.f, K.STILL);           // global frame (fractional under MB); still from 812
    ctx.setPost(s, { bloom: 0.15, vignette: 0.08 });
    // static frames: reading time (684–707) and the poster (812–899) are rendered once
    const key = f >= K.STILL ? 'still' : (f >= K.RES_END && f < K.SQ0 ? 'read' : null);
    if (key && key === this.cacheKey) { copyFBO(ctx.gl, this.cache, s.target); return; }
    this.draw(ctx, s, f, prev);
    if (key) { copyFBO(ctx.gl, s.target, this.cache); this.cacheKey = key; }
  },

  draw(ctx, s, f, prev) {
    const gl = ctx.gl, W = ctx.W, H = ctx.H, X = x => W / 2 + x * H, Y = y => H / 2 + y * H;
    const N = this.N, cap = N.cap, yb = N.yb, n = N.n, A = this.atlas;
    const frame = Math.min(s.frame, K.STILL);
    const premult = { blend: 'premult' };
    // the time slice this render stands for: one MB sample covers 0.5/N frames (shutter 0.5);
    // fast edges are box-filtered over it analytically (sweepIn) so the samples join seamlessly
    const slice = s.mbN >= 2 && f < K.STILL ? 0.5 / s.mbN : 0;
    const fa = f - 0.5 * slice, fb = f + 0.5 * slice;

    // ── worlds of the open windows, once per output frame (before the frame's first draw) ──
    const open = i => { const t = this.touch[i]; return frame >= t.f - 1 && fb >= t.f && frame < K.SHUT_END; };
    for (let i = 0; i < n; i++) {
      if (!open(i) || this.worldKey[i] === frame) continue;
      const b = this.glyphBox[i], wFrame = Math.max(frame, this.touch[i].f);
      ctx.draw(this.progWorld[i % 6], {
        uBox: [b[0], b[1], b[2], b[3]], uFull: [W, H], uQ0: [this.cxAt(i, 850), yb + 0.5 * cap],
        uT: wFrame / 60, uTL: (wFrame - this.touch[i].f) / 60,
      }, this.worldFbo[i]);
      this.worldKey[i] = frame;
    }

    copyFBO(gl, this.paper, s.target);
    gl.enable(gl.SCISSOR_TEST);
    try {
      // ── the ring (769–779, under the type) and the rule ──
      if (fb >= K.LAND) {
        const R = N.rule;
        const tipAt = g => R.x1 - (R.x1 - R.x0) * outExpo((g - K.LAND) / 12);   // zips from the dot to inkLeft
        const uRule = [this.ruleY, 2 * PXH, tipAt(fa), tipAt(fb)];
        if (frame > K.LAND && frame < K.RULE_END) this.drawRing(ctx, s, frame, fa, f, fb, uRule);
        gl.scissor(...pxBox(X(Math.min(uRule[2], uRule[3])), Y(this.ruleY - 3 * PXH), X(R.x1), Y(this.ruleY + 3 * PXH), W, H));
        ctx.draw(this.progLines, { uRing: [0, 0, 0, 0], uRingW: 0, uRule, uRuleX1: R.x1, uRuleOn: 1 }, s.target, premult);
      }

      // ── the name: each glyph at its live weight; windows ──
      // the shutter (§5.8): visible only above y_b + cap·inQuad((f−768)/4); like the iris, exposed
      // with a short effective shutter (≤ IRIS_SMEAR px of travel) so its 3px VERM edge stays hard
      const shutAt = g => yb + cap * Math.pow(clamp((g - K.LAND) / 4), 2);
      const sSpeed = cap * 2 * clamp((frame - K.LAND) / 4) / 4;                  // H per frame
      const skT = sSpeed > 0 ? Math.min(1, IRIS_SMEAR * PXH / (0.5 * sSpeed)) : 1;
      const shutT = g => frame + (g - frame) * skT;
      const uShut = [shutAt(shutT(fa)), shutAt(shutT(fb)), fb > K.LAND ? 1 : 0, 0];
      for (let i = 0; i < n; i++) {
        const g = N.glyphs[i], w = this.weight(i, f), kf = this.kern(f), c = this.cxAt(i, w, kf);
        const { wa, wb, k } = blendOf(w);
        const sa = A.slot(g.ch, wa), sb = A.slot(g.ch, wb);
        const t = this.touch[i], on = open(i);
        // the iris: 0 → 0.26 outExpo over 8f from t.f + IRIS_LAG, exposed with a short effective
        // shutter (≤ IRIS_SMEAR px of travel per frame) so its 3px VERM edge stays a hard rimmed edge
        const irisF = h => (h > t.f + IRIS_LAG ? 0.26 * outExpo((h - t.f - IRIS_LAG) / 8) : 0);
        const iu = (frame - t.f - IRIS_LAG) / 8;
        const iSpeed = iu > -0.0625 ? 0.26 * 10 * Math.LN2 / 8 * Math.pow(2, -10 * Math.max(iu, 0)) : 0;   // H per frame
        const ikT = iSpeed > 0 ? Math.min(1, IRIS_SMEAR * PXH / (0.5 * iSpeed)) : 1;
        const iris = h => irisF(frame + (h - frame) * ikT);
        const b = this.glyphBox[i];
        gl.scissor(...b);
        ctx.draw(this.progGlyph[on ? 1 + (i % 6) : 0], {
          ...this.glyphStatic,
          uPA: [sa.penX, sa.penY, sa.inkCx, k], uRA: [sa.x0, sa.y0, sa.x1, sa.y1],
          uPB: [sb.penX, sb.penY, sb.inkCx, 0], uRB: [sb.x0, sb.y0, sb.x1, sb.y1],
          uG: [c, yb, cap, i % 6],
          uGI: [t.cx + c - this.cxAt(i, 850), t.cy, iris(fa), iris(fb)],
          uShut, uWorld: this.worldFbo[i], uBox: [b[0], b[1], b[2], b[3]],
          uSlam: f >= K.LAND ? SLAM_BAND * PXH * clamp((w - 850) / 50) : 0,
          uWorldDx: (c - this.cxAt(i, 850)) * H,
        }, s.target, premult);
      }

      // ── role line (print-in, 792–812) and year (type-on 792, 795, 798, 801) ──
      // gated on the integer frame: every sample of 792 shows the year's first digit
      if (frame >= K.ROLE) {
        for (const row of this.roleAtlas.rows) {
          let rho = RT2 + 1e-4, slide = 0;
          if (row.kind === 'role') {
            const tau = f - (K.ROLE + row.idx * this.roleStep);
            if (tau <= 0) continue;
            if (tau < 8) rho = RT2 * outQuint(tau / 8);
            slide = 0.045 * Math.max(0, 1 - outExpo(tau / 12) * EXPO_N);   // normalised: lands exactly at rest
          } else if (frame < K.ROLE + 3 * row.idx) continue;
          gl.scissor(...pxBox(row.x0, H - row.bot, row.x1, H - row.top + slide * H, W, H));
          ctx.draw(this.progRow, { ...this.rowStatic, uRow: [row.dY, slide * H, row.rowTop, rho], uSlideH: slide }, s.target, premult);
        }
      }

      // ── the dot: four sub-positions inside this sample's time slice ──
      const uDotC = [], uDotM = [];
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let j = 0; j < 4; j++) {
        const d = this.dot(f + ((j + 0.5) / 4 - 0.5) * slice), M = d.M;
        uDotC.push(d.x, d.y, N.dot.r, 0); uDotM.push(...inv2(M));
        const ex = N.dot.r * Math.hypot(M[0], M[2]) + 3 * PXH, ey = N.dot.r * Math.hypot(M[1], M[3]) + 3 * PXH;
        bx0 = Math.min(bx0, d.x - ex); bx1 = Math.max(bx1, d.x + ex); by0 = Math.min(by0, d.y - ey); by1 = Math.max(by1, d.y + ey);
      }
      gl.scissor(...pxBox(X(bx0), Y(by0), X(bx1), Y(by1), W, H));
      ctx.draw(this.progDot, { uDotC, uDotM }, s.target, premult);
    } finally {
      gl.disable(gl.SCISSOR_TEST);
    }

    // ── 672–683: the halftone-cell dissolve over field's frame ──
    if (prev && f < K.RES_END) ctx.draw(this.progDiss, { uPrev: prev, uDiss: [f, 1, N.S0.x, N.S0.y] }, s.target, premult);
  },

  // The f768 ring: r 0.034 → 0.30 over 768–780 (outExpo), born under the dot, passing under the
  // type. Its width tapers 3px → 0 on linear time (a taper while it still moves, full VERM coverage
  // while it is fast). Each frame is exposed with a short effective shutter (≤ RING_SMEAR px of
  // travel), so it reads as a crisp VERM ring, not as a motion-blurred haze.
  drawRing(ctx, s, frame, fa, f, fb, uRule) {
    const gl = ctx.gl, W = ctx.W, H = ctx.H, X = x => W / 2 + x * H, Y = y => H / 2 + y * H, N = this.N;
    const L = 0.30 - N.dot.r;
    const ring = g => N.dot.r + L * outExpo((g - K.LAND) / 12);
    const speed = L * 10 * Math.LN2 / 12 * Math.pow(2, -10 * (frame - K.LAND) / 12);   // H per frame
    const kT = Math.min(1, RING_SMEAR * PXH / (0.5 * speed));
    const tau = g => frame + (g - frame) * kT;
    const u = clamp((tau(f) - K.LAND) / 12);
    const w = 3 * PXH * (1 - u * u * u);
    if (w <= 1e-6) return;
    const r0 = ring(tau(fa)), r1 = ring(tau(fb));
    const lo = Math.min(r0, r1) - w - 2 * PXH, hi = Math.max(r0, r1) + w + 2 * PXH, m = hi;
    const uu = { uRing: [N.dot.x, N.dot.y, r0, r1], uRingW: w, uRule, uRuleX1: N.rule.x1, uRuleOn: 0 };
    // draw only the tiles of the ring's box that the annulus touches (exact, non-overlapping integer
    // tiles: premultiplied blending must touch a pixel once)
    const [bx, by, bw, bh] = pxBox(X(N.dot.x - m), Y(N.dot.y - m), X(N.dot.x + m), Y(N.dot.y + m), W, H);
    const T = 16, cx = X(N.dot.x), cy = Y(N.dot.y);
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
      const px0 = bx + Math.floor(tx * bw / T), px1 = bx + Math.floor((tx + 1) * bw / T);
      const py0 = by + Math.floor(ty * bh / T), py1 = by + Math.floor((ty + 1) * bh / T);
      if (px1 <= px0 || py1 <= py0) continue;
      const x0 = (px0 - cx) / H, x1 = (px1 - cx) / H, y0 = (py0 - cy) / H, y1 = (py1 - cy) / H;
      const dmin = Math.hypot(Math.max(x0, 0, -x1), Math.max(y0, 0, -y1));
      const dmax = Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(y0), Math.abs(y1)));
      if (dmax < lo || dmin > hi) continue;
      gl.scissor(px0, py0, px1 - px0, py1 - py0);
      ctx.draw(this.progLines, uu, s.target, { blend: 'premult' });
    }
  },
};
