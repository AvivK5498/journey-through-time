// Free-roam check (free-drive mode, ?autodrive=1&fresh=1, then P: autopilot off). The car is
// driven by injected key events from an in-page controller (W/S/A/D, as a player would):
//   - autopilot toggling (state + HUD), hands-off with it off: nothing steers, it coasts
//   - W accelerates, release coasts gently, S brakes then reverses
//   - leave the root road before its fork, cross country past the junction 180 m out, and
//     rejoin one of the exits: the fork taken is the road rejoined
//   - drive straight away from the roads: no pull inside 400 m (hands-off heading unchanged
//     at ~330 m), then with W held the boundary slows and turns the car back (max < 600 m,
//     edge fog up), never a hard stop
//   - reverse off-road; return; autopilot back on follows the road
//   - the clock never decreases and never jumps; no page errors
//   - the coast (?biome=6): driving at the sea, the car is stopped softly at the shore
// --shots: also drive 300 m off-road in savannah, ice and river desert and save views to
// reports/round2/driving/ (--shots-only: savannah and desert views, no checks).
//   node tools/roam-test.mjs [--no-build] [--shots | --shots-only]
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';

const SHOTS = process.argv.includes('--shots') || process.argv.includes('--shots-only');
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const OUT = ROOT + 'reports/round2/driving/';
if (SHOTS) mkdirSync(OUT, { recursive: true });
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const wait = (ms) => p.waitForTimeout(ms);
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const P = () => p.evaluate(() => window.__drive.pose());
const ctl = (o) => p.evaluate((o) => Object.assign(window.__ctl, o), o);
const fmt = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]));

// In-page controller + clock sampler. Modes: off (no keys), keys (fixed keys), point (drive to
// tx,tz), heading (hold absolute heading h), road (follow the nearest road). speed: target m/s.
function install() {
  const C = window.__ctl = { mode: 'off', tx: 0, tz: 0, h: 0, speed: 28, keys: '', lastClock: -1, lastT: 0, lastV: 0, back: 0, jumps: 0, maxJump: 0, maxRatio: 0, loops: 0, frames: 0 };
  const down = new Set();
  const key = (code, on) => {
    if (on === down.has(code)) return;
    if (on) down.add(code); else down.delete(code);
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, bubbles: true }));
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  function tick(ts) {
    requestAnimationFrame(tick);
    const D = window.__drive, q = D.pose();
    // Clock sampler: never backwards (except the loop into a new world at clock 0), and never
    // more than the car's own travel this frame allows (|v| dt / 40, x1.6 catch-up, dt <= 0.1).
    if (C.lastClock >= 0) {
      const d = q.clock - C.lastClock;
      if (d < -1e-9) { if (q.clock < 1 && C.lastClock > 100) C.loops++; else C.back++; }
      else {
        const dt = Math.min(0.1, (ts - C.lastT) / 1000);
        const allow = Math.max(Math.abs(q.v), Math.abs(C.lastV)) * dt * 2.5 / 40 + 0.004; // 1.6x catch-up + frame/sim phase slack
        if (d > allow) C.jumps++;
        if (d > C.maxJump) C.maxJump = d;
        if (allow > 0.0041 && d / allow > C.maxRatio) C.maxRatio = d / allow;
      }
    }
    C.lastClock = q.clock; C.lastT = ts; C.lastV = q.v; C.frames++;
    let want = null;
    if (C.mode === 'point') want = Math.atan2(C.tz - q.z, C.tx - q.x);
    else if (C.mode === 'heading') want = C.h;
    else if (C.mode === 'road') { const n = D.nearest(q.x, q.z); const t = D.point(n.e, n.s + 28); want = Math.atan2(t.z - q.z, t.x - q.x); }
    if (C.mode === 'keys') {
      for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) key(c, C.keys.includes(c));
      return;
    }
    if (want === null) { for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) key(c, false); return; }
    const err = wrap(want - q.h);
    key('KeyD', err > 0.03); key('KeyA', err < -0.03);
    key('KeyW', q.v < C.speed - 1);
    key('KeyS', C.speed >= 0 && q.v > C.speed + 4 && q.v > 2);
  }
  requestAnimationFrame(tick);
}

