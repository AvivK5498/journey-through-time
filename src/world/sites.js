// Sites: the events' landmarks placed along the roads, and the land bridge.
//
// Landmarks. When every exit of a fork has been generated (onEdgeReady), each of those roads
// gets at most one landmark: an event of the registry (world/time.js EVENTS) of that road's
// region and landmass whose placement window [w0, w1] the road's clock span covers (the window
// closing soonest first; else a remnant such as the buried Gobekli Tepe), at the spot along it
// with the best approach view (sampled along the road behind it), on the side away from the
// sibling roads. Events whose module is not registered (landmarks/index.js) are skipped;
// ?placeholders=1 stands landmarks/example.js in for them (routes, logging and tests). A straddling landmark (the cave) straightens and levels
// the road under it. The pad is flattened by ground() (world.js siteData) and kept clear of
// grass, props and trees. The mesh is built when the car comes within BUILD_R, as a generator
// stepped under a per-frame time budget, then uploaded. Every frame: setState(built, decay)
// from landmarkState() (when the kit's handle has it), visibility, and the event log.
//
// Land bridge (graph.js planHistory marks the causeway exit and where it crosses): the nearest
// causeway's strait is written to siteData; frozen while time.js straitOpen() allows it
// (until LAND_BRIDGE_CLOCK), then open water.
// An unavailable causeway's road ends at the shore (edgeDrawEnd).
//
//   initSites(onLog)       once; onLog(eventId) is called when an event is logged
//   resetSites()           before resetGraph (destroys every landmark)
//   updateSites(budgetMs)  every frame after the sim (Infinity: build everything in range now)
//   siteInfo()             debug / tests (allocates)
//
// Satellites (def.satellites, see LANDMARKS.md): once a landmark is uploaded, its companions
// are scattered around it (seeded by the site, on valid ground: away from every road, pad
// and water, not on steep ground), a few tries per frame, then built into ONE extra kit mesh
// at the site's origin that shares the landmark's setState / visibility. While the site is
// visible one companion per frame is re-checked against the ground (roads that appear later
// change the far terrain) and the mesh is rebuilt when a height moved or a road came close.
//
// Witness (camera.js): every frame witnessIO[0] = the live, unwitnessed site whose landmark is
// near and in view (-1 none), [1] its event. witnessBegin(out) frames it (def.witness or the
// default) and logs it like a drive-by.
//
// The home (event 22, the ending; src/ending.js): prebuildHome() builds its mesh off-stage in
// a reserved site (one at a time with the other builds), homeSpotOk() judges a spot beside the
// road, placeHome(e, s, side) stands it there (pad, setState, drawn). It is never logged by a
// drive-by and offers no witness prompt. siteHold[0] = 1 while the ending runs the clock back:
// no logging, no witness, no strait closing, and every landmark shown only while it exists.

import { state } from '../state.js';
import { pose, car } from '../car.js'; // runtime use only (the import cycle is safe)
import { camera } from '../camera.js';
import {
  graph, pts, heads, MAX_PTS, MAX_EDGES, STEP, edgeN, edgeLen, edgeJ0, edgeRegion, edgeAlive, edgeFrom, edgeTo,
  edgeExit, edgeVersion, edgeDrawEnd, nodeIn, nodeExit, nodeExitCount, nodeAlive, nodeBridge, nodeBridgeS, pointAt,
  onEdgeReady, onEdgeFreed, exitAvailable, markExitUnavailable, clockBase, MAX_NODES, edgePresence, edgeKeep,
  edgeBio, edgeParentRegion, nearestRoad, edgeLand, edgeCross, nodeLand, landAt, edgeCrossHW,
  nodeKey, nodeHead, nodeX, nodeZ, nodeFerry, edgeFerry, exitAngle, DRAW_END_PAD, FERRY_WATER, edgeTunS, edgeTunH,
} from './graph.js';
import { hashU, HASH_SCALE } from './noise.js';
import { FOOTPRINTS, FOOT_BINS } from './footprints.js';
import { updateCrossing } from './crossing.js';
import { siteData, siteSight, MAX_PADS, BMAP, groundInfo, groundExtra, groundSea, padTight, seaData } from './world.js';
import * as WORLD from './world.js';
import { uploadEdge } from './road.js';
import { landmarkState, landmarkStateIO, EVENTS, EVENT_COUNT, LAND_BRIDGE_CLOCK, straitOpen, EV_HOME } from './time.js';
import { LandmarkBuilder, beginBuild, uploadLandmark, roadOffset, SEA, ROAD } from './landmarks/kit.js';
import * as MODULES from './landmarks/index.js';
import placeholder from './landmarks/example.js';

// Landmark definition per event id (null: no module yet, the event is not placed).
const PLACEHOLDERS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('placeholders') === '1';
export const DEFS = EVENTS.map((e) => {
  if (e.id === EV_HOME) return MODULES.home || null; // the ending's home: placed by placeHome() only
  if (!e.place) return null;
  const m = MODULES[e.key.replace(/-/g, '_')];
  return m || (PLACEHOLDERS ? placeholder : null);
});
// How far back along the road the approach view is judged (m), the half-angle of its view
// cone (rad), and the nearest approach point counted (m). A module may set `approach`,
// `cone`, `approachFrom`; the slice's four keep their tuned values (Giza is judged over the
// chase camera's wider frame, from about clock 85 until it falls out of it).
const SLICE_APPROACH = [320, 260, 380, 1400], SLICE_CONE = [0.45, 0.45, 0.45, 0.5], SLICE_FROM = [40, 40, 40, 640];
const APPROACH = DEFS.map((d, i) => (d && d.approach) || (i < 4 ? SLICE_APPROACH[i] : d ? Math.max(380, Math.min(1400, d.radius * 5)) : 400));
const CONE = DEFS.map((d, i) => (d && d.cone) || (i < 4 ? SLICE_CONE[i] : 0.45));
const VIEW_FROM = DEFS.map((d, i) => (d && d.approachFrom) || (i < 4 ? SLICE_FROM[i] : 40));
const BUILD_R = 3600; // m: build the mesh when the car is this close
const MAX_SITES = 16;
const BRIDGE_HW = 64; // strait half width along the causeway (m)
// Witness prompt range (m from the car to the origin) and "right beside it" distance.
const NOW = {}, ZERO2 = [0, 0];
const WRANGE = DEFS.map((d) => (!d ? 0 : (d.witness && d.witness.range) || roadOffset(d) * (d.straddlesRoad ? 0 : 1) + 1.5 * d.radius + 220));
const WBESIDE = DEFS.map((d) => (!d ? 0 : (d.straddlesRoad ? 0 : roadOffset(d)) + d.radius + 30));
const BIO_MIN = 0.8; // a landmark stands where its own region's biome weight is at least this
const BIO_LOW = 0.6; // fallback when no spot on the road reaches BIO_MIN
const VIEW_KEEP = 0.85; // a moved landmark takes the earliest in-biome spot with this share of the best view

