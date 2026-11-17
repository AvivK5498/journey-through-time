// Megacity at night (2026): a great modern city seen at dusk from the road that passes beside it
// (never through it). A dense skyline of dark glass towers, the tallest ~445 m, stepping down to
// mid-rise blocks toward the road; an elevated railway along the near edge with lit stations and
// a train running on it; tower cranes on the tops still rising; streetlights down every avenue;
// red aviation lights blinking slowly on the tallest tops; a warm glow dome in the haze.
//
// Light is the subject. Windows are cheap: each lit run of windows on one floor of one face is
// a single emissive quad laid 12 cm off the dark glass (no geometry for unlit windows), so the
// faces read as thousands of windows in warm white, scattered cool white office floors and a
// few coloured crowns. Faces turned away from the road (+x) get none.
//
// built (clock 264 -> 286, i.e. ~1936 -> 1991): built 0 is the older city of 4-9 storey stone
// blocks and three stepped stone towers. New blocks replace the old ones plot by plot; each
// tower rises floor by floor (CLIP from its base) with a climbing crane on its top that jumps
// up stage by stage, lights spreading upward behind the rising front; the taller the tower the
// later it starts, the tallest finishing last (~0.93). Two towers stay unfinished with their
// cranes (a city is never done). The viaduct, its stations and the train arrive 0.1-0.32,
// the glow dome grows with the city. No decay.
//
// Layout (local): road centre line at x = -360; the railway viaduct on an arc of radius 300 m
// (60 m from the road at its middle, bending away at both ends); the core (tallest) around
// (90, 0); plots on a 64 m grid with 16 m streets, all inside the flattened pad (352 m). The
// towers on the horizon beyond are satellites, which sites.js keeps clear of the roads.

import { MOTION, BY, FLICKER, SURF, loop } from './kit.js';

const RO = 360, PAD = 352, RAD = 356;
const PITCH = 64, X0 = -236;          // plot grid (centres), streets between plots
const AR = 300, AEND = 60, DY = 15;   // viaduct arc radius, its open half-angle (deg), deck height
const S8 = new Float64Array(48);      // prism corners
const TP = new Float64Array(2);       // animate scratch

// palettes (linear albedo)
const GLASS = [[0.07, 0.09, 0.12], [0.11, 0.095, 0.08], [0.065, 0.1, 0.1], [0.09, 0.095, 0.11], [0.055, 0.065, 0.085]];
const STONE = [[0.3, 0.25, 0.2], [0.25, 0.17, 0.13], [0.33, 0.31, 0.27], [0.21, 0.2, 0.19], [0.28, 0.21, 0.15]];
const WARM = [1.0, 0.72, 0.44], COOL = [0.8, 0.88, 1.0], AMBER = [1.0, 0.56, 0.24];
const TEAL = [0.3, 0.85, 1.0], ROSE = [1.0, 0.42, 0.55], GOLD = [1.0, 0.75, 0.35], WHITE = [0.95, 0.95, 1.0];
const RED = [1.0, 0.1, 0.05];
const EK = 0.3; // window brightness scale

let b = null; // the builder during build()
// window settings for the next winPrism (module scratch, set per building)
const W = { fh: 4, cell: 3.2, p: 0.45, cool: 0.25, acc: 0.02, e: 0.2, base: 0, H: 1, t0: -1, dt: 0, lag: 0.05, tv: 2, ymin: 0, ymax: 1e9, top: 0 };

function clamp(x, a, c) { return x < a ? a : x > c ? c : x; }
function pick(A) { return A[Math.floor(b.rand() * A.length) % A.length]; }

// tags: appear (built) by a POP at ta, vanish (built) at tv
function tag(ta, tv) {
  b.timeless();
  if (ta > 0) { const t = Math.min(ta, 0.996); b.appear(t, t + 0.004, MOTION.POP, 0, BY.BUILT); }
  if (tv < 1.5) b.vanish(tv, tv + 0.004, MOTION.POP, 0, BY.BUILT);
}

// n-sided prism centred on the local origin, from y0 up h, top scaled by s (taper); corners
// on the polygon circumscribing the ellipse (hx, hz). Flat-shaded sides, optional top cap.
function corners(n, hx, hz, ph) {
  const c = 1 / Math.cos(Math.PI / n);
  for (let k = 0; k < n; k++) { const a = ph + (k + 0.5) * 2 * Math.PI / n; S8[2 * k] = hx * c * Math.cos(a); S8[2 * k + 1] = hz * c * Math.sin(a); }
}
function prism(n, hx, hz, y0, h, s, ph, cap = true) {
  corners(n, hx, hz, ph);
  const y1 = y0 + h;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n, ax = S8[2 * k], az = S8[2 * k + 1], bx = S8[2 * k2], bz = S8[2 * k2 + 1];
    let nx = bz - az, nz = ax - bx; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    const l = Math.hypot(nx, nz); nx /= l; nz /= l;
    const ny = (1 - s) * (nx * mx + nz * mz) / h;
    const i0 = b.vertex(ax, y0, az, nx, ny, nz), i1 = b.vertex(bx, y0, bz, nx, ny, nz);
    const i2 = b.vertex(bx * s, y1, bz * s, nx, ny, nz), i3 = b.vertex(ax * s, y1, az * s, nx, ny, nz);
    b.quad(i0, i1, i2, i3);
  }
  if (cap) {
    const c = b.vertex(0, y1, 0, 0, 1, 0);
    for (let k = 0; k < n; k++) b.vertex(S8[2 * k] * s, y1, S8[2 * k + 1] * s, 0, 1, 0);
    for (let k = 0; k < n; k++) b.tri(c, c + 1 + k, c + 1 + (k + 1) % n);
  }
}

