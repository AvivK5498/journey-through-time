// Boot, frame loop, input, run modes, and the journey around the world: time, the road
// surface by era, landmarks and their event log, the land bridge, the loop, audio, the UI
// and the quality tiers.
//
// URL flags:
//   ?script=1          deterministic 60 s autopilot drive (driveScript in drive.js), canvas
//                      forced to 2560x1440, fixed seed; sets window.__perf when done.
//   &from=<s>          the scripted drive covers [from, from + 60] s of the same journey
//                      (tools/perf.mjs --from=60, 120, 180, 240 measure later minutes).
//   ?script=1&capture=1  same drive, but frames are rendered on demand by window.__step(t)
//                      (used by tools/shots.mjs to record a frame sequence).
//   ?pose=N            fixed pose N (0..5) at 2560x1440; sets window.__ready when stable.
//   &view=0|1          third / first person (plumbed into state.view).
//   &seed=N            world seed (script / pose modes use seed 1 unless given).
//   &t0=<s>            start the journey at that clock (history from there on).
//   &route=i,j,..      exit index (left to right) the autopilot takes at each fork.
//   &biome=N           start in biome N (0 savannah, 1 ice, 2 desert, 3 forest, 4 steppe,
//                      5 mountains, 6 coast); &biomelock=1 keeps every road in it (perf runs).
//   &autodrive=1       no start screen: drive at once (hands-off cruise), audio not started.
//   &rate=<y/s>        force state.timeRate (years per real second).
//   &quality=low|medium|high  force a tier (and no automatic step-down).
//   &fresh=1           ignore the saved logbook.
//   &placeholders=1    events without a landmark module get landmarks/example.js (sites.js).
//   &land=0|1          autopilot landmass preference (drive.js; 1 crosses to the far one).
//   &startland=1       the journey starts on the far landmass (graph.js root road; debug /
//                      tools/landmark-shot.mjs for the far-landmass events).
//   &ending=0          free drive without the ending (the old loop at clock 300).
//   &endperf=1         free drive at 2560x1440 with GPU timing logged per ending phase; sets
//                      window.__endPerf when the journey card shows (tools/perf.mjs --ending).
//
// Keys: W/S or Up/Down throttle/brake, A/D or Left/Right steer, P autopilot, C view, M mute, H stats;
// Esc menu (pause), L / Tab logbook (ui.js).
// The frame loop allocates nothing in steady state; the stats overlay builds a string 4x a
// second while it is visible.

import { state, env, updateSun } from './state.js';
import { camera, updateCamera, lightCenter, witness, witnessKey, witnessEnd, witnessRig, wIO, initWitness } from './camera.js';
import { gpu, initGpu, resize, renderFrame, timing, gpuIdle } from './gpu.js';
import { initWorld, updateWorld, worldIn, surfaceCurve } from './world/world.js';
import { graph, nodeExitCount, edgeExit, edgeFrom, clockBase, REGIONS, regionDebug } from './world/graph.js';
import { initRoad } from './world/road.js';
import { initSettle, applyDusk } from './world/settle.js';
import { initTerrain, updateTerrain } from './world/terrain.js';
import { initGrass, updateGrass } from './world/grass.js';
import { initProps, updateProps } from './world/props.js';
import { applyEnv } from './world/biomes.js';
import { updateTime, updateTimeRate, rateIO, updateSurfaceCurve, LOOP_CLOCK, LOOP_FOG_SECONDS, EVENTS } from './world/time.js';
import { initSites, updateSites, siteInfo, witnessBegin, witnessIO, siteClock } from './world/sites.js';
import { initLandmarkKit } from './world/landmarks/kit.js';
import { initCrossing, crossingInfo } from './world/crossing.js';
import { initTunnels, updateTunnels } from './world/tunnel.js';
import { initCar, uploadCar, pose, car } from './car.js';
import { initInterior, prepareInterior, setLevels } from './interior.js';
import { resetDrive, driveFree, driveScript, scriptT, applyView, posePrepare, poseView, keys, debugCam, setStartClock, routeInfo, toggleAutopilot, setPreferLand } from './drive.js';
import { ui, initUI, updateUI, showEvent, setVeil, fadeVeil, setQuality, witnessPrompt, witnessShow, witnessHide, witnessUI } from './ui.js';
import audio from './audio/index.js';
import { ending, initEnding, endingReset, endingTrack, endingUpdate, endingSurface, endingRig, endingKey, keepDriving, endingInfo, P_ARRIVE, P_ECHO, P_REWIND, P_LINE, P_CARD, P_OUTRO } from './ending.js';

