// Value noise, fbm and the world height functions, in WGSL and a JS mirror.
// The two must agree: the GPU draws the ground, the CPU drives the car and the camera on it.
//
//   baseH(x, z)   gentle rolling ground everywhere (roads are built on it)
//   reliefH(x, z) distant mesas and inselbergs; the caller masks it by distance from the
//                 road corridor so the drive stays in open country and the horizon is never empty.
//
// The seed is a WGSL override constant (SEED) and setNoiseSeed() on the JS side.

export const NOISE_WGSL = /* wgsl */ `
override SEED: u32 = 1u;
fn hash2(ix: i32, iz: i32) -> f32 {
  var h = bitcast<u32>(ix) * 374761393u + bitcast<u32>(iz) * 668265263u + SEED * 1442695041u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) * (1.0 / 4294967296.0);
}
fn hashU(a: u32, b: u32) -> u32 {
  var h = a * 374761393u + b * 668265263u + SEED * 1442695041u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let ix = i32(i.x);
  let iz = i32(i.y);
  let a = hash2(ix, iz);
  let b = hash2(ix + 1, iz);
  let c = hash2(ix, iz + 1);
  let d = hash2(ix + 1, iz + 1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(p0: vec2f, oct: i32) -> f32 {
  var p = p0;
  var s = 0.0;
  var a = 0.5;
  for (var i = 0; i < oct; i++) {
    s += a * (vnoise(p) * 2.0 - 1.0);
    p = vec2f(p.x * 1.6 - p.y * 1.2, p.x * 1.2 + p.y * 1.6) + vec2f(5.3, 1.7);
    a *= 0.5;
  }
  return s;
}
fn baseH(p: vec2f) -> f32 {
  return 16.0 * fbm(p * (1.0 / 1100.0) + vec2f(3.1, 7.7), 4)
       + 3.5 * fbm(p * (1.0 / 240.0) + vec2f(11.3, 2.9), 3)
       + 0.5 * fbm(p * (1.0 / 41.0), 2);
}
fn reliefH(p: vec2f) -> f32 {
  let n = fbm(p * (1.0 / 2300.0) + vec2f(17.0, 4.0), 4);
  let m1 = smoothstep(0.06, 0.12, n);
  let m2 = smoothstep(0.27, 0.31, n);
  let rough = fbm(p * (1.0 / 160.0) + vec2f(1.0, 9.0), 3);
  let mesa = m1 * (62.0 + 8.0 * rough) + m2 * 48.0;
  let d = fbm(p * (1.0 / 1250.0) + vec2f(41.0, 23.0), 4);
  let dome = pow(max(d + 0.02, 0.0), 1.5) * 520.0;
  return max(mesa, dome) + 6.0 * rough * smoothstep(0.0, 0.3, n + 0.3);
}

// ---- Biome terrain shapes (see natural() in world.js). w = biome weights (savannah, ice, desert).
const WIND = vec2f(-0.878, -0.479); // dunes' downwind: away from the desert sun, so slip faces are shaded
fn baseLow(p: vec2f) -> f32 {
  return 16.0 * fbm(p * (1.0 / 1100.0) + vec2f(3.1, 7.7), 4) + 3.5 * fbm(p * (1.0 / 240.0) + vec2f(11.3, 2.9), 3);
}
// Relief per biome from the shared relief noises (masked by distance from the roads by the caller).
fn reliefW(p: vec2f, w: vec3f, v: vec4f, m: f32, mi: f32, far: f32) -> f32 {
  let n = fbm(p * (1.0 / 2300.0) + vec2f(17.0, 4.0), 4);
  let rough = fbm(p * (1.0 / 160.0) + vec2f(1.0, 9.0), 3);
  let d = fbm(p * (1.0 / 1250.0) + vec2f(41.0, 23.0), 4);
  let dome = pow(max(d + 0.02, 0.0), 1.5) * 520.0;
  var r = 0.0;
  if (w.x > 0.0) {
    let m1 = smoothstep(0.06, 0.12, n);
    let m2 = smoothstep(0.27, 0.31, n);
    var rs = max(m1 * (62.0 + 8.0 * rough) + m2 * 48.0, dome) + 6.0 * rough * smoothstep(0.0, 0.3, n + 0.3);
    // Erosion gullies down the hills (ridged lines, deeper on the big hills).
    let gq = vec2f(p.x * 0.6 - p.y * 0.8, p.x * 0.8 + p.y * 0.6);
    let gl = abs(2.0 * vnoise(vec2f(gq.x * (1.0 / 70.0), gq.y * (1.0 / 160.0)) + vec2f(7.0, 3.0)) - 1.0);
    rs -= 7.0 * (1.0 - smoothstep(0.0, 0.25, gl)) * smoothstep(12.0, 70.0, rs);
    r += m * w.x * rs;
  }
  if (w.y > 0.0) {
    // Ice sheet: a broad plateau with a steep, stepped front (the glacier) broken into
    // serac blocks near its edge; low nunataks.
    // The front stands ~300 m from the nearest road (further where n is low), so ice roads
    // run in valleys between glacier walls.
    let gu = (far - 280.0) * 0.0012 + n + 0.06;
    let g = smoothstep(-0.004, 0.008, gu); // sheer front
    var sheet = g * (72.0 + 4.0 * rough + 34.0 * smoothstep(-0.1, 0.25, n)); // mostly flat top
    // Serac zone just behind the front: blocks and slots that break the edge and the face.
    let sz = g * (1.0 - smoothstep(0.05, 0.16, gu));
    sheet += sz * 16.0 * (smoothstep(0.42, 0.5, vnoise(p * (1.0 / 38.0) + vec2f(4.0, 7.0))) - 0.5); // angular serac blocks
    r += mi * smoothstep(0.5, 0.95, w.y) * (max(sheet, dome * 0.55) + 4.0 * rough); // deep in the ice only
  }
  if (w.z > 0.0) {
    // Low terraced mesas and worn hills.
    let m1 = smoothstep(0.09, 0.12, n);
    let m2 = smoothstep(0.24, 0.26, n);
    r += m * w.z * (max(m1 * (30.0 + 5.0 * rough) + m2 * 20.0, dome * 0.32) + 3.0 * rough);
  }
  // Forest: rounded wooded hills. Steppe: long low rises under a big sky. Coast: low downs.
  if (v.x > 0.0) { r += m * v.x * (max(dome * 0.35, smoothstep(-0.05, 0.35, n) * (26.0 + 6.0 * rough)) + 4.0 * rough); }
  if (v.y > 0.0) { r += m * v.y * (dome * 0.1 + 8.0 * smoothstep(0.1, 0.4, n) + 2.5 * rough); }
  if (v.w > 0.0) { r += m * v.w * (dome * 0.15 + 10.0 * smoothstep(0.05, 0.3, n) + 3.0 * rough); }
  return r;
}
// Mountains: ridged multifractal peaks and arêtes (up to ~600 m) over a broad massif envelope;
// natural() masks them by distance from the roads so the road keeps its valley floor.
fn mountainH(p: vec2f) -> f32 {
  var q = p * (1.0 / 1500.0) + vec2f(13.0, 29.0);
  var s = 0.0;
  var a = 0.5;
  var wg = 1.0;
  for (var i = 0; i < 5; i++) {
    let r = 1.0 - abs(vnoise(q) * 2.0 - 1.0);
    let r2 = r * r * wg;
    s += a * r2;
    wg = clamp(r2 * 1.8, 0.0, 1.0);
    q = vec2f(q.x * 1.6 - q.y * 1.2, q.x * 1.2 + q.y * 1.6) + vec2f(5.3, 1.7);
    a *= 0.5;
  }
  let massif = smoothstep(-0.35, 0.25, fbm(p * (1.0 / 3600.0) + vec2f(8.0, 2.0), 2));
  return (30.0 + 900.0 * s * s) * (0.35 + 0.65 * massif);
}
// Coast: which side of the nearest road the sea lies on (1 sea side, 0 land side). The sea
// is on the W.sea.yz side; the side comes from the far field's gradient (the direction away
// from the nearest road), and far from every road from the car's position instead.
fn seaSide(p: vec2f, far: f32) -> f32 {
  let g = vec2f(farField(p + vec2f(24.0, 0.0)) - farField(p - vec2f(24.0, 0.0)), farField(p + vec2f(0.0, 24.0)) - farField(p - vec2f(0.0, 24.0)));
  let s = smoothstep(-0.25, 0.25, dot(g, W.sea.yz) / max(length(g), 1e-3));
  let sc = smoothstep(-150.0, 150.0, dot(p - W.car.xz, W.sea.yz));
  // Open water only: 160 m further out to sea must also be clear of roads (no pools between
  // the roads of a fork).
  let open = smoothstep(70.0, 150.0, farField(p + W.sea.yz * 160.0));
  return mix(s, sc, smoothstep(700.0, 880.0, far)) * open;
}
// Coastline coordinate (m, > 0 offshore) and cliff amount for a point at far metres from the roads.
fn coastC(p: vec2f, far: f32) -> vec2f {
  let wob = 30.0 * (vnoise(p * (1.0 / 260.0) + vec2f(2.0, 5.0)) - 0.5) + 10.0 * (vnoise(p * (1.0 / 70.0) + vec2f(7.0, 1.0)) - 0.5);
  let cliff = smoothstep(0.42, 0.62, vnoise(p * (1.0 / 420.0) + vec2f(9.0, 9.0)));
  return vec2f(far - 60.0 - wob, cliff);
}
// Ice-age ground: long smooth moraine swells and broad hummocks. Only large, rounded forms
// live in the mesh (the coarse LOD rings would alias anything narrower into a sawtooth);
// drifts and sastrugi are shaded per pixel (terrain.js iceMat).
fn iceRidge(p: vec2f) -> f32 {
  let q = vec2f(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8);
  let r = vnoise(vec2f(q.x * (1.0 / 330.0), q.y * (1.0 / 120.0)) + vec2f(3.0, 9.0));
  let t = 2.0 * r - 1.0;
  return 1.0 - t * t;
}
fn iceH(p: vec2f) -> f32 {
  let ridge = iceRidge(p);
  let hum = vnoise(p * (1.0 / 140.0) + vec2f(6.0, 2.0));
  let hum2 = vnoise(vec2f(p.x * 0.6 + p.y * 0.8, -p.x * 0.8 + p.y * 0.6) * (1.0 / 62.0) + vec2f(1.0, 5.0));
  return 7.5 * ridge * ridge + 3.2 * hum + 1.1 * hum2;
}
// Snow drifts: low transverse waves (~17 m apart, steeper lee side), patchy. Faded out with
// camera distance on the GPU (the coarse LOD rings would alias them); the CPU mirror (near
// the car) keeps them in full.
fn iceDrift(p: vec2f) -> f32 {
  let u = dot(p, vec2f(0.94, 0.342)) * (1.0 / 21.0) + 1.6 * vnoise(p * (1.0 / 60.0) + vec2f(2.0, 9.0));
  let f = fract(u);
  let prof = smoothstep(0.0, 0.72, f) * (1.0 - smoothstep(0.72, 1.0, f));
  return 1.15 * smoothstep(0.3, 0.75, vnoise(p * (1.0 / 45.0) + vec2f(5.0, 1.0))) * prof;
}
fn duneProfile(f: f32) -> f32 {
  let c = 0.76;
  if (f < c) { return sin(f * (1.5707963 / c)); }
  let t = (f - c) / (1.0 - c);
  return 1.0 - t * (0.85 + 0.15 * t);
}
// Transverse dunes (slip faces downwind) on dune fields; stony plain between them.
fn duneField(p: vec2f) -> f32 { return smoothstep(0.3, 0.55, vnoise(p * (1.0 / 900.0) + vec2f(8.5, 3.2))); }
fn duneH(p: vec2f) -> f32 {
  let fld = duneField(p);
  if (fld <= 0.0) { return 0.0; }
  let warp = fbm(p * (1.0 / 420.0) + vec2f(5.0, 13.0), 2) * 1.7 + (vnoise(p * (1.0 / 95.0) + vec2f(2.0, 8.0)) - 0.5) * 0.35;
  let u = dot(p, WIND) * (1.0 / 78.0) + warp;
  let amp = 11.0 * (0.55 + 0.45 * vnoise(p * (1.0 / 230.0) + vec2f(4.0, 1.0)));
  let draa = 12.0 * fbm(p * (1.0 / 650.0) + vec2f(19.0, 2.0), 2);
  return fld * (amp * (duneProfile(fract(u)) - 0.45) + draa);
}
fn riverN(p: vec2f) -> f32 { return fbm(p * (1.0 / 2600.0) + vec2f(2.6, 49.3), 2); }
// Approximate distance to the river (zero line of riverN), metres.
fn riverDist(p: vec2f) -> f32 {
  let n = riverN(p);
  let gx = riverN(p + vec2f(8.0, 0.0)) - n;
  let gz = riverN(p + vec2f(0.0, 8.0)) - n;
  return abs(n) / max(length(vec2f(gx, gz)) * 0.125, 4e-5);
}
// Irregular river banks: metres added to the river distance for the channel edge.
fn riverBank(p: vec2f) -> f32 { return 5.0 * (vnoise(p * (1.0 / 27.0) + vec2f(3.0, 1.0)) - 0.5) + 2.0 * (vnoise(p * (1.0 / 9.5) + vec2f(8.0, 2.0)) - 0.5); }
fn lakeN(p: vec2f) -> f32 { return fbm(p * (1.0 / 700.0) + vec2f(7.0, 3.0), 2); }

struct Nat { h: f32, low: f32, flood: f32, chan: f32, lake: f32, rd: f32, relief: f32, sea: f32 };
// Natural terrain (no road conformance). far: masks the big relief; rdist: distance from the
// nearest road (masks the dunes next to it); w: biome weights.
fn natural(p: vec2f, far: f32, rdist: f32, w: vec3f, v: vec4f) -> Nat {
  var o: Nat;
  let low = baseLow(p);
  o.low = low;
  var h = low + 0.5 * fbm(p * (1.0 / 41.0), 2);
  let m = smoothstep(220.0, 650.0, far);
  let mi = smoothstep(130.0, 400.0, far); // the ice sheet comes closer to the road
  var floodR = 0.0;
  o.rd = 1e4; o.flood = 0.0; o.chan = 0.0; o.lake = 0.0; o.relief = 0.0; o.sea = 0.0;
  if (w.z > 0.004) {
    o.rd = riverDist(p);
    floodR = 1.0 - smoothstep(70.0, 240.0, o.rd);
    o.flood = floodR * w.z;
    o.chan = (1.0 - smoothstep(11.0, 17.0, o.rd + riverBank(p))) * w.z;
  }
  if (mi > 0.0) {
    o.relief = reliefW(p, w, v, m, mi, far) * (1.0 - o.flood);
    if (v.z > 0.004) { o.relief += v.z * smoothstep(100.0, 750.0, far) * mountainH(p) * (1.0 - o.flood); }
    h += o.relief;
  }
  if (w.y > 0.004) {
    h += w.y * iceH(p) * smoothstep(3.0, 70.0, rdist); // the road runs on the swells, not in a trench
    h += w.y * iceDrift(p) * smoothstep(5.0, 16.0, rdist) * (1.0 - smoothstep(350.0, 650.0, distance(p, W.cam.xz)));
  }
  if (w.z > 0.004) { h += w.z * duneH(p) * smoothstep(4.0, 45.0, rdist) * (1.0 - floodR); }
  let wl = low - 1.2;
  h = mix(h, wl + 0.9 + 0.7 * smoothstep(15.0, 220.0, o.rd), o.flood);
  h = mix(h, wl - 0.7, o.chan);
  if (w.y > 0.004) {
    o.lake = smoothstep(0.30, 0.33, lakeN(p)) * w.y * (1.0 - m) * smoothstep(45.0, 120.0, rdist);
    h = mix(h, low - 0.9, o.lake);
  }
  if (v.w > 0.004) {
    // The sea: a beach (or a low cliff where cliff noise is high) down to flat water at the
    // sea level W.sea.x, offshore of the coastline coordinate.
    let t = seaSide(p, far) * smoothstep(0.2, 0.55, v.w) * smoothstep(5.0, 25.0, far);
    if (t > 0.0) {
      let cc = coastC(p, far);
      let c = cc.x;
      let sy = W.sea.x;
      let beach = (1.0 - cc.y) * smoothstep(-35.0, -5.0, c);
      var hl = mix(h, min(h, sy + 0.5 + max(-c, 0.0) * 0.06), beach);
      let drop = mix(smoothstep(-12.0, 22.0, c), smoothstep(-3.0, 5.0, c), cc.y);
      hl = mix(hl, sy - 0.6, drop);
      h = mix(h, hl, t);
      o.sea = t * drop;
      o.relief *= 1.0 - o.sea;
    }
  }
  o.h = h;
  return o;
}
`;

