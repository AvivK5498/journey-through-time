// Event 22: the home at the end of the road (the ending, src/ending.js). An ordinary suburban
// bungalow: white rendered walls on a grey plinth, a red tiled gable roof with a brick chimney,
// an attached garage with a white up-and-over door, warm lit windows, a front lawn with mowing
// stripes, a white picket fence, a mailbox by the concrete driveway, hedges round the back
// yard, and in the yard a fire pit on a flagstone patio under a tree, with people round it.
//
// THE HOME STANDS WHERE THE FIRST FIRE BURNED. The yard is the first humans' camp (camp.js),
// built here whole and re-timed: its fire, ash bed, hearth stones, acacia and three seated
// people are timeless; everything else of the camp (windbreaks, hide frame, firewood, the
// knapper, the spearman, the walker, bones, flakes, the trampled floor) is present only at the
// very start of history. built = clock / 300 (time.js), so as the ending runs the clock back:
//   built 0.926 -> 0.893 (1974 -> 1950)  the house unbuilds: fence, hedges, mailbox, patio and
//                                        pit, roof, gables, walls (windows go with them), slab,
//                                        driveway, lawn
//   built 0.89 -> 0.06                   a plain lot: grass tufts, the fire and the people
//   built 0.07 -> 0.01 (clock 21 -> 3)   the camp comes back round the same fire
// decay is unused (0): it keeps the camp's own decay timeline (people leaving, the fire dying)
// at its living start.
//
// Local frame (LANDMARKS.md): road centre line at x = -36, travel toward -z; the driveway
// meets the road at z = DRIVE_Z; the car parks at (PARK_X, DRIVE_Z) facing +x.

import { SURF, FLICKER, MOTION, BY, noise3 } from './kit.js';
import camp, { tuft, CAMP_HX, CAMP_HZ, CAMP_TREE_X, CAMP_TREE_Z } from './camp.js';

export const HOME_OFF = 36; // road centre line to the origin
export const DRIVE_Z = 9.6; // driveway centre line (local z)
export const PARK_X = -21.0; // car centre when parked
// The camp in the yard: turned (CA, b.rotateY) so its open side (no windbreak) faces the yard's
// far corner, where the echo camera stands, and its acacia stands between the fire and the
// house: from the camera the tree rises behind the fire with the house and the street beyond.
export const CA = 2.531;
const CC = Math.cos(CA), CS = Math.sin(CA);
const rx = (x, z) => x * CC + z * CS, rz = (x, z) => -x * CS + z * CC; // camp-local -> yard offset
export const FIRE_X = 13, FIRE_Z = 0; // the fire
export const CX = FIRE_X - rx(CAMP_HX, CAMP_HZ), CZ = FIRE_Z - rz(CAMP_HX, CAMP_HZ); // the camp's origin
const TREE_X = CX + rx(CAMP_TREE_X, CAMP_TREE_Z), TREE_Z = CZ + rz(CAMP_TREE_X, CAMP_TREE_Z); // (0, -1.6)
const HX0 = -17, HX1 = -5.5, HZ0 = -7.6, HZ1 = 6.3; // house walls
const GX0 = -17, GX1 = -9.5, GZ0 = 6.3, GZ1 = 12.9; // garage walls
const WALL_H = 3.0, GWALL_H = 2.7, RIDGE_H = 6.45, GRIDGE_H = 4.5;
const LOT_X0 = -28.5, LOT_X1 = 25.5, LOT_Z = 13.5; // fence line, back hedge, side hedges
const DW_Z0 = 6.8, DW_Z1 = 12.4, DW_X0 = -32.2; // driveway

// Unbuild windows (built units; forward in time these are the build order).
const T_LAWN = 0.895, T_DRIVE = 0.893, T_SLAB = 0.896, T_WALL = 0.9, T_GABLE = 0.909, T_ROOF = 0.912,
  T_GAR = 0.903, T_PATIO = 0.917, T_PIT = 0.921, T_FENCE = 0.92, T_HEDGE = 0.918, T_MAIL = 0.925;

