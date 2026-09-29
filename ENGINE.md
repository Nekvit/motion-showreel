# Engine reference (for shot authors)

The reel is a custom WebGL2 engine (no three.js). Global frames run 0..899 at 60 fps
(1920×1080). The binding creative spec is `DIRECTION.md`; this file is the technical contract.

## Files

| Path | What |
|---|---|
| `index.html` | Player (click to play with sound; ←/→ step, Shift+←/→ ×10, Space, F) and capture API (`?capture=1`, see *Page API*) |
| `src/config.js` | Name / role / year / BPM |
| `src/timeline.js` | Shot list: `{ id, start, end, overlap, module }` |
| `src/engine.js` | Engine, per-frame state, stateful replay, prevTex overlap, motion blur, post continuity, HUD, post |
| `src/hud.js` | Engine-owned HUD: pure `hudState(frame, config)` + `HudRenderer` (never draw HUD in a shot) |
| `src/gl.js` | `Program`, `FBO`, `PingPong`, VAO/texture helpers, `mat4` |
| `src/glsl.js` | GLSL library: `common`, `hash`, `noise`, `sdf`, `ray`, `all` |
| `src/ease.js` | `ease.*`, `bezier`, `curves` (snap/glide/whip/settle), `spring`, `track`, `rng`, `window01` |
| `src/text.js` | `font()`, `snapWidth()`, `layout()`, `drawText()`, `Surface`, `sdfTexture()` |
| `src/sdf.js` | `sdfFromAlpha()`: accurate signed distance field of an antialiased mask (pure JS, Node-importable; used by `sdfTexture` and `_sys.glyphSDF`) |
| `src/post.js` | Post chain + `POST_DEFAULTS` |
| `src/shots/<id>.js` | One module per shot |
| `src/shots/_sys.js` | Shared palette / layout system (DIRECTION §2.3) |
| `src/shots/_test<Name>.js` | Test pages (`?test=<name>`): `_testFlat.js`, `_testSwatch.js` |
| `tools/render.mjs` | Headless renderer (PNG frames, contact sheets, MP4) |

## Shot module

```js
export default {
  id: 'my-shot',
  stateful: false,          // true => engine calls reset() then step() for EVERY frame from the shot's first frame
  init(ctx, shotInfo) {},   // once; create programs, FBOs, textures (may be async)
  reset(ctx, s) {},         // stateful only: clear sims to the initial state
  step(ctx, s) {},          // stateful only: advance the sim exactly one frame (fixed dt = 1/60)
  render(ctx, s) {},        // draw the frame into s.target (HDR, linear colour); call ctx.setPost(s, deltas)
  mb(f) { return 0; },      // motion-blur sample count for integer in-shot frame f (0/undefined = off)
  postOut: {},              // constant: this shot's post deltas at its final frame (for the next cut)
};
```

`this` inside the hooks is the module object, so keep per-shot state on `this`.
DIRECTION §4: every shot exports `mb(f)` and `postOut`.

### Per-frame state `s`

| Field | Meaning |
|---|---|
| `s.t` | seconds since the shot's first frame (`s.f / 60`) — **fractional during motion blur** |
| `s.f` | frame index within the shot (0-based) — **fractional during motion blur** |
| `s.fi` | integer frame within the shot (`s.frame − start`), never fractional |
| `s.index` | index of the shot in the timeline |
| `s.frame` | global frame — **always the integer frame** |
| `s.g` | global seconds, `(s.frame + s.sub) / 60` |
| `s.local` | `s.t / s.dur` — 0..1 over the shot, **exceeds 1 in the tail** |
| `s.sub` | sub-frame offset of this MB sample in frames (0 without MB) |
| `s.mbN`, `s.mbK` | MB sample count and index of this render (0, 0 without MB) |
| `s.dur`, `s.frames` | shot duration in seconds / frames (`end - start`) |
| `s.tail` | true when the shot is being rendered **past its end** as the next shot's `prevTex` |
| `s.overlap`, `s.inOverlap` | this shot's overlap length; true while its prevTex window is active |
| `s.dt` | 1/60 |
| `s.target` | the HDR `FBO` (RGBA16F, W×H) to draw the final image into. Already cleared to (0,0,0,1). With MB each sample may get a different FBO: always draw into `s.target`, never cache it. |
| `s.prevTex` | while `s.fi < overlap` of *this* shot: the previous shot's final HDR image at this same global frame (rendered lazily on first access). Otherwise `null`. Reading it sets `ctx.prevPost`. The first read runs the outgoing shot's whole `render()`; the engine saves and restores your GL state around it (framebuffer, viewport, current program, VAO, blend/depth/cull/scissor/colorMask, texture units 0–15), so `prog.use(); prog.set({ uPrev: s.prevTex })` is safe. Still cheapest to read it once at the top of `render()`. |

