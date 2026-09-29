// volume: the frame-exact schedule (DIRECTION §5.5). Pure functions of the in-shot frame f
// (0 = global 384). No GL here: camera, ball, lights, light sheet, aperture and post.
import * as sys from '../_sys.js';

const DEG = Math.PI / 180;
// Beats in in-shot frames (global − 384)
export const T = Object.freeze({
  SHEET1: 12,   // 396: light sheet done, overlap ends
  DOLLY1: 44,   // 428: dolly zoom done, orbit starts
  DOF1: 60,     // 444: aperture fully open
  SQ0: 64,      // 448: anticipation squash before the lift
  RISE0: 68,    // 452: ball lifts out of the notch
  RISE1: 80,    // 464
  BLACK: 84,    // 468: blackout
  ORBIT1: 86,   // 470: orbit done
  FALL0: 90,    // 474: ball falls
  FALL1: 95,    // 479: contact with the slab top
});
export const LOOK_Y = sys.VOL_EYE_Y;           // look-at (0, 0.6, 0)
export const RIM_DIR = (() => { const v = [0.6, 0.3, -0.75], l = Math.hypot(...v); return v.map(x => x / l); })();
export const KEY_I = (1 - 0.18) / sys.KEY3[1];  // key irradiance: lit floor = 0.18 + KEY_I·KEY3.y = 1 → exactly BONE
export const BALL_TOP = 1.236;                  // hover height (tittle), 0.09 above slab contact
export const CYC = Object.freeze({ cove0: 3.0, wall: 3.5, r: 0.5 });

export function makeSchedule(ctx) {
  const E = ctx.ease.ease;
  const NX = sys.NOTCH_X(ctx), NY = sys.NOTCH(ctx);

  // Camera (level): L = (0, 0.6, 0), eye = L + R_yaw·(0, 0, D), D = 1/tan(FOV/2).
  function cam(f) {
    let fov, yaw;
    if (f <= T.SHEET1) { fov = sys.VOL_FOV0; yaw = 0; }
    else if (f <= T.DOLLY1) { fov = 12 + 26 * E.inOutSine((f - T.SHEET1) / 32); yaw = 0; }
    else if (f <= T.ORBIT1) { const u = (f - T.DOLLY1) / 42; fov = 38 - 24 * E.inOutQuint(u); yaw = 90 * E.inOutQuint(u); }
    else { fov = 14; yaw = 90; }
    const th = Math.tan(fov * DEG / 2), D = 1 / th, a = yaw * DEG, s = Math.sin(a), c = Math.cos(a);
    return { fov, yaw, th, D, eye: [D * s, LOOK_Y, D * c], R: [c, 0, -s], U: [0, 1, 0], F: [-s, 0, -c] };
  }

  // Ball: rests at (NOTCH_X, NOTCH, 0) (§8.2). 448–452 anticipation: a volume-preserving squash (sy 0.8,
  // sx = sz = 1/√0.8) that keeps its lowest point; 452–464 rises to (0, 1.236, 0) with outBack, releasing
  // the squash into a short stretch; 474–479 falls to 1.146 with a volume-preserving stretch that is round
  // again at contact, the centre following §5.5's y(f) exactly.
  function ball(f) {
    const r = sys.BALL_R;
    let x = NX, y = NY, sy = 1;
    if (f > T.SQ0 && f <= T.RISE0) sy = 1 - 0.2 * E.inOutSine((f - T.SQ0) / (T.RISE0 - T.SQ0));
    if (f > T.RISE0) {
      const k = E.outBack((f - T.RISE0) / (T.RISE1 - T.RISE0));
      x = NX + (0 - NX) * k; y = NY + (BALL_TOP - NY) * k;
      const t = f - T.RISE0;   // frames since takeoff: 0.8 → 1.14 in 1.5 f, back to round by 6 f
      sy = t < 1.5 ? 0.8 + 0.34 * E.outQuad(t / 1.5) : 1 + 0.14 * (1 - E.inOutSine(Math.min((t - 1.5) / 4.5, 1)));
    }
    if (f > T.FALL0) {
      const u = Math.min((f - T.FALL0) / (T.FALL1 - T.FALL0), 1);
      x = 0; y = BALL_TOP - 0.09 * E.inQuad(u);
      sy = 1 + 0.15 * Math.sin(Math.PI * u);   // about the centre (§5.5's y(f) literally): round again at contact
    } else if (sy < 1) {
      y -= r * (1 - sy);                    // squash (and its release) on the lowest point
    }
    const sx = 1 / Math.sqrt(sy);
    return { c: [x, y, 0], s: [sx, sy, sx], r };
  }

  // Lights: ambient, key irradiance, COBALT rim, overhead spot (blackout only).
  function lights(fi) {
    if (fi >= T.BLACK) return { amb: 0.005, key: 0, rim: 2.2, spot: 1 };
    return { amb: 0.18, key: KEY_I, rim: 2.0, spot: 0 };
  }

  // Light sheet: plane x = P sweeping −2.5 → +2.5 wu over 384–396 (inOutSine).
  const sheetP = f => -2.5 + 5 * E.inOutSine(Math.min(Math.max(f / T.SHEET1, 0), 1));

  // Camera-locked fill on the ball: 0 while KEY3 lights the camera side, up to 0.6 edge-on.
  const fill = yaw => 0.6 * E.inOutSine(Math.min(Math.max((yaw - 15) / 60, 0), 1));

  // Circle of confusion at the wall (px at 1080p, diameter): 0 → COC_MAX over 428–444, then held. §5.5 allows
  // ≤ 12; 6 keeps the wall grid (1 px, 20 %) legible behind and *through* the glass, where its displaced,
  // split lines are what show the glass's thickness (at 12 px they vanish and the glass reads as a grey fill).
  const COC_MAX = 6;
  const cocWall = f => (f <= T.DOLLY1 ? 0 : COC_MAX * E.inOutSine((f - T.DOLLY1) / (T.DOF1 - T.DOLLY1)));

  // Post: bloom 0.45 (eased in from lens by setPost), 0.45 → 0.8 over 468–479.
  const bloom = fi => (fi < T.BLACK ? 0.45 : 0.45 + 0.35 * E.inOutSine((fi - T.BLACK) / (T.FALL1 - T.BLACK)));

  return { cam, ball, lights, sheetP, fill, cocWall, bloom, NX, NY };
}
