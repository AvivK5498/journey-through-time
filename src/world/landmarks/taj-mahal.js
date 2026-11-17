// Taj Mahal: Shah Jahan's white marble tomb for Mumtaz Mahal at Agra (1632-1653).
// Contract: internal_docs/LANDMARKS.md. Live landmark: one build holds the whole timeline.
//
// Layout (landmark-local; road at x = -165, the car comes from +z): the garden axis runs along
// z. The tomb (true scale: 55 m irregular octagon, onion dome to ~76 m) stands on its marble
// plinth (92 m square) at z = -52 on the red sandstone riverfront terrace, four minarets at
// the plinth corners leaning very slightly outward, the red sandstone mosque and its twin
// guest house flanking it (x = +-78), the river behind (z < -112). In front: the four-part
// garden walled in red sandstone, the long reflecting pool on the axis with the raised marble
// tank at its centre and the cross canal, lines of cypresses, and the red sandstone gateway at
// z = +118. The witness eye stands just inside the gateway on the axis: the frontal view down
// the pool (the water is a pale sky-mirror strip; the kit has no reflections).
//
// built (clock 186-194): terrace 0-0.05, plinth brick 0.03-0.1 then marble 0.1-0.19; the
//   tomb's brick core rises inside timber scaffolding 0.1-0.38 while a long earth ramp climbs
//   the axis with it (0.08-0.42; marble blocks hauled up it); marble cladding goes on from the
//   bottom, face by face (lower storey 0.3-0.4, iwans 0.4-0.47, upper storey 0.44-0.55, the
//   brick behind each storey gone once it is covered); drum and dome brick 0.38-0.62; minarets
//   rise stage by stage 0.44-0.72; kiosks 0.64-0.7; the dome is clad last, band by band
//   (0.7-0.86), the gilt finial set 0.88; ramp and scaffolds struck 0.84-0.9; then the garden:
//   paths, beds, water, cypresses (0.9-0.98); mosque, guest house and gateway rise 0.14-0.62.
// decay (0 -> 0.15, clock 240-300): the marble yellows slightly and warms (MORPH colour, per
//   vertex); nothing else changes.

import { SURF, POSE, MOTION, BY, noise3 } from './kit.js';

const TAU = Math.PI * 2;
const R = 155;
const TZ = -52; // tomb centre z
const YT = 1.0; // terrace top
const Y0 = 7.2; // plinth top
const PL = 46; // plinth half size
const TW = 27.5, CF = 8.5; // tomb half width, chamfer
const FC = (2 * TW - CF) / Math.SQRT2, HC = CF / Math.SQRT2; // chamfer face distance, half length
const WT = 28, PT = 33, YS = Y0 + 14.8; // wall / pishtaq top above Y0, storey split
const YR = Y0 + WT; // roof
const DR = 10.6, DH = 7, YD = YR + DH; // drum radius, height; dome springing
const MXY = 41.5; // minaret offset from the tomb centre
const GZ = 118; // gateway centre z
const PZ0 = 8, PZ1 = 106, PW = 3.4, KZ = 57; // pool ends, half width; tank / cross canal z
const WX = 90; // garden wall x

const MARBLE = [0.5, 0.49, 0.47];
const RED = [0.33, 0.115, 0.065];
const PATH = [0.38, 0.19, 0.11];
const BRICK = [0.34, 0.16, 0.09];
const EARTH = [0.42, 0.3, 0.18];
const TIMBER = [0.2, 0.13, 0.075];
const GOLD = [0.9, 0.64, 0.26];
const POOL = [0.42, 0.47, 0.5];
const RIVER = [0.16, 0.29, 0.29];
const CYP = [0.03, 0.062, 0.036];
const LAWN = [0.085, 0.13, 0.04];
const ROBES = [[0.46, 0.43, 0.37], [0.32, 0.1, 0.06], [0.1, 0.12, 0.25], [0.4, 0.3, 0.12], [0.2, 0.21, 0.16]];

// onion dome profile (r, h above the drum), and a coarse one for small domes
const ONION = [10.6, 0, 11.9, 1.4, 12.8, 3.6, 13.2, 6.2, 13.0, 9.0, 12.2, 11.8, 10.8, 14.4, 8.9, 16.8, 6.8, 18.9, 4.7, 20.8, 2.9, 22.4, 1.5, 23.7, 0.6, 24.6, 0, 25.0];
const ONS = [10.6, 0, 12.6, 3.0, 13.1, 7.0, 12.0, 11.8, 9.3, 16.4, 5.6, 20.0, 2.4, 23.0, 0, 25.0];
const CYPP = new Float64Array([0.25, -0.3, 0.95, 1.2, 1.15, 4, 0.95, 7.5, 0.5, 10, 0.05, 11.5]);