// ------------------------------------------------------------------------- road clearance
// The road is for the car only: no road that exists or will exist while a landmark is drawn
// may come within ROAD.clearance (6.5 m) of what it builds above 5 cm, nor cross more than the
// bare outer rim of its pad (PAD_IN below). The
// footprint is the module's polar envelope (src/world/footprints.js, tools/footprints.mjs);
// the roads are every live edge (the landmark's own along its whole length, siblings, the
// road behind, ferry roads over the water) plus "ghosts": the exits of every junction that
// are not generated yet, computed with graph.js's own road shape (they are deterministic), so
// a fork built after placement never runs into a landmark. A road generated later anyway
// (two forks out) re-checks the sites not yet in view (edgeReady) and moves them.
// The pad is the flattened ground under a landmark, built a few metres short of its own road;
// a road may cross its bare outer rim (PAD_IN of its radius, at most PAD_IN_MAX m), never what
// stands on it (GEO_CLEAR from every vertex above 5 cm).
const PAD_IN = 0.1, PAD_IN_MAX = 30, GEO_CLEAR = ROAD.clearance;
const SIGHT_APPROACH = 520; // m of road before a landmark whose view toward it is kept open
const FB = FOOT_BINS;
const FP = DEFS.map((d) => {
  if (!d) return null;
  let k = null;
  for (const m in MODULES) if (MODULES[m] === d) k = m;
  if (d === placeholder) k = 'example';
  const s = k && FOOTPRINTS[k];
  if (!s || typeof atob !== 'function') return null;
  const bin = atob(s), q = new Int16Array(FB * 2);
  for (let i = 0; i < FB * 2; i++) q[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
  const f = new Float64Array(FB * 3); // x, z, radius
  for (let i = 0; i < FB; i++) { f[i * 3] = q[i * 2] / 10; f[i * 3 + 1] = q[i * 2 + 1] / 10; f[i * 3 + 2] = Math.hypot(f[i * 3], f[i * 3 + 1]); }
  return f;
});
const FPR = DEFS.map((d, i) => { let r = 0; const f = FP[i]; if (f) for (let k = 0; k < FB; k++) if (f[k * 3 + 2] > r) r = f[k * 3 + 2]; return r; });
const CLRSTAT = new Int32Array(4); // debug: [0] candidates rejected, [1] sites moved by a later road, [2] seen too close
const CLR = new Float64Array(4);
const CLREJ = new Int32Array(EVENT_COUNT * 5); // debug: rejected candidates per event (own pad, own road, sibling, later fork, other road) // clearMargin out: [0] margin, [1] edge (-2 ghost), [2] 1 = pad, [3] -

// Margin (m) of local point (lx, lz) of event ev's landmark: distance to its footprint minus
// GEO_CLEAR, or into its pad beyond the rim allowance, whichever is smaller (< 0: too close).
function pointMargin(ev, lx, lz, straddle) {
  const r = Math.sqrt(lx * lx + lz * lz);
  const pad = DEFS[ev].pad;
  let m = straddle ? 1e9 : r - pad + Math.min(PAD_IN_MAX, PAD_IN * pad);
  CLR[2] = 1;
  const f = FP[ev];
  if (!f || r > FPR[ev] + GEO_CLEAR + 1) return m;
  let k = Math.floor((Math.atan2(lz, lx) + Math.PI) * (FB / (2 * Math.PI)));
  if (k >= FB) k = 0;
  // inside the envelope (its bin and the two beside it, conservatively)
  const km = (k + FB - 1) % FB, kp = (k + 1) % FB;
  const er = Math.max(f[k * 3 + 2], f[km * 3 + 2], f[kp * 3 + 2]);
  let g;
  if (r < er) g = -GEO_CLEAR - (er - r);
  else {
    g = 1e9;
    const w = 1 + Math.ceil(Math.asin(Math.min(1, (GEO_CLEAR + 3) / Math.max(r, 1e-3))) * (FB / (2 * Math.PI)));
    for (let d = -w; d <= w; d++) {
      const a = ((k + d) % FB + FB) % FB, b = (a + 1) % FB;
      const ax = f[a * 3], az = f[a * 3 + 1], sx = f[b * 3] - ax, sz = f[b * 3 + 1] - az;
      const px = lx - ax, pz = lz - az;
      const ll = sx * sx + sz * sz;
      let t = ll > 1e-9 ? (px * sx + pz * sz) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - sx * t, ez = pz - sz * t;
      const dd = Math.sqrt(ex * ex + ez * ez);
      if (dd < g) g = dd;
    }
    g -= GEO_CLEAR;
  }
  if (g < m) { m = g; CLR[2] = 0; }
  return m;
}

// Ghost exits: the not yet generated exits of every live junction (graph.js buildEdge's road
// shape, sampled every 4 m). Rebuilt when the graph has built a new edge.
const GMAX = 24, GPTS = 340;
const GH = new Float32Array(GMAX * GPTS * 2);
const GN = new Uint16Array(GMAX), GX = new Float64Array(GMAX * 2), GNI = new Int16Array(GMAX * 2);
const GSTAT = new Int32Array([0, -1]); // [0] ghosts, [1] graph.built when made
const GP = new Float64Array(16);
const FERRY_LEAD = 13; // graph.js: clock seconds from a fork to its ferry quay
const GK = new Uint32Array(1);
function rnd(k) { return hashU(GK[0], k) * HASH_SCALE; }
function ghostHeading(s) { // graph.js headingAt with the ghost's parameters in GP
  if (s > GP[14]) s = GP[14];
  const len = GP[7], u = s / len;
  let t = u / 0.16; t = t < 0 ? 0 : t > 1 ? 1 : t; let taper = t * t * (3 - 2 * t);
  t = (1 - u) / 0.16; t = t < 0 ? 0 : t > 1 ? 1 : t; taper *= t * t * (3 - 2 * t);
  t = s / 180; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return GP[0] + GP[1] * t * t * (3 - 2 * t) + GP[2] * taper * (GP[3] * Math.sin(Math.PI * GP[5] * u) + GP[4] * Math.sin(Math.PI * GP[6] * u) + GP[12] * Math.sin(Math.PI * GP[13] * u));
}
// Can junction n still grow its exits: it lies on the tree ahead of the car (its own road or a
// road ahead of the car's end junction leads to it). Junctions left behind, or off the branch
// the car took, never do.
function canGrow(n) {
  if (graph.cur < 0) return true;
  const j = edgeTo[graph.cur];
  for (let m = n, k = 0; k < 6; k++) {
    if (m === j) return true;
    const ie = nodeIn[m];
    if (ie < 0 || !edgeAlive[ie] || !edgeKeep[ie] || ie === graph.cur) return false;
    m = edgeFrom[ie];
  }
  return false;
}
function makeGhosts() {
  if (GSTAT[1] === graph.built) return;
  GSTAT[1] = graph.built;
  let g = 0;
  for (let n = 0; n < MAX_NODES && g < GMAX; n++) {
    if (!nodeAlive[n] || !canGrow(n)) continue;
    for (let i = 0; i < nodeExitCount[n] && g < GMAX; i++) {
      if (nodeExit(n, i) >= 0) continue;
      const key = hashU(nodeKey[n], 101 + i);
      GK[0] = key;
      const ferry = nodeFerry[n] === i;
      const qa = ferry ? FERRY_LEAD * 40 - 40 + 80 * rnd(1) : 1e9;
      const L = ferry ? qa + FERRY_WATER : nodeIn[n] < 0 ? 760 + 80 * rnd(1) : 950 + 200 * rnd(1);
      const N = Math.min(MAX_PTS, Math.floor(L / STEP) + 1);
      const wig = Math.min(1, L / 1150);
      GP[0] = nodeHead[n]; GP[1] = exitAngle(n, i); GP[2] = rnd(6) < 0.5 ? 1 : -1;
      GP[3] = (rnd(4) - 0.5) * 0.55 * wig; GP[4] = (rnd(5) - 0.5) * 0.25 * wig;
      GP[5] = 1 + (hashU(key, 2) % 3); GP[6] = GP[5] + 1 + (hashU(key, 3) % 2);
      GP[7] = (N - 1) * STEP;
      GP[12] = (0.06 + 0.06 * rnd(7)) * wig * (rnd(8) < 0.5 ? 1 : -1); GP[13] = 5 + (hashU(key, 9) % 4);
      GP[14] = ferry ? qa - 90 : 1e9;
      let x = nodeX[n], z = nodeZ[n], c = 0;
      const o = g * GPTS * 2;
      GH[o] = x; GH[o + 1] = z; c = 1;
      for (let k = 1; k < N; k++) {
        const hm = ghostHeading(k * STEP - STEP * 0.5);
        x += Math.cos(hm) * STEP; z += Math.sin(hm) * STEP;
        if ((k & 1) === 0 && c < GPTS) { GH[o + c * 2] = x; GH[o + c * 2 + 1] = z; c++; }
      }
      GN[g] = c; GX[g * 2] = nodeX[n]; GX[g * 2 + 1] = nodeZ[n]; GNI[g * 2] = n; GNI[g * 2 + 1] = i;
      g++;
    }
  }
  GSTAT[0] = g;
}

// Smallest clearance margin of event ev's landmark at (ox, oz, yaw) against every live road
// (skip: the straddled road) and every ghost exit (CLR[0]; CLR[1] the edge, -2 a ghost).
// Plan time (and the debug check) only.
// fading: also count roads already fading out (keep 0) and roads off the site's line (onLine).
// Placement does not (an abandoned branch is gone ~8 s later); a landmark placed over one stays
// hidden until it has gone (sFade, updateSites).
function clearMargin(ev, ox, oz, yaw, skip, ghosts, fading) { // ghosts: the site's road (-1: none)
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const straddle = DEFS[ev].straddlesRoad;
  const reach = Math.max(FPR[ev] + GEO_CLEAR + 1, DEFS[ev].pad) + 4;
  const r2 = reach * reach;
  let best = 1e9, by = -1, pad = 0;
  for (let f = 0; f < MAX_EDGES; f++) {
    if (f === skip || !edgeAlive[f] || (!edgeKeep[f] && (!fading || edgePresence[f] <= 0))) continue;
    if (!fading && ghosts >= 0 && !onLine(f, ghosts)) continue;
    const N = edgeN[f], base = f * MAX_PTS;
    const lim = edgeFerry[f] ? N : Math.min(N, Math.floor((edgeDrawEnd[f] + DRAW_END_PAD) / STEP) + 1);
    for (let k = 0; k < lim; k += 2) {
      const o = (base + k) * 4;
      const dx = pts[o] - ox, dz = pts[o + 2] - oz;
      if (dx * dx + dz * dz > r2) { if (dx * dx + dz * dz > r2 + 1.2e5) k += 14; continue; }
      const m = pointMargin(ev, c * dx - s * dz, s * dx + c * dz, straddle);
      if (m < best) { best = m; by = f; pad = CLR[2]; }
    }
  }
  if (ghosts >= 0) {
    makeGhosts();
    const gr = reach + 1400, n0 = edgeFrom[ghosts], n1 = edgeTo[ghosts];
    for (let g = 0; g < GSTAT[0]; g++) {
      // Only the junctions that grow while this road is on the route: its own end and its
      // siblings' ends (grown while the car approaches the fork). Others grow only if the car
      // leaves this branch, and the landmark goes with it.
      const gn = GNI[g * 2];
      if (gn !== n1 && !(nodeIn[gn] >= 0 && edgeFrom[nodeIn[gn]] === n0)) continue;
      const ddx = GX[g * 2] - ox, ddz = GX[g * 2 + 1] - oz;
      if (ddx * ddx + ddz * ddz > gr * gr) continue;
      const o = g * GPTS * 2;
      for (let k = 0; k < GN[g]; k++) {
        const dx = GH[o + k * 2] - ox, dz = GH[o + k * 2 + 1] - oz;
        if (dx * dx + dz * dz > r2) continue;
        const m = pointMargin(ev, c * dx - s * dz, s * dx + c * dz, straddle);
        if (m < best) { best = m; by = -2; pad = CLR[2]; CLR[3] = g; }
      }
    }
  }
  const gg = CLR[3];
  CLR[0] = best; CLR[1] = by; CLR[2] = pad; CLR[3] = gg;
  return best;
}
// Is road f still there when the car reaches road e: e itself, a road on the way to it, a
// sibling of e, or a road beyond e or a sibling. Any other road (an uncle, a cousin: other
// branches of the forks before e) fades out once the car commits toward e, while it is still
// more than a kilometre short of e's landmark; placement ignores those, and a landmark placed
// over one stays hidden until it has gone (sFade).
function onLine(f, e) {
  const n0 = edgeFrom[e];
  for (let a = e, k = 0; a >= 0 && k < 8; k++) { if (a === f) return true; const n = edgeFrom[a]; a = n >= 0 && nodeAlive[n] ? nodeIn[n] : -1; }
  for (let a = f, k = 0; a >= 0 && k < 6; k++) { if (edgeFrom[a] === n0) return true; const n = edgeFrom[a]; a = n >= 0 && nodeAlive[n] ? nodeIn[n] : -1; }
  return false;
}
// Landmark yaw for a site on a road of heading h, on side (+1 right of travel).
function siteYaw(h, side) { return Math.atan2(-Math.cos(h), -Math.sin(h)) + (side < 0 ? Math.PI : 0); }

const sEdge = new Int16Array(MAX_SITES).fill(-1);
const sVer = new Uint32Array(MAX_SITES);
const sEv = new Int8Array(MAX_SITES);
const sFade = new Uint8Array(MAX_SITES); // 1: a fading road still runs too close (kept hidden)
const sStage = new Uint8Array(MAX_SITES); // 0 free, 1 planned, 2 building, 3 live
const sF = new Float64Array(MAX_SITES * 8); // s, x, y, z, yaw, pass clock, log radius, seed
const sH = new Array(MAX_SITES).fill(null); // kit handles
const seen = new Uint32Array(1); // events logged this journey (bit mask, EVENT_COUNT <= 31 bits)
let building = -1, buildIt = null;
const shown = new Int16Array(EVENT_COUNT).fill(-1); // per event: the one drawn site (one copy at a time)
const lastNext = new Int32Array(2).fill(-1);
const STAT = new Float64Array(4); // builds, uploads, build ms total, max single-frame build ms
let logFn = null;
let B = null;
const LS = new Float64Array(4); // built, decay, loggable; [3] clock in (landmarkStateIO)
const SENT = new Float64Array(MAX_SITES * 2).fill(-1); // last setState(built, decay) per site
const Q = new Float64Array(8);
const Q2 = new Float64Array(8);
const planned = new Uint32Array(MAX_EDGES); // edgeVersion when planned (0 = not)
export const siteHold = new Uint8Array(1); // the ending's rewind: see the header
// Debug (tools/landmark-shot.mjs --at): >= 0 evaluates every landmark's state at this clock
// instead of the journey's (window.__game.siteClock[0]); -1 = off.
export const siteClock = new Float64Array([-1]);
const HOME = new Int32Array([-1, 0]); // [0] the home's site (-1 none), [1] placed

// Satellites (per site): positions in landmark-local x, z with the world ground height and
// the distance from the origin; y NaN = dropped. Stage 0 none, 1 placing, 2 to build, 3 live.
const MAX_SAT = 12;
const sC = new Array(MAX_SITES).fill(null); // companion kit handles
const sSat = new Float64Array(MAX_SITES * MAX_SAT * 4);
const sSatN = new Uint8Array(MAX_SITES), sSatWant = new Uint8Array(MAX_SITES), sSatTry = new Uint16Array(MAX_SITES);
const sSatStage = new Uint8Array(MAX_SITES), sSatK = new Uint8Array(MAX_SITES);
const sSatRng = new Uint32Array(MAX_SITES);
const SAT_TRIES = 400, SAT_REBUILD_FRAMES = 30;
const sEye = new Float64Array(MAX_SITES * 12); // approach eye points (x, y, z, heading) x 3
const EQ = new Float64Array(8);
const satAge = new Int32Array(1);
const GQ = new Float64Array(8), RQ = new Float64Array(8);
let satSite = -1;
const SAT_DEFS = DEFS.map((d) => (d && d.satellites ? satelliteDef(d) : null));
// Witness
const sWit = new Uint8Array(MAX_SITES); // witnessed (once per approach)
const sTop = new Float64Array(MAX_SITES); // landmark height (max y of its build)
export const witnessIO = new Float64Array(4); // [0] candidate site or -1, [1] event, [2] distance
witnessIO[0] = -1;

export function initSites(onLog) {
  logFn = onLog;
  B = new LandmarkBuilder();
  onEdgeReady(edgeReady);
  onEdgeFreed(edgeFreed);
}

export function resetSites() {
  for (let i = 0; i < MAX_SITES; i++) freeSite(i);
  planned.fill(0);
  seen[0] = 0;
  lastNext[0] = -1;
  CLMIN.fill(1e9); CLB.fill(-1); CLBAD = []; CLRSTAT.fill(0); CLREJ.fill(0); GSTAT[1] = -1;
  for (let i = 0; i < 24; i++) siteData[i] = 0;
}

function freeSite(i) {
  if (HOME[0] === i) { HOME[0] = -1; HOME[1] = 0; }
  for (let v = 0; v < EVENT_COUNT; v++) if (shown[v] === i) shown[v] = -1;
  if (sH[i]) { sH[i].destroy(); sH[i] = null; }
  if (sC[i]) { sC[i].destroy(); sC[i] = null; }
  if (building === i) { building = -1; buildIt = null; }
  sStage[i] = 0; sEdge[i] = -1;
  sSatStage[i] = 0; sSatN[i] = 0; sWit[i] = 0;
  if (witnessIO[0] === i) witnessIO[0] = -1;
}

function edgeFreed(e) {
  for (let i = 0; i < MAX_SITES; i++) if (sEdge[i] === e) freeSite(i);
  planned[e] = 0;
}

// Plan the exits of a fork together, once all of them exist (side choice avoids siblings).
function edgeReady(e) {
  if (!B) return;
  recheckSites(e);
  const n = edgeFrom[e], c = nodeExitCount[n];
  for (let i = 0; i < c; i++) if (nodeExit(n, i) < 0) return;
  for (let i = 0; i < c; i++) {
    const x = nodeExit(n, i);
    if (planned[x] !== edgeVersion[x]) { planned[x] = edgeVersion[x]; planEdge(x); }
  }
  closeBridge(n);
}

// A road was just generated (e): a site it runs too close to moves (its road is planned again)
// unless the car can already see it (built and within 2 km of the camera) on a road still on
// the route; one left beside an abandoned branch (its road faded) is removed.
const RECHECK = new Int16Array(MAX_SITES);
function recheckSites(e) {
  if (NOCLEAR) return;
  let n = 0;
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i] || i === HOME[0]) continue;
    const ev = sEv[i], o = i * 8, f = sEdge[i];
    if (f === e) continue;
    if (clearMargin(ev, sF[o + 1], sF[o + 3], sF[o + 4], DEFS[ev].straddlesRoad ? f : -1, -1, false) >= 0) continue;
    if (sStage[i] === 3 && edgeKeep[f]) { // (a site left on an abandoned branch goes anyway)
      const dx = sF[o + 1] - camera.eye[0], dz = sF[o + 3] - camera.eye[2];
      if (dx * dx + dz * dz < 2000 * 2000) { CLRSTAT[2]++; continue; }
    }
    RECHECK[n++] = i;
  }
  for (let q = 0; q < n; q++) {
    const i = RECHECK[q], f = sEdge[i];
    freeSite(i);
    CLRSTAT[1]++;
    if (f >= 0 && edgeAlive[f] && edgeKeep[f]) { planned[f] = edgeVersion[f]; planEdge(f); }
  }
}