// Lit windows on the faces of the prism above (W holds the settings). Each lit run of cells on
// one floor is one emissive quad; runs follow a sticky chain so offices light in stretches.
function winPrism(n, hx, hz, y0, h, s, ph) {
  corners(n, hx, hz, ph);
  const m = b.m;
  b.surface(SURF.PLAIN).ao(1);
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n, ax = S8[2 * k], az = S8[2 * k + 1], bx = S8[2 * k2], bz = S8[2 * k2 + 1];
    let nx = bz - az, nz = ax - bx; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    const l = Math.hypot(nx, nz); nx /= l; nz /= l;
    if (m[0] * nx + m[6] * nz > 0.55) continue; // turned away from the road
    winFace(ax, az, bx, bz, nx, nz, y0, h, s);
  }
  b.emissive(0, 0);
}
function winFace(ax, az, bx, bz, nx, nz, y0, h, s) {
  const len = Math.hypot(bx - ax, bz - az), fh = W.fh, yTop = Math.min(y0 + h - W.top, W.ymax);
  const ox = nx * 0.12, oz = nz * 0.12;
  for (let f = Math.max(0, Math.ceil((W.ymin - y0) / fh)); y0 + (f + 1) * fh <= yTop + 0.01; f++) {
    const yl = y0 + f * fh + 0.22 * fh, yh = y0 + f * fh + 0.84 * fh;
    const sl = 1 - (1 - s) * (yl - y0) / h, sh = 1 - (1 - s) * (yh - y0) / h;
    const nc = Math.max(1, Math.round(len * sl / W.cell));
    const r = b.rand();
    const p = r < 0.2 ? 0.03 : r < 0.45 ? W.p * 0.4 : r < 0.9 ? W.p * 0.8 : 0.9;
    const q = 0.72, p0 = Math.min(0.95, p * (1 - q) / Math.max(0.05, 1 - p));
    const office = b.rand() < W.cool;
    const g = 0.35 / (len * sl);
    const tf = W.t0 < 0 ? -1 : W.t0 + W.dt * (yl - W.base) / W.H;
    let st = -1, lit = false;
    for (let c = 0; c <= nc; c++) {
      lit = c < nc && b.rand() < (lit ? (p > 0.9 ? 0.97 : q) : (p > 0.9 ? 0.9 : p0));
      if (lit && st < 0) st = c;
      else if (!lit && st >= 0) {
        const u0 = st / nc + g, u1 = c / nc - g;
        st = -1;
        if (u1 <= u0) continue;
        const rr = b.rand();
        const C = rr < W.acc ? (b.rand() < 0.5 ? AMBER : pick(W.accs || ACCS)) : office || rr < 0.1 ? COOL : WARM;
        const e = EK * W.e * (office ? 0.85 : 0.55 + 0.6 * b.rand());
        tag(tf < 0 ? -1 : tf + W.lag * (0.3 + 0.7 * b.rand()), W.tv);
        b.color(C[0], C[1] * (0.95 + 0.1 * b.rand()), C[2]).emissive(e, FLICKER.NONE);
        const xa = ax + (bx - ax) * u0, za = az + (bz - az) * u0, xb = ax + (bx - ax) * u1, zb = az + (bz - az) * u1;
        const i0 = b.vertex(xa * sl + ox, yl, za * sl + oz, nx, 0, nz), i1 = b.vertex(xb * sl + ox, yl, zb * sl + oz, nx, 0, nz);
        const i2 = b.vertex(xb * sh + ox, yh, zb * sh + oz, nx, 0, nz), i3 = b.vertex(xa * sh + ox, yh, za * sh + oz, nx, 0, nz);
        b.quad(i0, i1, i2, i3);
      }
    }
  }
}
const ACCS = [TEAL, ROSE];

// Aviation light: a red lamp and a red glare card on rig 1 or 2 (blinking in animate).
function avLight(x, y, z, k, ta, tv) {
  tag(ta, tv);
  b.rig(k, false);
  b.surface(SURF.PLAIN).color(RED[0], RED[1], RED[2]).emissive(0.7, FLICKER.NONE);
  b.box(x, y, z, 0.7, 0.7, 0.7, false);
  b.emissive(0, 0);
  b.flash(x, y + 0.4, z, 1.6, 4, 0.55, 0.035, 0.02);
  b.rig(0);
}

// A climbing tower crane standing on a tower top at local height y, mast reaching L down.
function crane(y, L, yaw, ta, tv, rk) {
  b.push(); b.rotateY(yaw);
  tag(ta, tv);
  b.surface(SURF.PLAIN).ao(0.9).color(0.3, 0.24, 0.09);
  b.box(0, y - L / 2, 0, 1.15, L / 2, 1.15, false);
  b.box(14, y + 1, 0, 30, 0.85, 0.75, true);
  b.box(-12, y - 0.4, 0, 2.6, 1.5, 1.6, true);
  b.box(2.2, y - 1.6, 0, 1.2, 1.2, 1.2, true);
  b.beam(0, y + 1.8, 0, 0, y + 10, 0, 0.55, 0.3, 4, false);
  b.beam(0, y + 10, 0, 36, y + 1.9, 0, 0.12, 0.12, 3, false);
  b.beam(0, y + 10, 0, -13, y + 1.9, 0, 0.12, 0.12, 3, false);
  b.color(1.0, 0.92, 0.75).emissive(0.25, FLICKER.NONE);
  b.box(8, y - 0.2, 0, 0.7, 0.3, 0.7, true);
  b.emissive(0, 0);
  b.pop();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  avLight(44 * c, y + 2.3, -44 * s, rk, ta, tv); // rotateY: +x turns toward -z
}