function hsh(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- emission with the marble's decay colour --------------------------------------------
// MM: marble mode. Every marble vertex carries a MORPH vanish target (its own height, a warmer
// yellowed colour), so the decay yellows it without moving it; built uses RISE (piv.w only).
// No transform used with V translates in y, so local y is landmark y.
let MM = false, CR = 0, CG = 0, CB = 0, SHX = 0, SHZ = 0;
function col(b, c, f = 1) { CR = c[0] * f; CG = c[1] * f; CB = c[2] * f; return b.color(CR, CG, CB); }
function V(b, x, y, z, nx, ny, nz) {
  if (MM) b.morph(0, y, CR * 1.06, CG * 0.965, CB * 0.78);
  const s = y - Y0;
  return b.vertex(x + SHX * s, y, z + SHZ * s, nx, ny, nz);
}
// tag one element: RISE in over [t0, t1]; marble also yellows over the decay
function T(b, t0, t1, marble) {
  b.timeless().appear(t0, t1, MOTION.RISE, 0.8, BY.BUILT);
  if (marble) b.vanish(0, 0.16, MOTION.MORPH, 0, BY.DECAY);
  MM = marble;
  return b;
}
// CLIP-rising sandstone / brick element
function C(b, t0, t1, y0, h) { MM = false; return b.timeless().pivot(0, y0, 0).reach(h).appear(t0, t1, MOTION.CLIP, 0, BY.BUILT); }
function Q(b, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz) {
  b.quad(V(b, ax, ay, az, nx, ny, nz), V(b, bx, by, bz, nx, ny, nz), V(b, cx, cy, cz, nx, ny, nz), V(b, dx, dy, dz, nx, ny, nz));
}
const FQ = (b, u0, y0, u1, y1, z) => Q(b, u0, y0, z, u1, y0, z, u1, y1, z, u0, y1, z, 0, 0, 1);
const flat = (b, x0, z0, x1, z1, y) => Q(b, x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, 0, 1, 0);
function mbox(b, cx, cy, cz, hx, hy, hz) {
  const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
  Q(b, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0);
  Q(b, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1);
  Q(b, x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, 0, 0, -1);
  Q(b, x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, 1, 0, 0);
  Q(b, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0);
}
const PR = new Float64Array(64);
function P() { for (let i = 0; i < arguments.length; i++) PR[i] = arguments[i]; return PR.subarray(0, arguments.length); }
function prof(src, k, y0) { for (let i = 0; i < src.length; i += 2) { PR[i] = src[i] * k; PR[i + 1] = y0 + src[i + 1] * k; } return PR.subarray(0, src.length); }
// surface of revolution about (cx, cz); profile [r, y, ...] bottom -> top, absolute y; rows k0..k1
function mlathe(b, cx, cz, p, seg, cap, k0 = 0, k1 = -1) {
  const n = p.length >> 1; if (k1 < 0) k1 = n - 1;
  const W = seg + 1; let s0 = -1;
  for (let k = k0; k <= k1; k++) {
    const ka = Math.max(0, k - 1), kb = Math.min(n - 1, k + 1);
    const tr = p[kb * 2] - p[ka * 2], ty = p[kb * 2 + 1] - p[ka * 2 + 1], l = Math.hypot(tr, ty) || 1;
    const nr = ty / l, ny = -tr / l, r = p[k * 2], y = p[k * 2 + 1];
    for (let i = 0; i <= seg; i++) {
      const th = (i % seg) * TAU / seg, c = Math.cos(th), s = Math.sin(th);
      const v = V(b, cx + c * r, y, cz + s * r, c * nr, ny, s * nr);
      if (s0 < 0) s0 = v;
    }
  }
  if (s0 < 0) return;
  for (let k = 0; k < k1 - k0; k++) for (let i = 0; i < seg; i++) { const a = s0 + k * W + i; b.quad(a, a + 1, a + W + 1, a + W); }
  const r = p[k1 * 2];
  if (cap && r > 0.01) {
    const y = p[k1 * 2 + 1], c = V(b, cx, y, cz, 0, 1, 0);
    for (let i = 0; i < seg; i++) {
      const a0 = i * TAU / seg, a1 = (i + 1) * TAU / seg;
      b.tri(c, V(b, cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, 0, 1, 0), V(b, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r, 0, 1, 0));
    }
  }
}

// ---- arched bays (face frame: wall plane z = F, outward +z, u along x) -------------------
// Wall column u0..u1 from y0 to y1 with a pointed (two-centred) arch opening inset by m:
// sill ys, spring yk, apex ya, recessed dp metres; N segments (even).
let AU = 0, AW = 0, AR = 0, AK = 0;
const ay = (u) => { const t = Math.abs(u - AU) + AR - AW; return AK + Math.sqrt(Math.max(0, AR * AR - t * t)); };
function archSet(ua, ub, yk, ya) { AU = (ua + ub) / 2; AW = (ub - ua) / 2; const h = ya - yk; AR = (h * h + AW * AW) / (2 * AW); AK = yk; }
function arch(b, F, u0, u1, y0, y1, m, ys, yk, ya, dp, c, N) {
  const ua = u0 + m, ub = u1 - m, zb = F - dp;
  archSet(ua, ub, yk, ya);
  col(b, c).ao(1);
  if (m > 0) { FQ(b, u0, y0, ua, y1, F); FQ(b, ub, y0, u1, y1, F); }
  if (ys > y0 + 0.01) FQ(b, ua, y0, ub, ys, F);
  for (let i = 0; i < N; i++) { const p = ua + (ub - ua) * i / N, q = ua + (ub - ua) * (i + 1) / N; Q(b, p, ay(p), F, q, ay(q), F, q, y1, F, p, y1, F, 0, 0, 1); }
  col(b, c, 0.82).ao(0.45);
  for (let i = 0; i < N; i++) { const p = ua + (ub - ua) * i / N, q = ua + (ub - ua) * (i + 1) / N; Q(b, p, ys, zb, q, ys, zb, q, ay(q), zb, p, ay(p), zb, 0, 0, 1); }
  col(b, c, 0.92).ao(0.6);
  Q(b, ua, ys, F, ua, yk, F, ua, yk, zb, ua, ys, zb, 1, 0, 0);
  Q(b, ub, ys, F, ub, yk, F, ub, yk, zb, ub, ys, zb, -1, 0, 0);
  for (let i = 0; i < N; i++) {
    const p = ua + (ub - ua) * i / N, q = ua + (ub - ua) * (i + 1) / N, dy = ay(q) - ay(p), du = q - p, l = Math.hypot(du, dy);
    Q(b, p, ay(p), F, q, ay(q), F, q, ay(q), zb, p, ay(p), zb, dy / l, -du / l, 0);
  }
  if (ys > y0 + 0.01) { col(b, c, 0.97).ao(0.85); Q(b, ua, ys, F, ub, ys, F, ub, ys, zb, ua, ys, zb, 0, 1, 0); }
  b.ao(1);
}
// flat arch-shaped panel on the plane z (blind arcades, doors, lattices)
function panel(b, z, ua, ub, ys, yk, ya, N) {
  archSet(ua, ub, yk, ya);
  FQ(b, ua, ys, ub, yk, z);
  for (let i = 0; i < N; i++) { const p = ua + (ub - ua) * i / N, q = ua + (ub - ua) * (i + 1) / N; Q(b, p, yk, z, q, yk, z, q, ay(q), z, p, ay(p), z, 0, 0, 1); }
}
// framing band round a big arch (the inlaid border): left, right, top strips
function alfiz(b, F, ua, ub, ys, ytop, w, c, f) {
  col(b, c, f).ao(1);
  FQ(b, ua - w - 0.5, ys, ua - 0.5, ytop, F + 0.03); FQ(b, ub + 0.5, ys, ub + w + 0.5, ytop, F + 0.03);
  FQ(b, ua - 0.5, ytop - w, ub + 0.5, ytop, F + 0.03);
}
// pishtaq: the tall framed iwan projecting 0.7 m from the wall plane F
function pishtaq(b, F, hw, y0, top, m, yk, ya, dp, c, crownD) {
  const G = F + 0.7;
  arch(b, G, -hw, hw, y0, top, m, y0, yk, ya, dp, c, 10);
  col(b, c, 0.96);
  Q(b, -hw, y0, F, -hw, top, F, -hw, top, G, -hw, y0, G, -1, 0, 0);
  Q(b, hw, y0, F, hw, top, F, hw, top, G, hw, y0, G, 1, 0, 0);
  col(b, c, 0.98); mbox(b, 0, top - crownD / 2, F - 0.6, hw - 0.05, crownD / 2, 1.25);
  col(b, c, 1.04); mbox(b, 0, top + 0.18, G - 0.35, hw + 0.25, 0.18, 0.75);
}

// ---- kiosks and domes --------------------------------------------------------------------
function finial(b, cx, cz, y, s, t0) {
  T(b, t0, t0 + 0.02, false); col(b, GOLD).surface(SURF.GILT).ao(1);
  mlathe(b, cx, cz, P(0.5 * s, y - 0.2, 0.8 * s, y + 0.4 * s, 0.35 * s, y + 1.0 * s, 0.7 * s, y + 1.7 * s, 0.25 * s, y + 2.5 * s, 0.5 * s, y + 3.1 * s, 0.12 * s, y + 3.7 * s, 0, y + 5.2 * s), 6, false);
  b.surface(SURF.POLISH);
}
// small onion dome on a drum: base radius r at y
function sdome(b, cx, cz, y, r, t0, seg) {
  T(b, t0, t0 + 0.03, true); col(b, MARBLE).surface(SURF.POLISH).ao(0.95);
  mlathe(b, cx, cz, P(r, y - 0.2, r, y + 0.3 * r), seg, false);
  mlathe(b, cx, cz, prof(ONS, r / 10.6, y + 0.3 * r), seg, false);
  finial(b, cx, cz, y + 0.3 * r + 2.36 * r, r / 4, t0 + 0.02);
}
// chhatri: open octagonal kiosk (base, eight columns, eave, drum, onion dome); s = scale
function chhatri(b, cx, cz, y, s, base, t0) {
  const r = 3.4 * s, mb = base === MARBLE;
  T(b, t0, t0 + 0.03, mb); col(b, base).surface(SURF.POLISH).ao(0.95);
  mlathe(b, cx, cz, P(r + 0.4 * s, y - 0.3, r + 0.4 * s, y + 0.9 * s), 8, true);
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * TAU / 8;
    mlathe(b, cx + Math.cos(a) * (r - 0.35 * s), cz + Math.sin(a) * (r - 0.35 * s), P(0.27 * s, y + 0.9 * s, 0.22 * s, y + 4.9 * s), 5, false);
  }
  T(b, t0 + 0.012, t0 + 0.04, mb); col(b, base, 0.9).ao(0.75);
  mlathe(b, cx, cz, P(r - 0.3 * s, y + 4.85 * s, r + 1.1 * s, y + 5.3 * s), 12, false);
  col(b, base, 1).ao(1);
  mlathe(b, cx, cz, P(r + 1.1 * s, y + 5.3 * s, r + 1.1 * s, y + 5.55 * s, 0.62 * r, y + 6.2 * s), 12, false);
  sdome(b, cx, cz, y + 6.1 * s, 0.62 * r, t0 + 0.02, 12);
}
// irregular octagon in plan (half width w, chamfer c) as walls (+ cap), centred at the origin
const OCT = new Float64Array(16);
function octWalls(b, w, c, y0, y1, cap) {
  const a = w - c, p = [a, w, w, a, w, -a, a, -w, -a, -w, -w, -a, -w, a, -a, w];
  for (let i = 0; i < 16; i++) OCT[i] = p[i];
  for (let i = 0; i < 8; i++) {
    const x0 = OCT[i * 2], z0 = OCT[i * 2 + 1], x1 = OCT[(i * 2 + 2) % 16], z1 = OCT[(i * 2 + 3) % 16];
    let nx = z1 - z0, nz = x0 - x1; if (nx * (x0 + x1) + nz * (z0 + z1) < 0) { nx = -nx; nz = -nz; }
    Q(b, x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, nx, 0, nz);
  }
  if (!cap) return;
  const ci = V(b, 0, y1, 0, 0, 1, 0);
  for (let i = 0; i < 8; i++) b.tri(ci, V(b, OCT[i * 2], y1, OCT[i * 2 + 1], 0, 1, 0), V(b, OCT[(i * 2 + 2) % 16], y1, OCT[(i * 2 + 3) % 16], 0, 1, 0));
}

