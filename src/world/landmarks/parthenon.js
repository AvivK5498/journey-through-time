// Parthenon: the Doric marble temple of Athena on the Acropolis of Athens, 447-432 BCE.
// Contract: internal_docs/LANDMARKS.md.
//
// The rock: a steep limestone hill (plateau 26 m up) inside a stepped retaining wall, a ramp
// up its approach (+z) end to the Propylaea gateway with the Nike bastion; olives and
// cypresses on the slopes. On top: the temple at true scale (stylobate 30.9 x 69.5 m, 8 x 17
// fluted columns, entablature with painted triglyphs and taenia, low pediments with figures,
// marble-tiled roof, the cella with its porches) and the Erechtheion with its maidens' porch.
// Fluting is shading only: each flute's two arris vertices carry normals tilted toward the
// channel and the channel centre is darker.
//
// Live (def.live): built 0 = the old limestone podium, drum stacks and timber cranes;
//   0.02-0.1 krepis; 0.1-0.47 columns rise drum course by drum course (each lowered into
//   place), cella walls climb inside their scaffolds 0.14-0.5; capitals 0.48-0.53;
//   architrave, frieze, cornice 0.52-0.7; pediments 0.68-0.77; roof timbers 0.7, tiles laid
//   from both ends 0.76-0.9 (the roof last); scaffolds and cranes struck 0.84-0.95; pediment
//   figures 0.88; the paint is laid on 0.9-0.97; the Propylaea rises 0.72-0.95 and the
//   Erechtheion 0.92-1; the builders leave and visitors sit on the west steps.
// decay (the registry runs it 0 -> 0.7 over the year 1687): paint gone and visitors leave
//   0-0.07; the Propylaea roof blows off (1656) 0.03-0.06; 0.1 the powder magazine in the
//   cella explodes: flash, fire and a black smoke column; the roof is thrown up section by
//   section from the middle, seven columns of the road-side colonnade and four of the far
//   side topple outward (drums strewn in rows where they fell), the cella walls collapse to
//   their footings; rubble 0.13-0.28; west pediment's centre figures lost 0.2; the
//   Erechtheion roof falls 0.3-0.38; most east pediment figures removed 0.45-0.6; a few
//   modern visitors 0.6-0.66.

import { SURF, POSE, FLICKER, MOTION, BY, noise3, fbm3, seg } from './kit.js';

const TAU = Math.PI * 2;
const R = 124; // every vertex within this of the origin
const H = 26; // plateau height
const PHX = 44, PHZ = 74, PCR = 20; // plateau: rounded rectangle half sizes and corner radius
const GX = -8; // gateway axis (x) at the +z end
const TX = 6, TZ = -14; // temple centre
const SW = 15.45, SL = 34.75; // stylobate half width / half length
const XC = 14.45, ZC = 33.75; // corner column centres
const YS = 1.5, CH = 9.6, CR0 = 0.95, CAPH = 0.85; // stylobate top, shaft, base radius, capital
const YA = YS + CH + CAPH, YF = YA + 1.35, YC = YF + 1.35, YE = YC + 0.65; // architrave, frieze, cornice, eave
const WE = XC + 1.55, RISE = 3.8, RK = RISE / WE; // eave half width, roof rise, slope
const CW = 10.0, CZ0 = -25, CZ1 = 21; // cella outer half width, east / west wall lines
const EX = -27, EZ = -8; // Erechtheion
const PZC = 60; // Propylaea centre z
const NF = 16, ND = 5; // flutes, drums per column

