// The region graph: a seeded, lazily generated, endless tree of junctions and roads.
//
// Nodes are junctions; each has 2-3 exits ("forks", sorted left to right) roughly every
// 1.2 km. Each exit is an edge: a smooth road centreline sampled every STEP metres, tagged
// with a region id (0 savannah, 1 ice, 2 river desert). Everything is deterministic from
// state.seed and the exits taken: a node's random stream is derived from its parent's key
// and the exit index, so the same choices always produce the same world.
//
// Lookahead: the car's current edge, its end junction's exits, and those exits' end
// junctions' exits are always generated (two forks of lookahead). When the car commits to
// an exit (commit()), everything off that path fades out (presence 1 -> 0 over ~8 s, then
// the slot is freed) and the next level is queued. pump() generates queued edges, one per
// call, so a commit never builds more than one edge in a frame.
//
// Storage is pooled typed arrays: MAX_EDGES edge slots, MAX_NODES node slots, no
// allocation after module load.
//
// For the next workers (time, landmarks, land bridge, loop):
//   pointAt(e, out)              out[4] = s in; out[0..3] = world x, road y, z, heading
//   frameAt(e, out)              out[4] = s, out[5] = lat in; same, offset to the right
//   project(e, out, span), nearestRoad(out, fadeW)   see below (inputs in out[5..7])
//   edgeRegion[e], edgeLen[e], edgeJ0[e] (journey metres at s = 0; clock = (J0 + s) / 40),
//   edgeFrom[e] / edgeTo[e] (node slots), nodeExit(n, i), nodeExitCount[n]
//   onEdgeReady(fn(e)) / onEdgeFreed(fn(e))    edge slot built / freed (latch landmark state here)
//   markExitUnavailable(n, i) / exitAvailable(n, i)  the gated land bridge; commits skip it
//   edgeDrawEnd[e]               the road surface stops at this s (e.g. at the shore)
//   resetGraph(seed)             fresh world (the loop)
//
// Later crossings (from 1492, world/crossing.js draws them): a fork may offer a "ferry" exit
// (nodeFerry[n]), both ways between the landmasses. That road runs ~500 m to a stone quay at
// edgeQuayS[e] (level edgeQuayY[e]; the road surface is drawn only up to there), then straight
// over FERRY_WATER m of strait to the far quay, where it ends at a single-exit node
// (nodeQuay[m]) whose one road leads inland. edgeFerry[e]: 1 ship, 2 ship that gives way to
// the modern bridge when the clock passes BRIDGE_CLOCK (decided by where the car is then).
// Offer rule (planHistory): from the fork whose quay the car reaches at SHIP_CLOCK or later
// (near side: from clock 186, after the crowded windows around 1492), a three-way fork offers
// one with p = 0.6; from clock 190 (past the crowded windows around
// 1492) a two-way fork with p = 0.5 unless one of the two forks before it offered one or was
// a quay. exitCrosses(n, i): land bridge or ferry.

import { NIO, noiseBase, hashU, HASH_SCALE } from './noise.js';
import { LAND_BRIDGE_CLOCK, straitOpen, wantRegion, SHIP_CLOCK, BRIDGE_CLOCK } from './time.js';

