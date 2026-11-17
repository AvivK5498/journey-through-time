// Shared world GPU state: the World uniform, the road field textures and the ground
// height function (WGSL + JS mirror). Everything drawn or computed in the world binds
// this as @group(1) (WORLD_WGSL declares it).
//
// Road field: three camera-centred, texel-snapped 2D maps rasterised from the road
// centrelines every time they move (see road.js):
//   L0 1024^2 at 0.5 m (512 m)   R = distance to the nearest road (m, <= FIELD_W), G = road
//   L1 1024^2 at 4 m   (4 km)        height there, B = region id, A = journey metres
//   L2 512^2  at 32 m  (16 km)   R = distance up to FAR_W (masks the distant relief)
// Roads fading in/out add (1 - presence) * W to their distance, so corridors open and
// close smoothly.

import { gpu, planShadow1, requestShadow1, addPrePass, tsw } from '../gpu.js';
import { MAIN_HEADER } from '../shaders/common.js';
import { NOISE_WGSL, NIO, SIO, noiseNatural, noiseValue } from './noise.js';
import { BIOME_WGSL, BK, BIOME_COUNT, packBiomes, carBiome } from './biomes.js';
import { MAX_EDGES, MAX_PTS, pts, edgePresence, edgeRegion, edgeDrawEnd, DRAW_END_PAD, edgeN, edgeAlive, nearestRoad, edgeBio, edgeParentRegion, graph, graphFocus, pointAt, edgeSplit, edgeSeam } from './graph.js';
import { state } from '../state.js';
import { camera } from '../camera.js';
import { pose as carPose } from '../car.js'; // runtime use only (the import cycle is safe)

export const FIELD_W = 48; // metres of distance stored around each road (L0, L1)
export const FAR_W = 900; // metres for L2
export const FIELD = [
  { size: 512, res: 1024, snap: 8 },
  { size: 4096, res: 1024, snap: 64 },
  { size: 16384, res: 512, snap: 512 },
];

// Biome territories (round three). Every live road splits the land into the territory of its
// region: a point belongs to the region of the nearest road (a seam road counts as its parent's
// region before its split, graph.js edgeSplit, and as its own after it). Between two territories
// a ridge of high ground stands on the boundary, and a seam road passes it by a passage
// (tunnel.js). road.js renders the label map: per region the distance to the nearest road of that
// region (two rgba16float targets, min blend, capsules of radius rb around every `stride`-sample
// chord, a road fading in or out adds (1 - edgeBio) * rb), then resolves it into biomeTex
// (rgba16float, 32 m texels over the L2 extent): r = second distance - first (f, >= 0), g = first
// distance, b = first region + 8 * second region (7 = none within rb), a = distance to the crossing
// of a strait road (no ridge there). WGSL labelAt() / JS labelAtJS() read it the same way: the
// nearest texel's region is the reference, f is made signed (+ inside it) over the 4x4 texels
// around the point and B-spline filtered (smooth, with its gradient), g = |f| / |grad f| is the
// distance to the boundary. Materials switch there over +-tauM / 2 m (no blend in the open), the
// terrain's shape over +-tauS / 2 m (hidden by the ridge); beyond rb from every road the land is
// the car's biome. The JS mirror rounds every texel to half floats as the GPU stores them.
export const LMAP = { res: 512, size: 16384, rb: 1800, stride: 32, big: 30000, near: 220 };
// Legacy fields (sites.js's old kernel fallback reads them; unused while biomeFull exists).
export const BMAP = { res: 512, size: 16384, rb: 1800, sigma: 110, stride: 32, scale: 64, ramp0: 40, ramp1: 480, eps: 0.02 };
// Ridge on every territory boundary: crest hc m (x 0.82-1.22 along it, + rocky detail), a flat
// top wt m either side of the crest line, feet wf m from it (flanks up to ~60 degrees: the car
// cannot climb them). At a passage the crest dips to a saddle hs m above the road and stands as
// a plateau over the passage with cliff faces at the portals (tunnel.js frames them).
export const RIDGE = { hc: 66, wt: 7, wf: 74, hs: 30, tauM: 8, tauS: 120 };
// Passages near the camera (tunnel.js writes it every frame, after the camera; the GPU and the
// JS mirror read the same values). Per slot (12): centre x, z, unit road direction x, z, road y
// at the centre, half length, parent region, own region, slot open 0..1 (the cut through the
// plateau opens when the camera is within ~900 m), style (era) + 8 x clearance from other roads (m), weight (edge's biome presence
// as the label map last drew it), edge (-1 = unused).
export const MAX_TUN = 8;
export const tunData = new Float64Array(MAX_TUN * 12);
for (let i = 0; i < MAX_TUN; i++) tunData[i * 12 + 11] = -1;
// The passage: the terrain is cut to the road between |lateral| < SLOT_HW (+ a SLOT_WALL m wall)
// all through the plateau; tunnel.js covers it with the vault and the rock above it.
export const SLOT_HW = 6.6, SLOT_WALL = 1.6;
// What the GPU label map was last rendered from (per edge 8: biome presence, region, parent
// region, samples, split s, seam kind, 0, 0; then origin x, z, version). Written by road.js.
export const bioSnap = new Float64Array(MAX_EDGES * 8 + 3);
export const BIO_POST = { d0: 1200, d1: 3000, k: 0 }; // (round two's far pull, removed)

// Road surface curve along the journey: surface = mix(surfA, surfB, smoothstep(d0, d1, journey m)).
// 0 game trail, 1 dirt track, 2 stone paving. The time system owns these.
export const surfaceCurve = { a: 0, b: 1, d0: 1500, d1: 1700 };

// Settlement mask (settle.js renders building and field footprints into world.settleTex each
// frame, centred on the L0 field origin W.f0.xy): siteClear() thins grass and props under them.
export const SETTLE_MAP = { res: 256, size: 1024 };

export const SLOT_EDGES = 14;
const SLOT_BP = SLOT_EDGES + MAX_EDGES;
const SLOT_BW = SLOT_BP + BIOME_COUNT * BK; // appended: biome weights at the car, biome map origin
const SLOT_SITES = SLOT_BW + 4; // landmark pads (4) and the land-bridge strait (2)
export const MAX_PADS = 4;
const SLOT_BW2 = SLOT_SITES + MAX_PADS + 2; // appended: biome weights 3-6 at the car, the sea
const SLOT_SIGHT = SLOT_BW2 + 2; // appended: landmark sight wedges, one per pad
const SLOT_TUN = SLOT_SIGHT + MAX_PADS; // appended: passages (3 vec4 each, see tunData)
export const WORLD_VEC4 = SLOT_TUN + MAX_TUN * 3;
// The coast's sea (world.js updateSea): [0] sea level y, [1..2] unit direction (x, z) toward the
// sea side of the coast roads, [3] target level. Mirrored by natural() / groundInfo().
export const seaData = new Float64Array([-1e4, 0, 1, -1e4]);
// Written by sites.js (landmarks, land bridge), mirrored by ground() / groundInfo():
//   [0..15]  pads: x, z, radius, y   (radius 0 = unused). The disc is flattened to y.
//   [16..19] strait: centre x, z, unit direction of the causeway road (x, z)
//   [20..23] strait: half width along the road (0 = none), water y, open (1) / frozen (0),
//            side (+1: the water reaches out to the right of the road direction, -1 left)
export const siteData = new Float64Array(24);
// Sight wedge per pad slot (sites.js, same order as the pads): journey metres abreast of the
// landmark, road centre to origin (m), approach length (m, 0 = none), half width of what is seen
// (m). sightAt() in the WGSL: the ground between the approach road and the landmark, kept clear
// of tall settlement, thinned of trees and tall grass so the landmark is seen from the road.
export const siteSight = new Float64Array(MAX_PADS * 4);
// Pad slot + 1 of the ending's home (0 none; sites.js): settle.js lets neighbours stand right
// up to that lot instead of keeping the usual berth (World.pad0.w).
export const padTight = new Int8Array(1);
export const worldData = new Float32Array(WORLD_VEC4 * 4);
// Field origins (centre x, z) per level, written by updateWorld().
export const fieldOrigin = new Float64Array(6);

export const world = {
  buffer: null,
  bgl: null, // group(1) layout
  bg: null,
  fieldTex: null, // 2-layer array (L0, L1)
  farTex: null,
  biomeTex: null, // label map, resolved (road.js renderBiome): f, d1, regions, strait distance
  labelA: null, // per-region distances: savannah, ice, desert, forest
  biomeTex2: null, // per-region distances: steppe, mountains, coast; strait split distance
  settleTex: null, // settlement footprints (settle.js), see settleAt()
  noiseTex: null, // prefiltered material noise (initNoiseTex), sampled with tn()/tnl()
  probeReady: null, // resolves when the probe pipeline exists (terrain init awaits it)
  probeTex: null, // per-frame lighting probe (initProbe): sky ambient by normal, sun, sky zenith
  fieldFormat: 'rgba16float',
  sampler: null,
};

// --- Material noise texture: four independent smooth value noises (RGBA, 0..1) on a periodic
// 32-cell lattice, 8 texels per cell, quintic-interpolated, with a full mip chain. Sampling
// it (tn / tnl in WORLD_WGSL) costs one filtered fetch for four noises and fades detail
// smoothly with distance instead of aliasing. Built on the CPU at load (procedural, ~10 ms).
const NT = 256, NCELL = 32;
function f2h(v) { // float -> IEEE half (no NaN/inf handling needed: values are 0..1)
  if (v <= 0) return 0;
  let e = Math.floor(Math.log2(v));
  if (e < -14) return Math.round(v / Math.pow(2, -24));
  let m = Math.round((v / Math.pow(2, e) - 1) * 1024);
  if (m >= 1024) { m = 0; e++; }
  return ((e + 15) << 10) | m;
}
function initNoiseTex(d) {
  const lat = new Float32Array(NCELL * NCELL * 4);
  let s = 0x9e3779b9;
  for (let i = 0; i < lat.length; i++) { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; s ^= s >>> 12; lat[i] = (s >>> 8) / 16777216; }
  // Cubic B-spline over the lattice (C2, no flat plateaus at the lattice points, which is what
  // makes thresholded value noise look like soft squares), then each channel is rescaled to
  // the contrast of plain value noise (mean 0.5, sd 0.2).
  const bw = (t, k) => k === 0 ? (1 - t) * (1 - t) * (1 - t) / 6 : k === 1 ? (3 * t * t * t - 6 * t * t + 4) / 6 : k === 2 ? (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6 : t * t * t / 6;
  let lv = new Float32Array(NT * NT * 4);
  for (let y = 0; y < NT; y++) for (let x = 0; x < NT; x++) {
    const fx = (x + 0.5) / 8, fy = (y + 0.5) / 8;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const gx = (ix - 1 + i + NCELL) % NCELL, gy = (iy - 1 + j + NCELL) % NCELL;
        v += lat[(gy * NCELL + gx) * 4 + c] * bw(tx, i) * bw(ty, j);
      }
      lv[(y * NT + x) * 4 + c] = v;
    }
  }
  for (let c = 0; c < 4; c++) {
    let m = 0, m2 = 0;
    for (let i = c; i < lv.length; i += 4) { m += lv[i]; m2 += lv[i] * lv[i]; }
    m /= NT * NT; const sd = Math.sqrt(Math.max(m2 / (NT * NT) - m * m, 1e-9));
    for (let i = c; i < lv.length; i += 4) lv[i] = Math.min(1, Math.max(0, 0.5 + (lv[i] - m) * (0.2 / sd)));
  }
  const levels = Math.log2(NT) + 1;
  const tex = d.createTexture({ size: [NT, NT], format: 'rgba16float', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  let n = NT;
  for (let l = 0; l < levels; l++) {
    const h = new Uint16Array(n * n * 4);
    for (let i = 0; i < h.length; i++) h[i] = f2h(lv[i]);
    d.queue.writeTexture({ texture: tex, mipLevel: l }, h, { bytesPerRow: n * 8 }, [n, n]);
    if (n === 1) break;
    const m = n >> 1, nx = new Float32Array(m * m * 4);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) for (let c = 0; c < 4; c++) {
      nx[(y * m + x) * 4 + c] = 0.25 * (lv[((2 * y) * n + 2 * x) * 4 + c] + lv[((2 * y) * n + 2 * x + 1) * 4 + c] + lv[((2 * y + 1) * n + 2 * x) * 4 + c] + lv[((2 * y + 1) * n + 2 * x + 1) * 4 + c]);
    }
    lv = nx; n = m;
  }
  return tex;
}

