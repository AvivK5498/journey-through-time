// Stonehenge, c. 2500 BCE: the sarsen circle with its continuous ring of lintels, the inner
// horseshoe of five trilithons, the bluestone circle and horseshoe, the altar stone, the
// heel stone standing apart on the avenue, the station stones and the low circular bank and
// ditch with its entrance causeway, in a wide chalk-grass clearing. Stylised at 1.25x true
// size so the ring reads from the road at 300 m. Contract: internal_docs/LANDMARKS.md.
//
// Layout: the monument's axis (centre -> entrance -> heel stone; the midsummer sunrise line)
// points toward the road and the approaching car (AXA), so the driver looks into the open
// horseshoe through the entrance on the way in.
//
// Live (def.live): one build holds the whole timeline.
//   built 0..1 (clock 87-95): the bank, ditch and heel stone are already old. Trilithon
//     uprights arrive on sledges over log rollers and are hauled upright one by one with an
//     A-frame and a crew (0.03-0.35), each pair then capped from a timber platform (to 0.39);
//     the sarsen circle goes up from the back round to the entrance (0.2-0.63), two teams
//     drag the last sarsens in on rollers; an earth ramp is thrown up (0.6), the 30 lintels
//     go on one by one from timber cribs (0.66-0.94); bluestones are set (0.6-0.95); the
//     ramp is dug away and a few people gather on the axis at the end.
//   decay 0..0.8 (clock 125-255, reached at the modern era): the people leave, the fresh
//     pale stone weathers one stone at a time to lichened grey, lintels topple, uprights lean,
//     fall (some broken, some carted off) or are cut down to stumps, bluestones go; the bank
//     slumps and the chalk floor grasses over, until it is the familiar ruin: the entrance
//     arc with its lintels still on, three trilithons, the great trilithon down to one stone.

import { SURF, POSE, MOTION, BY, noise3 } from './kit.js';

const { POP, TILT, DROP, CLIP, MORPH } = MOTION;
const TAU = Math.PI * 2, HP = Math.PI / 2;
const AXA = 2.2, AXX = Math.cos(AXA), AXZ = Math.sin(AXA); // axis: centre -> heel stone (local x, z)
const R_S = 19.2, H_S = 5.1, N_S = 30; // sarsen circle: radius of the stone centres, upright height, count
const FOOT = 0.6; // uprights are sunk this deep
const R_BLUE = 14.6, N_BLUE = 40;

