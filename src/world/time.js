// Journey time: clock -> year, the seven eras, the event registry (ids 0-22) and the landmark
// states over the clock, the strait crossings and the loop point. Pure: no DOM, no imports, and
// nothing on the per-frame path allocates.
//
// Per frame (owner of state.year / eraIdx / eraBlend):
//   updateTime(state)                 reads state.clock, writes year, eraIdx, eraBlend
//   updateTimeRate(state)             state.timeRate from rateIO[0] (clock s per real s)
//   updateSurfaceCurve(state, base, curve)  road surface by era, with the front running ahead
// Labels (memoised per rounded value, so steady state allocates nothing):
//   yearLabel(year) -> string         "300,000 years ago", "9500 BCE", "500 CE", "1492"
// Events (EVENTS[id], see the table below):
//   landmarkState(id, clock, out)     -> true if it exists; out[0] built, out[1] decay, out[2] loggable
//   landmarkFor(region, clock, out, land)  -> event id to place on a road of that region, or -1
//   wantRegion(clock, land, k)        -> region of the k-th most urgent event about to be
//                                        placeable on that landmass (graph.js steering), or -1
// Gates:
//   straitOpen(clock, fromLand)       can a strait exit be taken when the car reaches it at clock
//   landBridgeOpen(clock), LAND_BRIDGE_CLOCK, LAND_BRIDGE_YEAR
//   LOOP_CLOCK, LOOP_FOG_SECONDS, loopFog(clock) -> 0..1 veil before the loop
//
// Years are historical: negative = BCE, positive = CE (there is no year 0; a rounded 0
// is shown as 1 CE). "Years ago" counts from PRESENT_YEAR.

export const PRESENT_YEAR = 2026;
export const JOURNEY_SECONDS = 300;
export const LOOP_CLOCK = 300; // the road enters the fog and the world restarts at clock 0
export const LOOP_FOG_SECONDS = 4; // veil ramps in over the last seconds before LOOP_CLOCK
export const LAND_BRIDGE_CLOCK = 55; // ice-region causeway is drivable only before this
export const LAND_BRIDGE_YEAR = -9000;

// Clock -> year anchors (DESIGN.md "Round two"), piecewise linear between them.
export const ANCHOR_CLOCK = new Float64Array([0, 30, 40, 55, 80, 85, 100, 120, 165, 210, 255, 300]);
export const ANCHOR_YEAR = new Float64Array([-300000, -40000, -10000, -9000, -3000, -2650, -2500, 500, 1450, 1750, 1914, 2026]);

// Eras: [start, end) in journey seconds. eraBlend ramps 0 -> 1 over the last
// ERA_BLEND_SECONDS of each era except the last (no next era to blend to).
export const ERA_COUNT = 7;
export const ERA_START = new Float64Array([0, 40, 80, 120, 165, 210, 255]);
export const ERA_END = new Float64Array([40, 80, 120, 165, 210, 255, 300]);
export const ERA_BLEND_SECONDS = 5;
export const ERA_NAMES = ['Origins', 'First farmers', 'Ancient empires', 'Connected world', 'Sail and science', 'Industry', 'Modern'];

// Regions (graph edge region ids = biome index = audio biome index).
export const REGION_SAVANNAH = 0, REGION_ICE = 1, REGION_DESERT = 2, REGION_FOREST = 3, REGION_STEPPE = 4,
  REGION_MOUNTAINS = 5, REGION_COAST = 6;
export const REGION_COUNT = 7;
export const REGION_NAMES = ['Savannah', 'Ice', 'River desert', 'Forest', 'Steppe', 'Mountains', 'Coast'];
export const LAND_NEAR = 0, LAND_FAR = 1;

