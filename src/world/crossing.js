// The later strait crossings: a ship from 1492 and a modern bridge from ~1920, both ways
// between the landmasses (the Ice Age land bridge stays in sites.js).
//
// graph.js offers a "ferry" exit at some forks from 1492 on (see its header for the rule).
// That road is an ordinary graph edge: ~500 m of approach down to a stone quay at
// edgeQuayS[e] (the road surface ends there), then FERRY_WATER m straight over the strait to
// the far quay, where the edge ends at a single-exit node whose road leads inland. The car,
// the clock, the graph and streaming need no special case: over the water the car's ground
// is a deck, the ship's (which rides along the edge with the car) or the bridge's.
//
//   initCrossing()       once, after initLandmarkKit(): builds and uploads the meshes
//   ferryStep()          every sim step, from car.js: the active crossing under the car, the
//                        ship's place and motion, and FH (the hold on the car, below)
//   deckAt(g)            car.js, after groundInfo(g): over a quay, the ship's deck or the bridge
//                        deck, overrides g[0] (height), g[1] (road distance), g[4] (surface),
//                        g[5] (half width) and clears the water flags; returns true there
//   updateCrossing()     every frame (sites.js updateSites, so dry runs get it too): the strait
//                        water of the nearest crossing (world.js siteData, when it is nearer than
//                        a causeway), mesh poses and states, the closed land bridge's marker
//   crossingSpan(e, out) query for renderers / tests: out[0] quay s, out[1] far quay s (edge
//                        end), out[2] quay level, out[3] kind (0 none, 1 ship, 2 bridge now);
//                        returns false when e is not a crossing. The road surface is never
//                        drawn over [out[0], out[1]]: the bridge mesh carries its own roadway.
//   crossingInfo()       tests / debug (allocates)
//
// FH (hold): [0] 0 free, 1 approaching the quay (speed capped to board), 2 aboard (speed and
// steering are the ship's; the player's input is ignored until the far quay); [1] speed (m/s);
// [2] lateral limit from the centre line (0 none: the bridge railings, the ship's lane).
//
// Ship: waits with its stern at the near quay; the car rolls aboard to mid-ship, then ship and
// car move together (centre = the car's s), accelerate to ~40 m/s, slow to dock with the bow
// at the far quay, and the car rolls off. A carrack (era 4) or a paddle steamer (era 5-6,
// chosen by the clock at the quay), rolling gently, with a wake while under way. If the clock
// reaches BRIDGE_CLOCK while the car is still well short of the quay (graph.js edgeFerry 2),
// the ship fades out and the bridge rises (pylons, then balanced cantilevers from both
// pylons, cables, lamps) over BRIDGE_BUILD clock seconds; its lamps light at dusk.
// The car rides down the middle of both ships on an open lane: masts, castle decks, deckhouse
// and funnel stand beside it, nothing hangs over it. Nothing but the car is ever on the roadway.

import { state, env } from '../state.js';
import { car, pose } from '../car.js'; // runtime use only (the import cycle is safe)
import {
  edgeLand, graph, pointAt, edgeAlive, edgePresence, edgeLen, edgeVersion, edgeJ0, edgeFerry, edgeQuayS, edgeQuayY, nodeBridge,
  nodeAlive, nodeExit, exitAvailable, edgeDrawEnd, DRAW_END_PAD, FERRY_WATER, MAX_EDGES, MAX_NODES, clockBase, SIM_DT, nodeFerry,
} from './graph.js';
import { siteData, groundExtra, groundSea, groundInfo } from './world.js';
import { BRIDGE_CLOCK, BRIDGE_BUILD } from './time.js';
import { LandmarkBuilder, uploadLandmark, SURF, MOTION, BY, FLICKER } from './landmarks/kit.js';
import { showNote } from '../ui.js';

const W = FERRY_WATER, HW = W / 2;
const SHIP_HL = 17; // ship half length (m); the car rides at mid-ship
const LANE = 2.6; // half width of the ship's car lane
const QUAY_L = 34, QUAY_HW = 8; // quay length on land and half width
const QUAY_TOP = 0.1; // quay top above the quay level (covers the end of the road)
const WATER_DROP = 1.6; // strait water level (world.js) below the quay; visible water 0.6 lower
const BRIDGE_H = 9; // bridge deck rise at mid-span
const DECK_HW = 6.6;
const STEAM_CLOCK = 210; // ships reaching the quay from here are steamers
// Ship speed profile (m/s, m/s^2): board, under way, roll off.
const VB = 10, DEC = 7, ACC = 8, VS = 40, VE = 6;
// ?lamps=1 (captures): the bridge lamps lit whatever the sun (the game has no dusk before the ending).
const LAMPS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lamps') === '1' ? 1 : 0;

export const FH = new Float64Array(4);
// Active crossing under the car (ferryStep): [0] edge (-1), [1] x0, [2] z0 (quay point), [3] cos h,
// [4] sin h, [5] quay s, [6] far quay s, [7] quay level, [8] ship mode, [9] ship centre s,
// [10] deck y, [11] deck slope across (per m to the left), [12] deck slope along, [13] bridge built
const DK = new Float64Array(16);
DK[0] = -1;
const T = new Float64Array(4); // [0] sim time (ship motion), [1] previous hold mode
const shipS = new Float32Array(MAX_EDGES), shipVer = new Uint32Array(MAX_EDGES).fill(0xffffffff);
const Q = new Float64Array(8);