export const WORLD_WGSL = /* wgsl */ `
struct World {
  f0: vec4f, f1: vec4f, f2: vec4f, // field centre x, z, texel metres, size metres
  bio: vec4f,    // biomeA, biomeB, blend, time
  surf: vec4f,   // surface curve: a, b, d0, d1
  car: vec4f,    // car x, y, z, speed
  cam: vec4f,    // camera x, y, z, view
  shadowC: vec4f,// shadow centre x, z, radius
  planes: array<vec4f, 6>,
  edges: array<vec4f, ${MAX_EDGES}>, // presence, region, drawEnd, sample count
  bp: array<vec4f, ${BIOME_COUNT * BK}>,
  bw: vec4f,     // biome weights at the car (savannah, ice, desert), 0
  bmap: vec4f,   // biome map centre x, z, texel metres, size metres
  wind: vec4f,   // wind direction xz, gust phase, 0
  pad0: vec4f,   // x: ?bdbg=1, yz: car heading (cos, sin) for its contact shadow, w: home pad slot + 1
  pads: array<vec4f, ${MAX_PADS}>, // landmark pads: x, z, radius, y (sites.js)
  strait: vec4f,  // land bridge: centre x, z, road direction x, z
  strait2: vec4f, // half width along the road (0 = none), water y, open, side
  bw2: vec4f,     // biome weights at the car: forest, steppe, mountains, coast
  sea: vec4f,     // sea level y, unit direction toward the sea (x, z), 0
  sight: array<vec4f, ${MAX_PADS}>, // per pad: journey abreast, road offset, approach, seen half width
  tun: array<vec4f, ${MAX_TUN * 3}>, // passages (tunData): centre xz, dir xz | road y, half length, parent, own | open, style, weight, edge
};
@group(1) @binding(0) var<uniform> W: World;
@group(1) @binding(1) var fieldTex: texture_2d_array<f32>;
@group(1) @binding(2) var farTex: texture_2d<f32>;
@group(1) @binding(3) var fieldSamp: sampler;
@group(1) @binding(4) var biomeTex: texture_2d<f32>;
@group(1) @binding(5) var noiseTex: texture_2d<f32>;
@group(1) @binding(6) var noiseSamp: sampler; // repeat, trilinear, anisotropic
@group(1) @binding(7) var probeTex: texture_2d<f32>;
@group(1) @binding(8) var biomeTex2: texture_2d<f32>;
@group(1) @binding(9) var settleTex: texture_2d<f32>;
const FIELD_W: f32 = ${FIELD_W}.0;
const FAR_W: f32 = ${FAR_W}.0;
` + NOISE_WGSL + BIOME_WGSL + /* wgsl */ `
fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
// Landmark pads: x = flatten weight (1 on the pad, easing out over a skirt), y = pad height,
// z = clearing (1 inside the pad: no grass, props or trees).
fn padAt(p: vec2f) -> vec3f {
  var o = vec3f(0.0, 0.0, 0.0);
  for (var i = 0; i < ${MAX_PADS}; i++) {
    let q = W.pads[i];
    if (q.z <= 0.0) { continue; }
    let r = distance(p, q.xy);
    let sk = 20.0 + 0.3 * q.z;
    let wf = 1.0 - smoothstep(q.z, q.z + sk, r);
    if (wf > o.x) { o = vec3f(wf, q.w, o.z); }
    o.z = max(o.z, 1.0 - smoothstep(q.z * 0.92, q.z + 3.0, r));
  }
  return o;
}
// Land-bridge strait (0..1 water): a band across the causeway road that opens to the sea on
// one side; its shores waver.
fn straitAt(p: vec2f) -> f32 {
  let hw = W.strait2.x;
  if (hw <= 0.0) { return 0.0; }
  let d = p - W.strait.xy;
  let u = dot(d, W.strait.zw);
  let v = dot(d, vec2f(-W.strait.w, W.strait.z)) * W.strait2.w;
  if (abs(u) > hw + 3000.0 || v < -400.0) { return 0.0; }
  let wob = 18.0 * (vnoise(p * (1.0 / 90.0) + vec2f(4.0, 7.0)) - 0.5) + 6.0 * (vnoise(p * (1.0 / 23.0)) - 0.5);
  let hv = hw + max(v, 0.0) * 0.22 + wob;
  let across = 1.0 - smoothstep(hv - 22.0, hv, abs(u));
  let reach = smoothstep(-150.0, -70.0, v + wob);
  return across * reach;
}
// Settlement footprints (settle.js) 0..1 at p.
fn settleAt(p: vec2f) -> f32 {
  let u = (p - W.f0.xy) * (1.0 / ${SETTLE_MAP.size}.0) + 0.5;
  if (max(abs(u.x - 0.5), abs(u.y - 0.5)) > 0.495) { return 0.0; }
  return textureSampleLevel(settleTex, fieldSamp, u, 0.0).r;
}
// Sight wedge (0..1) at p, whose nearest road is d m away at journey metre j: the ground between
// the last ~approach metres of road before a landmark (and alongside it) and the landmark, on
// its side of the road (a straight-road model: the triangle from the road A m back to the
// landmark's far edge). 0 outside every wedge.
fn sightW(p: vec2f, j: f32, d: f32) -> f32 {
  var w = 0.0;
  for (var i = 0; i < ${MAX_PADS}; i++) {
    let s = W.sight[i];
    if (s.z <= 0.0) { continue; }
    let pd = W.pads[i];
    let a = s.x - j;
    if (a < -0.4 * s.w || a > s.z) { continue; }
    let dp = p - pd.xy;
    if (dot(dp, dp) > a * a + s.y * s.y + d * d) { continue; } // the other side of the road
    let lim = (s.y + s.w) * (1.0 - max(a, 0.0) / s.z);
    w = max(w, 1.0 - smoothstep(lim - 25.0, lim, d));
  }
  return w;
}
fn sightAt(p: vec2f) -> f32 {
  var near = false;
  for (var i = 0; i < ${MAX_PADS}; i++) {
    let s = W.sight[i];
    let q = W.pads[i].xy - p;
    let r = s.y + s.w + s.z;
    if (s.z > 0.0 && dot(q, q) < r * r) { near = true; }
  }
  if (!near) { return 0.0; }
  let nf = nearField(p);
  if (nf.z < 0.0) { return 0.0; }
  return sightW(p, nf.w, nf.x);
}
fn siteClear(p: vec2f) -> f32 { return (1.0 - padAt(p).z) * (1.0 - smoothstep(0.05, 0.3, straitAt(p))) * (1.0 - settleAt(p)) * (1.0 - ridgeClear(p)); }
// Material noise (four independent smooth noises, 0..1, period 32 lattice units): x in lattice
// units (position * frequency). tnl: explicit mip level (compute / vertex / rotated lookups);
// tnLod(fw, s): the level for a pixel footprint fw (m) at frequency s (1/m).
fn tnl(x: vec2f, lod: f32) -> vec4f { return mix(textureSampleLevel(noiseTex, noiseSamp, x * (1.0 / 32.0), lod), vec4f(0.5), smoothstep(0.6, 2.6, lod)); }
fn tnLod(fw: f32, s: f32) -> f32 { return log2(max(fw * s * 8.0, 1e-4)); }
// Lighting probe (baked each frame by initProbe's pass from the same skyAmbient / sunIlluminance
// / skyRadiance as common.js, one frame behind the sky LUT): 16x16 octahedral map of the
// ambient by surface normal, then row 16: sun illuminance, sky radiance straight up.
fn probeAmb(n: vec3f) -> vec3f {
  var o = n.xz / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.y < 0.0) { o = (1.0 - abs(o.yx)) * select(vec2f(-1.0), vec2f(1.0), o >= vec2f(0.0)); }
  let uv = vec2f(o.x * 0.5 + 0.5, clamp(o.y * 0.5 + 0.5, 0.5 / 16.0, 15.5 / 16.0) * (16.0 / 17.0));
  return textureSampleLevel(probeTex, fieldSamp, uv, 0.0).rgb;
}
fn probeSun() -> vec3f { return textureLoad(probeTex, vec2i(0, 16), 0).rgb; }
fn probeSkyUp() -> vec3f { return textureLoad(probeTex, vec2i(1, 16), 0).rgb; }

// Near road field: vec4(distance, roadY, region, journey). Distance = FIELD_W when no road.
fn nearField(p: vec2f) -> vec4f {
  let none = vec4f(FIELD_W, 0.0, -1.0, 0.0);
  let u1 = (p - W.f1.xy) / W.f1.w + 0.5;
  let e1 = max(abs(u1.x - 0.5), abs(u1.y - 0.5));
  if (e1 > 0.497) { return none; }
  var s = textureSampleLevel(fieldTex, fieldSamp, u1, 1, 0.0);
  let u0 = (p - W.f0.xy) / W.f0.w + 0.5;
  let e0 = max(abs(u0.x - 0.5), abs(u0.y - 0.5));
  if (e0 < 0.49) {
    let s0 = textureSampleLevel(fieldTex, fieldSamp, u0, 0, 0.0);
    s = mix(s0, s, smoothstep(0.43, 0.49, e0));
  }
  return mix(s, none, smoothstep(0.47, 0.497, e1));
}
fn farField(p: vec2f) -> f32 {
  let u = (p - W.f2.xy) / W.f2.w + 0.5;
  let e = max(abs(u.x - 0.5), abs(u.y - 0.5));
  if (e > 0.497) { return FAR_W; }
  return mix(textureSampleLevel(farTex, fieldSamp, u, 0.0).r, FAR_W, smoothstep(0.45, 0.497, e));
}

// Biome weights at p (BW: a = savannah, ice, desert; b = forest, steppe, mountains, coast) from
// the label map (see LMAP in the JS): one biome per territory, switching on the ridge crest.
struct BW { a: vec3f, b: vec4f };
fn bwSum(w: BW) -> f32 { return w.a.x + w.a.y + w.a.z + w.b.x + w.b.y + w.b.z + w.b.w; }
fn bwScale(w: BW, k: f32) -> BW { return BW(w.a * k, w.b * k); }
fn bwOne(l: u32) -> BW {
  return BW(vec3f(select(0.0, 1.0, l == 0u), select(0.0, 1.0, l == 1u), select(0.0, 1.0, l == 2u)),
    vec4f(select(0.0, 1.0, l == 3u), select(0.0, 1.0, l == 4u), select(0.0, 1.0, l == 5u), select(0.0, 1.0, l == 6u)));
}
fn bwMix(a: BW, b: BW, t: f32) -> BW { return BW(mix(a.a, b.a, t), mix(a.b, b.b, t)); }
fn bwCar() -> BW { return BW(W.bw.rgb, W.bw2); }

const LM_RES: i32 = ${LMAP.res};
const LM_RB: f32 = ${LMAP.rb}.0;
const LM_BIG: f32 = ${LMAP.big}.0;
// Label at p: lab = the territory (reference region), oth = the neighbouring one, f = signed
// boundary function (+ inside lab), g = distance to the boundary (m), d1 = distance to the nearest
// road, ds = distance to a strait road's split. Cached for the last point (ground(), biomeW() and
// siteClear() are often called for the same point in a row).
struct LI { lab: u32, oth: u32, f: f32, g: f32, d1: f32, ds: f32 };
var<private> LIP: vec2f = vec2f(3.4e38, 0.0);
var<private> LIC: LI;
fn lmLoad(i: vec2i) -> vec4f { return textureLoad(biomeTex, clamp(i, vec2i(0), vec2i(LM_RES - 1)), 0); }
fn bsW(t: f32) -> vec4f { let s = 1.0 - t; let t2 = t * t; let t3 = t2 * t; return vec4f(s * s * s, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) * (1.0 / 6.0); }
fn bsD(t: f32) -> vec4f { let s = 1.0 - t; return vec4f(-0.5 * s * s, 1.5 * t * t - 2.0 * t, -1.5 * t * t + t + 0.5, 0.5 * t * t); }
fn labelAt(p: vec2f) -> LI {
  if (p.x == LIP.x && p.y == LIP.y) { return LIC; }
  var o: LI;
  o.lab = 7u; o.oth = 7u; o.f = LM_BIG; o.g = 1e5; o.d1 = LM_BIG; o.ds = LM_BIG;
  let u = (p - W.bmap.xy) / W.bmap.z + f32(LM_RES) * 0.5 - 0.5;
  if (min(u.x, u.y) > 2.0 && max(u.x, u.y) < f32(LM_RES) - 3.0) {
    let c = lmLoad(vec2i(floor(u + 0.5)));
    let code = u32(c.b + 0.5);
    o.lab = code & 7u; o.oth = code >> 3u;
    let q = textureSampleLevel(biomeTex, fieldSamp, (u + 0.5) / f32(LM_RES), 0.0);
    o.f = q.r; o.d1 = q.g; o.ds = q.a;
    if (q.r < ${LMAP.near}.0 && o.lab < 7u) {
      let fl = floor(u);
      let t = u - fl;
      let i0 = vec2i(fl) - vec2i(1);
      let wx = bsW(t.x); let wy = bsW(t.y); let dx = bsD(t.x); let dy = bsD(t.y);
      var f = 0.0; var fx = 0.0; var fy = 0.0; var d1 = 0.0; var ds = 0.0;
      for (var j = 0; j < 4; j++) {
        for (var i = 0; i < 4; i++) {
          let v = lmLoad(i0 + vec2i(i, j));
          let sv = select(-v.r, v.r, (u32(v.b + 0.5) & 7u) == o.lab);
          let w = wx[i] * wy[j];
          f += sv * w; fx += sv * dx[i] * wy[j]; fy += sv * wx[i] * dy[j];
          d1 += v.g * w; ds += v.a * w;
        }
      }
      o.f = f; o.d1 = d1; o.ds = ds;
      o.g = abs(f) / max(length(vec2f(fx, fy)) / W.bmap.z, 0.25);
    }
  }
  LIP = p; LIC = o;
  return o;
}
// Weights from a label: the territory's biome, the neighbour's across the boundary over +-tau/2 m
// (f changes about 2 m per metre across it), the car's beyond the map's reach.
fn labelBW(li: LI, tau: f32) -> BW {
  if (li.lab > 6u) { return bwCar(); }
  var o = bwOne(li.lab);
  if (li.oth < 7u && li.f < tau) { o = bwMix(bwOne(li.oth), o, smoothstep(-tau, tau, li.f)); }
  return bwMix(o, bwCar(), smoothstep(LM_RB - 350.0, LM_RB - 60.0, li.d1));
}

// Passages (tunData): the nearest one around p. a = metres along the road from the passage centre
// (+ toward its own region), l = metres to the right of it, w = 1 near it fading out by ~300 m,
// k = slot open, lh = half length, y0 = road height, lp / lo = parent / own region, st = style.
struct TZ { a: f32, l: f32, w: f32, k: f32, lh: f32, y0: f32, lp: u32, lo: u32, st: f32, cl: f32 };
var<private> TZP: vec2f = vec2f(3.4e38, 0.0);
var<private> TZC: TZ;
fn tunAt(p: vec2f) -> TZ {
  if (p.x == TZP.x && p.y == TZP.y) { return TZC; }
  var o: TZ; o.w = 0.0; o.a = 1e5; o.l = 1e5; o.k = 0.0; o.lh = 0.0; o.y0 = 0.0; o.lp = 7u; o.lo = 7u; o.st = 0.0; o.cl = 0.0;
  var best = 1e12;
  for (var i = 0; i < ${MAX_TUN}; i++) {
    let A = W.tun[i * 3]; let B = W.tun[i * 3 + 1]; let C = W.tun[i * 3 + 2];
    if (C.w < 0.0 || C.z <= 0.0) { continue; }
    let d = p - A.xy;
    let r2 = dot(d, d);
    let R = B.y + 300.0;
    if (r2 > R * R) { continue; }
    // the passage whose frame holds p best (two passages can stand near one fork)
    let a = dot(d, A.zw); let l = dot(d, vec2f(-A.w, A.z));
    let ea = max(abs(a) - B.y, 0.0);
    let sc = ea * ea + l * l;
    if (sc > best) { continue; }
    best = sc;
    o.a = a; o.l = l;
    o.w = (1.0 - smoothstep(B.y + 130.0, B.y + 290.0, sqrt(r2))) * C.z;
    o.k = C.x; o.lh = B.y; o.y0 = B.x; o.lp = u32(B.z + 0.5); o.lo = u32(B.w + 0.5); o.st = C.y % 8.0; o.cl = floor(C.y / 8.0);
  }
  TZP = p; TZC = o;
  return o;
}

// Ridge height (m above the natural ground) at p: the crest profile at distance g from a
// boundary, and around a passage the saddle and plateau (exact in the passage's own frame).
fn ridgeProf(p: vec2f, g: f32) -> f32 {
  if (g >= ${RIDGE.wf}.0) { return 0.0; }
  let k = 1.0 - smoothstep(${RIDGE.wt}.0, ${RIDGE.wf}.0, g);
  let vr = 0.82 + 0.4 * vnoise(p * (1.0 / 420.0) + vec2f(13.0, 5.0));
  let det = vnoise(p * (1.0 / 37.0) + vec2f(2.0, 9.0)) + 0.5 * vnoise(p * (1.0 / 13.0) + vec2f(7.0, 1.0)) - 0.75;
  return ${RIDGE.hc}.0 * vr * k + 14.0 * det * k * (1.0 - k);
}
// The ground with the ridge at p, over the natural ground nat (m): the crest profile at distance
// g from a boundary; around a passage (in its own frame, exact) the saddle beside the road and a
// plateau at least hs m above the road over the passage, cliff faces at the portals.
fn ridgeMap(p: vec2f) -> f32 {
  let li = labelAt(p);
  if (li.g >= ${RIDGE.wf}.0) { return 0.0; }
  let rd = nearField(p).x; // exact near a road (the map's distance is smoothed over 32 m)
  // (and it falls away before any road: where two regions' roads run close the ridge between
  // them is a narrow steep wall, never on a road)
  // (none in a strait's water: the sea parts the two sides of a strait road)
  return ridgeProf(p, li.g) * smoothstep(150.0, 300.0, li.ds) * (1.0 - smoothstep(0.0, 0.3, straitAt(p))) * (1.0 - smoothstep(LM_RB - 400.0, LM_RB - 120.0, li.d1)) * smoothstep(10.0, 34.0, rd);
}
var<private> RGP: vec3f = vec3f(3.4e38, 0.0, 0.0);
var<private> RGC: f32;
fn ridgeOn(p: vec2f, nat: f32) -> f32 {
  if (p.x == RGP.x && p.y == RGP.y && nat == RGP.z) { return RGC; }
  var h = nat + ridgeMap(p);
  let tz = tunAt(p);
  if (tz.w > 0.0) {
    let aa = abs(tz.a); let la = abs(tz.l);
    let gen = ridgeProf(p, aa) * smoothstep(10.0, 34.0, nearField(p).x);
    // (the plateau keeps clear of the nearest other road: cl m from the passage)
    let rdz = nearField(p).x;
    let pk = (1.0 - smoothstep(tz.lh + 3.0, tz.lh + 19.0, aa)) * (1.0 - smoothstep(min(40.0, tz.cl * 0.4), clamp(tz.cl - 14.0, 16.0, 90.0), la)) * select(1.0, smoothstep(10.0, 34.0, rdz), rdz < la - 6.0);
    let pl = nat + max(tz.y0 + ${RIDGE.hs}.0 + 2.5 * (vnoise(p * (1.0 / 9.0) + vec2f(3.0, 3.0)) - 0.5) - nat, 0.0) * pk;
    // the crest across the road dips to a saddle beside the passage, full height ~160 m out
    let hl = max(pl, nat + gen * mix(0.45, 1.0, smoothstep(26.0, 160.0, la)));
    h = mix(h, hl, tz.w * (1.0 - smoothstep(130.0, 210.0, la)));
  }
  RGP = vec3f(p, nat); RGC = h;
  return h;
}
// Material and shape weights at p (see labelAt); a passage's own frame decides near it.
fn biomeWT(p: vec2f, tau: f32) -> BW {
  var o = labelBW(labelAt(p), tau);
  let tz = tunAt(p);
  if (tz.w > 0.0 && tz.lp < 7u) {
    let near = tz.w * (1.0 - smoothstep(120.0, 220.0, abs(tz.l)));
    o = bwMix(o, bwMix(bwOne(tz.lp), bwOne(tz.lo), smoothstep(-tau * 0.5, tau * 0.5, tz.a)), near);
  }
  return o;
}
fn biomeW(p: vec2f) -> BW { return biomeWT(p, ${RIDGE.tauM}.0); }
// Wide weights: the terrain's shape (and gradients such as the snow line) change over the ridge.
fn biomeWRaw(p: vec2f) -> BW { return biomeWT(p, ${RIDGE.tauS}.0); }
// Ridge or passage here (0..1): grass, props and settlements keep off (siteClear, settle.js).
fn ridgeClear(p: vec2f) -> f32 {
  var c = smoothstep(2.0, 6.0, ridgeMap(p));
  let tz = tunAt(p);
  if (tz.w > 0.0) { c = max(c, (1.0 - smoothstep(tz.lh + 30.0, tz.lh + 45.0, abs(tz.a))) * (1.0 - smoothstep(150.0, 175.0, abs(tz.l))) * tz.w); }
  return c;
}
// Inside a covered passage (0..1) at world point wp: x = how deep inside (0 at the portals, 1
// from ~28 m in), y = lamp pool light along it (style-dependent), z = style.
fn tunnelIn(wp: vec3f) -> vec3f {
  let tz = tunAt(wp.xz);
  if (tz.w <= 0.0 || tz.k <= 0.0) { return vec3f(0.0); }
  let aa = abs(tz.a); let la = abs(tz.l);
  let inside = (1.0 - smoothstep(tz.lh - 1.0, tz.lh + 1.0, aa)) * (1.0 - smoothstep(${SLOT_HW + 1}, ${SLOT_HW + 2.5}, la)) * (1.0 - smoothstep(9.0, 11.0, wp.y - tz.y0)) * tz.k;
  if (inside <= 0.0) { return vec3f(0.0); }
  let deep = smoothstep(0.0, 28.0, tz.lh - aa) * inside;
  // lamps every 14-24 m along both walls (none in the natural caves: eras 0-1 have two torches)
  var pool = 0.0;
  if (tz.st >= 1.5) {
    let sp = select(select(14.0, 18.0, tz.st < 5.5), 24.0, tz.st < 3.5);
    let q = (fract((tz.a + tz.lh) / sp) - 0.5) * sp;
    pool = exp(-q * q * 0.035) * (0.55 + 0.45 * smoothstep(1.0, ${SLOT_HW}, la));
  }
  return vec3f(deep, pool * inside, tz.st);
}
// Biome table row blend at given weights.
fn bioAt(k: u32, w: BW) -> vec4f {
  return W.bp[k] * w.a.x + W.bp[BK + k] * w.a.y + W.bp[2u * BK + k] * w.a.z + W.bp[3u * BK + k] * w.b.x
    + W.bp[4u * BK + k] * w.b.y + W.bp[5u * BK + k] * w.b.z + W.bp[6u * BK + k] * w.b.w;
}
// Index of the biome a uniform random number u picks from (material) weights w.
fn bwPick(w: BW, u: f32) -> u32 {
  var c = w.a.x; if (u < c) { return 0u; }
  c += w.a.y; if (u < c) { return 1u; }
  c += w.a.z; if (u < c) { return 2u; }
  c += w.b.x; if (u < c) { return 3u; }
  c += w.b.y; if (u < c) { return 4u; }
  c += w.b.z; if (u < c) { return 5u; }
  return 6u;
}

fn surfAt(jd: f32) -> f32 { return mix(W.surf.x, W.surf.y, smoothstep(W.surf.z, W.surf.w, jd)); }
// Half width by surface: trail 1.35, dirt 2.6, paving and cobbles 3.4, asphalt 3.65, highway 3.9.
fn halfWidth(s: f32) -> f32 { return select(select(3.4 + 0.25 * clamp(s - 3.0, 0.0, 2.0), mix(2.6, 3.4, s - 1.0), s < 2.0), mix(1.35, 2.6, s), s < 1.0); }
// Cross-section of the road relative to its centreline height (trail hollow, dirt crown
// with wheel ruts and a ditch, stone crown).
fn roadProfile(d: f32, hw: f32, s: f32) -> f32 {
  let x = min(d / hw, 1.0);
  let q = 1.0 - x * x;
  let tT = 1.0 - saturate(s);
  let tS = saturate(s - 1.0);
  let tD = 1.0 - tT - tS;
  let rr = (d - 0.8) / 0.24;
  let rut = -0.05 * exp(-rr * rr);
  var h = -0.06 * q * tT + (0.035 * q + rut) * tD + 0.07 * q * tS;
  h -= 0.10 * smoothstep(hw - 0.2, hw + 0.5, d) * smoothstep(hw + 2.4, hw + 1.0, d) * (tD + tS);
  return h;
}

// Road-over-river cut (0..1) from the channel weight; matches the bridge span in props.js.
fn bridgeCut(chan: f32) -> f32 { return smoothstep(0.3, 0.75, chan); }
struct Ground { h: f32, d: f32, ry: f32, jd: f32, reg: f32, hw: f32, surf: f32, far: f32,
  w: vec3f, low: f32, flood: f32, chan: f32, lake: f32, rd: f32, relief: f32, v: vec4f, sea: f32 };

// Terrain without road conformance (biome-shaped ground + masked relief + ridges).
fn naturalH(p: vec2f, far: f32) -> f32 { let b = biomeWRaw(p); return ridgeOn(p, natural(p, far, far, b.a, b.b).h); }

fn ground(p: vec2f) -> Ground {
  var g: Ground;
  g.far = farField(p);
  let f = nearField(p);
  let bw = biomeW(p);
  let bs = biomeWRaw(p);
  g.w = bw.a; g.v = bw.b;
  let nt = natural(p, g.far, mix(f.x, g.far, smoothstep(30.0, 46.0, f.x)), bs.a, bs.b);
  g.low = nt.low; g.flood = nt.flood; g.chan = nt.chan; g.lake = nt.lake; g.rd = nt.rd; g.relief = nt.relief; g.sea = nt.sea;
  // The ridge between territories stands on the land (out of the sea, over rivers and lakes).
  var h0 = ridgeOn(p, nt.h);
  let rg = h0 - nt.h;
  if (rg > 0.0) {
    g.relief += rg;
    let dry = 1.0 - smoothstep(0.5, 3.0, rg);
    g.sea *= dry; g.lake *= dry; g.chan *= dry; g.flood *= dry;
  }
  let pf = padAt(p);
  h0 = mix(h0, pf.y, pf.x);
  let sm = straitAt(p);
  if (sm > 0.0) {
    h0 = mix(h0, W.strait2.y - 0.6, smoothstep(0.0, 0.6, sm));
    g.lake = max(g.lake, sm);
  }
  g.d = f.x; g.ry = f.y; g.reg = f.z; g.jd = f.w;
  g.surf = surfAt(f.w);
  g.hw = halfWidth(g.surf);
  g.h = h0;
  if (f.x < FIELD_W - 1.0) {
    let bank = clamp(3.0 + 1.5 * abs(h0 - f.y), 3.0, 38.0);
    var t = smoothstep(g.hw + 0.8, g.hw + 0.8 + bank, f.x);
    // A passage: the plateau stays whole over the road (closed while the camera is far), or is
    // cut to the road between near-vertical walls (the slot the vault stands in).
    let tz = tunAt(p);
    if (tz.w > 0.0) {
      let zk = (1.0 - smoothstep(tz.lh + 16.0, tz.lh + 30.0, abs(tz.a))) * tz.w;
      t = mix(t, mix(1.0, smoothstep(${SLOT_HW}, ${SLOT_HW + SLOT_WALL}, f.x), tz.k), zk);
    }
    // Where a road crosses the river the channel runs on under the bridge (props.js builds
    // the bridge; the CPU mirror keeps the road height there, which is the bridge deck).
    t = max(t, bridgeCut(nt.chan));
    // In an open strait the road dips under the water (a closed causeway's stub).
    let ry = mix(f.y, min(f.y, W.strait2.y - 0.5), smoothstep(0.1, 0.9, sm) * W.strait2.z);
    g.h = mix(ry + roadProfile(f.x, g.hw, g.surf), h0, t);
  }
  return g;
}
fn groundH(p: vec2f) -> f32 { return ground(p).h; }

// Material weights at p: the biome shapes blend smoothly, but materials (and the grass and
// props growing on them) meet in a patchy, noise-broken border a few hundred metres wide
// instead of a cross-fade. wIn: biomeW weights; lod: noise mip level (0 in compute).
fn matW(p: vec2f, wIn: BW) -> BW { return matWL(p, wIn, 0.0); }
fn matWL(p: vec2f, wIn: BW, lod: f32) -> BW {
  let wn = bwScale(wIn, 1.0 / max(bwSum(wIn), 1e-4));
  let mx = max(max(wn.a.x, max(wn.a.y, wn.a.z)), max(max(wn.b.x, wn.b.y), max(wn.b.z, wn.b.w)));
  if (mx > 0.985) {
    return BW(select(vec3f(0.0), vec3f(1.0), wn.a > vec3f(0.5)), select(vec4f(0.0), vec4f(1.0), wn.b > vec4f(0.5)));
  }
  let bn = tnl(p * (1.0 / 47.0), 0.0);
  let bn2 = tnl(p * 0.21 + vec2f(5.0, 1.0), lod);
  let bn3 = tnl(vec2f(p.y, -p.x) * (1.0 / 53.0) + vec2f(11.0, 3.0), 0.0);
  let bn4 = tnl(vec2f(-p.y, p.x) * 0.19 + vec2f(2.0, 9.0), lod);
  var a = clamp((wn.a - 0.5) * 2.4 + 0.5 + 1.0 * (bn.xyz - 0.5) + 0.35 * (bn2.xyz - 0.5), vec3f(0.0), vec3f(1.0));
  var b = clamp((wn.b - 0.5) * 2.4 + 0.5 + 1.0 * (vec4f(bn.w, bn3.xyz) - 0.5) + 0.35 * (vec4f(bn2.w, bn4.xyz) - 0.5), vec4f(0.0), vec4f(1.0));
  // No snow patches where ice is only a kernel tail (a distant ice road) in another biome.
  a.y *= smoothstep(0.2, 0.38, wn.a.y);
  // Patches, not a cross-fade: each point is (almost always) one material, so a pixel in the
  // border zone shades one biome, not several.
  a = a * a * a * a; b = b * b * b * b;
  var o = BW(a, b);
  let s = bwSum(o);
  if (s < 1e-6) { return BW(select(vec3f(0.0), vec3f(1.0), wn.a >= vec3f(mx)), select(vec4f(0.0), vec4f(1.0), wn.b >= vec4f(mx))); }
  o = bwScale(o, 1.0 / s);
  o.a = select(o.a, vec3f(0.0), o.a < vec3f(0.02)); o.b = select(o.b, vec4f(0.0), o.b < vec4f(0.02));
  return bwScale(o, 1.0 / max(bwSum(o), 1e-6));
}
// Irrigated plots along the river: bands parallel to it (~12 m across) whose borders waver,
// plots of varying length along it, staggered per band. rt: river tangent (|rt| ~1 on one
// bank, ~2 on the other; terrain.js passes it from the vertex stage). Returns x: kind (0 none,
// 1 young barley, 2 green, 3 ripening, 4 fallow), y: across-river coordinate (crop rows),
// z: distance to the plot border (m), w: plot hash.
fn fieldAtT(p: vec2f, rd: f32, rt: vec2f) -> vec4f {
  let none = vec4f(0.0, 0.0, 99.0, 0.0);
  let fb = smoothstep(24.0, 28.0, rd) * (1.0 - smoothstep(130.0, 150.0, rd + 50.0 * (tnl(p * 0.008, 0.0).x - 0.5)));
  if (fb < 0.5) { return none; }
  let side = select(0, 1, dot(rt, rt) > 2.25);
  let t = normalize(rt);
  let along = dot(p, t);
  let wn = tnl(vec2f(along * 0.021, rd * 0.034) + vec2f(f32(side) * 9.0, 0.0), 0.0);
  let rw = rd + 3.2 * (wn.x - 0.5);
  let band = floor(rw / 12.0);
  let hb = hash2(i32(band) + side * 977, 31);
  let plen = 22.0 + 42.0 * hb;
  let ua = (along + 7.0 * (wn.y - 0.5)) / plen + hb * 7.3;
  let cell = floor(ua);
  let hc = hash2(i32(band) * 131 + side * 977, i32(cell));
  let ea = min(fract(ua), 1.0 - fract(ua)) * plen;
  let fr = fract(rw / 12.0);
  let ec = min(fr, 1.0 - fr) * 12.0;
  var kind = 2.0;
  if (hc < 0.03) { kind = 0.0; } else if (hc < 0.11) { kind = 4.0; } else if (hc < 0.33) { kind = 3.0; } else if (hc < 0.58) { kind = 1.0; }
  return vec4f(kind, rw, min(ea, ec), hc);
}
fn fieldAt(p: vec2f, rd: f32) -> vec4f {
  let n0 = riverN(p);
  let g = vec2f(riverN(p + vec2f(8.0, 0.0)) - n0, riverN(p + vec2f(0.0, 8.0)) - n0);
  let t = normalize(vec2f(-g.y, g.x) + vec2f(1e-7, 0.0)) * select(-1.0, 2.0, n0 > 0.0);
  return fieldAtT(p, rd, t);
}
// Ice-age snow cover field (> 0 snow, < 0 bare tundra). Thin and patchy at the biome margin
// (steppe-tundra with snow lying in the hollows and on higher ground first), continuous
// inside; the wind scours moraine crests. wy: raw ice weight, hrel: height above the base
// ground (m). Shared by the terrain (which adds small-scale edge breakup) and the grass.
fn iceSnowV(p: vec2f, wy: f32, hrel: f32) -> f32 {
  let ridge = iceRidge(p);
  let a = tnl(p * (1.0 / 140.0) + vec2f(6.0, 2.0), 0.0);
  let wq = p + 30.0 * a.yz;
  let b = tnl(wq * (1.0 / 30.0), 0.0);
  let c = tnl(vec2f(wq.x * 0.8 - wq.y * 0.6, wq.x * 0.6 + wq.y * 0.8) * (1.0 / 15.0) + vec2f(3.0, 3.0), 0.0);
  let pat = b.x * 0.67 + c.y * 0.33;
  let margin = smoothstep(0.3, 0.9, wy);
  return 1.4 * margin - 0.86 + 1.3 * (pat - 0.5) - 0.5 * ridge * ridge * margin + 0.3 * (0.5 - a.x) + 0.05 * clamp(hrel, -4.0, 12.0) * (1.0 - margin);
}
// Grass cover 0..1 (bare patches, road and its worn shoulders, which are ragged and thin out
// gradually). Shared by terrain + grass. lod: noise mip level (0 in compute).
fn grassCoverL(p: vec2f, d: f32, hw: f32, lod: f32) -> f32 {
  // Rotated lookups so the bare patches do not line up with the noise lattice.
  let q1 = vec2f(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y);
  let q2 = vec2f(0.28 * p.x + 0.96 * p.y, -0.96 * p.x + 0.28 * p.y);
  let a = tnl(q1 * (1.0 / 41.0), 0.0);
  let b = tnl(q2 * (1.0 / 13.0), max(lod - 1.66, 0.0));
  let c = tnl(p * (1.0 / 4.3), lod);
  let n = a.x * 0.55 + b.y * 0.3 + c.z * 0.15;
  let patchy = smoothstep(0.17, 0.4, n);
  return patchy * smoothstep(hw + 0.1, hw + 2.0, d + 1.1 * (c.w - 0.5) + 0.6 * (b.w - 0.5));
}
fn grassCover(p: vec2f, d: f32, hw: f32) -> f32 { return grassCoverL(p, d, hw, 0.0); }
`;

