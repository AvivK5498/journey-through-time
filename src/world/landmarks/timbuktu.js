// Timbuktu: the Djinguereber Mosque, built of mud brick for Mansa Musa of Mali (1327).
// Contract: internal_docs/LANDMARKS.md. Live landmark: one build holds the whole timeline.
//
// Layout (landmark-local; road at x = -74, the car comes from +z): the long buttressed front
// wall faces the road along x = -22 (the roofed prayer hall z -4..26.5, the lower courtyard
// wall z -30..-4 with its gate portal). The tall tapering minaret, studded with projecting
// timber torons, stands in the front wall at the hall / courtyard junction; the smaller mihrab
// tower rises from the back (east) wall. Around it: low mud-brick houses and compound walls,
// a resting salt caravan on the approach side, scholars seated in shade.
//
// built (0..1, clock 155-161): brick fields drying in rows, mud pit and workers at 0; walls
// rise course by course (CLIP) chunk by chunk 0.14-0.66 with timber scaffolds along them, the
// brick rows used up as they go; roof 0.5, mihrab tower 0.42, gate 0.38; the minaret last
// (0.6-0.93) inside its own scaffold; pinnacles grow as each stretch tops out; the caravan
// arrives 0.75, the scholars sit 0.93, workers and scaffolds gone by 0.98.
// decay (0..0.25 only, clock 230-300): rain darkens the faces in streaks under the parapets and
// torons, pinnacles soften and shrink a little, the caravan leaves; patches of fresh
// replaster appear 0.1-0.24 with a ladder and two plasterers: maintained, never a ruin.

import { SURF, POSE, MOTION, BY } from './kit.js';

const TAU = Math.PI * 2;
const MUD = [0.36, 0.215, 0.112];
const ROOF = [0.42, 0.27, 0.15];
const TORON = [0.15, 0.115, 0.08];
const DOOR = [0.022, 0.018, 0.015];
const FRESH = [0.5, 0.31, 0.16];
const STREAK = [0.22, 0.135, 0.075];
const WET = [0.15, 0.09, 0.05];
const BRICK = [0.27, 0.165, 0.09];
const CAMEL = [0.31, 0.215, 0.13];
const SALT = [0.4, 0.39, 0.36];
const INDIGO = [0.045, 0.06, 0.14];
const CREAM = [0.5, 0.46, 0.38];
const MADDER = [0.3, 0.07, 0.045];
const STRAW = [0.42, 0.33, 0.17];

const SHAPE = new Float64Array(16);
const PATH = new Float64Array(6);
const SQP = 3.4; // squircle exponent of the towers (rounded square plan)

const MX = -19.3, MZ = -4; // minaret centre
const MH = 21.2; // minaret height (crown top)
const mr = (y) => 4.5 - (4.5 - 1.88) * (y - 1.5) / 15.8; // minaret half width at height y

let JIT = 0;
function col(b, c, j = 0.04) {
  const k = 1 + (b.rand() - 0.5) * 2 * j; JIT = k;
  b.color(c[0] * k, c[1] * k, c[2] * k);
  return b;
}
const sqm = (th) => Math.pow(Math.pow(Math.abs(Math.cos(th)), SQP) + Math.pow(Math.abs(Math.sin(th)), SQP), -1 / SQP);
const SQW = (th) => sqm(th) - 1;
// distance from the axis to a squircle face at lateral offset v (half width r)
const sqFace = (r, v) => r * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v / r), SQP)), 1 / SQP);

