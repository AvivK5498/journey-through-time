// Biome kits. One row per region id (0 savannah, 1 ice age glacial margin, 2 river desert,
// 3 temperate forest, 4 steppe, 5 mountains, 6 coast).
//
// Biomes are spatial: every road splats its region into a biome map (road.js renderBiome),
// and shaders read per-position weights with biomeW(p) / bioAt(slot, w) (world.js). The CPU
// blends the `env` block (sun, exposure, fog, haze, ambient) with the weights at the car
// (carBiome, written by drive.js) in applyEnv(). The legacy two-row accessor bio(k) (and
// state.biomeA / biomeB / biomeBlend) carries the two strongest biomes at the car.
//
// Slot meanings are per biome where noted ("props": tree, shrub, rock, special densities;
// special = termite mounds / mammoth herds / date palms).

import { env, state, updateSun } from '../state.js';

export const BIOME_COUNT = 7;
export const BK = 14; // vec4 slots per biome

// Slot indices (WGSL constants of the same name live in BIOME_WGSL).
export const B_GROUND = 0, B_GROUND_ALT = 1, B_SOIL = 2, B_ROCK = 3, B_GRASS_BASE = 4, B_GRASS_TIP = 5,
  B_GRASS_DRY = 6, B_GRASS = 7, B_PROPS = 8, B_LEAF = 9, B_BARK = 10, B_MOUND = 11, B_DUST = 12, B_COVER = 13;

