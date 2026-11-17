// Polish captures (copy of ice-shot.mjs; writes dist/final.html and reports/final/).
//   node tools/final-shot.mjs [--only=name,name] [--wait=5]
// Bundles src/main.js into dist/final.html, serves dist/ and writes 2560x1440 PNGs into
// reports/final/. Uses ?autodrive=1&seed=1&t0=<clock>; strips tile 6 frames 0.5 s apart.

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, serveDist, launch, isSoftwareAdapter } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const OUT = join(ROOT, 'reports/final');
const WAIT = Number(arg('wait', '5')) * 1000;

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
  await writeFile(join(ROOT, 'dist/final.html'), tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>'));
  console.log(`dist/final.html  js ${(Buffer.byteLength(js) / 1024).toFixed(1)} KB`);
}

async function open(page, base, query) {
  await page.goto(base + 'final.html' + query);
  await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 180000 });
  const r = await page.evaluate(() => ({ adapter: window.__gpu || null, error: window.__gpuError || null }));
  if (r.error) throw new Error(r.error);
  if (isSoftwareAdapter(r.adapter)) throw new Error('software adapter ' + JSON.stringify(r.adapter));
  await page.waitForTimeout(WAIT);
}

const Q = (t0, rate, extra = '') => `?autodrive=1&seed=1&fresh=1&view=0&t0=${t0}&rate=${rate}${extra}`;
const SHOTS = [];
// The scripted drive (?script=1, seed 1) is in the ice from about t=29 s; autodrive's t0 route differs.
for (const t of [31, 36, 42]) for (const r of [0, 8000]) SHOTS.push({ name: `ice_t${t}_r${r}`, single: t, rate: r });
SHOTS.push({ name: 'pose2_r0', q: '?pose=2&rate=0', ready: true }, { name: 'pose2_r8000', q: '?pose=2&rate=8000', ready: true });
for (const pt of [4012, 4005]) for (const r of [0, 8000]) SHOTS.push({ name: `ice_pt${pt}_r${r}`, q: `?pose=0&pt=${pt}&rate=${r}`, ready: true });
for (const [nm, yaw] of [['L', 1.1], ['R', -1.1]]) SHOTS.push({ name: `glacier_${nm}`, q: `?pose=0&pt=36&rate=0&pcam=0,0,7,2.5,${yaw},300,10,0.9`, ready: true });
SHOTS.push({ name: 'savannah_t8_r8000', q: Q(8, 8000) });
SHOTS.push({ name: 'desert_t70_r8000', q: Q(70, 8000) });
SHOTS.push({ name: 'strip_ice', cap: Number(arg('icet', '40')) });
SHOTS.push({ name: 'strip_savannah', cap: 8 });
SHOTS.push({ name: 'strip_desert', cap: Number(arg('dest', '75')) });


SHOTS.length = 0;
for (const p of [0,1,2,3,4,5]) SHOTS.push({ name: "pose"+p+"_v0", q: "?pose="+p+"&view=0&rate="+(p<3?8000:p===3?300:90), ready: true });
for (const p of [0,2,4]) SHOTS.push({ name: "pose"+p+"_v1", q: "?pose="+p+"&view=1&rate="+(p<3?8000:90), ready: true });
for (const [t,r] of [[12,8000],[26,8000],[36,8000],[44,300],[52,300],[58,300]]) SHOTS.push({ name: "drive_t"+t, single: t, rate: r });

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

await bundle();
await mkdir(OUT, { recursive: true });
const only = arg('only', '');
const srv = await serveDist();
const run = await launch(arg('browser', 'chromium'));
const page = run.page;
try {
  for (const s of SHOTS) {
    if (only && !only.split(',').includes(s.name)) continue;
    const file = join(OUT, s.name + '.png');
    try {
      if (s.single !== undefined) s.cap = s.single;
      if (s.cap !== undefined) {
        await open(page, srv.url, '?script=1&capture=1&view=0');
        await page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
        const STEP = 1 / 32, R = s.rate ?? 8000, bufs = [], labels = [];
        for (let k = 64; k > 0; k--) await page.evaluate(([t, r]) => { window.__timefx.force = r; return window.__step(t); }, [s.cap - k * STEP, R]);
        for (let i = 0; i < (s.single !== undefined ? 1 : 6); i++) {
          if (i) for (let k = 15; k >= 0; k--) await page.evaluate(([t, r]) => { window.__timefx.force = r; return window.__step(t); }, [s.cap + i * 0.5 - k * STEP, R]);
          else await page.evaluate(([t, r]) => { window.__timefx.force = r; return window.__step(t); }, [s.cap, R]);
          bufs.push(await page.screenshot());
          labels.push(`t=${(s.cap + i * 0.5).toFixed(1)} L${(await page.evaluate(() => window.__timefx.lapse)).toFixed(2)}`);
        }
        await writeFile(file, s.single !== undefined ? bufs[0] : await tile(page, bufs, labels));
      } else if (s.strip) {
        await open(page, srv.url, s.strip);
        const bufs = [], labels = [];
        for (let i = 0; i < 6; i++) {
          if (i) await page.waitForTimeout(500);
          bufs.push(await page.screenshot());
          const st = await page.evaluate(() => (window.__timefx ? window.__timefx.lapse : -1));
          labels.push(`t+${(i * 0.5).toFixed(1)}s L${Number(st).toFixed(2)}`);
        }
        await writeFile(file, await tile(page, bufs, labels));
      } else {
        await open(page, srv.url, s.q);
        if (s.ready) await page.waitForFunction(() => window.__ready, null, { timeout: 240000 });
        await page.screenshot({ path: file });
      }
      console.log('wrote', file);
    } catch (e) { console.log('FAILED', s.name, String(e.message || e).slice(0, 300)); }
  }
} finally {
  await run.browser.close();
  srv.close();
}
