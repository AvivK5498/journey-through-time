// Time-lapse sky / bloom / grade / ripple captures (does not touch dist/index.html).
//   node tools/sky-shot.mjs [--only=name,name] [--perf] [--noshots] [--browser=brave]
// Bundles src/main.js (same settings as build.mjs, WGSL minified) into dist/sky.html, serves
// dist/ and writes 2560x1440 PNGs into reports/sky/. Strips tile 6 frames 0.25 s apart.
// --perf runs the scripted 60 s drive with the effects on (rate 7000) and off (?fx=0) and
// writes reports/sky/perf.json (per-pass medians: bloom, tonemap, main).

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, serveDist, launch, isSoftwareAdapter } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const OUT = join(ROOT, 'reports/sky');

function minifyWgsl(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([{}()[\];,:=<>*&|!@])\s*/g, '$1').trim();
}
const wgslPlugin = {
  name: 'wgsl-min',
  setup(b) {
    b.onLoad({ filter: /src[\\/].*\.js$/ }, async (args) => {
      const code = await readFile(args.path, 'utf8');
      if (!code.includes('/* wgsl */')) return null;
      return { contents: code.replace(/\/\* wgsl \*\/ `([^`]*)`/g, (_, body) => '`' + minifyWgsl(body) + '`'), loader: 'js' };
    });
  },
};

async function bundle() {
  const res = await esbuild.build({
    entryPoints: [join(ROOT, 'src/main.js')], bundle: true, format: 'esm', target: 'es2022', minify: true,
    write: false, legalComments: 'none', plugins: [wgslPlugin], logLevel: 'warning',
  });
  const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const tpl = await readFile(join(ROOT, 'template.html'), 'utf8');
  await mkdir(join(ROOT, 'dist'), { recursive: true });
  await writeFile(join(ROOT, 'dist/sky.html'), tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>'));
  console.log(`dist/sky.html  js ${(Buffer.byteLength(js) / 1024).toFixed(1)} KB`);
}

async function open(page, base, query) {
  const errs = [];
  const onErr = (m) => { if (m.type() === 'error') errs.push(m.text()); };
  page.on('console', onErr);
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + 'sky.html' + query);
  await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 180000 });
  const r = await page.evaluate(() => ({ adapter: window.__gpu || null, error: window.__gpuError || null }));
  page.off('console', onErr);
  if (r.error) throw new Error(r.error);
  if (isSoftwareAdapter(r.adapter)) throw new Error('software adapter ' + JSON.stringify(r.adapter));
  return errs;
}

const CORE = '&carcam=2.75&dist=5.2&up=1.6&sunrel=2.6,0.07';
const SHOTS = [
  { name: 'still_savannah', q: '?pose=0&rate=0' },
  { name: 'cruise_savannah', q: '?pose=0&rate=7000' },
  { name: 'slow_savannah', q: '?pose=0&rate=90' },
  { name: 'ripple_early_savannah', q: '?pose=0&rate=7000&ripple=0.2' },
  { name: 'ripple_savannah', q: '?pose=0&rate=7000&ripple=0.45' },
  { name: 'ripple_late_savannah', q: '?pose=0&rate=7000&ripple=0.9' },
  { name: 'bloom_core_savannah', q: '?pose=0&rate=0' + CORE },
  { name: 'bloom_core_cruise_savannah', q: '?pose=0&rate=7000' + CORE },
  { name: 'cruise_ice', q: '?pose=2&rate=7000' },
  { name: 'cruise_desert', q: '?pose=0&pt=95&rate=7000' },
  { name: 'still_ice', q: '?pose=2&rate=0' },
  { name: 'still_desert', q: '?pose=0&pt=95&rate=0' },
  { name: 'cruise_firstperson_savannah', q: '?pose=0&view=1&rate=7000&fakeaudio=1' },
  { name: 'fxoff_savannah', q: '?pose=0&fx=0' },
  // strips: 6 frames 0.25 s apart; rate(t) in years/s over the strip (t from its first frame)
  { name: 'strip_cruise', strip: { t0: 6, rate: () => 7000 } },
  { name: 'strip_decel', strip: { t0: 6, rate: (t) => 7000 * Math.max(0, 1 - t / 0.75) ** 2 } },
  { name: 'strip_accel', strip: { t0: 6, rate: (t) => 7000 * Math.min(1, t / 1.25) ** 2 } },
  { name: 'strip_ripple', strip: { t0: 6, rate: () => 7000, ripple: true, step: 0.25 } },
];

const ADHOC = process.argv.find((a) => a.startsWith('--q='));
if (ADHOC) SHOTS.splice(0, SHOTS.length, { name: arg('name', 'adhoc'), q: ADHOC.slice(4) });

// Tile PNG buffers 3x2 at half size in the page itself (no image libraries needed).
async function tile(page, bufs, labels) {
  const urls = bufs.map((b) => 'data:image/png;base64,' + b.toString('base64'));
  const data = await page.evaluate(async ({ urls, labels }) => {
    const W = 1280, H = 720, cv = document.createElement('canvas');
    cv.width = W * 3; cv.height = H * 2;
    const g = cv.getContext('2d');
    for (let i = 0; i < urls.length; i++) {
      const im = new Image(); im.src = urls[i]; await im.decode();
      const x = (i % 3) * W, y = Math.floor(i / 3) * H;
      g.drawImage(im, x, y, W, H);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x + 12, y + 12, 330, 40);
      g.fillStyle = '#f3e2b8'; g.font = '24px Menlo, monospace'; g.fillText(labels[i], x + 22, y + 41);
    }
    return cv.toDataURL('image/png');
  }, { urls, labels });
  return Buffer.from(data.split(',')[1], 'base64');
}

async function strip(page, base, s) {
  await open(page, base, '?script=1&capture=1&view=0');
  await page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  const STEP = 1 / 32;
  // 2 s run-up at the strip's starting rate
  for (let k = 64; k > 0; k--) await page.evaluate(([t, r]) => { window.__timefx.force = r; return window.__step(t); }, [s.t0 - k * STEP, s.rate(0)]);
  const bufs = [], labels = [];
  const SP = s.step || 0.25;
  if (s.ripple) await page.evaluate(() => window.__timefx.ripple(1));
  for (let i = 0; i < 6; i++) {
    const tt = i * SP;
    if (i > 0) for (let k = 7; k >= 0; k--) {
      const t = tt - k * STEP;
      await page.evaluate(([t, r]) => { window.__timefx.force = r; return window.__step(t); }, [s.t0 + t, s.rate(t)]);
    } else await page.evaluate(([t, r]) => { window.__timefx.force = r; return window.__step(t); }, [s.t0, s.rate(0)]);
    bufs.push(await page.screenshot());
    const lap = await page.evaluate(() => window.__timefx.lapse);
    labels.push(`t+${tt.toFixed(2)}s ${Math.round(s.rate(tt))} y/s L${lap.toFixed(2)}`);
  }
  return tile(page, bufs, labels);
}

await bundle();
await mkdir(OUT, { recursive: true });
const only = arg('only', '');
const srv = await serveDist();
const run = await launch(arg('browser', 'chromium'));
const page = run.page;
try {
  if (!flag('noshots')) for (const s of SHOTS) {
    if (only && !only.split(',').includes(s.name)) continue;
    const file = join(OUT, s.name + '.png');
    try {
    if (s.strip) {
      await writeFile(file, await strip(page, srv.url, s.strip));
      console.log('wrote', file);
      continue;
    }
    const errs = await open(page, srv.url, s.q);
    await page.waitForFunction(() => window.__ready, null, { timeout: 240000 });
    await page.screenshot({ path: file });
    if (arg('eval', '')) console.log('eval', JSON.stringify(await page.evaluate(arg('eval', ''))));
    console.log('wrote', file, errs.length ? 'ERRORS: ' + errs.join(' | ').slice(0, 2000) : '');
    } catch (e) { console.log('FAILED', s.name, String(e.message || e).slice(0, 300)); }
  }

  if (flag('perf')) {
    const res = { note: 'GPU shared with other agents: compare avg / median, ignore max. Pass medians in ms.' };
    for (const [k, q] of [['fx', '?script=1&rate=7000' + arg('perfextra', '')], ['off', '?script=1&fx=0' + arg('perfextra', '')]]) {
      await open(page, srv.url, q);
      await page.waitForFunction(() => window.__perf, null, { timeout: 240000, polling: 1000 });
      const p = await page.evaluate(() => {
        const t = window.__timing, n = t.logCount, pl = t.passLog;
        const main = [], bloom = [], out = [], sky = [];
        for (let i = 0; i < n; i++) {
          let last = -1;
          for (let q = 0; q < 14; q++) if (pl[i * 14 + q] > 0) last = q;
          if (last < 2) continue;
          out.push(pl[i * 14 + last]);
          const hasBloom = !/fx=0|nobloom/.test(location.search);
          if (hasBloom) { bloom.push(pl[i * 14 + last - 1]); main.push(pl[i * 14 + last - 2]); } else main.push(pl[i * 14 + last - 1]);
        }
        const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return Math.round(s[s.length >> 1] * 1000) / 1000; };
        const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 1000) / 1000 : 0;
        const g = Array.from(window.__perf.gpuMs).sort((x, y) => x - y);
        return { avg: window.__perf.avg, median: g[g.length >> 1], p99: window.__perf.p99, frames: window.__perf.frames,
          mainMed: med(main), mainAvg: avg(main), bloomMed: med(bloom), bloomAvg: avg(bloom), outMed: med(out), outAvg: avg(out), adapter: window.__perf.adapter };
      });
      res[k] = p;
      console.log(k, JSON.stringify(p));
    }
    await writeFile(join(OUT, 'perf.json'), JSON.stringify(res, null, 1));
  }
} finally {
  await run.browser.close();
  srv.close();
}