// ------------------------------------------------------------------------------- helpers
function hr(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sst = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const wrap = (a) => a - TAU * Math.round(a / TAU);
const bump = (x, c, w) => { const t = (x - c) / w; return t * t >= 1 ? 0 : (1 - t * t) * (1 - t * t); };
// yaw that turns local +z to face outward along angle a (position (cos a, sin a))
const yawOut = (a) => Math.atan2(Math.cos(a), Math.sin(a));

// Stone colour sets (linear): fresh-dressed sarsen, bluestone (dolerite), altar sandstone.
// Sarsen is a weathered mid grey, a touch cool (bluer than it is warm) so the shaded faces fall
// to blue-grey under the sky fill instead of reading as white plaster in the sun.
const CS = [[0.175, 0.172, 0.162], [0.12, 0.128, 0.142], [0.2, 0.2, 0.165]];
const WEATHERED = [0.15, 0.152, 0.145];
const LICHEN = [0.21, 0.22, 0.14];

// Per-vertex stone colour: broad tonal breakup, a soil-stained foot (yb: local ground line,
// -99 = none), sun-bleached top; wear 1 adds lichen blotches and dark rain streaks.
function stoneCol(b, x, y, z, sd, cs, wear, yb) {
  const c = wear > 0 && cs === 0 ? WEATHERED : CS[cs];
  const n1 = noise3(x * 1.1 + sd * 0.37, y * 0.7 + sd * 0.11, z * 1.1);
  const k = 0.8 + 0.3 * n1 + 0.14 * noise3(x * 4.3 + sd, y * 3.1, z * 4.3);
  let r = c[0] * k, g = c[1] * k, bl = c[2] * k;
  if (wear > 0) {
    const l = sst(0.5, 0.64, noise3(x * 1.9 + sd, y * 1.3, z * 1.9 + 3.3)) * (cs === 0 ? 1 : 0.5);
    r = mix(r, LICHEN[0], l); g = mix(g, LICHEN[1], l); bl = mix(bl, LICHEN[2], l);
    const s = 1 - 0.3 * sst(0.56, 0.7, noise3(x * 3.1 + 7, y * 0.3 + sd * 0.2, z * 3.1));
    r *= s; g *= s; bl *= s;
  }
  let ao = 1;
  if (yb > -90) {
    const f = sst(yb + 0.7, yb - 0.1, y);
    r *= 1 - 0.38 * f; g *= 1 - 0.42 * f; bl *= 1 - 0.48 * f;
    ao = 1 - 0.25 * f;
  }
  b.color(r, g, bl).ao(ao);
}

// Slab: a dressed stone with soft rounded edges, local y from y0 to y1 (domed top end, flat
// bottom end), half extents hw (x) by ht (z), tapering by `taper` toward y1. Ring of cp
// points per corner (2 or 3), lev levels (>= 3). The faces are slightly pillowed (normals
// fan across them) so the stone reads round without sun shadows.
const RG = new Int32Array(12 * 8);
function slab(b, hw, ht, y0, y1, sd, cs, wear, taper, cp, lev, yb) {
  const rc = Math.min(hw, ht) * 0.6, n = cp * 4, L = lev;
  b.surface(SURF.STONE).emissive(0, 0);
  for (let k = 0; k < L; k++) {
    const top = k === L - 1;
    const y = top ? y1 : y0 + (y1 - rc * 0.45 - y0) * (k / (L - 2));
    const s = 1 - taper * (y - y0) / (y1 - y0);
    const ins = top ? rc * 0.5 : 0;
    for (let i = 0; i < n; i++) {
      const q = (i / cp) | 0, th = q * HP + ((i % cp) + 0.5) / cp * HP, ca = Math.cos(th), sa = Math.sin(th);
      const cx = (ca > 0 ? 1 : -1) * (hw - rc), cz = (sa > 0 ? 1 : -1) * (ht - rc);
      let px = (cx + (rc - ins) * ca) * s, pz = (cz + (rc - ins) * sa) * s;
      const j = 1 + 0.09 * (noise3(px * 0.8 + sd * 1.7, y * 0.5, pz * 0.8) - 0.5);
      px *= j; pz *= j;
      const ny = top ? 0.9 : taper * 0.3;
      stoneCol(b, px, y, pz, sd, cs, wear, yb);
      RG[k * n + i] = b.vertex(px, y, pz, ca, ny, sa);
    }
  }
  for (let k = 0; k < L - 1; k++) for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    b.quad(RG[k * n + i], RG[k * n + i1], RG[(k + 1) * n + i1], RG[(k + 1) * n + i]);
  }
  stoneCol(b, 0, y1, 0, sd, cs, wear, yb);
  const c1 = b.vertex(0, y1 + rc * 0.12, 0, 0, 1, 0);
  for (let i = 0; i < n; i++) b.tri(c1, RG[(L - 1) * n + i], RG[(L - 1) * n + (i + 1) % n]);
  const c0 = b.vertex(0, y0, 0, 0, -1, 0);
  for (let i = 0; i < n; i++) b.tri(c0, RG[(i + 1) % n], RG[i]);
}
// Horizontal bar (a lintel) along local x, centred, bottom on y = 0: hh half height, ht half
// thickness (z).
function bar(b, len, hh, ht, sd, cs, wear) {
  b.push(); b.translate(-len * 0.5, hh, 0); b.rotateZ(-HP);
  slab(b, hh, ht, 0, len, sd, cs, wear, 0, 3, 3, -99);
  b.pop();
}

function timber(b) { b.color(0.2, 0.14, 0.085).surface(SURF.WOOD).ao(0.95).emissive(0, 0); }
function rope(b) { b.color(0.3, 0.24, 0.15).surface(SURF.PLAIN).ao(1); }
function man(b, x, z, yaw, pose, s) {
  const k = 0.75 + 0.5 * hr(s, 1, 7), t = hr(s, 3, 7);
  b.surface(SURF.HIDE).ao(1).emissive(0, 0);
  if (t < 0.5) b.color(0.12 * k, 0.08 * k, 0.05 * k); else b.color(0.15 * k, 0.12 * k, 0.085 * k);
  b.push(); b.at(x, 0.02, z, yaw); b.human(pose, 1.58 + 0.18 * hr(s, 2, 7), s); b.pop();
}
// Sledge on log rollers along local z from z0 to z1 (runners at x = +-0.55, top at 0.4).
function sledge(b, z0, z1) {
  timber(b);
  for (let z = z0 + 0.4; z < z1; z += 1.7) b.beam(-1.15, 0.13, z, 1.15, 0.13, z, 0.12, 0.12, 6);
  b.beam(-0.55, 0.32, z0, -0.55, 0.32, z1, 0.09, 0.09, 5);
  b.beam(0.55, 0.32, z0, 0.55, 0.32, z1, 0.09, 0.09, 5);
}
// A-frame and hauling crew in an upright's frame (stone lying out along +z, pivot at height
// pv): legs straddle the socket, the rope runs from the stone's head over the apex to the
// crew pulling toward -z (the circle's centre).
function crew(b, h, pv, s, np) {
  timber(b);
  const ay = 0.62 * h, az = -1.0;
  b.beam(-1.8, -0.1, -2.0, 0, ay, az, 0.12, 0.08, 6);
  b.beam(1.8, -0.1, -2.0, 0, ay, az, 0.12, 0.08, 6);
  b.beam(-1.05, ay * 0.42, -1.6, 1.05, ay * 0.42, -1.6, 0.07, 0.07, 5);
  rope(b);
  const L = (h - pv) * 0.75, hy = pv + L * 0.71, hz = L * 0.71;
  b.beam(0, hy, hz, 0, ay, az, 0.04, 0.04, 4, false);
  b.beam(0, ay, az, 0, 1.25, -4.0 - 1.15 * np, 0.04, 0.04, 4, false);
  for (let i = 0; i < np; i++) man(b, (i & 1) ? 0.3 : -0.3, -4.2 - 1.15 * i, Math.PI, POSE.HAUL, s + i);
}
// Timber crib (alternating log courses) from the ground up to y = top, x half width hx.
function crib(b, top, hx, hz) {
  timber(b);
  for (let y = 0.17, l = 0; y < top - 0.1; y += 0.34, l++) {
    if (l & 1) { b.box(-hx + 0.15, y, 0, 0.15, 0.17, hz, false); b.box(hx - 0.15, y, 0, 0.15, 0.17, hz, false); }
    else { b.box(0, y, -hz + 0.15, hx, 0.17, 0.15, false); b.box(0, y, hz - 0.15, hx, 0.17, 0.15, false); }
  }
}

