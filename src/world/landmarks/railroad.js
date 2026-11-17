// Transcontinental railroad, 1869: a single track on a low ballast bank runs across the open
// prairie beside the road (88 m off at the site, curving away from it at both ends and sinking
// over a rise about 250 m out each way, clear of fork roads), a line of telegraph poles on its
// road side, a timber water tower with its spout and a small wooden depot with a plank platform
// on the far side,
// and a timber trestle over a dry gully cut through a low swell of the plain.
//
// The train (rigs 1-6): a wood-burning 4-4-0 with balloon stack, cowcatcher, big lit headlamp,
// brass domes and red drivers, its tender stacked with cordwood, two green coaches and two
// red boxcars. It runs the whole line one way (with the car), stops at the depot to take
// water, runs on and sinks over the horizon; a few seconds later it comes back the other way
// and stops with its coaches at the platform. Smoke streams back from the stack while it
// runs (rig 2, gain = speed) and stands up lazily while it waits.
//
// built 0 -> 1 (clock 232-243): the line is laid from the far end (+z) toward -z, the way
// the car drives: the graded bank runs ahead, then ballast, then ties and rails chunk by
// chunk; telegraph poles follow; depot, platform, tower and trestle go up as the railhead
// reaches them. At the railhead (rig 7): loose ties on the grade, rails being carried, a
// rail truck, stacks of ties and rails, track gangs, the tent camp with a cook fire, and the
// work train standing behind. At built 1 the camp is gone and the train starts running.
// decay is unused (0 in the registry).

import { SURF, POSE, FLICKER, MOTION, BY, loop, pathAt } from './kit.js';

const L = 304; // the track runs from z = +L to z = -L (local)
const STEP = 16; // track sample / chunk length along z (m)
const X0 = 8, KX = 0.0011; // track x = X0 + KX z^2: 88 m from the road centre at the site, curving away
const BASE = 1.3; // rail top above the flat pad (the bank)
const SWELL = 2.4; // height of the swell the gully cuts through
const TR0 = -48, TR1 = -16; // trestle span (z), on the chunk grid
const NP = Math.round((2 * L) / STEP) + 1;

function sm(a, b, x) { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); }
const trackX = (z) => X0 + KX * z * z;
const swZ = (z) => sm(-104, -62, z) * (1 - sm(-2, 36, z)); // the swell along z, 0..1
const swX = (x) => sm(-54, -24, x) * (1 - sm(44, 76, x));
const gullyZ = (x) => -30 + 4 * Math.sin(x / 15);
// Height of the built landform (the swell and its gully) at (x, z); 0 outside.
function land(x, z) {
  const s = SWELL * swZ(z) * swX(x);
  const d = Math.abs(z - gullyZ(x));
  return s * sm(5, 12, d);
}
const dip = (z) => -8 * sm(L - 100, L, Math.abs(z)); // the line sinks over the horizon at both ends
const railY = (z) => BASE + SWELL * swZ(z) * swX(trackX(z)) + dip(z);

// The track as a path (module level: animate never allocates).
const TRACK = new Float64Array(NP * 3);
const CUM = new Float64Array(NP);
for (let i = 0; i < NP; i++) {
  const z = L - i * STEP;
  TRACK[i * 3] = trackX(z); TRACK[i * 3 + 1] = railY(z); TRACK[i * 3 + 2] = z;
  if (i) CUM[i] = CUM[i - 1] + Math.hypot(TRACK[i * 3] - TRACK[i * 3 - 3], TRACK[i * 3 + 1] - TRACK[i * 3 - 2], STEP);
}
const S = CUM[NP - 1];
function sAtZ(z) { const f = (L - z) / STEP, i = Math.min(NP - 2, Math.max(0, Math.floor(f))); return CUM[i] + (CUM[i + 1] - CUM[i]) * (f - i); }

// Train: consist offsets from the head (pilot tip) to each rig's centre, along the track.
const LEN = 70;
const RIGS_T = [1, 2, 3, 4, 5, 6];
const OFF = [9, 9, 26, 41, 54, 65]; // loco + tender, its smoke plume, coach, coach, boxcar, boxcar
const TOWER_Z = 44; // the water tower: tender centre under the spout on the -z run
const V = 16, DB = 100, DA = 130, DWELL = 14, PAUSE = 8;
// Run A (-z, with the car): head from LEN + 5 to S - 5, stops with the tender at the tower.
// Run B (+z): head from S - LEN - 5 to 5, stops with the coaches at the platform.
const RUN = new Float64Array(8); // per run: stop distance, total distance, duration, (spare)
function plan(o, dStop, dTot) {
  RUN[o] = dStop; RUN[o + 1] = dTot;
  RUN[o + 2] = (dStop - DB) / V + 2 * DB / V + DWELL + 2 * DA / V + (dTot - dStop - DA) / V;
}
plan(0, sAtZ(TOWER_Z) + 14.8 - (LEN + 5), S - 5 - (LEN + 5));
plan(4, (S - LEN - 5) - sAtZ(96.2), S - LEN - 10);
const CYCLE = RUN[2] + PAUSE + RUN[6] + PAUSE;
const R = new Float64Array(2); // distance travelled, speed fraction
function travel(tau, o) {
  const dS = RUN[o], dT = RUN[o + 1], ab = V * V / (2 * DB), aa = V * V / (2 * DA);
  const t1 = (dS - DB) / V, t2 = t1 + 2 * DB / V, t3 = t2 + DWELL, t4 = t3 + 2 * DA / V;
  if (tau < t1) { R[0] = V * tau; R[1] = 1; } else if (tau < t2) { const u = tau - t1; R[0] = dS - DB + V * u - 0.5 * ab * u * u; R[1] = 1 - u / (t2 - t1); } else if (tau < t3) { R[0] = dS; R[1] = 0; } else if (tau < t4) { const u = tau - t3; R[0] = dS + 0.5 * aa * u * u; R[1] = u / (t4 - t3); } else { R[0] = Math.min(dT, dS + DA + V * (tau - t4)); R[1] = 1; }
}
const P = new Float64Array(5);

