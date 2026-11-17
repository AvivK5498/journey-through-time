// Streamed terrain: a CDLOD quadtree of 32x32-quad tiles around the camera, selected on the
// CPU each frame (a few hundred node visits, no allocation) and displaced on the GPU from
// the ground function in world.js. Nothing is baked, so streaming can never hitch: tiles are
// just (origin, size, lod) records; heights, the road conformance and normals are computed
// in the vertex shader, and geomorphing hides LOD transitions.
//
// Detail falls off with distance: 0.25 m vertex spacing within ~24 m of the camera, doubling
// every ring out to 64 m spacing at ~6 km, where the masked relief (mesas, inselbergs)
// forms the horizon.

import { gpu, addDrawable, addPrePass, mainPipeline, shadowPipeline, shadow1 } from '../gpu.js';
import { MAIN_HEADER, SHADOW_HEADER } from '../shaders/common.js';
import { camera } from '../camera.js';
import { WORLD_WGSL, world, worldData, biomeAt } from './world.js';
import { state } from '../state.js';
import { ROAD_WGSL } from './road.js';
import { SURF_WGSL } from './surface.js';

const GRID = 32; // quads per tile side
const NV = GRID + 1;
const LODS = 9;
const LEAF = 8; // metres, finest tile
const R0 = 26; // range of lod 0; doubles per lod
const ROOT = LEAF * (1 << (LODS - 1));
const MAXT = 1024; // tiles per list
const ranges = new Float64Array(LODS);
for (let l = 0; l < LODS; l++) ranges[l] = R0 * (1 << l);

const tileData = new Float32Array(MAXT * 4 * 3); // main list, near shadow list, far shadow list
let nMain = 0, nShadow = 0, nShadow1 = 0;
const SH1_TILE_LOD = 4; // far cascade casters: 128 m tiles (4 m vertex spacing)

const TERRAIN_COMMON = WORLD_WGSL + /* wgsl */ `
@group(2) @binding(0) var<storage, read> tiles: array<vec4f>;
const R0: f32 = ${R0}.0;
const NV: u32 = ${NV}u;

fn tilePos(vi: u32, ii: u32) -> vec2f {
  let t = tiles[ii];
  let ij = vec2f(f32(vi % NV), f32(vi / NV));
  let cell = t.z / ${GRID}.0;
  let p0 = t.xy + ij * cell;
  let r = R0 * exp2(t.w);
  let k = saturate((distance(p0, W.cam.xz) - 0.72 * r) / (0.26 * r));
  let fr = fract(ij * 0.5) * 2.0;
  return t.xy + (ij - fr * k) * cell;
}
`;

const MAIN_WGSL = MAIN_HEADER + TERRAIN_COMMON + /* wgsl */ `
// Gradient-filtered material noise for this fragment (see tnl in world.js): x = p * s.
var<private> GDX: vec2f;
var<private> GDY: vec2f;
var<private> FWMIN: f32;
// The sampler stops at 4 texels per lattice cell (coarser mips keep the lattice's square
// look); past that the noise fades to its mean instead.
fn tn(x: vec2f, s: f32) -> vec4f {
  let lod = log2(max(FWMIN * s * 8.0, 1e-4));
  let fade = smoothstep(0.6, 2.6, lod);
  if (fade > 0.999) { return vec4f(0.5); }
  let v = textureSampleGrad(noiseTex, noiseSamp, x * (1.0 / 32.0), GDX * (s / 32.0), GDY * (s / 32.0));
  return mix(v, vec4f(0.5), fade);
}
` + ROAD_WGSL + SURF_WGSL + /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) w: vec3f,     // biome weights
  @location(3) aux: vec4f,   // base low, flood, channel, lake
  @location(4) aux2: vec2f,  // river distance, relief height
  @location(5) aux3: vec4f,  // raw ice weight, snow field, river tangent (xz)
  @location(6) aux4: vec2f,  // raw desert weight, far-field distance
  @location(7) aux5: vec3f,  // dune crest warp, dune amplitude noise, dune field (smooth: per vertex)
  @location(8) v: vec4f,     // biome weights 3-6 (forest, steppe, mountains, coast)
  @location(9) aux6: vec2f,  // sea (water) weight, raw coast weight
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = tilePos(vi, ii);
  let g = ground(p);
  // Normal epsilon grows smoothly with distance (not per tile) so LOD seams do not shade.
  let e = clamp(distance(p, W.cam.xz) * 0.03, 0.7, 48.0);
  let hx = groundH(p + vec2f(e, 0.0));
  let hz = groundH(p + vec2f(0.0, e));
  var o: VOut;
  o.wp = vec3f(p.x, g.h, p.y);
  o.n = normalize(vec3f(g.h - hx, e, g.h - hz));
  o.pos = F.viewProj * vec4f(o.wp, 1.0);
  o.w = g.w;
  o.v = g.v;
  o.aux = vec4f(g.low, g.flood, g.chan, g.lake);
  o.aux2 = vec2f(min(g.rd, 1e4), g.relief);
  let wrb = biomeWRaw(p);
  let wr = wrb.a;
  o.aux6 = vec2f(g.sea, wrb.b.w);
  var sv = -1.0;
  if (g.w.y > 0.004) { sv = iceSnowV(p, wr.y, g.h - g.low); }
  var rt = vec2f(1.0, 0.0);
  if (g.flood > 0.003) {
    let n0 = riverN(p);
    let gr = vec2f(riverN(p + vec2f(8.0, 0.0)) - n0, riverN(p + vec2f(0.0, 8.0)) - n0);
    rt = normalize(vec2f(-gr.y, gr.x) + vec2f(1e-7, 0.0)) * select(-1.0, 2.0, n0 > 0.0); // |rt|: bank (fieldAtT)
  }
  o.aux3 = vec4f(wr.y, sv, rt);
  o.aux4 = vec2f(wr.z, g.far);
  o.aux5 = vec3f(0.0);
  if (g.w.z > 0.004) {
    o.aux5 = vec3f(fbm(p * (1.0 / 420.0) + vec2f(5.0, 13.0), 2) * 1.7 + (vnoise(p * (1.0 / 95.0) + vec2f(2.0, 8.0)) - 0.5) * 0.35,
      vnoise(p * (1.0 / 230.0) + vec2f(4.0, 1.0)), duneField(p));
  }
  return o;
}

// Material accumulator: albedo, specular strength / roughness, extra height-gradient (for
// crisp per-pixel detail the mesh cannot carry) and a scalar bump height (screen-space).
struct Mat { alb: vec3f, spec: f32, rough: f32, gx: f32, gz: f32, bump: f32, wet: f32, snow: f32 };

fn vor(p: vec2f) -> vec2f { // F1, F2-F1 of a jittered grid (cracks, pebbles)
  let ip = floor(p);
  let fp = p - ip;
  var f1 = 9.0; var f2 = 9.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = vec2f(f32(i), f32(j));
      let o = c + vec2f(hash2(i32(ip.x) + i, i32(ip.y) + j), hash2(i32(ip.x) + i + 913, i32(ip.y) + j + 37)) * 0.8 + 0.1 - fp;
      let dd = dot(o, o);
      if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) { f2 = dd; }
    }
  }
  return vec2f(sqrt(f1), sqrt(f2) - sqrt(f1));
}
// Thin ridged lines from a noise channel (0 = on a line): crevasses, gullies, pressure ridges.
fn ridgeLine(v: f32) -> f32 { return abs(v * 2.0 - 1.0); }

