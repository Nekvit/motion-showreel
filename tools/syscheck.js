// Checks for src/shots/_sys.js, run inside tools/syscheck.html by tools/syscheck.mjs.
// Each export is (ctx, sys) => result object ({report, images, fail}).

const fx = (v, n = 4) => (v == null ? 'null' : typeof v === 'number' ? v.toFixed(n) : String(v));
const pt = (o, n = 4) => (o ? `(${fx(o.x, n)}, ${fx(o.y, n)})${o.r != null ? ' r ' + fx(o.r, n) : ''}` : 'null');

// ─── values: every number the spec gives a check value for ───────────────────
export async function values(ctx, sys) {
  const lines = [], fail = [];
  const row = (label, got, spec, tol) => {
    let status = '';
    if (typeof got === 'number' && typeof spec === 'number') {
      const d = got - spec;
      status = Math.abs(d) <= tol ? 'ok' : 'DIFF';
      status += `  Δ ${d >= 0 ? '+' : ''}${d.toFixed(4)}`;
    }
    lines.push(`${label.padEnd(34)} ${String(typeof got === 'number' ? fx(got) : got).padEnd(28)} spec ${String(spec).padEnd(10)} ${status}`);
  };
  const t0 = performance.now();
  const sum = sys.initSys(ctx);
  const tInit = performance.now() - t0;
  const N = sys.nameLayout(ctx), R = sys.roleLayout(ctx);

  lines.push(`config: name=${ctx.config.name} role=${ctx.config.role} year=${ctx.config.year}   initSys ${tInit.toFixed(0)} ms`);
  lines.push('\n-- palette (linear, exact EOTF) --');
  for (const [k, v] of Object.entries(sys.PAL_LIN)) lines.push(`${k.padEnd(9)} ${sys.PAL[k]}  srgb (${sys.PAL_SRGB[k].map(x => x.toFixed(4)).join(', ')})  lin (${v.map(x => x.toFixed(6)).join(', ')})`);
  lines.push(`KEY3 (${sys.KEY3.map(x => x.toFixed(6)).join(', ')})  KEY2 (${sys.KEY2.map(x => x.toFixed(6)).join(', ')})`);

  lines.push('\n-- font metrics (measured) --');
  lines.push(`cap/em Archivo 850/100 ${fx(sys.capRatio(ctx, sys.NAME_FONT), 5)}  500/100 ${fx(sys.capRatio(ctx, sys.W1_FONT), 5)}  500/125 ${fx(sys.capRatio(ctx, sys.YEAR_FONT), 5)}  Instrument Serif Italic ${fx(sys.capRatio(ctx, sys.SERIF_FONT), 5)}`);

  lines.push('\n-- constants --');
  row('VOL_D0', sys.VOL_D0, 9.514, 0.001);
  row('S_FRONT', sys.S_FRONT, 1.0156, 0.0001);
  row('CAP_V2D', sys.CAP_V2D, 0.5078, 0.0001);
  row('BASE_V2D', sys.BASE_V2D, -0.3047, 0.0001);
  row('stemRatio(850)', sys.stemRatio(850), 0.292, 1e-9);
  row('0.25·STEM(300)', 0.25 * sys.STEM(300), 0.0288, 0.0001);
  row('0.25·STEM(900)', 0.25 * sys.STEM(900), 0.0805, 0.0001);
  row('stemRatio(600)', sys.stemRatio(600), '(interp)', 0);
  row('paperZ(0) / paperZ(168) / paperZ(300)', `${sys.paperZ(0)} / ${sys.paperZ(168).toFixed(4)} / ${sys.paperZ(300).toFixed(4)}`, '1 / 1.0672', 0);
  row("stationLetter(3), (-1), (8)", `${sys.stationLetter(ctx, 3)} ${sys.stationLetter(ctx, -1)} ${sys.stationLetter(ctx, 8)}`, 'V T K', 0);

  lines.push('\n-- NOTCH / NSTAR --');
  const V = sys.glyphSDF(ctx, sys.stationLetter(ctx, 3));
  row('NOTCH', sys.NOTCH(ctx), 0.8075, 0.0015);
  row('NSTAR.y', sys.NSTAR(ctx).y, 0.104, 0.001);
  row('NSTAR.r', sys.NSTAR(ctx).r, 0.073, 1e-9);
  const vGap = sys.glyphD(V, V.inkCx, sys.NOTCH(ctx)) - sys.BALL_R;
  lines.push(`V meta: w ${V.w} h ${V.h} ox ${V.ox} oy ${V.oy} ink x [${fx(V.inkX0)}, ${fx(V.inkX1)}] y [${fx(V.inkY0)}, ${fx(V.inkY1)}] inkCx ${fx(V.inkCx)} adv ${fx(V.adv)}; glyphD at rest − r = ${vGap.toExponential(2)}`);
  // contact: the ball must touch both walls (min glyphD on its rim, left half and right half ≈ 0)
  {
    const y = sys.NOTCH(ctx), r = sys.BALL_R, side = (a0, a1) => { let best = [0, 1e9]; for (let a = a0; a < a1; a += 0.05) { const t = a * Math.PI / 180, d = sys.glyphD(V, V.inkCx + r * Math.cos(t), y + r * Math.sin(t)); if (d < best[1]) best = [a, d]; } return best; };
    const L = side(90, 270), Rt = side(270, 450);
    lines.push(`ball rim min glyphD: left wall ${L[1].toExponential(2)} cap at ${L[0].toFixed(1)}°, right wall ${Rt[1].toExponential(2)} cap at ${(Rt[0] % 360).toFixed(1)}° (both ≈ 0 = touching, none < 0 = no penetration)`);
  }
  {
    const xy = sys.notchRestXY(V, sys.BALL_R), xy17 = sys.notchRestXY(V, 0.17);
    lines.push(`notchRestXY (two-wall rest, alternative to spec NOTCH): r 0.146 → dx ${xy.dx.toFixed(4)} y ${xy.y.toFixed(4)};  r 0.17 → dx ${xy17.dx.toFixed(4)} y ${xy17.y.toFixed(4)}`);
  }
  {
    // lens OUT: NSTAR disc (r 0.073, z = 0 plane) inside the 2D V drawn at the FRONT-face scale
    const pl = sys.placeGlyph(V, sys.CAP_V2D, sys.BASE_V2D, 0), ns = sys.NSTAR(ctx);
    let mn = 1e9; for (let a = 0; a < 360; a += 0.1) { const t = a * Math.PI / 180; mn = Math.min(mn, pl.d(ns.x + ns.r * Math.cos(t), ns.y + ns.r * Math.sin(t))); }
    const restOn2D = sys.BASE_V2D + sys.CAP_V2D * sys.vNotchRest(V, ns.r / sys.CAP_V2D);
    lines.push(`NSTAR disc vs 2D V at CAP_V2D/BASE_V2D: min wall distance on the disc rim ${(mn * 1080).toFixed(2)} px (negative = overlap); a 0.073 ball would rest on that V at y ${restOn2D.toFixed(4)} (NSTAR ${ns.y.toFixed(4)}, Δ ${((restOn2D - ns.y) * 1080).toFixed(2)} px)`);
  }
  lines.push('\n-- roleLayout --');
  row('w1 text', R.w1.text, 'MOTION', 0);
  row('w1 rest advance', R.w1.adv, 1.404, 0.005);
  row('w1 size (em, H)', R.w1.size, 0.24 / 0.686, 0.001);
  row('w2 text', R.w2 && R.w2.text, 'desıgn', 0);
  row('fs', R.fs, 0.24 / 0.72, 0.0005);
  row('w2.x1 = w1.x1', `${fx(R.w2 && R.w2.x1)} = ${fx(R.w1.x1)}`, '', 0);
  row('x_ı (pen)', R.w2 && R.w2.xI, 0.303, 0.005);
  row('tittle.x', R.tittle && R.tittle.x, 0.373, 0.005);
  row('tittle.y', R.tittle && R.tittle.y, -0.081, 0.001);
  row('tittle.r', R.tittle && R.tittle.r, 0.0172, 0.0002);
  row('T_DOT', pt(sys.T_DOT(ctx)), '(tittle)', 0);

  lines.push('\n-- nameLayout --');
  row('name', N.name, 'NEKVIT', 0);
  row('blockW @cap 0.20', N.blockW, 1.21, 0.02);
  row('cap', N.cap, 0.20, 1e-9);
  row('inkLeft', N.inkLeft, -0.623, 0.005);
  row('dot.x', N.dot.x, 0.589, 0.005);
  row('dot.y', N.dot.y, 0.054, 1e-6);
  row('dot.r', N.dot.r, 0.034, 1e-6);
  row('S0.x', N.S0.x, -0.698, 0.005);
  row('S0.y', N.S0.y, 0.054, 1e-6);
  row('rule.y', N.rule.y, -0.065, 1e-6);
  row('rule.x0 / x1', `${fx(N.rule.x0)} / ${fx(N.rule.x1)}`, '', 0);
  row('role baseline', N.role.baseline, -0.16, 1e-6);
  row('role cap', N.role.cap, 0.055, 1e-6);
  row('role pen x / ink-left', `${fx(N.role.x)} / ${fx(N.role.inkL)}`, '', 0);
  row('year cap', N.year.cap, 0.040, 1e-6);
  row('year x0 / x1 (ink right)', `${fx(N.year.x0)} / ${fx(N.year.x1)}`, '', 0);
  row('block centre (x0+x1)/2', (N.blockX0 + N.blockX1) / 2, 0, 1e-9);
  row('Δ (delta)', N.delta, 6, 0);
  row('touch frames', N.touchFrames.join(','), '720..750', 0);
  lines.push('glyphs:');
  for (const g of N.glyphs) {
    const yT = N.yTouch[g.i], rel = (yT - N.yb) / N.cap;
    lines.push(`  ${g.ch}  penX ${fx(g.penX)} adv ${fx(g.adv)} inkL ${fx(g.inkL)} inkR ${fx(g.inkR)} cx ${fx(g.cx)}  yTouch ${fx(yT)} (= yb + ${fx(rel)}·cap)  t=${N.touches[g.i].frame} ${N.touches[g.i].fig}`);
  }
  const iV = N.letters.indexOf('V');
  if (iV >= 0) row('yTouch V (cap units above yb)', (N.yTouch[iV] - N.yb) / N.cap, 0.89, 0.01);
  // kerning from the layout, in font units /1000 em
  {
    const pairs = [];
    for (let i = 0; i + 1 < N.n; i++) {
      const a = N.glyphs[i], b = N.glyphs[i + 1];
      const kern = ((b.penX - a.penX) - a.meta.adv * N.cap) / N.size * 1000;
      pairs.push(`${a.ch}${b.ch} ${kern.toFixed(1)}`);
    }
    lines.push('kerning (1/1000 em): ' + pairs.join('  '));
  }

  lines.push('\n-- O_K (lens) --');
  {
    const K = sys.glyphSDF(ctx, sys.stationLetter(ctx, 2));
    const ok = sys.scanInk(K, 0.5, K.inkX1, K.inkCx);
    row('O_K.x (cap, from pen)', ok, 0.824, 0.01);
    lines.push(`K ink x [${fx(K.inkX0)}, ${fx(K.inkX1)}] inkCx ${fx(K.inkCx)} adv ${fx(K.adv)}`);
  }

  lines.push('\n-- tittle constants vs the real Instrument Serif Italic i-dot --');
  {
    const S = 1000, fs = ctx.text.font({ family: 'Instrument Serif', weight: 400, size: S, italic: true });
    const ras = s => { const c = document.createElement('canvas'); c.width = 1000; c.height = 1300; const g = c.getContext('2d'); g.font = fs; g.fillStyle = '#fff'; g.fillText(s, 200, 1100); return g.getImageData(0, 0, 1000, 1300).data; };
    const a = ras('i'), b = ras('ı');
    let A = 0, sx = 0, sy = 0;
    for (let y = 0; y < 1300; y++) for (let x = 0; x < 1000; x++) { const k = (y * 1000 + x) * 4 + 3; const d = Math.max(0, a[k] - b[k]) / 255; if (d) { A += d; sx += d * (x + 0.5); sy += d * (y + 0.5); } }
    const m = { x: (sx / A - 200) / S, y: (1100 - sy / A) / S, r: Math.sqrt(A / Math.PI) / S };
    row('i-dot centroid x (em)', m.x, sys.TITTLE_EM.x, 0.0005);
    row('i-dot centroid y (em)', m.y, sys.TITTLE_EM.y, 0.0005);
    row('i-dot area radius (em)', m.r, sys.TITTLE_EM.r, 0.0005);
  }

  lines.push('\n-- SDF accuracy (analytic rect + circle, fractional edges) --');
  {
    const w = 400, h = 300; const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(100.3, 80.7, 150.25, 120.5);
    g.beginPath(); g.arc(320.4, 150.6, 50.3, 0, Math.PI * 2); g.fill();
    const sdR = (x, y) => { const dx = Math.abs(x - 175.425) - 75.125, dy = Math.abs(y - 140.95) - 60.25; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0); };
    const truth = (x, y) => Math.min(sdR(x, y), Math.hypot(x - 320.4, y - 150.6) - 50.3);
    const img = g.getImageData(0, 0, w, h).data, al = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) al[i] = img[i * 4 + 3] / 255;
    const tA = performance.now(); const mine = sys.sdfFromAlpha(al, w, h); const tMine = performance.now() - tA;
    const old = ctx.text.sdfTexture(ctx.gl, c);
    const stats = get => { let n = 0, s = 0, sa = 0, mx = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = truth(x + 0.5, y + 0.5); if (Math.abs(t) > 40) continue; const e = get(x, y) - t; n++; s += e; sa += Math.abs(e); mx = Math.max(mx, Math.abs(e)); } return `mean ${(s / n).toFixed(3)} px  mean|e| ${(sa / n).toFixed(3)} px  max|e| ${mx.toFixed(3)} px`; };
    lines.push(`sys.sdfFromAlpha     ${stats((x, y) => mine[y * w + x])}   (${tMine.toFixed(0)} ms, ${w}x${h})`);
    lines.push(`ctx.text.sdfTexture  ${stats((x, y) => old.data[((h - 1 - y) * w + x) * 4])}`);
    ctx.gl.deleteTexture(old.tex);
  }

  lines.push('\n-- halftone radius (JS) --');
  lines.push([0, 0.1, 0.35, 0.5, 0.785, 0.9, 0.99, 1].map(c => `${c}→${sys.halftoneRho(c).toFixed(4)}`).join('  '));

  // timings
  {
    const t = performance.now(); sys.glyphSDF(ctx, 'Q'); const tq = performance.now() - t;
    lines.push(`\nglyphSDF('Q') build ${tq.toFixed(0)} ms`);
  }
  return { report: lines.join('\n'), fail, summary: { NOTCH: sum.NOTCH, NSTAR: sum.NSTAR, T_DOT: sum.T_DOT } };
}

