// Great Zimbabwe, c. 1300: the Great Enclosure, a long oval of mortarless granite walls up to
// 11 m high, with the chevron band along the top of its tall road-facing stretch, the narrow
// parallel passage inside it leading to the solid conical tower; round daga (clay) houses with
// conical thatch inside and around; and behind it the Hill Complex: walls threaded along the
// contours between giant rounded granite boulders on a whaleback hill. Contract:
// internal_docs/LANDMARKS.md.
//
// Layout (landmark-local): the road is at x = -100 (roadOffset), the enclosure's long side
// faces it (centre (-25, 0), semi-axes 30 x 42), the hill rises behind at (52, -12).
// Every wall is coursed: each block is its own quad pair with its own tone, every course's
// face tilts from down-lit at its foot to up-lit at its top and every block is slightly
// pillowed, so the coursing reads through shading alone.
//
// Live (def.live): one build holds the whole timeline.
//   built 0..1 (clock 136-158, ~1300): the hill walls go up first (0.06-0.45); the Great
//     Enclosure rises course by course from the back round to the tall front (0.05-0.75),
//     the chevron band near the end; the parallel passage wall (0.32-0.68), the conical
//     tower (0.5-0.82); stone piles and masons at the wall foot, fire-setting quarrying on a
//     boulder; houses appear around (0.1-0.6) and inside (0.78-0.9); piles and crews cleared.
//   decay 0..0.7 (clock 168-215, abandoned): people and cattle go, the hearth and the cooking
//     smoke die (0.01-0.12); thatch sags and goes (0.05-0.25), clay walls melt to stubs and
//     grass over; sections of the enclosure and a hill wall tumble top-down into rubble
//     (0.2-0.65); all stone weathers darker; trees and flowering aloes grow inside (0.25-0.65)
//     -- the ruin of today, the conical tower and the great curved wall still standing.

import { SURF, POSE, MOTION, BY, FLICKER, noise3 } from './kit.js';

const { POP, RISE, GROW, SCALE, CLIP, MORPH } = MOTION;
const TAU = Math.PI * 2;
const EX = -25, EZ = 0, EA = 30, EC = 42; // enclosure wall centre line: ellipse centre, semi-axes x, z
const HX = 52, HZ = -12, HR = 36, HH = 21; // the hill: centre, radius, height
const TWX = -38.8, TWZ = -22; // conical tower
const CH = 0.55, BL = 1.45; // course height, block length

function hr(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sst = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const wrap = (a) => a - TAU * Math.round(a / TAU);
const bump = (x, w) => { const t = x / w; return t * t >= 1 ? 0 : (1 - t * t) * (1 - t * t); };

// Granite (linear): the dressed wall stone, grey-brown; weathered target darker and greener.
const GR = [0.255, 0.238, 0.207], WARM = [0.285, 0.222, 0.16];

// ------------------------------------------------------------------------------ the hill
function hillY(x, z) {
  const dx = (x - HX) / HR, dz = (z - HZ) / (HR * 0.92);
  const r = Math.hypot(dx, dz) * (0.95 + 0.1 * noise3(x * 0.05, 0.5, z * 0.05));
  if (r >= 1) return -0.6;
  const t = 1 - r * r;
  return HH * t * Math.sqrt(t) * (0.82 + 0.36 * noise3(x * 0.045, 2.1, z * 0.045)) - 0.6 * r * r;
}

// ------------------------------------------------------------------------ path sampling
const NP = 1400;
const PX = new Float64Array(NP), PZ = new Float64Array(NP), PS = new Float64Array(NP), PA = new Float64Array(NP);
let PN = 0;
function pt(x, z, a) {
  PX[PN] = x; PZ[PN] = z; PA[PN] = a;
  PS[PN] = PN ? PS[PN - 1] + Math.hypot(x - PX[PN - 1], z - PZ[PN - 1]) : 0;
  PN++;
}
const Q = new Float64Array(5), A0 = new Float64Array(5), A1 = new Float64Array(5), AM = new Float64Array(5);
function ptAt(s, o) {
  let lo = 0, hi = PN - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (PS[m] <= s) lo = m; else hi = m; }
  const d = PS[hi] - PS[lo] || 1, t = clamp01((s - PS[lo]) / d);
  o[0] = PX[lo] + (PX[hi] - PX[lo]) * t; o[1] = PZ[lo] + (PZ[hi] - PZ[lo]) * t;
  o[2] = (PX[hi] - PX[lo]) / d; o[3] = (PZ[hi] - PZ[lo]) / d; o[4] = PA[lo] + (PA[hi] - PA[lo]) * t;
}
function ellipsePath(a0, a1, off) {
  PN = 0;
  const n = Math.max(2, Math.ceil((a1 - a0) / 0.008));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n, c = Math.cos(a), s = Math.sin(a);
    const nx = EC * c, nz = EA * s, nl = Math.hypot(nx, nz);
    pt(EX + EA * c - nx / nl * off, EZ + EC * s - nz / nl * off, a);
  }
}