fn savannahMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, hw: f32, relief: f32) -> Mat {
  var m: Mat;
  let A = tn(p * (1.0 / 190.0), 1.0 / 190.0);
  let B = tn(p * (1.0 / 23.0) + vec2f(7.0, 2.0), 1.0 / 23.0);
  let C = tn(p * 1.7, 1.7);
  let big = A.x;
  let mid = B.x;
  let fine = C.x;
  let cover = grassCoverL(p, d, hw, tnLod(fw, 1.0 / 4.3));
  let dry = W.bp[B_GROUND].rgb;
  let alt = W.bp[B_GROUND_ALT];
  let soil = W.bp[B_SOIL].rgb;
  let farK = smoothstep(150.0, 1500.0, dist);
  var canopy = mix(dry, alt.rgb, smoothstep(0.45, 0.8, big) * alt.w * (1.0 - 0.6 * farK));
  canopy *= 0.86 + 0.28 * mid;
  { // seasons on the canopy: a gentle hue drift (deep summer green / warm autumn), brightness kept
    let sK = seasonK(); let l0 = dot(canopy, vec3f(0.2126, 0.7152, 0.0722));
    var c2 = mix(canopy, canopy * vec3f(0.78, 0.96, 0.66), 0.4 * max(sK, 0.0)); c2 = mix(c2, c2 * vec3f(1.14, 1.0, 0.74), 0.4 * max(-sK, 0.0));
    canopy = c2 * (l0 / max(dot(c2, vec3f(0.2126, 0.7152, 0.0722)), 1e-4)); }
  let litter = mix(soil, dry, 0.45) * (0.55 + 0.25 * fine);
  let far = smoothstep(4.0, 90.0, dist);
  var alb = mix(litter, canopy, cover * mix(0.25, 1.0, far));
  alb = mix(alb, soil * (0.8 + 0.3 * mid), (1.0 - cover) * (1.0 - far * 0.3) * 0.75 * (1.0 - 0.7 * farK));
  // Seen from afar the tree canopy and scrub darken the plain and the hill flanks (the
  // trees themselves become sub-pixel): olive-dark speckle where groves are dense.
  let grove = smoothstep(0.25, 0.75, A.y);
  let scrub = smoothstep(0.45, 0.75, B.y) * (0.35 + 0.65 * smoothstep(4.0, 30.0, relief));
  let farV = smoothstep(150.0, 900.0, dist);
  let hill = smoothstep(3.0, 20.0, relief);
  // Hill flanks: olive grass low down, drying and thinning toward the top.
  let hiK = smoothstep(30.0, 140.0, relief);
  let hillGrass = mix(mix(vec3f(0.17, 0.15, 0.07), vec3f(0.22, 0.17, 0.08), mid), vec3f(0.27, 0.21, 0.12), hiK);
  alb = mix(alb, hillGrass, hill * 0.6);
  alb = mix(alb, vec3f(0.07, 0.08, 0.035), farV * (0.25 * grove + 0.45 * scrub) * (1.0 - 0.6 * hiK) + hill * scrub * 0.3 * (1.0 - hiK));
  // Rock: one warm grey granite. Domes and cliffs on the steepest faces (rain-streaked,
  // scrub in the cracks), outcrops on the shoulders and ridges of the hills and down their
  // gullies (coherent shapes, not blotches).
  let steep = smoothstep(0.62, 0.45, n.y);
  let streak = tn(vec2f((p.x + p.y) * 0.06, wp.y * 0.006), 0.06);
  let rockC = vec3f(0.36, 0.32, 0.27) * (0.78 + 0.32 * streak.x) * (0.85 + 0.25 * C.y) * (0.92 + 0.16 * B.w);
  if (hill > 0.0) {
    let slope = 1.0 - n.y;
    let gully = 1.0 - smoothstep(0.0, 0.12, ridgeLine(tn(p * (1.0 / 85.0) + vec2f(3.0, 1.0), 1.0 / 85.0).z));
    let outc = smoothstep(0.66, 0.7, B.z * 0.5 + A.w * 0.3 + slope * 0.75 + hiK * 0.12 + gully * 0.12) * hill;
    alb = mix(alb, rockC * mix(1.0, 0.75, gully), outc * 0.9);
    alb *= 1.0 - 0.25 * gully * hill * (1.0 - outc); // gullies hold shade and scrub
  }
  let crackScrub = smoothstep(0.6, 0.75, streak.y * 0.6 + B.y * 0.4) * smoothstep(0.35, 0.6, n.y);
  m.alb = mix(alb, mix(rockC, vec3f(0.08, 0.085, 0.04), crackScrub * 0.8), steep);
  m.spec = 0.02; m.rough = 0.75;
  return m;
}

// Landscape time-lapse phases from the journey clock, which only advances while driving (so a
// parked car holds its season). Round three: a whole year took 4 clock s (one every ~4 s of
// driving) and read as the forest blinking; now season: 36 clock s (~36 s at cruise, ~13 s
// flat out), iceAge: 90 clock s, both -0.8..0.8 and continuous (no wrap, no lapse factor, so
// stopping does not snap the colours back either).
fn seasonK() -> f32 { return sin(F.timeFx.z * 0.17453) * 0.8; }
fn iceAgeK() -> f32 { return sin(F.timeFx.z * 0.069813 + 1.0) * 0.8; }

