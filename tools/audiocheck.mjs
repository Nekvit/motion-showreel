#!/usr/bin/env node
// Acceptance analysis for audio/soundtrack.wav (DIRECTION.md §3, §7.9).
//
//   node tools/audiocheck.mjs [audio/soundtrack.wav] [audio/soundtrack.json] [--verbose]
//
// Prints: format and length, sample peak and 4x true peak, integrated loudness (BS.1770-4),
// DC offset, the two hard gates (every sample exactly 0 except the post-gate foley), the end
// fade, a click detector, a per-cue onset table built from soundtrack.json (band-limited RMS
// in 200-sample windows from 5 frames before to 10 after, detected onset frame vs expected; pitched ticks
// are measured through a steeper band, see detectSub),
// per-bar spectral balance, loudness and stereo. Exit code 1 if any hard check fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const pos = args.filter((a) => !a.startsWith('--'));
const WAV = path.resolve(pos[0] ?? path.join(ROOT, 'audio', 'soundtrack.wav'));
const JSONP = path.resolve(pos[1] ?? path.join(ROOT, 'audio', 'soundtrack.json'));

const SR_EXPECT = 48000, SPF = 800, FRAMES = 900, N_EXPECT = SPF * FRAMES;
const G1 = [297600, 307200], G2 = [374400, 384000];
const results = []; // {name, ok, detail, warn}
const check = (name, ok, detail = '', warn = false) => results.push({ name, ok, detail, warn });
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-inf');
const TAU = 2 * Math.PI;

// ------------------------------------------------------------------------------ WAV
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = { off: p + 8, size };
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`expected 16-bit PCM, got format ${fmt.format} / ${fmt.bits} bit`);
  const frames = data.size / (2 * fmt.channels), ch = [];
  for (let c = 0; c < fmt.channels; c++) ch.push(new Float64Array(frames));
  const raw = [];
  for (let c = 0; c < fmt.channels; c++) raw.push(new Int16Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) { const v = b.readInt16LE(data.off + 2 * (i * fmt.channels + c)); raw[c][i] = v; ch[c][i] = v / 32768; }
  return { ...fmt, frames, ch, raw };
}

// ------------------------------------------------------------------------------ DSP helpers
class Biquad {
  constructor(type, fc, q, sr) {
    const w = TAU * Math.min(fc, sr * 0.49) / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; this.z1 = 0; this.z2 = 0;
  }
  run(x) { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) { const v = this.b0 * x[i] + this.z1; this.z1 = this.b1 * x[i] - this.a1 * v + this.z2; this.z2 = this.b2 * x[i] - this.a2 * v; y[i] = v; } return y; }
}
const BW4 = [0.5411961, 1.3065630];
// 4th-order Butterworth HP + LP (24 dB/oct per side); `stages` = 2 cascades them (48 dB/oct per side).
function bandpass(x, lo, hi, sr, stages = 1) { let y = x; for (let s = 0; s < stages; s++) { for (const q of BW4) y = new Biquad('hp', lo, q, sr).run(y); for (const q of BW4) y = new Biquad('lp', hi, q, sr).run(y); } return y; }

