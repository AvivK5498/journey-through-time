// Standalone landmark viewer page (bundled by tools/viewer.mjs with one landmark module
// aliased as 'jt-landmark'). Boots gpu.js without main.js: sky, fog, sun and shadows are the
// game's; the ground is a large flat plane tinted for the biome with a strip of road where
// the contract puts it (along local z, centre line at x = -roadOffset(def), or x = 0 for
// landmarks that straddle the road).
//
// URL: ?built=1&decay=0&seed=1&sun=day|low|dusk&biome=<name>&t=7.3 (biome: any of the seven
// in src/world/biomes.js; the coast also gets open water beyond local x = 160 m, the sea side,
// with kit SEA set to match so def.animate's a.seaX / seaY work as in the game).
// window.__time(t) sets the frame time (motion: def.animate's a.t, flicker, smoke).
// Exposes window.__info (build report), window.__view(camera) -> Promise<bool>,
// window.__state(built, decay) (handle.setState: the live state, no rebuild) and
// window.__cost(camera, frames) -> Promise<{ on, off }> (median GPU frame ms with the
// landmark drawn and hidden; the difference is the landmark's cost from that camera).

import def from 'jt-landmark';
import { gpu, initGpu, resize, renderFrame, gpuIdle, addDrawable, mainPipeline, timing } from '../gpu.js';
import { camera, updateCamera, lookAt, ortho, mul } from '../camera.js';
import { state, env, updateSun } from '../state.js';
import { BIOMES, applyEnv, carBiome } from '../world/biomes.js';
import { MAIN_HEADER } from '../shaders/common.js';
import {
  LandmarkBuilder, initLandmarkKit, buildLandmark, uploadLandmark, checkLandmark, hashBuild, roadOffset, ROAD, BIOME_INDEX, SEA,
} from '../world/landmarks/kit.js';

const W = 2560, H = 1440;
const q = new URLSearchParams(location.search);
const num = (k, d) => { const v = parseFloat(q.get(k)); return isFinite(v) ? v : d; };
const built = num('built', 1), decay = num('decay', 0), seed = num('seed', 1) | 0;
const sun = q.get('sun') === 'low' ? 'low' : q.get('sun') === 'dusk' ? 'dusk' : 'day';
const biome = BIOME_INDEX[q.get('biome')] ?? (typeof def.biome === 'number' ? def.biome : BIOME_INDEX[def.biome]) ?? 0;
const SEA_X = 160; // coast: open water beyond this local x (the side away from the road)
const tFix = num('t', 7.3);
let handle = null;