// Ice-age margin, stylised: clean bright snowfields in large smooth forms (cyan shade comes
// from the snow lighting), a few dark slate outcrops with crisp snow caps, the glacier as a
// crisp blue-white ice cliff with vertical crevasses. Toward the savannah the snow thins
// (grass, frost, thin snow, deep snow). Snow line and glacier margin breathe with time.
fn iceMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, hw: f32, low: f32, lake: f32, relief: f32, wy: f32, sv0: f32) -> Mat {
  var m: Mat;
  let o = BK;
  let snow = W.bp[o + B_GROUND].rgb;
  let tundra = W.bp[o + B_GROUND_ALT].rgb;
  let rockC = W.bp[o + B_ROCK].rgb;
  let A = tn(p * (1.0 / 37.0) + vec2f(4.0, 2.0), 1.0 / 37.0);
  let B = tn(p * (1.0 / 160.0), 1.0 / 160.0);
  let ridge = iceRidge(p);
  let sK = seasonK();
  let aK = iceAgeK();
  // Snow cover: large smooth forms only. The snow line rides the biome margin and creeps
  // with the seasons and the ice ages; high ground keeps its snow longest.
  let line = wy + 0.12 * (B.x - 0.5) + 0.03 * clamp(relief, 0.0, 6.0) + 0.09 * sK + 0.07 * aK;
  let cov = smoothstep(0.32, 0.48, line); // thin snow -> deep snow
  let frost = smoothstep(0.12, 0.32, line); // dry grass -> frost
  var alb = snow * (0.97 + 0.05 * B.y) * mix(vec3f(1.0), vec3f(0.93, 0.97, 1.03), 0.25 * A.x);
  let thin = mix(tundra * vec3f(1.05, 1.0, 0.85), vec3f(0.62, 0.66, 0.70), frost * 0.85);
  alb = mix(thin, alb, cov);
  // Rock outcrops: dark slate on the steep faces and a few ridge crests, crisp snow caps on
  // anything flat enough to hold snow.
  let steep = smoothstep(0.74, 0.6, n.y);
  let outc = smoothstep(0.69, 0.71, A.y * 0.6 + ridge * ridge * 0.35 + 0.05) * (1.0 - smoothstep(4.0, 10.0, relief));
  var rockK = max(steep, outc * smoothstep(0.97, 0.9, n.y + 0.1 * A.z));
  let rock = rockC * (0.9 + 0.2 * A.w);
  alb = mix(alb, rock, rockK);
  var cv = cov * (1.0 - rockK);
  // The glacier: flat top of clean snow-ice, a sheer blue-white face, vertical crevasses
  // in deeper blue, faint horizontal bedding. Its margin advances and retreats with the ages.
  let shift = 3.0 * aK;
  let sheet = smoothstep(4.0 + shift, 9.0 + shift, relief);
  var face = 0.0;
  if (sheet > 0.0) {
    face = sheet * smoothstep(0.86, 0.7, n.y);
    let hcoord = (p.x * 0.7 + p.y * 0.7) * (1.0 / 6.0);
    let cr = tn(vec2f(hcoord, wp.y * 0.004) + vec2f(2.0, 7.0), 1.0 / 6.0);
    let vcrev = 1.0 - smoothstep(0.0, 0.08 + fw * 0.02, ridgeLine(cr.x));
    let shade = 0.88 + 0.12 * cr.y;
    var iceC = mix(vec3f(0.48, 0.70, 0.86), vec3f(0.80, 0.90, 0.96), smoothstep(0.2, 0.9, cr.z)) * shade;
    iceC = mix(iceC, vec3f(0.16, 0.36, 0.58), vcrev * 0.85);
    let top = mix(snow * vec3f(0.95, 0.98, 1.02), vec3f(0.55, 0.74, 0.88), smoothstep(0.96, 0.9, n.y) * 0.4);
    alb = mix(alb, top, sheet * (1.0 - face));
    alb = mix(alb, iceC, face);
    cv = mix(max(cv, sheet), 0.2, face);
    rockK *= 1.0 - sheet;
  }
  m.alb = alb;
  m.spec = mix(0.025, 0.05, face); m.rough = mix(mix(0.9, 0.7, cv), 0.45, face);
  m.snow = cv;
  m.bump = 0.0;
  // Frozen lake: dark clear ice with a crack network, pressure ridges of white rubble, drifted
  // snow patches and a white rime shore; matte enough that the low sun gives a soft sheen.
  if (lake > 0.45) {
    let k = smoothstep(0.62, 0.86, lake);
    let shore = smoothstep(0.45, 0.62, lake) * (1.0 - smoothstep(0.7, 0.86, lake));
    var crack = 0.0;
    if (fw < 0.6) {
      let cr = vor(p * 0.055);
      crack = (1.0 - smoothstep(0.0, 0.012 + fw * 0.06, cr.y)) * smoothstep(0.6, 0.15, fw);
    }
    let pr = tn(p * (1.0 / 70.0) + vec2f(5.0, 5.0), 1.0 / 70.0);
    let press = (1.0 - smoothstep(0.0, 0.05 + fw * 0.01, ridgeLine(pr.x))) * smoothstep(0.4, 0.6, pr.y);
    let drift = smoothstep(0.6, 0.8, A.z * 0.6 + tn(p * vec2f(0.02, 0.15), 0.15).y * 0.5);
    var li = mix(vec3f(0.07, 0.13, 0.16), vec3f(0.15, 0.25, 0.29), A.w);
    li = mix(li, vec3f(0.55, 0.66, 0.74), crack * 0.8);
    li = mix(li, vec3f(0.34, 0.46, 0.54), smoothstep(0.86, 0.66, lake) * 0.6); // milky near the shore
    li = mix(li, snow * 0.92, max(drift * 0.9, press * 0.85));
    m.alb = mix(m.alb, li, k);
    m.alb = mix(m.alb, snow * 1.02, shore);
    m.spec = mix(m.spec, mix(0.03, 0.02, drift), k);
    m.rough = mix(m.rough, mix(0.38, 0.7, drift), k);
    m.gx *= 1.0 - k; m.gz *= 1.0 - k;
    m.bump *= 1.0 - k;
    m.snow = mix(m.snow, max(drift, press), k);
    m.wet = k * (1.0 - drift) * 0.3;
  }
  return m;
}