function ss(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function clockOf(e, s) { return clockBase[0] + (edgeJ0[e] + s - clockBase[1]) / 40; }

// Ship centre s on ferry edge e (waits at the near quay, rides with the car, stays docked).
function shipAt(e) {
  const qa = edgeQuayS[e], s0 = qa + SHIP_HL, s1 = edgeLen[e] - SHIP_HL;
  if (car.track === e) {
    let s = car.s < s0 ? s0 : car.s > s1 ? s1 : car.s;
    if (car.s < qa) s = s0;
    shipS[e] = s; shipVer[e] = edgeVersion[e];
    return s;
  }
  return shipVer[e] === edgeVersion[e] ? shipS[e] : s0;
}
function shipMode(e) { return edgeFerry[e] === 1 || state.clock < BRIDGE_CLOCK; }
function bridgeBuilt(e) { return edgeFerry[e] === 2 ? ss((state.clock - BRIDGE_CLOCK) / BRIDGE_BUILD) : 0; }
// Ship motion from the sim time: deck height offset, roll, pitch (amplitudes grow under way).
const M = new Float64Array(3);
function motion(under) {
  const t = T[0], k = 0.6 + 0.4 * under;
  M[0] = 0.07 * Math.sin(t * 1.25) * k;
  M[1] = (0.022 * Math.sin(t * 0.83) + 0.008 * Math.sin(t * 1.9 + 1)) * k;
  M[2] = 0.006 * Math.sin(t * 1.07 + 2.1) * k;
}

// ------------------------------------------------------------------ per sim step (car.js)
export function ferryStep() {
  T[0] += SIM_DT;
  FH[0] = 0; FH[2] = 0;
  let e = car.track;
  if (e < 0 || !edgeFerry[e] || !edgeAlive[e]) e = graph.prev >= 0 && edgeFerry[graph.prev] && edgeAlive[graph.prev] ? graph.prev : -1;
  DK[0] = e;
  if (e < 0) { T[1] = 0; return; }
  const qa = edgeQuayS[e], L = edgeLen[e];
  Q[4] = qa; pointAt(e, Q);
  DK[1] = Q[0]; DK[2] = Q[2]; DK[3] = Math.cos(Q[3]); DK[4] = Math.sin(Q[3]);
  DK[5] = qa; DK[6] = L; DK[7] = edgeQuayY[e];
  const ship = shipMode(e);
  DK[8] = ship ? 1 : 0;
  DK[13] = bridgeBuilt(e);
  const sc = shipAt(e);
  DK[9] = sc;
  if (ship && car.track === e) {
    const s = car.s, s0 = qa + SHIP_HL, s1 = L - SHIP_HL;
    if (s < qa) {
      if (s > qa - 220) { FH[0] = 1; FH[1] = Math.sqrt(VB * VB + 2 * DEC * (qa - s)); }
    } else if (s < L - 9) {
      let v = VB;
      if (s >= s0) {
        v = Math.min(VS, Math.sqrt(VB * VB + 2 * ACC * (s - s0)), Math.sqrt(VE * VE + 2 * ACC * Math.max(0, s1 - s)));
        if (s >= s1) v = VE;
      }
      FH[0] = 2; FH[1] = v; FH[2] = 0.35;
    }
  } else if (!ship && DK[13] >= 0.999) FH[2] = DECK_HW - 1.2; // the bridge railings
  const under = FH[0] === 2 && car.s > qa + SHIP_HL + 1 ? Math.min(1, car.v / VS) : 0;
  motion(under);
  DK[10] = edgeQuayY[e] + M[0];
  DK[11] = Math.cos(M[2]) * Math.sin(M[1]);
  DK[12] = -Math.sin(M[2]);
  if (FH[0] === 2 && T[1] !== 2) showNote(edgeLand[e] ? 'All aboard: the ship crosses back over the strait' : 'All aboard: the ship crosses the strait to the far landmass');
  T[1] = FH[0];
}

// Bridge deck height above the quay level at s along the crossing.
function bridgeRise(s, qa) { return BRIDGE_H * 0.5 * (1 - Math.cos(2 * Math.PI * (s - qa) / W)); }

export function deckAt(g) {
  const e = DK[0];
  if (e < 0) return false;
  const dx = g[6] - DK[1], dz = g[7] - DK[2];
  const along = dx * DK[3] + dz * DK[4], lat = -dx * DK[4] + dz * DK[3];
  const qa = DK[5], L = DK[6], s = qa + along, al = lat < 0 ? -lat : lat;
  let y = -1e9;
  if (al < QUAY_HW && ((s > qa - QUAY_L - 2 && s < qa + 0.8) || (s > L - 0.8 && s < L + QUAY_L + 2))) {
    // quay top, with a short ramp up from the road at its landward end
    const r = s < qa ? s - (qa - QUAY_L - 2) : L + QUAY_L + 2 - s;
    y = DK[7] + QUAY_TOP * ss(r / 2);
  }
  if (DK[8] > 0.5) {
    const zl = s - DK[9];
    if (zl > -SHIP_HL - 0.5 && zl < SHIP_HL + 0.5 && al < LANE + 1) y = DK[10] + DK[11] * -lat + DK[12] * zl;
  } else if (DK[13] >= 0.999 && s >= qa - 0.5 && s <= L + 0.5 && al < DECK_HW) y = DK[7] + QUAY_TOP + bridgeRise(s, qa);
  if (y < -1e8) return false;
  g[0] = y; g[1] = 0; g[4] = 2; g[5] = 3.4;
  groundExtra[5] = 0; groundSea[0] = 0;
  return true;
}

// Keeps the car (p: car.js sim channels, p[0] x, p[2] z) inside FH[2] of the crossing's centre
// line over the water: the ship's lane, the bridge between its railings.
export function deckClamp(p) {
  if (DK[0] < 0 || FH[2] <= 0) return;
  const dx = p[0] - DK[1], dz = p[2] - DK[2];
  const along = dx * DK[3] + dz * DK[4], lat = -dx * DK[4] + dz * DK[3];
  if (along < -2 || along > DK[6] - DK[5] + 2) return;
  const lim = FH[2], d = lat > lim ? lat - lim : lat < -lim ? lat + lim : 0;
  if (d === 0) return;
  p[0] += DK[4] * d; p[2] -= DK[3] * d;
}

// Sign glyph for strait exit i of fork n (props.js): 0 the Ice Age causeway, 1 the ship, 2 the
// modern bridge (the ship that gives way to it, graph.js edgeFerry 2).
export function crossingKind(n, i) {
  if (nodeFerry[n] !== i) return 0;
  const e = nodeExit(n, i);
  if (e >= 0) return edgeFerry[e] === 2 ? 2 : 1;
  return state.clock >= BRIDGE_CLOCK ? 2 : 1;
}

export function crossingSpan(e, out) {
  if (e < 0 || !edgeFerry[e]) return false;
  out[0] = edgeQuayS[e]; out[1] = edgeLen[e]; out[2] = edgeQuayY[e];
  out[3] = shipMode(e) ? 1 : bridgeBuilt(e) > 0 ? 2 : 1;
  return true;
}

// ------------------------------------------------------------------ meshes
let H = null; // handles: quays, carrack, steamer, bridge, marker
const DEF = (id, r) => ({ id, radius: r, wind: [0.6, 0.8] });

export function initCrossing() {
  if (H) return;
  const b = new LandmarkBuilder(90000, 120000);
  const up = (id, r, fn) => { b.reset(); b.seed(7); fn(b); const h = uploadLandmark(DEF(id, r), b, 0, -1e4, 0, 0); h.visible = false; return h; };
  H = {
    quays: up('quays', HW + QUAY_L, buildQuays),
    carrack: up('carrack', 30, buildCarrack),
    steamer: up('steamer', 30, buildSteamer),
    wake: up('wake', 60, buildWake),
    bridge: up('bridge', HW + 20, buildBridge),
    marker: up('marker', 6, buildMarker),
  };
}

// --- shared bits

// Quays (crossing-local: origin on the road line over the middle of the strait at quay
// level, +z along the road, +x to the left). Granite platforms reaching QUAY_L onto the land
// and a few metres into the water, bollards and a little cargo along their edges, timber
// fenders and piles at the water end.
function buildQuays(b) {
  for (let side = -1; side <= 1; side += 2) {
    const zw = side * HW; // water end
    const zl = side * (HW + QUAY_L); // land end
    const z0 = Math.min(zw, zl) - (side < 0 ? 0 : 1.5), z1 = Math.max(zw, zl) + (side < 0 ? 1.5 : 0);
    const zc = (z0 + z1) / 2, hz = (z1 - z0) / 2;
    // body: walls down into the water
    b.surface(SURF.STONE).ao(1).color(0.43, 0.39, 0.34);
    b.box(0, -3.5, zc, QUAY_HW, 3.5 + QUAY_TOP - 0.05, hz, false);
    // setts on top (slightly paler), and the coping stones along the edges
    b.color(0.47, 0.44, 0.40);
    b.box(0, QUAY_TOP - 0.03, zc, QUAY_HW - 0.5, 0.03, hz - 0.2, false);
    b.color(0.62, 0.58, 0.51);
    for (let sx = -1; sx <= 1; sx += 2) b.box(sx * (QUAY_HW - 0.25), QUAY_TOP + 0.04, zc, 0.3, 0.1, hz, false);
    b.box(0, QUAY_TOP + 0.04, zw + side * 0.25, QUAY_HW, 0.1, 0.3, false);
    // a darker tide band on the walls
    b.color(0.2, 0.2, 0.18);
    b.box(0, -1.85, zc, QUAY_HW + 0.03, 0.35, hz + 0.03, false);
    // bollards (iron) and timber fenders / piles at the water end
    b.color(0.07, 0.07, 0.08).surface(SURF.PLAIN);
    for (let k = 0; k < 4; k++) {
      const z = zw - side * (3 + k * 9);
      for (let sx = -1; sx <= 1; sx += 2) {
        b.beam(sx * (QUAY_HW - 0.8), QUAY_TOP, z, sx * (QUAY_HW - 0.8), QUAY_TOP + 0.75, z, 0.2, 0.17, 8, true);
        b.beam(sx * (QUAY_HW - 0.8), QUAY_TOP + 0.75, z, sx * (QUAY_HW - 0.8), QUAY_TOP + 0.85, z, 0.27, 0.27, 8, true);
      }
    }
    b.surface(SURF.WOOD).color(0.2, 0.13, 0.07);
    // piles along the water face: flush with the quay top across the lane, standing proud
    // only at the corners (never on the roadway)
    for (let k = -3; k <= 3; k++) { const out = k === -3 || k === 3; b.beam(k * 2.4, -3.2, zw + side * 0.7, k * 2.4, QUAY_TOP + (out ? 0.6 : -0.12), zw + side * 0.7, 0.24, 0.22, 6, true); }
    // cargo on the quay edges (never on the lane): crates and barrels
    for (let k = 0; k < 3; k++) {
      const z = zw - side * (6 + k * 8.5 + b.range(0, 2)), sx = (k & 1) ? 1 : -1;
      b.surface(SURF.WOOD).color(0.4 + b.range(0, 0.08), 0.28, 0.15);
      b.box(sx * 6.2, QUAY_TOP + 0.5, z, 0.55, 0.5, 0.55);
      b.box(sx * 6.4, QUAY_TOP + 1.3, z + 0.3, 0.42, 0.3, 0.42);
      b.color(0.3, 0.19, 0.1);
      b.beam(sx * 6.3, QUAY_TOP, z - 1.6, sx * 6.3, QUAY_TOP + 1.1, z - 1.6, 0.42, 0.42, 10, true);
    }
    // a harbour light on a post at the water end (left of the road coming in)
    const lx = side < 0 ? QUAY_HW - 1.2 : -(QUAY_HW - 1.2);
    b.surface(SURF.PLAIN).color(0.1, 0.1, 0.11);
    b.beam(lx, QUAY_TOP, zw - side * 1.6, lx, QUAY_TOP + 4.2, zw - side * 1.6, 0.11, 0.08, 6, true);
    b.color(1.0, 0.72, 0.38).emissive(0.06).box(lx, QUAY_TOP + 4.5, zw - side * 1.6, 0.22, 0.3, 0.22);
    b.emissive(0).color(0.1, 0.1, 0.11).box(lx, QUAY_TOP + 4.86, zw - side * 1.6, 0.3, 0.06, 0.3);
  }
}

// Hull (ship-local: +z bow, +x port, y = 0 the deck the car rides on; the visible water is at
// y = -2.2). half(t) half beam at t = z / SHIP_HL, sheer(t) top of the side.
function hull(b, beam, half, sheer, keel, colAt) {
  const NZ = 26, NU = 9;
  const P = new Float64Array((NZ + 1) * (NU + 1) * 3), N = new Float64Array(P.length);
  const U = [0, 0.18, 0.36, 0.52, 0.64, 0.74, 0.83, 0.9, 0.96, 1];
  for (let i = 0; i <= NZ; i++) {
    const t = -1 + 2 * i / NZ, z = t * SHIP_HL, hb = half(t) * beam, ys = sheer(t);
    for (let j = 0; j <= NU; j++) {
      const u = U[j], o = (i * (NU + 1) + j) * 3;
      P[o] = hb * Math.pow(Math.sin(u * Math.PI / 2), 0.55);
      P[o + 1] = ys - (ys - keel) * Math.pow(Math.cos(u * Math.PI / 2), 1.4);
      P[o + 2] = z;
    }
  }
  for (let i = 0; i <= NZ; i++) for (let j = 0; j <= NU; j++) {
    const a = (Math.min(NZ, i + 1) * (NU + 1) + j) * 3, c = (Math.max(0, i - 1) * (NU + 1) + j) * 3;
    const d = (i * (NU + 1) + Math.min(NU, j + 1)) * 3, f = (i * (NU + 1) + Math.max(0, j - 1)) * 3;
    const ax = P[a] - P[c], ay = P[a + 1] - P[c + 1], az = P[a + 2] - P[c + 2];
    const bx = P[d] - P[f], by = P[d + 1] - P[f + 1], bz = P[d + 2] - P[f + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const o = (i * (NU + 1) + j) * 3;
    if (nx * P[o] + ny * (P[o + 1] - 0.3) < 0) { nx = -nx; ny = -ny; nz = -nz; } // outward
    N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
  }
  for (let sx = -1; sx <= 1; sx += 2) {
    const base = b.nv;
    for (let i = 0; i <= NZ; i++) for (let j = 0; j <= NU; j++) {
      const o = (i * (NU + 1) + j) * 3;
      colAt(P[o + 1], P[o + 2]);
      b.vertex(sx * P[o], P[o + 1], P[o + 2], sx * N[o], N[o + 1], N[o + 2]);
    }
    for (let i = 0; i < NZ; i++) for (let j = 0; j < NU; j++) {
      const a = base + i * (NU + 1) + j;
      b.quad(a, a + 1, a + NU + 2, a + NU + 1);
    }
  }
}
// Closing face across the hull at z = z0 (transom / stem) up to y1, with a gate |x| < gate
// above y = 0 so the car can pass. half: half beam there.
function endFace(b, z0, hb, y1, keel, gate, nz) {
  const yk = keel * 0.6;
  for (let sx = -1; sx <= 1; sx += 2) {
    // below the deck: a trapezoid from the keel to the deck line
    const a = b.vertex(0, yk, z0, 0, 0, nz), c = b.vertex(sx * hb, 0, z0, 0, 0, nz), d = b.vertex(0, 0, z0, 0, 0, nz);
    b.tri(a, c, d);
    // above the deck: a post beside the gate
    if (hb > gate + 0.1) {
      const e0 = b.vertex(sx * gate, 0, z0, 0, 0, nz), e1 = b.vertex(sx * hb, 0, z0, 0, 0, nz);
      const e2 = b.vertex(sx * hb, y1, z0, 0, 0, nz), e3 = b.vertex(sx * gate, y1, z0, 0, 0, nz);
      b.quad(e0, e1, e2, e3);
    }
  }
}
// Deck planks (y = 0) over the hull, and the bulwarks' inner faces.
function deck(b, beam, half, sheer, zFrom, zTo, col) {
  const n = 16, NP = 14;
  for (let i = 0; i < n; i++) {
    const za = zFrom + (zTo - zFrom) * i / n, zb = zFrom + (zTo - zFrom) * (i + 1) / n;
    const ha = half(za / SHIP_HL) * beam - 0.12, hb = half(zb / SHIP_HL) * beam - 0.12;
    // planks along the ship, each a slightly different tone, with dark seams between
    for (let k = 0; k < NP; k++) {
      const u0 = -1 + 2 * k / NP, u1 = -1 + 2 * (k + 1) / NP - 0.012;
      const tone = 0.86 + 0.22 * ((k * 7 + 3) % 5) / 4;
      b.surface(SURF.WOOD).color(col[0] * tone, col[1] * tone, col[2] * tone);
      const a = b.vertex(u0 * ha, 0, za, 0, 1, 0), c = b.vertex(u1 * ha, 0, za, 0, 1, 0), d = b.vertex(u1 * hb, 0, zb, 0, 1, 0), e = b.vertex(u0 * hb, 0, zb, 0, 1, 0);
      b.quad(a, c, d, e);
    }
    b.color(col[0] * 0.25, col[1] * 0.22, col[2] * 0.2);
    {
      const a = b.vertex(-ha, -0.03, za, 0, 1, 0), c = b.vertex(ha, -0.03, za, 0, 1, 0), d = b.vertex(hb, -0.03, zb, 0, 1, 0), e = b.vertex(-hb, -0.03, zb, 0, 1, 0);
      b.quad(a, c, d, e);
    }
    b.color(col[0] * 0.62, col[1] * 0.5, col[2] * 0.42);
    for (let sx = -1; sx <= 1; sx += 2) {
      const ya = sheer(za / SHIP_HL) - 0.05, yb = sheer(zb / SHIP_HL) - 0.05;
      const p = b.vertex(sx * ha, 0, za, -sx, 0, 0), q = b.vertex(sx * hb, 0, zb, -sx, 0, 0);
      const r = b.vertex(sx * hb, yb, zb, -sx, 0, 0), t = b.vertex(sx * ha, ya, za, -sx, 0, 0);
      b.quad(p, q, r, t);
      // cap rail
      b.color(col[0] * 0.55, col[1] * 0.5, col[2] * 0.45);
      const u0 = b.vertex(sx * (ha - 0.05), ya + 0.08, za, 0, 1, 0), u1 = b.vertex(sx * (hb - 0.05), yb + 0.08, zb, 0, 1, 0);
      const u2 = b.vertex(sx * (hb + 0.2), yb + 0.08, zb, 0, 1, 0), u3 = b.vertex(sx * (ha + 0.2), ya + 0.08, za, 0, 1, 0);
      b.quad(u0, u1, u2, u3);
      b.color(col[0] * 0.62, col[1] * 0.5, col[2] * 0.42);
    }
  }
}
// A billowing sail: a grid from the yard (top) down, bellied toward +z. colAt(u, v) sets the
// colour (u across 0..1, v down 0..1).
function sail(b, x0, x1, yTop, yBot, z, belly, colAt, cross) {
  const NX = 16, NY = 14;
  // A point on the sail at (u, v), pushed `off` metres along its front normal (approximately).
  const at = (u, v, off, side) => {
    const x = x0 + (x1 - x0) * u, y = yTop + (yBot - yTop) * v;
    const bz = belly * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.85 * v));
    const dz = belly * Math.PI * Math.cos(Math.PI * u) / Math.abs(x1 - x0);
    return b.vertex(x - dz * off * side, y, z + bz + off * side, -dz * side, 0.15 * side, side);
  };
  if (cross) {
    // the red cross pattee of the Order of Christ, both faces: arms that flare toward their ends
    b.color(0.58, 0.07, 0.04);
    for (let side = 1; side >= -1; side -= 2) for (let arm = 0; arm < 4; arm++) {
      const n = 6, base = b.nv;
      for (let k = 0; k <= n; k++) {
        const t = k / n, w = 0.035 + 0.075 * t * t; // half width (u units), flaring
        for (let e = -1; e <= 1; e += 2) {
          // arms: up, down (v), left, right (u) from the centre (0.5, 0.47); u spans 1.6x v
          const L = arm < 2 ? 0.33 : 0.28, d = t * L * (arm & 1 ? 1 : -1);
          const u = arm < 2 ? 0.5 + e * w * 0.62 : 0.5 + d, v = arm < 2 ? 0.47 + d : 0.47 + e * w;
          at(u, v, 0.04, side);
        }
      }
      for (let k = 0; k < n; k++) b.quad(base + k * 2, base + k * 2 + 1, base + k * 2 + 3, base + k * 2 + 2);
    }
  }
  for (let side = 1; side >= -1; side -= 2) { // front (toward the bow), then back
    const base = b.nv;
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const u = i / NX, v = j / NY;
      const x = x0 + (x1 - x0) * u, y = yTop + (yBot - yTop) * v;
      const bz = belly * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.85 * v));
      colAt(u, v);
      const dz = belly * Math.PI * Math.cos(Math.PI * u) / Math.abs(x1 - x0);
      b.vertex(x, y, z + bz, -dz * side, 0.15 * side, side);
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = base + j * (NX + 1) + i;
      b.quad(a, a + 1, a + NX + 2, a + NX + 1);
    }
  }
}
// A square sail braced round (yards angled to the hull, as on a reach): centred on the ship's
// centre line at z, turned by `brace` about the vertical.
function sailBraced(b, w, yTop, yBot, z, belly, brace, colAt, cross) {
  b.push().translate(0, 0, z).rotateY(brace);
  b.surface(SURF.WOOD).color(0.24, 0.15, 0.08);
  b.beam(-w - 0.4, yTop + 0.2, 0, w + 0.4, yTop + 0.2, 0, 0.13, 0.13, 6, true); // yard
  b.surface(SURF.HIDE);
  sail(b, -w, w, yTop, yBot, 0.25, belly, colAt, cross);
  b.pop();
}

