// Mongol encampment, 1206: the great camp of the steppe tribes at the proclamation of Genghis
// Khan. A wide low city of round white felt gers laid out in rings (kuriens) around the khan's
// great ger; an open avenue runs from the road side to it, where the nine white horse-tail
// standards stand in an arc over a still gathering. Tethered horse lines, ox carts, cooking
// fires under tripods, drying racks; mounted sentries on the edges. Satellites: more ger
// clusters, herds and smoke columns out to the horizon.
//
// In the game the event exists only during clock 144-166 with no built / decay ramp, so the
// module always receives built 1, decay 0 (sites.js shows it from 144 and hides it once the
// car is 700 m away after 166). The whole timeline is still authored, so a ramp in the
// registry would play it:
//   built 0 -> 1 (arrival): carts and herds come first (0-0.12), then the gers go up from the
//     khan's outward (felt walls rise, the roof is lowered on, 0.05-0.75), smoke starts in
//     each, fires are lit (0.62), people gather (0.6-0.9), the nine standards are raised (0.84).
//   decay 0 -> 1 (departure): the standards are lowered (0.06), people go (0.03-0.3), fires
//     die (0.05-0.3), the gers are struck from the edge inward (roof first, then the walls,
//     0.15-0.8), the herds and carts leave last (0.8-0.95). Trampled rings, the worn avenue
//     and ash beds stay on the grass.

import { SURF, POSE, FLICKER, MOTION, BY, noise3 } from './kit.js';

const KX = 12; // the khan's ger (landmark-local x; z = 0), door toward the road (-x)
const KR = 10.5; // its radius
const MAXG = 160;
const GP = new Float64Array(MAXG * 4); // placed gers: x, z, R, ring distance (layout scratch)
let NG = 0;
const SR = 31; // standards arc radius about the khan's ger

// Zones kept clear of gers: capsules x0, z0, x1, z1, r.
const ZONES = [
  -120, 0, -16, 0, 13, // the avenue from the road side to the gathering
  -14, 0, 4, 0, 24, // the gathering and the standards
  -74, 28, -74, 62, 9, // horse line A (road side, toward the approach)
  -44, -44, -18, -62, 9, // horse line B
  70, -22, 70, 14, 9, // horse line C (behind the khan's ger)
  80, -58, 96, -46, 22, // loose herd
  50, 76, 72, 70, 15, // sheep
  -40, 86, 12, 96, 10, // cart park
];
const HL = [-74, 30, -74, 60, 9, -44, -46, -18, -62, 8, 70, -20, 70, 12, 8];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function capD(x, z, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0, l = dx * dx + dz * dz;
  const t = l > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l)) : 0;
  return Math.hypot(x - x0 - dx * t, z - z0 - dz * t);
}
function inZone(x, z, pad) {
  for (let i = 0; i < ZONES.length; i += 5) if (capD(x, z, ZONES[i], ZONES[i + 1], ZONES[i + 2], ZONES[i + 3]) < ZONES[i + 4] + pad) return true;
  return false;
}
function gerFree(x, z, R, gap) {
  for (let j = 0; j < NG; j++) { const o = j * 4; if (Math.hypot(x - GP[o], z - GP[o + 1]) < R + GP[o + 2] + gap) return false; }
  return true;
}

// Kurien rings about the khan's ger, the open avenue toward the road left free.
function layout(b) {
  NG = 0;
  const RINGS = [36, 52, 69, 87, 106];
  for (let ri = 0; ri < RINGS.length; ri++) {
    const rr = RINGS[ri], step = 15.5 + 2 * b.rand(), n = Math.floor((Math.PI * 2 * rr) / step);
    const a0 = b.rand() * 6.283;
    for (let i = 0; i < n && NG < MAXG; i++) {
      if (b.rand() < 0.14) continue;
      const a = a0 + (i + (b.rand() - 0.5) * 0.35) * (Math.PI * 2 / n), r = rr + (b.rand() - 0.5) * 5;
      const x = KX + Math.cos(a) * r, z = Math.sin(a) * r, R = 3.1 + 0.9 * b.rand();
      if (Math.hypot(x, z) + R > 117 || x - R < -108) continue;
      if (inZone(x, z, R + 1.5) || !gerFree(x, z, R, 3.2)) continue;
      const o = NG * 4; GP[o] = x; GP[o + 1] = z; GP[o + 2] = R; GP[o + 3] = r; NG++;
    }
  }
}