function clockAt(e, s) { return clockBase[0] + (edgeJ0[e] + s - clockBase[1]) / 40; }

// Event placed on this road or the two before it (one landmark per event along a route).
function onRoute(e, ev) {
  for (let k = 0; k < 3 && e >= 0; k++) {
    for (let i = 0; i < MAX_SITES; i++) if (sStage[i] && sEdge[i] === e && sEv[i] === ev) return true;
    e = nodeIn[edgeFrom[e]];
  }
  return false;
}

// Another exit of the same fork already has it (one pyramid on the horizon, not two; the
// autopilot heads for the exit that has it).
function onSibling(e, ev) {
  const n = edgeFrom[e];
  for (let i = 0; i < nodeExitCount[n]; i++) {
    const x = nodeExit(n, i);
    if (x === e || x < 0) continue;
    for (let k = 0; k < MAX_SITES; k++) if (sStage[k] && sEdge[k] === x && sEv[k] === ev) return true;
  }
  return false;
}

// ensure: the road the car is about to take gets an event it has not logged this journey
// even if a sibling road already has it (a second chance for reachability).
// Candidates are tried in order of urgency: the live window closing soonest first.
const ORDER = new Int8Array(EVENT_COUNT);
function planEdge(e, ensure) {
  if (ensure) for (let i = 0; i < MAX_SITES; i++) if (sStage[i] && sEdge[i] === e) return;
  const reg = edgeRegion[e], L = edgeLen[e], c0 = clockAt(e, 0), cross = edgeCross[e];
  let n = 0;
  for (let ev = 0; ev < EVENT_COUNT; ev++) {
    const E = EVENTS[ev];
    if (!DEFS[ev] || E.region !== reg) continue;
    if (E.land !== edgeLand[e] && cross < 0) continue; // other landmass (a crossing road has both)
    ORDER[n++] = ev;
  }
  for (let a = 1; a < n; a++) { // insertion sort by w1 (n is small)
    const v = ORDER[a];
    let b = a - 1;
    while (b >= 0 && EVENTS[ORDER[b]].w1 > EVENTS[v].w1) { ORDER[b + 1] = ORDER[b]; b--; }
    ORDER[b + 1] = v;
  }
  for (let q = 0; q < n; q++) {
    const ev = ORDER[q], E = EVENTS[ev];
    if (onRoute(e, ev)) continue;
    if (ensure ? (seen[0] >>> ev) & 1 : onSibling(e, ev)) continue;
    if (E.start && edgeJ0[e] > 0) continue; // the camp is at the start of the journey
    const def = DEFS[ev];
    const margin = def.straddlesRoad ? def.radius + 160 : Math.max(150, def.pad * 0.6 + 60);
    const endM = def.straddlesRoad ? def.radius + 160 : def.pad + 90;
    let lo = E.w0, hi = E.w1, rem = false;
    if (E.remnant && c0 >= E.remnant[0] - 10) { // the remnant (buried mound), on early roads only
      if (c0 > E.remnant[1] || ensure) continue;
      lo = E.remnant[0]; hi = 1e9; rem = true;
    }
    let s0 = (lo - c0) * 40, s1 = (hi - c0) * 40;
    if (s0 < margin) s0 = margin;
    if (s1 > L - endM) s1 = L - endM;
    if (rem && s1 > s0 + 300) s1 = s0 + 300;
    // A road across the strait: only on the event's own side, well clear of the crossing.
    if (cross >= 0) {
      const chw = edgeCrossHW[e]; // the causeway's strait, or a ferry's water and quays
      if (E.land === edgeLand[e]) { if (s1 > cross - chw - def.pad - 120) s1 = cross - chw - def.pad - 120; }
      else if (s0 < cross + chw + def.pad + 120) s0 = cross + chw + def.pad + 120;
    }
    if (s1 < s0) continue;
    if (place(e, ev, s0, s1, 1) || place(e, ev, s0, s1, 0.7) || (ensure && (place(e, ev, s0, s1, 0.3) || place(e, ev, s0, s1, 0.3, true)))) return;
  }
}

