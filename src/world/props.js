// Roadside and landscape props for all seven biomes, and the junction signposts.
//   savannah:  acacias (leafy near LOD + far LOD), shrubs, boulders, termite mounds
//   ice:       dwarf shrubs, erratic boulders and rubble, mammoth herds
//   desert:    date palms along the river, scrub, rocks on the stony plain
//   forest:    broadleaf trees and spruce in stands with glades, undergrowth, mossy rocks
//   steppe:    a rare lone tree, low shrubs, scattered stones
//   mountains: spruce in the valleys, boulders and scree
//   coast:     stone pines (the acacia mesh in coast colours), scrub, rocks
//
// Placement is a per-frame compute pass over world-anchored grids around the camera (so
// props never move). Each candidate picks a biome by the local biome weights (so borders
// interleave naturally), then a kind from that biome's densities, kept off the road and the
// water. Survivors go to per-type instance lists: camera-culled lists for the main pass,
// near-shadow-box lists, and far-cascade lists (only on frames that re-render the cached far
// cascade). Drawn with drawIndexedIndirect. Signposts come from the graph on the CPU.
//
// Material ids (vertex attribute me.x; leaf cards encode their u in the fraction, me.y = v):
//  0 bark, 1 leaf mass, 2 rock, 3 termite clay, 4 wood, 5 sign face, 6 leaf-clump card,
//  7 palm frond card, 8 palm trunk, 9 dates, 10 mammoth fur, 11 ivory, 12 dead frond card.

import { gpu, tsw, addDrawable, addPrePass, mainPipeline, shadowPipeline } from '../gpu.js';
import { MAIN_HEADER, SHADOW_HEADER, FRAME_STRUCT } from '../shaders/common.js';
import { MeshBuilder, packMeshes, VERTEX_LAYOUT } from '../mesh.js';
import { WORLD_WGSL, world, groundAt, halfWidth, surfaceCurve, biomeExactAt, groundOut, groundInfo, siteData, straitAt, MAX_PADS } from './world.js';
import { exitIsBridge, exitAvailable } from './graph.js';
import { crossingKind } from './crossing.js';
import { smoothstep, NIO, noiseRiverDist, noiseRiverBank } from './noise.js';
import { camera } from '../camera.js';
import { state } from '../state.js';
import { initWeather } from './weather.js';
import {
  graph, MAX_NODES, nodeAlive, nodeIn, nodeExitCount, edgeAlive, edgeLen,
  exitAngle, exitRegion, frameAt, edgeJ0, pointAt, MAX_EDGES, edgeDrawEnd, edgeRegion,
} from './graph.js';

// --- meshes ---------------------------------------------------------------------------

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function lumpy(a, b) { return (x, y, z) => a * Math.sin(5.1 * x + 2.3 * z + 1.7) * Math.sin(4.3 * z - 1.9 * x + 0.4) + b * Math.sin(11.7 * x + 3.1) * Math.sin(9.3 * z + 1.3) * Math.cos(7.7 * y); }

const nrm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A leaf card: centre c, half axes ax / ay, shading normal n (local space, no transform).
function card(m, c, ax, ay, n, mat) {
  const P = (su, sv) => [c[0] + ax[0] * su + ay[0] * sv, c[1] + ax[1] * su + ay[1] * sv, c[2] + ax[2] * su + ay[2] * sv];
  const a = m.vert(P(-1, -1), n, mat, 0), b = m.vert(P(1, -1), n, mat + 0.5, 0);
  const d = m.vert(P(1, 1), n, mat + 0.5, 1), e = m.vert(P(-1, 1), n, mat, 1);
  m.i.push(a, b, d, a, d, e);
}

// Scatter leaf-clump cards over an ellipsoidal pad (centre, radii): mostly flat layers
// (acacia), tilting outward toward the rim; the shading normal is the pad's radial normal.
function padCards(m, r, c, rx, ry, rz, count, size, flat) {
  for (let k = 0; k < count; k++) {
    const th = r() * Math.PI * 2, u = Math.sqrt(r());
    const yy = (r() * 2 - 1) * 0.8;
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy)) * (0.35 + 0.65 * u);
    const p = [c[0] + Math.cos(th) * rr * rx, c[1] + yy * ry + ry * 0.2, c[2] + Math.sin(th) * rr * rz];
    const n = nrm3([(p[0] - c[0]) / rx, (p[1] - c[1]) / ry * 0.6 + 0.6, (p[2] - c[2]) / rz]);
    const tilt = (1 - flat) * 1.2 + rr * 0.6;
    const cn = nrm3([Math.cos(th) * tilt + (r() - 0.5) * 0.8, 1, Math.sin(th) * tilt + (r() - 0.5) * 0.8]);
    const ref = Math.abs(cn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a0 = nrm3(cross3(cn, ref));
    const b0 = cross3(cn, a0);
    const yaw = r() * Math.PI * 2, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const sz = size * (0.75 + 0.5 * r());
    const ax = [(a0[0] * cy + b0[0] * sy) * sz, (a0[1] * cy + b0[1] * sy) * sz, (a0[2] * cy + b0[2] * sy) * sz];
    const ay = [(b0[0] * cy - a0[0] * sy) * sz, (b0[1] * cy - a0[1] * sy) * sz, (b0[2] * cy - a0[2] * sy) * sz];
    card(m, p, ax, ay, n, 6);
  }
}

function acaciaFrame(near, m, r) {
  const top = [0.35, 2.1, 0.12];
  m.mat = 0;
  const trunkPath = (t) => [top[0] * t * t, top[1] * t, top[2] * t];
  m.place().tube(trunkPath, (t) => (0.24 - 0.09 * t + 0.12 * Math.pow(1 - t, 6)) * (near ? 1 : 1.5), near ? 9 : 5, near ? 6 : 2);
  const tips = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + (r() - 0.5) * 0.8;
    const out = 2.1 + 1.3 * r();
    const tip = [top[0] + Math.cos(a) * out, 4.1 + 1.0 * r(), top[2] + Math.sin(a) * out];
    const ctrl = [top[0] + Math.cos(a) * out * 0.25, 3.6 + 0.5 * r(), top[2] + Math.sin(a) * out * 0.25];
    tips.push({ tip, a });
    if (near) {
      const path = (t) => { const u = 1 - t; return [u * u * top[0] + 2 * u * t * ctrl[0] + t * t * tip[0], u * u * (top[1] - 0.2) + 2 * u * t * ctrl[1] + t * t * tip[1], u * u * top[2] + 2 * u * t * ctrl[2] + t * t * tip[2]]; };
      m.place().tube(path, (t) => 0.13 - 0.08 * t, 6, 5);
      const tw = [tip[0] + Math.cos(a + 0.9) * 1.1, tip[1] + 0.25, tip[2] + Math.sin(a + 0.9) * 1.1];
      m.place().tube((t) => [tip[0] + (tw[0] - tip[0]) * t, tip[1] - 0.4 + (tw[1] - tip[1] + 0.4) * t, tip[2] + (tw[2] - tip[2]) * t], (t) => 0.05 - 0.03 * t, 4, 2);
    } else {
      m.place().tube((t) => [top[0] + (tip[0] - top[0]) * t, top[1] - 0.2 + (tip[1] - top[1] + 0.2) * t, top[2] + (tip[2] - top[2]) * t], (t) => 0.16 - 0.08 * t, 4, 1);
    }
  }
  return { top, tips };
}

// Near acacia: branches, a thin dark inner leaf mass and ~170 leaf-clump cards in flat
// layered pads (sky shows through the gaps). kind: 0 main, 1 shadow caster (solid pads).
function acacia(kind) {
  const m = new MeshBuilder();
  const r = rng(7);
  const { top, tips } = acaciaFrame(kind !== 2, m, r);
  m.mat = 1;
  const pads = [];
  for (const { tip } of tips) pads.push([tip[0], tip[1] + 0.25, tip[2], 2.3 + 0.7 * r(), 0.62, 2.0 + 0.6 * r()]);
  pads.push([top[0], 5.05, top[2], 3.3, 0.5, 3.0]);
  if (kind === 0) {
    const rc = rng(11);
    for (const [x, y, z, rx, ry, rz] of pads) {
      m.place(x, y, z, rc() * 6).blob(rx * 0.72, ry * 0.55, rz * 0.72, 12, 6, lumpy(0.14, 0.07), 0.45);
      padCards(m, rc, [x, y, z], rx * 1.02, ry * 1.1, rz * 1.02, Math.round(rx * rz * 5.2), 0.62, 0.65);
    }
  } else if (kind === 1) {
    const rc = rng(11);
    for (const [x, y, z, rx, ry, rz] of pads) m.place(x, y, z, rc() * 6).blob(rx * 0.95, ry * 0.9, rz * 0.95, 14, 7, lumpy(0.16, 0.08), 0.45);
  } else {
    // Far LOD: one thick, lumpy umbrella (reads as a crown, not a pin, at a few pixels); its
    // own material (14) is lit as sunlit foliage, not as the dark inner mass.
    m.mat = 14;
    m.place(top[0], 4.7, top[2], 0.3, 0, 0).blob(4.6, 1.6, 4.2, 14, 6, lumpy(0.16, 0.05), 0.5);
  }
  return m.build();
}

function shrub(cards) {
  const m = new MeshBuilder();
  m.mat = 1;
  const parts = [[0, 0.45, 0, 1.0, 0.65, 0.9], [0.7, 0.35, 0.4, 0.7, 0.5, 0.7], [-0.6, 0.3, -0.3, 0.6, 0.45, 0.65]];
  const r = rng(5);
  for (const [x, y, z, rx, ry, rz] of parts) {
    m.place(x, y, z, r() * 3).blob(rx * (cards ? 0.78 : 1), ry * (cards ? 0.78 : 1), rz * (cards ? 0.78 : 1), 12, 7, lumpy(0.16, 0.1), 0.6);
    if (cards) {
      for (let k = 0; k < 16; k++) {
        const th = r() * Math.PI * 2, yy = r() * 1.6 - 0.5;
        const rr = Math.sqrt(Math.max(0, 1 - yy * yy * 0.6));
        const c = [x + Math.cos(th) * rr * rx * 0.9, y + yy * ry * 0.8, z + Math.sin(th) * rr * rz * 0.9];
        const n = nrm3([(c[0] - x) / rx, (c[1] - y) / ry + 0.4, (c[2] - z) / rz]);
        const t = cross3(n, [0, 1, 0.01]);
        const tl = Math.hypot(...t) || 1;
        const ax = [t[0] / tl * 0.42, t[1] / tl * 0.42, t[2] / tl * 0.42];
        const ay3 = cross3(n, ax);
        card(m, c, ax, [ay3[0] * 0.95, ay3[1] * 0.95, ay3[2] * 0.95], n, 6);
      }
    }
  }
  return m.build();
}

function rock() {
  const m = new MeshBuilder();
  m.mat = 2;
  const d = (x, y, z) => 0.16 * Math.sin(3.1 * x + 1.3) * Math.sin(2.7 * z + 0.6) + 0.09 * Math.sin(6.3 * y + 2.1 * x) + 0.05 * Math.sin(13 * x + 7 * z) - 0.18 * Math.max(0, y - 0.55);
  m.place(0, 0, 0).blob(1, 0.72, 0.85, 18, 11, d, 0.9);
  return m.build();
}

function mound() {
  const m = new MeshBuilder();
  m.mat = 3;
  const prof = (v) => [0.08 + 1.05 * Math.pow(1 - v, 1.4) + 0.12 * Math.sin(v * 9) * (1 - v), v * 3.1];
  m.place(0, -0.1, 0).lathe(prof, 18, 14, (th, v) => 0.14 * Math.sin(3 * th + v * 5) + 0.07 * Math.sin(7 * th - v * 3));
  m.place(0.55, -0.1, 0.25, 0, 0, -0.12, 0.6).lathe(prof, 12, 9, (th, v) => 0.12 * Math.sin(4 * th + v * 4));
  return m.build();
}

