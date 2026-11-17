// Gobekli Tepe, c. 9500 BCE: round enclosures of T-shaped limestone pillars set into
// dry-stone walls with a bench, around a pair of taller central pillars, sunk into a low
// limestone rise. Hunter-gatherer monumental work: no metal, no wheel, no pottery, no
// draught animals. Timber levers, sledges, an A-frame, rope and people only.
//
// Layout for the road (x = -42, travel toward -z): the enclosures sit high on a broad
// limestone rise, their floors dug about a metre into its crest so the wall tops and the
// whole upper shafts stand clear above it. Two enclosures (A, B) sit side by side along the
// road, the third (C) higher up between and behind them. Ring pillars are set radially, as
// on the real site: the narrow front edge faces the centre, so from outside each stone
// shows a slim T in profile. Reliefs vary per pillar and are soft raised carving in the
// same limestone tone.
//
// built 0..1 is construction: enclosure A (nearest the approaching car) rises first, then B,
//   then C. Per enclosure: stakes mark it out, it is dug into the rise, ring pillars go up
//   one by one from the far side round to the road side (the next one is tilted on a timber
//   crib under an A-frame, a team outside hauls it upright; the one after lies on a sledge),
//   the walls rise in courses, the central pair goes up last, then the bench. A quarry with
//   an unfinished T-blank lies on the road side of the rise between A and B.
// decay 0..1 is the deliberate backfilling and weathering: rubble and earth fill the
//   enclosures and spill over the walls until only the top of each head shows (0.6), then
//   the whole site becomes a smooth grassy tell with a few weathered stone tips (1).
//
// Primitives written here because kit.js lacks them: prism() (chamfered octagonal prism
// with a two-tone stain), carved low relief (plateQ/stripAbs with dark carved flanks),
// tPillar(), hearth() (warmer flames and sooty stones than kit fire()), person() (hide
// clothing and hair over kit human()).

import { SURF, POSE, FLICKER, MOTION, BY, noise3, fbm3 } from './kit.js';

const TAU = Math.PI * 2;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const hr = (a, b, c) => noise3(a | 0, b | 0, c | 0); // integer lattice: a stable hash in [0, 1)
const wrap = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };

// Enclosures (landmark-local). R: inner wall face radius. fy: floor height. a0: first pillar
// angle. endA: the side built last (the road side, so work crews face the road). rot: facing
// of the central pair (front = (sin rot, cos rot); broad faces along (cos rot, -sin rot)).
const ENC = [
  { cx: -6, cz: 11.5, R: 8.5, n: 12, hMin: 3.6, hMax: 4.0, H: 1.75, hC: 5.6, fy: 1.5, start: 0.0, dur: 0.7, rot: 0.9, a0: 0.12, endA: Math.PI },
  { cx: -5, cz: -11, R: 7.8, n: 11, hMin: 3.5, hMax: 3.9, H: 1.7, hC: 5.5, fy: 1.5, start: 0.35, dur: 0.45, rot: 2.3, a0: 0.3, endA: Math.PI + 0.3 },
  { cx: 12, cz: 1, R: 6.6, n: 10, hMin: 3.4, hMax: 3.8, H: 1.65, hC: 5.3, fy: 2.2, start: 0.6, dur: 0.4, rot: -0.7, a0: 0.05, endA: Math.PI },
];
const MX = 3, MZ = 0, RISE = 2.6; // centre and crest height of the rise
const QX = -21, QZ = 0.5; // quarry

// Ring pillar proportions (local: thickness along x, width along z, front +z = toward the
// centre). The head is ~1.5x the shaft width and as thick as the shaft.
const RW = 0.72, RT = 0.36, RHH = 0.78, RHB = -0.62, RHF = 0.78; // head overhangs both ways: a T from the side
// Central pillars.
const CW = 1.05, CT = 0.42, CHH = 0.98, CHB = -0.88, CHF = 1.1, CPAIR = 1.7;

// ---------------------------------------------------------------------------------
// Scratch (build-time only, preallocated)
const PB = new Float64Array(24), PT = new Float64Array(24);
const PC = new Float64Array(6); // prism two-tone colours: bottom rgb, top rgb
const FR = new Float64Array(12); // face frame: origin, U, V, N
const Q = new Float64Array(64);
const TP = new Float64Array(64); // transformed shape points
const HX = new Float64Array(24);
const ST = new Float64Array(ENC.length * 8); // per enclosure: p, q (dug), fill, dome, rough, wall frac
const AN = new Float64Array(16), RK = new Int32Array(16), HT = new Float64Array(16), YW = new Float64Array(16);
const RC = new Float64Array(3); // relief colour
let S_D = 0, S_FILLW = 0, S_FY = 0; // decay, last mound sample's rubble weight, current floor

// Octagon corners: (sx, sz, cx, cz) -> (sx*hx - cx*c, sz*hz - cz*c)
const OCT = [1, -1, 1, 0, 1, -1, 0, -1, 1, 1, 0, 1, 1, 1, 1, 0, -1, 1, -1, 0, -1, 1, 0, 1, -1, -1, 0, -1, -1, -1, -1, 0];

// Chamfered octagonal prism along local y from y0 to y1: half extents (hx, hz) at the bottom,
// (tx, tz) at the top, chamfer c. Flat-shaded sides; ao graded bottom -> top. two: colour
// bottom/top vertices from PC (a soil stain fading up the stone).
function prism(b, hx, hz, tx, tz, y0, y1, c, aoB, aoT, top, bottom, two) {
  for (let i = 0; i < 8; i++) {
    const sx = OCT[i * 4], sz = OCT[i * 4 + 1], ccx = OCT[i * 4 + 2], ccz = OCT[i * 4 + 3];
    PB[i * 3] = sx * hx - ccx * c; PB[i * 3 + 1] = y0; PB[i * 3 + 2] = sz * hz - ccz * c;
    PT[i * 3] = sx * tx - ccx * c; PT[i * 3 + 1] = y1; PT[i * 3 + 2] = sz * tz - ccz * c;
  }
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) & 7, I = i * 3, J = j * 3;
    const ex = PB[J] - PB[I], ey = 0, ez = PB[J + 2] - PB[I + 2];
    const fx = PT[I] - PB[I], fy = y1 - y0, fz = PT[I + 2] - PB[I + 2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    if (nx * (PB[I] + PB[J]) + nz * (PB[I + 2] + PB[J + 2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    b.ao(aoB); if (two) b.color(PC[0], PC[1], PC[2]);
    const a = b.vertex(PB[I], y0, PB[I + 2], nx, ny, nz), bb = b.vertex(PB[J], y0, PB[J + 2], nx, ny, nz);
    b.ao(aoT); if (two) b.color(PC[3], PC[4], PC[5]);
    const cc = b.vertex(PT[J], y1, PT[J + 2], nx, ny, nz), dd = b.vertex(PT[I], y1, PT[I + 2], nx, ny, nz);
    b.quad(a, bb, cc, dd);
  }
  if (top) {
    b.ao(aoT); if (two) b.color(PC[3], PC[4], PC[5]);
    const t0 = b.nv;
    for (let i = 0; i < 8; i++) b.vertex(PT[i * 3], y1, PT[i * 3 + 2], 0, 1, 0);
    for (let i = 1; i < 7; i++) b.tri(t0, t0 + i, t0 + i + 1);
  }
  if (bottom) {
    b.ao(aoB); if (two) b.color(PC[0], PC[1], PC[2]);
    const t0 = b.nv;
    for (let i = 0; i < 8; i++) b.vertex(PB[i * 3], y0, PB[i * 3 + 2], 0, -1, 0);
    for (let i = 1; i < 7; i++) b.tri(t0, t0 + i, t0 + i + 1);
  }
}

// ---------------------------------------------------------------------------------
// Carved low relief: raised plates on a face whose flanks splay outward and are shaded
// dark, so the figure reads as an outlined carving even in flat light. The face frame maps
// (u, v, w) to local space.
function face(ox, oy, oz, ux, uy, uz, vx, vy, vz, nx, ny, nz) {
  FR[0] = ox; FR[1] = oy; FR[2] = oz; FR[3] = ux; FR[4] = uy; FR[5] = uz;
  FR[6] = vx; FR[7] = vy; FR[8] = vz; FR[9] = nx; FR[10] = ny; FR[11] = nz;
}
function fv(b, u, v, w, nx, ny, nz) {
  return b.vertex(FR[0] + FR[3] * u + FR[6] * v + FR[9] * w, FR[1] + FR[4] * u + FR[7] * v + FR[10] * w,
    FR[2] + FR[5] * u + FR[8] * v + FR[11] * w, nx, ny, nz);
}
// Soft low relief: the figure is the same limestone as the face, its edge a smooth bevel
// whose normals tilt outward, so it reads by shading alone (no dark outline to shimmer).
const SOFT = 1.7; // bevel run / relief depth
function bevelV(b, u, v, ou, ov, depth, top) {
  const Nx = FR[9], Ny = FR[10], Nz = FR[11], sp = depth * SOFT;
  const nx = (FR[3] * ou + FR[6] * ov) * depth + Nx * sp, ny = (FR[4] * ou + FR[7] * ov) * depth + Ny * sp, nz = (FR[5] * ou + FR[8] * ov) * depth + Nz * sp;
  return top ? fv(b, u, v, depth, nx, ny, nz) : fv(b, u + ou * sp, v + ov * sp, -0.012, nx, ny, nz);
}
// raised figures a touch paler than the face, their bevelled edges clearly darker, so the
// carving reads from the road in any light
function reliefTop(b) { b.color(RC[0] * 1.13, RC[1] * 1.11, RC[2] * 1.08).ao(1); }
function reliefFlank(b) { b.color(RC[0] * 0.66, RC[1] * 0.62, RC[2] * 0.58).ao(0.7); }
// Star-shaped polygon of n points in Q (face u, v), raised by depth, with a smooth mitred
// bevel all round.
function plateQ(b, n, depth) {
  let cu = 0, cv = 0;
  for (let i = 0; i < n; i++) { cu += Q[i * 2]; cv += Q[i * 2 + 1]; }
  cu /= n; cv /= n;
  // per-vertex outward direction: the mean of the two adjacent edges' outward normals
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    let ou = 0, ov = 0;
    for (let s = 0; s < 2; s++) {
      const a = s ? i : h, c = s ? j : i;
      const ua = Q[a * 2], va = Q[a * 2 + 1], uc = Q[c * 2], vc = Q[c * 2 + 1];
      let pu = vc - va, pv = -(uc - ua);
      if (pu * ((ua + uc) * 0.5 - cu) + pv * ((va + vc) * 0.5 - cv) < 0) { pu = -pu; pv = -pv; }
      const l = Math.hypot(pu, pv) || 1; ou += pu / l; ov += pv / l;
    }
    const l = Math.hypot(ou, ov) || 1;
    SL[i * 2] = ou / l; SL[i * 2 + 1] = ov / l;
  }
  reliefFlank(b);
  const t0 = b.nv;
  for (let i = 0; i < n; i++) { bevelV(b, Q[i * 2], Q[i * 2 + 1], SL[i * 2], SL[i * 2 + 1], depth, true); bevelV(b, Q[i * 2], Q[i * 2 + 1], SL[i * 2], SL[i * 2 + 1], depth, false); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.quad(t0 + i * 2 + 1, t0 + j * 2 + 1, t0 + j * 2, t0 + i * 2); }
  reliefTop(b);
  const c0 = fv(b, cu, cv, depth, FR[9], FR[10], FR[11]), base = b.nv;
  for (let i = 0; i < n; i++) fv(b, Q[i * 2], Q[i * 2 + 1], depth, FR[9], FR[10], FR[11]);
  for (let i = 0; i < n; i++) b.tri(c0, base + i, base + (i + 1) % n);
}
// Polyline band of m absolute points in P (face u, v), width w0 -> w1: one continuous
// raised strip with bevelled sides and ends (no joints between segments).
function stripAbs(b, P, m, w0, w1, depth) {
  if (m < 2) return;
  for (let i = 0; i < m; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(m - 1, i + 1);
    let tu = P[i1 * 2] - P[i0 * 2], tv = P[i1 * 2 + 1] - P[i0 * 2 + 1];
    const tl = Math.hypot(tu, tv) || 1; tu /= tl; tv /= tl;
    const w = mix(w0, w1, i / (m - 1)) * 0.5;
    SL[i * 6] = P[i * 2] - tv * w; SL[i * 6 + 1] = P[i * 2 + 1] + tu * w; // left
    SL[i * 6 + 2] = P[i * 2] + tv * w; SL[i * 6 + 3] = P[i * 2 + 1] - tu * w; // right
    SL[i * 6 + 4] = tu; SL[i * 6 + 5] = tv;
  }
  reliefFlank(b);
  for (let s = 0; s < 2; s++) { // the two long sides
    const t0 = b.nv, sg = s ? 1 : -1;
    for (let i = 0; i < m; i++) {
      const u = SL[i * 6 + s * 2], v = SL[i * 6 + s * 2 + 1], ou = sg * SL[i * 6 + 5], ov = -sg * SL[i * 6 + 4];
      bevelV(b, u, v, ou, ov, depth, true); bevelV(b, u, v, ou, ov, depth, false);
    }
    for (let i = 0; i < m - 1; i++) b.quad(t0 + i * 2, t0 + i * 2 + 2, t0 + i * 2 + 3, t0 + i * 2 + 1);
  }
  for (let e = 0; e < 2; e++) { // the two ends
    const i = e ? m - 1 : 0, sg = e ? 1 : -1, ou = sg * SL[i * 6 + 4], ov = sg * SL[i * 6 + 5];
    const a = bevelV(b, SL[i * 6], SL[i * 6 + 1], ou, ov, depth, true), c = bevelV(b, SL[i * 6 + 2], SL[i * 6 + 3], ou, ov, depth, true);
    const d = bevelV(b, SL[i * 6 + 2], SL[i * 6 + 3], ou, ov, depth, false), f = bevelV(b, SL[i * 6], SL[i * 6 + 1], ou, ov, depth, false);
    b.quad(a, c, d, f);
  }
  reliefTop(b);
  const t0 = b.nv;
  for (let i = 0; i < m; i++) {
    fv(b, SL[i * 6], SL[i * 6 + 1], depth, FR[9], FR[10], FR[11]);
    fv(b, SL[i * 6 + 2], SL[i * 6 + 3], depth, FR[9], FR[10], FR[11]);
  }
  for (let i = 0; i < m - 1; i++) b.quad(t0 + i * 2, t0 + i * 2 + 2, t0 + i * 2 + 3, t0 + i * 2 + 1);
}
const SL = new Float64Array(6 * 40);
// Shape points pts placed at (ou, ov), scale s, rotation rot, mirrored when mir < 0.
function xform(pts, ou, ov, s, rot, mir) {
  const c = Math.cos(rot), sn = Math.sin(rot), n = pts.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2] * s * mir, y = pts[i * 2 + 1] * s;
    TP[i * 2] = ou + x * c - y * sn; TP[i * 2 + 1] = ov + x * sn + y * c;
  }
  return n;
}
function poly(b, pts, ou, ov, s, rot, mir, depth) {
  const n = xform(pts, ou, ov, s, rot, mir);
  for (let i = 0; i < n * 2; i++) Q[i] = TP[i];
  plateQ(b, n, depth);
}
function band(b, pts, w0, w1, ou, ov, s, rot, mir, depth) {
  const n = xform(pts, ou, ov, s, rot, mir);
  stripAbs(b, TP, n, w0 * s, w1 * s, depth);
}
function ell(cu, cv, ru, rv, rot, n) {
  const out = [], c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, x = Math.cos(a) * ru, y = Math.sin(a) * rv;
    out.push(cu + x * c - y * s, cv + x * s + y * c);
  }
  return out;
}