// --------------------------------------------------------------------- coursed dry-stone
// W: the wall being built (set per run): wb / k / wt half thickness at the foot, batter per
// metre, minimum; y0 first course bottom (sunk); H(a) height; base(x, z) ground (null = 0);
// ta(a, y) course time (built); td(a, y0, y1, h) tumble time (decay; > 1 = stands and
// weathers); chev(a) chevron band; band [y, h] the band course; sd seed.
let W = null, WEA = false;
const MC = [0, 0, 0];
function vx(b, x, y, z, nx, ny, nz) {
  if (WEA) b.morph(y, y, MC[0], MC[1], MC[2]);
  return b.vertex(x, y, z, nx, ny, nz);
}
function wcol(b, cr, cg, cb, y, sh) {
  const st = 1 - 0.3 * sst(0.9, -0.3, y);
  const r = cr * st * sh, g = cg * st * sh, bl = cb * st * sh * 0.97;
  b.color(r, g, bl);
  MC[0] = r * 0.66; MC[1] = g * 0.68; MC[2] = bl * 0.6;
}
const wHalf = (y) => Math.max(W.wt, W.wb - W.k * y);
// one corner of a face: point o (path sample), side sg (+1 outer, -1 inner), height y
function corner(b, o, sg, y, yb, tilt, pil, cr, cg, cb, sh) {
  const w = wHalf(y), nx = o[3], nz = -o[2];
  wcol(b, cr, cg, cb, y, sh);
  b.ao(sg > 0 ? 0.78 + 0.22 * clamp01(y / 1.6) : 0.7 + 0.2 * clamp01(y / 2));
  return vx(b, o[0] + sg * nx * w, yb + y, o[1] + sg * nz * w,
    sg * nx + o[2] * pil, W.k + tilt, sg * nz + o[3] * pil);
}
function block(b, s0, s1, y0, y1, a, k, j, e0, e1) {
  const sd = W.sd + k * 131 + j * 7, h1 = hr(sd, 1, 3), h2 = hr(sd, 2, 3), h3 = hr(sd, 3, 3);
  ptAt(s0, A0); ptAt(s1, A1);
  const yb0 = W.base ? W.base(A0[0], A0[1]) : 0, yb1 = W.base ? W.base(A1[0], A1[1]) : 0;
  b.timeless();
  const ta = W.ta(a, y0) + 0.012 * h1;
  b.appear(ta, ta + 0.02, RISE, CH, BY.BUILT);
  const td = W.td(a, y0, y1, h2);
  WEA = td > 1;
  if (WEA) b.vanish(0, 0.7, MORPH, 0, BY.DECAY); else b.vanish(td, td + 0.012, POP, 0, BY.DECAY);
  const g = 0.8 + 0.36 * h3, wm = h1 < 0.22 ? 0.6 : 0;
  const cr = (GR[0] + (WARM[0] - GR[0]) * wm) * g, cg = (GR[1] + (WARM[1] - GR[1]) * wm) * g, cb = (GR[2] + (WARM[2] - GR[2]) * wm) * g;
  const chev = W.chev && y1 - y0 > 0.9 && W.chev(a);
  for (let sg = -1; sg <= 1; sg += 2) {
    if (sg > 0 && chev) { chevron(b, s0, s1, y0, y1, yb0, yb1, cr, cg, cb); continue; }
    const v0 = corner(b, A0, sg, y0, yb0, -0.3, -0.2, cr, cg, cb, 1), v1 = corner(b, A1, sg, y0, yb1, -0.3, 0.2, cr, cg, cb, 1);
    const v2 = corner(b, A1, sg, y1, yb1, 0.32, 0.2, cr, cg, cb, 1), v3 = corner(b, A0, sg, y1, yb0, 0.32, -0.2, cr, cg, cb, 1);
    b.quad(v0, v1, v2, v3);
  }
  // cap (the wall's top wherever this is the highest course standing)
  const w1 = wHalf(y1);
  wcol(b, cr, cg, cb, 9, 1.1); b.ao(1);
  const c0 = vx(b, A0[0] + A0[3] * w1, yb0 + y1, A0[1] - A0[2] * w1, 0, 1, 0), c1 = vx(b, A1[0] + A1[3] * w1, yb1 + y1, A1[1] - A1[2] * w1, 0, 1, 0);
  const c2 = vx(b, A1[0] - A1[3] * w1, yb1 + y1, A1[1] + A1[2] * w1, 0, 1, 0), c3 = vx(b, A0[0] - A0[3] * w1, yb0 + y1, A0[1] + A0[2] * w1, 0, 1, 0);
  b.quad(c0, c1, c2, c3);
  // ends: at entrances, run ends and wherever the block may fall (the breach shows solid)
  if (e0 || e1 || !WEA) {
    for (let e = 0; e < 2; e++) {
      if (!(e ? e1 : e0) && WEA) continue;
      const o = e ? A1 : A0, yb = e ? yb1 : yb0, sg = e ? 1 : -1, nx = o[2] * sg, nz = o[3] * sg;
      wcol(b, cr, cg, cb, y1, 0.92); b.ao(0.85);
      const wa = wHalf(y0), wb = wHalf(y1);
      const q0 = vx(b, o[0] + o[3] * wa, yb + y0, o[1] - o[2] * wa, nx, 0, nz), q1 = vx(b, o[0] - o[3] * wa, yb + y0, o[1] + o[2] * wa, nx, 0, nz);
      const q2 = vx(b, o[0] - o[3] * wb, yb + y1, o[1] + o[2] * wb, nx, 0, nz), q3 = vx(b, o[0] + o[3] * wb, yb + y1, o[1] - o[2] * wb, nx, 0, nz);
      b.quad(q0, q1, q2, q3);
    }
  }
}
// The chevron band: each block one upward-pointing chevron of pale stones set on edge between
// two dark recessed triangles, so the band zig-zags along the top of the wall.
function chevron(b, s0, s1, y0, y1, yb0, yb1, cr, cg, cb) {
  ptAt((s0 + s1) * 0.5, AM);
  const ybm = (yb0 + yb1) * 0.5;
  const P = (o, y, yb, tilt, sh, ao) => {
    const w = wHalf(y), nx = o[3], nz = -o[2];
    wcol(b, cr, cg, cb, y, sh); b.ao(ao);
    return vx(b, o[0] + nx * w, yb + y, o[1] + nz * w, nx, W.k + tilt, nz);
  };
  b.tri(P(A0, y0, yb0, 0.45, 1.2, 1), P(AM, y1, ybm, 0.45, 1.2, 1), P(A1, y0, yb1, 0.45, 1.2, 1));
  b.tri(P(A0, y0, yb0, -0.4, 0.55, 0.6), P(A0, y1, yb0, -0.4, 0.55, 0.6), P(AM, y1, ybm, -0.4, 0.55, 0.6));
  b.tri(P(AM, y1, ybm, -0.4, 0.55, 0.6), P(A1, y1, yb1, -0.4, 0.55, 0.6), P(A1, y0, yb1, -0.4, 0.55, 0.6));
}
// Lay the wall W along the current path, course by course with staggered joints.
function wallRun(b, closedEnds) {
  const S = PS[PN - 1];
  let y0 = W.y0;
  for (let k = 0; k < 40; k++) {
    let ch = CH;
    if (W.band && y0 >= W.band[0] - 0.01 && y0 < W.band[0] + 0.3) ch = W.band[1];
    const y1 = y0 + ch, off = k & 1 ? BL * 0.5 : 0;
    let s0 = 0, j = 0, any = false;
    while (s0 < S - 0.05) {
      let s1 = off > 0 && j === 0 ? off : s0 + BL;
      if (s1 > S - 0.4) s1 = S;
      ptAt((s0 + s1) * 0.5, Q);
      const a = Q[4], H = W.H(a);
      if (y0 < H - 0.25) {
        any = true;
        block(b, s0, s1, y0, y1 > H - 0.25 ? H : y1, a, k, j, s0 === 0 && closedEnds, s1 === S && closedEnds);
      }
      s0 = s1; j++;
    }
    if (!any) break;
    y0 = y1;
  }
  b.timeless();
}

