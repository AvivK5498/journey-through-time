// Strait crossings (world/crossing.js, graph.js ferry exits): the Ice Age land bridge before
// clock 55 and closed after; the ship near -> far and far -> near (car ends on the other
// landmass, clock advanced, never in the water, the hold released on the far quay); the player
// cannot drive off the ship and gets control back on the far quay; the bridge in era 6 driven
// both ways (across, and reversed back onto it); the ship -> bridge handover; no exceptions.
//   node tools/crossing-test.mjs [--no-build]
import { execSync } from 'node:child_process';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const open = async (q) => {
  const r = await openGame(p, srv.url, q);
  if (r.error) throw new Error(r.error);
  await p.waitForFunction(() => window.__captureReady || window.__game, null, { timeout: 60000 });
};

// Steps the scripted drive of the open capture page to `to` (scripted seconds) and returns a
// trace of the crossings met: per crossing edge, hold phases, landmass, lowest car height
// above the quay level over the water, time aboard.
const trace = (to) => p.evaluate((to) => {
  const g = window.__game, D = window.__drive, out = { flips: [], cross: [], errors: 0 };
  let land = g.state.landmass, cur = null;
  for (let t = 0; t <= to; t += 0.1) {
    g.dryStep(t);
    const c = g.crossing(), d = D.pose(), y = g.carPose[1];
    const f = c.list.find((x) => x.edge === d.track);
    if (f && d.s > f.quayS - 1 && d.s < f.len + 1) {
      if (!cur || cur.edge !== f.edge) { cur = { edge: f.edge, kind: f.kind, quayY: f.quayY, from: g.state.landmass, clock0: +g.state.clock.toFixed(1), minAbove: 99, maxAbove: -99, held: 0, ship: f.ship, maxLat: 0, vMin: 99 }; out.cross.push(cur); }
      const above = y - f.quayY;
      cur.minAbove = Math.min(cur.minAbove, +above.toFixed(2)); cur.maxAbove = Math.max(cur.maxAbove, +above.toFixed(2));
      if (c.hold === 2) cur.held += 0.1;
      cur.maxLat = Math.max(cur.maxLat, +d.roadDist.toFixed(2));
      cur.vMin = Math.min(cur.vMin, +d.v.toFixed(1));
      cur.clock1 = +g.state.clock.toFixed(1); cur.to = g.state.landmass;
    } else if (cur && f === undefined) cur = null;
    if (g.state.landmass !== land) { out.flips.push({ to: g.state.landmass, clock: +g.state.clock.toFixed(1), hold: c.hold }); land = g.state.landmass; }
  }
  out.end = { clock: +g.state.clock.toFixed(1), land: g.state.landmass, hold: g.crossing().hold, v: +D.pose().v.toFixed(1) };
  return out;
}, to);