const FIXED_W = 2560, FIXED_H = 1440;
const SCRIPT_SECONDS = 60;
const WARMUP_FRAMES = 90;
const BUILD_MS = 2; // landmark build budget per frame (ms)
const TUNNEL_MS = 1.5; // passage mesh build budget per frame (ms)

// Quality tiers: render scale of the backbuffer (High = full resolution, per the spec's
// 2560x1440 @ DPR 1 target). Chosen in the menu, remembered; stepped down automatically
// when the average frame interval stays over budget.
const TIERS = { low: 0.6, medium: 0.8, high: 1 };
const TIER_ORDER = ['low', 'medium', 'high'];
export const quality = { tier: 'high', scale: 1, forced: false };

const q = new URLSearchParams(location.search);
state.script = q.get('script') === '1';
state.capture = state.script && q.get('capture') === '1';
state.pose = q.has('pose') ? Math.max(0, Math.min(5, parseInt(q.get('pose'), 10) || 0)) : -1;
const AUTODRIVE = q.get('autodrive') === '1';
const RATE = q.has('rate') ? Number(q.get('rate')) : NaN;
const T0 = Math.max(0, Number(q.get('t0')) || 0);
const FROM = state.script ? Math.max(0, Number(q.get('from')) || 0) : 0;
const MANAGED = state.script || state.pose >= 0; // deterministic captures: no start screen, no saves
const ENDPERF = !MANAGED && q.get('endperf') === '1';
const ENDING = !MANAGED && q.get('ending') !== '0'; // the ending plays in free drive (src/ending.js)

state.view = q.get('view') === '1' ? 1 : 0;
state.seed = parseInt(q.get('seed'), 10) || 1;
if (q.get('startland') === '1') regionDebug[2] = 1;
if (q.has('biome')) { regionDebug[0] = Math.max(0, Math.min(REGIONS - 1, parseInt(q.get('biome'), 10) || 0)); if (q.get('biomelock') === '1') regionDebug[1] = regionDebug[0]; }
const fixedSize = state.script || state.pose >= 0 || ENDPERF;
if (q.has('carcam')) { debugCam.on = true; debugCam.yaw = parseFloat(q.get('carcam')) || 0; debugCam.dist = parseFloat(q.get('dist')) || 5.5; debugCam.up = parseFloat(q.get('up')) || 1.7; }

const canvas = document.getElementById('c');
const statsEl = document.getElementById('stats');
let statsOn = false;