**Transitions belong to the incoming shot.** If shot B has `overlap: 12`, then for B's first 12
frames the engine also renders shot A (with A's `s.tail === true`, `s.f >= A.frames`) and hands the
result to B as `s.prevTex`. B decides how to composite (mask, displacement, zoom-through…). A's
`render()` must therefore keep producing sensible motion for up to `overlap` frames past its end —
continue the motion, don't freeze or go black. `prevTex` carries alpha (`flow` writes its ink matte
there; `field` reads `prevTex.a`).

**Determinism.** Every frame must be a pure function of the frame number (plus sim state for
stateful shots, which the engine replays). Never use `Math.random()`, `Date`, `performance.now()`.
Use `ctx.ease.rng(seed)` created in `init` *and re-seeded in `reset`/per frame*, or GLSL `hash*`.
Never call `getImageData` on a canvas you redraw per frame: Chrome switches that canvas to a
different raster path after a couple of readbacks, so text rasterises differently in a sequential
render than in an isolated one. Read back only init-time canvases (e.g. `sdfTexture`).

### Motion blur (temporal supersampling, DIRECTION §2.2)

- `mb(f)` gets the **integer** in-shot frame (`s.fi`, may be ≥ `frames` in the tail) and returns
  the sample count N; 0, 1 or undefined = off. **Stateful shots are exempt**: the engine never calls
  their `mb` and never supersamples them.
- With N ≥ 2 the engine calls `render()` N times, sample k at
  `s.t + ((k+0.5)/N − 0.5)·0.5/60` (shutter 0.5), i.e. `s.sub = ((k+0.5)/N − 0.5)·0.5` frames
  (N = 6: ±0.042, ±0.125, ±0.208). `s.f`, `s.t`, `s.local`, `s.g` are fractional; `s.frame`/`s.fi`
  stay integer. Each sample renders into a freshly cleared target; the samples are averaged in fp32
  into an RGBA16F accumulator (**all four channels**, so alpha mattes are averaged too) and post
  runs once. A texel identical in every sample stays bit-identical (flat fills stay exact).
- **Samples straddle the integer frame**, so half of them are *earlier* than it: at `fi = 0` the
  early samples have **negative** `s.f`, `s.t`, `s.local` (and `s.g` at global frame 0). Clamp
  where negative time is meaningless (`Math.max(s.t, 0)`); `sys.paperZ` already clamps.
- **Latched discrete states** (flips, touches, plate pops, hashes, grain seeds) must use **`s.fi`**
  (or `s.frame`, or `Math.round(s.f)`), which switches exactly on its frame in every sample.
  **Not `floor(s.f)`**: the early samples of frame F have `floor(s.f) = F − 1`, so a state latched
  on it renders at F as a blend of the old and the new state (for N = 6, 3 of 6 samples old).
  (DIRECTION §2.2 still lists `floor(s.f)`; flagged to the direction owner.)
- **Post params with MB** are the integer frame's (§2.2): for odd N, those of sample (N−1)/2,
  which sits exactly on the integer frame; for even N, the mean of samples N/2−1 and N/2
  (at ∓0.25/N frame), which is exact for params linear in `s.f` and within O(1/N²) otherwise;
  discrete params (`tonemap`) come from sample N/2 (so a `s.f >= F` switch reads as switched at F).