// Animal shapes in a ~1 m box, facing +u. p: plate, s: strip. Chunky so they read at
// passing distance.
const FOX = [
  { p: ell(0, 0, 0.31, 0.12, -0.12, 10) },
  { p: [0.22, 0.07, 0.29, 0.22, 0.35, 0.1, 0.40, 0.22, 0.44, 0.08, 0.6, 0.0, 0.42, -0.06, 0.27, -0.08] },
  { s: [0.18, -0.05, 0.25, -0.18, 0.30, -0.32], w0: 0.08, w1: 0.055 },
  { s: [0.10, -0.07, 0.12, -0.2, 0.10, -0.33], w0: 0.08, w1: 0.055 },
  { s: [-0.18, -0.05, -0.22, -0.19, -0.18, -0.32], w0: 0.085, w1: 0.055 },
  { s: [-0.25, -0.03, -0.33, -0.15, -0.38, -0.27], w0: 0.085, w1: 0.055 },
  { p: ell(-0.48, -0.07, 0.2, 0.08, 0.45, 9) },
];
const BOAR = [
  { p: ell(0, 0, 0.32, 0.18, 0.05, 12) },
  { p: [0.22, 0.13, 0.30, 0.11, 0.50, -0.06, 0.52, -0.14, 0.40, -0.14, 0.24, -0.11] },
  { p: [0.22, 0.10, 0.21, 0.25, 0.30, 0.11] },
  { s: [0.43, -0.09, 0.42, -0.01, 0.37, 0.03], w0: 0.05, w1: 0.03 },
  { s: [0.18, -0.1, 0.2, -0.3], w0: 0.09, w1: 0.065 },
  { s: [0.08, -0.12, 0.06, -0.3], w0: 0.09, w1: 0.065 },
  { s: [-0.16, -0.1, -0.18, -0.3], w0: 0.09, w1: 0.065 },
  { s: [-0.24, -0.08, -0.27, -0.28], w0: 0.09, w1: 0.065 },
  { s: [-0.22, 0.15, 0.0, 0.2, 0.2, 0.16], w0: 0.07, w1: 0.04 },
  { s: [-0.30, 0.03, -0.37, -0.03, -0.36, -0.12], w0: 0.045, w1: 0.03 },
];
const CRANE = [
  { p: ell(-0.05, 0.05, 0.23, 0.11, 0.3, 10) },
  { s: [0.13, 0.12, 0.2, 0.3, 0.17, 0.46], w0: 0.07, w1: 0.05 },
  { p: ell(0.19, 0.49, 0.065, 0.05, 0, 7) },
  { s: [0.23, 0.49, 0.38, 0.44], w0: 0.04, w1: 0.02 },
  { s: [0.02, -0.03, 0.04, -0.24, 0.02, -0.46], w0: 0.045, w1: 0.035 },
  { s: [-0.06, -0.02, -0.1, -0.24, -0.08, -0.46], w0: 0.045, w1: 0.035 },
  { s: [-0.04, -0.46, 0.1, -0.47], w0: 0.03, w1: 0.03 },
  { p: [-0.22, 0.06, -0.38, -0.05, -0.36, -0.12, -0.2, -0.03] },
];
const SNAKE = (() => {
  const pts = [];
  for (let i = 0; i <= 12; i++) { const v = 0.5 - i * 0.075; pts.push(0.1 * Math.sin(v * 13), v); }
  return [{ s: pts, w0: 0.08, w1: 0.1 }, { p: ell(0.1 * Math.sin(-0.4 * 13), -0.47, 0.07, 0.1, 0, 8) }];
})();
const SCORPION = [
  { p: ell(0, 0, 0.1, 0.18, 0, 10) },
  { s: [0, 0.15, 0.02, 0.27, 0.07, 0.37, 0.13, 0.38, 0.15, 0.31], w0: 0.07, w1: 0.04 },
  { s: [0.05, -0.14, 0.13, -0.24, 0.10, -0.34], w0: 0.055, w1: 0.04 },
  { s: [-0.05, -0.14, -0.13, -0.24, -0.10, -0.34], w0: 0.055, w1: 0.04 },
  { p: ell(0.09, -0.37, 0.06, 0.04, 0.5, 6) },
  { p: ell(-0.09, -0.37, 0.06, 0.04, -0.5, 6) },
  { s: [0.07, -0.05, 0.2, -0.1], w0: 0.035, w1: 0.03 }, { s: [-0.07, -0.05, -0.2, -0.1], w0: 0.035, w1: 0.03 },
  { s: [0.07, 0.03, 0.21, 0.0], w0: 0.035, w1: 0.03 }, { s: [-0.07, 0.03, -0.21, 0.0], w0: 0.035, w1: 0.03 },
  { s: [0.07, 0.10, 0.2, 0.12], w0: 0.035, w1: 0.03 }, { s: [-0.07, 0.10, -0.2, 0.12], w0: 0.035, w1: 0.03 },
];
const HEAD_BEASTS = [FOX, BOAR];
const HEAD_SCALE = [0.72, 0.84];
const SHAFT_BEASTS = [CRANE, SNAKE, SCORPION, FOX];
const SHAFT_SCALE = [0.78, 1.0, 1.0, 0.55];
// Per-pillar motif (set before tPillar kind 1): head beast (-1 none), shaft beast (-1 none),
// which broad side carries them, and a snake down the narrow front edge.
let M_HEAD = -1, M_SHAFT = -1, M_SIDE = 1, M_FRONT = false;
function animal(b, sh, ou, ov, s, rot, mir, depth) {
  for (let i = 0; i < sh.length; i++) {
    const p = sh[i];
    if (p.p) poly(b, p.p, ou, ov, s, rot, mir, depth);
    else band(b, p.s, p.w0, p.w1, ou, ov, s, rot, mir, depth);
  }
}

