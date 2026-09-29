# FULL STOP. NEKVIT Showreel 2026: Final Direction

**Status:** binding spec v1.1. It supersedes v1.0 and all three pitches. Every engineer implements exactly one package from this document. Where a number is given, it is the number.

---

## 0. Logline and idea

**Logline.** A vermilion dot is born on the first downbeat and travels through the letters of the designer's name. At each letter it gains a dimension and a new craft: point, line, plane, lens, volume, flow, field. In the last two seconds the dot skips back across the name, and each letter it touches opens onto the world it made. The dot then lands as the full stop: **NEKVIT.**

**The one idea: follow the dot.** If something is vermilion, it is the dot, something born from the dot, or the cut. The six middle shots are stations, each built on one letter of `config.name`, in order: N is engraved, E is a window, K is a lens, V is a volume, I is a wall, T is an emitter. The viewer follows a red dot through what feels like a Bauhaus manual of motion design. Only on the title card do they see that the manual spelled the name. The reel opens on a vermilion dot on Bone paper and closes on the same dot, now used as a full stop. There is one idea and one payoff, and nothing sits outside it.

**Where each part came from:**
- **Spine, from FULL STOP:** the dot, the 150 BPM grid, the print pipeline and halftone, the tittle, disc-to-sphere by light, the light-sheet wipe, the dolly-zoom flatten, the halftone dissolve, the full stop.
- **Grafted from COUNTERSPACE:** letters as stations, render-pass windows in the E, the weight wave, glass K into V, the glass-V breath, the edge-on V as an "i", weight as a fluid wall, I into T, the contact-sheet windows with a six-note signature, alpha-matte handoffs with a vermilion rim.
- **Grafted from SURFACE TENSION:** continuous camera velocity across cuts, and silence before each big hit.
- **Killed:** the museum, voronoi, chrome, iridescence, galaxy, eclipse and stargate; the manifesto copy and the scale odometer; the O-counter zoom and the N lattice; a second flash; blur-to-sharp type.

---

## 1. Rules of the world

### 1.1 Units (everyone)

- **Screen coordinates:** `p = (vUv − 0.5) * vec2(aspect, 1)`.
  - Origin at frame centre, y up, units of frame height H.
  - x ∈ [−0.8889, 0.8889], y ∈ [−0.5, 0.5].
  - 1px = 1/1080 H. Multiply every pixel constant by `ctx.scale`.
- **Module:** `c = 1/18 H` (60px).
  - The frame is 32×18 modules, and the frame centre is a module corner.
  - Module lines sit at k·c; cell centres sit at (k+½)c.
- **Title-safe area:** |x| ≤ 0.80, |y| ≤ 0.45.
- **Frames** are global at 60 fps.
- **Camera roll and camera pitch:** none, anywhere in the reel. Every camera is level.

### 1.2 Palette (five colours, no others)

| Token | Hex | Linear (exact sRGB EOTF) | Role | Budget |
|---|---|---|---|---|
| INK | #0E0E12 | (0.0044, 0.0044, 0.0060) | Ground, type on paper, shadows, unlit studio | ~45% |
| BONE | #F1EBDF | (0.880, 0.831, 0.738) | Paper, type on Ink, 3D albedo, cool dust | ~30% |
| VERM | #FF3A1F | (1.0, 0.0423, 0.0137) | **The dot**, everything born from it (flood, horizon, pigment, dust, ball, rule), and **the cut** (rim on every matte or wipe edge) | ~18% |
| COBALT | #2233FF | (0.0160, 0.0331, 1.0) | Counter-colour: E's plane, glass tint, cool dispersion band, 3D rim light | ≤12% of any frame |
| GRAPHITE | #26262B | (0.0194, 0.0194, 0.0242) | Grid lines on Ink only | lines |

- Warm white (1.0, 0.955, 0.90) exists only as the tonemap's highlight roll-off. It is never a fill.
- 2D work has no gradients. Colour changes only across hard, antialiased edges. Gradients exist only inside light renderings: the lens glass, `volume`, and title world 3.
- No chrome, no iridescence, no rainbow. Dispersion only ever falls on the VERM–COBALT axis (§2.3 `palDisperse`).
- **Minimum line widths (for 4:2:0 delivery):**
  - Any VERM or COBALT line is at least 3px·scale: rims 3px, title rule 4px, window rims 3px, dissolve ring 3px.
  - 1–2px lines are allowed only in luma-contrast colours (INK, BONE, GRAPHITE).
  - A VERM line may taper below 3px only while it is moving (the f768 ring).

### 1.3 Typography

**Archivo Variable** (the only display family)
- Every letterform of the name uses **wght 850, wdth 100, caps, tracking 0**. This covers the station glyphs, the glass K and V, the pigment I, the dust T and the title. All of them come from `sys.glyphSDF`.
- The kinetic word runs from a rest of 500/100 to a peak of 900/125.
- Width is continuous: `ctx.text.font({family:'Archivo', weight, width})` accepts wdth in 0.25 steps (package 9). Never fake width with a scale.
- The year is set in Archivo 500, wdth 125, tabular figures, tracking +0.04 em.

**Instrument Serif Italic** (the human voice)
- Role word 2 (`roleLayout.w2`), lowercased, with a dotless ı (U+0131).
- The title role line, exactly as `config.role`.
- The latching serif flips in `lens`: uppercase, at a matched cap height.

**JetBrains Mono 500:** the engine HUD and the three pass tags in `plane`. Use ASCII plus em dash (—) and middot (·) only.

**Allowed words:** the role, the name, the year, the pass tags and the HUD. Nothing else. The role's first word appears as a hero word exactly once, in `lens`.

### 1.4 Light, texture and post

**Key light.** One key light from the upper left, everywhere.
- In 2D: a hard shadow offset of (+6px, −6px), rendered as a 45° Ink halftone (8px·scale cells, 35% coverage).
- In 3D: the direction to the light is `KEY3 = normalize(−0.55, 0.70, 0.45)`.
- The fluid's specular uses the same light.
- A COBALT rim appears in 3D only.

**Tonemap: mode 3, PRINT, for every shot** (§2.2).
- Values ≤1 map exactly to their hex.
- Values above 1 keep their hue and roll off to warm white, reaching it at 4.
- Author flat colours at ≤1.
- HDR values (>1) are only for:
  - specular highlights
  - rims and contours (2.0–2.5)
  - the light sheet (2.0)
  - accumulated dust (≤4)
  - the comet core

**Bloom.** Only in HDR shots, with threshold 1.05 and knee 0.1, so flat vermilion never blooms. 2D print shots use bloom 0 and CA 0.

**Grain.** 0.03 at size 1.6 everywhere. It is luminance-weighted.

**Paper fibre on BONE.** Anisotropic fbm at `uv·(2,60)`, ±1.5% luma.

**Vignette.** 0.08 in 2D shots, at most 0.18 in HDR shots.

**Budgets:**
- One flash, at f480, in Bone.
- One blackout, f468–479.
- CA spikes only at 480 and 600.
- Shake only at 480.

### 1.5 Motion language

- **Entrances:** outExpo over 10–14 frames, or springs. Nothing moves linearly except scrolls and trucks.
- **Springs** (`ctx.ease.spring(t,freq,ζ)`):

  | What | Freq | ζ | Limit |
  |---|---|---|---|
  | The dot | 3.0 Hz | 0.48 | ≈18% overshoot, the maximum anywhere |
  | Type axes | 3.5 Hz | 0.45 | Clamped at the axis limits |

  - Planes and windows overshoot by at most 3%.
  - Rotations use inOutBack with s = 1.3.
  - Cameras never overshoot: use inOutSine, inOutQuint or inOutCubic.
- **Anticipation:** every dot hop has a 2–4f squash (sx 1.2, sy 0.8) before takeoff and a 2f squash on landing. Volume is preserved.
- **Exits:** things leave through masks, slots, wipes and cell dissolves, never through opacity fades. There are only two exceptions:
  - the flash decay, 480–490
  - the audio fade, 870–899
- **Timing:**
  - Every event sits on the 150 BPM grid (a 16th is 6f, a 32nd is 3f).
  - Key compositions hold for at least 12f.
  - Hero type gets at least 30 clean frames.
- **Motion blur:** every shot declares `mb(f)` (§2.2). Fast moves never show as single-frame strobes.
- **Composition:** heroes do not all rest dead centre.
  - Off-axis rests: the N (ink centre at x −0.18, bleeding off the top and bottom), the K (x +0.40, sitting on the tittle), and the comet storm (framed by the yaw).
  - Symmetric anchors: `volume`, `flow` and the title.
- **Stillness:** frames 812–899 have no motion except grain. The HUD is gone by 812.
- **Sync rule:**
  - Accents and foley must have a picture event on their frame.
  - The music bed (hats, bass, pad, sub, bells, arps) needs no picture event.
  - Visual events smaller than 8px get no dedicated SFX.
  - The running HUD timecode is exempt.

---

## 2. Shared system (package 9, delivered before any shot work)

### 2.1 Config and timeline

| Key | Value |
|---|---|
| `config.bpm` | 150 |
| `beatOffset` | 0 |
| `config.name` | 2–11 letters; default "NEKVIT" |
| `config.role` | default "Motion Design" |
| `config.year` | default "2026" |

The timeline follows §4.

### 2.2 Engine and post changes (`src/engine.js`, `src/post.js`, `src/glsl.js`, `src/text.js`)

**Transfer function.**
- `srgb2lin`/`lin2srgb` in glsl.js `common`, and `hexc()`, use the exact piecewise sRGB EOTF/OETF, not pow 2.2.
- `PAL_LIN` is the exact column of §1.2.
- `flashColor` stays sRGB-coded, because it is applied after the tonemap.
- Unit check: each token rendered as a flat full-frame fill with `?clean=1` must read back its exact hex.

**Tonemap 3 (PRINT):**
```glsl
vec3 tmPrint(vec3 c){ c=max(c,0.); float m=max(c.r,max(c.g,c.b)); if(m<=1.) return c;
  float w=smoothstep(1.,4.,m); return mix(c/m, vec3(1.,.955,.90), w); }
```
- The curve is C1-continuous at 1. w = 0.10 at 1.6, 0.50 at 2.5 and 1.0 at 4.
- Package 9 ships a swatch test frame (VERM, COBALT and BONE ramps at ×0.5 … ×6) before any HDR shot is tuned.

**`POST_DEFAULTS`:**
- `tonemap 3`
- `bloom 0`
- `bloomThreshold 1.05`
- `bloomKnee 0.1`
- `ca 0`
- `grain 0.03`
- `vignette 0.08`
- `hudAlpha 0.55`

Shots set only their deltas, every frame.

**Shake.** When distortion is 0, the composite samples with CLAMP_TO_EDGE instead of zeroing out-of-range uv, so no black strip appears at 480–484. Zeroing is kept only for barrel distortion.

**Motion blur (temporal supersampling).**
- A shot exports `mb(f)`, which returns a sample count N (0 = off).
- The engine calls `render()` N times at `s.t + ((k+0.5)/N − 0.5)·0.5/60` (shutter 0.5), accumulates in RGBA16F and averages. It then runs post once with the integer frame's params.
- Contract:
  - `s.f`, `s.t` and `s.local` may be fractional.
  - `s.frame` stays the integer frame.
  - All hashes, grain seeds and latched discrete states (flips, touches, plate pops) use `floor(s.frame)` or `floor(s.f)`.
- Stateful shots are exempt from supersampling: `flow` needs none, `field` draws streaks, and `volume` uses a velocity blur.