export function yearAt(clock) {
  const n = ANCHOR_CLOCK.length;
  if (clock <= ANCHOR_CLOCK[0]) return ANCHOR_YEAR[0];
  if (clock >= ANCHOR_CLOCK[n - 1]) return ANCHOR_YEAR[n - 1];
  let i = 1;
  while (clock > ANCHOR_CLOCK[i]) i++;
  const c0 = ANCHOR_CLOCK[i - 1], c1 = ANCHOR_CLOCK[i];
  return ANCHOR_YEAR[i - 1] + (ANCHOR_YEAR[i] - ANCHOR_YEAR[i - 1]) * ((clock - c0) / (c1 - c0));
}

// Inverse of yearAt (tools, tables; not per frame).
export function clockAt(year) {
  const n = ANCHOR_CLOCK.length;
  if (year <= ANCHOR_YEAR[0]) return ANCHOR_CLOCK[0];
  if (year >= ANCHOR_YEAR[n - 1]) return ANCHOR_CLOCK[n - 1];
  let i = 1;
  while (year > ANCHOR_YEAR[i]) i++;
  return ANCHOR_CLOCK[i - 1] + (ANCHOR_CLOCK[i] - ANCHOR_CLOCK[i - 1]) * ((year - ANCHOR_YEAR[i - 1]) / (ANCHOR_YEAR[i] - ANCHOR_YEAR[i - 1]));
}

export function eraAt(clock) {
  for (let i = ERA_COUNT - 1; i > 0; i--) if (clock >= ERA_START[i]) return i;
  return 0;
}

function smooth(x) {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x);
}

export function eraBlendAt(clock) {
  const e = eraAt(clock);
  if (e === ERA_COUNT - 1) return 0;
  return smooth((clock - (ERA_END[e] - ERA_BLEND_SECONDS)) / ERA_BLEND_SECONDS);
}

// Writes state.year, state.eraIdx, state.eraBlend from state.clock. Inlined (no helper
// returning a double: V8 would box it every frame).
export function updateTime(state) {
  const c = state.clock, n = ANCHOR_CLOCK.length;
  if (c <= ANCHOR_CLOCK[0]) state.year = ANCHOR_YEAR[0];
  else if (c >= ANCHOR_CLOCK[n - 1]) state.year = ANCHOR_YEAR[n - 1];
  else {
    let i = 1;
    while (c > ANCHOR_CLOCK[i]) i++;
    state.year = ANCHOR_YEAR[i - 1] + (ANCHOR_YEAR[i] - ANCHOR_YEAR[i - 1]) * ((c - ANCHOR_CLOCK[i - 1]) / (ANCHOR_CLOCK[i] - ANCHOR_CLOCK[i - 1]));
  }
  let e = 0;
  for (let i = ERA_COUNT - 1; i > 0; i--) if (c >= ERA_START[i]) { e = i; break; }
  state.eraIdx = e;
  if (e === ERA_COUNT - 1) state.eraBlend = 0;
  else {
    let x = (c - (ERA_END[e] - ERA_BLEND_SECONDS)) / ERA_BLEND_SECONDS;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    state.eraBlend = x * x * (3 - 2 * x);
  }
}

// ---------------------------------------------------------------------------- labels
// Rounding by magnitude, so the counter moves at a readable pace:
//   >= 100,000 years ago: nearest 5,000   >= 10,000 BCE: "N years ago", nearest 500
//   10,000 .. 3000 BCE: nearest 50        3000 BCE .. 1450 CE: nearest 10      from 1450: every year
// CE years below 1000 carry "CE" ("500 CE"); from 1000 on the year stands alone ("1492").
const labelMemo = new Map();
let lastKey = NaN, lastLabel = '';

function commas(n) {
  const s = String(n);
  return n >= 10000 ? s.slice(0, s.length - 3) + ',' + s.slice(s.length - 3) : s;
}

