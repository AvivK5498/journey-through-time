// Landmark viewer: renders one landmark module with the game's sky, fog and shadows.
//   node tools/viewer.mjs <landmark.js> --name=<name> [--built=1] [--decay=0] [--seed=1]
//        [--sun=day|low|dusk] [--biome=savannah|ice|desert|forest|steppe|mountains|coast]
//        [--cams=drive_far,pass,...] [--strip=built,decay,time] [--strip-cam=strip] [--cost] [--t=7.3]
//        [--span=10]
// --sun=dusk: the modern era's low warm sun (emissive windows read); --biome defaults to
//   def.biome (the coast adds open water beyond local x = 160 m, where kit SEA points).
// --strip=time: 6 frames of motion (def.animate, flames, smoke) at t, t + span/5 .. t + span.
// --strip=built writes <param>_strip_<sun>.png: 6 frames (param 0, 0.2 .. 1; the other at
//   its --built / --decay value) from --strip-cam (default 'strip': the landmark's def.strip
//   framing, else drive_near), tiled 3 x 2, driven by handle.setState
//   (the live state; no rebuild between frames). --cams= (empty) skips the stills.
// --cost prints the landmark's GPU cost (median frame ms drawn minus hidden) per camera.
// --t fixes the frame time (flicker, flames, smoke).
// Bundles src/dev/viewer.js with the landmark (esbuild API) into dist/viewer-<name>.html,
// serves it on a free port, renders 2560x1440 in headed Chromium (WebGPU on the real GPU)
// and writes reports/viewer/<name>/<camera>_b<built>_d<decay>_<sun>.png.
// Several instances may run at once (separate names, ports and browsers).

import * as esbuild from 'esbuild';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, launch, isSoftwareAdapter } from './browser.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const modPath = args.find((x) => !x.startsWith('--'));
const name = arg('name', '');
function die(msg) { console.error(`\nVIEWER FAILED: ${msg}\n`); process.exit(1); }
const BIOMES = ['savannah', 'ice', 'desert', 'forest', 'steppe', 'mountains', 'coast'];
if (!modPath || !name) die(`usage: node tools/viewer.mjs <landmark.js> --name=<name> [--built=1] [--decay=0] [--seed=1] [--sun=day|low|dusk] [--biome=${BIOMES.join('|')}] [--cams=a,b]`);
if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) die('--name must be letters, digits, - or _');
const abs = resolve(process.cwd(), modPath);
if (!existsSync(abs)) die(`no such module: ${abs}`);
const built = Number(arg('built', '1')), decay = Number(arg('decay', '0')), seed = parseInt(arg('seed', '1'), 10);
const sun = arg('sun', 'day'), biome = arg('biome', ''); // default: the landmark's def.biome
if (!(built >= 0 && built <= 1) || !(decay >= 0 && decay <= 1)) die('--built and --decay must be in 0..1');
if (!['day', 'low', 'dusk'].includes(sun)) die('--sun must be day, low or dusk');
if (biome && !BIOMES.includes(biome)) die(`--biome must be one of ${BIOMES.join(', ')}`);
const ALL = ['drive_far', 'drive_near', 'pass', 'three_quarter', 'detail', 'inside'];
const STRIP_CAMS = [...ALL, 'strip'];
const cams = arg('cams', ALL.join(',')).split(',').filter(Boolean);
const strips = arg('strip', '').split(',').filter(Boolean);
for (const s of strips) if (!['built', 'decay', 'time'].includes(s)) die(`--strip takes built, decay and/or time`);
const span = Number(arg('span', '10'));
const stripCam = arg('strip-cam', 'strip');
if (!STRIP_CAMS.includes(stripCam)) die(`unknown --strip-cam '${stripCam}'`);
const doCost = args.includes('--cost');
const tFix = Number(arg('t', '7.3'));
const sunAz = arg('az', ''), sunEl = arg('el', ''); // optional sun override (radians)
for (const c of cams) if (!ALL.includes(c)) die(`unknown camera '${c}' (have ${ALL.join(', ')})`);