// ------------------------------------------------------------------ saved progress
const store = {
  get(k) { try { return localStorage.getItem('jtt.' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('jtt.' + k, String(v)); } catch (e) { /* private mode */ } },
};
if (!MANAGED && q.get('fresh') !== '1') {
  state.found = (parseInt(store.get('found'), 10) || 0) & ((1 << EVENTS.length) - 1);
  state.loop = Math.max(0, parseInt(store.get('journeys'), 10) || 0);
}
{
  const qt = q.get('quality');
  const saved = store.get('quality');
  const t = TIERS[qt] ? qt : !MANAGED && TIERS[saved] ? saved : 'high';
  quality.tier = t; quality.scale = TIERS[t]; quality.forced = !!TIERS[qt];
}

// CPU frame intervals (ms), ring for the overlay and a log for script mode.
const cpuRing = new Float32Array(240);
let cpuPos = 0, cpuCount = 0;
const cpuLog = new Float32Array(SCRIPT_SECONDS * 250);
let cpuLogCount = 0;

// Doubles live in a typed array: a module-level `let` holding a double boxes it on every write.
// [0] last rAF timestamp, [1] script run start, [2] previous clock, [3] clock rate (EMA),
// [4] previous state.time, [5] auto step-down window sum (ms), [6] its frames, [7] window age,
// [8] loop fog, [9] capture: previous step time
const T = new Float64Array(11); // [10] previous rAF timestamp
let pendW = 0, pendH = 0, needResize = false;

// Script state machine: 0 warmup, 1 running, 2 flushing timestamps, 3 done.
let phase = 0, warm = 0;
let muted = false, pausedAudio = false;

const held = new Uint8Array(8); // W S A D Up Down Left Right
const KEYCODES = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
function onKeyUp(e) {
  const k = KEYCODES.indexOf(e.code);
  if (k >= 0) { held[k] = 0; syncKeys(); }
}
function syncKeys() {
  const m = witness.on || ending.lock ? 0 : 1; // the event moment and the ending ignore drive input
  keys.throttle = (held[0] | held[4]) * m;
  keys.brake = (held[1] | held[5]) * m;
  keys.steer = ((held[3] | held[7]) - (held[2] | held[6])) * m;
}
function onKey(e) {
  if (!e.repeat && ui.started && !ui.paused && !ui.logbook && endingKey(e.code)) { e.preventDefault(); return; }
  const k = KEYCODES.indexOf(e.code);
  if (k >= 0) { held[k] = 1; syncKeys(); e.preventDefault(); }
  if (e.repeat) return;
  if (k >= 0 && witness.on) witnessEnd(); // a drive key ends the event moment early
  if (e.code === 'KeyH') {
    statsOn = !statsOn;
    statsEl.style.display = statsOn ? 'block' : 'none';
    if (!state.script) timing.enabled = statsOn;
  } else if (e.code === 'KeyP') {
    toggleAutopilot();
  } else if (e.code === 'KeyE') {
    if (ui.started && !ui.paused && !ui.logbook && !MANAGED && !ending.on) { const ev = witnessKey(); if (ev >= 0) audio.stinger(ev); }
  } else if (e.code === 'KeyC') {
    if (!witness.on && (ending.phase < P_ECHO || ending.phase > P_CARD)) state.view ^= 1;
  } else if (e.code === 'KeyM') {
    muted = !muted;
    applyMute();
  }
}
function applyMute() { audio.mute(muted || pausedAudio); }

function measure() {
  if (fixedSize) { pendW = FIXED_W; pendH = FIXED_H; }
  else {
    pendW = Math.max(16, Math.round(canvas.clientWidth * quality.scale));
    pendH = Math.max(16, Math.round(canvas.clientHeight * quality.scale));
  }
  needResize = true;
}

function pickQuality(tier, manual) {
  if (!TIERS[tier]) return;
  quality.tier = tier; quality.scale = TIERS[tier];
  if (manual) quality.forced = false;
  if (!MANAGED) store.set('quality', tier);
  setQuality(tier);
  T[5] = 0; T[6] = 0; T[7] = -3000; // give the new tier a few seconds before judging it
  measure();
}

// Automatic step-down: the average frame interval over a 5 s window above 1000/40 ms (the
// display cannot keep up) drops one tier. Only while actually driving.
function autoQuality() {
  const dtMs = T[0] - T[10]; // this frame's interval (read from T: a double argument would box)
  if (MANAGED || quality.forced || quality.tier === 'low' || !ui.started || ui.paused || ui.logbook || document.hidden) return;
  if (dtMs > 250) return; // a stall (tab switch, GC of a build): not a trend
  T[7] += dtMs;
  if (T[7] < 0) return;
  T[5] += dtMs; T[6]++;
  if (T[7] < 5000) return;
  const avg = T[5] / T[6];
  T[5] = 0; T[6] = 0; T[7] = 0;
  if (avg > 25) pickQuality(TIER_ORDER[TIER_ORDER.indexOf(quality.tier) - 1], false);
}

function pushCpu(ms) {
  cpuRing[cpuPos] = ms;
  cpuPos = (cpuPos + 1) % cpuRing.length;
  if (cpuCount < cpuRing.length) cpuCount++;
}

function updateStats() {
  let gs = 0, gm = 0;
  for (let i = 0; i < timing.ringCount; i++) { const v = timing.ring[i]; gs += v; if (v > gm) gm = v; }
  let cs = 0, cm = 0;
  for (let i = 0; i < cpuCount; i++) { const v = cpuRing[i]; cs += v; if (v > cm) cm = v; }
  const ga = timing.ringCount ? gs / timing.ringCount : 0;
  const ca = cpuCount ? cs / cpuCount : 0;
  statsEl.textContent =
    (timing.supported ? 'GPU ' + ga.toFixed(2) + ' ms avg  ' + gm.toFixed(2) + ' max' : 'GPU timing n/a') +
    '\nCPU ' + ca.toFixed(2) + ' ms avg  ' + cm.toFixed(2) + ' max' +
    '\n' + gpu.width + 'x' + gpu.height + '  ' + quality.tier + '  view ' + state.view +
    '\nclock ' + state.clock.toFixed(1) + '  ' + Math.round(state.timeRate) + ' y/s  seed ' + state.seed;
}

function frame(ts) {
  if (!state.capture && phase !== 3) requestAnimationFrame(frame);
  const dtMs = T[0] ? ts - T[0] : 1000 / 60;
  T[10] = T[0] || ts - 1000 / 60;
  T[0] = ts;
  pushCpu(dtMs);
  state.dt = Math.min(dtMs * 0.001, 0.1);
  state.frame++;
  wIO[0] = 0; // real seconds for the event moment: 0 unless the game runs (below)
  if (needResize) { needResize = false; resize(pendW, pendH); }

  if (state.pose >= 0) {
    state.time = 10;
  } else if (state.script) {
    stepScript(ts);
  } else if (ui.started && !ui.paused && !ui.logbook) {
    wIO[0] = state.dt; // the event moment runs in real time; the sim in slowed time
    state.dt *= witness.scale;
    syncKeys();
    state.time += state.dt;
    driveFree();
    state.dt = wIO[0];
    if (ENDING) { endingTrack(); endingUpdate(wIO[0]); }
    autoQuality();
  }
  if (ENDPERF) endPerfFrame();
  journey(state.pose >= 0 ? Infinity : BUILD_MS);
  prepareFrame();
  renderFrame();
  updateUI();

  if (statsOn && (state.frame & 15) === 0) updateStats();
  if (state.pose >= 0 && state.frame === 4) gpuIdle().then(markReady);
}

// The journey after the sim step: time and its rate, the road surface by era, landmarks and
// the event log, the loop, the music. budget: landmark build time this frame (ms).
function journey(budget) {
  // A finished journey loops into a new seeded world at clock 0 (free drive only; with the
  // ending, ending.js calls loopJourney after the journey card).
  if (!MANAGED && !ENDING && state.clock >= LOOP_CLOCK) loopJourney();
  updateTime(state);
  // Rate of time: clock seconds per real second (smoothed), times years per clock second.
  const dtR = state.time - T[4];
  if (state.pose >= 0) rateIO[0] = Math.max(0, state.speed) / 40;
  else if (Math.abs(state.clock - T[2]) > 5) rateIO[0] = 0; // a jump (reset, fast-forward)
  else if (dtR > 0) {
    const inst = (state.clock - T[2]) / dtR;
    rateIO[0] += (inst - rateIO[0]) * Math.min(1, dtR / 0.3);
  } else if (!state.capture) rateIO[0] = 0; // paused, or not started
  T[2] = state.clock; T[4] = state.time;
  updateTimeRate(state);
  if (RATE === RATE) state.timeRate = RATE;
  updateSurfaceCurve(state, clockBase, surfaceCurve);
  if (ENDING) endingSurface();
  updateSites(budget);
  // The veil and fog thicken over the last seconds before the loop (without the ending).
  let f = ENDING ? 0 : (state.clock - (LOOP_CLOCK - LOOP_FOG_SECONDS)) / LOOP_FOG_SECONDS;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  T[8] = f * f * (3 - 2 * f);
  if (T[8] > 0 && !MANAGED) setVeil(T[8]);
  // Music: era, biome at the car, speed and surface every frame; level bars for the head unit.
  if (ui.started) {
    const sf = state.offRoad > car.hw + 0.5 ? 0 : car.surf; // (state.surface uses 3 for off-road, which is also cobbles)
    audio.set(state.eraIdx, state.eraBlend, state.biomeA, state.biomeB, state.biomeBlend, state.speed > 0 ? state.speed : 0, sf > 3.5 ? 0 : sf > 1.5 ? 2 : sf > 0.5 ? 1 : 0); // off-road, asphalt and highway: the smooth trail hiss; cobbles: stone joints
    if (state.view === 1) audio.readLevels();
  }
}

function onLog(ev) {
  state.found |= 1 << ev;
  if (!MANAGED) store.set('found', state.found);
  if (state.pose < 0) showEvent(ev); // fixed poses stay free of a half-faded caption
  audio.stinger(ev);
}

function loopJourney(fromEnding) {
  state.loop++;
  store.set('journeys', state.loop);
  store.set('found', state.found);
  const seed = ((Math.imul(state.seed + 1, 0x9e3779b1) >>> 0) % 999983) + 1;
  setStartClock(0);
  resetDrive(seed);
  endingReset(0);
  updateSites(Infinity); // behind the veil: the camp is ready at once
  T[2] = state.clock; rateIO[0] = 0;
  if (!fromEnding) audio.loopRestart(); // (the ending restarted it at Keep driving)
  setVeil(1);
  fadeVeil(0, 3.5);
}

// Everything between the simulation and renderFrame(): environment, camera, world uniforms,
// terrain/grass/prop selection and the car's matrices.
let lastBuilt = 0, lastCommits = 0;
function prepareFrame() {
  if (graph.built !== lastBuilt) { lastBuilt = graph.built; timing.frameEvents |= 8; }
  if (graph.commits !== lastCommits) { lastCommits = graph.commits; timing.frameEvents |= 16; }
  applyEnv();
  applyDusk(); // settle.js: the key sun sinks over the last part of the journey
  if (T[8] > 0) env.fogDensity *= 1 + 60 * T[8] * T[8]; // the road enters the fog
  if (ending.fog > 1) env.fogDensity *= ending.fog; // the ending's drive off into the fog
  if (state.edgeFog > 0) env.fogDensity *= 1 + 25 * state.edgeFog * state.edgeFog; // free-roam boundary
  if (state.pose >= 0) poseView(camera); else { applyView(camera); witnessRig(camera); endingRig(camera); }
  camera.aspect = gpu.width / gpu.height;
  updateCamera(camera);
  updateTunnels(state.pose >= 0 ? Infinity : TUNNEL_MS); // passages near the camera, mesh builds
  worldIn[0] = pose[0]; worldIn[1] = pose[1]; worldIn[2] = pose[2]; worldIn[3] = lightCenter[0]; worldIn[4] = lightCenter[2];
  updateWorld();
  updateTerrain();
  updateGrass();
  updateProps();
  uploadCar();
  prepareInterior();
}

function markReady() {
  // Stop the loop: the canvas keeps its last image, so captures are pixel-stable.
  phase = 3;
  window.__ready = true;
}

function stepScript(ts) {
  if (phase === 0) {
    state.time = 0;
    scriptT[0] = FROM;
    driveScript();
    if (++warm >= WARMUP_FRAMES) {
      phase = 1;
      T[1] = ts;
      timing.log = timingLog;
      timing.spanLog = spanLog;
      timing.passLog = passLog;
      timing.logCount = 0;
      timing.logFrom = timing.frames;
      timing.logTo = Infinity;
      cpuLogCount = 0;
    }
    return;
  }
  let t = (ts - T[1]) * 0.001;
  if (phase === 1) {
    if (cpuLogCount < cpuLog.length && t > 0) cpuLog[cpuLogCount++] = state.dt * 1000;
    if (t >= SCRIPT_SECONDS) { phase = 2; timing.logTo = timing.frames; }
  }
  if (t > SCRIPT_SECONDS) t = SCRIPT_SECONDS;
  state.time = t;
  scriptT[0] = FROM + t;
  driveScript();
  if (phase === 2 && (!timing.supported || timing.lastMappedFrame >= timing.logTo - 1)) finishScript();
}
const timingLog = new Float32Array(SCRIPT_SECONDS * 250);
const spanLog = new Float32Array(SCRIPT_SECONDS * 250);
const passLog = new Float32Array(SCRIPT_SECONDS * 250 * 14);

function stats(arr, n) {
  if (!n) return { avg: 0, p99: 0, max: 0, median: 0 };
  const a = Array.from(arr.subarray(0, n)).sort((x, y) => x - y);
  let s = 0;
  for (const v of a) s += v;
  const r = (v) => Math.round(v * 1000) / 1000;
  return { avg: r(s / n), p99: r(a[Math.min(n - 1, Math.floor(n * 0.99))]), max: r(a[n - 1]), median: r(a[n >> 1]) };
}

function finishScript() {
  phase = 3;
  const g = stats(timing.log, timing.logCount);
  const sp = stats(timing.spanLog, timing.logCount);
  const c = stats(cpuLog, cpuLogCount);
  // Average per pass (ms, pass order) over every logged frame.
  const passAvg = new Array(14).fill(0);
  for (let i = 0; i < timing.logCount; i++) for (let k = 0; k < 14; k++) passAvg[k] += passLog[i * 14 + k];
  window.__perf = {
    avg: g.avg, p99: g.p99, max: g.max, median: g.median, // busy: sum of this frame's pass durations
    from: FROM,
    passAvg: passAvg.map((v) => Math.round(v / Math.max(1, timing.logCount) * 1000) / 1000),
    // Per-pass durations (ms, pass order) for frames over 10 ms (which pass grows in a spike),
    // plus every 400th frame as a baseline sample. Passes overlap on Apple GPUs.
    slowFrames: Array.from(timing.log.subarray(0, timing.logCount)).flatMap((v, i) => v > 10 || i % 400 === 7 ? [{ i, ms: v, passes: Array.from(passLog.subarray(i * 14, i * 14 + 14), (x) => Math.round(x * 100) / 100) }] : []),
    span: sp, // first pass begin -> last pass end (includes other GPU clients' work in gaps)
    spanMs: Array.from(timing.spanLog.subarray(0, timing.logCount), (v) => Math.round(v * 1000) / 1000),
    frames: timing.logCount,
    framesRendered: timing.logTo - timing.logFrom,
    adapter: { ...gpu.adapterInfo, timestampQuery: timing.supported },
    canvas: [gpu.width, gpu.height],
    view: state.view,
    found: state.found,
    clockEnd: state.clock,
    cpuInterval: c,
    cpuFrames: cpuLogCount,
    timestampGcdNs: timing.gcdNs,
    timestampSamples: timing.samples,
    droppedBatches: timing.dropped,
    gpuMs: Array.from(timing.log.subarray(0, timing.logCount), (v) => Math.round(v * 1000) / 1000),
    // Scene events per logged frame (bits: 1 L0 field, 2 L1 field, 4 L2 field, 8 edge built, 16 commit).
    events: Array.from({ length: timing.logCount }, (_, i) => timing.events[(timing.logFrom + i) & 8191]),
  };
}

// Test hook (capture pages only; allocates): drive seed's autopilot route from clock 0 to
// `to` without rendering, building landmarks as they come in range, and report when each
// event is logged. land: planner landmass preference (-1 none, 1 cross to the far one).
function dryRun(seed, step = 0.25, to = LOOP_CLOCK + 1, land = -1) {
  const out = { seed, logged: [], exits: null, bridges: [], landmass: [], regions: REGIONS };
  state.found = 0;
  setPreferLand(land);
  setStartClock(0);
  resetDrive(seed);
  for (let t = 0; t <= to; t += step) {
    scriptT[0] = t; driveScript();
    applyView(camera); updateCamera(camera);
    const f = state.found;
    updateTime(state);
    updateSites(Infinity);
    if (state.found !== f) for (let i = 0; i < 31; i++) if (((state.found ^ f) >>> i) & 1) out.logged.push({ ev: i, clock: +state.clock.toFixed(1) });
    if (t === 50) out.bridges = siteInfo().bridges;
    if (state.landmass !== (out.landmass.length ? out.landmass[out.landmass.length - 1].land : 0)) out.landmass.push({ land: state.landmass, clock: +state.clock.toFixed(1) });
  }
  setPreferLand(-1);
  out.exits = routeInfo().exits;
  out.offers = routeInfo().offers; // forks on the route that offered a strait crossing
  out.found = state.found;
  return out;
}

// Test hook (capture pages; tools/crossing-test.mjs): advance the scripted drive of the URL's
// seed / t0 / route to scripted time t without rendering, as dryRun does. Returns the clock.
function dryStep(t) {
  scriptT[0] = t; driveScript();
  applyView(camera); updateCamera(camera);
  updateTime(state);
  updateSites(Infinity);
  return state.clock;
}

// Capture mode: render the scripted drive at time t on demand.
function step(t) {
  const dt = Math.max(0, t - T[9]);
  T[9] = t;
  state.time = t;
  scriptT[0] = FROM + t;
  driveScript();
  if (needResize) { needResize = false; resize(pendW, pendH); }
  journey(Infinity);
  prepareFrame();
  renderFrame();
  state.dt = dt;
  updateUI();
  return gpuIdle();
}

// ?endperf=1: GPU frame times per ending phase (tools/perf.mjs --ending). Each logged frame's
// number is kept (timing.logFrames) so frames whose timestamps were dropped do not shift phases.
const endPhase = new Int8Array(8192), endLogFrames = new Int32Array(SCRIPT_SECONDS * 250);
let endPerfT = 0;
function endPerfFrame() {
  endPhase[timing.frames & 8191] = ending.phase;
  if (ending.phase === P_CARD && !window.__endPerf) {
    if (!endPerfT) { endPerfT = timing.frames; timing.logTo = timing.frames; }
    if (timing.lastMappedFrame < endPerfT - 1) return;
    const by = {};
    const names = { [P_ARRIVE]: 'arrival', 3: 'parked', [P_ECHO]: 'echo', [P_REWIND]: 'rewind', [P_LINE]: 'line' };
    for (let i = 0; i < timing.logCount; i++) {
      const ph = names[endPhase[endLogFrames[i] & 8191]];
      if (!ph) continue;
      (by[ph] || (by[ph] = [])).push(timingLog[i]);
    }
    const out = {};
    for (const k in by) { const a = by[k].sort((x, y) => x - y); let sum = 0; for (const v of a) sum += v; out[k] = { frames: a.length, avg: +(sum / a.length).toFixed(3), p99: +a[Math.min(a.length - 1, Math.floor(a.length * 0.99))].toFixed(3), max: +a[a.length - 1].toFixed(3) }; }
    window.__endPerf = { phases: out, view: state.view, canvas: [gpu.width, gpu.height], adapter: { ...gpu.adapterInfo, timestampQuery: timing.supported }, home: endingInfo().home, samples: timing.samples };
  }
}

async function boot() {
  if (fixedSize) {
    canvas.classList.add('fixed');
    document.body.classList.add('fixed');
  }
  if (!(await initGpu(canvas))) return;
  updateSun();
  const seed = state.seed >>> 0;
  initWorld();
  initSites(onLog);
  initWitness(witnessBegin, witnessIO, witnessPrompt, witnessShow, witnessHide);
  initEnding({
    loop() { loopJourney(true); },
    finale() { audio.finale(); },
    restart() { audio.loopRestart(); },
    markLogged(ev) { state.found |= 1 << ev; if (!MANAGED) store.set('found', state.found); },
  }, ENDING);
  setStartClock(T0);
  // JIT warm-up: run the autopilot through two forks once (fork tracking, commits and edge
  // generation get compiled now instead of deoptimising mid-drive), then start fresh.
  resetDrive(seed);
  scriptT[0] = 70;
  driveScript();
  resetDrive(seed);
  await Promise.all([initRoad(), initSettle(seed), initTerrain(seed), initGrass(seed), initProps(seed), initCar(), initInterior(), initLandmarkKit()]);
  initCrossing(); // the ship and bridge meshes (after the landmark kit)
  initTunnels(); // passages between biomes (after the landmark kit)
  // Same for the per-frame CPU preparation (camera rigs, tile selection, uniforms): run it
  // a few hundred times along the start of the drive so it is optimised before frame one.
  const w0 = gpu.width, h0 = gpu.height;
  gpu.width = FIXED_W; gpu.height = FIXED_H; // aspect for the warm-up only
  for (let i = 0; i < 400; i++) {
    scriptT[0] = i * 0.05; driveScript();
    state.view = i & 1;
    updateTime(state); updateTimeRate(state); updateSurfaceCurve(state, clockBase, surfaceCurve);
    prepareFrame();
  }
  state.view = q.get('view') === '1' ? 1 : 0;
  gpu.width = w0; gpu.height = h0;
  resetDrive(seed);
  endingReset(T0);
  if (state.pose >= 0) posePrepare(state.pose);
  else updateSites(Infinity); // the first landmarks are ready before the start screen lifts
  T[2] = state.clock;
  measure();
  if (!fixedSize) new ResizeObserver(measure).observe(canvas);
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', () => { held.fill(0); syncKeys(); });
  setLevels(audio.levels);
  initUI({
    start: !(MANAGED || AUTODRIVE),
    quality: quality.tier,
    onDrive() { audio.start().then(applyMute).catch((e) => console.warn('audio:', e)); },
    onPause(p) { pausedAudio = p; applyMute(); },
    onQuality(t) { pickQuality(t, true); },
    onKeep() { keepDriving(); },
  });
  if (state.script) timing.enabled = true;
  window.__jt = { state, car, graph, exitCount: (n) => (n >= 0 ? nodeExitCount[n] : 0),
    lastFork: () => [edgeExit[graph.cur], nodeExitCount[edgeFrom[graph.cur]]] }; // inspection hook for tools/drive-test.mjs and the console
  // Read-only view for tests: state, landmarks / land bridge, route, UI flags, quality.
  window.__game = { state, sites: siteInfo, siteClock, route: routeInfo, ui, quality, dryRun, dryStep, witness, witnessIO, witnessUI, camera, carPose: pose, crossing: crossingInfo, ending: endingInfo };
  if (ENDPERF) { timing.enabled = true; timing.log = timingLog; timing.spanLog = spanLog; timing.passLog = null; timing.logFrames = endLogFrames; timing.logCount = 0; timing.logFrom = timing.frames; timing.logTo = Infinity; }
  window.__gpu = { ...gpu.adapterInfo, timestampQuery: timing.supported, browser: navigator.userAgent };
  window.__timing = timing; // tools/posetime.mjs reads the rolling GPU times in capture mode
  if (state.capture) {
    resize(pendW, pendH); needResize = false;
    window.__step = step;
    window.__captureReady = true;
    return;
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  window.__gpuError = String(e && e.message || e);
  const el = document.getElementById('nogpu');
  if (el) { el.style.display = 'flex'; el.querySelector('.why').textContent = window.__gpuError; }
});

export { env };
