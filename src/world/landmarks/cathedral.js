// Gothic cathedral (event 7, 1163-1345), in the manner of Notre-Dame de Paris, standing over
// the roofs of a small medieval town in a forest clearing. Contract: internal_docs/LANDMARKS.md.
//
// Live landmark: one build holds the whole timeline; setState(built, decay) animates it.
// built, in the real order of work (CLIP: walls rise course by course):
//   0.00  the old church, the town, a levelled foundation platform, stone piles, masons
//   0.02-0.30  choir and polygonal apse, their aisles, flyers, then the choir roof
//   0.26-0.62  transept, then the nave and its aisles, the flying buttresses one bay after
//              another, the nave roof; the old church is pulled down (0.54-0.6)
//   0.58-0.86  the west front (portals, gallery of kings, rose), then the twin towers
//   0.87-0.96  the spire over the crossing; 0.9-0.99 scaffolds struck, piles and crews go
//   Timber scaffolds climb with each section; two treadwheel cranes (rigs 1, 2) ride the
//   wall tops of whatever is being built (animate).
// decay (0 -> 0.3 over 1914-2026): soot and weathering spread over the stone face by face
//   (REVEAL overlays, ragged fronts running down from the tops); it stays standing.
//
// Layout: the cathedral is built in a "C frame" (x across, z along the axis, west front at
// +z, apse at -z) centred at (CX, CZ) and turned PSI so the approaching driver sees the west
// front and the long buttressed flank together (the classic view from the south-west).

import { SURF, POSE, MOTION, BY, fbm3, noise3, seg } from './kit.js';

const CX = 20, CZ = -12, PSI = 0.5;
const CP = Math.cos(PSI), SP = Math.sin(PSI);
const NW = 6.5, EAVE = 33, RIDGE = 45, AW = 17, AH = 11.5, AR = 20; // vessel, aisles
const NZ0 = 6.5, NZ1 = 47; // nave (crossing to the west front)
const KZ0 = -40, KZ1 = -6.5; // choir; the apse is centred at (0, KZ0)
const TR = 24; // transept arm ends
const WZ0 = 47, WZ1 = 60, WX = 21, WH = 43, TX0 = 7.5, TH = 69.5; // west front, towers
const SPH = 93; // spire tip

// timeline (built)
const T_CH0 = 0.02, T_CH1 = 0.22, T_TR0 = 0.26, T_TR1 = 0.44, T_NV0 = 0.3, T_NV1 = 0.5;
const T_WF0 = 0.58, T_WF1 = 0.72, T_TW1 = 0.86, T_SP0 = 0.87, T_SP1 = 0.96;