// --- floor: the grazed, trampled ground of the camp (pad is kept clear of terrain grass) ---
const FC = new Float64Array(3);
function floorCol(b, x, z) {
  const g = b.bio('ground'), r = Math.hypot(x, z);
  const n1 = noise3(x * 0.035, 1.7, z * 0.035), n2 = noise3(x * 0.16 + 3, 4.2, z * 0.16);
  // grazed short grass: gold-green, with sage patches
  let cr = g[0] * (0.93 + 0.14 * n2), cg = g[1] * (0.98 + 0.12 * n2), cb = g[2] * (0.95 + 0.1 * n2);
  const sage = smooth(0.45, 0.7, n1);
  cr = mix(cr, 0.3, sage * 0.35); cg = mix(cg, 0.29, sage * 0.35); cb = mix(cb, 0.16, sage * 0.35);
  // worn earth: the avenue, the gathering ground, the horse lines
  let worn = Math.max(1 - smooth(6, 13, capD(x, z, -118, 0, -14, 0)), 1 - smooth(14, 27, capD(x, z, -14, 0, 2, 0)));
  for (let i = 0; i < HL.length; i += 5) worn = Math.max(worn, 0.8 * (1 - smooth(3, 7, capD(x, z, HL[i], HL[i + 1], HL[i + 2], HL[i + 3]))));
  worn *= 0.75 + 0.3 * n2;
  worn *= 0.7; cr = mix(cr, 0.34, worn); cg = mix(cg, 0.27, worn); cb = mix(cb, 0.16, worn);
  const e = smooth(108, 124, r); // back to plain ground at the rim
  FC[0] = mix(cr, g[0], e); FC[1] = mix(cg, g[1], e); FC[2] = mix(cb, g[2], e);
  return FC;
}
function floor(b) {
  b.timeless().surface(SURF.EARTH).ao(1).emissive(0, 0);
  b.disc(124, 112, 30, (x, z) => {
    const c = floorCol(b, x, z); b.color(c[0], c[1], c[2]);
    const r = Math.hypot(x, z);
    return 0.02 - 0.07 * smooth(117, 124, r + 3 * noise3(x * 0.08, 2, z * 0.08));
  });
}

// --- a ger. Door yaw: local +z of the door frame. t: arrival time (built), d: struck (decay).
function ger(b, x, z, R, wallH, peakH, segs, yaw, felt, trim, t, d, smokeK) {
  b.push(); b.at(x, 0, z, yaw);
  // trampled ring and the floor's pale circle: laid with the ger, left behind when it goes
  b.timeless().appear(t, t + 0.01, MOTION.POP, 0, BY.BUILT).surface(SURF.EARTH).ao(1);
  const RR = R + 1.7;
  b.disc(RR, segs, 2, (px, pz) => {
    const u = Math.hypot(px, pz) / RR;
    const k = smooth(0.55, 1, u);
    b.color(mix(0.36, 0.25, k), mix(0.31, 0.2, k), mix(0.22, 0.12, k));
    return 0.045 - 0.02 * u * u;
  });
  // felt wall, trim band, door
  b.timeless().pivot(0, 0, 0).appear(t, t + 0.06, MOTION.GROW, 0, BY.BUILT).vanish(d + 0.05, d + 0.1, MOTION.GROW, 0, BY.DECAY);
  b.color(felt[0] * 0.93, felt[1] * 0.93, felt[2] * 0.93).surface(SURF.PLASTER).ao(0.92);
  b.lathe([R, -0.3, R, wallH], segs, { caps: false });
  b.color(trim[0], trim[1], trim[2]).surface(SURF.PLAIN).ao(0.9);
  b.lathe([R + 0.03, wallH * 0.62, R + 0.03, wallH * 0.62 + 0.22], segs, { caps: false });
  const dw = Math.min(0.55, R * 0.16), dh = Math.min(1.35, wallH * 0.82);
  b.color(0.07, 0.11, 0.26).box(0, dh * 0.53, R + 0.01, dw + 0.12, dh * 0.53 + 0.04, 0.05);
  b.color(0.34, 0.07, 0.035).box(0, dh * 0.5, R + 0.05, dw, dh * 0.5, 0.05);
  // roof: felt lowered on over the poles; struck first (flattens onto the wall head)
  b.timeless().pivot(0, wallH, 0).appear(t + 0.04, t + 0.1, MOTION.DROP, 2.5, BY.BUILT).vanish(d, d + 0.05, MOTION.GROW, 0, BY.DECAY);
  b.color(felt[0], felt[1], felt[2]).surface(SURF.PLASTER).ao(1);
  const rh = peakH - wallH, rc = Math.max(0.45, R * 0.17);
  b.lathe([R + 0.22, wallH - 0.12, R * 0.62, wallH + rh * 0.52, rc, peakH], segs, { caps: false });
  b.color(felt[0] * 0.6, felt[1] * 0.6, felt[2] * 0.6).ao(0.5);
  b.lathe([R + 0.22, wallH - 0.12, R - 0.02, wallH - 0.12], segs, { caps: false }); // eave underside
  b.color(trim[0] * 0.8, trim[1] * 0.8, trim[2] * 0.8).ao(0.95);
  b.lathe([R + 0.23, wallH - 0.13, R + 0.23, wallH + 0.06, R + 0.05, wallH + 0.16], segs, { caps: false }); // eave band
  b.color(0.11, 0.075, 0.05).surface(SURF.WOOD).ao(0.9);
  b.lathe([rc, peakH - 0.04, rc * 0.92, peakH + 0.1, 0, peakH + 0.16], Math.max(8, segs >> 1)); // crown ring
  b.pop();
  if (smokeK > 0) {
    b.timeless().appear(t + 0.12, t + 0.13, MOTION.POP, 0, BY.BUILT).vanish(Math.max(0.01, d - 0.08), Math.max(0.02, d - 0.07), MOTION.POP, 0, BY.DECAY);
    b.smoke(x, peakH + 0.25, z, { count: 9, size: 1.0 + 0.5 * smokeK, rise: 16 + 14 * smokeK, density: 0.13 + 0.06 * smokeK, color: [0.56, 0.57, 0.61], src: FLICKER.NONE });
    b.timeless();
  }
}