function smoothstep(a, b, x) { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

export const STEP = 2; // metres between centreline samples
export const MAX_PTS = 656; // samples per edge (edges are 1100-1300 m)
export const MAX_EDGES = 40; // (round three: 40, so roads still showing their territory are not evicted)
export const MAX_NODES = 48;
export const REGIONS = 7; // 0 savannah, 1 ice, 2 river desert, 3 forest, 4 steppe, 5 mountains, 6 coast
// Debug (?biome=N, main.js): the root road's region, and (?biomelock=1) every exit kept in it.
export const regionDebug = new Int8Array([0, -1, 0]); // [start region, locked region or -1, start landmass (?startland=1)]
const MAIN_HEADING = 0; // the world drifts toward +x overall
const TURN_IN = 180; // metres over which an exit swings to its exit angle
const FADE_IN = 0.25, FADE_OUT = 0.125; // presence change per second
export const SIM_DT = 1 / 120; // updateGraph() advances presence by one fixed sim step

// --- edge pool
export const pts = new Float32Array(MAX_EDGES * MAX_PTS * 4); // x, roadY, z, journey metres
export const heads = new Float32Array(MAX_EDGES * MAX_PTS); // heading (radians) per sample
export const edgeAlive = new Uint8Array(MAX_EDGES); // slot holds a built edge
export const edgeKeep = new Uint8Array(MAX_EDGES); // 1 = on the live set, 0 = fading out
export const edgePresence = new Float32Array(MAX_EDGES); // 0..1 (field / terrain fade)
export const edgeN = new Uint16Array(MAX_EDGES); // sample count
export const edgeLen = new Float32Array(MAX_EDGES);
export const edgeJ0 = new Float32Array(MAX_EDGES); // journey metres at s = 0
export const edgeFrom = new Int16Array(MAX_EDGES);
export const edgeTo = new Int16Array(MAX_EDGES);
export const edgeExit = new Uint8Array(MAX_EDGES); // exit index at edgeFrom
export const edgeRegion = new Uint8Array(MAX_EDGES);
export const edgeDrawEnd = new Float32Array(MAX_EDGES); // road surface drawn up to this s
// A closed causeway's road (sites.js sets its draw end short of the strait) runs this much
// further, down the bank into the water, so the flooded crossing reads at the shore.
export const DRAW_END_PAD = 85;
export const edgeVersion = new Uint32Array(MAX_EDGES); // bumped when the slot is rebuilt
// Biome influence (spatial biome map, see road.js renderBiome): the road's region holds its
// ground for a while after the road itself fades out, so a landscape you can still see does
// not morph. Fades in with the road; fades out only once the edge is far from the car.
export const edgeBio = new Float32Array(MAX_EDGES);
export const edgeParentRegion = new Uint8Array(MAX_EDGES); // region of the road it forks from
export const graphFocus = new Float64Array(2); // car x, z (written by drive.js each sim step)
// Biome seams (round three: tunnels). A road whose region differs from the road it forks from
// changes biome at one point, its split: before it the ground is the parent's biome, after it
// its own (world.js label map). edgeSeam[e]: 0 none, 1 a ridge with a passage (tunnel.js) at
// edgeTunS[e] (the passage centre, half length edgeTunH[e]), 2 a strait road (ferry: the split
// is the middle of the water, no ridge). The passage is planned once every exit of the fork
// exists (planTunnels, before the edge-ready hooks of the last exit), so landmarks and
// settlements are laid out around it; until then edgeSplit holds a provisional value.
export const edgeSeam = new Uint8Array(MAX_EDGES);
export const edgeSplit = new Float32Array(MAX_EDGES).fill(-1);
export const edgeTunS = new Float32Array(MAX_EDGES).fill(-1);
export const edgeTunH = new Float32Array(MAX_EDGES);
export const edgeTunClear = new Float32Array(MAX_EDGES); // debug: clearance from other roads at the passage (m)
export const TUN_MIN_IN = 200; // the passage starts at least this far along its road (m)
export const TUN_MIN_OUT = 300; // ... and ends at least this far before the road's end
const tunnelFns = [];
export function onTunnelPlanned(fn) { tunnelFns.push(fn); }
const BIO_FAR = 1900, BIO_FADE = 0.2; // metres, per second (round three: territories held further)

// --- node pool
export const nodeAlive = new Uint8Array(MAX_NODES);
export const nodeX = new Float32Array(MAX_NODES);
export const nodeY = new Float32Array(MAX_NODES);
export const nodeZ = new Float32Array(MAX_NODES);
export const nodeHead = new Float32Array(MAX_NODES);
export const nodeKey = new Uint32Array(MAX_NODES);
export const nodeRegion = new Uint8Array(MAX_NODES); // region of the incoming road
export const nodeIn = new Int16Array(MAX_NODES); // incoming edge slot (-1 at the root)
export const nodeJ = new Float32Array(MAX_NODES); // journey metres at the node
export const nodeExitCount = new Uint8Array(MAX_NODES);
const nodeExits = new Int16Array(MAX_NODES * 3); // edge slot per exit, -1 until built
const nodeAngle = new Float32Array(MAX_NODES * 3);
const nodeExitRegion = new Uint8Array(MAX_NODES * 3);
const nodeUnavail = new Uint8Array(MAX_NODES); // bitmask of unavailable exits
const nodeWanted = new Uint8Array(MAX_NODES); // exits should be generated
// Land bridge: the exit that is a causeway across a strait (-1 none), where it crosses (s) and
// whether it is still frozen when the car would get there (time.js straitOpen decides).
// Landmass (0 near, 1 far): nodeLand[n] at a junction; edgeLand[e] at the start of a road;
// edgeCross[e] the s where the road crosses the strait (-1 none): the landmass flips there and
// the road's end junction and everything beyond inherit the new one. landAt(e, s).
export const nodeBridge = new Int8Array(MAX_NODES).fill(-1);
export const nodeBridgeS = new Float32Array(MAX_NODES);
export const nodeLand = new Uint8Array(MAX_NODES);
export const edgeLand = new Uint8Array(MAX_EDGES);
export const edgeCross = new Float32Array(MAX_EDGES).fill(-1);
export function landAt(e, s) { return edgeCross[e] >= 0 && s >= edgeCross[e] ? 1 - edgeLand[e] : edgeLand[e]; }
export function edgeEndLand(e) { return edgeCross[e] >= 0 ? 1 - edgeLand[e] : edgeLand[e]; }
// Strait half width along the road at edgeCross (sites.js keeps landmarks clear of it).
export const edgeCrossHW = new Float32Array(MAX_EDGES);
export const LAND_BRIDGE_HW = 64;
// Ferry crossings (see the header).
export const FERRY_WATER = 330; // quay to quay (m)
export const REGION_FERRY = 6; // a strait exit leads down to the coast
export const nodeFerry = new Int8Array(MAX_NODES).fill(-1);
export const nodeQuay = new Uint8Array(MAX_NODES);
export const edgeFerry = new Uint8Array(MAX_EDGES);
export const edgeQuayS = new Float32Array(MAX_EDGES);
export const edgeQuayY = new Float32Array(MAX_EDGES);
// Journey clock at journey metres j: clockBase[0] + (j - clockBase[1]) / 40 (drive.js sets
// it before resetGraph, so ?t0= starts the history later).
export const clockBase = new Float64Array(2);

export const graph = {
  seed: 1,
  cur: -1, // edge the car is on (committed)
  prev: -1, // edge the car came from
  root: -1,
  built: 0, // edges built so far (perf attribution)
  commits: 0,
  dirty: 0, // bumped whenever an edge is built or freed (road / field re-upload)
  evictBio: 0, evictNear: 1e9, // debug: roads evicted while their biome territory still showed, nearest (m)
};

const readyFns = [], freedFns = [];
export function onEdgeReady(fn) { readyFns.push(fn); }
export function onEdgeFreed(fn) { freedFns.push(fn); }

// Generation queue (node, exit) pairs.
const QCAP = 64;
const qNode = new Int16Array(QCAP), qExit = new Uint8Array(QCAP);
let qHead = 0, qLen = 0;

const tmpRaw = new Float32Array(MAX_PTS);
const tmpA = new Float32Array(MAX_PTS);

function rnd(key, k) { return hashU(key, k) * HASH_SCALE; }

export function nodeExit(n, i) { return nodeExits[n * 3 + i]; }
export function exitAvailable(n, i) { return !(nodeUnavail[n] & (1 << i)); }
export function markExitUnavailable(n, i, unavailable = true) {
  if (unavailable) nodeUnavail[n] |= 1 << i; else nodeUnavail[n] &= ~(1 << i);
}
export function exitAngle(n, i) { return nodeAngle[n * 3 + i]; }
export function exitRegion(n, i) { return nodeExitRegion[n * 3 + i]; }
export function exitCrosses(n, i) { return nodeBridge[n] === i || nodeFerry[n] === i; }

function allocNode() {
  for (let i = 0; i < MAX_NODES; i++) if (!nodeAlive[i]) { nodeAlive[i] = 1; return i; }
  throw new Error('graph: node pool exhausted');
}
function allocEdge() {
  for (let i = 0; i < MAX_EDGES; i++) if (!edgeAlive[i]) return i;
  // Pool full: evict a road that has already faded out (only its biome influence lingers).
  let v = -1;
  for (let i = 0; i < MAX_EDGES; i++) if (!edgeKeep[i] && edgePresence[i] <= 0 && (v < 0 || edgeBio[i] < edgeBio[v])) v = i;
  if (v < 0) return -1;
  if (edgeBio[v] > 0) { // debug: a road whose territory still showed (tools/tunnel-test.mjs)
    graph.evictBio++;
    let dm = 1e9;
    for (let k = 0; k < edgeN[v]; k += 16) { const o = (v * MAX_PTS + k) * 4, dx = pts[o] - graphFocus[0], dz = pts[o + 2] - graphFocus[1], d = dx * dx + dz * dz; if (d < dm) dm = d; }
    if (Math.sqrt(dm) < graph.evictNear) graph.evictNear = Math.sqrt(dm);
  }
  edgeAlive[v] = 0; edgeBio[v] = 0;
  const n = edgeFrom[v];
  if (nodeAlive[n]) nodeExits[n * 3 + edgeExit[v]] = -1;
  graph.dirty++;
  for (let f = 0; f < freedFns.length; f++) freedFns[f](v);
  return v;
}

// Plans a node's exits (count, angles, regions) from its key. Does not build edges.
function planNode(n) {
  const key = nodeKey[n];
  const three = rnd(key, 1) < 0.42;
  const cnt = three ? 3 : 2;
  nodeExitCount[n] = nodeIn[n] < 0 || nodeQuay[n] ? 1 : cnt;
  const a = 0.36 + 0.16 * rnd(key, 2);
  const bias = Math.max(-0.22, Math.min(0.22, -0.45 * (nodeHead[n] - MAIN_HEADING)));
  const c = nodeExitCount[n];
  for (let i = 0; i < c; i++) {
    let ang = 0;
    if (c === 2) ang = i === 0 ? -0.8 * a : 0.8 * a;
    else if (c === 3) ang = (i - 1) * a;
    nodeAngle[n * 3 + i] = c === 1 ? 0 : ang + bias;
    nodeExits[n * 3 + i] = -1;
  }
  // Regions: one exit continues the current region; others may lead elsewhere.
  const r = nodeRegion[n];
  const keepIdx = c === 1 ? 0 : (hashU(key, 3) % c);
  // Other exits change region with p = 0.6, to any other region (uniformly), and two changed
  // exits of one fork never offer the same region.
  for (let i = 0; i < c; i++) {
    let reg = r;
    if (i !== keepIdx && rnd(key, 10 + i) < 0.6) {
      reg = (r + 1 + (hashU(key, 20 + i) % (REGIONS - 1))) % REGIONS;
      for (let j = 0; j < i; j++) if (j !== keepIdx && nodeExitRegion[n * 3 + j] === reg) { reg = (reg + 1) % REGIONS; if (reg === r) reg = (reg + 1) % REGIONS; }
    }
    nodeExitRegion[n * 3 + i] = reg;
  }
  nodeUnavail[n] = 0;
  nodeWanted[n] = 0;
  nodeBridge[n] = -1;
  nodeFerry[n] = -1;
  if (c >= 2) planHistory(n, key, c);
  else if (nodeQuay[n]) { // off the boat: the road inland heads where history happens next
    const w = wantRegion(clockBase[0] + (nodeJ[n] - clockBase[1]) / 40, nodeLand[n], 0);
    if (w >= 0 && w < REGIONS) nodeExitRegion[n * 3] = w;
  }
  if (regionDebug[1] >= 0) for (let i = 0; i < c; i++) if (nodeBridge[n] !== i) nodeExitRegion[n * 3 + i] = regionDebug[1];
}

// Reachability: whatever the seed, some exit of every fork leads where history happens next on
// this landmass (time.js wantRegion: the region of the most urgent event about to be placeable;
// a three-way fork also gets the runner-up), and the first-era ice forks of the near landmass
// offer the land bridge on their outermost free exit. Regions the graph does not generate yet
// (>= REGIONS) are never steered to.
const WANT = new Int8Array(2);
function planHistory(n, key, c) {
  const clk = clockBase[0] + (nodeJ[n] - clockBase[1]) / 40;
  const land = nodeLand[n];
  WANT[0] = -1; WANT[1] = -1;
  for (let k = 0, m = 0; k < 4 && m < 2; k++) {
    const r = wantRegion(clk, land, k);
    if (r < 0) break;
    if (r < REGIONS) WANT[m++] = r;
  }
  // From the Connected world on (many events overlap), a two-way fork sometimes steers to the
  // runner-up instead, so events with later-closing windows (Timbuktu) get roads too.
  if (c === 2 && clk >= 120 && WANT[1] >= 0 && hashU(key, 43) % 5 < 2) { const t = WANT[0]; WANT[0] = WANT[1]; WANT[1] = t; }
  const o = n * 3;
  let bridge = -1;
  if (land === 0 && nodeRegion[n] === 1 && clk < LAND_BRIDGE_CLOCK + 50) {
    bridge = (hashU(key, 41) & 1) ? c - 1 : 0;
    nodeExitRegion[o + bridge] = 1; // the far landmass: same kits, ice
  }
  // Ferry (see the header): the quay is reached ~FERRY_LEAD clock seconds after the fork.
  if (bridge < 0 && straitOpen(clk + FERRY_LEAD, land) && clk + FERRY_LEAD >= SHIP_CLOCK && (land === 1 || clk >= FERRY_NEAR)) {
    // two forks back along the route (parent, grandparent): no crossing offered, not a quay
    let calm = true;
    for (let k = 0, m = n; k < 2 && calm; k++) {
      m = nodeIn[m] >= 0 ? edgeFrom[nodeIn[m]] : -1;
      if (m < 0 || !nodeAlive[m]) break;
      if (nodeFerry[m] >= 0 || nodeQuay[m]) calm = false;
    }
    if (c === 3 ? rnd(key, 47) < 0.6 : calm && clk >= 190 && rnd(key, 47) < 0.5) {
      bridge = (hashU(key, 48) & 1) ? c - 1 : 0;
      nodeFerry[n] = bridge;
      nodeExitRegion[o + bridge] = REGION_FERRY;
    }
  }
  let used = -1;
  for (let w = 0; w < 2 && w < c - 1; w++) {
    const want = WANT[w];
    if (want < 0) break;
    // On a three-way fork the most urgent region goes to an outer exit: the middle road has
    // siblings on both sides, so a large roadside landmark (Giza's 170 m pad) finds no room.
    const outer = c === 3 && w === 0 ? 1 : 0;
    let has = -1;
    for (let i = 0; i < c; i++) if (i !== bridge && i !== used && !(outer && i === 1) && nodeExitRegion[o + i] === want) { has = i; break; }
    if (has < 0) {
      // Turn the exit closest to straight ahead (other than the causeway) toward history.
      let ba = 1e9;
      for (let i = 0; i < c; i++) { if (i === bridge || i === used || (outer && i === 1)) continue; const a = Math.abs(nodeAngle[o + i]); if (a < ba) { ba = a; has = i; } }
      if (has < 0) break;
      nodeExitRegion[o + has] = want;
    }
    used = has;
  }
  if (bridge >= 0 && nodeFerry[n] < 0) {
    nodeBridge[n] = bridge;
    // Cross early enough that a car taking it is over before the strait thaws.
    let sc = (LAND_BRIDGE_CLOCK - 1.5 - clk) * 40;
    sc = sc < 210 ? 260 : sc > 330 ? 330 : sc;
    nodeBridgeS[n] = sc;
    if (!straitOpen(clk + sc / 40 + 0.5, land)) nodeUnavail[n] |= 1 << bridge;
  }
}
export function exitIsBridge(n, i) { return nodeBridge[n] === i || nodeFerry[n] === i; }

function queueNode(n) {
  if (nodeWanted[n]) return;
  nodeWanted[n] = 1;
  for (let i = 0; i < nodeExitCount[n]; i++) {
    if (nodeExits[n * 3 + i] >= 0) continue;
    if (qLen >= QCAP) throw new Error('graph: queue full');
    const k = (qHead + qLen) % QCAP;
    qNode[k] = n; qExit[k] = i; qLen++;
  }
}

// Builds exit i of node n into a free slot. Returns the slot (or -1 if the pool is full).
function buildEdge(n, i) {
  const e = allocEdge();
  if (e < 0) return -1;
  const key = hashU(nodeKey[n], 101 + i);
  const ferry = nodeFerry[n] === i;
  // The root road is short so the first fork comes ~19 s into the journey; later roads are
  // ~1.0-1.2 km (a fork every ~26 s at cruising speed). A ferry road: approach, then water.
  const qa = ferry ? FERRY_LEAD * 40 - 40 + 80 * rnd(key, 1) : 1e9;
  const L = ferry ? qa + FERRY_WATER : nodeIn[n] < 0 ? 760 + 80 * rnd(key, 1) : 950 + 200 * rnd(key, 1);
  const N = Math.min(MAX_PTS, Math.floor(L / STEP) + 1);
  const h0 = nodeHead[n], a = nodeAngle[n * 3 + i];
  const n1 = 1 + (hashU(key, 2) % 3), n2 = n1 + 1 + (hashU(key, 3) % 2);
  // Shorter roads get proportionally gentler wiggles (same curvature as a full-length road).
  const wig = Math.min(1, L / 1150);
  const A1 = (rnd(key, 4) - 0.5) * 0.55 * wig, A2 = (rnd(key, 5) - 0.5) * 0.25 * wig;
  const ph = rnd(key, 6) < 0.5 ? 1 : -1;
  // A gentler, quicker meander on top, so long roads never run ruler-straight.
  EP[12] = (0.06 + 0.06 * rnd(key, 7)) * wig * (rnd(key, 8) < 0.5 ? 1 : -1); EP[13] = 5 + (hashU(key, 9) % 4);
  const base = e * MAX_PTS;
  const len = (N - 1) * STEP;
  // Per-sample work lives in small functions called with integer arguments: they get hot and
  // optimised after a few edges, so building an edge does not churn boxed doubles.
  EP[0] = h0; EP[1] = a; EP[2] = ph; EP[3] = A1; EP[4] = A2; EP[5] = n1; EP[6] = n2; EP[7] = len;
  EP[8] = nodeX[n]; EP[9] = nodeZ[n];
  EP[14] = ferry ? qa - 90 : 1e9; // straight from here on: down the quay and over the water
  for (let k = 0; k < N; k++) edgeSample(base, k);
  // Height profile: two box passes (~120 m triangle filter), then pin the start to the node.
  boxSmooth(tmpRaw, tmpA, N, 30);
  boxSmooth(tmpA, tmpRaw, N, 30);
  EP[10] = nodeY[n] - tmpRaw[0];
  EP[11] = nodeJ[n];
  EP[16] = 1e9;
  if (ferry) {
    // The quay level: the lowest ground along the end of the approach (the road runs down to
    // the water), held flat over the quays and the strait.
    const k0 = Math.max(0, Math.floor((qa - 160) / STEP)), k1 = Math.min(N - 1, Math.floor(qa / STEP));
    let y = 1e9;
    for (let k = k0; k <= k1; k++) { const v = tmpRaw[k] + (k * STEP < 260 ? EP[10] * (1 - smoothstep(0, 260, k * STEP)) : 0); if (v < y) y = v; }
    EP[15] = y; EP[16] = qa - 200; EP[17] = qa - 40;
  }
  for (let k = 0; k < N; k++) edgeHeight(base, k);
  const J0 = nodeJ[n];
  edgeN[e] = N; edgeLen[e] = len; edgeJ0[e] = J0;
  edgeFrom[e] = n; edgeExit[e] = i; edgeRegion[e] = nodeExitRegion[n * 3 + i];
  edgeParentRegion[e] = nodeRegion[n];
  edgeBio[e] = 0;
  edgeDrawEnd[e] = 1e9;
  edgeLand[e] = nodeLand[n];
  edgeCross[e] = nodeBridge[n] === i ? nodeBridgeS[n] : -1;
  edgeCrossHW[e] = LAND_BRIDGE_HW;
  edgeFerry[e] = 0;
  if (ferry) {
    edgeQuayS[e] = qa; edgeQuayY[e] = EP[15];
    edgeCross[e] = qa + FERRY_WATER * 0.5; edgeCrossHW[e] = FERRY_WATER * 0.5 + 6;
    edgeDrawEnd[e] = qa - DRAW_END_PAD; // the road surface ends on the quay
    // Ship, or a ship that gives way to the bridge if the clock reaches BRIDGE_CLOCK while
    // the car is still well short of the quay (crossing.js).
    edgeFerry[e] = clockBase[0] + (J0 + qa - 150 - clockBase[1]) / 40 >= BRIDGE_CLOCK ? 2 : 1;
  }
  edgeAlive[e] = 1; edgeKeep[e] = 1; edgePresence[e] = 0;
  edgeVersion[e]++;
  nodeExits[n * 3 + i] = e;
  // Biome seam: a ferry road changes biome over the water (no ridge); any other road at its
  // passage (provisional split until planTunnels below).
  edgeTunS[e] = -1; edgeTunH[e] = 0; edgeTunClear[e] = 0;
  if (edgeRegion[e] !== edgeParentRegion[e] && nodeIn[n] >= 0) {
    if (edgeCross[e] >= 0) { edgeSeam[e] = 2; edgeSplit[e] = edgeCross[e]; }
    else { edgeSeam[e] = 1; edgeSplit[e] = Math.min(len * 0.45, 420); }
  } else { edgeSeam[e] = 0; edgeSplit[e] = -1; }

  // End node.
  const m = allocNode();
  const oe = (base + N - 1) * 4;
  nodeX[m] = pts[oe]; nodeY[m] = pts[oe + 1]; nodeZ[m] = pts[oe + 2];
  nodeHead[m] = heads[base + N - 1];
  nodeKey[m] = hashU(nodeKey[n], 17 + i);
  nodeRegion[m] = edgeRegion[e];
  nodeIn[m] = e;
  nodeJ[m] = J0 + len;
  nodeLand[m] = edgeEndLand(e);
  nodeQuay[m] = ferry ? 1 : 0;
  planNode(m);
  edgeTo[e] = m;
  // Keep two forks of lookahead: exits of the current edge's end node grow their own exits.
  if (graph.cur >= 0 && n === edgeTo[graph.cur]) queueNode(m);
  graph.dirty++;
  graph.built++;
  let all = true;
  for (let q = 0; q < nodeExitCount[n]; q++) if (nodeExits[n * 3 + q] < 0) all = false;
  if (all) planTunnels(n);
  for (let f = 0; f < readyFns.length; f++) readyFns[f](e);
  return e;
}

// Passages for the seam exits of fork n (every exit exists): each passage stands where its road
// is clearest of the other roads (so the ridge across it has room to rise and fall before
// another road), fairly straight, at least TUN_MIN_IN m along it and TUN_MIN_OUT m before its
// end. Its half length is 60-85 m (a 120-170 m passage: 3-4 s at cruising speed).
function planTunnels(n) {
  for (let i = 0; i < nodeExitCount[n]; i++) {
    const e = nodeExits[n * 3 + i];
    if (e < 0 || edgeSeam[e] !== 1 || edgeTunS[e] >= 0) continue;
    const key = hashU(nodeKey[n], 131 + i);
    const H = 60 + 25 * rnd(key, 1);
    const L = edgeLen[e];
    const s0 = TUN_MIN_IN + H, s1 = Math.max(s0, L - TUN_MIN_OUT - H);
    let best = -1e9, bs = s0, bc = 0;
    for (let s = s0; s <= s1 + 0.01; s += 20) {
      const c = roadClearance(e, s - H - 30, s + H + 30);
      // how far the road strays from the straight line through the passage over +-(H + 160) m
      const dev = straightDev(e, s, H + 160);
      // and well away from a strait crossing (the water there parts the biomes, no ridge)
      const sd = straitDist(e, s);
      const sc = Math.min(c, 140) - 6 * dev - 0.5 * (s - s0) - (sd < 700 ? (700 - sd) : 0); // early: room for a landmark after it
      if (sc > best) { best = sc; bs = s; bc = c; }
    }
    edgeTunS[e] = bs; edgeTunH[e] = H; edgeSplit[e] = bs; edgeTunClear[e] = bc;
    straightenAt(e, bs, H + 25);
    graph.dirty++;
    for (let f = 0; f < tunnelFns.length; f++) tunnelFns[f](e);
  }
}
// Distance from e at s to the nearest strait crossing of a live road (a causeway's or a ship's).
function straitDist(e, s) {
  const o = (e * MAX_PTS + Math.min(edgeN[e] - 1, Math.round(s / STEP))) * 4, x = pts[o], z = pts[o + 2];
  let best = 1e9;
  for (let f = 0; f < MAX_EDGES; f++) {
    if (!edgeAlive[f] || edgeCross[f] < 0) continue;
    const k0 = Math.max(0, Math.round((edgeCross[f] - edgeCrossHW[f] - 60) / STEP)), k1 = Math.min(edgeN[f] - 1, Math.round((edgeCross[f] + edgeCrossHW[f] + 60) / STEP));
    for (let k = k0; k <= k1; k += 8) {
      const q = (f * MAX_PTS + k) * 4, dx = pts[q] - x, dz = pts[q + 2] - z, d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
// Largest distance (m) of e's centreline over +-r around s from the chord through s's passage.
function straightDev(e, s, r) {
  const N = edgeN[e], base = e * MAX_PTS;
  const kc = Math.round(s / STEP);
  const ka = Math.max(0, Math.round((s - 100) / STEP)), kb = Math.min(N - 1, Math.round((s + 100) / STEP));
  let dx = pts[(base + kb) * 4] - pts[(base + ka) * 4], dz = pts[(base + kb) * 4 + 2] - pts[(base + ka) * 4 + 2];
  const dl = Math.sqrt(dx * dx + dz * dz) || 1; dx /= dl; dz /= dl;
  const cx = pts[(base + kc) * 4], cz = pts[(base + kc) * 4 + 2];
  let m = 0;
  const k0 = Math.max(0, Math.round((s - r) / STEP)), k1 = Math.min(N - 1, Math.round((s + r) / STEP));
  for (let k = k0; k <= k1; k += 4) {
    const o = (base + k) * 4, px = pts[o] - cx, pz = pts[o + 2] - cz;
    const d = Math.abs(-px * dz + pz * dx);
    if (d > m) m = d;
  }
  return m;
}
// Straight and level road over +-r around s, blended back over 220 m (the passage is straight,
// so its vault, its slot and the car's walls share one frame). The edge is far ahead of the car.
function straightenAt(e, s, r) {
  const N = edgeN[e], base = e * MAX_PTS;
  const kc = Math.round(s / STEP);
  const oc = (base + kc) * 4;
  const cx = pts[oc], cy = pts[oc + 1], cz = pts[oc + 2];
  // direction: the chord over the passage
  const ka = Math.max(0, Math.round((s - r) / STEP)), kb = Math.min(N - 1, Math.round((s + r) / STEP));
  let dx = pts[(base + kb) * 4] - pts[(base + ka) * 4], dz = pts[(base + kb) * 4 + 2] - pts[(base + ka) * 4 + 2];
  const dl = Math.sqrt(dx * dx + dz * dz) || 1; dx /= dl; dz /= dl;
  const R2 = r + 220;
  const k0 = Math.max(1, Math.floor((s - R2) / STEP)), k1 = Math.min(N - 2, Math.ceil((s + R2) / STEP));
  for (let k = k0; k <= k1; k++) {
    const d = (k - kc) * STEP;
    let t = (Math.abs(d) - r) / 220; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const w = 1 - t * t * (3 - 2 * t);
    const o = (base + k) * 4;
    pts[o] += (cx + dx * d - pts[o]) * w;
    pts[o + 2] += (cz + dz * d - pts[o + 2]) * w;
    pts[o + 1] += (cy - pts[o + 1]) * w;
  }
  for (let k = k0; k <= k1; k++) {
    const a = (base + k - 1) * 4, b = (base + k + 1) * 4;
    let v = Math.atan2(pts[b + 2] - pts[a + 2], pts[b] - pts[a]);
    const p = heads[base + k - 1];
    while (v - p > Math.PI) v -= 2 * Math.PI;
    while (v - p < -Math.PI) v += 2 * Math.PI;
    heads[base + k] = v;
  }
  // keep the samples after the blend continuous with the (unwrapped) headings
  for (let k = k1 + 1; k < N; k++) {
    const p = heads[base + k - 1];
    let v = heads[base + k];
    while (v - p > Math.PI) v -= 2 * Math.PI;
    while (v - p < -Math.PI) v += 2 * Math.PI;
    heads[base + k] = v;
  }
}
// Smallest distance from e's centreline over [sa, sb] to any other live road (coarse, plan time).
function roadClearance(e, sa, sb) {
  let best = 1e9;
  const ka = Math.max(0, Math.floor(sa / STEP)), kb = Math.min(edgeN[e] - 1, Math.ceil(sb / STEP));
  for (let f = 0; f < MAX_EDGES; f++) {
    if (f === e || !edgeAlive[f]) continue;
    const N = edgeN[f], base = f * MAX_PTS;
    for (let k = 0; k < N; k += 12) {
      const o = (base + k) * 4;
      for (let q = ka; q <= kb; q += 12) {
        const p = (e * MAX_PTS + q) * 4;
        const dx = pts[o] - pts[p], dz = pts[o + 2] - pts[p + 2];
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
    }
  }
  return Math.sqrt(best);
}

// Edge build parameters: h0, exit angle, phase sign, A1, A2, n1, n2, length, x, z (running),
// height offset, journey metres at the start.
// [14] heading frozen from this s on; [15] quay level, flattened in over [16, 17] (ferry roads).
const EP = new Float64Array(18);
const FERRY_LEAD = 13; // clock seconds from a fork to its ferry quay (~520 m)
// Near-side forks offer ships from this clock (the busy windows around 1492 keep their exits;
// the far side, empty since the land bridge flooded, offers the way back from 1492 itself).
const FERRY_NEAR = 186;
function headingAt(s) { // only called from edgeSample (inlined)
  if (s > EP[14]) s = EP[14];
  const len = EP[7], u = s / len;
  let t = u / 0.16; t = t < 0 ? 0 : t > 1 ? 1 : t; let taper = t * t * (3 - 2 * t);
  t = (1 - u) / 0.16; t = t < 0 ? 0 : t > 1 ? 1 : t; taper *= t * t * (3 - 2 * t);
  t = s / TURN_IN; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return EP[0] + EP[1] * t * t * (3 - 2 * t) + EP[2] * taper * (EP[3] * Math.sin(Math.PI * EP[5] * u) + EP[4] * Math.sin(Math.PI * EP[6] * u) + EP[12] * Math.sin(Math.PI * EP[13] * u));
}
function edgeSample(base, k) {
  const s = k * STEP;
  if (k > 0) {
    // Midpoint heading for the step keeps the integration second order.
    const hm = headingAt(s - STEP * 0.5);
    EP[8] += Math.cos(hm) * STEP; EP[9] += Math.sin(hm) * STEP;
  }
  const o = (base + k) * 4;
  pts[o] = EP[8]; pts[o + 2] = EP[9];
  heads[base + k] = headingAt(s);
  NIO[0] = EP[8]; NIO[1] = EP[9]; noiseBase();
  tmpRaw[k] = NIO[2];
}
function edgeHeight(base, k) {
  const s = k * STEP;
  const o = (base + k) * 4;
  let t = s / 260; t = t > 1 ? 1 : t;
  pts[o + 1] = tmpRaw[k] + EP[10] * (1 - t * t * (3 - 2 * t));
  if (s > EP[16]) { t = (s - EP[16]) / (EP[17] - EP[16]); t = t > 1 ? 1 : t; pts[o + 1] += (EP[15] - pts[o + 1]) * t * t * (3 - 2 * t); }
  pts[o + 3] = EP[11] + s;
}

function boxSmooth(src, dst, N, r) {
  let acc = 0;
  for (let k = -r; k <= r; k++) acc += src[Math.min(N - 1, Math.max(0, k))];
  const inv = 1 / (2 * r + 1);
  for (let k = 0; k < N; k++) {
    dst[k] = acc * inv;
    acc += src[Math.min(N - 1, k + r + 1)] - src[Math.max(0, k - r)];
  }
}

// Builds at most `budget` queued edges. Returns how many remain queued.
export function pump(budget = 1) {
  while (budget > 0 && qLen > 0) {
    const n = qNode[qHead], i = qExit[qHead];
    if (!nodeAlive[n] || nodeExits[n * 3 + i] >= 0 || !nodeWanted[n]) { qHead = (qHead + 1) % QCAP; qLen--; continue; }
    if (buildEdge(n, i) < 0) break; // pool full: retry next call once something is freed
    qHead = (qHead + 1) % QCAP; qLen--;
    budget--;
  }
  return qLen;
}
// Drains the queue; stops when the pool is full (pump makes no progress), the rest is built
// once fading edges free their slots.
export function pumpAll() {
  let left = qLen;
  for (;;) { const r = pump(64); if (r === 0 || r >= left) break; left = r; }
}

export function resetGraph(seed) {
  graph.seed = seed >>> 0;
  edgeAlive.fill(0); edgeKeep.fill(0); edgePresence.fill(0); edgeBio.fill(0);
  nodeAlive.fill(0); nodeWanted.fill(0); nodeQuay.fill(0); nodeFerry.fill(-1); edgeFerry.fill(0);
  qHead = 0; qLen = 0;
  const r = allocNode();
  graph.cur = -1; graph.prev = -1;
  NIO[0] = 0; NIO[1] = 0; noiseBase();
  nodeX[r] = 0; nodeZ[r] = 0; nodeY[r] = NIO[2]; nodeHead[r] = MAIN_HEADING;
  nodeKey[r] = hashU(graph.seed, 999);
  nodeRegion[r] = regionDebug[0]; nodeIn[r] = -1; nodeJ[r] = 0; nodeLand[r] = regionDebug[2];
  planNode(r);
  graph.root = r;
  queueNode(r);
  pumpAll();
  graph.cur = nodeExits[r * 3];
  graph.prev = -1;
  expandAhead();
  pumpAll();
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e]) { edgePresence[e] = 1; edgeBio[e] = 1; }
  graphFocus[0] = nodeX[r]; graphFocus[1] = nodeZ[r];
  graph.dirty++;
}

// Queue the two forks of lookahead beyond the current edge.
function expandAhead() {
  const j = edgeTo[graph.cur];
  queueNode(j);
  for (let i = 0; i < nodeExitCount[j]; i++) {
    const x = nodeExits[j * 3 + i];
    if (x >= 0) queueNode(edgeTo[x]);
  }
}

const keepTmp = new Uint8Array(MAX_EDGES);
// The car has committed to edge e (an exit of the current edge's end node).
export function commit(e) {
  if (e === graph.cur) return;
  graph.commits++;
  graph.prev = graph.cur;
  graph.cur = e;
  // Live set: prev, siblings of e, e, its end node's exits and their exits.
  keepTmp.fill(0);
  keepTmp[graph.prev] = 1;
  const n = edgeFrom[e];
  for (let i = 0; i < nodeExitCount[n]; i++) { const x = nodeExits[n * 3 + i]; if (x >= 0) keepTmp[x] = 1; }
  const j = edgeTo[e];
  for (let i = 0; i < nodeExitCount[j]; i++) {
    const x = nodeExits[j * 3 + i];
    if (x < 0) continue;
    keepTmp[x] = 1;
    const k = edgeTo[x];
    for (let q = 0; q < nodeExitCount[k]; q++) { const y = nodeExits[k * 3 + q]; if (y >= 0) keepTmp[y] = 1; }
  }
  for (let x = 0; x < MAX_EDGES; x++) if (edgeAlive[x]) edgeKeep[x] = keepTmp[x];
  // Nodes off the path stop wanting exits (queued builds for them are skipped).
  for (let m = 0; m < MAX_NODES; m++) {
    if (!nodeAlive[m] || !nodeWanted[m]) continue;
    const ie = nodeIn[m];
    if (ie >= 0 && !keepTmp[ie]) nodeWanted[m] = 0;
  }
  // Siblings' end nodes must not grow children any more.
  for (let i = 0; i < nodeExitCount[n]; i++) {
    const x = nodeExits[n * 3 + i];
    if (x >= 0 && x !== e) nodeWanted[edgeTo[x]] = 0;
  }
  expandAhead();
}

// Presence fades; frees fully faded edges and orphaned nodes. Call once per sim step.
export function updateGraph() {
  const dt = SIM_DT;
  let freed = false;
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!edgeAlive[e]) continue;
    if (edgeKeep[e]) { edgePresence[e] = Math.min(1, edgePresence[e] + FADE_IN * dt); edgeBio[e] = Math.max(edgeBio[e], edgePresence[e]); }
    else {
      edgePresence[e] = Math.max(0, edgePresence[e] - FADE_OUT * dt);
      if (edgeBio[e] > 0 && (edgeBio[e] < 1 || farFromFocus(e))) edgeBio[e] = Math.max(0, edgeBio[e] - BIO_FADE * dt);
      if (edgePresence[e] <= 0 && edgeBio[e] <= 0) {
        edgePresence[e] = 0;
        edgeAlive[e] = 0;
        const n = edgeFrom[e];
        if (nodeAlive[n]) nodeExits[n * 3 + edgeExit[e]] = -1;
        freed = true;
        graph.dirty++;
        for (let f = 0; f < freedFns.length; f++) freedFns[f](e);
      }
    }
  }
  if (freed) {
    for (let m = 0; m < MAX_NODES; m++) {
      if (!nodeAlive[m]) continue;
      const ie = nodeIn[m];
      let used = ie >= 0 && edgeAlive[ie] && edgeTo[ie] === m;
      for (let i = 0; i < nodeExitCount[m] && !used; i++) if (nodeExits[m * 3 + i] >= 0) used = true;
      if (!used && m !== edgeFrom[graph.cur]) nodeAlive[m] = 0;
    }
  }
}

// Every coarse sample of e further than BIO_FAR from the focus (car)?
function farFromFocus(e) {
  const N = edgeN[e], base = e * MAX_PTS, fx = graphFocus[0], fz = graphFocus[1];
  for (let k = 0; k < N; k += 16) {
    const o = (base + k) * 4;
    const dx = pts[o] - fx, dz = pts[o + 2] - fz;
    if (dx * dx + dz * dz < BIO_FAR * BIO_FAR) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------
// Queries. Inputs are passed in slots of the caller's Float64Array `out` (V8 boxes doubles
// passed as arguments, so the per-frame paths never do that). `out` needs 8 slots.

// out[4] = s (input)  ->  out[0..3] = x, roadY, z, heading at s along e (clamped).
export function pointAt(e, out) {
  const N = edgeN[e];
  let f = out[4] / STEP;
  if (f < 0) f = 0; else if (f > N - 1) f = N - 1;
  let k = Math.floor(f);
  if (k >= N - 1) k = N - 2;
  const t = f - k;
  const o = (e * MAX_PTS + k) * 4;
  out[0] = pts[o] + (pts[o + 4] - pts[o]) * t;
  out[1] = pts[o + 1] + (pts[o + 5] - pts[o + 1]) * t;
  out[2] = pts[o + 2] + (pts[o + 6] - pts[o + 2]) * t;
  const h0 = heads[e * MAX_PTS + k], h1 = heads[e * MAX_PTS + k + 1];
  out[3] = h0 + (h1 - h0) * t;
  return out;
}

// out[4] = s, out[5] = lat (inputs)  ->  like pointAt, offset lat metres to the right.
export function frameAt(e, out) {
  const lat = out[5];
  pointAt(e, out);
  const h = out[3];
  out[0] += -Math.sin(h) * lat;
  out[2] += Math.cos(h) * lat;
  return out;
}

// Local projection onto edge e. Inputs out[5] = x, out[6] = z, out[7] = s guess; searches
// +-span metres (integer) around the guess. Writes out[0] = s, out[1] = signed lateral
// (right +), out[2] = roadY, out[3] = heading, out[4] = distance.
export function project(e, out, span) {
  const x = out[5], z = out[6];
  const N = edgeN[e];
  const base = e * MAX_PTS;
  let k0 = Math.floor((out[7] - span) / STEP), k1 = Math.ceil((out[7] + span) / STEP);
  if (k0 < 0) k0 = 0; if (k1 > N - 1) k1 = N - 1;
  let best = 1e30, bk = k0, bt = 0;
  for (let k = k0; k < k1; k++) {
    const o = (base + k) * 4;
    const ax = pts[o], az = pts[o + 2];
    const dx = pts[o + 4] - ax, dz = pts[o + 6] - az;
    const px = x - ax, pz = z - az;
    let t = (px * dx + pz * dz) / (dx * dx + dz * dz);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const ex = px - dx * t, ez = pz - dz * t;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) { best = d2; bk = k; bt = t; }
  }
  const o = (base + bk) * 4;
  const ax = pts[o], az = pts[o + 2];
  const dx = pts[o + 4] - ax, dz = pts[o + 6] - az;
  const h = heads[base + bk] + (heads[base + bk + 1] - heads[base + bk]) * bt;
  const cx = ax + dx * bt, cz = az + dz * bt;
  out[0] = (bk + bt) * STEP;
  out[1] = (x - cx) * -Math.sin(h) + (z - cz) * Math.cos(h);
  out[2] = pts[o + 1] + (pts[o + 5] - pts[o + 1]) * bt;
  out[3] = h;
  out[4] = Math.sqrt(best);
  return out;
}

// Global nearest road over all live edges, with the same presence fade the GPU field uses
// (effective distance = d + (1 - presence) * fadeW; fadeW an integer).
// Inputs out[5] = x, out[6] = z. Writes out[0] = dEff, out[1] = roadY, out[2] = journey m,
// out[3] = edge (-1 if none), out[4] = s.
export function nearestRoad(out, fadeW) {
  const x = out[5], z = out[6];
  let bestD = 1e30, bestE = -1;
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!edgeAlive[e] || edgePresence[e] <= 0) continue;
    const N = edgeN[e], base = e * MAX_PTS;
    const lim = Math.min(N, Math.floor((edgeDrawEnd[e] + DRAW_END_PAD) / STEP) + 1);
    const pen = (1 - edgePresence[e]) * fadeW;
    for (let k = 0; k < lim; k += 8) {
      const o = (base + k) * 4;
      const dx = x - pts[o], dz = z - pts[o + 2];
      const d = Math.sqrt(dx * dx + dz * dz) + pen;
      if (d < bestD) { bestD = d; bestE = e; }
    }
  }
  out[0] = 1e9; out[1] = 0; out[2] = 0; out[3] = -1; out[4] = 0;
  if (bestE < 0) return out;
  // Refine around every coarse sample within 24 m of the best.
  let fd = 1e30;
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!edgeAlive[e] || edgePresence[e] <= 0) continue;
    const N = edgeN[e], base = e * MAX_PTS;
    const pen = (1 - edgePresence[e]) * fadeW;
    const lim = Math.min(N - 1, Math.floor((edgeDrawEnd[e] + DRAW_END_PAD) / STEP));
    for (let k = 0; k < lim; k += 8) {
      const o = (base + k) * 4;
      const dx = x - pts[o], dz = z - pts[o + 2];
      if (Math.sqrt(dx * dx + dz * dz) + pen > bestD + 24) continue;
      const k0 = Math.max(0, k - 8), k1 = Math.min(lim, k + 8);
      for (let q = k0; q < k1; q++) {
        const p = (base + q) * 4;
        const ax = pts[p], az = pts[p + 2];
        const sx = pts[p + 4] - ax, sz = pts[p + 6] - az;
        const px = x - ax, pz = z - az;
        let t = (px * sx + pz * sz) / (sx * sx + sz * sz);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - sx * t, ez = pz - sz * t;
        const d = Math.sqrt(ex * ex + ez * ez) + pen;
        if (d < fd) {
          fd = d;
          out[0] = d;
          out[1] = pts[p + 1] + (pts[p + 5] - pts[p + 1]) * t;
          out[2] = pts[p + 3] + (pts[p + 7] - pts[p + 3]) * t;
          out[3] = e;
          out[4] = (q + t) * STEP;
        }
      }
    }
  }
  return out;
}