function hsh(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const lerp = (a, b, t) => a + (b - a) * t;

// --- base colour and quads ---------------------------------------------------------------
let BR = 0.4, BG = 0.36, BB = 0.3;
const STN = new Float64Array([0.4, 0.37, 0.3]), LEAD = new Float64Array([0.12, 0.13, 0.155]);
function base(c, f = 1) { BR = c[0] * f; BG = c[1] * f; BB = c[2] * f; }
function baseRGB(r, g, bl) { BR = r; BG = g; BB = bl; }
const Q = new Float64Array(12);
function setQ(i, x, y, z) { Q[i * 3] = x; Q[i * 3 + 1] = y; Q[i * 3 + 2] = z; }
// quad Q0..Q3 with a given normal; corners 0, 1 take colour x f0, corners 2, 3 x f1
function qd(b, nx, ny, nz, f0, f1) {
  b.color(BR * f0, BG * f0, BB * f0);
  const i0 = b.vertex(Q[0], Q[1], Q[2], nx, ny, nz), i1 = b.vertex(Q[3], Q[4], Q[5], nx, ny, nz);
  b.color(BR * f1, BG * f1, BB * f1);
  const i2 = b.vertex(Q[6], Q[7], Q[8], nx, ny, nz), i3 = b.vertex(Q[9], Q[10], Q[11], nx, ny, nz);
  b.quad(i0, i1, i2, i3);
}
// face normal from the corners (n = 3: triangle Q0..Q2), turned toward (rx, ry, rz)
function qa(b, n, rx, ry, rz, f0, f1) {
  let ax, ay, az, bx, by, bz;
  if (n === 4) { ax = Q[6] - Q[0]; ay = Q[7] - Q[1]; az = Q[8] - Q[2]; bx = Q[9] - Q[3]; by = Q[10] - Q[4]; bz = Q[11] - Q[5]; }
  else { ax = Q[3] - Q[0]; ay = Q[4] - Q[1]; az = Q[5] - Q[2]; bx = Q[6] - Q[0]; by = Q[7] - Q[1]; bz = Q[8] - Q[2]; }
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  if (n === 4) { qd(b, nx, ny, nz, f0, f1); return; }
  b.color(BR * f0, BG * f0, BB * f0);
  const i0 = b.vertex(Q[0], Q[1], Q[2], nx, ny, nz), i1 = b.vertex(Q[3], Q[4], Q[5], nx, ny, nz);
  b.color(BR * f1, BG * f1, BB * f1);
  b.tri(i0, i1, b.vertex(Q[6], Q[7], Q[8], nx, ny, nz));
}

// --- soot faces: recorded while the walls are drawn, emitted at the end as REVEAL overlays
const MAXS = 400, SOOT = new Float64Array(MAXS * 8);
let NS = 0;
function addSoot(x0, z0, x1, z1, y0, y1, nx, nz) {
  if (NS >= MAXS) return;
  const o = NS++ * 8;
  SOOT[o] = x0; SOOT[o + 1] = z0; SOOT[o + 2] = x1; SOOT[o + 3] = z1; SOOT[o + 4] = y0; SOOT[o + 5] = y1; SOOT[o + 6] = nx; SOOT[o + 7] = nz;
}
// vertical wall face from (x0, z0) to (x1, z1), outward normal (nx, nz); darker at the foot
function wall(b, x0, z0, x1, z1, y0, y1, nx, nz, soot) {
  setQ(0, x0, y0, z0); setQ(1, x1, y0, z1); setQ(2, x1, y1, z1); setQ(3, x0, y1, z0);
  qd(b, nx, 0, nz, 0.8, 1);
  if (soot) addSoot(x0, z0, x1, z1, y0, y1, nx, nz);
}
// box with gradient sides; sm: soot mask (1 +z, 2 -z, 4 +x, 8 -x)
function slab(b, x0, x1, y0, y1, z0, z1, sm = 0, top = true) {
  wall(b, x0, z1, x1, z1, y0, y1, 0, 1, sm & 1);
  wall(b, x1, z0, x0, z0, y0, y1, 0, -1, sm & 2);
  wall(b, x1, z1, x1, z0, y0, y1, 1, 0, sm & 4);
  wall(b, x0, z0, x0, z1, y0, y1, -1, 0, sm & 8);
  if (top) { setQ(0, x0, y1, z0); setQ(1, x1, y1, z0); setQ(2, x1, y1, z1); setQ(3, x0, y1, z1); qd(b, 0, 1, 0, 0.93, 0.93); }
}
// pinnacle: tapered spirelet on top of a pier
function pinnacle(b, x, y, z, r, h) {
  b.push(); b.translate(x, y, z); b.block(r, r, r * 0.8, r * 0.8, h * 0.25); b.translate(0, h * 0.25, 0); b.block(r * 0.8, r * 0.8, 0.04, 0.04, h * 0.75); b.pop();
}
// pitched roof along z (eave half-width w at y e, ridge r), gables at the ends if g0 / g1
function roofZ(b, z0, z1, w, e, r, g0, g1) {
  lead(b);
  for (let s = -1; s <= 1; s += 2) {
    setQ(0, s * w, e, z0); setQ(1, s * w, e, z1); setQ(2, 0, r, z1); setQ(3, 0, r, z0);
    qa(b, 4, s, 0.5, 0, 0.82, 1.12);
  }
  b.color(BR * 1.1, BG * 1.1, BB * 1.1); b.beam(0, r, z0, 0, r, z1, 0.25, 0.25, 4, false); // ridge cresting
  base(STN); b.surface(SURF.STONE);
  if (g0) { setQ(0, -w, e, z0); setQ(1, w, e, z0); setQ(2, 0, r, z0); qa(b, 3, 0, 0, -1, 1, 1); }
  if (g1) { setQ(0, -w, e, z1); setQ(1, w, e, z1); setQ(2, 0, r, z1); qa(b, 3, 0, 0, 1, 1, 1); }
}
function roofX(b, x0, x1, w, e, r, g0, g1) {
  lead(b);
  for (let s = -1; s <= 1; s += 2) {
    setQ(0, x0, e, s * w); setQ(1, x1, e, s * w); setQ(2, x1, r, 0); setQ(3, x0, r, 0);
    qa(b, 4, 0, 0.5, s, 0.82, 1.12);
  }
  b.color(BR * 1.1, BG * 1.1, BB * 1.1); b.beam(x0, r, 0, x1, r, 0, 0.25, 0.25, 4, false);
  base(STN); b.surface(SURF.STONE);
  if (g0) { setQ(0, x0, e, -w); setQ(1, x0, e, w); setQ(2, x0, r, 0); qa(b, 3, -1, 0, 0, 1, 1); }
  if (g1) { setQ(0, x1, e, -w); setQ(1, x1, e, w); setQ(2, x1, r, 0); qa(b, 3, 1, 0, 0, 1, 1); }
}

// --- openings: flat pointed-arch panels in the local xy plane, proud of z = 0 by zo ------
// equilateral pointed arch: half-width hw, straight sides from y0 to y0 + hs, apex
// sqrt(3) hw above the springing
function lancet(b, cx, y0, hw, hs, zo, r, g, bl, e) {
  b.color(r, g, bl).emissive(e, 0);
  const ys = y0 + hs, c = b.vertex(cx, y0, zo, 0, 0, 1);
  let p = b.vertex(cx - hw, y0, zo, 0, 0, 1), q;
  q = b.vertex(cx - hw, ys, zo, 0, 0, 1); b.tri(c, p, q); p = q;
  for (let k = 1; k <= 4; k++) {
    const th = Math.PI - k * Math.PI / 12;
    q = b.vertex(cx + hw + 2 * hw * Math.cos(th), ys + 2 * hw * Math.sin(th), zo, 0, 0, 1); b.tri(c, p, q); p = q;
  }
  for (let k = 1; k <= 4; k++) {
    const th = Math.PI / 3 - k * Math.PI / 12;
    q = b.vertex(cx - hw + 2 * hw * Math.cos(th), ys + 2 * hw * Math.sin(th), zo, 0, 0, 1); b.tri(c, p, q); p = q;
  }
  q = b.vertex(cx + hw, y0, zo, 0, 0, 1); b.tri(c, p, q);
  b.emissive(0, 0);
}
const GLASS = [0.1, 0.12, 0.27];
function glass(b, cx, y0, hw, hs) { lancet(b, cx, y0, hw, hs, 0.09, GLASS[0], GLASS[1], GLASS[2], 0.035); }
function hole(b, cx, y0, hw, hs) { lancet(b, cx, y0, hw, hs, 0.09, 0.035, 0.035, 0.04, 0); }
// recessed portal read through stepped shading: archivolts, tympanum, doors, trumeau
function portal(b, cx, hw, hs) {
  lancet(b, cx, 0, hw, hs, 0.1, STN[0] * 0.62, STN[1] * 0.6, STN[2] * 0.58, 0);
  lancet(b, cx, 0, hw * 0.8, hs, 0.15, STN[0] * 0.42, STN[1] * 0.4, STN[2] * 0.39, 0);
  lancet(b, cx, 0, hw * 0.6, hs, 0.2, STN[0] * 0.78, STN[1] * 0.75, STN[2] * 0.7, 0);
  b.color(0.07, 0.045, 0.03);
  setQ(0, cx - hw * 0.6, 0, 0.25); setQ(1, cx + hw * 0.6, 0, 0.25); setQ(2, cx + hw * 0.6, hs, 0.25); setQ(3, cx - hw * 0.6, hs, 0.25);
  baseRGB(0.075, 0.05, 0.035); qd(b, 0, 0, 1, 1, 1);
  b.color(STN[0] * 0.7, STN[1] * 0.7, STN[2] * 0.7); b.box(cx, hs * 0.5, 0.3, 0.22, hs * 0.5, 0.08);
}
// rose window centred at the local origin (xy plane), radius r: jewel glass, stone tracery
const ROSE_C = [
  [0.62, 0.42, 0.1], [0.55, 0.06, 0.07], [0.09, 0.16, 0.62], [0.3, 0.08, 0.42], [0.08, 0.3, 0.42],
];
function rose(b, r, zo, e) {
  const N = 24, R = [0, 0.2, 0.46, 0.74, 0.92];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < N; i++) {
      let c;
      if (k === 0) c = 0; else if (k === 1) c = (i >> 1) & 1 ? 1 : 2;
      else if (k === 2) c = i % 3 === 0 ? 1 : 2; else c = i & 1 ? 3 : 2;
      const C = ROSE_C[c], a0 = i * Math.PI * 2 / N, a1 = (i + 1) * Math.PI * 2 / N;
      b.color(C[0], C[1], C[2]).emissive(e * (k === 0 ? 0.8 : 1), 0).duskLit(); // lit from within at dusk (kit)
      const r0 = R[k] * r, r1 = R[k + 1] * r;
      const i0 = b.vertex(Math.cos(a0) * r0, Math.sin(a0) * r0, zo, 0, 0, 1), i1 = b.vertex(Math.cos(a1) * r0, Math.sin(a1) * r0, zo, 0, 0, 1);
      const i2 = b.vertex(Math.cos(a1) * r1, Math.sin(a1) * r1, zo, 0, 0, 1), i3 = b.vertex(Math.cos(a0) * r1, Math.sin(a0) * r1, zo, 0, 0, 1);
      if (k === 0) b.tri(i0, i2, i3); else b.quad(i0, i1, i2, i3);
    }
  }
  b.emissive(0, 0).duskLit(false);
  // tracery: rim, mid ring and spokes in shadowed stone, a little proud
  b.color(STN[0] * 0.55, STN[1] * 0.53, STN[2] * 0.5);
  for (let k = 0; k < 3; k++) {
    const ra = [0.18, 0.44, 0.9][k] * r, rb = ra + [0.12, 0.1, 0.22][k] * r;
    for (let i = 0; i < N; i++) {
      const a0 = i * Math.PI * 2 / N, a1 = (i + 1) * Math.PI * 2 / N;
      const i0 = b.vertex(Math.cos(a0) * ra, Math.sin(a0) * ra, zo + 0.04, 0, 0, 1), i1 = b.vertex(Math.cos(a1) * ra, Math.sin(a1) * ra, zo + 0.04, 0, 0, 1);
      const i2 = b.vertex(Math.cos(a1) * rb, Math.sin(a1) * rb, zo + 0.04, 0, 0, 1), i3 = b.vertex(Math.cos(a0) * rb, Math.sin(a0) * rb, zo + 0.04, 0, 0, 1);
      b.quad(i0, i1, i2, i3);
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, c = Math.cos(a), s = Math.sin(a), w = 0.045 * r, r0 = 0.2 * r, r1 = 0.92 * r;
    const i0 = b.vertex(c * r0 - s * w, s * r0 + c * w, zo + 0.04, 0, 0, 1), i1 = b.vertex(c * r0 + s * w, s * r0 - c * w, zo + 0.04, 0, 0, 1);
    const i2 = b.vertex(c * r1 + s * w, s * r1 - c * w, zo + 0.04, 0, 0, 1), i3 = b.vertex(c * r1 - s * w, s * r1 + c * w, zo + 0.04, 0, 0, 1);
    b.quad(i0, i1, i2, i3);
  }
}

