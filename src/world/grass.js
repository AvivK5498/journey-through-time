// Savannah grass. Every frame a compute pass scatters blades on a world-anchored grid
// around the camera (so blades never swim), culls them to the view frustum, thins them with
// distance (continuous density, blades near the threshold shrink instead of popping) and
// appends survivors to an instance buffer drawn with drawIndirect. Blade height, density and
// colour come from the biome blend; none grow on the road or its worn shoulders.

import { gpu, tsw, addDrawable, addPrePass, mainPipeline, timing } from '../gpu.js';
import { MAIN_HEADER, FRAME_STRUCT } from '../shaders/common.js';
import { camera } from '../camera.js';
import { WORLD_WGSL, world } from './world.js';

const MAXB = 420000;
const SEGS = 4; // blade segments -> 2 * SEGS + 1 strip vertices
// Tiers: cell size (m), inner radius, outer radius.
const TIERS = [[0.13, 0, 28], [0.2, 28, 80], [0.42, 80, 230]];
const RHO0 = 58, RHO_R = 22; // blades/m^2 at the camera, falloff radius

const tierData = new Int32Array(8 * TIERS.length);
const tierF = new Float32Array(tierData.buffer);
const argsInit = new Uint32Array([2 * SEGS + 1, 0, 0, 0]);
const dispatch = new Uint32Array(TIERS.length * 2);

const GRASS_COMMON = /* wgsl */ `
struct Blade { a: vec4f, b: vec4f }; // a: pos.xyz, yaw   b: height, width, lean, type + hue
// Blade types: 0 savannah grass, 1 ice-age tuft, 2 desert tuft, 3 reed, 4 green crop, 5 ripe crop,
// 6 fern (forest), 7 feather grass (steppe), 8 alpine turf (mountains), 9 marram (coast).
// Colour row (biome) of a blade type.
fn typeRow(typ: u32) -> u32 {
  if (typ < 3u) { return typ; }
  if (typ < 6u) { return 2u; }
  return typ - 3u;
}

`;

const COMPUTE_WGSL = FRAME_STRUCT + WORLD_WGSL + GRASS_COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
struct Tier { origin: vec2i, dims: vec2i, cell: f32, r0: f32, r1: f32, salt: u32 };
@group(2) @binding(0) var<uniform> T: Tier;
@group(2) @binding(1) var<storage, read_write> blades: array<Blade>;
@group(2) @binding(2) var<storage, read_write> args: array<atomic<u32>, 4>;

const RHO0: f32 = ${RHO0}.0;
const RHO_R: f32 = ${RHO_R}.0;

fn hf(h: u32, k: u32) -> f32 { return f32(hashU(h, k) >> 8u) * (1.0 / 16777216.0); }

