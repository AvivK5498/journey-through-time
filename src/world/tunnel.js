// Passages through the ridges between biomes (round three: "tunnels between biomes that serve
// as artificial loading screens").
//
// graph.js plans one passage on every road that changes biome (planTunnels: where the road is
// clearest of the other roads, straightened and levelled over it). world.js raises the ridge on
// the territory boundary, a saddle and a plateau over the passage with cliff faces at the
// portals, and cuts the plateau to the road between near-vertical walls (the slot, open while the
// camera is within ~900 m). This module:
//   - keeps tunData (world.js) filled every frame with the passages nearest the camera, so the
//     GPU's ground() and the JS mirror see the same passages, slot openings and weights;
//   - builds each passage's mesh with the landmark kit (styled to the era of the moment the car
//     reaches it, like the road surface): the vault in the slot, the rock above it level with the
//     plateau, and the two portals:
//       eras 0-1  a natural rock cave narrowing from ragged mouths, a slit of sky in its roof;
//                 era 1 adds two torches at each mouth
//       eras 2-3  a rock-cut passage with dressed-stone portals (voussoirs, keystone, cornice),
//                 masonry ribs and oil lamps in niches
//       eras 4-5  a brick vault with stone-dressed portals (pilasters, cornice, parapet, date
//                 stone) and gas lamps on brackets
//       era 6     a concrete tube with a projecting portal hood, continuous strip lights and
//                 reflective edge markers
//     Built under a per-frame time budget as soon as the passage is planned (1-2 forks ahead).
//   - keeps the car inside a passage (tunnelClamp, car.js) and the chase camera inside it
//     (tunnelCam).
//
//   initTunnels()         once, after initLandmarkKit()
//   updateTunnels(budget) every frame after the camera, before updateWorld()
//   tunnelClamp(cur)      car.js after integrating a sim step (cur: x 0, z 2, heading 3)
//   tunnelCam(cur)        car.js after the chase camera step (cur 12..14)
//   tunnelInfo()          tests / debug (allocates)

import { LandmarkBuilder, beginBuild, uploadLandmark, SURF, FLICKER, noise3 } from './landmarks/kit.js';
import { BIOMES } from './biomes.js';
import {
  MAX_EDGES, edgeAlive, edgeVersion, edgeTunS, edgeTunH, edgeRegion, edgeParentRegion, edgeJ0, edgeLen, edgeTunClear,
  pointAt, frameAt, nearestRoad, onTunnelPlanned, clockBase, graph, edgeSeam, edgeSplit, edgePresence, edgeBio,
} from './graph.js';
import { tunData, MAX_TUN, bioSnap, groundInfo, SLOT_HW, SLOT_WALL, RIDGE, tunAtJS, TZO, ridgeJS, RGO, labelAtJS, LIO } from './world.js';
import { eraAt } from './time.js';
import { camera } from '../camera.js';
import { state } from '../state.js';
import { car } from '../car.js'; // runtime use only (the import cycle is safe)

// Per edge slot: stage 0 none, 1 planned (waiting to build), 2 building, 3 live.
const tStage = new Uint8Array(MAX_EDGES);
const tVer = new Uint32Array(MAX_EDGES);
const tStyle = new Int8Array(MAX_EDGES);
const tF = new Float64Array(MAX_EDGES * 8); // centre x, z, direction x, z, road y, half length, parent, own
const tH = new Array(MAX_EDGES).fill(null);
const tTop = new Float64Array(MAX_EDGES * 2); // rock height over each portal (debug)
let bE = -1, bIt = null;
const STAT = new Float64Array(4); // builds, max build ms in a frame, total build ms, destroyed
const Q = new Float64Array(8);
const G = new Float64Array(8);
const T0 = new Float64Array(1);
const SLOT_OPEN0 = 750, SLOT_OPEN1 = 950; // the slot is open within this camera distance

// Vault inner half width per style (the car's walls are 1.1 m inside it).
function wallX(st) { return st <= 1 ? 6.0 : st <= 5 ? 5.6 : 5.8; }

function planned(e) {
  if (edgeTunS[e] < 0) return;
  const s = edgeTunS[e], lh = edgeTunH[e];
  Q[4] = s; pointAt(e, Q);
  const o = e * 8;
  tF[o] = Q[0]; tF[o + 1] = Q[2]; tF[o + 2] = Math.cos(Q[3]); tF[o + 3] = Math.sin(Q[3]);
  tF[o + 4] = Q[1]; tF[o + 5] = lh; tF[o + 6] = edgeParentRegion[e]; tF[o + 7] = edgeRegion[e];
  const clk = clockBase[0] + (edgeJ0[e] + s - lh - clockBase[1]) / 40;
  tStyle[e] = eraAt(clk);
  if (tH[e]) { tH[e].destroy(); tH[e] = null; }
  if (bE === e) { bE = -1; bIt = null; }
  tStage[e] = 1; tVer[e] = edgeVersion[e];
}

export function initTunnels() {
  onTunnelPlanned(planned);
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e] && edgeTunS[e] >= 0 && !tStage[e]) planned(e);
}

function drop(e) {
  if (tH[e]) { tH[e].destroy(); tH[e] = null; STAT[3]++; }
  if (bE === e) { bE = -1; bIt = null; }
  tStage[e] = 0;
}

// ------------------------------------------------------------------------------ per frame