// A tower: tiers of glass prisms rising by CLIP from its base, windows, crown, aviation light,
// cranes stage by stage. T: {x, z, yaw, base, H, n, hx, hz, s, ph, tiers, glass, crown, ccol,
// t0, t1, fin (built fraction it stops at), stone, win (window overrides)}.
function tower(T) {
  const H = T.H, base = T.base, fin = T.fin || 1, Hr = (H - base) * fin;
  b.push(); b.translate(T.x, 0, T.z); if (T.yaw) b.rotateY(T.yaw);
  const tiers = T.tiers || [[1, 1, 1]];
  const timed = T.t0 >= 0;
  // body
  const G = T.glass;
  if (T.stone) b.surface(SURF.PLASTER).ao(0.95); else b.surface(SURF.GILT).ao(1);
  b.color(G[0], G[1], G[2]);
  b.timeless();
  if (timed) b.pivot(0, base, 0).appear(T.t0, T.t1, MOTION.CLIP, Hr, BY.BUILT);
  let y = base;
  for (let i = 0; i < tiers.length; i++) {
    const tr = tiers[i], y1 = H * tr[2];
    prism(T.n, T.hx * tr[0], T.hz * tr[1], y, y1 - y, i === tiers.length - 1 ? T.s : 1, T.ph);
    y = y1;
  }
  // a dark podium skirt at the foot (reads as the street wall)
  if (!T.stone && T.podium) {
    b.surface(SURF.PLASTER).color(0.13, 0.12, 0.115);
    prism(4, Math.min(T.hx + 3, 25), Math.min(T.hz + 3, 25), base, (T.podium - base), 1, 0);
  }
  // windows
  W.fh = T.stone ? 3.6 : 4; W.cell = T.cell || 3.2; W.p = T.p || 0.45; W.cool = T.stone ? 0.05 : T.cool ?? 0.3;
  W.acc = T.acc ?? 0.015; W.accs = T.accs || null; W.e = T.e || 0.2; W.base = base; W.H = Hr;
  W.t0 = timed ? T.t0 : -1; W.dt = timed ? T.t1 - T.t0 : 0; W.lag = 0.03; W.tv = 2;
  W.ymin = Math.max(T.ymin || 0, base + (T.podium ? T.podium - base : 0)); W.ymax = base + Hr - 2; W.top = 3;
  y = base;
  for (let i = 0; i < tiers.length; i++) {
    const tr = tiers[i], y1 = H * tr[2];
    winPrism(T.n, T.hx * tr[0], T.hz * tr[1], y, y1 - y, i === tiers.length - 1 ? T.s : 1, T.ph);
    y = y1;
  }
  // crown (only on finished towers)
  const tc = timed ? T.t1 : -1;
  let top = H;
  const last = tiers[tiers.length - 1], thx = T.hx * last[0] * T.s, thz = T.hz * last[1] * T.s;
  if (fin >= 1 && T.crown) top = crown(T, thx, thz, tc);
  if (fin >= 1 && H > 150) avLight(0, top + 0.8, 0, T.av || 1, tc > 0 ? tc + 0.01 : -1, 2);
  // cranes: one copy per stage, standing above the rising front, jumping up stage by stage
  if (timed && H - base > 140 && Math.hypot(T.x, T.z) < 290) {
    const K = Math.max(2, Math.round(Hr / 95)), yaw = b.rand() * 6.28;
    for (let k = 0; k < K; k++) {
      const ta = T.t0 + (T.t1 - T.t0) * k / K, tv = k === K - 1 ? (fin < 1 ? 2 : T.t1 + 0.012) : T.t0 + (T.t1 - T.t0) * (k + 1) / K;
      const yc = base + Hr * (k + 1) / K + 7;
      crane(yc, Hr / K + 16, yaw + k * 0.7, ta, tv, (k & 1) + 1);
    }
  }
  b.pop();
}

