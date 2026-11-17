// The Western Front, 1916: one stretch of it, told as a place (no fighting, nobody hurt).
// Contract: internal_docs/LANDMARKS.md.
//
// Live (def.live): one build holds the whole timeline.
//   built 0: ordinary Flanders-style countryside: a small wood, a farmhouse and barn, hedged
//     fields of wheat, pasture and plough.
//   built 0..1 (clock 254.6-256): the war arrives. The trees lose their crowns (toppled,
//     leaving bare splintered snags), the hedges and field colours go, grey-brown churned mud
//     rises over the field, pocked with water-filled shell craters; two crenellated trench
//     lines face each other across no-man's-land (earth breastworks, sandbag parapets,
//     duckboards, dugout entrances, communication trenches), with belts of barbed wire on
//     pickets in front; the farmhouse becomes a roofless shell, the barn a few charred posts.
//     A handful of still figures stand in the trenches. Rigs: three biplanes circle high up,
//     two pale flares hang and fade (animate).
//   decay 0..1 (clock 257-272): healing. Figures, wire, sandbags and duckboards go; the
//     craters drain and soften into grassy hollows, the trench banks slump and green over
//     (a faint ghost line stays in the grass), the snags fall, young trees grow back, poppies
//     spread outward from the old wood; a hedged war cemetery (rows of small white headstones)
//     and one plain stone memorial on a mown lawn are complete by ~0.7 (clock ~268).
//
// Layout: the road is at x = -RO (driver's right); the trench lines run away from the road
// (along +x) at z ~ -25 (line S, faces +z) and z ~ +23 (line N, faces -z), so the driver
// looks down no-man's-land when abreast. The cemetery sits in no-man's-land nearest the road.

import { SURF, POSE, MOTION, BY, noise3, fbm3, loop, seg, ease } from './kit.js';

const { POP, RISE, GROW, SCALE, TILT, CLIP, MORPH } = MOTION;
const TAU = Math.PI * 2;
const RO = 103; // road centre line at x = -103
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sst = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// --------------------------------------------------------------------------- trench lines
const TZ0 = [-25, 23], TSL = [0.05, 0.035], TPH = [3, 11], TF = [1, -1]; // TF: side the line faces (+z / -z)
const XA = -64, XB = 72, PY = 0.3; // trench extent along x; breastwork base height (above the mud)
function cren(u) { u = ((u % 18) + 18) % 18; return u < 7 ? 0 : u < 9 ? (u - 7) * 1.5 : u < 16 ? 3 : 3 - (u - 16) * 1.5; }
function zLine(i, x) { return TZ0[i] + TSL[i] * x + cren(x + TPH[i]) - 1.5; }
function linePath(i) {
  const xs = [XA, XB];
  for (let n = -6; n < 8; n++) for (const c of [0, 7, 9, 16]) { const x = n * 18 + c - TPH[i]; if (x > XA + 0.5 && x < XB - 0.5) xs.push(x); }
  xs.sort((a, b) => a - b);
  const P = [];
  for (const x of xs) P.push(x, PY, zLine(i, x));
  return P;
}
// Breastwork cross-sections (front toward +x of the shape = the side the line faces), listed
// from +x to -x so the faces point up / into the channel. Three parts, three colours.
const FB = [5.2, -0.14, 3.6, 0.45, 2.3, 1.02, 1.55, 1.24, 1.05, 1.14];
const CH = [1.05, 1.14, 0.85, 0.12, 0.6, 0.06, -0.6, 0.06, -0.85, 0.12, -1.05, 0.96];
const RB = [-1.05, 0.96, -1.6, 1.02, -2.7, 0.62, -4.3, -0.14];
const CT = [3.4, -0.14, 1.5, 0.72, 0.95, 0.82, 0.7, 0.1, 0.5, 0.05, -0.5, 0.05, -0.7, 0.1, -0.95, 0.82, -1.5, 0.72, -3.4, -0.14];
function prof(a, f) {
  if (f > 0) return a;
  const o = [];
  for (let i = a.length - 2; i >= 0; i -= 2) o.push(-a[i], a[i + 1]);
  return o;
}