@compute @workgroup_size(8, 8) fn place(@builtin(global_invocation_id) id: vec3u) {
  if (i32(id.x) >= T.dims.x || i32(id.y) >= T.dims.y) { return; }
  let ci = T.origin + vec2i(id.xy);
  let h = hashU(bitcast<u32>(ci.x) ^ T.salt, bitcast<u32>(ci.y));
  let p = (vec2f(ci) + vec2f(hf(h, 1u), hf(h, 2u))) * T.cell;
  let r = distance(p, W.cam.xz);
  if (r < T.r0 || r >= T.r1) { return; }
  // Density with distance; keep with probability rho * cell^2. The densest type sets the
  // candidate density; the biome / type thins it below.
  let rho = RHO0 * RHO_R * RHO_R / (RHO_R * RHO_R + r * r);
  let keep = rho * T.cell * T.cell;
  let u = hf(h, 3u);
  if (u > keep) { return; }
  // Frustum (vertical extent unknown yet: test a tall column around the camera height).
  let rad = 2.0;
  for (var i = 0; i < 5; i++) {
    let pl = W.planes[i];
    let yy = select(W.cam.y - 60.0, W.cam.y + 8.0, pl.y > 0.0);
    if (dot(pl.xyz, vec3f(p.x, yy, p.y)) + pl.w < -rad) { return; }
  }
  let g = ground(p);
  // Pick this blade's biome by the local weights.
  // Same patchy material border as the terrain, so blades match the ground they grow on.
  let mw = matW(p, BW(g.w, g.v));
  let ub = hf(h, 10u);
  let bi = bwPick(mw, ub);
  let gp = W.bp[bi * BK + B_GRASS];
  var cover = 0.0;
  var typ = f32(bi);
  var hmul = 1.0;
  var wmul = 1.0;
  let roadside = smoothstep(g.hw + 0.3, g.hw + 4.0, g.d);
  if (bi == 0u) {
    // Toward the ice the savannah grass thins out and shortens (the steppe-tundra margin).
    let wiR = biomeWRaw(p).a.y;
    cover = grassCover(p, g.d, g.hw) * gp.y * (1.0 - 0.85 * smoothstep(0.08, 0.5, wiR));
    hmul = 1.0 - 0.45 * smoothstep(0.05, 0.4, wiR);
  } else if (bi == 1u) {
    // Sedge tussocks grow on the bare tundra (same field as the terrain's snow cover), in
    // clumps with gaps; a few poke through thin snow at a patch edge; none in deep snow.
    let sv = iceSnowV(p, biomeWRaw(p).a.y, g.h - g.low);
    let bare = smoothstep(0.12, -0.25, sv);
    let tuss = smoothstep(0.58, 0.74, vnoise(p * 1.7 + vec2f(3.0, 3.0)));
    let patchy = smoothstep(0.3, 0.7, vnoise(p * 0.13 + vec2f(1.0, 8.0)));
    cover = tuss * (0.3 + 0.9 * patchy) * max(bare, 0.25) * smoothstep(16.0, 6.0, g.d) * gp.y * 3.0 * (1.0 - saturate(g.lake * 3.0)); // sparse golden tufts near the road only
    cover *= smoothstep(g.hw + 0.6, g.hw + 2.5, g.d);
    hmul = (0.55 + 0.5 * tuss) * mix(0.6, 1.0, bare);
  } else if (bi == 3u) {
    // Forest floor: fern clumps in patches and a low leafy undergrowth; thin on the litter.
    let patchy = smoothstep(0.35, 0.65, vnoise(p * (1.0 / 9.0) + vec2f(2.0, 4.0)));
    cover = gp.y * (0.1 + 0.9 * patchy * patchy) * smoothstep(0.3, 0.6, grassCover(p, g.d, g.hw) + 0.3);
    typ = 6.0; hmul = 0.7 + 0.5 * patchy;
  } else if (bi == 4u) {
    // Steppe: feather grass everywhere, tallest in the hollows.
    cover = grassCover(p, g.d, g.hw) * gp.y;
    typ = 7.0; hmul = 0.85 + 0.3 * smoothstep(0.3, 0.7, vnoise(p * 0.02));
  } else if (bi == 5u) {
    // Mountains: short alpine turf on the valley floor, thinning up the slopes.
    cover = grassCover(p, g.d, g.hw) * gp.y * (1.0 - smoothstep(10.0, 60.0, g.relief));
    typ = 8.0;
  } else if (bi == 6u) {
    // Coast: marram tussocks on the dunes, none on the beach or in the water.
    let tuss = smoothstep(0.45, 0.7, vnoise(p * 0.9 + vec2f(4.0, 2.0)));
    cover = gp.y * tuss * smoothstep(2.5, 5.0, g.h - W.sea.x) * (1.0 - g.sea) * smoothstep(0.2, 0.5, grassCover(p, g.d, g.hw) + 0.2);
    typ = 9.0; hmul = 0.7 + 0.5 * tuss;
  } else {
    // Desert: sparse dry tufts; reed beds on the river banks; crops in the irrigated strips.
    let fl = 1.0 - smoothstep(70.0, 240.0, g.rd);
    let tuss = smoothstep(0.66, 0.8, vnoise(p * 1.8 + vec2f(7.0, 1.0)));
    // On the dune fields tufts only grow in the troughs and at the foot of the slip faces.
    let dfl = duneField(p);
    var trough = 1.0;
    if (dfl > 0.01) {
      let wv = fbm(p * (1.0 / 420.0) + vec2f(5.0, 13.0), 2) * 1.7 + (vnoise(p * (1.0 / 95.0) + vec2f(2.0, 8.0)) - 0.5) * 0.35;
      let fu = fract(dot(p, WIND) * (1.0 / 78.0) + wv);
      trough = mix(1.0, max(1.0 - smoothstep(0.06, 0.22, fu), smoothstep(0.86, 0.97, fu)), dfl);
    }
    cover = gp.y * (0.05 * (1.0 - dfl) + tuss * (2.0 + 6.0 * smoothstep(0.45, 0.8, vnoise(p * 0.05)))) * (1.0 - fl) * (1.0 - 0.6 * dfl) * trough;
    let reedBand = smoothstep(9.0, 13.0, g.rd) * (1.0 - smoothstep(20.0, 30.0, g.rd));
    let reedBed = smoothstep(0.3, 0.55, vnoise(p * (1.0 / 17.0) + vec2f(5.0, 5.0)));
    if (reedBand * reedBed > 0.05 && g.flood > 0.05) {
      cover = reedBand * reedBed * 1.3; typ = 3.0; hmul = 4.6; wmul = 1.7;
    } else {
      let fa = fieldAt(p, g.rd);
      if (fa.x > 0.5 && fa.x < 3.5 && fa.z > 0.8 && g.flood > 0.05) {
        // Crop rows: blades only on the row ridges.
        let row = 0.5 + 0.5 * sin(fa.y * 7.85 + fa.w * 20.0);
        cover = select(1.1, 0.7, fa.x < 1.5) * smoothstep(0.2, 0.6, row); typ = select(4.0, 5.0, fa.x > 2.5);
        hmul = select(1.4, 0.8, fa.x < 1.5); wmul = 1.3;
      } else if (g.flood > 0.05 && fa.x < 0.5) {
        let moist = 1.0 - smoothstep(40.0, 200.0, g.rd);
        cover = max(cover, 0.45 * moist * smoothstep(0.4, 0.7, vnoise(p * 0.3))); typ = 4.0; hmul = 0.6;
      }
    }
    cover *= smoothstep(g.hw + 0.4, g.hw + 2.0, g.d) * (1.0 - saturate(g.chan * 4.0));
  }
  if ((bi == 1u || bi == 2u) && typ < 2.5) { cover *= 0.2; }
  cover *= siteClear(p); // landmark pads, the land-bridge strait
  let sw = sightAt(p); // a landmark's sight wedge: thinner, shorter grass (world.js)
  cover *= 1.0 - 0.45 * sw;
  if (hf(h, 4u) > cover * 1.15) { return; }
  let fade = smoothstep(keep, keep * 0.7, u);
  var hgt = gp.x * hmul * (1.0 - gp.z * 0.5 + gp.z * hf(h, 5u)) * mix(0.3, 1.0, roadside) * mix(0.55, 1.0, saturate(cover));
  // Taller clumps, and broad patches of taller / shorter, sparser / denser stands.
  let patchN = vnoise(p * 0.07 + vec2f(3.0, 8.0));
  hgt *= (0.75 + 0.5 * vnoise(p * 0.45)) * (0.65 + 0.7 * patchN);
  hgt *= fade * (1.0 - 0.5 * sw);
  // Ferns and marram are wide fans of leaves: right in front of the lens one would fill the
  // screen many layers deep (single 20+ ms frames in first person), so they shrink away there.
  if (typ == 6.0 || typ == 9.0) { hgt *= smoothstep(2.5, 7.0, distance(vec3f(p.x, g.h, p.y), W.cam.xyz)); }
  if (hgt < 0.05) { return; }
  let wComp = min(sqrt(RHO0 / rho), 9.0);
  // Ice and desert tufts are bunches: one accepted candidate grows a fan of blades leaning
  // out from a common base.
  let tuft = (typ < 2.5 && typ > 0.5) || typ == 6.0 || typ == 9.0;
  // Far tufts grow fewer, wider blades (same fan coverage): the main pass bins every
  // vertex into the GPU's tiler memory, and a few hundred MB of it stalls the pass for 10-20
  // ms whenever the driver has to re-wire that memory (Metal System Trace: ~2000 128 KiB
  // "Wire Memory" events during a 15-35 ms main-pass vertex phase on every spike frame).
  let nb = select(1u, select(7u, select(4u, 3u, r > 80.0), r > 28.0), tuft);
  let fanW = select(1.0, pow(7.0 / f32(nb), 0.6), tuft);
  let idx0 = atomicAdd(&args[1], nb);
  if (idx0 + nb > ${MAXB}u) { return; }
  for (var k = 0u; k < nb; k++) {
    let a = f32(k) * 2.39996 + hf(h, 12u) * 6.28;
    let off = select(vec2f(0.0), vec2f(cos(a), sin(a)) * 0.05 * hf(h, 20u + k), tuft);
    let hk = hgt * select(1.0, 0.65 + 0.5 * hf(h, 30u + k), tuft);
    let yaw = select(hf(h, 6u) * 6.2831853, a + 1.5708, tuft);
    // Ferns: few wide fronds arching out; marram: stiff narrow leaves.
    let fern = typ == 6.0;
    blades[idx0 + k].a = vec4f(p.x + off.x, g.h - 0.03, p.y + off.y, yaw);
    let wd = (0.022 + 0.018 * hf(h, 7u + k)) * select(wComp, min(wComp, 2.5), tuft) * wmul * select(1.0, 4.5, fern) * fanW;
    let ln = select(select(0.1 + 0.45 * hf(h, 8u), 0.5 + 0.4 * hf(h, 40u + k), tuft), 1.1 + 0.3 * hf(h, 40u + k), fern);
    blades[idx0 + k].b = vec4f(hk, wd, ln, typ + 0.999 * hf(h, 9u + k));
  }
}
`;

const DRAW_WGSL = MAIN_HEADER + WORLD_WGSL + GRASS_COMMON + /* wgsl */ `
@group(2) @binding(0) var<storage, read> blades: array<Blade>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) x: vec3f, // t along blade, hue, side
  @location(3) @interpolate(flat) ty: f32, // blade type
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let bl = blades[ii];
  let base = bl.a.xyz;
  let yaw = bl.a.w;
  let hgt = bl.b.x;
  let wid = bl.b.y;
  let lean = bl.b.z;
  // Segment LOD by distance (${SEGS} near, 2 mid, 1 far): rows past the LOD collapse onto the
  // tip, so their triangles are degenerate and dropped before binning (tiler memory, above).
  let dCam = distance(base, F.camPos);
  let lod = select(select(${SEGS}u, 2u, dCam > 25.0), 1u, dCam > 70.0);
  let rowI = vi / 2u;
  var t = f32(rowI) / f32(lod);
  var side = f32(vi % 2u) - 0.5;
  if (vi == ${2 * SEGS}u || rowI >= lod) { t = 1.0; side = 0.0; }
  let across = vec3f(cos(yaw), 0.0, sin(yaw));
  let fwd = vec3f(-across.z, 0.0, across.x);
  // Wind: slow travelling gusts plus a quicker flutter.
  let windDir = normalize(vec3f(0.85, 0.0, 0.5));
  let ph = dot(base.xz, windDir.xz);
  let gust = 0.55 + 0.45 * sin(ph * 0.06 - F.time * 1.1) * sin(ph * 0.013 - F.time * 0.37 + 1.0);
  let flutter = sin(F.time * 3.3 + base.x * 0.7 + base.z * 0.43) * 0.12;
  let typ = u32(bl.b.w);
  let hue = fract(bl.b.w);
  let row = typeRow(typ) * BK;
  let windAmt = select(W.bp[row + B_GRASS].w, 1.1, typ >= 3u && typ < 6u) * (gust * 0.55 + flutter);
  let bend = t * t;
  // Seed-head blades (and reed plumes) are thicker near the tip.
  let seedAmt = select(W.bp[row + B_GRASS_DRY].w, select(0.25, 0.55, typ == 3u), typ >= 3u && typ < 6u);
  let seed = step(1.0 - seedAmt, fract(hue * 7.13));
  let taper = mix(1.0 - t * 0.85, 1.0 - t * 0.3, seed * smoothstep(0.6, 0.9, t));
  var p = base + across * (side * wid * taper);
  let up = t * hgt * (1.0 - 0.25 * lean * t);
  p += vec3f(0.0, up, 0.0) + fwd * (lean * bend * hgt * 0.6) + windDir * (windAmt * bend * hgt * 0.7);
  // Rounded normal across the blade, tilted toward the sky.
  let nrm = normalize(fwd + across * side * 1.2 + vec3f(0.0, 0.35 + lean * t, 0.0));
  var o: VOut;
  o.pos = F.viewProj * vec4f(p, 1.0);
  o.wp = p;
  o.n = nrm;
  o.x = vec3f(t, hue, side);
  o.ty = f32(typ);
  return o;
}

