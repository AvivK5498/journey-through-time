// The time machine: an open two-seat brass-and-teal roadster with cycle fenders, spoked
// wheels, copper flux pipes and a gyroscopic "chrono core" (two gimbal rings spinning
// around a glowing cyan cylinder) on the rear deck. Procedural mesh, own design.
//
// Handling is arcade and runs at a fixed 120 Hz step (see drive.js): kinematic bicycle
// model with a lateral-acceleration cap. Three modes:
//   car.auto (scripted drive, poses, tests): cruise at 40 m/s, pure pursuit along the road,
//     corridor pull from 22 m and a hard limit at 75 m. Unchanged from the slice.
//   player, state.autopilot on (P): cruise at 40 m/s and follow the road hands-off; held
//     steering overrides; W/S still work.
//   player, autopilot off (default): W throttle, release coasts on rolling drag, S brakes
//     then reverses; steering is the player's alone.
// The player roams freely: nothing pulls within 400 m of the nearest live road; from 400 to
// 520 m outward motion is slowed, the car is turned home and state.edgeFog rises. Open
// water (the thawed strait, the desert river) is a soft boundary the same way. Off-road is
// slower (~30 m/s top) and bouncier. The road tracked is the nearest of the route's live
// edges (current, previous, siblings, next exits and theirs); the exit you rejoin on is the
// one you take (graph.commit), even after crossing country.
//
// Car local frame: x = LEFT, y = up, z = forward (right-handed); origin on the ground
// under the middle of the car. The driver sits on the left (x = +0.36).

import { gpu, addDrawable, mainPipeline, shadowPipeline } from './gpu.js';
import { MAIN_HEADER, SHADOW_HEADER } from './shaders/common.js';
import { MeshBuilder, VERTEX_LAYOUT } from './mesh.js';
import { state, env } from './state.js';
import { camera } from './camera.js';
import { groundInfo, groundExtra, groundBio, groundSea, siteData } from './world/world.js';
import { NIO, noiseValue } from './world/noise.js';
import { bioV, BV, B_DUST } from './world/biomes.js';
import { ferryStep, deckAt, deckClamp, FH } from './world/crossing.js';
import { tunnelClamp, tunnelCam, TC } from './world/tunnel.js';
import {
  graph, project, pointAt, commit, SIM_DT, edgeLen, edgeTo, edgeJ0, nodeExitCount, nodeExit, exitAvailable, exitAngle,
  MAX_EDGES, edgeAlive, edgeFrom, edgeVersion, edgePresence, nearestRoad,
} from './world/graph.js';

export const WHEELBASE = 2.7, TRACK = 1.62, WHEEL_R = 0.405;
export const CRUISE = 40, VMAX = 58;
const COMMIT_S = 110; // metres past a junction where the fork choice is locked in
const A_LAT = 10; // lateral acceleration cap (m/s^2)
const NPART = 8;

// ---------------------------------------------------------------------------------
// Simulation state (doubles in typed arrays: no boxing).

// Sim channels, also kept for the previous step so rendering can interpolate.
// 0 x, 1 y(body base), 2 z, 3 heading, 4 pitch, 5 roll, 6 steer, 7 spin, 8-11 wheel ground y (FL FR RL RR),
// 12 cam x, 13 cam y, 14 cam z, 15 cam yaw, 16 speed, 17 ring phase
export const NS = 18;
export const cur = new Float64Array(NS);
export const prev = new Float64Array(NS);
export const pose = new Float64Array(NS); // interpolated

export const car = {
  v: 0, // speed m/s
  yawRate: 0,
  bodyVY: 0, bodyOff: 0, prevG: -1e9, prevTV: 0, // vertical spring (offset from the ground plane)
  surf: 0, hw: 2, // surface and road half width under the car
  pitchV: 0, rollV: 0,
  aLong: 0, aLat: 0,
  // Road tracking
  track: -1, // edge slot tracked (graph.cur, or a fork candidate)
  s: 0,
  lat: 0, // signed lateral offset from the tracked centreline (right +)
  roadDist: 0,
  forkMode: false,
  forkNode: -1,
  preferred: 0, // exit index the assist/autopilot heads for at the next fork
  candS: new Float64Array(3),
  // Inputs (written by drive.js each step)
  inThrottle: 0, inBrake: 0, inSteer: 0, auto: false, autoExit: -1,
  dist: 0, // odometer (m)
  nearD: 0, // player: metres to the nearest drawn road (any live edge)
  fs: null, // player boundary scratch (wet ahead, left, right, under; edge fog)
  hidden: false, // the ending's rewind: the car is not drawn while history runs back
};

