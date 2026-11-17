// Apollo 11, 1969: the Saturn V on Launch Complex 39A, seen across flat coastal marsh from
// the road about a kilometre away.
//
// built is a STEP (0 until clock 277.2, then 1); decay (0 -> 1 over clock 277.4-286) is the
// timeline of the ascent.
//   built 0: the rocket stands on the grey mobile launcher beside the red umbilical tower,
//     swing arms in, vapour venting from the tanks, floodlights on; the gravel crawlerway runs
//     back to the assembly building.
//   built 1, decay 0: ignition. Flame jets and a white-hot glare at the flame trench, the first
//     clouds of steam burst out of both trench mouths, the swing arms swing back.
//   decay 0 -> 1: the rocket lifts slowly, clears the tower (~0.1), pitches over and climbs on
//     a long pillar of flame over the sea, leaving a growing exhaust trail, and dwindles to a
//     bright point (~13 km downrange, ~4 km up at 1). The ground clouds roll out, a column rises
//     over the pad, then they drift and thin; the pad is scorched; the tower stands empty.
//
// Layout (landmark-local): the pad (origin) stands ROAD_OFF m from the road. The flame trench
// runs along z, so the clouds burst out sideways as seen from the road. The umbilical tower is
// on the -z side of the rocket. The crawlerway leaves the mound toward (+x, -z) for the
// assembly building. Spectators are satellites near the road, facing the pad.
//
// Rigs: 1 the rocket, 2 its flame (scaled with height), 3 ground clouds (scaled and drifted),
// 4 the exhaust trail (built at 1/K_TRAIL scale, yawed downrange), 5 ignition jets and glare,
// 6 floodlight glare, 7 the rocket's bright point. The ascent heads out to sea (a.seaX/seaZ);
// when the sea lies behind the road it is turned toward the road ahead instead of overhead.

import { SURF, POSE, FLICKER, MOTION, BY, seg, ease } from './kit.js';

const PI = Math.PI;
const ROAD_OFF = 640, PAD = 400, RADIUS = 420; // (integration: was 950, too far to read from the road)
const MOUND = 12; // hardstand top
const DECK = 24.5; // mobile launcher deck
const RY = DECK + 0.4; // rocket base (rig 1 origin at rest)
const LUT_Z = -21; // umbilical tower centre (z); its rocket-side face is at -15
const TOP = DECK + 122; // tower top
const K_TRAIL = 40; // the trail is built at 1/K and drawn at K (bind pose stays on the pad)
const WIND_X = 0.55, WIND_Z = -0.83;

const WHITE = [0.6, 0.6, 0.58], BLACK = [0.03, 0.03, 0.035], GREY = [0.3, 0.3, 0.31], SILVER = [0.5, 0.51, 0.52];
const RED = [0.4, 0.075, 0.045];

// ---------------------------------------------------------------- ascent (module tables)
// Arc length s(u) = L (p u^2 + (1-p) u^3); flight path angle from vertical eases in once the
// rocket is ~140 m up. A long low arc keeps it in a road-side frame (peak elevation ~23 deg
// seen from 1.5 km behind the pad).
const NT = 256;
const TH = new Float64Array(NT + 1), TR = new Float64Array(NT + 1), TG = new Float64Array(NT + 1);
{
  const L = 14000, p = 0.85, GM = 1.32, KK = 600, SUB = 8;
  let h = 0, r = 0, sp = 0;
  for (let i = 1; i <= NT * SUB; i++) {
    const t = i / (NT * SUB), s = L * (p * t * t + (1 - p) * t * t * t), ds = s - sp; sp = s;
    const g = GM * (1 - Math.exp(-Math.max(0, s - 140) / KK));
    h += ds * Math.cos(g); r += ds * Math.sin(g);
    if (i % SUB === 0) { const k = i / SUB; TH[k] = h; TR[k] = r; TG[k] = g; }
  }
}
const T3 = new Float64Array(3); // traj() output: r (downrange), h (height), gamma (from vertical)
function traj(u, out) {
  const x = (u < 0 ? 0 : u > 1 ? 1 : u) * NT, i = Math.min(NT - 1, x | 0), f = x - i;
  out[0] = TR[i] + (TR[i + 1] - TR[i]) * f;
  out[1] = TH[i] + (TH[i + 1] - TH[i]) * f;
  out[2] = TG[i] + (TG[i + 1] - TG[i]) * f;
  return out;
}

// ---------------------------------------------------------------- scratch
const PR = new Float64Array(8); // lathe profile
const PATH = new Float64Array(9), SCL = new Float64Array(3);
const RING = new Float64Array(16); // unit circle, counter-clockwise
for (let i = 0; i < 8; i++) { RING[i * 2] = Math.cos(i * PI / 4); RING[i * 2 + 1] = Math.sin(i * PI / 4); }
const WAT = new Float64Array([300, 0]); // witness look-at (local x, z): a little downrange
const WAZ = new Float64Array([0]); // witness azimuth: behind the launch, looking downrange