// ---------------------------------------------------------------------------------
// T-pillar standing on y = 0 (foot sunk to -0.45), front (+z), broad faces +-x.
// kind: 0 plain, 1 ring reliefs, 2 central (arms, hands, belt, loincloth, necklace, pelt).
// rs: which broad face (+1 / -1 local x) faces the road. wear 0..1: rounded, stained.
function tPillar(b, Hs, Hh, W, T, hb, hf, cr, cg, cb, id, kind, rs, wear) {
  b.surface(SURF.STONE).emissive(0, 0);
  // the foot is stained by soil, the top is pale and sun-bleached
  PC[0] = cr * 0.72; PC[1] = cg * 0.66; PC[2] = cb * 0.56; PC[3] = cr; PC[4] = cg; PC[5] = cb;
  const tw = 0.47 + 0.03 * hr(id, 9, 78), ch = 0.035 + 0.12 * wear;
  prism(b, T * 0.53, W * 0.52, T * 0.5, W * tw, -0.45, Hs + 0.02, ch, 0.65, 1, false, false, true);
  b.color(cr, cg, cb);
  b.push(); b.translate(0, Hs + Hh * 0.5, (hb + hf) * 0.5); b.rotateZ(Math.PI / 2);
  prism(b, Hh * 0.5, (hf - hb) * 0.5, Hh * 0.5, (hf - hb) * 0.5, -(T * 0.5 + 0.012), T * 0.5 + 0.012, 0.06 + 0.16 * wear, 1, 1, true, true, false);
  b.pop();
  if (wear > 0.25) {
    // lichen (grey-green and ochre) and dark weathering stains on the head and upper shaft
    const hc0 = (hb + hf) * 0.5, L = (hf - hb) * 0.5;
    const nm = 2 + Math.round(3 * wear);
    for (let sd = -1; sd <= 1; sd += 2) {
      face(sd * (T * 0.5 + 0.012), 0, 0, 0, 0, 1, 0, 1, 0, sd, 0, 0);
      for (let m = 0; m < nm; m++) {
        const lu = hc0 + (hr(id, m + sd * 7, 79) - 0.5) * L * 1.5, lv = Hs + Hh * (0.15 + 0.7 * hr(id, m + sd * 7, 80)) - (m > 4 ? 0.5 : 0);
        const ru = 0.05 + 0.09 * hr(id, m, 81), rv = 0.05 + 0.1 * hr(id, m, 82);
        const t = hr(id, m, 84);
        if (t < 0.45) { RC[0] = cr * 0.8; RC[1] = cg * 0.84; RC[2] = cb * 0.78; } // grey-green lichen
        else if (t < 0.75) { RC[0] = cr * 1.0; RC[1] = cg * 0.9; RC[2] = cb * 0.66; } // ochre lichen
        else { RC[0] = cr * 0.74; RC[1] = cg * 0.72; RC[2] = cb * 0.7; } // weathering stain
        for (let i = 0; i < 7; i++) { const a = i / 7 * TAU; Q[i * 2] = lu + Math.cos(a) * ru * (0.7 + 0.5 * hr(id, m * 8 + i, 83)); Q[i * 2 + 1] = lv + Math.sin(a) * rv * (0.7 + 0.5 * hr(id, m * 8 + i, 85)); }
        plateQ(b, 7, 0.004);
      }
    }
  }
  if (kind === 0) return;
  RC[0] = cr; RC[1] = cg; RC[2] = cb;
  const dep = 0.05 * (1 - 0.45 * wear), hc = (hb + hf) * 0.5;
  if (kind === 1) {
    // motif chosen per pillar by the caller; carved on one broad side, the animal heading
    // toward the enclosure centre
    const sd = M_SIDE;
    if (M_HEAD >= 0) {
      face(sd * (T * 0.5 + 0.012), 0, 0, 0, 0, 1, 0, 1, 0, sd, 0, 0);
      animal(b, HEAD_BEASTS[M_HEAD], hc + 0.05, Hs + Hh * 0.5, HEAD_SCALE[M_HEAD], 0, 1, dep);
    }
    if (M_SHAFT >= 0) {
      face(sd * T * 0.5, 0, 0, 0, 0, 1, 0, 1, 0, sd, 0, 0);
      animal(b, SHAFT_BEASTS[M_SHAFT], 0.02, Hs - 0.75, SHAFT_SCALE[M_SHAFT], M_SHAFT === 3 ? -Math.PI / 2 : 0, 1, dep);
    }
    if (M_FRONT) {
      // a snake writhing down the narrow front edge; the face follows the shaft's taper
      const tw = 0.47 + 0.03 * hr(id, 9, 78), y0 = Hs - 1.05;
      const zB = W * 0.52, zT = W * tw, slope = (zT - zB) / (Hs + 0.47);
      face(0, y0, zB + slope * (y0 + 0.45), 1, 0, 0, 0, 1, slope, 0, 0, 1);
      animal(b, SNAKE, 0, 0, 0.85, 0, 1, dep * 0.8);
    }
    return;
  }
  // Central pillar: a stylised body. Arms down both broad sides bending forward to hands
  // at the front edge, fingers wrapping onto the narrow front where they meet above a belt;
  // a buckle and a hanging loincloth on the front, a fox pelt hanging on each side; a
  // necklace under the head.
  const belt = Hs * 0.42;
  for (let sd = -1; sd <= 1; sd += 2) {
    face(sd * T * 0.5, 0, 0, 0, 0, 1, 0, 1, 0, sd, 0, 0);
    ARM[0] = -W * 0.5 + 0.2; ARM[1] = Hs - 0.4;
    ARM[2] = -W * 0.5 + 0.22; ARM[3] = Hs - 1.0;
    ARM[4] = -W * 0.5 + 0.3; ARM[5] = belt + 0.95;
    ARM[6] = -0.12; ARM[7] = belt + 0.5;
    ARM[8] = W * 0.5 - 0.2; ARM[9] = belt + 0.36;
    stripAbs(b, ARM, 5, 0.2, 0.14, 0.065);
    // hand: palm and fingers reaching to the front edge
    poly(b, PALM, W * 0.5 - 0.17, belt + 0.35, 1, 0, 1, 0.06);
    for (let k = 0; k < 4; k++) {
      FING[0] = W * 0.5 - 0.12; FING[1] = belt + 0.29 + k * 0.04; FING[2] = W * 0.5 - 0.005; FING[3] = belt + 0.28 + k * 0.042;
      stripAbs(b, FING, 2, 0.032, 0.03, 0.035);
    }
    // belt band, stopping short of the edges so the silhouette stays one stone
    BELT[0] = -W * 0.5 + 0.1; BELT[1] = belt; BELT[2] = W * 0.5 - 0.1; BELT[3] = belt;
    stripAbs(b, BELT, 2, 0.17, 0.17, 0.055);
    // a fox pelt hanging head-down from the belt near the front
    animal(b, FOX, W * 0.5 - 0.24, belt - 0.5, 0.6, -Math.PI / 2, 1, 0.04);
  }
  face(0, 0, W * 0.5, 1, 0, 0, 0, 1, 0, 0, 0, 1);
  for (let sd = -1; sd <= 1; sd += 2) {
    for (let k = 0; k < 4; k++) {
      FING[0] = sd * (T * 0.5 - 0.005); FING[1] = belt + 0.28 + k * 0.042; FING[2] = sd * 0.02; FING[3] = belt + 0.3 + k * 0.042;
      stripAbs(b, FING, 2, 0.032, 0.03, 0.03);
    }
  }
  BELT[0] = -T * 0.5 + 0.07; BELT[1] = belt; BELT[2] = T * 0.5 - 0.07; BELT[3] = belt;
  stripAbs(b, BELT, 2, 0.17, 0.17, 0.055);
  poly(b, BUCKLE, 0, belt, 1, 0, 1, 0.07);
  poly(b, LOIN, 0, belt - 0.08, 1, 0, 1, 0.045);
  band(b, NECK, 0.045, 0.045, 0, Hs - 0.3, 1, 0, 1, 0.03);
  poly(b, PENDANT, 0, Hs - 0.5, 1, 0, 1, 0.035);
}
const ARM = new Float64Array(10), FING = new Float64Array(4), BELT = new Float64Array(4);
const PALM = ell(0, 0, 0.075, 0.1, 0, 8);
const LOIN = [-0.12, 0, 0.12, 0, 0.08, -0.85, 0, -0.95, -0.08, -0.85];
const NECK = (() => { const o = []; for (let i = 0; i <= 8; i++) { const t = -1.25 + 2.5 * i / 8; o.push(0.15 * Math.sin(t), -0.15 * Math.cos(t)); } return o; })();
const PENDANT = [0, 0.06, 0.06, 0.0, 0.035, -0.07, -0.035, -0.07, -0.06, 0.0];
const BUCKLE = ell(0, 0, 0.09, 0.075, 0, 8);

// ---------------------------------------------------------------------------------
// The rise: a low limestone hill whose enclosures are dug into it; backfill and the later
// tell grow with decay. Returns height (landmark-local y); sets S_FILLW.
function moundH(x, z) {
  const d = S_D;
  const n = fbm3(x * 0.07, 2.3, z * 0.07, 3) - 0.5;
  // the rise: a broad, gentle limestone hill; irregular footprint, down to 0 inside the disc
  const fp = 0.88 + 0.24 * noise3(x * 0.045, 7.1, z * 0.045);
  const r = Math.hypot(x - MX, z - MZ) * fp;
  let h = RISE * sstep(26, 11, r) + 0.45 * n * sstep(26, 16, r);
  // each enclosure sits on a shoulder of the rise: the hill swells up to just below the
  // wall top round it (always), and once dug it is cut back to that level, lowest on the
  // road side, so the outer face and every pillar stand clear of the hill
  for (let k = 0; k < ENC.length; k++) {
    const q = ST[k * 8 + 1];
    const e = ENC[k], dx = x - e.cx, dk = Math.hypot(dx, z - e.cz), Ro = e.R + 1.3;
    if (dk > Ro + 10) continue;
    const road = sstep(0.1, 0.8, -dx / (dk + 1e-6));
    const lvl = e.fy + 0.8 - 0.3 * road + 0.15 * n;
    const sh = lvl * sstep(Ro + 10, Ro + 1.5, dk);
    if (sh > h) h = sh;
    if (q <= 0) continue;
    const cut = mix(lvl, h, sstep(Ro + 0.3, Ro + 7, dk));
    if (cut < h) h = mix(h, cut, q);
  }
  // the dug floors (the floor disc and the wall cover these)
  for (let k = 0; k < ENC.length; k++) {
    const q = ST[k * 8 + 1];
    if (q <= 0) continue;
    const e = ENC[k], dk = Math.hypot(x - e.cx, z - e.cz), Ro = e.R + 1.3;
    if (dk > Ro + 0.2) continue;
    h = mix(h, mix(e.fy - 0.1, h, sstep(Ro - 0.5, Ro + 0.1, dk)), q);
  }
  // backfill: rubble and earth inside, spilling over the walls and spreading into a tell
  let fw = 0;
  for (let k = 0; k < ENC.length; k++) {
    const q = ST[k * 8 + 1], f = ST[k * 8 + 2];
    if (q <= 0 || f <= 0.01) continue;
    const e = ENC[k], dk = Math.hypot(x - e.cx, z - e.cz);
    const Wd = 2 + 6.5 * sstep(0.3, 1, d);
    if (dk > e.R + 1 + Wd) continue;
    const u = dk / e.R, rough = ST[k * 8 + 4];
    let lvl = e.fy + f + (u < 1 ? ST[k * 8 + 3] * (1 - u * u) : 0);
    lvl += rough * ((noise3(x * 0.8, 3.3, z * 0.8) - 0.5) + 0.6 * (noise3(x * 2.3, 6.1, z * 2.3) - 0.5));
    lvl += 0.25 * n * sstep(0.6, 1, d);
    const fall = sstep(e.R + 1 + Wd, e.R + 0.8, dk);
    const hv = mix(h, lvl, fall);
    if (hv > h) { h = hv; if (f > 0.25) fw = Math.max(fw, fall); }
  }
  S_FILLW = fw;
  // never a step at the disc edge
  h = Math.min(h, Math.max(0, (33 - Math.hypot(x, z)) * 0.7));
  return h - 0.08;
}
const mhL = (x, z) => moundH(x, z) - S_FY; // in the current enclosure's floor frame