const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
let MARK = null; // FX vertices of the camp build (scratch, made once)

// Camp vertices -> the home's timeline (see the header). v0..v1: the camp's vertex range.
function retime(b, v0, v1, f0, f1) {
  if (!MARK || MARK.length < b.maxV) MARK = new Uint8Array(b.maxV);
  for (let k = f0; k < f1; k++) MARK[b.fidx[k]] = 1;
  const t = b.tu8, tf = b.tf, f = b.f;
  for (let v = v0; v < v1; v++) {
    if (MARK[v]) { MARK[v] = 0; continue; } // smoke, flames, embers, glow: the fire's own
    const o = v * 24, fl = t[o + 6];
    const wx = f[v * 8] - CX, y = f[v * 8 + 1], wz = f[v * 8 + 2] - CZ;
    const x = wx * CC - wz * CS, z = wx * CS + wz * CC; // back to camp-local
    const dh = Math.hypot(x - CAMP_HX, z - CAMP_HZ);
    const dt = Math.hypot(x - CAMP_TREE_X, z - CAMP_TREE_Z);
    if ((fl & 2) && (t[o + 5] & 16)) { // vanish by decay
      const m = t[o + 5] & 15, a0 = t[o + 2] / 255, a1 = t[o + 3] / 255;
      if (m === MOTION.POP && a0 < 0.27) { t[o + 6] = fl & ~2; t[o + 5] = 0; t[o + 2] = 254; t[o + 3] = 255; continue; } // the three seated
      if (dh < 1.7 && m !== MOTION.POP) continue; // burning logs, coals, ash bed: the fire stays
      let w0, w1;
      if (m === MOTION.MORPH) { // the trampled floor: sinks under the lot (and rises at the end)
        w0 = 0.022 + (a0 - 0.25) * 0.25; w1 = w0 + 0.035;
        tf[v * 6 + 3] = -0.16;
      } else {
        w0 = 0.014 + a0 * 0.055; w1 = w0 + Math.max(0.006, (a1 - a0) * 0.055);
      }
      t[o + 2] = q(w0); t[o + 3] = Math.max(t[o + 2] + 1, q(w1)); t[o + 5] = m; // by built
    } else if (fl === 0) { // timeless camp detail
      if (dh < 1.7 || dt < 4.6 || (y > 2.4 && dt < 7)) continue; // the hearth, the acacia
      const w0 = 0.02 + 0.03 * noise3(x * 0.4, 1.7, z * 0.4);
      t[o + 6] = 2; t[o + 2] = q(w0); t[o + 3] = t[o + 2] + 1; t[o + 5] = MOTION.POP;
    }
  }
}

// A window on a wall face. The face frame: local x along the wall, +z out of it, y up.
function win(b, w, h, lit) {
  b.surface(SURF.PLAIN).ao(1);
  b.color(0.52, 0.51, 0.48); // white frame
  b.box(0, h / 2, 0.04, w / 2 + 0.09, h / 2 + 0.09, 0.04, false);
  b.color(0.42, 0.41, 0.38);
  b.box(0, -0.05, 0.09, w / 2 + 0.16, 0.05, 0.09, false); // sill
  // warm glass (the room lit behind it), a mullion and a transom
  b.color(0.9, 0.58, 0.3).emissive(lit, FLICKER.NONE);
  b.box(0, h / 2, 0.085, w / 2, h / 2, 0.01, false);
  b.emissive(0, 0).color(0.5, 0.49, 0.46);
  b.box(0, h / 2, 0.1, 0.035, h / 2, 0.015, false);
  b.box(0, h * 0.7, 0.1, w / 2, 0.03, 0.015, false);
}
function onFace(b, face, u, y) {
  b.push();
  if (face === 0) { b.translate(HX0, y, u); b.rotateY(-Math.PI / 2); }
  else if (face === 1) { b.translate(HX1, y, u); b.rotateY(Math.PI / 2); }
  else if (face === 2) { b.translate(u, y, HZ0); b.rotateY(Math.PI); }
  else { b.translate(u, y, HZ1); }
}

