// Keyboard driving check (free-drive mode, ?autodrive=1: no start screen, audio off, player
// autopilot on): cruise, steering off the road, the autopilot bringing it back, held steering
// overriding it, choosing a fork exit by steering; then P (autopilot off): throttle, coast,
// brake into reverse. Free roaming far off-road is tools/roam-test.mjs.
//   node tools/drive-test.mjs [--no-build]
import { execSync } from 'node:child_process';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
const S = () => p.evaluate(() => { const j = window.__jt; return { clock: +j.state.clock.toFixed(2), speed: +j.state.speed.toFixed(1), off: +j.state.offRoad.toFixed(1), edge: j.state.edge, s: +j.state.edgeS.toFixed(0), cur: j.graph.cur, commits: j.graph.commits, fork: j.car.forkMode }; });
const wait = (ms) => p.waitForTimeout(ms);
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
try {
  await openGame(p, srv.url, '?autodrive=1&fresh=1');
  await p.waitForFunction(() => window.__jt, null, { timeout: 30000 });
  await wait(2000);
  let a = await S(); console.log('start', a);
  check(await p.evaluate(() => window.__jt.state.autopilot === true), '?autodrive=1 starts with the autopilot on');
  check(a.speed > 35 && a.speed < 45 && a.off < 2, 'hands-off cruise on the road');
  await p.keyboard.down('KeyD'); await wait(2500); await p.keyboard.up('KeyD');
  let b = await S(); console.log('after D 2.5 s', b);
  check(b.off > 4, 'steering takes the car off the road');
  await wait(9000);
  let c = await S(); console.log('9 s hands-off', c);
  check(c.off < 3, 'autopilot brings it back to the road');
  await p.keyboard.down('KeyA'); await wait(6000);
  let d = await S(); await p.keyboard.up('KeyA'); console.log('6 s full left', d);
  check(d.off > 25, 'held steering overrides the autopilot (no corridor pull while held)');
  check(d.speed < 38, 'slower off-road');
  await wait(14000);
  let d2 = await S(); console.log('14 s hands-off', d2);
  check(d2.off < 4, 'released: the autopilot drives back to the road');
  await wait(8000);
  // Fork choice: a short push right just past the junction (held steering overrides the
  // autopilot, which then follows the exit the car is on); expect the rightmost exit.
  const before = (await S()).commits;
  await p.waitForFunction(() => window.__jt.car.forkMode, null, { timeout: 60000, polling: 20 });
  await p.keyboard.down('KeyD');
  await wait(1300);
  await p.keyboard.up('KeyD');
  await p.waitForFunction((n) => window.__jt.graph.commits > n, before, { timeout: 20000, polling: 50 }).catch(() => {});
  const e = await p.evaluate(() => { const j = window.__jt; return { cur: j.graph.cur, exitIdx: j.car.preferred, exits: j.exitCount(j.car.forkNode >= 0 ? j.car.forkNode : -1), commits: j.graph.commits, lastFork: j.lastFork() }; });
  console.log('fork with D held', e);
  check(e.commits > before, 'committed to an exit at the fork');
  check(e.lastFork[0] === e.lastFork[1] - 1, 'steering right took the rightmost exit (' + e.lastFork.join(' of ') + ')');
  await wait(9000);
  let f = await S(); console.log('9 s after the fork', f);
  check(f.off < 4 && f.speed > 30, 'back on the road after the fork');
  // Autopilot off: the car is the player's (throttle / coast / reverse: tools/roam-test.mjs).
  await p.keyboard.press('KeyP');
  check(await p.evaluate(() => window.__jt.state.autopilot === false), 'P turns the autopilot off');
  await wait(300);
  const h0 = await p.evaluate(() => window.__drive.pose().h);
  await wait(2500);
  const h1 = await p.evaluate(() => window.__drive.pose().h);
  check(Math.abs(h1 - h0) < 0.01, 'autopilot off, hands-off: nothing steers (heading change ' + (h1 - h0).toFixed(4) + ' rad in 2.5 s)');
  await p.keyboard.press('KeyP');
  check(await p.evaluate(() => window.__jt.state.autopilot === true), 'P turns it back on');
  await wait(300);
  check(await p.evaluate(() => document.querySelector('#jt .ap').classList.contains('on')), 'HUD indicator shows the autopilot on');
} finally { await run.browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
