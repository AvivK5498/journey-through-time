// Mill town (event 14, 1769 onward): the birth of the factory age in a wooded river valley.
// Contract: internal_docs/LANDMARKS.md. Live: one build holds the whole timeline.
//
// built (0 -> 1 over the whole Industry era, so the town grows while the player watches):
//   0.00       a gritstone spinning mill of five storeys by the weir and the mill pond, its
//              waterwheel (rig 1) turning in the wheel pit; cottages, woods all round
//   0.06-0.13  the mill is lengthened; 0.16-0.24 a canal with a wharf, warehouse, narrowboat
//   0.26-0.38  steam: engine house and a square chimney, smoke from 0.34; a stone bridge
//   0.36-0.56  a brick mill downstream and its octagonal chimney; gas lamps (0.45);
//              terraces of workers' houses climb the valley side one row after another
//   0.60-0.80  the great seven-storey brick mill with its stair tower, a 64 m chimney
//   0.82-1.00  a gasholder; the smoke thickens; the hillside woods are gone
//   Windows light up storey by storey as the mills fill (gas light), the ground turns to cinder.
// decay (0 -> 0.35, 1914-2026): the chimneys go cold one after another, the wheel stops,
//   windows go dark and some are boarded, the downstream mill loses its roof (rafters bare),
//   its chimney is cut down, the canal greens over, the boat settles, trees come back.
//
// Layout (road at x = -126, the car comes from +z): canal nearest the road, then the river
// with the weir and pond, the mills on the far bank, the valley side with its terraces behind.

import { SURF, POSE, MOTION, BY, FLICKER, fbm3, noise3, seg } from './kit.js';

const RO = 126; // road offset
const T_A1 = 0.002, T_EXT0 = 0.06, T_CAN = 0.16, T_E1 = 0.26, T_BR = 0.3, T_B0 = 0.36, T_LAMP = 0.45;
const T_C0 = 0.6, T_GAS = 0.82, T_THICK = 0.88;
const ROWS = [46, 57, 68, 79, 90]; // terrace rows (x of their centre line)
const ROW_T = [0.4, 0.51, 0.62, 0.73, 0.84];
const WX = -33.6, WY = 4.3, WZ = 6, WR = 5; // the waterwheel (axle centre, radius)

