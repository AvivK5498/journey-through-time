// First powered flight, Kill Devil Hills near Kitty Hawk, 17 December 1903.
//
// Flat sand below a big dune: the 18 m wooden launch rail, the plain board hangar and the
// smaller living shed (tar-paper roofs), an anemometer mast with spinning cups, a camera on a
// tripod by the end of the rail and a few still onlookers in dark coats. The Wright Flyer:
// a muslin-and-spruce biplane with the biplane elevator out in front, twin rudders behind,
// two pusher propellers chain-driven from the engine, skids, the pilot prone on the lower wing.
//
// Time: the registry ramps built 0 -> 1 over clock 250-253 (no decay). At built 0 the Flyer
// sits on the rail at its start being readied, props still, two men at the machine. As built
// rises the men step back and it goes: animate() starts a real-time cycle at that moment and
// repeats it for as long as the site exists: props run up on the rail, the take-off run down
// the rail, lift-off, ~140 m low and unsteady over the sand parallel to the road (and shore),
// a skid landing, a pause, and it is back at the start of the rail. A passer-by sees it in the
// air (about half the cycle) or about to be.
//
// Layout (landmark-local; road centre line at x = -ROAD_OFF, the car travels toward -z):
// the flight line runs along z at x = FX (45 m from the road), from the rail start at
// z = RZ0 toward -z; the sheds stand behind the rail start (x ~ -22), the dune behind them,
// the onlookers and the camera between the rail and the road but clear of the wing tips.
// The pad is large (85 m) so the whole flight line is on flattened ground.
//
// Rigs: 1 the airframe, 2 / 3 the left / right propellers (placed at their hubs every frame,
// counter-rotating), 4 the anemometer cups.

import { SURF, POSE, BY, MOTION, noise3, seg, ease } from './kit.js';

const TAU = Math.PI * 2;
const ROAD_OFF = 110, PAD = 100, RADIUS = 150;
const FX = -50; // flight line x (local), 60 m from the road
const RZ0 = 70; // rail start (the Flyer's centre at rest), z
const RAIL = 18; // rail length (60 ft)
const RAIL_Y = 0.3; // the Flyer's skids above the sand while on the rail truck
const SC = 1.45; // Flyer drawn a little over life size so it reads from the road
const L = 120; // metres flown
const V = 12; // ground speed in the air (m/s)
// cycle (s): hold on the rail with props running, take-off run, flight, skid slide, pause
// After the landing it rests where it stopped with two men by its wing tips (they waited
// there through the flight), then they carry it back up the flight line to the rail at a run.
const SLIDE = 7; // metres slid on the skids
const S_END = RAIL + L + SLIDE, V_BACK = 7;
const T_HOLD = 3, T_ROLL = 3, T_FLY = L / V, T_SLIDE = 1.3, T_REST = 3.5, T_BACK = S_END / V_BACK;
const T_LAND = T_HOLD + T_ROLL + T_FLY + T_SLIDE;
const T_CYC = T_LAND + T_REST + T_BACK;
const TIP = 6.6 * SC; // the carriers' distance from the centre line (just beyond the wing tips)
const SPIN = TAU * 4.6; // propeller rad/s (two blades: ~28 degrees a frame at 60 Hz)
const HUB_X = 2.35, HUB_Y = 1.45, HUB_Z = -1.35; // propeller hubs in the Flyer's frame
const MAST = [-34, 7.2, 40]; // anemometer mast: x, height, z

// ---- module scratch (animate allocates nothing)
const HX = new Float64Array(24);
const POSE6 = new Float64Array(6); // x, y, z, pitch, roll, yaw wobble
const WAT = new Float64Array([FX, RZ0]); // witness look-at (x, z)
const WIT = new Float64Array([34, -0.5, 1.8, 3.4]); // witness dist, az, look, height
const ST = { h: null, t0: -1 };

// ---------------------------------------------------------------------------- helpers