const CAND = new Int16Array(MAX_EDGES), CD = new Float64Array(MAX_EDGES);
export function updateTunnels(budget) {
  // Slots whose road is gone or rebuilt (a new world, an evicted road).
  for (let e = 0; e < MAX_EDGES; e++) {
    if (tStage[e] && (!edgeAlive[e] || edgeVersion[e] !== tVer[e] || edgeTunS[e] < 0)) drop(e);
    else if (!tStage[e] && edgeAlive[e] && edgeTunS[e] >= 0) planned(e);
  }
  const ex = camera.eye[0], ez = camera.eye[2];
  // Passages for the GPU / mirror: the nearest MAX_TUN with any biome presence in the label map.
  let n = 0;
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!tStage[e] || bioSnap[e * 8] <= 0) continue;
    const dx = tF[e * 8] - ex, dz = tF[e * 8 + 1] - ez;
    CAND[n] = e; CD[n] = dx * dx + dz * dz; n++;
  }
  for (let a = 1; a < n; a++) { // insertion sort (n is small)
    const e = CAND[a], d = CD[a];
    let b = a - 1;
    while (b >= 0 && CD[b] > d) { CAND[b + 1] = CAND[b]; CD[b + 1] = CD[b]; b--; }
    CAND[b + 1] = e; CD[b + 1] = d;
  }
  for (let i = 0; i < MAX_TUN; i++) {
    const t = i * 12;
    if (i >= n) { tunData[t + 10] = 0; tunData[t + 11] = -1; continue; }
    const e = CAND[i], o = e * 8;
    for (let k = 0; k < 8; k++) tunData[t + k] = tF[o + k];
    const d = Math.sqrt(CD[i]);
    let k = (d - SLOT_OPEN0) / (SLOT_OPEN1 - SLOT_OPEN0); k = k < 0 ? 0 : k > 1 ? 1 : k;
    tunData[t + 8] = 1 - k * k * (3 - 2 * k);
    tunData[t + 9] = tStyle[e] + 8 * Math.min(250, Math.floor(edgeTunClear[e]));
    tunData[t + 10] = bioSnap[e * 8];
    tunData[t + 11] = e;
  }
  // Builds: continue the current one, else start the nearest planned passage.
  const all = state.pose >= 0 || state.capture || budget === Infinity;
  let work = bE >= 0;
  for (let e = 0; e < MAX_EDGES && !work; e++) if (tStage[e] === 1) work = true;
  if (!work) return;
  T0[0] = performance.now();
  for (let guard = 0; guard < 64; guard++) {
    if (bE < 0) {
      let bi = -1, bd = 1e30;
      for (let e = 0; e < MAX_EDGES; e++) {
        if (tStage[e] !== 1) continue;
        const dx = tF[e * 8] - ex, dz = tF[e * 8 + 1] - ez, d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; bi = e; }
      }
      if (bi < 0) break;
      startBuild(bi);
    }
    if (bIt) {
      while (all || performance.now() - T0[0] < budget) { if (bIt.next().done) { bIt = null; break; } }
      if (bIt) break;
    }
    finishBuild();
    if (!all && performance.now() - T0[0] >= budget) break;
  }
  const ms = performance.now() - T0[0];
  STAT[2] += ms; if (ms > STAT[1]) STAT[1] = ms;
}

// ------------------------------------------------------------------------------ mesh build

let B = null;
const DEF = {
  id: 'tunnel', name: 'Passage', caption: '', year: 0, radius: 160, pad: 0, straddlesRoad: true,
  lights: [{ pos: [0, 3, 0], color: [1, 0.62, 0.3], intensity: 0, range: 18, flicker: 0.5 }, { pos: [0, 3, 0], color: [1, 0.62, 0.3], intensity: 0, range: 18, flicker: 0.5 }],
  build: null,
};
// Build parameters (set by startBuild, read by the generator).
const P = { e: -1, st: 0, lh: 80, y0: 0, cx: 0, cz: 0, dx: 1, dz: 0, lp: 0, lo: 0, seed: 1 };
// Rock height above the road at local (x, z) (uncut ground through the JS mirror with this
// passage forced in a spare slot, closed): TOP[] per sample column.
const NZT = 64;
const TOPZ = new Float64Array(NZT), TOPL = new Float64Array(NZT), TOPC = new Float64Array(NZT), TOPR = new Float64Array(NZT);
let nTop = 0;
const SAVE = new Float64Array(12);
function sampleTops() {
  const s = (MAX_TUN - 1) * 12;
  for (let i = 0; i < 12; i++) SAVE[i] = tunData[s + i];
  tunData[s] = P.cx; tunData[s + 1] = P.cz; tunData[s + 2] = P.dx; tunData[s + 3] = P.dz;
  tunData[s + 4] = P.y0; tunData[s + 5] = P.lh; tunData[s + 6] = P.lp; tunData[s + 7] = P.lo;
  tunData[s + 8] = 0; tunData[s + 9] = P.st + 8 * Math.min(250, Math.floor(edgeTunClear[P.e])); tunData[s + 10] = 1; tunData[s + 11] = P.e;
  nTop = Math.min(NZT, Math.ceil(P.lh * 2 / 6) + 1);
  for (let i = 0; i < nTop; i++) {
    const z = -P.lh + (2 * P.lh) * i / (nTop - 1);
    TOPZ[i] = z;
    for (let c = 0; c < 3; c++) {
      const x = c === 0 ? 8.8 : c === 1 ? 0 : -8.8; // local +x is the left of the road
      // local -> world: along (dx, dz), left = (dz, -dx)
      G[6] = P.cx + P.dx * z + P.dz * x; G[7] = P.cz + P.dz * z - P.dx * x;
      groundInfo(G);
      const h = G[0] - P.y0 + 0.45;
      if (c === 0) TOPL[i] = h; else if (c === 1) TOPC[i] = h; else TOPR[i] = h;
    }
  }
  for (let i = 0; i < 12; i++) tunData[s + i] = SAVE[i];
}
function topAt(x, z) { // interpolated rock height (local)
  let f = (z + P.lh) / (2 * P.lh) * (nTop - 1);
  f = f < 0 ? 0 : f > nTop - 1 ? nTop - 1 : f;
  const i = Math.min(nTop - 2, Math.floor(f)), t = f - i;
  const l = TOPL[i] + (TOPL[i + 1] - TOPL[i]) * t, c = TOPC[i] + (TOPC[i + 1] - TOPC[i]) * t, r = TOPR[i] + (TOPR[i + 1] - TOPR[i]) * t;
  const u = x / 8.8; // +1 left, -1 right
  return u >= 0 ? c + (l - c) * Math.min(1, u) : c + (r - c) * Math.min(1, -u);
}

