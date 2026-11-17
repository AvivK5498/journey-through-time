// Time-travel effects state: the time-lapse amount, cloud drift, the celestial pole of the
// sun's daily path, and the era-crossing ripple. gpu.js calls writeTimeFx(frameData) once
// per frame (after the camera and car matrices are final) and it fills Frame.timeFx ..
// Frame.biomeW (white balance, see shaders/common.js). Allocates nothing per frame.
//
//   triggerRipple(eraIdx)  start the era-crossing ripple now (also fires by itself whenever
//                          state.eraIdx changes)
//   timeFx                 { lapse, force } : lapse is the smoothed 0..1 time-lapse amount;
//                          set force to a number of years/s to override state.timeRate (tools)
//
// URL (debug): ?rate=<years/s> forces state.timeRate (and the lapse follows instantly);
// ?ripple=<age s> pins a ripple at that age (captures), ?ripple=loop re-fires every 3 s;
// ?fx=0 turns the sky effects, bloom and grade off (for A/B costing).

import { state, env } from './state.js';
import { camera, witness } from './camera.js';
import { bodyPoint } from './car.js'; // runtime use only (same cycle pattern as camera.js)
import { carBiome } from './world/biomes.js';

const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const RATE_URL = Q.has('rate') ? Math.max(0, parseFloat(Q.get('rate')) || 0) : NaN;
const RIPPLE_Q = Q.get('ripple');
const RIPPLE_PIN = RIPPLE_Q && RIPPLE_Q !== 'loop' ? Math.max(0, parseFloat(RIPPLE_Q) || 0.5) : NaN;
const RIPPLE_LOOP = RIPPLE_Q === 'loop';
export const FX_OFF = Q.get('fx') === '0';
const NO_CLOUDS = Q.get('clouds') === '0'; // debug: hide the cloud layer

// dir: -1 runs the sky backwards (the ending's rewind: stars, sun beads and clouds reverse).
export const timeFx = { lapse: 0, force: NaN, frame: null, ripple: null, dir: 1 };
if (typeof window !== 'undefined') { window.__timefx = timeFx; timeFx.ripple = (e) => triggerRipple(e); }

export const RIPPLE_SECONDS = 1.5;
// Era colours for the crossing flash: 0 Origins (fire amber), 1 First farmers (wheat and
// barley gold), 2 Ancient empires (lapis), 3 Connected world (madder red of silk and
// manuscripts), 4 Sail and science (sea teal), 5 Industry (steam silver-blue), 6 Modern
// (electric violet). Ripples fire at clock 40, 80, 120, 165, 210 and 255.
// Per biome (0-6: savannah, ice, desert, forest, steppe, mountains, coast): cloud cover and the
// white balance the grade applies (Frame.biomeW.xyz): savannah gold, ice cool cyan, desert
// apricot, forest cool and green-grey, steppe wide and warm, mountains crisp blue, coast luminous.
const BIO_CLOUD = new Float32Array([0.42, 0.5, 0.24, 0.5, 0.3, 0.46, 0.3]);
const BIO_WB = new Float32Array([1.035, 1.0, 0.95, 0.95, 1.0, 1.06, 1.045, 0.995, 0.93, 0.965, 1.0, 1.025,
  1.03, 1.01, 0.955, 0.965, 0.995, 1.05, 1.005, 1.0, 0.985]);
const ERA_COL = new Float32Array([1.0, 0.62, 0.3, 0.98, 0.8, 0.42, 0.42, 0.7, 1.0, 0.92, 0.4, 0.42, 0.34, 0.86, 0.8,
  0.74, 0.8, 0.94, 0.68, 0.52, 1.0]);
const ERA_N = 7;

