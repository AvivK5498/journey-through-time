// Landmark: an Ice Age painted cave (~17,000 years ago). A snow-dusted limestone outcrop
// that the road drives straight through: a ~70 m natural passage whose section changes along
// its length (asymmetric, ragged mouths that taper into the passage, a pinch in the middle,
// two wide firelit chambers). Outside: grey bedded limestone with buttresses, crags and
// detached blocks, snow only on ledges, fallen blocks and icicles at the mouths, drifts
// feathered into the ground. Inside it is dark: the light is two hearths (the two point
// lights), one on each wall in opposite halves so that from either road direction one wall
// is firelit and the other carries lamps and a torch-bearing painter. The walls of the dark
// zone carry large painted aurochs, horses and red deer, hand stencils and dot rows at the
// driver's eye height on both walls.
//
// The road keeps daylight out: inside the passage a cave floor (dark trodden earth, 4.5 cm
// above grade, under the 5 cm clearance) covers the road, so it takes only firelight and the
// cave's low ambient. It fades to the frozen-gravel road colour at the mouths.
//
// built: how much exists (0.3: a few figures near each hearth, lamps, a bare snowy entrance;
// 1: dense friezes, two painters, hands and dots at the mouths, soot over the mouths and a
// camp with tents and a bonfire at both mouths).
// decay: unused.
//
// Paintings are geometry, not vertex-colour blur: pigment layers are cut from 2D signed
// distance figures with marching squares (crisp, anti-aliased by MSAA), interiors merged into
// larger quads, outlines as ribbons along the contour, horns/antlers/tails as tapered strokes.

import { SURF, POSE, FLICKER, MOTION, BY, noise3, fbm3 } from './kit.js';

const PI = Math.PI, HP = PI / 2;
const LT = 34; // half passage length (inner mouths at z = +-LT .. LT + 4)
const NPHI = 97; // passage columns around the section
const NPS = 2 * (NPHI - 1) + 1; // outer shell columns (every other one meets a passage column)
const PHI0 = -0.035, PHI1 = PI + 0.035; // slightly past the floor so the foots sink below y = 0
// Hearths: right wall (x > 0) in the -z half, left wall in the +z half. Rotated 180 degrees
// the layout maps onto itself, so both road directions see the same arrangement.
const ZR = -12, ZL = 12;
const CLEAR_X = 6.3, CLEAR_Y = 6.5; // keep the wall outside this near the road
const ROAD_Y = 0.045; // cave floor height over the road (clearance box starts at 0.05)
const PAINT_Z = 27; // the gallery spans |z| < this (the dark zone)
const SOIL = [0.21, 0.2, 0.19]; // ice-age road surface (frozen gravel) the floor fades into

// Scratch (preallocated once).
const GMAX = 32768;
const GP = new Float64Array(3 * GMAX), GN = new Float64Array(3 * GMAX), GS = new Float64Array(3 * GMAX);
const T0 = new Float64Array(3), T1 = new Float64Array(3), T3 = new Float64Array(3);
const N1 = new Float64Array(3), N2 = new Float64Array(3);
const DC = new Float32Array(4 * 16384); // hand stencils: r g b coverage per grid vertex
const DM = new Float32Array(3 * 16384); // hand stencils: ao, emissive, flicker source
const DI = new Int32Array(16384);
const DP = new Float64Array(6 * 16384); // hand stencils: position + normal per grid vertex
const ARC = new Float64Array(2 * 256);
const FP = new Float64Array(2 * 512); // outcrop ground contact points (x, z)
const WX = new Float64Array(2 * 161); // wall foot |x| per side every 0.5 m of z (-40..40)
const M = { r: 0, g: 0, b: 0, ao: 1, e: 0, src: 0, mg: 1, mb: 1 };
const NZT = 93; // passage rows along z
// Passage wall as emitted (decals interpolate it so they sit on it seamlessly).
const TWP = new Float32Array(3 * NPHI * NZT), TWN = new Float32Array(3 * NPHI * NZT), TWC = new Float32Array(8 * NPHI * NZT);
const WS = new Float64Array(14); // wallAt result: pos 3, normal 3, r g b ao e src mg mb
const FIG = new Float64Array(8 * 96); // gallery: side, z, type, L, dir, vc, variant, tier
const SRC = new Float64Array(6 * 32); // baked light sources: x y z strength radius flicker
let nFig = 0, nSrc = 0, nFP = 0;

const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const sn = (x, y, z) => (noise3(x, y, z) - 0.5) * 2;
const frac = (x) => x - Math.floor(x);
// Continuous terrace offset (flat ledges, short risers), zero at integers, no seams.
const terr = (st) => { const f = frac(st); return sstep(0.62, 1, f) - f; };
// Bedding coordinate (warped so the beds are irregular, shared by shape and colour).
const bedAt = (x, y, z) => (y + 2.4 * sn(x * 0.035, 2.0, z * 0.035) + 0.9 * sn(x * 0.11, 4.0, z * 0.11)) / 3.1;