// Crowns: lit bands, a lantern, corner fins, a spire, a slanted top. Returns the highest point.
function crown(T, hx, hz, tc) {
  const H = T.H, C = T.ccol || WHITE, n = T.n, ph = T.ph;
  const lit = tc > 0 ? tc + 0.015 : -1;
  if (T.crown === 'ring') {
    tag(lit, 2); b.surface(SURF.PLAIN).color(C[0], C[1], C[2]).emissive(0.16, FLICKER.NONE);
    for (let i = 0; i < 3; i++) prism(n, hx * 1.03, hz * 1.03, H - 5 - i * 9, 1.6, 1, ph, false);
    b.emissive(0, 0);
    return H;
  }
  if (T.crown === 'lantern') {
    tag(tc, 2); b.surface(SURF.GILT).color(T.glass[0], T.glass[1], T.glass[2]);
    prism(n, hx * 0.72, hz * 0.72, H, 26, 0.8, ph);
    tag(lit, 2); b.surface(SURF.PLAIN).color(C[0], C[1], C[2]).emissive(0.055, FLICKER.NONE);
    prism(n, hx * 0.74, hz * 0.74, H + 2, 18, 0.86, ph, false);
    b.emissive(0, 0).surface(SURF.GILT).color(0.2, 0.2, 0.22);
    b.beam(0, H + 26, 0, 0, H + 52, 0, 1.2, 0.15, 5, false);
    return H + 52;
  }
  if (T.crown === 'fins') {
    tag(tc, 2); b.surface(SURF.GILT).color(0.18, 0.17, 0.15);
    corners(n, hx, hz, ph);
    for (let k = 0; k < n; k++) b.box(S8[2 * k] * 0.96, H + 14, S8[2 * k + 1] * 0.96, 1.1, 18, 1.1, false);
    tag(lit, 2); b.surface(SURF.PLAIN).color(C[0], C[1], C[2]).emissive(0.2, FLICKER.NONE);
    for (let k = 0; k < n; k++) b.box(S8[2 * k] * 1.0, H + 14, S8[2 * k + 1] * 1.0, 0.45, 18, 0.45, false);
    prism(n, hx * 1.02, hz * 1.02, H - 2, 1.4, 1, ph, false);
    b.emissive(0, 0);
    return H + 32;
  }
  if (T.crown === 'spire') {
    tag(tc, 2); b.surface(SURF.GILT).color(0.24, 0.24, 0.26);
    prism(n, hx * 0.6, hz * 0.6, H, 14, 0.7, ph);
    b.beam(0, H + 14, 0, 0, H + 14 + T.spire, 0, 1.6, 0.12, 6, false);
    tag(lit, 2); b.surface(SURF.PLAIN).color(C[0], C[1], C[2]).emissive(0.2, FLICKER.NONE);
    prism(n, hx * 0.62, hz * 0.62, H + 9, 1.3, 1, ph, false);
    b.beam(0, H + 14 + T.spire * 0.45, 0, 0, H + 14 + T.spire * 0.5, 0, 0.95, 0.9, 6, false);
    b.emissive(0, 0);
    return H + 14 + T.spire;
  }
  if (T.crown === 'slant') { // a roof sloping up away from the road, its edges lit
    tag(tc, 2); b.surface(SURF.GILT).color(T.glass[0], T.glass[1], T.glass[2]);
    const P = S8, rise = 46;
    for (let i = 0; i < 8; i++) {
      const sx = (i & 3) === 1 || (i & 3) === 2 ? 1 : -1, sz = (i & 3) >= 2 ? 1 : -1, tp = i >= 4;
      P[i * 3] = sx * hx; P[i * 3 + 2] = sz * hz; P[i * 3 + 1] = H - 0.5 + (tp ? 0.5 + rise * (sx > 0 ? 1 : 0.15) : 0);
    }
    b.hexa(P, false);
    tag(lit, 2); b.surface(SURF.PLAIN).color(C[0], C[1], C[2]).emissive(0.2, FLICKER.NONE);
    for (let sz = -1; sz <= 1; sz += 2) b.beam(-hx, H + rise * 0.15 + 0.3, sz * (hz + 0.2), hx, H + rise + 0.3, sz * (hz + 0.2), 0.4, 0.4, 4, false);
    b.emissive(0, 0);
    return H + rise;
  }
  return H;
}

// A mid-rise or old block: a box (optionally with a set-back top) and a rooftop plant room.
function block(x, z, hx, hz, base, H, C, stone, ta, tv, win, cool, t1) {
  b.push(); b.translate(x, 0, z);
  b.timeless();
  if (ta > 0 && t1 > ta) b.pivot(0, base, 0).appear(ta, t1, MOTION.CLIP, H - base, BY.BUILT);
  else if (ta > 0) b.appear(ta, ta + 0.004, MOTION.POP, 0, BY.BUILT);
  if (tv < 1.5) b.vanish(tv, tv + 0.004, MOTION.POP, 0, BY.BUILT);
  b.surface(stone ? SURF.PLASTER : SURF.GILT).ao(0.95).color(C[0], C[1], C[2]);
  prism(4, hx, hz, base, H - base, 1, 0);
  b.surface(SURF.PLASTER).color(C[0] * 0.6, C[1] * 0.6, C[2] * 0.6);
  b.box(hx * 0.3, H + 1.8, -hz * 0.2, hx * 0.35, 1.8, hz * 0.3, false);
  if (win) {
    W.fh = stone ? 3.4 : 3.6; W.cell = stone ? 2.6 : 3.2; W.p = stone ? 0.5 : 0.45; W.cool = cool; W.acc = 0.01; W.accs = null;
    W.e = stone ? 0.16 : 0.18; W.base = base; W.H = H - base; W.t0 = ta > 0 && t1 > ta ? ta : -1; W.dt = t1 - ta;
    W.lag = 0.03; W.tv = tv; W.ymin = Math.max(0, base + 3.4); W.ymax = 1e9; W.top = 1;
    winPrism(4, hx, hz, base, H - base, 1, 0);
  }
  b.pop();
}

