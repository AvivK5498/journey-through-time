// The ending (DESIGN.md "Round two / Ending"): arrival, the echo, the rewind, the journey card.
//
//   1 Arrival (clock 284 -> 300, ~15 s). The home (event 22, landmarks/home.js) is built
//     off-stage from clock 262 (sites.js prebuildHome) and stood beside the road 380-950 m
//     ahead on the car's route, on a straight, uncrowded, dry spot (homeSpotOk). The car takes
//     over (car.js park mode: the player's keys stop, a small cue says so), slows down the
//     street, turns into the driveway and parks; the clock follows the path's progress to
//     exactly 300. Off-road or far from the road: a short veil, the car is set back on the road.
//     Engine off: audio.finale().
//   2 The echo (~10 s). The camera lifts out of the car, over the roof and down into the yard,
//     to a held shot of the fire pit under the tree with people round it: the first camp's
//     composition. Letterbox: "2026" and the first camp's caption, word for word.
//   3 The rewind (10.5 s). From the same camera, state.clock itself is run back from 300 to 3,
//     so the game's own machinery plays in reverse: the time-lapse sky (spinning backwards,
//     timefx dir -1), the house unbuilding (built = clock / 300), the settlements and the road
//     surface (each change sweeps along the street as a front: settle.js settleOverride and
//     the road's surface curve), the year in the letterbox running down. The fire is camp.js's
//     own and never changes; at clock 3 the first camp stands round it. Then one line.
//   4 The card: route (biome glyphs), events witnessed of 22 with their names, years, distance,
//     and "Keep driving": the clock goes back to 300 behind the veil, the car pulls out down
//     the street into thick fog, and main.js loops into a new seeded world (logbook kept).
// Space / Enter skips to the card at any point. Free drive only (main.js: never in the
// scripted / pose captures unless ?ending=1).
//
//   initEnding(hooks)   hooks: { loop(), finale(), restart(), markLogged(ev), view(v) }
//   endingTrack()       every frame (free drive): the route record for the card
//   endingUpdate(dt)    every running frame after the sim step (dt real seconds)
//   endingSurface()     after time.js updateSurfaceCurve (the rewind's road front)
//   endingRig(cam)      after the driving / witness rigs
//   endingKey(code)     Space / Enter; returns true if consumed
//   ending              { phase, on, lock (keys ignored), fog (multiplier) }
// Allocates nothing per frame (the card is built once).

import { state } from './state.js';
import { camera, witness, witnessEnd } from './camera.js';
import { car, pose, PARK, PATH, parkBegin, placeCar, placeCarAt } from './car.js';
import { graph, edgeLen, edgeTo, nodeExit, nodeExitCount, exitAvailable, exitAngle, pointAt, edgeRegion, edgeJ0, clockBase, edgeAlive } from './world/graph.js';
import { prebuildHome, homeSpotOk, placeHome, homePose, siteHold, markSeen, seenMask } from './world/sites.js';
import { settleOverride } from './world/settle.js';
import { surfaceCurve, groundInfo } from './world/world.js';
import { yearLabel, yearAt, EVENTS, EV_HOME, EV_CAMP, SURFACE_CLOCK, SURFACE_ID, FRONT_SOFT } from './world/time.js';
import { timeFx } from './timefx.js';
import { journeyIO } from './drive.js';
import { FH } from './world/crossing.js';
import { endingCue, endingBars, endingYear, endingCard, endingDone, fadeVeil, ui } from './ui.js';
import { DRIVE_Z, PARK_X, HOME_OFF, FIRE_X, FIRE_Z } from './world/landmarks/home.js';

export const P_IDLE = 0, P_TAKE = 1, P_ARRIVE = 2, P_PARKED = 3, P_ECHO = 4, P_REWIND = 5, P_LINE = 6, P_CARD = 7, P_OUTRO = 8;
export const ending = { phase: 0, on: false, lock: false, fog: 1, enabled: false, skipped: false };

