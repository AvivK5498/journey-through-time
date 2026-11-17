// Landmark 0: the first humans' camp on the African savannah, ~300,000 years ago (Middle
// Stone Age). A hearth with a living fire and a thin smoke column (the long-range signal),
// three low open windbreaks of bent saplings thatched with dry grass (hides thrown over two,
// thorn brush piled on the third), a hide lashed to a pole frame to dry, knapping debris and
// bones, an untidy heap of firewood and a flat-topped umbrella acacia at the edge of camp.
// People are very dark brown silhouettes.
//
// built is always 1 (a camp is not "under construction"). decay 0 = living camp; decay 1 =
// abandoned: a blackened ash patch with charred stubs and displaced stones, windbreaks
// collapsed into flat grey litter with a few leaning stubs, the hide fallen and shrivelled,
// grass creeping back over the trampled floor, nobody there.
//
// The engine has no transparency, so the smoke is a continuous, lumpy, sun-lit tube (e < 0.5:
// it darkens with the sky at dusk instead of glowing) that starts thin inside the flames,
// widens and leans downwind, and tapers away to nothing at the top. Only its lowest ~2 m
// carries a warm, flickering glow from the fire. Flames are thin pointed tongues (e >= 0.5:
// no shadow, they sway) graded from a yellow-white base to red tips.
//
// Ground covers (camp floor, ash patch, collapsed litter) feather into the ground by dipping
// below y = 0 along a noisy edge, so they have no hard decal outline.

import { SURF, FLICKER, MOTION, BY, noise3 } from './kit.js';

const HX = -2, HZ = 1; // hearth
const TREE_X = 9.6, TREE_Z = -5.2; // at the edge of camp, clear of the windbreaks and the smoke
const WIND_X = 0.5, WIND_Z = 0.866; // smoke drifts away from the tree
const PX = -WIND_Z, PZ = WIND_X; // perpendicular to the wind
// Windbreaks: centre x, z, radius, height, arc span, covering kind (0 grass + small hide, 1 grass + big hide, 2 grass + thorn brush)
const SHELTERS = [
  [3.3, 3.5, 1.9, 1.25, 3.3, 1],
  [2.0, -3.5, 1.6, 1.05, 3.0, 0],
  [-5.5, -3.9, 1.45, 0.95, 2.7, 2],
];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------------
// Floor colour: savannah ground at the rim, trampled earth inside, ash around the hearth,
// darker ground under the windbreaks, footpath scuffs. Grass creeps back as the camp decays.
const FC = new Float64Array(3);
const KX = -3.5, KZ = -2.0; // knapping spot
const SPEAR_X = -6.8, SPEAR_Z = -0.4;
const KNAPPER_X = KX + 0.55, KNAPPER_Z = KZ + 0.3;
// contact shade under people: x, z, radius
const FIGS = [-0.6, 1.9, 0.9, -1.5, -0.6, 0.7, -2.6, 2.65, 0.7, KNAPPER_X, KNAPPER_Z, 0.65, SPEAR_X, SPEAR_Z, 0.5, -6.4, -6.75, 0.5];
function floorEdge(a, seed) {
  return 8.8 + 2.6 * noise3(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7, 3.1) + 0.7 * Math.sin(a * 3 + seed);
}
function floorCol(x, z, decay, seed) {
  const dx = x + 1, dz = z - 0.5;
  const u = Math.hypot(dx, dz) / floorEdge(Math.atan2(dz, dx), seed);
  const patch = noise3(x * 0.45 + 7, seed * 0.3, z * 0.45);
  let bare = 1 - smooth(0.5, 0.97, u + 0.25 * (patch - 0.5));
  bare *= 1 - decay * smooth(0.25, 0.65, patch + 0.35 - 0.3 * (1 - u));
  const n = 0.92 + 0.16 * noise3(x * 0.7, 1.3, z * 0.7);
  const scuff = 1 - 0.1 * bare * smooth(0.55, 0.8, noise3(x * 2.6 + seed, 0.5, z * 0.7));
  let r = mix(0.33, 0.255, bare) * n * scuff, g = mix(0.245, 0.17, bare) * n * scuff, b = mix(0.12, 0.092, bare) * n * scuff;
  // hearth surroundings: sooty while in use, a warm grey-brown ash smear when cold
  const hr = Math.hypot(x - HX, z - HZ) * (0.85 + 0.3 * noise3(x * 1.8, 2, z * 1.8));
  const ash = (1 - smooth(0.9, 2.7, hr)) * (1 - 0.35 * decay);
  const ar = mix(0.085, 0.13, decay), ag = mix(0.075, 0.112, decay), ab = mix(0.065, 0.092, decay);
  r = mix(r, ar, 0.75 * ash); g = mix(g, ag, 0.75 * ash); b = mix(b, ab, 0.75 * ash);
  for (let i = 0; i < SHELTERS.length; i++) {
    const s = SHELTERS[i], d = Math.hypot(x - s[0], z - s[1]) / s[2];
    const k = (1 - smooth(0.5, 1.35, d)) * 0.28 * (1 - 0.8 * decay);
    r *= 1 - k; g *= 1 - k * 1.05; b *= 1 - k * 1.05;
  }
  if (decay < 0.5) {
    for (let i = 0; i < FIGS.length; i += 3) {
      const d = Math.hypot(x - FIGS[i], z - FIGS[i + 1]) / FIGS[i + 2];
      const k = 0.35 * (1 - smooth(0.2, 1, d));
      r *= 1 - k; g *= 1 - k; b *= 1 - k;
    }
  }
  FC[0] = r; FC[1] = g; FC[2] = b;
  return FC;
}

// Floor: rings out past the trampled edge; the outer band dips below the ground along a
// two-octave noise front, so the patch frays into the savannah instead of ending in a line.
function floor(b, seed, decay) {
  const SEG = 112, RING = 26, base = b.nv;
  b.surface(SURF.EARTH).ao(1).emissive(0, 0);
  for (let k = 0; k <= RING; k++) {
    for (let i = 0; i < (k ? SEG : 1); i++) {
      const a = (i / SEG) * Math.PI * 2, u = 1.34 * Math.pow(k / RING, 0.75), r = floorEdge(a, seed) * u;
      const x = -1 + Math.cos(a) * r, z = 0.5 + Math.sin(a) * r;
      const f = u + 0.3 * (noise3(x * 0.8 + seed, 4.4, z * 0.8) - 0.5) + 0.26 * (noise3(x * 2.6, 8.1, z * 2.6 + seed) - 0.5);
      const y = Math.min(0.02 - 0.05 * smooth(0.9, 1.16, f), 0.02 - 0.06 * smooth(1.14, 1.34, u));
      // live: the colour morphs to the abandoned floor (grass back, cold ash) over the decay
      const c1 = floorCol(x, z, 1, seed);
      b.timeless().morph(y, y, c1[0], c1[1], c1[2]).vanish(0.25 + 0.1 * noise3(x * 0.3, 2.2, z * 0.3), 0.9, MOTION.MORPH, 0, BY.DECAY);
      const c = floorCol(x, z, decay, seed);
      b.color(c[0], c[1], c[2]);
      b.vertex(x, y, z, 0, 1, 0);
    }
  }
  b.timeless();
  for (let i = 0; i < SEG; i++) b.tri(base, base + 1 + i, base + 1 + (i + 1) % SEG);
  for (let k = 1; k < RING; k++) {
    const r0 = base + 1 + (k - 1) * SEG, r1 = r0 + SEG;
    for (let i = 0; i < SEG; i++) { const i1 = (i + 1) % SEG; b.quad(r0 + i, r0 + i1, r1 + i1, r1 + i); }
  }
}

// ---------------------------------------------------------------------------------
// Small helpers

// Crooked branch from A to B: n beams with noisy bends, tapering r0 -> r1.
function crooked(b, ax, ay, az, bx, by, bz, r0, r1, bend, sd, n = 3, sides = 5) {
  let px = ax, py = ay, pz = az;
  for (let i = 1; i <= n; i++) {
    const t = i / n, w = i < n ? bend : 0;
    const qx = mix(ax, bx, t) + w * (noise3(sd, t * 3.1, 0.5) - 0.5) * 2;
    const qy = mix(ay, by, t) + w * 0.5 * (noise3(sd, t * 3.1, 4.5) - 0.5) * 2;
    const qz = mix(az, bz, t) + w * (noise3(sd, t * 3.1, 9.5) - 0.5) * 2;
    let ex = qx, ey = qy, ez = qz;
    if (i < n) { // run on past the joint so the next segment's bend shows no gap
      const l = Math.hypot(qx - px, qy - py, qz - pz) || 1, k = mix(r0, r1, t) * 0.8 / l;
      ex += (qx - px) * k; ey += (qy - py) * k; ez += (qz - pz) * k;
    }
    b.beam(px, py, pz, ex, ey, ez, mix(r0, r1, (i - 1) / n), mix(r0, r1, t), sides, i === n || i === 1);
    px = qx; py = qy; pz = qz;
  }
}