// Cross-sections (x right of travel, y up, rail top = 0).
const FILL = [9.6, -6.2, 2.7, -0.5, -2.7, -0.5, -9.6, -6.2];
const BALLAST = [2.45, -0.6, 1.6, -0.24, -1.6, -0.24, -2.45, -0.6];
const TIEBAND = [1.3, -0.3, 1.3, -0.17, -1.3, -0.17, -1.3, -0.3];
const RAILR = [0.79, -0.16, 0.79, 0, 0.72, 0, 0.72, -0.16];
const RAILL = [-0.72, -0.16, -0.72, 0, -0.79, 0, -0.79, -0.16];
const STRR = [1.0, -0.62, 1.0, -0.3, 0.5, -0.3, 0.5, -0.62];
const STRL = [-0.5, -0.62, -0.5, -0.3, -1.0, -0.3, -1.0, -0.62];
const SEG = new Float64Array(9);
const FLAT = { smooth: false };
const CAPS = { smooth: false, caps: true };
function segPath(za, zb) {
  for (let k = 0; k < 3; k++) { const z = za + (zb - za) * k / 2; SEG[k * 3] = trackX(z); SEG[k * 3 + 1] = railY(z); SEG[k * 3 + 2] = z; }
  return SEG;
}
const lay = (b, f) => b.timeless().appear(f - 0.006, f - 0.002, MOTION.POP, 0, BY.BUILT);

function track(b, seed) {
  const g = b.bio('ground');
  for (let i = 0; i < NP - 1; i++) {
    const za = L - i * STEP, zb = za - STEP, f = CUM[i + 1] / S, near = Math.abs(za) < 240;
    const tr = za <= TR1 && zb >= TR0, abut = (zb === TR1) || (za === TR0);
    segPath(za, zb);
    if (!tr) {
      // the graded bank runs ahead of the track, then the ballast
      b.timeless().appear(f - 0.07, f - 0.05, MOTION.RISE, 1.5, BY.BUILT);
      b.color(g[0] * 0.8, g[1] * 0.74, g[2] * 0.66).surface(SURF.EARTH).ao(1);
      b.extrude(SEG, FILL, abut ? CAPS : FLAT);
      b.timeless().appear(f - 0.016, f - 0.012, MOTION.RISE, 0.4, BY.BUILT);
      b.color(0.3, 0.28, 0.25).surface(SURF.STONE).ao(0.95);
      b.extrude(SEG, BALLAST, abut ? CAPS : FLAT);
      if (!near) { lay(b, f); b.color(0.13, 0.095, 0.07).surface(SURF.WOOD).ao(0.9); b.extrude(SEG, TIEBAND, FLAT); }
    } else {
      b.timeless().appear(f - 0.03, f - 0.012, MOTION.RISE, 2, BY.BUILT);
      b.color(0.22, 0.16, 0.1).surface(SURF.WOOD).ao(0.85);
      b.extrude(SEG, STRR, FLAT); b.extrude(SEG, STRL, FLAT);
    }
    lay(b, f);
    if (near || tr) {
      b.surface(SURF.WOOD).ao(0.9);
      for (let z = za - 0.3; z > zb; z -= 0.62) {
        const c = 0.13 + 0.04 * b.rand();
        b.color(c * 1.1, c * 0.82, c * 0.6);
        b.push(); b.at(trackX(z), railY(z) - 0.235, z, Math.atan(2 * KX * z)); b.box(0, 0, 0, tr ? 1.45 : 1.3, 0.07, 0.11, false); b.pop();
      }
    }
    b.color(0.2, 0.18, 0.17).surface(SURF.PLAIN).ao(1);
    b.extrude(SEG, RAILR, FLAT); b.extrude(SEG, RAILL, FLAT);
  }
  b.timeless();
}

// Telegraph line on the far side (+x), poles every 40 m, two wires with a slight sag.
function telegraph(b) {
  const n = Math.floor((2 * L - 40) / 40) + 1;
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    const z = L - 20 - i * 40, x = trackX(z) - 6.5, base = land(x, z) + dip(z), top = base + 7.2;
    const f = sAtZ(z) / S;
    b.timeless().pivot(x, base, z).appear(f - 0.03, f - 0.02, MOTION.GROW, 0, BY.BUILT);
    b.color(0.2, 0.15, 0.1).surface(SURF.WOOD).ao(1);
    b.beam(x, base - 1.5, z, x, top, z, 0.13, 0.1, 5, false);
    b.beam(x, top - 0.45, z - 0.9, x, top - 0.45, z + 0.9, 0.06, 0.06, 4);
    b.color(0.24, 0.32, 0.3).surface(SURF.PLAIN);
    b.box(x, top - 0.33, z - 0.75, 0.04, 0.07, 0.04); b.box(x, top - 0.33, z + 0.75, 0.04, 0.07, 0.04);
    if (i) {
      b.color(0.08, 0.08, 0.08).surface(SURF.PLAIN);
      for (const o of [-0.75, 0.75]) {
        const mx = (x + px) / 2, my = (top + py) / 2 - 0.55 - 0.3, mz = (z + pz) / 2;
        b.beam(px, py - 0.28, pz + o, mx, my, mz + o, 0.018, 0.018, 3, false);
        b.beam(mx, my, mz + o, x, top - 0.28, z + o, 0.018, 0.018, 3, false);
      }
    }
    px = x; py = top; pz = z;
  }
  b.timeless();
}

// The swell of the plain and the dry gully cut through it (the trestle's reason to be).
function landform(b) {
  const g0 = b.bio('ground'), g = [g0[0] * 0.86, g0[1] * 0.86, g0[2] * 0.8];
  const x0 = -56, x1 = 80, z0 = -108, z1 = 40;
  b.timeless().surface(SURF.EARTH).ao(1);
  b.heightfield(x0, z0, x1, z1, 54, 60, (x, z) => {
    const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
    const sw = SWELL * swZ(z) * swX(x), d = Math.abs(z - gullyZ(x)), cut = 1 - sm(5, 12, d);
    const n = 0.12 * Math.sin(x * 0.21 + z * 0.13) * Math.sin(z * 0.17 - x * 0.07);
    const h = land(x, z) + n * swZ(z) * swX(x);
    const bed = cut * sw / SWELL, slope = sm(4, 6, d) * (1 - sm(10, 13, d)) * sw / SWELL;
    const p = 0.5 + 0.5 * Math.sin(x * 0.9) * Math.sin(z * 1.3);
    b.color(
      g[0] * (1 - bed - slope) + (0.36 + 0.05 * p) * bed + 0.27 * slope,
      g[1] * (1 - bed - slope) + (0.29 + 0.04 * p) * bed + 0.18 * slope,
      g[2] * (1 - bed - slope) + (0.2 + 0.03 * p) * bed + 0.1 * slope);
    // flat ground sinks under the terrain, so only the swell itself shows (no patch edges)
    const e = sm(0, 1.6, h) * sm(0, 6, edge);
    return e * Math.max(0.03, h) - (1 - e) * 0.9;
  });
  // stones in the gully bed
  b.surface(SURF.STONE).ao(0.9);
  for (let i = 0; i < 26; i++) {
    const x = -40 + 112 * b.rand(), z = gullyZ(x) + (b.rand() - 0.5) * 9;
    if (swX(x) < 0.3) continue;
    const c = 0.26 + 0.1 * b.rand();
    b.color(c, c * 0.95, c * 0.88);
    b.push(); b.translate(x, 0.05, z); b.rock(0.3 + 0.5 * b.rand(), 0.2 + 0.25 * b.rand(), 0.3 + 0.4 * b.rand(), 2, 0.3, i + 3, 3, 0.5); b.pop();
  }
}