// --------------------------------------------------------------------- one standing stone
// U holds the stone's parameters (module scratch; set by the caller, then upright()):
//   hw, ht, h      half width, half thickness, height above ground
//   sd, cs         shape seed, colour set
//   r0, r1, lead   raised (TILT, out of lying along +z) over built r0..r1, shown lying `lead` early
//   sled, crew     on a sledge over rollers until raised; A-frame crew size (0 = none)
//   w              weathers (fresh copy -> lichened copy) at decay w (>= 1: never)
//   fate, t        0 stands, 1 leans at t, 2 falls at t (fd: +1 out, -1 in; brk: broken;
//                  rm: carted off at rm), 3 cut to a stump from t, 4 taken away at t
const U = { hw: 1, ht: 0.5, h: 4, sd: 1, cs: 0, r0: 0, r1: 0.01, lead: 0, sled: false, crew: 0, w: 2, fate: 0, t: 1, fd: 1, brk: false, rm: 2, lean: 0.1 };
function fateTags(b, o) {
  if (o.fate === 1 || o.fate === 4) b.vanish(o.t - 0.004, o.t, POP, 0, BY.DECAY);
  else if (o.fate === 2) b.tiltDir(0, o.fd).vanish(o.t, o.t + 0.02, TILT, 0, BY.DECAY);
  else if (o.fate === 3) b.reach(o.h + FOOT).vanish(o.t, o.t + (0.8 - o.t) / 0.74, CLIP, 0, BY.DECAY);
}
function upright(b, x, z, yaw) {
  const o = U, pv = o.ht + (o.sled ? 0.4 : 0), wz = o.w < 1, cp = o.cs === 1 ? 2 : 3, lev = o.cs === 1 ? 4 : 6;
  b.push(); b.at(x, 0, z, yaw);
  b.timeless().pivot(0, pv, 0).tiltDir(0, 1).appear(o.r0, o.r1, TILT, 0, BY.BUILT, o.lead);
  if (wz) b.vanish(o.w - 0.004, o.w, POP, 0, BY.DECAY); else fateTags(b, o);
  slab(b, o.hw, o.ht, -FOOT, o.h, o.sd, o.cs, 0, 0.08, cp, lev, 0);
  if (wz) {
    b.timeless().appear(o.w, o.w + 0.004, POP, 0, BY.DECAY).pivot(0, o.ht, 0);
    fateTags(b, o);
    slab(b, o.hw, o.ht, -FOOT, o.h, o.sd, o.cs, 1, 0.08, cp, lev, 0);
  }
  const wr = wz || o.cs === 1 ? 1 : 0;
  if (o.fate === 1) { // leaning
    b.timeless().appear(o.t, o.t + 0.004, POP, 0, BY.DECAY);
    b.push(); b.rotateX(o.lean * o.fd); slab(b, o.hw, o.ht, -FOOT, o.h, o.sd, o.cs, wr, 0.08, cp, lev, 0); b.pop();
  } else if (o.fate === 2) { // lying where it fell, settling into the turf
    b.timeless().appear(o.t + 0.02, o.t + 0.024, POP, 0, BY.DECAY);
    if (o.rm < 1) b.vanish(o.rm, o.rm + 0.004, POP, 0, BY.DECAY);
    const pz = wz ? o.ht : pv;
    b.push(); b.translate(0, pz, 0); b.rotateX(o.fd * HP); b.translate(0, -pz, o.fd * (pz - o.ht + 0.18));
    if (o.brk) {
      const m = o.h * 0.5;
      slab(b, o.hw, o.ht, -FOOT, m, o.sd, o.cs, wr, 0.04, cp, 4, -99);
      b.translate(0, m + 0.3, 0); b.rotateZ(0.16 * o.fd);
      slab(b, o.hw * 0.95, o.ht, 0, o.h - m, o.sd + 5, o.cs, wr, 0.08, cp, 3, -99);
    } else slab(b, o.hw, o.ht, -FOOT, o.h, o.sd, o.cs, wr, 0.08, cp, lev - 1, -99);
    b.pop();
  }
  if (o.sled) { // on its sledge until it starts to rise
    b.timeless().appear(o.r0 - o.lead, o.r0 - o.lead + 0.004, POP, 0, BY.BUILT).vanish(o.r0 + 0.006, o.r0 + 0.01, POP, 0, BY.BUILT);
    sledge(b, -FOOT - pv + 0.4, o.h - pv);
  }
  if (o.crew) {
    b.timeless().appear(o.r0 - 0.02, o.r0 - 0.016, POP, 0, BY.BUILT).vanish(o.r1 + 0.006, o.r1 + 0.01, POP, 0, BY.BUILT);
    crew(b, o.h, pv, o.sd * 13, o.crew);
  }
  b.pop();
}