// Tiled slope: eave line (xe, ye) to ridge (xr, yr), across za..zb (or along x when alongX:
// then xe/xr are z values). n courses, each a thin plate whose lower edge stands proud.
const P = new Float64Array(24);
function tiles(b, xe, ye, xr, yr, za, zb, n, alongX, seed) {
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n + 0.012;
    const g = 0.86 + 0.26 * noise3(k * 1.7, seed, 0.5);
    b.color(0.40 * g, 0.115 * g, 0.055 * g);
    const a0 = xe + (xr - xe) * t0, b0 = ye + (yr - ye) * t0, a1 = xe + (xr - xe) * Math.min(1, t1), b1 = ye + (yr - ye) * Math.min(1, t1);
    const lx = alongX ? 0 : 1; // write (u, y, w) with u the slope axis
    const pts = [[a0, b0 - 0.07, za], [a1, b1 - 0.035, za], [a1, b1 - 0.035, zb], [a0, b0 - 0.07, zb], [a0, b0 + 0.02, za], [a1, b1, za], [a1, b1, zb], [a0, b0 + 0.02, zb]];
    for (let i = 0; i < 8; i++) {
      const p = pts[i];
      if (lx) { P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2]; } else { P[i * 3] = p[2]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[0]; }
    }
    b.hexa(P, false);
  }
}
// Plaster gable triangle in the plane z = zc (or x = zc when alongX), base y0 from u0 to u1.
function gable(b, u0, u1, y0, yr, zc, nz, alongX) {
  const um = (u0 + u1) / 2;
  const V = (u, y) => (alongX ? b.vertex(zc, y, u, nz, 0, 0) : b.vertex(u, y, zc, 0, 0, nz));
  b.tri(V(u0, y0), V(u1, y0), V(um, yr));
}