// grassiness of the buried tell at height h (shared by colour and tussocks)
function grassAt(x, z, h) {
  const n1 = noise3(x * 0.3, 1.7, z * 0.3), n4 = noise3(x * 0.9, 8.3, z * 0.9);
  return sstep(0.45, 0.95, S_D) * (0.45 + 0.55 * sstep(0.3, 0.62, n1)) * sstep(0.05, 0.9, h + 0.35 * (n4 - 0.5)) * (1 - 0.6 * sstep(0.62, 0.8, n4));
}
function moundColor(b, x, z, h) {
  const n1 = noise3(x * 0.3, 1.7, z * 0.3), n2 = noise3(x * 1.9, 5.1, z * 1.9), n3 = fbm3(x * 0.11, 9.2, z * 0.11, 2);
  // thin reddish soil over pale bedrock that shows through in patches
  const rr = Math.hypot(x - MX, z - MZ);
  const rock = sstep(0.6, 0.75, n1) * sstep(24, 12, rr) * 0.7;
  let r = mix(0.36, 0.45, n3), g = mix(0.27, 0.34, n3), bl = mix(0.18, 0.23, n3);
  r = mix(r, 0.44, rock); g = mix(g, 0.39, rock); bl = mix(bl, 0.3, rock);
  // the skirt fades toward a neutral dusty tan so the rise sits into any ground
  const sk = sstep(0.9, 0.0, h);
  r = mix(r, 0.53, sk * 0.75); g = mix(g, 0.4, sk * 0.75); bl = mix(bl, 0.26, sk * 0.75);
  const k = 0.88 + 0.2 * n2; r *= k; g *= k; bl *= k;
  // backfill: a mottled mix of pale limestone rubble and brown earth
  const fw = S_FILLW;
  if (fw > 0) {
    const n5 = noise3(x * 3.7, 2.9, z * 3.7);
    const stone = sstep(0.35, 0.65, n2 * 0.6 + n5 * 0.4), st = 0.86 + 0.24 * n5;
    const fr = mix(0.34, 0.46, stone) * st, fg = mix(0.27, 0.41, stone) * st, fb = mix(0.19, 0.32, stone) * st;
    r = mix(r, fr, fw); g = mix(g, fg, fw); bl = mix(bl, fb, fw);
  }
  // grass takes the buried tell: dry and green tussock colours, bare soil between
  const gr = grassAt(x, z, h);
  if (gr > 0) {
    const gk = 0.8 + 0.4 * n2, gg = sstep(0.35, 0.7, n3);
    r = mix(r, mix(0.27, 0.17, gg) * gk, gr * 0.85); g = mix(g, mix(0.24, 0.2, gg) * gk, gr * 0.85); bl = mix(bl, mix(0.12, 0.08, gg) * gk, gr * 0.85);
  }
  // sit in the river-desert palette: blend toward the biome's soil / ground
  const bt = BIO_T, bs = BIO_S;
  r = mix(r, bs[0] * (0.8 + 0.4 * n3), bt); g = mix(g, bs[1] * (0.8 + 0.4 * n3), bt); bl = mix(bl, bs[2] * (0.8 + 0.4 * n3), bt);
  b.color(r, g, bl);
}
let BIO_T = 0;
const BIO_S = [0.4, 0.3, 0.2];

// ---------------------------------------------------------------------------------
// Dry-stone fieldstone between angles t0..t1 (radians about the enclosure centre), y0..y1,
// front radius rf (the visible face) and back radius rb. j seeds the shape: the top edge
// dips at each end, the ends lean in and the face bulges, so no two stones are alike.
function stone(b, t0, t1, y0, y1, rf, rb, j) {
  const hgt = y1 - y0, span = t1 - t0;
  for (let top = 0; top < 2; top++) {
    const o = top * 12;
    const ta = top ? t0 + span * 0.14 * hr(j, 10, 401) : t0, tb = top ? t1 - span * 0.14 * hr(j, 11, 401) : t1;
    const ya = top ? y1 - hgt * 0.28 * hr(j, 12, 401) : y0 + 0.025 * hr(j, 8, 401);
    const yb = top ? y1 - hgt * 0.28 * hr(j, 13, 401) : y0 + 0.025 * hr(j, 9, 401);
    const f0 = rf + (hr(j, top * 4, 401) - 0.5) * 0.08, f1 = rf + (hr(j, top * 4 + 1, 401) - 0.5) * 0.08;
    HX[o] = Math.cos(ta) * f0; HX[o + 1] = ya; HX[o + 2] = Math.sin(ta) * f0;
    HX[o + 3] = Math.cos(tb) * f1; HX[o + 4] = yb; HX[o + 5] = Math.sin(tb) * f1;
    HX[o + 6] = Math.cos(tb) * rb; HX[o + 7] = yb; HX[o + 8] = Math.sin(tb) * rb;
    HX[o + 9] = Math.cos(ta) * rb; HX[o + 10] = ya; HX[o + 11] = Math.sin(ta) * rb;
  }
  // only the faces that can show: front, top and the two ends (the back and the bed sit in
  // the mortar core)
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < 8; i++) { cx += HX[i * 3]; cy += HX[i * 3 + 1]; cz += HX[i * 3 + 2]; }
  cx /= 8; cy /= 8; cz /= 8;
  for (let fi = 0; fi < 4; fi++) {
    const A = SF[fi * 4] * 3, B = SF[fi * 4 + 1] * 3, C = SF[fi * 4 + 2] * 3, D = SF[fi * 4 + 3] * 3;
    const ex = HX[C] - HX[A], ey = HX[C + 1] - HX[A + 1], ez = HX[C + 2] - HX[A + 2];
    const fx = HX[D] - HX[B], fy = HX[D + 1] - HX[B + 1], fz = HX[D + 2] - HX[B + 2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    const mx = (HX[A] + HX[B] + HX[C] + HX[D]) * 0.25 - cx, my = (HX[A + 1] + HX[B + 1] + HX[C + 1] + HX[D + 1]) * 0.25 - cy, mz = (HX[A + 2] + HX[B + 2] + HX[C + 2] + HX[D + 2]) * 0.25 - cz;
    const sg = nx * mx + ny * my + nz * mz < 0 ? -1 / l : 1 / l;
    nx *= sg; ny *= sg; nz *= sg;
    const i0 = b.vertex(HX[A], HX[A + 1], HX[A + 2], nx, ny, nz), i1 = b.vertex(HX[B], HX[B + 1], HX[B + 2], nx, ny, nz);
    const i2 = b.vertex(HX[C], HX[C + 1], HX[C + 2], nx, ny, nz), i3 = b.vertex(HX[D], HX[D + 1], HX[D + 2], nx, ny, nz);
    b.quad(i0, i1, i2, i3);
  }
}
const SF = [0, 1, 5, 4, 4, 5, 6, 7, 0, 4, 7, 3, 1, 2, 6, 5];
// warm cream limestone, a shade darker than the pillars, varied stone to stone
function stoneColor(b, j, d, dark) {
  const g = (0.255 + 0.1 * hr(j, 31, 402) + 0.04 * hr(j, 33, 402)) * dark, w = hr(j, 32, 402);
  const k = 1 - 0.12 * d;
  b.color(g * (1.1 + 0.05 * w) * k, g * (0.98 + 0.03 * w) * k, g * (0.78 + 0.05 * w) * k);
}
// mud-and-chip mortar behind the facing: warm earth, not black, so joints read as shadow
function mortar(b) { b.color(0.2, 0.155, 0.11).surface(SURF.EARTH).ao(0.6); }

// Irregular courses of fieldstones between angles tA..tB, heights y0..y1 (from skip up),
// front radius rf, back radius rb. outer: the face looks outward (and is hidden where the
// rise covers it).
function courses(b, e, tA, tB, y0, y1, skip, rf, rb, seed, dark, d, outer) {
  const Rm = rf, sg = outer ? -1 : 1;
  let y = y0, c = 0;
  while (y < y1 - 0.05) {
    const ch = 0.12 + 0.3 * Math.pow(hr(seed, c, 411), 1.3);
    let top = Math.min(y + ch, y1);
    if (y1 - top < 0.07) top = y1;
    if (top >= skip) {
      let pos = tA, jn = 0;
      while (pos < tB - 0.04 / Rm && jn < 400) {
        const j = (seed * 97 + c) * 1024 + jn;
        let L = (0.34 + 0.9 * hr(j, 1, 412) * hr(j, 2, 412) + 0.2 * hr(j, 5, 412)) / Rm;
        if (tB - pos - L < 0.18 / Rm) L = tB - pos;
        const g0 = 0.01 / Rm, tm = pos + L * 0.5;
        if (!outer || mhL(e.cx + Math.cos(tm) * (rf + 0.1), e.cz + Math.sin(tm) * (rf + 0.1)) < top - 0.03) {
          b.ao(outer ? 0.85 : 0.62 + 0.38 * clamp01(y / 1.6));
          const proud = 0.005 + 0.07 * hr(j, 3, 414);
          if (hr(j, 7, 413) < 0.22 && top - y > 0.22) { // two thin slabs stacked
            const ym = y + (top - y) * (0.35 + 0.3 * hr(j, 8, 413));
            stoneColor(b, j, d, dark); stone(b, pos + g0, pos + L - g0, y + 0.008, ym - 0.006, rf - sg * proud, rb, j);
            stoneColor(b, j + 7, d, dark); stone(b, pos + g0 + L * 0.15 * hr(j, 9, 413), pos + L - g0, ym + 0.006, top - 0.008, rf - sg * (0.005 + 0.07 * hr(j, 4, 414)), rb, j + 7);
          } else {
            stoneColor(b, j, d, dark); stone(b, pos + g0, pos + L - g0, y + 0.008, top - 0.008, rf - sg * proud, rb, j);
          }
        }
        pos += L; jn++;
      }
    }
    y = top; c++;
  }
}