// ----------------------------------------------------------------------------- lintels
// In the lintel's frame (centre of its span on the ground, local x along it, z outward), the
// lintel sits at height y. Lowered (DROP) from a timber platform over r0..r1 (shown hovering
// on it from r0 - lead); weathers at w; falls (tips off outward fd = 1 / inward -1) at t,
// lying on the ground after (carted off at rm); stays if t >= 1.
const LT = { len: 4, hh: 0.5, ht: 0.6, y: 5, sd: 1, r0: 0, r1: 0.01, lead: 0.04, w: 2, t: 2, fd: 1, rm: 2, crib: 0 };
function lintel(b, x, z, yaw) {
  const o = LT, falls = o.t < 1;
  b.push(); b.at(x, 0, z, yaw);
  b.push(); b.translate(0, o.y, 0);
  b.timeless().appear(o.r0, o.r1, DROP, 0.8, BY.BUILT, o.lead).vanish(o.w - 0.004, o.w, POP, 0, BY.DECAY);
  bar(b, o.len, o.hh, o.ht, o.sd, 0, 0);
  b.timeless().appear(o.w, o.w + 0.004, POP, 0, BY.DECAY);
  if (falls) b.pivot(0, 0, o.fd * o.ht).tiltDir(0, o.fd).vanish(o.t, o.t + 0.012, TILT, 0, BY.DECAY);
  bar(b, o.len, o.hh, o.ht, o.sd, 0, 1);
  b.pop();
  if (falls) {
    b.timeless().appear(o.t + 0.012, o.t + 0.016, POP, 0, BY.DECAY);
    if (o.rm < 1) b.vanish(o.rm, o.rm + 0.004, POP, 0, BY.DECAY);
    b.push(); b.translate((hr(o.sd, 1, 3) - 0.5) * 1.5, -0.25, o.fd * (o.ht + 2.4 + 1.6 * hr(o.sd, 2, 3))); b.rotateY((hr(o.sd, 3, 3) - 0.5) * 0.9);
    bar(b, o.len, o.hh, o.ht, o.sd, 0, 1);
    b.pop();
  }
  if (o.crib) { // the timber platform it is lowered from: raised before, cleared once it is down
    const top = o.y + 0.8;
    b.timeless().pivot(0, 0, 0).reach(top).appear(o.r0 - o.lead - 0.06, o.r0 - o.lead - 0.01, CLIP, 0, BY.BUILT).vanish(o.r0 + 0.006, o.r0 + 0.01, POP, 0, BY.BUILT);
    if (o.crib === 1) crib(b, top, 0.58, 0.62);
    else { // trilithon: two stacks before and behind the pair, decked over their heads
      b.push(); b.translate(0, 0, -o.ht - 0.75); crib(b, top - 0.3, 1.2, 0.6); b.pop();
      b.push(); b.translate(0, 0, o.ht + 0.75); crib(b, top - 0.3, 1.2, 0.6); b.pop();
      for (let i = -3; i <= 3; i++) b.box(i * 0.42, top - 0.15, 0, 0.18, 0.15, o.ht + 1.35, false);
    }
  }
  b.pop();
}