// The elevated railway: an arc of radius AR round the origin on the road side (70 m from the
// road at its middle, bending away into the city at both ends, all inside the pad): piers, deck,
// three lit stations, a terminal at each end that the train runs into.
function arcAt(deg) { const t = deg * Math.PI / 180; TP[0] = -AR * Math.cos(t); TP[1] = AR * Math.sin(t); return t; }
function viaduct() {
  b.surface(SURF.PLASTER).ao(0.9);
  for (let d = -AEND; d < AEND - 0.01; d += 6) {
    const k = (d + AEND) / (2 * AEND), t = 0.1 + 0.1 * k;
    // pier at the segment start
    let th = arcAt(d);
    b.color(0.24, 0.23, 0.22);
    b.timeless().pivot(TP[0], -1, TP[1]).appear(t, t + 0.03, MOTION.GROW, 0, BY.BUILT);
    b.push(); b.translate(TP[0], -1, TP[1]); b.rotateY(th); b.block(1.6, 1.4, 1.3, 1.1, DY - 0.6, 0, 0, false); b.box(0, DY - 0.2, 0, 2, 0.6, 3.6, false); b.pop();
    // deck over the segment
    th = arcAt(d + 3);
    b.timeless().appear(t + 0.05, t + 0.054, MOTION.POP, 0, BY.BUILT);
    b.push(); b.translate(TP[0], 0, TP[1]); b.rotateY(th);
    b.color(0.27, 0.26, 0.25); b.box(0, DY + 1, 0, 4.6, 0.9, 16, true);
    b.color(0.2, 0.2, 0.2); b.box(-4.4, DY + 2.4, 0, 0.2, 0.5, 16, false); b.box(4.4, DY + 2.4, 0, 0.2, 0.5, 16, false);
    b.pop();
  }
  // stations: platform canopy with lit glass sides, stair towers down to the ground
  for (let i = -1; i <= 1; i++) {
    const th = arcAt(i * 34), t = 0.26 + 0.02 * (i + 1);
    b.push(); b.translate(TP[0], 0, TP[1]); b.rotateY(th);
    b.timeless().pivot(0, -1, 0).appear(t, t + 0.03, MOTION.GROW, 0, BY.BUILT);
    b.surface(SURF.PLASTER).color(0.12, 0.12, 0.13);
    b.box(0, DY + 7.2, 0, 8, 0.6, 30, true);
    b.color(0.2, 0.2, 0.21);
    b.box(11, DY / 2, 22, 4, DY / 2 + 1, 5, false);
    b.box(11, DY / 2, -22, 4, DY / 2 + 1, 5, false);
    b.box(7, DY + 1.2, 0, 3, 0.4, 26, false);
    tag(t + 0.04, 2);
    b.surface(SURF.PLAIN).color(0.85, 0.92, 1.0).emissive(0.04, FLICKER.NONE);
    b.box(-7.6, DY + 4.8, 0, 0.1, 1.6, 28, false);
    b.box(7.6, DY + 4.8, 0, 0.1, 1.6, 28, false);
    b.color(1.0, 0.8, 0.55).emissive(0.1, FLICKER.NONE);
    b.box(11, DY - 2, 17, 3, 6, 0.1, false);
    b.box(11, DY - 2, -17, 3, 6, 0.1, false);
    b.color(1.0, 0.9, 0.7).emissive(0.045, FLICKER.NONE);
    b.box(0, DY + 6.5, 0, 5, 0.12, 27, false);
    b.emissive(0, 0);
    b.pop();
  }
  // terminals over the last 20 degrees at each end
  for (let sd = -1; sd <= 1; sd += 2) {
    const th = arcAt(sd * (AEND + 10));
    b.push(); b.translate(TP[0], 0, TP[1]); b.rotateY(th);
    b.timeless().pivot(0, -1, 0).appear(0.1, 0.2, MOTION.CLIP, 38, BY.BUILT);
    b.surface(SURF.PLASTER).ao(0.95).color(0.22, 0.2, 0.19);
    b.box(0, 18, 0, 14, 19, 54, false);
    W.fh = 4; W.cell = 3; W.p = 0.55; W.cool = 0.5; W.acc = 0; W.accs = null; W.e = 0.17; W.base = -1; W.H = 38;
    W.t0 = 0.1; W.dt = 0.1; W.lag = 0.03; W.tv = 2; W.ymin = DY + 6; W.ymax = 1e9; W.top = 1;
    winPrism(4, 14, 54, -1, 38, 1, 0);
    b.pop();
  }
}

// The train: three cars on rigs 3-5, each built around its own origin facing +z, lit windows.
function train() {
  for (let c = 0; c < 3; c++) {
    b.rig(3 + c, false);
    b.timeless();
    b.surface(SURF.PLASTER).ao(0.95).color(0.36, 0.38, 0.4);
    b.box(0, 2.1, 0, 1.5, 1.8, 9.8, true);
    b.surface(SURF.PLAIN).color(0.85, 0.92, 1.0).emissive(0.1, FLICKER.NONE);
    b.box(-1.52, 2.6, 0, 0.04, 0.55, 9, false);
    b.box(1.52, 2.6, 0, 0.04, 0.55, 9, false);
    if (c !== 1) {
      const e = c === 0 ? 9.85 : -9.85;
      b.color(1.0, 0.92, 0.75).emissive(0.6, FLICKER.NONE);
      b.box(0, 1.6, e, 1.0, 0.3, 0.06, false);
    }
    b.emissive(0, 0);
    b.rig(0);
  }
}