// Local deterministic random (independent of b.rand so built does not reshuffle props).
const RS = new Uint32Array(1);
function rng() {
  let t = (RS[0] = (RS[0] + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------
// Shape functions

// Front/back lip z of the passage at angle phi (end 0: +z, 1: -z), always >= LT.
function lipZ(phi, end) {
  const top = Math.exp(-(((phi - HP) / 0.55) ** 2));
  // the overhang side reaches further out than the other
  const side = Math.cos(phi) * (end ? 1 : -1);
  return LT + 0.6 + 1.6 * sat(side) + 2.6 * noise3(phi * 1.9, end * 7.3, 3.1) + 2.2 * top * noise3(phi * 3.1, end * 3.3, 8.2);
}

// Passage interior surface point at (phi, z) into o.
function inner(phi, z, o) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const az = Math.abs(z), end = z >= 0 ? 0 : 1;
  const fl = sstep(LT - 16, LT + 2, az); // long, gentle mouth flare (no stepped inner arch)
  const fl2 = sstep(LT - 5, LT + 2, az);
  const pin = Math.exp(-(((z - 1) / 5.5) ** 2)); // the pinch between the chambers
  const chR = Math.exp(-(((z - ZR) / 7) ** 2)), chL = Math.exp(-(((z - ZL) / 7) ** 2));
  // asymmetric mouths: taller on one side, a wide low overhang on the other
  const mR = end === 0 ? fl : 0, mL = end === 1 ? fl : 0;
  let Ar = 7.6 + 1.2 * sn(z * 0.055, 1.3, 0.2) + 3.2 * chR + 0.8 * chL - 0.8 * pin - 0.4 * mR + 1.8 * mL;
  let Al = 7.6 + 1.2 * sn(z * 0.055, 2.7, 0.9) + 3.2 * chL + 0.8 * chR - 0.8 * pin - 0.4 * mL + 1.8 * mR;
  let Br = 8.8 + 2.0 * sn(z * 0.05, 3.1, 1.7) + 3.4 * chR + 1.2 * chL - 1.6 * pin + 0.6 * mR - 0.8 * mL;
  let Bl = 8.8 + 2.0 * sn(z * 0.05, 4.4, 2.6) + 3.4 * chL + 1.2 * chR - 1.6 * pin + 0.6 * mL - 0.8 * mR;
  Ar = Math.max(6.9, Ar); Al = Math.max(6.9, Al); Br = Math.max(7.4, Br); Bl = Math.max(7.4, Bl);
  const wt = sstep(-0.3, 0.3, c);
  const A = mix(Al, Ar, wt), B = mix(Bl, Br, wt);
  const N = 2.3 + 0.9 * noise3(z * 0.07, 6.1, 4.2);
  let r = Math.pow(Math.pow(Math.abs(c) / A, N) + Math.pow(Math.abs(s) / B, N), -1 / N);
  const x0 = c * r, y0 = s * r;
  const pp = c >= 0 ? phi : PI - phi; // angle from the floor on this side
  // hearth alcoves low on the chamber walls
  const dz = c >= 0 ? z - ZR : z - ZL;
  r += 1.8 * Math.exp(-dz * dz / 14) * Math.exp(-(((pp - 0.18) / 0.3) ** 2));
  // low-frequency undulation, calm in the painted band, rougher on the vault and foot
  r += 0.7 * sn(x0 * 0.09 + 3, y0 * 0.12, z * 0.085);
  const up = sstep(4.5, 8.0, y0), foot = 1 - sstep(0.3, 1.2, y0);
  const rough = 0.12 + 1.1 * up + 0.45 * foot + 0.9 * fl;
  r += rough * (fbm3(x0 * 0.28, y0 * 0.28, z * 0.28, 3) - 0.5) * 2;
  // a rock passage, not a tube: bedding ledges and mid-scale lumps and hollows, calmer in the
  // painted band at eye height
  const band = sstep(0.9, 1.5, y0) * (1 - sstep(3.4, 4.3, y0));
  r += (1 - 0.75 * band) * (0.55 * terr(bedAt(x0, y0, z) * 1.7) + 0.75 * sn(x0 * 0.21 + 7, y0 * 0.23, z * 0.19));
  r += 0.35 * band * sn(x0 * 0.12 + 2, y0 * 0.1, z * 0.11);
  // sparse hanging folds on the vault (irregular, not rings)
  const fold = sstep(0.62, 0.85, noise3(x0 * 0.09 + 1.3, y0 * 0.05, z * 0.13));
  r -= up * 1.5 * fold;
  // irregular mouth (outward only): broad lobes plus a ragged, jagged rim
  // (mostly sideways: a low, wide, uneven arch rather than a tall keyhole)
  const side = 1 - 0.65 * s * s;
  r += fl * (0.3 + 1.8 * noise3(phi * 2.2 + 1.3, end * 5.1, 9.7)) * side;
  r += fl2 * (1.6 * noise3(phi * 6.5, end * 3.1, 2.2) ** 2 + 0.7 * noise3(phi * 13, end * 1.7, 5.5)) * (0.5 + 0.5 * side);
  let x = c * r, y = s * r;
  if (y < CLEAR_Y && Math.abs(x) < CLEAR_X) x = x < 0 ? -CLEAR_X : CLEAR_X;
  o[0] = x; o[1] = y; o[2] = z;
}
// Inward normal of the passage at (phi, z) into n (forward differences on inner()).
function innerNormal(phi, z, p, n) {
  inner(phi + 0.004, z, N1); inner(phi, z + 0.03, N2);
  const ax = N1[0] - p[0], ay = N1[1] - p[1], az = N1[2] - p[2];
  const bx = N2[0] - p[0], by = N2[1] - p[1], bz = N2[2] - p[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const yc = Math.min(4, Math.max(1, p[1]));
  if (nx * -p[0] + ny * (yc - p[1]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1;
  n[0] = nx / l; n[1] = ny / l; n[2] = nz / l;
}

// The emitted passage wall at (phi, z): the same triangles the GPU draws (quad a, a+1,
// a+W+1, a+W split on the a / a+W+1 diagonal), interpolated into WS.
function wallAt(phi, z) {
  const fi = Math.max(0, Math.min(NPHI - 1.0001, (phi - PHI0) / (PHI1 - PHI0) * (NPHI - 1)));
  const i = fi | 0, s = fi - i;
  const zb = -lipZ(phi, 1), zf = lipZ(phi, 0);
  const fk = Math.max(0, Math.min(NZT - 1.0001, (z - zb) / (zf - zb) * (NZT - 1)));
  const k = fk | 0, t = fk - k;
  const a = k * NPHI + i, c = a + 1, e = a + NPHI + 1, d = a + NPHI;
  let q1, q2, w0, w1, w2;
  if (s >= t) { q1 = c; q2 = e; w0 = 1 - s; w1 = s - t; w2 = t; } else { q1 = e; q2 = d; w0 = 1 - t; w1 = s; w2 = t - s; }
  for (let j = 0; j < 3; j++) {
    WS[j] = TWP[a * 3 + j] * w0 + TWP[q1 * 3 + j] * w1 + TWP[q2 * 3 + j] * w2;
    WS[3 + j] = TWN[a * 3 + j] * w0 + TWN[q1 * 3 + j] * w1 + TWN[q2 * 3 + j] * w2;
  }
  const l = Math.hypot(WS[3], WS[4], WS[5]) || 1;
  WS[3] /= l; WS[4] /= l; WS[5] /= l;
  for (let j = 0; j < 8; j++) WS[6 + j] = TWC[a * 8 + j] * w0 + TWC[q1 * 8 + j] * w1 + TWC[q2 * 8 + j] * w2;
  WS[11] = TWC[a * 8 + 5];
}

// Outer hill (polar around the passage axis) at (phi, z) into o.
function hill(phi, z, o) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const A = 36.5, B = 15, N = 2.6; // lower, squarer outcrop (not a dome)
  let r = Math.pow(Math.pow(Math.abs(c) / A, N) + Math.pow(Math.abs(s) / B, N), -1 / N);
  const zr = z >= 0 ? rimZ(phi, 0) : rimZ(phi, 1);
  const t = Math.abs(z) / zr;
  r *= 1 - 0.5 * t * t * t * (1 - s) - 0.2 * t * t * s;
  r *= 1 + 0.1 * c; // one flank higher and further out: not a symmetric dome
  const x0 = c * r, y0 = s * r;
  // crags: large and medium noise in 3D (continuous across the top)
  r += 8 * sn(x0 * 0.024 + 11, y0 * 0.03, z * 0.024) + 3 * (fbm3(x0 * 0.024 + 11, y0 * 0.03, z * 0.024, 3) - 0.5);
  r += 2.0 * (fbm3(x0 * 0.1, y0 * 0.1, z * 0.1 + 5, 2) - 0.5) * 2;
  // ridges with a rounded (not knife) crest: a kinked ridge folds the 2 m quads into a
  // saw-tooth skyline
  const rq = noise3(x0 * 0.05 + 2, y0 * 0.05, z * 0.05) * 2 - 1, rg = 1 - rq * rq;
  r += 4.5 * rg * rg * rg * s;
  r += 3.5 * Math.exp(-(((phi - 1.05) / 0.35) ** 2)) * Math.exp(-(((z - 6) / 22) ** 2));
  // buttresses on the flanks: irregular vertical ribs
  const bt = 1 - Math.abs(sn(z * 0.075 + (c > 0 ? 0 : 9), 1.7, 0.4 + y0 * 0.02));
  r += 3.4 * bt * bt * bt * bt * (1 - s * s);
  // blocky crags on the skyline
  // (a soft step: a sharp one is sampled into a saw-tooth skyline by the 2 m rows)
  const tw = sstep(0.48, 0.74, noise3(x0 * 0.05 + 3, 0.5, z * 0.05));
  r += 3.4 * tw * s * s;
  // bedding: irregular beds; ledges show only in places
  const st = bedAt(x0, s * r, z);
  const lm = sstep(0.3, 0.6, noise3(x0 * 0.06, 7.7, z * 0.06));
  r += 2.4 * terr(st) * lm * (0.4 + 0.6 * (1 - s));
  // broken ledges: irregular stepped shelves (spacing varies with position) that catch snow
  const lt = (s * r) / (3.2 + 1.6 * noise3(x0 * 0.04 + 1, 2.2, z * 0.04));
  r += 2.2 * terr(lt) * sstep(0.35, 0.6, noise3(x0 * 0.08 + 6, 1.1, z * 0.08)) * (1 - 0.5 * s);
  // vertical joints cut into the flanks
  const jn = noise3((z + x0 * 0.5) * 0.11, 5.5, 1.3 + (c > 0 ? 0 : 7));
  r -= 1.1 * sstep(0.74, 0.9, jn) * (1 - s * 0.7);
  o[0] = c * r; o[1] = s * r; o[2] = z;
}
// Rim z of the hill at angle phi: the sides reach forward to flank the mouth.
function rimZ(phi, end) {
  const s = Math.sin(Math.max(0, Math.min(PI, phi)));
  const r = LT - 2 + 20 * Math.pow(1 - s, 1.6) + 5 * noise3(phi * 1.6, end * 4.1 + 2, 1.7);
  // always ahead of the lip, so the rock over the mouth is a brow, never a recess
  return Math.max(r, lipZ(phi, end) + 3.5);
}

// Shell point (front face, hill, back face) at (phi, q in 0..1) into o.
const QF = 0.24;
function shell(phi, q, o) {
  if (q > QF && q < 1 - QF) {
    const t = (q - QF) / (1 - 2 * QF);
    hill(phi, mix(rimZ(phi, 0), -rimZ(phi, 1), t), o);
    return;
  }
  const end = q <= QF ? 0 : 1;
  const sgn = end ? -1 : 1;
  const s = end ? (1 - q) / QF : q / QF; // 0 at the lip, 1 at the rim
  inner(phi, sgn * lipZ(phi, end), T0);
  hill(phi, sgn * rimZ(phi, end), T3);
  const rL = Math.hypot(T0[0], T0[1]), rR = Math.hypot(T3[0], T3[1]);
  const aL = Math.atan2(T0[1], T0[0]), aR = Math.atan2(T3[1], T3[0]);
  // the lip turns outward fast so the portal reads thick
  // (radius and z must reach the rim together: a face that reaches the hill's radius while
  // still short of the rim pokes out past the hill's crest as a fin per column)
  const e1 = 1 - (1 - s) * (1 - s);
  const r = mix(rL, rR, e1), a = mix(aL, aR, s);
  let z = mix(T0[2], T3[2], Math.pow(s, 1.15));
  let x = Math.cos(a) * r, y = Math.sin(a) * r;
  const w = 2.6 * Math.sqrt(s) * (1 - s);
  // relief across the face (world-space noise: buttresses, bays, bedding ledges), so it reads
  // as a cliff rather than a smooth funnel into the mouth
  const nr = (fbm3(x * 0.1 + 4, y * 0.1, z * 0.1, 3) - 0.5) * 2 * 3.6 * w;
  const nz = (fbm3(x * 0.07, y * 0.09 + 3, z * 0.07, 3) - 0.5) * 2 * 5.0 * w + 1.6 * w * sn(x * 0.16, y * 0.05 + 9, 0.3);
  const st = bedAt(x, y, z);
  const lm = sstep(0.42, 0.66, noise3(x * 0.06, 7.7, z * 0.06));
  x += Math.cos(a) * nr; y += Math.sin(a) * nr; z += sgn * (nz + 1.6 * terr(st) * w * (0.35 + 0.65 * lm));
  y -= 0.3 * sstep(0.8, 0, y); // foot below grade
  o[0] = x; o[1] = y; o[2] = z;
}

// Wall foot |x| at z on a side (table, 0.5 m steps).
function wallFoot(sd, z) {
  const f = Math.max(0, Math.min(159.999, (z + 40) * 2)), i = f | 0, t = f - i, o = sd > 0 ? 0 : 161;
  return mix(WX[o + i], WX[o + i + 1], t);
}

// Cave floor height at (x, z): flat over the road (|x| < 6), a rubbly fillet at the walls.
function floorH(x, z) {
  const ax = Math.abs(x);
  if (ax < 6.0) return ROAD_Y;
  const wx = wallFoot(x > 0 ? 1 : -1, z);
  const ridge = 0.25 + 0.3 * noise3(z * 0.12, x > 0 ? 3 : -3, 1.1);
  const f = sstep(Math.max(6.05, wx - 2.6), wx + 0.4, ax);
  const rub = sstep(6.05, 6.8, ax) * 0.2 * fbm3(x * 0.9, 0, z * 0.9, 2);
  return ROAD_Y + f * (ridge + 0.5 * f) + rub;
}

// Snow drift height above grade at (x, z) (negative = under ground). It feathers out over
// ~10 m with a noisy outline so it melts into the snowfield instead of forming a plate.
function apron(x, z) {
  const ax = Math.abs(x), az = Math.abs(z);
  if (ax < 6.5) return -0.2;
  let d2 = 1e9;
  for (let i = 0; i < nFP; i++) { const dx = FP[i * 2] - x, dz = FP[i * 2 + 1] - z, q = dx * dx + dz * dz; if (q < d2) d2 = q; }
  const d = Math.sqrt(d2);
  const en = noise3(x * 0.07, 3.3, z * 0.07);
  let h = (1.4 + 0.8 * sn(x * 0.09, 3.3, z * 0.09)) * Math.exp(-d / 2.6) + (0.1 + 0.6 * en) * Math.exp(-d / 5.5);
  h += 0.2 * sn(x * 0.4, 1.1, z * 0.4) * Math.exp(-d / 5);
  h *= sstep(6.5, 9.5, ax);
  if (az < LT + 1.5 && ax < 15) h *= sstep(LT - 1, LT + 1.5, az); // not inside the passage
  return h - 0.16 - 0.14 * noise3(x * 0.05 + 5, 1, z * 0.05);
}

// ---------------------------------------------------------------------------------
// Light (baked) and materials

let gBuilt = 1;
function addSrc(x, y, z, s, rad, fl) {
  if (nSrc >= 32) return;
  const o = nSrc++ * 6;
  SRC[o] = x; SRC[o + 1] = y; SRC[o + 2] = z; SRC[o + 3] = s; SRC[o + 4] = rad; SRC[o + 5] = fl;
}
let GSRC = 0;
// Warm light reaching a point (0 .. ~2); sets GSRC to the dominant source's flicker.
function glowAt(x, y, z, nx, ny, nz) {
  let g = 0, best = 0; GSRC = 0;
  for (let i = 0; i < nSrc; i++) {
    const o = i * 6;
    const dx = SRC[o] - x, dy = SRC[o + 1] - y, dz = SRC[o + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) + 1e-6, R = SRC[o + 4];
    const ndl = Math.max(0, (dx * nx + dy * ny + dz * nz) / d);
    const q = 1 + d2 / (R * R);
    const gi = SRC[o + 3] * (0.12 + 0.88 * ndl) / (q * q);
    g += gi;
    if (gi > best) { best = gi; GSRC = SRC[o + 5]; }
  }
  return g;
}
// Applies baked firelight to M (colour already the albedo).
function finishLight(x, y, z, nx, ny, nz, day) {
  const g = glowAt(x, y, z, nx, ny, nz) * (1 - day);
  const k = sat(g * 2.2);
  M.mg = mix(1, 0.7, k); M.mb = mix(1, 0.42, k);
  M.g *= M.mg; M.b *= M.mb;
  M.e = Math.min(0.3, 0.13 * g);
  // hearth glow pulses with its light; lamp/torch glow is steady (OWN flicker is keyed per
  // 2 m cell and would chequer a large wall)
  M.src = M.e > 0.004 && GSRC !== FLICKER.OWN ? GSRC : 0;
}
function dayAt(z) { return Math.exp(-Math.max(0, LT + 1.5 - Math.abs(z)) / 5.5); }

// Passage wall albedo + ao into M. Near the mouths it becomes the outside limestone.
function wallBase(x, y, z, nx, ny, nz) {
  const day = dayAt(z);
  const v = 0.86 + 0.28 * noise3(x * 0.3, y * 0.3, z * 0.3);
  const flow = sstep(0.55, 0.8, noise3(x * 0.6, y * 0.08, z * 0.6)); // calcite flows
  const iron = sstep(0.6, 0.85, noise3(x * 0.2 + 5, y * 0.35, z * 0.2));
  const hearth = Math.exp(-(((z - ZR) / 5) ** 2)) * (x > 0 ? 1 : 0) + Math.exp(-(((z - ZL) / 5) ** 2)) * (x < 0 ? 1 : 0);
  const soot = sstep(5, 9, y) * (0.5 + 0.5 * hearth) + 0.4 * hearth * sstep(2.5, 5, y);
  let r = 0.44 * v, g = 0.39 * v, b = 0.31 * v;
  r = mix(r, 0.52, flow * 0.6); g = mix(g, 0.49, flow * 0.6); b = mix(b, 0.43, flow * 0.6);
  r = mix(r, 0.36, iron * 0.4); g = mix(g, 0.24, iron * 0.4); b = mix(b, 0.15, iron * 0.4);
  const sk = 1 - 0.75 * sat(soot);
  r *= sk; g *= sk; b *= sk;
  const ao = 0.015 + 0.98 * Math.pow(day, 1.2) * (1 - 0.4 * sat(soot));
  if (day > 0.02) { // the outside rock carries on into the mouth
    rockMat(x, y, z, ny, sstep(0.4, 0.9, day), 0.05);
    const k = sstep(0.05, 0.6, day);
    // the lip's crags face inward and down, so they take little sky: lift them toward the
    // outcrop's lit tone so the mouth and the cliff read as one rock mass
    const lift = 1 + 0.55 * sstep(0.45, 1, day);
    r = mix(r, M.r * lift, k); g = mix(g, M.g * lift, k); b = mix(b, M.b * lift * 1.04, k);
  }
  M.r = r; M.g = g; M.b = b; M.ao = ao;
  return day;
}
function wallMat(x, y, z, nx, ny, nz) {
  const day = wallBase(x, y, z, nx, ny, nz);
  finishLight(x, y, z, nx, ny, nz, day);
}
function applyM(b) { b.color(M.r, M.g, M.b).ao(M.ao).emissive(M.e, M.src); }

// Outside limestone: grey bedded rock, darker partings and joints, lichen and ochre stains,
// snow only on near-flat, up-facing ledges (patchy). sny: smoothed normal y; bias raises the
// snow threshold.
function rockMat(x, y, z, sny, snowK, bias) {
  // stylised banded limestone: each bed one of three tones (calm, readable at any range),
  // thin dark partings between beds, a few soft joints, a faint warm stain; no fine mottling
  const st = bedAt(x, y, z);
  const fs = frac(st), bi = Math.floor(st);
  const hb = noise3(0.5, bi * 1.37, 2.5);
  const tone = hb < 0.36 ? 0.84 : hb < 0.68 ? 1.0 : 1.13;
  const v = 0.95 + 0.1 * noise3(x * 0.035, y * 0.035, z * 0.035);
  const parting = sstep(0.045, 0.0, Math.min(fs, 1 - fs));
  const joint = sstep(0.8, 0.9, noise3((z + x * 0.5) * 0.09, 5.5, 1.3 + (x > 0 ? 0 : 7)));
  const stain = sstep(0.6, 0.85, noise3(x * 0.04 + 9, y * 0.06, z * 0.04));
  let r = 0.335 * tone * v, g = 0.33 * tone * v, b = 0.325 * tone * v;
  r = mix(r, 0.37 * tone, stain * 0.25); g = mix(g, 0.33 * tone, stain * 0.25); b = mix(b, 0.28 * tone, stain * 0.25);
  const dk = 1 - 0.3 * parting - 0.22 * joint;
  r *= dk; g *= dk; b *= dk;
  const ledge = sstep(0.6, 0.95, fs);
  const sl = sny + 0.12 * ledge + 0.25 * (noise3(x * 0.25, y * 0.25, z * 0.25) - 0.5) - 0.3 * joint;
  const patch = sstep(0.38, 0.66, noise3(x * 0.06 + 2, y * 0.06, z * 0.06));
  const sn2 = sstep(0.7 + bias, 1.0 + bias, sl) * (0.15 + 0.85 * patch) * snowK;
  M.r = mix(r, 0.78, sn2); M.g = mix(g, 0.82, sn2); M.b = mix(b, 0.88, sn2);
  M.ao = (0.5 + 0.5 * sstep(-0.2, 3, y)) * (1 - 0.3 * joint * (1 - sn2));
  M.e = 0; M.src = 0;
}

// Outcrop shell (SURF.ROCK): only the smooth base tone and ao per vertex; the beds, partings,
// joints, stains and snow are drawn per fragment in landmark space by the kit, so the shell's
// fan-shaped grid round the mouth cannot smear them into streaks. snowK 0..1.
function rockBase(x, y, z, snowK) {
  const v = 0.95 + 0.1 * noise3(x * 0.035, y * 0.035, z * 0.035);
  M.r = 0.335 * v; M.g = 0.33 * v; M.b = 0.325 * v;
  M.ao = 0.5 + 0.5 * sstep(-0.2, 3, y);
  M.e = 0; M.src = Math.round(sat(snowK) * 255);
}

// ---------------------------------------------------------------------------------
// Grid helpers (positions in GP, normals in GN, smoothed normals in GS; W columns x H rows)

// Emits a grid (vertices, then quads); yields every few rows.
function* emitGrid(b, W, H, matFn, rec) {
  const base = b.nv;
  for (let q = 0; q < W * H; q++) {
    const o = q * 3;
    matFn(GP[o], GP[o + 1], GP[o + 2], GN[o], GN[o + 1], GN[o + 2], q);
    applyM(b);
    if (rec) {
      for (let j = 0; j < 3; j++) { TWP[o + j] = GP[o + j]; TWN[o + j] = GN[o + j]; }
      const c = q * 8;
      TWC[c] = M.r; TWC[c + 1] = M.g; TWC[c + 2] = M.b; TWC[c + 3] = M.ao; TWC[c + 4] = M.e; TWC[c + 5] = M.src; TWC[c + 6] = M.mg; TWC[c + 7] = M.mb;
    }
    b.vertex(GP[o], GP[o + 1], GP[o + 2], GN[o], GN[o + 1], GN[o + 2]);
    if (q % (W * 40) === W * 40 - 1) yield;
  }
  if (b.nv - base !== W * H) return;
  for (let k = 0; k < H - 1; k++) for (let i = 0; i < W - 1; i++) { const a = base + k * W + i; b.quad(a, a + 1, a + W + 1, a + W); }
}
function gridNormals(W, H, sign) {
  for (let k = 0; k < H; k++) for (let i = 0; i < W; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(W - 1, i + 1), k0 = Math.max(0, k - 1), k1 = Math.min(H - 1, k + 1);
    const a = (k * W + i1) * 3, a0 = (k * W + i0) * 3, c = (k1 * W + i) * 3, c0 = (k0 * W + i) * 3;
    const ux = GP[a] - GP[a0], uy = GP[a + 1] - GP[a0 + 1], uz = GP[a + 2] - GP[a0 + 2];
    const vx = GP[c] - GP[c0], vy = GP[c + 1] - GP[c0 + 1], vz = GP[c + 2] - GP[c0 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = (Math.hypot(nx, ny, nz) || 1) * sign;
    const o = (k * W + i) * 3;
    GN[o] = nx / l; GN[o + 1] = ny / l; GN[o + 2] = nz / l;
  }
}
// GS = GN blurred (passes of a 3x3 box), renormalised.
function smoothNormals(W, H, passes) {
  GS.set(GN.subarray(0, W * H * 3));
  for (let p = 0; p < passes; p++) { // in place: row blur then column blur
    for (let k = 0; k < H; k++) {
      let px = GS[(k * W) * 3], py = GS[(k * W) * 3 + 1], pz = GS[(k * W) * 3 + 2];
      for (let i = 0; i < W; i++) {
        const o = (k * W + i) * 3, n = (k * W + Math.min(W - 1, i + 1)) * 3;
        const cx = GS[o], cy = GS[o + 1], cz = GS[o + 2];
        GS[o] = (px + cx + GS[n]) / 3; GS[o + 1] = (py + cy + GS[n + 1]) / 3; GS[o + 2] = (pz + cz + GS[n + 2]) / 3;
        px = cx; py = cy; pz = cz;
      }
    }
    for (let i = 0; i < W; i++) {
      let px = GS[i * 3], py = GS[i * 3 + 1], pz = GS[i * 3 + 2];
      for (let k = 0; k < H; k++) {
        const o = (k * W + i) * 3, n = (Math.min(H - 1, k + 1) * W + i) * 3;
        const cx = GS[o], cy = GS[o + 1], cz = GS[o + 2];
        GS[o] = (px + cx + GS[n]) / 3; GS[o + 1] = (py + cy + GS[n + 1]) / 3; GS[o + 2] = (pz + cz + GS[n + 2]) / 3;
        px = cx; py = cy; pz = cz;
      }
    }
  }
  for (let q = 0; q < W * H; q++) {
    const o = q * 3, l = Math.hypot(GS[o], GS[o + 1], GS[o + 2]) || 1;
    GS[o] /= l; GS[o + 1] /= l; GS[o + 2] /= l;
  }
}

// ---------------------------------------------------------------------------------
// Paintings: 2D figures from tapered capsules (figure units: length ~1, facing +u)

function caps(list) { return new Float64Array(list); }
function poly(pts, r0, r1) {
  const out = [], n = pts.length / 2 - 1;
  for (let i = 0; i < n; i++) out.push(pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], mix(r0, r1, i / n), mix(r0, r1, (i + 1) / n));
  return out;
}
function capD(px, py, C, o) {
  const ax = C[o], ay = C[o + 1], dx = C[o + 2] - ax, dy = C[o + 3] - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = px - ax - dx * t, qy = py - ay - dy * t;
  return Math.sqrt(qx * qx + qy * qy) - (C[o + 4] + (C[o + 5] - C[o + 4]) * t);
}
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function sdf(C, px, py, k) {
  let d = 1e9;
  for (let o = 0; o < C.length; o += 6) d = k > 0 ? smin(d, capD(px, py, C, o), k) : Math.min(d, capD(px, py, C, o));
  return d;
}

const BLACK = [0.042, 0.035, 0.03], RED = [0.3, 0.055, 0.025], YEL = [0.44, 0.26, 0.055], BROWN = [0.26, 0.085, 0.035];
const PALE = [0.5, 0.36, 0.15], ROSE = [0.36, 0.13, 0.06];

// Aurochs: heavy shoulder hump, dipping back, deep chest, low head, forward-curving lyre horns.
const AUROCHS = {
  body: caps([
    -0.28, 0.02, 0.08, 0.04, 0.15, 0.165, // barrel
    0.05, 0.11, 0.20, 0.10, 0.16, 0.14, // shoulder hump
    0.14, -0.03, 0.26, -0.06, 0.14, 0.11, // chest
    -0.33, 0.05, -0.33, 0.05, 0.125, 0.125, // rump
    -0.12, -0.06, 0.06, -0.07, 0.10, 0.11, // belly
    0.24, 0.06, 0.37, -0.01, 0.10, 0.075, // neck
    0.37, -0.01, 0.50, -0.10, 0.07, 0.045, // head
    0.19, -0.12, 0.21, -0.355, 0.05, 0.032, // forelegs
    0.09, -0.12, 0.07, -0.345, 0.048, 0.03,
    -0.30, -0.04, -0.35, -0.20, 0.075, 0.045, // hind legs
    -0.35, -0.20, -0.30, -0.355, 0.036, 0.028,
    -0.20, -0.07, -0.23, -0.21, 0.055, 0.038,
    -0.23, -0.21, -0.19, -0.345, 0.032, 0.026,
  ]),
  dark: caps([ // black forequarter, head and lower legs
    0.10, 0.12, 0.22, 0.10, 0.14, 0.13,
    0.17, -0.01, 0.27, -0.05, 0.12, 0.10,
    0.24, 0.06, 0.37, -0.01, 0.095, 0.07,
    0.37, -0.01, 0.50, -0.10, 0.07, 0.045,
    0.20, -0.25, 0.21, -0.36, 0.036, 0.033,
    0.08, -0.24, 0.07, -0.35, 0.034, 0.031,
    -0.33, -0.27, -0.30, -0.36, 0.031, 0.029,
    -0.215, -0.27, -0.19, -0.35, 0.029, 0.027,
  ]),
  strokes: caps([
    ...poly([0.41, 0.035, 0.40, 0.095, 0.425, 0.15, 0.47, 0.18, 0.51, 0.19], 0.03, 0.011), // near horn
    ...poly([0.445, 0.03, 0.46, 0.08, 0.495, 0.12, 0.54, 0.13, 0.575, 0.115], 0.025, 0.009), // far horn
    ...poly([-0.44, 0.11, -0.475, 0.0, -0.47, -0.19], 0.014, 0.011), // tail
    -0.47, -0.185, -0.465, -0.215, 0.02, 0.026, // tuft
  ]),
  bbox: [-0.56, -0.42, 0.66, 0.31], outlineW: 0.026, k: 0.05,
};
const HORSE = {
  body: caps([
    -0.22, 0.02, 0.12, 0.03, 0.13, 0.12,
    -0.05, -0.03, -0.05, -0.03, 0.14, 0.14,
    -0.26, 0.05, -0.26, 0.05, 0.11, 0.11,
    0.15, 0.0, 0.15, 0.0, 0.1, 0.1,
    0.15, 0.06, 0.27, 0.17, 0.095, 0.065,
    0.28, 0.18, 0.38, 0.09, 0.062, 0.042,
    0.13, -0.06, 0.15, -0.33, 0.042, 0.027,
    0.07, -0.06, 0.05, -0.32, 0.04, 0.026,
    -0.24, -0.02, -0.27, -0.16, 0.062, 0.042,
    -0.27, -0.16, -0.22, -0.33, 0.032, 0.026,
    -0.17, -0.04, -0.19, -0.17, 0.047, 0.036,
    -0.19, -0.17, -0.15, -0.32, 0.03, 0.025,
  ]),
  dark: caps([ // muzzle and lower legs
    0.32, 0.14, 0.38, 0.09, 0.05, 0.042,
    0.14, -0.2, 0.15, -0.33, 0.034, 0.028,
    0.06, -0.2, 0.05, -0.32, 0.033, 0.027,
    -0.25, -0.23, -0.22, -0.33, 0.03, 0.027,
    -0.17, -0.22, -0.15, -0.32, 0.029, 0.026,
  ]),
  strokes: caps([
    ...poly([0.06, 0.13, 0.12, 0.2, 0.2, 0.25, 0.27, 0.27], 0.045, 0.028), // mane
    ...poly([-0.35, 0.06, -0.42, -0.03, -0.43, -0.17], 0.036, 0.02), // tail
  ]),
  bbox: [-0.5, -0.38, 0.45, 0.33], outlineW: 0.024, k: 0.06,
};
const STAG = {
  body: caps([
    -0.20, 0.02, 0.12, 0.04, 0.10, 0.11,
    -0.22, 0.04, -0.22, 0.04, 0.095, 0.095,
    0.13, 0.0, 0.13, 0.0, 0.085, 0.085,
    0.13, 0.07, 0.24, 0.20, 0.07, 0.05,
    0.24, 0.21, 0.35, 0.15, 0.045, 0.026,
    0.12, -0.06, 0.14, -0.38, 0.032, 0.022,
    0.06, -0.06, 0.03, -0.37, 0.03, 0.021,
    -0.20, -0.02, -0.24, -0.18, 0.05, 0.032,
    -0.24, -0.18, -0.20, -0.38, 0.024, 0.021,
    -0.13, -0.04, -0.16, -0.19, 0.042, 0.028,
    -0.16, -0.19, -0.12, -0.37, 0.023, 0.02,
    -0.29, 0.08, -0.29, 0.08, 0.028, 0.028,
  ]),
  dark: caps([0.31, 0.165, 0.35, 0.15, 0.032, 0.026]),
  strokes: caps([
    ...poly([0.23, 0.24, 0.20, 0.36, 0.12, 0.46, 0.06, 0.56, 0.02, 0.63], 0.022, 0.011),
    ...poly([0.22, 0.30, 0.29, 0.34], 0.016, 0.008),
    ...poly([0.17, 0.41, 0.25, 0.46], 0.015, 0.008),
    ...poly([0.10, 0.49, 0.17, 0.56], 0.014, 0.007),
    ...poly([0.04, 0.59, 0.08, 0.67], 0.012, 0.006),
    ...poly([0.04, 0.59, -0.04, 0.66], 0.012, 0.006),
    ...poly([0.20, 0.24, 0.15, 0.35, 0.07, 0.44, 0.0, 0.53, -0.05, 0.59], 0.02, 0.01),
    ...poly([0.15, 0.35, 0.21, 0.40], 0.014, 0.007),
    ...poly([0.07, 0.44, 0.12, 0.51], 0.013, 0.006),
  ]),
  bbox: [-0.38, -0.43, 0.43, 0.71], outlineW: 0.022, k: 0.04,
};
// Hand (metres, palm centre at origin, fingers up).
const HAND = caps([
  0, -0.02, 0, 0.035, 0.045, 0.043,
  -0.033, 0.055, -0.05, 0.125, 0.011, 0.01,
  -0.011, 0.065, -0.014, 0.15, 0.012, 0.011,
  0.012, 0.065, 0.016, 0.145, 0.012, 0.011,
  0.032, 0.055, 0.048, 0.115, 0.011, 0.01,
  0.04, -0.005, 0.085, 0.045, 0.014, 0.012,
  0, -0.06, 0, -0.02, 0.032, 0.04,
]);

const A = 0, H = 1, S = 2, HANDS = 3, DOTS = 4;

// Builds the gallery layout (FIG) for both walls: figures at eye height with space between
// them, interleaved with hand-stencil panels and dot rows. tier decides when a figure exists;
// the figure nearest each hearth zone (|z| ~ 12) on each wall and half is always there.
function planGallery(seed) {
  RS[0] = (Math.imul(seed ^ 0x2f6b, 0x9e3779b1) >>> 0) || 7;
  nFig = 0;
  const put = (side, z, type, L, dir, vc, variant, tier) => {
    if (nFig >= 92) return -1;
    const o = nFig * 8;
    FIG[o] = side; FIG[o + 1] = z; FIG[o + 2] = type; FIG[o + 3] = L; FIG[o + 4] = dir; FIG[o + 5] = vc; FIG[o + 6] = variant; FIG[o + 7] = tier;
    return nFig++;
  };
  for (let sd = 1; sd >= -1; sd -= 2) {
    let z = PAINT_Z - (sd < 0 ? 1.3 : 0), k = 0;
    const best = [-1, -1], bestD = [1e9, 1e9];
    while (z > -PAINT_Z + 1.5) {
      const near = sat(Math.abs(Math.abs(z) - 12) / 16);
      const tier = sat(0.12 + 0.58 * rng() + 0.3 * near);
      if (k % 6 === 2) {
        put(sd, z - 1.0, HANDS, 1, 0, 1.75 + 0.25 * rng(), k & 1, tier);
        z -= 2.0 + 0.8 * rng();
      } else {
        const r = rng();
        const type = r < 0.42 ? A : r < 0.76 ? H : S;
        const L = type === A ? 3.1 + 0.5 * rng() : type === H ? 2.7 + 0.4 * rng() : 2.4 + 0.4 * rng();
        const F = type === A ? AUROCHS : type === H ? HORSE : STAG;
        const dir = rng() < 0.6 ? -1 : 1;
        // u maps to z = zc + u * dir: place the figure's +z edge at z
        const hiU = Math.max(dir * F.bbox[0], dir * F.bbox[2]) * L, loU = Math.min(dir * F.bbox[0], dir * F.bbox[2]) * L;
        const zc = z - hiU;
        if (zc + loU < -PAINT_Z) break;
        // hooves at ~1.2-1.4 m, clear of the floor fillet at the wall foot; higher beside the
        // own hearth, where the alcove hollows the lower wall
        const hz = sd > 0 ? ZR : ZL, al = Math.exp(-(((zc + (dir * (F.bbox[0] + F.bbox[2]) * 0.5 * L) - hz) / 5.5) ** 2));
        const vc = 1.25 + 0.55 * al - F.bbox[1] * L + 0.15 * rng();
        const i = put(sd, zc, type, L, dir, vc, rng() < 0.5 ? 0 : 1, tier);
        const h = zc < 0 ? 1 : 0, dd = Math.abs(Math.abs(zc) - 12);
        if (i >= 0 && dd < bestD[h]) { bestD[h] = dd; best[h] = i; }
        if (rng() < 0.22) put(sd, zc, DOTS, 1, 0, vc + F.bbox[3] * L + 0.35, rng() < 0.5 ? 0 : 1, sat(tier + 0.1));
        z = zc + loU - 0.9 - 0.7 * rng();
      }
      k++;
    }
    for (let h = 0; h < 2; h++) if (best[h] >= 0) FIG[best[h] * 8 + 7] = 0;
  }
  // hands and dots on the mouth rock, outside the dark zone (signal a full gallery)
  for (let end = 0; end < 2; end++) {
    const sg = end ? -1 : 1;
    put(1, sg * (LT - 1.6), HANDS, 1, 0, 1.9, end, 0.75);
    put(-1, sg * (LT - 1.4), HANDS, 1, 0, 2.0, 1 - end, 0.75);
    put(-sg, sg * (LT - 4.6), DOTS, 1, 0, 2.6, 0, 0.75);
  }
}

// --- mapping of a figure's (u, v) plane onto the wall: corner grid PP/PW, bilinear sample
const PMAX = 6000;
const PP = new Float64Array(6 * PMAX); // corner wall position + normal
const PW = new Float32Array(8 * PMAX); // corner wall albedo (untinted) r g b, ao, e, src, mg, mb
const PF = new Float32Array(PMAX), PK = new Float32Array(PMAX); // fill / black-mass SDF (m)
const VI = new Int32Array(PMAX), EHI = new Int32Array(PMAX), EVI = new Int32Array(PMAX);
const BC = new Uint8Array(PMAX); // cell covered by a merged interior block
const POLY = new Int32Array(12), CUT = new Float64Array(16), QC = new Int32Array(4);
const PV = new Float64Array(14); // sample: pos 3, nrm 3, r g b ao e src mg mb
const FC = new Float64Array(6); // current figure fill colour, belly colour
const LC = new Float64Array(3); // current figure line colour
let gW = 0, gH = 0, gU0 = 0, gV0 = 0, gCell = 0.1, gL = 1, gSk = 0, gF = null;

function mapFigure(side, zc, vc, dir, u0, v0, u1, v1, cell) {
  // arc length table up the wall at zc (pp: angle from the floor on this side)
  let acc = 0;
  for (let k = 0; k < 256; k++) {
    const pp = k * (1.35 / 255), ph = side > 0 ? pp : PI - pp;
    inner(ph, zc, T0);
    if (k > 0) acc += Math.hypot(T0[0] - T1[0], T0[1] - T1[1]);
    T1[0] = T0[0]; T1[1] = T0[1];
    ARC[k * 2] = acc; ARC[k * 2 + 1] = pp;
  }
  let sc = 0;
  for (let k = 0; k < 256; k++) { const ph = side > 0 ? ARC[k * 2 + 1] : PI - ARC[k * 2 + 1]; inner(ph, zc, T0); if (T0[1] >= vc) { sc = ARC[k * 2]; break; } }
  const W = Math.ceil((u1 - u0) / cell) + 1, Hh = Math.ceil((v1 - v0) / cell) + 1;
  if (W * Hh > PMAX) return false;
  gW = W; gH = Hh; gU0 = u0; gV0 = v0; gCell = cell;
  let ai = 0;
  for (let j = 0; j < Hh; j++) {
    const sa = sc + v0 + j * cell;
    while (ai > 0 && ARC[ai * 2] > sa) ai--;
    while (ai < 254 && ARC[ai * 2 + 2] < sa) ai++;
    const t = sat((sa - ARC[ai * 2]) / Math.max(1e-6, ARC[ai * 2 + 2] - ARC[ai * 2]));
    const pp = mix(ARC[ai * 2 + 1], ARC[ai * 2 + 3], t);
    const ph = side > 0 ? pp : PI - pp;
    for (let k = 0; k < W; k++) {
      const q = j * W + k;
      wallAt(ph, zc + (u0 + k * cell) * dir);
      for (let m = 0; m < 6; m++) PP[q * 6 + m] = WS[m];
      PW[q * 8] = WS[6]; PW[q * 8 + 1] = WS[7] / Math.max(0.05, WS[12]); PW[q * 8 + 2] = WS[8] / Math.max(0.05, WS[13]);
      PW[q * 8 + 3] = WS[9]; PW[q * 8 + 4] = WS[10]; PW[q * 8 + 5] = WS[11]; PW[q * 8 + 6] = WS[12]; PW[q * 8 + 7] = WS[13];
    }
  }
  return true;
}
// Bilinear sample of the mapped wall at fractional grid coordinates into PV.
function sample(fu, fv) {
  fu = Math.max(0, Math.min(gW - 1.0001, fu)); fv = Math.max(0, Math.min(gH - 1.0001, fv));
  const i = fu | 0, j = fv | 0, s = fu - i, t = fv - j;
  const a = j * gW + i, c = a + 1, d = a + gW, e = d + 1;
  const wa = (1 - s) * (1 - t), wc = s * (1 - t), wd = (1 - s) * t, we = s * t;
  for (let m = 0; m < 6; m++) PV[m] = PP[a * 6 + m] * wa + PP[c * 6 + m] * wc + PP[d * 6 + m] * wd + PP[e * 6 + m] * we;
  for (let m = 0; m < 8; m++) PV[6 + m] = PW[a * 8 + m] * wa + PW[c * 8 + m] * wc + PW[d * 8 + m] * wd + PW[e * 8 + m] * we;
  const n = s + t < 1 ? a : e; // flicker source: not interpolable
  PV[11] = PW[n * 8 + 5];
  const l = Math.hypot(PV[3], PV[4], PV[5]) || 1;
  PV[3] /= l; PV[4] /= l; PV[5] /= l;
}
// One pigment vertex at fractional grid coordinates. layer 0: fill, 1: line/black.
function pvert(b, fu, fv, off, layer) {
  sample(fu, fv);
  const u = gU0 + fu * gCell, v = gV0 + fv * gCell, sk = gSk;
  let cr, cg, cb, dens;
  if (layer === 0) {
    const bel = sstep(-0.02, -0.2, v / gL); // belly tone (bicolour figures)
    cr = mix(FC[0], FC[3], bel); cg = mix(FC[1], FC[4], bel); cb = mix(FC[2], FC[5], bel);
    dens = sat(0.66 + 0.5 * (noise3(u * 1.2 + sk, v * 1.2, sk * 1.7) - 0.3));
    // pigment soaked into the rock: the wall tone shows through, more where it is thin
    dens = 0.42 + 0.4 * dens * (0.8 + 0.2 * noise3(u * 7 + sk, v * 7, sk + 3));
  } else {
    cr = LC[0]; cg = LC[1]; cb = LC[2];
    dens = 0.52 + 0.3 * sat(0.86 + 0.3 * (noise3(u * 1.5 + sk, v * 1.5, sk + 4) - 0.45)) * (0.75 + 0.25 * noise3(u * 9 + sk, v * 9, sk + 8));
  }
  const r = mix(PV[6], cr, dens), g = mix(PV[7], cg, dens), bb = mix(PV[8], cb, dens);
  b.color(r, g * PV[12], bb * PV[13]).ao(PV[9]).emissive(PV[10], PV[11]);
  return b.vertex(PV[0] + PV[3] * off, PV[1] + PV[4] * off, PV[2] + PV[5] * off, PV[3], PV[4], PV[5]);
}

// Marching squares over vals (inside < 0): emits the inside region of every cell with
// shared corner and edge vertices. skipK: skip fill cells fully under the black mass.
function march(b, vals, off, layer, skipK) {
  const W = gW, Hh = gH;
  VI.fill(-1, 0, W * Hh); EHI.fill(-1, 0, W * Hh); EVI.fill(-1, 0, W * Hh);
  for (let j = 0; j < Hh - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i;
    if (BC[a]) continue;
    QC[0] = a; QC[1] = a + 1; QC[2] = a + W + 1; QC[3] = a + W;
    const f0 = vals[QC[0]], f1 = vals[QC[1]], f2 = vals[QC[2]], f3 = vals[QC[3]];
    if (f0 >= 0 && f1 >= 0 && f2 >= 0 && f3 >= 0) continue;
    if (skipK && PK[QC[0]] < -0.015 && PK[QC[1]] < -0.015 && PK[QC[2]] < -0.015 && PK[QC[3]] < -0.015) continue;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const p = QC[k], q = QC[(k + 1) & 3], fp = vals[p], fq = vals[q];
      if (fp < 0) {
        if (VI[p] < 0) VI[p] = pvert(b, p % W, (p / W) | 0, off, layer);
        POLY[n++] = VI[p];
      }
      if ((fp < 0) !== (fq < 0)) {
        const lo = p < q ? p : q, hz = q - p === 1 || p - q === 1;
        const cache = hz ? EHI : EVI;
        if (cache[lo] < 0) {
          const t = fp / (fp - fq);
          const pu = p % W, pv = (p / W) | 0, qu = q % W, qv = (q / W) | 0;
          cache[lo] = pvert(b, mix(pu, qu, t), mix(pv, qv, t), off, layer);
        }
        POLY[n++] = cache[lo];
      }
    }
    for (let t = 1; t < n - 1; t++) b.tri(POLY[0], POLY[t], POLY[t + 1]);
  }
}
// Merged interior: square blocks of cells (4x4, then 2x2 in what is left) whose corners and
// 1-cell ring are all inside become one quad, slightly under the fine layer and overlapping
// it by half a cell. Marks the covered cells in BC for march().
function blocks(b, vals, off, layer) {
  const W = gW, Hh = gH;
  BC.fill(0, 0, W * Hh);
  for (let BS = 4; BS >= 2; BS -= 2) {
    for (let j0 = 1; j0 + BS + 1 < Hh; j0 += BS) for (let i0 = 1; i0 + BS + 1 < W; i0 += BS) {
      let ok = true;
      for (let j = j0; j < j0 + BS && ok; j++) for (let i = i0; i < i0 + BS; i++) if (BC[j * W + i]) { ok = false; break; }
      for (let j = j0 - 1; j <= j0 + BS + 1 && ok; j++) for (let i = i0 - 1; i <= i0 + BS + 1; i++) if (vals[j * W + i] > -0.01) { ok = false; break; }
      if (!ok) continue;
      for (let j = j0; j < j0 + BS; j++) for (let i = i0; i < i0 + BS; i++) BC[j * W + i] = 1;
      const a = pvert(b, i0 - 0.5, j0 - 0.5, off, layer), c = pvert(b, i0 + BS + 0.5, j0 - 0.5, off, layer);
      const e = pvert(b, i0 + BS + 0.5, j0 + BS + 0.5, off, layer), d = pvert(b, i0 - 0.5, j0 + BS + 0.5, off, layer);
      b.quad(a, c, e, d);
    }
  }
}
// A straight ribbon in (u, v) metres from P to Q with half widths w0, w1, its centre line
// shifted by s0, s1 along the normal (nu, nv), extended by ext at both ends.
function ribbon(b, pu, pv, qu, qv, w0, w1, nu, nv, s0, s1, ext0, ext1, off) {
  let tu = qu - pu, tv = qv - pv;
  const l = Math.hypot(tu, tv) || 1; tu /= l; tv /= l;
  const ic = 1 / gCell;
  const ax = pu - tu * ext0, ay = pv - tv * ext0, bx = qu + tu * ext1, by = qv + tv * ext1;
  const v0 = pvert(b, (ax + nu * (s0 - w0) - gU0) * ic, (ay + nv * (s0 - w0) - gV0) * ic, off, 1);
  const v1 = pvert(b, (ax + nu * (s0 + w0) - gU0) * ic, (ay + nv * (s0 + w0) - gV0) * ic, off, 1);
  const v2 = pvert(b, (bx + nu * (s1 + w1) - gU0) * ic, (by + nv * (s1 + w1) - gV0) * ic, off, 1);
  const v3 = pvert(b, (bx + nu * (s1 - w1) - gU0) * ic, (by + nv * (s1 - w1) - gV0) * ic, off, 1);
  b.quad(v0, v1, v2, v3);
}
// Outline: ribbons along the fill contour (marching-squares segments), slightly inside it,
// width varying along the line, with a few breaks.
function outline(b, vals, off) {
  const W = gW, Hh = gH, c = gCell, sk = gSk, ow = gF.outlineW * gL;
  for (let j = 0; j < Hh - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i;
    QC[0] = a; QC[1] = a + 1; QC[2] = a + W + 1; QC[3] = a + W;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const p = QC[k], q = QC[(k + 1) & 3], fp = vals[p], fq = vals[q];
      if ((fp < 0) !== (fq < 0)) {
        const t = fp / (fp - fq);
        CUT[n * 2] = gU0 + mix(p % W, q % W, t) * c; CUT[n * 2 + 1] = gV0 + mix((p / W) | 0, (q / W) | 0, t) * c; n++;
      }
    }
    if (n < 2) continue;
    // gradient direction (towards outside)
    const f0 = vals[QC[0]], f1 = vals[QC[1]], f2 = vals[QC[2]], f3 = vals[QC[3]];
    const gx = (f1 - f0 + f2 - f3), gy = (f3 - f0 + f2 - f1);
    for (let s = 0; s + 1 < n; s += 2) {
      const pu = CUT[s * 2], pv = CUT[s * 2 + 1], qu = CUT[s * 2 + 2], qv = CUT[s * 2 + 3];
      const mu = (pu + qu) * 0.5, mv = (pv + qv) * 0.5;
      if (noise3(mu * 0.9 + sk, mv * 0.9, sk + 13) > 0.8) continue; // a break in the line
      let tu = qu - pu, tv = qv - pv;
      const l = Math.hypot(tu, tv);
      if (l < 1e-5) continue;
      let nu = -tv / l, nv = tu / l;
      if (nu * gx + nv * gy < 0) { nu = -nu; nv = -nv; }
      const w0 = 0.5 * ow * (0.55 + 0.9 * noise3(pu * 1.3 + sk, pv * 1.3, sk + 9));
      const w1 = 0.5 * ow * (0.55 + 0.9 * noise3(qu * 1.3 + sk, qv * 1.3, sk + 9));
      ribbon(b, pu, pv, qu, qv, w0, w1, nu, nv, -0.6 * w0, -0.6 * w1, w0 * 0.7, w1 * 0.7, off);
    }
  }
}
// Tapered strokes (horns, antlers, mane, tail) straight from the capsule list.
function strokes(b, C, dir, off) {
  const L = gL;
  for (let o = 0; o < C.length; o += 6) {
    const pu = C[o] * L, pv = C[o + 1] * L, qu = C[o + 2] * L, qv = C[o + 3] * L;
    const r0 = C[o + 4] * L, r1 = C[o + 5] * L;
    let tu = qu - pu, tv = qv - pv;
    const l = Math.hypot(tu, tv);
    if (l < 1e-5) continue;
    tu /= l; tv /= l;
    ribbon(b, pu, pv, qu, qv, r0, r1, -tv, tu, 0, 0, r0 * 0.6, r1 * 0.6, off);
  }
}

const HANDS_SET = [ // u, v, angle, colour (0 red, 1 black)
  [-0.55, -0.1, 0.3, 0], [-0.22, 0.18, -0.1, 0], [0.08, -0.14, 0.12, 1], [0.38, 0.16, -0.25, 0], [0.58, -0.2, 0.05, 0],
];
const HS = 1.3; // hand scale
function handsPaint(u, v, variant) {
  let cov = 0, cr = 0, cg = 0, cb = 0;
  for (let i = 0; i < HANDS_SET.length; i++) {
    const h = HANDS_SET[i];
    const ca = Math.cos(h[2]), sa = Math.sin(h[2]);
    const px = (u - h[0]) * ca + (v - h[1]) * sa, py = -(u - h[0]) * sa + (v - h[1]) * ca;
    if (px * px + py * py > 0.16) continue;
    const d = sdf(HAND, px / HS, py / HS, 0.012) * HS;
    const sp = d > 0 ? Math.exp(-d / 0.055) * (0.7 + 0.45 * noise3(u * 26, v * 26, i)) * sstep(-0.004, 0.008, d) : 0;
    const c = (h[3] + variant) % 2 ? BLACK : RED;
    if (sp > cov) { cov = sat(sp); cr = c[0]; cg = c[1]; cb = c[2]; }
  }
  M.r = mix(M.r, cr, cov); M.g = mix(M.g, cg, cov); M.b = mix(M.b, cb, cov);
  return cov;
}

// Built at which painting i is begun: the figures, in tier order, start evenly spaced over
// 0.02-0.74, each drawing itself in over ~0.26 (outline, fill, masses, strokes), so at any
// moment several are part-drawn and the last finishes at 1. Build-time only.
function figStart(i) {
  const ti = FIG[i * 8 + 7];
  let rank = 0;
  for (let j = 0; j < nFig; j++) { const tj = FIG[j * 8 + 7]; if (tj < ti || (tj === ti && j < i)) rank++; }
  return 0.02 + 0.72 * rank / Math.max(1, nFig - 1);
}
// REVEAL tag for the next layer: spreads over `reach` m from figure point (u, v), in [t0, t1].
function revealFrom(b, u, v, t0, t1, reach) {
  sample((u - gU0) / gCell, (v - gV0) / gCell);
  b.timeless().pivot(PV[0], PV[1], PV[2]).appear(t0, t1, MOTION.REVEAL, reach, BY.BUILT);
}
const HP3 = new Float64Array(3 * 8); // hand stencil centres on the wall
// Lays painting i of FIG on the wall, each layer revealed the way it was made: the charcoal
// outline drawn from the head back, the ochre fill soaking out from the body, the black
// masses, then horns, antlers and tails; dots dabbed one by one; hands sprayed one at a time.
function paintFigure(b, i) {
  const ts = figStart(i);
  const g = i * 8;
  const side = FIG[g], zc = FIG[g + 1], type = FIG[g + 2], L = FIG[g + 3], dir = FIG[g + 4] || 1, vc = FIG[g + 5], variant = FIG[g + 6];
  gSk = i * 3.7 + 1; gL = L;
  if (type <= S) { // animal: fill, black masses, outline, strokes
    const F = type === A ? AUROCHS : type === H ? HORSE : STAG;
    gF = F;
    const cell = F === AUROCHS ? 0.07 : F === HORSE ? 0.062 : 0.055;
    if (!mapFigure(side, zc, vc, dir, F.bbox[0] * L, F.bbox[1] * L, F.bbox[2] * L, F.bbox[3] * L, cell)) return;
    let fc = RED, fb = RED, lc = BLACK;
    if (F === AUROCHS) { fc = variant ? RED : BROWN; fb = variant ? ROSE : BROWN; }
    else if (F === HORSE) { fc = variant ? RED : YEL; fb = variant ? ROSE : PALE; }
    else { fc = RED; fb = ROSE; lc = variant ? RED : BLACK; }
    FC[0] = fc[0]; FC[1] = fc[1]; FC[2] = fc[2]; FC[3] = fb[0]; FC[4] = fb[1]; FC[5] = fb[2];
    LC[0] = lc[0]; LC[1] = lc[1]; LC[2] = lc[2];
    const sk = gSk;
    for (let q = 0; q < gW * gH; q++) {
      const u = gU0 + (q % gW) * gCell, v = gV0 + ((q / gW) | 0) * gCell, U = u / L, V = v / L;
      const jit = sn(u * 5 + sk, v * 5, sk) * 0.012 + sn(u * 14, v * 14, sk + 2) * 0.003; // slightly irregular pigment edge
      const flake = 0.05 * sstep(0.76, 0.86, noise3(u * 3 + sk, v * 3, sk + 6)); // pigment gaps
      PF[q] = sdf(F.body, U, V, F.k) * L + jit + flake;
      PK[q] = sdf(F.dark, U, V, 0.03) * L + jit * 0.8;
    }
    const bb = F.bbox, cu = (bb[0] + bb[2]) * 0.5 * L, cv = (bb[1] + bb[3]) * 0.5 * L;
    const hu = (bb[0] + 0.85 * (bb[2] - bb[0])) * L, hv = (bb[1] + 0.7 * (bb[3] - bb[1])) * L;
    const span = (bb[2] - bb[0]) * L;
    // outline first (0-0.1), then the fill soaks out (0.09-0.2), black masses, strokes
    revealFrom(b, cu, cv, ts + 0.09, ts + 0.2, span * 0.55);
    blocks(b, PF, 0.018, 0);
    march(b, PF, 0.022, 0, true);
    revealFrom(b, hu, hv, ts + 0.15, ts + 0.23, span * 0.6);
    blocks(b, PK, 0.025, 1);
    march(b, PK, 0.028, 1, false);
    revealFrom(b, hu, hv, ts, ts + 0.1, span * 1.0);
    outline(b, PF, 0.031);
    revealFrom(b, hu, hv, ts + 0.2, ts + 0.26, span * 0.45);
    strokes(b, F.strokes, dir, 0.033);
    b.timeless();
    return;
  }
  if (type === DOTS) { // rows of finger-dabbed dots, each a ragged disc
    if (!mapFigure(side, zc, vc, 1, -1.45, -0.6, 1.55, 0.35, 0.15)) return;
    const c = variant ? BLACK : RED;
    LC[0] = c[0]; LC[1] = c[1]; LC[2] = c[2];
    const ic = 1 / gCell;
    for (let row = 0; row < 2; row++) for (let k = 0; k < 9; k++) {
      const cx = (k - 4) * 0.27 + row * 0.13 + 0.07 * sn(k, row, gSk), cy = row * -0.26 + 0.06 * sn(k * 1.7, row + 3, gSk);
      const rr = 0.075 + 0.025 * noise3(k, row, gSk + 5);
      const td = ts + 0.012 * (row * 9 + k);
      revealFrom(b, cx, cy, td, td + 0.012, rr * 1.1);
      const cen = pvert(b, (cx - gU0) * ic, (cy - gV0) * ic, 0.024, 1), r0 = b.nv;
      for (let s = 0; s < 10; s++) {
        const a = s / 10 * PI * 2, rj = rr * (0.85 + 0.3 * noise3(Math.cos(a) * 2 + k, Math.sin(a) * 2 + row, gSk));
        pvert(b, (cx + Math.cos(a) * rj - gU0) * ic, (cy + Math.sin(a) * rj - gV0) * ic, 0.024, 1);
      }
      for (let s = 0; s < 10; s++) b.tri(cen, r0 + s, r0 + (s + 1) % 10);
    }
    b.timeless();
    return;
  }
  // hand stencils: sprayed pigment (soft by nature) on a fine vertex-colour grid
  const u0 = -0.85, v0 = -0.55, u1 = 0.85, v1 = 0.55, cell = 0.035;
  if (!mapFigure(side, zc, vc, 1, u0, v0, u1, v1, cell)) return;
  const W = gW, Hh = gH;
  for (let q = 0; q < W * Hh; q++) {
    const u = u0 + (q % W) * cell, v = v0 + ((q / W) | 0) * cell;
    sample(q % W, (q / W) | 0);
    M.r = PV[6]; M.g = PV[7]; M.b = PV[8];
    const cov = handsPaint(u, v, variant);
    DC[q * 4] = M.r; DC[q * 4 + 1] = M.g * PV[12]; DC[q * 4 + 2] = M.b * PV[13]; DC[q * 4 + 3] = cov;
    DM[q * 3] = PV[9]; DM[q * 3 + 1] = PV[10]; DM[q * 3 + 2] = PV[11];
    DP[q * 6] = PV[0] + PV[3] * 0.02; DP[q * 6 + 1] = PV[1] + PV[4] * 0.02; DP[q * 6 + 2] = PV[2] + PV[5] * 0.02;
    DP[q * 6 + 3] = PV[3]; DP[q * 6 + 4] = PV[4]; DP[q * 6 + 5] = PV[5];
    DI[q] = -1;
  }
  const need = (q) => DC[q * 4 + 3] > 0.15;
  for (let h = 0; h < HANDS_SET.length; h++) {
    sample((HANDS_SET[h][0] - u0) / cell, (HANDS_SET[h][1] - v0) / cell);
    HP3[h * 3] = PV[0]; HP3[h * 3 + 1] = PV[1]; HP3[h * 3 + 2] = PV[2];
  }
  for (let j = 0; j < Hh - 1; j++) for (let k = 0; k < W - 1; k++) {
    const a = j * W + k, c = a + 1, d = a + W, e = a + W + 1;
    if (!(need(a) || need(c) || need(d) || need(e))) continue;
    for (let m = 0; m < 4; m++) {
      const q = m === 0 ? a : m === 1 ? c : m === 2 ? e : d;
      if (DI[q] >= 0) continue;
      const o = q * 6;
      // sprayed one hand at a time: each vertex takes the window of the nearest hand
      const u = u0 + (q % W) * cell, v = v0 + ((q / W) | 0) * cell;
      let hb = 0, db = 1e9;
      for (let h = 0; h < HANDS_SET.length; h++) { const d = (u - HANDS_SET[h][0]) ** 2 + (v - HANDS_SET[h][1]) ** 2; if (d < db) { db = d; hb = h; } }
      const th = ts + 0.035 * hb;
      b.timeless().pivot(HP3[hb * 3], HP3[hb * 3 + 1], HP3[hb * 3 + 2]).appear(th, th + 0.04, MOTION.REVEAL, 0.24, BY.BUILT);
      b.color(DC[q * 4], DC[q * 4 + 1], DC[q * 4 + 2]).ao(DM[q * 3]).emissive(DM[q * 3 + 1], DM[q * 3 + 2]);
      DI[q] = b.vertex(DP[o], DP[o + 1], DP[o + 2], DP[o + 3], DP[o + 4], DP[o + 5]);
    }
    b.quad(DI[a], DI[c], DI[e], DI[d]);
  }
  b.timeless();
}

// ---------------------------------------------------------------------------------
// Props

// Broken limestone block with per-vertex snow (outside) or cave colouring (inside).
function boulder(b, cx, cy, cz, rx, ry, rz, seed, outside, blocky = 0) {
  const W = 17, Hh = 11;
  for (let k = 0; k < Hh; k++) for (let i = 0; i < W; i++) {
    const th = (k / (Hh - 1)) * PI, ph = (i / (W - 1)) * PI * 2;
    const dx = Math.sin(th) * Math.cos(ph), dy = Math.cos(th), dz = Math.sin(th) * Math.sin(ph);
    let r = 1 + 0.16 * sn(dx * 1.6 + seed, dy * 1.6, dz * 1.6 - seed) + 0.05 * sn(dx * 5 + seed, dy * 5, dz * 5);
    for (let f = 0; f < 9; f++) { // flat breaks: angular blocks
      const a = seed * 1.7 + f * 2.39, px = Math.cos(a), pz = Math.sin(a), py = f === 8 ? 1.4 : f === 7 ? -0.2 : (noise3(seed, f, 0.5) - 0.35) * 1.6;
      const fl = (dx * px + dy * py + dz * pz) / Math.hypot(px, py, pz);
      const dd = 0.6 - 0.16 * blocky + 0.16 * noise3(seed, f, 2.5);
      if (fl > dd) r = Math.min(r, dd / fl);
    }
    const o = (k * W + i) * 3;
    GP[o] = cx + dx * r * rx; GP[o + 1] = cy + dy * r * ry; GP[o + 2] = cz + dz * r * rz;
  }
  gridNormals(W, Hh, 1);
  for (let q = 0; q < W * Hh; q++) {
    const o = q * 3;
    if (GN[o] * (GP[o] - cx) + GN[o + 1] * (GP[o + 1] - cy) + GN[o + 2] * (GP[o + 2] - cz) < 0) { GN[o] = -GN[o]; GN[o + 1] = -GN[o + 1]; GN[o + 2] = -GN[o + 2]; }
  }
  b.surface(SURF.STONE);
  const it = emitGrid(b, W, Hh, outside
    ? (x, y, z, nx, ny, nz) => { rockMat(x, y, z, ny, 1, -0.05); M.ao *= 0.6 + 0.4 * sstep(cy - ry * 0.3, cy + ry * 0.4, y); }
    : (x, y, z, nx, ny, nz) => { wallMat(x, y, z, nx, ny, nz); M.r *= 0.8; M.g *= 0.8; M.b *= 0.8; });
  while (!it.next().done);
}

// Hanging cone (icicle / stalactite) from (x, y, z) down by len.
const PROF = new Float64Array(10);
const NOCAP = { caps: false };
function hanging(b, x, y, z, len, r, seg) {
  PROF[0] = 0; PROF[1] = -len; PROF[2] = r * 0.35; PROF[3] = -len * 0.6; PROF[4] = r * 0.78; PROF[5] = -len * 0.2; PROF[6] = r; PROF[7] = 0.25;
  b.push(); b.translate(x, y, z); b.lathe(PROF.subarray(0, 8), seg, NOCAP); b.pop();
}

// Flame tongue: a wobbling, bending cone; colour x e x 20 is the emitted radiance.
let WPH = 0;
const FLAME_OPT = { caps: false, wobble: (th, t) => 0.3 * Math.sin(th * 3 + WPH + t * 5) * t };
const FPROF = new Float64Array(10);
function tongue(b, x, y, z, r, h, cr, cg, cb, e, src, lean, yaw) {
  FPROF[0] = r; FPROF[1] = 0; FPROF[2] = r * 0.95; FPROF[3] = h * 0.25; FPROF[4] = r * 0.62; FPROF[5] = h * 0.55; FPROF[6] = r * 0.22; FPROF[7] = h * 0.82; FPROF[8] = 0; FPROF[9] = h;
  WPH += 1.7;
  b.surface(SURF.PLAIN).ao(1).color(cr, cg, cb).emissive(e, src);
  b.push(); b.translate(x, y, z); b.rotateY(yaw); b.rotateZ(lean); b.lathe(FPROF, 8, FLAME_OPT); b.pop();
}
// Flames with a colour ramp: deep red-orange outer tongues, orange, yellow, pale core.
function flames(b, x, y, z, size, src) {
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9 + 0.3, o = 0.2 * size;
    tongue(b, x + Math.cos(a) * o, y, z + Math.sin(a) * o, 0.12 * size, (0.4 + 0.3 * noise3(i, size, 2)) * size, 0.3, 0.06, 0.008, 0.55, src, 0.25 + rng() * 0.2, -a);
  }
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + 1.0, o = 0.09 * size;
    tongue(b, x + Math.cos(a) * o, y, z + Math.sin(a) * o, 0.12 * size, (0.65 + 0.25 * noise3(i, size, 5)) * size, 0.32, 0.14, 0.02, 0.6, src, (rng() - 0.5) * 0.3, -a);
  }
  tongue(b, x, y, z, 0.1 * size, 1.0 * size, 0.33, 0.24, 0.1, 0.62, src, 0, 0);
  tongue(b, x + 0.03 * size, y, z, 0.05 * size, 0.55 * size, 0.34, 0.31, 0.22, 0.66, src, 0.08, 1);
  b.emissive(0, 0);
}
// Hearth: ash and ember bed, glowing coals, ring of stones, logs with glowing ends, flames.
function hearth(b, x, y, z, size, slot, lit) {
  const src = slot > 0 ? slot : FLICKER.OWN;
  b.push(); b.translate(x, y, z);
  const R = 0.85 * size;
  b.surface(SURF.EARTH).ao(0.9);
  b.disc(R, 18, 4, (px, pz) => {
    const r = Math.hypot(px, pz) / R;
    const em = Math.max(0, 1 - r * 1.35) * lit * (0.6 + 0.7 * noise3(px * 6, 0, pz * 6));
    b.color(mix(0.06, 0.34, sat(em)), mix(0.05, 0.07, sat(em)), 0.03).emissive(em * 0.4, src);
    return 0.03 + 0.08 * Math.max(0, 1 - r * r);
  });
  // coals
  b.surface(SURF.STONE).ao(1);
  for (let i = 0; i < 9; i++) {
    const a = rng() * PI * 2, r = rng() * 0.45 * size, s = (0.05 + rng() * 0.05) * size;
    b.color(0.3, 0.06 + rng() * 0.04, 0.01).emissive(lit * (0.3 + rng() * 0.15), src);
    b.push(); b.translate(Math.cos(a) * r, 0.08 * size, Math.sin(a) * r); b.rock(s, s * 0.6, s, 1, 0.3, i + 3, 2, 0.5); b.pop();
  }
  b.emissive(0, 0).ao(0.8);
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * PI * 2 + rng() * 0.3, r = 0.95 * size, gq = 0.07 + rng() * 0.05; // soot-blackened
    b.color(gq, gq * 0.93, gq * 0.85);
    b.push(); b.translate(Math.cos(a) * r, 0.05 * size, Math.sin(a) * r); b.rotateY(-a);
    b.rock(0.2 * size, 0.13 * size, 0.15 * size, 2, 0.25, (x * 7 + i) | 0, 3, 0.4);
    b.pop();
  }
  b.surface(SURF.WOOD).ao(0.9);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * PI * 2 + 0.4 + rng() * 0.4, c = Math.cos(a), s = Math.sin(a);
    b.color(0.1, 0.07, 0.045).emissive(0, 0);
    b.beam(c * 0.9 * size, 0.08 * size, s * 0.9 * size, c * 0.3 * size, 0.14 * size, s * 0.3 * size, 0.065 * size, 0.055 * size, 6, true);
    b.color(0.3, 0.07, 0.012).emissive(0.3 * lit, src);
    b.beam(c * 0.3 * size, 0.14 * size, s * 0.3 * size, c * 0.1 * size, 0.2 * size, s * 0.1 * size, 0.055 * size, 0.04 * size, 6, true);
  }
  b.emissive(0, 0);
  if (lit > 0.02) b.flames(0, 0.12 * size, 0, size * 1.25 * (0.6 + 0.4 * lit), src, 17 + src * 5); // FX layer
  b.pop();
}