const GROUND_WGSL = MAIN_HEADER + /* wgsl */ `
struct GU { ground: vec4f, alt: vec4f, soil: vec4f, cover: vec4f, sea: vec4f };
// ground.w: road centre x, alt.w: patchiness, soil.w: road half width, cover.w: cover amount,
// sea.x: open water beyond this x (1e9: none)
@group(1) @binding(0) var<uniform> U: GU;
struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var c = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let p = vec3f(c[i].x * 12000.0, 0.0, c[i].y * 12000.0);
  var o: VO;
  o.wp = p;
  o.pos = F.viewProj * vec4f(p, 1.0);
  return o;
}
fn h2(p: vec2i) -> f32 {
  var h = (u32(p.x) * 73856093u) ^ (u32(p.y) * 19349663u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32((h ^ (h >> 16u)) & 0xffffffu) / 16777215.0;
}
fn n2(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2i(1, 0)), f.x), mix(h2(i + vec2i(0, 1)), h2(i + vec2i(1, 1)), f.x), f.y);
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let p = i.wp.xz;
  let pt = n2(p * 0.02) * 0.6 + n2(p * 0.11) * 0.4;
  var alb = mix(U.ground.rgb, U.alt.rgb, smoothstep(0.35, 0.75, pt) * (0.5 + U.alt.w));
  alb *= 0.85 + 0.3 * n2(p * 1.7);
  alb = mix(alb, U.cover.rgb, U.cover.w * 0.8 * smoothstep(0.3, 0.6, n2(p * 0.05 + 7.0)));
  // road strip along z
  let dx = abs(p.x - U.ground.w);
  let hw = U.soil.w;
  let road = 1.0 - smoothstep(hw - 0.5, hw + 0.4, dx + (n2(p * 0.7) - 0.5) * 0.5);
  var ra = U.soil.rgb * (0.85 + 0.25 * n2(p * 3.0));
  let rut = exp(-pow((dx - 1.0) / 0.22, 2.0));
  ra *= 1.0 - 0.18 * rut;
  alb = mix(alb, ra, road);
  // coast: wet sand, then open water (dark, with a faint sky sheen toward the horizon)
  let sea = smoothstep(U.sea.x - 4.0, U.sea.x + 4.0, p.x + (n2(p * 0.03) - 0.5) * 12.0);
  alb = mix(alb, alb * 0.6, smoothstep(U.sea.x - 30.0, U.sea.x, p.x) * (1.0 - sea));
  alb = mix(alb, vec3f(0.018, 0.04, 0.05), sea);
  var c = shadeLambert(alb, vec3f(0.0, 1.0, 0.0), i.wp, 1.0);
  let vd = normalize(i.wp - F.camPos);
  c += sea * skyRadiance(normalize(reflect(vd, vec3f(0.0, 1.0, 0.0)) + vec3f(0.0, 0.02, 0.0))) * (0.02 + 0.3 * pow(1.0 - abs(vd.y), 5.0));
  c = applyFog(c, i.wp);
  return vec4f(c, 1.0);
}
`;

async function initGround(roadCx) {
  const d = gpu.device;
  const bgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const B = BIOMES[biome];
  const u = new Float32Array([
    ...B.ground.slice(0, 3), roadCx,
    ...B.groundAlt.slice(0, 3), B.groundAlt[3],
    ...B.soil.slice(0, 3), ROAD.halfWidth,
    ...B.cover.slice(0, 3), B.cover[3],
    biome === 6 ? SEA_X : 1e9, 0, 0, 0,
  ]);
  const ub = d.createBuffer({ size: u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ub, 0, u);
  const bg = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub } }] });
  const pipe = await mainPipeline({ label: 'viewer-ground', module: d.createShaderModule({ code: GROUND_WGSL }), layouts: [bgl], cullMode: 'none' });
  addDrawable({ main(p) { p.setPipeline(pipe); p.setBindGroup(1, bg); p.draw(6); } });
}

// ---------------------------------------------------------------------------------
// Cameras. Travel is toward -z; distances are to the landmark origin along the road.

const FOV_DRIVE = 1.08, FOV_VIEW = 0.92;
const R = def.radius;
const rx = roadOffset(def);
const roadCx = -rx;
const centreY = Math.min(R * 0.25, 20);
const lv = new Float32Array(16), lp = new Float32Array(16), lEye = new Float32Array(3), lC = new Float32Array(3), lUp = new Float32Array([0, 1, 0]);