// Park mode (the ending, src/ending.js): the car follows a given path on its own (keys are
// ignored), slowing to stop at its end. PARK: [0] on, [1] point count, [2] segment hint,
// [3] path length, [4] distance left, [5] top speed (m/s), [6] 1 when stopped at the end,
// [7] stop at the end (0: keep the top speed: the drive off into the fog), [8] max deviation
// from the path seen (m). PATH: x, z per point.
export const PARK = new Float64Array(10);
export const PATH = new Float64Array(2 * 320);
const PCUM = new Float64Array(320);
export function parkBegin(n, vmax, stop) {
  PARK[0] = 1; PARK[1] = n; PARK[2] = 0; PARK[5] = vmax; PARK[6] = 0; PARK[7] = stop ? 1 : 0; PARK[8] = 0;
  PCUM[0] = 0;
  for (let i = 1; i < n; i++) PCUM[i] = PCUM[i - 1] + Math.hypot(PATH[i * 2] - PATH[i * 2 - 2], PATH[i * 2 + 1] - PATH[i * 2 - 1]);
  PARK[3] = PCUM[n - 1]; PARK[4] = PARK[3];
}
// Along-path distance of (x, z) (local search from the hint); PS[0] out: lateral deviation.
const PQ = new Float64Array(2);
function parkProject(x, z) {
  const n = PARK[1];
  let best = 1e30, bi = PARK[2] | 0, bt = 0;
  for (let i = Math.max(0, (PARK[2] | 0) - 2); i < Math.min(n - 1, (PARK[2] | 0) + 12); i++) {
    const ax = PATH[i * 2], az = PATH[i * 2 + 1], bx = PATH[i * 2 + 2] - ax, bz = PATH[i * 2 + 3] - az;
    const l2 = bx * bx + bz * bz || 1;
    let t = ((x - ax) * bx + (z - az) * bz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + bx * t - x, dz = az + bz * t - z, d = dx * dx + dz * dz;
    if (d < best) { best = d; bi = i; bt = t; }
  }
  PARK[2] = bi;
  PQ[0] = PCUM[bi] + (PCUM[bi + 1] - PCUM[bi]) * bt; PQ[1] = Math.sqrt(best);
}
// Point at along-path distance d -> PQ.
function parkPoint(d) {
  const n = PARK[1];
  if (d >= PCUM[n - 1]) { const k = n - 1, j = n - 2, l = PCUM[k] - PCUM[j] || 1, e = (d - PCUM[k]) / l; PQ[0] = PATH[k * 2] + (PATH[k * 2] - PATH[j * 2]) * e; PQ[1] = PATH[k * 2 + 1] + (PATH[k * 2 + 1] - PATH[j * 2 + 1]) * e; return; }
  let i = PARK[2] | 0;
  while (i < n - 2 && PCUM[i + 1] < d) i++;
  const t = (d - PCUM[i]) / (PCUM[i + 1] - PCUM[i] || 1);
  PQ[0] = PATH[i * 2] + (PATH[i * 2 + 2] - PATH[i * 2]) * t; PQ[1] = PATH[i * 2 + 1] + (PATH[i * 2 + 3] - PATH[i * 2 + 1]) * t;
}
// Speed and steering on the path (one sim step); writes car.v, returns the steer target.
function parkStep(x, z, hd, maxSteer) {
  const h = SIM_DT;
  parkProject(x, z);
  const p = PQ[0];
  if (PQ[1] > PARK[8] && p > 3) PARK[8] = PQ[1];
  const rem = PARK[3] - p;
  PARK[4] = rem;
  let vt = PARK[5];
  if (PARK[7] > 0) {
    const vs = rem > 5 ? 3.5 + 0.21 * (rem - 5) : rem * 0.7;
    if (vs < vt) vt = vs;
  }
  let a = (vt - car.v) * 1.6;
  a = a < -6.5 ? -6.5 : a > 3.2 ? 3.2 : a;
  car.v += a * h;
  if (PARK[7] > 0 && rem < 0.12 && car.v < 0.35) { car.v = 0; PARK[6] = 1; }
  if (car.v < 0) car.v = 0;
  // pure pursuit on the path
  const ld = 2.4 + 0.42 * Math.abs(car.v);
  parkPoint(p + ld);
  let al = Math.atan2(PQ[1] - z, PQ[0] - x) - hd;
  al = Math.atan2(Math.sin(al), Math.cos(al));
  const st = Math.atan(2 * WHEELBASE * Math.sin(al) / ld);
  return st < -maxSteer ? -maxSteer : st > maxSteer ? maxSteer : st;
}

// Put the car on road e at s, heading along it, at speed v (the ending's moves behind its veil).
export function placeCar(e, s, v) {
  pt[4] = s; pointAt(e, pt);
  placeCarAt(pt[0], pt[2], pt[3], v);
  car.track = e; car.s = s;
}
export function placeCarAt(x, z, hd, v) {
  cur[0] = x; cur[2] = z; cur[3] = hd; cur[4] = 0; cur[5] = 0; cur[6] = 0;
  gi[6] = x; gi[7] = z; groundCar(gi);
  cur[1] = gi[0];
  for (let i = 8; i < 12; i++) cur[i] = gi[0];
  car.v = v; cur[16] = v; car.yawRate = 0; car.bodyVY = 0; car.bodyOff = 0; car.prevG = -1e9; car.pitchV = 0; car.rollV = 0; car.aLong = 0; car.aLat = 0;
  cur[12] = x - Math.cos(hd) * 7.4; cur[14] = z - Math.sin(hd) * 7.4; cur[13] = gi[0] + 2.6; cur[15] = hd;
  prev.set(cur); pose.set(cur);
}

// Scratch arrays (queries take their inputs in slots 4..7, see graph.js / world.js).
const pr = new Float64Array(8);
const pt = new Float64Array(8);
const gi = new Float64Array(8);
// simIO[0] = interpolation alpha for interpolate().
export const simIO = new Float64Array(2);

export function resetCar(edge, s) {
  car.track = edge; car.s = s; car.forkMode = false; car.forkNode = -1;
  pt[4] = s;
  pointAt(edge, pt);
  cur.fill(0);
  cur[0] = pt[0]; cur[2] = pt[2]; cur[3] = pt[3];
  gi[6] = pt[0]; gi[7] = pt[2];
  groundInfo(gi);
  cur[1] = gi[0];
  for (let i = 8; i < 12; i++) cur[i] = gi[0];
  car.v = CRUISE; cur[16] = CRUISE;
  car.yawRate = 0; car.bodyVY = 0; car.bodyOff = 0; car.prevG = -1e9; car.prevTV = 0; car.pitchV = 0; car.rollV = 0; car.aLong = 0; car.aLat = 0;
  car.dist = 0;
  sVer.fill(0xffffffff);
  sGuess[edge] = s; sVer[edge] = edgeVersion[edge];
  FS.fill(0); state.edgeFog = 0;
  // Chase camera starts settled behind the car.
  cur[12] = pt[0] - Math.cos(pt[3]) * 7.4; cur[14] = pt[2] - Math.sin(pt[3]) * 7.4; cur[13] = gi[0] + 2.6; cur[15] = pt[3];
  pickPreferred();
  prev.set(cur);
  pose.set(cur);
}

// Default exit at the next fork: the straightest available one (the autopilot overrides).
function pickPreferred() {
  const j = edgeTo[graph.cur];
  let best = 0, bestA = 1e9;
  for (let i = 0; i < nodeExitCount[j]; i++) {
    if (!exitAvailable(j, i)) continue;
    const a = Math.abs(exitAngle(j, i));
    if (a < bestA) { bestA = a; best = i; }
  }
  car.preferred = best;
}

const tgt = new Float64Array(8);

// ---------------------------------------------------------------------------------
// Player road tracking: the nearest of the route's live edges.
const sGuess = new Float64Array(MAX_EDGES); // last projected s per edge slot
const sVer = new Uint32Array(MAX_EDGES); // edgeVersion that guess belongs to
const NC = 16;
const cE = new Int16Array(NC), cKind = new Int8Array(NC), cIdx = new Int8Array(NC), cPar = new Int16Array(NC);
const cS = new Float64Array(NC), cLat = new Float64Array(NC), cD = new Float64Array(NC);
const K_CUR = 0, K_PREV = 1, K_SIB = 2, K_CHILD = 3, K_GRAND = 4;
let nc = 0;
function addCand(e, kind, idx, par) {
  if (e < 0 || !edgeAlive[e] || nc >= NC) return;
  for (let i = 0; i < nc; i++) if (cE[i] === e) return;
  cE[nc] = e; cKind[nc] = kind; cIdx[nc] = idx; cPar[nc] = par; nc++;
}
function gatherCands() {
  nc = 0;
  const c = graph.cur;
  addCand(c, K_CUR, -1, -1);
  if (graph.prev >= 0) addCand(graph.prev, K_PREV, -1, -1);
  const n = edgeFrom[c];
  // Siblings fade out after a commit (graph.js): rejoinable only while still drawn.
  for (let i = 0; i < nodeExitCount[n]; i++) {
    const x = nodeExit(n, i);
    if (x >= 0 && exitAvailable(n, i) && edgePresence[x] > 0.3) addCand(x, K_SIB, i, -1);
  }
  const j = edgeTo[c];
  for (let i = 0; i < nodeExitCount[j]; i++) {
    if (!exitAvailable(j, i)) continue;
    const x = nodeExit(j, i);
    if (x < 0 || !edgeAlive[x]) continue;
    addCand(x, K_CHILD, i, -1);
    const k = edgeTo[x];
    for (let q = 0; q < nodeExitCount[k]; q++) if (exitAvailable(k, q)) addCand(nodeExit(k, q), K_GRAND, q, x);
  }
}
function trackFree(x, z) {
  gatherCands();
  let bi = 0, bd = 1e30;
  for (let i = 0; i < nc; i++) {
    const e = cE[i];
    const fresh = sVer[e] === edgeVersion[e];
    pr[5] = x; pr[6] = z; pr[7] = fresh ? sGuess[e] : 0;
    project(e, pr, fresh ? 40 : 4000); // a new edge: one full search, then local
    sGuess[e] = pr[0]; sVer[e] = edgeVersion[e];
    cS[i] = pr[0]; cLat[i] = pr[1]; cD[i] = pr[4];
    // Hysteresis toward the edge we are on and the exit we are heading for.
    let d = pr[4];
    if (e === car.track) d -= 0.8;
    if (cKind[i] === K_CHILD && cIdx[i] === car.preferred) d -= 0.8;
    if (d < bd) { bd = d; bi = i; }
  }
  const e = cE[bi], kind = cKind[bi];
  car.track = e; car.s = cS[bi]; car.lat = cLat[bi]; car.roadDist = cD[bi];
  car.forkNode = edgeTo[graph.cur];
  car.forkMode = kind === K_CHILD || kind === K_GRAND || (kind === K_CUR && car.s >= edgeLen[e] - 0.01);
  if (kind === K_CHILD) car.preferred = cIdx[bi];
  // Rejoining a road decides the fork: well past its junction and on it.
  if (kind !== K_CUR && kind !== K_PREV && car.s > COMMIT_S && car.roadDist < 30) {
    if (kind === K_GRAND) commit(cPar[bi]);
    commit(e);
    car.forkMode = false;
    car.forkNode = -1;
    pickPreferred();
  }
}

// Ground under (g[6], g[7]) for the car: groundInfo, then the crossings' decks (quays, the
// ship, the bridge: world/crossing.js), which count as road and are never water.
function groundCar(g) { groundInfo(g); deckAt(g); }

// Player-mode scratch: [0] water ahead, [1] ahead-left, [2] ahead-right, [3] water under the
// car, [4] smoothed edge fog.
const FS = new Float64Array(8);
car.fs = FS; // inspection (tools/roam-test.mjs)
const gw = new Float64Array(8);
const nh = new Float64Array(8);
let probeTick = 0;
function ss01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
// Water weight 0..1 -> FS[slot]: below the desert river's level or in the
// thawed strait. (Frozen lakes and the frozen strait stay drivable.)
// g: a groundInfo() result just computed (groundExtra still belongs to it).
const FSEA = new Uint8Array(4); // probe slot saw the coast's sea (not the river or the strait)
function wetFrom(g, slot) {
  let w = 0;
  if (groundExtra[5] > 0.02) w = ss01((groundExtra[3] - 1.2 - g[0] - 0.05) / 0.4);
  FSEA[slot] = 0;
  if (groundSea[0] > w) { w = groundSea[0]; FSEA[slot] = 1; } // the coast's sea (world.js groundInfo)
  if (siteData[20] > 0 && siteData[22] > 0.05) {
    straitW(g);
    if (FS[7] > 0.2) {
      const ws = siteData[22] * ss01((siteData[21] - g[0] - 0.05) / 0.35) * ss01((FS[7] - 0.2) / 0.3);
      if (ws > w) w = ws;
    }
  }
  FS[slot] = w;
}
// Strait water weight at (g[6], g[7]) -> FS[7]. Mirrors straitJS() in world/world.js (keep in sync);
// groundExtra[6] cannot be used: it also holds the (frozen, drivable) ice lakes.
function straitW(g) {
  const x = g[6], z = g[7];
  FS[7] = 0;
  const hw = siteData[20];
  const dx = x - siteData[16], dz = z - siteData[17];
  const u = dx * siteData[18] + dz * siteData[19];
  const v = (dx * -siteData[19] + dz * siteData[18]) * siteData[23];
  if (Math.abs(u) > hw + 3000 || v < -400) return;
  NIO[0] = x / 90 + 4; NIO[1] = z / 90 + 7; noiseValue(); let wob = 18 * (NIO[2] - 0.5);
  NIO[0] = x / 23; NIO[1] = z / 23; noiseValue(); wob += 6 * (NIO[2] - 0.5);
  const hv = hw + Math.max(v, 0) * 0.22 + wob;
  let a = (Math.abs(u) - hv + 22) / 22; a = a < 0 ? 0 : a > 1 ? 1 : a;
  let b = (v + wob + 150) / 80; b = b < 0 ? 0 : b > 1 ? 1 : b;
  FS[7] = (1 - a * a * (3 - 2 * a)) * b * b * (3 - 2 * b);
}
function probe(slot, ang, dist) {
  gw[6] = cur[0] + Math.cos(ang) * dist; gw[7] = cur[2] + Math.sin(ang) * dist;
  groundCar(gw);
  wetFrom(gw, slot);
}

// Player-mode values passed between stepCar and the player functions.
const PS = new Float64Array(12);
function playerSense() {
  const x = PS[0], z = PS[1], hd = PS[2], hw = PS[3], h = SIM_DT;
  let offK = 0, kEdge = 0, cosHome = 1, homeA = 0;
  const nearD = gi[1]; // nearest drawn road (any live edge)
  car.nearD = nearD;
  offK = ss01((nearD - hw - 0.5) / 5.5);
  const waterOK = groundExtra[2] > 0.004 || groundBio[6] > 0.004 || (siteData[20] > 0 && siteData[22] > 0.05);
  if (waterOK) wetFrom(gi, 3); else FS[3] = 0;
  FS[4] += (ss01((nearD - 380) / 140) - FS[4]) * Math.min(1, h * 1.5);
  state.edgeFog = FS[4];
  if (nearD > 390) {
    nh[5] = x; nh[6] = z;
    nearestRoad(nh, 0);
    if (nh[3] >= 0) {
      pointAt(nh[3], nh); // nh[4] = s from nearestRoad
      homeA = Math.atan2(nh[2] - z, nh[0] - x) - hd;
      homeA = Math.atan2(Math.sin(homeA), Math.cos(homeA));
      cosHome = Math.cos(homeA);
      kEdge = ss01((nearD - 400) / 120) + Math.max(0, (nearD - 520) / 80);
    }
  }
  if (waterOK) {
    // Probe ahead of the motion (far enough to stop in), and its two flanks in turn.
    const dir = car.v < -0.3 ? hd + Math.PI : hd;
    const va = Math.abs(car.v);
    const pd = Math.min(70, 4 + va * va / 24);
    probe(0, dir, pd);
    probeTick = (probeTick + 1) & 3;
    if (probeTick === 1) probe(1, dir - 0.6, pd * 0.8 + 3);
    else if (probeTick === 3) probe(2, dir + 0.6, pd * 0.8 + 3);
  } else { FS[0] = 0; FS[1] = 0; FS[2] = 0; }
  PS[5] = offK; PS[6] = kEdge; PS[7] = cosHome; PS[8] = homeA;
}
function playerSpeed() {
  const h = SIM_DT, offRoad = PS[4], offK = PS[5], kEdge = PS[6], cosHome = PS[7];
  const cruise = offRoad > 6 ? 24 : CRUISE;
  const v = car.v;
  // Drive force (aD) and resistance (res >= 0, opposes the motion, never reverses it).
  let aD = 0;
  if (car.inThrottle > 0) aD = v < -0.5 ? 16 * car.inThrottle : 9 * car.inThrottle * (1 - v / VMAX);
  else if (car.inBrake > 0) aD = v > 0.5 ? -16 * car.inBrake : -5 * car.inBrake;
  else if (state.autopilot) aD = Math.max(-4, Math.min(4, (cruise - v) * 0.7));
  // Slopes: gravity beyond ~6 degrees, and the wheels lose grip past ~20 degrees, so ice
  // walls and steep dune faces are soft limits (the car slides back), not climbable.
  const sl = Math.sin(cur[4]), asl = sl < 0 ? -sl : sl;
  if (asl > 0.3 && aD * sl > 0) aD *= ss01((0.62 - asl) / 0.32);
  if (asl > 0.1) aD -= 9.8 * (sl - (sl > 0 ? 0.1 : -0.1));
  // Grass and sand: top speed ~30 m/s with the throttle held.
  let res = offK * (0.6 + 0.0033 * v * v);
  if (!state.autopilot) res += 0.5 + 0.0006 * v * v; // rolling + air: a gentle coast
  if (kEdge > 0) {
    const fwdOut = -cosHome; // > 0: the nose points away from the roads
    if (aD * fwdOut > 0) aD *= Math.max(0.3, 1 - 0.7 * Math.min(1, kEdge));
    const vout = v * fwdOut;
    if (vout > 4) res += kEdge * 0.35 * (vout - 4);
  }
  // Only water deeper than where the car stands blocks: a car already in the shallows can
  // always drive out.
  let wA = FS[0] - FS[3];
  // The open sea is never driven into: water ahead at least as deep as here holds the car back
  // even once its wheels are wet (it can still turn or back out toward the shore).
  if (FSEA[0] && FS[0] > 0.5 && FS[0] >= FS[3] - 0.02 && FS[0] * 0.9 > wA) wA = FS[0] * 0.9;
  if (wA > 0) {
    const dirS = v < -0.3 ? -1 : 1;
    if (aD * dirS > 0) aD *= 1 - wA;
    // Braking only above walking pace: the car can still creep and turn along the shore.
    const av = v < 0 ? -v : v;
    res += 14 * wA * ss01((av - 2) / 3);
  }
  res += 2.5 * FS[3];
  let nv = v + aD * h;
  const m = res * h;
  nv = Math.abs(nv) <= m ? 0 : nv - (nv > 0 ? m : -m);
  car.v = Math.max(-10, Math.min(VMAX, nv));
}
function playerSteer() {
  const offRoad = PS[4], kEdge = PS[6], cosHome = PS[7], homeA = PS[8], maxSteer = PS[9], pursuit = PS[10], handsOff = PS[11] > 0.5;
  let steerT = car.inSteer * maxSteer;
  if (state.autopilot && handsOff) {
    steerT = pursuit * (offRoad > 3 ? 0.6 : 1);
    const pull = Math.min(1, Math.max(0, (car.roadDist - 22) / 40));
    steerT = steerT + (pursuit - steerT) * pull;
  }
  const sgv = car.v < -0.3 ? -1 : 1;
  // Free-roam boundary: turn the car home while it moves outward.
  if (kEdge > 0) {
    const vout = -car.v * cosHome;
    const w = Math.min(1, kEdge) * ss01((vout + 2) / 4);
    const sH = Math.max(-maxSteer, Math.min(maxSteer, Math.atan(2 * WHEELBASE * Math.sin(homeA) / 25)));
    steerT += (sH * sgv - steerT) * w;
  }
  // Water: swing the direction of motion away from the wetter flank.
  if (FS[1] > 0 || FS[2] > 0) {
    steerT += (FS[1] - FS[2]) * maxSteer * sgv * (0.5 + Math.max(0, FS[0] - FS[3]));
    steerT = Math.max(-maxSteer, Math.min(maxSteer, steerT));
  }
  PS[11] = steerT;
}

// One fixed simulation step (SIM_DT seconds).
export function stepCar() {
  const h = SIM_DT;
  prev.set(cur);
  const x = cur[0], z = cur[2];
  let hd = cur[3];
  const v0 = car.v;

  // --- road tracking
  if (!car.auto) trackFree(x, z);
  else if (!car.forkMode) {
    pr[5] = x; pr[6] = z; pr[7] = car.s;
    project(car.track, pr, 40);
    car.s = pr[0]; car.lat = pr[1]; car.roadDist = pr[4];
    if (car.s >= edgeLen[car.track] - 0.01) {
      car.forkMode = true;
      car.forkNode = edgeTo[car.track];
      car.candS.fill(0);
    }
  }
  if (car.auto && car.forkMode) {
    const j = car.forkNode;
    let bi = -1, bd = 1e9;
    for (let i = 0; i < nodeExitCount[j]; i++) {
      const e = nodeExit(j, i);
      if (e < 0 || !exitAvailable(j, i)) continue;
      pr[5] = x; pr[6] = z; pr[7] = car.candS[i];
      project(e, pr, 40);
      car.candS[i] = pr[0];
      // Hysteresis toward the exit we are heading for.
      const d = pr[4] - (i === car.preferred ? 0.8 : 0);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0) {
      if (!car.auto) car.preferred = bi;
      const e = nodeExit(j, car.auto ? car.preferred : bi);
      const k = car.auto ? car.preferred : bi;
      pr[5] = x; pr[6] = z; pr[7] = car.candS[k];
      project(e, pr, 40);
      car.track = e; car.s = pr[0]; car.lat = pr[1]; car.roadDist = pr[4];
      if (car.s > COMMIT_S && car.roadDist < 30) {
        commit(e);
        car.forkMode = false;
        car.forkNode = -1;
        pickPreferred();
        if (car.auto && car.autoExit >= 0) car.preferred = car.autoExit;
      }
    }
  } else if (car.auto && car.autoExit >= 0) car.preferred = Math.min(car.autoExit, nodeExitCount[edgeTo[graph.cur]] - 1);

  // --- the strait crossings: which one is under the car, the ship's place and the hold
  ferryStep();

  // --- ground under the car
  gi[6] = x; gi[7] = z;
  groundCar(gi);
  const hw = gi[5];
  car.surf = gi[4]; car.hw = hw;
  const offRoad = Math.max(0, car.roadDist - hw - 0.5);
  const auto = car.auto;

  // --- player: off-road amount, free-roam boundary, water (own functions, so the scripted
  // path keeps stepCar small and optimised; values pass through PS, not double arguments)
  if (!auto) { PS[0] = x; PS[1] = z; PS[2] = hd; PS[3] = hw; PS[4] = offRoad; playerSense(); }

  // --- speed
  const cruise = offRoad > 6 ? 24 : CRUISE;
  const parked = PARK[0] > 0;
  if (parked) { /* park mode: speed and steering below */ }
  else if (auto) {
    let a;
    if (car.inThrottle > 0) a = 9 * car.inThrottle * (1 - car.v / VMAX);
    else if (car.inBrake > 0) a = car.v > 0.5 ? -16 * car.inBrake : -5 * car.inBrake;
    else a = Math.max(-4, Math.min(4, (cruise - car.v) * 0.7));
    a -= 6 * Math.min(1, offRoad / 14) * Math.max(0, car.v - 18) / 40; // grass drag
    car.v = Math.max(-10, Math.min(VMAX, car.v + a * h));
  } else playerSpeed();
  // Crossing: the speed down to the quay is capped so the car can board; aboard, the ship
  // sets it (the player's input does nothing until the far quay).
  if (FH[0] === 2) car.v = FH[1];
  else if (FH[0] === 1 && car.v > FH[1]) car.v = FH[1];
  car.aLong = (car.v - v0) / h;

  // --- steering
  const sp = Math.max(Math.abs(car.v), 2);
  const maxSteer = Math.min(0.55, Math.atan(WHEELBASE * A_LAT / (sp * sp)));
  let steerT = car.inSteer * maxSteer;
  // Pure pursuit toward the road ahead (lane assist / autopilot / corridor pull).
  const ld = 14 + sp * 0.55;
  // Point ld metres ahead along the planned path (continuing onto the preferred exit).
  {
    let e = car.track, sa = car.s + ld;
    if (sa > edgeLen[e]) {
      let xe = -1;
      if (auto) { if (!car.forkMode) xe = nodeExit(edgeTo[e], car.preferred); }
      else if (e === graph.cur) xe = nodeExit(edgeTo[e], car.preferred);
      else if (e === graph.prev) xe = graph.cur;
      if (xe >= 0) { sa -= edgeLen[e]; e = xe; }
    }
    tgt[4] = sa;
    pointAt(e, tgt);
  }
  const dx = tgt[0] - x, dz = tgt[2] - z;
  let alpha = Math.atan2(dz, dx) - hd;
  alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  const pursuit = Math.max(-maxSteer, Math.min(maxSteer, Math.atan(2 * WHEELBASE * Math.sin(alpha) / ld)));
  const handsOff = Math.abs(car.inSteer) < 0.02;
  if (auto) {
    steerT = pursuit;
    // Corridor pull: the further from the road, the more the pursuit takes over.
    const pull = Math.min(1, Math.max(0, (car.roadDist - 22) / 40));
    steerT = steerT + (pursuit - steerT) * pull;
  } else {
    PS[9] = maxSteer; PS[10] = pursuit; PS[11] = handsOff ? 1 : 0;
    playerSteer();
    steerT = PS[11];
  }
  if (FH[0] === 2) steerT = pursuit; // aboard: the ship's course
  if (parked) { steerT = parkStep(x, z, hd, maxSteer); car.aLong = (car.v - v0) / h; }
  const steer0 = cur[6];
  cur[6] = steer0 + (steerT - steer0) * Math.min(1, h / 0.09);

  // --- integrate
  car.yawRate = car.v * Math.tan(cur[6]) / WHEELBASE;
  hd += car.yawRate * h;
  cur[3] = hd;
  cur[0] = x + Math.cos(hd) * car.v * h;
  cur[2] = z + Math.sin(hd) * car.v * h;
  // Hard limit (scripted drive only): never more than ~75 m from the road.
  if (auto && car.roadDist > 75) {
    const k = (car.roadDist - 75) * 0.02;
    cur[0] += (tgt[0] - x) * k * h; cur[2] += (tgt[2] - z) * k * h;
  }
  deckClamp(cur); // the ship's lane, the bridge's railings
  tunnelClamp(cur); // a passage's walls (world/tunnel.js)
  car.aLat = car.v * car.yawRate;
  car.dist += Math.abs(car.v) * h;
  cur[16] = car.v;

  // --- suspension: wheel contacts, body spring, roll and pitch
  const ch = Math.cos(hd), sh = Math.sin(hd);
  // Local x = left: left = (sin h, -cos h) in xz.
  const fx = ch, fz = sh, lx = sh, lz = -ch;
  let gsum = 0;
  for (let w = 0; w < 4; w++) {
    const side = (w & 1) ? -1 : 1; // FL, FR, RL, RR
    const fwd = w < 2 ? WHEELBASE / 2 : -WHEELBASE / 2;
    const wx = cur[0] + fx * fwd + lx * side * TRACK / 2, wz = cur[2] + fz * fwd + lz * side * TRACK / 2;
    gi[6] = wx; gi[7] = wz;
    groundCar(gi);
    let gy = gi[0];
    // Surface vibration (trail and grass shake more than paving).
    const rough = gi[1] > gi[5] + 0.5 ? 0.035 : (gi[4] < 1 ? 0.014 : gi[4] < 2 ? 0.009 : 0.003);
    NIO[0] = car.dist * 0.9 + w * 17.3; NIO[1] = w * 3.1;
    noiseValue();
    gy += rough * (NIO[2] - 0.5) * 2;
    // Player off-road: a slower swell under each wheel (bounce, pitch and roll), not a rattle.
    if (!auto && gi[1] > gi[5] + 0.5) {
      const ob = ss01((gi[1] - gi[5] - 0.5) / 4);
      NIO[0] = wx * 0.21 + 3.7; NIO[1] = wz * 0.21 + 1.3;
      noiseValue();
      gy += ob * 0.07 * (NIO[2] - 0.5) * 2;
    }
    cur[8 + w] = gy;
    gsum += gy;
  }
  const gAvg = gsum * 0.25;
  const front = (cur[8] + cur[9]) * 0.5, rear = (cur[10] + cur[11]) * 0.5;
  const left = (cur[8] + cur[10]) * 0.5, right = (cur[9] + cur[11]) * 0.5;
  const pitchG = Math.atan2(front - rear, WHEELBASE);
  const rollG = Math.atan2(right - left, TRACK); // positive = right side lower
  // Body base rides the ground plane on a spring: changes in the ground's vertical speed
  // (bumps, crests, dips) kick the spring, so the body bobs but never lags on slopes.
  const tv = (gAvg - car.prevG) / h;
  if (car.prevG > -1e8) car.bodyVY -= (tv - car.prevTV) * 0.8;
  car.prevG = gAvg; car.prevTV = tv;
  car.bodyVY += (-170 * car.bodyOff - 15 * car.bodyVY) * h;
  car.bodyOff += car.bodyVY * h;
  car.bodyOff = Math.max(-0.12, Math.min(0.12, car.bodyOff));
  cur[1] = gAvg + car.bodyOff;
  // Pitch: ground + squat/dive; roll: ground + body lean outward in turns.
  const pitchT = pitchG + car.aLong * 0.006;
  const rollT = rollG - car.aLat * 0.011;
  car.pitchV += (-90 * (cur[4] - pitchT) - 12 * car.pitchV) * h;
  cur[4] += car.pitchV * h;
  car.rollV += (-70 * (cur[5] - rollT) - 10 * car.rollV) * h;
  cur[5] += car.rollV * h;
  // Player: a side slope steeper than ~17 degrees slides the car down the fall line (and
  // bleeds speed), so it cannot traverse an ice wall on two wheels.
  if (!auto) {
    const sr = Math.sin(rollG), asr = sr < 0 ? -sr : sr;
    const tgtV = asr > 0.3 ? (sr > 0 ? 1 : -1) * 14 * (asr - 0.3) : 0; // + = toward the right
    FS[5] += (tgtV - FS[5]) * Math.min(1, h * 4);
    if (FS[5] > 0.01 || FS[5] < -0.01) {
      cur[0] += -sh * FS[5] * h; cur[2] += ch * FS[5] * h;
      car.v *= 1 - Math.min(0.5, (FS[5] < 0 ? -FS[5] : FS[5]) * 0.08) * h;
    }
  }

  cur[7] += car.v * h / WHEEL_R;
  cur[17] += h * (1.5 + car.v * 0.04);

  // --- chase camera (critically damped follow, yaw lags in curves)
  let dyaw = hd - cur[15];
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  cur[15] += dyaw * Math.min(1, h * 2.6);
  const cy = cur[15];
  const dist = 7.6 + Math.max(0, car.v - CRUISE) * 0.05;
  const txc = cur[0] - Math.cos(cy) * dist, tzc = cur[2] - Math.sin(cy) * dist;
  const kf = Math.min(1, h * 9);
  cur[12] += (txc - cur[12]) * kf;
  cur[14] += (tzc - cur[14]) * kf;
  gi[6] = cur[12]; gi[7] = cur[14];
  groundInfo(gi);
  const gyC = gi[0];
  const tyc = Math.max(cur[1] + 2.55, gyC + 1.2);
  cur[13] += (tyc - cur[13]) * Math.min(1, h * 6);
  tunnelCam(cur); // inside a passage: between its walls, under its crown

  // --- dust
  emitDust();
  stepDust();
}

// Interpolate between the last two steps for rendering.
export function interpolate() {
  const alpha = simIO[0];
  for (let i = 0; i < NS; i++) {
    let a = prev[i], b = cur[i];
    if (i === 3 || i === 15) { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); b = a + d; }
    pose[i] = a + (b - a) * alpha;
  }
}

