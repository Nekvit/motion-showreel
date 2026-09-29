// Engine-owned HUD overlay (DIRECTION.md §2.2). Shots never draw HUD elements.
//
//   hudState(frame, config) -> { L: { text, tone }, R: { text, full, tone } }
//
// is a PURE function of the integer frame (no luma readback, no history), so an
// isolated render shows exactly what a sequential render shows. tone is 0 = INK,
// 1 = BONE (fractional during the 4f eases). R.full is the complete timecode whose
// cells R.text (a prefix) occupies, so R types on / off in place. HudRenderer draws the two labels
// into two small canvases (640x48 design px) that are re-uploaded only when
// their text changes; the post composite blends them after tonemap, grain and
// vignette and before dither (see post.js), with opacity post.hudAlpha.
//
// This module must stay importable from Node (tools/tests): no DOM access at
// module scope; the renderer receives the engine ctx.

export const FIG = ['FIG. 0 — POINT', 'FIG. 1 — LINE', 'FIG. 2 — PLANE', 'FIG. 3 — LENS', 'FIG. 4 — VOLUME', 'FIG. 5 — FLOW', 'FIG. 6 — FIELD', 'FIG. 7 — FULL STOP'];

// First frame of each shot (§4). FIG[k] belongs to shot k; the label re-resolves
// at every start after the first.
export const HUD_SHOT_STARTS = [0, 96, 168, 264, 384, 480, 576, 672];

export const HUD_TIMING = {
  typeOn: 6,          // f6–19: one character per frame, newest char shows a hashed A–Z glyph
  touch0: 720,        // title touches at 720 + i·Δ
  land: 768,          // L lands on FIG. 7 — FULL STOP; timecode frozen from here
  off: 800,           // type-off 800–811 (L −1.5 chars/f, R −1 char/f)
  empty: 812,         // nothing from 812
  jump: 3,            // touch/landing jumps resolve in 3f
  toneEase: 4,        // tone transitions ease over 4f (except the snaps)
};

// sRGB-coded tone colours (the HUD is composited after the OETF).
export const INK_SRGB = [0x0E / 255, 0x0E / 255, 0x12 / 255];
export const BONE_SRGB = [0xF1 / 255, 0xEB / 255, 0xDF / 255];

// Tone table (§2.2): [from frame, tone]; 0 = INK, 1 = BONE. '·' entries are omitted.
const TONE = {
  L: [[0, 0], [150, 1], [237, 0], [259, 1], [386, 0], [468, 1], [480, 0], [583, 1], [675, 0]],
  R: [[0, 0], [150, 1], [237, 0], [259, 1], [394, 0], [468, 1], [480, 0], [583, 1], [680, 0]],
};
const SNAPS = new Set([468, 480]);

// Layout in design px (1920x1080), multiplied by scale.
export const HUD_LAYOUT = {
  family: 'JetBrains Mono', weight: 500, size: 18, tracking: 0.06, // tracking in em (+6%)
  canvasW: 640, canvasH: 48,
  baseline: 1026,     // both labels: baseline y (from top)
  leftX: 60,          // L: text starts at x = 60
  rightX: 1860,       // R: text right-aligned at x = 1860
  pad: 8,             // canvas margin beyond the text anchor (ink never clipped)
  ascent: 34,         // baseline position inside the canvas (from its top)
};

const inOutSine = x => -(Math.cos(Math.PI * Math.min(1, Math.max(0, x))) - 1) / 2;

// Tone of track 'L' | 'R' at frame f: 0 INK .. 1 BONE. A transition listed at F
// progresses over frames F..F+3 (inOutSine of (f−F+1)/4, complete at F+3);
// 468 and 480 snap on their frame.
export function hudTone(track, f) {
  const ev = TONE[track];
  let v = ev[0][1];
  for (let i = 1; i < ev.length; i++) {
    const [F, to] = ev[i];
    if (f < F) break;
    v = SNAPS.has(F) ? to : v + (to - v) * inOutSine((f - F + 1) / HUD_TIMING.toneEase);
  }
  return v;
}

// Letters of config.name (uppercased, letters only), as _sys.stationLetter uses.
export const nameLetters = config => [...String(config?.name ?? 'NEKVIT').toUpperCase()].filter(ch => /\p{L}/u.test(ch));

