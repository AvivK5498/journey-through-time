// Ground shading shared by the terrain (and anything else that wants it): Lambert sun with
// shadow, a rough GGX lobe (the sheen of dust, sand and snow toward a low sun), sky ambient,
// a sky reflection that grows with smoothness, stable snow glints, and still water.
// Needs MAIN_HEADER and WORLD_WGSL (noise). No derivatives inside (callable from branches).

export const SURF_WGSL = /* wgsl */ `
// alb: albedo, spec: F0 (0.02 dielectric .. 0.9 polished ice), rough: GGX roughness,
// glint: 0..1 snow glint amount, fw: pixel footprint (m).
fn shadeSurfG(alb: vec3f, n: vec3f, wp: vec3f, ao: f32, spec: f32, rough: f32, glint: f32, fw: f32) -> vec3f {
  let v = normalize(F.camPos - wp);
  let l = F.sunDir;
  let ndl = max(dot(n, l), 0.0);
  var sh = 1.0;
  if (ndl > 0.0) { sh = shadowAt(wp, n); }
  let sunL = sunIlluminance();
  let nv = max(dot(n, v), 1e-3);
  let h = normalize(l + v);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let a = max(rough * rough, 0.002);
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let G = 1.0 / ((ndl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
  let Fs = spec + (1.0 - spec) * pow(1.0 - vh, 5.0) * (1.0 - rough) * (1.0 - rough);
  let specS = min(D * G * Fs * 0.25 * ndl, 60.0);
  var col = sunL * sh * (alb * (ndl / PI) + vec3f(specS));
  col += alb * skyAmbient(n) * (ao / PI);
  // Sky reflection, fading with roughness.
  let r = reflect(-v, n);
  let Fe = spec + (1.0 - spec) * pow(1.0 - nv, 5.0);
  let sm = (1.0 - rough) * (1.0 - rough) * (1.0 - rough);
  col += skyRadiance(normalize(vec3f(r.x, max(r.y, 0.02), r.z))) * Fe * sm * ao;
  // Snow glints: rare facets in a world-anchored 3 cm grid catch the sun; only where a
  // pixel is small enough to resolve them, so they are stable rather than shimmering.
  if (glint > 0.0 && fw < 0.02 && ndl > 0.0) {
    let c = floor(wp.xz * 34.0);
    let hh = hash2(i32(c.x), i32(c.y) + 7177);
    if (hh > 0.985) {
      let fn_ = normalize(vec3f(hash2(i32(c.x) + 31, i32(c.y)) - 0.5, 1.2, hash2(i32(c.x), i32(c.y) + 57) - 0.5));
      let g = pow(max(dot(fn_, h), 0.0), 900.0) * smoothstep(0.02, 0.006, fw);
      col += sunL * sh * g * glint * 6.0;
    }
  }
  return col;
}
// shadeSurfG with the lighting probe (world.js) for the sun and the sky ambient: the terrain's
// lighting without the per-pixel sky LUT taps.
fn shadeSurfP(alb: vec3f, n: vec3f, wp: vec3f, ao: f32, spec: f32, rough: f32, glint: f32, fw: f32) -> vec3f {
  let v = normalize(F.camPos - wp);
  let l = F.sunDir;
  let ndl = max(dot(n, l), 0.0);
  var sh = 1.0;
  if (ndl > 0.0) { sh = shadowAt(wp, n); }
  let sunL = probeSun();
  let nv = max(dot(n, v), 1e-3);
  let h = normalize(l + v);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let a = max(rough * rough, 0.002);
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let G = 1.0 / ((ndl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
  let Fs = spec + (1.0 - spec) * pow(1.0 - vh, 5.0) * (1.0 - rough) * (1.0 - rough);
  let specS = min(D * G * Fs * 0.25 * ndl, 60.0);
  var col = sunL * sh * (alb * (ndl / PI) + vec3f(specS));
  col += alb * probeAmb(n) * (ao / PI);
  let sm = (1.0 - rough) * (1.0 - rough) * (1.0 - rough);
  if (sm > 0.01) {
    let r = reflect(-v, n);
    let Fe = spec + (1.0 - spec) * pow(1.0 - nv, 5.0);
    col += skyRadiance(normalize(vec3f(r.x, max(r.y, 0.02), r.z))) * Fe * sm * ao;
  }
  if (glint > 0.0 && fw < 0.012 && ndl > 0.0) {
    let c = floor(wp.xz * 34.0);
    let hh = hash2(i32(c.x), i32(c.y) + 7177);
    if (hh > 0.988) {
      let fn_ = normalize(vec3f(hash2(i32(c.x) + 31, i32(c.y)) - 0.5, 1.2, hash2(i32(c.x), i32(c.y) + 57) - 0.5));
      let g = pow(max(dot(fn_, h), 0.0), 900.0) * smoothstep(0.012, 0.004, fw);
      col += sunL * sh * g * glint * 2.5;
    }
  }
  return col;
}
fn shadeSurf(alb: vec3f, n: vec3f, wp: vec3f, ao: f32, spec: f32, rough: f32, glint: f32) -> vec3f {
  return shadeSurfG(alb, n, wp, ao, spec, rough, glint, 1.0);
}

// Still water at wp (the surface is the terrain itself, flattened to the water level).
fn shadeWater(wp: vec3f, dist: f32, fw: f32, w: vec3f) -> vec3f { return shadeWaterR(wp, dist, fw, w, 0.0); }
// rd: distance from the river's centre line (m): shallow, sandy-turquoise water at the banks,
// deep teal in the middle; slow ripples break the sky reflection.
fn shadeWaterR(wp: vec3f, dist: f32, fw: f32, w: vec3f, rd: f32) -> vec3f {
  let v = normalize(F.camPos - wp);
  let q = wp.xz;
  let t = F.time;
  let amp = 0.06 * (1.0 - smoothstep(30.0, 400.0, dist));
  var nn = vec3f(0.0, 1.0, 0.0);
  if (amp > 0.0) {
    let e = 0.2;
    let lod = log2(max(fw * 1.4 * 8.0, 1e-3));
    let o1 = vec2f(t * 0.07, t * 0.02);
    let o2 = vec2f(t * 0.05, t * 0.11);
    let h0 = tnl(q * 0.45 + o1, lod - 1.6).x + 0.5 * tnl(q * 1.4 - o2, lod).y;
    let hx = tnl((q + vec2f(e, 0.0)) * 0.45 + o1, lod - 1.6).x + 0.5 * tnl((q + vec2f(e, 0.0)) * 1.4 - o2, lod).y;
    let hz = tnl((q + vec2f(0.0, e)) * 0.45 + o1, lod - 1.6).x + 0.5 * tnl((q + vec2f(0.0, e)) * 1.4 - o2, lod).y;
    nn = normalize(vec3f(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
  }
  // Long slow swirls of the current: a faint streaky variation in the reflection.
  let cur = tnl(q * 0.02 + vec2f(t * 0.01, 0.0), 0.0).z * 0.5 + 0.5 * tnl(q * 0.07, 0.0).w;
  nn = normalize(nn + vec3f(cur - 0.5, 0.0, 0.5 - cur) * 0.03 * (1.0 - smoothstep(100.0, 600.0, dist)));
  let nv = max(dot(nn, v), 1e-3);
  let r = reflect(-v, nn);
  var refl = skyRadiance(normalize(vec3f(r.x, max(r.y, 0.01), r.z)));
  // Low reflected rays meet the far bank (palms, reeds, earth), not the sky.
  let ambUp = probeAmb(vec3f(0.0, 1.0, 0.0));
  let bankC = vec3f(0.05, 0.075, 0.04) * (ambUp / PI + probeSun() * max(F.sunDir.y, 0.0) * 0.2);
  refl = mix(refl, bankC, (1.0 - smoothstep(0.015, 0.09, r.y)) * 0.75);
  let fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  let sunL = probeSun();
  let sh = shadowAt(wp, vec3f(0.0, 1.0, 0.0));
  let deep = select(1.0, smoothstep(15.0, 4.0, rd), rd > 0.0);
  let bodyC = mix(vec3f(0.11, 0.15, 0.11), vec3f(0.025, 0.085, 0.09), deep);
  let body = bodyC * (ambUp / PI + sunL * sh * max(F.sunDir.y, 0.0) * 0.16);
  let glint = pow(max(dot(r, F.sunDir), 0.0), 700.0) * 25.0 * sh;
  return mix(body, refl, fres) + sunL * glint * fres;
}
// Open sea (the coast): long swell plus chop for the normal (both fade with distance so the far
// water settles to a clean mirror of the sky toward the horizon), deep blue-teal body that turns
// turquoise over the shallows, sun glitter, and a foam line that runs up the beach and back.
fn shadeSea(wp: vec3f, dist: f32, fw: f32) -> vec3f {
  let v = normalize(F.camPos - wp);
  let q = wp.xz;
  let t = F.time;
  let depth = clamp(W.sea.x - wp.y, 0.0, 0.6);
  var nn = vec3f(0.0, 1.0, 0.0);
  let amp = 0.11 * (1.0 - 0.7 * smoothstep(60.0, 1500.0, dist));
  if (amp > 0.0) {
    let lod = log2(max(fw * 8.0, 1e-3));
    let e = 0.35;
    let o1 = vec2f(t * 0.05, -t * 0.09);
    let o2 = vec2f(-t * 0.13, t * 0.04);
    let hA = tnl(q * 0.12 + o1, lod - 3.0).x + 0.6 * tnl(q * 0.55 + o2, lod - 0.8).y;
    let hX = tnl((q + vec2f(e, 0.0)) * 0.12 + o1, lod - 3.0).x + 0.6 * tnl((q + vec2f(e, 0.0)) * 0.55 + o2, lod - 0.8).y;
    let hZ = tnl((q + vec2f(0.0, e)) * 0.12 + o1, lod - 3.0).x + 0.6 * tnl((q + vec2f(0.0, e)) * 0.55 + o2, lod - 0.8).y;
    nn = normalize(vec3f(-(hX - hA) / e * amp * 4.0, 1.0, -(hZ - hA) / e * amp * 4.0));
  }
  // Swell: long crests rolling toward the shore (along -W.sea.yz).
  let sw = dot(q, W.sea.yz) * 0.09 + t * 0.8;
  nn = normalize(nn + vec3f(W.sea.y, 0.0, W.sea.z) * cos(sw) * 0.06 * (1.0 - smoothstep(200.0, 1500.0, dist)));
  let nv = max(dot(nn, v), 1e-3);
  let r = reflect(-v, nn);
  // Stylised: the reflection is tinted toward the deep blue and capped, so the sea keeps a strong
  // colour at grazing angles (toward the sun too) instead of turning into a pale sheet.
  let sky = skyRadiance(normalize(vec3f(r.x, max(r.y, 0.004), r.z)));
  let refl = mix(sky * vec3f(0.45, 0.68, 1.0), probeSkyUp() * vec3f(0.5, 0.7, 1.0), 0.35);
  let fres = 0.03 + 0.42 * pow(1.0 - nv, 4.0);
  let sunL = probeSun();
  let sh = shadowAt(wp, vec3f(0.0, 1.0, 0.0));
  let ambUp = probeAmb(vec3f(0.0, 1.0, 0.0));
  let shallow = smoothstep(0.6, 0.15, depth);
  let bodyC = mix(vec3f(0.01, 0.06, 0.16), vec3f(0.03, 0.19, 0.22), shallow);
  let body = bodyC * (ambUp / PI + sunL * sh * max(F.sunDir.y, 0.0) * 0.2);
  // Sun glitter: a narrow band of sparkles under the sun, not a wash.
  let rs = max(dot(r, F.sunDir), 0.0);
  let spark = smoothstep(0.55, 0.9, tnl(q * 1.7 + vec2f(t * 0.6, -t * 0.4), log2(max(fw * 14.0, 1e-3))).x);
  let gl = pow(rs, 900.0) * 30.0 + pow(rs, 160.0) * 2.2 * spark;
  var col = mix(body, refl, fres) + sunL * gl * sh * 0.08;
  // Foam where the water is thin over the beach, surging with the swell.
  let surge = 0.5 + 0.5 * sin(t * 0.8 + dot(q, W.sea.yz) * 0.03 + tnl(q * 0.02, 0.0).x * 6.0);
  let fz = tnl(q * 0.6 + vec2f(t * 0.1, 0.0), log2(max(fw * 8.0, 1e-3))).z;
  let foam = smoothstep(0.32 + 0.22 * surge, 0.05, depth) * (0.6 + 0.4 * fz);
  col = mix(col, vec3f(0.86, 0.88, 0.9) * (ambUp / PI + sunL * sh * max(F.sunDir.y, 0.1) / PI), saturate(foam * 1.2));
  return col;
}
`;