// ------------------------------------------------------------------------------ ground
// Chalk downland turf; the floor inside the circle and the construction ring trampled to
// chalk, the path in along the axis, the bank's crest chalky, the ditch a dark band between
// the bank and its low outer lip. MORPH carries all of it to the decayed state: a slumped
// bank and plain turf.
let BG = null;
const TURF = [0.13, 0.17, 0.058], CHALK = [0.47, 0.45, 0.37], OLD = [0.1, 0.148, 0.05];
function fld(b, x, z) {
  const r = Math.hypot(x, z), th = wrap(Math.atan2(z, x) - AXA);
  const n = noise3(x * 0.08, 1.3, z * 0.08), m = noise3(x * 0.33, 4.1, z * 0.33);
  const gate = sst(0.12, 0.19, Math.abs(th));
  const bank = 0.95 * gate * bump(r, 33.6, 2.1), lip = 0.32 * gate * bump(r, 40.5, 1.2), ditch = gate * bump(r, 37.6, 1.9);
  const y = 0.02 + bank + lip, y1 = 0.02 + bank * 0.5 + lip * 0.45;
  const u = x * AXX + z * AXZ, v = -x * AXZ + z * AXX;
  let c = 0.62 * sst(20.5, 16.5, r) * (0.55 + 0.7 * m) + 0.3 * bump(r, 22, 3.2) * (0.3 + m);
  c += 0.55 * sst(2.6, 1.0, Math.abs(v)) * sst(-2, 2, u) * sst(42, 36, u) * (0.6 + 0.6 * m);
  c += 0.45 * sst(0.45, 0.9, bank) * (0.4 + m);
  c = clamp01(c);
  const k = 0.84 + 0.32 * n, dk = 1 - 0.5 * ditch;
  let cr = mix(TURF[0] * k, CHALK[0], c) * dk, cg = mix(TURF[1] * k, CHALK[1], c) * dk, cb = mix(TURF[2] * k, CHALK[2], c) * dk;
  let dr = OLD[0] * k * (1 - 0.25 * ditch) * (1 + 0.25 * bank), dg = OLD[1] * k * (1 - 0.25 * ditch) * (1 + 0.2 * bank), db = OLD[2] * k * (1 - 0.25 * ditch);
  const e = sst(51, 57.5, r);
  cr = mix(cr, BG[0], e); cg = mix(cg, BG[1], e); cb = mix(cb, BG[2], e);
  dr = mix(dr, BG[0], e); dg = mix(dg, BG[1], e); db = mix(db, BG[2], e);
  b.color(cr, cg, cb).ao(1 - 0.35 * ditch).morph(y, y1, dr, dg, db);
  return y - 0.008 * e;
}
const GI = new Int32Array(200 * 24);
function annulus(b, R, segs) {
  const e = 0.3;
  for (let k = 0; k < R.length; k++) for (let i = 0; i < segs; i++) {
    const a = i / segs * TAU, x = Math.cos(a) * R[k], z = Math.sin(a) * R[k];
    const gx = fld(b, x + e, z) - fld(b, x - e, z), gz = fld(b, x, z + e) - fld(b, x, z - e);
    const y = fld(b, x, z);
    GI[k * segs + i] = b.vertex(x, y, z, -gx / (2 * e), 1, -gz / (2 * e));
  }
  for (let k = 0; k < R.length - 1; k++) for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % segs;
    b.quad(GI[k * segs + i], GI[k * segs + i1], GI[(k + 1) * segs + i1], GI[(k + 1) * segs + i]);
  }
}
const RINGS = [30, 31, 31.9, 32.7, 33.5, 34.3, 35.1, 35.9, 36.7, 37.6, 38.5, 39.4, 40.1, 40.8, 41.6, 43, 46, 50, 54, 58];

// Trilithon layout: angle from the axis, distance from the centre, upright height.
const TRI_A = [Math.PI, 2.2, -2.2, 1.25, -1.25], TRI_R = [9.2, 10.2, 10.2, 11.2, 11.2], TRI_H = [9.0, 8.1, 8.1, 7.4, 7.4];