// Carrack of the 1490s: high castles fore and aft (the lane runs under them through gates in
// the stem and transom), three masts to port with square courses and topsails on fore and
// main (the red cross on the main course), a lateen mizzen, shrouds, a pennant.
function buildCarrack(b) {
  b.vanish(0, 1, MOTION.FADE, 0, BY.DECAY); // gives way to the bridge
  const half = (t) => t > 0 ? Math.max(0.27, Math.pow(1 - Math.pow(t, 2.2), 0.5)) : 1 - 0.42 * Math.pow(-t, 3);
  const sheer = (t) => 1.05 + 0.75 * t * t + (t < 0 ? 0.6 * t * t : 0);
  const beam = 5.0;
  hull(b, beam, half, sheer, -3.2, (y) => {
    if (y < -1.9) b.surface(SURF.WOOD).color(0.08, 0.06, 0.05);
    else if (y > 0.25 && y < 0.6) b.surface(SURF.WOOD).color(0.55, 0.42, 0.22);
    else b.surface(SURF.WOOD).color(0.30, 0.16, 0.07);
  });
  b.surface(SURF.WOOD).color(0.22, 0.12, 0.06);
  endFace(b, -SHIP_HL, half(-1) * beam, sheer(-1), -3.2, LANE - 0.4, -1);
  endFace(b, SHIP_HL, half(1) * beam, sheer(1), -3.2, LANE - 0.4, 1);
  deck(b, beam, half, sheer, -SHIP_HL, SHIP_HL, [0.5, 0.36, 0.21]);
  // castles: a raised deck on each side of the lane (open between them, so nothing hangs
  // over the car or the chase camera), with planked walls, rails and dark gun ports
  const castle = (z0, z1, h, col) => {
    const zc = (z0 + z1) / 2, hz = (z1 - z0) / 2, hb = Math.min(half(z0 / SHIP_HL), half(z1 / SHIP_HL)) * beam;
    const inner = LANE - 0.5, w = (hb - inner) / 2;
    for (let sx = -1; sx <= 1; sx += 2) {
      const xc = sx * (inner + w);
      b.surface(SURF.WOOD).color(col[0], col[1], col[2]);
      b.box(xc, h / 2, zc, w + 0.2, h / 2, hz, false);
      b.color(col[0] * 1.25, col[1] * 1.15, col[2] * 1.05).box(xc, h + 0.1, zc, w + 0.3, 0.1, hz + 0.2);
      b.color(col[0] * 0.55, col[1] * 0.5, col[2] * 0.45);
      b.box(sx * (hb + 0.15), h + 0.6, zc, 0.1, 0.5, hz + 0.2, false);
      b.box(sx * (inner + 0.1), h + 0.6, zc, 0.1, 0.5, hz + 0.2, false);
      b.box(xc, h + 0.6, z0 - 0.1, w + 0.25, 0.5, 0.1, false);
      b.box(xc, h + 0.6, z1 + 0.1, w + 0.25, 0.5, 0.1, false);
      b.color(0.06, 0.04, 0.03);
      for (let k = 0; k < 2; k++) b.box(sx * (hb + 0.22), h * 0.55, z0 + hz * (0.6 + 0.8 * k), 0.04, 0.32, 0.4, false);
    }
  };
  castle(-SHIP_HL + 0.2, -9.5, 3.3, [0.42, 0.24, 0.11]);
  castle(10, SHIP_HL - 0.6, 2.7, [0.42, 0.24, 0.11]);
  // a gilded stern lantern and a warm lit stern window
  b.surface(SURF.GILT).color(0.8, 0.6, 0.25).beam(0, 4.0, -SHIP_HL - 0.2, 0, 5.0, -SHIP_HL - 0.4, 0.06, 0.06, 4, true);
  b.surface(SURF.PLAIN).color(1.0, 0.7, 0.35).emissive(0.25).box(0, 5.25, -SHIP_HL - 0.45, 0.22, 0.32, 0.22);
  b.emissive(0);
  // masts (to port), yards, sails
  const MX = 2.35;
  const cloth = [0.86, 0.80, 0.66];
  b.surface(SURF.WOOD).color(0.24, 0.15, 0.08);
  b.beam(MX, 0, 0.5, MX, 25, 0.5, 0.32, 0.15, 8, true); // main
  b.beam(MX, 2.7, 12.5, MX, 19, 12.5, 0.24, 0.12, 8, true); // fore
  b.beam(MX, 3.3, -12.8, MX, 15.5, -12.8, 0.2, 0.1, 8, true); // mizzen
  b.beam(MX - 0.2, 2.9, SHIP_HL - 1, MX - 0.4, 6.4, SHIP_HL + 5.5, 0.16, 0.08, 6, true); // bowsprit
  const plain = () => b.color(cloth[0], cloth[1], cloth[2]);
  const BR = 0.42; // yards braced round
  // main course with the cross of the Order of Christ
  sailBraced(b, 7.0, 18.4, 7.4, 1.0, 2.2, BR, plain, true);
  sailBraced(b, 4.0, 23.8, 19.0, 1.0, 1.1, BR, plain);
  sailBraced(b, 5.4, 15.4, 6.8, 13.0, 1.7, BR, plain);
  sailBraced(b, 2.8, 18.6, 15.9, 13.0, 0.7, BR, plain);
  // lateen mizzen: a long slanted yard and a triangle (in the ship's plane, bellied to port)
  b.surface(SURF.WOOD).color(0.24, 0.15, 0.08).beam(MX, 7.0, -7.0, MX, 17.5, -17.5, 0.09, 0.07, 6, true);
  b.surface(SURF.HIDE);
  b.push().translate(MX, 0, 0).rotateY(Math.PI / 2);
  // in this frame +x is the ship's -z: the sail spans from the fore end (yard foot) aft
  lateen(b, cloth);
  b.pop();
  // shrouds to the rails and stays fore and aft
  b.surface(SURF.PLAIN).color(0.1, 0.08, 0.06);
  const shroud = (mx, my, mz, n, dz) => {
    for (let sx = -1; sx <= 1; sx += 2) for (let k = 0; k < n; k++) {
      const z = mz + (k - (n - 1) / 2) * dz, hb = half(z / SHIP_HL) * beam + 0.15;
      b.beam(mx, my, mz, sx * hb, sheer(z / SHIP_HL) + 0.1, z, 0.035, 0.035, 3, false);
    }
  };
  shroud(MX, 17.5, 0.5, 4, 1.2); shroud(MX, 14.6, 12.5, 3, 1.0);
  b.beam(MX, 24.8, 0.5, MX, 18.8, 12.5, 0.04, 0.04, 3, false);
  b.beam(MX, 18.6, 12.5, MX - 0.4, 6.4, SHIP_HL + 5.4, 0.04, 0.04, 3, false);
  b.beam(MX, 24.5, 0.5, MX, 15.2, -12.8, 0.04, 0.04, 3, false);
  // pennant at the main top
  b.surface(SURF.HIDE).color(0.62, 0.08, 0.05);
  const p0 = b.vertex(MX, 25.2, 0.5, 1, 0, 0), p1 = b.vertex(MX, 24.6, 0.5, 1, 0, 0), p2 = b.vertex(MX + 0.2, 24.95, -5.5, 1, 0, 0);
  b.tri(p0, p1, p2);
  const q0 = b.vertex(MX, 25.2, 0.5, -1, 0, 0), q1 = b.vertex(MX, 24.6, 0.5, -1, 0, 0), q2 = b.vertex(MX + 0.2, 24.95, -5.5, -1, 0, 0);
  b.tri(q0, q2, q1);
}
function lateen(b, cloth) {
  // local frame: +x = ship aft, +z = ship port. Triangle: tack low forward, peak high aft
  // along the yard, clew at the deck aft.
  const base = b.nv, NX = 10, NY = 10;
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const u = i / NX, v = j / NY; // u along the yard (fore -> aft), v from the yard down
    const xa = -7.0 + 10.5 * u, ya = 7.0 + 10.5 * u; // yard line (x = ship -z)
    const xb = 3.2, yb = 4.0; // clew
    const x = xa + (xb - xa) * v * (1 - u * 0.2), y = ya + (yb - ya) * v;
    const bz = 1.1 * Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.1));
    b.color(cloth[0], cloth[1], cloth[2]);
    b.vertex(x, y, bz, 0, 0.1, 1);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = base + j * (NX + 1) + i; b.quad(a, a + 1, a + NX + 2, a + NX + 1); }
  const back = b.nv;
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const u = i / NX, v = j / NY;
    const xa = -7.0 + 10.5 * u, ya = 7.0 + 10.5 * u, x = xa + (3.2 - xa) * v * (1 - u * 0.2), y = ya + (4.0 - ya) * v;
    const bz = 1.1 * Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.1));
    b.vertex(x, y, bz, 0, -0.1, -1);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = back + j * (NX + 1) + i; b.quad(a, a + NX + 1, a + NX + 2, a + 1); }
}
// The wake (its own mesh, posed at the ship with yaw only, on the water): thin foam lines
// from the bows spreading astern and tapering away, a bow wave, twin lines from the stern;
// shown while under way (appear by built = the ship's speed share).
function buildWake(b) {
  b.appear(0.03, 0.12, MOTION.FADE, 0, BY.BUILT);
  b.surface(SURF.PLAIN);
  const y = 0.05; // above the visible water (the mesh is posed at the water level)
  const strip = (x0, z0, x1, z1, w0, w1, c0, c1) => {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), nx = -dz / l, nz = dx / l, n = 10, base = b.nv;
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = x0 + dx * t, z = z0 + dz * t, w = w0 + (w1 - w0) * t, c = c0 + (c1 - c0) * t;
      b.color(c * 0.92, c, c * 1.02);
      b.vertex(x - nx * w, y, z - nz * w, 0, 1, 0); b.vertex(x + nx * w, y, z + nz * w, 0, 1, 0);
    }
    for (let k = 0; k < n; k++) b.quad(base + k * 2, base + k * 2 + 1, base + k * 2 + 3, base + k * 2 + 2);
  };
  for (let sx = -1; sx <= 1; sx += 2) {
    strip(sx * 1.0, SHIP_HL + 0.6, sx * 5.3, 8, 0.25, 0.55, 0.72, 0.66); // bow wave
    strip(sx * 5.4, 6, sx * 15, -46, 0.5, 0.02, 0.66, 0.5);
    strip(sx * 1.4, -SHIP_HL - 0.5, sx * 3.2, -52, 0.45, 0.02, 0.62, 0.48);
  }
  b.noAppear();
}