function set(eye, target, fov) {
  camera.eye[0] = eye[0]; camera.eye[1] = eye[1]; camera.eye[2] = eye[2];
  camera.target[0] = target[0]; camera.target[1] = target[1]; camera.target[2] = target[2];
  camera.fovY = fov;
}
function drive(dist) {
  const ex = roadCx, ey = ROAD.eye, ez = dist;
  // Look down the road, turned halfway toward the landmark (a driver glancing at it).
  let tx = 0 - ex, ty = centreY - ey, tz = 0 - ez;
  const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
  let fx = tx * 0.5, fy = ty * 0.5, fz = -1 * 0.5 + tz * 0.5;
  const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  set([ex, ey, ez], [ex + fx * 100, ey + fy * 100, ez + fz * 100], FOV_DRIVE);
}
function detailCam() {
  const dt = def.detail || {};
  const at = dt.at || [0, Math.min(2, R * 0.15), 0];
  const from = dt.from || [at[0] - R * 0.45 - 2, at[1] + R * 0.25 + 1, at[2] + R * 0.3];
  set(from, at, dt.fov || FOV_VIEW);
  return Math.hypot(from[0] - at[0], from[1] - at[1], from[2] - at[2]);
}
// Time-lapse camera for --strip: def.strip { at, from, fov } when the landmark gives one
// (framed so the change reads), else the drive_near view.
function stripCam() {
  const st = def.strip;
  if (!st) { drive(60); return false; }
  set(st.from, st.at, st.fov || FOV_VIEW);
  return true;
}
// Returns false when the camera does not apply to this landmark.
function setCamera(name) {
  switch (name) {
    case 'drive_far': drive(250); return true;
    case 'drive_near': drive(60); return true;
    case 'pass':
      if (def.straddlesRoad) set([R + 25, 1.7, 0], [0, centreY, 0], FOV_VIEW);
      else set([roadCx, ROAD.eye, 0], [0, centreY, 0], FOV_VIEW);
      return true;
    case 'three_quarter': {
      const D = Math.max(R * 2.4, 28);
      set([-D * 0.72, D * 0.48, D * 0.72], [0, R * 0.1, 0], FOV_VIEW);
      return true;
    }
    case 'detail': detailCam(); return true;
    case 'strip': stripCam(); return true;
    case 'inside':
      if (!def.straddlesRoad) return false;
      set([0, ROAD.eye, 0], [0, ROAD.eye - 0.3, -50], FOV_DRIVE);
      return true;
  }
  return false;
}

// Non-driving views centre the shadow map on the landmark and widen it to cover it; the
// driving views keep the game's camera-following cascade (radius 160 m).
// Close-up views (detail, a framed strip) centre a tight cascade on what they look at, as a
// near cascade would: radius ~1.6 x the viewing distance (30-160 m).
function shadowOnLandmark(cx = 0, cz = 0, radius = 0) {
  const Rs = radius > 0 ? radius : Math.max(160, R * 1.3);
  camera.shadowRadius = Rs;
  const s = env.sunDir, D = 1500;
  lC[0] = cx; lC[1] = 0; lC[2] = cz;
  lEye[0] = cx + s[0] * D; lEye[1] = s[1] * D; lEye[2] = cz + s[2] * D;
  lookAt(lv, lEye, lC, lUp);
  ortho(lp, -Rs, Rs, -Rs, Rs, 1, D * 2);
  mul(camera.lightViewProj, lp, lv);
}

async function view(name) {
  if (!setCamera(name)) return false;
  camera.aspect = W / H;
  camera.shadowRadius = 160;
  updateCamera(camera);
  if (name === 'detail' || (name === 'strip' && def.strip)) {
    const t = camera.target, e = camera.eye;
    const dist = Math.hypot(t[0] - e[0], t[1] - e[1], t[2] - e[2]);
    // target is 100 m down the view ray only for driving views; here it is the look-at point
    shadowOnLandmark(t[0], t[2], Math.min(160, Math.max(30, dist * 1.6)));
  } else if (name !== 'drive_far' && name !== 'drive_near' && name !== 'strip') shadowOnLandmark();
  renderFrame();
  await gpuIdle();
  renderFrame(); // second frame: identical state; makes sure the canvas has presented
  await gpuIdle();
  return true;
}

// Median GPU frame time (ms) over n frames with the landmark drawn and with it hidden.
// The GPU is shared with other processes: use medians and compare on and off back to back.
async function cost(name, n = 90) {
  if (!setCamera(name)) return null;
  camera.aspect = W / H;
  camera.shadowRadius = 160;
  updateCamera(camera);
  timing.enabled = true;
  const res = {};
  for (const vis of [true, false, true, false]) {
    handle.visible = vis;
    const f0 = timing.frames;
    for (let i = 0; i < n; i++) { renderFrame(); if ((i & 7) === 7) await gpuIdle(); }
    await gpuIdle();
    await new Promise((r) => setTimeout(r, 150));
    const got = Math.min(n - 8, timing.ringCount, timing.frames - f0);
    const a = [];
    for (let i = 0; i < got; i++) a.push(timing.ring[(timing.ringPos - 1 - i + timing.ring.length) % timing.ring.length]);
    a.sort((x, y) => x - y);
    const k = vis ? 'on' : 'off';
    const med = a.length ? a[a.length >> 1] : NaN;
    res[k] = res[k] === undefined ? med : Math.min(res[k], med);
  }
  handle.visible = true;
  timing.enabled = false;
  return { on: +res.on.toFixed(3), off: +res.off.toFixed(3), landmark: +(res.on - res.off).toFixed(3) };
}

