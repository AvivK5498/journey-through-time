// Plain Node checks for src/world/time.js:  node tools/time-test.mjs
import assert from 'node:assert/strict';
import * as T from '../src/world/time.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

ok('anchors', () => {
  const A = [[0, -300000], [30, -40000], [40, -10000], [55, -9000], [80, -3000], [85, -2650], [100, -2500], [120, 500],
    [165, 1450], [210, 1750], [255, 1914], [300, 2026]];
  for (const [c, y] of A) { near(T.yearAt(c), y); near(T.clockAt(y), c); }
  near(T.yearAt(-5), -300000);
  near(T.yearAt(500), 2026);
  near(T.clockAt(1492), 165 + 42 / 300 * 45);
});

ok('monotonic', () => {
  let prev = -Infinity;
  for (let c = 0; c <= 300; c += 0.01) {
    const y = T.yearAt(c);
    assert.ok(y > prev, `not increasing at ${c}`);
    prev = y;
  }
});

ok('eras and blend', () => {
  const s = { clock: 0, year: 0, eraIdx: -1, eraBlend: -1 };
  const at = (c) => { s.clock = c; T.updateTime(s); return [s.eraIdx, s.eraBlend]; };
  assert.deepEqual(at(0), [0, 0]);
  assert.deepEqual(at(30), [0, 0]);
  assert.equal(at(39.999)[0], 0); assert.ok(at(39.999)[1] > 0.999);
  assert.deepEqual(at(40), [1, 0]);
  assert.equal(at(77.5)[0], 1); near(at(77.5)[1], 0.5);
  assert.deepEqual(at(80), [2, 0]);
  assert.equal(at(119.9)[0], 2); assert.ok(at(119.9)[1] > 0.99);
  const starts = [0, 40, 80, 120, 165, 210, 255];
  starts.forEach((c, e) => { assert.deepEqual(at(c), [e, 0]); assert.equal(at(c + 1)[0], e); });
  assert.deepEqual(at(299.9), [6, 0]); // the last era has nothing to blend into
  assert.deepEqual(at(400), [6, 0]);
  assert.equal(T.ERA_COUNT, 7);
  assert.deepEqual(T.ERA_NAMES, ['Origins', 'First farmers', 'Ancient empires', 'Connected world', 'Sail and science', 'Industry', 'Modern']);
  near((at(100), s.year), -2500);
  near((at(255), s.year), 1914);
  let prev = 0;
  for (let c = 35; c < 40; c += 0.01) { const b = at(c)[1]; assert.ok(b >= prev); prev = b; }
});

ok('labels', () => {
  const L = T.yearLabel;
  assert.equal(L(-300000), '300,000 years ago');
  assert.equal(L(T.yearAt(30)), '42,000 years ago');
  assert.equal(L(-15000), '17,000 years ago');
  assert.equal(L(-9500), '9500 BCE');
  assert.equal(L(-10000), '10,000 BCE');
  assert.equal(L(-2560), '2560 BCE');
  assert.equal(L(-2563), '2560 BCE');
  assert.equal(L(-3020), '3000 BCE');
  assert.equal(L(500), '500 CE');
  assert.equal(L(3), '1 CE');
  assert.equal(L(-4), '1 CE');
  assert.equal(L(-6), '10 BCE');
  assert.equal(L(999), '1000');
  assert.equal(L(994), '990 CE');
  assert.equal(L(1163), '1160');
  assert.equal(L(1492.3), '1492');
  assert.equal(L(1914), '1914');
  assert.equal(L(2026), '2026');
  assert.equal(L(T.yearAt(300)), '2026');
  // Same rounded value -> the identical cached string; across a journey the memo is bounded.
  const a = L(-2561), b = L(-2559);
  assert.ok(a === b);
  const seen = new Set();
  for (let c = 0; c <= 300; c += 1 / 60) seen.add(L(T.yearAt(c)));
  console.log(`   ${seen.size} distinct labels in a journey`);
  assert.ok(seen.size < 1500);
  // Years tick one by one in the last eras (2.5 years per second at 40 m/s).
  assert.notEqual(L(T.yearAt(290)), L(T.yearAt(290.5)));
});