// Date palm: a slightly curved ringed trunk, a crown of arching pinnate fronds (V-section
// ribbons with a procedural leaflet mask), dead fronds hanging below, date clusters.
function palm(far) {
  const m = new MeshBuilder();
  const r = rng(23);
  const H = 9.0, lean = 0.7;
  const trunk = (t) => [lean * t * t, H * t, 0.15 * Math.sin(t * 3)];
  m.mat = 8;
  m.place().tube(trunk, (t) => (0.23 - 0.06 * t + 0.14 * Math.pow(1 - t, 8)) * (far ? 1.4 : 1), far ? 5 : 10, far ? 4 : 12);
  const top = trunk(1);
  m.mat = 8;
  m.place(top[0], top[1] - 0.15, top[2]).blob(0.42, 0.5, 0.42, 10, 6);
  const fronds = [];
  for (let k = 0; k < 7; k++) fronds.push([0.95 + 0.25 * r(), 3.6 + 0.6 * r(), 7]);
  for (let k = 0; k < 8; k++) fronds.push([0.35 + 0.25 * r(), 4.2 + 0.6 * r(), 7]);
  for (let k = 0; k < 6; k++) fronds.push([-0.35 - 0.4 * r(), 3.2 + 0.5 * r(), k < 3 ? 12 : 7]);
  const n = fronds.length;
  const NV = far ? 3 : 9;
  fronds.forEach(([el, L, mat], k) => {
    if (far && (k % 2)) return;
    const az = k * 2.39996 + r() * 0.3;
    const dir = [Math.cos(az), 0, Math.sin(az)];
    const side = [-Math.sin(az), 0, Math.cos(az)];
    const ce = Math.cos(el), se = Math.sin(el);
    const P = (t) => [top[0] + dir[0] * L * ce * t, top[1] + L * (se * t - 0.42 * t * t), top[2] + dir[2] * L * ce * t];
    const base = m.count;
    for (let j = 0; j <= NV; j++) {
      const t = j / NV;
      const c = P(t);
      const hw = (0.62 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.1)), 0.7) + 0.05) * (far ? 1.3 : 1);
      const sag = 0.22 * hw;
      const nU = nrm3([dir[0] * 0.3, 1, dir[2] * 0.3]);
      m.vert([c[0] - side[0] * hw, c[1] - sag, c[2] - side[2] * hw], nU, mat, t);
      m.vert([c[0], c[1], c[2]], nU, mat + 0.25, t);
      m.vert([c[0] + side[0] * hw, c[1] - sag, c[2] + side[2] * hw], nU, mat + 0.5 - 1e-4, t);
    }
    for (let j = 0; j < NV; j++) {
      const a = base + j * 3;
      for (let q = 0; q < 2; q++) m.i.push(a + q, a + q + 1, a + q + 4, a + q, a + q + 4, a + q + 3);
    }
  });
  // Dates hanging under the crown.
  m.mat = 9;
  for (let k = 0; k < (far ? 0 : 4); k++) {
    const a = k * 1.7 + 0.4;
    m.place(top[0] + Math.cos(a) * 0.45, top[1] - 0.75, top[2] + Math.sin(a) * 0.45).blob(0.22, 0.38, 0.22, 8, 5, lumpy(0.2, 0.15));
  }
  return m.build();
}

// Young date palm: a short stout trunk under a big, more upright crown (offshoots and young
// trees in the groves, so they are not all one model).
function youngPalm() {
  const m = new MeshBuilder();
  const r = rng(41);
  const H = 3.6;
  const trunk = (t) => [0.25 * t * t, H * t, 0.08 * Math.sin(t * 3)];
  m.mat = 8;
  m.place().tube(trunk, (t) => 0.3 - 0.06 * t + 0.16 * Math.pow(1 - t, 6), 10, 8);
  const top = trunk(1);
  m.place(top[0], top[1] - 0.1, top[2]).blob(0.48, 0.55, 0.48, 10, 6);
  const fronds = [];
  for (let k = 0; k < 9; k++) fronds.push([1.05 + 0.25 * r(), 3.1 + 0.6 * r(), 7]);
  for (let k = 0; k < 10; k++) fronds.push([0.5 + 0.3 * r(), 3.5 + 0.6 * r(), 7]);
  for (let k = 0; k < 5; k++) fronds.push([0.0 + 0.25 * r(), 3.2 + 0.4 * r(), k < 2 ? 12 : 7]);
  const NV = 8;
  fronds.forEach(([el, L, mat], k) => {
    const az = k * 2.39996 + r() * 0.4;
    const dir = [Math.cos(az), 0, Math.sin(az)], side = [-Math.sin(az), 0, Math.cos(az)];
    const ce = Math.cos(el), se = Math.sin(el);
    const P = (t) => [top[0] + dir[0] * L * ce * t, top[1] + L * (se * t - 0.38 * t * t), top[2] + dir[2] * L * ce * t];
    const base = m.count;
    for (let j = 0; j <= NV; j++) {
      const t = j / NV, c = P(t);
      const hw = 0.58 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.1)), 0.7) + 0.05;
      const nU = nrm3([dir[0] * 0.3, 1, dir[2] * 0.3]);
      m.vert([c[0] - side[0] * hw, c[1] - 0.22 * hw, c[2] - side[2] * hw], nU, mat, t);
      m.vert([c[0], c[1], c[2]], nU, mat + 0.25, t);
      m.vert([c[0] + side[0] * hw, c[1] - 0.22 * hw, c[2] + side[2] * hw], nU, mat + 0.5 - 1e-4, t);
    }
    for (let j = 0; j < NV; j++) { const a = base + j * 3; for (let q = 0; q < 2; q++) m.i.push(a + q, a + q + 1, a + q + 4, a + q, a + q + 4, a + q + 3); }
  });
  return m.build();
}

// Desert scrub (tamarisk / saltbush): a low woody dome of twigs carrying knots of small
// grey-green foliage (solid lumpy clumps, not cards: they keep their volume up close) over a
// dark inner mass, so it reads as a 3D bush and casts a real shadow.
function scrub() {
  const m = new MeshBuilder();
  const r = rng(77);
  m.mat = 1;
  m.place(0, 0.3, 0).blob(0.6, 0.32, 0.56, 12, 6, lumpy(0.18, 0.1), 0.5);
  const tips = [];
  for (let k = 0; k < 12; k++) {
    const a = k * 2.39996 + r() * 0.5, out = 0.5 + 0.45 * r(), up = 0.5 + 0.45 * r();
    const tip = [Math.cos(a) * out, up, Math.sin(a) * out];
    const mid = [Math.cos(a + 0.4) * out * 0.45, up * 0.55, Math.sin(a + 0.4) * out * 0.45];
    m.mat = 0;
    m.place().tube((t) => { const u = 1 - t; return [2 * u * t * mid[0] + t * t * tip[0], 2 * u * t * mid[1] + t * t * tip[1], 2 * u * t * mid[2] + t * t * tip[2]]; }, (t) => 0.03 - 0.02 * t, 4, 3);
    tips.push(tip);
  }
  m.mat = 14;
  for (const t of tips) {
    const sz = 0.17 + 0.11 * r();
    m.place(t[0] * 0.9, t[1] * 0.92, t[2] * 0.9, r() * 6, 0, 0).blob(sz * 1.3, sz * 0.85, sz * 1.1, 7, 4, lumpy(0.3, 0.15), 0.6);
  }
  return m.build();
}

// Trail cairn: a short stack of flat stones (marks the ice and desert tracks).
function cairn() {
  const m = new MeshBuilder();
  m.mat = 2;
  const d = (x, y, z) => 0.1 * Math.sin(5.1 * x + 1.3) * Math.sin(4.7 * z + 0.6) + 0.05 * Math.sin(11 * x + 7 * z);
  const st = [[0, 0.16, 0, 0.62, 0.24, 0.55, 0.2], [0.04, 0.48, -0.03, 0.48, 0.18, 0.44, 1.1], [-0.03, 0.74, 0.02, 0.38, 0.15, 0.34, 2.3], [0.02, 0.96, 0, 0.27, 0.13, 0.25, 0.7], [0, 1.15, 0.01, 0.17, 0.12, 0.16, 1.9]];
  for (const [x, y, z, rx, ry, rz, yaw] of st) m.place(x, y, z, yaw, 0.08, -0.06).blob(rx, ry, rz, 12, 7, d, 0.8);
  return m.build();
}

// Woolly mammoth, ~3.2 m at the shoulder, facing +x.
function mammoth() {
  const m = new MeshBuilder();
  m.mat = 10;
  const fur = (x, y, z) => 0.05 * Math.sin(9 * x + 3 * z) * Math.sin(7 * y) + 0.03 * Math.sin(23 * x + 17 * y);
  m.place(0, 2.2, 0).blob(2.0, 1.25, 1.1, 22, 12, fur, 0.85);
  m.place(0.75, 2.85, 0).blob(1.05, 0.85, 0.95, 14, 8, fur);
  m.place(1.85, 2.75, 0).blob(0.75, 0.85, 0.72, 14, 9, fur);
  m.place(1.72, 3.38, 0).blob(0.45, 0.42, 0.45, 10, 6);
  for (const s of [-1, 1]) m.place(1.62, 2.85, s * 0.62).blob(0.3, 0.36, 0.12, 8, 5);
  const trunk = (t) => { const u = 1 - t; return [u * u * 2.45 + 2 * u * t * 2.75 + t * t * 2.62, u * u * 2.45 + 2 * u * t * 1.2 + t * t * 0.35, 0]; };
  m.place().tube(trunk, (t) => 0.27 - 0.17 * t, 10, 10);
  for (const [x, z] of [[1.05, 0.52], [1.05, -0.52], [-1.15, 0.5], [-1.15, -0.5]]) {
    m.place().tube((t) => [x + 0.05 * Math.sin(t * 3), 2.0 - 2.0 * t, z], (t) => 0.4 - 0.08 * t + 0.06 * Math.pow(t, 6), 10, 4);
  }
  m.place().tube((t) => [-1.95 - 0.25 * t, 2.45 - 1.0 * t, 0], (t) => 0.09 - 0.05 * t, 6, 4);
  m.mat = 11;
  for (const s of [-1, 1]) {
    const P0 = [2.35, 2.2, s * 0.32], P1 = [3.3, 1.2, s * 0.75], P2 = [3.75, 1.75, s * 0.35], P3 = [3.35, 2.25, s * 0.02];
    const bz = (t) => { const u = 1 - t; const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t; return [a * P0[0] + b * P1[0] + c * P2[0] + d * P3[0], a * P0[1] + b * P1[1] + c * P2[1] + d * P3[1], a * P0[2] + b * P1[2] + c * P2[2] + d * P3[2]]; };
    m.place().tube(bz, (t) => 0.13 - 0.1 * t, 8, 12);
  }
  return m.build();
}

function post() {
  const m = new MeshBuilder();
  m.mat = 4;
  m.place(0, 0, 0, 0, -Math.PI / 2, 0).cyl(0.085, -0.4, 2.75, 8);
  m.place(0, 2.78, 0).blob(0.11, 0.07, 0.11, 8, 4);
  return m.build();
}

// Board extending along +x from the post, faces +-z (the -z face looks at the driver).
const BOARD_H = 0.19;
function board() {
  const m = new MeshBuilder();
  m.mat = 4;
  m.place(0.66, 0, 0).rbox(0.64, BOARD_H + 0.025, 0.03, 0.15, 16, 8);
  // Faces (both sides) carry the painted glyph.
  m.mat = 5;
  m.place().quad([0.08, -BOARD_H, 0.032], [1.16, 0, 0], [0, BOARD_H * 2, 0], [0, 0, 1]);
  m.place().quad([0.08, -BOARD_H, -0.032], [0, BOARD_H * 2, 0], [1.16, 0, 0], [0, 0, -1]);
  // Arrow tip at the outer end.
  m.mat = 4;
  m.place(1.32, 0, 0, 0, 0, Math.PI / 4).rbox(0.15, 0.15, 0.028, 0.2, 8, 6);
  return m.build();
}

// Timber bridge segment (8 m along +x, centred): a plank deck whose top is at y = 0.05 (the
// road height) on two stringer beams, a post-and-rail fence each side, and a pile bent at each
// end standing in the river (adjacent segments share the bents).
const BR_LEN = 8, BR_HW = 3.7;
function bridge() {
  const m = new MeshBuilder();
  m.mat = 13;
  m.place(0, -0.07, 0).rbox(BR_LEN / 2 + 0.02, 0.12, BR_HW - 0.15, 0.12, 12, 6); // deck
  for (const sz of [-1, 1]) {
    m.place(0, -0.35, sz * (BR_HW - 0.45)).rbox(BR_LEN / 2, 0.2, 0.16, 0.2, 10, 6); // stringer
    for (const x of [-3.9, -1.3, 1.3]) m.place(x, 0, sz * (BR_HW - 0.18), 0, -Math.PI / 2, 0).cyl(0.085, -0.1, 1.1, 8);
    m.place(0, 1.02, sz * (BR_HW - 0.18)).rbox(BR_LEN / 2 + 0.05, 0.055, 0.06, 0.3, 10, 4); // top rail
    m.place(0, 0.56, sz * (BR_HW - 0.18)).rbox(BR_LEN / 2 + 0.05, 0.045, 0.05, 0.3, 10, 4); // mid rail
  }
  for (const sz of [-1, 0, 1]) m.place(-3.9, -0.3, sz * (BR_HW - 0.5), 0, -Math.PI / 2, 0).cyl(0.2, -3.6, 0, 9); // pile bent
  m.place(-3.9, -0.6, 0).rbox(0.14, 0.14, BR_HW - 0.2, 0.25, 6, 6); // cap beam
  return m.build();
}

