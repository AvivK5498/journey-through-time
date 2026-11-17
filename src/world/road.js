// Roads. The road is not a separate mesh: every frame the live road centrelines are
// rasterised (as capsules, min-distance by depth test) into the camera-centred road field
// (see world.js). The terrain then conforms to the field (crown, ruts, shoulders, banks)
// and shades the road surface from it, so forks are real geometry: the exits' distance
// fields union into a Y with a proper gore and no z-fighting.
//
// Surface type: 0 game trail, 1 dirt track, 2 stone paving, 3 cobbles, 4 asphalt two-lane,
// 5 modern highway, blended along the road by journey distance (world.js surfaceCurve;
// time.js SURFACE_CLOCK). ROAD_WGSL shades all six.

import { gpu, addPrePass, timing, tsw } from '../gpu.js';
import { world, FIELD, FIELD_W, FAR_W, fieldOrigin, WORLD_VEC4, SLOT_EDGES, LMAP, bioSnap } from './world.js';
import { MAX_EDGES, MAX_PTS, pts, edgeN, edgeAlive, edgePresence, onEdgeReady, onTunnelPlanned, graph, edgeBio, edgeRegion, edgeParentRegion, edgeSplit, edgeSeam } from './graph.js';

const STRIDES = [2, 4, 16]; // centreline samples per capsule (4 m, 8 m, 32 m)

let ptsBuf, pipeNear, pipeFar;
const lvl = [];
const lastO = new Float64Array(6).fill(NaN);
let lastDirty = -1;

// The field pass cannot bind group(1) (it renders into the textures group(1) samples), so it
// reads the edge table straight out of the World buffer.
const FIELD_WGSL = /* wgsl */ `
struct Lvl { origin: vec2f, size: f32, w: f32, stride: u32, segs: u32, maxPts: u32, pad: u32 };
@group(0) @binding(0) var<uniform> L: Lvl;
@group(0) @binding(1) var<storage, read> P: array<vec4f>;
@group(0) @binding(2) var<uniform> WV: array<vec4f, ${WORLD_VEC4}>;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec2f,
  @location(1) @interpolate(flat) a: vec4f, // a.xz, b.xz
  @location(2) @interpolate(flat) y: vec4f, // ya, yb, ja, jb
  @location(3) @interpolate(flat) m: vec2f, // presence, region
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let e = ii / L.segs;
  let sg = ii % L.segs;
  let ed = WV[${SLOT_EDGES}u + e];
  let n = u32(ed.w);
  let k0 = sg * L.stride;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  if (ed.x <= 0.0 || k0 + 1u >= n || f32(k0) * 2.0 > ed.z) { return o; }
  let k1 = min(k0 + L.stride, n - 1u);
  let a = P[e * L.maxPts + k0];
  let b = P[e * L.maxPts + k1];
  let A = a.xz;
  let B = b.xz;
  let dir = normalize(B - A);
  let nr = vec2f(-dir.y, dir.x);
  var cs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = cs[vi];
  let w = L.w;
  let base = select(A - dir * w, B + dir * w, c.x > 0.0);
  let p = base + nr * (c.y * w);
  let uv = (p - L.origin) / L.size + 0.5;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  o.wp = p;
  o.a = vec4f(A, B);
  o.y = vec4f(a.y, b.y, a.w, b.w);
  o.m = vec2f(ed.x, ed.y);
  return o;
}

struct FO { @location(0) c: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fs(i: VO) -> FO {
  let A = i.a.xy;
  let ab = i.a.zw - A;
  let t = clamp(dot(i.wp - A, ab) / dot(ab, ab), 0.0, 1.0);
  let d = length(i.wp - (A + ab * t)) + (1.0 - i.m.x) * L.w;
  if (d >= L.w) { discard; }
  var o: FO;
  o.depth = d / L.w;
  o.c = vec4f(d, mix(i.y.x, i.y.y, t), i.m.y, mix(i.y.z, i.y.w, t));
  return o;
}
`;

