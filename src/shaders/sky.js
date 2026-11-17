// Atmosphere LUT passes, the sky backdrop and the tonemap / output pass.
// Single-scattering Rayleigh + Mie + ozone atmosphere (after Hillaire 2020, reduced):
//   transmittance LUT 256x64  (recomputed only when mieScale changes)
//   sky-view LUT     192x128  (recomputed every frame, ~25k texels)
// The sky pass and applyFog() in common.js sample the sky-view LUT.

import { ATMO_HEADER, FRAME_STRUCT, MAIN_HEADER } from './common.js';

const FULLSCREEN = /* wgsl */ `
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const TRANSMITTANCE_WGSL = ATMO_HEADER + FULLSCREEN + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;

@fragment fn fsTrans(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(256.0, 64.0);
  let mu = uv.x * 2.0 - 1.0;
  let h = uv.y * uv.y * (RT - RG);
  let ro = vec3f(0.0, RG + h + 1e-3, 0.0);
  let rd = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  let g = raySphere(ro, rd, RG);
  if (g.x > 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let tmax = raySphere(ro, rd, RT).y;
  let N = 40;
  let dt = tmax / f32(N);
  var od = vec3f(0.0);
  for (var i = 0; i < N; i++) {
    let p = ro + rd * ((f32(i) + 0.5) * dt);
    od += extinctionAt(length(p) - RG, F.mieScale) * dt;
  }
  return vec4f(exp(-od), 1.0);
}
`;

export const SKYVIEW_WGSL = ATMO_HEADER + FULLSCREEN + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var linSamp: sampler;

fn trans(hKm: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, linSamp, transUV(hKm, mu), 0.0).rgb;
}

