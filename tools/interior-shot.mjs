// First-person interior captures (does not touch dist/index.html or reports/shots/).
//   node tools/interior-shot.mjs [--only=name,name] [--perf] [--browser=brave]
// Bundles src/main.js with esbuild (same production settings as build.mjs, including the
// WGSL minifier) into dist/interior.html, serves dist/ on a free port, and writes
// 2560x1440 PNGs into reports/interior/. --perf also runs the scripted 60 s drive in first
// person with and without the interior (&hide=interior) and writes reports/interior/perf.json.

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, serveDist, launch, isSoftwareAdapter } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const OUT = join(ROOT, 'reports/interior');

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
  await writeFile(join(ROOT, 'dist/interior.html'), tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>'));
  console.log(`dist/interior.html  js ${(Buffer.byteLength(js) / 1024).toFixed(1)} KB`);
}

async function open(page, base, query) {
  const errs = [];
  const onErr = (m) => { if (m.type() === 'error') errs.push(m.text()); };
  page.on('console', onErr);
  await page.goto(base + 'interior.html' + query);
  await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 60000 });
  const r = await page.evaluate(() => ({ adapter: window.__gpu || null, error: window.__gpuError || null }));
  page.off('console', onErr);
  if (r.error) throw new Error(r.error);
  if (isSoftwareAdapter(r.adapter)) throw new Error('software adapter ' + JSON.stringify(r.adapter));
  return errs;
}

// Shots. Pose pages use the game's fixed poses; t= shots step the scripted drive.
const YC = '&yearclock=1&fakeaudio=1';
const SHOTS = [
  { name: 'straight_midday', q: `?pose=0&view=1${YC}` },
  { name: 'turn_left', t: 'left', q: `?script=1&capture=1&view=1${YC}` },
  { name: 'turn_right', t: 'right', q: `?script=1&capture=1&view=1${YC}` },
  { name: 'low_sun_raking', q: `?pose=0&view=1&sunrel=2.2,0.11${YC}` },
  { name: 'sun_behind_left', q: `?pose=0&view=1&sunrel=2.5,0.8${YC}` },
  { name: 'golden_hour_ahead', q: `?pose=0&view=1&sunrel=0.35,0.16${YC}` },
  { name: 'closeup_headunit', q: `?pose=0&view=1&icam=hu${YC}` },
  { name: 'closeup_instruments', q: `?pose=0&view=1&icam=gauges${YC}` },
  { name: 'closeup_instruments_bce', q: `?pose=0&view=1&icam=gauges&fakeaudio=1&year=-2565&era=2&biome=2` },
  { name: 'closeup_instruments_ce', q: `?pose=0&view=1&icam=gauges&fakeaudio=1&year=476&era=2` },
  { name: 'closeup_headunit_desert', q: `?pose=0&view=1&icam=hu&fakeaudio=1&year=-2565&era=2&biome=2` },
  { name: 'drive_rolling_years', t: 18, q: `?script=1&capture=1&view=1${YC}` },
  // Fixed poses of seed 1 (drive.js): 2 = the ice road, 4 = desert dunes. Biome on the LCD is the game's own.
  { name: 'biome_ice', q: `?pose=2&view=1${YC}` },
  { name: 'biome_desert', q: `?pose=4&view=1${YC}` },
  { name: 'third_person', q: `?pose=0&view=0${YC}` },
  { name: 'third_person_close', q: `?pose=0&view=0&carcam=2.6&dist=4.2&up=2.2${YC}` },
];

// Ad-hoc shot: --q='?pose=0&view=1&ishdbg=1' --name=dbg (written into --out, default reports/interior)
const ADHOC = process.argv.find((a) => a.startsWith('--q='));
if (ADHOC) SHOTS.splice(0, SHOTS.length, { name: arg('name', 'adhoc'), q: ADHOC.slice(4) });
const OUTDIR = process.argv.find((a) => a.startsWith('--out=')) ? process.argv.find((a) => a.startsWith('--out=')).slice(6) : OUT;

await bundle();
await mkdir(OUTDIR, { recursive: true });
const only = arg('only', '');
const srv = await serveDist();
const run = await launch(arg('browser', 'chromium'));
const page = run.page;
try {
  for (const s of SHOTS) {
    if (only && !only.split(',').includes(s.name)) continue;
    const errs = await open(page, srv.url, s.q);
    if (s.t === undefined) {
      await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
    } else {
      await page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
      let t = s.t;
      if (typeof t === 'string') {
        // Find the strongest left (yawRate < 0) or right turn in the first 60 s.
        const want = t === 'left' ? -1 : 1;
        let best = 10, bv = 0;
        for (let k = 4; k < 60; k += 0.5) {
          const yr = await page.evaluate((k) => { window.__step(k); return window.__jt.car.yawRate; }, k);
          if (yr * want > bv) { bv = yr * want; best = k; }
        }
        t = best;
        console.log(`${s.name}: t=${t} yawRate=${(bv * want).toFixed(3)}`);
        await open(page, srv.url, s.q); // fresh page: the scan left year-drum transitions behind
        await page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
      }
      // 3 s of 30 Hz steps before the shot, so jump-in transients (era plate roll, drum-rate
      // smoothing) have settled the way they would while driving
      for (let k = 0; k < 91; k++) await page.evaluate((x) => window.__step(x), t - (90 - k) / 30);
    }
    const file = join(OUTDIR, s.name + '.png');
    await page.screenshot({ path: file });
    console.log('wrote', file, errs.length ? 'ERRORS: ' + errs.join(' | ') : '');
  }

  if (flag('perf')) {
    const res = {};
    // --perfextra='&hide=grass,props,terrain' isolates the interior from the world's cost (and noise)
    const X = arg('perfextra', '');
    const HX = X.includes('hide=') ? X.replace('hide=', 'hide=interior,') : X + '&hide=interior';
    for (const [k, q] of [['interior', '?script=1&view=1&fakeaudio=1' + X], ['hidden', '?script=1&view=1' + HX]]) {
      await open(page, srv.url, q);
      await page.waitForFunction(() => window.__perf, null, { timeout: 200000, polling: 1000 });
      const p = await page.evaluate(() => window.__perf);
      const a = p.gpuMs.slice().sort((x, y) => x - y);
      const med = a[Math.floor(a.length / 2)];
      // per-pass medians (pass order: [trans] skyview, interior-shadow (first person), shadow, main, out ...)
      const p5 = a[Math.floor(a.length * 0.05)], p25 = a[Math.floor(a.length * 0.25)];
      res[k] = { avg: p.avg, median: med, p5, p25, p99: p.p99, max: p.max, frames: p.frames, adapter: p.adapter, baselinePasses: p.slowFrames.filter((f) => f.ms <= 10).map((f) => f.passes) };
      console.log(k, 'avg', p.avg, 'median', med, 'p5', p5, 'p25', p25, 'p99', p.p99, 'max', p.max);
    }
    res.note = 'GPU shared with other agents rendering captures: compare avg/median, ignore max.';
    await writeFile(join(OUT, X ? 'perf_isolated.json' : 'perf.json'), JSON.stringify(res, null, 1));
  }
} finally {
  await run.browser.close();
  srv.close();
}