// Timber trestle: bents every 4 m over the gully, cap, posts, battered legs, sway bracing.
function trestle(b) {
  const f = sAtZ(TR1) / S;
  for (let z = TR1 - 2; z > TR0; z -= 4) {
    const x = trackX(z), top = railY(z) - 0.62;
    b.timeless().pivot(x, 0, z).appear(f - 0.05 + 0.002 * (TR1 - z) / 4, f - 0.03, MOTION.RISE, top, BY.BUILT);
    b.push(); b.at(x, 0, z, Math.atan(2 * KX * z));
    const gl = land(x - 2, z), gr = land(x + 2, z), g0 = Math.min(gl, gr) - 0.4;
    b.color(0.24, 0.17, 0.11).surface(SURF.WOOD).ao(0.9);
    b.box(0, g0 + 0.15, 0, 2.6, 0.18, 0.2); // mud sill
    b.box(0, top - 0.12, 0, 1.6, 0.13, 0.2); // cap
    for (const sx of [-0.55, 0.55]) b.beam(sx, g0, 0, sx, top - 0.2, 0, 0.13, 0.13, 4);
    for (const sx of [-1, 1]) b.beam(sx * 2.3, g0, 0, sx * 1.25, top - 0.2, 0, 0.13, 0.13, 4);
    b.color(0.2, 0.14, 0.09);
    const h = top - g0;
    if (h > 1.4) {
      b.beam(-2.2, g0 + 0.3, 0.17, 1.4, top - 0.3, 0.17, 0.06, 0.06, 4);
      b.beam(2.2, g0 + 0.3, -0.17, -1.4, top - 0.3, -0.17, 0.06, 0.06, 4);
    }
    b.pop();
  }
  // guard timbers along the deck ends
  b.timeless().appear(f - 0.012, f - 0.008, MOTION.POP, 0, BY.BUILT);
  b.color(0.2, 0.15, 0.1).surface(SURF.WOOD);
  for (const o of [-1.5, 1.5]) {
    for (let k = 0; k < 3; k++) { const z = TR1 - k * (TR1 - TR0) / 2; SEG[k * 3] = trackX(z) + o; SEG[k * 3 + 1] = railY(z) - 0.14; SEG[k * 3 + 2] = z; }
    b.extrude(SEG, [0.1, -0.1, 0.1, 0.06, -0.1, 0.06, -0.1, -0.1], FLAT);
  }
  b.timeless();
}

function depot(b, seed) {
  const zc = 63, xt = trackX(zc), f = sAtZ(84) / S;
  // platform: plank deck on the road side of the track
  b.timeless().pivot(0, 0, 0).appear(f - 0.02, f, MOTION.RISE, 1.2, BY.BUILT);
  b.color(0.3, 0.26, 0.21).surface(SURF.WOOD).ao(0.95);
  b.push(); b.at(xt + 4.0, 0, 64, Math.atan(2 * KX * 64));
  b.box(0, 0.25, 0, 2.15, 0.85, 17.5);
  b.color(0.2, 0.15, 0.1).box(2.17, 0.7, 0, 0.04, 0.12, 17.5);
  b.pop();
  // the depot: board-and-batten, buff with brown trim, deep eaves on brackets
  const dx = xt + 10.6;
  b.timeless().pivot(dx, -0.8, zc).appear(f - 0.02, f + 0.0, MOTION.CLIP, 7.6, BY.BUILT);
  b.push(); b.translate(dx, 0, zc);
  b.color(0.24, 0.2, 0.17).surface(SURF.STONE).ao(0.9);
  b.box(0, 0.1, 0, 3.75, 0.9, 8.6);
  b.color(0.47, 0.35, 0.18).surface(SURF.WOOD).ao(1);
  b.box(0, 2.75, 0, 3.6, 1.75, 8.4);
  b.color(0.2, 0.12, 0.07).surface(SURF.WOOD);
  for (const sx of [-3.62, 3.62]) for (const sz of [-8.42, 8.42]) b.box(sx, 2.75, sz, 0.1, 1.75, 0.1);
  b.box(0, 1.08, 0, 3.66, 0.08, 8.46); // sill board
  // doors and windows on both long sides (track side +x, road side -x), and the ends
  b.ao(0.8);
  for (const sx of [-1, 1]) {
    for (const wz of [-6, -3, 3, 6]) { b.color(0.05, 0.06, 0.07).box(sx * 3.63, 3.0, wz, 0.05, 0.75, 0.48); b.color(0.2, 0.12, 0.07).box(sx * 3.66, 3.85, wz, 0.06, 0.08, 0.62); }
    b.color(0.12, 0.08, 0.05).box(sx * 3.63, 2.35, 0, 0.05, 1.3, 0.6);
    b.color(0.2, 0.12, 0.07).box(sx * 3.66, 3.75, 0, 0.06, 0.1, 0.75);
  }
  for (const sz of [-1, 1]) { b.color(0.05, 0.06, 0.07).box(0, 3.1, sz * 8.43, 0.5, 0.7, 0.05); }
  // telegrapher's bay on the track side
  b.color(0.47, 0.35, 0.18).ao(1).box(-3.9, 2.7, 1.2, 0.5, 1.6, 1.4);
  b.color(0.05, 0.06, 0.07).box(-4.42, 3.0, 1.2, 0.04, 0.6, 1.0);
  // roof: two slabs, ridge along z
  b.color(0.17, 0.12, 0.1).surface(SURF.WOOD).ao(1);
  const ry = 6.7, ey = 4.25, ew = 5.4, rl = 9.6;
  b.hexa([-ew, ey, -rl, 0, ry, -rl, 0, ry, rl, -ew, ey, rl, -ew, ey + 0.16, -rl, 0, ry + 0.16, -rl, 0, ry + 0.16, rl, -ew, ey + 0.16, rl]);
  b.hexa([0, ry, -rl, ew, ey, -rl, ew, ey, rl, 0, ry, rl, 0, ry + 0.16, -rl, ew, ey + 0.16, -rl, ew, ey + 0.16, rl, 0, ry + 0.16, rl]);
  // gable ends
  b.color(0.47, 0.35, 0.18).surface(SURF.WOOD);
  for (const sz of [-8.4, 8.4]) b.hexa([-3.6, 4.5, sz - 0.05, 3.6, 4.5, sz - 0.05, 3.6, 4.5, sz + 0.05, -3.6, 4.5, sz + 0.05, -0.02, 6.6, sz - 0.05, 0.02, 6.6, sz - 0.05, 0.02, 6.6, sz + 0.05, -0.02, 6.6, sz + 0.05]);
  // brackets under the eaves
  b.color(0.2, 0.12, 0.07);
  for (const sx of [-1, 1]) for (let bz = -7.5; bz <= 7.6; bz += 3) b.beam(sx * 3.6, 3.6, bz, sx * 4.9, 4.4, bz, 0.06, 0.06, 4);
  // chimney
  b.color(0.3, 0.13, 0.08).surface(SURF.STONE).box(-1.2, 6.9, -4.5, 0.32, 1.1, 0.32);
  b.pop();
  // freight on the platform, a baggage cart, two waiting passengers
  b.timeless().appear(f, f + 0.01, MOTION.POP, 0, BY.BUILT);
  b.surface(SURF.WOOD).ao(0.9);
  const px = xt + 4.2;
  for (let i = 0; i < 4; i++) { b.color(0.25, 0.17, 0.1); b.push(); b.translate(px + 1 - 0.7 * (i & 1), 1.1, 73 + i * 0.75); b.cylinder(0.3, 0.8, 8); b.pop(); }
  b.color(0.3, 0.22, 0.13).box(px + 0.2, 1.5, 76.5, 0.6, 0.4, 0.5).box(px + 0.1, 2.1, 76.6, 0.45, 0.2, 0.4);
  b.color(0.18, 0.12, 0.08).box(px, 1.55, 51, 0.7, 0.08, 1.3);
  b.color(0.1, 0.07, 0.05);
  for (const s of [-1, 1]) { b.push(); b.translate(px + s * 0.72, 1.4, 51); b.rotateZ(Math.PI / 2); b.translate(0, -0.04, 0); b.cylinder(0.32, 0.08, 10); b.pop(); }
  b.color(0.09, 0.08, 0.1).surface(SURF.HIDE).ao(1);
  b.push(); b.at(px + 0.6, 1.1, 59, 1.4); b.human(POSE.STAND, 1.75, seed + 1); b.pop();
  b.color(0.2, 0.1, 0.08);
  b.push(); b.at(px + 1.1, 1.1, 60.2, 1.9); b.human(POSE.STAND, 1.62, seed + 2); b.pop();
  b.timeless();
}