// ─── gpu: SYS_GLSL compiles in any include order; GPU glyphD == CPU glyphD; halftone coverage ──
function readFloat(ctx, fbo) {
  const gl = ctx.gl; fbo.bind();
  const buf = new Float32Array(fbo.w * fbo.h * 4);
  gl.readPixels(0, 0, fbo.w, fbo.h, gl.RGBA, gl.FLOAT, buf);
  return buf;
}
export async function gpu(ctx, sys) {
  const gl = ctx.gl, lines = [], fail = [];
  const F32 = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST };
  // 1. include orders
  const body = `uniform sampler2D uGlyphTex; uniform vec4 uGlyphMeta; in vec2 vUv; out vec4 o;
    void main(){ vec2 p=P(vUv,1.7778); o=vec4(paperFibre(p)+halftone45(p,8.0,0.35)+glyphD(uGlyphTex,uGlyphMeta,p)+palDisperse(INK,BONE).r+KEY3.x+C_MOD, 0,0,1); }`;
  for (const [label, src] of [['all+SYS', ctx.glsl.all + sys.SYS_GLSL + body], ['SYS+all', sys.SYS_GLSL + ctx.glsl.all + body], ['SYS+SYS', sys.SYS_GLSL + sys.SYS_GLSL + body], ['SYS only', sys.SYS_GLSL + body]]) {
    try { ctx.program(src, 'sys:' + label); lines.push(`compile ${label}: ok`); } catch (e) { lines.push(`compile ${label}: FAIL ${e.message}`); fail.push('compile ' + label); }
  }
  // 2. GPU vs CPU glyphD over a grid of q (inside, edge, far outside the texture)
  for (const ch of ['V', 'K', 'N']) {
    const m = sys.glyphSDF(ctx, ch);
    const n = 96, fbo = ctx.fbo(n, n, F32);
    const prog = ctx.program(`${sys.SYS_GLSL}
      uniform sampler2D uGlyphTex; uniform vec4 uGlyphMeta; uniform vec4 uBox; in vec2 vUv; out vec4 o;
      void main(){ vec2 q = uBox.xy + (gl_FragCoord.xy/96.0)*(uBox.zw-uBox.xy); o = vec4(glyphD(uGlyphTex,uGlyphMeta,q), q, 1.0); }`, 'sys:glyphD');
    const box = [-1.2, -1.0, m.adv + 1.2, 2.2];
    ctx.draw(prog, { ...sys.glyphUniforms(m), uBox: box }, fbo);
    const buf = readFloat(ctx, fbo);
    let mx = 0, mxNear = 0, worst = null;
    for (let i = 0; i < n * n; i++) {
      const g = buf[i * 4], qx = buf[i * 4 + 1], qy = buf[i * 4 + 2];
      const c = sys.glyphD(m, qx, qy), e = Math.abs(g - c);
      if (e > mx) { mx = e; worst = [qx, qy, g, c]; }
      if (Math.abs(c) < 0.1) mxNear = Math.max(mxNear, e);
    }
    lines.push(`glyphD GPU vs CPU '${ch}': max|Δ| ${mx.toExponential(2)} cap (${(mx * m.capPx).toFixed(4)} px), near edge ${(mxNear * m.capPx).toFixed(4)} px; worst at q (${worst[0].toFixed(3)}, ${worst[1].toFixed(3)}) gpu ${worst[2].toFixed(5)} cpu ${worst[3].toFixed(5)}`);
    if (mx * m.capPx > 0.05) fail.push('glyphD mismatch ' + ch);
  }
  // 3. halftone mean coverage vs cover, at 1080p design scale (p = fragCoord/1080) and half scale
  {
    const n = 480, fbo = ctx.fbo(n, n, F32);
    const prog = ctx.program(`${sys.SYS_GLSL}
      uniform float uCover, uCell, uScale; in vec2 vUv; out vec4 o;
      void main(){ vec2 p = (gl_FragCoord.xy - 240.0) / (1080.0*uScale); o = vec4(halftone45(p, uCell, uCover), halftoneRho(uCover), 0, 1); }`, 'sys:ht');
    const res = [];
    for (const [cell, scale] of [[8, 1], [12, 1], [6, 0.5]]) {
      const parts = [];
      for (const cover of [0.05, 0.2, 0.35, 0.5, 0.7, 0.785, 0.9, 0.97, 1]) {
        ctx.draw(prog, { uCover: cover, uCell: cell, uScale: scale }, fbo);
        const b = readFloat(ctx, fbo); let s = 0; for (let i = 0; i < n * n; i++) s += b[i * 4];
        const mean = s / (n * n);
        parts.push(`${cover}→${mean.toFixed(3)}`);
        const tol = cover <= 0.7 ? 0.006 : 0.02;   // separate dots: exact; merged regime: AA cusp deficit
        if (scale === 1 && Math.abs(mean - cover) > tol) fail.push(`halftone cover ${cover} cell ${cell} scale ${scale}: ${mean.toFixed(3)}`);
      }
      res.push(`cell ${cell}px scale ${scale}: ${parts.join(' ')}`);
    }
    lines.push('halftone45 mean coverage (requested→measured):\n  ' + res.join('\n  '));
  }
  // 4. palette constants round-trip through GLSL and exact OETF
  {
    const fbo = ctx.fbo(8, 1, F32);
    const prog = ctx.program(`${sys.SYS_GLSL} in vec2 vUv; out vec4 o;
      void main(){ int i=int(gl_FragCoord.x); vec3 c = i==0?INK: i==1?BONE: i==2?VERM: i==3?COBALT: i==4?GRAPHITE: i==5?WARM: vec3(0); o=vec4(c,1); }`, 'sys:pal');
    ctx.draw(prog, {}, fbo);
    const b = readFloat(ctx, fbo);
    const names = ['INK', 'BONE', 'VERM', 'COBALT', 'GRAPHITE'];
    const parts = names.map((k, i) => {
      const lin = [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]];
      const hex = '#' + lin.map(v => Math.round(sys.linearToSrgb(v) * 255).toString(16).padStart(2, '0').toUpperCase()).join('');
      const ok = hex === sys.PAL[k];
      if (!ok) fail.push('palette ' + k);
      return `${k} ${hex}${ok ? ' ok' : ' MISMATCH vs ' + sys.PAL[k]}`;
    });
    lines.push('GLSL palette → exact OETF → hex: ' + parts.join(', '));
  }
  // 5. paper fibre statistics (and clean)
  {
    const n = 512, fbo = ctx.fbo(n, n, F32);
    const prog = ctx.program(`${sys.SYS_GLSL} in vec2 vUv; out vec4 o;
      void main(){ vec2 p = (gl_FragCoord.xy/512.0 - 0.5) * vec2(1.7778, 1.0); o = vec4(paperFibre(p), 0, 0, 1); }`, 'sys:fibre');
    for (const clean of [0, 1]) {
      ctx.draw(prog, { uSysClean: clean }, fbo);
      const b = readFloat(ctx, fbo); let mn = 1, mx = -1, s = 0;
      for (let i = 0; i < n * n; i++) { const v = b[i * 4]; mn = Math.min(mn, v); mx = Math.max(mx, v); s += v; }
      lines.push(`paperFibre uSysClean=${clean}: min ${mn.toFixed(4)} max ${mx.toFixed(4)} mean ${(s / n / n).toFixed(4)}`);
      if (clean && (mn !== 0 || mx !== 0)) fail.push('fibre not zero in clean');
      if (!clean && (mn < -0.0151 || mx > 0.0151)) fail.push('fibre out of range');
    }
  }
  // 6. palDisperse identities
  {
    const fbo = ctx.fbo(4, 1, F32);
    const prog = ctx.program(`${sys.SYS_GLSL} in vec2 vUv; out vec4 o;
      void main(){ int i=int(gl_FragCoord.x); vec3 c = i==0? palDisperse(BONE,BONE) : i==1? palDisperse(BONE,INK) : i==2? palDisperse(INK,BONE) : vec3(0); o=vec4(c,1); }`, 'sys:disp');
    ctx.draw(prog, {}, fbo);
    const b = readFloat(ctx, fbo);
    const v = i => `(${[0, 1, 2].map(k => b[i * 4 + k].toFixed(3)).join(', ')})`;
    lines.push(`palDisperse(BONE,BONE) ${v(0)} (= BONE)  (BONE,INK) ${v(1)} (VERM-leaning)  (INK,BONE) ${v(2)} (COBALT-leaning)`);
  }
  return { report: lines.join('\n'), fail };
}

