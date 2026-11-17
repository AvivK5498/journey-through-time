// Shared, preallocated game state. One object, mutated in place, never replaced.
// Every module may read it; each field has one owner that writes it (noted below).
// Do not add fields inside the frame loop: add them here so the object shape is fixed.

export const state = {
  // --- journey (owner: world/time.js, car.js) ---
  clock: 0, // journey seconds (advances with distance / 40 m/s)
  year: -300000,
  eraIdx: 0,
  eraBlend: 0, // 0..1 into the next era
  timeRate: 0, // years of history per real second right now (0 when stopped; integrator writes it, ?rate= forces it)
  biomeA: 0,
  biomeB: 0,
  biomeBlend: 0,
  speed: 0, // m/s
  view: 0, // 0 third person, 1 first person (C toggles; ?view= sets)
  seed: 1,
  loop: 0, // journeys completed
  found: 0, // bitmask of logged events

  // --- drive (owner: drive.js / car.js) ---
  distance: 0, // journey metres along the road (clock = distance / 40)
  surface: 0, // road surface under the car: 0 trail, 1 dirt, 2 stone, 3 cobbles, 4 asphalt, 5 highway (blended); 3 also = off-road (use state.offRoad)
  edge: -1, // graph edge slot the car is on (see world/graph.js)
  edgeS: 0, // metres along that edge
  landmass: 0, // landmass under the car: 0 near, 1 far (flips where the road crosses the strait; graph.js landAt)
  offRoad: 0, // metres from the road centreline
  autopilot: false, // player autopilot (P toggles; ?autodrive=1 starts on): cruise + follow the road
  edgeFog: 0, // 0..1 free-roam boundary (400-520 m from the nearest live road): thicken fog with it

  // --- frame (owner: main.js) ---
  time: 0, // seconds since boot (or scripted time in script/pose mode)
  dt: 0, // seconds since previous frame, clamped
  frame: 0, // frame counter

  // --- run mode (owner: main.js, from the URL; read-only elsewhere) ---
  script: false, // ?script=1 : deterministic 60 s drive, 2560x1440, sets window.__perf
  pose: -1, // ?pose=N : fixed pose N at 2560x1440, sets window.__ready
  capture: false, // &capture=1 : time is stepped by window.__step() instead of real time
};

// Render environment. Biomes / time of day write these; gpu.js uploads them each frame.
// Units: sunIntensity is the HDR illuminance scale of the sun at the top of the
// atmosphere; fogDensity is extra height-fog extinction per metre at y = 0;
// fogFalloff is 1/metres; mieScale multiplies the atmosphere's aerosol density (haze).
// bounce is the ground albedo used for bounced light; skyFill scales sky ambient.
export const env = {
  sunAzimuth: 0.6, // radians, 0 = +x, increases toward +z
  sunElevation: 0.35, // radians above the horizon
  sunDir: new Float32Array(3), // derived from azimuth/elevation by updateSun()
  sunIntensity: 12,
  exposure: 0.55,
  fogDensity: 0.00012,
  fogFalloff: 0.012,
  mieScale: 1.0,
  bounce: new Float32Array([0.2, 0.18, 0.14]),
  skyFill: 1.0,
  haze: new Float32Array([1, 1, 1]), // tint of the fog / aerial-perspective inscatter (biomes)
};

export function updateSun() {
  const ce = Math.cos(env.sunElevation);
  env.sunDir[0] = ce * Math.cos(env.sunAzimuth);
  env.sunDir[1] = Math.sin(env.sunElevation);
  env.sunDir[2] = ce * Math.sin(env.sunAzimuth);
}
updateSun();
