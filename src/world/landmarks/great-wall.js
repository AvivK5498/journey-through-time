// The Great Wall (event 5, mountains, ~220 BCE): a crenellated wall riding the ridgelines
// beside the road. It comes down off the mountains on the approach side to a fortified pass
// gate on the valley floor next to the road (the road runs beside the gate, never through
// it), then climbs the ridge on the far side; at both ends it runs over the back of a peak
// and out of sight. Square watchtowers stand on the crests; distant beacon towers with
// fires and smoke (satellites, on the real ground) carry the line across the country.
//
// Terrain: build() has no access to the game's ground, and the pad (140 m) is flat. So the
// ridges the wall rides are sculpted here: a height field around the wall's own path, coloured
// like the mountain biome's meadow, dry turf and blue-grey rock, whose flanks run below y = 0
// so they meet the real ground; it fades down to -25 m toward the radius, where the real
// mountains take over. The wall follows that field exactly (its crest is the path's height).
//
// built (clock 108-118): sections rise from the gate outward, a granite footing then the
// rammed-earth and brick body (CLIP), merlons last; bamboo scaffolds, earth ramps, baskets and
// a few figures by the sections near the gate while they go up; the gate platform first, its
// gate tower late; watchtowers complete last (0.66-0.97).
// decay (0 -> 0.35 over clock 200-285): merlons drop away (more of them far from the gate),
// a few stretches lose their upper body down to the footing with rubble at their feet, one
// tower loses its upper storey, shrubs grow out of the walkway; the beacons go out early.

import { SURF, POSE, FLICKER, MOTION, BY, fbm3, pathAt } from './kit.js';

const CLIP = MOTION.CLIP, RISE = MOTION.RISE, POP = MOTION.POP, SCALE = MOTION.SCALE, GROW = MOTION.GROW;

// ---- the wall's path: x, crest height, z (landmark-local), from the +z end (behind the
// approaching car) through the gate (-100, 0) to the -z end. The crest climbs and dips.
const CTRL = [
  205, 20, 245,
  160, 48, 228,
  118, 64, 200, // peak
  82, 42, 168, // saddle
  45, 50, 135,
  10, 30, 100,
  -40, 12, 55,
  -78, 3, 20,
  -100, 0, 0, // the pass gate
  -80, 3, -22,
  -45, 14, -55,
  -5, 34, -88,
  35, 56, -112, // peak
  70, 38, -140, // saddle
  105, 60, -175,
  140, 70, -205, // high peak
  190, 40, -240,
];
const GATE_X = -100, GATE_Z = 0, GATE_HL = 12.5; // gate platform half length along the wall
const TOWERS = [160, 228, 118, 200, 45, 135, -40, 55, -45, -55, 35, -112, 105, -175, 150, -212];

const STEP = 3; // m between wall samples
const MAXP = 400;
const PX = new Float64Array(MAXP), PY = new Float64Array(MAXP), PZ = new Float64Array(MAXP);
const PC = new Float64Array(MAXP), PS = new Float64Array(MAXP), PTX = new Float64Array(MAXP), PTZ = new Float64Array(MAXP);
let PN = 0, SG = 0, SMAX = 1;