// Flat slab whose four corners have their own heights: (x0, z0), (x1, z0), (x1, z1), (x0, z1)
// at y a, b, c, d, thickness th.
function slab(b, x0, x1, z0, z1, ya, yb, yc, yd, th) {
  HX[0] = x0; HX[1] = ya; HX[2] = z0; HX[3] = x1; HX[4] = yb; HX[5] = z0;
  HX[6] = x1; HX[7] = yc; HX[8] = z1; HX[9] = x0; HX[10] = yd; HX[11] = z1;
  for (let i = 0; i < 4; i++) { HX[12 + i * 3] = HX[i * 3]; HX[13 + i * 3] = HX[i * 3 + 1] + th; HX[14 + i * 3] = HX[i * 3 + 2]; }
  b.hexa(HX, true);
}
// Vertical panel in the y-z plane at x (rudders, doors), thickness th along x.
function panel(b, x, z0, z1, y0, y1, th) {
  HX[0] = x - th; HX[1] = y0; HX[2] = z0; HX[3] = x + th; HX[4] = y0; HX[5] = z0;
  HX[6] = x + th; HX[7] = y0; HX[8] = z1; HX[9] = x - th; HX[10] = y0; HX[11] = z1;
  HX[12] = x - th; HX[13] = y1; HX[14] = z0; HX[15] = x + th; HX[16] = y1; HX[17] = z0;
  HX[18] = x + th; HX[19] = y1; HX[20] = z1; HX[21] = x - th; HX[22] = y1; HX[23] = z1;
  b.hexa(HX, true);
}
// Gable roof over [x0, x1] x [z0, z1] from eave height y, ridge `rise` above, ridge along z.
function roofZ(b, x0, x1, z0, z1, y, rise, over) {
  const xm = (x0 + x1) / 2;
  x0 -= over; x1 += over; z0 -= over; z1 += over;
  HX.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, xm, y + rise, z0, xm, y + rise, z0, xm, y + rise, z1, xm, y + rise, z1]);
  b.hexa(HX, false);
}
// Plain board building: walls, a tar-paper gable roof (ridge along z).
function shed(b, cx, cz, w, len, eave, rise) {
  b.color(0.36, 0.3, 0.22).surface(SURF.WOOD).ao(0.95);
  b.box(cx, eave / 2 - 0.1, cz, w / 2, eave / 2 + 0.1, len / 2, false);
  // gable ends
  b.ao(0.9);
  for (const s of [-1, 1]) {
    const z = cz + s * len / 2;
    HX.set([cx - w / 2, eave, z - 0.02, cx + w / 2, eave, z - 0.02, cx + w / 2, eave, z + 0.02, cx - w / 2, eave, z + 0.02,
      cx, eave + rise, z - 0.02, cx, eave + rise, z - 0.02, cx, eave + rise, z + 0.02, cx, eave + rise, z + 0.02]);
    b.hexa(HX, false);
  }
  // corner and eave trim, a shade lighter (reads the box from afar)
  b.color(0.44, 0.38, 0.29);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(cx + sx * w / 2, eave / 2, cz + sz * len / 2, 0.07, eave / 2, 0.07, false);
  b.color(0.12, 0.11, 0.105).surface(SURF.PLAIN).ao(1);
  roofZ(b, cx - w / 2, cx + w / 2, cz - len / 2, cz + len / 2, eave, rise, 0.35);
}
// A clump of marram grass at (x, y, z).
function tuft(b, x, y, z, s) {
  const n = 3 + (b.rand() * 2 | 0);
  b.color(0.36 + 0.08 * b.rand(), 0.37, 0.2).surface(SURF.PLAIN).ao(0.85);
  for (let i = 0; i < n; i++) {
    const a = b.rand() * TAU, r = 0.25 * s * b.rand(), h = s * (0.5 + 0.4 * b.rand());
    const lx = 0.35 * s * (b.rand() - 0.5), lz = 0.35 * s * (b.rand() - 0.5);
    b.beam(x + Math.cos(a) * r, y - 0.05, z + Math.sin(a) * r, x + Math.cos(a) * r + lx, y + h, z + Math.sin(a) * r + lz, 0.09 * s, 0.0, 4, false);
  }
}

// The big dune behind the sheds (Kill Devil Hill's kind): height above the pad at (x, z).
function dune(x, z) {
  const dx = (x + 2) / 30, dz = (z - 55) / 42;
  const r2 = dx * dx + dz * dz;
  if (r2 >= 1) return 0;
  const k = 1 - r2;
  return 8.5 * k * k * (1 + 0.12 * (noise3(x * 0.05, 0, z * 0.05) - 0.5));
}
// The sand field: low hummocks except on the flat strip along the flight line, the dune.
function sandY(x, z) {
  const strip = seg(Math.abs(x - FX), 9, 18); // 0 on the strip, 1 off it
  const hum = (noise3(x * 0.07, 3.1, z * 0.07) - 0.45) * 1.3 + (noise3(x * 0.19, 7.7, z * 0.19) - 0.5) * 0.35;
  return 0.03 + strip * Math.max(0, hum) + dune(x, z);
}
// Inside the irregular sand patch (else the vertex is sunk so the terrain covers it).
function inSand(x, z) {
  if (dune(x, z) > 0) return true;
  const ex = (x + 20) / 64, ez = z / 112;
  return ex * ex + ez * ez < 0.84 + 0.22 * noise3(x * 0.03, 1.3, z * 0.03);
}

// ---------------------------------------------------------------------------- the Flyer