async function boot() {
  const canvas = document.getElementById('c');
  if (!(await initGpu(canvas))) return;
  resize(W, H);
  state.biomeA = state.biomeB = biome; state.biomeBlend = 0;
  for (let k = 0; k < carBiome.length; k++) carBiome[k] = k === biome ? 1 : 0; // applyEnv blends from these
  applyEnv();
  if (biome === 6) { SEA[0] = 0; SEA[1] = 1; SEA[2] = 0; } // the sea toward local +x, level with the ground
  // The viewer lights the landmark from the road side (front lit), behind the driver.
  if (sun === 'low') { env.sunElevation = 0.075; env.sunAzimuth = 2.75; }
  else env.sunAzimuth = def.viewSunAz ?? 2.4; // def.viewSunAz: optional per-landmark day sun (viewer only)
  if (sun === 'dusk') { // the modern era's end of day (settle.js applyDusk at full strength)
    env.sunElevation = 0.045; env.sunIntensity *= 0.75; env.exposure *= 1.55;
  }
  env.sunAzimuth = num('az', env.sunAzimuth); env.sunElevation = num('el', env.sunElevation);
  updateSun();
  state.time = tFix; // fixed: deterministic flicker and FX
  await Promise.all([initLandmarkKit(), initGround(roadCx)]);

  const b = new LandmarkBuilder();
  let t0 = performance.now();
  buildLandmark(def, b, built, decay, seed, biome);
  const ms = performance.now() - t0;
  const h1 = hashBuild(b);
  t0 = performance.now();
  const counts = buildLandmark(def, b, built, decay, seed, biome);
  const ms2 = performance.now() - t0;
  const h2 = hashBuild(b);
  const warnings = checkLandmark(def, b);
  if (h1 !== h2) warnings.push('build() is not deterministic (two builds with the same inputs differ)');
  const lights = [];
  for (let i = 0; i < 2; i++) { const o = i * 12, L = b.lights; if (L[o + 7] > 0) lights.push({ pos: [L[o], L[o + 1], L[o + 2]].map((v) => +v.toFixed(2)), intensity: +L[o + 7].toFixed(2), range: L[o + 3], flicker: L[o + 8] }); }
  handle = uploadLandmark(def, b, 0, 0, 0, 0, seed);
  handle.setState(built, decay);
  window.__info = {
    id: def.id, name: def.name, straddlesRoad: !!def.straddlesRoad, radius: R, pad: def.pad, roadOffset: rx,
    vertices: counts.vertices, triangles: counts.triangles, a2cTriangles: counts.a2c, fxTriangles: counts.fx, live: !!def.live, buildMs: +ms.toFixed(2), rebuildMs: +ms2.toFixed(2),
    bounds: { maxR: +b.bounds.maxR.toFixed(2), minY: +b.bounds.minY.toFixed(2), maxY: +b.bounds.maxY.toFixed(2) },
    lights, warnings, built, decay, seed, sun, biome: q.get('biome') || def.biome || 'savannah',
  };
  window.__view = view;
  window.__state = (bu, de) => { handle.setState(bu, de); return true; };
  window.__cost = cost;
  window.__time = (t) => { state.time = t; return true; };
  window.__gpu = { ...gpu.adapterInfo };
  await view('three_quarter');
  window.__ready = true;
}

boot().catch((e) => { console.error(e); window.__gpuError = String((e && e.stack) || e); });