// Person in a hide cloak (hood, cloak to the knees, arms free), facing +z at the origin of
// the current frame. Returns the shoulder height.
function person(b, pose, seed, cr, cg, cb) {
  const kneel = pose === POSE.KNEEL;
  b.surface(SURF.HIDE).color(cr, cg, cb);
  b.human(pose, 1.66, seed);
  const sh = kneel ? 0.98 : 1.38;
  // cloak (outward: bottom -> top), open at the front of the arms
  if (kneel) { PROF[0] = 0.36; PROF[1] = 0.1; PROF[2] = 0.32; PROF[3] = 0.55; PROF[4] = 0.24; PROF[5] = 0.85; PROF[6] = 0.15; PROF[7] = 1.02; }
  else { PROF[0] = 0.36; PROF[1] = 0.48; PROF[2] = 0.32; PROF[3] = 0.9; PROF[4] = 0.26; PROF[5] = 1.22; PROF[6] = 0.15; PROF[7] = 1.43; }
  b.color(cr * 1.3, cg * 1.25, cb * 1.2);
  b.push(); b.translate(0, 0, -0.03); b.scale(1, 1, 0.78); b.lathe(PROF.subarray(0, 8), 10, { caps: false, a0: HP + 0.35, a1: HP - 0.35 + PI * 2 }); b.pop();
  // fur hood and hair
  b.color(cr * 0.8, cg * 0.75, cb * 0.7);
  const hy = kneel ? 1.11 : 1.55;
  b.push(); b.translate(0, hy + 0.03, -0.04); b.ellipsoid(0.135, 0.135, 0.14, 2); b.pop();
  b.push(); b.translate(0, hy - 0.12, -0.06); b.ellipsoid(0.19, 0.08, 0.15, 2); b.pop();
  return sh;
}
// Painter facing the wall (+z of its frame), torch raised in the left hand.
function painter(b, x, z, yaw, seed) {
  b.push(); b.at(x, floorH(x, z) - 0.03, z, yaw);
  b.ao(0.75).emissive(0, 0);
  const sy = person(b, POSE.STAND, seed, 0.13, 0.085, 0.055);
  b.color(0.12, 0.08, 0.055);
  b.beam(-0.19, sy, 0.0, -0.28, sy + 0.3, 0.34, 0.05, 0.04, 5, true);
  b.surface(SURF.WOOD).color(0.1, 0.07, 0.045);
  b.beam(-0.28, sy + 0.18, 0.32, -0.34, sy + 0.72, 0.44, 0.028, 0.034, 5, true);
  flames(b, -0.34, sy + 0.72, 0.44, 0.38, FLICKER.OWN);
  b.pop();
}

