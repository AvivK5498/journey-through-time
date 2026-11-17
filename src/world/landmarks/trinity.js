// Trinity (event 18, 1945): the first nuclear test, seen across a wide desert basin.
//
// built is a STEP at clock 267.4 (0 = the quiet site, 1 = the detonation); decay runs 0 -> 1
// over 267.6-276 and is the timeline of what follows.
//
// At the site (the pad, beside the road): an earth-covered observation bunker with a concrete
// face and a dark slit, a timber platform, a jeep, tyre tracks, a field cable on low posts
// running out toward the tower, creosote scrub and a handful of still figures facing it. At
// built 1 a couple of them crouch.
//
// Far out (ground zero GZ, ~2.4 km, all on rigs): a slender 30 m steel lattice tower with a
// cabin and a work lamp, instrument bunkers and cable runs. Rigs:
//   1 the flash (two additive cards, one rise and one decay)       built 1, decay 0-0.07
//   2 the fireball: white, yellow and orange shells dissolve in turn, the last cools to deep
//     red; an orange corona; it swells and rises with the cap     decay 0-0.55
//   3 the cap: shaded billows, glowing orange-brown inside early (gain), morphing per vertex
//     to sunlit pale grey and flattening; swells, climbs ~1.3 km and drifts downwind
//   4 the stem: dusty billows drawn up segment by segment under the rising cap, tilted with
//     the drift; dust smoke along it (constant rig scale: smoke never churns)
//   5 the ground: a dust ring surging outward in rings, settling late
//   6 soft smoke billows on the cap (constant scale, pop in one by one)
//   7 ground zero: tower, cabin, lamp (gone at the step), bunkers, cables, then a dish of
//     glassy grey-green ground and four footing stubs
// Sizes on rigs 3-6 are built at 1/100 (rig 7 at 1/10) so the bind pose stays in the radius.

import { SURF, POSE, FLICKER, MOTION, BY, seg, ease, fbm3, noise3 } from './kit.js';

const GX = 1000, GZ = -2180; // ground zero, local metres (ahead and to the right of the road)
const WX = 0.902, WZ = 0.431; // drift (and smoke wind) direction
const UX = 0.417, UZ = -0.909; // from the observation post toward GZ
const YAW_U = Math.atan2(UX, UZ), YAW_W = Math.atan2(WX, WZ);
const S_STEM = 100, S_RING = 100, S_PUFF = 84, S_GZ = 10;

// Cap centre height (m) over decay and its inverse; drift downwind (m); cap rig scale.
function ycap(d) { return 60 + 950 * (1 - Math.pow(1 - d, 2.4)); }
function dAt(y) { const k = Math.min(1, Math.max(0, (y - 60) / 950)); return 1 - Math.pow(1 - k, 1 / 2.4); }
function drift(d) { const k = seg(d, 0.3, 1); return 420 * k * k; }
function capScale(d) { return 26 + 58 * ease(seg(d, 0.07, 0.48)) + 8 * seg(d, 0.48, 1); }

// --- billow: a lat-long ellipsoid with soft noise displacement, written vertex by vertex
// in the current transform so paint(dx, dy, dz, x, y, z) can set colour, emissive, ao and a
// MORPH target per vertex (x, y, z: the vertex in the builder's local space).
function billow(b, cx, cy, cz, rx, ry, rz, nLat, nLon, rough, sd, paint) {
  const W = nLon + 1, N = (nLat + 1) * W;
  const P = new Float64Array(N * 3), D = new Float64Array(N * 3);
  for (let i = 0; i <= nLat; i++) {
    const th = Math.PI * i / nLat, st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j <= nLon; j++) {
      const ph = 2 * Math.PI * (j % nLon) / nLon;
      const dx = st * Math.cos(ph), dy = ct, dz = st * Math.sin(ph);
      const n = fbm3(dx * 1.6 + sd * 3.1, dy * 1.6 + sd * 1.7, dz * 1.6 - sd * 2.3, 3);
      const n2 = noise3(dx * 4.3 + sd, dy * 4.3 - sd, dz * 4.3 + 7);
      const r = 1 + rough * ((n - 0.5) * 2.4 + (n2 - 0.5) * 0.7);
      const o = (i * W + j) * 3;
      P[o] = cx + dx * rx * r; P[o + 1] = cy + dy * ry * r; P[o + 2] = cz + dz * rz * r;
      D[o] = dx; D[o + 1] = dy; D[o + 2] = dz;
    }
  }
  let first = -1;
  for (let i = 0; i <= nLat; i++) {
    for (let j = 0; j <= nLon; j++) {
      const o = (i * W + j) * 3, dx = D[o], dy = D[o + 1], dz = D[o + 2];
      let nx = dx / rx, ny = dy / ry, nz = dz / rz;
      if (i > 0 && i < nLat) {
        const jp = (i * W + (j === nLon ? 1 : j + 1)) * 3, jm = (i * W + (j === 0 ? nLon - 1 : j - 1)) * 3;
        const ip = ((i + 1) * W + j) * 3, im = ((i - 1) * W + j) * 3;
        const tx = P[jp] - P[jm], ty = P[jp + 1] - P[jm + 1], tz = P[jp + 2] - P[jm + 2];
        const sx = P[ip] - P[im], sy = P[ip + 1] - P[im + 1], sz = P[ip + 2] - P[im + 2];
        let cx2 = sy * tz - sz * ty, cy2 = sz * tx - sx * tz, cz2 = sx * ty - sy * tx;
        if (cx2 * dx + cy2 * dy + cz2 * dz < 0) { cx2 = -cx2; cy2 = -cy2; cz2 = -cz2; }
        const l = Math.hypot(cx2, cy2, cz2);
        if (l > 1e-9) { nx = cx2; ny = cy2; nz = cz2; }
      }
      if (paint) paint(dx, dy, dz, P[o], P[o + 1], P[o + 2]);
      const v = b.vertex(P[o], P[o + 1], P[o + 2], nx, ny, nz);
      if (v < 0) return;
      if (first < 0) first = v;
    }
  }
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = first + i * W + j;
      if (i === 0) b.tri(a, a + W + 1, a + W);
      else if (i === nLat - 1) b.tri(a, a + 1, a + W);
      else b.quad(a, a + 1, a + W + 1, a + W);
    }
  }
}