ok('events table', () => {
  assert.equal(T.EVENT_COUNT, 23);
  const keys = new Set();
  T.EVENTS.forEach((e, i) => {
    assert.equal(e.id, i);
    assert.ok(e.caption.length <= 90, `${e.name} caption ${e.caption.length} chars`);
    assert.ok(e.t1 > e.t0 && e.w1 > e.w0, `${e.name} windows`);
    assert.ok(e.p0 <= e.t0 && e.t1 <= e.p1, `${e.name}: logged only while it exists`);
    assert.ok(e.w0 >= e.t0 && e.w1 <= e.t1, `${e.name}: placement inside the log window`);
    assert.ok(/^[a-z0-9-]+$/.test(e.key) && !keys.has(e.key)); keys.add(e.key);
    if (e.place) {
      assert.ok(e.region >= 0 && e.region < 7 && (e.land === 0 || e.land === 1), `${e.name} region / land`);
      // wide enough to hit: 10 s = 400 m of road at 40 m/s (a fork every ~1.2 km)
      assert.ok(e.start || e.w1 - e.w0 >= 7.5, `${e.name} placement window ${e.w1 - e.w0} s`);
      // the year it stands for falls inside (or right by) its log window
      assert.ok(e.year <= -10000 || (T.clockAt(e.year) >= e.t0 - 3 && T.clockAt(e.year) <= e.t1 + 1), `${e.name} year ${e.year} at clock ${T.clockAt(e.year).toFixed(1)} vs ${e.t0}-${e.t1}`);
    }
  });
  assert.deepEqual(T.EVENTS.slice(0, 4).map((e) => e.yearText), ['300,000 years ago', '17,000 years ago', '9500 BCE', '2560 BCE']);
  assert.deepEqual(T.EVENTS.filter((e) => e.land === 1).map((e) => e.id), [12, 15, 16, 18, 19]);
  assert.equal(T.EVENTS[22].place, false);
  // Spread: walking the clock, the longest stretch with no event loggable stays short.
  let gap = 0, run = 0;
  for (let c = 0; c < 300; c += 0.5) {
    run = T.EVENTS.some((e) => e.place && c >= e.t0 && c < e.t1) ? 0 : run + 0.5;
    gap = Math.max(gap, run);
  }
  console.log(`   longest stretch with nothing loggable: ${gap} s`);
  assert.ok(gap <= 25);
});