function tower(b) {
  const z = TOWER_Z, x = trackX(z) + 6.4, f = sAtZ(z + 25) / S;
  b.timeless().pivot(x, 0, z).appear(f - 0.025, f, MOTION.CLIP, 12.5, BY.BUILT);
  b.push(); b.translate(x, 0, z);
  b.color(0.22, 0.16, 0.11).surface(SURF.WOOD).ao(0.95);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(sx * 2.6, -0.2, sz * 2.6, 0.45, 0.4, 0.45);
    b.beam(sx * 2.7, 0, sz * 2.7, sx * 2.0, 6.1, sz * 2.0, 0.17, 0.15, 4);
  }
  b.color(0.19, 0.14, 0.09);
  for (const k of [0, 1]) for (const s of [-1, 1]) {
    const a = k ? 2.4 : 2.45, y0 = 0.6, y1 = 5.5;
    if (k) { b.beam(s * 2.6, y0, -a, -s * 2.05, y1, -a + 0.05, 0.07, 0.07, 4); b.beam(s * 2.6, y0, a, -s * 2.05, y1, a - 0.05, 0.07, 0.07, 4); }
    else { b.beam(-a, y0, s * 2.6, -a + 0.05, y1, -s * 2.05, 0.07, 0.07, 4); b.beam(a, y0, s * 2.6, a - 0.05, y1, -s * 2.05, 0.07, 0.07, 4); }
  }
  b.box(0, 6.15, 0, 2.7, 0.15, 2.7);
  // the tank: staves and iron hoops, a shallow conical roof
  b.color(0.33, 0.15, 0.08).surface(SURF.WOOD).ao(1);
  b.push(); b.translate(0, 6.3, 0); b.lathe([3.05, 0, 3.15, 2.1, 3.05, 4.2], 24); b.pop();
  b.color(0.1, 0.09, 0.09).surface(SURF.PLAIN);
  for (const hy of [6.8, 7.8, 8.8, 9.8]) { b.push(); b.translate(0, hy, 0); b.lathe([3.16, 0, 3.17, 0.1], 24, { caps: false }); b.pop(); }
  b.color(0.16, 0.12, 0.1).surface(SURF.WOOD);
  b.push(); b.translate(0, 10.45, 0); b.lathe([3.5, 0, 3.4, 0.12, 0.1, 1.5, 0, 1.55], 24); b.pop();
  // the spout, hinged on the track side, raised; the counterweight chain
  b.color(0.13, 0.11, 0.1).surface(SURF.PLAIN).ao(1);
  b.beam(-3.1, 7.3, 0, -4.9, 8.7, 0, 0.2, 0.17, 8);
  b.beam(-4.9, 8.7, 0, -5.3, 8.75, 0, 0.17, 0.2, 8);
  b.beam(-4.6, 8.5, 0, -3.3, 10.2, 0, 0.025, 0.025, 3);
  // ladder
  b.color(0.2, 0.15, 0.1).surface(SURF.WOOD);
  for (const sz of [-0.3, 0.3]) b.beam(2.75, 0, sz + 1.2, 3.25, 10.2, sz + 1.2, 0.04, 0.04, 3);
  b.pop();
  b.timeless();
}