export default {
  id: 'home',
  name: 'Home',
  caption: 'At the end of the road, people sit round a fire, as they always have.',
  year: 2026,
  radius: 36,
  pad: 31, // road edge (highway 3.9) at 32.1 m from the origin
  roadOffset: HOME_OFF,
  straddlesRoad: false,
  live: true,
  biome: 'savannah',
  wind: [0.5, 0.866],
  lights: [
    // the fire: the camp's own (decay stays 0, so it never dies)
    { pos: [FIRE_X, 0.9, FIRE_Z], color: [1.0, 0.46, 0.15], intensity: 60, range: 20, flicker: 0.6, vanish: [0.08, 0.62] },
    // the lit back of the house on the patio and lawn
    { pos: [HX1 + 3.5, 2.4, 1.9], color: [1.0, 0.7, 0.42], intensity: 9, range: 12, flicker: 0, appear: [T_WALL + 0.004, T_WALL + 0.012] },
  ],
  detail: { at: [FIRE_X, 0.8, FIRE_Z], from: [FIRE_X + 9, 3, FIRE_Z - 7] },
  strip: { at: [0, 2, 0], from: [24, 9, -26], fov: 0.9 },

  build(b, built, decay, seed) {
    // --- the first camp, whole, then re-timed onto the home's clock
    const v0 = b.nv, f0 = b.nf;
    b.push(); b.translate(CX, 0, CZ); b.rotateY(CA);
    camp.build(b, 1, 0, seed);
    b.pop();
    retime(b, v0, b.nv, f0, b.nf);
    b.light(0, FIRE_X, 0.9, FIRE_Z, 1.0, 0.46, 0.15, 60, 20, 0.6);

    // --- the plain lot of most of history: tufts of grass (before the lawn, after the camp)
    b.seed(seed * 7 + 3);
    for (let i = 0; i < 96; i++) {
      const x = -27 + 51 * b.rand(), z = -12.5 + 25 * b.rand();
      if (Math.hypot(x - FIRE_X, z - FIRE_Z) < 3 || Math.hypot(x - TREE_X, z - TREE_Z) < 2) continue;
      const a = 0.05 + 0.02 * b.rand(), v = 0.88 + 0.01 * b.rand();
      b.timeless().pivot(x, 0, z).appear(a, a + 0.01, MOTION.GROW, 0, BY.BUILT).vanish(v, v + 0.008, MOTION.GROW, 0, BY.BUILT);
      tuft(b, x, z, 0.2 + 0.35 * b.rand(), seed * 300 + i);
    }

    // --- lawn: mowing stripes, frayed under the hedges; it rises out of the lot
    b.timeless().surface(SURF.EARTH).ao(1);
    b.heightfield(LOT_X0 + 0.2, -LOT_Z + 0.3, LOT_X1 - 0.2, LOT_Z - 0.3, 54, 26, (x, z) => {
      const stripe = Math.floor((x + 40) / 2.4) & 1, n = 0.9 + 0.2 * noise3(x * 0.3, 2, z * 0.3);
      const k = (stripe ? 1.08 : 0.92) * n;
      b.color(0.085 * k, 0.17 * k, 0.04 * k);
      const y = 0.022;
      b.timeless().morph(-0.14, y).appear(T_LAWN, T_LAWN + 0.012, MOTION.MORPH, 0, BY.BUILT);
      return y;
    });

    // --- driveway, front path, patio (concrete and flagstones)
    b.timeless().pivot(0, 0, 0).appear(T_DRIVE, T_DRIVE + 0.006, MOTION.RISE, 0.32, BY.BUILT);
    b.surface(SURF.STONE).ao(1).color(0.33, 0.32, 0.3);
    b.box((DW_X0 + GX0) / 2, -0.11, DRIVE_Z, (GX0 - DW_X0) / 2, 0.15, (DW_Z1 - DW_Z0) / 2, false);
    b.color(0.27, 0.26, 0.245);
    b.box((LOT_X0 + HX0) / 2, -0.12, -0.7, (HX0 - LOT_X0) / 2, 0.155, 0.6, false);
    b.timeless().pivot(0, 0, 0).appear(T_PATIO, T_PATIO + 0.006, MOTION.RISE, 0.2, BY.BUILT);
    b.push(); b.translate(FIRE_X, 0, FIRE_Z);
    b.surface(SURF.STONE);
    b.disc(3.2, 40, 8, (x, z) => { // rings every 0.4 m: the hole under the pit ends at 1.2
      const cx = Math.floor(x / 0.75 + 0.5 * Math.floor(z / 0.6)), cz = Math.floor(z / 0.6);
      const g = 0.8 + 0.35 * noise3(cx * 3.1, cz * 2.7, 4.2);
      b.color(0.27 * g, 0.25 * g, 0.22 * g);
      const r = Math.hypot(x, z);
      return r < 1.1 ? -0.25 : r > 3.0 ? 0.045 - (r - 3.0) * 0.3 : 0.045;
    });
    b.pop();
    // fire pit: a low ring of dark stone round the old hearth
    b.timeless().pivot(FIRE_X, 0, FIRE_Z).appear(T_PIT, T_PIT + 0.004, MOTION.CLIP, 0.26, BY.BUILT);
    b.push(); b.translate(FIRE_X, 0, FIRE_Z);
    b.color(0.15, 0.13, 0.115).surface(SURF.STONE).ao(0.85);
    b.lathe([1.2, 0.0, 1.2, 0.24, 1.17, 0.26, 1.03, 0.26, 1.0, 0.24, 1.0, 0.03], 28, { caps: false });
    b.pop();

    // --- house: slab, plinth, walls with their windows, gables, tiled roof, chimney
    b.timeless().pivot(0, 0, 0).appear(T_SLAB, T_SLAB + 0.004, MOTION.RISE, 0.4, BY.BUILT);
    b.surface(SURF.STONE).color(0.2, 0.19, 0.18).ao(0.9);
    b.box((HX0 + HX1) / 2, -0.15, (HZ0 + GZ1) / 2, (HX1 - HX0) / 2 + 0.25, 0.3, (GZ1 - HZ0) / 2 + 0.25, false);
    b.box(HX0 - 0.55, 0.04, -0.7, 0.35, 0.12, 0.75, false); // door step
    b.timeless().pivot(0, 0, 0).appear(T_WALL, T_WALL + 0.009, MOTION.CLIP, WALL_H + 0.1, BY.BUILT);
    b.surface(SURF.PLASTER).color(0.56, 0.545, 0.5).ao(1);
    b.box((HX0 + HX1) / 2, WALL_H / 2, (HZ0 + HZ1) / 2, (HX1 - HX0) / 2, WALL_H / 2, (HZ1 - HZ0) / 2, false);
    b.surface(SURF.STONE).color(0.22, 0.21, 0.2);
    b.box((HX0 + HX1) / 2, 0.2, (HZ0 + HZ1) / 2, (HX1 - HX0) / 2 + 0.04, 0.2, (HZ1 - HZ0) / 2 + 0.04, false);
    // windows: front (to the street), back (to the yard: patio doors), the far side
    const W = [[0, -5.1, 0.95, 2.1, 1.3, 0.05], [0, 3.4, 0.95, 2.3, 1.3, 0.06], [0, -2.9, 1.05, 0.9, 1.15, 0.05],
      [1, 1.9, 0.12, 2.6, 2.15, 0.018], [1, -3.6, 0.95, 1.5, 1.3, 0.025], [2, -11.2, 0.95, 1.6, 1.3, 0.05], [2, -7.6, 1.2, 0.8, 0.9, 0.04]];
    for (const [face, u, y, w, h, lit] of W) { onFace(b, face, u, y); win(b, w, h, lit); b.pop(); }
    // front door with a lit fanlight and a little canopy
    onFace(b, 0, -0.7, 0);
    b.surface(SURF.WOOD).color(0.13, 0.065, 0.035).ao(0.9);
    b.box(0, 1.05, 0.04, 0.5, 1.05, 0.04, false);
    b.surface(SURF.PLAIN).color(0.52, 0.51, 0.48);
    b.box(0, 1.1, 0.03, 0.62, 1.16, 0.03, false);
    b.color(1.0, 0.7, 0.38).emissive(0.12, FLICKER.NONE);
    b.box(0, 2.22, 0.07, 0.42, 0.07, 0.01, false);
    b.emissive(0, 0).color(0.6, 0.48, 0.2).surface(SURF.GILT);
    b.push(); b.translate(0.33, 1.0, 0.1); b.ellipsoid(0.035, 0.035, 0.035, 1); b.pop();
    b.surface(SURF.PLAIN).color(0.5, 0.49, 0.46);
    b.box(0, 2.62, 0.45, 0.85, 0.05, 0.45, false);
    b.pop();
    // gables (plaster) and the roof
    b.timeless().pivot(0, WALL_H, 0).appear(T_GABLE, T_GABLE + 0.004, MOTION.CLIP, RIDGE_H - WALL_H + 0.1, BY.BUILT);
    b.surface(SURF.PLASTER).color(0.55, 0.535, 0.49).ao(1);
    gable(b, HX0, HX1, WALL_H, RIDGE_H, HZ0, -1, false);
    gable(b, HX0, HX1, WALL_H, RIDGE_H, HZ1, 1, false);
    const RX = (HX0 + HX1) / 2, OH = 0.55, slope = (RIDGE_H - WALL_H) / (RX - HX0);
    b.timeless().pivot(0, WALL_H - 0.4, 0).appear(T_ROOF, T_ROOF + 0.008, MOTION.CLIP, RIDGE_H - WALL_H + 0.8, BY.BUILT);
    b.surface(SURF.STONE).ao(1);
    tiles(b, HX0 - OH, WALL_H - OH * slope, RX, RIDGE_H + 0.06, HZ0 - 0.45, HZ1 + 0.1, 13, false, seed);
    tiles(b, HX1 + OH, WALL_H - OH * slope, RX, RIDGE_H + 0.06, HZ0 - 0.45, HZ1 + 0.1, 13, false, seed + 9);
    b.color(0.34, 0.1, 0.05);
    b.beam(RX, RIDGE_H + 0.1, HZ0 - 0.5, RX, RIDGE_H + 0.1, HZ1 + 0.15, 0.13, 0.13, 6, true);
    // white fascia and barge boards; dark soffits under the eaves
    b.surface(SURF.PLAIN).color(0.52, 0.51, 0.48).ao(0.9);
    for (const s of [-1, 1]) {
      const xe = s < 0 ? HX0 - OH : HX1 + OH;
      b.box(xe, WALL_H - OH * slope - 0.1, (HZ0 + HZ1) / 2 - 0.17, 0.04, 0.11, (HZ1 - HZ0) / 2 + 0.28, false);
      for (const zc of [HZ0 - 0.46, HZ1 + 0.11]) b.beam(xe, WALL_H - OH * slope - 0.02, zc, RX, RIDGE_H + 0.02, zc, 0.07, 0.07, 4, false);
    }
    // chimney
    b.timeless().pivot(0, WALL_H, 0).appear(T_ROOF + 0.004, T_ROOF + 0.009, MOTION.CLIP, 5, BY.BUILT);
    b.surface(SURF.STONE).color(0.3, 0.12, 0.08).ao(0.95);
    b.box(-8.4, 6.0, -4.6, 0.42, 1.6, 0.42, false);
    b.color(0.25, 0.24, 0.22);
    b.box(-8.4, 7.62, -4.6, 0.5, 0.06, 0.5, false);

    // --- garage: walls, the up-and-over door, its own tiled roof (ridge across)
    b.timeless().pivot(0, 0, 0).appear(T_GAR, T_GAR + 0.008, MOTION.CLIP, GRIDGE_H + 0.2, BY.BUILT);
    b.surface(SURF.PLASTER).color(0.55, 0.535, 0.49).ao(1);
    b.box((GX0 + GX1) / 2, GWALL_H / 2, (GZ0 + GZ1) / 2, (GX1 - GX0) / 2, GWALL_H / 2, (GZ1 - GZ0) / 2, false);
    gable(b, GZ0, GZ1, GWALL_H, GRIDGE_H, GX0, -1, true);
    gable(b, GZ0, GZ1, GWALL_H, GRIDGE_H, GX1, 1, true);
    b.surface(SURF.STONE).color(0.22, 0.21, 0.2);
    b.box((GX0 + GX1) / 2, 0.2, (GZ0 + GZ1) / 2, (GX1 - GX0) / 2 + 0.04, 0.2, (GZ1 - GZ0) / 2 + 0.04, false);
    b.surface(SURF.PLAIN).color(0.5, 0.495, 0.47).ao(0.95);
    b.box(GX0 - 0.03, 1.15, DRIVE_Z, 0.04, 1.15, 1.75, false);
    b.color(0.36, 0.355, 0.34);
    for (let k = 1; k < 5; k++) b.box(GX0 - 0.075, k * 0.46, DRIVE_Z, 0.012, 0.012, 1.7, false);
    b.color(0.5, 0.49, 0.46);
    b.box(GX0 - 0.02, 2.36, DRIVE_Z, 0.05, 0.07, 1.86, false);
    const gs = (GRIDGE_H - GWALL_H) / ((GZ1 - GZ0) / 2), GR = (GZ0 + GZ1) / 2;
    b.surface(SURF.STONE).ao(1);
    tiles(b, GZ0 - 0.45, GWALL_H - 0.45 * gs, GR, GRIDGE_H + 0.05, GX0 - 0.45, GX1, 8, true, seed + 3);
    tiles(b, GZ1 + 0.45, GWALL_H - 0.45 * gs, GR, GRIDGE_H + 0.05, GX0 - 0.45, GX1, 8, true, seed + 5);
    b.color(0.34, 0.1, 0.05);
    b.beam(GX0 - 0.5, GRIDGE_H + 0.08, GR, GX1, GRIDGE_H + 0.08, GR, 0.11, 0.11, 6, true);

    // --- picket fence along the street (gaps for the path and the driveway), side and back hedges
    b.surface(SURF.PLAIN).color(0.53, 0.52, 0.49).ao(0.95);
    for (let z = -LOT_Z + 0.1, k = 0; z < LOT_Z; z += 0.16, k++) {
      if ((z > -1.45 && z < 0.05) || (z > DW_Z0 - 0.4 && z < LOT_Z - 0.5)) continue;
      const t = T_FENCE + 0.006 * (z + LOT_Z) / (2 * LOT_Z);
      b.timeless().pivot(LOT_X0, 0, z).appear(t, t + 0.002, MOTION.GROW, 0, BY.BUILT);
      b.box(LOT_X0, 0.45 + 0.02 * (k & 1), z, 0.02, 0.45 + 0.02 * (k & 1), 0.045, false);
    }
    for (const [za, zb] of [[-LOT_Z, -1.45], [0.05, DW_Z0 - 0.4]]) {
      b.timeless().pivot(LOT_X0, 0, 0).appear(T_FENCE + 0.006, T_FENCE + 0.008, MOTION.GROW, 0, BY.BUILT);
      for (const y of [0.3, 0.7]) b.box(LOT_X0 + 0.04, y, (za + zb) / 2, 0.02, 0.035, (zb - za) / 2, false);
    }
    b.surface(SURF.THATCH);
    const hedge = (x0, z0, x1, z1, h) => {
      const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 2.4)), a = Math.atan2(z1 - z0, x1 - x0);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, g = 0.85 + 0.3 * b.rand();
        const w = T_HEDGE + 0.012 * b.rand();
        b.timeless().pivot(x, 0, z).appear(w, w + 0.004, MOTION.GROW, 0, BY.BUILT);
        b.color(0.045 * g, 0.085 * g, 0.03 * g).ao(0.8);
        b.push(); b.translate(x, h * 0.5, z); b.rotateY(-a);
        b.rock(L / n * 0.62, h * 0.58, 0.5, 3, 0.18, seed * 13 + i + x, 0, 0.35);
        b.pop();
      }
    };
    hedge(LOT_X0 + 0.3, -LOT_Z, LOT_X1, -LOT_Z, 1.35);
    hedge(LOT_X1, -LOT_Z, LOT_X1, LOT_Z, 1.55);
    hedge(LOT_X1, LOT_Z, GX1 + 0.6, LOT_Z, 1.45);
    hedge(GX1 + 0.6, LOT_Z, LOT_X0 + 0.3, LOT_Z, 0.95);

    // --- mailbox by the driveway
    b.timeless().pivot(-29.1, 0, 13.3).appear(T_MAIL, T_MAIL + 0.003, MOTION.GROW, 0, BY.BUILT);
    b.surface(SURF.WOOD).color(0.5, 0.49, 0.46).ao(0.9);
    b.box(-29.1, 0.55, 13.3, 0.05, 0.55, 0.05, false);
    b.surface(SURF.PLAIN).color(0.07, 0.12, 0.09);
    b.box(-29.1, 1.2, 13.3, 0.24, 0.13, 0.13, false);
    b.color(0.42, 0.06, 0.04);
    b.box(-28.98, 1.38, 13.44, 0.015, 0.09, 0.04, false);
    b.timeless();
    return b.counts();
  },
};