// ---------------------------------------------------------------------------------
// Matrices (column-major), built from `pose`.

export const partMat = new Float32Array(NPART * 16 + 4); // + glow params
export const bodyMat = new Float32Array(16);
const tA = new Float32Array(16), tB = new Float32Array(16), tC = new Float32Array(16);

// BA: heading, pitch, roll, position x, y, z (inputs to basis()).
const BA = new Float64Array(6);
function basis(out) {
  const hd = BA[0], pitch = BA[1], roll = BA[2], px = BA[3], py = BA[4], pz = BA[5];
  const fx0 = Math.cos(hd), fz0 = Math.sin(hd);
  const rx0 = -fz0, rz0 = fx0; // right
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // pitch about right axis (nose up +)
  const fx = fx0 * cp, fy = sp, fz = fz0 * cp;
  const ux = -fx0 * sp, uy = cp, uz = -fz0 * sp;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // roll about forward: positive = right side down
  const rX = rx0 * cr - ux * sr, rY = -uy * sr, rZ = rz0 * cr - uz * sr;
  const uX = ux * cr + rx0 * sr, uY = uy * cr, uZ = uz * cr + rz0 * sr;
  // columns: left (-right), up, forward, position
  out[0] = -rX; out[1] = -rY; out[2] = -rZ; out[3] = 0;
  out[4] = uX; out[5] = uY; out[6] = uZ; out[7] = 0;
  out[8] = fx; out[9] = fy; out[10] = fz; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
  return out;
}
function mul4(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) tC[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  out.set(tC);
  return out;
}
// Rotation about local axis (0 = x, 1 = y, 2 = z) then translation.
// RA: angle, translation x, y, z (inputs to rotT()).
const RA = new Float64Array(4);
function rotT(out, axis) {
  const c = Math.cos(RA[0]), s = Math.sin(RA[0]);
  const tx = RA[1], ty = RA[2], tz = RA[3];
  out.fill(0); out[15] = 1;
  if (axis === 0) { out[0] = 1; out[5] = c; out[6] = s; out[9] = -s; out[10] = c; }
  else if (axis === 1) { out[0] = c; out[2] = -s; out[5] = 1; out[8] = s; out[10] = c; }
  else { out[0] = c; out[1] = s; out[4] = -s; out[5] = c; out[10] = 1; }
  out[12] = tx; out[13] = ty; out[14] = tz;
  return out;
}