function kWeight(x) {
  const y = Float64Array.from(x);
  for (const c of [{ b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 }, { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 }]) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const xi = y[i], yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi; }
  }
  return y;
}
function loudness(L, R, sr) {
  const kl = kWeight(L), kr = kWeight(R), blk = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), z = [];
  for (let s = 0; s + blk <= L.length; s += hop) { let a = 0; for (let i = s; i < s + blk; i++) a += kl[i] * kl[i] + kr[i] * kr[i]; z.push(a / blk); }
  const lk = (v) => -0.691 + 10 * Math.log10(v + 1e-20);
  const abs = z.filter((v) => lk(v) > -70), relG = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10, gated = abs.filter((v) => lk(v) > relG);
  const st = []; const blk3 = 3 * sr; for (let s = 0; s + blk3 <= L.length; s += hop) { let a = 0; for (let i = s; i < s + blk3; i += 4) a += kl[i] * kl[i] + kr[i] * kr[i]; st.push(lk(4 * a / blk3)); }
  return { integrated: lk(gated.reduce((a, b) => a + b, 0) / gated.length), momentaryMax: Math.max(...z.map(lk)), shortTermMax: Math.max(...st), kl, kr };
}
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
function truePeak(x, over = 4, T = 32, beta = 9) {
  const n = over * T + 1, c = over * T / 2, h = new Float64Array(n), i0 = besselI0(beta);
  for (let j = 0; j < n; j++) { const u = (j - c) / over, s = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u), r = (j - c) / c; h[j] = s * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0; }
  let peak = 0, at = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > peak) { peak = v; at = i; } }
  for (let m = 0; m < x.length + T; m++) {
    for (let p = 1; p < over; p++) {
      let acc = 0; for (let k = 0; k < T; k++) { const idx = m - k; if (idx >= 0 && idx < x.length) acc += x[idx] * h[over * k + p]; }
      const v = Math.abs(acc); if (v > peak) { peak = v; at = m - T / 2; }
    }
  }
  return { peak, at };
}
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len, wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2, tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = t;
      }
    }
  }
}

// ------------------------------------------------------------------------------ load
const wav = readWav(WAV);
const meta = fs.existsSync(JSONP) ? JSON.parse(fs.readFileSync(JSONP, 'utf8')) : null;
const SR = wav.rate, [L, R] = wav.ch, N = wav.frames;
console.log(`\n== ${path.relative(process.cwd(), WAV)}`);
console.log(`format      : PCM ${wav.bits}-bit, ${wav.channels} ch, ${SR} Hz`);
console.log(`length      : ${N} samples = ${(N / SPF).toFixed(3)} frames = ${(N / SR).toFixed(4)} s`);
check('format 48 kHz / 16-bit / stereo', SR === SR_EXPECT && wav.bits === 16 && wav.channels === 2, `${SR} Hz ${wav.bits}-bit ${wav.channels} ch`);
check('length exactly 720,000 samples', N === N_EXPECT, `${N}`);

// ------------------------------------------------------------------------------ levels
let sp = 0; for (let i = 0; i < N; i++) sp = Math.max(sp, Math.abs(L[i]), Math.abs(R[i]));
const tpL = truePeak(L), tpR = truePeak(R), tp = Math.max(tpL.peak, tpR.peak), tpAt = tpL.peak >= tpR.peak ? tpL.at : tpR.at;
const ld = loudness(L, R, SR);
let mL = 0, mR = 0; for (let i = 0; i < N; i++) { mL += L[i]; mR += R[i]; } mL /= N; mR /= N;
console.log(`sample peak : ${fmt(db(sp))} dBFS`);
console.log(`true peak   : ${fmt(db(tp))} dBTP (4x oversampled, at frame ${(tpAt / SPF).toFixed(1)})`);
console.log(`loudness    : ${fmt(ld.integrated)} LUFS integrated, momentary max ${fmt(ld.momentaryMax)} LUFS, short-term max ${fmt(ld.shortTermMax)} LUFS`);
console.log(`DC offset   : L ${mL.toExponential(2)} (${fmt(db(Math.abs(mL)), 1)} dBFS), R ${mR.toExponential(2)} (${fmt(db(Math.abs(mR)), 1)} dBFS)`);
check('true peak <= -1 dBTP', db(tp) <= -1.0, `${fmt(db(tp))} dBTP`);
check('integrated loudness -14 +-1 LUFS', Math.abs(ld.integrated + 14) <= 1, `${fmt(ld.integrated)} LUFS`);
check('no DC offset (< -60 dBFS)', db(Math.abs(mL)) < -60 && db(Math.abs(mR)) < -60, `L ${fmt(db(Math.abs(mL)), 1)} / R ${fmt(db(Math.abs(mR)), 1)} dBFS`);