const col = (b, c, k = 1) => b.color(c[0] * k, c[1] * k, c[2] * k);
function lathe2(b, r0, y0, r1, y1, seg, a0, a1) {
  PR[0] = r0; PR[1] = y0; PR[2] = r1; PR[3] = y1;
  return b.lathe(PR.subarray(0, 4), seg, a0 === undefined ? { caps: false } : { a0, a1, caps: false });
}

// ---------------------------------------------------------------- the Saturn V (rig 1)
// y0, y1, r0, r1, paint: 0 white, 1 black, 2 roll pattern (black and white quarters), 3 grey,
// 4 silver. S-IC 0-42, interstage, S-II 47-66.5, adapter, S-IVB 72-87.5, IU, SLA, the
// spacecraft under its cover, then the escape tower.
const BANDS = [
  0, 2, 5.05, 5.05, 0, 2, 10, 5.05, 5.05, 2, 10, 25, 5.05, 5.05, 0, 25, 28.5, 5.05, 5.05, 1,
  28.5, 38, 5.05, 5.05, 0, 38, 42, 5.05, 5.05, 2, 42, 47, 5.05, 5.05, 0, 47, 47.6, 5.08, 5.08, 3,
  47.6, 63, 5.05, 5.05, 0, 63, 66.5, 5.05, 5.05, 2, 66.5, 72, 5.05, 3.3, 0, 72, 76, 3.3, 3.3, 2,
  76, 87.5, 3.3, 3.3, 0, 87.5, 88.5, 3.32, 3.32, 3, 88.5, 97, 3.3, 1.95, 4, 97, 100.6, 1.95, 0.32, 0,
];

function rocket(b, seed) {
  b.timeless().surface(SURF.PLAIN).ao(1);
  for (let i = 0; i < BANDS.length; i += 5) {
    const y0 = BANDS[i], y1 = BANDS[i + 1], r0 = BANDS[i + 2], r1 = BANDS[i + 3], p = BANDS[i + 4];
    if (p === 2) {
      for (let q = 0; q < 4; q++) { col(b, q & 1 ? BLACK : WHITE); lathe2(b, r0, y0, r1, y1, 6, q * PI / 2 + PI / 4, (q + 1) * PI / 2 + PI / 4); }
    } else {
      col(b, p === 1 ? BLACK : p === 3 ? GREY : p === 4 ? SILVER : WHITE);
      lathe2(b, r0, y0, r1, y1, 24);
    }
  }
  // base plate, F-1 bells (seen once it lifts), fairings and fins
  col(b, BLACK); PR[0] = 0.01; PR[1] = 0; PR[2] = 5.05; PR[3] = 0; b.lathe(PR.subarray(0, 4), 24, { caps: false });
  b.color(0.1, 0.1, 0.11).ao(0.8);
  for (let e = 0; e < 5; e++) {
    const a = PI / 4 + e * PI / 2, rr = e < 4 ? 3.25 : 0;
    b.push(); b.translate(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    PR[0] = 1.85; PR[1] = -5.8; PR[2] = 0.7; PR[3] = -1.4; PR[4] = 0.5; PR[5] = 0;
    b.lathe(PR.subarray(0, 6), 10, { caps: false });
    b.pop();
  }
  b.ao(1);
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + k * PI / 2, c = Math.cos(a), s = Math.sin(a);
    col(b, WHITE); b.beam(c * 4.7, -2.6, s * 4.7, c * 4.4, 8, s * 4.4, 1.85, 0.7, 8);
    col(b, BLACK);
    const t = 0.2, tc = -s * t, ts = c * t;
    b.hexa([c * 5 - tc, -1.8, s * 5 - ts, c * 5 + tc, -1.8, s * 5 + ts, c * 8.6 + tc, -1.2, s * 8.6 + ts, c * 8.6 - tc, -1.2, s * 8.6 - ts,
      c * 5 - tc, 6.5, s * 5 - ts, c * 5 + tc, 6.5, s * 5 + ts, c * 8.6 + tc, 1.6, s * 8.6 + ts, c * 8.6 - tc, 1.6, s * 8.6 - ts]);
  }
  // launch escape tower: a red truss, the motor, the nose
  b.color(0.3, 0.07, 0.045);
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + k * PI / 2, c = Math.cos(a), s = Math.sin(a);
    b.beam(c * 1.05, 100.3, s * 1.05, c * 0.38, 104.6, s * 0.38, 0.1, 0.08, 4);
  }
  b.beam(0.75, 102.4, 0, -0.75, 102.4, 0, 0.07, 0.07, 4).beam(0, 102.4, 0.75, 0, 102.4, -0.75, 0.07, 0.07, 4);
  col(b, WHITE); b.push(); b.translate(0, 104.5, 0); b.cylinder(0.36, 4.8, 12); b.pop();
  col(b, BLACK); lathe2(b, 0.37, 104.5, 0.37, 105.3, 12);
  b.push(); b.translate(0, 109.3, 0); b.cone(0.36, 1.3, 10); b.pop();
  // cold vapour venting from the tanks while it stands fuelled (gone at ignition)
  b.timeless().vanish(0.5, 0.52, MOTION.POP, 0, BY.BUILT);
  const V = [5.3, 27, 0.6, -5.3, 27, -0.4, 0.6, 40, 5.3, 5.3, 64.5, -0.5, -0.4, 64.5, -5.3, 3.5, 75, 0.4, -3.5, 86, 0.3];
  for (let i = 0; i < V.length; i += 3) {
    b.smoke(V[i], V[i + 1], V[i + 2], { count: 9, size: 2.3, rise: 9, density: 0.42, color: [0.76, 0.79, 0.84], src: FLICKER.NONE });
  }
  b.timeless();
}