function setR(a, x, y, z) { RA[0] = a; RA[1] = x; RA[2] = y; RA[3] = z; }

export function buildMatrices() {
  const time = state.time;
  const p = pose;
  BA[0] = p[3]; BA[1] = p[4]; BA[2] = p[5]; BA[3] = p[0]; BA[4] = p[1]; BA[5] = p[2];
  basis(bodyMat);
  partMat.set(bodyMat, 0);
  const ch = Math.cos(p[3]), sh = Math.sin(p[3]);
  const groundPitch = Math.atan2((p[8] + p[9]) - (p[10] + p[11]), 2 * WHEELBASE);
  for (let w = 0; w < 4; w++) {
    const side = (w & 1) ? -1 : 1;
    const fwd = w < 2 ? WHEELBASE / 2 : -WHEELBASE / 2;
    const wx = p[0] + ch * fwd + sh * side * TRACK / 2, wz = p[2] + sh * fwd - ch * side * TRACK / 2;
    const steer = w < 2 ? p[6] : 0;
    BA[0] = p[3] + steer; BA[1] = groundPitch; BA[2] = 0; BA[3] = wx; BA[4] = p[8 + w] + WHEEL_R; BA[5] = wz;
    basis(tA);
    RA[0] = p[7]; RA[1] = 0; RA[2] = 0; RA[3] = 0;
    rotT(tB, 0);
    mul4(tA, tA, tB);
    partMat.set(tA, (1 + w) * 16);
  }
  // Gyro rings around the chrono core.
  const ph = p[17];
  RA[0] = ph * 2.1; RA[1] = 0; RA[2] = 1.18; RA[3] = -1.42; rotT(tA, 1);
  RA[0] = 0.5; RA[1] = 0; RA[2] = 0; RA[3] = 0; rotT(tB, 0); mul4(tA, tA, tB);
  mul4(tA, bodyMat, tA); partMat.set(tA, 5 * 16);
  RA[0] = -ph * 1.4; RA[1] = 0; RA[2] = 1.18; RA[3] = -1.42; rotT(tA, 1);
  RA[0] = 0.9 + Math.sin(ph * 0.7) * 0.3; RA[1] = 0; RA[2] = 0; RA[3] = 0; rotT(tB, 2); mul4(tA, tA, tB);
  mul4(tA, bodyMat, tA); partMat.set(tA, 6 * 16);
  // Steering wheel: column tilted toward the driver, turns with the steer angle.
  RA[0] = 0.64; RA[1] = 0.36; RA[2] = 0.97; RA[3] = 0.06; rotT(tA, 0);
  RA[0] = -p[6] * 9; RA[1] = 0; RA[2] = 0; RA[3] = 0; rotT(tB, 2); mul4(tA, tA, tB);
  mul4(tA, bodyMat, tA); partMat.set(tA, 7 * 16);
  const o = NPART * 16;
  // core glow; dimmed as the light falls (at dusk the exposure is raised and a full-strength
  // core blooms over the car and outshines the warm windows of the ending's street)
  let dk = (env.sunElevation - 0.04) / 0.2; dk = dk < 0 ? 0 : dk > 1 ? 1 : dk;
  partMat[o] = (1.6 + 0.5 * Math.sin(time * 3.0) + 0.25 * Math.sin(time * 7.3)) * (0.22 + 0.78 * dk * dk * (3 - 2 * dk));
  partMat[o + 1] = time;
  partMat[o + 2] = 1 - 0.9 * TC[3]; // daylight on the car inside a passage (world/tunnel.js)
}