// Paddle steamer of the 1800s: black iron hull with a red boot topping and a white sheer
// strake, paddle boxes, a white deckhouse to port carrying the wheelhouse and a tall buff
// funnel with a red band and black top (smoke), two light masts to port.
function buildSteamer(b) {
  b.vanish(0, 1, MOTION.FADE, 0, BY.DECAY);
  const half = (t) => t > 0 ? Math.max(0.27, Math.pow(1 - Math.pow(t, 2.6), 0.42)) : 1 - 0.3 * Math.pow(-t, 4);
  const sheer = (t) => 1.1 + 0.45 * t * t;
  const beam = 5.1;
  hull(b, beam, half, sheer, -3.0, (y) => {
    if (y < -1.72) b.surface(SURF.PLAIN).color(0.4, 0.07, 0.04);
    else if (y > 0.65) b.surface(SURF.PLASTER).color(0.72, 0.70, 0.64);
    else b.surface(SURF.PLAIN).color(0.05, 0.055, 0.065);
  });
  b.surface(SURF.PLAIN).color(0.05, 0.055, 0.065);
  endFace(b, -SHIP_HL, half(-1) * beam, sheer(-1), -3.0, LANE - 0.4, -1);
  endFace(b, SHIP_HL, half(1) * beam, sheer(1), -3.0, LANE - 0.4, 1);
  deck(b, beam, half, sheer, -SHIP_HL, SHIP_HL, [0.52, 0.42, 0.3]);
  // paddle boxes: half drums on both sides amidships, white with dark vanes painted on
  for (let sx = -1; sx <= 1; sx += 2) {
    const x0 = sx * (beam + 0.05), x1 = sx * (beam + 1.9);
    b.surface(SURF.PLASTER).color(0.74, 0.72, 0.66);
    b.beam(x0, -1.0, -1.5, x1, -1.0, -1.5, 3.5, 3.5, 20, true);
    b.surface(SURF.PLAIN).color(0.08, 0.08, 0.09);
    for (let k = 0; k < 7; k++) {
      const a = (k + 0.5) / 7 * Math.PI, cy = Math.sin(a), cz = Math.cos(a);
      b.beam(x1 + sx * 0.03, -1.0 + cy * 0.9, -1.5 + cz * 0.9, x1 + sx * 0.03, -1.0 + cy * 3.3, -1.5 + cz * 3.3, 0.09, 0.09, 3, false);
    }
    b.surface(SURF.GILT).color(0.75, 0.55, 0.2);
    b.beam(x1 + sx * 0.04, -1.0, -1.5, x1 + sx * 0.08, -1.0, -1.5, 0.6, 0.6, 12, true);
  }
  // deckhouse to port of the lane: saloon, wheelhouse on its roof, the tall buff funnel with a
  // red band and black top (smoke), boats on davits outboard
  const DX = 3.25;
  b.surface(SURF.PLASTER).color(0.76, 0.74, 0.68);
  b.box(DX + 0.15, 1.2, -1.5, 1.0, 1.2, 6.0);
  b.surface(SURF.PLAIN).color(0.06, 0.07, 0.09);
  for (let k = 0; k < 6; k++) b.box(DX - 0.87, 1.45, -6 + k * 1.8, 0.03, 0.32, 0.45, false);
  b.surface(SURF.WOOD).color(0.4, 0.28, 0.17).box(DX, 2.47, -1.5, 1.35, 0.07, 6.2);
  b.surface(SURF.PLASTER).color(0.78, 0.76, 0.7).box(DX, 3.45, 3.2, 1.1, 0.95, 1.0);
  b.surface(SURF.PLAIN).color(0.06, 0.07, 0.09).box(DX, 3.65, 4.22, 0.95, 0.35, 0.03, false);
  b.surface(SURF.WOOD).color(0.3, 0.2, 0.12).box(DX, 4.45, 3.2, 1.3, 0.08, 1.2);
  b.surface(SURF.PLAIN).color(0.72, 0.56, 0.32);
  b.beam(DX, 2.5, -2.6, DX, 11.8, -3.2, 0.95, 0.9, 18, false);
  b.color(0.52, 0.08, 0.05).beam(DX, 9.6, -3.05, DX, 10.6, -3.12, 0.93, 0.92, 18, false);
  b.color(0.05, 0.05, 0.055).beam(DX, 10.6, -3.12, DX, 12.7, -3.27, 0.92, 0.9, 18, false);
  b.color(0.03, 0.03, 0.03).beam(DX, 12.65, -3.27, DX, 12.7, -3.27, 0.78, 0.78, 18, true);
  b.smoke(DX, 12.9, -3.3, { count: 26, size: 1.4, rise: 40, density: 0.42, color: [0.24, 0.23, 0.24], src: FLICKER.NONE });
  b.surface(SURF.WOOD).color(0.55, 0.42, 0.28);
  b.box(DX + 0.4, 3.0, -7.4, 0.6, 0.35, 2.4); // a boat on the saloon roof
  // the funnel's stays to the rail
  b.surface(SURF.PLAIN).color(0.1, 0.09, 0.08);
  b.beam(DX, 11.5, -3.2, beam - 0.1, sheer(-0.2) + 0.1, -6.5, 0.03, 0.03, 3, false);
  b.beam(DX, 11.5, -3.2, beam - 0.1, sheer(0.1) + 0.1, 1.5, 0.03, 0.03, 3, false);
  // masts to port with a gaff each, stays
  const MX = 2.6;
  b.surface(SURF.WOOD).color(0.3, 0.2, 0.12);
  b.beam(MX, 1, 9.5, MX, 17, 9.0, 0.17, 0.09, 6, true);
  b.beam(MX, 1, -11, MX, 15, -11.4, 0.16, 0.09, 6, true);
  b.beam(MX, 7, 9.5, MX, 9.4, 4.0, 0.07, 0.06, 4, true);
  b.surface(SURF.HIDE).color(0.82, 0.78, 0.68);
  const g0 = b.vertex(MX + 0.05, 7.2, 9.3, 1, 0, 0), g1 = b.vertex(MX + 0.05, 9.2, 4.2, 1, 0, 0), g2 = b.vertex(MX + 0.05, 3.9, 4.4, 1, 0, 0), g3 = b.vertex(MX + 0.05, 3.9, 9.3, 1, 0, 0);
  b.quad(g0, g1, g2, g3);
  const h0 = b.vertex(MX - 0.05, 7.2, 9.3, -1, 0, 0), h1 = b.vertex(MX - 0.05, 9.2, 4.2, -1, 0, 0), h2 = b.vertex(MX - 0.05, 3.9, 4.4, -1, 0, 0), h3 = b.vertex(MX - 0.05, 3.9, 9.3, -1, 0, 0);
  b.quad(h0, h3, h2, h1);
  b.surface(SURF.PLAIN).color(0.1, 0.09, 0.08);
  b.beam(MX, 16.8, 9.0, 0, sheer(1) + 0.1, SHIP_HL - 0.3, 0.035, 0.035, 3, false);
  b.beam(MX, 16.8, 9.0, MX, 14.8, -11.4, 0.035, 0.035, 3, false);
  b.beam(MX, 14.8, -11.4, 0, sheer(-1) + 0.1, -SHIP_HL + 0.3, 0.035, 0.035, 3, false);
  // ensign astern and a lamp
  b.surface(SURF.HIDE).color(0.55, 0.08, 0.06);
  b.beam(-3.6, 1.2, -SHIP_HL + 0.4, -3.6, 4.6, -SHIP_HL + 0.2, 0.04, 0.04, 4, true);
  const f0 = b.vertex(-3.6, 4.5, -SHIP_HL + 0.2, 1, 0, 0), f1 = b.vertex(-3.6, 3.5, -SHIP_HL + 0.2, 1, 0, 0), f2 = b.vertex(-3.6, 3.4, -SHIP_HL - 1.6, 1, 0, 0), f3 = b.vertex(-3.6, 4.4, -SHIP_HL - 1.6, 1, 0, 0);
  b.quad(f0, f1, f2, f3);
  const k0 = b.vertex(-3.6, 4.5, -SHIP_HL + 0.2, -1, 0, 0), k1 = b.vertex(-3.6, 3.5, -SHIP_HL + 0.2, -1, 0, 0), k2 = b.vertex(-3.6, 3.4, -SHIP_HL - 1.6, -1, 0, 0), k3 = b.vertex(-3.6, 4.4, -SHIP_HL - 1.6, -1, 0, 0);
  b.quad(k0, k3, k2, k1);
}

