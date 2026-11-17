// Landmark kit: the shared builder, primitives and render path for historical landmarks.
// The contract every landmark module follows is in internal_docs/LANDMARKS.md.
//
//   const b = new LandmarkBuilder();               // once; reused for every landmark
//   await initLandmarkKit();                       // once, after initGpu()
//   buildLandmark(def, b, built, decay, seed);     // when the landmark comes into range
//   const h = uploadLandmark(def, b, x, y, z, yaw); // GPU buffers + addDrawable
//   h.destroy();                                   // when it leaves range
//
// Vertex (32 bytes): position f32x3, normal f32x3, colour unorm8x4 (sqrt-encoded linear
// rgb, a unused), material unorm8x4 (x emissive 0..1, y flicker source 0..3 as a byte,
// z ambient occlusion 0..1, w surface kind as a byte).
//
// Local space: metres, +y up, origin on the flattened ground at the landmark's centre. The
// road runs along local z and the car travels toward -z. Roadside landmarks have the road
// centre line at x = -roadOffset(def); straddling landmarks have it at x = 0.
//
// Nothing here allocates per frame: lights flicker in the shader from the frame time.

import { gpu, addDrawable, removeDrawable, mainPipeline, shadowPipeline, timing } from '../../gpu.js';
import { MAIN_HEADER, SHADOW_HEADER } from '../../shaders/common.js';
import { camera } from '../../camera.js';
import { state } from '../../state.js';
import { BIOMES } from '../biomes.js';

function q8(t) { return Math.round(Math.min(1, Math.max(0, t)) * 255); }

export const MAX_TRIS = 150000;
export const MAX_VERTS = 262144;
export const MAX_LIGHTS = 2;
export const EMISSIVE_MAX = 20; // emissive 1.0 = vertex colour x 20 (HDR); a sunlit white wall is ~2
export const ROAD = {
  halfWidth: 3.9, // widest road surface (the modern highway, world.js halfWidth(5)), metres from the centre line
  clearance: 6.5, // roadside: nothing taller than 5 cm within 6.5 m of the centre line (2.6 m past the widest edge)
  sideGap: 8, // default roadOffset = radius + sideGap
  eye: 1.3, // driver's eye above the road
  straddleHalfWidth: 6, // straddlesRoad: clear box |x| < 6 ...
  straddleHeight: 6, // ... and 0 < y < 6 along the whole landmark
};
// POLISH: smooth dressed stone with a broad sun sheen; GILT: metal leaf (colour = specular
// tint); CAVE_STONE / CAVE_EARTH: stone / earth detail whose sun light is also scaled by ao^2,
// so cave interiors stay dark whatever the shadow map covers.
// ROCK: bedded rock + snow per fragment; its flicker byte is the snow amount (b.snow(k)).
export const SURF = { PLAIN: 0, STONE: 1, EARTH: 2, WOOD: 3, HIDE: 4, THATCH: 5, PLASTER: 6, POLISH: 7, GILT: 8, CAVE_STONE: 9, CAVE_EARTH: 10, ROCK: 11 };
export const FLICKER = { NONE: 0, LIGHT0: 1, LIGHT1: 2, OWN: 3 };
export const POSE = { STAND: 0, WALK: 1, SIT: 2, KNEEL: 3, HAUL: 4 };
// Live state (handle.setState(built, decay)): how a tagged element moves while it appears
// (b.appear) or disappears (b.vanish). a = 0..1 presence inside the element's window.
//   POP    no motion (shown from the window start)
//   RISE   slides up from h metres below (hidden by the ground / the course below)
//   GROW   scales up in y from the pivot's height
//   SCALE  scales up from the pivot point
//   TILT   pivots up about the pivot from lying flat along tiltDir (raising a stone)
//   DROP   comes down from h metres above
//   CLIP   built up from the pivot's height: everything above pivot.y + h * a is pressed
//          flat onto that level (courses rising, walls going up)
//   PUSH   emerges along its own normal from h metres inside the surface (paint, turf)
//   MORPH  height (and on vanish, colour) blend to targets given per vertex by b.morph()
//   REVEAL no motion: the surface is uncovered fragment by fragment, a ragged front spreading
//          out from the pivot over `h` metres (paint being laid on, a stencil sprayed, a
//          line drawn from its start). Drawn with alpha-to-coverage (MSAA), no sorting.
//   FADE   no motion: dissolves in / out with alpha-to-coverage (people arriving, leaving).
// REVEAL and FADE elements go to their own index range (drawn after the opaque one with an
// alpha-to-coverage pipeline); in the shadow pass they cast while presence > 0.5.
export const MOTION = { POP: 0, RISE: 1, GROW: 2, SCALE: 3, TILT: 4, DROP: 5, CLIP: 6, PUSH: 7, MORPH: 8, REVEAL: 9, FADE: 10 };
export const BY = { BUILT: 0, DECAY: 1 };
export const LAYER = { OPAQUE: 0, FX: 1 };
export const FX = { SMOKE: 20, FLAME: 21, EMBER: 22, GLOW: 23, HALO: 24, FLASH: 25 };
export const MAX_FX_TRIS = 24000;
export const MAX_A2C_TRIS = 60000;
// Rigs: rigid parts that def.animate(a) moves every frame (b.rig(k), a.set(k, ...)); 1..RIGS.
export const RIGS = 7;
// The sea seen from a landmark (world coordinates): [0] sea level y (-1e4: none), [1..2] unit
// direction toward the sea (x, z). sites.js copies world.js seaData here every frame; the
// viewer sets it for the coast. def.animate reads it in local terms as a.seaY / a.seaX / a.seaZ.
export const SEA = new Float64Array([-1e4, 1, 0]);

// Distance from the road centre line to the landmark origin (0 when it straddles the road).
export function roadOffset(def) {
  if (def.straddlesRoad) return 0;
  return def.roadOffset > 0 ? def.roadOffset : def.radius + ROAD.sideGap;
}

// ---------------------------------------------------------------------------------
// Allocation-free value noise (build time helpers, also handy inside build()).

function hash3(x, y, z) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
// 3D value noise in [0, 1].
export function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iy, iz), b = hash3(ix + 1, iy, iz), c = hash3(ix, iy + 1, iz), d = hash3(ix + 1, iy + 1, iz);
  const e = hash3(ix, iy, iz + 1), f = hash3(ix + 1, iy, iz + 1), g = hash3(ix, iy + 1, iz + 1), h = hash3(ix + 1, iy + 1, iz + 1);
  const x0 = a + (b - a) * fx, x1 = c + (d - c) * fx, x2 = e + (f - e) * fx, x3 = g + (h - g) * fx;
  const y0 = x0 + (x1 - x0) * fy, y1 = x2 + (x3 - x2) * fy;
  return y0 + (y1 - y0) * fz;
}
// Fractal noise in [0, 1] (oct octaves, gain 0.5, lacunarity 2.03).
export function fbm3(x, y, z, oct = 3) {
  let s = 0, a = 0.5, w = 0;
  for (let i = 0; i < oct; i++) { s += a * noise3(x, y, z); w += a; a *= 0.5; x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.3; }
  return s / w;
}

// ---------------------------------------------------------------------------------
// Motion helpers for def.animate (allocation-free, plain numbers; see LANDMARKS.md "Motion").

// 0..1 phase of a loop of `period` seconds (offset in seconds).
export function loop(t, period, offset = 0) { const x = (t + offset) / period; return x - Math.floor(x); }
// Linear 0..1 ramp of x over [a, b] (clamped): a timeline segment.
export function seg(x, a, b) { const k = (x - a) / (b - a); return k < 0 ? 0 : k > 1 ? 1 : k; }
// Smoothstep of a 0..1 value.
export function ease(k) { k = k < 0 ? 0 : k > 1 ? 1 : k; return k * k * (3 - 2 * k); }
// Point on a smooth path (Catmull-Rom through P = [x0, y0, z0, x1, y1, z1, ...], spaced by
// segment length) at u = 0..1 (closed: P loops back to its start, u wraps). Writes out[0..2]
// position, out[3] yaw (a part built facing +z faces along the path), out[4] pitch (climbing
// is negative: pass it to a.set as is). out: a module-level Float64Array(5).
export function pathAt(P, u, out, closed = false) {
  const n = (P.length / 3) | 0, m = closed ? n : n - 1;
  let total = 0;
  for (let i = 0; i < m; i++) total += segLen(P, i * 3, ((i + 1) % n) * 3);
  u = closed ? u - Math.floor(u) : u < 0 ? 0 : u > 1 ? 1 : u;
  let d = u * total, i = 0, L = 0;
  for (; i < m; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    L = segLen(P, a, b);
    if (d <= L || i === m - 1) break;
    d -= L;
  }
  const f = L > 0 ? Math.min(1, d / L) : 0;
  const i0 = closed ? (i - 1 + n) % n : Math.max(0, i - 1), i1 = i, i2 = closed ? (i + 1) % n : Math.min(n - 1, i + 1), i3 = closed ? (i + 2) % n : Math.min(n - 1, i + 2);
  const f2 = f * f, f3 = f2 * f;
  let dx = 0, dy = 0, dz = 0;
  for (let c = 0; c < 3; c++) {
    const p0 = P[i0 * 3 + c], p1 = P[i1 * 3 + c], p2 = P[i2 * 3 + c], p3 = P[i3 * 3 + c];
    out[c] = 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (3 * p1 - p0 - 3 * p2 + p3) * f3);
    const t = 0.5 * ((p2 - p0) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (3 * p1 - p0 - 3 * p2 + p3) * f2);
    if (c === 0) dx = t; else if (c === 1) dy = t; else dz = t;
  }
  out[3] = Math.atan2(dx, dz);
  out[4] = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  return out;
}
function segLen(P, a, b) { const x = P[b] - P[a], y = P[b + 1] - P[a + 1], z = P[b + 2] - P[a + 2]; return Math.sqrt(x * x + y * y + z * z); }

// ---------------------------------------------------------------------------------
// Builder. All storage is preallocated; reset() rewinds it. Overflow sets b.overflow and
// drops further geometry instead of throwing.

const G = new Float64Array(3 * 65536); // grid scratch (positions) for lathe / extrude / grids
const GN = new Float64Array(3 * 65536); // grid scratch (normals)
const S = new Float64Array(96); // small scratch
const HEX_FACES = [0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 1, 2, 6, 5, 2, 3, 7, 6, 3, 0, 4, 7];
const CUBE = [ // face normal, u axis, v axis
  1, 0, 0, 0, 0, -1, 0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0,
  0, 1, 0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 1, 0, 0, 0, 0, 1,
  0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, -1, -1, 0, 0, 0, 1, 0,
];

export class LandmarkBuilder {
  constructor(maxVerts = MAX_VERTS, maxTris = MAX_TRIS) {
    this.maxV = maxVerts;
    this.maxI = maxTris * 3;
    this.data = new ArrayBuffer(maxVerts * 32);
    this.f = new Float32Array(this.data);
    this.u8 = new Uint8Array(this.data);
    this.idx = new Uint32Array(this.maxI);
    this.m = new Float64Array(12); // columns X, Y, Z, translation
    this.c = new Float64Array(9); // cofactor (normal) matrix
    this.stack = new Float64Array(12 * 32);
    this.lights = new Float32Array(MAX_LIGHTS * 12); // pos xyz, range, rgb, intensity, flicker, -, -, -
    this.lightRule = new Float32Array(MAX_LIGHTS * 4); // appear t0, t1 (built), vanish t0, t1 (decay)
    // Live-state stream (24 bytes per vertex): thresholds unorm8x4 (in0, in1, out0, out1),
    // modes uint8x4 (in mode | by << 4 | lead << 5, out mode | by << 4, flags, tilt dir),
    // pivot float32x4 (x, y, z, h) in landmark space.
    this.tdata = new ArrayBuffer(maxVerts * 24);
    this.tu8 = new Uint8Array(this.tdata);
    this.tf = new Float32Array(this.tdata);
    this.tpv = new Float64Array(4);
    this.maxFx = MAX_FX_TRIS * 3;
    this.fidx = new Uint32Array(this.maxFx);
    this.maxA = MAX_A2C_TRIS * 3; // REVEAL / FADE triangles (count toward MAX_TRIS)
    this.aidx = new Uint32Array(this.maxA);
    this.rs = new Uint32Array(1);
    this.out = { vertices: 0, triangles: 0, fx: 0 };
    this.biome = 0;
    this.reset();
  }

  reset() {
    this.nv = 0; this.ni = 0; this.nf = 0; this.na = 0; this.li = 0; this.overflow = false; this.sp = 0; this.trg = 0; this.tdl = 0;
    this.identity();
    this.color(0.5, 0.5, 0.5); this.me = 0; this.mf = 0; this.ma = 255; this.mk = 0; this.ca = 255;
    this.timeless();
    this.lights.fill(0);
    for (let i = 0; i < MAX_LIGHTS; i++) { const o = i * 4; this.lightRule[o] = -1; this.lightRule[o + 1] = -1; this.lightRule[o + 2] = 2; this.lightRule[o + 3] = 2; }
    this.rs[0] = 1;
    this.built0 = 1; this.decay0 = 0; this.padR = 1e9;
    return this;
  }
  // triangles: opaque + alpha-to-coverage (REVEAL / FADE); a2c: the latter alone; fx: FX layer.
  counts() { this.out.vertices = this.nv; this.out.triangles = (this.ni + this.na) / 3; this.out.a2c = this.na / 3; this.out.fx = this.nf / 3; return this.out; }

  // --- biome palette (linear albedo rows of src/world/biomes.js for the biome the landmark
  // stands in; def.biome or beginBuild's biome argument picks it). Returns [r, g, b, w].
  bio(key) { return BIOMES[this.biome][key]; }

