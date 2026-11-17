// Shared WGSL: the per-frame uniform block, group(0) bindings, atmosphere model,
// aerial perspective / fog, shadow lookup and a small lighting helper.
//
// How to use from a scene module:
//   const code = MAIN_HEADER + myWGSL;          // for pipelines drawn in the main pass
//   const code = SHADOW_HEADER + myShadowWGSL;  // for shadow-pass pipelines
// Your own resources go in @group(1) (and up). Group 0 is owned by gpu.js.
// In fragment shaders, finish with: col = applyFog(col, worldPos);
//
// Units: world is metres, +y up. The atmosphere model works in kilometres.

// Layout of the Frame block. gpu.js writes it from a Float32Array in this order.
export const FRAME_STRUCT = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  lightViewProj: mat4x4f,
  camPos: vec3f, time: f32,
  sunDir: vec3f, sunIntensity: f32,
  fogDensity: f32, fogFalloff: f32, exposure: f32, mieScale: f32,
  resolution: vec2f, shadowTexel: f32, shadowRadius: f32,
  params: vec4f, // x: view (0 third, 1 first person), yzw free for later workers
  ambient: vec4f, // rgb: ground bounce albedo, w: sky fill scale
  // --- appended (world step 3) ---
  lightViewProj1: mat4x4f, // far shadow cascade (cached; re-rendered when it moves)
  shadow1: vec4f, // x: far cascade texel metres, y: radius, z: re-rendered this frame, w: valid
  haze: vec4f, // rgb: tint of the fog / aerial-perspective inscatter (1 = untinted)
  // --- appended (time-lapse sky / post, src/timefx.js) ---
  timeFx: vec4f, // x: state.timeRate (years/s), y: lapse 0..1 (smoothed, log of the rate), z: state.clock, w: state.year
  cloud: vec4f, // xy: cloud-noise offset (cells, wrapped), z: along-wind stretch, w: coverage
  pole: vec4f, // xyz: celestial pole (the sun's daily path is the circle through sunDir around it), w: star phase
  ripple: vec4f, // xy: era-crossing ripple centre (uv), z: age s (>= 1.6 inactive), w: strength
  rippleCol: vec4f, // rgb: the new era's colour, w: era index
  biomeW: vec4f, // xyz: per-biome white balance at the car (timefx.js BIO_WB), w: 1 = effects off (?fx=0)
  starPole: vec4f, // xyz: pole the star trails circle (kept in view), w: phase of the time-lapse sun beads
  rippleW: vec4f, // xyz: ripple centre on the ground under the car (world), w: fine cloud-octave offset
};
`;
// Number of f32 in Frame (must stay a multiple of 4).
export const FRAME_FLOATS = 128;

const ATMOSPHERE = /* wgsl */ `
const PI = 3.14159265;
const RG = 6360.0;            // ground radius, km
const RT = 6460.0;            // top of atmosphere, km
const RAY_S = vec3f(5.802e-3, 13.558e-3, 33.1e-3); // Rayleigh scattering, 1/km
const RAY_H = 8.0;
const MIE_S = 3.996e-3;        // Mie scattering, 1/km
const MIE_A = 4.40e-3;         // Mie absorption, 1/km
const MIE_H = 1.2;
const OZ_A = vec3f(0.650e-3, 1.881e-3, 0.085e-3); // ozone absorption, 1/km
const GROUND_ALBEDO = vec3f(0.12, 0.12, 0.09);

// Extinction at altitude h (km). mieScale scales aerosols (haze / turbidity).
fn extinctionAt(h: f32, mieScale: f32) -> vec3f {
  let r = exp(-h / RAY_H);
  let m = exp(-h / MIE_H) * mieScale;
  let o = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  return RAY_S * r + vec3f(MIE_S + MIE_A) * m + OZ_A * o;
}