// --- flying buttress: arch along local x from xa (pier) to xb (wall), thickness 2 hw in z
const HX = new Float64Array(24);
function flyer(b, xa, xb, hw) {
  const N = 6, ya0 = 26, ya1 = 30.6, yb0 = 22.6, yb1 = 29.4;
  for (let k = 0; k < N; k++) {
    const t0 = k / N, t1 = (k + 1) / N;
    for (let i = 0; i < 8; i++) {
      const sx = (i & 3) === 1 || (i & 3) === 2, sz = (i & 3) >= 2 ? 1 : -1, t = sx ? t1 : t0;
      HX[i * 3] = lerp(xa, xb, t);
      HX[i * 3 + 1] = i >= 4 ? lerp(ya0, ya1, t) : yb0 + (yb1 - yb0) * Math.sin(t * Math.PI / 2);
      HX[i * 3 + 2] = sz * hw;
    }
    b.hexa(HX, true);
  }
}

// --- timber scaffold along a wall line (x0, z0) -> (x1, z1), offset (ox, oz), y0..y1
function scaffold(b, x0, z0, x1, z1, ox, oz, y0, y1) {
  const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 3.6));
  const ax = x0 + ox, az = z0 + oz, dx = (x1 - x0) / n, dz = (z1 - z0) / n;
  for (let i = 0; i <= n; i++) {
    b.beam(ax + dx * i, y0 - 0.3, az + dz * i, ax + dx * i, y1, az + dz * i, 0.13, 0.1, 4, false);
    b.beam(ax + dx * i + ox * 0.9, y0 - 0.3, az + dz * i + oz * 0.9, ax + dx * i + ox * 0.9, y1 - 1, az + dz * i + oz * 0.9, 0.12, 0.09, 4, false);
  }
  for (let y = y0 + 3.2; y < y1 - 0.5; y += 3.6) {
    b.beam(ax, y, az, ax + dx * n, y, az + dz * n, 0.08, 0.08, 4, false);
    b.beam(ax + ox * 0.9, y + 0.05, az + oz * 0.9, ax + dx * n + ox * 0.9, y + 0.05, az + dz * n + oz * 0.9, 0.08, 0.08, 4, false);
  }
  for (let i = 0; i < n; i += 2) { // braces
    const yb = y0 + (i % 4 === 0 ? 0 : 7);
    b.beam(ax + dx * i, yb, az + dz * i, ax + dx * (i + 1), Math.min(y1, yb + 7), az + dz * (i + 1), 0.07, 0.07, 4, false);
  }
}
function wood(b) { baseRGB(0.21, 0.145, 0.085); b.color(0.21, 0.145, 0.085).surface(SURF.WOOD).ao(1); }
function lead(b) { base(LEAD); b.surface(SURF.PLAIN); }
function stone(b) { base(STN); b.color(STN[0], STN[1], STN[2]).surface(SURF.STONE).ao(1); }

// tags
function clip(b, y0, h, t0, t1) { b.timeless().pivot(0, y0, 0).appear(t0, t1, MOTION.CLIP, h, BY.BUILT); }
function clipV(b, y0, h, t0, t1, v0, v1) { clip(b, y0, h, t0, t1); b.vanish(v0, v1, MOTION.CLIP, h, BY.BUILT); }