// the flame (rig 2): origin at the nozzle exit plane, exhaust toward -y
function flame(b) {
  b.timeless().surface(SURF.PLAIN).ao(1);
  b.color(1.0, 0.86, 0.6).emissive(0.6, FLICKER.NONE);
  PR[0] = 1.2; PR[1] = -36; PR[2] = 5.6; PR[3] = -18; PR[4] = 6.6; PR[5] = -6; PR[6] = 6.2; PR[7] = 0;
  b.lathe(PR, 16);
  b.color(1.0, 0.48, 0.15).emissive(0.45, FLICKER.NONE);
  PR[0] = 0.4; PR[1] = -88; PR[2] = 5.4; PR[3] = -62; PR[4] = 8.4; PR[5] = -38; PR[6] = 7.6; PR[7] = -19;
  b.lathe(PR, 16);
  // the hot exhaust glowing on behind the flame: the brightest part of the trail, near the rocket
  b.color(1.0, 0.7, 0.45).emissive(0.06, FLICKER.NONE);
  PR[0] = 0.3; PR[1] = -150; PR[2] = 4.5; PR[3] = -100; PR[4] = 6.6; PR[5] = -55; PR[6] = 5.2; PR[7] = -30;
  b.lathe(PR, 12);
  b.emissive(0, 0);
}

// ---------------------------------------------------------------- pad, launcher, tower
function strut(b, ax, ay, az, bx, by, bz, r) { b.beam(ax, ay, az, bx, by, bz, r, r, 4, false); }

function tower(b) {
  b.timeless().surface(SURF.PLAIN).ao(0.95);
  const x0 = -6, x1 = 6, z0 = LUT_Z - 6, z1 = LUT_Z + 6, NL = 20, dy = (TOP - DECK) / NL;
  col(b, RED, 0.62); b.box(0, (DECK + TOP) / 2, LUT_Z, 3.2, (TOP - DECK) / 2, 3.2); // core and lifts
  col(b, RED);
  for (const cx of [x0, x1]) for (const cz of [z0, z1]) b.box(cx, (DECK + TOP) / 2, cz, 0.55, (TOP - DECK) / 2, 0.55);
  const CX = [x0, x1, x1, x0], CZ = [z0, z0, z1, z1];
  for (let l = 0; l <= NL; l++) {
    const y = DECK + l * dy;
    for (let f = 0; f < 4; f++) {
      const ax = CX[f], az = CZ[f], bx = CX[(f + 1) & 3], bz = CZ[(f + 1) & 3];
      strut(b, ax, y, az, bx, y, bz, 0.28);
      if (l < NL) { strut(b, ax, y, az, bx, y + dy, bz, 0.17); strut(b, bx, y, bz, ax, y + dy, az, 0.17); }
    }
    if (l % 4 === 0) { col(b, RED, 0.8); b.box(0, y + 0.3, LUT_Z, 6.2, 0.3, 6.2); col(b, RED); }
  }
  // hammerhead crane and the lightning mast
  b.box(0, TOP + 1.6, LUT_Z + 4, 1.3, 1.3, 12.5);
  b.box(0, TOP + 4, LUT_Z - 5, 2.2, 1.6, 2.4);
  b.color(0.36, 0.35, 0.33); b.beam(0, TOP + 5.5, LUT_Z - 5, 0, TOP + 24, LUT_Z - 5, 0.45, 0.12, 6);
  // swing arms: in at built 0, swung back against the tower at ignition
  const ARM = [30, 44, 56, 68, 76, 87, 97, 101];
  for (let i = 0; i < ARM.length; i++) {
    const y = RY + ARM[i], rr = ARM[i] < 66 ? 5.05 : ARM[i] < 88 ? 3.3 : 2.2, hx = i & 1 ? 4.5 : -4.5;
    const end = -rr - 0.5, crew = i === ARM.length - 1;
    col(b, RED, 0.9);
    b.timeless().vanish(0.5, 0.52, MOTION.POP, 0, BY.BUILT);
    b.beam(hx * 0.5, y, LUT_Z + 6, 0, y, end - (crew ? 2.4 : 0), 1.25, 1.1, 4);
    if (crew) { col(b, WHITE, 0.9); b.box(0, y, end - 1.2, 1.4, 1.4, 1.3); col(b, RED, 0.9); }
    b.timeless().appear(0.5, 0.52, MOTION.POP, 0, BY.BUILT);
    b.beam(hx, y, LUT_Z + 7, hx - Math.sign(hx) * 11.5, y, LUT_Z + 8.5, 1.25, 1.1, 4);
  }
  b.timeless();
}