try {
  // --- 1. the land bridge: open before 55 (?land=1 takes it), closed (and marked) after
  await open('?script=1&capture=1&placeholders=1&seed=1');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  let crossedEarly = 0;
  for (const seed of [1, 2, 3]) {
    const r = await p.evaluate((seed) => window.__game.dryRun(seed, 0.25, 70, 1), seed);
    if (r.landmass.some((x) => x.land === 1 && x.clock < 55)) crossedEarly++;
  }
  check(crossedEarly === 3, `land bridge: ?land=1 crosses to the far landmass before clock 55 on ${crossedEarly}/3 seeds`);
  await open('?script=1&capture=1&placeholders=1&seed=3&t0=58&biome=1'); // an ice start: a causeway at the first fork
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  const lb = await p.evaluate(() => { const g = window.__game; let marker = false, open = false, far = false, n = 0; for (let t = 0; t < 40; t += 0.25) { g.dryStep(t); const s = g.sites(); n = Math.max(n, s.bridges.length); if (s.bridges.some((b) => b.available)) open = true; if (g.crossing().marker) marker = true; if (g.state.landmass === 1) far = true; } return { marker, open, far, n }; });
  check(lb.n > 0 && !lb.open && !lb.far, `land bridge closed after clock 55 (no open causeway, car stays near; causeways seen ${lb.n})`);
  check(lb.marker, 'the flooded land bridge has its marker at the road end');

  // --- 2. ship near -> far (scripted autopilot, forced onto the ferry exit)
  await open('?script=1&capture=1&placeholders=1&seed=1&t0=176&route=0');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  let tr = await trace(60);
  let c = tr.cross[0];
  check(!!c && c.ship && c.from === 0 && c.to === 1, `ship near -> far: crossing met (${c ? `quay clock ${c.clock0}, ${c.from}->${c.to}` : 'none'})`);
  if (c) {
    check(c.held >= 8 && c.held <= 14, `passage aboard ${c.held.toFixed(1)} s (8-14 s incl. boarding)`);
    check(c.minAbove > -0.3, `never in the water: car at least ${c.minAbove} m relative to the quay level (water 2.2 m below)`);
    check(c.maxLat < 0.8, `held to the ship's lane (max ${c.maxLat} m off the centre line)`);
    check(c.clock1 - c.clock0 > 8, `clock advanced over the passage (${c.clock0} -> ${c.clock1})`);
  }
  check(tr.end.land === 1 && tr.end.hold === 0 && tr.end.v > 30, `after the far quay: far landmass, released, cruising again (v ${tr.end.v})`);

  // --- 3. ship far -> near: runs that took the land bridge (?land=1) come back after 1492
  await open('?script=1&capture=1&placeholders=1&seed=1');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  let back = 0, backSeeds = [];
  for (let seed = 1; seed <= 8; seed++) {
    const r = await p.evaluate((seed) => window.__game.dryRun(seed, 0.25, 301, 1), seed);
    const fl = r.landmass;
    const i = fl.findIndex((x) => x.land === 1 && x.clock < 55);
    if (i >= 0 && fl.slice(i + 1).some((x) => x.land === 0 && x.clock > 171)) { back++; backSeeds.push(seed); }
  }
  check(back >= 1, `far -> near: ${back}/8 seeds that crossed by the land bridge sail back after 1492 (seeds ${backSeeds.join(',')})`);
  if (backSeeds.length) {
    await open(`?script=1&capture=1&placeholders=1&seed=${backSeeds[0]}&land=1`);
    await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
    tr = await trace(300);
    c = tr.cross.find((x) => x.from === 1 && x.to === 0);
    check(!!c && c.minAbove > -0.3, `far -> near crossing: ${c ? `${c.ship ? 'ship' : 'bridge'} at clock ${c.clock0}, lowest ${c.minAbove} m vs the quay` : 'not traced'}`);
  }

  // --- 4. bridge (era 6), near -> far, driven normally (no hold), on the deck
  await open('?script=1&capture=1&placeholders=1&seed=1&t0=245&route=0');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  tr = await trace(45);
  c = tr.cross[0];
  check(!!c && !c.ship && c.held === 0 && c.to === 1, `bridge near -> far without a hold (${c ? `clock ${c.clock0}` : 'none'})`);
  if (c) check(c.minAbove > -0.2 && c.maxAbove > 7 && c.vMin > 35, `on the arched deck (height ${c.minAbove}..${c.maxAbove} m over the quay, min speed ${c.vMin})`);

  // --- 5. handover: the steamer waits until 258, then fades and the bridge rises; the car crosses on it
  await open('?script=1&capture=1&placeholders=1&seed=4&t0=205&route=1,0');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  const ho = await p.evaluate(() => {
    const g = window.__game, o = {};
    for (let t = 0; t < 90; t += 0.1) {
      g.dryStep(t);
      const c = g.crossing(), k2 = c.list.find((x) => x.kind === 2);
      if (!k2) continue;
      if (g.state.clock > 256.5 && g.state.clock < 257.5 && o.before === undefined) o.before = { ...c.ships, shown: c.shown === k2.edge };
      if (g.state.clock > 262 && o.after === undefined) o.after = { ...c.ships, built: k2.built, shown: c.shown === k2.edge };
      if (g.state.landmass === 1 && o.far === undefined) o.far = +g.state.clock.toFixed(1);
    }
    return o;
  });
  check(!!ho.before && ho.before.steamer && !ho.before.bridge && ho.before.shown, `before 258 the steamer waits at the quay (${JSON.stringify(ho.before)})`);
  check(!!ho.after && !ho.after.steamer && ho.after.bridge && ho.after.built >= 1, `after 258 the bridge stands, the ship is gone (${JSON.stringify(ho.after)})`);
  check(ho.far > 258, `the car crosses on the bridge (far landmass at clock ${ho.far})`);

  // --- 6. player: on the ship the keys do nothing, control returns on the far quay; on the
  // bridge the car can be reversed back onto the deck and stays on it
  for (const mode of ['ship', 'bridge']) {
    await p.goto(srv.url + `index.html?autodrive=1&fresh=1&placeholders=1&seed=1&t0=${mode === 'ship' ? 176 : 245}`);
    await p.waitForFunction(() => window.__game && window.__drive, null, { timeout: 60000 });
    const R = { held: 0, maxLat: 0, minAbove: 99, land: 0, released: false, braked: false, rev: null };
    let phase = 0, t0 = Date.now(), quayY = 0;
    while (Date.now() - t0 < 110000) {
      const s = await p.evaluate(() => {
        const g = window.__game, D = window.__drive, c = g.crossing(), d = D.pose();
        // steer for the strait exit at the next fork (the autopilot follows car.preferred)
        const cr = c.list.find((x) => x.presence > 0);
        if (cr && !c.list.some((x) => x.edge === d.track)) { const e = D.edge(cr.edge); const ex = D.exits(e.from).findIndex((q) => q.e === cr.edge); if (ex >= 0 && D.edge(d.cur).to === e.from) D.car.preferred = ex; }
        const f = c.list.find((x) => x.edge === d.track);
        return { hold: c.hold, land: g.state.landmass, v: d.v, s: d.s, lat: d.roadDist, y: g.carPose[1], f: f ? { quayS: f.quayS, len: f.len, quayY: f.quayY } : null, clock: g.state.clock };
      });
      if (s.f) quayY = s.f.quayY;
      if (s.f && s.s > s.f.quayS && s.s < s.f.len) { R.minAbove = Math.min(R.minAbove, s.y - s.f.quayY); R.maxLat = Math.max(R.maxLat, s.lat); }
      if (mode === 'ship') {
        if (phase === 0 && s.hold === 2) { phase = 1; await p.keyboard.down('KeyS'); await p.keyboard.down('KeyA'); }
        if (phase === 1) { R.held++; if (s.hold !== 2) { phase = 2; await p.keyboard.up('KeyA'); } }
        if (phase === 2) { R.land = s.land; await p.waitForTimeout(1500); const v = await p.evaluate(() => window.__drive.pose().v); R.braked = v < 3; R.released = true; await p.keyboard.up('KeyS'); break; }
      } else {
        if (phase === 0 && s.f && s.s > s.f.quayS + 60) { phase = 1; await p.keyboard.down('KeyS'); }
        if (phase === 1 && s.land === 1 && s.f === null) { phase = 2; }
        if (phase === 1 && s.f && s.s > s.f.len - 2) phase = 2;
        if (phase === 1 && s.v < -1) { phase = 3; } // reversing
        if (phase === 3) {
          await p.waitForTimeout(3000);
          R.rev = await p.evaluate(() => { const g = window.__game, d = window.__drive.pose(); return { v: +d.v.toFixed(1), lat: +d.roadDist.toFixed(2), y: +g.carPose[1].toFixed(2), wet: d.wet }; });
          R.land = s.land; await p.keyboard.up('KeyS'); break;
        }
      }
      await p.waitForTimeout(100);
    }
    if (mode === 'ship') {
      check(R.held > 20 && R.maxLat < 0.8, `player aboard: brake + steer held for ${(R.held / 10).toFixed(1)} s, car stays in the lane (max ${R.maxLat.toFixed(2)} m)`);
      check(R.minAbove > -0.3, `player never in the water (lowest ${R.minAbove.toFixed(2)} m vs the quay)`);
      check(R.released && R.braked && R.land === 1, `control returns on the far quay (brake stops the car, landmass ${R.land})`);
    } else {
      check(!!R.rev && R.rev.v < -1 && R.rev.lat < 6 && R.rev.y > quayY - 0.3, `bridge driven backwards on the deck: ${JSON.stringify(R.rev)} (quay level ${quayY.toFixed(1)})`);
      check(R.minAbove > -0.3, `player on the bridge never below the deck (lowest ${R.minAbove.toFixed(2)} m vs the quay)`);
    }
  }
  check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
} finally { await run.browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