  // --- live state (see MOTION). Tags apply to every vertex written after the call, like
  // material state; give one element (a block, a pillar) one tag so its triangles move
  // together. Windows are in the driver's units (0..1, 1/255 resolution).
  // appear: hidden while driver < t0 (- lead: shown at a = 0 that much earlier, e.g. a
  // pillar lying before it is raised), a = smoothstep(t0, t1, driver).
  appear(t0, t1, motion = 0, h = 0, by = 0, lead = 0) {
    this.ti0 = q8(t0); this.ti1 = Math.max(this.ti0 + 1, q8(t1));
    this.tmI = (motion & 15) | (by ? 16 : 0) | (Math.min(7, Math.round(lead / 0.02)) << 5);
    this.tfl |= 1; if (h) this.tpv[3] = h;
    this._a2c();
    return this;
  }
  // vanish: a = 1 - smoothstep(t0, t1, driver) (linear for CLIP, MORPH, REVEAL, FADE); hidden
  // once a reaches 0 (except MORPH).
  vanish(t0, t1, motion = 0, h = 0, by = 1) {
    this.to0 = q8(t0); this.to1 = Math.max(this.to0 + 1, q8(t1));
    this.tmO = (motion & 15) | (by ? 16 : 0);
    this.tfl |= 2; if (h) this.tpv[3] = h;
    this._a2c();
    return this;
  }
  // Rig k (1..RIGS; 0 = none): the vertices written after this call are one rigid part that
  // def.animate(a) moves every frame with a.set(k, x, y, z, yaw, pitch, roll, scale) (its
  // emissive and FX brightness by a.gain(k, g), hidden by a.show(k, 0)). Build the part around
  // the local origin as its own frame (the rig's pivot); the live tags, pivots and FX inside it
  // work in that frame. shadow = false: the part casts no shadow (far parts, flashes, clouds).
  // Not reset by timeless(); b.rig(0) ends the part.
  rig(k = 0, shadow = true) { this.trg = k > 0 ? ((Math.min(RIGS, k | 0) << 2) | (shadow ? 0 : 32)) : 0; return this; }
  // Dusk-lit emissive (windows, lamps meant for the evening): from here until duskLit(false),
  // emissive is scaled by the time of day: ~8% in full sun, full once the sun is low (the same
  // ramp as the settlements' windows, from the key sun's height). Not reset by timeless().
  duskLit(on = true) { this.tdl = on ? 64 : 0; return this; }
  noAppear() { this.tfl &= ~1; this.tmI = 0; this._a2c(); return this; }
  noVanish() { this.tfl &= ~2; this.tmO = 0; this._a2c(); return this; }
  _a2c() { this.ta = ((this.tfl & 1) && (this.tmI & 15) >= 9) || ((this.tfl & 2) && (this.tmO & 15) >= 9); }
  timeless() {
    this.ta = false;
    this.ti0 = 0; this.ti1 = 1; this.to0 = 254; this.to1 = 255; this.tmI = 0; this.tmO = 0; this.tfl = 0; this.tdir = 0;
    this.tpv[0] = this.tpv[1] = this.tpv[2] = this.tpv[3] = 0;
    return this;
  }
  // Pivot for GROW / SCALE / TILT / CLIP, in the current transform.
  pivot(x, y, z) {
    const m = this.m;
    this.tpv[0] = m[0] * x + m[3] * y + m[6] * z + m[9];
    this.tpv[1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    this.tpv[2] = m[2] * x + m[5] * y + m[8] * z + m[11];
    return this;
  }
  // Motion distance h (metres) for RISE / DROP / PUSH, height for CLIP.
  reach(h) { this.tpv[3] = h; return this; }
  // TILT lies the element down toward the horizontal direction (dx, dz) of the current frame.
  tiltDir(dx, dz) {
    const m = this.m, wx = m[0] * dx + m[6] * dz, wz = m[2] * dx + m[8] * dz;
    this.tdir = Math.round(Math.atan2(wx, wz) / (Math.PI * 2) * 256) & 255;
    return this;
  }
  // MORPH targets for the next vertex: height at built 0 (appear), height and linear colour at
  // decay 1 (vanish). Heights are landmark-space y.
  morph(yBuilt0, yDecay1, r = 0, g = 0, bl = 0) {
    this.tpv[0] = yBuilt0; this.tpv[1] = yDecay1;
    const e = (v) => Math.round(Math.sqrt(Math.min(1, Math.max(0, v))) * 255);
    this.tpv[2] = e(r) + e(g) * 256 + e(bl) * 65536;
    return this;
  }
  // Index layer: LAYER.OPAQUE (lit, shadowed) or LAYER.FX (smoke, flames, embers, ground
  // light; drawn blended after the sky). Use the fx helpers rather than raw geometry in FX.
  layer(l) { this.li = l | 0; return this; }
  alpha(a) { this.ca = Math.round(Math.min(1, Math.max(0, a)) * 255); return this; }
  // Light i's level follows the live state: smoothstep(a0, a1, built) x (1 - smoothstep(v0,
  // v1, decay)). Flames, embers, smoke and glowing ash bound to that light follow it too.
  lightLive(i, a0 = -1, a1 = -1, v0 = 2, v1 = 2) {
    const o = i * 4, R = this.lightRule; R[o] = a0; R[o + 1] = a1; R[o + 2] = v0; R[o + 3] = v1; return this;
  }

  // --- deterministic random
  seed(s) { this.rs[0] = (Math.imul((s | 0) ^ 0x5bd1e995, 0x9e3779b1) >>> 0) || 1; return this; }
  rand() { // mulberry32
    let t = (this.rs[0] = (this.rs[0] + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.rand(); }

  // --- material state (applies to vertices written after the call)
  color(r, g, b) {
    this.cr = Math.round(Math.sqrt(Math.min(1, Math.max(0, r))) * 255);
    this.cg = Math.round(Math.sqrt(Math.min(1, Math.max(0, g))) * 255);
    this.cb = Math.round(Math.sqrt(Math.min(1, Math.max(0, b))) * 255);
    return this;
  }
  // SURF.ROCK only: snow amount 0..1 for the next vertices (stored in the flicker byte).
  snow(k) { this.me = 0; this.mf = Math.round(Math.min(1, Math.max(0, k)) * 255); return this; }
  emissive(e, flicker = 0) { this.me = Math.round(Math.min(1, Math.max(0, e)) * 255); this.mf = flicker | 0; return this; }
  ao(a) { this.ma = Math.round(Math.min(1, Math.max(0, a)) * 255); return this; }
  surface(kind) { this.mk = kind | 0; return this; }

  // --- lights (landmark-local). def.lights are copied in before build(); build() may move,
  // recolour, rescale or switch them off (intensity 0).
  light(i, x, y, z, r, g, b, intensity, range, flicker) {
    const o = i * 12, L = this.lights;
    L[o] = x; L[o + 1] = y; L[o + 2] = z; L[o + 3] = range;
    L[o + 4] = r; L[o + 5] = g; L[o + 6] = b; L[o + 7] = intensity; L[o + 8] = flicker;
    return this;
  }
  // Moves light i to a point given in the CURRENT transform's space.
  lightAt(i, x, y, z) {
    const m = this.m, L = this.lights, o = i * 12;
    L[o] = m[0] * x + m[3] * y + m[6] * z + m[9];
    L[o + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    L[o + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
    return this;
  }
  lightScale(i, s) { this.lights[i * 12 + 7] *= s; return this; }
  setLightsFrom(list) {
    this.lights.fill(0);
    if (!list) return this;
    for (let i = 0; i < list.length && i < MAX_LIGHTS; i++) {
      const l = list[i], p = l.pos || [0, 1, 0], c = l.color || [1, 0.6, 0.3];
      this.light(i, p[0], p[1], p[2], c[0], c[1], c[2], l.intensity ?? 40, l.range ?? 20, l.flicker ?? 0.6);
      const ap = l.appear || null, va = l.vanish || null;
      this.lightLive(i, ap ? ap[0] : -1, ap ? ap[1] : -1, va ? va[0] : 2, va ? va[1] : 2);
    }
    return this;
  }

  // --- transform (each call composes in the current local frame, like a scene graph)
  identity() { const m = this.m; m.fill(0); m[0] = m[4] = m[8] = 1; this.cd = true; return this; }
  push() {
    if (this.sp >= 32) throw new Error('LandmarkBuilder: transform stack overflow');
    this.stack.set(this.m, this.sp++ * 12); return this;
  }
  pop() {
    if (this.sp <= 0) throw new Error('LandmarkBuilder: transform stack underflow');
    const o = --this.sp * 12;
    for (let i = 0; i < 12; i++) this.m[i] = this.stack[o + i];
    this.cd = true; return this;
  }
  translate(x, y, z) {
    const m = this.m;
    m[9] += m[0] * x + m[3] * y + m[6] * z; m[10] += m[1] * x + m[4] * y + m[7] * z; m[11] += m[2] * x + m[5] * y + m[8] * z;
    return this;
  }
  // Rotation about local +y; positive turns +x toward -z (same as mesh.js yaw).
  rotateY(a) { return this._rot(0, 6, Math.cos(a), -Math.sin(a)); }
  rotateX(a) { return this._rot(3, 6, Math.cos(a), Math.sin(a)); } // +y toward +z
  rotateZ(a) { return this._rot(0, 3, Math.cos(a), Math.sin(a)); } // +x toward +y
  _rot(p, q, c, s) {
    const m = this.m;
    for (let k = 0; k < 3; k++) {
      const a = m[p + k], b = m[q + k];
      m[p + k] = c * a + s * b; m[q + k] = -s * a + c * b;
    }
    this.cd = true; return this;
  }
  scale(sx, sy = sx, sz = sx) {
    const m = this.m;
    for (let k = 0; k < 3; k++) { m[k] *= sx; m[3 + k] *= sy; m[6 + k] *= sz; }
    this.cd = true; return this;
  }
  // translate + rotateY, the common placement.
  at(x, y, z, yaw = 0) { this.translate(x, y, z); if (yaw) this.rotateY(yaw); return this; }
  _cof() {
    const m = this.m, c = this.c;
    // columns: Y x Z, Z x X, X x Y (inverse-transpose up to scale)
    c[0] = m[4] * m[8] - m[5] * m[7]; c[1] = m[5] * m[6] - m[3] * m[8]; c[2] = m[3] * m[7] - m[4] * m[6];
    c[3] = m[7] * m[2] - m[8] * m[1]; c[4] = m[8] * m[0] - m[6] * m[2]; c[5] = m[6] * m[1] - m[7] * m[0];
    c[6] = m[1] * m[5] - m[2] * m[4]; c[7] = m[2] * m[3] - m[0] * m[5]; c[8] = m[0] * m[4] - m[1] * m[3];
    const det = m[0] * c[0] + m[1] * c[1] + m[2] * c[2];
    if (det < 0) for (let i = 0; i < 9; i++) c[i] = -c[i];
    this.cd = false;
  }

  // --- raw geometry. vertex() takes local position + normal, returns its index (-1 when full).
  vertex(x, y, z, nx, ny, nz) {
    if (this.nv >= this.maxV) { this.overflow = true; return -1; }
    if (this.cd) this._cof();
    const m = this.m, c = this.c, f = this.f, u = this.u8;
    const i = this.nv, o = i * 8, ob = i * 32;
    f[o] = m[0] * x + m[3] * y + m[6] * z + m[9];
    f[o + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    f[o + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
    let a = c[0] * nx + c[3] * ny + c[6] * nz, b = c[1] * nx + c[4] * ny + c[7] * nz, d = c[2] * nx + c[5] * ny + c[8] * nz;
    const l = Math.sqrt(a * a + b * b + d * d);
    if (l > 1e-20) { a /= l; b /= l; d /= l; } else { a = 0; b = 1; d = 0; }
    f[o + 3] = a; f[o + 4] = b; f[o + 5] = d;
    u[ob + 24] = this.cr; u[ob + 25] = this.cg; u[ob + 26] = this.cb; u[ob + 27] = this.ca;
    u[ob + 28] = this.me; u[ob + 29] = this.mf; u[ob + 30] = this.ma; u[ob + 31] = this.mk;
    const t = this.tu8, ot = i * 24, tf = this.tf, of = i * 6, P = this.tpv;
    t[ot] = this.ti0; t[ot + 1] = this.ti1; t[ot + 2] = this.to0; t[ot + 3] = this.to1;
    t[ot + 4] = this.tmI; t[ot + 5] = this.tmO; t[ot + 6] = this.tfl | this.trg | this.tdl; t[ot + 7] = this.tdir;
    tf[of + 2] = P[0]; tf[of + 3] = P[1]; tf[of + 4] = P[2]; tf[of + 5] = P[3];
    this.nv = i + 1;
    return i;
  }
  // Triangle; the winding is fixed automatically so the front face agrees with the vertex
  // normals (the main pass culls back faces). Get the normals right; winding is free.
  tri(a, b, c) {
    if (a < 0 || b < 0 || c < 0) return this;
    if (this.li === 1) { // FX layer: drawn without culling, winding irrelevant
      if (this.nf + 3 > this.maxFx) { this.overflow = true; return this; }
      const F = this.fidx, n = this.nf; F[n] = a; F[n + 1] = b; F[n + 2] = c; this.nf = n + 3;
      return this;
    }
    if (this.ni + this.na + 3 > this.maxI) { this.overflow = true; return this; }
    const f = this.f, A = a * 8, B = b * 8, C = c * 8;
    const ux = f[B] - f[A], uy = f[B + 1] - f[A + 1], uz = f[B + 2] - f[A + 2];
    const vx = f[C] - f[A], vy = f[C + 1] - f[A + 1], vz = f[C + 2] - f[A + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const s = gx * (f[A + 3] + f[B + 3] + f[C + 3]) + gy * (f[A + 4] + f[B + 4] + f[C + 4]) + gz * (f[A + 5] + f[B + 5] + f[C + 5]);
    if (this.ta) { // REVEAL / FADE: alpha-to-coverage range
      if (this.na + 3 > this.maxA) { this.overflow = true; return this; }
      const J = this.aidx, m = this.na;
      J[m] = a;
      if (s < 0) { J[m + 1] = c; J[m + 2] = b; } else { J[m + 1] = b; J[m + 2] = c; }
      this.na = m + 3;
      return this;
    }
    const I = this.idx, n = this.ni;
    I[n] = a;
    if (s < 0) { I[n + 1] = c; I[n + 2] = b; } else { I[n + 1] = b; I[n + 2] = c; }
    this.ni = n + 3;
    return this;
  }
  quad(a, b, c, d) { this.tri(a, b, c); return this.tri(a, c, d); }

  // --- primitives (all in the current transform) ------------------------------------

  // Eight corners (Float64Array/array of 24: bottom ring then top ring, each going
  // -x-z, +x-z, +x+z, -x+z), flat-shaded faces. bottom=false skips the underside.
  hexa(P, bottom = true) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < 8; i++) { cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; }
    cx /= 8; cy /= 8; cz /= 8;
    for (let fi = bottom ? 0 : 1; fi < 6; fi++) {
      const a = HEX_FACES[fi * 4] * 3, b = HEX_FACES[fi * 4 + 1] * 3, c = HEX_FACES[fi * 4 + 2] * 3, d = HEX_FACES[fi * 4 + 3] * 3;
      const ex = P[c] - P[a], ey = P[c + 1] - P[a + 1], ez = P[c + 2] - P[a + 2];
      const fx = P[d] - P[b], fy = P[d + 1] - P[b + 1], fz = P[d + 2] - P[b + 2];
      let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-12) continue;
      const mx = (P[a] + P[b] + P[c] + P[d]) * 0.25 - cx, my = (P[a + 1] + P[b + 1] + P[c + 1] + P[d + 1]) * 0.25 - cy, mz = (P[a + 2] + P[b + 2] + P[c + 2] + P[d + 2]) * 0.25 - cz;
      const sg = (nx * mx + ny * my + nz * mz) < 0 ? -1 / l : 1 / l;
      nx *= sg; ny *= sg; nz *= sg;
      const i0 = this.vertex(P[a], P[a + 1], P[a + 2], nx, ny, nz), i1 = this.vertex(P[b], P[b + 1], P[b + 2], nx, ny, nz);
      const i2 = this.vertex(P[c], P[c + 1], P[c + 2], nx, ny, nz), i3 = this.vertex(P[d], P[d + 1], P[d + 2], nx, ny, nz);
      this.quad(i0, i1, i2, i3);
    }
    return this;
  }
  // Axis-aligned box centred at (cx, cy, cz) with half extents.
  box(cx, cy, cz, hx, hy, hz, bottom = true) {
    const P = S;
    for (let i = 0; i < 8; i++) {
      const sx = (i & 3) === 1 || (i & 3) === 2 ? 1 : -1, sz = (i & 3) >= 2 ? 1 : -1, sy = i >= 4 ? 1 : -1;
      P[i * 3] = cx + sx * hx; P[i * 3 + 1] = cy + sy * hy; P[i * 3 + 2] = cz + sz * hz;
    }
    return this.hexa(P, bottom);
  }
  // Tapered block standing on y = 0: base half extents (bx, bz), top half extents (tx, tz)
  // at height h, top centre shifted by (ox, oz). Pillars, steps, pyramid courses, stones.
  block(bx, bz, tx, tz, h, ox = 0, oz = 0, bottom = false) {
    const P = S;
    for (let i = 0; i < 8; i++) {
      const sx = (i & 3) === 1 || (i & 3) === 2 ? 1 : -1, sz = (i & 3) >= 2 ? 1 : -1, top = i >= 4;
      P[i * 3] = top ? ox + sx * tx : sx * bx; P[i * 3 + 1] = top ? h : 0; P[i * 3 + 2] = top ? oz + sz * tz : sz * bz;
    }
    return this.hexa(P, bottom);
  }
  // Tapered round strut from A to B (radii r0 at A, r1 at B). Limbs, poles, logs, ropes.
  beam(ax, ay, az, bx, by, bz, r0, r1 = r0, sides = 6, caps = true) {
    let tx = bx - ax, ty = by - ay, tz = bz - az;
    const L = Math.hypot(tx, ty, tz);
    if (L < 1e-6) return this;
    tx /= L; ty /= L; tz /= L;
    let rx = 0, ry = 1, rz = 0;
    if (Math.abs(ty) > 0.9) { rx = 1; ry = 0; }
    let ux = ty * rz - tz * ry, uy = tz * rx - tx * rz, uz = tx * ry - ty * rx;
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const slope = (r0 - r1) / L;
    const base = this.nv;
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const dx = ux * ca + vx * sa, dy = uy * ca + vy * sa, dz = uz * ca + vz * sa;
      const nx = dx + tx * slope, ny = dy + ty * slope, nz = dz + tz * slope;
      this.vertex(ax + dx * r0, ay + dy * r0, az + dz * r0, nx, ny, nz);
      this.vertex(bx + dx * r1, by + dy * r1, bz + dz * r1, nx, ny, nz);
    }
    if (this.nv - base !== (sides + 1) * 2) return this;
    for (let k = 0; k < sides; k++) { const i = base + k * 2; this.quad(i, i + 2, i + 3, i + 1); }
    if (caps) {
      for (let e = 0; e < 2; e++) {
        const px = e ? bx : ax, py = e ? by : ay, pz = e ? bz : az, r = e ? r1 : r0, s = e ? 1 : -1;
        if (r < 1e-4) continue;
        const c = this.vertex(px, py, pz, tx * s, ty * s, tz * s), c0 = this.nv;
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          this.vertex(px + (ux * ca + vx * sa) * r, py + (uy * ca + vy * sa) * r, pz + (uz * ca + vz * sa) * r, tx * s, ty * s, tz * s);
        }
        for (let k = 0; k < sides; k++) this.tri(c, c0 + k, c0 + (k + 1) % sides);
      }
    }
    return this;
  }
  // Surface of revolution about +y. profile = [r0, y0, r1, y1, ...]. Normals face the
  // right-hand side of the profile's direction in the (r, y) plane: listed bottom -> top
  // they point outward, top -> bottom inward (interiors); outer -> inner (flat) points up.
  // opts: seg (around), caps (close flat ends), a0/a1 (partial sweep, radians from +x
  // toward +z), wobble(theta, t) -> radial multiplier offset (t = 0..1 along the profile).
  lathe(profile, seg = 16, opts) {
    const n = profile.length >> 1;
    const a0 = opts && opts.a0 !== undefined ? opts.a0 : 0, a1 = opts && opts.a1 !== undefined ? opts.a1 : Math.PI * 2;
    const caps = opts && opts.caps !== undefined ? opts.caps : true, wob = opts && opts.wobble;
    const closed = a1 - a0 >= Math.PI * 2 - 1e-6;
    const W = seg + 1;
    if (n < 2 || n * W > 65536) return this;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i <= seg; i++) {
        const th = closed && i === seg ? a0 : a0 + (a1 - a0) * (i / seg);
        const r = profile[k * 2] * (wob ? 1 + wob(th, k / (n - 1)) : 1);
        const o = (k * W + i) * 3;
        G[o] = Math.cos(th) * r; G[o + 1] = profile[k * 2 + 1]; G[o + 2] = Math.sin(th) * r;
      }
    }
    this._gridNormals(W, n, closed);
    this._emitGrid(W, n);
    if (closed && caps) {
      const dir = profile[(n - 1) * 2 + 1] - profile[1];
      if (Math.abs(dir) > 1e-6) {
        for (let e = 0; e < 2; e++) {
          const k = e ? n - 1 : 0;
          if (profile[k * 2] < 1e-4) continue;
          const ny = (e ? 1 : -1) * Math.sign(dir), y = profile[k * 2 + 1];
          const c = this.vertex(0, y, 0, 0, ny, 0), c0 = this.nv;
          for (let i = 0; i < seg; i++) { const o = (k * W + i) * 3; this.vertex(G[o], G[o + 1], G[o + 2], 0, ny, 0); }
          for (let i = 0; i < seg; i++) this.tri(c, c0 + i, c0 + (i + 1) % seg);
        }
      }
    }
    return this;
  }
  cylinder(r, h, seg = 12, caps = true) { S[80] = r; S[81] = 0; S[82] = r; S[83] = h; return this.lathe(S.subarray(80, 84), seg, caps ? undefined : NOCAPS); }
  cone(r, h, seg = 12) { S[80] = r; S[81] = 0; S[82] = 0; S[83] = h; return this.lathe(S.subarray(80, 84), seg); }

  // Sweep a 2D cross-section along a 3D path. path = [x, y, z, ...] (>= 2 points),
  // shape = [x, y, ...] with x = right of the direction of travel, y = up. A closed shape
  // listed counter-clockwise gets outward normals; open shapes get normals on the right-hand
  // side of their direction (an arch listed from its right foot over to its left foot faces
  // outward; flip: true faces it inward, e.g. a tunnel). opts: closed (default true),
  // smooth (default true; false = flat facets), scale (number or per-path-point array),
  // flip, caps (closed shapes only; fan, assumes convex).
  extrude(path, shape, opts) {
    const np = path.length / 3 | 0, ns = shape.length >> 1;
    const closed = !(opts && opts.closed === false), smooth = !(opts && opts.smooth === false);
    const flip = !!(opts && opts.flip), sc = opts && opts.scale, caps = !!(opts && opts.caps);
    if (np < 2 || ns < 2) return this;
    const F = S; // frames: per path point we only need T, S, U for the current and caps
    const ring = closed ? ns + 1 : ns;
    if (np * ring * 2 > 65536) return this;
    // Positions and normals into the grid (u = shape index, v = path index).
    const W = smooth ? ring : (closed ? ns : ns - 1) * 2;
    for (let k = 0; k < np; k++) {
      this._frame(path, np, k, F);
      const s = sc === undefined || sc === null ? 1 : (typeof sc === 'number' ? sc : sc[k]);
      const px = path[k * 3], py = path[k * 3 + 1], pz = path[k * 3 + 2];
      if (smooth) {
        for (let j = 0; j < ring; j++) {
          const jj = j % ns;
          const jp = closed ? (jj + ns - 1) % ns : Math.max(0, jj - 1), jn = closed ? (jj + 1) % ns : Math.min(ns - 1, jj + 1);
          let ex = shape[jn * 2] - shape[jp * 2], ey = shape[jn * 2 + 1] - shape[jp * 2 + 1];
          this._put(k * W + j, px, py, pz, F, shape[jj * 2] * s, shape[jj * 2 + 1] * s, ey, -ex, flip);
        }
      } else {
        const ne = closed ? ns : ns - 1;
        for (let e = 0; e < ne; e++) {
          const j0 = e, j1 = (e + 1) % ns;
          const ex = shape[j1 * 2] - shape[j0 * 2], ey = shape[j1 * 2 + 1] - shape[j0 * 2 + 1];
          this._put(k * W + e * 2, px, py, pz, F, shape[j0 * 2] * s, shape[j0 * 2 + 1] * s, ey, -ex, flip);
          this._put(k * W + e * 2 + 1, px, py, pz, F, shape[j1 * 2] * s, shape[j1 * 2 + 1] * s, ey, -ex, flip);
        }
      }
    }
    const base = this.nv;
    for (let q = 0; q < np * W; q++) this.vertex(G[q * 3], G[q * 3 + 1], G[q * 3 + 2], GN[q * 3], GN[q * 3 + 1], GN[q * 3 + 2]);
    if (this.nv - base === np * W) {
      for (let k = 0; k < np - 1; k++) {
        const r0 = base + k * W, r1 = r0 + W;
        if (smooth) for (let j = 0; j < ring - 1; j++) this.quad(r0 + j, r0 + j + 1, r1 + j + 1, r1 + j);
        else for (let j = 0; j < W; j += 2) this.quad(r0 + j, r0 + j + 1, r1 + j + 1, r1 + j);
      }
    }
    if (caps && closed) {
      for (let e = 0; e < 2; e++) {
        const k = e ? np - 1 : 0;
        this._frame(path, np, k, F);
        const s = sc === undefined || sc === null ? 1 : (typeof sc === 'number' ? sc : sc[k]);
        const sg = e ? 1 : -1, nx = F[0] * sg, ny = F[1] * sg, nz = F[2] * sg;
        const c0 = this.nv;
        for (let j = 0; j < ns; j++) {
          const x = shape[j * 2] * s, y = shape[j * 2 + 1] * s;
          this.vertex(path[k * 3] + F[3] * x + F[6] * y, path[k * 3 + 1] + F[4] * x + F[7] * y, path[k * 3 + 2] + F[5] * x + F[8] * y, nx, ny, nz);
        }
        for (let j = 1; j < ns - 1; j++) this.tri(c0, c0 + j, c0 + j + 1);
      }
    }
    return this;
  }
  _frame(path, np, k, F) { // F[0..2] tangent, F[3..5] right, F[6..8] up
    const k0 = Math.max(0, k - 1), k1 = Math.min(np - 1, k + 1);
    let tx = path[k1 * 3] - path[k0 * 3], ty = path[k1 * 3 + 1] - path[k0 * 3 + 1], tz = path[k1 * 3 + 2] - path[k0 * 3 + 2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    let sx, sy, sz;
    if (Math.abs(ty) < 0.99) { sx = -tz; sy = 0; sz = tx; } else { sx = 0; sy = tz; sz = -ty; } // T x Y (or T x X)
    const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
    F[0] = tx; F[1] = ty; F[2] = tz; F[3] = sx; F[4] = sy; F[5] = sz;
    F[6] = sy * tz - sz * ty; F[7] = sz * tx - sx * tz; F[8] = sx * ty - sy * tx;
  }
  _put(q, px, py, pz, F, x, y, nx2, ny2, flip) {
    G[q * 3] = px + F[3] * x + F[6] * y; G[q * 3 + 1] = py + F[4] * x + F[7] * y; G[q * 3 + 2] = pz + F[5] * x + F[8] * y;
    const s = flip ? -1 : 1;
    GN[q * 3] = (F[3] * nx2 + F[6] * ny2) * s; GN[q * 3 + 1] = (F[4] * nx2 + F[7] * ny2) * s; GN[q * 3 + 2] = (F[5] * nx2 + F[8] * ny2) * s;
  }

  // Rough rock / boulder / megalith centred at the origin: a cube-sphere with radii
  // (rx, ry, rz), detail = cells per cube face edge (tris = 12 * detail^2), rough = noise
  // amplitude (0 = smooth ellipsoid), facets = number of random flat cuts (0-8, gives
  // knapped / quarried planes), flat = 0..1 flattens the underside (sits on y = -ry*(1-flat)),
  // seed = shape seed.
  rock(rx, ry, rz, detail = 5, rough = 0.2, seed = 1, facets = 0, flat = 0) {
    facets = Math.min(8, facets | 0);
    for (let p = 0; p < facets; p++) { // planes: normal + distance, in S[0..31]
      const u = hash3(seed, p, 1) * 2 - 1, a = hash3(seed, p, 2) * Math.PI * 2, r = Math.sqrt(1 - u * u);
      S[p * 4] = r * Math.cos(a); S[p * 4 + 1] = u * 0.6; S[p * 4 + 2] = r * Math.sin(a);
      const l = Math.hypot(S[p * 4], S[p * 4 + 1], S[p * 4 + 2]);
      S[p * 4] /= l; S[p * 4 + 1] /= l; S[p * 4 + 2] /= l;
      S[p * 4 + 3] = 0.72 + 0.2 * hash3(seed, p, 3);
    }
    S[40] = rx; S[41] = ry; S[42] = rz; S[43] = rough; S[44] = facets; S[45] = flat; S[46] = seed;
    const d = Math.max(1, detail | 0), W = d + 1, e = 0.35 / d;
    for (let fc = 0; fc < 6; fc++) {
      const o = fc * 9, base = this.nv;
      for (let j = 0; j <= d; j++) {
        for (let i = 0; i <= d; i++) {
          const u = (i / d) * 2 - 1, v = (j / d) * 2 - 1;
          _rockPt(CUBE, o, u, v, 47);
          const px = S[47], py = S[48], pz = S[49];
          _rockPt(CUBE, o, u + e, v, 50); _rockPt(CUBE, o, u - e, v, 53);
          _rockPt(CUBE, o, u, v + e, 56); _rockPt(CUBE, o, u, v - e, 59);
          const ax = S[50] - S[53], ay = S[51] - S[54], az = S[52] - S[55];
          const bx = S[56] - S[59], by = S[57] - S[60], bz = S[58] - S[61];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          // outward: compare with the unscaled direction
          if (nx * px / (rx * rx) + ny * py / (ry * ry) + nz * pz / (rz * rz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
          this.vertex(px, py, pz, nx, ny, nz);
        }
      }
      if (this.nv - base !== W * W) continue;
      for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) { const a = base + j * W + i; this.quad(a, a + 1, a + W + 1, a + W); }
    }
    return this;
  }
  ellipsoid(rx, ry, rz, detail = 3) { return this.rock(rx, ry, rz, detail, 0, 1, 0, 0); }

  // Flat-ish disc in the xz plane (ground covers, ash beds, floors, burial mounds), centre at
  // the origin. fn(x, z) -> y (optional, default 0) runs just before each vertex is written,
  // so it may also set b.color / b.ao / b.emissive per vertex. Normal from the height slope.
  disc(radius, segs = 24, rings = 6, fn = null) {
    const e = Math.max(0.02, radius / rings * 0.35);
    const base = this.nv;
    this._hfVert(0, 0, e, fn);
    for (let k = 1; k <= rings; k++) {
      const r = radius * k / rings;
      for (let i = 0; i < segs; i++) { const a = (i / segs) * Math.PI * 2; this._hfVert(Math.cos(a) * r, Math.sin(a) * r, e, fn); }
    }
    if (this.nv - base !== 1 + rings * segs) return this;
    for (let i = 0; i < segs; i++) this.tri(base, base + 1 + i, base + 1 + (i + 1) % segs);
    for (let k = 1; k < rings; k++) {
      const r0 = base + 1 + (k - 1) * segs, r1 = r0 + segs;
      for (let i = 0; i < segs; i++) { const i1 = (i + 1) % segs; this.quad(r0 + i, r0 + i1, r1 + i1, r1 + i); }
    }
    return this;
  }
  // Height field over the rectangle [x0, x1] x [z0, z1] with nx * nz cells; fn as for disc().
  heightfield(x0, z0, x1, z1, nx, nz, fn) {
    const e = Math.max(0.02, Math.min((x1 - x0) / nx, (z1 - z0) / nz) * 0.35);
    const base = this.nv, W = nx + 1;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) this._hfVert(x0 + (x1 - x0) * i / nx, z0 + (z1 - z0) * j / nz, e, fn);
    if (this.nv - base !== W * (nz + 1)) return this;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = base + j * W + i; this.quad(a, a + 1, a + W + 1, a + W); }
    return this;
  }
  _hfVert(x, z, e, fn) {
    if (!fn) return this.vertex(x, 0, z, 0, 1, 0);
    const gx = fn(x + e, z) - fn(x - e, z), gz = fn(x, z + e) - fn(x, z - e);
    const y = fn(x, z); // last call: its colour / material side effects win
    return this.vertex(x, y, z, -gx / (2 * e), 1, -gz / (2 * e));
  }

  // Low-detail human silhouette (~300 triangles) standing at the origin, facing +z.
  // pose: POSE.STAND | WALK | SIT (on the ground) | KNEEL (working) | HAUL (leaning, pulling
  // a rope over the shoulder). height in metres; seed varies build and limb angles.
  human(pose = 0, height = 1.7, seed = 0) {
    const J = POSES[Math.max(0, Math.min(POSES.length - 1, pose | 0))];
    const sh = height / 1.7, wj = 0.92 + 0.16 * hash3(seed, 7, 1), aj = (hash3(seed, 7, 2) - 0.5) * 0.12;
    const P = S;
    for (let i = 0; i < 15; i++) {
      P[i * 3] = J[i * 3] * wj; P[i * 3 + 1] = J[i * 3 + 1]; P[i * 3 + 2] = J[i * 3 + 2];
    }
    // arm swing jitter
    for (const h of [5, 8]) P[h * 3 + 2] += aj * (h === 5 ? 1 : -1);
    this.push(); this.scale(sh, sh, sh);
    const sd = 5;
    const bm = (a, b, r0, r1, caps) => this.beam(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], r0, r1, sd, caps);
    bm(0, 1, 0.14, 0.17, true); // torso
    this.beam(P[3], P[4] + 0.02, P[5], P[18], P[19] + 0.02, P[20], 0.065, 0.065, sd, true); // shoulders
    // neck: chest -> just under the head
    this.beam(P[3], P[4], P[5], P[6] * 0.7 + P[3] * 0.3, P[7] - 0.1, P[8] * 0.7 + P[5] * 0.3, 0.05, 0.045, sd, false);
    bm(3, 4, 0.055, 0.045, false); bm(4, 5, 0.045, 0.034, true); // left arm
    bm(6, 7, 0.055, 0.045, false); bm(7, 8, 0.045, 0.034, true); // right arm
    bm(9, 10, 0.085, 0.06, false); bm(10, 11, 0.06, 0.042, true); // left leg
    bm(12, 13, 0.085, 0.06, false); bm(13, 14, 0.06, 0.042, true); // right leg
    // feet
    for (const f of [11, 14]) this.beam(P[f * 3], P[f * 3 + 1], P[f * 3 + 2] - 0.03, P[f * 3], Math.max(0.03, P[f * 3 + 1] - 0.03), P[f * 3 + 2] + 0.15, 0.045, 0.035, 4, true);
    this.push(); this.translate(P[6], P[7], P[8]); this.ellipsoid(0.095, 0.118, 0.105, 2); this.pop();
    this.pop();
    return this;
  }