// --------------------------------------------------------------------------- the ground
const CR = new Float64Array(4 * 96); let NCR = 0; // craters: x, z, radius, rim height
const GV = new Float64Array(8); // ground() out: y built, y decayed, crater offset, mask, noise, cemetery, trench
const CEM = [-66, -20, -18, 18]; // cemetery x0, x1, z0, z1
let BG = [0.085, 0.13, 0.04, 0];
function cemK(x, z) { return sst(-2, 2, Math.min(x - CEM[0], CEM[1] - x, z - CEM[2], CEM[3] - z)); }
function maskAt(x, z) { const q = Math.hypot(x / 70, z / 72) + 0.16 * (fbm3(x * 0.035, 3.1, z * 0.035) - 0.5); return 1 - sst(0.82, 1.0, q); }
function trK(x, z) {
  if (x < XA - 2 || x > XB + 2) return 0;
  const d = Math.min(Math.abs(z - zLine(0, x)), Math.abs(z - zLine(1, x)));
  return 1 - sst(2.2, 4.5, d);
}
function ground(x, z) {
  const m = maskAt(x, z);
  let off = 0;
  for (let i = 0; i < NCR; i++) {
    const o = i * 4, r = CR[o + 2], dx = x - CR[o], dz = z - CR[o + 1], d2 = dx * dx + dz * dz;
    if (d2 > 3.7 * r * r) continue;
    const d = Math.sqrt(d2) / r, rh = CR[o + 3];
    off += d < 1 ? mix(-0.27, rh, sst(0.3, 1, d)) : rh * (1 - sst(1, 1.9, d));
  }
  const n = fbm3(x * 0.11, 0.5, z * 0.11), c = cemK(x, z), t = trK(x, z);
  GV[0] = -0.25 + 0.55 * m + m * (0.12 * (n - 0.5) + off - 0.2 * t);
  GV[1] = -0.25 + 0.55 * m + m * (1 - c) * (0.05 * (n - 0.5) + 0.28 * off);
  GV[2] = off; GV[3] = m; GV[4] = n; GV[5] = c; GV[6] = t;
}
function poppyK(x, z) { return sst(0.42, 0.66, fbm3(x * 0.028 + 5, 1.7, z * 0.028)); }
// Heightfield callback: mud at built 1 (colour), MORPH to grass at decay 1 (height + colour).
function gfn(b, x, z) {
  ground(x, z);
  const off = GV[2], m = GV[3], n = GV[4], c = GV[5], t = GV[6];
  const w = off < 0 ? Math.min(1, -off * 4) : 0, ri = off > 0 ? Math.min(1, off * 1.6) * 0.6 : 0;
  const k = 0.82 + 0.36 * n, e = 1 - sst(0.35, 0.9, m);
  let r = mix(mix(0.112 * k, 0.055, w), 0.15, ri), g = mix(mix(0.09 * k, 0.047, w), 0.122, ri), bl = mix(mix(0.066 * k, 0.038, w), 0.09, ri);
  r = mix(r, BG[0], e); g = mix(g, BG[1], e); bl = mix(bl, BG[2], e);
  // grass: meadow, darker hollows, a faint ghost of the trench lines, poppy-red haze, mown lawn
  const kg = (0.86 + 0.28 * n) * (off < 0 ? 0.86 : 1);
  let tr = 0.1 * kg, tg = 0.158 * kg, tb = 0.046 * kg;
  tr = mix(tr, 0.14, 0.45 * t); tg = mix(tg, 0.165, 0.45 * t);
  const p = poppyK(x, z) * (1 - c) * 0.16;
  tr = mix(tr, 0.4, p); tg = mix(tg, 0.05, p); tb = mix(tb, 0.035, p);
  if (c > 0) { const s = (Math.floor((x + 66) / 3.2) & 1) ? 1 : 0.86; tr = mix(tr, 0.11 * s, c); tg = mix(tg, 0.2 * s, c); tb = mix(tb, 0.052 * s, c); }
  tr = mix(tr, BG[0], e); tg = mix(tg, BG[1], e); tb = mix(tb, BG[2], e);
  b.color(r, g, bl).morph(-0.6, GV[1], tr, tg, tb);
  return GV[0];
}
function makeCraters(b) {
  NCR = 0;
  for (let tries = 0; tries < 900 && NCR < 90; tries++) {
    const nml = b.rand() < 0.55;
    let x, z, r;
    if (nml) { x = b.range(-60, 70); const z0 = zLine(0, x) + 4, z1 = zLine(1, x) - 4; z = b.range(z0, z1); r = b.range(2.6, 5.6); }
    else { const a = b.rand() * TAU, d = 70 * Math.sqrt(b.rand()); x = Math.cos(a) * d; z = Math.sin(a) * d; r = b.range(1.8, 4.2); }
    if (maskAt(x, z) < 0.8) continue;
    if (Math.min(Math.abs(z - zLine(0, x)), Math.abs(z - zLine(1, x))) < r * 1.9 + 3) continue;
    if (Math.hypot(x - HX, z - HZ) < 13 || Math.hypot(x - BX, z - BZ) < 11) continue;
    let ok = true;
    for (let i = 0; i < NCR && ok; i++) if (Math.hypot(x - CR[i * 4], z - CR[i * 4 + 1]) < (r + CR[i * 4 + 2]) * 1.15) ok = false;
    if (!ok) continue;
    const o = NCR++ * 4;
    CR[o] = x; CR[o + 1] = z; CR[o + 2] = r; CR[o + 3] = b.range(0.32, 0.62);
  }
}

// --------------------------------------------------------------------------- farm
const HX = -40, HZ = -58, HY = 0.25; // farmhouse (yaw HY)
const BX = -21, BZ = -64;            // barn