**Post continuity across cuts.**
- Each shot exports `postOut`: its post deltas at its final frame, as a constant object.
- The engine exposes `ctx.prevPost`:
  - During an overlap, it holds the params the outgoing shot set while rendering `prevTex` this frame. It becomes available once `s.prevTex` has been read.
  - At a zero-overlap cut, it holds the previous shot's `postOut` for the incoming shot's first 12 frames.
- The incoming shot sets every scalar param to `p = mix(ctx.prevPost.p, own.p, inOutSine(min(s.f/12, 1)))`.
- Exempt: flash, ca, shake, and the cut at 480, where the flash is the designed break.

**Canvas.** Never use `filter` on a full-frame canvas. It measured 270 ms per `fillText`.

**Text.** `ctx.text.font` registers Archivo wdth aliases at 0.25 steps over 100–125 (101 faces × 2 styles) and rounds a requested wdth to the nearest 0.25.

**`?clean=1`** sets grain, dither, vignette and paper fibre to 0. It is for acceptance renders only.

**HUD overlay** (engine-owned; shots never draw HUD elements)

Placement and style:
- It is drawn in the composite pass after tonemap, grain and vignette, and before dither. That keeps it out of the mattes, bloom, CA, distortion and shake.
- It comes from two small canvases (640×48), re-uploaded only when their text changes.
- JetBrains Mono 500, 18px·scale, uppercase, tracking +6%, opacity `hudAlpha`.
- **Bottom-left (L):** baseline at (60px, 1026px), showing the `FIG` label.
- **Bottom-right (R):** right-aligned at 1860px, showing SMPTE `HH:MM:SS:FF`.

Tone:
- The tone is a pure function of the frame. There is no luma readback, so it cannot flicker and is safe for isolated renders.
- Each transition eases over 4f from the listed frame, except at 468 and 480, which snap.

  | From f | 0 | 150 | 237 | 259 | 386 | 394 | 468 | 480 | 583 | 675 | 680 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | L | INK | BONE | INK | BONE | INK | · | BONE | INK | BONE | INK | · |
  | R | INK | BONE | INK | BONE | · | INK | BONE | INK | BONE | · | INK |

Type-on and changes:
- **Type-on:** f6–19, one character per frame. Each new character shows a hashed A–Z glyph for its first frame.
- **FIG re-resolve:** at 96, 168, 264, 384, 480, 576 and 672, the label re-resolves left to right at one character per frame (cued in §3). During the title touches, the label jumps to the touched station's label (§5.8), resolving in 3f.
- **Timecode:** runs from `00:00:00:00` and **freezes at `00:00:12:48` from f768**.
- **Type-off:** both labels delete right to left over 800–811. L deletes 1.5 characters per frame and R deletes 1. The HUD is empty from 812.

### 2.3 `src/shots/_sys.js` (pure and deterministic; every shot imports it)

**Palette and GLSL.**
- Exports `PAL`, `PAL_LIN` and `SYS_GLSL`.
- `SYS_GLSL` provides:
  - `INK BONE VERM COBALT GRAPHITE`
  - `KEY2 = normalize(vec2(-1,1))`, `KEY3`, `C_MOD = 1./18.`
  - `vec2 P(vec2 uv,float aspect)`, `float paperFibre(vec2 p)`, `float halftone45(vec2 p, float cellPx, float cover)`
  - `palDisperse`:
    ```glsl
    vec3 palDisperse(vec3 a, vec3 b){ // a: short-λ sample, b: long-λ sample
      vec3 avg=.5*(a+b); float d=luma(a)-luma(b); return max(avg+.5*d*(VERM-COBALT),0.); }
    ```

**Timing constants:** `F16=6, F8=12, BEAT=24, BAR=96`.

**`stationLetter(ctx,k)`:** the k-th letter of `config.name` (uppercased, letters only), taken modulo its length.

**`glyphSDF(ctx,ch)`**
- Cached result: `{tex, capPx:360, ox, oy, w, h, inkX0, inkX1, inkCx}`.
- Rasterized at Archivo 850/100 with 0.6 cap of padding, then passed through `ctx.text.sdfTexture`.
- `inkX0` and `inkX1` come from scanning the raster's alpha. Do not use `measureText`, which is loose and quantized.
- The GLSL helper `glyphD(tex, meta, q)` returns signed distance in **cap units**.
  - q is in cap units, measured from the pen origin on the baseline.
  - Outside the texture, clamp the sample and add the distance to its bounds.

**`placeGlyph(meta, cap, baselineY)`:** `q = (p.x/cap + inkCx, (p.y − baselineY)/cap)`, with the ink box centred on x = 0.

**`restY(meta, xCap, rCap)`**
- Returns the centre height (in cap units) at which a ball of radius rCap, dropped on the vertical line x = xCap, first touches ink.
- Method:
  1. Scan y from `1 + rCap` downward in steps of 0.001.
  2. Return the first y where `glyphD(xCap, y) ≤ rCap`.
  3. If nothing is found above 0.2, return `1 + rCap`.
- Starting at 1 + rCap means a ball wider than a notch rests on the notch's two top corners.
- `vNotchRest(meta, rCap) = restY(meta, meta.inkCx, rCap)`.

**`NOTCH = vNotchRest(glyphSDF(stationLetter(3)), 0.146)`**
- This is the single source for the dot or ball in the V.
- 0.146 is the ball radius in cap units: 0.073 H ÷ cap 0.50, which equals 0.146 wu ÷ cap 1.0.
- For Archivo V 850 it is ≈0.806–0.809.
- No shot may hard-code it.

**Volume camera constants** (shared by `lens` and `volume`)
- `VOL_FOV0 = 12°`, `VOL_D0 = 1/tan(6°) ≈ 9.514`.
- Eye height `VOL_EYE_Y = 0.6` wu; look-at `(0, 0.6, 0)`. So at f384, world (x, y, 0) maps to screen `0.5·(x, y − 0.6)`.
- Front-face scale: `S_FRONT = VOL_D0/(VOL_D0 − 0.146) ≈ 1.0156`.
- **`CAP_V2D = 0.5·S_FRONT ≈ 0.5078`** and baseline **`BASE_V2D = −0.30·S_FRONT ≈ −0.3047`**. This is the V's front face as `volume` projects it, scaled about the screen origin.
- **`NSTAR = (0, 0.5·(NOTCH − 0.6)) ≈ (0, 0.104)`**: the ball centre on screen, with r 0.073.

**`STEM`** (stem width ÷ cap for Archivo wdth 100, interpolated linearly between entries):

| wght | 100 | 200 | 300 | 400 | 500 | 700 | 850 | 900 |
|---|---|---|---|---|---|---|---|---|
| stem ÷ cap | .079 | .094 | .115 | .139 | .163 | .218 | .292 | .322 |

**`roleLayout(ctx)`** (H units)

Words of `config.role`:
- w1 is word 1.
- w2 is words 2 onward, joined with single spaces. For a one-word role, w2 is `null`.

| Element | Spec |
|---|---|
| **w1** | Uppercased, Archivo, cap 0.24, baseline 0, rest 500/100, **centred on its advance width**. Rest advance ≈1.404 for MOTION |
| **w2** | Lowercased, first `i` replaced by `ı`, Instrument Serif Italic, `fs = 0.24/0.72` H, baseline −0.30, **advance end aligned to w1's advance end** |
| **tittle** | `{x: x_ı + 0.2105·fs, y: −0.30 + 0.6575·fs, r: 0.0515·fs}`. For "Motion Design" ≈ (0.373, −0.081), r 0.0172 |
| **dotAlt** (no ı) | `{x: advEnd + 0.05·fs, y: baseline + 0.07·fs, r: 0.0515·fs}`, placed after w2, or after w1 on baseline 0 when w2 is null |

Every consumer uses **`T_DOT = roleLayout.tittle ?? roleLayout.dotAlt`**.

**`nameLayout(ctx)`**

The name:
- `config.name` uppercased, set in Archivo 850/100, with kerning from `ctx.text.layout`.
- Baseline `y_b = +0.02`.
- **Cap:** `cap = min(0.20, 0.20·1.45/blockW)`, where blockW is measured at cap 0.20. NEKVIT measures 1.21, so its cap is 0.20. Every value below scales with cap.

| Element | Values |
|---|---|
| **dot** (full stop) | `{x: penEnd + 0.2375·cap, y: y_b + 0.17·cap, r: 0.17·cap}` |
| **Block** | Runs from the first glyph's ink-left edge to `dot.x + r`, centred on x = 0. Per glyph: `{ch, penX, inkL, inkR, cx}` |
| **S0** (dot start) | `{x: inkLeft − 0.375·cap, y: y_b + 0.17·cap}` |
| **rule** | `{y: y_b − 0.425·cap, x0: inkLeft, x1: dot.x + r, w: 4px}` |
| **role** | Instrument Serif Italic, cap 0.275·cap, baseline `y_b − 0.9·cap`, left edge at inkLeft |
| **year** | Archivo 500/125 tabular, cap 0.20·cap, baseline `y_b − 0.9·cap`, right edge at `dot.x + r` |
| **yTouch[i]** | `y_b + cap·restY(glyph_i, cx_i in cap units, r/cap)`: the dot centre at contact. In the V it drops into the notch at ≈0.89 cap |
| **Touch schedule** | For n letters, interval `Δ = 3·max(1, ⌊10/(n−1)⌋)` frames; touch i is at `720 + i·Δ`. For NEKVIT, Δ = 6, so touches run 720…750 |

Check values for NEKVIT (kerned, K–V −55 units):
- inkLeft ≈ −0.623
- dot ≈ (0.589, 0.054)
- S0 ≈ (−0.698, 0.054)
- rule y −0.065
- role baseline −0.16

**`paperZ(frame) = 1 + 0.0004·min(frame, 168)`**: the paper push shared by `point` and `line`.

**`FIG`** labels:
`['FIG. 0 — POINT','FIG. 1 — LINE','FIG. 2 — PLANE','FIG. 3 — LENS','FIG. 4 — VOLUME','FIG. 5 — FLOW','FIG. 6 — FIELD','FIG. 7 — FULL STOP']`

Station k (letter k) maps to `FIG[k+1]`.

### 2.4 Protocols

**Alpha**
- The engine clears the target to (0,0,0,1). Every shot leaves alpha at 1, **except `flow`**.
- `flow`'s final unblended pass writes the ink matte into alpha. Every blended draw in `flow` uses `colorMask(1,1,1,0)`.

