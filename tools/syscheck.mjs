#!/usr/bin/env node
// Headless check runner for src/shots/_sys.js (package 9).
//
//   node tools/syscheck.mjs                      # run all checks, print values, write out/syscheck/*.png
//   node tools/syscheck.mjs --check values       # one named export of tools/syscheck.js
//   node tools/syscheck.mjs --name KAROLINA --role "Art Direction"   # other config
//   node tools/syscheck.mjs --eval probe.js      # run a file's body as an async function in the page
//                                                # (receives `ctx`, `__S` = window.__sys); prints its return value
//   --out dir (default out/syscheck), --clean (sets ctx.clean)
//
// Serves the repo root on a random port, opens tools/syscheck.html in headless
// Chromium (SwiftShader WebGL2, same flags as tools/render.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) { try { return await import(c); } catch { /* next */ } }
  throw new Error('playwright not found');
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
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
  const outDir = path.resolve(ROOT, opt('out', 'out/syscheck'));
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const qs = new URLSearchParams();
  for (const k of ['name', 'role', 'year', 'w', 'h']) if (opt(k, null)) qs.set(k, opt(k));
  if (opt('clean', false)) qs.set('clean', '1');
  const url = `http://127.0.0.1:${srv.address().port}/tools/syscheck.html?${qs}`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds', '--font-render-hinting=none', '--js-flags=--max-old-space-size=4096'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push('[pageerror] ' + (e.stack || e.message)));
  await page.goto(url);
  const err = await page.evaluate(async () => { try { await window.__sys.ready; return null; } catch (e) { return window.__sys.error || String(e); } });
  const flush = () => { if (logs.length) console.log(logs.splice(0).join('\n')); };
  if (err) { flush(); console.error('INIT FAILED\n' + err); process.exit(1); }

  const saveImages = res => {
    if (res && res.images) {
      for (const [name, data] of Object.entries(res.images)) {
        const f = path.join(outDir, name + '.png');
        fs.writeFileSync(f, Buffer.from(data.split(',')[1], 'base64'));
        console.log('wrote', path.relative(process.cwd(), f));
      }
      delete res.images;
    }
    return res;
  };

  try {
    if (opt('eval', null)) {
      const src = fs.readFileSync(path.resolve(process.cwd(), opt('eval')), 'utf8');
      const res = await page.evaluate(async src => {
        const fn = new (Object.getPrototypeOf(async function () {}).constructor)('ctx', '__S', src);
        try { return await fn(window.__sys.ctx, window.__sys); } catch (e) { return { error: String(e.stack || e) }; }
      }, src);
      flush();
      console.log(JSON.stringify(saveImages(res), null, 1));
    } else {
      const checks = opt('check', null) ? [opt('check')] : ['values', 'gpu', 'overlay'];
      for (const c of checks) {
        const t0 = Date.now();
        const res = await page.evaluate(async c => { try { return await window.__sys.run(c); } catch (e) { return { error: String(e.stack || e) }; } }, c);
        flush();
        console.log(`\n=== ${c} (${Date.now() - t0} ms) ===`);
        const r = saveImages(res);
        if (r && r.report) console.log(r.report); else console.log(JSON.stringify(r, null, 1));
        if (r && r.error) process.exitCode = 1;
        if (r && r.fail && r.fail.length) { process.exitCode = 1; console.log('FAIL: ' + r.fail.join('; ')); }
      }
    }
  } finally {
    await browser.close();
    srv.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