// yearLabel(year) without the double argument (per-frame callers): yearIO[0] = year.
export const yearIO = new Float64Array(1);
export function yearLabelIO() { return labelOf(yearIO[0]); }
export function yearLabel(year) { return labelOf(year); }
function labelOf(year) {
  let key;
  if (year < -10000) {
    const ago = PRESENT_YEAR - year;
    const step = ago >= 100000 ? 5000 : 500;
    key = -1e7 - Math.round(ago / step) * step; // years-ago keys live below -1e7
  } else {
    const step = year < -3000 ? 50 : year < 1449.5 ? 10 : 1;
    key = Math.round(year / step) * step;
  }
  if (key === lastKey) return lastLabel;
  let s = labelMemo.get(key);
  if (s === undefined) {
    if (key <= -1e7) s = commas(-1e7 - key) + ' years ago';
    else if (key < 0) s = commas(-key) + ' BCE';
    else if (key < 1000) s = (key === 0 ? 1 : key) + ' CE';
    else s = String(key);
    labelMemo.set(key, s);
  }
  lastKey = key;
  lastLabel = s;
  return s;
}

// ---------------------------------------------------------------------------- events
// The event registry. id is the bit index in state.found and the audio stinger index.
//   key        landmark module id (src/world/landmarks/<key>.js, registered in landmarks/index.js)
//   region     biome / region index; land 0 near, 1 far landmass (-1: anywhere, never placed)
//   t0..t1     clock window in which passing (or witnessing) the landmark logs the event
//   p0..p1     the landmark exists (p1 = Infinity: it stands from then on)
//   b0..b1     built ramps 0 -> 1 (linear; b1 <= b0: a step at b0; b0 < 0: always 1)
//   d0..d1,dMax decay ramps 0 -> dMax (linear; d1 <= d0: a step; d0 < 0: never)
//   w0..w1     pass clocks sites.js may place it at (inside t0..t1 with margins, so the whole
//              drive-by happens while it is loggable)
//   remnant    optional [c0, c1]: after w1 a road starting before c1 may get the remnant
//              (not loggable) from pass clock c0 on (the buried Gobekli Tepe mound)
//   start      placed only at the start of the journey (the camp); place: false never placed
//   prio       autopilot priority bonus (the slice's cave, Gobekli Tepe and Giza keep winning
//              their fork against same-era newcomers such as Stonehenge)
// Windows are 10-40 s (400-1600 m of road; a fork every ~1.2 km), spread so a run meets an
// event about every 20-30 s. Years: clock 120 = 500, 165 = 1450, 210 = 1750, 255 = 1914.
const INF = Infinity;
function ev(id, key, name, yearText, year, region, land, t0, t1, p0, p1, b0, b1, d0, d1, dMax, w0, w1, caption, extra) {
  const e = { id, key, name, yearText, year, region, land, t0, t1, p0, p1, b0, b1, d0, d1, dMax, w0, w1, caption, remnant: null, start: false, place: true, prio: 0 };
  if (extra) Object.assign(e, extra);
  return e;
}
const N = LAND_NEAR, F = LAND_FAR;
export const EVENTS = [
  //  id key               name                        yearText             year   region             land t0     t1    p0     p1    b0     b1     d0     d1    dMax  w0     w1
  ev(0, 'camp', "First humans' camp", '300,000 years ago', -300000, REGION_SAVANNAH, N, 0, 12, 0, 12, -1, 0, -1, 0, 0, 2.5, 10,
    'Early Homo sapiens live in small bands in Africa, sharing food around the fire.', { start: true, short: 'People gather at a fire.' }),
  ev(1, 'cave', 'Cave paintings', '17,000 years ago', -15000, REGION_ICE, N, 20, 40, 20, 40, -1, 0, -1, 0, 0, 22, 35,
    'By firelight, painters cover the walls of Lascaux with horses, aurochs and deer.', { prio: 2 }),
  ev(2, 'gobekli', 'Göbekli Tepe', '9500 BCE', -9500, REGION_DESERT, N, 40, 64, 40, INF, -1, 0, 64, 64, 1, 41.5, 61,
    'Hunter-gatherers raise rings of carved T-shaped pillars in what is now Turkey.', { remnant: [66, 80], prio: 2 }),
  ev(3, 'giza', 'Great Pyramid of Giza', '2560 BCE', -2560, REGION_DESERT, N, 85, 120, 85, INF, 85, 100, -1, 0, 0, 104, 118,
    "Egypt builds King Khufu's pyramid, the tallest human-made structure for 3,800 years.", { prio: 2 }),
  ev(4, 'stonehenge', 'Stonehenge', '2500 BCE', -2500, REGION_FOREST, N, 87, 120, 72, INF, 72, 92, 125, 255, 0.8, 89, 118,
    'Farmers in Britain raise a ring of huge sarsen stones on Salisbury Plain.'),
  ev(5, 'great-wall', 'Great Wall of China', '220 BCE', -220, REGION_MOUNTAINS, N, 108, 150, 93, INF, 93, 114, 200, 285, 0.35, 111, 147,
    'The Qin emperor links older border walls into one long wall across northern China.'),
  ev(6, 'parthenon', 'Parthenon', '432 BCE', -432, REGION_COAST, N, 106, 140, 91, INF, 91, 112, 199, 206, 0.7, 109, 138,
    'Athens completes the Parthenon, a marble temple to Athena on the Acropolis.'),
  ev(7, 'cathedral', 'Gothic cathedral', '1163–1345', 1163, REGION_FOREST, N, 148, 195, 133, INF, 133, 158, 255, 300, 0.3, 151, 192,
    'Masons raise Notre-Dame de Paris, its high vaults braced by flying buttresses.'),
  ev(8, 'mongol-camp', 'Mongol encampment', '1206', 1206, REGION_STEPPE, N, 145, 165, 134, 166, 134, 146, 163.5, 166, 1, 147, 163,
    'Temüjin is proclaimed Genghis Khan, uniting the nomad tribes of the Mongol steppe.'),
  ev(9, 'timbuktu', 'Mosque of Timbuktu', '1327', 1327, REGION_DESERT, N, 154, 190, 139, INF, 139, 159, 230, 300, 0.25, 157, 187,
    'Mansa Musa of Mali has the Djinguereber Mosque built of mud brick at Timbuktu.'),
  ev(10, 'great-zimbabwe', 'Great Zimbabwe', '1300', 1300, REGION_SAVANNAH, N, 138, 180, 123, INF, 123, 150, 168, 215, 0.7, 141, 177,
    'Shona builders raise the dry-stone walls of Great Zimbabwe, a gold-trading capital.'),
  ev(11, 'fleet-1492', 'The fleet of 1492', '1492', 1492, REGION_COAST, N, 165, 182, 150, 183, -1, 0, -1, 0, 0, 167, 180,
    "Columbus's three ships sail west across the Atlantic and reach the Caribbean."),
  ev(12, 'machu-picchu', 'Machu Picchu', '1450', 1450, REGION_MOUNTAINS, F, 161, 205, 145, INF, 145, 165, 176, 215, 0.6, 163, 201,
    'The Inca build Machu Picchu, a royal estate on a ridge high in the Andes.'),
  ev(13, 'taj-mahal', 'Taj Mahal', '1653', 1653, REGION_DESERT, N, 186, 228, 171, INF, 171, 192, 240, 300, 0.15, 189, 225,
    'Shah Jahan completes the Taj Mahal at Agra, a tomb for his wife Mumtaz Mahal.'),
  ev(14, 'mill-town', 'Mill town', '1769', 1769, REGION_FOREST, N, 214, 252, 198, INF, 212, 252, 262, 300, 0.35, 216, 249,
    'Spinning mills driven by water, then steam, draw workers into new factory towns.'),
  ev(15, 'railroad', 'Transcontinental railroad', '1869', 1869, REGION_STEPPE, F, 236, 262, 220, INF, 220, 241, -1, 0, 0, 238, 259,
    'The first transcontinental railroad links the east and west of the United States.'),
  ev(16, 'first-flight', 'First powered flight', '1903', 1903, REGION_COAST, F, 247, 262, 231, 264, 250, 253, -1, 0, 0, 249, 260,
    'The Wright brothers make the first controlled, powered aeroplane flight.'),
  ev(17, 'trenches', 'Trench line', '1916', 1916, REGION_FOREST, N, 254, 268, 237, 275, 254.6, 256, 257, 272, 1, 255, 266,
    'On the Western Front, armies dig in along trench lines that barely move for years.'),
  ev(18, 'trinity', 'Trinity test', '1945', 1945, REGION_DESERT, F, 263, 276, 247, 278, 267.4, 267.4, 267.6, 276, 1, 265, 274,
    'The first nuclear weapon is tested in the New Mexico desert.'),
  ev(19, 'apollo', 'Apollo 11 launch', '1969', 1969, REGION_COAST, F, 273, 286, 257, 288, 277.2, 277.2, 277.4, 286, 1, 275, 284,
    'Apollo 11 lifts off from Florida; four days later, people walk on the Moon.'),
  ev(20, 'glacier', 'Melting glacier', '2026', 2026, REGION_ICE, N, 280, 300, 264, INF, -1, 0, 280, 300, 1, 282, 298,
    'Glaciers around the world are shrinking as the climate warms.'),
  ev(21, 'megacity', 'Megacity at night', '2026', 2026, REGION_SAVANNAH, N, 280, 300, 264, INF, 264, 286, -1, 0, 0, 282, 298,
    'More than half of humanity now lives in cities that stay lit all night.'),
  // The home (the ending, src/ending.js): never placed by the planner; sites.js stands it beside
  // the last street. It exists at every clock and built = clock / 300, so the rewind (the clock
  // run back to ~3) unbuilds the house and brings the first camp back round the same fire.
  ev(22, 'home', 'Home', '2026', 2026, -1, -1, 296, 300, 0, INF, 0, 300, -1, 0, 0, 296, 300,
    'At the end of the road, people sit round a fire, as they always have.', { place: false }),
];
export const EVENT_COUNT = EVENTS.length;
export const EV_CAMP = 0, EV_CAVE = 1, EV_GOBEKLI = 2, EV_GIZA = 3, EV_HOME = 22;
// Plain arrays of numbers for the per-frame state (no property loads of mixed objects).
const P0 = new Float64Array(EVENT_COUNT), P1 = new Float64Array(EVENT_COUNT), B0 = new Float64Array(EVENT_COUNT),
  B1 = new Float64Array(EVENT_COUNT), D0 = new Float64Array(EVENT_COUNT), D1 = new Float64Array(EVENT_COUNT),
  DM = new Float64Array(EVENT_COUNT), L0 = new Float64Array(EVENT_COUNT), L1 = new Float64Array(EVENT_COUNT);