// ─── overlay: debug images of nameLayout / roleLayout over real type ─────────
function glOutlines(ctx, sys, placements, colorRGB, widthPx = 1.2) {
  // GL pass: outline |d| < widthPx/2 of several placed glyphs (via SYS_GLSL glyphDist) → ImageData (alpha mask)
  const gl = ctx.gl, W = ctx.W, H = ctx.H, n = placements.length;
  let decl = '', body = 'float d = 1e9;\n';
  for (let i = 0; i < n; i++) { decl += sys.glyphUniformDecl('uG' + i); body += `d = min(d, glyphDist(uG${i}Tex, uG${i}Meta, uG${i}Place, p));\n`; }
  const prog = ctx.program(`${sys.SYS_GLSL}${decl} uniform float uW; in vec2 vUv; out vec4 o;
    void main(){ vec2 p = P(vUv, ${(W / H).toFixed(6)}); ${body}
      float px = d * ${H.toFixed(1)}; float a = clamp(uW*0.5 + 0.5 - abs(px), 0.0, 1.0); o = vec4(a, a, a, 1.0); }`, 'sys:outline');
  let uni = { uW: widthPx };
  placements.forEach((pl, i) => Object.assign(uni, pl.uniforms('uG' + i)));
  gl.clearColor(0, 0, 0, 1);
  ctx.draw(prog, uni, null);
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4;
    img.data[d] = colorRGB[0]; img.data[d + 1] = colorRGB[1]; img.data[d + 2] = colorRGB[2]; img.data[d + 3] = buf[s];
  }
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