// ------------------------------------------------------------------------------ gates
console.log('\n== hard gates (after the limiter; must be digital zero except the post-gate foley)');
const gateMeta = meta?.gates ?? [{ id: 'G1', first: G1[0], last: G1[1] - 1, foley: { maxSamples: 720 } }, { id: 'G2', first: G2[0], last: G2[1] - 1, foley: { maxSamples: 144 } }];
for (const g of gateMeta) {
  const allow = g.foley?.maxSamples ?? 0;
  let foleyNZ = 0, foleyLast = -1, stray = 0, firstStray = -1, fPeak = 0;
  for (let n = g.first; n <= g.last; n++) {
    const nz = wav.raw[0][n] !== 0 || wav.raw[1][n] !== 0;
    if (!nz) continue;
    if (n < g.first + allow) { foleyNZ++; foleyLast = n; fPeak = Math.max(fPeak, Math.abs(L[n]), Math.abs(R[n])); } else { stray++; if (firstStray < 0) firstStray = n; }
  }
  const before = g.first - 1, closeLen = 96;
  let rampPeak = 0; for (let n = before - closeLen - 200; n < before - closeLen; n++) rampPeak = Math.max(rampPeak, Math.abs(L[n]), Math.abs(R[n]));
  const lastPre = [wav.raw[0][before], wav.raw[1][before]];
  const reopen = [wav.raw[0][g.last + 1], wav.raw[1][g.last + 1]];
  const foleyMs = foleyLast >= 0 ? ((foleyLast - g.first + 1) / SR * 1000) : 0;
  console.log(`${g.id}: samples ${g.first.toLocaleString('en')}-${g.last.toLocaleString('en')} (f${g.first / SPF}-${(g.last + 1) / SPF - 1})`);
  console.log(`    foley window ${allow} samples: ${foleyNZ} non-zero samples, last at +${foleyLast - g.first} (${fmt(foleyMs, 2)} ms), peak ${fmt(db(fPeak), 1)} dBFS  [${g.foley?.voice ?? ''}]`);
  console.log(`    stray non-zero samples after the foley: ${stray}${stray ? ` (first at ${firstStray})` : ''}`);
  console.log(`    boundary sample ${before} = [${lastPre}] (cosine close ends here), reopen sample ${g.last + 1} = [${reopen}], pre-close level ${fmt(db(rampPeak), 1)} dBFS`);
  check(`${g.id} exact digital zero outside the foley`, stray === 0, `${stray} stray samples`);
  check(`${g.id} post-gate foley present and within ${(allow / SR * 1000).toFixed(0)} ms`, foleyNZ > 0 && foleyLast < g.first + allow, `${foleyNZ} samples, ${fmt(foleyMs)} ms`);
  check(`${g.id} close finishes on boundary sample ${before}`, lastPre[0] === 0 && lastPre[1] === 0, `[${lastPre}]`);
}
// End: fade 870 -> 899 and digital silence on frame 899
{
  const rms = (a, b) => { let s = 0; for (let n = a; n < b; n++) s += L[n] * L[n] + R[n] * R[n]; return Math.sqrt(s / (2 * (b - a))); };
  let nzEnd = 0; for (let n = 899 * SPF; n < N; n++) if (wav.raw[0][n] !== 0 || wav.raw[1][n] !== 0) nzEnd++;
  const r1 = rms(840 * SPF, 870 * SPF), r2 = rms(870 * SPF, 885 * SPF), r3 = rms(885 * SPF, 898 * SPF);
  console.log(`end fade    : RMS 840-869 ${fmt(db(r1), 1)} dBFS -> 870-884 ${fmt(db(r2), 1)} -> 885-897 ${fmt(db(r3), 1)}; frame 899 non-zero samples: ${nzEnd}`);
  check('fade 870 -> digital silence at 899', nzEnd === 0 && r3 < r2 && r2 <= r1 * 1.05, `frame 899 non-zero: ${nzEnd}`);
}