export default {
  id: 'stonehenge',
  name: 'Stonehenge',
  caption: 'Farmers raise a ring of huge sarsen stones',
  year: -2500,
  radius: 58,
  pad: 60, // road centre line at x = -66, road edge 62.1 m from the origin
  straddlesRoad: false,
  biome: 'forest',
  live: true,
  lights: [],
  viewSunAz: 2.0,
  detail: { at: [0, 3.5, 0], from: [-26, 3.2, 24] },
  strip: { at: [0, 4.5, 0], from: [-46, 12, 40], fov: 0.68 },
  // Event moment: low on the axis outside the entrance, a little to the side of the heel
  // stone, looking in through the entrance gap at the horseshoe (the midsummer sunrise view).
  witness: { at: [0, 0], look: 4.2, dist: 66, height: 11, az: 1.1, fov: 0.58, drift: 0.1 },
  // The builders' camps (Durrington Walls and others) in the woods around: fires with smoke
  // columns over the trees, lit while the work goes on and out early in the decay.
  satellites: {
    count: [4, 6], near: 2, nearR: [150, 280], farR: [380, 1000],
    centre: 0.4, spread: 5.0, minSep: 130, roadClear: 45,
    build(b, k, n, dist) {
      const far = Math.min(1, dist / 1000), t = 0.02 + 0.1 * (k / n);
      b.timeless().pivot(0, 0, 0).appear(0.0, 0.04, MOTION.GROW, 0, BY.BUILT).vanish(t, t + 0.05, MOTION.GROW, 0, BY.DECAY);
      b.farFire((1 + 1.3 * far) * (0.85 + 0.3 * b.rand()), 34 + 24 * far, 0.9 + 0.3 * b.rand());
    },
  },

  *build(b, built, decay, seed) {
    const sd = (seed | 0) * 7 + 11;
    BG = b.bio('ground');

    // --- ground: inner floor and the bank / ditch annulus (one MORPH over the decay)
    b.timeless().surface(SURF.EARTH).emissive(0, 0).vanish(0, 0.8, MORPH, 0, BY.DECAY);
    b.disc(30, 72, 10, (x, z) => fld(b, x, z));
    b.timeless().vanish(0, 0.8, MORPH, 0, BY.DECAY);
    annulus(b, RINGS, 160);
    b.timeless();
    // Aubrey holes: a ring of chalk-filled pits inside the bank, grassing over
    b.surface(SURF.EARTH).ao(1);
    for (let i = 0; i < 56; i++) {
      const a = AXA + (i + 0.5) * TAU / 56;
      if (Math.abs(wrap(a - AXA)) < 0.12) continue;
      const g = 0.4 + 0.08 * hr(i, 1, sd);
      b.timeless().vanish(0.08 + 0.6 * hr(i, 2, sd), 0.09 + 0.6 * hr(i, 2, sd), POP, 0, BY.DECAY);
      b.color(g, g * 0.97, g * 0.82);
      b.push(); b.translate(Math.cos(a) * 30.6, 0.035, Math.sin(a) * 30.6); b.disc(0.55, 8, 1); b.pop();
    }
    // the avenue's two low banks running out along the axis past the heel stone
    b.color(0.15, 0.19, 0.065).surface(SURF.EARTH).ao(1);
    for (let s = -1; s <= 1; s += 2) {
      const ox = -AXZ * 7 * s, oz = AXX * 7 * s;
      b.timeless().pivot(0, 0, 0).reach(0.45).vanish(0.05, 1.0, CLIP, 0, BY.DECAY);
      b.extrude([AXX * 41.5 + ox, 0.01, AXZ * 41.5 + oz, AXX * 55 + ox, 0.01, AXZ * 55 + oz], [1.5, 0, 0.75, 0.26, 0, 0.36, -0.75, 0.26, -1.5, 0], { closed: false });
    }
    b.timeless();
    yield;

    // --- heel stone: an unworked sarsen boulder on the avenue, leaning toward the circle
    b.surface(SURF.STONE).color(0.165, 0.162, 0.15).ao(1);
    b.push(); b.at(AXX * 50 - AXZ * 1.2, 0, AXZ * 50 + AXX * 1.2, yawOut(AXA)); b.rotateX(-0.2); b.translate(0, 2.6, 0);
    b.rock(1.6, 3.4, 1.25, 4, 0.16, sd + 3, 5, 0.25);
    b.pop();
    // altar stone: a long slab of green-grey sandstone lying before the great trilithon
    b.push(); b.at(-AXX * 5.0, 0.0, -AXZ * 5.0, yawOut(AXA)); b.rotateY(0.12);
    bar(b, 6.0, 0.3, 0.62, sd + 7, 2, 0); b.pop();

    // station stones (two survive) and the slaughter stone in the entrance
    const ST = [0.62, -0.62, Math.PI - 0.62, Math.PI + 0.62];
    for (let i = 0; i < 4; i++) {
      const a = AXA + ST[i];
      Object.assign(U, { hw: 0.75, ht: 0.5, h: i & 1 ? 1.4 : 2.7, sd: sd + 40 + i, cs: 0, r0: 0, r1: 0.004, lead: 0, sled: false, crew: 0, w: 0.1 + 0.1 * i, fate: i < 2 ? 0 : 4, t: 0.3 + 0.2 * (i - 2), fd: 1, brk: false, rm: 2 });
      upright(b, Math.cos(a) * 31.2, Math.sin(a) * 31.2, yawOut(a));
    }
    Object.assign(U, { hw: 1.15, ht: 0.48, h: 5.2, sd: sd + 50, cs: 0, r0: 0.9, r1: 0.95, lead: 0.06, sled: true, crew: 2, w: 0.08, fate: 2, t: 0.36, fd: -1, brk: false, rm: 2 });
    upright(b, AXX * 34.5 + AXZ * 1.6, AXZ * 34.5 - AXX * 1.6, yawOut(AXA));
    yield;

    // --- trilithons: raised great one first, then the sides, then the arms of the horseshoe
    for (let k = 0; k < 5; k++) {
      const a = AXA + TRI_A[k], ca = Math.cos(a), sa = Math.sin(a), yw = yawOut(a), h = TRI_H[k];
      const cx = ca * TRI_R[k], cz = sa * TRI_R[k], tx = Math.sin(a), tz = -Math.cos(a);
      let lastT1 = 0;
      for (let s = 0; s < 2; s++) {
        const idx = k * 2 + s, sg = s ? 1 : -1, t0 = 0.03 + 0.03 * idx;
        lastT1 = t0 + 0.05;
        let fate = 0, t = 1, fd = -1, brk = false;
        if (k === 0) { fate = s ? 1 : 2; t = s ? 0.33 : 0.3; brk = true; }
        if (k === 1 && s === 0) { fate = 2; t = 0.52; fd = 1; brk = true; }
        Object.assign(U, { hw: 1.4, ht: 0.8, h, sd: sd + 100 + idx, cs: 0, r0: t0, r1: t0 + 0.05, lead: 0.1, sled: true, crew: s ? 0 : 3, w: 0.03 + 0.22 * hr(idx, 1, sd), fate, t, fd, brk, rm: 2, lean: 0.1 });
        upright(b, cx + tx * sg * 1.55, cz + tz * sg * 1.55, yw);
      }
      Object.assign(LT, { len: 6.1, hh: 0.62, ht: 0.78, y: h, sd: sd + 120 + k, r0: lastT1 + 0.04, r1: lastT1 + 0.07, lead: 0.03, w: 0.04 + 0.2 * hr(k, 2, sd), t: k === 0 ? 0.27 : k === 1 ? 0.5 : 2, fd: k === 0 ? -1 : 1, rm: 2, crib: 2 });
      lintel(b, cx, cz, yw);
    }
    yield;

    // --- the sarsen circle: fates first (the entrance arc and its lintels survive)
    const ang = (i) => AXA + (i + 0.5) * TAU / N_S;
    const FATE = new Int8Array(N_S), FT = new Float64Array(N_S), RK = new Int8Array(N_S), LST = new Uint8Array(N_S);
    for (let j = 0; j < N_S; j++) LST[j] = Math.abs(wrap((j + 1) * TAU / N_S)) < 0.55 || j === 11 ? 1 : 0;
    for (let i = 0; i < N_S; i++) {
      const th = Math.abs(wrap(ang(i) - AXA)), u = hr(i, 5, sd);
      let f;
      if (LST[i] || LST[(i + N_S - 1) % N_S]) f = 0;
      else if (th < 1.3) f = u < 0.82 ? 0 : 1;
      else f = u < 0.22 ? 0 : u < 0.36 ? 1 : u < 0.78 ? 2 : 3;
      FATE[i] = f; FT[i] = 0.24 + 0.5 * hr(i, 6, sd);
      let r = 0;
      for (let j = 0; j < N_S; j++) { const tj = Math.abs(wrap(ang(j) - AXA)); if (tj > th + 1e-6 || (Math.abs(tj - th) < 1e-6 && j < i)) r++; }
      RK[i] = r;
    }
    for (let i = 0; i < N_S; i++) {
      const a = ang(i), t0 = 0.2 + 0.4 * RK[i] / N_S;
      Object.assign(U, { hw: 1.3, ht: 0.68, h: H_S, sd: sd + 200 + i, cs: 0, r0: t0, r1: t0 + 0.045, lead: 0.1, sled: true, crew: RK[i] % 3 === 0 ? 2 : 0, w: 0.03 + 0.2 * hr(i, 7, sd), fate: FATE[i], t: FT[i], fd: hr(i, 8, sd) < 0.6 ? 1 : -1, brk: hr(i, 9, sd) < 0.5, rm: hr(i, 10, sd) < 0.35 ? FT[i] + 0.06 + 0.1 * hr(i, 11, sd) : 2, lean: 0.07 + 0.08 * hr(i, 12, sd) });
      upright(b, Math.cos(a) * R_S, Math.sin(a) * R_S, yawOut(a));
    }
    yield;
    // lintels: each spans the heads of uprights j and j + 1, put on from the back round
    for (let j = 0; j < N_S; j++) {
      const a = AXA + (j + 1) * TAU / N_S, th = Math.abs(wrap(a - AXA)), j1 = (j + 1) % N_S;
      let r = 0;
      for (let q = 0; q < N_S; q++) { const tq = Math.abs(wrap((q + 1) * TAU / N_S)); if (tq > th + 1e-6 || (Math.abs(tq - th) < 1e-6 && q < j)) r++; }
      const t0 = 0.66 + 0.27 * r / N_S;
      let t = 2;
      if (!LST[j]) {
        t = 0.12 + 0.5 * hr(j, 20, sd);
        for (const i of [j, j1]) if (FATE[i]) t = Math.min(t, FT[i] - 0.03);
      }
      const rc = R_S * Math.cos(Math.PI / N_S);
      Object.assign(LT, { len: 4.22, hh: 0.5, ht: 0.62, y: H_S, sd: sd + 300 + j, r0: t0, r1: t0 + 0.03, lead: 0.04, w: Math.min(0.04 + 0.2 * hr(j, 21, sd), t - 0.03), t, fd: hr(j, 22, sd) < 0.65 ? 1 : -1, rm: hr(j, 23, sd) < 0.4 ? t + 0.1 + 0.15 * hr(j, 24, sd) : 2, crib: j & 1 ? 0 : 1 });
      lintel(b, Math.cos(a) * rc, Math.sin(a) * rc, yawOut(a));
    }
    yield;

    // --- bluestones: the circle (gap at the entrance) and the inner horseshoe
    for (let i = 0; i < N_BLUE + 15; i++) {
      const hs = i >= N_BLUE;
      let a, r;
      if (!hs) { a = AXA + 0.2 + (i + 0.5) * (TAU - 0.4) / N_BLUE; r = R_BLUE; }
      else { const q = (i - N_BLUE) / 14; a = AXA + Math.PI + (q - 0.5) * 2 * 2.0; r = 6.6 * (1 - 0.1 * Math.cos(a - AXA)); }
      const u = hr(i, 30, sd), th = Math.abs(wrap(a - AXA - Math.PI));
      const t0 = hs ? 0.88 + 0.06 * (i - N_BLUE) / 15 : 0.6 + 0.27 * (th / Math.PI);
      Object.assign(U, { hw: 0.42 + 0.14 * hr(i, 31, sd), ht: 0.3 + 0.08 * hr(i, 32, sd), h: (hs ? 2.6 + 0.6 * (1 - th / 2) : 2.0 + 0.6 * hr(i, 33, sd)), sd: sd + 400 + i, cs: 1, r0: t0, r1: t0 + 0.02, lead: 0, sled: false, crew: 0, w: 2, fate: u < 0.33 ? 4 : u < 0.62 ? 3 : u < 0.74 ? 1 : u < 0.84 ? 2 : 0, t: 0.15 + 0.55 * hr(i, 34, sd), fd: hr(i, 35, sd) < 0.5 ? 1 : -1, brk: false, rm: 2, lean: 0.12 + 0.1 * hr(i, 36, sd) });
      upright(b, Math.cos(a) * r, Math.sin(a) * r, yawOut(a));
    }
    yield;

    // --- the works: an earth ramp of chalk rubble against the circle for the lintels
    const ra = AXA - 0.95, rx = Math.cos(ra), rz = Math.sin(ra);
    b.push(); b.at(0, 0, 0, yawOut(ra));
    b.timeless().pivot(0, 0, 0).reach(6.3).appear(0.6, 0.655, CLIP, 0, BY.BUILT).vanish(0.95, 0.985, CLIP, 0, BY.BUILT);
    b.color(0.41, 0.39, 0.31).surface(SURF.EARTH).ao(1);
    const P = [-3.2, -0.1, 20.1, 3.2, -0.1, 20.1, 3.6, -0.1, 31.5, -3.6, -0.1, 31.5, -2.3, H_S + 1.05, 20.1, 2.3, H_S + 1.05, 20.1, 2.3, 0.05, 31.5, -2.3, 0.05, 31.5];
    b.hexa(P, false);
    b.color(0.3, 0.27, 0.2);
    for (let i = 0; i < 6; i++) b.beam(-2.4, 0.9 + i * 0.99, 30 - i * 1.85, 2.4, 0.9 + i * 0.99, 30 - i * 1.85, 0.11, 0.11, 5); // timber treads
    b.pop();
    // two teams dragging the last sarsens in on rollers: one up the avenue, one round inside the bank
    for (let tm = 0; tm < 2; tm++) {
      const px = tm ? Math.cos(AXA - 1.25) * 26.5 : AXX * 45 + AXZ * 3.2, pz = tm ? Math.sin(AXA - 1.25) * 26.5 : AXZ * 45 - AXX * 3.2;
      const yw = tm ? yawOut(AXA - 1.25) - HP : yawOut(AXA) + Math.PI;
      b.timeless().appear(0, 0.004, POP, 0, BY.BUILT).vanish(0.5 + 0.08 * tm, 0.504 + 0.08 * tm, POP, 0, BY.BUILT);
      b.push(); b.at(px, 0, pz, yw);
      sledge(b, -3.2, 3.2);
      b.surface(SURF.STONE);
      b.push(); b.translate(0, 0.4 + 0.68, -3); b.rotateX(HP); b.translate(0, 0, 0); slab(b, 1.3, 0.68, 0, 5.6, sd + 500 + tm, 0, 0, 0.08, 3, 5, -99); b.pop();
      rope(b);
      for (let s = -1; s <= 1; s += 2) b.beam(s * 0.5, 0.9, 3.0, s * 0.9, 1.2, 12.6, 0.04, 0.04, 4, false);
      for (let i = 0; i < 8; i++) man(b, ((i & 1) ? 1 : -1) * (0.6 + 0.05 * i), 5.0 + 1.1 * (i >> 1) + 0.3 * (i & 1), 0, POSE.HAUL, sd + 600 + tm * 10 + i);
      man(b, 1.6, -0.5, -HP + 0.4, POSE.KNEEL, sd + 630 + tm); // laying the rollers
      man(b, -1.8, 1.2, 0.4, POSE.STAND, sd + 640 + tm); // calling the pull
      b.pop();
    }
    // at the end: a few people on the axis inside the horseshoe, facing the midsummer sunrise
    b.timeless().appear(0.975, 0.98, POP, 0, BY.BUILT).vanish(0.015, 0.02, POP, 0, BY.DECAY);
    for (let i = 0; i < 9; i++) {
      const v = (i - 4) * 0.95 + 0.3 * (hr(i, 1, sd) - 0.5), u = -2.2 + 1.3 * (i % 3) + 0.4 * hr(i, 2, sd);
      man(b, AXX * u - AXZ * v, AXZ * u + AXX * v, yawOut(AXA) + 0.25 * (hr(i, 3, sd) - 0.5), POSE.STAND, sd + 700 + i);
    }
    b.timeless();
    return b.counts();
  },
};
