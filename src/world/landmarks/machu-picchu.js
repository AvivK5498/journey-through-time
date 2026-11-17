// Machu Picchu (event 12, mountains, far landmass, ~1450): the Inca royal estate on its ridge
// saddle, with the steep sugarloaf of Huayna Picchu behind it (away from the road, +x).
//
// Terrain: build() has no access to the game's ground and the pad is flat, so the hill, the
// ridge and the peak are sculpted here (as great-wall.js does): a height field coloured like
// the mountain biome's meadow, cloud forest and blue-grey granite, whose flanks run below
// y = 0 to meet the real ground and fade to -25 m toward the radius.
//
// The city stands on a plateau (an ellipse round C, long axis along the ridge toward the
// peak). Fourteen stepped terraces (green treads, grey retaining walls) fall from it toward
// the road and both sides; in the wedge toward the peak the ridge runs on to a saddle and the
// peak. Terrace geometry is laid in "contour" coordinates (rho, theta) round C; the hill
// under them is the cone through the risers' feet, so the terraces rise out of a bare slope.
//
// built (clock 160-168): terraces rise bottom-up (0.02-0.3), plateau last of them; the
// Intihuatana's stepped hill 0.2-0.4, its carved stone 0.45; house platforms then walls rise
// (CLIP, 0.3-0.75), gables, the curved Temple of the Sun wall 0.36-0.5; thatch last
// (0.78-0.99); llamas and a few figures from 0.35-0.45.
// decay (0 -> 0.6 over clock 176-215, abandoned): people leave (0.02-0.1), most llamas go;
// thatch roofs sink in one by one (0.03-0.3), some gables fall; treads, plaza and slopes
// darken to scrub and cloud forest (MORPH colour, 0.04-0.6); shrubs and trees grow out of
// the terraces, the houses and the plaza (0.08-0.58): the ruin as it was found.
// Mist wisps (FX) drift across the peak throughout.

import { SURF, POSE, FLICKER, MOTION, BY, fbm3 } from './kit.js';

const CLIP = MOTION.CLIP, RISE = MOTION.RISE, POP = MOTION.POP, SCALE = MOTION.SCALE, GROW = MOTION.GROW, MORPH = MOTION.MORPH;

// ---- layout
const CX = 30, CZ = -70, SX = 1.35; // city centre; the plateau ellipse is SX longer along x
const R0 = 38, Y0 = 46; // plateau contour radius and height
const N = 16, HS = 2.6, TW = 4.2; // terraces: count, step height, tread width (contour units)
const RN = R0 + N * TW;
const SINK = 1.0; // hill under the terraces sits this far below the risers' feet
const PX = 200, PZ = -80, PH = 168, PR = 48; // Huayna Picchu
const QX = 176, QZ = -136, QH = 96, QR = 34; // its lower neighbour
const RAD = 300;

