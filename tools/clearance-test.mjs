// Road clearance: no road may run through a landmark ("the road is for the car only").
// Drives the autopilot route of seeds 1-30 for each landmass option (default planner, ?land=1,
// ?land=2) without rendering (window.__game.dryRun) with ?clearlog=1: every landmark that is
// drawn is checked against every live road whenever a road is generated, using the module's
// footprint (src/world/footprints.js: what stands above 5 cm, rigs and FX excluded) with the
// 6.5 m road clearance, and its pad (a road may cross only its bare outer 10%, at most 30 m). Fails on any
// case below zero, or when src/world/footprints.js is stale (node tools/footprints.mjs).
// Reports per landmark: runs drawn, smallest margin (m), cases too close.
//   node tools/clearance-test.mjs [--seeds=1-30] [--step=0.25] [--no-build] [--noclear (placement as before)]
import { execSync } from 'node:child_process';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
import { EVENTS } from '../src/world/time.js';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
let fails = 0;
try { execSync('node tools/footprints.mjs --check', { cwd: ROOT, stdio: 'inherit' }); } catch { fails++; }
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const [a, b] = arg('seeds', '1-30').split('-').map(Number);
const step = Number(arg('step', '0.25'));
const srv = await serveDist();
const run = await launch('chromium');
const errs = [];
run.page.on('pageerror', (e) => errs.push(e.message));
const per = EVENTS.map(() => ({ runs: 0, min: Infinity, bad: 0 }));
const bad = [];
let rejected = 0, moved = 0, late = 0;
const why = new Array(EVENTS.length * 5).fill(0);
try {
  const r = await openGame(run.page, srv.url, `?script=1&capture=1&clearlog=1${process.argv.includes('--noclear') ? '&noclear=1' : ''}`);
  if (r.error) throw new Error(r.error);
  await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  for (const land of [-1, 1, 2]) {
    for (let seed = a; seed <= (b || a); seed++) {
      const c = await run.page.evaluate(({ seed, step, land }) => { window.__game.dryRun(seed, step, undefined, land); return window.__game.sites().clearance; }, { seed, step, land });
      rejected += c.rejected; moved += c.moved; late += c.lateSeen;
      c.why.forEach((n, k) => { why[k] += n; });
      c.min.forEach((m, ev) => { if (m === null) return; per[ev].runs++; per[ev].min = Math.min(per[ev].min, m); });
      for (const x of c.bad) { per[x.ev].bad++; bad.push({ seed, land, ...x }); }
    }
  }
  console.log('landmark          runs  min margin (m)  too close   candidates rejected (own pad / own road / sibling / later fork / other road)');
  EVENTS.forEach((e, i) => {
    const p = per[i];
    if (!p.runs) { console.log(`  ${e.key.padEnd(16)} ${String(0).padStart(4)}  ${'-'.padStart(14)}  ${'-'.padStart(9)}   ${why.slice(i * 5, i * 5 + 5).join(' / ')}`); return; }
    const w = why.slice(i * 5, i * 5 + 5).join(' / ');
    console.log(`  ${e.key.padEnd(16)} ${String(p.runs).padStart(4)}  ${(p.min > 1e8 ? 'no road near' : p.min.toFixed(1)).padStart(14)}  ${String(p.bad ? `${p.bad} FAIL` : 0).padStart(9)}   ${w}`);
  });
  for (const x of bad.slice(0, 20)) console.log(`  too close: seed ${x.seed} land ${x.land} ${x.id} margin ${x.margin} m (${x.pad ? 'pad' : 'geometry'}, ${x.own ? 'its own road' : x.road === -2 ? 'a ghost exit' : 'road ' + x.road}) clock ${x.clock}`);
  console.log(`placement candidates rejected for clearance: ${rejected}; sites moved after a later road: ${moved}; later roads too close to a site already in view: ${late}`);
  if (bad.length) fails++;
  if (errs.length) { fails++; console.log('page errors', errs.slice(0, 3)); }
} finally { await run.browser.close(); srv.close(); }
console.log(fails ? 'FAIL' : 'ok');
process.exit(fails ? 1 : 0);
