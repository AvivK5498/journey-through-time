// Melting glacier (event 20, ice, today). A valley glacier retreating in front of the player.
//
// The valley runs away from the road at 54 degrees toward the approach's far side (axis u,
// across v; see AX/AZ), so the driver looks straight up it a few hundred metres before the
// site, and its mouth is open (low walls on both sides there) so the ice front shows on the
// approach. Its walls, floor, lake basin, terminal moraine and cirque headwall are sculpted
// here (build() has no ground access and the pad is flat): one height field in SURF.ROCK, dark
// slate with snow on the ledges above a pale trim line (the ice's old level), pale scoured rock
// below it, grey gravel on the floor, buttresses and gullies on the walls; its flanks sink below
// y = 0 toward the edges so the real ground takes over.
//
// The ice is two height fields over the valley floor whose vertices MORPH (per vertex windows,
// BY.DECAY) down below the floor: the upper layer thins steadily from decay 0 until the front
// reaches it, the lower body keeps its height until the front passes and then drops in a narrow
// window (jittered per vertex, so the front is ragged), so a tall fractured blue cliff walks up
// the valley (front position U(decay), accelerating). Seracs on the snout sink with it; the
// cliff face is streaked deep blue and white with dirty bands. The turquoise lake (a flat water
// sheet under the ice) is uncovered as the front leaves it, braided meltwater streams and bare
// gravel come out above the lake, and the pale trim line stays high on the walls. Marker posts
// are planted where the front stood as it passes (the first at the front of decay 0). At decay 1
// a small remnant sits in the cirque. Moving parts: a block calving off the current front every
// few seconds and three icebergs drifting down the lake (rigs 1-4). A research hut with weather
// mast and solar panel, and figures watching the front, stand on the mouth shore.

import { SURF, POSE, MOTION, BY, fbm3, loop } from './kit.js';

const MORPH = MOTION.MORPH, RISE = MOTION.RISE;
const TH = 0.95; // valley axis angle (54 deg) from +x toward -z
const AX = Math.cos(TH), AZ = -Math.sin(TH), VX = -AZ, VZ = AX; // u axis (AX, AZ), v axis (VX, VZ)
const WL = 0.35; // lake level
const U0 = 40, U1 = 284; // front at decay 0 and 1
const YAW_UP = Math.atan2(AX, AZ), YAW_DOWN = Math.atan2(-AX, -AZ);