  // Campfire at (x, y, z) in the current frame: ring of hearth stones, ash bed, logs and
  // flame tongues. light = 0 (none) or 1/2 to bind light slot light-1 to it (moves that
  // light above the flames and scales its intensity by lit); lit = 0..1 (0 = cold hearth).
  fire(x, y, z, size = 1, light = 1, lit = 1) {
    const src = light > 0 ? light : FLICKER.OWN;
    this.push(); this.translate(x, y, z);
    const sv = this.rand() * 1000 | 0;
    // ash bed with glowing centre
    const self = this, R = 0.7 * size;
    this.surface(SURF.EARTH).ao(0.9);
    this.disc(R, 16, 3, (px, pz) => {
      const r = Math.hypot(px, pz) / R;
      const glow = Math.max(0, 1 - r * 1.6) * lit;
      self.color(0.05 + 0.2 * glow, 0.045 + 0.06 * glow, 0.04).emissive(glow * 0.22, src);
      return 0.03 + 0.06 * Math.max(0, 1 - r * r);
    });
    this.emissive(0, 0);
    // hearth stones
    this.surface(SURF.STONE).ao(0.85);
    const ns = 9;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * Math.PI * 2 + this.rand() * 0.3, r = 0.8 * size;
      const g = 0.16 + this.rand() * 0.08;
      this.color(g, g * 0.97, g * 0.92);
      this.push(); this.translate(Math.cos(a) * r, 0.04 * size, Math.sin(a) * r); this.rotateY(-a);
      this.rock(0.2 * size, 0.12 * size, 0.15 * size, 2, 0.25, sv + i, 2, 0.4);
      this.pop();
    }
    // logs (charred ends point inward)
    this.surface(SURF.WOOD).ao(0.9);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4 + this.rand() * 0.4;
      const c = Math.cos(a), s = Math.sin(a);
      this.color(0.11, 0.075, 0.05);
      this.beam(c * 0.85 * size, 0.07 * size, s * 0.85 * size, c * 0.25 * size, 0.1 * size, s * 0.25 * size, 0.07 * size, 0.06 * size, 6, true);
      this.color(0.03, 0.025, 0.02).emissive(0.12 * lit, src);
      this.beam(c * 0.25 * size, 0.1 * size, s * 0.25 * size, c * 0.08 * size, 0.18 * size, s * 0.08 * size, 0.06 * size, 0.04 * size, 6, true);
      this.emissive(0, 0);
    }
    // flames: layered, animated flame cards with a hot core, plus embers (FX layer)
    if (lit > 0.02) this.flames(0, 0.08 * size, 0, size * (0.45 + 0.55 * lit), src, sv);
    if (light > 0) {
      this.lightAt(light - 1, 0, 0.55 * size, 0); this.lightScale(light - 1, lit);
      const rg = this.lights[(light - 1) * 12 + 3];
      if (rg > 0) this.glow(0, 0, rg * 0.85); // firelight on the surrounding terrain
    }
    this.pop();
    return this;
  }

  // Cheap campfire for distant companions (satellites): a trampled bare patch, a glowing ash
  // bed, three logs, flames with their own flicker (no light slot), a warm halo that keeps at
  // least `halo` px radius on screen however far away, and a smoke column rising `rise` m
  // (<= 60; smoke 0 = none, 1 = normal) that is dark and blue enough to hold against a pale
  // sky. About 120 opaque triangles plus ~75 FX cards.
  farFire(size = 1, rise = 50, smoke = 1, halo = 5) {
    const src = FLICKER.OWN, sv = this.rand() * 1000 | 0, self = this, R = 0.8 * size;
    const g = this.bio('ground'), P = 3.2 + 1.6 * size;
    // bare, trampled patch: a low dome sunk at its rim so it sits on uneven ground
    this.surface(SURF.EARTH).ao(1).color(g[0] * 0.72, g[1] * 0.66, g[2] * 0.6);
    this.disc(P, 14, 3, (px, pz) => { const r = Math.hypot(px, pz) / P; return 0.12 - 0.5 * r * r * r; });
    this.surface(SURF.EARTH).ao(0.9);
    this.disc(R, 10, 2, (px, pz) => {
      const r = Math.hypot(px, pz) / R, gl = Math.max(0, 1 - r * 1.5);
      self.color(0.05 + 0.25 * gl, 0.045 + 0.07 * gl, 0.04).emissive(gl * 0.3, src);
      return 0.15 + 0.05 * Math.max(0, 1 - r * r);
    });
    this.emissive(0, 0);
    this.surface(SURF.WOOD).ao(0.9).color(0.1, 0.07, 0.05);
    for (let i = 0; i < 3; i++) {
      const a = i * 2.09 + this.rand() * 0.5, c = Math.cos(a), s = Math.sin(a);
      this.beam(c * 0.75 * size, 0.18 * size, s * 0.75 * size, c * 0.1 * size, 0.28 * size, s * 0.1 * size, 0.06 * size, 0.05 * size, 4, true);
    }
    this.flames(0, 0.18 * size, 0, size, src, sv);
    if (halo > 0) {
      this.color(1.0, 0.55, 0.22).alpha(1);
      this._fxBegin(FX.HALO, (sv % 97) / 97, src, Math.min(255, halo * 10));
      this._card(0, 0.7 * size, 0, 1.6 * size);
      this._fxEnd();
    }
    if (smoke > 0) {
      this.smoke(0, 1.0 * size, 0, { count: 34, size: 1.1 * size * (0.7 + 0.5 * smoke), rise, density: 0.34 * smoke, color: [0.3, 0.31, 0.37], src });
    }
    return this;
  }

  // ---- FX layer helpers (smoke, flames, embers, ground light). All are animated in the
  // shader from the frame time; src = FLICKER.LIGHT0 / LIGHT1 ties their strength to that
  // light's live level (a dying fire), FLICKER.NONE / OWN keeps them at full strength.
  _fxBegin(kind, seed, src, param) {
    this._sv = this.me | (this.mf << 8) | (this.ma << 16) | (this.mk << 24); this._sl = this.li;
    this.me = Math.floor(seed * 255) & 255; this.mf = src | 0; this.ma = Math.max(0, Math.min(255, Math.round(param))); this.mk = kind; this.li = 1;
  }
  _fxEnd() { const v = this._sv; this.me = v & 255; this.mf = (v >>> 8) & 255; this.ma = (v >>> 16) & 255; this.mk = v >>> 24; this.li = this._sl; this.ca = 255; }
  // One camera-facing card anchored at (x, y, z): the shader reads the corner from the normal.
  _card(x, y, z, size) {
    const f = this.f, b0 = this.nv;
    for (let k = 0; k < 4; k++) {
      const i = this.vertex(x, y, z, 0, 1, 0);
      if (i < 0) return this;
      f[i * 8 + 3] = (k === 1 || k === 2) ? 1 : -1; f[i * 8 + 4] = k >= 2 ? 1 : -1; f[i * 8 + 5] = size;
    }
    return this.quad(b0, b0 + 1, b0 + 2, b0 + 3);
  }
  // Soft translucent smoke rising from (x, y, z): n puffs of base size s (m) spread evenly in
  // time, rising `rise` m (<= 60) and drifting downwind (def.wind). colour = albedo, density
  // = peak opacity of one puff. Optional: phase (0..1, default 0) shifts every puff's place in
  // its rise cycle (a single-puff call otherwise always gets the same phase: pass b.rand() to
  // scatter many one-puff calls); spread (default 0.4) is the random size range (0 = exactly
  // `size`, and draws no b.rand()).
  smoke(x, y, z, o = {}) {
    const n = o.count ?? 24, s = o.size ?? 0.5, rise = o.rise ?? 14, den = o.density ?? 0.35, src = o.src ?? FLICKER.LIGHT0;
    const c = o.color || [0.42, 0.42, 0.44], ph = o.phase ?? 0, sp = o.spread ?? 0.4;
    this.color(c[0], c[1], c[2]).alpha(den);
    for (let i = 0; i < n; i++) {
      const q = (i + 0.5) / n + ph;
      this._fxBegin(FX.SMOKE, q - Math.floor(q), src, rise * 4);
      this._card(x, y, z, sp > 0 ? s * (1 - 0.5 * sp + sp * this.rand()) : s);
      this._fxEnd();
    }
    return this;
  }
  // Halo: one soft additive glow card at (x, y, z), `size` m in radius, in the current colour
  // and alpha (alpha scales its strength: a faint dome over a city wants ~0.01, a fire's halo
  // 1). minPx (0..25.5, as farFire's `halo`) keeps it at least that many px in radius on screen
  // at any range (0 = none); seed (0..1) varies its slow breathing; src ties it to a
  // light's level (FLICKER.LIGHT0/1) or not (NONE / OWN). FX layer, no shadow.
  halo(x, y, z, size, minPx = 0, seed = 0, src = FLICKER.NONE) {
    this._fxBegin(FX.HALO, seed, src, Math.min(255, minPx * 10));
    this._card(x, y, z, size);
    this._fxEnd();
    return this;
  }
  // Layered fire at (x, y, z), height h: an outer ring of tall orange tongues, a hot
  // yellow-white core and rising embers.
  flames(x, y, z, h, src = FLICKER.LIGHT0, seed = 1) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const core = i < 2, a = (i / n) * 6.283 + seed * 0.37, r = core ? 0.02 * h : 0.13 * h;
      const hh = h * (core ? 0.6 + 0.1 * i : 0.65 + 0.5 * hash3(seed, i, 5)), w = core ? 0.5 : 0.3 + 0.12 * hash3(seed, i, 6);
      if (core) this.color(1.0, 0.82, 0.5).alpha(1); else this.color(1.0, 0.5, 0.16).alpha(0.75);
      this._fxBegin(FX.FLAME, hash3(seed, i, 7), src, w * 255);
      this._card(x + Math.cos(a) * r, y, z + Math.sin(a) * r, hh);
      this._fxEnd();
    }
    this.embers(x, y + 0.2 * h, z, 14, h * 2.6, src);
    return this;
  }
  // Sparks rising and fading above a fire.
  embers(x, y, z, n = 12, rise = 2.5, src = FLICKER.LIGHT0) {
    this.color(1.0, 0.55, 0.18).alpha(1);
    for (let i = 0; i < n; i++) {
      this._fxBegin(FX.EMBER, (i + 0.5) / n, src, Math.min(255, rise * 40));
      this._card(x, y, z, 0.035);
      this._fxEnd();
    }
    return this;
  }
  // Ground light decal: a disc of radius r on the ground (1.5 cm up) that adds the landmark's
  // point lights to the terrain under it, using the biome ground albedo. Landmark floors laid
  // above 2 cm hide it, so it only shows where the terrain itself is visible.
  glow(x, z, r, albedo) {
    const al = albedo || this.bio('ground');
    // stay inside the flattened pad (terrain beyond it is not at y = 0)
    const m = this.m, cx = m[0] * x + m[6] * z + m[9], cz = m[2] * x + m[8] * z + m[11];
    r = Math.min(r, this.padR - Math.hypot(cx, cz) - 0.5);
    if (r < 1) return this;
    this.color(al[0], al[1], al[2]).alpha(1);
    this._fxBegin(FX.GLOW, 0, 0, 0);
    this.push(); this.translate(x, 0, z);
    this.disc(r, 28, 5, () => 0.015);
    this.pop();
    this._fxEnd();
    return this;
  }

  // Flash: one white-hot additive glare card at (x, y, z), `size` m in radius and never under
  // minPx (<= 255) px on screen, that cuts through haze. Its brightness is the level of its
  // source: put it on a rig and drive a.gain(k, 0..1) from def.animate (0 = off), or give it
  // appear / vanish tags. Colour = the current colour (default warm white). FX layer, no shadow.
  flash(x, y, z, size = 30, minPx = 90, r = 1, g = 0.96, bl = 0.88) {
    this.color(r, g, bl).alpha(1);
    this._fxBegin(FX.FLASH, 0, FLICKER.NONE, minPx);
    this._card(x, y, z, size);
    this._fxEnd();
    return this;
  }

  // Appends a src/mesh.js MeshBuilder (or its build() output) in the current transform with
  // the current material (its material ids are ignored).
  addMesh(mb) {
    const v = mb.vertices || mb.v, ix = mb.indices || mb.i;
    const base = this.nv, n = v.length / 8 | 0;
    for (let k = 0; k < n; k++) this.vertex(v[k * 8], v[k * 8 + 1], v[k * 8 + 2], v[k * 8 + 3], v[k * 8 + 4], v[k * 8 + 5]);
    if (this.nv - base !== n) return this;
    for (let k = 0; k + 2 < ix.length; k += 3) this.tri(base + ix[k], base + ix[k + 1], base + ix[k + 2]);
    return this;
  }

  // Grid helpers: G holds W x H positions (row-major, rows along v); writes GN normals as
  // cross(d/dv, d/du), wrapping u when closedU.
  _gridNormals(W, H, closedU) {
    for (let k = 0; k < H; k++) {
      for (let i = 0; i < W; i++) {
        let i0 = i - 1, i1 = i + 1;
        if (closedU) { if (i0 < 0) i0 = W - 2; if (i1 > W - 1) i1 = 1; } else { if (i0 < 0) i0 = 0; if (i1 > W - 1) i1 = W - 1; }
        const k0 = Math.max(0, k - 1), k1 = Math.min(H - 1, k + 1);
        let ux = G[(k * W + i1) * 3] - G[(k * W + i0) * 3], uy = G[(k * W + i1) * 3 + 1] - G[(k * W + i0) * 3 + 1], uz = G[(k * W + i1) * 3 + 2] - G[(k * W + i0) * 3 + 2];
        if (ux * ux + uy * uy + uz * uz < 1e-14) { // pole: borrow the neighbouring ring's direction
          const kk = k > 0 ? k - 1 : Math.min(H - 1, k + 1);
          ux = G[(kk * W + i1) * 3] - G[(kk * W + i0) * 3]; uy = G[(kk * W + i1) * 3 + 1] - G[(kk * W + i0) * 3 + 1]; uz = G[(kk * W + i1) * 3 + 2] - G[(kk * W + i0) * 3 + 2];
        }
        const vx = G[(k1 * W + i) * 3] - G[(k0 * W + i) * 3], vy = G[(k1 * W + i) * 3 + 1] - G[(k0 * W + i) * 3 + 1], vz = G[(k1 * W + i) * 3 + 2] - G[(k0 * W + i) * 3 + 2];
        const o = (k * W + i) * 3;
        GN[o] = vy * uz - vz * uy; GN[o + 1] = vz * ux - vx * uz; GN[o + 2] = vx * uy - vy * ux;
      }
    }
  }
  _emitGrid(W, H) {
    const base = this.nv;
    for (let q = 0; q < W * H; q++) this.vertex(G[q * 3], G[q * 3 + 1], G[q * 3 + 2], GN[q * 3], GN[q * 3 + 1], GN[q * 3 + 2]);
    if (this.nv - base !== W * H) return;
    for (let k = 0; k < H - 1; k++) for (let i = 0; i < W - 1; i++) { const a = base + k * W + i; this.quad(a, a + 1, a + W + 1, a + W); }
  }
}
const NOCAPS = { caps: false };