function launcher(b, seed) {
  b.timeless().surface(SURF.PLAIN);
  // hardstand: an octagonal raised mound, grass-grey slopes, concrete top that scorches
  b.push(); b.rotateY(PI / 8);
  b.color(0.25, 0.27, 0.19).ao(1).surface(SURF.EARTH);
  PR[0] = 124; PR[1] = -1.5; PR[2] = 88; PR[3] = MOUND;
  b.lathe(PR.subarray(0, 4), 8, { caps: false });
  b.surface(SURF.PLAIN).vanish(0.0, 0.18, MOTION.MORPH, 0, BY.DECAY);
  b.disc(88, 8, 4, (x, z) => {
    const r = Math.min(1, Math.hypot(x, z) / 88), k = 0.92 + 0.08 * r;
    b.color(0.42 * k, 0.41 * k, 0.38 * k).morph(MOUND + 0.03, MOUND + 0.03, 0.05 + 0.1 * r, 0.045 + 0.08 * r, 0.04 + 0.06 * r);
    return MOUND + 0.03;
  });
  b.pop();
  // flame trench: a dark slot along z with its mouths in the slopes
  b.timeless().color(0.04, 0.035, 0.03).ao(0.5);
  b.box(0, MOUND + 0.05, 0, 8.5, 0.04, 81);
  for (const sd of [-1, 1]) {
    const ny = 33.3 / 35.8, nz = 13 / 35.8 * sd, o = 0.08;
    const a = b.vertex(-8.5, MOUND + ny * o, sd * 81.3 + nz * o, 0, ny, nz), c = b.vertex(8.5, MOUND + ny * o, sd * 81.3 + nz * o, 0, ny, nz);
    const d = b.vertex(8.5, -1.5 + ny * o, sd * 114.6 + nz * o, 0, ny, nz), e = b.vertex(-8.5, -1.5 + ny * o, sd * 114.6 + nz * o, 0, ny, nz);
    b.quad(a, c, d, e);
  }
  // pedestals, the mobile launcher, hold-down arms, tail service masts
  b.ao(0.9);
  b.color(0.34, 0.34, 0.33);
  for (const px of [-14, 14]) for (const pz of [-25, -9, 7]) b.box(px, (MOUND + 17) / 2, pz, 2.4, (17 - MOUND) / 2, 2.4);
  b.color(0.3, 0.31, 0.32).ao(1);
  b.box(0, (17 + DECK) / 2, -9, 20.5, (DECK - 17) / 2, 22);
  b.color(0.22, 0.23, 0.24); b.box(0, DECK + 0.05, -9, 20.6, 0.05, 22.1, false); // deck plating
  b.color(0.03, 0.03, 0.03); b.box(0, DECK + 0.12, 0, 7, 0.04, 7, false); // exhaust hole
  b.color(0.36, 0.36, 0.36);
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + k * PI / 2;
    b.push(); b.at(Math.cos(a) * 7.2, DECK, Math.sin(a) * 7.2, PI / 2 - a); b.block(1.1, 1.6, 0.7, 1.2, 2.6); b.pop();
  }
  col(b, RED, 0.8);
  for (const [mx, mz] of [[-9.5, 4], [9.5, 4], [0, 10.5]]) { b.box(mx, DECK + 5, mz, 1.2, 5, 1.2); b.box(mx * 0.85, DECK + 9.6, mz * 0.85, 0.5, 0.4, 0.5); }
  // LOX and LH2 spheres at the edge of the pad, on legs
  for (const [sx, sz, r] of [[-96, 128, 11], [112, 118, 12]]) {
    b.color(0.56, 0.56, 0.54).ao(1);
    b.push(); b.translate(sx, r + 4, sz); b.ellipsoid(r, r, r, 4); b.pop();
    b.color(0.3, 0.3, 0.3);
    for (let k = 0; k < 8; k++) { const a = k * PI / 4; b.beam(sx + Math.cos(a) * r * 0.85, 0, sz + Math.sin(a) * r * 0.85, sx + Math.cos(a) * r * 0.8, r + 2, sz + Math.sin(a) * r * 0.8, 0.4, 0.4, 4); }
  }
  // floodlight towers (heads glow; rig 6 adds the glare)
  for (const [fx, fz] of FLOODS) {
    b.color(0.3, 0.3, 0.3).ao(1);
    b.beam(fx, -0.5, fz, fx, 38, fz, 0.9, 0.5, 6);
    b.box(fx, 38.6, fz, 2.6, 0.5, 0.6);
    const dx = -fx, dz = -fz, l = Math.hypot(dx, dz);
    b.color(0.85, 0.9, 1.0).emissive(0.55, FLICKER.NONE);
    b.box(fx + dx / l * 0.7, 39.6, fz + dz / l * 0.7, 2.2, 0.55, 0.55);
    b.emissive(0, 0);
  }
}
const FLOODS = [[-150, 70], [-135, -95], [95, 155], [165, -20], [60, -175]];