@fragment fn fsSkyView(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(192.0, 128.0);
  let az = uv.x * PI;
  let l = uv.y * 2.0 - 1.0;
  let elev = sign(l) * l * l * 0.5 * PI;
  let sunEl = asin(clamp(F.sunDir.y, -1.0, 1.0));
  let sun = vec3f(cos(sunEl), sin(sunEl), 0.0);
  let rd = vec3f(cos(elev) * cos(az), sin(elev), cos(elev) * sin(az));
  let hCam = max(F.camPos.y * 0.001, 0.0) + 0.002;
  let ro = vec3f(0.0, RG + hCam, 0.0);
  let tg = raySphere(ro, rd, RG).x;
  let hitGround = tg > 0.0;
  var tmax = raySphere(ro, rd, RT).y;
  if (hitGround) { tmax = tg; }
  let c = dot(rd, sun);
  let pR = phaseRayleigh(c);
  let pM = phaseMie(c);
  let N = 32;
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  var tPrev = 0.0;
  for (var i = 0; i < N; i++) {
    let f = (f32(i) + 1.0) / f32(N);
    let t = tmax * f * f;
    let dt = t - tPrev;
    let tm = 0.5 * (t + tPrev);
    tPrev = t;
    let p = ro + rd * tm;
    let r = length(p);
    let h = r - RG;
    let up = p / r;
    let muS = dot(up, sun);
    let rayS = RAY_S * exp(-h / RAY_H);
    let mieS = MIE_S * exp(-h / MIE_H) * F.mieScale;
    let ext = extinctionAt(h, F.mieScale);
    let ts = trans(h, muS);
    // Single scattering plus a small isotropic multiple-scattering approximation.
    let ms = (rayS + vec3f(mieS)) * (0.06 * trans(h, max(muS, 0.08)) * smoothstep(-0.25, 0.1, muS));
    let S = (rayS * pR + vec3f(mieS * pM)) * ts + ms;
    let sT = exp(-ext * dt);
    L += T * S * (1.0 - sT) / max(ext, vec3f(1e-7));
    T *= sT;
  }
  if (hitGround) {
    let p = ro + rd * tmax;
    let up = normalize(p);
    let muS = dot(up, sun);
    L += T * trans(0.0, muS) * GROUND_ALBEDO * (max(muS, 0.0) / PI);
  }
  return vec4f(L, 1.0);
}
`;

// Sky backdrop, drawn last in the main pass with depthCompare 'equal' against the
// cleared depth (0), so it only shades pixels nothing else covered.
//
// Time-lapse (F.timeFx.y = lapse L 0..1, from the rate of time; src/timefx.js). One morph
// level g = pow(L, 1.5) drives everything, so the sky collapses back as one:
//  - the sun disk stretches along its daily path (the great circle around F.pole.xyz through
//    sunDir, chosen to arc across the view) into a white-hot band with a gold-to-orange
//    falloff, hottest at the key sun (where it "is on average"), widened by the seasons;
//  - aliased "beads" of sunlight run along the band (the strobe of a time-lapse camera, each
//    pixel brightens at < 1 Hz) and warm the horizon where they set;
//  - day and night average out: the upper sky deepens toward a dusky blue (horizon kept, so
//    the fog still matches it) and long tinted star trails circle F.starPole in its dark part;
//  - the stylised cloud layer stretches along the wind and races (F.cloud, F.rippleW.w).
// The key light (F.sunDir) never moves with the lapse.
export const SKY_WGSL = MAIN_HEADER + /* wgsl */ `
@vertex fn vsSky(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

const WIND = vec2f(0.8, 0.6);
const CLOUD_H = 1900.0;
const CLOUD_CELL = 1500.0;
const TAU = 6.2831853;

fn hashSky(p: vec2i) -> f32 { // periodic: 256 cells
  let q = vec2u(p & vec2i(255));
  var h = (q.x * 0x27d4eb2du) ^ (q.y * 0x165667b1u + 0x9e3779b9u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = h ^ (h >> 12u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
fn vnSky(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashSky(i), hashSky(i + vec2i(1, 0)), u.x), mix(hashSky(i + vec2i(0, 1)), hashSky(i + vec2i(1, 1)), u.x), u.y);
}
fn hashU(a: u32, b: u32) -> u32 {
  var h = (a * 0x8da6b343u) ^ (b * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
fn wrapPi(x: f32) -> f32 { return x - TAU * floor(x / TAU + 0.5); }

// Cloud density 0..1 at noise coords q (coarse octaves) and qf (fine octave, stretched less so
// it reads as dashes crawling along the streaks). lod 0..1 fades the fine octave (far clouds).
fn cloudField(q: vec2f, qf: vec2f, cov: f32, soft: f32, lod: f32) -> f32 {
  // Domain warp by the coarse octave for rounder, billowing shapes.
  let w = vnSky(q * 0.5 + vec2f(3.1, 7.7));
  let wo = vec2f(w * 0.55, w * 0.45);
  let qq = q + wo;
  var n = vnSky(qq) * 0.52 + vnSky(qq * 2.0 + vec2f(5.2, 1.3)) * 0.27 + vnSky((qf + wo) * 4.0 + vec2f(1.7, 9.2)) * 0.16 * lod;
  n = n / (0.79 + 0.16 * lod);
  let th = 1.0 - cov;
  return smoothstep(th - 0.03 - soft, th + 0.13 + soft, n);
}

@fragment fn fsSky(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / F.resolution;
  // Unproject a point far down the ray (reverse-Z: small depth = far) rather than on the near
  // plane, so the direction keeps its precision when the camera is kilometres from the origin.
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1e-4, 1.0);
  let w = F.invViewProj * ndc;
  let dir = normalize(w.xyz / w.w - F.camPos);
  var col = skyRadiance(dir);
  let rad = 0.0075;
  let fxOn = F.biomeW.w < 0.5;
  let L = select(0.0, F.timeFx.y, fxOn);
  let g = pow(L, 1.5);

  // Daily-path frame: pole p, path radius rho, e1 toward the key sun, e2 along the motion.
  let p = F.pole.xyz;
  let c0 = dot(F.sunDir, p);
  let rho = acos(clamp(c0, -1.0, 1.0));
  let e1 = normalize(F.sunDir - p * c0);
  let e2 = cross(p, e1);
  let th = acos(clamp(dot(dir, p), -1.0, 1.0));
  let phi = atan2(dot(dir, e2), dot(dir, e1));
  let along = phi * sin(rho);
  // Seasons: the whole arc tilts slowly about the key sun (period ~5 s at full lapse;
  // F.starPole.w wraps at 10 turns, so w * 0.1 wraps at one whole cycle).
  let sway = 0.05 * pow(L, 1.5) * sin(F.starPole.w * 0.1);
  let across = th - rho - sway * along;
  // Star frame: the same pole as the sun band, so the whole sky turns about one axis.
  let sp = p;
  let sa = normalize(cross(sp, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-5, 0.0, 0.0));
  let sb = cross(sp, sa);
  let sth = acos(clamp(dot(dir, sp), -1.0, 1.0));
  let sphi = atan2(dot(dir, sb), dot(dir, sa));
  let sthW = fwidth(sth); // star-trail line width (derivatives in uniform control flow)

  let horizon = smoothstep(-0.03, 0.02, dir.y);
  let glowL = F.sunIntensity * transmittanceTo(camHeightKm(), max(dir.y, 0.0));
  let cS = dot(dir, F.sunDir);

  // Keep the sky saturated toward the sun: warm the Mie haze around it a little.
  col *= mix(vec3f(1.0), vec3f(1.04, 0.92, 0.72), smoothstep(0.55, 0.995, cS) * smoothstep(0.0, 0.1, dir.y) * 0.85);

  // Band geometry (also masks the stars).
  let k = smoothstep(0.0, 0.3, L); // disk -> band
  // The band grows and brightens with the same level that streaks the clouds, so slowing
  // down collapses it back toward the sun while the clouds settle.
  let spanA = 2.6 * pow(g, 1.4);
  let bandK = k * (0.3 + 0.7 * smoothstep(0.15, 0.85, L));
  let wB = 0.0045 + 0.024 * g; // core half width: the seasons fan the daily arcs out
  let core = exp(-pow(across / (wB + rad * (1.0 - k)), 2.0));
  let wide = exp(-abs(across) / (wB * 2.0 + 0.01));
  let nearBand = exp(-abs(across) / 0.22);

  // --- day and night average out: the upper sky deepens to a saturated dusk blue (the horizon
  // is kept, so the fog still matches it), and star trails circle F.starPole in it.
  if (L > 0.0) {
    let up = smoothstep(-0.01, 0.38, dir.y);
    let dk = g * up * (1.0 - 0.35 * nearBand);
    let zen = skyRadiance(vec3f(0.0, 1.0, 0.0));
    let zl = dot(zen, vec3f(0.2126, 0.7152, 0.0722));
    // One treatment in every biome: a deepened but still daytime blue (a floor on the zenith
    // level keeps a dim-zenith biome from going to night).
    let zq = max(zl, 0.06 * F.sunIntensity);
    // kept bright: a time-lapse sky reads as daytime blue, not navy
    let dusk = zq * mix(vec3f(0.95, 1.12, 1.45), vec3f(0.72, 0.92, 1.38), up);
    col = mix(col, dusk, dk * 0.5);
    // Star trails: dense concentric arcs about the pole, up to two per ring, each with its own
    // length, brightness and warm/cool tint; they turn with F.pole.w (the sky's rotation).
    let sv = smoothstep(0.3, 0.8, L) * smoothstep(0.03, 0.22, dir.y) * (1.0 - 0.92 * exp(-abs(across) / 0.12)) * (1.0 - smoothstep(1.0, 1.6, sth));
    if (sv > 0.002) {
      let ringW = 0.0062;
      let ri = u32(sth / ringW);
      let px = max(sthW, 2e-5) * 1.25;
      var acc = vec3f(1.0, 0.95, 0.85) * exp(-sth * sth / (px * px * 6.0)) * 3.0; // the pole star
      for (var j = 0u; j < 2u; j++) {
        let h = hashU(ri, 977u + j * 7919u);
        if ((h & 1023u) < 830u) {
          let len = 0.35 + 2.6 * f32((h >> 10u) & 255u) / 255.0;
          let start = f32((h >> 18u) & 1023u) / 1023.0 * TAU + F.pole.w;
          var dp = sphi - start;
          dp -= TAU * floor(dp / TAU);
          if (dp < len) {
            let h2 = hashU(ri, 31u + j * 101u);
            let off = (f32(ri) + 0.5 + (f32(h2 & 255u) / 255.0 - 0.5) * 0.55) * ringW - sth;
            let br = 0.25 + 0.75 * pow(f32((h2 >> 8u) & 255u) / 255.0, 1.6);
            let ends = smoothstep(0.0, 0.3, dp) * smoothstep(len, len - 0.03, dp);
            let tint = mix(vec3f(0.66, 0.80, 1.0), vec3f(1.0, 0.84, 0.62), f32((h2 >> 16u) & 31u) / 31.0);
            acc += tint * exp(-off * off / (px * px)) * br * ends * (0.3 + 0.7 * dp / len);
          }
        }
      }
      col += acc * zl * 0.55 * sv;
    }
  }

  // --- the sun: disk at rest, stretched along its daily path into a band as time speeds up.
  let m = sqrt(pow(along * rad / (rad + spanA), 2.0) + pow(across * rad / (rad + 0.4 * wB * k), 2.0));
  // Glow around the disk: a tight warm halo and a small pale-gold aureole; fades into the band.
  col += glowL * horizon * vec3f(1.0, 0.86, 0.66) * ((2.0 * exp(-m / 0.010) + 0.10 * exp(-m / 0.05)) * (1.0 - k));
  if (L > 0.0) {
    // Along the path: full length of the visible arc at cruise, fading toward its ends.
    let fall = exp(-1.1 * pow(along / (spanA + 0.05), 2.0));
    // The sun's average position stays hottest.
    let hot = exp(-pow(along / (0.15 + 0.3 * g), 2.0));
    let white = vec3f(1.0, 0.95, 0.84);
    let gold = vec3f(1.0, 0.66, 0.26);
    let bv = smoothstep(0.3, 0.8, L);
    // Beads: the strobe of the daily cycle racing along the band, seven per circuit
    // (each pixel pulses at < 2 Hz).
    // No travelling head: a steady profile with a fine, low-contrast shimmer flowing along it.
    let bead = 0.42 + 0.06 * sin(along * 90.0 - F.starPole.w * 2.0) * sin(along * 37.0 + F.starPole.w);
    // Season lines: faint parallel day-arcs drifting slowly across the band.
    let sw = across / (wB * 0.6 + 1e-4) - F.starPole.w * 0.0159155;
    let lines = pow(0.5 + 0.5 * cos(TAU * sw), 8.0) * exp(-pow(across / (wB * 1.5), 2.0));
    var bandL = white * (core * (0.22 + 0.65 * bead * bv) + lines * (0.10 + 0.08 * bead) * bv)
      + gold * (wide * (0.05 + 0.16 * bead * bv) + nearBand * 0.003);
    bandL *= (fall + hot * 0.5) * 0.75;
    // Where a bead nears the horizon, warm it (sunrise / sunset sweeping round).
    let lowB = 1.0 - smoothstep(0.0, 0.2, dir.y);
    bandL += vec3f(1.0, 0.5, 0.2) * bead * lowB * exp(-abs(across) / 0.35) * 0.03 * bv * (fall + 0.3);
    // Fade the band into the horizon glow instead of standing on it.
    col += glowL * horizon * smoothstep(-0.01, 0.08, dir.y) * bandK * bandL;
  }
  if (m < rad && k < 1.0) {
    let x = clamp(m / rad, 0.0, 1.0);
    let x2 = x * x;
    let limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - x2, 0.0)));
    let edge = 1.0 - smoothstep(0.9, 1.0, x);
    let sunL = F.sunIntensity * transmittanceTo(camHeightKm(), dir.y) / (PI * rad * rad);
    col += min(sunL, vec3f(3000.0)) * limb * edge * (1.0 - k);
  }

  // --- clouds (stylised layer above the camera, lit by the key sun; in front of the band and
  // the stars). Mapped on a flattened dome so they keep round shapes toward the horizon; at
  // rest soft puffs, at speed stretched along the wind into thin bright racing streaks.
  let cloudW = F.cloud.w; // per-biome coverage from timefx.js
  if (fxOn && dir.y > 0.0 && cloudW > 0.0) {
    let t = CLOUD_H / (dir.y + 0.2);
    let rel = dir.xz * t;
    // At speed the streaks turn to run around the same pole as the band and star trails
    // (one sky spinning); at rest they keep the wind direction.
    var bandAx = vec2f(-p.z, p.x) + vec2f(1e-4, 0.0);
    bandAx = normalize(bandAx) * select(1.0, -1.0, dot(bandAx, WIND) < 0.0);
    let WD = normalize(mix(WIND, bandAx, smoothstep(0.25, 0.75, L)));
    let a = dot(rel, WD);
    let b = dot(rel, vec2f(-WD.y, WD.x));
    let crossS = 1.0 - 0.65 * g;
    let q = vec2f(a / (CLOUD_CELL * F.cloud.z), b / (CLOUD_CELL * crossS)) + F.cloud.xy;
    let qf = vec2f(a / (CLOUD_CELL * (1.0 + 2.2 * g)), b / (CLOUD_CELL * crossS)) + vec2f(F.rippleW.w, F.cloud.y);
    let lod = 1.0 - smoothstep(9000.0, 20000.0, t);
    let soft = 0.03 * g;
    let cov = cloudW - 0.06 * g;
    let d = cloudField(q, qf, cov, soft, lod);
    if (d > 0.002) {
      let sh = vec2f(dot(F.sunDir.xz, WD), dot(F.sunDir.xz, vec2f(-WD.y, WD.x)));
      let qs = q + vec2f(sh.x / F.cloud.z, sh.y / crossS) * 0.2;
      let ds = smoothstep(0.94 - cov - soft, 1.22 - cov + soft, vnSky(qs + vec2f(vnSky(qs * 0.5 + vec2f(3.1, 7.7)) * 0.5, 0.0)) * 1.05);
      // Lit from the core outward (no bright rim around a pale centre, which read as hollow
      // bubbles as the streaks relaxed).
      let lit = clamp(0.85 - ds * 0.55 + d * 0.2, 0.0, 1.0);
      let sunE = F.sunIntensity * transmittanceTo(camHeightKm() + 1.9, max(F.sunDir.y, 0.02));
      let fwd = pow(max(cS, 0.0), 8.0);
      let amb = skyRadiance(vec3f(0.0, 1.0, 0.0)) * 2.2 + skyRadiance(normalize(vec3f(dir.x, 0.15, dir.z))) * 1.2;
      var cc = amb * mix(0.5, 0.95, lit) + sunE * ((0.12 + 0.14 * g) * lit * lit + 0.35 * fwd * (1.0 - d) * lit);
      // At speed the streaks carry the averaged daylight: brighter and a touch warmer.
      cc *= mix(vec3f(1.0), vec3f(1.25, 1.12, 0.95), g);
      let haze = 1.0 - exp(-t / 26000.0);
      let base = skyRadiance(dir);
      cc = mix(cc, base, haze);
      let cloudA = d * mix(0.92, 0.88, g) * smoothstep(0.0, 0.05, dir.y) * (1.0 - haze * 0.6);
      col = mix(col, cc, cloudA);
    }
  }
  return vec4f(col, 1.0);
}
`;

// Era-crossing ripple, drawn at the end of the main pass (depth-tested, additive) only while a
// ripple runs: an expanding cylinder of light centred under the car (F.rippleW.xyz), 128
// segments x 2 instances (the front and a fainter echo behind it). It starts below the ground
// so the terrain cuts its base wherever it stands; brightest at ground level, warm white at the
// base turning to the era's colour as it rises and fades. Perspective makes it thick and tall
// near the camera and a thin line toward the horizon; the car and everything else hide it.
export const RIPPLE_SEGS = 128;
export const RIPPLE_WGSL = MAIN_HEADER + /* wgsl */ `
const RSEG = 128u;
const RTAU = 6.2831853;
struct RV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) h: f32,
  @location(2) echo: f32,
};
fn rippleR(ii: u32) -> f32 {
  let t = clamp(F.ripple.z / 1.5, 0.0, 1.0);
  let R = 2.5 + 72.0 * pow(t, 1.3);
  return select(R, R * 0.8, ii == 1u);
}
@vertex fn vsRipple(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RV {
  let seg = vi / 6u;
  let c = vi % 6u;
  let cx = select(0.0, 1.0, c == 1u || c == 3u || c == 4u);
  let cy = select(0.0, 1.0, c == 2u || c == 4u || c == 5u);
  let a = (f32(seg) + cx) / f32(RSEG) * RTAU;
  let R = rippleR(ii);
  let C = F.rippleW.xyz;
  let h = mix(-14.0, 7.0 + 0.06 * R, cy);
  let wp = vec3f(C.x + cos(a) * R, C.y + h, C.z + sin(a) * R);
  var o: RV;
  o.pos = F.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.h = h;
  o.echo = f32(ii);
  return o;
}
@fragment fn fsRipple(v: RV) -> @location(0) vec4f {
  let t = clamp(F.ripple.z / 1.5, 0.0, 1.0);
  let R = rippleR(u32(v.echo));
  let fade = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.4, 1.0, t)) * F.ripple.w;
  // A crisp hot rim at grass-top height (0.8 m over the car's ground), and a faint
  // curtain of the era's colour rising behind it, fading out well below the top of the mesh.
  let top = 7.0 + 0.06 * R;
  let H = 0.9 + 0.02 * R;
  let hh = max(v.h - 0.8, 0.0);
  let rim = exp(-hh / (0.07 + 0.003 * R));
  let curtain = exp(-hh / H) * (1.0 - smoothstep(0.35, 0.9, v.h / top));
  let warm = vec3f(1.0, 0.86, 0.6);
  let era = F.rippleCol.rgb;
  // The visible ring is now drawn in screen space by the tonemap; this geometry adds nothing.
  let colr = (warm * rim * 2.2 + mix(warm, era, smoothstep(0.0, H, hh)) * curtain * 0.07) * 0.0;
  let dc = distance(v.wp, F.camPos);
  let near = smoothstep(3.0, 22.0, dc);
  let fog = exp(-dc / 1100.0);
  let I = F.sunIntensity * 0.10 * fade * near * fog * mix(1.0, 0.35, v.echo);
  return vec4f(colr * I, 0.0);
}
`;

// Bloom: one compute pass. Prefilter + 2x downsample of the resolved HDR image into a 6-level
// chain (1/2 .. 1/64 resolution), then upsample-and-add back to 1/2 resolution. Only what is
// far brighter than sunlit ground passes the threshold (sun / band, fire, the car's core).
export const BLOOM_WGSL = FRAME_STRUCT + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var add: texture_2d<f32>; // upsample: the level being added to

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Exposed-space soft threshold, with a luminance cap against single-pixel fireflies.
fn prefilter(c0: vec3f) -> vec3f {
  let c = c0 * F.exposure;
  let l = lum(c);
  let T = 1.15;
  let K = 0.5;
  var s = clamp(l - T + K, 0.0, 2.0 * K);
  s = s * s / (4.0 * K);
  let wgt = max(s, l - T) / max(l, 1e-4);
  let capped = c * min(1.0, 40.0 / max(l, 1e-4));
  return capped * wgt;
}

@compute @workgroup_size(8, 8) fn down0(@builtin(global_invocation_id) id: vec3u) {
  let dd = textureDimensions(dst);
  if (id.x >= dd.x || id.y >= dd.y) { return; }
  let ts = 1.0 / vec2f(textureDimensions(src));
  let uv = (vec2f(id.xy) * 2.0 + 1.0) * ts;
  // 4 bilinear taps over a 4x4 footprint, Karis-weighted (luma) against fireflies.
  let a = prefilter(textureSampleLevel(src, samp, uv + vec2f(-1.0, -1.0) * ts, 0.0).rgb);
  let b = prefilter(textureSampleLevel(src, samp, uv + vec2f(1.0, -1.0) * ts, 0.0).rgb);
  let c = prefilter(textureSampleLevel(src, samp, uv + vec2f(-1.0, 1.0) * ts, 0.0).rgb);
  let d = prefilter(textureSampleLevel(src, samp, uv + vec2f(1.0, 1.0) * ts, 0.0).rgb);
  let wa = 1.0 / (1.0 + lum(a)); let wb = 1.0 / (1.0 + lum(b));
  let wc = 1.0 / (1.0 + lum(c)); let wd = 1.0 / (1.0 + lum(d));
  let o = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  textureStore(dst, id.xy, vec4f(o, 1.0));
}

@compute @workgroup_size(8, 8) fn down(@builtin(global_invocation_id) id: vec3u) {
  let dd = textureDimensions(dst);
  if (id.x >= dd.x || id.y >= dd.y) { return; }
  let ts = 1.0 / vec2f(textureDimensions(src));
  let uv = (vec2f(id.xy) * 2.0 + 1.0) * ts;
  var o = textureSampleLevel(src, samp, uv, 0.0).rgb * 0.5;
  o += textureSampleLevel(src, samp, uv + vec2f(-1.0, -1.0) * ts, 0.0).rgb * 0.125;
  o += textureSampleLevel(src, samp, uv + vec2f(1.0, -1.0) * ts, 0.0).rgb * 0.125;
  o += textureSampleLevel(src, samp, uv + vec2f(-1.0, 1.0) * ts, 0.0).rgb * 0.125;
  o += textureSampleLevel(src, samp, uv + vec2f(1.0, 1.0) * ts, 0.0).rgb * 0.125;
  textureStore(dst, id.xy, vec4f(o, 1.0));
}

// dst (level i) = add (down level i) + tent upsample of src (level i + 1); wider levels
// weigh more, for a gentle, wide glow.
@compute @workgroup_size(8, 8) fn up(@builtin(global_invocation_id) id: vec3u) {
  let dd = textureDimensions(dst);
  if (id.x >= dd.x || id.y >= dd.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dd);
  let ts = 1.0 / vec2f(textureDimensions(src));
  var o = textureSampleLevel(src, samp, uv + vec2f(-0.5, -0.5) * ts, 0.0).rgb;
  o += textureSampleLevel(src, samp, uv + vec2f(0.5, -0.5) * ts, 0.0).rgb;
  o += textureSampleLevel(src, samp, uv + vec2f(-0.5, 0.5) * ts, 0.0).rgb;
  o += textureSampleLevel(src, samp, uv + vec2f(0.5, 0.5) * ts, 0.0).rgb;
  let base = textureLoad(add, vec2i(id.xy), 0).rgb;
  textureStore(dst, id.xy, vec4f(base * 0.55 + o * 0.42, 1.0));
}
`;