**Tails** (rendered past a shot's end as `prevTex` for the next shot; motion stays alive):
- `lens` renders 384–395.
- `flow` renders 576–587.
- `field` renders 672–683.

**Determinism**
- Use no `Math.random`, `Date` or wall-clock time. Use hashes and the seeded rng only.
- `flow` and `field` are stateful and replay from their first frame with a fixed dt of 1/60.

**Budget**
- ≤2.5 s steady-state sequential time per frame. This includes motion-blur samples, any outgoing shot rendered as `prevTex`, and post (≈0.34 s).
- An isolated render of a stateful frame gets a separate replay allowance of ≤20 s.

---

## 3. Music and sound

**Tempo and grid:** 150 BPM, 4/4, F minor.

| Unit | Frames |
|---|---|
| Beat | 24f |
| 8th | 12f |
| 16th | 6f |
| 32nd | 3f |
| Bar | 96f |

- At 48 kHz, 1 frame = 800 samples and 1 beat = 19,200 samples.
- Bar starts: 1:0 · 2:96 · 3:192 · 4:288 · 5:384 · 6:480 · 7:576 · 8:672 · 9:768 · 10:864, which ends at 900.

**Genre:** dry editorial "graphic bass": a halftime groove, UI foley and FM bells. The sync rule of §1.5 applies: accents and foley need a picture event, and the bed does not.

### Voices (procedural JS DSP, offline, seeded PRNG)

**Drums**

| Voice | Recipe |
|---|---|
| KICK | Sine; pitch 150→45 Hz (τ 40 ms), amplitude 180 ms, 2 ms click |
| SUB/808 | Sine with glide. F1 = 43.65 Hz, F2 = 87.31 Hz |
| SNARE/CLAP | Three noise bursts 10 ms apart, band-passed at 1.2 kHz, plus a 190 Hz body; 2.4 s plate |
| HAT | High-passed noise at 8 kHz; closed 30 ms, open 120 ms |

**Tonal**

| Voice | Recipe |
|---|---|
| REESE | Two saws detuned ±9 cents, LP 900 Hz, sidechained to the kick (−8 dB, 120 ms) |
| FM | 2-operator. Glass: ratio 1:2, index 4→0.5. Metallic: ratio 1:2.76 or 1:3.5 |
| **DOT** | The dot's only voice: FM pluck at ratio 1:2, index 3→0.3, 80 ms, pitch ×0.7 over 60 ms. Successive hops walk through the signature notes |
| PAD | Six saws detuned ±12 cents, LP 1.8 kHz, 60 ms attack |

**Effects and textures**

| Voice | Recipe |
|---|---|
| FX | Swept band-pass noise for whooshes, zips and risers; Shepard tone from 6 octave-spaced sines |
| GRAINS | Hashed sine grains, Hann window, 20–60 ms |
| TICK | 3 ms noise click plus a 15 ms pitched sine |

**Space and master**

| Stage | Recipe |
|---|---|
| Reverb | Convolution with a generated, exponentially decaying stereo noise IR (1.8 s, 12 ms predelay) |
| Master | 2:1 glue compressor, then a −1 dBTP limiter, about −14 LUFS integrated |

**Pitch reference:**

| Note | Hz |
|---|---|
| F4 | 349.23 |
| G4 | 392.00 |
| Ab4 | 415.30 |
| Bb4 | 466.16 |
| C5 | 523.25 |
| Eb5 | 622.25 |
| F5 | 698.46 |
| Ab5 | 830.61 |
| C6 | 1046.5 |
| Eb6 | 1244.5 |
| F6 | 1396.9 |

**Hard gates (the two vacuums are digital zero)**

After the limiter, the master is multiplied by a gate:

| Gate | Samples | Frames |
|---|---|---|
| G1 | 297,600–307,199 | f372–383 |
| G2 | 374,400–383,999 | f468–479 |

- Each gate closes with a 2 ms cosine fade that finishes on the boundary sample (297,599 or 374,399). It reopens hard on 307,200 or 384,000.
- The limiter's lookahead buffer is flushed at every gate edge.
- One dry foley event is inserted **after** the gate on each vacuum's first frame:
  - the wood tock at 372 (≤15 ms)
  - the relay-off click at 468 (3 ms)
- Every other sample inside a gate is exactly 0.
- The pad, the sub swell, all bells and all reverb sends end at 468.

**HUD ticks**
- HUD type-on (6–19) and every FIG re-resolve (96, 168, 264, 384, 480, 576, 672): one mono TICK per character at −32 dB.
- HUD type-off (800–811): one tick per frame at −36 dB.

### Cue list (frame-exact)

**Bar 1 (f0–95): intro, `point`**

| f | Picture | Sound |
|---|---|---|
| 0 | Dot born; crosshairs snap in | Sub pop 110→44 Hz (140 ms), soft kick (LP 2 kHz), and a 1 kHz blip (20 ms) |
| 0–84 | The crosshair circles' notches step 45° on every 8th | Rim tick on every 8th at −30 dB |
| 6–19 | HUD types on | HUD ticks |
| 24 | Grid reveal | 2→8 kHz sine zip over 12f |
| 24, 30 | Heartbeat, two pulses | 55 Hz thumps |
| 48, 50, 52, 54 | Children depart TR, TL, BL, BR | DOT plucks F5, Ab5, C6, Eb6, panned by x |
| 54–78 | Ripple pops | 32 pops on F minor pentatonic (F5–C7). They get denser with the ripple front and pan by x |
| 72, 78, 84, 90 | Dots breathe | Closed hats |
| 84–96 | Flood | Reverse cymbal ending exactly at 96 |

**Bars 2–3 (f96–263): groove, `line` and `plane`**

| f | Picture | Sound |
|---|---|---|
| 96 | Shadow plate prints | Kick, clap, and reese on F1. Plate thud (LP noise plus a 90 Hz body, 60 ms) |
| 102, 108 | Face plate, ground plate | Plate thuds, the second brighter, the third brightest |
| 96–191 | Groove (bed) | Halftime: kicks at 96, 132 and 168; snare at 144; hats on 8ths |
| 120 | Dots stretch into lines | FM glide C4→F4 over 10f |
| 132, 138 | Row wave pulses | Reese LFO wobble, one swell per pulse |
| 144–166 | Collapse | A saw falls F4→F2 into a thin F5 sine hum at −30 dB |
| 168 | Slit | "Shhk" (band-passed noise at 3 kHz, 80 ms) plus a pickup kick |
| 172, 176, 180 | Top, middle, bottom arm open | Tape swishes panned left, centre, right |
| 174 | Stem wipes in | Wood clack |
| 192 | Bar 3 | Kick and clap. 16th hats start. FM bass on 16ths; its LP opens from 300 Hz to 3 kHz over 192–288, sidechained |
| 192, 198, 204, 210 | Scanlines print the passes (top, middle, bottom, stem) | Print zip: band-passed noise 2→6 kHz, 90 ms, panned left to right, −16 dB |
| 216 | Re-layout | Short Fm stab plus a tom |
| 234–240 | Merge wipe | Tape-wipe swish panned left to right, landing in the snare at 240 |
| 252, 255, 258 | Top, middle, bottom collapse to hairlines | Sine tinks C6, Eb6, F6 |
| 252 | Dot leaves for the tittle | DOT pluck F5 with a sine tail gliding 400→900 Hz to 261 |

**Bar 3 beat 4 to bar 4 (f264–383): the build, `lens`**

| f | Picture | Sound |
|---|---|---|
| 264–269 | Paired glyphs rise, one per row per frame | Six paired typewriter ticks rising in pitch. First-word row panned left, second-word row panned right |
| 264–276 | Top hairline retracts | Hiss panned centre to right |
| 276 | The ı arrives under the dot; dot squashes | Crisp click plus an F6 ping |
| 288 | Weight wave | Kick. Ticks at 288, 290, 292, 294, 296, 298 on F4, G4, Ab4, Bb4, C5, Eb5. A low stretch whoosh |
| 288–359 | Groove (bed) | Kicks at 288, 312, 336; clap at 312; 16th hats |
| 300–312 | K swings in | High-Q whoosh (band-pass Q 12, sweeping 6 kHz to 1.2 kHz) panned right to centre |
| 312 | K lands; shockwave | Glass clink (FM 1:2.76 on C6). Sub drop 60→30 Hz over 250 ms. 8-bit noise burst of 60 ms |
| 336, 342, 348, 351, 354, 357 | Serif flips M-O-T-I-O-N (latching) | Snares on those frames and a 20 ms bitcrush glitch on each flip. Noise riser plus Shepard tone from 336 to 372 |
| 357–360 | Dot anticipation squash | — |
| 360 | Dot takes off | DOT pluck Ab5. 32nd gate on the riser and a −12 semitone pitch dive over 360–372 |
| 360–365 | Type drops through its slots, right to left | Six reverse typewriter ticks |
| 364 | Stem slot cut | Short "shhk", a callback to 168 |
| 364–370 | Hairlines retract | Hiss |
| 372 | Dot lands in the V | Wood tock (dry, post-gate) |
| 372–383 | Glass V alone | **G1: digital zero** |

**Bar 5 (f384–479): the breath, `volume`, drums out**

| f | Picture | Sound |
|---|---|---|
| 384 | Lights on; sheet sweep over 384–396 | Relay click and 50 Hz thump. Band-passed noise 0.8→5 kHz, panned left to right over 12f. Fm9 pad enters (F2, C3, Ab3, Eb4, G4) |
| 396–456 | Breath (bed) | Glass bells on 8ths: 396 F4, 408 Ab4, 420 C5, 432 Eb5, 444 C5, 456 Ab4. From 428 the pan follows the camera yaw. F1 sub swell from 420 |
| 452 | Ball lifts out of the notch | DOT pluck C6 plus a sine glide F5→C6 over 452–464 |
| 456–468 | Build to the vacuum | Reverse-reverb riser ending at 468 |
| 468 | Blackout (key and ambient cut) | Relay-off click (3 ms, dry, post-gate) |
| 468–479 | Hold (to 474) and fall (474–479) in the dark | **G2: digital zero** |

**Bar 6 (f480–575): the drop, `flow`**

| f | Picture | Sound |
|---|---|---|
| 480 | **Drop**: flash, burst, scale punch | Kick. 808 glide F2→F1 over 300 ms. Noise crash. Wet splat: noise with LP sweeping 8 kHz→300 Hz over 150 ms |
| 480–575 | Groove (bed) | Kick on every beat; claps at 504 and 552; 16th hats; reese alternating F1 and Ab1 |
| 480, 504, 528, 552 | Wall pumps | Wet thump on the kick (LP sweep 2 kHz→200 Hz, 80 ms) |
| 492, 516, 540 | Ink pours | Bloop (sine 800→200 Hz, 90 ms) plus 20 bubbly grains |
| 552–575 | Rupture | Snares at 552 and 558, then 564, 567, 570, 573. Pitch and LP rise |
| 564–576 | Flood front | Two-band splash whoosh |

**Bar 7 (f576–671): drop 2, `field`**

| f | Picture | Sound |
|---|---|---|
| 576 | **Drop 2**: full-width VERM slash | Kick and F1 sub. Two high-passed noise zips, one hard left and one hard right, over 576–579. Fm stab. **No crash** |
| 579–585 | Slash shatters into grains | Glitter burst: 120 grains at 4–10 kHz spreading from the edges to the centre |
| 576–647 | Groove B (bed) | Kicks at 576, 600, 624, 648; claps at 600 and 648. Glitter grain bed. FM pluck arp on F minor pentatonic 16ths with a 3/16 ping-pong delay (18f) |
| 600 | Peel begins; the comet launches | 300 grains at 2–8 kHz, panned from the edges toward the centre. DOT pluck C6 |
| 624 | Lattice snap | Dry metallic snap (FM 1:3.5, 40 ms) on the kick, plus a sidechain pump |
| 636–672 | Converge | Reverse granular swell rising in pitch. Tape-stretch over 648–672. Drums out after 648 |
| 660 | Comet lands at S0 | Quiet DOT pluck F5 |

**Bars 8–10 (f672–899): title, `full-stop`**

| f | Picture | Sound |
|---|---|---|
| 672 | Name resolves (dissolve over 672–684) | Soft Fm(add9) chord with no kick. Granular fizz sweeping left to right over 672–684 |
| 672–767 | Reading time (bed) | F1 sub and pad |
| 708 | Dot squashes at S0 | Soft "tuck" (felt thump, LP 400 Hz, 40 ms) |
| 712 | Hop to the first letter | DOT pluck F4 |
| 720 + i·Δ (for NEKVIT: 720, 726, 732, 738, 744, 750) | Touches; windows open; HUD label jumps | **Signature:** FM bells F4, Ab4, C5, Eb5, F5, C6 (ratio 1:2, 1.2 s), cycling for longer names. Each has a 3 ms touch click and is panned by glyph x |
| 754 | Final hop takes off | DOT pluck C6 plus a reverse crash that ends at 768 |
| 768 | **Final hit**: landing, weight slam, windows shut, ring | Kick, F1 sub, crash, and a full Fm(add9) stab. Landing thock. Four shutter clicks over 768–771 |
| 768–780 | Rule zips right to left | 3→6 kHz zip panned right to left, a callback to the f24 zip |
| 792–812 | Role line prints in | Air swell (band-passed noise at 1.5 kHz, 20f) plus an F6 harmonic |
| 792, 795, 798, 801 | Year digits type on | Four ticks |
| 800–811 | HUD types off | HUD ticks |
| 812–899 | Poster | Reverb tail. Room tone at −60 dB from 840. Fade from 870 to digital silence at 899 |

---

## 4. Shot table

| # | id (`src/shots/<id>.js`) | Frames [start,end) | Len | Overlap (incoming composites prevTex) | Station / HUD |
|---|---|---|---|---|---|
| 1 | `point` | 0–96 | 96 | 0 (hard match) | FIG. 0 — POINT |
| 2 | `line` | 96–168 | 72 | 0 (inversion cut) | name[0] (N) · FIG. 1 — LINE |
| 3 | `plane` | 168–264 | 96 | 0 (line match) | name[1] (E) · FIG. 2 — PLANE |
| 4 | `lens` | 264–384 | 120 | 0 (hairline and dot match) | name[2] (K) · FIG. 3 — LENS |
| 5 | `volume` | 384–480 | 96 | **12**: light-sheet wipe over prevTex | name[3] (V) · FIG. 4 — VOLUME |
| 6 | `flow` | 480–576 | 96 | 0 (the one flash) | name[4] (I) · FIG. 5 — FLOW |
| 7 | `field` | 576–672 | 96 | **12**: ink-matte wipe plus cell dissolve | name[5] (T) · FIG. 6 — FIELD |
| 8 | `full-stop` | 672–900 | 228 | **12**: halftone-cell dissolve | name · FIG. 7 — FULL STOP |

- **Package 9** covers `_sys.js`, the engine and post changes, the HUD, the timeline and config, and the audio.
- Each overlap resolves on an 8th: 396, 588 and 684.
- Every shot exports `mb(f)` and `postOut`.

---

## 5. Shots

### 5.1 `point`: FIG. 0 POINT [0,96)

**Hero:** the dot multiplies into a field. **Supporting beats:** the grid (f24) and the flood (f84).

All content is drawn in paper space, `q = p / paperZ(frame)`. **Layer order:** paper → grid → crosshairs → dots.

**Beats**
- **f0:** Bone paper with fibre.
  - The dot is a VERM disc, r 0.11, at q = (0,0). Its scale is `spring(t + 5/60, 3.0, 0.48)`, a 5f pre-roll. **Frame 0 already shows the dot at ≈0.62 scale**, and it peaks at ≈1.18 around f6.
  - Four registration crosshairs snap in at q = (±0.80, ±0.42) with outExpo over 4f. Each is Ink at 1px, with 24px arms and an 8px circle.
  - Each circle carries a 4px notch tick that steps 45° on every 8th (0–84): the print clock.
- **f22–40, heartbeat (two pulses):**
  - 22–24: squash to sx 1.12, sy 0.88.
  - 24–27: stretch to 0.90 / 1.10.
  - 28–30: squash to 1.05 / 0.95.
  - 30–33: rebound to 0.97 / 1.03.
  - Spring back to rest by 40.
- **f24, grid:**
  - Minor lines: Ink at 12%, 1px.
  - Every 4th line: Ink at 28%.
  - Lines reveal inside a radius `R = 2.0·outExpo((f−24)/12)` around the origin.
- **f48, mitosis:**
  - The children depart at **48, 50, 52 and 54** (TR, TL, BL, BR). Each moves from the origin to (±c/2, ±c/2) with outBack over 8f, at radius 0.30c.
  - Each child is joined to the mother with `smin`, using `k_i = 0.06·(1 − e_i)`, so it visibly pinches off.
  - **The mother shrinks to 0 by 58** (outExpo from 48).
- **f54–78, ripple:**
  - Every cell-centre dot pops with `spring(4, 0.45)` as the front `R_f = 1.1·(f−54)/24` passes.
  - Radius: `r = c·(0.30 + 0.12·cos(2π(|q|/0.22 − (f−54)/24)))·pop`.
  - The four children join the formula, easing to it over 54–60.
- **f72, f78:** radii ×(1 + 0.08·pulse) on the hats.
- **f84–95, flood:**
  - All radii grow to 0.72c with outExpo over 11f.
  - The Bone gaps shrink into four-point stars that die on the module corners by 95.
  - The dots occlude the grid and the crosshairs, so nothing fades.

**Camera:** the paper push only.

**Build:** one fragment pass.
- 3×3 neighbour cells plus 5 analytic discs.
- `aastep` for antialiasing.
- The grid uses `fract` plus `fwidth`.

**MB:** 6 on 0–12, 22–40, 48–62 and 84–95; 0 elsewhere.

**IN (f0):** Bone paper, the dot at ≈0.62 scale, and the crosshairs starting their snap.

**OUT (f95):** uniform VERM. No marks, no grid, no crosshairs.

**Post:** defaults (vignette 0.08). `postOut = {}`.

**Perf:** under 80 ms per sample.

### 5.2 `line`: FIG. 1 LINE [96,168), station 0 (N)

**Hero:** dots print the letter as plates, become engraved lines, then collapse into one horizon. Paper space continues.

**The letter**
- `stationLetter(0)` at **cap 1.10** in paper units, baseline −0.55, so it bleeds off the top and bottom.
- **Ink-centred at x = −0.18.**
- Darkness D is set per module corner (k·c, j·c):

  | Region | D |
  |---|---|
  | Ground (outside) | 0.10 |
  | Front face | 0.46 + 0.10·(u.x − u.y), where u = (q − inkCentre)/1.10 |
  | Extrusion (inside the glyph shifted by t·(+0.12, −0.12) for t = 1/8 … 8/8, but outside the front face) | 0.92 |

- The extrusion goes **toward the lower right**, the shadow side of the upper-left key.
- D is box-filtered over a 2×2 subsample per cell, so edge cells get intermediate dot sizes.
- Dot radius is `r = 0.56c·√D`.

**Beats**
- **Plates on 16ths:**
  - The shadow plate (the D = 0.92 cells) prints at **96**, the face plate at **102**, and the ground plate (D = 0.10) at **108**.
  - Each plate's dots pop with `spring(4, 0.5)` plus a hashed 0 or 1f delay per cell.
  - Before its plate prints, a cell is bare VERM.
  - The N reads cleanly from **110 to 144**.
- **f120–130, lines:**
  - Dots stretch into horizontal capsules; their half-length grows from 0 to c/2 with outQuint over 10f.
  - They fuse into 19 rows at y = j·c, with **zero displacement**.
  - Row thickness blends to a per-pixel value of `2·0.56c·√D(x, j·c)`, which looks like banknote engraving.
- **Row wave:**
  - Rows are displaced by `A(f)·sin(2π(x/0.9 − (f−120)/24))`.
  - `A(f) = 0.18c·(b(f−132) + b(f−138))`, where `b(u) = sin(πu/6)` for 0 ≤ u ≤ 6 and 0 otherwise.
  - **A = 0 from 144**, so the rows are straight for the collapse.
- **f144–166, collapse:**
  - Rows with |j| ≥ 2 swell to thickness c with outExpo over 6f each. Row |j| starts at `144 + 2·(9−|j|)`, so the outermost rows go first.
  - Rows ±1 swell until their inner edges sit at y = ±3px in **screen** space, by 166.
  - Row 0 thins to 0 over 150–162.
- **f166–167:** hold.

**Camera:** the paper push continues. The final band is resolved in screen space.

**Build:** one fragment pass.
- D is precomputed at init into a 33×19 corner texture and a 1920×19 per-row texture, so the extrusion taps and subsamples run once, not per pixel.
- Per pixel: 3×3 neighbour corners, capsule SDFs, and `aastep`.

**MB:** 6 on 96–114, 120–130 and 132–166.

**IN (f96):** VERM with the first shadow-plate Ink dots popping. This is the inversion of `point`'s dying stars.

**OUT (f167):** INK everywhere, except a VERM band |y| ≤ 3px (screen space) across the full width, perfectly straight.

**Post:** defaults. `postOut = {}`.

**Perf:** under 40 ms per sample.

**Fallback:** works for any letter.

### 5.3 `plane`: FIG. 2 PLANE [168,264), station 1 (E)

**Hero:** an E-shaped window shows one composition as three render passes. **Supporting beats:** the scan-in (192–210), the re-layout (216) and the merge (234–240).

**Window geometry** (screen space; the union boundary carries a 3px VERM rim)
- **Stem:** x ∈ [−0.889, −0.60], y ∈ [−0.41, 0.41], bleeding off the left edge.
- **Arms:** each starts at x = −0.60 and ends like a letter stroke.
  - The top arm (y_arm +0.30) and bottom arm (y_arm −0.30) end at x = **+0.60**.
  - The middle arm (y_arm 0) ends at x = **+0.46**.
  - Half-height 0.11.
  - Each arm end is a window edge with the rim.

**Beats**
- **f168:** the horizon becomes three 3px VERM lines, centred at y = +1.5px, 0 and −1.5px. Their union is exactly the 6px band. The outer two fly to y = ±0.30 with outExpo over 10f.
- **172 (top), 176 (middle), 180 (bottom):** each line opens into its arm window. The half-height grows from 0 to 0.11 with outExpo over 12f. The line's ends slide in to the arm's extent, and the line becomes the arm's rims.
- **174:** the stem wipes in from the left edge with outExpo over 10f.
- Until its scan, a window shows only its pass ground and tag.
- **192 (top), 198 (middle), 204 (bottom), 210 (stem):** a 3px VERM vertical scanline sweeps across the window from left to right over 6f (outQuint). Behind the scan front, the pass renders in.
- **f216, re-layout** (`spring(3, 0.5)`):
  - The dot moves to (0.05, 0).
  - The bar rotates from −30° to +15° with outBack.
  - The ring moves up one module.
  - The dot grid shifts one module to the right.
- **234–240, merge** (all inOutQuint unless stated):
  - Every window's half-height grows to 0.26, and every arm's extent grows to the full width [−0.889, +0.889] (outExpo over 6f).
  - Each arm's `y_arm` eases to 0.
  - A vertical wipe edge with a 3px VERM rim sweeps x from −0.889 to +0.889. It turns CONTOUR and MATTE into BEAUTY and removes the tags.
  - Draw order is stem > bottom > middle > top. Rims appear only on the union boundary, so at 240 there are none.
  - **240 (snare): full-frame BEAUTY.**
- **240–252:** hold (12f). The truck continues.
- **252 (top), 255 (middle), 258 (bottom), collapse:**
  - Window k's half-height shrinks from 0.26 to 1px around y_k (+0.30, 0, −0.30) with outExpo over 5f. The collapses finish at 257, 260 and 263.
  - When its collapse starts, the window's rims switch to 1px BONE.
  - Once its half-height is under 3px, its interior is flat BONE.
  - The result is a 2px BONE hairline across the full width. Outside the windows: INK.
- **252–258:** the stem slides out, x −= 0.30 (inQuint).
- **252–261, dot:** at 252 the dot detaches from the composition at ≈(−0.118, 0) and is drawn above everything. It glides to `T_DOT` (inOutQuint) and shrinks from r 0.16 to `T_DOT.r`.

**Composition** (Bone paper, in window space)

Every window samples `w = (p.x + 0.12·(f−168)/60, p.y − y_arm)`.
- This is **one shared linear truck at 0.12 H/s**, so elements cross the arm gaps in perfect registration.
- y_arm is +0.30, 0 and −0.30 for the arms and 0 for the stem.

Elements:
- **The dot:** VERM, r 0.16, at (0.34, 0).
- **Cobalt column:** x ∈ [−0.30, −0.05], sheared 15°.
- **Ink bar:** 0.70×0.03, corner radius 0.004, through (0, 0.02), at −30°.
- **Ink dot grid:** 7×7, r 0.006, pitch c, centred at (−0.55, 0).
- **Ink ring:** centre (0.70, −0.02), r 0.09, width 0.006.

**Passes**

| Window | Pass | Look |
|---|---|---|
| Top arm | CONTOUR | Bone ground. Ink 1px isolines of the union SDF (period 1/28 H) plus a 2px Ink zero line. The dot's isolines are 3px VERM |
| Middle arm | MATTE | Ink ground. Flat silhouettes: dot VERM, column COBALT, everything else BONE |
| Bottom arm + stem | BEAUTY | Bone paper and flat fills. A hard (+6, −6)px shadow rendered as a 45° Ink halftone (8px cells, 35% coverage). A 2px BONE highlight line on edges where dot(n, KEY2) > 0.6, antialiased with fwidth. No soft shadow, no bevel gradient |

**Tags**
- Text: `CONTOUR`, `MATTE`, `BEAUTY`.
- JetBrains Mono 500, cap 0.016, at 80% opacity, in whichever of Ink or Bone contrasts with the pass ground.
- Placed at x = −0.58, 0.02 below each arm's top edge.
- They appear with their arm and leave with the merge wipe.

**Camera:** static. The truck is the only motion.

**Build:**
- One full-resolution pass, with the shader chosen by window ID. The window rects are passed as uniforms.
- Tags are drawn to a canvas once, at init.

**MB:** 6 on 168–192, 192–216, 216–230 and 234–263.

**IN (f168):** identical to `line` OUT.

**OUT (f263):** INK, three 2px BONE hairlines at y = +0.30, 0 and −0.30 across the full width, and a VERM disc at `T_DOT` ≈ (0.373, −0.081), r 0.0172. Nothing else.

**Post:** defaults. `postOut = {}`.

**Perf:** about 60 ms per sample.

**Fallback:** for another letter:
- The windows are the interior of `glyphSDF(stationLetter(1))` at cap 0.82, ink-centred.
- Passes are assigned by band: y > 0.15 is CONTOUR, |y| ≤ 0.15 is MATTE, y < −0.15 is BEAUTY.
- The merge dilates the glyph SDF until it covers the frame by 240.
- The collapse to three hairlines is unchanged.

### 5.4 `lens`: FIG. 3 LENS [264,384), station 2 (K)

**Hero:** a glass K refracts kinetic type. **Supporting beats:** the weight wave (288), the latching serif flips (336–357) and K→V (360). The dot waits for its letter, becomes the tittle, then hops into the V.

Layout comes from `roleLayout`. Type is BONE on INK.
- Row 1 is w1, on the y = 0 hairline.
- Row 2 is w2, on the y = −0.30 hairline.

**Beats**
- **f264:** the top hairline retracts: its left end moves to +0.889 with outExpo over 12f.
- **264–269, rows rise:**
  - Glyph k of **each** row starts at 264 + k, so both rows start together.
  - Each glyph rises from dy −1.3·0.24 to 0 with outExpo over 14f, through its hairline.
  - The mask is `y > lineY − 0.30·0.24·e`. The line acts as a slot, and descenders are admitted once the glyph is at rest.
  - **Override: the ı always starts at 267**, so it is within 4px of rest at 276.
- **f276, tittle click:** the dot has waited at `T_DOT` since 261. It squashes over 276–278 (sx 1.2, sy 0.8) and springs back.
- **f288, weight wave:**
  - For each w1 glyph i, `τ = t − i·2f` and `a = spring(τ, 3.5, 0.45) − spring(τ − 8f, 3.5, 0.45)`.
  - `wght = 500 + 400a` and `wdth = 100 + 25a` (in 0.25 steps), clamped to the axis limits.
  - Per-glyph fonts are re-measured every frame and the word is re-centred on its advance width, so it physically shoves outward.
  - At the peak the word is ≈1.9 H wide, and the first and last glyphs crop hard at the frame edges. It returns to rest by about 310.
- **300–312, glass K:**
  - The glyph is `stationLetter(2)`, cap 0.50, baseline −0.30.
  - Its ink-box centre is at **X = 0.40 + 1.00·(1 − spring(t − 300f, 2.4, 0.62))**, with rotation −14°·(1 − spring).
  - It comes to rest at x = +0.40, **sitting over the tittle**, so the dot's VERM/COBALT split is visible at rest.
- **f312, shockwave** from O_K:
  - To find O_K, scan at q.y = 0.5 cap from inkR leftward until `glyphD ≤ 0`. For Archivo K 850 this lands at q.x ≈ 0.824, the arm/leg crotch. If nothing is hit before inkCx, use the ink-box centre.
  - The background (type, hairlines and dot) is displaced by `0.012·sin(40(r−R))·exp(−60(r−R)²)·exp(−(f−312)/10)`.
  - `R = 1.4·(f−312)/60`.
- **336, 342, 348, 351, 354, 357, latching serif flips:**
  - Call these six frames F. w1 glyph k flips at `F[⌊k·6/n⌋]` when n ≥ 6, or at `F[round(k·5/(n−1))]` when n < 6. For MOTION the flips go M, O, T, I, O, N in order.
  - On its flip frame, the glyph shows a single negative frame: a Bone advance cell with an Ink glyph.
  - From the next frame on, it is **permanently** Instrument Serif Italic uppercase at cap 0.24.
  - After each flip the word re-measures and re-centres with outExpo over 4f, so it contracts in rhythm.
  - By 358 the word has changed voice from grotesk to serif.
  - The glint pulses on 16ths.
- **357–360:** dot anticipation squash. **360:** takeoff.
- **360–367, type exits:** glyphs drop back through their baseline slots (inExpo, 8f, staggered 1f right to left, both rows).
- **364–370:** the middle and bottom hairlines retract: their left ends move to +0.889 with inExpo.
- **360–372, K→V:**
  - **360–368** (inOutBack, s 1.3):
    - The K rotates +90° CCW **about its arm/leg junction J = O_K**, while J translates to the V's vertex (0, BASE_V2D).
    - The K's scale goes from cap 0.50 to CAP_V2D.
    - The K travels from x +0.40 to 0.
    - Rotated this way, its arm and leg already form an upward V.
  - **364–368:** the now-horizontal stem is cut away by a slot mask sweeping from its ends toward J (`smax`, with a 3px VERM rim).
  - **364–372:** the arm angles blend into the V's with a front that travels from the arm tips down to J: `d = mix(d_Krot, d_V, smoothstep(y_front + 0.02, y_front − 0.02, y))`. There is no global SDF mix.
- **Dot hop, 360–372:**
  - A parabola from `T_DOT` to **NSTAR**, with its apex 0.10 above the higher end.
  - The radius grows from `T_DOT.r` to 0.073 with outQuint.
  - It lands at 372, squashes to 1.25/0.8, and is back to rest by 378.
- **372–383, silence:** the glass V, with the flat VERM dot in its notch. One slow glint travels down the left bevel.

**Glass shader**
- Bevel height: `h = smoothstep(0, .035, −d)`, with d in H. Normal: `n = normalize(vec3(−∇h·0.9, 1))`.
- Dispersion:
  - Take two background samples at `K_c + (p − K_c)/1.3 + n.xy·0.035·(1 ± 0.15)`, about ±6px at the bevel, and combine them with `palDisperse`.
  - The dot is evaluated as an SDF at both offsets. Its leading crescent paints VERM and its trailing crescent paints COBALT.
- Schlick Fresnel with F0 0.04 against an analytic environment: a vertical GRAPHITE→BONE gradient with a soft upper-left highlight peaking at ≤2.0.
- An 8% COBALT Beer–Lambert tint, driven by h.
- Glint: `h·(1−h)·4·exp(−((dot(p − K_c, normalize(vec2(0.55, −0.70))) − s)/0.02)²)·1.8`.
  - Over 336–360, s sweeps the glyph's extent along that axis once per 16th.
  - In the tail (372–395), s runs linearly once, masked to n.x < 0.

**Camera:** none. The shot is orthographic 2D and static.

**Build:**
- A full-resolution Surface, redrawn per sample with per-glyph fonts.
- One lens pass: type texture, analytic hairlines, the dot's SDF, the shockwave, and the glass from `glyphD` of the K and V.

**MB:** 6 on 264–282, 288–320 and 336–378; 0 in the tail.

**IN (f264):** identical to `plane` OUT.

**OUT (f383, and the tail through 395):**
- Ink ground.
- The 2D glass V at `CAP_V2D`, baseline `BASE_V2D`, ink-centred on x = 0, showing only its Fresnel rims, bevel highlights and Cobalt tint.
- The flat VERM disc, r 0.073, at **NSTAR ≈ (0, 0.104)**.
- In the tail, only the glint moves.

**Post:** bloom 0.25, vignette 0.12, eased in from plane's 0.08 over 264–276 (§2.2). No post CA or distortion. `postOut = {bloom: 0.25, vignette: 0.12}`.

**Perf:** about 170 ms per sample (Surface 76 ms plus the lens pass); ≤1.4 s on MB frames, including post.

**Fallback:** for any pair of letters:
- J is O_K of name[2], or the ink-box centre if there is none.
- The slot cut removes whatever lies below J after the rotation.
- The front blend handles the rest.

### 5.5 `volume`: FIG. 4 VOLUME [384,480), station 3 (V). The breath.

**Hero:** the flat glass V is revealed as a solid in a lit studio, and the dot inflates into a ball through light alone. **Supporting beats:** the dolly zoom, the orbit to edge-on (where the V and the ball read as a lowercase "i"), and the blackout.

**World** (world units, wu)
- **The V:** `glyphSDF(stationLetter(3))`, extruded.
  - Cap 1.0, baseline on the floor at y = 0, ink-centred at x = 0.
  - Depth z ∈ ±0.146. The total depth of 0.292 equals the 850 stem width.
  - Edge rounding 0.012.
- **Glass:**
  - Two exit rays, at IOR 1.47 and 1.53, combined with `palDisperse`, so fringes fall only on the VERM–COBALT axis.
  - COBALT absorption 0.35 per wu.
- **Ball:** r 0.146 at **(0, NOTCH, 0)**, ≈0.808, taken from `_sys` with no literal. VERM matte with a clearcoat (F0 0.04).
- **Floor:**
  - An infinite plane at y = 0, in BONE.
  - A world-fixed grid every 1/9 wu: Ink at 15%, every 9th line at 30%.
  - Lines are box-filtered and analytic, with width taken from ray differentials. They fade to their mean coverage when spacing drops below 4px.
  - The grid fades out between horizontal radius 1.5 and 2.3 from the origin.
- **Cyc (camera-locked):**
  - Along the camera's horizontal forward f̂, a cove of radius 0.5 rises from the floor at distance 3.0 behind the origin into a vertical wall at distance 3.5. The wall is infinitely tall and wide, all BONE.
  - Every yaw sees the same backdrop. The cove itself is plain.
  - **Wall grid:**
    - Pitch ≈0.152 wu, computed at init so it projects to exactly 60px at f384.
    - Ink at 20%, every 4th line at 35%, with one line through the view axis.
  - Four Ink registration crosshairs on the wall, sized at f384 scale (24px arms, 8px circle). They sit at wall points that project to (±0.80, +0.40) and (±0.80, 0.00) at f384.
  - Any escaping ray takes the fog colour: the current ambient-lit BONE, or INK during the blackout.
- **Lights:**
  - Key: an area light from `KEY3` in warm white, balanced so the lit floor reads exactly as BONE.
  - Rim: COBALT from (0.6, 0.3, −0.75) at 2.0.
  - Ambient: 0.18·BONE.

**Camera** (level: pitch 0, roll 0)
- Look-at L = (0, 0.6, 0); eye = L + R_yaw·(0, 0, D).
- **D = 1/tan(FOV/2)**, so the plane z = 0 is always 1 wu = 0.5 H, and the V stays 0.5 H tall.
- At yaw 0, world (x, y, 0) maps to screen 0.5·(x, y − 0.6).

| Frames | FOV | Yaw | Aperture |
|---|---|---|---|
| 384–396 | 12° | 0 | 0 |
| 396–428 | 12→38° (inOutSine): the dolly zoom | 0 | 0 |
| 428–470 | 38→14° (inOutQuint) | 0→90° (inOutQuint) | Ramps from 0 to CoC ≤12px at the wall over 428–444; focus = \|eye − L\| |
| 470–480 | 14° | 90° | Held |

The FOV function is continuous with zero slope at 428, because both eases are flat there.

**Beats**
- **384–396, light sheet:**
  - A plane at x = P sweeps from **−2.5 to +2.5 wu** (inOutSine, 12f). It enters beyond the left edge and leaves beyond the right.
  - For each primary hit with pos.x < P, draw the lit 3D render. Otherwise draw **prevTex**, the 2D glass V from `lens`. It matches because `lens` drew it at `CAP_V2D`, the projected front face.
  - The contour on surfaces is `VERM·2.0·exp(−((pos.x−P)/0.012)²)`.
  - Where the sheet crosses the dot, the flat disc becomes a lit ball.
- **396–428, dolly zoom:**
  - The V holds at 0.5 H while the wall grid shrinks from 60px to ≈37px and the crosshairs rush inward. The effect is vertigo, and a callback to f0.
  - The floor opens into perspective. Through the glass, the grid bends and splits into VERM and COBALT fringes.
- **428–470, orbit:** the camera yaws to 90° while FOV closes to 14°. DOF breathes in over 428–444.
- **452–464:** the ball rises out of the notch to (0, 1.236, 0) with outBack. Above the edge-on slab it reads as a **tittle**.
- **464–474:** hold.
- **468, blackout:**
  - The key and ambient lights cut to 0 in one frame. The ambient floor becomes 0.005, which renders Bone as INK.
  - The COBALT rim rises to 2.2 and outlines the slab.
  - A narrow warm-white spot from directly above (8° cone, tracking the ball) keeps the ball VERM. Its lit top renders at 1.0·VERM.
  - Exposure stays at 1.
  - Bloom goes 0.45 → 0.8 over 468–479, and only catches the rims.
- **474–479, fall:**
  - `y = 1.236 − 0.09·inQuad((f−474)/5)`, which reaches 1.146 (contact with the slab top) **at f479**.
  - Stretch is `sy = 1 + 0.15·sin(π·u)`, volume-preserving, so the ball is round again at contact.

**Build**
- **Primary rays at half resolution (960×540):**
  - Floor, cove, wall and ball are intersected analytically.
  - The V is marched only inside its AABB, over [t_enter, min(t_exit, t_studio, t_ball)], with ≤48 steps and a hit epsilon of 0.0008.
  - Output is rgb plus depth in RGBA16F. Measured at 61–73 ms, with no unconverged pixels.
- **Refraction:** an inner march of ≤24 steps, then two analytic exit rays (IOR 1.47 and 1.53), tested first against the ball, then against the floor, cove and wall.
- **Shadows:**
  - The V's soft shadow uses 20 steps, k 10. The ball's shadow is analytic.
  - Inside the glass shadow, the floor is shaded as `shadow·0.4 + causticMap·BONE·k`.
- **Caustic bake** (at init; the V and the key light never move):
  - Trace 512² rays from KEY3 through the V's SDF on the GPU: entry march, refract, inner march (≤24 steps), refract out, intersect y = 0. Do this once at IOR 1.47 and once at 1.53.
  - Splat the hits as additive `gl.POINTS` into two 1024² floor-space maps, blur them by 1–2px, and combine them with `palDisperse`.
  - Per frame, the cost is one texture fetch.
- **Ball:** Lambert, shadow, 4-tap AO and clearcoat.
- **DOF:** 16-tap golden-angle gather, from 428.
- **Upsampling:** depth-aware 2× to full resolution. The sheet test and all grid shading (floor and wall) run in this full-res pass, using positions reconstructed from depth.
- **Motion blur:** an 8-tap screen-velocity blur built from depth plus the previous and current camera matrices, plus the ball's own velocity over 452–479. `mb(f) = 0`.

**IN (f384):** identical to `lens` OUT, with the ball centre within 1px of NSTAR. The sheet enters from beyond the left edge.

**OUT (f479):**
- Ink void.
- An edge-on glass slab outlined by the 2.2 COBALT rim, x ≈ ±0.073, y ≈ −0.30 to +0.20.
- The round VERM ball, r 0.073, spot-lit from above, with its centre at (0, 0.273), just touching the slab top.
- Exposure 1.

**Post:** bloom 0.45 and vignette 0.16, both eased from `lens` over 384–396. Bloom rises to 0.8 over 468–479. `postOut = {bloom: 0.8, vignette: 0.16}`.

**Perf:** about 340 ms (march, DOF, upsample and velocity blur), plus about 170 ms for `lens` on 384–395, plus post: ≤0.9 s.

**Fallback:** works for any glyph. The ball rests at `vNotchRest(glyph, 0.146)`, which returns 1 + 0.146 (on top of the glyph) if there is no notch.

### 5.6 `flow`: FIG. 5 FLOW [480,576), station 4 (I), stateful. The drop.

**Hero:** the letter's weight acts as a moving wall that shoves wet pigment, rendered as a screen print. **Supporting beats:** ink pours on the off-beats, the rupture at 552, and the flood.

**The I**
- A box centred at (0, −0.05), half-height 0.25.
- Half-width `w = 0.25·STEM(wght)`:

  | wght | 300 | 850 | 900 |
  |---|---|---|---|
  | half-width | 0.0288 | 0.073 | 0.0805 |

**Weight schedule**
- **480:** rises from 850 toward 900 with overshoot, peaking at w = 0.089 within 4f. Relaxes to 300 by 500 (outCubic).
- **504 and 528:** springs from 300 to 900 with `spring(5, 0.4)`, capped at w ≤ 0.095, and relaxes to 300 within 18f.
- **552:** springs to 900, settles to 850 by 564, and holds.

**Simulation** (reset at f480, fixed dt)
- Velocity: 384×216 RG16F.
- Pressure: 20 Jacobi iterations.
- Dye: **512×288** RGBA16F, with R = vermilion and G = ink. MacCormack advection.
- Dissipation: R 0.999, G 1.0.
- Vorticity confinement **ε = 8**, for heavy, viscous ink.
- Moving-wall boundary: velocity inside the box is `(dw/dt)·sign(x)·x̂`.
- All of a step's splats are applied in **one pass per field** (`uniform vec4 uS[32], uC[32]`).
- Splat speed is capped at 1.5 H/s.

**Splats**
- **480, impact** (step 0), at (0, 0.20):
  - A radial impulse of 1.5 H/s (Gaussian r 0.07), biased sideways and down the walls.
  - A VERM splat, r 0.09, amount 1.4.
  - A crown of 10 droplets (r 0.012) at radii 0.10–0.18 above the top.
- **Every kick** (480, 504, 528, 552): 4 outward splats per wall, r 0.05, with speed proportional to dw/dt (capped), VERM 0.5. These are big coherent shoves, not fizz.
- **Pours at 492, 516, 540** (6f each):
  - Ink at (0, 0.21), moving down at 1.2 H/s, r 0.035, G 1.2 per frame.
  - The ink drapes over the shoulders and marbles.
- **Rupture, 556–587:**
  - 8 ink splats per wall per frame.
  - Outward speed rises from 0.8 to 1.5 H/s (inQuad).
  - The splats **continue through 587**.
- **Flood (guaranteed by construction):**
  - `G_eff = max(G_sim, flood(p, f))`.
  - flood = 1 where `dBox(p) > 0.02` and `dBox(p) + 0.04·fbm(6p + 0.02f) < R(f)`, with `R(f) = mix(0.02, 1.15, inQuad((f−552)/36))` for f ≥ 552.
  - The front edge renders as the 12px halftone.
  - Guarantees:
    - G_eff ≥ 0.95 everywhere outside the core rectangle dilated by 0.02, by **f584**.
    - 100% coverage at **f587** (asserted).

**Render** (one full-resolution pass, screen print)
- **Push and punch:**
  - The sim and the I are sampled at `c + (p − c)/S`, with c = (0, −0.05).
  - `S(f) = 1 + 0.10·exp(−(f−480)/5) + 0.06·inOutSine((f−480)/96)`, so the drop hits with scale.
- **Pigment (posterised, never multiplied):**
  - The dye is sampled bicubically, then thresholded with fwidth antialiasing.
  - **INK** where G_eff > 0.5; otherwise **VERM** where R > 0.45; otherwise **BONE** paper with fibre.
  - The 0.2–0.5 band of the dominant pigment renders as a 45° halftone (12px·scale cells, dot radius ∝ √((v − 0.2)/0.3)) over the colour beneath.
- **The I:** a solid VERM box with a wet sheen.
- **Wet light** (the only non-flat light):
  - `n = normalize(−∇blur(R+G)·6, 1)`.
  - Blinn highlight toward KEY3, power 60, warm white at 2.2.
  - Cavity darkening of 10%.
- **Alpha:** `a = smoothstep(.55, .95, G_eff)`, written in the final unblended pass.

**IN (f480):**
- `post.flash` 1→0 over 480–490 (outQuad), with `flashColor` = BONE sRGB (0.945, 0.922, 0.875).
- It opens from `volume`'s Ink void onto Bone paper, the bursting VERM I and the crown: a full Ink→Bone swing.
- `ca` 0.008→0 by 490.
- `shake` 5px·scale, in a hashed direction, decaying as `exp(−(f−480)/3)`, with edge-clamped sampling.
- Scale punch as above.

**OUT (f575, and the tail through 587):**
- The VERM I core at wght 850: x ±0.0774, y −0.315 to +0.215 (after S ≈ 1.06), with a VERM film ≤0.02 wide around it.
- The ink flood is advancing: G_eff ≥ 0.9 over at least 45% of the frame at 575. It completes by 587.
- Alpha is the ink matte.

**Post:** bloom 0.6, vignette 0.14. The 480 cut is exempt from easing. `postOut = {bloom: 0.6, vignette: 0.14}`.

**MB:** none.

**Perf:**
- Step: about 143 ms, splats included.
- Render: about 300 ms.
- Steady state: about 0.8 s including post.
- Isolated replay: ≤108 steps, about 15 s.

**Fallback:** for another letter, the obstacle is its glyph SDF dilated by `w(t) − w(850)`, and dBox becomes the distance to that glyph.

### 5.7 `field`: FIG. 6 FIELD [576,672), station 5 (T), stateful, overlap 12. Drop 2.

**Hero:** the I becomes a T of vermilion dust. The T peels into a storm while the dot, now a comet, leads the camera through it, and everything converges into the name. **Supporting beats:** the slash (576), the lattice snap (624) and the lock (654–666).

**World and camera**
- The name plane is z = 0.
- **Backplane grid:** a backplane at z = −0.5 carries a GRAPHITE grid.
  - 1px·scale lines, every 4th line 2px.
  - Pitch 0.0594 wu, which is exactly 60px at f671, on the module lines.
  - Box-filtered; it fades in through fog over 612–630.
- **Eye** = L + R_yaw·(0, 0, D).
- **Look-at:** L = k(f)·C(f).
  - k = 0 before 600, rises 0→1 over 600–612, stays 1 until 636, and falls 1→0 over 636–648 (inOutSine).
  - With yaw 0 and L = 0, world (x, y, 0) maps to screen p = (x, y) exactly.
- **FOV:** 40° over 576–648, then 40→8° over 648–672 (inOutSine).
- **D:**

  | Frames | D |
  |---|---|
  | 576–600 | 1.374 (= 0.5/tan 20°) |
  | 600–636 | 1.374→0.65 (inOutCubic) |
  | 636–648 | 0.65→1.374 (inOutCubic) |
  | From 648 | D = 0.5/tan(FOV/2), the dolly-zoom flatten |

- **Yaw:** 0→28° over 600–636 (inOutCubic), then back to 0 over 636–660 (inOutQuint). The yaw frames the storm off-axis.
- **Focus:** z_f = |eye − L|.

**Particles**
- 512×384 = 196,608 grains.
- State: MRT RGBA32F ping-pong, storing pos.xyz + tag and vel.xyz + age.
- **Dot-bound grains:** 4,096 of them, about 1 grain per px in the r 0.034 disc. They are rejection-sampled from the right end of the T's crossbar (x ≥ x_tip − 0.06).
- **Letter-bound grains:** the other 192,512.
  - They are rejection-sampled (PCG) from the `stationLetter(5)` raster: cap 0.53, baseline −0.315, ink-centred on x = 0.
  - 10% are BONE sparkles.
  - Crossbar grains are the raster rows wider than 1.5× the stem.
- **Targets (stratified, exact):**
  - Letter grain i goes to filled pixel `j = ⌊i·P/N⌋` of the `nameLayout` NAME raster, where P is the number of filled pixels and N the number of letter grains.
  - Its weight is `1/c_j`, where `c_j = ⌈(j+1)N/P⌉ − ⌈jN/P⌉`.
  - Dot grains go to stratified points in the disc at S0, with r = `nameLayout.dot.r`.
- **Intensity rule:** a grain's value is `target / (grains per px · sprite integral)`, so accumulated brightness never depends on grain count.
- **Storm values:**
  - VERM grains at 0.45–0.8 each. Where 2–6 grains overlap they span m 1–4, so density reads as a white-hot core.
  - Sparkles at 0.6·BONE.
  - The comet core accumulates to ≈2.5.

**Beats**
- **576–588, IN (drop 2):**
  - **576–579:** the T's crossbar extends as a solid VERM SDF bar, thickness 0.25·0.53, on the crossbar's centre line y_cb. It runs from the stem top to the full frame width x = ±0.889 with outExpo over 3f. This full-width slash rhymes with the f167 horizon and the hard-left and hard-right zips.
  - **579–585:** the slash retracts to the crossbar's width and shatters through a **6px halftone-cell dissolve**. Cells die in hashed order, and each grain is born when its cell dies.
  - The same cell dissolve turns the pigment of the core (flow's I core dilated by 0.02) into the stem's grains. There is no crossfade.
  - **Mask:** this shot's world shows where `mask = max(smoothstep(.45, .6, prevTex.a), slashAlpha, dustAlpha, coreDissolve)`, and prevTex shows elsewhere. A 3px VERM meniscus at 1.6 runs along the prevTex matte edge.
  - Flow guarantees alpha 1 outside core+0.02 by 587, and the core dissolve completes by 585. So **mask = 1 everywhere by 587**, and nothing pops at 588.
- **585–600:** the complete T holds, twinkling on a hashed 8f period. It is readable for at least 18f (585–603).
- **f600, peel:**
  - Crossbar grains release at `600 + 14·(1 − |x|/x_tip)`, so the tips go first.
  - Stem grains release at `612 + 14·(0.215 − y)/0.53`.
  - Release impulse: (sign(x)·0.24, 0.48, ±0.36) wu/s, plus curl.
  - `ca` spikes to 0.005 and decays to 0.0015 over 8f.
- **600–660, the comet:**
  - At 600 the dot-bound grains release. They spring (ω 2π·4, ζ 0.7) to hashed offsets within r 0.034 of the centroid path C(f).
  - C(f) is a centripetal Catmull-Rom through:

    | Frame | Point |
    |---|---|
    | 600 | (x_tip, y_cb, 0) |
    | 612 | (0.45, 0.30, −0.20) |
    | 624 | (0.10, 0.05, −0.45) |
    | 636 | (−0.35, −0.10, −0.25) |
    | 648 | (−0.62, 0.03, −0.05) |
    | 660 | (S0.x, S0.y, 0), then held |

  - It renders with a white-hot core and a drag tail.
  - The camera's look-at rides the comet, so the dive follows the dot.
- **600–624, storm:**
  - Letter grains are driven by a 32³ curl field baked at init, sampled at `pos·1.6 + t·0.1` and scaled by 1.3.
  - Drag is 0.965 per frame.
  - Fast grains heat toward warm white.
- **624–636, lattice snap:**
  - Letter grains spring (ω 2π·6, ζ 0.6) to the nearest node of a 3D lattice with a pitch of 1/18 wu (the 60px module), plus hashed jitter ≤0.004.
  - Curl drops to 20%.
  - While snapped, per-grain intensity is ×0.35, so the nodes land at m ≈ 2–4.
  - The dive passes between the lattice planes, giving ordered parallax and bokeh built from `point`'s grid.
- **636–654, converge:**
  - Released from the lattice, grains spring to their targets (ω 2π·2.6, ζ 1), with gain `smoothstep(636, 650)`.
  - Curl fades to 0 by 650.
  - Letter grains cool from VERM to BONE as they arrive.
- **654–666, lock (deterministic):**
  - Let P654 be the positions at 654. For f ≥ 654: `pos = mix(P654, target, outExpo((f−654)/12))`, vel = 0, z → 0.
  - Placement is exact by 666 and held through the tail.
  - Over the same window, intensities ramp to the lock values: letters accumulate to **1.0·BONE per pixel**, and the dot cluster's centre to **1.0·VERM**.
  - Only a ±5% brightness twinkle remains.

**Render**
- Instanced Gaussian sprites, fetched by instance ID, drawn additively into RGBA16F.
- Size: `s = clamp(1.6 + 24·|z_v − z_f|/z_v, 1.6, 16)·scale`.
- Each sprite is stretched along its screen velocity by `|v_screen|·0.5/60` (the motion-blur streak) and energy-normalised by its footprint. `mb(f) = 0`.
- **Energy-conserving decimation:** for s > 6px, keep a grain only if `hash(i) < (6/s)²`, and multiply its value by `(s/6)²`. The rest are sent off-screen at size 1.
- Grains with z_v < 0.12 fade out (near plane only).

**IN (f576):** flow's frame, with the slash beginning at the stem top.

**OUT (f671, and the tail through 683):**
- Frontal camera: FOV 8°, yaw 0, L = 0.
- BONE dust letters sitting exactly on the `nameLayout` raster, at 1.0·BONE ±5%.
- The VERM cluster at S0, r 0.034. Its centre tonemaps to within 3 sRGB codes of #FF3A1F.
- INK void with a flat GRAPHITE grid at 60px on the module lines.
- In the tail, only the twinkle moves.

**Post:** bloom 0.8, vignette 0.18, eased from `flow` over 576–588. `postOut = {bloom: 0.8, vignette: 0.18}`.

**Perf:**
- Update: ≤25 ms.
- Render: 223–255 ms with decimation.
- Overlap frames (plus `flow` as prevTex): ≤1.2 s.
- Isolated replay: `field`'s ≤108 steps (about 3 s), plus `flow`'s replay on 576–587 (about 15 s).

**Fallback:** for another letter:
- Crossbar grains are the rows wider than 1.5× the stem. If there are none, the slash leaves from the glyph's top ink row.
- x_tip = inkR.
- Dot-bound grains come from the rightmost ink.

### 5.8 `full-stop`: FIG. 7 FULL STOP [672,900), overlap 12. Title.

**Four events:** resolve (672), skip and windows (720), land with lock and rule (768), and the role line (792). After that, stillness from 812 to 899.

The layout is `nameLayout`: INK type on BONE paper with fibre.

**Beats**
- **672–684, resolve:** a halftone-cell dissolve on the module grid.
  - Cell k starts at `s_k = 672 + |centre_k − S0|/0.24` frames. Its disc radius is `0.75c·outExpo((f − s_k)/5)`.
  - Inside the discs: the crisp layer, which is Bone paper, the Ink name at 850, and the flat VERM dot at S0 (r 0.034).
  - Outside the discs: prevTex.
  - Each growing disc carries a 3px VERM ring on its edge. The ring is drawn only where no neighbouring disc covers it, so rings are cut away as the discs merge.
  - The sweep runs left to right from the dot and is done by 684.
- **684–708:** reading time.
- **708–712:** the dot squashes at S0.
- **712–720:** it hops to glyph 0 at `(cx_0, yTouch[0])`, with its apex +0.06 above the higher end.
- **Touches at `720 + i·Δ`** (for NEKVIT: 720, 726, 732, 738, 744, 750):
  - Each touch is a 2f squash at `(cx_i, yTouch[i])`.
  - Between touches, the dot makes Δ-frame hops with an apex +0.035 above the higher end.
  - The dot really touches ink: on the N's diagonal, on the K's arm, and inside the V's notch.
  - Each touch opens **window i**:
    - an iris from the touch point, with radius growing from 0 to 0.26 (outExpo, 8f)
    - clipped to the **live** title Surface alpha of glyph i
    - while the window is open, glyph i is drawn at **wght 900** about its fixed centre (about a 10% wider aperture, driven by the type-axis spring), with a 3px VERM inner rim
    - showing `world(i % 6)`
  - At each touch the HUD label jumps to `FIG[(i % 6) + 1]` (FIG. 1 — LINE through FIG. 6 — FIELD), resolving in 3f.
- **750–754:** anticipation.
- **754–768:** the final hop to `nameLayout.dot`, with its apex at y = 0.30.
- **768, lock (the final hit):**
  - **Landing:** squash to 1.3/0.72, springing back with `spring(4, 0.5)`. The motion is sub-pixel by 784.
  - **Weight slam:** every glyph goes 850 → 900 → 850 over 768–770 (peak at 769, released with `spring(4, 0.5)`), about its fixed centre, so the whole name punches on the hit.
  - **Windows** snap shut from bottom to top within 4f. A window stays visible only where `y > y_b + cap·inQuad((f−768)/4)`, and is always clipped by the live Surface alpha.
  - **Ring:** one 3px VERM ring leaves the full stop, growing from r 0.034 to 0.30 over 768–780 (outExpo). Its width tapers to zero as it grows (a taper, not a fade), and it passes under the type. This is the callback to `point`'s ripple.
  - The HUD lands on `FIG. 7 — FULL STOP`, and the timecode freezes at `00:00:12:48`.
- **768–780, rule:**
  - The rule tip zips from the dot leftward to `inkLeft` with outExpo over 12f. It is 4px, in VERM.
  - As the tip passes under glyph i's centre (at t_pass,i), that glyph's wght dips 850 → 700 → 850 on a 10f sine that starts at `max(t_pass,i, 772)`.
  - The glyph is drawn about its fixed centre, so nothing re-lays out.
- **792–812, role line (print-in):**
  - Character k of `config.role` starts at `792 + k·s`, where `s = min(1.5, 8/(n−1))` frames and n counts characters including spaces. For "Motion Design", s = 0.667.
  - Over 12f, each glyph slides down 0.045 H from behind the rule (outExpo), masked to `y < rule.y − 3px` (below the rule's bottom edge), so it starts hidden.
  - During its first 8f, the glyph prints in as a 45° halftone (6px·scale cells) whose dot radius grows from 0 to solid (outQuint). It snaps to the crisp glyph on its last frame.
  - The last glyph ends at 812.
- **792, 795, 798, 801:** the year's digits type on, crisp.
- **800–811:** the HUD types off (§2.2).
- **812–899:** still. Only grain moves.

**Worlds**

These are live and cheap, use only palette colours, and are one function each. Each is designed to read through an aperture of about 60px and is dominated by a colour other than Ink.

| # | Station | World |
|---|---|---|
| 0 | LINE | VERM ground. Ink rows at 12px pitch, thickness 35–65% on a travelling sine |
| 1 | PLANE | COBALT ground. BONE isolines (period 1/80 H) of an animated circle unioned with a rotating bar. A 3px VERM zero contour |
| 2 | LENS | BONE ground. A 1.3× magnified Ink module grid at 20px pitch, drifting. A 4px VERM/COBALT split along the glyph's bevel. No text, because the aperture cannot carry a word |
| 3 | VOLUME | A GRAPHITE → 0.6·COBALT gradient. A diagonal BONE specular band at 1.4 sweeps across. A half-module grid with a 2px VERM/COBALT offset |
| 4 | FLOW | Posterised VERM/Ink marbling at 1/3 scale: flow's print model applied to 3-octave domain-warped fbm |
| 5 | FIELD | INK ground. VERM dust in 3px cells at 40% occupancy, flaring to 1.6 |

**Build**
- A full-resolution title Surface, redrawn per sample. Each glyph is drawn individually about its fixed ink centre, at its live weight.
- A static glyph-ID texture.
- The role line is a static atlas made at init. The shader animates it with per-glyph uniforms (offset and print progress).
- One composite pass. Worlds are evaluated only inside open windows.
- No canvas `filter` anywhere.

**MB:** 6 on 708–784 and 792–812.

**IN (f672):** field's frame 671, with the first cells opening at S0 (radius ≈0 at 672).

**OUT (f899, the poster):**
- Bone paper.
- **NEKVIT** in INK: Archivo 850/100, cap 0.20, baseline +0.02.
- The VERM full stop at `dot` ≈ (0.589, 0.054), r 0.034.
- The 4px VERM rule at y = −0.065, from inkLeft ≈ −0.623 to dot.x + r.
- **Motion Design** in Instrument Serif Italic, cap 0.055, baseline −0.16, left-aligned to inkLeft.
- **2026** in Archivo 500/125 tabular, cap 0.040, baseline −0.16, right-aligned to dot.x + r.
- No HUD. The poster uses two families.

**Post:** bloom 0.15, vignette 0.08, eased from `field`'s 0.8/0.18 over 672–684. `postOut = {bloom: 0.15, vignette: 0.08}`.

**Perf:** about 150 ms per sample; ≤1.3 s on MB frames. Overlap frames add `field` (about 0.3 s).

**Fallback:**
- Any name of 2–11 letters works: the cap, Δ, the bells and the worlds all derive from n.
- Any role works: the print-in stagger derives from its length.

---

## 6. Global continuity

**The dot's path.** Every cut is carried by the dot or by something born from it.

| Where | What the dot is | Handoff |
|---|---|---|
| `point` | Born (r 0.11), divides, floods the frame | f95: uniform VERM |
| `line` | The ground the plates print on, then the horizon | f167: 6px VERM band |
| `plane` | The composition's disc (r 0.16), then the glide to the tittle | f263: disc at T_DOT, r 0.0172 |
| `lens` | The tittle under the glass K, then the ball in the notch | f383: disc at NSTAR, r 0.073 |
| `volume` | A lit sphere, then the tittle of an edge-on "i", then a spot-lit ball in the dark | f479: ball at (0, 0.273) |
| `flow` | The splash that becomes pigment | f575: VERM I core |
| `field` | The dust T, then a comet the camera follows, then the cluster at S0 | f671: cluster at S0, r 0.034 |
| `full-stop` | Hops across the stations, lands as the full stop | f899: poster |

**Stations.** Each letter is a different instrument:

| Letter | Instrument | Craft shown |
|---|---|---|
| N | Engraving | Print and halftone |
| E | Window | Compositing and masking |
| K | Lens | Distortion and kinetic type |
| V | Volume | 3D, light, depth of field, camera |
| I | Wall | Fluid |
| T | Emitter | Particles |

The title replays them in the same order, with one bell per letter, and the HUD names each station as it opens.

**Recurring motifs**
- **The 60px module:**
  - the grid in `point`
  - the lattice in `line`
  - the dot grid in `plane`
  - the wall grid in `volume` (exactly 60px at f384, about 37px at the end of the dolly)
  - the lattice snap and the backplane grid in `field` (exactly 60px at f671)
  - the title's halftone cells
- **Halftone:**
  - the field in `point`
  - the plates in `line`
  - the shadows in `plane`'s BEAUTY pass
  - the dilute edges in `flow`
  - the slash shatter in `field`
  - the title dissolve and the role print-in
- **Hairline:**
  - the horizon
  - the window rims
  - the baselines
  - the title rule, whose zip at f768 repeats the f24 grid zip
- **Registration crosshairs:** in `point` at f0, and on `volume`'s wall during the dolly.
- **Upper-left key light:** in every shot.
- **The vermilion rim (3px):** on every matte and wipe edge.
- **Serif voice:** the latching flips in `lens` hand the reel from grotesk to serif, which the title's role line then speaks.

**Camera feel.** The reel reads as one continuous move from flat to deep and back to flat.

| Frames | Move |
|---|---|
| 0–168 | Paper push (`paperZ`) |
| 168–263 | Lateral truck at 0.12 H/s, shared by every window |
| 264–396 | Static lens (the K travels; the camera does not) |
| 396–470 | Dolly zoom opens the space (396–428), then an orbit to edge-on while closing back to near-flat (428–470) |
| 480–576 | Scale punch, then a slow push |
| 600–672 | Dive after the comet, lattice parallax, then the dolly-zoom flatten |
| 672 onward | Still |

- At every handoff, the outgoing move eases to zero exactly as the incoming shot starts static, or the same function continues across the cut (`paperZ`).
- There is no roll, no pitch and no camera overshoot anywhere.

**Composition**
- **Off-axis rests:**
  - the N at x −0.18, bleeding off the top and bottom
  - the K at x +0.40, on the tittle
  - the E's arms, ending like letter strokes
  - the storm, framed by the yaw
- **Symmetric anchors:** the glass V, the I and the title.
- **Lateral energy:**
  - the truck
  - the dot's glide to the tittle
  - the K's swing in and its travel into the V
  - the light sheet
  - the slash
  - the comet
  - the title dissolve and the skip

**Arc**

| Frames | Section |
|---|---|
| 0–95 | Intro |
| 96–263 | Groove |
| 264–371 | Build (weight wave, glass K, serif flips) |
| 372–383 | Silence |
| 384–467 | **Breath** (lights on) |
| 468–479 | **Vacuum**: blackout and digital silence |
| 480 | **Drop**: the only flash, Ink → Bone |
| 576 | **Drop 2**: the full-width slash, with no flash and no crash |
| 672 | Title |
| 768 | Final hit |
| 812–899 | The poster holds |

**Breath.** Frames 372–467: the drums are out and there is a single object. It is the most beautiful frame in the reel: a glass V holding a vermilion ball on a lit Bone cyc, with a real caustic in its shadow. Then the lights go out.

**Climax.** The drop at 480 into wet pigment, then the storm and the comet from 576 to 672.

**Title payoff.** The dot revisits the six stations. Each letter opens onto its world with one note of the six-note signature (F4–Ab4–C5–Eb5–F5–C6), and the HUD names it. The dot lands as the full stop, the name punches, and the rule draws. The last frame rhymes with frame 0: a vermilion dot on Bone paper.

---

## 7. Acceptance checklist (every package, before merge)

1. **Isolated rendering.** Any frame renders identically when rendered on its own. Check f, f−1 and f+1 with `tools/render.mjs --frames`. Stateful frames must render within the ≤20 s replay allowance.
2. **Contract frames.** Check these pairs:
   - 95/96
   - 167/168
   - 263/264
   - 383/384
   - 479/480 (under the flash)
   - 575/576
   - 671/672

   How to check:
   - Render with `?clean=1`.
   - Exclude the two HUD bounding boxes, each expanded by 8px.
   - Pass = every edge is within 2px **and** mean |Δ| ≤ 2 sRGB codes over every 32×32 patch.
   - Extra checks:
     - at 383/384, the dot/ball centre matches within 1px
     - at 671, the S0 cluster centre is within 3 codes of #FF3A1F
3. **Flat colour** (with `?clean=1`). The mean of any flat patch within 0.3 H of the frame centre is within ±1 code of its hex. Each token rendered as a flat full-frame fill reads back exactly.
4. **Tonemap swatch frame.** The VERM, COBALT and BONE ramps (×0.5 … ×6) roll off with their hue preserved and reach warm white at 4.
5. **Delivery check.** Encode the contract frames with the real settings (`libx264 -pix_fmt yuv420p -crf 14 -tune animation`). Inspect the VERM and COBALT rims, the rule and the tags on the **decoded** frames, not on the PNGs.
6. **Frame budget.** ≤2.5 s steady-state per frame, including MB samples, overlap and post.
7. **Text.**
   - Only the strings specified here.
   - Only ASCII plus — and ·.
   - No HUD drawn inside a shot.
   - No canvas `filter` on a full-frame canvas.
8. **Post.**
   - `ctx.post` deltas are set every frame, and `postOut` is exported.
   - Overlaps and cuts ease as in §2.2.
   - Flash, CA and shake appear only where §1.4 allows.
9. **Timing and sound.**
   - Every event lands on its §3 frame.
   - Gates G1 and G2 are exactly 0, apart from the two dry foley events.
   - The flow coverage assertion passes at 587.
---

## 8. Director decisions (v1.2, binding; they override earlier text)

1. **Measured values win.** `_sys.js` computes every layout value from the real fonts. Where a "≈" check value in this document differs, use the `_sys` value. Measured: blockW 1.243, inkLeft −0.6217, dot (0.5877, 0.054), S0 (−0.6967, 0.054), O_K ≈ 0.827 cap.
2. **The ball rests in the V's notch touching both walls.** Archivo's V notch sits slightly right of its ink centre, so `NOTCH = notchRestXY(V, 0.146).y ≈ 0.787`. The new `NOTCH_X ≈ +0.0068` is the ball's x offset from the V's ink centre, in wu and cap units. The V itself stays ink-centred at x = 0.
   - `volume` places the ball at `(NOTCH_X, NOTCH, 0)`.
   - `NSTAR = 0.5·(NOTCH_X, NOTCH − 0.6) ≈ (0.0034, 0.094)`.
   - Every shot reads these from `_sys` and never hard-codes them.
3. **tmPrint stays as specified.** It is C0, not C1, at 1. HDR BONE saturates quickly to warm white and COBALT drifts slightly violet before it whitens. Author with that in mind.
4. **Motion-blur latches.** Discrete states must latch on `s.fi` (the integer in-shot frame) or `s.frame`, never on `floor(s.f)`. `s.f` and `s.t` can be slightly negative on the early samples of a shot's first frame.
5. **Post cost.** Budget about 0.25 s for post with bloom 0, 0.5 s with bloom, and 0.65 s at the 480 cut. The ≤2.5 s frame budget stands.
6. **restY** scans down from `max(1, inkY1) + rCap`, so glyphs with overshoot rest on top.
7. **HUD** is engine-owned (`src/hud.js`). Shots never draw it.
8. **Fallback roles.** `roleLayout`'s fit rule for long roles is accepted.