// --- the train (each part built facing +z around its own centre, rail top at y = 0)
function wheel(b, x, y, z, r, w, red) {
  b.push(); b.translate(x, y, z); b.rotateZ(Math.PI / 2);
  b.color(0.05, 0.045, 0.045).surface(SURF.PLAIN); b.push(); b.translate(0, -w / 2, 0); b.cylinder(r, w, 16); b.pop();
  b.color(red ? 0.42 : 0.08, red ? 0.05 : 0.07, red ? 0.03 : 0.065); b.push(); b.translate(0, -w / 2 - 0.02, 0); b.cylinder(r * 0.84, w + 0.04, 16); b.pop();
  b.color(0.5, 0.36, 0.13).surface(SURF.GILT); b.push(); b.translate(0, -w / 2 - 0.04, 0); b.cylinder(r * 0.18, w + 0.08, 8); b.pop();
  b.pop();
}
function truck(b, z, r) { // a four-wheel truck
  b.color(0.07, 0.065, 0.06).surface(SURF.PLAIN).ao(0.8);
  b.box(0, r + 0.1, z, 1.0, 0.16, 1.15);
  for (const dz of [-0.75, 0.75]) for (const sx of [-0.78, 0.78]) wheel(b, sx, r, z + dz, r, 0.1, false);
}