// Two-sided sheet: pos(u, v, out, o) writes a point; shade(nx, ny, nz, x, y, z, u, v) sets
// the material of each vertex (both faces are emitted, with opposite normals).
const SP = new Float64Array(3 * 600);
function sheet(b, NU, NV, pos, shade) {
  const W = NU + 1;
  if (W * (NV + 1) > 600) return;
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) pos(i / NU, j / NV, SP, (j * W + i) * 3);
  for (let side = 0; side < 2; side++) {
    const s = side ? -1 : 1, base = b.nv;
    for (let j = 0; j <= NV; j++) {
      for (let i = 0; i <= NU; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(NU, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NV, j + 1);
        const A = (j * W + i0) * 3, B = (j * W + i1) * 3, C = (j0 * W + i) * 3, D = (j1 * W + i) * 3;
        const ux = SP[B] - SP[A], uy = SP[B + 1] - SP[A + 1], uz = SP[B + 2] - SP[A + 2];
        const vx = SP[D] - SP[C], vy = SP[D + 1] - SP[C + 1], vz = SP[D + 2] - SP[C + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx *= s / l; ny *= s / l; nz *= s / l;
        const o = (j * W + i) * 3;
        shade(nx, ny, nz, SP[o], SP[o + 1], SP[o + 2], i / NU, j / NV);
        b.vertex(SP[o], SP[o + 1], SP[o + 2], nx, ny, nz);
      }
    }
    if (b.nv - base !== W * (NV + 1)) return;
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { const a = base + j * W + i; b.quad(a, a + 1, a + W + 1, a + W); }
  }
}

// Grass tuft: curved, tapering blades from a small dark base. The seed picks the variant:
// blade count, spread (upright / fanned / flopped), height and dry-straw tint.
function tuft(b, x, z, h, sd) {
  const v1 = noise3(sd * 1.37, 2.1, 5.3), v2 = noise3(sd * 0.71, 7.7, 1.9), v3 = noise3(sd * 2.13, 3.3, 8.1);
  const nb = 5 + Math.floor(v1 * 8), spread = 0.25 + 0.65 * v2;
  const tint = v3 < 0.33 ? 0 : v3 < 0.66 ? 1 : 2;
  const cr = tint === 0 ? 0.33 : tint === 1 ? 0.27 : 0.31, cg = tint === 0 ? 0.255 : tint === 1 ? 0.225 : 0.21, cb = tint === 0 ? 0.125 : tint === 1 ? 0.14 : 0.1;
  b.push(); b.translate(x, 0.012, z); b.rotateY(sd * 2.7);
  b.color(0.1, 0.08, 0.05).surface(SURF.THATCH).ao(0.7);
  b.rock(0.05 * h + 0.03, 0.025, 0.05 * h + 0.03, 1, 0.3, sd | 0, 0, 0.8);
  b.ao(0.85);
  for (let i = 0; i < nb; i++) {
    const a = i * 2.39996 + sd, l = h * (0.55 + 0.6 * noise3(sd, i * 1.3, 3)), sp = spread * (0.6 + 0.8 * noise3(sd, i * 1.7, 7));
    const g = 0.8 + 0.35 * noise3(sd, i * 2.1, 11);
    b.color(cr * g, cg * g, cb * g);
    const ca = Math.cos(a), sa = Math.sin(a);
    const mx = ca * l * sp * 0.3, my = l * (0.6 - 0.12 * sp), mz = sa * l * sp * 0.3;
    const tx = ca * l * sp, ty = l * (0.95 - 0.55 * sp * sp), tz = sa * l * sp;
    b.beam(ca * 0.02, 0, sa * 0.02, mx, my, mz, 0.011, 0.007, 3, false);
    b.beam(mx, my, mz, tx, ty, tz, 0.007, 0.0012, 3, false);
  }
  b.pop();
}

// Knapped stone flake or point: a thin faceted plate (flat facets, sharp edges) on the ground.
const FL = new Float64Array(14);
function flake(b, len, wid, th, sd, point) {
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3 * (noise3(sd, i, 1) - 0.5);
    let rx = Math.cos(a) * wid * (0.75 + 0.5 * noise3(sd, i, 2)), rz = Math.sin(a) * len * (0.7 + 0.4 * noise3(sd, i, 3));
    if (point && Math.sin(a) > 0.6) rz *= 1.7; // drawn-out tip
    FL[i * 2] = rx; FL[i * 2 + 1] = rz;
  }
  const rx = (noise3(sd, 9, 9) - 0.5) * wid * 0.5, rz = (noise3(sd, 8, 8) - 0.5) * len * 0.4;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = FL[i * 2], az = FL[i * 2 + 1], bx = FL[j * 2], bz = FL[j * 2 + 1];
    // face normal of (ridge, a, b)
    const ux = ax - rx, uy = -th, uz = az - rz, vx = bx - rx, vy = -th, vz = bz - rz;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const r = b.vertex(rx, th, rz, nx, ny, nz), p = b.vertex(ax, 0.002, az, nx, ny, nz), q = b.vertex(bx, 0.002, bz, nx, ny, nz);
    b.tri(r, p, q);
  }
}

// ---------------------------------------------------------------------------------
// Fire and smoke

// Flame tongue: a thin, leaning, pointed spindle, graded from a yellow-white base (e ~0.95)
// through orange to deep red tips (e 0.6). All e >= 0.5: no shadow, sways in the shader.
function tongue(b, x, y, z, r, h, lx, lz, sd) {
  const RINGS = 7, SEGS = 6, W = SEGS + 1, base = b.nv;
  for (let k = 0; k <= RINGS; k++) {
    const t = k / RINGS;
    const rr = r * Math.pow(1 - t, 0.85) * (0.7 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 2.2)));
    const cx = x + lx * t * t * h + 0.07 * h * Math.sin(sd + t * 6) * t, cz = z + lz * t * t * h + 0.07 * h * Math.cos(sd * 1.3 + t * 6) * t;
    let cr, cg, cb;
    if (t < 0.4) { const s = t / 0.4; cr = mix(0.5, 0.44, s); cg = mix(0.39, 0.17, s); cb = mix(0.17, 0.035, s); }
    else { const s = (t - 0.4) / 0.6; cr = mix(0.44, 0.2, s); cg = mix(0.17, 0.03, s); cb = mix(0.035, 0.006, s); }
    b.color(cr, cg, cb).emissive(mix(0.95, 0.6, t), FLICKER.LIGHT0);
    for (let i = 0; i <= SEGS; i++) {
      const a = (i % SEGS) / SEGS * Math.PI * 2 + t * 1.1 + sd, ca = Math.cos(a), sa = Math.sin(a);
      const w = rr * (1 + 0.35 * (noise3(ca * 1.5 + sd, t * 3, sa * 1.5) - 0.5));
      b.vertex(cx + ca * w, y + t * h, cz + sa * w, ca, 0.3, sa);
    }
  }
  if (b.nv - base !== (RINGS + 1) * W) return;
  for (let k = 0; k < RINGS; k++) for (let i = 0; i < SEGS; i++) { const a = base + k * W + i; b.quad(a, a + 1, a + W + 1, a + W); }
}