// --- the cathedral's parts ------------------------------------------------------------
// one side (s = +-1) of a long section: aisle, clerestory, piers, flyers and windows
function bays(b, s, z0, z1, piers, t0, t1, tf, tAisle) {
  const xa = s * AW, xn = s * NW;
  // aisle wall and its lean-to roof
  stone(b); clip(b, 0, AH, t0, tAisle);
  slab(b, Math.min(xa, xn), Math.max(xa, xn), 0, AH, z0, z1, s > 0 ? 4 : 8, false);
  for (let i = 0; i + 1 < piers.length; i++) {
    const zc = (piers[i] + piers[i + 1]) * 0.5;
    b.push(); b.translate(xa, 0, zc); b.rotateY(s * Math.PI / 2); glass(b, 0, 3, 1.5, 4.4); b.pop();
  }
  lead(b); clip(b, AH, AR - AH, tAisle - 0.02, tAisle + 0.04);
  setQ(0, xa + s * 0.5, AH - 0.3, z0); setQ(1, xa + s * 0.5, AH - 0.3, z1); setQ(2, xn, AR, z1); setQ(3, xn, AR, z0);
  qa(b, 4, s, 1, 0, 0.85, 1.08);
  // clerestory windows (the vessel's wall itself is drawn by the caller)
  clip(b, 0, EAVE, t0, t1);
  for (let i = 0; i + 1 < piers.length; i++) {
    const zc = (piers[i] + piers[i + 1]) * 0.5;
    b.push(); b.translate(xn, 0, zc); b.rotateY(s * Math.PI / 2); glass(b, 0, 21.6, 1.35, 6.2); b.pop();
  }
  // piers with pinnacles, then the flyers bay by bay
  for (let i = 0; i < piers.length; i++) {
    const z = piers[i];
    stone(b); clip(b, 0, 33, t0, t1);
    slab(b, Math.min(xa, xa + s * 3.6), Math.max(xa, xa + s * 3.6), 0, 26, z - 1.1, z + 1.1, 15);
    pinnacle(b, xa + s * 1.8, 26, z, 1.0, 7);
    const ft = tf + 0.012 * i;
    b.push(); b.translate(0, 0, z);
    b.timeless().pivot(xa, 24, 0).appear(ft, ft + 0.03, MOTION.SCALE, 0, BY.BUILT);
    flyer(b, xa, xn, 0.5);
    b.pop();
  }
}
// polygonal apse: wall facets and windows of radius R from y0 to y1 around (0, KZ0)
const APN = 5;
function apseRing(b, R, y0, y1, soot) {
  for (let k = 0; k < APN; k++) {
    const p0 = k * Math.PI / APN, p1 = (k + 1) * Math.PI / APN, pm = (p0 + p1) * 0.5;
    wall(b, R * Math.cos(p0), KZ0 - R * Math.sin(p0), R * Math.cos(p1), KZ0 - R * Math.sin(p1), y0, y1, Math.cos(pm), -Math.sin(pm), soot);
    setQ(0, R * Math.cos(p0), y1, KZ0 - R * Math.sin(p0)); setQ(1, R * Math.cos(p1), y1, KZ0 - R * Math.sin(p1)); setQ(2, 0, y1, KZ0);
    qa(b, 3, 0, 1, 0, 0.93, 0.93);
  }
}
function apseWindows(b, R, y0, hw, hs) {
  for (let k = 0; k < APN; k++) {
    const pm = (k + 0.5) * Math.PI / APN;
    b.push(); b.translate(0, 0, KZ0); b.rotateY(pm + Math.PI / 2); b.translate(0, 0, R * Math.cos(Math.PI / APN / 2)); glass(b, 0, y0, hw, hs); b.pop();
  }
}

function westFront(b) {
  const zf = WZ1;
  stone(b); clip(b, 0, WH, T_WF0, T_WF1);
  slab(b, -WX, WX, 0, WH, WZ0, zf, 1 | 2 | 4 | 8);
  // buttresses dividing the front into three, string courses, cornice
  for (const x of [-WX, -TX0, TX0, WX]) slab(b, x - 1.25, x + 1.25, 0, WH - 1, zf, zf + 1.7, 1);
  for (const [y, h] of [[16.6, 0.5], [20.2, 0.5], [31.4, 0.7], [WH - 0.8, 1.2]]) slab(b, -WX - 1.4, WX + 1.4, y, y + h, zf, zf + 2.0, 0);
  b.push(); b.translate(0, 0, zf);
  portal(b, 0, 4.4, 8.6); portal(b, -14.25, 3.5, 7.4); portal(b, 14.25, 3.5, 7.4);
  for (let i = 0; i < 28; i++) { const x = -19.6 + i * 39.2 / 27; if (Math.abs(Math.abs(x) - 7.5) > 1.4 && Math.abs(Math.abs(x) - 21) > 1.4) lancet(b, x, 17.3, 0.5, 1.5, 0.09, STN[0] * 0.38, STN[1] * 0.36, STN[2] * 0.36, 0); }
  b.push(); b.translate(0, 25.6, 0);
  base(STN, 0.7); b.color(STN[0] * 0.7, STN[1] * 0.68, STN[2] * 0.66);
  lancet(b, 0, -6.2, 6.2, 1.2, 0.06, STN[0] * 0.5, STN[1] * 0.48, STN[2] * 0.46, 0); // the rose's arch
  rose(b, 5.2, 0.12, 0.16);
  b.pop();
  for (const x of [-17.2, -11.3, 11.3, 17.2]) glass(b, x, 21.6, 1.4, 5.3);
  for (let i = 0; i < 15; i++) { const x = -18 + i * 36 / 14; if (Math.abs(Math.abs(x) - 7.5) > 1.6) hole(b, x, 33, 0.62, 6); }
  b.pop();
  // towers (each with corner buttresses, twin belfry openings on every face, cornice)
  for (let s = -1; s <= 1; s += 2) {
    const x0 = s > 0 ? TX0 : -WX, x1 = s > 0 ? WX : -TX0, xc = (x0 + x1) * 0.5, zc = (WZ0 + zf) * 0.5;
    stone(b); clip(b, WH, TH - WH + 1, T_WF1, T_TW1);
    slab(b, x0, x1, WH, TH, WZ0, zf, 1 | 2 | 4 | 8);
    for (const cx of [x0, x1]) for (const cz of [WZ0, zf]) slab(b, cx - 0.9, cx + 0.9, WH, TH - 2.5, cz - 0.9, cz + 0.9, 0);
    slab(b, x0 - 0.9, x1 + 0.9, TH, TH + 1, WZ0 - 0.9, zf + 0.9, 0);
    for (let f = 0; f < 4; f++) {
      b.push(); b.translate(xc, 0, zc); b.rotateY(f * Math.PI / 2); b.translate(0, 0, f & 1 ? (x1 - x0) * 0.5 : (zf - WZ0) * 0.5);
      hole(b, -2.6, 47, 1.15, 12.5); hole(b, 2.6, 47, 1.15, 12.5);
      b.pop();
    }
  }
}

function transept(b) {
  stone(b); clip(b, 0, EAVE, T_TR0, T_TR1);
  slab(b, -TR, TR, 0, EAVE, -NW, NW, 1 | 2 | 4 | 8, false);
  for (let s = -1; s <= 1; s += 2) {
    for (const z of [-NW, NW]) { slab(b, s * TR - 1.2, s * TR + 1.2, 0, 36, z - 1.2, z + 1.2, 0); pinnacle(b, s * TR, 36, z, 1.2, 8); }
    b.push(); b.translate(s * TR, 0, 0); b.rotateY(s * Math.PI / 2);
    portal(b, 0, 3.4, 7.2);
    b.push(); b.translate(0, 21.5, 0); lancet(b, 0, -5.8, 5.8, 1.1, 0.06, STN[0] * 0.5, STN[1] * 0.48, STN[2] * 0.46, 0); rose(b, 4.9, 0.12, 0.13); b.pop();
    for (let i = 0; i < 5; i++) hole(b, -4 + i * 2, 28.6, 0.55, 2.4);
    b.pop();
  }
  clip(b, EAVE, RIDGE - EAVE, T_TR1, T_TR1 + 0.08);
  roofX(b, -TR, -NW, NW + 0.5, EAVE, RIDGE, true, false);
  roofX(b, NW, TR, NW + 0.5, EAVE, RIDGE, false, true);
}