fn desertMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, far: f32, wz: f32, low: f32, flood: f32, chan: f32, rd: f32, relief: f32, rt: vec2f, dv: vec3f) -> Mat {
  var m: Mat;
  let o = 2u * BK;
  let sand = W.bp[o + B_GROUND].rgb;
  let reg = W.bp[o + B_GROUND_ALT].rgb;
  let rockC = W.bp[o + B_ROCK].rgb;
  let floodR = 1.0 - smoothstep(70.0, 240.0, rd);
  let fld = dv.z;
  let A = tn(p * (1.0 / 23.0), 1.0 / 23.0);
  let B = tn(p * 0.55 + vec2f(1.0, 3.0), 0.55);
  let mid = A.x;
  // --- dunes: crisp crest lines and slip faces per pixel (the mesh smooths them out).
  let rdist = mix(d, far, smoothstep(30.0, 46.0, d));
  let Ad = wz * smoothstep(4.0, 45.0, rdist) * (1.0 - floodR) * fld;
  var slip = 0.0;
  var crest = 0.0;
  var fprof = 0.5;
  if (Ad > 0.002) {
    let wv = dv.x; // the warp bends crests slowly (smooth: interpolated from the vertices); its gradient is left out
    let gu = WIND * (1.0 / 78.0);
    let u = dot(p, WIND) * (1.0 / 78.0) + wv;
    let amp = 11.0 * (0.55 + 0.45 * dv.y) * Ad;
    let f = fract(u);
    fprof = f;
    let c = 0.76;
    var dp = 0.0;
    if (f < c) { dp = cos(f * (1.5707963 / c)) * (1.5707963 / c); } else { let t = (f - c) / (1.0 - c); dp = -(0.85 + 0.3 * t) / (1.0 - c); }
    let e = clamp(dist * 0.03, 0.7, 48.0);
    let p0 = duneProfile(f);
    let sx = (duneProfile(fract(u + gu.x * e)) - p0) / e;
    let sz = (duneProfile(fract(u + gu.y * e)) - p0) / e;
    let k = smoothstep(4.0, 1.0, fw * 40.0 * length(gu) * 78.0);
    m.gx = amp * (dp * gu.x - sx) * k;
    m.gz = amp * (dp * gu.y - sz) * k;
    slip = smoothstep(c - 0.005, c + 0.02, f) * Ad;
    crest = smoothstep(c - 0.06, c, f) * smoothstep(c + 0.03, c, f) * Ad;
  }
  // Sand colour: lighter crests, warmer troughs, slip faces a touch darker (looser grains).
  var alb = sand * (0.9 + 0.12 * mid) * mix(vec3f(1.04, 0.98, 0.94), vec3f(0.96, 1.0, 1.05), fprof * Ad);
  alb *= 1.0 - 0.1 * slip;
  alb = mix(alb, sand * 1.08, crest * 0.5);
  // Wind ripples on windward slopes and flats, sinuous (strongly warped), smooth asymmetric
  // profile, weaker on steeper slopes and none on slip faces; faded before they can band.
  let flatK = smoothstep(0.86, 0.97, n.y) * (1.0 - slip) * (1.0 - floodR) * wz;
  let rq = dot(p, WIND) * (1.0 / 0.45) + 2.6 * B.x + 1.2 * tn(p * 2.1, 2.1).y - 0.5 * F.timeFx.z; // ripples creep while time runs
  let rp = fract(rq);
  let rprof = smoothstep(0.0, 0.7, rp) - smoothstep(0.7, 1.0, rp);
  m.bump = (rprof - 0.5) * 0.009 * flatK * smoothstep(0.02, 0.006, fw) * (0.6 + 0.4 * fld);
  let rq2 = dot(p, WIND) * (1.0 / 1.7) + 2.2 * tn(p * 0.23 + vec2f(4.0, 0.0), 0.23).x + 1.0 * B.y;
  let rk = 0.008 * 6.2831853 / 1.7 * cos(rq2 * 6.2831853) * smoothstep(0.12, 0.03, fw) * flatK * (0.5 + 0.5 * smoothstep(0.3, 0.7, B.z));
  m.gx += rk * WIND.x; m.gz += rk * WIND.y;
  // Stony plain (desert pavement): dark varnished pebbles on pale silt, sand in the lows;
  // pebble scatter also collects at the dune bases.
  var peb = 0.0;
  let pebK = max(1.0 - smoothstep(0.55, 0.85, fld), fld * smoothstep(0.25, 0.05, fprof) * smoothstep(0.4, 0.7, B.w) * 0.8);
  if (pebK > 0.01 && fw < 0.02) { peb = smoothstep(0.32, 0.18, vor(p * 2.2).x) * smoothstep(0.02, 0.006, fw) * pebK; }
  if (fld < 0.72) {
    var stony = reg * (0.85 + 0.3 * B.z) * (0.9 + 0.2 * mid);
    stony = mix(stony, reg * vec3f(0.55, 0.5, 0.48), peb * 0.6);
    stony = mix(stony, sand * 0.95, smoothstep(0.5, 0.8, A.y) * 0.6);
    alb = mix(stony, alb, smoothstep(0.15, 0.6, fld + 0.25 * (A.z - 0.5)));
  }
  alb = mix(alb, reg * vec3f(0.6, 0.52, 0.48), peb * fld * 0.5);
  m.bump += peb * 0.008;
  // Mesa walls and hill flanks: banded red sandstone, pale cap rock.
  let steep = smoothstep(0.7, 0.5, n.y);
  let band = 0.88 + 0.12 * sin(wp.y * 0.9 + 2.0 * A.w) + 0.06 * sin(wp.y * 3.1);
  let rock = rockC * band * (0.85 + 0.3 * tn(vec2f(p.x + p.y, wp.y) * 0.2, 0.2).x);
  alb = mix(alb, rock, steep);
  alb = mix(alb, mix(reg, rockC, 0.5), smoothstep(10.0, 22.0, relief) * (1.0 - steep) * 0.6);
  // --- the green river corridor: irrigated plots, palm-grove floor, wet mud banks, water.
  if (flood > 0.003) {
    let fl = flood / max(wz, 1e-3);
    let moist = 1.0 - smoothstep(40.0, 200.0, rd + 50.0 * (A.y - 0.5) - 60.0 * seasonK()); // the flood greens and browns with the seasons
    var green = mix(vec3f(0.19, 0.15, 0.09), vec3f(0.075, 0.115, 0.04), moist * (0.6 + 0.4 * B.w)); // grove floor
    green *= 0.88 + 0.24 * B.z;
    let fa = fieldAtT(p, rd, rt);
    if (fa.x > 0.5) {
      let rowsK = smoothstep(0.03, 0.01, fw);
      let row = 0.5 + 0.5 * sin(fa.y * 7.85 + fa.w * 20.0);
      // Each plot: its crop at its own growth stage, uneven within (thin patches, weeds,
      // a greener damp end), so the corridor reads as tended plots, not tiles.
      let G = tn(p * (1.0 / 7.0) + vec2f(fa.w * 31.0, 0.0), 1.0 / 7.0);
      let patchy = G.x * 0.6 + B.x * 0.4;
      var crop: vec3f;
      if (fa.x < 1.5) { crop = mix(vec3f(0.19, 0.15, 0.09), vec3f(0.12, 0.22, 0.05), 0.35 + 0.4 * row * rowsK + 0.3 * (patchy - 0.5)); }
      else if (fa.x < 2.5) { crop = mix(vec3f(0.07, 0.15, 0.035), vec3f(0.12, 0.22, 0.045), fract(fa.w * 13.1) * 0.6 + patchy * 0.4); }
      else if (fa.x < 3.5) { crop = mix(vec3f(0.30, 0.27, 0.10), vec3f(0.40, 0.34, 0.14), fract(fa.w * 13.1) * 0.6 + patchy * 0.4); crop = mix(crop, vec3f(0.13, 0.2, 0.05), smoothstep(0.62, 0.8, G.y) * 0.6); }
      else { crop = vec3f(0.21, 0.15, 0.10) * (0.8 + 0.3 * row * rowsK); } // ploughed furrows
      crop = mix(crop, crop * vec3f(1.1, 1.0, 0.8) + vec3f(0.03, 0.02, 0.0), smoothstep(0.62, 0.85, patchy) * 0.5);
      // Earth dykes (raised, paler) around plots; irrigation ditches (dark water, wet edges).
      let dyke = 1.0 - smoothstep(0.35, 0.75 + fw * 1.5, fa.z);
      let ditch = 1.0 - smoothstep(0.18, 0.4 + fw * 1.5, fa.z);
      let isD = select(0.0, 1.0, fract(fa.w * 7.3) > 0.55);
      crop = mix(crop, vec3f(0.27, 0.21, 0.14) * (0.85 + 0.3 * mid), dyke * 0.85 * (1.0 - isD * 0.4));
      crop = mix(crop, vec3f(0.05, 0.065, 0.05), ditch * isD);
      green = mix(green, crop, smoothstep(0.0, 0.2, fl));
      m.wet = max(m.wet, ditch * isD * 0.5);
      m.bump += (dyke * 0.04 - ditch * isD * 0.04) * smoothstep(0.08, 0.02, fw);
    }
    // Wet mud margin and the bank: dark and damp near the water, cracking as it dries.
    let bank = 1.0 - smoothstep(14.0, 26.0, rd + 4.0 * (B.y - 0.5));
    let wetM = 1.0 - smoothstep(12.0, 16.5, rd + 2.0 * (B.y - 0.5));
    green = mix(green, vec3f(0.17, 0.13, 0.09) * (0.8 + 0.3 * mid), bank);
    green = mix(green, vec3f(0.09, 0.075, 0.055), wetM);
    alb = mix(alb, green, smoothstep(0.0, 0.25, fl) * (1.0 - smoothstep(190.0, 240.0, rd + 40.0 * (A.z - 0.5))));
    m.wet = max(m.wet, max(bank * 0.35, wetM * 0.8));
  }
  m.alb = alb;
  m.spec = 0.03; m.rough = 0.6;
  // Still water: the terrain is flat at the river's level; the surface is shaded as water.
  let wl = low - 1.2 + 0.35 * seasonK(); // river level rises and falls
  if (chan > 0.02 && wp.y < wl) {
    m.wet = 2.0 * smoothstep(wl, wl - 0.08, wp.y);
  }
  return m;
}


// Temperate forest floor: moss and fern green with leaf-litter patches, grey mossy stone on the
// steep banks; from afar the wooded hills read as deep layered canopy green (the trees themselves
// become sub-pixel), opening into paler glades where props.js leaves clearings.
fn forestMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, hw: f32, relief: f32) -> Mat {
  var m: Mat;
  let o = 3u * BK;
  let moss = W.bp[o + B_GROUND].rgb;
  let litter = W.bp[o + B_GROUND_ALT].rgb;
  let soil = W.bp[o + B_SOIL].rgb;
  let A = tn(p * (1.0 / 31.0), 1.0 / 31.0);
  let B = tn(p * (1.0 / 7.0) + vec2f(3.0, 5.0), 1.0 / 7.0);
  let C = tn(p * 1.3 + vec2f(1.0, 8.0), 1.3);
  var alb = mix(moss * (0.8 + 0.4 * B.x), litter * (0.85 + 0.3 * C.x), smoothstep(0.45, 0.7, A.x * 0.7 + B.y * 0.3));
  alb *= mix(vec3f(0.95, 1.0, 0.9), vec3f(1.08, 1.04, 0.92), C.y);
  { let sK = seasonK(); alb = mix(alb, alb * vec3f(1.35, 1.05, 0.7), 0.35 * max(-sK, 0.0)); } // autumn litter
  let cover = grassCoverL(p, d, hw, tnLod(fw, 1.0 / 4.3));
  alb = mix(soil * (0.75 + 0.3 * B.z), alb, mix(0.35, 1.0, cover));
  // Distant canopy: the glade noise of props.js (dense where it is high).
  let farV = smoothstep(160.0, 900.0, dist);
  if (farV > 0.0) {
    let wood = smoothstep(0.32, 0.5, vnoise(p * (1.0 / 180.0) + vec2f(4.0, 7.0)));
    let crown = mix(vec3f(0.028, 0.06, 0.022), vec3f(0.06, 0.10, 0.035), tn(p * (1.0 / 60.0) + vec2f(9.0, 2.0), 1.0 / 60.0).x);
    alb = mix(alb, crown, farV * mix(0.35, 0.92, wood));
  }
  let steep = smoothstep(0.66, 0.48, n.y);
  let rockC = W.bp[o + B_ROCK].rgb * (0.8 + 0.35 * A.w);
  let mossy = smoothstep(0.4, 0.9, n.y + 0.3 * (B.w - 0.5));
  alb = mix(alb, mix(rockC, moss * 1.1, mossy * 0.6), steep);
  m.alb = alb;
  m.spec = 0.02; m.rough = 0.85;
  return m;
}