// Cable-stayed bridge (crossing-local frame, see buildQuays): an arched deck between the
// quays, two inverted-Y pylons at a quarter of the span from each end with fans of stays,
// a dark roadway with white edge lines and a dashed centre line, kerbs, railings and lamps
// that light at dusk (decay = night). Built: the pylons rise (0-0.45), the deck grows out
// from them in both directions (0.35-0.9) with its stays, the lamps come last.
function buildBridge(b) {
  const deckY = (z) => QUAY_TOP + BRIDGE_H * 0.5 * (1 - Math.cos(2 * Math.PI * (z + HW) / W));
  const PZ = W * 0.27, TOPY = 54;
  const near = (z) => Math.min(Math.abs(z - PZ), Math.abs(z + PZ)) / (HW - PZ + 1);
  // pylons
  for (let pz = -1; pz <= 1; pz += 2) {
    const z = pz * PZ, dy = deckY(z);
    b.appear(0.0, 0.45, MOTION.CLIP, 0, BY.BUILT).pivot(0, -6, z).reach(TOPY + dy + 6);
    b.surface(SURF.PLASTER).color(0.68, 0.66, 0.61);
    for (let sx = -1; sx <= 1; sx += 2) {
      b.beam(sx * 10.5, -6, z, sx * 7.2, dy - 1.6, z, 1.5, 1.25, 8, true);
      b.beam(sx * 7.2, dy - 1.6, z, sx * 1.4, dy + TOPY - 14, z, 1.25, 0.95, 8, true);
    }
    b.beam(0, dy + TOPY - 14.5, z, 0, dy + TOPY, z, 1.25, 0.9, 8, true);
    b.box(0, dy - 2.4, z, 9.2, 0.9, 1.3); // cross beam under the deck
    b.color(0.2, 0.2, 0.2).box(0, -2.6, z, 12, 0.6, 2.4); // footing at the water line
  }
  // deck segments
  const n = 33;
  for (let k = 0; k < n; k++) {
    const za = -HW + W * k / n, zb = -HW + W * (k + 1) / n, zm = (za + zb) / 2;
    const thr = 0.35 + 0.5 * Math.min(1, near(zm));
    b.appear(thr, thr + 0.03, MOTION.POP, 0, BY.BUILT);
    const ya = deckY(za), yb = deckY(zb);
    // a slab from x0 to x1 whose top is t0 above the deck line, th thick
    const slab = (x0, x1, t0, th, col, kind) => {
      b.surface(kind).color(col[0], col[1], col[2]);
      const P = HEX;
      for (let i = 0; i < 8; i++) {
        const k = i & 3, x = k === 1 || k === 2 ? x1 : x0, far = k >= 2, top = i >= 4;
        P[i * 3] = x; P[i * 3 + 1] = (far ? yb : ya) + t0 - (top ? 0 : th); P[i * 3 + 2] = far ? zb : za;
      }
      b.hexa(P, true);
    };
    slab(-5.8, 5.8, 0, 1.6, [0.075, 0.075, 0.08], SURF.STONE); // roadway on the girder
    slab(-6.6, -5.8, 0.18, 1.78, [0.6, 0.59, 0.56], SURF.STONE); // kerbs / walkways
    slab(5.8, 6.6, 0.18, 1.78, [0.6, 0.59, 0.56], SURF.STONE);
    b.surface(SURF.STONE).color(0.5, 0.49, 0.46);
    slab(-4.2, 4.2, -1.6, 0.9, [0.5, 0.49, 0.46], SURF.STONE); // box girder below
    // markings: edge lines and a dashed centre line, 2 cm above the roadway
    b.surface(SURF.PLAIN).color(0.78, 0.77, 0.72);
    for (let sx = -1; sx <= 1; sx += 2) line(b, sx * 5.35, za, zb, ya, yb, 0.12);
    if (k % 2 === 0) { b.color(0.85, 0.7, 0.25); line(b, 0, za + 1, zb - 1, ya + (yb - ya) * 0.1, yb - (yb - ya) * 0.1, 0.1); }
    // railings (posts + two rails)
    b.surface(SURF.PLAIN).color(0.34, 0.37, 0.4);
    for (let sx = -1; sx <= 1; sx += 2) {
      b.beam(sx * 6.45, ya + 0.18, za, sx * 6.45, ya + 1.25, za, 0.05, 0.05, 4, false);
      b.beam(sx * 6.45, ya + 1.2, za, sx * 6.45, yb + 1.2, zb, 0.06, 0.06, 4, false);
      b.beam(sx * 6.45, ya + 0.7, za, sx * 6.45, yb + 0.7, zb, 0.04, 0.04, 4, false);
    }
    // stays from this segment's middle to its pylon (not over the pylons themselves)
    const pz = zm > 0 ? PZ : -PZ, d = Math.abs(zm - pz);
    if (d > 9 && d < PZ + 4 && k % 1 === 0) {
      const ym = deckY(zm), f = Math.min(1, d / 80), ty = deckY(pz) + TOPY - 13 + 11 * (1 - f);
      b.surface(SURF.PLAIN).color(0.86, 0.86, 0.83);
      for (let sx = -1; sx <= 1; sx += 2) b.beam(sx * 6.0, ym + 0.2, zm, sx * 0.9, ty, pz + Math.sign(zm - pz) * 0.6, 0.07, 0.07, 3, false);
    }
    // lamps every third segment, alternating sides: post, arm over the road, head, bulb
    if (k % 3 === 1) {
      const sx = (k % 6 === 1) ? 1 : -1, ym = deckY(zm);
      b.appear(0.9, 0.95, MOTION.POP, 0, BY.BUILT);
      b.surface(SURF.PLAIN).color(0.2, 0.22, 0.24);
      b.beam(sx * 6.2, ym + 0.2, zm, sx * 6.2, ym + 8.6, zm, 0.11, 0.07, 6, true);
      b.beam(sx * 6.2, ym + 8.6, zm, sx * 4.6, ym + 9.0, zm, 0.06, 0.05, 4, true);
      b.box(sx * 4.3, ym + 8.95, zm, 0.45, 0.1, 0.2);
      b.appear(0.25, 0.5, MOTION.POP, 0, BY.DECAY);
      b.color(1.0, 0.72, 0.4).emissive(0.6);
      b.box(sx * 4.3, ym + 8.8, zm, 0.36, 0.05, 0.14, false);
      b.emissive(0);
    }
  }
  b.noAppear();
}
const HEX = new Float64Array(24);
function line(b, x, za, zb, ya, yb, w) {
  const a = b.vertex(x - w, ya + 0.02, za, 0, 1, 0), c = b.vertex(x + w, ya + 0.02, za, 0, 1, 0);
  const d = b.vertex(x + w, yb + 0.02, zb, 0, 1, 0), e = b.vertex(x - w, yb + 0.02, zb, 0, 1, 0);
  b.quad(a, c, d, e);
}

