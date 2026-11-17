// WebGPU device, render targets, the fixed pass sequence and GPU timing.
//
// Frame = [transmittance LUT (only when dirty)] -> sky-view LUT -> shadow -> main (HDR,
// 4x MSAA, reverse-Z) -> bloom (one compute pass) -> tonemap + grade + era ripple to the
// canvas (+ overlays). Time-lapse sky / ripple uniforms come from src/timefx.js.
//
// Scene modules plug in through drawables (see addDrawable). Each frame gpu.js calls
//   d.shadow(pass)  inside the shadow pass   (optional; pipelines from shadowPipeline())
//   d.main(pass)    inside the main HDR pass (pipelines from mainPipeline())
// and overlays (addOverlay) get o.overlay(pass) in the final LDR canvas pass.
// Bind group 0 is always set by gpu.js before calling you; use group 1+ for your own.
//
// Nothing in renderFrame() allocates JS objects except what the WebGPU API itself
// returns (command encoder, passes, command buffer, current canvas texture). Timestamp
// readback maps one buffer per 32 frames, which costs one Promise from mapAsync.

import { FRAME_FLOATS } from './shaders/common.js';
import { TRANSMITTANCE_WGSL, SKYVIEW_WGSL, SKY_WGSL, TONEMAP_WGSL, BLOOM_WGSL, RIPPLE_WGSL, RIPPLE_SEGS } from './shaders/sky.js';
import { writeTimeFx, FX_OFF } from './timefx.js';
import { camera, lookAt, ortho, mul } from './camera.js';
import { env, state } from './state.js';

const U = typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage : {};
const B = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage : {};

export const gpu = {
  device: null,
  adapter: null,
  adapterInfo: null, // plain object: vendor, architecture, device, description, isFallbackAdapter
  context: null,
  canvas: null,
  format: 'bgra8unorm', // canvas format
  hdrFormat: 'rgba16float',
  depthFormat: 'depth32float',
  shadowFormat: 'depth32float',
  sampleCount: 4,
  shadowSize: 4096,
  width: 0,
  height: 0,
  frameBuffer: null, // GPUBuffer holding the Frame uniform block
  frameData: new Float32Array(FRAME_FLOATS),
  mainBGL: null, // group(0) layout for main-pass pipelines
  shadowBGL: null, // group(0) layout for shadow-pass pipelines
  mainBG: null,
  shadowBG: null,
  // Far shadow cascade (appended): rendered only when planShadow1() asks for it.
  shadow1Size: 2048,
  shadow1Radius: 1000,
  shadow1Now: false, // re-render the far cascade this frame
  cascade: 0, // which cascade drawables' shadow(p) is rendering (0 near, 1 far)
};

export const timing = {
  supported: false,
  enabled: false, // main.js turns this on for the H overlay and script mode
  // Rolling window of recent GPU frame times (ms), newest at ringPos - 1.
  ring: new Float32Array(240),
  ringPos: 0,
  ringCount: 0,
  // Optional long log for script mode: main.js assigns a Float32Array, resets logCount
  // and sets the frame window [logFrom, logTo) (frame numbers from timing.frames).
  log: null,
  passLog: null, // optional Float32Array(log.length * 14): per-pass durations in pass order
  logFrames: null, // optional Int32Array(log.length): the frame number of each logged entry
  spanLog: null, // same frames: first-begin to last-end span (ms)
  logCount: 0,
  logFrom: 0,
  logTo: Infinity,
  frames: 0, // frames submitted so far (the number of the next frame)
  // Per-frame bitmask of expensive scene events (set by scene modules via timing.frameEvents
  // |= bit before renderFrame), indexed by frame & 8191; lets perf runs attribute spikes.
  events: new Uint8Array(8192),
  frameEvents: 0,
  lastMappedFrame: -1, // newest frame whose GPU time has been read back
  dropped: 0, // batches skipped because every readback buffer was still mapping
  // Precision probe: gcd of all observed timestamp deltas (ns), and samples seen.
  gcdNs: 0,
  samples: 0,
  rawFirst: -1,
};

const drawables = [];
const overlays = [];
const prePasses = [];
// d.transparent(pass) (optional) runs in the main pass after the sky, for blended geometry.
export function addDrawable(d) { drawables.push(d); }
// p.pre(encoder) runs first in every frame's command encoder (compute / offscreen passes).
export function addPrePass(p) { prePasses.push(p); }
export function removeDrawable(d) { const i = drawables.indexOf(d); if (i >= 0) drawables.splice(i, 1); }
export function addOverlay(o) { overlays.push(o); }

// ---------------------------------------------------------------------------------
// Pipeline helpers. `layouts` are the extra bind group layouts for group 1, 2, ...

