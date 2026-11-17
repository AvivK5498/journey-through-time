// The evening light at the end of the journey: chase-view captures of the scripted drive at
// clock 267 (Trinity, full day), 277 (Apollo, late-afternoon gold), 282 (dusk, lamps lit) and
// 290 (the megacity / the ending's street: deep dusk) into reports/round2/dusk/, with the
// key sun's elevation and the frame's mean sky and ground brightness.
//   node tools/dusk-shot.mjs [--no-build] [--seed=1] [--at=267,277,282,290] [--biome=0] [--view=0]
//        [--file=index.r2-landmarks.html --out=before] (another build in dist/, its own folder)
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { ROOT, serveDist, launch } from './browser.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const OUT = ROOT + 'reports/round2/dusk/' + (arg('out', '') ? arg('out', '') + '/' : '');
mkdirSync(OUT, { recursive: true });
const AT = arg('at', '267,277,282,290').split(',').map(Number);
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
await p.setViewportSize({ width: 1920, height: 1080 });
try {
  for (const c of AT) {
    const q = `?script=1&capture=1&fresh=1&seed=${arg('seed', '1')}&t0=${c - 4}&view=${arg('view', '0')}${arg('biome', '') ? '&biome=' + arg('biome', '') : ''}`;
    await p.goto(srv.url + arg('file', 'index.html') + q);
    await p.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 30000 });
    await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
    for (let t = 0; t <= 4.001; t += 0.1) await p.evaluate((t) => window.__step(t), t);
    await p.waitForTimeout(200);
    const name = `clock_${c}.jpg`;
    await p.screenshot({ path: OUT + name, type: 'jpeg', quality: 88 });
    const s = await p.evaluate(() => {
      const cv = document.querySelector('canvas');
      const tmp = document.createElement('canvas'); tmp.width = 96; tmp.height = 54;
      const g = tmp.getContext('2d'); g.drawImage(cv, 0, 0, 96, 54);
      const d = g.getImageData(0, 0, 96, 54).data;
      let sky = 0, gr = 0;
      for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) { const i = (y * 96 + x) * 4, l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]); if (y < 14) sky += l; else if (y > 34) gr += l; }
      return { clock: window.__game.state.clock, sky: sky / (14 * 96), ground: gr / (19 * 96), sun: window.__sunElevation ? window.__sunElevation() : null };
    });
    console.log(`${name}  clock ${s.clock.toFixed(1)}  mean sky ${s.sky.toFixed(0)}  mean ground ${s.ground.toFixed(0)} (0-255)`);
  }
} finally { await run.browser.close(); srv.close(); }
