# `_sys.js`: the shared system (package 9)

`src/shots/_sys.js` is the pure, deterministic library every shot imports (DIRECTION.md §1.1, §1.2, §2.3).
Nothing in it touches the DOM at import time. Anything that needs fonts or GL takes the engine
`ctx`, computes once and caches (per GL context and per `config.name/role/year`).

```js
import * as sys from './_sys.js';

init(ctx) {
  sys.initSys(ctx);                        // idempotent: glyph SDFs of the name, NOTCH, layouts (~1.1 s once per page)
  const V = sys.glyphSDF(ctx, sys.stationLetter(ctx, 3));
  this.prog = ctx.program(`${ctx.glsl.all}${sys.SYS_GLSL}${sys.glyphUniformDecl('uV')}
    in vec2 vUv; out vec4 o; uniform vec2 uRes;
    void main(){ vec2 p = P(vUv, uRes.x/uRes.y);
      float d = glyphDist(uVTex, uVMeta, uVPlace, p);           // signed distance in H
      vec3 col = BONE * (1.0 + paperFibre(p));
      col = mix(col, INK, clamp(0.5 - d*uRes.y, 0.0, 1.0));
      o = vec4(col, 1.0); }`);
  this.V = sys.placeGlyph(V, sys.CAP_V2D, sys.BASE_V2D, 0);     // cap, baseline, ink-box centre x
},
render(ctx, s) { ctx.draw(this.prog, { ...this.V.uniforms('uV'), ...sys.sysUniforms(ctx) }, s.target); }
```

A complete working example is `src/shots/_testSys.js` (`node tools/render.mjs --test sys --frames 0,738`).
It draws the whole title layout from `_sys`, and on each touch frame the dot sits at that touch point.

## Units

| Name | Meaning |
|---|---|
| **H** | Frame height. Screen coords `p = (vUv − 0.5)·(aspect, 1)`: origin at the centre, y up, x ∈ ±0.8889, y ∈ ±0.5. |
| **cap units** | Multiples of a glyph's cap height, measured from the **pen origin on the baseline**, with y up. `glyphSDF`, `glyphD`, `restY` and `NOTCH` all use them. In `volume`, where cap = 1 wu, cap units are world units. |
| **em (H)** | A font size expressed in H. Canvas px = `size·ctx.H`; use `fontPx(ctx, spec, size)`. |
| **design px** | 1/1080 H (`PX`). Pixel constants in the spec are design px. Multiply by `ctx.scale` for real px. `halftone45`'s `cellPx` is in design px and already scales. |

## Palette and light (§1.2, §1.4)

| Export | Value |
|---|---|
| `PAL` | Hex strings for canvas `fillStyle`: `{INK:'#0E0E12', BONE:'#F1EBDF', VERM:'#FF3A1F', COBALT:'#2233FF', GRAPHITE:'#26262B'}` |
| `PAL_SRGB` | sRGB-coded `[r,g,b]` in 0..1, e.g. `post.flashColor = PAL_SRGB.BONE` = (0.9451, 0.9216, 0.8745) |
| `PAL_LIN` | Linear `[r,g,b]` from the **exact** piecewise EOTF (computed, not copied): INK (0.004391, 0.004391, 0.006049) · BONE (0.879622, 0.830770, 0.737910) · VERM (1, 0.042311, 0.013702) · COBALT (0.015996, 0.033105, 1) · GRAPHITE (0.019382, 0.019382, 0.024158) |
| `WARM_LIN` | (1, 0.955, 0.90): the tonemap's roll-off white. Only for HDR highlights (e.g. `2.2·WARM`), never a fill. |
| `srgbToLinear(c)`, `linearToSrgb(l)` | Exact scalar transfer functions |
| `KEY2` | normalize(−1, 1) = (−0.707107, 0.707107) |
| `KEY3` | normalize(−0.55, 0.70, 0.45) = (−0.551380, 0.701757, 0.451129) |
| `SHADOW_PX`, `SHADOW_CELL_PX`, `SHADOW_COVER` | The 2D hard shadow: [6, −6] design px, 8 px cells, 0.35 coverage |
| `C_MOD`, `PX` | 1/18 and 1/1080 (H) |