// The flooded land bridge's marker at the end of the road: a cairn and a tall pole with a
// crossbar and a weathered rag, "no way over" (from LAND_BRIDGE_CLOCK until 1492).
function buildMarker(b) {
  b.surface(SURF.ROCK).snow(0.15).color(0.36, 0.36, 0.38);
  b.push().translate(0, 0.3, 0); b.rock(1.1, 0.55, 1.0, 4, 0.2, 3); b.pop();
  b.push().translate(0.1, 0.95, -0.05); b.rock(0.8, 0.45, 0.75, 4, 0.2, 5); b.pop();
  b.push().translate(-0.05, 1.45, 0.05); b.rock(0.55, 0.32, 0.5, 4, 0.2, 9); b.pop();
  b.surface(SURF.WOOD).color(0.2, 0.14, 0.09);
  b.beam(0, 1.2, 0, 0.1, 5.4, 0, 0.09, 0.07, 6, true);
  b.beam(-0.8, 4.6, 0, 0.9, 4.75, 0, 0.05, 0.05, 4, true);
  b.surface(SURF.HIDE).color(0.45, 0.1, 0.06);
  const a = b.vertex(0.08, 5.3, 0, 0, 0, 1), c = b.vertex(0.08, 4.5, 0, 0, 0, 1), d = b.vertex(1.4, 4.75, 0.3, 0, 0, 1);
  b.tri(a, c, d);
  const a2 = b.vertex(0.08, 5.3, 0, 0, 0, -1), c2 = b.vertex(0.08, 4.5, 0, 0, 0, -1), d2 = b.vertex(1.4, 4.75, 0.3, 0, 0, -1);
  b.tri(a2, d2, c2);
}