- **prevTex during MB**: the outgoing shot is rendered **once per output frame at the integer frame**
  (with its own `mb()` honoured), cached, and the same texture (and `ctx.prevPost`) is handed to
  every sample of the incoming shot. It is *not* re-rendered at each sample's fractional time.
- Cost: each sample is a full `render()`, plus one averaging pass (~0.1 s at 1080p in SwiftShader)
  per 7 samples. Budget MB frames accordingly (≤ 2.5 s including prevTex and post).

### Post continuity (`ctx.setPost`, `postOut`, `ctx.prevPost`)

Shots set only their deltas, **every frame**, with

```js
ctx.setPost(s, { bloom: 0.45, vignette: 0.16 });                 // typical
ctx.setPost(s, { flash, ca, shake, flashColor }, { easeFrames: 0 }); // the 480 cut: no easing
ctx.setPost(s, deltas, { exempt: ['bloom'] });                    // don't ease bloom
```

`setPost(s, deltas, { exempt = [], easeFrames = 12 })` sets `ctx.post = POST_DEFAULTS ⊕ deltas` and,
while `s.f < easeFrames` and `ctx.prevPost` exists, replaces every numeric param (arrays
component-wise) by `mix(prevPost.p, own.p, inOutSine(min(s.f/easeFrames, 1)))` — except `flash`,
`flashColor`, `ca`, `shake`, `tonemap` and the keys in `exempt`. It returns the object; you may still
tweak `ctx.post.x` afterwards (not eased). `easeFrames` may exceed 12 (the §2.2 default): once
`ctx.prevPost` ends (in-shot frame 12, or the end of the overlap window) the ease continues from the
previous shot's `postOut` ⊕ defaults until `easeFrames`, so a 24-frame ease is one continuous curve.

`ctx.prevPost` (what the incoming shot eases from):
- **Overlap cut** (`overlap > 0`): the params the outgoing shot set while rendering `prevTex` this
  frame; available once `s.prevTex` has been read. `setPost` reads `s.prevTex` itself if the window
  is active and it hasn't been read yet, so call order doesn't matter.
- **Zero-overlap cut**: the previous shot's `postOut` (⊕ `POST_DEFAULTS`) for the incoming shot's
  first 12 frames (also for in-shot frames ≥ overlap but < 12 of a short overlap).
- Otherwise `null` (first shot, or `s.f ≥ 12`).

`postOut` must equal the deltas the shot passes to `setPost` at its final frame (a constant object).

### `ctx`