// --- animals and people ---
function horse(b, x, z, yaw, col, graze, s = 1) {
  b.push(); b.at(x, 0, z, yaw); b.scale(s);
  b.color(col[0], col[1], col[2]).surface(SURF.HIDE).ao(0.95);
  b.push(); b.translate(0, 1.0, 0); b.ellipsoid(0.26, 0.3, 0.66, 2); b.pop();
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 0.14 : -0.14, sz = i & 2 ? 0.42 : -0.44;
    b.beam(sx, 0.95, sz, sx * 1.05, 0, sz + 0.04, 0.075, 0.042, 5, false);
  }
  if (graze) { b.beam(0, 1.12, 0.48, 0, 0.6, 1.0, 0.16, 0.1, 5); b.beam(0, 0.66, 0.98, 0, 0.14, 1.16, 0.11, 0.07, 5); }
  else { b.beam(0, 1.12, 0.46, 0, 1.62, 0.84, 0.17, 0.11, 5); b.beam(0, 1.66, 0.82, 0, 1.33, 1.16, 0.12, 0.075, 5); }
  b.color(col[0] * 0.5, col[1] * 0.5, col[2] * 0.5);
  b.beam(0, 1.18, -0.6, 0, 0.5, -0.8, 0.075, 0.035, 4);
  b.pop();
}
function rider(b, x, z, yaw, col, coat, lance) {
  horse(b, x, z, yaw, col, false, 1.02);
  b.push(); b.at(x, 0, z, yaw);
  b.color(coat[0], coat[1], coat[2]).surface(SURF.HIDE).ao(0.95);
  b.beam(0, 1.3, -0.06, 0, 1.98, 0, 0.17, 0.14, 6);
  for (const sx of [-1, 1]) {
    b.beam(sx * 0.17, 1.36, 0, sx * 0.3, 0.86, 0.16, 0.08, 0.055, 5);
    b.beam(sx * 0.16, 1.88, 0, sx * 0.2, 1.48, 0.3, 0.055, 0.04, 4);
  }
  b.color(0.24, 0.16, 0.1); b.push(); b.translate(0, 2.15, 0.01); b.ellipsoid(0.1, 0.12, 0.11, 2); b.pop();
  b.color(0.1, 0.07, 0.05); b.push(); b.translate(0, 2.22, 0); b.cone(0.16, 0.2, 8); b.pop();
  if (lance) { b.color(0.15, 0.1, 0.06).surface(SURF.WOOD); b.beam(0.3, 0.9, 0.12, 0.33, 4.6, 0.02, 0.03, 0.02, 4); }
  b.pop();
}
function ox(b, x, z, yaw, col) {
  b.push(); b.at(x, 0, z, yaw);
  b.color(col[0], col[1], col[2]).surface(SURF.HIDE).ao(0.95);
  b.push(); b.translate(0, 0.98, 0); b.ellipsoid(0.38, 0.42, 0.85, 2); b.pop();
  for (let i = 0; i < 4; i++) { const sx = i & 1 ? 0.2 : -0.2, sz = i & 2 ? 0.55 : -0.58; b.beam(sx, 0.9, sz, sx, 0, sz, 0.1, 0.07, 5, false); }
  b.beam(0, 1.1, 0.7, 0, 0.8, 1.25, 0.2, 0.14, 5);
  b.color(0.5, 0.46, 0.38); b.beam(-0.08, 0.95, 1.2, -0.38, 1.18, 1.15, 0.035, 0.015, 4); b.beam(0.08, 0.95, 1.2, 0.38, 1.18, 1.15, 0.035, 0.015, 4);
  b.pop();
}
function cart(b, x, z, yaw, load) {
  b.push(); b.at(x, 0, z, yaw);
  b.color(0.2, 0.135, 0.08).surface(SURF.WOOD).ao(0.9);
  b.box(0, 1.02, 0, 0.75, 0.07, 1.35);
  for (const sx of [-0.85, 0.85]) {
    b.push(); b.translate(sx, 0.82, -0.1); b.rotateZ(Math.PI / 2); b.translate(0, -0.06, 0); b.cylinder(0.82, 0.12, 12); b.pop();
    b.color(0.11, 0.075, 0.05); b.beam(sx * 0.5, 1.0, 1.2, sx * 0.4, 0.05, 3.4, 0.06, 0.05, 5); b.color(0.2, 0.135, 0.08);
  }
  if (load === 0) { // chests, lacquered red
    b.color(0.36, 0.08, 0.04).surface(SURF.PLAIN); b.box(0, 1.4, -0.5, 0.6, 0.32, 0.5); b.box(0.05, 1.36, 0.6, 0.55, 0.28, 0.42);
    b.color(0.62, 0.45, 0.16); b.box(0, 1.73, -0.5, 0.62, 0.02, 0.52);
  } else if (load === 1) { // felt rolls and lattice bundles
    b.color(0.5, 0.48, 0.42).surface(SURF.PLASTER);
    for (let i = 0; i < 3; i++) { b.push(); b.translate(-0.6, 1.3 + (i === 2 ? 0.42 : 0), -0.6 + (i % 2) * 0.62 + (i === 2 ? 0.31 : 0)); b.rotateZ(-Math.PI / 2); b.cylinder(0.24, 1.2, 8); b.pop(); }
    b.color(0.26, 0.17, 0.1).surface(SURF.WOOD); b.box(0, 1.25, 0.85, 0.65, 0.16, 0.35);
  } else { // a small covered ger-cart
    b.color(0.56, 0.54, 0.48).surface(SURF.PLASTER);
    b.push(); b.translate(0, 1.08, 0); b.scale(1, 1, 1.6); b.lathe([0.74, 0, 0.74, 0.6, 0.45, 1.05, 0, 1.25], 12); b.pop();
    b.color(0.34, 0.07, 0.035); b.box(0, 1.5, 1.21, 0.28, 0.36, 0.04);
  }
  b.pop();
}
function figure(b, x, z, yaw, pose, h, coat, s) {
  b.color(coat[0], coat[1], coat[2]).surface(SURF.HIDE).ao(1);
  b.push(); b.at(x, 0, z, yaw); b.human(pose, h, s); b.pop();
}
function tug(b, x, z, H, main, tx, tz) {
  b.timeless().surface(SURF.STONE).ao(0.85).color(0.3, 0.28, 0.25);
  b.push(); b.translate(x, 0.05, z); b.rock(main ? 0.95 : 0.7, 0.35, main ? 0.95 : 0.7, 2, 0.25, (x * 7 + z * 13) | 0, 2, 0.6); b.pop();
  b.push(); b.translate(x, 0, z);
  b.pivot(0, 0, 0).tiltDir(tx, tz).appear(0.84, 0.92, MOTION.TILT, 0, BY.BUILT).vanish(0.06, 0.16, MOTION.TILT, 0, BY.DECAY);
  b.color(0.16, 0.1, 0.06).surface(SURF.WOOD).ao(0.95);
  b.beam(0, -0.2, 0, 0, H - 0.6, 0, 0.11, 0.075, 6);
  b.color(0.58, 0.565, 0.52).surface(SURF.HIDE).ao(1);
  const w = main ? 1.15 : 1;
  b.lathe([0.12, H - 2.6 * w, 0.36 * w, H - 2.15 * w, 0.46 * w, H - 1.5 * w, 0.36 * w, H - 1.0, 0.14, H - 0.68], 14,
    { wobble: (th, t) => (0.2 * Math.sin(th * 9) + 0.08 * Math.sin(th * 17)) * (1 - t) });
  b.color(0.75, 0.53, 0.2).surface(SURF.GILT).ao(1);
  b.push(); b.translate(0, H - 0.7, 0); b.cylinder(0.32 * w, 0.07, 12); b.pop();
  b.push(); b.translate(0, H - 0.45, 0); b.ellipsoid(0.11, 0.13, 0.11, 2); b.pop();
  b.beam(0, H - 0.4, 0, 0, H + 0.75 * w, 0, 0.065, 0.0, 4);
  b.beam(-0.03, H - 0.25, 0, -0.3, H + 0.3, 0, 0.035, 0.0, 4);
  b.beam(0.03, H - 0.25, 0, 0.3, H + 0.3, 0, 0.035, 0.0, 4);
  b.beam(-0.3, H - 0.32, 0, 0.3, H - 0.32, 0, 0.03, 0.03, 4);
  b.pop(); b.timeless();
}
// Cooking fire: ash bed left behind; the fire, tripod and cauldron go with the people.
function cookFire(b, x, z, light, tIn, tOut) {
  b.timeless().surface(SURF.EARTH).ao(1).color(0.13, 0.115, 0.1);
  b.push(); b.translate(x, 0, z); b.disc(1.6, 12, 2, (px, pz) => 0.05 - 0.02 * (px * px + pz * pz) / 2.6); b.pop();
  b.appear(tIn, tIn + 0.02, MOTION.POP, 0, BY.BUILT).vanish(tOut, tOut + 0.02, MOTION.POP, 0, BY.DECAY);
  b.fire(x, 0.03, z, 0.75, light, 1);
  b.color(0.14, 0.095, 0.06).surface(SURF.WOOD).ao(0.95);
  for (let i = 0; i < 3; i++) { const a = i * 2.094 + 0.4; b.beam(x + Math.cos(a) * 1.15, 0, z + Math.sin(a) * 1.15, x, 2.15, z, 0.045, 0.035, 4); }
  b.color(0.05, 0.045, 0.04).surface(SURF.PLAIN).ao(0.9);
  b.beam(x, 2.15, z, x, 1.25, z, 0.012, 0.012, 3, false);
  b.push(); b.translate(x, 0.72, z); b.lathe([0.12, 0, 0.4, 0.12, 0.44, 0.38, 0.36, 0.55], 10); b.pop();
  b.timeless();
}
function rack(b, x, z, yaw, tIn, tOut) {
  b.push(); b.at(x, 0, z, yaw);
  b.timeless().appear(tIn, tIn + 0.02, MOTION.POP, 0, BY.BUILT).vanish(tOut, tOut + 0.02, MOTION.POP, 0, BY.DECAY);
  b.color(0.17, 0.11, 0.07).surface(SURF.WOOD).ao(0.95);
  for (const sx of [-1.6, 1.6]) { b.beam(sx, 0, -0.5, sx, 1.75, 0, 0.04, 0.035, 4); b.beam(sx, 0, 0.5, sx, 1.75, 0, 0.04, 0.035, 4); }
  b.beam(-1.75, 1.72, 0, 1.75, 1.72, 0, 0.035, 0.035, 4);
  for (let i = 0; i < 6; i++) {
    const u = -1.3 + i * 0.52, hide = i % 3 === 1;
    b.color(hide ? 0.42 : 0.3, hide ? 0.3 : 0.09, hide ? 0.18 : 0.06).surface(hide ? SURF.HIDE : SURF.PLAIN);
    b.box(u, hide ? 1.15 : 1.35, 0, hide ? 0.22 : 0.06, hide ? 0.55 : 0.36, 0.015);
  }
  b.pop(); b.timeless();
}

