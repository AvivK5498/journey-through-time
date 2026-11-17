// The ending (src/ending.js) on the built game, free drive:
//   A  third person from ?t0=280: the home is placed, the car parks in the driveway without
//      leaving it or touching the fence / mailbox / hedge / garage, the echo and the rewind
//      run (clock back to ~0.4), the card's counts are right, Keep driving puts the clock back
//      to 300 and loops into a new world at clock 0 with the logbook kept
//   B  off-road when the ending starts: the veil sets the car back on the road, it still parks
//   C  first person: parks, the view comes back after the card
//   D  far landmass (the 1920s bridge from ?t0=245, autopilot steered across the strait)
//   E  Space skips to the card at once; Keep driving still loops
// and no page errors anywhere.
//   node tools/ending-test.mjs [--no-build] [--only=A,B,..]
import { execSync } from 'node:child_process';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';

if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const wait = (ms) => p.waitForTimeout(ms);
const E = () => p.evaluate(() => window.__game.ending());

// In-page recorder: phases seen, the car in home-local coordinates while it is off the road,
// the lowest clock in the rewind, the clock during the outro.
function recorder() {
  const R = window.__rec = { phases: [], maxX: -1e9, maxDz: 0, minMail: 1e9, minClock: 1e9, outroClock: [], takeDist: -1, view: [] };
  function tick() {
    requestAnimationFrame(tick);
    const g = window.__game, e = g.ending(), s = g.state;
    if (R.phases[R.phases.length - 1] !== e.phase) { R.phases.push(e.phase); if (e.phase === 1 || e.phase === 2) R.takeDist = window.__drive.pose().roadDist; }
    if (e.phase === 5 || e.phase === 6 || e.phase === 7) R.minClock = Math.min(R.minClock, s.clock);
    if (e.phase === 8 && window.__game.ui.veil < 0.95 && R.veiled) R.outroClock.push(s.clock);
    if (e.phase === 8 && window.__game.ui.veil >= 0.99) R.veiled = true;
    if (e.home && e.phase >= 2 && e.phase <= 3) {
      const [x, z] = e.home.carLocal;
      if (x > -33.5 && x < 0 && Math.abs(z - e.home.driveZ) < 20) { R.maxX = Math.max(R.maxX, x); if (x > -31) R.maxDz = Math.max(R.maxDz, Math.abs(z - e.home.driveZ)); }
      R.minMail = Math.min(R.minMail, Math.hypot(x - -29.1, z - 13.3));
    }
  }
  requestAnimationFrame(tick);
}

async function toCard(timeout = 120000) {
  await p.waitForFunction(() => window.__game.ending().phase === 7, null, { timeout, polling: 250 });
  await wait(800);
}
async function cardCounts() {
  return p.evaluate(() => {
    const b = [...document.querySelectorAll('#jt .stats b')].map((x) => x.textContent);
    const seen = window.__game.sites().seen;
    let n = 0; for (let i = 0; i < 22; i++) if ((seen >>> i) & 1) n++;
    return { shown: b[0], want: `${n} / 22`, names: document.querySelectorAll('#jt .evs li').length, n, visible: !!document.querySelector('#jt .endc.on'), route: document.querySelectorAll('#jt .route svg').length };
  });
}
async function keepAndLoop(label) {
  const f0 = await p.evaluate(() => window.__game.state.found);
  const seed0 = await p.evaluate(() => window.__game.state.seed);
  await p.click('#jt .keep');
  await p.waitForFunction(() => window.__game.state.loop > 0, null, { timeout: 30000, polling: 100 });
  const s = await p.evaluate(() => ({ clock: window.__game.state.clock, seed: window.__game.state.seed, found: window.__game.state.found, phase: window.__game.ending().phase, view: window.__game.state.view, oc: window.__rec.outroClock }));
  const oc = s.oc.length ? [Math.min(...s.oc), Math.max(...s.oc)] : [];
  check(oc.length && oc[0] > 299.99 && oc[1] < 300.01, `${label}: Keep driving: the clock back at 300 while the car drives off (${oc.map((v) => v.toFixed(2)).join('..')})`);
  check(s.clock < 2 && s.seed !== seed0 && s.phase === 0, `${label}: a new world at clock ${s.clock.toFixed(2)} (seed ${seed0} -> ${s.seed})`);
  check((s.found & f0) === f0, `${label}: logbook kept (${f0} -> ${s.found})`);
  return s;
}
async function parkedChecks(label) {
  const e = await E();
  const R = await p.evaluate(() => window.__rec);
  const h = e.home;
  check(!!h, `${label}: home placed (${h ? `edge ${h.edge} s ${h.s} side ${h.side}` : 'none'})`);
  if (!h) return;
  const [x, z] = h.carLocal;
  check(Math.abs(x - h.parkX) < 0.6 && Math.abs(z - h.driveZ) < 0.4 && Math.abs(h.carHeadingErr) < 0.1, `${label}: parked in the driveway at (${x}, ${z}), heading error ${h.carHeadingErr} rad`);
  check(R.maxX < -19.3 && R.maxDz < 1.8 && R.minMail > 1.6, `${label}: never left the driveway (front-most x ${R.maxX.toFixed(2)} < -19.3, |z - lane| <= ${R.maxDz.toFixed(2)} in the driveway, mailbox ${R.minMail.toFixed(2)} m away; largest path error on the way ${e.park[8]} m)`);
  const sites = await p.evaluate(() => window.__game.sites().sites.filter((s) => s.home));
  check(sites.length === 1 && sites[0].placed === 1, `${label}: one home site, placed (${JSON.stringify(sites.map((s) => ({ edge: s.edge, tris: s.triangles })))})`);
  check([4, 5, 6, 7].every((ph) => R.phases.includes(ph)), `${label}: echo, rewind, line, card (phases ${R.phases.join(',')})`);
  check(R.minClock < 0.5, `${label}: the rewind ran the clock back to ${R.minClock.toFixed(2)}`);
  const c = await cardCounts();
  check(c.visible && c.shown === c.want && c.names === c.n && c.route > 0, `${label}: card shows ${c.shown} (want ${c.want}), ${c.names} names, ${c.route} route glyphs`);
}
const want = (k) => !ONLY.length || ONLY.includes(k);

