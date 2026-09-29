#!/usr/bin/env node
// Offline soundtrack synthesiser for the reel (DIRECTION.md §3, "Music and sound").
//
//   node tools/soundtrack.mjs            -> audio/soundtrack.wav + audio/soundtrack.json   (~6 s)
//   node tools/soundtrack.mjs --debug [--bands]   also print per-bus, per-bar RMS (and 5-band split)
//   node tools/soundtrack.mjs --dump-buses <dir>  also write each pre-master bus as raw float32
//   node tools/audiocheck.mjs            -> analysis / acceptance of the WAV
//
// Dependency-free and deterministic: every noise source is a seeded PRNG keyed by
// the event that owns it, so any change to one cue never re-rolls another.
// 48 kHz, 16-bit PCM, stereo, exactly 900 frames x 800 samples = 720,000 samples.
// Frame f starts at sample f*800. 150 BPM: a 16th is 6 frames, a beat 24, a bar 96.
// soundtrack.json lists every implemented cue (frame, voice, description, and how audiocheck verifies it),
// the intended transients (for the click detector), the gates and the master stats incl. per-frame gain.
//
// Signal flow
//   voices -> buses (drums, sub, bass, music, fx, foley, dot, bar-7 stem) + sends (hall 1.8 s, plate 2.4 s)
//   bass/music/hall return sidechained to the kick list, sub ducked under every kick (the 808 at 480 and the
//   final sub at 768 arrive just after their kick); sub kept mono; side channel HP 120 Hz; the DOT has its own bus
//   (no drop ducks); HUD ticks on one fixed pitch (G7)
//   sum -> DC/infrasonic HP -> 2:1 glue compressor (detector HP 150 Hz) -> gain -> true-peak lookahead limiter
//   (segmented: its lookahead is flushed at every gate edge) -> hard gates G1/G2
//   -> post-gate dry foley (372 wood tock, 468 relay-off click) -> room tone -> end fade
//   -> loudness loop to -14 LUFS integrated / <= -1 dBTP -> TPDF dither (fixed seed) -> WAV.
import fsys from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js'; // name drives the title touches (count, spacing, pans)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAV_PATH = path.join(ROOT, 'audio', 'soundtrack.wav');
const JSON_PATH = path.join(ROOT, 'audio', 'soundtrack.json');
const clock = () => Number(process.hrtime.bigint() / 1000000n); // reporting only, never feeds the DSP
const T_START = clock();
const log = (...a) => console.log(`[${((clock() - T_START) / 1000).toFixed(2).padStart(6)}s]`, ...a);

// ============================================================================ constants
const SR = 48000, FPS = 60, SPF = SR / FPS, FRAMES = 900, N = FRAMES * SPF; // 720,000
const BPM = 150, SEED = 0x2026f00d;
const TAU = 2 * Math.PI;
const f = (frame) => Math.round(frame * SPF);          // frame -> first sample
const ms = (x) => Math.round(x * SR / 1000);
const sec = (x) => Math.round(x * SR);
const fsec = (frames) => frames / FPS;                  // frames -> seconds
const dB = (x) => Math.pow(10, x / 20);
const G1 = [297600, 307200], G2 = [374400, 384000];    // [first zero sample, reopen sample)
const TARGET_LUFS = -14, CEIL_DBTP = -1;
const GATE_CLOSE = ms(2);                               // 96-sample cosine close

const NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function hz(name) {
  const m = /^([A-G])(b|#)?(-?\d)$/.exec(name);
  if (!m) throw new Error('bad note ' + name);
  const midi = 12 * (Number(m[3]) + 1) + NOTE_IDX[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ============================================================================ DSP kit
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
const rng = (key) => mulberry32(hash32(String(key)) ^ SEED);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (u) => { u = clamp01(u); return u * u * (3 - 2 * u); };
const lerp = (a, b, u) => a + (b - a) * u;
const expLerp = (a, b, u) => a * Math.pow(b / a, u);
const inOutQuint = (u) => { u = clamp01(u); return u < 0.5 ? 16 * u ** 5 : 1 - Math.pow(-2 * u + 2, 5) / 2; };
// raised-cosine attack over n samples (0 at i = 0) and release over the last n samples (0 on the last sample)
const atk = (i, n) => (n <= 0 || i >= n) ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * i / n);
const rel = (i, len, n) => { const k = len - 1 - i; return (n <= 0 || k >= n) ? 1 : k <= 0 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * k / n); };

// Zavalishin TPT state-variable filter: stable under per-sample cutoff modulation.
class SVF {
  constructor(fc = 1000, q = Math.SQRT1_2) { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.set(fc, q); }
  set(fc, q) {
    const g = Math.tan(Math.PI * clamp(fc, 5, SR * 0.49) / SR), k = 1 / q;
    this.k = k; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; return this;
  }
  tick(v0) {
    const v3 = v0 - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = v0 - this.k * v1 - v2; return v2;
  }
  get bpn() { return this.bp * this.k; } // unity-peak band-pass
}

// RBJ biquad (TDF-II) for static EQ.
class Biquad {
  constructor(type, fc, q = Math.SQRT1_2, gainDb = 0) { this.z1 = 0; this.z2 = 0; this.set(type, fc, q, gainDb); }
  set(type, fc, q = Math.SQRT1_2, gainDb = 0) {
    const w = TAU * clamp(fc, 1, SR * 0.49) / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    else if (type === 'hs' || type === 'ls') {
      const sq = 2 * Math.sqrt(A) * al, s = type === 'hs' ? 1 : -1;
      b0 = A * ((A + 1) + s * (A - 1) * cw + sq); b1 = -2 * s * A * ((A - 1) + s * (A + 1) * cw); b2 = A * ((A + 1) + s * (A - 1) * cw - sq);
      a0 = (A + 1) - s * (A - 1) * cw + sq; a1 = 2 * s * ((A - 1) - s * (A + 1) * cw); a2 = (A + 1) - s * (A - 1) * cw - sq;
    } else throw new Error('biquad type ' + type);
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this;
  }
  tick(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  run(buf, a = 0, b = buf.length) { for (let i = a; i < b; i++) buf[i] = this.tick(buf[i]); return buf; }
}
const BW4 = [0.5411961, 1.3065630]; // Butterworth 4th-order section Qs
const filt = (buf, type, fc, q, g) => new Biquad(type, fc, q, g).run(buf);
const filt4 = (buf, type, fc) => { for (const q of BW4) filt(buf, type, fc, q); return buf; };

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
class Saw { // band-limited (polyBLEP) sawtooth with a phase accumulator
  constructor(phase = 0) { this.p = phase; }
  tick(fr) { const dt = fr / SR; this.p += dt; if (this.p >= 1) this.p -= 1; return 2 * this.p - 1 - polyblep(this.p, dt); }
}

function peakOf(sig) {
  let p = 0;
  const scan = (a) => { for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } };
  if (sig instanceof Float32Array || sig instanceof Float64Array) scan(sig); else { scan(sig.L); scan(sig.R); }
  return p;
}
function normalize(sig, target = 1) {
  const p = peakOf(sig); if (p <= 0) return sig; const g = target / p;
  const sc = (a) => { for (let i = 0; i < a.length; i++) a[i] *= g; };
  if (sig instanceof Float32Array || sig instanceof Float64Array) sc(sig); else { sc(sig.L); sc(sig.R); }
  return sig;
}
function reversed(sig) {
  const rv = (a) => Float32Array.from(a).reverse();
  return (sig instanceof Float32Array) ? rv(sig) : { L: rv(sig.L), R: rv(sig.R) };
}
function addInto(dst, src, off = 0, g = 1) { const n = Math.min(src.length, dst.length - off); for (let i = Math.max(0, -off); i < n; i++) dst[off + i] += src[i] * g; return dst; }
function stereo(n) { return { L: new Float32Array(n), R: new Float32Array(n) }; }
function panGains(p) { const th = (clamp(p, -1, 1) + 1) * Math.PI / 4; return [Math.SQRT2 * Math.cos(th), Math.SQRT2 * Math.sin(th)]; } // equal power, unity at centre
function crush(buf, hold, bits) { // sample-and-hold + quantiser (the bitcrusher)
  const q = Math.pow(2, bits - 1); let h = 0;
  for (let i = 0; i < buf.length; i++) { if (i % hold === 0) h = Math.round(buf[i] * q) / q; buf[i] = h; }
  return buf;
}

// ---------------------------------------------------------------- FFT (radix-2, in place)
const FFT_CACHE = new Map();
function fftTables(n) {
  if (FFT_CACHE.has(n)) return FFT_CACHE.get(n);
  const bits = Math.log2(n), rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(TAU * i / n); sin[i] = Math.sin(TAU * i / n); }
  const t = { n, rev, cos, sin }; FFT_CACHE.set(n, t); return t;
}
function fft(re, im, inverse = false) {
  const n = re.length, { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  const sg = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const l = i + j + half, wr = cos[k], wi = sg * sin[k];
        const tr = re[l] * wr - im[l] * wi, ti = re[l] * wi + im[l] * wr;
        re[l] = re[i + j] - tr; im[l] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti;
      }
    }
  }
  if (inverse) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
}
// Stereo overlap-add FFT convolution. Two real channels are packed into one complex FFT.
// `segments` are independent [a, b) ranges: output of a segment never leaks past b.
function convolveStereo(inL, inR, ir, segments, outLen = inL.length) {
  const irLen = ir.L.length; let M = 1; while (M < 2 * irLen) M <<= 1;
  const B = M - irLen + 1;
  const HLr = new Float64Array(M), HLi = new Float64Array(M), HRr = new Float64Array(M), HRi = new Float64Array(M);
  for (let i = 0; i < irLen; i++) { HLr[i] = ir.L[i]; HRr[i] = ir.R[i]; }
  fft(HLr, HLi); fft(HRr, HRi);
  const out = stereo(outLen);
  const re = new Float64Array(M), im = new Float64Array(M), wr = new Float64Array(M), wi = new Float64Array(M);
  for (const [a, b] of segments) {
    for (let s = a; s < b; s += B) {
      const bl = Math.min(B, b - s);
      re.fill(0); im.fill(0);
      let any = false;
      for (let i = 0; i < bl; i++) { re[i] = inL[s + i]; im[i] = inR[s + i]; if (re[i] !== 0 || im[i] !== 0) any = true; }
      if (!any) continue;
      fft(re, im);
      for (let k = 0; k < M; k++) {
        const km = (M - k) & (M - 1);
        const xlr = 0.5 * (re[k] + re[km]), xli = 0.5 * (im[k] - im[km]);
        const xrr = 0.5 * (im[k] + im[km]), xri = -0.5 * (re[k] - re[km]);
        const ylr = xlr * HLr[k] - xli * HLi[k], yli = xlr * HLi[k] + xli * HLr[k];
        const yrr = xrr * HRr[k] - xri * HRi[k], yri = xrr * HRi[k] + xri * HRr[k];
        wr[k] = ylr - yri; wi[k] = yli + yrr;
      }
      fft(wr, wi, true);
      const end = Math.min(s + bl + irLen - 1, b, outLen);
      for (let n = s; n < end; n++) { out.L[n] += wr[n - s]; out.R[n] += wi[n - s]; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- loudness (ITU-R BS.1770-4)
function kWeight(x) {
  const y = Float64Array.from(x);
  const s1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
  const s2 = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };
  for (const c of [s1, s2]) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const xi = y[i]; const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi; }
  }
  return y;
}
function loudness(L, R) {
  const kl = kWeight(L), kr = kWeight(R), blk = sec(0.4), hop = sec(0.1), z = [];
  for (let s = 0; s + blk <= L.length; s += hop) {
    let a = 0, b = 0; for (let i = s; i < s + blk; i++) { a += kl[i] * kl[i]; b += kr[i] * kr[i]; }
    z.push((a + b) / blk);
  }
  const lk = (v) => -0.691 + 10 * Math.log10(v + 1e-20);
  const abs = z.filter((v) => lk(v) > -70);
  if (!abs.length) return { integrated: -Infinity, momentaryMax: -Infinity };
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((v) => lk(v) > rel);
  return { integrated: lk(gated.reduce((a, b) => a + b, 0) / gated.length), momentaryMax: Math.max(...z.map(lk)) };
}

// ---------------------------------------------------------------- true peak (4x polyphase, Kaiser-windowed sinc)
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
function interpFilter(over, T, beta) {
  const n = over * T + 1, c = over * T / 2, h = new Float64Array(n), i0b = besselI0(beta);
  for (let j = 0; j < n; j++) {
    const x = (j - c) / over, s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x), r = (j - c) / c;
    h[j] = s * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
  }
  return h;
}
const TP_OVER = 4, TP_T = 16, TP_H = interpFilter(TP_OVER, TP_T, 8.5);
// tp[j] = max |x| over [j, j+1) including the three inter-sample points; stereo-linked.
function truePeakEnv(L, R) {
  const n = L.length, tp = new Float32Array(n), half = TP_T / 2;
  for (const x of [L, R]) {
    for (let j = 0; j < n; j++) { const v = Math.abs(x[j]); if (v > tp[j]) tp[j] = v; }
    for (let m = half; m < n + half; m++) {
      const j = m - half; if (j >= n) break;
      for (let p = 1; p < TP_OVER; p++) {
        let acc = 0;
        for (let k = 0; k < TP_T; k++) { const idx = m - k; if (idx >= 0 && idx < n) acc += x[idx] * TP_H[TP_OVER * k + p]; }
        const v = Math.abs(acc); if (v > tp[j]) tp[j] = v;
      }
    }
  }
  return tp;
}

// ============================================================================ voices
// All voices return a mono Float32Array or {L, R}, start and end at zero amplitude
// (raised-cosine edges) unless the click is the point of the voice.

function kickVoice(o = {}) {
  const { f0 = 150, f1 = 45, tau = 0.040, len = 0.18, hold = 0.028, decay = 0.062, click = 0.35, lp = 0, drive = 1.8, seed = 'kick' } = o;
  const n = sec(len), out = new Float32Array(n), r = rng(seed), clickN = ms(2), tailN = ms(28), nd = Math.tanh(drive);
  const hp = new SVF(3200, 0.7); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, fr = f1 + (f0 - f1) * Math.exp(-t / tau);
    ph += fr / SR; if (ph >= 1) ph -= 1;
    const a = (t < hold ? 1 : Math.exp(-(t - hold) / decay)) * rel(i, n, tailN);
    let s = Math.sin(TAU * ph) * a;
    if (i < clickN) { hp.tick(r() * 2 - 1); s += click * hp.hp * Math.exp(-t / 0.0006) * (0.5 + 0.5 * Math.cos(Math.PI * i / clickN)); }
    out[i] = Math.tanh(drive * s) / nd;
  }
  if (lp) filt(out, 'lp', lp, 0.7);
  return out;
}

function subVoice(o) { // sine with glide + soft saturation; mono
  const { len, f0, f1 = f0, glide = 0, att = 0.003, decay = 0, relS = 0.03, drive = 1.4, shape = 3 } = o;
  const n = sec(len), out = new Float32Array(n), nd = Math.tanh(drive), aN = Math.max(1, sec(att)), rN = sec(relS); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, u = glide > 0 ? clamp01(t / glide) : 1, e = 1 - Math.pow(1 - u, shape);
    ph += expLerp(f0, f1, e) / SR; if (ph >= 1) ph -= 1;
    const a = atk(i, aN) * (decay > 0 ? Math.exp(-t / decay) : 1) * rel(i, n, rN);
    out[i] = Math.tanh(drive * Math.sin(TAU * ph) * a) / nd;
  }
  return out;
}

// Continuous sub line: one oscillator, re-triggered hits with glides; never overlaps itself.
function subLine({ len, hits, att = 0.006, relS = 0.04, drive = 1.6, swell = null }) {
  const n = sec(len), out = new Float32Array(n), nd = Math.tanh(drive), aS = 1 - Math.exp(-1 / (0.0025 * SR));
  let ph = 0, hi = -1, amp = 0, cur = hits[0].from ?? hits[0].hz, from = cur, glide = 0.001;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (hi + 1 < hits.length && t >= hits[hi + 1].t) { hi++; from = hits[hi].from ?? cur; glide = hits[hi].glide ?? 0.014; }
    const h = hits[Math.max(0, hi)], dt = Math.max(0, t - h.t);
    cur = expLerp(from, h.hz, smooth(dt / glide));
    ph += cur / SR; if (ph >= 1) ph -= 1;
    const target = hi < 0 ? 0 : (h.floor + (h.peak - h.floor) * Math.exp(-dt / h.tau)) * (swell ? swell(t) : 1);
    amp += (target - amp) * aS;
    const a = amp * atk(i, sec(att)) * rel(i, n, sec(relS));
    out[i] = Math.tanh(drive * Math.sin(TAU * ph) * a) / nd;
  }
  return out;
}