// One smoke puff with its own phase (kit smoke's `phase` option) and exact size.
const PC = [0, 0, 0];
function puff(b, x, y, z, size, rise, den, r, g, bl) {
  PC[0] = r; PC[1] = g; PC[2] = bl;
  b.smoke(x, y, z, { count: 1, size, rise, density: den, color: PC, src: FLICKER.NONE, phase: b.rand(), spread: 0 });
}

// Flat ribbon on the ground through a polyline (tyre ruts), offset sideways by `off`.
function ribbon(b, P, off, w, y) {
  let prev = -1;
  for (let i = 0; i < P.length; i += 2) {
    const i0 = Math.max(0, i - 2), i1 = Math.min(P.length - 2, i + 2);
    let tx = P[i1] - P[i0], tz = P[i1 + 1] - P[i0 + 1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = -tz, nz = tx, cx = P[i] + nx * off, cz = P[i + 1] + nz * off;
    const a = b.vertex(cx - nx * w, y, cz - nz * w, 0, 1, 0);
    b.vertex(cx + nx * w, y, cz + nz * w, 0, 1, 0);
    if (prev >= 0 && a >= 0) b.quad(prev, prev + 1, a + 1, a);
    prev = a;
  }
}

// Earth-covered bunker: a low mound with a concrete face and a dark slit, facing local +z.
// Sunk deep so it sits on uneven ground.
function bunker(b, L, Hh, D, sd, g) {
  b.surface(SURF.EARTH).ao(1).color(g[0] * 0.78, g[1] * 0.7, g[2] * 0.62);
  b.push(); b.translate(0, -Hh * 0.9, 0); b.rock(L, Hh * 1.9, D, 4, 0.12, sd, 0, 0); b.pop();
  b.surface(SURF.PLASTER).ao(0.95).color(0.36, 0.345, 0.32);
  b.box(0, Hh * 0.42, D * 0.86, L * 0.42, Hh * 0.62, D * 0.1);
  b.surface(SURF.PLAIN).ao(0.4).color(0.025, 0.022, 0.02);
  b.box(0, Hh * 0.62, D * 0.97, L * 0.3, Hh * 0.07, D * 0.012);
}

export default {
  id: 'trinity',
  name: 'Trinity test',
  caption: 'The first nuclear test lights the desert',
  year: 1945,
  radius: 46,
  pad: 44,
  straddlesRoad: false,
  biome: 'desert',
  reach: 3900,
  wind: [WX, WZ],
  viewSunAz: 2.2,
  lights: [
    // the flash on everything at the post (geometry only): on at the step, gone by decay 0.06
    { pos: [UX * 90, 40, UZ * 90], color: [1, 0.96, 0.9], intensity: 70000, range: 160, flicker: 0, appear: [0.4, 0.5], vanish: [0, 0.06] },
  ],
  detail: { at: [20, 1.0, -12], from: [30, 1.9, -1] },
  strip: { at: [GX * 0.5, 420, GZ * 0.5], from: [-30, 3, 40], fov: 0.95 },
  // From beside and above the bunker, over the observers' shoulders toward GZ (the eye is ~84 m
  // from the look-at point on the same line, so the push-in moves it only 4 m).
  witness: { at: [44, -61.5], dist: 84, az: 1.27, height: 5.2, look: 10, fov: 0.8, drift: 0.02 },
  satellites: {
    count: [4, 6], near: 2, nearR: [140, 300], farR: [420, 1100],
    centre: Math.atan2(UZ, UX), spread: 1.5, minSep: 130, roadClear: 45,
    build(b, k, n, dist) {
      const g = b.bio('ground'), sc = 1 + dist / 900;
      b.timeless().push(); b.scale(sc);
      bunker(b, 4.5, 1.7, 3.2, 31 + k, g);
      if (k % 2 === 0) { // a timber camera pole with its box
        b.surface(SURF.WOOD).ao(1).color(0.2, 0.15, 0.1);
        b.beam(3.5, -0.5, -2.5, 3.5, 7, -2.5, 0.13, 0.1, 5);
        b.beam(3.5, 6.2, -2.5, 4.4, 6.2, -2.5, 0.06, 0.06, 4);
        b.surface(SURF.PLAIN).color(0.1, 0.1, 0.09);
        b.box(4.4, 6.55, -2.5, 0.35, 0.3, 0.3);
      }
      b.pop();
    },
  },

  build(b, built, decay, seed) {
    const g = b.bio('ground'), soil = b.bio('soil');
    b.timeless().rig(0).identity();

    // ---------------- the observation post (static, on the pad) ----------------
    const BX = 14, BZ = 4; // bunker centre
    // tyre tracks: from near the road to the post, round the bunker and out toward GZ
    const TR = [-33, 27, -26, 26, -14, 19, -4, 14, 4, 11, 9, 5.5, 13, -3, 17, -10, 21, -19, 25, -28, 28.5, -35];
    b.surface(SURF.EARTH).ao(1).color(g[0] * 0.62, g[1] * 0.55, g[2] * 0.5);
    ribbon(b, TR, -0.78, 0.17, 0.025);
    ribbon(b, TR, 0.78, 0.17, 0.025);
    // a trampled apron in front of the bunker
    b.push(); b.translate(BX + UX * 9, 0, BZ + UZ * 9);
    b.disc(9, 20, 3, (x, z) => { const r = Math.hypot(x, z) / 9; const k = 0.86 + 0.14 * r; b.color(g[0] * k, g[1] * k * 0.97, g[2] * k * 0.95); return 0.02; });
    b.pop();

    // observation bunker (long axis across the line of sight)
    b.push(); b.at(BX, 0, BZ, YAW_U);
    b.surface(SURF.EARTH).ao(1).color(g[0] * 0.8, g[1] * 0.72, g[2] * 0.64);
    b.push(); b.translate(0, -1.6, -0.5); b.rock(6.8, 3.9, 4.6, 6, 0.14, seed + 3, 0, 0); b.pop();
    b.surface(SURF.PLASTER).ao(0.95).color(0.37, 0.355, 0.33);
    b.box(0, 1.1, 4.2, 4.6, 1.25, 0.35); // concrete face
    b.box(-4.9, 0.6, 3.7, 0.35, 0.75, 0.9); // wing walls
    b.box(4.9, 0.6, 3.7, 0.35, 0.75, 0.9);
    b.surface(SURF.PLAIN).ao(0.3).color(0.02, 0.02, 0.018);
    b.box(0.8, 1.55, 4.56, 2.8, 0.16, 0.02); // the viewing slit
    b.box(-3.2, 0.95, 4.56, 0.5, 0.95, 0.02); // door
    b.surface(SURF.WOOD).ao(0.9).color(0.2, 0.15, 0.1);
    b.box(-3.2, 1.95, 4.6, 0.62, 0.06, 0.06); // lintel
    b.surface(SURF.PLAIN).ao(1).color(0.1, 0.1, 0.09);
    b.beam(1.5, 2.4, 1.2, 1.5, 3.3, 1.2, 0.07, 0.07, 6); // periscope
    b.box(1.5, 3.35, 1.32, 0.11, 0.09, 0.16);
    // sandbags along the face
    b.surface(SURF.HIDE).color(g[0] * 0.75, g[1] * 0.66, g[2] * 0.5);
    for (let i = 0; i < 9; i++) { b.push(); b.translate(-4.2 + i * 1.05 + (i > 2 ? 0.0 : 0), 0.2, 4.85); b.ellipsoid(0.5, 0.22, 0.32, 2); b.pop(); }
    // a cable reel by the door
    b.surface(SURF.WOOD).ao(0.9).color(0.22, 0.16, 0.1);
    b.push(); b.translate(-5.6, 0.55, 5.4); b.rotateZ(Math.PI / 2); b.translate(0, -0.3, 0); b.cylinder(0.55, 0.6, 12); b.pop();
    b.pop();

    // field cable on low posts from the bunker face out toward GZ
    {
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k < 6; k++) {
        const t = 6 + k * 6.2, x = BX + UX * t + 2.2 * (UZ), z = BZ + UZ * t - 2.2 * UX;
        b.surface(SURF.WOOD).ao(1).color(0.19, 0.14, 0.09);
        b.beam(x, -0.2, z, x, 0.85, z, 0.055, 0.045, 5);
        b.surface(SURF.PLAIN).color(0.05, 0.05, 0.05);
        if (k > 0) {
          const mx = (px + x) / 2, mz = (pz + z) / 2;
          b.beam(px, py, pz, mx, 0.62, mz, 0.014, 0.014, 3, false);
          b.beam(mx, 0.62, mz, x, 0.8, z, 0.014, 0.014, 3, false);
        }
        px = x; py = 0.8; pz = z;
      }
    }

    // the signal line: poles with a crossarm and two sagging wires, from beyond the observers
    // out to the edge of the pad toward GZ (rig 7 carries it on from the tower's end), so the
    // eye follows it to the tower before the flash
    {
      let px = 0, pz = 0;
      for (let k = 0; k < 6; k++) {
        const t = 14 + k * 5, x = BX + UX * t - 3.2 * UZ, z = BZ + UZ * t + 3.2 * UX, h = 3.4;
        b.surface(SURF.WOOD).ao(1).color(0.17, 0.13, 0.085);
        b.beam(x, -0.3, z, x, h, z, 0.09, 0.07, 5);
        b.beam(x - 0.6 * UZ, h - 0.25, z + 0.6 * UX, x + 0.6 * UZ, h - 0.25, z - 0.6 * UX, 0.045, 0.045, 4);
        if (k > 0) {
          b.surface(SURF.PLAIN).color(0.04, 0.04, 0.04);
          for (const sd of [-0.5, 0.5]) {
            const ax = px + sd * UZ, az = pz - sd * UX, cx = x + sd * UZ, cz = z - sd * UX;
            b.beam(ax, h - 0.2, az, (ax + cx) / 2, h - 0.55, (az + cz) / 2, 0.012, 0.012, 3, false);
            b.beam((ax + cx) / 2, h - 0.55, (az + cz) / 2, cx, h - 0.2, cz, 0.012, 0.012, 3, false);
          }
        }
        px = x; pz = z;
      }
    }

    // timber platform with an observer on it
    {
      const x0 = BX + UZ * 12.5 + UX, z0 = BZ - UX * 12.5 + UZ;
      b.push(); b.at(x0, 0, z0, YAW_U);
      b.surface(SURF.WOOD).ao(1).color(0.21, 0.16, 0.1);
      for (const sx of [-1.1, 1.1]) for (const sz of [-1.1, 1.1]) b.beam(sx, -0.3, sz, sx * 0.9, 3.2, sz * 0.9, 0.09, 0.08, 5);
      b.box(0, 3.15, 0, 1.25, 0.07, 1.25);
      b.beam(-1.0, 1.0, 1.0, 1.0, 2.6, 1.0, 0.04, 0.04, 4); b.beam(1.0, 1.0, 1.0, -1.0, 2.6, 1.0, 0.04, 0.04, 4);
      b.beam(-1.0, 1.0, -1.0, 1.0, 2.6, -1.0, 0.04, 0.04, 4);
      b.beam(-1.15, 4.0, 1.15, 1.15, 4.0, 1.15, 0.035, 0.035, 4); // rail
      for (let r = 0; r < 7; r++) b.beam(-0.35, 0.4 * r + 0.3, -1.4, 0.35, 0.4 * r + 0.3, -1.4, 0.03, 0.03, 4); // ladder rungs
      b.beam(-0.35, 0, -1.45, -0.35, 3.2, -1.2, 0.04, 0.04, 4); b.beam(0.35, 0, -1.45, 0.35, 3.2, -1.2, 0.04, 0.04, 4);
      b.surface(SURF.HIDE).color(0.17, 0.15, 0.1);
      b.push(); b.translate(0.2, 3.22, 0.3); b.human(POSE.STAND, 1.76, seed + 40); b.pop();
      b.pop();
    }

    // jeep parked by the tracks
    {
      b.push(); b.at(-8, 0, 22.5, 2.05);
      b.surface(SURF.PLAIN).ao(1).color(0.11, 0.12, 0.075);
      b.box(0, 0.78, 0, 0.78, 0.3, 1.65); // body
      b.box(0, 0.98, 1.15, 0.7, 0.14, 0.5); // bonnet
      b.box(0, 0.8, 1.66, 0.62, 0.22, 0.04); // grille
      b.box(0, 1.33, 0.55, 0.72, 0.28, 0.025); // windscreen frame
      b.surface(SURF.PLAIN).color(0.03, 0.03, 0.03);
      for (const sx of [-0.78, 0.78]) for (const sz of [-1.05, 1.05]) { b.push(); b.translate(sx, 0.38, sz); b.rotateZ(Math.PI / 2); b.translate(0, -0.13, 0); b.cylinder(0.38, 0.26, 10); b.pop(); }
      b.surface(SURF.HIDE).color(0.13, 0.13, 0.09);
      b.push(); b.translate(0, 1.05, -1.75); b.rotateZ(Math.PI / 2); b.translate(0, -0.12, 0); b.cylinder(0.36, 0.24, 10); b.pop(); // spare
      b.pop();
    }

    // the observers: still, facing GZ; at the step two of them crouch
    {
      const cx = BX + UX * 17, cz = BZ + UZ * 17;
      const SPOT = [-5.2, 0.6, -2.6, -0.8, -0.4, 0.5, 2.4, -0.3, 4.6, 0.9];
      const TONE = [0.16, 0.15, 0.1, 0.44, 0.42, 0.38, 0.13, 0.14, 0.1, 0.2, 0.17, 0.12, 0.4, 0.38, 0.34];
      for (let i = 0; i < 5; i++) {
        const lx = SPOT[i * 2], lz = SPOT[i * 2 + 1];
        const x = cx + lx * UZ + lz * UX, z = cz - lx * UX + lz * UZ; // across / along the sight line
        const yaw = YAW_U + (b.rand() - 0.5) * 0.4, h = 1.68 + 0.14 * b.rand();
        b.surface(SURF.HIDE).ao(1).color(TONE[i * 3], TONE[i * 3 + 1], TONE[i * 3 + 2]);
        const crouch = i === 1 || i === 3;
        b.push(); b.at(x, 0, z, yaw);
        if (crouch) b.vanish(0.4, 0.45, MOTION.POP, 0, BY.BUILT);
        b.human(POSE.STAND, h, seed + 10 + i);
        b.timeless();
        if (crouch) { b.appear(0.4, 0.45, MOTION.POP, 0, BY.BUILT); b.rotateY(Math.PI); b.human(POSE.KNEEL, h, seed + 20 + i); b.timeless(); }
        b.pop();
      }
      // a theodolite on its tripod beside them
      b.push(); b.at(cx + 3.6 * UZ - 1.4 * UX, 0, cz - 3.6 * UX - 1.4 * UZ, YAW_U);
      b.surface(SURF.WOOD).ao(1).color(0.24, 0.18, 0.11);
      for (let k = 0; k < 3; k++) { const a = k * 2.094; b.beam(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, 0, 1.35, 0, 0.025, 0.02, 4); }
      b.surface(SURF.PLAIN).color(0.08, 0.08, 0.07);
      b.box(0, 1.45, 0, 0.09, 0.1, 0.18);
      b.pop();
    }

    // creosote scrub
    b.surface(SURF.THATCH).ao(0.9);
    for (let i = 0; i < 16; i++) {
      const a = b.rand() * Math.PI * 2, r = 12 + 30 * Math.sqrt(b.rand());
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (x < -40 || Math.hypot(x - BX, z - BZ) < 11 || Math.hypot(x - BX - UX * 17, z - BZ - UZ * 17) < 9) continue;
      const s = 0.45 + 0.5 * b.rand();
      b.color(0.075 + 0.03 * b.rand(), 0.085 + 0.02 * b.rand(), 0.045);
      b.push(); b.translate(x, 0.25 * s, z); b.rock(0.9 * s, 0.6 * s, 0.85 * s, 3, 0.35, seed + 60 + i, 0, 0); b.pop();
    }

    // ---------------- rig 7: ground zero, at 1/10 ----------------
    b.timeless().rig(7, false).identity();
    // tower: four legs carried 25 m below ground (the terrain out there is not flat), girts
    // and X bracing; gone at the step
    b.vanish(0.4, 0.45, MOTION.POP, 0, BY.BUILT);
    b.surface(SURF.PLAIN).ao(1).color(0.15, 0.15, 0.15);
    const hw = (y) => 0.35 - 0.0733 * y;
    for (let k = 0; k < 4; k++) {
      const sx = k === 1 || k === 2 ? 1 : -1, sz = k >= 2 ? 1 : -1;
      b.beam(sx * hw(-2.5), -2.5, sz * hw(-2.5), sx * hw(3), 3, sz * hw(3), 0.032, 0.022, 5);
    }
    for (let l = 0; l <= 6; l++) {
      const y0 = l * 0.5, y1 = y0 + 0.5, a = hw(y0), c = hw(y1);
      for (let f = 0; f < 4; f++) {
        const ax = f === 0 ? -1 : f === 1 ? 1 : f === 2 ? 1 : -1, az = f === 0 ? -1 : f === 1 ? -1 : f === 2 ? 1 : 1;
        const bx = f === 0 ? 1 : f === 1 ? 1 : f === 2 ? -1 : -1, bz = f === 0 ? -1 : f === 1 ? 1 : f === 2 ? 1 : -1;
        b.beam(ax * a, y0, az * a, bx * a, y0, bz * a, 0.012, 0.012, 4, false);
        if (l < 6) {
          b.beam(ax * a, y0, az * a, bx * c, y1, bz * c, 0.009, 0.009, 4, false);
          b.beam(bx * a, y0, bz * a, ax * c, y1, az * c, 0.009, 0.009, 4, false);
        }
      }
    }
    b.box(0, 3.0, 0, 0.21, 0.012, 0.21); // platform
    b.color(0.42, 0.41, 0.38); b.box(0, 3.13, 0, 0.14, 0.11, 0.14); // corrugated cabin
    b.color(0.3, 0.3, 0.29); b.box(0, 3.255, 0, 0.165, 0.015, 0.165); // roof
    b.color(0.12, 0.12, 0.12); b.beam(0, 3.27, 0, 0, 3.45, 0, 0.006, 0.006, 3); // hoist mast
    b.flash(0.16, 3.2, 0.16, 0.05, 3, 0.32, 0.27, 0.19); // work lamp
    b.surface(SURF.WOOD).ao(1).color(0.22, 0.17, 0.11);
    b.box(0.9, 0.12, 0.6, 0.22, 0.16, 0.15); // shack at the foot
    b.timeless();
    // footing stubs and the glassy dish, from the step on
    b.appear(0.4, 0.45, MOTION.POP, 0, BY.BUILT);
    b.surface(SURF.PLASTER).ao(1).color(0.3, 0.29, 0.27);
    for (let k = 0; k < 4; k++) { const sx = k === 1 || k === 2 ? 1 : -1, sz = k >= 2 ? 1 : -1; b.box(sx * 0.35, -0.2, sz * 0.35, 0.05, 0.25, 0.05); }
    b.surface(SURF.PLAIN).ao(1);
    b.disc(26, 40, 9, (x, z) => {
      const r = Math.hypot(x, z) / 26, w = 0.5 + 0.5 * noise3(x * 0.4, 3, z * 0.4);
      const glass = 1 - seg(r, 0.25 + 0.15 * w, 0.62), scorch = 1 - seg(r, 0.55, 1);
      const sr = g[0] * (1 - 0.45 * scorch), sg = g[1] * (1 - 0.42 * scorch), sb = g[2] * (1 - 0.4 * scorch);
      b.color(sr + (0.15 - sr) * glass, sg + (0.2 - sg) * glass, sb + (0.16 - sb) * glass);
      return 0.03 - 0.18 * r * r;
    });
    b.timeless();
    // instrument bunkers and cable runs on low posts
    const BK = [8.5, 6, 0.9, -13, 9, 2.6, 5, -16, -0.3];
    for (let k = 0; k < 3; k++) {
      const x = BK[k * 3], z = BK[k * 3 + 1];
      b.push(); b.at(x, 0, z, Math.atan2(-x, -z)); b.translate(0, -0.15, 0);
      bunker(b, 0.55, 0.32, 0.4, seed + 80 + k, g); b.pop();
      const n = Math.floor(Math.hypot(x, z) / 0.9);
      let qx = 0, qz = 0;
      for (let i = 1; i < n; i++) {
        const t = i / n, px = x * t + 0.4 * Math.sin(t * 9 + k), pz = z * t + 0.4 * Math.cos(t * 7 + k);
        b.surface(SURF.WOOD).color(0.19, 0.14, 0.09);
        b.beam(px, -1.0, pz, px, 0.09, pz, 0.006, 0.005, 3, false);
        if (i > 1) { b.surface(SURF.PLAIN).color(0.05, 0.05, 0.05); b.beam(qx, 0.08, qz, px, 0.08, pz, 0.003, 0.003, 3, false); }
        qx = px; qz = pz;
      }
    }

    // the signal line's far end: poles every 30 m from 40 to 450 m out of GZ toward the post
    // (6 m tall, footings 25 m deep for the uneven ground), at 1/10
    {
      let px = 0, pz = 0;
      for (let k = 0; k < 14; k++) {
        const t = 4 + k * 3, x = -UX * t - 0.5 * UZ, z = -UZ * t + 0.5 * UX;
        b.surface(SURF.WOOD).ao(1).color(0.17, 0.13, 0.085);
        b.beam(x, -2.5, z, x, 0.6, z, 0.018, 0.013, 4, false);
        b.beam(x - 0.07 * UZ, 0.57, z + 0.07 * UX, x + 0.07 * UZ, 0.57, z - 0.07 * UX, 0.008, 0.008, 3, false);
        if (k > 0) { b.surface(SURF.PLAIN).color(0.04, 0.04, 0.04); b.beam(px, 0.55, pz, x, 0.55, z, 0.003, 0.003, 3, false); }
        px = x; pz = z;
      }
    }

    // ---------------- rig 1: the flash ----------------
    b.timeless().rig(1, false).identity();
    b.flash(0, 0, 0, 220, 80, 1, 0.97, 0.92); // white-hot core
    b.flash(0, 0, 0, 2600, 255, 0.13, 0.127, 0.12); // the wash over the basin

    // ---------------- rig 2: the fireball (unit radius) ----------------
    b.rig(2, false).identity().surface(SURF.PLAIN).ao(1);
    // white-hot skin, dissolving first
    b.vanish(0.012, 0.055, MOTION.FADE, 0, BY.DECAY);
    billow(b, 0, 0, 0, 1, 1, 1, 14, 24, 0.06, 1.3, (dx, dy, dz) => {
      const n = noise3(dx * 5 + 1, dy * 5, dz * 5); b.color(1, 0.96 - 0.04 * n, 0.86 - 0.1 * n).emissive(0.75 + 0.25 * n, 0);
    });
    // yellow under it
    b.vanish(0.05, 0.11, MOTION.FADE, 0, BY.DECAY);
    billow(b, 0, 0, 0, 0.985, 0.985, 0.985, 14, 24, 0.06, 1.3, (dx, dy, dz) => {
      const n = noise3(dx * 4.6 + 4, dy * 4.6, dz * 4.6 - 2); b.color(1, 0.7 + 0.16 * n, 0.22 + 0.15 * n).emissive(0.32 + 0.3 * n, 0);
    });
    // orange, cooling to a deep red (MORPH colour, height unchanged)
    b.vanish(0.1, 0.36, MOTION.MORPH, 0, BY.DECAY);
    billow(b, 0, 0, 0, 0.97, 0.97, 0.97, 14, 24, 0.06, 1.3, (dx, dy, dz, x, y) => {
      const n = noise3(dx * 4.2 - 3, dy * 4.2 + 1, dz * 4.2), k = 0.55 + 0.45 * n;
      b.color(1, 0.3 + 0.16 * n, 0.06 + 0.04 * n).emissive(0.12 + 0.2 * k, 0);
      b.morph(y, y, 0.2 * k + 0.1, 0.07 * k + 0.05, 0.04);
    });
    b.timeless();
    b.flash(0, 0, 0, 2.6, 16, 1, 0.5, 0.18); // corona

    // ---------------- rig 3: the cap (unit = 1 m at scale 1; ~100 m at full size) --------------
    b.rig(3, false).identity().surface(SURF.PLAIN);
    b.vanish(0.1, 0.56, MOTION.MORPH, 0, BY.DECAY);
    const capPaint = (dx, dy, dz, x, y, z) => {
      const r = Math.hypot(x, z), up = Math.max(0, dy), dn = Math.max(0, -dy);
      const inner = 1 - seg(r, 2.5, 5.5), under = seg(-y, -0.2, 1.4);
      const n = noise3(x * 0.9 + 5, y * 0.9, z * 0.9);
      // glowing fireball brown early (emissive follows the rig's gain)
      b.color(0.5 + 0.1 * n, 0.2 + 0.06 * n, 0.08).emissive(0.06 + 0.22 * (dn * 0.6 + inner * 0.5) * (0.7 + 0.6 * n), 0);
      b.ao(1 - 0.3 * under - 0.1 * dn);
      // sunlit pale above, dusty below
      const p = 0.62 + 0.24 * up + 0.07 * n - 0.32 * under - 0.12 * dn;
      const yT = y > 0 ? y * 0.58 : y * 0.85;
      b.morph(y, yT, p * 1.0, p * 0.96 - 0.02 * under, p * 0.92 - 0.05 * under);
    };
    // the rolling torus: many smaller, overlapping lobes at two radii (a turbulent roll, not a
    // ring of balls), the rolled-under lip, then the dome heaped on top
    for (let i = 0; i < 26; i++) {
      const a = i / 26 * Math.PI * 2 + 0.25 * b.rand(), R = (i & 1 ? 4.3 : 3.3) + 0.4 * b.rand(), s = 0.8 + 0.45 * b.rand();
      billow(b, Math.cos(a) * R, (i & 1 ? 0.05 : 0.55) + 0.35 * b.rand(), Math.sin(a) * R, 1.25 * s, 1.0 * s, 1.25 * s, 8, 12, 0.32, i * 1.7 + 0.3, capPaint);
    }
    for (let i = 0; i < 18; i++) {
      const a = (i + 0.5) / 18 * Math.PI * 2 + 0.2 * b.rand(), R = 4.8 + 0.5 * b.rand(), s = 0.7 + 0.4 * b.rand();
      billow(b, Math.cos(a) * R, -0.55 - 0.3 * b.rand(), Math.sin(a) * R, 1.0 * s, 0.7 * s, 1.0 * s, 7, 10, 0.32, i * 2.3 + 9, capPaint);
    }
    for (let i = 0; i < 15; i++) {
      const a = i / 15 * Math.PI * 2 * 2.3 + 0.4, R = 0.6 + 2.4 * Math.sqrt((i + 0.5) / 15), s = 0.8 + 0.4 * b.rand();
      billow(b, Math.cos(a) * R, 1.25 + 0.9 * (1 - R / 3) + 0.3 * b.rand(), Math.sin(a) * R, 1.25 * s, 1.0 * s, 1.25 * s, 8, 12, 0.3, i * 3.1 + 20, capPaint);
    }
    billow(b, 0, 1.6, 0, 2.2, 1.5, 2.2, 10, 16, 0.24, 40, capPaint);
    billow(b, 0, -0.6, 0, 3.3, 1.0, 3.3, 8, 16, 0.15, 44, capPaint); // the dark underside

    // ---------------- rig 4: the stem (constant scale 100) ----------------
    b.timeless().rig(4, false).identity().surface(SURF.PLAIN);
    {
      const dc = [g[0] * 0.92, g[1] * 0.8, g[2] * 0.7];
      // skirt of dust at the foot
      for (let i = 0; i < 13; i++) {
        const a = i / 13 * Math.PI * 2 + 0.3 * b.rand(), s = 0.7 + 0.45 * b.rand(), R = i & 1 ? 1.5 : 0.85;
        b.appear(0.02 + 0.006 * i, 0.12 + 0.008 * i, MOTION.SCALE, 0, BY.DECAY).pivot(Math.cos(a) * R, 0, Math.sin(a) * R);
        billow(b, Math.cos(a) * R, 0.1, Math.sin(a) * R, 0.95 * s, 0.5 * s, 0.95 * s, 7, 12, 0.3, 60 + i, (dx, dy) => {
          b.color(dc[0] * (0.82 + 0.15 * dy), dc[1] * (0.82 + 0.15 * dy), dc[2] * (0.82 + 0.15 * dy)).ao(0.75 + 0.25 * Math.max(0, dy));
        });
      }
      // the column, drawn up behind the cap
      for (let i = 0; i < 23; i++) {
        const h = 0.6 + i * 0.5, w = 0.48 + 0.12 * b.rand() + 0.25 * seg(h, 9, 12.5) + 0.3 * (1 - seg(h, 0.6, 2.5));
        const t0 = dAt(h * 100 + 140);
        if (h * 100 + 140 > 1000) continue;
        for (let q = 0; q < 2; q++) { // two lobes per level, offset and of different sizes: a ragged column
          const a = b.rand() * 6.283, o = w * (0.25 + 0.3 * b.rand()), ox = Math.cos(a) * o, oz = Math.sin(a) * o;
          const ww = w * (q ? 0.62 + 0.2 * b.rand() : 0.85 + 0.15 * b.rand()), hh = h + (b.rand() - 0.5) * 0.3;
          b.appear(t0, Math.min(1, t0 + 0.05), MOTION.SCALE, 0, BY.DECAY).pivot(ox, hh, oz);
          billow(b, ox, hh, oz, ww, 0.5, ww, 7, 10, 0.34, 70 + i * 1.3 + q * 0.7, (dx, dy, dz) => {
            const k = 0.72 + 0.16 * dx * 0.7 + 0.1 * dy;
            b.color(dc[0] * k, dc[1] * k * 0.98, dc[2] * k * 0.96).ao(0.85);
          });
        }
      }
      // dust along it
      for (let i = 0; i < 40; i++) {
        const h = 0.2 + (i / 40) * 8.4, t0 = Math.min(0.9, dAt(h * 100 + 200));
        const a = b.rand() * 6.283, r = 0.35 + 0.2 * b.rand();
        b.appear(t0, Math.min(1, t0 + 0.012), MOTION.POP, 0, BY.DECAY);
        puff(b, Math.cos(a) * r, h, Math.sin(a) * r, 0.45 + 0.2 * b.rand(), 1, 0.32, 0.5, 0.41, 0.33);
      }
    }

    // ---------------- rig 5: the ground surge (constant scale 100) ----------------
    b.timeless().rig(5, false).identity().surface(SURF.PLAIN);
    {
      const RR = [1.6, 0.0, 0.07, 2.9, 0.04, 0.14, 4.3, 0.09, 0.24, 5.8, 0.15, 0.36, 7.3, 0.22, 0.5];
      for (let ring = 0; ring < 5; ring++) {
        const R = RR[ring * 3], t0 = RR[ring * 3 + 1], t1 = RR[ring * 3 + 2], n = 7 + ring * 4;
        const fade0 = ring < 2 ? 0.86 : 0.58 + 0.05 * ring;
        for (let i = 0; i < n; i++) {
          const a = (i + 0.5 * (ring & 1)) / n * Math.PI * 2 + 0.1 * b.rand(), s = 0.8 + 0.4 * b.rand();
          const x = Math.cos(a) * R, z = Math.sin(a) * R, ry = (0.42 - 0.04 * ring) * s;
          b.appear(t0, t1, MOTION.SCALE, 0, BY.DECAY).vanish(fade0 + 0.03 * b.rand(), Math.min(1, fade0 + 0.3), MOTION.GROW, 0, BY.DECAY).pivot(x, -0.1, z);
          billow(b, x, -0.05, z, (0.95 + 0.1 * ring) * s, ry, (0.75 + 0.05 * ring) * s, 6, 10, 0.25, 100 + ring * 13 + i, (dx, dy) => {
            const k = 0.66 + 0.2 * Math.max(0, dy);
            b.color(g[0] * k, g[1] * k * 0.93, g[2] * k * 0.86).ao(0.8 + 0.2 * Math.max(0, dy));
          });
        }
        for (let i = 0; i < n; i++) { // dust puffs on the ring
          const a = (i + 0.3) / n * Math.PI * 2;
          b.timeless().appear(t1 - 0.02, t1 - 0.01, MOTION.POP, 0, BY.DECAY).vanish(fade0 + 0.1, fade0 + 0.11, MOTION.POP, 0, BY.DECAY);
          puff(b, Math.cos(a) * (R + 0.3), 0.2, Math.sin(a) * (R + 0.3), 0.5, 0.5, 0.3, 0.55, 0.45, 0.36);
        }
      }
    }

    // ---------------- rig 6: billows of smoke on the cap (constant scale 100) ----------------
    b.timeless().rig(6, false).identity();
    for (let i = 0; i < 110; i++) {
      const u = b.rand(), a = b.rand() * Math.PI * 2;
      let x, y, z;
      if (u < 0.5) { const R = 4.6 + 1.2 * b.rand(); x = Math.cos(a) * R; z = Math.sin(a) * R; y = -0.5 + 1.3 * b.rand(); }
      else if (u < 0.8) { const R = 2.6 * Math.sqrt(b.rand()); x = Math.cos(a) * R; z = Math.sin(a) * R; y = 1.6 + 0.9 * b.rand(); }
      else { const R = 3.0 + 1.8 * b.rand(); x = Math.cos(a) * R; z = Math.sin(a) * R; y = -1.1 - 0.3 * b.rand(); }
      const t0 = 0.36 + 0.3 * (i / 110);
      b.timeless().appear(t0, t0 + 0.012, MOTION.POP, 0, BY.DECAY);
      const pale = y > 0 ? 1 : 0.78;
      puff(b, x, y, z, 0.75 + 0.45 * b.rand(), 0.5, 0.26, 0.62 * pale, 0.58 * pale, 0.54 * pale);
    }
    b.timeless().rig(0);
    return b.counts();
  },

  // Allocation-free: plain numbers only.
  animate(a) {
    const on = a.built > 0.5, d = on ? a.decay : 0;
    const f = on ? 1 - ease(seg(d, 0, 0.07)) : 0;
    a.set(1, GX, 70, GZ).gain(1, f).show(1, f > 0.002);
    const y = ycap(d), dr = drift(d), cx = GX + WX * dr, cz = GZ + WZ * dr;
    const rf = 95 + 185 * ease(seg(d, 0, 0.14)) + 55 * seg(d, 0.14, 0.45);
    a.set(2, cx, Math.max(y, 0.55 * rf), cz, 0, 0, 0, rf).gain(2, 1 - 0.85 * ease(seg(d, 0.16, 0.38))).show(2, on && d < 0.4);
    a.set(3, cx, y, cz, 0, 0, 0, capScale(d)).gain(3, 1 - ease(seg(d, 0.12, 0.64))).show(3, on && d > 0.06);
    a.set(4, GX, 0, GZ, YAW_W, Math.atan2(dr * 0.85, y), 0, S_STEM).show(4, on);
    a.set(5, GX, 0, GZ, 0, 0, 0, S_RING).show(5, on);
    a.set(6, cx, y, cz, 0, 0, 0, S_PUFF).show(6, on && d > 0.3);
    a.set(7, GX, 0, GZ, 0, 0, 0, S_GZ);
  },
};