fn raySphere(ro: vec3f, rd: vec3f, rad: f32) -> vec2f {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - rad * rad;
  let d = b * b - c;
  if (d < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn phaseRayleigh(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn phaseMie(c: f32) -> f32 {
  let g = 0.8;
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Transmittance LUT parameterisation: x = cos(zenith) mapped 0..1, y = sqrt(h / H).
fn transUV(hKm: f32, mu: f32) -> vec2f {
  return vec2f(mu * 0.5 + 0.5, sqrt(clamp(hKm / (RT - RG), 0.0, 1.0)));
}
`;

// Bindings shared by every main-pass pipeline (group 0).
const MAIN_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var linSamp: sampler;
@group(0) @binding(4) var shadowMap: texture_depth_2d;
@group(0) @binding(5) var shadowSamp: sampler_comparison;
@group(0) @binding(6) var shadowMap1: texture_depth_2d;
`;

const MAIN_FUNCS = /* wgsl */ `
fn camHeightKm() -> f32 { return max(F.camPos.y * 0.001, 0.0) + 0.002; }

fn transmittanceTo(hKm: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, linSamp, transUV(hKm, mu), 0.0).rgb;
}

// Sun illuminance arriving at the camera's altitude (HDR units).
fn sunIlluminance() -> vec3f {
  return F.sunIntensity * transmittanceTo(camHeightKm(), F.sunDir.y);
}

// Sky-view LUT: x = azimuth from the sun 0..pi, y = elevation with sqrt warp around the horizon.
fn skyUV(dir: vec3f) -> vec2f {
  let elev = asin(clamp(dir.y, -1.0, 1.0));
  let l = sign(elev) * sqrt(abs(elev) / (0.5 * PI));
  let hs = vec2f(F.sunDir.x, F.sunDir.z);
  let hd = vec2f(dir.x, dir.z);
  let ls = length(hs);
  let ld = length(hd);
  var ca = 1.0;
  if (ls > 1e-4 && ld > 1e-4) { ca = dot(hs, hd) / (ls * ld); }
  let az = acos(clamp(ca, -1.0, 1.0)) / PI;
  return vec2f(az, 0.5 + 0.5 * l);
}

// Sky radiance (no sun disk) in direction dir, HDR units.
fn skyRadiance(dir: vec3f) -> vec3f {
  return textureSampleLevel(skyLUT, linSamp, skyUV(dir), 0.0).rgb * F.sunIntensity;
}

// Irradiance-ish ambient for a surface normal (5 LUT taps): zenith + a ring of horizon
// samples toward / away from / beside the sun, weighted by the normal, plus light bounced
// off the sunlit ground (biome albedo, F.ambient.rgb) and a whitish multiple-scattering fill
// (the sky-view LUT is single-scattering dominated and alone leaves shadows near black).
fn skyAmbient(n: vec3f) -> vec3f {
  let up = skyRadiance(vec3f(0.0, 1.0, 0.0));
  let s = normalize(vec3f(F.sunDir.x, 0.0, F.sunDir.z) + vec3f(1e-4, 0.0, 0.0));
  let sp = vec3f(-s.z, 0.0, s.x);
  let hS = skyRadiance(normalize(s + vec3f(0.0, 0.3, 0.0)));
  let hA = skyRadiance(normalize(-s + vec3f(0.0, 0.3, 0.0)));
  let hP = skyRadiance(normalize(sp + vec3f(0.0, 0.3, 0.0)));
  let ns = dot(n, s);
  let ring = (hS * (1.0 + ns) + hA * (1.0 - ns) + hP * 2.0) * 0.25;
  let skyW = saturate1(n.y * 0.5 + 0.5);
  let sunE = sunIlluminance() * max(F.sunDir.y, 0.0);
  let fill = sunIlluminance() * vec3f(0.85, 0.9, 1.0) * 0.028 * smoothstep(-0.05, 0.15, F.sunDir.y);
  let sky = (mix(ring, up, 0.35 * skyW) * PI + fill) * F.ambient.w * mix(0.5, 1.0, skyW);
  // Ground bounce: full for downward faces, some for all (surrounding grass, trees).
  let gnd = F.ambient.rgb * (sunE + up * PI);
  return sky + gnd * mix(1.0, 0.3, skyW);
}
fn saturate1(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

// Aerial perspective + height fog. Transmittance from the atmosphere (Rayleigh+Mie at
// the camera altitude) and an exponential height-fog term; inscatter colour is the sky
// radiance along the view ray (the asymptotic inscatter), so far objects melt into the sky.
fn applyFog(col: vec3f, wp: vec3f) -> vec3f {
  let d = wp - F.camPos;
  let dist = length(d);
  let v = d / max(dist, 1e-3);
  let hKm = camHeightKm();
  let atm = (RAY_S * exp(-hKm / RAY_H) + vec3f(MIE_S + MIE_A) * exp(-hKm / MIE_H) * F.mieScale) * (dist * 0.001);
  let k = F.fogFalloff;
  let kd = k * v.y * dist;
  var hf = 1.0;
  if (abs(kd) > 1e-4) { hf = (1.0 - exp(-kd)) / kd; }
  let fogOD = F.fogDensity * exp(-k * F.camPos.y) * hf * dist;
  let T = exp(-(atm + vec3f(fogOD)));
  let vs = normalize(vec3f(v.x, max(v.y, 0.0), v.z));
  let insc = skyRadiance(vs) * F.haze.rgb;
  return col * T + insc * (1.0 - T);
}

// Far cascade (shadowMap1, ~2 km across): 2x2 filtered taps; 1 outside it.
fn shadowFar(wp: vec3f, n: vec3f, ndl: f32) -> f32 {
  if (F.shadow1.w < 0.5) { return 1.0; }
  let bias = F.shadow1.x * 1.6 * (1.0 + 2.0 * (1.0 - abs(ndl)));
  let p = F.lightViewProj1 * vec4f(wp + n * bias + F.sunDir * 1.2, 1.0);
  let edge = max(abs(p.x), abs(p.y));
  if (edge >= 1.0 || p.z <= 0.0 || p.z >= 1.0) { return 1.0; }
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  // Wide soft filter (8 rotated taps, ~2.5 texels): the casters are coarse terrain tiles, so
  // a sharp lookup would trace their triangles.
  let st = 2.5 / vec2f(textureDimensions(shadowMap1));
  var s = 0.0;
  for (var k = 0; k < 4; k++) {
    let a = f32(k) * 1.5707963 + 0.5;
    let r = select(1.0, 0.45, (k & 1) == 1);
    s += textureSampleCompareLevel(shadowMap1, shadowSamp, uv + vec2f(cos(a), sin(a)) * r * st, p.z);
  }
  s *= 0.25;
  return mix(s, 1.0, smoothstep(0.88, 1.0, edge));
}

// Directional shadow: 0 = fully shadowed, 1 = lit. Near cascade: contact-hardening PCF (see
// below); beyond it (and across its fading edge) the far cascade.
fn shadowAt(wp: vec3f, n: vec3f) -> f32 {
  let ndl = dot(n, F.sunDir);
  let bias = F.shadowTexel * 2.0 * (1.0 + 2.0 * (1.0 - abs(ndl)));
  let p = F.lightViewProj * vec4f(wp + n * bias, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let z = p.z;
  let edge = max(abs(p.x), abs(p.y));
  if (edge >= 1.0 || z <= 0.0 || z >= 1.0) { return shadowFar(wp, n, ndl); }
  let dim = vec2f(textureDimensions(shadowMap));
  let st = vec2f(1.0) / dim;
  // Contact-hardening (PCSS-style) within ~90 m: a 4-tap blocker search finds how far above the
  // receiver the caster is; the filter widens with that distance, so shadows are crisp where
  // objects touch the ground (tyres, trunks) and soft under high crowns and fronds. Further
  // away a fixed 4-tap filter (the texels are already sub-pixel there).
  var s = 0.0;
  if (distance(wp, F.camPos) > 90.0) {
    for (var k = 0; k < 4; k++) {
      let a = f32(k) * 1.5707963 + 0.4;
      s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(cos(a), sin(a)) * 1.2 * st, z);
    }
    s *= 0.25;
  } else {
    var bsum = 0.0;
    var bn = 0.0;
    for (var k = 0; k < 4; k++) {
      let a = f32(k) * 1.5707963 + 0.7;
      let tc = clamp(vec2i((uv + vec2f(cos(a), sin(a)) * 5.0 * st) * dim), vec2i(0), vec2i(dim) - 1);
      let d = textureLoad(shadowMap, tc, 0);
      if (d < z - 0.00002) { bsum += d; bn += 1.0; }
    }
    s = textureSampleCompareLevel(shadowMap, shadowSamp, uv, z);
    if (bn > 0.0) {
      let rad = clamp((z - bsum / bn) * 2999.0 * 0.035 / F.shadowTexel, 1.0, 9.0);
      for (var k = 0; k < 6; k++) {
        let a = f32(k) * 2.3999632 + 0.4;
        let r = sqrt((f32(k) + 0.5) / 6.0) * rad;
        s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(cos(a), sin(a)) * r * st, z);
      }
      s /= 7.0;
    }
  }
  let fade = smoothstep(0.85, 1.0, edge);
  if (fade > 0.0) { return mix(s, shadowFar(wp, n, ndl), fade); }
  return s;
}

// Simple lit surface: Lambert sun with shadow + sky ambient. Returns HDR radiance.
fn shadeLambert(albedo: vec3f, n: vec3f, wp: vec3f, ao: f32) -> vec3f {
  let ndl = max(dot(n, F.sunDir), 0.0);
  var sh = 1.0;
  if (ndl > 0.0) { sh = shadowAt(wp, n); }
  let sun = sunIlluminance() * (ndl * sh / PI);
  let amb = skyAmbient(n) * (ao / PI);
  return albedo * (sun + amb);
}
`;

// Header for main-pass shader modules.
export const MAIN_HEADER = FRAME_STRUCT + ATMOSPHERE + MAIN_BINDINGS + MAIN_FUNCS;

// Header for shadow-pass shader modules (only the frame uniform is bound).
export const SHADOW_HEADER = FRAME_STRUCT + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
`;

// Header for the atmosphere LUT passes (frame + transmittance LUT + sampler).
export const ATMO_HEADER = FRAME_STRUCT + ATMOSPHERE;