Verified: every GLSL palette constant reads back its exact hex through the exact OETF. In
`?clean=1` renders through the engine (PRINT tonemap), BONE, INK and VERM read back exactly.

## Timing and motion constants

| Export | Value |
|---|---|
| `F32`, `F16`, `F8`, `BEAT`, `BAR` | 3, 6, 12, 24, 96 frames |
| `SPRING_DOT` | [3.0, 0.48] |
| `SPRING_TYPE` | [3.5, 0.45], i.e. `ctx.ease.spring(t, ...SPRING_TYPE)` (and `...SPRING_DOT` for the dot) |
| `FIG` | `['FIG. 0 — POINT', …, 'FIG. 7 — FULL STOP']` (em dash U+2014). Station k maps to `FIG[k+1]`. |
| `paperZ(frame)` | `1 + 0.0004·min(frame, 168)`. Accepts fractional frames (MB) and clamps below 0. |

## Letters and stems

| Export | Returns |
|---|---|
| `nameLetters(ctx)` | `config.name` uppercased, letters only (Unicode `\p{L}`), as an array |
| `stationLetter(ctx, k)` | The k-th of those letters, modulo their count (negative k wraps). NEKVIT: 0 N, 1 E, 2 K, 3 V, 4 I, 5 T |
| `stemRatio(wght)` | Stem ÷ cap for Archivo wdth 100, linear between §2.3's table entries, clamped to [100, 900] |
| `STEM(wght)` | Same as `stemRatio`. `STEM.table = [[wght, ratio], …]`. `0.25·STEM(300 / 850 / 900)` = 0.02875 / 0.073 / 0.0805 |

## Volume camera constants (lens + volume)

| Export | Value |
|---|---|
| `BALL_R` | 0.146 cap/wu. The ball radius, also the V's half depth. On screen at f384 the radius is `0.5·BALL_R` = 0.073 H. |
| `VOL_FOV0` | **12, in degrees**. `VOL_FOV0_RAD` = 0.20944 for `mat4.perspective` / `camRay`. |
| `VOL_D0` | 1/tan 6° = 9.514364 |
| `VOL_EYE_Y` | 0.6. At yaw 0 world (x, y, 0) maps to screen `0.5·(x, y − 0.6)`. |
| `S_FRONT` | `VOL_D0/(VOL_D0 − 0.146)` = 1.015584 |
| `CAP_V2D`, `BASE_V2D` | 0.507792, −0.304675: the V's front face as `volume` projects it |
| `NOTCH(ctx)` | `vNotchRest(glyphSDF(stationLetter(3)), 0.146)` = **0.8079** for Archivo V 850 (spec ≈0.806–0.809). **A function** (it needs fonts). After one call with ctx (or `initSys(ctx)`), `NOTCH()` also works, and so does the spec's value style: `sys.NOTCH * 0.5`, `+sys.NOTCH`, `` `${sys.NOTCH}` ``. Value-style use before that **throws** a clear error (never NaN). Passing `sys.NOTCH` itself as a uniform throws in `prog.set()`. |
| `NSTAR(ctx)` | `{x: 0, y: 0.5·(NOTCH − 0.6), r: 0.073}` = (0, **0.1039**), r 0.073. Also a function; after `initSys(ctx)`, `sys.NSTAR.x / .y / .r` read the values (throw before). |

## Glyph SDFs (§2.3)

**`glyphSDF(ctx, ch) → meta`** is cached per GL context and character. The glyph is rasterised at Archivo 850/100
with cap = `GLYPH_CAP_PX` = 360 px and `GLYPH_PAD` = 0.6 cap of padding around the ink box.