// A biplane wing at height y0 (lower surface), span, leading edge at zLE, chord; cambered,
// the outer panels drooping (the 1903 machine's slight anhedral).
function wing(b, y0, span, zLE, chord, droop) {
  const hs = span / 2, xi = span * 0.17;
  const XS = [-hs, -xi, xi, hs], US = [0, 0.2, 0.55, 1];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const xa = XS[i], xb = XS[i + 1], ua = US[j], ub = US[j + 1];
      const za = zLE - ua * chord, zb = zLE - ub * chord;
      const ca = 0.42 * chord * 0.12 * ua * (1 - ua) * 4 / 1.7, cb = 0.42 * chord * 0.12 * ub * (1 - ub) * 4 / 1.7;
      const da = -droop * Math.max(0, (Math.abs(xa) - xi) / (hs - xi)), db = -droop * Math.max(0, (Math.abs(xb) - xi) / (hs - xi));
      // corners: (xa, za) (xb, za) (xb, zb) (xa, zb)
      slab(b, xa, xb, za, zb, y0 + ca + da, y0 + ca + db, y0 + cb + db, y0 + cb + da, 0.045);
    }
  }
}

function flyer(b) {
  const WOOD = [0.42, 0.31, 0.19], CLOTH = [0.6, 0.56, 0.46], IRON = [0.07, 0.07, 0.075];
  const LO = 0.58, GAP = 1.83, SPAN = 12.3, CH = 1.98, ZLE = 1.0;
  // wings (unbleached muslin)
  b.color(CLOTH[0], CLOTH[1], CLOTH[2]).surface(SURF.PLAIN).ao(0.92);
  wing(b, LO, SPAN, ZLE, CH, 0.12);
  wing(b, LO + GAP, SPAN, ZLE, CH, 0.12);
  // leading-edge spars, darker, so the wing edges read
  b.color(WOOD[0] * 0.8, WOOD[1] * 0.8, WOOD[2] * 0.8).surface(SURF.WOOD).ao(1);
  for (const y of [LO, LO + GAP]) {
    b.beam(-SPAN / 2, y - 0.1, ZLE, -SPAN * 0.17, y + 0.02, ZLE, 0.035, 0.035, 5);
    b.beam(-SPAN * 0.17, y + 0.02, ZLE, SPAN * 0.17, y + 0.02, ZLE, 0.035, 0.035, 5);
    b.beam(SPAN * 0.17, y + 0.02, ZLE, SPAN / 2, y - 0.1, ZLE, 0.035, 0.035, 5);
  }
  // struts between the wings, front and rear spars
  b.color(WOOD[0], WOOD[1], WOOD[2]);
  for (const sx of [-1, 1]) {
    for (const xs of [0.55, 1.75, 2.95, 4.15, 5.35]) {
      const dr = -0.12 * Math.max(0, (xs - SPAN * 0.17) / (SPAN / 2 - SPAN * 0.17));
      for (const zs of [ZLE - 0.2, ZLE - CH + 0.3]) b.beam(sx * xs, LO + 0.05 + dr, zs, sx * xs, LO + GAP + dr, zs, 0.022, 0.022, 4, false);
    }
    // bracing wire diagonals in the centre bays (thin, dark)
    b.color(0.2, 0.18, 0.16);
    b.beam(sx * 0.55, LO + 0.1, ZLE - 0.2, sx * 1.75, LO + GAP, ZLE - 0.2, 0.008, 0.008, 3, false);
    b.beam(sx * 1.75, LO + 0.1, ZLE - 0.2, sx * 0.55, LO + GAP, ZLE - 0.2, 0.008, 0.008, 3, false);
    b.color(WOOD[0], WOOD[1], WOOD[2]);
  }
  // skids: two runners, curving up at the front to carry the elevator
  for (const sx of [-0.55, 0.55]) {
    b.beam(sx, 0.06, -1.3, sx, 0.06, 2.4, 0.04, 0.04, 5);
    b.beam(sx, 0.06, 2.4, sx, 0.75, 3.5, 0.04, 0.035, 5);
    b.beam(sx, 0.06, 0.6, sx, LO + 0.05, 0.6, 0.025, 0.025, 4, false);
    b.beam(sx, 0.06, -0.8, sx, LO + 0.05, -0.8, 0.025, 0.025, 4, false);
  }
  // elevator (canard): two surfaces out front on outriggers
  const EZ = 3.75, ECH = 0.85, ESP = 4.4, EL = 0.78, EU = 1.62;
  for (const sx of [-0.6, 0.6]) {
    b.beam(sx, LO + 0.03, ZLE, sx, EL, EZ - ECH * 0.6, 0.025, 0.025, 4, false);
    b.beam(sx, LO + GAP, ZLE, sx, EU, EZ - ECH * 0.6, 0.025, 0.025, 4, false);
  }
  for (const sx of [-1, 1]) for (const xs of [0.6, 2.0]) b.beam(sx * xs, EL, EZ - 0.4, sx * xs, EU, EZ - 0.4, 0.018, 0.018, 4, false);
  b.color(CLOTH[0], CLOTH[1], CLOTH[2]).surface(SURF.PLAIN).ao(0.92);
  for (const y of [EL, EU]) {
    slab(b, -ESP / 2, ESP / 2, EZ, EZ - ECH, y, y, y, y, 0.035);
    // rounded ends
    for (const sx of [-1, 1]) slab(b, sx * ESP / 2, sx * (ESP / 2 + 0.22), EZ - 0.15, EZ - ECH + 0.15, y, y, y, y, 0.03);
  }
  // rudders: twin vertical surfaces on booms behind
  b.color(WOOD[0], WOOD[1], WOOD[2]).surface(SURF.WOOD).ao(1);
  const RZ = -3.3, RCH = 0.62;
  for (const sx of [-1, 1]) {
    b.beam(sx * 0.62, LO + 0.03, ZLE - CH, sx * 0.34, 0.72, RZ, 0.022, 0.02, 4, false);
    b.beam(sx * 0.62, LO + GAP, ZLE - CH, sx * 0.34, 2.32, RZ, 0.022, 0.02, 4, false);
  }
  b.color(CLOTH[0], CLOTH[1], CLOTH[2]).surface(SURF.PLAIN).ao(0.95);
  for (const sx of [-1, 1]) panel(b, sx * 0.34, RZ - RCH, RZ, 0.68, 2.38, 0.016);
  // engine (right of centre), radiator, chains to the propeller shafts
  b.color(IRON[0], IRON[1], IRON[2]).surface(SURF.PLAIN).ao(0.9);
  b.box(0.48, LO + 0.3, -0.25, 0.22, 0.24, 0.32);
  b.color(0.16, 0.15, 0.14);
  b.box(0.3, LO + 0.75, 0.25, 0.04, 0.38, 0.14);
  b.color(IRON[0], IRON[1], IRON[2]);
  for (const sx of [-1, 1]) {
    b.beam(0.48, LO + 0.35, -0.55, sx * HUB_X, HUB_Y + 0.08, HUB_Z + 0.25, 0.018, 0.018, 3, false);
    b.beam(0.48, LO + 0.15, -0.55, sx * HUB_X, HUB_Y - 0.08, HUB_Z + 0.25, 0.018, 0.018, 3, false);
    // shaft bearing struts from the rear spar
    b.beam(sx * HUB_X, LO + 0.05, ZLE - CH + 0.3, sx * HUB_X, HUB_Y, HUB_Z + 0.1, 0.022, 0.022, 4, false);
    b.beam(sx * HUB_X, LO + GAP, ZLE - CH + 0.3, sx * HUB_X, HUB_Y, HUB_Z + 0.1, 0.022, 0.022, 4, false);
  }
  // the pilot lying prone on the lower wing, left of centre, head forward
  b.color(0.075, 0.07, 0.07).surface(SURF.PLAIN).ao(0.95);
  const py = LO + 0.2, px = -0.42;
  b.push(); b.translate(px, py + 0.1, 0.05); b.ellipsoid(0.21, 0.14, 0.45, 2); b.pop();
  b.push(); b.translate(px, py + 0.13, 0.62); b.ellipsoid(0.11, 0.11, 0.12, 2); b.pop();
  b.beam(px - 0.1, py + 0.05, -0.35, px - 0.14, py, -1.1, 0.075, 0.06, 5);
  b.beam(px + 0.1, py + 0.05, -0.35, px + 0.14, py, -1.1, 0.075, 0.06, 5);
  b.color(0.42, 0.3, 0.24);
  b.push(); b.translate(px, py + 0.1, 0.72); b.ellipsoid(0.07, 0.07, 0.05, 1); b.pop(); // face, looking ahead
}