// ------------------------------------------------------------------------------ clicks
// A click is an isolated spike in the >= 14 kHz band (8th-order Butterworth HP): a discontinuity leaves broadband
// energy there, while band-limited waveforms (a low-passed saw's wrap, sines, grains) do not, and noise sources
// (hats, crashes) are not isolated. Flag |hf| > -54 dBFS and > 8x the RMS of its +-5 ms neighbourhood, outside the
// intended transients listed in soundtrack.json and the post-gate foley windows.
console.log('\n== click detector (isolated spikes above 14 kHz, outside intended transients)');
{
  const excl = new Uint8Array(N);
  const mark = (a, b) => { for (let n = Math.max(0, a); n < Math.min(N, b); n++) excl[n] = 1; };
  for (const [s, w] of meta?.transients ?? []) mark(s - 48, s + Math.max(w, 96) + 48);
  for (const g of gateMeta) mark(g.first - 4, g.first + (g.foley?.maxSamples ?? 0) + 48);
  const W = 240, found = [];
  for (const [ci, x] of [L, R].entries()) {
    let hf = x; for (let r = 0; r < 2; r++) for (const q of BW4) hf = new Biquad('hp', 14000, q, SR).run(hf);
    const pre = new Float64Array(N + 1); for (let n = 0; n < N; n++) pre[n + 1] = pre[n] + hf[n] * hf[n];
    for (let n = 0; n < N; n++) {
      const a = Math.abs(hf[n]); if (a < 0.002 || excl[n]) continue;
      const lo = Math.max(0, n - W), hi = Math.min(N, n + W + 1), sAll = pre[hi] - pre[lo], sCtr = pre[Math.min(N, n + 4)] - pre[Math.max(0, n - 3)];
      const rms = Math.sqrt(Math.max(1e-14, (sAll - sCtr) / Math.max(1, hi - lo - 7)));
      if (a / rms > 8) found.push({ n, ch: ci ? 'R' : 'L', a, ratio: a / rms });
    }
  }
  found.sort((p, q) => p.n - q.n);
  const events = []; for (const e of found) { const last = events[events.length - 1]; if (last && e.n - last.n < 96) { if (e.ratio > last.ratio) Object.assign(last, e); } else events.push({ ...e }); }
  if (!events.length) console.log('no clicks found outside intended transients');
  for (const e of events.slice(0, 25)) console.log(`  click at sample ${e.n} (frame ${(e.n / SPF).toFixed(2)}) ${e.ch}: HF spike ${fmt(db(e.a), 1)} dBFS, ${fmt(e.ratio, 1)}x local`);
  check('no clicks outside intended transients', events.length === 0, `${events.length} events`);
}