export const BIOMES = [
  {
    name: 'Savannah',
    // Linear albedos.
    ground: [0.34, 0.25, 0.12, 0], // dry grass seen from afar; w unused
    groundAlt: [0.26, 0.22, 0.11, 0.45], // greener / darker patches; w = patchiness
    soil: [0.30, 0.17, 0.09, 0], // red-brown earth (road, bare patches)
    rock: [0.30, 0.27, 0.24, 0],
    grassBase: [0.16, 0.12, 0.06, 0],
    grassTip: [0.62, 0.50, 0.27, 0],
    grassDry: [0.50, 0.33, 0.17, 0.35], // reddish seed heads; w = seed-head amount
    grass: [0.95, 1.0, 0.55, 1.0], // height m, density scale, height variance, wind
    props: [1.0, 1.0, 1.0, 1.0], // tree, shrub, rock, termite mound density scales
    leaf: [0.075, 0.085, 0.032, 0],
    bark: [0.13, 0.10, 0.08, 0],
    mound: [0.44, 0.24, 0.12, 0],
    dust: [0.52, 0.38, 0.24, 1.0], // dust colour; w = how much dust the wheels kick
    cover: [0, 0, 0, 0], // snow / sand overlay colour, amount
    env: {
      sunElevation: 0.36, sunAzimuth: 0.62, sunIntensity: 13, exposure: 0.56,
      fogDensity: 0.00016, fogFalloff: 0.010, mieScale: 1.9,
      bounce: [0.30, 0.22, 0.12], skyFill: 1.35, haze: [1, 1, 1],
    },
  },
  {
    name: 'Ice',
    ground: [0.84, 0.88, 0.93, 0], // snow
    groundAlt: [0.25, 0.23, 0.155, 0.5], // tundra (dry grass, moss) where the wind scours the snow
    soil: [0.27, 0.25, 0.23, 0], // frozen gravel (mid tone: neither a dark smear nor a white strip)
    rock: [0.12, 0.13, 0.15, 0],
    grassBase: [0.30, 0.22, 0.10, 0],
    grassTip: [0.80, 0.63, 0.30, 0],
    grassDry: [0.86, 0.72, 0.42, 0.0],
    grass: [0.55, 0.32, 0.45, 1.4],
    props: [0.0, 0.9, 1.9, 1.0], // no trees; dwarf shrubs, erratics, mammoth herds
    leaf: [0.085, 0.075, 0.045, 0], // dwarf willow / heather
    bark: [0.10, 0.08, 0.06, 0],
    mound: [0.16, 0.10, 0.06, 0], // mammoth fur
    dust: [0.93, 0.96, 1.0, 1.35], // snow spray
    cover: [0.84, 0.88, 0.94, 1.0],
    env: {
      sunElevation: 0.25, sunAzimuth: 0.95, sunIntensity: 11.5, exposure: 0.46,
      fogDensity: 0.00034, fogFalloff: 0.0075, mieScale: 1.5,
      bounce: [0.62, 0.65, 0.70], skyFill: 1.15, haze: [0.90, 0.97, 1.10],
    },
  },
  {
    name: 'Desert',
    ground: [0.62, 0.45, 0.27, 0], // sand
    groundAlt: [0.33, 0.25, 0.18, 0.6], // stony plain (desert pavement)
    soil: [0.50, 0.36, 0.22, 0],
    rock: [0.46, 0.29, 0.19, 0], // red sandstone
    grassBase: [0.16, 0.13, 0.07, 0],
    grassTip: [0.62, 0.55, 0.37, 0],
    grassDry: [0.58, 0.48, 0.30, 0.1],
    grass: [0.45, 0.12, 0.5, 0.9],
    props: [0.0, 0.45, 1.2, 1.0], // no acacias; scrub, rocks, date palms by the river
    leaf: [0.075, 0.105, 0.035, 0], // palm fronds
    bark: [0.20, 0.15, 0.10, 0],
    mound: [0.50, 0.35, 0.20, 0],
    dust: [0.66, 0.50, 0.32, 1.5],
    cover: [0.64, 0.47, 0.28, 0.6],
    env: {
      sunElevation: 0.5, sunAzimuth: 0.5, sunIntensity: 14.5, exposure: 0.33,
      fogDensity: 0.00007, fogFalloff: 0.009, mieScale: 2.3,
      bounce: [0.52, 0.38, 0.24], skyFill: 1.35, haze: [1.10, 1.0, 0.86],
    },
  },
  {
    name: 'Forest',
    ground: [0.085, 0.13, 0.04, 0], // moss and fern floor
    groundAlt: [0.17, 0.11, 0.055, 0.55], // leaf litter
    soil: [0.17, 0.115, 0.07, 0], // dark loam
    rock: [0.24, 0.25, 0.22, 0], // grey stone, moss in the cracks
    grassBase: [0.02, 0.035, 0.012, 0],
    grassTip: [0.07, 0.15, 0.035, 0], // fern fronds
    grassDry: [0.30, 0.20, 0.07, 0.0], // bracken turning
    grass: [0.8, 0.75, 0.5, 0.35],
    props: [1.0, 0.7, 0.45, 0.0], // trees (broadleaf + conifer), undergrowth, mossy rocks
    leaf: [0.045, 0.095, 0.03, 0], // beech / oak canopy
    bark: [0.13, 0.115, 0.10, 0],
    mound: [0.20, 0.15, 0.10, 0],
    dust: [0.26, 0.21, 0.14, 0.45], // damp loam: little dust
    cover: [0, 0, 0, 0],
    env: {
      sunElevation: 0.40, sunAzimuth: 0.70, sunIntensity: 12.5, exposure: 0.62,
      fogDensity: 0.00048, fogFalloff: 0.014, mieScale: 2.6,
      bounce: [0.12, 0.18, 0.07], skyFill: 1.3, haze: [0.86, 1.0, 1.02],
    },
  },
  {
    name: 'Steppe',
    ground: [0.38, 0.32, 0.17, 0], // pale gold grass
    groundAlt: [0.22, 0.25, 0.15, 0.5], // sage
    soil: [0.33, 0.26, 0.17, 0],
    rock: [0.40, 0.38, 0.35, 0],
    grassBase: [0.15, 0.14, 0.07, 0],
    grassTip: [0.56, 0.48, 0.26, 0],
    grassDry: [0.64, 0.62, 0.50, 0.55], // silvery feather-grass plumes
    grass: [0.9, 1.0, 0.45, 1.7],
    props: [0.03, 0.25, 0.5, 0.0], // a rare lone tree, low shrubs, a few stones
    leaf: [0.08, 0.10, 0.04, 0],
    bark: [0.20, 0.17, 0.13, 0],
    mound: [0.30, 0.25, 0.17, 0],
    dust: [0.58, 0.50, 0.36, 1.1],
    cover: [0, 0, 0, 0],
    env: {
      sunElevation: 0.30, sunAzimuth: 0.72, sunIntensity: 13.5, exposure: 0.46,
      fogDensity: 0.00008, fogFalloff: 0.008, mieScale: 1.5,
      bounce: [0.40, 0.35, 0.22], skyFill: 1.45, haze: [0.97, 1.0, 1.05],
    },
  },
  {
    name: 'Mountains',
    ground: [0.10, 0.155, 0.05, 0], // alpine meadow
    groundAlt: [0.21, 0.21, 0.12, 0.5], // dry turf
    soil: [0.26, 0.24, 0.21, 0], // gravel
    rock: [0.19, 0.19, 0.21, 0], // blue-grey granite
    grassBase: [0.035, 0.065, 0.02, 0],
    grassTip: [0.22, 0.34, 0.09, 0],
    grassDry: [0.55, 0.48, 0.28, 0.1],
    grass: [0.45, 0.8, 0.4, 0.8],
    props: [0.55, 0.4, 1.5, 0.0], // spruce in the valleys, dwarf pine, boulders
    leaf: [0.025, 0.06, 0.035, 0], // spruce needles
    bark: [0.13, 0.095, 0.07, 0],
    mound: [0.20, 0.15, 0.10, 0],
    dust: [0.40, 0.38, 0.34, 0.8],
    cover: [0.86, 0.90, 0.95, 1.0], // snow
    env: {
      sunElevation: 0.36, sunAzimuth: 0.80, sunIntensity: 13.0, exposure: 0.5,
      fogDensity: 0.00008, fogFalloff: 0.006, mieScale: 1.05,
      bounce: [0.30, 0.32, 0.30], skyFill: 1.2, haze: [0.90, 0.97, 1.1],
    },
  },
  {
    name: 'Coast',
    ground: [0.19, 0.22, 0.10, 0], // dune grass
    groundAlt: [0.50, 0.43, 0.30, 0.5], // sand
    soil: [0.46, 0.40, 0.30, 0], // sandy track
    rock: [0.56, 0.51, 0.43, 0], // pale limestone cliffs
    grassBase: [0.12, 0.13, 0.07, 0],
    grassTip: [0.30, 0.40, 0.20, 0], // marram, blue-green going gold
    grassDry: [0.66, 0.58, 0.38, 0.2],
    grass: [0.75, 0.9, 0.5, 1.5],
    props: [0.3, 0.5, 0.8, 0.0], // stone pines, scrub, rocks
    leaf: [0.04, 0.085, 0.035, 0], // stone pine
    bark: [0.22, 0.14, 0.09, 0],
    mound: [0.30, 0.25, 0.17, 0],
    dust: [0.66, 0.58, 0.44, 1.2],
    cover: [0.64, 0.57, 0.42, 0.6],
    env: {
      sunElevation: 0.32, sunAzimuth: 0.55, sunIntensity: 14.0, exposure: 0.46,
      fogDensity: 0.00011, fogFalloff: 0.01, mieScale: 1.8,
      bounce: [0.45, 0.42, 0.34], skyFill: 1.4, haze: [0.95, 1.0, 1.08],
    },
  },
];