// ---- small builders -------------------------------------------------------------------------
function figure(b, x, y, z, yaw, pose, c, sd) {
  MM = false; col(b, c).surface(SURF.HIDE).ao(1);
  b.push(); b.at(x, y, z, yaw); b.human(pose, 1.7, sd); b.pop();
}
function cypress(b, x, z, s, t) {
  MM = false; b.timeless().pivot(x, 0, z).appear(t, t + 0.04, MOTION.GROW, 0, BY.BUILT);
  col(b, CYP).surface(SURF.PLAIN).ao(0.95);
  b.push(); b.translate(x, 0, z); b.scale(s, s, s); b.lathe(CYPP, 8); b.pop();
}
function tree(b, x, z, s, sd) {
  b.color(0.18, 0.13, 0.08).surface(SURF.WOOD).ao(0.9);
  b.beam(x, -0.2, z, x, 2.2 * s, z, 0.25 * s, 0.18 * s, 5);
  const g = 0.85 + 0.3 * hsh(sd, 3, 1);
  b.color(0.06 * g, 0.105 * g, 0.04 * g).surface(SURF.PLAIN).ao(0.95);
  b.push(); b.translate(x, 3.4 * s, z); b.rock(2.3 * s, 1.8 * s, 2.3 * s, 2, 0.25, sd, 0, 0.3); b.pop();
}
function palm(b, x, z, h, sd) {
  b.color(0.2, 0.15, 0.1).surface(SURF.WOOD).ao(0.9);
  const lx = (hsh(sd, 1, 2) - 0.5) * 1.6, lz = (hsh(sd, 2, 2) - 0.5) * 1.6;
  b.beam(x, -0.3, z, x + lx, h, z + lz, 0.32, 0.22, 6);
  b.color(0.075, 0.105, 0.035).surface(SURF.PLAIN).ao(0.95);
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8 + hsh(sd, i, 3), L = 3.4 + 0.8 * hsh(sd, i, 4);
    b.beam(x + lx, h, z + lz, x + lx + Math.cos(a) * L, h - 1.1 - 0.6 * hsh(sd, i, 5), z + lz + Math.sin(a) * L, 0.35, 0.05, 3, false);
  }
}