// --- JS mirror. Allocation-free by construction: V8 boxes doubles passed to or returned
// from non-inlined calls, so the hot API takes its input from and writes its output to the
// NIO Float64Array, and helpers only exchange small integers (Smis).
//   NIO[0], NIO[1] = x, z   ->   noiseBase(): NIO[2] = baseH;  noiseRelief(): NIO[3] = reliefH
export const NIO = new Float64Array(4);
const seedS = new Int32Array(1);
const LV = new Float64Array(16); // per-layer fbm results (LV[10] is also the shape scratch slot)
const LM = new Float64Array(1); // massif layer result
// Layers: scale (1/m), offset x, offset z, octaves.
export const LS = new Float64Array([1 / 1100, 3.1, 7.7, 4, 1 / 240, 11.3, 2.9, 3, 1 / 41, 0, 0, 2,
  1 / 2300, 17, 4, 4, 1 / 160, 1, 9, 3, 1 / 1250, 41, 23, 4,
  1 / 2600, 2.6, 49.3, 2, // 6 river (offset chosen so seed 1's desert road meets it)
  1 / 700, 7, 3, 2, // 7 lake
  1 / 420, 5, 13, 2, // 8 dune warp
  1 / 650, 19, 2, 2, // 9 draa
  1 / 3600, 8, 2, 2, // 10 mountain massif
]);