for (const e of EVENTS) {
  const i = e.id;
  P0[i] = e.p0; P1[i] = e.p1; B0[i] = e.b0; B1[i] = e.b1; D0[i] = e.d0; D1[i] = e.d1; DM[i] = e.dMax; L0[i] = e.t0; L1[i] = e.t1;
}
// Era of an event (by its log window start), for the logbook.
export function eventEra(id) { return eraAt(EVENTS[id].t0); }

// Whether event `id`'s landmark exists at `clock`, and its state. Writes
// out[0] built (0..1), out[1] decay (0..1), out[2] 1 if passing it logs the event now.
// `out` is a caller-owned Float64Array(3) (or Float32Array). Region / landmass are checked by
// the caller (or use landmarkFor).
// Same with the clock read from io[3] (per-frame callers: no double argument to box).
export function landmarkStateIO(id, io) { return landmarkState(id, io[3], io); }
export function landmarkState(id, clock, out) {
  const on = clock >= P0[id] && clock < P1[id];
  let built = 1, decay = 0;
  const b0 = B0[id], b1 = B1[id], d0 = D0[id], d1 = D1[id];
  if (b0 >= 0) {
    if (b1 > b0) { const x = (clock - b0) / (b1 - b0); built = x < 0 ? 0 : x > 1 ? 1 : x; }
    else built = clock >= b0 ? 1 : 0;
  }
  if (d0 >= 0) {
    if (d1 > d0) { const x = (clock - d0) / (d1 - d0); decay = (x < 0 ? 0 : x > 1 ? 1 : x) * DM[id]; }
    else decay = clock >= d0 ? DM[id] : 0;
  }
  out[0] = on ? built : 0;
  out[1] = on ? decay : 0;
  out[2] = on && clock >= L0[id] && clock < L1[id] ? 1 : 0;
  return on;
}