// SNARE/CLAP: three noise bursts 10 ms apart, BP 1.2 kHz, 190 Hz body. Both modes add a second, weaker band at
// 3.8 kHz (bright 0.75) for presence. The snare's bursts are longer and its last burst carries a 50 ms decay (the
// clap's two first bursts are 3 ms slaps and its tail 48 ms); the snare also has the heavier, longer body.
function clapVoice(o = {}) {
  const { snare = false, pitch = 1, lp = 0, seed = 'clap', body = snare ? 0.7 : 0.4, bright = 0.75 } = o;
  const len = snare ? 0.24 : 0.28, n = sec(len), out = new Float32Array(n), r = rng(seed);
  const bp1 = new SVF(1200 * pitch, 1.0), bp2 = new SVF(3800 * pitch, 1.3), lpf = lp ? new SVF(lp, 0.707) : null;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, w = r() * 2 - 1; bp1.tick(w); bp2.tick(w);
    const nz = bp1.bpn + bright * bp2.bpn;
    let e = 0;
    if (snare) { for (const [b, a, tau] of [[0, 1, 0.0055], [0.010, 0.7, 0.0045], [0.020, 0.72, 0.05]]) if (t >= b) e += a * Math.exp(-(t - b) / tau); }
    else for (const b of [0, 0.010, 0.020]) if (t >= b) e += b === 0.020 ? Math.exp(-(t - b) / 0.048) : 0.85 * Math.exp(-(t - b) / 0.0032);
    ph += 190 * pitch * (1 + 0.3 * Math.exp(-t / 0.008)) / SR; if (ph >= 1) ph -= 1;
    let s = nz * e + body * Math.sin(TAU * ph) * Math.exp(-t / (snare ? 0.045 : 0.03)) * atk(i, ms(0.6));
    if (lpf) s = lpf.tick(s);
    out[i] = s * rel(i, n, ms(25));
  }
  return normalize(out);
}

function hatVoice({ open = false, seed = 'hat' } = {}) { // HP noise at 8 kHz; closed 30 ms, open 120 ms
  const len = open ? 0.12 : 0.03, n = sec(len), out = new Float32Array(n), r = rng(seed);
  const h1 = new SVF(8000, 0.54), h2 = new SVF(8000, 1.31), pk = new SVF(10800, 3);
  for (let i = 0; i < n; i++) {
    const t = i / SR, w = r() * 2 - 1; h1.tick(w); h2.tick(h1.hp); pk.tick(h2.hp);
    const e = (open ? 0.75 * Math.exp(-t / 0.05) + 0.25 * Math.exp(-t / 0.006) : Math.exp(-t / 0.0085)) * atk(i, 10) * rel(i, n, ms(open ? 30 : 7));
    out[i] = (h2.hp + 0.5 * pk.bpn) * e;
  }
  return normalize(out);
}

// REESE: two polyBLEP saws detuned +-9 cents, 4-pole LP (900 Hz by default; bar 2 moves it only for the
// 132/138 wobble and the 144-168 collapse). Mid (A+B) carries the body and is saturated after the LP; side (A-B)
// is high-passed at 160 Hz so the lows stay mono. `hpMid` removes the fundamental when a separate sine sub
// carries it. Its 0.5-0.9 kHz band pulses once per cycle (a saw's upper harmonics sit on its reset edge): that
// is the reese's buzz at the note's own period, not an event.
function reeseVoice(o) {
  const { len, notes, glide = 0.012, lpFn = () => 900, hpMid = 90, width = 0.9, drive = 1.7, ampFn = () => 1, seed = 'reese' } = o;
  const n = sec(len), out = stereo(n), r = rng(seed);
  const sA = new Saw(r()), sB = new Saw(r()), dA = Math.pow(2, 9 / 1200), dBn = Math.pow(2, -9 / 1200);
  const m1 = new SVF(), m2 = new SVF(), s1 = new SVF(), s2 = new SVF();
  const hm1 = new Biquad('hp', hpMid, BW4[0]), hm2 = new Biquad('hp', hpMid, BW4[1]), hs1 = new Biquad('hp', 160, BW4[0]), hs2 = new Biquad('hp', 160, BW4[1]), mud = new Biquad('peak', 230, 0.9, -2.5);
  const nd = Math.tanh(drive), gc = 1 - Math.exp(-1 / (glide * SR));
  let logf = Math.log(notes[0].hz), ni = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (ni + 1 < notes.length && t >= notes[ni + 1].t) ni++;
    logf += (Math.log(notes[ni].hz) - logf) * gc;
    const fr = Math.exp(logf), a = sA.tick(fr * dA), b = sB.tick(fr * dBn);
    if ((i & 15) === 0) { const fc = lpFn(t); m1.set(fc, BW4[0]); m2.set(fc, BW4[1]); s1.set(fc, BW4[0]); s2.set(fc, BW4[1]); }
    let mid = m2.tick(m1.tick(0.5 * (a + b))), side = s2.tick(s1.tick(0.5 * (a - b)));
    mid = mud.tick(Math.tanh(drive * hm2.tick(hm1.tick(mid))) / nd); side = hs2.tick(hs1.tick(side)); // HP before the drive: no spiky square-minus-fundamental
    const e = ampFn(t) * atk(i, ms(8)) * rel(i, n, ms(25));
    out.L[i] = (mid + width * side) * e; out.R[i] = (mid - width * side) * e;
  }
  return out;
}

// FM: 2-operator, modulator phase-locked at `ratio`; index decays i0 -> i1.
function fmVoice(o) {
  const { len, hz: h0 = 440, hzFn = null, ratio = 2, i0 = 4, i1 = 0.5, itau = 0.25, att = 0.002, decay = 0.5, sustain = 0, tail = 0.03, ampFn = null } = o;
  const n = sec(len), out = new Float32Array(n), aN = sec(att), tN = sec(tail); let pc = 0, pm = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, fr = hzFn ? hzFn(t) : h0;
    pc += fr / SR; if (pc >= 1) pc -= 1;
    pm += fr * ratio / SR; if (pm >= 1) pm -= 1;
    const I = i1 + (i0 - i1) * Math.exp(-t / itau);
    const a = atk(i, aN) * (sustain + (1 - sustain) * Math.exp(-t / decay)) * rel(i, n, tN) * (ampFn ? ampFn(t) : 1);
    out[i] = a * Math.sin(TAU * pc + I * Math.sin(TAU * pm));
  }
  return out;
}
// DOT: the dot's only voice. FM 1:2, index 3 -> 0.3, 80 ms, pitch x0.7 over 60 ms.
// At index 3 on 1:2 the fundamental is nearly absent at the attack and only emerges as the index decays, so the
// written pitch is held for the first 18 ms and the x0.7 drop runs over 18-60 ms: the note is heard in tune.
const dotVoice = (h) => normalize(fmVoice({ len: 0.1, hzFn: (t) => h * Math.pow(0.7, smooth((t - 0.018) / 0.042)), ratio: 2, i0: 3, i1: 0.3, itau: 0.022, att: 0.0008, decay: 0.032, tail: 0.028 }));
// Glass bell: FM 1:2, index 4 -> 0.5, 1.2 s.
const bellVoice = (h, o = {}) => normalize(fmVoice({ len: o.len ?? 1.2, hz: h, ratio: 2, i0: o.i0 ?? 4, i1: 0.5, itau: 0.16, att: o.att ?? 0.0012, decay: o.decay ?? 0.42, tail: 0.12 }));

function padVoice(o) { // PAD: six saws per note detuned +-12 cents, 4-pole LP 1.8 kHz, 60 ms attack
  const { len, notes, att = 0.06, relS = 0.25, lpFn = () => 1800, ampFn = () => 1, spread = 0.75, seed = 'pad', drift = 0 } = o;
  const n = sec(len), L = new Float32Array(n), R = new Float32Array(n), r = rng(seed);
  const cents = [-12, -7.2, -2.4, 2.4, 7.2, 12], pans = [-1, 1, -0.33, 0.33, -0.66, 0.66];
  for (const h of notes) {
    for (let v = 0; v < 6; v++) {
      const saw = new Saw(r()), fr = h * Math.pow(2, cents[v] / 1200), [gl, gr] = panGains(pans[v] * spread), dph = r() * TAU;
      for (let i = 0; i < n; i++) {
        const d = drift ? 1 + drift * Math.sin(TAU * 0.23 * i / SR + dph) : 1;
        const s = saw.tick(fr * d); L[i] += s * gl; R[i] += s * gr;
      }
    }
  }
  const fl = [new SVF(), new SVF()], fr_ = [new SVF(), new SVF()];
  const aN = sec(att), rN = sec(relS);
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) { const fc = lpFn(i / SR); fl[0].set(fc, BW4[0]); fl[1].set(fc, BW4[1]); fr_[0].set(fc, BW4[0]); fr_[1].set(fc, BW4[1]); }
    const e = atk(i, aN) * rel(i, n, rN) * ampFn(i / SR);
    L[i] = fl[1].tick(fl[0].tick(L[i])) * e; R[i] = fr_[1].tick(fr_[0].tick(R[i])) * e;
  }
  filt(L, 'hp', 35, 0.7); filt(R, 'hp', 35, 0.7);
  const S = Float64Array.from(L, (v, i) => 0.5 * (v - R[i])); filt4(S, 'hp', 150); // the spread stays above 150 Hz
  for (let i = 0; i < n; i++) { const M = 0.5 * (L[i] + R[i]); L[i] = M + S[i]; R[i] = M - S[i]; }
  return normalize({ L, R });
}

// FX: swept filtered noise (whooshes, zips, risers, hiss). mode bp | hp | lp.
function sweepVoice(o) {
  const { len, f0, f1 = f0, q = 1, envFn = (u) => Math.sin(Math.PI * u), curveFn = (u) => u, seed = 'sweep', st = false, mode = 'bp', att = 1, tailMs = 3 } = o;
  const n = sec(len), outs = [];
  for (let c = 0; c < (st ? 2 : 1); c++) {
    const out = new Float32Array(n), r = rng(seed + ':' + c), sv = new SVF(f0, q);
    for (let i = 0; i < n; i++) {
      const u = i / Math.max(1, n - 1);
      if ((i & 7) === 0) sv.set(expLerp(f0, f1, curveFn(u)), q);
      sv.tick(r() * 2 - 1);
      const s = mode === 'bp' ? sv.bpn : mode === 'hp' ? sv.hp : sv.lp;
      out[i] = s * envFn(u) * atk(i, ms(att)) * rel(i, n, ms(tailMs));
    }
    outs.push(out);
  }
  return normalize(st ? { L: outs[0], R: outs[1] } : outs[0]);
}

function sineGlide({ len, f0, f1 = f0, glide = len, att = 0.004, tailS = 0.03, envFn = null, partial2 = 0 }) {
  const n = sec(len), out = new Float32Array(n); let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, fr = expLerp(f0, f1, smooth(t / glide));
    ph += fr / SR; if (ph >= 1) ph -= 1; ph2 += 2 * fr / SR; if (ph2 >= 1) ph2 -= 1;
    out[i] = (Math.sin(TAU * ph) + partial2 * Math.sin(TAU * ph2)) * atk(i, sec(att)) * rel(i, n, sec(tailS)) * (envFn ? envFn(t) : 1);
  }
  return normalize(out);
}

function shepardVoice({ len, octPerSec = 1.1, center = 650, sigma = 1.05, lowest = 55, pitchFn = () => 1, envFn = () => 1 }) {
  const n = sec(len), out = new Float32Array(n), ph = new Float64Array(6), lc = Math.log2(center);
  for (let i = 0; i < n; i++) {
    const t = i / SR, pm = pitchFn(t), pos = octPerSec * t; let s = 0;
    for (let k = 0; k < 6; k++) {
      const oct = (k + pos) % 6, lf = Math.log2(lowest) + oct, fr = Math.pow(2, lf) * pm;
      const w = Math.exp(-0.5 * ((lf - lc) / sigma) ** 2); // spectral envelope rides the dive with the partials
      ph[k] += fr / SR; if (ph[k] >= 1) ph[k] -= 1;
      s += w * Math.sin(TAU * ph[k]);
    }
    out[i] = s * envFn(t) * atk(i, ms(5)) * rel(i, n, ms(3));
  }
  return normalize(out);
}

function grainVoice(h, dur, { chirp = 1, rev = false } = {}) { // Hann-windowed (or reversed) sine grain
  const n = Math.max(8, sec(dur)), out = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1); ph += h * Math.pow(chirp, u) / SR; if (ph >= 1) ph -= 1;
    const w = rev ? (u < 0.88 ? Math.pow(u / 0.88, 2.2) : 0.5 + 0.5 * Math.cos(Math.PI * (u - 0.88) / 0.12)) * (i === 0 ? 0 : 1) : 0.5 - 0.5 * Math.cos(TAU * u);
    out[i] = w * Math.sin(TAU * ph);
  }
  return out;
}

// TICK: 3 ms noise click + 15 ms pitched sine.
function tickVoice(o = {}) {
  const { hz: th = 3200, noise = 0.7, tone = 1, clickMs = 3, toneMs = 15, bp = 4500, bpQ = 0.9, toneTau = 0.004, hold = 0, seed = 'tick' } = o;
  const n = ms(Math.max(clickMs, toneMs)), cN = ms(clickMs), out = new Float32Array(n), r = rng(seed), sv = new SVF(bp, bpQ); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; let s = 0;
    if (i < cN) { sv.tick(r() * 2 - 1); s += noise * sv.bpn * Math.exp(-t / 0.0008) * rel(i, cN, ms(1)); }
    ph += th / SR; if (ph >= 1) ph -= 1;
    s += tone * Math.sin(TAU * ph) * (t < hold ? 1 : Math.exp(-(t - hold) / toneTau)) * atk(i, 6) * rel(i, n, ms(4));
    out[i] = s;
  }
  return normalize(out);
}

function modalVoice({ modes, len, strike = 0.4, strikeLp = 5000, strikeMs = 1.2, seed = 'modal', tailMs = 3 }) { // struck modes (wood, relays)
  const n = sec(len), out = new Float32Array(n), r = rng(seed), lp = new SVF(strikeLp, 0.8), sN = ms(strikeMs);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let s = 0;
    for (const [mh, a, tau] of modes) s += a * Math.sin(TAU * mh * t) * Math.exp(-t / tau);
    if (i < sN) { lp.tick(r() * 2 - 1); s += strike * lp.lp * (1 - i / sN); }
    out[i] = s * rel(i, n, ms(tailMs));
  }
  return normalize(out);
}

function crashVoice({ len = 2.0, t60 = 1.6, seed = 'crash', metal = 0.55, lp0 = 16000, lp1 = 5500, splash = 0.6, attMs = 0.8 } = {}) {
  const n = sec(len), out = stereo(n), freqs = [3150, 4370, 5210, 6830, 7590, 9420];
  for (let c = 0; c < 2; c++) {
    const r = rng(seed + ':' + c), h1 = new SVF(3200, BW4[0]), h2 = new SVF(3200, BW4[1]), l1 = new SVF(lp0, 0.7), ph = freqs.map(() => r());
    const o = c ? out.R : out.L;
    for (let i = 0; i < n; i++) {
      const t = i / SR, w = r() * 2 - 1; let ring = 0;
      for (let k = 0; k < 6; k++) { ph[k] += freqs[k] * (1 + 0.013 * c) / SR; if (ph[k] >= 1) ph[k] -= 1; ring += Math.sin(TAU * ph[k]); }
      const x = w * (1 - metal) + metal * w * ring / 3;
      h1.tick(x); h2.tick(h1.hp);
      if ((i & 15) === 0) l1.set(expLerp(lp0, lp1, clamp01(t / len)), 0.7);
      l1.tick(h2.hp);
      o[i] = l1.lp * Math.exp(-6.9078 * t / t60) * (1 + splash * Math.exp(-t / 0.025)) * atk(i, ms(attMs)) * rel(i, n, ms(40));
    }
  }
  return normalize(out);
}