// Label map (world.js LMAP): per region the distance to the nearest road of that region, min-
// blended into two rgba16float targets (labelA: regions 0-3; biomeTex2: 4-6 and the distance to a
// strait road's split), then resolved per texel into biomeTex. One capsule per chord of `stride`
// samples, radius rb (a road fading in or out adds (1 - edgeBio) * rb); a chord holding its
// road's split writes the parent's region before it and its own after it.
const LABEL_WGSL = /* wgsl */ `
struct BL { origin: vec2f, size: f32, rb: f32, stride: u32, segs: u32, maxPts: u32, big: f32 };
@group(0) @binding(0) var<uniform> L: BL;
@group(0) @binding(1) var<storage, read> P: array<vec4f>;
@group(0) @binding(2) var<uniform> E: array<vec4f, ${MAX_EDGES * 2}>; // presence, region, parent, samples | split, seam
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec2f,
  @location(1) @interpolate(flat) ab: vec4f,
  @location(2) @interpolate(flat) m: vec4f, // s0, s1, split, penalty
  @location(3) @interpolate(flat) r: vec4f, // own, parent, seam
};
struct FO { @location(0) a: vec4f, @location(1) b: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let e = ii / L.segs;
  let k0 = (ii % L.segs) * L.stride;
  let ed = E[e * 2u];
  let ex = E[e * 2u + 1u];
  let n = u32(ed.w);
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  if (ed.x <= 0.0 || k0 + 1u >= n) { return o; }
  let k1 = min(k0 + L.stride, n - 1u);
  let A = P[e * L.maxPts + k0].xz;
  let B = P[e * L.maxPts + k1].xz;
  var cs = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let lo = min(A, B) - vec2f(L.rb);
  let hi = max(A, B) + vec2f(L.rb);
  let p = mix(lo, hi, cs[vi]);
  let uv = (p - L.origin) / L.size + 0.5;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  o.wp = p;
  o.ab = vec4f(A, B);
  o.m = vec4f(f32(k0) * 2.0, f32(k1) * 2.0, ex.x, (1.0 - ed.x) * L.rb);
  o.r = vec4f(ed.y, ed.z, ex.y, 0.0);
  return o;
}
fn segd(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let s = b - a;
  let l2 = dot(s, s);
  var t = 0.0;
  if (l2 > 1e-12) { t = clamp(dot(p - a, s) / l2, 0.0, 1.0); }
  return length(p - a - s * t);
}
fn put(o: ptr<function, FO>, lab: u32, d: f32) {
  if (lab < 4u) { (*o).a[lab] = min((*o).a[lab], d); } else { (*o).b[lab - 4u] = min((*o).b[lab - 4u], d); }
}
@fragment fn fs(i: VO) -> FO {
  var o = FO(vec4f(L.big), vec4f(L.big));
  let A = i.ab.xy; let B = i.ab.zw;
  let own = u32(i.r.x + 0.5); let par = u32(i.r.y + 0.5);
  let split = i.m.z; let pen = i.m.w;
  var any = false;
  if (split > i.m.x && split < i.m.y) {
    let X = mix(A, B, (split - i.m.x) / (i.m.y - i.m.x));
    let dp = segd(i.wp, A, X) + pen;
    let dn = segd(i.wp, X, B) + pen;
    if (dp < L.rb) { put(&o, par, dp); any = true; }
    if (dn < L.rb) { put(&o, own, dn); any = true; }
  } else {
    let lab = select(own, par, split >= 0.0 && i.m.y <= split);
    let d = segd(i.wp, A, B) + pen;
    if (d < L.rb) { put(&o, lab, d); any = true; }
  }
  // a strait road's crossing (its quays and the water between them): no ridge near it
  if (i.r.z > 1.5 && i.m.y > split - 205.0) { let ds = segd(i.wp, A, B); if (ds < L.rb) { o.b.w = ds; any = true; } }
  if (!any) { discard; }
  return o;
}
`;
const RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var tA: texture_2d<f32>;
@group(0) @binding(1) var tB: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ij = vec2i(pos.xy);
  let a = textureLoad(tA, ij, 0);
  let b = textureLoad(tB, ij, 0);
  let D = array<f32, 7>(a.x, a.y, a.z, a.w, b.x, b.y, b.z);
  var l1 = 0;
  for (var k = 1; k < 7; k++) { if (D[k] < D[l1]) { l1 = k; } }
  var l2 = select(0, 1, l1 == 0);
  for (var k = 0; k < 7; k++) { if (k != l1 && D[k] < D[l2]) { l2 = k; } }
  if (D[l1] >= ${LMAP.rb}.0) { return vec4f(${LMAP.big}.0, ${LMAP.big}.0, 63.0, b.w); }
  return vec4f(min(D[l2] - D[l1], ${LMAP.big}.0), D[l1], f32(l1 + 8 * l2), b.w);
}
`;
let bioPipe, bioBG, bioUbuf, bioEbuf, resPipe, resBG;
const bioL = new Float32Array(8), bioLu = new Uint32Array(bioL.buffer);
const bioE = new Float32Array(MAX_EDGES * 8);
const BIG = { r: LMAP.big, g: LMAP.big, b: LMAP.big, a: LMAP.big };
const bioPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: BIG }, { view: null, loadOp: 'clear', storeOp: 'store', clearValue: BIG }], timestampWrites: undefined };
const resPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }], timestampWrites: undefined };
const lastBio = new Float64Array(4).fill(NaN);

export async function initRoad() {
  const d = gpu.device;
  addPrePass({ pre: renderField }); // first, so grass/props placement sees this frame's field
  ptsBuf = d.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bgl = d.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: {} },
  ] });
  const layout = d.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const module = d.createShaderModule({ label: 'road-field', code: FIELD_WGSL });
  const desc = (format) => ({
    label: 'road-field', layout,
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  });
  [pipeNear, pipeFar] = await Promise.all([d.createRenderPipelineAsync(desc(world.fieldFormat)), d.createRenderPipelineAsync(desc('rgba16float'))]);
  const depthNear = d.createTexture({ size: [FIELD[0].res, FIELD[0].res], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const depthFar = d.createTexture({ size: [FIELD[2].res, FIELD[2].res], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  for (let l = 0; l < 3; l++) {
    const ubuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const segs = Math.ceil(MAX_PTS / STRIDES[l]);
    const view = l < 2 ? world.fieldTex.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 }) : world.farTex.createView();
    const W = l < 2 ? FIELD_W : FAR_W;
    lvl.push({
      ubuf, segs, W,
      data: new Float32Array(8),
      u32: null,
      bg: d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: ptsBuf } }, { binding: 2, resource: { buffer: world.buffer } }] }),
      pass: {
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: W, g: 0, b: -1, a: 0 } }],
        depthStencilAttachment: { view: (l < 2 ? depthNear : depthFar).createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        timestampWrites: undefined,
      },
      pipe: l < 2 ? pipeNear : pipeFar,
    });
    const L = lvl[l];
    L.u32 = new Uint32Array(L.data.buffer);
    L.data[2] = FIELD[l].size; L.data[3] = W;
    L.u32[4] = STRIDES[l]; L.u32[5] = segs; L.u32[6] = MAX_PTS;
  }
  // Label map passes.
  {
    const bglB = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: {} },
    ] });
    bioUbuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    bioEbuf = d.createBuffer({ size: bioE.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    bioBG = d.createBindGroup({ layout: bglB, entries: [{ binding: 0, resource: { buffer: bioUbuf } }, { binding: 1, resource: { buffer: ptsBuf } }, { binding: 2, resource: { buffer: bioEbuf } }] });
    const bm = d.createShaderModule({ label: 'label-map', code: LABEL_WGSL });
    const mn = { srcFactor: 'one', dstFactor: 'one', operation: 'min' };
    const rm = d.createShaderModule({ label: 'label-resolve', code: RESOLVE_WGSL });
    const bglR = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ] });
    [bioPipe, resPipe] = await Promise.all([
      d.createRenderPipelineAsync({
        label: 'label-map', layout: d.createPipelineLayout({ bindGroupLayouts: [bglB] }),
        vertex: { module: bm, entryPoint: 'vs' },
        fragment: { module: bm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: { color: mn, alpha: mn } }, { format: 'rgba16float', blend: { color: mn, alpha: mn } }] },
        primitive: { topology: 'triangle-list' },
      }),
      d.createRenderPipelineAsync({
        label: 'label-resolve', layout: d.createPipelineLayout({ bindGroupLayouts: [bglR] }),
        vertex: { module: rm, entryPoint: 'vs' }, fragment: { module: rm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      }),
    ]);
    resBG = d.createBindGroup({ layout: bglR, entries: [{ binding: 0, resource: world.labelA.createView() }, { binding: 1, resource: world.biomeTex2.createView() }] });
    bioPass.colorAttachments[0].view = world.labelA.createView();
    bioPass.colorAttachments[1].view = world.biomeTex2.createView();
    resPass.colorAttachments[0].view = world.biomeTex.createView();
    bioL[2] = LMAP.size; bioL[3] = LMAP.rb;
    bioLu[4] = LMAP.stride; bioLu[5] = Math.ceil(MAX_PTS / LMAP.stride); bioLu[6] = MAX_PTS; bioL[7] = LMAP.big;
  }
  onEdgeReady(uploadEdge);
  onTunnelPlanned(uploadEdge); // the road is straightened through its passage
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e]) uploadEdge(e);
}

export function uploadEdge(e) {
  if (!ptsBuf) return;
  gpu.device.queue.writeBuffer(ptsBuf, e * MAX_PTS * 16, pts, e * MAX_PTS * 4, edgeN[e] * 4);
}

function renderField(enc) {
  if (!lvl.length) return;
  let fading = false;
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e] && edgePresence[e] > 0 && edgePresence[e] < 1) { fading = true; break; }
  const dirty = graph.dirty !== lastDirty;
  lastDirty = graph.dirty;
  for (let l = 0; l < 3; l++) {
    const ox = fieldOrigin[l * 2], oz = fieldOrigin[l * 2 + 1];
    const moved = ox !== lastO[l * 2] || oz !== lastO[l * 2 + 1];
    if (!moved && !dirty && !(fading && l > 0)) continue;
    lastO[l * 2] = ox; lastO[l * 2 + 1] = oz;
    timing.frameEvents |= 1 << l; // 1 L0, 2 L1, 4 L2 re-rendered
    const L = lvl[l];
    L.data[0] = ox; L.data[1] = oz;
    gpu.device.queue.writeBuffer(L.ubuf, 0, L.data);
    L.pass.timestampWrites = tsw();
    const p = enc.beginRenderPass(L.pass);
    p.setPipeline(L.pipe);
    p.setBindGroup(0, L.bg);
    p.draw(6, MAX_EDGES * L.segs);
    p.end();
  }
  renderBiome(enc, dirty);
}

// Re-renders the label map when its origin moved or the graph changed at once, and while a
// road's biome presence is fading every 4th frame (the fades are slow). Snapshots what it drew
// for the JS mirror (world.js labelAtJS).
let bioFrame = 0;
function renderBiome(enc, dirty) {
  let fading = false;
  for (let e = 0; e < MAX_EDGES; e++) if (edgeAlive[e] && edgeBio[e] > 0 && edgeBio[e] < 1) { fading = true; break; }
  const ox = fieldOrigin[4], oz = fieldOrigin[5];
  bioFrame++;
  const moved = ox !== lastBio[0] || oz !== lastBio[1] || lastBio[2] !== 1;
  const endFade = lastBio[3] === 1 && !fading; // a fade that just ended: draw its last state
  if (!dirty && !moved && !(fading && (bioFrame & 3) === 0) && !endFade) { lastBio[3] = fading ? 1 : 0; return; }
  lastBio[3] = fading ? 1 : 0;
  lastBio[0] = ox; lastBio[1] = oz; lastBio[2] = 1;
  bioL[0] = ox; bioL[1] = oz;
  for (let e = 0; e < MAX_EDGES; e++) {
    const o = e * 8;
    bioE[o] = edgeAlive[e] ? edgeBio[e] : 0;
    bioE[o + 1] = edgeRegion[e]; bioE[o + 2] = edgeParentRegion[e]; bioE[o + 3] = edgeN[e];
    bioE[o + 4] = edgeSplit[e]; bioE[o + 5] = edgeSeam[e]; bioE[o + 6] = 0; bioE[o + 7] = 0;
  }
  const q = gpu.device.queue;
  q.writeBuffer(bioUbuf, 0, bioL);
  q.writeBuffer(bioEbuf, 0, bioE);
  for (let i = 0; i < MAX_EDGES * 8; i++) bioSnap[i] = bioE[i]; // (as float32, the GPU's values)
  bioSnap[MAX_EDGES * 8] = ox; bioSnap[MAX_EDGES * 8 + 1] = oz; bioSnap[MAX_EDGES * 8 + 2]++;
  timing.frameEvents |= 32;
  bioPass.timestampWrites = tsw();
  let p = enc.beginRenderPass(bioPass);
  p.setPipeline(bioPipe);
  p.setBindGroup(0, bioBG);
  p.draw(6, MAX_EDGES * bioLu[5]);
  p.end();
  resPass.timestampWrites = tsw();
  p = enc.beginRenderPass(resPass);
  p.setPipeline(resPipe);
  p.setBindGroup(0, resBG);
  p.draw(3);
  p.end();
}

// ---------------------------------------------------------------------------------
// Road surface shading, used by the terrain fragment shader. Needs WORLD_WGSL and the
// terrain's tn() (gradient-filtered material noise).
export const ROAD_WGSL = /* wgsl */ `
fn voronoi2(p: vec2f) -> vec3f { // x: F1, y: F2, z: cell hash
  let ip = floor(p);
  let fp = p - ip;
  var f1 = 9.0; var f2 = 9.0; var id = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = vec2f(f32(i), f32(j));
      let h = hash2(i32(ip.x) + i, i32(ip.y) + j);
      let h2 = hash2(i32(ip.x) + i + 7919, i32(ip.y) + j + 104729);
      let o = c + vec2f(h, h2) * 0.8 + 0.1 - fp;
      let dd = dot(o, o);
      if (dd < f1) { f2 = f1; f1 = dd; id = h; } else if (dd < f2) { f2 = dd; }
    }
  }
  return vec3f(sqrt(f1), sqrt(f2), id);
}

