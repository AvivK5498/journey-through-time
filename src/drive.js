// The drive: fixed-step simulation (120 Hz) of the car on the graph, the autopilot used by
// the scripted run / recording / poses, and the journey state it owns (clock, speed,
// biome blend, distance, surface).
//
//   resetDrive(seed)        new world, car at the start of the first road
//   driveFree(dt, keys)     player driving (interpolated between fixed steps)
//   driveScript(t)          autopilot drive, a pure function of t (fast-forwards/rewinds)
//   posePrepare(n)          run the autopilot to pose n's moment; returns its camera mode
//   toggleAutopilot()       player autopilot on/off (state.autopilot; P key in main.js)
//
// The autopilot cruises at 40 m/s and takes, at each fork, the exit toward where history
// happens next: a road that already carries a landmark still to log (or whose exits do), else
// the exit whose region and landmass offer the next not-yet-logged event (world/time.js
// EVENTS, with a landmark module) whose placement window the car can still reach on that road
// or the next, else the straightest. Graph.js steers an exit of every fork toward the most
// urgent event's region. Crossing the strait (another landmass: the Ice Age land bridge, or a
// ship / bridge from 1492) is taken when a run that crosses now can still log more events
// than one that does not (crossPlan: a greedy schedule of the unlogged events by closing
// time on each landmass, allowing up to two later crossings). ?land=1 / setPreferLand(1)
// takes the land bridge whenever it is open (?land=0 never does); later crossings still
// follow the events. ?land=2 heads for the far landmass at every crossing and stays there
// (route-test's coverage pass for the far events). A ?route=i,j,k list (exit indexes, left to right, clamped) overrides it
// fork by fork; single-exit quay nodes (after a ferry) do not count as forks.

import { state } from './state.js';
import { chaseRig, firstPersonRig } from './camera.js';
import { setNoiseSeed } from './world/noise.js';
import { graph, resetGraph, updateGraph, pump, pumpAll, edgeJ0, edgeLen, edgeTo, edgeFrom, nodeExitCount, nodeExit, exitAvailable, SIM_DT, graphFocus, clockBase, exitRegion, exitAngle, nodeJ, nodeBridge, edgeRegion, frameAt, pointAt, nearestRoad, project, nodeLand, landAt, exitCrosses, FERRY_WATER } from './world/graph.js';
import { resetSites, edgeSiteValue, sitePass, seenMask, DEFS } from './world/sites.js';
import { EVENTS, EVENT_COUNT, SHIP_CLOCK } from './world/time.js';
import { biomeExact } from './world/world.js';
import { carBiome, setStateBiome } from './world/biomes.js';
import { car, cur, pose, resetCar, stepCar, interpolate, clearDust, bodyPoint, simIO, placeCarAt } from './car.js';

export const H = SIM_DT;
const START_S = 40;
const BQC = new Float64Array(8);
const PQ0 = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const ROUTE = PQ0 && PQ0.get('route') ? PQ0.get('route').split(',').map((v) => parseInt(v, 10) || 0) : null;
// Planner landmass preference (-1 none): ?land=1 makes the autopilot cross to the far landmass
// whenever a crossing is open (tools/route-test.mjs covers the far events with it).
const PLAN = new Int8Array(1);
PLAN[0] = PQ0 && PQ0.has('land') ? Math.max(0, Math.min(2, parseInt(PQ0.get('land'), 10) || 0)) : -1;
export function setPreferLand(l) { PLAN[0] = l === 0 || l === 1 || l === 2 ? l : -1; }
// Player autopilot (P): off by default; ?autodrive=1 starts with it on (hands-off cruise).
if (PQ0 && PQ0.get('autodrive') === '1') state.autopilot = true;
export function toggleAutopilot() { state.autopilot = !state.autopilot; return state.autopilot; }