const MARBLE = [0.62, 0.565, 0.47];
const LIMESTONE = [0.38, 0.355, 0.3];
const BLUE = [0.05, 0.11, 0.34];
const RED = [0.45, 0.075, 0.04];
const TIMBER = [0.2, 0.13, 0.075];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function hsh(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function c3(b, c, f) { return b.color(c[0] * f, c[1] * f, c[2] * f); }

// ---- the rock ---------------------------------------------------------------------------
const plat = (x, z) => H - 3.5 * sstep(30, 70, z); // plateau falls gently toward the gate
const PB = plat(GX, PZC); // Propylaea floor
function sdRR(x, z) {
  const qx = Math.abs(x) - (PHX - PCR), qz = Math.abs(z) - (PHZ - PCR);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - PCR;
}
const gateW = (x, z) => (z > 0 ? 1 - sstep(7, 15, Math.abs(x - GX)) : 0);
function hillH(x, z) {
  const r = Math.hypot(x, z);
  if (r > R - 1.5) return 0.02;
  const d = sdRR(x, z), p = plat(x, z);
  if (d <= 0) return p + 0.12 * noise3(x * 0.11, 0.5, z * 0.11);
  const n = fbm3(x * 0.035, 3.1, z * 0.035, 3);
  const dEnd = R - 3 - (r - d);
  const dn = d + 6 * (n - 0.5) * sstep(3, 12, d);
  let h;
  if (dn < 3) h = p - 8 * sstep(0, 2.6, dn);
  else if (dn < 15) h = (p - 8) + (0.42 * H - (p - 8)) * Math.pow(sstep(3, 15, dn), 0.8);
  else {
    const t = clamp01((dn - 15) / Math.max(4, dEnd - 15));
    h = 0.42 * H * Math.pow(1 - t, 1.6) + 5 * (n - 0.5) * t * (1 - t);
  }
  const g = gateW(x, z);
  if (g > 0) h += (Math.max(0.02, p - 0.5 * d) - h) * g;
  return Math.max(0.02, h * (1 - sstep(R - 9, R - 1.5, r)));
}
// hill colour (call after hillH for the same point)
let BG = null, BR = null;
function hillColor(b, x, z, h) {
  const d = sdRR(x, z), n = noise3(x * 0.05, 7.7, z * 0.05), n2 = noise3(x * 0.19, 2.2, z * 0.19);
  const r = Math.hypot(x, z), g = gateW(x, z);
  let cr, cg, cb, ao = 1;
  if (d <= 0) { // worn bedrock and dust on the summit
    const f = 0.88 + 0.16 * n + 0.06 * n2;
    cr = 0.5 * f; cg = 0.455 * f; cb = 0.37 * f;
  } else {
    const streak = noise3(x * 0.25, h * 0.12, z * 0.25);
    const f = 0.78 + 0.2 * n + 0.08 * n2;
    cr = BR[0] * f; cg = BR[1] * f; cb = BR[2] * f;
    const ochre = clamp01(streak * 1.6 - 0.5) * 0.5; // warm iron streaks down the cliff
    cr += (0.55 - cr) * ochre; cg += (0.4 - cg) * ochre; cb += (0.26 - cb) * ochre;
    const scrub = clamp01(sstep(12, 26, d) * (0.45 + 0.9 * (n2 - 0.25)));
    cr += (0.13 - cr) * scrub; cg += (0.16 - cg) * scrub; cb += (0.075 - cb) * scrub;
    const base = sstep(R - 22, R - 4, r);
    cr += (BG[0] - cr) * base; cg += (BG[1] - cg) * base; cb += (BG[2] - cb) * base;
    ao = 1 - 0.18 * sstep(10, 15, d) * (1 - sstep(15, 24, d));
  }
  if (g > 0.4 && h > 0.5) { const k = sstep(0.4, 0.9, g) * 0.8; cr += (0.54 - cr) * k; cg += (0.49 - cg) * k; cb += (0.4 - cb) * k; }
  b.color(cr, cg, cb).ao(ao);
}

// ---- fluted column ----------------------------------------------------------------------
const VI = new Int32Array(6);
const ECH = new Float64Array(8);
const FL = new Float64Array(4); // fall: decay time (< 0: stands), stub drums, tilt dx, dz
const rAt = (r0, r1, t) => r0 + (r1 - r0) * (0.55 * t + 0.45 * t * t); // gentle entasis
function drum(b, cx, cz, y0, y1, ra, rb, col, cap) {
  const st = TAU / NF, dr = (ra - rb) / (y1 - y0);
  for (let k = 0; k < NF; k++) {
    const a0 = 0.2 + k * st;
    for (let e = 0; e < 2; e++) {
      const y = e ? y1 : y0, r = e ? rb : ra;
      for (let s = 0; s < 3; s++) {
        const th = a0 + s * 0.5 * st, rr = s === 1 ? r * 0.955 : r, nt = th + (s === 0 ? 0.62 : s === 2 ? -0.62 : 0);
        if (s === 1) c3(b, col, 0.86).ao(0.72); else c3(b, col, 1).ao(1);
        VI[e * 3 + s] = b.vertex(cx + Math.cos(th) * rr, y, cz + Math.sin(th) * rr, Math.cos(nt), dr, Math.sin(nt));
      }
    }
    b.quad(VI[0], VI[1], VI[4], VI[3]); b.quad(VI[1], VI[2], VI[5], VI[4]);
  }
  if (cap) {
    c3(b, col, 0.95).ao(1);
    const c = b.vertex(cx, y1, cz, 0, 1, 0);
    for (let k = 0; k < NF; k++) {
      const a = 0.2 + k * st, a1 = a + st;
      const i0 = b.vertex(cx + Math.cos(a) * rb, y1, cz + Math.sin(a) * rb, 0, 1, 0);
      const i1 = b.vertex(cx + Math.cos(a1) * rb, y1, cz + Math.sin(a1) * rb, 0, 1, 0);
      b.tri(c, i0, i1);
    }
  }
}
function tagPart(b, cx, cz, py, t, fall) {
  b.timeless().pivot(cx, py, cz);
  if (t >= 0) b.appear(t, t + 0.012, MOTION.DROP, 2.0, BY.BUILT);
  if (fall) b.tiltDir(FL[2], FL[3]).vanish(FL[0], FL[0] + 0.05, MOTION.TILT, 0, BY.DECAY);
}
// column standing on y = by: nd drums from tA every dtA, capital at tCap (t < 0: no tags)
function column(b, cx, cz, by, h, r0, nd, tA, dtA, tCap, col) {
  const r1 = r0 * 0.79, dh = h / nd, falls = FL[0] >= 0, stub = FL[1] | 0, py = by + stub * dh;
  b.surface(SURF.STONE);
  for (let j = 0; j < nd; j++) {
    tagPart(b, cx, cz, py, tA < 0 ? -1 : tA + j * dtA, falls && j >= stub);
    drum(b, cx, cz, by + j * dh, by + (j + 1) * dh, rAt(r0, r1, j / nd), rAt(r0, r1, (j + 1) / nd), col, true);
  }
  tagPart(b, cx, cz, py, tCap, falls);
  ECH[0] = r1; ECH[1] = 0; ECH[2] = r1 * 1.08; ECH[3] = 0.12; ECH[4] = r1 * 1.36; ECH[5] = 0.42; ECH[6] = r1 * 1.4; ECH[7] = 0.5;
  const capH = 0.5 * r0 / CR0, abH = 0.35 * r0 / CR0;
  b.push(); b.translate(cx, by + h, cz); b.scale(1, capH / 0.5, 1);
  c3(b, col, 0.95).ao(0.85); b.lathe(ECH, 12);
  b.pop();
  c3(b, col, 1).ao(1);
  b.box(cx, by + h + capH + abH * 0.5, cz, r1 * 1.42, abH * 0.5, r1 * 1.42);
}

// ---- small builders ----------------------------------------------------------------------
const HX = new Float64Array(24);
function prism(b, x0, x1, z0, z1, y, rise, alongZ) { // gable roof: ridge along z (or x)
  if (alongZ) {
    const xm = (x0 + x1) / 2;
    HX.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, xm, y + rise, z0, xm, y + rise, z0, xm, y + rise, z1, xm, y + rise, z1]);
  } else {
    const zm = (z0 + z1) / 2;
    HX.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y + rise, zm, x1, y + rise, zm, x1, y + rise, zm, x0, y + rise, zm]);
  }
  b.hexa(HX, false);
}
// triangular slab in a plane z = const (pediment tympanum), half width w, rise h, thickness t
function gable(b, x, y, z, w, h, t) {
  HX.set([x - w, y, z - t, x + w, y, z - t, x + w, y, z + t, x - w, y, z + t, x, y + h, z - t, x, y + h, z - t, x, y + h, z + t, x, y + h, z + t]);
  b.hexa(HX, false);
}
// raking cornice along a pediment from x - w .. x + w, apex rise h, at z with depth hz
function raking(b, x, y, z, w, h, hz, th) {
  const L = Math.hypot(w, h) + 0.4, a = Math.atan2(h, w);
  for (let s = -1; s <= 1; s += 2) {
    b.push(); b.translate(x + s * w * 0.5, y + h * 0.5 + th * 0.5, z); b.rotateZ(-s * a);
    b.box(0, 0, 0, L * 0.5, th * 0.5, hz); b.pop();
  }
}
function olive(b, x, y, z, s, sd) {
  b.color(0.19, 0.155, 0.12).surface(SURF.WOOD).ao(0.9);
  const lx = (hsh(sd, 1, 3) - 0.5) * 0.8 * s, lz = (hsh(sd, 2, 3) - 0.5) * 0.8 * s;
  b.beam(x, y - 0.4, z, x + lx, y + 1.5 * s, z + lz, 0.3 * s, 0.22 * s, 5);
  b.beam(x + lx, y + 1.5 * s, z + lz, x + lx - 1.1 * s, y + 2.6 * s, z + lz + 0.4 * s, 0.17 * s, 0.1 * s, 4);
  b.beam(x + lx, y + 1.5 * s, z + lz, x + lx + 1.0 * s, y + 2.5 * s, z + lz - 0.5 * s, 0.17 * s, 0.1 * s, 4);
  b.surface(SURF.PLAIN).ao(1);
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + hsh(sd, i, 5) * 1.5, rr = 0.9 * s, g = 0.9 + 0.2 * hsh(sd, i, 6);
    b.color(0.15 * g, 0.18 * g, 0.115 * g);
    b.push(); b.translate(x + lx + Math.cos(a) * rr, y + (2.7 + 0.5 * hsh(sd, i, 7)) * s, z + lz + Math.sin(a) * rr);
    b.rock(1.5 * s, 0.95 * s, 1.4 * s, 2, 0.35, sd * 7 + i, 0, 0.2); b.pop();
  }
}
const CYP = new Float64Array([0.3, -0.5, 1.05, 1.4, 1.3, 4.5, 1.05, 8.5, 0.55, 12, 0.05, 14]);
function cypress(b, x, y, z, s) {
  b.color(0.035, 0.068, 0.038).surface(SURF.PLAIN).ao(0.95);
  b.push(); b.translate(x, y, z); b.scale(s, s, s); b.lathe(CYP, 9); b.pop();
}
function figure(b, x, y, z, yaw, pose, h, col, sd) {
  c3(b, col, 1).surface(SURF.HIDE).ao(1);
  b.push(); b.at(x, y, z, yaw); b.human(pose, h, sd); b.pop();
}
const ROBES = [[0.5, 0.47, 0.4], [0.09, 0.13, 0.3], [0.36, 0.11, 0.07], [0.42, 0.36, 0.24], [0.2, 0.22, 0.18]];