// Picks s in [s0, s1] and the side; fills a free site. Returns true if placed.
// crowd: fraction of the pad that must stay clear of other roads (1 strict; a retry relaxes it).
// anyBiome: last resort for the road the car is about to take (reachability over biome).
function place(e, ev, s0, s1, crowd, anyBiome) {
  const def = DEFS[ev];
  const off = roadOffset(def);
  // Every candidate is scored; only spots in the landmark's own biome (siteBiome >= BIO_MIN)
  // may be chosen. The best-view spot wins when it is in-biome (unchanged placement);
  // otherwise the earliest in-biome spot with VIEW_KEEP of the best in-biome view.
  const reg = EVENTS[ev].region;
  let best = -1e9, bestS = 0, bestSide = 1, bestOk = false, bestIn = -1e9, nc = 0;
  const step = Math.max(10, (s1 - s0) / 24);
  for (let s = s0; s <= s1 + 0.01 && nc < CMAX; s += step) {
    for (let side = 1; side >= -1; side -= 2) {
      if (def.straddlesRoad && side < 0) break;
      Q[4] = s; pointAt(e, Q);
      const h = Q[3];
      const ox = Q[0] - Math.sin(h) * off * side, oz = Q[2] + Math.cos(h) * off * side;
      if (!def.straddlesRoad && crowded(e, ox, oz, (def.pad + 12) * crowd, crowd < 0.5)) continue;
      // Never relaxed: no road, now or later, through the landmark (see "road clearance").
      if (!NOCLEAR && clearMargin(ev, ox, oz, siteYaw(h, side), def.straddlesRoad ? e : -1, e, false) < 0) {
        CLRSTAT[0]++;
        const by = CLR[1];
        if (PLAN_LOG && by >= 0 && by !== e) { PLAN_LOG.push({ road: 1, ev, e, s: Math.round(s), side, m: +CLR[0].toFixed(1), rel: edgeTo[by] === edgeFrom[e] ? 'parent' : edgeFrom[by] === edgeFrom[e] ? 'sibling' : nodeIn[edgeFrom[by]] === nodeIn[edgeFrom[e]] ? 'cousin' : 'other', keep: edgeKeep[by], pres: edgePresence[by], cur: graph.cur, by, byFrom: edgeFrom[by], eFrom: edgeFrom[e] }); if (PLAN_LOG.length > 3000) PLAN_LOG.shift(); }
        if (PLAN_LOG && by === -2) { const gn = GNI[CLR[3] * 2]; PLAN_LOG.push({ ghost: 1, ev, e, s: Math.round(s), side, m: +CLR[0].toFixed(1), rel: gn === edgeTo[e] ? "end" : nodeIn[gn] >= 0 && edgeFrom[nodeIn[gn]] === edgeFrom[e] ? "sibling end" : "other", L: Math.round(edgeLen[e]), gNode: gn }); if (PLAN_LOG.length > 3000) PLAN_LOG.shift(); }
        CLREJ[ev * 5 + (by === -2 ? 3 : by === e ? (CLR[2] === 1 ? 0 : 1) : edgeFrom[by] === edgeFrom[e] ? 2 : 4)]++;
        continue;
      }
      let sc = view(e, s, ox, oz, APPROACH[ev], CONE[ev], VIEW_FROM[ev]);
      if (def.straddlesRoad) sc -= 3 * bend(e, s, def.radius + 40);
      // Passages (round three): clear of every ridge and ~150 m from every passage mouth.
      // (what stands: its footprint envelope, not the bare pad)
      const fr = FPR[ev] || def.radius * 0.6;
      // (the road the car is about to take, crowd < 0.5: reachability first, only off the passage)
      const relax = crowd < 0.5 || ev === 3;
      if (!NOCLEAR && tunnelNear(ox, oz, relax ? 30 : fr * 0.5 + 50)) { CLRSTAT[3]++; continue; }
      if (!NOCLEAR && !relax && WORLD.boundaryDist(ox, oz) < fr * 0.5) { CLRSTAT[3]++; continue; }
      const bw = siteBiome(e, ox, oz, reg), ok = bw >= BIO_MIN;
      CBw[nc] = bw; CS[nc] = s; CSide[nc] = side; CSc[nc] = sc; COk[nc] = ok ? 1 : 0; nc++;
      if (sc > best) { best = sc; bestS = s; bestSide = side; bestOk = ok; }
      if (ok && sc > bestIn) bestIn = sc;
    }
  }
  if (bestIn <= -1e9) {
    // Nothing reaches BIO_MIN: the most in-biome candidate, if it is still mostly that biome.
    let bw = anyBiome ? -1 : BIO_LOW, bc = -1;
    for (let c = 0; c < nc; c++) if (CBw[c] >= bw) { bw = CBw[c]; bc = c; }
    if (bc < 0) {
      if (PLAN_LOG) { let mx = 0; for (let c = 0; c < nc; c++) if (CBw[c] > mx) mx = CBw[c]; PLAN_LOG.push({ ev, e, s0: Math.round(s0), s1: Math.round(s1), crowd, cands: nc, bestBiome: +mx.toFixed(2), by: CROWD[0], byS: CROWD[1], byFrom: edgeFrom[CROWD[0]], eFrom: edgeFrom[e], eTo: edgeTo[e], byKeep: edgeKeep[CROWD[0]], byPres: +edgePresence[CROWD[0]].toFixed(2) }); if (PLAN_LOG.length > 3000) PLAN_LOG.shift(); }
      return false;
    }
    bestS = CS[bc]; bestSide = CSide[bc];
  } else if (!bestOk) {
    const need = bestIn - Math.abs(bestIn) * (1 - VIEW_KEEP);
    for (let c = 0; c < nc; c++) if (COk[c] && CSc[c] >= need) { bestS = CS[c]; bestSide = CSide[c]; break; }
  }
  let k = -1;
  for (let i = 0; i < MAX_SITES; i++) if (!sStage[i]) { k = i; break; }
  if (k < 0) return false;
  if (def.straddlesRoad) straighten(e, bestS, def.radius + 24);
  Q[4] = bestS; pointAt(e, Q);
  const h = Q[3];
  const o = k * 8;
  sF[o] = bestS;
  sF[o + 1] = Q[0] - Math.sin(h) * off * bestSide;
  sF[o + 2] = Q[1];
  sF[o + 3] = Q[2] + Math.cos(h) * off * bestSide;
  // Local -z is the travel direction; local +x points away from the road.
  sF[o + 4] = siteYaw(h, bestSide);
  sF[o + 5] = clockAt(e, bestS);
  sF[o + 6] = off + def.radius * 0.5 + 120;
  sF[o + 7] = (Math.imul(graph.seed | 0, 0x9e3779b1) ^ Math.imul(ev + 1, 0x85ebca6b) ^ Math.imul(e + 7, 0xc2b2ae35)) & 0x7fffffff;
  sEdge[k] = e; sVer[k] = edgeVersion[e]; sEv[k] = ev; sStage[k] = 1;
  // over a road that is fading out: hidden until it has gone
  sFade[k] = !NOCLEAR && clearMargin(ev, sF[o + 1], sF[o + 3], sF[o + 4], def.straddlesRoad ? e : -1, -1, true) < 0 ? 1 : 0;
  return true;
}

// Debug (?plandebug=1): placements that failed for lack of in-biome ground (siteInfo().planFails).
const PLAN_LOG = typeof location !== 'undefined' && new URLSearchParams(location.search).get('plandebug') === '1' ? [] : null;
// Placement candidates (plan time; preallocated).
const CMAX = 64;
const CS = new Float64Array(CMAX), CSc = new Float64Array(CMAX), CBw = new Float64Array(CMAX);
const CSide = new Int8Array(CMAX), COk = new Uint8Array(CMAX);

// Weight of region reg's biome at (x, z) once the roads near it are fully grown in: the
// biome map's kernel sum (world.js kernSum / biomeExact, same sharpen and steppe step) with
// every live road counted at full presence, since the fork's new exits are still fading in
// when they are planned. Plan time only.
// When world.js has biomeFull (7 regions, every live road at full presence) it is used instead.
const BW = new Float64Array(8);
const BF = new Float64Array(12);
function siteBiome(e, x, z, reg) {
  if (typeof WORLD.biomeFull === 'function') { BF[0] = x; BF[1] = z; WORLD.biomeFull(BF); return reg >= 0 && reg < 7 ? BF[2 + reg] : 0; }
  const rb2 = BMAP.rb * BMAP.rb, is2 = 1 / (BMAP.sigma * BMAP.sigma);
  BW.fill(0);
  let a = 0;
  for (let f = 0; f < MAX_EDGES; f++) {
    if (!edgeAlive[f] || (edgeBio[f] <= 0 && edgeFrom[f] !== edgeFrom[e])) continue;
    const own = edgeRegion[f] % 7, par = edgeParentRegion[f] % 7, n = edgeN[f], base = f * MAX_PTS;
    for (let k = 0; k < n; k += BMAP.stride) {
      const o = (base + k) * 4;
      const dx = x - pts[o], dz = z - pts[o + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= rb2) continue;
      const q = 1 + d2 * is2;
      const kk = 1 / (q * q);
      let t = (k * STEP - BMAP.ramp0) / (BMAP.ramp1 - BMAP.ramp0);
      t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
      BW[own] += kk * t; BW[par] += kk * (1 - t);
      a += kk;
    }
  }
  if (a < 1e-12) return 0;
  // Cube sharpen, then the dry band between ice and desert (the slice's steppe step, onto the
  // savannah kit) as world.js does for three regions.
  let sum = 0;
  for (let r = 0; r < 7; r++) { BW[r] = BW[r] * BW[r] * BW[r]; sum += BW[r]; }
  let inv = 1 / Math.max(sum, 1e-30);
  for (let r = 0; r < 7; r++) BW[r] *= inv;
  const m = Math.min(BW[1], BW[2]);
  BW[0] += 1.6 * m; BW[1] -= 0.8 * m; BW[2] -= 0.8 * m;
  return reg >= 0 && reg < 7 ? BW[reg] : 0;
}