// Inspection hook for tools/roam-test.mjs and the console (allocates; never on the frame path).
if (typeof window !== 'undefined') {
  const Q = new Float64Array(8);
  window.__drive = {
    car,
    pose: () => ({ x: cur[0], z: cur[2], h: cur[3], v: car.v, nearD: car.nearD, track: car.track, s: car.s, roadDist: car.roadDist, cur: graph.cur, prev: graph.prev, commits: graph.commits, clock: state.clock, fog: state.edgeFog, autopilot: state.autopilot, fork: car.forkMode, wet: Array.from(car.fs.subarray(0, 4)), ui: window.__game && window.__game.ui ? { ...window.__game.ui } : null }),
    point: (e, s, lat = 0) => { Q[4] = s; Q[5] = lat; frameAt(e, Q); return { x: Q[0], z: Q[2], h: Q[3] }; },
    edge: (e) => ({ len: edgeLen[e], to: edgeTo[e], from: edgeFrom[e], region: edgeRegion[e], j0: edgeJ0[e] }),
    exits: (n) => Array.from({ length: nodeExitCount[n] }, (_, i) => ({ i, e: nodeExit(n, i), ok: exitAvailable(n, i), region: exitRegion(n, i), angle: exitAngle(n, i) })),
    // Nearest point on the route (current road, previous road, next exits).
    onRoute: (x, z) => {
      let best = null;
      const j = edgeTo[graph.cur];
      const es = [graph.cur, graph.prev, ...Array.from({ length: nodeExitCount[j] }, (_, i) => (exitAvailable(j, i) ? nodeExit(j, i) : -1))];
      for (const e of es) {
        if (e < 0) continue;
        Q[5] = x; Q[6] = z; Q[7] = edgeLen[e] / 2; project(e, Q, 4000);
        if (!best || Q[4] < best.d) best = { e, s: Q[0], d: Q[4] };
      }
      return best;
    },
    // tools/tunnel-test.mjs: put the car at (x, z) heading h (rad) at speed v.
    place: (x, z, h, v = 0) => { placeCarAt(x, z, h, v); T[1] = 0; },
    nearest: (x, z) => { Q[5] = x; Q[6] = z; nearestRoad(Q, 0); const e = Q[3], s = Q[4]; Q[4] = s; pointAt(e, Q); return { e, s, x: Q[0], z: Q[2], h: Q[3] }; },
  };
}

const T = new Float64Array(4); // [0] sim time, [1] accumulator, [2] last journey metres, [3] start clock
// The ending (src/ending.js): [0] 1 = the clock is the ending's (forward progress no longer
// moves it), [1] the highest clock the drive may reach on its own (free drive: just short of
// the end, so the ending always gets to play).
export const journeyIO = new Float64Array([0, 1e9]);
let junctions = 0, lastCur = -1, seedNow = 1;

export const keys = { throttle: 0, brake: 0, steer: 0 };

// The exit toward history at node j (lowest score wins): straightness (|angle| < 1) plus 10
// minus the road's value: the most urgent event still to log that stands on it (sites.js
// edgeSiteValue, 2-12) or that its region and landmass offer inside its placement window
// (0-10; sites.js places it there when the car commits), or 0.6 x the best of its exits'.
// Urgency is how soon the event's window closes after the pass, so Giza (closing at 118) wins
// over the Parthenon (open to 140) and both get seen. Changing landmass costs 100 unless
// crossPlan says the crossing pays (or ?land= / setPreferLand asks for it), then it gains 20.
function historyExit(j) {
  const clk = clockBase[0] + (nodeJ[j] - clockBase[1]) / 40;
  const land = nodeLand[j], seen = seenMask();
  let best = -1, bestA = 1e9;
  for (let i = 0; i < nodeExitCount[j]; i++) {
    if (!exitAvailable(j, i)) continue;
    const e = nodeExit(j, i);
    const cross = exitCrosses(j, i);
    const l2 = cross ? 1 - land : land;
    const L = e >= 0 ? edgeLen[e] : 1150;
    let v = eventAhead(exitRegion(j, i), l2, clk, L, seen);
    if (e >= 0) {
      const sv = edgeSiteValue(e);
      if (sv > v) v = sv;
      const k = edgeTo[e];
      for (let q = 0; q < nodeExitCount[k]; q++) { const x = nodeExit(k, q); if (x >= 0) { const w = 0.6 * edgeSiteValue(x); if (w > v) v = w; } }
    }
    let a = Math.abs(exitAngle(j, i)) + 10 - v;
    // The middle road of a three-way fork has siblings on both sides: a large landmark finds no
    // clear ground beside it (sites.js road clearance), so an outer road that offers the same
    // history wins.
    if (nodeExitCount[j] === 3 && i === 1 && !(e >= 0 && edgeSiteValue(e) > 0)) a += 0.6;
    if (cross) {
      const pref = PLAN[0] === 2 || (PLAN[0] >= 0 && nodeBridge[j] === i);
      const keep = pref ? ((PLAN[0] === 2 ? 1 : PLAN[0]) === l2 ? 1 : 0) : crossPlan(land, clk, seen, nodeBridge[j] !== i);
      if (!keep) a += 100;
      else a -= pref ? 100 : 20;
    }
    if (a < bestA) { bestA = a; best = i; }
  }
  return best < 0 ? 0 : best;
}