// Battered wall cross-section with a soft rounded parapet; returns the batter slope.
function wallShape(tb, tt, h) {
  const s = (tb - tt) / h, f = (y) => tb - s * y, P = SHAPE;
  P[0] = f(-0.4); P[1] = -0.4; P[2] = f(h * 0.5); P[3] = h * 0.5; P[4] = f(h - 0.32); P[5] = h - 0.32;
  P[6] = tt * 0.6; P[7] = h - 0.03; P[8] = -tt * 0.6; P[9] = h - 0.03;
  P[10] = -f(h - 0.32); P[11] = h - 0.32; P[12] = -f(h * 0.5); P[13] = h * 0.5; P[14] = -f(-0.4); P[15] = -0.4;
  return s;
}
// A straight slab of mud along local +x from 0 to L (shape set by wallShape).
function slab(b, L) {
  PATH[0] = 0; PATH[1] = 0; PATH[2] = 0; PATH[3] = L; PATH[4] = 0; PATH[5] = 0;
  b.extrude(PATH, SHAPE, { caps: true });
}
// Dark doorway with a timber lintel on the battered face (local frame of a slab).
function door(b, u, side, tb, s, w, hh) {
  b.push(); b.translate(u, 0, side * tb); b.rotateX(-side * Math.atan(s));
  b.color(DOOR[0], DOOR[1], DOOR[2]).surface(SURF.PLAIN).ao(0.12);
  b.box(0, hh * 0.5, -side * 0.12, w * 0.5, hh * 0.5, 0.15, false);
  col(b, TORON).surface(SURF.WOOD).ao(0.8);
  b.box(0, hh + 0.1, 0, w * 0.5 + 0.28, 0.09, 0.13, false);
  b.pop();
}
function toron(b, u, y, side, fy, out, r) {
  b.beam(u, y, side * (fy - 0.3), u, y - 0.05, side * (fy + out), r, r * 0.85, 4, true);
}
// Round buttress (body only) at (x, z) of the current frame, height h.
function buttress(b, x, z, r, h) {
  b.push(); b.translate(x, 0, z);
  b.lathe([r, -0.4, r * 0.96, h * 0.4, r * 0.8, h * 0.85, r * 0.7, h + 0.05, r * 0.5, h + 0.24, 0, h + 0.3], 9);
  b.pop();
}
// Pinnacle on top of a buttress: grows when its stretch tops out, softens in the rain.
function pinnacle(b, x, y, z, r, hp, t) {
  b.push(); b.translate(x, y, z);
  b.timeless().pivot(0, 0, 0).appear(t, t + 0.05, MOTION.GROW, 0, BY.BUILT).vanish(0, 1, MOTION.SCALE, 0, BY.DECAY);
  b.lathe([r, 0, r * 0.84, hp * 0.42, r * 0.52, hp * 0.76, r * 0.16, hp * 0.97, 0, hp], 9);
  b.pop();
}
// Patch on a battered face (local frame of a slab): a blob of nseg points.
function faceBlob(b, u, y, side, tb, s, rw, rh, off) {
  const fz = (py) => side * (tb - s * py + off);
  const c = b.vertex(u, y, fz(y), 0, s, side), c0 = b.nv;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU, rr = 0.72 + 0.28 * b.rand();
    const py = y + Math.sin(a) * rh * rr;
    b.vertex(u + Math.cos(a) * rw * rr, py, fz(py), 0, s, side);
  }
  for (let i = 0; i < 9; i++) b.tri(c, c0 + i, c0 + (i + 1) % 9);
}
function streak(b, u, y0, y1, side, tb, s, w) {
  const fz = (py) => side * (tb - s * py + 0.02);
  const i0 = b.vertex(u - w * 0.5, y1, fz(y1), 0, s, side), i1 = b.vertex(u + w * 0.5, y1, fz(y1), 0, s, side);
  const i2 = b.vertex(u + w * 0.2, y0, fz(y0), 0, s, side), i3 = b.vertex(u - w * 0.2, y0, fz(y0), 0, s, side);
  b.quad(i0, i1, i2, i3);
}