// ---- the parts ------------------------------------------------------------------------------
function tomb(b) {
  b.push(); b.translate(0, 0, TZ);
  // brick core in two storeys: each rises (CLIP) and goes once its marble storey is on
  for (let s = 0; s < 2; s++) {
    const y0 = s ? YS : Y0, y1 = s ? YR : YS;
    C(b, s ? 0.24 : 0.1, s ? 0.38 : 0.24, y0, y1 - y0).vanish(s ? 0.6 : 0.47, s ? 0.605 : 0.475, MOTION.POP, 0, BY.BUILT);
    col(b, BRICK).surface(SURF.STONE).ao(0.9);
    octWalls(b, TW - 0.3, CF - 0.12, y0, y1, true);
  }
  // marble: storeys face by face, the four iwans, cornices, pinnacles
  for (let k = 0; k < 8; k++) {
    const main = (k & 1) === 0, q = k >> 1, a = main ? q * Math.PI / 2 : q * Math.PI / 2 + Math.PI / 4;
    b.push(); b.rotateY(a);
    for (let st = 0; st < 2; st++) {
      const t = (st ? 0.44 : 0.3) + 0.0125 * k, y0 = st ? YS : Y0, y1 = st ? YR : YS;
      const ys = y0 + (st ? 1.0 : 1.6), yk = y0 + (st ? 7.8 : 8.4), ya = y0 + (st ? 11.0 : 11.8);
      T(b, t, t + 0.025, true).surface(SURF.POLISH);
      if (main) for (let sg = -1; sg <= 1; sg += 2) arch(b, TW, sg < 0 ? -19 : 11, sg < 0 ? -11 : 19, y0, y1, 1.0, ys, yk, ya, 2.0, MARBLE, 6);
      else arch(b, FC, -HC, HC, y0, y1, 1.5, ys, yk, ya, 2.2, MARBLE, 6);
      if (st) { // cornice
        col(b, MARBLE, 1.03).ao(0.8);
        if (main) { mbox(b, -15, YR + 0.2, TW + 0.2, 4.05, 0.3, 0.4); mbox(b, 15, YR + 0.2, TW + 0.2, 4.05, 0.3, 0.4); } else mbox(b, 0, YR + 0.2, FC + 0.2, HC + 0.1, 0.3, 0.4);
      }
    }
    if (main) {
      T(b, 0.4 + 0.018 * q, 0.43 + 0.018 * q, true).surface(SURF.POLISH);
      pishtaq(b, TW, 11, Y0, Y0 + PT, 3.5, Y0 + 17, Y0 + 26.5, 5.5, MARBLE, 5.2);
      alfiz(b, TW + 0.7, -7.5, 7.5, Y0 + 1.5, Y0 + 29.6, 0.75, MARBLE, 0.78);
      col(b, MARBLE, 0.3).ao(0.5); // door and lattice window at the back of the iwan
      panel(b, TW + 0.7 - 5.5 + 0.03, -3.4, 3.4, Y0, Y0 + 7.5, Y0 + 10.2, 4);
      col(b, MARBLE, 0.42).ao(0.5);
      panel(b, TW + 0.7 - 5.5 + 0.03, -3.4, 3.4, Y0 + 12, Y0 + 17.5, Y0 + 20, 4);
      // pinnacles at the pishtaq's edges
      T(b, 0.56, 0.58, true); col(b, MARBLE, 1).ao(0.95);
      for (let sg = -1; sg <= 1; sg += 2) mlathe(b, sg * 11.1, TW + 0.75, P(0.55, Y0, 0.55, Y0 + PT + 1.2, 0.8, Y0 + PT + 1.6, 0.35, Y0 + PT + 3.2, 0, Y0 + PT + 4.4), 6, false);
    }
    b.pop();
  }
  // corner pinnacles (guldastas) where the faces meet, and the roof
  T(b, 0.56, 0.6, true).surface(SURF.POLISH); col(b, MARBLE, 1).ao(0.95);
  {
    const a = TW - CF;
    for (let i = 0; i < 8; i++) {
      const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1, sw = i & 4;
      const x = sx * (sw ? TW : a), z = sz * (sw ? a : TW);
      mlathe(b, x, z, P(0.8, Y0, 0.8, YR + 3.0, 1.05, YR + 3.4, 0.5, YR + 4.9, 0, YR + 6.2), 8, false);
    }
    col(b, MARBLE, 0.97).ao(1); octWalls(b, TW - 0.05, CF - 0.02, YR - 0.3, YR - 0.05, true);
  }
  // drum and dome: brick first, then the marble, the dome last (band by band)
  C(b, 0.38, 0.45, YR, DH); col(b, BRICK).surface(SURF.STONE).ao(0.9);
  mlathe(b, 0, 0, P(DR - 0.3, YR - 0.2, DR - 0.3, YD), 24, false);
  C(b, 0.45, 0.62, YD, 25.2); col(b, BRICK, 1.05);
  mlathe(b, 0, 0, prof(ONION, 0.975, YD), 24, false);
  T(b, 0.62, 0.66, true).surface(SURF.POLISH); col(b, MARBLE, 0.98).ao(1);
  mlathe(b, 0, 0, P(DR + 1.2, YR - 0.3, DR + 1.2, YR + 1.0), 32, true);
  col(b, MARBLE).ao(0.95); mlathe(b, 0, 0, P(DR, YR + 1.0, DR, YD - 0.6), 32, false);
  col(b, MARBLE, 1.04).ao(0.8); mlathe(b, 0, 0, P(DR + 0.15, YD - 0.6, DR + 0.6, YD - 0.25, DR + 0.15, YD), 32, false);
  col(b, MARBLE, 0.75).ao(0.6); // band of blind arches round the drum
  for (let i = 0; i < 16; i++) {
    b.push(); b.rotateY(i * TAU / 16);
    panel(b, DR + 0.02, -1.1, 1.1, YR + 2.0, YR + 4.6, YR + 5.6, 2);
    b.pop();
  }
  const band = [0, 3, 6, 9, 13];
  for (let i = 0; i < 4; i++) {
    T(b, 0.7 + 0.04 * i, 0.74 + 0.04 * i, true).surface(SURF.POLISH); col(b, MARBLE).ao(1);
    mlathe(b, 0, 0, prof(ONION, 1, YD), 40, false, band[i], band[i + 1]);
  }
  T(b, 0.86, 0.88, true); col(b, MARBLE, 1.02).ao(0.9); // lotus crown
  mlathe(b, 0, 0, P(0.4, YD + 23.4, 2.4, YD + 23.6, 2.0, YD + 24.4, 0.9, YD + 25.2, 0, YD + 25.5), 16, false);
  b.timeless().appear(0.88, 0.9, MOTION.DROP, 3, BY.BUILT); MM = false;
  col(b, GOLD).surface(SURF.GILT).ao(1);
  mlathe(b, 0, 0, P(0.55, YD + 25.2, 0.95, YD + 25.8, 0.45, YD + 26.4, 0.45, YD + 26.9, 1.05, YD + 27.6, 0.4, YD + 28.4, 0.35, YD + 28.9, 0.8, YD + 29.5, 0.3, YD + 30.2, 0.2, YD + 31.8, 0, YD + 32.2), 10, false);
  b.surface(SURF.POLISH);
  // four kiosks round the dome
  for (let i = 0; i < 4; i++) chhatri(b, (i & 1 ? 1 : -1) * 14.2, (i & 2 ? 1 : -1) * 14.2, YR, 1, MARBLE, 0.64 + 0.015 * i);
  b.pop();
}

function minaret(b, j) {
  const sx = j & 1 ? 1 : -1, sz = j & 2 ? 1 : -1, mx = sx * MXY, mz = TZ + sz * MXY, L = 0.0135 / Math.SQRT2;
  SHX = sx * L; SHZ = sz * L;
  const B = [Y0, Y0 + 12, Y0 + 22.5, Y0 + 31.5], R0 = [2.75, 2.6, 2.45, 2.3];
  for (let s = 0; s < 3; s++) {
    const t = 0.44 + 0.07 * s + 0.012 * j;
    T(b, t, t + 0.03, true).surface(SURF.POLISH); col(b, MARBLE).ao(1);
    if (s === 0) { mlathe(b, mx, mz, P(3.6, Y0 - 0.2, 3.6, Y0 + 2.6), 8, true); }
    mlathe(b, mx, mz, P(R0[s], B[s] + (s ? 0 : 2.6), R0[s + 1], B[s + 1]), 16, false);
    const y = B[s + 1]; // balcony: brackets, platform, parapet
    col(b, MARBLE, 0.95).ao(0.7); mlathe(b, mx, mz, P(R0[s + 1], y - 1.3, 3.6, y), 16, false);
    col(b, MARBLE, 1).ao(1); mlathe(b, mx, mz, P(3.6, y, 3.6, y + 1.0), 16, true);
  }
  T(b, 0.65 + 0.012 * j, 0.68 + 0.012 * j, true); col(b, MARBLE).ao(1);
  mlathe(b, mx, mz, P(2.3, B[3] + 1.0, 2.3, B[3] + 1.6), 16, true);
  chhatri(b, mx, mz, B[3] + 1.6, 0.72, MARBLE, 0.68 + 0.012 * j);
  SHX = 0; SHZ = 0;
}