| Field | Meaning |
|---|---|
| `tex` | R32F texture: signed distance in **texture px**, negative inside. Linear filtering, clamped. |
| `capPx` (360), `pad` (0.6), `w`, `h` | Raster cap height, padding, and texture size in px |
| `ox`, `oy` | Pen origin in texture px, measured from the **bottom-left** (GL uv convention) |
| `inkX0`, `inkX1`, `inkY0`, `inkY1`, `inkCx`, `inkCy`, `inkW` | Ink box in cap units. Taken from the SDF zero set of the raster (sub-pixel), not `measureText`. |
| `adv` | Unkerned advance in cap units, measured at 1000 px. Chrome applies the variable-font deltas in whole font units, so advances of the interpolated 850 instance are quantised to 0.001 em (V: 0.754 vs 0.753573 unrounded), i.e. ≤ 0.2 px per glyph at the title size. Measuring at a larger size does not help (the quantisation is in font units). |
| `data` | `Float32Array(w·h)`, row 0 = bottom. The texture contents, for the CPU `glyphD`. |
| `canvas` | Cropped raster: white ink on transparent, canvas y-down, pen at `(ox, h − oy)`. For raster sampling (e.g. `field`). |
| `ch`, `sizePx`, `font`, `fontStr` | Character, raster font size in px, font spec, CSS font string |

Measured metas (cap units from the pen origin):

| Glyph | Ink x range | inkCx | adv |
|---|---|---|---|
| V | [0.0231, 1.0716] | 0.5474 | 1.0967 |
| K | [0.1083, 1.1422] | 0.6252 | 1.1651 |

The SDF comes from `sdfFromAlpha` rather than `ctx.text.sdfTexture` (see Deviations).

**`sdfFromAlpha(alpha, w, h) → Float32Array`** (defined in `src/sdf.js`, re-exported here): an accurate signed distance field
for any antialiased mask (canvas order, px, negative inside). It seeds sub-pixel edge points from coverage and a Sobel normal
(Gustavson & Strand "edtaa"), then propagates the nearest edge point with one forward and one backward 8-neighbour raster sweep.
Against analytic shapes: mean |error| 0.043 px, max 0.32 px (at corners). `ctx.text.sdfTexture` now uses the same generator
(it used to overestimate |d| by ≈0.86 px). Cost: about 85–190 ms per glyph.

**GLSL (in `SYS_GLSL`):**

```glsl
float glyphD(sampler2D tex, vec4 meta, vec2 q);                  // q: cap units from pen origin → distance in cap units
vec2  placeGlyph(vec2 p, vec4 meta, float cap, float baselineY);                  // ink box centred on x = 0
vec2  placeGlyph(vec2 p, vec4 meta, float cap, float baselineY, float centreX);   // ink box centred on x = centreX
vec2  placeGlyph(vec2 p, vec4 meta, vec4 place);                // place = (cap, baselineY, centreX, 0)
float glyphDist(sampler2D tex, vec4 meta, vec4 place, vec2 p);  // distance in the units of p (H or wu)
```

- `meta` is `vec4(ox, oy, capPx, inkCx)`. Outside the texture, the sample is clamped and the distance to the texture bounds is added (§2.3).
- `glyphD` samples with `textureLod`, so it is safe in raymarch loops and branches.
- **Placement:** `q = ((p.x − centreX)/cap + inkCx, (p.y − baselineY)/cap)`.

**JS:**