// One wall from (x0, z0) to (x1, z1), exterior toward (ox, oz). o: sp (buttress spacing),
// rows (toron heights), doors (bay indices), weather (streaks and replaster patches), scaf.
function wallRun(b, x0, z0, x1, z1, ox, oz, h, tb, tt, t0, spread, o) {
  const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz), yaw = Math.atan2(-dz, dx);
  const side = Math.sin(yaw) * ox + Math.cos(yaw) * oz > 0 ? 1 : -1;
  b.push(); b.at(x0, 0, z0, yaw);
  const n = Math.max(1, Math.round(L / 9)), nb = Math.max(1, Math.round(L / o.sp)), bw = L / nb;
  const win = (u) => t0 + spread * Math.min(n - 1, Math.floor(u / L * n)) / Math.max(1, n - 1);
  const clip = (u) => { const w = win(u); b.timeless().pivot(0, 0, 0).appear(w, w + 0.15, MOTION.CLIP, h + 0.8, BY.BUILT); };
  for (let i = 0; i < n; i++) {
    const ua = L * i / n, ub = L * (i + 1) / n;
    clip(ua + 0.01);
    const s = wallShape(tb, tt, h);
    col(b, MUD, 0.03).surface(SURF.PLASTER).ao(1);
    b.push(); b.translate(ua, 0, 0); slab(b, ub - ua); b.pop();
    // dark footing strip (the plan marked out before the walls rise)
    b.timeless().color(WET[0], WET[1], WET[2]).surface(SURF.EARTH).ao(0.9);
    b.box((ua + ub) * 0.5, 0.03, 0, (ub - ua) * 0.5, 0.025, tb - 0.06, false);
    void s;
  }
  const s = wallShape(tb, tt, h);
  for (let k = 1; k < nb; k++) { // buttresses with their pinnacles
    const u = bw * k;
    clip(u);
    col(b, MUD, 0.03).surface(SURF.PLASTER).ao(1);
    buttress(b, u, side * tb * 0.8, 0.82, h);
    col(b, MUD, 0.03).surface(SURF.PLASTER).ao(1);
    pinnacle(b, u, h + 0.15, side * tb * 0.8, 0.42, 0.95, win(u) + 0.13);
  }
  for (let k = 0; k < nb; k++) { // torons, doors, weather per bay
    const um = bw * (k + 0.5);
    clip(um);
    col(b, TORON, 0.1).surface(SURF.WOOD).ao(0.85);
    for (const y of o.rows) for (const du of [-0.7, 0.7]) toron(b, um + du, y, side, tb - s * y, 0.55, 0.075);
    if (o.doors && o.doors.indexOf(k) >= 0) door(b, um, side, tb, s, 1.15, 2.3);
    if (!o.weather) continue;
    b.timeless().appear(0.02 + 0.12 * b.rand(), 0.2, MOTION.FADE, 0, BY.DECAY);
    col(b, STREAK, 0.08).surface(SURF.PLASTER).ao(1);
    for (let q = 0; q < 2; q++) streak(b, um + (b.rand() - 0.5) * bw * 0.7, h - 0.45 - 1.2 - 2.4 * b.rand(), h - 0.45, side, tb, s, 0.3 + 0.3 * b.rand());
    for (const y of o.rows) for (const du of [-0.7, 0.7]) if (b.rand() < 0.6) streak(b, um + du, y - 0.5 - 1.2 * b.rand(), y - 0.1, side, tb, s, 0.22);
    if (b.rand() < 0.55) {
      const t = 0.1 + 0.13 * b.rand();
      b.timeless().pivot(0, 0, 0).appear(t, t + 0.015, MOTION.PUSH, 0.08, BY.DECAY);
      col(b, FRESH, 0.05).surface(SURF.PLASTER).ao(1);
      faceBlob(b, um + (b.rand() - 0.5) * bw * 0.4, 1.0 + (h - 2.4) * b.rand(), side, tb, s, 0.7 + 0.7 * b.rand(), 0.5 + 0.5 * b.rand(), 0.04);
    }
  }
  if (o.scaf) { // timber scaffold along the outside while the wall rises
    col(b, TORON, 0.1).surface(SURF.WOOD).ao(0.9);
    for (let i = 0; i < n; i++) {
      const ua = L * i / n, ub = L * (i + 1) / n, w = win(ua + 0.01);
      b.timeless().appear(w - 0.03, w, MOTION.POP, 0, BY.BUILT).vanish(w + 0.2, w + 0.23, MOTION.POP, 0, BY.BUILT);
      const zo = side * (tb + 1.5), np = Math.max(2, Math.round((ub - ua) / 3));
      for (let p = 0; p <= np; p++) b.beam(ua + (ub - ua) * p / np, -0.3, zo, ua + (ub - ua) * p / np, h + 1.2, zo, 0.07, 0.06, 4, false);
      for (const y of [2.2, 4.3, h - 0.3]) b.beam(ua, y, zo, ub, y, zo, 0.055, 0.055, 4, false);
      for (let p = 0; p < np; p++) b.beam(ua + (ub - ua) * p / np, 0.2, zo, ua + (ub - ua) * (p + 1) / np, h, zo, 0.045, 0.045, 4, false);
    }
  }
  b.pop();
}

// Squircle tower about the current origin with a CLIP tag; torons on faces in `faces`.
function tower(b, prof, rAt, y0, y1, dy, faces, cols, t0, t1, hmax) {
  b.timeless().pivot(0, 0, 0).appear(t0, t1, MOTION.CLIP, hmax + 0.4, BY.BUILT);
  col(b, MUD, 0.02).surface(SURF.PLASTER).ao(1);
  b.lathe(prof, 28, { wobble: SQW });
  col(b, TORON, 0.08).surface(SURF.WOOD).ao(0.85);
  for (let y = y0; y <= y1 + 1e-6; y += dy) {
    const r = rAt(y), nc = Math.max(2, Math.min(cols, Math.floor(1.3 * r / 1.05) + 1));
    for (const f of faces) {
      const fx = Math.cos(f * Math.PI / 2), fz = Math.sin(f * Math.PI / 2);
      for (let c = 0; c < nc; c++) {
        const v = (c / (nc - 1) - 0.5) * 1.3 * r, d = sqFace(r, v);
        b.beam(fx * (d - 0.35) - fz * v, y, fz * (d - 0.35) + fx * v, fx * (d + 0.9) - fz * v, y - 0.07, fz * (d + 0.9) + fx * v, 0.095, 0.08, 4, true);
      }
    }
  }
}