// A passage mouth within r of (x, z)? (graph.js plans every passage before sites plan a fork.)
function tunnelNear(x, z, r) {
  for (let f = 0; f < MAX_EDGES; f++) {
    if (!edgeAlive[f] || edgeTunS[f] < 0) continue;
    Q2[4] = edgeTunS[f] - edgeTunH[f]; pointAt(f, Q2);
    const ax = Q2[0], az = Q2[2];
    Q2[4] = edgeTunS[f] + edgeTunH[f]; pointAt(f, Q2);
    const bx = Q2[0] - ax, bz = Q2[2] - az, l2 = bx * bx + bz * bz || 1;
    let t = ((x - ax) * bx + (z - az) * bz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + bx * t - x, dz = az + bz * t - z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
// A passage between approach point (ee, ss) and a landmark on road e at s (the ridge hides it).
function behindPassage(e, s, ee, ss) {
  if (ee === e) return edgeTunS[e] >= 0 && ss < edgeTunS[e] + edgeTunH[e] && s > edgeTunS[e];
  return (edgeTunS[e] >= 0 && s > edgeTunS[e]) || (edgeTunS[ee] >= 0 && ss < edgeTunS[ee] + edgeTunH[ee]);
}

// Another site of the same event within r of (x, z)?
function nearSame(ev, x, z, r) {
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i] || sEv[i] !== ev) continue;
    const dx = sF[i * 8 + 1] - x, dz = sF[i * 8 + 3] - z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

// Any other live road within r of (x, z)?
// fadingOk: roads already fading out (off the route) do not count (the ensure pass: they are
// gone before the car arrives).
function crowded(e, x, z, r, fadingOk) {
  const r2 = r * r;
  for (let f = 0; f < MAX_EDGES; f++) {
    if (f === e || !edgeAlive[f] || (!edgeKeep[f] && (fadingOk || edgePresence[f] <= 0))) continue; // a road that has faded away is gone
    const N = edgeN[f], base = f * MAX_PTS;
    for (let k = 0; k < N; k += 8) {
      const o = (base + k) * 4;
      const dx = pts[o] - x, dz = pts[o + 2] - z;
      if (dx * dx + dz * dz < r2) { CROWD[0] = f; CROWD[1] = k * STEP; return true; }
    }
  }
  return false;
}
const CROWD = new Float64Array(2); // debug: the road (and s) that crowded the last rejected spot

// Fraction of the approach (the A metres of road before s, continuing onto the road before
// this one) from which (ox, oz) lies within ~26 degrees of the heading.
function view(e, s, ox, oz, A, cone, d0) {
  let vis = 0, n = 0;
  const pe = nodeIn[edgeFrom[e]];
  for (let d = d0; d <= A; d += 40) {
    let ee = e, ss = s - d;
    if (ss < 0) { if (pe < 0 || !edgeAlive[pe]) break; ee = pe; ss += edgeLen[pe]; }
    Q2[4] = ss; pointAt(ee, Q2);
    const dx = ox - Q2[0], dz = oz - Q2[2];
    let a = Math.atan2(dz, dx) - Q2[3];
    a = Math.atan2(Math.sin(a), Math.cos(a));
    n++;
    if (Math.abs(a) < cone && (!behindPassage(e, s, ee, ss) || d > A * 0.5)) vis++; // (the near half of the approach must not be behind a passage)
  }
  return n ? vis / n : 0;
}

// Heading change (radians) over +-r around s.
function bend(e, s, r) {
  let mn = 1e9, mx = -1e9;
  for (let d = -r; d <= r; d += 8) {
    Q2[4] = s + d; pointAt(e, Q2);
    if (Q2[3] < mn) mn = Q2[3];
    if (Q2[3] > mx) mx = Q2[3];
  }
  return mx - mn;
}

// Straight and level road over +-r around s (smoothly blended back over 110 m), for a landmark
// the road runs through. The edge is ahead of the car when this runs.
function straighten(e, s, r) {
  const N = edgeN[e], base = e * MAX_PTS;
  const kc = Math.round(s / STEP);
  const oc = (base + kc) * 4;
  const cx = pts[oc], cy = pts[oc + 1], cz = pts[oc + 2], h = heads[base + kc];
  const dx = Math.cos(h), dz = Math.sin(h);
  const R2 = r + 110;
  const k0 = Math.max(1, Math.floor((s - R2) / STEP)), k1 = Math.min(N - 2, Math.ceil((s + R2) / STEP));
  for (let k = k0; k <= k1; k++) {
    const d = (k - kc) * STEP;
    let t = (Math.abs(d) - r) / 110; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const w = 1 - t * t * (3 - 2 * t);
    const o = (base + k) * 4;
    pts[o] += (cx + dx * d - pts[o]) * w;
    pts[o + 2] += (cz + dz * d - pts[o + 2]) * w;
    pts[o + 1] += (cy - pts[o + 1]) * w;
  }
  for (let k = k0; k <= k1; k++) {
    const a = (base + k - 1) * 4, b = (base + k + 1) * 4;
    heads[base + k] = Math.atan2(pts[b + 2] - pts[a + 2], pts[b] - pts[a]);
  }
  // Keep the heading continuous (no 2 pi wraps against the untouched samples).
  for (let k = k0; k <= k1; k++) {
    const p = heads[base + k - 1];
    let v = heads[base + k];
    while (v - p > Math.PI) v -= 2 * Math.PI;
    while (v - p < -Math.PI) v += 2 * Math.PI;
    heads[base + k] = v;
  }
  uploadEdge(e);
  graph.dirty++;
}

// A causeway that will not be frozen when the car could reach it ends at the shore.
function closeBridge(n) {
  const b = nodeBridge[n];
  if (b < 0 || exitAvailable(n, b)) return;
  const e = nodeExit(n, b);
  if (e < 0) return;
  const end = nodeBridgeS[n] - BRIDGE_HW - 30;
  if (edgeDrawEnd[e] > end) { edgeDrawEnd[e] = end; graph.dirty++; }
}

// --------------------------------------------------------------------------------- per frame

const T = new Float64Array(2); // [0] build start (ms)
export function updateSites(budget) {
  const clock = state.clock;
  const cx = pose[0], cz = pose[2];
  // Strait crossings: once closed (time.js straitOpen), causeways the car is not on close at
  // the shore.
  if (!siteHold[0]) {
    for (let n = 0; n < MAX_NODES; n++) {
      const b = nodeBridge[n];
      if (!nodeAlive[n] || b < 0 || !exitAvailable(n, b) || straitOpen(clock, nodeLand[n])) continue;
      const e = nodeExit(n, b);
      if (e >= 0 && (e === graph.cur || e === graph.prev || edgeFrom[graph.cur] === edgeTo[e])) continue;
      markExitUnavailable(n, b);
      closeBridge(n);
    }
  }
  updateStrait();
  SEA[0] = seaData[0]; SEA[1] = seaData[1]; SEA[2] = seaData[2]; // def.animate's a.seaY / seaX / seaZ
  updateCrossing(); // ships and bridges from 1492 (world/crossing.js); may take the strait
  // The road the car is heading for next: make sure history is on it.
  if (graph.cur >= 0) {
    const e2 = nodeExit(edgeTo[graph.cur], car.preferred < 0 ? 0 : car.preferred);
    if (e2 >= 0 && (e2 !== lastNext[0] || edgeVersion[e2] !== lastNext[1])) {
      lastNext[0] = e2; lastNext[1] = edgeVersion[e2];
      if (planned[e2] === edgeVersion[e2]) planEdge(e2, true);
    }
  }

  // Builds: continue the current one, else start the nearest planned site in range (the
  // clock is read only when there is work: performance.now() allocates a number).
  let work = building >= 0 || (HOME[0] >= 0 && sStage[HOME[0]] === 1);
  for (let i = 0; i < MAX_SITES && !work; i++) {
    if (sStage[i] !== 1) continue;
    const dx = sF[i * 8 + 1] - cx, dz = sF[i * 8 + 3] - cz;
    if (dx * dx + dz * dz < BUILD_R * BUILD_R) work = true;
  }
  if (work) T[0] = performance.now();
  for (let guard = 0; work && guard < 64; guard++) {
    if (building < 0) {
      let bi = -1, bd = BUILD_R * BUILD_R;
      for (let i = 0; i < MAX_SITES; i++) {
        if (sStage[i] !== 1 || i === HOME[0]) continue;
        const dx = sF[i * 8 + 1] - cx, dz = sF[i * 8 + 3] - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; bi = i; }
      }
      if (bi < 0 && HOME[0] >= 0 && sStage[HOME[0]] === 1) bi = HOME[0]; // off-stage, last
      if (bi < 0) break;
      startBuild(bi);
    }
    if (buildIt) {
      while (performance.now() - T[0] < budget) { if (buildIt.next().done) { buildIt = null; break; } }
      if (buildIt) break;
    }
    finishBuild();
    if (performance.now() - T[0] >= budget) break;
  }

  updateSatellites(budget);

  // Live sites: state, visibility, the event log. A site whose road has faded away goes once
  // it is out of sight (far, or behind the camera).
  const fx = camera.target[0] - camera.eye[0], fz = camera.target[2] - camera.eye[2];
  const fl = Math.sqrt(fx * fx + fz * fz) || 1;
  let wBest = -1, wD = 1e30;
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i]) continue;
    const e = sEdge[i];
    const home = i === HOME[0];
    if (home && !HOME[1]) { if (sH[i]) sH[i].visible = false; continue; } // built off-stage, not placed yet
    if (!home && edgePresence[e] <= 0 && !edgeKeep[e]) {
      const o = i * 8, dx = sF[o + 1] - camera.eye[0], dz = sF[o + 3] - camera.eye[2];
      const r = DEFS[sEv[i]].radius;
      if (dx * dx + dz * dz > 1800 * 1800 || dx * fx + dz * fz < -r * Math.sqrt(fx * fx + fz * fz)) { freeSite(i); continue; }
    }
    if (sStage[i] !== 3) continue;
    const ev = sEv[i], h = sH[i], o = i * 8;
    LS[3] = siteClock[0] >= 0 ? siteClock[0] : clock;
    const on = landmarkStateIO(ev, LS);
    const dx = sF[o + 1] - cx, dz = sF[o + 3] - cz;
    const d2 = dx * dx + dz * dz;
    // A landmark leaves the world when its time is over, but not under the car's nose.
    h.visible = on || (h.visible && d2 < 700 * 700 && !siteHold[0]);
    // Placed beside a road that was still fading out: shown once that road has gone.
    if (sFade[i]) {
      if (((satAge[0] + i) & 7) === 0 && clearMargin(ev, sF[o + 1], sF[o + 3], sF[o + 4], DEFS[ev].straddlesRoad ? e : -1, -1, true) >= 0) sFade[i] = 0;
      else h.visible = false;
    }
    // One pyramid on the horizon, one Gobekli Tepe in the land: only the shown site of
    // those events (nearest, with hysteresis) is drawn.
    if (ev >= 2) { // (not the camp and the cave: one per route already)
      const g = shown[ev];
      if (g < 0 || sStage[g] !== 3 || sEv[g] !== ev) shown[ev] = i;
      else if (g !== i) {
        const qx = sF[g * 8 + 1] - cx, qz = sF[g * 8 + 3] - cz;
        if (Math.sqrt(d2) + 400 < Math.sqrt(qx * qx + qz * qz)) shown[ev] = i;
      }
      if (shown[ev] !== i) h.visible = false;
    }
    // Only on change: the call boxes its two doubles.
    const sat = sC[i];
    if (on && h.setState && (LS[0] !== SENT[i * 2] || LS[1] !== SENT[i * 2 + 1])) {
      SENT[i * 2] = LS[0]; SENT[i * 2 + 1] = LS[1]; h.setState(LS[0], LS[1]);
      if (sat !== null) sat.setState(LS[0], LS[1]);
    }
    if (sat !== null) sat.visible = h.visible;
    if (home || siteHold[0]) continue; // the ending logs the home itself; the rewind logs nothing
    if (on && h.visible && LS[2] === 1 && d2 < sF[o + 6] * sF[o + 6] && !((seen[0] >>> ev) & 1)) {
      seen[0] |= 1 << ev;
      if (logFn) logFn(ev);
    }
    // Witness candidate: live, not witnessed on this approach, near, and in view (ahead of
    // the camera, or right beside it).
    if (on && h.visible && LS[2] === 1 && sWit[i] === 0) {
      const wr = WRANGE[ev];
      if (d2 < wr * wr) {
        const vx = sF[o + 1] - camera.eye[0], vz = sF[o + 3] - camera.eye[2];
        const vl = Math.sqrt(vx * vx + vz * vz);
        if ((vx * fx + vz * fz) > 0.34 * vl * fl || vl < WBESIDE[ev]) {
          if (d2 < wD) { wD = d2; wBest = i; }
        }
      }
    }
  }
  witnessIO[0] = wBest;
  witnessIO[1] = wBest >= 0 ? sEv[wBest] : -1;
  witnessIO[2] = wBest >= 0 ? Math.sqrt(wD) : 0;
  if (work) { const ms = performance.now() - T[0]; STAT[2] += ms; if (ms > STAT[3]) STAT[3] = ms; }
  writePads();
  if (CLEARLOG) clearLog();
}