ok('landmark states', () => {
  const o = new Float64Array(3);
  const st = (id, c) => { const on = T.landmarkState(id, c, o); return [on, o[0], o[1], o[2]]; };
  assert.deepEqual(st(0, 0), [true, 1, 0, 1]);
  assert.deepEqual(st(0, 30), [false, 0, 0, 0]);
  assert.deepEqual(st(1, 19), [false, 0, 0, 0]);
  assert.deepEqual(st(1, 25), [true, 1, 0, 1]);
  assert.deepEqual(st(1, 40), [false, 0, 0, 0]);
  assert.deepEqual(st(2, 39), [false, 0, 0, 0]);
  assert.deepEqual(st(2, 45), [true, 1, 0, 1]);
  assert.deepEqual(st(2, 61), [true, 1, 0, 1]); // still in use (loggable until 64)
  assert.deepEqual(st(2, 65), [true, 1, 1, 0]); // buried mound, not loggable
  assert.deepEqual(st(3, 84), [false, 0, 0, 0]);
  const g = st(3, 92.5); assert.equal(g[0], true); near(g[1], 0.5); assert.equal(g[3], 1);
  assert.deepEqual(st(3, 85), [true, 0, 0, 1]);
  assert.deepEqual(st(3, 105), [true, 1, 0, 1]);
  // landmarkFor: per region, prefers live over remnant.
  assert.equal(T.landmarkFor(0, 2, o), 0);
  assert.equal(T.landmarkFor(1, 30, o), 1);
  assert.equal(T.landmarkFor(1, 50, o), -1);
  assert.equal(T.landmarkFor(2, 30, o), -1);
  assert.equal(T.landmarkFor(2, 50, o), 2);
  assert.equal(T.landmarkFor(2, 70, o), 2); assert.equal(o[1], 1);
  assert.equal(T.landmarkFor(2, 90, o), 3); assert.equal(o[2], 1);
  // Round two: rising, standing, gone, moments.
  let c = st(7, 150); assert.ok(c[0] && c[1] > 0.55 && c[1] < 0.8 && c[3] === 1, 'cathedral rising'); // rises over 133-158 so it is in view early
  c = st(7, 230); assert.deepEqual([c[0], c[1], c[2], c[3]], [true, 1, 0, 0]); // finished, not loggable
  c = st(7, 299); assert.ok(c[2] > 0.2, 'cathedral weathered by the modern era');
  assert.equal(st(8, 150)[0], true); assert.equal(st(8, 170)[0], false); // the encampment moves on
  assert.ok(st(4, 82)[1] > 0.3 && st(4, 82)[1] < 0.7); assert.ok(st(4, 260)[2] >= 0.79); // Stonehenge raised, then a ruin
  assert.ok(st(14, 220)[1] < st(14, 240)[1]); // mill town grows through Industry
  assert.deepEqual(st(18, 267), [true, 0, 0, 1]); // Trinity: nothing yet
  c = st(18, 267.5); assert.equal(c[1], 1); assert.ok(c[2] < 0.05); // the flash
  assert.ok(st(19, 277)[1] === 0 && st(19, 278)[1] === 1); // Apollo lifts off at 1969
  assert.ok(st(20, 290)[2] > 0.4 && st(20, 290)[3] === 1); // the glacier melts in the last 20 s
  // Several events per biome over time.
  assert.equal(T.landmarkFor(3, 100, o), 4); assert.equal(T.landmarkFor(3, 160, o), 7); assert.equal(T.landmarkFor(3, 230, o), 14);
  assert.equal(T.landmarkFor(3, 260, o), 17);
  assert.equal(T.landmarkFor(2, 200, o), 13);
  assert.equal(T.landmarkFor(5, 180, o, 1), 12); assert.equal(T.landmarkFor(5, 180, o, 0), 5); assert.equal(o[2], 0);
  assert.equal(T.landmarkFor(6, 280, o, 1), 19);
  // Region steering for the graph.
  assert.equal(T.wantRegion(10, 0, 0), 1); // the cave
  assert.equal(T.wantRegion(40, 0, 0), 2); // Gobekli Tepe
  assert.equal(T.wantRegion(160, 1, 0), 5); // Machu Picchu on the far landmass
  assert.equal(T.wantRegion(240, 1, 0), 4); // the railroad
  assert.ok(T.wantRegion(150, 0, 1) >= 0 && T.wantRegion(150, 0, 1) !== T.wantRegion(150, 0, 0));
  assert.equal(T.wantRegion(305, 0, 0), -1);
});

ok('land bridge and loop', () => {
  assert.equal(T.LAND_BRIDGE_CLOCK, 55);
  near(T.yearAt(T.LAND_BRIDGE_CLOCK), T.LAND_BRIDGE_YEAR);
  assert.equal(T.landBridgeOpen(54.9), true);
  assert.equal(T.landBridgeOpen(55), false);
  assert.equal(T.straitOpen(54.9, 0), true);
  assert.equal(T.straitOpen(55, 0), false);
  assert.equal(T.straitOpen(20, 1), false); // no way back yet (ship from 1492, bridge: later)
  assert.equal(T.LOOP_CLOCK, 300);
  assert.equal(T.loopFog(280), 0);
  assert.equal(T.loopFog(300), 1);
  assert.ok(T.loopFog(298) > 0 && T.loopFog(298) < 1);
});

ok('no allocation on the frame path', () => {
  if (typeof globalThis.gc !== 'function') { console.log('   (run with --expose-gc to measure)'); return; }
  const s = { clock: 0.5, year: 0.5, eraIdx: 0, eraBlend: 0.5 };
  let sink = 0;
  const io = new Float64Array(4);
  const run = () => { for (let k = 0; k < 8; k++) for (let i = 0; i < 18000; i++) { s.clock = i * (1 / 60) + 0.001; T.updateTime(s); sink += T.yearLabel(s.year).length; io[3] = s.clock; if (T.landmarkStateIO(i % 23, io)) sink++; } };
  for (let w = 0; w < 6; w++) run(); // warm the label memo and the JIT
  let d = Infinity; // best of 3, to skip a measurement that lands on a JIT tier-up
  for (let m = 0; m < 3; m++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    run();
    d = Math.min(d, process.memoryUsage().heapUsed - h0);
  }
  console.log(`   heap delta over 8 journeys (144k frames) after warm-up: ${d} bytes (sink ${sink > 0})`);
  assert.ok(d < 64 * 1024); // one 16-byte allocation per frame would be ~2.3 MB
});

console.log(`\n${n} groups passed`);
