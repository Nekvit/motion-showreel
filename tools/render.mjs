#!/usr/bin/env node
// Frame-exact renderer for the reel (headless Chromium + WebGL2).
//
//   node tools/render.mjs --frames 0,120,450 --out out/check        # specific frames
//   node tools/render.mjs --range 120-240 --step 4 --out out/shot    # a range
//   node tools/render.mjs --shot fluid-bloom --step 6 --sheet        # a shot + contact sheet
//   node tools/render.mjs --all --video out/reel.mp4                 # full reel -> MP4 (+audio)
//
//   node tools/render.mjs --test flat --query "color=VERM" --clean --frames 0   # a test page
//
// Options: --scale 0.5 (render resolution), --workers N (parallel pages over
// contiguous chunks), --sheet (contact sheet PNG), --cols 6, --quiet,
// --clean (?clean=1: no grain/dither/vignette/paper fibre, for acceptance checks),
// --test <name> (?test=<name>: timeline = src/shots/_test<Name>.js over all frames),
// --query "k=v&k2=v2" (extra page query parameters, e.g. hud=0 or color=COBALT).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };

async function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'];
  for (const c of candidates) { try { return await import(c); } catch { /* next */ } }
  throw new Error('playwright not found: npm i -D playwright');
}

export function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const py = spawnSync('python3', ['-c', 'import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())'], { encoding: 'utf8' });
  if (py.status === 0 && py.stdout.trim()) return py.stdout.trim();
  throw new Error('ffmpeg not found (set FFMPEG, install ffmpeg, or pip install imageio-ffmpeg)');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function main() {
  const scale = parseFloat(opt('scale', '1'));
  const workers = parseInt(opt('workers', '1'), 10);
  const quiet = !!opt('quiet', false);
  const videoOut = opt('video', null);
  const outDir = path.resolve(ROOT, opt('out', videoOut ? 'out/frames' : 'out/render'));
  fs.mkdirSync(outDir, { recursive: true });

  const srv = await serve();
  const qp = new URLSearchParams({ capture: '1', scale: String(scale) });
  if (opt('clean', false)) qp.set('clean', '1');
  if (opt('test', null)) qp.set('test', String(opt('test')));
  if (opt('query', null)) for (const [k, v] of new URLSearchParams(String(opt('query')))) qp.set(k, v);
  const url = `http://127.0.0.1:${srv.address().port}/index.html?${qp}`;
  const { chromium } = await loadPlaywright();
  // --font-render-hinting=none: fractional glyph advances, so continuous wdth/wght animation
  // moves smoothly instead of in whole-pixel steps (and _sys metrics are unquantised).
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds', '--font-render-hinting=none', '--js-flags=--max-old-space-size=4096'] });

  async function openPage() {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
    page.on('pageerror', e => errors.push('[pageerror] ' + (e.stack || e.message)));
    await page.goto(url);
    const ok = await page.evaluate(async () => { try { await window.__reel.ready; return null; } catch (e) { return window.__reel.error || String(e); } });
    if (ok) { console.error('INIT FAILED:\n' + ok + '\n' + errors.join('\n')); process.exitCode = 1; throw new Error('init failed'); }
    return { page, errors };
  }

  const first = await openPage();
  const meta = await first.page.evaluate(() => ({ frames: __reel.frames, fps: __reel.fps, shots: __reel.shots, w: __reel.width, h: __reel.height, timings: __reel.timings }));
  if (!quiet) console.log(`page ready: ${url.replace(/^http:\/\/[^/]+/, '')}  fonts ${Math.round(meta.timings?.fontsMs ?? 0)}ms (${meta.timings?.fontFaces} faces), init ${Math.round(meta.timings?.initMs ?? 0)}ms`);

  let frames = [];
  if (opt('all', false) || videoOut) frames = [...Array(meta.frames).keys()];
  else if (opt('frames', null)) frames = String(opt('frames')).split(',').map(Number);
  else if (opt('range', null)) {
    const [a, b] = String(opt('range')).split('-').map(Number);
    const step = parseInt(opt('step', '1'), 10);
    for (let n = a; n <= b; n += step) frames.push(n);
  } else if (opt('shot', null)) {
    const s = meta.shots.find(s => s.id === opt('shot'));
    if (!s) throw new Error('unknown shot ' + opt('shot') + '; shots: ' + meta.shots.map(s => s.id).join(', '));
    const step = parseInt(opt('step', '6'), 10);
    for (let n = s.start; n < s.end; n += step) frames.push(n);
    if (frames[frames.length - 1] !== s.end - 1) frames.push(s.end - 1);
  } else if (opt('beats', null)) {
    const step = parseInt(opt('step', '30'), 10);
    for (let n = 0; n < meta.frames; n += step) frames.push(n);
  } else {
    console.log('shots:', meta.shots.map(s => `${s.id}[${s.start},${s.end})`).join(' '));
    frames = [0];
  }

  // Split into contiguous chunks so stateful shots replay minimally.
  const chunks = [];
  const per = Math.ceil(frames.length / workers);
  for (let i = 0; i < workers; i++) { const c = frames.slice(i * per, (i + 1) * per); if (c.length) chunks.push(c); }
  const pages = [first];
  for (let i = 1; i < chunks.length; i++) pages.push(await openPage());

  const t0 = Date.now();
  let done = 0;
  const written = [];
  await Promise.all(chunks.map(async (chunk, ci) => {
    const { page, errors } = pages[ci];
    for (const n of chunk) {
      const ts = Date.now();
      const data = await page.evaluate(n => __reel.capture(n), n);
      const file = path.join(outDir, `f${String(n).padStart(4, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      written.push({ n, file });
      done++;
      if (!quiet) {
        const shot = meta.shots.find(s => n >= s.start && n < s.end)?.id;
        const el = (Date.now() - t0) / 1000;
        process.stdout.write(`frame ${n} (${shot}) ${(Date.now() - ts)}ms  [${done}/${frames.length}, eta ${Math.round(el / done * (frames.length - done))}s]\n`);
      }
      if (errors.length) { console.error(errors.splice(0).join('\n')); }
    }
  }));
  await browser.close();
  srv.close();
  written.sort((a, b) => a.n - b.n);
  console.log(`rendered ${written.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(process.cwd(), outDir)}`);

  const ff = videoOut ? ffmpegPath() : null;
  if (opt('sheet', false)) {
    const cols = parseInt(opt('cols', '6'), 10);
    const sheet = path.join(outDir, 'sheet.png');
    execFileSync('python3', [path.join(ROOT, 'tools', 'sheet.py'), sheet, String(cols), ...written.map(w => w.file)], { stdio: 'inherit' });
    console.log('contact sheet ->', path.relative(process.cwd(), sheet), `(tiles in order: ${written.map(w => w.n).join(',')})`);
  }
  if (videoOut) {
    const out = path.resolve(ROOT, videoOut);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const audio = path.join(ROOT, 'audio', 'soundtrack.wav');
    const a = fs.existsSync(audio) ? ['-i', audio] : [];
    execFileSync(ff, ['-y', '-loglevel', 'error', '-framerate', String(meta.fps), '-i', path.join(outDir, 'f%04d.png'), ...a,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tune', 'animation', '-movflags', '+faststart',
      ...(a.length ? ['-c:a', 'aac', '-b:a', '320k', '-shortest'] : []), out], { stdio: 'inherit' });
    console.log('video ->', path.relative(process.cwd(), out));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