// Wall ring (core + facing stones) for enclosure e, up to height wh (enclosure frame).
function wall(b, e, k, wh, bench, fill, d, n) {
  const R = e.R, H = e.H, Ro = R + 1.3;
  let outerMin = 1e9;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    outerMin = Math.min(outerMin, mhL(e.cx + Math.cos(a) * (Ro + 0.2), e.cz + Math.sin(a) * (Ro + 0.2)));
  }
  if (fill > wh + 0.2 && outerMin > wh + 0.2) return;
  const seg = Math.round(R * 9);
  mortar(b);
  const ri = R + 0.04;
  CORE[0] = Ro - 0.03; CORE[1] = -0.1; CORE[2] = Ro - 0.03; CORE[3] = wh - 0.02; CORE[4] = Ro - 0.03; CORE[5] = wh - 0.02;
  CORE[6] = ri; CORE[7] = wh - 0.02; CORE[8] = ri; CORE[9] = wh - 0.02; CORE[10] = ri; CORE[11] = -0.1;
  b.lathe(CORE, seg, NOCAP);
  b.surface(SURF.STONE);
  // inner face between the pillars, butted tight against each shaft
  const skipIn = Math.max(bench ? 0.45 : 0, fill > 0.01 ? fill - 0.15 : 0);
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    const sA = AN[i] + HT[i] / R, sB = AN[i2] + (i2 === 0 ? TAU : 0) - HT[i2] / R;
    if ((sB - sA) * R < 0.12) continue;
    courses(b, e, sA, sB, 0, wh, skipIn, R, R + 0.34, k * 64 + i, 0.84, d, false);
  }
  if (fill > H - 0.3) return;
  // outer face: the courses that stand above the rise, a step darker and weathered so the
  // ring reads against the pale sand and the pale pillars
  courses(b, e, hr(k, 0, 421), hr(k, 0, 421) + TAU, 0, Math.min(wh, H), 0, Ro, Ro - 0.32, k * 64 + 40, 0.66, d, true);
  // cap stones across the wall top: an inner row between the pillars, an outer row all round
  if (wh < H - 0.01 || fill > H + 0.35) return;
  for (let row = 0; row < 2; row++) {
    const r0 = row ? R + 0.62 : R - 0.07, r1 = row ? R + 1.34 : R + 0.66, rm = (r0 + r1) * 0.5;
    const segs = row ? 1 : n;
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % n;
      const sA = row ? hr(k, 1, 432) : AN[i] + (HT[i] + 0.02) / R;
      const sB = row ? sA + TAU : AN[i2] + (i2 === 0 ? TAU : 0) - (HT[i2] + 0.02) / R;
      if (sB <= sA) continue;
      const m = Math.max(1, Math.round((sB - sA) * rm / (0.45 + 0.45 * hr(k * 5 + row, i, 430))));
      for (let jn = 0; jn < m; jn++) {
        const j = ((k * 2 + row) * 32 + i) * 64 + jn + 500000;
        const t0 = sA + (sB - sA) * (jn + (jn ? 0.25 * (hr(j, 21, 433) - 0.5) : 0)) / m;
        const t1 = sA + (sB - sA) * (jn + 1 + (jn < m - 1 ? 0.25 * (hr(j + 1, 21, 433) - 0.5) : 0)) / m;
        const tm = (t0 + t1) * 0.5;
        if (mhL(e.cx + Math.cos(tm) * rm, e.cz + Math.sin(tm) * rm) > H + 0.1) continue;
        stoneColor(b, j, d, 0.98); b.ao(1);
        stone(b, t0 + 0.01 / rm, t1 - 0.01 / rm, H - 0.04, H + 0.08 + 0.08 * hr(j, 7, 431), r0, r1, j);
      }
    }
  }
  if (!bench || fill > 0.6) return;
  if (WALL_BENCH) WALL_BENCH(b);
  // bench: mud core, fieldstone facing, flat top slabs
  mortar(b);
  CORE[0] = R + 0.05; CORE[1] = 0.45; CORE[2] = R - 0.5; CORE[3] = 0.45; CORE[4] = R - 0.5; CORE[5] = 0.45; CORE[6] = R - 0.5; CORE[7] = -0.1;
  b.lathe(CORE.subarray(0, 8), seg, NOCAP);
  b.surface(SURF.STONE);
  courses(b, e, hr(k, 2, 441), hr(k, 2, 441) + TAU, 0, 0.45, 0, R - 0.56, R - 0.25, k * 64 + 50, 0.92, d, false);
  const rs = R - 0.3;
  const m = Math.round(TAU * rs / 0.7), off = hr(k, 9, 442) * TAU / m;
  for (let i = 0; i < m; i++) {
    const j = k * 4096 + i + 800000;
    const t0 = off + (i + 0.3 * (hr(j, 1, 443) - 0.5)) / m * TAU, t1 = off + (i + 1 + 0.3 * (hr(j + 1, 1, 443) - 0.5)) / m * TAU;
    stoneColor(b, j, d, 1.04); b.ao(0.95);
    stone(b, t0 + 0.01 / rs, t1 - 0.01 / rs, 0.45, 0.53 + 0.03 * hr(j, 2, 443), R - 0.62, R + 0.02, j);
  }
}
const CORE = new Float64Array(12);
let WALL_BENCH = null; // tag hook called before the bench is emitted
const TUS = new Float64Array(8);
const NOCAP = { caps: false };

// ---------------------------------------------------------------------------------
// People: dark skin, a hide wrap from chest to thigh, hair. Torso joints per POSE
// (pelvis y, z; chest y, z; head y, z) for a 1.7 m figure, matching kit.js.
const TORSO = [
  0.95, 0, 1.38, 0, 1.6, 0.01,
  0.93, 0, 1.36, 0.04, 1.58, 0.07,
  0.17, 0, 0.6, 0.05, 0.82, 0.1,
  0.55, -0.08, 0.95, 0.12, 1.15, 0.25,
  0.88, 0, 1.24, 0.26, 1.4, 0.4,
];
function person(b, x, y, z, yaw, pose, s) {
  const ht = 1.55 + 0.2 * hr(s, 2, 502), sc = ht / 1.7;
  const sk = 0.75 + 0.5 * hr(s, 3, 503), hk = 0.75 + 0.5 * hr(s, 4, 504);
  b.surface(SURF.HIDE).ao(1).emissive(0, 0);
  b.color(0.085 * sk, 0.052 * sk, 0.034 * sk);
  b.push(); b.at(x, y, z, yaw);
  b.human(pose, ht, s);
  b.scale(sc, sc, sc);
  const o = pose * 6, py = TORSO[o], pz = TORSO[o + 1], cy = TORSO[o + 2], cz = TORSO[o + 3], hy = TORSO[o + 4], hz = TORSO[o + 5];
  let ty = py - cy, tz = pz - cz;
  const tl = Math.hypot(ty, tz); ty /= tl; tz /= tl;
  const ext = pose === POSE.SIT ? 0.06 : 0.3;
  // hide wrap: lighter, tan or grey-brown
  if (hr(s, 5, 505) < 0.5) b.color(0.15 * hk, 0.1 * hk, 0.06 * hk); else b.color(0.11 * hk, 0.09 * hk, 0.07 * hk);
  b.beam(0, cy + ty * 0.05, cz + tz * 0.05, 0, py + ty * ext, pz + tz * ext, 0.15, pose === POSE.SIT ? 0.19 : 0.21, 7, true);
  // hair
  b.color(0.03, 0.024, 0.02).surface(SURF.PLAIN);
  b.push(); b.translate(0, hy + 0.035, hz - 0.035); b.ellipsoid(0.103, 0.1, 0.1, 2); b.pop();
  b.pop();
}

// Hearth: sooty warm-grey stones, an ash bed, logs, embers and orange-to-yellow flames.
// slot 1/2 binds light slot-1 (its flicker too); lit 0..1.
function hearth(b, x, y, z, size, slot, lit) {
  b.push(); b.translate(x, y, z);
  const R = 0.75 * size;
  b.surface(SURF.EARTH).ao(0.9);
  b.disc(R, 16, 3, (px, pz) => {
    const r = Math.hypot(px, pz) / R, glow = Math.max(0, 1 - r * 1.7) * lit;
    b.color(0.05 + 0.25 * glow, 0.045 + 0.07 * glow, 0.04 + 0.01 * glow).emissive(glow * 0.16, slot);
    return 0.02 + 0.05 * Math.max(0, 1 - r * r);
  });
  b.emissive(0, 0);
  b.surface(SURF.STONE).ao(0.8);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + hr(i, 1, 601) * 0.3, r = 0.86 * size;
    const g = 0.09 + 0.06 * hr(i, 2, 601);
    b.color(g * 1.1, g * 0.95, g * 0.78);
    b.push(); b.translate(Math.cos(a) * r, 0.03 * size, Math.sin(a) * r); b.rotateY(-a);
    b.rock(0.2 * size, 0.13 * size, 0.16 * size, 2, 0.25, 70 + i, 2, 0.45);
    b.pop();
  }
  b.surface(SURF.WOOD).ao(0.9);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4 + hr(i, 3, 601) * 0.4, c = Math.cos(a), s = Math.sin(a);
    b.color(0.1, 0.07, 0.045);
    b.beam(c * 0.85 * size, 0.07 * size, s * 0.85 * size, c * 0.28 * size, 0.1 * size, s * 0.28 * size, 0.07 * size, 0.06 * size, 6, true);
    b.color(0.05, 0.02, 0.01).emissive(0.25 * lit, slot);
    b.beam(c * 0.28 * size, 0.1 * size, s * 0.28 * size, c * 0.08 * size, 0.17 * size, s * 0.08 * size, 0.06 * size, 0.04 * size, 6, true);
    b.emissive(0, 0);
  }
  // layered animated flames, embers and the firelight on the ground (FX layer); their
  // strength follows the bound light's live level, so the fire dies with it
  if (lit > 0.02) b.flames(0, 0.08 * size, 0, 0.95 * size, slot > 0 ? slot : FLICKER.OWN, 31 + slot * 7);
  if (slot > 0) { b.lightAt(slot - 1, 0, 0.6 * size, 0); b.glow(0, 0, b.lights[(slot - 1) * 12 + 3] * 0.85); }
  b.pop();
}
const FL = new Float64Array(8);

// ---------------------------------------------------------------------------------
// Construction props
function timber(b) { b.color(0.2, 0.14, 0.09).surface(SURF.WOOD).ao(0.95).emissive(0, 0); }
function rope(b) { b.color(0.28, 0.22, 0.14).surface(SURF.PLAIN).ao(1); }
// Sledge along local z from z0 to z1 (runners at x = +-0.42).
function sledge(b, z0, z1) {
  timber(b);
  b.beam(-0.42, 0.08, z0, -0.42, 0.08, z1, 0.1, 0.1, 6);
  b.beam(0.42, 0.08, z0, 0.42, 0.08, z1, 0.1, 0.1, 6);
  for (let z = z0 + 0.3; z < z1 - 0.1; z += 1.1) b.beam(-0.6, 0.2, z, 0.6, 0.2, z, 0.07, 0.07, 5);
}
// lowest of five samples around (x, z): seats a long object on a slope
function seat(x, z, r) {
  let m = mhL(x, z);
  for (let i = 0; i < 4; i++) m = Math.min(m, mhL(x + Math.cos(i * 1.57) * r, z + Math.sin(i * 1.57) * r));
  return m;
}