// --------------------------------------------------------------------------- small parts
function bag(b, x, y, z, yaw, sd) {
  const k = 0.85 + 0.3 * b.rand(), mud = b.rand() < 0.3 ? 0.75 : 1;
  b.color(0.19 * k * mud, 0.17 * k * mud, 0.125 * k * mud);
  b.push(); b.at(x, y, z, yaw); b.rock(0.24, 0.14, 0.36, 1, 0.05, sd, 0, 0.3); b.pop();
}
// Countryside tree that the shelling turns into a snag (built), which falls in the decay.
function tree(b, x, z, H, t0, sd) {
  const hs = 1.8 + 4.6 * b.rand(), r0 = 0.2 + 0.13 * b.rand(), fa = b.rand() * TAU, fb = b.rand() * TAU;
  const lx = 0.05 * Math.cos(fa), lz = 0.05 * Math.sin(fa), tx = x + lx * hs, tz = z + lz * hs;
  const td = 0.12 + 0.24 * b.rand();
  b.timeless().pivot(x, 0, z).tiltDir(Math.cos(fa), Math.sin(fa)).vanish(td, td + 0.07, TILT, 0, BY.DECAY);
  b.color(0.13, 0.118, 0.1).surface(SURF.WOOD).ao(1);
  b.beam(x, -0.3, z, tx, hs, tz, r0, r0 * 0.82, 7);
  for (let k = 0; k < 2; k++) {
    const a = b.rand() * TAU, h = hs * (0.45 + 0.4 * b.rand()), L = 0.7 + 0.8 * b.rand();
    b.beam(x + lx * h, h, z + lz * h, x + Math.cos(a) * L, h + 0.6 * L, z + Math.sin(a) * L, 0.07, 0.025, 4);
  }
  // splintered top, bared when the crown is torn off
  b.appear(t0 + 0.05, t0 + 0.06, POP, 0, BY.BUILT).color(0.25, 0.235, 0.205);
  for (let k = 0; k < 4; k++) {
    const a = fa + k * 1.6 + b.rand(), L = 0.4 + 1.1 * b.rand(), rr = r0 * 0.8;
    b.beam(tx + Math.cos(a) * rr * 0.5, hs - 0.25, tz + Math.sin(a) * rr * 0.5, tx + Math.cos(a) * rr * 0.9, hs + L, tz + Math.sin(a) * rr * 0.9, rr * 0.45, 0.01, 4, false);
  }
  // the living tree above: torn away as the war arrives
  b.timeless().pivot(tx, hs, tz).tiltDir(Math.cos(fb), Math.sin(fb)).vanish(t0, t0 + 0.07, TILT, 0, BY.BUILT);
  b.color(0.13, 0.118, 0.1).surface(SURF.WOOD);
  b.beam(tx, hs - 0.05, tz, tx + lx * H, H * 0.75, tz + lz * H, r0 * 0.82, r0 * 0.4, 7);
  const L = b.bio('leaf');
  for (let k = 0; k < 3; k++) {
    const a = b.rand() * TAU, d = k ? 1.5 + b.rand() : 0, s = 0.85 + 0.3 * b.rand();
    const ck = 0.85 + 0.35 * b.rand();
    b.color(L[0] * ck * 1.15, L[1] * ck * 1.1, L[2] * ck).surface(SURF.PLAIN).ao(0.95);
    b.push(); b.translate(tx + Math.cos(a) * d, H * (0.68 + 0.08 * k) - (k ? 0.8 : 0), tz + Math.sin(a) * d);
    b.rock(2.9 * s, 2.4 * s, 2.9 * s, 2, 0.18, sd * 13 + k, 0, 0); b.pop();
  }
}
// Young tree grown back in the decay.
function young(b, x, z, s, t, sd) {
  b.timeless().pivot(x, 0.2, z).appear(t, t + 0.2, SCALE, 0, BY.DECAY);
  b.color(0.15, 0.13, 0.105).surface(SURF.WOOD).ao(1);
  b.beam(x, 0, z, x, 4.2 * s, z, 0.12 * s, 0.07 * s, 6);
  for (let k = 0; k < 2; k++) {
    const ck = 0.9 + 0.3 * b.rand();
    b.color(0.065 * ck, 0.13 * ck, 0.04 * ck).surface(SURF.PLAIN).ao(0.95);
    b.push(); b.translate(x + (k ? 0.7 : -0.3) * s, (4.6 + 1.1 * k) * s, z + (k ? -0.4 : 0.3) * s);
    b.rock(1.9 * s, 2.0 * s, 1.9 * s, 2, 0.16, sd * 7 + k, 0, 0); b.pop();
  }
}
// Hedge along a polyline (extruded rounded section).
const HEDGE = [-0.6, 0, 0.6, 0, 0.7, 0.8, 0.45, 1.5, -0.45, 1.5, -0.7, 0.8];
function hedgePath(b, x0, z0, x1, z1, y, step) {
  const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / step)), P = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, j = i > 0 && i < n ? 0.5 : 0;
    P.push(mix(x0, x1, t) + j * (b.rand() - 0.5), y, mix(z0, z1, t) + j * (b.rand() - 0.5));
  }
  return P;
}
// Biplane facing +z around its own origin (rigs 1..3).
function biplane(b) {
  b.color(0.2, 0.19, 0.14).surface(SURF.PLAIN).ao(1);
  b.beam(0, 0, 2.4, 0, 0.05, -3.6, 0.5, 0.13, 6);           // fuselage
  b.color(0.1, 0.095, 0.085); b.beam(0, 0, 2.4, 0, 0, 2.75, 0.5, 0.42, 6); // cowl
  b.color(0.27, 0.255, 0.2);
  b.box(0, 1.05, 0.5, 4.8, 0.06, 0.75);                     // upper wing
  b.box(0, -0.35, 0.65, 4.2, 0.06, 0.7);                    // lower wing
  b.box(0, 0.08, -3.3, 1.6, 0.04, 0.45);                    // tailplane
  b.box(0, 0.45, -3.4, 0.04, 0.45, 0.4);                    // fin
  b.color(0.12, 0.11, 0.09);
  for (const sx of [-2.8, 2.8]) for (const dz of [0.1, 0.9]) b.beam(sx, -0.33, dz + 0.1, sx, 1.02, dz, 0.035, 0.035, 3, false);
  b.beam(-0.6, -0.35, 1.2, -0.3, -0.95, 1.0, 0.04, 0.04, 3, false); b.beam(0.6, -0.35, 1.2, 0.3, -0.95, 1.0, 0.04, 0.04, 3, false);
}
// Small white headstone (rounded top), facing -x (the road); y = ground line.
const STONE = [-0.25, -0.3, 0.25, -0.3, 0.25, 0.72, 0.22, 0.83, 0.13, 0.9, 0, 0.92, -0.13, 0.9, -0.22, 0.83, -0.25, 0.72];

// --------------------------------------------------------------------------- animate scratch
const PLN = new Float64Array([ // centre x, z, radius, altitude, angular speed, phase
  30, 0, 120, 170, 0.11, 0.0,
  50, -20, 95, 205, -0.14, 2.1,
  10, 25, 140, 150, 0.09, 4.0]);
