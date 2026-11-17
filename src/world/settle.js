// Settlements: the human footprint beside the road, era by era (round two, step B).
//
//   era 1 first farmers   round huts, fenced plots, pens with animals, hearth smoke
//   era 2 ancient         mud-brick / stone villages, walled and irrigated fields
//   era 3 500-1450        timber-and-thatch villages, strip fields, a windmill, a chapel
//   era 4 1450-1750       tiled towns with a spire, hedged fields, carts and coaches beside the road
//   era 5 1750-1914       brick terraces with smoking chimneys, factory stacks, gas lamps, telegraph
//   era 6 modern          suburbs, lit city blocks, streetlights, power lines, parked cars;
//                         from clock 272 the highway's reflector posts
// Materials and forms vary by biome (a desert village is flat-roofed mud brick, a steppe one
// has felt yurts); the ice has almost nothing.
//
// Placement. When a graph edge is built (onEdgeReady) the CPU lays out lots along it once, for
// every era: zones of countryside and settlement, rows of houses facing the road, fields,
// lamps, poles. A lot is 64 bytes (position, yaw, journey metres, size, clock range [c0, c1),
// colours, kind and style bits). Nothing is ever placed on the road: every frame a compute
// pass checks each live lot against the road field at its footprint corners (so a fork
// built later clears it), landmark pads (with a wide berth, and the far side of the road from
// a landmark kept open), water, the strait, steep ground and deep snow, caching the ground
// height and slope; then it applies the era with its front, culls to the view and appends
// survivors to per-kind lists drawn with drawIndexedIndirect.
//
// Time. A lot is shown while the display clock is in [c0, c1). At each change (era starts,
// clock 245 and 272) a front leaves the car and runs down the road at FRONT_SPEED (time.js),
// like the road's remaking front: behind it the new clock, ahead the old one. Old buildings
// sink into the ground as it arrives, new ones rise behind it (clipped from the ground up),
// each lot a little staggered, so a visible wave runs down the street.
//
// Grass and props thin out where buildings and fields stand: lots are splatted every frame
// into world.settleTex (camera-centred, see world.js settleAt), which siteClear() reads.
//
// Light: walls get procedural windows (lit at random, warmer and more of them in later eras),
// lamps and reflectors glow; all emissive, scaled by how low the sun is. applyDusk() lowers
// the key sun over the last part of the journey so the present arrives at dusk.
//
// Debug: ?hide=settle; window.__settle.stats().

import { gpu, tsw, addDrawable, addPrePass, mainPipeline, shadowPipeline } from '../gpu.js';
import { MAIN_HEADER, SHADOW_HEADER, FRAME_STRUCT } from '../shaders/common.js';
import { MeshBuilder, packMeshes, VERTEX_LAYOUT } from '../mesh.js';
import { WORLD_WGSL, world, fieldOrigin, SETTLE_MAP, siteData, siteSight, MAX_PADS } from './world.js';
import { MAX_EDGES, edgeAlive, edgeLen, edgeJ0, edgeRegion, edgeParentRegion, edgeFrom, edgeExit, edgeDrawEnd, nodeKey, onEdgeReady, onEdgeFreed, onTunnelPlanned, frameAt, clockBase, edgeSplit, edgeSeam } from './graph.js';
import { ERA_START, FRONT_SPEED, FRONT_LEAD, FRONT_DONE } from './time.js';
import { state, env, updateSun } from '../state.js';

// ------------------------------------------------------------------------------- kinds
const K_GABLE = 0, K_HIP = 1, K_FLAT = 2, K_ROUND = 3, K_CHAPEL = 4, K_CHURCH = 5, K_MILL = 6, K_STACK = 7, K_FACTORY = 8,
  K_FENCE = 9, K_HEDGE = 10, K_WALL = 11, K_FIELD = 12, K_CART = 13, K_COACH = 14, K_POLE = 15, K_GASLAMP = 16, K_LAMP = 17,
  K_CAR = 18, K_PERSON = 19, K_ANIMAL = 20, K_POST = 21, K_HAY = 22, NK = 23, K_NONE = 31;
// Per kind: list capacity, draw distance (m), top (mesh units), footprint half extents x / z
// (mesh units), mask margin (m, -1: does not clear grass and props).
const CAP = [1024, 512, 768, 512, 64, 64, 64, 512, 64, 768, 768, 512, 768, 128, 64, 512, 256, 512, 256, 256, 256, 512, 256, 512];
const MAXD = [1300, 1000, 1700, 900, 1700, 2000, 1700, 700, 2000, 320, 650, 450, 950, 240, 260, 750, 320, 900, 320, 170, 230, 420, 380];
const KTOP = [1.5, 1.5, 1.5, 1.5, 10.6, 36, 21.2, 1.75, 30.8, 1.15, 1, 1, 1, 1.3, 2.4, 1, 3.35, 7.5, 1.5, 1.72, 1.3, 1.05, 2.75];
const KFX = [0.5, 0.5, 0.5, 0.5, 3.3, 4.3, 3.3, 0.4, 2.3, 3.1, 0.5, 0.5, 0.5, 3, 1.7, 0.9, 0.2, 0.25, 2.2, 0.3, 1.2, 0.1, 1.6];
const KFZ = [0.5, 0.5, 0.5, 0.5, 6.5, 14.5, 3.3, 0.4, 2.3, 0.1, 0.5, 0.5, 0.5, 0.9, 0.9, 0.15, 0.2, 2.1, 0.9, 0.2, 0.4, 0.1, 1.6];
const MASKM = [2.5, 2.5, 2.5, 2.5, 3, 3, 3, -1, 3, -1, 0.6, 0.6, 0.2, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0.6];
const UNIT = (1 << K_GABLE) | (1 << K_HIP) | (1 << K_FLAT) | (1 << K_ROUND) | (1 << K_HEDGE) | (1 << K_WALL) | (1 << K_FIELD);
const NL = NK + 1; // lists: one per kind, then smoke sources

// Lot bits: kind 0-4, wall style 5-7, roof style 8-10, light 11-12, flags, variant 22-29.
const B_SMOKE = 1 << 13, B_ATT = 1 << 15, B_ICE = 1 << 16, B_WIN = 1 << 17, B_DOOR = 1 << 18, B_ROWS = 1 << 19;
const WS_PLASTER = 0, WS_MUD = 1, WS_TIMBER = 2, WS_BRICK = 3, WS_STONE = 4, WS_PLANK = 5, WS_CONC = 6, WS_GLASS = 7;
const RS_THATCH = 0, RS_TILE = 1, RS_SLATE = 2, RS_TIN = 3, RS_FLAT = 4, RS_SHINGLE = 5, RS_FELT = 6;
const L_NONE = 0, L_CANDLE = 1, L_GAS = 2, L_ELEC = 3;
// Vertex flags (mesh `extra`): roof remap, eave overhang, hip ridge, radial overhang, metric
// top part, metric xz with scaled y, wire span, windmill sail.
const F_ROOF = 1, F_OH = 2, F_HIP = 4, F_ROH = 8, F_TOP = 16, F_MY = 32, F_WIRE = 64, F_SAIL = 128, F_LUMP = 256;
// Materials (mesh `mat`).
const M_WALL = 0, M_ROOF = 1, M_TIMBER = 2, M_STONE = 3, M_DOOR = 4, M_LAMP = 5, M_METAL = 6, M_CROP = 7, M_LEAF = 8,
  M_PAINT = 9, M_WHITE = 10, M_REFL = 11, M_WIRE = 12, M_CLOTH = 13, M_SKIN = 14, M_GLASS = 15;