// hall: mosque (x < 0, the road side) and its twin guest house; front faces the tomb
function hall(b, sg) {
  b.push(); b.translate(sg * 78, 0, TZ); b.rotateY(sg > 0 ? -Math.PI / 2 : Math.PI / 2);
  const top = YT + 12.5, h = top - YT;
  C(b, 0.14, 0.42, YT, 18).surface(SURF.STONE);
  arch(b, 10, -26, -16.5, YT, top, 1.4, YT, YT + 6.8, YT + 10.2, 2.4, RED, 6);
  arch(b, 10, -16.5, -7.5, YT, top, 1.4, YT, YT + 6.8, YT + 10.2, 2.4, RED, 6);
  arch(b, 10, 7.5, 16.5, YT, top, 1.4, YT, YT + 6.8, YT + 10.2, 2.4, RED, 6);
  arch(b, 10, 16.5, 26, YT, top, 1.4, YT, YT + 6.8, YT + 10.2, 2.4, RED, 6);
  pishtaq(b, 10, 7.5, YT, YT + 17, 2.3, YT + 9, YT + 14.2, 4, RED, 5);
  col(b, MARBLE, 0.95); MM = false;
  alfiz(b, 10.7, -5.2, 5.2, YT + 1, YT + 15.6, 0.4, MARBLE, 0.95);
  col(b, RED, 0.97).ao(1); // back, ends, roof
  Q(b, -26, YT, -10, 26, YT, -10, 26, top, -10, -26, top, -10, 0, 0, -1);
  Q(b, -26, YT, -10, -26, YT, 10, -26, top, 10, -26, top, -10, -1, 0, 0);
  Q(b, 26, YT, -10, 26, YT, 10, 26, top, 10, 26, top, -10, 1, 0, 0);
  flat(b, -26, -10, 26, 10, top);
  col(b, RED, 0.62).ao(0.55);
  b.push(); b.rotateY(Math.PI);
  for (let i = 0; i < 7; i++) panel(b, 10.03, -24 + i * 7, -19.5 + i * 7, YT + 1.2, YT + 7.5, YT + 10, 4);
  b.pop();
  col(b, MARBLE, 0.95).ao(1); mbox(b, 0, top + 0.25, 0, 26.3, 0.25, 10.3); // marble coping
  // turrets at the corners
  col(b, RED).ao(1);
  for (let i = 0; i < 4; i++) mlathe(b, (i & 1 ? 1 : -1) * 25.4, (i & 2 ? 1 : -1) * 9.4, P(1.7, YT, 1.7, top + 3.2), 8, true);
  for (let i = 0; i < 4; i++) sdome(b, (i & 1 ? 1 : -1) * 25.4, (i & 2 ? 1 : -1) * 9.4, top + 3.2, 1.5, 0.5 + 0.01 * i, 10);
  // three white domes on drums
  for (let i = -1; i <= 1; i++) sdome(b, i * 13.5, 0, top + 0.4, i ? 3.6 : 4.5, 0.44 + 0.03 * (i + 1), 20);
  b.pop();
}

function gateway(b) {
  b.push(); b.translate(0, 0, GZ);
  const top = 22;
  for (let f = 0; f < 2; f++) {
    b.push(); b.rotateY(f * Math.PI);
    C(b, 0.2, 0.55, 0, 27).surface(SURF.STONE);
    for (let sg = -1; sg <= 1; sg += 2) {
      const u0 = sg < 0 ? -16.5 : 9, u1 = sg < 0 ? -9 : 16.5;
      arch(b, 9, u0, u1, 0, 11, 1.1, 0.8, 6.6, 9.3, 1.8, RED, 6);
      arch(b, 9, u0, u1, 11, top, 1.1, 12, 17.4, 20.2, 1.8, RED, 6);
    }
    pishtaq(b, 9, 9, 0, 26, 2.6, 13, 20.6, 5, RED, 5);
    MM = false; alfiz(b, 9.7, -6.4, 6.4, 0.5, 24.6, 0.55, MARBLE, 0.95);
    for (let i = 0; i < 11; i++) sdome(b, -8 + i * 1.6, 8.6, 26.35, 0.62, 0.55 + 0.004 * i, 8);
    b.pop();
  }
  C(b, 0.2, 0.55, 0, 27); col(b, RED, 0.95).ao(1);
  for (let sg = -1; sg <= 1; sg += 2) Q(b, sg * 16.5, 0, -9, sg * 16.5, 0, 9, sg * 16.5, top, 9, sg * 16.5, top, -9, sg, 0, 0);
  flat(b, -16.5, -9, 16.5, 9, top);
  for (let i = 0; i < 4; i++) {
    const x = (i & 1 ? 1 : -1) * 17.6, z = (i & 2 ? 1 : -1) * 8.4;
    C(b, 0.2, 0.55, 0, 27); col(b, RED).surface(SURF.STONE).ao(1);
    mlathe(b, x, z, P(3.2, -0.2, 3.2, 25), 8, true);
    col(b, MARBLE, 0.95); mlathe(b, x, z, P(3.25, 24.2, 3.25, 24.6), 8, false);
    chhatri(b, x, z, 25, 0.6, RED, 0.56 + 0.01 * i);
  }
  b.pop();
}