function startBuild(e) {
  if (!B) B = new LandmarkBuilder(60000, 90000);
  const o = e * 8;
  P.e = e; P.st = tStyle[e]; P.cx = tF[o]; P.cz = tF[o + 1]; P.dx = tF[o + 2]; P.dz = tF[o + 3];
  P.y0 = tF[o + 4]; P.lh = tF[o + 5]; P.lp = tF[o + 6]; P.lo = tF[o + 7];
  P.seed = (Math.imul(graph.seed | 0, 0x9e3779b1) ^ Math.imul(e + 3, 0x85ebca6b) ^ Math.imul(edgeVersion[e], 0xc2b2ae35)) >>> 0;
  sampleTops();
  DEF.radius = P.lh + 40;
  DEF.build = buildPassage;
  tStage[e] = 2; bE = e;
  bIt = beginBuild(DEF, B, 1, 0, P.seed & 0x7fffffff, P.lo);
}
function finishBuild() {
  const e = bE;
  bE = -1; bIt = null;
  if (e < 0 || tStage[e] !== 2) return;
  // local +z along the road: world (sin yaw, cos yaw) = (dx, dz)
  const yaw = Math.atan2(P.dx, P.dz);
  tH[e] = uploadLandmark(DEF, B, P.cx, P.y0, P.cz, yaw);
  tH[e].setState(1, 0);
  tTop[e * 2] = TOPC[0]; tTop[e * 2 + 1] = TOPC[nTop - 1];
  tStage[e] = 3;
  STAT[0]++;
}

// ---- colours
function mixc(a, b, t, k = 1) { return [(a[0] + (b[0] - a[0]) * t) * k, (a[1] + (b[1] - a[1]) * t) * k, (a[2] + (b[2] - a[2]) * t) * k]; }
// Rock of the territory at local z (parent before the middle, own after).
function rockAt(z) { const t = Math.min(1, Math.max(0, z / 40 + 0.5)); return mixc(BIOMES[P.lp].rock, BIOMES[P.lo].rock, t); }
function snowAt(z) { const r = z < 0 ? P.lp : P.lo; return r === 1 ? 0.75 : r === 5 ? 0.35 : 0; }
function smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

// Inner section of the vault: NPF points from the right foot (local x < 0) over the crown to the
// left foot. PX / PY (and inward normals NX / NY) for style st at local z.
const NPF = 25;
const PX = new Float64Array(NPF), PY = new Float64Array(NPF), NXp = new Float64Array(NPF), NYp = new Float64Array(NPF);
function section(st, z, flare) {
  const W0 = wallX(st);
  for (let i = 0; i < NPF; i++) {
    const u = i / (NPF - 1); // 0 right foot .. 1 left foot
    let x, y;
    if (st <= 1) {
      // natural cave: a rough low ellipse, ragged and wider at the mouths
      const th = -0.06 + u * (Math.PI + 0.12);
      const rx = 6.6 * flare, ry = 8.2 * (0.92 + 0.12 * flare);
      x = -Math.cos(th) * rx; y = Math.sin(th) * ry;
      const n = noise3(x * 0.22 + 3.1, y * 0.22, z * 0.11) - 0.5 + 0.5 * (noise3(x * 0.6, y * 0.6 + 7, z * 0.35) - 0.5);
      const k = 1 + 0.32 * n * (0.6 + 0.4 * flare);
      x *= k; y *= k;
      // keep the road and the car's walls clear
      if (y < 5.8 && Math.abs(x) < W0) x = Math.sign(x || 1) * W0;
      if (Math.abs(x) < 4.2 && y < 6.6) y = 6.6;
    } else if (st <= 3) {
      // vertical walls to 4.0 m, a segmental arch (centre y 2.0, r 5.97) to ~8 m
      const a = u < 0.18 ? 0 : u > 0.82 ? 1 : (u - 0.18) / 0.64;
      if (u < 0.18) { x = -W0; y = -0.35 + (u / 0.18) * 4.42; }
      else if (u > 0.82) { x = W0; y = -0.35 + ((1 - u) / 0.18) * 4.42; }
      else { const th = 0.355 + a * (Math.PI - 0.71); x = -Math.cos(th) * 5.97; y = 2.0 + Math.sin(th) * 5.97; }
      x *= flare; y = y * (0.9 + 0.1 * flare);
    } else if (st <= 5) {
      // brick: walls to 3.6 m, a semi-ellipse (5.6 x 3.8)
      if (u < 0.18) { x = -W0; y = -0.35 + (u / 0.18) * 3.95; }
      else if (u > 0.82) { x = W0; y = -0.35 + ((1 - u) / 0.18) * 3.95; }
      else { const th = (u - 0.18) / 0.64 * Math.PI; x = -Math.cos(th) * W0; y = 3.6 + Math.sin(th) * 3.8; }
      x *= flare;
    } else {
      // concrete: walls to 4.6 m, a shallow arch (centre y -2.0, r 8.79)
      if (u < 0.18) { x = -W0; y = -0.35 + (u / 0.18) * 4.95; }
      else if (u > 0.82) { x = W0; y = -0.35 + ((1 - u) / 0.18) * 4.95; }
      else { const th = 0.851 + (u - 0.18) / 0.64 * (Math.PI - 1.702); x = -Math.cos(th) * 8.79; y = -2.0 + Math.sin(th) * 8.79; }
      x *= flare;
    }
    // everything stays inside the slot the terrain leaves (its walls would hide it)
    const xm = SLOT_HW - 0.25;
    if (x > xm) x = xm; else if (x < -xm) x = -xm;
    PX[i] = x; PY[i] = y;
  }
  for (let i = 0; i < NPF; i++) {
    const a = i > 0 ? i - 1 : i, b = i < NPF - 1 ? i + 1 : i;
    const tx = PX[b] - PX[a], ty = PY[b] - PY[a], l = Math.hypot(tx, ty) || 1;
    // the curve runs right -> over -> left: the inward normal is the tangent turned right
    NXp[i] = ty / l; NYp[i] = -tx / l;
  }
}
function archTop(st, x) { // the opening's top at local x (portal faces), -1 outside the opening
  const W0 = wallX(st);
  if (Math.abs(x) >= W0) return -1;
  if (st <= 1) return -1; // the cave mouth is built from its own section
  if (st <= 3) return 2.0 + Math.sqrt(Math.max(0, 5.97 * 5.97 - x * x));
  if (st <= 5) return 3.6 + 3.8 * Math.sqrt(Math.max(0, 1 - (x / W0) * (x / W0)));
  return -2.0 + Math.sqrt(Math.max(0, 8.79 * 8.79 - x * x));
}