// crawlerway, assembly building, marsh water
function grounds(b, seed) {
  b.timeless();
  const c = Math.SQRT1_2;
  b.push(); b.at(c * 193, 0, -c * 193, 3 * PI / 4);
  // two gravel lanes and the ramp up the mound
  b.surface(SURF.EARTH).ao(1).color(0.5, 0.47, 0.41);
  for (const lx of [-13.5, 13.5]) b.box(lx, 0.04, 0, 6, 0.04, 80, false);
  b.pop();
  b.push(); b.rotateY(PI / 4); // +x now points along the crawlerway (toward +x, -z)
  b.color(0.46, 0.44, 0.4);
  b.hexa([84, MOUND - 0.2, -24, 160, 0.02, -24, 160, 0.02, 24, 84, MOUND - 0.2, 24, 84, MOUND + 0.02, -24, 160, 0.06, -24, 160, 0.06, 24, 84, MOUND + 0.02, 24], false);
  b.pop();
  // the Vertical Assembly Building, far down the crawlerway, its doors toward the pad
  b.push(); b.at(c * 300, 0, -c * 300, -PI / 4);
  // 160 m tall and nearly as deep as it is wide: a cliff of grey panels striped with vertical
  // ribs, two high bay doors (a wide lower leaf, a tall narrow slot above) on each long face
  const VZ0 = 26, VD = 56, VH = 160, VW = 56, VC = VZ0 - VD;
  b.surface(SURF.PLASTER).ao(1).color(0.5, 0.5, 0.48);
  b.box(0, VH / 2, VC, VW, VH / 2, VD);
  b.color(0.47, 0.47, 0.46); b.box(VW + 14, 30, -6, 14, 30, 32); // low bay
  b.color(0.3, 0.31, 0.32); b.box(0, VH + 0.6, VC, VW + 0.4, 0.6, VD + 0.4); // roof edge
  for (const fz of [1, -1]) {
    const zf = VC + fz * (VD + 0.25);
    for (let k = -7; k <= 7; k++) { // vertical ribs between and beside the doors
      b.color(k & 1 ? 0.42 : 0.55, k & 1 ? 0.42 : 0.55, k & 1 ? 0.43 : 0.53);
      b.box(k * 7.4, VH / 2, zf, 1.6, VH / 2, 0.25);
    }
    for (const dx of [-26, 26]) {
      b.color(0.22, 0.23, 0.25);
      b.box(dx, 30, zf + fz * 0.3, 13, 30, 0.3); // lower leaf
      b.box(dx, 99, zf + fz * 0.3, 6.5, 40, 0.3); // the tall slot above it
      b.color(0.33, 0.34, 0.36);
      for (let y = 9; y < 138; y += 9.5) b.box(dx, y, zf + fz * 0.65, y < 60 ? 13 : 6.5, 0.35, 0.1); // leaf joints
    }
  }
  for (const fx of [1, -1]) {
    for (let k = -7; k <= 7; k++) { // ribs on the short faces
      b.color(k & 1 ? 0.42 : 0.55, k & 1 ? 0.42 : 0.55, k & 1 ? 0.43 : 0.53);
      b.box(fx * (VW + 0.25), VH / 2, VC + k * 7.4, 0.25, VH / 2, 1.6);
    }
    { // a door on each short face too (the low bay hides the foot of the +x one)
      b.color(0.22, 0.23, 0.25);
      b.box(fx * (VW + 0.55), 30, VC, 0.3, 30, 13); b.box(fx * (VW + 0.55), 99, VC, 0.3, 40, 6.5);
      b.color(0.33, 0.34, 0.36);
      for (let y = 9; y < 138; y += 9.5) b.box(fx * (VW + 0.9), y, VC, 0.1, 0.35, y < 60 ? 13 : 6.5);
    }
  }
  b.color(1.0, 0.72, 0.42).emissive(0.32, FLICKER.NONE);
  for (let k = 0; k < 3; k++) b.box(VW + 14, 12 + k * 14, 26.2, 12, 0.6, 0.2);
  b.emissive(0, 0);
  b.pop();
  // marsh: still water in the flats
  b.surface(SURF.PLAIN).ao(1);
  for (const [mx, mz, a, sx, sz] of MARSH) {
    b.color(0.1, 0.14, 0.17);
    b.push(); b.at(mx, 0, mz, a); b.scale(sx, 1, sz); b.disc(1, 18, 2, () => 0.03); b.pop();
  }
}
const MARSH = [[-235, 165, 0.4, 40, 95], [-300, -130, -0.3, 30, 80], [160, 255, 1.1, 35, 70], [-140, -290, 0.9, 30, 90], [290, 70, 0.2, 28, 60], [-290, 40, 0.1, 18, 45]];