// Drive to (x, z) until within r metres (or timeout ms). Returns the final pose.
async function driveTo(x, z, r = 25, timeout = 60000, speed = 28) {
  await ctl({ mode: 'point', tx: x, tz: z, speed });
  await p.waitForFunction(([x, z, r]) => { const q = window.__drive.pose(); return Math.hypot(q.x - x, q.z - z) < r; }, [x, z, r], { timeout, polling: 50 }).catch(() => {});
  return P();
}
// Back to the nearest road and follow it for ms.
async function rejoin(ms = 4000) {
  const q = await P();
  const n = await p.evaluate(([x, z]) => window.__drive.onRoute(x, z), [q.x, q.z]);
  const t = await p.evaluate(([e, s]) => window.__drive.point(e, s + 60), [n.e, n.s]);
  console.log('rejoin: route edge', n.e, 's', n.s.toFixed(0), 'dist', n.d.toFixed(0));
  for (let k = 0; k < 9; k++) {
    const r = await driveTo(t.x, t.z, 25, 10000);
    console.log('  rejoin', k, fmt({ x: r.x, z: r.z, v: r.v, nearD: r.nearD, left: Math.hypot(r.x - t.x, r.z - t.z), wet: r.wet.join(',') }));
    if (Math.hypot(r.x - t.x, r.z - t.z) < 25) break;
    if (Math.abs(r.v) < 1) { // blocked (water, a steep face): back off and go round
      await ctl({ mode: 'keys', keys: 'KeyS' }); await wait(2500);
      await ctl({ mode: 'heading', h: r.h + (k & 1 ? -1 : 1) * Math.PI / 2, speed: 20 }); await wait(5000);
    }
  }
  await ctl({ mode: 'road', speed: 28 });
  await wait(ms);
  return P();
}
// Measure the heading change with no keys over ms (after a 400 ms settle of the steering).
async function handsOffTurn(ms) {
  await ctl({ mode: 'off' });
  await wait(400);
  const a = await P();
  await wait(ms);
  const b = await P();
  return { dh: Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)), a, b };
}

async function offroadShots(name) {
  // From the road: head out perpendicular until 300 m off, stop, look.
  const q = await P();
  const n = await p.evaluate(([x, z]) => window.__drive.nearest(x, z), [q.x, q.z]);
  const side = Math.sin(q.h - n.h) >= 0 ? 1 : -1;
  await ctl({ mode: 'heading', h: n.h + side * Math.PI / 2, speed: 28 });
  await p.waitForFunction(() => window.__drive.pose().nearD > 300, null, { timeout: 60000, polling: 50 }).catch(() => {});
  await ctl({ mode: 'keys', keys: 'KeyS' });
  await p.waitForFunction(() => window.__drive.pose().v < 3, null, { timeout: 15000, polling: 50 }).catch(() => {});
  await ctl({ mode: 'off' });
  // Swing round so the road is in view for one shot.
  const s = await P();
  console.log(name, 'off-road', fmt(s), 'biome', await p.evaluate(() => [window.__jt.state.biomeA, window.__jt.state.biomeB, +window.__jt.state.biomeBlend.toFixed(2)]));
  await wait(1500);
  await p.screenshot({ path: OUT + name + '-300m-a.jpg', type: 'jpeg', quality: 82 });
  await ctl({ mode: 'heading', h: s.h + Math.PI * 0.6, speed: 8 });
  await wait(5000);
  await ctl({ mode: 'keys', keys: 'KeyS' });
  await wait(1200);
  await ctl({ mode: 'off' });
  await wait(1200);
  await p.screenshot({ path: OUT + name + '-300m-b.jpg', type: 'jpeg', quality: 82 });
  await p.keyboard.press('KeyC'); await wait(1500);
  await p.screenshot({ path: OUT + name + '-300m-fp.jpg', type: 'jpeg', quality: 82 });
  await p.keyboard.press('KeyC');
  await rejoin(3000);
}