// Couched or standing camel facing +z at the origin.
function camel(b, standing, seed) {
  col(b, CAMEL, 0.12).surface(SURF.HIDE).ao(1);
  const y = standing ? 1.55 : 0.62;
  b.push(); b.translate(0, y, 0); b.ellipsoid(0.48, 0.45, 1.0, 3); b.pop();
  b.push(); b.translate(0, y + 0.36, -0.1); b.ellipsoid(0.3, 0.32, 0.42, 2); b.pop();
  const nk = standing ? [0, y + 0.1, 0.85, 0, y - 0.1, 1.4, 0, y + 0.6, 1.75] : [0, y + 0.05, 0.85, 0, y + 0.3, 1.45, 0, y + 1.0, 1.7];
  b.beam(nk[0], nk[1], nk[2], nk[3], nk[4], nk[5], 0.16, 0.11, 6);
  b.beam(nk[3], nk[4], nk[5], nk[6], nk[7], nk[8], 0.11, 0.09, 6);
  b.push(); b.translate(nk[6], nk[7] + 0.02, nk[8] + 0.22); b.rotateX(0.3); b.ellipsoid(0.15, 0.16, 0.36, 2); b.pop();
  b.beam(0, y + 0.1, -0.95, 0, y - 0.5, -1.05, 0.05, 0.03, 4); // tail
  if (standing) {
    for (const sx of [-0.27, 0.27]) for (const sz of [-0.62, 0.62]) {
      b.beam(sx, y - 0.2, sz, sx * 1.1, 0.75, sz + 0.05, 0.11, 0.07, 5, false);
      b.beam(sx * 1.1, 0.75, sz + 0.05, sx * 1.1, 0.04, sz, 0.07, 0.06, 5, true);
    }
    // load: salt slabs lashed either side of the hump
    col(b, SALT, 0.05).surface(SURF.STONE).ao(0.95);
    for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) b.box(sx * (0.56 + i * 0.09), y + 0.2, -0.1, 0.04, 0.24, 0.5);
  } else {
    for (const sx of [-0.45, 0.45]) { b.push(); b.translate(sx, 0.16, 0.25); b.ellipsoid(0.17, 0.15, 0.55, 2); b.pop(); }
  }
  void seed;
}
function saltPile(b, n) {
  col(b, SALT, 0.06).surface(SURF.STONE).ao(0.9);
  for (let i = 0; i < n; i++) {
    b.push(); b.translate((b.rand() - 0.5) * 0.08, 0.045 + i * 0.085, (b.rand() - 0.5) * 0.08); b.rotateY((b.rand() - 0.5) * 0.25);
    b.box(0, 0, 0, 0.52, 0.04, 0.24); b.pop();
  }
  b.push(); b.translate(0.75, 0, 0); b.rotateZ(0.32); b.box(0, 0.5, 0, 0.04, 0.5, 0.24); b.pop(); // one leaning
}
function bundle(b, c, sx, sy, sz) { col(b, c, 0.08).surface(SURF.HIDE).ao(0.95); b.push(); b.translate(0, sy * 0.9, 0); b.ellipsoid(sx, sy, sz, 2); b.pop(); }
function person(b, x, z, yaw, pose, c, h, seed) {
  col(b, c, 0.1).surface(SURF.HIDE).ao(1);
  b.push(); b.at(x, 0, z, yaw); b.human(pose, h, seed); b.pop();
}
// Low mud-brick house (wall run along local x, front side +z) with door and spouts.
function house(b, cx, cz, lx, lz, h, yaw, t) {
  b.push(); b.at(cx, 0, cz, yaw); b.translate(-lx / 2, 0, 0);
  if (t >= 0) b.timeless().pivot(0, 0, 0).appear(t, t + 0.12, MOTION.GROW, 0, BY.BUILT); else b.timeless();
  const s = wallShape(lz / 2, lz / 2 - 0.22, h);
  col(b, MUD, 0.07).surface(SURF.PLASTER).ao(1);
  slab(b, lx);
  door(b, lx * (0.3 + 0.4 * b.rand()), 1, lz / 2, s, 0.95, 1.9);
  col(b, TORON, 0.1).surface(SURF.WOOD).ao(0.85);
  for (let i = 0; i < 3; i++) toron(b, lx * (0.2 + 0.3 * i), h - 0.45, 1, lz / 2 - s * (h - 0.45), 0.45, 0.07);
  // a small rooftop room on the bigger ones
  if (lx > 7.5) { col(b, MUD, 0.05).surface(SURF.PLASTER); b.push(); b.translate(lx * 0.62, h - 0.2, -lz * 0.12); wallShape(1.4, 1.2, 2.0); slab(b, 2.6); b.pop(); }
  b.pop();
}
function lowWall(b, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  b.push(); b.at(x0, 0, z0, Math.atan2(-dz, dx)); b.timeless();
  wallShape(0.36, 0.24, 2.1); col(b, MUD, 0.06).surface(SURF.PLASTER).ao(1); slab(b, Math.hypot(dx, dz));
  b.pop();
}

const HALL_H = 6.6, COURT_H = 4.8;