// ---------------------------------------------------------------- the launch
// rig 3: clouds of steam and smoke out of the trench mouths, the pad mass and a rising column.
// Each billow is a flattened, darker body with smaller, whiter lobes heaped on its upper side
// (so the underside reads shaded and the tops sunlit), soft translucent puffs round its edge,
// and the low ones near the pad lit warm by the flame.
const SC = [0, 0, 0];
function clouds(b, seed) {
  b.seed(seed * 7 + 3);
  let n = 0;
  const lump = (x, y, z, R, warm, t0, t1, die) => {
    b.timeless().pivot(x, y, z);
    if (t0 < 0) b.appear(0.5, 0.52, MOTION.POP, 0, BY.BUILT); else b.appear(t0, t1, MOTION.SCALE, 0, BY.DECAY);
    if (die > 0) b.vanish(die, Math.min(1, die + 0.22), MOTION.SCALE, 0, BY.DECAY);
    const e = warm > 0 ? 0.06 * warm : 0, k = 0.93 + 0.12 * b.rand();
    // the body: wider than tall, its shaded underside
    if (warm) b.color(0.56 * k, 0.45 * k, 0.36 * k).emissive(e, FLICKER.NONE); else b.color(0.44 * k, 0.44 * k, 0.45 * k).emissive(0, 0);
    b.push(); b.translate(x, y, z); b.rotateY(b.rand() * 6.28);
    b.rock(R, R * 0.62, R * (0.85 + 0.25 * b.rand()), 3, 0.2, seed * 31 + n++, 0, 0.2);
    // lobes heaped on top and round the shoulders, whiter as they rise
    const m = 3 + (b.rand() * 2.5 | 0);
    for (let q = 0; q < m; q++) {
      const a = q * 6.283 / m + b.rand(), rr = R * (0.35 + 0.3 * b.rand()), r = R * (0.38 + 0.3 * b.rand());
      const up = 0.25 + 0.55 * b.rand(), w = 0.62 + 0.38 * up;
      if (warm) b.color(0.66 * w, 0.54 * w, 0.43 * w).emissive(e * 0.6, FLICKER.NONE); else b.color(0.66 * w, 0.66 * w, 0.65 * w).emissive(0, 0);
      b.push(); b.translate(Math.cos(a) * rr, R * 0.62 * up, Math.sin(a) * rr);
      b.rock(r, r * 0.82, r, 2, 0.25, seed * 37 + n++, 0, 0.2);
      b.pop();
    }
    b.pop();
    // soft edges: translucent puffs drifting off the billow
    SC[0] = warm ? 0.66 : 0.6; SC[1] = warm ? 0.56 : 0.6; SC[2] = warm ? 0.48 : 0.6;
    b.emissive(0, 0);
    b.smoke(x, y + R * 0.2, z, { count: 2, size: R * 0.95, rise: Math.min(60, R * 0.6), density: 0.3, color: SC, src: FLICKER.NONE, phase: b.rand() });
  };
  b.surface(SURF.PLAIN).ao(1);
  for (const sd of [-1, 1]) {
    for (let k = 0; k < 13; k++) {
      const t = k / 12, R = 11 + 26 * t * (0.75 + 0.5 * b.rand()), z = sd * (70 + 250 * t + 10 * (b.rand() - 0.5)), x = (b.rand() - 0.5) * 34 * t;
      const y = R * 0.35 + 1 + 14 * t * t;
      lump(x, y, z, R, k < 6 ? 1 - k / 6 : 0, k < 3 ? -1 : 0.004 + 0.05 * t, 0.03 + 0.09 * t, k % 3 === 1 ? 0.62 + 0.25 * b.rand() : 0);
      if (k >= 2) lump(x + (b.rand() - 0.5) * R, y + R * (0.6 + 0.3 * b.rand()), z - sd * R * (0.2 + 0.4 * b.rand()), R * (0.55 + 0.3 * b.rand()), k < 5 ? 0.4 : 0, 0.02 + 0.07 * t, 0.07 + 0.1 * t, k % 4 === 0 ? 0.7 : 0);
    }
  }
  for (let k = 0; k < 10; k++) { // the mass round the launcher
    const a = k * PI / 5 + 0.3, rr = 38 + 18 * b.rand();
    lump(Math.cos(a) * rr * 0.8, 8 + 18 * b.rand(), Math.sin(a) * rr, 13 + 8 * b.rand(), 0.8, k < 4 ? -1 : 0.006, 0.05, k & 1 ? 0.7 : 0);
  }
  for (let k = 0; k < 14; k++) { // the column left over the pad: billows widening as they rise
    const y = 44 + 19 * k, o = k * 6, R = 13 + 1.5 * k;
    for (let q = 0; q < (k > 4 ? 2 : 1); q++) {
      const jx = (b.rand() - 0.5) * R * 0.9, jz = (b.rand() - 0.5) * R * 0.9;
      lump(WIND_X * o + jx, y + (b.rand() - 0.5) * 8, WIND_Z * o + jz, R * (0.75 + 0.35 * b.rand()), k < 2 ? 0.5 : 0, 0.02 + 0.02 * k, 0.07 + 0.024 * k, k % 3 === 2 ? 0.68 : 0);
    }
  }
  b.timeless().appear(0.5, 0.52, MOTION.POP, 0, BY.BUILT).emissive(0, 0);
  for (const [x, y, z] of [[0, 22, 150], [0, 30, 270], [0, 22, -150], [0, 30, -270], [0, 46, 30], [0, 46, -40], [0, 90, 10], [0, 150, 30]]) {
    b.smoke(x, y, z, { count: 12, size: 17, rise: 50, density: 0.34, color: [0.62, 0.6, 0.57], src: FLICKER.NONE });
  }
  b.timeless();
}