// ------------------------------------------------------------------------- enclosure walls
const ZONES = [[0.8, 0.36, 0.2], [-1.3, 0.28, 0.3], [2.18, 0.15, 0.42]]; // tumbled: angle, half width, start
const outerH = (a) => 6.2 + 4.8 * (1 - sst(0.85, 1.7, Math.abs(wrap(a - Math.PI))));
function outerTd(a, y0, y1, h) {
  const H = outerH(a);
  for (let i = 0; i < 3; i++) {
    const z = ZONES[i], bm = bump(wrap(a - z[0]), z[1]);
    if (bm > 0) {
      const keep = H * (1 - 0.9 * bm) + 1.1 * (h - 0.5);
      if (y1 > keep) return z[2] + 0.2 * clamp01(1 - (y0 - keep) / (H - keep + 0.01)) + 0.025 * h;
    }
  }
  if (Math.abs(wrap(a - Math.PI)) > 0.95 && y0 > H - 1.3 && h < 0.33) return 0.3 + h;
  return 2;
}
const OUTER = {
  wb: 2.4, k: 0.1, wt: 1.1, y0: -0.35, H: outerH, base: null, sd: 101,
  ta: (a, y) => 0.05 + 0.58 * clamp01(y / 11) + 0.1 * Math.abs(wrap(a)) / Math.PI,
  td: outerTd, chev: (a) => Math.abs(wrap(a - Math.PI)) < 0.8, band: [8.4, 1.1],
};
const INNER = {
  wb: 1.25, k: 0.04, wt: 0.8, y0: -0.35, base: null, sd: 303, chev: null, band: null,
  H: (a) => 7 - 1.5 * sst(Math.PI + 0.6, Math.PI + 0.8, a) - 1.2 * sst(Math.PI - 0.3, Math.PI - 0.42, a),
  ta: (a, y) => 0.32 + 0.33 * clamp01(y / 7) + 0.05 * (a - Math.PI + 0.42),
  td: () => 2,
};
const GATES = [-0.75, 0.3, 1.95];

// ---------------------------------------------------------------------------- hill walls
// [ring radius (x HR), from angle, to angle, height, start, tumbles at]
const HILLW = [[0.6, 2.45, 3.85, 4.6, 0.06, 2], [0.32, 1.75, 3.0, 4.0, 0.14, 2], [0.47, 4.0, 5.2, 4.2, 0.2, 0.34], [0.66, 0.9, 1.75, 3.6, 0.26, 2]];