// With the autopilot on, aim for an exit of `region` at the coming forks until the car is on
// such a road with its biome under the car.
async function reachRegion(region, timeout = 150000) {
  await ctl({ mode: 'off' });
  if (!(await P()).autopilot) await p.keyboard.press('KeyP');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await p.evaluate((r) => {
      const D = window.__drive, q = D.pose(), st = window.__jt.state;
      const ed = D.edge(q.cur);
      if (ed.region === r && st.biomeA === r && st.biomeBlend < 0.15 && q.s > 250 && q.track === q.cur) return true;
      const ex = D.exits(ed.to).filter((x) => x.ok && x.e >= 0);
      const m = ex.find((x) => x.region === r) || ex.find((x) => D.exits(D.edge(x.e).to).some((y) => y.region === r)) || ex[0];
      if (m && !q.fork) D.car.preferred = m.i;
      return false;
    }, region);
    if (ok) break;
    await wait(250);
  }
  await p.keyboard.press('KeyP'); // autopilot off again
}

try {
  await openGame(p, srv.url, '?autodrive=1&fresh=1');
  await p.waitForFunction(() => window.__drive && window.__jt, null, { timeout: 30000 });
  await wait(1500);
  await p.evaluate(install);

  if (process.argv.includes('--shots-only')) { // just the biome views
    await p.keyboard.press('KeyP'); await wait(300);
    await offroadShots('savannah');
    await reachRegion(1);
    await offroadShots('ice');
    await reachRegion(2);
    await offroadShots('desert');
    throw new Error('shots only (no checks run)');
  }
  // --- toggling
  check((await P()).autopilot === true, '?autodrive=1 starts with the autopilot on');
  await p.keyboard.press('KeyP'); await wait(200);
  let q = await P();
  check(q.autopilot === false && !(await p.evaluate(() => document.querySelector('#jt .ap').classList.contains('on'))), 'P: autopilot off (state and HUD)');
  await p.keyboard.press('KeyP'); await wait(200);
  check((await P()).autopilot === true && await p.evaluate(() => document.querySelector('#jt .ap').classList.contains('on')), 'P again: on (state and HUD)');
  await p.keyboard.press('KeyP'); await wait(200);

  // --- hands-off on the road, autopilot off: nothing steers, gentle coast
  const v0 = (await P()).v;
  let t = await handsOffTurn(2000);
  console.log('hands-off on road', fmt(t.b));
  check(Math.abs(t.dh) < 0.005, `hands-off, autopilot off: no lane assist (heading change ${t.dh.toFixed(4)} rad in 2 s)`);
  check(v0 - t.b.v > 0.8 && v0 - t.b.v < 8, `coasts down gently (${v0.toFixed(1)} -> ${t.b.v.toFixed(1)} m/s in 2.4 s)`);

  // --- fork crossing: leave the root road, pass its junction 180 m out, rejoin an exit
  q = await P();
  const root = q.cur, rootE = await p.evaluate((e) => window.__drive.edge(e), root);
  const exits = (await p.evaluate((n) => window.__drive.exits(n), rootE.to)).filter((x) => x.ok && x.e >= 0);
  // Prefer the exit that is not the straightest (the one the autopilot would not take).
  exits.sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle));
  const X = exits[0];
  const side = X.angle >= 0 ? 1 : -1;
  console.log('root edge', root, fmt(rootE), 'exits', exits.map((x) => fmt(x)), '-> rejoin exit', X.i, 'edge', X.e, 'side', side);
  const w1 = await p.evaluate(([e, s, l]) => window.__drive.point(e, s, l), [root, rootE.len - 220, side * 180]);
  const w2 = await p.evaluate(([e, l]) => window.__drive.point(e, 380, l), [X.e, side * 180]);
  const w3 = await p.evaluate((e) => window.__drive.point(e, 560, 0), X.e);
  q = await driveTo(w1.x, w1.z);
  console.log('w1 (root, 180 m out)', fmt(q));
  check(q.nearD > 120 && q.cur === root, 'off-road beside the root road, still on it in the graph');
  q = await driveTo(w2.x, w2.z);
  console.log('w2 (past the junction, 180 m out)', fmt(q));
  check(q.cur === root, 'no commit while far from the exits (graph.cur still the root road)');
  q = await driveTo(w3.x, w3.z, 20);
  await ctl({ mode: 'road', speed: 28 });
  await p.waitForFunction((r) => window.__drive.pose().cur !== r, root, { timeout: 15000, polling: 50 }).catch(() => {});
  q = await P();
  console.log('rejoined', fmt(q));
  check(q.cur === X.e && q.prev === root, `the fork taken is the road rejoined (cur ${q.cur}, wanted ${X.e})`);

  // --- throttle / coast / reverse on the road, autopilot off
  await wait(2000);
  q = await P();
  await ctl({ mode: 'road', speed: 45 }); await wait(3000);
  let q2 = await P();
  check(q2.v > q.v + 3, `W accelerates on the road (${q.v.toFixed(1)} -> ${q2.v.toFixed(1)} m/s)`);
  await ctl({ mode: 'road', speed: -99 }); // steer only, no keys for speed
  await wait(3000);
  let q3 = await P();
  check(q2.v - q3.v > 1.5 && q2.v - q3.v < 9 && q3.nearD < 6, `released: coasts on the road (${q2.v.toFixed(1)} -> ${q3.v.toFixed(1)} m/s in 3 s)`);

  // --- straight away from the roads: no pull inside 400 m, soft turn-back beyond
  q = await P();
  let n = await p.evaluate(([x, z]) => window.__drive.nearest(x, z), [q.x, q.z]);
  // Away from the roads. Round three: a ridge stands between biomes (a wall by design, checked by
  // tools/tunnel-test.mjs), so the car is first set down beside a live road where a heading leads
  // 650 m out with no ridge on the way and ends far from every road.
  const away = await p.evaluate(([x0, z0, a0]) => {
    const T = window.__tunnel, D = window.__drive;
    const far = (x, z) => { const nn = D.nearest(x, z); return Math.hypot(nn.x - x, nn.z - z); };
    const clear = (x, z, a) => { if (!T) return true; for (let r = 0; r <= 650; r += 20) if (T.ridge(x + Math.cos(a) * r, z + Math.sin(a) * r).ridge > 1.5) return false; return true; };
    let best = null;
    const starts = [[x0, z0]];
    if (T) for (const E of T.edges()) if (E.pres > 0.9) for (let s = 100; s < E.len; s += 150) for (const lat of [-60, 60]) { const q = T.at(E.e, s, lat); starts.push([q[0], q[2]]); }
    for (const [x, z] of starts) {
      for (let k = 0; k < 16; k++) {
        const a = a0 + k * Math.PI / 8, d = far(x + Math.cos(a) * 650, z + Math.sin(a) * 650);
        if (d > 560 && far(x + Math.cos(a) * 330, z + Math.sin(a) * 330) > 250 && clear(x, z, a) && (!best || d > best.d)) best = { x, z, a, d };
      }
      if (best && best.d > 620) break;
    }
    if (!best) return a0;
    if (best.x !== x0 || best.z !== z0) D.place(best.x, best.z, best.a, 20);
    return best.a;
  }, [q.x, q.z, n.h - side * Math.PI / 2]);
  await ctl({ mode: 'heading', h: away, speed: 40 });
  await p.waitForFunction(() => window.__drive.pose().nearD > 100, null, { timeout: 30000, polling: 50 });
  t = await handsOffTurn(1500);
  console.log('hands-off at ~100 m', fmt(t.b));
  check(Math.abs(t.dh) < 0.005, `no pull at ${t.a.nearD.toFixed(0)} m (heading change ${t.dh.toFixed(4)} rad)`);
  await ctl({ mode: 'heading', h: away, speed: 40 });
  await p.waitForFunction(() => window.__drive.pose().nearD > 320, null, { timeout: 40000, polling: 50 });
  t = await handsOffTurn(1500);
  console.log('hands-off at ~330 m', fmt(t.b));
  check(Math.abs(t.dh) < 0.005 && t.b.nearD < 400, `no pull at ${t.a.nearD.toFixed(0)}-${t.b.nearD.toFixed(0)} m (heading change ${t.dh.toFixed(4)} rad)`);
  // W held, no steering: the boundary must slow and turn the car.
  await ctl({ mode: 'keys', keys: 'KeyW' });
  let maxD = 0, maxFog = 0, vAtMax = 0, last = null;
  const tEnd = Date.now() + 42000; // (round three: the run out starts from a set-down point, 20 m/s)
  while (Date.now() < tEnd) {
    last = await P();
    if (last.nearD > maxD) { maxD = last.nearD; vAtMax = last.v; }
    if (last.fog > maxFog) maxFog = last.fog;
    if (maxD > 420 && last.nearD < maxD - 80) break;
    await wait(100);
  }
  console.log('boundary', { maxD: +maxD.toFixed(1), vAtMax: +vAtMax.toFixed(1), maxFog: +maxFog.toFixed(2) }, fmt(last));
  check(maxD > 400 && maxD < 600, `soft boundary: furthest ${maxD.toFixed(0)} m from a road with W held`);
  check(last.nearD < maxD - 80, `turned back toward the roads with W still held (now ${last.nearD.toFixed(0)} m)`);
  check(vAtMax > 2, `never a wall: still rolling at ${vAtMax.toFixed(1)} m/s at the furthest point`);
  check(maxFog > 0.5, `edge fog rises (state.edgeFog max ${maxFog.toFixed(2)})`);

  // --- reverse off-road
  await ctl({ mode: 'keys', keys: 'KeyS' });
  await wait(5000);
  q = await P();
  check(q.v < -1, `S brakes then reverses off-road (${q.v.toFixed(1)} m/s)`);
  await ctl({ mode: 'off' });

  // --- back, autopilot on follows the road
  q = await rejoin(2000);
  console.log('back on the road', fmt(q));
  await ctl({ mode: 'off' });
  await p.keyboard.press('KeyP');
  await wait(10000);
  q = await P();
  console.log('autopilot 10 s', fmt(q));
  check(q.autopilot && q.roadDist < 4 && q.v > 30, `autopilot on: follows the road (${q.roadDist.toFixed(1)} m off, ${q.v.toFixed(1)} m/s)`);

  // --- open water: drive at the thawed land-bridge strait (if this world has one in reach)
  {
    const info = await p.evaluate(() => { const g = window.__game.sites(); return { strait: g.strait, bridges: g.bridges }; });
    const [cx, cz, dx, dz, hw, wy, open] = info.strait;
    q = await P();
    const far = Math.hypot(q.x - cx, q.z - cz);
    console.log('strait', info.strait, 'bridges', info.bridges, 'distance', far.toFixed(0));
    if (hw > 0 && open > 0.5 && far < 2500) {
      // Approach along the causeway from the near shore, then aim straight across.
      const near = (q.x - cx) * dx + (q.z - cz) * dz < 0 ? -1 : 1;
      await driveTo(cx + dx * near * (hw + 120), cz + dz * near * (hw + 120), 30, 120000);
      await ctl({ mode: 'point', tx: cx - dx * near * (hw + 200), tz: cz - dz * near * (hw + 200), speed: 28 });
      let minU = 1e9, wetMax = 0;
      const tEnd2 = Date.now() + 25000;
      while (Date.now() < tEnd2) {
        const r = await P();
        const u = Math.abs((r.x - cx) * dx + (r.z - cz) * dz);
        if (u < minU) minU = u;
        if (r.wet[0] > wetMax) wetMax = r.wet[0];
        await wait(100);
      }
      q = await P();
      console.log('strait approach', { hw, minU: +minU.toFixed(1), wetMax: +wetMax.toFixed(2) }, fmt({ v: q.v, wet: q.wet.join(',') }));
      check(minU > hw - 25 && wetMax > 0.5, `open water stops the car at the shore (closest ${minU.toFixed(0)} m from the strait centre line, water half-width ${hw} m)`);
      await ctl({ mode: 'off' });
    } else console.log('skip strait check: none open within reach');
  }

  if (SHOTS) {
    await p.keyboard.press('KeyP'); await wait(300);
    await offroadShots('savannah');
    await reachRegion(1);
    await offroadShots('ice');
    await reachRegion(2);
    await offroadShots('desert');
  }

  const C = await p.evaluate(() => { const c = window.__ctl; return { back: c.back, jumps: c.jumps, maxJump: c.maxJump, maxRatio: c.maxRatio, loops: c.loops, frames: c.frames }; });
  console.log('clock sampler', C, 'clock', (await P()).clock.toFixed(2));
  check(C.back === 0, `the clock never decreased (${C.frames} frames, ${C.loops} loop restarts)`);
  check(C.jumps === 0, `the clock never jumped (largest step ${C.maxJump.toFixed(4)} s, ${C.maxRatio.toFixed(2)}x of the car's own travel allowance)`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  // --- the coast's sea (?biome=6): drive off the road straight at the sea; the car must be
  // stopped softly at the shore like the strait (water ahead seen by the probes, never in it).
  {
    await openGame(p, srv.url, '?autodrive=1&fresh=1&biome=6&biomelock=1');
    await p.waitForFunction(() => window.__drive && window.__jt && window.__world, null, { timeout: 30000 });
    await wait(1500);
    await p.evaluate(install);
    await ctl({ mode: 'off' });
    await wait(6000); // autopilot on: drive along the coast road for a while
    await p.keyboard.press('KeyP'); await wait(300);
    const sz = await p.evaluate(() => window.__world.sea[2]);
    q = await P();
    await ctl({ mode: 'heading', h: Math.atan2(sz, 0), speed: 24 });
    let wetMax = 0, inSea = 0, maxDepth = 0, minV = 99, n = 0;
    const tEnd3 = Date.now() + 20000;
    while (Date.now() < tEnd3) {
      const r = await P();
      const g = await p.evaluate(([x, z]) => window.__world.groundAt(x, z), [r.x, r.z]);
      const d = g.seaY - g.h;
      if (d > maxDepth) maxDepth = d;
      if (g.sea > 0.9) inSea++;
      if (r.wet[0] > wetMax) wetMax = r.wet[0];
      if (n++ > 40 && Math.abs(r.v) < minV) minV = Math.abs(r.v);
      await wait(100);
    }
    q = await P();
    console.log('coast', fmt({ wetMax, inSea, maxDepth, minV, nearD: q.nearD, v: q.v }));
    check(wetMax > 0.5 && inSea === 0 && maxDepth < 0.3 && Math.abs(q.v) < 3, `the sea stops the car at the shore (water ahead ${wetMax.toFixed(2)}, ${inSea} samples out at sea, deepest ${maxDepth.toFixed(2)} m, now ${q.v.toFixed(1)} m/s, ${q.nearD.toFixed(0)} m from the road)`);
    check(errors.length === 0, 'no page errors on the coast' + (errors.length ? ': ' + errors.join(' | ') : ''));
  }
} catch (e) {
  console.log('FAIL exception:', e.message); fails++;
} finally { await run.browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