| Member | Use |
|---|---|
| `ctx.gl`, `ctx.W`, `ctx.H`, `ctx.aspect`, `ctx.scale` | GL context, render size (W/H already include `scale`; design in fractions of W/H, and multiply pixel sizes by `ctx.scale`) |
| `ctx.program(frag, label)` | fullscreen fragment program (`prog.set()` throws if a uniform value is a function, e.g. `sys.NOTCH` instead of `sys.NOTCH(ctx)`). The vertex shader provides `in vec2 vUv` (0..1). Declare your own `out vec4 o;`. `#version 300 es` + highp precision are prepended automatically. |
| `ctx.programVF(vert, frag, label)` | custom vertex+fragment (instancing, geometry). Attribute location 0 is `aPos`. |
| `ctx.draw(prog, uniforms, target, {blend, swap, clear})` | draw a fullscreen triangle. `target`: `FBO`, `PingPong` (draws into `.write`; `swap:true` swaps after), or `null` (canvas — never do this in a shot). Automatically sets `uRes` (target px size), `uAspect`, `uClean` and `uSysClean` (1 under `?clean=1`) if declared. `blend`: `'add' \| 'alpha' \| 'premult' \| 'multiply' \| 'screen' \| 'max'`. |
| `ctx.setBlend(mode)` | same modes for your own draw calls |
| `ctx.blit(tex, target, [sx,sy,ox,oy])` | copy texture |
| `ctx.fbo(w,h,opts)` | `FBO` (default RGBA16F, linear, clamp). `opts`: `{internal, format, type, filter, wrap, depth, count}` (count>1 = MRT: `fbo.texs[i]`). `.bind()`, `.clear(r,g,b,a)`, `.tex`, `.w`, `.h`. |
| `ctx.pingpong(w,h,opts)` | two FBOs: `.read`, `.write`, `.swap()`, `.clear()`; pass a PingPong as a sampler uniform to bind `.read.tex` |
| `ctx.surface(w,h)` | canvas2D surface: `.g` (2D context), `.clear(color?)`, `.upload()` → `.tex`. Canvas y-down; uploaded flipped so `vUv` y-up matches. |
| `ctx.text.font({family, weight, width, size, italic, tnum})` | CSS font string. Archivo `width` 62..125: **0.25 steps over 100..125**, integers below 100 (`ctx.text.snapWidth(w)` gives the width actually used). Never fake width with a scale. `tnum: true` = real tabular figures (OpenType `tnum`), available for upright Archivo at widths `TNUM_WIDTHS` = 100 and 125 (the year: `_sys.YEAR_FONT`). |
| `ctx.text.layout(str, fontSpec, tracking)` | per-glyph metrics `{glyphs:[{ch,x,w,adv,i}], width, capHeight, ascent, descent}` |
| `ctx.text.drawText(g, str, x, y, {font, tracking, align, baseline:'middle'\|'alphabetic', fill, perGlyph})` | glyph-by-glyph drawing; `perGlyph(glyph, i, layout) → {dx, dy, rot, sx, sy, alpha, fill, font}` |
| `ctx.text.sdfTexture(gl, canvas)` | signed distance field of a canvas' alpha: `{tex, data, w, h}`, RGBA32F (distance in r/g/b, 1 in a; `data` stride 4, row 0 = bottom), **distance in source px, negative inside**, accurate to ≈0.05 px (mean \|e\| 0.04–0.08 px on analytic shapes, slope 1 across the edge, so offsets/rims `0 < d < w` are exactly w wide). Uses `src/sdf.js`. Build once in `init` (≈0.55 s for 1920×1080; reads the canvas back, so only on init-time canvases). |
| `ctx.textureFrom(img/canvas, opts)`, `ctx.dataTexture(w,h,Float32Array,opts)` | textures |
| `ctx.createVAO({attribs:[{loc,data,size,divisor}], indices})` | geometry / instancing |
| `ctx.mat4` | `perspective, lookAt, multiply, rotateX/Y/Z, translate, scale, identity` (column-major arrays) |
| `ctx.glsl` | `{common, hash, noise, sdf, ray, all}` GLSL strings to prepend |
| `ctx.ease` | the `ease.js` module (`ctx.ease.ease.outExpo(x)`, `ctx.ease.curves.snap(x)`, `ctx.ease.spring(t,f,z)`, `ctx.ease.track(keys)`…) |
| `ctx.beat` | `{bpm, spb, fpb, at(g), pulse(g,k), frameOf(i)}` |
| `ctx.config` | `{name, role, year, site, bpm, …}` — always take the name from here |
| `ctx.post` | this frame's post parameters (reset to `POST_DEFAULTS` before every render / MB sample) |
| `ctx.setPost(s, deltas, opts)` | set this frame's post params with cut easing (see *Post continuity*) |
| `ctx.prevPost` | the params to ease from after a cut (see *Post continuity*), else `null` |
| `ctx.POST_DEFAULTS` | the defaults (read-only) |
| `ctx.clean` | true under `?clean=1`: multiply paper fibre (and any other texture noise) by 0 |
| `ctx.query` | page query parameters as an object (test pages read e.g. `ctx.query.color`) |
| `ctx.shared` | cross-shot scratch object (avoid unless needed) |

### Colour: exact sRGB, `hexc`, tonemap 3 PRINT