// The one shared tonemap and colour grade (everything in the frame goes through it):
// era-crossing ripple (screen-space ring distortion + soft flash of the era's colour) ->
// exposure -> bloom -> biome white balance -> ACES (Hill fit) filmic curve -> grade (warm
// highlights, cool shadows, rich saturation) -> sRGB -> lifted blacks / soft white cap ->
// vignette -> dither -> swapchain.
export const TONEMAP_WGSL = FRAME_STRUCT + FULLSCREEN + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

const ACES_IN = mat3x3f(
  vec3f(0.59719, 0.07600, 0.02840),
  vec3f(0.35458, 0.90834, 0.13383),
  vec3f(0.04823, 0.01566, 0.83777));
const ACES_OUT = mat3x3f(
  vec3f(1.60475, -0.10208, -0.00327),
  vec3f(-0.53108, 1.10813, -0.07276),
  vec3f(-0.07367, -0.00605, 1.07602));

fn rrtOdt(v: vec3f) -> vec3f {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash12(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q += dot(q, q.yx + 33.33);
  return fract((q.x + q.y) * q.x);
}

@fragment fn fsTonemap(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = F.resolution;
  let uv0 = pos.xy / res;
  if (F.biomeW.w > 0.5) { // ?fx=0: the original plain tonemap
    let c = textureLoad(hdr, vec2i(pos.xy), 0).rgb * F.exposure;
    var m = ACES_OUT * rrtOdt(ACES_IN * c);
    m = toSrgb(clamp(m, vec3f(0.0), vec3f(1.0)));
    let n = hash12(pos.xy) + hash12(pos.xy + 17.17) - 1.0;
    return vec4f(m + n / 255.0, 1.0);
  }
  // --- era-crossing ripple: the ring of light itself is geometry in the main pass (depth
  // tested, RIPPLE_WGSL). Here: a soft flash of the era's colour, strongest at the screen edges
  // so it never washes over the car, and a gentle refraction band where the expanding ring
  // crosses the ground (masked off the car and the cockpit).
  var uv = uv0;
  var flash = vec3f(0.0);
  let age = F.ripple.z;
  if (age < 1.6) {
    // A thin bright ring expanding in screen space from the car to past the frame corners
    // in ~1.2 s, refracting the image slightly at the ring, tinted by the era, fading as it grows.
    let t = clamp(age / 1.2, 0.0, 1.0);
    let asp = res.x / res.y;
    let sv = (uv0 - F.ripple.xy) * vec2f(asp, 1.0);
    let r = length(sv);
    let R = 0.02 + 1.35 * pow(t, 1.15);
    let wR = 0.006 + 0.012 * t;
    let x = (r - R) / wR;
    let fade = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.55, 1.0, t)) * F.ripple.w;
    let lens = -x * exp(-x * x * 0.5);
    let nrm = sv / max(r, 1e-4);
    uv = uv0 + nrm * vec2f(1.0 / asp, 1.0) * lens * 0.004 * fade;
    let ring = exp(-x * x) * fade;
    flash = mix(vec3f(1.0, 0.95, 0.85), F.rippleCol.rgb, 0.35 + 0.4 * t) * ring * (1.6 - 1.1 * t)
      + F.rippleCol.rgb * (0.05 * exp(-age * 3.0)) * F.ripple.w;
  }
  var c: vec3f;
  if (age < 1.6) { c = textureSampleLevel(hdr, samp, uv, 0.0).rgb * F.exposure; }
  else { c = textureLoad(hdr, vec2i(pos.xy), 0).rgb * F.exposure; }
  // Bloom (prefiltered, already exposed), with a little chromatic warmth in its wide tail.
  let bl = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  c += bl * vec3f(0.42, 0.41, 0.39);
  c += flash;
  // Subtle per-biome white balance (timefx.js blends it from the biome weights at the car).
  let wb = max(F.biomeW.xyz, vec3f(0.5));
  c *= wb / max(dot(wb, vec3f(0.2126, 0.7152, 0.0722)), 1e-3);
  var m = clamp(ACES_OUT * rrtOdt(ACES_IN * c), vec3f(0.0), vec3f(1.0));
  // Grade in display-linear: split-tone (cool shadows, warm highlights), saturation.
  let l = dot(m, vec3f(0.2126, 0.7152, 0.0722));
  let hiW = smoothstep(0.25, 0.85, l);
  let loW = 1.0 - smoothstep(0.02, 0.3, l);
  m *= mix(vec3f(1.0), vec3f(1.045, 1.0, 0.93), hiW * 0.8);
  m *= mix(vec3f(1.0), vec3f(0.90, 0.96, 1.16), loW * 0.85);
  let l2 = dot(m, vec3f(0.2126, 0.7152, 0.0722));
  m = max(mix(vec3f(l2), m, 1.1), vec3f(0.0));
  var s = toSrgb(clamp(m, vec3f(0.0), vec3f(1.0)));
  // Never pure black (lifted, slightly cool) nor pure white.
  s = vec3f(0.030, 0.031, 0.050) + s * 0.946;
  // Gentle vignette.
  let vq = (uv0 - 0.5) * vec2f(res.x / res.y, 1.0);
  let vg = smoothstep(0.35, 1.05, length(vq));
  s *= 1.0 - 0.16 * vg;
  // While time rushes, the frame edges cool toward dusk violet (visible in every framing).
  s *= mix(vec3f(1.0), vec3f(0.84, 0.86, 1.04), vg * F.timeFx.y * F.timeFx.y * select(1.0, 0.0, F.biomeW.w > 0.5));
  let n = hash12(pos.xy) - 0.5;
  return vec4f(s + n / 255.0, 1.0);
}
`;