// Rough-hewn slab: an 8-corner block with every corner knocked about, so the faces are
// flat chisel facets at odd angles (not a pillow). Centred on (0, 0, 0) in the current
// frame, bottom at -hy.
function hewn(b, hx, hy, hz, j, chip) {
  for (let i = 0; i < 8; i++) {
    const sx = (i & 3) === 1 || (i & 3) === 2 ? 1 : -1, sz = (i & 3) >= 2 ? 1 : -1, tp = i >= 4;
    const c = tp ? chip : 0;
    HX[i * 3] = sx * (hx - c * hr(j, i, 451)) + (hr(j, i, 452) - 0.5) * 0.08;
    HX[i * 3 + 1] = (tp ? hy : -hy) - (tp ? 0.5 : 0.2) * c * hr(j, i, 453);
    HX[i * 3 + 2] = sz * (hz - c * 1.5 * hr(j, i, 454)) + (hr(j, i, 455) - 0.5) * 0.1;
  }
  b.hexa(HX, true);
}
// Bedrock ledge along local z, broken by joints into 2-4 blocks of uneven height, each
// with knocked-about corners (an outcrop being worked, not a cast slab).
function ledge(b, x, y, z, yaw, hx, hy, hz, j, r, g, bl) {
  b.push(); b.at(x, y, z, yaw);
  const m = 2 + ((hr(j, 1, 460) * 3) | 0);
  let z0 = -hz;
  for (let i = 0; i < m; i++) {
    const z1 = i === m - 1 ? hz : z0 + (2 * hz / m) * (0.7 + 0.6 * hr(j, i, 461));
    const dy = (hr(j, i, 462) - 0.5) * 0.24, k = 0.9 + 0.18 * hr(j, i, 463);
    b.color(r * k, g * k, bl * k);
    b.push(); b.translate((hr(j, i, 464) - 0.5) * 0.15, dy, (z0 + z1) * 0.5);
    hewn(b, hx * (0.85 + 0.2 * hr(j, i, 465)), hy, (z1 - z0) * 0.5 - 0.04, j * 8 + i, 0.18);
    b.pop();
    z0 = z1;
  }
  b.pop();
}
// A quarried T-blank lying flat: a rough shaft and a wider rough head, hewn, not dressed.
// Long axis along local z (head toward +z). Bottom on y = 0.
function blank(b, L, W, T, j) {
  b.push(); b.translate(0, T * 0.5, -0.17 * L);
  hewn(b, W * 0.5, T * 0.5, L * 0.36, j, 0.07);
  b.pop();
  b.push(); b.translate(0.04, T * 0.52, 0.35 * L);
  hewn(b, W * 0.78, T * 0.52, L * 0.16, j + 1, 0.08);
  b.pop();
  b.push(); b.translate(-0.05, T * 0.9, -0.05 * L);
  hewn(b, W * 0.32, T * 0.12, L * 0.22, j + 2, 0.04); // a spall scar standing proud
  b.pop();
}
// Grass tuft: a few thin blades fanning out (3-sided tapered struts), foot at (x, y, z).
function tuft(b, x, y, z, s, j) {
  const nb = 4 + ((hr(j, 1, 720) * 3) | 0);
  for (let k = 0; k < nb; k++) {
    const a = hr(j, k + 2, 721) * TAU, lean = 0.2 + 0.45 * hr(j, k + 2, 722), h = s * (0.55 + 0.6 * hr(j, k + 2, 723));
    const c = Math.cos(a), sn = Math.sin(a), bx = x + c * 0.04 * s * 4, bz = z + sn * 0.04 * s * 4;
    b.beam(bx, y - 0.03, bz, bx + c * lean * h, y + h, bz + sn * lean * h, 0.022 + 0.02 * s, 0.002, 3, false);
  }
}

// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------
// Live state. The rise, the enclosures, the construction crews, the backfill rubble and the
// turf of the tell are all emitted once; handle.setState(built, decay) animates them:
//   the rise MORPHs per vertex from the undug hill (built 0) to the dug enclosures (built 1)
//   and on to the grassy tell (decay 1), colour included; pillars TILT up one by one (lying
//   beside their slot a moment first) with an A-frame crew that comes and goes; walls rise
//   (CLIP); the central pair goes up last, then the bench; rubble pours in (decay 0.1-0.6)
//   and is smoothed under turf, tussocks push up through it (0.62-1).
const { TILT, RISE: M_RISE, CLIP, MORPH, SCALE } = MOTION;

// Enclosure states for (built, decay): p (progress), q (dug), fill, dome, rough.
function setST(built, d) {
  S_D = d;
  for (let k = 0; k < ENC.length; k++) {
    const e = ENC[k];
    const p = clamp01((built - e.start) / e.dur);
    const q = p > 0 ? clamp01(p / 0.12) : 0;
    let f = 0, dome = 0;
    if (q > 0.5) {
      const hm = (e.hMin + e.hMax) * 0.5, uc = 1 - (CPAIR / e.R) * (CPAIR / e.R);
      const f06 = hm - 0.8, dome06 = (e.hC - 1.0 - f06) / uc;
      const f1 = e.hMax - 0.28, dome1 = (e.hC - 0.45 - f1) / uc;
      if (d < 0.6) { const t = sstep(0.05, 0.6, d); f = t * f06; dome = t * dome06; } else { const t = sstep(0.6, 1, d); f = mix(f06, f1, t); dome = mix(dome06, dome1, t); }
    }
    ST[k * 8] = p; ST[k * 8 + 1] = q; ST[k * 8 + 2] = f; ST[k * 8 + 3] = dome;
    ST[k * 8 + 4] = 0.32 * (1 - sstep(0.65, 0.95, d));
  }
}
const lin = (c) => (c / 255) * (c / 255);
// The decay window in which the rise at (x, z) fills: from the enclosures outward.
const FW = new Float64Array(2);
function fillWin(x, z, best) {
  const o = clamp01((best + 1) / 12), j = 0.03 * (noise3(x * 0.4, 5.5, z * 0.4) - 0.5);
  FW[0] = Math.max(0, 0.1 * o + j); FW[1] = Math.min(1, 0.85 + 0.15 * o + j);
}
// Height of the morphing rise at landmark (x, z) when decay = d (built 1).
function fillY(x, z, d) {
  let best = 1e9;
  for (let k = 0; k < ENC.length; k++) best = Math.min(best, Math.hypot(x - ENC[k].cx, z - ENC[k].cz) - ENC[k].R);
  fillWin(x, z, best);
  setST(1, 0); const hA = moundH(x, z);
  setST(1, 1); const hC = moundH(x, z);
  setST(1, 0);
  const t = clamp01((d - FW[0]) / (FW[1] - FW[0])); // linear, as the shader's MORPH vanish
  return mix(hA, hC, t);
}