function thudVoice({ lp = 800, body = 90, len = 0.06, seed = 'thud' }) { // plate thud: LP noise + 90 Hz body
  const n = sec(len), out = new Float32Array(n), r = rng(seed), l = new SVF(lp, 0.8); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; l.tick(r() * 2 - 1); ph += body * (1 + 0.4 * Math.exp(-t / 0.006)) / SR;
    out[i] = (0.8 * l.lp * Math.exp(-t / 0.011) + Math.sin(TAU * ph) * Math.exp(-t / 0.022)) * atk(i, 12) * rel(i, n, ms(10));
  }
  return normalize(out);
}

// Wet/LP sweeps (splat, wet thump): resonant LP on noise (+ optional sine body).
function lpSweepVoice({ len, f0, f1, sweep, q = 1.5, tau = 0.06, body = 0, bodyHz = 110, seed = 'lps', st = false }) {
  const n = sec(len), outs = [];
  for (let c = 0; c < (st ? 2 : 1); c++) {
    const out = new Float32Array(n), r = rng(seed + ':' + c), sv = new SVF(f0, q); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if ((i & 7) === 0) sv.set(expLerp(f0, f1, clamp01(t / sweep)), q);
      ph += bodyHz * (1 + 0.8 * Math.exp(-t / 0.01)) / SR;
      sv.tick(r() * 2 - 1 + body * Math.sin(TAU * ph));
      out[i] = sv.lp * Math.exp(-t / tau) * atk(i, ms(1)) * rel(i, n, ms(15));
    }
    outs.push(out);
  }
  return normalize(st ? { L: outs[0], R: outs[1] } : outs[0]);
}

function typeTick(h, seed) { // typewriter: key click + short pitched body + low thunk
  const a = tickVoice({ hz: h, noise: 0.85, clickMs: 2.5, toneMs: 22, toneTau: 0.005, bp: 2800, bpQ: 1.4, seed });
  const th = sineGlide({ len: 0.018, f0: 420, f1: 330, att: 0.0005, tailS: 0.006 });
  for (let i = 0; i < th.length; i++) a[i] += 0.35 * th[i] * Math.exp(-i / ms(4));
  return normalize(a);
}

function stabVoice({ notes, len = 0.36, decay = 0.13, seed = 'stab', lp = 4200, i0 = 3 }) { // FM (1:1, brassy) chord stab, stereo
  const n = sec(len), out = stereo(n);
  notes.forEach((h, k) => {
    for (const [det, pan] of [[-6, -0.55], [6, 0.55]]) {
      const v = fmVoice({ len, hz: h * Math.pow(2, det / 1200), ratio: 1, i0, i1: 0.7, itau: 0.07, att: 0.0015, decay, tail: 0.05 });
      const [gl, gr] = panGains(pan * (k % 2 ? 1 : -1));
      addInto(out.L, v, 0, gl); addInto(out.R, v, 0, gr);
    }
  });
  filt(out.L, 'lp', lp, 0.7); filt(out.R, 'lp', lp, 0.7);
  return normalize(out);
}

// ============================================================================ buses & mixing
const BUS = {};
for (const name of ['drums', 'sub', 'bass', 'music', 'fx', 'foley', 'hall', 'plate', 'dot']) BUS[name] = stereo(N); // dot: the DOT plucks, kept out of the drop ducks
const STEM7 = stereo(N); // bar-7 bed (arp + delay + glitter bed): gets the tape-stretch before joining `music`
const TRANSIENTS = [];   // [sample, windowSamples] of intended clicks/attacks (for audiocheck's click detector)
const KICKS = [];

// Events never ring on through a vacuum: anything that starts before a gate is cut at the
// gate's first sample (where the master gate is already 0), so nothing resumes after reopening.
function gateLimit(s) { return s < G1[0] ? G1[0] : s < G2[0] ? G2[0] : N; }

function mix(bus, start, sig, o = {}) {
  const Bs = bus === 'stem7' ? STEM7 : BUS[bus], g = dB(o.db ?? 0);
  const isSt = !(sig instanceof Float32Array || sig instanceof Float64Array), sl = isSt ? sig.L : sig, sr = isSt ? sig.R : sig;
  start = Math.round(start);
  const lim = gateLimit(Math.max(0, start)), i0 = Math.max(0, -start), i1 = Math.min(sl.length, lim - start);
  if (i1 <= i0) return;
  // o.specLevel: the cue has a level set by the spec, so the pan law is normalised to the near side (its louder
  // channel peaks at exactly o.db) instead of the default equal-power law, which is unity at centre, +3 dB at the sides.
  const panF = typeof o.pan === 'function' ? o.pan : null;
  const pg = (p) => { const g = panGains(p); if (!o.specLevel) return g; const m = Math.max(g[0], g[1]); return [g[0] / m, g[1] / m]; };
  let [gl, gr] = pg(panF ? panF(start + i0) : (o.pan ?? 0));
  const sends = [];
  if (o.hall !== undefined) sends.push([BUS.hall, dB(o.hall)]);
  if (o.plate !== undefined) sends.push([BUS.plate, dB(o.plate)]);
  for (let i = i0; i < i1; i++) {
    const n = start + i;
    if (panF && (i & 15) === 0) [gl, gr] = pg(panF(n));
    const l = sl[i] * g * gl, r = sr[i] * g * gr;
    Bs.L[n] += l; Bs.R[n] += r;
    for (const [S, sg] of sends) { S.L[n] += l * sg; S.R[n] += r * sg; }
  }
  if (o.tr) TRANSIENTS.push([start + i0, ms(o.tr)]);
}

function duckCurve(triggers, depthDb, totalMs, holdMs = 14, attMs = 1.5) {
  const red = new Float32Array(N), aN = ms(attMs), hN = ms(holdMs), rN = ms(totalMs - holdMs);
  for (const t of triggers) {
    for (let i = -aN; i < hN + rN; i++) {
      const n = t + i; if (n < 0 || n >= N) continue;
      const v = i < 0 ? 0.5 - 0.5 * Math.cos(Math.PI * (i + aN) / aN) : i < hN ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (i - hN) / rN);
      if (v > red[n]) red[n] = v;
    }
  }
  const g = new Float32Array(N); for (let n = 0; n < N; n++) g[n] = Math.pow(10, -depthDb * red[n] / 20);
  return g;
}
function applyGain(st, g, a = 0, b = N) { for (let n = a; n < b; n++) { st.L[n] *= g[n]; st.R[n] *= g[n]; } }

// ============================================================================ cue registry (-> soundtrack.json)
const CUES = [];
function cue(frame, voice, description, meta = {}) { CUES.push({ frame, voice, description, check: 'onset', ...meta }); }
const bandAround = (h, lo = 0.8, hi = 1.25) => [Math.round(h * lo), Math.round(h * hi)];
const B_DOT = (h) => bandAround(h, 0.9, 1.08); // the pluck's first 10 ms sit at its written pitch
// Nearest F-minor-pentatonic pitch (F Ab Bb C Eb): grains and short pitched foley stay in key.
const PENTA_PC = [5, 8, 10, 0, 3];
function pentaQ(h) { const m = 69 + 12 * Math.log2(h / 440); let best = m, bd = 99; for (let k = Math.floor(m) - 3; k <= Math.ceil(m) + 3; k++) { if (!PENTA_PC.includes(((k % 12) + 12) % 12)) continue; const d = Math.abs(k - m); if (d < bd) { bd = d; best = k; } } return 440 * Math.pow(2, (best - 69) / 12); }

// ---------------------------------------------------------------- common instruments
const B_KICK = [40, 160], B_CLAP = [800, 2600], B_HAT = [7000, 16000], B_SUB = [30, 120];
function kick(frame, o = {}) {
  KICKS.push(f(frame));
  mix('drums', f(frame), kickVoice({ seed: 'kick' + frame, ...o }), { db: o.db ?? -7, tr: 3 });
}
function clap(frame, o = {}) { mix('drums', f(frame), clapVoice({ seed: 'clap' + frame, ...o }), { db: o.db ?? -9, pan: o.pan ?? 0, plate: o.plate ?? -9, tr: 30 }); }
function snare(frame, o = {}) { mix('drums', f(frame), clapVoice({ snare: true, seed: 'snare' + frame, ...o }), { db: o.db ?? -9, pan: o.pan ?? 0, plate: o.plate ?? -10, tr: 30 }); }
function hat(frame, vel = 1, open = false, pan = 0.12) {
  const r = rng('hatvel' + frame), v = vel * (0.93 + 0.07 * r());
  mix('drums', f(frame), hatVoice({ open, seed: 'hat' + frame }), { db: (open ? -19.5 : -17.5) + 20 * Math.log10(v), pan: pan + ((frame / 6) % 2 ? -0.22 : 0.08), tr: 1 });
}
const HUD_TICK_HZ = (k, seed) => 3000 * (1 + 0.012 * (rng(seed)() - 0.5)) * (1 + 0.012 * k); // +-0.6 %, alternating +1.2 %
const HUD_EVENTS = [], TONED = []; // tick events with a fixed tone, rendered after the score (cue order)
function hudTick(frame, db, k = 0, base = 3000) {
  mix('foley', f(frame), tickVoice({ hz: HUD_TICK_HZ(k, 'hud' + frame) * base / 3000, noise: 0.45, clickMs: 3, toneMs: 15, toneTau: 0.004, hold: 0.003, bp: Math.min(9000, base * 1.7), seed: 'hud' + frame }), { db, tr: 4 });
}
function hudEvent(frames, db, description) { HUD_EVENTS.push({ frames, db, description }); }
// The HUD has one voice for the whole reel: every HUD tick (type-on, the seven FIG re-resolves, type-off) is pitched
// on HUD_NOTE (with a +-0.6 % jitter and a +1.2 % alternation per tick). The pitch is fixed, never derived from the
// mix, so no mix change re-pitches the HUD, and the ticks stay at their spec'd level. G7 was chosen once, by
// comparing it with Ab7, Bb7, C8, Eb8 and F8 in audiocheck: it leaves the fewest ticks masked. Ticks under a big
// hit are masked there by design (audiocheck proves each one is masked rather than missing).
const HUD_NOTE = 'G7'; // 3136 Hz, the add9 of the title chord
function renderHud() {
  for (const ev of [...HUD_EVENTS.map((e) => ({ ...e, hud: true, note: HUD_NOTE })), ...TONED]) {
    const h = hz(ev.note);
    cue(ev.frames[0], ev.voice ?? 'TICK', `${ev.description} (tone ${ev.note})`, { end: ev.frames[ev.frames.length - 1], check: 'group', band: [Math.round(h * 0.94), Math.round(h * 1.06)], subs: ev.frames, tickHz: +h.toFixed(1), levelDb: ev.db, ...(ev.hud ? { hud: true } : {}) });
    ev.frames.forEach((fr, k) => (ev.render ? ev.render(fr, k, h) : hudTick(fr, ev.db, k % 2, h)));
  }
}
const FIG = ['FIG. 0 — POINT', 'FIG. 1 — LINE', 'FIG. 2 — PLANE', 'FIG. 3 — LENS', 'FIG. 4 — VOLUME', 'FIG. 5 — FLOW', 'FIG. 6 — FIELD', 'FIG. 7 — FULL STOP'];