// Streetlights: down every avenue inside the pad (lines of light running into the city), and
// both sides of the boulevard behind the viaduct.
function lamp(x, z, warm, ta, pole) {
  tag(ta, 2);
  if (pole) { b.surface(SURF.PLAIN).ao(0.9).color(0.12, 0.12, 0.13); b.beam(x, -0.5, z, x, 9, z, 0.13, 0.1, 4, false); }
  const C = warm ? AMBER : COOL;
  b.surface(SURF.PLAIN).color(C[0], C[1] * (warm ? 1.25 : 1), C[2] * (warm ? 1.3 : 1)).emissive(warm ? 0.32 : 0.26, FLICKER.NONE);
  b.box(x, 9.2, z, 0.75, 0.22, 0.75, false);
  b.emissive(0, 0);
}
function streets() {
  // the paved city floor inside the pad (strips, 2 cm up)
  b.timeless().surface(SURF.PLAIN).ao(1).color(0.06, 0.06, 0.065);
  for (let x = -300; x < PAD - 8; x += 12) {
    const xe = Math.min(x + 12, PAD - 8), zr = Math.sqrt(Math.max(0, (PAD - 6) * (PAD - 6) - Math.max(x * x, xe * xe)));
    if (zr < 4) continue;
    const i0 = b.vertex(x, 0.02, -zr, 0, 1, 0), i1 = b.vertex(xe, 0.02, -zr, 0, 1, 0), i2 = b.vertex(xe, 0.02, zr, 0, 1, 0), i3 = b.vertex(x, 0.02, zr, 0, 1, 0);
    b.quad(i0, i1, i2, i3);
  }
  // avenues along x (between plot rows) and the boulevard along z
  for (let iz = -8; iz <= 8; iz++) {
    const z = iz * PITCH;
    for (let x = -262, k = 0; x < PAD; x += 30, k++) {
      for (let sd = -1; sd <= 1; sd += 2) {
        const zz = z + sd * 6.5;
        if (Math.hypot(x, zz) > PAD - 6 || (k + (sd > 0 ? 1 : 0)) & 1) continue;
        lamp(x, zz, ((iz * 7 + k) % 5) < 3, 0.02 + 0.05 * b.rand(), x < -120);
      }
    }
  }
  for (let d = -AEND - 18; d <= AEND + 18; d += 5.5) for (let sd = -1; sd <= 1; sd += 2) {
    const t = d * Math.PI / 180, r = AR - 16 + sd * 5.5;
    lamp(-r * Math.cos(t), r * Math.sin(t), sd < 0, 0.02 + 0.04 * b.rand(), true);
  }
}

// The glow dome: soft warm halo cards in the haze over the city, growing with it.
function glowDome() {
  b.timeless().appear(0.25, 1.0, MOTION.POP, 0, BY.BUILT);
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9, r = i ? 150 : 0;
    b.color(1.0, 0.58, 0.32).alpha(0.01);
    b.halo(90 + Math.cos(a) * r, 230 + 40 * (i & 1), Math.sin(a) * r * 1.6, i ? 420 : 560, 0, (i * 37 % 97) / 97);
  }
  b.timeless();
}

// --- heroes: the signature towers (x, z on the plot grid)
const HEROES = [
  // x, z, H, type, n, hx, hz, s, crown, colour, t0, t1, extra
  { x: 84, z: -32, H: 392, ty: 'taper', n: 4, hx: 25, hz: 25, s: 0.58, crown: 'spire', spire: 54, ccol: WHITE, t0: 0.64, t1: 0.93, g: 0 },
  { x: 148, z: 96, H: 398, ty: 'step', n: 4, hx: 25, hz: 22, s: 1, crown: 'ring', ccol: TEAL, t0: 0.6, t1: 0.89, g: 3 },
  { x: 20, z: 160, H: 318, ty: 'round', n: 16, hx: 21, hz: 21, s: 0.92, crown: 'lantern', ccol: WARM, t0: 0.5, t1: 0.8, g: 1 },
  { x: 212, z: -160, H: 312, ty: 'oct', n: 8, hx: 23, hz: 23, s: 0.82, crown: 'fins', ccol: GOLD, t0: 0.52, t1: 0.8, g: 2 },
  { x: -44, z: -96, H: 268, ty: 'slab', n: 4, hx: 14, hz: 24, s: 1, crown: 'slant', ccol: COOL, t0: 0.42, t1: 0.68, g: 4 },
  { x: 276, z: 32, H: 305, ty: 'step', n: 4, hx: 22, hz: 22, s: 1, crown: 'spire', spire: 40, ccol: ROSE, t0: 0.55, t1: 0.82, g: 0 },
  { x: 148, z: -224, H: 262, ty: 'taper', n: 8, hx: 22, hz: 22, s: 0.7, crown: 'ring', ccol: WARM, t0: 0.46, t1: 0.7, g: 3 },
  { x: 20, z: 288, H: 290, ty: 'slab', n: 4, hx: 20, hz: 20, s: 1, fin: 0.6, t0: 0.66, t1: 0.92, g: 1 },
  { x: 148, z: 224, H: 250, ty: 'oct', n: 8, hx: 20, hz: 20, s: 1, fin: 0.52, t0: 0.7, t1: 0.95, g: 4 },
  { x: -44, z: 96, H: 236, ty: 'slab', n: 4, hx: 22, hz: 13, s: 1, crown: 'ring', ccol: COOL, t0: 0.38, t1: 0.62, g: 2 },
];
// the older stone towers standing at built 0 (stepped, warm windows, a lit lantern)
const OLD = [[-108, -224, 118], [84, 224, 142], [-108, 224, 96], [212, 160, 128]];
const TIERS = {
  slab: [[1, 1, 1]], taper: [[1, 1, 1]], oct: [[1, 1, 1]], round: [[1, 1, 1]],
  step: [[1, 1, 0.52], [0.8, 0.78, 0.8], [0.58, 0.55, 1]],
  step2: [[1, 1, 0.66], [0.72, 0.9, 1]],
  deco: [[1, 1, 0.5], [0.78, 0.78, 0.72], [0.56, 0.56, 0.9], [0.32, 0.32, 1]],
};
const TYPES = ['slab', 'step', 'taper', 'oct', 'round', 'slab', 'step2', 'taper'];
const CROWNS = [null, null, null, 'ring', 'lantern', 'slant', 'fins', null, 'spire'];

