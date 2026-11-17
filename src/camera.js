// Camera maths, scripted path and fixed poses. Column-major mat4 in Float32Array
// (m[col * 4 + row]), right-handed, -z forward. The main projection is reverse-Z with an
// infinite far plane: depth = near / distance, cleared to 0, compared with 'greater'.
// Nothing here allocates after module load.

import { env, state } from './state.js';
import { car, pose, buildMatrices, bodyPoint } from './car.js'; // first-person rig only (runtime use; the import cycle is safe)
import { groundInfo } from './world/world.js'; // witness rig only (runtime use; same cycle pattern)

export const camera = {
  eye: new Float32Array([0, 10, 0]),
  target: new Float32Array([0, 10, -1]),
  up: new Float32Array([0, 1, 0]),
  fovY: 1.0, // radians (vertical)
  near: 0.1,
  aspect: 16 / 9,
  view: new Float32Array(16),
  proj: new Float32Array(16),
  viewProj: new Float32Array(16),
  invViewProj: new Float32Array(16),
  // Directional shadow (single cascade centred near the camera).
  shadowRadius: 160, // metres covered from the centre to the map edge
  shadowSize: 4096, // texels; must match gpu.js
  lightViewProj: new Float32Array(16),
};

const tmpA = new Float32Array(16);
const tmpB = new Float32Array(16);
const tmpM = new Float32Array(16);

export function lookAt(out, eye, target, up) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  let l = 1 / Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx *= l; fy *= l; fz *= l;
  let sx = fy * up[2] - fz * up[1], sy = fz * up[0] - fx * up[2], sz = fx * up[1] - fy * up[0];
  l = 1 / Math.sqrt(sx * sx + sy * sy + sz * sz);
  sx *= l; sy *= l; sz *= l;
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = sz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  out[15] = 1;
  return out;
}

// Reverse-Z, infinite far plane.
export function perspectiveRevInf(out, fovY, aspect, near) {
  const f = 1 / Math.tan(fovY * 0.5);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = near;
  return out;
}

// Orthographic, depth 0..1 (near..far), conventional (not reversed).
export function ortho(out, l, r, b, t, n, f) {
  out.fill(0);
  out[0] = 2 / (r - l);
  out[5] = 2 / (t - b);
  out[10] = -1 / (f - n);
  out[12] = -(r + l) / (r - l);
  out[13] = -(t + b) / (t - b);
  out[14] = -n / (f - n);
  out[15] = 1;
  return out;
}