// Debug (?clearlog=1, tools/clearance-test.mjs): every drawn landmark is checked against the
// live roads (those fading out too) whenever a road was
// generated or it was just shown; the smallest margin per
// event (and the cases below zero) go to siteInfo().clearance.
// ?noclear=1: placement ignores the road clearance (the old behaviour, for before / after).
// ?nosight=1: no sight wedges (before / after for tools/visibility-test.mjs).
const NOSIGHT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('nosight') === '1';
const NOCLEAR = typeof location !== 'undefined' && new URLSearchParams(location.search).get('noclear') === '1';
const CLEARLOG = typeof location !== 'undefined' && new URLSearchParams(location.search).get('clearlog') === '1';
const CLB = new Int32Array(MAX_SITES).fill(-1), CLMIN = new Float64Array(EVENT_COUNT).fill(1e9);
let CLBAD = [];
function clearLog() {
  for (let i = 0; i < MAX_SITES; i++) {
    if (sStage[i] !== 3 || !sH[i] || !sH[i].visible || i === HOME[0]) { CLB[i] = -1; continue; }
    if (CLB[i] === graph.built) continue;
    CLB[i] = graph.built;
    const ev = sEv[i], o = i * 8;
    const m = clearMargin(ev, sF[o + 1], sF[o + 3], sF[o + 4], DEFS[ev].straddlesRoad ? sEdge[i] : -1, -1, true);
    const mm = m < 5e8 ? m : 5e8; // 5e8: no road anywhere near
    if (mm < CLMIN[ev]) CLMIN[ev] = mm;
    if (m < 0 && CLBAD.length < 64) CLBAD.push({ ev, id: DEFS[ev].id, margin: +m.toFixed(1), road: CLR[1], own: CLR[1] === sEdge[i], pad: CLR[2] === 1, clock: +state.clock.toFixed(1) });
  }
}

function startBuild(i) {
  const ev = sEv[i], o = i * 8;
  // Built as it will look when the car passes (setState animates it live where the kit has it).
  landmarkState(ev, sF[o + 5], LS);
  building = i;
  STAT[0]++;
  buildIt = beginBuild(DEFS[ev], B, LS[0], LS[1], sF[o + 7], edgeRegion[sEdge[i]]);
  sStage[i] = 2;
}

function finishBuild() {
  const i = building;
  if (i < 0) return;
  building = -1;
  const home = i === HOME[0];
  if (sStage[i] !== 2 || (!home && (!edgeAlive[sEdge[i]] || edgeVersion[sEdge[i]] !== sVer[i]))) { sStage[i] = 0; sEdge[i] = -1; if (home) HOME[0] = -1; return; }
  const o = i * 8;
  STAT[1]++;
  sH[i] = uploadLandmark(DEFS[sEv[i]], B, sF[o + 1], sF[o + 2], sF[o + 3], sF[o + 4], sEv[i] * 0.37);
  sH[i].visible = false;
  if (home) sH[i].shadowDistance = 600; // the echo shot looks at it from the yard
  SENT[i * 2] = -1; SENT[i * 2 + 1] = -1;
  sStage[i] = 3;
  // Height of the landmark for the default witness framing (the timeline is all in the build).
  let top = 0;
  const f = B.f;
  for (let v = 0; v < B.nv; v++) { const y = f[v * 8 + 1]; if (y > top) top = y; }
  sTop[i] = top;
  sWit[i] = 0;
  if (SAT_DEFS[sEv[i]]) beginSatellites(i);
}

// ------------------------------------------------------------------------------ satellites

// Wrapper def for a landmark's companion mesh (one per landmark kind, made at load).
function satelliteDef(d) {
  const S = d.satellites;
  return {
    id: d.id + '-sat', name: d.name, caption: d.caption, year: d.year,
    radius: (S.farR ? S.farR[1] : 1000) + 40, pad: 1, straddlesRoad: false, live: true,
    lights: [], wind: d.wind, biome: d.biome,
    build(b) {
      const i = satSite, n = sSatN[i], seed = sF[i * 8 + 7], y0 = sF[i * 8 + 2];
      for (let k = 0; k < n; k++) {
        const q = (i * MAX_SAT + k) * 4;
        if (sSat[q + 1] !== sSat[q + 1]) continue; // dropped
        b.seed(((seed | 0) ^ Math.imul(k + 1, 0x9e3779b1)) & 0x7fffffff);
        b.timeless().identity();
        b.push();
        b.translate(sSat[q], sSat[q + 1] - y0, sSat[q + 2]);
        b.rotateY(b.rand() * 6.283);
        S.build(b, k, n, sSat[q + 3]);
        b.pop();
      }
      return b.counts();
    },
  };
}

function satRand(i) {
  let x = sSatRng[i];
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  sSatRng[i] = x;
  return x / 4294967296;
}

function beginSatellites(i) {
  const S = DEFS[sEv[i]].satellites;
  sSatRng[i] = ((sF[i * 8 + 7] | 0) ^ 0x2545f491) >>> 0 || 1;
  for (let k = 0; k < 4; k++) satRand(i);
  const c0 = S.count ? S.count[0] : 6, c1 = S.count ? S.count[1] : c0;
  sSatWant[i] = Math.min(MAX_SAT, c0 + Math.floor(satRand(i) * (c1 - c0 + 1)));
  sSatN[i] = 0; sSatTry[i] = 0; sSatK[i] = 0;
  sSatStage[i] = 1;
  // Where the driver sees it from: three points on the approach (road behind the site).
  const e = sEdge[i], s0 = sF[i * 8];
  for (let k = 0; k < 3; k++) {
    let ss = s0 - (k === 0 ? 340 : k === 1 ? 200 : 70);
    if (ss < 2) ss = 2;
    EQ[4] = ss; pointAt(e, EQ);
    sEye[i * 12 + k * 4] = EQ[0]; sEye[i * 12 + k * 4 + 1] = EQ[1] + 1.6; sEye[i * 12 + k * 4 + 2] = EQ[2]; sEye[i * 12 + k * 4 + 3] = EQ[3];
  }
}

// From how many approach points is a companion at (x, y, z) (y: its ground) in view: within
// the chase camera's frame (0.7 rad of the heading) with a clear line of sight over the
// terrain (plus grass height) to 3 m above it. Load time only (~20 ground samples).
function satSeen(i, x, y, z) {
  let n = 0;
  for (let k = 0; k < 3; k++) {
    const o = i * 12 + k * 4, ex = sEye[o], ey = sEye[o + 1], ez = sEye[o + 2], h = sEye[o + 3];
    const dx = x - ex, dz = z - ez;
    let a = Math.atan2(dz, dx) - h;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (Math.abs(a) > 0.7) continue;
    const ty = y + 3;
    let clear = true;
    for (let q = 1; q < 8 && clear; q++) {
      const t = q / 8;
      GQ[6] = ex + dx * t; GQ[7] = ez + dz * t; groundInfo(GQ);
      if (GQ[0] + 0.9 > ey + (ty - ey) * t) clear = false;
    }
    if (clear) n++;
  }
  return n;
}

// Ground at (x, z) usable for a companion? Writes GQ[0] = height. clear: road clearance (m).
function satGround(i, x, z, clear) {
  RQ[5] = x; RQ[6] = z; nearestRoad(RQ, 0);
  if (RQ[0] < clear) return false;
  // Clear of every landmark pad (its own included).
  for (let j = 0; j < MAX_SITES; j++) {
    if (!sStage[j]) continue;
    const dx = sF[j * 8 + 1] - x, dz = sF[j * 8 + 3] - z, r = DEFS[sEv[j]].pad + 30;
    if (dx * dx + dz * dz < r * r) return false;
  }
  GQ[6] = x + 4; GQ[7] = z; groundInfo(GQ); const hx = GQ[0];
  GQ[6] = x; GQ[7] = z + 4; groundInfo(GQ); const hz = GQ[0];
  GQ[6] = x; GQ[7] = z; groundInfo(GQ);
  if (groundExtra[4] > 0.3 || groundExtra[5] > 0.02 || groundExtra[6] > 0.02) return false; // flood plain, channel, lake / strait
  return Math.abs(hx - GQ[0]) < 2.2 && Math.abs(hz - GQ[0]) < 2.2;
}