function hsh(a, b) { const s = Math.sin(a * 127.1 + b * 311.7 + 0.5) * 43758.5453; return s - Math.floor(s); }
function ss(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function smax(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; }
function wob(t) { return 0.06 * Math.sin(2 * t + 0.7) + 0.035 * Math.sin(5 * t + 1.9) + 0.018 * Math.sin(9 * t + 0.3); }
function yk(k) { return Y0 - k * HS; }
// contour radius of riser k + 1 (k = 0: the plateau edge)
function Rk(k, t) { return R0 + k * TW + 0.7 * Math.sin(3 * t + k * 1.3); }
const O = new Float64Array(4);
function pt(rho, t) { const s = rho * (1 + wob(t)); O[0] = CX + SX * s * Math.cos(t); O[1] = CZ + s * Math.sin(t); }
function rhoAt(x, z) {
  const u = (x - CX) / SX, v = z - CZ, t = Math.atan2(v, u);
  O[2] = t < 0 ? t + Math.PI * 2 : t;
  return Math.hypot(u, v) / (1 + wob(t));
}
// angular range of terrace level k (theta from +x, the peak side, 0..2pi)
function a0k(k) { return k > 9 ? Math.PI - 0.75 - 0.5 * hsh(k, 1) + 0.04 * (k - 9) : 0.6 + 0.22 * hsh(k, 1); }
function a1k(k) { return k > 9 ? Math.PI + 0.8 + 0.5 * hsh(k, 2) - 0.04 * (k - 9) : Math.PI * 2 - 0.62 - 0.22 * hsh(k, 2); }

// ---- the sculpted hill, ridge and peaks
function hillAt(x, z) {
  const rho = rhoAt(x, z);
  let h = Math.min(Y0 - HS - SINK, Y0 - HS - SINK - (rho - R0) * HS / TW);
  if (rho > RN + 2) h -= (rho - RN - 2) * 0.55;
  { // where a level has no terraces the hillside is left natural: rougher and fuller
    const k = Math.min(N, Math.max(1, Math.ceil((rho - R0) / TW))), t = O[2];
    const out = Math.max(a0k(k) - t, t - a1k(k), 0);
    const w = ss(0.04, 0.3, out) * ss(R0, R0 + 6, rho);
    h += w * (3 + 16 * (fbm3(x / 30, 5.1, z / 30, 2) - 0.25));
  }
  if (x > CX) { // the ridge on to the saddle
    const dz = Math.abs(z - CZ + 0.08 * (x - CX));
    let r = Y0 - 0.8 - 17 * ss(CX + 45, 140, x) - 0.8 * dz - 0.004 * dz * dz;
    if (rho < R0 + 1.5) r = Math.min(r, Y0 - 0.8);
    h = smax(h, r, 3);
  }
  const n = fbm3(x / 70, 2.3, z / 70, 3) - 0.5;
  const dp = Math.hypot(x - PX, (z - PZ) * 1.12);
  const n2 = fbm3(x / 22, 9.3, z / 22, 3) - 0.5;
  const pk = PH * Math.exp(-Math.pow(dp / PR, 2.6)) * (1 + 0.22 * n + 0.12 * n2);
  const dq = Math.hypot(x - QX, z - QZ);
  const qk = QH * Math.exp(-Math.pow(dq / QR, 2.2)) * (1 + 0.25 * n);
  h = smax(h, smax(pk, qk, 8) - 3, 6);
  h += n * 16 * ss(RN + 2, RN + 30, rho);
  const r = Math.hypot(x, z);
  h += (-25 - h) * ss(238, 288, r);
  return h > 0 ? h : Math.max(-40, h * 1.6);
}
const GX0 = -130, GZ0 = -240, CELL = 5, NXC = 85, NZC = 61, GW = NXC + 1;
const HG = new Float32Array(GW * (NZC + 1));
let HREADY = false;
function ensureGrid() {
  if (HREADY) return;
  for (let j = 0; j <= NZC; j++) for (let i = 0; i <= NXC; i++) HG[j * GW + i] = hillAt(GX0 + i * CELL, GZ0 + j * CELL);
  HREADY = true;
}

// ---- palette (linear)
const TREAD = [0.13, 0.2, 0.052], TREAD_D = [0.04, 0.065, 0.024]; // cultivated green -> scrub
const WALL = [0.25, 0.24, 0.22], WALL_D = [0.17, 0.18, 0.14]; // granite retaining walls -> moss
const STONE = [0.27, 0.26, 0.24]; // house walls
const THATCH = [0.33, 0.24, 0.1];
const DARK = [0.03, 0.026, 0.024];
const HX = new Float64Array(24);
function hx8(x0, y0, z0, x1, z1, tx0, ty, tz0, tx1, tz1) {
  const P = HX;
  P[0] = x0; P[1] = y0; P[2] = z0; P[3] = x1; P[4] = y0; P[5] = z0; P[6] = x1; P[7] = y0; P[8] = z1; P[9] = x0; P[10] = y0; P[11] = z1;
  P[12] = tx0; P[13] = ty; P[14] = tz0; P[15] = tx1; P[16] = ty; P[17] = tz0; P[18] = tx1; P[19] = ty; P[20] = tz1; P[21] = tx0; P[22] = ty; P[23] = tz1;
}
// trapezoidal opening (doorway, window, niche) on a face z = zf facing dir (+1/-1): dark panel
function trap(b, x, y0, zf, dir, wb, wt, h) {
  b.color(DARK[0], DARK[1], DARK[2]);
  const z0 = zf, z1 = zf + dir * 0.05;
  hx8(x - wb, y0, Math.min(z0, z1), x + wb, Math.max(z0, z1), x - wt, y0 + h, Math.min(z0, z1), x + wt, Math.max(z0, z1));
  b.hexa(HX, false);
}

// ---- terraces: level k = tread k (y_k, from Rk(k-1) out to Rk(k)) + riser k+1 + end caps
function level(b, k, tk) {
  const a0 = a0k(k), a1 = a1k(k);
  const rm = Rk(k, 0);
  const M = Math.max(10, Math.ceil((a1 - a0) * rm * 1.15 / 4.5));
  const y = yk(k), yb = (k === N ? -1.5 : yk(k + 1) - 1.6);
  const g = 0.9 + 0.18 * hsh(k, 3);
  b.timeless().reach(HS + 1.4).appear(tk, tk + 0.06, RISE, 0, BY.BUILT).vanish(0.04 + 0.1 * hsh(k, 4), 0.6, MORPH, 0, BY.DECAY);
  // tread
  b.surface(SURF.EARTH).ao(1);
  let base = b.nv;
  for (let i = 0; i <= M; i++) {
    const t = a0 + (a1 - a0) * i / M, c = g * (0.92 + 0.16 * hsh(k * 31 + i, 5));
    for (let e = 0; e < 2; e++) {
      pt(Rk(k - 1 + e, t), t);
      b.color(TREAD[0] * c, TREAD[1] * c, TREAD[2] * c).morph(y, y, TREAD_D[0] * c, TREAD_D[1] * c, TREAD_D[2] * c);
      b.vertex(O[0], y, O[1], 0, 1, 0);
    }
  }
  for (let i = 0; i < M; i++) { const a = base + i * 2; b.quad(a, a + 1, a + 3, a + 2); }
  // riser
  b.surface(SURF.STONE).ao(0.95);
  base = b.nv;
  for (let i = 0; i <= M; i++) {
    const t = a0 + (a1 - a0) * i / M, r = Rk(k, t);
    pt(r, t + 0.002); const fx = O[0], fz = O[1];
    pt(r, t - 0.002); let nx = fz - O[1], nz = -(fx - O[0]);
    pt(r, t);
    if (nx * (O[0] - CX) + nz * (O[1] - CZ) < 0) { nx = -nx; nz = -nz; }
    const c = 0.9 + 0.2 * hsh(k * 17 + i, 6), tx = O[0], tz = O[1];
    const nl = Math.hypot(nx, nz) || 1, bx = nx / nl * 0.35, bz = nz / nl * 0.35; // batter: foot 0.35 m out
    b.color(WALL[0] * c * 0.7, WALL[1] * c * 0.7, WALL[2] * c * 0.7).morph(yb, yb, WALL_D[0] * 0.7, WALL_D[1] * 0.7, WALL_D[2] * 0.7);
    b.vertex(tx + bx * (y - yb) / HS, yb, tz + bz * (y - yb) / HS, nx, 0.14 * nl, nz);
    b.color(WALL[0] * c, WALL[1] * c, WALL[2] * c).morph(y - 0.6, y - 0.6, WALL_D[0] * c, WALL_D[1] * c, WALL_D[2] * c);
    b.vertex(tx + bx * 0.6 / HS, y - 0.6, tz + bz * 0.6 / HS, nx, 0.14 * nl, nz);
    b.color(TREAD[0] * 0.85, TREAD[1] * 0.85, TREAD[2] * 0.85).morph(y, y, TREAD_D[0], TREAD_D[1], TREAD_D[2]);
    b.vertex(tx, y, tz, nx, 0.8 * nl, nz);
  }
  for (let i = 0; i < M; i++) { const a = base + i * 3; b.quad(a, a + 1, a + 4, a + 3); b.quad(a + 1, a + 2, a + 5, a + 4); }
  // end caps: the cut through the terrace fill at each end
  for (let e = 0; e < 2; e++) {
    const t = e ? a1 : a0;
    pt(Rk(k, t), t + 0.002); const fx = O[0], fz = O[1];
    pt(Rk(k, t), t - 0.002); let tx = fx - O[0], tz = fz - O[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l; if (!e) { tx = -tx; tz = -tz; }
    b.color(WALL[0] * 0.85, WALL[1] * 0.85, WALL[2] * 0.85).morph(y, y, WALL_D[0], WALL_D[1], WALL_D[2]);
    pt(Rk(k - 1, t), t); const ix = O[0], iz = O[1];
    pt(Rk(k, t), t); const ox = O[0], oz = O[1];
    const v0 = b.vertex(ix, y, iz, tx, 0, tz), v1 = b.vertex(ox, y, oz, tx, 0, tz);
    b.morph(yb, yb, WALL_D[0], WALL_D[1], WALL_D[2]);
    const v2 = b.vertex(ox, yb, oz, tx, 0, tz);
    b.morph(y - SINK - 0.4, y - SINK - 0.4, WALL_D[0], WALL_D[1], WALL_D[2]);
    const v3 = b.vertex(ix, y - SINK - 0.4, iz, tx, 0, tz);
    b.quad(v0, v1, v2, v3);
  }
}
// a flight of steps climbing riser k (from tread k up to tread k - 1) at angle t
function stairs(b, k, t) {
  const r = Rk(k - 1, t);
  pt(r, t + 0.002); const fx = O[0], fz = O[1];
  pt(r, t - 0.002); let nx = fz - O[1], nz = -(fx - O[0]);
  pt(r, t);
  if (nx * (O[0] - CX) + nz * (O[1] - CZ) < 0) { nx = -nx; nz = -nz; }
  b.push(); b.at(O[0], yk(k), O[1], Math.atan2(nx, nz));
  b.color(0.36, 0.345, 0.32).surface(SURF.STONE).ao(0.95);
  for (let j = 0; j < 4; j++) {
    const top = (j + 1) * HS / 4, d = (4 - j) * 0.42;
    b.box(0, top * 0.5 - 0.3, d * 0.5 - 0.4, 0.75, top * 0.5 + 0.3, d * 0.5 + 0.4, false);
  }
  b.pop();
}

// ---- buildings
function house(b, x, z, L, W, base, dir, t0, tr, td, gableFalls, seed) {
  const H = 2.9, G = 0.5 * W * 1.6, T = 0.65;
  b.push(); b.at(x, base, z, 0);
  b.timeless().pivot(0, 0, 0).reach(H + 0.05).appear(t0, t0 + 0.1, CLIP, 0, BY.BUILT);
  const c = 0.9 + 0.2 * hsh(seed, 9);
  b.color(STONE[0] * c, STONE[1] * c, STONE[2] * c).surface(SURF.STONE).ao(0.95);
  b.box(0, H * 0.5, W * 0.5 - T * 0.5, L * 0.5, H * 0.5, T * 0.5, false);
  b.box(0, H * 0.5, -W * 0.5 + T * 0.5, L * 0.5, H * 0.5, T * 0.5, false);
  b.box(L * 0.5 - T * 0.5, H * 0.5, 0, T * 0.5, H * 0.5, W * 0.5 - T, false);
  b.box(-L * 0.5 + T * 0.5, H * 0.5, 0, T * 0.5, H * 0.5, W * 0.5 - T, false);
  b.color(0.13, 0.1, 0.07).surface(SURF.EARTH).ao(0.6); // earthen floor
  b.box(0, 0.03, 0, L * 0.5 - T, 0.03, W * 0.5 - T, false);
  // trapezoidal doorway toward the plaza (both faces), windows and niches
  b.surface(SURF.PLAIN).ao(0.4);
  const fz = dir * W * 0.5, iz = dir * (W * 0.5 - T);
  trap(b, 0, 0, fz, dir, 0.55, 0.4, 2.0); trap(b, 0, 0, iz, -dir, 0.55, 0.4, 2.0);
  trap(b, -L * 0.28, 1.3, -fz, -dir, 0.3, 0.22, 0.75); trap(b, L * 0.28, 1.3, -fz, -dir, 0.3, 0.22, 0.75);
  trap(b, -L * 0.3, 1.1, -iz, dir, 0.25, 0.18, 0.6); trap(b, L * 0.3, 1.1, -iz, dir, 0.25, 0.18, 0.6);
  // stone gables
  b.timeless().pivot(0, H, 0).reach(G + 0.05).appear(t0 + 0.1, t0 + 0.14, CLIP, 0, BY.BUILT);
  if (gableFalls) b.vanish(td + 0.04, td + 0.1, RISE, G + 0.2, BY.DECAY);
  b.color(STONE[0] * c, STONE[1] * c, STONE[2] * c).surface(SURF.STONE).ao(1);
  for (let e = -1; e <= 1; e += 2) {
    const x0 = e * (L * 0.5 - T), x1 = e * L * 0.5;
    hx8(Math.min(x0, x1), H, -W * 0.5, Math.max(x0, x1), W * 0.5, Math.min(x0, x1), H + G, -0.001, Math.max(x0, x1), 0.001);
    b.hexa(HX, false);
  }
  // steep thatch: two slabs from the ridge to the eaves, then the ridge
  b.timeless().pivot(0, H, 0).reach(G + 2).appear(tr, tr + 0.05, GROW, 0, BY.BUILT).vanish(td, td + 0.08, RISE, G + 2, BY.DECAY);
  const k = 0.88 + 0.2 * hsh(seed, 10);
  b.color(THATCH[0] * k, THATCH[1] * k, THATCH[2] * k).surface(SURF.THATCH).ao(1);
  const ex = L * 0.5 + 0.45, ez = W * 0.5 + 0.7, ey = H - 0.55, ry = H + G + 0.35;
  for (let e = -1; e <= 1; e += 2) {
    const P = HX;
    // bottom ring: underside, top ring: 0.35 m above
    P[0] = -ex; P[1] = ey; P[2] = e * ez; P[3] = ex; P[4] = ey; P[5] = e * ez; P[6] = ex; P[7] = ry - 0.35; P[8] = 0; P[9] = -ex; P[10] = ry - 0.35; P[11] = 0;
    P[12] = -ex; P[13] = ey + 0.35; P[14] = e * (ez + 0.05); P[15] = ex; P[16] = ey + 0.35; P[17] = e * (ez + 0.05); P[18] = ex; P[19] = ry; P[20] = 0; P[21] = -ex; P[22] = ry; P[23] = 0;
    b.hexa(HX, true);
  }
  b.pop();
}

function figure(b, x, y, z, yaw, pose, sd, col) {
  b.color(col[0], col[1], col[2]).surface(SURF.HIDE).ao(1);
  b.push(); b.at(x, y, z, yaw); b.human(pose, 1.55 + 0.1 * hsh(sd, 1), sd); b.pop();
}
function llama(b, x, y, z, yaw, r, g, bl) {
  b.push(); b.at(x, y, z, yaw);
  b.color(r, g, bl).surface(SURF.HIDE).ao(1);
  b.push(); b.translate(0, 1.0, 0); b.ellipsoid(0.27, 0.3, 0.6, 2); b.pop();
  b.beam(0, 1.1, 0.42, 0, 1.78, 0.6, 0.13, 0.1, 5, false);
  b.push(); b.translate(0, 1.84, 0.7); b.ellipsoid(0.1, 0.12, 0.2, 2); b.pop();
  for (let e = -1; e <= 1; e += 2) b.beam(e * 0.05, 1.92, 0.64, e * 0.08, 2.1, 0.62, 0.03, 0.02, 3, false);
  for (let q = 0; q < 4; q++) {
    const sx = (q & 1 ? 1 : -1) * 0.15, sz = (q & 2 ? 1 : -1) * 0.4;
    b.beam(sx, 0.95, sz, sx, 0, sz + 0.02, 0.07, 0.05, 4, false);
  }
  b.beam(0, 1.1, -0.58, 0, 0.85, -0.7, 0.06, 0.04, 4, false);
  b.pop();
}
// shrub or tree growing in the decay
function growth(b, x, y, z, s, t0, tree) {
  b.timeless().pivot(x, y, z).appear(t0, Math.min(0.6, t0 + 0.12), SCALE, 0, BY.DECAY);
  const g = 0.75 + 0.5 * b.rand();
  if (tree) {
    b.color(0.1, 0.075, 0.05).surface(SURF.WOOD).ao(0.9);
    b.beam(x, y - 0.3, z, x, y + 3.2 * s, z, 0.16 * s, 0.1 * s, 5, false);
    b.color(0.04 * g, 0.075 * g, 0.028 * g).surface(SURF.THATCH).ao(1);
    b.push(); b.translate(x, y + 3.6 * s, z); b.rock(1.9 * s, 1.5 * s, 1.9 * s, 2, 0.25, (x * 7 + z * 3) | 0, 0, 0); b.pop();
  } else {
    b.color(0.05 * g, 0.085 * g, 0.03 * g).surface(SURF.THATCH).ao(0.9);
    b.push(); b.translate(x, y + 0.5 * s, z); b.rock(1.1 * s, 0.8 * s, 1.1 * s, 2, 0.3, (x * 5 + z * 11) | 0, 0, 0); b.pop();
  }
}

export default {
  id: 'machu-picchu',
  name: 'Machu Picchu',
  caption: 'The Inca build a city in the sky',
  year: 1450,
  radius: RAD,
  pad: 160,
  roadOffset: 166,
  straddlesRoad: false,
  biome: 'mountains',
  lights: [],
  approach: 750, cone: 0.55,
  wind: [0.3, -0.95],
  detail: { at: [CX - 20, Y0 + 3, CZ - 22], from: [CX - 52, Y0 + 16, CZ - 50] },
  strip: { at: [70, 55, CZ], from: [-260, 120, CZ + 170], fov: 0.7 },
  witness: { at: [CX + 40, CZ - 5], look: 72, dist: 400, height: 112, az: 0.3, fov: 0.6, drift: 0.07, range: 1500 },

  satellites: {
    count: [5, 7], near: 0, farR: [380, 1300],
    centre: 0.1, spread: 3.4, minSep: 200, roadClear: 60, visible: 1,
    build(b, k, n, dist) {
      // an outlying terraced hillside with a hut on top (Intipata, Winay Wayna)
      const s = 1 + dist / 650, tb = 0.05 + 0.3 * k / n;
      b.scale(s, s, s);
      for (let q = 0; q < 5; q++) {
        const r = 17 - q * 3.1, y0 = -2.5 + q * 2.4, y1 = y0 + 2.4;
        b.timeless().reach(3).appear(tb + q * 0.03, tb + q * 0.03 + 0.05, RISE, 0, BY.BUILT);
        b.color(WALL[0], WALL[1], WALL[2]).surface(SURF.STONE).ao(0.95);
        b.lathe([r, y0 - 0.5, r, y1], 16, { caps: false });
        b.color(TREAD[0], TREAD[1], TREAD[2]).surface(SURF.EARTH).ao(1);
        b.lathe([r, y1, r - 3.1, y1], 16, { caps: false });
      }
      const yt = -2.5 + 5 * 2.4;
      b.timeless().pivot(0, yt, 0).reach(2.5).appear(tb + 0.2, tb + 0.3, CLIP, 0, BY.BUILT);
      b.color(STONE[0], STONE[1], STONE[2]).surface(SURF.STONE).ao(0.95);
      b.push(); b.translate(0, yt, 0); b.block(2.6, 1.8, 2.6, 1.8, 2.4); b.pop();
      b.timeless().pivot(0, yt + 2.4, 0).appear(tb + 0.32, tb + 0.38, GROW, 0, BY.BUILT).vanish(0.05 + 0.2 * k / n, 0.12 + 0.2 * k / n, POP, 0, BY.DECAY);
      b.color(THATCH[0], THATCH[1], THATCH[2]).surface(SURF.THATCH).ao(1);
      hx8(-3.1, yt + 2.2, -2.3, 3.1, 2.3, -2.9, yt + 5.0, -0.05, 2.9, 0.05);
      b.hexa(HX, true);
      b.timeless();
    },
  },

  *build(b, built, decay, seed) {
    ensureGrid();
    yield;

    // ---- the sculpted hill, ridge and peaks
    const meadow = b.bio('ground'), turf = b.bio('groundAlt'), rock = b.bio('rock');
    b.timeless().surface(SURF.EARTH).ao(1).vanish(0.06, 0.6, MORPH, 0, BY.DECAY);
    const base = b.nv;
    for (let j = 0; j <= NZC; j++) {
      for (let i = 0; i <= NXC; i++) {
        let x = GX0 + i * CELL, z = GZ0 + j * CELL;
        const o = j * GW + i, y = HG[o];
        const gx = (HG[j * GW + Math.min(NXC, i + 1)] - HG[j * GW + Math.max(0, i - 1)]) / (2 * CELL);
        const gz = (HG[Math.min(NZC, j + 1) * GW + i] - HG[Math.max(0, j - 1) * GW + i]) / (2 * CELL);
        const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
        const n = fbm3(x / 35, 7.7, z / 35, 2);
        const steep = ss(0.5, 0.25, ny + 0.25 * (fbm3(x / 12, 3.3, y / 9, 2) - 0.5)), hi = ss(40, 140, y), far = ss(RN, RN + 30, rhoAt(x, z));
        // meadow low down, cloud forest on the high slopes, granite where steep
        const dry = Math.min(1, Math.max(0, 0.25 + 0.6 * (n - 0.5)));
        let r = meadow[0] + (turf[0] - meadow[0]) * dry, g = meadow[1] + (turf[1] - meadow[1]) * dry, bl = meadow[2] + (turf[2] - meadow[2]) * dry;
        const fo = Math.min(1, far * (0.55 + 0.45 * hi) + 0.3 * far * (n - 0.3));
        r += (0.05 - r) * fo; g += (0.088 - g) * fo; bl += (0.032 - bl) * fo;
        const rk = Math.min(0.6, steep * (0.5 + 0.6 * n)) * (1 - 0.5 * hi);
        r += (rock[0] - r) * rk; g += (rock[1] - g) * rk; bl += (rock[2] - bl) * rk;
        const sh = 0.8 + 0.2 * ss(-5, 30, y);
        b.color(r * sh, g * sh, bl * sh).ao(0.8 + 0.2 * ss(-2, 25, y));
        b.morph(y, y, (r + (0.045 - r) * (1 - rk) * 0.8) * sh, (g + (0.075 - g) * (1 - rk) * 0.8) * sh, (bl + (0.028 - bl) * (1 - rk) * 0.8) * sh);
        const rr = Math.hypot(x, z);
        if (rr > RAD - 1) { x *= (RAD - 1) / rr; z *= (RAD - 1) / rr; }
        b.vertex(x, y, z, -gx, 1, -gz);
      }
    }
    for (let j = 0; j < NZC; j++) {
      for (let i = 0; i < NXC; i++) {
        const o = j * GW + i;
        let ok = true;
        for (let q = 0; q < 4 && ok; q++) {
          const x = GX0 + (i + (q & 1)) * CELL, z = GZ0 + (j + (q >> 1)) * CELL;
          if (x * x + z * z > (RAD - 1) * (RAD - 1)) ok = false;
        }
        if (!ok || Math.max(HG[o], HG[o + 1], HG[o + GW], HG[o + GW + 1]) < 0.05) continue;
        b.quad(base + o, base + o + 1, base + o + GW + 1, base + o + GW);
      }
    }
    yield;

    // ---- terraces, bottom-up, then the plateau floor and its retaining wall
    for (let k = N; k >= 1; k--) level(b, k, 0.02 + 0.22 * (N - k) / N);
    const ST = [2.72, 3.75, 1.55];
    for (let k = 1; k <= N; k++) {
      for (let s = 0; s < ST.length; s++) {
        const t = ST[s];
        if (t < a0k(k) + 0.05 || t > a1k(k) - 0.05 || (s === 2 && k > 8)) continue;
        b.timeless().reach(HS + 1.4).appear(0.02 + 0.22 * (N - k + 1) / N, 0.08 + 0.22 * (N - k + 1) / N, RISE, 0, BY.BUILT);
        stairs(b, k, t);
      }
    }
    // plateau: floor (lawn in the plaza, packed earth among the houses) and riser 1 all round
    b.timeless().reach(HS + 1.4).appear(0.25, 0.3, RISE, 0, BY.BUILT).vanish(0.05, 0.6, MORPH, 0, BY.DECAY);
    b.surface(SURF.EARTH).ao(1);
    const MS = 72, RF = [0, 0.25, 0.45, 0.62, 0.76, 0.88, 1];
    const fb = b.nv;
    for (let q = 0; q < RF.length; q++) {
      for (let i = 0; i < MS; i++) {
        const t = i / MS * Math.PI * 2;
        pt(Rk(0, t) * RF[q], t);
        const lawn = ss(14, 9, Math.abs(O[1] - CZ)) * ss(50, 40, Math.abs(O[0] - CX));
        const v = 0.92 + 0.14 * hsh(q * 97 + i, 7);
        const r = (0.16 + (0.14 - 0.16) * lawn) * v, g = (0.15 + (0.215 - 0.15) * lawn) * v, bl = (0.085 + (0.055 - 0.085) * lawn) * v;
        b.color(r, g, bl).morph(Y0, Y0, 0.06 * v, 0.09 * v, 0.032 * v);
        b.vertex(O[0], Y0, O[1], 0, 1, 0);
        if (q === 0) break;
      }
    }
    for (let i = 0; i < MS; i++) b.tri(fb, fb + 1 + i, fb + 1 + (i + 1) % MS);
    for (let q = 1; q < RF.length - 1; q++) {
      const r0 = fb + 1 + (q - 1) * MS, r1 = r0 + MS;
      for (let i = 0; i < MS; i++) { const i1 = (i + 1) % MS; b.quad(r0 + i, r0 + i1, r1 + i1, r1 + i); }
    }
    b.surface(SURF.STONE).ao(0.95);
    const wb = b.nv;
    for (let i = 0; i <= MS; i++) {
      const t = i / MS * Math.PI * 2;
      pt(Rk(0, t), t + 0.002); const fx = O[0], fz = O[1];
      pt(Rk(0, t), t - 0.002); let nx = fz - O[1], nz = -(fx - O[0]);
      pt(Rk(0, t), t);
      if (nx * (O[0] - CX) + nz * (O[1] - CZ) < 0) { nx = -nx; nz = -nz; }
      b.color(WALL[0] * 0.7, WALL[1] * 0.7, WALL[2] * 0.7).morph(yk(1) - 1.6, yk(1) - 1.6, WALL_D[0] * 0.7, WALL_D[1] * 0.7, WALL_D[2] * 0.7);
      b.vertex(O[0], yk(1) - 1.6, O[1], nx, 0, nz);
      b.color(WALL[0] * 1.05, WALL[1] * 1.05, WALL[2] * 1.05).morph(Y0, Y0, WALL_D[0], WALL_D[1], WALL_D[2]);
      b.vertex(O[0], Y0, O[1], nx, 0, nz);
    }
    for (let i = 0; i < MS; i++) { const a = wb + i * 2; b.quad(a, a + 1, a + 3, a + 2); }
    yield;

    // ---- the Intihuatana: a small pyramid of terraces with the carved stone on top
    const IX = CX + 30, IZ = CZ - 15;
    const TIER = [8.5, 6.6, 4.9, 3.4];
    for (let q = 0; q < 4; q++) {
      const y0 = Y0 - 0.4 + q * 1.9;
      b.timeless().reach(2.4).appear(0.2 + q * 0.04, 0.26 + q * 0.04, RISE, 0, BY.BUILT);
      b.color(WALL[0], WALL[1], WALL[2]).surface(SURF.STONE).ao(0.9);
      b.push(); b.translate(IX, y0, IZ); b.block(TIER[q], TIER[q], TIER[q] - 0.15, TIER[q] - 0.15, 2.3); b.pop();
      b.timeless().reach(2.4).appear(0.2 + q * 0.04, 0.26 + q * 0.04, RISE, 0, BY.BUILT).vanish(0.05, 0.6, MORPH, 0, BY.DECAY);
      b.surface(SURF.EARTH).ao(1);
      const yt = y0 + 2.32, e = TIER[q] - 0.15;
      b.color(TREAD[0], TREAD[1], TREAD[2]).morph(yt, yt, TREAD_D[0], TREAD_D[1], TREAD_D[2]);
      const v0 = b.vertex(IX - e, yt, IZ - e, 0, 1, 0), v1 = b.vertex(IX + e, yt, IZ - e, 0, 1, 0);
      const v2 = b.vertex(IX + e, yt, IZ + e, 0, 1, 0), v3 = b.vertex(IX - e, yt, IZ + e, 0, 1, 0);
      b.quad(v0, v1, v2, v3);
    }
    b.timeless().reach(2.4).appear(0.36, 0.4, RISE, 0, BY.BUILT);
    b.color(0.36, 0.345, 0.32).surface(SURF.STONE).ao(0.95);
    for (let q = 0; q < 4; q++) b.box(IX - TIER[q] - 0.7, Y0 + q * 1.9 + 0.5, IZ, 0.75, 0.95 + 0.3, 1.0, false);
    const top = Y0 - 0.4 + 4 * 1.9 + 0.02;
    b.timeless().pivot(IX, top, IZ).appear(0.44, 0.5, SCALE, 0, BY.BUILT);
    b.color(0.4, 0.385, 0.36).surface(SURF.POLISH).ao(1);
    b.push(); b.at(IX, top, IZ, 0.35);
    b.block(1.4, 0.8, 1.2, 0.65, 0.75);
    b.translate(0.25, 0.74, 0); b.block(0.24, 0.22, 0.18, 0.17, 0.75);
    b.pop();
    yield;

    // ---- the Temple of the Sun: curved wall of fine ashlar on its rock, conical thatch
    const TX = CX - 20, TZ = CZ - 22, TB = Y0 + 1.6;
    b.timeless();
    b.color(rock[0] * 1.3, rock[1] * 1.3, rock[2] * 1.3).surface(SURF.ROCK).ao(0.9);
    b.push(); b.translate(TX, Y0, TZ); b.rock(6.4, 2.2, 5.6, 4, 0.2, 31, 4, 0.6); b.pop();
    b.timeless().pivot(TX, TB - 0.2, TZ).reach(5.6).appear(0.36, 0.5, CLIP, 0, BY.BUILT);
    b.color(0.4, 0.38, 0.35).surface(SURF.POLISH).ao(1);
    const ta0 = 0.35 * Math.PI, ta1 = 1.75 * Math.PI;
    b.push(); b.translate(TX, TB - 0.2, TZ);
    b.lathe([4.6, 0, 4.45, 5.4], 22, { a0: ta0, a1: ta1, caps: false });
    b.lathe([3.75, 5.4, 3.9, 0], 22, { a0: ta0, a1: ta1, caps: false });
    b.lathe([4.45, 5.4, 3.75, 5.4], 22, { a0: ta0, a1: ta1, caps: false });
    const cx0 = Math.cos(ta0) * 4.2, sz0 = Math.sin(ta0) * 4.2, cx1 = Math.cos(ta1) * 4.2, sz1 = Math.sin(ta1) * 4.2;
    const chx = (cx0 + cx1) * 0.5, chz = (sz0 + sz1) * 0.5, chl = Math.hypot(cx1 - cx0, sz1 - sz0) * 0.5;
    b.push(); b.at(chx, 0, chz, Math.atan2(cx1 - cx0, sz1 - sz0)); b.box(0, 2.7, 0, 0.35, 2.7, chl + 0.2, false); b.pop();
    b.surface(SURF.PLAIN).ao(0.4);
    for (let w = 0; w < 2; w++) { // trapezoidal windows in the curve
      const a = Math.PI * (0.85 + 0.45 * w);
      b.push(); b.at(Math.cos(a) * 4.6, 0, Math.sin(a) * 4.6, Math.atan2(Math.cos(a), Math.sin(a)));
      trap(b, 0, 2.6, -0.06, 1, 0.38, 0.28, 0.9); b.pop();
    }
    b.pop();
    b.timeless().pivot(TX, TB + 5.2, TZ).reach(5).appear(0.8, 0.86, GROW, 0, BY.BUILT).vanish(0.1, 0.18, RISE, 5, BY.DECAY);
    b.color(THATCH[0], THATCH[1], THATCH[2]).surface(SURF.THATCH).ao(1);
    b.push(); b.translate(TX, TB + 4.7, TZ); b.lathe([5.3, 0, 0.1, 3.9], 18); b.pop();
    yield;

    // ---- houses on stepped platforms either side of the plaza
    const lots = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let row = 0; row < 3; row++) {
        const z = CZ + side * (15 + row * 8.2);
        for (let col = -5; col <= 5; col++) {
          const x = CX + col * 9.6 + (row & 1) * 3.2;
          if (hsh(col * 7 + row, side + 9) < 0.12) continue;
          if (Math.hypot(x - TX, z - TZ) < 10 || Math.hypot(x - IX, z - IZ) < 14) continue;
          const L = 6.6 + 1.6 * hsh(col, row + 20 + side), W = 4.3 + 0.7 * hsh(col + 40, row + side);
          let ok = true;
          for (let q = 0; q < 4 && ok; q++) {
            const px = x + (q & 1 ? 1 : -1) * (L * 0.5 + 0.7), pz = z + (q & 2 ? 1 : -1) * (W * 0.5 + 0.8);
            if (rhoAt(px, pz) > R0 - 2.5) ok = false;
          }
          if (ok) lots.push(x, z, L, W, row, side);
        }
      }
    }
    const NL = lots.length / 6;
    for (let l = 0; l < NL; l++) {
      const x = lots[l * 6], z = lots[l * 6 + 1], L = lots[l * 6 + 2], W = lots[l * 6 + 3], row = lots[l * 6 + 4], side = lots[l * 6 + 5];
      const ph = 0.35 + 0.95 * row + 0.5 * hsh(l, 30);
      const h0 = hsh(l, 31), t0 = 0.32 + 0.3 * h0 + 0.05 * row;
      // platform (retaining wall) under the house
      b.timeless().reach(ph + 0.8).appear(t0 - 0.06, t0, RISE, 0, BY.BUILT);
      b.color(WALL[0] * 0.95, WALL[1] * 0.95, WALL[2] * 0.95).surface(SURF.STONE).ao(0.9);
      b.push(); b.translate(x, Y0 - 0.5, z); b.block(L * 0.5 + 0.7, W * 0.5 + 0.8, L * 0.5 + 0.65, W * 0.5 + 0.75, ph + 0.5); b.pop();
      const tr = 0.78 + 0.18 * hsh(l, 32), td = 0.03 + 0.25 * hsh(l, 33);
      house(b, x, z, L, W, Y0 + ph, -side, t0, tr, td, hsh(l, 34) < 0.3, seed + l);
      // the ruin: a tree or shrub inside some of the roofless houses
      if (hsh(l, 35) < 0.45) growth(b, x + (hsh(l, 36) - 0.5) * L * 0.4, Y0 + ph + 0.05, z, 0.7 + 0.4 * hsh(l, 37), td + 0.1 + 0.15 * hsh(l, 38), hsh(l, 39) < 0.5);
    }
    yield;

    // ---- overgrowth on the terraces and round the plaza (decay)
    for (let q = 0; q < 170; q++) {
      const k = 1 + Math.floor(b.rand() * N), a0 = a0k(k), a1 = a1k(k);
      const t = a0 + 0.04 + (a1 - a0 - 0.08) * b.rand();
      pt((Rk(k - 1, t) + Rk(k, t)) * 0.5 + (b.rand() - 0.5) * 1.5, t);
      const tree = b.rand() < 0.35;
      growth(b, O[0], yk(k), O[1], tree ? 1.0 + 0.6 * b.rand() : 0.9 + 0.7 * b.rand(), 0.08 + 0.42 * b.rand(), tree);
    }
    for (let q = 0; q < 10; q++) {
      const x = CX + (b.rand() - 0.5) * 70, z = CZ + (b.rand() < 0.5 ? -1 : 1) * (6 + 4 * b.rand());
      growth(b, x, Y0, z, 0.7 + 0.5 * b.rand(), 0.2 + 0.35 * b.rand(), b.rand() < 0.4);
    }
    // ---- llamas (two stay with the ruin) and a few figures
    const LL = [CX - 8, CZ + 3, 0.4, CX + 4, CZ - 4, 2.6, CX + 14, CZ + 6, -1.9];
    for (let q = 0; q < 3; q++) {
      b.timeless().appear(0.35, 0.36, POP, 0, BY.BUILT);
      if (q !== 1) b.vanish(0.03 + 0.03 * q, 0.04 + 0.03 * q, POP, 0, BY.DECAY);
      const w = q === 1;
      llama(b, LL[q * 3], Y0, LL[q * 3 + 1], LL[q * 3 + 2], w ? 0.5 : 0.24, w ? 0.47 : 0.15, w ? 0.42 : 0.08);
    }
    for (let q = 0; q < 2; q++) {
      const k = 3 + q * 4, t = 3.3 + q * 0.5;
      pt((Rk(k - 1, t) + Rk(k, t)) * 0.5, t);
      b.timeless().appear(0.35, 0.36, POP, 0, BY.BUILT);
      if (q === 0) b.vanish(0.08, 0.09, POP, 0, BY.DECAY);
      llama(b, O[0], yk(k), O[1], t + 1.2, q ? 0.46 : 0.12, q ? 0.43 : 0.09, q ? 0.38 : 0.07);
    }
    const RED = [0.3, 0.055, 0.04], OCH = [0.34, 0.2, 0.06], DK = [0.08, 0.065, 0.055];
    const FG = [CX - 6, CZ + 1, 2.0, POSE.STAND, CX - 4.6, CZ + 2.2, -2.4, POSE.STAND, CX + 10, CZ - 2, 0.3, POSE.WALK];
    for (let q = 0; q < 3; q++) {
      b.timeless().appear(0.45, 0.46, POP, 0, BY.BUILT).vanish(0.02 + 0.025 * q, 0.03 + 0.025 * q, POP, 0, BY.DECAY);
      figure(b, FG[q * 4], Y0, FG[q * 4 + 1], FG[q * 4 + 2], FG[q * 4 + 3], seed + q, q === 0 ? RED : q === 1 ? OCH : DK);
    }
    b.timeless().appear(0.5, 0.51, POP, 0, BY.BUILT).vanish(0.05, 0.06, POP, 0, BY.DECAY);
    figure(b, IX - 1.2, top, IZ + 0.6, -1.6, POSE.STAND, seed + 7, RED);
    for (let q = 0; q < 2; q++) {
      const k = 5 + q * 3, t = 2.4 + q * 1.6;
      pt((Rk(k - 1, t) + Rk(k, t)) * 0.5, t);
      b.timeless().appear(0.3, 0.31, POP, 0, BY.BUILT).vanish(0.04 + 0.03 * q, 0.05 + 0.03 * q, POP, 0, BY.DECAY);
      figure(b, O[0], yk(k), O[1], t + 1.6, POSE.KNEEL, seed + 20 + q, q ? OCH : DK);
    }
    yield;

    // ---- mist wisps drifting across the peak and the saddle
    b.timeless();
    const MI = [PX - 30, 92, PZ - 38, PX + 18, 128, PZ + 30, PX + 40, 70, PZ - 20, PX - 45, 58, PZ + 34, 135, 40, PZ - 20, QX, 66, QZ + 10];
    for (let q = 0; q < MI.length / 3; q++) {
      b.smoke(MI[q * 3], MI[q * 3 + 1], MI[q * 3 + 2], { count: 7, size: 13 + 4 * (q & 1), rise: 22, density: 0.3, color: [0.9, 0.92, 0.95], src: FLICKER.NONE });
    }
    b.timeless();
    return b.counts();
  },
};