// ---- the temple's entablature, one bay at a time ------------------------------------------
// long: side along z at x = sg * XC; else an end along x at z = sg * ZC. u along, v outward.
function bx(b, long, sg, uc, vc, yc, hu, hv, hy) {
  if (long) b.box(sg * (XC + vc), yc, uc, hv, hy, hu); else b.box(uc, yc, sg * (ZC + vc), hu, hy, hv);
}
function paintTag(b, px, py, pz, t0) {
  b.timeless().pivot(px, py, pz).appear(t0, t0 + 0.06, MOTION.REVEAL, 30, BY.BUILT).vanish(0, 0.07, MOTION.FADE, 0, BY.DECAY);
}
function bayTag(b, t, brk) {
  b.timeless();
  if (brk >= 0) b.appear(t, t + 0.02, MOTION.POP, 0, BY.BUILT).vanish(brk, brk + 0.04, MOTION.DROP, 18, BY.DECAY);
  else b.appear(t, t + 0.02, MOTION.DROP, 1.5, BY.BUILT);
}
function bay(b, long, sg, ua, ub, u01, brk, last, sd) {
  const L = ub - ua, uc = (ua + ub) / 2, hu = Math.abs(L) / 2;
  b.surface(SURF.STONE);
  bayTag(b, 0.52 + 0.05 * u01, brk); c3(b, MARBLE, 0.97).ao(0.85);
  bx(b, long, sg, uc, 0, YA + 0.675, hu, 0.95, 0.675);
  bayTag(b, 0.58 + 0.05 * u01, brk); c3(b, MARBLE, 0.95).ao(0.9);
  bx(b, long, sg, uc, -0.05, YF + 0.675, hu, 0.9, 0.675);
  c3(b, MARBLE, 0.8).ao(0.8);
  for (let k = 0; k < (last ? 3 : 2); k++) bx(b, long, sg, ua + k * L / 2, 0.88, YF + 0.66, 0.42, 0.04, 0.64);
  c3(b, MARBLE, 1.02).surface(SURF.STONE).ao(0.9);
  for (let k = 0; k < 2; k++) { // metope reliefs
    const u = ua + (k * 2 + 1) * L / 4;
    b.push(); if (long) b.translate(sg * (XC + 0.86), YF + 0.68, u); else b.translate(u, YF + 0.68, sg * (ZC + 0.86));
    b.rock(long ? 0.12 : 0.5, 0.5, long ? 0.5 : 0.12, 1, 0.35, sd + k, 0, 0); b.pop();
  }
  bayTag(b, 0.63 + 0.05 * u01, brk); c3(b, MARBLE, 1).surface(SURF.STONE).ao(0.75);
  bx(b, long, sg, uc, 0.3, YC + 0.325, hu, 1.25, 0.325);
  // paint: blue triglyphs, red taenia (laid on at the end, gone with the decay)
  if (brk < 0 || true) {
    if (long) paintTag(b, sg * XC, YF, uc, 0.9 + 0.05 * u01); else paintTag(b, uc, YF, sg * ZC, 0.9 + 0.05 * u01);
    c3(b, BLUE, 1).surface(SURF.PLAIN).ao(0.9);
    for (let k = 0; k < (last ? 3 : 2); k++) bx(b, long, sg, ua + k * L / 2, 0.905, YF + 0.66, 0.4, 0.03, 0.62);
    c3(b, RED, 1);
    bx(b, long, sg, uc, 0.965, YF - 0.09, hu, 0.025, 0.09);
  }
}