- `srgb2lin` / `lin2srgb` (float and vec3) in `glsl.common` are the **exact piecewise sRGB
  EOTF/OETF** (12.92 linear toe, 2.4 power), not pow 2.2. `hexc(0xRRGGBB)` returns the exact linear
  value (`hexc(0xFF3A1F)` = (1.0, 0.0423, 0.0137)). The post chain's output encode uses the same OETF.
- Tonemap 3 PRINT (default): identity for max channel ≤ 1; above 1 the hue is kept and rolls off to
  warm white (1, .955, .90), reached at 4 (`w = smoothstep(1, 4, max)`: 0.10 at 1.6, 0.5 at 2.5).
  **Author flat colours at ≤ 1**; HDR (> 1) only for speculars, rims (2–2.5), the light sheet (2),
  dust (≤ 4), the comet core.
- PRINT is only **C0** at max = 1 (not C1 as §2.2 says): above 1 the brightest channel is pinned at 1
  (`c/m`), so light tokens plateau. BONE ×1.25 … ×3 all read ≈ (255, 249, 236–240): a BONE highlight
  gains no brightness, only a slow shift to warm white. VERM keeps its hue (4–9°); COBALT drifts
  ≈14° towards violet (235° → 249° at ×3) before whitening. See `?test=swatch`.
- With bloom 0, CA 0, shake 0, distortion 0 and zoomBlur 0 the composite samples the scene
  texel-exactly; with vignette/grain/dither 0 (`?clean=1`) a flat fill of `hexc(X)` reads back as
  exactly `#X` (verified for all five tokens with `?test=flat`).
- The vignette never touches the centre: it ramps from `length(vc)·1.35 = 0.25`, i.e. no change
  within ≈0.18 H of the centre.

### Post parameters (`ctx.post`, set every frame via `ctx.setPost`)

```
exposure 1, bloom 0, bloomThreshold 1.05, bloomKnee 0.1, bloomRadius 1, bloomTint [1,1,1],
ca 0 (chromatic aberration), distortion 0 (barrel +), zoomBlur 0, zoomCenter [0.5,0.5],
grain 0.03, grainSize 1.6 (design px), vignette 0.08, vignetteRoundness 0.6, saturation 1,
contrast 1, lift [0,0,0], gain [1,1,1], flash 0, flashColor [1,1,1] (sRGB-coded), fade 0,
fadeColor [0,0,0], shake [0,0] (uv), scanlines 0, tonemap 3 (0 none, 1 ACES, 2 filmic, 3 PRINT),
letterbox 0, letterboxColor [0,0,0], dither 1 (±0.5 code), hudAlpha 0.55
```

The shot owning the current frame sets them (DIRECTION §1.4 budgets: bloom only in HDR shots,
vignette 0.08 in 2D and ≤ 0.18 in HDR shots, one flash at 480, CA spikes only at 480/600, shake only
at 480). `bloom 0` skips the bloom pyramid entirely. `flashColor` and `fadeColor` are **sRGB-coded**
(applied after the tonemap): BONE flash = `[0.945, 0.922, 0.875]`. **Shake** samples with
CLAMP_TO_EDGE (no black strip); out-of-range uv is zeroed only when `distortion ≠ 0`.

Composite order: shake/distortion/CA/zoom sampling → bloom → gain/lift → exposure → saturation →
contrast → vignette → tonemap → exact OETF → flash → grain → scanlines → fade → letterbox →
distortion edge → **HUD** → dither.

### `?clean=1` (acceptance renders)

Forces `grain 0`, `dither 0`, `vignette 0` in post (after the shot's params) and sets `ctx.clean =
true`. Shots zero their paper fibre: in GLSL declare `uniform float uClean;` (or `_sys.js`'s
`uSysClean`) — `ctx.draw` fills both automatically; custom draw calls pass
`{ uClean: ctx.clean ? 1 : 0 }` themselves. `render.mjs --clean`.

### HUD (engine-owned, DIRECTION §2.2)

Shots never draw HUD elements. `src/hud.js`:
- `hudState(frame, config[, starts]) → { L: { text, tone }, R: { text, full, tone } }` — a pure function of
  the frame (tone 0 = INK `#0E0E12`, 1 = BONE `#F1EBDF`, fractional during 4f eases; transitions
  progress over frames F..F+3, 468 and 480 snap). Node-importable (no DOM at module scope).