function loco(b) {
  const GREEN = [0.05, 0.09, 0.075], RED = [0.42, 0.07, 0.04], WOOD = [0.3, 0.11, 0.05];
  // frame, running boards
  b.color(0.06, 0.055, 0.05).surface(SURF.PLAIN).ao(0.85);
  b.box(0, 1.15, 2.4, 0.55, 0.25, 4.1);
  b.box(0, 1.47, 2.2, 1.3, 0.04, 3.6);
  // boiler, bands, smokebox
  b.color(GREEN[0], GREEN[1], GREEN[2]).surface(SURF.PLAIN).ao(1);
  b.beam(0, 2.1, -0.2, 0, 2.1, 5.0, 0.66, 0.68, 16);
  b.color(0.6, 0.42, 0.15).surface(SURF.GILT);
  for (const bz of [0.6, 1.9, 3.3, 4.6]) b.beam(0, 2.1, bz, 0, 2.1, bz + 0.09, 0.7, 0.7, 16, false);
  b.color(0.05, 0.05, 0.05).surface(SURF.PLAIN);
  b.beam(0, 2.05, 5.0, 0, 2.05, 6.15, 0.74, 0.74, 16);
  b.color(0.6, 0.42, 0.15).surface(SURF.GILT).beam(0, 2.05, 6.12, 0, 2.05, 6.2, 0.4, 0.4, 12);
  // balloon stack with its spark arrester
  b.color(0.05, 0.048, 0.046).surface(SURF.PLAIN);
  b.push(); b.translate(0, 2.6, 5.55);
  b.lathe([0.24, 0, 0.27, 0.9, 0.5, 1.25, 0.78, 1.75, 0.82, 2.05, 0.66, 2.2, 0.0, 2.24], 16);
  b.pop();
  // headlamp on its bracket: a big box lamp with a lit lens and a glare card
  b.color(0.07, 0.06, 0.05).box(0, 2.9, 5.95, 0.12, 0.12, 0.12);
  b.color(0.12, 0.1, 0.08).surface(SURF.WOOD).box(0, 3.35, 5.95, 0.36, 0.38, 0.42);
  b.color(0.6, 0.42, 0.15).surface(SURF.GILT).box(0, 3.82, 5.95, 0.4, 0.1, 0.46).box(0, 4.0, 5.95, 0.08, 0.1, 0.08);
  b.color(1.0, 0.82, 0.5).surface(SURF.PLAIN).emissive(0.85, FLICKER.NONE).box(0, 3.35, 6.38, 0.25, 0.25, 0.02);
  b.emissive(0, 0);
  b.flash(0, 3.35, 6.5, 0.7, 4, 1.0, 0.82, 0.52);
  // brass steam dome, sand dome, bell, whistle
  b.color(0.62, 0.44, 0.16).surface(SURF.GILT).ao(1);
  b.push(); b.translate(0, 2.55, 2.4); b.lathe([0.44, 0, 0.44, 0.5, 0.38, 0.72, 0.2, 0.86, 0, 0.9], 16); b.pop();
  b.push(); b.translate(0, 2.55, 4.1); b.lathe([0.36, 0, 0.36, 0.34, 0.28, 0.5, 0, 0.56], 14); b.pop();
  b.push(); b.translate(0, 2.75, 3.3); b.lathe([0.2, 0, 0.2, 0.08, 0.17, 0.26, 0.08, 0.36, 0, 0.4], 10); b.pop();
  b.beam(0, 2.7, 0.6, 0, 3.15, 0.6, 0.05, 0.06, 6);
  // cylinders and valve chests, rods
  b.color(0.07, 0.065, 0.06).surface(SURF.PLAIN).ao(0.9);
  for (const sx of [-1.08, 1.08]) {
    b.beam(sx, 0.95, 4.1, sx, 0.95, 5.35, 0.3, 0.3, 10);
    b.color(0.6, 0.42, 0.15).surface(SURF.GILT).beam(sx, 0.95, 5.35, sx, 0.95, 5.42, 0.32, 0.32, 10).beam(sx, 0.95, 4.03, sx, 0.95, 4.1, 0.32, 0.32, 10);
    b.color(0.07, 0.065, 0.06).surface(SURF.PLAIN).box(sx, 1.42, 4.72, 0.2, 0.2, 0.6);
    b.color(0.3, 0.3, 0.3).surface(SURF.POLISH);
    b.beam(sx * 1.06, 0.95, 4.0, sx * 1.06, 0.7, 1.35, 0.05, 0.05, 4);
    b.beam(sx * 1.06, 0.62, 1.35, sx * 1.06, 0.62, -0.75, 0.04, 0.04, 4);
    b.color(0.07, 0.065, 0.06).surface(SURF.PLAIN);
  }
  // drivers (red) under splashers, leading truck
  for (const dz of [1.35, -0.75]) for (const sx of [-0.88, 0.88]) wheel(b, sx, 0.8, dz, 0.8, 0.13, true);
  b.color(0.6, 0.42, 0.15).surface(SURF.GILT);
  for (const dz of [1.35, -0.75]) for (const sx of [-0.9, 0.9]) { b.push(); b.translate(sx, 0.8, dz); b.rotateZ(Math.PI / 2); b.translate(0, -0.1, 0); b.lathe([0.86, 0, 0.86, 0.2], 14, { caps: false, a0: 0.2, a1: Math.PI - 0.2 }); b.pop(); }
  for (const dz of [3.9, 5.05]) for (const sx of [-0.8, 0.8]) wheel(b, sx, 0.42, dz, 0.42, 0.1, true);
  // firebox under the cab
  b.color(0.05, 0.05, 0.05).surface(SURF.PLAIN).box(0, 1.45, -1.0, 0.7, 0.9, 0.8);
  // cab: varnished red wood, windows, arched roof
  b.color(WOOD[0], WOOD[1], WOOD[2]).surface(SURF.WOOD).ao(1);
  b.box(0, 1.9, -1.4, 1.3, 0.45, 1.25);
  for (const sx of [-1.24, 1.24]) { b.box(sx, 3.05, -0.35, 0.06, 0.7, 0.2); b.box(sx, 3.05, -2.45, 0.06, 0.7, 0.2); b.box(sx, 3.05, -1.4, 0.06, 0.7, 0.1); }
  b.box(0, 2.8, -0.2, 1.3, 0.95, 0.06);
  b.color(0.6, 0.42, 0.15).surface(SURF.GILT).box(0, 2.36, -1.4, 1.32, 0.05, 1.27);
  b.color(0.12, 0.08, 0.06).surface(SURF.WOOD);
  b.push(); b.translate(0, 3.6, -1.4);
  b.extrude([0, 0, -1.55, 0, 0, 1.45], [1.55, 0.02, 1.0, 0.25, 0, 0.33, -1.0, 0.25, -1.55, 0.02, -1.55, -0.05, -1.0, 0.18, 0, 0.26, 1.0, 0.18, 1.55, -0.05], { smooth: false });
  b.pop();
  // pilot (cowcatcher) and buffer beam
  b.color(RED[0], RED[1], RED[2]).surface(SURF.WOOD).ao(0.9);
  b.box(0, 1.15, 6.25, 1.25, 0.2, 0.12);
  b.hexa([-1.2, 0.1, 6.35, 1.2, 0.1, 6.35, 0.12, 0.1, 8.9, -0.12, 0.1, 8.9, -1.2, 1.0, 6.35, 1.2, 1.0, 6.35, 0.1, 1.0, 6.6, -0.1, 1.0, 6.6]);
  b.color(0.2, 0.04, 0.03);
  for (let k = -3; k <= 3; k++) b.beam(k * 0.32, 1.02, 6.4, k * 0.045, 0.1, 8.86, 0.035, 0.035, 3, false);
  // tender: tank body, cordwood stacked on top, two trucks
  b.color(WOOD[0] * 0.9, WOOD[1], WOOD[2]).surface(SURF.WOOD).ao(1);
  b.box(0, 1.85, -5.8, 1.3, 0.75, 3.1);
  b.color(0.6, 0.42, 0.15).surface(SURF.GILT).box(0, 2.62, -5.8, 1.33, 0.04, 3.13);
  b.color(0.06, 0.055, 0.05).surface(SURF.PLAIN).box(0, 1.08, -5.8, 1.2, 0.08, 3.0);
  b.surface(SURF.WOOD).ao(0.95);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 7 - r; k++) {
    const c = 0.24 + 0.08 * ((k * 7 + r * 3) % 5) / 5;
    b.color(c, c * 0.68, c * 0.42);
    const x = (k - (6 - r) / 2) * 0.36;
    b.beam(x, 2.84 + r * 0.31, -8.4, x, 2.84 + r * 0.31, -3.4, 0.17, 0.17, 6);
  }
  truck(b, -4.2, 0.45); truck(b, -7.4, 0.45);
  b.color(0.06, 0.055, 0.05).surface(SURF.PLAIN).box(0, 1.0, -2.6, 0.12, 0.08, 0.4);
  // smoke standing up from the stack, steam at the cylinders
  b.smoke(0, 4.9, 5.55, { count: 16, size: 0.75, rise: 16, density: 0.32, color: [0.36, 0.35, 0.35], src: FLICKER.OWN });
  b.smoke(0, 3.4, 2.4, { count: 4, size: 0.25, rise: 2.5, density: 0.22, color: [0.62, 0.62, 0.62], src: FLICKER.OWN });
}
// The plume streaming back from the stack while the train runs (rig 2; gain = speed).
function plume(b) {
  for (let j = 0; j < 12; j++) {
    b.smoke(0, 5.0 + j * 0.42 + 0.02 * j * j, 5.4 - j * 4.4, { count: 3 + (j % 3), size: 0.95 + 0.26 * j, rise: 2.5 + 0.5 * j, density: 0.4 * (1 - j / 14), color: [0.34, 0.33, 0.33], src: FLICKER.OWN });
  }
  b.smoke(-1.1, 0.9, 4.4, { count: 5, size: 0.4, rise: 1.6, density: 0.3, color: [0.64, 0.64, 0.64], src: FLICKER.OWN });
  b.smoke(1.1, 0.9, 4.4, { count: 5, size: 0.4, rise: 1.6, density: 0.3, color: [0.64, 0.64, 0.64], src: FLICKER.OWN });
}
function coach(b) {
  b.color(0.07, 0.16, 0.11).surface(SURF.WOOD).ao(1);
  b.box(0, 2.2, 0, 1.35, 1.05, 6.2);
  b.color(0.06, 0.055, 0.05).surface(SURF.PLAIN).ao(0.85).box(0, 1.08, 0, 1.3, 0.1, 6.95);
  b.color(0.55, 0.42, 0.2).surface(SURF.GILT).box(0, 2.62, 0, 1.37, 0.03, 6.22).box(0, 1.6, 0, 1.37, 0.03, 6.22);
  b.color(0.05, 0.06, 0.07).surface(SURF.PLAIN).ao(0.8);
  for (let k = 0; k < 10; k++) { const z = -5.2 + k * 1.155; b.box(-1.36, 2.55, z, 0.03, 0.38, 0.33); b.box(1.36, 2.55, z, 0.03, 0.38, 0.33); }
  // roof with clerestory
  b.color(0.14, 0.13, 0.12).surface(SURF.PLAIN).ao(1);
  b.hexa([-1.5, 3.25, -6.9, 1.5, 3.25, -6.9, 1.5, 3.25, 6.9, -1.5, 3.25, 6.9, -0.7, 3.55, -6.9, 0.7, 3.55, -6.9, 0.7, 3.55, 6.9, -0.7, 3.55, 6.9]);
  b.color(0.07, 0.16, 0.11).surface(SURF.WOOD).box(0, 3.72, 0, 0.66, 0.18, 6.1);
  b.color(0.14, 0.13, 0.12).surface(SURF.PLAIN);
  b.hexa([-0.85, 3.9, -6.3, 0.85, 3.9, -6.3, 0.85, 3.9, 6.3, -0.85, 3.9, 6.3, -0.2, 4.05, -6.3, 0.2, 4.05, -6.3, 0.2, 4.05, 6.3, -0.2, 4.05, 6.3]);
  // end platforms with railings
  b.color(0.07, 0.065, 0.06);
  for (const s of [-1, 1]) { b.beam(-1.2, 1.2, s * 6.9, -1.2, 2.2, s * 6.9, 0.03, 0.03, 3); b.beam(1.2, 1.2, s * 6.9, 1.2, 2.2, s * 6.9, 0.03, 0.03, 3); b.beam(-1.2, 2.2, s * 6.9, -0.5, 2.2, s * 6.9, 0.03, 0.03, 3); b.beam(1.2, 2.2, s * 6.9, 0.5, 2.2, s * 6.9, 0.03, 0.03, 3); }
  truck(b, -4.8, 0.42); truck(b, 4.8, 0.42);
}
function boxcar(b) {
  b.color(0.3, 0.085, 0.05).surface(SURF.WOOD).ao(1);
  b.box(0, 2.25, 0, 1.3, 1.15, 4.95);
  b.color(0.06, 0.055, 0.05).surface(SURF.PLAIN).ao(0.85).box(0, 1.03, 0, 1.25, 0.1, 5.2);
  b.color(0.2, 0.06, 0.035).surface(SURF.WOOD);
  for (const s of [-1, 1]) { b.box(s * 1.33, 2.2, 0, 0.04, 0.95, 0.9); b.box(s * 1.33, 3.22, 0, 0.05, 0.05, 1.6); }
  b.color(0.24, 0.07, 0.04);
  b.hexa([-1.45, 3.4, -5.1, 1.45, 3.4, -5.1, 1.45, 3.4, 5.1, -1.45, 3.4, 5.1, -0.05, 3.72, -5.1, 0.05, 3.72, -5.1, 0.05, 3.72, 5.1, -0.05, 3.72, 5.1]);
  b.color(0.16, 0.12, 0.09).box(0, 3.76, 0, 0.3, 0.04, 5.0);
  truck(b, -3.4, 0.42); truck(b, 3.4, 0.42);
}

