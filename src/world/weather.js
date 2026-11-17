// Blowing snow (spindrift) in the ice biome, faint drifting sand in the desert, blown sand on
// the coast and windborne chaff over the steppe: a few
// thousand soft streaks hugging the ground around the camera, positioned procedurally in the
// vertex shader (world-anchored, wrapped into a box that follows the camera, carried by the
// wind), so there is no simulation state and nothing allocates. Weighted per streak by the
// local biome weights; skipped entirely when the car is far from both biomes.

import { gpu, addDrawable, mainPipeline } from '../gpu.js';
import { MAIN_HEADER } from '../shaders/common.js';
import { WORLD_WGSL, world } from './world.js';
import { carBiome } from './biomes.js';

const N = 1900;
const BOX = 150; // metres

const WGSL = MAIN_HEADER + WORLD_WGSL + /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) wp: vec3f,
  @location(2) @interpolate(flat) a: vec4f, // alpha, snow vs sand, seed, 0
  @location(3) @interpolate(flat) c: vec3f, // lit, fogged colour (per streak: it is small)
};
fn hh(i: u32, k: u32) -> f32 { return f32(hashU(i, k) >> 8u) * (1.0 / 16777216.0); }

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  let wind = normalize(vec2f(0.8, 0.6));
  let t = F.time;
  let speed = 6.0 + 7.0 * hh(ii, 1u);
  let base = vec2f(hh(ii, 2u), hh(ii, 3u)) * ${BOX}.0 + wind * t * speed;
  let rel = fract((base - W.cam.xz) / ${BOX}.0) - 0.5;
  let c = W.cam.xz + rel * ${BOX}.0;
  let r = length(rel) * 2.0;
  let bwf = biomeW(c);
  let bw = bwf.a;
  let dry = 0.25 * bw.z + 0.2 * bwf.b.y + 0.22 * bwf.b.w;
  let amt = bw.y + dry;
  if (amt < 0.02 || r > 1.0) { return o; }
  let gy = groundH(c);
  // Gusts sweep through in bands.
  let gust = smoothstep(0.35, 0.8, vnoise(c * 0.02 - wind * t * 0.25 + vec2f(3.0, 1.0)));
  let len = 2.0 + 4.0 * hh(ii, 4u);
  let hgt = 0.12 + 0.35 * hh(ii, 5u) * hh(ii, 6u);
  let y = gy + 0.08 + hgt * 0.6 + 0.9 * hh(ii, 7u) * hh(ii, 7u);
  var cs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let q = cs[vi];
  let along = vec3f(wind.x, 0.0, wind.y);
  let ctr = vec3f(c.x, y, c.y);
  let view = normalize(ctr - F.camPos);
  var up = normalize(cross(along, view));
  if (up.y < 0.0) { up = -up; }
  let wp = ctr + along * (q.x * len) + up * (q.y * hgt);
  o.wp = wp;
  o.uv = q;
  let fade = smoothstep(1.0, 0.75, r) * smoothstep(1.5, 5.0, distance(ctr, F.camPos));
  o.a = vec4f(amt * fade * (0.25 + 0.75 * gust), bw.y / max(bw.y + dry * 4.0, 1e-3), hh(ii, 8u), bwf.b.y / max(bw.z + bwf.b.y + bwf.b.w, 1e-3));
  if (o.a.x < 0.06) { return o; } // too faint to see: skip its fill
  o.pos = F.viewProj * vec4f(wp, 1.0);
  let alb = mix(mix(vec3f(0.62, 0.47, 0.30), vec3f(0.74, 0.66, 0.46), o.a.w), vec3f(0.9, 0.93, 0.98), o.a.y);
  let fwd = 1.0 + 2.0 * pow(max(dot(view, F.sunDir), 0.0), 6.0);
  o.c = applyFog(alb * (probeSun() * max(F.sunDir.y, 0.2) * fwd + probeAmb(vec3f(0.0, 1.0, 0.0))) / PI, ctr);
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let along = 1.0 - i.uv.x * i.uv.x;
  let across = exp(-i.uv.y * i.uv.y * 3.0);
  let wisp = 0.62 + 0.38 * sin(i.uv.x * 7.0 + i.a.z * 40.0) * sin(i.uv.y * 2.3 + i.a.z * 13.0);
  let a = along * along * across * wisp * i.a.x * mix(0.05, 0.11, i.a.y);
  if (a < 0.002) { discard; }
  return vec4f(i.c * a, a);
}
`;

let pipe;
export async function initWeather(seed) {
  const d = gpu.device;
  const mod = d.createShaderModule({ label: 'weather', code: WGSL });
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  pipe = await mainPipeline({ label: 'weather', module: mod, layouts: [world.bgl], cullMode: 'none', depthWrite: false, blend, constants: { SEED: seed } });
  if (/[?&]hide=[^&]*weather/.test(location.search)) return;
  addDrawable({
    main() {},
    transparent(p) {
      if (carBiome[1] + carBiome[2] * 0.35 + carBiome[4] * 0.3 + carBiome[6] * 0.3 < 0.02) return;
      p.setPipeline(pipe); p.setBindGroup(1, world.bg); p.draw(6, N);
    },
  });
}