export function setNoiseSeed(s) { seedS[0] = Math.imul(s >>> 0, 1442695041); }

// 30-bit hash (a Smi); value noise uses it / 2^30.
function hashS(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + seedS[0]) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 2;
}
// Integer hash for generation (30-bit Smi).
export function hashU(a, b) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + seedS[0]) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 2;
}
export const HASH_SCALE = 1 / 1073741824;

// fbm of layer k at (NIO[0], NIO[1]) -> LV[k].
function fbmLayer(k) {
  const o = k * 4;
  let x = NIO[0] * LS[o] + LS[o + 1], z = NIO[1] * LS[o] + LS[o + 2];
  const oct = LS[o + 3];
  let s = 0, a = 0.5;
  for (let i = 0; i < oct; i++) {
    const fx0 = Math.floor(x), fz0 = Math.floor(z);
    const ix = fx0 | 0, iz = fz0 | 0;
    const fx = x - fx0, fz = z - fz0;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const va = hashS(ix, iz) * HASH_SCALE, vb = hashS(ix + 1, iz) * HASH_SCALE;
    const vc = hashS(ix, iz + 1) * HASH_SCALE, vd = hashS(ix + 1, iz + 1) * HASH_SCALE;
    const ab = va + (vb - va) * ux, cd = vc + (vd - vc) * ux;
    s += a * ((ab + (cd - ab) * uz) * 2 - 1);
    const nx = x * 1.6 - z * 1.2 + 5.3;
    z = x * 1.2 + z * 1.6 + 1.7;
    x = nx;
    a *= 0.5;
  }
  LV[k] = s;
}
export function noiseBase() {
  fbmLayer(0); fbmLayer(1); fbmLayer(2);
  NIO[2] = 16 * LV[0] + 3.5 * LV[1] + 0.5 * LV[2];
}
export function noiseRelief() {
  fbmLayer(3); fbmLayer(4); fbmLayer(5);
  const n = LV[3], rough = LV[4], d = LV[5];
  let t = (n - 0.06) / 0.06; t = t < 0 ? 0 : t > 1 ? 1 : t; const m1 = t * t * (3 - 2 * t);
  t = (n - 0.27) / 0.04; t = t < 0 ? 0 : t > 1 ? 1 : t; const m2 = t * t * (3 - 2 * t);
  const mesa = m1 * (62 + 8 * rough) + m2 * 48;
  const dome = Math.pow(Math.max(d + 0.02, 0), 1.5) * 520;
  t = (n + 0.3) / 0.3; t = t < 0 ? 0 : t > 1 ? 1 : t;
  NIO[3] = Math.max(mesa, dome) + 6 * rough * t * t * (3 - 2 * t);
}
// Value noise in [0,1] at (NIO[0], NIO[1]) (single octave) -> NIO[2].
export function noiseValue() {
  const x = NIO[0], z = NIO[1];
  const fx0 = Math.floor(x), fz0 = Math.floor(z);
  const ix = fx0 | 0, iz = fz0 | 0;
  const fx = x - fx0, fz = z - fz0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const va = hashS(ix, iz) * HASH_SCALE, vb = hashS(ix + 1, iz) * HASH_SCALE;
  const vc = hashS(ix, iz + 1) * HASH_SCALE, vd = hashS(ix + 1, iz + 1) * HASH_SCALE;
  const ab = va + (vb - va) * ux, cd = vc + (vd - vc) * ux;
  NIO[2] = ab + (cd - ab) * uz;
}