// ============================================================================ SCORE (§3 cue list, frame exact)
function score() {
  // ------------------------------------------------------------ Bar 1 (f0-95): intro, point
  cue(0, 'SUB', 'Dot born: sub pop 110->44 Hz (140 ms)', { band: [40, 130] });
  mix('sub', f(0), subVoice({ len: 0.14, f0: 110, f1: 44, glide: 0.14, att: 0.0015, relS: 0.03, drive: 1.3 }), { db: -10 });
  cue(0, 'KICK', 'Soft kick (LP 2 kHz)', { band: B_KICK });
  kick(0, { lp: 2000, click: 0.12, drive: 1.3, db: -9 });
  cue(0, 'TICK', '1 kHz blip (20 ms)', { band: [850, 1200] });
  mix('foley', f(0), sineGlide({ len: 0.02, f0: 1000, att: 0.0008, tailS: 0.008 }), { db: -17, hall: -14 });

  cue(0, 'TICK', 'Rim tick on every 8th, crosshair notches step 45 deg (0-84), -30 dB (tone Ab6)', { end: 84, check: 'group', band: [1560, 1780], subs: [0, 12, 24, 36, 48, 60, 72, 84] });
  for (const fr of [0, 12, 24, 36, 48, 60, 72, 84]) {
    for (const [side, dh] of [[-0.8, 0], [0.8, 14]]) {
      mix('foley', f(fr), tickVoice({ hz: hz('Ab6') + dh, noise: 0.9, clickMs: 2.5, toneMs: 12, toneTau: 0.0035, bp: 3300, bpQ: 1.2, seed: 'rim' + fr + side }), { db: -30, pan: side, specLevel: true, tr: 3 });
    }
  }
  const typeOn = []; for (let k = 0; k < FIG[0].length; k++) typeOn.push(6 + k);
  hudEvent(typeOn, -32, 'HUD types on: one mono tick per character, -32 dB');

  cue(24, 'FX', 'Grid reveal: 2->8 kHz sine zip over 12f', { band: [1800, 3000] });
  mix('fx', f(24), sineGlide({ len: fsec(12) + 0.03, f0: 2000, f1: 8000, glide: fsec(12), att: 0.003, tailS: 0.05, envFn: (t) => 1 - 0.45 * clamp01(t / 0.2) }), { db: -23, hall: -16 });
  cue(24, 'SUB', 'Heartbeat pulse 1: 55 Hz thump', { band: [40, 120] });
  mix('sub', f(24), subVoice({ len: 0.1, f0: 80, f1: 55, glide: 0.03, decay: 0.035, att: 0.002, relS: 0.02, drive: 1.8 }), { db: -11 });
  cue(30, 'SUB', 'Heartbeat pulse 2: 55 Hz thump', { band: [40, 120] });
  mix('sub', f(30), subVoice({ len: 0.16, f0: 76, f1: 55, glide: 0.03, decay: 0.05, att: 0.002, drive: 1.8 }), { db: -13 });

  // Mitosis: children depart TR, TL, BL, BR. Pan by x (children sit at +-c/2; exaggerated to +-0.35).
  [[48, 'F5', 0.35], [50, 'Ab5', -0.35], [52, 'C6', -0.35], [54, 'Eb6', 0.35]].forEach(([fr, nt, pan]) => {
    cue(fr, 'DOT', `Child departs (${pan > 0 ? 'right' : 'left'}): DOT pluck ${nt}`, { band: B_DOT(hz(nt)), pan });
    mix('dot', f(fr), dotVoice(hz(nt)), { db: -12.5, pan, hall: -13 });
  });

  // Ripple pops: 32 pops on F minor pentatonic F5-C7, denser with the front, panned by the cell's x.
  {
    const c = 1 / 18, cells = [];
    for (let k = -16; k < 16; k++) for (let j = -9; j < 9; j++) { const x = (k + 0.5) * c, y = (j + 0.5) * c, d = Math.hypot(x, y); cells.push({ x, y, d, t: 54 + 24 * d / 1.1 }); }
    const penta = ['F5', 'Ab5', 'Bb5', 'C6', 'Eb6', 'F6', 'Ab6', 'Bb6', 'C7'].map(hz), used = new Set(), r = rng('ripple'), pops = [];
    for (let i = 0; i < 32; i++) {
      const target = 54 + 24 * Math.sqrt((i + 0.5) / 32) * 0.99;
      let best = -1, bd = 1e9;
      cells.forEach((cl, ci) => { if (used.has(ci) || cl.t > 78) return; const dd = Math.abs(cl.t - target) + 0.02 * r(); if (dd < bd) { bd = dd; best = ci; } });
      used.add(best); pops.push(cells[best]);
    }
    pops.sort((a, b) => a.t - b.t);
    cue(54, 'GRAINS', 'Ripple: 32 pops on F minor pentatonic (F5-C7), denser with the front, panned by x', { end: 78, check: 'span', band: [650, 2300] });
    pops.forEach((p, i) => {
      const ni = clamp(Math.round(p.d / 1.02 * 8 + (r() - 0.5) * 2), 0, 8), h = penta[ni];
      const v = sineGlide({ len: 0.12, f0: h * 1.3, f1: h, glide: 0.008, att: 0.0008, tailS: 0.03, envFn: (t) => Math.exp(-t / 0.032) });
      mix('music', f(p.t), v, { db: -27 + 4 * (i / 31) + 2 * (r() - 0.5), pan: clamp(p.x / 0.889, -1, 1), hall: -12 });
    });
  }
  cue(72, 'HAT', 'Dots breathe: closed hats 72, 78, 84, 90', { check: 'group', band: B_HAT, subs: [72, 78, 84, 90] });
  [72, 78, 84, 90].forEach((fr, i) => hat(fr, [1, 0.6, 0.85, 0.7][i]));
  cue(84, 'FX', 'Flood: reverse cymbal ending exactly at 96', { end: 96, check: 'end', band: [4000, 12000] });
  {
    const len = f(96) - f(84), cr = reversed(crashVoice({ len: 1.2, t60: 1.0, seed: 'revcym1', splash: 0.2 }));
    const seg = { L: cr.L.subarray(cr.L.length - len), R: cr.R.subarray(cr.R.length - len) };
    const out = stereo(len); for (let i = 0; i < len; i++) { const e = Math.pow(i / len, 1.6) * rel(i, len, ms(1.5)); out.L[i] = seg.L[i] * e; out.R[i] = seg.R[i] * e; }
    mix('fx', f(84), normalize(out), { db: -15, hall: -18 });
  }

  // ------------------------------------------------------------ Bars 2-3 (f96-263): groove, line + plane
  cue(96, 'KICK', 'Shadow plate prints: kick', { band: B_KICK }); kick(96);
  cue(96, 'CLAP', 'Shadow plate prints: clap', { band: B_CLAP }); clap(96);
  cue(96, 'REESE', 'Reese on F1 enters (bed through 191, sidechained)', { band: [150, 700] });
  const wobble = (fr) => { const b = (u) => (u >= 0 && u <= 6) ? Math.sin(Math.PI * u / 6) : 0; return b(fr - 132) + b(fr - 138); };
  cue(132, 'REESE', 'Row wave pulse 1: reese LFO swell', { band: [900, 2600] });
  cue(138, 'REESE', 'Row wave pulse 2: reese LFO swell', { band: [900, 2600] });
  {
    const close = (fr) => fr < 144 ? 1 : fr < 168 ? Math.pow(2, -1.9 * smooth((fr - 144) / 14)) : Math.pow(2, -1.9 * (1 - smooth((fr - 168) / 8)));
    const len = fsec(191 - 96);
    const v = reeseVoice({ len, notes: [{ t: 0, hz: hz('F1') }], lpFn: (t) => { const fr = 96 + t * 60; return 900 * Math.pow(2, 1.5 * wobble(fr)) * close(fr); }, ampFn: (t) => { const fr = 96 + t * 60; return fr < 144 ? 1 : fr < 168 ? 1 - 0.35 * smooth((fr - 144) / 10) : 0.65 + 0.35 * smooth((fr - 168) / 6); }, seed: 'reese2', drive: 2.4 });
    mix('bass', f(96), normalize(v), { db: -10 });
    const sub = subLine({ len, hits: [96, 132, 168].map((fr) => ({ t: fsec(fr - 96), hz: hz('F1'), peak: 1, floor: 0.55, tau: 0.22 })), drive: 1.2 });
    mix('sub', f(96), sub, { db: -17 });
  }
  cue(96, 'FOLEY', 'Plate thud 1 (shadow): LP noise + 90 Hz body, 60 ms', { band: [60, 400] });
  cue(102, 'FOLEY', 'Plate thud 2 (face), brighter', { band: [800, 2000] });
  cue(108, 'FOLEY', 'Plate thud 3 (ground), brightest', { band: [1500, 4000] });
  [[96, 650, -13], [102, 2200, -8.5], [108, 3200, -13]].forEach(([fr, lp, db]) => mix('foley', f(fr), thudVoice({ lp, seed: 'plate' + fr }), { db, tr: 2 })); // thud 2 sits in the 96 kick's tail: brighter and +4.5 dB
  cue(132, 'KICK', 'Halftime groove kick', { band: B_KICK }); kick(132);
  cue(144, 'SNARE', 'Halftime groove snare', { band: B_CLAP }); snare(144);
  cue(168, 'KICK', 'Slit: pickup kick', { band: B_KICK }); kick(168, { db: -6, f0: 165 });
  const h8 = []; for (let fr = 96; fr < 192; fr += 12) h8.push(fr);
  cue(96, 'HAT', 'Halftime groove: hats on 8ths 96-180', { end: 191, check: 'group', band: B_HAT, subs: h8 });
  h8.forEach((fr) => hat(fr, ((fr - 96) / 12) % 2 ? 1 : 0.62));

  cue(120, 'FM', 'Dots stretch into lines: FM glide C4->F4 over 10f', { band: [230, 420] });
  mix('music', f(120), normalize(fmVoice({ len: 0.5, hzFn: (t) => expLerp(hz('C4'), hz('F4'), smooth(t / fsec(10))), ratio: 2, i0: 2.2, i1: 0.8, itau: 0.12, att: 0.006, decay: 0.3, tail: 0.1 })), { db: -15, hall: -11 });

  cue(144, 'FX', 'Collapse: saw falls F4->F2 into a thin F5 sine hum at -30 dB', { end: 166, check: 'onset', band: [300, 1200] });
  {
    const len = fsec(20), n = sec(len), out = new Float32Array(n), a = new Saw(0.1), b = new Saw(0.6), lp1 = new SVF(), lp2 = new SVF();
    for (let i = 0; i < n; i++) {
      const t = i / SR, fr = 144 + t * 60, h = expLerp(hz('F4'), hz('F2'), smooth((fr - 144) / 16));
      if ((i & 15) === 0) { const fc = expLerp(3200, 700, clamp01((fr - 144) / 16)); lp1.set(fc, BW4[0]); lp2.set(fc, BW4[1]); }
      const s = lp2.tick(lp1.tick(0.5 * (a.tick(h * 1.003) + b.tick(h / 1.003))));
      out[i] = s * atk(i, ms(4)) * (1 - smooth((fr - 157) / 7)) * rel(i, n, ms(10));
    }
    mix('music', f(144), normalize(out), { db: -16, hall: -14 });
    const hum = sineGlide({ len: fsec(168 - 155) + 0.012, f0: hz('F5'), att: 0.07, tailS: 0.012 });
    mix('music', f(155), hum, { db: -30, specLevel: true });
  }
  cue(168, 'FX', 'Slit: "shhk" (BP noise at 3 kHz, 80 ms)', { band: [2200, 4200] });
  const shhk = (seed) => {
    const v = sweepVoice({ len: 0.08, f0: 3000, f1: 3300, q: 1.6, envFn: (u) => (u < 0.8 ? 1 - 0.3 * u : (1 - 0.3 * u) * (1 - (u - 0.8) / 0.2)), seed, att: 1.5 });
    const k = tickVoice({ hz: 5200, noise: 1, clickMs: 1.2, toneMs: 3, seed: seed + 'k' }); addInto(v, k, sec(0.066), 0.5); return normalize(v);
  };
  mix('fx', f(168), shhk('shhk168'), { db: -14, hall: -18, tr: 3 });

  // FIG re-resolve (src/hud.js resolveLR): position j of the label changes on frame f0 + j, for
  // max(len(old), len(new)) frames (a shorter new label erases the old tail), so one tick per frame of that.
  const hudResolve = (fr0, k, db = -32) => {
    const subs = [], len = Math.max([...FIG[k - 1]].length, [...FIG[k]].length); for (let j = 0; j < len; j++) subs.push(fr0 + j);
    hudEvent(subs, db, `HUD FIG re-resolve "${FIG[k - 1]}" -> "${FIG[k]}": one mono tick per character (${len}), -32 dB`);
  };
  hudResolve(96, 1); hudResolve(168, 2);

  [[172, -0.75, 'top'], [176, 0, 'middle'], [180, 0.75, 'bottom']].forEach(([fr, pan, arm]) => {
    cue(fr, 'FX', `${arm} arm opens: tape swish panned ${pan < 0 ? 'left' : pan > 0 ? 'right' : 'centre'}`, { band: [700, 2200], pan });
    // 65 ms, envelope peak ~6 ms after the frame: each arm (outExpo, fastest on its first frame) gets its own transient
    mix('fx', f(fr), sweepVoice({ len: 0.065, f0: 700, f1: 3400, q: 1.3, curveFn: (u) => Math.sqrt(u), envFn: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.3)), 1.4), seed: 'swish' + fr, att: 1.5 }), { db: -18, pan, hall: -17 });
  });
  cue(174, 'FOLEY', 'Stem wipes in: wood clack', { band: [1000, 3000], pan: -0.6 });
  mix('foley', f(174), modalVoice({ modes: [[1150, 1, 0.012], [2630, 0.6, 0.007], [4100, 0.3, 0.004]], len: 0.05, strike: 0.5, seed: 'clack' }), { db: -15, pan: -0.6, hall: -18, tr: 2 });

  // Bar 3
  cue(192, 'KICK', 'Bar 3: kick', { band: B_KICK }); kick(192);
  cue(192, 'CLAP', 'Bar 3: clap', { band: B_CLAP }); clap(192);
  const h16a = []; for (let fr = 192; fr < 264; fr += 6) h16a.push(fr);
  cue(192, 'HAT', '16th hats start (192-258)', { end: 263, check: 'group', band: B_HAT, subs: h16a });
  h16a.forEach((fr) => hat(fr, 1.41 * [0.72, 0.6, 1, 0.64][((fr - 192) / 6) % 4])); // +3 dB: the 16ths carry the groove's top end
  // FM bass on 16ths 192-359, LP opens 300 Hz -> 3 kHz over 192-288, sidechained.
  {
    // 16th-step note table ('-' = rest). Bar 3 on an F pedal, bar 4 climbs Ab-Bb-C into the take-off.
    const seq = new Map(), put = (fr0, notes) => notes.forEach((nt, k) => seq.set(fr0 + 6 * k, nt));
    put(192, ['F1', 'F1', 'F2', 'F1', '-', 'F1', 'Ab1', 'F1', 'F1', 'F2', 'F1', 'Eb2', 'F1', 'F1', 'C2', 'Ab1']);
    put(288, ['F1', 'F1', 'F2', 'F1', '-', 'F1', 'Ab1', 'F2']);
    put(336, ['Ab1', 'Bb1', 'C2', 'Eb2']);
    const len = fsec(360 - 192) + 0.02, n = sec(len), stem = new Float32Array(n);
    for (const [fr, nt] of [...seq.entries()].sort((a, b) => a[0] - b[0])) {
      if (nt === '-') continue;
      const v = fmVoice({ len: fsec(5.4), hz: hz(nt), ratio: 1, i0: 2.6, i1: 1.1, itau: 0.045, att: 0.0015, decay: 0.09, sustain: 0.35, tail: 0.012 });
      addInto(stem, v, f(fr) - f(192), (fr % 24 === 0 ? 1 : 0.82));
    }
    const l1 = new SVF(), l2 = new SVF();
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) { const fr = 192 + (i / SR) * 60, fc = fr < 288 ? expLerp(300, 3000, (fr - 192) / 96) : 3000; l1.set(fc, 0.8); l2.set(fc, 0.8); }
      stem[i] = Math.tanh(1.4 * l2.tick(l1.tick(stem[i]))) * rel(i, n, ms(8));
    }
    cue(192, 'FM', 'FM bass on 16ths (192-359), LP 300 Hz -> 3 kHz over 192-288, sidechained', { end: 359, check: 'span', band: [80, 500] });
    mix('bass', f(192), normalize(stem), { db: -12 });
  }
  [[192, -0.75, 0.35, 'top'], [198, -0.75, 0.35, 'middle'], [204, -0.75, 0.35, 'bottom'], [210, -1, -0.62, 'stem']].forEach(([fr, p0, p1, w]) => {
    cue(fr, 'FX', `Scanline prints ${w} pass: print zip (BP noise 2->6 kHz, 90 ms, L->R, -16 dB)`, { band: [1800, 3200] });
    mix('fx', f(fr), sweepVoice({ len: 0.09, f0: 2000, f1: 6000, q: 2.2, envFn: (u) => Math.pow(1 - u, 0.6), seed: 'print' + fr, att: 1.5 }), { db: -16, pan: (n) => lerp(p0, p1, clamp01((n - f(fr)) / ms(90))), specLevel: true });
  });
  cue(216, 'FM', 'Re-layout: short Fm stab', { band: [300, 900] });
  mix('music', f(216), stabVoice({ notes: ['F3', 'Ab3', 'C4', 'F4'].map(hz), seed: 'stab216' }), { db: -13, hall: -13 });
  cue(216, 'KICK', 'Re-layout: tom', { band: [80, 200] });
  mix('drums', f(216), normalize(subVoice({ len: 0.32, f0: 175, f1: 98, glide: 0.06, decay: 0.11, att: 0.0015, drive: 2.0 })), { db: -8, hall: -16, tr: 2 });
  cue(234, 'FX', 'Merge wipe: tape-wipe swish L->R landing in the snare at 240', { end: 240, check: 'end', band: [1500, 4000] });
  {
    const len = f(240) - f(234) + ms(6);
    mix('fx', f(234), sweepVoice({ len: len / SR, f0: 600, f1: 4200, q: 1.1, curveFn: (u) => u * u, envFn: (u) => Math.pow(u, 1.8) * (u > 0.94 ? (1 - u) / 0.06 : 1), seed: 'wipe234' }), { db: -16, pan: (n) => lerp(-0.9, 0.9, clamp01((n - f(234)) / (f(240) - f(234)))), hall: -16 });
  }
  cue(240, 'SNARE', 'Merge lands: snare (full-frame BEAUTY)', { band: B_CLAP }); snare(240, { db: -9 });
  [[252, 'C6', 'top'], [255, 'Eb6', 'middle'], [258, 'F6', 'bottom']].forEach(([fr, nt, w]) => {
    cue(fr, 'FM', `${w} window collapses to hairline: sine tink ${nt}`, { band: bandAround(hz(nt), 0.9, 1.1) });
    mix('music', f(fr), sineGlide({ len: 0.35, f0: hz(nt), att: 0.0006, tailS: 0.05, envFn: (t) => Math.exp(-t / 0.09), partial2: 0.12 }), { db: -19, hall: -12 });
  });
  cue(252, 'DOT', 'Dot leaves for the tittle: DOT pluck F5', { band: B_DOT(hz('F5')), pan: -0.13 });
  mix('dot', f(252), dotVoice(hz('F5')), { db: -9.5, pan: -0.13, hall: -13 });
  cue(252, 'DOT', 'Sine tail gliding 400->900 Hz to 261 (dot glide to T_DOT)', { end: 261, check: 'span', band: [380, 950] });
  mix('music', f(252), sineGlide({ len: fsec(9) + 0.05, f0: 400, f1: 900, glide: fsec(9), att: 0.012, tailS: 0.06 }), { db: -23, pan: (n) => lerp(-0.13, 0.42, clamp01((n - f(252)) / (f(261) - f(252)))), hall: -14 });

  // ------------------------------------------------------------ f264-383: the build, lens
  hudResolve(264, 3);
  for (let k = 0; k < 6; k++) {
    const fr = 264 + k, h = hz(['Ab6', 'Bb6', 'C7', 'Eb7', 'F7', 'Ab7'][k]);
    cue(fr, 'TICK', `Paired glyphs rise (row step ${k + 1}): typewriter ticks, first-word row L, second-word row R`, { band: [1500, 4000] });
    mix('foley', f(fr), typeTick(h, 'tw1' + fr), { db: -21, pan: -0.6, tr: 3 });
    mix('foley', f(fr), typeTick(h * 1.005, 'tw2' + fr), { db: -21, pan: 0.6, tr: 3 });
  }
  cue(264, 'FX', 'Top hairline retracts: hiss panned centre -> right', { end: 276, check: 'span', band: [6000, 14000] });
  mix('fx', f(264), sweepVoice({ len: fsec(12), f0: 6500, f1: 9000, mode: 'hp', envFn: (u) => Math.pow(Math.sin(Math.PI * u), 1.5), seed: 'hiss264' }), { db: -27, pan: (n) => lerp(0, 0.85, clamp01((n - f(264)) / f(12))) });
  cue(276, 'TICK', 'The dotless i arrives under the dot: crisp click', { band: [3000, 9000], pan: 0.4 });
  mix('foley', f(276), tickVoice({ hz: 6200, noise: 1, clickMs: 1.2, toneMs: 4, toneTau: 0.001, bp: 6000, seed: 'crisp276' }), { db: -17, pan: 0.4, tr: 2 });
  cue(276, 'FM', 'F6 ping (tittle squash)', { band: bandAround(hz('F6'), 0.92, 1.08), pan: 0.4 });
  mix('music', f(276), sineGlide({ len: 0.45, f0: hz('F6'), att: 0.0008, tailS: 0.08, envFn: (t) => Math.exp(-t / 0.13) }), { db: -19, pan: 0.4, hall: -10 });

  cue(288, 'KICK', 'Weight wave: kick', { band: B_KICK }); kick(288);
  ['F4', 'G4', 'Ab4', 'Bb4', 'C5', 'Eb5'].forEach((nt, i) => {
    const fr = 288 + 2 * i, pan = -0.6 + 0.24 * i;
    cue(fr, 'TICK', `Weight wave glyph ${i + 1}: pitched tick ${nt}`, { band: bandAround(hz(nt), 0.92, 1.08), pan });
    const v = tickVoice({ hz: hz(nt), noise: 0.35, clickMs: 2, toneMs: 60, toneTau: 0.02, bp: 2400, seed: 'ww' + fr });
    mix('foley', f(fr), v, { db: -18, pan, hall: -16, tr: 2 });
  });
  cue(288, 'FX', 'Weight wave: low stretch whoosh', { end: 310, check: 'span', band: [150, 500] });
  mix('fx', f(288), sweepVoice({ len: fsec(22), f0: 160, f1: 480, q: 0.8, curveFn: (u) => Math.sin(Math.PI * u), envFn: (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 1.2), seed: 'stretch288', st: true, att: 4 }), { db: -16 });
  cue(312, 'KICK', 'K lands: kick', { band: B_KICK }); kick(312);
  cue(312, 'CLAP', 'K lands: clap', { band: B_CLAP }); clap(312);
  cue(336, 'KICK', 'Serif flips begin: kick', { band: B_KICK }); kick(336, { db: -8.5 });
  const h16b = []; for (let fr = 288; fr < 360; fr += 6) h16b.push(fr);
  cue(288, 'HAT', '16th hats (288-354)', { end: 359, check: 'group', band: B_HAT, subs: h16b });
  h16b.forEach((fr) => hat(fr, 1.41 * [0.72, 0.6, 1, 0.64][((fr - 288) / 6) % 4] * (fr >= 336 ? 1.1 : 1)));

  cue(300, 'FX', 'K swings in: high-Q whoosh (BP Q12, 6 kHz -> 1.2 kHz), right -> centre', { end: 312, check: 'onset', band: [4000, 7000] });
  mix('fx', f(300), sweepVoice({ len: fsec(12) + 0.02, f0: 6000, f1: 1200, q: 12, curveFn: (u) => smooth(u), envFn: (u) => Math.pow(clamp01(u / 0.12), 1) * (u > 0.85 ? Math.max(0, 1 - (u - 0.85) / 0.15) : 1), seed: 'kswing', st: true, att: 1 }), { db: -16, pan: (n) => lerp(0.9, 0.2, clamp01((n - f(300)) / f(12))), hall: -14 });
  cue(312, 'FM', 'Shockwave: glass clink FM 1:2.76 on C6', { band: bandAround(hz('C6'), 0.9, 1.1), pan: 0.35 });
  mix('music', f(312), normalize(fmVoice({ len: 0.8, hz: hz('C6'), ratio: 2.76, i0: 4, i1: 0.6, itau: 0.07, att: 0.0005, decay: 0.2, tail: 0.1 })), { db: -14, pan: 0.35, hall: -9, tr: 1 });
  cue(312, 'SUB', 'Shockwave: sub drop 60->30 Hz over 250 ms', { band: B_SUB });
  mix('sub', f(312), subVoice({ len: 0.32, f0: 60, f1: 30, glide: 0.25, shape: 1.5, att: 0.002, decay: 0.18, drive: 1.6 }), { db: -11 });
  cue(312, 'FX', 'Shockwave: 8-bit noise burst, 60 ms', { band: [3000, 12000] });
  {
    const n = ms(60), r = rng('crush312'), v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (r() * 2 - 1) * Math.exp(-i / ms(22)) * atk(i, 24) * rel(i, n, ms(3));
    crush(v, 6, 8); for (let i = 0; i < n; i++) v[i] *= atk(i, 24) * rel(i, n, ms(3));
    mix('fx', f(312), normalize(v), { db: -19, pan: 0.2, tr: 2 });
  }
  // Serif flips M-O-T-I-O-N: snares + 20 ms bitcrush glitch each, left to right.
  [336, 342, 348, 351, 354, 357].forEach((fr, i) => {
    const pan = -0.55 + 0.22 * i;
    cue(fr, 'SNARE', `Serif flip ${'MOTION'[i]}: snare`, { band: B_CLAP, pan });
    snare(fr, { db: -14 + 0.8 * i, pitch: 1 + 0.03 * i, pan: pan * 0.5, plate: -12 });
    cue(fr, 'FX', `Serif flip ${'MOTION'[i]}: 20 ms bitcrush glitch`, { band: [3000, 10000], pan });
    const r = rng('glitch' + fr), g = fmVoice({ len: 0.02, hz: 300 + 900 * r(), ratio: 1.5 + r(), i0: 5, i1: 3, itau: 0.02, att: 0.0005, decay: 1, tail: 0.002 });
    crush(g, 7, 4); for (let k = 0; k < g.length; k++) g[k] *= atk(k, 24) * rel(k, g.length, 48);
    mix('fx', f(fr), normalize(g), { db: -21, pan, tr: 3 });
  });
  // Noise riser + Shepard 336 -> 372; from 360 a 32nd gate and a -12 semitone dive.
  {
    const len = fsec(372 - 336) + 0.004, dive = (t) => { const fr = 336 + t * 60; return fr < 360 ? 1 : Math.pow(2, -smooth((fr - 360) / 12)); }; // runs 4 ms past 372: its own release lies under the gate, the master's 2 ms close is the cut
    const gate32 = (t) => {
      const fr = 336 + t * 60; if (fr < 360) return 1;
      // 1.25 ms ramps; each 32nd opens on the grid and is open for 60% of it, with a -9 dB floor between pulses
      // (the build keeps its energy). The last 32nd (369-372) stays open, so riser and Shepard run at full level
      // into the master's 2 ms close and the vacuum lands exactly on 372.
      const p = ((fr - 360) % 3) / 3, e = 0.075, fl = 0.35;
      const gg = p < e ? 0.5 - 0.5 * Math.cos(Math.PI * p / e) : (fr >= 369 || p < 0.6) ? 1 : p < 0.6 + e ? 0.5 + 0.5 * Math.cos(Math.PI * (p - 0.6) / e) : 0;
      return fl + (1 - fl) * gg;
    };
    const swell = (t) => Math.pow(t / len, 1.7) * Math.pow(10, 5 / 20 * smooth((336 + t * 60 - 360) / 11)); // +5 dB push over 360-371
    cue(336, 'FX', 'Noise riser 336->372 (32nd gate + -12 st dive from 360)', { end: 372, check: 'end', band: [1600, 5000] });
    // band centre climbs 450 Hz -> 4 kHz over 336-360, then dives an octave (x0.5) with everything else
    const k8 = Math.log(2) / Math.log(4000 / 450);
    const nz = sweepVoice({ len, f0: 450, f1: 4000, q: 1.8, curveFn: (u) => { const fr = 336 + u * 36; return fr < 360 ? (fr - 336) / 24 : 1 - k8 * smooth((fr - 360) / 12); }, envFn: () => 1, seed: 'riser336', st: true, att: 5, tailMs: 1 });
    for (let i = 0; i < nz.L.length; i++) { const t = i / SR, g = swell(t) * gate32(t); nz.L[i] *= g; nz.R[i] *= g; }
    mix('fx', f(336), normalize(nz), { db: -9.5, hall: -16 });
    cue(336, 'FX', 'Shepard tone 336->372 (6 octave-spaced sines, rising; dives from 360)', { end: 372, check: 'end', band: [500, 1000] });
    const sh = shepardVoice({ len, octPerSec: 1.1, center: 700, pitchFn: dive, envFn: (t) => (0.2 + 0.8 * swell(t)) * gate32(t) });
    mix('music', f(336), sh, { db: -12.5, hall: -18 });
  }
  cue(360, 'DOT', 'Dot takes off: DOT pluck Ab5', { band: B_DOT(hz('Ab5')), pan: 0.37 });
  mix('dot', f(360), dotVoice(hz('Ab5')), { db: -10, pan: 0.37, hall: -13 });
  for (let k = 0; k < 6; k++) {
    const fr = 360 + k, pan = 0.6 - 0.24 * k;
    cue(fr, 'TICK', `Type drops through its slot (${6 - k} of 6, right to left): reverse typewriter tick`, { band: [1500, 4000], pan });
    const v = reversed(typeTick(hz(['Ab7', 'F7', 'Eb7', 'C7', 'Bb6', 'Ab6'][k]), 'rtw' + fr)); for (let i = 0; i < v.length; i++) v[i] *= rel(i, v.length, 24);
    mix('foley', f(fr), v, { db: -22, pan, tr: 18 });
  }
  cue(364, 'FX', 'Stem slot cut: short "shhk" (callback to 168)', { band: [2200, 4200] });
  mix('fx', f(364), (() => { const v = shhk('shhk364'); return v.subarray(0, ms(55)).map((x, i, a) => x * rel(i, a.length, ms(8))); })(), { db: -16, pan: 0.15, tr: 3 });
  cue(364, 'FX', 'Hairlines retract: hiss', { end: 370, check: 'span', band: [6000, 14000] });
  mix('fx', f(364), sweepVoice({ len: fsec(6), f0: 7000, f1: 9500, mode: 'hp', envFn: (u) => Math.sin(Math.PI * u), seed: 'hiss364' }), { db: -28, pan: (n) => lerp(0, 0.8, clamp01((n - f(364)) / f(6))) });
  cue(372, 'FOLEY', 'Dot lands in the V: wood tock (dry, post-gate, <=15 ms)', { check: 'foley', band: [500, 4000] });
  cue(372, 'GATE', 'G1: digital zero 297,600-307,199 (f372-383)', { end: 383, check: 'gate' });

  // ------------------------------------------------------------ Bar 5 (f384-479): the breath, drums out
  cue(384, 'FOLEY', 'Lights on: relay click', { band: [1500, 5000] });
  mix('foley', f(384), (() => {
    const a = modalVoice({ modes: [[2870, 1, 0.003], [4630, 0.6, 0.002], [1720, 0.5, 0.005]], len: 0.025, strike: 0.8, strikeLp: 7000, strikeMs: 0.8, seed: 'relay' });
    const b = modalVoice({ modes: [[2950, 1, 0.0025], [4400, 0.5, 0.0015]], len: 0.015, strike: 0.8, strikeLp: 7000, strikeMs: 0.6, seed: 'relayb' });
    addInto(a, b, ms(5.5), 0.55); return normalize(a);
  })(), { db: -14, hall: -14, tr: 12 });
  cue(384, 'SUB', 'Lights on: 50 Hz thump', { band: B_SUB });
  mix('sub', f(384), subVoice({ len: 0.2, f0: 68, f1: 50, glide: 0.03, decay: 0.07, att: 0.002, drive: 1.6 }), { db: -11 });
  cue(384, 'FX', 'Light sheet: BP noise 0.8->5 kHz panned L->R over 12f', { end: 396, check: 'onset', band: [700, 1500] });
  mix('fx', f(384), sweepVoice({ len: fsec(13), f0: 800, f1: 5000, q: 1.6, curveFn: (u) => smooth(u), envFn: (u) => Math.pow(Math.sin(Math.PI * clamp01(u * 1.02)), 0.8), seed: 'sheet', att: 2 }), { db: -17, pan: (n) => lerp(-0.95, 0.95, smooth((n - f(384)) / f(12))), hall: -14 });
  cue(384, 'PAD', 'Fm9 pad enters (F2, C3, Ab3, Eb4, G4), ends at 468', { end: 468, check: 'onset', band: [80, 500] });
  mix('music', f(384), padVoice({ len: fsec(468 - 384) + 0.05, notes: ['F2', 'C3', 'Ab3', 'Eb4', 'G4'].map(hz), lpFn: (t) => lerp(1300, 1800, clamp01(t / 0.8)), drift: 0.0012, seed: 'pad384' }), { db: -24, hall: -12 });
  hudResolve(384, 4);
  const yawPan = (n) => { const fr = n / SPF; if (fr < 428) return 0; return 0.7 * Math.sin(Math.PI / 2 * inOutQuint((fr - 428) / 42)); };
  [[396, 'F4'], [408, 'Ab4'], [420, 'C5'], [432, 'Eb5'], [444, 'C5'], [456, 'Ab4']].forEach(([fr, nt]) => {
    cue(fr, 'FM', `Breath: glass bell ${nt} (FM 1:2)${fr >= 428 ? ', pan follows camera yaw' : ''}`, { band: bandAround(hz(nt), 0.9, 1.1) });
    mix('music', f(fr), bellVoice(hz(nt), { i0: 3.2 }), { db: -19.5, pan: yawPan, hall: -10 });
  });
  cue(420, 'SUB', 'F1 sub swell from 420 (ends at 468)', { end: 468, check: 'span', band: B_SUB });
  mix('sub', f(420), subVoice({ len: fsec(48), f0: hz('F1'), att: 0.4, drive: 1.6 }).map((x, i) => x * Math.pow(i / sec(fsec(48)), 1.6)), { db: -15 });
  cue(452, 'DOT', 'Ball lifts out of the notch: DOT pluck C6', { band: B_DOT(hz('C6')) });
  mix('dot', f(452), dotVoice(hz('C6')), { db: -9, hall: -10 });
  cue(452, 'DOT', 'Sine glide F5->C6 over 452-464', { end: 464, check: 'span', band: [650, 1100] });
  mix('music', f(452), sineGlide({ len: fsec(12) + 0.06, f0: hz('F5'), f1: hz('C6'), glide: fsec(12), att: 0.012, tailS: 0.06 }), { db: -21, hall: -10 });
  cue(456, 'FX', 'Build to the vacuum: reverse-reverb riser ending at 468', { end: 468, check: 'end', band: [5000, 12000] });
  // (rendered in main(), once the hall IR exists)
  cue(468, 'FOLEY', 'Blackout: relay-off click (3 ms, dry, post-gate)', { check: 'foley', band: [1500, 6000] });
  cue(468, 'GATE', 'G2: digital zero 374,400-383,999 (f468-479)', { end: 479, check: 'gate' });

  // ------------------------------------------------------------ Bar 6 (f480-575): the drop, flow
  cue(480, 'KICK', 'DROP: kick', { band: B_KICK }); kick(480, { db: -2.5, f0: 165, click: 0.45 });
  cue(480, 'SUB', 'DROP: 808 glide F2->F1 over 300 ms', { band: [80, 130] });
  cue(480, 'FX', 'DROP: noise crash', { band: [5000, 14000] });
  // Crash normalised on its body, not its splash transient (the limiter clamps the transient anyway). -8 dB is the
  // ceiling: louder, it buries hat 486 and HUD tick 488.
  mix('fx', f(480), crashVoice({ len: 2.2, t60: 1.5, seed: 'crash480', metal: 0.35, splash: 0.25 }), { db: -8, hall: -12, tr: 2 });
  cue(480, 'FX', 'DROP: wet splat (noise, LP 8 kHz -> 300 Hz over 150 ms)', { band: [2000, 8000] });
  mix('fx', f(480), lpSweepVoice({ len: 0.26, f0: 8000, f1: 300, sweep: 0.15, q: 2.2, tau: 0.08, seed: 'splat480', st: true }), { db: -13, hall: -16, tr: 2 });
  hudResolve(480, 5);
  [504, 528, 552].forEach((fr) => { cue(fr, 'KICK', 'Drop groove: kick on the beat', { band: B_KICK }); kick(fr, { db: -4 }); });
  cue(504, 'CLAP', 'Drop groove: clap', { band: B_CLAP }); clap(504, { db: -5.5 });
  cue(552, 'CLAP', 'Rupture: clap', { band: B_CLAP }); clap(552, { db: -5.5 });
  [480, 504, 528, 552].forEach((fr) => {
    cue(fr, 'FX', 'Wall pumps: wet thump on the kick (LP 2 kHz -> 200 Hz, 80 ms)', { band: [500, 2000] });
    mix('fx', f(fr), lpSweepVoice({ len: 0.1, f0: 2000, f1: 200, sweep: 0.08, q: 3.2, tau: 0.045, body: 0.6, bodyHz: 120, seed: 'wet' + fr }), { db: -14, tr: 2 });
  });
  const h16c = []; for (let fr = 480; fr < 576; fr += 6) h16c.push(fr);
  cue(480, 'HAT', 'Drop groove: 16th hats (open on the offbeat 8ths)', { end: 575, check: 'group', band: B_HAT, subs: h16c });
  h16c.forEach((fr) => { const s = ((fr - 480) / 6) % 4; hat(fr, 1.6 * [0.8, 0.78, 1, 0.78][s], s === 2); });
  {
    const len = fsec(96), notes = [[480, 'F1'], [504, 'Ab1'], [528, 'F1'], [552, 'Ab1']].map(([fr, nt]) => ({ t: fsec(fr - 480), hz: hz(nt) }));
    cue(480, 'REESE', 'Drop groove: reese alternating F1 / Ab1 per beat, sidechained', { end: 575, check: 'span', band: [150, 900] });
    mix('bass', f(480), normalize(reeseVoice({ len, notes, glide: 0.01, hpMid: 95, width: 1.0, drive: 3.0, seed: 'reese6' })), { db: -3 }); // LP 900 Hz per spec
    // Sub line for bars 6-7 (one oscillator): the 808 at 480, then F1/Ab1 under the reese, F1 for groove B.
    const hits = [{ t: 0, hz: hz('F1'), from: hz('F2'), glide: 0.3, peak: 1, floor: 0.55, tau: 0.38 }];
    [[504, 'Ab1'], [528, 'F1'], [552, 'Ab1'], [576, 'F1'], [600, 'F1'], [624, 'F1'], [648, 'F1']].forEach(([fr, nt]) => hits.push({ t: fsec(fr - 480), hz: hz(nt), glide: 0.03, peak: fr === 576 ? 1 : 0.75, floor: fr >= 576 ? 0.32 : 0.4, tau: 0.3 }));
    mix('sub', f(480), subLine({ len: fsec(672 - 480), hits, drive: 1.4 }), { db: -12 }); // less sub peak into the limiter, so the drop's mids and top come through
  }
  [492, 516, 540].forEach((fr) => {
    cue(fr, 'FX', 'Ink pours: bloop (sine 800->200 Hz, 90 ms)', { band: [500, 900] });
    mix('fx', f(fr), sineGlide({ len: 0.1, f0: 800, f1: 200, glide: 0.09, att: 0.0015, tailS: 0.02, envFn: (t) => Math.exp(-t / 0.05) }), { db: -13, hall: -16 });
    cue(fr, 'GRAINS', 'Ink pours: 20 bubbly grains', { end: fr + 15, check: 'span', band: [300, 2500] });
    const r = rng('bubbles' + fr);
    for (let k = 0; k < 20; k++) {
      const t = 0.015 + 0.22 * Math.pow(r(), 1.4), h = expLerp(350, 1500, r());
      mix('fx', f(fr) + sec(t), grainVoice(h, 0.02 + 0.03 * r(), { chirp: 1.5 + 0.8 * r() }), { db: -27 - 4 * r(), pan: (r() - 0.5) * 1.1 });
    }
  });
  [[552, 0], [558, 1], [564, 2], [567, 3], [570, 4], [573, 5]].forEach(([fr, k]) => {
    cue(fr, 'SNARE', `Rupture: snare ${k + 1} of 6 (pitch and LP rise)`, { band: B_CLAP });
    snare(fr, { db: -11 + 0.8 * k, pitch: 1 + 0.07 * k, lp: expLerp(2500, 14000, k / 5), plate: -13 });
  });
  cue(564, 'FX', 'Flood front: two-band splash whoosh (peaks at 574, sucks out into 576)', { end: 575, check: 'end', band: [2500, 9000] });
  {
    const len = fsec(12), env = (u) => Math.pow(u, 1.6) * (u > 0.86 ? Math.max(0, 1 - (u - 0.86) / 0.14) : 1); // sucks out just before 576
    const lo = sweepVoice({ len, f0: 250, f1: 800, q: 1.0, envFn: env, seed: 'splashlo', st: true });
    const hi = sweepVoice({ len, f0: 3000, f1: 9500, q: 0.8, envFn: env, seed: 'splashhi', st: true });
    mix('fx', f(564), lo, { db: -17 }); mix('fx', f(564), hi, { db: -15, hall: -18 });
  }

  // ------------------------------------------------------------ Bar 7 (f576-671): drop 2, field
  cue(576, 'KICK', 'DROP 2: kick (no crash)', { band: B_KICK }); kick(576, { db: -5 });
  cue(576, 'SUB', 'DROP 2: F1 sub', { band: B_SUB });
  cue(576, 'FX', 'Slash: two high-passed noise zips, hard left and hard right, 576-579', { band: [6000, 14000] });
  [-1, 1].forEach((side) => mix('fx', f(576), sweepVoice({ len: fsec(3) + 0.012, f0: 2500, f1: 11000, mode: 'hp', curveFn: (u) => u, envFn: (u) => (u < 0.8 ? 1 : 1 - (u - 0.8) / 0.2), seed: 'zip576' + side, att: 1 }), { db: -12, pan: side, tr: 2 }));
  cue(576, 'FM', 'DROP 2: Fm stab', { band: [300, 900] });
  mix('music', f(576), stabVoice({ notes: ['F3', 'C4', 'Ab4', 'C5'].map(hz), seed: 'stab576', decay: 0.16, lp: 5200 }), { db: -9.5, hall: -12 });
  hudResolve(576, 6);
  cue(579, 'GRAINS', 'Slash shatters: glitter burst, 120 grains 4-10 kHz, edges -> centre', { end: 585, check: 'onset', band: [4000, 10000] });
  {
    const r = rng('glitterburst');
    for (let k = 0; k < 120; k++) {
      const u = r(), t = f(579) + u * (f(585) - f(579)), side = r() < 0.5 ? -1 : 1;
      mix('fx', t, grainVoice(pentaQ(expLerp(4000, 10000, r())), 0.018 + 0.02 * r()), { db: -26 - 5 * r(), pan: side * (1 - 0.9 * u) });
    }
  }
  [600, 624, 648].forEach((fr) => { cue(fr, 'KICK', 'Groove B: kick', { band: B_KICK }); kick(fr, { db: fr === 648 ? -7 : -5.5 }); });
  [600, 648].forEach((fr) => { cue(fr, 'CLAP', 'Groove B: clap', { band: B_CLAP }); clap(fr, { db: -7 }); });
  cue(576, 'GRAINS', 'Groove B: glitter grain bed', { end: 647, check: 'span', band: [5000, 12000] });
  {
    const r = rng('glitterbed');
    for (let s = 576; s < 648; s += 1.5) {
      const accent = (s - 576) % 6 === 0, p = accent ? 1 : 0.55;
      if (r() > p) continue;
      mix('stem7', f(s) + Math.round((accent ? 0 : r() * 200)), grainVoice(pentaQ(expLerp(5000, 11000, r())), 0.015 + 0.02 * r()), { db: (accent ? -26 : -32) - 3 * r(), pan: (r() - 0.5) * 1.6 });
    }
  }
  {
    const pat = ['F4', 'Ab4', 'C5', 'Eb5', 'F5', 'Eb5', 'C5', 'Ab4', 'Bb4', 'C5', 'Eb5', 'Ab5'];
    const subs = []; for (let fr = 576; fr < 648; fr += 6) subs.push(fr);
    cue(576, 'FM', 'Groove B: FM pluck arp, F minor pentatonic 16ths, 3/16 ping-pong delay (18f)', { end: 647, check: 'span', band: [330, 900], subs });
    subs.forEach((fr, k) => {
      const v = fmVoice({ len: 0.22, hz: hz(pat[k % 12]), ratio: 1, i0: 2.4, i1: 0.35, itau: 0.035, att: 0.001, decay: 0.08, tail: 0.04 });
      mix('stem7', f(fr), normalize(v), { db: (k % 4 === 0 ? -11 : k % 2 ? -14.5 : -13), pan: k % 2 ? 0.18 : -0.18, hall: -18 });
    });
  }
  cue(600, 'GRAINS', 'Peel + comet launch: 300 grains 2-8 kHz, edges -> centre', { end: 626, check: 'onset', band: [2000, 8000] });
  {
    const r = rng('peel600');
    for (let k = 0; k < 300; k++) {
      const u = Math.pow(r(), 1.35), t = f(600) + u * (f(626) - f(600)), side = r() < 0.5 ? -1 : 1;
      mix('fx', t, grainVoice(pentaQ(expLerp(2000, 8000, r())), 0.02 + 0.025 * r()), { db: -30 - 6 * r() + 3 * (1 - u), pan: side * Math.pow(1 - u, 0.8) });
    }
  }
  cue(600, 'DOT', 'Comet launches: DOT pluck C6', { band: B_DOT(hz('C6')), pan: 0.3 });
  mix('dot', f(600), dotVoice(hz('C6')), { db: -7, pan: 0.3, hall: -12 });
  cue(624, 'FM', 'Lattice snap: dry metallic snap (FM 1:3.5, 40 ms) on the kick + sidechain pump', { band: [600, 3000] });
  mix('foley', f(624), normalize(fmVoice({ len: 0.04, hz: hz('F5'), ratio: 3.5, i0: 6, i1: 1, itau: 0.008, att: 0.0003, decay: 0.012, tail: 0.008 })), { db: -12, tr: 2 });
  cue(636, 'GRAINS', 'Converge: reverse granular swell rising in pitch, ending at 672', { end: 672, check: 'end', band: [500, 4000] });
  {
    const r = rng('revswell');
    for (let k = 0; k < 380; k++) {
      const u = Math.pow(r(), 0.55), dur = 0.025 + 0.035 * r(), s = f(636) + u * (f(672) - f(636)), e = Math.min(s + sec(dur), f(672));
      if (e - s < 200) continue;
      const h = pentaQ(expLerp(350, 3400, Math.pow(u, 1.2)) * Math.pow(2, (r() - 0.5) * 4 / 12));
      const g = grainVoice(h, (e - s) / SR, { rev: true });
      if (u > 0.8) { new Biquad('peak', 3000, 1, -4).run(g); for (let i = 0; i < g.length; i++) g[i] *= rel(i, g.length, 24); } // the pile-up into 672 was the reel's loudest 2-5 kHz moment
      mix('fx', s, g, { db: -40 + 15 * u - 3 * r(), pan: (r() - 0.5) * 2 * (0.3 + 0.6 * u), hall: -16 });
    }
  }
  cue(648, 'FX', 'Tape-stretch over 648-672 (arp, delay, glitter bed and sub slow down); drums out after 648', { end: 672, check: 'span', band: [100, 1000] });
  cue(660, 'DOT', 'Comet lands at S0: quiet DOT pluck F5', { band: B_DOT(hz('F5')), pan: -0.6 });
  mix('dot', f(660), dotVoice(hz('F5')), { db: -18, pan: -0.6, hall: -12 });

  // ------------------------------------------------------------ Bars 8-10 (f672-899): title, full-stop
  cue(672, 'PAD', 'Name resolves: soft Fm(add9) chord, no kick', { band: [300, 900] });
  {
    const chord = ['F3', 'C4', 'G4', 'Ab4', 'C5'].map(hz);
    mix('music', f(672), padVoice({ len: fsec(768 - 672) + 0.06, notes: chord, att: 0.03, relS: 0.06, lpFn: (t) => lerp(2200, 1400, clamp01(t / 1.2)), ampFn: (t) => 0.55 + 0.45 * Math.exp(-t / 0.35), seed: 'pad672' }), { db: -23, hall: -12 });
    const glass = new Float32Array(sec(1.6));
    ['F4', 'Ab4', 'C5', 'G5'].forEach((nt, k) => addInto(glass, bellVoice(hz(nt), { len: 1.6, i0: 2.5, att: 0.012, decay: 0.6 }), 0, 0.5));
    mix('music', f(672), normalize(glass), { db: -22, hall: -11 });
  }
  cue(672, 'GRAINS', 'Resolve dissolve: granular fizz sweeping L->R over 672-684', { end: 684, check: 'onset', band: [9000, 13000] });
  {
    const r = rng('fizz672');
    for (let k = 0; k < 90; k++) {
      const u = r(), t = f(672) + u * (f(684) - f(672));
      mix('fx', t, grainVoice(pentaQ(expLerp(5500, 12000, r())), 0.015 + 0.02 * r()), { db: -29 - 5 * r(), pan: clamp(-0.9 + 1.8 * u + (r() - 0.5) * 0.2, -1, 1) });
    }
  }
  hudResolve(672, 7);
  cue(672, 'SUB', 'Reading time: F1 sub (672-767)', { end: 767, check: 'span', band: B_SUB });
  mix('sub', f(672), subVoice({ len: fsec(768 - 672) + 0.02, f0: hz('F1'), att: 0.12, relS: 0.02, drive: 1.2 }), { db: -19 });
  cue(708, 'FOLEY', 'Dot squashes at S0: soft felt "tuck" (LP 400 Hz, 40 ms)', { band: [50, 400], pan: -0.55 });
  {
    const n = ms(40), r = rng('tuck'), l1 = new SVF(400, 0.6), l2 = new SVF(400, 0.9), v = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; l1.tick(r() * 2 - 1); l2.tick(l1.lp); ph += 72 / SR; v[i] = (l2.lp * 1.5 + 0.8 * Math.sin(TAU * ph)) * Math.exp(-t / 0.012) * atk(i, ms(2.5)) * rel(i, n, ms(8)); }
    mix('foley', f(708), normalize(v), { db: -11, pan: -0.55 });
  }
  cue(712, 'DOT', 'Hop to the first letter: DOT pluck F4', { band: B_DOT(hz('F4')), pan: -0.62 });
  mix('dot', f(712), dotVoice(hz('F4')), { db: -10, pan: -0.62, hall: -12 });
  // Touches: signature FM bells F4 Ab4 C5 Eb5 F5 C6 (1:2, 1.2 s) + 3 ms touch click, panned by glyph x.
  {
    // Letters of config.name (uppercased, letters only), Δ = 3·max(1, ⌊10/(n−1)⌋) (§2.3). Glyph centres: measured
    // estimates for NEKVIT (cap 0.20, kerned), otherwise spread evenly over the same block.
    const name = [...String(CONFIG.name ?? 'NEKVIT').toUpperCase()].filter((ch) => /\p{L}/u.test(ch)).join(''), n = name.length, delta = 3 * Math.max(1, Math.floor(10 / (n - 1)));
    const sig = ['F4', 'Ab4', 'C5', 'Eb5', 'F5', 'C6'];
    const glyphX = name === 'NEKVIT' ? [-0.52, -0.32, -0.125, 0.055, 0.205, 0.345] : Array.from({ length: n }, (_, i) => lerp(-0.52, 0.345, n > 1 ? i / (n - 1) : 0.5));
    for (let i = 0; i < n; i++) {
      const fr = 720 + i * delta, nt = sig[i % 6], pan = clamp(glyphX[i] / 0.889 * 1.3, -1, 1);
      cue(fr, 'FM', `Touch ${name[i]}: signature bell ${nt} (FM 1:2, 1.2 s), window opens`, { band: bandAround(hz(nt), 0.9, 1.1), pan });
      mix('music', f(fr), bellVoice(hz(nt), { i0: 3 }), { db: -21.5, pan, hall: -10 });
      cue(fr, 'TICK', `Touch ${name[i]}: 3 ms touch click`, { band: [3000, 9000], pan });
      mix('foley', f(fr), tickVoice({ hz: 5400, noise: 1, tone: 0.3, clickMs: 3, toneMs: 3, toneTau: 0.001, bp: 5200, seed: 'touch' + fr }), { db: -21, pan, tr: 3 });
    }
  }
  cue(754, 'DOT', 'Final hop takes off: DOT pluck C6', { band: B_DOT(hz('C6')), pan: 0.4 });
  mix('dot', f(754), dotVoice(hz('C6')), { db: -9, pan: 0.4, hall: -12 });
  cue(754, 'FX', 'Reverse crash ending at 768', { end: 768, check: 'end', band: [9000, 16000] });
  {
    const len = f(768) - f(754), cr = reversed(crashVoice({ len: 1.6, t60: 1.3, seed: 'revcrash754', splash: 0.3 }));
    const out = stereo(len); for (let i = 0; i < len; i++) { const e = Math.pow(i / len, 2.4) * rel(i, len, ms(2)); out.L[i] = cr.L[cr.L.length - len + i] * e; out.R[i] = cr.R[cr.R.length - len + i] * e; }
    mix('fx', f(754), normalize(out), { db: -10, hall: -16 });
  }
  cue(768, 'KICK', 'FINAL HIT: kick', { band: B_KICK }); kick(768, { db: -1.5, f0: 160, click: 0.3 });
  cue(768, 'SUB', 'FINAL HIT: F1 sub', { band: B_SUB });
  mix('sub', f(768), subLine({ len: 0.8, hits: [{ t: 0, hz: hz('F1'), from: hz('F2'), glide: 0.08, peak: 1, floor: 0, tau: 0.4 }], drive: 1.4, relS: 0.25 }), { db: -10 });
  cue(768, 'FX', 'FINAL HIT: crash', { band: [5000, 14000] });
  // Body-heavy crash with a 6 ms attack: top end over the reverse crash without a transient that only feeds the limiter
  mix('fx', f(768), crashVoice({ len: 2.2, t60: 1.4, seed: 'crash768', metal: 0.6, splash: 0.5, attMs: 6 }), { db: -4, hall: -9, tr: 2 });
  cue(768, 'PAD', 'FINAL HIT: full Fm(add9) stab (0.6 s; the hall carries the tail)', { band: [150, 700] });
  {
    const notes = ['F2', 'C3', 'F3', 'Ab3', 'C4', 'G4', 'Ab4', 'C5'].map(hz);
    const saw = padVoice({ len: 0.6, notes, att: 0.004, relS: 0.25, lpFn: (t) => 1300 + 4200 * Math.exp(-t / 0.18), ampFn: (t) => 0.45 + 0.55 * Math.exp(-t / 0.3), seed: 'stab768' }); // dense body: loudness without more peak
    for (let i = 0; i < saw.L.length; i++) { const e = Math.exp(-i / SR / 1.3); saw.L[i] *= e; saw.R[i] *= e; }
    mix('music', f(768), normalize(saw), { db: -9.5, hall: -7 });
    const glass = new Float32Array(sec(1.6));
    ['C5', 'G5', 'Ab5', 'C6'].forEach((nt) => addInto(glass, bellVoice(hz(nt), { len: 1.6, i0: 3.5, decay: 0.36 }), 0, 0.5));
    mix('music', f(768), normalize(glass), { db: -12, hall: -7 });
  }
  cue(768, 'FOLEY', 'FINAL HIT: landing thock', { band: [200, 800], pan: 0.66 });
  mix('foley', f(768), modalVoice({ modes: [[240, 1, 0.035], [560, 0.55, 0.02], [1300, 0.25, 0.01]], len: 0.12, strike: 0.5, strikeLp: 3000, seed: 'thock' }), { db: -11, pan: 0.66, tr: 2 });
  TONED.push({ frames: [768, 769, 770, 771], db: -13, note: 'C9', voice: 'TICK', description: 'Windows snap shut (bottom to top): four shutter clicks over 768-771', render: (fr, k, h) => {
    // leaf shutter: blade click + a short ring (C9, above the final hit), then the latch 3.5 ms later
    const v = tickVoice({ hz: h * (1 + 0.01 * k), noise: 0.8, tone: 1, clickMs: 1.2, toneMs: 9, toneTau: 0.0028, bp: Math.min(9000, h * 1.6), seed: 'shut' + fr });
    const w = new Float32Array(ms(14)); addInto(w, v, 0, 1); addInto(w, v.subarray(0, ms(10)), ms(3.5), 0.45);
    for (let i = 0; i < w.length; i++) w[i] *= rel(i, w.length, ms(2));
    mix('foley', f(fr), normalize(w), { db: -13, pan: 0.3 - 0.2 * k, tr: 6 }); // up 2.5 dB: the final crash's body sits on 769
  } });
  cue(768, 'FX', 'Rule zips right to left: 3->6 kHz zip (callback to the f24 zip)', { end: 780, check: 'onset', band: [2850, 3300] });
  mix('fx', f(768), sineGlide({ len: fsec(12) + 0.03, f0: 3000, f1: 6000, glide: fsec(12), att: 0.003, tailS: 0.05, envFn: (t) => 1 - 0.4 * clamp01(t / 0.2) }), { db: -20, pan: (n) => lerp(0.75, -0.75, clamp01((n - f(768)) / f(12))), hall: -14 });
  cue(792, 'FX', 'Role line prints in: air swell (BP noise at 1.5 kHz, 20f)', { end: 812, check: 'span', band: [1100, 2000] });
  mix('fx', f(792), sweepVoice({ len: fsec(20), f0: 1500, f1: 1600, q: 1.8, envFn: (u) => Math.pow(Math.sin(Math.PI * u), 1.6), seed: 'air792', st: true, att: 3 }), { db: -22, hall: -12 });
  cue(792, 'FM', 'Role line prints in: F6 harmonic', { end: 812, check: 'span', band: bandAround(hz('F6'), 0.95, 1.05) });
  mix('music', f(792), sineGlide({ len: 0.6, f0: hz('F6'), att: 0.07, tailS: 0.22, envFn: (t) => Math.exp(-t / 0.3) }), { db: -26, pan: -0.25, hall: -8 });
  [792, 795, 798, 801].forEach((fr, k) => {
    const h = hz(['C7', 'Eb7', 'F7', 'Ab7'][k]);
    cue(fr, 'TICK', `Year digit ${k + 1} types on: tick`, { band: bandAround(h, 0.93, 1.07), pan: 0.5 });
    mix('foley', f(fr), typeTick(h, 'year' + fr), { db: -23, pan: 0.5, tr: 3 });
  });
  const typeOff = []; for (let fr = 800; fr < 812; fr++) typeOff.push(fr);
  hudEvent(typeOff, -36, 'HUD types off: one tick per frame, -36 dB');
  cue(812, 'FX', 'Poster: reverb tail', { end: 899, check: 'span', band: [100, 4000] });
  cue(840, 'FX', 'Room tone at -60 dB from 840', { end: 899, check: 'span', band: [100, 2000] });
  cue(870, 'FX', 'Fade 870 -> digital silence at 899', { end: 899, check: 'fade' });
}