// --------------------------------------------------------------------------------- parts
function man(b, x, z, yaw, pose, s) {
  const k = 0.75 + 0.5 * hr(s, 1, 7), t = hr(s, 3, 7);
  b.surface(SURF.HIDE).ao(1).emissive(0, 0);
  if (t < 0.4) b.color(0.12 * k, 0.08 * k, 0.05 * k);
  else if (t < 0.7) b.color(0.3 * k, 0.07 * k, 0.04 * k); // red cloth
  else b.color(0.17 * k, 0.12 * k, 0.08 * k);
  b.push(); b.at(x, 0.02, z, yaw); b.human(pose, 1.6 + 0.16 * hr(s, 2, 7), s); b.pop();
}
// Round daga house: clay wall (grows, then melts down to a stub that grasses over), conical
// thatch (sags flat and goes), optional cooking smoke tied to src.
function hut(b, x, z, r, ta, td, sd, smoke, src) {
  b.push(); b.at(x, 0, z, hr(sd, 1, 9) * TAU);
  b.timeless().pivot(0, 0, 0).appear(ta, ta + 0.03, GROW, 0, BY.BUILT).reach(2.25).vanish(td + 0.08, td + 0.3, CLIP, 0, BY.DECAY);
  const c = 0.9 + 0.2 * hr(sd, 2, 9);
  b.color(0.34 * c, 0.19 * c, 0.1 * c).surface(SURF.PLASTER).ao(1).emissive(0, 0);
  b.cylinder(r, 2.1, 14, false);
  b.color(0.33 * c, 0.17 * c, 0.085 * c).ao(0.9);
  b.cylinder(r + 0.08, 0.35, 14, false); // plinth
  b.color(0.04, 0.03, 0.025).ao(0.4).surface(SURF.PLAIN);
  b.box(0, 0.8, r - 0.02, 0.36, 0.8, 0.06);
  b.timeless().pivot(0, 2.0, 0).appear(ta + 0.03, ta + 0.055, GROW, 0, BY.BUILT).reach(2.9).vanish(td, td + 0.07, CLIP, 0, BY.DECAY);
  const t = 0.9 + 0.2 * hr(sd, 3, 9);
  b.color(0.4 * t, 0.3 * t, 0.15 * t).surface(SURF.THATCH).ao(1);
  b.lathe([r + 0.85, 1.85, r + 0.5, 2.25, r * 0.55, 3.35, 0.06, 4.8], 14);
  if (smoke) {
    b.timeless().appear(ta + 0.06, ta + 0.07, POP, 0, BY.BUILT).vanish(td - 0.04, td, POP, 0, BY.DECAY);
    b.smoke(0, 4.8, 0, { count: 18, size: 1.3, rise: 26, density: 0.3, color: [0.44, 0.44, 0.48], src });
  }
  const sv = Math.min(0.69, 0.58 + 0.1 * hr(sd, 4, 9));
  b.timeless().appear(td + 0.24, td + 0.27, POP, 0, BY.DECAY).pivot(0, 0, 0).reach(0.5).vanish(sv - 0.06, sv, CLIP, 0, BY.DECAY);
  b.color(0.27, 0.16, 0.09).surface(SURF.EARTH).ao(0.9);
  b.cylinder(r, 0.45, 14, true);
  b.timeless(); b.pop();
}
function granary(b, x, z, ta, td, sd) {
  b.push(); b.at(x, 0, z, hr(sd, 1, 4) * TAU);
  b.timeless().pivot(0, 0, 0).appear(ta, ta + 0.03, GROW, 0, BY.BUILT).vanish(td, td + 0.02, POP, 0, BY.DECAY);
  b.color(0.3, 0.28, 0.25).surface(SURF.STONE).ao(0.85);
  for (let i = 0; i < 3; i++) { b.push(); b.translate(Math.cos(i * 2.1) * 0.5, 0.25, Math.sin(i * 2.1) * 0.5); b.rock(0.3, 0.3, 0.3, 1, 0.2, sd + i, 2, 0.3); b.pop(); }
  b.color(0.38, 0.2, 0.1).surface(SURF.PLASTER).ao(1);
  b.push(); b.translate(0, 1.25, 0); b.ellipsoid(0.75, 0.8, 0.75, 2); b.pop();
  b.color(0.4, 0.3, 0.15).surface(SURF.THATCH);
  b.lathe([1.0, 1.8, 0.05, 2.65], 10);
  b.timeless(); b.pop();
}
function cow(b, x, z, yaw, sd, td) {
  b.push(); b.at(x, 0, z, yaw);
  b.timeless().vanish(td, td + 0.01, POP, 0, BY.DECAY);
  const t = hr(sd, 1, 5);
  if (t < 0.4) b.color(0.17, 0.075, 0.04); else if (t < 0.7) b.color(0.33, 0.3, 0.26); else b.color(0.07, 0.055, 0.045);
  b.surface(SURF.HIDE).ao(1);
  b.push(); b.translate(0, 1.05, 0); b.ellipsoid(0.36, 0.42, 0.95, 2); b.pop();
  b.push(); b.translate(0, 1.42, 0.55); b.ellipsoid(0.2, 0.18, 0.26, 1); b.pop();
  const gz = hr(sd, 2, 5) < 0.5, hy = gz ? 0.35 : 0.95;
  b.beam(0, 1.2, 0.8, 0, hy + 0.2, 1.4, 0.2, 0.13, 5);
  b.beam(0, hy + 0.2, 1.4, 0, hy, 1.72, 0.13, 0.09, 5);
  for (let i = 0; i < 4; i++) { const sx = i & 1 ? 0.2 : -0.2, sz = i & 2 ? 0.62 : -0.62; b.beam(sx, 0.9, sz, sx, 0, sz, 0.08, 0.05, 4); }
  b.beam(0, 1.25, -0.95, 0, 0.55, -1.08, 0.03, 0.02, 3);
  b.color(0.5, 0.46, 0.38);
  for (let s = -1; s <= 1; s += 2) b.beam(s * 0.08, hy + 0.32, 1.42, s * 0.42, hy + 0.72, 1.32, 0.05, 0.015, 4);
  b.timeless(); b.pop();
}
// Tree of the ruin (fig / msasa): grows in with the decay, or timeless when t0 < 0.
function tree(b, x, z, h, cr, t0, sd) {
  b.timeless();
  if (t0 >= 0) b.pivot(x, 0, z).appear(t0, t0 + 0.16, SCALE, 0, BY.DECAY);
  b.color(0.13, 0.1, 0.08).surface(SURF.WOOD).ao(0.9);
  const lx = (hr(sd, 1, 2) - 0.5) * 0.25 * h, lz = (hr(sd, 2, 2) - 0.5) * 0.25 * h;
  b.beam(x, -0.2, z, x + lx, h * 0.62, z + lz, 0.07 * h, 0.04 * h, 6);
  b.surface(SURF.PLAIN);
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7 + sd, px = x + lx + Math.cos(a) * cr * 0.55, pz = z + lz + Math.sin(a) * cr * 0.55, py = h * (0.78 + 0.08 * hr(sd, i, 3));
    b.color(0.13, 0.1, 0.08).ao(0.9);
    b.beam(x + lx, h * 0.6, z + lz, px, py - 0.4, pz, 0.03 * h, 0.018 * h, 5);
    const g = 0.85 + 0.3 * hr(sd, i, 4);
    b.color(0.075 * g, 0.1 * g, 0.035 * g).ao(1);
    b.push(); b.translate(px, py, pz); b.ellipsoid(cr * 0.62, cr * 0.3, cr * 0.62, 2); b.pop();
  }
  b.color(0.085, 0.11, 0.04);
  b.push(); b.translate(x + lx, h * 0.9, z + lz); b.ellipsoid(cr * 0.7, cr * 0.32, cr * 0.7, 2); b.pop();
  b.timeless();
}
// Aloe: a grey-green rosette with a branched stalk of red-orange flower spikes (the accent).
function aloe(b, x, y, z, s, t0, sd) {
  b.timeless();
  if (t0 >= 0) b.pivot(x, y, z).appear(t0, t0 + 0.1, GROW, 0, BY.DECAY);
  b.push(); b.translate(x, y, z); b.scale(s, s, s);
  b.color(0.15, 0.19, 0.12).surface(SURF.PLAIN).ao(0.95);
  for (let i = 0; i < 9; i++) { const a = i * 0.7 + sd, c = Math.cos(a), sn = Math.sin(a), u = 0.45 + 0.3 * (i % 3) / 2; b.beam(0, 0.1, 0, c * u, 0.35 + 0.25 * (i % 2), sn * u, 0.08, 0.01, 4); }
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + sd, tx = Math.cos(a) * 0.3, tz = Math.sin(a) * 0.3, th = 1.3 + 0.25 * i;
    b.color(0.22, 0.17, 0.1); b.beam(0, 0.3, 0, tx, th, tz, 0.03, 0.02, 4);
    b.color(0.66, 0.16, 0.04); b.push(); b.translate(tx, th - 0.05, tz); b.cone(0.1, 0.45, 5); b.pop();
  }
  b.pop(); b.timeless();
}
function granite(b, sd, sh) {
  const g = (0.88 + 0.24 * hr(sd, 1, 11)) * sh, w = hr(sd, 2, 11) < 0.35;
  b.color((w ? 0.29 : 0.27) * g, (w ? 0.25 : 0.255) * g, (w ? 0.2 : 0.225) * g).surface(SURF.STONE).ao(1).emissive(0, 0);
}
function boulder(b, x, y, z, rx, ry, rz, sd) {
  granite(b, sd, 1);
  b.push(); b.at(x, y, z, hr(sd, 3, 11) * TAU);
  b.rock(rx, ry, rz, 4, 0.07, sd, 1, 0.3);
  b.pop();
}
// stack of dressed blocks waiting at the wall foot
function pile(b, x, z, yaw, sd, tv) {
  b.push(); b.at(x, 0, z, yaw);
  b.timeless().vanish(tv, tv + 0.02, POP, 0, BY.BUILT);
  for (let l = 0; l < 3; l++) for (let i = 0; i < 6 - l * 2; i++) {
    const g = 0.85 + 0.3 * hr(sd, l * 9 + i, 6);
    b.color(GR[0] * g, GR[1] * g, GR[2] * g).surface(SURF.STONE).ao(0.85 + 0.05 * l);
    b.box((i - (5 - l * 2) * 0.5) * 0.74 + 0.1 * hr(sd, i, l), 0.15 + l * 0.29, 0.1 * hr(sd, i, 7 + l), 0.34, 0.14, 0.23);
  }
  b.timeless(); b.pop();
}