// ---------------------------------------------------------------------------------
// JS mirror of ground(). Allocation-free: inputs and outputs go through Float64Arrays.

const nr = new Float64Array(8);
const nrFar = new Float64Array(8);
function ss(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
// Convenience (boxes a double; not for per-frame use).
export function halfWidth(s) { return s < 1 ? 1.35 + (2.6 - 1.35) * s : s < 2 ? 2.6 + (3.4 - 2.6) * (s - 1) : 3.4 + 0.25 * Math.min(2, Math.max(0, s - 3)); }

// Ground at (out[6], out[7]) = (x, z). Writes out[0] = height, out[1] = road distance,
// out[2] = road y, out[3] = journey m, out[4] = surface 0..2, out[5] = road half width.
export const groundOut = new Float64Array(8);
// groundExtra: [0..2] biome weights 0-2, [3] base low, [4] flood, [5] channel, [6] lake, [7] river distance.
export const groundExtra = new Float64Array(8);
// groundBio: [0..6] biome weights (all seven) of the last groundInfo() point.
export const groundBio = new Float64Array(8);
// groundSea (last groundInfo() point): [0] sea water weight 0..1 (the car's water check), [1] sea level y, [2] water depth above the ground (m).
export const groundSea = new Float64Array(4);
// groundTun (last groundInfo() point): [0] the ground without the road cut (a passage's rock).
export const groundTun = new Float64Array(2);
export function groundInfo(out) {
  const x = out[6], z = out[7];
  nr[5] = x; nr[6] = z;
  nearestRoad(nr, FIELD_W);
  let far = nr[0];
  if (far > 200) { nrFar[5] = x; nrFar[6] = z; nearestRoad(nrFar, FAR_W); far = nrFar[0]; }
  far = Math.min(far, FAR_W);
  const d = Math.min(nr[0], FIELD_W);
  // Shape weights (wide) for natural(), material weights for groundBio (biomeWRaw / biomeW).
  BQ[0] = x; BQ[1] = z;
  biomeWTJS(BQ, RIDGE.tauS);
  SIO[0] = x; SIO[1] = z; SIO[2] = far; SIO[3] = d + (far - d) * ss((d - 30) / 16);
  SIO[4] = BQ[2]; SIO[5] = BQ[3]; SIO[6] = BQ[4];
  SIO[17] = BQ[5]; SIO[18] = BQ[6]; SIO[19] = BQ[7]; SIO[20] = BQ[8];
  SIO[21] = seaData[0]; SIO[16] = 0;
  if (BQ[8] > 0.004) seaSideJS(x, z, far);
  noiseNatural();
  biomeWTJS(BQ, RIDGE.tauM);
  // The ridge (ground() in the WGSL).
  ridgeJS(x, z, SIO[8], d);
  let h0 = RGO[0];
  const rg = h0 - SIO[8];
  if (rg > 0) {
    SIO[14] += rg;
    const dry = 1 - ss((rg - 0.5) / 2.5);
    SIO[22] *= dry; SIO[12] *= dry; SIO[11] *= dry; SIO[10] *= dry;
  }
  // Landmark pads and the land-bridge strait (padAt / straitAt in the WGSL).
  let pw = 0, py = 0;
  for (let i = 0; i < 16; i += 4) {
    const R = siteData[i + 2];
    if (R <= 0) continue;
    const dx = x - siteData[i], dz = z - siteData[i + 1];
    let t = (Math.sqrt(dx * dx + dz * dz) - R) / (20 + 0.3 * R);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const wf = 1 - t * t * (3 - 2 * t);
    if (wf > pw) { pw = wf; py = siteData[i + 3]; }
  }
  if (pw > 0) h0 += (py - h0) * pw;
  straitJS(x, z);
  tunAtJS(x, z);
  const sm = STR[0];
  if (sm > 0) {
    let t = sm / 0.6; t = t > 1 ? 1 : t;
    h0 += (siteData[21] - 0.6 - h0) * t * t * (3 - 2 * t);
    if (sm > SIO[12]) SIO[12] = sm;
  }
  groundExtra[0] = BQ[2]; groundExtra[1] = BQ[3]; groundExtra[2] = BQ[4];
  for (let i = 0; i < 7; i++) groundBio[i] = BQ[2 + i];
  groundSea[1] = seaData[0];
  groundSea[2] = SIO[22] > 0.02 ? Math.max(seaData[0] - h0, 0) : 0;
  groundSea[0] = SIO[22] > 0.02 ? ss((seaData[0] - h0 - 0.02) / 0.2) * ss((SIO[22] - 0.2) / 0.3) : 0;
  groundExtra[3] = SIO[9]; groundExtra[4] = SIO[10]; groundExtra[5] = SIO[11]; groundExtra[6] = SIO[12]; groundExtra[7] = SIO[13];
  groundTun[0] = h0; // the uncut ground (tunnel.js: the rock over a passage)
  const c = surfaceCurve;
  const s = c.a + (c.b - c.a) * ss((nr[2] - c.d0) / (c.d1 - c.d0));
  const hw = s < 1 ? 1.35 + 1.25 * s : s < 2 ? 2.6 + 0.8 * (s - 1) : 3.4 + 0.25 * Math.min(2, Math.max(0, s - 3));
  let h = h0;
  if (d < FIELD_W - 1) {
    const bank = Math.min(38, Math.max(3, 3 + 1.5 * Math.abs(h0 - nr[1])));
    let t = ss((d - hw - 0.8) / bank);
    // A passage (ground() in the WGSL; tunAtJS ran inside ridgeJS for this point).
    if (TZO[2] > 0) {
      const zk = (1 - ss((Math.abs(TZO[0]) - TZO[4] - 16) / 14)) * TZO[2];
      const ts = ss((d - SLOT_HW) / SLOT_WALL);
      t += (1 + (ts - 1) * TZO[3] - t) * zk;
    }
    // roadProfile (keep in sync with the WGSL)
    const xr = Math.min(d / hw, 1), q = 1 - xr * xr;
    const tT = 1 - Math.min(1, Math.max(0, s)), tS = Math.min(1, Math.max(0, s - 1)), tD = 1 - tT - tS;
    const rr = (d - 0.8) / 0.24;
    let prof = -0.06 * q * tT + (0.035 * q - 0.05 * Math.exp(-rr * rr)) * tD + 0.07 * q * tS;
    prof -= 0.10 * ss((d - hw + 0.2) / 0.7) * ss((hw + 2.4 - d) / 1.4) * (tD + tS);
    // Mirrors the WGSL: in an open strait the road dips under the water.
    const ry = nr[1] + (Math.min(nr[1], siteData[21] - 0.5) - nr[1]) * ss((sm - 0.1) / 0.8) * siteData[22];
    const r = ry + prof;
    h = r + (h0 - r) * t;
  }
  out[0] = h; out[1] = nr[0]; out[2] = nr[1]; out[3] = nr[2]; out[4] = s; out[5] = hw;
  return out;
}
// seaSide() of the WGSL -> SIO[16]: 1 when the direction away from the nearest road points to the
// sea side (seaData[1..2]); far from every road, the side of the car (graphFocus) instead.
const SQ = new Float64Array(8);
function seaSideJS(x, z, far) {
  let s = 0;
  const useFar = nr[0] > 200;
  const e = useFar ? nrFar[3] : nr[3], sAt = useFar ? nrFar[4] : nr[4];
  if (e >= 0) {
    SQ[4] = sAt; pointAt(e, SQ);
    const dx = x - SQ[0], dz = z - SQ[2], l = Math.sqrt(dx * dx + dz * dz);
    if (l > 1e-3) s = ss(((dx * seaData[1] + dz * seaData[2]) / l + 0.25) / 0.5);
  }
  const sc = ss(((x - graphFocus[0]) * seaData[1] + (z - graphFocus[1]) * seaData[2] + 150) / 300);
  SQ[5] = x + seaData[1] * 160; SQ[6] = z + seaData[2] * 160; nearestRoad(SQ, FAR_W);
  const open = ss((Math.min(SQ[0], FAR_W) - 70) / 80);
  SIO[16] = (s + (sc - s) * ss((far - 700) / 180)) * open;
}
const STR = new Float64Array(1);
function straitJS(x, z) { // -> STR[0] (no double return: V8 would box it)
  STR[0] = 0;
  const hw = siteData[20];
  if (hw <= 0) return;
  const dx = x - siteData[16], dz = z - siteData[17];
  const u = dx * siteData[18] + dz * siteData[19];
  const v = (dx * -siteData[19] + dz * siteData[18]) * siteData[23];
  if (Math.abs(u) > hw + 3000 || v < -400) return;
  NIO[0] = x / 90 + 4; NIO[1] = z / 90 + 7; noiseValue(); let wob = 18 * (NIO[2] - 0.5);
  NIO[0] = x / 23; NIO[1] = z / 23; noiseValue(); wob += 6 * (NIO[2] - 0.5);
  const hv = hw + Math.max(v, 0) * 0.22 + wob;
  let a = (Math.abs(u) - hv + 22) / 22; a = a < 0 ? 0 : a > 1 ? 1 : a;
  let b = (v + wob + 150) / 80; b = b < 0 ? 0 : b > 1 ? 1 : b;
  STR[0] = (1 - a * a * (3 - 2 * a)) * b * b * (3 - 2 * b);
}
// Strait water weight at (x, z) (boxes a double: not for per-frame use).
export function straitAt(x, z) { straitJS(x, z); return STR[0]; }
// Convenience (boxes doubles; load time only).
export function groundAt(x, z) { groundOut[6] = x; groundOut[7] = z; return groundInfo(groundOut)[0]; }

// ---------------------------------------------------------------------------------
// Biome territories, ridges and passages on the CPU (mirrors labelAt / ridgeAt / tunAt /
// biomeWT of the WGSL; seven biomes: savannah, ice, desert, forest, steppe, mountains, coast).
//   biomeAt(q):      q[0], q[1] = x, z  ->  q[2..8] material weights as the GPU has them.
//   biomeExact(q):   the car's weights (carBiome, biomes.js; q[2..4] the first three): the
//                    territory it is in, crossfaded through a passage from end to end.
//   biomeExactAt(q): biomeAt without the car's crossfade (signposts).
//   biomeFull(q):    plan-time weights (sites.js): the territory of (x, z) with every live road
//                    at full presence, from the roads themselves (no map).
//   labelAtJS / ridgeJS / tunAtJS: LIO, RGO, TZO below.
export const BQ = new Float64Array(10);
const f16 = typeof Math.f16round === 'function' ? Math.f16round : (v) => {
  if (!isFinite(v) || v === 0) return v;
  const a = Math.abs(v); let e = Math.floor(Math.log2(a)); if (e < -14) e = -14;
  const u = Math.pow(2, e - 10); return Math.sign(v) * Math.round(a / u) * u;
};
// Label texel cache (direct-mapped by texel, per map version): f, d1, code, ds.
const LTC = 1024;
const ltKey = new Float64Array(LTC * 3).fill(NaN);
const ltVal = new Float64Array(LTC * 4);
const LTX = new Float64Array(4); // texel out
const LD = new Float64Array(8); // per-region distance, strait distance
// Distance from (px, pz) to segment (ax, az)-(bx, bz) -> SEGD[0].
const SEGD = new Float64Array(1);
function segDist(px, pz, ax, az, bx, bz) {
  const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz;
  let t = l2 > 1e-12 ? ((px - ax) * sx + (pz - az) * sz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - ax - sx * t, ez = pz - az - sz * t;
  SEGD[0] = Math.sqrt(ex * ex + ez * ez);
}
// The label map's per-region distances at (px, pz) from edge table T (8 per edge: presence,
// region, parent, samples, split, seam) -> LD[0..6], LD[7] strait split distance (exactly as
// road.js's label pass: chords of `stride` samples, capsules of radius rb, presence penalty).
function regionDists(px, pz, T, full) {
  const RB = LMAP.rb, ST = LMAP.stride, BIG = LMAP.big;
  for (let i = 0; i < 8; i++) LD[i] = BIG;
  for (let e = 0; e < MAX_EDGES; e++) {
    let bio = T ? T[e * 8] : (edgeAlive[e] ? (full ? 1 : edgeBio[e]) : 0);
    if (bio <= 0) continue;
    const own = T ? T[e * 8 + 1] : edgeRegion[e], par = T ? T[e * 8 + 2] : edgeParentRegion[e];
    const n = T ? T[e * 8 + 3] : edgeN[e], split = T ? T[e * 8 + 4] : edgeSplit[e], seam = T ? T[e * 8 + 5] : edgeSeam[e];
    const pen = (1 - bio) * RB;
    const base = e * MAX_PTS;
    for (let k0 = 0; k0 + 1 < n; k0 += ST) {
      const k1 = k0 + ST < n - 1 ? k0 + ST : n - 1;
      const oa = (base + k0) * 4, ob = (base + k1) * 4;
      const ax = pts[oa], az = pts[oa + 2], bx = pts[ob], bz = pts[ob + 2];
      // quick reject: the whole chord is further than rb
      const mx = px - (ax + bx) * 0.5, mz = pz - (az + bz) * 0.5;
      const hl = ST + 1; // half chord length is at most stride metres (2 m samples)
      if (mx * mx + mz * mz > (RB + hl) * (RB + hl)) continue;
      const s0 = k0 * 2, s1 = k1 * 2;
      if (split > s0 && split < s1) {
        const t = (split - s0) / (s1 - s0), xx = ax + (bx - ax) * t, xz = az + (bz - az) * t;
        segDist(px, pz, ax, az, xx, xz); let d = SEGD[0] + pen; if (d < RB && d < LD[par]) LD[par] = d;
        segDist(px, pz, xx, xz, bx, bz); d = SEGD[0] + pen; if (d < RB && d < LD[own]) LD[own] = d;
      } else {
        const lab = split >= 0 && s1 <= split ? par : own;
        segDist(px, pz, ax, az, bx, bz); const d = SEGD[0] + pen;
        if (d < RB && d < LD[lab]) LD[lab] = d;
      }
      if (seam === 2 && s1 > split - 205) { segDist(px, pz, ax, az, bx, bz); const ds = SEGD[0]; if (ds < RB && ds < LD[7]) LD[7] = ds; }
    }
  }
}
// Resolve (road.js's resolve pass): LD (rounded to half floats as the targets store them) ->
// LTX: f, d1, code (first + 8 * second region), ds.
function resolveTexel() {
  const BIG = LMAP.big;
  for (let i = 0; i < 8; i++) LD[i] = f16(LD[i]);
  let l1 = 0;
  for (let k = 1; k < 7; k++) if (LD[k] < LD[l1]) l1 = k;
  let l2 = l1 === 0 ? 1 : 0;
  for (let k = 0; k < 7; k++) if (k !== l1 && LD[k] < LD[l2]) l2 = k;
  const d1 = LD[l1];
  if (d1 >= LMAP.rb) { LTX[0] = BIG; LTX[1] = BIG; LTX[2] = 63; LTX[3] = LD[7]; return; }
  LTX[0] = f16(Math.min(LD[l2] - d1, BIG)); LTX[1] = d1; LTX[2] = l1 + 8 * l2; LTX[3] = LD[7];
}
function labelTexel(ix, iz) { // -> LTX, cached per map version
  const R = LMAP.res, ver = bioSnap[MAX_EDGES * 8 + 2];
  ix = ix < 0 ? 0 : ix > R - 1 ? R - 1 : ix; iz = iz < 0 ? 0 : iz > R - 1 ? R - 1 : iz;
  const i = ((ix & 31) | ((iz & 31) << 5));
  if (ltKey[i * 3] === ix && ltKey[i * 3 + 1] === iz && ltKey[i * 3 + 2] === ver) {
    LTX[0] = ltVal[i * 4]; LTX[1] = ltVal[i * 4 + 1]; LTX[2] = ltVal[i * 4 + 2]; LTX[3] = ltVal[i * 4 + 3];
    return;
  }
  const t = LMAP.size / R;
  regionDists(bioSnap[MAX_EDGES * 8] + (ix + 0.5 - R / 2) * t, bioSnap[MAX_EDGES * 8 + 1] + (iz + 0.5 - R / 2) * t, bioSnap, false);
  resolveTexel();
  ltKey[i * 3] = ix; ltKey[i * 3 + 1] = iz; ltKey[i * 3 + 2] = ver;
  ltVal[i * 4] = LTX[0]; ltVal[i * 4 + 1] = LTX[1]; ltVal[i * 4 + 2] = LTX[2]; ltVal[i * 4 + 3] = LTX[3];
}
// labelAt(): LIO[0] region (7 none), [1] neighbour, [2] f (signed), [3] g (m to the boundary),
// [4] d1, [5] ds. Same branches and filters as the WGSL.
export const LIO = new Float64Array(8);
const BSX = new Float64Array(4), BSY = new Float64Array(4), BDX = new Float64Array(4), BDY = new Float64Array(4);
function bsplineInto(W, Dv, t) {
  const s = 1 - t, t2 = t * t, t3 = t2 * t;
  W[0] = s * s * s / 6; W[1] = (3 * t3 - 6 * t2 + 4) / 6; W[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6; W[3] = t3 / 6;
  Dv[0] = -0.5 * s * s; Dv[1] = 1.5 * t2 - 2 * t; Dv[2] = -1.5 * t2 + t + 0.5; Dv[3] = 0.5 * t2;
}
export function labelAtJS(x, z) {
  const R = LMAP.res, BIG = LMAP.big, tex = LMAP.size / R;
  LIO[0] = 7; LIO[1] = 7; LIO[2] = BIG; LIO[3] = 1e5; LIO[4] = BIG; LIO[5] = BIG;
  const ux = (x - bioSnap[MAX_EDGES * 8]) / tex + R * 0.5 - 0.5, uz = (z - bioSnap[MAX_EDGES * 8 + 1]) / tex + R * 0.5 - 0.5;
  if (!(Math.min(ux, uz) > 2 && Math.max(ux, uz) < R - 3)) return;
  labelTexel(Math.floor(ux + 0.5), Math.floor(uz + 0.5));
  const lab = LTX[2] & 7;
  LIO[0] = lab; LIO[1] = LTX[2] >> 3;
  // bilinear (the GPU's filtered fetch)
  const fx = Math.floor(ux), fz = Math.floor(uz), tx = ux - fx, tz = uz - fz;
  let qf = 0, qd = 0, qs = 0;
  for (let c = 0; c < 4; c++) {
    const cx = c & 1, cz = c >> 1;
    labelTexel(fx + cx, fz + cz);
    const w = (cx ? tx : 1 - tx) * (cz ? tz : 1 - tz);
    qf += LTX[0] * w; qd += LTX[1] * w; qs += LTX[3] * w;
  }
  LIO[2] = qf; LIO[4] = qd; LIO[5] = qs;
  if (qf < LMAP.near && lab < 7) {
    bsplineInto(BSX, BDX, tx); bsplineInto(BSY, BDY, tz);
    let f = 0, gx = 0, gz = 0, d1 = 0, ds = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      labelTexel(fx - 1 + i, fz - 1 + j);
      const sv = (LTX[2] & 7) === lab ? LTX[0] : -LTX[0];
      const w = BSX[i] * BSY[j];
      f += sv * w; gx += sv * BDX[i] * BSY[j]; gz += sv * BSX[i] * BDY[j];
      d1 += LTX[1] * w; ds += LTX[3] * w;
    }
    LIO[2] = f; LIO[4] = d1; LIO[5] = ds;
    LIO[3] = Math.abs(f) / Math.max(Math.sqrt(gx * gx + gz * gz) / tex, 0.25);
  }
}
// tunAt(): TZO[0] a, [1] l, [2] w, [3] k (slot open), [4] half length, [5] road y, [6] parent,
// [7] own region, [8] style, [9] slot index (-1 none).
export const TZO = new Float64Array(12); // [10] clearance (m)
export function tunAtJS(x, z) {
  TZO[0] = 1e5; TZO[1] = 1e5; TZO[2] = 0; TZO[3] = 0; TZO[4] = 0; TZO[5] = 0; TZO[6] = 7; TZO[7] = 7; TZO[8] = 0; TZO[9] = -1;
  let best = 1e12;
  for (let i = 0; i < MAX_TUN; i++) {
    const o = i * 12;
    if (tunData[o + 11] < 0 || tunData[o + 10] <= 0) continue;
    const dx = x - tunData[o], dz = z - tunData[o + 1], r2 = dx * dx + dz * dz, R = tunData[o + 5] + 300;
    if (r2 > R * R) continue;
    const a = dx * tunData[o + 2] + dz * tunData[o + 3], l = -dx * tunData[o + 3] + dz * tunData[o + 2];
    let ea = (a < 0 ? -a : a) - tunData[o + 5]; ea = ea > 0 ? ea : 0;
    const sc = ea * ea + l * l;
    if (sc > best) continue;
    best = sc;
    TZO[0] = a; TZO[1] = l;
    TZO[2] = (1 - ss((Math.sqrt(r2) - tunData[o + 5] - 130) / 160)) * tunData[o + 10];
    TZO[3] = tunData[o + 8]; TZO[4] = tunData[o + 5]; TZO[5] = tunData[o + 4];
    TZO[6] = tunData[o + 6]; TZO[7] = tunData[o + 7]; TZO[8] = tunData[o + 9] % 8; TZO[9] = i; TZO[10] = Math.floor(tunData[o + 9] / 8);
  }
}
// ridgeProf / ridgeAt of the WGSL -> RGO[0] (m).
export const RGO = new Float64Array(2);
const RPO = new Float64Array(1);
function ridgeProfJS(x, z, g) {
  if (g >= RIDGE.wf) { RPO[0] = 0; return; }
  const k = 1 - ss((g - RIDGE.wt) / (RIDGE.wf - RIDGE.wt));
  NIO[0] = x / 420 + 13; NIO[1] = z / 420 + 5; noiseValue(); const vr = 0.82 + 0.4 * NIO[2];
  NIO[0] = x / 37 + 2; NIO[1] = z / 37 + 9; noiseValue(); let det = NIO[2];
  NIO[0] = x / 13 + 7; NIO[1] = z / 13 + 1; noiseValue(); det += 0.5 * NIO[2] - 0.75;
  RPO[0] = RIDGE.hc * vr * k + 14 * det * k * (1 - k);
}
// ridgeMap of the WGSL -> RGO[1]; ridgeOn (the ground with the ridge over natural ground nat)
// -> RGO[0]. Leaves TZO for (x, z).
export function ridgeJS(x, z, nat, rd) {
  labelAtJS(x, z);
  let m = 0;
  if (LIO[3] < RIDGE.wf) {
    ridgeProfJS(x, z, LIO[3]);
    straitJS(x, z);
    m = RPO[0] * ss((LIO[5] - 150) / 150) * (1 - ss(STR[0] / 0.3)) * (1 - ss((LIO[4] - LMAP.rb + 400) / 280)) * ss((rd - 10) / 24);
  }
  RGO[1] = m;
  let h = nat + m;
  tunAtJS(x, z);
  if (TZO[2] > 0) {
    const aa = Math.abs(TZO[0]), la = Math.abs(TZO[1]);
    ridgeProfJS(x, z, aa); const gen = RPO[0] * ss((rd - 10) / 24);
    NIO[0] = x / 9 + 3; NIO[1] = z / 9 + 3; noiseValue();
    const c0 = Math.min(40, TZO[10] * 0.4), c1 = Math.min(90, Math.max(16, TZO[10] - 14));
    const pk = (1 - ss((aa - TZO[4] - 3) / 16)) * (1 - ss((la - c0) / (c1 - c0))) * (rd < la - 6 ? ss((rd - 10) / 24) : 1);
    const lift = TZO[5] + RIDGE.hs + 2.5 * (NIO[2] - 0.5) - nat;
    const pl = nat + (lift > 0 ? lift : 0) * pk;
    const cr = nat + gen * (0.45 + 0.55 * ss((la - 26) / 134));
    const hl = cr > pl ? cr : pl;
    h += (hl - h) * TZO[2] * (1 - ss((la - 130) / 80));
  }
  RGO[0] = h;
}
// biomeWT of the WGSL -> q[2..8] (q[0], q[1] = x, z).
function bwOneInto(q, l, k) { for (let i = 0; i < 7; i++) q[2 + i] += (i === l ? 1 : 0) * k; }
export function biomeWTJS(q, tau) {
  const x = q[0], z = q[1];
  labelAtJS(x, z);
  const lab = LIO[0], oth = LIO[1];
  for (let i = 0; i < 7; i++) q[2 + i] = 0;
  if (lab > 6) { for (let i = 0; i < 7; i++) q[2 + i] = carBiome[i]; }
  else {
    let t = 1;
    if (oth < 7 && LIO[2] < tau) t = ss((LIO[2] + tau) / (2 * tau));
    bwOneInto(q, lab, t); if (t < 1) bwOneInto(q, oth, 1 - t);
    const k = ss((LIO[4] - LMAP.rb + 350) / 290);
    if (k > 0) for (let i = 0; i < 7; i++) q[2 + i] += (carBiome[i] - q[2 + i]) * k;
  }
  tunAtJS(x, z);
  if (TZO[2] > 0 && TZO[6] < 7) {
    const near = TZO[2] * (1 - ss((Math.abs(TZO[1]) - 120) / 100));
    if (near > 0) {
      const t = ss((TZO[0] + tau * 0.5) / tau);
      for (let i = 0; i < 7; i++) {
        const v = (i === TZO[6] ? 1 - t : 0) + (i === TZO[7] ? t : 0);
        q[2 + i] += (v - q[2 + i]) * near;
      }
    }
  }
  return q;
}
export function biomeAt(q) { return biomeWTJS(q, RIDGE.tauM); }
export function biomeExactAt(q) { return biomeWTJS(q, RIDGE.tauM); }
// Plan time (sites.js): the territory of (x, z) with every live road at full presence.
export function biomeFull(q) {
  regionDists(q[0], q[1], null, true);
  let l1 = 0;
  for (let k = 1; k < 7; k++) if (LD[k] < LD[l1]) l1 = k;
  let l2 = l1 === 0 ? 1 : 0;
  for (let k = 0; k < 7; k++) if (k !== l1 && LD[k] < LD[l2]) l2 = k;
  for (let i = 0; i < 7; i++) q[2 + i] = 0;
  if (LD[l1] >= LMAP.rb) { for (let i = 0; i < 7; i++) q[2 + i] = carBiome[i]; return q; }
  const f = LD[l2] - LD[l1], t = f < RIDGE.tauM ? ss((f + RIDGE.tauM) / (2 * RIDGE.tauM)) : 1;
  q[2 + l1] = t; q[2 + l2] += 1 - t;
  return q;
}
// Plan time (sites.js, settle): about how far (x, z) is from the nearest territory boundary,
// every live road at full presence (half the gap between the two nearest regions' distances: never
// more than the true distance), 1e9 when only one region is within reach.
function gapAt(x, z) { // second - first region distance, every live road at full presence
  regionDists(x, z, null, true);
  let l1 = 0;
  for (let k = 1; k < 7; k++) if (LD[k] < LD[l1]) l1 = k;
  let d2 = LMAP.big;
  for (let k = 0; k < 7; k++) if (k !== l1 && LD[k] < d2) d2 = LD[k];
  BD[1] = l1;
  return d2 - LD[l1];
}
const BD = new Float64Array(2);
export function boundaryDist(x, z) {
  const f = gapAt(x, z);
  if (f >= LMAP.big * 0.5) return 1e9;
  const l = BD[1];
  // signed differences keep the gradient right across the boundary
  const sg = (xx, zz) => { const v = gapAt(xx, zz); return BD[1] === l ? v : -v; };
  const gx = (sg(x + 6, z) - sg(x - 6, z)) / 12, gz = (sg(x, z + 6) - sg(x, z - 6)) / 12;
  return f / Math.max(Math.sqrt(gx * gx + gz * gz), 0.25);
}
// The car's weights: its territory; in a passage, parent -> own from one portal to the other
// (sky, light, weather and the music change while the car is inside).
const BX = new Float64Array(10);
export function biomeExact(q) {
  BX[0] = q[0]; BX[1] = q[1];
  biomeWTJS(BX, RIDGE.tauM);
  tunAtJS(q[0], q[1]);
  if (TZO[2] > 0 && TZO[6] < 7 && Math.abs(TZO[1]) < 40 && Math.abs(TZO[0]) < TZO[4] + 40) {
    const t = ss((TZO[0] + TZO[4] * 0.85) / (TZO[4] * 1.7));
    for (let i = 0; i < 7; i++) BX[2 + i] = (i === TZO[6] ? 1 - t : 0) + (i === TZO[7] ? t : 0);
  }
  for (let i = 0; i < 7; i++) carBiome[i] = BX[2 + i];
  q[2] = BX[2]; q[3] = BX[3]; q[4] = BX[4];
  return q;
}

// The coast's sea level: a few metres below the lowest live coast road (so no road is ever
// under water), eased so the water never jumps while in view. Called once per frame.
function updateSea(dt) {
  seaData[1] = 0; seaData[2] = (graph.seed & 1) ? 1 : -1;
  let lo = 1e9, coast = 0;
  const fx = graphFocus[0], fz = graphFocus[1];
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e] && edgeRegion[e] === 6 && edgeBio[e] > 0) coast = 1;
  // Below every live road near the car (not just the coast's own: the sea also reaches the
  // other roads of a fork into or out of the coast).
  for (let e = 0; e < MAX_EDGES && coast; e++) {
    if (!edgeAlive[e] || edgePresence[e] <= 0) continue;
    const base = e * MAX_PTS, n = edgeN[e];
    for (let k = 0; k < n; k += 4) {
      const o = (base + k) * 4, dx = pts[o] - fx, dz = pts[o + 2] - fz;
      if (dx * dx + dz * dz > 2.6e6) continue; // coast roads within ~1.6 km of the car
      if (pts[o + 1] < lo) lo = pts[o + 1];
    }
  }
  if (lo < 1e8) seaData[3] = lo - 2.2;
  if (seaData[0] < -9e3 || dt <= 0) seaData[0] = seaData[3];
  else { const d = seaData[3] - seaData[0], st = 3 * dt; seaData[0] += d > st ? st : d < -st ? -st : d; }
}
// Sea water at (q[0], q[1]) for the car: q[2] = water weight 0..1 (0 dry land), q[3] = depth (m).
// Allocation-free (computes a full groundInfo()).
const SW = new Float64Array(8);
export function seaWater(q) {
  SW[6] = q[0]; SW[7] = q[1];
  groundInfo(SW);
  q[2] = groundSea[0]; q[3] = groundSea[2];
  return q;
}