function hsh(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const lerp = (a, b, t) => a + (b - a) * t;
const sst = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

// valley side behind the mills (landmark-space height)
function hill(x, z) {
  const r = Math.hypot(x, z), s = sst(34, 104, x), f = 1 - sst(103, 117.5, r);
  return (17 * s + 1.6 * s * fbm3(x * 0.03, 2.1, z * 0.03, 2)) * f;
}

// --- colours (linear albedo) -------------------------------------------------------------
const GRIT = new Float64Array([0.26, 0.23, 0.175]);
const BRICK = [0.3, 0.125, 0.072], BRICK2 = [0.27, 0.115, 0.075], BRICK_D = [0.22, 0.09, 0.06];
const SLATE = [0.085, 0.095, 0.115], GLASS = [0.04, 0.05, 0.065], LIT = [1.0, 0.64, 0.3], BOARD = [0.2, 0.15, 0.1];
const DRESS = [0.44, 0.4, 0.33], WOOD = [0.15, 0.1, 0.065], IRON = [0.08, 0.085, 0.09], WATER = [0.045, 0.075, 0.085];
const LIT_E = 0.04;
let LEAF = [0.06, 0.09, 0.035], BARK = [0.12, 0.1, 0.08];

// --- quads with a vertical colour gradient ---------------------------------------------
let BR = 0.4, BG = 0.36, BB = 0.3;
function base(c, f = 1) { BR = c[0] * f; BG = c[1] * f; BB = c[2] * f; }
const Q = new Float64Array(12);
function setQ(i, x, y, z) { Q[i * 3] = x; Q[i * 3 + 1] = y; Q[i * 3 + 2] = z; }
function qd(b, nx, ny, nz, f0, f1) {
  b.color(BR * f0, BG * f0, BB * f0);
  const i0 = b.vertex(Q[0], Q[1], Q[2], nx, ny, nz), i1 = b.vertex(Q[3], Q[4], Q[5], nx, ny, nz);
  b.color(BR * f1, BG * f1, BB * f1);
  const i2 = b.vertex(Q[6], Q[7], Q[8], nx, ny, nz), i3 = b.vertex(Q[9], Q[10], Q[11], nx, ny, nz);
  b.quad(i0, i1, i2, i3);
}
function qa(b, n, rx, ry, rz, f0, f1) {
  let ax, ay, az, bx, by, bz;
  if (n === 4) { ax = Q[6] - Q[0]; ay = Q[7] - Q[1]; az = Q[8] - Q[2]; bx = Q[9] - Q[3]; by = Q[10] - Q[4]; bz = Q[11] - Q[5]; }
  else { ax = Q[3] - Q[0]; ay = Q[4] - Q[1]; az = Q[5] - Q[2]; bx = Q[6] - Q[0]; by = Q[7] - Q[1]; bz = Q[8] - Q[2]; }
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  if (n === 4) { qd(b, nx, ny, nz, f0, f1); return; }
  b.color(BR * f0, BG * f0, BB * f0);
  const i0 = b.vertex(Q[0], Q[1], Q[2], nx, ny, nz), i1 = b.vertex(Q[3], Q[4], Q[5], nx, ny, nz);
  b.color(BR * f1, BG * f1, BB * f1);
  b.tri(i0, i1, b.vertex(Q[6], Q[7], Q[8], nx, ny, nz));
}
function wall(b, x0, z0, x1, z1, y0, y1, nx, nz, f0 = 0.74, f1 = 1) {
  setQ(0, x0, y0, z0); setQ(1, x1, y0, z1); setQ(2, x1, y1, z1); setQ(3, x0, y1, z0);
  qd(b, nx, 0, nz, f0, f1);
}
// four walls of a block x in [-hw, hw], z in [-hl, hl] (no top), optional flat top
function shell(b, hw, hl, y0, y1, top, f0, f1) {
  wall(b, -hw, hl, hw, hl, y0, y1, 0, 1, f0, f1); wall(b, hw, -hl, -hw, -hl, y0, y1, 0, -1, f0, f1);
  wall(b, hw, hl, hw, -hl, y0, y1, 1, 0, f0, f1); wall(b, -hw, -hl, -hw, hl, y0, y1, -1, 0, f0, f1);
  if (top) { setQ(0, -hw, y1, -hl); setQ(1, hw, y1, -hl); setQ(2, hw, y1, hl); setQ(3, -hw, y1, hl); qd(b, 0, 1, 0, 0.92, 0.92); }
}
// flat rectangle in the face frame (normal +z) at depth z
function rect(b, x0, y0, x1, y1, z) {
  const i0 = b.vertex(x0, y0, z, 0, 0, 1), i1 = b.vertex(x1, y0, z, 0, 0, 1);
  const i2 = b.vertex(x1, y1, z, 0, 0, 1), i3 = b.vertex(x0, y1, z, 0, 0, 1);
  b.quad(i0, i1, i2, i3);
}
// run fn(L, f) in each of the four face frames of a block (face normal = local +z)
function faces(b, hw, hl, fn, mask = 15) {
  if (mask & 1) { b.push(); b.translate(hw, 0, 0); b.rotateY(Math.PI / 2); fn(2 * hl, 0); b.pop(); }
  if (mask & 2) { b.push(); b.translate(-hw, 0, 0); b.rotateY(-Math.PI / 2); fn(2 * hl, 1); b.pop(); }
  if (mask & 4) { b.push(); b.translate(0, 0, hl); fn(2 * hw, 2); b.pop(); }
  if (mask & 8) { b.push(); b.translate(0, 0, -hl); b.rotateY(Math.PI); fn(2 * hw, 3); b.pop(); }
}
// a grid of windows on a face: mode 0 dark panes (+ pale lintels) under the current tag;
// mode 1 lit panes, each storey lit at its own moment in [lt0, lt1], each pane dark again at
// its own decay moment (a quarter of those boarded up a little later)
function panes(b, L, nst, sh, y0, ww, wh, bay, mode, lt0, lt1, sd, lintel) {
  const n = Math.max(1, Math.floor((L - 2.2) / bay) + 1), x0 = -(n - 1) * bay / 2;
  for (let s = 0; s < nst; s++) {
    const yb = y0 + s * sh + (sh - wh) * 0.5, tl = lt0 + (lt1 - lt0) * hsh(s, sd, 1);
    for (let i = 0; i < n; i++) {
      const x = x0 + i * bay;
      if (mode === 0) {
        b.color(GLASS[0], GLASS[1], GLASS[2]); rect(b, x - ww / 2, yb, x + ww / 2, yb + wh, 0.07);
        if (lintel) { b.color(DRESS[0], DRESS[1], DRESS[2]); rect(b, x - ww / 2 - 0.12, yb + wh, x + ww / 2 + 0.12, yb + wh + 0.24, 0.06); }
        continue;
      }
      const h = hsh(i, s, sd + 3);
      if (h > 0.86) continue; // a few never lit
      const dk = 0.03 + 0.4 * hsh(i, s, sd + 7);
      b.timeless().appear(tl, tl + 0.012, MOTION.POP, 0, BY.BUILT).vanish(dk, dk + 0.01, MOTION.POP, 0, BY.DECAY);
      b.color(LIT[0], LIT[1] * (0.92 + 0.12 * h), LIT[2]).emissive(LIT_E, FLICKER.NONE).duskLit(); // lit as the light goes (kit)
      rect(b, x - ww / 2 + 0.06, yb + 0.06, x + ww / 2 - 0.06, yb + wh - 0.06, 0.15);
      b.emissive(0, 0).duskLit(false);
      if (h < 0.22 && dk < 0.3) {
        b.timeless().appear(dk + 0.02, dk + 0.03, MOTION.POP, 0, BY.DECAY);
        b.color(BOARD[0], BOARD[1], BOARD[2]); rect(b, x - ww / 2, yb, x + ww / 2, yb + wh, 0.21);
      }
    }
  }
}
function clip(b, y0, h, t0, t1) { b.timeless().pivot(0, y0, 0).appear(t0, t1, MOTION.CLIP, h, BY.BUILT); }

// pitched roof along z over [-hw, hw] x [-hl, hl] from eave e to ridge r (overhang ov)
function roofZ(b, hw, hl, e, r, ov) {
  base(SLATE); b.surface(SURF.PLAIN);
  const k = (r - e) / hw;
  for (let s = -1; s <= 1; s += 2) {
    setQ(0, s * (hw + ov), e - ov * k, -hl - ov); setQ(1, s * (hw + ov), e - ov * k, hl + ov); setQ(2, 0, r, hl + ov); setQ(3, 0, r, -hl - ov);
    qa(b, 4, s, 0.5, 0, 0.8, 1.15);
  }
}
function gables(b, hw, hl, e, r, c) {
  base(c, 0.95);
  for (let s = -1; s <= 1; s += 2) { setQ(0, -hw, e, s * hl); setQ(1, hw, e, s * hl); setQ(2, 0, r, s * hl); qa(b, 3, 0, 0, s, 1, 0.9); }
}

// a mill: o = {x, z, hw, hl, st, sh, c, t0, t1, l0, l1, sd, brick, ww, wh, bay, rg (roof gone at decay), cup}
function mill(b, o) {
  const H = o.st * o.sh, R = H + o.hw * 0.48;
  b.push(); b.translate(o.x, 0, o.z);
  b.surface(o.brick ? SURF.PLAIN : SURF.POLISH).ao(1); base(o.c);
  clip(b, -0.4, H + 0.4, o.t0, o.t1);
  shell(b, o.hw, o.hl, -0.4, H, false, 0.7, 1);
  base(o.c, 0.8); b.push(); b.translate(0, H - 0.15, 0); b.color(BR, BG, BB); b.box(0, 0, 0, o.hw + 0.25, 0.3, o.hl + 0.25); b.pop(); // eaves cornice
  b.surface(SURF.PLAIN);
  const pn = (mode) => faces(b, o.hw, o.hl, (L, f) => panes(b, L, o.st, o.sh, 0, o.ww, o.wh, f > 1 ? o.bay * 1.15 : o.bay, mode, o.l0, o.l1, o.sd + f * 31, o.brick));
  pn(0);
  b.ao(1); clip(b, H, R - H + 4.5, o.t1, o.t1 + 0.03);
  gables(b, o.hw, o.hl, H, R, o.c);
  if (o.cup) { // bell-cote on the ridge
    base(DRESS, 0.85); b.surface(SURF.POLISH); b.push(); b.translate(0, R - 0.5, o.cup); shell(b, 1.1, 1.1, 0, 2.6, false, 0.85, 1);
    base(SLATE); b.surface(SURF.PLAIN); for (let i = 0; i < 4; i++) { const a0 = i * Math.PI / 2 + 0.785, a1 = a0 + Math.PI / 2; setQ(0, 1.65 * Math.cos(a0), 2.6, 1.65 * Math.sin(a0)); setQ(1, 1.65 * Math.cos(a1), 2.6, 1.65 * Math.sin(a1)); setQ(2, 0, 4.4, 0); qa(b, 3, Math.cos(a0 + 0.785), 0.5, Math.sin(a0 + 0.785), 0.85, 1.1); }
    b.pop();
  }
  b.timeless().pivot(0, H, 0).appear(o.t1, o.t1 + 0.03, MOTION.CLIP, R - H + 0.6, BY.BUILT);
  if (o.rg) b.vanish(o.rg, o.rg + 0.06, MOTION.CLIP, 0, BY.DECAY);
  roofZ(b, o.hw, o.hl, H, R, 0.5);
  if (o.rg) { // bare rafters once the slates are stripped
    b.timeless().appear(o.rg + 0.03, o.rg + 0.04, MOTION.POP, 0, BY.DECAY);
    b.color(0.1, 0.075, 0.055).surface(SURF.WOOD);
    for (let z = -o.hl + 0.6; z <= o.hl; z += 1.8) for (let s = -1; s <= 1; s += 2) b.beam(s * o.hw, H + 0.1, z, 0, R - 0.1, z, 0.1, 0.1, 4, false);
    b.beam(0, R - 0.1, -o.hl, 0, R - 0.1, o.hl, 0.16, 0.16, 4, false);
  }
  b.surface(SURF.PLAIN);
  pn(1);
  b.pop();
}

// tall chimney: n-sided tapered shaft on a square plinth, corbelled cap, soot toward the top
function stack(b, x, z, n, r0, r1, H, c, t0, t1, cut) {
  b.push(); b.translate(x, 0, z);
  b.surface(SURF.PLAIN).ao(1);
  b.timeless().pivot(0, 0, 0).appear(t0, t1, MOTION.CLIP, H + 2, BY.BUILT);
  if (cut) b.vanish(cut, cut + 0.57, MOTION.CLIP, 0, BY.DECAY); // cut down to ~0.7 of its height by decay 0.35
  const a0 = n === 4 ? Math.PI / 4 : Math.PI / n, pr = r0 * 1.32;
  base(DRESS, 0.8); b.color(BR, BG, BB);
  b.block(pr, pr, pr * 0.94, pr * 0.94, 5.5, 0, 0, false);
  b.push(); b.translate(0, -1, 0); b.block(pr, pr, pr, pr, 1, 0, 0, false); b.pop();
  const ring = (ra, ya, rb, yb, f0, f1, ny) => {
    for (let i = 0; i < n; i++) {
      const p0 = a0 + i * 2 * Math.PI / n, p1 = p0 + 2 * Math.PI / n, pm = (p0 + p1) / 2;
      setQ(0, ra * Math.cos(p0), ya, ra * Math.sin(p0)); setQ(1, ra * Math.cos(p1), ya, ra * Math.sin(p1));
      setQ(2, rb * Math.cos(p1), yb, rb * Math.sin(p1)); setQ(3, rb * Math.cos(p0), yb, rb * Math.sin(p0));
      qa(b, 4, Math.cos(pm), ny, Math.sin(pm), f0, f1);
    }
  };
  base(c); ring(r0, 5.5, lerp(r0, r1, 0.6), 5.5 + (H - 5.5) * 0.6, 0.85, 1.0, 0);
  ring(lerp(r0, r1, 0.6), 5.5 + (H - 5.5) * 0.6, r1, H, 1.0, 0.45, 0);
  base(c, 0.42); ring(r1, H, r1 * 1.28, H + 0.7, 1, 1, -0.4); ring(r1 * 1.28, H + 0.7, r1 * 1.28, H + 1.6, 1, 0.8, 0);
  base([0.03, 0.028, 0.028]); ring(r1 * 1.28, H + 1.6, r1 * 0.8, H + 1.6, 1, 1, 1);
  b.pop();
}
// smoke from a chimney top: lit at t0 (thicker from T_THICK), cold at decay d0
function smokeAt(b, x, y, z, t0, d0, s) {
  b.timeless().appear(t0, t0 + 0.04, MOTION.POP, 0, BY.BUILT).vanish(d0, d0 + 0.04, MOTION.POP, 0, BY.DECAY);
  b.smoke(x, y, z, { count: 34, size: 3.4 * s, rise: 60, density: 0.4, color: [0.17, 0.165, 0.17], src: FLICKER.NONE });
  b.timeless().appear(Math.max(t0 + 0.05, T_THICK), Math.max(t0 + 0.09, T_THICK + 0.06), MOTION.POP, 0, BY.BUILT).vanish(d0 - 0.01, d0 + 0.02, MOTION.POP, 0, BY.DECAY);
  b.smoke(x, y + 2, z, { count: 26, size: 5.5 * s, rise: 60, density: 0.3, color: [0.24, 0.23, 0.23], src: FLICKER.NONE });
}

// a deciduous or conifer tree at (x, y, z) of height h (tags set by the caller)
function tree(b, x, y, z, h, k) {
  b.color(BARK[0], BARK[1], BARK[2]).surface(SURF.WOOD).ao(1);
  b.beam(x, y - 0.4, z, x, y + h * 0.55, z, 0.03 * h, 0.018 * h, 4, false);
  const v = 0.8 + 0.4 * hsh(k, 3, 9);
  b.surface(SURF.PLAIN).color(LEAF[0] * v, LEAF[1] * v, LEAF[2] * v);
  if (hsh(k, 5, 1) < 0.4) { // conifer
    b.color(LEAF[0] * v * 0.7, LEAF[1] * v * 0.85, LEAF[2] * v * 0.9);
    b.push(); b.translate(x, y + h * 0.18, z); b.cone(h * 0.24, h * 0.55, 7); b.translate(0, h * 0.38, 0); b.cone(h * 0.16, h * 0.45, 7); b.pop();
  } else {
    b.push(); b.translate(x, y + h * 0.62, z); b.rock(h * 0.3, h * 0.27, h * 0.3, 2, 0.22, k, 0, 0); b.pop();
    b.color(LEAF[0] * v * 1.15, LEAF[1] * v * 1.12, LEAF[2] * v);
    b.push(); b.translate(x + h * 0.12, y + h * 0.82, z - h * 0.06); b.rock(h * 0.2, h * 0.17, h * 0.2, 2, 0.2, k + 7, 0, 0); b.pop();
  }
}
// small stone cottage (frame: ridge along z), with an optional thin smoke
function cottage(b, x, z, yaw, k, c) {
  b.push(); b.at(x, 0, z, yaw);
  b.surface(SURF.STONE).ao(1); base(c); shell(b, 2.6, 4.2, -0.3, 4.6, false, 0.75, 1);
  gables(b, 2.6, 4.2, 4.6, 7, c); roofZ(b, 2.6, 4.2, 4.6, 7, 0.35);
  base(c, 0.8); b.push(); b.translate(0, 6, 3.6); shell(b, 0.45, 0.4, 0, 2.2, true, 1, 1); b.pop();
  b.surface(SURF.PLAIN);
  faces(b, 2.6, 4.2, (L, f) => {
    b.color(GLASS[0], GLASS[1], GLASS[2]); rect(b, -1.6, 1.0, -0.7, 2.2, 0.06); rect(b, 0.7, 1.0, 1.6, 2.2, 0.06); rect(b, -0.5, 3.0, 0.4, 4.0, 0.06);
    b.color(0.08, 0.05, 0.035); rect(b, -0.45, 0, 0.45, 2.0, 0.07);
  }, 3);
  b.pop();
}
// row of terraced brick houses on the valley side: frame ridge along z, fronts face -x
function terrace(b, xr, hl, k, t0) {
  const y0 = Math.min(hill(xr - 3.8, -hl), hill(xr - 3.8, hl), hill(xr - 3.8, 0)) - 0.1, D = 3.6, E = 6.2, R = 8.4;
  const c = k & 1 ? BRICK : BRICK2;
  b.push(); b.translate(xr, y0, 0);
  b.surface(SURF.PLAIN).ao(1); base(c);
  clip(b, -3.5, E + 3.5, t0, t0 + 0.06);
  shell(b, D, hl, -3.5, E, false, 0.6, 1);
  const nh = Math.round(2 * hl / 5.4), w = 2 * hl / nh;
  b.push(); b.translate(-D, 0, 0); b.rotateY(-Math.PI / 2);
  for (let i = 0; i < nh; i++) {
    const zc = -hl + (i + 0.5) * w;
    b.color(0.06, 0.04, 0.03); rect(b, zc - 1.9, 0, zc - 1.0, 2.1, 0.07);
    b.color(GLASS[0], GLASS[1], GLASS[2]); rect(b, zc - 0.3, 0.9, zc + 1.4, 2.3, 0.07); rect(b, zc - 1.9, 3.7, zc - 0.9, 5.2, 0.07); rect(b, zc + 0.3, 3.7, zc + 1.3, 5.2, 0.07);
  }
  b.pop();
  clip(b, E, R - E + 2, t0 + 0.05, t0 + 0.07);
  gables(b, D, hl, E, R, c); roofZ(b, D, hl, E, R, 0.3);
  base(c, 0.8);
  for (let i = 0; i < nh; i += 2) { b.push(); b.translate(0, R - 0.6, -hl + (i + 1) * w); shell(b, 0.45, 1.0, 0, 2, true, 1, 1); b.pop(); }
  // lit windows, house by house
  b.push(); b.translate(-D, 0, 0); b.rotateY(-Math.PI / 2);
  for (let i = 0; i < nh; i++) {
    const zc = -hl + (i + 0.5) * w, h = hsh(i, k, 51);
    if (h > 0.8) continue;
    const tl = t0 + 0.08 + 0.12 * hsh(i, k, 52), dk = 0.05 + 0.4 * hsh(i, k, 53);
    b.timeless().appear(tl, tl + 0.01, MOTION.POP, 0, BY.BUILT).vanish(dk, dk + 0.01, MOTION.POP, 0, BY.DECAY);
    b.color(LIT[0], LIT[1], LIT[2]).emissive(LIT_E, FLICKER.NONE).duskLit();
    rect(b, zc - 0.25, 0.95, zc + 1.35, 2.25, 0.14);
    if (h < 0.45) rect(b, zc + 0.35, 3.75, zc + 1.25, 5.15, 0.14);
    b.emissive(0, 0).duskLit(false);
  }
  b.pop();
  for (let j = 0; j < 3; j++) { // hearth smoke from a few stacks
    const i = 2 * Math.floor(hsh(j, k, 61) * nh / 2);
    b.timeless().appear(t0 + 0.08, t0 + 0.11, MOTION.POP, 0, BY.BUILT).vanish(0.06 + 0.04 * j, 0.1 + 0.04 * j, MOTION.POP, 0, BY.DECAY);
    b.smoke(0, R + 1.6, -hl + (i + 1) * w, { count: 12, size: 1.6, rise: 24, density: 0.16, color: [0.3, 0.29, 0.3], src: FLICKER.NONE });
  }
  b.pop();
}
function lamp(b, x, z, y = 0) {
  b.color(IRON[0], IRON[1], IRON[2]).surface(SURF.PLAIN).ao(1);
  b.beam(x, y, z, x, y + 3.6, z, 0.09, 0.06, 5);
  b.beam(x - 0.4, y + 3.3, z, x + 0.4, y + 3.3, z, 0.03, 0.03, 4, false);
  b.color(1.0, 0.72, 0.38).emissive(0.32, FLICKER.NONE).duskLit();
  b.push(); b.translate(x, y + 3.85, z); b.block(0.2, 0.2, 0.26, 0.26, 0.45, 0, 0, true); b.pop();
  b.emissive(0, 0).duskLit(false).color(IRON[0], IRON[1], IRON[2]);
  b.push(); b.translate(x, y + 4.3, z); b.cone(0.32, 0.25, 6); b.pop();
}
function heap(b, x, z, r, h, sd) {
  b.push(); b.translate(x, 0, z); b.timeless().pivot(0, 0, 0);
  return () => { b.color(0.035, 0.034, 0.036).surface(SURF.STONE).ao(0.9); b.rock(r, h, r * 0.8, 3, 0.25, sd, 2, 0.95); b.pop(); };
}
const WHEEL_S = new Float64Array(2); // animate scratch: last t, wheel angle

export default {
  id: 'mill-town',
  name: 'Mill town',
  caption: 'Spinning mills driven by water, then steam, draw workers into new factory towns.',
  year: 1769,
  radius: 118,
  pad: 115,
  roadOffset: RO,
  straddlesRoad: false,
  biome: 'forest',
  live: true,
  lights: [],
  viewSunAz: 2.1,
  witness: { at: [-6, -6], dist: 250, height: 34, look: 22, az: 0.5, fov: 0.6, drift: 0.07, range: 1250 },
  detail: { at: [WX, WY, WZ], from: [-62, 7, 26] },
  strip: { at: [-4, 22, -6], from: [-240, 28, 170], fov: 0.62 },

  // distant mills smoking in the neighbouring valleys: the factory age spreading
  satellites: {
    count: [5, 7], near: 2, nearR: [260, 380], farR: [480, 1100],
    centre: 0.15, spread: 4.2, minSep: 170, roadClear: 50,
    build(b, k, n, dist) {
      const s = 1 + dist / 650, t = 0.28 + 0.55 * k / n, H = 30 + 8 * b.rand();
      b.push(); b.scale(s, s, s);
      const c = k & 1 ? BRICK : BRICK2;
      b.surface(SURF.PLAIN).ao(1); base(c);
      clip(b, -0.5, 16, t, t + 0.06); shell(b, 6, 14, -0.5, 14, false, 0.7, 1);
      b.timeless().pivot(0, -0.5, 0).appear(t + 0.03, t + 0.06, MOTION.CLIP, 18, BY.BUILT);
      gables(b, 6, 14, 14, 17, c); roofZ(b, 6, 14, 14, 17, 0.4);
      b.timeless().appear(t + 0.06, t + 0.08, MOTION.POP, 0, BY.BUILT).vanish(0.04 + 0.2 * k / n, 0.06 + 0.2 * k / n, MOTION.POP, 0, BY.DECAY);
      b.color(LIT[0], LIT[1], LIT[2]).emissive(0.07, FLICKER.NONE).duskLit();
      for (let f = 0; f < 4; f++) for (let st = 0; st < 3; st++) {
        const y = 2.8 + st * 4.2, L = f & 1 ? 13 : 5.2;
        b.push(); b.rotateY(f * Math.PI / 2); b.translate(0, 0, f & 1 ? 6 : 14); rect(b, -L, y, L, y + 1.1, 0.12); b.pop();
      }
      b.emissive(0, 0).duskLit(false);
      stack(b, 9, -10, 8, 1.6, 1.0, H, BRICK_D, t + 0.02, t + 0.07, 0);
      smokeAt(b, 9, H + 2, -10, t + 0.07, 0.02 + 0.1 * k / n, 1.1);
      b.pop();
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 17 + 3;
    const rock = b.bio('rock'), ground = b.bio('ground'), leaf = b.bio('leaf'), bark = b.bio('bark');
    LEAF = [leaf[0], leaf[1], leaf[2]]; BARK = [bark[0], bark[1], bark[2]];
    GRIT[0] = lerp(0.26, rock[0], 0.2); GRIT[1] = lerp(0.23, rock[1], 0.2); GRIT[2] = lerp(0.175, rock[2], 0.2);
    WHEEL_S[0] = 0; WHEEL_S[1] = 0;

    // --- the valley side (custom grid fitted inside the radius)
    b.timeless().surface(SURF.EARTH).ao(1);
    {
      const NU = 26, NV = 30, v0 = b.nv;
      for (let i = 0; i <= NU; i++) {
        const x = 33 + (117 - 33) * i / NU, zm = Math.sqrt(Math.max(0, 117.5 * 117.5 - x * x));
        for (let j = 0; j <= NV; j++) {
          const z = -zm + 2 * zm * j / NV, y = hill(x, z), e = 0.6;
          const gx = (hill(x + e, z) - hill(x - e, z)) / (2 * e), gz = (hill(x, z + e) - hill(x, z - e)) / (2 * e);
          const n = 0.85 + 0.25 * noise3(x * 0.06, 1.3, z * 0.06), d = Math.min(1, y / 14);
          b.color(ground[0] * n * (0.9 + 0.1 * d), ground[1] * n * (0.95 + 0.1 * d), ground[2] * n * 0.9);
          b.vertex(x, y + 0.02, z, -gx, 1, -gz);
        }
      }
      if (b.nv - v0 === (NU + 1) * (NV + 1)) for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const a = v0 + i * (NV + 1) + j; b.quad(a, a + NV + 1, a + NV + 2, a + 1); }
    }
    // --- the mill yards: meadow trampled to cinder as the works spread (MORPH colour by built)
    b.surface(SURF.EARTH);
    b.heightfield(-36, -90, 34, 62, 18, 30, (x, z) => {
      const e = Math.min(x + 36, 34 - x, z + 90, 62 - z), f = Math.min(1, e / 16), n = fbm3(x * 0.06, 0.7, z * 0.06, 2);
      const k = f * (0.6 + 0.4 * n), g = 0.9 + 0.15 * n;
      b.timeless().morph(0.03, 0.03, lerp(ground[0], 0.07, k) * g, lerp(ground[1], 0.062, k) * g, lerp(ground[2], 0.058, k) * g);
      b.vanish(0.25 + 0.3 * (1 - f), 0.85, MOTION.MORPH, 0, BY.BUILT);
      b.color(lerp(ground[0], 0.17, k * 0.5) * g, lerp(ground[1], 0.14, k * 0.5) * g, lerp(ground[2], 0.1, k * 0.5) * g);
      return 0.03;
    });
    // lanes: bridge to wharf, bridge to the works, the towpath
    b.timeless().surface(SURF.EARTH).color(0.2, 0.17, 0.13);
    b.heightfield(-75, -58, -71, -30, 1, 6, () => 0.05);
    b.heightfield(-24, -35, -2, -29, 5, 1, () => 0.05);
    b.heightfield(-78.4, -56, -75.6, 58, 1, 20, () => 0.05);
    yield;

    // --- river, weir, mill pond and the wheel pit
    b.timeless().surface(SURF.PLAIN).ao(1);
    b.color(WATER[0], WATER[1], WATER[2]).emissive(0.012, FLICKER.NONE);
    const riv = (x0, x1, z0, z1, y) => { setQ(0, x0, y, z0); setQ(1, x1, y, z0); setQ(2, x1, y, z1); setQ(3, x0, y, z1); base(WATER); qa(b, 4, 0, 1, 0, 1, 1); };
    riv(-52, -36, -104, 22, 0.1); riv(-36, -30.5, 0.5, 11.5, 0.1);
    riv(-60, -31, 22, 76, 0.55); riv(-50, -38, 76, 104, 0.55);
    b.emissive(0, 0);
    // stone banks
    b.surface(SURF.STONE);
    const bank = (x0, z0, x1, z1, y) => {
      const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 6));
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, g = 0.82 + 0.2 * hsh(i, x0 | 0, z0 | 0);
        base(GRIT, 0.8 * g);
        const ax = lerp(x0, x1, t0), az = lerp(z0, z1, t0), bx = lerp(x0, x1, t1), bz = lerp(z0, z1, t1);
        b.color(BR, BG, BB); b.beam(ax, y, az, bx, y, bz, 0.42, 0.42, 4);
      }
    };
    bank(-52.4, -104, -52.4, 22, 0.35); bank(-35.6, -104, -35.6, 0, 0.35); bank(-35.6, 12, -35.6, 22, 0.35);
    bank(-36, 0, -30.2, 0, 0.35); bank(-36, 12, -30.2, 12, 0.35);
    bank(-60.4, 22, -60.4, 76, 0.8); bank(-30.6, 22, -30.6, 76, 0.8); bank(-60.4, 76, -50.4, 76, 0.8); bank(-37.6, 76, -30.6, 76, 0.8);
    bank(-50.4, 76, -50.4, 104, 0.8); bank(-37.6, 76, -37.6, 104, 0.8);
    // the weir: a stepped sill and the white water below it
    base(GRIT, 0.75); b.color(BR, BG, BB); b.box(-44, 0.3, 22.6, 8.5, 0.5, 1.4);
    b.color(0.6, 0.63, 0.64).emissive(0.02, FLICKER.NONE);
    setQ(0, -52, 0.8, 22); setQ(1, -36, 0.8, 22); setQ(2, -36, 0.14, 19.2); setQ(3, -52, 0.14, 19.2); base([0.6, 0.63, 0.64]); qa(b, 4, 0, 1, -0.5, 1, 0.8);
    for (let i = 0; i < 9; i++) { const x = -51 + i * 1.9 + hsh(i, 2, 2), l = 2 + 3 * hsh(i, 3, 3); setQ(0, x, 0.13, 19.2); setQ(1, x + 1.3, 0.13, 19.2); setQ(2, x + 1, 0.13, 19.2 - l); setQ(3, x + 0.3, 0.13, 19.2 - l); base([0.45, 0.5, 0.52]); qa(b, 4, 0, 1, 0, 1, 0.5); }
    b.emissive(0, 0);
    yield;

    // --- early woods, cottages and the first mill
    for (let k = 0; k < 4; k++) cottage(b, -68, 34 + k * 9.5, 0, k, GRIT);
    cottage(b, -9, 52, Math.PI / 2, 5, GRIT); cottage(b, 0.5, 52, Math.PI / 2, 6, GRIT);
    for (let k = 0; k < 3; k++) {
      b.timeless().vanish(0.12 + 0.06 * k, 0.18 + 0.06 * k, MOTION.POP, 0, BY.DECAY);
      b.smoke(-68, 9, 37.6 + k * 9.5, { count: 10, size: 1.2, rise: 18, density: 0.14, color: [0.36, 0.35, 0.36], src: FLICKER.NONE });
    }
    const A = { x: -24, z: 7, hw: 6, hl: 19, st: 5, sh: 3.2, c: GRIT, t0: 0, t1: T_A1, l0: 0.04, l1: 0.42, sd: sd + 1, brick: false, ww: 0.9, wh: 1.4, bay: 2.3, cup: 4 };
    mill(b, A);
    mill(b, { x: -24, z: 35.5, hw: 6, hl: 9.5, st: 5, sh: 3.2, c: GRIT, t0: T_EXT0, t1: T_EXT0 + 0.07, l0: 0.16, l1: 0.5, sd: sd + 2, brick: false, ww: 0.9, wh: 1.4, bay: 2.3 });
    // the wheel pit's axle housing on the mill wall
    b.timeless().surface(SURF.STONE); base(GRIT, 0.7); b.color(BR, BG, BB); b.box(-30.7, WY, WZ, 0.7, 0.9, 0.9);
    yield;

    // --- the canal: walls, water (greening with decay), lock, basin, wharf and warehouse
    b.timeless().pivot(0, 0, 0).appear(T_CAN, T_CAN + 0.04, MOTION.RISE, 0.8, BY.BUILT);
    bank(-87.4, -56, -87.4, 74, 0.3); bank(-78.6, -56, -78.6, 58, 0.3); bank(-78.6, 58, -81, 58, 0.3);
    bank(-85, 58, -85, 74, 0.3); bank(-81, 58, -81, 74, 0.3); bank(-87.4, 74, -81, 74, 0.3);
    bank(-90.4, -70, -71.6, -70, 0.3); bank(-90.4, -70, -90.4, -56, 0.3); bank(-90.4, -56, -87.4, -56, 0.3); bank(-71.6, -70, -71.6, -56, 0.3); bank(-78.6, -56, -71.6, -56, 0.3);
    b.surface(SURF.PLAIN).color(WATER[0], WATER[1], WATER[2]).emissive(0.012, FLICKER.NONE);
    const cw = (x0, x1, z0, z1) => {
      b.timeless().appear(T_CAN + 0.04, T_CAN + 0.05, MOTION.POP, 0, BY.BUILT).morph(0.12, 0.12, 0.07, 0.095, 0.035).vanish(0.06, 0.35, MOTION.MORPH, 0, BY.DECAY);
      setQ(0, x0, 0.12, z0); setQ(1, x1, 0.12, z0); setQ(2, x1, 0.12, z1); setQ(3, x0, 0.12, z1); base(WATER); qa(b, 4, 0, 1, 0, 1, 1);
    };
    cw(-87, -79, -56, 58); cw(-85, -81, 58, 74); cw(-90, -72, -70, -56);
    b.emissive(0, 0);
    // lock gates and balance beams
    b.timeless().appear(T_CAN + 0.04, T_CAN + 0.05, MOTION.POP, 0, BY.BUILT).color(WOOD[0], WOOD[1], WOOD[2]).surface(SURF.WOOD);
    for (const z of [58.6, 73.4]) { b.box(-83, 0.6, z, 2, 0.75, 0.18); b.beam(-81, 1.3, z, -77.5, 1.2, z + (z > 60 ? 2.4 : -2.4), 0.13, 0.11, 4); }
    // warehouse on the wharf
    mill(b, { x: -66, z: -63, hw: 5, hl: 6.5, st: 3, sh: 3.3, c: BRICK2, t0: T_CAN + 0.02, t1: T_CAN + 0.09, l0: 0.32, l1: 0.6, sd: sd + 3, brick: true, ww: 1.1, wh: 1.6, bay: 3.0 });
    // the narrowboat: moored, laden with coal; it settles in the decay
    b.push(); b.translate(-83.5, 0.12, 16);
    b.timeless().appear(T_CAN + 0.07, T_CAN + 0.08, MOTION.POP, 0, BY.BUILT).vanish(0.15, 0.5, MOTION.RISE, 1.3, BY.DECAY);
    b.surface(SURF.WOOD).color(0.06, 0.05, 0.045); b.box(0, 0.25, 0, 1.05, 0.55, 9);
    { const P = new Float64Array([-1.05, -0.3, 9, 1.05, -0.3, 9, 0, -0.3, 11.2, 0, -0.3, 11.2, -1.05, 0.8, 9, 1.05, 0.8, 9, 0.04, 0.95, 11.4, -0.04, 0.95, 11.4]); b.hexa(P, false); }
    b.color(0.36, 0.08, 0.05); b.box(0, 1.15, -6.6, 0.95, 0.42, 2.3); b.color(0.06, 0.18, 0.12); b.box(0, 1.6, -6.6, 1.0, 0.06, 2.4);
    b.color(0.03, 0.03, 0.033).surface(SURF.STONE); b.push(); b.translate(0, 0.75, 1.5); b.rock(0.9, 0.45, 6.5, 3, 0.2, sd + 4, 0, 0.9); b.pop();
    b.pop();
    yield;

    // --- steam: engine house, the square chimney, the stone bridge
    mill(b, { x: -22, z: -17, hw: 4, hl: 4.6, st: 3, sh: 4.2, c: GRIT, t0: T_E1, t1: T_E1 + 0.05, l0: 0.33, l1: 0.38, sd: sd + 5, brick: false, ww: 1.2, wh: 3.0, bay: 3.2 });
    stack(b, -13, -24, 4, 2.5, 1.5, 38, BRICK_D, T_E1 + 0.02, T_E1 + 0.08, 0);
    smokeAt(b, -13, 40, -24, T_E1 + 0.08, 0.01, 1);
    // bridge over the river (west to the wharf lane, east to the works), two round arches
    {
      clip(b, -0.3, 7, T_BR, T_BR + 0.06);
      b.surface(SURF.POLISH).ao(1);
      const N = 64, x0 = -66, x1 = -24, dk = (x) => 0.3 + 4.7 * sst(0, 1, 1 - Math.abs(x + 44) / 22);
      const ia = (x) => { for (const cx of [-48.2, -39.8]) { const d = Math.abs(x - cx); if (d < 3.6) return 0.7 + Math.sqrt(3.6 * 3.6 - d * d); } return -0.3; };
      base(GRIT);
      for (let i = 0; i < N; i++) {
        const xa = lerp(x0, x1, i / N), xb = lerp(x0, x1, (i + 1) / N), ta = dk(xa), tb = dk(xb), ba = ia(xa), bb = ia(xb);
        for (let s = -1; s <= 1; s += 2) {
          const z = -32 + s * 3;
          setQ(0, xa, ba, z); setQ(1, xb, bb, z); setQ(2, xb, tb, z); setQ(3, xa, ta, z); qd(b, 0, 0, s, ba > 0 ? 0.62 : 0.72, 1);
          setQ(0, xa, ta, z); setQ(1, xb, tb, z); setQ(2, xb, tb + 1.0, z); setQ(3, xa, ta + 1.0, z); qd(b, 0, 0, s, 1, 1.05);
          setQ(0, xa, ta, z - s * 0.4); setQ(1, xb, tb, z - s * 0.4); setQ(2, xb, tb + 1.0, z - s * 0.4); setQ(3, xa, ta + 1.0, z - s * 0.4); qd(b, 0, 0, -s, 0.8, 0.9);
          setQ(0, xa, ta + 1, z); setQ(1, xb, tb + 1, z); setQ(2, xb, tb + 1, z - s * 0.4); setQ(3, xa, ta + 1, z - s * 0.4); qa(b, 4, 0, 1, 0, 1.05, 1.05);
        }
        setQ(0, xa, ta, -28.6); setQ(1, xb, tb, -28.6); setQ(2, xb, tb, -35.4); setQ(3, xa, ta, -35.4); base(GRIT, 0.6); qa(b, 4, 0, 1, 0, 1, 1);
        if (ba > 0 || bb > 0) { setQ(0, xa, Math.max(0, ba), -35); setQ(1, xb, Math.max(0, bb), -35); setQ(2, xb, Math.max(0, bb), -29); setQ(3, xa, Math.max(0, ba), -29); base(GRIT, 0.35); qa(b, 4, 0, -1, 0, 1, 1); }
        base(GRIT);
      }
    }
    yield;

    // --- the brick mill downstream, its chimney (cut down in the decay), roof stripped
    mill(b, { x: -23, z: -58, hw: 7, hl: 16, st: 6, sh: 3.3, c: BRICK, t0: T_B0, t1: T_B0 + 0.1, l0: 0.48, l1: 0.7, sd: sd + 6, brick: true, ww: 1.1, wh: 1.8, bay: 2.6, rg: 0.14 });
    stack(b, -6, -62, 8, 2.2, 1.3, 50, BRICK_D, T_B0 + 0.1, T_B0 + 0.17, 0.18);
    smokeAt(b, -6, 52, -62, T_B0 + 0.17, 0.04, 1.1);
    // gas lamps along the lanes, the bridge and the towpath
    b.timeless().appear(T_LAMP, T_LAMP + 0.01, MOTION.POP, 0, BY.BUILT);
    const LAMPS = [-64.5, -28.2, 0.4, -23.6, -28.2, 0.4, -12, -36.5, 0, -1, -36.5, 0, -73, -52, 0, -76.6, -36, 0, -76.6, -6, 0, -76.6, 24, 0, -76.6, 50, 0, 40, -30, 0, 40, 10, 0];
    for (let i = 0; i < LAMPS.length; i += 3) {
      b.timeless().appear(T_LAMP + 0.01 * (i / 3 % 4), T_LAMP + 0.01 + 0.01 * (i / 3 % 4), MOTION.POP, 0, BY.BUILT);
      if (i % 2 === 0) b.vanish(0.1 + 0.2 * hsh(i, 4, 4), 0.11 + 0.2 * hsh(i, 4, 4), MOTION.POP, 0, BY.DECAY);
      const x = LAMPS[i], z = LAMPS[i + 1];
      lamp(b, x, z, LAMPS[i + 2]);
    }
    yield;

    // --- the great mill, its engine house, stair tower and the tallest chimney
    mill(b, { x: 12, z: 4, hw: 10, hl: 32, st: 7, sh: 3.4, c: BRICK2, t0: T_C0, t1: T_C0 + 0.13, l0: T_C0 + 0.16, l1: 0.96, sd: sd + 7, brick: true, ww: 1.3, wh: 2.0, bay: 2.8 });
    {
      const H = 7 * 3.4, TT = 7.4;
      b.push(); b.translate(12, 0, 39.5);
      b.surface(SURF.PLAIN).ao(1); base(BRICK2); clip(b, -0.4, H + TT + 6, T_C0 + 0.03, T_C0 + 0.17);
      shell(b, 3.5, 3.5, -0.4, H + TT, false, 0.7, 1);
      base(DRESS, 0.85); b.color(BR, BG, BB); b.box(0, H + TT, 0, 3.8, 0.35, 3.8);
      base(SLATE); for (let i = 0; i < 4; i++) { const a0 = i * Math.PI / 2 + 0.785, a1 = a0 + Math.PI / 2, r = 5.3; setQ(0, r * Math.cos(a0), H + TT + 0.3, r * Math.sin(a0)); setQ(1, r * Math.cos(a1), H + TT + 0.3, r * Math.sin(a1)); setQ(2, 0, H + TT + 5.6, 0); qa(b, 3, Math.cos(a0 + 0.785), 0.5, Math.sin(a0 + 0.785), 0.8, 1.15); }
      faces(b, 3.5, 3.5, (L) => panes(b, L, 9, 3.4, 0, 1.0, 2.0, 3, 0, 0, 0, sd + 8, true), 7);
      b.pop();
    }
    mill(b, { x: 12, z: -33, hw: 6.5, hl: 5, st: 3, sh: 4.6, c: BRICK2, t0: T_C0 + 0.02, t1: T_C0 + 0.08, l0: T_C0 + 0.1, l1: T_C0 + 0.14, sd: sd + 9, brick: true, ww: 1.3, wh: 3.2, bay: 3.2 });
    stack(b, 26, -42, 8, 2.9, 1.65, 64, BRICK_D, T_C0 + 0.06, T_C0 + 0.16, 0);
    smokeAt(b, 26, 66, -42, T_C0 + 0.17, 0.07, 1.25);
    // coal heaps by the engines and on the wharf
    const HEAPS = [-10, -16, 4, 2.2, T_E1 + 0.06, -66, -51, 5, 2.2, T_CAN + 0.08, -58, -50, 3.5, 1.6, 0.42, -2, -48, 4.5, 2.4, T_B0 + 0.14, 1, -40, 5.5, 2.8, T_C0 + 0.12];
    for (let i = 0; i < HEAPS.length; i += 5) {
      const f = heap(b, HEAPS[i], HEAPS[i + 1], HEAPS[i + 2], HEAPS[i + 3], sd + i);
      b.appear(HEAPS[i + 4], HEAPS[i + 4] + 0.1, MOTION.SCALE, 0, BY.BUILT).vanish(0.12 + 0.01 * i, 0.3 + 0.01 * i, MOTION.SCALE, 0, BY.DECAY);
      f();
    }
    // the gasholder: a dark iron bell inside its guide frame
    {
      b.push(); b.translate(8, 0, 70);
      b.surface(SURF.PLAIN).ao(1); clip(b, -0.3, 18, T_GAS, T_GAS + 0.06);
      b.color(0.11, 0.14, 0.13); b.lathe([10, -0.3, 10, 10.5, 9.4, 11.4, 0.01, 12.1], 20);
      b.color(0.05, 0.055, 0.06);
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; b.beam(10.8 * Math.cos(a), -0.3, 10.8 * Math.sin(a), 10.8 * Math.cos(a), 16, 10.8 * Math.sin(a), 0.32, 0.26, 4); }
      for (const y of [8, 16]) for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6, c = a + Math.PI / 6; b.beam(10.8 * Math.cos(a), y, 10.8 * Math.sin(a), 10.8 * Math.cos(c), y, 10.8 * Math.sin(c), 0.2, 0.2, 4, false); }
      b.pop();
    }
    yield;

    // --- terraces climbing the valley side, row after row
    for (let k = 0; k < ROWS.length; k++) terrace(b, ROWS[k], k === 0 ? 34 : 46, k, ROW_T[k]);
    yield;

    // --- trees: the hillside wood (felled for each terrace row), the crest and the river
    //     ends (stay), trees on the mill sites (felled), and scrub coming back in the decay
    for (let i = 0; i < 9; i++) for (let j = 0; j < 13; j++) {
      const x = 38 + i * 9.5 + 4 * hsh(i, j, sd), z = -60 + j * 10 + 5 * hsh(j, i, sd + 1);
      if (Math.hypot(x, z) > 112 || hsh(i, j, sd + 2) < 0.25) continue;
      let r = -1;
      for (let k = 0; k < ROWS.length; k++) if (Math.abs(x - ROWS[k]) < 6.5 && Math.abs(z) < (k === 0 ? 36 : 48)) r = k;
      if (r < 0 && x < 96 && Math.abs(z) < 50) for (let k = 0; k < ROWS.length; k++) if (Math.abs(x - ROWS[k]) < 9) r = k; // the back yards too
      const y = hill(x, z), h = 9 + 6 * hsh(i, j, sd + 3);
      b.timeless().pivot(x, y, z);
      if (r >= 0) b.vanish(ROW_T[r] - 0.05, ROW_T[r] - 0.01, MOTION.SCALE, 0, BY.BUILT);
      tree(b, x, y, z, h, i * 13 + j);
    }
    const OLD = [-58, -98, -66, 92, -56, 88, -72, -84, -96, -40, -100, 10, -98, 40, -60, -90, -40, 98, 30, 80, 24, 92, -14, 96, -16, -96, 4, -100, 22, -90, -94, -14, -70, 70, -76, -95];
    for (let i = 0; i < OLD.length; i += 2) { b.timeless().pivot(OLD[i], 0, OLD[i + 1]); if (Math.hypot(OLD[i], OLD[i + 1]) < 114) tree(b, OLD[i], 0, OLD[i + 1], 10 + 5 * hsh(i, 1, sd), 200 + i); }
    const SITE = [8, -10, 0.6, 16, 20, 0.6, 4, 30, 0.6, -20, -66, T_B0, -26, -50, T_B0, 12, 66, T_GAS, 2, 74, T_GAS, -6, -60, T_B0 + 0.08];
    for (let i = 0; i < SITE.length; i += 3) {
      b.timeless().pivot(SITE[i], 0, SITE[i + 1]).vanish(SITE[i + 2] - 0.04, SITE[i + 2] - 0.005, MOTION.SCALE, 0, BY.BUILT);
      tree(b, SITE[i], 0, SITE[i + 1], 11 + 4 * hsh(i, 2, sd), 300 + i);
    }
    const RET = [-12, -6, -4, 4, -13, 14, -5, 24, -11, 32, -55.6, -88, -55.6, -70, -55.6, -46, -55.6, 2, -33, -86, -91, -38, -91, -10,
      -91, 22, -91, 48, -75, 64, -60, -76, -4, 84, 20, 50, 28, 26, 30, -10, -14, -46, -62, -40];
    for (let i = 0; i < RET.length; i += 2) {
      const x = RET[i] + 2 * hsh(i, 9, sd) - 1, z = RET[i + 1] + 3 * hsh(i, 10, sd) - 1.5, t = 0.06 + 0.26 * hsh(i, 11, sd);
      b.timeless().pivot(x, 0, z).appear(t, t + 0.05, MOTION.SCALE, 0, BY.DECAY);
      tree(b, x, 0, z, 5 + 4 * hsh(i, 12, sd), 400 + i);
    }
    // trees in the stripped mill's yard and on its wall heads
    for (let i = 0; i < 5; i++) {
      const x = -32.5 + (i & 1) * 19, z = -72 + i * 7.5, t = 0.16 + 0.03 * i;
      b.timeless().pivot(x, 0, z).appear(t, t + 0.06, MOTION.SCALE, 0, BY.DECAY);
      tree(b, x, 0, z, 6 + 2 * hsh(i, 5, sd), 500 + i);
    }
    yield;

    // --- a few still figures: wharf, bridge, mill yard, terrace street
    b.surface(SURF.HIDE).ao(1);
    const FIG = [-73, -60, 0, 0.6, 0.0, -45, -32, 5.0, 1.6, T_BR + 0.06, -15, 2, 0, -1.4, 0.05, -10, -33, 0, 2.6, T_E1 + 0.06, 39, -6, hill(39, -6), -1.2, ROW_T[0] + 0.1];
    for (let i = 0; i < FIG.length; i += 5) {
      b.timeless().appear(FIG[i + 4], FIG[i + 4] + 0.01, MOTION.POP, 0, BY.BUILT);
      if (i) b.vanish(0.04 + 0.04 * i / 5, 0.05 + 0.04 * i / 5, MOTION.POP, 0, BY.DECAY);
      const c = 0.5 + 0.5 * hsh(i, sd, 2);
      b.color(0.12 * c + 0.03, 0.1 * c + 0.02, 0.09 * c + 0.03);
      b.push(); b.at(FIG[i], FIG[i + 2], FIG[i + 1], FIG[i + 3]); b.human(i === 15 ? POSE.HAUL : POSE.STAND, 1.7, sd + i); b.pop();
    }
    b.timeless();

    // --- the waterwheel (rig 1): axle along x, built around its own centre
    b.rig(1);
    b.timeless().pivot(0, 0, 0).appear(0, 0.002, MOTION.SCALE, 0, BY.BUILT);
    b.surface(SURF.WOOD).ao(1);
    const NS = 16;
    for (const sx of [-1.25, 1.25]) {
      b.color(IRON[0], IRON[1], IRON[2]);
      for (let i = 0; i < NS; i++) {
        const a0 = i * 2 * Math.PI / NS, a1 = a0 + 2 * Math.PI / NS;
        b.beam(sx, WR * Math.cos(a0), WR * Math.sin(a0), sx, WR * Math.cos(a1), WR * Math.sin(a1), 0.13, 0.13, 4, false);
      }
      b.color(WOOD[0], WOOD[1], WOOD[2]);
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + 0.2; b.beam(sx, 0, 0, sx, WR * Math.cos(a), WR * Math.sin(a), 0.12, 0.09, 4, false); }
    }
    b.color(WOOD[0] * 1.2, WOOD[1] * 1.2, WOOD[2] * 1.2);
    for (let i = 0; i < 24; i++) { // paddles
      const a = i * 2 * Math.PI / 24;
      b.push(); b.rotateX(-a); b.box(0, WR - 0.45, 0, 1.25, 0.5, 0.06, false); b.pop();
    }
    b.color(IRON[0], IRON[1], IRON[2]); b.beam(-1.8, 0, 0, 3.0, 0, 0, 0.3, 0.3, 8);
    b.rig(0);
    b.timeless();
    return b.counts();
  },

  // the wheel turns while the mill runs on water, and stops as the works fall idle
  animate(a) {
    let dt = a.t - WHEEL_S[0];
    WHEEL_S[0] = a.t;
    if (!(dt > 0 && dt < 0.5)) dt = 0;
    WHEEL_S[1] = (WHEEL_S[1] + dt * 0.5 * (1 - seg(a.decay, 0.02, 0.09))) % 6.283185307179586;
    a.set(1, WX, WY, WZ, 0, WHEEL_S[1]);
  },
};