// Value (0..10) of the most urgent unlogged event of region reg on landmass land whose
// placement window the car meets on a road of length L leaving at clk: 10 - 10 x min(1,
// slack / 60) with slack = w1 - the likely pass clock; half that if it only opens on the road
// after.
function eventAhead(reg, land, clk, L, seen) {
  const end = clk + L / 40;
  let b = 0;
  for (let ev = 0; ev < EVENT_COUNT; ev++) {
    const E = EVENTS[ev];
    if (E.region !== reg || E.land !== land || E.start || !DEFS[ev] || (seen >>> ev) & 1) continue;
    if (E.w1 < clk + 3) continue;
    const pass = Math.max(clk + 5, E.w0 + 5);
    const k = Math.min(1, Math.max(0, (E.w1 - pass) / 60));
    let v = 0;
    if (E.w0 <= end - 4) v = 10 - 10 * k + 2 * E.prio;
    else if (E.w0 <= end + 28) v = 0.5 * (10 - 10 * k + E.prio);
    if (v > b) b = v;
  }
  return b;
}

// Crossing plan: does crossing the strait at clock clk (from landmass land) let the run log
// more of the events still unlogged than staying? Each side is valued by a greedy schedule
// (events by closing time, one every PLAN_GAP clock seconds, at most to the loop), allowing
// later crossings (from SHIP_CLOCK, at any fork: they are offered often) that cost
// PLAN_CROSS seconds of travel. Allocation-free; called only at forks with a crossing.
const PLAN_GAP = 22, PLAN_CROSS = 13 + FERRY_WATER / 40, PLAN_STEP = 12;
const BY_W1 = EVENTS.map((e, i) => i).sort((a, b) => EVENTS[a].w1 - EVENTS[b].w1);
const SC = new Float64Array(2); // greedySpan out: [0] count, [1] clock after the last pass
function greedySpan(land, t, until, seen) {
  let n = 0;
  for (let k = 0; k < BY_W1.length; k++) {
    const ev = BY_W1[k], E = EVENTS[ev];
    if (E.land !== land || !E.place || E.start || !DEFS[ev] || (seen >>> ev) & 1) continue;
    const p = t > E.w0 ? t : E.w0;
    if (p > E.w1 || p > until) continue;
    n++; t = p + PLAN_GAP;
  }
  SC[0] = n; SC[1] = t;
}
// Best count from clock t on landmass land with up to `depth` more crossings; the first one
// no earlier than tMin.
function planValue(land, t, depth, seen, tMin) {
  greedySpan(land, t, 1e9, seen);
  let best = SC[0];
  if (depth <= 0) return best;
  for (let T = Math.max(tMin, SHIP_CLOCK); T < 290; T += PLAN_STEP) {
    greedySpan(land, t, T, seen);
    const v = SC[0] + planValue(1 - land, T + PLAN_CROSS, depth - 1, seen, T + PLAN_CROSS + 20);
    if (v > best) best = v;
  }
  return best;
}
// A tie crosses: the schedule is coarse, and the other side's events are the ones this run
// has not been able to reach (the land bridge, which strands the car until 1492, needs a gain).
// Staying is valued with later crossings no earlier than PLAN_NEXT seconds on: crossings are
// offered at a fork now and then (graph.js: not two forks running), so "cross a little later"
// is not a real option, and valuing it made every crossing lose to the next one.
const PLAN_NEXT = 55;
function crossPlan(land, clk, seen, ferry) {
  const go = planValue(1 - land, clk + PLAN_CROSS, 1, seen, clk + PLAN_CROSS + 20);
  const stay = planValue(land, clk, 2, seen, clk + PLAN_NEXT);
  // A ship or the bridge from 1492 is also taken when the far side offers nearly as much (one
  // event less by the schedule, which is coarse) on about EXPLORE of the runs (seeded): the far
  // landmass's own landmarks (Machu Picchu, the railroad, first flight, Trinity, Apollo) are
  // otherwise never seen from a near-side start.
  const explore = ferry && go >= 3 && go >= stay - 1 && clk <= EXPLORE_BY && ((Math.imul(seedNow + 7, 0x9e3779b1) >>> 0) % 1000) < EXPLORE * 1000;
  return go > stay || (ferry && go === stay && go > 0) || explore ? 1 : 0;
}
const EXPLORE = 0.3, EXPLORE_BY = 222; // (later, the far side's railroad and first flight are out of reach)