function hearth(b, lit, decay, seed) {
  b.push(); b.translate(HX, 0, HZ);
  // Ash patch: an irregular soft-edged blackened area: charcoal in the middle, grey-black ash,
  // a reddish fire-hardened rim, then the floor colour; its edge dips under the floor along
  // a noisy front. Glowing coals in the middle while lit.
  const R = 1.35;
  b.surface(SURF.EARTH).ao(0.9);
  b.disc(R, 30, 8, (px, pz) => {
    const n1 = noise3(px * 1.5 + seed, 0.3, pz * 1.5), n2 = noise3(px * 5 + seed, 1.7, pz * 5);
    const rr = (Math.hypot(px, pz) / R) * (0.78 + 0.45 * n1) + 0.14 * (n2 - 0.5);
    const m = 1 - smooth(0.5, 0.92, rr);
    const fc = floorCol(HX + px, HZ + pz, decay, seed);
    // core -> ash -> reddish rim
    const core = 1 - smooth(0.05, 0.38, rr), rim = smooth(0.25, 0.45, rr) * (1 - smooth(0.5, 0.7, rr));
    const speck = smooth(0.62, 0.75, n2) * decay;
    let cr = mix(0.075, 0.026, core), cg = mix(0.067, 0.023, core), cbb = mix(0.058, 0.021, core);
    cr = mix(cr, 0.13, rim * 0.6); cg = mix(cg, 0.08, rim * 0.6); cbb = mix(cbb, 0.052, rim * 0.6);
    cr = mix(cr, 0.14, speck * 0.6); cg = mix(cg, 0.132, speck * 0.6); cbb = mix(cbb, 0.12, speck * 0.6);
    // soot fades into the floor well inside the dip line, along a blotchy front
    const k = 1 - smooth(0.3, 0.82, rr + 0.25 * (noise3(px * 3.3 - seed, 5.5, pz * 3.3) - 0.5));
    cr = mix(fc[0], cr, k); cg = mix(fc[1], cg, k); cbb = mix(fc[2], cbb, k);
    const glow = Math.max(0, 1 - rr * 2.3) * lit * (0.55 + 0.7 * n2);
    b.color(mix(cr, 0.34, glow), mix(cg, 0.06, glow), mix(cbb, 0.012, glow)).emissive(glow * 0.3, FLICKER.LIGHT0).ao(mix(1, 0.85, k));
    const hy = 0.012 + 0.04 * m * (1 - 0.4 * decay) + 0.012 * (n2 - 0.5) * m;
    // live: the fire-reddened hearth cools to grey ash and weathers into the floor (no red
    // left once the fire is long dead)
    const fa = floorCol(HX + px, HZ + pz, 1, seed), ash = 1 - smooth(0.3, 0.85, rr);
    b.timeless().morph(hy, hy, mix(fa[0], 0.085, ash * 0.6), mix(fa[1], 0.08, ash * 0.6), mix(fa[2], 0.072, ash * 0.6))
      .vanish(0.5 + 0.08 * n1, 0.85, MOTION.MORPH, 0, BY.DECAY);
    return hy;
  });
  b.timeless().emissive(0, 0);
  // hearth stones: uneven sizes and spacing; when abandoned, some kicked out, sunk or missing
  b.surface(SURF.STONE);
  const ns = 10, Rs = 0.82;
  for (let i = 0; i < ns; i++) {
    const gap = b.rand(), a = (i / ns) * Math.PI * 2 + (b.rand() - 0.5) * (0.45 + 0.5 * decay);
    let r = Rs + 0.02 + (b.rand() - 0.5) * 0.16;
    const kick = b.rand();
    if (gap < 0.12 + 0.15 * decay) continue;
    if (decay > 0.5 && kick < 0.35) r += 0.3 + 0.6 * b.rand();
    const s = 0.1 + b.rand() * 0.12, g = 0.06 + b.rand() * 0.035;
    b.color(g, g * 0.86, g * 0.7).ao(0.8);
    b.push(); b.translate(Math.cos(a) * r, 0.02 - 0.05 * decay * b.rand(), Math.sin(a) * r); b.rotateY(-a + b.rand() * 2);
    if (decay > 0.5) b.rotateZ((b.rand() - 0.5) * 0.6);
    b.rock(s * (1.1 + b.rand() * 0.4), s * (0.5 + b.rand() * 0.35), s, 3, 0.3, seed * 31 + i, 3, 0.55);
    b.pop();
    b.color(0.03, 0.027, 0.024).ao(0.7); // soot on the face toward the fire
    b.push(); b.translate(Math.cos(a) * (r - s * 0.45), 0.03, Math.sin(a) * (r - s * 0.45)); b.rotateY(-a);
    b.rock(s * 0.75, s * 0.45, s * 0.8, 2, 0.25, seed * 37 + i, 2, 0.6);
    b.pop();
  }
  b.surface(SURF.WOOD);
  if (lit > 0.05) {
    // live: the burning logs and coals settle into the ash once the fire is out
    b.timeless().vanish(0.56, 0.7, MOTION.RISE, 0.32, BY.DECAY);
    // wood: bark on the outer ends, charred toward the middle, glowing tips in the fire
    const nl = 5;
    for (let i = 0; i < nl; i++) {
      const a = (i / nl) * Math.PI * 2 + 0.3 + b.rand() * 0.5, c = Math.cos(a), s = Math.sin(a);
      const rr = 0.045 + b.rand() * 0.03, sd = seed * 3 + i * 7.7, out = 1.0 + b.rand() * 0.35;
      b.color(0.075, 0.055, 0.04).ao(0.9);
      crooked(b, c * out, 0.06, s * out, c * 0.5, 0.12, s * 0.5, rr, rr * 0.9, 0.05, sd, 2);
      b.color(0.022, 0.019, 0.016).ao(0.9);
      b.beam(c * 0.5, 0.12, s * 0.5, c * 0.22, 0.2, s * 0.22, rr * 0.9, rr * 0.75, 5, false);
      b.color(0.36, 0.08, 0.01).emissive(0.55 * lit, FLICKER.LIGHT0);
      b.beam(c * 0.22, 0.2, s * 0.22, c * 0.08, 0.27, s * 0.08, rr * 0.75, rr * 0.4, 5, true);
      b.emissive(0, 0);
    }
    // embers among the coals
    b.surface(SURF.PLAIN);
    for (let i = 0; i < 14; i++) {
      const a = b.rand() * Math.PI * 2, r = 0.08 + Math.sqrt(b.rand()) * 0.5, hot = b.rand();
      b.color(mix(0.3, 0.45, hot), mix(0.06, 0.16, hot), mix(0.01, 0.03, hot)).emissive(0.55 + 0.35 * hot * (1 - r), FLICKER.LIGHT0).ao(1);
      b.push(); b.translate(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      b.rock(0.03 + 0.03 * b.rand(), 0.022, 0.03 + 0.02 * b.rand(), 1, 0.3, seed * 11 + i, 2, 0.5);
      b.pop();
    }
    b.timeless().emissive(0, 0);
    // flames: layered animated cards with a hot core, embers rising (FX layer); they shrink
    // and dim with light 0's live level as the fire dies
    b.flames(0, 0.1, 0, 1.15 * (0.45 + 0.55 * lit), FLICKER.LIGHT0, seed * 3 + 1);
    b.flames(0.18, 0.08, -0.12, 0.6 * (0.45 + 0.55 * lit), FLICKER.LIGHT0, seed * 3 + 2);
  }
  {
    // cold: charred stubs at random angles, partly buried in the ash, and charcoal lumps
    // (live: they surface as the fire dies)
    b.timeless().appear(0.5, 0.66, MOTION.RISE, 0.12, BY.DECAY);
    b.color(0.024, 0.021, 0.019).ao(0.85);
    for (let i = 0; i < 6; i++) {
      const a = b.rand() * Math.PI * 2, r = b.rand() * 0.55, d = b.rand() * Math.PI * 2, l = 0.18 + b.rand() * 0.38;
      const x0 = Math.cos(a) * r, z0 = Math.sin(a) * r, rr = 0.03 + 0.03 * b.rand();
      b.beam(x0, -0.03, z0, x0 + Math.cos(d) * l, 0.035 + 0.05 * b.rand(), z0 + Math.sin(d) * l, rr, rr * 0.55, 5, true);
    }
    b.surface(SURF.STONE);
    for (let i = 0; i < 9; i++) {
      const a = b.rand() * Math.PI * 2, r = b.rand() * 0.7;
      b.push(); b.translate(Math.cos(a) * r, 0.03, Math.sin(a) * r);
      b.rock(0.03 + 0.03 * b.rand(), 0.02, 0.03 + 0.02 * b.rand(), 1, 0.3, seed + i, 3, 0.5);
      b.pop();
    }
  }
  b.timeless();
  b.pop();
  b.light(0, HX, 0.9, HZ, 1.0, 0.46, 0.15, 60 * lit, 20, 0.6);
  b.glow(HX, HZ, 17); // firelight on the savannah round the trampled floor
}

// Smoke: soft translucent puffs (FX layer) rising from the fire, widening and drifting
// downwind (def.wind), lit by the sun and sky, warm at the base; thin and elegant, readable
// as a pale thread from far away. Its density follows the fire (light 0).
function smoke(b) {
  b.smoke(HX, 0.7, HZ, { count: 64, size: 0.3, rise: 17, density: 0.13, color: [0.46, 0.47, 0.5], src: FLICKER.LIGHT0 });
  b.smoke(HX, 1.0, HZ, { count: 20, size: 0.5, rise: 12, density: 0.07, color: [0.5, 0.5, 0.53], src: FLICKER.LIGHT0 });
}

// ---------------------------------------------------------------------------------
// Windbreak: an open crescent of saplings stuck in the ground and bent inward over a
// grass-thatch wall with a ragged, frayed top; a hide thrown over part of it (kinds 0, 1) or
// thorn brush piled on a lower wall (kind 2). The back faces away from (fx, fz). slump > 0.5
// is the collapsed state: flat grey litter, fallen saplings in a tangle, 1-2 leaning stubs.
let WB_T0 = -1; // decay at which this windbreak starts to go (saplings tip over from here)
function windbreak(b, S, fx, fz, slump, sd) {
  const [cx, cz, R, H, span, kind] = S;
  const back = Math.atan2(cz - fz, cx - fx), a0 = back - span / 2, a1 = back + span / 2;
  const lean = 0.3;
  const ht = (u) => H * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, 0.06 + u * 0.88))) * (0.88 + 0.24 * noise3(u * 5 + sd, sd, 0.5));
  const wallTop = (u) => ht(u) * (kind === 2 ? 0.68 : 0.9) + 0.13 * (noise3(u * 40 + sd, 2.2, sd) - 0.5) + 0.07 * (noise3(u * 95, sd, 1) - 0.5);
  const ns = Math.round(span * R / 0.7);
  b.push(); b.translate(cx, 0, cz);

  if (slump < 0.5) {
    // thatch wall, sagging between the saplings, streaky dry grass
    b.surface(SURF.THATCH);
    sheet(b, 44, 4, (u, v, o, k) => {
      const a = mix(a0, a1, u), h = wallTop(u), y = -0.05 + v * (h + 0.05);
      const sag = 0.05 * Math.sin(Math.PI * v) * (0.5 + 0.5 * Math.cos(u * ns * Math.PI * 2));
      const bundles = 0.035 * Math.abs(Math.sin(u * span * R / 0.16 * Math.PI + 2 * noise3(u * 9, sd, 3))) * (0.4 + 0.6 * v);
      const rr = R + 0.03 - lean * y + sag + bundles + 0.05 * (noise3(u * 13 + sd, v * 3, 1) - 0.5);
      o[k] = Math.cos(a) * rr; o[k + 1] = y; o[k + 2] = Math.sin(a) * rr;
    }, (nx, ny, nz, x, y, z, u) => {
      const outward = nx * x + nz * z > 0;
      const n = (0.78 + 0.3 * noise3(u * 70 + sd, y * 1.5, 2) + 0.12 * noise3(u * 9, y * 4 + sd, 5)) * (0.85 + 0.2 * Math.min(1, y / H));
      const m = (outward ? 1 : 0.62) * n;
      b.color(0.3 * m, 0.235 * m, 0.125 * m).ao(outward ? 0.95 : 0.55);
    });
    // frayed top: loose straws sticking up and out of the wall's edge
    const nst = Math.round(span * R / 0.06);
    for (let i = 0; i < nst; i++) {
      const u = b.rand(), a = mix(a0, a1, u), h = wallTop(u), g = 0.8 + 0.4 * b.rand();
      const r0 = R + 0.03 - lean * (h - 0.12), out = (b.rand() - 0.3) * 0.22, l = 0.14 + 0.28 * b.rand(), tw = (b.rand() - 0.5) * 0.08;
      b.color(0.33 * g, 0.26 * g, 0.13 * g).ao(0.9);
      b.beam(Math.cos(a) * r0, h - 0.12, Math.sin(a) * r0, Math.cos(a + tw) * (r0 + out), h - 0.1 + l, Math.sin(a + tw) * (r0 + out), 0.008, 0.0015, 3, false);
    }
    // a few straws laid diagonally on the outside, breaking up the surface
    for (let i = 0; i < Math.round(span * R / 0.35); i++) {
      const u = b.rand(), du = (b.rand() - 0.5) * 0.08, a = mix(a0, a1, u), a2 = mix(a0, a1, Math.min(1, Math.max(0, u + du))), h = wallTop(u) * (0.6 + 0.3 * b.rand());
      const g = 0.75 + 0.4 * b.rand();
      b.color(0.31 * g, 0.245 * g, 0.125 * g).ao(0.95);
      b.beam(Math.cos(a) * (R + 0.1), 0.02, Math.sin(a) * (R + 0.1), Math.cos(a2) * (R + 0.08 - lean * h), h, Math.sin(a2) * (R + 0.08 - lean * h), 0.014, 0.004, 3, false);
    }
    if (kind === 2) {
      // thorn brush heaped against and over the low wall: dark crooked branches with twigs,
      // a few dull brown-olive clumps of dry leaf
      b.surface(SURF.WOOD);
      for (let i = 0; i < Math.round(span * R / 0.35); i++) {
        const u = (i + b.rand()) / Math.round(span * R / 0.35), a = mix(a0, a1, u), h = wallTop(u);
        const rb = R + 0.25 + 0.2 * b.rand(), d = a + Math.PI / 2 + (b.rand() - 0.5) * 1.2, l = 0.7 + 0.6 * b.rand();
        const x0 = Math.cos(a) * rb, z0 = Math.sin(a) * rb, x1 = x0 + Math.cos(d) * l * 0.5, z1 = z0 + Math.sin(d) * l * 0.5, x2 = x0 - Math.cos(d) * l * 0.5, z2 = z0 - Math.sin(d) * l * 0.5;
        const g = 0.8 + 0.4 * b.rand();
        b.color(0.075 * g, 0.058 * g, 0.042 * g).ao(0.85);
        const y1 = h * (0.5 + 0.6 * b.rand()), y2 = 0.05 + h * 0.4 * b.rand();
        crooked(b, x2, y2, z2, x1, y1, z1, 0.03, 0.012, 0.07, sd * 5 + i, 2);
        for (let k = 0; k < 4; k++) {
          const t = 0.2 + 0.7 * b.rand(), px = mix(x2, x1, t), py = mix(y2, y1, t), pz = mix(z2, z1, t);
          const ta = b.rand() * Math.PI * 2, tl = 0.15 + 0.25 * b.rand();
          b.beam(px, py, pz, px + Math.cos(ta) * tl, py + (b.rand() - 0.2) * tl, pz + Math.sin(ta) * tl, 0.01, 0.002, 3, false);
        }
        if (b.rand() < 0.45) {
          const gg = 0.8 + 0.4 * b.rand();
          b.color(0.11 * gg, 0.095 * gg, 0.055 * gg).surface(SURF.THATCH).ao(0.8);
          b.push(); b.translate(mix(x2, x1, 0.7), mix(y2, y1, 0.7), mix(z2, z1, 0.7)); b.rotateY(b.rand() * 6);
          b.rock(0.13 + 0.07 * b.rand(), 0.06, 0.1 + 0.05 * b.rand(), 2, 0.5, sd * 17 + i, 0, 0.3);
          b.pop();
          b.surface(SURF.WOOD);
        }
      }
    }
  } else {
    // collapsed: the rotted thatch slumped into flat, grey, weathered litter along the old
    // arc; patches dip under the ground at their noisy edges
    b.surface(SURF.THATCH);
    const np = 3;
    for (let i = 0; i < np; i++) {
      const u = (i + 0.25 + 0.5 * b.rand()) / np, a = mix(a0, a1, u), rr = R + 0.15 + 0.25 * b.rand();
      const ps = sd * 3 + i * 7;
      b.push(); b.translate(Math.cos(a) * rr, 0, Math.sin(a) * rr); b.rotateY(-a + (b.rand() - 0.5) * 0.4); b.scale(0.55 + 0.25 * b.rand(), 1, 0.9 + 0.4 * b.rand());
      b.disc(1, 20, 5, (px, pz) => {
        const q = px * px + pz * pz, n = noise3(px * 2.2 + ps, 0.7, pz * 2.2), n2 = noise3(px * 7 + ps, 2.9, pz * 7);
        const m = (1 - q) * (0.45 + 1.0 * n) + 0.3 * (n2 - 0.5);
        const g = 0.75 + 0.45 * n2, w = smooth(0.1, 0.6, m); // weathered grey in the middle, straw-brown at the edges
        b.color(mix(0.26, 0.165, w) * g, mix(0.205, 0.145, w) * g, mix(0.115, 0.11, w) * g).ao(mix(1, 0.8, w));
        return Math.max(-0.03, 0.13 * m * (0.7 + 0.6 * n2) - 0.03);
      });
      b.pop();
    }
    // loose grey straws lying in the litter
    for (let i = 0; i < Math.round(span * R * 6); i++) {
      const u = b.rand(), a = mix(a0, a1, u), rr = R + (b.rand() - 0.3) * 0.9, d = b.rand() * Math.PI * 2, l = 0.2 + 0.3 * b.rand();
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr, g = 0.75 + 0.4 * b.rand();
      b.color(0.22 * g, 0.2 * g, 0.165 * g).ao(0.9);
      b.beam(x, 0.035, z, x + Math.cos(d) * l, 0.035 + 0.04 * b.rand(), z + Math.sin(d) * l, 0.008, 0.003, 3, false);
    }
  }

  // saplings
  b.surface(SURF.WOOD);
  const nStubs = 1 + (b.rand() < 0.5 ? 1 : 0);
  let stubs = 0;
  for (let i = 0; i < ns; i++) {
    const u = (i + 0.3 + 0.4 * b.rand()) / ns, a = mix(a0, a1, u), ca = Math.cos(a), sa = Math.sin(a);
    const h = H * (1.05 + 0.3 * b.rand()), reach = R * (0.45 + 0.25 * b.rand()), r0 = 0.032 + 0.012 * b.rand();
    if (slump >= 0.5) {
      const g = 0.95 + 0.3 * b.rand();
      b.color(0.1 * g, 0.088 * g, 0.072 * g).ao(0.9); // weathered grey wood
      const pick = b.rand();
      if (stubs < nStubs && pick < 0.35 + 0.3 * (i === ns - 1 ? 1 : 0)) {
        // a broken stub still in the ground, leaning at an irregular angle
        stubs++;
        const d = b.rand() * Math.PI * 2, tilt = 0.45 + 0.5 * b.rand(), l = 0.55 + 0.6 * b.rand();
        const x0 = ca * R, z0 = sa * R, x1 = x0 + Math.cos(d) * Math.sin(tilt) * l, y1 = Math.cos(tilt) * l, z1 = z0 + Math.sin(d) * Math.sin(tilt) * l;
        crooked(b, x0, -0.1, z0, x1, y1, z1, r0, r0 * 0.6, 0.05, sd * 7 + i, 2);
      } else {
        // fallen: lying across the litter in a random direction, sometimes broken in two
        const d = b.rand() * Math.PI * 2, l = h * (0.7 + 0.5 * b.rand());
        const x0 = ca * (R + (b.rand() - 0.5) * 0.8), z0 = sa * (R + (b.rand() - 0.5) * 0.8);
        const xm = x0 + Math.cos(d) * l * 0.55, zm = z0 + Math.sin(d) * l * 0.55, ym = 0.05 + 0.18 * b.rand();
        b.beam(x0, 0.04, z0, xm, ym, zm, r0, r0 * 0.75, 5, true);
        const d2 = d + (b.rand() - 0.5) * 1.4;
        b.beam(xm, ym, zm, xm + Math.cos(d2) * l * 0.45, 0.04 + 0.06 * b.rand(), zm + Math.sin(d2) * l * 0.45, r0 * 0.7, r0 * 0.4, 5, true);
      }
      continue;
    }
    b.color(0.07, 0.052, 0.036).ao(0.9);
    if (WB_T0 >= 0) { // the rib loosens and falls outward or sideways, one after another
      const tf = WB_T0 + 0.05 + 0.22 * ((i * 0.618 + sd * 0.37) % 1), da = a + (b.rand() - 0.5) * 1.6;
      b.timeless().pivot(ca * R, 0, sa * R).tiltDir(Math.cos(da), Math.sin(da)).vanish(tf, tf + 0.14, MOTION.TILT, 0, BY.DECAY);
    }
    const sw = (b.rand() - 0.5) * 0.35;
    let qx = ca * (R + 0.02), qy = -0.1, qz = sa * (R + 0.02);
    const N = 5;
    for (let s = 1; s <= N; s++) {
      const t = s / N, bend = Math.pow(t, 1.6);
      const rr = R - reach * bend - 0.05, aa = a + sw * bend;
      const nx = Math.cos(aa) * rr, ny = -0.1 + (h + 0.1) * Math.sin(Math.PI / 2 * Math.min(1, t * 1.15)) + (s === N ? 0.12 * b.rand() : 0), nz = Math.sin(aa) * rr;
      b.beam(qx, qy, qz, nx, ny, nz, mix(r0, r0 * 0.3, (s - 1) / N), mix(r0, r0 * 0.3, t), 5, false);
      qx = nx; qy = ny; qz = nz;
    }
  }

  // hide thrown over part of the back (big on kind 1, small on kind 0), hanging ragged; it
  // slides off as the ribs go
  if (WB_T0 >= 0 && slump < 0.5) b.timeless().pivot(0, 0, 0).vanish(WB_T0 + 0.08, WB_T0 + 0.2, MOTION.GROW, 0, BY.DECAY);
  if (kind !== 2 && slump < 0.5) {
    const ua = kind === 1 ? 0.33 : 0.52, ub = kind === 1 ? 0.72 : 0.8;
    b.surface(SURF.HIDE);
    sheet(b, 8, 5, (u, v, o, k) => {
      const uu = mix(ua, ub, u), a = mix(a0, a1, uu), h = wallTop(uu);
      const yTop = h + 0.05, rTop = R - lean * h + 0.08;
      const rag = 0.14 * (noise3(u * 7 + sd, 3, 1) - 0.5);
      const y = mix(yTop, 0.22 + rag + 0.1 * Math.sin(Math.PI * u), v);
      const rr = mix(rTop, R + 0.14, v) + 0.06 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v) + 0.03 * Math.sin(u * 13 + sd) * v;
      o[k] = Math.cos(a) * rr; o[k + 1] = y; o[k + 2] = Math.sin(a) * rr;
    }, (nx, ny, nz, x, y, z, u, v) => {
      const outward = nx * x + nz * z > 0;
      const n = 0.6 + 0.55 * noise3(x * 4 + sd, y * 4, z * 4) + 0.25 * noise3(x * 13, y * 13 + sd, z * 13);
      const edge = 1 - 0.35 * (1 - smooth(0, 0.12, Math.min(u, 1 - u, v, 1 - v)));
      if (outward) b.color(0.14 * n * edge, 0.085 * n * edge, 0.048 * n * edge).ao(0.95); else b.color(0.19, 0.13, 0.08).ao(0.5);
    });
  } else if (kind === 1) {
    // fallen hide, shrivelled dark on the litter
    b.surface(SURF.HIDE);
    b.push(); b.translate(Math.cos(back) * (R + 0.2), 0.04, Math.sin(back) * (R + 0.2)); b.rotateY(-back);
    b.rotateX(-Math.PI / 2);
    skin(b, 0.95, 0.7, sd + 4, [0.07, 0.05, 0.035], [0.1, 0.075, 0.05], 1);
    b.pop();
  }

  // grass bedding inside, open to the fire
  if (slump < 0.5) {
    b.color(0.24, 0.18, 0.095).surface(SURF.THATCH).ao(0.6);
    b.push(); b.translate(-Math.cos(back) * 0.1, 0, -Math.sin(back) * 0.1);
    b.disc(R * 0.72, 12, 2, (x, z) => 0.05 + 0.04 * noise3(x * 3 + sd, 0, z * 3) - 0.03 * (x * x + z * z) / (R * R * 0.5));
    b.pop();
  }
  b.pop();
}