// Steppe: pale gold and sage grassland in broad soft bands; bright sheen waves run downwind
// across it (the wind in the grass, far beyond the blades), a few pale stones.
fn steppeMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, hw: f32) -> Mat {
  var m: Mat;
  let o = 4u * BK;
  let gold = W.bp[o + B_GROUND].rgb;
  let sage = W.bp[o + B_GROUND_ALT].rgb;
  let soil = W.bp[o + B_SOIL].rgb;
  let A = tn(p * (1.0 / 260.0), 1.0 / 260.0);
  let B = tn(p * (1.0 / 37.0) + vec2f(2.0, 6.0), 1.0 / 37.0);
  let C = tn(p * 1.1, 1.1);
  var alb = mix(gold, sage, smoothstep(0.35, 0.75, A.x * 0.7 + B.x * 0.3));
  alb *= 0.88 + 0.22 * B.y;
  { let sK = seasonK(); alb = mix(alb, alb * vec3f(0.7, 0.95, 0.6), 0.5 * max(sK, 0.0)); alb = mix(alb, alb * vec3f(1.1, 1.0, 0.85), 0.4 * max(-sK, 0.0)); }
  let cover = grassCoverL(p, d, hw, tnLod(fw, 1.0 / 4.3));
  alb = mix(soil * (0.8 + 0.3 * C.x), alb, mix(0.4, 1.0, cover));
  // Wind sheen: gust bands travelling downwind, visible out to the horizon.
  let wd = vec2f(0.85, 0.5);
  let u = dot(p, wd) * (1.0 / 55.0) + 1.3 * A.y - F.time * 0.9;
  let gust = smoothstep(0.55, 1.0, sin(u) * 0.5 + 0.5) * smoothstep(0.3, 0.7, tn(p * (1.0 / 120.0) - wd * F.time * 0.6 / 120.0, 1.0 / 120.0).z);
  alb *= 1.0 + 0.22 * gust * smoothstep(8.0, 60.0, dist);
  let steep = smoothstep(0.7, 0.5, n.y);
  let rock = W.bp[o + B_ROCK].rgb * (0.85 + 0.3 * B.w);
  alb = mix(alb, rock, max(steep, smoothstep(0.8, 0.86, C.w * 0.5 + B.z * 0.5) * 0.7));
  m.alb = alb;
  m.spec = 0.02; m.rough = 0.8;
  return m;
}

// Mountains: alpine meadow on the valley floor and lower slopes, scree fans, blue-grey granite
// faces with strata, snow above a ragged line that holds on the gentler slopes and gullies.
fn mountainMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, hw: f32, relief: f32) -> Mat {
  var m: Mat;
  let o = 5u * BK;
  let meadow = W.bp[o + B_GROUND].rgb;
  let turf = W.bp[o + B_GROUND_ALT].rgb;
  let gravel = W.bp[o + B_SOIL].rgb;
  let rockC = W.bp[o + B_ROCK].rgb;
  let snowC = W.bp[o + B_COVER].rgb;
  let A = tn(p * (1.0 / 90.0), 1.0 / 90.0);
  let B = tn(p * (1.0 / 17.0) + vec2f(4.0, 1.0), 1.0 / 17.0);
  let C = tn(p * 0.9 + vec2f(8.0, 3.0), 0.9);
  var alb = mix(meadow * (0.85 + 0.3 * B.x), turf, smoothstep(0.5, 0.8, A.x * 0.6 + B.y * 0.4) * 0.7);
  { let sK = seasonK(); alb = mix(alb, alb * vec3f(1.35, 1.1, 0.7), 0.4 * max(-sK, 0.0)); }
  let cover = grassCoverL(p, d, hw, tnLod(fw, 1.0 / 4.3));
  alb = mix(gravel * (0.8 + 0.3 * C.x), alb, mix(0.4, 1.0, cover));
  let hi = smoothstep(20.0, 160.0, relief);
  let slope = 1.0 - n.y;
  // Scree: grey-brown gravel fans on the middle slopes.
  let scree = hi * smoothstep(0.12, 0.3, slope + 0.15 * (A.y - 0.5)) * (1.0 - smoothstep(0.45, 0.6, slope));
  alb = mix(alb, gravel * (0.75 + 0.45 * B.z) * (0.9 + 0.2 * C.y), scree * 0.85);
  // Rock faces with strata.
  let face = smoothstep(0.32, 0.5, slope + 0.1 * (B.w - 0.5));
  let strata = 0.85 + 0.15 * sin(wp.y * 0.35 + 3.0 * A.z) + 0.08 * sin(wp.y * 1.7 + 5.0 * B.x);
  let rock = rockC * strata * (0.8 + 0.35 * tn(vec2f(p.x + p.y, wp.y) * 0.05, 0.05).x);
  alb = mix(alb, rock, max(face, hi * smoothstep(0.75, 0.9, A.w) * 0.6));
  // Snow line (rises and falls with the seasons and ages): lies where the slope lets it.
  let line = 300.0 + 90.0 * (A.x - 0.5) + 40.0 * seasonK() - 30.0 * iceAgeK();
  let sn = smoothstep(line - 25.0, line + 25.0, relief + 50.0 * (B.y - 0.5)) * (1.0 - smoothstep(0.38, 0.55, slope + 0.15 * (C.z - 0.5)));
  alb = mix(alb, snowC * (0.95 + 0.06 * B.x), sn);
  m.alb = alb;
  m.snow = sn;
  m.spec = mix(0.025, 0.03, sn); m.rough = mix(0.8, 0.7, sn);
  return m;
}

// Coast: marram dunes inland, a pale beach and wet sand at the water line, limestone cliffs.
// The sea itself is flagged with wet = 3 (shaded as open water by the caller).
fn coastMat(p: vec2f, wp: vec3f, n: vec3f, dist: f32, fw: f32, d: f32, hw: f32, far: f32, sea: f32) -> Mat {
  var m: Mat;
  let o = 6u * BK;
  let dune = W.bp[o + B_GROUND].rgb;
  let sand = W.bp[o + B_GROUND_ALT].rgb;
  let soil = W.bp[o + B_SOIL].rgb;
  let rockC = W.bp[o + B_ROCK].rgb;
  let A = tn(p * (1.0 / 45.0), 1.0 / 45.0);
  let B = tn(p * (1.0 / 9.0) + vec2f(6.0, 2.0), 1.0 / 9.0);
  let C = tn(p * 1.4 + vec2f(2.0, 2.0), 1.4);
  let above = wp.y - W.sea.x;
  var alb = dune * (0.85 + 0.3 * B.x) * mix(vec3f(1.0), vec3f(1.08, 1.02, 0.9), A.y);
  let cover = grassCoverL(p, d, hw, tnLod(fw, 1.0 / 4.3));
  alb = mix(sand * (0.9 + 0.15 * C.x), alb, cover * smoothstep(0.12, 0.4, A.x + 0.1 * (B.y - 0.5)));
  // Beach toward the water: dry pale sand, then darker wet sand at the waterline.
  let beach = 1.0 - smoothstep(1.5, 4.5, above + 1.5 * (A.z - 0.5));
  alb = mix(alb, sand * (0.95 + 0.1 * C.y), beach);
  let wetK = 1.0 - smoothstep(0.15, 0.6, above);
  alb = mix(alb, sand * vec3f(0.55, 0.52, 0.5), wetK * sea);
  m.wet = wetK * 0.6 * sea;
  // Cliffs: pale limestone in horizontal beds.
  let steep = smoothstep(0.7, 0.5, n.y);
  let beds = 0.86 + 0.14 * sin(wp.y * 1.3 + 2.0 * A.w) + 0.06 * sin(wp.y * 4.1);
  alb = mix(alb, rockC * beds * (0.85 + 0.25 * B.z), steep);
  m.alb = alb;
  m.spec = 0.025; m.rough = mix(0.8, 0.5, m.wet);
  if (sea > 0.3 && above < 0.0) { m.wet = 3.0; }
  return m;
}