// The landmark to place on a road of `region` (and landmass `land`, default near) reached at
// `clock`: a live (loggable) one first, the one whose window closes soonest if several,
// otherwise a remnant (a standing or buried landmark past its window). Returns -1 if none;
// fills `out` as above.
export function landmarkFor(region, clock, out, land = LAND_NEAR) {
  let live = -1, liveEnd = INF, rem = -1;
  for (let i = EVENT_COUNT - 1; i >= 0; i--) {
    const e = EVENTS[i];
    if (!e.place || e.region !== region || e.land !== land || !landmarkState(i, clock, out)) continue;
    if (out[2] === 1) { if (e.t1 < liveEnd) { liveEnd = e.t1; live = i; } } else if (rem < 0) rem = i;
  }
  const best = live >= 0 ? live : rem;
  if (best >= 0) landmarkState(best, clock, out);
  else { out[0] = 0; out[1] = 0; out[2] = 0; }
  return best;
}

// Region steering for the graph (plan time; allocation-free): the region of the k-th most
// urgent placeable event on landmass `land` whose placement window [w0, w1] meets
// [clock, clock + horizon], most urgent = window closing first; distinct regions only.
// -1 if there is none. Start-only events (the camp) do not count.
const WANT_HORIZON = 45;
const wantTaken = new Int8Array(REGION_COUNT);
export function wantRegion(clock, land, k = 0) {
  wantTaken.fill(0);
  for (let r = 0; r <= k; r++) {
    let best = -1, bestEnd = INF;
    for (let i = 0; i < EVENT_COUNT; i++) {
      const e = EVENTS[i];
      if (!e.place || e.start || e.land !== land || e.region < 0 || wantTaken[e.region]) continue;
      if (e.w1 < clock || e.w0 > clock + WANT_HORIZON) continue;
      if (e.w1 < bestEnd) { bestEnd = e.w1; best = e.region; }
    }
    if (best < 0) return -1;
    if (r === k) return best;
    wantTaken[best] = 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------- crossings
// THE hook for strait exits (graph.js planHistory and sites.js decide availability with it):
// can a road crossing the strait from landmass `fromLand` be taken by a car that reaches the
// crossing at `clock`? The Ice Age land bridge (near -> far, before LAND_BRIDGE_CLOCK); then
// nothing until 1492; from SHIP_CLOCK a ship both ways, and from BRIDGE_CLOCK a modern bridge
// (world/crossing.js draws both; graph.js offers the exits).
export const SHIP_CLOCK = 171.3; // 1492
export const BRIDGE_CLOCK = 258; // ~1920: the bridge builds over BRIDGE_BUILD clock seconds
export const BRIDGE_BUILD = 3;
export function straitOpen(clock, fromLand) {
  if (clock < LAND_BRIDGE_CLOCK) return fromLand === LAND_NEAR;
  return clock >= SHIP_CLOCK;
}
export function landBridgeOpen(clock) {
  return clock < LAND_BRIDGE_CLOCK;
}

// 0 until LOOP_FOG_SECONDS before the loop, then smoothly to 1 at LOOP_CLOCK.
export function loopFog(clock) {
  return smooth((clock - (LOOP_CLOCK - LOOP_FOG_SECONDS)) / LOOP_FOG_SECONDS);
}

// ---------------------------------------------------------------------------- rate of time
// Years of history per clock second at the clock (slope of the anchor curve).
// rateIO[0] = clock seconds per real second (input); updateTimeRate(state) writes
// state.timeRate = years per real second. (Inputs live in a typed array: V8 would box a
// double argument.) At 40 m/s: ~8700 y/s in era 1, 21 in era 4, 6.7, 3.6 and 2.5 in eras 5-7.
export const rateIO = new Float64Array(2);
export function updateTimeRate(state) {
  const c = state.clock, n = ANCHOR_CLOCK.length;
  let i = 1;
  while (i < n - 1 && c >= ANCHOR_CLOCK[i]) i++;
  const slope = (ANCHOR_YEAR[i] - ANCHOR_YEAR[i - 1]) / (ANCHOR_CLOCK[i] - ANCHOR_CLOCK[i - 1]);
  state.timeRate = rateIO[0] > 0 ? rateIO[0] * slope : 0;
}

// ---------------------------------------------------------------------------- road surface
// The road remakes itself ahead of the car at each era change: from half a second before the
// era starts, a front leaves the car and runs down the road at FRONT_SPEED journey metres per
// clock second, the new surface behind it, the old one ahead (it stops when the car stops,
// because the clock does). Writes the world surface curve {a, b, d0, d1}: surface =
// mix(a, b, smoothstep(d0, d1, journey m)). jAt(clock) = base[1] + (clock - base[0]) * 40.
// Surface ids: 0 trail, 1 dirt track, 2 stone paving, 3 cobbles, 4 asphalt two-lane (painted
// centre line), 5 modern highway (edge lines, dashed centre line, studs). SURFACE_CLOCK[k] is
// the clock at which surface SURFACE_ID[k + 1] takes over: eras 2-4 at their starts (dirt,
// paving, cobbles from 500 CE), asphalt late in the industrial era (clock 245, ~1878), the
// highway from clock 272 (~1956) and the ending's residential street (asphalt) from 283. Settlements (settle.js) run their own fronts with the same constants.
// From clock 283 the highway gives way to the quiet residential street of the ending (asphalt).
export const SURFACE_CLOCK = [40, 80, 120, 245, 272, 283];
export const SURFACE_ID = [0, 1, 2, 3, 4, 5, 4]; // surface after k changes
export const SURFACE_OF_ERA = [0, 1, 2, 3, 3, 3, 4]; // surface at each era's start
export const FRONT_SPEED = 300, FRONT_LEAD = 0.5, FRONT_SOFT = 70, FRONT_DONE = 8000;
export function updateSurfaceCurve(state, base, curve) {
  const clock = state.clock;
  // Surface now, counting a change that starts within FRONT_LEAD (the front leaves the car
  // just before the change).
  let k = 0;
  while (k < 6 && clock >= SURFACE_CLOCK[k] - FRONT_LEAD) k++;
  const t0 = k > 0 ? SURFACE_CLOCK[k - 1] - FRONT_LEAD : 0;
  const front = base[1] + (t0 - base[0]) * 40 + FRONT_SPEED * (clock - t0);
  const carJ = base[1] + (clock - base[0]) * 40;
  if (k === 0 || front - carJ > FRONT_DONE) {
    curve.a = SURFACE_ID[k]; curve.b = curve.a; curve.d0 = 0; curve.d1 = 1;
    return;
  }
  curve.a = SURFACE_ID[k]; curve.b = SURFACE_ID[k - 1]; curve.d0 = front; curve.d1 = front + FRONT_SOFT;
}