// ---------------------------------------------------------------------------------
// People: very dark brown, lean, smooth low-detail bodies (form reads by rim light).
// Joints (facing +z, 1.7 m): pelvis, chest, head, lShoulder, lElbow, lHand, rShoulder,
// rElbow, rHand, lHip, lKnee, lFoot, rHip, rKnee, rFoot.
const SIT_CROSS = [0, 0.14, 0, 0, 0.6, 0.05, 0, 0.83, 0.1, 0.17, 0.61, 0.05, 0.25, 0.39, 0.16, 0.12, 0.27, 0.33, -0.17, 0.61, 0.05, -0.25, 0.39, 0.16, -0.12, 0.27, 0.33,
  0.1, 0.12, 0.02, 0.36, 0.11, 0.3, -0.06, 0.06, 0.42, -0.1, 0.12, 0.02, -0.36, 0.11, 0.3, 0.06, 0.06, 0.46];
const SIT_LOG = [0, 0.42, 0, 0, 0.86, 0.1, 0, 1.07, 0.18, 0.17, 0.87, 0.1, 0.22, 0.62, 0.3, 0.1, 0.56, 0.45, -0.17, 0.87, 0.1, -0.22, 0.62, 0.3, -0.1, 0.58, 0.45,
  0.1, 0.4, 0.03, 0.14, 0.52, 0.42, 0.16, 0.05, 0.5, -0.1, 0.4, 0.03, -0.14, 0.52, 0.42, -0.16, 0.05, 0.48];