// Fat lamp: a hollowed stone with a small flame.
function lamp(b, x, y, z) {
  b.surface(SURF.STONE).color(0.3, 0.27, 0.22).ao(0.6).emissive(0.05, 0);
  b.push(); b.translate(x, y + 0.05, z); b.rock(0.2, 0.09, 0.15, 2, 0.15, (x * 13 + z) | 0, 3, 0.7); b.pop();
  tongue(b, x, y + 0.12, z, 0.045, 0.2, 0.3, 0.08, 0.01, 0.55, FLICKER.OWN, 0, 0);
  tongue(b, x, y + 0.12, z, 0.024, 0.13, 0.33, 0.24, 0.08, 0.6, FLICKER.OWN, 0, 0);
  b.emissive(0, 0);
}

// Conical hide tent (outside), with poles through the top and a dark doorway.
function tent(b, x, y, z, r, h, yaw) {
  b.push(); b.at(x, y, z, yaw);
  b.surface(SURF.HIDE).ao(0.85).emissive(0, 0);
  for (let k = 0; k < 2; k++) {
    b.color(k ? 0.17 : 0.22, k ? 0.11 : 0.14, k ? 0.07 : 0.085);
    PROF[0] = r; PROF[1] = -0.1; PROF[2] = r * 0.62; PROF[3] = h * 0.4; PROF[4] = r * 0.12; PROF[5] = h * 0.92;
    // two panels (front with the doorway gap, back)
    b.lathe(PROF.subarray(0, 6), 9, { caps: false, a0: k ? 1.95 : -1.2, a1: k ? 1.95 + 3.6 : 1.2 + 0.2 });
  }
  b.color(0.03, 0.025, 0.02).ao(0.3);
  b.push(); b.translate(0, 0, 0); b.lathe(PROF.subarray(0, 6), 3, { caps: false, a0: 1.4, a1: 1.95 }); b.pop();
  b.surface(SURF.WOOD).color(0.12, 0.08, 0.05).ao(0.9);
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * PI * 2 + 0.3;
    b.beam(Math.cos(a) * r * 0.97, -0.1, Math.sin(a) * r * 0.97, -Math.cos(a) * 0.25, h * 1.12, -Math.sin(a) * 0.25, 0.045, 0.03, 4, true);
  }
  b.pop();
}