export function mainPipeline({ label, module, vertex = 'vs', fragment = 'fs', layouts = [], buffers = [],
  topology = 'triangle-list', cullMode = 'back', depthWrite = true, depthCompare = 'greater', blend, constants, alphaToCoverage = false }) {
  const d = gpu.device;
  return d.createRenderPipelineAsync({
    label,
    layout: d.createPipelineLayout({ bindGroupLayouts: [gpu.mainBGL, ...layouts] }),
    vertex: { module, entryPoint: vertex, buffers, constants },
    fragment: { module, entryPoint: fragment, targets: [{ format: gpu.hdrFormat, blend }], constants },
    primitive: { topology, cullMode },
    depthStencil: { format: gpu.depthFormat, depthWriteEnabled: depthWrite, depthCompare },
    multisample: { count: gpu.sampleCount, alphaToCoverageEnabled: alphaToCoverage },
  });
}

export function shadowPipeline({ label, module, vertex = 'vsShadow', layouts = [], buffers = [],
  topology = 'triangle-list', cullMode = 'none', constants }) {
  const d = gpu.device;
  return d.createRenderPipelineAsync({
    label,
    layout: d.createPipelineLayout({ bindGroupLayouts: [gpu.shadowBGL, ...layouts] }),
    vertex: { module, entryPoint: vertex, buffers, constants },
    primitive: { topology, cullMode },
    depthStencil: { format: gpu.shadowFormat, depthWriteEnabled: true, depthCompare: 'less',
      depthBias: 2, depthBiasSlopeScale: 2.0, depthBiasClamp: 0 },
  });
}

export function overlayPipeline({ label, module, vertex = 'vs', fragment = 'fs', layouts = [], buffers = [],
  topology = 'triangle-list', blend }) {
  const d = gpu.device;
  return d.createRenderPipelineAsync({
    label,
    layout: d.createPipelineLayout({ bindGroupLayouts: [gpu.mainBGL, ...layouts] }),
    vertex: { module, entryPoint: vertex, buffers },
    fragment: { module, entryPoint: fragment, targets: [{ format: gpu.format, blend }] },
    primitive: { topology },
  });
}

// ---------------------------------------------------------------------------------

let transPipe, skyViewPipe, skyPipe, tonemapPipe, ripplePipe;
// Bloom chain: down[0..5] at 1/2 .. 1/64 resolution, up[0..4]; one bind group per dispatch.
let bloomBGL, bloomDown0, bloomDown, bloomUp, bloomSamp, bloomDummy;
const BLOOM_LEVELS = 6;
const bloomTex = [], bloomUpTex = [], bloomBG = [], bloomWG = new Uint32Array(BLOOM_LEVELS * 2 * 2);
const bloomPass = { timestampWrites: undefined };
const BLOOM_OFF = typeof location !== 'undefined' && /[?&](nobloom=1|fx=0)/.test(location.search);
let transBG, skyViewBG, tonemapBG, tonemapBGL;
let transTex, skyLutTex, shadowTex, msaaTex, msaaDepthTex, hdrTex, shadowTex1, frameBuffer1, shadowBG1;
const frameData1 = new Float32Array(FRAME_FLOATS);
const lvp1 = new Float32Array(16);
const sh1 = new Float64Array(8); // last centre x, z, sun x, y, z
const sh1i = new Int32Array(4); // frames since, valid, forced
const sh1Eye = new Float32Array(3), sh1Ctr = new Float32Array(3), sh1Up = new Float32Array([0, 1, 0]);
const sh1A = new Float32Array(16), sh1B = new Float32Array(16);
let transDirty = true, lastMie = -1;
let useTextureAsView = false;
let transientUsage = 0;

const submitList = [null];
const clearBlack = { r: 0, g: 0, b: 0, a: 1 };

const transPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: clearBlack }], timestampWrites: undefined };
const skyViewPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: clearBlack }], timestampWrites: undefined };
const shadowPass = { colorAttachments: [], depthStencilAttachment: { view: null, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: undefined };
const shadowPass1 = { colorAttachments: [], depthStencilAttachment: { view: null, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: undefined };
const mainPass = {
  colorAttachments: [{ view: null, resolveTarget: null, loadOp: 'clear', storeOp: 'discard', clearValue: clearBlack }],
  depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  timestampWrites: undefined,
};
const outPassColor = { view: null, loadOp: 'clear', storeOp: 'store', clearValue: clearBlack };
const outPass = { colorAttachments: [outPassColor], timestampWrites: undefined };

// Timestamp machinery.
const TS_FRAMES = 32;
const TS_READBACKS = 4;
let querySet, resolveBuf;
const readbacks = [];
const readbackBusy = new Uint8Array(TS_READBACKS);
const readbackCount = new Uint8Array(TS_READBACKS);
const readbackFirst = new Float64Array(TS_READBACKS);
let batchFirst = 0;
const mapOk = [];
const mapFail = [];
// Every pass of a frame gets its own begin/end pair (tsw()). A frame's GPU time ("busy") is
// the union of its pass intervals: overlapping passes (Apple GPUs overlap consecutive
// passes) count once, and gaps between passes (the GPU running the compositor, other apps,
// or waiting for the canvas texture) do not count. The span from the first begin to the
// last end is reported alongside.
const PPF = 14; // max timed passes per frame
const passWrites = []; // [slot * PPF + k] -> timestampWrites
const passCount = new Uint8Array(TS_FRAMES);
const readbackPasses = [];
const ivB = new Float64Array(PPF), ivE = new Float64Array(PPF);
let passIdx = 0, timedNow = false;
let tsSlot = 0;
let tsWasEnabled = false;

function fail(msg) {
  const el = document.getElementById('nogpu');
  if (el) {
    el.style.display = 'flex';
    const m = el.querySelector('.why');
    if (m) m.textContent = msg;
  }
  window.__gpuError = msg;
  return false;
}

export async function initGpu(canvas) {
  if (!navigator.gpu) return fail('This browser does not expose WebGPU (navigator.gpu is missing).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return fail('No WebGPU adapter is available on this machine.');
  const info = adapter.info || {};
  gpu.adapter = adapter;
  gpu.adapterInfo = {
    vendor: info.vendor || '',
    architecture: info.architecture || '',
    device: info.device || '',
    description: info.description || '',
    isFallbackAdapter: !!(info.isFallbackAdapter || adapter.isFallbackAdapter),
  };
  const features = [];
  if (adapter.features.has('timestamp-query')) features.push('timestamp-query');
  if (adapter.features.has('float32-filterable')) features.push('float32-filterable');
  let device;
  try {
    device = await adapter.requestDevice({ requiredFeatures: features });
  } catch (e) {
    return fail('WebGPU device creation failed: ' + e.message);
  }
  gpu.device = device;
  timing.supported = features.includes('timestamp-query');
  device.lost.then((e) => { if (e.reason !== 'destroyed') fail('The GPU device was lost: ' + e.message); });
  device.addEventListener('uncapturederror', (e) => console.error('[webgpu]', e.error.message));

  // MSAA colour/depth are NOT memoryless by default. When the main pass overflows the tiler's
  // parameter buffer (dense grass), Metal does a partial render; with memoryless targets it
  // first has to allocate and wire ~230 MiB of backing for them (~1900 128 KiB "Wire Memory"
  // events in Metal System Trace), stalling that frame's main pass by 10-20 ms (forest/coast
  // single 21-28 ms frames). With real backing a partial render costs only a store/reload.
  // ?transient=1 restores memoryless targets for comparison.
  if (U.TRANSIENT_ATTACHMENT && /[?&]transient=1/.test(location.search)) transientUsage = U.TRANSIENT_ATTACHMENT;

  gpu.canvas = canvas;
  gpu.context = canvas.getContext('webgpu');
  gpu.format = navigator.gpu.getPreferredCanvasFormat();
  gpu.context.configure({ device, format: gpu.format, alphaMode: 'opaque', usage: U.RENDER_ATTACHMENT | (GRAB ? U.COPY_SRC : 0) });

  // --- frame uniforms and shared layouts
  gpu.frameBuffer = device.createBuffer({ size: FRAME_FLOATS * 4, usage: B.UNIFORM | B.COPY_DST });
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  gpu.mainBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: VF, texture: {} },
    { binding: 2, visibility: VF, texture: {} },
    { binding: 3, visibility: VF, sampler: {} },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
  ] });
  gpu.shadowBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
  const transBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
  const skyViewBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: VF, texture: {} },
    { binding: 2, visibility: VF, sampler: {} },
  ] });
  tonemapBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
  ] });
  const CS = GPUShaderStage.COMPUTE;
  bloomBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: CS, buffer: {} },
    { binding: 1, visibility: CS, texture: { sampleType: 'float' } },
    { binding: 2, visibility: CS, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    { binding: 3, visibility: CS, sampler: {} },
    { binding: 4, visibility: CS, texture: { sampleType: 'float' } },
  ] });

  // --- fixed-size targets
  const RT = U.RENDER_ATTACHMENT | U.TEXTURE_BINDING;
  transTex = device.createTexture({ size: [256, 64], format: 'rgba16float', usage: RT });
  skyLutTex = device.createTexture({ size: [192, 128], format: 'rgba16float', usage: RT });
  shadowTex = device.createTexture({ size: [gpu.shadowSize, gpu.shadowSize], format: gpu.shadowFormat, usage: RT });
  shadowTex1 = device.createTexture({ size: [gpu.shadow1Size, gpu.shadow1Size], format: gpu.shadowFormat, usage: RT });
  frameBuffer1 = device.createBuffer({ size: FRAME_FLOATS * 4, usage: B.UNIFORM | B.COPY_DST });
  camera.shadowSize = gpu.shadowSize;
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const shadowSamp = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });

  transPass.colorAttachments[0].view = transTex.createView();
  skyViewPass.colorAttachments[0].view = skyLutTex.createView();
  shadowPass.depthStencilAttachment.view = shadowTex.createView();
  shadowPass1.depthStencilAttachment.view = shadowTex1.createView();

  gpu.mainBG = device.createBindGroup({ layout: gpu.mainBGL, entries: [
    { binding: 0, resource: { buffer: gpu.frameBuffer } },
    { binding: 1, resource: transTex.createView() },
    { binding: 2, resource: skyLutTex.createView() },
    { binding: 3, resource: linSamp },
    { binding: 4, resource: shadowTex.createView() },
    { binding: 5, resource: shadowSamp },
    { binding: 6, resource: shadowTex1.createView() },
  ] });
  gpu.shadowBG = device.createBindGroup({ layout: gpu.shadowBGL, entries: [{ binding: 0, resource: { buffer: gpu.frameBuffer } }] });
  shadowBG1 = device.createBindGroup({ layout: gpu.shadowBGL, entries: [{ binding: 0, resource: { buffer: frameBuffer1 } }] });
  transBG = device.createBindGroup({ layout: transBGL, entries: [{ binding: 0, resource: { buffer: gpu.frameBuffer } }] });
  skyViewBG = device.createBindGroup({ layout: skyViewBGL, entries: [
    { binding: 0, resource: { buffer: gpu.frameBuffer } },
    { binding: 1, resource: transTex.createView() },
    { binding: 2, resource: linSamp },
  ] });

  // --- built-in pipelines
  const transMod = device.createShaderModule({ label: 'transmittance', code: TRANSMITTANCE_WGSL });
  const skyViewMod = device.createShaderModule({ label: 'skyview', code: SKYVIEW_WGSL });
  const skyMod = device.createShaderModule({ label: 'sky', code: SKY_WGSL });
  const toneMod = device.createShaderModule({ label: 'tonemap', code: TONEMAP_WGSL });
  const bloomMod = device.createShaderModule({ label: 'bloom', code: BLOOM_WGSL });
  const bloomLayout = device.createPipelineLayout({ bindGroupLayouts: [bloomBGL] });
  bloomSamp = linSamp;
  bloomDummy = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: U.TEXTURE_BINDING });
  const lutTarget = [{ format: 'rgba16float' }];
  const rippleMod = device.createShaderModule({ label: 'ripple', code: RIPPLE_WGSL });
  const ADD = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  [transPipe, skyViewPipe, skyPipe, tonemapPipe, ripplePipe] = await Promise.all([
    device.createRenderPipelineAsync({ label: 'trans', layout: device.createPipelineLayout({ bindGroupLayouts: [transBGL] }),
      vertex: { module: transMod, entryPoint: 'vsFull' }, fragment: { module: transMod, entryPoint: 'fsTrans', targets: lutTarget } }),
    device.createRenderPipelineAsync({ label: 'skyview', layout: device.createPipelineLayout({ bindGroupLayouts: [skyViewBGL] }),
      vertex: { module: skyViewMod, entryPoint: 'vsFull' }, fragment: { module: skyViewMod, entryPoint: 'fsSkyView', targets: lutTarget } }),
    mainPipeline({ label: 'sky', module: skyMod, vertex: 'vsSky', fragment: 'fsSky', cullMode: 'none', depthWrite: false, depthCompare: 'equal' }),
    device.createRenderPipelineAsync({ label: 'tonemap', layout: device.createPipelineLayout({ bindGroupLayouts: [tonemapBGL] }),
      vertex: { module: toneMod, entryPoint: 'vsFull' }, fragment: { module: toneMod, entryPoint: 'fsTonemap', targets: [{ format: gpu.format }] } }),
    mainPipeline({ label: 'ripple', module: rippleMod, vertex: 'vsRipple', fragment: 'fsRipple', cullMode: 'none', depthWrite: false, depthCompare: 'greater', blend: ADD }),
  ]);
  [bloomDown0, bloomDown, bloomUp] = await Promise.all(['down0', 'down', 'up'].map((e) =>
    device.createComputePipelineAsync({ label: 'bloom-' + e, layout: bloomLayout, compute: { module: bloomMod, entryPoint: e } })));

  // --- timestamps
  if (timing.supported) {
    querySet = device.createQuerySet({ type: 'timestamp', count: TS_FRAMES * PPF * 2 });
    resolveBuf = device.createBuffer({ size: TS_FRAMES * PPF * 16, usage: B.QUERY_RESOLVE | B.COPY_SRC });
    for (let k = 0; k < TS_READBACKS; k++) {
      readbackPasses.push(new Uint8Array(TS_FRAMES));
      readbacks.push(device.createBuffer({ size: TS_FRAMES * PPF * 16, usage: B.MAP_READ | B.COPY_DST }));
      mapOk.push(() => onMapped(k));
      mapFail.push(() => { readbackBusy[k] = 0; });
    }
    for (let i = 0; i < TS_FRAMES * PPF; i++) passWrites.push({ querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 });
  }

  // Can a GPUTexture be used directly where a view is expected? Saves a createView per frame.
  device.pushErrorScope('validation');
  try {
    const t = device.createTexture({ size: [4, 4], format: gpu.format, usage: U.RENDER_ATTACHMENT });
    const e = device.createCommandEncoder();
    const p = e.beginRenderPass({ colorAttachments: [{ view: t, loadOp: 'clear', storeOp: 'store' }] });
    p.end();
    e.finish();
    t.destroy();
  } catch (e) { /* older implementations throw */ }
  useTextureAsView = !(await device.popErrorScope());

  return true;
}