// ============================================================================ space: reverbs
function makeIR({ len, pre, t60, lp0, lp1, seed, hp = 150, er = 0, density = 1 }) {
  const p0 = sec(pre), n = p0 + sec(len), ir = stereo(n);
  for (let c = 0; c < 2; c++) {
    const r = rng(seed + ':' + c), o = c ? ir.R : ir.L; let s1 = 0, s2 = 0;
    for (let i = p0; i < n; i++) {
      const t = (i - p0) / SR, a = Math.exp(-TAU * expLerp(lp0, lp1, t / len) / SR);
      const w = density >= 1 || r() < density ? r() * 2 - 1 : 0;
      s1 = (1 - a) * w + a * s1; s2 = (1 - a) * s1 + a * s2;
      o[i] = s2 * Math.exp(-6.9078 * t / t60) * atk(i - p0, ms(1.5)) * rel(i - p0, n - p0, sec(0.12));
    }
    if (er) for (let k = 0; k < 8; k++) { const at = p0 + ms(3 + 9 * k + 4 * r()); o[at] += er * Math.pow(0.72, k) * (r() < 0.5 ? -1 : 1); }
    filt(o, 'hp', hp, 0.7);
  }
  let e = 0; for (let i = 0; i < n; i++) e += (ir.L[i] ** 2 + ir.R[i] ** 2) / 2;
  const g = 1 / Math.sqrt(e); for (let i = 0; i < n; i++) { ir.L[i] *= g; ir.R[i] *= g; }
  return ir;
}
const SEGMENTS = [[0, G1[0]], [G1[0], G2[0]], [G2[0], N]]; // reverb tails never cross a vacuum