// rig 4: the exhaust trail along the ascent (1/K scale). Each segment overlaps its neighbours
// and grows from nothing about its middle over 0.1 of decay after the rocket passes, so the
// trail is thin at the rocket (where the glowing plume on rig 2 is) and swells behind it; the
// old, low part is greyer, lumpier and ragged, as a trail dispersing in the wind.
function trail(b) {
  const NS = 60, U0 = 0.035;
  b.surface(SURF.PLAIN).ao(1);
  for (let i = 0; i < NS; i++) {
    const ua = U0 + (1 - U0) * i / NS, ub = U0 + (1 - U0) * (i + 1) / NS, du = ub - ua;
    const age = 1 - i / NS;
    for (let j = 0; j < 3; j++) {
      const u = ua - 0.35 * du + 1.7 * du * j / 2, au = 1 - u; // radius continuous along u: no steps
      traj(u, T3);
      PATH[j * 3] = 0; PATH[j * 3 + 1] = (T3[1] - 6) / K_TRAIL; PATH[j * 3 + 2] = T3[0] / K_TRAIL;
      SCL[j] = (5 + 36 * u) * (1 + (0.1 + 0.22 * au) * Math.sin(u * 140) + 0.12 * au * Math.sin(u * 53 + 1)) / K_TRAIL;
    }
    traj(ua + 0.5 * du, T3);
    b.timeless().pivot(0, (T3[1] - 6) / K_TRAIL, T3[0] / K_TRAIL).appear(ua, ua + 0.1, MOTION.SCALE, 0, BY.DECAY);
    const w = ua < 0.14 ? 1 - ua / 0.14 : 0, gr = 0.06 * age;
    b.color(0.6 + 0.06 * w - gr, 0.58 - 0.03 * w - gr, 0.55 - 0.06 * w - gr * 0.6).emissive(0.022 + 0.03 * w, FLICKER.NONE);
    b.extrude(PATH, RING, { scale: SCL });
  }
  b.timeless().emissive(0, 0);
}

// rig 5: ignition jets out of the trench mouths and the glare
function ignition(b) {
  b.timeless().surface(SURF.PLAIN).ao(1);
  for (const sd of [-1, 1]) {
    b.color(1.0, 0.5, 0.17).emissive(0.8, FLICKER.NONE);
    b.beam(0, 5, sd * 104, 0, 10, sd * 178, 9, 3, 10);
    b.color(1.0, 0.86, 0.6).emissive(1, FLICKER.NONE);
    b.beam(0, 4.5, sd * 102, 0, 6.5, sd * 140, 4.5, 1.6, 8);
    b.flash(0, 7, sd * 118, 22, 26, 1, 0.78, 0.5);
  }
  b.emissive(0, 0);
  b.flash(0, 18, 0, 30, 40, 1, 0.84, 0.6);
}

// ---------------------------------------------------------------- spectators (satellites)
const SHIRTS = [[0.52, 0.52, 0.5], [0.22, 0.3, 0.42], [0.4, 0.33, 0.22], [0.08, 0.08, 0.09], [0.45, 0.2, 0.15], [0.34, 0.38, 0.3]];
function spectators(b, k) {
  b.timeless().surface(SURF.PLAIN).ao(1);
  const m = b.m, tx = m[9], tz = m[11];
  const face = Math.atan2(-(tx * m[0] + tz * m[2]), -(tx * m[6] + tz * m[8])); // toward the pad
  b.push(); b.rotateY(face);
  const n = 7 + ((k * 5) % 4);
  for (let i = 0; i < n; i++) {
    const c = SHIRTS[(i + k * 2) % SHIRTS.length];
    b.color(c[0], c[1], c[2]);
    b.push(); b.at((i - n / 2) * 1.6 + (b.rand() - 0.5) * 0.8, 0, (b.rand() - 0.5) * 3.2, (b.rand() - 0.5) * 0.5);
    b.human(POSE.STAND, 1.62 + 0.2 * b.rand(), k * 31 + i); b.pop();
  }
  // a parked car behind them
  b.color(k & 1 ? 0.42 : 0.16, k & 1 ? 0.1 : 0.27, k & 1 ? 0.07 : 0.3).ao(0.95);
  b.push(); b.at(n * 0.8 + 4, 0, -5, 0.25 + 0.4 * b.rand());
  b.box(0, 0.68, 0, 0.95, 0.38, 2.6); b.color(0.1, 0.11, 0.12); b.box(0, 1.32, -0.2, 0.86, 0.3, 1.3); b.pop();
  b.pop();
}