// Biome weights (0..6, the order above) at the car. world.js biomeExact writes them (drive.js
// calls it every sim step); everything CPU-side blends with them.
export const carBiome = new Float64Array([1, 0, 0, 0, 0, 0, 0]);


const KEYS = ['ground', 'groundAlt', 'soil', 'rock', 'grassBase', 'grassTip', 'grassDry', 'grass', 'props', 'leaf', 'bark', 'mound', 'dust', 'cover'];

// Packs the table into `out` (Float32Array, BIOME_COUNT * BK * 4 floats).
export function packBiomes(out, offset) {
  packTable();
  out.set(packed, offset);
}
// Re-pack after editing BIOMES (the next worker's biome rows); call before packBiomes.
export function packTable() {
  const out = packed, offset = 0;
  for (let b = 0; b < BIOME_COUNT; b++) {
    for (let k = 0; k < BK; k++) {
      const v = BIOMES[b][KEYS[k]];
      for (let c = 0; c < 4; c++) out[offset + (b * BK + k) * 4 + c] = v[c];
    }
  }
}

// CPU-side blended parameter: bioV(slot) writes the car-position blend into BV.
export const BV = new Float64Array(4);
const packed = new Float32Array(BIOME_COUNT * BK * 4);
export function bioV(slot) {
  for (let c = 0; c < 4; c++) {
    let v = 0;
    for (let b = 0; b < BIOME_COUNT; b++) v += packed[(b * BK + slot) * 4 + c] * carBiome[b];
    BV[c] = v;
  }
}