function ss(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function fadeR(h, r) { const t = ss(225, 324, r); return h + (-25 - h) * t; }

function ensurePath() {
  if (PN) return;
  const out = new Float64Array(5);
  let L = 0;
  for (let i = 0; i < CTRL.length / 3 - 1; i++) {
    const a = i * 3, b = a + 3;
    L += Math.hypot(CTRL[b] - CTRL[a], CTRL[b + 1] - CTRL[a + 1], CTRL[b + 2] - CTRL[a + 2]);
  }
  const n = Math.min(MAXP - 1, Math.round(L / STEP));
  for (let k = 0; k <= n; k++) {
    pathAt(CTRL, k / n, out);
    PX[k] = out[0]; PY[k] = out[1]; PZ[k] = out[2];
  }
  PN = n + 1;
  PS[0] = 0;
  let gd = 1e9;
  for (let k = 0; k < PN; k++) {
    if (k) PS[k] = PS[k - 1] + Math.hypot(PX[k] - PX[k - 1], PZ[k] - PZ[k - 1]);
    const k0 = Math.max(0, k - 1), k1 = Math.min(PN - 1, k + 1);
    let tx = PX[k1] - PX[k0], tz = PZ[k1] - PZ[k0];
    const l = Math.hypot(tx, tz) || 1;
    PTX[k] = tx / l; PTZ[k] = tz / l;
    PC[k] = fadeR(PY[k], Math.hypot(PX[k], PZ[k]));
    const d = Math.hypot(PX[k] - GATE_X, PZ[k] - GATE_Z);
    if (d < gd) { gd = d; SG = k; }
  }
  SMAX = Math.max(PS[SG], PS[PN - 1] - PS[SG]);
}

// ---- sculpted ridges: a height field around the path (cached once; deterministic).
const GX0 = -125, GZ0 = -265, CELL = 5, NXC = 68, NZC = 106, GW = NXC + 1;
const HG = new Float32Array(GW * (NZC + 1));
let HREADY = false;

function ridgeAt(x, z) {
  let best = 1e18, bc = 0;
  for (let i = 0; i < PN - 1; i++) {
    const ax = PX[i], az = PZ[i], dx = PX[i + 1] - ax, dz = PZ[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - x, ez = az + dz * t - z, d2 = ex * ex + ez * ez;
    if (d2 < best) { best = d2; bc = PY[i] + (PY[i + 1] - PY[i]) * t; }
  }
  const d = Math.sqrt(best);
  let h = bc + 2.1 - 0.42 * Math.sqrt(best + 25) - 0.0013 * best;
  // the mountain mass behind, rising away from the road, joins the two arms
  const back = 58 * ss(-40, 190, x) * (0.75 + 0.5 * fbm3(z / 120, 1.3, x / 120, 2));
  h = Math.max(h, Math.min(back, bc - 0.8 + 0.25 * d)); // never above the crest at the wall
  h += (fbm3(x / 85, 3.1, z / 85, 3) - 0.45) * 30 * ss(12, 70, d);
  h -= 35 * ss(-60, -118, x); // nothing rises toward the road
  h = fadeR(h, Math.hypot(x, z));
  return h > 0 ? h - 0.5 : Math.max(-40, h * 2 - 0.5); // the foot sinks a little faster below the ground
}
function ensureGrid() {
  if (HREADY) return;
  for (let j = 0; j <= NZC; j++) for (let i = 0; i <= NXC; i++) HG[j * GW + i] = ridgeAt(GX0 + i * CELL, GZ0 + j * CELL);
  HREADY = true;
}
// The sculpted ground under (x, z) (bilinear on the grid); the flat pad inside 140 m.
function groundY(x, z) {
  const fx = (x - GX0) / CELL, fz = (z - GZ0) / CELL;
  let h = -30;
  if (fx >= 0 && fz >= 0 && fx < NXC && fz < NZC) {
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, o = j * GW + i;
    h = (HG[o] * (1 - u) + HG[o + 1] * u) * (1 - v) + (HG[o + GW] * (1 - u) + HG[o + GW + 1] * u) * v;
  }
  if (x * x + z * z < 140 * 140 && h < 0) h = 0;
  return h;
}

// ---- wall cross-sections (r: across, + = away from the road; y above the crest)
// lower: granite footing up to 2.5 m; upper: body, outer crenellated parapet (road side),
// walkway, low inner parapet. Listed clockwise in (r, y): outward normal of an edge is (-dy, dr).
const LOW_R = [-3.5, -3.22, 3.22, 3.5], LOW_Y = [-3.2, 2.5, 2.5, -3.2];
const UP_R = [-3.22, -3.0, -2.5, -2.5, 2.6, 2.6, 3.0, 3.22], UP_Y = [2.5, 7.0, 7.0, 6.0, 6.0, 6.9, 6.9, 2.5];
const Q = new Float64Array(12);

function strip(b, i0, i1, R, Y, cols) {
  const n = R.length;
  for (let k = 0; k < n - 1; k++) {
    const c = cols[k];
    for (let i = i0; i < i1; i++) {
      const j = i + 1;
      // corners A (i, k), B (i, k+1), C (j, k+1), D (j, k)
      const rxi = -PTZ[i], rzi = PTX[i], rxj = -PTZ[j], rzj = PTX[j];
      Q[0] = PX[i] + rxi * R[k]; Q[1] = PC[i] + Y[k]; Q[2] = PZ[i] + rzi * R[k];
      Q[3] = PX[i] + rxi * R[k + 1]; Q[4] = PC[i] + Y[k + 1]; Q[5] = PZ[i] + rzi * R[k + 1];
      Q[6] = PX[j] + rxj * R[k + 1]; Q[7] = PC[j] + Y[k + 1]; Q[8] = PZ[j] + rzj * R[k + 1];
      Q[9] = PX[j] + rxj * R[k]; Q[10] = PC[j] + Y[k]; Q[11] = PZ[j] + rzj * R[k];
      const ux = Q[6] - Q[0], uy = Q[7] - Q[1], uz = Q[8] - Q[2], vx = Q[9] - Q[3], vy = Q[10] - Q[4], vz = Q[11] - Q[5];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const er = R[k + 1] - R[k], ey = Y[k + 1] - Y[k];
      const hr = -ey, hy = er; // outward in (r, y)
      const hx = rxi * hr, hz = rzi * hr;
      if (nx * hx + ny * hy + nz * hz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      // colour: darker toward the foot of tall faces
      const gA = Y[k] < Y[k + 1] - 1 ? c[3] : 1, gB = Y[k + 1] < Y[k] - 1 ? c[3] : 1;
      b.color(c[0] * gA, c[1] * gA, c[2] * gA);
      const a = b.vertex(Q[0], Q[1], Q[2], nx, ny, nz), d = b.vertex(Q[9], Q[10], Q[11], nx, ny, nz);
      b.color(c[0] * gB, c[1] * gB, c[2] * gB);
      const bb = b.vertex(Q[3], Q[4], Q[5], nx, ny, nz), cc = b.vertex(Q[6], Q[7], Q[8], nx, ny, nz);
      b.quad(a, bb, cc, d);
    }
  }
}
// End cap at sample i (dir -1: start of a section, +1: end): quads in (r, y) above the crest.
const CAP_LOW = [-3.5, -3.2, 3.5, -3.2, 3.22, 2.5, -3.22, 2.5];
const CAP_UP = [-3.22, 2.5, 3.22, 2.5, 3.045, 6.0, -3.049, 6.0, -3.049, 6.0, -2.5, 6.0, -2.5, 7.0, -3.0, 7.0, 2.6, 6.0, 3.045, 6.0, 3.0, 6.9, 2.6, 6.9];
function cap(b, i, dir, P) {
  const rx = -PTZ[i], rz = PTX[i], nx = PTX[i] * dir, nz = PTZ[i] * dir;
  for (let q = 0; q < P.length; q += 8) {
    const v0 = b.vertex(PX[i] + rx * P[q], PC[i] + P[q + 1], PZ[i] + rz * P[q], nx, 0, nz);
    const v1 = b.vertex(PX[i] + rx * P[q + 2], PC[i] + P[q + 3], PZ[i] + rz * P[q + 2], nx, 0, nz);
    const v2 = b.vertex(PX[i] + rx * P[q + 4], PC[i] + P[q + 5], PZ[i] + rz * P[q + 4], nx, 0, nz);
    const v3 = b.vertex(PX[i] + rx * P[q + 6], PC[i] + P[q + 7], PZ[i] + rz * P[q + 6], nx, 0, nz);
    b.quad(v0, v1, v2, v3);
  }
}

// palette (linear albedo): weathered grey-brown brick and blue-grey granite of the mountains
const C_FOOT = [0.2, 0.2, 0.205, 0.72];
const C_BODY = [0.27, 0.245, 0.205, 0.78];
const C_PAR = [0.29, 0.265, 0.225, 1];
const C_WALK = [0.2, 0.175, 0.14, 1];
const COLS_LOW = [C_FOOT, C_FOOT, C_FOOT];
const COLS_UP = [C_BODY, C_PAR, C_PAR, C_WALK, C_PAR, C_PAR, C_BODY];

function hexWorld(b, P) { b.hexa(P, false); }
const HX = new Float64Array(24);

// A square watchtower centred on sample k: footing, lower body to the walkway, upper storey
// with dark windows, crenellated top. tt: built time; ruin: upper storey falls in the decay.
function tower(b, k, tt, ruin) {
  const yaw = Math.atan2(PTX[k], PTZ[k]);
  let cmin = 1e9, cmax = -1e9;
  for (let q = Math.max(0, k - 2); q <= Math.min(PN - 1, k + 2); q++) { cmin = Math.min(cmin, PC[q]); cmax = Math.max(cmax, PC[q]); }
  const base = cmin - 3.5, walk = cmax + 6.2, top = walk + 5.6;
  b.push(); b.at(PX[k], 0, PZ[k], yaw);
  b.timeless().pivot(0, base, 0).reach(walk - base).appear(tt, tt + 0.03, CLIP, 0, BY.BUILT);
  b.color(0.24, 0.22, 0.19).surface(SURF.STONE).ao(0.85);
  b.push(); b.translate(0, base, 0); b.block(4.8, 4.8, 4.5, 4.5, walk - base); b.pop();
  // upper storey
  b.timeless().pivot(0, walk, 0).reach(top - walk + 0.1).appear(tt + 0.03, tt + 0.06, CLIP, 0, BY.BUILT);
  if (ruin) b.vanish(0.2, 0.27, CLIP, 0, BY.DECAY);
  b.color(0.28, 0.255, 0.215).surface(SURF.STONE).ao(1);
  b.push(); b.translate(0, walk - 0.05, 0); b.block(4.5, 4.5, 4.4, 4.4, top - walk + 0.05); b.pop();
  b.color(0.035, 0.03, 0.028).surface(SURF.PLAIN).ao(0.4);
  for (let s = 0; s < 4; s++) {
    b.push(); b.rotateY(s * Math.PI / 2);
    for (let w = -1; w <= 1; w += 2) b.box(w * 1.8, walk + 2.6, 4.46, 0.55, 1.0, 0.1);
    b.pop();
  }
  // doorways where the walkway enters
  b.box(0, walk + 1.0, 4.58, 0.8, 1.2, 0.1); b.box(0, walk + 1.0, -4.58, 0.8, 1.2, 0.1);
  // crenellations
  b.color(0.3, 0.275, 0.235).surface(SURF.STONE).ao(1);
  for (let s = 0; s < 4; s++) {
    b.push(); b.rotateY(s * Math.PI / 2);
    for (let m = -1; m <= 1; m++) {
      const td = 0.03 + 0.3 * b.rand(), lose = b.rand() < 0.4;
      b.timeless().appear(tt + 0.06, tt + 0.075, RISE, 1.3, BY.BUILT);
      if (lose || ruin) b.vanish(ruin ? 0.19 : td, (ruin ? 0.19 : td) + 0.015, RISE, 1.3, BY.DECAY);
      b.box(m * 3.0, top + 0.6, 4.1, 0.75, 0.6, 0.28, false);
    }
    b.pop();
  }
  b.pop();
  if (ruin) { // rubble from the fallen storey
    b.timeless().appear(0.2, 0.26, RISE, 3, BY.DECAY);
    b.color(0.25, 0.23, 0.2).surface(SURF.STONE).ao(0.85);
    const rx = -PTZ[k], rz = PTX[k];
    for (let s = -1; s <= 1; s += 2) {
      const x = PX[k] + rx * 7 * s, z = PZ[k] + rz * 7 * s;
      b.push(); b.translate(x, groundY(x, z) - 0.6, z); b.rock(3.2, 1.8, 3.6, 3, 0.35, 77 + s, 3, 0.5); b.pop();
    }
  }
}

// The fortified pass gate on the valley floor: a stone platform pierced by an arched gateway,
// crenellated, with a two-tier gate tower (red walls and columns, dark tiled hipped roofs).
function gate(b) {
  const k = SG, yaw = Math.atan2(PTX[k], PTZ[k]);
  b.push(); b.at(PX[k], 0, PZ[k], yaw);
  b.timeless().pivot(0, -1, 0).reach(11).appear(0.02, 0.22, CLIP, 0, BY.BUILT);
  b.color(0.27, 0.26, 0.245).surface(SURF.STONE).ao(0.85);
  b.push(); b.translate(0, -1, 0); b.block(8.4, GATE_HL, 8.0, GATE_HL - 0.4, 4); b.pop();
  b.color(0.27, 0.245, 0.205).surface(SURF.STONE).ao(1);
  b.push(); b.translate(0, 3, 0); b.block(8.0, GATE_HL - 0.4, 7.7, GATE_HL - 0.7, 7); b.pop();
  // arched gateway on both faces (dark recess panels)
  b.color(0.03, 0.026, 0.024).surface(SURF.PLAIN).ao(0.3);
  for (let s = -1; s <= 1; s += 2) {
    b.box(s * 8.25, 2.2, 0, 0.25, 2.4, 2.4);
    b.push(); b.translate(s * 8.25 - 0.25, 4.6, 0); b.rotateZ(-Math.PI / 2); b.cylinder(2.4, 0.5, 14); b.pop();
  }
  // crenellated parapet round the top
  b.color(0.3, 0.275, 0.235).surface(SURF.STONE).ao(1);
  for (let s = 0; s < 2; s++) {
    for (let m = 0; m < 10; m++) {
      const z = -GATE_HL + 1.6 + m * ((GATE_HL * 2 - 3.2) / 9);
      for (let e = -1; e <= 1; e += 2) {
        b.timeless().appear(0.22, 0.26, RISE, 1.3, BY.BUILT);
        if (b.rand() < 0.25) b.vanish(0.05 + 0.28 * b.rand(), 0.36, RISE, 1.3, BY.DECAY);
        if (s === 0) b.box(e * 7.45, 10.6, z, 0.25, 0.65, 0.75, false);
        else if (m < 6) b.box(-5.6 + m * 2.24, 10.6, e * (GATE_HL - 0.95), 0.75, 0.65, 0.25, false);
      }
    }
  }
  // gate tower
  b.timeless().pivot(0, 9.95, 0).reach(11.6).appear(0.84, 0.97, CLIP, 0, BY.BUILT);
  b.color(0.2, 0.19, 0.17).surface(SURF.STONE).ao(0.9);
  b.push(); b.translate(0, 9.95, 0); b.block(4.6, 8.2, 4.6, 8.2, 0.45); b.pop();
  b.color(0.33, 0.075, 0.05).surface(SURF.PLASTER).ao(0.9); // red walls
  b.push(); b.translate(0, 10.4, 0); b.block(3.6, 7.0, 3.6, 7.0, 4.2); b.pop();
  b.color(0.36, 0.07, 0.045).surface(SURF.WOOD).ao(0.8); // columns of the gallery
  for (let c = -3; c <= 3; c++) for (let e = -1; e <= 1; e += 2) b.beam(e * 4.25, 10.4, c * 2.55, e * 4.25, 14.6, c * 2.55, 0.18, 0.17, 6, false);
  // lower roof: eaves skirt
  b.color(0.075, 0.08, 0.078).surface(SURF.STONE).ao(0.8);
  HXset(-6.0, 14.4, -10.2, 6.0, 10.2, -3.4, 16.4, -7.6, 3.4, 7.6);
  b.hexa(HX, true);
  // upper storey and hipped roof
  b.color(0.33, 0.075, 0.05).surface(SURF.PLASTER).ao(0.9);
  b.push(); b.translate(0, 16.3, 0); b.block(3.0, 6.6, 3.0, 6.6, 1.8); b.pop();
  b.color(0.075, 0.08, 0.078).surface(SURF.STONE).ao(0.85);
  HXset(-5.0, 18.0, -9.0, 5.0, 9.0, -0.35, 21.4, -5.2, 0.35, 5.2);
  b.hexa(HX, true);
  b.color(0.1, 0.1, 0.095).ao(1); // ridge with raised ends
  b.box(0, 21.55, 0, 0.3, 0.25, 5.6);
  b.box(0, 21.9, 5.4, 0.3, 0.55, 0.3); b.box(0, 21.9, -5.4, 0.3, 0.55, 0.3);
  b.pop();
}
function HXset(x0, y0, z0, x1, z1, tx0, ty, tz0, tx1, tz1) {
  // bottom ring at y0 (x0..x1, z0..z1), top ring at ty (tx0..tx1, tz0..tz1)
  const P = HX;
  P[0] = x0; P[1] = y0; P[2] = z0; P[3] = x1; P[4] = y0; P[5] = z0; P[6] = x1; P[7] = y0; P[8] = z1; P[9] = x0; P[10] = y0; P[11] = z1;
  P[12] = tx0; P[13] = ty; P[14] = tz0; P[15] = tx1; P[16] = ty; P[17] = tz0; P[18] = tx1; P[19] = ty; P[20] = tz1; P[21] = tx0; P[22] = ty; P[23] = tz1;
}

// Figures in dark hemp clothing.
function figure(b, x, z, yaw, pose, sd) {
  b.color(0.1, 0.085, 0.07).surface(SURF.HIDE).ao(1);
  b.push(); b.at(x, groundY(x, z), z, yaw); b.human(pose, 1.62 + 0.1 * ((sd * 37) % 3) / 3, sd); b.pop();
}

export default {
  id: 'great-wall',
  name: 'Great Wall',
  caption: 'The Qin wall rides the ridges',
  year: -220,
  radius: 330,
  pad: 140,
  roadOffset: 150, // road centre line at x = -150; the gate's road face is ~40 m from it
  straddlesRoad: false,
  biome: 'mountains',
  lights: [],
  approach: 700, cone: 0.55,
  detail: { at: [-100, 8, 0], from: [-140, 9, 34] },
  strip: { at: [0, 22, 0], from: [-300, 60, 230], fov: 0.75 },
  witness: { at: [-10, 0], look: 26, dist: 360, height: 70, az: 0.42, fov: 0.62, drift: 0.07, range: 1500 },

  satellites: {
    count: [8, 10], near: 0, farR: [420, 1600],
    centre: 0, spread: 3.0, minSep: 220, roadClear: 70, visible: 1,
    build(b, k, n, dist) {
      // Undo the companion's random yaw so the wall stubs run along the site's own line (local z).
      const a = Math.atan2(-b.m[2], b.m[0]);
      b.rotateY(-a);
      const s = 1 + dist / 1300, tb = 0.2 + 0.4 * k / n;
      b.scale(s, s, s);
      // beacon tower
      b.timeless().pivot(0, -4, 0).reach(17).appear(tb, tb + 0.12, CLIP, 0, BY.BUILT);
      b.color(0.25, 0.23, 0.2).surface(SURF.STONE).ao(0.9);
      b.push(); b.translate(0, -4, 0); b.block(3.6, 3.6, 3.0, 3.0, 15.5); b.pop();
      b.color(0.29, 0.265, 0.225);
      for (let q = 0; q < 4; q++) {
        b.push(); b.rotateY(q * Math.PI / 2);
        for (let m = -1; m <= 1; m += 2) b.box(m * 1.9, 12.1, 2.85, 0.55, 0.6, 0.22, false);
        b.pop();
      }
      // wall stubs running away along the line, sinking into the hillside at their ends
      b.timeless().pivot(0, -8, 0).reach(16).appear(tb + 0.05, tb + 0.2, CLIP, 0, BY.BUILT);
      b.color(0.25, 0.23, 0.195).surface(SURF.STONE).ao(0.9);
      for (let e = -1; e <= 1; e += 2) {
        for (let q = 0; q < 3; q++) {
          const z0 = e * (3 + q * 9), z1 = e * (3 + (q + 1) * 9), h0 = 6 - q * 2.6, h1 = 6 - (q + 1) * 2.6;
          HXset(-2.3, -8, Math.min(z0, z1), 2.3, Math.max(z0, z1), -2.1, 0, Math.min(z0, z1), 2.1, Math.max(z0, z1));
          // top ring follows the descending crest
          const zl = Math.min(z0, z1) === z0 ? h0 : h1, zh = Math.min(z0, z1) === z0 ? h1 : h0;
          HX[13] = zl; HX[16] = zl; HX[19] = zh; HX[22] = zh;
          b.hexa(HX, false);
        }
      }
      // the beacon fire on top, lit as the wall is finished, out early in the decay
      const tf = 0.62 + 0.25 * k / n, tv = 0.02 + 0.06 * k / n;
      b.timeless().pivot(0, 11.5, 0).appear(tf, tf + 0.06, GROW, 0, BY.BUILT).vanish(tv, tv + 0.04, GROW, 0, BY.DECAY);
      b.push(); b.translate(0, 11.5, 0);
      b.farFire(1.5 + dist / 900, 60, 1.1, 6);
      b.pop();
    },
  },

  *build(b, built, decay, seed) {
    ensurePath();
    ensureGrid();
    yield;

    // ---- the sculpted ridges (one surface: bedded rock, coloured meadow -> turf -> rock)
    const meadow = b.bio('ground'), turf = b.bio('groundAlt'), rock = b.bio('rock');
    b.timeless().surface(SURF.EARTH).ao(1);
    const base = b.nv;
    for (let j = 0; j <= NZC; j++) {
      for (let i = 0; i <= NXC; i++) {
        let x = GX0 + i * CELL, z = GZ0 + j * CELL;
        const o = j * GW + i, y = HG[o];
        const gx = (HG[j * GW + Math.min(NXC, i + 1)] - HG[j * GW + Math.max(0, i - 1)]) / (2 * CELL);
        const gz = (HG[Math.min(NZC, j + 1) * GW + i] - HG[Math.max(0, j - 1) * GW + i]) / (2 * CELL);
        const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
        const steep = ss(0.9, 0.62, ny), hi = ss(5, 60, y);
        const n = fbm3(x / 40, 7.7, z / 40, 2);
        const dry = Math.min(1, 0.15 + 0.55 * hi + 0.5 * (n - 0.5));
        let r = meadow[0] + (turf[0] - meadow[0]) * dry, g = meadow[1] + (turf[1] - meadow[1]) * dry, bl = meadow[2] + (turf[2] - meadow[2]) * dry;
        const rk = Math.min(1, steep * (0.85 + 0.4 * n));
        r += (rock[0] * 1.15 - r) * rk; g += (rock[1] * 1.15 - g) * rk; bl += (rock[2] * 1.15 - bl) * rk;
        b.color(r, g, bl).ao(0.82 + 0.18 * ss(-2, 20, y));
        const rr = Math.hypot(x, z);
        if (rr > 329) { x *= 329 / rr; z *= 329 / rr; } // never used by a triangle
        b.vertex(x, y, z, -gx, 1, -gz);
      }
    }
    for (let j = 0; j < NZC; j++) {
      for (let i = 0; i < NXC; i++) {
        const o = j * GW + i;
        let ok = true;
        for (let q = 0; q < 4 && ok; q++) {
          const x = GX0 + (i + (q & 1)) * CELL, z = GZ0 + (j + (q >> 1)) * CELL;
          if (x * x + z * z > 329 * 329) ok = false;
        }
        if (!ok) continue;
        if (Math.max(HG[o], HG[o + 1], HG[o + GW], HG[o + GW + 1]) < 0.05) continue;
        b.quad(base + o, base + o + 1, base + o + GW + 1, base + o + GW);
      }
    }
    yield;

    // ---- wall sections (up to 4 intervals each), outward from the gate
    const sections = []; // [i0, i1, t0, t1, collapse td or -1]
    let i = 0;
    while (i < PN - 1) {
      const mid = (PS[i] + PS[i + 1]) * 0.5;
      if (Math.abs(mid - PS[SG]) < GATE_HL - 0.5 || PC[i] < -9) { i++; continue; }
      let i1 = i + 1;
      while (i1 < PN - 1 && i1 - i < 4) {
        const m2 = (PS[i1] + PS[i1 + 1]) * 0.5;
        if (Math.abs(m2 - PS[SG]) < GATE_HL - 0.5 || PC[i1] < -9) break;
        i1++;
      }
      const frac = Math.abs((PS[i] + PS[i1]) * 0.5 - PS[SG]) / SMAX;
      const t0 = 0.03 + 0.5 * frac + 0.06 * b.rand();
      const td = frac > 0.25 && b.rand() < 0.3 ? 0.08 + 0.24 * b.rand() : -1;
      sections.push(i, i1, t0, t0 + 0.13, td, frac);
      i = i1;
    }
    const NS = sections.length / 6;
    for (let s = 0; s < NS; s++) {
      const i0 = sections[s * 6], i1 = sections[s * 6 + 1], t0 = sections[s * 6 + 2], t1 = sections[s * 6 + 3], td = sections[s * 6 + 4];
      let cmin = 1e9, cmax = -1e9;
      for (let q = i0; q <= i1; q++) { cmin = Math.min(cmin, PC[q]); cmax = Math.max(cmax, PC[q]); }
      const tm = t0 + (t1 - t0) * 0.45;
      // granite footing
      b.timeless().pivot(0, cmin - 3.2, 0).reach(cmax - cmin + 5.7).appear(t0, tm, CLIP, 0, BY.BUILT);
      b.surface(SURF.STONE).ao(0.9);
      strip(b, i0, i1, LOW_R, LOW_Y, COLS_LOW);
      b.color(C_FOOT[0], C_FOOT[1], C_FOOT[2]);
      cap(b, i0, -1, CAP_LOW); cap(b, i1, 1, CAP_LOW);
      // rammed-earth and brick body, parapets, walkway
      b.timeless().pivot(0, cmin + 2.5, 0).reach(cmax - cmin + 4.6).appear(tm, t1, CLIP, 0, BY.BUILT);
      if (td >= 0) b.vanish(td, td + 0.04, CLIP, 0, BY.DECAY);
      b.surface(SURF.STONE).ao(1);
      strip(b, i0, i1, UP_R, UP_Y, COLS_UP);
      b.color(C_BODY[0], C_BODY[1], C_BODY[2]);
      cap(b, i0, -1, CAP_UP); cap(b, i1, 1, CAP_UP);
      if (td >= 0) { // rubble at the foot of the broken stretch
        b.timeless().appear(td, td + 0.05, RISE, 2.5, BY.DECAY);
        b.color(0.25, 0.23, 0.2).surface(SURF.STONE).ao(0.85);
        const k = (i0 + i1) >> 1, rx = -PTZ[k], rz = PTX[k];
        for (let e = -1; e <= 1; e += 2) {
          const x = PX[k] + rx * 5.5 * e, z = PZ[k] + rz * 5.5 * e;
          b.push(); b.at(x, Math.min(groundY(x, z), PC[k]) - 0.5, z, Math.atan2(PTX[k], PTZ[k]));
          b.rock(2.6, 1.5, (i1 - i0) * 1.6, 3, 0.35, seed + s * 7 + e, 3, 0.5); b.pop();
        }
      }
    }
    yield;

    // ---- merlons on the road-side parapet, and shrubs on the walkway (decay)
    b.surface(SURF.STONE);
    for (let s = 0; s < NS; s++) {
      const i0 = sections[s * 6], i1 = sections[s * 6 + 1], t1 = sections[s * 6 + 3], td = sections[s * 6 + 4], frac = sections[s * 6 + 5];
      for (let q = i0; q < i1; q++) {
        const x = (PX[q] + PX[q + 1]) * 0.5, z = (PZ[q] + PZ[q + 1]) * 0.5, c = (PC[q] + PC[q + 1]) * 0.5;
        const tx = PTX[q] + PTX[q + 1], tz = PTZ[q] + PTZ[q + 1], yaw = Math.atan2(tx, tz);
        const lose = b.rand() < 0.2 + 0.65 * frac, tl = 0.02 + 0.32 * b.rand();
        b.timeless().appear(t1, t1 + 0.03, RISE, 1.3, BY.BUILT);
        if (td >= 0) b.vanish(td - 0.01, td, POP, 0, BY.DECAY);
        else if (lose) b.vanish(tl, tl + 0.015, RISE, 1.3, BY.DECAY);
        b.color(0.3, 0.275, 0.235).ao(1);
        b.push(); b.at(x, c + 6.9, z, yaw); b.box(-2.75, 0.65, 0, 0.26, 0.65, 0.78, false); b.pop();
        // shrubs: more of them far from the gate
        if (b.rand() < 0.08 + 0.3 * frac) {
          const off = (b.rand() - 0.5) * 3.4, rx = -tz, rz = tx, rl = Math.hypot(rx, rz) || 1;
          const sx = x + rx / rl * off, sz = z + rz / rl * off, sy = c + (td >= 0 ? 2.5 : 6.0);
          const ta = Math.max(td >= 0 ? td + 0.03 : 0.04, 0.04 + 0.28 * b.rand());
          b.timeless().pivot(sx, sy, sz).appear(ta, Math.min(0.35, ta + 0.06), SCALE, 0, BY.DECAY);
          const gg = 0.8 + 0.4 * b.rand();
          b.color(0.045 * gg, 0.085 * gg, 0.03 * gg).surface(SURF.THATCH).ao(0.9);
          b.push(); b.translate(sx, sy + 0.45, sz); b.ellipsoid(0.8 + 0.5 * b.rand(), 0.7, 0.8 + 0.5 * b.rand(), 2); b.pop();
          b.surface(SURF.STONE);
        }
      }
    }
    yield;

    // ---- the gate and the watchtowers (towers complete last)
    gate(b);
    const nt = TOWERS.length / 2;
    for (let t = 0; t < nt; t++) {
      let best = 1e18, k = 0;
      for (let q = 0; q < PN; q++) { const d = (PX[q] - TOWERS[t * 2]) ** 2 + (PZ[q] - TOWERS[t * 2 + 1]) ** 2; if (d < best) { best = d; k = q; } }
      const frac = Math.abs(PS[k] - PS[SG]) / SMAX;
      tower(b, k, 0.66 + 0.24 * frac, t === 6);
    }
    yield;

    // ---- the works: scaffolds, earth ramps, baskets and a few figures by the sections near the gate
    let figs = 0;
    for (let s = 0; s < NS; s++) {
      const i0 = sections[s * 6], i1 = sections[s * 6 + 1], t0 = sections[s * 6 + 2], t1 = sections[s * 6 + 3], frac = sections[s * 6 + 5];
      if (frac > 0.42 || i1 - i0 < 3) continue;
      const tv = Math.min(0.97, t1 + 0.03);
      b.timeless().appear(Math.max(0, t0 - 0.04), Math.max(0.004, t0 - 0.01), POP, 0, BY.BUILT).vanish(tv, tv + 0.01, POP, 0, BY.BUILT);
      // bamboo scaffold on the road side
      b.color(0.3, 0.25, 0.12).surface(SURF.WOOD).ao(1);
      for (let q = i0; q <= i1; q += 2) {
        const rx = -PTZ[q], rz = PTX[q], x = PX[q] - rx * 4.4, z = PZ[q] - rz * 4.4;
        b.beam(x, groundY(x, z) - 0.3, z, x, PC[q] + 8.6, z, 0.07, 0.06, 4, false);
      }
      for (let lv = 0; lv < 2; lv++) {
        const h = lv ? 5.6 : 2.6, qa = i0, qb = i1;
        const ax = PX[qa] + PTZ[qa] * 4.4, az = PZ[qa] - PTX[qa] * 4.4, bx = PX[qb] + PTZ[qb] * 4.4, bz = PZ[qb] - PTX[qb] * 4.4;
        b.beam(ax, PC[qa] + h, az, bx, PC[qb] + h, bz, 0.06, 0.06, 4, false);
      }
      if (s % 2 === 0) {
        // packed-earth ramp against the inner side
        const qa = i0 + 1, qb = i1 - 1;
        const ra = [-PTZ[qa], PTX[qa]], rb = [-PTZ[qb], PTX[qb]];
        const nax = PX[qa] + ra[0] * 3.4, naz = PZ[qa] + ra[1] * 3.4, fax = PX[qa] + ra[0] * 15, faz = PZ[qa] + ra[1] * 15;
        const nbx = PX[qb] + rb[0] * 3.4, nbz = PZ[qb] + rb[1] * 3.4, fbx = PX[qb] + rb[0] * 15, fbz = PZ[qb] + rb[1] * 15;
        const gfa = groundY(fax, faz), gfb = groundY(fbx, fbz);
        const P = HX;
        P[0] = nax; P[1] = PC[qa] - 3; P[2] = naz; P[3] = fax; P[4] = gfa - 2; P[5] = faz;
        P[6] = fbx; P[7] = gfb - 2; P[8] = fbz; P[9] = nbx; P[10] = PC[qb] - 3; P[11] = nbz;
        P[12] = nax; P[13] = PC[qa] + 5.2; P[14] = naz; P[15] = fax; P[16] = gfa + 0.15; P[17] = faz;
        P[18] = fbx; P[19] = gfb + 0.15; P[20] = fbz; P[21] = nbx; P[22] = PC[qb] + 5.2; P[23] = nbz;
        b.color(0.25, 0.19, 0.12).surface(SURF.EARTH).ao(0.95);
        hexWorld(b, P);
        // baskets of earth at the ramp foot
        b.color(0.26, 0.2, 0.1).surface(SURF.THATCH).ao(0.9);
        for (let q = 0; q < 3; q++) {
          const x = fax + ra[0] * (1.5 + q * 0.9) + PTX[qa] * (q - 1) * 1.1, z = faz + ra[1] * (1.5 + q * 0.9) + PTZ[qa] * (q - 1) * 1.1;
          b.push(); b.translate(x, groundY(x, z), z); b.cylinder(0.36, 0.45, 8); b.pop();
        }
        // figures: one hauling a basket up the ramp, one at the foot, one kneeling at the baskets
        if (figs < 9) {
          const yawUp = Math.atan2(-ra[0], -ra[1]);
          const mx = (nax + fax) * 0.5, mz = (naz + faz) * 0.5;
          b.color(0.1, 0.085, 0.07).surface(SURF.HIDE).ao(1);
          b.push(); b.at(mx, (PC[qa] + 5.2 + gfa) * 0.5 - 0.1, mz, yawUp); b.human(POSE.HAUL, 1.65, seed + s); b.pop();
          figure(b, fax + ra[0] * 2.5 - PTX[qa] * 2.5, faz + ra[1] * 2.5 - PTZ[qa] * 2.5, yawUp, POSE.STAND, seed + s + 40);
          figure(b, fax + ra[0] * 3.4 + PTX[qa] * 1.6, faz + ra[1] * 3.4 + PTZ[qa] * 1.6, yawUp + 1.2, POSE.KNEEL, seed + s + 80);
          figs += 3;
        }
      }
    }
    // an overseer and two guards by the gate while it goes up
    b.timeless().vanish(0.9, 0.93, POP, 0, BY.BUILT);
    const gx = PX[SG] + 14, gz = PZ[SG] - 16;
    figure(b, gx, gz, -2.2, POSE.STAND, seed + 200);
    figure(b, gx + 1.6, gz - 1.0, -2.0, POSE.STAND, seed + 201);
    figure(b, gx - 2.5, gz + 4, -2.8, POSE.KNEEL, seed + 202);
    b.timeless();
    return b.counts();
  },
};