// A two-bladed propeller in the x-y plane around the origin (axis along z).
function propeller(b) {
  b.color(0.45, 0.33, 0.19).surface(SURF.WOOD).ao(1);
  b.box(0, 0, 0, 0.09, 0.09, 0.1);
  for (const s of [-1, 1]) {
    // root to mid, mid to tip; twisted (leading edge forward)
    const R0 = 0.08, R1 = 0.75, R2 = 1.3;
    blade(b, s, R0, R1, 0.05, 0.11, 0.06);
    blade(b, s, R1, R2, 0.11, 0.07, 0.035);
  }
}
function blade(b, s, r0, r1, w0, w1, tw) {
  // a thin twisted board from radius r0 to r1 along s * y; width w along x; twist tw in z
  HX[0] = -w0; HX[1] = s * r0; HX[2] = -tw * s - 0.015; HX[3] = w0; HX[4] = s * r0; HX[5] = tw * s - 0.015;
  HX[6] = w0; HX[7] = s * r0; HX[8] = tw * s + 0.015; HX[9] = -w0; HX[10] = s * r0; HX[11] = -tw * s + 0.015;
  HX[12] = -w1; HX[13] = s * r1; HX[14] = -tw * 0.6 * s - 0.012; HX[15] = w1; HX[16] = s * r1; HX[17] = tw * 0.6 * s - 0.012;
  HX[18] = w1; HX[19] = s * r1; HX[20] = tw * 0.6 * s + 0.012; HX[21] = -w1; HX[22] = s * r1; HX[23] = -tw * 0.6 * s + 0.012;
  b.hexa(HX, true);
}