// ------------------------------------------------------------------------------ cues
const bandCache = new Map();
const BLK = 50; // 50-sample blocks: 16 per frame
function bandEnergy(lo, hi, stages = 1) {
  const key = `${lo}-${hi}-${stages}`; if (bandCache.has(key)) return bandCache.get(key);
  const yl = bandpass(L, Math.max(lo, 15), Math.min(hi, SR * 0.45), SR, stages), yr = bandpass(R, Math.max(lo, 15), Math.min(hi, SR * 0.45), SR, stages);
  const nb = Math.ceil(N / BLK), e = new Float64Array(nb);
  for (let n = 0; n < N; n++) e[(n / BLK) | 0] += yl[n] * yl[n] + yr[n] * yr[n];
  for (let i = 0; i < nb; i++) e[i] /= 2 * BLK;
  bandCache.set(key, e); return e;
}
const EPS = 1e-11, BPF = SPF / BLK;
const mean = (e, a, b) => { let s = 0, c = 0; for (let k = Math.max(0, a); k < Math.min(e.length, b); k++) { s += e[k]; c++; } return c ? s / c : 0; };
// Accent onset: the 50-sample block with the largest rise over the mean of the preceding frame (16 blocks),
// searched over frames F-1..F+1. (Events are placed sample-exactly at f*800 by construction; a +-1 here comes from
// the detector in busy beds, e.g. a buzzy bass's per-cycle pulses or a pad's beating just before the cue.)
function detectOnset(band, F) {
  const e = bandEnergy(band[0], band[1]); let best = -Infinity, bb = -1;
  for (let b = Math.max(0, BPF * (F - 1)); b < Math.min(e.length, BPF * (F + 2)); b++) { const r = 10 * Math.log10((e[b] + EPS) / (mean(e, b - BPF, b) + EPS)); if (r > best) { best = r; bb = b; } }
  return { frame: Math.floor(bb / BPF), rise: best, level: 10 * Math.log10(e[bb] + EPS) };
}
// Grouped sub-onset (ticks every frame, hats): peak of the first 200 samples of frame s over the 400 samples before it.
// Pitched ticks (cues with a tickHz, band +-6 %) are measured through the steep 48 dB/oct band: a 24 dB/oct band
// still passes a loud source five semitones away at about -8 dB (e.g. the f579-585 glitter grains on C8 against
// G7 ticks), far more than the ear's masking skirt, and would report audible ticks as buried.
const STEEP = (c) => (c.tickHz ? 2 : 1);
function detectSub(band, s, stages = 1) {
  const e = bandEnergy(band[0], band[1], stages); let pk = 0; for (let b = BPF * s; b < BPF * s + 4; b++) pk = Math.max(pk, e[b] ?? 0);
  let pkPrev = 0; for (let b = BPF * s - 4; b < BPF * s; b++) pkPrev = Math.max(pkPrev, e[b] ?? 0);
  return { rise: 10 * Math.log10((pk + EPS) / (mean(e, BPF * s - 8, BPF * s) + EPS)), early: pkPrev > pk };
}
function bandRms(band, a, b, stages = 1) { const e = bandEnergy(band[0], band[1], stages); return 10 * Math.log10(mean(e, Math.round(BPF * a), Math.round(BPF * b)) + EPS); }
function envelope(F) { // full-band RMS per frame (max of the four 200-sample windows), F-5 .. F+10
  const out = [];
  for (let fr = F - 5; fr <= F + 10; fr++) {
    let m = 0; for (let w = 0; w < 4; w++) { const a = fr * SPF + w * 200; if (a < 0 || a + 200 > N) continue; let s = 0; for (let n = a; n < a + 200; n++) s += L[n] * L[n] + R[n] * R[n]; m = Math.max(m, s / 400); }
    out.push(m > 0 ? Math.round(10 * Math.log10(m)) : -99);
  }
  return out;
}
function subInfo(c, s) {
  const st = STEEP(c), d = detectSub(c.band, s, st), g = meta?.master?.frameGainDb?.[s] ?? meta?.master?.staticGainDb ?? null, e = bandEnergy(c.band[0], c.band[1], st);
  const floor = bandRms(c.band, s - 0.5, s, st), prevPk = 10 * Math.log10(Math.max(...[1, 2, 3, 4].map((k) => e[BPF * s - k] ?? 0)) + EPS);
  return { ...d, floor, prevPk, nominal: c.levelDb !== undefined && g !== null ? c.levelDb + g : null };
}
// Calibrate the HUD tick's best-block level re its peak on ticks that stand >= 10 dB clear of their floor.
const TICK_CAL = (() => {
  const offs = [];
  for (const c of meta?.cues ?? []) if (c.check === 'group' && c.hud) for (const s of c.subs) {
    const d = subInfo(c, s); if (d.rise >= 10 && !d.early && d.nominal !== null) offs.push(d.floor + 10 * Math.log10(10 ** (d.rise / 10) - 1) - d.nominal);
  }
  offs.sort((a, b) => a - b);
  return offs.length ? { worst: offs[0], median: offs[offs.length >> 1], n: offs.length } : null;
})();
if (TICK_CAL) console.log(`\nHUD tick calibration: best 50-sample block = peak ${fmt(TICK_CAL.median, 1)} dB (median), ${fmt(TICK_CAL.worst, 1)} dB (worst) over ${TICK_CAL.n} exposed ticks`);
console.log('\n== cue list (accent onsets: band-limited rise of a 50-sample block over the preceding frame, searched f-1..f+1; ok = |d| <= 1 and rise >= 3 dB;\n   grouped sub-onsets: first 200 samples of the frame vs the 400 before it; swells: loudest of the last 3 frames vs the 3-frame pre-roll and the midpoint)');
console.log('   env = full-band RMS dB per frame (max of four 200-sample windows) from f-5 to f+10; ^ marks the cue frame');
const cueStats = { onset: [0, 0], group: [0, 0], end: [0, 0], span: [0, 0] }, weak = [];
for (const c of meta?.cues ?? []) {
  const F = c.frame, tag = `f${String(F).padStart(3)}${c.end !== undefined ? '-' + String(c.end).padEnd(3) : '    '} ${c.voice.padEnd(6)}`;
  const env = envelope(F), envStr = env.map((v, i) => (i === 5 ? '^' : '') + v).join(' ');
  let status = '', ok = true;
  if (c.check === 'onset') {
    const d = detectOnset(c.band, F);
    ok = Math.abs(d.frame - F) <= 1 && d.rise >= 3;
    status = `onset f${d.frame} (d${d.frame - F >= 0 ? '+' : ''}${d.frame - F}) rise ${fmt(d.rise, 1)} dB @ ${fmt(d.level, 0)} dB [${c.band[0]}-${c.band[1]} Hz]`;
    cueStats.onset[0] += ok; cueStats.onset[1]++;
  } else if (c.check === 'group') {
    // A sub-onset that is not detected is "masked by design" only if the masker in its band is louder than what a
    // tick of the specified peak can add. That limit is calibrated on the exposed ticks of this file (see TICK_CAL):
    // a mean floor above peak + worst-case block offset cannot show a 3 dB rise, and a masker block above
    // peak + median offset in the 200 samples before the frame hides the attack. Peak = level + per-frame master gain.
    const subs = c.subs ?? [F]; let good = 0; const masked = [], missing = [];
    for (const s of subs) {
      const d = subInfo(c, s);
      if (VERBOSE) console.log(`      sub f${s}: rise ${fmt(d.rise, 1)} dB, early ${d.early}, floor ${fmt(d.floor, 1)} dB, tick peak ${fmt(d.nominal, 1)} dBFS`);
      if (d.rise >= 3 && !d.early) { good++; continue; }
      const cal = c.hud ? TICK_CAL : null; // only the HUD ticks may be masked by design
      if (cal && d.nominal !== null && (d.floor > d.nominal + cal.worst || d.prevPk > d.nominal + cal.median)) masked.push(`${s}(${fmt(Math.max(d.floor - cal.worst, d.prevPk - cal.median) - d.nominal, 0)})`);
      else missing.push(`${s}(${fmt(d.rise, 1)})`);
    }
    ok = missing.length === 0;
    status = `${good}/${subs.length} detected [${c.band[0]}-${c.band[1]} Hz]${masked.length ? `; masked by design (masker margin over the detectable limit, dB): ${masked.join(' ')}` : ''}${missing.length ? '; MISSING: ' + missing.join(' ') : ''}`;
    cueStats.group[0] += good; cueStats.group[1] += subs.length; cueStats.masked = (cueStats.masked ?? 0) + masked.length; cueStats.missing = (cueStats.missing ?? 0) + missing.length;
  } else if (c.check === 'end') {
    const E = c.end, a = bandRms(c.band, F - 3, F), b = Math.max(bandRms(c.band, E - 3, E - 2), bandRms(c.band, E - 2, E - 1), bandRms(c.band, E - 1, E)), mid = bandRms(c.band, Math.round((F + E) / 2) - 1, Math.round((F + E) / 2) + 1);
    ok = b - a >= 6 && b >= mid - 1;
    status = `swell into f${E}: pre-roll ${fmt(a, 1)} -> mid ${fmt(mid, 1)} -> last 3f max ${fmt(b, 1)} dB (+${fmt(b - a, 1)}) [${c.band[0]}-${c.band[1]} Hz]`;
    cueStats.end[0] += ok; cueStats.end[1]++;
  } else if (c.check === 'span') {
    const E = Math.max(c.end ?? F + 12, F + 1), lv = bandRms(c.band, F, E);
    ok = lv > -75;
    status = `present, band RMS ${fmt(lv, 1)} dB over f${F}-${E} [${c.band[0]}-${c.band[1]} Hz]`;
    cueStats.span[0] += ok; cueStats.span[1]++;
  } else if (c.check === 'gate') status = 'see hard gates';
  else if (c.check === 'foley') { const g = gateMeta.find((q) => q.first === F * SPF); let nz = 0; if (g) for (let n = g.first; n < g.first + g.foley.maxSamples; n++) if (wav.raw[0][n] || wav.raw[1][n]) nz++; ok = nz > 0; status = `post-gate dry foley, ${nz} non-zero samples`; }
  else if (c.check === 'fade') status = 'see end fade';
  if (!ok) weak.push(`${tag} ${c.description} -> ${status}`);
  console.log(`${ok ? ' ok ' : 'FAIL'} ${tag} ${c.description.slice(0, 74).padEnd(74)} | ${status}${VERBOSE || !ok || c.check === 'onset' ? '\n' + ' '.repeat(22) + 'env ' + envStr : ''}`);
}
console.log(`\ncue summary: onsets ${cueStats.onset[0]}/${cueStats.onset[1]}, group sub-onsets ${cueStats.group[0]}/${cueStats.group[1]} detected (${cueStats.masked ?? 0} masked by design, ${cueStats.missing ?? 0} missing), swells ${cueStats.end[0]}/${cueStats.end[1]}, beds ${cueStats.span[0]}/${cueStats.span[1]}`);
check('every accent cue onset within +-1 frame', cueStats.onset[0] === cueStats.onset[1], `${cueStats.onset[0]}/${cueStats.onset[1]}`);
check('every grouped sub-onset detected (or provably masked)', (cueStats.missing ?? 0) === 0, `${cueStats.group[0]}/${cueStats.group[1]} detected, ${cueStats.masked ?? 0} masked by design, ${cueStats.missing ?? 0} missing`);
check('every swell reaches its end frame', cueStats.end[0] === cueStats.end[1], `${cueStats.end[0]}/${cueStats.end[1]}`);
check('every bed cue present', cueStats.span[0] === cueStats.span[1], `${cueStats.span[0]}/${cueStats.span[1]}`);

