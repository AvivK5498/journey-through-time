// Settlement and road-age captures (settle worker): bundles src/main.js into dist/settle.html
// (dist/index.html is left alone), serves dist/ and writes 1920x1080 PNGs into
// reports/round2/settle/.
//   node tools/settle-shot.mjs                 the review set (eras 1-6 chase + first person,
//                                              a modern dusk shot, forest / desert / coast)
//   node tools/settle-shot.mjs --only=a,b      named shots only
//   node tools/settle-shot.mjs --q='?pose=1&...' --name=x   one ad-hoc pose query
// Shots are fixed poses: ?pose=1&pcam=0 (the normal chase / first-person camera) at script time
// pt on a seeded road of one biome (&biome=N&biomelock=1), starting the journey at t0, so the
// clock at the pose is t0 + pt. rate=0 keeps the sky still.

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ROOT, serveDist, CHROME_ARGS, isSoftwareAdapter } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const OUT = join(ROOT, 'reports/round2/settle');

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
    write: false, legalComments: 'none', plugins: [wgslPlugin], logLevel: 'warning', metafile: true,
  });
  const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const tpl = await readFile(join(ROOT, 'template.html'), 'utf8');
  await mkdir(join(ROOT, 'dist'), { recursive: true });
  await writeFile(join(ROOT, 'dist/settle.html'), tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>'));
  const mine = Object.entries(res.metafile.outputs)[0][1].inputs;
  const part = (f) => { const k = Object.keys(mine).find((x) => x.endsWith(f)); return k ? (mine[k].bytesInOutput / 1024).toFixed(1) : '-'; };
  console.log(`dist/settle.html  js ${(Buffer.byteLength(js) / 1024).toFixed(1)} KB (settle.js ${part('world/settle.js')} KB, road.js ${part('world/road.js')} KB)`);
}

// pose query: biome b, seed s, journey start t0, script time pt, view v, extra.
const P = (b, s, t0, pt, v, extra = '') => `?pose=1&pcam=0&seed=${s}&biome=${b}&biomelock=1&t0=${t0}&pt=${pt}&view=${v}&rate=0&fresh=1${extra}`;
const SHOTS = [];
// Eras 1-6 (index): a clock well inside each era, on roads of biomes that suit it.
const ERA = [[1, 3, 62], [2, 6, 102], [3, 3, 145], [4, 3, 192], [5, 3, 236], [6, 0, 266]];
for (const [e, b, c] of ERA) for (const v of [0, 1]) SHOTS.push({ name: `era${e}_${v ? 'fp' : 'chase'}`, q: P(b, 3, c - 12, 12, v) });
SHOTS.push({ name: 'modern_dusk', q: P(0, 3, 284, 10, 0) });
SHOTS.push({ name: 'modern_dusk_fp', q: P(3, 3, 286, 10, 1) });
SHOTS.push({ name: 'forest_era4', q: P(3, 5, 186, 12, 0) });
SHOTS.push({ name: 'desert_era4', q: P(2, 5, 190, 12, 0) });
SHOTS.push({ name: 'coast_era5', q: P(6, 5, 228, 12, 0) });
SHOTS.push({ name: 'road_cobbles_fp', q: P(3, 7, 180, 10, 1) });
SHOTS.push({ name: 'road_asphalt_fp', q: P(4, 7, 252, 10, 1) });
SHOTS.push({ name: 'road_highway_fp', q: P(4, 7, 278, 10, 1) });
SHOTS.push({ name: 'road_highway_ice', q: P(1, 7, 278, 10, 0) });

const adhoc = arg('q', '');
if (adhoc) { SHOTS.length = 0; SHOTS.push({ name: arg('name', 'adhoc'), q: adhoc }); }

await bundle();
if (process.argv.includes('--build-only')) process.exit(0);
await mkdir(OUT, { recursive: true });
const only = arg('only', '');
const srv = await serveDist();
const browser = await chromium.launch({ headless: false, args: CHROME_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
try {
  for (const s of SHOTS) {
    if (only && !only.split(',').includes(s.name)) continue;
    const file = join(OUT, s.name + '.png');
    errs.length = 0;
    try {
      await page.goto(srv.url + 'settle.html' + s.q);
      await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 180000 });
      const r = await page.evaluate(() => ({ adapter: window.__gpu || null, error: window.__gpuError || null }));
      if (r.error) throw new Error(r.error);
      if (isSoftwareAdapter(r.adapter)) throw new Error('software adapter');
      await page.waitForFunction(() => window.__ready, null, { timeout: 240000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: file });
      const st = await page.evaluate(() => (window.__settle ? window.__settle.stats() : null));
      console.log('wrote', file, st ? JSON.stringify(st) : '', errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ').slice(0, 1500) : '');
    } catch (e) { console.log('FAILED', s.name, String(e.message || e).slice(0, 400), errs.slice(0, 3).join(' | ').slice(0, 1500)); }
  }
} finally {
  await browser.close();
  srv.close();
}