// ---------------------------------------------------------------------------- the camp

function camera(b, x, z, yaw) {
  b.push(); b.at(x, 0, z, yaw);
  b.color(0.2, 0.15, 0.1).surface(SURF.WOOD).ao(1);
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3 + 0.3;
    b.beam(Math.cos(a) * 0.55, 0.0, Math.sin(a) * 0.55, 0, 1.32, 0, 0.022, 0.018, 4);
  }
  b.color(0.09, 0.075, 0.06);
  b.box(0, 1.5, 0, 0.17, 0.17, 0.2);
  b.color(0.05, 0.045, 0.045);
  b.box(0, 1.5, 0.3, 0.13, 0.13, 0.12); // bellows
  b.color(0.25, 0.2, 0.12);
  b.push(); b.translate(0, 1.5, 0.43); b.rotateX(Math.PI / 2); b.cylinder(0.05, 0.06, 8); b.pop();
  b.pop();
}

function camp(b, seed) {
  // sand: low hummocks, a flat strip for the flight, the dune behind the sheds
  b.timeless().surface(SURF.EARTH).ao(1);
  b.heightfield(-88, -118, 46, 118, 38, 66, (x, z) => {
    if (!inSand(x, z)) { b.color(0.42, 0.37, 0.27).ao(0.9); return -0.45; }
    const y = sandY(x, z), d = dune(x, z);
    const n = noise3(x * 0.11, 5.5, z * 0.11);
    const k = 0.94 + 0.1 * n - 0.04 * Math.min(1, d / 6);
    b.color(0.52 * k, 0.45 * k, 0.32 * k).ao(0.9 + 0.1 * Math.min(1, y * 0.6 + 0.3));
    return y;
  });
  // marram on the hummocks and the dune (not on the strip)
  for (let i = 0; i < 150; i++) {
    const x = -80 + 120 * b.rand(), z = -110 + 220 * b.rand();
    if (!inSand(x, z) || Math.abs(x - FX) < 14) continue;
    if (x > -40 && x < -22 && z > 40 && z < 85) continue; // the sheds
    const y = sandY(x, z);
    if (y < 0.25 && b.rand() < 0.6) continue;
    tuft(b, x, y, z, 0.6 + 0.6 * b.rand());
  }

  // the launch rail: 2x4s on edge capped with a metal strip, on short blocks
  b.color(0.33, 0.25, 0.16).surface(SURF.WOOD).ao(0.95);
  const r0 = RZ0 + 1.5, r1 = RZ0 - RAIL;
  b.box(FX, 0.1, (r0 + r1) / 2, 0.045, 0.1, (r0 - r1) / 2, false);
  for (let z = r1; z <= r0; z += 3) b.box(FX, 0.03, z, 0.35, 0.04, 0.12, false);
  b.color(0.16, 0.16, 0.17).surface(SURF.PLAIN);
  b.box(FX, 0.205, (r0 + r1) / 2, 0.03, 0.008, (r0 - r1) / 2, false);
  // the bench at the start of the rail the right wing tip rests on
  b.color(0.3, 0.23, 0.15).surface(SURF.WOOD);
  b.box(FX + 8.3, 0.35, RZ0 + 0.4, 0.5, 0.05, 0.25);
  for (const dx of [-0.4, 0.4]) b.box(FX + 8.3 + dx, 0.15, RZ0 + 0.4, 0.04, 0.15, 0.2, false);

  // hangar (1903) and the living shed (1901), side by side behind the rail start
  b.push(); b.translate(-8, 0, -11);
  shed(b, -22, 69, 5, 13.4, 2.5, 1.0);
  shed(b, -23, 86.5, 4.9, 7.6, 2.4, 0.9);
  // the hangar's end doors hinged at the top and propped open as an awning, dark inside
  b.color(0.035, 0.03, 0.028).surface(SURF.PLAIN).ao(0.3);
  b.box(-22, 1.2, 62.28, 2.2, 1.2, 0.03, false);
  b.color(0.34, 0.28, 0.21).surface(SURF.WOOD).ao(0.9);
  b.push(); b.translate(-22, 2.45, 62.3); b.rotateX(1.25); b.box(0, -1.15, -0.03, 2.3, 1.15, 0.035); b.pop();
  for (const sx of [-1.9, 1.9]) b.beam(-22 + sx, 0, 61.6 - 1.9, -22 + sx, 2.45 + 0.75, 62.3 - 2.1, 0.035, 0.035, 4, false);
  // living shed: a door, a window, a stovepipe
  b.color(0.05, 0.045, 0.04).surface(SURF.PLAIN).ao(0.5);
  b.box(-25.47, 1.0, 87.5, 0.03, 1.0, 0.45, false);
  b.box(-25.47, 1.45, 84.6, 0.03, 0.35, 0.45, false);
  b.color(0.12, 0.11, 0.1).ao(1);
  b.beam(-21.8, 2.9, 85, -21.8, 4.4, 85, 0.09, 0.09, 6);
  // lumber, a crate, a keg by the hangar
  b.color(0.38, 0.3, 0.2).surface(SURF.WOOD).ao(0.85);
  b.box(-26.4, 0.2, 72, 0.6, 0.2, 2.4, false);
  b.box(-18.6, 0.35, 65.5, 0.45, 0.35, 0.45, false);
  b.color(0.25, 0.18, 0.11);
  b.push(); b.translate(-18.4, 0, 67.2); b.cylinder(0.3, 0.75, 10); b.pop();
  b.pop();

  // anemometer mast: a guyed pole with a cross-arm vane (the cups are rig 4)
  const [mx, mh, mz] = MAST;
  b.color(0.3, 0.24, 0.17).surface(SURF.WOOD).ao(1);
  b.beam(mx, -0.3, mz, mx, mh, mz, 0.08, 0.05, 6);
  b.beam(mx, mh - 0.6, mz, mx + 1.3, mh - 0.6, mz, 0.03, 0.03, 4); // vane arm
  b.color(0.5, 0.47, 0.4).surface(SURF.PLAIN);
  slab(b, mx + 1.1, mx + 1.9, mz - 0.02, mz + 0.02, mh - 0.95, mh - 0.95, mh - 0.95, mh - 0.95, 0.7);
  b.color(0.15, 0.14, 0.13);
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3 + 0.5;
    b.beam(mx, mh - 1.2, mz, mx + Math.cos(a) * 3.6, 0, mz + Math.sin(a) * 3.6, 0.008, 0.008, 3, false);
  }

  // the camera by the end of the rail, aimed along the take-off
  camera(b, FX - 13, RZ0 - RAIL - 4, 0.75);

  // onlookers in dark coats (the lifesaving station men and a boy), standing still
  b.color(0.075, 0.07, 0.075).surface(SURF.HIDE).ao(1);
  const O = [FX - 12.5, RZ0 + 3, 1.9, FX - 13.8, RZ0 + 4.4, 1.7, FX - 14.6, RZ0 + 2.2, 1.8,
    FX - 11.4, RZ0 + 6.5, 2.2, FX - 16, RZ0 + 7, 1.6];
  for (let i = 0; i < O.length; i += 3) {
    b.push(); b.at(O[i], 0, O[i + 1], O[i + 2]); b.human(POSE.STAND, i === 12 ? 1.45 : 1.72 + 0.08 * b.rand(), seed + i); b.pop();
  }
  // readying (built 0): one man at the propeller, one at the right wing tip; they step
  // back as built rises (the brother runs the wing tip, then stands watching)
  b.vanish(0.03, 0.08, MOTION.POP, 0, BY.BUILT);
  b.push(); b.at(FX + 4.6, 0, RZ0 - 3.0, 0.2); b.human(POSE.KNEEL, 1.75, seed + 31); b.pop();
  b.push(); b.at(FX + 9.8, 0, RZ0 + 0.2, -1.4); b.human(POSE.STAND, 1.78, seed + 32); b.pop();
  b.timeless().appear(0.03, 0.08, MOTION.POP, 0, BY.BUILT);
  b.color(0.075, 0.07, 0.075).surface(SURF.HIDE).ao(1);
  b.push(); b.at(FX + 10.5, 0, RZ0 - 12, -2.6); b.human(POSE.STAND, 1.78, seed + 32); b.pop();
  b.timeless();
}