// ---------------------------------------------------------------------------------
// Biome terrain shapes, JS mirror of natural() in the WGSL above (keep in sync).
// Inputs SIO[0] x, [1] z, [2] far, [3] rdist, [4..6] biome weights 0-2, [17..20] biome
// weights 3-6, [16] sea side (seaSide()), [21] sea level; outputs SIO[8] h, [9] low, [10] flood,
// [11] chan, [12] lake, [13] river distance, [14] relief, [22] sea (water) weight, [23] metres
// offshore of the coastline (coast only, else -1000).
export const SIO = new Float64Array(24);
const VN = new Float64Array(2);
function vnAt(slot) { // value noise at (VN[0], VN[1]) -> LV[slot]
  const x = VN[0], z = VN[1];
  const fx0 = Math.floor(x), fz0 = Math.floor(z);
  const ix = fx0 | 0, iz = fz0 | 0;
  const fx = x - fx0, fz = z - fz0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const va = hashS(ix, iz) * HASH_SCALE, vb = hashS(ix + 1, iz) * HASH_SCALE;
  const vc = hashS(ix, iz + 1) * HASH_SCALE, vd = hashS(ix + 1, iz + 1) * HASH_SCALE;
  const ab = va + (vb - va) * ux, cd = vc + (vd - vc) * ux;
  LV[slot] = ab + (cd - ab) * uz;
}
function ssJ(a, b, x) { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function riverNAt(dx, dz) { const x = NIO[0], z = NIO[1]; NIO[0] = x + dx; NIO[1] = z + dz; fbmLayer(6); NIO[0] = x; NIO[1] = z; }
function reliefJS() { // LV[3] n, LV[4] rough, LV[5] d already computed -> SIO[14]
  const n = LV[3], rough = LV[4], d = LV[5];
  const dome = Math.pow(Math.max(d + 0.02, 0), 1.5) * 520;
  let r = 0;
  const ws = SIO[4], wi = SIO[5], wd = SIO[6];
  const m = SIO[15], mi = SIO[7];
  if (ws > 0) {
    let rs = Math.max(ssJ(0.06, 0.12, n) * (62 + 8 * rough) + ssJ(0.27, 0.31, n) * 48, dome) + 6 * rough * ssJ(0, 0.3, n + 0.3);
    const x = SIO[0], z = SIO[1], gx = x * 0.6 - z * 0.8, gz = x * 0.8 + z * 0.6;
    VN[0] = gx / 70 + 7; VN[1] = gz / 160 + 3; vnAt(11);
    const gl = Math.abs(2 * LV[11] - 1);
    rs -= 7 * (1 - ssJ(0, 0.25, gl)) * ssJ(12, 70, rs);
    r += m * ws * rs;
  }
  if (wi > 0) {
    const gu = (SIO[2] - 280) * 0.0012 + n + 0.06;
    const g = ssJ(-0.004, 0.008, gu);
    let sheet = g * (72 + 4 * rough + 34 * ssJ(-0.1, 0.25, n));
    const sz = g * (1 - ssJ(0.05, 0.16, gu));
    if (sz > 0) { VN[0] = SIO[0] / 38 + 4; VN[1] = SIO[1] / 38 + 7; vnAt(12); sheet += sz * 16 * (ssJ(0.42, 0.5, LV[12]) - 0.5); }
    r += mi * ssJ(0.5, 0.95, wi) * (Math.max(sheet, dome * 0.55) + 4 * rough);
  }
  if (wd > 0) r += m * wd * (Math.max(ssJ(0.09, 0.12, n) * (30 + 5 * rough) + ssJ(0.24, 0.26, n) * 20, dome * 0.32) + 3 * rough);
  const vf = SIO[17], vs = SIO[18], vc = SIO[20];
  if (vf > 0) r += m * vf * (Math.max(dome * 0.35, ssJ(-0.05, 0.35, n) * (26 + 6 * rough)) + 4 * rough);
  if (vs > 0) r += m * vs * (dome * 0.1 + 8 * ssJ(0.1, 0.4, n) + 2.5 * rough);
  if (vc > 0) r += m * vc * (dome * 0.15 + 10 * ssJ(0.05, 0.3, n) + 3 * rough);
  SIO[14] = r;
}
function mountainJS() { // mountainH() at (SIO[0], SIO[1]) -> LV[10]
  let x = SIO[0] / 1500 + 13, z = SIO[1] / 1500 + 29;
  let s = 0, a = 0.5, wg = 1;
  for (let i = 0; i < 5; i++) {
    VN[0] = x; VN[1] = z; vnAt(11);
    const r = 1 - Math.abs(LV[11] * 2 - 1);
    const r2 = r * r * wg;
    s += a * r2;
    wg = r2 * 1.8; wg = wg > 1 ? 1 : wg;
    const nx = x * 1.6 - z * 1.2 + 5.3;
    z = x * 1.2 + z * 1.6 + 1.7;
    x = nx;
    a *= 0.5;
  }
  const lv10 = LV[10];
  fbmLayer(10); LM[0] = LV[10]; LV[10] = lv10;
  LV[10] = (30 + 900 * s * s) * (0.35 + 0.65 * ssJ(-0.35, 0.25, LM[0]));
}
function coastJS() { // coastC() -> LV[12] c, LV[13] cliff
  const x = SIO[0], z = SIO[1];
  VN[0] = x / 260 + 2; VN[1] = z / 260 + 5; vnAt(11); let wob = 30 * (LV[11] - 0.5);
  VN[0] = x / 70 + 7; VN[1] = z / 70 + 1; vnAt(11); wob += 10 * (LV[11] - 0.5);
  VN[0] = x / 420 + 9; VN[1] = z / 420 + 9; vnAt(11);
  LV[13] = ssJ(0.42, 0.62, LV[11]);
  LV[12] = SIO[2] - 60 - wob;
}
function bankJS() { // riverBank() at (SIO[0], SIO[1]); clobbers LV[11..12]
  const x = SIO[0], z = SIO[1];
  VN[0] = x / 27 + 3; VN[1] = z / 27 + 1; vnAt(11);
  VN[0] = x / 9.5 + 8; VN[1] = z / 9.5 + 2; vnAt(12);
  return 5 * (LV[11] - 0.5) + 2 * (LV[12] - 0.5);
}
// riverBank() at (NIO[0], NIO[1]) -> NIO[3] (bridges).
export function noiseRiverBank() { SIO[0] = NIO[0]; SIO[1] = NIO[1]; NIO[3] = bankJS(); }
function iceJS() { // -> LV[10]
  const x = SIO[0], z = SIO[1];
  const qx = x * 0.8 - z * 0.6, qz = x * 0.6 + z * 0.8;
  VN[0] = qx / 330 + 3; VN[1] = qz / 120 + 9; vnAt(11);
  const t = 2 * LV[11] - 1, ridge = 1 - t * t;
  VN[0] = x / 140 + 6; VN[1] = z / 140 + 2; vnAt(12);
  VN[0] = (x * 0.6 + z * 0.8) / 62 + 1; VN[1] = (-x * 0.8 + z * 0.6) / 62 + 5; vnAt(13);
  LV[10] = 7.5 * ridge * ridge + 3.2 * LV[12] + 1.1 * LV[13];
}
function driftJS() { // iceDrift() -> LV[10]
  const x = SIO[0], z = SIO[1];
  VN[0] = x / 60 + 2; VN[1] = z / 60 + 9; vnAt(11);
  const u = (x * 0.94 + z * 0.342) / 21 + 1.6 * LV[11];
  const f = u - Math.floor(u);
  VN[0] = x / 45 + 5; VN[1] = z / 45 + 1; vnAt(12);
  LV[10] = 1.15 * ssJ(0.3, 0.75, LV[12]) * ssJ(0, 0.72, f) * (1 - ssJ(0.72, 1, f));
}
function duneJS() { // -> LV[10]
  const x = SIO[0], z = SIO[1];
  VN[0] = x / 900 + 8.5; VN[1] = z / 900 + 3.2; vnAt(11);
  const fld = ssJ(0.3, 0.55, LV[11]);
  if (fld <= 0) { LV[10] = 0; return; }
  fbmLayer(8);
  VN[0] = x / 95 + 2; VN[1] = z / 95 + 8; vnAt(12);
  const u = (x * -0.878 + z * -0.479) / 78 + LV[8] * 1.7 + (LV[12] - 0.5) * 0.35;
  VN[0] = x / 230 + 4; VN[1] = z / 230 + 1; vnAt(13);
  const amp = 11 * (0.55 + 0.45 * LV[13]);
  fbmLayer(9);
  const f = u - Math.floor(u), c = 0.76;
  let pr;
  if (f < c) pr = Math.sin(f * (1.5707963 / c));
  else { const t = (f - c) / (1 - c); pr = 1 - t * (0.85 + 0.15 * t); }
  LV[10] = fld * (amp * (pr - 0.45) + 12 * LV[9]);
}
// natural(): NIO[0], NIO[1] must equal SIO[0], SIO[1]. Clobbers NIO[2..3].
export function noiseNatural() {
  NIO[0] = SIO[0]; NIO[1] = SIO[1];
  fbmLayer(0); fbmLayer(1); fbmLayer(2);
  const low = 16 * LV[0] + 3.5 * LV[1];
  SIO[9] = low;
  let h = low + 0.5 * LV[2];
  const far = SIO[2], m = ssJ(220, 650, far), mi = ssJ(130, 400, far);
  SIO[15] = m; SIO[7] = mi;
  const wi = SIO[5], wd = SIO[6];
  let floodR = 0, rd = 1e4, flood = 0, chan = 0, lake = 0, relief = 0;
  if (wd > 0.004) {
    fbmLayer(6); const n = LV[6];
    riverNAt(8, 0); const gx = LV[6] - n;
    riverNAt(0, 8); const gz = LV[6] - n;
    rd = Math.abs(n) / Math.max(Math.sqrt(gx * gx + gz * gz) * 0.125, 4e-5);
    floodR = 1 - ssJ(70, 240, rd);
    flood = floodR * wd;
    chan = (1 - ssJ(11, 17, rd + bankJS())) * wd;
  }
  if (mi > 0) {
    fbmLayer(3); fbmLayer(4); fbmLayer(5);
    reliefJS();
    relief = SIO[14] * (1 - flood);
    if (SIO[19] > 0.004) { mountainJS(); relief += SIO[19] * ssJ(100, 750, far) * LV[10] * (1 - flood); }
    h += relief;
  }
  if (wi > 0.004) { iceJS(); h += wi * LV[10] * ssJ(3, 70, SIO[3]); driftJS(); h += wi * LV[10] * ssJ(5, 16, SIO[3]); }
  if (wd > 0.004) { duneJS(); h += wd * LV[10] * ssJ(4, 45, SIO[3]) * (1 - floodR); }
  const wl = low - 1.2;
  h += (wl + 0.9 + 0.7 * ssJ(15, 220, rd) - h) * flood;
  h += (wl - 0.7 - h) * chan;
  if (wi > 0.004) {
    fbmLayer(7);
    lake = ssJ(0.30, 0.33, LV[7]) * wi * (1 - m) * ssJ(45, 120, SIO[3]);
    h += (low - 0.9 - h) * lake;
  }
  let sea = 0;
  SIO[23] = -1e3;
  if (SIO[20] > 0.004) {
    const t = SIO[16] * ssJ(0.2, 0.55, SIO[20]) * ssJ(5, 25, far);
    if (t > 0) {
      coastJS();
      const c = LV[12], cliff = LV[13], sy = SIO[21];
      SIO[23] = c;
      const beach = (1 - cliff) * ssJ(-35, -5, c);
      const hb = sy + 0.5 + Math.max(-c, 0) * 0.06;
      let hl = h + ((h < hb ? h : hb) - h) * beach;
      const drop = ssJ(-12, 22, c) + (ssJ(-3, 5, c) - ssJ(-12, 22, c)) * cliff;
      hl += (sy - 0.6 - hl) * drop;
      h += (hl - h) * t;
      sea = t * drop;
      relief *= 1 - sea;
    }
  }
  SIO[8] = h; SIO[10] = flood; SIO[11] = chan; SIO[12] = lake; SIO[13] = rd; SIO[14] = relief; SIO[22] = sea;
}

// River distance at (NIO[0], NIO[1]) -> NIO[2] (metres, as riverDist() in the WGSL).
export function noiseRiverDist() {
  fbmLayer(6); const n = LV[6];
  riverNAt(8, 0); const gx = LV[6] - n;
  riverNAt(0, 8); const gz = LV[6] - n;
  NIO[2] = Math.abs(n) / Math.max(Math.sqrt(gx * gx + gz * gz) * 0.125, 4e-5);
}

// Convenience (allocates a boxed double; load time / tools only).
export function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
export function baseH(x, z) { NIO[0] = x; NIO[1] = z; noiseBase(); return NIO[2]; }