try {
  if (want('A')) {
    await openGame(p, srv.url, '?autodrive=1&fresh=1&t0=280&seed=1');
    await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
    await p.evaluate(recorder);
    const f0 = await p.evaluate(() => window.__game.state.found);
    await toCard();
    await parkedChecks('A');
    const f1 = await p.evaluate(() => window.__game.state.found);
    check(((f1 >>> 22) & 1) === 1 && (f1 & f0) === f0, `A: the home is in the logbook, nothing lost (${f0} -> ${f1})`);
    await keepAndLoop('A');
  }
  if (want('B')) {
    await openGame(p, srv.url, '?autodrive=1&fresh=1&t0=281&seed=2');
    await p.waitForFunction(() => window.__game && window.__drive, null, { timeout: 60000 });
    await p.evaluate(recorder);
    // autopilot off; brake to a stop, turn off the road and drive out across country until the
    // ending begins (~90 m out)
    await p.keyboard.press('KeyP');
    await p.keyboard.down('KeyS'); await wait(3500); await p.keyboard.up('KeyS');
    await p.keyboard.down('KeyD'); await p.keyboard.down('KeyW'); await wait(1300); await p.keyboard.up('KeyD');
    // heading ~50 degrees off the road the projected progress still moves the clock on
    await p.waitForFunction(() => window.__game.ending().phase > 0, null, { timeout: 60000, polling: 50 });
    await p.keyboard.up('KeyW');
    const R0 = await p.evaluate(() => window.__rec);
    check(R0.phases.includes(1) && R0.takeDist > 20, `B: off the road (${R0.takeDist.toFixed(1)} m) when the ending began: the veil sets the car back (phases ${R0.phases.join(',')})`);
    await toCard();
    await parkedChecks('B');
    await keepAndLoop('B');
  }
  if (want('C')) {
    await openGame(p, srv.url, '?autodrive=1&fresh=1&t0=280&seed=3&view=1');
    await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
    await p.evaluate(recorder);
    await p.waitForFunction(() => window.__game.ending().phase === 3, null, { timeout: 90000, polling: 100 });
    const v = await p.evaluate(() => window.__game.state.view);
    check(v === 1, 'C: first person through the arrival');
    await toCard();
    const v2 = await p.evaluate(() => window.__game.state.view);
    check(v2 === 0, 'C: the camera out of the car for the echo and the card');
    await parkedChecks('C');
    await p.click('#jt .keep');
    await p.waitForFunction(() => window.__game.ending().phase === 8 && window.__game.state.clock === 300 && window.__game.ui.veil < 0.6, null, { timeout: 20000, polling: 50 });
    check(await p.evaluate(() => window.__game.state.view) === 1, 'C: first person again as the car drives off');
    await p.waitForFunction(() => window.__game.state.loop > 0, null, { timeout: 30000 });
  }
  if (want('D')) {
    await openGame(p, srv.url, '?autodrive=1&fresh=1&t0=245&seed=1');
    await p.waitForFunction(() => window.__game && window.__drive, null, { timeout: 60000 });
    await p.evaluate(recorder);
    const t0 = Date.now();
    let land = 0;
    while (Date.now() - t0 < 120000) {
      land = await p.evaluate(() => {
        const g = window.__game, D = window.__drive, c = g.crossing(), d = D.pose();
        const cr = c.list.find((x) => x.presence > 0);
        if (g.state.landmass === 0 && cr && !c.list.some((x) => x.edge === d.track)) { const e = D.edge(cr.edge); const ex = D.exits(e.from).findIndex((q) => q.e === cr.edge); if (ex >= 0 && D.edge(d.cur).to === e.from) D.car.preferred = ex; }
        return g.state.landmass;
      });
      if (land === 1) break;
      await wait(200);
    }
    check(land === 1, 'D: crossed to the far landmass before the end');
    await toCard(150000);
    const l2 = await p.evaluate(() => window.__game.state.landmass);
    check(l2 === 1, `D: the home stands on the far landmass (landmass ${l2})`);
    await parkedChecks('D');
    await keepAndLoop('D');
  }
  if (want('E')) {
    await openGame(p, srv.url, '?autodrive=1&fresh=1&t0=280&seed=1');
    await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
    await p.evaluate(recorder);
    await p.waitForFunction(() => window.__game.ending().phase === 2, null, { timeout: 60000, polling: 100 });
    await wait(1500);
    await p.keyboard.press('Space');
    await wait(1200);
    const e = await E();
    const c = await cardCounts();
    check(e.phase === 7 && e.skipped && c.visible && Math.abs(e.clock - 0.4) < 0.01, `E: Space skips to the card (phase ${e.phase}, clock ${e.clock.toFixed(2)})`);
    check(!!e.home && Math.abs(e.home.carLocal[0] - e.home.parkX) < 0.3 && Math.abs(e.home.carLocal[1] - e.home.driveZ) < 0.3, `E: the car in the driveway after the skip (${e.home && e.home.carLocal})`);
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__game.state.loop > 0, null, { timeout: 30000 });
    check(true, 'E: Enter on the card keeps driving into a new world');
  }
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
} finally { await run.browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