function setAutoExit() {
  const j = edgeTo[graph.cur];
  if (nodeExitCount[j] === 1) { car.autoExit = 0; return; } // a quay: one road on
  // Debug / route-test: the forks on the route that offered a crossing (clock, from landmass).
  for (let i = 0; i < nodeExitCount[j]; i++) if (exitCrosses(j, i) && exitAvailable(j, i) && NOFF[0] < 24) { OFFERS[NOFF[0] * 2] = clockBase[0] + (nodeJ[j] - clockBase[1]) / 40; OFFERS[NOFF[0] * 2 + 1] = nodeLand[j]; NOFF[0]++; }
  let x = ROUTE && junctions < ROUTE.length ? Math.max(0, Math.min(ROUTE[junctions], nodeExitCount[j] - 1)) : historyExit(j);
  // Never plan an unavailable exit (the gated land bridge): take the next available one.
  for (let k = 0; k < nodeExitCount[j] && !exitAvailable(j, x); k++) x = (x + 1) % nodeExitCount[j];
  car.autoExit = x;
  if (junctions < TAKEN.length) TAKEN[junctions] = x;
}
const TAKEN = new Int8Array(16).fill(-1); // autopilot exit per fork (debug)
const OFFERS = new Float32Array(48), NOFF = new Int8Array(1);

// Journey start clock (?t0=): history starts later, the world is laid out from there.
export function setStartClock(c) { T[3] = c; }
export function routeInfo() { return { junctions, seed: seedNow, startClock: T[3], exits: Array.from(TAKEN.subarray(0, junctions + 1)), offers: Array.from({ length: NOFF[0] }, (_, k) => ({ clock: +OFFERS[k * 2].toFixed(1), from: OFFERS[k * 2 + 1] })) }; }

export function resetDrive(seed) {
  seedNow = seed;
  state.seed = seed;
  setNoiseSeed(seed);
  resetSites();
  clockBase[0] = T[3]; clockBase[1] = START_S; // the root road starts at journey metre 0
  resetGraph(seed);
  resetCar(graph.cur, START_S);
  clearDust();
  junctions = 0; lastCur = graph.cur; TAKEN.fill(-1); NOFF[0] = 0;
  setAutoExit();
  car.preferred = car.autoExit;
  T[0] = 0; T[1] = 0; T[2] = edgeJ0[graph.cur] + START_S;
  state.clock = T[3];
  state.distance = T[2];
  updateJourney();
}