// Transform a car-local point by bodyMat (rendered pose), in place: out[0..2] local -> world.
export function bodyPoint(out) {
  const m = bodyMat;
  const lx = out[0], ly = out[1], lz = out[2];
  out[0] = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
  out[1] = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
  out[2] = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
  return out;
}

// ---------------------------------------------------------------------------------
// Dust: a fixed pool simulated in the sim step, drawn as soft billboards.

const MAXD = 768;
const dPos = new Float32Array(MAXD * 3), dVel = new Float32Array(MAXD * 3), dAge = new Float32Array(MAXD), dLife = new Float32Array(MAXD), dSize = new Float32Array(MAXD);
let dNext = 0;
const dAcc = new Float64Array(1);
const dUp = new Float32Array(MAXD * 8);
let dCount = 0;
// Pre-generated random table (a function returning a double would box it per call).
const RT = new Float32Array(4096);
{ let sd = 1; for (let i = 0; i < 4096; i++) { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; RT[i] = sd / 4294967296; } }
let ri = 0;

function emitDust() {
  const h = SIM_DT;
  const v = Math.abs(car.v);
  // Surface: trail/dirt dusty, paving and cobbles barely, asphalt and highway none (fades out
  // across the cobbles -> asphalt front), grass off-road a bit.
  const offRoad = car.roadDist > car.hw + 0.5;
  const s = car.surf;
  const surfDust = offRoad ? 0.55 : (s < 1 ? 1.0 : s < 2 ? 1.0 - 0.3 * (s - 1) : s < 3.5 ? 0.7 - 0.6 * Math.min(1, s - 2 + 0.6) : Math.max(0, 0.2 * (4 - s)));
  bioV(B_DUST);
  const rate = FH[0] === 2 ? 0 : v * 1.6 * surfDust * BV[3]; // particles per second (none aboard a ship)
  dAcc[0] += rate * h;
  const hd = cur[3], ch = Math.cos(hd), sh = Math.sin(hd);
  while (dAcc[0] >= 1) {
    dAcc[0] -= 1;
    const i = dNext; dNext = (dNext + 1) % MAXD;
    const w = 2 + (RT[ri = (ri + 1) & 4095] < 0.5 ? 0 : 1); // rear wheels
    const side = (w & 1) ? -1 : 1;
    const fwd = -WHEELBASE / 2 - 0.3;
    dPos[i * 3] = cur[0] + ch * fwd + sh * side * TRACK / 2 + (RT[ri = (ri + 1) & 4095] - 0.5) * 0.4;
    dPos[i * 3 + 1] = cur[8 + w] + 0.15;
    dPos[i * 3 + 2] = cur[2] + sh * fwd - ch * side * TRACK / 2 + (RT[ri = (ri + 1) & 4095] - 0.5) * 0.4;
    // Kicked back and out, slower than the car.
    const kick = 0.12 + 0.12 * RT[ri = (ri + 1) & 4095];
    dVel[i * 3] = ch * car.v * kick + sh * side * (1 + RT[ri = (ri + 1) & 4095] * 2);
    dVel[i * 3 + 1] = 0.6 + RT[ri = (ri + 1) & 4095] * 1.4;
    dVel[i * 3 + 2] = sh * car.v * kick - ch * side * (1 + RT[ri = (ri + 1) & 4095] * 2);
    dAge[i] = 0; dLife[i] = 1.6 + RT[ri = (ri + 1) & 4095] * 2.2; dSize[i] = 0.5 + RT[ri = (ri + 1) & 4095] * 0.5;
  }
}
function stepDust() {
  const h = SIM_DT;
  const damp = Math.exp(-h * 1.6);
  for (let i = 0; i < MAXD; i++) {
    if (dAge[i] >= dLife[i]) continue;
    dAge[i] += h;
    dVel[i * 3] = dVel[i * 3] * damp + 0.5 * h; // light breeze
    dVel[i * 3 + 1] = dVel[i * 3 + 1] * damp + 0.25 * h;
    dVel[i * 3 + 2] = dVel[i * 3 + 2] * damp + 0.3 * h;
    dPos[i * 3] += dVel[i * 3] * h; dPos[i * 3 + 1] += dVel[i * 3 + 1] * h; dPos[i * 3 + 2] += dVel[i * 3 + 2] * h;
  }
}
export function clearDust() { dAge.fill(0); dLife.fill(0); dAcc[0] = 0; ri = 0; }
function packDust() {
  let n = 0;
  for (let i = 0; i < MAXD; i++) {
    if (dAge[i] >= dLife[i]) continue;
    const t = dAge[i] / dLife[i];
    const o = n * 8;
    dUp[o] = dPos[i * 3]; dUp[o + 1] = dPos[i * 3 + 1]; dUp[o + 2] = dPos[i * 3 + 2];
    dUp[o + 3] = dSize[i] * (0.6 + 3.2 * Math.sqrt(t));
    dUp[o + 4] = (1 - t) * (1 - t) * Math.min(1, t * 8) ;
    dUp[o + 5] = i;
    n++;
  }
  dCount = n;
}