export default {
  id: 'gobekli',
  name: 'Gobekli Tepe',
  caption: 'Hunters raise T-shaped stone pillars in rings',
  year: -9500,
  radius: 34,
  pad: 36, // road centre line at x = -42; road edge 38.6 m from the origin
  straddlesRoad: false,
  biome: 'desert',
  live: true,
  lights: [
    { pos: [-4, 2.1, 13], color: [1.0, 0.5, 0.2], intensity: 60, range: 22, flicker: 0.7 },
    { pos: [-3, 2.1, -12], color: [1.0, 0.5, 0.2], intensity: 45, range: 18, flicker: 0.7 },
  ],
  // close-up: enclosure A from the road side, its western central pillar in front
  detail: { at: [-6.9, 4.5, 13.0], from: [-10.6, 7.7, 20.6] },
  // time-lapse framing (viewer --strip): the whole rise from the road shoulder, filling the frame
  strip: { at: [1, 1.8, -1], from: [-39, 4.2, 30], fov: 0.72 },
  // Event moment (LANDMARKS.md "Witness"): high over the road shoulder, looking down into the
  // rings so the pillars read against the enclosure floors.
  witness: { at: [0, -2], dist: 64, height: 24, look: 1.5, az: 0.6, fov: 0.6, drift: 0.12 },
  // The gathering: hunter bands camped on the hills around (3-4 fires, smoke on the horizon).
  // They are lit as the work starts and go out with the hearths when the site is filled in.
  satellites: {
    count: [3, 4], near: 1, nearR: [140, 260], farR: [320, 900],
    centre: 0.2, spread: 5.2, minSep: 120, roadClear: 45,
    build(b, k, n, dist) {
      const far = Math.min(1, dist / 900), t = 0.04 + 0.12 * (k / n);
      b.timeless().pivot(0, 0, 0).appear(0.05 + 0.1 * k / n, 0.12 + 0.1 * k / n, MOTION.GROW, 0, BY.BUILT).vanish(t, t + 0.06, MOTION.GROW, 0, BY.DECAY);
      b.farFire((0.9 + 1.2 * far) * (0.85 + 0.3 * b.rand()), 28 + 26 * far, 0.8 + 0.4 * b.rand());
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 7 + 3;
    const bs = b.bio('soil');
    BIO_S[0] = bs[0]; BIO_S[1] = bs[1]; BIO_S[2] = bs[2]; BIO_T = 0.3;
    S_FY = 0;

    // --- the rise: one surface morphing through three states
    b.surface(SURF.EARTH).ao(1).emissive(0, 0).timeless();
    let call = 0;
    b.disc(33, 150, 48, (x, z) => {
      setST(1, 0);
      const hA = moundH(x, z);
      if ((call++ % 5) !== 4) return hA; // gradient samples
      setST(0, 0); const h0 = moundH(x, z);
      setST(1, 1); const h1 = moundH(x, z); S_D = 0.6; moundColor(b, x, z, h1); S_D = 1;
      const r1 = lin(b.cr), g1 = lin(b.cg), b1 = lin(b.cb);
      // dug when its nearest enclosure is opened; filled from the enclosures outward
      let best = 1e9, t0 = 0, t1 = 0.01;
      for (let k = 0; k < ENC.length; k++) {
        const e = ENC[k], dk = Math.hypot(x - e.cx, z - e.cz) - e.R;
        if (dk < best) { best = dk; t0 = e.start + 0.01 * e.dur; t1 = e.start + 0.12 * e.dur; }
      }
      fillWin(x, z, best);
      b.timeless().morph(h0, h1, r1, g1, b1).appear(t0, t1, MORPH, 0, BY.BUILT).vanish(FW[0], FW[1], MORPH, 0, BY.DECAY);
      setST(1, 0); moundColor(b, x, z, hA);
      return hA;
    });
    b.timeless();
    yield;

    // tussocks on the tell, pushing up through the turf late in the decay
    setST(1, 1);
    b.surface(SURF.THATCH).emissive(0, 0);
    for (let i = 0; i < 230; i++) {
      const a = hr(i, 1, 701) * TAU, r = Math.sqrt(hr(i, 2, 701)) * 29;
      const cx = MX + Math.cos(a) * r, cz = MZ + Math.sin(a) * r;
      if (Math.hypot(cx, cz) > 31) continue;
      const ch = moundH(cx, cz), ga = grassAt(cx, cz, ch);
      if (hr(i, 3, 701) > ga * 1.2) continue;
      const tg = 0.67 + 0.27 * hr(i, 12, 701);
      b.timeless().appear(tg, tg + 0.06, M_RISE, 0.5, BY.DECAY);
      const dry = hr(i, 5, 701), nt = 2 + ((hr(i, 4, 701) * 3) | 0), cr = 0.35 + 0.6 * hr(i, 6, 701);
      for (let t = 0; t < nt; t++) {
        const j = i * 16 + t, ta = hr(j, 7, 702) * TAU, tr = Math.sqrt(hr(j, 8, 702)) * cr;
        const x = cx + Math.cos(ta) * tr, z = cz + Math.sin(ta) * tr;
        const gk = 0.75 + 0.5 * hr(j, 9, 702), dd = clamp01(dry + (hr(j, 10, 702) - 0.5) * 0.4);
        b.color(mix(0.1, 0.24, dd) * gk, mix(0.13, 0.2, dd) * gk, mix(0.045, 0.085, dd) * gk).ao(0.8);
        tuft(b, x, moundH(x, z), z, 0.14 + 0.24 * hr(j, 11, 702) * (0.6 + 0.4 * ga), j);
      }
    }
    b.timeless();
    setST(1, 0);
    yield;

    for (let k = 0; k < ENC.length; k++) {
      const e = ENC[k], R = e.R, n = e.n;
      const tw = (f) => e.start + e.dur * f;
      S_FY = e.fy;
      b.push(); b.translate(e.cx, e.fy, e.cz);

      // floor: warm smoothed bedrock and lime plaster, uncovered once the enclosure is dug
      b.timeless().appear(tw(0.06), tw(0.12), M_RISE, 0.35, BY.BUILT);
      b.surface(SURF.STONE);
      const spx = Math.cos(e.rot) * CPAIR, spz = -Math.sin(e.rot) * CPAIR;
      b.disc(R - 0.25, 72, 14, (x, z) => {
        const r = Math.hypot(x, z) / R;
        const sock = sstep(1.0, 0.72, Math.min(Math.hypot(x - spx, z - spz), Math.hypot(x + spx, z + spz)));
        const nn = noise3(x * 0.6 + k * 13, 2.2, z * 0.6), m2 = noise3(x * 2.3, 6.3, z * 2.3);
        const cr = Math.abs(fbm3(x * 0.45, 4.1 + k, z * 0.45, 2) - 0.5);
        const g = 0.38 + 0.06 * nn + 0.03 * m2;
        let rr = g * 1.1, gg = g * 0.92, bb = g * 0.7;
        const crack = 1 - 0.35 * sstep(0.03, 0.0, cr);
        const dirt = sstep(0.72, 0.97, r + 0.08 * (m2 - 0.5));
        rr = mix(rr, 0.27, dirt) * crack; gg = mix(gg, 0.2, dirt) * crack; bb = mix(bb, 0.13, dirt) * crack;
        const sk = 1 - 0.3 * sock;
        b.color(rr * sk, gg * sk, bb * sk).ao(1 - 0.35 * dirt - 0.3 * sock);
        return 0.03 + 0.03 * (nn - 0.5) * (1 - dirt) + 0.06 * dirt - 0.05 * sock;
      });
      for (let i = 0; i < Math.round(R * 2.2); i++) {
        const a = hr(k, i, 91) * TAU, rr = R - 0.35 - 0.5 * hr(k, i, 92);
        const g = 0.24 + 0.12 * hr(k, i, 93), sz = 0.07 + 0.12 * hr(k, i, 94);
        b.color(g * 1.06, g * 0.95, g * 0.77).ao(0.75);
        b.push(); b.at(Math.cos(a) * rr, 0.05, Math.sin(a) * rr, a); b.rock(sz * 1.3, sz * 0.7, sz, 1, 0.3, k * 300 + i, 3, 0.5); b.pop();
      }

      // pillar slots, raise order (the far side first, ending at e.endA, the road side)
      const sa = e.endA + Math.PI;
      for (let i = 0; i < n; i++) {
        AN[i] = e.a0 + i * TAU / n + (hr(k, i, sd + 3) - 0.5) * 0.06;
        YW[i] = Math.atan2(-Math.cos(AN[i]), -Math.sin(AN[i]));
        HT[i] = RT * 0.53 + 0.012;
      }
      for (let i = 0; i < n; i++) {
        let r = 0;
        const di = Math.abs(wrap(AN[i] - sa)) + i * 1e-4;
        for (let j = 0; j < n; j++) if (Math.abs(wrap(AN[j] - sa)) + j * 1e-4 < di) r++;
        RK[i] = r;
      }
      const tR = (r) => tw(0.15 + 0.65 * r / n), tR1 = (r) => tw(0.15 + 0.65 * (r + 1) / n);

      // ring pillars: each lies beside its slot, then is levered and hauled upright
      for (let i = 0; i < n; i++) {
        const a = AN[i], ht = mix(e.hMin, e.hMax, hr(k, i, sd + 5)), Hs = ht - RHH;
        const px = Math.cos(a) * (R + 0.15), pz = Math.sin(a) * (R + 0.15);
        const id = k * 32 + i + sd * 1024;
        const kc = 0.92 + 0.14 * hr(k, i, sd + 7), hue = hr(k, i, sd + 8) - 0.5;
        const t = (i * 7 + k * 3 + sd) % 5;
        M_HEAD = t === 0 || t === 3 ? 0 : t === 1 || t === 4 ? 1 : -1;
        M_SHAFT = (i * 3 + k + sd) % 5 < 4 ? (i * 3 + k + sd) % 5 : -1;
        M_SIDE = (i + k) & 1 ? 1 : -1;
        M_FRONT = (i * 5 + k + sd) % 4 === 0;
        b.push();
        b.at(px, 0, pz, YW[i]);
        b.timeless().pivot(0, 0, 0).tiltDir(0, -1).appear(tR(RK[i]), tR1(RK[i]), TILT, 0, BY.BUILT, 0.08);
        tPillar(b, Hs, RHH, RW, RT, RHB, RHF, 0.4 * kc * (1 + 0.05 * hue), 0.358 * kc, 0.275 * kc * (1 - 0.06 * hue), id, 1, 1, 0);
        b.pop();
      }
      // walls rise in courses between the pillars; the bench goes in last
      WALL_BENCH = (bb) => bb.timeless().appear(tw(0.88), tw(0.94), M_RISE, 0.6, BY.BUILT);
      b.timeless().pivot(0, 0, 0).reach(e.H + 0.25).appear(tw(0.2), tw(0.8), CLIP, 0, BY.BUILT);
      wall(b, e, k, e.H, true, 0, 0, n);
      WALL_BENCH = null;

      // central pair (raised last), feet sunk into sockets in the bedrock floor
      const fx = Math.sin(e.rot), fz = Math.cos(e.rot), nx = Math.cos(e.rot), nz = -Math.sin(e.rot);
      for (let s2 = -1; s2 <= 1; s2 += 2) {
        const px = nx * CPAIR * s2, pz = nz * CPAIR * s2, kc = 1.0 + 0.03 * s2;
        const tc = tw(0.8 + (s2 > 0 ? 0.07 : 0));
        b.push(); b.at(px, 0, pz, e.rot);
        b.timeless().pivot(0, 0, 0).tiltDir(0, -1).appear(tc, tc + 0.07 * e.dur, TILT, 0, BY.BUILT, 0.1);
        const rs = Math.cos(e.rot) < 0 ? 1 : -1;
        tPillar(b, e.hC - CHH, CHH, CW, CT, CHB, CHF, 0.42 * kc, 0.375 * kc, 0.29 * kc, k * 2 + (s2 > 0 ? 1 : 0), 2, rs, 0);
        // the timber sledge it lies on until it is raised
        b.timeless().appear(tc - 0.1, tc - 0.095, M_RISE, 0.5, BY.BUILT).vanish(tc + 0.02, tc + 0.03, M_RISE, 0.5, BY.BUILT);
        b.push(); b.translate(0, 0, -e.hC * 0.5 - 0.3); sledge(b, -e.hC * 0.5, e.hC * 0.5); b.pop();
        b.pop();
      }

      // --- construction crews: an A-frame and a hauling team at every third pillar while it
      // goes up
      for (let i = 0; i < n; i++) {
        if (RK[i] % 3) continue;
        const a = AN[i], ca = Math.cos(a), sa2 = Math.sin(a), yaw = Math.atan2(-ca, -sa2);
        const ht = mix(e.hMin, e.hMax, hr(k, i, sd + 5)), Hs = ht - RHH;
        const r0 = tR(RK[i]), r1 = tR1(RK[i]);
        b.timeless().appear(r0 - 0.03, r0 - 0.02, M_RISE, 1.2, BY.BUILT).vanish(r1 + 0.01, r1 + 0.02, M_RISE, 6, BY.BUILT);
        b.push(); b.at(ca * (R + 0.15), 0, sa2 * (R + 0.15), yaw);
        timber(b);
        const tl = 0.75, c = Math.cos(tl), s = Math.sin(tl);
        const Z0 = 1.8;
        const yTop = ((Z0 - 0.5 * c) / s) * c - 0.5 * s;
        for (let l = 0; l * 0.24 + 0.24 < yTop + 0.02; l++) {
          const yy = 0.12 + l * 0.24;
          if (l & 1) { b.beam(-0.38, yy, Z0 - 0.6, -0.38, yy, Z0 + 0.6, 0.12, 0.11, 6); b.beam(0.38, yy, Z0 - 0.6, 0.38, yy, Z0 + 0.6, 0.12, 0.11, 6); }
          else { b.beam(-0.75, yy, Z0 - 0.38, 0.75, yy, Z0 - 0.38, 0.12, 0.11, 6); b.beam(-0.75, yy, Z0 + 0.38, 0.75, yy, Z0 + 0.38, 0.12, 0.11, 6); }
        }
        const gA = Math.max(0, mhL(e.cx + ca * (R + 1.4), e.cz + sa2 * (R + 1.4)));
        const apY = 5.6, apZ = -0.3;
        b.beam(-1.5, gA - 0.1, -1.3, 0, apY, apZ, 0.1, 0.07, 6);
        b.beam(1.5, gA - 0.1, -1.3, 0, apY, apZ, 0.1, 0.07, 6);
        b.beam(-0.9, gA + 2.3, -0.95, 0.9, gA + 2.3, -0.95, 0.06, 0.06, 5);
        const sh = Hs + RHH * 0.5;
        const ay = sh * c + 0.75 * s, az = sh * s - 0.75 * c;
        let lastY = 0;
        for (let h = 0; h < 3; h++) {
          const lz = -4.4 - h * 1.1, lx = (h & 1) ? 0.32 : -0.32;
          const wx = e.cx + ca * (R + 0.15) + Math.cos(yaw) * lx + Math.sin(yaw) * lz;
          const wz = e.cz + sa2 * (R + 0.15) - Math.sin(yaw) * lx + Math.cos(yaw) * lz;
          const gy = Math.max(0, mhL(wx, wz));
          person(b, lx, gy, lz, Math.PI, POSE.HAUL, 900 + k * 40 + i * 3 + h);
          lastY = gy;
        }
        rope(b);
        const y1 = Math.max(0, lastY) + 1.12;
        b.beam(0, ay, az, 0, apY - 0.05, apZ, 0.04, 0.04, 5, false);
        b.beam(0, apY - 0.05, apZ, 0, y1 + 0.35, -4.95, 0.04, 0.04, 5, false);
        b.beam(0, y1 + 0.35, -4.95, 0, y1, -7.3, 0.04, 0.04, 5, false);
        b.pop();
      }

      // marking stakes and surveyors while the ground is being opened
      b.timeless().appear(tw(0), tw(0.01), M_RISE, 1, BY.BUILT).vanish(tw(0.18), tw(0.2), M_RISE, 1.2, BY.BUILT);
      timber(b);
      const m = Math.round(TAU * (R + 0.5) / 2.4);
      for (let i = 0; i < m; i++) {
        const a = i / m * TAU, x = Math.cos(a) * (R + 0.5), z = Math.sin(a) * (R + 0.5);
        const gy = Math.max(0, mhL(e.cx + x, e.cz + z)) - 0.1;
        b.beam(x, gy, z, x, gy + 0.9, z, 0.07, 0.055, 5);
      }
      person(b, 1.5, 0.03, -2.0, 0.4, POSE.KNEEL, 1300 + k);
      person(b, 0.5, 0.03, 2.5, 3.0, POSE.STAND, 1320 + k);

      // in use: a hearth before the central pair, people gathered; the fire dies early in the
      // decay
      if (k < 2) {
        const fx2 = fx * 2.8, fz2 = fz * 2.8, tu = tw(0.97);
        b.lightLive(k, tu, tw(1) + 0.005, 0.05, 0.22);
        b.timeless().appear(tu, tu + 0.02, M_RISE, 0.3, BY.BUILT);
        hearth(b, fx2, 0.03, fz2, k === 0 ? 1.0 : 0.85, k + 1, 1);
        b.timeless().appear(tu, tu + 0.02, M_RISE, 2, BY.BUILT).vanish(0.03, 0.1, M_RISE, 2, BY.DECAY);
        const np = k === 0 ? 4 : 2;
        for (let h = 0; h < np; h++) {
          const a = 0.6 + h * (TAU / (np + 1)) + e.rot;
          const px = fx2 + Math.cos(a) * 1.7, pz = fz2 + Math.sin(a) * 1.7;
          person(b, px, 0.03, pz, Math.atan2(fx2 - px, fz2 - pz), POSE.SIT, 1400 + k * 10 + h);
        }
        if (k === 0) {
          person(b, nx * 3.4 + fx * 0.8, 0.03, nz * 3.4 + fz * 0.8, e.rot + 2.6, POSE.STAND, 1450);
          person(b, -nx * 3.6 + fx * 1.2, 0.03, -nz * 3.6 + fz * 1.2, e.rot - 2.2, POSE.STAND, 1451);
        }
      }

      // backfill rubble: angular limestone chunks and earth clods tipped in (decay 0.1-0.6),
      // each landing on the fill as it is at that moment and buried by what follows
      const nrub = Math.round((R + 3) * (R + 3) * 2.2);
      b.surface(SURF.STONE);
      for (let i = 0; i < nrub; i++) {
        const a = hr(k, i, 81) * TAU, rr = Math.sqrt(hr(k, i, 82)) * (R + 3.0);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const ta = 0.01 + 0.6 * hr(k, i, 90), tv = ta + 0.25;
        const gy = fillY(e.cx + x, e.cz + z, ta + 0.03) - e.fy;
        const g = 0.27 + 0.16 * hr(k, i, 83), clod = hr(k, i, 86) < 0.25;
        if (clod) b.color(g * 0.95, g * 0.74, g * 0.52).ao(0.85);
        else b.color(g * 1.08, g * 0.97, g * 0.78).ao(0.9);
        const sz = 0.07 + 0.25 * hr(k, i, 84) * hr(k, i, 87);
        b.timeless().appear(ta, ta + 0.06, M_RISE, sz * 3 + 0.3, BY.DECAY).vanish(tv, tv + 0.06, M_RISE, sz * 2 + 0.2, BY.DECAY);
        b.push(); b.at(x, gy - sz * 0.25, z, hr(k, i, 85) * TAU);
        b.rotateX((hr(k, i, 88) - 0.5) * 0.8);
        b.rock(sz * (0.9 + 0.6 * hr(k, i, 89)), sz * 0.6, sz, 1, 0.35, k * 1000 + i, 3, 0.3);
        b.pop();
      }
      setST(1, 0);
      b.timeless();
      b.pop();
      S_FY = 0;
      yield;
    }

    // --- quarry on the road side of the rise: hewn bedrock ledges round a cut channel with
    // a half-cut T-pillar being levered up on its edge in it. The bedrock surfaces as the
    // overburden is cleared at the start of the works; in the decay the quarry silts up and
    // everything here sinks under the spreading tell with the rest of the site.
    const qy = Math.max(0, moundH(QX, QZ));
    const qr = 0.36, qg = 0.325, qb = 0.26;
    const quarryTags = (t0, h) => b.timeless().appear(t0, t0 + 0.08, M_RISE, h, BY.BUILT).vanish(0.42 + (t0 - 0.02), 0.72 + (t0 - 0.02), M_RISE, h + 0.15, BY.DECAY);
    quarryTags(0.03, 0.9);
    b.color(qr, qg, qb).surface(SURF.STONE).ao(0.85);
    ledge(b, QX - 1.9, qy - 0.06, QZ + 0.4, 0, 0.85, 0.4, 3.6, 11, qr, qg, qb);
    ledge(b, QX + 2.0, qy - 0.1, QZ + 0.7, 0, 0.8, 0.36, 3.3, 12, qr, qg, qb);
    ledge(b, QX + 0.1, qy - 0.12, QZ - 4.6, Math.PI / 2, 0.7, 0.36, 2.4, 13, qr, qg, qb);
    // the T-pillar being levered up out of its bed: foot still in the cut, broad face to the
    // road, leaning back on a timber crib, so its T outline reads from the road. Fresh, pale
    // stone. It is worked free over the build and goes under the tell with the rest.
    quarryTags(0.08, 2.6);
    b.color(0.52, 0.47, 0.38).surface(SURF.STONE).ao(0.95);
    const LEAN = 0.95, PL = 4.6; // lean from vertical (rad), length
    b.push(); b.at(QX, qy - 0.35, QZ - 2.2, 0);
    b.rotateX(LEAN); // +y (the pillar's long axis) toward +z
    b.push(); b.translate(0, PL * 0.36, 0); hewn(b, 0.22, PL * 0.36, 0.42, 21, 0.05); b.pop();
    b.push(); b.translate(0.03, PL * 0.72 + 0.4, 0.28); hewn(b, 0.24, 0.42, 0.78, 22, 0.06); b.pop();
    b.pop();
    // timber crib under the head and two levers
    timber(b);
    const hy = qy - 0.35 + Math.cos(LEAN) * PL * 0.8, hz = QZ - 2.2 + Math.sin(LEAN) * PL * 0.8;
    for (let l = 0; l * 0.2 + 0.2 < hy - qy - 0.2; l++) {
      const yy = qy + 0.08 + l * 0.2;
      if (l & 1) { b.beam(QX - 0.5, yy, hz - 0.45, QX + 0.5, yy, hz - 0.45, 0.09, 0.09, 6); b.beam(QX - 0.5, yy, hz + 0.45, QX + 0.5, yy, hz + 0.45, 0.09, 0.09, 6); }
      else { b.beam(QX - 0.4, yy, hz - 0.6, QX - 0.4, yy, hz + 0.6, 0.09, 0.09, 6); b.beam(QX + 0.4, yy, hz - 0.6, QX + 0.4, yy, hz + 0.6, 0.09, 0.09, 6); }
    }
    b.beam(QX + 0.35, qy + 0.05, QZ - 3.6, QX + 0.25, hy - 0.4, hz - 1.6, 0.07, 0.06, 6);
    b.beam(QX - 0.35, qy + 0.05, QZ - 3.4, QX - 0.25, hy - 0.5, hz - 1.7, 0.07, 0.06, 6);
    // loose blanks while work goes on (used up by the end), one discarded cracked blank after
    for (let i = 0; i < 3; i++) {
      const bx = QX + 5.0 + i * 1.6, bz = QZ - 2.0 + i * 2.1;
      const tv = 0.4 + 0.25 * i;
      b.timeless().appear(0.12 + 0.08 * i, 0.18 + 0.08 * i, M_RISE, 0.6, BY.BUILT).vanish(tv, tv + 0.03, SCALE, 0, BY.BUILT);
      b.push(); b.at(bx, Math.max(0, moundH(bx, bz)) - 0.08, bz, 0.2 + i * 0.5);
      b.pivot(0, 0.2, 0);
      b.color(0.45, 0.405, 0.325).surface(SURF.STONE).ao(0.9);
      blank(b, 3.4 + 0.4 * i, 0.8, 0.42, 30 + i * 3);
      b.pop();
    }
    b.timeless().appear(0.97, 0.99, M_RISE, 0.6, BY.BUILT).vanish(0.35, 0.6, M_RISE, 0.6, BY.DECAY);
    {
      const bx = QX + 5.0, bz = QZ - 2.0;
      b.push(); b.at(bx, Math.max(0, moundH(bx, bz)) - 0.08, bz, 0.2);
      b.translate(0, 0.2, 0); hewn(b, 0.42, 0.2, 1.1, 40, 0.1); b.translate(0.15, 0, 1.45); b.rotateY(0.35); hewn(b, 0.5, 0.2, 0.5, 41, 0.1);
      b.pop();
    }
    // quarrymen and their cook fire while the work goes on
    b.timeless().appear(0.0, 0.05, MOTION.FADE, 0, BY.BUILT).vanish(0.93, 0.985, MOTION.FADE, 0, BY.BUILT);
    person(b, QX - 0.9, qy, QZ - 3.9, 0.2, POSE.HAUL, 1500);
    person(b, QX + 1.05, qy + 0.27, QZ + 1.9, -Math.PI / 2, POSE.KNEEL, 1501);
    person(b, QX + 3.6, Math.max(0, moundH(QX + 3.6, QZ + 2.5)), QZ + 2.5, -2.4, POSE.STAND, 1502);
    const fxq = QX + 2.5, fzq = QZ - 7.0;
    person(b, fxq + 1.4, Math.max(0, moundH(fxq + 1.4, fzq)), fzq, -Math.PI / 2, POSE.SIT, 1503);
    person(b, fxq - 0.6, Math.max(0, moundH(fxq - 0.6, fzq + 1.3)), fzq + 1.3, 2.7, POSE.SIT, 1504);
    hearth(b, fxq, Math.max(0, moundH(fxq, fzq)) + 0.03, fzq, 0.8, 0, 1);
    b.timeless();
    return b.counts();
  },
};