function updateJourney() {
  state.speed = car.v;
  const jd = edgeJ0[car.track] + car.s;
  if (journeyIO[0] > 0) { if (jd > T[2]) T[2] = jd; }
  else if (car.auto) { if (jd > T[2]) { state.clock += (jd - T[2]) / 40; T[2] = jd; } }
  else if (jd > T[2]) {
    // Player: only forward progress along the route moves the clock, never faster than the
    // car is moving (a projection that leaps while far off-road, or a cross-country shortcut
    // onto a later road, is caught up smoothly instead of jumping the clock).
    let d = jd - T[2];
    const lim = Math.abs(car.v) * H * 1.6 + 1e-4;
    if (d > lim) d = lim;
    state.clock += d / 40; T[2] += d;
    if (state.clock > journeyIO[1]) state.clock = journeyIO[1];
  }
  state.distance = T[2];
  state.edge = car.track; state.edgeS = car.s; state.offRoad = car.roadDist;
  state.landmass = car.track >= 0 ? landAt(car.track, car.s) : 0;
  state.surface = car.roadDist > car.hw + 0.5 ? 3 : car.surf;
  // Biomes are spatial: the environment and the audio follow the weights at the car.
  graphFocus[0] = cur[0]; graphFocus[1] = cur[2];
  BQC[0] = cur[0]; BQC[1] = cur[2];
  biomeExact(BQC);
  carBiome[0] = BQC[2]; carBiome[1] = BQC[3]; carBiome[2] = BQC[4];
  setStateBiome();
}

function step(auto, pumpIt) {
  if (pumpIt) pump(1);
  car.auto = auto;
  if (auto) { car.inThrottle = 0; car.inBrake = 0; car.inSteer = 0; }
  else { car.inThrottle = keys.throttle; car.inBrake = keys.brake; car.inSteer = keys.steer; }
  stepCar();
  updateGraph();
  if (graph.cur !== lastCur) {
    lastCur = graph.cur;
    if (nodeExitCount[edgeFrom[graph.cur]] > 1) junctions++;
    setAutoExit();
  }
  updateJourney();
  T[0] += H;
}

// Player driving for state.dt seconds (clamped by main.js).
export function driveFree() {
  pump(1);
  T[1] += state.dt;
  let n = 0;
  while (T[1] >= H && n < 24) { step(false, false); T[1] -= H; n++; }
  if (T[1] > H) T[1] = 0;
  simIO[0] = T[1] / H;
  interpolate();
}

// Autopilot drive at time scriptT[0] (seconds since the start). Deterministic in t.
export const scriptT = new Float64Array(1);
export function driveScript() {
  const t = scriptT[0];
  if (t < T[0] - 1e-9) resetDrive(seedNow);
  const n = Math.floor((t - T[0]) / H + 1e-9);
  const fast = n > 6;
  if (!fast) pump(1);
  for (let i = 0; i < n; i++) step(true, fast);
  if (fast) pumpAll();
  simIO[0] = Math.min(1, Math.max(0, (t - T[0]) / H));
  interpolate();
}

// ---------------------------------------------------------------------------------
// Camera for the current view.

export function applyView(cam) {
  if (state.view === 1) firstPersonRig(cam, bodyPoint);
  else chaseRig(cam, pose);
  // Debug (tools/tunnel-shot.mjs): window.__camOverride = [eye x, y, z, target x, y, z, fov]
  // (y relative to the car's ground when the array has an 8th value of 1).
  const o = typeof window !== 'undefined' ? window.__camOverride : null;
  if (o) {
    const dy = o[7] ? pose[1] : 0;
    cam.eye[0] = o[0]; cam.eye[1] = o[1] + dy; cam.eye[2] = o[2];
    cam.target[0] = o[3]; cam.target[1] = o[4] + dy; cam.target[2] = o[5];
    if (o[6]) cam.fovY = o[6];
  }
}