// Placement (a few tries per frame), the companion build, and the per-frame ground check.
function updateSatellites(budget) {
  satAge[0]++;
  let t0 = -1;
  for (let i = 0; i < MAX_SITES; i++) {
    const st = sSatStage[i];
    if (st === 0 || sStage[i] !== 3) continue;
    const S = DEFS[sEv[i]].satellites, o = i * 8;
    if (st === 1) {
      if (t0 < 0) t0 = performance.now();
      const yaw = sF[o + 4], c = Math.cos(yaw), s = Math.sin(yaw);
      const near = S.near || 0, nearR = S.nearR || [100, 300], farR = S.farR || [300, 1000];
      const centre = S.centre || 0, spread = S.spread || 6.2832, sep = S.minSep || 60, clear = S.roadClear || 40;
      while (sSatN[i] < sSatWant[i] && sSatTry[i] < SAT_TRIES) {
        sSatTry[i]++;
        const isNear = sSatN[i] < near, R = isNear ? nearR : farR;
        const d = R[0] + (R[1] - R[0]) * Math.sqrt(satRand(i));
        const a = centre + (satRand(i) - 0.5) * spread;
        const lx = Math.cos(a) * d, lz = Math.sin(a) * d;
        const wx = c * lx + s * lz + sF[o + 1], wz = -s * lx + c * lz + sF[o + 3];
        let ok = true;
        for (let k = 0; k < sSatN[i] && ok; k++) {
          const q = (i * MAX_SAT + k) * 4, ddx = sSat[q] - lx, ddz = sSat[q + 2] - lz;
          if (ddx * ddx + ddz * ddz < sep * sep) ok = false;
        }
        if (ok && satGround(i, wx, wz, clear)) {
          const gy = GQ[0];
          // Seen from the road: strict first, relaxed late in the search.
          const need = S.visible ? (sSatTry[i] < SAT_TRIES * 0.7 ? S.visible : sSatTry[i] < SAT_TRIES * 0.9 ? 1 : 0) : 0;
          if (need === 0 || satSeen(i, wx, gy, wz) >= need) {
            const q = (i * MAX_SAT + sSatN[i]) * 4;
            sSat[q] = lx; sSat[q + 1] = gy; sSat[q + 2] = lz; sSat[q + 3] = d;
            sSatN[i]++;
          }
        }
        if (performance.now() - t0 > (budget > 1e6 ? 40 : budget < 1 ? budget : 1)) break;
      }
      if (sSatN[i] >= sSatWant[i] || sSatTry[i] >= SAT_TRIES) sSatStage[i] = 2;
      else continue;
    }
    if (sSatStage[i] === 2) {
      if (building >= 0 || buildIt) continue; // the builder is busy with a landmark
      buildSatellites(i);
      continue;
    }
    // Live: re-check one companion per frame while the site is shown.
    const h = sH[i];
    if (!h || !h.visible || sSatN[i] === 0) continue;
    const k = sSatK[i] % sSatN[i];
    sSatK[i] = (k + 1) % sSatN[i];
    const q = (i * MAX_SAT + k) * 4;
    if (sSat[q + 1] !== sSat[q + 1]) continue;
    const yaw = sF[o + 4], c = Math.cos(yaw), s = Math.sin(yaw);
    const wx = c * sSat[q] + s * sSat[q + 2] + sF[o + 1], wz = -s * sSat[q] + c * sSat[q + 2] + sF[o + 3];
    RQ[5] = wx; RQ[6] = wz; nearestRoad(RQ, 0);
    let dirty = false;
    if (RQ[0] < (S.roadClear || 40) * 0.7) { sSat[q + 1] = NaN; dirty = true; }
    else {
      GQ[6] = wx; GQ[7] = wz; groundInfo(GQ);
      if (Math.abs(GQ[0] - sSat[q + 1]) > 0.3) { sSat[q + 1] = GQ[0]; dirty = true; }
    }
    if (dirty) sSatStage[i] = 4; // rebuild when the builder is free (rate-limited)
  }
  for (let i = 0; i < MAX_SITES; i++) {
    if (sSatStage[i] !== 4 || sStage[i] !== 3 || building >= 0 || buildIt) continue;
    if (satAge[0] < SAT_REBUILD_FRAMES) continue;
    buildSatellites(i);
    break;
  }
}

function buildSatellites(i) {
  if (sC[i]) { sC[i].destroy(); sC[i] = null; }
  sSatStage[i] = 3;
  satAge[0] = 0;
  let live = 0;
  for (let k = 0; k < sSatN[i]; k++) if (sSat[(i * MAX_SAT + k) * 4 + 1] === sSat[(i * MAX_SAT + k) * 4 + 1]) live++;
  if (!live) return;
  const o = i * 8, ev = sEv[i];
  landmarkState(ev, state.clock, LS);
  satSite = i;
  beginBuild(SAT_DEFS[ev], B, LS[0], LS[1], sF[o + 7], edgeRegion[sEdge[i]]);
  satSite = -1;
  const h = uploadLandmark(SAT_DEFS[ev], B, sF[o + 1], sF[o + 2], sF[o + 3], sF[o + 4], ev * 0.37 + 0.5);
  h.visible = sH[i] ? sH[i].visible : false;
  if (SENT[i * 2] >= 0) h.setState(SENT[i * 2], SENT[i * 2 + 1]);
  // Companions are small and far: no point in their shadows beyond the near cascade.
  h.shadowDistance = 250 + 160;
  sC[i] = h;
}

// ------------------------------------------------------------------------------ witness

// Frames the current candidate (witnessIO[0]) into out and logs it (same path as a drive-by).
// out: [0..2] look-at (world), [3] eye distance (horizontal), [4] eye azimuth (world, about
// the look-at point), [5] eye height (world), [6] fov, [7] drift (rad over the moment),
// [8] event, [10] 1 if this logged the event now (its flourish already played), else 0.
// Returns the event id, or -1. Load-time cost only (once per press).
export function witnessBegin(out) {
  const i = witnessIO[0] | 0;
  if (i < 0 || sStage[i] !== 3) return -1;
  const ev = sEv[i], def = DEFS[ev], w = def.witness || NOW, o = i * 8;
  const R = def.radius, H = Math.max(2, sTop[i]);
  const yaw = sF[o + 4], c = Math.cos(yaw), s = Math.sin(yaw);
  const ox = sF[o + 1], oy = sF[o + 2], oz = sF[o + 3];
  const at = w.at || ZERO2;
  const dist = w.dist ?? Math.max(H * 2.7, R * 1.35, 22);
  const lookY = w.look ?? H * 0.42;
  const eyeY = w.height ?? H * 0.45 + dist * 0.14;
  const az = w.az ?? 0.55;
  // look-at point (local at -> world)
  const lx = c * at[0] + s * at[1] + ox, lz = -s * at[0] + c * at[1] + oz;
  out[0] = lx; out[1] = oy + lookY; out[2] = lz;
  // eye direction (local: az 0 = toward the road side (-x), > 0 toward the approach (+z))
  const ldx = -Math.cos(az), ldz = Math.sin(az);
  const wdx = c * ldx + s * ldz, wdz = -s * ldx + c * ldz;
  out[3] = dist; out[4] = Math.atan2(wdz, wdx);
  // (Drift amounts were tuned for a 6 s moment; the 10 s one turns 1.4x as far, a little slower.)
  out[6] = w.fov ?? 0.62; out[7] = (w.drift ?? 0.08) * 1.4; out[8] = ev;
  // Keep the eye above the ground over the whole drift.
  let y = oy + eyeY;
  for (let k = -2; k <= 2; k++) {
    const a = out[4] + out[7] * 0.25 * k;
    GQ[6] = lx + Math.cos(a) * dist; GQ[7] = lz + Math.sin(a) * dist; groundInfo(GQ);
    if (GQ[0] + 2.5 > y) y = GQ[0] + 2.5;
  }
  out[5] = y;
  sWit[i] = 1;
  witnessIO[0] = -1;
  out[10] = 0;
  if (!((seen[0] >>> ev) & 1)) {
    seen[0] |= 1 << ev;
    out[10] = 1;
    if (logFn) logFn(ev);
  }
  return ev;
}

// Up to MAX_PADS pads, nearest the car first (planned sites too: the ground is ready before
// the mesh).
const PD = new Float64Array(MAX_SITES);
function writePads() {
  const cx = pose[0], cz = pose[2];
  padTight[0] = 0;
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i] || (i === HOME[0] && !HOME[1])) { PD[i] = 1e30; continue; }
    const dx = sF[i * 8 + 1] - cx, dz = sF[i * 8 + 3] - cz;
    PD[i] = dx * dx + dz * dz;
  }
  for (let p = 0; p < MAX_PADS; p++) {
    let bi = -1, bd = 1e29;
    for (let i = 0; i < MAX_SITES; i++) if (PD[i] < bd) { bd = PD[i]; bi = i; }
    const o = p * 4;
    if (bi < 0) { siteData[o] = 0; siteData[o + 1] = 0; siteData[o + 2] = 0; siteData[o + 3] = 0; siteSight[o + 2] = 0; continue; }
    PD[bi] = 1e30;
    if (bi === HOME[0]) padTight[0] = p + 1; // settle.js: neighbours right up to the lot
    siteData[o] = sF[bi * 8 + 1]; siteData[o + 1] = sF[bi * 8 + 3];
    siteData[o + 2] = DEFS[sEv[bi]].pad; siteData[o + 3] = sF[bi * 8 + 2];
    // The sight wedge (world.js siteSight): none for the home and a landmark over the road.
    const def = DEFS[sEv[bi]];
    if (bi === HOME[0] || def.straddlesRoad || sEdge[bi] < 0 || NOSIGHT) { siteSight[o + 2] = 0; continue; }
    const lo = Math.min(roadOffset(def), 600);
    siteSight[o] = edgeJ0[sEdge[bi]] + sF[bi * 8];
    siteSight[o + 1] = lo;
    siteSight[o + 2] = SIGHT_APPROACH;
    siteSight[o + 3] = Math.max(0, Math.min(0.8 * (FPR[sEv[bi]] || def.radius), 650 - lo));
  }
}

// The nearest causeway (built, visible) drives the strait uniform.
function updateStrait() {
  const clock = state.clock, cx = pose[0], cz = pose[2];
  let bn = -1, bd = 1e30;
  for (let n = 0; n < MAX_NODES; n++) {
    if (!nodeAlive[n] || nodeBridge[n] < 0) continue;
    const e = nodeExit(n, nodeBridge[n]);
    if (e < 0 || !edgeAlive[e] || edgePresence[e] <= 0) continue;
    Q[4] = nodeBridgeS[n]; pointAt(e, Q);
    const dx = Q[0] - cx, dz = Q[2] - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; bn = n; }
  }
  if (bn < 0) { siteData[20] = 0; return; }
  const b = nodeBridge[bn], e = nodeExit(bn, b);
  Q[4] = nodeBridgeS[bn]; pointAt(e, Q);
  siteData[16] = Q[0]; siteData[17] = Q[2];
  siteData[18] = Math.cos(Q[3]); siteData[19] = Math.sin(Q[3]);
  siteData[20] = BRIDGE_HW;
  siteData[21] = Q[1] - 1.7;
  let open = (clock - LAND_BRIDGE_CLOCK) / 2.5;
  open = open < 0 ? 0 : open > 1 ? 1 : open;
  if (!exitAvailable(bn, b) && !(e === graph.cur)) open = 1;
  siteData[22] = open;
  siteData[23] = b === 0 ? -1 : 1;
}

// ------------------------------------------------------------------------------ the home