// ---------------------------------------------------------------------------------
// Mesh. Material ids: 0 paint, 1 brass, 2 copper, 3 rubber, 4 steel, 5 leather, 6 glass,
// 7 glow (cyan), 8 matte black, 9 head lamp, 10 grille, 11 tail lamp, 12 wood dash.

function buildCarMesh() {
  const m = new MeshBuilder();
  const P = (mat, part = 0) => { m.mat = mat; m.extra = part; };
  // Car local: x left, y up, z forward. MeshBuilder.place(tx,ty,tz, yaw,pitch,roll, scale).
  P(0);
  // Main tub and tapered tail.
  m.place(0, 0.64, -0.35).rbox(0.70, 0.24, 1.55, 0.28, 28, 14);
  m.place(0, 0.70, -1.75, 0, 0.12, 0).rbox(0.62, 0.20, 0.55, 0.45, 20, 10);
  // Long bonnet over the engine.
  m.place(0, 0.80, 1.28).rbox(0.50, 0.17, 0.92, 0.32, 24, 12);
  // (Scuttle cowl, dash, windscreen, gauges, steering column and wheel: src/interior.js.)
  // Cycle fenders: curved strips over each wheel (open surfaces; drawn double-sided).
  for (let w = 0; w < 4; w++) {
    const side = (w & 1) ? -1 : 1, fz = w < 2 ? WHEELBASE / 2 : -WHEELBASE / 2;
    const cx = side * TRACK / 2, cy = WHEEL_R;
    m.place(cx, cy, fz).surface(18, 3, (u, v) => {
      const a = -0.35 + u * (Math.PI + 0.55); // from behind to in front over the top
      const r = WHEEL_R + 0.09 + 0.012 * Math.sin(v * Math.PI);
      const wdt = 0.17;
      return [(v - 0.5) * 2 * wdt + side * 0.02 * Math.sin(v * Math.PI), Math.sin(a) * r, -Math.cos(a) * r];
    });
    // Fender stay.
    P(8);
    m.place(cx - side * 0.12, cy + 0.2, fz, 0, 0, side * 0.9).cyl(0.025, -0.02, 0.33, 6);
    P(0);
  }
  // Running boards.
  P(8);
  for (const side of [1, -1]) m.place(side * 0.80, 0.40, 0).rbox(0.11, 0.025, 0.72, 0.3, 12, 6);
  // Radiator grille + brass surround, head lamps, tail lamps.
  P(1); m.place(0, 0.76, 2.21).rbox(0.40, 0.25, 0.07, 0.25, 16, 8);
  P(10); m.place(0, 0.76, 2.265).rbox(0.34, 0.20, 0.025, 0.15, 12, 6);
  for (const side of [1, -1]) {
    P(1); m.place(side * 0.52, 0.86, 2.08).cyl(0.14, -0.14, 0.08, 18);
    P(9); m.place(side * 0.52, 0.86, 2.165).blob(0.115, 0.115, 0.03, 16, 6);
    P(8); m.place(side * 0.52, 0.66, 2.0, 0, 0, 0).cyl(0.025, -0.05, 0.05, 6);
    P(11); m.place(side * 0.42, 0.78, -2.12).blob(0.06, 0.06, 0.03, 10, 5);
  }
  // Copper flux pipes along both flanks.
  P(2);
  for (const side of [1, -1]) {
    m.place().tube((t) => [side * (0.74 + 0.03 * Math.sin(t * Math.PI)), 0.56 + 0.06 * Math.sin(t * Math.PI * 2), 1.15 - t * 3.0], () => 0.045, 10, 24);
    m.place().tube((t) => [side * 0.70, 0.80 - 0.24 * t, 1.6 - 0.45 * t], () => 0.035, 8, 6);
  }
  // Seats (oxblood leather) and the windscreen frame.
  P(5);
  for (const side of [1, -1]) {
    m.place(side * 0.36, 0.86, -0.82, 0, -0.18, 0).rbox(0.25, 0.30, 0.07, 0.3, 16, 8);
    m.place(side * 0.36, 0.66, -0.55).rbox(0.24, 0.07, 0.25, 0.35, 14, 6);
  }
  // Chrono core on the rear deck: brass base, glowing cylinder, cap.
  P(1); m.place(0, 0.86, -1.42, 0, -Math.PI / 2, 0).cyl(0.30, 0, 0.12, 24);
  P(7); m.place(0, 0.98, -1.42, 0, -Math.PI / 2, 0).cyl(0.17, 0, 0.36, 20, false);
  P(1); m.place(0, 1.34, -1.42, 0, -Math.PI / 2, 0).cyl(0.21, 0, 0.05, 20);
  m.place(0, 1.42, -1.42).blob(0.07, 0.09, 0.07, 10, 6);
  // Gimbal rings (parts 5 and 6, spun in buildMatrices) around the core at (0, 1.18, -1.42).
  P(1, 5); m.place().torus(0.46, 0.022, 40, 6);
  P(7, 5); m.place().torus(0.43, 0.009, 40, 4);
  P(2, 6); m.place(0, 0, 0, Math.PI / 2, 0, 0).torus(0.38, 0.02, 36, 6);
  // Wheels (parts 1-4): tyre, rim disc, spokes, brass hub. Axle along local x.
  for (let w = 0; w < 4; w++) {
    const part = 1 + w;
    P(3, part); m.place(0, 0, 0, Math.PI / 2, 0, 0, [1, 1, 1.45]).torus(0.33, 0.075, 36, 10);
    P(4, part); m.place(0, 0, 0, Math.PI / 2, 0, 0).torus(0.27, 0.018, 28, 5);
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      m.place(0, Math.sin(a) * 0.14, Math.cos(a) * 0.14, 0, -a, 0).cyl(0.009, -0.13, 0.13, 5, false);
    }
    P(1, part); m.place(0, 0, 0, Math.PI / 2, 0, 0).cyl(0.07, -0.09, 0.09, 14);
  }
  return m.build();
}