- L = FIG label of the shot owning the frame: type-on f6–19 (one char/frame, each new char shows a
  hashed A–Z glyph on its first frame); left-to-right re-resolve (one char/frame, hashed cursor) at
  every shot start (96, 168, 264, 384, 480, 576, 672); title touches at `720 + i·Δ`
  (`Δ = 3·max(1, ⌊10/(n−1)⌋)`, n = letters of `config.name`) jump to `FIG[(i%6)+1]` resolving in 3f
  (only the changing characters scramble); lands on `FIG. 7 — FULL STOP` at 768 (3f); type-off
  800–811 at 1.5 chars/frame; empty from 812.
- R = SMPTE `HH:MM:SS:FF` (FF = frame % 60), frozen at `00:00:12:48` from 768; type-on from f6;
  type-off 800–810 at 1 char/frame. `hudState(n).R.full` is the complete 11-character timecode and
  `R.text` its visible prefix: the renderer right-aligns `full` at 1860 px and draws the prefix in
  full's cells, so characters appear left to right and delete right to left **in place** (nothing
  slides; the ink's left edge stays at x ≈ 1731 from f6 to f809).
- `HudRenderer`: two canvases of 640×48·scale, re-uploaded only when their text changes; JetBrains
  Mono 500, 18px·scale, uppercase, tracking +6%. L baseline at (60, 1026) px, R right-aligned at
  1860 px, same baseline. Composited in the post pass (after tonemap/grain/vignette, before dither)
  with opacity `post.hudAlpha`, in sRGB-coded space — unaffected by bloom/CA/distortion/shake/mattes.
- `hudRects(W, H, scale)` gives both canvas boxes in screen px (top-left origin); §7.2 comparisons
  exclude these boxes expanded by 8 px.
- The HUD is on for the reel and off for test pages; `?hud=0|1` overrides.

### GLSL library highlights (`ctx.glsl.*`)

`common`: `PI, TAU, saturate, remap, remapc, lstep, rot2, rotX/Y/Z, luma, srgb2lin, lin2srgb`
(exact sRGB), `hexc(0xRRGGBB)` (→ linear), `ipal` (cosine palette), `easeInOutCubic, easeOutExpo,
easeInExpo, easeInOutExpo, easeOutQuint, easeInQuint, easeOutBack`, `aastep(d)` (AA fill from a
signed distance). `hash`: `hash11/12/13/22/33, ihash, ihash3` (bit-exact integer hashes). `noise`
(includes hash): `vnoise` 2D/3D, `snoise` 2D/3D (simplex), `fbm` 2D/3D (5 oct), `fbm3` (3 oct,
cheaper), `curl2`, `curl3`, `voronoi` → (F1, F2, id). `sdf`: `sdCircle, sdBox2, sdRoundBox2,
sdSegment, sdRing, sdTri2, sdNgon, sdSphere, sdBox, sdRoundBox, sdTorus, sdCapsule, sdCylinder,
sdOctahedron, sdPlane, opU/opS/opI, smin/smax, opRep2/opRep`. `ray`: `camRay(uv, aspect, ro, ta,
fovY, roll)` (roll must be 0: no camera roll anywhere), `fresnelSchlick`, `iridescence` (not used:
§1.2 forbids iridescence). Use `glsl.all` for everything. Guards (`#ifndef`) make repeated inclusion safe.

### Fonts

`loadFonts()` registers Archivo (both styles) width aliases: every integer 62..99 plus 0.25 steps over
100..125 (101 faces × 2 styles), plus 2 tabular-figure aliases (upright wdth 100 and 125): 286 faces in
total; ≈0.85 s at page load. JetBrains Mono renders ASCII, `—` and `·`.