// ---------------------------------------------------------------------------------
// Poses: meaningful moments of the scripted drive. A time >= 2000 means "(t - 2000*k) seconds
// before the autopilot passes event k-1's landmark" (found by driving the route), so the
// poses follow the landmarks wherever the seed puts them.
//   0 savannah road with the camp ahead          3 Gobekli Tepe from the road
//   1 fork 1 from above: two biomes              4 Giza on its long approach
//   2 the cave mouth in the ice                  5 first person: the dash, a landmark ahead
export const POSE_COUNT = 6;
// time, rig (0 chase, 1 elevated), yaw offset of the camera around the car, distance back,
// height, look yaw, look distance, look height, fov. Pose 5 is always first person.
const POSES = [
  [2000 + 1.2, 0],
  [1003, 1, -0.25, 38, 26, 0.02, 600, -30, 0.98],
  [4000 + 1.7, 0],
  [6000 + 1.6, 0],
  [8000 + 12, 1, 0.25, 26, 9, -0.42, 900, 40, 0.85],
  [6000 + 3.4, 0],
];
let poseN = -1;
// Dev: ?pt=<time>&pcam=<rig,yaw,back,up,lookYaw,lookDist,lookUp,fov> overrides the pose (framing).
const PQ = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const PT = PQ && PQ.has('pt') ? +PQ.get('pt') : NaN;
const PCAM = PQ && PQ.has('pcam') ? PQ.get('pcam').split(',').map(Number) : null;

function forkTime(k) {
  // Time the autopilot reaches its k-th fork (0-based).
  let t = (edgeLen[graph.cur] - START_S) / 40;
  return k === 0 ? t : t + edgeLen[nextOnRoute()] / 40;
}
function nextOnRoute() {
  const j = edgeTo[graph.cur];
  return nodeExit(j, car.autoExit >= 0 ? car.autoExit : historyExit(j));
}

// Clock at which the autopilot passes event ev's landmark (drives the route to find it).
function passTime(ev) {
  for (let t = 0; t <= 305; t += 1) {
    scriptT[0] = t; driveScript();
    const p = sitePass(ev, graph.cur);
    if (p >= 0) { const c = p; resetDrive(seedNow); return c - T[3]; }
  }
  resetDrive(seedNow);
  return 10;
}

export function posePrepare(n) {
  resetDrive(seedNow);
  poseN = n;
  let t = PT === PT ? PT : POSES[n][0];
  if (t >= 2000) t = passTime(Math.floor(t / 2000) - 1) - (t % 2000);
  else if (t < 0) t += forkTime(1);
  else if (t > 1000) t += forkTime(0) - 1000;
  if (n === 5) state.view = 1;
  scriptT[0] = t;
  driveScript();
}

// Called every frame in pose mode after applyEnv(): the pose camera.
// Debug close-up of the car (?pose=N&carcam=<yaw offset radians>), for inspecting the model.
export const debugCam = { on: false, yaw: 0, dist: 5.5, up: 1.7 };
export function poseView(cam) {
  if (debugCam.on) {
    const h = pose[3] + debugCam.yaw;
    cam.fovY = 0.7;
    cam.eye[0] = pose[0] + Math.cos(h) * debugCam.dist; cam.eye[1] = pose[1] + debugCam.up; cam.eye[2] = pose[2] + Math.sin(h) * debugCam.dist;
    cam.target[0] = pose[0]; cam.target[1] = pose[1] + 0.7; cam.target[2] = pose[2];
    return;
  }
  const P = PCAM ? [0, ...PCAM] : POSES[poseN];
  if (state.view === 1 || !P || P[1] === 0) { applyView(cam); return; }
  const h = pose[3];
  const hb = h + P[2], hl = h + P[5];
  cam.fovY = P[8];
  cam.eye[0] = pose[0] - Math.cos(hb) * P[3]; cam.eye[1] = pose[1] + P[4]; cam.eye[2] = pose[2] - Math.sin(hb) * P[3];
  cam.target[0] = pose[0] + Math.cos(hl) * P[6]; cam.target[1] = pose[1] + P[7]; cam.target[2] = pose[2] + Math.sin(hl) * P[6];
}