// Camp outside a mouth (end 0: +z, 1: -z): bonfire, tents, people, firewood, drying rack.
function camp(b, end, built, seed) {
  const sg = end ? -1 : 1;
  const cx = sg * 11.5, cz = sg * (LT + 9);
  const cy = Math.max(0, apron(cx, cz));
  hearth(b, cx, cy + 0.02, cz, 1.25, 0, 1);
  tent(b, sg * 16.5, Math.max(0, apron(sg * 16.5, sg * (LT + 14))), sg * (LT + 14), 2.1, 3.4, 0.6 + end * PI);
  if (built >= 0.85) tent(b, sg * 21, Math.max(0, apron(sg * 21, sg * (LT + 7))), sg * (LT + 7), 1.8, 3.0, 2.0 + end * PI);
  b.ao(0.8).emissive(0, 0);
  b.push(); b.at(cx - sg * 1.6, cy, cz - sg * 0.6, end ? 1.2 : -2.0); person(b, POSE.KNEEL, seed + 5, 0.12, 0.08, 0.05); b.pop();
  b.push(); b.at(cx + sg * 1.7, cy, cz + sg * 0.9, end ? -2.3 : 0.8); person(b, POSE.STAND, seed + 6, 0.11, 0.075, 0.05); b.pop();
  b.surface(SURF.WOOD).color(0.15, 0.1, 0.06).ao(0.85);
  for (let k = 0; k < 6; k++) {
    const wz = cz + sg * (2.6 + (k % 3) * 0.17), wy = cy + 0.08 + (k / 3 | 0) * 0.15;
    b.beam(cx + sg * 1.2, wy, wz, cx + sg * 2.6, wy, wz + 0.1, 0.07, 0.06, 6, true);
  }
  if (built >= 0.85) { // drying rack with hides
    const rx = sg * 15, rz = sg * (LT + 20);
    const ry = Math.max(0, apron(rx, rz));
    b.surface(SURF.WOOD).color(0.13, 0.09, 0.06).ao(0.9).emissive(0, 0);
    b.beam(rx, ry - 0.2, rz - 1.6, rx, ry + 1.9, rz - 1.6, 0.06, 0.05, 6, true);
    b.beam(rx, ry - 0.2, rz + 1.6, rx, ry + 1.9, rz + 1.6, 0.06, 0.05, 6, true);
    b.beam(rx, ry + 1.85, rz - 1.8, rx, ry + 1.85, rz + 1.8, 0.045, 0.045, 6, true);
    b.surface(SURF.HIDE);
    for (let k = 0; k < 3; k++) {
      b.color(0.22 + 0.05 * k, 0.15, 0.09);
      b.box(rx, ry + 1.3, rz - 1.0 + k * 1.0, 0.03, 0.55, 0.42);
    }
  }
}