// ============================================================================ master chain
function glueCompress(L, R, { thrDb = -16, ratio = 2, kneeDb = 6, attMs = 10, relMs = 140, rmsMs = 12 } = {}) {
  const aA = Math.exp(-1 / (SR * attMs / 1000)), aR = Math.exp(-1 / (SR * relMs / 1000)), aM = Math.exp(-1 / (SR * rmsMs / 1000));
  // The detector hears the mix through a 150 Hz HP (the audio path stays full range): sub energy alone must not
  // pump the glue, or it takes the drop down with it.
  let ms2 = 0, g = 0, grSum = 0, grMax = 0; const hpL = new Biquad('hp', 150, 0.7), hpR = new Biquad('hp', 150, 0.7);
  for (let n = 0; n < L.length; n++) {
    const xl = hpL.tick(L[n]), xr = hpR.tick(R[n]); const p = Math.max(xl * xl, xr * xr); ms2 = aM * ms2 + (1 - aM) * p;
    const lev = 10 * Math.log10(ms2 + 1e-12), over = lev - thrDb;
    const gr = over <= -kneeDb / 2 ? 0 : over >= kneeDb / 2 ? over * (1 - 1 / ratio) : (1 - 1 / ratio) * (over + kneeDb / 2) ** 2 / (2 * kneeDb);
    g = gr > g ? aA * g + (1 - aA) * gr : aR * g + (1 - aR) * gr;
    const k = Math.pow(10, -g / 20); L[n] *= k; R[n] *= k; grSum += g; if (g > grMax) grMax = g;
  }
  return { avgGr: grSum / L.length, maxGr: grMax };
}
// Sliding-window minimum over [i, i + w] (monotonic deque).
function slidingMinFwd(x, w) {
  const n = x.length, out = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && x[dq[t - 1]] >= x[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + w) h++;
    out[i] = x[dq[h]];
  }
  return out;
}
// Lookahead peak limiter on true-peak detection. Each segment is independent (the lookahead
// buffer is flushed at the gate edges). Gain: min-filter over 2W, release, two W-boxes.
// For any sample p the applied gain is <= the required gain at p (see comment in audiocheck).
function limitSegments(L, R, ceiling, bounds, W = ms(1.5), relMs = 80) {
  const tp = truePeakEnv(L, R), relC = Math.exp(-1 / (SR * relMs / 1000)); let maxGr = 0;
  for (const [a, b] of bounds) {
    const len = b - a; if (len <= 0) continue;
    const req = new Float32Array(len);
    for (let i = 0; i < len; i++) req[i] = Math.min(1, ceiling / Math.max(tp[a + i], 1e-9));
    const m = slidingMinFwd(req, 2 * W), r = new Float32Array(len);
    let prev = m[0];
    for (let i = 0; i < len; i++) { const v = m[i]; prev = v <= prev ? v : v + (prev - v) * relC; r[i] = prev; }
    const box = (x) => { const o = new Float32Array(len); let acc = x[0] * (W + 1); for (let i = 0; i < len; i++) { acc += x[i] - (i - W - 1 >= 0 ? x[i - W - 1] : x[0]); o[i] = acc / (W + 1); } return o; };
    const g = box(box(r));
    for (let i = 0; i < len; i++) { const gi = Math.min(g[i], 1); L[a + i] *= gi; R[a + i] *= gi; const d = -20 * Math.log10(gi); if (d > maxGr) maxGr = d; }
  }
  return maxGr;
}