function buildGlass() {
  const m = new MeshBuilder();
  m.mat = 6; m.extra = 0;
  // Windscreen leaning back slightly, between the frame posts.
  m.place(0, 0.97, 0.62, 0, -0.45, 0).quad([0.62, 0.0, 0], [-1.24, 0, 0], [0, 0.19, 0], [0, 0, -1]);
  return m.build();
}

const CAR_COMMON = /* wgsl */ `
struct Parts { m: array<mat4x4f, ${NPART}>, glow: vec4f };
@group(1) @binding(0) var<uniform> PT: Parts;
struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) me: vec2f };
`;

const CAR_WGSL = MAIN_HEADER + CAR_COMMON + /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) lp: vec3f, @location(3) @interpolate(flat) mat: f32 };

@vertex fn vs(v: VIn) -> VOut {
  let M = PT.m[u32(v.me.y + 0.5)];
  var o: VOut;
  let w = M * vec4f(v.pos, 1.0);
  o.wp = w.xyz;
  o.n = (M * vec4f(v.nrm, 0.0)).xyz;
  o.lp = v.pos;
  o.mat = v.me.x;
  o.pos = F.viewProj * w;
  return o;
}

fn hash12c(p: vec2f) -> f32 { var q = fract(p * vec2f(0.1031, 0.1030)); q += dot(q, q.yx + 33.33); return fract((q.x + q.y) * q.x); }