// Broadleaf (beech / oak): a tall clean trunk, a few limbs and a crown of layered leaf masses
// with leaf-clump cards (near); the far LOD is three solid masses on a stub trunk, also used as
// the shadow caster.
function broadleaf(far) {
  const m = new MeshBuilder();
  const r = rng(91);
  m.mat = 0;
  m.place().tube((t) => [0.35 * t * t, 9.5 * t, 0.12 * Math.sin(t * 2.5)], (t) => (0.42 - 0.16 * t + 0.22 * Math.pow(1 - t, 7)) * (far ? 1.3 : 1), far ? 5 : 9, far ? 2 : 6);
  const masses = [[0.3, 14.2, 0.1, 3.6, 2.4, 3.4]];
  for (let k = 0; k < 5; k++) {
    const a = k * 1.2566 + (r() - 0.5) * 0.6, out = 2.4 + 0.8 * r();
    masses.push([0.3 + Math.cos(a) * out, 10.2 + 1.8 * r(), Math.sin(a) * out, 2.7 + 0.6 * r(), 2.0 + 0.4 * r(), 2.6 + 0.5 * r()]);
  }
  if (far) {
    m.mat = 14;
    m.place(0.3, 12.6, 0.05).blob(4.6, 3.6, 4.4, 12, 7, lumpy(0.14, 0.06), 0.55);
    m.place(1.6, 10.6, 1.4).blob(2.6, 1.9, 2.5, 8, 5, lumpy(0.12, 0.05), 0.6);
    m.place(-1.7, 10.9, -1.1).blob(2.5, 1.9, 2.4, 8, 5, lumpy(0.12, 0.05), 0.6);
    return m.build();
  }
  for (let k = 1; k < masses.length; k++) {
    const [x, y, z] = masses[k];
    const P0 = [0.25, 6.5 + 0.8 * r(), 0.08], P1 = [x * 0.5, y - 1.2, z * 0.5];
    m.place().tube((t) => { const u = 1 - t; return [u * u * P0[0] + 2 * u * t * P1[0] + t * t * x, u * u * P0[1] + 2 * u * t * P1[1] + t * t * (y - 0.6), u * u * P0[2] + 2 * u * t * P1[2] + t * t * z]; }, (t) => 0.17 - 0.1 * t, 5, 4);
  }
  const rc = rng(17);
  for (const [x, y, z, rx, ry, rz] of masses) {
    m.mat = 1;
    m.place(x, y, z, rc() * 6).blob(rx * 0.8, ry * 0.72, rz * 0.8, 12, 7, lumpy(0.15, 0.07), 0.6);
    padCards(m, rc, [x, y - ry * 0.15, z], rx * 1.0, ry * 0.9, rz * 1.0, Math.round(rx * rz * 3.0), 0.85, 0.15);
  }
  return m.build();
}

// Spruce / fir: a straight trunk and stacked drooping tiers that narrow to a spire.
function conifer(far) {
  const m = new MeshBuilder();
  m.mat = 0;
  m.place().tube((t) => [0, 19 * t, 0], (t) => 0.32 - 0.26 * t + 0.12 * Math.pow(1 - t, 8), far ? 4 : 7, far ? 1 : 3);
  m.mat = 14;
  const tiers = far ? 3 : 7;
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers;
    const y0 = 2.6 + f * 14.5, R = 3.3 * (1 - f * 0.8) + 0.3, h = (far ? 6.5 : 3.6) * (1 - f * 0.35);
    const prof = (v) => [Math.max(0.05, R * v), y0 + h * (1 - v) - 0.5 * R * v * v * 0.3];
    m.place(0, 0, 0, i * 0.9).lathe(prof, far ? 7 : 12, far ? 2 : 4, (th, v) => v * (0.16 * Math.sin(5 * th + i) + 0.1 * Math.sin(11 * th + 2 * i)));
  }
  return m.build();
}

// --- GPU ------------------------------------------------------------------------------

const M_TREE = 0, M_TREE_FAR = 1, M_SHRUB = 2, M_ROCK = 3, M_MOUND = 4, M_PALM = 5, M_MAMMOTH = 6, M_TREE_SH = 7, M_SHRUB_SH = 8, M_POST = 9, M_BOARD = 10, M_PALM_FAR = 11, M_BRIDGE = 12, M_PALM2 = 13, M_SCRUB = 14, M_CAIRN = 15;
const M_BL = 16, M_BL_FAR = 17, M_CN = 18, M_CN_FAR = 19;
// Lists: main (camera) lists, near-shadow lists, far-cascade lists.
const L_TREE = 0, L_TREE_FAR = 1, L_SHRUB = 2, L_ROCK = 3, L_MOUND = 4, L_PALM = 5, L_MAMMOTH = 6;
const L_S_TREE = 7, L_S_SHRUB = 8, L_S_ROCK = 9, L_S_MOUND = 10, L_S_PALM = 11, L_S_MAMMOTH = 12;
const L_F_TREE = 13, L_F_ROCK = 14, L_F_PALM = 15, L_F_MAMMOTH = 16, L_F_MOUND = 17, L_PALM_FAR = 18;
const L_PALM2 = 19, L_S_PALM2 = 20, L_SCRUB = 21, L_S_SCRUB = 22; // appended: young palms, desert scrub
// appended: broadleaf and conifer trees (near, far, near shadow, far cascade)
const L_BL = 23, L_BL_FAR = 24, L_CN = 25, L_CN_FAR = 26, L_S_BL = 27, L_S_CN = 28, L_F_BL = 29, L_F_CN = 30;
const CAP = [1536, 4096, 4096, 6144, 1024, 768, 256, 1536, 2048, 2048, 512, 512, 128, 4096, 2048, 1024, 256, 1024, 3072, 768, 512, 2048, 1024,
  1024, 8192, 768, 6144, 1536, 1024, 6144, 4096];
const MESH_OF = [M_TREE, M_TREE_FAR, M_SHRUB, M_ROCK, M_MOUND, M_PALM, M_MAMMOTH, M_TREE_SH, M_SHRUB_SH, M_ROCK, M_MOUND, M_PALM, M_MAMMOTH, M_TREE_FAR, M_ROCK, M_PALM_FAR, M_MAMMOTH, M_MOUND, M_PALM_FAR, M_PALM2, M_PALM2, M_SCRUB, M_SCRUB,
  M_BL, M_BL_FAR, M_CN, M_CN_FAR, M_BL_FAR, M_CN_FAR, M_BL_FAR, M_CN_FAR];
const NL = CAP.length;
// Lists drawn in each pass.
const MAIN_LISTS = new Uint8Array([L_TREE, L_TREE_FAR, L_SHRUB, L_ROCK, L_MOUND, L_PALM, L_MAMMOTH, L_PALM_FAR, L_PALM2, L_SCRUB, L_BL, L_BL_FAR, L_CN, L_CN_FAR]);
const NEAR_SH_LISTS = new Uint8Array([L_S_TREE, L_S_SHRUB, L_S_ROCK, L_S_MOUND, L_S_PALM, L_S_MAMMOTH, L_S_PALM2, L_S_SCRUB, L_S_BL, L_S_CN]);
const FAR_SH_LISTS = new Uint8Array([L_F_TREE, L_F_ROCK, L_F_PALM, L_F_MAMMOTH, L_F_MOUND, L_F_BL, L_F_CN]);
const listBase = new Uint32Array(NL);
const argsInit = new Uint32Array(NL * 5);
const MAX_SIGN = 64;
const SIGN_SCALE = 3.0;
const MAX_BRIDGE = 48; // bridge segments, stored after the signs
const MAX_CAIRN = 192; // trail cairns along ice and desert roads, stored after the bridges
const signData = new Float32Array((MAX_SIGN + MAX_BRIDGE + MAX_CAIRN) * 8);
let nSign = 0, signDirty = -1;
const pt4 = new Float64Array(8);

const PROP_COMMON = /* wgsl */ `
struct Inst { a: vec4f, b: vec4f }; // a: pos.xyz, yaw   b: scale xz, scale y, biome + hue, kind
fn instPos(lp: vec3f, it: Inst) -> vec3f {
  let c = cos(it.a.w);
  let s = sin(it.a.w);
  let q = lp * vec3f(it.b.x, it.b.y, it.b.x);
  return it.a.xyz + vec3f(c * q.x - s * q.z, q.y, s * q.x + c * q.z);
}
fn instNrm(n: vec3f, it: Inst) -> vec3f {
  let c = cos(it.a.w);
  let s = sin(it.a.w);
  let q = normalize(n / vec3f(it.b.x, it.b.y, it.b.x));
  return vec3f(c * q.x - s * q.z, q.y, s * q.x + c * q.z);
}
`;

const PLACE_WGSL = FRAME_STRUCT + WORLD_WGSL + PROP_COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
override LODK: f32 = 1.0; // debug (?lodk=): scales the near / far model switch distances
struct Grid { origin: vec2i, dims: vec2i, cell: f32, rmax: f32, fine: u32, pad: u32 };
@group(2) @binding(0) var<uniform> G: Grid;
@group(2) @binding(1) var<storage, read_write> inst: array<Inst>;
@group(2) @binding(2) var<storage, read_write> args: array<atomic<u32>, ${NL * 5}>;
var<private> CAP: array<u32, ${NL}> = array<u32, ${NL}>(${CAP.join('u, ')}u);
var<private> BASE: array<u32, ${NL}> = array<u32, ${NL}>(BASE_LIST);

fn hf(h: u32, k: u32) -> f32 { return f32(hashU(h, k) >> 8u) * (1.0 / 16777216.0); }

// Fades (no prop ever pops): a prop's opacity rides in the fraction of its kind (b.w): 0..0.49
// near side, 0.5..0.99 far side, 0 = opaque; the main pass turns it into a screen-door dither
// (fs). Density hand-offs and range limits fade each tree in over a short ramp (dfade); the
// near / far models crossfade over a band with complementary dithers (pushLod).
fn fcode(o: f32, far: bool) -> f32 { return (1.0 - clamp(o, 0.0, 1.0)) * 0.49 + select(0.0, 0.5, far); }
// Opacity of a candidate drawn at u < p0 * s, s the density factor: ramps in as s passes its
// threshold q = u / p0 (scaled so every tree is opaque at s = 1 and gone at s = 0).
fn dfade(s: f32, q: f32) -> f32 { return saturate((s - q * 0.88) / 0.12); }

fn push(list: u32, it: Inst) {
  let i = atomicAdd(&args[list * 5u + 1u], 1u);
  if (i < CAP[list]) { inst[BASE[list] + i] = it; } else { atomicSub(&args[list * 5u + 1u], 1u); }
}
// Near model inside d - 12 m, far model beyond d + 12 m. In between both are drawn and one
// stays opaque while the other fades (driving in: the near model fades in over the far one,
// then the far one fades out), so the tree never thins or shows a hole.
fn pushLod(nearL: u32, farL: u32, r: f32, d: f32, it0: Inst, o: f32) {
  let k = smoothstep(d - 12.0, d + 12.0, r);
  var it = it0;
  if (k < 1.0) { it.b.w = it0.b.w + fcode(o * saturate(2.0 - 2.0 * k), false); push(nearL, it); }
  if (k > 0.0) { it.b.w = it0.b.w + fcode(o * saturate(2.0 * k), true); push(farL, it); }
}

fn visible(p: vec3f, rad: f32) -> bool {
  for (var i = 0; i < 5; i++) {
    let pl = W.planes[i];
    if (dot(pl.xyz, p) + pl.w < -rad) { return false; }
  }
  return true;
}

