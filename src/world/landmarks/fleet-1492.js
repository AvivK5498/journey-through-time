// The fleet of 1492: the nao Santa Maria and the caravels Pinta and Nina leave a small harbour
// and stand out to sea, in line, while the town watches from the quay.
//
// The registry gives this event no built / decay ramp (built 1, decay 0 for its whole life,
// clock 164-183), so nothing here is tagged: the motion is real time. animate() counts seconds
// from the first frame this placement is drawn (a new handle restarts it) and moves the three
// ships from just off the harbour out toward the horizon, rolling gently, each with its wake.
//
// The sea's side is only known per frame (a.seaX / a.seaZ). The shore (quay, mole, chapel,
// beach, boats, crowd) is built with the sea toward local +x and sits on rig 7, turned half a
// circle when the sea lies across the road, so the quay always faces the water the ships sail
// on. Ships sail away from the road on the sea side, ~235 m out at the start (clear of the pad's
// flattened ground). The witness block reads getters that animate() keeps current, so the
// event shot looks from behind the crowd over the quay at the fleet wherever it is.
//
// Rigs: 1 Santa Maria, 2 Pinta, 3 Nina (no shadow, far), 4-6 their wakes (built at 0.4 scale so
// the bind pose stays inside the radius, drawn at 2.5x), 7 the shore (casts shadows).

import { SURF, POSE } from './kit.js';

const TAU = Math.PI * 2;
const RADIUS = 46, PAD = 28, ROAD_OFF = 72;
const SHIP_SC = 1.55; // ships drawn a little over life size so they read at 300-600 m
const WAKE_K = 0.4; // wakes built at this scale, drawn at 1 / WAKE_K
const DS = 430; // start of the line: metres from the road centre line along the sea direction
const RUN = 620; // metres the fleet makes good over the event (asymptotic)
const TAU_RUN = 70; // seconds: time constant of that run
const GAP = 52; // spacing in line astern (m)

// ---- module scratch (animate allocates nothing)
const HX = new Float64Array(24);
const HG = new Float64Array(20 * 9 * 3); // hull grid
const HN = new Float64Array(20 * 9 * 3);
const HI = new Int32Array(20 * 9);
const WAT = new Float64Array([120, 0]); // witness look-at (local x, z)
const WIT = new Float64Array([230, 0.22, 12, -2]); // witness dist, az, height, look
const ST = { h: null, t0: 0 }; // first frame of this placement
// per ship: offset along the line, lateral offset, roll / pitch / bob phases
const SHIPS = new Float64Array([
  GAP, 0, 0.0, 1.3, 2.1, // 1 Santa Maria (middle)
  2 * GAP, 30, 1.7, 0.4, 3.3, // 2 Pinta (the fast one, leading)
  0, -28, 3.1, 2.6, 0.8, // 3 Nina (astern)
]);

// ---------------------------------------------------------------------------- helpers

function gableRoof(b, x0, x1, z0, z1, y, rise, alongZ) {
  if (alongZ) {
    const xm = (x0 + x1) / 2;
    HX.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, xm, y + rise, z0, xm, y + rise, z0, xm, y + rise, z1, xm, y + rise, z1]);
  } else {
    const zm = (z0 + z1) / 2;
    HX.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y + rise, zm, x1, y + rise, zm, x1, y + rise, zm, x0, y + rise, zm]);
  }
  b.hexa(HX, false);
}

function hullW(u) { const k = (u - 0.42) / 0.58; return Math.sqrt(Math.max(0, 1 - k * k)); }