// Environment reflection: sky above the horizon, warm ground below it.
fn envRefl(r: vec3f) -> vec3f {
  let sky = skyRadiance(normalize(vec3f(r.x, max(r.y, 0.02), r.z)));
  let gnd = F.ambient.rgb * (sunIlluminance() * max(F.sunDir.y, 0.0) + skyRadiance(vec3f(0.0, 1.0, 0.0)) * PI) / PI;
  return mix(gnd, sky, smoothstep(-0.12, 0.05, r.y));
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = normalize(i.n);
  if (!ff) { n = -n; }
  let v = normalize(F.camPos - i.wp);
  let m = i32(i.mat + 0.5);
  var base = vec3f(0.5);
  var metal = 0.0;
  var rough = 0.5;
  var emit = vec3f(0.0);
  var coat = 0.0;
  if (m == 0) { base = vec3f(0.012, 0.085, 0.082); rough = 0.35; coat = 1.0; }
  else if (m == 1) { base = vec3f(0.78, 0.56, 0.26); metal = 1.0; rough = 0.32; }
  else if (m == 2) { base = vec3f(0.80, 0.40, 0.24); metal = 1.0; rough = 0.38; }
  else if (m == 3) { base = vec3f(0.022, 0.021, 0.02); rough = 0.85; }
  else if (m == 4) { base = vec3f(0.62, 0.62, 0.64); metal = 1.0; rough = 0.28; }
  else if (m == 5) { base = vec3f(0.17, 0.045, 0.03); rough = 0.55; }
  else if (m == 7) { base = vec3f(0.05); emit = vec3f(0.15, 0.85, 0.9) * PT.glow.x * 1.4 * (0.45 + 0.55 * smoothstep(0.3, 0.9, sin(i.lp.y * 45.0 - PT.glow.y * 6.0))); } // bands peak ~2-3 HDR: a tight teal halo that keeps the car readable
  else if (m == 8) { base = vec3f(0.03); rough = 0.6; }
  else if (m == 9) { base = vec3f(0.9, 0.85, 0.7); metal = 0.0; rough = 0.08; emit = vec3f(1.0, 0.8, 0.55) * 0.6; }
  else if (m == 10) {
    let slat = smoothstep(0.35, 0.5, abs(fract(i.lp.x * 28.0) - 0.5));
    base = mix(vec3f(0.02), vec3f(0.7, 0.5, 0.24), slat); metal = slat; rough = 0.4;
  }
  else if (m == 11) { base = vec3f(0.3, 0.02, 0.01); emit = vec3f(0.6, 0.04, 0.02); rough = 0.1; }
  else if (m == 12) { base = vec3f(0.20, 0.09, 0.04) * (0.8 + 0.3 * sin(i.lp.x * 60.0 + sin(i.lp.y * 30.0) * 2.0)); rough = 0.4; coat = 0.6; }
  let ndl = max(dot(n, F.sunDir), 0.0);
  var sh = 1.0;
  if (ndl > 0.0) { sh = shadowAt(i.wp, n); }
  let sun = sunIlluminance();
  let amb = skyAmbient(n);
  // Diffuse (none for metals).
  var col = base * (1.0 - metal) * (sun * ndl * sh + amb) / PI;
  // Specular: GGX sun highlight + environment reflection with Schlick fresnel.
  let hv = normalize(v + F.sunDir);
  let nh = max(dot(n, hv), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let a2 = max(rough * rough * rough * rough, 1e-4);
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let f0 = mix(vec3f(0.04), base, metal);
  let fres = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  let envL = envRefl(r) * mix(1.0, 0.35, rough) * mix(1.0, 0.45, coat);
  col += fres * (sun * D * ndl * sh * 0.25 / max(nv, 0.2) + envL * (1.0 - rough * 0.6));
  if (coat > 0.0) {
    let fc = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    let dc = nh * nh * (0.0001 - 1.0) + 1.0;
    col += coat * fc * (envRefl(r) * 0.35 + sun * min(0.0001 / (PI * dc * dc), 400.0) * ndl * sh * 0.25);
  }
  col *= PT.glow.z; // a passage's darkness
  col += emit * 2.2;
  col = applyFog(col, i.wp);
  return vec4f(col, 1.0);
}

// Windscreen glass: reflection only (alpha-blended).
@fragment fn fsGlass(i: VOut) -> @location(0) vec4f {
  var n = normalize(i.n);
  let v = normalize(F.camPos - i.wp);
  if (dot(n, v) < 0.0) { n = -n; }
  let nv = max(dot(n, v), 0.0);
  let fr = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  let c = envRefl(r);
  return vec4f(c * fr / max(fr + 0.06, 1e-3), fr + 0.06);
}
`;

const CAR_SHADOW_WGSL = SHADOW_HEADER + CAR_COMMON + /* wgsl */ `
@vertex fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  return F.lightViewProj * (PT.m[u32(v.me.y + 0.5)] * vec4f(v.pos, 1.0));
}
`;

const DUST_WGSL = MAIN_HEADER + /* wgsl */ `
struct P { a: vec4f, b: vec4f }; // pos, size | alpha, id
@group(1) @binding(0) var<storage, read> ps: array<P>;
@group(1) @binding(1) var<uniform> dustCol: vec4f;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) wp: vec3f, @location(2) al: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = ps[ii];
  var cs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = cs[vi];
  let fwd = normalize(p.a.xyz - F.camPos);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let ang = p.b.y * 2.39;
  let rc = vec2f(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
  let wp = p.a.xyz + (right * rc.x + up * rc.y) * p.a.w;
  var o: VOut;
  o.pos = F.viewProj * vec4f(wp, 1.0);
  o.uv = rc; // rotated corner: uv.y is world-up across the puff (the fragment fades its lower half)
  o.wp = wp;
  o.al = p.b.x;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let r = length(i.uv);
  let soft = smoothstep(1.0, 0.2, r);
  let a = soft * i.al * 0.32 * smoothstep(-0.95, 0.05, i.uv.y); // fade the lower half: no hard line where a puff meets the ground
  let v = normalize(i.wp - F.camPos);
  let fwdScatter = 1.0 + 2.5 * pow(max(dot(v, F.sunDir), 0.0), 6.0);
  let lit = dustCol.rgb * (sunIlluminance() * max(F.sunDir.y, 0.15) * fwdScatter * mix(0.55, 1.0, shadowAt(i.wp, F.sunDir)) + skyAmbient(vec3f(0.0, 1.0, 0.0))) / PI * dustCol.w;
  let col = applyFog(lit, i.wp);
  return vec4f(col * a, a);
}
`;

let pipe, glassPipe, shPipe, dustPipe, vbuf, ibuf, gvbuf, gibuf, nIdx, nGIdx, partBuf, bg, dustBuf, dustBG, dustColBuf;
const dustCol = new Float32Array(4);

export async function initCar() {
  const d = gpu.device;
  const mesh = buildCarMesh();
  const glass = buildGlass();
  vbuf = d.createBuffer({ size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(vbuf, 0, mesh.vertices);
  ibuf = d.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ibuf, 0, mesh.indices);
  nIdx = mesh.indices.length;
  gvbuf = d.createBuffer({ size: glass.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(gvbuf, 0, glass.vertices);
  gibuf = d.createBuffer({ size: glass.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(gibuf, 0, glass.indices);
  nGIdx = glass.indices.length;
  partBuf = d.createBuffer({ size: partMat.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const bgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
  bg = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: partBuf } }] });
  dustBuf = d.createBuffer({ size: dUp.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  dustColBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const dbgl = d.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: VF, buffer: {} },
  ] });
  dustBG = d.createBindGroup({ layout: dbgl, entries: [{ binding: 0, resource: { buffer: dustBuf } }, { binding: 1, resource: { buffer: dustColBuf } }] });
  const mod = d.createShaderModule({ label: 'car', code: CAR_WGSL });
  const smod = d.createShaderModule({ label: 'car-sh', code: CAR_SHADOW_WGSL });
  const dmod = d.createShaderModule({ label: 'dust', code: DUST_WGSL });
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  [pipe, glassPipe, shPipe, dustPipe] = await Promise.all([
    mainPipeline({ label: 'car', module: mod, layouts: [bgl], buffers: VERTEX_LAYOUT, cullMode: 'none' }),
    mainPipeline({ label: 'glass', module: mod, fragment: 'fsGlass', layouts: [bgl], buffers: VERTEX_LAYOUT, cullMode: 'none', depthWrite: false, blend }),
    shadowPipeline({ label: 'car-sh', module: smod, vertex: 'vsShadow', layouts: [bgl], buffers: VERTEX_LAYOUT }),
    mainPipeline({ label: 'dust', module: dmod, layouts: [dbgl], cullMode: 'none', depthWrite: false, blend }),
  ]);
  const HIDE = /[?&]hide=[^&]*car/.test(location.search); // debug: ?hide=...
  if (!HIDE) addDrawable({
    shadow(p) {
      if (car.hidden) return;
      p.setPipeline(shPipe); p.setBindGroup(1, bg);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32'); p.drawIndexed(nIdx);
    },
    main(p) {
      if (car.hidden) return;
      p.setPipeline(pipe); p.setBindGroup(1, bg);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32'); p.drawIndexed(nIdx);
    },
    transparent(p) {
      if (dCount) {
        p.setPipeline(dustPipe); p.setBindGroup(1, dustBG); p.draw(6, dCount);
      }
      // (windscreen glass: src/interior.js)
    },
  });
}

// Per frame, after interpolate(): matrices + dust upload.
export function uploadCar() {
  buildMatrices();
  const q = gpu.device.queue;
  q.writeBuffer(partBuf, 0, partMat);
  packDust();
  if (dCount) q.writeBuffer(dustBuf, 0, dUp, 0, dCount * 8);
  bioV(B_DUST);
  dustCol[0] = BV[0]; dustCol[1] = BV[1]; dustCol[2] = BV[2]; dustCol[3] = 1 - 0.9 * TC[3]; // w: a passage's darkness
  q.writeBuffer(dustColBuf, 0, dustCol);
}