const FLR = new Float64Array([ // x, z, period, phase offset
  10, 6, 9.5, 0, 40, -6, 11, 5.2]);

export default {
  id: 'trenches',
  name: 'Trench line',
  caption: 'On the Western Front, armies dig in along trench lines',
  year: 1916,
  radius: 95,
  pad: 93, // road edge (highway) 99.1 m from the origin
  roadOffset: RO,
  straddlesRoad: false,
  biome: 'forest',
  live: true,
  lights: [],
  reach: 260, // the biplanes' circles
  viewSunAz: 2.2,
  detail: { at: [-30, 1.2, -24], from: [-44, 4, -6] },
  strip: { at: [-5, 1.5, 0], from: [-118, 36, 74], fov: 0.66 },
  // Event moment: high over the road side, looking down no-man's-land past the cemetery
  // ground toward the old wood, the trench lines receding on both sides.
  witness: { at: [-12, 0], look: 2.5, dist: 118, height: 34, az: 0.42, fov: 0.6, drift: 0.07, range: 1200 },
  // Further along the front: shattered copses and churned patches with smoke rising (built),
  // greening into young copses in the decay.
  satellites: {
    count: [5, 7], near: 2, nearR: [150, 260], farR: [320, 900],
    centre: 0.2, spread: 4.2, minSep: 120, roadClear: 45,
    build(b, k, n, dist) {
      const far = Math.min(1, dist / 900), t = 0.3 + 0.2 * b.rand();
      b.timeless().surface(SURF.EARTH).appear(0.1, 0.4, MORPH, 0, BY.BUILT).vanish(0.05, 0.45, MORPH, 0, BY.DECAY);
      b.disc(9 + 6 * far, 14, 3, (x, z) => {
        const q = 0.85 + 0.3 * noise3(x * 0.3, k, z * 0.3);
        b.color(0.15 * q, 0.128 * q, 0.1 * q).morph(-0.6, -0.1, 0.08, 0.13, 0.04);
        return 0.06 - 0.003 * Math.hypot(x, z);
      });
      for (let i = 0; i < 4; i++) {
        const a = b.rand() * TAU, d = 1 + 5 * b.rand(), x = Math.cos(a) * d, z = Math.sin(a) * d, h = 3 + 5 * b.rand();
        b.timeless().pivot(x, 0, z).appear(0.25, 0.3, POP, 0, BY.BUILT).tiltDir(Math.cos(a), Math.sin(a)).vanish(t, t + 0.08, TILT, 0, BY.DECAY);
        b.color(0.16, 0.145, 0.125).surface(SURF.WOOD).beam(x, -0.3, z, x, h, z, 0.26, 0.12, 5);
        young(b, -x * 0.8, -z * 0.8 + 1.5, 0.9 + 0.4 * b.rand(), t + 0.05, k * 5 + i);
      }
      if (dist > 250) {
        b.timeless().appear(0.35, 0.5, POP, 0, BY.BUILT).vanish(0.0, 0.1, POP, 0, BY.DECAY);
        b.smoke(0, 1, 0, { count: 22, size: 5 + 4 * far, rise: 42 + 16 * far, density: 0.28, color: [0.26, 0.25, 0.24], src: 0 });
      }
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 7 + 3;
    BG = b.bio('ground');
    makeCraters(b);

    // --- the countryside (built 0): field colours and hedges, sunk away as the war comes
    const FIELDS = [
      [-72, -38, -15, 1, 0.3, 0.235, 0.1],     // wheat
      [-68, 3, -15, 40, 0.085, 0.145, 0.045],  // pasture
      [-13, -38, 64, 40, 0.11, 0.165, 0.05],   // meadow round the wood
      [-10, -72, 50, -42, 0.15, 0.1, 0.065],   // plough
      [-55, 44, 50, 70, 0.26, 0.215, 0.1],     // wheat
    ];
    for (let i = 0; i < FIELDS.length; i++) {
      const F = FIELDS[i];
      b.timeless().surface(SURF.EARTH).ao(1).vanish(0.2 + 0.02 * i, 0.22 + 0.02 * i, POP, 0, BY.BUILT);
      b.heightfield(F[0], F[1], F[2], F[3], 8, 8, (x, z) => {
        const q = 0.85 + 0.3 * noise3(x * 0.07, i, z * 0.07);
        const st = i === 3 ? 0.88 + 0.12 * Math.sin(x * 0.9) : 1;
        b.color(F[4] * q * st, F[5] * q * st, F[6] * q * st);
        return 0.03;
      });
    }
    const HL = [[-74, -40, 66, -37], [-66, 42, 62, 44], [-14, -82, -13, 80], [-74, 2, -14, 2], [52, -40, 52, -68]];
    for (let i = 0; i < HL.length; i++) {
      const h = HL[i];
      b.timeless().surface(SURF.PLAIN).ao(0.95).vanish(0.12 + 0.04 * i, 0.2 + 0.04 * i, RISE, 2.2, BY.BUILT);
      b.color(0.04, 0.078, 0.026);
      b.extrude(hedgePath(b, h[0], h[1], h[2], h[3], -0.05, 9), HEDGE, { caps: true });
    }
    yield;

    // --- the wood (built 0) -> shattered snags (built 1) -> fallen (decay)
    const TP = [];
    for (let tries = 0; tries < 400 && TP.length < 52; tries++) {
      const a = b.rand() * TAU, d = Math.sqrt(b.rand()), x = 34 + Math.cos(a) * d * 25, z = 2 + Math.sin(a) * d * 19;
      let ok = true;
      for (let i = 0; i < TP.length; i += 2) if (Math.hypot(x - TP[i], z - TP[i + 1]) < 4.6) { ok = false; break; }
      if (ok) TP.push(x, z);
    }
    for (const [x, z] of [[-60, -37], [-30, -38], [6, 42], [40, -38], [-14, 30], [-14, 60]]) TP.push(x, z);
    for (let i = 0; i < TP.length; i += 2) tree(b, TP[i], TP[i + 1], 10 + 4 * b.rand(), 0.08 + 0.14 * b.rand(), sd + i);
    yield;

    // --- the field: mud (built) -> grass (decay), in 6.4 m tiles kept inside the radius
    b.timeless().surface(SURF.EARTH).ao(1).appear(0.1, 0.45, MORPH, 0, BY.BUILT).vanish(0.05, 0.45, MORPH, 0, BY.DECAY);
    const TS = 6.4, G = (x, z) => gfn(b, x, z);
    for (let tz = -14; tz < 14; tz++) {
      for (let tx = -14; tx < 14; tx++) {
        const x0 = tx * TS, z0 = tz * TS, x1 = x0 + TS, z1 = z0 + TS;
        if (Math.hypot(Math.max(-x0, x1), Math.max(-z0, z1)) > 92.5) continue;
        if (Math.min(Math.hypot(x0, z0), Math.hypot(x1, z0), Math.hypot(x0, z1), Math.hypot(x1, z1), Math.hypot((x0 + x1) / 2, (z0 + z1) / 2)) > 86 &&
            maskAt(x0, z0) + maskAt(x1, z1) + maskAt(x0, z1) + maskAt(x1, z0) < 1e-3) continue;
        b.heightfield(x0, z0, x1, z1, 4, 4, G);
      }
      if (tz % 4 === 0) yield;
    }
    // standing water in the craters
    for (let i = 0; i < NCR; i++) {
      const o = i * 4, x = CR[o], z = CR[o + 1], r = CR[o + 2], rh = CR[o + 3];
      ground(x, z);
      let d = 0.3;
      while (d < 1 && mix(-0.27, rh, sst(0.3, 1, d)) < -0.14) d += 0.02;
      b.timeless().surface(SURF.PLAIN).ao(1).appear(0.42, 0.46, POP, 0, BY.BUILT).vanish(0.06 + 0.2 * b.rand(), 0.3, RISE, 0.5, BY.DECAY);
      b.color(0.075, 0.085, 0.095);
      b.push(); b.translate(x, GV[0] + 0.12, z); b.disc(d * r * 0.98, 14, 1); b.pop();
    }
    yield;

    // --- the trench lines: breastworks rising out of the mud (built), slumping green (decay)
    const GRN = [0.1, 0.15, 0.046];
    for (let i = 0; i < 2; i++) {
      const P = linePath(i), f = TF[i], a0 = 0.3 + 0.06 * i;
      const tag = (r, g, bl) => b.timeless().surface(SURF.EARTH).ao(1).appear(a0, a0 + 0.28, MORPH, 0, BY.BUILT)
        .vanish(0.08 + 0.03 * i, 0.42, MORPH, 0, BY.DECAY).morph(-1.6, 0.12, GRN[0], GRN[1], GRN[2]).color(r, g, bl);
      tag(0.13, 0.108, 0.08); b.extrude(P, prof(FB, f), { closed: false, smooth: false });
      tag(0.08, 0.066, 0.052).ao(0.7); b.extrude(P, prof(CH, f), { closed: false, smooth: false });
      tag(0.12, 0.1, 0.075); b.extrude(P, prof(RB, f), { closed: false, smooth: false });
      // a communication trench zig-zagging back from the line
      const CP = [], cx = 18 + 10 * i, z0 = zLine(i, cx) - f * 1.4;
      for (let k = 0; k < 7; k++) CP.push(cx + (k & 1 ? 2.5 : -2.5), PY + 0.06, z0 - f * k * 5);
      b.timeless().surface(SURF.EARTH).ao(0.9).appear(a0 + 0.1, a0 + 0.35, MORPH, 0, BY.BUILT)
        .vanish(0.1, 0.4, MORPH, 0, BY.DECAY).morph(-1.6, 0.12, GRN[0], GRN[1], GRN[2]).color(0.14, 0.12, 0.094);
      b.extrude(CP, CT, { closed: false, smooth: false });

      // sandbags on the parapet, duckboards, dugouts, figures: walk the segments
      let fig = 0;
      for (let s = 0; s < P.length / 3 - 1; s++) {
        const ax = P[s * 3], az = P[s * 3 + 2], bx = P[s * 3 + 3], bz = P[s * 3 + 5];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.3) continue;
        const dx = (bx - ax) / L, dz = (bz - az) / L, rx = -dz * f, rz = dx * f, yaw = Math.atan2(dx, dz);
        const u = clamp01(((ax + bx) / 2 - XA) / (XB - XA));
        for (let q = 0.3; q < L; q += 0.56) {
          const x = ax + dx * q, z = az + dz * q, td = 0.04 + 0.18 * u + 0.04 * b.rand();
          b.timeless().surface(SURF.HIDE).ao(1).appear(0.5 + 0.2 * u, 0.53 + 0.2 * u, POP, 0, BY.BUILT).vanish(td, td + 0.05, RISE, 1.8, BY.DECAY);
          bag(b, x + rx * 1.5, PY + 1.33, z + rz * 1.5, yaw, sd + s * 31 + q * 7);
          if (b.rand() < 0.6) bag(b, x + rx * 1.42 + dx * 0.33, PY + 1.55, z + rz * 1.42 + dz * 0.33, yaw + 0.1 * (b.rand() - 0.5), sd + s * 17 + q * 3);
        }
        // duckboards
        b.timeless().surface(SURF.WOOD).ao(0.8).appear(0.58, 0.6, POP, 0, BY.BUILT).vanish(0.06, 0.18, RISE, 1, BY.DECAY);
        b.color(0.16, 0.13, 0.095);
        b.push(); b.at((ax + bx) / 2, PY + 0.1, (az + bz) / 2, yaw); b.box(0, 0, 0, 0.32, 0.035, L / 2, false); b.pop();
        if (L > 6) { // a bay
          if ((s + i) % 4 === 1) { // dugout entrance in the rear wall
            const x = (ax + bx) / 2 - rx * 0.92, z = (az + bz) / 2 - rz * 0.92;
            b.push(); b.at(x, PY, z, yaw);
            b.color(0.018, 0.016, 0.014).surface(SURF.PLAIN).ao(0.2);
            b.box(0, 0.6, 0, 0.55, 0.5, 0.6, false);
            b.color(0.12, 0.1, 0.075).surface(SURF.WOOD).ao(0.9);
            b.beam(0, 1.12, -0.75, 0, 1.12, 0.75, 0.08, 0.08, 4);
            b.beam(0.05, 0.05, -0.68, 0.05, 1.1, -0.68, 0.07, 0.07, 4); b.beam(0.05, 0.05, 0.68, 0.05, 1.1, 0.68, 0.07, 0.07, 4);
            b.pop();
          }
          if (fig < 3 - i && (s * 7 + i * 3) % 5 === 2) { // a still figure on watch, no weapon
            fig++;
            const q = 2 + b.rand() * (L - 4), x = ax + dx * q + rx * 0.3, z = az + dz * q + rz * 0.3;
            b.timeless().surface(SURF.HIDE).ao(1).appear(0.86, 0.88, POP, 0, BY.BUILT).vanish(0.02, 0.03, POP, 0, BY.DECAY);
            b.color(0.13, 0.125, 0.09);
            b.push(); b.at(x, PY + 0.1, z, Math.atan2(rx, rz) + 0.4 * (b.rand() - 0.5)); b.human(POSE.STAND, 1.74, sd + s);
            b.color(0.1, 0.1, 0.085); b.translate(0, 1.66, 0.01); b.ellipsoid(0.19, 0.045, 0.2, 2); b.pop();
          }
        }
      }
      // barbed wire: two rows of pickets in front of the line, strands between them
      const WP = [];
      for (let x = XA + 3; x < XB - 2; x += 2.6 + 0.5 * b.rand()) WP.push(x, b.rand() - 0.5, b.rand() - 0.5);
      for (let k = 0; k < WP.length; k += 3) {
        const x = WP[k], u = clamp01((x - XA) / (XB - XA)), td = 0.03 + 0.2 * u + 0.03 * b.rand();
        const zb = TZ0[i] + TSL[i] * x + f * 10.5;
        b.timeless().surface(SURF.WOOD).ao(1).appear(0.6 + 0.2 * u, 0.62 + 0.2 * u, POP, 0, BY.BUILT).vanish(td, td + 0.03, POP, 0, BY.DECAY);
        b.color(0.12, 0.1, 0.08);
        const z1 = zb + 0.6 * WP[k + 1], z2 = zb + f * 1.4 + 0.6 * WP[k + 2];
        b.beam(x, 0.1, z1, x + 0.05, 1.45, z1, 0.045, 0.035, 4, false);
        b.beam(x + 1.2, 0.1, z2, x + 1.2, 1.3, z2, 0.045, 0.035, 4, false);
        if (k + 3 < WP.length) {
          const x2 = WP[k + 3], n1 = zb + 0.6 * WP[k + 4], n2 = zb + f * 1.4 + 0.6 * WP[k + 5];
          b.color(0.075, 0.066, 0.06).surface(SURF.PLAIN);
          const r = 0.022;
          b.beam(x, 1.3, z1, x2, 1.1 + 0.3 * b.rand(), n1, r, r, 3, false);
          b.beam(x, 0.75, z1, x2, 0.6 + 0.3 * b.rand(), n1, r, r, 3, false);
          b.beam(x + 1.2, 1.2, z2, x2 + 1.2, 0.9 + 0.3 * b.rand(), n2, r, r, 3, false);
          b.beam(x, 1.35, z1, x2 + 1.2, 0.5, n2, r, r, 3, false);
          b.beam(x + 1.2, 1.25, z2, x2, 0.45, n1, r, r, 3, false);
          b.beam(x, 0.35, z1, x + 1.2, 1.0, z2, r, r, 3, false);
        }
      }
      yield;
    }

    // --- the farm: intact (built 0) -> shell and wreck (built) -> gone (decay)
    b.push(); b.at(HX, 0, HZ, HY);
    b.timeless().ao(1).vanish(0.33, 0.34, POP, 0, BY.BUILT);
    b.color(0.37, 0.34, 0.28).surface(SURF.PLASTER); b.box(0, 2.3, 0, 5.5, 2.5, 3.5, false);
    b.extrude([-5.5, 4.8, 0, 5.5, 4.8, 0], [-3.5, 0, 3.5, 0, 0, 2.6], { caps: true, smooth: false });
    b.color(0.21, 0.095, 0.065).surface(SURF.PLAIN);
    for (const s of [1, -1]) { b.push(); b.translate(0, 6.12, 1.75 * s); b.rotateX(0.64 * s); b.box(0, 0, 0, 5.9, 0.1, 2.5); b.pop(); }
    b.color(0.24, 0.12, 0.09); b.box(3.6, 6.4, 0.6, 0.35, 1.5, 0.35);
    b.color(0.04, 0.04, 0.045);
    for (const s of [1, -1]) for (const wx of [-3.6, -1.2, 1.2, 3.6]) for (const wy of [1.5, 3.5]) {
      if (s > 0 && wy < 2 && wx === -1.2) { b.box(wx, 1.1, 3.52, 0.5, 1.1, 0.04); continue; } // door
      b.box(wx, wy, 3.52 * s, 0.45, 0.6, 0.04);
    }
    b.box(-5.52, 3.4, 0, 0.04, 0.6, 0.45);
    // the shell
    b.timeless().ao(1).appear(0.33, 0.34, POP, 0, BY.BUILT).pivot(0, 0, 0).vanish(0.22, 0.5, CLIP, 9.5, BY.DECAY);
    b.color(0.2, 0.185, 0.155).surface(SURF.PLASTER);
    for (const s of [1, -1]) {
      for (let k = 0; k < 10; k++) {
        const x = -5.5 + 1.1 * k + 0.55, win = (k === 1 || k === 3 || k === 6 || k === 8);
        const h = k === 0 ? 4.8 : win ? 0.9 + 0.5 * b.rand() : 1.4 + (s > 0 ? 3.0 : 1.8) * b.rand() * (1 - k / 14);
        b.box(x, h / 2 - 0.2, 3.25 * s, 0.56, h / 2 + 0.2, 0.25);
        if (win && b.rand() < 0.5) b.box(x, 4.2, 3.25 * s, 0.56, 0.3, 0.25);
      }
    }
    b.box(-5.25, 2.3, 0, 0.25, 2.5, 3.5); // the gable end still stands
    b.extrude([-5.5, 4.8, 0, -5.0, 4.8, 0], [-3.5, 0, 3.5, 0, 0, 2.6], { caps: true, smooth: false });
    b.color(0.03, 0.03, 0.03); b.box(-5.52, 3.4, 0, 0.04, 0.6, 0.45); b.box(-5.52, 5.6, 0, 0.04, 0.4, 0.3);
    b.color(0.2, 0.185, 0.155); b.box(5.25, 0.6, 0, 0.25, 0.8, 3.5);
    b.color(0.045, 0.04, 0.035).surface(SURF.WOOD);
    b.beam(-4.8, 4.6, 2.9, 1.5, 0.3, 1.0, 0.12, 0.12, 4); b.beam(-4.8, 4.6, -2.9, 2.2, 0.6, -1.5, 0.12, 0.12, 4); b.beam(-4.9, 6.4, 0, 0.5, 2.2, 0.4, 0.13, 0.13, 4);
    b.timeless().ao(0.9).appear(0.33, 0.34, POP, 0, BY.BUILT).vanish(0.25, 0.45, RISE, 1.6, BY.DECAY);
    b.color(0.2, 0.16, 0.13).surface(SURF.STONE);
    for (let k = 0; k < 9; k++) { b.push(); b.translate(b.range(-6, 6), 0, b.range(-5, 5)); b.rock(b.range(1, 2.2), b.range(0.4, 0.9), b.range(0.8, 1.8), 2, 0.3, sd + k, 3, 0.6); b.pop(); }
    b.pop();
    b.push(); b.at(BX, 0, BZ, HY + 0.1);
    b.timeless().ao(1).vanish(0.36, 0.37, POP, 0, BY.BUILT);
    b.color(0.15, 0.105, 0.07).surface(SURF.WOOD); b.box(0, 2.6, 0, 6, 2.8, 4, false);
    b.color(0.11, 0.1, 0.09).surface(SURF.THATCH); b.extrude([-6.4, 5.35, 0, 6.4, 5.35, 0], [-4.6, 0, 4.6, 0, 0, 3.6], { caps: true, smooth: false });
    b.color(0.035, 0.03, 0.028).surface(SURF.PLAIN); b.box(0, 1.8, 4.02, 1.6, 1.8, 0.04);
    b.timeless().ao(1).appear(0.36, 0.37, POP, 0, BY.BUILT).vanish(0.15, 0.3, RISE, 4, BY.DECAY);
    b.color(0.05, 0.045, 0.04).surface(SURF.WOOD);
    for (const [px, pz, h] of [[-5.6, -3.6, 3.4], [5.6, -3.6, 2.2], [-5.6, 3.6, 1.6], [0.2, 3.6, 2.8]]) b.beam(px, -0.2, pz, px, h, pz, 0.16, 0.13, 5);
    b.color(0.09, 0.08, 0.07); b.push(); b.translate(1.2, 0.5, -0.5); b.rotateZ(0.12); b.rotateX(0.2); b.box(0, 0, 0, 4.6, 0.12, 3.2); b.pop();
    for (let k = 0; k < 6; k++) b.beam(b.range(-5, 5), 0.15, b.range(-4, 4), b.range(-5, 5), 0.3, b.range(-4, 4), 0.1, 0.1, 4);
    b.pop();
    yield;

    // --- healing: young trees, poppies, the cemetery and its memorial
    for (let k = 0; k < 30; k++) {
      const a = b.rand() * TAU, d = Math.sqrt(b.rand()), x = 34 + Math.cos(a) * d * 26, z = 2 + Math.sin(a) * d * 20;
      young(b, x, z, 0.8 + 0.6 * b.rand(), 0.2 + 0.3 * d + 0.15 * b.rand(), sd + k);
    }
    for (const [x, z] of [[-50, -40], [-20, 42], [10, -40], [60, 30], [-62, 30]]) young(b, x, z, 1.1 + 0.3 * b.rand(), 0.45 + 0.1 * b.rand(), sd + x);
    let np = 0;
    b.surface(SURF.PLAIN).ao(1);
    for (let tries = 0; tries < 9000 && np < 1700; tries++) {
      const x = b.range(-70, 75), z = b.range(-72, 72);
      if (x > CEM[0] - 3 && x < CEM[1] + 3 && z > CEM[2] - 3 && z < CEM[3] + 3) continue;
      if (Math.hypot(x, z) > 90) continue;
      const pk = poppyK(x, z) * maskAt(x, z);
      if (b.rand() > 0.12 + 0.88 * pk) continue;
      ground(x, z);
      const y = GV[1] + 0.32 + 0.12 * b.rand(), s = 0.17 + 0.06 * b.rand(), t = 0.15 + 0.3 * clamp01(Math.hypot(x - 34, z - 2) / 90) + 0.06 * b.rand();
      b.timeless().pivot(x, GV[1], z).appear(t, t + 0.06, SCALE, 0, BY.DECAY);
      const kr = 0.85 + 0.3 * b.rand();
      b.color(0.5 * kr, 0.04 * kr, 0.026);
      const r0 = b.rand() * TAU, c = b.vertex(x, y + 0.05, z, 0, 1, 0);
      const v0 = b.nv;
      for (let j = 0; j < 4; j++) { const a = r0 + j * Math.PI / 2, cx = Math.cos(a), cz = Math.sin(a); b.vertex(x + cx * s, y - 0.02, z + cz * s, cx * 0.6, 0.8, cz * 0.6); }
      for (let j = 0; j < 4; j++) b.tri(c, v0 + j, v0 + ((j + 1) & 3));
      np++;
    }
    yield;
    // headstones: rows facing the road, set row by row
    for (let r = 0; r < 7; r++) {
      const x = CEM[0] + 6 + r * 4.4;
      for (let j = 0; j < 14; j++) {
        const z = -13 + j * 2.0, t = 0.38 + 0.035 * r + 0.002 * j;
        const k = 0.94 + 0.08 * b.rand();
        b.timeless().surface(SURF.STONE).ao(1).appear(t, t + 0.04, RISE, 1.4, BY.DECAY);
        b.color(0.5 * k, 0.495 * k, 0.465 * k);
        b.push(); b.at(x, 0.3, z, 0); b.scale(1.25, 1.25, 1.25);
        b.extrude([0.05, 0, 0, -0.05, 0, 0], STONE, { caps: true, smooth: false });
        b.pop();
      }
    }
    // the memorial: a plain stone on three steps, built course by course
    b.timeless().surface(SURF.STONE).ao(1).pivot(0, 0.3, 0).appear(0.48, 0.62, CLIP, 7.6, BY.DECAY);
    b.push(); b.at(CEM[1] - 4, 0.3, 0, 0);
    b.color(0.42, 0.415, 0.39);
    b.translate(0, -0.2, 0); b.block(3.3, 3.3, 3.3, 3.3, 0.55);
    b.translate(0, 0.55, 0); b.block(2.6, 2.6, 2.6, 2.6, 0.4);
    b.translate(0, 0.4, 0); b.block(1.95, 1.95, 1.95, 1.95, 0.4);
    b.color(0.47, 0.465, 0.44);
    b.translate(0, 0.4, 0); b.block(0.95, 0.95, 0.72, 0.72, 5.4);
    b.translate(0, 5.4, 0); b.block(0.86, 0.86, 0.6, 0.6, 0.5);
    b.pop();
    // the cemetery hedge (open toward the road)
    b.color(0.035, 0.075, 0.025).surface(SURF.PLAIN).ao(0.95);
    const hx0 = CEM[0] + 1, hx1 = CEM[1] + 2, hz = CEM[3] + 1;
    const SEGS = [[hx0, -hz, hx1, -hz], [hx1, -hz, hx1, hz], [hx1, hz, hx0, hz], [hx0, hz, hx0, 4], [hx0, -4, hx0, -hz]];
    for (const s of SEGS) {
      b.timeless().pivot(s[0], 0.25, s[1]).appear(0.42, 0.56, GROW, 0, BY.DECAY);
      b.extrude([s[0], 0.25, s[1], s[2], 0.25, s[3]], HEDGE, { caps: true, scale: 0.6 });
    }
    yield;

    // --- moving parts: biplanes (rigs 1-3), flares (rigs 4-5)
    b.timeless();
    for (let k = 1; k <= 3; k++) { b.rig(k, false); b.push(); b.scale(1.3, 1.3, 1.3); biplane(b); b.pop(); }
    for (let k = 4; k <= 5; k++) { b.rig(k, false); b.flash(0, 0, 0, 2.2, 10, 0.92, 0.96, 0.82); }
    b.rig(0);
    return b.counts();
  },

  animate(a) {
    const war = seg(a.built, 0.5, 0.9), away = ease(seg(a.decay, 0, 0.12));
    for (let k = 0; k < 3; k++) {
      const o = k * 6, w = PLN[o + 4], th = PLN[o + 5] + a.t * w, R = PLN[o + 2] * (1 + 1.5 * away);
      const c = Math.cos(th), s = Math.sin(th), sg = w > 0 ? 1 : -1;
      a.set(k + 1, PLN[o] + R * c, PLN[o + 3] + 260 * away + 6 * Math.sin(a.t * 0.4 + k), PLN[o + 1] + R * s,
        Math.atan2(-s * sg, c * sg), 0, -0.32 * sg).show(k + 1, war > 0 && away < 1);
    }
    const env = war * (1 - seg(a.decay, 0.02, 0.1));
    for (let k = 0; k < 2; k++) {
      const o = k * 4, u = loop(a.t, FLR[o + 2], FLR[o + 3]);
      const y = 12 + 78 * ease(seg(u, 0, 0.1)) - 34 * seg(u, 0.1, 1), g = seg(u, 0.03, 0.1) * (1 - seg(u, 0.55, 0.95)) * env;
      a.set(k + 4, FLR[o] + 8 * u, y, FLR[o + 1]).gain(k + 4, g).show(k + 4, g > 0.002);
    }
  },
};
