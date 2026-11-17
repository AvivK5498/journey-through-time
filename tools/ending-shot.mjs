// Captures the ending at 1920x1080 into reports/round2/ending/: the street at dusk, the car in
// the driveway, the echo shot, five frames through the rewind (~1900, ~1500, ~1 CE, ~10,000 BCE,
// the final camp) and the journey card. Free drive from ?t0=280 (autopilot on).
//   node tools/ending-shot.mjs [--no-build] [--seed=1] [--view=0]
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const OUT = ROOT + 'reports/round2/ending/';
mkdirSync(OUT, { recursive: true });
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
await p.setViewportSize({ width: 1920, height: 1080 });
p.on('pageerror', (e) => console.log('[page error]', e.message));
const shot = async (name) => { await p.screenshot({ path: OUT + name + '.jpg', type: 'jpeg', quality: 88 }); const s = await p.evaluate(() => ({ clock: window.__game.state.clock, year: Math.round(window.__game.state.year) })); console.log(`${name}.jpg  clock ${s.clock.toFixed(1)}  year ${s.year}`); };
const phaseAt = (ph, t) => p.waitForFunction(([ph, t]) => { const e = window.__game.ending(); return e.phase === ph && window.__endT >= t; }, [ph, t], { timeout: 120000, polling: 'raf' });
try {
  await openGame(p, srv.url, `?autodrive=1&fresh=1&t0=280&seed=${arg('seed', '1')}&view=${arg('view', '0')}`);
  await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
  // phase clock (real seconds since the phase began), in-page
  await p.evaluate(() => { let ph = -1, t0 = 0; const f = (ts) => { requestAnimationFrame(f); const e = window.__game.ending(); if (e.phase !== ph) { ph = e.phase; t0 = ts; } window.__endT = (ts - t0) / 1000; }; requestAnimationFrame(f); });
  await phaseAt(2, 7); await shot('1-street-dusk');
  await phaseAt(3, 1.2); await shot('2-driveway');
  await phaseAt(4, 9); await shot('3-echo');
  for (const [name, yr] of [['4-rewind-1900', 1900], ['5-rewind-1500', 1500], ['6-rewind-1ce', 1], ['7-rewind-10000bce', -10000]]) {
    await p.waitForFunction((yr) => window.__game.ending().phase === 5 && window.__game.state.year <= yr, yr, { timeout: 120000, polling: 'raf' });
    await shot(name);
  }
  await phaseAt(6, 1.6); await shot('8-final-camp');
  await phaseAt(6, 4.2); await shot('8b-same-fire');
  await phaseAt(7, 1.5); await shot('9-card');
} finally { await run.browser.close(); srv.close(); }
