// Easing, interpolation and timing helpers (JS side).

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => clamp((x - a) / (b - a));
export const remap = (x, a, b, c, d) => c + (d - c) * invLerp(a, b, x);
export const smoothstep = (a, b, x) => { const t = invLerp(a, b, x); return t * t * (3 - 2 * t); };
export const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export const ease = {
  linear: x => clamp(x),
  inQuad: x => (x = clamp(x), x * x),
  outQuad: x => (x = clamp(x), 1 - (1 - x) * (1 - x)),
  inOutQuad: x => (x = clamp(x), x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
  inCubic: x => (x = clamp(x), x ** 3),
  outCubic: x => (x = clamp(x), 1 - (1 - x) ** 3),
  inOutCubic: x => (x = clamp(x), x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  inQuart: x => (x = clamp(x), x ** 4),
  outQuart: x => (x = clamp(x), 1 - (1 - x) ** 4),
  inOutQuart: x => (x = clamp(x), x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
  inQuint: x => (x = clamp(x), x ** 5),
  outQuint: x => (x = clamp(x), 1 - (1 - x) ** 5),
  inOutQuint: x => (x = clamp(x), x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  inExpo: x => (x = clamp(x), x === 0 ? 0 : 2 ** (10 * x - 10)),
  outExpo: x => (x = clamp(x), x === 1 ? 1 : 1 - 2 ** (-10 * x)),
  inOutExpo: x => (x = clamp(x), x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
  inCirc: x => (x = clamp(x), 1 - Math.sqrt(1 - x * x)),
  outCirc: x => (x = clamp(x), Math.sqrt(1 - (x - 1) ** 2)),
  inOutCirc: x => (x = clamp(x), x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
  inSine: x => (x = clamp(x), 1 - Math.cos((x * Math.PI) / 2)),
  outSine: x => (x = clamp(x), Math.sin((x * Math.PI) / 2)),
  inOutSine: x => (x = clamp(x), -(Math.cos(Math.PI * x) - 1) / 2),
  inBack: (x, s = 1.70158) => (x = clamp(x), (s + 1) * x ** 3 - s * x * x),
  outBack: (x, s = 1.70158) => (x = clamp(x), 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2),
  inOutBack: (x, s = 1.70158 * 1.525) => (x = clamp(x), x < 0.5
    ? ((2 * x) ** 2 * ((s + 1) * 2 * x - s)) / 2
    : ((2 * x - 2) ** 2 * ((s + 1) * (x * 2 - 2) + s) + 2) / 2),
  outElastic: (x, p = 0.3) => (x = clamp(x), x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x - p / 4) * (2 * Math.PI) / p) + 1),
  inElastic: (x, p = 0.3) => (x = clamp(x), x === 0 ? 0 : x === 1 ? 1 : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * (2 * Math.PI) / (p * 10 / 3))),
  outBounce: x => {
    x = clamp(x); const n = 7.5625, d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  },
};

// CSS-style cubic-bezier(x1,y1,x2,y2) easing via Newton + bisection.
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t;
  const sy = t => ((ay * t + by) * t + cy) * t;
  const dsx = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    x = clamp(x);
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x; const d = dsx(t);
      if (Math.abs(e) < 1e-6) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1; t = x;
    for (let i = 0; i < 30; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}

// Signature curves for the reel's motion language.
export const curves = {
  snap: bezier(0.7, 0, 0.1, 1),        // hard anticipation, crisp settle
  glide: bezier(0.45, 0, 0.1, 1),      // confident camera move
  whip: bezier(0.9, 0, 0.1, 1),        // whip-pan / transition
  settle: bezier(0.16, 1, 0.3, 1),     // quick out, long tail
};

// Closed-form damped spring from 0 -> 1. t in seconds.
// freq: natural frequency (Hz), damping: ratio (0..1 underdamped, 1 critical).
export function spring(t, freq = 3, damping = 0.5) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq;
  if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t));
}

// Keyframe track: keys = [[time, value, easeFn?], ...] (value may be number or array).
// The ease on key i shapes the segment arriving at key i.
export function track(keys) {
  return t => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, e = ease.inOutCubic] = keys[i];
      const [t0, v0] = keys[i - 1];
      if (t <= t1) {
        const k = e((t - t0) / (t1 - t0));
        return Array.isArray(v0) ? v0.map((a, j) => lerp(a, v1[j], k)) : lerp(v0, v1, k);
      }
    }
    return keys[keys.length - 1][1];
  };
}

// Deterministic PRNG (mulberry32) for any JS-side randomness.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Window helper: 0 before a, ramps to 1 by b (eased), holds, ramps down from c to d.
export function window01(t, a, b, c = Infinity, d = Infinity, e = ease.inOutCubic) {
  if (t < a) return 0;
  if (t < b) return e((t - a) / (b - a));
  if (t < c) return 1;
  if (t < d) return 1 - e((t - c) / (d - c));
  return 0;
}