struct RoadMatW { alb: vec3f, cover: f32, bump: f32, spec: f32, rough: f32, shoulder: vec3f };
fn tri(s: f32, k: f32) -> f32 { return saturate(1.0 - abs(s - k)); }
// |lateral offset| from the centre line, exact also within the field's bilinear plateau (the
// stored distance is |x| sampled at 0.5 m, so it reads flat for |x| < 0.25): two samples
// 0.75 m either side across the road are in the linear part, and their difference is 2x.
// The across direction comes from the gradient of the journey coordinate. d < 0.9 only.
fn roadAbsX(p: vec2f, jd: f32) -> f32 {
  let tj = vec2f(nearField(p + vec2f(0.4, 0.0)).w - jd, nearField(p + vec2f(0.0, 0.4)).w - jd);
  let t = tj / max(length(tj), 1e-5);
  let nr = vec2f(-t.y, t.x) * 0.75;
  return min(abs(nearField(p + nr).x - nearField(p - nr).x) * 0.5, 0.9);
}
// Painted stripe across x (anti-aliased, averaging out when it is thinner than a pixel), and
// dashes along the road: on for the first (on) fraction of each (per) metres.
fn paint(x: f32, c: f32, w: f32, fw: f32) -> f32 {
  let e = max(fw * 0.8, 0.003);
  return saturate((w * 0.5 - abs(x - c)) / e + 0.5) * min(1.0, w / max(fw * 1.3, 1e-4));
}
fn dashes(jd: f32, per: f32, on: f32, fw: f32) -> f32 {
  let u = fract(jd / per);
  let e = max(fw / per, 0.002);
  return smoothstep(0.0, e, u) * (1.0 - smoothstep(on - e, on, u));
}
fn stones(p: vec2f, dens: f32, fw: f32) -> vec2f { // x: stone mask, y: stone tone
  // Irregular outlines (the lookup point is warped), sizes from grit to cobbles, sparse.
  let q = p + (tnl(p * 2.7, 0.0).xy - 0.5) * 1.1;
  let v = voronoi2(q);
  let r = 0.06 + 0.22 * pow(fract(v.z * 7.31), 2.0);
  let on = step(1.0 - dens, fract(v.z * 3.17));
  let m = (1.0 - smoothstep(r - 0.04 - fw * 3.0, r + fw * 3.0, v.x)) * on;
  return vec2f(m, fract(v.z * 11.7));
}
// p: world xz, d: distance from centreline, jd: journey metres, s: surface 0..2 (trail, dirt
// track, stone paving), hw: half width, fw: pixel footprint (m), w: material weights, wr: raw
// (unsharpened) biome weights: the road changes over a few hundred metres at a biome border
// (red earth -> gravel -> frost -> packed snow; earth -> compacted sand).
fn roadMaterialW(p: vec2f, d: f32, jd: f32, s: f32, hw: f32, fw: f32, w: BW, wr: vec3f) -> RoadMatW {
  var m: RoadMatW;
  let soil = bioAt(B_SOIL, w).rgb;
  let grass = bioAt(B_GROUND, w).rgb;
  let fine = smoothstep(0.03, 0.006, fw); // detail that would alias fades out
  let NA = tn(p * 0.31, 0.31);
  let NB = tn(p * 4.3 + vec2f(3.0, 7.0), 4.3);
  let n0 = NA.x;
  let n1 = NA.y;
  let n2 = NB.x;
  let n3 = mix(0.5, tn(p * 17.0, 17.0).x, fine);
  let tT = 1.0 - saturate(s);
  let tD = tri(s, 1.0);
  let tS = tri(s, 2.0);
  let tB = saturate(s - 1.0); // built (paved or later)
  let modK = saturate(s - 2.0); // cobbles, asphalt, highway: the same lane in every biome
  let rn = tnl(vec2f(jd * 0.35, d * 0.2), tnLod(fw, 0.35));
  let rag = ((rn.x - 0.5) * mix(0.9, 0.12, tB) + (n2 - 0.5) * 0.25 * (1.0 - tB)) * (1.0 - 0.75 * modK);
  let edge = max(0.06, fw * 1.5);
  m.cover = 1.0 - smoothstep(hw + rag - edge, hw + rag + edge, d);
  m.alb = vec3f(0.0); m.bump = 0.0; m.spec = 0.025; m.rough = 0.72;
  m.shoulder = mix(soil * 0.9, mix(soil, vec3f(0.3, 0.29, 0.27), 0.5) * 0.85, modK);
  let ice = smoothstep(0.62, 0.86, wr.y); // packed snow
  let sand = smoothstep(0.18, 0.45, wr.z);

  // --- cobbles, asphalt, highway (s 2..5). Weighted by modK; the ice and sand overlays below
  // keep these lanes and only add snow berms or drifts at the edges.
  var mA = vec3f(0.0); var mBump = 0.0; var mSpec = 0.0; var mRough = 0.0;
  if (modK > 0.001) {
    var ax = d;
    if (d < 0.9) { ax = roadAbsX(p, jd); }
    let fineC = smoothstep(0.05, 0.014, fw);
    let tC = tri(s, 3.0);
    let tA = tri(s, 4.0);
    let tH = saturate(s - 4.0);
    if (tC > 0.001) {
      // Setts in courses across the road (each course offset, mirrored about a crown course),
      // domed and polished on top, dark sandy joints with a little moss; a gutter of long
      // stones and a kerb along each edge. Far away the pattern averages to its mean tone.
      let fineS = smoothstep(0.032, 0.011, fw);
      let rl = 0.17;
      let ri = floor(jd / rl);
      let fr = fract(jd / rl);
      let hr = hash2(i32(ri), 71);
      let sw = 0.2 + 0.05 * hr;
      var ac = ax / sw + 0.5 + hr * 0.5 * step(0.5, ax);
      ac += (hash2(i32(floor(ac)) + 311, i32(ri)) - 0.5) * 0.3; // stones of uneven width
      let ci = floor(ac);
      let fc = fract(ac);
      let hc = hash2(i32(ci) + 917, i32(ri));
      // rounded-rectangle depth inside the stone (m): rounded corners, narrow sandy joints
      let qd = vec2f(abs(fr - 0.5) * rl, abs(fc - 0.5) * sw) - (vec2f(0.5 * rl, 0.5 * sw) - vec2f(0.045));
      let ed = 0.034 - length(max(qd, vec2f(0.0))) - min(max(qd.x, qd.y), 0.0);
      let joint = smoothstep(0.0, 0.01 + fw, ed);
      let dome = saturate(ed / 0.06);
      let rock = bioAt(B_ROCK, w).rgb;
      let base = mix(vec3f(0.2, 0.198, 0.192), rock * 0.85 + vec3f(0.02), 0.45);
      var sett = base * (0.76 + 0.42 * hc) * (0.94 + 0.1 * n2);
      sett *= mix(vec3f(1.0), select(vec3f(0.92, 0.97, 1.06), vec3f(1.1, 1.0, 0.86), hc > 0.5), step(0.7, fract(hc * 7.0)));
      sett *= 0.93 + 0.12 * dome * fineS;
      let jc = mix(sett * 0.5, soil * 0.45, 0.5);
      let jc2 = mix(jc, vec3f(0.08, 0.1, 0.05), smoothstep(0.55, 0.8, n1) * 0.5); // moss in the joints
      var cb = mix(jc2, sett, mix(0.88, joint, fineS));
      // gutter and kerb
      let gq = d - (hw - 0.62);
      let gut = smoothstep(-0.02, 0.0, gq) * (1.0 - smoothstep(0.34, 0.36, gq));
      let gl = fract(jd / 0.7 + hash2(i32(floor(gq * 3.0)), 5) * 0.5);
      let gj = smoothstep(0.0, 0.04, gl) * smoothstep(1.0, 0.96, gl);
      cb = mix(cb, mix(jc, base * (0.95 + 0.15 * n2), mix(0.9, gj, fineC)), gut);
      let kerb = smoothstep(hw - 0.27, hw - 0.24, d);
      let kj = fract(jd * 1.1);
      cb = mix(cb, mix(soil * 0.45, base * 1.15 * (0.92 + 0.15 * n2), mix(0.9, smoothstep(0.0, 0.06, kj) * smoothstep(1.0, 0.94, kj), fineC)), kerb);
      cb = mix(cb, soil * 0.7, smoothstep(0.6, 0.9, NA.w) * 0.25); // dust in places
      mA += cb * tC;
      mBump += ((joint - 1.0) * 0.003 + dome * 0.004 - gut * 0.006 + kerb * 0.03) * tC * fineS;
      mSpec += 0.035 * tC; mRough += 0.55 * tC;
    }
    if (tA > 0.001) {
      // Weathered two-lane asphalt: grey with a fine aggregate, darker patches of newer tar,
      // crack seals, paler polished wheel tracks, a worn cream dashed centre line, frayed edges.
      var asp = vec3f(0.112, 0.108, 0.102) * (0.86 + 0.28 * n3) * (0.9 + 0.2 * n0);
      let pi = floor(jd / 11.0);
      let hp = hash2(i32(pi), 41);
      let pu = fract(jd / 11.0);
      let pat = step(0.8, hp) * smoothstep(0.1, 0.13, pu) * (1.0 - smoothstep(0.55 + 0.3 * fract(hp * 9.0), 0.58 + 0.3 * fract(hp * 9.0), pu))
        * (1.0 - smoothstep(0.7 + 2.2 * fract(hp * 13.0), 0.75 + 2.2 * fract(hp * 13.0), ax));
      asp = mix(asp, vec3f(0.068, 0.068, 0.07) * (0.9 + 0.2 * n3), pat);
      // thin sealed cracks: where two noise contours cross a narrow band (no loops or dots)
      let cn = tnl(p * vec2f(0.45, 1.3) + vec2f(5.0, 1.0), tnLod(fw, 1.3));
      let crack = (1.0 - smoothstep(0.004, 0.012 + fw * 0.8, abs(cn.x - 0.5) * 0.25)) * smoothstep(0.6, 0.75, cn.y) * smoothstep(0.5, 0.7, NA.w) * fineC;
      asp = mix(asp, vec3f(0.05, 0.05, 0.052), crack * 0.6);
      let wt = exp(-pow((abs(ax - 1.8) - 0.85) / 0.32, 2.0));
      asp *= 1.0 + 0.16 * wt;
      let cl = paint(ax, 0.0, 0.11, fw) * dashes(jd + 1.5, 12.0, 0.36, fw) * (0.6 + 0.4 * smoothstep(0.25, 0.6, NB.y));
      asp = mix(asp, vec3f(0.6, 0.56, 0.44), cl);
      mA += asp * tA;
      mBump += ((n3 - 0.5) * 0.002 - crack * 0.003 + pat * 0.001) * tA * fineC;
      mSpec += mix(0.03, 0.04, wt) * tA; mRough += mix(0.6, 0.5, wt) * tA;
    }
    if (tH > 0.001) {
      // Modern highway: clean dark asphalt with a speck of aggregate, solid white edge lines,
      // a paler paved strip beyond them, a dashed centre line and white studs between dashes.
      var hwy = vec3f(0.058, 0.058, 0.062) * (0.88 + 0.24 * n3) * (0.96 + 0.08 * n0);
      let spk = step(0.93, tnl(p * 9.0, tnLod(fw, 9.0)).y) * fineC;
      hwy += vec3f(0.05) * spk;
      let shl = smoothstep(hw - 0.33, hw - 0.3, ax);
      hwy = mix(hwy, vec3f(0.085, 0.084, 0.082) * (0.9 + 0.2 * n3), shl);
      let el = paint(ax, hw - 0.42, 0.15, fw);
      let cd = paint(ax, 0.0, 0.14, fw) * dashes(jd, 12.0, 0.3, fw);
      let su = fract(jd / 12.0 + 0.35) * 12.0;
      let stud = (1.0 - smoothstep(0.05, 0.07, abs(su - 6.0))) * (1.0 - smoothstep(0.05, 0.07, ax)) * fineC;
      hwy = mix(hwy, vec3f(0.74, 0.74, 0.72), saturate(el + cd));
      hwy = mix(hwy, vec3f(0.8, 0.78, 0.7), stud);
      mA += hwy * tH;
      mBump += ((n3 - 0.5) * 0.0015 + stud * 0.02) * tH * fineC;
      mSpec += mix(0.035, 0.3, stud) * tH; mRough += mix(0.52, 0.2, stud) * tH;
    }
  }
  // Loose stones only where the earth shows (not under snow or drifted sand): Voronoi is costly.
  let stoneK = fine * (1.0 - smoothstep(0.3, 0.6, max(ice, sand)));
  // Only the surfaces actually present are evaluated (each costs several Voronoi lookups),
  // and none of them under packed snow.
  if (ice < 0.97 && sand < 0.97) {
  // Base earth: hue drifts between redder and browner patches, damp darker blotches.
  var earth = soil * mix(vec3f(1.08, 0.95, 0.88), vec3f(0.92, 0.97, 1.06), NA.z) * (0.8 + 0.22 * n0 + 0.12 * n1);
  earth *= 1.0 - 0.14 * smoothstep(0.55, 0.8, NA.w * 0.7 + NB.y * 0.3);
  var crust = 0.0;
  if (stoneK > 0.0 && tB < 0.999) {
    crust = smoothstep(0.55, 0.75, NA.w) * smoothstep(0.62, 0.8, NB.z) * stoneK;
  }

  if (tT > 0.001) {
  // --- game trail: a trampled, braided path: a paler worn line or two, scattered stones of
  // many sizes, dry cracked crust in patches, tufts creeping in.
  let wob = (rn.y - 0.5) * 0.9;
  let line1 = exp(-pow((d * sign(rn.z - 0.5) - wob * 0.6) / 0.38, 2.0));
  let worn = max(smoothstep(hw, 0.2, d) * 0.55, line1);
  var trail = mix(earth * 0.9, earth * vec3f(1.22, 1.13, 1.04), worn * (0.55 + 0.35 * n2));
  trail = mix(trail, earth * 0.62, crust * 0.6);
  var stT = vec2f(0.0);
  if (stoneK > 0.0) { stT = stones(p * 4.0, 0.05 + 0.14 * smoothstep(0.45, 0.85, n0), fw * 4.0) * vec2f(stoneK, 1.0); }
  let stoneC = mix(soil * 0.55 + vec3f(0.05), soil * 0.9 + vec3f(0.11, 0.1, 0.09), stT.y);
  trail = mix(trail, stoneC, stT.x * 0.75 * fine);
  let tuft = smoothstep(0.62, 0.8, NB.y * 0.6 + n3 * 0.4) * (1.0 - worn * 0.9);
  let stub = mix(grass * 0.55, grass * 0.95, n3);
  trail = mix(trail, stub, tuft * 0.5);
  m.alb += trail * tT;
  m.bump += ((n3 - 0.5) * 0.004 + stT.x * 0.01 - crust * 0.003) * tT * fine;
  }

  if (tD > 0.001) {
  // --- dirt track: two compacted ruts (darker, smoother, slightly glossy), a grassy crown
  // strip, loose gravel pushed to the margins.
  let rd = abs(d - 0.8 - 0.05 * (n1 - 0.5));
  let rut = exp(-pow(rd / 0.32, 2.0));
  let strip = smoothstep(0.42 + 0.2 * (n2 - 0.5), 0.1, d) * smoothstep(0.35, 0.65, rn.w) * smoothstep(0.3, 0.6, NB.w);
  var dirt = earth * vec3f(1.06, 1.0, 0.95);
  dirt = mix(dirt, earth * 0.68, rut * 0.7);
  var stD = vec2f(0.0);
  if (stoneK > 0.0) { stD = stones(p * 6.0, 0.06 + 0.3 * smoothstep(0.9, hw, d), fw * 6.0) * vec2f(stoneK, 1.0); }
  dirt = mix(dirt, mix(soil * 0.6 + vec3f(0.05), soil * 0.95 + vec3f(0.12, 0.11, 0.1), stD.y), stD.x * (1.0 - rut) * 0.8 * fine);
  dirt = mix(dirt, mix(grass * 0.55, grass * 0.9, n3), strip * 0.7);
  dirt = mix(dirt, earth * 0.6, crust * 0.5 * (1.0 - rut));
  m.alb += dirt * tD;
  m.bump += ((n3 - 0.5) * 0.003 + stD.x * 0.01 - rut * 0.004) * tD * fine;
  m.spec += 0.03 * rut * tD;
  m.rough = mix(0.72, 0.55, rut * tD);
  }

  if (tS > 0.001) {
  // --- stone paving: irregular slabs, worn rounded edges, dirt and moss in the joints,
  // each slab its own tone; kerb blocks at the edges.
  let vc = voronoi2(p * 1.6);
  let gap = vc.y - vc.x;
  let joint = smoothstep(0.02 + fw * 1.6, 0.12 + fw * 1.6, gap);
  let slabT = fract(vc.z * 5.3);
  var slab = mix(vec3f(0.34, 0.31, 0.27), vec3f(0.50, 0.46, 0.39), slabT) * (0.85 + 0.25 * n2) * (0.92 + 0.12 * n3);
  slab = mix(slab, slab * 1.12, smoothstep(0.1, 0.3, gap) * 0.5); // polished centres
  var stone = mix(mix(soil * 0.42, vec3f(0.12, 0.13, 0.07), smoothstep(0.5, 0.7, n1) * 0.6), slab, joint);
  let kerb = smoothstep(hw - 0.45, hw - 0.4, d);
  let kb = fract(jd * 1.25);
  let kj = smoothstep(0.0, 0.06, kb) * smoothstep(1.0, 0.94, kb);
  stone = mix(stone, mix(soil * 0.45, vec3f(0.40, 0.37, 0.32) * (0.9 + 0.2 * n2), kj), kerb);
  stone = mix(stone, soil * 0.75, smoothstep(0.55, 0.85, NA.w) * 0.35);
  m.alb += stone * tS;
  m.bump += (joint - 1.0) * 0.012 * tS * fine;
  m.spec += 0.03 * tS;
  m.rough = mix(m.rough, 0.62, tS);
  }
  // Toward the ice: the red earth greys into frozen gravel, then rime frost settles on it.
  let grav = smoothstep(0.22, 0.5, wr.y) * (1.0 - smoothstep(0.2, 0.45, wr.z)) * (1.0 - modK);
  if (grav > 0.0) {
    let gravel = W.bp[BK + B_SOIL].rgb * (0.85 + 0.4 * n2) * (0.9 + 0.2 * n3);
    m.alb = mix(m.alb, gravel, grav * 0.85);
    let frost = smoothstep(0.45, 0.72, wr.y + 0.1 * (NB.y - 0.5)); // the lane frosts only once the snowfield has
    m.alb = mix(m.alb, vec3f(0.62, 0.68, 0.76), frost * 0.85 * (1.0 - modK));
    m.shoulder = mix(m.shoulder, W.bp[BK + B_SOIL].rgb, grav);
  }
  }
  m.alb += mA;
  m.bump += mBump;
  if (modK > 0.001) { m.spec = mix(m.spec, mSpec / modK, modK); m.rough = mix(m.rough, mRough / modK, modK); }

  // --- ice: packed snow lane, clearly darker and greyer than the snowfield: two glossy
  // compacted tyre ruts with frozen gravel churned up in them, a loose-snow crown between
  // them, ploughed white berms with a shadowed foot at the edges.
  if (ice > 0.001) {
    let snow = W.bp[BK + B_GROUND].rgb;
    let gravel = W.bp[BK + B_SOIL].rgb;
    let pack = snow * vec3f(0.42, 0.47, 0.58) * (0.95 + 0.08 * n2); // packed snow: a touch darker and bluer than the drifts
    let tw = abs(d - 0.85 - 0.07 * (n1 - 0.5));
    let rutK = exp(-pow(tw / 0.26, 2.0));
    let churn = smoothstep(0.4, 0.75, NB.z * 0.6 + n3 * 0.4);
    var sr = mix(pack, mix(snow * vec3f(0.26, 0.31, 0.42), gravel * 0.6, 0.35 * churn), rutK * 0.92); // two clean blue-grey ruts
    // Tread marks across the ruts (only where they resolve).
    let tread = (0.5 + 0.5 * sin(jd * 26.0 + d * 3.0)) * rutK * fine * 0.25;
    sr *= 1.0 - tread * 0.4;
    let crown = smoothstep(0.42, 0.12, d) * smoothstep(0.3, 0.7, NA.z);
    sr = mix(sr, snow * 0.7, crown * 0.5);
    let berm = smoothstep(hw - 0.55, hw + 0.15, d + 0.25 * (n2 - 0.5));
    sr = mix(sr, snow * 1.02, berm * 0.92);
    sr *= 1.0 - 0.22 * exp(-pow((d - hw + 0.6) / 0.22, 2.0)); // shadowed berm foot
    // Built lanes keep their surface, with a light frost and ploughed snow at the edges.
    let bermM = smoothstep(hw - 0.4, hw + 0.15, d + 0.2 * (n2 - 0.5));
    sr = sr * (1.0 - modK) + mix(mA * (1.0 + 0.3 * smoothstep(0.3, 0.7, NA.z)), snow * 1.02 * modK, bermM * 0.92);
    m.alb = select(sr, mix(m.alb, sr, ice), ice < 0.97);
    m.spec = mix(m.spec, mix(0.03, m.spec, modK), ice);
    m.rough = mix(m.rough, mix(mix(0.8, 0.6, rutK), m.rough, modK), ice);
    m.bump = mix(m.bump, mix(((n2 - 0.5) * 0.004 - rutK * 0.025 + berm * 0.035 - tread * 0.004) * fine, mBump + bermM * 0.03 * fine, modK), ice);
    m.cover = mix(m.cover, 1.0 - smoothstep(hw + 0.4 + rag * 0.5, hw + 1.1 + rag * 0.5, d), ice * (1.0 - modK));
    m.shoulder = mix(m.shoulder, snow, ice);
  }
  // --- desert: compacted, darker sand track with two wheel ruts; loose sand drifts across
  // it in tongues from the downwind side.
  // Per era: trail = faint compacted sand; dirt track = darker, cooler compacted earth with
  // firm edges and two dark ruts; paving = pale limestone slabs in courses with dark joints
  // and a kerb, sand drifted only at the edges.
  if (sand > 0.001) {
    let sandC = W.bp[2u * BK + B_GROUND].rgb;
    let rr = abs(d - 0.85 - 0.08 * (n1 - 0.5));
    let rutS = exp(-pow(rr / 0.3, 2.0));
    let edgeD = smoothstep(hw - 0.9, hw - 0.1, d); // 0 in the lane, 1 at the edge
    var st = vec3f(0.0);
    var sb = 0.0;
    if (tT > 0.001) {
      var tr = sandC * vec3f(0.80, 0.76, 0.74) * (0.9 + 0.15 * n1);
      tr = mix(tr, sandC * vec3f(0.66, 0.6, 0.58), rutS * 0.8);
      st += tr * tT;
      sb -= rutS * 0.018 * tT;
    }
    if (tD > 0.001) {
      var tk = vec3f(0.235, 0.21, 0.185) * (0.92 + 0.12 * n1) * (0.95 + 0.08 * n3);
      let rutD = exp(-pow(rr / 0.24, 2.0));
      tk = mix(tk, vec3f(0.11, 0.10, 0.095), rutD * 0.9);
      tk = mix(tk, vec3f(0.29, 0.26, 0.225), smoothstep(0.45, 0.1, d) * 0.5); // raised crown
      tk = mix(tk, vec3f(0.16, 0.145, 0.13), smoothstep(hw - 0.35, hw - 0.12, d)); // firm dark edge
      st += tk * tD;
      sb -= (rutD * 0.022 - (n3 - 0.5) * 0.003) * tD;
    }
    if (tS > 0.001) {
      // Sun-bleached limestone in staggered courses: small, slightly irregular slabs (the
      // joints wander with noise), each its own tone, sand-filled low-contrast joints and
      // softly worn edges. The colour is derived from the sand so it always belongs to it.
      let wv = (NB.x - 0.5) * 0.12; // joint wander
      let dd = d + 2.0 + wv;
      let ri = floor(dd / 0.62);
      let slen = 0.78 + 0.22 * hash2(i32(ri), 517); // course-specific slab length
      let along = (f32(jd) + wv * 0.8) / slen + hash2(i32(ri), 911) * 0.9;
      let ci = floor(along);
      let jw = 0.008 + fw * 1.2;
      let ju = min(fract(along), 1.0 - fract(along)) * slen;
      let jv = min(fract(dd / 0.62), 1.0 - fract(dd / 0.62)) * 0.62;
      let joint = smoothstep(jw, jw + 0.07, min(ju, jv)); // wide falloff = worn, rounded edges
      let tone = hash2(i32(ci) + 313, i32(ri) * 7 + 11);
      let sl = dot(sandC, vec3f(0.3, 0.55, 0.15));
      let limeB = mix(sandC, vec3f(sl) * vec3f(1.05, 1.0, 0.88), 0.38) * 1.07; // warm-grey, a touch lighter than the sand
      var lime = limeB * (0.93 + 0.1 * tone) * (0.95 + 0.08 * n2);
      let fill = smoothstep(0.35, 0.7, n3 * 0.6 + NB.y * 0.4); // sand packed into the joints
      lime = mix(mix(limeB * 0.78, sandC * 0.97, fill), lime, joint);
      let kerb = smoothstep(hw - 0.42, hw - 0.36, d);
      let kb = fract(f32(jd) * 1.1);
      let kj = smoothstep(0.0, 0.08, kb) * smoothstep(1.0, 0.92, kb);
      lime = mix(lime, mix(limeB * 0.8, limeB * 0.94 * (0.95 + 0.1 * n2), kj), kerb);
      st += lime * tS;
      sb += ((joint - 1.0) * 0.006 * (1.0 - fill * 0.6) + kerb * 0.02) * tS;
    }
    st += mA;
    sb += mBump;
    // Loose sand drifts in tongues; on the paved road only along the edges.
    let tng = rn.x * 0.7 + NA.y * 0.3 + smoothstep(0.3, hw + 0.4, d) * 0.3;
    let tongue = mix(smoothstep(0.55, 0.75, tng), smoothstep(0.4, 0.7, tng + 0.15), tB) * mix(1.0, edgeD * 0.95, tB) * mix(1.0, 0.5 + 0.5 * edgeD, tD) * (1.0 - 0.6 * modK);
    st = mix(st, sandC * (0.95 + 0.12 * n2), tongue * 0.85);
    m.alb = select(st, mix(m.alb, st, sand), sand < 0.97);
    m.bump = mix(m.bump, (sb + tongue * 0.01 + (n3 - 0.5) * 0.003) * fine, sand);
    m.spec = mix(m.spec, mix(0.025 + 0.02 * tS, m.spec, modK), sand);
    m.rough = mix(m.rough, mix(mix(0.75, 0.6, tS), m.rough, modK), sand);
    // Firm edges for the built road (the trail stays ragged).
    let firm = 1.0 - smoothstep(hw - edge, hw + edge, d + rag * 0.12);
    m.cover = mix(m.cover, firm, sand * (1.0 - tT));
    m.shoulder = mix(m.shoulder, sandC * mix(0.9, 0.78, tD), sand);
  }
  return m;
}
`;