// Lamps (local x, y, z, kind) for the baked light pools and the fittings.
const LMAX = 40;
const LX = new Float64Array(LMAX), LY = new Float64Array(LMAX), LZ = new Float64Array(LMAX);
let nL = 0;
function lampsFor(st, lh) {
  nL = 0;
  if (st === 0) return;
  if (st === 1) { // two torches at each mouth
    for (let s = -1; s <= 1; s += 2) for (let side = -1; side <= 1; side += 2) { if (nL < LMAX) { LX[nL] = side * 5.0; LY[nL] = 3.0; LZ[nL] = s * (lh - 7); nL++; } }
    return;
  }
  const sp = st <= 3 ? 24 : st <= 5 ? 18 : 14;
  let side = 1;
  for (let z = -lh + sp * 0.5; z < lh - 2 && nL < LMAX; z += sp) {
    if (st >= 6) { LX[nL] = 2.6; LY[nL] = 6.2; LZ[nL] = z; nL++; if (nL < LMAX) { LX[nL] = -2.6; LY[nL] = 6.2; LZ[nL] = z; nL++; } }
    else { LX[nL] = side * (wallX(st) - 0.35); LY[nL] = st <= 3 ? 2.6 : 3.4; LZ[nL] = z; nL++; side = -side; }
  }
}
// Light from the lamps at a wall point (0..1) -> emissive amount.
function poolAt(st, x, y, z) {
  if (!nL) return 0;
  let e = 0;
  const r2 = st >= 6 ? 30 : st <= 3 ? 22 : 26;
  for (let i = 0; i < nL; i++) {
    const dx = x - LX[i], dy = y - LY[i], dz = z - LZ[i];
    e += Math.exp(-(dx * dx + dy * dy * 1.4 + dz * dz) / r2);
  }
  return Math.min(1, e);
}
function lampTint(st) { return st >= 6 ? [0.92, 0.97, 1.0] : st >= 4 ? [1.0, 0.86, 0.6] : [1.0, 0.62, 0.3]; }

// Deep inside: ambient occlusion by distance from the nearer mouth.
function aoAt(z, lh) { return 1 - 0.9 * smooth((lh - Math.abs(z)) / 26); }

function* buildPassage(b) {
  const st = P.st, lh = P.lh, W0 = wallX(st);
  const rng = () => b.rand();
  lampsFor(st, lh);
  const tint = lampTint(st);
  const surf = st <= 1 ? SURF.CAVE_STONE : SURF.CAVE_STONE;
  // --- the vault: rings every 2 m (1.5 m at the mouths), the cave flares out at its mouths
  const NZ = Math.ceil(lh * 2 / 2) + 1;
  let prev = -1;
  const slit0 = -0.22 * lh, slit1 = 0.18 * lh; // era 0-1: a crack of sky in the roof
  b.surface(surf);
  for (let iz = 0; iz < NZ; iz++) {
    const z = -lh + (2 * lh) * iz / (NZ - 1);
    const m = (lh - Math.abs(z)); // metres from the nearer mouth
    const flare = st <= 1 ? 1 + 0.35 * (1 - smooth(m / 14)) : 1;
    section(st, z, flare);
    const ao = aoAt(z, lh);
    const base = b.nv;
    for (let i = 0; i < NPF; i++) {
      const x = PX[i], y = PY[i];
      let c;
      if (st <= 1) c = mixc(rockAt(z), [0.08, 0.075, 0.07], 0.35, 0.85 + 0.25 * noise3(x * 0.4, y * 0.4, z * 0.2));
      else if (st <= 3) {
        const rib = st >= 2 && (((z + lh) % 20) + 20) % 20 < 1.6; // masonry ribs
        c = rib ? [0.42, 0.37, 0.3] : mixc(rockAt(z), [0.25, 0.22, 0.18], 0.4, 0.8 + 0.3 * noise3(x * 0.5, y * 0.5, z * 0.3));
      } else if (st <= 5) {
        const course = Math.floor((y + 0.35) / 0.42) + Math.floor(z / 1.3);
        c = (course & 1) ? [0.30, 0.13, 0.08] : [0.34, 0.15, 0.09];
        c = mixc(c, [0.06, 0.05, 0.05], smooth((y - 5.6) / 2.2) * 0.6); // soot at the crown
      } else {
        const joint = (((z + lh) % 6) + 6) % 6 < 0.12;
        c = joint ? [0.26, 0.26, 0.25] : y > 0.0 && y < 1.15 ? [0.62, 0.62, 0.58] : [0.5, 0.5, 0.48]; // painted dado
      }
      const pool = poolAt(st, x, y, z);
      if (pool > 0.01) c = mixc(c, [c[0] * tint[0] * 1.25, c[1] * tint[1] * 1.25, c[2] * tint[2] * 1.25], 0.7);
      b.color(c[0], c[1], c[2]).ao(ao).emissive(pool * (st >= 6 ? 0.075 : 0.06), st <= 3 ? FLICKER.OWN : FLICKER.NONE);
      b.vertex(x, y, z, NXp[i], NYp[i], 0);
    }
    if (prev >= 0) {
      for (let i = 0; i < NPF - 1; i++) {
        if (st <= 1 && z > slit0 && z < slit1 && i >= 11 && i < 13) continue; // the slit of sky
        b.quad(prev + i, prev + i + 1, base + i + 1, base + i);
      }
    }
    prev = base;
    if ((iz & 7) === 7) yield;
  }
  b.emissive(0, 0);
  // --- the rock above the vault, level with the plateau (it closes the slot from above)
  const rk = rockAt(0);
  b.surface(SURF.ROCK);
  {
    const nz = nTop;
    const tb = b.nv;
    for (let i = 0; i < nz; i++) {
      const z = TOPZ[i], s = snowAt(z), r = rockAt(z);
      b.color(r[0], r[1], r[2]).snow(s).ao(1);
      for (let c = 0; c < 5; c++) {
        const x = -8.8 + c * 4.4;
        b.vertex(x, topAt(x, z), z, 0, 1, 0);
      }
    }
    for (let i = 0; i + 1 < nz; i++) for (let c = 0; c < 4; c++) b.quad(tb + i * 5 + c, tb + i * 5 + c + 1, tb + (i + 1) * 5 + c + 1, tb + (i + 1) * 5 + c);
    // sides down into the slot walls
    for (let sd = -1; sd <= 1; sd += 2) {
      const x = sd * 8.8, sb = b.nv;
      for (let i = 0; i < nz; i++) {
        const z = TOPZ[i], r = rockAt(z);
        b.color(r[0] * 0.8, r[1] * 0.8, r[2] * 0.8).snow(0).ao(0.9);
        b.vertex(x, topAt(x, z), z, sd, 0, 0);
        b.vertex(x, 4.0, z, sd, 0, 0);
      }
      for (let i = 0; i + 1 < nz; i++) b.quad(sb + i * 2, sb + i * 2 + 1, sb + i * 2 + 3, sb + i * 2 + 2);
    }
    // the slit of sky continues up through the rock: two cheek walls
    if (st <= 1) {
      for (let sd = -1; sd <= 1; sd += 2) {
        const x = sd * 1.0, sb = b.nv;
        for (let z = slit0; z <= slit1 + 0.01; z += (slit1 - slit0) / 6) {
          b.color(rk[0] * 0.7, rk[1] * 0.7, rk[2] * 0.7).snow(0).ao(0.6);
          b.vertex(x + 0.3 * (noise3(z * 0.3, 1, 2) - 0.5), topAt(x, z), z, -sd, 0, 0);
          b.vertex(x, 7.2, z, -sd, 0, 0);
        }
        for (let i = 0; i < 6; i++) b.quad(sb + i * 2, sb + i * 2 + 1, sb + i * 2 + 3, sb + i * 2 + 2);
      }
    }
  }
  yield;
  // --- portals
  for (let end = -1; end <= 1; end += 2) {
    yield* portal(b, st, end, lh, rng);
  }
  // --- fittings inside
  fittings(b, st, lh);
  b.identity();
}