export async function overlay(ctx, sys) {
  const W = ctx.W, H = ctx.H, P = sys.PAL, lines = [];
  const X = x => W / 2 + x * H, Y = y => H / 2 - y * H;
  const N = sys.nameLayout(ctx), R = sys.roleLayout(ctx);
  const mk = bg => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, W, H); return [c, g]; };
  const font = (spec, sizeH) => ctx.text.font({ ...spec, size: sizeH * H });
  const circle = (g, x, y, r, fill, stroke, lw = 1) => { g.beginPath(); g.arc(X(x), Y(y), r * H, 0, Math.PI * 2); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
  const hline = (g, y, x0, x1, col, lw = 1, dash = []) => { g.save(); g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(X(x0), Y(y)); g.lineTo(X(x1), Y(y)); g.stroke(); g.restore(); };
  const vline = (g, x, y0, y1, col, lw = 1, dash = []) => { g.save(); g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(X(x), Y(y0)); g.lineTo(X(x), Y(y1)); g.stroke(); g.restore(); };
  const label = (g, s, x, y, col = '#444', size = 13) => { g.font = `500 ${size}px "JetBrains Mono"`; g.fillStyle = col; g.fillText(s, X(x), Y(y)); };

  // ── image 1: title layout (nameLayout) on Bone ──
  const [c1, g1] = mk(P.BONE);
  // module grid, faint
  g1.strokeStyle = 'rgba(14,14,18,0.07)'; g1.lineWidth = 1;
  for (let k = -16; k <= 16; k++) { g1.beginPath(); g1.moveTo(X(k / 18) + 0.5, 0); g1.lineTo(X(k / 18) + 0.5, H); g1.stroke(); }
  for (let k = -9; k <= 9; k++) { g1.beginPath(); g1.moveTo(0, Y(k / 18) + 0.5); g1.lineTo(W, Y(k / 18) + 0.5); g1.stroke(); }
  g1.strokeStyle = 'rgba(34,51,255,0.35)'; g1.strokeRect(X(-0.8), Y(0.45), 1.6 * H, 0.9 * H);   // title safe
  // name, glyph by glyph at the layout pen positions
  g1.fillStyle = P.INK; g1.font = font(sys.NAME_FONT, N.size);
  for (const gl of N.glyphs) g1.fillText(gl.ch, X(gl.penX), Y(N.yb));
  // role + year
  g1.font = font(sys.SERIF_FONT, N.role.size);
  for (const gl of N.role.glyphs) g1.fillText(gl.ch, X(gl.x), Y(N.role.baseline));
  g1.font = font(sys.YEAR_FONT, N.year.size);
  for (const gl of N.year.glyphs) g1.fillText(gl.ch, X(gl.x), Y(N.year.baseline));
  // rule (4px, centred on rule.y) and the dot
  g1.fillStyle = P.VERM; g1.fillRect(X(N.rule.x0), Y(N.rule.y) - N.rule.wPx * ctx.scale / 2, (N.rule.x1 - N.rule.x0) * H, N.rule.wPx * ctx.scale);
  circle(g1, N.dot.x, N.dot.y, N.dot.r, P.VERM);
  // GL glyphD outlines of the same glyphs (cobalt): must hug the canvas type
  const outl = glOutlines(ctx, sys, N.glyphs.map(gl => gl.place), [34, 51, 255], 1.4);
  g1.drawImage(outl, 0, 0);
  // annotations
  for (const gl of N.glyphs) {
    g1.strokeStyle = 'rgba(0,160,90,0.9)'; g1.lineWidth = 1;
    g1.strokeRect(X(gl.inkL), Y(gl.inkT), (gl.inkR - gl.inkL) * H, (gl.inkT - gl.inkB) * H);
    vline(g1, gl.cx, N.yb - 0.03, N.yb + 0.26, 'rgba(0,160,90,0.9)', 1, [4, 3]);
    vline(g1, gl.penX, N.yb - 0.012, N.yb + 0.0, '#000', 1);
    const t = N.touches[gl.i];
    circle(g1, t.x, t.y, N.dot.r, 'rgba(255,58,31,0.25)', P.VERM, 1.5);
    circle(g1, t.x, t.y, 0.0015, P.VERM);
    label(g1, `${gl.ch} f${t.frame} y${(t.y).toFixed(3)}`, gl.cx - 0.045, N.yb + 0.3, '#333', 12);
  }
  circle(g1, N.S0.x, N.S0.y, N.S0.r, null, P.VERM, 2); label(g1, 'S0', N.S0.x - 0.012, N.S0.y + 0.05, P.VERM);
  hline(g1, N.yb, -0.85, 0.85, 'rgba(0,0,0,0.25)', 1, [2, 4]);
  vline(g1, 0, -0.45, 0.45, 'rgba(34,51,255,0.3)', 1, [6, 6]);
  vline(g1, N.blockX0, -0.2, 0.3, 'rgba(255,58,31,0.6)', 1, [3, 3]); vline(g1, N.blockX1, -0.2, 0.3, 'rgba(255,58,31,0.6)', 1, [3, 3]);
  label(g1, `nameLayout: cap ${N.cap.toFixed(4)} blockW ${N.blockW.toFixed(4)} inkLeft ${N.inkLeft.toFixed(4)} dot (${N.dot.x.toFixed(4)}, ${N.dot.y.toFixed(4)}) r ${N.dot.r.toFixed(4)} S0 (${N.S0.x.toFixed(4)}, ${N.S0.y.toFixed(4)}) rule y ${N.rule.y.toFixed(4)}`, -0.86, -0.40, '#222', 14);
  label(g1, `green: ink boxes + ink centres (from glyphSDF raster) · blue: GLSL glyphDist outline (placeGlyph) · red rings: touch balls r ${N.dot.r.toFixed(3)} at (cx, yTouch)`, -0.86, -0.43, '#222', 14);

  // ── image 2: roleLayout on Ink (lens rest) ──
  const [c2, g2] = mk(P.INK);
  hline(g2, 0, -0.889, 0.889, P.BONE, 2); hline(g2, -0.30, -0.889, 0.889, P.BONE, 2);
  g2.fillStyle = P.BONE; g2.font = font(R.w1.font, R.w1.size);
  for (const gl of R.w1.glyphs) g2.fillText(gl.ch, X(gl.x), Y(0));
  if (R.w2) { g2.font = font(R.w2.font, R.w2.size); for (const gl of R.w2.glyphs) g2.fillText(gl.ch, X(gl.x), Y(-0.30)); }
  const TD = R.T_DOT;
  circle(g2, TD.x, TD.y, TD.r, P.VERM);
  // ghost of a real 'i' at the ı pen position (cobalt, 45% alpha): its dot must coincide with the tittle
  if (R.w2 && R.w2.xI != null) { g2.save(); g2.globalAlpha = 0.45; g2.fillStyle = P.COBALT; g2.font = font(R.w2.font, R.w2.size); g2.fillText('i', X(R.w2.xI), Y(-0.30)); g2.restore(); }
  // advance boxes
  g2.strokeStyle = 'rgba(0,200,120,0.8)'; g2.lineWidth = 1;
  g2.strokeRect(X(R.w1.x0), Y(0.24), R.w1.adv * H, 0.24 * H);
  if (R.w2) g2.strokeRect(X(R.w2.x0), Y(-0.30 + 0.24), R.w2.adv * H, 0.24 * H);
  vline(g2, 0, -0.45, 0.45, 'rgba(241,235,223,0.25)', 1, [6, 6]);
  label(g2, `roleLayout: w1 ${R.w1.text} adv ${R.w1.adv.toFixed(4)} [${R.w1.x0.toFixed(4)}, ${R.w1.x1.toFixed(4)}]  w2 ${R.w2 ? R.w2.text : '-'} [${R.w2 ? R.w2.x0.toFixed(4) : ''}, ${R.w2 ? R.w2.x1.toFixed(4) : ''}] fs ${R.fs.toFixed(4)}`, -0.86, -0.40, '#ccc', 14);
  label(g2, `T_DOT (${TD.x.toFixed(4)}, ${TD.y.toFixed(4)}) r ${TD.r.toFixed(4)} · cobalt ghost = a real Instrument Serif Italic 'i' at the ı pen position`, -0.86, -0.43, '#ccc', 14);

  // ── image 3: zoomed crops (4×) ──
  const zoom = (src, cx, cy, halfH, k = 4) => {
    const s = halfH * H * 2, c = document.createElement('canvas'); c.width = Math.round(s * k); c.height = Math.round(s * k);
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.drawImage(src, X(cx) - s / 2, Y(cy) - s / 2, s, s, 0, 0, c.width, c.height); return c;
  };
  const iT = N.glyphs.length - 1, iV = N.letters.indexOf('V'), iN = 0, iK = N.letters.indexOf('K');
  const crops = [
    ['tittle', zoom(c2, TD.x, TD.y - 0.02, 0.06)],
    ['T + full stop', zoom(c1, N.dot.x - 0.05, N.yb + 0.08, 0.12, 2.5)],
    ['V touch', zoom(c1, N.touches[iV >= 0 ? iV : 0].x, N.touches[iV >= 0 ? iV : 0].y - 0.02, 0.07)],
    ['N touch', zoom(c1, N.touches[iN].x, N.touches[iN].y - 0.02, 0.07)],
    ['K touch', zoom(c1, N.touches[iK >= 0 ? iK : 1].x, N.touches[iK >= 0 ? iK : 1].y - 0.02, 0.07)],
  ];
  const cw = crops.reduce((s, [, c]) => s + c.width + 12, 12), ch = Math.max(...crops.map(([, c]) => c.height)) + 40;
  const c3 = document.createElement('canvas'); c3.width = cw; c3.height = ch; const g3 = c3.getContext('2d');
  g3.fillStyle = '#777'; g3.fillRect(0, 0, cw, ch);
  let xo = 12; for (const [name, c] of crops) { g3.drawImage(c, xo, 30); g3.font = '500 16px "JetBrains Mono"'; g3.fillStyle = '#fff'; g3.fillText(name, xo, 20); xo += c.width + 12; }

  // ── image 4: GL visual: V + notch ball, O_K, palette, halftone, fibre ──
  const gl = ctx.gl;
  const V = sys.glyphSDF(ctx, sys.stationLetter(ctx, 3)), K = sys.glyphSDF(ctx, sys.stationLetter(ctx, 2));
  const NOTCH = sys.NOTCH(ctx), NS = sys.NSTAR(ctx);
  const OK = sys.scanInk(K, 0.5, K.inkX1, K.inkCx) ?? K.inkCx;
  const pV = sys.placeGlyph(V, sys.CAP_V2D, sys.BASE_V2D, 0);           // lens OUT: 2D V at front-face scale
  const pBig = sys.placeGlyph(V, 0.62, -0.36, -0.52);                     // big V with the 0.146 ball at NOTCH
  const pK = sys.placeGlyph(K, 0.30, 0.10, 0.60);
  const prog = ctx.program(`${sys.SYS_GLSL}${sys.glyphUniformDecl('uV')}${sys.glyphUniformDecl('uB')}${sys.glyphUniformDecl('uK')}
    uniform vec3 uBall, uNstar, uOK; in vec2 vUv; out vec4 o;
    void main(){
      vec2 p = P(vUv, ${(W / H).toFixed(6)});
      float px = 1.0/${H.toFixed(1)};
      vec3 col = BONE * (1.0 + paperFibre(p));
      // palette swatches (top left)
      if (p.y > 0.36 && p.x < -0.30) { float k = floor((p.x + 0.889) / 0.118); col = k < 1.0 ? INK : k < 2.0 ? BONE : k < 3.0 ? VERM : k < 4.0 ? COBALT : GRAPHITE; }
      // halftone swatches (row under): cover 0.1 .. 1.0, 8px cells, INK on BONE
      if (p.y > 0.26 && p.y < 0.34 && p.x < -0.30) { float k = floor((p.x + 0.889) / 0.0589); float cov = (k + 1.0) / 10.0; col = mix(col, INK, halftone45(p, 8.0, cov)); }
      // big V (INK) + ball of r 0.146 cap at NOTCH (VERM) + contact check ring
      float dB = glyphDist(uBTex, uBMeta, uBPlace, p);
      col = mix(col, INK, clamp(0.5 - dB/px, 0.0, 1.0));
      float dBall = length(p - uBall.xy) - uBall.z;
      col = mix(col, VERM, clamp(0.5 - dBall/px, 0.0, 1.0));
      // 2D glass-V stand-in at CAP_V2D / BASE_V2D (outline only, COBALT) + NSTAR disc (lens OUT)
      float dV = glyphDist(uVTex, uVMeta, uVPlace, p);
      col = mix(col, COBALT, clamp(1.5 - abs(dV)/px, 0.0, 1.0));
      col = mix(col, VERM, clamp(0.5 - (length(p - uNstar.xy) - uNstar.z)/px, 0.0, 1.0));
      // K with its 45° halftone shadow (+6,-6 px, 35%) and the O_K marker
      float dKs = glyphDist(uKTex, uKMeta, uKPlace, p - vec2(6.0, -6.0)*px);
      col = mix(col, INK, clamp(0.5 - dKs/px, 0.0, 1.0) * halftone45(p, 8.0, 0.35));
      float dK = glyphDist(uKTex, uKMeta, uKPlace, p);
      col = mix(col, INK, clamp(0.5 - dK/px, 0.0, 1.0));
      col = mix(col, VERM, clamp(0.5 - (length(p - uOK.xy) - uOK.z)/px, 0.0, 1.0));
      o = vec4(pow(col, vec3(1.0/2.4)), 1.0);   // approx display encode for the debug image
    }`, 'sys:visual');
  const ball = pBig.p(V.inkCx, NOTCH);
  const okP = pK.p(OK, 0.5);
  ctx.draw(prog, { ...pV.uniforms('uV'), ...pBig.uniforms('uB'), ...pK.uniforms('uK'), uBall: [ball[0], ball[1], sys.BALL_R * 0.62], uNstar: [NS.x, NS.y, NS.r], uOK: [okP[0], okP[1], 0.006], ...sys.sysUniforms(ctx) }, null);
  const c4 = document.createElement('canvas'); c4.width = W; c4.height = H; const g4 = c4.getContext('2d');
  g4.drawImage(ctx.gl.canvas, 0, 0);
  label(g4, `big V: ball r 0.146 cap at NOTCH ${NOTCH.toFixed(4)} (must touch both walls) · centre: 2D V outline at CAP_V2D ${sys.CAP_V2D.toFixed(4)} / BASE_V2D ${sys.BASE_V2D.toFixed(4)} + NSTAR disc (${NS.x}, ${NS.y.toFixed(4)}) r ${NS.r}`, -0.86, -0.43, '#222', 14);
  label(g4, `K: O_K = ${OK.toFixed(4)} cap (red dot, on q.y 0.5) · K shadow: +6,-6px 45° halftone 8px 35% · top: palette, halftone45 cover 0.1…1.0`, -0.86, -0.46, '#222', 14);
  const vz = zoom(c4, ball[0], ball[1] - 0.03, 0.12, 3);

  return { report: lines.join('\n') || 'images written', images: { name_overlay: c1.toDataURL(), role_overlay: c2.toDataURL(), zoom: c3.toDataURL(), gl_visual: c4.toDataURL(), notch_zoom: vz.toDataURL() } };
}