const STAND_SPEAR = [0, 0.95, 0, 0.02, 1.38, 0.01, 0.04, 1.6, 0.03, 0.19, 1.41, 0, 0.23, 1.13, -0.02, 0.22, 0.88, 0.04, -0.17, 1.37, 0.01, -0.31, 1.08, -0.02, -0.33, 1.26, 0.15,
  0.1, 0.93, 0, 0.15, 0.52, 0.08, 0.2, 0.07, 0.06, -0.1, 0.97, 0, -0.1, 0.53, 0.02, -0.1, 0.07, -0.01];
const WALK_CARRY = [0, 0.93, 0, 0, 1.36, 0.05, 0, 1.58, 0.08, 0.18, 1.38, 0.05, 0.21, 1.12, -0.06, 0.21, 0.88, -0.1, -0.18, 1.38, 0.05, -0.32, 1.5, 0.12, -0.22, 1.62, 0.1,
  0.1, 0.91, 0, 0.1, 0.52, 0.2, 0.1, 0.08, 0.3, -0.1, 0.91, 0, -0.1, 0.48, -0.08, -0.1, 0.14, -0.32];
// kneeling, sitting back on the heels, bent over the stones: one hand steadies the core, the
// other holds the hammerstone
const KNEEL_WORK = [0, 0.38, -0.16, 0, 0.75, 0.06, 0, 0.93, 0.22, 0.16, 0.77, 0.05, 0.2, 0.53, 0.2, 0.09, 0.27, 0.38, -0.16, 0.77, 0.05, -0.22, 0.56, 0.17, -0.13, 0.4, 0.36,
  0.1, 0.38, -0.13, 0.13, 0.07, 0.3, 0.11, 0.05, -0.25, -0.1, 0.38, -0.13, -0.13, 0.07, 0.3, -0.11, 0.05, -0.25];

function figure(b, J, h) {
  b.push(); b.scale(h / 1.7);
  b.color(0.025, 0.018, 0.014).surface(SURF.HIDE).ao(0.85);
  const bm = (i, k, r0, r1, sides = 8) => b.beam(J[i * 3], J[i * 3 + 1], J[i * 3 + 2], J[k * 3], J[k * 3 + 1], J[k * 3 + 2], r0, r1, sides, true);
  const ball = (i, rx, ry, rz, d, ox = 0, oy = 0, oz = 0) => { b.push(); b.translate(J[i * 3] + ox, J[i * 3 + 1] + oy, J[i * 3 + 2] + oz); b.ellipsoid(rx, ry, rz, d); b.pop(); };
  bm(0, 1, 0.105, 0.125, 9);
  ball(0, 0.13, 0.095, 0.1, 3);
  ball(1, 0.145, 0.12, 0.095, 3, 0, -0.04, 0);
  bm(3, 6, 0.052, 0.052, 7);
  b.beam(J[3], J[4], J[5], J[6] * 0.6 + J[3] * 0.4, J[7] - 0.09, J[8] * 0.6 + J[5] * 0.4, 0.045, 0.04, 7, false);
  b.beam(J[18], J[19], J[20], J[6] * 0.6 + J[18] * 0.4, J[7] - 0.09, J[8] * 0.6 + J[20] * 0.4, 0.045, 0.04, 7, false);
  ball(2, 0.085, 0.108, 0.095, 3);
  for (const s of [3, 6]) {
    bm(s, s + 1, 0.048, 0.04, 7); ball(s + 1, 0.04, 0.04, 0.04, 2);
    bm(s + 1, s + 2, 0.038, 0.03, 7); ball(s + 2, 0.034, 0.044, 0.034, 2);
  }
  for (const hp of [9, 12]) {
    bm(hp, hp + 1, 0.072, 0.052, 8); ball(hp + 1, 0.052, 0.052, 0.052, 2);
    bm(hp + 1, hp + 2, 0.049, 0.034, 7);
    ball(hp + 2, 0.04, 0.032, 0.095, 2, 0, -0.01, 0.05);
  }
  b.pop();
}