// --- bundle
const res = await esbuild.build({
  entryPoints: [join(ROOT, 'src/dev/viewer.js')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'warning',
  plugins: [{ name: 'landmark', setup(b) { b.onResolve({ filter: /^jt-landmark$/ }, () => ({ path: abs })); } }],
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>viewer ${name}</title><link rel="icon" href="data:,">
<style>html,body{margin:0;background:#000;overflow:hidden}#c{display:block;width:2560px;height:1440px}</style></head>
<body><canvas id="c" width="2560" height="1440"></canvas><script type="module">${js}</script></body></html>`;
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const htmlFile = join(ROOT, 'dist', `viewer-${name}.html`);
writeFileSync(htmlFile, html);

// 3 x 2 tiles at half resolution with the parameter value printed in each corner.
async function tile(browser, shots, param) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
  const pg = await ctx.newPage();
  const b64 = await pg.evaluate(async ([shots, param, span]) => {
    const cv = document.createElement('canvas'); cv.width = 3840; cv.height = 1440;
    const g = cv.getContext('2d');
    for (let k = 0; k < shots.length; k++) {
      const img = new Image(); img.src = 'data:image/png;base64,' + shots[k]; await img.decode();
      const x = (k % 3) * 1280, y = ((k / 3) | 0) * 720;
      g.drawImage(img, x, y, 1280, 720);
      g.fillStyle = 'rgba(20,16,12,0.6)'; g.fillRect(x + 16, y + 16, 210, 52);
      g.fillStyle = '#f3e3c3'; g.font = '30px sans-serif'; g.fillText(param === 'time' ? `t ${(k * span / 5).toFixed(1)} s` : `${param} ${(k / 5).toFixed(1)}`, x + 30, y + 52);
    }
    return cv.toDataURL('image/png').split(',')[1];
  }, [shots, param, span]);
  await ctx.close();
  return Buffer.from(b64, 'base64');
}

// --- serve (this page only, ephemeral port)
const srv = await new Promise((ok) => {
  const s = createServer((req, r) => {
    if (req.url.split('?')[0] === '/') { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); r.end(html); } else { r.writeHead(404); r.end(); }
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const url = `http://127.0.0.1:${srv.address().port}/?built=${built}&decay=${decay}&seed=${seed}&sun=${sun}&biome=${biome}&t=${tFix}${sunAz ? `&az=${sunAz}` : ''}${sunEl ? `&el=${sunEl}` : ''}`;

const OUT = join(ROOT, 'reports/viewer', name);
mkdirSync(OUT, { recursive: true });
const errors = [];
const run = await launch('chromium');
run.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
run.page.on('pageerror', (e) => errors.push(e.message));
let failed = null;
try {
  await run.page.goto(url);
  await run.page.waitForFunction(() => window.__ready || window.__gpuError, null, { timeout: 90000 });
  const st = await run.page.evaluate(() => ({ err: window.__gpuError || null, info: window.__info || null, gpu: window.__gpu || null }));
  if (st.err) throw new Error(st.err);
  if (isSoftwareAdapter(st.gpu)) throw new Error(`software adapter: ${JSON.stringify(st.gpu)}`);
  console.log(`adapter: ${st.gpu.vendor} ${st.gpu.architecture} ${st.gpu.description}`.trim());
  const i = st.info;
  console.log(`${i.id} "${i.name}"  built=${i.built} decay=${i.decay} seed=${i.seed} sun=${i.sun} biome=${i.biome}`);
  console.log(`  ${i.triangles} triangles (${i.a2cTriangles} of them reveal/fade; +${i.fxTriangles} fx), ${i.vertices} vertices, build ${i.buildMs} ms (rebuild ${i.rebuildMs} ms)${i.live ? ', live' : ''}`);
  console.log(`  radius ${i.radius} m (geometry reaches ${i.bounds.maxR} m, y ${i.bounds.minY}..${i.bounds.maxY}), pad ${i.pad} m, road ${i.straddlesRoad ? 'through the origin along z' : `centre line at x = ${-i.roadOffset}`}`);
  console.log(`  lights: ${i.lights.length ? i.lights.map((l) => `[${l.pos}] I=${l.intensity} range=${l.range} flicker=${l.flicker}`).join('; ') : 'none'}`);
  for (const w of i.warnings) console.log(`  WARNING: ${w}`);
  for (const c of cams) {
    const ok = await run.page.evaluate((c) => window.__view(c), c);
    if (!ok) { console.log(`  (skipped ${c}: not applicable)`); continue; }
    const file = join(OUT, `${c}_b${built}_d${decay}_${sun}.png`);
    await run.page.screenshot({ path: file });
    console.log('wrote', file);
  }
  for (const param of strips) {
    const shots = [];
    for (let k = 0; k < 6; k++) {
      const v = k / 5;
      if (param === 'time') await run.page.evaluate((t) => window.__time(t), tFix + v * span);
      else await run.page.evaluate(([bu, de]) => window.__state(bu, de), param === 'built' ? [v, decay] : [built, v]);
      const ok = await run.page.evaluate((c) => window.__view(c), stripCam);
      if (!ok) break;
      shots.push((await run.page.screenshot({ type: 'png' })).toString('base64'));
    }
    if (shots.length === 6) {
      const file = join(OUT, `${param}_strip_${sun}.png`);
      const png = await tile(run.browser, shots, param);
      writeFileSync(file, png);
      console.log('wrote', file);
    }
    await run.page.evaluate(([bu, de]) => window.__state(bu, de), [built, decay]);
    await run.page.evaluate((t) => window.__time(t), tFix);
  }
  if (doCost) {
    for (const c of ['drive_far', 'drive_near', 'pass', 'inside']) {
      const r = await run.page.evaluate((c) => window.__cost(c, 90), c);
      if (r) console.log(`  cost ${c}: ${r.landmark} ms (frame ${r.on} ms drawn, ${r.off} ms hidden)`);
    }
  }
  if (errors.length) { console.log(`  ${errors.length} page error(s):`); for (const e of errors.slice(0, 10)) console.log('   ', e); }
} catch (e) {
  failed = e;
} finally {
  await run.browser.close();
  srv.close();
}
if (failed) die(failed.message);
if (errors.length) process.exitCode = 2;