// ---------------------------------------------------------------------------------
// Lighting probe pass (a 16x17 render, every frame, before the scene).

const PROBE_WGSL = MAIN_HEADER + /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ij = vec2i(pos.xy);
  if (ij.y >= 16) {
    if (ij.x == 0) { return vec4f(sunIlluminance(), 1.0); }
    return vec4f(skyRadiance(vec3f(0.0, 1.0, 0.0)), 1.0);
  }
  let o = (vec2f(ij) + 0.5) * (2.0 / 16.0) - 1.0;
  var n = vec3f(o.x, 1.0 - abs(o.x) - abs(o.y), o.y);
  if (n.y < 0.0) { n = vec3f((1.0 - abs(o.y)) * select(-1.0, 1.0, o.x >= 0.0), n.y, (1.0 - abs(o.x)) * select(-1.0, 1.0, o.y >= 0.0)); }
  return vec4f(skyAmbient(normalize(n)), 1.0);
}
`;
let probePipe = null;
const probePass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }], timestampWrites: undefined };
function initProbe(d) {
  const mod = d.createShaderModule({ label: 'probe', code: PROBE_WGSL });
  world.probeReady = d.createRenderPipelineAsync({
    label: 'probe', layout: d.createPipelineLayout({ bindGroupLayouts: [gpu.mainBGL] }),
    vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
  }).then((p) => { probePipe = p; });
  probePass.colorAttachments[0].view = world.probeTex.createView();
  addPrePass({ pre(enc) {
    if (!probePipe) return;
    probePass.timestampWrites = tsw();
    const p = enc.beginRenderPass(probePass);
    p.setPipeline(probePipe); p.setBindGroup(0, gpu.mainBG); p.draw(3); p.end();
  } });
}

export function initWorld() {
  const d = gpu.device;
  world.fieldFormat = d.features.has('float32-filterable') ? 'rgba32float' : 'rgba16float';
  world.buffer = d.createBuffer({ size: worldData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const RT = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  world.fieldTex = d.createTexture({ size: [FIELD[0].res, FIELD[0].res, 2], format: world.fieldFormat, usage: RT });
  world.farTex = d.createTexture({ size: [FIELD[2].res, FIELD[2].res], format: 'rgba16float', usage: RT });
  // Label map: per-region distances (labelA: savannah, ice, desert, forest; biomeTex2: steppe,
  // mountains, coast, strait split), resolved into biomeTex (road.js).
  world.biomeTex = d.createTexture({ size: [LMAP.res, LMAP.res], format: 'rgba16float', usage: RT });
  world.labelA = d.createTexture({ size: [LMAP.res, LMAP.res], format: 'rgba16float', usage: RT });
  world.biomeTex2 = d.createTexture({ size: [LMAP.res, LMAP.res], format: 'rgba16float', usage: RT });
  world.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  world.noiseTex = initNoiseTex(d);
  world.settleTex = d.createTexture({ size: [SETTLE_MAP.res, SETTLE_MAP.res], format: 'r8unorm', usage: RT });
  world.probeTex = d.createTexture({ size: [16, 17], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  initProbe(d);
  const noiseSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 4, lodMaxClamp: 1 });
  const ALL = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  world.bgl = d.createBindGroupLayout({ entries: [
    { binding: 0, visibility: ALL, buffer: {} },
    { binding: 1, visibility: ALL, texture: { viewDimension: '2d-array' } },
    { binding: 2, visibility: ALL, texture: {} },
    { binding: 3, visibility: ALL, sampler: {} },
    { binding: 4, visibility: ALL, texture: {} },
    { binding: 5, visibility: ALL, texture: {} },
    { binding: 6, visibility: ALL, sampler: {} },
    { binding: 7, visibility: ALL, texture: {} },
    { binding: 8, visibility: ALL, texture: {} },
    { binding: 9, visibility: ALL, texture: {} },
  ] });
  world.bg = d.createBindGroup({ layout: world.bgl, entries: [
    { binding: 0, resource: { buffer: world.buffer } },
    { binding: 1, resource: world.fieldTex.createView({ dimension: '2d-array' }) },
    { binding: 2, resource: world.farTex.createView() },
    { binding: 3, resource: world.sampler },
    { binding: 4, resource: world.biomeTex.createView() },
    { binding: 5, resource: world.noiseTex.createView() },
    { binding: 6, resource: noiseSamp },
    { binding: 7, resource: world.probeTex.createView() },
    { binding: 8, resource: world.biomeTex2.createView() },
    { binding: 9, resource: world.settleTex.createView() },
  ] });
  packBiomes(worldData, SLOT_BP * 4);
}

// Camera-frustum planes (from camera.viewProj), normalised; inside when dot(n, p) + w >= 0.
function writePlanes(o) {
  const m = camera.viewProj;
  // Rows of the matrix (column-major storage).
  for (let i = 0; i < 6; i++) {
    const r = i >> 1, sgn = (i & 1) ? -1 : 1;
    let a, b, c, w;
    if (r < 2) { // left/right, bottom/top: row3 +- row r
      a = m[3] + sgn * m[r]; b = m[7] + sgn * m[4 + r]; c = m[11] + sgn * m[8 + r]; w = m[15] + sgn * m[12 + r];
    } else if (sgn > 0) { // near (reverse-Z: z <= w)
      a = m[3] - m[2]; b = m[7] - m[6]; c = m[11] - m[10]; w = m[15] - m[14];
    } else { // far: z >= 0 (infinite: degenerate) -> always inside
      a = 0; b = 0; c = 0; w = 1;
    }
    const l = Math.sqrt(a * a + b * b + c * c) || 1;
    worldData[o + i * 4] = a / l; worldData[o + i * 4 + 1] = b / l; worldData[o + i * 4 + 2] = c / l; worldData[o + i * 4 + 3] = w / l;
  }
}

// Fills and uploads the World uniform. Call after the camera is updated, before rendering.
// worldIn: car x, y, z, shadow centre x, z (set by the caller; no double arguments).
export const worldIn = new Float64Array(5);
let lastDirtyW = -1;
const BDBG = typeof location !== 'undefined' && /[?&]bdbg=1/.test(location.search) ? 1 : 0;
export function updateWorld() {
  if (graph.dirty !== lastDirtyW) { lastDirtyW = graph.dirty; requestShadow1(); }
  planShadow1();
  const carX = worldIn[0], carY = worldIn[1], carZ = worldIn[2], shadowX = worldIn[3], shadowZ = worldIn[4];
  const w = worldData;
  const cx = camera.eye[0], cz = camera.eye[2];
  for (let l = 0; l < 3; l++) {
    const F = FIELD[l];
    const ox = Math.round(cx / F.snap) * F.snap, oz = Math.round(cz / F.snap) * F.snap;
    fieldOrigin[l * 2] = ox; fieldOrigin[l * 2 + 1] = oz;
    w[l * 4] = ox; w[l * 4 + 1] = oz; w[l * 4 + 2] = F.size / F.res; w[l * 4 + 3] = F.size;
  }
  w[12] = state.biomeA; w[13] = state.biomeB; w[14] = state.biomeBlend; w[15] = state.time;
  const c = surfaceCurve;
  w[16] = c.a; w[17] = c.b; w[18] = c.d0; w[19] = c.d1;
  w[20] = carX; w[21] = carY; w[22] = carZ; w[23] = state.speed;
  w[24] = camera.eye[0]; w[25] = camera.eye[1]; w[26] = camera.eye[2]; w[27] = state.view;
  w[28] = shadowX; w[29] = shadowZ; w[30] = camera.shadowRadius; w[31] = 0;
  writePlanes(32);
  for (let e = 0; e < MAX_EDGES; e++) {
    const o = (SLOT_EDGES + e) * 4;
    w[o] = edgeAlive[e] ? edgePresence[e] : 0;
    w[o + 1] = edgeRegion[e];
    w[o + 2] = Math.min(edgeDrawEnd[e] + DRAW_END_PAD, 1e6);
    w[o + 3] = edgeN[e];
  }
  const ob = SLOT_BW * 4;
  w[ob] = carBiome[0]; w[ob + 1] = carBiome[1]; w[ob + 2] = carBiome[2]; w[ob + 3] = 0;
  // The map is re-rendered this frame whenever it moves, so the current L2 origin is right.
  w[ob + 4] = fieldOrigin[4]; w[ob + 5] = fieldOrigin[5]; w[ob + 6] = LMAP.size / LMAP.res; w[ob + 7] = LMAP.size;
  w[ob + 8] = 0.94; w[ob + 9] = 0.342; w[ob + 10] = state.time; w[ob + 11] = 0;
  w[ob + 12] = BDBG; // ?bdbg=1: terrain shows its biome weights
  w[ob + 13] = Math.cos(carPose[3]); w[ob + 14] = Math.sin(carPose[3]); w[ob + 15] = padTight[0];
  const os = SLOT_SITES * 4;
  for (let i = 0; i < 24; i++) w[os + i] = siteData[i];
  updateSea(state.dt);
  const o2 = SLOT_BW2 * 4;
  w[o2] = carBiome[3]; w[o2 + 1] = carBiome[4]; w[o2 + 2] = carBiome[5]; w[o2 + 3] = carBiome[6];
  w[o2 + 4] = seaData[0]; w[o2 + 5] = seaData[1]; w[o2 + 6] = seaData[2]; w[o2 + 7] = 0;
  for (let i = 0; i < MAX_PADS * 4; i++) w[SLOT_SIGHT * 4 + i] = siteSight[i];
  for (let i = 0; i < MAX_TUN; i++) {
    const o = (SLOT_TUN + i * 3) * 4, t = i * 12;
    w[o] = tunData[t]; w[o + 1] = tunData[t + 1]; w[o + 2] = tunData[t + 2]; w[o + 3] = tunData[t + 3];
    w[o + 4] = tunData[t + 4]; w[o + 5] = tunData[t + 5]; w[o + 6] = tunData[t + 6]; w[o + 7] = tunData[t + 7];
    w[o + 8] = tunData[t + 8]; w[o + 9] = tunData[t + 9]; w[o + 10] = tunData[t + 10]; w[o + 11] = tunData[t + 11];
  }
  gpu.device.queue.writeBuffer(world.buffer, 0, w);
}

// ---------------------------------------------------------------------------------
// Debug / tools (never on the frame path): window.__world.groundAt(x, z) (JS mirror, with the
// sea and biome weights), and groundCheck(points) -> the GPU ground() heights at [[x, z], ...]
// (a one-off compute pass), so tools can compare the car's ground with the rendered terrain.
if (typeof window !== 'undefined') {
  let ckPipe = null;
  window.__world = {
    groundAt(x, z) {
      const g = new Float64Array(8); g[6] = x; g[7] = z; groundInfo(g);
      return { h: g[0], d: g[1], bio: Array.from(groundBio.subarray(0, 7)), sea: groundSea[0], seaY: seaData[0], relief: SIO[14] };
    },
    sea: seaData, snap: bioSnap, carBiome,
    async groundCheck(points) {
      const d = gpu.device, n = points.length;
      if (!ckPipe) {
        const mod = d.createShaderModule({ code: WORLD_WGSL + `
@group(0) @binding(0) var<storage, read> P: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> H: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&P)) { return; }
  H[id.x] = groundH(P[id.x]);
}` });
        const bgl = d.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
        ckPipe = { bgl, pipe: d.createComputePipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [bgl, world.bgl] }), compute: { module: mod, entryPoint: 'main', constants: { SEED: state.seed } } }) };
      }
      const pb = d.createBuffer({ size: n * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(pb, 0, new Float32Array(points.flat()));
      const hb = d.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const rb = d.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const bg = d.createBindGroup({ layout: ckPipe.bgl, entries: [{ binding: 0, resource: { buffer: pb } }, { binding: 1, resource: { buffer: hb } }] });
      const enc = d.createCommandEncoder();
      const p = enc.beginComputePass(); p.setPipeline(ckPipe.pipe); p.setBindGroup(0, bg); p.setBindGroup(1, world.bg); p.dispatchWorkgroups(Math.ceil(n / 64)); p.end();
      enc.copyBufferToBuffer(hb, 0, rb, 0, n * 4);
      d.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const out = Array.from(new Float32Array(rb.getMappedRange()));
      rb.unmap();
      return out;
    },
  };
}