// Title touch frames (§2.3 nameLayout): Δ = 3·max(1, ⌊10/(n−1)⌋), touch i at 720 + i·Δ.
export function touchFrames(config) {
  const n = nameLetters(config).length;
  const d = 3 * Math.max(1, n > 1 ? Math.floor(10 / (n - 1)) : 10);
  return Array.from({ length: n }, (_, i) => HUD_TIMING.touch0 + i * d);
}

// SMPTE HH:MM:SS:FF at 60 fps (FF = frame % 60).
export function timecode(f) {
  const p = v => String(v).padStart(2, '0');
  const s = Math.floor(f / 60);
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f % 60)}`;
}

// Deterministic integer hash -> A..Z.
function ih(a) {
  a = Math.imul(a ^ (a >>> 16), 0x7feb352d);
  a = Math.imul(a ^ (a >>> 15), 0x846ca68b);
  return (a ^ (a >>> 16)) >>> 0;
}
const glyphAZ = (f, pos, salt) => String.fromCharCode(65 + ih((f * 64 + pos) * 7 + salt * 1000003) % 26);

// Type-on from f0, one char per frame; the newest char shows a hashed glyph for its first frame.
function typeOn(text, f, f0, salt) {
  const ch = [...text], n = f - f0 + 1;
  if (n <= 0) return '';
  if (n > ch.length) return text;
  return ch.slice(0, n - 1).join('') + glyphAZ(f, n - 1, salt);
}

// Left-to-right re-resolve from `from` to `to`, one char per frame starting at f0:
// at f0+j, positions < j show `to`, position j a hashed glyph, positions > j still `from`.
function resolveLR(from, to, f, f0, salt) {
  const j = f - f0, a = [...from], b = [...to], L = Math.max(a.length, b.length);
  if (j < 0) return from;
  if (j >= L) return to;
  const out = [];
  for (let p = 0; p < L; p++) {
    if (p < j) out.push(b[p] ?? ' ');
    else if (p === j) out.push(p < b.length ? glyphAZ(f, p, salt) : ' ');
    else out.push(a[p] ?? ' ');
  }
  return out.join('').trimEnd();
}

// Jump from `from` to `to` at f0, resolving left to right in HUD_TIMING.jump frames:
// characters that change show hashed glyphs until resolved (unchanged characters and
// spaces stay put, so "FIG. " and " — " hold still). Fully resolved at f0 + 3.
function resolveJump(from, to, f, f0, salt) {
  const j = f - f0, n = HUD_TIMING.jump;
  if (j >= n) return to;
  const a = [...from], b = [...to], k = Math.floor(b.length * j / n);
  return b.map((c, p) => (p < k || c === ' ' || c === a[p] ? c : glyphAZ(f, p, salt))).join('');
}

export function hudTextL(f, config, starts = HUD_SHOT_STARTS) {
  const T = HUD_TIMING;
  if (f < T.typeOn || f >= T.empty) return '';
  let k = 0;
  for (let i = 0; i < starts.length; i++) if (f >= starts[i]) k = i;
  let text = k === 0 ? typeOn(FIG[0], f, T.typeOn, 1) : resolveLR(FIG[k - 1], FIG[k], f, starts[k], 2 + k);
  if (f >= T.touch0) {
    const tf = touchFrames(config);
    let i = -1;
    for (let q = 0; q < tf.length; q++) if (f >= tf[q]) i = q;
    const touchLabel = q => (q < 0 ? FIG[7] : FIG[(q % 6) + 1]);
    if (f >= T.land) text = resolveJump(touchLabel(tf.length - 1), FIG[7], f, T.land, 11);
    else if (i >= 0) text = resolveJump(touchLabel(i - 1), touchLabel(i), f, tf[i], 12 + i);
  }
  if (f >= T.off) {
    const ch = [...text];
    text = ch.slice(0, Math.max(0, ch.length - Math.floor(1.5 * (f - T.off + 1)))).join('');
  }
  return text;
}

// R's complete timecode at frame f (the string whose cells the visible characters
// occupy): '' outside 6..811, frozen at 768. Always 11 characters.
export function hudFullR(f) {
  const T = HUD_TIMING;
  if (f < T.typeOn || f >= T.empty) return '';
  return timecode(Math.min(f, T.land));
}

// R's visible characters: a PREFIX of hudFullR(f). It is drawn in the full string's
// cells (right edge of the full string at 1860 px), so type-on adds characters left to
// right in place and type-off deletes right to left in place; nothing slides.
export function hudTextR(f) {
  const T = HUD_TIMING, full = hudFullR(f);
  if (!full) return '';
  let text = typeOn(full, f, T.typeOn, 31);
  if (f >= T.off) text = text.slice(0, Math.max(0, text.length - (f - T.off + 1)));
  return text;
}

// starts: first frame of each of the 8 shots (defaults to §4; the engine passes its
// timeline's starts when the timeline has 8 shots), i.e. FIG[k] = label of the shot owning f.
export function hudState(frame, config, starts = HUD_SHOT_STARTS) {
  const f = Math.floor(frame);
  return {
    L: { text: hudTextL(f, config, starts), tone: hudTone('L', f) },
    R: { text: hudTextR(f), full: hudFullR(f), tone: hudTone('R', f) },
  };
}

export const toneColor = t => INK_SRGB.map((a, i) => a + (BONE_SRGB[i] - a) * t);

// Canvas rectangles of the two labels in screen px (top-left origin, y down), for a
// render of width W, height H at `scale`. Acceptance checks exclude these boxes (+8px).
export function hudRects(W, H, scale = H / 1080) {
  const Ly = HUD_LAYOUT, w = Math.round(Ly.canvasW * scale), h = Math.round(Ly.canvasH * scale);
  const top = Math.round((Ly.baseline - Ly.ascent) * scale);
  return {
    L: { x: Math.round((Ly.leftX - Ly.pad) * scale), y: top, w, h },
    R: { x: Math.round((Ly.rightX + Ly.pad) * scale) - w, y: top, w, h },
  };
}

export class HudRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    const { W, H, scale } = ctx;
    this.rects = hudRects(W, H, scale);
    this.surf = { L: ctx.surface(this.rects.L.w, this.rects.L.h), R: ctx.surface(this.rects.R.w, this.rects.R.h) };
    this.last = { L: null, R: null };
    this.uploads = 0;
  }

  // L: text left-aligned at leftX. R: `full` (the complete timecode) is laid out once,
  // right-aligned at rightX, and the visible prefix `text` is drawn glyph by glyph in
  // full's cells, so characters appear and disappear in place (§2.2: delete right to left).
  draw(side, text, full = text) {
    const { ctx } = this, Ly = HUD_LAYOUT, s = ctx.scale, surf = this.surf[side];
    const g = surf.clear();
    if (text) {
      const size = Ly.size * s, tracking = Ly.tracking * size;
      const fontSpec = { family: Ly.family, weight: Ly.weight, size };
      const baseline = Math.round(Ly.baseline * s) - this.rects[side].y;
      if (side === 'L') {
        ctx.text.drawText(g, text.toUpperCase(), Ly.leftX * s - this.rects.L.x, baseline, { font: fontSpec, tracking, align: 'left', fill: '#fff' });
      } else {
        const F = ctx.text.layout(String(full || text).toUpperCase(), fontSpec, tracking);
        const x0 = Ly.rightX * s - this.rects.R.x - F.width;
        const chars = [...text.toUpperCase()];
        g.save();
        g.font = F.font; g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.fillStyle = '#fff';
        chars.forEach((ch, i) => g.fillText(ch, x0 + (F.glyphs[i] ? F.glyphs[i].x : F.width), baseline));
        g.restore();
      }
    }
    surf.upload();
    this.uploads++;
  }

  // state: hudState(). Returns the uniforms block Post.run() expects.
  update(state) {
    for (const side of ['L', 'R']) {
      const st = state[side], key = side === 'R' ? `${st.text}|${st.full ?? ''}` : st.text;
      if (key !== this.last[side]) { this.draw(side, st.text, st.full); this.last[side] = key; }
    }
    const H = this.ctx.H, r = this.rects;
    const gl = rc => [rc.x, H - rc.y - rc.h, rc.w, rc.h];
    return {
      texL: this.surf.L.tex, texR: this.surf.R.tex, rectL: gl(r.L), rectR: gl(r.R),
      colL: toneColor(state.L.tone), colR: toneColor(state.R.tone),
    };
  }
}