function garden(b) {
  const t0 = 0.9;
  // garden walls and corner pavilions (rise early)
  C(b, 0.06, 0.22, 0, 4).surface(SURF.STONE); col(b, RED).ao(1);
  for (let sg = -1; sg <= 1; sg += 2) {
    mbox(b, sg * WX, 1.6, (2 + GZ - 9) / 2, 0.6, 1.9, (GZ - 9 - 2) / 2);
    mbox(b, sg * (20.5 + WX) / 2, 1.6, GZ, (WX - 20.5) / 2, 1.9, 0.6);
  }
  for (let sg = -1; sg <= 1; sg += 2) {
    C(b, 0.1, 0.25, 0, 8); col(b, RED).ao(1);
    mlathe(b, sg * WX, GZ, P(4, -0.2, 4, 7), 8, true);
    sdome(b, sg * WX, GZ, 7, 2.8, 0.3, 12);
  }
  // paths
  b.timeless().appear(t0, t0 + 0.02, MOTION.POP, 0, BY.BUILT); MM = false;
  col(b, PATH).surface(SURF.STONE).ao(1);
  const xm = (PW + 8 + WX - 5) / 2, zf = (6 + KZ - 6.2) / 2, zb = (KZ + 6.2 + GZ - 13) / 2;
  for (let sg = -1; sg <= 1; sg += 2) {
    const s = (a, c) => (sg < 0 ? -c : a), e = (a, c) => (sg < 0 ? -a : c);
    flat(b, s(PW + 0.6, PW + 4.6), PZ0 - 3, e(PW + 0.6, PW + 4.6), PZ1 + 3, 0.1);
    flat(b, s(10, WX - 5), KZ - 6.2, e(10, WX - 5), KZ - 2.8, 0.1);
    flat(b, s(10, WX - 5), KZ + 2.8, e(10, WX - 5), KZ + 6.2, 0.1);
    flat(b, s(WX - 5, WX - 0.6), 2, e(WX - 5, WX - 0.6), GZ - 0.6, 0.1);
    flat(b, s(xm - 1.3, xm + 1.3), 6, e(xm - 1.3, xm + 1.3), GZ - 13, 0.1);
  }
  flat(b, -WX + 0.6, GZ - 13, WX - 0.6, GZ - 0.6, 0.1);
  flat(b, -WX + 0.6, 1.5, WX - 0.6, 6, 0.1);
  for (const z of [zf, zb]) flat(b, -WX + 5, z - 1.3, WX - 5, z + 1.3, 0.1);
  // beds: lawns, fading in
  b.timeless().appear(t0 + 0.01, t0 + 0.06, MOTION.FADE, 0, BY.BUILT);
  col(b, LAWN).surface(SURF.EARTH).ao(1);
  for (let sg = -1; sg <= 1; sg += 2) {
    const lo = (v) => sg < 0 ? -v : v;
    flat(b, lo(PW + 4.6), PZ0 - 3, lo(PW + 8), PZ1 + 3, 0.07);
    for (const [z0, z1] of [[6, KZ - 6.2], [KZ + 6.2, GZ - 13]]) {
      const zc = (z0 + z1) / 2;
      for (const [x0, x1] of [[PW + 8, xm - 1.3], [xm + 1.3, WX - 5]]) {
        flat(b, lo(x0), z0, lo(x1), zc - 1.3, 0.07); flat(b, lo(x0), zc + 1.3, lo(x1), z1, 0.07);
      }
    }
  }
  // the pool: marble coping, the central raised tank, the cross canal
  T(b, t0, t0 + 0.03, true).surface(SURF.POLISH); col(b, MARBLE, 1).ao(1);
  for (const [z0, z1] of [[PZ0, KZ - 10], [KZ + 10, PZ1]]) {
    const zc = (z0 + z1) / 2, hz = (z1 - z0) / 2;
    mbox(b, -PW - 0.3, 0.18, zc, 0.3, 0.2, hz); mbox(b, PW + 0.3, 0.18, zc, 0.3, 0.2, hz);
  }
  mbox(b, 0, 0.18, PZ0 - 0.3, PW + 0.6, 0.2, 0.3); mbox(b, 0, 0.18, PZ1 + 0.3, PW + 0.6, 0.2, 0.3);
  for (let sg = -1; sg <= 1; sg += 2) {
    const xc = sg * (10 + WX - 6) / 2, hx = (WX - 16) / 2;
    mbox(b, xc, 0.18, KZ - 2.5, hx, 0.2, 0.3); mbox(b, xc, 0.18, KZ + 2.5, hx, 0.2, 0.3);
    mbox(b, sg * (WX - 5.7), 0.18, KZ, 0.3, 0.2, 2.2);
  }
  col(b, MARBLE, 0.96); mbox(b, 0, 0.7, KZ, 10, 0.75, 10);
  col(b, MARBLE, 1.03);
  mbox(b, 0, 1.6, KZ - 6.8, 7.1, 0.2, 0.3); mbox(b, 0, 1.6, KZ + 6.8, 7.1, 0.2, 0.3);
  mbox(b, -6.8, 1.6, KZ, 0.3, 0.2, 6.5); mbox(b, 6.8, 1.6, KZ, 0.3, 0.2, 6.5);
  mbox(b, 0, 2.0, KZ, 0.9, 0.6, 0.9); // fountain pedestal
  // water: a pale sky mirror (GILT: sky reflection tinted)
  b.timeless().appear(t0 + 0.03, t0 + 0.05, MOTION.POP, 0, BY.BUILT); MM = false;
  col(b, POOL).surface(SURF.GILT).ao(1);
  flat(b, -PW, PZ0, PW, KZ - 10, 0.26); flat(b, -PW, KZ + 10, PW, PZ1, 0.26);
  flat(b, -6.5, KZ - 6.5, 6.5, KZ + 6.5, 1.55);
  for (let sg = -1; sg <= 1; sg += 2) flat(b, sg * 10, KZ - 2.2, sg * (WX - 6), KZ + 2.2, 0.26);
  b.surface(SURF.PLAIN);
  // cypresses along the pool and the cross canal; fruit trees in the beds
  let n = 0;
  for (let z = PZ0 + 3; z < PZ1 - 1; z += 6) {
    if (Math.abs(z - KZ) < 13) continue;
    for (let sg = -1; sg <= 1; sg += 2) cypress(b, sg * (PW + 6.3), z, 0.92 + 0.12 * hsh(n, 7, 1), t0 + 0.02 + 0.0012 * n++);
  }
  for (let x = 17; x < WX - 8; x += 7.5) for (let sg = -1; sg <= 1; sg += 2) for (let e = -1; e <= 1; e += 2) cypress(b, sg * x, KZ + e * 8, 0.85 + 0.1 * hsh(n, 7, 2), t0 + 0.02 + 0.0012 * n++);
  for (let i = 0; i < 16; i++) {
    const sg = i & 1 ? 1 : -1, xi = (i >> 1) & 1, zi = i >> 2;
    const x = sg * (xi ? (xm + WX - 5) / 2 + 1.5 : (PW + 8 + xm) / 2), z = [16, 40, 74, 98][zi] + (hsh(i, 5, 5) - 0.5) * 6;
    b.timeless().pivot(x, 0, z).appear(t0 + 0.02, t0 + 0.07, MOTION.GROW, 0, BY.BUILT); MM = false;
    tree(b, x, z, 1 + 0.25 * hsh(i, 5, 6), i * 7 + 3);
  }
}

// earth ramp up the axis to the top of the walls, with blocks being hauled up it
const HX = new Float64Array(24);
function ramp(b, sd) {
  const zt = TZ + TW - 0.3, z0 = 100, yt = YR;
  b.timeless().pivot(0, 0, 0).reach(yt).appear(0.08, 0.42, MOTION.CLIP, 0, BY.BUILT).vanish(0.84, 0.9, MOTION.CLIP, 0, BY.BUILT);
  MM = false; col(b, EARTH).surface(SURF.EARTH).ao(1);
  HX.set([-12, -0.3, zt, 12, -0.3, zt, 6, -0.3, z0 + 2, -6, -0.3, z0 + 2, -4.5, yt, zt, 4.5, yt, zt, 4.5, 0.15, z0, -4.5, 0.15, z0]);
  b.hexa(HX, false);
  const yOn = (z) => yt * (z0 - z) / (z0 - zt);
  for (let g = 0; g < 3; g++) {
    const z = 76 - g * 34, y = yOn(z), t = 0.08 + 0.34 * (y / yt) + 0.012;
    b.timeless().appear(t, t + 0.01, MOTION.POP, 0, BY.BUILT).vanish(0.8, 0.84, MOTION.FADE, 0, BY.BUILT);
    col(b, MARBLE, 0.95).surface(SURF.STONE).ao(0.9);
    b.box(0, y + 0.75, z + 1.5, 1.1, 0.75, 1.6, false);
    for (let i = 0; i < 3; i++) figure(b, (i - 1) * 1.1, yOn(z - 3 - i * 1.5) + 0.05, z - 3 - i * 1.5, Math.PI, POSE.HAUL, ROBES[(i + g) % 5], sd + g * 7 + i);
  }
}