// ------------------------------------------------------------------------------- meshes
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
// Planar convex polygon, flat normal turned toward `hint`.
function face(m, P, hint, mat, fl = 0) {
  let n = nrm(crs(sub(P[1], P[0]), sub(P[2], P[0])));
  let Q = P;
  if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) { Q = P.slice().reverse(); n = [-n[0], -n[1], -n[2]]; }
  const id = Q.map((p) => m.vert(p, n, mat, fl));
  for (let k = 1; k < id.length - 1; k++) m.i.push(id[0], id[k], id[k + 1]);
}
// Box; `top` / `bot` faces optional; flg(y) can flag vertices by height.
function box(m, x0, y0, z0, x1, y1, z1, mat, fl = 0, top = true, bot = false) {
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const F = (P) => { const h = sub(P.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]), c); face(m, P, h, mat, fl); };
  F([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
  F([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]);
  F([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  F([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]);
  if (top) F([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
  if (bot) F([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
}
// Surface of revolution about +y at (cx, cz): prof [[r, y], ...] bottom to top, smooth normals.
// flg(j) -> vertex flags of profile row j. inside: also the flipped inner skin (eaves).
function lathe(m, prof, seg, mat, flg = () => 0, cx = 0, cz = 0, inMat = -1, ang0 = 0) {
  const ring = (j, inv) => {
    const [r, y] = prof[j];
    const a = prof[Math.max(0, j - 1)], b = prof[Math.min(prof.length - 1, j + 1)];
    let nr = b[1] - a[1], ny = a[0] - b[0];
    const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
    const out = [];
    for (let i = 0; i <= seg; i++) {
      const t = ang0 + (i / seg) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const n = inv ? [-c * nr, -ny, -s * nr] : [c * nr, ny, s * nr];
      out.push(m.vert([cx + c * r, y, cz + s * r], n, inv ? inMat : mat, flg(j)));
    }
    return out;
  };
  for (const inv of inMat >= 0 ? [false, true] : [false]) {
    const R = prof.map((_, j) => ring(j, inv));
    for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < seg; i++) {
      const a = R[j][i], b = R[j][i + 1], c = R[j + 1][i], d = R[j + 1][i + 1];
      if (inv) m.i.push(a, c, b, b, c, d); else m.i.push(a, b, c, b, d, c);
    }
  }
}
// Wheel (disc along z) at (x, y, z).
function wheel(m, x, y, z, r, w, mat) {
  const seg = 10, P0 = [], P1 = [];
  for (let i = 0; i < seg; i++) { const t = (i / seg) * Math.PI * 2; P0.push([x + Math.cos(t) * r, y + Math.sin(t) * r, z - w / 2]); P1.push([x + Math.cos(t) * r, y + Math.sin(t) * r, z + w / 2]); }
  face(m, P0, [0, 0, -1], mat); face(m, P1, [0, 0, 1], mat);
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; const mid = [(P0[i][0] + P0[j][0]) / 2 - x, (P0[i][1] + P0[j][1]) / 2 - y, 0]; face(m, [P0[i], P0[j], P1[j], P1[i]], mid, mat); }
}
// Gable roof over the unit box (ridge along x), with eaves and the flipped underside.
function gableRoof(m, mat) {
  for (const s of [1, -1]) {
    const P = [[-0.5, 1, 0.5 * s], [0.5, 1, 0.5 * s], [0.5, 1.5, 0], [-0.5, 1.5, 0]];
    face(m, P, [0, 1, s], mat, F_ROOF | F_OH);
    face(m, P, [0, -1, -s], M_TIMBER, F_ROOF | F_OH);
  }
  for (const s of [1, -1]) face(m, [[0.5 * s, 1, -0.5], [0.5 * s, 1, 0.5], [0.5 * s, 1.5, 0]], [s, 0, 0], M_WALL, F_ROOF);
}
function unitWalls(m, y0 = -0.8, y1 = 1) { box(m, -0.5, y0, -0.5, 0.5, y1, 0.5, M_WALL, 0, false); }

function buildMeshes() {
  const M = [];
  let m;
  // 0 gable house
  m = new MeshBuilder(); unitWalls(m); gableRoof(m, M_ROOF); M.push(m.build());
  // 1 hip roof house (ridge ends pulled in by the shader to keep every face at the pitch)
  m = new MeshBuilder(); unitWalls(m);
  for (const s of [1, -1]) {
    const P = [[-0.5, 1, 0.5 * s], [0.5, 1, 0.5 * s], [0.25, 1.5, 0], [-0.25, 1.5, 0]];
    face(m, P, [0, 1, s], M_ROOF, F_ROOF | F_OH | F_HIP);
    face(m, P, [0, -1, -s], M_TIMBER, F_ROOF | F_OH | F_HIP);
    const T = [[0.5 * s, 1, -0.5], [0.5 * s, 1, 0.5], [0.25 * s, 1.5, 0]];
    face(m, T, [s, 1, 0], M_ROOF, F_ROOF | F_OH | F_HIP);
    face(m, T, [-s, -1, 0], M_TIMBER, F_ROOF | F_OH | F_HIP);
  }
  M.push(m.build());
  // 2 flat roof block: walls up to the parapet top (1.5 -> eave + H), roof slab inside it
  m = new MeshBuilder();
  box(m, -0.5, -0.8, -0.5, 0.5, 1, 0.5, M_WALL, 0, false);
  for (const [P, h] of [
    [[[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1.5, 0.5], [-0.5, 1.5, 0.5]], [0, 0, 1]], [[[-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1.5, -0.5], [-0.5, 1.5, -0.5]], [0, 0, -1]],
    [[[0.5, 1, -0.5], [0.5, 1, 0.5], [0.5, 1.5, 0.5], [0.5, 1.5, -0.5]], [1, 0, 0]], [[[-0.5, 1, -0.5], [-0.5, 1, 0.5], [-0.5, 1.5, 0.5], [-0.5, 1.5, -0.5]], [-1, 0, 0]]]) face(m, P, h, M_WALL, F_ROOF);
  const e = 0.485;
  for (const [a, b, c, d] of [[[-0.5, 0.5], [0.5, 0.5], [e, e], [-e, e]], [[-0.5, -0.5], [0.5, -0.5], [e, -e], [-e, -e]], [[0.5, -0.5], [0.5, 0.5], [e, e], [e, -e]], [[-0.5, -0.5], [-0.5, 0.5], [-e, e], [-e, -e]]]) {
    face(m, [a, b, c, d].map((q) => [q[0], 1.5, q[1]]), [0, 1, 0], M_STONE, F_ROOF); // parapet coping
  }
  face(m, [[-e, 1.25, -e], [e, 1.25, -e], [e, 1.25, e], [-e, 1.25, e]], [0, 1, 0], M_ROOF, F_ROOF);
  for (const [P, h] of [[[[-e, 1.25, e], [e, 1.25, e], [e, 1.5, e], [-e, 1.5, e]], [0, 0, -1]], [[[-e, 1.25, -e], [e, 1.25, -e], [e, 1.5, -e], [-e, 1.5, -e]], [0, 0, 1]],
    [[[e, 1.25, -e], [e, 1.25, e], [e, 1.5, e], [e, 1.5, -e]], [-1, 0, 0]], [[[-e, 1.25, -e], [-e, 1.25, e], [-e, 1.5, e], [-e, 1.5, -e]], [1, 0, 0]]]) face(m, P, h, M_WALL, F_ROOF);
  M.push(m.build());
  // 3 round house / hut / yurt: cylinder wall, cone roof with radial eaves
  m = new MeshBuilder();
  lathe(m, [[0.5, -0.6], [0.5, 1]], 14, M_WALL);
  lathe(m, [[0.5, 1], [0.27, 1.27], [0, 1.5]], 14, M_ROOF, (j) => F_ROOF | (j === 0 ? F_ROH : 0), 0, 0, M_TIMBER);
  M.push(m.build());
  // 4 chapel (metric): nave with its gable to the road, a bell-cote
  m = new MeshBuilder();
  box(m, -3, -1.2, -6, 3, 5, 4, M_WALL, 0, false);
  for (const s of [1, -1]) { const P = [[3.4 * s, 4.7, -6.4], [3.4 * s, 4.7, 4.4], [0, 8.4, 4.4], [0, 8.4, -6.4]]; face(m, P, [s, 1, 0], M_ROOF); face(m, P, [-s, -1, 0], M_TIMBER); }
  for (const z of [4, -6]) face(m, [[-3, 5, z], [3, 5, z], [0, 8.1, z]], [0, 0, z], M_WALL);
  box(m, -0.65, 7.4, 3.3, 0.65, 9.6, 4.3, M_WALL);
  face(m, [[-0.8, 9.6, 3.15], [0.8, 9.6, 3.15], [0, 10.6, 3.8]], [0, 1, -1], M_ROOF); face(m, [[-0.8, 9.6, 4.45], [0.8, 9.6, 4.45], [0, 10.6, 3.8]], [0, 1, 1], M_ROOF);
  face(m, [[-0.8, 9.6, 3.15], [-0.8, 9.6, 4.45], [0, 10.6, 3.8]], [-1, 1, 0], M_ROOF); face(m, [[0.8, 9.6, 3.15], [0.8, 9.6, 4.45], [0, 10.6, 3.8]], [1, 1, 0], M_ROOF);
  M.push(m.build());
  // 5 church: long nave, west tower to the road with a tall spire
  m = new MeshBuilder();
  box(m, -4, -1.2, -16, 4, 8, 2, M_WALL, 0, false);
  for (const s of [1, -1]) { const P = [[4.4 * s, 7.7, -16.4], [4.4 * s, 7.7, 2], [0, 13, 2], [0, 13, -16.4]]; face(m, P, [s, 1, 0], M_ROOF); face(m, P, [-s, -1, 0], M_TIMBER); }
  face(m, [[-4, 8, -16], [4, 8, -16], [0, 12.7, -16]], [0, 0, -1], M_WALL);
  box(m, -3, -1.2, 2, 3, 20, 8, M_WALL);
  box(m, -3.3, 20, 1.7, 3.3, 20.6, 8.3, M_STONE);
  for (const [a, b] of [[[-3, 20.6, 2], [3, 20.6, 2]], [[3, 20.6, 2], [3, 20.6, 8]], [[3, 20.6, 8], [-3, 20.6, 8]], [[-3, 20.6, 8], [-3, 20.6, 2]]]) {
    face(m, [a, b, [0, 36, 5]], [(a[0] + b[0]) / 2, 0.2, (a[2] + b[2]) / 2 - 5], M_ROOF);
  }
  M.push(m.build());
  // 6 windmill: tapered tower, boat cap, four sails (rotated by the shader about the hub)
  m = new MeshBuilder();
  lathe(m, [[3.3, -1.2], [3.1, 1], [2.25, 11]], 8, M_WALL, () => 0, 0, 0, -1, Math.PI / 8);
  lathe(m, [[2.6, 11], [2.55, 12.2], [1.3, 13.6], [0, 14.1]], 8, M_ROOF, () => 0, 0, 0, M_TIMBER, Math.PI / 8);
  box(m, -0.35, 11.25, 2.2, 0.35, 11.95, 3.1, M_TIMBER, F_SAIL);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + 0.3, ca = Math.cos(a), sa = Math.sin(a);
    const R = (x, y, z) => [ca * x - sa * y, 11.6 + sa * x + ca * y, z];
    const quadT = (x0, x1, y0, y1, z, mat) => { face(m, [R(x0, y0, z), R(x1, y0, z), R(x1, y1, z), R(x0, y1, z)], [0, 0, 1], mat, F_SAIL); face(m, [R(x0, y0, z - 0.04), R(x1, y0, z - 0.04), R(x1, y1, z - 0.04), R(x0, y1, z - 0.04)], [0, 0, -1], mat, F_SAIL); };
    quadT(0.4, 9.6, -0.12, 0.12, 3.15, M_TIMBER);
    quadT(2.2, 9.3, 0.12, 1.7, 3.12, M_WHITE);
    for (let r = 2.2; r < 9.4; r += 1.18) quadT(r, r + 0.08, 0.12, 1.75, 3.17, M_TIMBER);
  }
  M.push(m.build());
  // 7 house chimney stack (attached to a roof), two pots
  m = new MeshBuilder();
  box(m, -0.33, -1.6, -0.33, 0.33, 1.3, 0.33, M_WALL);
  box(m, -0.4, 1.3, -0.4, 0.4, 1.45, 0.4, M_STONE);
  for (const x of [-0.15, 0.15]) lathe(m, [[0.1, 1.45], [0.085, 1.75]], 6, M_ROOF, () => 0, x, 0);
  M.push(m.build());
  // 8 factory stack
  m = new MeshBuilder();
  box(m, -2.2, -1.2, -2.2, 2.2, 4, 2.2, M_WALL);
  lathe(m, [[1.55, 3.9], [1.45, 6], [0.95, 30]], 12, M_WALL);
  lathe(m, [[1.15, 29.9], [1.2, 30.8], [0.85, 30.8]], 12, M_STONE);
  M.push(m.build());
  // 9 fence, 6 m
  m = new MeshBuilder();
  for (const x of [-3, -1, 1, 3]) box(m, x - 0.07, -0.3, -0.07, x + 0.07, 1.15, 0.07, M_TIMBER);
  for (const y of [0.5, 0.92]) box(m, -3.05, y, -0.035, 3.05, y + 0.1, 0.035, M_TIMBER, 0, true, true);
  M.push(m.build());
  // 10 hedge (unit, rounded)
  m = new MeshBuilder();
  { const NX = 20, NA = 8, id = [];
    for (let i = 0; i <= NX; i++) for (let j = 0; j <= NA; j++) {
      const t = (j / NA) * Math.PI, st = Math.sin(t);
      id.push(m.vert([i / NX - 0.5, -0.15 + 1.15 * Math.pow(st, 0.45), -0.5 * Math.cos(t)], nrm([0, st, -Math.cos(t)]), M_LEAF, F_LUMP));
    }
    for (let i = 0; i < NX; i++) for (let j = 0; j < NA; j++) { const a = id[i * (NA + 1) + j], b = a + 1, c = a + NA + 1, d = c + 1; m.i.push(a, c, b, b, c, d); }
    for (const x of [-0.5, 0.5]) face(m, Array.from({ length: NA + 1 }, (_, j) => { const t = (j / NA) * Math.PI; return [x, -0.15 + 1.15 * Math.pow(Math.sin(t), 0.45), -0.5 * Math.cos(t)]; }), [x, 0, 0], M_LEAF, F_LUMP); }
  M.push(m.build());
  // 11 low wall (unit), a capping course
  m = new MeshBuilder(); box(m, -0.5, -0.5, -0.5, 0.5, 0.88, 0.5, M_WALL); box(m, -0.53, 0.88, -0.56, 0.53, 1, 0.56, M_STONE); M.push(m.build());
  // 12 field: crop canopy (unit; the top is a grid so the shader can tilt it), crop sides
  m = new MeshBuilder();
  { const G = 6, id = [];
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) id.push(m.vert([i / G - 0.5, 1, j / G - 0.5], [0, 1, 0], M_CROP, F_LUMP));
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const a = id[j * (G + 1) + i], b = a + 1, c = a + G + 1, d = c + 1; m.i.push(a, c, b, b, c, d); }
    box(m, -0.5, -0.6, -0.5, 0.5, 1, 0.5, M_CROP, F_LUMP, false); }
  M.push(m.build());
  // 13 cart
  m = new MeshBuilder();
  box(m, -1.2, 0.75, -0.65, 1.0, 0.92, 0.65, M_TIMBER, 0, true, true);
  for (const z of [-0.65, 0.65]) box(m, -1.2, 0.92, z - 0.03, 1.0, 1.28, z + 0.03, M_TIMBER);
  box(m, -1.25, 0.92, -0.65, -1.2, 1.28, 0.65, M_TIMBER);
  for (const z of [-0.8, 0.8]) wheel(m, -0.15, 0.62, z, 0.62, 0.09, M_TIMBER);
  for (const z of [-0.45, 0.45]) face(m, [[1.0, 0.86, z - 0.04], [1.0, 0.94, z + 0.04], [3.0, 0.22, z + 0.04], [3.0, 0.14, z - 0.04]], [0, 1, 0], M_TIMBER);
  M.push(m.build());
  // 14 coach
  m = new MeshBuilder();
  box(m, -1.1, 0.95, -0.72, 1.0, 2.25, 0.72, M_PAINT, 0, false, true);
  box(m, -1.2, 2.25, -0.8, 1.1, 2.4, 0.8, M_METAL);
  for (const s of [1, -1]) face(m, [[-0.75, 1.55, 0.722 * s], [0.6, 1.55, 0.722 * s], [0.6, 2.05, 0.722 * s], [-0.75, 2.05, 0.722 * s]], [0, 0, s], M_GLASS);
  face(m, [[1.001, 1.55, -0.5], [1.001, 1.55, 0.5], [1.001, 2.05, 0.5], [1.001, 2.05, -0.5]], [1, 0, 0], M_GLASS);
  box(m, 1.0, 1.45, -0.62, 1.65, 1.58, 0.62, M_TIMBER);
  box(m, -1.3, 0.55, -0.12, 1.8, 0.7, 0.12, M_TIMBER);
  for (const z of [-0.82, 0.82]) { wheel(m, -0.75, 0.62, z, 0.62, 0.08, M_TIMBER); wheel(m, 1.15, 0.48, z, 0.48, 0.08, M_TIMBER); }
  M.push(m.build());
  // 15 pole: body (metric xz, scaled height), cross-arm and insulators at the top, four wires
  m = new MeshBuilder();
  lathe(m, [[0.13, -0.4], [0.1, 1]], 6, M_TIMBER, () => F_MY);
  box(m, -0.85, 0.63, -0.065, 0.85, 0.74, 0.065, M_TIMBER, F_TOP, true, true);
  for (const x of [-0.7, -0.25, 0.25, 0.7]) {
    box(m, x - 0.04, 0.74, -0.04, x + 0.04, 0.85, 0.04, M_WHITE, F_TOP);
    const W = 12, id = [];
    for (let j = 0; j <= W; j++) {
      const z = j / W;
      for (const [dx, dy] of [[-0.016, 0.83], [0.016, 0.83], [0.016, 0.865], [-0.016, 0.865]]) id.push(m.vert([x + dx, dy, z], nrm([dx, dy - 0.848, 0]), M_WIRE, F_WIRE));
    }
    for (let j = 0; j < W; j++) for (let k = 0; k < 4; k++) { const a = j * 4 + k, b = j * 4 + (k + 1) % 4; m.i.push(id[a], id[b], id[a + 4], id[b], id[b + 4], id[a + 4]); }
  }
  M.push(m.build());
  // 16 gas lamp
  m = new MeshBuilder();
  lathe(m, [[0.16, 0], [0.13, 0.45], [0.06, 0.6], [0.05, 2.65]], 6, M_METAL);
  box(m, -0.17, 2.65, -0.17, 0.17, 3.05, 0.17, M_LAMP, 0, false, true);
  for (const [P, h] of [[[[-0.21, 3.05, -0.21], [0.21, 3.05, -0.21], [0, 3.3, 0]], [0, 1, -1]], [[[0.21, 3.05, -0.21], [0.21, 3.05, 0.21], [0, 3.3, 0]], [1, 1, 0]],
    [[[0.21, 3.05, 0.21], [-0.21, 3.05, 0.21], [0, 3.3, 0]], [0, 1, 1]], [[[-0.21, 3.05, 0.21], [-0.21, 3.05, -0.21], [0, 3.3, 0]], [-1, 1, 0]]]) face(m, P, h, M_METAL);
  M.push(m.build());
  // 17 streetlight: pole, an arm toward the road (+z, never past the verge), the lamp head
  m = new MeshBuilder();
  lathe(m, [[0.13, -0.3], [0.1, 0.4], [0.08, 7.4]], 6, M_METAL);
  box(m, -0.05, 7.25, 0, 0.05, 7.37, 1.5, M_METAL, 0, true, true);
  box(m, -0.2, 7.3, 1.35, 0.2, 7.5, 2.05, M_METAL, 0, true, false);
  face(m, [[-0.17, 7.29, 1.4], [0.17, 7.29, 1.4], [0.17, 7.29, 2.0], [-0.17, 7.29, 2.0]], [0, -1, 0], M_LAMP);
  M.push(m.build());
  // 18 parked car
  m = new MeshBuilder();
  m.mat = M_PAINT; m.place(0, 0.66, 0).rbox(2.15, 0.34, 0.86, 0.3, 20, 10);
  m.mat = M_GLASS; m.place(-0.25, 1.1, 0).rbox(1.2, 0.33, 0.78, 0.35, 16, 8);
  for (const x of [-1.35, 1.35]) for (const z of [-0.8, 0.8]) wheel(m, x, 0.34, z, 0.34, 0.22, M_METAL);
  M.push(m.build());
  // 19 person, standing (facing +z)
  m = new MeshBuilder();
  for (const x of [-0.1, 0.1]) box(m, x - 0.075, 0, -0.08, x + 0.075, 0.86, 0.08, M_CLOTH);
  m.mat = M_CLOTH; m.place(0, 1.16, 0).rbox(0.21, 0.33, 0.13, 0.5, 12, 8);
  for (const x of [-0.27, 0.27]) box(m, x - 0.05, 0.8, -0.05, x + 0.05, 1.42, 0.05, M_CLOTH);
  m.mat = M_SKIN; m.place(0, 1.6, 0).blob(0.11, 0.13, 0.11, 10, 6);
  M.push(m.build());
  // 20 animal (cow at scale 1, sheep / goat smaller), side on to +x
  m = new MeshBuilder();
  m.mat = M_CLOTH; m.place(0, 0.95, 0).blob(0.78, 0.38, 0.34, 12, 8);
  m.place(0.98, 1.08, 0, 0, 0, -0.5).blob(0.26, 0.17, 0.16, 8, 6);
  for (const x of [-0.5, 0.5]) for (const z of [-0.18, 0.18]) box(m, x - 0.06, 0, z - 0.06, x + 0.06, 0.75, z + 0.06, M_CLOTH);
  M.push(m.build());
  // 21 highway reflector post (reflector on the +z face, toward the road)
  m = new MeshBuilder();
  box(m, -0.06, -0.2, -0.06, 0.06, 1.05, 0.06, M_WHITE);
  box(m, -0.063, 0.78, -0.063, 0.063, 0.92, 0.063, M_METAL, 0, false);
  face(m, [[-0.04, 0.81, 0.064], [0.04, 0.81, 0.064], [0.04, 0.89, 0.064], [-0.04, 0.89, 0.064]], [0, 0, 1], M_REFL);
  M.push(m.build());
  // 22 haystack
  m = new MeshBuilder(); lathe(m, [[1.45, -0.3], [1.55, 0.6], [1.3, 1.6], [0.7, 2.4], [0, 2.75]], 10, M_ROOF); M.push(m.build());
  return M;
}

// ------------------------------------------------------------------------------- palette
const C = (r, g, b) => Math.round(Math.sqrt(r) * 255) | (Math.round(Math.sqrt(g) * 255) << 8) | (Math.round(Math.sqrt(b) * 255) << 16);
const P_MUDRED = C(0.40, 0.24, 0.14), P_MUDSAND = C(0.55, 0.42, 0.28), P_MUDGREY = C(0.40, 0.34, 0.26), P_THATCH = C(0.36, 0.26, 0.12),
  P_THATCHD = C(0.33, 0.26, 0.15), P_WHITE = C(0.74, 0.71, 0.65), P_CREAM = C(0.70, 0.62, 0.47), P_OCHRE = C(0.62, 0.44, 0.24),
  P_STONE = C(0.43, 0.40, 0.35), P_STONEW = C(0.52, 0.45, 0.34), P_TILE = C(0.50, 0.19, 0.09), P_SLATE = C(0.12, 0.13, 0.15),
  P_BRICK = C(0.36, 0.13, 0.07), P_BRICKD = C(0.27, 0.11, 0.07), P_PLANKR = C(0.36, 0.08, 0.05), P_PLANK = C(0.30, 0.20, 0.12),
  P_TIN = C(0.33, 0.34, 0.35), P_RUST = C(0.36, 0.18, 0.10), P_CONC = C(0.50, 0.49, 0.46), P_TAR = C(0.13, 0.13, 0.13),
  P_FELT = C(0.72, 0.68, 0.58), P_HIDE = C(0.33, 0.24, 0.15), P_SHINGLE = C(0.24, 0.17, 0.11), P_GLASSB = C(0.30, 0.38, 0.42);
const PASTEL = [C(0.74, 0.55, 0.38), C(0.46, 0.58, 0.62), C(0.78, 0.67, 0.40), C(0.70, 0.46, 0.42), C(0.56, 0.63, 0.48), C(0.76, 0.72, 0.62)];
const DESERT = [P_WHITE, P_CREAM, P_MUDSAND, C(0.66, 0.52, 0.38), C(0.72, 0.6, 0.5), C(0.62, 0.46, 0.3)];
const CROPS = [C(0.50, 0.40, 0.16), C(0.40, 0.42, 0.14), C(0.55, 0.45, 0.2), C(0.22, 0.15, 0.09), C(0.30, 0.38, 0.10), C(0.58, 0.50, 0.08)];
const CLOTH = [C(0.42, 0.13, 0.08), C(0.15, 0.20, 0.34), C(0.42, 0.38, 0.25), C(0.25, 0.30, 0.15), C(0.55, 0.5, 0.42), C(0.3, 0.22, 0.15)];
const CARS = [C(0.45, 0.04, 0.03), C(0.04, 0.12, 0.30), C(0.62, 0.62, 0.60), C(0.05, 0.05, 0.055), C(0.50, 0.40, 0.12), C(0.12, 0.25, 0.18)];
const FUR = [C(0.30, 0.20, 0.12), C(0.62, 0.60, 0.55), C(0.18, 0.13, 0.09), C(0.5, 0.42, 0.32)];

// ------------------------------------------------------------------------------- lots
const LPE = 1024; // lot slots per edge
const NLOT = MAX_EDGES * LPE;
const lotF = new Float32Array(NLOT * 16), lotU = new Uint32Array(lotF.buffer);
const dirty = new Uint8Array(MAX_EDGES);
const zeros = new Float32Array(LPE * 4);
const genCount = new Int32Array(MAX_EDGES);
const FA = new Float64Array(8);
const H = new Float64Array(16); // house style: kind, wall, roof, colA, colB, pitch, sx, sy, sz, light, bits
const ZN = new Float64Array(64 * 4);
const PEN = new Float64Array([0, -3, 0, 0, 3, 0, -3, 0, Math.PI / 2, 3, 0, Math.PI / 2]); // a 6 m square pen of fences // zones: s0, s1, weight, region
const QUOTA = [0, 110, 150, 175, 190, 190, 209]; // lots per era per edge (sums to LPE)
const ERA_C0 = [0, 40, 80, 120, 165, 210, 255], ERA_C1 = [40, 80, 120, 165, 210, 255, 1e5];
let gE = 0, gBase = 0, gN = 0, gCap = 0, rs = 1;
function rnd() { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; }
function pick(a) { return a[Math.floor(rnd() * a.length) % a.length]; }

// One lot at road s, lateral lat (right +), yaw relative to "front faces the road".
function put(k, s, lat, yr, sx, sy, sz, pw, c0, c1, ca, cb, bits, clr) {
  if (gN >= gCap) return -1;
  FA[4] = s; FA[5] = lat; frameAt(gE, FA);
  const h = FA[3], i = (gBase + gN) * 16;
  lotF[i] = FA[0]; lotF[i + 1] = FA[2]; lotF[i + 2] = h + (lat > 0 ? Math.PI : 0) + yr; lotF[i + 3] = edgeJ0[gE] + s;
  lotF[i + 4] = sx; lotF[i + 5] = sy; lotF[i + 6] = sz; lotF[i + 7] = pw;
  lotF[i + 8] = c0; lotF[i + 9] = c1; lotU[i + 10] = ca; lotU[i + 11] = cb;
  lotF[i + 12] = FA[0] + Math.sin(h) * lat; lotF[i + 13] = FA[2] - Math.cos(h) * lat;
  lotF[i + 14] = clr; lotU[i + 15] = k | bits | ((Math.floor(rnd() * 255) & 255) << 22);
  return gBase + gN++;
}
// A lot attached to another (chimneys): parent-local offset (x along, z toward the road), y
// above the parent's ground; it shares the parent's ground and validity.
function attach(par, k, lx, lz, yoff, s, bits, ca) {
  if (gN >= gCap || par < 0) return -1;
  const p = par * 16, i = (gBase + gN) * 16, a = lotF[p + 2], ca_ = Math.cos(a), sa = Math.sin(a);
  lotF[i] = lotF[p] + ca_ * lx - sa * lz; lotF[i + 1] = lotF[p + 1] + sa * lx + ca_ * lz; lotF[i + 2] = a; lotF[i + 3] = lotF[p + 3];
  lotF[i + 4] = s; lotF[i + 5] = s; lotF[i + 6] = s; lotF[i + 7] = 0;
  lotF[i + 8] = lotF[p + 8]; lotF[i + 9] = lotF[p + 9]; lotU[i + 10] = ca; lotU[i + 11] = P_TILE;
  lotF[i + 12] = par; lotF[i + 13] = yoff; lotF[i + 14] = 0; lotU[i + 15] = k | bits | B_ATT;
  return gBase + gN++;
}

// House style for region r in era e; `town` 0..1. Writes H.
function style(r, e, town) {
  const R = rnd();
  let k = K_GABLE, ws = WS_PLASTER, rf = RS_THATCH, ca = P_CREAM, cb = P_THATCH, pw = 1.0, sx = 7, sy = 2.6, sz = 5.5, li = L_NONE, b = B_DOOR;
  if (e === 1) {
    k = K_ROUND; ws = WS_MUD; ca = r === 0 ? P_MUDRED : r === 2 ? P_MUDSAND : P_MUDGREY; cb = R < 0.5 ? P_THATCH : P_THATCHD;
    sx = sz = 4.2 + rnd() * 1.6; sy = 1.5 + rnd() * 0.4; pw = 0.95 + rnd() * 0.25;
    if (r === 2) { k = K_FLAT; ws = WS_MUD; rf = RS_FLAT; cb = P_MUDSAND; sx = 4 + rnd() * 2; sz = 3.6 + rnd() * 1.6; sy = 2.3; pw = 0.8 / sz; }
    if (r === 4 || r === 1) { ws = WS_PLASTER; ca = P_HIDE; cb = P_HIDE; rf = RS_FELT; sy = 0.6; pw = 1.3; }
    if (r === 5) { ws = WS_STONE; ca = P_STONE; }
  } else if (e === 2) {
    if (r === 2 || r === 0 || r === 4) { k = K_FLAT; ws = WS_MUD; rf = RS_FLAT; ca = r === 0 ? P_MUDRED : P_MUDSAND; cb = ca; sx = 5 + rnd() * 4; sz = 4.5 + rnd() * 3; sy = 2.5 + (R < 0.2 ? 2.4 : 0); pw = 0.9 / sz; }
    else if (r === 3) { k = K_ROUND; ws = WS_MUD; ca = P_MUDGREY; cb = P_THATCH; sx = sz = 7 + rnd() * 3; sy = 1.9; pw = 1.05; }
    else { ws = WS_STONE; ca = r === 6 ? P_STONEW : P_STONE; rf = r === 6 ? RS_TILE : RS_SLATE; cb = r === 6 ? P_TILE : P_SLATE; pw = r === 6 ? 0.4 : 0.75; sx = 6 + rnd() * 3; sz = 5 + rnd(); sy = 2.6; }
    b |= B_WIN;
  } else if (e === 3) {
    if (r === 2) { k = K_FLAT; ws = WS_MUD; rf = RS_FLAT; ca = P_MUDSAND; cb = ca; sx = 6 + rnd() * 5; sz = 5 + rnd() * 3; sy = 2.8 + (R < 0.3 ? 3 : 0); pw = 0.9 / sz; }
    else if (r === 0) { k = K_ROUND; ws = WS_MUD; ca = P_MUDRED; cb = P_THATCH; sx = sz = 6 + rnd() * 3; sy = 2.1; pw = 1.05; }
    else if (r === 4 && R < 0.55) { k = K_ROUND; ws = WS_PLASTER; ca = P_FELT; rf = RS_FELT; cb = P_FELT; sx = sz = 5.5 + rnd() * 2; sy = 1.6; pw = 0.42; }
    else { ws = r === 6 || r === 5 ? WS_STONE : WS_TIMBER; ca = r === 6 ? P_STONEW : r === 5 ? P_STONE : P_CREAM; rf = r === 5 ? RS_SHINGLE : RS_THATCH; cb = r === 5 ? P_SHINGLE : (R < 0.5 ? P_THATCH : P_THATCHD); pw = r === 5 ? 0.7 : 1.15; sx = 7 + rnd() * 5; sz = 5 + rnd() * 1.5; sy = 2.7; }
    b |= B_WIN; li = L_CANDLE;
  } else if (e === 4) {
    if (r === 2 || r === 0) { k = K_FLAT; ws = R < 0.3 ? WS_MUD : WS_PLASTER; rf = RS_FLAT; ca = pick(DESERT); cb = P_MUDSAND; sx = 6 + rnd() * 6; sz = 6 + rnd() * 3; sy = 3 + (R < 0.5 ? 3 : 0) + rnd() * 0.6; pw = 0.9 / sz; }
    else if (r === 5 || r === 1) { ws = WS_PLANK; ca = P_PLANK; rf = RS_SLATE; cb = P_SLATE; pw = 0.65; sx = 8 + rnd() * 3; sz = 7; sy = 4.8; }
    else { ws = town > 0.55 ? WS_PLASTER : (R < 0.5 ? WS_TIMBER : WS_PLASTER); ca = pick([P_CREAM, P_OCHRE, P_WHITE, PASTEL[2]]); rf = RS_TILE; cb = P_TILE; pw = r === 6 ? 0.45 : 0.95; sx = 6 + rnd() * 3; sz = 7 + rnd() * 2; sy = town > 0.55 ? 5.6 + rnd() : 3; }
    b |= B_WIN; li = L_CANDLE;
  } else if (e === 5) {
    if (r === 2 || r === 0) { k = K_FLAT; ws = WS_PLASTER; rf = RS_FLAT; ca = pick(DESERT); cb = P_MUDSAND; sx = 8 + rnd() * 6; sz = 7 + rnd() * 3; sy = 3 + (R < 0.7 ? 3 : 0) + rnd(); pw = 0.9 / sz; }
    else if (r === 1 || r === 5) { ws = WS_PLANK; ca = R < 0.5 ? P_PLANKR : P_PLANK; rf = RS_TIN; cb = P_TIN; pw = 0.6; sx = 8; sz = 7; sy = 5; }
    else { ws = r === 6 ? WS_PLASTER : WS_BRICK; ca = r === 6 ? pick(PASTEL) : (R < 0.6 ? P_BRICK : P_BRICKD); rf = RS_SLATE; cb = P_SLATE; pw = 0.62; sx = town > 0.5 ? 18 + rnd() * 18 : 7 + rnd() * 3; sz = 8.5; sy = town > 0.5 ? 6.5 + rnd() * 2.5 : 5.5; }
    b |= B_WIN; li = L_GAS;
  } else {
    k = K_HIP; ws = R < 0.35 ? WS_BRICK : WS_PLASTER; ca = ws === WS_BRICK ? P_BRICK : pick(PASTEL); rf = R < 0.5 ? RS_TILE : RS_SLATE; cb = rf === RS_TILE ? P_TILE : P_SLATE;
    pw = 0.5; sx = 9 + rnd() * 4; sz = 8 + rnd() * 2; sy = R < 0.45 ? 5.6 : 2.9; li = L_ELEC; b |= B_WIN;
    if (r === 2) { k = K_FLAT; ws = WS_PLASTER; ca = pick([P_WHITE, P_CREAM, PASTEL[0]]); rf = RS_FLAT; cb = P_CONC; sy = 3.2 + (R < 0.4 ? 3 : 0); pw = 0.9 / sz; }
    if (r === 1 || r === 5) { k = K_GABLE; ws = WS_PLANK; ca = R < 0.6 ? P_PLANKR : P_PLANK; rf = RS_TIN; cb = P_TIN; pw = 0.75; b |= B_ICE; }
    if (r === 6 && R < 0.5) { rf = RS_TILE; cb = P_TILE; ca = P_WHITE; }
  }
  H[0] = k; H[1] = ws; H[2] = rf; H[3] = ca; H[4] = cb; H[5] = pw; H[6] = sx; H[7] = sy; H[8] = sz; H[9] = li; H[10] = b;
}
function house(s, lat, yr, c0, c1, smoke) {
  const k = H[0], b = (H[10] | (H[1] << 5) | (H[2] << 8) | (H[9] << 11) | (smoke ? B_SMOKE : 0)) >>> 0;
  return put(k, s, lat, yr, H[6], H[7], H[8], H[5], c0, c1, H[3], H[4], b, 6.2);
}

function field(s, lat, sx, sz, col, rows, c0, c1, edge) {
  const i = put(K_FIELD, s, lat, 0, sx, 0.16 + rnd() * 0.24, sz, 0, c0, c1, col, col, rows ? B_ROWS : 0, 5.6);
  if (i < 0 || !edge) return;
  // boundaries: edge 1 fence, 2 hedge, 3 low wall (road side, two flanks, back)
  const sgn = lat > 0 ? 1 : -1, d = Math.abs(lat), front = d - sz / 2 - 0.9, back = d + sz / 2 + 0.9;
  if (edge === 1) {
    for (let x = -sx / 2 + 3; x < sx / 2 - 1; x += 6) { put(K_FENCE, s + x, sgn * front, 0, 1, 1, 1, 0, c0, c1, 0, 0, 0, 5); put(K_FENCE, s + x, sgn * back, 0, 1, 1, 1, 0, c0, c1, 0, 0, 0, 5); }
    for (let z = front + 3; z < back - 1; z += 6) for (let x = -sx / 2 - 0.9; x < sx; x += sx + 1.8) put(K_FENCE, s + x, sgn * z, Math.PI / 2, 1, 1, 1, 0, c0, c1, 0, 0, 0, 5);
    return;
  }
  const k = edge === 2 ? K_HEDGE : K_WALL, h = edge === 2 ? 1.05 + rnd() * 0.35 : 0.85, t = edge === 2 ? 0.95 : 0.6, ca = edge === 3 ? P_STONE : 0;
  if (rnd() < (edge === 2 ? 0.3 : 0.6)) put(k, s, sgn * front, 0, sx + 2, h * 0.8, t, 0, c0, c1, ca, ca, 4 << 5, 4.8);
  if (rnd() < 0.8) put(k, s, sgn * back, 0, sx + 2, h, t, 0, c0, c1, ca, ca, 4 << 5, 4.8);
  for (let x = -sx / 2 - 0.9; x < sx; x += sx + 1.8) put(k, s + x, sgn * d, Math.PI / 2, sz + 1.8, h, t, 0, c0, c1, ca, ca, 4 << 5, 4.8);
}

function people(s, lat, n, c0, c1) {
  for (let q = 0; q < n; q++) put(K_PERSON, s + (rnd() - 0.5) * 8, lat + (rnd() - 0.5) * 6, rnd() * 6.28, 1, 1, 1, 0, c0, c1, pick(CLOTH), 0, 0, 5);
}

// Countryside of era e on [s0, s1].
function country(e, s0, s1, r, c0, c1) {
  if (r === 1) return;
  for (let si = 0; si < 2; si++) {
    const side = si ? -1 : 1;
    let s = s0 + rnd() * 20;
    while (s < s1 - 20) {
      const u = rnd();
      if (e === 1) { // a lone hut and a fenced plot now and then
        if (u < 0.5) {
          style(r, 1, 0); house(s, side * (13 + rnd() * 8), (rnd() - 0.5), c0, c1, rnd() < 0.6);
          if (rnd() < 0.6) { style(r, 1, 0); house(s + 9 + rnd() * 4, side * (17 + rnd() * 6), rnd() * 6, c0, c1, false); }
          field(s + 22, side * 15, 10, 7, CROPS[4], true, c0, c1, r === 2 ? 0 : 1);
          if (rnd() < 0.5) people(s + 5, side * 10, 1, c0, c1);
        } else if (u < 0.7 && r !== 2) {
          for (let q = 0; q < 4; q++) put(K_FENCE, s + PEN[q * 3], side * 14 + PEN[q * 3 + 1], PEN[q * 3 + 2], 1, 1, 1, 0, c0, c1, 0, 0, 0, 5);
          for (let q = 0; q < 3; q++) put(K_ANIMAL, s + (rnd() - 0.5) * 3, side * 14 + (rnd() - 0.5) * 3, rnd() * 6.28, 0.55 + rnd() * 0.25, 1, 1, 0, c0, c1, pick(FUR), 0, 0, 5);
        }
        s += 60 + rnd() * 80; continue;
      }
      if (r === 2 && e < 6) { s += 200; continue; } // the desert stays desert beyond the villages
      const big = e === 6 ? 1.8 : e >= 4 ? 1.3 : 1;
      const sx = (22 + rnd() * 30) * big, sz = (18 + rnd() * 22) * (e === 6 ? 1.4 : 1), lat = side * (7.5 + sz / 2);
      if (u < (r === 5 ? 0.3 : 0.75)) {
        if (e === 3 && r !== 0) { // strip fields, long side away from the road
          const n = 3 + Math.floor(rnd() * 4);
          for (let q = 0; q < n; q++) field(s + q * 7.4, side * (7.5 + 25), 6.6, 50, pick(CROPS), false, c0, c1, 0);
          if (rnd() < 0.5) put(K_HAY, s + rnd() * n * 7, side * (14 + rnd() * 30), 0, 0.9 + rnd() * 0.3, 1, 1, 0, c0, c1, 0, P_THATCH, 0, 5);
          s += n * 7.4 + 6; continue;
        }
        const edge = e === 2 && (r === 3 || r === 5 || r === 6) ? 3 : (e === 4 || e === 5) && r !== 0 && r !== 4 ? 2 : 0;
        field(s + sx / 2, lat, sx, sz, pick(CROPS), rnd() < 0.5, c0, c1, edge);
        if (e <= 4 && rnd() < 0.3) for (let q = 0; q < 2 + rnd() * 4; q++) put(K_ANIMAL, s + rnd() * sx, side * (8.5 + rnd() * sz), rnd() * 6.28, 0.6 + rnd() * 0.45, 1, 1, 0, c0, c1, pick(FUR), 0, 0, 5);
        if ((e === 3 || e === 4) && rnd() < 0.3) put(K_HAY, s + sx * rnd(), lat, 0, 0.9 + rnd() * 0.3, 1, 1, 0, c0, c1, 0, P_THATCH, 0, 5);
        s += sx + 4 + rnd() * 10;
      } else if (u < 0.88 && e >= 2) { // a farmstead: house and barn
        style(r, e, 0);
        const hz = side * (14 + H[8] / 2 + rnd() * 10);
        const hi = house(s + H[6] / 2, hz, (rnd() - 0.5) * 0.3, c0, c1, e <= 3 && rnd() < 0.5);
        if (e === 5 && H[0] === K_GABLE && rnd() < 0.7) attach(hi, K_STACK, H[6] * 0.35, 0, H[7] + H[5] * H[8] * 0.5 - 0.5, 1, (WS_BRICK << 5) | (rnd() < 0.5 ? B_SMOKE : 0), P_BRICK);
        if (e === 6 && rnd() < 0.6) put(K_CAR, s + H[6] + 4, hz - side * 1, Math.PI / 2 * (rnd() < 0.5 ? 1 : -1), 1, 1, 1, 0, c0, c1, 0, pick(CARS), 0, 5);
        put(K_GABLE, s + H[6] + 14, side * (18 + 6 + rnd() * 8), (rnd() - 0.5) * 0.2, 12 + rnd() * 6, 4 + rnd(), 8, 0.8, c0, c1, e >= 5 ? P_PLANKR : P_PLANK, e >= 5 ? P_TIN : P_THATCHD, (WS_PLANK << 5) | ((e >= 5 ? RS_TIN : RS_THATCH) << 8), 6.2);
        if ((e === 3 || e === 4) && (r === 3 || r === 4 || r === 6) && rnd() < 0.5) put(K_MILL, s + 40, side * (40 + rnd() * 30), rnd() * 6.28, 0.85 + rnd() * 0.25, 1, 1, 0, c0, e === 4 ? 255 : c1, P_WHITE, P_THATCHD, (WS_PLASTER << 5) | (RS_THATCH << 8), 6);
        s += 70 + rnd() * 40;
      } else s += 40 + rnd() * 60;
      if (e === 3 || e === 4 || e === 5) if (rnd() < 0.08) { // a cart or coach waiting on the verge
        const ch = e >= 4 && rnd() < 0.5;
        put(ch ? K_COACH : K_CART, s, side * 7.2, (rnd() < 0.5 ? 0.5 : -0.5) * Math.PI, 1, 1, 1, 0, c0, c1, 0, ch ? pick([P_PLANKR, C(0.08, 0.1, 0.16), C(0.12, 0.12, 0.1)]) : P_PLANK, 0, 5.2);
      }
    }
  }
}

// A settlement of era e on [s0, s1], weight w (0.3 hamlet .. 1 town / city).
function settlement(e, s0, s1, w, sides, r, c0, c1) {
  if (r === 1 && e < 6) { if (e === 1 && rnd() < 0.4) { style(4, 1, 0); house((s0 + s1) / 2, 24, 0, c0, c1, true); } return; }
  const mid = (s0 + s1) / 2, len = s1 - s0;
  if (e === 1) { // hamlets: huts round a yard, a pen with animals, fenced plots, smoke
    const nh = 1 + Math.floor(w * 2.2);
    for (let q = 0; q < nh; q++) {
      const side = (sides & 1) && (!(sides & 2) || rnd() < 0.5) ? 1 : -1, sc = s0 + (q + 0.5) * len / nh, lc = side * (18 + rnd() * 10);
      const n = 3 + Math.floor(rnd() * 3 + w * 3);
      for (let i = 0; i < n; i++) {
        style(r, 1, w);
        const a = (i / n) * 6.28 + rnd() * 0.5, rr = 8 + rnd() * 5;
        house(sc + Math.cos(a) * rr, lc + Math.sin(a) * rr * 0.8, rnd() * 6.28, c0, c1, rnd() < 0.5);
      }
      if (r !== 2) { // pen
        const ps = sc + (rnd() < 0.5 ? -1 : 1) * 22, pl = lc + side * 4;
        for (let q = 0; q < 4; q++) put(K_FENCE, ps + PEN[q * 3], pl + PEN[q * 3 + 1], PEN[q * 3 + 2], 1, 1, 1, 0, c0, c1, 0, 0, 0, 5);
        for (let i = 0; i < 3; i++) put(K_ANIMAL, ps + (rnd() - 0.5) * 3, pl + (rnd() - 0.5) * 3, rnd() * 6.28, 0.55 + rnd() * 0.2, 1, 1, 0, c0, c1, pick(FUR), 0, 0, 5);
      }
      field(sc + (rnd() < 0.5 ? -1 : 1) * 30, side * (14 + 5), 10 + rnd() * 4, 7 + rnd() * 3, CROPS[4], true, c0, c1, r === 2 ? 0 : 1);
      people(sc, lc - side * 9, 1 + Math.floor(rnd() * 2), c0, c1);
    }
    return;
  }
  if (e === 6 && w > 0.75 && r !== 1) { city(s0, s1, w, sides, r, c0, c1); return; }
  const street = e >= 4 && w > 0.55; // a continuous street front
  let civic = false;
  for (let si = 0; si < 2; si++) {
    const side = si ? -1 : 1;
    if (!(sides & (side > 0 ? 1 : 2))) continue;
    let s = s0 + rnd() * 10;
    while (s < s1 - 6) {
      style(r, e, w);
      const organic = e <= 3 && !street;
      const gap = e === 6 ? 7 + rnd() * 9 : street ? rnd() * 1.5 : (3 + rnd() * 10) * (1.3 - w);
      const set = e === 6 ? 13 + rnd() * 5 : street ? 6.6 + rnd() * (r === 2 || r === 0 ? 4 : 0.6) : 8 + rnd() * 6 + (organic ? rnd() * 10 : 0);
      if (s + H[6] > s1) break;
      const lat = side * (set + H[8] / 2), sm = s + H[6] / 2;
      const hi = house(sm, lat, organic ? (rnd() - 0.5) * 0.5 : 0, c0, c1, e <= 3 && rnd() < 0.35);
      const roofY = H[7] + H[5] * H[8] * 0.5;
      if ((e === 5 && H[0] === K_GABLE) || (e === 4 && H[0] === K_GABLE && rnd() < 0.5) || (e === 6 && H[0] === K_HIP && rnd() < 0.4)) {
        const n = Math.max(1, Math.floor(H[6] / 6.5));
        for (let q = 0; q < n; q++) attach(hi, K_STACK, -H[6] / 2 + (q + 0.5) * H[6] / n, 0, roofY - 0.45, 1, (WS_BRICK << 5) | (e === 5 && rnd() < 0.45 ? B_SMOKE : 0), e === 6 ? P_BRICKD : P_BRICK);
      }
      if (e === 6 && rnd() < 0.55) put(K_CAR, sm + H[6] / 2 + 3.5, side * (set + 3), Math.PI / 2, 1, 1, 1, 0, c0, c1, 0, pick(CARS), 0, 5);
      // back rows in towns
      if ((street && w > 0.72) || (e <= 3 && w > 0.6 && rnd() < 0.6) || (e === 6 && rnd() < 0.5)) {
        style(r, e, w * 0.7);
        house(sm + (rnd() - 0.5) * 4, side * (set + 20 + H[8] / 2 + rnd() * 6), organic ? (rnd() - 0.5) * 0.6 : 0, c0, c1, e <= 3 && rnd() < 0.3);
      }
      if (e <= 4 && rnd() < 0.12) people(sm, side * (set - 2), 1, c0, c1);
      if (e >= 3 && e <= 5 && rnd() < 0.07) put(rnd() < 0.5 && e >= 4 ? K_COACH : K_CART, sm, side * (set - 2.5), (rnd() < 0.5 ? 0.5 : -0.5) * Math.PI, 1, 1, 1, 0, c0, c1, 0, P_PLANK, 0, 5.2);
      s += H[6] + gap;
    }
    // the church, chapel, mill or factory of this settlement (one side)
    if (!civic && w > 0.35) {
      civic = true;
      const cs = mid + (rnd() - 0.5) * len * 0.4;
      if (e === 3 && r !== 0 && r !== 2) put(K_CHAPEL, cs, side * (34 + rnd() * 10), 0, 0.9 + rnd() * 0.2, 1, 1, 0, c0, rnd() < 0.6 ? 1e5 : c1, r === 6 ? P_STONEW : P_STONE, P_SLATE, (WS_STONE << 5) | (RS_SLATE << 8) | B_WIN | B_DOOR | (L_CANDLE << 11), 6.2);
      if (e === 4 && w > 0.5 && r !== 0 && r !== 2) put(K_CHURCH, cs, side * (42 + rnd() * 10), 0, 0.95 + rnd() * 0.15, 1, 1, 0, c0, 1e5, r === 6 ? P_STONEW : P_STONE, rnd() < 0.5 ? P_SLATE : C(0.25, 0.42, 0.36), (WS_STONE << 5) | (RS_SLATE << 8) | B_WIN | B_DOOR | (L_CANDLE << 11), 6.2);
      if ((e === 3 || e === 4) && (r === 3 || r === 4 || r === 6) && rnd() < 0.55) put(K_MILL, mid + len * 0.45, -side * (38 + rnd() * 20), rnd() * 6.28, 0.9 + rnd() * 0.2, 1, 1, 0, c0, rnd() < 0.5 ? 255 : c1, r === 6 ? P_WHITE : P_PLANK, P_THATCHD, ((r === 6 ? WS_PLASTER : WS_PLANK) << 5) | (RS_SHINGLE << 8), 6);
      if (e === 5 && w > 0.55 && r !== 1) {
        const fs = mid + (rnd() - 0.5) * len * 0.3, fl = side * (46 + rnd() * 10);
        put(K_GABLE, fs, fl, 0, 34 + rnd() * 16, 7.5, 18, 0.45, c0, c1, P_BRICKD, P_SLATE, (WS_BRICK << 5) | (RS_SLATE << 8) | B_WIN | (L_GAS << 11), 6.2);
        put(K_FACTORY, fs + 24, fl + side * 6, 0, 0.85 + rnd() * 0.3, 1, 1, 0, c0, 1e5, P_BRICK, 0, (WS_BRICK << 5) | B_SMOKE, 6.2);
      }
    }
    // fields behind the village
    if (e >= 2 && r !== 1 && w < 0.8) {
      const fz = side * (40 + rnd() * 10);
      if (e === 3 && r !== 0 && r !== 2) for (let q = 0; q < 4; q++) field(s0 + 10 + q * 7.2, side * 60, 6.4, 36, pick(CROPS), false, c0, c1, 0);
      else if (r === 2) field(mid, fz, 26, 14, CROPS[4], true, c0, c1, 0);
      else field(s0 + 20, fz + side * 10, 30, 22, pick(CROPS), rnd() < 0.5, c0, c1, e === 4 || e === 5 ? 2 : e === 2 ? 3 : 0);
    }
  }
}

// Modern city blocks: a street front of tall blocks, a taller row behind.
function city(s0, s1, w, sides, r, c0, c1) {
  for (let si = 0; si < 2; si++) {
    const side = si ? -1 : 1;
    if (!(sides & (side > 0 ? 1 : 2))) continue;
    let s = s0 + rnd() * 6;
    while (s < s1 - 10) {
      const sx = 16 + rnd() * 18, sz = 14 + rnd() * 10, tall = 10 + rnd() * 30 * w;
      if (s + sx > s1) break;
      const glass = rnd() < 0.3;
      const ws = glass ? WS_GLASS : rnd() < 0.5 ? WS_CONC : WS_BRICK, ca = glass ? P_GLASSB : ws === WS_BRICK ? P_BRICKD : pick([P_CONC, PASTEL[4], PASTEL[5], P_CREAM]);
      put(K_FLAT, s + sx / 2, side * (9.5 + sz / 2), 0, sx, tall, sz, 1.1 / sz, c0, c1, ca, P_TAR, (ws << 5) | (RS_FLAT << 8) | B_WIN | B_DOOR | (L_ELEC << 11), 6.2);
      if (rnd() < 0.8) {
        const bx = 18 + rnd() * 16, bz = 16 + rnd() * 10;
        put(K_FLAT, s + bx / 2 + (rnd() - 0.5) * 6, side * (9.5 + sz + 14 + bz / 2), 0, bx, tall * (1 + rnd() * 1.4), bz, 1.1 / bz, c0, c1, rnd() < 0.4 ? P_GLASSB : pick([P_CONC, PASTEL[4], P_BRICKD]), P_TAR, ((rnd() < 0.4 ? WS_GLASS : WS_CONC) << 5) | (RS_FLAT << 8) | B_WIN | (L_ELEC << 11), 6.2);
      }
      s += sx + 6 + rnd() * 6;
    }
  }
}

// Lamps along a settlement zone (gas in era 5 towns, electric in era 6).
function lamps(e, s0, s1, w, c0, c1) {
  if (e === 5 && w > 0.4) for (let s = s0 + 8, q = 0; s < s1; s += 26, q++) put(K_GASLAMP, s, (q & 1 ? 1 : -1) * 5.6, 0, 1, 1, 1, 0, c0, c1, 0, 0, (L_GAS << 11), 4.6);
  if (e === 6) for (let s = s0 + 6; s < s1; s += 34) for (let side = 1; side >= -1; side -= 2) put(K_LAMP, s + (side > 0 ? 0 : 17), side * 6.4, 0, 1, 1, 1, 0, c0, c1, 0, 0, (L_ELEC << 11), 4.2);
}

// Pole lines along the whole edge: telegraph (era 5 on), power (era 6, other side).
function poles(L, side, step, c0, h, lat) {
  for (let s = 30; s < L - 30; s += step) {
    const s2 = s + step < L - 30 ? s + step : -1;
    FA[4] = s; FA[5] = side * lat; frameAt(gE, FA);
    const x = FA[0], z = FA[2];
    let span = 0, yaw = FA[3] - Math.PI / 2;
    if (s2 > 0) { FA[4] = s2; FA[5] = side * lat; frameAt(gE, FA); const dx = FA[0] - x, dz = FA[2] - z; span = Math.hypot(dx, dz); yaw = Math.atan2(-dx, dz); }
    const i = put(K_POLE, s, side * lat, 0, 1, h + rnd() * 0.6, 1, span, c0, 1e5, 0, 0, 0, 4.6);
    if (i >= 0) lotF[i * 16 + 2] = yaw;
  }
}

function fr(z) { const v = Math.sin(z * 12.9898 + gE * 78.233) * 43758.5453; return v - Math.floor(v); }
// The region of the ground at s along the road: a seam road's parent's before its split (graph.js).
function regionAt(s) { return edgeSeam[gE] && s < edgeSplit[gE] ? edgeParentRegion[gE] : edgeRegion[gE]; }

function genEdge(e) {
  gE = e; gBase = e * LPE;
  for (let i = 0; i < LPE; i++) lotU[(gBase + i) * 16 + 15] = K_NONE;
  dirty[e] = 1;
  const L = Math.min(edgeLen[e], edgeDrawEnd[e]);
  rs = (Math.imul(nodeKey[edgeFrom[e]] + 1, 0x9e3779b1) ^ Math.imul(edgeExit[e] + 7, 0x85ebca6b)) >>> 0;
  rnd(); rnd();
  // zones
  let nz = 0, s = 25 + rnd() * 40;
  while (s < L - 60 && nz < 64) {
    const len = Math.min(170 + rnd() * 230, L - 40 - s);
    const u = rnd();
    ZN[nz * 4] = s; ZN[nz * 4 + 1] = s + len; ZN[nz * 4 + 2] = u < 0.45 ? 0 : 0.3 + 0.7 * rnd(); ZN[nz * 4 + 3] = regionAt(s);
    nz++; s += len + 8;
  }
  const side = rnd() < 0.5 ? 1 : -1;
  gN = 0;
  for (let era = 1; era <= 6; era++) {
    gCap = Math.min(LPE, gN + QUOTA[era]);
    const c0 = ERA_C0[era], c1 = ERA_C1[era];
    if (era === 5) poles(L, side, 46, 210, 7.3, 7.6);
    if (era === 6) poles(L, -side, 62, 255, 9.6, 8.6);
    for (let z = 0; z < nz; z++) {
      const z0 = ZN[z * 4], z1 = ZN[z * 4 + 1], r = ZN[z * 4 + 3];
      let w = ZN[z * 4 + 2];
      rs = (Math.imul(nodeKey[edgeFrom[e]] + 31 * z + 1, 0x9e3779b1) ^ Math.imul(era * 977 + edgeExit[e], 0x85ebca6b)) >>> 0;
      let sides = rnd() < 0.55 ? 3 : rnd() < 0.5 ? 1 : 2;
      // The ending: the last stretch (from clock 280) is a quiet residential street on both
      // sides, never a city block and never open country.
      if (era === 6 && clockBase[0] + (edgeJ0[e] + z1 - clockBase[1]) / 40 >= 280) { w = 0.45 + 0.25 * fr(z); sides = 3; }
      if (w > 0) { settlement(era, z0, z1, w, sides, r, c0, c1); lamps(era, z0, z1, w, c0, c1); }
      else {
        country(era, z0, z1, r, c0, c1);
        if (era === 6) for (let q = z0 + 5; q < z1; q += 25) for (let sd = 1; sd >= -1; sd -= 2) put(K_POST, q, sd * 5.0, 0, 1, 1, 1, 0, 272, 1e5, 0, 0, 0, 4.4);
      }
    }
  }
  genCount[e] = gN;
}
function freeEdge(e) {
  for (let i = 0; i < LPE; i++) lotU[(e * LPE + i) * 16 + 15] = K_NONE;
  dirty[e] = 1; genCount[e] = 0;
}

// ------------------------------------------------------------------------------- WGSL
const LOT_WGSL = /* wgsl */ `
struct Lot { a: vec4f, b: vec4f, c: vec4f, d: vec4f };
struct SU { s0: vec4f, s1: vec4f, s2: vec4f };
const NK: u32 = ${NK}u;
const UNIT: u32 = ${UNIT}u;
const KTOP = array<f32, ${NK}>(${KTOP.map((v) => v.toFixed(2)).join(', ')});
const KFX = array<f32, ${NK}>(${KFX.map((v) => v.toFixed(2)).join(', ')});
const KFZ = array<f32, ${NK}>(${KFZ.map((v) => v.toFixed(2)).join(', ')});
fn isUnit(k: u32) -> bool { return ((UNIT >> k) & 1u) != 0u; }
`;

const CULL_WGSL = FRAME_STRUCT + WORLD_WGSL + LOT_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(2) @binding(0) var<storage, read> lots: array<Lot>;
@group(2) @binding(1) var<storage, read_write> cache: array<vec4f>;
@group(2) @binding(2) var<storage, read_write> built: array<f32>;
@group(2) @binding(3) var<storage, read_write> outL: array<vec4u>;
@group(2) @binding(4) var<storage, read_write> args: array<atomic<u32>>;
@group(2) @binding(5) var<uniform> S: SU;
const LPE: u32 = ${LPE}u;
const BASE = array<u32, ${NL}>(BASE_LIST);
const CAPS = array<u32, ${NL}>(${CAP.map((v) => v + 'u').join(', ')});
const MAXD = array<f32, ${NK}>(${MAXD.map((v) => v.toFixed(1)).join(', ')});
fn hl(i: u32, k: u32) -> f32 { return f32(hashU(i, k) >> 8u) * (1.0 / 16777216.0); }

// Built amount 0..1 of a lot at the display clocks (S.s0: new clock, old clock, front j).
fn presence(L: Lot, i: u32) -> f32 {
  let nowIn = S.s0.x >= L.c.x && S.s0.x < L.c.y;
  let oldIn = S.s0.y >= L.c.x && S.s0.y < L.c.y;
  if (nowIn == oldIn) { return select(0.0, 1.0, nowIn); }
  let d = S.s0.z - L.a.w - hl(i, 7u) * 110.0;
  if (nowIn) { return smoothstep(30.0, 260.0, d); }
  return 1.0 - smoothstep(-60.0, 120.0, d);
}

// Ground cache for lot i: y, slope along local x, z (fields) or the wire's rise (poles), status
// (1 ok, 2 rejected).
fn probe(L: Lot, k: u32, i: u32) -> vec4f {
  let bad = vec4f(0.0, 0.0, 0.0, 2.0);
  let p = L.a.xy;
  let X = vec2f(cos(L.a.z), sin(L.a.z));
  let Z = vec2f(-X.y, X.x);
  var hx = KFX[k] * L.b.x;
  var hz = KFZ[k] * select(L.b.x, L.b.z, isUnit(k));
  if (k == ${K_POLE}u) { hx = 0.9; hz = 0.2; }
  // road clearance at the centre and the footprint corners (forks built later clear lots)
  var dmin = nearField(p).x;
  dmin = min(dmin, min(nearField(p + X * hx + Z * hz).x, nearField(p + X * hx - Z * hz).x));
  dmin = min(dmin, min(nearField(p - X * hx + Z * hz).x, nearField(p - X * hx - Z * hz).x));
  if (dmin < L.d.z) { return bad; }
  if (straitAt(p) > 0.02) { return bad; }
  // never on a ridge, nor within ~150 m of a passage's mouth (world.js)
  if (ridgeClear(p) > 0.05 || ridgeMap(p) > 0.5) { return bad; }
  let tz = tunAt(p);
  if (tz.w > 0.0 && abs(tz.a) < tz.lh + 150.0 && abs(tz.l) < 150.0) { return bad; }
  // landmarks: never on a pad, a wide berth around it, the far side of the road kept open
  for (var q = 0; q < ${'4'}; q++) {
    let pd = W.pads[q];
    if (pd.z <= 0.0) { continue; }
    let dp = distance(p, pd.xy) - max(hx, hz);
    if (i32(W.pad0.w + 0.5) == q + 1) { // the ending's home: a street of neighbours up to its lot
      if (dp < pd.z + 4.0) { return bad; }
      continue;
    }
    if (dp < pd.z + 45.0) { return bad; }
    if (dp < pd.z + 200.0 && hl(i, 11u) > (dp - pd.z - 45.0) / 155.0) { return bad; }
    let rp = L.d.xy;
    if (dot(p - rp, pd.xy - rp) < 0.0 && distance(rp, pd.xy) < pd.z + 450.0) { return bad; }
  }
  // buildings never stand in a landmark's sight wedge (between the approach road and it)
  if (k <= ${K_FACTORY}u && sightW(p, L.a.w, distance(p, L.d.xy) + max(hx, hz)) > 0.3) { return bad; }
  if ((bitcast<u32>(L.d.w) & ${B_ICE}u) == 0u && biomeW(p).a.y > 0.55) { return bad; }
  // ground at the corners: water, slope
  var h0: f32; var h1: f32; var h2: f32; var h3: f32;
  let small = hx < 1.4 && hz < 1.4;
  let g0 = ground(p + X * hx + Z * hz);
  if (g0.chan > 0.1 || g0.lake > 0.1 || g0.sea > 0.05) { return bad; }
  h0 = g0.h;
  if (small) { h1 = h0; h2 = h0; h3 = h0; } else {
    let g1 = ground(p - X * hx + Z * hz);
    let g2 = ground(p + X * hx - Z * hz);
    let g3 = ground(p - X * hx - Z * hz);
    if (max(max(g1.chan, g2.chan), g3.chan) > 0.1 || max(max(g1.lake, g2.lake), g3.lake) > 0.1 || max(max(g1.sea, g2.sea), g3.sea) > 0.05) { return bad; }
    h1 = g1.h; h2 = g2.h; h3 = g3.h;
  }
  let lo = min(min(h0, h1), min(h2, h3));
  let hi = max(max(h0, h1), max(h2, h3));
  if (W.sea.x > -1000.0 && lo < W.sea.x + 0.8) { return bad; }
  let sx = ((h0 + h2) - (h1 + h3)) / max(4.0 * hx, 0.1);
  let sz = ((h0 + h1) - (h2 + h3)) / max(4.0 * hz, 0.1);
  if (k == ${K_FIELD}u || k == ${K_HEDGE}u || k == ${K_WALL}u) {
    if (abs(sx) > 0.22 || abs(sz) > 0.22) { return bad; }
    return vec4f((h0 + h1 + h2 + h3) * 0.25, sx, sz, 1.0);
  }
  if (hi - lo > 1.2 + 0.07 * max(hx, hz)) { return bad; }
  if (k == ${K_POLE}u) {
    // the wire's rise to the next pole (local +z, span metres away)
    let gn = ground(p + Z * L.b.w);
    return vec4f(lo, gn.h - lo, 0.0, 1.0);
  }
  return vec4f(lo - 0.05, 0.0, 0.0, 1.0);
}

fn inView(c: vec3f, r: f32) -> bool {
  for (var q = 0; q < 6; q++) { let pl = W.planes[q]; if (dot(pl.xyz, c) + pl.w < -r) { return false; } }
  return true;
}

@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&lots)) { return; }
  built[i] = 0.0;
  let L = lots[i];
  let bits = bitcast<u32>(L.d.w);
  let k = bits & 31u;
  if (k >= NK) { return; }
  if (W.edges[i / LPE].x <= 0.01) { return; }
  var b = presence(L, i);
  if (b <= 0.0) { return; }
  let p = L.a.xy;
  let cd = distance(p, W.cam.xz);
  if (cd > MAXD[k]) { return; }
  b *= smoothstep(MAXD[k], MAXD[k] * 0.86, cd); // rises out of the ground at its draw distance, never pops
  var c: vec4f;
  if ((bits & ${B_ATT}u) != 0u) {
    c = cache[u32(L.d.x)];
    c.x += L.d.y;
  } else {
    c = cache[i];
    if (c.w == 0.0 || ((i + u32(S.s1.x)) & 7u) == 0u) { c = probe(L, k, i); cache[i] = c; }
  }
  if (c.w != 1.0) { return; }
  built[i] = b;
  var top = KTOP[k] * L.b.x;
  if (k <= 3u) { top = L.b.y + L.b.w * L.b.z * 0.5; } else if (isUnit(k)) { top = L.b.y; } else if (k == ${K_POLE}u) { top = L.b.y + 0.9; }
  let rad = select(max(KFX[k], KFZ[k]) * L.b.x, 0.5 * max(L.b.x, L.b.z), isUnit(k)) + 0.5 * top + 3.0;
  if ((bits & ${B_SMOKE}u) != 0u && cd < 650.0 && b > 0.5) {
    var ty = c.x + top;
    if (k == ${K_STACK}u) { ty = c.x + 1.75 * L.b.x; }
    if (k == ${K_FACTORY}u) { ty = c.x + 30.8 * L.b.x; }
    let si = atomicAdd(&args[${NK * 5 + 1}u], 1u);
    if (si < CAPS[NK]) { outL[BASE[NK] + si] = vec4u(i, bitcast<u32>(ty), bitcast<u32>(b), 0u); }
  }
  if (!inView(vec3f(p.x, c.x + top * 0.5, p.y), rad + 25.0)) { return; }
  let li = atomicAdd(&args[k * 5u + 1u], 1u);
  if (li >= CAPS[k]) { return; }
  var ex = bitcast<u32>(c.y);
  if (k == ${K_FIELD}u || k == ${K_HEDGE}u || k == ${K_WALL}u) { ex = pack2x16float(c.yz); }
  outL[BASE[k] + li] = vec4u(i, bitcast<u32>(c.x), bitcast<u32>(b), ex);
}
// Counts past a list's capacity are clamped (the draws read only what was written).
@compute @workgroup_size(32) fn clampArgs(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= ${NL}u) { return; }
  let n = atomicLoad(&args[k * 5u + 1u]);
  if (n > CAPS[k]) { atomicStore(&args[k * 5u + 1u], CAPS[k]); }
}
`;

// Shared vertex transform for the main and shadow passes.
const XF_WGSL = LOT_WGSL + /* wgsl */ `
@group(2) @binding(0) var<storage, read> lots: array<Lot>;
@group(2) @binding(1) var<storage, read> list: array<vec4u>;
@group(2) @binding(2) var<uniform> S: SU;
struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) me: vec2f };
struct XF { wp: vec3f, n: vec3f, lp: vec3f, ln: vec3f, lot: u32 };
fn xform(v: VIn, ii: u32) -> XF {
  var o: XF;
  let R = list[ii];
  let L = lots[R.x];
  o.lot = R.x;
  let bits = bitcast<u32>(L.d.w);
  let k = bits & 31u;
  let fl = u32(v.me.y + 0.5);
  let sc = L.b.xyz;
  let pw = L.b.w;
  var q = v.pos;
  var lp: vec3f;
  var ln = v.nrm;
  if (isUnit(k)) {
    lp = q * sc;
    ln = normalize(v.nrm / sc);
    let Hr = pw * sc.z * 0.5;
    if ((fl & ${F_ROOF}u) != 0u) {
      lp.y = sc.y + (q.y - 1.0) * 2.0 * Hr;
      if (abs(v.nrm.y) > 0.1) {
        let h2 = v.nrm.xz;
        let hn = length(h2);
        let hh = select(vec2f(0.0), h2 / max(hn, 1e-4) * pw, hn > 0.01);
        ln = normalize(vec3f(hh.x, 1.0, hh.y)) * sign(v.nrm.y);
      }
    }
    if ((fl & ${F_HIP}u) != 0u && q.y > 1.4) { lp.x = sign(q.x) * max(0.5 * (sc.x - sc.z), 0.05); }
    if ((fl & ${F_OH}u) != 0u) {
      let oh = select(0.35, 0.55, ((bits >> 8u) & 7u) == 0u);
      if (abs(q.x) > 0.49) { lp.x += sign(q.x) * oh; }
      if (abs(q.z) > 0.49) { lp.z += sign(q.z) * oh; lp.y -= oh * pw; }
    }
    if ((fl & ${F_ROH}u) != 0u) { let r = normalize(q.xz + vec2f(1e-6, 0.0)); lp.x += r.x * 0.5; lp.z += r.y * 0.5; lp.y -= 0.5 * pw; }
    if ((fl & ${F_LUMP}u) != 0u) {
      let ax = lp.x + f32(bits >> 22u) * 3.7;
      let nn = tnl(vec2f(ax * 0.6, lp.z * 0.3 + 0.5), 0.0);
      lp.y *= select(0.8 + 0.42 * nn.x, 0.62 + 0.7 * nn.x, k == ${K_HEDGE}u);
      if (k == ${K_HEDGE}u) { lp.z *= 0.85 + 0.3 * nn.y; }
    }
    if (k == ${K_FIELD}u) { let sl = unpack2x16float(R.w); lp.y += sl.x * lp.x + sl.y * lp.z; }
  } else {
    if ((fl & ${F_SAIL}u) != 0u) {
      let a = F.time * 0.8 + f32(bits >> 22u) * 0.1;
      let c = cos(a); let s = sin(a);
      let rel = q.xy - vec2f(0.0, 11.6);
      let rr = vec2f(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
      q = vec3f(rr.x, rr.y + 11.6, q.z);
      ln = vec3f(c * ln.x - s * ln.y, s * ln.x + c * ln.y, ln.z);
    }
    lp = q * sc.x;
    if ((fl & ${F_MY}u) != 0u) { lp = vec3f(q.x, q.y * sc.y, q.z); }
    if ((fl & ${F_TOP}u) != 0u) { lp = vec3f(q.x, sc.y + q.y - 1.0, q.z); }
    if ((fl & ${F_WIRE}u) != 0u) {
      let t = q.z;
      let dy = bitcast<f32>(R.w);
      lp = vec3f(q.x, sc.y + q.y - 1.0 + dy * t - pw * 0.022 * 4.0 * t * (1.0 - t), t * pw);
    }
  }
  // rising / sinking with the era front: everything above the cut is pressed onto it
  let b = bitcast<f32>(R.z);
  if (b < 0.999) {
    var top = KTOP[k] * select(sc.x, sc.y, k == ${K_POLE}u);
    if (k <= 3u) { top = sc.y + pw * sc.z * 0.5; }
    if (isUnit(k) && k > 3u) { top = sc.y; }
    let cut = mix(-1.6, top + 0.6, b);
    if (lp.y > cut) { lp.y = cut - 0.002 * (lp.y - cut); }
  }
  let a = L.a.z;
  let X = vec2f(cos(a), sin(a));
  let Z = vec2f(-X.y, X.x);
  let y0 = bitcast<f32>(R.y);
  o.wp = vec3f(L.a.x + X.x * lp.x + Z.x * lp.z, y0 + lp.y, L.a.y + X.y * lp.x + Z.y * lp.z);
  o.n = vec3f(X.x * ln.x + Z.x * ln.z, ln.y, X.y * ln.x + Z.y * ln.z);
  o.lp = lp;
  o.ln = ln;
  return o;
}
`;

const MAIN_WGSL = MAIN_HEADER + WORLD_WGSL + XF_WGSL + /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) lp: vec3f,
  @location(3) ln: vec3f,
  @location(4) @interpolate(flat) f: vec4u, // material, bits, colour A, colour B
  @location(5) @interpolate(flat) g: vec4f, // lot size x, y, z, lot hash
};
@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let x = xform(v, ii);
  var o: VOut;
  o.pos = F.viewProj * vec4f(x.wp, 1.0);
  o.wp = x.wp; o.n = x.n; o.lp = x.lp; o.ln = x.ln;
  let L = lots[x.lot];
  o.f = vec4u(u32(v.me.x + 0.5), bitcast<u32>(L.d.w), bitcast<u32>(L.c.z), bitcast<u32>(L.c.w));
  o.g = vec4f(L.b.xyz, f32(hashU(x.lot, 3u) >> 8u) * (1.0 / 16777216.0));
  return o;
}
fn unpackC(u: u32) -> vec3f { let c = unpack4x8unorm(u).rgb; return c * c; }
fn h2(a: u32, b: u32) -> f32 { return f32(hashU(a, b) >> 8u) * (1.0 / 16777216.0); }
// Coverage of the band |x - c| < w / 2 (anti-aliased by the footprint f).
fn band(x: f32, w: f32, f: f32) -> f32 { return saturate((w * 0.5 - abs(x)) / max(f, 1e-4) + 0.5); }
// Distance to the nearest grid line of period p (0 on the line).
fn gridD(x: f32, p: f32) -> f32 { let t = fract(x / p); return min(t, 1.0 - t) * p; }

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let fwv = fwidth(i.lp);
  let fw = max(max(fwv.x, fwv.y), fwv.z) + 1e-4;
  let mat = i.f.x;
  let bits = i.f.y;
  let k = bits & 31u;
  let n = normalize(i.n);
  let ln = normalize(i.ln);
  let cA = unpackC(i.f.z);
  let cB = unpackC(i.f.w);
  let seed = i.g.w;
  let sd = u32(seed * 65535.0);
  let tone = 0.9 + 0.2 * fract(seed * 7.31);
  let fine = smoothstep(0.09, 0.025, fw);
  let night = S.s0.w;
  let lp = i.lp;
  let nz = tnl(lp.xz * 0.23 + vec2f(lp.y * 0.31, seed * 29.0), 0.0);
  var alb = vec3f(0.3);
  var em = vec3f(0.0);
  var gloss = 0.0;
  var refl = 0.0;
  var ao = 1.0;
  let wst = (bits >> 5u) & 7u;
  let rst = (bits >> 8u) & 7u;
  let lit = (bits >> 11u) & 3u;
  if (mat == ${M_WALL}u) {
    var c = cA * tone;
    let vert = abs(ln.y) < 0.35;
    let sideX = abs(ln.x) > abs(ln.z);
    let u = select(lp.x, lp.z, sideX);
    let v = lp.y;
    if (wst == ${WS_MUD}u) { c *= 0.82 + 0.3 * nz.x; c *= mix(0.8, 1.0, smoothstep(0.0, 0.7, v)); }
    else if (wst == ${WS_TIMBER}u) {
      let pu = gridD(u + 0.3, 1.5);
      let fv = fract(v / 2.7) * 2.7;
      let beam = max(max(band(pu, 0.2, fw), band(gridD(v, 2.7), 0.22, fw)), band(abs(fract(u / 1.5 + 0.2) - fv / 2.7) * 1.5, 0.16, fw) * step(0.8, fract(floor(u / 1.5 + 0.2) * 0.37 + 0.2)));
      c = mix(c * (0.92 + 0.12 * nz.y), vec3f(0.075, 0.05, 0.035), beam * mix(0.6, 1.0, fine));
    } else if (wst == ${WS_BRICK}u) {
      let row = floor(v / 0.075);
      let bu = (u + row * 0.11) / 0.23;
      let mort = max(band(gridD(v, 0.075), 0.012, fw), band(gridD(u + row * 0.11, 0.23), 0.012, fw));
      c *= 0.86 + 0.24 * h2(u32(i32(floor(bu)) + 4096), u32(i32(row) + 4096) + sd);
      c = mix(c, vec3f(0.3, 0.29, 0.26), mort * 0.7 * fine);
      c = mix(cA * 0.92, c, fine);
    } else if (wst == ${WS_STONE}u) {
      let row = floor(v / 0.42);
      let bu = (u + row * 0.37) / (0.65 + 0.2 * h2(u32(i32(row) + 999), sd));
      let j = max(band(gridD(v, 0.42), 0.035, fw), band(fract(bu) - 0.5 + 0.5 * sign(0.5 - fract(bu)), 0.05, fw * 1.6));
      c *= 0.82 + 0.3 * h2(u32(i32(floor(bu)) + 7000), u32(i32(row) + 7000) + sd) + 0.1 * (nz.x - 0.5);
      c = mix(c, c * 0.55, j * fine);
    } else if (wst == ${WS_PLANK}u) {
      let pl = gridD(u, 0.22);
      c *= (0.85 + 0.25 * h2(u32(i32(floor(u / 0.22)) + 3000), sd)) * (0.92 + 0.1 * nz.z);
      c = mix(c, c * 0.45, band(pl, 0.02, fw) * fine);
    } else if (wst == ${WS_CONC}u) {
      c *= 0.9 + 0.12 * nz.x - 0.12 * smoothstep(0.55, 0.8, nz.w) * smoothstep(4.0, 0.0, v);
      c = mix(c, c * 0.7, max(band(gridD(v, 3.4), 0.04, fw), band(gridD(u, 3.0), 0.04, fw)) * fine);
    } else { c *= 0.9 + 0.16 * tnl(vec2f(u * 0.12, v * 0.2) + seed * 17.0, 0.0).x; }
    // weathering: grime rising from the ground, a darker plinth on rendered walls, a light
    // cornice under a flat roof
    c *= mix(0.8, 1.0, smoothstep(0.0, 2.2, v + 0.6 * nz.y));
    if (wst <= ${WS_TIMBER}u || wst == ${WS_CONC}u) { c = mix(c, c * 0.68, band(v - 0.18, 0.75, fw)); }
    if (k == ${K_FLAT}u) { c = mix(c, c * 1.1, band(v - (i.g.y - 0.25), 0.35, fw)); c = mix(c, c * 0.7, band(v - (i.g.y - 0.48), 0.1, fw) * fine); }
    alb = c;
    // windows and doors on the walls (procedural; lit at random once the light is low)
    if (vert && (bits & ${B_WIN | B_DOOR}u) != 0u) {
      let halfW = select(99.0, select(i.g.x, i.g.z, sideX) * 0.5, isUnit(k));
      var fh = 3.0; var wp = 2.7; var w0 = 1.0; var w1 = 2.15; var ww = 0.85;
      if (wst >= ${WS_CONC}u) { fh = 3.4; wp = 2.3; w0 = 0.8; w1 = 2.5; ww = 1.35; }
      if (wst == ${WS_GLASS}u) { w0 = 0.25; w1 = 3.15; ww = 2.1; }
      if (k == ${K_CHAPEL}u || k == ${K_CHURCH}u) { fh = 99.0; wp = 3.6; w0 = 1.8; w1 = 5.4; ww = 0.9; }
      if (k == ${K_ROUND}u || wst == ${WS_MUD}u || (k == ${K_FLAT}u && lit < 3u)) { wp = 3.4; ww = 0.6; w0 = 1.3; w1 = 1.95; }
      let fl = floor(v / fh);
      let fv = v - fl * fh;
      let cu = u / wp + 0.5;
      let ci = floor(cu);
      let fu = (fract(cu) - 0.5) * wp;
      var arch = 0.0;
      if (k == ${K_CHAPEL}u || k == ${K_CHURCH}u) { arch = max(fv - (w1 - 0.45), 0.0) * 2.0; }
      let inW = band(fu, ww - arch * arch * ww, fw) * band(fv - (w0 + w1) * 0.5, w1 - w0, fw) * step(abs(u), halfW - 0.8) * step(0.0, v);
      let frm = band(fu, ww + 0.16, fw) * band(fv - (w0 + w1) * 0.5, w1 - w0 + 0.16, fw) * step(abs(u), halfW - 0.8) - inW;
      let front = ln.z > 0.7;
      let door = select(0.0, band(u, 1.05, fw) * band(v - 1.05, 2.1, fw), front && (bits & ${B_DOOR}u) != 0u);
      let useW = select(0.0, 1.0, (bits & ${B_WIN}u) != 0u) * (1.0 - door) * step(halfW, 60.0);
      // which windows are lit: more in later eras, a few on at dusk first
      let hw = h2(u32(i32(ci) + 50000) + sd * 7u, u32(i32(fl) + 100) + select(0u, 977u, sideX) + select(0u, 431u, ln.z + ln.x < 0.0));
      let frac = select(select(select(0.0, 0.3, lit == 1u), 0.45, lit == 2u), 0.6, lit == 3u);
      let onK = step(hw, frac * smoothstep(0.0, 0.6 + 0.4 * hw, night));
      let warm = mix(vec3f(1.0, 0.55, 0.22), vec3f(1.0, 0.78, 0.5), h2(u32(i32(ci)), u32(i32(fl)) + sd));
      let lvl = select(select(1.6, 2.6, lit == 2u), 4.0, lit == 3u);
      let glassC = vec3f(0.035, 0.04, 0.048);
      let frameC = select(vec3f(0.55, 0.53, 0.5), vec3f(0.12, 0.08, 0.05), wst <= ${WS_TIMBER}u || wst == ${WS_PLANK}u);
      alb = mix(alb, frameC, saturate(frm) * useW * fine);
      alb = mix(alb, glassC, inW * useW);
      refl = 0.2 * inW * useW * (1.0 - onK);
      em += warm * (lvl * onK * inW * useW);
      alb = mix(alb, select(vec3f(0.09, 0.055, 0.035), cB * 0.6, wst >= ${WS_CONC}u), door);
    }
    // contact darkening at the foot, a soft shade under the eaves
    ao = mix(0.55, 1.0, smoothstep(-0.2, 0.9, lp.y));
    if (isUnit(k)) {
      ao *= mix(1.0, 0.72, smoothstep(i.g.y - 0.7, i.g.y, lp.y) * step(lp.y, i.g.y + 0.01));
      ao *= mix(0.82, 1.0, smoothstep(0.0, 0.7, select(i.g.x, i.g.z, abs(ln.x) > abs(ln.z)) * 0.5 - abs(select(lp.x, lp.z, abs(ln.x) > abs(ln.z)))));
    }
  } else if (mat == ${M_ROOF}u) {
    var c = cB * tone;
    let sl = lp.y;
    if (rst == ${RS_THATCH}u || k == ${K_HAY}u) {
      let st = tnl(vec2f((lp.x + lp.z) * 4.0, sl * 0.35), log2(max(fw * 4.0 * 8.0, 1e-4))).x;
      c = select(c, vec3f(0.46, 0.34, 0.15) * tone, k == ${K_HAY}u);
      c *= (0.58 + 0.62 * st) * (0.85 + 0.3 * nz.y) * mix(0.7, 1.0, smoothstep(i.g.y - 0.2, i.g.y + 1.2, lp.y));
    } else if (rst == ${RS_TILE}u || rst == ${RS_SLATE}u || rst == ${RS_SHINGLE}u) {
      let rh = select(select(0.2, 0.14, rst == ${RS_SLATE}u), 0.17, rst == ${RS_SHINGLE}u);
      let cw = select(select(0.24, 0.3, rst == ${RS_SLATE}u), 0.16, rst == ${RS_SHINGLE}u);
      let row = floor(sl / rh);
      let along = lp.x + lp.z * select(0.0, 1.0, abs(ln.x) > 0.3);
      let col = floor(along / cw + row * 0.5);
      let lap = fract(sl / rh);
      c *= (0.8 + 0.3 * h2(u32(i32(col) + 9000), u32(i32(row) + 9000) + sd)) * mix(1.0, 0.72 + 0.28 * lap, fine);
      c = mix(c, c * 0.6, band(gridD(along + row * 0.5 * cw, cw), 0.02, fw) * fine * 0.6);
      gloss = select(0.0, 0.25, rst == ${RS_SLATE}u);
    } else if (rst == ${RS_TIN}u) {
      c *= 0.85 + 0.2 * (0.5 + 0.5 * sin((lp.x + lp.z) * 41.9)) * fine;
      c = mix(c, vec3f(0.3, 0.15, 0.08), smoothstep(0.55, 0.8, nz.z) * 0.6);
      gloss = 0.3;
    } else if (rst == ${RS_FELT}u) {
      c *= 0.9 + 0.12 * nz.x;
    } else { c *= 0.85 + 0.25 * nz.x; }
    alb = c;
  } else if (mat == ${M_CROP}u) {
    let across = (bits & ${B_ROWS}u) != 0u;
    let r = select(lp.z, lp.x, across);
    let ripe = saturate(0.5 + 0.45 * sin(F.timeFx.z * 0.17453 + seed * 6.28) + (seed - 0.5) * 0.5); // 36 clock s a year (terrain.js seasonK)
    var c = mix(vec3f(0.06, 0.12, 0.03), cA * 0.8, ripe) * (0.72 + 0.4 * nz.x) * (0.85 + 0.25 * tnl(i.wp.xz * 0.06, 0.0).y);
    let furrow = band(gridD(r, 0.7), 0.32, fw);
    c = mix(c, vec3f(0.13, 0.09, 0.055), furrow * 0.6 * fine + 0.22 * (1.0 - fine));
    c *= 0.8 + 0.35 * tnl(i.wp.xz * 2.1, log2(max(fw * 2.1 * 8.0, 1e-4))).z; // plants
    c = mix(c, vec3f(0.12, 0.09, 0.055), band(gridD(r + seed * 7.0, 14.0), 0.45, fw) * 0.6); // tramlines
    c *= mix(1.0, 0.82, band(abs(select(lp.x, lp.z, across)) - select(i.g.x, i.g.z, across) * 0.5, 3.0, fw)); // headland
    if (ln.y < 0.5) { c *= 0.85; }
    alb = c;
  } else if (mat == ${M_LEAF}u) {
    let cl = tnl(vec2f(lp.x * 1.3 + lp.z * 0.7, lp.y * 1.6) + seed * 13.0, 0.0);
    alb = vec3f(0.04, 0.08, 0.028) * (0.55 + 0.75 * cl.x) * tone * mix(vec3f(1.0), vec3f(1.25, 1.1, 0.7), smoothstep(0.6, 0.85, cl.y));
    ao = mix(0.5, 1.0, smoothstep(0.0, 1.0, lp.y)) * (0.75 + 0.35 * cl.z);
  }
  else if (mat == ${M_TIMBER}u) { alb = vec3f(0.11, 0.075, 0.05) * (0.8 + 0.4 * nz.z); }
  else if (mat == ${M_STONE}u) { alb = vec3f(0.36, 0.34, 0.3) * (0.85 + 0.3 * nz.x); }
  else if (mat == ${M_METAL}u) { alb = vec3f(0.045, 0.047, 0.05); gloss = 0.35; }
  else if (mat == ${M_PAINT}u) { alb = cB; gloss = select(0.1, 0.6, k == ${K_CAR}u); }
  else if (mat == ${M_WHITE}u) { alb = vec3f(0.6, 0.6, 0.57); }
  else if (mat == ${M_CLOTH}u) { alb = cA * tone; }
  else if (mat == ${M_SKIN}u) { alb = vec3f(0.36, 0.23, 0.15) * tone; }
  else if (mat == ${M_GLASS}u) { alb = vec3f(0.02, 0.025, 0.03); gloss = 1.0; }
  else if (mat == ${M_WIRE}u) { alb = vec3f(0.03); }
  else if (mat == ${M_DOOR}u) { alb = vec3f(0.09, 0.055, 0.035); }
  else if (mat == ${M_LAMP}u) {
    alb = vec3f(0.5, 0.45, 0.35);
    let col = select(vec3f(1.0, 0.72, 0.38), vec3f(1.0, 0.6, 0.26), k == ${K_LAMP}u);
    em = col * (0.25 + 26.0 * night);
  } else if (mat == ${M_REFL}u) { alb = vec3f(0.5, 0.3, 0.05); em = vec3f(1.0, 0.5, 0.08) * (0.15 + 7.0 * night); }

  let ndl = max(dot(n, F.sunDir), 0.0);
  var sh = 1.0;
  if (ndl > 0.0) { sh = shadowAt(i.wp, n); }
  var col = alb * (probeSun() * (ndl * sh / PI) + probeAmb(n) * (ao / PI));
  if (gloss > 0.0) {
    let vd = normalize(F.camPos - i.wp);
    let r = reflect(-vd, n);
    let fr = 0.04 + 0.96 * pow(1.0 - max(dot(n, vd), 0.0), 5.0);
    col += skyRadiance(normalize(vec3f(r.x, max(r.y, 0.02), r.z))) * fr * gloss * 0.6;
    col += probeSun() * (pow(max(dot(r, F.sunDir), 0.0), 120.0) * sh * gloss * 0.4);
  }
  if (refl > 0.0) {
    let vd = normalize(F.camPos - i.wp);
    let r = reflect(-vd, n);
    col += skyRadiance(normalize(vec3f(r.x, max(r.y, 0.05), r.z))) * refl;
  }
  col += em;
  return vec4f(applyFog(col, i.wp), 1.0);
}
`;

const SHADOW_WGSL = SHADOW_HEADER + WORLD_WGSL + XF_WGSL + /* wgsl */ `
@vertex fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  // wires are far thinner than a shadow texel: their shadows would alias into dotted lines
  if ((u32(v.me.y + 0.5) & ${F_WIRE}u) != 0u) { return vec4f(0.0, 0.0, -2.0, 1.0); }
  let x = xform(v, ii);
  return F.lightViewProj * vec4f(x.wp, 1.0);
}
`;

// Chimney and hearth smoke: a few soft camera-facing puffs per source, rising and drifting.
const PUFFS = 7;
const SMOKE_WGSL = MAIN_HEADER + WORLD_WGSL + LOT_WGSL + /* wgsl */ `
@group(2) @binding(0) var<storage, read> lots: array<Lot>;
@group(2) @binding(1) var<storage, read> list: array<vec4u>;
@group(2) @binding(2) var<uniform> S: SU;
struct SO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32, @location(2) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SO {
  var o: SO;
  let R = list[ii];
  let L = lots[R.x];
  let pf = vi / 6u;
  let cs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = cs[vi % 6u];
  let ph = f32(hashU(R.x, 5u) >> 8u) * (1.0 / 16777216.0);
  let big = select(1.0, 2.6, (bitcast<u32>(L.d.w) & 31u) == ${K_FACTORY}u);
  let age = fract(F.time * 0.09 / big + ph + f32(pf) / ${PUFFS}.0);
  let wind = vec3f(0.94, 0.0, 0.34);
  let base = vec3f(L.a.x, bitcast<f32>(R.y), L.a.y);
  let wp = base + vec3f(0.0, 1.0, 0.0) * (age * 9.0 * big) + wind * (age * age * 7.0 * big) + vec3f(sin(f32(pf) * 2.3 + ph * 9.0), 0.0, cos(f32(pf) * 1.7)) * 0.4 * age;
  let size = (0.45 + age * 2.4) * big;
  let toC = normalize(F.camPos - wp);
  let rt = normalize(cross(vec3f(0.0, 1.0, 0.0), toC));
  let up = cross(toC, rt);
  let p = wp + (rt * c.x + up * c.y) * size;
  o.pos = F.viewProj * vec4f(p, 1.0);
  o.uv = c;
  o.a = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.6) * 0.42 * bitcast<f32>(R.z);
  o.wp = p;
  return o;
}
@fragment fn fs(i: SO) -> @location(0) vec4f {
  let r = length(i.uv);
  let a = i.a * smoothstep(1.0, 0.25, r);
  if (a < 0.003) { discard; }
  let c = vec3f(0.62, 0.62, 0.64) * (probeAmb(vec3f(0.0, 1.0, 0.0)) / PI + probeSun() * (max(F.sunDir.y, 0.1) * 0.35 / PI));
  return vec4f(applyFog(c, i.wp) * a, a);
}
`;

// Footprints into world.settleTex (no world binding: it renders into a world texture).
const MASK_WGSL = LOT_WGSL + /* wgsl */ `
@group(0) @binding(0) var<storage, read> lots: array<Lot>;
@group(0) @binding(1) var<storage, read> built: array<f32>;
@group(0) @binding(2) var<uniform> S: SU;
const MASKM = array<f32, ${NK}>(${MASKM.map((v) => v.toFixed(1)).join(', ')});
struct MO { @builtin(position) pos: vec4f, @location(0) v: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MO {
  var o: MO;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  o.v = 0.0;
  let b = built[ii];
  if (b <= 0.0) { return o; }
  let L = lots[ii];
  let k = bitcast<u32>(L.d.w) & 31u;
  if (k >= NK || MASKM[k] < 0.0) { return o; }
  let cs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = cs[vi];
  let hx = KFX[k] * L.b.x + MASKM[k];
  let hz = KFZ[k] * select(L.b.x, L.b.z, isUnit(k)) + MASKM[k];
  let X = vec2f(cos(L.a.z), sin(L.a.z));
  let Z = vec2f(-X.y, X.x);
  let p = L.a.xy + X * (c.x * hx) + Z * (c.y * hz);
  let uv = (p - S.s2.xy) / ${SETTLE_MAP.size}.0 + 0.5;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  o.v = b;
  return o;
}
@fragment fn fs(i: MO) -> @location(0) vec4f { return vec4f(i.v, 0.0, 0.0, 1.0); }
`;

// ------------------------------------------------------------------------------- GPU
let lotBuf, cacheBuf, builtBuf, outBuf, argsBuf, ubuf, vbuf, ibuf;
let cullPipe, clampPipe, mainPipe, shPipe, smokePipe, maskPipe, cullBG0, cullBG2, maskBG;
let ready = false;
const listBGs = [];
const listBase = new Uint32Array(NL);
const argsInit = new Uint32Array(NL * 5);
const su = new Float32Array(12);
const cullPass = { timestampWrites: undefined };
const maskPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }], timestampWrites: undefined };
let frameNo = 0;
const HIDE = typeof location !== 'undefined' && /[?&]hide=[^&]*settle/.test(location.search);