// Portal at local z = end * lh (end -1: the entry from the parent's side, +1 the exit).
function* portal(b, st, end, lh, rng) {
  const z0 = end * (lh + 0.25);
  const top = end < 0 ? topAt(0, -lh) : topAt(0, lh);
  const W0 = wallX(st);
  const FW = SLOT_HW + SLOT_WALL + 1.2; // tucks into the cutting walls
  const faceH = st <= 1 ? 0 : st <= 3 ? 11.5 : st <= 5 ? 10.5 : 9.5;
  const rk = rockAt(end * lh);
  // face columns (outward normal: +z at the exit, -z at the entry)
  const NC = 48;
  const fb = b.nv;
  if (st <= 1) section(st, end * lh, 1.35);
  for (let c = 0; c <= NC; c++) {
    const x = -FW + (2 * FW) * c / NC;
    let y0 = -0.6;
    if (st <= 1) {
      // the cave mouth: the flared section's height at this x (its upper half)
      for (let i = 0; i < NPF - 1; i++) {
        const xa = PX[i], xb = PX[i + 1];
        if ((x - xa) * (x - xb) <= 0 && PY[i] + PY[i + 1] > 6) { const t = Math.abs(xb - xa) > 1e-6 ? (x - xa) / (xb - xa) : 0; y0 = Math.max(y0, PY[i] + (PY[i + 1] - PY[i]) * t); }
      }
      if (Math.abs(x) < 4.5 && y0 < 6.6) y0 = 7.5;
    } else { const a = archTop(st, x); if (a > 0) y0 = a; }
    const t = Math.max(y0 + 0.5, (end < 0 ? topAt(x, -lh) : topAt(x, lh)));
    const nzv = end;
    // three bands: dressed face (style), a rough transition, rock
    const yA = y0, yB = Math.max(yA, Math.min(faceH, t)), yC = t;
    const fc = faceColour(st, x, rng);
    b.surface(st <= 1 ? SURF.ROCK : SURF.STONE).color(fc[0], fc[1], fc[2]).snow(st <= 1 ? snowAt(end * lh) * 0.5 : 0).ao(st <= 1 ? 0.8 : 1);
    b.vertex(x, yA, z0, 0, 0, nzv);
    b.vertex(x, yB, z0, 0, 0, nzv);
    b.surface(SURF.ROCK).color(rk[0], rk[1], rk[2]).snow(snowAt(end * lh)).ao(1);
    b.vertex(x, yB, z0 + end * 0.05, 0, 0, nzv);
    b.vertex(x, yC, z0 + end * 0.05, 0, 0, nzv);
  }
  for (let c = 0; c < NC; c++) {
    const a = fb + c * 4, n = fb + (c + 1) * 4;
    b.quad(a, a + 1, n + 1, n);
    b.quad(a + 2, a + 3, n + 3, n + 2);
  }
  yield;
  b.push();
  b.translate(0, 0, z0);
  if (st <= 1) {
    // ragged rocks round the mouth
    b.surface(SURF.ROCK).ao(0.9);
    for (let k = 0; k < 9; k++) {
      const a = 0.15 + (k / 8) * (Math.PI - 0.3), r = 7.6 + 1.6 * rng();
      const c = mixc(rk, [0.1, 0.09, 0.08], 0.2 * rng());
      b.color(c[0], c[1], c[2]).snow(snowAt(end * lh) * 0.6);
      b.push(); b.translate(-Math.cos(a) * r, Math.sin(a) * r * 1.05 + 0.5, end * (0.6 + 0.8 * rng()));
      b.rock(1.4 + 1.6 * rng(), 1.2 + 1.4 * rng(), 1.0 + 0.8 * rng(), 2, 0.3, (P.seed + k * 7) | 0, 3, 0.2);
      b.pop();
    }
    if (st === 1) {
      // torches either side of the mouth
      for (let sd = -1; sd <= 1; sd += 2) torch(b, sd * 7.1, 3.2, end * 0.7);
    }
  } else if (st <= 3) {
    // voussoir ring, keystone and imposts in pale dressed stone
    const R = 5.97, cy = 2.0, nv = 15;
    b.surface(SURF.STONE).ao(1);
    for (let k = 0; k < nv; k++) {
      const a0 = 0.355 + (k / nv) * (Math.PI - 0.71), a1 = 0.355 + ((k + 1) / nv) * (Math.PI - 0.71);
      const key = k === (nv >> 1);
      const ro = R + (key ? 1.35 : 1.0), d = key ? 0.45 : 0.3;
      const g = key ? 0.56 : 0.46 + 0.06 * rng();
      b.color(g, g * 0.94, g * 0.84);
      voussoir(b, R - 0.02, ro, cy, a0 + 0.012, a1 - 0.012, end * d);
    }
    b.color(0.44, 0.41, 0.36);
    for (let sd = -1; sd <= 1; sd += 2) b.box(sd * (W0 + 0.55), 4.05, end * 0.2, 0.95, 0.28, 0.45);
    // cornice
    b.color(0.47, 0.44, 0.38);
    b.box(0, faceH + 0.25, end * 0.35, FW, 0.32, 0.5);
    b.box(0, faceH - 0.15, end * 0.18, FW - 0.2, 0.14, 0.3);
    // flanking torches
    for (let sd = -1; sd <= 1; sd += 2) torch(b, sd * (W0 + 1.7), 3.6, end * 0.6);
  } else if (st <= 5) {
    // brick face dressed in stone: pilasters, an arch ring of stone, cornice, parapet, date stone
    b.surface(SURF.STONE).ao(1);
    b.color(0.5, 0.47, 0.41);
    for (let sd = -1; sd <= 1; sd += 2) b.box(sd * (W0 + 1.25), faceH * 0.5, end * 0.28, 0.65, faceH * 0.5, 0.3);
    const nv = 17;
    for (let k = 0; k < nv; k++) {
      const a0 = (k / nv) * Math.PI, a1 = ((k + 1) / nv) * Math.PI;
      const key = k === (nv >> 1);
      b.color(key ? 0.6 : 0.52, key ? 0.56 : 0.49, key ? 0.48 : 0.42);
      ellipVoussoir(b, W0, 3.8, 3.6, key ? 1.15 : 0.75, a0 + 0.01, a1 - 0.01, end * (key ? 0.38 : 0.26));
    }
    b.color(0.5, 0.47, 0.41);
    b.box(0, faceH + 0.22, end * 0.4, FW, 0.3, 0.55); // cornice
    b.color(0.33, 0.15, 0.09);
    b.box(0, faceH + 1.05, end * 0.12, FW - 0.4, 0.55, 0.32); // parapet (brick)
    b.color(0.5, 0.47, 0.41);
    b.box(0, faceH + 1.66, end * 0.14, FW - 0.3, 0.08, 0.38); // coping
    b.color(0.62, 0.58, 0.5);
    b.box(0, 8.6, end * 0.3, 1.1, 0.55, 0.12); // date stone
    // gas lamps either side
    for (let sd = -1; sd <= 1; sd += 2) gasLamp(b, sd * (W0 + 1.25), 4.3, end * 0.65, end);
  } else {
    // concrete portal hood: two fins and a deep beam, a dark band with a lit edge line
    b.surface(SURF.PLASTER).ao(1);
    const out = 3.2;
    b.color(0.56, 0.56, 0.54);
    for (let sd = -1; sd <= 1; sd += 2) {
      b.push(); b.translate(sd * (W0 + 0.6), 0, end * out * 0.5);
      b.box(0, 4.1, 0, 0.6, 4.1, out * 0.5);
      b.pop();
    }
    b.box(0, 7.75, end * out * 0.5, W0 + 1.2, 0.65, out * 0.5);
    b.color(0.09, 0.1, 0.11);
    b.box(0, 7.75, end * (out + 0.02), W0 + 0.6, 0.38, 0.03);
    b.color(0.95, 0.85, 0.55).emissive(0.06, FLICKER.NONE);
    b.box(0, 7.18, end * (out - 0.2), W0 + 0.4, 0.03, 0.06);
    b.emissive(0, 0);
    // reflective edge posts at the mouth
    for (let sd = -1; sd <= 1; sd += 2) {
      b.color(0.9, 0.9, 0.88);
      b.box(sd * (W0 - 0.15), 0.6, end * (out + 0.6), 0.09, 0.6, 0.09);
      b.color(1.0, 0.55, 0.1).emissive(0.12, FLICKER.NONE);
      b.box(sd * (W0 - 0.15), 1.0, end * (out + 0.6 + 0.1 * end * 0), 0.07, 0.09, 0.1);
      b.emissive(0, 0);
    }
  }
  b.pop();
}
function faceColour(st, x, rng) {
  if (st <= 1) return rockAt(0);
  if (st <= 3) { const g = 0.4 + 0.05 * Math.sin(x * 1.7); return [g, g * 0.93, g * 0.82]; }
  if (st <= 5) return [0.31, 0.14, 0.085];
  return [0.52, 0.52, 0.5];
}
// One wedge of a circular arch ring (centre (0, cy), radii ri..ro, angles a0..a1), d thick toward +z.
const VP = new Float64Array(24);
function voussoir(b, ri, ro, cy, a0, a1, d) {
  const z0 = Math.min(0, d), z1 = Math.max(0, d);
  const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
  const pts = [[-c0 * ri, cy + s0 * ri], [-c1 * ri, cy + s1 * ri], [-c1 * ro, cy + s1 * ro], [-c0 * ro, cy + s0 * ro]];
  for (let i = 0; i < 4; i++) { VP[i * 3] = pts[i][0]; VP[i * 3 + 1] = pts[i][1]; VP[i * 3 + 2] = z0; VP[12 + i * 3] = pts[i][0]; VP[12 + i * 3 + 1] = pts[i][1]; VP[12 + i * 3 + 2] = z1; }
  hexaRing(b);
}
function ellipVoussoir(b, ax, ay, cy, th, a0, a1, d) {
  const z0 = Math.min(0, d), z1 = Math.max(0, d);
  const P0 = [-Math.cos(a0) * ax, cy + Math.sin(a0) * ay], P1 = [-Math.cos(a1) * ax, cy + Math.sin(a1) * ay];
  const N0 = [-Math.cos(a0) * ay, Math.sin(a0) * ax], N1 = [-Math.cos(a1) * ay, Math.sin(a1) * ax];
  const l0 = Math.hypot(N0[0], N0[1]), l1 = Math.hypot(N1[0], N1[1]);
  const pts = [P0, P1, [P1[0] + N1[0] / l1 * th, P1[1] + N1[1] / l1 * th], [P0[0] + N0[0] / l0 * th, P0[1] + N0[1] / l0 * th]];
  for (let i = 0; i < 4; i++) { VP[i * 3] = pts[i][0]; VP[i * 3 + 1] = pts[i][1]; VP[i * 3 + 2] = z0; VP[12 + i * 3] = pts[i][0]; VP[12 + i * 3 + 1] = pts[i][1]; VP[12 + i * 3 + 2] = z1; }
  hexaRing(b);
}
// VP holds a quad at z0 (4 points) then the same at z1: as hexa() wants (bottom ring, top ring)
// with "bottom" = z0 face. hexa computes outward normals from the centroid, so order is free.
const HP = new Float64Array(24);
function hexaRing(b) {
  // hexa(): bottom ring -x-z, +x-z, +x+z, -x+z then top; we map our two quads onto it with y as
  // the third axis: rotate so the quads become bottom/top (swap y and z of a copy).
  for (let i = 0; i < 8; i++) { HP[i * 3] = VP[i * 3]; HP[i * 3 + 1] = VP[i * 3 + 1]; HP[i * 3 + 2] = VP[i * 3 + 2]; }
  b.hexa(HP, true);
}
function torch(b, x, y, z) {
  b.surface(SURF.WOOD).color(0.12, 0.08, 0.05).ao(1).emissive(0, 0);
  b.beam(x, y - 0.9, z, x, y, z, 0.05, 0.07, 6, true);
  b.color(0.05, 0.04, 0.03).emissive(0.2, FLICKER.OWN);
  b.box(x, y + 0.05, z, 0.09, 0.08, 0.09);
  b.emissive(0, 0);
  b.flames(x, y + 0.1, z, 0.55, FLICKER.OWN, (P.seed + Math.round(x * 13 + z * 7)) & 1023);
}
function gasLamp(b, x, y, z, end) {
  b.surface(SURF.PLAIN).color(0.06, 0.06, 0.06).ao(1).emissive(0, 0);
  b.beam(x, y - 0.5, z - end * 0.55, x, y - 0.5, z, 0.035, 0.035, 5, true);
  b.box(x, y - 0.42, z, 0.17, 0.05, 0.17);
  b.box(x, y + 0.42, z, 0.2, 0.06, 0.2);
  b.color(1.0, 0.88, 0.62).emissive(0.45, FLICKER.NONE);
  b.box(x, y, z, 0.15, 0.36, 0.15);
  b.emissive(0, 0);
}
function fittings(b, st, lh) {
  if (st <= 1) return; // the cave's torches stand at its mouths (portal)
  const tint = lampTint(st);
  for (let i = 0; i < nL; i++) {
    const x = LX[i], y = LY[i], z = LZ[i], sd = x > 0 ? 1 : -1;
    if (st <= 3) {
      // a niche with an oil lamp
      b.surface(SURF.STONE).color(0.05, 0.045, 0.04).ao(0.5).emissive(0, 0);
      b.box(x + sd * 0.12, y + 0.3, z, 0.08, 0.55, 0.45);
      b.surface(SURF.EARTH).color(0.3, 0.2, 0.12).ao(1);
      b.box(x - sd * 0.05, y - 0.06, z, 0.12, 0.05, 0.14);
      b.flames(x - sd * 0.05, y, z, 0.32, FLICKER.OWN, (i * 37 + P.seed) & 1023);
    } else if (st <= 5) {
      b.surface(SURF.PLAIN).color(0.05, 0.05, 0.05).ao(1).emissive(0, 0);
      b.beam(x + sd * 0.3, y + 0.45, z, x - sd * 0.25, y + 0.45, z, 0.03, 0.03, 5, true);
      b.box(x - sd * 0.25, y + 0.38, z, 0.13, 0.04, 0.13);
      b.box(x - sd * 0.25, y - 0.3, z, 0.1, 0.03, 0.1);
      b.color(tint[0], tint[1] * 0.97, tint[2] * 0.9).emissive(0.5, FLICKER.NONE);
      b.box(x - sd * 0.25, y + 0.04, z, 0.11, 0.3, 0.11);
      b.emissive(0, 0);
    } else {
      // strip light segment (cool white) along the ceiling
      b.surface(SURF.PLAIN).color(0.2, 0.2, 0.2).ao(1).emissive(0, 0);
      b.box(x, y + 0.12, z, 0.16, 0.05, 5.6);
      b.color(0.85, 0.92, 1.0).emissive(0.55, FLICKER.NONE);
      b.box(x, y + 0.04, z, 0.11, 0.035, 5.4);
      b.emissive(0, 0);
    }
  }
  if (st >= 6) {
    // reflective edge markers on both walls every 6 m, and a kerb along each side
    const W0 = wallX(st);
    for (let z = -lh + 3; z < lh - 2; z += 6) {
      for (let sd = -1; sd <= 1; sd += 2) {
        b.surface(SURF.PLAIN).color(1.0, 0.55, 0.12).ao(1).emissive(0.16, FLICKER.NONE);
        b.box(sd * (W0 - 0.03), 0.95, z, 0.03, 0.06, 0.12);
        b.emissive(0, 0);
      }
    }
    b.surface(SURF.STONE).color(0.55, 0.55, 0.52).ao(0.8);
    for (let sd = -1; sd <= 1; sd += 2) b.box(sd * (W0 - 0.5), 0.12, 0, 0.5, 0.16, lh);
  } else {
    // a raised walkway of flags along each wall
    b.surface(SURF.STONE).color(0.3, 0.28, 0.25).ao(0.7);
    const W0 = wallX(st);
    for (let sd = -1; sd <= 1; sd += 2) b.box(sd * (W0 - 0.55), 0.08, 0, 0.55, 0.14, lh);
  }
}