fn shadowFast(wp: vec3f) -> f32 {
  let p = F.lightViewProj * vec4f(wp, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = max(abs(p.x), abs(p.y));
  if (edge >= 1.0 || p.z <= 0.0 || p.z >= 1.0) { return 1.0; }
  let s = textureSampleCompareLevel(shadowMap, shadowSamp, uv, p.z - F.shadowTexel * 0.004);
  return mix(s, 1.0, smoothstep(0.85, 1.0, edge));
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = normalize(i.n);
  if (!ff) { n = -n; }
  n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), 0.3));
  let t = i.x.x;
  let hue = i.x.y;
  let typ = u32(i.ty + 0.5);
  let row = typeRow(typ) * BK;
  let dryC = W.bp[row + B_GRASS_DRY];
  var tip = mix(W.bp[row + B_GRASS_TIP].rgb, dryC.rgb, smoothstep(0.55, 0.95, hue) * 0.7);
  // Seasons: 36 clock s a year (terrain.js seasonK).
  { let sK = sin(F.timeFx.z * 0.17453) * 0.8; tip = mix(tip, tip * vec3f(0.5, 0.9, 0.38), 0.6 * max(sK, 0.0)); tip = mix(tip, tip * vec3f(1.12, 1.0, 0.75), 0.45 * max(-sK, 0.0)); } // seasons
  tip = mix(tip, W.bp[row + B_GROUND_ALT].rgb * 1.3, smoothstep(0.25, 0.0, hue) * 0.6 * select(1.0, 0.3, typ == 1u));
  var base = W.bp[row + B_GRASS_BASE].rgb;
  if (typ == 3u) { // reeds: green stems, buff plumes
    base = vec3f(0.06, 0.09, 0.03);
    tip = mix(vec3f(0.20, 0.30, 0.08), vec3f(0.42, 0.36, 0.22), smoothstep(0.82, 0.95, t) * step(0.45, fract(hue * 7.13)));
  } else if (typ == 4u) { // young barley
    base = vec3f(0.05, 0.09, 0.02);
    tip = mix(vec3f(0.14, 0.26, 0.05), vec3f(0.22, 0.34, 0.08), hue);
  } else if (typ == 5u) { // ripening
    base = vec3f(0.14, 0.12, 0.05);
    tip = mix(vec3f(0.55, 0.45, 0.20), vec3f(0.66, 0.55, 0.28), hue);
  } else if (typ == 6u) { // fern frond: pinnae lit along the rachis, a few bracken-brown
    let pin = 0.75 + 0.25 * sin(t * 60.0 + abs(i.x.z) * 9.0);
    tip = mix(W.bp[row + B_GRASS_TIP].rgb, W.bp[row + B_GRASS_DRY].rgb, step(0.88, hue)) * pin;
  }
  tip *= 0.8 + 0.4 * fract(hue * 13.7);
  let alb = mix(base, tip, smoothstep(0.0, 0.75, t));
  let sh = shadowFast(i.wp + vec3f(0.0, 0.05, 0.0));
  let ndl = max(dot(n, F.sunDir), 0.0) * 0.75 + 0.25 * max(F.sunDir.y, 0.0);
  let sunL = probeSun();
  let ao = mix(0.55, 1.0, t);
  // Blades are thin: in shade they still glow with sky light passing through neighbours.
  let skyUp = probeSkyUp();
  var col = alb * (sunL * (ndl * sh / PI) + probeAmb(n) * (ao / PI) + skyUp * 0.35 * t);
  // Thin-leaf transmission when looking toward the sun.
  let v = normalize(F.camPos - i.wp);
  let back = pow(max(dot(-v, F.sunDir), 0.0), 3.0);
  col += alb * vec3f(1.0, 0.85, 0.55) * sunL * back * 0.5 * t * sh;
  col = applyFog(col, i.wp);
  return vec4f(col, 1.0);
}
`;

let cPipe, dPipe, cBG0, tierBGs = [], drawBG, argsBuf, tierBufs = [];

export async function initGrass(seed) {
  const d = gpu.device;
  const bladeBuf = d.createBuffer({ size: MAXB * 32, usage: GPUBufferUsage.STORAGE });
  argsBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | (DBG ? GPUBufferUsage.COPY_SRC : 0) });
  const C = GPUShaderStage.COMPUTE;
  const bgl0 = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: C, buffer: {} }] });
  const bgl2 = d.createBindGroupLayout({ entries: [
    { binding: 0, visibility: C, buffer: {} },
    { binding: 1, visibility: C, buffer: { type: 'storage' } },
    { binding: 2, visibility: C, buffer: { type: 'storage' } },
  ] });
  cBG0 = d.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: gpu.frameBuffer } }] });
  for (let t = 0; t < TIERS.length; t++) {
    const ub = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    tierBufs.push(ub);
    tierBGs.push(d.createBindGroup({ layout: bgl2, entries: [
      { binding: 0, resource: { buffer: ub } },
      { binding: 1, resource: { buffer: bladeBuf } },
      { binding: 2, resource: { buffer: argsBuf } },
    ] }));
  }
  const constants = { SEED: seed };
  const cm = d.createShaderModule({ label: 'grass-place', code: COMPUTE_WGSL });
  const dm = d.createShaderModule({ label: 'grass', code: DRAW_WGSL });
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const dbgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } }] });
  drawBG = d.createBindGroup({ layout: dbgl, entries: [{ binding: 0, resource: { buffer: bladeBuf } }] });
  [cPipe, dPipe] = await Promise.all([
    d.createComputePipelineAsync({ layout: d.createPipelineLayout({ bindGroupLayouts: [bgl0, world.bgl, bgl2] }), compute: { module: cm, entryPoint: 'place', constants } }),
    mainPipeline({ label: 'grass', module: dm, layouts: [world.bgl, dbgl], topology: 'triangle-strip', cullMode: 'none', constants }),
  ]);
  addPrePass({ pre: place });
  if (DBG) {
    for (let k = 0; k < 16; k++) dbgBufs.push(d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    window.__grassDbg = { count: new Uint32Array(8192), eye: new Float32Array(8192 * 4), timing };
  }
  const HIDE = /[?&]hide=[^&]*grass/.test(location.search); // debug: ?hide=grass,props
  if (!HIDE) addDrawable({
    main(p) {
      p.setPipeline(dPipe); p.setBindGroup(1, world.bg); p.setBindGroup(2, drawBG);
      p.drawIndirect(argsBuf, 0);
    },
  });
}

// Per-frame: tier domains (world cells covering the frustum footprint within the tier radius).
const TIER_F = new Float64Array(TIERS.flat());
const WEDGE = new Float64Array(14); // candidate directions (x, z) for the footprint AABB
export function updateGrass() {
  const ex = camera.eye[0], ez = camera.eye[2];
  let fx = camera.target[0] - ex, fz = camera.target[2] - ez;
  const fl = Math.sqrt(fx * fx + fz * fz) || 1; fx /= fl; fz /= fl;
  const halfFov = Math.atan(Math.tan(camera.fovY * 0.5) * camera.aspect) + 0.15;
  const ca = Math.cos(halfFov), sa = Math.sin(halfFov);
  // Footprint wedge: edge rays, forward, and the axis directions that fall inside the wedge.
  WEDGE[0] = fx * ca - fz * sa; WEDGE[1] = fx * sa + fz * ca;
  WEDGE[2] = fx * ca + fz * sa; WEDGE[3] = -fx * sa + fz * ca;
  WEDGE[4] = fx; WEDGE[5] = fz;
  WEDGE[6] = 1; WEDGE[7] = 0; WEDGE[8] = -1; WEDGE[9] = 0; WEDGE[10] = 0; WEDGE[11] = 1; WEDGE[12] = 0; WEDGE[13] = -1;
  for (let t = 0; t < TIERS.length; t++) {
    const cell = TIER_F[t * 3], r0 = TIER_F[t * 3 + 1], r1 = TIER_F[t * 3 + 2];
    let minX = ex - 3, maxX = ex + 3, minZ = ez - 3, maxZ = ez + 3;
    for (let k = 0; k < 7; k++) {
      const dx = WEDGE[k * 2], dz = WEDGE[k * 2 + 1];
      if (k >= 3 && dx * fx + dz * fz < ca) continue;
      const px = ex + dx * r1, pz = ez + dz * r1;
      if (px < minX) minX = px; if (px > maxX) maxX = px; if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    minX = Math.max(minX, ex - r1); maxX = Math.min(maxX, ex + r1); minZ = Math.max(minZ, ez - r1); maxZ = Math.min(maxZ, ez + r1);
    const ox = Math.floor(minX / cell), oz = Math.floor(minZ / cell);
    const nx = Math.ceil(maxX / cell) - ox, nz = Math.ceil(maxZ / cell) - oz;
    const o = t * 8;
    tierData[o] = ox; tierData[o + 1] = oz; tierData[o + 2] = nx; tierData[o + 3] = nz;
    tierF[o + 4] = cell; tierF[o + 5] = r0; tierF[o + 6] = r1; tierData[o + 7] = 7919 * (t + 1);
    dispatch[t * 2] = Math.ceil(nx / 8); dispatch[t * 2 + 1] = Math.ceil(nz / 8);
  }
}

// Debug (?grassdbg=1, allocates): read back the indirect instance count of every frame.
const DBG = /[?&]grassdbg=1/.test(location.search);
const dbgBufs = [], dbgBusy = new Uint8Array(16), dbgFrame = new Int32Array(16);
let dbgPending = -1;
function dbgMap() {
  if (dbgPending < 0) return;
  const k = dbgPending, fno = dbgFrame[k]; dbgPending = -1;
  dbgBufs[k].mapAsync(GPUMapMode.READ).then(() => {
    const u = new Uint32Array(dbgBufs[k].getMappedRange());
    window.__grassDbg.count[fno & 8191] = u[1];
    dbgBufs[k].unmap(); dbgBusy[k] = 0;
  }, () => { dbgBusy[k] = 0; });
}

const cDesc = { timestampWrites: undefined };
function place(enc) {
  const q = gpu.device.queue;
  q.writeBuffer(argsBuf, 0, argsInit);
  for (let t = 0; t < TIERS.length; t++) q.writeBuffer(tierBufs[t], 0, tierData, t * 8, 8);
  cDesc.timestampWrites = tsw();
  const p = enc.beginComputePass(cDesc);
  p.setPipeline(cPipe);
  p.setBindGroup(0, cBG0);
  p.setBindGroup(1, world.bg);
  for (let t = 0; t < TIERS.length; t++) {
    p.setBindGroup(2, tierBGs[t]);
    p.dispatchWorkgroups(dispatch[t * 2], dispatch[t * 2 + 1]);
  }
  p.end();
  if (DBG) {
    dbgMap(); // previous frame's copy has been submitted by now
    const fno = timing.frames;
    const e = window.__grassDbg.eye; e[(fno & 8191) * 4] = camera.eye[0]; e[(fno & 8191) * 4 + 1] = camera.eye[1]; e[(fno & 8191) * 4 + 2] = camera.eye[2];
    window.__grassDbg.count[fno & 8191] = 0xffffffff;
    for (let k = 0; k < 16; k++) if (!dbgBusy[k]) { dbgBusy[k] = 1; dbgFrame[k] = fno; dbgPending = k; enc.copyBufferToBuffer(argsBuf, 0, dbgBufs[k], 0, 16); break; }
  }
}