// kinds: 0 acacia, 2 shrub, 3 rock, 4 termite mound, 5 date palm, 6 mammoth
@compute @workgroup_size(8, 8) fn place(@builtin(global_invocation_id) id: vec3u) {
  if (i32(id.x) >= G.dims.x || i32(id.y) >= G.dims.y) { return; }
  let ci = G.origin + vec2i(id.xy);
  let h = hashU(bitcast<u32>(ci.x) ^ (G.fine * 0x9e3779b9u), bitcast<u32>(ci.y) + 31u);
  let p = (vec2f(ci) + 0.04 + 0.92 * vec2f(hf(h, 1u), hf(h, 2u))) * G.cell;
  let r = distance(p, W.cam.xz);
  if (r > G.rmax) { return; }
  // Biome of this candidate, drawn from the local weights.
  let bwf = biomeW(p);
  let bw = bwf.a;
  let mw = matW(p, bwf);
  let bi = bwPick(mw, hf(h, 11u));
  let dens = W.bp[bi * BK + B_PROPS];
  let u = hf(h, 3u);
  var kind = -1;
  var clear = 0.0;
  var rad = 1.0;
  var maxR = 0.0;
  var ofade = 1.0; // density hand-off fade (dfade)
  // Woodland (forest, mountain valleys): glades and stands; trees thin out around landmarks so
  // they stay in view from the road.
  var wood = 0.0;
  if (bi == 3u || bi == 5u) {
    wood = smoothstep(0.32, 0.5, vnoise(p * (1.0 / 180.0) + vec2f(4.0, 7.0)));
    for (var k = 0; k < ${MAX_PADS}; k++) {
      let q = W.pads[k];
      if (q.z <= 0.0) { continue; }
      wood *= smoothstep(q.z * 0.6 + 25.0, q.z * 1.6 + 150.0, distance(p, q.xy));
    }
  }
  let conif = smoothstep(0.45, 0.65, vnoise(p * (1.0 / 140.0) + vec2f(8.0, 1.0)));
  if (G.fine == 2u) {
    // Woodland grid: near trees (and the mid distance, crossfading to the coarse grid).
    // (Faded per tree, complementary to the coarse grid's stands below.)
    let fade = 1.0 - smoothstep(330.0, 420.0, r);
    if (bi == 3u) {
      let pT = dens.x * 0.75 * wood;
      if (u < pT) { kind = select(7, 8, hf(h, 19u) < 0.15 + 0.7 * conif); clear = 8.5; rad = 7.0; maxR = 420.0; ofade = dfade(fade, u / pT); }
    } else if (bi == 5u) {
      let pT = dens.x * 0.45 * wood * smoothstep(0.3, 0.6, vnoise(p * (1.0 / 60.0) + vec2f(1.0, 3.0)));
      if (u < pT) { kind = 8; clear = 6.0; rad = 6.0; maxR = 420.0; ofade = dfade(fade, u / pT); }
    }
  } else if (G.fine == 0u) {
    if (bi == 0u) {
      let grove = smoothstep(0.25, 0.75, vnoise(p * (1.0 / 420.0) + vec2f(3.0, 1.0)));
      let rocky = smoothstep(0.55, 0.85, vnoise(p * (1.0 / 260.0) + vec2f(9.0, 4.0)));
      let clump = smoothstep(0.38, 0.72, vnoise(p * (1.0 / 75.0) + vec2f(5.0, 9.0)) * 0.7 + vnoise(p * (1.0 / 23.0)) * 0.3);
      // Trees cluster in groves and along drainage lines (thin, winding), sparse elsewhere.
      let dq = vec2f(0.6 * p.x + 0.8 * p.y, -0.8 * p.x + 0.6 * p.y);
      let drain = 1.0 - smoothstep(0.0, 0.16, abs(2.0 * vnoise(dq * (1.0 / 260.0) + vec2f(vnoise(p * (1.0 / 90.0)) * 0.6, 3.0)) - 1.0));
      let pT = dens.x * (0.008 + 0.42 * grove * clump + 0.5 * drain * (0.3 + 0.7 * clump)) * smoothstep(0.6, 0.92, bw.x);
      let pM = dens.w * 0.05;
      let pR = dens.z * 0.15 * rocky;
      if (u < pT) { kind = 0; clear = 6.5; rad = 6.0; maxR = 1700.0; }
      else if (u < pT + pM) { kind = 4; clear = 4.0; rad = 2.5; maxR = 700.0; }
      else if (u < pT + pM + pR) { kind = 3; clear = 3.5; rad = 3.0; maxR = 900.0; }
    } else if (bi == 1u) {
      // Erratics everywhere (more in boulder fields), mammoth herds in the open.
      let field = smoothstep(0.55, 0.85, vnoise(p * (1.0 / 260.0) + vec2f(9.0, 4.0)));
      let pR = dens.z * (0.035 + 0.13 * field) * (1.0 + 2.0 * smoothstep(80.0, 10.0, r));
      let herd = smoothstep(0.70, 0.80, vnoise(p * (1.0 / 520.0) + vec2f(2.0, 7.0)));
      let pM = dens.w * 0.3 * herd;
      if (u < pR) { kind = 3; clear = 4.0; rad = 4.0; maxR = select(700.0, 1300.0, hf(h, 18u) < 0.3); }
      else if (u < pR + pM) { kind = 6; clear = 70.0; rad = 4.5; maxR = 1700.0; }
    } else if (bi == 2u) {
      // Date palms in groves along the river; boulders on the stony plain.
      let pR = dens.z * 0.07 * (1.0 - duneField(p));
      var pP = 0.0;
      if (u < dens.w * 0.6) {
        let rd = riverDist(p);
        pP = dens.w * 0.6 * (1.0 - smoothstep(30.0, 190.0, rd)) * step(19.0, rd) * smoothstep(0.35, 0.7, vnoise(p * (1.0 / 70.0) + vec2f(1.0, 1.0)) * 0.7 + vnoise(p * (1.0 / 23.0)) * 0.3 + 0.2 * (1.0 - smoothstep(25.0, 60.0, rd)));
      }
      if (u < pP) { kind = 5; clear = 4.5; rad = 6.0; maxR = 1300.0; }
      else if (u < pP + pR) { kind = 3; clear = 3.5; rad = 3.0; maxR = 900.0; }
    } else if (bi == 3u) {
      // Forest beyond the woodland grid: stands to the horizon.
      let pT = dens.x * 0.95 * wood;
      let pR = dens.z * 0.04;
      if (u < pT) { kind = select(7, 8, hf(h, 19u) < 0.15 + 0.7 * conif); clear = 8.5; rad = 7.0; maxR = 1750.0; ofade = dfade(smoothstep(330.0, 420.0, r), u / pT); }
      else if (u < pT + pR) { kind = 3; clear = 3.5; rad = 3.0; maxR = 700.0; }
    } else if (bi == 4u) {
      // Steppe: a lone tree now and then, stones in loose fields.
      let pT = dens.x * 0.12 * smoothstep(0.6, 0.8, vnoise(p * (1.0 / 300.0) + vec2f(2.0, 2.0)));
      let pR = dens.z * 0.08 * smoothstep(0.5, 0.8, vnoise(p * (1.0 / 200.0) + vec2f(6.0, 3.0)));
      if (u < pT) { kind = 7; clear = 8.5; rad = 7.0; maxR = 1700.0; }
      else if (u < pT + pR) { kind = 3; clear = 3.5; rad = 3.0; maxR = 1000.0; }
    } else if (bi == 5u) {
      // Mountains: spruce beyond the woodland grid, boulders everywhere.
      let pT = dens.x * 0.6 * wood * smoothstep(0.3, 0.6, vnoise(p * (1.0 / 60.0) + vec2f(1.0, 3.0)));
      let pR = dens.z * 0.09 * (1.0 + 1.5 * smoothstep(0.5, 0.8, vnoise(p * (1.0 / 150.0) + vec2f(3.0, 8.0))));
      if (u < pT) { kind = 8; clear = 6.0; rad = 6.0; maxR = 1750.0; ofade = dfade(smoothstep(330.0, 420.0, r), u / pT); }
      else if (u < pT + pR) { kind = 3; clear = 3.5; rad = 3.5; maxR = 1100.0; }
    } else {
      // Coast: stone pines in loose groves on the downs, rocks.
      let pT = dens.x * 0.35 * smoothstep(0.45, 0.75, vnoise(p * (1.0 / 240.0) + vec2f(5.0, 5.0)));
      let pR = dens.z * 0.06;
      // Stone pines and, in rows and pairs, dark cypresses (the spruce mesh drawn narrow).
      if (u < pT) { kind = select(0, 8, hf(h, 19u) < 0.45); clear = 7.5; rad = 7.0; maxR = 1700.0; }
      else if (u < pT + pR) { kind = 3; clear = 3.5; rad = 3.0; maxR = 900.0; }
    }
  } else {
    if (bi == 0u) {
      let pS = dens.y * 0.05 * (0.4 + vnoise(p * (1.0 / 60.0)));
      let pR = dens.z * 0.03;
      if (u < pS) { kind = 2; clear = 1.6; rad = 1.5; maxR = 260.0; }
      else if (u < pS + pR) { kind = 3; clear = 1.2; rad = 0.8; maxR = 260.0; }
    } else if (bi == 1u) {
      let pS = dens.y * 0.07 * smoothstep(0.35, 0.75, vnoise(p * (1.0 / 25.0) + vec2f(6.0, 2.0)));
      let pR = dens.z * 0.035;
      if (u < pS) { kind = 2; clear = 1.4; rad = 1.0; maxR = 230.0; }
      else if (u < pS + pR) { kind = 3; clear = 1.2; rad = 0.8; maxR = 260.0; }
    } else if (bi == 2u) {
      let pS = dens.y * 0.04 * (0.3 + vnoise(p * (1.0 / 45.0)));
      let pR = dens.z * 0.06 * (1.0 - duneField(p));
      if (u < pS) { kind = 2; clear = 3.2; rad = 1.2; maxR = 260.0; }
      else if (u < pS + pR) { kind = 3; clear = 1.2; rad = 0.8; maxR = 260.0; }
    } else {
      // Undergrowth bushes (denser under the forest stands), stones.
      let pS = dens.y * select(0.04, 0.03 + 0.09 * wood, bi == 3u) * (0.4 + vnoise(p * (1.0 / 50.0) + vec2f(3.0, 3.0)));
      let pR = dens.z * 0.03;
      // (Kept 4 m off the verge: a leafy bush sweeping past the first-person lens fills the
      // screen with leaf cards for a few frames, 20+ ms each.)
      if (u < pS) { kind = 2; clear = 4.0; rad = 1.5; maxR = 260.0; }
      else if (u < pS + pR) { kind = 3; clear = 1.2; rad = 0.8; maxR = 260.0; }
    }
  }
  // Every prop fades in over the last 8% of its range instead of appearing at it.
  ofade *= 1.0 - smoothstep(maxR * 0.92, maxR, r);
  if (kind < 0 || ofade <= 0.0) { return; }
  // Toward the desert (or by its river) a savannah tree becomes a date palm or scrub.
  if (kind == 0 && bi == 0u) {
    let wz = biomeWRaw(p).a.z;
    if (wz > 0.1) { kind = select(2, 5, riverDist(p) < 230.0); clear = 3.0; }
  }
  let g = ground(p);
  if (g.d < g.hw + clear) { return; }
  if (g.chan > 0.2 || g.lake > 0.2 || g.sea > 0.1) { return; }
  if (siteClear(p) < 0.5) { return; } // landmark pads, the land-bridge strait
  // Trees thin to a few in a landmark's sight wedge (world.js sightAt): it is seen from the road.
  if ((kind == 0 || kind == 5 || kind == 7 || kind == 8) && sightAt(p) * 0.9 > hf(h, 29u)) { return; }
  // Dwarf shrubs grow on the bare tundra, not out of deep snow.
  if (kind == 2 && bi == 1u && iceSnowV(p, biomeWRaw(p).a.y, g.h - g.low) > 0.1) { return; }
  // Hill and mesa flanks carry thinner, clumpier tree cover than the plain.
  if (kind == 0 && hf(h, 13u) > 1.0 - 0.7 * smoothstep(8.0, 30.0, g.relief)) { return; }
  // Treeline: mountain spruce stays in the valleys and on the lower slopes.
  if (bi == 5u && (kind == 8 || kind == 2) && hf(h, 13u) > 1.0 - smoothstep(60.0, 170.0, g.relief)) { return; }
  // Coast: nothing growing on the beach.
  if (bi == 6u && kind != 3 && g.h - W.sea.x < 3.0) { return; }
  var it: Inst;
  var yaw = hf(h, 4u) * 6.2831853;
  var sxz = 1.0;
  var sy = 1.0;
  var y = g.h;
  // Far trees sink a little: the coarse terrain rings lie below the true surface on convex
  // ground and they must never float.
  let sink = clamp((r - 120.0) * 0.0025, 0.0, 1.6);
  if (kind == 0) {
    sxz = 0.75 + 0.55 * hf(h, 5u); sy = sxz * (0.8 + 0.4 * hf(h, 6u)); y -= 0.1 + sink;
    if (bi == 6u) { sxz *= 1.1; sy *= 1.45; } // stone pine: taller trunk
  }
  else if (kind == 2) {
    sxz = 0.6 + 0.9 * hf(h, 5u); sy = sxz * (0.7 + 0.5 * hf(h, 6u)); y -= 0.1;
    if (bi == 1u) { sxz *= 0.42; sy *= 0.4; } else if (bi == 2u) { sxz *= 1.0; sy *= 0.95; }
  }
  else if (kind == 3) {
    var big = select(0.25 + 0.55 * hf(h, 5u), 0.8 + 2.6 * hf(h, 5u) * hf(h, 7u), G.fine == 0u);
    if (bi == 1u && G.fine == 0u) { big = 1.2 + 4.2 * hf(h, 5u) * sqrt(hf(h, 7u)); y -= big * 0.08; } // erratics
    if (bi == 5u && G.fine == 0u) { big *= 1.4; }
    sxz = big; sy = big * (0.7 + 0.5 * hf(h, 6u)); y -= big * 0.28;
  }
  else if (kind == 4) { sxz = 0.7 + 0.5 * hf(h, 5u); sy = 0.6 + 0.9 * hf(h, 6u); }
  else if (kind == 5) { sxz = 0.8 + 0.4 * hf(h, 5u); sy = 0.7 + 0.6 * hf(h, 6u); y -= 0.1 + sink; }
  else if (kind == 6) {
    sxz = 0.85 + 0.3 * hf(h, 5u); sy = sxz;
    // A herd grazes facing roughly the same way.
    yaw = vnoise(p * (1.0 / 300.0) + vec2f(4.0, 4.0)) * 12.0 + (hf(h, 4u) - 0.5) * 1.2;
  }
  else if (kind == 7) { sxz = 0.8 + 0.4 * hf(h, 5u); sy = sxz * (0.85 + 0.35 * hf(h, 6u)); y -= 0.15 + sink; }
  else if (kind == 8) {
    sxz = 0.75 + 0.45 * hf(h, 5u); sy = sxz * (0.8 + 0.5 * hf(h, 6u)); y -= 0.15 + sink;
    if (bi == 6u) { sxz *= 0.32; sy *= 0.7; } // cypress
  }
  // A third of the palms are young ones (another model), shorter and bushier.
  let young = kind == 5 && hf(h, 16u) < 0.33;
  if (young) { sxz *= 1.1; sy = sxz * (0.85 + 0.35 * hf(h, 17u)); }
  it.a = vec4f(p.x, y, p.y, yaw);
  it.b = vec4f(sxz, sy, f32(bi) + 0.99 * hf(h, 8u), f32(kind));
  let tall = select(2.0, 8.0, kind >= 7);
  let c = vec3f(p.x, y + tall * sy, p.y);
  let R = rad * max(sxz, sy) + 1.0;
  if (visible(c, R)) {
    var iv = it;
    iv.b.w += fcode(ofade, false);
    if (kind == 0) { pushLod(${L_TREE}u, ${L_TREE_FAR}u, r, 240.0 * LODK, it, ofade); }
    else if (kind == 7) { pushLod(${L_BL}u, ${L_BL_FAR}u, r, 150.0 * LODK, it, ofade); }
    else if (kind == 8) { pushLod(${L_CN}u, ${L_CN_FAR}u, r, 150.0 * LODK, it, ofade); }
    else if (kind == 2) { push(select(${L_SHRUB}u, ${L_SCRUB}u, bi == 2u), iv); }
    else if (kind == 3) { push(${L_ROCK}u, iv); }
    else if (kind == 4) { push(${L_MOUND}u, iv); }
    else if (kind == 5) { pushLod(select(${L_PALM}u, ${L_PALM2}u, young), ${L_PALM_FAR}u, r, 200.0, it, ofade); }
    else { push(${L_MAMMOTH}u, iv); }
  }
  // Near shadow casters: inside the near shadow map's light-space box.
  let lp = F.lightViewProj * vec4f(c, 1.0);
  let pad = 1.0 + R / W.shadowC.z;
  if (abs(lp.x) < pad && abs(lp.y) < pad) {
    if (kind == 0) { push(${L_S_TREE}u, it); }
    else if (kind == 7) { push(${L_S_BL}u, it); }
    else if (kind == 8) { push(${L_S_CN}u, it); }
    else if (kind == 2) { push(select(${L_S_SHRUB}u, ${L_S_SCRUB}u, bi == 2u), it); }
    else if (kind == 3) { push(${L_S_ROCK}u, it); }
    else if (kind == 4) { push(${L_S_MOUND}u, it); }
    else if (kind == 5) { push(select(${L_S_PALM}u, ${L_S_PALM2}u, young), it); }
    else { push(${L_S_MAMMOTH}u, it); }
  }
  // Far cascade casters (only when it is re-rendered this frame).
  // (Woodland trees never cast into the cached far cascade: a forest's thousands of trees made
  // each of its re-renders a 25 ms frame; the near cascade has the close ones, and far away the
  // terrain's canopy shading carries the forest.)
  let farOk = kind < 7;
  if (F.shadow1.z > 0.5 && kind != 2 && (kind != 3 || sxz > 0.9) && farOk) {
    let lf = F.lightViewProj1 * vec4f(c, 1.0);
    let padF = 1.0 + R / F.shadow1.y;
    if (abs(lf.x) < padF && abs(lf.y) < padF) {
      if (kind == 0) { push(${L_F_TREE}u, it); }
      else if (kind == 7) { push(${L_F_BL}u, it); }
      else if (kind == 8) { push(${L_F_CN}u, it); }
      else if (kind == 3) { push(${L_F_ROCK}u, it); }
      else if (kind == 5) { push(${L_F_PALM}u, it); }
      else if (kind == 6) { push(${L_F_MAMMOTH}u, it); }
      else { push(${L_F_MOUND}u, it); }
    }
  }
}
`;

const DRAW_COMMON = WORLD_WGSL + PROP_COMMON + /* wgsl */ `
@group(2) @binding(0) var<storage, read> inst: array<Inst>;
struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) me: vec2f };
// Per-instance shape variation (local space, before sway; main and shadow passes agree):
// acacias vary crown spread, flatness and lean, and a few are dead snags (foliage collapsed);
// palms lean and curve by different amounts.
fn ihash(it: Inst) -> f32 { return fract(sin(dot(it.a.xz, vec2f(12.9898, 78.233))) * 43758.547); }
fn vary(lp: vec3f, mat: f32, it: Inst) -> vec3f {
  let k = floor(it.b.w); // (the fraction is the fade code, see the placement pass)
  if (k != 0.0 && k != 5.0) { return lp; }
  let h = ihash(it);
  let h2 = fract(h * 7.31 + 0.13);
  let h3 = fract(h * 13.7 + 0.71);
  var q = lp;
  if (k == 0.0) {
    let crown = smoothstep(2.2, 3.9, lp.y);
    q.x *= 1.0 + crown * (h - 0.35) * 0.7;
    q.z *= 1.0 + crown * (h2 - 0.35) * 0.7;
    q.y = mix(lp.y, 3.7 + (lp.y - 3.7) * (0.55 + 0.75 * h3), crown);
    q.x += (h2 - 0.5) * 0.35 * lp.y * lp.y * 0.2;
    let leaf = (mat > 0.5 && mat < 1.5) || (mat > 5.5 && mat < 6.5);
    if (h3 > 0.93 && leaf) { q = vec3f(0.0, -6.0, 0.0); }
  } else {
    let t = lp.y * (1.0 / 9.0);
    q.x += (h - 0.5) * 2.6 * t * t;
    q.z += (h2 - 0.5) * 1.8 * t * t;
  }
  return q;
}
// Wind sway of foliage (leaf masses, cards, fronds) in local space.
fn sway(lp: vec3f, mat: f32, it: Inst) -> vec3f {
  if (mat < 0.5 || (mat > 1.5 && mat < 5.5) || (mat > 7.5 && mat < 11.5) || mat > 12.5) { return lp; }
  let ph = F.time * 0.9 + it.a.x * 0.05 + it.a.z * 0.03;
  let w = sin(ph) * 0.04 * max(lp.y - 2.0, 0.0);
  let f = sin(F.time * 2.7 + lp.x * 1.3 + lp.z * 1.7 + it.a.x) * 0.05 * select(0.0, 1.0, mat > 5.5);
  return lp + vec3f(w + f, f * 0.6, w * 0.6 - f * 0.5);
}
`;

const MAIN_WGSL = MAIN_HEADER + DRAW_COMMON + /* wgsl */ `
// Debug kill switches (?pdm=<bits>, tools/flicker-test.mjs): 1 flat leaf tone, 2 no shadow on
// props, 4 no sway, 8 opaque leaf cards, 16 no bark / rock noise, 32 full leaf-card detail at
// any distance (as before round three).
override PDM: u32 = 0u;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) lp: vec3f,
  @location(3) @interpolate(flat) m: vec4f, // material, biome + hue / sign code, kind, fade code
  @location(4) uv: vec2f, // leaf cards
};