// Rock surface point for cube face o at (u, v) into S[out..out+2]; params in S[40..46].
function _rockPt(C, o, u, v, out) {
  let x = C[o] + C[o + 3] * u + C[o + 6] * v, y = C[o + 1] + C[o + 4] * u + C[o + 7] * v, z = C[o + 2] + C[o + 5] * u + C[o + 8] * v;
  const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
  const rough = S[43], facets = S[44], flat = S[45], seed = S[46];
  let r = 1;
  if (rough > 0) {
    const sx = seed * 7.13;
    r += rough * ((fbm3(x * 1.7 + sx, y * 1.7, z * 1.7 - sx, 3) - 0.5) * 2.0) + rough * 0.35 * (noise3(x * 6 + sx, y * 6, z * 6) - 0.5);
  }
  for (let p = 0; p < facets; p++) {
    const dn = x * S[p * 4] + y * S[p * 4 + 1] + z * S[p * 4 + 2];
    if (dn > 1e-3) r = Math.min(r, S[p * 4 + 3] / dn);
  }
  let py = y * r * S[41];
  const fy = -S[41] * (1 - flat);
  if (flat > 0 && py < fy) py = fy;
  S[out] = x * r * S[40]; S[out + 1] = py; S[out + 2] = z * r * S[42];
}