// Round-bellied wooden hull facing +z, waterline y = 0, keel below. o: L, B, D (draught),
// sh (freeboard amidships), rise (sheer rise to the ends), col / band / tar colours.
// Returns nothing; deckY(o, u) gives the deck height at u (0 stern .. 1 stem).
function deckY(o, u) { const s = 2 * u - 1; return o.sh + o.rise * s * s - 0.45; }
function hull(b, o) {
  const NS = 18, NP = 9, L = o.L, hb = o.B / 2;
  for (let i = 0; i < NS; i++) {
    const u = i / (NS - 1), w = hb * Math.max(hullW(u), 0.001);
    const s = 2 * u - 1, sh = o.sh + o.rise * s * s;
    const D = o.D * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.95)));
    const z = -L / 2 + u * L;
    for (let j = 0; j < NP; j++) {
      const k = j <= 4 ? j : 8 - j, sd = j < 4 ? -1 : j > 4 ? 1 : 0;
      let px, py;
      if (k === 0) { px = 0.86 * w; py = sh; } else if (k === 1) { px = w; py = 0.9; } else if (k === 2) { px = 0.95 * w; py = 0; } else if (k === 3) { px = 0.7 * w; py = -0.62 * D; } else { px = 0; py = -D; }
      const hf = (py + D) / (sh + D); // 0 keel .. 1 sheer
      const g = (i * NP + j) * 3;
      HG[g] = sd * px; HG[g + 1] = py;
      HG[g + 2] = z - o.L * 0.13 * (1 - hf) * Math.pow(u, 5); // raked stem
    }
  }
  // normals from the grid, turned outward
  for (let i = 0; i < NS; i++) for (let j = 0; j < NP; j++) {
    const g = (i * NP + j) * 3;
    const ia = Math.max(0, i - 1), ib = Math.min(NS - 1, i + 1), ja = Math.max(0, j - 1), jb = Math.min(NP - 1, j + 1);
    const a = (ia * NP + j) * 3, c = (ib * NP + j) * 3, d = (i * NP + ja) * 3, e = (i * NP + jb) * 3;
    const tx = HG[c] - HG[a], ty = HG[c + 1] - HG[a + 1], tz = HG[c + 2] - HG[a + 2];
    const qx = HG[e] - HG[d], qy = HG[e + 1] - HG[d + 1], qz = HG[e + 2] - HG[d + 2];
    let nx = ty * qz - tz * qy, ny = tz * qx - tx * qz, nz = tx * qy - ty * qx;
    const sd = j < 4 ? -1 : j > 4 ? 1 : 0, u = i / (NS - 1);
    const rx = sd + HG[g] * 0.2, ry = (HG[g + 1] + 0.3) * 0.3, rz = u > 0.92 ? 1 : 0;
    if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    HN[g] = nx; HN[g + 1] = ny; HN[g + 2] = nz;
  }
  b.surface(SURF.WOOD).ao(1);
  for (let i = 0; i < NS; i++) for (let j = 0; j < NP; j++) {
    const k = j <= 4 ? j : 8 - j, g = (i * NP + j) * 3;
    const C = k === 0 ? o.band : k <= 1 ? o.col : o.tar;
    b.color(C[0], C[1], C[2]).ao(k >= 3 ? 0.7 : 1);
    HI[i * NP + j] = b.vertex(HG[g], HG[g + 1], HG[g + 2], HN[g], HN[g + 1], HN[g + 2]);
  }
  for (let i = 0; i < NS - 1; i++) for (let j = 0; j < NP - 1; j++) {
    const a = i * NP + j;
    b.quad(HI[a], HI[a + NP], HI[a + NP + 1], HI[a + 1]);
  }
  // transom (flat stern), fan from its centre
  b.color(o.col[0] * 0.9, o.col[1] * 0.9, o.col[2] * 0.9).ao(0.95);
  const zc = HG[2];
  const c0 = b.vertex(0, (o.sh + o.rise - o.D * 0.6) / 2, zc, 0, 0.1, -1), f0 = b.nv;
  for (let j = 0; j < NP; j++) b.vertex(HG[j * 3], HG[j * 3 + 1], zc, 0, 0.1, -1);
  for (let j = 0; j < NP - 1; j++) b.tri(c0, f0 + j, f0 + j + 1);
  b.tri(c0, f0 + NP - 1, f0);
  // deck
  b.color(o.deck[0], o.deck[1], o.deck[2]).ao(0.9);
  for (let i = 0; i < NS - 1; i++) {
    const u0 = i / (NS - 1), u1 = (i + 1) / (NS - 1);
    const w0 = hb * 0.84 * hullW(u0), w1 = hb * 0.84 * hullW(u1);
    const z0 = -L / 2 + u0 * L, z1 = -L / 2 + u1 * L, y0 = deckY(o, u0), y1 = deckY(o, u1);
    const p = b.vertex(-w0, y0, z0, 0, 1, 0), q = b.vertex(w0, y0, z0, 0, 1, 0);
    const r = b.vertex(w1, y1, z1, 0, 1, 0), s = b.vertex(-w1, y1, z1, 0, 1, 0);
    b.quad(p, q, r, s);
  }
}