// ---------------------------------------------------------------------------- flight

// The Flyer's pose el seconds into the cycle -> POSE6; returns 1 while the engine runs.
function poseAt(el) {
  let s = 0, y = RAIL_Y, pitch = 0, roll = 0, wob = 0, run = 1, x = FX;
  if (el < T_HOLD) { s = 0; }
  else if (el < T_HOLD + T_ROLL) {
    const u = (el - T_HOLD) / T_ROLL;
    s = RAIL * u * u;
    roll = 0.01 * Math.sin(el * 9);
  } else if (el < T_HOLD + T_ROLL + T_FLY) {
    const q = (el - T_HOLD - T_ROLL) / T_FLY;
    s = RAIL + q * L;
    y = altAt(q);
    pitch = -Math.atan2(altAt(Math.min(1, q + 0.005)) - altAt(Math.max(0, q - 0.005)), 0.01 * L);
    const lift = ease(seg(q, 0, 0.1)) * (1 - ease(seg(q, 0.9, 1)));
    pitch += lift * 0.045 * Math.sin(el * 1.9);
    roll = lift * (0.07 * Math.sin(el * 1.25 + 0.6) + 0.025 * Math.sin(el * 3.1));
    wob = lift * 0.035 * Math.sin(el * 0.8 + 1.1);
    x = FX + lift * 1.4 * Math.sin(q * TAU * 0.9 + 0.4);
  } else if (el < T_HOLD + T_ROLL + T_FLY + T_SLIDE) {
    const u = (el - T_HOLD - T_ROLL - T_FLY) / T_SLIDE;
    s = RAIL + L + SLIDE * (1 - (1 - u) * (1 - u));
    y = 0.03; pitch = 0.035 * (1 - u); roll = -0.015 * (1 - u);
    run = u < 0.5 ? 1 : 0;
  } else if (el < T_LAND + T_REST) {
    s = S_END; y = 0.03; pitch = 0.0; roll = -0.012; run = 0;
  } else { // carried back, lifted off its skids, set down on the rail truck at the end
    const u = (el - T_LAND - T_REST) / T_BACK, lift = ease(seg(u, 0, 0.06)) * (1 - ease(seg(u, 0.93, 1)));
    s = S_END * (1 - ease(u));
    y = 0.03 + (RAIL_Y - 0.03) * ease(seg(u, 0.9, 1)) + 0.5 * lift;
    pitch = 0.02 * lift * Math.sin(el * 6.1); roll = 0.025 * lift * Math.sin(el * 7.3); run = 0;
  }
  POSE6[0] = x; POSE6[1] = y; POSE6[2] = RZ0 - s; POSE6[3] = pitch; POSE6[4] = roll; POSE6[5] = wob;
  return run;
}
// Height of the skids above the sand over the flight, q = 0..1: off the rail, up to ~5 m,
// undulating (the first flights pitched up and down), down onto the skids.
function altAt(q) {
  const up = ease(seg(q, 0, 0.22)), down = 1 - ease(seg(q, 0.78, 1));
  const h = 6.3 * up * down + 1.5 * Math.sin(q * Math.PI * 3.2 + 0.3) * up * down * up;
  return RAIL_Y * (1 - ease(seg(q, 0, 0.05))) + Math.max(0, h) + 0.03 * ease(seg(q, 0.5, 1));
}