// ------------------------------------------------------------------------------ the car

// Inside a passage (the slot from cutting to cutting): keep the car between the walls. A wall
// is a soft limit: the car slides along it and loses a little speed; steering is the player's.
export const TC = new Float64Array(8); // [0] passage slot of the car (-1 none), [1] a, [2] l, [3] depth 0..1, [4] wall contacts (steps), [5] largest |l| / limit seen
export function tunnelClamp(cur) {
  TC[0] = -1; TC[3] = 0;
  tunAtJS(cur[0], cur[2]);
  if (TZO[9] < 0 || TZO[2] <= 0) return;
  const te = tunData[TZO[9] * 12 + 11];
  if (te !== car.track) return; // another road's passage
  const a = TZO[0], l = TZO[1], lh = TZO[4];
  const aa = a < 0 ? -a : a;
  if (aa > lh + 26 || (l < 0 ? -l : l) > SLOT_HW + 4) return;
  TC[0] = TZO[9]; TC[1] = a; TC[2] = l; TC[3] = smooth((lh - aa) / 26);
  const lim = (aa < lh + 2 ? wallX(TZO[8]) : SLOT_HW) - 1.15;
  const r = (l < 0 ? -l : l) / lim; if (r > TC[5]) TC[5] = r;
  if (l > lim || l < -lim) {
    TC[4]++;
    const sl = l > 0 ? lim : -lim, o = TZO[9] * 12, dx = tunData[o + 2], dz = tunData[o + 3];
    // move back onto the limit (along the passage's lateral axis: right = (-dz, dx))
    cur[0] += -dz * (sl - l); cur[2] += dx * (sl - l);
    // the heading turns along the wall
    const hw = Math.atan2(dz, dx), d = Math.atan2(Math.sin(cur[3] - hw), Math.cos(cur[3] - hw));
    const into = (l > 0 && Math.sin(d) > 0) || (l < 0 && Math.sin(d) < 0);
    if (into) { cur[3] -= Math.sin(d) * 0.35; car.v *= 0.995; }
  }
}
// The chase camera stays inside the passage and below its crown.
export function tunnelCam(cur) {
  tunAtJS(cur[12], cur[14]);
  if (TZO[9] < 0 || TZO[2] <= 0) return;
  const te = tunData[TZO[9] * 12 + 11];
  if (te !== car.track) return;
  const a = TZO[0], l = TZO[1], lh = TZO[4], aa = a < 0 ? -a : a;
  if (aa > lh + 20 || (l < 0 ? -l : l) > SLOT_HW + 6) return;
  const lim = (aa < lh + 1 ? wallX(TZO[8]) : SLOT_HW) - 0.8;
  const o = TZO[9] * 12, dx = tunData[o + 2], dz = tunData[o + 3];
  if (l > lim || l < -lim) { const sl = l > 0 ? lim : -lim; cur[12] += -dz * (sl - l); cur[14] += dx * (sl - l); }
  if (aa < lh + 1) { const cap = TZO[5] + (TZO[8] <= 1 ? 5.4 : TZO[8] >= 6 ? 5.0 : 5.6); if (cur[13] > cap) cur[13] = cap; }
}