// ------------------------------------------------------------------ per frame
const V = new Int16Array(2); // [0] crossing shown (edge, -1), [1] marker edge
const MK = new Float64Array(4); // marker: x, y, z, edge version
const GI = new Float64Array(8);
export function updateCrossing() {
  // The crossing to show: the car's, else the nearest live one (by its water centre).
  const cx = pose[0], cz = pose[2];
  let best = -1, bd = 2600 * 2600;
  if (car.track >= 0 && edgeFerry[car.track] && edgeAlive[car.track]) best = car.track;
  else {
    for (let e = 0; e < MAX_EDGES; e++) {
      if (!edgeAlive[e] || !edgeFerry[e] || edgePresence[e] <= 0.02) continue;
      Q[4] = edgeQuayS[e] + HW; pointAt(e, Q);
      const dx = Q[0] - cx, dz = Q[2] - cz, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = e; }
    }
  }
  V[0] = best;
  if (best >= 0) placeCrossing(best, cx, cz); else if (H) { H.quays.visible = false; H.carrack.visible = false; H.steamer.visible = false; H.bridge.visible = false; H.wake.visible = false; }
  updateMarker(cx, cz);
}

function placeCrossing(e, cx, cz) {
  const qa = edgeQuayS[e];
  Q[4] = qa; pointAt(e, Q);
  const h = Q[3], c = Math.cos(h), s = Math.sin(h), x0 = Q[0], z0 = Q[2], yq = edgeQuayY[e];
  const mx = x0 + c * HW, mz = z0 + s * HW;
  // Strait water: unless a causeway (sites.js, written just before) is nearer.
  let mine = true;
  if (siteData[20] > 0) {
    const ax = siteData[16] - cx, az = siteData[17] - cz, bx = mx - cx, bz = mz - cz;
    if (ax * ax + az * az < bx * bx + bz * bz) mine = false;
  }
  if (mine) {
    siteData[16] = mx; siteData[17] = mz; siteData[18] = c; siteData[19] = s;
    siteData[20] = HW + 6; siteData[21] = yq - WATER_DROP; siteData[22] = 1;
    siteData[23] = (edgeVersion[e] & 1) ? 1 : -1;
  }
  if (!H) return;
  const yaw = Math.PI / 2 - h, vis = edgePresence[e] > 0.02;
  H.quays.visible = vis; H.quays.setPose(mx, yq, mz, yaw);
  // ship
  const steam = clockOf(e, qa) >= STEAM_CLOCK;
  const sh = steam ? H.steamer : H.carrack, other = steam ? H.carrack : H.steamer;
  other.visible = false;
  const fade = edgeFerry[e] === 2 ? ss(state.clock - BRIDGE_CLOCK) : 0;
  sh.visible = vis && fade < 1;
  if (sh.visible) {
    const sc = shipAt(e), a = sc - qa;
    const onIt = car.track === e && FH[0] === 2;
    const under = onIt && car.s > qa + SHIP_HL + 1 ? Math.min(1, car.v / VS) : 0;
    motion(under);
    sh.setState(under, fade);
    sh.setPose(x0 + c * a, yq + M[0], z0 + s * a, yaw, M[1], M[2]);
    H.wake.setState(under, fade);
    H.wake.setPose(x0 + c * a, yq - WATER_DROP - 0.6, z0 + s * a, yaw);
  }
  H.wake.visible = sh.visible;
  // bridge
  const built = bridgeBuilt(e);
  H.bridge.visible = vis && built > 0;
  if (H.bridge.visible) {
    const night = Math.max(LAMPS, ss((0.14 - env.sunElevation) / 0.16));
    H.bridge.setState(Math.min(1, built), night * (built >= 1 ? 1 : 0));
    H.bridge.setPose(mx, yq, mz, yaw);
  }
}