function scaffolds(b) {
  MM = false;
  // round the walls: poles and ledgers, growing with the brick
  b.timeless().pivot(0, Y0, 0).appear(0.1, 0.38, MOTION.GROW, 0, BY.BUILT).vanish(0.6, 0.66, MOTION.GROW, 0, BY.BUILT);
  col(b, TIMBER).surface(SURF.WOOD).ao(0.95);
  b.push(); b.translate(0, 0, TZ);
  for (let k = 0; k < 8; k++) {
    const main = (k & 1) === 0, F = (main ? TW : FC) + 1.6, hl = main ? 19 : HC;
    b.push(); b.rotateY(main ? (k >> 1) * Math.PI / 2 : (k >> 1) * Math.PI / 2 + Math.PI / 4);
    const n = main ? 9 : 3;
    for (let i = 0; i < n; i++) { const u = -hl + 2 * hl * (i + 0.5) / n; if (main && Math.abs(u) < 5 && k === 0) continue; b.beam(u, Y0, F, u, YR + 2, F, 0.1, 0.1, 4, false); }
    for (let y = Y0 + 3; y < YR + 1; y += 3.4) b.beam(-hl, y, F, hl, y, F, 0.08, 0.08, 4, false);
    b.pop();
  }
  // round the drum and dome
  b.timeless().pivot(0, YR, 0).appear(0.4, 0.62, MOTION.GROW, 0, BY.BUILT).vanish(0.88, 0.92, MOTION.GROW, 0, BY.BUILT);
  for (let i = 0; i < 16; i++) {
    const a = i * TAU / 16, a1 = (i + 1) * TAU / 16;
    b.beam(Math.cos(a) * 15, YR, Math.sin(a) * 15, Math.cos(a) * 15, YR + 20, Math.sin(a) * 15, 0.11, 0.1, 4, false);
    b.beam(Math.cos(a) * 15, YR + 20, Math.sin(a) * 15, Math.cos(a) * 7, YR + 31, Math.sin(a) * 7, 0.1, 0.09, 4, false);
    for (let y = 4; y < 30; y += 4.5) {
      const r = y <= 20 ? 15 : 15 - 8 * (y - 20) / 11;
      b.beam(Math.cos(a) * r, YR + y, Math.sin(a) * r, Math.cos(a1) * r, YR + y, Math.sin(a1) * r, 0.07, 0.07, 3, false);
    }
  }
  b.pop();
  // round each minaret
  for (let j = 0; j < 4; j++) {
    const mx = (j & 1 ? 1 : -1) * MXY, mz = TZ + (j & 2 ? 1 : -1) * MXY;
    b.timeless().pivot(mx, Y0, mz).appear(0.42, 0.66, MOTION.GROW, 0, BY.BUILT).vanish(0.74, 0.8, MOTION.GROW, 0, BY.BUILT);
    for (let i = 0; i < 6; i++) { const a = i * TAU / 6; b.beam(mx + Math.cos(a) * 4.8, Y0, mz + Math.sin(a) * 4.8, mx + Math.cos(a) * 4.4, Y0 + 41, mz + Math.sin(a) * 4.4, 0.09, 0.08, 4, false); }
    for (let y = Y0 + 5; y < Y0 + 40; y += 5) for (let i = 0; i < 6; i++) { const a = i * TAU / 6, c = (i + 1) * TAU / 6; b.beam(mx + Math.cos(a) * 4.7, y, mz + Math.sin(a) * 4.7, mx + Math.cos(c) * 4.7, y, mz + Math.sin(c) * 4.7, 0.06, 0.06, 3, false); }
  }
}

function worksite(b, sd) {
  MM = false;
  // brick stacks and marble blocks used up as the work goes on
  const BS = [[-62, -12], [62, -18], [-58, 18], [58, 22], [-30, 30], [32, 34], [-64, -84], [64, -90]];
  for (let i = 0; i < BS.length; i++) {
    const t = 0.18 + 0.06 * i;
    b.timeless().vanish(t, t + 0.05, MOTION.RISE, 2, BY.BUILT);
    col(b, BRICK, 0.9 + 0.2 * hsh(sd, i, 1)).surface(SURF.STONE).ao(0.85);
    for (let k = 0; k < 4; k++) b.box(BS[i][0] + (k & 1) * 3.2, 0.7 + (BS[i][1] < 0 ? YT : 0), BS[i][1] + (k >> 1) * 2.6, 1.4, 0.9, 1.1, false);
  }
  const MB = [[-44, 50], [46, 48], [-72, 44], [70, 66], [-24, 70], [26, 84]];
  for (let i = 0; i < MB.length; i++) {
    const t = 0.32 + 0.08 * i;
    b.timeless().vanish(t, t + 0.05, MOTION.RISE, 2, BY.BUILT);
    col(b, MARBLE, 0.92 + 0.1 * hsh(sd, i, 2)).surface(SURF.STONE).ao(0.9);
    for (let k = 0; k < 5; k++) b.box(MB[i][0] + (k % 3) * 2.4, k > 2 ? 2.1 : 0.7, MB[i][1] + (k > 2 ? 1.2 : 0), 1.05, 0.7, 1.3, false);
  }
  // workers
  const WK = [[-58, -6, POSE.KNEEL, 1.2], [-56, 22, POSE.STAND, 2.0], [60, -12, POSE.HAUL, -1.6], [56, 28, POSE.KNEEL, -2.2], [-42, 46, POSE.KNEEL, 0.4],
    [44, 52, POSE.STAND, -0.6], [-20, 64, POSE.WALK, 2.6], [22, 80, POSE.HAUL, 3.0], [-50, -40, POSE.STAND, 1.5], [50, -62, POSE.WALK, -1.4], [-12, 104, POSE.STAND, 3.1], [14, 106, POSE.WALK, 3.4]];
  for (let i = 0; i < WK.length; i++) {
    b.timeless().vanish(0.9 + 0.004 * i, 0.94 + 0.004 * i, MOTION.FADE, 0, BY.BUILT);
    figure(b, WK[i][0], WK[i][1] < 0 ? YT : 0, WK[i][1], WK[i][3], WK[i][2], ROBES[i % 5], sd + 40 + i);
  }
  // visitors once it is finished
  const VS = [[-12, 46, 0.4], [-13.2, 47.1, 0.6], [13, 70, -2.6], [7, 30, 3.0], [-8, 92, 2.8]];
  for (let i = 0; i < VS.length; i++) {
    b.timeless().appear(0.96 + 0.006 * i, 0.99, MOTION.FADE, 0, BY.BUILT);
    figure(b, VS[i][0], 0.1, VS[i][1], VS[i][2], i === 3 ? POSE.SIT : POSE.STAND, ROBES[(i + 2) % 5], sd + 80 + i);
  }
}

function river(b) {
  b.timeless(); MM = false;
  const zr = (x) => -113 - 2.5 * noise3(x * 0.03, 1.7, 0.3);
  const zf = (x) => -Math.sqrt(Math.max(0, 152 * 152 - x * x));
  for (let x = -100; x < 100; x += 10) {
    const x1 = x + 10;
    // reed fringe, then water
    col(b, [0.1, 0.13, 0.05]).surface(SURF.THATCH).ao(1);
    Q(b, x, 0.03, zr(x) + 3.5, x1, 0.03, zr(x1) + 3.5, x1, 0.03, zr(x1), x, 0.03, zr(x), 0, 1, 0);
    if (zf(x) < zr(x) - 1 || zf(x1) < zr(x1) - 1) {
      col(b, RIVER).surface(SURF.GILT).ao(1);
      Q(b, x, 0.05, zr(x), x1, 0.05, zr(x1), x1, 0.05, Math.min(zf(x1), zr(x1)), x, 0.05, Math.min(zf(x), zr(x)), 0, 1, 0);
    }
  }
  b.surface(SURF.PLAIN);
}