export default {
  id: 'parthenon',
  name: 'Parthenon',
  caption: 'Athens raises a marble temple to Athena',
  year: -432,
  radius: R,
  pad: R + 2,
  roadOffset: 132, // road edge 128 m out; the hill foot ends at 124
  straddlesRoad: false,
  biome: 'coast',
  live: true,
  lights: [],
  reach: 60,
  // close-up: from beside the Propylaea, the west front and its painted frieze
  detail: { at: [TX - 2, H + 12, TZ + SL], from: [GX + 4, H + 1.5, 50] },
  strip: { at: [TX, H + 9, TZ], from: [-140, H + 12, 95], fov: 0.5 },
  // Event moment: from beyond the road, a little below the summit, the long side and the west
  // pediment against the sky
  witness: { at: [TX, TZ], look: H + 9, dist: 190, height: H + 17, az: 0.5, fov: 0.46, drift: 0.07 },
  // the city round the rock: farmhouse clusters with tiled roofs, a smaller temple on a far hill
  satellites: {
    count: [6, 8], near: 2, nearR: [150, 280], farR: [330, 950],
    centre: 0.2, spread: 4.4, minSep: 85, roadClear: 42,
    build(b, k, n, dist) {
      const s = 1 + 1.1 * Math.min(1, dist / 900);
      b.timeless();
      if (k === 0) { // a hilltop Doric temple (like the Hephaisteion), seen far off
        b.push(); b.scale(s, s, s);
        c3(b, LIMESTONE, 1).surface(SURF.STONE).ao(1);
        b.box(0, -0.5, 0, 9, 1.4, 15, false);
        c3(b, MARBLE, 1).surface(SURF.STONE);
        b.box(0, 3.9, 0, 5, 3.0, 10.5, false);
        for (let i = 0; i < 6; i++) for (let e = -1; e <= 1; e += 2) b.beam(-7 + i * 2.8, 0.9, e * 13.6, -7 + i * 2.8, 7, e * 13.6, 0.55, 0.45, 6, false);
        for (let i = 1; i < 12; i++) for (let e = -1; e <= 1; e += 2) b.beam(e * 7, 0.9, -13.6 + i * 2.47, e * 7, 7, -13.6 + i * 2.47, 0.55, 0.45, 6, false);
        b.box(0, 7.8, 0, 7.8, 0.8, 14.4, false);
        c3(b, MARBLE, 0.82); prism(b, -8.2, 8.2, -14.8, 14.8, 8.6, 2.1, true);
        b.pop();
        return;
      }
      const m = 3 + (b.rand() * 3 | 0);
      for (let i = 0; i < m; i++) {
        const a = b.rand() * TAU, r = i === 0 ? 0 : 6 + 7 * b.rand();
        const x = Math.cos(a) * r * s, z = Math.sin(a) * r * s, w = (2.2 + 1.6 * b.rand()) * s, d = (2 + 1.4 * b.rand()) * s, h = (2.8 + 1.4 * b.rand()) * s;
        b.push(); b.at(x, 0, z, b.rand() * 3);
        const g = 0.92 + 0.12 * b.rand();
        b.color(0.56 * g, 0.51 * g, 0.42 * g).surface(SURF.PLASTER).ao(1);
        b.box(0, h / 2 - 0.5, 0, w, h / 2 + 0.5, d, false);
        b.color(0.34, 0.13, 0.065).surface(SURF.PLAIN);
        prism(b, -w - 0.3 * s, w + 0.3 * s, -d - 0.3 * s, d + 0.3 * s, h, 1.1 * s, false);
        b.pop();
      }
      for (let i = 0; i < 2; i++) { const a = b.rand() * TAU; cypress(b, Math.cos(a) * 12 * s, 0, Math.sin(a) * 12 * s, 0.75 * s); }
      olive(b, (b.rand() - 0.5) * 20 * s, 0, (b.rand() - 0.5) * 20 * s, 1.1 * s, k * 13 + 5);
    },
  },

  *build(b, built, decay, seed) {
    BG = b.bio('ground'); BR = b.bio('rock');
    const sd = (seed | 0) * 31 + 7;

    // ===== the rock: one height field, with the retaining wall round the summit =====
    b.timeless().surface(SURF.ROCK).emissive(0, 0);
    b.disc(R, 148, 54, (x, z) => { const h = hillH(x, z); hillColor(b, x, z, h); return h; });
    yield;
    {
      const P = [], hx = PHX + 1, hz = PHZ + 1, rc = PCR + 1, ax = hx - rc, az = hz - rc;
      const put = (x, z) => P.push(x, plat(x, z), z);
      const line = (x0, z0, x1, z1) => { const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 6)); for (let i = 1; i <= n; i++) put(x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n); };
      const arc = (cx, cz, f0) => { for (let i = 1; i <= 7; i++) { const f = f0 + (Math.PI / 2) * i / 7; put(cx + Math.cos(f) * rc, cz + Math.sin(f) * rc); } };
      put(GX - 12, hz); line(GX - 12, hz, -ax, hz); arc(-ax, az, Math.PI / 2);
      line(-hx, az, -hx, -az); arc(-ax, -az, Math.PI);
      line(-ax, -hz, ax, -hz); arc(ax, -az, Math.PI * 1.5);
      line(hx, -az, hx, az); arc(ax, az, 0);
      line(ax, hz, GX + 12, hz);
      b.color(BR[0] * 0.92, BR[1] * 0.88, BR[2] * 0.82).surface(SURF.ROCK).ao(0.95);
      b.extrude(P, [-2, -11, 2, -11, 2, 1.3, -2, 1.3], { smooth: false, caps: true });
    }

    // ===== olives and cypresses on the slopes and at the foot =====
    let placed = 0;
    for (let i = 0; i < 400 && placed < 52; i++) {
      const a = hsh(sd, i, 1) * TAU, r = 55 + 66 * Math.sqrt(hsh(sd, i, 2));
      const x = Math.cos(a) * r, z = Math.sin(a) * r, d = sdRR(x, z);
      if (d < 15 || r > R - 4 || gateW(x, z) > 0.05 || (z > 40 && Math.abs(x - GX) < 18)) continue;
      const y = hillH(x, z) - 0.2;
      if (placed % 3 === 2) cypress(b, x, y, z, 0.85 + 0.35 * hsh(sd, i, 3));
      else olive(b, x, y, z, 1.0 + 0.4 * hsh(sd, i, 4), sd + i);
      placed++;
    }
    olive(b, -12, H - 0.2, -22, 1.2, sd + 901); // Athena's olive by the Erechtheion
    cypress(b, GX - 22, plat(GX - 22, 52), 52, 0.8); cypress(b, GX + 20, plat(GX + 20, 50), 50, 0.9);
    yield;

    // ===== the Erechtheion (rises last, 0.92-1) =====
    {
      const ey = H;
      const tg = () => b.timeless().pivot(EX, ey - 0.5, EZ).reach(10).appear(0.92, 1, MOTION.CLIP, 0, BY.BUILT);
      tg(); c3(b, LIMESTONE, 1.05).surface(SURF.STONE).ao(1);
      b.box(EX, ey + 0.05, EZ, 6.8, 0.55, 12.6, false);
      tg(); c3(b, MARBLE, 0.98).surface(SURF.STONE).ao(0.95);
      b.box(EX, ey + 3.6, EZ, 5.7, 3.0, 11.4, false);
      tg(); b.color(0.2, 0.21, 0.24).surface(SURF.STONE).ao(0.9); // Eleusinian dark-stone frieze
      b.box(EX, ey + 6.25, EZ, 5.78, 0.45, 11.48, false);
      tg(); c3(b, MARBLE, 0.97).surface(SURF.STONE);
      for (let i = 0; i < 6; i++) { b.push(); b.translate(EX - 5 + i * 2, ey + 0.6, EZ - 14); b.cylinder(0.4, 5.6, 10, false); b.pop(); }
      b.box(EX, ey + 6.45, EZ - 13.0, 5.8, 0.6, 1.6, false);
      c3(b, MARBLE, 0.9); gable(b, EX, ey + 7.05, EZ - 14.2, 5.8, 1.8, 0.4);
      // the maidens' porch, facing the Parthenon
      c3(b, MARBLE, 0.95).surface(SURF.STONE);
      b.box(EX + 7.4, ey + 1.6, EZ + 6.5, 1.75, 1.0, 2.9, false);
      c3(b, MARBLE, 1.04).surface(SURF.STONE);
      for (let i = 0; i < 6; i++) {
        const fx = i < 4 ? EX + 8.6 : EX + 6.6, fz = EZ + 6.5 + (i < 4 ? -2.1 + i * 1.4 : (i === 4 ? -2.1 : 2.1));
        b.push(); b.at(fx, ey + 2.6, fz, Math.PI / 2); b.human(POSE.STAND, 2.3, sd + 40 + i); b.pop();
      }
      c3(b, MARBLE, 0.95); b.box(EX + 7.5, ey + 5.15, EZ + 6.5, 1.95, 0.32, 3.1, false);
      // its roof falls in in the decay
      b.timeless().pivot(EX, ey - 0.5, EZ).reach(10).appear(0.92, 1, MOTION.CLIP, 0, BY.BUILT).vanish(0.3, 0.38, MOTION.RISE, 4, BY.DECAY);
      c3(b, MARBLE, 0.8).surface(SURF.PLAIN).ao(0.9);
      prism(b, EX - 6.1, EX + 6.1, EZ - 11.9, EZ + 11.9, ey + 6.7, 1.8, true);
    }

    // ===== the Propylaea and the Nike bastion (0.72-0.95) =====
    {
      const py = PB, z0 = PZC;
      const tg = (v) => {
        b.timeless().pivot(GX, py - 0.6, z0).reach(16).appear(0.72, 0.95, MOTION.CLIP, 0, BY.BUILT);
        if (v) b.vanish(0.03, 0.06, MOTION.DROP, 14, BY.DECAY);
      };
      tg(false); b.surface(SURF.STONE).ao(1);
      for (let k = 0; k < 3; k++) {
        c3(b, MARBLE, 0.95 - 0.03 * k);
        const top = py + 0.45 * (k + 1), e = (2 - k) * 0.6;
        b.box(GX, (top + py - 0.8) / 2, z0 + 0.3, 11.8 + e, (top - py + 0.8) / 2, 7.4 + e, false);
      }
      const fy = py + 1.35, ch = 8.0;
      FL[0] = -1;
      const xs = [-9.2, -5.9, -2.6, 2.6, 5.9, 9.2];
      for (const zz of [z0 + 6.6, z0 - 5.8]) for (const ox of xs) { tg(false); column(b, GX + ox, zz, fy, ch, 0.78, 2, -1, 0, -1, MARBLE); b.timeless(); }
      tg(false); c3(b, MARBLE, 0.82).surface(SURF.STONE).ao(0.7);
      for (const ox of [-10.6, -6.9, -4.2, 4.2, 6.9, 10.6]) b.box(GX + ox, fy + 3.8, z0 - 0.5, ox * ox > 100 ? 0.6 : 0.5, 3.8, 0.7, false);
      b.box(GX - 11.2, fy + 4.5, z0 + 0.4, 0.5, 4.5, 6.6, false); b.box(GX + 11.2, fy + 4.5, z0 + 0.4, 0.5, 4.5, 6.6, false);
      tg(false); c3(b, MARBLE, 0.97).ao(0.9);
      const ty = fy + ch + 0.8 * (0.78 / CR0) + 0.1;
      b.box(GX, ty + 1.1, z0 + 6.6, 11.6, 1.1, 1.0, false); b.box(GX, ty + 1.1, z0 - 5.8, 11.6, 1.1, 1.0, false);
      b.box(GX - 11.2, ty + 1.1, z0 + 0.4, 0.6, 1.1, 6.2, false); b.box(GX + 11.2, ty + 1.1, z0 + 0.4, 0.6, 1.1, 6.2, false);
      // painted triglyphs on the front
      b.timeless().pivot(GX, ty, z0 + 7.6).appear(0.93, 0.98, MOTION.REVEAL, 14, BY.BUILT).vanish(0, 0.07, MOTION.FADE, 0, BY.DECAY);
      c3(b, BLUE, 1).surface(SURF.PLAIN).ao(0.9);
      for (let i = 0; i < 11; i++) b.box(GX - 10.5 + i * 2.1, ty + 1.15, z0 + 7.62, 0.38, 0.5, 0.03, false);
      tg(true); c3(b, MARBLE, 0.9).surface(SURF.STONE).ao(0.9);
      for (const zz of [z0 + 6.9, z0 - 6.1]) { gable(b, GX, ty + 2.2, zz, 11.6, 2.6, 0.4); raking(b, GX, ty + 2.2, zz + (zz > z0 ? 0.5 : -0.5), 12.2, 2.8, 0.6, 0.5); }
      tg(true); c3(b, MARBLE, 0.78).surface(SURF.PLAIN).ao(0.95);
      prism(b, GX - 12.0, GX + 12.0, z0 - 6.5, z0 + 7.4, ty + 2.2, 2.75, true);
      // north-west wing (picture gallery)
      tg(false); c3(b, MARBLE, 0.9).surface(SURF.STONE).ao(0.95);
      b.box(GX - 18, py + 3.3, z0 + 2, 6.2, 3.9, 5.6, false);
      c3(b, MARBLE, 0.75).surface(SURF.PLAIN); prism(b, GX - 24.6, GX - 11.4, z0 - 4, z0 + 8, py + 7.2, 1.6, false);
      // Nike bastion and its little Ionic temple
      b.timeless(); c3(b, BR, 0.9).surface(SURF.STONE).ao(0.95);
      b.box(GX + 16, py - 5, z0 + 8, 5.2, 5.5, 6.4, false);
      tg(false); c3(b, MARBLE, 1).surface(SURF.STONE).ao(0.95);
      b.box(GX + 16, py + 2.6, z0 + 8, 2.6, 2.1, 3.6, false);
      for (let i = 0; i < 4; i++) { b.push(); b.translate(GX + 14.1 + i * 1.27, py + 0.5, z0 + 12.4); b.cylinder(0.24, 4.0, 8, false); b.pop(); }
      b.box(GX + 16, py + 4.85, z0 + 9, 2.8, 0.35, 4.6, false);
      c3(b, MARBLE, 0.8).surface(SURF.PLAIN); prism(b, GX + 13.1, GX + 18.9, z0 + 4.3, z0 + 13.7, py + 5.2, 0.9, true);
    }
    yield;

    // ===== the temple (temple frame: origin at the stylobate centre on the plateau) =====
    b.push(); b.translate(TX, H, TZ);
    // the older limestone podium (there at built 0)
    b.timeless(); c3(b, LIMESTONE, 1).surface(SURF.STONE).ao(1);
    b.box(0, -0.45, 0, SW + 2.8, 0.6, SL + 2.8, false);
    // krepis: three steps
    b.surface(SURF.STONE);
    for (let k = 0; k < 3; k++) {
      const top = 0.5 * (k + 1), e = (2 - k) * 0.7;
      b.timeless().pivot(0, -0.2, 0).reach(top + 0.2).appear(0.02 + 0.025 * k, 0.05 + 0.025 * k, MOTION.CLIP, 0, BY.BUILT);
      c3(b, MARBLE, 0.93 + 0.03 * k).ao(1);
      b.box(0, (top - 0.2) / 2, 0, SW + e, (top + 0.2) / 2, SL + e, false);
    }

    // --- peristyle: 8 x 17
    const falls = (side, i) => side === 0 ? (i >= 5 && i <= 11) : side === 1 ? (i >= 6 && i <= 9) : false;
    const fallT = (side, i) => (side === 0 ? 0.105 : 0.112) + 0.011 * Math.abs(i - 8);
    const stubOf = (side, i) => side === 0 ? (i === 6 ? 2 : i === 10 ? 3 : i === 8 ? 1 : 0) : (i === 7 ? 2 : 0);
    const dz = (2 * ZC) / 16, dxe = (2 * XC) / 7;
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      for (let i = 0; i <= 16; i++) {
        const z = -ZC + i * dz, u = i / 16, f = falls(side, i);
        FL[0] = f ? fallT(side, i) : -1; FL[1] = stubOf(side, i); FL[2] = sg; FL[3] = (hsh(sd, i, side) - 0.5) * 0.5;
        column(b, sg * XC, z, YS, CH, CR0, ND, 0.1 + 0.05 * u, 0.072, 0.48 + 0.03 * u, MARBLE);
      }
      if (side === 1) yield;
    }
    for (let e = 0; e < 2; e++) {
      const sg = e ? 1 : -1;
      for (let i = 1; i < 7; i++) {
        FL[0] = -1;
        column(b, -XC + i * dxe, sg * ZC, YS, CH, CR0, ND, 0.1 + 0.03 * (e ? 1 : 0), 0.075, 0.48 + 0.03 * e, MARBLE);
      }
    }
    // inner porches: six columns at each end of the cella, on a raised step
    for (let e = 0; e < 2; e++) {
      const sg = e ? 1 : -1, zp = e ? CZ1 + 2.6 : CZ0 - 2.6;
      b.timeless().pivot(0, YS, 0).reach(0.6).appear(0.12, 0.14, MOTION.CLIP, 0, BY.BUILT);
      c3(b, MARBLE, 0.95).surface(SURF.STONE).ao(0.85);
      b.box(0, YS + 0.3, zp, CW + 0.6, 0.3, 1.5, false);
      for (let i = 0; i < 6; i++) {
        const f = !e && i >= 1 && i <= 4;
        FL[0] = f ? 0.12 + 0.01 * i : -1; FL[1] = f && i === 2 ? 2 : 0; FL[2] = 0; FL[3] = sg * -1;
        column(b, -9 + i * 3.6, zp, YS + 0.6, CH - 0.6, 0.85, ND, 0.12 + 0.02 * e, 0.075, 0.5, MARBLE);
      }
      b.timeless().appear(0.54, 0.56, MOTION.DROP, 1.5, BY.BUILT);
      if (!e) b.vanish(0.12, 0.16, MOTION.DROP, 16, BY.DECAY);
      c3(b, MARBLE, 0.9).surface(SURF.STONE).ao(0.7);
      b.box(0, YA + 1.0, zp, CW + 0.4, 1.0, 0.9, false);
    }
    yield;

    // --- cella walls: low footings stay; the upper walls rise inside scaffolds and fall in 1687
    b.surface(SURF.STONE);
    const wallSeg = (x0, x1, z0, z1, t, keep) => {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
      b.timeless().pivot(0, YS, 0).reach(1.8).appear(0.14, 0.17, MOTION.CLIP, 0, BY.BUILT);
      c3(b, MARBLE, 0.9).ao(0.7);
      b.box(cx, YS + 0.9, cz, hx, 0.9, hz, false);
      b.timeless().pivot(0, YS + 1.8, 0).reach(YF - YS - 1.8).appear(0.17, 0.5, MOTION.CLIP, 0, BY.BUILT);
      if (keep < 1) b.vanish(t, t + 0.06, MOTION.CLIP, 0, BY.DECAY);
      b.box(cx, (YS + 1.8 + YF) / 2, cz, hx, (YF - YS - 1.8) / 2, hz, false);
    };
    const NSEG = 6, segL = (CZ1 - CZ0) / NSEG;
    for (let s = 0; s < 2; s++) {
      const x0 = s ? CW - 1.1 : -CW, x1 = s ? CW : -CW + 1.1;
      for (let k = 0; k < NSEG; k++) {
        const zm = CZ0 + (k + 0.5) * segL, mid = Math.abs(zm - (CZ0 + CZ1) / 2) < 16;
        wallSeg(x0, x1, CZ0 + k * segL, CZ0 + (k + 1) * segL, mid ? 0.11 + 0.01 * k : 0.25 + 0.04 * k, k === NSEG - 1 ? 1 : 0);
      }
    }
    for (const [zw, keep, t] of [[CZ0, 0, 0.12], [CZ1, 1, 0], [7, 0, 0.14]]) { // end and cross walls, a door in each
      wallSeg(-CW + 1.1, -2.4, zw - 0.6, zw + 0.6, t, keep); wallSeg(2.4, CW - 1.1, zw - 0.6, zw + 0.6, t, keep);
      b.timeless().appear(0.45, 0.48, MOTION.DROP, 1, BY.BUILT); if (!keep) b.vanish(t, t + 0.05, MOTION.RISE, 6, BY.DECAY);
      c3(b, MARBLE, 0.88).ao(0.7); b.box(0, YS + 10.6, zw, 2.5, 0.7, 0.6, false);
      b.box(0, (YS + 11.3 + YF) / 2, zw, 2.5, (YF - YS - 11.3) / 2, 0.6, false);
    }
    // the Ionic frieze round the cella top: a blue band with a marble procession
    for (let s = 0; s < 2; s++) {
      const sg = s ? 1 : -1;
      paintTag(b, sg * CW, YA, -2, 0.9);
      c3(b, BLUE, 1).surface(SURF.PLAIN).ao(0.8);
      b.box(sg * (CW + 0.03), YA + 0.62, (CZ0 + CZ1) / 2, 0.03, 0.55, (CZ1 - CZ0) / 2 + 0.5, false);
    }
    yield;

    // --- entablature, bay by bay
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      for (let i = 0; i < 16; i++) {
        const za = -ZC + i * dz, zb = za + dz, bf = falls(side, i) || falls(side, i + 1);
        const brk = bf ? Math.min(falls(side, i) ? fallT(side, i) : 1, falls(side, i + 1) ? fallT(side, i + 1) : 1) - 0.004 : -1;
        bay(b, true, sg, za, zb, (i + 0.5) / 16, brk, i === 15, sd + i * 3 + side * 101);
      }
    }
    for (let e = 0; e < 2; e++) {
      const sg = e ? 1 : -1;
      for (let i = 0; i < 7; i++) bay(b, false, sg, -XC + i * dxe, -XC + (i + 1) * dxe, e, -1, i === 6, sd + 500 + i * 3 + e * 50);
    }
    // corners of the entablature
    for (let k = 0; k < 4; k++) {
      const sx = k & 1 ? 1 : -1, sz = k & 2 ? 1 : -1, t = sz > 0 ? 0.05 : 0;
      b.surface(SURF.STONE);
      b.timeless().appear(0.52 + t, 0.54 + t, MOTION.DROP, 1.5, BY.BUILT); c3(b, MARBLE, 0.97).ao(0.85);
      b.box(sx * (XC + 0.475), YA + 0.675, sz * (ZC + 0.475), 0.475, 0.675, 0.475, false);
      b.timeless().appear(0.58 + t, 0.6 + t, MOTION.DROP, 1.5, BY.BUILT); c3(b, MARBLE, 0.95).ao(0.9);
      b.box(sx * (XC + 0.425), YF + 0.675, sz * (ZC + 0.425), 0.425, 0.675, 0.425, false);
      b.timeless().appear(0.63 + t, 0.65 + t, MOTION.DROP, 1.5, BY.BUILT); c3(b, MARBLE, 1).ao(0.75);
      b.box(sx * (XC + 0.775), YC + 0.325, sz * (ZC + 0.775), 0.775, 0.325, 0.775, false);
    }
    yield;

    // --- pediments: tympanum, raking cornice, figures, blue ground, acroteria
    for (let e = 0; e < 2; e++) {
      const sg = e ? 1 : -1, zt = sg * (ZC + 0.4);
      b.timeless().pivot(0, YE, 0).reach(RISE).appear(0.68, 0.74, MOTION.CLIP, 0, BY.BUILT);
      c3(b, MARBLE, 0.92).surface(SURF.STONE).ao(0.8);
      gable(b, 0, YE, zt, WE - 0.7, (WE - 0.7) * RK, 0.45);
      b.timeless().appear(0.73 + 0.02 * e, 0.76 + 0.02 * e, MOTION.DROP, 1.5, BY.BUILT);
      if (!e) b.vanish(0.48, 0.56, MOTION.RISE, 8, BY.DECAY);
      c3(b, MARBLE, 1).ao(0.85);
      raking(b, 0, YE - 0.05, sg * (ZC + 1.1), WE + 0.1, RISE + 0.05, 0.75, 0.62);
      // acroteria
      c3(b, MARBLE, 1.02).surface(SURF.STONE).ao(1);
      for (let a = -1; a <= 1; a++) {
        b.push(); b.translate(a * (WE - 0.4), YE + (a === 0 ? RISE + 0.9 : 0.75), sg * (ZC + 1.1)); b.rock(0.55, 0.75, 0.25, 1, 0.3, sd + a + e * 9, 0, 0); b.pop();
      }
      paintTag(b, 0, YE + 1, zt, 0.9);
      c3(b, BLUE, 0.95).surface(SURF.PLAIN).ao(0.85);
      gable(b, 0, YE + 0.05, zt + sg * 0.47, WE - 1.3, (WE - 1.3) * RK - 0.1, 0.02);
      // figures: gods at the centre, smaller and reclining toward the corners
      const FX = [0, -2.6, 2.6, -5.4, 5.4, -8.3, 8.3, -11.3, 11.3];
      const FP = [POSE.STAND, POSE.STAND, POSE.STAND, POSE.STAND, POSE.KNEEL, POSE.KNEEL, POSE.SIT, POSE.SIT, POSE.SIT];
      for (let i = 0; i < FX.length; i++) {
        const x = FX[i], room = ((WE - 0.7) - Math.abs(x)) * RK;
        const pose = FP[i], hgt = pose === POSE.SIT ? Math.min(2.6, room * 1.5) : pose === POSE.KNEEL ? Math.min(2.8, room * 1.15) : Math.min(3.2, room * 0.9);
        let vt = -1, vh = 0;
        if (e === 1 && i < 3) { vt = 0.2; vh = 1; } // west centre: lost when Morosini tried to lower them (1688)
        if (e === 0 && i !== 7 && i !== 8) { vt = 0.45 + 0.02 * i; vh = 1; } // east: carried off
        b.timeless().appear(0.88, 0.92, MOTION.DROP, 2, BY.BUILT);
        if (vh) b.vanish(vt, vt + 0.04, MOTION.RISE, 4, BY.DECAY);
        c3(b, MARBLE, 1.04).surface(SURF.STONE).ao(0.85);
        b.push(); b.at(x, YE + 0.02, sg * (ZC + 0.95), e ? 0 : Math.PI); b.human(pose, hgt, sd + i * 5 + e); b.pop();
      }
    }
    yield;

    // --- roof: timbers, then marble tiles laid in sections from both ends (blown off in 1687)
    const NS = 7, ZR = ZC + 1.6;
    for (let s = 0; s < NS; s++) {
      const z0 = -ZR + (2 * ZR) * s / NS, z1 = -ZR + (2 * ZR) * (s + 1) / NS, rank = Math.abs(s - (NS - 1) / 2);
      const tb = 0.1 + 0.012 * (3 - rank), tIn = 0.76 + 0.035 * (3 - rank);
      b.timeless().appear(0.7 + 0.01 * s, 0.73 + 0.01 * s, MOTION.POP, 0, BY.BUILT).vanish(tb, tb + 0.03, MOTION.DROP, 25, BY.DECAY);
      c3(b, TIMBER, 1).surface(SURF.WOOD).ao(0.8);
      for (let z = z0 + 1.2; z < z1; z += 2.6) for (let m = -1; m <= 1; m += 2) b.beam(m * (WE - 0.3), YE + 0.15, z, 0, YE + RISE - 0.25, z, 0.16, 0.16, 4, false);
      b.beam(0, YE + RISE - 0.2, z0, 0, YE + RISE - 0.2, z1, 0.2, 0.2, 4, false);
      b.timeless().appear(tIn, tIn + 0.03, MOTION.POP, 0, BY.BUILT).vanish(tb, tb + 0.035, MOTION.DROP, 30, BY.DECAY);
      b.surface(SURF.PLAIN);
      for (let m = -1; m <= 1; m += 2) {
        c3(b, MARBLE, 0.8).ao(1);
        HX.set([0, YE + RISE - 0.05, z0, m * WE, YE - 0.05, z0, m * WE, YE - 0.05, z1, 0, YE + RISE - 0.05, z1,
          0, YE + RISE + 0.25, z0, m * WE, YE + 0.25, z0, m * WE, YE + 0.25, z1, 0, YE + RISE + 0.25, z1]);
        b.hexa(HX, false);
        c3(b, MARBLE, 0.93);
        for (let z = z0 + 0.6; z < z1; z += 1.3) {
          b.beam(m * 0.3, YE + RISE + 0.3, z, m * WE, YE + 0.3, z, 0.12, 0.12, 4, false);
          b.box(m * (WE + 0.02), YE + 0.5, z, 0.08, 0.28, 0.2, false); // antefix
        }
      }
      c3(b, MARBLE, 0.9); b.box(0, YE + RISE + 0.35, (z0 + z1) / 2, 0.3, 0.18, (z1 - z0) / 2, false);
    }
    yield;

    // --- construction: cranes, scaffolds, drum stacks, builders
    // cranes: shear legs leaning over the work, hoist rope with a drum
    const CRN = [[-26, -6, 1, 0], [0, -ZC - 12, 0, 1], [27, 14, -1, 0]];
    for (let c = 0; c < 3; c++) {
      const [cx, cz, dx, dzz] = CRN[c], px = -dzz, pz = dx;
      const ax = cx + dx * 10, az = cz + dzz * 10, ay = 25;
      b.timeless().pivot(cx, 0, cz).vanish(0.9 + 0.015 * c, 0.94 + 0.015 * c, MOTION.GROW, 0, BY.BUILT);
      c3(b, TIMBER, 1).surface(SURF.WOOD).ao(0.95);
      for (let s = -1; s <= 1; s += 2) b.beam(cx + px * 2.2 * s, 0, cz + pz * 2.2 * s, ax, ay, az, 0.28, 0.2, 5);
      b.beam(cx + px * 2.2, 3.2, cz + pz * 2.2, cx - px * 2.2, 3.2, cz - pz * 2.2, 0.15, 0.15, 4);
      b.beam(cx + px * 1.6, 1.0, cz + pz * 1.6, cx - px * 1.6, 1.0, cz - pz * 1.6, 0.35, 0.35, 8); // winch
      b.color(0.32, 0.27, 0.18);
      b.beam(ax, ay, az, cx - dx * 16, 0, cz - dzz * 16, 0.05, 0.05, 3, false); // back stay
      b.beam(ax, ay, az, ax, 15, az, 0.05, 0.05, 3, false); // hoist
      b.beam(ax, ay, az, cx, 1.0, cz, 0.05, 0.05, 3, false);
      c3(b, MARBLE, 0.95).surface(SURF.STONE);
      b.push(); b.translate(ax, 13.2, az); b.cylinder(0.85, 1.8, 12); b.pop();
    }
    // scaffolds round the cella walls and later before the pediments
    c3(b, TIMBER, 1.15).surface(SURF.WOOD).ao(0.95);
    for (let s = -1; s <= 1; s += 2) {
      const x = s * (CW + 1.6);
      b.timeless().pivot(0, YS, 0).appear(0.13, 0.17, MOTION.GROW, 0, BY.BUILT).vanish(0.84, 0.88, MOTION.GROW, 0, BY.BUILT);
      for (let z = CZ0 - 1; z <= CZ1 + 1.01; z += 4.7) b.beam(x, YS, z, x, YF + 1.2, z, 0.1, 0.1, 4, false);
      for (let y = YS + 3; y < YF + 1; y += 3) b.beam(x, y, CZ0 - 1, x, y, CZ1 + 1, 0.08, 0.08, 4, false);
    }
    for (let e = -1; e <= 1; e += 2) {
      const z = e * (ZC + 3.2);
      b.timeless().pivot(0, 0, 0).appear(0.55, 0.6, MOTION.GROW, 0, BY.BUILT).vanish(0.9, 0.94, MOTION.GROW, 0, BY.BUILT);
      for (let x = -12; x <= 12.01; x += 4) b.beam(x, 0, z, x, YE + RISE * (1 - Math.abs(x) / WE) + 1, z, 0.1, 0.1, 4, false);
      for (let y = 3; y < YE + 3; y += 3.2) { const w = Math.min(12, (YE + RISE + 1 - y) / RK); if (w > 1) b.beam(-w, y, z, w, y, z, 0.08, 0.08, 4, false); }
    }
    // drum stacks waiting on the summit; they go as the columns rise
    const ST = [[-27, 6], [-28, -26], [25, -30], [-6, -ZC - 15], [24, 30]];
    for (let g = 0; g < ST.length; g++) {
      const t = 0.18 + 0.07 * g;
      b.timeless().vanish(t, t + 0.05, MOTION.RISE, 2.2, BY.BUILT);
      for (let i = 0; i < 6; i++) {
        const ox = (i % 3) * 2.3 - 2.3 + (hsh(sd, g, i) - 0.5) * 0.4, oz = (i / 3 | 0) * 2.3;
        c3(b, MARBLE, 0.95 + 0.06 * hsh(sd, i, g)).surface(SURF.STONE).ao(0.95);
        b.push(); b.translate(ST[g][0] + ox, -0.1, ST[g][1] + oz); b.cylinder(0.9, 1.95, 12); b.pop();
      }
      c3(b, MARBLE, 0.9); b.box(ST[g][0] + 5.2, 0.5, ST[g][1] + 1, 1.4, 0.6, 0.8, false);
    }
    // builders
    const WK = [[-26, -6 - 3, POSE.HAUL, 0.3], [-25, -6 + 2.5, POSE.HAUL, 0.2], [27, 11, POSE.HAUL, 3.4], [2, -ZC - 15, POSE.HAUL, 1.6],
      [-27, 9, POSE.KNEEL, 2.4], [-25, -22, POSE.KNEEL, 0.8], [25, -27, POSE.STAND, -1.6], [-(CW + 1.6), -4, POSE.STAND, 1.57], [CW + 1.6, 8, POSE.STAND, -1.57], [-20, 30, POSE.WALK, 2.8]];
    for (let i = 0; i < WK.length; i++) {
      const [x, z, p, yaw] = WK[i], y = i === 7 || i === 8 ? YS + 6 : 0;
      b.timeless().vanish(0.92, 0.96, MOTION.FADE, 0, BY.BUILT);
      figure(b, x, y, z, yaw, p, 1.72, ROBES[3 + (i & 1)], sd + 200 + i);
    }
    // visitors on the west steps once it is finished; a few modern ones at the ruin
    const VS = [[-6, 1.0, SL + 0.35, POSE.SIT], [-3.4, 0.5, SL + 1.05, POSE.STAND], [4.5, 1.0, SL + 0.35, POSE.SIT], [8, 0, SL + 4.5, POSE.STAND], [9.2, 0, SL + 5.2, POSE.STAND], [-12, 0, SL + 7, POSE.WALK]];
    for (let i = 0; i < VS.length; i++) {
      b.timeless().appear(0.95, 0.99, MOTION.FADE, 0, BY.BUILT).vanish(0.02 + 0.008 * i, 0.05 + 0.008 * i, MOTION.FADE, 0, BY.DECAY);
      figure(b, VS[i][0], VS[i][1], VS[i][2], 0.3 * (i - 2), VS[i][3], 1.72, ROBES[i % 3], sd + 300 + i);
    }
    for (let i = 0; i < 3; i++) {
      b.timeless().appear(0.6 + 0.02 * i, 0.64 + 0.02 * i, MOTION.FADE, 0, BY.DECAY);
      figure(b, -6 + i * 4.5, 0, SL + 9 + i * 1.3, Math.PI + 0.3 * i, POSE.STAND, 1.75, [0.14 + 0.1 * i, 0.15, 0.17], sd + 400 + i);
    }
    yield;

    // --- 1687: fallen drums in rows where the columns came down, rubble, fire and smoke
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      for (let i = 0; i <= 16; i++) {
        if (!falls(side, i)) continue;
        const z0 = -ZC + i * dz, t = fallT(side, i) + 0.045, st = stubOf(side, i);
        b.timeless().appear(t, t + 0.01, MOTION.POP, 0, BY.DECAY);
        c3(b, MARBLE, 0.97).surface(SURF.STONE).ao(0.9);
        for (let j = st; j < ND; j++) {
          const r = rAt(CR0, CR0 * 0.79, j / ND), d = 3.6 + (j - st) * 2.1 + 1.2 * hsh(sd, i, j + side * 9);
          const x = sg * (XC + d), z = z0 + (hsh(sd, j, i) - 0.5) * 2.4 + (j - st) * 0.25 * (hsh(sd, i, 77) - 0.5);
          b.push(); b.translate(x, r - 0.05, z); b.rotateY((hsh(sd, i, j) - 0.5) * 0.9); b.rotateZ(Math.PI / 2); b.translate(0, -0.95, 0);
          b.cylinder(r, 1.9, 12); b.pop();
        }
        b.push(); b.translate(sg * (XC + 4.2 + (ND - st) * 2.2), 0.5, z0 + 0.7); b.box(0, 0, 0, 0.8, 0.5, 0.8, false); b.pop(); // capital
      }
    }
    for (let i = 0; i < 34; i++) {
      const inside = i < 18, t = 0.13 + 0.15 * hsh(sd, i, 61);
      const x = inside ? (hsh(sd, i, 62) - 0.5) * 2 * (CW - 2) : -(CW + 1 + 9 * hsh(sd, i, 63)) * (i & 1 ? 1 : -1) * (i % 3 ? 1 : -1);
      const z = inside ? CZ0 + 3 + (CZ1 - CZ0 - 6) * hsh(sd, i, 64) : -12 + 22 * hsh(sd, i, 65);
      const s = 0.7 + 1.1 * hsh(sd, i, 66), by = inside ? YS : 0;
      b.timeless().appear(t, t + 0.06, MOTION.RISE, s, BY.DECAY);
      c3(b, MARBLE, 0.82 + 0.15 * hsh(sd, i, 67)).surface(SURF.STONE).ao(0.85);
      b.push(); b.translate(x, by + s * 0.25, z); b.rock(s * 1.3, s * 0.55, s, 1, 0.35, sd + i, 3, 0.5); b.pop();
    }
    for (let i = 0; i < 3; i++) {
      b.timeless().pivot(0, YS, 0).appear(0.1, 0.104, MOTION.POP, 0, BY.DECAY).vanish(0.16 + 0.02 * i, 0.24 + 0.02 * i, MOTION.GROW, 0, BY.DECAY);
      b.flames(-4 + i * 4, YS + 0.5, -12 + i * 9, 7, FLICKER.OWN, sd + i);
    }
    b.timeless().pivot(0, 8, -2).appear(0.1, 0.104, MOTION.POP, 0, BY.DECAY).vanish(0.3, 0.45, MOTION.SCALE, 0, BY.DECAY);
    b.smoke(0, 9, -2, { count: 40, size: 9, rise: 60, density: 0.6, color: [0.14, 0.13, 0.13], src: FLICKER.OWN });
    b.timeless();
    b.pop();

    // ===== the flash of 1687 (rig 1, driven by animate) =====
    b.rig(1, false).timeless().appear(0.097, 0.101, MOTION.POP, 0, BY.DECAY).vanish(0.103, 0.15, MOTION.POP, 0, BY.DECAY);
    b.flash(0, 0, 0, 30, 140, 1, 0.9, 0.7);
    b.rig(0).timeless();
    return b.counts();
  },

  animate(a) {
    const k = seg(a.decay, 0.097, 0.103) * (1 - seg(a.decay, 0.103, 0.15));
    a.set(1, TX, H + 10, TZ - 2).gain(1, k).show(1, k > 0.002);
  },
};