// Place a propeller (rig k) at hub (hx, hy, hz) of the Flyer posed at (x, y, z, yaw, pitch, roll).
function prop(a, k, hx, x, y, z, yaw, pitch, roll, ang) {
  const c = Math.cos(yaw), s = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const vx = hx * SC, vy = HUB_Y * SC, vz = HUB_Z * SC;
  const wx = (c * cr + s * sp * sr) * vx + (-c * sr + s * sp * cr) * vy + s * cp * vz;
  const wy = cp * sr * vx + cp * cr * vy - sp * vz;
  const wz = (-s * cr + c * sp * sr) * vx + (s * sr + c * sp * cr) * vy + c * cp * vz;
  a.set(k, x + wx, y + wy, z + wz, yaw, pitch, roll + ang, SC);
}

// ---------------------------------------------------------------------------- the module

export default {
  id: 'first-flight',
  name: 'First powered flight',
  caption: 'The Wright Flyer lifts off the sand at Kitty Hawk',
  year: 1903,
  radius: RADIUS,
  pad: PAD,
  roadOffset: ROAD_OFF,
  straddlesRoad: false,
  biome: 'coast',
  lights: [],
  reach: 200,
  approach: 520,
  detail: { at: [FX, 1.5, RZ0 - 1], from: [FX - 9, 3.2, RZ0 - 10] },
  strip: { at: [FX + 4, 2, 30], from: [-118, 8, -60], fov: 0.55 },
  // The event shot: low, from the road side ahead of the Flyer, so it comes on against the
  // sky (and the sea, on the sea side). animate() keeps it on the Flyer wherever it is.
  witness: {
    get at() { return WAT; },
    get dist() { return WIT[0]; },
    get az() { return WIT[1]; },
    get look() { return WIT[2]; },
    get height() { return WIT[3]; },
    fov: 0.5, drift: 0.06, range: 700,
  },
  // outlying dunes with marram, and the lifesaving station up the beach
  satellites: {
    count: [4, 6], near: 2, nearR: [170, 260], farR: [320, 700],
    centre: 0.2, spread: 4.4, minSep: 110, roadClear: 40,
    build(b, k, n, dist) {
      b.timeless();
      if (k === 0) {
        // Kill Devil Hills lifesaving station: shingled house with a lookout on the roof
        shed(b, 0, 0, 7, 10, 4.6, 2.2);
        b.color(0.36, 0.3, 0.22).surface(SURF.WOOD).ao(0.95);
        b.box(0, 7.3, 1.5, 1.2, 0.8, 1.2, false);
        b.color(0.12, 0.11, 0.105).surface(SURF.PLAIN);
        roofZ(b, -1.2, 1.2, 0.3, 2.7, 8.1, 0.7, 0.2);
        b.color(0.36, 0.3, 0.22).surface(SURF.WOOD);
        b.box(-6.5, 1.4, -2, 2.2, 1.6, 3, false); // boat house
        b.color(0.12, 0.11, 0.105).surface(SURF.PLAIN);
        roofZ(b, -8.7, -4.3, -5, 1, 3.0, 1.0, 0.25);
        return;
      }
      const R = 22 + 14 * b.rand(), H = 4 + 5 * b.rand() + dist / 200;
      b.surface(SURF.EARTH).ao(1);
      b.disc(R, 18, 5, (x, z) => {
        const r = Math.hypot(x, z * 1.3) / R, kk = Math.max(0, 1 - r * r);
        b.color(0.5, 0.435, 0.31).ao(0.88 + 0.12 * kk);
        return H * kk * kk * (1 + 0.15 * (noise3(x * 0.07, k, z * 0.07) - 0.5)) - 1.2;
      });
      for (let i = 0; i < 10; i++) {
        const a = b.rand() * TAU, r = R * (0.2 + 0.6 * b.rand()), x = Math.cos(a) * r, z = Math.sin(a) * r;
        const rr = Math.hypot(x, z * 1.3) / R, kk = Math.max(0, 1 - rr * rr);
        tuft(b, x, H * kk * kk - 1.2, z, 1.2);
      }
    },
  },

  build(b, built, decay, seed) {
    b.timeless();
    camp(b, seed);
    b.rig(1); flyer(b);
    b.rig(2); propeller(b);
    b.rig(3); propeller(b);
    // anemometer cups (rig 4)
    // the two carriers (rig 5): at the wing tips, facing +z (up the flight line to the rail)
    b.rig(5);
    b.color(0.075, 0.07, 0.075).surface(SURF.HIDE).ao(1);
    for (const sx of [-1, 1]) { b.push(); b.at(sx * TIP, 0, 0, 0); b.human(POSE.WALK, 1.76, seed + 50 + sx); b.pop(); }
    b.rig(4, false);
    b.color(0.16, 0.15, 0.14).surface(SURF.PLAIN).ao(1);
    for (let i = 0; i < 4; i++) {
      const a = i * TAU / 4;
      b.beam(0, 0, 0, Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, 0.012, 0.012, 3, false);
      b.push(); b.translate(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45); b.ellipsoid(0.08, 0.08, 0.08, 1); b.pop();
    }
    b.beam(0, -0.3, 0, 0, 0.05, 0, 0.02, 0.02, 4);
    b.rig(0);
    return b.counts();
  },

  animate(a) {
    const t = a.t;
    if (a.handle !== ST.h) { ST.h = a.handle; ST.t0 = a.built > 0.03 ? t - T_HOLD + 0.5 : -1; }
    let run = 0, el = -1;
    if (a.built <= 0.03) { ST.t0 = -1; poseAt(0); }
    else {
      if (ST.t0 < 0 || t < ST.t0) ST.t0 = t - T_HOLD + 1.2; // the moment: a short run-up, then away
      el = (t - ST.t0) % T_CYC;
      run = poseAt(el);
    }
    const x = POSE6[0], y = POSE6[1], z = POSE6[2], pitch = POSE6[3], roll = POSE6[4], yaw = Math.PI + POSE6[5];
    a.set(1, x, y, z, yaw, pitch, roll, SC);
    const ang = run ? t * SPIN : 0.35;
    prop(a, 2, -HUB_X, x, y, z, yaw, pitch, roll, -ang);
    prop(a, 3, HUB_X, x, y, z, yaw, pitch, roll, ang + 0.9);
    a.set(4, MAST[0], MAST[1] + 0.1, MAST[2], t * 5.5);
    // the carriers: by the Flyer at the rail, waiting at the landing spot through the run and
    // the flight (they move there while every eye is on the take-off), then carrying it back
    if (el < 0) a.show(5, false);
    else if (el < T_HOLD) a.set(5, FX, 0, RZ0, 0).show(5, true);
    else if (el < T_LAND + T_REST) a.set(5, FX, 0, RZ0 - S_END, 0).show(5, true);
    else a.set(5, x, 0, z, 0).show(5, true);
    // witness: on the Flyer, low, from ahead on the road side
    WAT[0] = x; WAT[1] = z - 2;
    WIT[0] = 30 + 0.6 * y;
    WIT[1] = -0.55;
    WIT[2] = y + 1.6;
    WIT[3] = y + 2.6;
  },
};