export async function initSettle(seed) {
  const d = gpu.device;
  addPrePass({ pre }); // registered before grass and props: they read this frame's mask
  onEdgeReady(genEdge);
  onTunnelPlanned(genEdge); // the road was straightened and its split moved
  onEdgeFreed(freeEdge);
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e]) genEdge(e); else freeEdge(e);

  const pk = packMeshes(buildMeshes());
  vbuf = d.createBuffer({ size: pk.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(vbuf, 0, pk.vertices);
  ibuf = d.createBuffer({ size: pk.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ibuf, 0, pk.indices);
  let off = 0;
  for (let l = 0; l < NL; l++) {
    listBase[l] = off;
    off += Math.ceil(CAP[l] / 16) * 16;
    if (l < NK) { const r = pk.ranges[l]; argsInit.set([r.indexCount, 0, r.firstIndex, r.baseVertex, 0], l * 5); }
    else argsInit.set([6 * PUFFS, 0, 0, 0, 0], l * 5);
  }
  const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  lotBuf = d.createBuffer({ size: lotF.byteLength, usage: ST });
  cacheBuf = d.createBuffer({ size: NLOT * 16, usage: ST });
  builtBuf = d.createBuffer({ size: NLOT * 4, usage: ST });
  outBuf = d.createBuffer({ size: off * 16, usage: GPUBufferUsage.STORAGE });
  argsBuf = d.createBuffer({ size: NL * 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  ubuf = d.createBuffer({ size: su.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const C = GPUShaderStage.COMPUTE, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, V = GPUShaderStage.VERTEX;
  const S_ = (b, vis, type) => ({ binding: b, visibility: vis, buffer: type ? { type } : {} });
  const bgl0 = d.createBindGroupLayout({ entries: [S_(0, C)] });
  cullBG0 = d.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: gpu.frameBuffer } }] });
  const bglC = d.createBindGroupLayout({ entries: [S_(0, C, 'read-only-storage'), S_(1, C, 'storage'), S_(2, C, 'storage'), S_(3, C, 'storage'), S_(4, C, 'storage'), S_(5, C)] });
  cullBG2 = d.createBindGroup({ layout: bglC, entries: [lotBuf, cacheBuf, builtBuf, outBuf, argsBuf, ubuf].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  const bglD = d.createBindGroupLayout({ entries: [S_(0, VF, 'read-only-storage'), S_(1, VF, 'read-only-storage'), S_(2, VF)] });
  for (let l = 0; l < NL; l++) listBGs.push(d.createBindGroup({ layout: bglD, entries: [{ binding: 0, resource: { buffer: lotBuf } }, { binding: 1, resource: { buffer: outBuf, offset: listBase[l] * 16, size: Math.ceil(CAP[l] / 16) * 256 } }, { binding: 2, resource: { buffer: ubuf } }] }));
  const bglM = d.createBindGroupLayout({ entries: [S_(0, V, 'read-only-storage'), S_(1, V, 'read-only-storage'), S_(2, V)] });
  maskBG = d.createBindGroup({ layout: bglM, entries: [lotBuf, builtBuf, ubuf].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  maskPass.colorAttachments[0].view = world.settleTex.createView();

  const constants = { SEED: seed };
  const cm = d.createShaderModule({ label: 'settle-cull', code: CULL_WGSL.replace('BASE_LIST', Array.from(listBase, (b) => b + 'u').join(', ')) });
  const mm = d.createShaderModule({ label: 'settle', code: MAIN_WGSL });
  const sm = d.createShaderModule({ label: 'settle-sh', code: SHADOW_WGSL });
  const km = d.createShaderModule({ label: 'settle-smoke', code: SMOKE_WGSL });
  const qm = d.createShaderModule({ label: 'settle-mask', code: MASK_WGSL });
  const cl = d.createPipelineLayout({ bindGroupLayouts: [bgl0, world.bgl, bglC] });
  const layouts = [world.bgl, bglD];
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
  [cullPipe, clampPipe, mainPipe, shPipe, smokePipe, maskPipe] = await Promise.all([
    d.createComputePipelineAsync({ label: 'settle-cull', layout: cl, compute: { module: cm, entryPoint: 'cull', constants } }),
    d.createComputePipelineAsync({ label: 'settle-clamp', layout: cl, compute: { module: cm, entryPoint: 'clampArgs', constants } }),
    mainPipeline({ label: 'settle', module: mm, layouts, buffers: VERTEX_LAYOUT, constants }),
    shadowPipeline({ label: 'settle-sh', module: sm, vertex: 'vsShadow', layouts, buffers: VERTEX_LAYOUT, constants }),
    mainPipeline({ label: 'settle-smoke', module: km, layouts, cullMode: 'none', depthWrite: false, blend, constants }),
    d.createRenderPipelineAsync({
      label: 'settle-mask', layout: d.createPipelineLayout({ bindGroupLayouts: [bglM] }),
      vertex: { module: qm, entryPoint: 'vs' },
      fragment: { module: qm, entryPoint: 'fs', targets: [{ format: 'r8unorm', blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' } } }] },
      primitive: { topology: 'triangle-list' },
    }),
  ]);
  ready = true;
  if (!HIDE) addDrawable({
    shadow(p) {
      if (gpu.cascade === 1) return;
      draw(p, shPipe);
    },
    main(p) { draw(p, mainPipe); },
    transparent(p) {
      p.setPipeline(smokePipe); p.setBindGroup(1, world.bg); p.setBindGroup(2, listBGs[NK]);
      p.drawIndirect(argsBuf, NK * 20);
    },
  });
}

function draw(p, pipe) {
  p.setPipeline(pipe); p.setBindGroup(1, world.bg);
  p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32');
  for (let k = 0; k < NK; k++) { p.setBindGroup(2, listBGs[k]); p.drawIndexedIndirect(argsBuf, k * 20); }
}

// Settlement change clocks: the eras, then the highway's posts (272). Each starts a front like
// the road's.
const CH = new Float64Array([40, 80, 120, 165, 210, 255, 272]);
// The ending's rewind (src/ending.js): [0] 1 = use [1] now, [2] old, [3] front instead.
export const settleOverride = new Float64Array(4);
function pre(enc) {
  if (!ready || HIDE) return;
  const q = gpu.device.queue;
  const clock = state.clock;
  let k = 0;
  while (k < CH.length && clock >= CH[k] - FRONT_LEAD) k++;
  let now = clock, old = clock, front = -1e9;
  if (settleOverride[0] > 0) { now = settleOverride[1]; old = settleOverride[2]; front = settleOverride[3]; }
  else if (k > 0) {
    const t0 = CH[k - 1] - FRONT_LEAD;
    front = clockBase[1] + (t0 - clockBase[0]) * 40 + FRONT_SPEED * (clock - t0);
    const carJ = clockBase[1] + (clock - clockBase[0]) * 40;
    now = clock > CH[k - 1] + 0.001 ? clock : CH[k - 1] + 0.001;
    if (front - carJ < FRONT_DONE) old = t0 - 0.01; else old = now;
  }
  let night = (env.sunElevation - 0.05) / 0.25;
  night = night < 0 ? 1 : night > 1 ? 0 : 1 - night * night * (3 - 2 * night);
  su[0] = now; su[1] = old; su[2] = front; su[3] = night;
  su[4] = frameNo++ & 7; su[5] = 0; su[6] = state.time; su[7] = 0;
  su[8] = fieldOrigin[0]; su[9] = fieldOrigin[1];
  q.writeBuffer(ubuf, 0, su);
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!dirty[e]) continue;
    dirty[e] = 0;
    q.writeBuffer(lotBuf, e * LPE * 64, lotF, e * LPE * 16, LPE * 16);
    q.writeBuffer(cacheBuf, e * LPE * 16, zeros);
  }
  q.writeBuffer(argsBuf, 0, argsInit);
  cullPass.timestampWrites = tsw();
  const c = enc.beginComputePass(cullPass);
  c.setPipeline(cullPipe); c.setBindGroup(0, cullBG0); c.setBindGroup(1, world.bg); c.setBindGroup(2, cullBG2);
  c.dispatchWorkgroups(NLOT / 64);
  c.setPipeline(clampPipe);
  c.dispatchWorkgroups(1);
  c.end();
  maskPass.timestampWrites = tsw();
  const m = enc.beginRenderPass(maskPass);
  m.setPipeline(maskPipe); m.setBindGroup(0, maskBG);
  m.draw(6, NLOT);
  m.end();
}

// Dusk over the last minute of the journey (clock 267 on: Trinity is the last event in full
// day). The key sun sinks through keyframes: late-afternoon gold by the Apollo launch (277),
// at the horizon with the lamps and windows lit by 282, then below it: deep dusk with a dark
// blue sky for the megacity and the ending's street (from 289). The exposure lifts as the
// light goes, so the dusk reads as evening, not as an underexposed day. Call after applyEnv().
const DUSK_C = [267, 277, 282, 289], DUSK_E = [0, 0.15, 0.02, -0.035];
const DUSK_I = [1, 0.92, 0.8, 0.7], DUSK_X = [1, 1.15, 2.0, 2.8];
export function applyDusk() {
  const c = state.clock;
  if (!(c > DUSK_C[0])) return;
  let k = 1;
  while (k < 3 && c > DUSK_C[k]) k++;
  let t = (c - DUSK_C[k - 1]) / (DUSK_C[k] - DUSK_C[k - 1]);
  t = t > 1 ? 1 : t * t * (3 - 2 * t);
  const e0 = k === 1 ? env.sunElevation : DUSK_E[k - 1];
  env.sunElevation = e0 + (DUSK_E[k] - e0) * t;
  env.sunIntensity *= DUSK_I[k - 1] + (DUSK_I[k] - DUSK_I[k - 1]) * t;
  env.exposure *= DUSK_X[k - 1] + (DUSK_X[k] - DUSK_X[k - 1]) * t;
  updateSun();
}

// JS mirror of the WGSL sightW (world.js), for the debug occluders below.
function sightJS(x, z, j, d) {
  let w = 0;
  for (let i = 0; i < MAX_PADS; i++) {
    const S = i * 4;
    if (!(siteSight[S + 2] > 0)) continue;
    const a = siteSight[S] - j;
    if (a < -0.4 * siteSight[S + 3] || a > siteSight[S + 2]) continue;
    const dx = x - siteData[S], dz = z - siteData[S + 1];
    if (dx * dx + dz * dz > a * a + siteSight[S + 1] * siteSight[S + 1] + d * d) continue;
    const lim = (siteSight[S + 1] + siteSight[S + 3]) * (1 - Math.max(a, 0) / siteSight[S + 2]);
    let t = (d - (lim - 25)) / 25; t = t < 0 ? 0 : t > 1 ? 1 : t;
    w = Math.max(w, 1 - t * t * (3 - 2 * t));
  }
  return w;
}
if (typeof window !== 'undefined') window.__settle = {
  // Debug (tools/visibility-test.mjs; allocates): boxes of the buildings standing within r of
  // (x, z) at clock c, by the GPU cull's landmark rules (pads, the far side, the sight wedge;
  // not its ground and road checks): [x, z, yaw, half x, half z, top] per box.
  occluders(x, z, r, c) {
    const out = [];
    for (let e = 0; e < MAX_EDGES; e++) {
      if (!edgeAlive[e]) continue;
      for (let q = 0; q < genCount[e]; q++) {
        const i = (e * LPE + q) * 16, bits = lotU[i + 15], k = bits & 31;
        if (k > K_FACTORY || (bits & B_ATT)) continue;
        if (!(c >= lotF[i + 8] && c < lotF[i + 9])) continue;
        const px = lotF[i], pz = lotF[i + 1];
        if ((px - x) * (px - x) + (pz - z) * (pz - z) > r * r) continue;
        const sx = lotF[i + 4], hx = KFX[k] * sx, hz = KFZ[k] * (UNIT >> k & 1 ? lotF[i + 6] : sx);
        let bad = false;
        for (let pI = 0; pI < MAX_PADS && !bad; pI++) {
          const P = pI * 4, pr = siteData[P + 2];
          if (!(pr > 0)) continue;
          const dp = Math.hypot(px - siteData[P], pz - siteData[P + 1]) - Math.max(hx, hz);
          if (dp < pr + 45) bad = true;
          const rx = lotF[i + 12], rz = lotF[i + 13];
          if ((px - rx) * (siteData[P] - rx) + (pz - rz) * (siteData[P + 1] - rz) < 0 && Math.hypot(rx - siteData[P], rz - siteData[P + 1]) < pr + 450) bad = true;
        }
        if (bad) continue;
        if (sightJS(px, pz, lotF[i + 3], Math.hypot(px - lotF[i + 12], pz - lotF[i + 13]) + Math.max(hx, hz)) > 0.3) continue;
        out.push([px, pz, lotF[i + 2], hx, hz, KTOP[k] * lotF[i + 5]]);
      }
    }
    return out;
  },
  stats() {
    const per = new Array(NK + 1).fill(0);
    let n = 0;
    for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e]) { n += genCount[e]; for (let i = 0; i < genCount[e]; i++) per[Math.min(NK, lotU[(e * LPE + i) * 16 + 15] & 31)]++; }
    return { lots: n, perKind: per.join(',') };
  },
};