| Export | Returns |
|---|---|
| `glyphUniforms(meta, prefix='uGlyph')` | `{uGlyphTex, uGlyphMeta: [ox,oy,capPx,inkCx], uGlyphInk: [inkX0,inkY0,inkX1,inkY1]}` |
| `glyphUniformDecl(prefix)` | The matching GLSL declarations, including `${prefix}Place` |
| `glyphMeta4(meta)` | `[ox, oy, capPx, inkCx]` |
| `glyphD(meta, qx, qy)` | CPU mirror of the GLSL `glyphD` (same bilinear sampling and clamp). GPU vs CPU: ≤ 0.0001 px inside the texture, up to ≈0.0006 px far outside it (float32 rounding of the added bounds distance). |
| `placeGlyph(meta, cap, baselineY, centreX = 0)` | `{meta, cap, baselineY, centreX, place, penX, q(x,y), p(qx,qy), d(x,y) (distance in p units), box {x0,x1,y0,y1}, uniforms(prefix)}`. `uniforms()` adds `${prefix}Place`. |
| `restY(meta, xCap, rCap)` | The centre height (cap units) where a ball of radius rCap, dropped on x = xCap, first touches ink. Details below. |
| `vNotchRest(meta, rCap)` | `restY(meta, meta.inkCx, rCap)` |
| `notchRestXY(meta, rCap)` | **Extra.** `{x, y, dx}`: where a ball that may also roll sideways (±0.1 around inkCx) settles, touching **both** walls. V 850, r 0.146: dx +0.0068, y 0.7872. See the notes below. |
| `scanInk(meta, qy, x0, x1)` | First x (bisected) from x0 toward x1 on `q.y = qy` where `glyphD ≤ 0`, or `null`. `lens` O_K = `scanInk(K, 0.5, K.inkX1, K.inkCx) ?? K.inkCx` = **0.8272** (spec ≈0.824). |

`restY` details:
- It scans down in 0.001 steps and bisects inside the step where contact happens (exact contact).
- The scan starts at `max(1, meta.inkY1) + rCap` (+0.002), where the ball clears all ink. For flat-topped glyphs (all of NEKVIT)
  that is §2.3's start at `1 + rCap`, and a ball wider than a notch still rests on its two top corners. Glyphs that rise above
  cap height are touched **on top** instead of penetrated: overshoot (O, C, G, S, Q: inkY1 ≈ 1.017, rest 1.187 at r 0.17) and
  accents (Ž: rest 1.356). If the start sample touches anyway (raster tolerance), it climbs until clear first.
- It returns `1 + rCap` only if nothing is found above y = 0.2 (the line misses the glyph).
- So `NOTCH` for a station letter without a notch is "on top of the glyph" (§5.5): 1.146 for flat tops, 1.163 for O.

## `roleLayout(ctx)` (H units)