function spire(b) {
  base(LEAD); b.surface(SURF.PLAIN).ao(1); clip(b, 41, SPH - 41 + 3, T_SP0, T_SP1);
  const prof = [3.6, 41, 3.6, 52, 3.0, 53, 0.1, SPH]; // octagonal drum then needle
  for (let k = 0; k < 3; k++) {
    const r0 = prof[k * 2], y0 = prof[k * 2 + 1], r1 = prof[k * 2 + 2], y1 = prof[k * 2 + 3];
    for (let i = 0; i < 8; i++) {
      const a0 = (i + 0.5) * Math.PI / 4, a1 = (i + 1.5) * Math.PI / 4, am = (i + 1) * Math.PI / 4;
      setQ(0, r0 * Math.cos(a0), y0, r0 * Math.sin(a0)); setQ(1, r0 * Math.cos(a1), y0, r0 * Math.sin(a1));
      setQ(2, r1 * Math.cos(a1), y1, r1 * Math.sin(a1)); setQ(3, r1 * Math.cos(a0), y1, r1 * Math.sin(a0));
      qa(b, 4, Math.cos(am), 0.3, Math.sin(am), k === 2 ? 0.95 : 0.85, k === 2 ? 1.25 : 1);
    }
  }
  for (let i = 0; i < 8; i++) { // drum openings and the small pinnacles round the needle's foot
    const am = (i + 1) * Math.PI / 4;
    b.push(); b.rotateY(-am + Math.PI / 2); b.translate(0, 0, 3.6 * Math.cos(Math.PI / 8)); hole(b, 0, 45, 0.7, 3.8); b.pop();
    b.color(LEAD[0], LEAD[1], LEAD[2]); b.push(); b.translate(4 * Math.cos(am + 0.39), 52, 4 * Math.sin(am + 0.39)); b.block(0.45, 0.45, 0.03, 0.03, 7); b.pop();
  }
  b.timeless().appear(T_SP1, T_SP1 + 0.01, MOTION.POP, 0, BY.BUILT);
  b.color(0.6, 0.45, 0.16).surface(SURF.GILT);
  b.push(); b.translate(0, SPH + 0.3, 0); b.ellipsoid(0.45, 0.45, 0.45, 2); b.pop();
  b.beam(0, SPH + 0.6, 0, 0, SPH + 3.4, 0, 0.09, 0.09, 4); b.beam(-0.8, SPH + 2.5, 0, 0.8, SPH + 2.5, 0, 0.08, 0.08, 4);
}

// town house (C frame): plaster walls, dark timbers, a steep tile roof, a chimney
function house(b, x, z, w, d, h, rf, k) {
  k = Math.abs(k | 0);
  const wc = [[0.4, 0.33, 0.22], [0.36, 0.3, 0.24], [0.42, 0.37, 0.28]][k % 3];
  b.surface(SURF.PLASTER).ao(1); base(wc);
  slab(b, x - w, x + w, 0, h * 0.5, z - d, z + d, 0, false);
  slab(b, x - w - 0.5, x + w + 0.5, h * 0.5, h, z - d - 0.3, z + d + 0.3, 0, false); // jettied upper storey
  baseRGB(0.08, 0.06, 0.045); b.surface(SURF.WOOD);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) slab(b, x + sx * (w + 0.5) - 0.18, x + sx * (w + 0.5) + 0.18, h * 0.5, h, z + sz * (d + 0.3) - 0.18, z + sz * (d + 0.3) + 0.18, 0, false);
  slab(b, x - w - 0.55, x + w + 0.55, h * 0.5 - 0.2, h * 0.5 + 0.15, z - d - 0.35, z + d + 0.35, 0, false);
  const rc = [[0.3, 0.12, 0.065], [0.26, 0.13, 0.08], [0.16, 0.15, 0.15]][(k >> 1) % 3];
  b.surface(SURF.PLAIN);
  b.push(); b.translate(x, 0, z);
  for (let s = -1; s <= 1; s += 2) {
    base(rc); setQ(0, s * (w + 1.1), h - 0.3, -d - 0.9); setQ(1, s * (w + 1.1), h - 0.3, d + 0.9); setQ(2, 0, h + rf, d + 0.9); setQ(3, 0, h + rf, -d - 0.9);
    qa(b, 4, s, 0.6, 0, 0.82, 1.1);
    base(wc, 0.92); b.surface(SURF.PLASTER);
    setQ(0, -w - 0.5, h, s * (d + 0.3)); setQ(1, w + 0.5, h, s * (d + 0.3)); setQ(2, 0, h + rf - 0.4, s * (d + 0.3)); qa(b, 3, 0, 0, s, 1, 1);
    b.surface(SURF.PLAIN);
  }
  base([0.2, 0.17, 0.15]); slab(b, w * 0.4 - 0.5, w * 0.4 + 0.5, h, h + rf + 1, d * 0.3 - 0.5, d * 0.3 + 0.5, 0);
  b.pop();
}

const PILES = [-28, -22, 0.3, 27, -30, 0.3, -28, 24, 0.58, 28, 20, 0.58, -13, 68, 0.9, 15, 70, 0.9, -4, -60, 0.3];
const HOUSES = [-37, 31, 3.5, 5.5, 7, 5, -38, 15, 3.2, 4.5, 6, 4.5, -36, -18, 3.6, 5, 7.5, 5, -38, -33, 3.2, 5, 6.5, 4.5,
  37, 26, 3.5, 5, 7, 5, 36, 6, 3.2, 4.5, 6.5, 4.5, 37, -22, 3.6, 5.5, 7.5, 5, -18, -64, 3.4, 4.5, 6.5, 4.5, 18, -63, 3.2, 5, 7, 5,
  -29, 70, 3.5, 5, 7, 5, 30, 66, 3.5, 4.5, 6.5, 4.5];

