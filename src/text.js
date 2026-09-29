// Typography toolkit: font loading (incl. continuous variable width for Archivo),
// per-glyph layout for kinetic type, canvas2D drawing surfaces that upload to
// textures, and a signed-distance-field generator for text/shape masks.
import { textureFrom } from './gl.js';
import { sdfFromAlpha } from './sdf.js';

const FONT_FILES = {
  Archivo: { url: 'fonts/Archivo-Variable.woff2', weight: '100 900', stretch: '62% 125%' },
  'Archivo Italic': { url: 'fonts/Archivo-Variable-Italic.woff2', weight: '100 900', stretch: '62% 125%', style: 'italic', family: 'Archivo' },
  Unbounded: { url: 'fonts/Unbounded-Variable.woff2', weight: '200 900' },
  'Instrument Serif': { url: 'fonts/InstrumentSerif-Regular.woff2', weight: '400' },
  'Instrument Serif Italic': { url: 'fonts/InstrumentSerif-Italic.woff2', weight: '400', style: 'italic', family: 'Instrument Serif' },
  'JetBrains Mono': { url: 'fonts/JetBrainsMono-Variable.woff2', weight: '100 800' },
};

// Archivo's wdth axis is exposed through alias families whose stretch
// descriptor is pinned to one value; the browser clamps the variation to that
// value, so `width: 83` really renders wdth=83. Aliases: every integer 62..99,
// and 0.25 steps over 100..125 (101 faces), each in both styles (§2.2), plus the
// tabular-figure aliases (TNUM_WIDTHS).
const WIDTH_MIN = 62, WIDTH_MAX = 125, WIDTH_FINE = 100;

// Snap a requested wdth to a registered alias: nearest 0.25 in [100,125],
// nearest integer below 100 (a value rounding up to 100 uses the 100 alias).
export function snapWidth(width) {
  const w = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(width)));
  if (w >= WIDTH_FINE) return Math.round(w * 4) / 4;
  return Math.min(WIDTH_FINE, Math.round(w));
}

// Every registered alias width (ascending): 62..99, 100, 100.25, ..., 125.
export const WIDTH_STEPS = (() => {
  const a = [];
  for (let w = WIDTH_MIN; w < WIDTH_FINE; w++) a.push(w);
  for (let q = WIDTH_FINE * 4; q <= WIDTH_MAX * 4; q++) a.push(q / 4);
  return a;
})();

const aliasName = w => `ArchivoW${String(w).replace('.', '_')}`;

// Tabular-figure aliases (OpenType 'tnum' on via the FontFace featureSettings descriptor):
// upright Archivo at these widths only. font({ ..., tnum: true }) picks them (the year is
// Archivo 500/125 tabular, §1.3).
export const TNUM_WIDTHS = [100, 125];
const tnumName = w => aliasName(w) + 'Tnum';
const warnedTnum = new Set();

export const fontTimings = { ms: 0, faces: 0 };

export async function loadFonts(base = '') {
  const t0 = performance.now();
  const buffers = {};
  await Promise.all(Object.entries(FONT_FILES).map(async ([key, f]) => {
    const res = await fetch(base + f.url);
    if (!res.ok) throw new Error('font load failed: ' + f.url);
    buffers[key] = await res.arrayBuffer();
  }));
  const faces = [];
  for (const [key, f] of Object.entries(FONT_FILES)) {
    faces.push(new FontFace(f.family ?? key, buffers[key], { weight: f.weight, style: f.style ?? 'normal', ...(f.stretch ? { stretch: f.stretch } : {}) }));
  }
  for (const w of WIDTH_STEPS) {
    faces.push(new FontFace(aliasName(w), buffers.Archivo, { weight: '100 900', stretch: `${w}%` }));
    faces.push(new FontFace(aliasName(w), buffers['Archivo Italic'], { weight: '100 900', stretch: `${w}%`, style: 'italic' }));
  }
  for (const w of TNUM_WIDTHS) {
    faces.push(new FontFace(tnumName(w), buffers.Archivo, { weight: '100 900', stretch: `${w}%`, featureSettings: '"tnum" 1' }));
  }
  await Promise.all(faces.map(ff => ff.load()));
  for (const ff of faces) document.fonts.add(ff);
  await document.fonts.ready;
  fontTimings.ms = performance.now() - t0;
  fontTimings.faces = faces.length;
  return fontTimings;
}

// Build a CSS font string.
//   family: 'Archivo' | 'Unbounded' | 'Instrument Serif' | 'JetBrains Mono'
//   weight: 100..900 (continuous for variable fonts; rounded to an integer)
//   width: 62..125 (Archivo only): snapped by snapWidth() — 0.25 steps over 100..125,
//   integers below 100. Never fake width with a scale.
//   tnum: true (Archivo upright, width in TNUM_WIDTHS): tabular figures.
export function font({ family = 'Archivo', weight = 400, width = 100, size = 100, italic = false, tnum = false } = {}) {
  let fam = family;
  if (family === 'Archivo') {
    const w = snapWidth(width);
    fam = aliasName(w);
    if (tnum) {
      if (!italic && TNUM_WIDTHS.includes(w)) fam = tnumName(w);
      else if (!warnedTnum.has(w + '|' + italic)) { warnedTnum.add(w + '|' + italic); console.warn(`text.font: no tabular alias for Archivo width ${w}${italic ? ' italic' : ''} (have ${TNUM_WIDTHS.join(', ')} upright); using proportional figures`); }
    }
  }
  return `${italic ? 'italic ' : ''}${Math.round(weight)} ${size}px "${fam}"`;
}