// Joint tables for human(): pelvis, chest, head, lShoulder, lElbow, lHand, rShoulder, rElbow,
// rHand, lHip, lKnee, lFoot, rHip, rKnee, rFoot (metres for a 1.7 m figure facing +z).
const POSES = [
  [0, 0.95, 0, 0, 1.38, 0, 0, 1.6, 0.01, 0.19, 1.4, 0, 0.23, 1.12, -0.02, 0.24, 0.85, 0.03, -0.19, 1.4, 0, -0.23, 1.12, -0.02, -0.24, 0.85, 0.03,
    0.1, 0.93, 0, 0.11, 0.5, 0.03, 0.12, 0.08, 0.0, -0.1, 0.93, 0, -0.11, 0.5, 0.03, -0.12, 0.08, 0.0],
  [0, 0.93, 0, 0, 1.36, 0.04, 0, 1.58, 0.07, 0.19, 1.38, 0.04, 0.22, 1.12, -0.08, 0.22, 0.88, -0.12, -0.19, 1.38, 0.04, -0.22, 1.12, 0.12, -0.21, 0.9, 0.24,
    0.1, 0.91, 0, 0.1, 0.52, 0.2, 0.1, 0.08, 0.3, -0.1, 0.91, 0, -0.1, 0.48, -0.06, -0.1, 0.14, -0.3],
  [0, 0.17, 0, 0, 0.6, 0.05, 0, 0.82, 0.1, 0.19, 0.62, 0.05, 0.21, 0.42, 0.22, 0.15, 0.42, 0.4, -0.19, 0.62, 0.05, -0.21, 0.42, 0.22, -0.15, 0.42, 0.4,
    0.1, 0.15, 0, 0.14, 0.42, 0.36, 0.13, 0.07, 0.55, -0.1, 0.15, 0, -0.14, 0.42, 0.36, -0.13, 0.07, 0.55],
  [0, 0.55, -0.08, 0, 0.95, 0.12, 0, 1.15, 0.25, 0.19, 0.98, 0.14, 0.2, 0.72, 0.32, 0.15, 0.45, 0.47, -0.19, 0.98, 0.14, -0.2, 0.72, 0.32, -0.15, 0.45, 0.47,
    0.1, 0.53, -0.08, 0.12, 0.07, 0.08, 0.12, 0.07, -0.38, -0.1, 0.53, -0.08, -0.12, 0.52, 0.35, -0.12, 0.07, 0.38],
  [0, 0.88, 0, 0, 1.24, 0.26, 0, 1.4, 0.4, 0.19, 1.27, 0.25, 0.2, 1.05, 0.45, 0.06, 1.12, 0.58, -0.19, 1.27, 0.25, -0.2, 1.05, 0.45, -0.06, 1.12, 0.58,
    0.1, 0.86, 0, 0.1, 0.5, 0.24, 0.1, 0.08, 0.36, -0.1, 0.86, 0, -0.1, 0.44, -0.22, -0.1, 0.12, -0.52],
];

// ---------------------------------------------------------------------------------
// Building

// Resets b, seeds it, copies def.lights in and runs def.build. Returns the generator when
// build() is a generator function (step it with it.next() across frames), else null.
// biome: a BIOME_INDEX name or 0..6 (default def.biome, else savannah) picks the
// palette b.bio() returns and the ground-light albedo. For live landmarks (def.live) the
// geometry does not depend on built / decay: they only set the handle's initial state.
export const BIOME_INDEX = { savannah: 0, ice: 1, desert: 2, forest: 3, steppe: 4, mountains: 5, coast: 6 };
export function beginBuild(def, b, built, decay, seed, biome) {
  b.reset();
  b.seed(seed);
  const bi = biome ?? def.biome ?? 0;
  b.biome = typeof bi === 'string' ? (BIOME_INDEX[bi] ?? 0) : Math.max(0, Math.min(BIOMES.length - 1, bi | 0));
  b.setLightsFrom(def.lights);
  b.padR = def.pad > 0 ? def.pad : 1e9;
  b.built0 = Math.min(1, Math.max(0, built)); b.decay0 = Math.min(1, Math.max(0, decay));
  const r = def.build(b, b.built0, b.decay0, seed | 0);
  return r && typeof r.next === 'function' ? r : null;
}
// Runs a whole build synchronously; returns b.counts().
export function buildLandmark(def, b, built, decay, seed, biome) {
  const it = beginBuild(def, b, built, decay, seed, biome);
  if (it) while (!it.next().done);
  return b.counts();
}

// Contract and geometry checks (dev tool / viewer). Returns an array of warning strings.
export function checkLandmark(def, b) {
  const w = [];
  for (const k of ['id', 'name', 'caption']) if (typeof def[k] !== 'string' || !def[k]) w.push(`missing string field '${k}'`);
  for (const k of ['year', 'radius', 'pad']) if (typeof def[k] !== 'number' || !isFinite(def[k])) w.push(`missing number field '${k}'`);
  if (typeof def.straddlesRoad !== 'boolean') w.push(`'straddlesRoad' must be a boolean`);
  if (!Array.isArray(def.lights) || def.lights.length > MAX_LIGHTS) w.push(`'lights' must be an array of at most ${MAX_LIGHTS}`);
  if (typeof def.build !== 'function') w.push(`'build' must be a function`);
  if (b.overflow) w.push(`builder overflow: geometry was dropped (limit ${b.maxV} vertices / ${b.maxI / 3} triangles)`);
  const tris = (b.ni + b.na) / 3;
  if (tris > MAX_TRIS) w.push(`${tris} triangles exceeds the ${MAX_TRIS} budget`);
  const f = b.f, R = def.radius, rx = roadOffset(def);
  let nan = 0, outside = 0, road = 0, maxR = 0, maxY = -1e9, minY = 1e9;
  for (let i = 0; i < b.nv; i++) {
    const x = f[i * 8], y = f[i * 8 + 1], z = f[i * 8 + 2];
    if (!(isFinite(x) && isFinite(y) && isFinite(z) && isFinite(f[i * 8 + 3]))) { nan++; continue; }
    const r = Math.hypot(x, z);
    if (r > maxR) maxR = r;
    if (y > maxY) maxY = y;
    if (y < minY) minY = y;
    if (r > R + 0.5) outside++;
  }
  // Road clearance on triangle centroids and vertices.
  for (let L = 0; L < 2; L++) {
  const I = L ? b.aidx : b.idx, nI = L ? b.na : b.ni;
  for (let t = 0; t < nI; t += 3) {
    for (let k = 0; k < 4; k++) {
      let x, y, z;
      if (k < 3) { const v = I[t + k] * 8; x = f[v]; y = f[v + 1]; z = f[v + 2]; } else {
        const a = I[t] * 8, c = I[t + 1] * 8, d = I[t + 2] * 8;
        x = (f[a] + f[c] + f[d]) / 3; y = (f[a + 1] + f[c + 1] + f[d + 1]) / 3; z = (f[a + 2] + f[c + 2] + f[d + 2]) / 3;
      }
      if (def.straddlesRoad) { if (Math.abs(x) < ROAD.straddleHalfWidth && y > 0.05 && y < ROAD.straddleHeight) { road++; break; } }
      else if (x < -rx + ROAD.clearance && y > 0.05) { road++; break; }
    }
  }
  }
  if (nan) w.push(`${nan} vertices with NaN/Infinity`);
  if (outside) w.push(`${outside} vertices beyond radius ${R} m (furthest ${maxR.toFixed(1)} m)`);
  if (road) w.push(def.straddlesRoad
    ? `${road} triangles intrude the road clearance box (|x| < ${ROAD.straddleHalfWidth}, 0.05 < y < ${ROAD.straddleHeight})`
    : `${road} triangles within ${ROAD.clearance} m of the road centre line (x < ${(-rx + ROAD.clearance).toFixed(1)}) above 5 cm`);
  if (def.pad > rx - ROAD.halfWidth - 1 && !def.straddlesRoad) w.push(`pad ${def.pad} m reaches the road (road edge at ${(rx - ROAD.halfWidth).toFixed(1)} m from the origin)`);
  b.bounds = { maxR, minY, maxY };
  return w;
}

// FNV-1a over the built buffers (determinism check).
export function hashBuild(b) {
  let h = 0x811c9dc5;
  const u = b.u8, n = b.nv * 32;
  for (let i = 0; i < n; i += 4) h = Math.imul(h ^ (u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24)), 16777619);
  const I = b.idx;
  for (let i = 0; i < b.ni; i++) h = Math.imul(h ^ I[i], 16777619);
  const t = b.tu8, nt = b.nv * 24;
  for (let i = 0; i < nt; i += 4) h = Math.imul(h ^ (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24)), 16777619);
  for (let i = 0; i < b.nf; i++) h = Math.imul(h ^ b.fidx[i], 16777619);
  for (let i = 0; i < b.na; i++) h = Math.imul(h ^ b.aidx[i], 16777619);
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------------
// Rendering

export const LANDMARK_VERTEX_LAYOUT = [{
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'unorm8x4' },
    { shaderLocation: 3, offset: 28, format: 'unorm8x4' },
  ],
}];
// Second stream: live-state tags (see LandmarkBuilder.appear / vanish).
export const LANDMARK_TIME_LAYOUT = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 4, offset: 0, format: 'unorm8x4' },
    { shaderLocation: 5, offset: 4, format: 'uint8x4' },
    { shaderLocation: 6, offset: 8, format: 'float32x4' },
  ],
};
const LM_BUFFERS = [LANDMARK_VERTEX_LAYOUT[0], LANDMARK_TIME_LAYOUT];