// Clouds: noise cell size (m) at 1 x stretch, and the wind direction (unit, xz).
const CELL = 1500;
const WX = 0.8, WZ = 0.6;
// Sky path geometry. The band is the key sun's daily path drawn as the great circle through the
// key sun and a point T a little above the view centre (so it always arcs across the frame);
// the star trails circle a pole kept in the upper sky on the side away from the sun. Both
// follow the camera heading slowly (POLE_TAU s) so turns do not swing the sky.
// T_ELEV, T_AZ, STAR_AZ, STAR_EL are fractions of the vertical field of view.
const ARC_MIN = 0.55, T_ELEV = 0.26, T_AZ = 0.42, STAR_AZ = 0.55, STAR_EL = 0.36, POLE_TAU = 3.0;

const S = new Float64Array(20); // [0] lapse, [1] off along, [2] off across, [3] star phase,
// [4] last time, [5] last cam x, [6] last cam z, [7] ripple age, [8] ripple era, [9] last era,
// [10] inited, [11] ripple centre u, [12] v, [13] loop timer, [14] bead phase, [15] fine off along
S[7] = 99; S[9] = -1;
const P = new Float64Array(4); // band pole (smoothed)
const SP = new Float64Array(4); // star pole (smoothed)
const G = new Float64Array(3);
const DBG = new Float64Array(9); // debug: band construction (window.__timefx.dbg)
timeFx.dbg = DBG; // ripple ground centre (world)

function smoothDir(o, x, y, z, a) {
  o[0] += (x - o[0]) * a; o[1] += (y - o[1]) * a; o[2] += (z - o[2]) * a;
  const l = Math.sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]) || 1;
  o[0] /= l; o[1] /= l; o[2] /= l;
}

export function triggerRipple(eraIdx) {
  S[7] = 0;
  S[8] = eraIdx === undefined ? state.eraIdx : eraIdx;
}

// Lapse at 90 years/s (the knee below which the later eras' curve takes over).
const KNEE = 90, KNEE_L = 1 - Math.pow(1 - Math.log(1 + KNEE * 0.25) / Math.log(1751), 2.2);
const LOG_KNEE = Math.log(1 + KNEE / 0.4);
function lapseOf(rate) {
  // From 90 years/s up (eras 1-3): log mapping x (0.42 at 90, 0.58 at 300, 1 at 7000), eased
  // up as 1 - (1 - x)^2.2: about 0.7 at 90, 0.85 at 300, 1 at 7000.
  // Below 90 (eras 4-7 cruise at 21, 6.7, 3.6 and 2.5 years/s, and every era while slowing)
  // it falls gently, 0.7 x (log(1 + r / 0.4) / log(1 + 90 / 0.4))^0.2: ~0.66 at 21, 0.62 at
  // 6.7, 0.58 at 2.5. Even 2.5 years/s is ~900 days a second, so the sun stays a band of
  // light and the seasons keep pulsing; the lower level slows the beads, star wheel and
  // cloud race, so the present reads as time decelerating, never as a stop. 0 when stopped.
  // Everything (sun band, beads, clouds, stars, seasons) is driven by this one smoothed level.
  const x = Math.log(1 + rate * 0.25) / Math.log(1751);
  const hi = x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 2.2);
  const y = Math.log(1 + (rate > 0 ? rate : 0) / 0.4) / LOG_KNEE;
  let k = rate * 4; k = k < 0 ? 0 : k > 1 ? 1 : k; // below 0.25 years/s (nearly stopped) it collapses
  const lo = KNEE_L * Math.pow(y, 0.2) * k * k * (3 - 2 * k);
  return rate >= KNEE ? hi : lo;
}