| Field | Value for "Motion Design" |
|---|---|
| `cap`, `fit` | `cap = 0.24·fit`. `fit` = 1 unless the layout would leave title-safe (\|x\| > `ROLE_SAFE_X` = 0.80, incl. dotAlt); then everything horizontal and every size scales by `fit`, baselines stay. **Provisional fallback rule** (the spec has none): "Motion Design" 1, "Art Direction" 1, "Motion Graphics Lead" 0.891, "Animator" 0.840, "Type-Work" 0.740. |
| `w1` | `{text, font: W1_FONT (Archivo 500/100), cap, size 0.3499 em, baseline 0, x0, x1, adv, glyphs[{ch,i,x,adv}]}`. Centred on its advance: `x0 = −adv/2`. **adv 1.4037** (spec ≈1.404) |
| `w2` | `{text 'desıgn', font: SERIF_FONT, cap, size fs, baseline −0.30, x1 = w1.x1, x0, adv, glyphs, iIndex, xI}`. `xI` = pen x of the ı = 0.3032. `null` for a one-word role. |
| `fs` | `cap/capRatio(Instrument Serif Italic)` = 0.24/0.720 = **0.3333** (the measured cap ratio equals the spec's 0.72) |
| `tittle` | `{x: xI + 0.2105·fs, y: −0.30 + 0.6575·fs, r: 0.0515·fs}` = **(0.3733, −0.0808) r 0.0172**. `null` if there is no ı. |
| `dotAlt` | `{x: advEnd + 0.05·fs, y: baseline + 0.07·fs, r: 0.0515·fs}`. Only set when there is no ı, otherwise `null`. |
| `T_DOT` | `tittle ?? dotAlt`. Also exported as `T_DOT(ctx)` (a function; after `initSys(ctx)`, `sys.T_DOT.x / .y / .r` also work). |

`TITTLE_EM = {x: 0.2105, y: 0.6575, r: 0.0515}`. Verified against a raster of the real Instrument Serif Italic `i`
minus `ı`: centroid (0.2104, 0.6575), area-equivalent radius 0.0517 em. `tools/syscheck` shows the tittle covering
the real i-dot exactly.

## `nameLayout(ctx)` (H units)

| Field | Value for NEKVIT |
|---|---|
| `name`, `letters`, `n` | 'NEKVIT', 6 |
| `cap` | `min(0.20, 0.20·1.45/blockW)` = **0.20**. blockW is measured at cap 0.20 = **1.2434** (spec text says 1.21; see Notes). |
| `yb`, `size`, `font` | +0.02; em of the 850 face in H = cap/0.6875; `NAME_FONT` |
| `glyphs[i]` | `{ch, i, meta, penX, adv (kerned), inkL, inkR, cx, inkB, inkT, place}`. `place` = `placeGlyph(meta, cap, yb, cx)`, ready for `glyphDist`. |
| `inkLeft`, `blockX0` | **−0.6217** (spec ≈−0.623) |
| `penEnd`, `blockX1` | Pen end, and `blockX1` = `dot.x + r` = 0.6217. The block is centred on x = 0. |
| `dot` | `{x: penEnd + 0.2375·cap, y: yb + 0.17·cap, r: 0.17·cap}` = **(0.5877, 0.054) r 0.034** (spec ≈(0.589, 0.054)) |
| `S0` | `{x: inkLeft − 0.375·cap, y: dot.y, r}` = **(−0.6967, 0.054)** (spec ≈(−0.698, 0.054)) |
| `rule` | `{y: yb − 0.425·cap, x0: inkLeft, x1: dot.x + r, w: 4/1080, wPx: 4}`. `y` = **−0.065** is the rule's centre line. |
| `role` | `{text: config.role as is, font: SERIF_FONT, cap: 0.275·cap = 0.055, size, baseline: yb − 0.9·cap = −0.16, x (pen), inkL, glyphs[{ch,i,x,adv}]}`. The first glyph's **ink** left edge is at inkLeft (pen x −0.6184). |
| `year` | `{text, font: YEAR_FONT (Archivo 500/125, `tnum: true`), cap 0.040, size, baseline −0.16, x0 (first pen) = 0.4478, x1 (= dot.x + r, ink right edge), tracking 0.04 em, cellW (tabular digit advance, 0.724 em), glyphs[{ch,i,x (pen),cellX (= x),adv}]}`. An empty `config.year` gives no glyphs and x0 = x1. |
| `yTouch[i]` | `yb + cap·restY(glyph_i, inkCx_i, 0.17)`: N 0.2178 (on the diagonal) · E 0.2540 (on top) · K 0.2372 (on the arm) · **V 0.1976 = yb + 0.888·cap** · I 0.2540 · T 0.2540. Verified tangent (no penetration) for NEKVIT, OSCAR, ŽOFIE, KAROLINA, QUBO. |
| `delta` | `3·max(1, ⌊10/(n−1)⌋)` = 6. Also exported as `touchInterval(n)`. |
| `touches[i]` | `{i, frame: 720 + i·Δ, x: cx_i, y: yTouch[i], world: i % 6, fig: FIG[i%6 + 1]}` |
| `touchFrames` | 720, 726, 732, 738, 744, 750 |

The year uses Archivo's real tabular figures (`zero.tf` … `nine.tf`, all 724 units): `ctx.text.font({..., tnum: true})` selects a
FontFace alias registered with `featureSettings: '"tnum" 1'` (src/text.js, `TNUM_WIDTHS`), and the pens are the plain advances plus
0.04 em tracking. Draw with `fontPx(ctx, N.year.font, N.year.size)`.

Draw each glyph individually at its `x`/`penX`. Measured kerning: K–V −54.6 (the GPOS −55 through whole-font-unit advances), 0 for every other pair.

## GLSL chunk `SYS_GLSL`

`SYS_GLSL` is self-contained. It prepends `glsl.js` `common` (guarded) and brings its own hash. It is safe to include
in any order with `ctx.glsl.*`, or twice. It declares `uniform float uSysClean;`, which the engine's `ctx.draw` sets automatically
(`sysUniforms(ctx)` gives the same thing by hand).

| GLSL | Meaning |
|---|---|
| `INK BONE VERM COBALT GRAPHITE WARM` | Linear `const vec3` |
| `KEY2`, `KEY3`, `C_MOD`, `PX_H` | Constants (`PX_H` = 1/1080) |
| `vec2 P(vec2 uv, float aspect)` | `(uv − 0.5)·(aspect, 1)` |
| `float paperFibre(vec2 p)` | Luma modulation in **[−0.015, +0.015]**; use `col *= 1.0 + paperFibre(p)`. Anisotropic 3-octave value-noise fbm at `uv·(2,60)` of a 16:9 frame. p is in H (screen p, or paper q for the paper push). Returns 0 when `uSysClean = 1`. Measured range: −0.0127…+0.0118. |
| `float halftone45(vec2 p, float cellPx, float cover)` | 45° dot screen with the grid anchored at p = 0. `cellPx` is in design px. Returns AA coverage 0..1. At 1080p with 8 px cells the mean equals `cover` within ±0.002 for cover ≤ 0.7 (the dot radius is corrected for the AA ramp); where dots merge (0.785–0.97) it reads up to 0.015 low. With 6 px cells (role print-in) at 1080p: 0.7 → 0.6955, 0.8 → 0.778, 0.9 → 0.882; at 540p 0.9 → 0.837. At 1 it is solid. Uses `fwidth(p)`: **call it in uniform control flow** (not inside a branch/loop whose condition varies per pixel). |
| `float halftone45(vec2 p, float cellPx, float cover, float aaPx)` | The same without derivatives: `aaPx` = design px per screen px (`1080.0/uRes.y` for screen-space p). Safe in branches and loops. |
| `float halftone45Rho(vec2 p, float cellPx, float rho[, float aaPx])` | The same screen, driven by the dot radius in cell units (0…0.7071 = solid). Use it for "radius grows to solid" print-ins. The 3-argument form uses `fwidth` (uniform control flow only). |
| `float halftoneRho(float cover)` | Coverage → radius; `halftoneRho(cover)` in JS mirrors it |
| `vec3 palDisperse(vec3 a, vec3 b)` | Exactly as in §2.3 |
| `glyphD`, `placeGlyph` ×3, `glyphDist` | See Glyph SDFs above |

## Fonts and helpers

| Export | Meaning |
|---|---|
| `NAME_FONT` | Archivo 850/100 |
| `W1_FONT` | Archivo 500/100 |
| `SERIF_FONT` | Instrument Serif 400 italic |
| `YEAR_FONT` | Archivo 500/125, `tnum: true` (tabular figures) |
| `capRatio(ctx, spec)` | Cap ÷ em, measured on 'H' at 1000 px: Archivo 850/100 **0.6875** · 500/100 0.6860 · 500/125 0.68675 · Instrument Serif Italic **0.7200** |
| `sizeForCap(ctx, spec, cap)` | `cap / capRatio` |
| `advanceEm(ctx, spec, ch)` | Advance in em, measured at 1000 px |
| `inkExtentsEm(ctx, spec, ch)` | `{l, r, adv}` in em, from a raster scan |
| `toCanvas(ctx, x, y)` | Screen H coords → canvas px of a W×H Surface |
| `fontPx(ctx, spec, sizeH)` | CSS font string at `sizeH·ctx.H` px |
| `isClean(ctx)`, `sysUniforms(ctx)` | Detects `?clean=1`: the first of `ctx.clean`, `ctx.config.clean`, `ctx.post.clean` that is set, else the URL; `sysUniforms` returns `{uSysClean}` |
| `initSys(ctx)` | Computes everything and returns `{NOTCH, NSTAR, T_DOT, nameLayout, roleLayout}` |

Always get layout numbers from these functions. Never copy the values printed here into a shot.

## Verification

```
node tools/syscheck.mjs                      # values + gpu + overlay; prints every number above vs the spec
node tools/syscheck.mjs --name KAROLINA --role Animator     # fallbacks (any name 2–11 letters, any role)
node tools/syscheck.mjs --eval probe.js                      # run a file's body in the page (ctx, __S)
node tools/render.mjs --test sys --frames 0,738 [--clean]   # through the real engine
```

`tools/syscheck.mjs` serves the repo, opens `tools/syscheck.html` (fonts plus a WebGL2 ctx) and runs `tools/syscheck.js`.
Its debug images go to `out/syscheck/`:
- `name_overlay.png`: canvas-rendered type overlaid with ink boxes, the GLSL `glyphDist` outlines, touch balls, dot, S0, rule, role and year
- `role_overlay.png`: the lens rest layout, with a real `i` ghosted under the tittle
- `zoom.png`: 4× crops of the tittle, the full stop, and the V/N/K touches
- `gl_visual.png` and `notch_zoom.png`: the ball at NOTCH, the 2D V at CAP_V2D with NSTAR, O_K, the halftone and the palette

## Deviations and notes

- **SDF generator.** `glyphSDF` uses `sdfFromAlpha` (src/sdf.js), which `ctx.text.sdfTexture` now shares. The old engine generator
  overestimated |d| by about 0.9 px on both sides of every edge; that would have lifted `restY` and NOTCH by about 0.003 cap. The
  glyph texture is single-channel R32F (px, negative inside); `sdfTexture` keeps its RGBA32F shape.
- **`restY` precision.** `restY` bisects inside the 0.001 step where contact happens, giving exact contact rather than a 0.001-quantised value.
- **blockW.** The spec text says NEKVIT measures 1.21. The exact value is 1.2433, which is also what the spec's own inkLeft and dot
  check values imply (0.589 + 0.034 + 0.623 = 1.246). The cap is 0.20 either way.
- **The V's notch is off its ink centre.** Archivo V 850 has a thick left diagonal and a thin right one. Its notch axis is at
  inkCx + 0.0068 cap. A ball dropped on the ink-centre line (the spec's NOTCH and yTouch) touches only the left wall and
  clears the right wall by 0.0127 cap. That is ≈7 px in `volume`/`lens` at cap ≈0.5 H, and ≈2.7 px in the title's V touch.
  `notchRestXY` gives the two-wall rest (dx +0.0068, y 0.7872) if the direction prefers it.
- **The ball in lens OUT.** The NSTAR disc clears the walls of the 2D V drawn at front-face scale (CAP_V2D/BASE_V2D) by 0.74 px.
- **Year figures.** Real tabular figures via the text.js `tnum` alias (see above). The earlier claim that Canvas 2D cannot enable
  `tnum` was wrong: the FontFace `featureSettings` descriptor works.
- **Long roles.** The spec has no fit rule for w1/w2: "ANIMATOR" at cap 0.24 put `dotAlt`/T_DOT at x ≈ 0.94 (off-screen) and
  "graphıcs lead" started at x −0.898. `roleLayout` now scales cap by `fit` so everything stays within ±0.80 (see the table);
  "Motion Design" is unchanged (fit 1). Provisional until the direction owner confirms a rule.