const measureCanvas = document.createElement('canvas');
const mctx = measureCanvas.getContext('2d');

// Per-glyph layout. Returns { glyphs:[{ch,x,w,i}], width, ascent, descent, height }.
// x is the left edge of each glyph relative to the string origin, tracking in px
// is added between glyphs (like CSS letter-spacing, but not after the last glyph).
export function layout(str, fontSpec, tracking = 0) {
  const f = typeof fontSpec === 'string' ? fontSpec : font(fontSpec);
  mctx.font = f;
  const glyphs = [];
  let x = 0;
  const chars = [...str];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // advance including kerning with the next char
    const pair = i + 1 < chars.length ? mctx.measureText(ch + chars[i + 1]).width - mctx.measureText(chars[i + 1]).width : mctx.measureText(ch).width;
    const w = mctx.measureText(ch).width;
    glyphs.push({ ch, x, w, adv: pair, i });
    x += pair + (i + 1 < chars.length ? tracking : 0);
  }
  const m = mctx.measureText(str || 'H');
  const H = mctx.measureText('H');
  return {
    glyphs, width: x, font: f,
    ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent,
    capHeight: H.actualBoundingBoxAscent,
    height: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent,
  };
}

// Draw a string glyph-by-glyph with tracking and an optional per-glyph transform
// callback: perGlyph(g, i) -> { dx, dy, rot, sx, sy, alpha, fill } (all optional).
// align: 'left' | 'center' | 'right'; baseline: 'alphabetic' | 'middle' (cap-height centred).
export function drawText(g, str, x, y, { font: fontSpec, tracking = 0, align = 'left', baseline = 'alphabetic', fill = '#fff', perGlyph = null } = {}) {
  const L = layout(str, fontSpec, tracking);
  g.save();
  g.font = L.font;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  let ox = x;
  if (align === 'center') ox -= L.width / 2;
  else if (align === 'right') ox -= L.width;
  const oy = baseline === 'middle' ? y + L.capHeight / 2 : y;
  for (const gl of L.glyphs) {
    const tr = perGlyph ? perGlyph(gl, gl.i, L) || {} : {};
    if (tr.alpha === 0) continue;
    g.save();
    const cx = ox + gl.x + gl.w / 2, cy = oy - L.capHeight / 2;
    g.translate(cx + (tr.dx || 0), cy + (tr.dy || 0));
    if (tr.rot) g.rotate(tr.rot);
    if (tr.sx != null || tr.sy != null) g.scale(tr.sx ?? 1, tr.sy ?? 1);
    if (tr.font) g.font = tr.font;
    g.globalAlpha = tr.alpha ?? 1;
    g.fillStyle = tr.fill ?? fill;
    g.fillText(gl.ch, -gl.w / 2, L.capHeight / 2);
    g.restore();
  }
  g.restore();
  return L;
}

// A 2D drawing surface backed by a canvas that uploads into a GL texture.
export class Surface {
  constructor(gl, w, h, { mipmap = false } = {}) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.w = w; this.h = h;
    this.g = this.canvas.getContext('2d', { willReadFrequently: false });
    this.mipmap = mipmap;
    this.tex = gl.createTexture();
    this.upload();
  }
  clear(color = null) {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (color) { g.fillStyle = color; g.fillRect(0, 0, this.w, this.h); }
    return g;
  }
  upload() {
    textureFrom(this.gl, this.canvas, { tex: this.tex, mipmap: this.mipmap });
    return this.tex;
  }
}

// Signed distance field from a canvas' alpha channel (src/sdf.js sdfFromAlpha: sub-pixel
// edge points from the antialiased coverage, accurate to ~0.05 px, slope 1 across the edge).
// Returns { tex, data, w, h }: an RGBA32F texture (distance in r, g and b, 1 in a; LINEAR if
// OES_texture_float_linear, clamp) with the distance in PIXELS of the source canvas,
// NEGATIVE inside, positive outside, rows flipped to GL order (row 0 = bottom); `data` is
// its Float32Array (stride 4) for CPU use. Build once in init (≈0.3 s for 1920×1080).
// Reads the canvas back with getImageData: only use it on init-time canvases.
export function sdfTexture(gl, canvas) {
  const w = canvas.width, h = canvas.height;
  const img = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = img[i * 4 + 3] / 255;
  const dist = sdfFromAlpha(alpha, w, h);
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = dist[y * w + x], dst = ((h - 1 - y) * w + x) * 4; // flip Y to GL convention
    data[dst] = d; data[dst + 1] = d; data[dst + 2] = d; data[dst + 3] = 1;
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  const lin = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, data, w, h };
}