// The railhead (rig 7): loose ties on the grade ahead, rails waiting, a rail truck, stacks,
// gangs, the tent camp with a cook fire. Built facing +z (the laying direction), rail top 0.
function railhead(b, seed) {
  b.surface(SURF.WOOD).ao(0.9);
  for (let z = 0.5; z < 13; z += 0.62) { const c = 0.14 + 0.05 * b.rand(); b.color(c * 1.1, c * 0.82, c * 0.6); b.box(0, -0.235, z, 1.3, 0.07, 0.11, false); }
  b.color(0.24, 0.21, 0.2).surface(SURF.PLAIN);
  b.box(-0.75, -0.08, 5.4, 0.035, 0.08, 4.8).box(0.75, -0.08, 5.4, 0.035, 0.08, 4.8);
  // rail truck with rails and ties
  b.color(0.22, 0.16, 0.1).surface(SURF.WOOD).box(0, 0.7, -5, 1.2, 0.12, 2.6);
  for (const dz of [-6.6, -3.4]) for (const sx of [-0.78, 0.78]) wheel(b, sx, 0.35, dz, 0.35, 0.08, false);
  b.color(0.25, 0.22, 0.21).surface(SURF.PLAIN);
  for (let k = 0; k < 6; k++) b.box(-0.9 + k * 0.36, 0.88, -5, 0.04, 0.06, 2.5);
  // stacks of ties and rails beside the bank, on the ground (about 1.3 m below the rail top)
  b.surface(SURF.WOOD).ao(0.85);
  for (let s = 0; s < 3; s++) {
    const sx = 5.5 + s * 0.2, sz = -8 + s * 6;
    for (let r = 0; r < 6; r++) { b.color(0.15 + 0.03 * (r & 1), 0.11, 0.075); b.box(sx, -1.25 + r * 0.24, sz, r & 1 ? 1.3 : 0.9, 0.11, r & 1 ? 0.9 : 1.3); }
  }
  b.color(0.24, 0.21, 0.2).surface(SURF.PLAIN);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 5 - r; k++) b.box(-5.2 + k * 0.2 + r * 0.1, -1.24 + r * 0.14, -2, 0.05, 0.07, 4.2);
  // the gangs: spikers kneeling at the ties, a pair carrying a rail, bosses standing
  b.color(0.16, 0.13, 0.1).surface(SURF.HIDE).ao(1);
  const G = [-1.4, 1.0, 1.6, 3, 1.5, 1.6, -1.5, 2.6, -1.6, 3, -1.3, 4.0, 0.0, 6.2, 0, 4, 0.0, 9.0, 0, 4, 1.9, 8.0, -2.8, 0, -2.1, 11.5, 2.5, 0, 3.6, -1.2, -1.6, 0];
  for (let i = 0; i < G.length; i += 4) {
    b.push(); b.at(G[i], G[i + 3] === 4 ? -0.25 : -0.3, G[i + 1], G[i + 2]); b.human(G[i + 3], 1.72, seed + 20 + i); b.pop();
  }
  // tents and a cook fire (on the far side, +x)
  for (let k = 0; k < 5; k++) {
    const tx = 15 + (k % 2) * 7 + b.rand() * 2, tz = -16 + k * 7.5, c = 0.52 + 0.05 * b.rand();
    b.push(); b.at(tx, -1.5, tz, 0.2 * (b.rand() - 0.5));
    b.color(c, c * 0.96, c * 0.86).surface(SURF.HIDE).ao(1);
    b.extrude([0, 0, -2.1, 0, 0, 2.1], [1.8, 0, 0, 2.5, -1.8, 0], { closed: false, smooth: false, caps: false });
    b.extrude([0, 0, 2.1, 0, 0, -2.1], [1.8, 0, 0, 2.5, -1.8, 0], { closed: false, smooth: false, caps: false });
    b.color(c * 0.9, c * 0.86, c * 0.76).hexa([-1.8, 0, -2.1, 1.8, 0, -2.1, 1.8, 0, -2.08, -1.8, 0, -2.08, 0, 2.5, -2.1, 0, 2.5, -2.1, 0, 2.5, -2.08, 0, 2.5, -2.08]);
    b.color(0.04, 0.04, 0.04).hexa([-0.6, 0, 2.12, 0.6, 0, 2.12, 0.6, 0, 2.13, -0.6, 0, 2.13, 0, 1.7, 2.12, 0, 1.7, 2.12, 0, 1.7, 2.13, 0, 1.7, 2.13]);
    b.pop();
  }
  b.color(0.1, 0.07, 0.05).surface(SURF.WOOD);
  b.beam(27.5, -1.5, 3, 27.5, 0.5, 3, 0.05, 0.05, 4).beam(27.5, 0.5, 3, 28.5, -1.5, 2.2, 0.05, 0.05, 4);
  b.flames(28, -1.45, 3, 0.9, FLICKER.OWN, seed + 7);
  b.smoke(28, -0.6, 3, { count: 14, size: 0.6, rise: 14, density: 0.3, color: [0.36, 0.36, 0.38], src: FLICKER.OWN });
  b.color(0.16, 0.13, 0.1).surface(SURF.HIDE);
  b.push(); b.at(26.5, -1.5, 4.5, 2.4); b.human(POSE.SIT, 1.7, seed + 40); b.pop();
}