const COATS = [[0.05, 0.07, 0.15], [0.19, 0.045, 0.03], [0.13, 0.085, 0.05], [0.21, 0.15, 0.06], [0.07, 0.06, 0.05], [0.06, 0.09, 0.16], [0.17, 0.1, 0.055]];
const HORSES = [[0.09, 0.06, 0.04], [0.16, 0.08, 0.04], [0.05, 0.045, 0.04], [0.22, 0.15, 0.08], [0.38, 0.36, 0.33], [0.12, 0.07, 0.04]];

export default {
  id: 'mongol-camp',
  name: 'Mongol encampment',
  caption: 'Temüjin is proclaimed Genghis Khan before the nine white standards',
  year: 1206,
  radius: 125,
  pad: 126, // road centre line at x = -133
  straddlesRoad: false,
  biome: 'steppe',
  live: true,
  wind: [0.75, -0.66],
  lights: [
    { pos: [-30, 0.6, -20], color: [1.0, 0.5, 0.18], intensity: 40, range: 18, flicker: 0.6, appear: [0.62, 0.7], vanish: [0.05, 0.3] },
  ],
  detail: { at: [-6, 4, 0], from: [-40, 7, 20] },
  strip: { at: [10, 3, 0], from: [-120, 26, 70], fov: 0.6 },
  // Event moment: from above the road-side edge, down the avenue over the standards and the
  // gathering to the khan's great ger, the city of gers spreading behind to the horizon smoke.
  witness: { at: [2, 0], dist: 78, height: 17, look: 5, az: 0.42, fov: 0.5, drift: 0.07, range: 1100 },
  // More of the tribes out on the steppe: ger clusters with herds and smoke, mostly ahead of
  // the car and on the far side, out to the horizon.
  satellites: {
    count: [9, 12], near: 4, nearR: [160, 280], farR: [340, 1150],
    centre: -0.55, spread: 3.7, minSep: 95, roadClear: 45, visible: 1,
    build(b, k, n, dist) {
      const far = Math.min(1, dist / 1000), t = 0.1 + 0.5 * (k / n), d = 0.3 + 0.5 * (k / n);
      const s = 1 + 0.9 * far, ng = (dist < 400 ? 3 : 2) + Math.floor(b.rand() * 3), segs = dist < 400 ? 12 : 8;
      for (let i = 0; i < ng; i++) {
        const a = i * 2.4 + b.rand(), r = i === 0 ? 0 : (8 + 5 * b.rand()) * s;
        const x = Math.cos(a) * r, z = Math.sin(a) * r, R = (2.9 + 0.6 * b.rand()) * s;
        const c = 0.5 + 0.08 * b.rand();
        ger(b, x, z, R, 1.6 * s, 3.2 * s, segs, b.rand() * 6.28, [c, c * 0.97, c * 0.88], b.rand() < 0.5 ? [0.06, 0.1, 0.26] : [0.3, 0.06, 0.04], t, d, i === 0 ? 1 + far : 0);
      }
      // the herd: horses near, a flock of sheep further out
      b.timeless().appear(t, t + 0.01, MOTION.POP, 0, BY.BUILT).vanish(d + 0.12, d + 0.13, MOTION.POP, 0, BY.DECAY);
      const ha = b.rand() * 6.28, hr = (24 + 10 * b.rand()) * s, hx = Math.cos(ha) * hr, hz = Math.sin(ha) * hr;
      const nh = dist < 400 ? 7 : 12;
      for (let i = 0; i < nh; i++) {
        const x = hx + (b.rand() - 0.5) * 14 * s, z = hz + (b.rand() - 0.5) * 10 * s;
        if (dist < 400) horse(b, x, z, b.rand() * 6.28, HORSES[i % HORSES.length], b.rand() < 0.6);
        else {
          const sh = b.rand() < 0.7, c = sh ? 0.5 : 0.08;
          b.color(c, c * 0.95, c * 0.85).surface(SURF.HIDE).ao(1);
          b.push(); b.translate(x, 0.75 * s, z); b.rotateY(b.rand() * 3); b.ellipsoid(0.5 * s, 0.5 * s, 0.9 * s, 1); b.pop();
        }
      }
      b.timeless();
    },
  },

  build(b, built, decay, seed) {
    layout(b);
    floor(b);

    // --- the khan's great ger: arrives first, struck last
    const kf = [0.6, 0.58, 0.53];
    ger(b, KX, 0, KR, 3.6, 10.2, 40, -Math.PI / 2, kf, [0.06, 0.1, 0.28], 0.05, 0.7, 1.6);
    b.push(); b.at(KX, 0, 0, -Math.PI / 2);
    b.timeless().pivot(0, 0, 0).appear(0.05, 0.12, MOTION.GROW, 0, BY.BUILT).vanish(0.75, 0.8, MOTION.GROW, 0, BY.DECAY);
    // second red band, gilt finial, and a felt awning on red poles over the door
    b.color(0.3, 0.06, 0.035).surface(SURF.PLAIN).ao(0.9);
    b.lathe([KR + 0.04, 0.55, KR + 0.04, 0.85], 40, { caps: false });
    b.color(0.75, 0.53, 0.2).surface(SURF.GILT).ao(1);
    b.push(); b.translate(0, 10.35, 0); b.lathe([0.3, 0, 0.42, 0.3, 0.2, 0.75, 0.08, 1.1, 0, 1.8], 10); b.pop();
    b.color(0.62, 0.45, 0.16).box(0, 1.85, KR + 0.1, 1.45, 1.85, 0.06);
    b.color(0.32, 0.06, 0.03).surface(SURF.PLAIN).box(0, 1.7, KR + 0.16, 1.15, 1.7, 0.06);
    b.color(0.3, 0.06, 0.035).surface(SURF.WOOD);
    for (const sx of [-2.6, 2.6]) { b.beam(sx, 0, KR + 3.6, sx, 3.5, KR + 3.6, 0.1, 0.09, 6); b.beam(sx, 0, KR + 0.6, sx, 3.9, KR + 0.6, 0.1, 0.09, 6); }
    b.color(0.58, 0.56, 0.5).surface(SURF.PLASTER).ao(0.95);
    b.hexa([-2.9, 3.85, KR + 0.2, 2.9, 3.85, KR + 0.2, 2.9, 3.45, KR + 3.9, -2.9, 3.45, KR + 3.9,
      -2.9, 3.97, KR + 0.2, 2.9, 3.97, KR + 0.2, 2.9, 3.57, KR + 3.9, -2.9, 3.57, KR + 3.9]);
    b.color(0.06, 0.1, 0.28).surface(SURF.PLAIN).box(0, 3.43, KR + 3.92, 2.95, 0.16, 0.04);
    b.pop();
    // the white felt before the door, the khan seated on it, two attendants
    b.timeless().appear(0.6, 0.62, MOTION.POP, 0, BY.BUILT).vanish(0.03, 0.05, MOTION.POP, 0, BY.DECAY);
    b.color(0.6, 0.58, 0.53).surface(SURF.HIDE).ao(1).box(KX - KR - 6.2, 0.05, 0, 2.0, 0.03, 2.6);
    figure(b, KX - KR - 5.9, 0, -Math.PI / 2, POSE.SIT, 1.75, [0.07, 0.1, 0.24], seed + 1);
    figure(b, KX - KR - 6, -3.4, -Math.PI / 2, POSE.STAND, 1.75, [0.28, 0.06, 0.035], seed + 2);
    figure(b, KX - KR - 6, 3.4, -Math.PI / 2, POSE.STAND, 1.75, [0.28, 0.06, 0.035], seed + 3);

    // --- the gathering: still figures in loose rows facing the khan
    let fi = 0;
    for (let row = 0; row < 4; row++) {
      const xr = -5 - row * 2.4, w = 7 + row * 1.6, nr = 7 + row * 2;
      for (let i = 0; i < nr; i++) {
        const zz = -w + (2 * w * (i + 0.5)) / nr + (b.rand() - 0.5) * 0.7, xx = xr + (b.rand() - 0.5) * 0.8;
        const tIn = 0.62 + 0.25 * b.rand(), tOut = 0.04 + 0.25 * b.rand();
        b.timeless().appear(tIn, tIn + 0.01, MOTION.POP, 0, BY.BUILT).vanish(tOut, tOut + 0.01, MOTION.POP, 0, BY.DECAY);
        figure(b, xx, zz, Math.PI / 2 + (b.rand() - 0.5) * 0.3, row === 0 ? POSE.KNEEL : POSE.STAND, 1.6 + 0.15 * b.rand(), COATS[(fi++ * 3 + row) % COATS.length], seed + 10 + fi);
      }
    }
    b.timeless();

    // --- the nine white standards in an arc before the gathering, the tallest in the middle
    for (let i = -4; i <= 4; i++) {
      const a = i * 0.16, x = KX - Math.cos(a) * SR, z = Math.sin(a) * SR * 1.05;
      tug(b, x, z, i === 0 ? 12.5 : 9.8 - 0.2 * Math.abs(i), i === 0, -Math.cos(a), Math.sin(a));
    }

    // --- the gers
    for (let i = 0; i < NG; i++) {
      const o = i * 4, x = GP[o], z = GP[o + 1], R = GP[o + 2], u = (GP[o + 3] - 30) / 80;
      const c = 0.5 + 0.09 * b.rand(), old = b.rand() < 0.2;
      const felt = old ? [c * 0.88, c * 0.82, c * 0.7] : [c, c * 0.975, c * 0.9];
      const trim = b.rand() < 0.55 ? [0.06, 0.1, 0.27] : [0.3, 0.06, 0.04];
      // doors toward the road side, as one camp
      const yaw = -Math.PI / 2 + 0.35 + (b.rand() - 0.5) * 0.5;
      const sm = b.rand() < 0.45 ? 0.4 + 0.6 * b.rand() : 0;
      ger(b, x, z, R, 1.55 + 0.25 * b.rand(), R * 0.62 + 1.25 + 0.3 * b.rand(), 14, yaw, felt, trim,
        0.12 + 0.55 * u + 0.04 * b.rand(), 0.15 + 0.5 * (1 - u) + 0.04 * b.rand(), sm);
    }

    // --- horse lines: tether posts and rope, horses on both sides facing it
    for (let l = 0; l < HL.length; l += 5) {
      const x0 = HL[l], z0 = HL[l + 1], x1 = HL[l + 2], z1 = HL[l + 3], n = HL[l + 4];
      const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz), nx = -dz / L, nz = dx / L;
      b.timeless().appear(0.02, 0.03, MOTION.POP, 0, BY.BUILT).vanish(0.82, 0.83, MOTION.POP, 0, BY.DECAY);
      b.color(0.15, 0.1, 0.06).surface(SURF.WOOD).ao(0.95);
      b.beam(x0, 0, z0, x0, 1.5, z0, 0.07, 0.06, 5); b.beam(x1, 0, z1, x1, 1.5, z1, 0.07, 0.06, 5);
      b.color(0.3, 0.25, 0.17).beam(x0, 1.38, z0, x1, 1.38, z1, 0.022, 0.022, 3, false);
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5 + (b.rand() - 0.5) * 0.4) / n, side = i % 2 ? 1 : -1;
        const x = x0 + dx * u + nx * side * 1.9, z = z0 + dz * u + nz * side * 1.9;
        horse(b, x, z, Math.atan2(-nx * side, -nz * side) + (b.rand() - 0.5) * 0.4, HORSES[(i + l) % HORSES.length], b.rand() < 0.3);
      }
    }
    // loose herd grazing behind the camp, sheep, oxen by the carts
    b.timeless().appear(0.0, 0.01, MOTION.POP, 0, BY.BUILT).vanish(0.88, 0.89, MOTION.POP, 0, BY.DECAY);
    for (let i = 0; i < 14; i++) horse(b, 88 + (b.rand() - 0.5) * 30, -52 + (b.rand() - 0.5) * 18, b.rand() * 6.28, HORSES[i % HORSES.length], b.rand() < 0.7);
    for (let i = 0; i < 22; i++) {
      const c = b.rand() < 0.85 ? 0.52 : 0.1;
      b.color(c, c * 0.95, c * 0.84).surface(SURF.HIDE).ao(1);
      b.push(); b.translate(61 + (b.rand() - 0.5) * 26, 0.42, 73 + (b.rand() - 0.5) * 14); b.rotateY(b.rand() * 6.28);
      b.ellipsoid(0.32, 0.3, 0.52, 2); b.translate(0, 0.08, 0.5); b.ellipsoid(0.11, 0.13, 0.17, 1); b.pop();
    }
    for (let i = 0; i < 5; i++) ox(b, -30 + i * 9 + b.rand() * 3, 102 - i * 0.6 + b.rand() * 3, b.rand() * 6.28, i % 2 ? [0.08, 0.06, 0.05] : [0.2, 0.13, 0.08]);
    // carts: the park, and a few beside the gers
    b.timeless().appear(0.0, 0.01, MOTION.POP, 0, BY.BUILT).vanish(0.92, 0.93, MOTION.POP, 0, BY.DECAY);
    for (let i = 0; i < 7; i++) cart(b, -36 + i * 7.6, 88 + i * 1.3, 0.35 + (b.rand() - 0.5) * 0.3, i % 3);
    cart(b, -62, -14, 2.3, 0); cart(b, 44, 34, -0.8, 2); cart(b, 40, -40, 2.6, 1);
    b.timeless();

    // --- riders: sentries on the road-side edge, two at the avenue, a herdsman
    const R6 = [-100, 46, -1.4, -97, -30, -1.75, -30, 16, -1.2, -30, -16, -1.95, 104, -36, 0.4, 20, -104, 3.0];
    for (let i = 0; i < R6.length; i += 3) {
      const tIn = 0.55 + 0.03 * i / 3, tOut = 0.04 + 0.03 * i / 3;
      b.timeless().appear(tIn, tIn + 0.01, MOTION.POP, 0, BY.BUILT).vanish(tOut, tOut + 0.01, MOTION.POP, 0, BY.DECAY);
      rider(b, R6[i], R6[i + 1], R6[i + 2], HORSES[i % 4], COATS[(i / 3) % COATS.length], i < 12);
    }
    b.timeless();

    // --- cooking fires among the gers (one lit for the gathering), racks beside some
    cookFire(b, -30, -20, 1, 0.62, 0.15);
    let nf = 0;
    for (let tr = 0; tr < 400 && nf < 9; tr++) {
      const a = b.rand() * 6.283, r = 25 + 80 * b.rand(), x = KX + Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.hypot(x, z) > 108 || inZone(x, z, 3) || !gerFree(x, z, 2.5, 2)) continue;
      cookFire(b, x, z, 0, 0.5 + 0.12 * b.rand(), 0.05 + 0.25 * b.rand());
      if (nf % 2 === 0) rack(b, x + 4, z + 1.5, b.rand() * 3, 0.6, 0.2);
      // the cooks
      b.timeless().appear(0.7, 0.71, MOTION.POP, 0, BY.BUILT).vanish(0.1, 0.11, MOTION.POP, 0, BY.DECAY);
      figure(b, x - 1.9, z + 0.4, Math.PI / 2, POSE.KNEEL, 1.6, COATS[(nf + 2) % COATS.length], seed + 60 + nf);
      if (nf % 3 === 0) figure(b, x + 1.4, z - 1.6, -0.6, POSE.STAND, 1.65, COATS[(nf + 4) % COATS.length], seed + 80 + nf);
      b.timeless();
      GP[NG * 4] = x; GP[NG * 4 + 1] = z; GP[NG * 4 + 2] = 3; NG++; // keep later fires apart
      nf++;
    }
    rack(b, -40, -26, 0.4, 0.6, 0.2); rack(b, 34, 26, 1.2, 0.6, 0.2);

    // --- tussocks around the rim, so the camp ground frays into the steppe grass
    const tip = b.bio('grassTip');
    b.timeless().surface(SURF.PLAIN).ao(0.9);
    for (let i = 0; i < 230; i++) {
      const a = b.rand() * 6.283, r = i < 170 ? 104 + 18 * Math.sqrt(b.rand()) : 30 + 75 * b.rand();
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (x < -110 || inZone(x, z, 1) || !gerFree(x, z, 0.5, 1.5)) continue;
      const h = 0.45 + 0.4 * b.rand(), k = 0.75 + 0.3 * b.rand();
      b.color(tip[0] * k, tip[1] * k, tip[2] * k);
      for (let j = 0; j < 5; j++) {
        const ba = j * 1.257 + b.rand(), lx = Math.cos(ba) * 0.22, lz = Math.sin(ba) * 0.22;
        b.beam(x + lx * 0.4, -0.02, z + lz * 0.4, x + lx * 1.6, h * (0.7 + 0.3 * b.rand()), z + lz * 1.6, 0.05, 0.0, 3, false);
      }
    }
    b.timeless();
    return b.counts();
  },
};