// ------------------------------------------------------------------------------ debug
export function tunnelInfo() {
  const out = [];
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!tStage[e]) continue;
    const o = e * 8;
    out.push({ edge: e, stage: tStage[e], style: tStyle[e], x: +tF[o].toFixed(1), z: +tF[o + 1].toFixed(1), dir: [+tF[o + 2].toFixed(3), +tF[o + 3].toFixed(3)], y: +tF[o + 4].toFixed(2), lh: +tF[o + 5].toFixed(1), s: +edgeTunS[e].toFixed(1), len: Math.round(edgeLen[e]), parent: tF[o + 6], own: tF[o + 7], clear: Math.round(edgeTunClear[e]), bio: +bioSnap[e * 8].toFixed(2), top: [+tTop[e * 2].toFixed(1), +tTop[e * 2 + 1].toFixed(1)], tris: tH[e] ? tH[e].triangles : 0 });
  }
  return { tunnels: out, builds: STAT[0], maxBuildMs: +STAT[1].toFixed(2), buildMs: +STAT[2].toFixed(1), dropped: STAT[3], slots: Array.from(tunData) };
}
if (typeof window !== 'undefined') {
  const Gq = new Float64Array(8);
  window.__tunnel = {
    info: tunnelInfo, TC,
    // every live road: region, parent, seam kind, passage s / half length, split, biome presence
    edges: () => { const o = []; for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e]) o.push({ e, ver: edgeVersion[e], region: edgeRegion[e], parent: edgeParentRegion[e], seam: edgeSeam[e], tunS: edgeTunS[e], tunH: edgeTunH[e], split: edgeSplit[e], len: edgeLen[e], pres: +edgePresence[e].toFixed(3), bio: +edgeBio[e].toFixed(3), cur: e === graph.cur }); return o; },
    // nearest distance from (x, z) to road e's samples
    edgeDist: (e, x, z) => { let b = 1e18; for (let s = 0; s <= edgeLen[e]; s += 8) { Gq[4] = s; pointAt(e, Gq); const dx = Gq[0] - x, dz = Gq[2] - z; b = Math.min(b, dx * dx + dz * dz); } return Math.sqrt(b); },
    // point on road e at s, offset lat to the right: x, y, z, heading
    at: (e, s, lat = 0) => { Gq[4] = s; Gq[5] = lat; frameAt(e, Gq); return [Gq[0], Gq[1], Gq[2], Gq[3]]; },
    // the ridge alone (m over the natural ground) and the label at (x, z)
    ridge: (x, z) => { Gq[5] = x; Gq[6] = z; nearestRoad(Gq, 48); ridgeJS(x, z, 0, Math.min(Gq[0], 48)); const ze = TZO[9] >= 0 ? tunData[TZO[9] * 12 + 11] : -1, za = TZO[0], zl = TZO[1]; labelAtJS(x, z); return { ridge: RGO[0], map: RGO[1], ze, za, zl, rd: Gq[0], lab: LIO[0], oth: LIO[1], g: LIO[3], f: LIO[2], d1: LIO[4], ds: LIO[5] }; },
    graph: () => ({ evictBio: graph.evictBio, evictNear: graph.evictNear, built: graph.built, commits: graph.commits }),
  };
}