// Post-gate dry foley (never touches the limiter or the reverb).
function woodTock() { // <= 15 ms (672 samples)
  return normalize(modalVoice({ modes: [[720, 1, 0.0045], [1690, 0.55, 0.003], [2860, 0.3, 0.0018]], len: 0.014, strike: 0.55, strikeLp: 4500, strikeMs: 0.8, seed: 'tock372', tailMs: 3 }));
}
function relayOff() { // 3 ms = 144 samples. Body at 5.4-6.2 kHz, above the reverse-reverb riser it cuts, so it reads as its own click
  const n = ms(3), r = rng('relayoff'), sv = new SVF(5400, 1.4), out = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; sv.tick(r() * 2 - 1); ph += 6200 / SR; out[i] = (sv.bpn * Math.exp(-t / 0.0006) + 0.55 * Math.sin(TAU * ph) * Math.exp(-t / 0.0009)) * rel(i, n, ms(1)); }
  return normalize(out);
}

// ============================================================================ main
function main() {
  log('score');
  score();
  const IR_HALL = makeIR({ len: 1.8, pre: 0.012, t60: 1.8, lp0: 10000, lp1: 2400, seed: 'hallIR', hp: 180, er: 0.25 });
  const IR_PLATE = makeIR({ len: 2.4, pre: 0.0, t60: 2.4, lp0: 14000, lp1: 4500, seed: 'plateIR', hp: 350 });

  // Reverse-reverb riser 456 -> 468: an Fm9 bell chord through the hall IR (predelay removed), reversed.
  {
    const src = new Float32Array(sec(0.5)), rn = rng('rrsrc'), bp = new SVF(3500, 0.7);
    ['F4', 'Ab4', 'C5', 'Eb5', 'G5'].forEach((nt) => addInto(src, bellVoice(hz(nt), { len: 0.5, decay: 0.2 }), 0, 0.3));
    for (let i = 0; i < ms(60); i++) { bp.tick(rn() * 2 - 1); src[i] += 2.6 * bp.bpn * Math.exp(-i / ms(15)) * atk(i, 24); } // a brushed hit so the swell has air
    const irNoPre = { L: IR_HALL.L.subarray(sec(0.012)), R: IR_HALL.R.subarray(sec(0.012)) };
    const len0 = src.length + irNoPre.L.length;
    const padded = new Float32Array(len0); padded.set(src);
    const wet = convolveStereo(padded, padded, irNoPre, [[0, len0]], len0);
    const rv = reversed(wet), len = f(468) - f(456), out = stereo(len);
    for (let i = 0; i < len; i++) { const e = Math.pow(i / len, 2.2); out.L[i] = rv.L[len0 - len + i] * e; out.R[i] = rv.R[len0 - len + i] * e; }
    mix('fx', f(456), normalize(out), { db: -9.5 });
  }

  log('buses');
  // Bar-7 bed: ping-pong delay (3/16 = 18f) then the tape-stretch 648-672.
  {
    const D = f(18), dl = new Float32Array(D), dr = new Float32Array(D), fb = 0.42, wet = dB(-8);
    const lpl = new Biquad('lp', 4200), lpr = new Biquad('lp', 4200), hpl = new Biquad('hp', 380), hpr = new Biquad('hp', 380);
    let idx = 0;
    for (let n = f(576); n < f(672); n++) {
      const x = 0.5 * (STEM7.L[n] + STEM7.R[n]), yl = dl[idx], yr = dr[idx];
      dl[idx] = hpl.tick(lpl.tick(x + fb * yr)); dr[idx] = hpr.tick(lpr.tick(fb * yl)); // L at 18f, R at 36f, L at 54f ...
      STEM7.L[n] += wet * yl; STEM7.R[n] += wet * yr;
      idx = (idx + 1) % D;
    }
    for (let n = f(672); n < N; n++) { STEM7.L[n] = 0; STEM7.R[n] = 0; }
    tapeStretch([STEM7.L, STEM7.R, BUS.sub.L, BUS.sub.R], f(648), f(672));
    // The 0.28x read rate drags the F1 sub towards 12 Hz: a 4th-order 32 Hz HP over the whole bar 6-7 sub line
    // (it starts from the silence of G2, so the filter starts clean; F1 loses 0.35 dB), ring-out added after 672.
    for (const ch of [BUS.sub.L, BUS.sub.R]) {
      const a0 = f(468), seg = new Float64Array(f(672) - a0 + ms(200)); for (let n = a0; n < f(672); n++) seg[n - a0] = ch[n];
      filt4(seg, 'hp', 32);
      for (let i = 0; i < seg.length; i++) { const n = a0 + i; if (n < f(672)) ch[n] = seg[i]; else ch[n] += seg[i] * rel(i - (f(672) - a0), seg.length - (f(672) - a0), ms(60)); }
    }
    for (let n = f(576); n < f(672); n++) { BUS.music.L[n] += STEM7.L[n]; BUS.music.R[n] += STEM7.R[n]; }
  }

  // Sidechains: bass -8 dB / 120 ms on every kick; music and hall return pump lightly; 624 pump. The DOT bus is
  // kept out of the music ducks, so the dot's signature plucks land at one level (about -8 dBFS) all reel long.
  const kicks = KICKS.filter((k) => k > 0);
  applyGain(BUS.bass, duckCurve(kicks, 8, 120));
  // The sub gets out of the kick's way too (the kick's 45 Hz tail and F1 would otherwise sum at random phase and
  // load the limiter): -9 dB / 110 ms under every kick; the 808 at 480 and the final sub at 768 only -6 dB / 90 ms,
  // so they arrive right after their kick's first 30 ms.
  applyGain(BUS.sub, duckCurve(kicks.filter((k) => k !== f(480) && k !== f(768)), 9, 110, 12, 1));
  applyGain(BUS.sub, duckCurve([f(480), f(768)], 6, 90, 10, 1));
  const drops = kicks.filter((k) => k >= f(480) && k < f(672));
  applyGain(BUS.music, duckCurve(drops, 3, 140));
  applyGain(BUS.music, duckCurve([f(624)], 9, 220, 20));
  applyGain(BUS.fx, duckCurve([f(624)], 5, 180, 16));

  // Reverb: segmented so tails end at each vacuum; returns EQ'd and ducked.
  log('reverb (FFT convolution)');
  const hall = convolveStereo(BUS.hall.L, BUS.hall.R, IR_HALL, SEGMENTS);
  const plate = convolveStereo(BUS.plate.L, BUS.plate.R, IR_PLATE, SEGMENTS);
  for (const [ret, hp, lp] of [[hall, 220, 9000], [plate, 420, 10000]]) { for (const ch of [ret.L, ret.R]) { filt(ch, 'hp', hp, 0.7); filt(ch, 'lp', lp, 0.7); } }
  applyGain(hall, duckCurve(kicks, 4, 160));

  renderHud();

  // Bus EQ / dynamics
  for (const ch of [BUS.music.L, BUS.music.R, BUS.fx.L, BUS.fx.R, BUS.dot.L, BUS.dot.R]) filt(ch, 'hp', 35, 0.7);
  for (const ch of [BUS.bass.L, BUS.bass.R]) filt(ch, 'hp', 32, 0.7);
  for (let n = 0; n < N; n++) { const m = 0.5 * (BUS.sub.L[n] + BUS.sub.R[n]); BUS.sub.L[n] = m; BUS.sub.R[n] = m; } // sub strictly mono
  for (const ch of [BUS.drums.L, BUS.drums.R]) filt(ch, 'peak', 3500, 0.8, 2.5); // presence for claps / snares (the reese stays under its 900 Hz LP)
  for (const ch of [BUS.drums.L, BUS.drums.R]) for (let n = 0; n < N; n++) ch[n] = Math.tanh(ch[n]);

  const TRIM = { dot: 0, drums: 0, sub: 0, bass: 0, music: 0, fx: 0, foley: 0, hall: -4, plate: -5 };
  if (process.argv.includes('--debug')) debugBuses({ ...BUS, hall, plate }, TRIM);
  const dumpAt = process.argv.indexOf('--dump-buses');
  if (dumpAt > 0) { const dir = process.argv[dumpAt + 1]; fsys.mkdirSync(dir, { recursive: true }); for (const [k, st] of Object.entries({ ...BUS, hall, plate })) { fsys.writeFileSync(path.join(dir, k + '.L.f32'), Buffer.from(st.L.buffer)); fsys.writeFileSync(path.join(dir, k + '.R.f32'), Buffer.from(st.R.buffer)); } }
  const L = new Float64Array(N), R = new Float64Array(N);
  const addBus = (st, db) => { const g = dB(db); for (let n = 0; n < N; n++) { L[n] += st.L[n] * g; R[n] += st.R[n] * g; } };
  for (const name of ['drums', 'sub', 'bass', 'music', 'fx', 'foley', 'dot']) addBus(BUS[name], TRIM[name]);
  addBus(hall, TRIM.hall); addBus(plate, TRIM.plate);

  log('master');
  filt(L, 'hp', 18, 0.7); filt(R, 'hp', 18, 0.7);                          // DC / infrasonic
  filt(L, 'hs', 9000, 0.7, 1); filt(R, 'hs', 9000, 0.7, 1);                // +1 dB air
  { const S = new Float64Array(N); for (let n = 0; n < N; n++) S[n] = 0.5 * (L[n] - R[n]); filt4(S, 'hp', 120); filt4(S, 'hp', 120); for (let n = 0; n < N; n++) { const M = 0.5 * (L[n] + R[n]); L[n] = M + S[n]; R[n] = M - S[n]; } } // mono < 120 Hz
  const pre = loudness(L, R).integrated, preGain = dB(-16 - pre);
  for (let n = 0; n < N; n++) { L[n] *= preGain; R[n] *= preGain; }
  const preGlueL = Float64Array.from(L), preGlueR = Float64Array.from(R);
  const glue = glueCompress(L, R, { thrDb: -15, ratio: 2, kneeDb: 6, attMs: 10, relMs: 140 });

  // Static post-limiter signals
  const gate = new Float32Array(N).fill(1);
  for (const [a, b] of [G1, G2]) {
    for (let k = 0; k < GATE_CLOSE; k++) gate[a - GATE_CLOSE + k] = 0.5 + 0.5 * Math.cos(Math.PI * k / (GATE_CLOSE - 1)); // 1 -> 0 on a-1
    for (let n = a; n < b; n++) gate[n] = 0;
  }
  const fade = new Float32Array(N).fill(1);
  for (let n = f(870); n < N; n++) fade[n] = n >= f(899) ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (n - f(870)) / (f(899) - f(870)));
  const room = stereo(N);
  { // pinkish, dark room tone at -60 dBFS RMS from 840
    for (let c = 0; c < 2; c++) {
      const r = rng('room' + c), o = c ? room.R : room.L; let b0 = 0, b1 = 0, b2 = 0;
      for (let n = f(840); n < N; n++) { const w = r() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527; o[n] = b0 + b1 + b2 + w * 0.1848; }
      filt(o, 'lp', 1800, 0.7); filt4(o, 'hp', 150); // no uncorrelated stereo below 120 Hz
    }
    for (let n = f(840); n < N; n++) { const m = 0.5 * (room.L[n] + room.R[n]); room.L[n] = m + 0.5 * (room.L[n] - m); room.R[n] = m + 0.5 * (room.R[n] - m); }
    let e = 0, cnt = 0; for (let n = f(850); n < f(870); n++) { e += room.L[n] ** 2 + room.R[n] ** 2; cnt += 2; }
    const g = dB(-60) / Math.sqrt(e / cnt);
    for (let n = f(840); n < N; n++) { const a = g * smooth((n - f(840)) / f(10)); room.L[n] *= a; room.R[n] *= a; }
  }
  const tock = woodTock(), relay = relayOff();
  if (tock.length > ms(15) || relay.length > ms(3)) throw new Error('post-gate foley too long');
  const bounds = [[0, G1[0]], [G1[0], G1[1]], [G1[1], G2[0]], [G2[0], G2[1]], [G2[1], N]];

  const render = (gain, ceil) => {
    const oL = new Float64Array(N), oR = new Float64Array(N);
    for (let n = 0; n < N; n++) { oL[n] = L[n] * gain; oR[n] = R[n] * gain; }
    const gr = limitSegments(oL, oR, ceil, bounds);
    for (let n = 0; n < N; n++) { oL[n] *= gate[n]; oR[n] *= gate[n]; }
    for (let i = 0; i < tock.length; i++) { oL[G1[0] + i] = tock[i] * dB(-9); oR[G1[0] + i] = tock[i] * dB(-9); }
    for (let i = 0; i < relay.length; i++) { oL[G2[0] + i] = relay[i] * dB(-7); oR[G2[0] + i] = relay[i] * dB(-7); }
    for (let n = f(840); n < N; n++) { if (gate[n] > 0) { oL[n] += room.L[n]; oR[n] += room.R[n]; } }
    for (let n = f(870); n < N; n++) { oL[n] *= fade[n]; oR[n] *= fade[n]; }
    return { oL, oR, gr };
  };
  const tpMax = (a, b) => { const tp = truePeakEnv(a, b); let m = 0; for (let i = 0; i < tp.length; i++) if (tp[i] > m) m = tp[i]; return 20 * Math.log10(m); };

  log('loudness loop');
  let gainDb = 2, ceil = dB(CEIL_DBTP - 0.25), out, lufs, tp;
  for (let it = 0; it < 8; it++) {
    out = render(dB(gainDb), ceil);
    lufs = loudness(out.oL, out.oR).integrated; tp = tpMax(out.oL, out.oR);
    log(`  iter ${it}: gain ${gainDb.toFixed(2)} dB  LUFS ${lufs.toFixed(2)}  TP ${tp.toFixed(2)} dBTP  limiter max GR ${out.gr.toFixed(2)} dB`);
    if (tp > CEIL_DBTP - 0.05) { ceil *= dB(CEIL_DBTP - 0.08 - tp); continue; }
    if (Math.abs(lufs - TARGET_LUFS) < 0.05) break;
    gainDb += (TARGET_LUFS - lufs) * (it < 2 ? 1 : 1.15);
  }

  // Applied master gain per frame (pre-glue mix -> output, dB; energy-weighted), exported for audiocheck.
  const frameGainDb = [];
  for (let fr = 0; fr < FRAMES; fr++) {
    let a = 0, b = 0; for (let n = f(fr); n < f(fr + 1); n++) { a += preGlueL[n] ** 2 + preGlueR[n] ** 2; b += out.oL[n] ** 2 + out.oR[n] ** 2; }
    frameGainDb.push(a > 1e-12 && b > 0 ? +(10 * Math.log10(b / a) + 20 * Math.log10(preGain)).toFixed(2) : null);
  }

  // TPDF dither (fixed seed) to 16 bit. Exact zeros stay exact zeros (gates, the end).
  const pcm = new Int16Array(N * 2), dr = rng('tpdf');
  for (let n = 0; n < N; n++) {
    for (let c = 0; c < 2; c++) {
      const x = c ? out.oR[n] : out.oL[n]; let q = 0;
      if (x !== 0) { const inGate = (n >= G1[0] && n < G1[1]) || (n >= G2[0] && n < G2[1]); q = Math.round(x * 32767 + (inGate ? 0 : dr() - dr())); }
      pcm[2 * n + c] = clamp(q, -32768, 32767);
    }
  }
  writeWav(WAV_PATH, pcm, 2, SR);
  log(`wrote ${path.relative(ROOT, WAV_PATH)} (${N} frames, ${(N / SR).toFixed(3)} s)`);

  const json = {
    title: 'NEKVIT showreel soundtrack', spec: 'DIRECTION.md §3', generator: 'tools/soundtrack.mjs',
    sampleRate: SR, channels: 2, bitDepth: 16, samples: N, fps: FPS, samplesPerFrame: SPF, frames: FRAMES, bpm: BPM, key: 'F minor',
    gates: [{ id: 'G1', first: G1[0], last: G1[1] - 1, frames: [372, 383], foley: { frame: 372, voice: 'wood tock', maxSamples: ms(15), samples: tock.length } },
      { id: 'G2', first: G2[0], last: G2[1] - 1, frames: [468, 479], foley: { frame: 468, voice: 'relay-off click', maxSamples: ms(3), samples: relay.length } }],
    master: { integratedLufs: +lufs.toFixed(2), truePeakDbtp: +tp.toFixed(2), normalisationGainDb: +gainDb.toFixed(2), staticGainDb: +(20 * Math.log10(preGain) + gainDb).toFixed(2), limiterMaxGrDb: +out.gr.toFixed(2), glueAvgGrDb: +glue.avgGr.toFixed(2), glueMaxGrDb: +glue.maxGr.toFixed(2), frameGainDb },
    cues: CUES.sort((a, b) => a.frame - b.frame || a.voice.localeCompare(b.voice)),
    transients: TRANSIENTS.sort((a, b) => a[0] - b[0]),
  };
  fsys.writeFileSync(JSON_PATH, JSON.stringify(json, null, 1));
  log(`wrote ${path.relative(ROOT, JSON_PATH)} (${CUES.length} cues)`);
  log(`done: ${lufs.toFixed(2)} LUFS, ${tp.toFixed(2)} dBTP, glue avg/max GR ${glue.avgGr.toFixed(2)}/${glue.maxGr.toFixed(2)} dB`);
}