// Reserve a site for the home and build its mesh off-stage (budgeted, after any other build).
export function prebuildHome() {
  if (HOME[0] >= 0 || !DEFS[EV_HOME]) return;
  let k = -1;
  for (let i = 0; i < MAX_SITES; i++) if (!sStage[i]) { k = i; break; }
  if (k < 0) return;
  const o = k * 8;
  sF[o] = 0; sF[o + 1] = 1e6; sF[o + 2] = -1e3; sF[o + 3] = 1e6; sF[o + 4] = 0; sF[o + 5] = 300; sF[o + 6] = 0;
  sF[o + 7] = (Math.imul(graph.seed | 0, 0x9e3779b1) ^ 0x2c1b3c6d) & 0x7fffffff;
  sEdge[k] = -1; sVer[k] = 0; sEv[k] = EV_HOME; sStage[k] = 1;
  HOME[0] = k; HOME[1] = 0;
}
export function homeReady() { return HOME[0] >= 0 && sStage[HOME[0]] === 3; }

// Is the spot at road e, s, on side (+1 right of travel) usable for the home: its lot (pad + a
// margin) clear of every other road and landmark pad, no water, ground not too steep, inside the
// drawn road. Writes HQ: [0..2] origin x, y, z, [3] yaw, [4] road heading. Plan time only.
export const HQ = new Float64Array(8);
export function homeSpotOk(e, s, side, strict) {
  const def = DEFS[EV_HOME];
  if (!def || e < 0 || !edgeAlive[e]) return false;
  const off = roadOffset(def), pad = def.pad;
  if (s < 90 || s > Math.min(edgeLen[e], edgeDrawEnd[e]) - 90) return false;
  if (edgeCross[e] >= 0 && Math.abs(s - edgeCross[e]) < edgeCrossHW[e] + 260) return false;
  // The street never runs through a passage: no mouth near the home, none between it and the car.
  if (edgeTunS[e] >= 0 && s > edgeTunS[e] - edgeTunH[e] - 220 && (e !== car.track || car.s < edgeTunS[e] + edgeTunH[e] + 60)) return false;
  if (e !== car.track && car.track >= 0 && edgeTunS[car.track] >= 0 && car.s < edgeTunS[car.track] + edgeTunH[car.track] + 60) return false;
  homeFrame(e, s, side, off);
  const ox = HQ[0], oz = HQ[2];
  if (strict && bend(e, s, 70) > 0.12) return false;
  if (crowded(e, ox, oz, pad + (strict ? 26 : 12), false)) return false;
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i] || i === HOME[0]) continue;
    const dx = sF[i * 8 + 1] - ox, dz = sF[i * 8 + 3] - oz, r = DEFS[sEv[i]].pad + pad + (strict ? 160 : 40);
    if (dx * dx + dz * dz < r * r) return false;
  }
  // water and slope over the lot (centre and a ring)
  for (let k = 0; k < 9; k++) {
    const a = k * 0.785, r = k ? pad * 0.9 : 0;
    GQ[6] = ox + Math.cos(a) * r; GQ[7] = oz + Math.sin(a) * r; groundInfo(GQ);
    if (groundExtra[5] > 0.02 || groundExtra[6] > 0.02 || groundSea[0] > 0.02) return false;
    if (strict && Math.abs(GQ[0] - Q[1]) > 9) return false;
  }
  return true;
}

function homeFrame(e, s, side, off) {
  Q[4] = s; pointAt(e, Q);
  const h = Q[3];
  HQ[0] = Q[0] - Math.sin(h) * off * side; HQ[1] = Q[1]; HQ[2] = Q[2] + Math.cos(h) * off * side; HQ[4] = h;
  HQ[3] = Math.atan2(-Math.cos(h), -Math.sin(h)) + (side < 0 ? Math.PI : 0);
}

// Stand the home at road e, s, side (the spot homeSpotOk just judged: HQ). Builds it now if the
// off-stage build has not finished. Returns the site index.
export function placeHome(e, s, side) {
  if (HOME[0] < 0) prebuildHome();
  const k = HOME[0];
  if (k < 0) return -1;
  if (sStage[k] !== 3) {
    if (building >= 0 && building !== k) { while (buildIt && !buildIt.next().done); buildIt = null; finishBuild(); }
    if (building !== k) startBuild(k);
    while (buildIt && !buildIt.next().done);
    buildIt = null; finishBuild();
  }
  homeFrame(e, s, side, roadOffset(DEFS[EV_HOME]));
  const o = k * 8;
  sF[o] = s; sF[o + 1] = HQ[0]; sF[o + 2] = HQ[1]; sF[o + 3] = HQ[2]; sF[o + 4] = HQ[3]; sF[o + 5] = 300; sF[o + 6] = 0;
  sEdge[k] = e; sVer[k] = edgeVersion[e];
  sH[k].setPose(HQ[0], HQ[1], HQ[2], HQ[3]);
  sH[k].visible = true;
  SENT[k * 2] = -1;
  HOME[1] = 1;
  return k;
}
// The placed home: out[0..3] origin x, y, z, yaw; false if none.
export function homePose(out) {
  const k = HOME[0];
  if (k < 0 || !HOME[1]) return false;
  out[0] = sF[k * 8 + 1]; out[1] = sF[k * 8 + 2]; out[2] = sF[k * 8 + 3]; out[3] = sF[k * 8 + 4];
  return true;
}
// Mark an event logged this journey without the drive-by's caption (the ending's home).
export function markSeen(ev) { seen[0] |= 1 << ev; }

// Events logged this journey (bit mask; the autopilot plans toward the others).
export function seenMask() { return seen[0]; }

// Does road e carry a landmark whose event can still be logged when the car gets there?
export function edgeHasSite(e) {
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i] || sEdge[i] !== e) continue;
    landmarkState(sEv[i], sF[i * 8 + 5], LS);
    if (LS[2] === 1) return true;
  }
  return false;
}

// Planner value of the landmarks on road e still to log this journey (0 none): the most urgent
// one's 12 - 10 x min(1, slack / 60), slack = seconds its log window stays open after the pass
// (a landmark already standing there is worth 2 more than one the road could still get).
export function edgeSiteValue(e) {
  let v = 0;
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i] || sEdge[i] !== e || (seen[0] >>> sEv[i]) & 1) continue;
    landmarkState(sEv[i], sF[i * 8 + 5], LS);
    if (LS[2] !== 1) continue;
    let k = (EVENTS[sEv[i]].t1 - sF[i * 8 + 5]) / 60;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const u = 12 - 10 * k + EVENTS[sEv[i]].prio;
    if (u > v) v = u;
  }
  return v;
}

// Pass clock of event ev's landmark on road e, or -1 (pose setup; boxes a double).
export function sitePass(ev, e) {
  for (let i = 0; i < MAX_SITES; i++) if (sStage[i] && sEdge[i] === e && sEv[i] === ev) return sF[i * 8 + 5];
  return -1;
}

// Debug: the ghost exits (allocates): [{ node, exit, pts: [[x, z], ...] }].
export function ghostInfo() {
  GSTAT[1] = -1; makeGhosts();
  const out = [];
  for (let g = 0; g < GSTAT[0]; g++) { const p = []; for (let k = 0; k < GN[g]; k++) p.push([GH[(g * GPTS + k) * 2], GH[(g * GPTS + k) * 2 + 1]]); out.push({ node: GNI[g * 2], exit: GNI[g * 2 + 1], pts: p }); }
  return out;
}

// Debug / tests: the current sites (allocates).
export function siteInfo() {
  const out = [];
  for (let i = 0; i < MAX_SITES; i++) {
    if (!sStage[i]) continue;
    const o = i * 8;
    out.push({ ev: sEv[i], id: DEFS[sEv[i]].id, home: i === HOME[0], placed: i === HOME[0] ? HOME[1] : 1, yaw: +sF[o + 4].toFixed(4), edge: sEdge[i], s: Math.round(sF[o]), x: Math.round(sF[o + 1]), z: Math.round(sF[o + 3]), y: +sF[o + 2].toFixed(1),
      passClock: +sF[o + 5].toFixed(1), alive: edgeAlive[sEdge[i]] === 1 && edgeVersion[sEdge[i]] === sVer[i], presence: +edgePresence[sEdge[i]].toFixed(2), stage: ['free', 'planned', 'building', 'live'][sStage[i]], visible: sH[i] ? sH[i].visible : false,
      seed: sF[o + 7], pos: [sF[o + 1], sF[o + 2], sF[o + 3], sF[o + 4]], region: edgeRegion[sEdge[i]], built: sH[i] ? sH[i].built : 0, decay: sH[i] ? sH[i].decay : 0,
      top: sTop[i], foot: FPR[sEv[i]], journey: sEdge[i] >= 0 ? edgeJ0[sEdge[i]] + sF[o] : 0, triangles: sH[i] ? sH[i].triangles : 0, fxTriangles: sH[i] ? sH[i].fxTriangles : 0, hasSetState: !!(sH[i] && sH[i].setState),
      satellites: sSatN[i], satTriangles: sC[i] ? sC[i].triangles : 0, satFx: sC[i] ? sC[i].fxTriangles : 0,
      satPos: Array.from({ length: sSatN[i] }, (_, k) => [Math.round(sSat[(i * MAX_SAT + k) * 4 + 3]), Math.round(Math.atan2(sSat[(i * MAX_SAT + k) * 4 + 2], sSat[(i * MAX_SAT + k) * 4]) * 100) / 100]) });
  }
  const bridges = [];
  for (let n = 0; n < MAX_NODES; n++) if (nodeAlive[n] && nodeBridge[n] >= 0) bridges.push({ node: n, exit: nodeBridge[n], s: nodeBridgeS[n], available: exitAvailable(n, nodeBridge[n]), edge: nodeExit(n, nodeBridge[n]) });
  let alive = 0, zero = 0;
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e]) { alive++; if (edgePresence[e] <= 0) zero++; }
  return { cur: { edge: graph.cur, region: edgeRegion[graph.cur], startClock: +clockAt(graph.cur, 0).toFixed(1), len: Math.round(edgeLen[graph.cur]), land: edgeLand[graph.cur], cross: edgeCross[graph.cur] }, edgesAlive: alive, edgesFaded: zero, builds: STAT[0], uploads: STAT[1], buildMs: Math.round(STAT[2]), maxFrameMs: +STAT[3].toFixed(1), sites: out, bridges, strait: Array.from(siteData.subarray(16, 24), (v) => +v.toFixed(2)), seen: seen[0], planFails: PLAN_LOG ? PLAN_LOG.slice() : null,
    clearance: { min: Array.from(CLMIN, (v) => (v >= 1e9 ? null : +v.toFixed(1))), bad: CLBAD.slice(), rejected: CLRSTAT[0], why: Array.from(CLREJ), moved: CLRSTAT[1], lateSeen: CLRSTAT[2] } };
}
if (typeof window !== 'undefined') window.__sites = { ghosts: ghostInfo };