export default {
  id: 'taj-mahal',
  name: 'Taj Mahal',
  caption: 'Shah Jahan completes the Taj Mahal at Agra',
  year: 1653,
  radius: R,
  pad: R + 2,
  roadOffset: 165, // corridor edge 158.5 m out; nothing west of x = -152
  straddlesRoad: false,
  biome: 'desert',
  live: true,
  lights: [],
  detail: { at: [0, 36, TZ], from: [0, 9, 100] },
  strip: { at: [0, 30, TZ + 10], from: [-130, 26, 160], fov: 0.55 },
  // Event moment: just inside the gateway on the axis, the frontal view down the pool
  // (eye low, 8 m, so the whole pool runs from the bottom of the frame to the plinth; the lens
  // wide enough that the finial clears the letterbox even after the push-in)
  witness: { at: [0, TZ], look: 14.9, dist: 158, height: 8, az: Math.PI / 2, fov: 0.98, drift: 0.02 },
  // Agra round it: older red sandstone tombs with white domes, riverside villages with palms
  satellites: {
    count: [6, 8], near: 2, nearR: [200, 320], farR: [380, 1000],
    centre: 0.3, spread: 4.2, minSep: 90, roadClear: 45,
    build(b, k, n, dist) {
      const s = 1 + 1.2 * Math.min(1, dist / 900);
      MM = false; SHX = 0; SHZ = 0;
      b.timeless().appear(0.04 + 0.4 * k / n, 0.12 + 0.4 * k / n, MOTION.RISE, 4 * s, BY.BUILT);
      if (k === 0 || k === 3) { // a tomb on a terrace: red sandstone with a white dome and kiosks
        col(b, RED, 1.1).surface(SURF.STONE).ao(1);
        b.box(0, 0.4, 0, 20 * s, 1.4, 20 * s, false);
        b.box(0, 1.8 + 5 * s, 0, 10 * s, 5 * s, 10 * s, false);
        col(b, MARBLE, 0.8).ao(0.5);
        for (let i = 0; i < 4; i++) { b.push(); b.rotateY(i * Math.PI / 2); panel(b, 10 * s + 0.05, -2.6 * s, 2.6 * s, 1.8, 1.8 + 5 * s, 1.8 + 7.5 * s, 2); b.pop(); }
        col(b, MARBLE, 0.97).surface(SURF.POLISH).ao(1);
        mlathe(b, 0, 0, P(5.4 * s, 1.8 + 9.5 * s, 5.4 * s, 1.8 + 11 * s), 12, false);
        mlathe(b, 0, 0, prof(ONS, 5.4 * s / 10.6, 1.8 + 11 * s), 14, false);
        for (let i = 0; i < 4; i++) { const x = (i & 1 ? 1 : -1) * 8 * s, z = (i & 2 ? 1 : -1) * 8 * s; mlathe(b, x, z, P(1.6 * s, 1.8 + 10 * s, 1.6 * s, 1.8 + 10.6 * s), 8, false); mlathe(b, x, z, prof(ONS, 1.6 * s / 10.6, 1.8 + 10.6 * s), 8, false); }
        for (let i = 0; i < 3; i++) { const a = b.rand() * TAU; palm(b, Math.cos(a) * 26 * s, Math.sin(a) * 26 * s, 9 + 3 * b.rand(), k * 9 + i); }
        return;
      }
      const m = 3 + (b.rand() * 3 | 0);
      for (let i = 0; i < m; i++) {
        const a = b.rand() * TAU, r = i === 0 ? 0 : 6 + 8 * b.rand();
        const w = (2.4 + 1.6 * b.rand()) * s, d = (2.2 + 1.4 * b.rand()) * s, h = (2.6 + 1.2 * b.rand()) * s, g = 0.9 + 0.15 * b.rand();
        b.push(); b.at(Math.cos(a) * r * s, 0, Math.sin(a) * r * s, b.rand() * 3);
        b.color(0.5 * g, 0.36 * g, 0.23 * g).surface(SURF.PLASTER).ao(1);
        b.box(0, h / 2 - 0.4, 0, w, h / 2 + 0.4, d, false);
        b.color(0.4 * g, 0.29 * g, 0.18 * g); b.box(0, h + 0.2, 0, w + 0.15, 0.25, d + 0.15, false);
        b.pop();
      }
      for (let i = 0; i < 3; i++) { const a = b.rand() * TAU; palm(b, Math.cos(a) * 16 * s, Math.sin(a) * 16 * s, (8 + 3 * b.rand()) * Math.min(1.5, s), k * 11 + i); }
      if (k === 1) sdome(b, 0, 9 * s, 0, 2.6 * s, 0.05, 12); // a small white shrine
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 37 + 11;
    MM = false; SHX = 0; SHZ = 0;
    // riverfront terrace and plinth
    C(b, 0, 0.05, -0.6, YT + 0.6).surface(SURF.STONE); col(b, RED, 1.05).ao(1);
    b.box(0, (YT - 0.6) / 2, TZ, 96, (YT + 0.6) / 2, 52, false);
    col(b, PATH, 1.1); b.box(0, YT + 0.02, TZ, 95.5, 0.04, 51.5, false);
    C(b, 0.03, 0.1, YT, Y0 - YT); col(b, BRICK).surface(SURF.STONE).ao(0.9);
    b.box(0, (YT + Y0) / 2, TZ, PL - 0.25, (Y0 - YT) / 2, PL - 0.25, false);
    b.push(); b.translate(0, 0, TZ);
    for (let k = 0; k < 4; k++) {
      b.push(); b.rotateY(k * Math.PI / 2);
      T(b, 0.1 + 0.01 * k, 0.13 + 0.01 * k, true).surface(SURF.POLISH); col(b, MARBLE, 0.95).ao(1);
      FQ(b, -PL, YT - 0.1, PL, YT + 3, PL);
      T(b, 0.14 + 0.01 * k, 0.17 + 0.01 * k, true); col(b, MARBLE, 0.97);
      FQ(b, -PL, YT + 3, PL, Y0, PL);
      col(b, MARBLE, 1.03).ao(0.85); mbox(b, 0, Y0 - 0.2, PL, PL + 0.3, 0.2, 0.3);
      col(b, MARBLE, 0.7).ao(0.55);
      for (let i = 0; i < 15; i++) panel(b, PL + 0.03, -36 + i * 4.8 + 0.65, -36 + i * 4.8 + 4.15, YT + 0.9, YT + 3.7, YT + 5.1, 4);
      b.pop();
    }
    T(b, 0.18, 0.19, true); col(b, MARBLE, 0.98).ao(1);
    flat(b, -PL, -PL, PL, PL, Y0);
    b.pop();
    yield;
    tomb(b);
    yield;
    for (let j = 0; j < 4; j++) minaret(b, j);
    yield;
    hall(b, -1); hall(b, 1);
    gateway(b);
    yield;
    garden(b);
    ramp(b, sd);
    scaffolds(b);
    worksite(b, sd);
    yield;
    river(b);
    b.timeless(); MM = false;
    const PAL = [[-112, -92], [-104, -78], [110, -92], [122, -74], [-104, 30], [104, 26], [-108, 70], [110, 96], [-60, -108], [64, -108]];
    for (let i = 0; i < PAL.length; i++) palm(b, PAL[i][0], PAL[i][1], 9 + 4 * hsh(sd, i, 9), sd + i * 3);
    b.timeless(); MM = false;
    return b.counts();
  },
};