export function writeTimeFx(f) {
  timeFx.frame = f;
  // Time step from the frame clock (pose mode holds it still; capture mode steps it).
  let dt = state.time - S[4];
  S[4] = state.time;
  if (!(dt > 0)) dt = 0; else if (dt > 0.5) dt = 0.5;

  if (RATE_URL === RATE_URL) state.timeRate = RATE_URL;
  if (timeFx.force === timeFx.force) state.timeRate = timeFx.force;
  // The event moment (camera.js witness) holds time almost still: the sky settles with it.
  const target = lapseOf(state.timeRate) * (1 - 0.7 * witness.w);
  if (RATE_URL === RATE_URL && timeFx.force !== timeFx.force) S[0] = target;
  else S[0] += (target - S[0]) * (1 - Math.exp(-dt * 6));
  const L = S[0];
  timeFx.lapse = L;
  // The event moment keeps the scene's look: the sky's morph (its averaged day and night, the
  // band, the cooled frame edges, the cloud stretch) holds the level it had when the moment
  // began, while the motion (beads, star wheel, cloud race) slows with time. Blended by the
  // moment's weight, so it eases back as the camera returns.
  const ww = witness.w > 0 ? (witness.w < 1 ? witness.w : 1) : 0;
  S[16] = ww > 0 ? S[16] : L;
  const Lm = L + (S[16] - L) * ww;
  const gm = Math.pow(Lm, 1.5);

  const g = Math.pow(L, 1.5); // shared morph curve (shader uses the same pow(L, 1.5))

  // Clouds: a stretched noise layer that races along the wind as time speeds up. Offsets are
  // integrated (camera parallax + wind) in stretched cell units and wrapped at the noise
  // period (256 cells), so nothing jumps when the stretch changes. The fine octave is
  // stretched less (its own offset) so dashes visibly crawl along the streaks.
  const stretch = 1 + 7 * gm, stretchF = 1 + 2.2 * gm, crossS = 1 - 0.65 * gm; // crossS: shader uses the same
  const cx = camera.eye[0], cz = camera.eye[2];
  let dx = cx - S[5], dz = cz - S[6];
  S[5] = cx; S[6] = cz;
  if (S[10] === 0 || dx * dx + dz * dz > 250000) { dx = 0; dz = 0; }
  const wind = (10 + 15000 * g * g) * dt * timeFx.dir;
  const da = dx * WX + dz * WZ - wind;
  S[1] += da / (CELL * stretch);
  S[15] += da / (CELL * stretchF);
  S[2] += (dx * -WZ + dz * WX - wind * 0.012) / (CELL * crossS);
  S[1] -= Math.floor(S[1] / 256) * 256;
  S[15] -= Math.floor(S[15] / 256) * 256;
  S[2] -= Math.floor(S[2] / 256) * 256;
  // Sky rotation (star trails) and the aliased "beads" of the sun running along its band.
  S[3] = (S[3] + dt * 0.55 * g * g * timeFx.dir + 6.283185307) % 6.283185307;
  // Bead phase: the band's 7 beads pulse each pixel at 12 g^2 / 2pi = 1.9 Hz (< 3 Hz); the
  // season lines sweep at 0.6 / 2pi of it. Wrapped at 10 turns (whole cycles of both).
  S[14] = (S[14] + dt * 12 * g * g * timeFx.dir + 62.83185307) % 62.83185307;

  // Band pole and star pole from the key sun and the camera heading (smoothed).
  let hx = camera.target[0] - cx, hz = camera.target[2] - cz;
  const hl = Math.sqrt(hx * hx + hz * hz) || 1; hx /= hl; hz /= hl;
  // Anchor the band and the star pole in the frame whatever the camera pitch and lens.
  const pitch = Math.atan2(camera.target[1] - camera.eye[1], hl), fv = camera.fovY;
  let sEl = pitch + STAR_EL * fv; sEl = sEl < 0.2 ? 0.2 : sEl > 0.9 ? 0.9 : sEl;
  const sx = env.sunDir[0], sy = env.sunDir[1], sz = env.sunDir[2];
  const side = (sx * -hz + sz * hx) > 0 ? -1 : 1; // +1: the sun is left of the view
  // The band is the small circle through three points: the key sun S, an apex T above the
  // view (pushed away from the sun's side, at least ARC_MIN from the sun in azimuth) and U,
  // the mirror of S about T's azimuth. So it always bows across the frame like a rising and
  // setting arc, never stands up as a pillar when the camera faces a low sun.
  const hAz = Math.atan2(hz, hx), sAz = Math.atan2(sz, sx);
  const sElv = Math.asin(sy < -1 ? -1 : sy > 1 ? 1 : sy);
  let tAz = hAz + T_AZ * fv * side;
  let dTs = tAz - sAz; dTs -= 6.283185307 * Math.floor(dTs / 6.283185307 + 0.5);
  // (Allocation note: every branch below only selects values computed unconditionally. A
  // binary op or compare first reached inside a rarely taken branch deopts the optimised code
  // ("insufficient type feedback"), and once a frame function is back in the interpreter every
  // double it computes is a heap allocation until it re-optimises many seconds later.)
  const dTsC = dTs >= 0 ? ARC_MIN : -ARC_MIN, tAzC = sAz + dTsC;
  if (Math.abs(dTs) < ARC_MIN) { dTs = dTsC; tAz = tAzC; }
  let tEl = pitch + T_ELEV * fv;
  tEl = tEl < 0.12 ? 0.12 : tEl > 0.85 ? 0.85 : tEl;
  // A low sun rises to an apex at T (U mirrors S about T); a sun higher than T is itself the
  // apex and the arc comes down through T (U mirrors T about the sun's azimuth).
  let uAz, uEl;
  let rel = sAz - hAz; rel -= 6.283185307 * Math.floor(rel / 6.283185307 + 0.5);
  const tMax = pitch + 0.4 * fv;
  // side / behind candidates
  const tElS = tEl < 0.17 ? 0.17 : tEl;
  const tAzS = hAz + 0.6 * side, uAzS = hAz - 0.6 * side, uElS = tElS - 0.13;
  // low-sun candidates
  const lo25 = sElv + 0.25, lo08 = sElv + 0.08;
  const c25 = lo25 < tMax, c08 = tMax > lo08, cLow = tEl < lo25;
  const tElL = cLow ? (c25 ? lo25 : c08 ? tMax : lo08) : tEl;
  const uAzL = tAz + dTs, uElL = sElv < 0.03 ? 0.03 : sElv;
  // high-sun candidate
  const uAzH = sAz - dTs;
  const cR1 = rel > 1.2, cR2 = rel < -1.2, cE1 = sElv < tEl + 0.1, cE2 = sElv < 0.35;
  if (cR1 ? true : cR2) {
    // Sun well to the side or behind: the far side of its path crosses the view, through two
    // points either side of the view centre.
    // (tilted: higher on the side away from where the sun sets, so it crosses diagonally)
    tEl = tElS; tAz = tAzS; uAz = uAzS; uEl = uElS;
  } else if (cE1 ? true : cE2) {
    tEl = tElL; uAz = uAzL; uEl = uElL;
  }
  else { uAz = uAzH; uEl = tEl; }
  if (tEl < 0.06) tEl = 0.06;
  const ct = Math.cos(tEl), tx = ct * Math.cos(tAz), ty = Math.sin(tEl), tz = ct * Math.sin(tAz);
  const cu = Math.cos(uEl), ux = cu * Math.cos(uAz), uy = Math.sin(uEl), uz = cu * Math.sin(uAz);
  DBG[0] = hAz; DBG[1] = sAz; DBG[2] = sElv; DBG[3] = tAz; DBG[4] = tEl; DBG[5] = uAz; DBG[6] = uEl; DBG[7] = pitch; DBG[8] = fv;
  // pole = (T - S) x (U - S)
  const ax = tx - sx, ay = ty - sy, az = tz - sz, bx = ux - sx, by = uy - sy, bz = uz - sz;
  let px = ay * bz - az * by, py = az * bx - ax * bz, pz = ax * by - ay * bx;
  let pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
  const plN = -pl;
  if (py < 0) pl = plN;
  px /= pl; py /= pl; pz /= pl;
  // stars on the side away from the sun
  const ca = Math.cos(STAR_AZ * fv), sa = Math.sin(STAR_AZ * fv) * side, ce = Math.cos(sEl);
  const qx = ce * (hx * ca - hz * sa), qy = Math.sin(sEl), qz = ce * (hz * ca + hx * sa);
  const snap = S[10] === 0 || !(dt > 0);
  const a = snap ? 1 : 1 - Math.exp(-dt / POLE_TAU);
  smoothDir(P, px, py, pz, a);
  smoothDir(SP, qx, qy, qz, a);

  // Era-crossing ripple.
  if (S[10] === 0) { S[9] = state.eraIdx; S[10] = 1; }
  { // = triggerRipple(eraIdx) on a change, written branch-free (see the allocation note above)
    const era = state.eraIdx, chg = era !== S[9] && timeFx.dir > 0; // (no ripples while the ending runs time back)
    S[7] = chg ? 0 : S[7]; S[8] = chg ? era : S[8]; S[9] = era;
  }
  if (RIPPLE_LOOP) { S[13] += dt; if (S[13] > 3) { S[13] = 0; triggerRipple((S[8] + 1) % ERA_N); } }
  S[7] += dt;
  let age = S[7];
  if (RIPPLE_PIN === RIPPLE_PIN) { age = RIPPLE_PIN; if (S[8] === 0 && state.eraIdx === 0) S[8] = 1; }
  rippleCentre(); // every frame (a few flops) so it stays optimised and never boxes doubles

  const e = (S[8] | 0) % ERA_N;
  f[96] = state.timeRate; f[97] = Lm; f[98] = state.clock; f[99] = state.year;
  f[100] = S[1]; f[101] = S[2]; f[102] = stretch;
  let cov = 0, wr = 0, wg = 0, wbl = 0;
  for (let b = 0; b < 7; b++) { const w = carBiome[b]; cov += BIO_CLOUD[b] * w; wr += BIO_WB[b * 3] * w; wg += BIO_WB[b * 3 + 1] * w; wbl += BIO_WB[b * 3 + 2] * w; }
  f[103] = NO_CLOUDS ? -1 : cov;
  f[104] = P[0]; f[105] = P[1]; f[106] = P[2]; f[107] = S[3];
  f[108] = S[11]; f[109] = S[12]; f[110] = age < 1.6 ? age : 99; f[111] = 1;
  f[112] = ERA_COL[e * 3]; f[113] = ERA_COL[e * 3 + 1]; f[114] = ERA_COL[e * 3 + 2]; f[115] = e;
  f[116] = wr; f[117] = wg; f[118] = wbl; f[119] = FX_OFF ? 1 : 0; // white balance (see BIO_WB)
  f[120] = SP[0]; f[121] = SP[1]; f[122] = SP[2]; f[123] = S[14];
  f[124] = G[0]; f[125] = G[1]; f[126] = G[2]; f[127] = S[15];
}

// Screen position of the car's chrono core (third person) or a point low on the windscreen
// (first person, where the core is behind the driver).
const CP = new Float64Array(3);
function rippleCentre() {
  G[0] = 0; G[1] = 0; G[2] = 0;
  bodyPoint(G); // car origin is on the ground
  if (state.view === 1) { S[11] = 0.5; S[12] = 0.78; return; }
  CP[0] = 0; CP[1] = 1.18; CP[2] = -1.42;
  bodyPoint(CP);
  const m = camera.viewProj;
  const x = m[0] * CP[0] + m[4] * CP[1] + m[8] * CP[2] + m[12];
  const y = m[1] * CP[0] + m[5] * CP[1] + m[9] * CP[2] + m[13];
  const w = m[3] * CP[0] + m[7] * CP[1] + m[11] * CP[2] + m[15];
  const u = x / w * 0.5 + 0.5, v = 0.5 - y / w * 0.5, behind = w < 0.05;
  S[11] = behind ? 0.5 : u; S[12] = behind ? 0.7 : v;
}