// Billowing square sail hung from a yard at height yT (half width wT) to its foot at yB (wB),
// bellied forward (+z) by `belly`, at z = z0. cross: a red cross on both faces.
const CU = [-1, -0.15, 0.15, 1], CV = [0, 0.33, 0.57, 1];
function sqPoint(u, v, s, out) {
  const hw = s.wT + (s.wB - s.wT) * v;
  out[0] = u * hw; out[1] = s.yT + (s.yB - s.yT) * v;
  out[2] = s.z0 + s.belly * (1 - 0.85 * u * u) * Math.sin(Math.PI * (0.1 + 0.75 * v));
}
const SP = new Float64Array(3), SQ = new Float64Array(3), SR = new Float64Array(3);
function squareSail(b, s, canvas, red) {
  b.surface(SURF.HIDE).ao(1);
  for (let ci = 0; ci < 3; ci++) for (let cj = 0; cj < 3; cj++) {
    const isRed = red && (ci === 1 || cj === 1);
    const C = isRed ? red : canvas;
    b.color(C[0], C[1], C[2]);
    const u0 = CU[ci], u1 = CU[ci + 1], v0 = CV[cj], v1 = CV[cj + 1];
    const nu = Math.max(1, Math.round((u1 - u0) / 0.3)), nv = Math.max(1, Math.round((v1 - v0) / 0.2));
    for (let side = -1; side <= 1; side += 2) {
      const base = b.nv;
      for (let jj = 0; jj <= nv; jj++) for (let ii = 0; ii <= nu; ii++) {
        const u = u0 + (u1 - u0) * ii / nu, v = v0 + (v1 - v0) * jj / nv;
        sqPoint(u, v, s, SP); sqPoint(u + 0.02, v, s, SQ); sqPoint(u, v + 0.02, s, SR);
        const ax = SQ[0] - SP[0], ay = SQ[1] - SP[1], az = SQ[2] - SP[2];
        const bx = SR[0] - SP[0], by = SR[1] - SP[1], bz = SR[2] - SP[2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        if (nz * side < 0) { nx = -nx; ny = -ny; nz = -nz; }
        b.vertex(SP[0], SP[1], SP[2] + side * 0.035, nx, ny, nz);
      }
      const W = nu + 1;
      for (let jj = 0; jj < nv; jj++) for (let ii = 0; ii < nu; ii++) {
        const a = base + jj * W + ii;
        b.quad(a, a + 1, a + W + 1, a + W);
      }
    }
  }
}

// Lateen sail: triangle tack T (forward, low on the yard), peak P (aft, high), clew C, in the
// ship's centre plane, bellied to +x. Points as [x, y, z] numbers.
function lateen(b, tx, ty, tz, px, py, pz, cx, cy, cz, belly, canvas) {
  const N = 6;
  b.color(canvas[0], canvas[1], canvas[2]).surface(SURF.HIDE).ao(1);
  const pt = (i, j, o) => {
    const a = i / N, bb = j / N, c = 1 - a - bb;
    o[0] = tx * c + px * a + cx * bb + belly * 27 * a * bb * Math.max(0, c);
    o[1] = ty * c + py * a + cy * bb; o[2] = tz * c + pz * a + cz * bb;
  };
  const tri = (i0, j0, i1, j1, i2, j2) => {
    pt(i0, j0, SP); pt(i1, j1, SQ); pt(i2, j2, SR);
    const ax = SQ[0] - SP[0], ay = SQ[1] - SP[1], az = SQ[2] - SP[2], bx = SR[0] - SP[0], by = SR[1] - SP[1], bz = SR[2] - SP[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (nx < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (let sd = -1; sd <= 1; sd += 2) {
      const o = sd * 0.03;
      const v0 = b.vertex(SP[0] + o, SP[1], SP[2], nx * sd, ny * sd, nz * sd);
      const v1 = b.vertex(SQ[0] + o, SQ[1], SQ[2], nx * sd, ny * sd, nz * sd);
      const v2 = b.vertex(SR[0] + o, SR[1], SR[2], nx * sd, ny * sd, nz * sd);
      b.tri(v0, v1, v2);
    }
  };
  for (let i = 0; i < N; i++) for (let j = 0; j < N - i; j++) {
    tri(i, j, i + 1, j, i, j + 1);
    if (i + j < N - 1) tri(i + 1, j, i + 1, j + 1, i, j + 1);
  }
}

// Pennant streaming forward (downwind) from a masthead at (0, y, z).
function pennant(b, y, z, len, col) {
  b.color(col[0], col[1], col[2]).surface(SURF.PLAIN).ao(1);
  const n = 5;
  for (let sd = -1; sd <= 1; sd += 2) {
    const base = b.nv;
    for (let i = 0; i <= n; i++) {
      const t = i / n, w = 0.55 * (1 - t) + 0.04, x = 0.35 * Math.sin(t * 4.2) * t + sd * 0.02;
      const yy = y - 0.4 * t * t, zz = z + 0.15 + len * t;
      b.vertex(x, yy, zz, sd, 0, 0); b.vertex(x, yy - w, zz, sd, 0, 0);
    }
    for (let i = 0; i < n; i++) { const a = base + i * 2; b.quad(a, a + 2, a + 3, a + 1); }
  }
}

const ROPE = [0.07, 0.055, 0.04];
function line(b, ax, ay, az, bx, by, bz, r = 0.05) { b.beam(ax, ay, az, bx, by, bz, r, r, 3, false); }

// One ship, facing +z, waterline at y = 0. big: the nao with castles; else a caravel.
const CANVAS = [0.55, 0.51, 0.41], CANVAS2 = [0.5, 0.47, 0.38], RED = [0.42, 0.045, 0.035];
const MAST = [0.15, 0.1, 0.06];
function ship(b, big, sc) {
  b.push(); b.scale(sc, sc, sc);
  const o = big
    ? { L: 21, B: 7.2, D: 2.3, sh: 2.2, rise: 0.8, col: [0.13, 0.08, 0.045], band: [0.27, 0.16, 0.07], tar: [0.06, 0.045, 0.035], deck: [0.28, 0.2, 0.12] }
    : { L: 16.5, B: 5.4, D: 1.8, sh: 1.7, rise: 0.55, col: [0.16, 0.1, 0.055], band: [0.3, 0.19, 0.08], tar: [0.065, 0.05, 0.04], deck: [0.3, 0.22, 0.13] };
  hull(b, o);
  const L = o.L, hb = o.B / 2;
  const zu = (u) => -L / 2 + u * L;
  // wale: a darker rubbing strake along each side just under the sheer
  b.color(0.07, 0.05, 0.035).surface(SURF.WOOD).ao(1);
  for (let sd = -1; sd <= 1; sd += 2) {
    for (let i = 0; i < 10; i++) {
      const u0 = 0.04 + i * 0.085, u1 = u0 + 0.085;
      const y0 = deckY(o, u0) - 0.25, y1 = deckY(o, u1) - 0.25;
      line(b, sd * hb * hullW(u0) * 0.97, y0, zu(u0), sd * hb * hullW(u1) * 0.97, y1, zu(u1), 0.11);
    }
  }
  // sterncastle
  const ua = big ? 0.27 : 0.2, ah = big ? 2.6 : 1.4;
  const ys = deckY(o, 0) + 0.2, yf = deckY(o, ua) + 0.2;
  const w0 = hb * hullW(0) * 0.9, w1 = hb * hullW(ua) * 0.86;
  const zs = zu(0) - 0.4, zf = zu(ua);
  HX.set([-w0, ys - 0.6, zs, w0, ys - 0.6, zs, w1, yf - 0.6, zf, -w1, yf - 0.6, zf,
    -w0 * 0.95, ys + ah, zs - 0.3, w0 * 0.95, ys + ah, zs - 0.3, w1 * 0.95, yf + ah * 0.9, zf, -w1 * 0.95, yf + ah * 0.9, zf]);
  b.color(o.band[0] * 0.8, o.band[1] * 0.8, o.band[2] * 0.8).surface(SURF.WOOD).ao(1);
  b.hexa(HX, false);
  // its rail and a dark band of ports
  b.color(0.06, 0.045, 0.035);
  for (let sd = -1; sd <= 1; sd += 2) line(b, sd * w0 * 0.97, ys + ah * 0.55, zs - 0.1, sd * w1 * 0.97, yf + ah * 0.5, zf, 0.12);
  const castleTop = ys + ah;
  if (big) {
    // forecastle, overhanging the stem
    const u0 = 0.8, y0 = deckY(o, u0) + 0.1, wq = hb * hullW(u0) * 0.92, zq = zu(u0), zt = zu(1) + 1.2, yt = deckY(o, 1) + 0.3;
    HX.set([-wq, y0 - 0.5, zq, wq, y0 - 0.5, zq, 0.9, yt, zt, -0.9, yt, zt,
      -wq * 1.05, y0 + 2.0, zq, wq * 1.05, y0 + 2.0, zq, 1.3, yt + 1.8, zt + 0.4, -1.3, yt + 1.8, zt + 0.4]);
    b.color(o.band[0] * 0.8, o.band[1] * 0.8, o.band[2] * 0.8).surface(SURF.WOOD);
    b.hexa(HX, false);
  }
  // masts, yards, sails
  const uM = big ? 0.53 : 0.5, uF = big ? 0.83 : 0.8, uZ = big ? 0.17 : 0.14;
  const hM = big ? 25 : 19, hF = big ? 17 : 14, hZ = big ? 14.5 : 11.5;
  const zM = zu(uM), zF = zu(uF), zZ = zu(uZ);
  b.color(MAST[0], MAST[1], MAST[2]).surface(SURF.WOOD).ao(1);
  b.beam(0, deckY(o, uM) - 0.5, zM, 0, hM, zM, big ? 0.32 : 0.26, 0.14, 7, true);
  b.beam(0, deckY(o, uF) - 0.5, zF, 0, hF, zF, big ? 0.24 : 0.2, 0.11, 6, true);
  b.beam(0, castleTop - 0.5, zZ, 0, hZ, zZ, 0.17, 0.09, 6, true);
  // bowsprit
  const yb = deckY(o, 0.95) + 0.4, zb = zu(0.95);
  b.beam(0, yb, zb - 1, 0, yb + 2.6, zb + (big ? 8 : 6), 0.2, 0.12, 6, true);
  // main course with the cross
  const mY = big ? 16 : 13.2, mW = big ? 7.2 : 5.6;
  b.color(MAST[0], MAST[1], MAST[2]);
  b.beam(-mW - 0.6, mY + 0.1, zM + 0.35, mW + 0.6, mY + 0.1, zM + 0.35, 0.16, 0.16, 5, true);
  squareSail(b, { yT: mY, yB: big ? 5.6 : 4.6, wT: mW, wB: mW + 0.8, z0: zM + 0.45, belly: big ? 1.8 : 1.4 }, CANVAS, RED);
  // fore course (and the nao's main topsail and spritsail)
  const fY = big ? 13 : 10.6, fW = big ? 5.2 : 4.2;
  b.color(MAST[0], MAST[1], MAST[2]);
  b.beam(-fW - 0.5, fY + 0.1, zF + 0.3, fW + 0.5, fY + 0.1, zF + 0.3, 0.13, 0.13, 5, true);
  squareSail(b, { yT: fY, yB: big ? 5.4 : 4.2, wT: fW, wB: fW + 0.6, z0: zF + 0.4, belly: 1.2 }, CANVAS2, null);
  if (big) {
    b.color(MAST[0], MAST[1], MAST[2]);
    b.beam(-3.6, 22.4, zM + 0.25, 3.6, 22.4, zM + 0.25, 0.1, 0.1, 5, true);
    squareSail(b, { yT: 22.3, yB: 17.6, wT: 3.4, wB: 5.4, z0: zM + 0.35, belly: 0.9 }, CANVAS2, null);
    // fighting top on the main
    b.color(0.12, 0.08, 0.05);
    b.push(); b.translate(0, 19.9, zM); b.lathe([0.7, 0, 1.0, 0.9], 10); b.pop();
    const zs2 = zb + 5.6, ys2 = yb + 1.4;
    b.color(MAST[0], MAST[1], MAST[2]);
    b.beam(-2.6, ys2, zs2, 2.6, ys2, zs2, 0.08, 0.08, 4, true);
    squareSail(b, { yT: ys2 - 0.1, yB: ys2 - 2.8, wT: 2.4, wB: 2.8, z0: zs2 + 0.1, belly: 0.7 }, CANVAS2, null);
  }
  // mizzen lateen: the long yard slants up aft
  const tY = castleTop + 1.6, tZ = zZ + (big ? 5.5 : 4.6), pY = hZ + (big ? 4.5 : 3.6), pZ = zZ - (big ? 6.2 : 5);
  b.color(MAST[0], MAST[1], MAST[2]);
  b.beam(0.15, tY - 0.4, tZ + 0.8, 0.15, pY + 0.3, pZ - 0.4, 0.1, 0.07, 5, true);
  lateen(b, 0.2, tY, tZ, 0.2, pY, pZ, 0.2, castleTop + 0.9, zu(0) - 0.6, 0.9, CANVAS);
  // standing rigging: shrouds and stays
  b.color(ROPE[0], ROPE[1], ROPE[2]).surface(SURF.PLAIN);
  for (let sd = -1; sd <= 1; sd += 2) {
    for (let k = -1; k <= 1; k++) {
      line(b, sd * hb * 0.95, deckY(o, uM) + 0.3, zM + k * 0.9 - 1.2, 0, hM * 0.78, zM);
      line(b, sd * hb * 0.92, deckY(o, uF) + 0.3, zF + k * 0.8 - 1, 0, hF * 0.8, zF);
    }
    line(b, sd * hb * 0.8, castleTop, zZ - 0.6, 0, hZ * 0.85, zZ);
  }
  line(b, 0, hM - 0.5, zM, 0, deckY(o, uF) + 1.2, zF - 0.4); // main stay
  line(b, 0, hF - 0.4, zF, 0, yb + 2.4, zb + (big ? 7.4 : 5.5)); // fore stay
  // pennants at the mastheads, red and long (no device, no national flag)
  pennant(b, hM + 0.1, zM, big ? 6.5 : 5, RED);
  pennant(b, hF + 0.1, zF, big ? 4.5 : 3.6, [0.5, 0.47, 0.4]);
  pennant(b, hZ + 0.1, zZ, 3.2, RED);
  b.pop();
}

// A wake, built at WAKE_K scale around the ship's centre: two broken Kelvin arms from the bow
// and a broad churned wash astern, pale foam fading into the sea. y = 0 (the rig sets it).
function wake(b, L, B, seed) {
  const K = WAKE_K;
  b.surface(SURF.PLAIN).ao(1);
  const quad = (x0, z0, x1, z1, hw0, hw1, dx, dz, c0, c1) => {
    // strip from (x0, z0) to (x1, z1), half widths hw0 -> hw1 across (dx, dz) (unit, perpendicular)
    b.color(c0[0], c0[1], c0[2]);
    const p = b.vertex((x0 - dx * hw0) * K, 0, (z0 - dz * hw0) * K, 0, 1, 0), q = b.vertex((x0 + dx * hw0) * K, 0, (z0 + dz * hw0) * K, 0, 1, 0);
    b.color(c1[0], c1[1], c1[2]);
    const r = b.vertex((x1 + dx * hw1) * K, 0, (z1 + dz * hw1) * K, 0, 1, 0), s = b.vertex((x1 - dx * hw1) * K, 0, (z1 - dz * hw1) * K, 0, 1, 0);
    b.quad(p, q, r, s);
  };
  const C = new Float64Array(3), D = new Float64Array(3);
  const foam = (t, out) => { const k = Math.min(1, t); out[0] = 0.6 - 0.46 * k; out[1] = 0.64 - 0.42 * k; out[2] = 0.65 - 0.36 * k; };
  const len = 82, bowZ = L * 0.5, half = 0.36;
  for (let sd = -1; sd <= 1; sd += 2) {
    const dx = Math.sin(half) * sd, dz = -Math.cos(half); // arm direction
    const px = -dz * sd, pz = dx * sd; // across it
    let s = 0;
    while (s < len) {
      const segL = 3 + 6 * b.rand(), e = Math.min(len, s + segL);
      const x0 = sd * B * 0.42 + dx * s, z0 = bowZ + dz * s, x1 = sd * B * 0.42 + dx * e, z1 = bowZ + dz * e;
      foam(s / len, C); foam(e / len, D);
      quad(x0, z0, x1, z1, 1.3 * (1 - s / len) + 0.35, 1.3 * (1 - e / len) + 0.35, px, pz, C, D);
      s = e + 0.8 + 3 * b.rand() * (0.3 + s / len);
    }
  }
  // the wake astern: a smooth pale lane narrowing into the sea (no gaps: sailing ships leave
  // a quiet wake, and crosswise breaks read as a ladder)
  const z00 = -L * 0.46, WL = 55, NW = 8;
  for (let i = 0; i < NW; i++) {
    const s0 = WL * i / NW, s1 = WL * (i + 1) / NW;
    foam(0.15 + s0 / WL, C); foam(0.15 + s1 / WL, D);
    quad(0, z00 - s0, 0, z00 - s1, B * 0.28 + s0 * 0.04, B * 0.28 + s1 * 0.04, 1, 0, C, D);
  }
  // bow wave hugging the stem
  foam(0, C);
  for (let sd = -1; sd <= 1; sd += 2) quad(sd * 0.3, bowZ + 1.2, sd * B * 0.45, bowZ - L * 0.2, 0.5, 0.9, sd * 0.94, 0.34, C, C);
}

// ---------------------------------------------------------------------------- the shore

const STONE = [0.36, 0.33, 0.27], PAVE = [0.42, 0.39, 0.32], LIME = [0.52, 0.5, 0.45];
const TILE = [0.36, 0.13, 0.065], SAND = [0.47, 0.41, 0.29];
const CLOTH = [[0.1, 0.075, 0.05], [0.26, 0.17, 0.08], [0.3, 0.07, 0.05], [0.12, 0.14, 0.17], [0.06, 0.055, 0.05], [0.33, 0.29, 0.21], [0.16, 0.2, 0.12]];

function house(b, x, z, yaw, w, d, h, s) {
  b.push(); b.at(x, 0, z, yaw);
  const g = 0.94 + 0.08 * b.rand();
  b.color(LIME[0] * g, LIME[1] * g, LIME[2] * g).surface(SURF.PLASTER).ao(1);
  b.box(0, h / 2 - 0.3, 0, w, h / 2 + 0.3, d, false);
  b.color(TILE[0], TILE[1], TILE[2]).surface(SURF.PLAIN).ao(1);
  gableRoof(b, -w - 0.35, w + 0.35, -d - 0.3, d + 0.3, h, 1.5 * s, false);
  b.color(0.06, 0.05, 0.045).ao(0.8);
  b.box(w * 0.3, 1.05, d + 0.04, 0.5, 1.05, 0.06, false); // door
  b.box(-w * 0.45, 2.0 * s, d + 0.04, 0.35, 0.35, 0.06, false); // window
  b.pop();
}

function barrel(b, x, y, z) {
  b.push(); b.translate(x, y, z);
  b.color(0.24, 0.15, 0.08).surface(SURF.WOOD).ao(1);
  b.lathe([0.3, 0, 0.37, 0.45, 0.3, 0.92], 9);
  b.color(0.08, 0.07, 0.06);
  b.lathe([0.315, 0.16, 0.33, 0.24], 9, { caps: false });
  b.lathe([0.33, 0.68, 0.315, 0.76], 9, { caps: false });
  b.pop();
}

function fishingBoat(b, x, z, yaw, len, band) {
  b.push(); b.at(x, 0, z, yaw);
  const o = { L: len, B: len * 0.36, D: 0.5, sh: 0.55, rise: 0.25, col: [0.13, 0.1, 0.07], band, tar: [0.07, 0.055, 0.045], deck: [0.22, 0.16, 0.1] };
  b.translate(0, 0.42, 0); b.rotateZ(0.16);
  hull(b, o);
  b.color(0.2, 0.14, 0.08).surface(SURF.WOOD);
  b.beam(-0.4, 0.4, -0.5, 0.9, 0.55, 1.6, 0.04, 0.04, 4, true); // oars
  b.beam(-0.2, 0.45, -0.8, 1.1, 0.6, 1.0, 0.04, 0.04, 4, true);
  b.pop();
}

function chapel(b) {
  // nave along x, facade with the bell gable toward the road (-x)
  const x0 = -26, x1 = -12, z0 = 15, z1 = 23, h = 6.2, zm = (z0 + z1) / 2;
  b.color(STONE[0], STONE[1], STONE[2]).surface(SURF.STONE).ao(1);
  b.box((x0 + x1) / 2, 0.2, zm, (x1 - x0) / 2 + 0.35, 0.45, (z1 - z0) / 2 + 0.35, false); // plinth
  b.color(LIME[0], LIME[1], LIME[2]).surface(SURF.PLASTER).ao(1);
  b.box((x0 + x1) / 2, h / 2, zm, (x1 - x0) / 2, h / 2, (z1 - z0) / 2, false);
  // apse
  b.push(); b.translate(x1, 0, zm);
  b.lathe([3.0, -0.2, 3.0, h - 0.6], 12, { a0: -Math.PI / 2, a1: Math.PI / 2, caps: false });
  b.color(TILE[0], TILE[1], TILE[2]).surface(SURF.PLAIN);
  b.lathe([3.35, h - 0.6, 0.01, h + 1.4], 12, { a0: -Math.PI / 2, a1: Math.PI / 2, caps: false });
  b.pop();
  b.color(TILE[0], TILE[1], TILE[2]).surface(SURF.PLAIN).ao(1);
  gableRoof(b, x0 - 0.2, x1 + 0.3, z0 - 0.45, z1 + 0.45, h, 2.7, false);
  // facade gable wall up to the espadana
  b.color(LIME[0], LIME[1], LIME[2]).surface(SURF.PLASTER);
  HX.set([x0 - 0.5, h, z0, x0, h, z0, x0, h, z1, x0 - 0.5, h, z1, x0 - 0.5, h + 2.9, zm, x0, h + 2.9, zm, x0, h + 2.9, zm, x0 - 0.5, h + 2.9, zm]);
  b.hexa(HX, false);
  b.box(x0 - 0.25, h / 2, zm, 0.25, h / 2, (z1 - z0) / 2, false);
  // espadana: a pierced bell wall above the facade
  const ex = x0 - 0.25, ew = 2.5;
  b.box(ex, h + 1.6, zm, 0.3, 1.6, ew, false);
  b.box(ex, h + 4.1, zm - ew + 0.5, 0.3, 0.9, 0.5, false);
  b.box(ex, h + 4.1, zm + ew - 0.5, 0.3, 0.9, 0.5, false);
  b.box(ex, h + 5.4, zm, 0.3, 0.45, ew, false);
  HX.set([ex - 0.3, h + 5.85, zm - ew, ex + 0.3, h + 5.85, zm - ew, ex + 0.3, h + 5.85, zm + ew, ex - 0.3, h + 5.85, zm + ew,
    ex - 0.3, h + 7.0, zm, ex + 0.3, h + 7.0, zm, ex + 0.3, h + 7.0, zm, ex - 0.3, h + 7.0, zm]);
  b.hexa(HX, false);
  // the bell in its opening, and an iron cross on top
  b.color(0.2, 0.13, 0.06).surface(SURF.GILT).ao(0.9);
  b.push(); b.translate(ex, h + 3.25, zm); b.lathe([0.62, 0, 0.5, 0.25, 0.32, 0.8, 0.0, 0.95], 10); b.pop();
  b.color(0.07, 0.06, 0.05).surface(SURF.PLAIN);
  b.beam(ex, h + 7, zm, ex, h + 8.5, zm, 0.07, 0.07, 4, true);
  b.beam(ex, h + 8.0, zm - 0.45, ex, h + 8.0, zm + 0.45, 0.06, 0.06, 4, true);
  // doorway, oculus, side windows (dark)
  b.color(0.05, 0.045, 0.04).ao(0.7);
  b.box(x0 - 0.52, 1.35, zm, 0.04, 1.35, 0.85, false);
  b.box(x0 - 0.52, 4.6, zm, 0.04, 0.45, 0.45, false);
  for (let i = 0; i < 3; i++) for (let sd = -1; sd <= 1; sd += 2) b.box(x0 + 3.5 + i * 3.6, 3.9, zm + sd * ((z1 - z0) / 2 + 0.03), 0.3, 0.6, 0.04, false);
  // stone step
  b.color(PAVE[0], PAVE[1], PAVE[2]).surface(SURF.STONE).ao(1);
  b.box(x0 - 1.3, 0.12, zm, 0.8, 0.14, 1.6, false);
}

function shore(b, seed) {
  const sd = seed | 0;
  // beach sand on the sea side of the pad
  b.surface(SURF.EARTH).ao(1);
  b.disc(27.5, 44, 7, (x, z) => {
    const t = Math.min(1, Math.max(0, (x - 6) / 5));
    const k = 0.92 + 0.1 * Math.min(1, x / 27);
    b.color(SAND[0] * k, SAND[1] * k, SAND[2] * k);
    return t > 0 ? 0.025 : -0.25;
  });
  // cobbled lane from the road side down to the quay
  b.color(PAVE[0] * 0.8, PAVE[1] * 0.8, PAVE[2] * 0.8).surface(SURF.STONE);
  b.heightfield(-44, -3, 5, 3, 14, 2, () => 0.03);
  // sea wall along the beach head, its top a paved quay
  const QH = 1.4;
  b.color(STONE[0], STONE[1], STONE[2]).surface(SURF.STONE).ao(1);
  b.push(); b.translate(6.5, -0.4, -2); b.block(2.1, 26, 1.9, 26, QH + 0.4, 0.15, 0, false); b.pop();
  b.color(PAVE[0], PAVE[1], PAVE[2]);
  b.box(6.6, QH + 0.07, -2, 2.05, 0.08, 26, false);
  // steps down to the beach
  b.color(STONE[0] * 1.05, STONE[1] * 1.05, STONE[2] * 1.05);
  for (let i = 0; i < 4; i++) b.box(9.0 + i * 0.5, (QH - 0.35 * i) / 2, 10, 0.3, (QH - 0.35 * i) / 2, 1.4, false);
  // the mole: out across the sand to the water, its foot sunk deep (the ground falls away
  // beyond the pad), a squat beacon tower at its head
  const mz = -10.5, mw = 3.6;
  b.color(STONE[0] * 0.95, STONE[1] * 0.95, STONE[2] * 0.92).surface(SURF.STONE);
  HX.set([4, -5, mz - mw - 1.2, 42.2, -5, mz - mw - 1.2, 42.2, -5, mz + mw + 1.2, 4, -5, mz + mw + 1.2,
    4, QH, mz - mw, 42.2, QH, mz - mw, 42.2, QH, mz + mw, 4, QH, mz + mw]);
  b.hexa(HX, false);
  b.color(PAVE[0], PAVE[1], PAVE[2]);
  b.box(23.2, QH + 0.06, mz, 19.1, 0.07, mw - 0.1, false);
  b.color(STONE[0], STONE[1], STONE[2]);
  b.push(); b.translate(40.6, -5, mz); b.lathe([4.3, 0, 3.7, 5 + QH, 0.01, 5 + QH], 14); b.pop();
  b.push(); b.translate(41.0, QH, mz);
  b.color(LIME[0] * 0.85, LIME[1] * 0.85, LIME[2] * 0.82).surface(SURF.STONE);
  b.lathe([1.7, 0, 1.5, 4.4], 12);
  b.color(STONE[0] * 0.8, STONE[1] * 0.8, STONE[2] * 0.8);
  b.lathe([1.8, 4.4, 1.8, 4.9, 0.01, 4.9], 12);
  b.color(0.08, 0.06, 0.05).surface(SURF.PLAIN);
  b.lathe([0.5, 4.9, 0.7, 5.6, 0.01, 5.6], 8); // the iron fire basket
  b.box(-1.62, 1.7, 0, 0.04, 0.8, 0.45, false); // door toward the quay
  b.pop();
  // bollards along both edges of the mole and the wall
  b.color(0.1, 0.085, 0.07).surface(SURF.STONE).ao(1);
  for (let i = 0; i < 6; i++) for (let s = -1; s <= 1; s += 2) {
    b.push(); b.translate(12 + i * 5.2, QH, mz + s * (mw - 0.45));
    b.lathe([0.24, 0, 0.2, 0.5, 0.28, 0.62, 0.01, 0.7], 8); b.pop();
  }
  for (let i = 0; i < 4; i++) { b.push(); b.translate(7.9, QH, -24 + i * 9); b.lathe([0.24, 0, 0.2, 0.5, 0.28, 0.62, 0.01, 0.7], 8); b.pop(); }
  // cargo: barrels and crates at the root of the mole and along the quay
  const rand = () => b.rand();
  for (let i = 0; i < 9; i++) barrel(b, 5.6 + (i % 3) * 0.78, QH + 0.02, -18.5 + Math.floor(i / 3) * 0.78);
  barrel(b, 6.0, QH + 0.94, -17.7); barrel(b, 6.75, QH + 0.94, -17.7);
  for (let i = 0; i < 5; i++) barrel(b, 14 + i * 0.8 + rand() * 0.1, QH + 0.02, mz + 2.3);
  b.color(0.27, 0.19, 0.11).surface(SURF.WOOD).ao(1);
  for (let i = 0; i < 7; i++) {
    const s = 0.35 + 0.15 * rand(), x = 5.4 + rand() * 2.2, z = 2 + i * 1.3 + rand() * 0.3;
    b.push(); b.at(x, QH + s, z, rand() * 0.6); b.box(0, 0, 0, s, s, s * 1.2, false); b.pop();
  }
  for (let i = 0; i < 3; i++) { b.push(); b.at(19 + i * 1.3, QH + 0.45, mz - 2.3, 0.2 * i); b.box(0, 0, 0, 0.45, 0.45, 0.6, false); b.pop(); }
  // fishing boats drawn up on the beach, bows to the land
  fishingBoat(b, 17.5, 5, -Math.PI / 2 - 0.12, 6.2, [0.32, 0.2, 0.07]);
  fishingBoat(b, 19.5, 11.5, -Math.PI / 2 + 0.2, 5.6, [0.1, 0.22, 0.26]);
  fishingBoat(b, 16.5, 18.5, -Math.PI / 2 - 0.05, 6.6, [0.36, 0.08, 0.05]);
  fishingBoat(b, 22, -24, -Math.PI / 2 + 0.3, 5.2, [0.1, 0.22, 0.26]);
  // nets drying on poles
  b.color(0.16, 0.11, 0.07).surface(SURF.WOOD);
  for (let i = 0; i < 3; i++) b.beam(12, 0, 23 + i * 2.2, 12, 2.1, 23 + i * 2.2, 0.06, 0.05, 4, true);
  b.color(0.12, 0.12, 0.1).surface(SURF.HIDE).ao(0.85);
  for (let sdn = -1; sdn <= 1; sdn += 2) {
    const p = b.vertex(12 + sdn * 0.03, 2.0, 23, sdn, 0.1, 0), q = b.vertex(12 + sdn * 0.03, 2.0, 27.4, sdn, 0.1, 0);
    const r = b.vertex(12 + sdn * 0.03, 0.5, 27.4, sdn, 0.1, 0), s = b.vertex(12 + sdn * 0.03, 0.7, 23, sdn, 0.1, 0);
    b.quad(p, q, r, s);
  }
  // the chapel and two fishermen's houses
  chapel(b);
  house(b, -30, -10, Math.PI / 2, 3.6, 2.6, 3.4, 1);
  house(b, -22, -24, 0.1, 3.0, 2.4, 3.1, 1);
  house(b, -8, 30, Math.PI, 3.2, 2.5, 3.2, 1);
  // the crowd: still figures on the quay, the mole and the beach, all watching the sea
  b.surface(SURF.HIDE).ao(1);
  const spots = [
    // x, y, z
    7.5, QH, -14, 7.2, QH, -11.6, 7.6, QH, -6.5, 7.4, QH, -4, 7.7, QH, 0.4, 7.3, QH, 4.7, 7.6, QH, 6.2, 7.4, QH, 13.5, 7.7, QH, 16,
    18, QH, mz - 2.9, 21.5, QH, mz + 2.8, 24, QH, mz - 2.7, 26, QH, mz + 3.0, 29.5, QH, mz - 2.8, 33, QH, mz + 2.9, 36.5, QH, mz - 2.6, 38.5, QH, mz + 2.5,
    15.5, 0.02, 8.5, 20.5, 0.02, 15, 23, 0.02, 7, 14.2, 0.02, 1,
  ];
  for (let i = 0; i < spots.length; i += 3) {
    const C = CLOTH[(i / 3 + sd) % CLOTH.length];
    b.color(C[0], C[1], C[2]);
    b.push(); b.at(spots[i], spots[i + 1], spots[i + 2], Math.PI / 2 + (b.rand() - 0.5) * 0.7);
    b.human(POSE.STAND, 1.55 + 0.25 * b.rand(), sd * 17 + i);
    b.pop();
  }
  // a friar at the chapel door
  b.color(0.07, 0.06, 0.055);
  b.push(); b.at(-28.2, 0.02, 19, Math.PI / 2); b.human(POSE.STAND, 1.72, sd + 3); b.pop();
}

// ---------------------------------------------------------------------------- the module

export default {
  id: 'fleet-1492',
  name: 'The fleet of 1492',
  caption: 'Three ships leave harbour and stand out to sea',
  year: 1492,
  radius: RADIUS,
  pad: PAD,
  roadOffset: ROAD_OFF,
  straddlesRoad: false,
  biome: 'coast',
  lights: [],
  reach: 1300,
  detail: { at: [10, 2, -6], from: [-16, 6, 12] },
  strip: { at: [140, 6, 0], from: [-60, 14, 70], fov: 0.55 },
  // The event shot: from the land side, over the quay and the crowd, at the fleet (animate()
  // keeps these current: the sea side and the ships' progress change the framing).
  witness: {
    get at() { return WAT; },
    get dist() { return WIT[0]; },
    get az() { return WIT[1]; },
    get height() { return WIT[2]; },
    get look() { return WIT[3]; },
    fov: 0.55, drift: 0.05, range: 700,
  },
  satellites: {
    count: [5, 7], near: 2, nearR: [90, 170], farR: [220, 520],
    centre: 0, spread: 6, minSep: 60, roadClear: 32,
    build(b, k, n, dist) {
      b.timeless();
      const s = 1 + 0.6 * Math.min(1, dist / 500);
      b.push(); b.scale(s, s, s);
      house(b, 0, 0, 0, 3 + b.rand(), 2.4, 3.2, 1);
      if (k % 2 === 0) house(b, 7.5, 2, 0.3, 2.4, 2.2, 2.8, 1);
      b.pop();
    },
  },

  build(b, built, decay, seed) {
    b.timeless();
    // ships (rigs 1-3, no shadow: they live far out) and their wakes (rigs 4-6)
    b.rig(1, false); ship(b, true, 1);
    b.rig(2, false); ship(b, false, 1.02);
    b.rig(3, false); ship(b, false, 0.9);
    b.rig(4, false); wake(b, 21 * SHIP_SC, 7.2 * SHIP_SC, seed);
    b.rig(5, false); wake(b, 16.5 * SHIP_SC * 1.02, 5.4 * SHIP_SC, seed + 1);
    b.rig(6, false); wake(b, 16.5 * SHIP_SC * 0.9, 5.4 * SHIP_SC * 0.9, seed + 2);
    // the shore (rig 7: turned to face the sea)
    b.rig(7); shore(b, seed);
    b.rig(0);
    return b.counts();
  },

  animate(a) {
    if (a.handle !== ST.h || a.t < ST.t0) { ST.h = a.handle; ST.t0 = a.t; }
    const el = a.t - ST.t0, t = a.t;
    const sea = a.seaY > -1000;
    const sx = sea ? a.seaX : 1, y0 = sea ? a.seaY : -2.2;
    const sg = sx >= 0 ? 1 : -1;
    a.set(7, 0, 0, 0, sg > 0 ? 0 : Math.PI);
    // course: straight out along the sea direction, from a point DS m off the road. Probed on
    // six seeds, the open water begins 80-450 m from the road (the coast line is noise and
    // other roads keep land around them), so the line starts beyond the worst of those.
    let hx = sea ? a.seaX : 1, hz = sea ? a.seaZ : 0;
    const hl = Math.sqrt(hx * hx + hz * hz) || 1; hx /= hl; hz /= hl;
    const x0 = -ROAD_OFF + hx * DS, z0 = hz * DS;
    const d = RUN * (1 - Math.exp(-el / TAU_RUN));
    const yaw = Math.atan2(hx, hz);
    let mx = 0, mz = 0;
    for (let k = 0; k < 3; k++) {
      const o = k * 5, s = d + SHIPS[o], lat = SHIPS[o + 1] * sg;
      const x = x0 + hx * s - hz * lat, z = z0 + hx * lat + hz * s;
      const p1 = SHIPS[o + 2], p2 = SHIPS[o + 3], p3 = SHIPS[o + 4];
      const yy = y0 + 0.14 * Math.sin(t * 1.05 + p3);
      a.set(k + 1, x, yy, z, yaw + 0.025 * Math.sin(t * 0.21 + p1),
        0.013 * Math.sin(t * 0.74 + p2), 0.022 + 0.032 * Math.sin(t * 0.9 + p1), SHIP_SC);
      a.set(k + 4, x, y0 + 0.1, z, yaw, 0, 0, 1 / WAKE_K);
      if (k === 0) { mx = x; mz = z; }
    }
    // witness: look between the mole head and the Santa Maria, from 90 m behind the quay (the
    // crowd in the foreground, the chapel beside the eye on the other side, out of frame), a
    // little to the mole's side of the line to the fleet; high when the sea lies across the
    // road, so the ships show afloat over the land and houses between
    const qx = sg * 36, qz = -10.5 * sg;
    const ex = mx - qx, ez = mz - qz, len = Math.sqrt(ex * ex + ez * ez) || 1;
    WAT[0] = qx + 0.62 * ex; WAT[1] = qz + 0.62 * ez;
    WIT[0] = 0.62 * len + 90;
    WIT[1] = Math.atan2(-ez, ex) - 0.04 * sg;
    WIT[2] = sg > 0 ? 12 : 22;
    WIT[3] = sg > 0 ? -2 : -13;
  },
};