// ------------------------------------------------------------------------------ per bar: spectrum, loudness, stereo
console.log('\n== per bar: spectral balance (% of bar energy per band), K-weighted loudness, stereo');
const BANDS = [[0, 120], [120, 500], [500, 2000], [2000, 8000], [8000, 24000]];
console.log('bar  frames     |   <120  120-500  500-2k   2k-8k    >8k | LUFS(bar) | corr  >500Hz  side<100Hz');
const FFTN = 4096, win = new Float64Array(FFTN); for (let i = 0; i < FFTN; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (FFTN - 1));
let lowSideWorst = -Infinity;
for (let bar = 0; bar < 10; bar++) {
  const f0 = bar * 96, f1 = Math.min(900, f0 + 96), a = f0 * SPF, b = f1 * SPF, acc = new Float64Array(BANDS.length);
  for (let s = a; s + FFTN <= b; s += FFTN / 2) {
    for (const x of [L, R]) {
      const re = new Float64Array(FFTN), im = new Float64Array(FFTN);
      for (let i = 0; i < FFTN; i++) re[i] = x[s + i] * win[i];
      fftInPlace(re, im);
      for (let k = 1; k < FFTN / 2; k++) { const fq = k * SR / FFTN, p = re[k] * re[k] + im[k] * im[k]; for (let j = 0; j < BANDS.length; j++) if (fq >= BANDS[j][0] && fq < BANDS[j][1]) acc[j] += p; }
    }
  }
  const tot = acc.reduce((p, q) => p + q, 0) || 1;
  let kp = 0; for (let n = a; n < b; n++) kp += ld.kl[n] ** 2 + ld.kr[n] ** 2;
  const lufsBar = -0.691 + 10 * Math.log10(kp / (b - a) + 1e-20);
  let sxy = 0, sxx = 0, syy = 0; for (let n = a; n < b; n++) { sxy += L[n] * R[n]; sxx += L[n] * L[n]; syy += R[n] * R[n]; }
  const corr = sxy / Math.sqrt(sxx * syy + 1e-30);
  let hl = L.subarray(a, b), hr = R.subarray(a, b); for (const q of BW4) { hl = new Biquad('hp', 500, q, SR).run(hl); hr = new Biquad('hp', 500, q, SR).run(hr); }
  let hxy = 0, hxx = 0, hyy = 0; for (let i = 0; i < hl.length; i++) { hxy += hl[i] * hr[i]; hxx += hl[i] * hl[i]; hyy += hr[i] * hr[i]; }
  const corrHi = hxy / Math.sqrt(hxx * hyy + 1e-30);
  const M = new Float64Array(b - a), S = new Float64Array(b - a); for (let n = a; n < b; n++) { M[n - a] = 0.5 * (L[n] + R[n]); S[n - a] = 0.5 * (L[n] - R[n]); }
  let lm = new Biquad('lp', 100, BW4[0], SR).run(M); lm = new Biquad('lp', 100, BW4[1], SR).run(lm);
  let ls = new Biquad('lp', 100, BW4[0], SR).run(S); ls = new Biquad('lp', 100, BW4[1], SR).run(ls);
  let em = 0, es = 0; for (let i = 0; i < lm.length; i++) { em += lm[i] ** 2; es += ls[i] ** 2; }
  const sideRatio = 10 * Math.log10((es + 1e-20) / (em + 1e-20)); if (em / lm.length > 1e-5) lowSideWorst = Math.max(lowSideWorst, sideRatio); // bars with low end above -50 dBFS RMS
  const pct = [...acc].map((v) => (100 * v / tot).toFixed(1).padStart(6) + '%');
  console.log(`${String(bar + 1).padStart(3)}  ${String(f0).padStart(3)}-${String(f1 - 1).padEnd(3)}    | ${pct.join(' ')} | ${fmt(lufsBar, 1).padStart(7)}   | ${corr.toFixed(2).padStart(5)}  ${corrHi.toFixed(2).padStart(5)}  ${fmt(sideRatio, 1).padStart(7)} dB`);
}
{ // momentary loudness (400 ms, K-weighted, ungated) every 12 frames: the arc at a glance
  const vals = [];
  for (let fr = 0; fr + 24 <= 900; fr += 12) { const a = fr * SPF, b = a + 0.4 * SR; let kp = 0; for (let n = a; n < b; n++) kp += ld.kl[n] ** 2 + ld.kr[n] ** 2; vals.push(-0.691 + 10 * Math.log10(kp / (b - a) + 1e-20)); }
  console.log('\nmomentary LUFS (400 ms) every 12 frames from f0:');
  for (let i = 0; i < vals.length; i += 16) console.log(`  f${String(i * 12).padStart(3)}: ` + vals.slice(i, i + 16).map((v) => (Number.isFinite(v) && v > -99 ? v.toFixed(0) : '-inf').padStart(4)).join(''));
}
check('low end mono (side < 100 Hz at least 30 dB under mid)', lowSideWorst < -30, `worst ${fmt(lowSideWorst, 1)} dB`);

// ------------------------------------------------------------------------------ summary
console.log('\n== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(62)} ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall checks passed');
process.exitCode = failed.length ? 1 : 0;