export default {
  id: 'megacity',
  name: 'Megacity at night',
  caption: 'More than half of humanity now lives in cities that stay lit all night.',
  year: 2026,
  radius: RAD,
  pad: PAD,
  roadOffset: RO, // road centre line at x = -360; viaduct 70 m from it, first blocks 100 m
  straddlesRoad: false,
  biome: 'savannah',
  live: true,
  lights: [],
  approach: 1400, cone: 0.5,
  witness: { at: [90, 0], look: 170, dist: 1000, height: 80, az: 0.5, fov: 0.62, drift: 0.05, range: 1700 },
  detail: { at: [84, 380, -32], from: [-260, 300, 240] },
  strip: { at: [90, 150, 0], from: [-950, 70, 520], fov: 0.6 },

  // the metropolis goes on: clusters of towers on the horizon behind and beyond the city
  satellites: {
    count: [10, 12], near: 4, nearR: [480, 700], farR: [800, 1800],
    centre: 0, spread: 3.8, minSep: 150, roadClear: 120,
    build(bb, k, n, dist) {
      b = bb;
      b.duskLit();
      const nt = 2 + Math.floor(b.rand() * 3), sc = 1 + dist / 2400;
      for (let i = 0; i < nt; i++) {
        const H = (70 + b.rand() * 170) * sc, hx = (9 + b.rand() * 8) * sc, hz = (9 + b.rand() * 8) * sc;
        const x = (b.rand() - 0.5) * 90, z = (b.rand() - 0.5) * 90, t = 0.15 + 0.6 * b.rand() * (H / 300);
        b.push(); b.translate(x, 0, z);
        b.timeless().pivot(0, -30, 0).appear(t, t + 0.15, MOTION.CLIP, H + 30, BY.BUILT);
        const G = GLASS[(k + i) % GLASS.length];
        b.surface(SURF.GILT).ao(1).color(G[0], G[1], G[2]);
        prism(4, hx, hz, -30, H + 30, 1, 0);
        // coarse lit bands (a few floors each)
        W.fh = 9; W.cell = 7 * sc; W.p = 0.5; W.cool = 0.3; W.acc = 0; W.accs = null; W.e = 0.22; W.base = -30;
        W.H = H + 30; W.t0 = t; W.dt = 0.15; W.lag = 0.04; W.tv = 2; W.ymin = 6; W.ymax = 1e9; W.top = 4;
        winPrism(4, hx, hz, -30, H + 30, 1, 0);
        tag(t + 0.16, 2);
        b.surface(SURF.PLAIN).color(RED[0], RED[1], RED[2]).emissive(0.8, FLICKER.NONE);
        b.box(0, H + 1, 0, 1.2 * sc, 1.2 * sc, 1.2 * sc, false);
        b.emissive(0, 0);
        b.pop();
      }
    },
  },

  animate(a) {
    // aviation lights: slow red pulses, two groups out of phase
    for (let k = 1; k <= 2; k++) {
      const ph = loop(a.t, 2.4, k === 2 ? 1.2 : 0);
      const g = ph < 0.45 ? Math.sin(ph / 0.45 * Math.PI) : 0;
      a.set(k, 0, 0, 0).gain(k, g);
    }
    // the train: out of one terminal, round the viaduct, into the other (cars 4 deg apart)
    const lead = -84 + 172 * loop(a.t, 34), on = a.built > 0.3;
    for (let c = 0; c < 3; c++) {
      const dg = lead - 4 * c, t = dg * 0.017453292519943295;
      a.set(3 + c, -AR * Math.cos(t), DY + 1.9, AR * Math.sin(t), t).show(3 + c, on && dg > -71 && dg < 71);
    }
  },

  *build(bb, built, decay, seed) {
    b = bb;
    b.duskLit(); // every window, sign and light scales with the dusk (kit)
    // plots on the grid: the kind of building on each (heroes first)
    const plots = [];
    for (let ix = 0; ix < 14; ix++) for (let iz = 0; iz < 18; iz++) {
      const x = X0 + ix * PITCH, z = (iz - 8.5) * PITCH;
      const rc = Math.hypot(Math.abs(x) + 24, Math.abs(z) + 24);
      if (rc > PAD - 4 || (x < -60 && rc > AR - 16)) continue;
      plots.push(x, z);
    }
    const used = new Set();
    const key = (x, z) => Math.round(x) * 10000 + Math.round(z);
    for (const h of HEROES) used.add(key(h.x, h.z));
    for (const o of OLD) used.add(key(o[0], o[1]));
    yield;

    // --- the old city (built 0): low stone blocks on every plot, two per plot; replaced plot
    // by plot as the new city rises. Heritage blocks along the front keep their lit windows.
    const repl = new Map(); // plot -> time its old blocks go
    const towers = [];
    for (let i = 0; i < plots.length; i += 2) {
      const x = plots[i], z = plots[i + 1], k = key(x, z);
      const d = Math.hypot((x - 90) * 1.0, z * 0.85);
      let tr = 2;
      if (used.has(k)) {
        const h = HEROES.find((q) => q.x === x && q.z === z);
        tr = h ? h.t0 - 0.02 : 2;
      } else if (x <= -172) {
        tr = b.rand() < 0.45 ? 2 : 0.04 + 0.3 * b.rand(); // front rows: half stay
      } else {
        const pt = clamp(1.12 - d / 440, 0.1, 0.9);
        if (b.rand() < pt) {
          const H = Math.round(80 + 300 * Math.exp(-(d / 300) * (d / 300)) * (0.45 + 0.55 * b.rand()));
          const t0 = clamp(0.05 + 0.48 * Math.pow(H / 400, 1.15) + 0.08 * b.rand(), 0.04, 0.7);
          towers.push({ x, z, H, t0, t1: Math.min(0.9, t0 + 0.1 + 0.16 * H / 400) });
          tr = t0 - 0.02;
        } else if (b.rand() < 0.75) {
          tr = 0.03 + 0.35 * b.rand();
          towers.push({ x, z, H: Math.round(30 + 46 * b.rand()), t0: tr + 0.02, t1: tr + 0.12, mid: true });
        }
      }
      repl.set(k, tr);
      // the old blocks
      const out = false;
      for (let s = -1; s <= 1; s += 2) {
        const H = 11 + b.rand() * (x < -172 ? 16 : 24), C = pick(STONE);
        const keep = tr > 1.5, front = x <= -172 || (keep && H > 22);
        block(x + (b.rand() - 0.5) * 3, z + s * 11.5, 20 + b.rand() * 2, 9.5 + b.rand(), out ? -30 : -1, H, C, true, -1, tr, keep && front, 0.05, 0);
      }
    }
    yield;

    // --- the older stone towers (present at built 0)
    for (let i = 0; i < OLD.length; i++) {
      const o = OLD[i], C = STONE[i % STONE.length];
      tower({ x: o[0], z: o[1], H: o[2], base: -1, n: 4, hx: 19, hz: 19, s: 1, ph: 0, tiers: TIERS.deco, glass: C, stone: true,
        crown: 'lantern', ccol: WARM, t0: -1, t1: -1, e: 0.17, p: 0.55, av: 1 + (i & 1) });
    }
    yield;

    // --- the heroes
    for (let i = 0; i < HEROES.length; i++) {
      const h = HEROES[i];
      tower({ x: h.x, z: h.z, H: h.H, base: -1, n: h.n, hx: h.hx, hz: h.hz, s: h.s, ph: h.n === 4 ? 0 : 0.2, tiers: TIERS[h.ty],
        glass: GLASS[h.g], crown: h.crown, ccol: h.ccol, spire: h.spire, t0: h.t0, t1: h.t1, fin: h.fin, podium: 12,
        cool: 0.4, p: 0.5, e: 0.21, av: 1 + (i & 1), yaw: h.n === 4 ? (b.rand() - 0.5) * 0.12 : 0, ymin: h.x > 0 ? 30 : 0 });
      if (i % 3 === 2) yield;
    }

    // --- the new city: towers and mid-rise blocks on the replaced plots
    for (let i = 0; i < towers.length; i++) {
      const T = towers[i], base = -1;
      const G = pick(GLASS);
      if (T.mid) {
        const hx = 15 + b.rand() * 7, hz = 15 + b.rand() * 7;
        block(T.x, T.z, hx, hz, base, T.H, G, false, T.t0, 2, T.x < -60 || T.H > 50, 0.45, T.t1);
        continue;
      }
      const ty = pick(TYPES), n = ty === 'oct' ? 8 : ty === 'round' ? 12 : 4;
      const sz = Math.min(23, 12 + T.H / 30), asp = 0.75 + 0.5 * b.rand();
      const cr = T.H > 140 ? pick(CROWNS) : null;
      tower({ x: T.x + (b.rand() - 0.5) * 4, z: T.z + (b.rand() - 0.5) * 4, H: T.H, base, n, hx: sz * (n === 4 ? asp : 1), hz: sz * (n === 4 ? 1 / asp : 1),
        s: ty === 'taper' ? 0.62 + 0.2 * b.rand() : 1, ph: n === 4 ? 0 : 0.2, tiers: TIERS[ty], glass: G, crown: cr,
        ccol: b.rand() < 0.2 ? pick(ACCS) : b.rand() < 0.5 ? WARM : WHITE, spire: 20 + T.H * 0.08,
        t0: T.t0, t1: T.t1, podium: T.x < 0 ? 10 : 0, cool: 0.35, p: 0.38 + 0.2 * b.rand(), e: 0.19,
        av: 1 + (i & 1), ymin: T.x > -60 ? clamp((T.x + 60) * 0.1, 0, 36) : 0,
        yaw: n === 4 && b.rand() < 0.3 ? (b.rand() - 0.5) * 0.5 : 0 });
      if (i % 8 === 7) yield;
    }
    yield;

    // --- streets, railway, train, glow
    streets();
    viaduct();
    train();
    glowDome();
    b.timeless().emissive(0, 0).surface(SURF.PLAIN).duskLit(false);
    return b.counts();
  },
};