export default {
  id: 'railroad',
  name: 'Transcontinental railroad',
  caption: 'The rails meet across the plains and the first trains run coast to coast',
  year: 1869,
  radius: 125, // the site; the line itself runs ~300 m each way along the road
  pad: 74,
  roadOffset: 80, // the track is 88 m from the road centre at the site
  straddlesRoad: false,
  biome: 'steppe',
  live: true,
  reach: 330,
  wind: [0.85, 0.5],
  lights: [],
  approach: 700, cone: 0.5,
  detail: { at: [8, 2.5, 40], from: [-14, 4, 64] },
  strip: { at: [8, 2, 10], from: [-70, 20, 120], fov: 0.62 },
  // Event moment: from the road side, low, over the line to the depot and the tower beyond it,
  // the train standing or running in front of them against the prairie sky.
  witness: { at: [16, 56], dist: 78, height: 9, look: 3.5, az: -0.3, fov: 0.5, drift: 0.07, range: 1000 },
  // Emigrant wagon camps out on the plain beyond the line, smoke rising from their fires.
  satellites: {
    count: [3, 5], near: 1, nearR: [300, 380], farR: [420, 1000],
    centre: 0.0, spread: 2.2, minSep: 120, roadClear: 60,
    build(b, k, n, dist) {
      const s = 1 + Math.min(1.2, dist / 600);
      b.timeless().pivot(0, 0, 0).appear(0.2 + 0.4 * k / n, 0.22 + 0.4 * k / n, MOTION.POP, 0, BY.BUILT);
      for (let w = 0; w < 2; w++) {
        b.push(); b.at(w * 7 * s - 3 * s, 0, w * 3 * s - 6 * s, 0.4 + w * 0.9); b.scale(s);
        b.color(0.2, 0.13, 0.08).surface(SURF.WOOD).ao(1).box(0, 1.0, 0, 0.62, 0.28, 2.0);
        b.color(0.58, 0.56, 0.49).surface(SURF.HIDE);
        b.extrude([0, 1.25, -1.9, 0, 1.25, 1.9], [0.75, 0, 0.65, 0.5, 0.38, 0.85, 0, 0.98, -0.38, 0.85, -0.65, 0.5, -0.75, 0], { closed: false });
        b.extrude([0, 1.25, 1.9, 0, 1.25, -1.9], [0.75, 0, 0.65, 0.5, 0.38, 0.85, 0, 0.98, -0.38, 0.85, -0.65, 0.5, -0.75, 0], { closed: false });
        b.color(0.1, 0.08, 0.06).surface(SURF.WOOD);
        for (const dz of [-1.4, 1.4]) for (const sx of [-0.72, 0.72]) { b.push(); b.translate(sx, 0.55, dz); b.rotateZ(Math.PI / 2); b.cylinder(0.55, 0.08, 10); b.pop(); }
        b.pop();
      }
      b.push(); b.translate(5 * s, 0, 4 * s); b.farFire(1 + dist / 900, 34 + 18 * dist / 1000, 1, 5); b.pop();
      b.timeless();
    },
  },

  build(b, built, decay, seed) {
    landform(b);
    track(b, seed);
    trestle(b);
    telegraph(b);
    depot(b, seed);
    tower(b);
    // the train: loco + tender (1), its running plume (2), coaches (3, 4), boxcars (5, 6)
    b.timeless().rig(1); loco(b);
    b.rig(2, false); plume(b);
    b.rig(3); coach(b);
    b.rig(4); coach(b);
    b.rig(5); boxcar(b);
    b.rig(6); boxcar(b);
    b.rig(7); railhead(b, seed);
    b.rig(0);
    return b.counts();
  },

  animate(a) {
    let head = 0, dir = 1, spd = 0, on = true;
    if (a.built < 1) {
      // laying: the work train stands behind the railhead, the camp at the end of track
      const sr = a.built * S;
      let i = 0;
      while (i < NP - 2 && CUM[i + 1] <= sr + 0.002 * S) i++;
      const se = CUM[i];
      head = Math.max(LEN + 2, se - 26);
      if (se > 1) { pathAt(TRACK, se / S, P); a.set(7, P[0], P[1], P[2], P[3], P[4]).show(7, true); } else a.show(7, false);
    } else {
      a.show(7, false);
      const c = loop(a.t, CYCLE) * CYCLE;
      if (c < RUN[2]) { travel(c, 0); head = LEN + 5 + R[0]; dir = 1; spd = R[1]; }
      else if (c >= RUN[2] + PAUSE && c < RUN[2] + PAUSE + RUN[6]) { travel(c - RUN[2] - PAUSE, 4); head = S - LEN - 5 - R[0]; dir = -1; spd = R[1]; }
      else on = false;
    }
    for (let k = 0; k < 6; k++) {
      const s = head - dir * OFF[k], r = RIGS_T[k];
      if (!on || s < 0 || s > S) { a.show(r, false); continue; }
      pathAt(TRACK, s / S, P);
      a.set(r, P[0], P[1], P[2], dir > 0 ? P[3] : P[3] + Math.PI, dir > 0 ? P[4] : -P[4]).show(r, true);
    }
    a.gain(2, spd);
  },
};