The renderers (`tools/render.mjs`, `tools/syscheck.mjs`) launch Chromium with
`--font-render-hinting=none`: glyph advances are fractional (MOTION at wdth 100 / 100.25 / 100.5 =
802.44 / 805.04 / 807.24 px instead of 802 / 806 / 807), so springs on wdth/wght move smoothly
instead of in whole-pixel steps. Advances are still quantised to whole font units (0.001 em) by
the variable-font instancer.

## Performance (headless SwiftShader = software GPU on 4 cores)

Budget (DIRECTION §2.4): ≤ 2.5 s steady-state per frame **including MB samples, the outgoing shot
rendered as prevTex, and post**; isolated renders of stateful frames get ≤ 20 s of replay.
Post at 1080p (measured, SwiftShader): **≈0.21–0.27 s with bloom 0** (composite + HUD), **≈0.45–0.55 s
with bloom**, ≈0.6–0.67 s with bloom + CA + shake (the 480 cut). §2.4's "≈0.34 s" is low for bloom
shots: budget an HDR shot with bloom and MB 6 as 6 × render + ≈0.1 s averaging + ≈0.5 s post.
Guidelines: raymarch
≤ 96 steps, or march at half resolution into a smaller FBO and upsample; fluid sims ≤ 512×288 with
≤ 20 Jacobi iterations; particles ≤ 250k points; avoid huge loops per pixel; canvas2D text redraw per
frame is fine (never use canvas `filter` on a full-frame canvas: ≈270 ms per `fillText`).
Stateful shots are replayed from their first frame when rendering an isolated frame, so keep
`step()` cheap (sims only, no heavy composites).

## Testing a shot

```
node tools/render.mjs --shot <id> --step 6 --sheet --out out/<id>      # every 6th frame + contact sheet
node tools/render.mjs --frames 120,121,122 --out out/<id>-cut          # specific frames
node tools/render.mjs --shot <id> --step 6 --sheet --scale 0.5 ...     # faster half-res preview
node tools/render.mjs --frames 95,96 --clean --out out/contract        # acceptance (?clean=1)
node tools/render.mjs --test swatch --frames 0 --out out/swatch        # tonemap swatch page
node tools/render.mjs --test flat --query "color=COBALT" --clean --frames 0 --out out/flat
node tools/render.mjs --all --video out/reel.mp4 --workers 2          # delivery: x264 crf 14, yuv420p, -tune animation
```

`--clean` adds `?clean=1`; `--test <name>` loads `src/shots/_test<Name>.js` as the whole timeline
(a test module may instead `export const timeline = [...]`); `--query "k=v&k2=v2"` passes extra page
parameters (`hud=0|1`, `color=…`, and for `_testFlat` `post={json deltas}` e.g.
`post={"shake":[0.004,0.003]}`). Test pages:

| Page | Shows |
|---|---|
| `?test=flat&color=VERM\|COBALT\|BONE\|INK\|GRAPHITE` | full-frame flat linear fill of the token; with `--clean` every pixel must be its exact hex |
| `?test=swatch` | VERM, COBALT, BONE at ×0.5 ×0.75 ×1 ×1.25 ×1.5 ×2 ×2.5 ×3 ×4 ×6 as labelled patches, a ×0→×6 ramp per row, and the warm-white end point |

Look at the PNGs (`out/<id>/f0123.png`, `out/<id>/sheet.png`) with your image viewer / Read tool.
Shader compile errors are printed with numbered source. Always check the per-frame timing it prints.

### Page API (`window.__reel`, for tools)

`ready` (promise), `capture(n)` → PNG data URL, `renderFrame(n)`, `readHDR(n, x, y, w, h)` → linear
RGBA floats of the pre-post image (MB average included; GL coords, origin bottom-left),
`lastPost()` (post params used for the last frame, after clean overrides), `hudState(n)`,
`hudRects()`, `shots`, `timings` (`fontsMs`, `fontFaces`, `initMs`), `clean`, `test`, `hud`, `engine`.