// ---------------------------------------------------------------------------------
// Acacia (umbrella thorn): crooked dark trunk, splayed limbs, flat broken crown of clumps.
function acacia(b, seed) {
  b.push(); b.translate(TREE_X, 0, TREE_Z);
  b.color(0.065, 0.052, 0.04).surface(SURF.WOOD).ao(0.9);
  crooked(b, 0, -0.2, 0, 0.25, 2.0, 0.15, 0.3, 0.22, 0.12, seed + 0.5, 3, 9);
  const tips = [];
  const nl = 4;
  for (let i = 0; i < nl; i++) {
    const a = (i / nl) * Math.PI * 2 + 0.4 + (b.rand() - 0.5) * 0.6;
    const reach = 1.0 + b.rand() * 0.6;
    const mx = 0.25 + Math.cos(a) * reach, mz = 0.15 + Math.sin(a) * reach, my = 3.6 + b.rand() * 0.5;
    crooked(b, 0.25, 1.9, 0.15, mx, my, mz, 0.2, 0.13, 0.2, seed * 3 + i, 3, 7);
    for (let k = 0; k < 2; k++) {
      const a2 = a + (k ? 0.55 : -0.55) + (b.rand() - 0.5) * 0.3, r2 = 1.2 + 1.0 * b.rand();
      const tx = mx + Math.cos(a2) * r2, tz = mz + Math.sin(a2) * r2, ty = 5.0 + (b.rand() - 0.5) * 0.4;
      crooked(b, mx, my, mz, tx, ty, tz, 0.12, 0.06, 0.18, seed * 5 + i * 2 + k, 3, 6);
      tips.push(tx, ty, tz);
    }
  }
  b.surface(SURF.THATCH);
  for (let i = 0; i < tips.length / 3; i++) {
    const tx = tips[i * 3], ty = tips[i * 3 + 1], tz = tips[i * 3 + 2];
    for (let q = 0; q < 4; q++) {
      const g = 0.8 + 0.35 * b.rand(), up = (q & 1) * 0.22, a = b.rand() * 6.3, o = 0.2 + 0.7 * b.rand();
      b.color(0.06 * g * (1 + up), 0.068 * g * (1 + up), 0.03 * g).ao(0.72 + up);
      b.push(); b.translate(tx + Math.cos(a) * o, ty + 0.35 + up, tz + Math.sin(a) * o); b.rotateY(b.rand() * 3);
      b.rock(0.8 + b.rand() * 0.45, 0.24 + b.rand() * 0.1, 0.65 + b.rand() * 0.35, 4, 0.45, seed * 13 + i * 4 + q, 0, 0.5);
      b.pop();
    }
  }
  // the flat crown in three stacked, offset tiers (dark underside, lighter sunlit top), so
  // the umbrella has depth instead of reading as one slab
  const TIERS = [[0.35, 4.95, 0.2, 2.5, 0.22, 2.3, 0.75, 0.043], [0.0, 5.35, 0.6, 2.0, 0.2, 1.8, 0.85, 0.055], [0.7, 5.7, -0.1, 1.35, 0.17, 1.25, 1.0, 0.068]];
  for (let t = 0; t < 3; t++) {
    const T = TIERS[t];
    b.color(T[7], T[7] * 1.16, T[7] * 0.5).ao(T[6]);
    b.push(); b.translate(T[0], T[1], T[2]); b.rotateY(t * 1.3);
    b.rock(T[3], T[4], T[5], 6, 0.38, seed * 7 + 3 + t, 0, 0.55);
    b.pop();
  }
  b.pop();
}

// ---------------------------------------------------------------------------------
// Hide (two-sided, irregular skin outline with leg flaps, stiff wavy edges, mottled).
// crumple > 0 shrivels it (abandoned).
function skin(b, w, h, sd, hairCol, fleshCol, crumple = 0) {
  sheet(b, 9, 9, (u, v, o, k) => {
    const x0 = u * 2 - 1;
    const l1 = (v - 0.15) / 0.09, l2 = (v - 0.82) / 0.09;
    const leg = 0.55 * (Math.exp(-l1 * l1) + Math.exp(-l2 * l2)) * Math.pow(Math.abs(x0), 4) * (1 - 0.5 * crumple);
    const neck = v > 0.9 ? 1 - (v - 0.9) * 4 : 1;
    const halfW = (w / 2) * (0.56 + 0.26 * Math.sin(Math.PI * v)) * neck * (1 - 0.15 * crumple * noise3(v * 3, sd, 1));
    const rag = (0.07 + 0.08 * crumple) * (noise3(u * 5 + sd, v * 5, sd) - 0.5) * (Math.abs(x0) > 0.7 || v < 0.1 || v > 0.9 ? 1 : 0.2);
    const edge = 1 - smooth(0, 0.18, Math.min(u, 1 - u, v, 1 - v));
    o[k] = x0 * halfW + Math.sign(x0) * leg * w * 0.5 + rag;
    o[k + 1] = v * h + (v < 0.05 ? rag : 0) - 0.06 * Math.sin(Math.PI * u) * (1 - v);
    o[k + 2] = 0.1 * (1 - x0 * x0) * Math.sin(Math.PI * v) + 0.045 * edge * Math.sin(u * 17 + v * 11 + sd)
      + crumple * 0.22 * (noise3(u * 3.5 + sd, v * 3.5, 2) - 0.35);
  }, (nx, ny, nz, x, y, z, u, v) => {
    const n = 0.6 + 0.55 * noise3(x * 4 + sd, y * 4, sd) + 0.25 * noise3(x * 12, y * 12 + sd, 3);
    const e = 1 - 0.35 * (1 - smooth(0, 0.1, Math.min(u, 1 - u, v, 1 - v)));
    const c = nz > 0 ? fleshCol : hairCol;
    b.color(c[0] * n * e, c[1] * n * e, c[2] * n * e);
  });
}

function hideFrame(b, decay, seed) {
  b.push(); b.translate(-7.4, 0, -2.6); b.rotateY(-0.9);
  const fall = smooth(0.4, 0.9, decay);
  b.color(0.075, 0.058, 0.042).surface(SURF.WOOD).ao(0.9);
  if (fall < 0.5) {
    crooked(b, -1.1, -0.2, 0.05, -1.0, 2.15, -0.05, 0.055, 0.04, 0.07, seed + 1, 3);
    b.beam(-1.0, 2.0, -0.05, -1.18, 2.35, -0.08, 0.03, 0.02, 5, true); // fork
    crooked(b, 1.05, -0.2, -0.05, 1.12, 2.0, 0.05, 0.055, 0.04, 0.07, seed + 2, 3);
    b.beam(1.1, 1.85, 0.03, 1.3, 2.18, 0.02, 0.03, 0.02, 5, true);
    crooked(b, -1.35, 1.98, 0.06, 1.4, 1.84, 0.06, 0.038, 0.03, 0.06, seed + 3, 3);
    crooked(b, -1.25, 0.35, 0.06, 1.3, 0.24, 0.06, 0.035, 0.03, 0.05, seed + 4, 2);
    b.surface(SURF.HIDE).ao(1);
    b.push(); b.translate(0.02, 0.42, 0.06); b.rotateZ(0.03);
    skin(b, 1.75, 1.32, seed + 2, [0.13, 0.08, 0.045], [0.21, 0.135, 0.075]);
    b.pop();
    // thongs from the stretch points to the poles, knotted at the hide
    b.color(0.045, 0.034, 0.026).surface(SURF.PLAIN).ao(0.9);
    const pts = [[-0.62, 0.62, -1.0, 0.55], [-0.75, 1.25, -1.02, 1.32], [-0.35, 1.72, -0.4, 1.94], [0.62, 0.6, 1.08, 0.5], [0.78, 1.3, 1.1, 1.38], [0.32, 1.72, 0.35, 1.9], [0.0, 0.42, 0.05, 0.29]];
    for (const [hx, hy, px, py] of pts) {
      b.beam(hx, hy, 0.08, px, py, 0.06, 0.022, 0.02, 5, false);
      b.push(); b.translate(hx, hy, 0.08); b.ellipsoid(0.035, 0.035, 0.035, 2); b.pop();
      b.push(); b.translate(px, py, 0.06); b.ellipsoid(0.045, 0.03, 0.045, 2); b.pop();
    }
  } else {
    crooked(b, -1.7, 0.05, 0.2, 0.6, 0.05, 0.7, 0.05, 0.04, 0.06, seed + 1, 3);
    crooked(b, -0.3, 0.05, -0.7, 1.9, 0.06, -0.3, 0.05, 0.04, 0.06, seed + 2, 3);
    b.beam(-0.9, 0.04, 1.1, 1.0, 0.05, 1.3, 0.035, 0.03, 5, true);
    b.surface(SURF.HIDE).ao(0.85);
    b.push(); b.translate(0.2, 0.06, -0.3); b.rotateX(-Math.PI / 2 + 0.06);
    skin(b, 1.2, 0.85, seed + 2, [0.065, 0.047, 0.033], [0.095, 0.07, 0.048], 1);
    b.pop();
  }
  b.pop();
}

// ---------------------------------------------------------------------------------