function ss(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function X(u, v) { return u * AX + v * VX; }
function Z(u, v) { return u * AZ + v * VZ; }

// ---- valley shape
function W(u) { return 96 - 26 * ss(-30, 110, u) - 16 * ss(150, 280, u); } // half width of the floor
function Hw(u) { return (42 + 100 * ss(0, 240, u)) * ss(-95, 25, u); } // wall height
function bed(u) { return -1 + 2 * ss(138, 162, u) + 17 * ss(172, 215, u) + 31 * ss(228, 300, u); }
function Th(u) { return 42 + 8 * ss(40, 120, u) - 5 * ss(170, 230, u) - 10 * ss(260, 310, u); } // ice thickness
function Wl(u) { // lake half width (rounded at the mouth; -10 = no lake)
  const q = u < -15 ? (u + 15) / 45 : 0, sq = Math.sqrt(Math.max(0, 1 - q * q));
  return (W(u) - 5 + 5 * Math.sin(u / 11) + 3 * Math.sin(u / 4.5 + 1)) * sq - 10;
}
function floorY(u, v) {
  const av = Math.abs(v), e = av - Wl(u);
  const rim = -1 + 1.9 * ss(-5, 5, e) + 0.025 * Math.max(0, e - 5);
  return Math.max(bed(u) + 0.0018 * v * v * ss(120, 160, u), rim); // the lake basin is flat to its shore
}
// The sculpted ground (exact; the mesh interpolates it on a 6 m grid).
function groundF(u, v) {
  const av = Math.abs(v), e = av - W(u);
  let h = floorY(u, v);
  const n = fbm3(u / 70, 2.3, v / 70, 3);
  // the mouth is open: both walls stay low there (the approach side lowest), so the front shows
  const side = v > 0 ? 0.22 + 0.78 * ss(-10, 160, u) : 0.4 + 0.6 * ss(-50, 80, u);
  const g = Math.abs(fbm3(u / 19, 5.1, v / 45, 3) - 0.5) * 2; // buttresses (1) and gullies (0)
  h += side * Hw(u) * Math.pow(ss(-4, 44, e + 12 * (n - 0.5)), 1.1) * (1 - 0.92 * ss(78, 150, e)) * (0.78 + 0.45 * n) * (0.72 + 0.4 * g);
  h += (fbm3(u / 33, 5.1, v / 33, 2) - 0.5) * 22 * ss(20, 55, e) * (1 - ss(80, 130, e)) * ss(-60, 40, u);
  h += 2.6 * Math.exp(-(((u + 62) / 7) ** 2)) * ss(W(u) + 12, W(u) - 6, av); // terminal moraine
  h += 135 * ss(266, 318, u) * (1 + 0.4 * fbm3(v / 40, 9.1, 0.5, 2)); // the cirque headwall (also hides the real ice sheet behind)
  const r = Math.hypot(X(u, v), Z(u, v));
  const f = Math.max(ss(170, 198, av), ss(322, 339, r), ss(-68, -92, u), ss(-130, -160, X(u, v)));
  return h + (-25 - h) * f;
}
// ground for things standing on it: the pad (y = 0) where the sculpted mesh sinks below it
function gy(u, v) { return Math.max(0, groundF(u, v)); }
// Ice surfaces (full, lower body) and the per-vertex timing.
function iceTop(u, v) { const s = v / (W(u) + 6); return bed(u) + Th(u) * (1 - 0.15 * s * s); }
function LB(u, v) { const s = Math.min(1, Math.abs(v) / (W(u) + 6)); return 26 * s * s; } // the snout is a lobe: its sides lag the centre
function lowTop(u, v) { const s = v / (W(u) + 6); return bed(u) + 0.86 * Th(u) * (1 - 0.15 * s * s); }
function U(t) { return U0 + (U1 - U0) * (0.55 * t + 0.45 * t * t); }
function dOf(u) { const s = Math.max(0, (u - U0) / (U1 - U0)); return (-0.55 + Math.sqrt(0.3025 + 1.8 * s)) / 0.9; }
function trimY(u) { return bed(u) + 0.86 * Th(u) + 12; }
// ragged front: a per-place offset (m) of where the front stands, columns of seracs and bays
function jag(u, v) { return 7 * (fbm3(u / 9, 7.7, v / 6, 2) - 0.5) + 3 * Math.sin(v * 0.9 + u * 0.13); }

// ---- sculpted ground grid (cached)
const GU0 = -96, GV0 = -198, GC = 6, GNU = 73, GNV = 66, GW = GNV + 1;
const HG = new Float32Array((GNU + 1) * GW);
let HREADY = false;
function ensureGrid() {
  if (HREADY) return;
  for (let i = 0; i <= GNU; i++) for (let j = 0; j <= GNV; j++) HG[i * GW + j] = groundF(GU0 + i * GC, GV0 + j * GC);
  HREADY = true;
}

// ---- palette (linear)
const ICE = [0.42, 0.62, 0.78], ICE_HI = [0.62, 0.72, 0.82], DEEP = [0.02, 0.13, 0.3], DIRT = [0.1, 0.095, 0.095];
const FACE_W = [0.36, 0.56, 0.72]; // the white-blue of a fresh face
const C = new Float64Array(3);
function iceColour(u, v) {
  const av = Math.abs(v), w = W(u);
  let r = ICE[0], g = ICE[1], bl = ICE[2];
  const hi = ss(200, 285, u); // the snowy upper glacier
  r += (ICE_HI[0] - r) * hi; g += (ICE_HI[1] - g) * hi; bl += (ICE_HI[2] - bl) * hi;
  // crevasses: transverse arcs everywhere below the névé, densest near the current front, the
  // icefall and along the margins
  const amt = 0.35 + 0.65 * Math.max(ss(165, 185, u) * (1 - ss(222, 240, u)), ss(w - 22, w - 6, av)) - 0.5 * hi;
  const ph = (u + 0.009 * v * v) / 9 + 3.2 * fbm3(u / 22, 1.1, v / 16, 2);
  const cr = ss(0.62, 0.92, 0.5 + 0.5 * Math.cos(ph * 6.2832)) * amt * (0.6 + 0.4 * fbm3(u / 7, 4.4, v / 7, 2));
  r += (DEEP[0] - r) * cr; g += (DEEP[1] - g) * cr; bl += (DEEP[2] - bl) * cr;
  // debris: two medial bands, ogive-like dirty arcs, and the lateral moraines on the ice
  const md = Math.exp(-(((av - 0.36 * w) / 3.5) ** 2)) * 0.75 * (1 - hi), lat = ss(w - 14, w - 1, av) * 0.85;
  const og = ss(0.8, 0.97, 0.5 + 0.5 * Math.sin((u + 0.012 * v * v) / 14)) * 0.45 * (1 - hi);
  const dd = Math.max(md, lat, og);
  r += (DIRT[0] - r) * dd; g += (DIRT[1] - g) * dd; bl += (DIRT[2] - bl) * dd;
  C[0] = r; C[1] = g; C[2] = bl;
  return C;
}
// The colour a vertex takes as it becomes part of the cliff face: vertical streaks of white-blue
// ice and deep blue cracks, some columns dirty with debris.
function faceColour(u, v) {
  const s = fbm3(v / 3.2, u / 30, 2.2, 2), crack = ss(0.42, 0.62, s), k = 0.85 + 0.3 * fbm3(v / 11, 6.6, u / 11, 2);
  let r = FACE_W[0] + (DEEP[0] - FACE_W[0]) * crack, g = FACE_W[1] + (DEEP[1] - FACE_W[1]) * crack, bl = FACE_W[2] + (DEEP[2] - FACE_W[2]) * crack;
  const band = ss(0.66, 0.74, fbm3(v / 23, u / 40, 8.8, 2)) * 0.6; // debris-laden columns
  r += (DIRT[0] - r) * band; g += (DIRT[1] - g) * band; bl += (DIRT[2] - bl) * band;
  C[0] = r * k; C[1] = g * k; C[2] = bl * k;
  return C;
}

// One ice layer: rows along u from the front (row 0 is the cliff foot), columns across v.
const IU = 2.5, INU = 104, IV0 = -100, IC = 5, INV = 40;
function iceLayer(b, lower) {
  const base = b.nv, Wc = INV + 1;
  b.timeless().surface(SURF.PLAIN).ao(1).emissive(0.045);
  for (let i = 0; i <= INU; i++) {
    for (let j = 0; j <= INV; j++) {
      const v = IV0 + j * IC;
      const u = U0 + i * IU + (i === 0 ? jag(U0, v) * 0.5 : 0);
      const fl = floorY(u, v), tgt = fl - 2.5;
      const top = lower ? lowTop(u, v) : iceTop(u, v);
      const ue = u - LB(u, v) + (lower ? jag(u, v) : 0), front = i === 0 || ue < U0;
      const y = front ? tgt : top;
      const col = iceColour(u, v);
      if (front) b.color(DEEP[0], DEEP[1], DEEP[2]);
      else b.color(col[0], col[1], col[2]);
      const d = dOf(ue);
      b.timeless();
      if (lower) {
        if (d < 1) {
          const t1 = Math.max(0.008, d), fc = faceColour(u, v);
          b.vanish(Math.max(0, t1 - 0.03), t1, MORPH, 0, BY.DECAY).morph(0, tgt, fc[0], fc[1], fc[2]);
        }
      } else if (d < 1) {
        b.vanish(0, Math.max(0.008, d), MORPH, 0, BY.DECAY).morph(0, tgt, 0.3, 0.4, 0.48);
      } else {
        b.vanish(0, 1, MORPH, 0, BY.DECAY).morph(0, y + (tgt - y) / d, 0.42, 0.55, 0.66);
      }
      // normal from the surface slope
      const e = 1.5, f = lower ? lowTop : iceTop;
      const hu = (f(u + e, v) - f(u - e, v)) / (2 * e), hv = (f(u, v + e) - f(u, v - e)) / (2 * e);
      const tl = lower ? 0.25 : 0; // the lower body's shelf leans a little down-valley
      b.vertex(X(u, v), y, Z(u, v), -(hu * AX + hv * VX) - tl * AX, 1, -(hu * AZ + hv * VZ) - tl * AZ);
    }
  }
  if (b.nv - base !== (INU + 1) * Wc) return;
  for (let i = 0; i < INU; i++) {
    for (let j = 0; j < INV; j++) {
      // skip cells buried in the valley walls
      let vis = false;
      for (let q = 0; q < 4 && !vis; q++) {
        const u = U0 + (i + (q & 1)) * IU, v = IV0 + (j + (q >> 1)) * IC;
        if ((lower ? lowTop(u, v) : iceTop(u, v)) > groundF(u, v) - 0.3) vis = true;
      }
      if (!vis) continue;
      const a = base + i * Wc + j;
      b.quad(a, a + 1, a + Wc + 1, a + Wc);
    }
  }
}

// A serac or ice block (white-blue, faceted), sinking with the ice at (u, v).
function serac(b, u, v, y, sx, sy, sz, sd, lower) {
  const d = dOf(u - LB(u, v) + (lower ? jag(u, v) : 0)), tgt = floorY(u, v) - 2.5;
  b.push(); b.at(X(u, v), y, Z(u, v), sd * 1.7);
  b.timeless().surface(SURF.PLAIN).ao(1).emissive(0.04);
  const k = 0.85 + 0.25 * ((sd * 0.618) % 1);
  b.color(0.5 * k, 0.66 * k, 0.78 * k);
  if (d < 1) {
    const t1 = Math.max(0.008, d);
    b.vanish(lower ? Math.max(0, t1 - 0.03) : 0, t1, MORPH, 0, BY.DECAY).morph(0, tgt, DEEP[0], DEEP[1], DEEP[2]);
  }
  b.rock(sx, sy, sz, 2, 0.1, sd, 7, 0.3);
  b.pop();
}

// Floating ice (bergy bits): mostly under water; some white, some clear blue.
function berg(b, x, z, s, sd, blue) {
  b.push(); b.at(x, WL - 0.3 * s, z, sd);
  if (blue) b.color(0.2, 0.42, 0.58); else b.color(0.52, 0.66, 0.76);
  b.surface(SURF.PLAIN).ao(1).emissive(0.035);
  b.rock(s * 1.3, s * (blue ? 0.8 : 1), s * 1.1, 2, 0.3, sd, 4, 0.5);
  b.pop();
}

function figure(b, u, v, yaw, r, g, bl, sd, pose) {
  b.timeless().color(r, g, bl).surface(SURF.HIDE).ao(1).emissive(0);
  b.push(); b.at(X(u, v), gy(u, v) - 0.05, Z(u, v), yaw); b.human(pose, 1.72, sd); b.pop();
}

// ---- moving parts (animate): scratch only, no allocation
function calveY(u, t) {
  const d = dOf(u), up = iceTop(u, 0), tgt = floorY(u, 0) - 2.5;
  return Math.max(lowTop(u, 0), up + (tgt - up) * Math.min(1, t / Math.max(0.008, d)));
}

export default {
  id: 'glacier',
  name: 'Melting glacier',
  caption: 'The glacier retreats up its valley',
  year: 2026,
  radius: 340,
  pad: 228, // large: the real ice sheet must not push up through the valley floor
  roadOffset: 235,
  straddlesRoad: false,
  biome: 'ice',
  live: true,
  lights: [],
  approach: 800, cone: 0.55,
  reach: 340,
  detail: { at: [X(60, 0), 18, Z(60, 0)], from: [X(-130, -20), 6, Z(-130, -20)] },
  strip: { at: [X(130, 0), 24, Z(130, 0)], from: [X(-170, -10), 9, Z(-170, -10)], fov: 0.62 },
  // From the mouth shore near lake level, looking up the valley at the front: the figures and
  // the hut small in the foreground, the posts receding along the left shore.
  witness: { at: [X(95, 0), Z(95, 0)], look: 9, dist: 270, height: 14, az: TH - 0.06, fov: 0.56, drift: 0.05, range: 1500 },

  animate(a) {
    const t = a.decay, fu = U(Math.min(1, t + 0.03)) - 1;
    // rig 1: a block calving off the front every 9 s, into the lake while the front is in it
    const p = loop(a.t, 9), cyc = Math.floor(a.t / 9);
    const v = 22 * Math.sin(cyc * 2.39), top = calveY(fu, t), low = Math.max(WL, floorY(fu - 5, v));
    if (p < 0.82 && top - low > 4) {
      let y = top, du = 0, pitch = 0.05;
      if (p > 0.2) {
        const k = Math.min(1, (p - 0.2) / 0.16);
        y = top + (low - 1 - top) * k * k; du = -4.5 * k; pitch = 0.05 + 1.4 * k;
      }
      if (p > 0.36) { const k = (p - 0.36) / 0.46; du = -4.5 - 6 * k; y = low - 1.2 - 0.8 * k + 0.25 * Math.sin(a.t * 1.7); pitch = 1.45 + 0.1 * Math.sin(a.t); }
      a.set(1, X(fu + du, v), y, Z(fu + du, v), YAW_DOWN, pitch, 0, 1).show(1, true);
    } else a.show(1, false);
    // rigs 2-4: icebergs drifting down the lake from the front (or the lake head)
    const head = Math.min(fu - 8, 146);
    for (let k = 2; k <= 4; k++) {
      const q = loop(a.t, 70 + 17 * k, k * 23);
      const u = head + (-48 - head) * q, vv = (k - 3) * 22 + 8 * Math.sin(a.t * 0.05 + k);
      a.set(k, X(u, vv), WL + 0.06 * Math.sin(a.t * 0.8 + k), Z(u, vv), a.t * 0.02 * (k - 2.5), 0.03 * Math.sin(a.t * 0.6 + k), 0, 1);
    }
  },

  *build(b, built, decay, seed) {
    ensureGrid();
    // ---- the valley: walls, floor, basin, moraines, headwall (bedded rock, snow on ledges)
    b.timeless().surface(SURF.ROCK).emissive(0);
    const snowC = b.bio('ground');
    const base = b.nv;
    for (let i = 0; i <= GNU; i++) {
      for (let j = 0; j <= GNV; j++) {
        const u = GU0 + i * GC, v = GV0 + j * GC, y = HG[i * GW + j];
        const hu = (HG[Math.min(GNU, i + 1) * GW + j] - HG[Math.max(0, i - 1) * GW + j]) / (2 * GC);
        const hv = (HG[i * GW + Math.min(GNV, j + 1)] - HG[i * GW + Math.max(0, j - 1)]) / (2 * GC);
        const ny = 1 / Math.sqrt(1 + hu * hu + hv * hv);
        const av = Math.abs(v), e = av - W(u), n = fbm3(u / 25, 4.4, v / 25, 2);
        // gravel floor -> pale scoured rock below the trim line -> dark slate and snow above
        const tr = trimY(u) + 5 * (n - 0.5);
        let r = 0.1 + 0.03 * (n - 0.5), g = 0.105 + 0.03 * (n - 0.5), bl = 0.12 + 0.03 * (n - 0.5); // cool grey: stays grey under the warm dusk sun
        const wet = ss(WL + 1.5, WL + 0.2, y) * 0.5;
        r *= 1 - wet; g *= 1 - wet * 0.9; bl *= 1 - wet * 0.8;
        const wall = ss(-14, 2, e);
        r += (0.11 - r) * wall; g += (0.12 - g) * wall; bl += (0.145 - bl) * wall;
        const mor = Math.exp(-(((y - (tr - 10)) / 3) ** 2)) * wall * ss(-40, 10, u) * 0.85; // side moraine
        r += (0.1 - r) * mor; g += (0.095 - g) * mor; bl += (0.09 - bl) * mor;
        const above = ss(tr - 1, tr + 2.5, y) * Math.max(wall, ss(1, 6, y - bed(u)));
        r += (0.035 - r) * above; g += (0.04 - g) * above; bl += (0.052 - bl) * above;
        // snow on the gentle crests and the outer flanks, as on the real ground
        const sn = above * (ss(0.5, 0.75, ny + 0.4 * (fbm3(u / 14, 6.2, v / 14, 2) - 0.5)) * 0.8 + 0.5 * ss(80, 120, y - bed(u)) * ss(0.45, 0.75, ny)) + ss(60, 100, e) * ss(0.45, 0.8, ny + 0.5 * (n - 0.5)) * 0.3 + ss(-55, -85, u) * 0.6; // little snow: dark walls at dusk
        const snk = Math.min(0.6, sn);
        r += (snowC[0] * 0.9 - r) * snk; g += (snowC[1] * 0.9 - g) * snk; bl += (snowC[2] * 0.9 - bl) * snk;
        b.color(r, g, bl).snow(above * 0.9).ao(0.75 + 0.25 * ss(-10, 40, e));
        let x = X(u, v), z = Z(u, v);
        const rr = Math.hypot(x, z);
        if (rr > 339) { x *= 339 / rr; z *= 339 / rr; }
        b.vertex(x, y, z, -(hu * AX + hv * VX), 1, -(hu * AZ + hv * VZ));
      }
    }
    for (let i = 0; i < GNU; i++) {
      for (let j = 0; j < GNV; j++) {
        let ok = true;
        for (let q = 0; q < 4 && ok; q++) {
          const u = GU0 + (i + (q & 1)) * GC, v = GV0 + (j + (q >> 1)) * GC;
          if (Math.hypot(X(u, v), Z(u, v)) > 339) ok = false;
        }
        const o = i * GW + j;
        if (!ok || Math.max(HG[o], HG[o + 1], HG[o + GW], HG[o + GW + 1]) < 0.03) continue;
        b.quad(base + o, base + o + 1, base + o + GW + 1, base + o + GW);
      }
    }
    b.snow(0);
    yield;

    // ---- the turquoise lake (under the ice where the glacier still stands)
    b.timeless().surface(SURF.PLAIN).ao(1).emissive(0.045);
    {
      const lu0 = -66, lc = 6, lnu = 36, lv0 = -112, lnv = 28, lw = 8, wb = b.nv, Wc = lnv + 1;
      for (let i = 0; i <= lnu; i++) for (let j = 0; j <= lnv; j++) {
        const u = lu0 + i * lc, v = lv0 + j * lw, k = 0.5 + 0.5 * fbm3(u / 40, 0.7, v / 40, 2);
        const sh = ss(-4, 3, Math.abs(v) - Wl(u)) * 0.5; // paler milky shallows by the shore
        b.color(0.05 + 0.03 * k + 0.08 * sh, 0.32 + 0.05 * k + 0.08 * sh, 0.34 + 0.04 * k + 0.05 * sh);
        b.vertex(X(u, v), WL, Z(u, v), 0, 1, 0);
      }
      for (let i = 0; i < lnu; i++) for (let j = 0; j < lnv; j++) {
        let wet = false;
        for (let q = 0; q < 4 && !wet; q++) { const u = lu0 + (i + (q & 1)) * lc, v = lv0 + (j + (q >> 1)) * lw; if (floorY(u, v) < WL + 0.4 && groundF(u, v) < WL + 0.4) wet = true; }
        if (!wet) continue;
        const a = wb + i * Wc + j;
        b.quad(a, a + 1, a + Wc + 1, a + Wc);
      }
    }
    // braided meltwater streams over the gravel above the lake (uncovered by the retreat)
    b.color(0.08, 0.3, 0.33).emissive(0.03);
    for (let s = 0; s < 3; s++) {
      let prevL = -1, prevR = -1;
      for (let u = 150; u <= 272; u += 4) {
        const v = (s - 1) * 13 + 11 * Math.sin(u / 21 + s * 2.1) + 5 * Math.sin(u / 8.5 + s), w = 0.9 + 0.6 * (0.5 + 0.5 * Math.sin(u / 13 + s * 3));
        const hu = (floorY(u + 2, v) - floorY(u - 2, v)) / 4;
        const l = b.vertex(X(u, v - w), floorY(u, v - w) + 0.3, Z(u, v - w), -hu * AX, 1, -hu * AZ);
        const r = b.vertex(X(u, v + w), floorY(u, v + w) + 0.3, Z(u, v + w), -hu * AX, 1, -hu * AZ);
        if (prevL >= 0) b.quad(prevL, prevR, r, l);
        prevL = l; prevR = r;
      }
    }
    yield;

    // ---- the glacier: upper layer (thins) and lower body (the front cliff)
    iceLayer(b, false);
    iceLayer(b, true);
    yield;
    // seracs: a broken rampart along the decay-0 front, and blocks over the snout that the
    // thinning surface uncovers as the front comes up the valley (the cliff's jagged skyline)
    for (let k = 0; k < 34; k++) {
      const v = -78 + 156 * (k + 0.5) / 34 + (b.rand() - 0.5) * 3, u = U0 + LB(U0, v) + 2 + 4 * b.rand();
      const s = 2 + 2.6 * b.rand() * b.rand();
      serac(b, u, v, iceTop(u, v) - s * 0.8, s * 0.9, s * (0.8 + 0.8 * b.rand()), s * 0.7, seed * 13 + k, false);
    }
    for (let k = 0; k < 120; k++) {
      const u = U0 + 8 + (250 - U0) * (k / 120) + 3 * b.rand(), w = W(u) - 12;
      const v = (b.rand() * 2 - 1) * w, s = 2.2 + 2.6 * b.rand();
      serac(b, u, v, lowTop(u, v) + s * 0.3, s * 0.9, s * (0.9 + 0.6 * b.rand()), s * 0.8, seed * 7 + k + 100, true);
    }
    // icebergs: those in the decay-0 lake always, the others surface as the lake grows
    for (let k = 0; k < 48; k++) {
      const u = -50 + 196 * Math.sqrt(b.rand()), wl = Wl(u) - 6;
      if (wl < 4) continue;
      const v = (b.rand() * 2 - 1) * wl, s = 0.7 + 2.4 * b.rand() * b.rand();
      b.timeless();
      if (u > U0 - 6) { const ta = Math.min(0.97, dOf(u + 8) + 0.01); b.appear(ta, ta + 0.03, RISE, 2.5 * s, BY.DECAY); }
      if (u < 20 && b.rand() < 0.5) { const tv = 0.3 + 0.6 * b.rand(); b.vanish(tv, tv + 0.08, MOTION.SCALE, 0, BY.DECAY); }
      b.pivot(X(u, v), WL, Z(u, v));
      berg(b, X(u, v), Z(u, v), s, seed + k * 3.1, k % 4 === 0);
    }
    yield;

    // ---- moving parts: the calving block (rig 1) and three drifting bergs (rigs 2-4)
    b.timeless().rig(1);
    b.color(0.42, 0.58, 0.7).surface(SURF.POLISH).ao(1).emissive(0.03);
    b.push(); b.translate(0, -2.5, 0); b.rock(3.6, 3.2, 2.6, 2, 0.25, 4242, 5, 0.2); b.pop();
    for (let k = 2; k <= 4; k++) {
      b.rig(k);
      b.color(0.48, 0.63, 0.74).surface(SURF.POLISH).ao(1).emissive(0.03);
      const s = 1.8 + 0.8 * k;
      b.push(); b.translate(0, -0.4 * s, 0); b.rock(s * 1.4, s, s * 1.1, 2, 0.3, 77 + k, 5, 0.4); b.pop();
    }
    b.rig(0);

    // ---- marker posts where the front stood: the first at the decay-0 front, the rest planted
    // as the front passes them (on the near shore terrace, v < 0), receding up the valley
    for (let k = 0; k < 8; k++) {
      const tk = k * 0.12, v = -(W(U(tk)) - 7), u = U(tk) + LB(U(tk), v) - 3, y = gy(u, v);
      b.timeless();
      if (k) b.appear(tk + 0.012, tk + 0.03, RISE, 4, BY.DECAY);
      b.push(); b.at(X(u, v), y, Z(u, v), 0);
      b.color(0.07, 0.07, 0.075).surface(SURF.WOOD).ao(1).emissive(0);
      b.beam(0, -0.4, 0, 0, 2.8, 0, 0.14, 0.12, 6);
      b.color(0.6, 0.17, 0.04).surface(SURF.PLASTER).emissive(0.04);
      b.beam(0, 2.8, 0, 0, 3.6, 0, 0.2, 0.2, 6);
      b.color(0.2, 0.195, 0.19).surface(SURF.STONE).emissive(0);
      b.rock(0.9, 0.5, 0.9, 2, 0.3, k + 9, 3, 0.6);
      b.pop();
    }
    yield;

    // ---- the research hut, mast and solar panel on the mouth shore; figures watching the front
    {
      const hu = -122, hv = -34, gy0 = gy(hu, hv);
      b.push(); b.at(X(hu, hv), gy0, Z(hu, hv), YAW_UP);
      b.timeless().surface(SURF.STONE).color(0.16, 0.155, 0.15).ao(0.9).emissive(0);
      b.box(0, 0.15, 0, 3.2, 0.4, 2.4); // footing
      b.surface(SURF.WOOD).color(0.42, 0.08, 0.04).ao(0.95); // red-painted walls
      b.box(0, 1.85, 0, 3, 1.3, 2.2, false);
      b.surface(SURF.PLAIN).color(0.11, 0.115, 0.12).ao(0.9); // low-pitched metal roof
      const P = [-3.4, 3.1, -2.6, 3.4, 3.1, -2.6, 3.4, 3.1, 2.6, -3.4, 3.1, 2.6, -3.4, 3.6, -0.05, 3.4, 3.6, -0.05, 3.4, 3.6, 0.05, -3.4, 3.6, 0.05];
      b.hexa(P, true);
      b.color(0.85, 0.6, 0.3).surface(SURF.PLAIN).emissive(0.07); // lit windows (dusk)
      b.box(-1.3, 2.0, 2.21, 0.55, 0.45, 0.04); b.box(1.3, 2.0, 2.21, 0.55, 0.45, 0.04);
      b.box(3.01, 2.0, 0, 0.04, 0.45, 0.6); b.box(-1.3, 2.0, -2.21, 0.55, 0.45, 0.04);
      b.color(0.1, 0.07, 0.05).emissive(0); b.box(1, 1.5, -2.21, 0.5, 1.0, 0.04); // door
      // weather mast with cross arm, cups and vane
      b.surface(SURF.PLAIN).color(0.5, 0.5, 0.48).ao(1);
      b.beam(5, 0, 1, 5, 9, 1, 0.07, 0.05, 6);
      b.beam(4.1, 8.4, 1, 5.9, 8.4, 1, 0.03, 0.03, 4);
      for (let c = 0; c < 3; c++) { const a = c * 2.094; b.beam(5.9, 8.6, 1, 5.9 + 0.35 * Math.cos(a), 8.6, 1 + 0.35 * Math.sin(a), 0.015, 0.015, 3); }
      b.box(4.1, 8.6, 1, 0.35, 0.12, 0.03);
      b.color(0.3, 0.3, 0.3); for (let s = -1; s <= 1; s += 2) b.beam(5, 6, 1, 5 + 2.5 * s, 0, 1 + 1.5 * s, 0.012, 0.012, 3); // guys
      b.box(5, 4, 1.25, 0.25, 0.35, 0.15); // logger box
      // solar panel on a frame, tilted toward the low sun
      b.color(0.3, 0.3, 0.3).surface(SURF.PLAIN);
      b.beam(5.2, 0, -2, 5.2, 1.1, -2, 0.05, 0.05, 4); b.beam(6.6, 0, -2, 6.6, 1.9, -2, 0.05, 0.05, 4);
      b.push(); b.translate(5.9, 1.5, -2); b.rotateZ(0.6);
      b.color(0.03, 0.05, 0.13).surface(SURF.POLISH); b.box(0, 0, 0, 0.85, 0.04, 1.2);
      b.pop();
      // fuel drums and a sledge
      b.color(0.08, 0.16, 0.22).surface(SURF.PLAIN);
      for (let q = 0; q < 3; q++) { b.push(); b.translate(-4.2, 0, -1 + q * 0.7); b.cylinder(0.3, 0.9, 10); b.pop(); }
      b.pop();
      // figures: three on the shore looking up at the ice front, one by the hut
      figure(b, -96, -16, YAW_UP + 0.15, 0.55, 0.14, 0.03, seed + 1, POSE.STAND);
      figure(b, -94.6, -14.2, YAW_UP - 0.1, 0.07, 0.09, 0.16, seed + 2, POSE.STAND);
      figure(b, -97.5, -12.5, YAW_UP, 0.45, 0.4, 0.08, seed + 4, POSE.STAND);
      figure(b, -112, -30, YAW_UP + 1.3, 0.2, 0.2, 0.19, seed + 3, POSE.KNEEL);
    }
    b.timeless();
    return b.counts();
  },
};