@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let it = inst[ii];
  var o: VOut;
  let mat = floor(v.me.x + 0.001);
  var lp = sway(vary(v.pos, mat, it), mat, it);
  if ((PDM & 4u) != 0u) { lp = vary(v.pos, mat, it); }
  o.wp = instPos(lp, it);
  o.n = instNrm(v.nrm, it);
  o.lp = v.pos;
  o.m = vec4f(mat, it.b.z, floor(it.b.w), fract(it.b.w)); // material, biome + hue, kind, fade code
  o.uv = vec2f((v.me.x - mat) * 2.0, v.me.y);
  o.pos = F.viewProj * vec4f(o.wp, 1.0);
  return o;
}

fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// Sign face paint: rgb colour and ink amount. code = region + 8 * arrow (0 left, 1 straight,
// 2 right), region 7 = a strait crossing, + 32 when closed, + 64 the ship (from 1492), + 128 the
// modern bridge (else the Ice Age causeway); uv 0..1 across the face as the driver sees it. Each region has its colour and a silhouette: savannah an acacia, ice a snowflake,
// desert a palm by a pyramid, forest a spruce by a round tree, steppe grass under a big sun,
// mountains snow-capped peaks, coast a sail over waves.
fn signPaint(code: i32, uv: vec2f, aa: f32) -> vec4f {
  let region = code % 8;
  let arrow = (code / 8) % 4;
  let closed = ((code / 32) % 2) == 1;
  let cross = code / 64; // 0 causeway, 1 ship, 2 bridge
  var col = vec3f(0.46, 0.28, 0.07); // savannah ochre-brown
  if (region == 1) { col = vec3f(0.06, 0.20, 0.45); } else if (region == 2) { col = vec3f(0.55, 0.14, 0.04); }
  else if (region == 3) { col = vec3f(0.05, 0.25, 0.07); } // forest green
  else if (region == 4) { col = vec3f(0.52, 0.40, 0.08); } // steppe gold
  else if (region == 5) { col = vec3f(0.20, 0.22, 0.32); } // mountain slate
  else if (region == 6) { col = vec3f(0.03, 0.28, 0.50); } // coast azure
  else if (region == 7) { col = vec3f(0.02, 0.27, 0.30); } // land bridge: deep teal
  // Painted frame band in the region colour.
  let fr = min(min(uv.x, 1.0 - uv.x) * 5.8, min(uv.y, 1.0 - uv.y));
  var ink = 1.0 - smoothstep(0.075 - aa, 0.075 + aa, fr);
  // Arrow (left part).
  if (uv.x < 0.27) {
    var a = (uv - vec2f(0.135, 0.5)) * vec2f(5.8 * 0.5, 1.0) * 2.0;
    if (arrow == 2) { a = vec2f(-a.x, a.y); } else if (arrow == 1) { a = vec2f(-a.y, a.x); }
    let shaft = max(abs(a.y) - 0.12, max(-0.1 - a.x, a.x - 0.55));
    let tri = max(abs(a.y) - (a.x + 0.62) * 0.95, max(-0.62 - a.x, a.x + 0.05));
    ink = max(ink, 1.0 - smoothstep(-aa * 4.0, aa * 4.0, min(shaft, tri)));
    return vec4f(vec3f(0.05, 0.04, 0.03), ink);
  }
  // Silhouette (right part), q in a square-ish frame: x in [-1.4, 1.4], y in [-0.5, 0.5].
  let q = (uv - vec2f(0.63, 0.5)) * vec2f(5.8 * 0.36 * 1.4, 1.0);
  var dsh = 1.0;
  if (region == 0) {
    let crown = length((q - vec2f(0.0, 0.17)) * vec2f(1.0, 3.4)) - 0.42;
    let trunk = sdSeg(q, vec2f(-0.02, -0.36), vec2f(0.03, 0.12)) - 0.04;
    let br = min(sdSeg(q, vec2f(0.0, 0.0), vec2f(-0.22, 0.13)), sdSeg(q, vec2f(0.01, 0.02), vec2f(0.25, 0.14))) - 0.025;
    let gnd = max(abs(q.y + 0.38) - 0.025, abs(q.x) - 0.6);
    dsh = min(min(crown, trunk), min(br, gnd));
  } else if (region == 1) {
    // snowflake: six arms with side branches
    let c = q - vec2f(-0.05, 0.02);
    let r = length(c);
    var a = atan2(c.y, c.x);
    let seg = 1.0471976;
    a = abs(a - seg * floor(a / seg + 0.5));
    let pp = vec2f(cos(a), sin(a)) * r;
    let arm = max(abs(pp.y) - 0.03, pp.x - 0.4);
    let b1 = sdSeg(pp, vec2f(0.22, 0.0), vec2f(0.32, 0.09)) - 0.022;
    let b2 = sdSeg(pp, vec2f(0.12, 0.0), vec2f(0.19, 0.07)) - 0.022;
    dsh = min(arm, min(b1, b2));
    dsh = min(dsh, r - 0.06);
  } else if (region == 3) {
    let sp = max(-(q.y + 0.38), (q.y + 0.38) - (0.82 - abs(q.x + 0.25) * 2.4) - 0.06 * sin((q.y + 0.38) * 40.0));
    let crown = length((q - vec2f(0.35, 0.05)) * vec2f(1.0, 1.15)) - 0.27;
    let trunk = sdSeg(q, vec2f(0.35, -0.38), vec2f(0.35, -0.05)) - 0.035;
    let gnd = max(abs(q.y + 0.4) - 0.022, abs(q.x) - 0.75);
    dsh = min(min(sp, crown), min(trunk, gnd));
  } else if (region == 4) {
    let sun = length(q - vec2f(0.25, 0.12)) - 0.17;
    let gnd = max(abs(q.y + 0.36 + 0.04 * sin(q.x * 3.0)) - 0.022, abs(q.x) - 0.95);
    var gr = 1.0;
    for (var k = 0; k < 7; k++) {
      let x0 = -0.75 + f32(k) * 0.25;
      gr = min(gr, sdSeg(q, vec2f(x0, -0.36), vec2f(x0 + 0.1 + 0.03 * f32(k % 2), -0.08 - 0.05 * f32(k % 3))) - 0.018);
    }
    dsh = min(min(sun, gnd), gr);
  } else if (region == 5) {
    let pk1 = max(-(q.y + 0.38), (q.y + 0.38) - (0.78 - abs(q.x + 0.18) * 1.3));
    let pk2 = max(-(q.y + 0.38), (q.y + 0.38) - (0.55 - abs(q.x - 0.45) * 1.2));
    let snow = max(abs(q.y - 0.22) - 0.04, abs(q.x + 0.18) - 0.13);
    dsh = min(min(pk1, pk2), 1.0);
    dsh = max(dsh, -snow); // a band left unpainted: the snow line
  } else if (region == 6) {
    let sail = max(max(-(q.x + 0.05), q.x + 0.05 - (q.y + 0.12) * 0.75), max(-(q.y + 0.12), q.y - 0.42));
    let hull = max(abs(q.y + 0.17) - 0.04, abs(q.x - 0.05) - 0.32 + (q.y + 0.17) * 0.0);
    let w1 = max(abs(q.y + 0.3 + 0.03 * sin(q.x * 14.0)) - 0.02, abs(q.x) - 0.9);
    let w2 = max(abs(q.y + 0.42 + 0.03 * sin(q.x * 14.0 + 1.7)) - 0.02, abs(q.x) - 0.8);
    dsh = min(min(sail, hull), min(w1, w2));
  } else if (region == 2) {
    let pyr2 = max(-(q.y + 0.38), (q.y + 0.38) - (0.62 - abs(q.x - 0.28) * 1.05));
    let sun = length(q - vec2f(0.62, 0.28)) - 0.1;
    let trunk = sdSeg(q, vec2f(-0.36, -0.38), vec2f(-0.3, 0.2)) - 0.035;
    var fr2 = 1.0;
    for (var k = 0; k < 5; k++) {
      let an = 0.35 + f32(k) * 0.6;
      let e = vec2f(cos(an), sin(an) * 0.6 - 0.15) * 0.3;
      fr2 = min(fr2, sdSeg(q, vec2f(-0.3, 0.2), vec2f(-0.3, 0.2) + vec2f(e.x * select(1.0, -1.0, k > 2), e.y)) - 0.03);
    }
    let water = abs(q.y + 0.43 + 0.025 * sin(q.x * 18.0)) - 0.02;
    dsh = min(min(pyr2, sun), min(min(trunk, fr2), water));
  } else if (region == 7 && cross == 1) {
    // ship crossing: a two-masted ship with full square sails over the waves
    let hull = max(abs(q.y + 0.13) - 0.07, abs(q.x) - (0.55 + (q.y + 0.2) * 1.3));
    let m1 = max(abs(q.x + 0.22) - 0.022, max(-(q.y + 0.06), q.y - 0.46));
    let m2 = max(abs(q.x - 0.24) - 0.022, max(-(q.y + 0.06), q.y - 0.38));
    let s1 = max(abs(q.x + 0.22) - 0.17 + 0.25 * abs(q.y - 0.21), abs(q.y - 0.21) - 0.14);
    let s2 = max(abs(q.x - 0.24) - 0.14 + 0.25 * abs(q.y - 0.16), abs(q.y - 0.16) - 0.11);
    let w1 = max(abs(q.y + 0.31 + 0.03 * sin(q.x * 14.0)) - 0.02, abs(q.x) - 0.9);
    let w2 = max(abs(q.y + 0.43 + 0.03 * sin(q.x * 14.0 + 1.7)) - 0.02, abs(q.x) - 0.8);
    dsh = min(min(hull, min(m1, m2)), min(min(s1, s2), min(w1, w2)));
  } else if (region == 7 && cross == 2) {
    // modern bridge: a suspension span between two towers, the deck, waves under it
    let ax = abs(q.x);
    let deck = max(abs(q.y + 0.05) - 0.035, ax - 1.05);
    let tw = max(abs(ax - 0.5) - 0.045, max(-(q.y + 0.38), q.y - 0.38));
    let cy = select(0.38 * (1.0 - (ax - 0.5) * 2.0), 0.38 * ax * ax * 4.0, ax < 0.5) - 0.02;
    let cab = max(abs(q.y - cy) * 0.75 - 0.016, ax - 1.0);
    let hang = max(max(abs(fract(q.x * 6.0) - 0.5) / 6.0 - 0.008, max(-(q.y + 0.05), q.y - cy)), ax - 0.98);
    let w1 = max(abs(q.y + 0.3 + 0.03 * sin(q.x * 14.0)) - 0.02, ax - 0.9);
    let w2 = max(abs(q.y + 0.42 + 0.03 * sin(q.x * 14.0 + 1.7)) - 0.02, ax - 0.8);
    dsh = min(min(deck, tw), min(min(cab, hang), min(w1, w2)));
  } else if (region == 7) {
    // land bridge: a causeway deck on piers over two rows of waves, far shore hills
    let deck = max(abs(q.y + 0.02) - 0.045, abs(q.x) - 0.95);
    let pier = max(abs(fract(q.x * 1.6 + 0.5) - 0.5) / 1.6 - 0.035, max(q.y + 0.02, -(q.y + 0.3)));
    let w1 = abs(q.y + 0.27 + 0.03 * sin(q.x * 14.0)) - 0.02;
    let w2 = max(abs(q.y + 0.41 + 0.03 * sin(q.x * 14.0 + 1.7)) - 0.02, abs(q.x) - 0.85);
    let hill = max(length((q - vec2f(0.75, -0.02)) * vec2f(1.0, 2.2)) - 0.42, -(q.y + 0.02));
    dsh = min(min(deck, max(pier, abs(q.x) - 0.95)), min(min(w1, w2), hill));
  }
  if (closed) {
    // struck through: a bold red bar across the glyph
    let bar = abs(dot(q, vec2f(0.38, 0.92))) - 0.06;
    let bk = 1.0 - smoothstep(-aa * 3.0, aa * 3.0, max(bar, abs(q.x) - 1.0));
    let sil0 = 1.0 - smoothstep(-aa * 3.0, aa * 3.0, dsh);
    if (bk > 0.0) { return vec4f(mix(col, vec3f(0.62, 0.06, 0.04), bk), max(max(ink, sil0), bk)); }
  }
  let sil = 1.0 - smoothstep(-aa * 3.0, aa * 3.0, dsh);
  return vec4f(col, max(ink, sil));
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let duv = fwidth(i.uv);
  let daa = max(duv.x, duv.y);
  let fwp = fwidth(i.wp);
  let fwl = max(max(fwp.x, fwp.y), fwp.z);
  var n = normalize(i.n);
  let mat = i32(i.m.x + 0.5);
  if (!ff && mat != 6 && mat != 7 && mat != 12) { n = -n; }
  let bi = u32(i.m.y);
  let hue = fract(i.m.y);
  let row = min(bi, 6u) * BK;
  let wp = i.wp;
  var n1 = vnoise(wp.xz * 1.3 + wp.y * 0.7);
  var n2 = vnoise(vec2f(wp.x + wp.z, wp.y) * 6.0);
  if ((PDM & 16u) != 0u) { n1 = 0.5; n2 = 0.5; }
  var alb = vec3f(0.3);
  var ao = 1.0;
  var trans = 0.0;
  var alpha = 1.0;
  var spec = 0.03;
  var rough = 0.8;
  if (mat == 0) {
    alb = W.bp[row + B_BARK].rgb * (0.7 + 0.5 * n2) * (0.9 + 0.2 * hue);
    ao = 0.6 + 0.4 * smoothstep(0.0, 2.0, i.lp.y);
  } else if (mat == 1 || mat == 6 || mat == 14) {
    // Leaves: clumps lighter at the sunlit outside, darker inside and underneath.
    var cl = vnoise(wp.xz * 2.7 + wp.y * 3.1) * 0.6 + vnoise(wp.xz * 7.0 - wp.y * 5.0) * 0.4;
    if ((PDM & 1u) != 0u) { cl = 0.5; }
    alb = W.bp[row + B_LEAF].rgb * (0.65 + 0.7 * cl) * mix(vec3f(0.9, 1.0, 0.85), vec3f(1.15, 1.05, 0.8), hue);
    let under = smoothstep(0.2, -0.6, n.y);
    ao = mix(1.0, 0.45, under) * (0.75 + 0.25 * cl);
    trans = 0.6;
    if (i.m.z == 2.0) { alb *= select(vec3f(1.25, 1.2, 1.0), vec3f(1.5, 1.2, 1.0), bi == 1u); }
    if (bi == 2u && i.m.z == 2.0) { alb = vec3f(0.16, 0.17, 0.11) * (0.7 + 0.6 * cl); } // grey-green scrub
    if (mat == 1) { alb *= 0.6; ao *= 0.7; } // inner mass reads as depth between clumps
    else if (mat == 14) { alb *= 1.15; ao = mix(0.8, 1.0, smoothstep(-0.2, 0.6, n.y)); }
    else {
      // Leaf-clump card: lobed outline with small holes, alpha to coverage.
      let q = i.uv * 2.0 - 1.0;
      let sd = vnoise(i.uv * 4.0 + i.lp.xz * 3.1) - 0.5;
      let holes = smoothstep(0.32, 0.22, vnoise(i.uv * 11.0 + i.lp.zx * 5.0));
      // Detail the pixel grid cannot hold fades out with the card's size on screen (daa: card
      // uv per pixel): the holes (11 per card) by ~25 px across, the lobes (4 per card) by
      // ~10 px. Kept, they alias into a sparkle that crawls over every crown while driving.
      var hk = 1.0 - smoothstep(0.012, 0.04, daa);
      var lk = 1.0 - smoothstep(0.035, 0.1, daa);
      if ((PDM & 32u) != 0u) { hk = 1.0; lk = 1.0; }
      let a0 = 1.0 - dot(q, q) * 1.15 + sd * 0.9 * lk - holes * 0.6 * hk;
      alpha = saturate((a0 - 0.15) / max(daa * 3.0, 1e-3) + 0.5);
      if ((PDM & 8u) != 0u) { alpha = 1.0; }
      alb *= 0.9 + 0.25 * (1.0 - length(q));
    }
  } else if (mat == 2) {
    alb = W.bp[row + B_ROCK].rgb * (0.75 + 0.35 * n1) * (0.85 + 0.25 * n2) * mix(vec3f(1.0), vec3f(1.1, 0.95, 0.85), hue);
    if (bi == 1u) {
      // Erratics: pale speckled granite with snow lying on top.
      alb = vec3f(0.46, 0.45, 0.44) * (0.75 + 0.4 * n1) * (0.85 + 0.3 * vnoise(wp.xz * 9.0 + wp.y * 7.0));
      alb = mix(alb, vec3f(0.74, 0.79, 0.86), smoothstep(0.6, 0.8, n.y + 0.15 * (n2 - 0.5)) * smoothstep(0.15, 0.5, i.lp.y));
    } else if (bi == 2u) {
      alb = W.bp[row + B_ROCK].rgb * vec3f(1.1, 0.95, 0.85) * (0.7 + 0.4 * n1) * (0.85 + 0.25 * n2);
      alb = mix(alb, alb * vec3f(0.62, 0.48, 0.40), smoothstep(0.3, 0.8, n.y) * 0.6); // desert varnish
    } else if (bi >= 3u) {
      // Forest / mountain stone: moss or lichen on top; steppe and coast: pale and clean.
      let top = smoothstep(0.45, 0.85, n.y + 0.2 * (n2 - 0.5));
      if (bi == 3u) { alb = mix(alb, vec3f(0.07, 0.12, 0.03) * (0.8 + 0.4 * n1), top * 0.75); }
      else if (bi == 5u) { alb = mix(alb, vec3f(0.30, 0.31, 0.22), top * smoothstep(0.55, 0.75, vnoise(wp.xz * 2.0 + wp.y)) * 0.6); }
      else { alb *= vec3f(1.05, 1.02, 0.97); }
    } else {
      // Savannah granite: warm, lichen-spotted, red dust settled on top.
      alb *= vec3f(1.12, 1.0, 0.84);
      alb = mix(alb, vec3f(0.42, 0.36, 0.16), smoothstep(0.62, 0.8, vnoise(wp.xz * 3.0 + wp.y * 2.0)) * 0.35);
      alb = mix(alb, W.bp[row + B_SOIL].rgb * 1.2, smoothstep(0.5, 0.95, n.y) * 0.4);
    }
    ao = 0.8 + 0.2 * smoothstep(-0.2, 0.6, n.y + i.lp.y * 0.6);
  } else if (mat == 3) {
    alb = W.bp[row + B_MOUND].rgb * (0.8 + 0.3 * n1) * (0.85 + 0.2 * vnoise(vec2f(atan2(i.lp.z, i.lp.x) * 6.0, i.lp.y * 3.0)));
    ao = 0.65 + 0.35 * smoothstep(0.0, 1.2, i.lp.y);
  } else if (mat == 4) {
    alb = vec3f(0.24, 0.17, 0.11) * (0.75 + 0.4 * vnoise(vec2f(i.lp.x * 3.0, i.lp.y * 40.0 + i.lp.z * 40.0)));
  } else if (mat == 5) {
    // Sign face: lime-washed board with the exit's region painted on.
    let uv = vec2f((i.lp.x - 0.08) / 1.16, (i.lp.y + ${BOARD_H}) / ${BOARD_H * 2});
    var u2 = uv;
    if (i.lp.z < 0.0) { u2.x = 1.0 - uv.x; }
    let aa = max(fwl / (1.16 * 1.7), 0.002);
    let pc = signPaint(i32(i.m.y + 0.5), u2, aa);
    alb = mix(vec3f(0.78, 0.74, 0.64) * (0.88 + 0.16 * n2), pc.rgb, pc.a);
  } else if (mat == 13) {
    // Timber bridge: weathered silver-brown planks laid across the deck with dark gaps, each
    // plank its own tone; posts, rails and piles in long grain, darker and damp low down.
    let lp = i.lp;
    let aa = max(fwl, 0.004);
    let g1 = vnoise(vec2f(lp.x * 2.0 + lp.z * 0.3, lp.y * 30.0 + lp.z * 9.0));
    var c = vec3f(0.36, 0.30, 0.23) * (0.8 + 0.35 * g1) * (0.9 + 0.15 * n2);
    if (n.y > 0.8 && lp.y > -0.06) {
      let pl = lp.x / 0.28;
      let fp = fract(pl);
      let hs = hash2(i32(floor(pl)) + i32(i.wp.x * 0.125) * 37, i32(i.wp.z * 0.125) * 53);
      c = mix(vec3f(0.33, 0.29, 0.24), vec3f(0.48, 0.42, 0.34), hs) * (0.82 + 0.3 * vnoise(vec2f(lp.x * 3.0, lp.z * 0.7 + hs * 9.0)));
      c = mix(vec3f(0.07, 0.06, 0.05), c, smoothstep(0.03, 0.07 + aa * 3.0, min(fp, 1.0 - fp)));
      c = mix(c, vec3f(0.52, 0.42, 0.30), smoothstep(0.6, 0.85, vnoise(i.wp.xz * 0.5)) * 0.35); // dust
    } else {
      c *= mix(0.45, 1.0, smoothstep(-2.2, -0.6, lp.y)); // wet piles
      ao = mix(1.0, 0.55, select(0.0, 1.0, n.y < -0.3));
    }
    alb = c;
    rough = 0.8;
  } else if (mat == 7 || mat == 12) {
    // Palm frond: pinnate leaflets either side of the rachis.
    let x = abs(i.uv.x - 0.5) * 2.0;
    let v = i.uv.y;
    let env = smoothstep(0.02, 0.16, v) * (1.0 - smoothstep(0.8, 1.0, v));
    let st = fract(v * 30.0 + x * 1.9);
    let leaflet = min(env * (1.0 - x * 0.15) - x, 0.42 - abs(st - 0.42) * 1.6);
    let rach = 0.07 - x;
    let a0 = max(leaflet * 6.0, rach * 8.0);
    alpha = saturate(a0 / max(daa * 6.0, 1e-3) + 0.5);
    let base = select(W.bp[row + B_LEAF].rgb * mix(vec3f(0.95, 1.0, 0.9), vec3f(1.2, 1.15, 0.85), hue), vec3f(0.30, 0.20, 0.10), mat == 12);
    alb = base * (0.8 + 0.4 * x) * (0.85 + 0.3 * vnoise(vec2f(v * 9.0, x * 3.0) + i.lp.xz));
    trans = select(0.8, 0.3, mat == 12);
    ao = 0.65 + 0.35 * v;
  } else if (mat == 8) {
    // Palm trunk: diamond pattern of old leaf bases.
    let ang = atan2(i.lp.z, i.lp.x - i.lp.y * i.lp.y * 0.0086);
    let d1 = fract(i.lp.y * 2.6 + ang * 0.95);
    let d2 = fract(i.lp.y * 2.6 - ang * 0.95);
    let boot = smoothstep(0.0, 0.15, min(d1, d2)) * smoothstep(1.0, 0.75, max(d1, d2));
    alb = W.bp[row + B_BARK].rgb * (0.55 + 0.6 * boot) * (0.85 + 0.3 * n2);
    ao = 0.6 + 0.4 * boot;
  } else if (mat == 9) {
    alb = vec3f(0.42, 0.18, 0.05) * (0.7 + 0.6 * vnoise(wp.xz * 20.0 + wp.y * 17.0));
    ao = 0.6;
  } else if (mat == 10) {
    // Mammoth: long brown hair, darker below, streaks running down the body.
    let streak = vnoise(vec2f((i.lp.x + i.lp.z) * 6.0, i.lp.y * 0.9)) * 0.6 + vnoise(vec2f((i.lp.x - i.lp.z) * 17.0, i.lp.y * 2.0)) * 0.4;
    alb = W.bp[row + B_MOUND].rgb * (0.6 + 0.7 * streak) * mix(0.55, 1.0, smoothstep(0.8, 2.6, i.lp.y));
    ao = 0.55 + 0.45 * smoothstep(0.5, 2.5, i.lp.y);
    rough = 0.6; spec = 0.04;
  } else {
    alb = vec3f(0.62, 0.56, 0.44) * (0.85 + 0.2 * n2);
    spec = 0.05; rough = 0.4;
  }
  // Lambert sun with shadow + sky ambient, from the lighting probe (as shadeLambert).
  let ndl = max(dot(n, F.sunDir), 0.0);
  var sh = 1.0;
  if ((ndl > 0.0 || trans > 0.0) && (PDM & 2u) == 0u) { sh = shadowAt(wp, n); }
  let sunL = probeSun();
  var col = alb * (sunL * (ndl * sh / PI) + probeAmb(n) * (ao / PI));
  if (trans > 0.0) {
    let v = normalize(F.camPos - wp);
    let back = pow(max(dot(-v, F.sunDir), 0.0), 4.0);
    col += alb * vec3f(1.1, 1.0, 0.6) * sunL * back * trans * 0.25 * sh;
  }
  col = applyFog(col, wp);
  // Fading prop (placement fade code): its opacity through alpha to coverage. (Not a
  // screen-space dither: a pattern fixed to the screen crawls over a moving tree, which
  // measured as five times more shimmer on the tree line than the pops it replaced.)
  let fc = i.m.w;
  if (fc > 0.0) { alpha *= 1.0 - (fc - select(0.0, 0.5, fc >= 0.5)) * (1.0 / 0.49); }
  return vec4f(col, alpha);
}
`;

const SHADOW_WGSL = SHADOW_HEADER + DRAW_COMMON + /* wgsl */ `
@vertex fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let it = inst[ii];
  let mat = floor(v.me.x + 0.001);
  return F.lightViewProj * vec4f(instPos(sway(vary(v.pos, mat, it), mat, it), it), 1.0);
}
`;

let placePipe, mainPipe, shPipe, vbuf, ibuf, argsBuf, instBuf, signBuf, signBG;
let cBG0;
const gridBGs = [], gridBufs = [];
const listBGs = [];
let meshRanges;
// Coarse grid (trees, palms, mounds, boulders, mammoths), fine grid (shrubs, stones) and the
// woodland grid (forest and mountain trees within ~420 m, denser than the coarse grid allows).
const GRIDS = [[20, 1750, 0], [5, 270, 1], [9, 420, 2]];
const gridData = new Int32Array(8 * GRIDS.length);
const gridF = new Float32Array(gridData.buffer);
const gridDispatch = new Uint32Array(GRIDS.length * 2);

export async function initProps(seed) {
  const d = gpu.device;
  const meshes = [acacia(0), acacia(2), shrub(true), rock(), mound(), palm(false), mammoth(), acacia(1), shrub(false), post(), board(), palm(true), bridge(), youngPalm(), scrub(), cairn(),
    broadleaf(false), broadleaf(true), conifer(false), conifer(true)];
  const pk = packMeshes(meshes);
  meshRanges = pk.ranges;
  vbuf = d.createBuffer({ size: pk.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(vbuf, 0, pk.vertices);
  ibuf = d.createBuffer({ size: pk.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ibuf, 0, pk.indices);

  let off = 0;
  for (let l = 0; l < NL; l++) {
    listBase[l] = off;
    off += Math.ceil(CAP[l] * 32 / 256) * 256 / 32;
    const r = meshRanges[MESH_OF[l]];
    argsInit[l * 5] = r.indexCount; argsInit[l * 5 + 1] = 0; argsInit[l * 5 + 2] = r.firstIndex; argsInit[l * 5 + 3] = r.baseVertex; argsInit[l * 5 + 4] = 0;
  }
  instBuf = d.createBuffer({ size: off * 32, usage: GPUBufferUsage.STORAGE | (PDBG ? GPUBufferUsage.COPY_SRC : 0) });
  argsBuf = d.createBuffer({ size: NL * 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | (PDBG ? GPUBufferUsage.COPY_SRC : 0) });
  signBuf = d.createBuffer({ size: signData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

  const C = GPUShaderStage.COMPUTE, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const bgl0 = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: C, buffer: {} }] });
  cBG0 = d.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: gpu.frameBuffer } }] });
  const bglG = d.createBindGroupLayout({ entries: [
    { binding: 0, visibility: C, buffer: {} },
    { binding: 1, visibility: C, buffer: { type: 'storage' } },
    { binding: 2, visibility: C, buffer: { type: 'storage' } },
  ] });
  for (let g = 0; g < GRIDS.length; g++) {
    const ub = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    gridBufs.push(ub);
    gridBGs.push(d.createBindGroup({ layout: bglG, entries: [
      { binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: instBuf } }, { binding: 2, resource: { buffer: argsBuf } },
    ] }));
  }
  const bglI = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } }] });
  for (let l = 0; l < NL; l++) {
    listBGs.push(d.createBindGroup({ layout: bglI, entries: [{ binding: 0, resource: { buffer: instBuf, offset: listBase[l] * 32, size: CAP[l] * 32 } }] }));
  }
  signBG = d.createBindGroup({ layout: bglI, entries: [{ binding: 0, resource: { buffer: signBuf } }] });

  const constants = { SEED: seed };
  const placeCode = PLACE_WGSL.replace('BASE_LIST', Array.from(listBase, (b) => b + 'u').join(', '));
  const pm = d.createShaderModule({ label: 'props-place', code: placeCode });
  const mm = d.createShaderModule({ label: 'props', code: MAIN_WGSL });
  const sm = d.createShaderModule({ label: 'props-sh', code: SHADOW_WGSL });
  const layouts = [world.bgl, bglI];
  [placePipe, mainPipe, shPipe] = await Promise.all([
    d.createComputePipelineAsync({ layout: d.createPipelineLayout({ bindGroupLayouts: [bgl0, world.bgl, bglG] }), compute: { module: pm, entryPoint: 'place', constants: LODK_Q ? { ...constants, LODK: LODK_Q } : constants } }),
    mainPipeline({ label: 'props', module: mm, layouts, buffers: VERTEX_LAYOUT, cullMode: 'none', constants: PDM_Q ? { ...constants, PDM: PDM_Q } : constants, alphaToCoverage: true }),
    shadowPipeline({ label: 'props-sh', module: sm, vertex: 'vsShadow', layouts, buffers: VERTEX_LAYOUT, constants }),
  ]);

  await initWeather(seed); // spindrift / drifting sand (drawn after the props)
  addPrePass({ pre: placeProps });
  const HIDE = /[?&]hide=[^&]*props/.test(location.search); // debug: ?hide=grass,props
  if (!HIDE) addDrawable({
    shadow(p) {
      p.setPipeline(shPipe); p.setBindGroup(1, world.bg);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32');
      const L = gpu.cascade === 1 ? FAR_SH_LISTS : NEAR_SH_LISTS;
      for (let k = 0; k < L.length; k++) { const l = L[k]; p.setBindGroup(2, listBGs[l]); p.drawIndexedIndirect(argsBuf, l * 20); }
      drawSigns(p);
    },
    main(p) {
      p.setPipeline(mainPipe); p.setBindGroup(1, world.bg);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32');
      for (let k = 0; k < MAIN_LISTS.length; k++) { const l = MAIN_LISTS[k]; p.setBindGroup(2, listBGs[l]); p.drawIndexedIndirect(argsBuf, l * 20); }
      drawSigns(p);
    },
  });
}

function drawSigns(p) {
  if (!nSign && !nBridge && !nCairn) return;
  p.setBindGroup(2, signBG);
  // Instances [0, nPost) are posts, the rest boards.
  const rp = meshRanges[M_POST], rb = meshRanges[M_BOARD];
  p.drawIndexed(rp.indexCount, nPost, rp.firstIndex, rp.baseVertex, 0);
  if (nSign > nPost) p.drawIndexed(rb.indexCount, nSign - nPost, rb.firstIndex, rb.baseVertex, nPost);
  if (nBridge) { const r = meshRanges[M_BRIDGE]; p.drawIndexed(r.indexCount, nBridge, r.firstIndex, r.baseVertex, MAX_SIGN); }
  if (nCairn) { const r = meshRanges[M_CAIRN]; p.drawIndexed(r.indexCount, nCairn, r.firstIndex, r.baseVertex, MAX_SIGN + MAX_BRIDGE); }
}
let nPost = 0;

// Rebuilds signpost instances when the graph changed. One post per fork on its incoming
// road (right-hand side, ~60 m before the junction); one board per exit pointing down it.
function updateSigns() {
  if (graph.dirty === signDirty) return;
  signDirty = graph.dirty;
  nPost = 0;
  let nb = 0;
  // Posts first, then boards (stored after MAX_SIGN/2).
  const half = MAX_SIGN / 2;
  for (let n = 0; n < MAX_NODES; n++) {
    if (!nodeAlive[n] || nodeExitCount[n] < 2) continue;
    const ie = nodeIn[n];
    if (ie < 0 || !edgeAlive[ie] || nPost >= half - 1) continue;
    const s = edgeLen[ie] - 60;
    const c = surfaceCurve;
    const sf = c.a + (c.b - c.a) * smoothstep(c.d0, c.d1, edgeJ0[ie] + s);
    pt4[4] = s; pt4[5] = halfWidth(sf) + 2.2;
    frameAt(ie, pt4);
    const x = pt4[0], z = pt4[2], hIn = pt4[3];
    const y = groundAt(x, z);
    let o = nPost * 8;
    signData[o] = x; signData[o + 1] = y; signData[o + 2] = z; signData[o + 3] = 0;
    signData[o + 4] = SIGN_SCALE; signData[o + 5] = SIGN_SCALE; signData[o + 6] = 0; signData[o + 7] = 5;
    nPost++;
    const cnt = nodeExitCount[n];
    for (let i = 0; i < cnt && nb < half; i++) {
      // Boards stacked top to bottom = exits left to right, facing the driver and reaching
      // over toward the road. Glyph code = region + 8 * arrow (0 left, 1 straight, 2 right).
      const a = exitAngle(n, i);
      const arrow = cnt === 3 ? i : (i === 0 ? (a < -0.12 ? 0 : 1) : (a > 0.12 ? 2 : 1));
      o = (half + nb) * 8;
      signData[o] = x; signData[o + 1] = y + (2.4 - i * (BOARD_H * 2 + 0.12)) * SIGN_SCALE; signData[o + 2] = z;
      // Turned slightly toward the approaching driver (and so toward more of the sky).
      signData[o + 3] = hIn - Math.PI / 2 - 0.25;
      // The land bridge has its own glyph (code region 7), struck through once it is closed (+32).
      // Ferry exits (from 1492) show the ship or, when the car will find it built, the bridge.
      const glyph = exitIsBridge(n, i) ? 7 + (exitAvailable(n, i) ? 0 : 32) + 64 * crossingKind(n, i) : exitRegion(n, i);
      signData[o + 4] = SIGN_SCALE; signData[o + 5] = SIGN_SCALE; signData[o + 6] = glyph + 8 * arrow; signData[o + 7] = 6;
      nb++;
    }
  }
  // Compact boards right after posts.
  signData.copyWithin(nPost * 8, half * 8, (half + nb) * 8);
  nSign = nPost + nb;
  if (nSign) gpu.device.queue.writeBuffer(signBuf, 0, signData, 0, nSign * 8);
  updateBridges();
  updateCairns();
}

// Inside a landmark pad or the strait (sites.js / world.js siteData)?
function onPad(x, z) {
  for (let i = 0; i < 16; i += 4) {
    const R = siteData[i + 2];
    if (R <= 0) continue;
    const dx = x - siteData[i], dz = z - siteData[i + 1];
    if (dx * dx + dz * dz < (R + 10) * (R + 10)) return true;
  }
  return straitAt(x, z) > 0.05;
}

// Cairns: every ~40 m along ice and desert roads (once the road's own region has taken over
// from its parent's), alternating sides, just off the verge. Rebuilt on graph changes.
let nCairn = 0;
function updateCairns() {
  nCairn = 0;
  const c = surfaceCurve;
  for (let e = 0; e < MAX_EDGES && nCairn < MAX_CAIRN; e++) {
    if (!edgeAlive[e] || edgeRegion[e] === 0) continue;
    const L = Math.min(edgeLen[e], edgeDrawEnd[e]) - 30;
    let side = 1;
    for (let s = 470 + (e % 3) * 13; s < L && nCairn < MAX_CAIRN; s += 38 + ((s * 7) % 11)) {
      const sf = c.a + (c.b - c.a) * smoothstep(c.d0, c.d1, edgeJ0[e] + s);
      pt4[4] = s; pt4[5] = side * (halfWidth(sf) + 1.5 + ((s * 13) % 7) * 0.12);
      frameAt(e, pt4);
      if (onPad(pt4[0], pt4[2])) { side = -side; continue; }
      const o = (MAX_SIGN + MAX_BRIDGE + nCairn) * 8;
      groundOut[6] = pt4[0]; groundOut[7] = pt4[2]; groundInfo(groundOut);
      signData[o] = pt4[0]; signData[o + 1] = groundOut[0] - 0.08; signData[o + 2] = pt4[2]; signData[o + 3] = s * 1.7;
      const sc = 0.85 + ((s * 3) % 5) * 0.08;
      signData[o + 4] = sc; signData[o + 5] = sc * (0.9 + ((s * 5) % 3) * 0.1); signData[o + 6] = edgeRegion[e] + 0.37; signData[o + 7] = 3;
      nCairn++;
      side = -side;
    }
  }
  if (nCairn) gpu.device.queue.writeBuffer(signBuf, (MAX_SIGN + MAX_BRIDGE) * 32, signData, (MAX_SIGN + MAX_BRIDGE) * 8, nCairn * 8);
}

// Bridges: wherever a road crosses the river channel (same channel weight as the terrain's
// bridgeCut, from the CPU mirrors), a row of arch segments spans it, padded onto the banks.
let nBridge = 0;
const bq = new Float64Array(10);
const bsp = new Float64Array(4);
function channelAt(e, s) { // -> bsp[0] channel weight, bsp[1..3] x, road y, z (pt4 = frame)
  pt4[4] = s; pointAt(e, pt4);
  bsp[1] = pt4[0]; bsp[2] = pt4[1]; bsp[3] = pt4[2];
  NIO[0] = pt4[0]; NIO[1] = pt4[2]; noiseRiverDist();
  bsp[0] = 0;
  if (NIO[2] < 22) {
    noiseRiverBank();
    bq[0] = pt4[0]; bq[1] = pt4[2]; biomeExactAt(bq);
    bsp[0] = (1 - smoothstep(11, 17, NIO[2] + NIO[3])) * bq[4];
  }
}
function emitBridge(e, a, b) {
  const k = Math.ceil((b - a) / BR_LEN);
  const s0 = (a + b) * 0.5 - k * BR_LEN * 0.5 + BR_LEN * 0.5;
  for (let i = 0; i < k && nBridge < MAX_BRIDGE; i++) {
    pt4[4] = s0 + i * BR_LEN; pointAt(e, pt4);
    const o = (MAX_SIGN + nBridge) * 8;
    signData[o] = pt4[0]; signData[o + 1] = pt4[1] + 0.005; signData[o + 2] = pt4[2]; signData[o + 3] = pt4[3];
    signData[o + 4] = 1; signData[o + 5] = 1; signData[o + 6] = 2; signData[o + 7] = 13;
    nBridge++;
  }
}
function updateBridges() {
  nBridge = 0;
  for (let e = 0; e < MAX_EDGES; e++) {
    if (!edgeAlive[e]) continue;
    const L = Math.min(edgeLen[e], edgeDrawEnd[e]);
    let open = -1;
    for (let s = 0; s <= L; s += 3) {
      channelAt(e, s);
      const wet = bsp[0] > 0.1;
      if (wet && open < 0) open = s;
      if (open >= 0 && (!wet || s + 3 > L)) { emitBridge(e, open - 7, s + 4); open = -1; }
    }
  }
  if (nBridge) gpu.device.queue.writeBuffer(signBuf, MAX_SIGN * 32, signData, MAX_SIGN * 8, nBridge * 8);
}

export function updateProps() {
  updateSigns();
  // Grid domains: square around the camera (props are sparse, culling happens per cell).
  const ex = camera.eye[0], ez = camera.eye[2];
  for (let g = 0; g < GRIDS.length; g++) {
    const G = GRIDS[g], cell = G[0], R = G[1];
    const ox = Math.floor((ex - R) / cell), oz = Math.floor((ez - R) / cell);
    const nx = Math.ceil((ex + R) / cell) - ox, nz = Math.ceil((ez + R) / cell) - oz;
    const o = g * 8;
    gridData[o] = ox; gridData[o + 1] = oz; gridData[o + 2] = nx; gridData[o + 3] = nz;
    gridF[o + 4] = cell; gridF[o + 5] = R; gridData[o + 6] = G[2]; gridData[o + 7] = 0;
    gridDispatch[g * 2] = Math.ceil(nx / 8); gridDispatch[g * 2 + 1] = Math.ceil(nz / 8);
  }
}

// Debug (?propdbg=1, allocates; tools/flicker-test.mjs): reads back every list's instance
// count (window.__propDbg.count / over) and, while __propDbg.rec > 0, the main tree lists of
// that many consecutive frames ({ n, cnt, base, inst (Float32Array of the whole instance
// buffer), vp (camera viewProj) } in __propDbg.recs).
const PDBG = typeof location !== 'undefined' && /[?&]propdbg=1/.test(location.search);
const PDBG_N = 12;
const pdbgBufs = [], pdbgInst = [], pdbgBusy = new Uint8Array(PDBG_N);
export const TREE_LISTS = [L_TREE, L_TREE_FAR, L_BL, L_BL_FAR, L_CN, L_CN_FAR, L_PALM, L_PALM_FAR, L_PALM2];
function propDbg(enc) {
  if (!pdbgBufs.length) {
    for (let k = 0; k < PDBG_N; k++) {
      pdbgBufs.push(gpu.device.createBuffer({ size: NL * 20, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
      pdbgInst.push(gpu.device.createBuffer({ size: instBuf.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    }
    window.__propDbg = { cap: CAP, base: Array.from(listBase), lists: TREE_LISTS, count: new Uint32Array(NL), over: new Uint32Array(NL), frames: 0, rec: 0, recs: [], missed: 0 };
  }
  const D = window.__propDbg;
  for (let k = 0; k < PDBG_N; k++) {
    if (pdbgBusy[k]) continue;
    pdbgBusy[k] = 1;
    const rec = D.rec > 0;
    if (rec) D.rec--;
    const fno = state.frame, ts = performance.now(), vp = rec ? new Float32Array(camera.viewProj) : null, eye = rec ? Array.from(camera.eye) : null;
    enc.copyBufferToBuffer(argsBuf, 0, pdbgBufs[k], 0, NL * 20);
    if (rec) enc.copyBufferToBuffer(instBuf, 0, pdbgInst[k], 0, instBuf.size);
    setTimeout(() => Promise.all([pdbgBufs[k].mapAsync(GPUMapMode.READ), rec ? pdbgInst[k].mapAsync(GPUMapMode.READ) : null]).then(() => {
      const u = new Uint32Array(pdbgBufs[k].getMappedRange());
      const cnt = new Uint32Array(NL);
      for (let l = 0; l < NL; l++) { cnt[l] = u[l * 5 + 1]; D.count[l] = cnt[l]; if (cnt[l] >= CAP[l]) D.over[l]++; }
      D.frames++;
      if (rec) {
        // Compact: x, y, z, list, fade code (fract of b.w) of every tree instance.
        const f = new Float32Array(pdbgInst[k].getMappedRange());
        let n = 0; for (const l of TREE_LISTS) n += Math.min(cnt[l], CAP[l]);
        const t = new Float32Array(n * 5); let j = 0;
        for (const l of TREE_LISTS) for (let i = 0; i < Math.min(cnt[l], CAP[l]); i++) { const o = (listBase[l] + i) * 8; t[j++] = f[o]; t[j++] = f[o + 1]; t[j++] = f[o + 2]; t[j++] = l; t[j++] = f[o + 7] - Math.floor(f[o + 7]); }
        D.recs.push({ n: fno, ts, trees: t, vp, eye }); pdbgInst[k].unmap();
      }
      pdbgBufs[k].unmap(); pdbgBusy[k] = 0;
    }, () => { pdbgBusy[k] = 0; }), 0);
    return;
  }
  if (D.rec > 0) D.missed++;
}

const LODK_Q = typeof location !== 'undefined' ? Number((/[?&]lodk=([\d.]+)/.exec(location.search) || [])[1] || 0) : 0;
const PDM_Q = typeof location !== 'undefined' ? Number((/[?&]pdm=(\d+)/.exec(location.search) || [])[1] || 0) : 0;

const cDesc = { timestampWrites: undefined };
function placeProps(enc) {
  const q = gpu.device.queue;
  q.writeBuffer(argsBuf, 0, argsInit);
  for (let g = 0; g < GRIDS.length; g++) q.writeBuffer(gridBufs[g], 0, gridData, g * 8, 8);
  cDesc.timestampWrites = tsw();
  const p = enc.beginComputePass(cDesc);
  p.setPipeline(placePipe);
  p.setBindGroup(0, cBG0);
  p.setBindGroup(1, world.bg);
  for (let g = 0; g < GRIDS.length; g++) {
    p.setBindGroup(2, gridBGs[g]);
    p.dispatchWorkgroups(gridDispatch[g * 2], gridDispatch[g * 2 + 1]);
  }
  p.end();
  if (PDBG) propDbg(enc);
}