export default {
  id: '0',
  name: "First humans' camp",
  caption: 'People gather at a fire beside an acacia',
  year: -300000,
  radius: 18,
  pad: 19, // road centre line at x = -26; road edge 22.6 m from the origin
  straddlesRoad: false,
  biome: 'savannah',
  live: true,
  wind: [WIND_X, WIND_Z],
  lights: [
    // the fire dies slowly over decay 0.08-0.62 (flames shrink, smoke thins and shortens,
    // coals go dark with it), outlasting the people
    { pos: [HX, 0.9, HZ], color: [1.0, 0.46, 0.15], intensity: 60, range: 20, flicker: 0.6, vanish: [0.08, 0.62] },
  ],
  detail: { at: [-1.6, 0.6, 0.4], from: [-7.6, 2.5, 5.4] },
  // time-lapse framing (viewer --strip): the whole camp from the roadside, filling the frame
  strip: { at: [0.8, 1.5, -0.8], from: [-14.5, 3.0, 8.0], fov: 0.8 },
  // Event moment (LANDMARKS.md "Witness"): from above the roadside grass, looking down over
  // the hearth and shelters toward the acacia, the other bands' smoke on the horizon.
  witness: { at: [1, -1], dist: 34, height: 7.5, look: 2.4, az: 1.2, fov: 0.62, drift: 0.12 },
  // Other bands out on the savannah: 8-10 fires ahead of the car, three of them small camps
  // 60-150 m from the road (a windbreak and two or three seated figures, like this camp's),
  // the rest scattered to the horizon. sites.js keeps only spots the approach road can see.
  // They go out one after another as the camp decays.
  satellites: {
    count: [8, 10], near: 3, nearR: [75, 175], farR: [300, 1000],
    centre: -1.05, spread: 2.9, minSep: 85, roadClear: 45, visible: 2,
    build(b, k, n, dist) {
      const far = Math.min(1, dist / 1000), t = 0.1 + 0.45 * (k / n);
      b.timeless().pivot(0, 0, 0).vanish(t, t + 0.1, MOTION.GROW, 0, BY.DECAY);
      const size = (1.0 + 1.3 * far) * (0.85 + 0.3 * b.rand());
      b.farFire(size, Math.min(60, 42 + 18 * far), 0.85 + 0.3 * b.rand(), 4 + 2 * far);
      if (dist > 200) return;
      // a small band: a windbreak behind the fire and a few figures round it
      const wa = b.rand() * 6.283, wr = 3.4 + 0.6 * b.rand();
      windbreak(b, [Math.cos(wa) * wr, Math.sin(wa) * wr, 1.6 + 0.3 * b.rand(), 1.0 + 0.2 * b.rand(), 2.8, k % 3], 0, 0, 0, 7.1 + k * 3.3);
      const np = 2 + (b.rand() < 0.5 ? 1 : 0);
      for (let i = 0; i < np; i++) {
        const a = wa + Math.PI + (i - (np - 1) / 2) * 1.1 + (b.rand() - 0.5) * 0.3, r = 1.7 + 0.4 * b.rand();
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        b.push(); b.at(x, 0, z, Math.atan2(-x, -z));
        figure(b, i === np - 1 && b.rand() < 0.4 ? STAND_SPEAR : SIT_CROSS, 1.55 + 0.15 * b.rand());
        b.pop();
      }
    },
  },

  // Live (handle.setState): decay 0 = living camp, 1 = abandoned. People leave one at a time
  // (0.05-0.55), the fire dies (0.08-0.62: flames shrink, smoke thins, coals go dark, charred stubs show),
  // windbreaks slump one by one into grey litter (0.35-0.85), the hide frame topples (0.4-0.75),
  // the woodpile goes, the floor colour morphs back to grass and tussocks push up (0.35-1).
  // built is unused (a camp is not under construction).
  build(b, built, decay, seed) {
    decay = 0;
    const alive = 1, lit = 1;

    // --- trampled floor (receives firelight), frayed into the savannah at its edge
    floor(b, seed, decay);

    // --- grass tufts in clumps around the rim; spreading over the floor once abandoned
    for (let c = 0; c < 15; c++) {
      const a = b.rand() * Math.PI * 2, e = floorEdge(a, seed) * (0.82 + 0.3 * b.rand());
      const cx = -1 + Math.cos(a) * e, cz = 0.5 + Math.sin(a) * e, n = 1 + Math.floor(b.rand() * 4);
      for (let i = 0; i < n; i++) {
        const ox = (b.rand() - 0.5) * 1.1, oz = (b.rand() - 0.5) * 1.1;
        tuft(b, cx + ox, cz + oz, 0.22 + 0.32 * b.rand(), seed * 100 + c * 7 + i);
      }
    }
    {
      const nc = 34;
      for (let c = 0; c < nc; c++) {
        const tg = 0.35 + 0.55 * (c / nc);
        b.timeless().appear(tg, tg + 0.08, MOTION.RISE, 0.5, BY.DECAY);
        const a = b.rand() * Math.PI * 2, e = floorEdge(a, seed) * Math.sqrt(b.rand()) * 0.88;
        const cx = -1 + Math.cos(a) * e, cz = 0.5 + Math.sin(a) * e, n = 1 + Math.floor(b.rand() * 3.5);
        for (let i = 0; i < n; i++) {
          const x = cx + (b.rand() - 0.5) * 0.9, z = cz + (b.rand() - 0.5) * 0.9;
          if (Math.hypot(x - HX, z - HZ) < 1.4) continue;
          tuft(b, x, z, 0.15 + 0.3 * b.rand(), seed * 200 + c * 5 + i);
        }
      }
      b.timeless();
    }

    // --- acacia
    acacia(b, seed);

    // --- windbreaks, open toward the hearth
    // standing: flattened down into the ground (GROW) as they slump; then the collapsed
    // litter surfaces in their place
    for (let i = 0; i < SHELTERS.length; i++) {
      const t0 = 0.35 + 0.12 * i;
      b.timeless().pivot(0, 0, 0).vanish(t0 + 0.05, t0 + 0.3, MOTION.GROW, 0, BY.DECAY);
      const rs = b.rs[0];
      WB_T0 = t0;
      windbreak(b, SHELTERS[i], HX, HZ, 0, 1.3 + i * 3.4 + seed);
      WB_T0 = -1;
      b.rs[0] = rs;
      b.timeless().appear(t0 + 0.12, t0 + 0.25, MOTION.RISE, 0.25, BY.DECAY);
      windbreak(b, SHELTERS[i], HX, HZ, 1, 1.3 + i * 3.4 + seed);
    }
    b.timeless();

    // --- hearth, fire and smoke
    hearth(b, lit, decay, seed);
    smoke(b);

    // --- firewood: an untidy heap of forked branches (scattered and greyed when abandoned)
    {
      const fx = 0.6, fz = -0.9;
      for (let i = 0; i < 11; i++) {
        const tv = 0.3 + 0.03 * i;
        b.timeless().vanish(tv, tv + 0.08, MOTION.RISE, 0.5, BY.DECAY);
        if (decay > 0.5 && i % 2) continue;
        const a = b.rand() * Math.PI * 2 * (decay > 0.5 ? 1 : 0.35) + 0.3, l = 0.9 + b.rand() * 1.0;
        const ox = fx + (b.rand() - 0.5) * 0.7 * (1 + decay * 2), oz = fz + (b.rand() - 0.5) * 0.6 * (1 + decay * 2);
        const y0 = 0.05 + (decay > 0.5 ? 0 : b.rand() * 0.25), y1 = 0.05 + (decay > 0.5 ? 0.02 : b.rand() * 0.3);
        const r0 = 0.03 + b.rand() * 0.045, gr = decay > 0.5 ? 0.1 : 0.075;
        b.color(gr, gr * (decay > 0.5 ? 0.9 : 0.8), gr * (decay > 0.5 ? 0.78 : 0.6)).surface(SURF.WOOD).ao(0.85);
        const ax = ox - Math.cos(a) * l / 2, az = oz - Math.sin(a) * l / 2, bx = ox + Math.cos(a) * l / 2, bz = oz + Math.sin(a) * l / 2;
        crooked(b, ax, y0, az, bx, y1, bz, r0, r0 * 0.55, 0.06, seed * 9 + i, 2);
        if (b.rand() < 0.6) { // fork
          const fa = a + (b.rand() < 0.5 ? 0.6 : -0.6), fl = l * (0.25 + 0.2 * b.rand());
          const mx = mix(ax, bx, 0.6), my = mix(y0, y1, 0.6), mz = mix(az, bz, 0.6);
          b.beam(mx, my, mz, mx + Math.cos(fa) * fl, my + 0.04, mz + Math.sin(fa) * fl, r0 * 0.6, r0 * 0.3, 5, true);
        }
      }
    }

    b.timeless();
    // --- hide drying frame: topples, then lies flat
    b.push(); b.translate(-7.4, 0, -2.6); b.rotateY(-0.9);
    b.timeless().pivot(0, 0, 0).tiltDir(0, 1).vanish(0.4, 0.75, MOTION.TILT, 0, BY.DECAY);
    b.pop();
    hideFrame(b, 0, seed);
    b.timeless().appear(0.72, 0.76, MOTION.RISE, 0.15, BY.DECAY);
    hideFrame(b, 1, seed);
    b.timeless();

    // --- knapping spot: cores, dark flakes and points, a hammerstone, a lump of red ochre
    const bury = 0.02 * decay;
    b.surface(SURF.STONE);
    for (let i = 0; i < 3; i++) {
      const a = b.rand() * Math.PI * 2, r = 0.1 + b.rand() * 0.35, g = 0.065 + b.rand() * 0.03;
      b.color(g, g * 0.92, g * 0.82).ao(0.85);
      b.push(); b.translate(KX + Math.cos(a) * r, 0.03 - bury, KZ + Math.sin(a) * r); b.rotateY(b.rand() * 6);
      b.rock(0.085, 0.06, 0.075, 2, 0.12, seed * 3 + i, 6, 0.6);
      b.pop();
    }
    for (let i = 0; i < 26; i++) {
      if (decay > 0.5 && i % 3 === 2) continue;
      const a = b.rand() * Math.PI * 2, r = 0.1 + Math.sqrt(b.rand()) * (i < 18 ? 0.8 : 1.6);
      const ox = i < 18 ? KX : HX, oz = i < 18 ? KZ : HZ; // a few points dropped by the hearth
      const rr = i < 18 ? r : 1.0 + r * 0.6;
      const chert = b.rand() < 0.35, g = 0.045 + b.rand() * 0.03;
      if (chert) b.color(g * 1.7, g * 1.15, g * 0.75); else b.color(g, g * 0.95, g * 0.9);
      b.ao(0.85);
      b.push(); b.translate(ox + Math.cos(a) * rr, 0.02 - bury * 0.5, oz + Math.sin(a) * rr); b.rotateY(b.rand() * 6.3);
      const point = i % 4 === 0 || i >= 18;
      flake(b, point ? 0.05 + 0.03 * b.rand() : 0.03 + 0.025 * b.rand(), 0.025 + 0.015 * b.rand(), 0.008 + 0.006 * b.rand(), seed * 13 + i, point);
      b.pop();
    }
    b.color(0.12, 0.105, 0.085).ao(0.85);
    b.push(); b.translate(KX - 0.25, 0.04 - bury, KZ - 0.3); b.rock(0.075, 0.06, 0.07, 2, 0.08, 91, 0, 0.5); b.pop();
    if (decay < 0.5) {
      b.color(0.22, 0.07, 0.035);
      b.push(); b.translate(KX + 0.4, 0.03, KZ - 0.3); b.rock(0.06, 0.04, 0.05, 2, 0.2, 77, 3, 0.5); b.pop();
    }

    // --- bones by the midden: long bones with knobbed ends, an antelope skull with horn
    // cores, a jaw, ribs. Off-white to ochre, greyer when weathered.
    {
      const BX = 1.4, BZ = 6.6;
      const g = mix(1, 0.85, decay);
      const bc = (k) => b.color(0.26 * g * k, 0.215 * g * k, 0.145 * g * mix(k, 1.15, decay)).surface(SURF.STONE).ao(0.85);
      for (let i = 0; i < 3; i++) {
        bc(0.85 + 0.3 * b.rand());
        const d = 0.4 + i * 1.9 + b.rand() * 0.4, x = BX + (i === 1 ? 0.5 : i === 2 ? -0.9 : -0.3), z = BZ + (i === 1 ? -0.4 : i === 2 ? 0.1 : 0.3), l = 0.36 + 0.1 * i;
        const cx = Math.cos(d) * l / 2, cz = Math.sin(d) * l / 2, y = 0.04 - bury;
        crooked(b, x - cx, y, z - cz, x + cx, y + 0.01, z + cz, 0.03, 0.024, 0.02, seed * 19 + i, 2, 6);
        b.push(); b.translate(x - cx, y + 0.008, z - cz); b.rotateY(-d); b.rock(0.055, 0.045, 0.07, 2, 0.25, seed + 40 + i, 0, 0.4); b.pop();
        b.push(); b.translate(x + cx, y + 0.005, z + cz); b.rotateY(-d); b.rock(0.045, 0.04, 0.055, 2, 0.25, seed + 50 + i, 0, 0.4); b.pop();
      }
      bc(1.05);
      b.push(); b.translate(BX + 0.9, 0.08 - bury * 1.5, BZ + 0.5); b.rotateY(0.8);
      b.rock(0.1, 0.075, 0.16, 3, 0.15, seed + 60, 0, 0.3);
      b.push(); b.translate(0, -0.01, 0.15); b.ellipsoid(0.06, 0.05, 0.1, 2); b.pop();
      b.color(0.15 * g, 0.12 * g, 0.085 * g); // darker horn cores, ridged and curved
      crooked(b, 0.05, 0.05, -0.08, 0.13, 0.27, -0.32, 0.036, 0.008, 0.04, seed + 61, 3, 6);
      crooked(b, -0.05, 0.05, -0.08, -0.13, 0.27, -0.32, 0.036, 0.008, 0.04, seed + 62, 3, 6);
      b.pop();
      bc(0.95);
      b.push(); b.translate(BX - 0.6, 0.035 - bury, BZ - 0.6); b.rotateY(2.2);
      b.beam(0, 0, 0, 0.22, 0, 0.05, 0.03, 0.022, 5, true);
      b.beam(0, 0, 0, -0.02, 0.09, -0.04, 0.032, 0.03, 5, true);
      b.color(0.1, 0.085, 0.06);
      for (let k = 0; k < 4; k++) b.beam(0.05 + k * 0.04, 0.02, 0.012 + k * 0.009, 0.05 + k * 0.04, 0.045, 0.012 + k * 0.009, 0.012, 0.008, 4, true); // teeth
      b.pop();
      bc(1);
      for (let i = 0; i < 3; i++) {
        let px = BX + 0.2 + i * 0.12, pz = BZ + 0.9;
        for (let s = 1; s <= 3; s++) {
          const qx = px + 0.1 * Math.cos(0.4 * s), qz = pz - 0.1 * Math.sin(0.5 * s + 0.2);
          b.beam(px, 0.03 - bury, pz, qx, 0.03 + 0.03 * Math.sin(s) - bury, qz, 0.02, 0.018, 4, s === 3);
          px = qx; pz = qz;
        }
      }
    }

    // --- people: dark silhouettes, only while the camp is alive
    if (alive > 0.5) {
      let who = 0;
      // people leave one at a time across decay 0.05-0.55: each is wholly present until its
      // moment, then gone (never a half-transparent figure)
      const leave = () => { const t = 0.05 + 0.1 * who++; b.timeless().vanish(t, t + 0.004, MOTION.POP, 0, BY.DECAY); };
      const face = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);
      // on a log, on the far side of the fire
      {
        leave();
        const x = -0.6, z = 1.9, yaw = face(x, z, HX, HZ);
        b.push(); b.at(x, 0, z, yaw);
        b.color(0.07, 0.052, 0.038).surface(SURF.WOOD).ao(0.8);
        crooked(b, -0.65, 0.15, -0.05, 0.7, 0.16, 0.05, 0.15, 0.13, 0.04, seed + 41, 2, 7);
        figure(b, SIT_LOG, 1.66);
        b.pop();
      }
      // cross-legged on the ground
      for (const [x, z, h] of [[-1.5, -0.6, 1.6], [-2.6, 2.65, 1.55]]) {
        leave();
        b.push(); b.at(x, 0, z, face(x, z, HX, HZ) + (b.rand() - 0.5) * 0.3); figure(b, SIT_CROSS, h); b.pop();
      }
      // knapper kneeling over the stones
      {
        leave();
        b.push(); b.at(KNAPPER_X, 0, KNAPPER_Z, face(KNAPPER_X, KNAPPER_Z, KX, KZ)); figure(b, KNEEL_WORK, 1.66); b.pop();
      }
      // standing easy with a grounded spear, watching the road
      {
        leave();
        b.push(); b.at(SPEAR_X, 0, SPEAR_Z, -Math.PI / 2 + 0.4);
        figure(b, STAND_SPEAR, 1.74);
        b.scale(1.74 / 1.7);
        b.color(0.08, 0.06, 0.042).surface(SURF.WOOD).ao(0.9);
        b.beam(-0.42, 0, 0.3, -0.26, 2.35, 0.02, 0.022, 0.017, 5, true);
        b.color(0.13, 0.12, 0.11).surface(SURF.STONE);
        b.beam(-0.26, 2.33, 0.02, -0.25, 2.52, -0.005, 0.03, 0.0, 4, false);
        b.pop();
      }
      // walking in with a bundle of branches on the shoulder
      {
        leave();
        const x = -6.4, z = -6.8;
        b.push(); b.at(x, 0, z, face(x, z, HX, HZ));
        figure(b, WALK_CARRY, 1.7);
        b.color(0.08, 0.06, 0.043).surface(SURF.WOOD).ao(0.9);
        for (let k = 0; k < 6; k++) {
          const ox = -0.2 + (b.rand() - 0.5) * 0.12, oy = 1.53 + b.rand() * 0.08;
          crooked(b, ox, oy + 0.1, -0.75 - b.rand() * 0.3, ox + (b.rand() - 0.5) * 0.2, oy - 0.08 + b.rand() * 0.12, 0.55 + b.rand() * 0.35, 0.03, 0.016, 0.05, seed * 7 + k, 2);
        }
        b.pop();
      }
      b.timeless();
    }
    return b.counts();
  },
};

// Pieces reused by the ending's home (landmarks/home.js): the yard is composed on this camp.
export { tuft, HX as CAMP_HX, HZ as CAMP_HZ, TREE_X as CAMP_TREE_X, TREE_Z as CAMP_TREE_Z };