// Recreates the size-dependent targets. Call when the canvas pixel size changes.
export function resize(w, h) {
  w = Math.max(1, w | 0); h = Math.max(1, h | 0);
  if (w === gpu.width && h === gpu.height) return;
  gpu.width = w; gpu.height = h;
  gpu.canvas.width = w; gpu.canvas.height = h;
  const d = gpu.device;
  if (msaaTex) { msaaTex.destroy(); msaaDepthTex.destroy(); hdrTex.destroy(); }
  for (const t of bloomTex) t.destroy();
  for (const t of bloomUpTex) t.destroy();
  bloomTex.length = 0; bloomUpTex.length = 0; bloomBG.length = 0;
  msaaTex = d.createTexture({ size: [w, h], format: gpu.hdrFormat, sampleCount: gpu.sampleCount, usage: U.RENDER_ATTACHMENT | transientUsage });
  msaaDepthTex = d.createTexture({ size: [w, h], format: gpu.depthFormat, sampleCount: gpu.sampleCount, usage: U.RENDER_ATTACHMENT | transientUsage });
  hdrTex = d.createTexture({ size: [w, h], format: gpu.hdrFormat, usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
  mainPass.colorAttachments[0].view = msaaTex.createView();
  mainPass.colorAttachments[0].resolveTarget = hdrTex.createView();
  mainPass.depthStencilAttachment.view = msaaDepthTex.createView();
  // Bloom chain (level k is ceil(size / 2^(k+1))).
  const BU = U.TEXTURE_BINDING | U.STORAGE_BINDING;
  for (let k = 0; k < BLOOM_LEVELS; k++) {
    const bw = Math.max(1, Math.ceil(w / (2 << k))), bh = Math.max(1, Math.ceil(h / (2 << k)));
    bloomTex.push(d.createTexture({ size: [bw, bh], format: 'rgba16float', usage: BU }));
    if (k < BLOOM_LEVELS - 1) bloomUpTex.push(d.createTexture({ size: [bw, bh], format: 'rgba16float', usage: BU }));
    bloomWG[k * 2] = Math.ceil(bw / 8); bloomWG[k * 2 + 1] = Math.ceil(bh / 8);
  }
  const dummy = bloomDummy.createView();
  const bg = (src, dst, add) => d.createBindGroup({ layout: bloomBGL, entries: [
    { binding: 0, resource: { buffer: gpu.frameBuffer } },
    { binding: 1, resource: src.createView() },
    { binding: 2, resource: dst.createView() },
    { binding: 3, resource: bloomSamp },
    { binding: 4, resource: add ? add.createView() : dummy },
  ] });
  // Dispatch order: down 0..5 (src hdr, then the previous level), then up 4..0.
  bloomBG.push(bg(hdrTex, bloomTex[0]));
  for (let k = 1; k < BLOOM_LEVELS; k++) bloomBG.push(bg(bloomTex[k - 1], bloomTex[k]));
  for (let k = BLOOM_LEVELS - 2; k >= 0; k--) {
    const src = k === BLOOM_LEVELS - 2 ? bloomTex[k + 1] : bloomUpTex[k + 1];
    bloomBG.push(bg(src, bloomUpTex[k], bloomTex[k]));
  }
  tonemapBG = d.createBindGroup({ layout: tonemapBGL, entries: [
    { binding: 0, resource: { buffer: gpu.frameBuffer } },
    { binding: 1, resource: hdrTex.createView() },
    { binding: 2, resource: (BLOOM_OFF ? bloomDummy : bloomUpTex[0]).createView() },
    { binding: 3, resource: bloomSamp },
  ] });
}

// Bloom: one compute pass, 11 dispatches (6 down, 5 up), timed as one pass.
function encodeBloom(enc) {
  bloomPass.timestampWrites = tsw();
  const p = enc.beginComputePass(bloomPass);
  let n = 0;
  for (let k = 0; k < BLOOM_LEVELS; k++) {
    p.setPipeline(k === 0 ? bloomDown0 : bloomDown);
    p.setBindGroup(0, bloomBG[n++]);
    p.dispatchWorkgroups(bloomWG[k * 2], bloomWG[k * 2 + 1]);
  }
  p.setPipeline(bloomUp);
  for (let k = BLOOM_LEVELS - 2; k >= 0; k--) {
    p.setBindGroup(0, bloomBG[n++]);
    p.dispatchWorkgroups(bloomWG[k * 2], bloomWG[k * 2 + 1]);
  }
  p.end();
}

function writeFrame() {
  const f = gpu.frameData;
  f.set(camera.viewProj, 0);
  f.set(camera.invViewProj, 16);
  f.set(camera.lightViewProj, 32);
  f[48] = camera.eye[0]; f[49] = camera.eye[1]; f[50] = camera.eye[2]; f[51] = state.time;
  f[52] = env.sunDir[0]; f[53] = env.sunDir[1]; f[54] = env.sunDir[2]; f[55] = env.sunIntensity;
  f[56] = env.fogDensity; f[57] = env.fogFalloff; f[58] = env.exposure; f[59] = env.mieScale;
  f[60] = gpu.width; f[61] = gpu.height;
  f[62] = (camera.shadowRadius * 2) / gpu.shadowSize; f[63] = camera.shadowRadius;
  f[64] = state.view; f[65] = 0; f[66] = 0; f[67] = 0;
  f[68] = env.bounce[0]; f[69] = env.bounce[1]; f[70] = env.bounce[2]; f[71] = env.skyFill;
  f.set(lvp1, 72);
  f[88] = (gpu.shadow1Radius * 2) / gpu.shadow1Size; f[89] = gpu.shadow1Radius; f[90] = gpu.shadow1Now ? 1 : 0; f[91] = sh1i[1];
  const hz = env.haze;
  f[92] = hz ? hz[0] : 1; f[93] = hz ? hz[1] : 1; f[94] = hz ? hz[2] : 1; f[95] = 1;
  writeTimeFx(f); // f[96..119]: time-lapse, clouds, pole, ripple, biome weights
  gpu.device.queue.writeBuffer(gpu.frameBuffer, 0, f);
  if (gpu.shadow1Now) {
    frameData1.set(f);
    frameData1.set(lvp1, 32);
    gpu.device.queue.writeBuffer(frameBuffer1, 0, frameData1);
  }
  if (env.mieScale !== lastMie) { lastMie = env.mieScale; transDirty = true; }
}

// Encode and submit one frame. Camera matrices must already be updated.
export function renderFrame() {
  const device = gpu.device;
  writeFrame();
  const enc = device.createCommandEncoder();

  // Timestamp slot for this frame.
  const timed = timing.supported && timing.enabled;
  if (timed !== tsWasEnabled) { tsSlot = 0; tsWasEnabled = timed; }
  if (tsSlot === 0) batchFirst = timing.frames;
  timedNow = timed; passIdx = 0;
  transPass.timestampWrites = undefined;

  for (let i = 0; i < prePasses.length; i++) prePasses[i].pre(enc);
  timing.events[timing.frames & 8191] = timing.frameEvents; timing.frameEvents = 0;

  let p;
  if (transDirty) {
    transDirty = false;
    transPass.timestampWrites = tsw();
    p = enc.beginRenderPass(transPass);
    p.setPipeline(transPipe); p.setBindGroup(0, transBG); p.draw(3); p.end();
  }

  skyViewPass.timestampWrites = tsw();
  p = enc.beginRenderPass(skyViewPass);
  p.setPipeline(skyViewPipe); p.setBindGroup(0, skyViewBG); p.draw(3); p.end();

  shadowPass.timestampWrites = tsw();
  p = enc.beginRenderPass(shadowPass);
  p.setBindGroup(0, gpu.shadowBG);
  for (let i = 0; i < drawables.length; i++) { const d = drawables[i]; if (d.shadow) d.shadow(p); }
  p.end();

  if (gpu.shadow1Now) {
    // Far cascade: the same drawables, with F.lightViewProj = the far matrix (frameBuffer1);
    // gpu.cascade tells them which caster lists to draw.
    gpu.cascade = 1;
    shadowPass1.timestampWrites = tsw();
    p = enc.beginRenderPass(shadowPass1);
    p.setBindGroup(0, shadowBG1);
    for (let i = 0; i < drawables.length; i++) { const d = drawables[i]; if (d.shadow) d.shadow(p); }
    p.end();
    gpu.cascade = 0;
    gpu.shadow1Now = false;
    sh1i[1] = 1;
    timing.frameEvents |= 64;
  }

  mainPass.timestampWrites = tsw();
  p = enc.beginRenderPass(mainPass);
  p.setBindGroup(0, gpu.mainBG);
  for (let i = 0; i < drawables.length; i++) drawables[i].main(p);
  p.setPipeline(skyPipe); p.setBindGroup(0, gpu.mainBG); p.draw(3);
  for (let i = 0; i < drawables.length; i++) { const d = drawables[i]; if (d.transparent) d.transparent(p); }
  // Era-crossing ripple ring (only while one runs; f[110] is its age, 99 when idle).
  if (gpu.frameData[110] < 1.6 && !FX_OFF) { p.setPipeline(ripplePipe); p.setBindGroup(0, gpu.mainBG); p.draw(RIPPLE_SEGS * 6, 2); }
  p.end();

  if (!BLOOM_OFF) encodeBloom(enc);

  const tex = gpu.context.getCurrentTexture();
  outPassColor.view = useTextureAsView ? tex : tex.createView();
  outPass.timestampWrites = tsw();
  p = enc.beginRenderPass(outPass);
  p.setPipeline(tonemapPipe); p.setBindGroup(0, tonemapBG); p.draw(3);
  if (overlays.length) {
    p.setBindGroup(0, gpu.mainBG);
    for (let i = 0; i < overlays.length; i++) overlays[i].overlay(p);
  }
  p.end();

  let mapK = -1;
  if (timed) {
    passCount[tsSlot] = passIdx;
    tsSlot++;
    if (tsSlot === TS_FRAMES) {
      tsSlot = 0;
      for (let k = 0; k < TS_READBACKS; k++) if (!readbackBusy[k]) { mapK = k; break; }
      if (mapK >= 0) {
        enc.resolveQuerySet(querySet, 0, TS_FRAMES * PPF * 2, resolveBuf, 0);
        enc.copyBufferToBuffer(resolveBuf, 0, readbacks[mapK], 0, TS_FRAMES * PPF * 16);
        readbackPasses[mapK].set(passCount);
        readbackBusy[mapK] = 1;
        readbackCount[mapK] = TS_FRAMES;
        readbackFirst[mapK] = batchFirst;
      } else timing.dropped++;
    }
  }

  const gk = GRAB ? grabCopy(enc, tex) : -1;
  submitList[0] = enc.finish();
  device.queue.submit(submitList);
  submitList[0] = null;
  timing.frames++;
  if (mapK >= 0) readbacks[mapK].mapAsync(GPUMapMode.READ).then(mapOk[mapK], mapFail[mapK]);
  if (gk >= 0) grabMap(gk);
}

// Debug (?grab=1, allocates; tools/flicker-test.mjs): window.__grab.left = n copies the next n
// canvas frames back as luminance (window.__grab.frames: { n: frame number, l: Uint8Array }).
const GRAB = typeof location !== 'undefined' && /[?&]grab=1/.test(location.search);
const grabBufs = [], grabBusy = new Uint8Array(12), grabNo = new Int32Array(12);
if (GRAB) window.__grab = { left: 0, frames: [], missed: 0, w: 0, h: 0 };
function grabCopy(enc, tex) {
  const G = window.__grab;
  if (!(G.left > 0)) return -1;
  const bpr = Math.ceil(tex.width * 4 / 256) * 256;
  if (G.w !== tex.width || G.h !== tex.height) { G.w = tex.width; G.h = tex.height; grabBufs.length = 0; }
  if (!grabBufs.length) for (let k = 0; k < 12; k++) grabBufs.push(gpu.device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  for (let k = 0; k < 12; k++) {
    if (grabBusy[k]) continue;
    grabBusy[k] = 1; grabNo[k] = timing.frames; G.left--;
    enc.copyTextureToBuffer({ texture: tex }, { buffer: grabBufs[k], bytesPerRow: bpr }, [tex.width, tex.height]);
    return k;
  }
  G.missed++;
  return -1;
}
function grabMap(k) {
  const G = window.__grab, w = G.w, h = G.h, bpr = Math.ceil(w * 4 / 256) * 256, bgra = gpu.format === 'bgra8unorm';
  grabBufs[k].mapAsync(GPUMapMode.READ).then(() => {
    const u = new Uint8Array(grabBufs[k].getMappedRange());
    const l = new Uint8Array(w * h);
    const ri = bgra ? 2 : 0, bi = bgra ? 0 : 2;
    for (let y = 0; y < h; y++) for (let x = 0, j = y * bpr, o = y * w; x < w; x++, j += 4) l[o + x] = (u[j + ri] * 54 + u[j + 1] * 183 + u[j + bi] * 19) >> 8;
    G.frames.push({ n: grabNo[k], l });
    grabBufs[k].unmap(); grabBusy[k] = 0;
  }, () => { grabBusy[k] = 0; });
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

function onMapped(k) {
  const buf = readbacks[k];
  const u = new Uint32Array(buf.getMappedRange()); // one view per 32 frames (API-returned buffer)
  const n = readbackCount[k];
  const first = readbackFirst[k];
  for (let i = 0; i < n; i++) {
    const fno = first + i;
    if (fno > timing.lastMappedFrame) timing.lastMappedFrame = fno;
    const np = readbackPasses[k][i];
    let lo = Infinity, hi = 0, ok = np > 0, m = 0;
    for (let q = 0; q < np; q++) {
      const o = (i * PPF + q) * 4;
      const b = u[o + 1] * 4294967296 + u[o];
      const e = u[o + 3] * 4294967296 + u[o + 2];
      if (!(e >= b) || b === 0) { ok = false; break; }
      // insertion sort by begin time
      let j = m++;
      while (j > 0 && ivB[j - 1] > b) { ivB[j] = ivB[j - 1]; ivE[j] = ivE[j - 1]; j--; }
      ivB[j] = b; ivE[j] = e;
      if (timing.passLog && timing.logCount < timing.log.length) timing.passLog[timing.logCount * PPF + q] = (e - b) * 1e-6;
      if (b < lo) lo = b;
      if (e > hi) hi = e;
      if (timing.rawFirst < 0) timing.rawFirst = b;
      timing.gcdNs = gcd(timing.gcdNs, Math.abs(b - timing.rawFirst));
    }
    // Union of the pass intervals: time the GPU spent on this frame's passes, without
    // double-counting overlapping passes and without the gaps between them.
    let busy = 0, cb = ivB[0], ce = ivE[0];
    for (let q = 1; q < m; q++) {
      if (ivB[q] > ce) { busy += ce - cb; cb = ivB[q]; ce = ivE[q]; } else if (ivE[q] > ce) ce = ivE[q];
    }
    busy += ce - cb;
    if (!ok) continue;
    timing.samples++;
    const ms = busy * 1e-6, spanMs = (hi - lo) * 1e-6;
    timing.ring[timing.ringPos] = ms;
    timing.ringPos = (timing.ringPos + 1) % timing.ring.length;
    if (timing.ringCount < timing.ring.length) timing.ringCount++;
    if (timing.log && fno >= timing.logFrom && fno < timing.logTo && timing.logCount < timing.log.length) {
      if (timing.logFrames) timing.logFrames[timing.logCount] = fno;
      timing.spanLog[timing.logCount] = spanMs;
      timing.log[timing.logCount++] = ms;
    }
  }
  buf.unmap();
  readbackBusy[k] = 0;
}

// timestampWrites for the next pass of this frame (undefined when timing is off). Scene
// modules call it for their own passes: desc.timestampWrites = tsw().
export function tsw() {
  if (!timedNow || passIdx >= PPF) return undefined;
  return passWrites[tsSlot * PPF + passIdx++];
}

// Far shadow cascade planning. Call once per frame after the camera and env are updated and
// before scene modules build their caster lists (world.js updateWorld does). Re-renders the
// cached cascade when its snapped centre moves, the sun moves, or requestShadow1() was
// called (the ground changed); otherwise it is reused as is.
const SH1_SNAP = 64;
export function requestShadow1() { sh1i[2] = 1; }
const PS = new Float64Array(8); // planShadow1 scratch (doubles kept out of locals: no boxing)
// Whether the cached far cascade needs re-rendering (PS[3..5] computed by the caller).
function shadow1Due() {
  // Sun moved more than ~4 mrad; while it keeps moving (biome transitions) refresh at most
  // every 4th frame.
  const sunMoved = PS[5] < 0.999992 && sh1i[0] >= 3;
  sh1i[0]++;
  return PS[3] !== sh1[0] || PS[4] !== sh1[1] || sunMoved || sh1i[2] !== 0 || sh1i[1] === 0 || sh1i[0] > 600;
}
export function planShadow1() {
  const R = gpu.shadow1Radius;
  PS[0] = camera.target[0] - camera.eye[0]; PS[1] = camera.target[2] - camera.eye[2];
  PS[2] = Math.sqrt(PS[0] * PS[0] + PS[1] * PS[1]) + 1e-6;
  PS[3] = Math.round((camera.eye[0] + PS[0] / PS[2] * R * 0.5) / SH1_SNAP) * SH1_SNAP;
  PS[4] = Math.round((camera.eye[2] + PS[1] / PS[2] * R * 0.5) / SH1_SNAP) * SH1_SNAP;
  const s = env.sunDir;
  PS[5] = s[0] * sh1[2] + s[1] * sh1[3] + s[2] * sh1[4];
  // Sun moved more than ~4 mrad; while it keeps moving (biome transitions) refresh at most
  // every 4th frame.
  if (!shadow1Due()) return;
  sh1[0] = PS[3]; sh1[1] = PS[4]; sh1[2] = s[0]; sh1[3] = s[1]; sh1[4] = s[2]; sh1i[0] = 0; sh1i[2] = 0;
  sh1Ctr[0] = PS[3]; sh1Ctr[1] = camera.eye[1]; sh1Ctr[2] = PS[4];
  sh1Eye[0] = PS[3] + s[0] * 3000; sh1Eye[1] = sh1Ctr[1] + s[1] * 3000; sh1Eye[2] = PS[4] + s[2] * 3000;
  if (Math.abs(s[1]) > 0.99) { sh1Up[0] = 0; sh1Up[1] = 0; sh1Up[2] = 1; } else { sh1Up[0] = 0; sh1Up[1] = 1; sh1Up[2] = 0; }
  lookAt(sh1A, sh1Eye, sh1Ctr, sh1Up);
  ortho(sh1B, -R, R, -R, R, 1, 6000);
  mul(lvp1, sh1B, sh1A);
  const half = gpu.shadow1Size * 0.5;
  PS[6] = lvp1[12] * half; PS[7] = lvp1[13] * half;
  lvp1[12] += (Math.round(PS[6]) - PS[6]) / half;
  lvp1[13] += (Math.round(PS[7]) - PS[7]) / half;
  gpu.shadow1Now = true;
}
// The far cascade's matrix (valid once rendered) and centre, for culling caster lists.
export const shadow1 = { matrix: lvp1, center: sh1 };

// Resolves when all submitted GPU work has finished (used by pose capture).
export function gpuIdle() { return gpu.device.queue.onSubmittedWorkDone(); }