export default {
  id: 'great-zimbabwe',
  name: 'Great Zimbabwe',
  caption: 'Shona masons raise the Great Enclosure',
  year: 1300,
  radius: 92,
  pad: 94, // road centre line at x = -100: the enclosure's front wall stands 45 m from it
  straddlesRoad: false,
  biome: 'savannah',
  live: true,
  viewSunAz: 2.2,
  lights: [{ pos: [-18, 0.6, 3], color: [1.0, 0.55, 0.22], intensity: 40, range: 18, flicker: 0.6, vanish: [0.02, 0.12] }],
  detail: { at: [TWX, 5, TWZ], from: [-62, 13.5, -6] },
  strip: { at: [-15, 6, -6], from: [-118, 42, 66], fov: 0.62 },
  // Event moment: high on the road side, toward the approach, over the chevron wall into the
  // enclosure with the conical tower, the houses and the boulder hill behind.
  witness: { at: [-8, -6], look: 8, dist: 150, height: 44, az: 0.5, fov: 0.6, drift: 0.08 },
  // Homesteads in the hills around: two or three houses, a granary and cooking smoke among
  // granite boulders; built as the capital grows, deserted early in the decay.
  satellites: {
    count: [5, 7], near: 2, nearR: [150, 260], farR: [340, 950],
    centre: 0.2, spread: 4.4, minSep: 110, roadClear: 45,
    build(b, k, n, dist) {
      const s = 1 + 0.6 * Math.min(1, dist / 900), ta = 0.08 + 0.4 * k / n, td = 0.03 + 0.12 * k / n, sd = 900 + k * 17;
      b.push(); b.scale(s, s, s);
      boulder(b, 9, 1.2, -6, 5, 3.6, 4.2, sd);
      boulder(b, 13, 0.6, -1, 3, 2.4, 2.6, sd + 1);
      hut(b, 0, 0, 2.8, ta, td, sd + 2, true, FLICKER.OWN);
      if (k & 1) hut(b, -7, 4, 2.4, ta + 0.04, td + 0.03, sd + 3, false, 0);
      granary(b, 4, 5, ta, td + 0.05, sd + 4);
      b.pop();
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 7 + 3;
    const BG = b.bio('ground');

    // --- enclosure floor: trampled red earth, grassing over in the decay
    b.timeless().surface(SURF.EARTH).emissive(0, 0).vanish(0, 0.7, MORPH, 0, BY.DECAY);
    b.push(); b.translate(EX, 0, EZ); b.scale(1, 1, EC / EA);
    b.disc(EA - 1.2, 56, 6, (x, z) => {
      const n = 0.82 + 0.36 * noise3(x * 0.15, 0.3, z * 0.2);
      b.color(0.3 * n, 0.175 * n, 0.095 * n).ao(1).morph(0.03, 0.03, BG[0] * 0.8 * n, BG[1] * 0.85 * n, BG[2] * 0.7 * n);
      return 0.03;
    });
    b.pop(); b.timeless();
    yield;

    // --- the hill: a granite whaleback, grassy at its foot
    b.surface(SURF.STONE).emissive(0, 0);
    b.push(); b.translate(HX, 0, HZ);
    b.disc(HR * 1.06, 64, 18, (x, z) => {
      const y = hillY(x + HX, z + HZ), n = noise3((x + HX) * 0.09, 1.7, (z + HZ) * 0.09);
      const rk = sst(3, 8, y + 4 * (n - 0.5)), g = 0.82 + 0.3 * n;
      b.color((BG[0] * 0.8 + (0.27 - BG[0] * 0.8) * rk) * g, (BG[1] * 0.85 + (0.255 - BG[1] * 0.85) * rk) * g, (BG[2] * 0.85 + (0.225 - BG[2] * 0.85) * rk) * g)
        .ao(0.8 + 0.2 * sst(-0.5, 3, y));
      return y;
    });
    b.pop();
    // boulders: the crest pile first, then the scattered ones, kept off the hill walls
    const onWall = (x, z, r) => {
      const dx = x - HX, dz = z - HZ, rr = Math.hypot(dx, dz) / HR, a = Math.atan2(dz, dx);
      for (const w of HILLW) {
        const aa = ((a - w[1]) % TAU + TAU) % TAU;
        if (aa < w[2] - w[1] + 0.15 && Math.abs(rr - w[0]) * HR < r + 2.2) return true;
      }
      return false;
    };
    const CREST = [[-2, 3, 8, 6.2, 7], [7, -5, 7, 5.6, 6], [-3, -10, 5.5, 4.5, 5], [12, 6, 5, 4.2, 6], [-9, -2, 4.5, 3.8, 4]];
    for (let i = 0; i < CREST.length; i++) {
      const c = CREST[i], x = HX + c[0], z = HZ + c[1];
      boulder(b, x, hillY(x, z) + c[3] * 0.55, z, c[2], c[3], c[4], sd + 20 + i);
    }
    boulder(b, HX + 1, hillY(HX, HZ) + 11.3, HZ + 0.5, 4.2, 3.2, 3.6, sd + 30); // balanced on top
    for (let i = 0, m = 0; i < 60 && m < 16; i++) {
      const a = hr(i, 1, sd) * TAU, rr = 0.2 + 0.68 * Math.sqrt(hr(i, 2, sd)), s = 1.6 + 3.6 * hr(i, 3, sd) * (1 - rr * 0.5);
      const x = HX + Math.cos(a) * rr * HR, z = HZ + Math.sin(a) * rr * HR * 0.92;
      if (onWall(x, z, s) || Math.hypot(x, z) > 86) continue;
      m++;
      boulder(b, x, hillY(x, z) + s * 0.45, z, s * (1 + 0.3 * hr(i, 4, sd)), s * 0.8, s, sd + 40 + i);
    }
    // boulders on the plain (kopje outliers)
    const PB = [[-66, -36, 4.5], [-60, -44, 3], [-8, 72, 4], [-1, 76, 2.6], [46, 56, 5], [52, 50, 3.2], [-70, 20, 2.4]];
    for (let i = 0; i < PB.length; i++) boulder(b, PB[i][0], PB[i][2] * 0.5, PB[i][1], PB[i][2] * 1.2, PB[i][2], PB[i][2], sd + 80 + i);
    yield;

    // --- hill walls along the contours between the boulders
    for (let i = 0; i < HILLW.length; i++) {
      const w = HILLW[i];
      PN = 0;
      const n = Math.ceil((w[2] - w[1]) * w[0] * HR / 0.6);
      for (let q = 0; q <= n; q++) {
        const a = w[1] + (w[2] - w[1]) * q / n, rr = w[0] * HR * (1 + 0.05 * Math.sin(a * 5 + i));
        pt(HX + Math.cos(a) * rr, HZ + Math.sin(a) * rr * 0.92, q / n);
      }
      const t0 = w[4], tz = w[5];
      W = {
        wb: 1.3, k: 0.08, wt: 0.75, y0: -1.6, H: (a) => w[3] * (0.85 + 0.15 * Math.sin(a * 9 + i)), base: hillY, sd: 500 + i * 50,
        ta: (a, y) => t0 + 0.2 * clamp01(y / 4.6) + 0.08 * a, chev: null, band: null,
        td: (a, y0, y1, h) => (tz < 1 && a > 0.25 && a < 0.75 && y1 > 1.2 + 2 * Math.abs(a - 0.5) * 4 * (h - 0.2) ? tz + 0.2 * (1 - clamp01(y0 / 4.6)) + 0.03 * h : 2),
      };
      wallRun(b, true);
    }
    yield;

    // --- the Great Enclosure: three runs between the entrances
    W = OUTER;
    for (let i = 0; i < 3; i++) {
      const g0 = GATES[i], g1 = i < 2 ? GATES[i + 1] : GATES[0] + TAU;
      const sp0 = Math.hypot(EA * Math.sin(g0), EC * Math.cos(g0)), sp1 = Math.hypot(EA * Math.sin(g1), EC * Math.cos(g1));
      ellipsePath(g0 + 1.1 / sp0, g1 - 1.1 / sp1, 0);
      wallRun(b, true);
      yield;
    }
    // the inner wall of the parallel passage
    W = INNER;
    ellipsePath(Math.PI - 0.42, Math.PI + 0.8, 4.5);
    wallRun(b, true);
    // monoliths set along the top of the tall front
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + (i - 3) * 0.2, c = Math.cos(a), s = Math.sin(a);
      const ta = OUTER.ta(a, 10.6) + 0.04;
      b.timeless().appear(ta, ta + 0.02, RISE, 1.6, BY.BUILT).vanish(0, 0.7, MORPH, 0, BY.DECAY);
      granite(b, sd + 200 + i, 1.05);
      b.push(); b.at(EX + EA * c, 11, EZ + EC * s, Math.atan2(EC * c, EA * s));
      b.block(0.32, 0.22, 0.24, 0.18, 1.5 + 0.5 * hr(i, 5, sd));
      b.pop();
    }
    b.timeless();
    yield;

    // --- the conical tower (solid, coursed) and the small tower beside it
    for (let tw = 0; tw < 2; tw++) {
      const cx = tw ? TWX + 4.2 : TWX, cz = tw ? TWZ - 3.1 : TWZ, R0 = tw ? 1.4 : 2.8, R1 = tw ? 0.85 : 1.15, Ht = tw ? 4.4 : 10.2;
      const N = tw ? 16 : 28, t0 = tw ? 0.6 : 0.5, t1 = tw ? 0.72 : 0.82;
      for (let k = 0, y0 = -0.3; y0 < Ht - 0.05; k++, y0 += 0.5) {
        const y1 = Math.min(Ht, y0 + 0.5), ta = t0 + (t1 - t0) * clamp01(y0 / Ht);
        const rad = (y) => R0 + (R1 - R0) * Math.pow(clamp01(y / Ht), 1.15);
        const r0 = rad(y0), r1 = rad(y1), sl = (r0 - r1) / (y1 - y0);
        b.timeless().appear(ta, ta + 0.02, RISE, 0.5, BY.BUILT);
        WEA = !(tw === 0 && y0 > Ht - 1.1);
        if (WEA) b.vanish(0, 0.7, MORPH, 0, BY.DECAY); else b.vanish(0.44 + 0.04 * hr(k, 1, sd), 0.452 + 0.04 * hr(k, 1, sd), POP, 0, BY.DECAY);
        b.surface(SURF.STONE).emissive(0, 0);
        const off = k & 1 ? 0.5 : 0;
        for (let i = 0; i < N; i++) {
          const a0 = (i + off) / N * TAU, a1 = (i + 1 + off) / N * TAU, h = hr(k * 61 + i, 7, sd + tw);
          const g = 0.8 + 0.36 * h, wm = hr(k * 61 + i, 8, sd) < 0.2 ? 0.6 : 0;
          const cr = (GR[0] + (WARM[0] - GR[0]) * wm) * g, cg = (GR[1] + (WARM[1] - GR[1]) * wm) * g, cb = (GR[2] + (WARM[2] - GR[2]) * wm) * g;
          const V = (a, y, r, tilt, pil) => {
            const c = Math.cos(a), s = Math.sin(a);
            wcol(b, cr, cg, cb, y, 1); b.ao(0.8 + 0.2 * clamp01(y / 1.5));
            return vx(b, cx + c * r, y, cz + s * r, c - s * pil, sl + tilt, s + c * pil);
          };
          b.quad(V(a0, y0, r0, -0.3, -0.18), V(a1, y0, r0, -0.3, 0.18), V(a1, y1, r1, 0.32, 0.18), V(a0, y1, r1, 0.32, -0.18));
        }
        wcol(b, GR[0], GR[1], GR[2], 9, 1.05); b.ao(1);
        const c0 = vx(b, cx, y1, cz, 0, 1, 0);
        let p = -1, f = -1;
        for (let i = 0; i <= N; i++) {
          const a = (i % N) / N * TAU, v = vx(b, cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, 0, 1, 0);
          if (p >= 0) b.tri(c0, p, v); else f = v;
          p = v;
        }
      }
    }
    b.timeless();
    yield;

    // --- rubble where the wall tumbles (and below the fallen hill wall)
    for (let zi = 0; zi < 3; zi++) {
      const z = ZONES[zi], nr = zi === 2 ? 5 : 14;
      for (let i = 0; i < nr; i++) {
        const u = hr(i, 1, zi + sd) * 2 - 1, a = z[0] + u * z[1] * 0.85, side = hr(i, 2, zi) < 0.6 ? 1 : -1;
        const c = Math.cos(a), s = Math.sin(a), nx = EC * c, nz = EA * s, nl = Math.hypot(nx, nz);
        const d = side * (2.2 + 4 * hr(i, 3, zi)), x = EX + EA * c + nx / nl * d, zz = EZ + EC * s + nz / nl * d, r = 0.45 + 0.6 * hr(i, 4, zi);
        const t = z[2] + 0.05 + 0.15 * hr(i, 5, zi);
        b.timeless().pivot(x, 0, zz).appear(t, t + 0.06, GROW, 0, BY.DECAY);
        granite(b, sd + 300 + zi * 20 + i, 0.85);
        b.push(); b.at(x, r * 0.4, zz, u * 3); b.rock(r * 1.3, r, r, 2, 0.25, sd + i, 3, 0.3); b.pop();
      }
      // a low slumped heap along the breach
      const c = Math.cos(z[0]), s = Math.sin(z[0]);
      b.timeless().pivot(EX + EA * c, 0, EZ + EC * s).appear(z[2] + 0.08, z[2] + 0.25, GROW, 0, BY.DECAY);
      granite(b, sd + 360 + zi, 0.82);
      b.push(); b.at(EX + EA * c, -0.3, EZ + EC * s, Math.atan2(EC * c, EA * s) + Math.PI / 2); b.rock(z[1] * 30, 1.8, 3.4, 3, 0.18, sd + 50 + zi, 2, 0.6); b.pop();
    }
    b.timeless();
    yield;

    // --- houses, granaries, the hearth, the kraal and its cattle
    const HUT = [ // x, z, r, appear (built), smoke
      [-14, 13, 3.0, 0.8, 1], [-10, -6, 3.2, 0.84, 0], [-24, 26, 2.8, 0.88, 0],
      [8, 50, 3.0, 0.12, 1], [-9, 60, 3.2, 0.18, 0], [22, 44, 2.8, 0.26, 0], [33, 30, 3.0, 0.34, 1],
      [-3, -55, 3.0, 0.15, 1], [15, -61, 2.8, 0.22, 0], [33, -52, 3.0, 0.3, 0], [-46, -62, 3.0, 0.44, 0], [-58, 46, 2.8, 0.52, 1],
    ];
    for (let i = 0; i < HUT.length; i++) {
      const h = HUT[i], td = 0.05 + 0.13 * hr(i, 1, sd);
      hut(b, h[0], h[1], h[2], h[3], td, sd + 400 + i * 3, h[4] === 1, FLICKER.LIGHT0);
      if (i % 3 === 1) granary(b, h[0] + 5.5, h[1] + 2.5, h[3] + 0.03, 0.08 + 0.1 * hr(i, 2, sd), sd + 450 + i);
    }
    b.timeless().fire(-18, 0.03, 3, 1.0, 1, 1);
    // kraal: a ring of brush and stakes with the herd inside
    const KX = -30, KZ = 62;
    b.timeless().pivot(KX, 0, KZ).reach(1.5).vanish(0.1, 0.32, CLIP, 0, BY.DECAY);
    b.color(0.15, 0.105, 0.07).surface(SURF.WOOD).ao(0.9);
    for (let i = 0; i < 44; i++) {
      const a = i / 44 * TAU + 0.3;
      if (Math.abs(wrap(a - 3.6)) < 0.2) continue; // gate toward the enclosure
      const x = KX + Math.cos(a) * 8.5, z = KZ + Math.sin(a) * 8.5, l = (hr(i, 1, sd) - 0.5) * 0.6;
      b.beam(x, 0, z, x + Math.cos(a + 1.6) * 0.5, 1.3 + 0.3 * hr(i, 2, sd), z + Math.sin(a + 1.6) * 0.5 + l, 0.07, 0.04, 4, false);
      b.beam(x, 0.1, z, x + Math.cos(a + 1.6) * 1.2, 0.9, z + Math.sin(a + 1.6) * 1.2, 0.12, 0.03, 4, false);
    }
    const COW = [[-32, 60, 0.4], [-27, 64, 2.2], [-30, 66, -1.4], [-25, 59, 3.4], [-34, 64, 1.1], [-46, 40, 2.6], [-50, 36, 0.9]];
    for (let i = 0; i < COW.length; i++) cow(b, COW[i][0], COW[i][1], COW[i][2], sd + 500 + i, 0.03 + 0.06 * hr(i, 3, sd));
    // people living here: by the hearth, the houses and the kraal
    const PPL = [[-16.5, 4.2, -2.2, POSE.SIT], [-19.5, 1.5, 0.8, POSE.SIT], [-12, 9, 2.6, POSE.STAND], [-38, 56, 1.2, POSE.STAND], [-21, 67, -2.0, POSE.STAND], [11, 53, 3.6, POSE.KNEEL], [-1, -51, 0.2, POSE.STAND]];
    for (let i = 0; i < PPL.length; i++) {
      const t = 0.01 + 0.06 * i / PPL.length;
      b.timeless().vanish(t, t + 0.01, POP, 0, BY.DECAY);
      man(b, PPL[i][0], PPL[i][1], PPL[i][2], PPL[i][3], sd + 600 + i);
    }
    b.timeless();
    yield;

    // --- the works: stone piles and masons along the front, fire-setting on a boulder
    for (let i = 0; i < 5; i++) {
      const a = Math.PI + (i - 2) * 0.42, c = Math.cos(a), s = Math.sin(a), nx = EC * c, nz = EA * s, nl = Math.hypot(nx, nz);
      const x = EX + EA * c + nx / nl * 6.5, z = EZ + EC * s + nz / nl * 6.5, yw = Math.atan2(nx, nz);
      const tv = 0.72 + 0.04 * i;
      pile(b, x, z, yw + Math.PI / 2, sd + 700 + i, tv);
      b.timeless().vanish(tv, tv + 0.01, POP, 0, BY.BUILT);
      man(b, x + nx / nl * 1.6 + nz / nl * 1.4, z + nz / nl * 1.6 - nx / nl * 1.4, yw + Math.PI, POSE.KNEEL, sd + 720 + i);
      if (i & 1) man(b, x - nz / nl * 2.6, z + nx / nl * 2.6, yw - 0.6, POSE.HAUL, sd + 740 + i);
      if (i === 2) man(b, x + nx / nl * 3.4, z + nz / nl * 3.4, yw + 2.6, POSE.STAND, sd + 760);
    }
    // quarry: a boulder being split by fire, slabs lifted off its shoulder
    const QX = 10, QZ = -40;
    boulder(b, QX, 2.4, QZ, 7.5, 4.6, 6, sd + 800);
    b.timeless().vanish(0.8, 0.82, POP, 0, BY.BUILT);
    b.color(0.1, 0.07, 0.05).surface(SURF.WOOD).ao(0.9);
    for (let i = 0; i < 4; i++) b.beam(QX - 3 + i * 0.5, 4.9, QZ + 2.4, QX - 1.4 + i * 0.3, 4.6, QZ + 3.8, 0.12, 0.1, 4);
    b.flames(QX - 2.2, 5.0, QZ + 3.1, 1.4, FLICKER.OWN, sd);
    b.smoke(QX - 2.2, 6.2, QZ + 3.1, { count: 20, size: 1.4, rise: 22, density: 0.3, color: [0.4, 0.4, 0.44], src: FLICKER.OWN });
    granite(b, sd + 810, 1.08);
    for (let i = 0; i < 5; i++) { b.push(); b.at(QX - 9.5 + 0.2 * i, 0.12 + 0.24 * i, QZ - 1 + 0.15 * i, 0.3 + 0.1 * i); b.box(0, 0, 0, 1.3, 0.12, 0.7); b.pop(); }
    man(b, QX - 8.8, QZ + 2.4, 2.6, POSE.KNEEL, sd + 820);
    man(b, QX - 10.5, QZ - 3.2, 0.4, POSE.HAUL, sd + 821);
    man(b, QX - 6, QZ + 5, 3.2, POSE.STAND, sd + 822);
    b.timeless();
    yield;

    // --- vegetation: timeless trees around, the ruin's trees and aloes inside
    tree(b, -48, -70, 9, 5.5, -1, 1); tree(b, 70, 44, 10, 6, -1, 2); tree(b, -64, 30, 8, 5, -1, 3); tree(b, 30, 66, 9, 5.5, -1, 4);
    const RT = [[-18, 6, 13, 7], [-30, 20, 10, 5.5], [-8, -16, 11, 6], [-28, -32, 8, 4.5], [EX + EA * Math.cos(0.8), EZ + EC * Math.sin(0.8), 9, 5]];
    for (let i = 0; i < RT.length; i++) tree(b, RT[i][0], RT[i][1], RT[i][2], RT[i][3], 0.25 + 0.08 * i, 10 + i);
    for (let i = 0; i < 12; i++) {
      const a = hr(i, 1, sd + 9) * TAU, rr = 0.25 + 0.6 * hr(i, 2, sd + 9);
      const x = EX + Math.cos(a) * EA * rr, z = EZ + Math.sin(a) * EC * rr;
      if (Math.hypot(x - TWX, z - TWZ) < 5) continue;
      aloe(b, x, 0, z, 0.9 + 0.5 * hr(i, 3, sd), 0.3 + 0.3 * hr(i, 4, sd), i);
    }
    for (let i = 0; i < 9; i++) { // on the hill, among the boulders, always
      const a = hr(i, 5, sd) * TAU, rr = 0.3 + 0.55 * hr(i, 6, sd), x = HX + Math.cos(a) * rr * HR, z = HZ + Math.sin(a) * rr * HR * 0.92;
      if (onWall(x, z, 1)) continue;
      aloe(b, x, hillY(x, z) - 0.1, z, 1.1 + 0.4 * hr(i, 7, sd), -1, i + 20);
    }
    b.timeless();
    return b.counts();
  },
};