// out = a * b. Safe when out aliases a or b.
export function mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    tmpM[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    tmpM[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    tmpM[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    tmpM[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  out.set(tmpM);
  return out;
}

export function invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return out;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

const lightEye = new Float32Array(3);
export const lightCenter = new Float32Array(3); // shadow map centre (world), set by updateCamera
const lightUp = new Float32Array([0, 1, 0]);

// Rebuilds view/proj/viewProj/invViewProj and the shadow matrix. Call once per frame
// after eye/target/aspect are set.
export function updateCamera(cam) {
  lookAt(cam.view, cam.eye, cam.target, cam.up);
  perspectiveRevInf(cam.proj, cam.fovY, cam.aspect, cam.near);
  mul(cam.viewProj, cam.proj, cam.view);
  invert(cam.invViewProj, cam.viewProj);

  // Shadow: centre the cascade a bit ahead of the camera, on the view direction.
  const R = cam.shadowRadius;
  let fx = cam.target[0] - cam.eye[0], fz = cam.target[2] - cam.eye[2];
  const fl = Math.sqrt(fx * fx + fz * fz) || 1;
  fx /= fl; fz /= fl;
  lightCenter[0] = cam.eye[0] + fx * R * 0.55;
  lightCenter[1] = cam.eye[1];
  lightCenter[2] = cam.eye[2] + fz * R * 0.55;
  const s = env.sunDir, D = 1500;
  lightEye[0] = lightCenter[0] + s[0] * D;
  lightEye[1] = lightCenter[1] + s[1] * D;
  lightEye[2] = lightCenter[2] + s[2] * D;
  if (Math.abs(s[1]) > 0.99) { lightUp[0] = 0; lightUp[1] = 0; lightUp[2] = 1; }
  else { lightUp[0] = 0; lightUp[1] = 1; lightUp[2] = 0; }
  lookAt(tmpA, lightEye, lightCenter, lightUp);
  ortho(tmpB, -R, R, -R, R, 1, D * 2);
  const m = mul(cam.lightViewProj, tmpB, tmpA);
  // Snap the projection to whole shadow texels so edges do not shimmer while moving.
  const half = cam.shadowSize * 0.5;
  const ox = m[12] * half, oy = m[13] * half;
  m[12] += (Math.round(ox) - ox) / half;
  m[13] += (Math.round(oy) - oy) / half;
}

// ---------------------------------------------------------------------------------
// Camera rigs. `pose` is the car's interpolated sim state (see car.js: 0..2 position,
// 3 heading, 12..14 chase-camera position, 15 chase yaw). They write cam.eye / cam.target
// and the field of view; updateCamera() builds the matrices.

const FOV_CHASE = 0.92, FOV_FP = 1.02;
const tmp3 = new Float64Array(3);

// Third person: the chase position is spring-damped in the sim step; look a little ahead of
// the car so curves open up in front of it.
export function chaseRig(cam, pose) {
  cam.fovY = FOV_CHASE;
  cam.eye[0] = pose[12]; cam.eye[1] = pose[13]; cam.eye[2] = pose[14];
  const h = pose[3];
  cam.target[0] = pose[0] + Math.cos(h) * 5.5;
  cam.target[1] = pose[1] + 1.25;
  cam.target[2] = pose[2] + Math.sin(h) * 5.5;
}

// First person at the driver's eye (car-local, x = left), looking ~8 degrees down so the
// bonnet, both dials, the wheel's upper half and the head unit frame the road (interior.js).
// The car matrices are rebuilt first: drive.js calls this before uploadCar(), and with last
// frame's bodyMat the eye trailed the cockpit by one frame of travel (0.7 m at 40 m/s).
// Head motion, all derived from the current sim state (deterministic in capture mode):
// the head leans into the turn and glances toward its inside, bobs with the suspension,
// sinks back under acceleration and shakes slightly with the surface. The horizon stays level.
const FP_EYE_X = 0.36, FP_EYE_Y = 1.32, FP_EYE_Z = -0.58, FP_PITCH = -0.142;
export function firstPersonRig(cam, bodyPoint) {
  buildMatrices();
  cam.fovY = FOV_FP;
  const latN = Math.max(-1.2, Math.min(1.2, car.aLat / 10)); // > 0 turning right
  const v = Math.abs(pose[16]);
  const off = car.roadDist > car.hw + 0.5, sf = car.surf;
  const rough = (off ? 0.0022 : sf < 1 ? 0.0012 : sf < 2 ? 0.0008 : 0.0003) * Math.min(1, v / 25);
  const d = car.dist;
  const shake = rough * (Math.sin(d * 7.3) * Math.sin(d * 2.9 + 1.3) + 0.5 * Math.sin(d * 13.7 + 0.4));
  const ex = FP_EYE_X - 0.028 * latN; // local x is left: leaning right = smaller x
  const ey = FP_EYE_Y - 0.35 * car.bodyOff + shake;
  const ez = FP_EYE_Z - Math.max(-0.02, Math.min(0.02, car.aLong * 0.0025));
  tmp3[0] = ex; tmp3[1] = ey; tmp3[2] = ez;
  bodyPoint(tmp3);
  cam.eye[0] = tmp3[0]; cam.eye[1] = tmp3[1]; cam.eye[2] = tmp3[2];
  const look = Math.max(-0.13, Math.min(0.13, car.yawRate * 0.42)); // glance into the bend
  const D = 14;
  tmp3[0] = ex - Math.sin(look) * D; tmp3[1] = ey + Math.tan(FP_PITCH) * D; tmp3[2] = ez + Math.cos(look) * D;
  bodyPoint(tmp3);
  cam.target[0] = tmp3[0]; cam.target[1] = tmp3[1]; cam.target[2] = tmp3[2];
}

// ---------------------------------------------------------------------------------
// Witness: the event moment (DESIGN.md "Event moment"). Near a live landmark the HUD offers
// `E`; pressing it slows time to WIT_SCALE for ~10 s while the camera leaves the car on an arc
// (a slight roll that eases level), frames the landmark (sites.js witnessBegin: the landmark's
// `witness` block or a default from its radius and height), holds the shot for ~6.5 s while it
// keeps drifting slowly round and in (so the caption can be read), then eases back to the driving
// rig of the view it started from. `E` again or a drive key ends it early (same ease-back).
//
//   initWitness(begin, io, prompt, show, hide)  once (main.js): sites.js witnessBegin /
//                         witnessIO and the ui.js prompt / letterbox calls
//   witnessKey()          E pressed: starts or ends it. Returns an event id whose flourish
//                         main.js should play (already logged before), else -1.
//   witnessEnd()          ease back now (a drive key)
//   witnessRig(cam)       every frame after applyView(); wIO[0] = real seconds since the last
//                         frame while the game runs (0 when paused)
//   witness               { on, scale (sim time multiplier), ev, w (0 driving .. 1 shot) }
// Allocates nothing per frame.

export const witness = { on: false, scale: 1, ev: -1, w: 0 };
export const wIO = new Float64Array(2);
const WIT_SCALE = 0.12, WIT_IN = 1.8, WIT_TOTAL = 10.0, WIT_OUT = 1.7, WIT_SLOW = 0.55, WIT_ROLL = 0.1;
// [0] t (real s), [1] exiting, [2] w at exit start, [3] exit t, [4] roll sign, [5] start view,
// [6] prompt shown, [7] previous w
const WS = new Float64Array(8);
const WSHOT = new Float64Array(16); // filled by sites.js witnessBegin (see there)
const DR = { eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array([0, 1, 0]), fovY: 1 };
const GQ = new Float64Array(8);
let wBegin = null, wSites = null, wPrompt = null, wShow = null, wHide = null;

export function initWitness(begin, io, prompt, show, hide) { wBegin = begin; wSites = io; wPrompt = prompt; wShow = show; wHide = hide; }

export function witnessKey() {
  if (witness.on) { witnessEnd(); return -1; }
  if (!wBegin || !wSites || wSites[0] < 0) return -1;
  const ev = wBegin(WSHOT);
  if (ev < 0) return -1;
  witness.on = true; witness.ev = ev; witness.w = 0; witness.scale = 1;
  WS[0] = 0; WS[1] = 0; WS[2] = 0; WS[3] = 0; WS[7] = 0;
  WS[5] = state.view;
  // Roll into the swing: the side the shot lies on relative to the current view direction.
  const cam = camera;
  const fx = cam.target[0] - cam.eye[0], fz = cam.target[2] - cam.eye[2];
  const sx = WSHOT[0] - cam.eye[0], sz = WSHOT[2] - cam.eye[2];
  WS[4] = fx * sz - fz * sx > 0 ? 1 : -1;
  if (wPrompt) wPrompt(false);
  WS[6] = 0;
  if (wShow) wShow(ev);
  return WSHOT[10] > 0 ? -1 : ev;
}

export function witnessEnd() {
  if (!witness.on || WS[1] > 0) return;
  WS[1] = 1; WS[2] = witness.w; WS[3] = 0;
  if (wHide) wHide();
}

function smoother(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * x * (x * (x * 6 - 15) + 10); }

// The driving rig of the view the moment started from (state.view is forced to third person
// while the camera is away from the car).
function drivingRig() {
  if (WS[5] === 1) firstPersonRig(DR, bodyPoint);
  else chaseRig(DR, pose);
}

export function witnessRig(cam) {
  const dt = wIO[0];
  // The prompt: only while the game runs and no moment is playing (written on change only).
  const want = !witness.on && dt > 0 && wSites !== null && wSites[0] >= 0 ? 1 : 0;
  if (want !== WS[6]) { WS[6] = want; if (wPrompt) wPrompt(want === 1); }
  if (!witness.on) return;
  WS[0] += dt;
  const t = WS[0];
  if (WS[1] === 0 && t >= WIT_TOTAL - WIT_OUT) witnessEnd();
  let w, slow;
  if (WS[1] > 0) {
    WS[3] += dt;
    const wx = WS[2] > 0.05 ? WS[2] : 0.05;
    const dur = WIT_OUT * (0.45 + 0.55 * wx);
    w = wx * (1 - smoother(WS[3] / dur));
    slow = w / wx;
    if (WS[3] >= dur) { finish(cam); return; }
  } else {
    w = smoother(t / WIT_IN);
    slow = smoother(t / WIT_SLOW);
  }
  witness.w = w;
  witness.scale = 1 - (1 - WIT_SCALE) * slow;

  drivingRig();
  // The shot: a slow orbit (drift) and push-in over the whole moment, so the held shot never
  // reads as a freeze frame.
  const p = t / WIT_TOTAL < 1 ? t / WIT_TOTAL : 1;
  const a = WSHOT[4] + WSHOT[7] * (p - 0.5);
  const dist = WSHOT[3] * (1 - 0.07 * p);
  const sx = WSHOT[0] + Math.cos(a) * dist, sz = WSHOT[2] + Math.sin(a) * dist, sy = WSHOT[5];
  // Eye along an arc from the driving eye to the shot's.
  const ex0 = DR.eye[0], ey0 = DR.eye[1], ez0 = DR.eye[2];
  let ex = ex0 + (sx - ex0) * w, ey = ey0 + (sy - ey0) * w, ez = ez0 + (sz - ez0) * w;
  const mx = sx - ex0, my = sy - ey0, mz = sz - ez0;
  const span = Math.sqrt(mx * mx + my * my + mz * mz);
  const arc = Math.sin(Math.PI * w);
  ey += arc * (span * 0.22 < 60 ? span * 0.22 : 60);
  // Never below the ground (or inside the near terrain) on the way.
  GQ[6] = ex; GQ[7] = ez; groundInfo(GQ);
  const clear = GQ[0] + 1.8, k = w * 8 < 1 ? w * 8 : 1;
  if (ey < clear) ey += (clear - ey) * k;
  cam.eye[0] = ex; cam.eye[1] = ey; cam.eye[2] = ez;
  // Look direction: yaw (shortest way) and pitch blended between the two rigs.
  let dx = DR.target[0] - ex0, dy = DR.target[1] - ey0, dz = DR.target[2] - ez0;
  const y0 = Math.atan2(dz, dx), p0 = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  dx = WSHOT[0] - sx; dy = WSHOT[1] - sy; dz = WSHOT[2] - sz;
  const y1 = Math.atan2(dz, dx), p1 = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  let dyaw = y1 - y0;
  dyaw -= 6.283185307 * Math.floor(dyaw / 6.283185307 + 0.5);
  const yaw = y0 + dyaw * w, pitch = p0 + (p1 - p0) * w, cp = Math.cos(pitch);
  const fx = Math.cos(yaw) * cp, fy = Math.sin(pitch), fz = Math.sin(yaw) * cp;
  cam.target[0] = ex + fx * 50; cam.target[1] = ey + fy * 50; cam.target[2] = ez + fz * 50;
  cam.fovY = DR.fovY + (WSHOT[6] - DR.fovY) * w;
  // Roll: banks into the swing, level again once the shot is held.
  const r = WS[4] * WIT_ROLL * arc * (1 - 0.35 * w), cr = Math.cos(r), sr = Math.sin(r);
  cam.up[0] = -fz * sr; cam.up[1] = cr; cam.up[2] = fx * sr;
  // The car body (third person) once the eye is clear of the cabin; the cockpit returns
  // with the eye.
  if (WS[5] === 1) {
    const qx = ex - ex0, qy = ey - ey0, qz = ez - ez0;
    state.view = qx * qx + qy * qy + qz * qz > 6.25 ? 0 : 1;
  }
}

function finish(cam) {
  witness.on = false; witness.w = 0; witness.scale = 1; witness.ev = -1;
  state.view = WS[5];
  cam.up[0] = 0; cam.up[1] = 1; cam.up[2] = 0;
  drivingRig();
  cam.eye.set(DR.eye); cam.target.set(DR.target); cam.fovY = DR.fovY;
}

// Elevated establishing shot: behind and to the side of the car, 16 m above it.
export function orbitRig(cam, pose) {
  const side = 0.9, back = 30, up = 16;
  cam.fovY = FOV_CHASE;
  const h = pose[3] + side * 0.35;
  cam.eye[0] = pose[0] - Math.cos(h) * back; cam.eye[1] = pose[1] + up; cam.eye[2] = pose[2] - Math.sin(h) * back;
  cam.target[0] = pose[0] + Math.cos(pose[3]) * 60; cam.target[1] = pose[1] - 2; cam.target[2] = pose[2] + Math.sin(pose[3]) * 60;
}