const ARM_CLOCK = 262, TAKE_CLOCK = 284, END_CLOCK = 300, REWIND_END = 0.4; // 0.4: the year reads 300,000 years ago
const PARKED_S = 1.8, ECHO_FLY = 5.6, ECHO_S = 10.5, LINE_HOLD = 2.4, LINE_S = 6.4, R_TURN = 7;
// The line the echo shares with the first camp (time.js EVENTS[0].short, shown when it is logged).
const ECHO_LINE = EVENTS[EV_CAMP].short;
// Rewind clock keyframes (real s, clock): slow while the house unbuilds, fast through the eras,
// slow again as the camp comes back round the fire. Monotone cubic, tabulated at load.
const RK_T = [0, 1.0, 3.2, 4.4, 7.8, 9.2, 10.5], RK_C = [300, 294, 266, 230, 40, 15, REWIND_END];
const REWIND_S = RK_T[RK_T.length - 1], RTAB = new Float64Array(512);
{
  const n = RK_T.length, d = new Float64Array(n), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (RK_C[i + 1] - RK_C[i]) / (RK_T[i + 1] - RK_T[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]); // harmonic: monotone
  for (let k = 0; k < RTAB.length; k++) {
    const t = (k / (RTAB.length - 1)) * REWIND_S;
    let i = 0; while (i < n - 2 && t > RK_T[i + 1]) i++;
    const h = RK_T[i + 1] - RK_T[i], u = (t - RK_T[i]) / h, u2 = u * u, u3 = u2 * u;
    RTAB[k] = (2 * u3 - 3 * u2 + 1) * RK_C[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * RK_C[i + 1] + (u3 - u2) * h * m[i + 1];
  }
}
// Changes the rewind sweeps along the street (settlement eras, road surfaces), newest first.
const TR = [283, 272, 255, 245, 210, 165, 120, 80, 40], TR_W = 7;

// E: [0] phase time (real s), [1] clock at takeover, [2] home edge, [3] home s, [4] side,
// [5] home journey metres, [6] start view, [7] veil step, [8] finale sent, [9] rewind dc/dt,
// [10] start clock of the journey, [11] outro step
const E = new Float64Array(16);
const H = new Float64Array(4); // home origin x, y, z, yaw
const CAM = new Float64Array(24); // [0..2] eye0, [3..5] target0, [6] fov0, [7..9] echo eye, [10..12] echo target, [13] echo fov
const Q = new Float64Array(8), G = new Float64Array(8);
const ROUTE = new Int8Array(96), RN = new Int32Array(2); // region | landmass << 4, count; [1] last code
let hooks = null, lastLabel = '';

export function initEnding(h, enabled) {
  hooks = h; ending.enabled = enabled;
  journeyIO[1] = enabled ? END_CLOCK - 0.6 : 1e9;
}

// New journey (main.js after resetDrive): forget the route and any ending state.
export function endingReset(startClock) {
  RN[0] = 0; RN[1] = -1; E[10] = startClock;
  release();
  ending.phase = P_IDLE; ending.skipped = false;
}

function release() {
  ending.on = false; ending.lock = false; ending.fog = 1;
  journeyIO[0] = 0; PARK[0] = 0; siteHold[0] = 0; settleOverride[0] = 0;
  timeFx.dir = 1; timeFx.force = NaN; car.hidden = false;
}

export function endingTrack() {
  if (graph.cur < 0) return;
  const code = edgeRegion[graph.cur] | (state.landmass << 4);
  if (code === RN[1] || RN[0] >= ROUTE.length) return;
  RN[1] = code; ROUTE[RN[0]++] = code;
}

// ------------------------------------------------------------------ arrival
// Route ahead of the car (current edge, then the exits the car is heading for): distance d ->
// Q[0] edge, Q[1] s. False past the generated roads.
const RE = new Int16Array(4), RS = new Float64Array(4);
function routeInit() {
  let e = car.track >= 0 ? car.track : graph.cur;
  RE[0] = e; RS[0] = Math.max(0, car.s);
  for (let k = 1; k < 4; k++) {
    const j = edgeTo[e];
    let x = -1, best = 1e9;
    for (let i = 0; i < nodeExitCount[j]; i++) {
      if (!exitAvailable(j, i) || nodeExit(j, i) < 0) continue;
      const a = Math.abs(exitAngle(j, i)) - (e === graph.cur && i === car.preferred ? 10 : 0);
      if (a < best) { best = a; x = i; }
    }
    e = x >= 0 ? nodeExit(j, x) : -1;
    RE[k] = e; RS[k] = 0;
    if (e < 0) break;
  }
}
function routeAt(d) {
  let s = RS[0] + d;
  for (let k = 0; k < 4; k++) {
    const e = RE[k];
    if (e < 0 || !edgeAlive[e]) return false;
    if (s <= edgeLen[e] || k === 3) { Q[0] = e; Q[1] = Math.min(s, edgeLen[e]); return true; }
    s -= edgeLen[e];
  }
  return false;
}

// Home-local (x, z) -> world G[0], G[1].
function toWorld(lx, lz) {
  const c = Math.cos(H[3]), s = Math.sin(H[3]);
  G[0] = c * lx + s * lz + H[0]; G[1] = -s * lx + c * lz + H[2];
}

function plan() {
  routeInit();
  let found = false;
  for (let pass = 0; pass < 2 && !found; pass++) {
    for (let d = 380; d <= 950 && !found; d += 20) {
      if (!routeAt(d)) break;
      for (let side = 1; side >= -1; side -= 2) {
        if (homeSpotOk(Q[0], Q[1], side, pass === 0)) { E[2] = Q[0]; E[3] = Q[1]; E[4] = side; found = true; break; }
      }
    }
  }
  if (!found) { if (!routeAt(420)) routeAt(0); E[2] = Q[0]; E[3] = Q[1]; E[4] = 1; }
  placeHome(E[2] | 0, E[3], E[4]);
  homePose(H);
  E[5] = edgeJ0[E[2] | 0] + E[3];
  // The path: the road from the car to the turn, a quarter turn into the driveway, the drive.
  const tz = E[4] > 0 ? -1 : 1;
  const e = E[2] | 0, sTurn = E[3] + tz * DRIVE_Z - R_TURN;
  let n = 0;
  PATH[0] = pose[0]; PATH[1] = pose[2]; n = 1;
  // route distance of sTurn: walk the route to the home's edge
  let dHome = -RS[0];
  for (let k = 0; k < 4 && RE[k] >= 0; k++) { if (RE[k] === e) break; dHome += edgeLen[RE[k]]; }
  const dTurn = dHome + sTurn;
  for (let d = 5; d < dTurn - 10 && n < 260; d += 5) {
    if (!routeAt(d)) break;
    Q[4] = Q[1]; pointAt(Q[0] | 0, Q);
    PATH[n * 2] = Q[0]; PATH[n * 2 + 1] = Q[2]; n++;
  }
  for (let z = DRIVE_Z - tz * (R_TURN + 10); tz * (DRIVE_Z - tz * R_TURN - z) > 0.01; z += tz * 2.5) { toWorld(-HOME_OFF, z); PATH[n * 2] = G[0]; PATH[n * 2 + 1] = G[1]; n++; }
  for (let k = 0; k <= 12; k++) {
    const a = (k / 12) * Math.PI / 2;
    toWorld(-HOME_OFF + R_TURN * (1 - Math.cos(a)), DRIVE_Z - tz * R_TURN + tz * R_TURN * Math.sin(a));
    PATH[n * 2] = G[0]; PATH[n * 2 + 1] = G[1]; n++;
  }
  for (let x = -HOME_OFF + R_TURN + 2; x <= PARK_X + 0.01; x += 2) { toWorld(x, DRIVE_Z); PATH[n * 2] = G[0]; PATH[n * 2 + 1] = G[1]; n++; }
  if (PATH[n * 2 - 2] !== G[0]) { toWorld(PARK_X, DRIVE_Z); PATH[n * 2] = G[0]; PATH[n * 2 + 1] = G[1]; n++; }
  parkBegin(n, 36, true);
  journeyIO[0] = 1;
  E[1] = state.clock;
}

// Keep the car where it is (a two-point path ending under it).
function holdCar() {
  const h = pose[3];
  PATH[0] = pose[0] - Math.cos(h) * 0.5; PATH[1] = pose[2] - Math.sin(h) * 0.5; PATH[2] = pose[0]; PATH[3] = pose[2];
  parkBegin(2, 0, true);
  car.v = 0;
}

// ------------------------------------------------------------------ camera
function echoPose() {
  // Eye in the yard's far corner, low; the fire in the middle of the frame, the acacia framing
  // the right, the house behind (lit windows), the street beyond it.
  // Eye low in the far corner of the yard, looking back at the house: the fire and the people
  // round it in the middle, the acacia rising behind them (a tree over the fire pit), the
  // house with its lit windows behind the tree, the street beyond. It looks in through the
  // camp's open side, so when the camp comes back no windbreak stands in front of the fire, at
  // an angle that shows all three seated people (two beyond the fire, one beside it).
  toWorld(FIRE_X + 10.0, FIRE_Z + 4.65); CAM[7] = G[0]; CAM[9] = G[1];
  G[6] = G[0]; G[7] = G[1]; groundInfo(G);
  CAM[8] = Math.max(H[1] + 2.9, G[0] + 1.6);
  toWorld(FIRE_X - 3, FIRE_Z - 1.4); CAM[10] = G[0]; CAM[12] = G[1]; CAM[11] = H[1] + 1.9;
  CAM[13] = 0.7;
}
function smoother(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * x * (x * (x * 6 - 15) + 10); }
function bez(a, b, c, d, u) { const v = 1 - u; return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d; }

export function endingRig(cam) {
  const p = ending.phase;
  if (p < P_ECHO || p > P_CARD) return;
  let u = 1, drift = 0;
  if (p === P_ECHO) { u = smoother(E[0] / ECHO_FLY); drift = E[0] / 40; }
  else drift = (ECHO_S + (p === P_REWIND ? E[0] : REWIND_S + 2)) / 40;
  // eye: lift out of the car, over the roof, down into the yard
  toWorld(-11, 0); const rx = G[0], rz = G[1];
  const ex = bez(CAM[0], CAM[0] + (rx - CAM[0]) * 0.15, rx + (CAM[7] - rx) * 0.2, CAM[7], u);
  const ez = bez(CAM[2], CAM[2] + (rz - CAM[2]) * 0.15, rz + (CAM[9] - rz) * 0.2, CAM[9], u);
  const ey = bez(CAM[1], CAM[1] + 12, H[1] + 19, CAM[8], u);
  // a slow drift sideways while the shot is held (keeps it alive)
  const dx = CAM[10] - CAM[7], dz = CAM[12] - CAM[9], dl = Math.hypot(dx, dz) || 1, k = 1.6 * (drift < 1 ? drift : 1) * u;
  cam.eye[0] = ex - dz / dl * k; cam.eye[1] = ey; cam.eye[2] = ez + dx / dl * k;
  // look: from the car's view, over the house, settling on the fire
  const w = smoother((u - 0.15) / 0.85);
  cam.target[0] = CAM[3] + (CAM[10] - CAM[3]) * w;
  cam.target[1] = CAM[4] + (CAM[11] - CAM[4]) * w + Math.sin(Math.PI * u) * 3;
  cam.target[2] = CAM[5] + (CAM[12] - CAM[5]) * w;
  cam.fovY = CAM[6] + (CAM[13] - CAM[6]) * u;
  cam.up[0] = 0; cam.up[1] = 1; cam.up[2] = 0;
  if (E[6] === 1) {
    const qx = cam.eye[0] - CAM[0], qy = cam.eye[1] - CAM[1], qz = cam.eye[2] - CAM[2];
    state.view = qx * qx + qy * qy + qz * qz > 6.25 ? 0 : 1;
  }
}

// ------------------------------------------------------------------ the rewind's fronts
function surfAt(c) { let k = 0; while (k < SURFACE_CLOCK.length && c >= SURFACE_CLOCK[k]) k++; return SURFACE_ID[k]; }
export function endingSurface() {
  const p = ending.phase;
  if (p < P_REWIND || p > P_CARD) return;
  const c = state.clock;
  let T = -1;
  for (let i = TR.length - 1; i >= 0; i--) if (TR[i] > c) { T = TR[i]; break; }
  let q = T > 0 ? (T - c) / TR_W : 1;
  q = q > 1 ? 1 : q * q * (3 - 2 * q);
  const front = E[5] + 800 - 1600 * q; // the older state spreads from ahead of the home back past it
  if (q < 1) {
    surfaceCurve.a = surfAt(T + 0.01); surfaceCurve.b = surfAt(c); surfaceCurve.d0 = front; surfaceCurve.d1 = front + FRONT_SOFT;
    settleOverride[1] = T + 0.01; settleOverride[2] = c; settleOverride[3] = front;
  } else {
    surfaceCurve.a = surfAt(c); surfaceCurve.b = surfaceCurve.a; surfaceCurve.d0 = 0; surfaceCurve.d1 = 1;
    settleOverride[1] = c; settleOverride[2] = c; settleOverride[3] = -1e9;
  }
  settleOverride[0] = 1;
}

// ------------------------------------------------------------------ the sequence
function go(p) { ending.phase = p; E[0] = 0; }

function startEcho() {
  endingBars('2026', '', false);
  CAM[0] = camera.eye[0]; CAM[1] = camera.eye[1]; CAM[2] = camera.eye[2];
  CAM[3] = camera.target[0]; CAM[4] = camera.target[1]; CAM[5] = camera.target[2]; CAM[6] = camera.fovY;
  E[6] = state.view;
  echoPose();
  markSeen(EV_HOME); if (hooks) hooks.markLogged(EV_HOME);
  go(P_ECHO);
}

function setClock(c) { state.clock = c; }

function showCard() {
  endingCue(false);
  const seen = seenMask();
  let n = 0;
  const names = [];
  for (let i = 0; i < EV_HOME; i++) if ((seen >>> i) & 1) { n++; names.push(EVENTS[i].name); }
  const route = [];
  let land = -1;
  for (let i = 0; i < RN[0]; i++) { const r = ROUTE[i] & 15, l = ROUTE[i] >> 4; route.push([r, land >= 0 && l !== land]); land = l; }
  const years = Math.round(END_CLOCK > E[10] ? 2026 - yearAt(E[10]) : 0);
  endingCard({ route, found: n, total: EV_HOME, names, years: years.toLocaleString('en-US'), km: (car.dist / 1000).toFixed(1) + ' km', line: 'From the first fire to this one.' });
  go(P_CARD);
}

// Skip: straight to the card over the finished rewind.
function skip() {
  ending.skipped = true;
  if (ending.phase === P_TAKE || !(E[2] >= 0)) plan();
  homePose(H);
  // the car in the driveway, the engine off
  toWorld(PARK_X, DRIVE_Z);
  const c = Math.cos(H[3]), s = Math.sin(H[3]);
  placeCarParked(G[0], G[1], Math.atan2(-s, c));
  if (!E[8]) { E[8] = 1; if (hooks) hooks.finale(); }
  if (ending.phase < P_ECHO) { CAM[0] = camera.eye[0]; CAM[1] = camera.eye[1]; CAM[2] = camera.eye[2]; CAM[3] = camera.target[0]; CAM[4] = camera.target[1]; CAM[5] = camera.target[2]; CAM[6] = camera.fovY; E[6] = state.view; echoPose(); markSeen(EV_HOME); if (hooks) hooks.markLogged(EV_HOME); }
  if (E[6] === 1) state.view = 0;
  setClock(REWIND_END);
  siteHold[0] = 1; car.hidden = true; timeFx.dir = 1; timeFx.force = NaN;
  endingBars(yearLabel(yearAt(REWIND_END)), '300,000 years. Same fire.', true);
  fadeVeil(0, 0.6);
  showCard();
}
function placeCarParked(x, z, hd) {
  placeCarAt(x, z, hd, 0);
  PATH[0] = x - Math.cos(hd) * 0.5; PATH[1] = z - Math.sin(hd) * 0.5; PATH[2] = x; PATH[3] = z;
  parkBegin(2, 0, true);
}

export function endingKey(code) {
  if (!ending.on) return false;
  if (code !== 'Space' && code !== 'Enter' && code !== 'NumpadEnter') return false;
  if (ending.phase === P_CARD) { keepDriving(); return true; }
  if (ending.phase >= P_TAKE && ending.phase <= P_LINE) { skip(); return true; }
  return false;
}

export function keepDriving() {
  if (ending.phase !== P_CARD) return;
  go(P_OUTRO); E[11] = 0;
  fadeVeil(1, 0.6, '');
  if (hooks) hooks.restart();
}

export function endingUpdate(dt) {
  if (!ending.enabled) return;
  const p = ending.phase;
  E[0] += dt;
  if (p === P_IDLE) {
    if (state.clock >= ARM_CLOCK) prebuildHome();
    if (state.clock < TAKE_CLOCK || FH[0] !== 0) return;
    if (witness.on) { witnessEnd(); return; }
    ending.on = true; ending.lock = true; E[8] = 0; E[2] = -1;
    endingCue(true);
    if (car.roadDist > car.hw + 18 || car.v < -0.5) { go(P_TAKE); E[7] = 0; fadeVeil(1, 0.7, ''); journeyIO[0] = 1; holdCar(); return; }
    plan();
    go(P_ARRIVE);
    return;
  }
  if (p === P_TAKE) { // set the car back on the road behind the veil, then arrive
    if (E[7] === 0 && ui.veil >= 0.99) {
      const e = graph.cur;
      placeCar(e, Math.max(5, Math.min(edgeLen[e] - 5, car.s)), 18);
      PARK[0] = 0;
      E[7] = 1;
    } else if (E[7] === 1) {
      plan();
      fadeVeil(0, 1.2);
      go(P_ARRIVE);
    }
    return;
  }
  if (p === P_ARRIVE) {
    let k = 1 - PARK[4] / (PARK[3] || 1);
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    setClock(E[1] + (END_CLOCK - E[1]) * k);
    if (E[0] > 7) endingCue(false);
    if (PARK[6] > 0) { setClock(END_CLOCK); if (!E[8]) { E[8] = 1; if (hooks) hooks.finale(); } go(P_PARKED); }
    return;
  }
  if (p === P_PARKED) { if (E[0] > 0.6) endingCue(false); if (E[0] >= PARKED_S) startEcho(); return; }
  if (p === P_ECHO) {
    if (E[0] >= 2.6 && E[0] - dt < 2.6) endingBars('2026', ECHO_LINE, false);
    if (E[0] >= ECHO_S) { go(P_REWIND); siteHold[0] = 1; lastLabel = ''; endingBars('2026', '', false); }
    return;
  }
  if (p === P_REWIND) {
    const t = E[0] < REWIND_S ? E[0] : REWIND_S;
    const x = (t / REWIND_S) * (RTAB.length - 1), i = Math.min(RTAB.length - 2, x | 0), f = x - i;
    const c = RTAB[i] + (RTAB[i + 1] - RTAB[i]) * f;
    E[9] = dt > 0 ? (state.clock - c) / dt : 0;
    setClock(c);
    // the sky runs backwards at the rewind's rate of history
    const slope = Math.abs(yearAt(c + 0.25) - yearAt(c - 0.25)) * 2;
    timeFx.dir = -1; timeFx.force = E[9] * slope;
    if (c < 271) car.hidden = true;
    const lab = yearLabel(state.year);
    if (lab !== lastLabel) { lastLabel = lab; endingYear(lab); }
    if (E[0] >= REWIND_S) {
      go(P_LINE);
      timeFx.dir = 1; timeFx.force = NaN;
      endingBars(yearLabel(yearAt(REWIND_END)), ECHO_LINE, false);
    }
    return;
  }
  if (p === P_LINE) {
    if (E[0] >= LINE_HOLD && E[0] - dt < LINE_HOLD) endingBars(yearLabel(yearAt(REWIND_END)), '300,000 years. Same fire.', true);
    if (E[0] >= LINE_S) showCard();
    return;
  }
  if (p === P_OUTRO) {
    if (E[11] === 0 && ui.veil >= 0.99) {
      // behind the veil: the journey's clock back to its end, the car out on the street
      E[11] = 1;
      endingCard(null); endingBars(null); endingDone();
      siteHold[0] = 0; settleOverride[0] = 0; car.hidden = false; timeFx.dir = 1; timeFx.force = NaN;
      setClock(END_CLOCK);
      state.view = E[6];
      ending.phase = P_OUTRO;
      const e = E[2] | 0, tz = E[4] > 0 ? -1 : 1;
      const s0 = Math.min(edgeLen[e] - 2, E[3] + tz * DRIVE_Z + 6);
      placeCar(e, s0, 9);
      let n = 0;
      for (let d = 0; d < 700 && n < 300; d += 5) {
        let s = s0 + d, ee = e;
        if (s > edgeLen[ee]) { const j = edgeTo[ee], x = nodeExit(j, 0); if (x < 0) break; s -= edgeLen[ee]; ee = x; if (s > edgeLen[ee]) break; }
        Q[4] = s; pointAt(ee, Q); PATH[n * 2] = Q[0]; PATH[n * 2 + 1] = Q[2]; n++;
      }
      parkBegin(n, 26, false);
      E[0] = 0;
      fadeVeil(0.18, 1.1);
      return;
    }
    if (E[11] >= 1) {
      ending.fog = 1 + 70 * smoother(E[0] / 3.6);
      if (E[11] === 1 && E[0] > 2.9) { E[11] = 2; fadeVeil(1, 0.9, ''); }
      if (E[11] === 2 && ui.veil >= 0.99) { release(); ending.phase = P_IDLE; if (hooks) hooks.loop(); }
    }
  }
}

// Tests / debug (allocates).
export function endingInfo() {
  const o = { phase: ending.phase, on: ending.on, lock: ending.lock, skipped: ending.skipped, clock: state.clock, park: Array.from(PARK, (v) => +v.toFixed(3)), home: null, route: Array.from(ROUTE.subarray(0, RN[0])), carHidden: car.hidden };
  if (homePose(H)) {
    const c = Math.cos(H[3]), s = Math.sin(H[3]), dx = pose[0] - H[0], dz = pose[2] - H[2];
    // world -> home-local (inverse of toWorld)
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    let dh = pose[3] - Math.atan2(-s, c); dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    o.home = { x: +H[0].toFixed(1), z: +H[2].toFixed(1), yaw: +H[3].toFixed(3), edge: E[2], s: +E[3].toFixed(1), side: E[4], carLocal: [+lx.toFixed(2), +lz.toFixed(2)], carHeadingErr: +dh.toFixed(3), parkX: PARK_X, driveZ: DRIVE_Z };
  }
  return o;
}