const LM_COMMON = /* wgsl */ `
struct LM {
  model: mat4x4f,  // landmark local -> world (yaw + translation)
  l0p: vec4f,      // light 0 world position, range (0 = off)
  l0c: vec4f,      // light 0 colour * intensity * live level, flicker amount
  l1p: vec4f,
  l1c: vec4f,
  prm: vec4f,      // x: flicker phase seed, y: built, z: decay
  lv: vec4f,       // x, y: live level of light 0 / 1; z, w: wind direction (local x, z)
  rig: array<vec4f, ${RIGS * 4}>, // per rig: rows 0-2 of its local transform (3x4), then (gain, shown, scale, -)
};
@group(1) @binding(0) var<uniform> L: LM;
struct VIn {
  @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) col: vec4f, @location(3) mat: vec4f,
  @location(4) thr: vec4f, @location(5) mode: vec4u, @location(6) piv: vec4f,
};

// Flicker multiplier (mean ~1) for a seed, from the frame time: no CPU work per frame.
fn lmFlick(seed: f32, amt: f32) -> f32 {
  let t = F.time;
  let n = sin(t * 11.3 + seed * 7.1) * 0.45 + sin(t * 17.9 + seed * 3.3) * 0.3 + sin(t * 5.7 + seed * 11.0) * 0.25 + sin(t * 31.0 + seed) * 0.15;
  return max(0.0, 1.0 + amt * 0.4 * n);
}
// Dusk-lit emissive level (b.duskLit): ~0.08 in full sun, 1 once the key sun is low.
fn lmDusk() -> f32 { return mix(0.08, 1.0, 1.0 - smoothstep(0.05, 0.30, F.sunDir.y)); }
fn lmDrv(m: u32) -> f32 { return select(L.prm.y, L.prm.z, (m & 16u) != 0u); }
// Rig of a vertex (flags byte bits 2-4; 0 = none) and its transform (b.rig, def.animate).
fn lmRigK(fl: u32) -> u32 { return (fl >> 2u) & 7u; }
fn lmRigP(k: u32, p: vec4f) -> vec3f { let b = (k - 1u) * 4u; return vec3f(dot(L.rig[b], p), dot(L.rig[b + 1u], p), dot(L.rig[b + 2u], p)); }
fn lmRigX(k: u32) -> vec4f { return L.rig[(k - 1u) * 4u + 3u]; }
fn lmDir(b: u32) -> vec3f { let a = f32(b) * (6.2831853 / 256.0); return vec3f(sin(a), 0.0, cos(a)); }

// One motion (MOTION in kit.js) at presence a.
fn lmMotion(m: u32, a: f32, p: vec3f, n: ptr<function, vec3f>, piv: vec4f, db: u32) -> vec3f {
  let k = 1.0 - a;
  var r = p;
  if (m == 1u) { r = p - vec3f(0.0, k * piv.w, 0.0); }
  else if (m == 2u) { r = vec3f(p.x, piv.y + (p.y - piv.y) * max(a, 0.002), p.z); }
  else if (m == 3u) { r = piv.xyz + (p - piv.xyz) * max(a, 0.002); }
  else if (m == 4u) {
    let dir = lmDir(db);
    let th = k * 1.52;
    let c = cos(th);
    let s = sin(th);
    let v = p - piv.xyz;
    let al = dot(v.xz, dir.xz);
    let na = al * c + v.y * s;
    let nn = *n;
    let nal = dot(nn.xz, dir.xz);
    let nna = nal * c + nn.y * s;
    *n = vec3f(nn.x + dir.x * (nna - nal), -nal * s + nn.y * c, nn.z + dir.z * (nna - nal));
    r = piv.xyz + vec3f(v.x + dir.x * (na - al), -al * s + v.y * c, v.z + dir.z * (na - al));
  }
  else if (m == 5u) { r = p + vec3f(0.0, k * piv.w, 0.0); }
  else if (m == 6u) {
    let cy = piv.y + piv.w * a;
    if (p.y > cy) { r = vec3f(p.x, cy - 0.004 * (p.y - cy), p.z); }
  }
  else if (m == 7u) { r = p - (*n) * (k * piv.w); }
  return r;
}

// Applies the live state to a vertex. Returns false when it is hidden; mc = how far its
// colour has morphed to the vanish target (MORPH); pa = presence of REVEAL / FADE (1 else).
fn lmAnim(v: VIn, p: ptr<function, vec3f>, n: ptr<function, vec3f>, mc: ptr<function, f32>, pa: ptr<function, f32>) -> bool {
  let fl = v.mode.z;
  if (fl == 0u) { return true; }
  if ((fl & 1u) != 0u) {
    let mi = v.mode.x;
    let d = lmDrv(mi);
    let m = mi & 15u;
    if (m != 8u && d < v.thr.x - f32(mi >> 5u) * 0.02) { return false; }
    var a = smoothstep(v.thr.x, v.thr.y, d);
    if (m == 6u || m >= 9u) { a = clamp((d - v.thr.x) / (v.thr.y - v.thr.x), 0.0, 1.0); } // CLIP, REVEAL, FADE: linear
    if (m >= 9u) { *pa = a; }
    else if (m == 8u) { (*p).y = mix(v.piv.x, (*p).y, a); } else { *p = lmMotion(m, a, *p, n, v.piv, v.mode.w); }
  }
  if ((fl & 2u) != 0u) {
    let mo = v.mode.y;
    let m = mo & 15u;
    var a = 1.0 - smoothstep(v.thr.z, v.thr.w, lmDrv(mo));
    if (m == 6u || m >= 8u) { a = 1.0 - clamp((lmDrv(mo) - v.thr.z) / (v.thr.w - v.thr.z), 0.0, 1.0); } // MORPH vanish linear too (a steady fill)
    if (m == 8u) { (*p).y = mix(v.piv.y, (*p).y, a); *mc = 1.0 - a; }
    else {
      if (a <= 0.0) { return false; }
      if (m >= 9u) { *pa = *pa * a; } else { *p = lmMotion(m, a, *p, n, v.piv, v.mode.w); }
    }
  }
  return true;
}
// Presence only (FX layer: fades instead of moving).
fn lmPresence(v: VIn) -> f32 {
  let fl = v.mode.z;
  var a = 1.0;
  if ((fl & 1u) != 0u) { a = smoothstep(v.thr.x, v.thr.y, lmDrv(v.mode.x)); }
  if ((fl & 2u) != 0u) { a *= 1.0 - smoothstep(v.thr.z, v.thr.w, lmDrv(v.mode.y)); }
  return a;
}
fn lmUnpack(c: f32) -> vec3f {
  let u = u32(c + 0.5);
  let s = vec3f(f32(u & 255u), f32((u >> 8u) & 255u), f32((u >> 16u) & 255u)) / 255.0;
  return s * s;
}
fn lmLevel(src: i32) -> f32 {
  if (src == 1) { return L.lv.x; }
  if (src == 2) { return L.lv.y; }
  return 1.0;
}
`;

const LM_LIGHTING = /* wgsl */ `
const EMAX = ${EMISSIVE_MAX.toFixed(1)};
fn lmHash(p: vec3i) -> f32 {
  var h = (u32(p.x) * 73856093u) ^ (u32(p.y) * 19349663u) ^ (u32(p.z) * 83492791u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h & 0xffffffu) / 16777215.0;
}
fn lmNoise(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(lmHash(i), lmHash(i + vec3i(1, 0, 0)), f.x), mix(lmHash(i + vec3i(0, 1, 0)), lmHash(i + vec3i(1, 1, 0)), f.x), f.y);
  let b = mix(mix(lmHash(i + vec3i(0, 0, 1)), lmHash(i + vec3i(1, 0, 1)), f.x), mix(lmHash(i + vec3i(0, 1, 1)), lmHash(i + vec3i(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
fn lmNoise2(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lmHash(vec3i(i, 0)), lmHash(vec3i(i.x + 1, i.y, 0)), f.x), mix(lmHash(vec3i(i.x, i.y + 1, 0)), lmHash(vec3i(i.x + 1, i.y + 1, 0)), f.x), f.y);
}
fn pointLight(lp: vec4f, lc: vec4f, seed: f32, wp: vec3f, n: vec3f, ao: f32) -> vec3f {
  if (lp.w <= 0.0) { return vec3f(0.0); }
  let d = lp.xyz - wp;
  let d2 = dot(d, d);
  if (d2 > lp.w * lp.w) { return vec3f(0.0); }
  let l = d * inverseSqrt(max(d2, 1e-6));
  let ndl = max(dot(n, l) * 0.9 + 0.1, 0.0);
  let x = d2 / (lp.w * lp.w);
  let win = (1.0 - x * x) * (1.0 - x * x);
  return lc.rgb * (ndl * win * lmFlick(seed, lc.w) * mix(1.0, ao, 0.5) / (PI * (d2 + 0.3)));
}
fn lmLights(wp: vec3f, n: vec3f, ao: f32) -> vec3f {
  return pointLight(L.l0p, L.l0c, L.prm.x, wp, n, ao) + pointLight(L.l1p, L.l1c, L.prm.x + 5.3, wp, n, ao);
}
`;

const LM_MAIN_WGSL = MAIN_HEADER + LM_COMMON + LM_LIGHTING + /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) col: vec3f,
  @location(3) mat: vec4f,
  @location(4) lp: vec3f,
  @location(5) rk: vec4f, // SURF.ROCK only: bed coordinate, stain, snow patch, joint (low frequency, per vertex)
  @location(6) rs: f32,   // SURF.ROCK only: snow-line jitter
};

fn srcFlick(src: i32, lp: vec3f) -> f32 {
  if (src == 1) { return lmFlick(L.prm.x, L.l0c.w) * L.lv.x; }
  if (src == 2) { return lmFlick(L.prm.x + 5.3, L.l1c.w) * L.lv.y; }
  if (src == 3) { return lmFlick(L.prm.x + dot(floor(lp * 0.5), vec3f(1.7, 3.1, 5.3)), 0.7); }
  return 1.0;
}

fn lmVert(v: VIn, pa: ptr<function, f32>) -> VOut {
  var o: VOut;
  var p = v.pos;
  var n = v.nrm;
  var mc = 0.0;
  if (!lmAnim(v, &p, &n, &mc, pa)) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); *pa = 0.0; return o; }
  // Flames (strongly emissive, flickering) sway a little.
  if (v.mat.x > 0.5 && v.mat.y > 0.0) {
    let t = F.time;
    let s = sin(t * 8.7 + p.y * 7.0 + p.x * 3.0) * 0.5 + sin(t * 13.1 + p.y * 11.0 + p.z * 5.0) * 0.3;
    p += vec3f(s, 0.0, s * 0.7) * 0.035;
  }
  var gain = 1.0;
  let rk = lmRigK(v.mode.z);
  if (rk != 0u) {
    let rx = lmRigX(rk);
    if (rx.y <= 0.0) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); *pa = 0.0; return o; }
    p = lmRigP(rk, vec4f(p, 1.0));
    n = lmRigP(rk, vec4f(n, 0.0));
    gain = rx.x;
  }
  let w = L.model * vec4f(p, 1.0);
  o.wp = w.xyz;
  o.n = (L.model * vec4f(n, 0.0)).xyz;
  o.col = v.col.rgb * v.col.rgb; // sqrt-encoded
  if (mc > 0.0) { o.col = mix(o.col, lmUnpack(v.piv.z), mc); }
  o.mat = vec4f(v.mat.x * gain * select(1.0, lmDusk(), (v.mode.z & 64u) != 0u), v.mat.yzw);
  o.lp = v.pos;
  o.rk = vec4f(0.0);
  o.rs = 0.0;
  if (u32(v.mat.w * 255.0 + 0.5) == 11u) {
    let q = v.pos;
    let w1 = lmNoise(vec3f(q.x * 0.035, 2.0, q.z * 0.035)) * 2.0 - 1.0;
    let w2 = lmNoise(vec3f(q.x * 0.11, 4.0, q.z * 0.11)) * 2.0 - 1.0;
    o.rk = vec4f((q.y + 2.4 * w1 + 0.9 * w2) / 3.1,
      smoothstep(0.6, 0.85, lmNoise(vec3f(q.x * 0.04 + 9.0, q.y * 0.06, q.z * 0.04))),
      smoothstep(0.38, 0.66, lmNoise(q * 0.06 + vec3f(2.0, 0.0, 0.0))),
      smoothstep(0.8, 0.9, lmNoise(vec3f((q.z + q.x * 0.5) * 0.09, 5.5, select(8.3, 1.3, q.x > 0.0)))));
    o.rs = 0.25 * (lmNoise(q * 0.25) - 0.5);
  }
  o.pos = F.viewProj * w;
  return o;
}
@vertex fn vs(v: VIn) -> VOut { var pa = 1.0; return lmVert(v, &pa); }

// Procedural albedo breakup per surface kind (landmark-local position, fine detail fades
// with distance so it does not shimmer).
fn surfaceDetail(kind: i32, p: vec3f, dist: f32, fwy: f32) -> f32 {
  let fine = 1.0 - smoothstep(25.0, 90.0, dist);
  if (kind == 1) { // stone
    return 0.78 + 0.32 * lmNoise(p * 1.3) + fine * 0.22 * (lmNoise(p * 6.5) - 0.5) + fine * 0.12 * (lmNoise(p * 23.0) - 0.5);
  } else if (kind == 2) { // earth, mud brick
    return 0.8 + 0.3 * lmNoise(p * 0.8) + fine * 0.18 * (lmNoise(p * 5.0) - 0.5);
  } else if (kind == 3) { // wood (grain along local y and the longest axis is not known: mixed)
    return 0.8 + 0.25 * lmNoise(vec3f(p.x * 9.0, p.y * 0.9, p.z * 9.0)) + fine * 0.15 * (lmNoise(p * 14.0) - 0.5);
  } else if (kind == 4) { // hide, cloth
    return 0.9 + 0.12 * lmNoise(p * 2.0) + fine * 0.1 * (lmNoise(p * 15.0) - 0.5);
  } else if (kind == 5) { // thatch, reeds, brush
    return 0.72 + 0.4 * lmNoise(vec3f(p.x * 18.0, p.y * 1.6, p.z * 18.0)) * mix(0.6, 1.0, fine);
  } else if (kind == 6) { // plaster, dressed limestone, paint ground
    return 0.92 + 0.1 * lmNoise(p * 0.7) + fine * 0.06 * (lmNoise(p * 9.0) - 0.5);
  } else if (kind == 7) { // polished casing: very soft mottling and fine course joints (1.25 m)
    // anti-aliased joint lines: thin dark seams that average out to a faint banding far away
    let j = abs(fract(p.y * 0.8) - 0.5) * 2.0;
    let w = 0.05;
    let f = max(fwy * 0.8 * 2.0, 1e-4);
    let cov = clamp((j - (1.0 - w)) / f + 0.5, 0.0, 1.0) * min(1.0, w / f + 0.3);
    let joint = 1.0 - 0.16 * cov;
    return (0.95 + 0.07 * lmNoise(p * 0.06) + fine * 0.04 * (lmNoise(p * 3.0) - 0.5)) * joint;
  }
  return 1.0;
}

// SURF.ROCK: stylised bedded limestone evaluated in landmark space per fragment (no mesh
// parameterisation, so a coarse or fan-shaped grid cannot smear it): each bed one of three
// tones, thin anti-aliased partings, soft vertical joints, a faint warm stain; snow settles on
// up-facing ledges in patches, scaled by snowK (the vertex's flicker byte, 0..1).
fn rockStrata(base: vec3f, p: vec3f, rk: vec4f, rs: f32, ny: f32, snowK: f32, dist: f32, fwy: f32, fwn: f32) -> vec3f {
  let st = rk.x;
  let fs = fract(st);
  let hb = lmHash(vec3i(i32(floor(st)), 17, 5));
  let tone = select(select(1.13, 1.0, hb < 0.68), 0.84, hb < 0.36);
  let fw = max(fwy * (1.0 / 3.1) * 1.3, 1e-4); // derivatives come from uniform control flow
  let d = min(fs, 1.0 - fs);
  // partings break up along their length (not contour lines), and each bed is lighter at its
  // ledge top and darker under the overhang of the bed above, so the beds read as steps
  let brk = smoothstep(0.3, 0.6, lmNoise2(vec2f((p.x + p.z) * 0.09, st * 3.0)));
  let part = (1.0 - smoothstep(0.02 - fw, 0.04 + fw, d)) * clamp(0.05 / fw, 0.0, 1.0) * brk;
  let step = mix(0.86, 1.07, smoothstep(0.0, 0.35, fs)) * mix(1.0, 0.93, smoothstep(0.75, 1.0, fs));
  let joint = rk.w;
  let grain = 0.95 + 0.1 * lmNoise2(vec2f(p.x * 0.8 + p.z * 0.6, p.y * 0.8));
  var c = base * tone * step * mix(vec3f(1.0), vec3f(1.1, 1.0, 0.86), rk.y * 0.25);
  c *= (1.0 - 0.3 * part - 0.22 * joint) * grain;
  let ledge = smoothstep(0.6, 0.95, fs);
  let sl = ny + 0.12 * ledge + rs - 0.3 * joint;
  let bias = 0.1 * (1.0 - snowK);
  let sw = clamp(fwn * 1.5, 0.01, 0.2);
  let snow = smoothstep(0.7 + bias - sw, 1.0 + bias + sw, sl) * (0.15 + 0.85 * rk.z) * snowK;
  return mix(c, vec3f(0.78, 0.82, 0.88), snow);
}