export default {
  id: 'cathedral',
  name: 'Gothic cathedral',
  caption: 'Masons raise a Gothic cathedral',
  year: 1163,
  radius: 112,
  pad: 108,
  roadOffset: 120,
  straddlesRoad: false,
  biome: 'forest',
  live: true,
  lights: [],
  reach: 110,
  viewSunAz: 2.0,
  witness: { at: [CX, CZ + 6], dist: 280, height: 26, look: 40, az: 0.95, fov: 0.6, drift: 0.07, range: 1200 },
  detail: { at: [CX + 60 * SP, 24, CZ + 60 * CP], from: [CX + 100 * SP - 20 * CP, 3, CZ + 100 * CP + 20 * SP] },
  strip: { at: [CX, 36, CZ], from: [CX - 250, 24, CZ + 190], fov: 0.62 },

  // distant village churches in the forest: the cathedral's diocese
  satellites: {
    count: [5, 7], near: 2, nearR: [240, 340], farR: [420, 1000],
    centre: 0.3, spread: 4.4, minSep: 130, roadClear: 45,
    build(b, k, n, dist) {
      const s = 1 + 0.6 * Math.min(1, dist / 900);
      b.timeless(); b.push(); b.scale(s, s, s);
      base(STN, 0.95); b.surface(SURF.STONE).ao(1);
      slab(b, -3.2, 3.2, 0, 7, -7, 6, 0, false);
      slab(b, -2.2, 2.2, 0, 15, 6, 10.4, 0);
      roofZ(b, -7, 6, 3.6, 7, 12.5, true, false);
      base(LEAD); b.push(); b.translate(0, 15, 8.2);
      for (let i = 0; i < 4; i++) { const a0 = i * Math.PI / 2, a1 = a0 + Math.PI / 2; setQ(0, 2.6 * Math.cos(a0 + 0.785), 0, 2.6 * Math.sin(a0 + 0.785)); setQ(1, 2.6 * Math.cos(a1 + 0.785), 0, 2.6 * Math.sin(a1 + 0.785)); setQ(2, 0, 11, 0); qa(b, 3, Math.cos(a0 + 1.57), 0.3, Math.sin(a0 + 1.57), 0.85, 1.15); }
      b.pop();
      if (b.rand() < 0.7) house(b, 9, -2, 3, 4.5, 6, 4, k);
      b.pop();
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 13 + 7;
    const rock = b.bio('rock'), ground = b.bio('ground'), soil = b.bio('soil');
    // pale Lutetian limestone, a touch of the forest's own stone
    STN[0] = lerp(0.35, rock[0], 0.15); STN[1] = lerp(0.315, rock[1], 0.15); STN[2] = lerp(0.245, rock[2], 0.15);
    NS = 0;
    b.push(); b.translate(CX, 0, CZ); b.rotateY(PSI);

    // --- ground: the cathedral close (trampled earth worksite, feathered into the moss)
    b.timeless().surface(SURF.EARTH).ao(1);
    b.heightfield(-40, -72, 40, 88, 20, 40, (x, z) => {
      const e = Math.min(x + 40, 40 - x, z + 72, 88 - z), f = Math.min(1, e / 22) * Math.min(1, e / 22);
      const n = fbm3(x * 0.05, 1.7, z * 0.05, 3), w = f * (0.55 + 0.45 * n);
      const k = 0.9 + 0.2 * noise3(x * 0.2, 3.1, z * 0.2);
      b.color(lerp(ground[0], soil[0] * 1.1, w) * k, lerp(ground[1], soil[1] * 1.05, w) * k, lerp(ground[2], soil[2], w) * k);
      return 0.02 + 0.015 * f;
    });
    // the paved parvis before the west front, laid when the front is finished
    b.timeless().appear(0.9, 0.93, MOTION.POP, 0, BY.BUILT).surface(SURF.STONE);
    b.heightfield(-22, 61, 22, 86, 8, 6, (x, z) => { const k = 0.82 + 0.12 * noise3(x * 0.4, 0, z * 0.4); b.color(STN[0] * 0.8 * k, STN[1] * 0.78 * k, STN[2] * 0.75 * k); return 0.06; });

    // --- foundations, laid out from the start
    stone(b); b.timeless();
    base(STN, 0.85);
    slab(b, -AW - 0.4, AW + 0.4, -0.4, 0.6, KZ0, WZ0, 0);
    slab(b, -WX - 0.5, WX + 0.5, -0.4, 0.6, WZ0, WZ1 + 0.5, 0);
    slab(b, -TR - 0.4, TR + 0.4, -0.4, 0.6, -NW - 0.4, NW + 0.4, 0);
    apseRing(b, AW + 0.4, -0.4, 0.6, false);
    yield;

    // --- the old church on the site of the west front, pulled down as the nave arrives
    stone(b); base(STN, 0.82); b.timeless().pivot(0, 0, 0).vanish(0.54, 0.6, MOTION.CLIP, 26, BY.BUILT);
    b.push(); b.translate(4, 0, 64);
    slab(b, -4.5, 4.5, 0, 9, -8, 8, 0, false); roofZ(b, -8, 8, 5, 9, 14, true, true);
    base(STN, 0.78); b.surface(SURF.STONE); slab(b, -3, 3, 0, 18, 8, 14, 0);
    base(LEAD); for (let i = 0; i < 4; i++) { const a0 = i * Math.PI / 2 + 0.785, a1 = a0 + Math.PI / 2; setQ(0, 4.2 * Math.cos(a0), 18, 11 + 4.2 * Math.sin(a0)); setQ(1, 4.2 * Math.cos(a1), 18, 11 + 4.2 * Math.sin(a1)); setQ(2, 0, 25, 11); qa(b, 3, Math.cos(a0 + 0.785), 0.4, Math.sin(a0 + 0.785), 0.85, 1.1); }
    b.pop();

    // --- choir and apse (first)
    stone(b); clip(b, 0, EAVE, T_CH0, T_CH1);
    slab(b, -NW, NW, 0, EAVE, KZ0, KZ1, 4 | 8, false);
    apseRing(b, NW, 0, EAVE, true);
    apseWindows(b, NW, 21.6, 1.2, 6.2);
    clip(b, 0, AH, T_CH0, T_CH0 + 0.13);
    apseRing(b, AW, 0, AH, true);
    apseWindows(b, AW, 3, 1.5, 4.4);
    lead(b); clip(b, AH, AR - AH, T_CH0 + 0.11, T_CH0 + 0.17);
    for (let k = 0; k < APN; k++) {
      const p0 = k * Math.PI / APN, p1 = (k + 1) * Math.PI / APN, pm = (p0 + p1) / 2, R0 = AW + 0.5;
      setQ(0, R0 * Math.cos(p0), AH - 0.3, KZ0 - R0 * Math.sin(p0)); setQ(1, R0 * Math.cos(p1), AH - 0.3, KZ0 - R0 * Math.sin(p1));
      setQ(2, NW * Math.cos(p1), AR, KZ0 - NW * Math.sin(p1)); setQ(3, NW * Math.cos(p0), AR, KZ0 - NW * Math.sin(p0));
      qa(b, 4, Math.cos(pm), 1, -Math.sin(pm), 0.85, 1.08);
    }
    // radial piers and flyers round the chevet
    for (let k = 1; k < APN; k++) {
      const p = k * Math.PI / APN;
      b.push(); b.translate(0, 0, KZ0); b.rotateY(p);
      stone(b); clip(b, 0, 33, T_CH0, T_CH1);
      slab(b, AW, AW + 3.6, 0, 26, -1.1, 1.1, 0); pinnacle(b, AW + 1.8, 26, 0, 1.0, 7);
      const ft = T_CH1 + 0.01 * k;
      b.timeless().pivot(AW, 24, 0).appear(ft, ft + 0.03, MOTION.SCALE, 0, BY.BUILT);
      flyer(b, AW, NW * Math.cos(Math.PI / APN / 2), 0.5);
      b.pop();
    }
    const CP_ = [-38, -31, -24, -17, -10];
    for (let s = -1; s <= 1; s += 2) bays(b, s, KZ0, KZ1, CP_, T_CH0, T_CH1, T_CH1 - 0.02, T_CH0 + 0.13);
    // choir roof with its half-cone over the apse
    clip(b, EAVE, RIDGE - EAVE, T_CH1, T_CH1 + 0.07);
    roofZ(b, KZ0, KZ1, NW + 0.5, EAVE, RIDGE, false, false);
    lead(b);
    for (let k = 0; k < APN; k++) {
      const p0 = k * Math.PI / APN, p1 = (k + 1) * Math.PI / APN, pm = (p0 + p1) / 2, R0 = NW + 0.5;
      setQ(0, R0 * Math.cos(p0), EAVE, KZ0 - R0 * Math.sin(p0)); setQ(1, R0 * Math.cos(p1), EAVE, KZ0 - R0 * Math.sin(p1)); setQ(2, 0, RIDGE, KZ0);
      qa(b, 3, Math.cos(pm), 0.6, -Math.sin(pm), 0.82, 1.12);
    }
    // choir scaffolds and their dismantling
    wood(b); clipV(b, 0, EAVE + 3, T_CH0, T_CH1, T_CH1 + 0.08, T_CH1 + 0.13);
    for (let s = -1; s <= 1; s += 2) scaffold(b, s * NW, KZ0, s * NW, KZ1, s * 1.3, 0, AH, EAVE + 3);
    for (let k = 0; k < APN; k++) {
      const p0 = k * Math.PI / APN, p1 = (k + 1) * Math.PI / APN, pm = (p0 + p1) / 2, R = NW + 0.2;
      scaffold(b, R * Math.cos(p0), KZ0 - R * Math.sin(p0), R * Math.cos(p1), KZ0 - R * Math.sin(p1), 1.3 * Math.cos(pm), -1.3 * Math.sin(pm), AH, EAVE + 3);
    }
    yield;

    // --- transept and crossing
    transept(b);
    wood(b); clipV(b, 0, EAVE + 3, T_TR0, T_TR1, T_TR1 + 0.1, T_TR1 + 0.15);
    for (let s = -1; s <= 1; s += 2) scaffold(b, s * TR, -NW, s * TR, NW, s * 1.6, 0, 0, EAVE + 3);

    // --- nave
    stone(b); clip(b, 0, EAVE, T_NV0, T_NV1);
    slab(b, -NW, NW, 0, EAVE, NZ0, NZ1, 4 | 8, false);
    const NP = [10, 17, 24, 31, 38, 45];
    for (let s = -1; s <= 1; s += 2) bays(b, s, NZ0, NZ1, NP, T_NV0, T_NV1, T_NV1 - 0.02, T_NV0 + 0.12);
    clip(b, EAVE, RIDGE - EAVE, T_NV1 + 0.03, T_NV1 + 0.11);
    roofZ(b, -NW, WZ0, NW + 0.5, EAVE, RIDGE, false, false);
    wood(b); clipV(b, 0, EAVE + 3, T_NV0, T_NV1, T_NV1 + 0.1, T_NV1 + 0.16);
    for (let s = -1; s <= 1; s += 2) scaffold(b, s * NW, NZ0, s * NW, NZ1, s * 1.3, 0, AH, EAVE + 3);
    yield;

    // --- west front and towers
    westFront(b);
    wood(b); clipV(b, 0, WH + 3, T_WF0, T_WF1, 0.92, 0.96);
    scaffold(b, -WX - 1.5, WZ1 + 1.8, WX + 1.5, WZ1 + 1.8, 0, 1.4, 0, WH + 2);
    clipV(b, WH, TH - WH + 3, T_WF1, T_TW1, 0.92, 0.96);
    for (let s = -1; s <= 1; s += 2) {
      const x0 = s > 0 ? TX0 : -WX, x1 = s > 0 ? WX : -TX0;
      scaffold(b, x0 - 1, WZ1 + 1, x1 + 1, WZ1 + 1, 0, 1.4, WH, TH + 3);
      scaffold(b, s * (WX + 1), WZ0, s * (WX + 1), WZ1, s * 1.4, 0, WH, TH + 3);
    }

    // --- spire over the crossing
    spire(b);
    yield;

    // --- the town (stands throughout)
    b.timeless();
    for (let i = 0; i < HOUSES.length; i += 6) house(b, HOUSES[i], HOUSES[i + 1], HOUSES[i + 2], HOUSES[i + 3], HOUSES[i + 4], HOUSES[i + 5], i / 6 + sd);

    // --- stone piles (used up section by section), the masons' lodge, the crews
    for (let p = 0; p < PILES.length; p += 3) {
      const px = PILES[p], pz = PILES[p + 1], tv = PILES[p + 2] + 0.03 * hsh(p, sd, 3);
      b.push(); b.translate(px, 0, pz);
      b.timeless().pivot(0, 0, 0).vanish(tv, tv + 0.05, MOTION.SCALE, 0, BY.BUILT);
      b.surface(SURF.STONE).ao(0.95);
      for (let i = 0; i < 9; i++) {
        const lx = (i % 3 - 1) * 1.5, lz = ((i / 3) | 0) * 1.0 - 1, ly = 0.35 + (i % 2 && i < 6 ? 0.7 : 0);
        base(STN, 0.88 + 0.12 * hsh(i, p, sd)); b.color(BR, BG, BB);
        b.box(lx, ly, lz, 0.68, 0.34, 0.45);
      }
      b.pop();
    }
    b.timeless().vanish(0.96, 0.99, MOTION.POP, 0, BY.BUILT);
    wood(b);
    b.push(); b.translate(-30, 0, 46);
    slab(b, -3, 3, 0, 3.2, -6, 6, 0, false);
    baseRGB(0.17, 0.12, 0.07); setQ(0, -3.8, 3, -6.5); setQ(1, -3.8, 3, 6.5); setQ(2, 3.8, 4.6, 6.5); setQ(3, 3.8, 4.6, -6.5); qa(b, 4, -0.4, 1, 0, 0.9, 1.05);
    b.pop();
    b.surface(SURF.HIDE).ao(1);
    const CREW = [-26, -19, 0, 0.3, 25, -27, 3, 2.1, -26, 27, 4, -0.8, 26, 23, 0, 3.6, -11, 65, 3, 0.4, 13, 67, 0, -2.4, -27, 41, 1, 1.2];
    for (let i = 0; i < CREW.length; i += 4) {
      const c = 0.6 + 0.4 * hsh(i, sd, 9);
      b.color(0.2 * c, 0.15 * c, 0.1 * c);
      b.push(); b.at(CREW[i], 0, CREW[i + 1], CREW[i + 3]); b.human(CREW[i + 2], 1.72, sd + i); b.pop();
    }
    // townsfolk on the new parvis
    b.timeless().appear(0.95, 0.97, MOTION.POP, 0, BY.BUILT).surface(SURF.HIDE);
    for (let i = 0; i < 3; i++) { b.color(0.16 + 0.1 * i, 0.1, 0.07 + 0.05 * i); b.push(); b.at(-6 + i * 5.5, 0.06, 74 + 3 * (i & 1), 2.8 + i); b.human(i === 1 ? POSE.WALK : POSE.STAND, 1.68, sd + 40 + i); b.pop(); }
    yield;

    // --- soot and weathering (decay 0 -> 0.3): dark overlays revealed from each face's top
    b.surface(SURF.STONE).ao(1);
    for (let f = 0; f < NS; f++) {
      const o = f * 8, x0 = SOOT[o], z0 = SOOT[o + 1], x1 = SOOT[o + 2], z1 = SOOT[o + 3], y0 = SOOT[o + 4], y1 = SOOT[o + 5];
      const nx = SOOT[o + 6] * 0.05, nz = SOOT[o + 7] * 0.05;
      const L = Math.hypot(x1 - x0, z1 - z0), H = y1 - y0, nu = Math.max(1, Math.round(L / 3)), nv = Math.max(1, Math.round(H / 4.5));
      const t0 = 0.01 + 0.13 * hsh(f, sd, 17);
      b.timeless().pivot((x0 + x1) * 0.5 + nx, y1, (z0 + z1) * 0.5 + nz).appear(t0, 0.285, MOTION.REVEAL, Math.max(H, L * 0.6) + 6, BY.DECAY);
      const v0 = b.nv;
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const u = i / nu, y = y0 + H * j / nv, x = lerp(x0, x1, u) + nx, z = lerp(z0, z1, u) + nz;
          const n = fbm3(x * 0.07, y * 0.05, z * 0.07, 2), st = noise3(x * 0.55 + z * 0.55, y * 0.035, 3.3);
          // grey-brown grime, streaked down the face, heavier toward the foot; washed patches
          const k = Math.min(0.9, (0.18 + 0.55 * n + 0.3 * st * st) * (0.7 + 0.3 * j / nv));
          b.color(lerp(0.075, STN[0], k), lerp(0.07, STN[1], k), lerp(0.06, STN[2], k));
          b.vertex(x, y, z, SOOT[o + 6], 0, SOOT[o + 7]);
        }
      }
      if (b.nv - v0 !== (nu + 1) * (nv + 1)) continue;
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = v0 + j * (nu + 1) + i; b.quad(a, a + 1, a + nu + 2, a + nu + 1); }
    }
    b.timeless();
    b.pop();

    // --- the two treadwheel cranes (rigs 1, 2; animate rides them up the wall tops)
    for (let r = 1; r <= 2; r++) {
      b.rig(r); wood(b);
      b.beam(-1.6, 0, -1.4, 0, 6.8, 0, 0.13, 0.11, 4); b.beam(1.6, 0, -1.4, 0, 6.8, 0, 0.13, 0.11, 4);
      b.beam(-1.6, 0, 1.4, 0, 6.8, 0, 0.13, 0.11, 4); b.beam(1.6, 0, 1.4, 0, 6.8, 0, 0.13, 0.11, 4);
      b.box(0, 0.15, 0, 2.2, 0.15, 2.0);
      for (const zz of [-0.8, 0.8]) { // the wheel: two rims and treads
        for (let i = 0; i < 14; i++) {
          const a0 = i * Math.PI / 7, a1 = (i + 1) * Math.PI / 7;
          b.beam(0, 3.1 + 2.7 * Math.cos(a0), zz, 0, 3.1 + 2.7 * Math.cos(a1), zz, 0.09, 0.09, 4, false);
          b.beam(0, 3.1, zz, 0, 3.1 + 2.7 * Math.cos(a0), zz, 0.05, 0.05, 3, false);
        }
      }
      for (let i = 0; i < 14; i++) b.beam(0, 3.1 + 2.7 * Math.cos(i * Math.PI / 7), -0.8, 0, 3.1 + 2.7 * Math.cos(i * Math.PI / 7), 0.8, 0.05, 0.05, 3, false);
      b.beam(0, 6.6, -0.3, 0, 9.2, 7.5, 0.16, 0.1, 4); // the jib
      b.beam(0, 6.6, -0.3, 0, 7.2, -3, 0.12, 0.1, 4);
      baseRGB(0.32, 0.27, 0.18); b.color(0.32, 0.27, 0.18).surface(SURF.PLAIN);
      b.beam(0, 9.2, 7.5, 0, 4.4, 7.5, 0.03, 0.03, 3, false); // rope and the stone on it
      stone(b); b.box(0, 3.9, 7.5, 0.6, 0.4, 0.45);
      b.color(0.18, 0.13, 0.09).surface(SURF.HIDE); b.push(); b.at(0, 0.3, 2.2, Math.PI); b.human(POSE.HAUL, 1.7, sd + r); b.pop();
    }
    b.rig(0);
    return b.counts();
  },

  // the cranes follow the work: choir, then nave, then the front and its towers, the crossing
  animate(a) {
    const u = a.built;
    for (let r = 1; r <= 2; r++) {
      const s = r === 1 ? 1 : -1;
      let x, y, z;
      if (u < 0.28) { x = s * NW * 0.6; z = s > 0 ? -27 : -15; y = EAVE * seg(u, T_CH0, T_CH1); }
      else if (u < 0.56) { x = s * NW * 0.6; z = s > 0 ? 34 : 21; y = EAVE * seg(u, T_NV0, T_NV1); }
      else if (u < 0.86 || s < 0) { x = s * 14; z = 52; y = WH * seg(u, T_WF0, T_WF1) + (TH - WH) * seg(u, T_WF1, T_TW1); }
      else { x = 4.5; z = 9; y = RIDGE - 1.2; }
      const yaw = PSI + s * 1.57 + 0.6 * Math.sin(a.t * 0.21 + r * 2.1);
      a.set(r, CX + x * CP + z * SP, y + 0.6, CZ - x * SP + z * CP, yaw).show(r, u > 0.003 && u < 0.955);
    }
  },
};