// state.biomeA / biomeB / biomeBlend from carBiome: B = strongest, A = runner-up,
// blend = wB / (wA + wB) (0 and A = B when only one biome is present).
export function setStateBiome() {
  let b = 0;
  for (let i = 1; i < BIOME_COUNT; i++) if (carBiome[i] > carBiome[b]) b = i;
  let a = b === 0 ? 1 : 0;
  for (let i = 0; i < BIOME_COUNT; i++) if (i !== b && carBiome[i] > carBiome[a]) a = i;
  const wa = carBiome[a], wb = carBiome[b];
  if (wa < 0.01) { state.biomeA = b; state.biomeB = b; state.biomeBlend = 0; }
  else { state.biomeA = a; state.biomeB = b; state.biomeBlend = wb / (wa + wb); }
}

// Writes env (sun, exposure, fog, haze, ambient) from the biome weights at the car. Called
// every frame before rendering. A time-of-day system can post-modify env after this call.
export function applyEnv() {
  env.sunElevation = 0; env.sunAzimuth = 0; env.sunIntensity = 0; env.exposure = 0;
  env.fogDensity = 0; env.fogFalloff = 0; env.mieScale = 0; env.skyFill = 0;
  for (let i = 0; i < 3; i++) { env.bounce[i] = 0; env.haze[i] = 0; }
  let sum = 0;
  for (let b = 0; b < BIOME_COUNT; b++) sum += carBiome[b];
  const inv = 1 / Math.max(sum, 1e-6);
  for (let b = 0; b < BIOME_COUNT; b++) {
    const w = carBiome[b] * inv;
    if (w <= 0) continue;
    const E = BIOMES[b].env;
    env.sunElevation += E.sunElevation * w; env.sunAzimuth += E.sunAzimuth * w;
    env.sunIntensity += E.sunIntensity * w; env.exposure += E.exposure * w;
    env.fogDensity += E.fogDensity * w; env.fogFalloff += E.fogFalloff * w;
    env.mieScale += E.mieScale * w; env.skyFill += E.skyFill * w;
    for (let i = 0; i < 3; i++) { env.bounce[i] += E.bounce[i] * w; env.haze[i] += E.haze[i] * w; }
  }
  updateSun();
}

// WGSL accessor. Requires World (with bp array) to be declared first.
export const BIOME_WGSL = /* wgsl */ `
const BK: u32 = ${BK}u;
const B_GROUND: u32 = 0u; const B_GROUND_ALT: u32 = 1u; const B_SOIL: u32 = 2u; const B_ROCK: u32 = 3u;
const B_GRASS_BASE: u32 = 4u; const B_GRASS_TIP: u32 = 5u; const B_GRASS_DRY: u32 = 6u; const B_GRASS: u32 = 7u;
const B_PROPS: u32 = 8u; const B_LEAF: u32 = 9u; const B_BARK: u32 = 10u; const B_MOUND: u32 = 11u;
const B_DUST: u32 = 12u; const B_COVER: u32 = 13u;
fn bio(k: u32) -> vec4f {
  let a = u32(W.bio.x);
  let b = u32(W.bio.y);
  return mix(W.bp[a * BK + k], W.bp[b * BK + k], W.bio.z);
}
`;
packTable();
