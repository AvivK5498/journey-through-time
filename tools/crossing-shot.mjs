// Captures the strait crossings at 1920x1080 into reports/round2/crossing/: the quay with the
// carrack waiting, mid-passage in both views and from the side, arrival at the far quay, the
// paddle steamer, the bridge from the approach and from its deck (lamps forced on with
// ?lamps=1: the game has no dusk before the ending), the handover (ship fading, bridge rising)
// and the flooded land bridge's marker.
//   node tools/crossing-shot.mjs [--no-build] [--only=name,...]
import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, serveDist, launch } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const OUT = join(ROOT, 'reports/round2/crossing');
await mkdir(OUT, { recursive: true });

// at: which moment on the crossing road (found by stepping the drive): 'wait' (130 m short of
// the quay), 'board', 'mid' (aboard, mid-strait), 'arrive' (rolling off), 'approach' (230 m
// short), 'deck' (40% over), 'fork' (at the fork before it); dt: seconds after that moment.
// cam: optional pose camera (rig 1: yaw offset, back, up, look yaw, look dist, look up, fov).
const SHOTS = [
  { name: 'quay_waiting', q: 'seed=1&t0=176&route=0', at: 'wait', view: 0 },
  { name: 'quay_waiting_high', q: 'seed=1&t0=176&route=0', at: 'wait', cam: '1,-0.35,45,22,0,260,-14,0.8' },
  { name: 'boarding', q: 'seed=1&t0=176&route=0', at: 'board', dt: 0.6, view: 0 },
  { name: 'passage_chase', q: 'seed=1&t0=176&route=0', at: 'mid', view: 0 },
  { name: 'passage_first', q: 'seed=1&t0=176&route=0', at: 'mid', view: 1 },
  { name: 'passage_side', q: 'seed=1&t0=176&route=0', at: 'mid', cam: '1,1.75,75,14,0,0,4,0.72' },
  { name: 'arrival', q: 'seed=1&t0=176&route=0', at: 'arrive', view: 0 },
  { name: 'steamer_quay', q: 'seed=1&t0=205&route=0', at: 'wait', cam: '1,-0.4,40,16,0,220,-10,0.8' },
  { name: 'steamer_passage', q: 'seed=1&t0=205&route=0', at: 'mid', cam: '1,2.1,70,12,0,0,5,0.72' },
  { name: 'steamer_chase', q: 'seed=1&t0=205&route=0', at: 'mid', view: 0 },
  { name: 'handover_ship', q: 'seed=4&t0=205&route=1,0', at: 'clock:257.4', cam: '1,-0.15,30,26,0,520,-22,0.75' },
  { name: 'handover_rising', q: 'seed=4&t0=205&route=1,0', at: 'clock:259.4', cam: '1,-0.15,30,26,0,520,-22,0.75' },
  { name: 'bridge_approach', q: 'seed=1&t0=245&route=0', at: 'approach', view: 0 },
  { name: 'bridge_high', q: 'seed=1&t0=245&route=0', at: 'approach', cam: '1,-0.55,60,40,0.1,420,-30,0.8' },
  { name: 'bridge_deck_dusk', q: 'seed=1&t0=245&route=0&lamps=1', at: 'deck', view: 1 },
  { name: 'bridge_deck_chase', q: 'seed=1&t0=245&route=0&lamps=1', at: 'deck', view: 0 },
  { name: 'marker', q: 'seed=3&t0=58&biome=1', at: 'marker', cam: 'marker' },
].filter((s) => !ONLY || ONLY.includes(s.name));

const srv = await serveDist();
const run = await launch('chromium');
const ctx = await run.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
try {
  for (const s of SHOTS) {
    // Find the moment with the scripted drive (capture page, no rendering).
    await p.goto(srv.url + `index.html?script=1&capture=1&placeholders=1&${s.q}`);
    await p.waitForFunction(() => window.__captureReady || window.__gpuError, null, { timeout: 60000 });
    const t = await p.evaluate((at) => {
      const g = window.__game, D = window.__drive;
      for (let t = 0; t < 120; t += 0.05) {
        g.dryStep(t);
        const c = g.crossing(), d = D.pose();
        if (at.startsWith('clock:')) { if (g.state.clock >= Number(at.slice(6))) return t; continue; }
        if (at === 'marker') { if (c.marker && c.markerPos) { const dx = c.markerPos[0] - g.carPose[0], dz = c.markerPos[2] - g.carPose[2]; if (Math.hypot(dx, dz) < 105) { const a = Math.atan2(dz, dx) - g.carPose[3]; window.__markerCam = `1,${a.toFixed(3)},14,4,${a.toFixed(3)},${Math.hypot(dx, dz).toFixed(0)},1,0.5`; return t; } } continue; }
        const f = c.list.find((x) => x.edge === d.track);
        if (at === 'fork') { if (c.list.length && d.fork) return t; continue; }
        if (!f) continue;
        const s = d.s;
        if (at === 'wait' && s > f.quayS - 130) return t;
        if (at === 'approach' && s > f.quayS - 230) return t;
        if (at === 'board' && s > f.quayS - 4) return t;
        if (at === 'mid' && s > f.quayS + 175) return t;
        if (at === 'deck' && s > f.quayS + 125) return t;
        if (at === 'arrive' && s > f.len - 10) return t;
      }
      return -1;
    }, s.at);
    if (t < 0) { console.log(`skip ${s.name}: moment '${s.at}' not found`); continue; }
    const tt = t + (s.dt || 0);
    if (s.cam === 'marker') s.cam = await p.evaluate(() => window.__markerCam);
    let url;
    if (s.cam) url = `index.html?pose=1&placeholders=1&${s.q}&pt=${tt.toFixed(2)}&pcam=${s.cam}`;
    else url = `index.html?script=1&capture=1&placeholders=1&${s.q}&view=${s.view || 0}`;
    await p.goto(srv.url + url);
    if (s.cam) await p.waitForFunction(() => window.__ready || window.__gpuError, null, { timeout: 90000 });
    else {
      await p.waitForFunction(() => window.__captureReady || window.__gpuError, null, { timeout: 60000 });
      for (let k = 0; k < 5; k++) await p.evaluate((x) => window.__step(x), Math.max(0, tt - 0.4 + k * 0.1));
    }
    const info = await p.evaluate(() => { const g = window.__game, c = g.crossing(); return { clock: +g.state.clock.toFixed(1), land: g.state.landmass, hold: c.hold, ships: c.ships }; });
    const out = join(OUT, s.name + '.png');
    await p.screenshot({ path: out });
    console.log(`wrote ${s.name}.png  t=${tt.toFixed(2)} clock ${info.clock} land ${info.land} hold ${info.hold} ${JSON.stringify(info.ships)}${errs.length ? '  ERRORS: ' + errs.slice(0, 2).join(' | ').slice(0, 600) : ''}`);
    errs.length = 0;
  }
} finally { await run.browser.close(); srv.close(); }