// Profiling (?tdbg=N, compiled out otherwise): 1 flat colour (vertex + raster cost only),
// 6 no lighting, 7 no materials, 8 no road surface.
override TDBG: u32 = 0u;
// Biome materials compiled into this variant (bit b = biome b: 1 savannah, 2 ice, 4 desert,
// 8 forest, 16 steppe, 32 mountains, 64 coast). A variant with fewer biomes is a much smaller
// shader (better occupancy); updateTerrain() picks the one the view needs (built on demand).
override BMASK: u32 = 127u;
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  if (TDBG == 1u) { return vec4f(i.n * 0.5 + 0.5, 1.0); }
  let p = i.wp.xz;
  GDX = dpdx(p); GDY = dpdy(p);
  let fwv = abs(GDX) + abs(GDY);
  let fw = max(fwv.x, fwv.y);
  FWMIN = max(min(length(GDX), length(GDY)) * 1.4, max(length(GDX), length(GDY)) * 0.18);
  let dist = distance(i.wp, F.camPos);
  let f = nearField(p);
  let surf = surfAt(f.w);
  let hw = halfWidth(surf);
  var n = normalize(i.n);
  // Colour weights: the shape blends smoothly, but materials meet in a patchy, noise-broken
  // border (snow patches, sand tongues) instead of a cross-fade.
  let wm = matWL(p, BW(i.w, i.v), tnLod(fw, 0.21));
  let w = wm.a;
  let v = wm.b;

  var mt: Mat;
  mt.alb = vec3f(0.0); mt.spec = 0.0; mt.rough = 0.0; mt.gx = 0.0; mt.gz = 0.0; mt.bump = 0.0; mt.wet = 0.0; mt.snow = 0.0;
  if (TDBG == 7u) { mt.alb = vec3f(0.3); mt.rough = 0.7; mt.spec = 0.02; } else {
  if ((BMASK & 1u) != 0u && w.x > 0.01) {
    let a = savannahMat(p, i.wp, n, dist, fw, f.x, hw, i.aux2.y);
    mt.alb += a.alb * w.x; mt.spec += a.spec * w.x; mt.rough += a.rough * w.x;
  }
  if ((BMASK & 2u) != 0u && w.y > 0.01) {
    let a = iceMat(p, i.wp, n, dist, fw, f.x, hw, i.aux.x, i.aux.w, i.aux2.y, i.aux3.x, i.aux3.y);
    mt.alb += a.alb * w.y; mt.spec += a.spec * w.y; mt.rough += a.rough * w.y;
    mt.gx += a.gx * w.y; mt.gz += a.gz * w.y;
    mt.bump += a.bump * w.y; mt.wet += a.wet * w.y; mt.snow += a.snow * w.y;
  }
  if ((BMASK & 4u) != 0u && w.z > 0.01) {
    let a = desertMat(p, i.wp, n, dist, fw, f.x, i.aux4.y, i.w.z / max(i.w.x + i.w.y + i.w.z, 1e-4), i.aux.x, i.aux.y, i.aux.z, i.aux2.x, i.aux2.y, i.aux3.zw, i.aux5);
    mt.alb += a.alb * w.z; mt.spec += a.spec * w.z; mt.rough += a.rough * w.z;
    mt.gx += a.gx; mt.gz += a.gz; mt.bump += a.bump * w.z; mt.wet = max(mt.wet, a.wet);
  }
  if ((BMASK & 8u) != 0u && v.x > 0.01) {
    let a = forestMat(p, i.wp, n, dist, fw, f.x, hw, i.aux2.y);
    mt.alb += a.alb * v.x; mt.spec += a.spec * v.x; mt.rough += a.rough * v.x;
  }
  if ((BMASK & 16u) != 0u && v.y > 0.01) {
    let a = steppeMat(p, i.wp, n, dist, fw, f.x, hw);
    mt.alb += a.alb * v.y; mt.spec += a.spec * v.y; mt.rough += a.rough * v.y;
  }
  if ((BMASK & 32u) != 0u && v.z > 0.01) {
    let a = mountainMat(p, i.wp, n, dist, fw, f.x, hw, i.aux2.y);
    mt.alb += a.alb * v.z; mt.spec += a.spec * v.z; mt.rough += a.rough * v.z; mt.snow += a.snow * v.z;
  }
  if ((BMASK & 64u) != 0u && v.w > 0.01) {
    let a = coastMat(p, i.wp, n, dist, fw, f.x, hw, i.aux4.y, i.aux6.x);
    mt.alb += a.alb * v.w; mt.spec += a.spec * v.w; mt.rough += a.rough * v.w;
    mt.wet = select(max(mt.wet, a.wet * v.w), 3.0, a.wet > 2.5);
  }
  }
  var alb = mt.alb;

  // --- road
  var bump = mt.bump;
  if (f.x < hw + 1.8 && TDBG != 8u) {
    let sandR = max(i.aux4.x, 0.75 * i.aux6.y);
    var rm = roadMaterialW(p, f.x, f.w, surf, hw, fw, wm, vec3f(1.0 - i.aux3.x - sandR, i.aux3.x, sandR));
    rm.cover *= 1.0 - bridgeCut(i.aux.z); // under a bridge: river bed
    rm.cover *= 1.0 - smoothstep(0.8, 2.0, i.wp.y - f.y); // a closed passage's plateau over the road
    // Worn verge: compacted, slightly darker earth (mud in the irrigated corridor), broken up
    // so it never reads as a uniform pale feather along the road.
    let shc = mix(rm.shoulder, vec3f(0.15, 0.115, 0.075), saturate(i.aux.y * 4.0));
    let vn = tn(p * 0.7, 0.7);
    let sh = smoothstep(hw + 1.3, hw + 0.1, f.x + 0.6 * (vn.x - 0.5)) * (1.0 - rm.cover) * (0.55 + 0.45 * vn.y);
    alb = mix(alb, mix(alb, shc * 0.85, 0.6), sh);
    alb = mix(alb, rm.alb, rm.cover);
    bump = mix(bump, rm.bump, rm.cover);
    mt.spec = mix(mt.spec, rm.spec, rm.cover); mt.rough = mix(mt.rough, rm.rough, rm.cover);
    mt.gx *= 1.0 - rm.cover; mt.gz *= 1.0 - rm.cover;
    mt.wet *= 1.0 - smoothstep(0.0, 0.5, rm.cover);
    // Little snow sky-fill on the road: the packed lane must read darker than the snowfield,
    // and a desert or earth road gets none.
    mt.snow *= 1.0 - rm.cover * mix(1.0, 0.85, smoothstep(0.62, 0.86, i.aux3.x));
  }
  // Per-pixel slope detail (dune crests, snow waves) on the mesh normal.
  if (abs(mt.gx) + abs(mt.gz) > 0.0) {
    let hg = vec2f(-n.x, -n.z) / max(n.y, 0.2) + vec2f(mt.gx, mt.gz);
    n = normalize(vec3f(-hg.x, 1.0, -hg.y));
  }
  // Fine bump (road grain, ripples, ruts), faded out before it can alias.
  let bh = bump * smoothstep(0.03, 0.008, fw);
  let dpx = dpdx(i.wp);
  let dpy = dpdy(i.wp);
  let r1 = cross(dpy, n);
  let r2 = cross(n, dpx);
  let det = dot(dpx, r1);
  let grad = sign(det) * (dpdx(bh) * r1 + dpdy(bh) * r2);
  n = normalize(abs(det) * n - grad);

  var col: vec3f;
  if (TDBG == 6u) { return vec4f(alb + n * 0.01, 1.0); }
  if (mt.wet > 2.5) {
    col = shadeSea(i.wp, dist, fw);
  } else if (mt.wet > 1.0) {
    col = shadeWaterR(i.wp, dist, fw, w, i.aux2.x + riverBank(p) * 0.5);
  } else {
    // Inside a passage (world.js tunnelIn): daylight falls off from the portals, the lamps
    // light pools on the floor.
    let ti = tunnelIn(i.wp);
    let ao = 1.0 - 0.6 * ti.x;
    col = shadeSurfP(alb * (1.0 - 0.35 * mt.wet), n, i.wp, ao, mt.spec + 0.03 * mt.wet, mt.rough * (1.0 - 0.4 * mt.wet), mt.snow * 0.6, fw);
    // Snow is lit by the whole sky and by other snow: shaded snow stays bright and cyan
    // (never grey), so the low sun's self-shadowing reads as soft blue, not dirt.
    if (mt.snow > 0.0) {
      let lit = saturate(dot(n, F.sunDir) * 2.0);
      col += alb * (probeSkyUp() * vec3f(0.7, 0.92, 1.2) * 0.5 + probeSun() * vec3f(0.5, 0.68, 0.92) * 0.016) * mt.snow * (1.0 - 0.6 * lit);
    }
    if (ti.x + ti.y > 0.0) {
      col *= 1.0 - 0.93 * ti.x;
      let lc = select(select(vec3f(1.0, 0.62, 0.3), vec3f(1.0, 0.84, 0.58), ti.z > 3.5), vec3f(0.86, 0.93, 1.0), ti.z > 5.5);
      col += alb * lc * ti.y * 0.9;
    }
  }
  // The land-bridge strait thaws into open water (sites.js sets strait2.z from the clock).
  if (W.strait2.z > 0.0 && W.strait2.x > 0.0) {
    let smw = straitAt(p) * smoothstep(hw + 0.5, hw + 3.0, f.x);
    if (smw > 0.45) { col = mix(col, shadeWater(i.wp, dist, fw, w), W.strait2.z * smoothstep(0.45, 0.6, smw)); }
  }
  // Contact shadow under the car: tight occlusion beneath the chassis and at the tyres, so
  // the car sits on the ground whatever the sun angle.
  let cr = p - W.car.xz;
  if (dot(cr, cr) < 16.0 && W.cam.w < 0.5) {
    let lx = dot(cr, W.pad0.yz);
    let lz = dot(cr, vec2f(-W.pad0.z, W.pad0.y));
    let body = 1.0 - smoothstep(0.45, 1.05, length(vec2f(lx / 2.2, lz / 1.0)));
    let qx = abs(lx) - 1.3;
    let qz = abs(lz) - 0.8;
    let tyre = 1.0 - smoothstep(0.02, 0.38, length(vec2f(qx * 0.55, qz)));
    col *= (1.0 - 0.55 * body) * (1.0 - 0.7 * tyre);
  }
  if (W.pad0.x > 0.5) { col = i.w * 2.0 + vec3f(0.2, 0.8, 0.1) * i.v.x + vec3f(1.6, 1.4, 0.4) * i.v.y + vec3f(0.8) * i.v.z + vec3f(0.0, 0.6, 1.6) * i.v.w; } // ?bdbg=1
  col = applyFog(col, i.wp);
  return vec4f(col, 1.0);
}
`;

const SHADOW_WGSL = SHADOW_HEADER + TERRAIN_COMMON + /* wgsl */ `
@vertex fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let p = tilePos(vi, ii);
  return F.lightViewProj * vec4f(p.x, groundH(p), p.y, 1.0);
}
`;

let pipeShadow, ibuf, bgMain, bgShadow, bgShadow1, tileBuf;
const pipeVar = new Array(128).fill(null); // by biome mask; 127 = all
let mask = 127;

export async function initTerrain(seed) {
  const d = gpu.device;
  const idx = new Uint16Array(GRID * GRID * 6);
  let o = 0;
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const a = z * NV + x, b = a + 1, c = a + NV, e = c + 1;
    // Alternate the diagonal for a less directional mesh.
    if ((x + z) & 1) { idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = e; }
    else { idx[o++] = a; idx[o++] = c; idx[o++] = e; idx[o++] = a; idx[o++] = e; idx[o++] = b; }
  }
  ibuf = d.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ibuf, 0, idx);
  tileBuf = d.createBuffer({ size: tileData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const bgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } }] });
  bgMain = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: tileBuf, offset: 0, size: MAXT * 16 } }] });
  bgShadow = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: tileBuf, offset: MAXT * 16, size: MAXT * 16 } }] });
  bgShadow1 = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: tileBuf, offset: MAXT * 32, size: MAXT * 16 } }] });
  const constants = { SEED: seed };
  const tdbg = /[?&]tdbg=(\d+)/.exec(location.search);
  const layouts = [world.bgl, bgl];
  await world.probeReady;
  const mainMod = d.createShaderModule({ label: 'terrain', code: MAIN_WGSL });
  const shMod = d.createShaderModule({ label: 'terrain-sh', code: SHADOW_WGSL });
  const variant = (m) => mainPipeline({ label: 'terrain-' + m, module: mainMod, layouts, constants: { SEED: seed, BMASK: m, TDBG: tdbg ? +tdbg[1] : 0 } }).then((p) => { pipeVar[m] = p; });
  [, pipeShadow] = await Promise.all([
    variant(127),
    shadowPipeline({ label: 'terrain-sh', module: shMod, vertex: 'vsShadow', layouts, constants, cullMode: 'back' }),
  ]);
  // Every single-biome and two-biome variant is built at load (behind the start screen), so
  // nothing compiles while driving; a view holding three or more biomes uses the full one.
  const all = [];
  for (let a = 0; a < 7; a++) for (let b = a; b < 7; b++) all.push(variant((1 << a) | (1 << b)));
  await Promise.all(all);
  // Warm-up: the first draw with a pipeline still costs the GPU a one-off setup (it showed as a
  // single 25 ms frame at the first fork into a new biome mix), so every variant draws one tile
  // into a tiny offscreen target on the first frames, behind the start screen.
  const wt = d.createTexture({ size: [8, 8], format: gpu.hdrFormat, sampleCount: gpu.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const wd = d.createTexture({ size: [8, 8], format: gpu.depthFormat, sampleCount: gpu.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const warmPass = { colorAttachments: [{ view: wt.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    depthStencilAttachment: { view: wd.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' } };
  let warmLeft = 3;
  addPrePass({ pre(enc) {
    if (warmLeft === 0) { warmLeft = -1; wt.destroy(); wd.destroy(); } // a frame after the last use
    if (warmLeft <= 0 || !nMain) return;
    warmLeft--;
    const p = enc.beginRenderPass(warmPass);
    p.setBindGroup(0, gpu.mainBG); p.setBindGroup(1, world.bg); p.setBindGroup(2, bgMain); p.setIndexBuffer(ibuf, 'uint16');
    for (let m = 1; m < 128; m++) if (pipeVar[m]) { p.setPipeline(pipeVar[m]); p.drawIndexed(GRID * GRID * 6, 1); }
    p.end();
  } });
  const HIDE = /[?&]hide=[^&]*terrain/.test(location.search); // debug: ?hide=...
  if (!HIDE) addDrawable({
    shadow(p) {
      const far = gpu.cascade === 1;
      const n = far ? nShadow1 : nShadow;
      if (!n) return;
      p.setPipeline(pipeShadow); p.setBindGroup(1, world.bg); p.setBindGroup(2, far ? bgShadow1 : bgShadow);
      p.setIndexBuffer(ibuf, 'uint16'); p.drawIndexed(GRID * GRID * 6, n);
    },
    main(p) {
      p.setPipeline(pipeVar[mask] || pipeVar[127]); p.setBindGroup(1, world.bg); p.setBindGroup(2, bgMain);
      p.setIndexBuffer(ibuf, 'uint16'); p.drawIndexed(GRID * GRID * 6, nMain);
    },
  });
}

// --- CDLOD selection. Node coordinates are integers in LEAF units (Smis), so the recursion
// passes no doubles (V8 would box them).

const SEL = new Float64Array(6); // camera x, z, shadow centre x, z, shadow radius^2 (padded)
import { lightCenter } from '../camera.js';

// Frustum test of the node's box (y range is conservative).
const P0 = 32; // worldData offset of the planes (vec4 slot 8)
function inFrustum(ix, iz, n) {
  const x = ix * LEAF, z = iz * LEAF, s = n * LEAF;
  const w = worldData;
  for (let i = 0; i < 5; i++) {
    const o = P0 + i * 4;
    const a = w[o], b = w[o + 1], c = w[o + 2], d = w[o + 3];
    const px = a > 0 ? x + s : x, py = b > 0 ? 900 : -150, pz = c > 0 ? z + s : z;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

function add(ix, iz, n, lod) {
  const x = ix * LEAF, z = iz * LEAF, s = n * LEAF;
  if (nMain < MAXT && inFrustum(ix, iz, n)) {
    const o = nMain * 4;
    tileData[o] = x; tileData[o + 1] = z; tileData[o + 2] = s; tileData[o + 3] = lod;
    nMain++;
  }
  // Shadow list: tiles overlapping a padded square around the shadow centre.
  const dx = Math.max(x - SEL[2], 0, SEL[2] - (x + s)), dz = Math.max(z - SEL[3], 0, SEL[3] - (z + s));
  if (nShadow < MAXT && dx * dx + dz * dz < SEL[4]) {
    const o = (MAXT + nShadow) * 4;
    tileData[o] = x; tileData[o + 1] = z; tileData[o + 2] = s; tileData[o + 3] = lod;
    nShadow++;
  }
}

// Distance from the camera to the node rectangle, compared against a range (no double
// return values: the comparison happens here).
function farther(ix, iz, n, range) {
  const x = ix * LEAF, z = iz * LEAF, s = n * LEAF;
  const dx = Math.max(x - SEL[0], 0, SEL[0] - (x + s));
  const dz = Math.max(z - SEL[1], 0, SEL[1] - (z + s));
  return dx * dx + dz * dz > ranges[range] * ranges[range];
}

function select(ix, iz, n, lod) {
  if (farther(ix, iz, n, lod)) return false;
  if (lod === 0 || farther(ix, iz, n, lod - 1)) { add(ix, iz, n, lod); return true; }
  const h = n >> 1;
  for (let q = 0; q < 4; q++) {
    const qx = ix + (q & 1) * h, qz = iz + (q >> 1) * h;
    // A quadrant outside the finer range is drawn as a finer tile that is fully morphed
    // to this lod's grid (so it matches its neighbours exactly).
    if (!select(qx, qz, h, lod - 1)) add(qx, qz, h, lod - 1);
  }
  return true;
}

// Which biome materials the view needs: biome weights (as the GPU's biomeW) sampled over the
// visible ground, out to the far relief. A biome counts when its weight anywhere exceeds 0.1
// (below that matW never lets its material through). Re-evaluated every 4th frame; the
// full variant is used while anything is mixed.
const VQ = new Float64Array(10);
const VM = new Float64Array(7);
const VDIST = new Float64Array([6, 25, 70, 160, 350, 700, 1300, 2400, 4000]);
let vFrame = 0;
const FORCE_VAR = typeof location !== 'undefined' && /[?&]tvar=(\d+)/.test(location.search) ? +/[?&]tvar=(\d+)/.exec(location.search)[1] : 0;
function pickVariant() {
  if (FORCE_VAR) { mask = FORCE_VAR; return; }
  const ex = camera.eye[0], ez = camera.eye[2];
  let fx = camera.target[0] - ex, fz = camera.target[2] - ez;
  const fl = Math.sqrt(fx * fx + fz * fz) || 1; fx /= fl; fz /= fl;
  for (let b = 0; b < 7; b++) VM[b] = 0;
  for (let a = -4; a <= 4; a++) {
    const ang = a * 0.2, c = Math.cos(ang), sn = Math.sin(ang);
    const dx = fx * c - fz * sn, dz = fx * sn + fz * c;
    for (let k = 0; k < VDIST.length; k++) {
      VQ[0] = ex + dx * VDIST[k]; VQ[1] = ez + dz * VDIST[k];
      biomeAt(VQ);
      for (let b = 0; b < 7; b++) if (VQ[2 + b] > VM[b]) VM[b] = VQ[2 + b];
    }
  }
  let m = 0;
  for (let b = 0; b < 7; b++) if (VM[b] > 0.1) m |= 1 << b;
  if (m === 0) m = 127;
  const m2 = m & (m - 1);
  if ((m2 & (m2 - 1)) !== 0 || !pipeVar[m]) m = 127; // three or more biomes (or not built)
  mask = m;
}
export function terrainVariant() { return mask; }

// Selects tiles for the current camera; uploads both lists.
export function updateTerrain() {
  if ((vFrame++ & 3) === 0 || state.pose >= 0 || state.capture) pickVariant();
  SEL[0] = camera.eye[0]; SEL[1] = camera.eye[2];
  SEL[2] = lightCenter[0]; SEL[3] = lightCenter[2];
  const shR = camera.shadowRadius * 1.45;
  SEL[4] = shR * shR;
  nMain = 0; nShadow = 0;
  const R = ranges[LODS - 1];
  const RN = ROOT / LEAF; // root size in LEAF units
  const x0 = Math.floor((SEL[0] - R) / ROOT), x1 = Math.floor((SEL[0] + R) / ROOT);
  const z0 = Math.floor((SEL[1] - R) / ROOT), z1 = Math.floor((SEL[1] + R) / ROOT);
  for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) select(gx * RN, gz * RN, RN, LODS - 1);
  const q = gpu.device.queue;
  if (nMain) q.writeBuffer(tileBuf, 0, tileData, 0, nMain * 4);
  if (nShadow) q.writeBuffer(tileBuf, MAXT * 16, tileData, MAXT * 4, nShadow * 4);
  if (gpu.shadow1Now) {
    // Far cascade casters: a uniform grid of coarse tiles over its square.
    const T = LEAF << SH1_TILE_LOD, R = gpu.shadow1Radius + 300;
    const cx = shadow1.center[0], cz = shadow1.center[1];
    const x0 = Math.floor((cx - R) / T), x1 = Math.floor((cx + R) / T);
    const z0 = Math.floor((cz - R) / T), z1 = Math.floor((cz + R) / T);
    nShadow1 = 0;
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      if (nShadow1 >= MAXT) break;
      const o = (MAXT * 2 + nShadow1) * 4;
      tileData[o] = gx * T; tileData[o + 1] = gz * T; tileData[o + 2] = T; tileData[o + 3] = SH1_TILE_LOD;
      nShadow1++;
    }
    q.writeBuffer(tileBuf, MAXT * 32, tileData, MAXT * 8, nShadow1 * 4);
  }
}
export function terrainStats() { return nMain; }