fn lmShade(i: VOut) -> vec3f {
  let n = normalize(i.n);
  let e = i.mat.x;
  let src = i32(i.mat.y * 255.0 + 0.5);
  let ao = i.mat.z;
  var kind = i32(i.mat.w * 255.0 + 0.5);
  let dist = distance(F.camPos, i.wp);
  let fwy = fwidth(i.lp.y);
  let fwn = fwidth(n.y);
  var sunOcc = 1.0;
  var alb: vec3f;
  if (kind == 11) { // bedded rock: strata, joints and snow per fragment (src byte = snow amount)
    alb = rockStrata(i.col, i.lp, i.rk, i.rs, n.y, i.mat.y, dist, fwy, fwn);
    kind = 0;
  } else {
    var cave = 1.0;
    if (kind >= 9) {
      sunOcc = ao * ao;
      // cave rock: blotchy calcite and stain at hand scale, shared by the wall and anything
      // painted on it (pigment then reads as soaked into the same rock)
      if (kind == 9 && dist < 60.0) { cave = 0.74 + 0.42 * lmNoise2(vec2f(i.lp.z * 2.1 + i.lp.x * 1.3, i.lp.y * 2.1)) * (1.0 - smoothstep(30.0, 60.0, dist)) + 0.21 * smoothstep(30.0, 60.0, dist); }
      kind = kind - 8;
    }
    alb = i.col * (surfaceDetail(kind, i.lp, dist, fwy) * cave);
  }
  let ndl = max(dot(n, F.sunDir), 0.0);
  var sh = sunOcc;
  if (ndl > 0.0 && sunOcc > 0.002) { sh = shadowAt(i.wp, n) * sunOcc; }
  let sunE = sunIlluminance();
  var c: vec3f;
  if (kind >= 7) {
    // Polished limestone (7): a broad, soft sun sheen and a faint sky reflection over the
    // diffuse face. Gilt (8): metal, gold-tinted highlight and sky reflection, little diffuse.
    let vdir = normalize(F.camPos - i.wp);
    let h = normalize(vdir + F.sunDir);
    let nh = max(dot(n, h), 0.0);
    let fres = pow(1.0 - max(dot(n, vdir), 0.0), 5.0);
    let r = reflect(-vdir, n);
    let sky = skyRadiance(normalize(vec3f(r.x, max(r.y, 0.02), r.z)));
    if (kind == 7) {
      // Form light (stylised): the sun term is remapped so faces turned toward the sun read
      // clearly brighter and warmer than faces turned away, even when the sun sits between
      // two faces (a pyramid's faces differ in N.L by only ~0.3 there); the shadow side keeps
      // the cool sky fill, a little reduced so it reads as shade.
      let fl = pow(ndl, 2.6) * 1.7;
      let away = 1.0 - smoothstep(0.35, 0.85, ndl);
      // broad warm sheen (a wide lobe that sweeps across the whole face) plus a tighter glint
      let sheen = pow(nh, 5.0) * 0.12 + pow(nh, 18.0) * 0.55 + pow(nh, 90.0) * 0.4;
      c = alb * (sunE * vec3f(1.0, 0.96, 0.9) * (fl * sh / PI) + skyAmbient(n) * mix(vec3f(0.95, 0.97, 1.04), vec3f(0.7, 0.78, 1.22), away) * (ao * (1.0 - 0.33 * away) / PI)) + sunE * vec3f(1.0, 0.93, 0.8) * (sheen * fl * sh / PI) + sky * (0.03 + 0.25 * fres) * ao;
    } else {
      let gold = alb;
      let spec = (pow(nh, 28.0) * 2.2 + pow(nh, 220.0) * 9.0) * ndl * sh;
      c = gold * 0.25 * (sunE * (ndl * sh / PI) + skyAmbient(n) * (ao / PI)) + gold * (sunE * spec / PI + sky * (0.35 + 0.65 * fres));
    }
  } else {
    c = alb * (sunE * (ndl * sh / PI) + skyAmbient(n) * (ao / PI));
  }
  c += alb * lmLights(i.wp, n, ao);
  if (e > 0.0) {
    c = c * (1.0 - min(e * 1.6, 0.85)) + i.col * (e * EMAX * srcFlick(src, i.lp));
  }
  return applyFog(c, i.wp);
}
@fragment fn fs(i: VOut) -> @location(0) vec4f { return vec4f(lmShade(i), 1.0); }

// REVEAL / FADE range: same shading, coverage from the presence (alpha-to-coverage).
struct VOutA {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) col: vec3f,
  @location(3) mat: vec4f,
  @location(4) lp: vec3f,
  @location(5) fa: vec4f, // presence, reveal (1) / fade (0), reach
  @location(6) fp: vec3f, // reveal origin (landmark space)
  @location(7) rk: vec4f,
  @location(8) rs: f32,
};
@vertex fn vsA(v: VIn) -> VOutA {
  var pa = 1.0;
  let b = lmVert(v, &pa);
  var o: VOutA;
  o.pos = b.pos; o.wp = b.wp; o.n = b.n; o.col = b.col; o.mat = b.mat; o.lp = b.lp; o.rk = b.rk; o.rs = b.rs;
  let rv = ((v.mode.z & 1u) != 0u && (v.mode.x & 15u) == 9u) || ((v.mode.z & 2u) != 0u && (v.mode.y & 15u) == 9u);
  o.fa = vec4f(pa, select(0.0, 1.0, rv), max(v.piv.w, 0.01), 0.0);
  o.fp = v.piv.xyz;
  return o;
}
@fragment fn fsA(i: VOutA) -> @location(0) vec4f {
  var a = i.fa.x;
  if (i.fa.y > 0.5) {
    // a ragged front spreading from the origin: pigment soaking in, a line being drawn
    let q = i.lp;
    let pat = distance(q, i.fp) / i.fa.z + (lmNoise(q * 7.0) - 0.5) * 0.3 + (lmNoise(q * 31.0) - 0.5) * 0.14;
    a = clamp((a * 1.5 - pat) / 0.07, 0.0, 1.0);
  }
  var s: VOut;
  s.pos = i.pos; s.wp = i.wp; s.n = i.n; s.col = i.col; s.mat = i.mat; s.lp = i.lp; s.rk = i.rk; s.rs = i.rs;
  let c = lmShade(s);
  if (a < 0.01) { discard; }
  return vec4f(c, a);
}
`;

const LM_SHADOW_WGSL = SHADOW_HEADER + LM_COMMON + /* wgsl */ `
@vertex fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  if (v.mat.x > 0.5) { return vec4f(0.0, 0.0, -2.0, 1.0); } // flames cast no shadow
  var p = v.pos;
  var n = v.nrm;
  var mc = 0.0;
  var pa = 1.0;
  if (!lmAnim(v, &p, &n, &mc, &pa) || pa < 0.5) { return vec4f(0.0, 0.0, -2.0, 1.0); }
  let rk = lmRigK(v.mode.z);
  if (rk != 0u) {
    if ((v.mode.z & 32u) != 0u || lmRigX(rk).y <= 0.0) { return vec4f(0.0, 0.0, -2.0, 1.0); }
    p = lmRigP(rk, vec4f(p, 1.0));
  }
  return F.lightViewProj * (L.model * vec4f(p, 1.0));
}
`;

// FX layer: camera-facing animated cards (smoke, flames, embers) and the ground-light decal,
// blended (premultiplied alpha; flames, embers and light are additive with alpha 0).
const LM_FX_WGSL = MAIN_HEADER + LM_COMMON + LM_LIGHTING + /* wgsl */ `
struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) uv: vec2f,
  @location(2) col: vec4f,
  @location(3) misc: vec4f,
  @location(4) @interpolate(flat) kind: u32,
};
fn h1(x: f32) -> f32 { return fract(sin(x * 91.7 + 3.1) * 43758.5453); }

@vertex fn vsFx(v: VIn) -> FOut {
  var o: FOut;
  let kind = u32(v.mat.w * 255.0 + 0.5);
  let seed = v.mat.x;
  let src = i32(v.mat.y * 255.0 + 0.5);
  var prm = v.mat.z * 255.0;
  var lvl = lmLevel(src) * lmPresence(v);
  o.kind = kind;
  var lp = v.pos;
  var csz = v.nrm.z; // card size (m), scaled with its rig
  let rk = lmRigK(v.mode.z);
  if (rk != 0u) {
    let rx = lmRigX(rk);
    lvl *= rx.x * select(0.0, 1.0, rx.y > 0.0);
    lp = lmRigP(rk, vec4f(lp, 1.0));
    csz *= rx.z;
    if (kind == 20u) { prm *= rx.z; } // smoke rises in proportion
  }
  let anchor = (L.model * vec4f(lp, 1.0)).xyz;
  let corner = v.nrm.xy;
  o.uv = corner;
  let tc = F.camPos - anchor;
  let toCam = tc / max(length(tc), 1e-3);
  var wp = anchor;
  if (kind == 23u) { // ground light: lit in the fragment shader; fog transmittance per vertex
    let T = applyFog(vec3f(1.0), wp) - applyFog(vec3f(0.0), wp);
    o.col = vec4f(v.col.rgb * v.col.rgb * T, 0.0);
  } else if (kind == 20u) { // smoke puff
    // a dying source's plume is shorter as well as thinner
    let rise = max(prm * 0.25, 2.0) * (0.3 + 0.7 * lvl);
    let life = rise * 0.7;
    let age = fract(F.time / life + seed);
    let wind = (L.model * vec4f(L.lv.z, 0.0, L.lv.w, 0.0)).xyz;
    let j = vec3f(h1(seed * 17.0) - 0.5, 0.0, h1(seed * 29.0) - 0.5);
    let c = anchor + vec3f(0.0, rise * age, 0.0) + wind * (rise * 0.5 * age * age) + j * (0.4 + 2.2 * age);
    // puffs are drawn out along the column (taller than wide while young) so neighbours
    // overlap into one continuous plume instead of a string of beads
    let sz = csz * (0.45 + 3.4 * age);
    let right = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-4, 0.0, 0.0));
    let up = cross(toCam, right);
    let ang = (h1(seed * 41.0) - 0.5) * 0.5 + age * 0.4;
    let cr = vec2f(corner.x * cos(ang) - corner.y * sin(ang), corner.x * sin(ang) + corner.y * cos(ang));
    wp = c + (right * cr.x + up * cr.y * (2.2 - 1.1 * age)) * sz;
    var a = v.col.a * smoothstep(0.0, 0.1, age) * pow(1.0 - age, 1.4) * sqrt(max(lvl, 0.0));
    // sunlit (forward scattering toward the sun) plus sky fill; the base glows from the fire
    let fwd = 0.5 + 0.5 * dot(-toCam, F.sunDir);
    let lit = sunIlluminance() * max(F.sunDir.y + 0.05, 0.0) * (0.22 + 0.5 * fwd * fwd) / PI + skyAmbient(vec3f(0.0, 1.0, 0.0)) * (0.9 / PI);
    var col = v.col.rgb * v.col.rgb * lit + vec3f(1.0, 0.45, 0.15) * (3.0 * pow(1.0 - age, 40.0) * lvl);
    col = applyFog(col, wp);
    o.col = vec4f(col, a);
    o.misc = vec4f(seed, age, 0.0, 0.0);
  } else if (kind == 21u) { // flame card: cylindrical billboard, base at the anchor
    let fl = select(lmFlick(L.prm.x + seed * 3.0, 0.7), lmFlick(L.prm.x + select(0.0, 5.3, src == 2), 0.8), src == 1 || src == 2);
    let hgt = csz * (0.25 + 0.75 * lvl) * (0.85 + 0.25 * fl);
    let wid = hgt * prm / 255.0;
    let right = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-4, 0.0, 0.0));
    let vv = corner.y * 0.5 + 0.5;
    let sway = (sin(F.time * 6.3 + seed * 40.0) * 0.6 + sin(F.time * 10.7 + seed * 13.0) * 0.4) * 0.12 * hgt * vv * vv;
    wp = anchor + right * (corner.x * wid * 0.5 + sway) + vec3f(0.0, vv * hgt, 0.0);
    let T = applyFog(vec3f(1.0), wp) - applyFog(vec3f(0.0), wp);
    o.col = vec4f(v.col.rgb * v.col.rgb * (v.col.a * EMAX * 0.22 * fl * min(lvl * 1.5, 1.0)) * T, 0.0);
    o.misc = vec4f(seed, wid / max(hgt, 1e-3), 0.0, 0.0);
  } else if (kind == 25u) { // flash: white-hot additive glare, a minimum size on screen, cuts through haze
    let d = length(tc);
    let sz = max(csz, d * prm / F.resolution.y);
    let right = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-4, 0.0, 0.0));
    let up = cross(toCam, right);
    wp = anchor + (right * corner.x + up * corner.y) * sz;
    let T = mix(applyFog(vec3f(1.0), wp) - applyFog(vec3f(0.0), wp), vec3f(1.0), 0.7);
    o.col = vec4f(v.col.rgb * v.col.rgb * (EMAX * 3.0 * lvl) * T, 0.0);
  } else if (kind == 24u) { // halo: warm additive glow that keeps a minimum size on screen (far fires)
    let d = length(tc);
    let px = d * prm * 0.1 / F.resolution.y; // prm: minimum radius in tenths of a pixel-ish unit
    let sz = max(csz, px);
    let right = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-4, 0.0, 0.0));
    let up = cross(toCam, right);
    wp = anchor + (right * corner.x + up * corner.y) * sz;
    let fl = lmFlick(L.prm.x + seed * 7.0, 0.5);
    let T = applyFog(vec3f(1.0), wp) - applyFog(vec3f(0.0), wp);
    // the same light spread over a larger disc up close; at range the floor size holds it
    let k = min(1.0, csz / sz) * 0.65 + 0.35;
    o.col = vec4f(v.col.rgb * v.col.rgb * (v.col.a * EMAX * 0.12 * fl * lvl * k) * T, 0.0);
  } else { // ember: a spark spiralling up, fading
    let rise = prm / 40.0;
    let life = 1.6 + 1.4 * h1(seed * 7.0);
    let age = fract(F.time / life + seed * 3.7);
    let ang = seed * 37.0 + age * 5.0;
    let rr = (0.08 + 0.35 * age) * (0.4 + h1(seed * 11.0));
    let wind = (L.model * vec4f(L.lv.z, 0.0, L.lv.w, 0.0)).xyz;
    let c = anchor + vec3f(cos(ang) * rr, rise * age * (0.6 + 0.6 * h1(seed * 5.0)), sin(ang) * rr) + wind * age * age * rise * 0.4;
    let right = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-4, 0.0, 0.0));
    let up = cross(toCam, right);
    // keep a spark at least ~1.5 px wide so it does not shimmer
    let px = length(c - F.camPos) * 1.6 / F.resolution.y;
    let sz = max(csz, px);
    wp = c + (right * corner.x + up * corner.y) * sz;
    let tw = 0.6 + 0.4 * sin(F.time * 23.0 + seed * 50.0);
    let T = applyFog(vec3f(1.0), wp) - applyFog(vec3f(0.0), wp);
    let fade = pow(1.0 - age, 1.5) * smoothstep(0.0, 0.05, age) * (csz / sz) * (csz / sz);
    o.col = vec4f(v.col.rgb * v.col.rgb * (EMAX * 0.9 * fade * tw * lvl) * T, 0.0);
  }
  if (kind != 23u) { o.wp = wp; } else { o.wp = anchor; o.misc = vec4f(lvl, 0.0, 0.0, 0.0); }
  o.pos = F.viewProj * vec4f(wp, 1.0);
  return o;
}

