// Captures the middle of the event moment at each landmark and the camp's scattered fires
// from the road, at 1920x1080, into reports/round2/events/.
//   node tools/witness-shot.mjs [--no-build] [--only=camp,cave,gobekli,giza,fires] [--at=3.2]
import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, serveDist, launch } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const AT = Number(arg('at', '3.2')) * 1000;
const OUT = join(ROOT, 'reports/round2/events');
await mkdir(OUT, { recursive: true });

const SHOTS = [
  { name: 'camp', ev: 0, t0: 0 },
  { name: 'cave', ev: 1, t0: 0 },
  { name: 'gobekli', ev: 2, t0: 0 },
  { name: 'giza', ev: 3, t0: 80 },
].filter((s) => !ONLY || ONLY.includes(s.name));
if (!ONLY || ONLY.includes('fires')) SHOTS.unshift({ name: 'fires', fires: true, t0: 0 });

const srv = await serveDist();
const run = await launch('chromium');
const ctx = await run.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
let p = null;
try {
  let last = {};
  for (const s of SHOTS) {
    // One drive from clock 0 meets the landmarks in order; reload only for the fires.
    if (!p || s.fires || s.t0 > 0 || last.fires || last.t0 > 0) {
      if (p) await p.close();
      p = await ctx.newPage(); await p.bringToFront(); p.on('pageerror', (e) => console.log('[page error]', e.message));
      await p.goto(srv.url + `index.html?autodrive=1&seed=1&fresh=1&t0=${s.t0}&view=0&n=${s.name}`);
      await p.waitForFunction(() => window.__game || window.__gpuError, null, { timeout: 60000 });
    }
    if (s.fires) {
      // From the road at the start: the camp ahead, the other bands' smoke and fires around.
      await p.waitForFunction(() => window.__game.sites().sites.some((x) => x.ev === 0 && x.stage === 'live'), null, { timeout: 30000 });
      await p.waitForTimeout(1200);
      await p.screenshot({ path: join(OUT, 'fires_road.png') });
      await p.waitForTimeout(1800);
      await p.screenshot({ path: join(OUT, 'fires_road2.png') });
      console.log('fires_road.png, fires_road2.png');
      last = s;
      continue;
    }
    const ok = await p.waitForFunction((ev) => window.__game.witnessIO[0] >= 0 && window.__game.witnessIO[1] === ev, s.ev, { timeout: 140000, polling: 100 }).then(() => true).catch(() => false);
    last = s;
    if (!ok) { console.log(`${s.name}: no prompt`); continue; }
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(OUT, `${s.name}_prompt.png`) });
    await p.keyboard.press('KeyE');
    await p.waitForTimeout(900);
    await p.screenshot({ path: join(OUT, `${s.name}_swing.png`) });
    await p.waitForTimeout(AT - 900);
    await p.screenshot({ path: join(OUT, `${s.name}_witness.png`) });
    const info = await p.evaluate(() => ({ clock: window.__game.state.clock, w: window.__game.witness.w, sites: window.__game.sites().sites.map((x) => [x.id, x.stage, x.visible]) }));
    console.log(`${s.name}: clock ${info.clock.toFixed(1)} w ${info.w.toFixed(2)} ${JSON.stringify(info.sites)}`);
  }
} finally {
  await run.browser.close();
  srv.close();
}