// The closed land bridge (from its flooding until ships sail): a marker where its road ends.
function updateMarker(cx, cz) {
  if (!H) return;
  let best = -1, bd = 2000 * 2000;
  if (state.clock < 171.3) {
    for (let n = 0; n < MAX_NODES; n++) {
      const bi = nodeBridge[n];
      if (!nodeAlive[n] || bi < 0 || exitAvailable(n, bi)) continue;
      const e = nodeExit(n, bi);
      if (e < 0 || !edgeAlive[e] || edgePresence[e] <= 0.02 || edgeDrawEnd[e] > 1e8) continue;
      Q[4] = edgeDrawEnd[e]; pointAt(e, Q);
      const dx = Q[0] - cx, dz = Q[2] - cz, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = e; }
    }
  }
  H.marker.visible = best >= 0;
  if (best < 0) return;
  if (V[1] !== best || MK[3] !== edgeVersion[best] + edgeDrawEnd[best]) {
    V[1] = best; MK[3] = edgeVersion[best] + edgeDrawEnd[best];
    Q[4] = edgeDrawEnd[best] + DRAW_END_PAD - 22; Q[5] = 6.5;
    frameAtQ(best);
    GI[6] = Q[0]; GI[7] = Q[2]; groundInfo(GI);
    MK[0] = Q[0]; MK[1] = GI[0] - 0.2; MK[2] = Q[2];
    H.marker.setPose(MK[0], MK[1], MK[2], Math.PI / 2 - Q[3]);
  }
}
function frameAtQ(e) { // pointAt + lateral offset Q[5] to the right
  const lat = Q[5]; pointAt(e, Q);
  Q[0] += -Math.sin(Q[3]) * lat; Q[2] += Math.cos(Q[3]) * lat;
}

// Tests / debug (allocates).
export function crossingInfo() {
  const list = [];
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!edgeAlive[e] || !edgeFerry[e]) continue;
    list.push({ edge: e, kind: edgeFerry[e], quayS: Math.round(edgeQuayS[e]), len: Math.round(edgeLen[e]), quayY: +edgeQuayY[e].toFixed(2), quayClock: +clockOf(e, edgeQuayS[e]).toFixed(1), ship: shipMode(e), built: +bridgeBuilt(e).toFixed(2), shipS: +shipAt(e).toFixed(1), presence: +edgePresence[e].toFixed(2) });
  }
  return { list, shown: V[0], hold: FH[0], holdV: +FH[1].toFixed(1), active: DK[0], deckY: +DK[10].toFixed(2), marker: H ? H.marker.visible : false, markerPos: H && H.marker.visible ? [Math.round(MK[0]), +MK[1].toFixed(1), Math.round(MK[2])] : null, ships: H ? { carrack: H.carrack.visible, steamer: H.steamer.visible, bridge: H.bridge.visible } : null };
}