// ---------------------------------------------------------------- the module
export default {
  id: 'apollo',
  name: 'Apollo 11 launch',
  caption: 'A Saturn V lifts off for the Moon',
  year: 1969,
  radius: RADIUS,
  pad: PAD,
  roadOffset: ROAD_OFF,
  straddlesRoad: false,
  biome: 'coast',
  live: true,
  reach: 13600,
  wind: [WIND_X, WIND_Z],
  approach: 2400, approachFrom: 400, cone: 0.6,
  lights: [
    { pos: [-75, 45, 25], color: [0.8, 0.88, 1.0], intensity: 15000, range: 180, flicker: 0 }, // floodlights
    { pos: [-25, 28, 0], color: [1.0, 0.55, 0.22], intensity: 70000, range: 420, flicker: 0.3 }, // the flame
  ],
  detail: { at: [0, 60, -8], from: [-170, 35, 90] },
  strip: { at: [300, 310, 0], from: [-1200, 35, 0], fov: 0.6 },
  // The event shot: from ~1.2 km behind the launch, looking downrange over the pad, so the
  // rocket, its clouds and the whole arc stay in one frame (animate keeps at / az current).
  witness: {
    get at() { return WAT; },
    get az() { return WAZ[0]; },
    dist: 1800, height: 35, look: 430, fov: 0.6, drift: 0.04, range: 1900,
  },
  satellites: {
    count: [2, 3], near: 3, nearR: [880, 915], farR: [880, 915],
    centre: PI, spread: 0.32, minSep: 70, roadClear: 26,
    build(b, k) { spectators(b, k); },
  },

  build(b, built, decay, seed) {
    b.timeless();
    launcher(b, seed);
    tower(b);
    grounds(b, seed);
    b.lightLive(1, 0.5, 0.52, 0.0, 0.32);
    b.glow(0, 0, 395);
    // scorch where the jets ran out over the ground
    b.timeless().appear(0.0, 0.12, MOTION.FADE, 0, BY.DECAY).surface(SURF.EARTH).ao(1).color(0.06, 0.05, 0.045);
    for (const sd of [-1, 1]) { b.push(); b.at(0, 0, sd * 175, 0); b.scale(34, 1, 70); b.disc(1, 16, 2, () => 0.045); b.pop(); }
    b.timeless();
    b.rig(1, false); rocket(b, seed);
    b.rig(2, false); flame(b);
    b.rig(3, false); clouds(b, seed);
    b.rig(4, false); trail(b);
    b.rig(5, false); ignition(b);
    b.rig(6, false);
    for (const [fx, fz] of FLOODS) { const l = Math.hypot(fx, fz); b.flash(fx - fx / l * 1.4, 39.6, fz - fz / l * 1.4, 0.9, 4, 0.85, 0.9, 1.0); }
    b.rig(7, false); b.flash(0, -9, 0, 7, 9, 1, 0.86, 0.62);
    b.rig(0);
    return b.counts();
  },

  animate(a) {
    const on = a.built > 0.5, D = on ? a.decay : 0;
    const sea = a.seaY > -1000;
    let dx = sea ? a.seaX : 1, dz = sea ? a.seaZ : 0;
    if (dx < 0) { const k = -dx; dx *= 0.35; dz -= 0.9 * k; } // sea behind the road: out ahead, not overhead
    const l = Math.sqrt(dx * dx + dz * dz) || 1; dx /= l; dz /= l;
    const yaw = Math.atan2(dx, dz);
    WAT[0] = dx * 600; WAT[1] = dz * 600; WAZ[0] = Math.atan2(-dz, dx) + 0.42; // a little to the side: the arc reads
    traj(D, T3);
    const g = T3[2], sg = Math.sin(g), cg = Math.cos(g);
    const x = dx * T3[0], y = RY + T3[1], z = dz * T3[0];
    a.set(1, x, y, z, yaw, g);
    const nx = x - dx * sg * 5.6, ny = y - cg * 5.6, nz = z - dz * sg * 5.6;
    const fl = 0.9 + 0.1 * Math.sin(a.t * 29) * Math.sin(a.t * 17.3);
    a.set(2, nx, ny, nz, yaw, g, 0, 1 + 2.6 * ease(seg(D, 0.02, 0.75))).show(2, on).gain(2, fl);
    a.set(7, nx, ny, nz).show(7, on).gain(7, 0.2 + 0.8 * seg(D, 0.3, 0.8));
    const s3 = 0.42 + 0.58 * ease(seg(D, 0, 0.12)) + 0.5 * seg(D, 0.1, 1), dr = 230 * D * D;
    a.set(3, WIND_X * dr, 0, WIND_Z * dr, 0, 0, 0, s3).show(3, on).gain(3, 1 - 0.45 * seg(D, 0.6, 1));
    a.set(4, 0, RY, 0, yaw, 0, 0, K_TRAIL).show(4, on);
    a.show(5, on && D < 0.4).gain(5, (1 - ease(seg(D, 0.012, 0.35))) * (0.85 + 0.15 * Math.sin(a.t * 41)));
    a.gain(6, 0.55);
  },
};