export default {
  id: 'timbuktu',
  name: 'Djinguereber Mosque',
  caption: 'Mansa Musa has the great mosque of Timbuktu built of mud brick',
  year: 1327,
  radius: 66,
  pad: 67,
  roadOffset: 74, // road centre line at x = -74; corridor edge 67.5 m out; nothing west of x = -47
  straddlesRoad: false,
  biome: 'desert',
  live: true,
  lights: [],
  detail: { at: [MX, 9, MZ], from: [-44, 5, 18] },
  strip: { at: [-12, 6, -2], from: [-84, 9, 46], fov: 0.66 },
  // Event moment: from high over the road shoulder on the approach side, the minaret and its
  // torons in front of the long buttressed wall, the courtyard and roof behind.
  witness: { at: [-12, -2], dist: 82, height: 24, look: 8, az: 0.62, fov: 0.56, drift: 0.08 },
  // The town of Timbuktu around it: clusters of flat-roofed mud houses rising with the mosque,
  // the nearest with a second tapering minaret (Sankore) on the skyline.
  satellites: {
    count: [5, 7], near: 2, nearR: [140, 230], farR: [280, 750],
    centre: 0.2, spread: 4.6, minSep: 85, roadClear: 40,
    build(b, k, n, dist) {
      const t = 0.08 + 0.6 * k / n, sc = 1 + dist / 1200;
      b.push(); b.scale(sc, sc, sc);
      if (k === 0) {
        b.push(); b.translate(6, 0, 0);
        const r = (y) => 3.2 - 0.14 * y;
        tower(b, [3.3, -0.4, 3.2, 1, 1.4, 13.6, 1.0, 14.6, 0.4, 15.4, 0, 15.6], r, 2, 12, 1.6, [0, 1, 2, 3], 3, t, t + 0.12, 15.6);
        b.pop();
      }
      const nh = 2 + (b.rand() < 0.5 ? 1 : 0);
      for (let i = 0; i < nh; i++) {
        const a = b.rand() * TAU, rr = i === 0 ? 0 : 9 + 4 * b.rand();
        house(b, Math.cos(a) * rr - (k === 0 ? 4 : 0), Math.sin(a) * rr, 7 + 3 * b.rand(), 5.5 + 2 * b.rand(), 3 + 0.8 * b.rand(), b.rand() * TAU, t + 0.03 * i);
      }
      b.pop();
    },
  },

  *build(b, built, decay, seed) {
    b.seed((seed | 0) * 13 + 9);
    const W = (x0, z0, x1, z1, ox, oz, h, tb, tt, t0, sp, o) => wallRun(b, x0, z0, x1, z1, ox, oz, h, tb, tt, t0, sp, o);

    // --- the mosque walls (prayer hall, then courtyard)
    W(-22, -4, -22, 26.5, -1, 0, HALL_H, 1.1, 0.62, 0.14, 0.2, { sp: 3, rows: [2.5, 4.6], doors: [2, 5, 8], weather: true, scaf: true });
    W(-22, 26.5, 10, 26.5, 0, 1, HALL_H, 1.1, 0.62, 0.17, 0.2, { sp: 3.2, rows: [2.5, 4.6], doors: [4], weather: true, scaf: true });
    W(10, 26.5, 10, -4, 1, 0, HALL_H, 1.1, 0.62, 0.22, 0.16, { sp: 4, rows: [] });
    W(-22, -4, 10, -4, 0, -1, HALL_H, 1.1, 0.62, 0.24, 0.16, { sp: 4, rows: [3.2], doors: [2, 5] });
    yield;
    W(-22, -30, -22, -4, -1, 0, COURT_H, 1.0, 0.6, 0.3, 0.16, { sp: 3, rows: [2.6], weather: true, scaf: true });
    W(-22, -30, 10, -30, 0, -1, COURT_H, 1.0, 0.6, 0.34, 0.14, { sp: 3.5, rows: [2.6] });
    W(10, -30, 10, -4, 1, 0, COURT_H, 1.0, 0.6, 0.38, 0.12, { sp: 4, rows: [] });
    // big rounded corner towers with pinnacles
    for (const c of [[-22, 26.5, HALL_H, 0.17], [10, 26.5, HALL_H, 0.36], [10, -30, COURT_H, 0.5], [-22, -30, COURT_H, 0.46], [10, -4, HALL_H, 0.4]]) {
      b.timeless().pivot(0, 0, 0).appear(c[3], c[3] + 0.15, MOTION.CLIP, c[2] + 1, BY.BUILT);
      col(b, MUD, 0.03).surface(SURF.PLASTER).ao(1);
      buttress(b, c[0], c[1], 1.55, c[2] + 0.5);
      col(b, MUD, 0.03);
      pinnacle(b, c[0], c[2] + 0.7, c[1], 0.75, 1.6, c[3] + 0.14);
    }
    // gate portal in the courtyard front wall
    b.push(); b.at(-23.2, 0, -19.6, -Math.PI / 2);
    b.timeless().pivot(0, 0, 0).appear(0.38, 0.55, MOTION.CLIP, 7.4, BY.BUILT);
    let s = wallShape(1.7, 1.15, 6.4);
    col(b, MUD, 0.02).surface(SURF.PLASTER).ao(1);
    slab(b, 5.2);
    door(b, 2.6, 1, 1.7, s, 1.8, 3.0);
    col(b, TORON, 0.1).surface(SURF.WOOD).ao(0.85);
    for (const y of [3.9, 5.2]) for (const u of [0.9, 1.9, 3.3, 4.3]) toron(b, u, y, 1, 1.7 - s * y, 0.55, 0.075);
    col(b, MUD, 0.02).surface(SURF.PLASTER);
    for (const u of [0.5, 4.7]) pinnacle(b, u, 6.3, 0.55, 0.5, 1.7, 0.54);
    b.pop();
    yield;

    // --- roof of the prayer hall (flat, with dark hatches) and the courtyard
    b.timeless().appear(0.5, 0.6, MOTION.RISE, 0.5, BY.BUILT);
    col(b, ROOF, 0).surface(SURF.PLASTER).ao(1);
    b.box(-6, 5.95, 11.25, 15.4, 0.2, 14.65, false);
    b.color(DOOR[0], DOOR[1], DOOR[2]).surface(SURF.PLAIN).ao(0.3);
    for (let i = 0; i < 8; i++) b.box(-17 + 3.6 * i, 6.18, 3 + 15 * ((i * 7) % 3) / 2, 0.45, 0.05, 0.45, false);
    b.timeless();
    col(b, [0.5, 0.37, 0.22], 0).surface(SURF.EARTH).ao(1);
    b.box(-6, 0.025, -17, 15.2, 0.02, 12.2, false); // courtyard sand
    // shaded gallery along the courtyard's back
    b.timeless().pivot(0, 0, 0).appear(0.45, 0.6, MOTION.CLIP, 4.4, BY.BUILT);
    col(b, MUD, 0.02).surface(SURF.PLASTER).ao(0.9);
    for (let i = 0; i < 8; i++) { b.push(); b.translate(4.2, 0, -27.5 + 3.2 * i); b.lathe([0.5, 0, 0.42, 3.7, 0.55, 3.85], 8); b.pop(); }
    col(b, ROOF, 0.02).ao(1);
    b.box(6.8, 3.95, -17, 2.75, 0.17, 12.45, false);
    b.color(0.2, 0.12, 0.065).surface(SURF.EARTH).ao(0.45);
    b.box(6.9, 0.04, -17, 2.6, 0.02, 12.3, false); // its shade on the ground (no sun shadow at range)
    yield;

    // --- the mihrab tower on the back wall
    b.push(); b.at(12.4, 0, 11);
    tower(b, [3.0, -0.4, 2.9, 1, 1.9, 9.5, 2.05, 9.62, 2.05, 10.1, 1.3, 10.22, 1.05, 11.2, 0.5, 11.9, 0, 12.05],
      (y) => 2.9 - 0.105 * (y - 1), 2, 8.4, 1.6, [0, 1, 3], 4, 0.42, 0.62, 12.05);
    b.pop();

    // --- the minaret, last: tapering, studded with torons, crown with four pinnacles
    b.push(); b.at(MX, 0, MZ);
    tower(b, [4.7, -0.4, 4.5, 1.5, mr(7), 7, mr(12.5), 12.5, 1.88, 17.3, 2.15, 17.42, 2.15, 18.15, 1.42, 18.3, 1.3, 19.5, 0.92, 20.4, 0.42, 21.0, 0, MH],
      mr, 2.1, 16.6, 1.21, [0, 1, 2, 3], 6, 0.6, 0.93, MH);
    b.pop();
    b.push(); b.at(MX - 4.66, 0, MZ); b.rotateY(-Math.PI / 2);
    b.timeless().pivot(0, 0, 0).appear(0.6, 0.93, MOTION.CLIP, MH, BY.BUILT);
    door(b, 0, 1, 0, 0.1658, 1.05, 2.2);
    b.pop();
    b.push(); b.at(MX, 0, MZ);
    col(b, MUD, 0.02).surface(SURF.PLASTER);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) pinnacle(b, sx * 1.62, 18.05, sz * 1.62, 0.34, 1.25, 0.9);
    b.timeless().appear(0.93, 0.96, MOTION.GROW, 0, BY.BUILT);
    b.color(0.6, 0.57, 0.5).surface(SURF.POLISH).ao(1);
    b.push(); b.translate(0, MH + 0.12, 0); b.ellipsoid(0.17, 0.24, 0.17, 2); b.pop(); // ostrich egg finial
    // its scaffold: eight poles following the taper, ledgers every 3 m
    b.timeless().appear(0.57, 0.6, MOTION.POP, 0, BY.BUILT).vanish(0.95, 0.98, MOTION.POP, 0, BY.BUILT);
    col(b, TORON, 0.08).surface(SURF.WOOD).ao(0.9);
    for (let f = 0; f < 4; f++) {
      const fx = Math.cos(f * Math.PI / 2), fz = Math.sin(f * Math.PI / 2);
      for (const v of [-0.55, 0.55]) {
        const bx = 5.9, tx = 3.1;
        b.beam(fx * bx - fz * v * 4.5, -0.3, fz * bx + fx * v * 4.5, fx * tx - fz * v * 1.9, 20, fz * tx + fx * v * 1.9, 0.08, 0.06, 4, false);
      }
      for (let y = 3; y < 19; y += 3) {
        const rr = mr(y) + 1.45 - 0.0 * y, w = mr(y) * 0.6 + 0.6;
        b.beam(fx * rr - fz * w, y, fz * rr + fx * w, fx * rr + fz * w, y, fz * rr - fx * w, 0.055, 0.055, 4, false);
      }
    }
    b.pop();
    yield;

    // --- front walls' doors already in the runs; now the houses and compound walls
    house(b, -40, -44, 8, 6, 3.4, 0.1, -1);
    house(b, -4, -48, 10, 6, 3.8, 0.04, -1);
    house(b, 16, -46, 7, 7, 3.2, -0.05, 0.3);
    house(b, 30, -26, 8, 7, 3.6, Math.PI / 2 + 0.08, 0.42);
    house(b, 37, 8, 7, 8, 3.4, Math.PI / 2, -1);
    house(b, 32, 34, 8.4, 7, 3.6, 0.12 + Math.PI, 0.55);
    house(b, -45, 6, 7.5, 5.5, 3.0, -Math.PI / 2, -1);
    lowWall(b, 20.5, -42.5, 26.5, -29.8);
    lowWall(b, 37, 12.2, 34.5, 30.4);
    lowWall(b, -35.6, -44.6, -9.4, -47.6);
    yield;

    // --- construction (built < 1): brick fields, mud pit, stacks, workers
    for (let r = 0; r < 7; r++) { // field 1 on the approach side
      const t = 0.26 + 0.07 * r;
      b.timeless().vanish(t, t + 0.02, MOTION.POP, 0, BY.BUILT);
      for (let i = 0; i < 38; i++) {
        col(b, BRICK, 0.1).surface(SURF.EARTH).ao(0.95);
        b.box(-17 + i * 0.62, 0.06, 33 + r * 2.1 + (b.rand() - 0.5) * 0.06, 0.2, 0.06, 0.12, false);
      }
    }
    for (let r = 0; r < 5; r++) { // field 2 between the courtyard and the road
      const t = 0.18 + 0.06 * r;
      b.timeless().vanish(t, t + 0.02, MOTION.POP, 0, BY.BUILT);
      for (let i = 0; i < 26; i++) {
        col(b, BRICK, 0.1).surface(SURF.EARTH).ao(0.95);
        b.box(-44 + r * 2.1 + (b.rand() - 0.5) * 0.06, 0.06, -24.5 + i * 0.62, 0.12, 0.06, 0.2, false);
      }
    }
    b.timeless().vanish(0.86, 0.9, MOTION.POP, 0, BY.BUILT);
    b.surface(SURF.EARTH).ao(0.8);
    b.push(); b.translate(-27, 0, 40);
    b.disc(3.2, 18, 3, (x, z) => { const r = Math.hypot(x, z) / 3.2; b.color(WET[0] * (0.8 + 0.5 * r), WET[1] * (0.8 + 0.5 * r), WET[2] * (0.8 + 0.5 * r)); return 0.035 + 0.12 * Math.max(0, r - 0.75); });
    b.pop();
    b.push(); b.translate(-31.5, 0, 42.5); bundle(b, STRAW, 1.1, 0.55, 0.9); b.pop();
    for (let i = 0; i < 3; i++) { // water jars
      col(b, [0.3, 0.16, 0.08], 0.08).surface(SURF.EARTH).ao(0.95);
      b.push(); b.translate(-23.5 + i * 0.75, 0, 37.5); b.lathe([0.05, 0, 0.3, 0.12, 0.32, 0.38, 0.14, 0.62, 0.17, 0.7], 8); b.pop();
    }
    for (const p of [[-28, -2], [-28, 22], [-14, 30], [16, 2]]) { // stacks of dried brick by the walls
      b.timeless().appear(0.08, 0.12, MOTION.POP, 0, BY.BUILT).vanish(0.55, 0.6, MOTION.POP, 0, BY.BUILT);
      col(b, [0.33, 0.2, 0.105], 0.05).surface(SURF.EARTH).ao(0.9);
      b.push(); b.translate(p[0], 0, p[1]); b.block(1.2, 0.8, 1.05, 0.65, 1.1); b.pop();
    }
    b.timeless().vanish(0.93, 0.96, MOTION.POP, 0, BY.BUILT);
    person(b, -10, 32.2, 0.3, POSE.KNEEL, CREAM, 1.68, 11);
    person(b, 2, 39.5, -2.6, POSE.KNEEL, INDIGO, 1.7, 12);
    person(b, -26, 42.2, 2.8, POSE.KNEEL, CREAM, 1.66, 13);
    person(b, -28.5, 37.5, -0.4, POSE.STAND, INDIGO, 1.75, 14);
    person(b, -29.5, 4, 0.2, POSE.HAUL, CREAM, 1.7, 15);
    person(b, -29, 6.2, 0.2, POSE.HAUL, CREAM, 1.72, 16);
    person(b, -36, -16, 1.5, POSE.KNEEL, INDIGO, 1.7, 17);
    person(b, -24, -34, -0.8, POSE.WALK, CREAM, 1.72, 18);
    yield;

    // --- the finished mosque in use: scholars in the shade, the salt caravan resting
    b.timeless().appear(0.9, 0.94, MOTION.POP, 0, BY.BUILT);
    col(b, TORON, 0.08).surface(SURF.WOOD).ao(0.9);
    for (const p of [[-31.2, 7.6], [-31.2, 15.4], [-26.6, 7.6], [-26.6, 15.4]]) b.beam(p[0], -0.2, p[1], p[0], 2.45, p[1], 0.075, 0.065, 5);
    col(b, STRAW, 0.04).surface(SURF.THATCH).ao(1);
    b.box(-28.9, 2.5, 11.5, 2.75, 0.06, 4.3, true);
    b.color(0.3, 0.19, 0.105).surface(SURF.EARTH).ao(0.6);
    b.box(-28.6, 0.04, 11.3, 2.7, 0.02, 4.2, false); // shade
    person(b, -28.2, 9.6, -1.75, POSE.SIT, CREAM, 1.66, 21);
    person(b, -27.6, 12.2, -1.45, POSE.SIT, INDIGO, 1.64, 22);
    person(b, -28.4, 14.2, -1.2, POSE.SIT, CREAM, 1.62, 23);
    person(b, -30.6, 11.4, 1.57, POSE.STAND, CREAM, 1.78, 24);
    person(b, 6.6, -20, 1.57, POSE.SIT, CREAM, 1.64, 25);
    person(b, 6.4, -18.4, 1.9, POSE.SIT, INDIGO, 1.64, 26);
    person(b, 6.8, -11, 1.4, POSE.SIT, CREAM, 1.62, 27);
    // caravan: arrives with the finished mosque, leaves early in the modern era
    const CAM = [[-38, 33, 0.9, 0], [-34, 36.5, -0.4, 0], [-40.5, 39.5, 1.6, 0], [-35, 42.5, 2.6, 0], [-30.5, 41, -1.2, 1], [-42, 45, 0.3, 0]];
    for (let i = 0; i < CAM.length; i++) {
      const c = CAM[i], tv = 0.03 + 0.012 * i;
      b.timeless().appear(0.74 + 0.01 * i, 0.78 + 0.01 * i, MOTION.POP, 0, BY.BUILT).vanish(tv, tv + 0.01, MOTION.POP, 0, BY.DECAY);
      b.push(); b.at(c[0], 0, c[1], c[2]); camel(b, c[3] === 1, i); b.pop();
    }
    b.timeless().appear(0.76, 0.8, MOTION.POP, 0, BY.BUILT).vanish(0.1, 0.11, MOTION.POP, 0, BY.DECAY);
    for (const p of [[-33, 30.5, 9], [-37.5, 46, 7], [-28.6, 36.2, 8]]) { b.push(); b.at(p[0], 0, p[1], b.rand() * 3); saltPile(b, p[2]); b.pop(); }
    for (const p of [[-36.2, 35.6, MADDER], [-31.6, 33.8, INDIGO], [-39, 42.2, STRAW], [-32.8, 44.6, MADDER]]) { b.push(); b.translate(p[0], 0, p[1]); bundle(b, p[2], 0.45, 0.32, 0.55); b.pop(); }
    person(b, -32, 38.6, -2.2, POSE.STAND, INDIGO, 1.82, 31);
    person(b, -36.4, 30.4, 0.6, POSE.STAND, CREAM, 1.74, 32);
    person(b, -30.4, 34.6, 2.4, POSE.KNEEL, INDIGO, 1.76, 33);

    // --- the yearly replastering (decay): a ladder and two plasterers on the front wall
    b.timeless().appear(0.15, 0.16, MOTION.POP, 0, BY.DECAY);
    col(b, TORON, 0.05).surface(SURF.WOOD).ao(0.9);
    for (const dz of [-0.3, 0.3]) b.beam(-25.6, 0, 17.5 + dz, -23.3, 5.6, 17.5 + dz, 0.05, 0.05, 4);
    for (let i = 1; i < 10; i++) { const k = i / 10; b.beam(-25.6 + 2.3 * k, 5.6 * k, 17.2, -25.6 + 2.3 * k, 5.6 * k, 17.8, 0.03, 0.03, 4, false); }
    person(b, -25.4, 19, -1.6, POSE.STAND, CREAM, 1.74, 41);
    person(b, -24.6, 14.6, -1.5, POSE.KNEEL, INDIGO, 1.7, 42);
    b.timeless();
    return b.counts();
  },
};