@fragment fn fsFx(i: FOut) -> @location(0) vec4f {
  if (i.kind == 23u) {
    let c = i.col.rgb * lmLights(i.wp, vec3f(0.0, 1.0, 0.0), 1.0) * i.misc.x;
    return vec4f(c, 0.0);
  }
  if (i.kind == 20u) {
    let r = length(i.uv);
    let n = lmNoise(vec3f(i.uv * 1.6 + vec2f(i.misc.x * 17.0, 0.0), i.misc.y * 1.5 + i.misc.x * 9.0));
    let n2 = lmNoise(vec3f(i.uv * 3.7 + vec2f(3.0, i.misc.x * 5.0), i.misc.y * 2.5));
    let soft = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.65 + (n2 - 0.5) * 0.25);
    let a = i.col.a * soft * soft;
    return vec4f(i.col.rgb * a, a);
  }
  if (i.kind == 21u) {
    let v = i.uv.y * 0.5 + 0.5;
    let t = F.time;
    let s = i.misc.x;
    let n = lmNoise(vec3f(i.uv.x * 1.3 + s * 13.0, v * 2.4 - t * 3.1, s * 7.0 + t * 0.4));
    let n2 = lmNoise(vec3f(i.uv.x * 3.1 - s * 5.0, v * 5.0 - t * 5.3, s * 3.0));
    // teardrop envelope: widest a quarter of the way up, a licking, broken tip
    let env = pow(1.0 - v, 1.4) * sqrt(clamp(v * 6.0, 0.0, 1.0)) * 1.3;
    let u = abs(i.uv.x + (n - 0.5) * 0.9 * v + (n2 - 0.5) * 0.3 * v);
    let d = u / max(env, 1e-3);
    let body = smoothstep(1.0, 0.5, d) * smoothstep(0.95, 0.35, v + (n - 0.5) * 0.7 * v + (n2 - 0.5) * 0.25);
    let core = smoothstep(0.55, 0.0, d) * (1.0 - smoothstep(0.02, 0.4, v + (n2 - 0.5) * 0.25));
    let hue = mix(vec3f(1.0, 0.32, 0.07), vec3f(1.0, 0.72, 0.32), clamp(core * 1.4 + (1.0 - v) * 0.3, 0.0, 1.0));
    let c = i.col.rgb * (hue * body + vec3f(1.0, 0.8, 0.5) * core * 1.2);
    return vec4f(c, 0.0);
  }
  let r = length(i.uv);
  if (i.kind == 25u) { // flash: a white-hot core in a broad falloff (no hard rim when it saturates)
    let q = max(1.0 - r, 0.0);
    return vec4f(i.col.rgb * (q * q * q * 0.12 + smoothstep(0.28, 0.0, r)), 0.0);
  }
  let g = smoothstep(1.0, 0.0, r);
  return vec4f(i.col.rgb * g * g, 0.0);
}
`;

const kit = { bgl: null, main: null, shadow: null, fx: null, a2c: null };
export const UNIFORM_FLOATS = 40 + RIGS * 16; // 40 + the rigs (4 vec4 each)

// Creates the shared pipelines. Call once after initGpu().
export async function initLandmarkKit() {
  if (kit.main) return;
  const d = gpu.device;
  kit.bgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const mm = d.createShaderModule({ label: 'landmark', code: LM_MAIN_WGSL });
  const sm = d.createShaderModule({ label: 'landmark-sh', code: LM_SHADOW_WGSL });
  const fm = d.createShaderModule({ label: 'landmark-fx', code: LM_FX_WGSL });
  const pm = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
  [kit.main, kit.shadow, kit.fx, kit.a2c] = await Promise.all([
    mainPipeline({ label: 'landmark', module: mm, layouts: [kit.bgl], buffers: LM_BUFFERS, cullMode: 'back' }),
    shadowPipeline({ label: 'landmark-sh', module: sm, layouts: [kit.bgl], buffers: LM_BUFFERS }),
    mainPipeline({ label: 'landmark-fx', module: fm, vertex: 'vsFx', fragment: 'fsFx', layouts: [kit.bgl], buffers: LM_BUFFERS, cullMode: 'none', depthWrite: false, blend: pm }),
    mainPipeline({ label: 'landmark-a2c', module: mm, vertex: 'vsA', fragment: 'fsA', layouts: [kit.bgl], buffers: LM_BUFFERS, cullMode: 'back', alphaToCoverage: true }),
  ]);
}

function sstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Uploads the builder's current contents as a landmark placed at world (x, y, z) with yaw
// (radians about +y, same sense as rotateY) and registers it with gpu.js. The builder can
// be reused immediately. Returns a handle: { setPose(x, y, z, yaw), setState(built, decay),
// destroy(), visible, triangles, fxTriangles, built, decay }. Draw calls are skipped beyond
// drawDistance (default radius + 4000 m) and shadow casting beyond shadowDistance (radius +
// 2.5 x camera.shadowRadius). setState may be called every frame: it allocates nothing and
// writes the 160-byte uniform only when the state changed.
export function uploadLandmark(def, b, x = 0, y = 0, z = 0, yaw = 0, phase = 0) {
  if (!kit.main) throw new Error('initLandmarkKit() first');
  const d = gpu.device, U = GPUBufferUsage;
  const nv = Math.max(1, b.nv), ni = b.ni, nf = b.nf, na = b.na, nAll = ni + na;
  const vbuf = d.createBuffer({ label: 'lm-v ' + def.id, size: nv * 32, usage: U.VERTEX | U.COPY_DST });
  if (b.nv) d.queue.writeBuffer(vbuf, 0, b.data, 0, b.nv * 32);
  const tbuf = d.createBuffer({ label: 'lm-t ' + def.id, size: nv * 24, usage: U.VERTEX | U.COPY_DST });
  if (b.nv) d.queue.writeBuffer(tbuf, 0, b.tdata, 0, b.nv * 24);
  // opaque indices, then the REVEAL / FADE (alpha-to-coverage) range
  const ibuf = d.createBuffer({ label: 'lm-i ' + def.id, size: Math.max(4, nAll * 4), usage: U.INDEX | U.COPY_DST });
  if (ni) d.queue.writeBuffer(ibuf, 0, b.idx, 0, ni);
  if (na) d.queue.writeBuffer(ibuf, ni * 4, b.aidx, 0, na);
  const fbuf = nf ? d.createBuffer({ label: 'lm-f ' + def.id, size: nf * 4, usage: U.INDEX | U.COPY_DST }) : null;
  if (nf) d.queue.writeBuffer(fbuf, 0, b.fidx, 0, nf);
  const ubuf = d.createBuffer({ label: 'lm-u ' + def.id, size: UNIFORM_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST });
  const bg = d.createBindGroup({ layout: kit.bgl, entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  const u = new Float32Array(UNIFORM_FLOATS);
  const lights = new Float32Array(b.lights);
  const rules = new Float32Array(b.lightRule);
  const lvl = new Float32Array(MAX_LIGHTS);
  // REVEAL / FADE range: when every element in it is fully present (all appear windows
  // passed, no vanish window begun) it is drawn with the opaque pipeline (no alpha-to-coverage
  // cost); a2cWin = max appear end by built / decay, min vanish start by built / decay.
  const a2cWin = new Float32Array([-1, -1, 2, 2]);
  if (na) {
    const t = b.tu8;
    for (let i = 0; i < b.nv; i++) {
      const o = i * 24, fl = t[o + 6];
      if ((fl & 1) && (t[o + 4] & 15) >= 9) { const k = t[o + 4] & 16 ? 1 : 0, v = t[o + 1] / 255; if (v > a2cWin[k]) a2cWin[k] = v; }
      if ((fl & 2) && (t[o + 5] & 15) >= 9) { const k = t[o + 5] & 16 ? 3 : 2, v = t[o + 2] / 255; if (v < a2cWin[k]) a2cWin[k] = v; }
    }
  }
  let a2cSettled = false;
  for (let k = 0; k < RIGS; k++) { const o = 40 + k * 16; u[o] = 1; u[o + 5] = 1; u[o + 10] = 1; u[o + 12] = 1; u[o + 13] = 1; u[o + 14] = 1; }
  const anim = typeof def.animate === 'function' ? def.animate : null;
  let animFrame = -1;
  const wind = def.wind || null;
  let wx = wind ? wind[0] : 0.6, wz = wind ? wind[1] : 0.8;
  const wl = Math.hypot(wx, wz) || 1; wx /= wl; wz /= wl;
  const h = {
    def, x: 0, y: 0, z: 0, yaw: 0, visible: true, triangles: nAll / 3, fxTriangles: nf / 3, a2cTriangles: na / 3,
    built: b.built0, decay: b.decay0,
    drawDistance: Math.max(def.radius, def.reach || 0) + 4000, shadowDistance: def.radius + camera.shadowRadius * 2.5,
    // Optional roll (about local z, + lifts local +x) and pitch (about local x, + dips local
    // +z): moving props such as the crossing's ship (world/crossing.js). Lights follow yaw only.
    setPose(px, py, pz, pyaw, roll, pitch) {
      h.x = px; h.y = py; h.z = pz; h.yaw = pyaw;
      const c = Math.cos(pyaw), s = Math.sin(pyaw);
      u.fill(0, 0, 16);
      // columns of yaw rotation (same as LandmarkBuilder.rotateY) + translation
      u[0] = c; u[2] = -s; u[5] = 1; u[8] = s; u[10] = c; u[12] = px; u[13] = py; u[14] = pz; u[15] = 1;
      if (roll || pitch) {
        const cr = Math.cos(roll || 0), sr = Math.sin(roll || 0), cp = Math.cos(pitch || 0), sp = Math.sin(pitch || 0);
        // R = yaw * pitch(x) * roll(z); columns of pitch * roll, then yawed
        u[0] = c * cr + s * sp * sr; u[1] = cp * sr; u[2] = -s * cr + c * sp * sr;
        u[4] = -c * sr + s * sp * cr; u[5] = cp * cr; u[6] = s * sr + c * sp * cr;
        u[8] = s * cp; u[9] = -sp; u[10] = c * cp;
      }
      for (let i = 0; i < MAX_LIGHTS; i++) {
        const o = i * 12, w = 16 + i * 8;
        const lx = lights[o], ly = lights[o + 1], lz = lights[o + 2];
        u[w] = c * lx + s * lz + px; u[w + 1] = ly + py; u[w + 2] = -s * lx + c * lz + pz;
      }
      u[32] = 1.7 + phase * 3.1;
      u[38] = wx; u[39] = wz;
      A.cy = c; A.sy = s;
      writeState();
    },
    // Live state: built and decay 0..1 (clamped). Cheap; call every frame.
    setState(built, decay) {
      built = built < 0 ? 0 : built > 1 ? 1 : built;
      decay = decay < 0 ? 0 : decay > 1 ? 1 : decay;
      if (Math.abs(built - h.built) < 1e-5 && Math.abs(decay - h.decay) < 1e-5) return;
      h.built = built; h.decay = decay;
      writeState();
    },
    destroy() {
      removeDrawable(drawable); vbuf.destroy(); tbuf.destroy(); ibuf.destroy(); ubuf.destroy();
      if (fbuf) fbuf.destroy();
    },
  };
  function writeState() {
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const r = i * 4, o = i * 12, w = 16 + i * 8, I = lights[o + 7];
      lvl[i] = sstep(rules[r], rules[r + 1], h.built) * (1 - sstep(rules[r + 2], rules[r + 3], h.decay));
      const k = I * lvl[i];
      u[w + 3] = k > 0 ? lights[o + 3] : 0;
      u[w + 4] = lights[o + 4] * k; u[w + 5] = lights[o + 5] * k; u[w + 6] = lights[o + 6] * k; u[w + 7] = lights[o + 8];
    }
    u[33] = h.built; u[34] = h.decay;
    a2cSettled = h.built >= a2cWin[0] && h.decay >= a2cWin[1] && h.built <= a2cWin[2] && h.decay <= a2cWin[3];
    u[36] = lvl[0]; u[37] = lvl[1];
    d.queue.writeBuffer(ubuf, 0, u);
  }
  // def.animate(a): once per drawn frame (allocation-free; see LANDMARKS.md "Motion").
  const A = {
    t: 0, built: 0, decay: 0, seaX: 1, seaZ: 0, seaY: -1e4, cy: 1, sy: 0, handle: h,
    // Rig k (1..RIGS) in landmark-local space: at (x, y, z), turned by yaw (rotateY sense: its
    // +z faces (sin yaw, cos yaw)), pitch (+ dips its +z), roll (+ lifts its +x), uniform scale.
    set(k, x, y, z, yaw = 0, pitch = 0, roll = 0, sc = 1) {
      const o = 40 + (k - 1) * 16;
      const c = Math.cos(yaw), s = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch);
      // rows of yaw * pitch(x) * roll(z) * scale (columns as in setPose)
      u[o] = (c * cr + s * sp * sr) * sc; u[o + 1] = (-c * sr + s * sp * cr) * sc; u[o + 2] = s * cp * sc; u[o + 3] = x;
      u[o + 4] = cp * sr * sc; u[o + 5] = cp * cr * sc; u[o + 6] = -sp * sc; u[o + 7] = y;
      u[o + 8] = (-s * cr + c * sp * sr) * sc; u[o + 9] = (s * sr + c * sp * cr) * sc; u[o + 10] = c * cp * sc; u[o + 11] = z;
      u[o + 14] = sc;
      return A;
    },
    gain(k, g) { u[40 + (k - 1) * 16 + 12] = g; return A; }, // emissive and FX brightness (1 = as built)
    show(k, on) { u[40 + (k - 1) * 16 + 13] = on ? 1 : 0; return A; }, // 0 hides the part
  };
  function tick() {
    if (animFrame === timing.frames) return;
    animFrame = timing.frames;
    A.t = state.time; A.built = h.built; A.decay = h.decay;
    // the sea in local terms (inverse yaw)
    const sx = SEA[1], sz = SEA[2];
    A.seaX = A.cy * sx - A.sy * sz; A.seaZ = A.sy * sx + A.cy * sz; A.seaY = SEA[0] - h.y;
    anim(A);
    d.queue.writeBuffer(ubuf, 0, u);
  }
  h.animator = A;
  const drawable = {
    shadow(p) {
      if (!h.visible || !nAll) return;
      if (anim) tick();
      const dx = camera.eye[0] - h.x, dz = camera.eye[2] - h.z;
      if (dx * dx + dz * dz > h.shadowDistance * h.shadowDistance) return;
      p.setPipeline(kit.shadow); p.setBindGroup(1, bg);
      p.setVertexBuffer(0, vbuf); p.setVertexBuffer(1, tbuf); p.setIndexBuffer(ibuf, 'uint32');
      p.drawIndexed(nAll);
    },
    main(p) {
      if (!h.visible || !nAll) return;
      if (anim) tick();
      const dx = camera.eye[0] - h.x, dz = camera.eye[2] - h.z;
      if (dx * dx + dz * dz > h.drawDistance * h.drawDistance) return;
      p.setPipeline(kit.main); p.setBindGroup(1, bg);
      p.setVertexBuffer(0, vbuf); p.setVertexBuffer(1, tbuf); p.setIndexBuffer(ibuf, 'uint32');
      if (a2cSettled) { p.drawIndexed(nAll); return; }
      if (ni) p.drawIndexed(ni);
      if (na) { p.setPipeline(kit.a2c); p.drawIndexed(na, 1, ni); }
    },
    transparent(p) {
      if (!h.visible || !nf) return;
      if (anim) tick();
      const dx = camera.eye[0] - h.x, dz = camera.eye[2] - h.z;
      if (dx * dx + dz * dz > h.drawDistance * h.drawDistance) return;
      p.setPipeline(kit.fx); p.setBindGroup(0, gpu.mainBG); p.setBindGroup(1, bg);
      p.setVertexBuffer(0, vbuf); p.setVertexBuffer(1, tbuf); p.setIndexBuffer(fbuf, 'uint32');
      p.drawIndexed(nf);
    },
  };
  h.drawable = drawable;
  h.setPose(x, y, z, yaw);
  addDrawable(drawable);
  return h;
}