// Tape slow-down over [a, b): read pointer rate 1 -> 0.28, level fades to 0 at b; silence after b.
function tapeStretch(chans, a, b) {
  const len = b - a;
  for (const ch of chans) {
    const src = Float32Array.from(ch.subarray(a - 4, b + 4)), off = 4; let p = 0;
    for (let i = 0; i < len; i++) {
      const u = i / len, rate = 1 - 0.72 * Math.pow(u, 1.3), amp = 1 - smooth((u - 0.45) / 0.55);
      const k = Math.floor(p), fr = p - k, x0 = src[off + k - 1], x1 = src[off + k], x2 = src[off + k + 1], x3 = src[off + k + 2];
      const c1 = 0.5 * (x2 - x0), c2 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3, c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
      ch[a + i] = (((c3 * fr + c2) * fr + c1) * fr + x1) * amp;
      p += rate;
    }
  }
}

// --debug: per-bus, per-bar RMS (dBFS, pre-master) and 5-band energy split, to mix by measurement.
function debugBuses(buses, trim) {
  const BANDS = [120, 500, 2000, 8000], names = Object.keys(buses);
  const splits = {};
  for (const name of names) {
    const st = buses[name], g = dB(trim[name] ?? 0), m = Float64Array.from(st.L, (v, i) => 0.5 * (v + st.R[i]) * g);
    const edges = [0, ...BANDS, 0], bandsSig = [];
    for (let k = 0; k < 5; k++) { const x = Float64Array.from(m); if (edges[k]) filt4(x, 'hp', edges[k]); if (edges[k + 1]) filt4(x, 'lp', edges[k + 1]); bandsSig.push(x); }
    splits[name] = { m, bandsSig };
  }
  console.log('bus      bar:' + Array.from({ length: 10 }, (_, b) => String(b + 1).padStart(7)).join(''));
  for (const name of names) {
    const { m, bandsSig } = splits[name];
    const row = [], rowB = [];
    for (let bar = 0; bar < 10; bar++) {
      const a = f(bar * 96), b = f(Math.min(900, bar * 96 + 96)); let s = 0; const e = [0, 0, 0, 0, 0];
      for (let n = a; n < b; n++) { s += m[n] * m[n]; for (let k = 0; k < 5; k++) e[k] += bandsSig[k][n] ** 2; }
      row.push((10 * Math.log10(s / (b - a) + 1e-12)).toFixed(1).padStart(7));
      const tot = e.reduce((p, q) => p + q, 0) || 1; rowB.push(e.map((v) => Math.round(100 * v / tot)).join('/').padStart(16));
    }
    console.log(name.padEnd(12) + row.join(''));
    if (process.argv.includes('--bands')) console.log(' '.repeat(12) + rowB.join(' '));
  }
}

function writeWav(file, pcm, channels, rate) {
  const dataBytes = pcm.length * 2, buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + 2 * i);
  fsys.mkdirSync(path.dirname(file), { recursive: true });
  fsys.writeFileSync(file, buf);
}

main();