// ---------------------------------------------------------------------------------

export default {
  id: '1',
  name: 'Painted cave',
  caption: 'Ice Age hunters paint aurochs and horses by firelight',
  year: -17000,
  radius: 68,
  pad: 68,
  straddlesRoad: true,
  biome: 'ice',
  live: true,
  lights: [
    { pos: [9.2, 0.9, ZR], color: [1.0, 0.42, 0.13], intensity: 340, range: 28, flicker: 0.55 },
    { pos: [-9.2, 0.9, ZL], color: [1.0, 0.42, 0.13], intensity: 340, range: 28, flicker: 0.55 },
  ],
  detail: { at: [7.5, 2.4, -10.5], from: [-1.5, 1.7, 0.5] },
  // Event moment (LANDMARKS.md "Witness"): from above the approach, the outcrop whole with
  // the road running into its firelit mouth.
  witness: { dist: 120, height: 34, look: 7, az: 1.2, fov: 0.6, drift: 0.1 },

  // Live (handle.setState): built 0..1 brings the gallery to life: the hearths burn throughout;
  // paintings appear one by one in the order of their tier (each emerges through the rock
  // surface, PUSH, over ~0.5 s at 15 s per unit), lamps light where figures are being
  // painted, the painters arrive (0.45, 0.75), the mouth camps go up (0.55, 0.7). decay: unused.
  *build(b, built, decay, seed) {
    built = 1;
    gBuilt = built;
    nSrc = 0; WPH = 0;
    planGallery(seed);
    // wall foot table
    for (let i = 0; i <= 160; i++) {
      const z = -40 + i * 0.5;
      inner(0.08, z, T0); WX[i] = Math.abs(T0[0]);
      inner(PI - 0.08, z, T0); WX[161 + i] = Math.abs(T0[0]);
    }
    // hearths: one on each wall, in opposite halves
    const fxR = wallFoot(1, ZR) - 2.0, fxL = -(wallFoot(-1, ZL) - 2.0);
    b.light(0, fxR, 1.5, ZR, 1.0, 0.42, 0.13, 380, 30, 0.55);
    b.light(1, fxL, 1.5, ZL, 1.0, 0.42, 0.13, 380, 30, 0.55);
    addSrc(fxR, 0.9, ZR, 1.6, 5.5, FLICKER.LIGHT0);
    addSrc(fxL, 0.9, ZL, 1.6, 5.5, FLICKER.LIGHT1);
    // painters with torches on the wall opposite each hearth
    const pA = built >= 0.5, pB = built >= 0.8;
    const zA = -6.5, zB = 6.5;
    const pxA = -Math.max(6.8, wallFoot(-1, zA) - 1.0), pxB = Math.max(6.8, wallFoot(1, zB) - 1.0);
    if (pA) addSrc(pxA + 0.3, 2.1, zA + 0.45, 1.0, 3.8, FLICKER.OWN);
    if (pB) addSrc(pxB - 0.3, 2.1, zB - 0.45, 1.0, 3.8, FLICKER.OWN);
    // fat lamps: wherever painted figures on that wall need light (not by the own hearth)
    const firstLamp = nSrc;
    for (let sd = 1; sd >= -1; sd -= 2) {
      for (let lz = 24 - (sd < 0 ? 3 : 0); lz > -26; lz -= 6) {
        if (Math.abs(lz - (sd > 0 ? ZR : ZL)) < 6) continue;
        let need = false;
        for (let i = 0; i < nFig; i++) { const o = i * 8; if (FIG[o] === sd && FIG[o + 7] < built && Math.abs(FIG[o + 1] - lz) < 3.5 && Math.abs(FIG[o + 1]) < PAINT_Z) need = true; }
        if (need) addSrc(sd * Math.max(6.6, wallFoot(sd, lz) - 0.9), 0.5, lz, 1.0, 4.2, FLICKER.OWN);
      }
    }
    yield;

    // --- passage interior (inward normals), rows along z, columns around the section
    b.surface(SURF.CAVE_STONE);
    for (let k = 0; k < NZT; k++) {
      for (let i = 0; i < NPHI; i++) {
        const phi = mix(PHI0, PHI1, i / (NPHI - 1));
        const z = mix(-lipZ(phi, 1), lipZ(phi, 0), k / (NZT - 1));
        const o = (k * NPHI + i) * 3;
        inner(phi, z, T0);
        innerNormal(phi, z, T0, T3);
        GP[o] = T0[0]; GP[o + 1] = T0[1]; GP[o + 2] = T0[2];
        GN[o] = T3[0]; GN[o + 1] = T3[1]; GN[o + 2] = T3[2];
      }
      if (k % 30 === 29) yield;
    }
    yield* emitGrid(b, NPHI, NZT, wallMat, true);
    b.surface(SURF.STONE);
    yield;

    // --- outer shell: front face, hill, back face (outward normals). Every other column
    // meets a passage column at the lip; the ones between sit on the passage's edge.
    const NF = 22, NHL = 54, NQ = NF * 2 + NHL;
    for (let k = 0; k < NQ; k++) {
      let q;
      // rows dense at the lip and at the rim crease (a coarse crease draws a saw-tooth outline)
      const ease = (u) => u * u * (3 - 2 * u);
      if (k < NF) q = mix(ease(k / NF), k / NF, 0.25) * QF;
      else if (k < NF + NHL) q = QF + (1 - 2 * QF) * (0.5 - 0.5 * Math.cos(PI * (k - NF) / (NHL - 1)));
      else q = 1 - mix(ease((NQ - 1 - k) / NF), (NQ - 1 - k) / NF, 0.25) * QF;
      for (let i = 0; i < NPS; i++) {
        const o = (k * NPS + i) * 3;
        if ((k === 0 || k === NQ - 1) && (i & 1)) continue;
        shell(mix(PHI0, PHI1, i / (NPS - 1)), q, T0);
        GP[o] = T0[0]; GP[o + 1] = T0[1]; GP[o + 2] = T0[2];
      }
      if (k === 0 || k === NQ - 1) {
        for (let i = 1; i < NPS; i += 2) {
          const o = (k * NPS + i) * 3;
          for (let j = 0; j < 3; j++) GP[o + j] = (GP[o - 3 + j] + GP[o + 3 + j]) * 0.5;
        }
      }
      if (k % 20 === 19) yield;
    }
    gridNormals(NPS, NQ, 1);
    {
      const o = ((NF + (NHL >> 1)) * NPS + (NPS >> 1)) * 3;
      if (GN[o + 1] < 0) for (let q = 0; q < NPS * NQ * 3; q++) GN[q] = -GN[q];
    }
    smoothNormals(NPS, NQ, 1); // one pass only: the crags and ledges keep their facets
    // stylised: the outcrop is shaded with the broad (smoothed) normals, so it reads as a few
    // big lit and shaded planes with its bedding, not as a field of small bumps
    for (let q = 0; q < NPS * NQ * 3; q++) GN[q] = GS[q];
    // round the brow: the last front-face rows (and first back-face rows) take on the hill's
    // normal at the crease, so the crest shades as a rounded shoulder instead of a knife edge
    // whose sunlit far side shows through as a saw-tooth skyline
    for (let side = 0; side < 2; side++) {
      const kc = side ? NQ - NF - 1 : NF; // first hill row past the crease
      for (let j = 1; j <= 7; j++) {
        const k = side ? kc + j : kc - j, t = (1 - j / 8) ** 1.5;
        for (let i = 0; i < NPS; i++) {
          const o = (k * NPS + i) * 3, oc = (kc * NPS + i) * 3;
          let x = mix(GN[o], GN[oc], t), y = mix(GN[o + 1], GN[oc + 1], t), z = mix(GN[o + 2], GN[oc + 2], t);
          const l = Math.hypot(x, y, z) || 1;
          GN[o] = x / l; GN[o + 1] = y / l; GN[o + 2] = z / l;
          GS[o] = GN[o]; GS[o + 1] = GN[o + 1]; GS[o + 2] = GN[o + 2];
        }
      }
    }
    // ground contact of the outcrop (for the apron): the first rows above grade per column side
    nFP = 0;
    for (let k = 0; k < NQ; k++) for (let s = 0; s < 2; s++) {
      const o = (k * NPS + (s ? NPS - 4 : 3)) * 3;
      if (nFP < 512) { FP[nFP * 2] = GP[o]; FP[nFP * 2 + 1] = GP[o + 2]; nFP++; }
    }
    yield;
    // Per-vertex slate + snow (no per-fragment strata, so no regular banding): pale slate on
    // steep faces, heavy snow caps on every upward-facing surface.
    b.surface(SURF.PLAIN);
    yield* emitGrid(b, NPS, NQ, (x, y, z, nx, ny, nz, q) => {
      const az = Math.abs(z);
      // snow thins out toward the mouth, so the bare rock round the opening grades into the
      // snow-dusted outcrop instead of meeting it along a line
      const rec = (1 - sstep(LT + 2, LT + 18, az)) * (1 - sstep(9, 27, Math.hypot(x, y)));
      rockBase(x, y, z, 1 - 0.8 * rec);
      const v = 0.92 + 0.16 * noise3(x * 0.07 + 3, y * 0.07, z * 0.07);
      // exposed crag faces: noise-shaped patches where the steeper rock stays bare
      const crag = sstep(0.5, 0.7, noise3(x * 0.09 + 8, y * 0.11, z * 0.09));
      const sl = ny + 0.3 * (noise3(x * 0.12, y * 0.12 + 4, z * 0.12) - 0.5) - 0.3 * crag
        + 0.3 * sstep(11, 17, Math.hypot(x, y)); // snow-laden brow and upper slopes over the cliff
      // bare rock only right round the opening; the face above the mouth keeps its snow
      const recM = (1 - sstep(LT + 2, LT + 10, az)) * (1 - sstep(9, 15, Math.hypot(x, y)));
      const sw = sstep(0.36, 0.52, sl) * (1 - 0.85 * recM);
      M.r = mix(0.3 * v, 0.84, sw); M.g = mix(0.32 * v, 0.88, sw); M.b = mix(0.36 * v, 0.93, sw);
      M.src = 0;
      if (az < LT + 16 && Math.hypot(x, y) < 26) { // cool shade deepening into the mouth recess
        // (grades the bright cliff into the darker rock of the arch: one rock mass)
        const near = (1 - sstep(LT + 1, LT + 14, az)) * (1 - sstep(8, 25, Math.hypot(x, y)));
        M.ao *= 1 - 0.5 * near;
        M.r *= 1 - 0.42 * near; M.g *= 1 - 0.36 * near; M.b *= 1 - 0.26 * near;
      }
    });
    yield;

    // --- snow drifts around the foot (feather into the snowfield)
    {
      const X0 = -60, Z0 = -64, CS = 1.6, W = 76, Hh = 81;
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const x = X0 + i * CS, z = Z0 + j * CS, o = (j * W + i) * 3;
        GP[o] = x; GP[o + 1] = Math.hypot(x, z) > 66.5 ? -0.3 : apron(x, z); GP[o + 2] = z;
      }
      yield;
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const o = (j * W + i) * 3;
        const hx = GP[(j * W + Math.min(W - 1, i + 1)) * 3 + 1] - GP[(j * W + Math.max(0, i - 1)) * 3 + 1];
        const hz = GP[(Math.min(Hh - 1, j + 1) * W + i) * 3 + 1] - GP[(Math.max(0, j - 1) * W + i) * 3 + 1];
        const nx = -hx / (2 * CS), nz = -hz / (2 * CS), l = Math.hypot(nx, 1, nz);
        GN[o] = nx / l; GN[o + 1] = 1 / l; GN[o + 2] = nz / l;
        DI[j * W + i] = -1;
      }
      b.surface(SURF.PLAIN);
      for (let j = 0; j < Hh - 1; j++) for (let i = 0; i < W - 1; i++) {
        const a = j * W + i, c = a + 1, d = a + W, e = a + W + 1;
        const ya = GP[a * 3 + 1], yc = GP[c * 3 + 1], yd = GP[d * 3 + 1], ye = GP[e * 3 + 1];
        if (Math.max(ya, yc, yd, ye) <= 0.0) continue;
        if (Math.hypot(GP[a * 3], GP[a * 3 + 2]) > 67 || Math.hypot(GP[c * 3], GP[c * 3 + 2]) > 67 ||
          Math.hypot(GP[d * 3], GP[d * 3 + 2]) > 67 || Math.hypot(GP[e * 3], GP[e * 3 + 2]) > 67) continue;
        for (let m = 0; m < 4; m++) {
          const q = m === 0 ? a : m === 1 ? c : m === 2 ? e : d;
          if (DI[q] >= 0) continue;
          const o = q * 3, x = GP[o], y = GP[o + 1], z = GP[o + 2];
          const tal = sstep(0.55, 0.75, noise3(x * 0.35, 4.4, z * 0.35)) * sstep(0.5, 1.4, y);
          const v = 0.9 + 0.12 * noise3(x * 0.6, 1, z * 0.6);
          const rk = 0.28 * (0.8 + 0.4 * noise3(x * 1.3, 2, z * 1.3));
          // the snowfield's own colour at the edge, wind-scoured tundra showing through
          const scour = sstep(0.6, 0.78, noise3(x * 0.08 + 3, 2, z * 0.08)) * (1 - sstep(0.05, 0.4, y)) * 0.5;
          let r = 0.8 * v, g = 0.84 * v, bb = 0.9 * v;
          r = mix(r, 0.3, scour); g = mix(g, 0.27, scour); bb = mix(bb, 0.17, scour);
          b.color(mix(r, rk, tal), mix(g, rk * 0.97, tal), mix(bb, rk * 0.9, tal))
            .ao(1 - 0.35 * sstep(0.5, 1.9, y)).emissive(0, 0);
          DI[q] = b.vertex(x, y, z, GN[o], GN[o + 1], GN[o + 2]);
        }
        b.quad(DI[a], DI[c], DI[e], DI[d]);
      }
    }
    yield;

    // --- cave floor, wall to wall: covers the road (flat, under 5 cm) so no daylight reaches
    // it inside; rises into a rubbly fillet at each wall foot. Dark earth, trodden lighter
    // along the road, ash by the hearths, ochre spills, snow and frozen gravel at the mouths.
    {
      const NXF = 36, NZF = 89, X0 = -14, X1 = 14, // columns at x = +-6 exactly
        Z0 = -(LT + 1), Z1 = LT + 1;
      const hf = floorH;
      for (let j = 0; j < NZF; j++) for (let i = 0; i < NXF; i++) {
        const x = mix(X0, X1, i / (NXF - 1)), z = mix(Z0, Z1, j / (NZF - 1)), o = (j * NXF + i) * 3;
        GP[o] = x; GP[o + 1] = hf(x, z); GP[o + 2] = z;
        const e = 0.25;
        const gx = hf(x + e, z) - hf(x - e, z), gz = hf(x, z + e) - hf(x, z - e);
        const l = Math.hypot(gx / (2 * e), 1, gz / (2 * e));
        GN[o] = -gx / (2 * e) / l; GN[o + 1] = 1 / l; GN[o + 2] = -gz / (2 * e) / l;
      }
      yield;
      b.surface(SURF.CAVE_EARTH);
      yield* emitGrid(b, NXF, NZF, (x, y, z, nx, ny, nz) => {
        const ax = Math.abs(x), day = dayAt(z);
        const v = 0.86 + 0.28 * noise3(x * 0.6, 0, z * 0.6);
        let r = 0.2 * v, g = 0.155 * v, bb = 0.115 * v;
        // trodden path carrying the road through: pale packed earth and grit, ragged edge,
        // two worn lanes a little lighter still
        const path = 1 - sstep(3.0, 5.0, ax + 0.7 * sn(x * 0.4, 2, z * 0.3));
        const lane = Math.exp(-(((ax - 1.0) / 0.5) ** 2)) * 0.12;
        r = mix(r, (0.36 + lane) * v, path); g = mix(g, (0.31 + lane) * v, path); bb = mix(bb, (0.25 + lane * 0.8) * v, path);
        const grav = sstep(0.62, 0.8, noise3(x * 1.1, 5, z * 1.1)) * (1 - path * 0.5); // stones, gravel
        r = mix(r, 0.24, grav * 0.5); g = mix(g, 0.21, grav * 0.5); bb = mix(bb, 0.17, grav * 0.5);
        for (let i = 0; i < 2; i++) { // ash and charcoal round the hearths
          const d = Math.hypot(x - (i ? fxL : fxR), z - (i ? ZL : ZR));
          const ash = Math.exp(-d * d / 6);
          r = mix(r, 0.08, ash); g = mix(g, 0.075, ash); bb = mix(bb, 0.07, ash);
        }
        const och = sstep(0.72, 0.85, noise3(x * 0.8, 3, z * 0.8)) * sstep(6, 7, ax);
        r = mix(r, 0.26, och * 0.6); g = mix(g, 0.08, och * 0.6); bb = mix(bb, 0.03, och * 0.6);
        // mouths: frozen gravel on the road, snow drifted in at the sides
        const out = sstep(0.25, 0.85, day);
        r = mix(r, SOIL[0], out * path); g = mix(g, SOIL[1], out * path); bb = mix(bb, SOIL[2], out * path);
        const snow = (1 - path) * sstep(0.25, 0.65, day) * sstep(0.35, 0.65, noise3(x * 0.4, 1, z * 0.4) + day * 0.45);
        M.r = mix(r, 0.72, snow); M.g = mix(g, 0.76, snow); M.b = mix(bb, 0.82, snow);
        // cool mid ambient over the path, darker toward the walls (not a black void)
        M.ao = mix(mix(0.5, 0.2, sstep(4.5, 9, ax)), 1, day * day);
        finishLight(x, y, z, nx, ny, nz, day);
        // warm pools of firelight spread across the floor round each hearth
        for (let i = 0; i < 2; i++) {
          const d2 = (x - (i ? fxL : fxR)) ** 2 + (z - (i ? ZL : ZR)) ** 2;
          const k = 0.11 * Math.exp(-d2 / 70) * (1 - day);
          if (k > M.e) { M.e = k; M.src = i ? FLICKER.LIGHT1 : FLICKER.LIGHT0; }
          const w = k / 0.11; // the pool is fire-coloured (emission = albedo x e)
          M.g *= 1 - 0.22 * w; M.b *= 1 - 0.5 * w;
        }
      });
    }
    b.emissive(0, 0);
    yield;

    // --- paintings: each emerges through the rock at its tier. They take the wall's own surface
    // (CAVE_STONE: same rock grain per fragment, same sun occlusion and firelight), so pigment
    // reads as stained rock rather than a card in front of it
    b.surface(SURF.CAVE_STONE);
    let np = 0;
    for (let i = 0; i < nFig; i++) {
      if (FIG[i * 8 + 7] >= built) continue;
      paintFigure(b, i);
      if (++np % 3 === 0) yield;
    }
    b.timeless();
    yield;

    // --- hearths, lamps, painters, floor clutter
    RS[0] = (seed * 7919 + 13) >>> 0 || 3;
    hearth(b, fxR, floorH(fxR, ZR) - 0.02, ZR, 1.0, 1, 1);
    hearth(b, fxL, floorH(fxL, ZL) - 0.02, ZL, 1.0, 2, 1);
    for (let i = firstLamp; i < nSrc; i++) {
      const o = i * 6, sd = SRC[o] > 0 ? 1 : -1;
      // lit when the first figure it serves is begun
      let t = 1;
      for (let f = 0; f < nFig; f++) { const g = f * 8; if (FIG[g] === sd && Math.abs(FIG[g + 1] - SRC[o + 2]) < 3.5) t = Math.min(t, figStart(f) - 0.03); }
      b.timeless().appear(Math.max(0, t), Math.max(0, t) + 0.03, MOTION.FADE, 0, BY.BUILT);
      lamp(b, SRC[o], floorH(SRC[o], SRC[o + 2]) - 0.02, SRC[o + 2]);
    }
    // the painters come in (fading in) before their walls are begun
    b.timeless().appear(0.0, 0.05, MOTION.FADE, 0, BY.BUILT);
    if (pA) painter(b, pxA, zA, -HP, seed + 1);
    b.timeless().appear(0.24, 0.3, MOTION.FADE, 0, BY.BUILT);
    if (pB) painter(b, pxB, zB, HP, seed + 2);
    b.timeless().appear(0.0, 0.05, MOTION.FADE, 0, BY.BUILT);
    // pigment stones and a grinding slab by the first painter
    if (pA) {
      const gx = pxA - 0.15, gz = zA + 1.4;
      b.surface(SURF.STONE).color(0.22, 0.2, 0.17).ao(0.5).emissive(0, 0);
      const gy = floorH(gx, gz);
      b.push(); b.translate(gx, gy + 0.05, gz); b.rock(0.35, 0.1, 0.25, 2, 0.2, 5, 2, 0.6); b.pop();
      b.color(0.32, 0.06, 0.02); b.push(); b.translate(gx - 0.1, gy + 0.17, gz - 0.05); b.rock(0.08, 0.06, 0.07, 1, 0.3, 6, 0, 0.5); b.pop();
      b.color(0.44, 0.26, 0.05); b.push(); b.translate(gx + 0.15, gy + 0.17, gz + 0.1); b.rock(0.07, 0.05, 0.06, 1, 0.3, 7, 0, 0.5); b.pop();
      b.color(0.03, 0.025, 0.02); b.push(); b.translate(gx + 0.05, gy + 0.16, gz - 0.2); b.rock(0.06, 0.04, 0.05, 1, 0.3, 8, 0, 0.5); b.pop();
    }
    b.timeless();
    // stones and bones along the wall foot
    for (let i = 0; i < 60; i++) {
      const sd = i & 1 ? 1 : -1, z = (rng() * 2 - 1) * (LT - 3);
      const x = sd * (6.95 + rng() * Math.max(0.1, wallFoot(sd, z) - 7.4));
      const day = dayAt(z), fy = floorH(x, z);
      if (i % 6 === 0) { // bone
        b.surface(SURF.PLAIN).color(0.42, 0.38, 0.3).ao(0.02 + 0.8 * day).emissive(0, 0);
        const a = rng() * PI, l = 0.25 + rng() * 0.3;
        b.beam(x - Math.cos(a) * l, fy + 0.03, z - Math.sin(a) * l, x + Math.cos(a) * l, fy + 0.03, z + Math.sin(a) * l, 0.035, 0.03, 5, true);
      } else {
        wallMat(x, 0.2, z, 0, 1, 0); M.r *= 0.8; M.g *= 0.8; M.b *= 0.8;
        b.surface(SURF.STONE); applyM(b);
        const rr = 0.12 + rng() * 0.3;
        b.push(); b.translate(x, fy + rr * 0.2, z); b.rock(rr, rr * 0.6, rr * 0.8, 2, 0.25, i + 40, 3, 0.5); b.pop();
      }
    }
    b.emissive(0, 0);
    yield;

    // --- stalactites on the vault: fewer, stouter, none near the mouths
    b.surface(SURF.STONE);
    for (let i = 0; i < 42; i++) {
      const phi = HP + (b.rand() - 0.5) * 1.6, z = (b.rand() * 2 - 1) * (LT - 9);
      inner(phi, z, T0);
      let len = 0.5 + Math.pow(b.rand(), 2) * 2.0;
      if (Math.abs(T0[0]) < CLEAR_X + 0.3) len = Math.min(len, T0[1] - 6.6);
      if (len < 0.3) continue;
      wallMat(T0[0], T0[1] - len * 0.5, T0[2], 0, -0.3, 0);
      applyM(b);
      hanging(b, T0[0], T0[1] + 0.05, T0[2], len, 0.16 + len * 0.13, 7);
    }
    yield;

    // --- icicles under the roof lip at both mouths (few, thick, tapered)
    b.surface(SURF.PLAIN).ao(1);
    for (let end = 0; end < 2; end++) {
      const sg = end ? -1 : 1;
      for (let i = 0; i < 16; i++) {
        const phi = HP + (i / 15 - 0.5) * 1.9 + (b.rand() - 0.5) * 0.05;
        if (noise3(phi * 3, end * 3, 1.1) < 0.42) continue;
        const lz = lipZ(phi, end);
        inner(phi, sg * (lz - 0.35), T0);
        if (T0[1] < 3) continue;
        const nc = 1 + (b.rand() * 2 | 0);
        for (let c = 0; c < nc; c++) {
          let len = 0.45 + Math.pow(b.rand(), 1.6) * 1.2;
          const x = T0[0] + (b.rand() - 0.5) * 0.4, z = T0[2] - sg * b.rand() * 0.3;
          if (Math.abs(x) < CLEAR_X + 0.3) len = Math.min(len, T0[1] - 6.15);
          if (len < 0.3) continue;
          const ice = 0.5 + 0.1 * b.rand();
          b.color(ice * 0.82, ice * 0.9, ice).emissive(0.01, 0);
          hanging(b, x, T0[1] + 0.25, z, len + 0.25, 0.09 + len * 0.06, 7);
        }
      }
    }
    b.emissive(0, 0);
    yield;

    // --- fallen blocks clustered at the foot of each mouth, half buried in snow
    for (let end = 0; end < 2; end++) {
      const sg = end ? -1 : 1;
      for (let i = 0; i < 9; i++) {
        const sd = (i + end) % 2 ? 1 : -1;
        const rr = 0.6 + Math.pow(b.rand(), 1.4) * 2.2;
        const x = sd * (6.4 + rr * 1.1 + b.rand() * (i < 4 ? 2.5 : 9));
        const z = sg * (LT + 1.5 + b.rand() * (i < 4 ? 4 : 13));
        const ya = Math.max(0, apron(x, z));
        boulder(b, x, ya + rr * 0.15, z, rr * (1 + b.rand() * 0.5), rr * 0.75, rr * (0.8 + b.rand() * 0.4), seed * 13 + i + end * 20, true);
      }
    }
    for (let i = 0; i < 6; i++) {
      const sd = i % 2 ? 1 : -1, rr = 0.35 + b.rand() * 0.5;
      const z = (b.rand() * 2 - 1) * (LT - 6);
      if (Math.abs(z - (sd > 0 ? ZR : ZL)) < 6) continue;
      const x = sd * Math.max(6.3 + rr * 1.3, wallFoot(sd, z) - rr * 0.6);
      boulder(b, x, rr * 0.3, z, rr * 1.3, rr * 0.7, rr, seed * 7 + i + 50, false);
    }
    // detached limestone blocks and a pinnacle around the outcrop (a broken skyline)
    for (let i = 0; i < 6; i++) {
      const a = 0.35 + i * 1.03 + 0.2 * b.rand(); // around, never on the road ends
      const ca = Math.cos(a), sa = Math.sin(a);
      if (Math.abs(sa) > 0.82) continue; // keep the road approaches open
      const rr = 3.5 + 3 * b.rand(), tall = i % 3 === 0 ? 1.35 : 0.9;
      const dist = 47 + 6 * b.rand();
      const x = ca * dist, z = sa * dist * 0.9;
      if (Math.hypot(x, z) + rr > 64) continue;
      boulder(b, x, Math.max(0, apron(x, z)) + rr * tall * 0.3, z, rr * 1.1, rr * tall, rr * 0.8, seed * 31 + i + 70, true, 1);
    }
    yield;

    // --- flank camps: on each side of the outcrop, against its foot behind a fallen block,
    // a small fire with a hide tent and a figure, so the flanks seen while driving alongside
    // carry a warm point of life (no point light: emissive flames, coals and baked ember glow)
    {
      RS[0] = (seed * 7919 + 3) >>> 0 || 9;
      b.timeless().appear(0.3, 0.36, MOTION.RISE, 3, BY.BUILT);
      for (let sd = 1; sd >= -1; sd -= 2) {
        const zc = sd * 3.5;
        hill(sd > 0 ? 0.04 : PI - 0.04, zc, T0);
        const fx = T0[0] + sd * 5.5;
        const fy = Math.max(0, apron(fx, zc));
        boulder(b, fx + sd * 0.4, fy + 1.3, zc + sd * 4.4, 2.4, 2.1, 1.9, seed * 17 + (sd > 0 ? 3 : 5), true, 1);
        hearth(b, fx, fy + 0.02, zc, 1.4, 0, 1);
        tent(b, fx + sd * 1.0, Math.max(0, apron(fx + sd * 1.0, zc - sd * 4.6)), zc - sd * 4.6, 1.7, 2.8, sd > 0 ? 0.4 : 0.4 + PI);
        b.ao(0.8).emissive(0, 0);
        b.push(); b.at(fx + sd * 1.5, fy, zc + sd * 1.1, sd > 0 ? -2.2 : 0.9); person(b, POSE.KNEEL, seed + 31 + sd, 0.12, 0.08, 0.05); b.pop();
        b.push(); b.at(fx - sd * 0.4, fy, zc + sd * 2.0, sd > 0 ? 2.9 : -0.2); person(b, POSE.STAND, seed + 37 + sd, 0.11, 0.075, 0.05); b.pop();
      }
      b.timeless();
    }
    yield;

    // --- camps at the mouths (both ends: either road direction approaches one)
    if (built >= 0.55) {
      RS[0] = (seed * 104729 + 7) >>> 0 || 5;
      b.timeless().appear(0.55, 0.6, MOTION.RISE, 3, BY.BUILT);
      camp(b, 0, built, seed);
      b.timeless().appear(0.7, 0.75, MOTION.RISE, 3, BY.BUILT);
      if (built >= 0.7) camp(b, 1, built, seed + 11);
      b.timeless();
    }
    return b.counts();
  },
};
