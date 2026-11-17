// Giza: the Great Pyramid of Khufu, c. 2560 BCE, at true scale (base 230.3 m, height 146.6 m,
// faces at 51.84 degrees) on a levelled, rectilinear limestone terrace. Contract:
// internal_docs/LANDMARKS.md.
//
// Live landmark (def.live): one build holds the whole timeline; handle.setState(built,
// decay) animates it in the shader (see the timeline notes above the default export).
//
// Layout: the pyramid stands at (PX, PZ), well back from the road and ahead along it, so the
// whole monument is in frame from the driver's seat at 250 m and at 60 m. It is built in a
// frame rotated PSI about y (the "C frame", pyramid axis aligned, east face toward the road),
// chosen so the two faces seen from the road take clearly different light. Harbour, town and
// quarry are laid out in landmark space; the valley temple is aligned to the C frame.
// Extra primitives defined here (not in kit.js): stepped(), casing(), ramp(), figure(),
// team(), boat(), wallRun().

import { SURF, POSE, FLICKER, noise3, fbm3 } from './kit.js';

const H = 146.6; // apex height
const A = 115.15; // half base
const T = H / A; // tan(face slope)
const PX = 70, PZ = -135; // pyramid centre in landmark space
const PSI = 0.2618; // C frame yaw (rad): east face toward the road and a little toward the approach
const CP = Math.cos(PSI), SP = Math.sin(PSI);
const RAMP_W = 12, RAMP_G = 1 / 7, BOSS = 0.35; // ramp width, gradient; undressed boss depth
// C frame sides: outward normal (x, z) and along direction (x, z). Side 0 faces the road.
const FN = [-1, 0, 0, 1, 1, 0, 0, -1];
const FT = [0, 1, 1, 0, 0, -1, -1, 0];
// terrace (C frame): x from TX0 to TX1, z from TZ0 to TZ1
const TX0 = -178, TX1 = 129, TZ0 = -129, TZ1 = 160;

// --------------------------------------------------------------------------------------
// small helpers (no per-call allocation)

function hsh(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
// C frame -> landmark space and back
const wX = (x, z) => PX + CP * x + SP * z;
const wZ = (x, z) => PZ - SP * x + CP * z;
const cX = (x, z) => CP * (x - PX) - SP * (z - PZ);
const cZ = (x, z) => SP * (x - PX) + CP * (z - PZ);
// foot of the construction ramp (south end of the east face), C frame and landmark space
const FOOT_CX = -(A + BOSS + RAMP_W * 0.5 - 1), FOOT_CZ = -0.55 * A - 2;
const FOOT_X = wX(FOOT_CX, FOOT_CZ), FOOT_Z = wZ(FOOT_CX, FOOT_CZ);
const VT_X = -235, VT_Z = -150; // valley temple centre (aligned to the C frame)
const HB_X = -278, HB_Z = -118; // harbour basin centre; its canal runs off toward the road (-x)
const CW_X = wX(-245, 0), CW_Z = wZ(-245, 0); // causeway bend, clear of the queens' pyramids
const QY_X = -70, QY_Z = -284; // quarry

const QP = new Float64Array(12);
function setQ(i, x, y, z) { QP[i * 3] = x; QP[i * 3 + 1] = y; QP[i * 3 + 2] = z; }
// Quad from QP (a loop of 4 corners), flat normal from its diagonals, oriented toward ref.
function qa(b, rx, ry, rz) {
  const P = QP;
  const ax = P[6] - P[0], ay = P[7] - P[1], az = P[8] - P[2], bx = P[9] - P[3], by = P[10] - P[4], bz = P[11] - P[5];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  if (nx * nx + ny * ny + nz * nz < 1e-14) { nx = rx; ny = ry; nz = rz; }
  const i0 = b.vertex(P[0], P[1], P[2], nx, ny, nz), i1 = b.vertex(P[3], P[4], P[5], nx, ny, nz);
  const i2 = b.vertex(P[6], P[7], P[8], nx, ny, nz), i3 = b.vertex(P[9], P[10], P[11], nx, ny, nz);
  b.quad(i0, i1, i2, i3);
}
// Quad from QP with a given shading normal (used where geometry and shading should differ).
function qn(b, nx, ny, nz) {
  const P = QP;
  const i0 = b.vertex(P[0], P[1], P[2], nx, ny, nz), i1 = b.vertex(P[3], P[4], P[5], nx, ny, nz);
  const i2 = b.vertex(P[6], P[7], P[8], nx, ny, nz), i3 = b.vertex(P[9], P[10], P[11], nx, ny, nz);
  b.quad(i0, i1, i2, i3);
}
// Same as qa with a colour callback per corner (smooth colour variation across big faces).
function qac(b, rx, ry, rz, colFn) {
  const P = QP;
  const ax = P[6] - P[0], ay = P[7] - P[1], az = P[8] - P[2], bx = P[9] - P[3], by = P[10] - P[4], bz = P[11] - P[5];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  if (nx * nx + ny * ny + nz * nz < 1e-14) { nx = rx; ny = ry; nz = rz; }
  colFn(P[0], P[1], P[2]); const i0 = b.vertex(P[0], P[1], P[2], nx, ny, nz);
  colFn(P[3], P[4], P[5]); const i1 = b.vertex(P[3], P[4], P[5], nx, ny, nz);
  colFn(P[6], P[7], P[8]); const i2 = b.vertex(P[6], P[7], P[8], nx, ny, nz);
  colFn(P[9], P[10], P[11]); const i3 = b.vertex(P[9], P[10], P[11], nx, ny, nz);
  b.quad(i0, i1, i2, i3);
}
function col3(b, c, f) { b.color(c[0] * f, c[1] * f, c[2] * f); }
// Same as qa, colour c x f0 on the first two corners and c x f1 on the last two.
function qaV(b, rx, ry, rz, c, f0, f1) {
  const P = QP;
  const ax = P[6] - P[0], ay = P[7] - P[1], az = P[8] - P[2], bx = P[9] - P[3], by = P[10] - P[4], bz = P[11] - P[5];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  if (nx * nx + ny * ny + nz * nz < 1e-14) { nx = rx; ny = ry; nz = rz; }
  col3(b, c, f0);
  const i0 = b.vertex(P[0], P[1], P[2], nx, ny, nz), i1 = b.vertex(P[3], P[4], P[5], nx, ny, nz);
  col3(b, c, f1);
  const i2 = b.vertex(P[6], P[7], P[8], nx, ny, nz), i3 = b.vertex(P[9], P[10], P[11], nx, ny, nz);
  b.quad(i0, i1, i2, i3);
}

// --------------------------------------------------------------------------------------
// Stepped pyramid: courses of blocks (risers + treads), optionally eroded. Pyramid-local
// (centred, axis aligned, base on y = 0). Each side is cut into segments along rays from the
// centre (t = 0..1 corner to corner); a segment's riser sits back by its own inset. Corner
// segments are shared by both sides so the shell stays closed; a course never overhangs the
// one below it. The little side faces between segments of different depth are shaded mostly
// like the riser they belong to, so at distance they neither flash in the sun nor go black.

const TBa = new Float64Array(2 * 80), DIa = new Float64Array(2 * 4 * 80), NNa = new Int32Array(2);
function sx(s, t, d) { return FN[s * 2] * d + FT[s * 2] * (2 * t - 1) * d; }
function sz(s, t, d) { return FN[s * 2 + 1] * d + FT[s * 2 + 1] * (2 * t - 1) * d; }
function lowerInset(cur, s, t0, t1, hw, first) {
  if (first) return 0;
  const pv = 1 - cur, N = NNa[pv], tb = pv * 80, di = (pv * 4 + s) * 80;
  let m = 1e9;
  for (let j = 0; j < N; j++) if (TBa[tb + j + 1] > t0 + 1e-9 && TBa[tb + j] < t1 - 1e-9 && DIa[di + j] < m) m = DIa[di + j];
  return m < 1e8 ? hw - m + 0.03 : 0;
}

function stepped(b, o) {
  const a = o.a, Hh = o.h, top = o.top, seed = o.seed;
  let y0 = o.y0 !== undefined ? o.y0 : -0.3, k = 0, cur = 0, n = 0, prevY = 0;
  const riser = o.rc, tread = o.tc;
  // dark inner core: whatever a crack between blocks reveals is shadowed stone, not sky
  {
    b.color(o.rc[0] * 0.55, o.rc[1] * 0.52, o.rc[2] * 0.5).ao(0.6);
    const yi = Math.max(0, y0), ins = 4.5;
    const w0 = a * (1 - yi / Hh) - ins, yt = Math.min(top - 0.5, Hh * (1 - (ins + 0.5) / a));
    const w1 = a * (1 - yt / Hh) - ins;
    if (w0 > 1 && w1 > 0.4 && yt > yi + 0.5) {
      for (let s = 0; s < 4; s++) {
        setQ(0, sx(s, 0, w0), yi, sz(s, 0, w0)); setQ(1, sx(s, 1, w0), yi, sz(s, 1, w0));
        setQ(2, sx(s, 1, w1), yt, sz(s, 1, w1)); setQ(3, sx(s, 0, w1), yt, sz(s, 0, w1));
        qa(b, FN[s * 2], 0.5, FN[s * 2 + 1]);
      }
      setQ(0, -w1, yt, -w1); setQ(1, w1, yt, -w1); setQ(2, w1, yt, w1); setQ(3, -w1, yt, w1); qa(b, 0, 1, 0);
    }
    b.ao(o.ao !== undefined ? o.ao : 0.9);
  }
  const gr = o.grad || 0, maxI = 3.6;
  for (;;) {
    const hk = (1.45 - 0.8 * Math.max(0, y0) / Hh) * o.course * (0.8 + 0.4 * hsh(k, seed, 11));
    let y1 = y0 + hk;
    if (y1 > top - 0.3 * o.course) y1 = top;
    const hw = a * (1 - y1 / Hh) - o.inset;
    if (hw < 0.45 || y1 <= y0 + 0.01) break;
    const L = 2 * hw, cl = Math.min(o.corner, L * 0.25);
    const nm = Math.max(0, Math.min(70, Math.round((L - 2 * cl) / o.seg)));
    const tb = cur * 80;
    let N;
    TBa[tb] = 0;
    if (nm === 0) { N = 2; TBa[tb + 1] = 0.5; TBa[tb + 2] = 1; } else {
      N = nm + 2;
      TBa[tb + 1] = cl / L;
      for (let j = 1; j < nm; j++) TBa[tb + 1 + j] = (cl + (L - 2 * cl) * (j + o.jit * (hsh(k, j, seed + 31) - 0.5)) / nm) / L; // staggered joints
      TBa[tb + nm + 1] = 1 - cl / L; TBa[tb + N] = 1;
    }
    NNa[cur] = N;
    const first = n === 0, lim = hw * 0.55;
    // insets: mid segments
    for (let s = 0; s < 4; s++) {
      const di = (cur * 4 + s) * 80;
      for (let j = 1; j < N - 1; j++) {
        const t0 = TBa[tb + j], t1 = TBa[tb + j + 1];
        const al = (t0 + t1 - 1) * hw;
        const r = hsh(k * 4 + s, j, seed + 3);
        let I = o.rough * r * r + o.erode * Math.max(0, fbm3(al * 0.035 + s * 17.3, y1 * 0.045, seed * 0.37, 3) * 1.8 - 0.62);
        if (o.cornerErode > 0) { // erosion near the corners falls off over ~24 m
          const dc0 = (t0 + t1) * 0.5 * L, dc1 = L - dc0;
          I += o.cornerErode * cornerE(s, y1, seed) * Math.max(0, 1 - dc0 / 24);
          I += o.cornerErode * cornerE((s + 1) & 3, y1, seed) * Math.max(0, 1 - dc1 / 24);
        }
        if (o.notch > 0 && hsh(k * 4 + s, j, seed + 5) < o.notch) I += 0.25 + 0.4 * hsh(k, j * 4 + s, seed + 6);
        I = Math.min(I, lim, maxI);
        I = Math.max(I, lowerInset(cur, s, t0, t1, hw, first));
        DIa[di + j] = hw - I;
      }
    }
    // insets: corner segments (shared by the two sides that meet there)
    for (let c = 0; c < 4; c++) {
      const sp = (c + 3) & 3;
      let I = o.cornerErode * cornerE(c, y1, seed) + o.rough * hsh(k, c, seed + 9);
      I = Math.min(I, lim, maxI);
      I = Math.max(I, lowerInset(cur, c, 0, TBa[tb + 1], hw, first), lowerInset(cur, sp, TBa[tb + N - 1], 1, hw, first));
      DIa[(cur * 4 + c) * 80] = hw - I;
      DIa[(cur * 4 + sp) * 80 + N - 1] = hw - I;
    }
    // risers and the small side faces between segments of different depth
    if (o.tag) o.tag(b, y1);
    const band = 1 + o.cb * (hsh(k, seed, 21) - 0.5) * 2;
    let minD = 1e9;
    for (let s = 0; s < 4; s++) {
      const di = (cur * 4 + s) * 80, nx = FN[s * 2], nz = FN[s * 2 + 1];
      for (let j = 0; j < N; j++) {
        const D = DIa[di + j], t0 = TBa[tb + j], t1 = TBa[tb + j + 1];
        if (D < minD) minD = D;
        const f = band * (1 + o.cv * (hsh(k * 4 + s, j, seed + 1) - 0.5) * 2) * (1 - o.deep * Math.min(1, (hw - D) / 2.5));
        // each riser darkens toward its foot: the shadow line under every course
        setQ(0, sx(s, t0, D), y0, sz(s, t0, D)); setQ(1, sx(s, t1, D), y0, sz(s, t1, D));
        setQ(2, sx(s, t1, D), y1, sz(s, t1, D)); setQ(3, sx(s, t0, D), y1, sz(s, t0, D));
        qaV(b, nx, 0, nz, riser, f * (1 - gr), f);
        if (j < N - 1) {
          const D2 = DIa[di + j + 1];
          if (D !== D2) { // always closed: no hairline cracks
            const m = 2 * t1 - 1;
            let px = FT[s * 2] - FN[s * 2] * m, pz = FT[s * 2 + 1] - FN[s * 2 + 1] * m;
            if (D < D2) { px = -px; pz = -pz; }
            const pl = Math.hypot(px, pz);
            col3(b, riser, f * (1 - gr * 0.5) * 0.92);
            setQ(0, sx(s, t1, D), y0, sz(s, t1, D)); setQ(1, sx(s, t1, D2), y0, sz(s, t1, D2));
            setQ(2, sx(s, t1, D2), y1, sz(s, t1, D2)); setQ(3, sx(s, t1, D), y1, sz(s, t1, D));
            qn(b, 0.55 * px / pl + 0.45 * nx, 0, 0.55 * pz / pl + 0.45 * nz);
          }
        }
      }
    }
    if (!first) { if (o.tag) o.tag(b, prevY); treads(b, o, 1 - cur, prevY, Math.max(0, minD - 0.3), k - 1, tread); }
    prevY = y1; n++; cur = 1 - cur; y0 = y1; k++;
    if (y1 >= top) break;
  }
  if (n > 0) { if (o.tag) o.tag(b, prevY); treads(b, o, 1 - cur, prevY, 0, k - 1, tread); }
  return prevY;
}
function cornerE(c, y, seed) { return Math.max(0, 0.15 + fbm3(y * 0.06, c * 9.1, seed * 0.71, 3) * 1.3 - 0.45); }
function treads(b, o, c, y, din, k, tread) {
  const N = NNa[c], tb = c * 80, seed = o.seed;
  for (let s = 0; s < 4; s++) {
    const di = (c * 4 + s) * 80;
    for (let j = 0; j < N; j++) {
      const D = DIa[di + j], t0 = TBa[tb + j], t1 = TBa[tb + j + 1];
      col3(b, tread, 1 + o.cv * 0.7 * (hsh(k * 4 + s, j, seed + 2) - 0.5) * 2);
      setQ(0, sx(s, t0, D), y, sz(s, t0, D)); setQ(1, sx(s, t1, D), y, sz(s, t1, D));
      setQ(2, sx(s, t1, din), y, sz(s, t1, din)); setQ(3, sx(s, t0, din), y, sz(s, t0, din));
      qa(b, 0, 1, 0);
    }
  }
}

// --------------------------------------------------------------------------------------
// Smooth casing: four faces, each slightly indented along its centre line (as Khufu's are),
// cut into M columns x R rows (rows = bands of courses, shaded faintly apart) so colour can
// vary per vertex and so stripping can leave a ragged band. keep[s * M + c] = height up to
// which column c of side s keeps its casing.

const KEEP = new Float64Array(4 * 64), KEEPQ = new Float64Array(4 * 16);
function casP(o, s, u, y, inward) {
  const w = Math.max(0, o.a * (1 - y / o.h));
  const out = w - o.dc * (1 - Math.abs(u)) * (w / o.a) - inward, al = u * w;
  QX = FN[s * 2] * out + FT[s * 2] * al; QZ = FN[s * 2 + 1] * out + FT[s * 2 + 1] * al;
}
let QX = 0, QZ = 0, ROW = 0;
const CC = new Float64Array(3); // colour written by a casing colFn
// One casing block (or band of blocks) from u0 to u1, ya to yb on side s. The shading normal
// is steepened (o.steep scales its horizontal part, so the faces turned to and from the sun
// separate more) and jittered per block (jt up/down, ju sideways) so the light breaks up
// course by course. Each block is a little darker along its bottom and left edges: next to
// the lighter top of the block below that reads as a fine joint line.
function casQuad(b, o, s, u0, u1, ya, yb, tint, jt, ju, jb, jl) {
  casP(o, s, u0, ya, 0); setQ(0, QX, ya, QZ);
  casP(o, s, u1, ya, 0); setQ(1, QX, ya, QZ);
  casP(o, s, u1, yb, 0); setQ(2, QX, yb, QZ);
  casP(o, s, u0, yb, 0); setQ(3, QX, yb, QZ);
  const P = QP, fx = FN[s * 2], fz = FN[s * 2 + 1];
  const ax = P[6] - P[0], ay = P[7] - P[1], az = P[8] - P[2], bx = P[9] - P[3], by = P[10] - P[4], bz = P[11] - P[5];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx * fx + ny * 0.6 + nz * fz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  let l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) { nx = fx; ny = 0.6; nz = fz; l = Math.hypot(nx, ny, nz); }
  // o.split: the two halves of each (slightly dished) face take visibly different light
  if (o.split) ju += (u0 + u1 > 0 ? 1 : -1) * o.split;
  nx = nx / l * o.steep + FT[s * 2] * ju; nz = nz / l * o.steep + FT[s * 2 + 1] * ju; ny = ny / l + jt;
  if (o.nyaw) { // shading turned about y (see the finished casing)
    const c = Math.cos(o.nyaw), sn = Math.sin(o.nyaw), rx = c * nx + sn * nz;
    nz = -sn * nx + c * nz; nx = rx;
  }
  for (let v = 0; v < 4; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    o.colFn(x, y, z);
    const f = tint * (v < 2 ? jb : 1) * (v === 0 || v === 3 ? jl : 1);
    b.color(CC[0] * f, CC[1] * f, CC[2] * f);
    VI[v] = b.vertex(x, y, z, nx, ny, nz);
  }
  b.quad(VI[0], VI[1], VI[2], VI[3]);
}
const VI = new Int32Array(4);
// Casing faces. Rows below o.blk are laid in individual blocks (staggered joints, per-block
// tint and normal); higher rows are drawn as M columns per row (rows still shaded apart).
function casing(b, o, keep) {
  const M = o.M, R = o.R, yCap = o.yCap, yLow = o.yLow, th = o.thick, rowH = o.rowH || yCap / R;
  const blk = o.blk || 0, nB = o.nB || 6, sd = o.sd || 0;
  for (let s = 0; s < 4; s++) {
    for (let r = 0; r < R; r++) {
      let ya = r === 0 ? -0.3 : rowH * r, yb = rowH * (r + 1);
      if (yb <= yLow) continue;
      if (ya < yLow) ya = yLow;
      if (ya >= yCap) break;
      if (yb > yCap) yb = yCap;
      ROW = r;
      if (o.rowTag) o.rowTag(b, ya, yb);
      const rj = hsh(r, s, sd + 71), rt = 1 + 0.03 * (hsh(r, s, sd + 72) - 0.5) * 2;
      for (let c = 0; c < M; c++) {
        const cu0 = -1 + 2 * c / M, cu1 = cu0 + 2 / M;
        const ytop = keep ? Math.min(keep[s * M + c], yCap) : yCap;
        if (ya >= ytop) continue;
        const ybb = Math.min(yb, ytop);
        if (ybb <= ya + 0.01) continue;
        if (yb <= blk) { // individual blocks, joints staggered from course to course
          let ua = cu0;
          for (let j = 0; j < nB; j++) {
            const ub = j === nB - 1 ? cu1 : cu0 + (cu1 - cu0) * (j + 0.35 + 0.3 * hsh(r * 7 + j, c + s * 64, sd + 73) + 0.5 * (r & 1) - 0.25) / nB;
            if (ub <= ua + 1e-4) continue;
            const h1 = hsh(r * 64 + c * nB + j, s, sd + 74), h2 = hsh(r * 64 + c * nB + j, s, sd + 75);
            casQuad(b, o, s, ua, ub, ya, ybb, rt * (0.95 + 0.1 * h1), 0.035 * (h2 - 0.5), 0.03 * (h1 - 0.5), 0.9, 0.95);
            ua = ub;
          }
        } else {
          casQuad(b, o, s, cu0, cu1, ya, ybb, rt, 0.03 * (rj - 0.5), 0, 0.93, 1);
        }
      }
    }
    if (!keep) continue;
    const nx = FN[s * 2], nz = FN[s * 2 + 1];
    for (let c = 0; c < M; c++) {
      const u0 = -1 + 2 * c / M, u1 = u0 + 2 / M;
      const ytop = Math.min(keep[s * M + c], yCap);
      if (ytop <= yLow + 0.05) continue;
      if (ytop < yCap - 0.01) { // stripped above: the cut top of the remaining casing
        col3(b, o.cutCol, 1);
        casP(o, s, u0, ytop, 0); setQ(0, QX, ytop, QZ);
        casP(o, s, u1, ytop, 0); setQ(1, QX, ytop, QZ);
        casP(o, s, u1, ytop, th); setQ(2, QX, ytop, QZ);
        casP(o, s, u0, ytop, th); setQ(3, QX, ytop, QZ);
        qa(b, 0, 1, 0);
      }
      if (keep && c < M - 1) { // side of a taller neighbour
        const kh2 = Math.min(keep[s * M + c + 1], yCap);
        if (Math.abs(kh2 - ytop) > 0.01) {
          const ya = Math.max(yLow, Math.min(ytop, kh2)), yb = Math.max(ytop, kh2);
          if (yb > ya + 0.01) {
            col3(b, o.cutCol, 0.9);
            casP(o, s, u1, ya, 0); setQ(0, QX, ya, QZ);
            casP(o, s, u1, yb, 0); setQ(1, QX, yb, QZ);
            casP(o, s, u1, yb, th); setQ(2, QX, yb, QZ);
            casP(o, s, u1, ya, th); setQ(3, QX, ya, QZ);
            const sg = kh2 < ytop ? 1 : -1;
            qn(b, 0.5 * FT[s * 2] * sg + 0.5 * nx, 0.3, 0.5 * FT[s * 2 + 1] * sg + 0.5 * nz);
          }
        }
      }
    }
  }
}

// --------------------------------------------------------------------------------------
// Construction ramp: a mud-brick and rubble embankment that zigzags up the road face (side 0)
// from its south end, turning back on itself a few metres short of each arris, until it
// arrives at the working top. Each run leans on the face; alternate runs have a different
// batter so their outer walls never coincide at a turn. Samples (side, u, y, direction) are
// kept for placing teams.

const RS = new Float64Array(4 * 640);
let RN = 0;
const rP = (s, u, o) => { QX = FN[s * 2] * o + FT[s * 2] * u; QZ = FN[s * 2 + 1] * o + FT[s * 2 + 1] * u; };
const dOf = (y) => A * (1 - y / H) + BOSS;
const MUDB = [0.25, 0.19, 0.13], RUBB = [0.3, 0.245, 0.175]; // darker than the limestone, so the zigzag reads
// smooth, irregular mud-brick / rubble tone (no hard panels)
function rampCol(b, x, y, z) {
  const n = fbm3(x * 0.06 + 1.7, y * 0.11, z * 0.06, 3), m = 0.35 + 0.3 * sstep(0.3, 0.7, fbm3(x * 0.025, y * 0.05 + 4.1, z * 0.025, 2));
  const f = (0.96 + 0.08 * n) * LIFT;
  b.color(lerp(MUDB[0], RUBB[0], m) * f, lerp(MUDB[1], RUBB[1], m) * f, lerp(MUDB[2], RUBB[2], m) * f);
}
const rampColFn = (x, y, z) => rampCol(BREF, x, y, z);
let BREF = null, LIFT = 1;
function rampWall(b, s, u, u1, y, y1, d0, d1, W, bat, h0, h1) {
  const NL = 6, NA = 2;
  for (let L = 0; L < NL; L++) {
    const fa = L / NL, fb = (L + 1) / NL;
    // built up in lifts, parallel to the ramp top; the batter darkens toward its foot (the
    // embankment's own shade and dust), so the run reads as a raised mass with a lit lip
    LIFT = 1.08 - 0.3 * (fa + fb) * 0.5;
    for (let q = 0; q < NA; q++) {
      const ga = q / NA, gb = (q + 1) / NA;
      const ua = lerp(u, u1, ga), ub = lerp(u, u1, gb), ya = lerp(y, y1, ga), yb = lerp(y, y1, gb);
      const da = lerp(d0, d1, ga), db = lerp(d0, d1, gb), ha = lerp(h0, h1, ga), hb = lerp(h0, h1, gb);
      rP(s, ua, da + W + bat * ha * fa); setQ(0, QX, ya - ha * fa, QZ); rP(s, ub, db + W + bat * hb * fa); setQ(1, QX, yb - hb * fa, QZ);
      rP(s, ub, db + W + bat * hb * fb); setQ(2, QX, yb - hb * fb, QZ); rP(s, ua, da + W + bat * ha * fb); setQ(3, QX, ya - ha * fb, QZ);
      qac(b, FN[s * 2], 0, FN[s * 2 + 1], rampColFn);
    }
  }
  LIFT = 1;
}
// End wall of a run at u (facing along dir), from the top at y down the batter.
function rampEnd(b, s, u, y, W, bat, hh, dir) {
  const d = dOf(y);
  rP(s, u, d - 2); setQ(0, QX, y + 0.02, QZ); rP(s, u, d + W); setQ(1, QX, y + 0.02, QZ);
  rP(s, u, d + W + bat * hh); setQ(2, QX, y - hh, QZ); rP(s, u, d - 2); setQ(3, QX, y - hh, QZ);
  // shading normal leans outward and up so an end turned from the sun is not a black slot
  rampCol(b, QP[0], QP[1], QP[2]);
  qn(b, FT[s * 2] * dir + 0.8 * FN[s * 2], 0.5, FT[s * 2 + 1] * dir + 0.8 * FN[s * 2 + 1]);
}
function ramp(b, yEnd, topCol) {
  const W = RAMP_W, g = RAMP_G, s = 0, m = 4;
  BREF = b;
  let u = -0.55 * A, y = 0, k = 0, dir = 1, run = 0;
  let bat = 0.1, hW = W * T / (1 - bat * T) + 1.5;
  RN = 0;
  const push = () => { if (RN < 640) { RS[RN * 4] = s; RS[RN * 4 + 1] = u; RS[RN * 4 + 2] = y; RS[RN * 4 + 3] = dir; RN++; } };
  push();
  let guard = 0;
  // toe: a short wedge from the ground into the ramp foot, so the ramp meets the sledge track
  b.color(topCol[0] * 0.95, topCol[1] * 0.95, topCol[2] * 0.95);
  rP(s, u - 4, dOf(0) - 2); setQ(0, QX, 0.07, QZ); rP(s, u, dOf(0) - 2); setQ(1, QX, 0.07, QZ);
  rP(s, u, dOf(0) + W + 1); setQ(2, QX, 0.07, QZ); rP(s, u - 4, dOf(0) + W + 1); setQ(3, QX, 0.07, QZ);
  qa(b, 0, 1, 0);
  while (y < yEnd - 0.01 && guard++ < 600) {
    if (dOf(y) < W * 1.3) break;
    const tMax = (dOf(y) - m - W * 0.5 - dir * u) / (1 + A * g / H);
    let t = 9, turn = false;
    if (t >= tMax) { t = Math.max(0, tMax); turn = true; }
    if (y + t * g >= yEnd) { t = (yEnd - y) / g; turn = false; }
    const u1 = u + dir * t, y1 = y + t * g;
    if (t > 0.05) {
      const d0 = dOf(y), d1 = dOf(y1);
      const h0 = Math.min(hW, y + 0.3), h1 = Math.min(hW, y1 + 0.3);
      // top: a trodden mud surface with slight tone changes per stretch, pale along the outer
      // lip (sunlit edge), shaded in the angle against the pyramid face
      const tf = 0.94 + 0.12 * hsh(k, 3, 5);
      col3(b, topCol, tf * 0.62);
      rP(s, u, d0 - 2); setQ(0, QX, y + 0.02, QZ); rP(s, u1, d1 - 2); setQ(1, QX, y1 + 0.02, QZ);
      rP(s, u1, d1 + 2); setQ(2, QX, y1 + 0.02, QZ); rP(s, u, d0 + 2); setQ(3, QX, y + 0.02, QZ);
      qa(b, 0, 1, 0);
      col3(b, topCol, tf * 1.25);
      rP(s, u, d0 + 2); setQ(0, QX, y + 0.02, QZ); rP(s, u1, d1 + 2); setQ(1, QX, y1 + 0.02, QZ);
      rP(s, u1, d1 + W); setQ(2, QX, y1 + 0.02, QZ); rP(s, u, d0 + W); setQ(3, QX, y + 0.02, QZ);
      qa(b, 0, 1, 0);
      // a low mud-brick parapet on the outer edge: a bright top and a step of shade
      col3(b, topCol, tf * 1.4);
      rP(s, u, d0 + W - 0.9); setQ(0, QX, y + 0.75, QZ); rP(s, u1, d1 + W - 0.9); setQ(1, QX, y1 + 0.75, QZ);
      rP(s, u1, d1 + W); setQ(2, QX, y1 + 0.75, QZ); rP(s, u, d0 + W); setQ(3, QX, y + 0.75, QZ);
      qa(b, 0, 1, 0);
      col3(b, topCol, tf * 0.8);
      rP(s, u, d0 + W - 0.9); setQ(0, QX, y + 0.02, QZ); rP(s, u1, d1 + W - 0.9); setQ(1, QX, y1 + 0.02, QZ);
      rP(s, u1, d1 + W - 0.9); setQ(2, QX, y1 + 0.75, QZ); rP(s, u, d0 + W - 0.9); setQ(3, QX, y + 0.75, QZ);
      qa(b, -FN[s * 2], 0.2, -FN[s * 2 + 1]);
      rampWall(b, s, u, u1, y, y1, d0, d1, W, bat, h0, h1);
    }
    u = u1; y = y1; k++; push();
    if (turn) { // switchback: close this run's end and climb back the other way
      rampEnd(b, s, u, y, W, bat, Math.min(hW, y + 0.3), dir);
      dir = -dir; run++;
      bat = run & 1 ? 0.2 : 0.1; hW = W * T / (1 - bat * T) + 1.5;
      push();
    }
  }
  rampEnd(b, s, u, y, W, bat, Math.min(hW, y + 0.3), dir);
}

// --------------------------------------------------------------------------------------
// People. figure(): a cheap tapered silhouette (~80 triangles: rounded head, narrow waist,
// flared kilt, legs apart) for crowds, with its own skin and linen tone, lean and stride; kit
// human() is used for the crew nearest the close-up camera. Both face +z.
// pose 0 stand, 1 haul (leaning into the rope), 2 walk.

function figure(b, x, y, z, yaw, pose, h, sd) {
  const v1 = hsh(sd, 1, 1), v2 = hsh(sd, 2, 1), v3 = hsh(sd, 3, 1), v4 = hsh(sd, 4, 1);
  b.push(); b.at(x, y, z, yaw + (v4 - 0.5) * (pose === 1 ? 0.12 : 0.5));
  const sc = h / 1.7;
  b.scale(sc, sc, sc);
  const lean = pose === 1 ? 0.3 + 0.22 * v3 : pose === 2 ? 0.06 : 0.015;
  const st = pose === 1 ? 0.3 + 0.16 * v4 : pose === 2 ? 0.26 * (v3 > 0.5 ? 1 : -1) : 0.05;
  const skr = 0.095 + 0.07 * v1;
  b.color(skr, skr * 0.6, skr * 0.36).surface(SURF.HIDE);
  // legs, set apart
  b.beam(0.085, 0.84, 0, 0.12, 0.04, st, 0.068, 0.042, 4, false);
  b.beam(-0.085, 0.84, 0, -0.12, 0.04, -st * 0.85, 0.068, 0.042, 4, false);
  // torso: narrow waist, broad chest
  b.beam(0, 0.84, 0, 0, 1.36, lean, 0.095, 0.155, 5, false);
  if (pose === 1) { // arms forward on the rope
    b.beam(0.16, 1.32, lean, 0.1, 1.16, lean + 0.42, 0.048, 0.036, 4, false);
    b.beam(-0.16, 1.32, lean, -0.08, 1.2, lean + 0.4, 0.048, 0.036, 4, false);
  } else {
    const sw = pose === 2 ? 0.16 : 0.03;
    b.beam(0.18, 1.33, lean, 0.22, 0.86, lean * 0.4 - sw, 0.048, 0.036, 4, false);
    b.beam(-0.18, 1.33, lean, -0.22, 0.86, lean * 0.4 + sw, 0.048, 0.036, 4, false);
  }
  // neck and a rounded head
  const hz = lean * 1.14;
  b.beam(0, 1.34, lean, 0, 1.47, hz, 0.05, 0.045, 4, false);
  b.beam(0, 1.45, hz, 0, 1.56, hz + 0.01, 0.055, 0.088, 5, false);
  b.beam(0, 1.56, hz + 0.01, 0, 1.69, hz, 0.088, 0.03, 5, true);
  // flared linen kilt
  const lv = 0.36 + 0.14 * v2;
  b.color(lv, lv * 0.93, lv * 0.78).surface(SURF.PLASTER);
  b.push(); b.translate(0, 0.56, lean * 0.08); b.block(0.165, 0.14, 0.11, 0.1, 0.34); b.pop();
  b.pop();
}
function crowdMat(b) { b.surface(SURF.HIDE).ao(1).emissive(0, 0); }

// Hauling team: a block on a wooden sledge, two staggered lines of haulers ahead on ropes, a
// man pouring water in front of the runners and an overseer walking beside the block. Faces
// +z (direction of pull). Spacing, lean and tone vary per man.
function team(b, x, y, z, yaw, n, slope, near, sd, stone) {
  b.push(); b.at(x, y, z, yaw);
  b.push(); b.rotateX(-Math.atan(slope));
  b.color(0.2, 0.13, 0.07).surface(SURF.WOOD).ao(0.95);
  b.beam(-0.55, 0.12, -1.8, -0.55, 0.12, 1.6, 0.12, 0.12, 4, true);
  b.beam(0.55, 0.12, -1.8, 0.55, 0.12, 1.6, 0.12, 0.12, 4, true);
  b.beam(-0.55, 0.16, 1.6, -0.55, 0.42, 2.0, 0.1, 0.08, 4, true);
  b.beam(0.55, 0.16, 1.6, 0.55, 0.42, 2.0, 0.1, 0.08, 4, true);
  const sf = 0.92 + 0.14 * hsh(sd, 9, 2);
  b.color(stone[0] * sf, stone[1] * sf, stone[2] * sf).surface(SURF.STONE).ao(0.95);
  const bh = 0.55 + 0.15 * hsh(sd, 3, 1);
  b.box(0, 0.24 + bh, -0.1, 0.78, bh, 1.25);
  b.pop();
  const z0 = 3.3;
  // hauler positions: two lines, the right line offset half a pace, uneven gaps
  const hx = (i) => (i & 1 ? 0.78 : -0.78) + (hsh(sd, i, 7) - 0.5) * 0.22;
  const hz = (i) => z0 + (i >> 1) * 1.08 + (i & 1 ? 0.52 : 0) + (hsh(sd, i, 8) - 0.5) * 0.35;
  const zl = hz(n - 1) + 0.3;
  if (near) {
    for (let i = 0; i < n; i++) {
      const v = hsh(sd, i, 6), sk = 0.1 + 0.06 * v;
      b.color(sk, sk * 0.6, sk * 0.36).surface(SURF.HIDE).ao(1);
      b.push(); b.at(hx(i), hz(i) * slope, hz(i), (hsh(sd, i, 9) - 0.5) * 0.15); b.human(POSE.HAUL, 1.58 + 0.16 * hsh(sd, i, 5), sd * 31 + i); b.pop();
    }
    for (let i = 0; i < n; i++) { // flared linen kilts
      const lv = 0.34 + 0.14 * hsh(sd, i, 4);
      b.color(lv, lv * 0.93, lv * 0.78).surface(SURF.PLASTER);
      b.push(); b.translate(hx(i), hz(i) * slope + 0.5, hz(i) + 0.02); b.block(0.16, 0.14, 0.11, 0.1, 0.36); b.pop();
    }
    b.color(0.34, 0.27, 0.16).surface(SURF.PLAIN);
    b.beam(-0.8, 0.5 + 1.8 * slope, 1.9, -0.8, 1.15 + zl * slope, zl, 0.03, 0.03, 4, false);
    b.beam(0.8, 0.5 + 1.8 * slope, 1.9, 0.8, 1.15 + zl * slope, zl, 0.03, 0.03, 4, false);
    b.color(0.13, 0.08, 0.05).surface(SURF.HIDE);
    b.push(); b.at(0.2, 2.4 * slope, 2.5, Math.PI); b.human(POSE.KNEEL, 1.6, sd + 77); b.pop();
    b.push(); b.at(1.75, 0, 0.4, -0.5); b.human(POSE.STAND, 1.68, sd + 78); b.pop();
    b.color(0.25, 0.17, 0.09).surface(SURF.WOOD); // overseer's staff
    b.beam(1.95, 0, 0.75, 1.98, 1.85, 0.78, 0.02, 0.018, 4, false);
  } else {
    crowdMat(b);
    for (let i = 0; i < n; i++) figure(b, hx(i), hz(i) * slope, hz(i), 0, 1, 1.56 + 0.18 * hsh(sd, i, 5), sd * 31 + i);
    figure(b, 0.15, 2.4 * slope, 2.4, Math.PI, 2, 1.6, sd + 77);
    figure(b, 1.7, 0.4 * slope, 0.4, -0.4, 0, 1.68, sd + 78);
  }
  b.pop();
}

// A stack yard of dressed blocks: rows x cols, up to `layers` high, some missing.
// use > 0: each block is taken away at its own moment between built = use and the end of
// the works (the yard empties over time); the caller's appear tag is kept.
function stack(b, x, z, yaw, rows, cols, layers, sd, col, use = 0) {
  b.push(); b.at(x, 0.04, z, yaw);
  b.surface(SURF.STONE).ao(0.9);
  for (let l = 0; l < layers; l++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = hsh(sd + l, r, c);
        if (h < 0.18 + l * 0.22) continue;
        const f = 0.92 + 0.16 * hsh(sd, r * 31 + c, l + 9);
        b.color(col[0] * f, col[1] * f, col[2] * f);
        if (use > 0) { const tv = use + (0.86 - use) * hsh(sd + l * 7, r * 13 + c, 99); b.vanish(tv, tv + 0.012, 1, 1.3, 0); }
        b.box((c - (cols - 1) / 2) * 2.0 + (h - 0.5) * 0.2, 0.55 + l * 1.1, (r - (rows - 1) / 2) * 2.9, 0.85, 0.53, 1.3, l > 0);
      }
    }
  }
  b.pop();
}

// Papyriform barge (~110 triangles): a decked hull whose sheer sweeps up into tall bow and
// stern posts. Length 2L along z, beam 2W. Origin at the waterline.
const BP = new Float64Array(24);
function boat(b, L, W) {
  const NS = 10;
  for (let i = 0; i < NS; i++) {
    const ta = -1 + 2 * i / NS, tb = ta + 2 / NS;
    for (let e = 0; e < 2; e++) {
      const t = e ? tb : ta, at = Math.abs(t);
      const w = W * Math.max(0.06, Math.pow(Math.max(0, 1 - at * at), 0.55));
      const keel = -0.35 + 1.3 * at * at * at * at, sheer = 0.9 + 1.7 * Math.pow(at, 5);
      const zz = t * L;
      const i0 = e ? 3 : 0, i1 = e ? 2 : 1; // rings: bottom 0..3, top 4..7 (-x-z, +x-z, +x+z, -x+z)
      BP[i0 * 3] = -w * 0.45; BP[i0 * 3 + 1] = keel; BP[i0 * 3 + 2] = zz;
      BP[i1 * 3] = w * 0.45; BP[i1 * 3 + 1] = keel; BP[i1 * 3 + 2] = zz;
      BP[(i0 + 4) * 3] = -w; BP[(i0 + 4) * 3 + 1] = sheer; BP[(i0 + 4) * 3 + 2] = zz;
      BP[(i1 + 4) * 3] = w; BP[(i1 + 4) * 3 + 1] = sheer; BP[(i1 + 4) * 3 + 2] = zz;
    }
    b.hexa(BP, false);
  }
  // bow and stern posts curling up into papyrus umbels
  b.beam(0, 2.4, L * 0.98, 0, 3.5, L * 1.08, 0.16, 0.1, 5, false);
  b.beam(0, 3.5, L * 1.08, 0, 3.9, L * 1.02, 0.1, 0.22, 5, true);
  b.beam(0, 2.4, -L * 0.98, 0, 3.3, -L * 1.06, 0.16, 0.1, 5, false);
  b.beam(0, 3.3, -L * 1.06, 0, 3.6, -L * 1.0, 0.1, 0.2, 5, true);
}

// Box without a floor whose side normals lean up by `tilt`: buildings seen against the
// light keep some sky fill instead of going black; the roof is a little lighter.
function tbox(b, cx, cy, cz, hx, hy, hz, c, f) {
  const y0 = cy - hy, y1 = cy + hy, t = 0.7;
  col3(b, c, f);
  setQ(0, cx - hx, y0, cz + hz); setQ(1, cx + hx, y0, cz + hz); setQ(2, cx + hx, y1, cz + hz); setQ(3, cx - hx, y1, cz + hz); qn(b, 0, t, 1);
  setQ(0, cx - hx, y0, cz - hz); setQ(1, cx + hx, y0, cz - hz); setQ(2, cx + hx, y1, cz - hz); setQ(3, cx - hx, y1, cz - hz); qn(b, 0, t, -1);
  setQ(0, cx + hx, y0, cz - hz); setQ(1, cx + hx, y0, cz + hz); setQ(2, cx + hx, y1, cz + hz); setQ(3, cx + hx, y1, cz - hz); qn(b, 1, t, 0);
  setQ(0, cx - hx, y0, cz - hz); setQ(1, cx - hx, y0, cz + hz); setQ(2, cx - hx, y1, cz + hz); setQ(3, cx - hx, y1, cz - hz); qn(b, -1, t, 0);
  col3(b, c, f * 1.12);
  setQ(0, cx - hx, y1, cz - hz); setQ(1, cx + hx, y1, cz - hz); setQ(2, cx + hx, y1, cz + hz); setQ(3, cx - hx, y1, cz + hz); qn(b, 0, 1, 0);
}
// Straight strip on the ground (sledge track, path), y just above the terrace.
function strip(b, x0, z0, x1, z1, w, y) {
  let dx = x1 - x0, dz = z1 - z0;
  const l = Math.hypot(dx, dz); dx /= l; dz /= l;
  const px = -dz * w * 0.5, pz = dx * w * 0.5;
  setQ(0, x0 + px, y, z0 + pz); setQ(1, x1 + px, y, z1 + pz); setQ(2, x1 - px, y, z1 - pz); setQ(3, x0 - px, y, z0 - pz);
  qa(b, 0, 1, 0);
}
// Timber sleepers across a track every `step` metres (evenly spaced, perpendicular).
function sleepers(b, x0, z0, x1, z1, w, step, y) {
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
  const n = Math.floor(l / step);
  for (let i = 1; i < n; i++) {
    const t = i / n, f = 0.85 + 0.3 * hsh(i, 5, 17);
    b.color(0.2 * f, 0.135 * f, 0.08 * f);
    b.push(); b.at(x0 + dx * t, y, z0 + dz * t, yaw + Math.PI * 0.5);
    b.box(0, 0.07, 0, 0.16, 0.07, w * 0.5, false);
    b.pop();
  }
}
// Oriented box from p0 to p1 (centre line on the ground), width w, height h; for the causeway.
const HX = new Float64Array(24);
function wallLine(b, x0, z0, x1, z1, w, y0, h, wt) {
  let dx = x1 - x0, dz = z1 - z0;
  const l = Math.hypot(dx, dz); dx /= l; dz /= l;
  const px = -dz * w * 0.5, pz = dx * w * 0.5, tx = -dz * wt * 0.5, tz = dx * wt * 0.5;
  HX[0] = x0 - px; HX[2] = z0 - pz; HX[3] = x1 - px; HX[5] = z1 - pz; HX[6] = x1 + px; HX[8] = z1 + pz; HX[9] = x0 + px; HX[11] = z0 + pz;
  HX[12] = x0 - tx; HX[14] = z0 - tz; HX[15] = x1 - tx; HX[17] = z1 - tz; HX[18] = x1 + tx; HX[20] = z1 + tz; HX[21] = x0 + tx; HX[23] = z0 + tz;
  for (let i = 0; i < 4; i++) { HX[i * 3 + 1] = y0; HX[12 + i * 3 + 1] = y0 + h; }
  b.hexa(HX, false);
}
// Battered limestone wall laid in courses of dressed blocks (joints staggered course to
// course, each block tinted a little apart) under a square, slightly projecting coping.
// rag 0..1 breaks it into ruined stubs of uneven height.
// grow: each block is tagged to rise (CLIP) as a work front runs along the wall from (x0, z0):
// WT = [t0, t1, height, start fraction of the front] (front fraction 0..1 maps to t0..t1;
// the run covers L / (8 * 127 m) of it), worn down block by block with decay 0.2-0.88.
const WT = new Float64Array(4);
function wallRun(b, x0, z0, x1, z1, t, h, col, sd, rag = 0, grow = false) {
  const L = Math.hypot(x1 - x0, z1 - z0), nc = h > 2.4 ? 2 : 1, ch = h / nc;
  const span = L / (8 * (A + 11.7));
  const gtag = (u, k) => {
    if (!grow) return;
    const f = WT[3] + span * u, ta = WT[0] + (WT[1] - WT[0]) * f + 0.01 * k;
    b.timeless().pivot(0, 0, 0).reach(WT[2]).appear(ta, ta + 0.06, M_CLIP, 0, BY_B).vanish(0.2 + 0.3 * hsh(u * 50 | 0, sd, 5), 0.88, M_CLIP, 0, BY_D);
  };
  for (let k = 0; k < nc; k++) {
    const n = Math.max(1, Math.round(L / 4.4)), off = (k & 1) * 0.5;
    for (let i = -1; i < n; i++) {
      const a = clamp01((i + off) / n), c = clamp01((i + 1 + off) / n);
      if (c <= a + 1e-6) continue;
      gtag((a + c) * 0.5, k);
      const f = 0.93 + 0.12 * hsh(i * 3 + k, sd, 41);
      let bh = ch;
      if (rag > 0) { bh = ch * (1 - rag * 0.85 * hsh(i, k + sd * 7, 42)); if (bh < 0.08) continue; }
      b.color(col[0] * f, col[1] * f, col[2] * f);
      wallLine(b, lerp(x0, x1, a), lerp(z0, z1, a), lerp(x0, x1, c), lerp(z0, z1, c), lerp(t, t * 0.72, k / nc), k === 0 ? -0.1 : k * ch, bh + (k === 0 ? 0.1 : 0), lerp(t, t * 0.72, (k + 1) / nc));
    }
  }
  if (h > 1 && rag < 0.3) { // square coping in 2 m blocks
    const n = Math.max(1, Math.round(L / 2)), cw = t * 0.72 + 0.35;
    for (let i = 0; i < n; i++) {
      gtag((i + 0.5) / n, 2);
      col3(b, col, 1.04 + 0.06 * hsh(i, sd, 43));
      wallLine(b, lerp(x0, x1, i / n), lerp(z0, z1, i / n), lerp(x0, x1, (i + 1) / n), lerp(z0, z1, (i + 1) / n), cw, h, 0.45, cw);
    }
  }
}

// --------------------------------------------------------------------------------------


// --------------------------------------------------------------------------------------
// Timeline. The build emits every element the site ever has, tagged with the window of
// `built` (or `decay`) in which it appears or goes; handle.setState animates it in the shader.

const NL = 10; // lifts: the core rises a lift at a time, then pauses while the top is worked
const T_CORE = 0.72; // built at which the core reaches the apex
const DT = T_CORE / NL, RISEF = 0.55; // a lift rises during the first 55% of its slot
const T_DRESS0 = 0.74, T_DRESS1 = 0.95; // casing slides down from the apex; ramp cleared
const T_CLEAR = 0.9; // yards, tracks and crews taken away
const LTOP = new Float64Array(NL + 1); // highest course top in each lift
const liftOf = (y) => Math.min(NL - 1, Math.max(0, Math.ceil(y / (H / NL) - 1e-6) - 1));
const dressT = (y) => T_DRESS0 + (T_DRESS1 - T_DRESS0) * clamp01(1 - y / (H - 7.5));
const BY_B = 0, BY_D = 1;
const M_POP = 0, M_RISE = 1, M_GROW = 2, M_SCALE = 3, M_DROP = 5, M_CLIP = 6;

// construction-time element: appears near the start, cleared away at the end of the works
function works(b, t0 = 0.0, tc = T_CLEAR, h = 0.8) {
  b.timeless().appear(t0, t0 + 0.02, M_RISE, h, BY_B).vanish(tc, tc + 0.025, M_RISE, h, BY_B);
}
// finished-complex element: grows up from its foot (CLIP to height h), falls with decay
function complex(b, t0, t1, h, y0 = 0, d0 = 0.15, d1 = 0.65) {
  b.timeless().pivot(0, y0, 0).reach(h).appear(t0, t1, M_CLIP, 0, BY_B).vanish(d0, d1, M_CLIP, 0, BY_D);
  // pivot() above used the current transform; only its y matters for CLIP
}

const TURA = [0.43, 0.36, 0.255]; // dressed Tura limestone: creamy warm white (the sheen does the rest)
const TURA_F = [0.54, 0.515, 0.445]; // fresh casing during construction
const CORE_R = [0.4, 0.31, 0.2]; // tan local-limestone core, risers
const CORE_T = [0.44, 0.35, 0.235]; // course tops
const BLOCK = [0.46, 0.38, 0.26]; // core blocks on sledges and in yards
const TOWN = [0.5, 0.38, 0.25], TOWN2 = [0.55, 0.44, 0.3]; // plastered mud brick, whitewashed
const LIME = [0.47, 0.385, 0.27]; // walls and temples: a step darker than the casing so they separate
const SAND = [0.52, 0.39, 0.23];
const GOLD = [0.95, 0.66, 0.22]; // electrum capstone (metal: this is its specular colour)

export default {
  id: 'giza',
  name: 'Great Pyramid',
  caption: "Khufu's pyramid rises at Giza",
  year: -2560,
  radius: 350,
  pad: 352,
  roadOffset: 358,
  straddlesRoad: false,
  biome: 'desert',
  live: true,
  // viewer only: a mid-morning sun from behind the driver that rakes one face and leaves the
  // other in shade (the game's sun moves; any azimuth off the face bisector reads)
  viewSunAz: 1.75,
  lights: [
    // bakery hearths in the workers' town; the town empties early in the decay
    { pos: [-250, 1.4, 104], color: [1.0, 0.52, 0.22], intensity: 55, range: 24, flicker: 0.6, vanish: [0.03, 0.12] },
  ],
  // close-up: from beside the mortuary temple's gate, looking up the dressed east face to the
  // gilded capstone (temple walls and the court in the foreground)
  // Event moment (LANDMARKS.md "Witness"): the whole pyramid, apex to terrace, from the
  // roadside three-quarter view (the ramp face lit), with headroom above the apex.
  witness: { at: [PX, PZ], dist: 500, height: 38, look: 64, az: 0.5, fov: 0.56, drift: 0.06, range: 1350 },
  detail: {
    at: [wX(-118, -6), 40, wZ(-118, -6)],
    from: [wX(-232, 40), 2.2, wZ(-232, 40)],
  },

  // built 0..0.8: the core rises in ten lifts (each rises, then pauses with block stacks and
  //   crews on its top), the zigzag ramp climbs with it, the fresh white casing follows a
  //   little behind, closing over the core from the base; yards, tracks and hauling teams
  //   work below; the queens' pyramids grow from 0.55.
  // 0.8..1: the gilded capstone is set (0.86), the casing is dressed from the apex down while
  //   the ramp is cleared top-down (0.86-0.975); temples, causeway and walls go up; yards are
  //   cleared (0.885). decay: capstone, town and people go, the casing is stripped top-down to
  //   the stepped core, temples and walls fall, a rubble skirt builds up round the base.
  *build(b, built, decay, seed) {
    const rs = seed * 7 + 3;
    const bg = b.bio('ground'), br = b.bio('rock');
    // sand and dust tones from the desert biome, limestones kept in the same warm family
    const sand = [lerp(SAND[0], bg[0], 0.6), lerp(SAND[1], bg[1], 0.6), lerp(SAND[2], bg[2], 0.6)];
    const lime = [lerp(LIME[0], bg[0], 0.15), lerp(LIME[1], bg[1], 0.15), lerp(LIME[2], bg[2], 0.15)];
    const coreR = [lerp(CORE_R[0], br[0], 0.2), lerp(CORE_R[1], br[1], 0.2), lerp(CORE_R[2], br[2], 0.2)];

    // ---- the plateau: a levelled rectilinear terrace aligned to the pyramid, with a low
    // quarried scarp on its two far sides
    b.timeless();
    b.push(); b.translate(PX, 0, PZ); b.rotateY(PSI);
    {
      b.surface(SURF.EARTH).ao(1);
      b.heightfield(TX0, TZ0, TX1, TZ1, 30, 28, (x, z) => {
        const n = fbm3(x * 0.014, 0, z * 0.014, 3), n2 = noise3(x * 0.07, 1.3, z * 0.07);
        const edge = Math.min(x - TX0, TX1 - x, z - TZ0, TZ1 - z);
        const sd = clamp01(0.15 * (0.6 + 0.8 * n) + 0.3 * (1 - sstep(0, 40, edge)));
        const cr = lerp(0.5, sand[0], sd), cg = lerp(0.45, sand[1], sd), cb = lerp(0.355, sand[2], sd);
        const f = 0.9 + 0.18 * n + 0.07 * n2;
        // baked AO: the terrace darkens toward the pyramid's foot
        const sq = Math.max(Math.abs(x), Math.abs(z)), ao = 1 - 0.22 * sstep(A + 14, A, sq);
        b.color(cr * f * ao, cg * f * ao, cb * f * ao);
        return 0.04;
      });
      b.surface(SURF.STONE);
      col3(b, [0.44, 0.39, 0.3], 1);
      const bw = 1.6;
      setQ(0, TX0, 0.05, TZ0); setQ(1, TX1, 0.05, TZ0); setQ(2, TX1, 0.05, TZ0 + bw); setQ(3, TX0, 0.05, TZ0 + bw); qa(b, 0, 1, 0);
      setQ(0, TX0, 0.05, TZ1 - bw); setQ(1, TX1, 0.05, TZ1 - bw); setQ(2, TX1, 0.05, TZ1); setQ(3, TX0, 0.05, TZ1); qa(b, 0, 1, 0);
      setQ(0, TX0, 0.05, TZ0 + bw); setQ(1, TX0 + bw, 0.05, TZ0 + bw); setQ(2, TX0 + bw, 0.05, TZ1 - bw); setQ(3, TX0, 0.05, TZ1 - bw); qa(b, 0, 1, 0);
      setQ(0, TX1 - bw, 0.05, TZ0 + bw); setQ(1, TX1, 0.05, TZ0 + bw); setQ(2, TX1, 0.05, TZ1 - bw); setQ(3, TX1 - bw, 0.05, TZ1 - bw); qa(b, 0, 1, 0);
      b.surface(SURF.STONE).ao(0.95);
      for (let i = 0; i < 26; i++) {
        const z0 = TZ0 + (TZ1 - TZ0) * i / 26, z1 = TZ0 + (TZ1 - TZ0) * (i + 1) / 26;
        const h = 0.7 + 1.1 * fbm3(i * 0.3, 1, seed * 0.2, 2), g = 0.88 + 0.2 * hsh(i, 1, 23);
        b.color(lerp(0.47, br[0], 0.3) * g, lerp(0.4, br[1], 0.3) * g, lerp(0.29, br[2], 0.3) * g);
        HX.set([TX1, -0.2, z0, TX1 + 3, -0.2, z0, TX1 + 3, -0.2, z1, TX1, -0.2, z1, TX1, h, z0, TX1 + 2.4, h * 0.9, z0, TX1 + 2.4, h * 0.9, z1, TX1, h, z1]);
        b.hexa(HX, false);
      }
      for (let i = 0; i < 26; i++) {
        const x0 = TX0 + (TX1 + 3 - TX0) * i / 26, x1 = TX0 + (TX1 + 3 - TX0) * (i + 1) / 26;
        const h = 0.6 + 1.0 * fbm3(i * 0.3, 2, seed * 0.2, 2) * sstep(0, 3, i), g = 0.88 + 0.2 * hsh(i, 2, 23);
        b.color(lerp(0.47, br[0], 0.3) * g, lerp(0.4, br[1], 0.3) * g, lerp(0.29, br[2], 0.3) * g);
        HX.set([x0, -0.2, TZ0 - 3, x1, -0.2, TZ0 - 3, x1, -0.2, TZ0, x0, -0.2, TZ0, x0, h * 0.9, TZ0 - 2.4, x1, h * 0.9, TZ0 - 2.4, x1, h, TZ0, x0, h, TZ0]);
        b.hexa(HX, false);
      }
      // trodden, wetted work area at the ramp foot (dark tafla mud) while the works go on
      works(b, 0, T_CLEAR, 0.4);
      b.surface(SURF.EARTH).ao(1);
      b.push(); b.translate(FOOT_CX - 12, 0, FOOT_CZ - 6);
      b.disc(48, 40, 6, (x, z) => {
        const n = fbm3(x * 0.05, 3, z * 0.05, 2), r = Math.hypot(x, z);
        b.color(0.3 + 0.05 * n, 0.235 + 0.04 * n, 0.165 + 0.03 * n);
        return r > 22 + 22 * n ? -0.4 : 0.07;
      });
      b.pop();
      b.timeless();
      // the levelled base course outline, visible before the first lift
      b.color(0.5, 0.45, 0.36).surface(SURF.STONE).ao(1);
      b.box(0, 0.06, 0, A + 0.6, 0.06, A + 0.6, false);
    }
    b.pop();
    yield;

    // ---- harbour: a quayed basin at the end of a canal (silts up with decay)
    {
      const bx0 = HB_X - 22, bx1 = HB_X + 22, bz0 = HB_Z - 13, bz1 = HB_Z + 13;
      const cx0 = -323, cz0 = HB_Z - 6, cz1 = HB_Z + 6;
      works(b, 0, T_CLEAR + 0.03, 0.4);
      b.surface(SURF.EARTH).ao(1);
      b.push(); b.translate(HB_X + 16, 0, HB_Z + 4);
      b.disc(24, 24, 4, (x, z) => {
        const n = fbm3(x * 0.05, 4, z * 0.05, 2);
        b.color(0.32 + 0.06 * n, 0.25 + 0.05 * n, 0.17 + 0.03 * n);
        return Math.hypot(x, z) > 16 + 8 * n ? -0.3 : 0.03;
      });
      b.pop();
      b.timeless().vanish(0.08, 0.35, M_RISE, 0.06, BY_D);
      b.surface(SURF.PLAIN).ao(1);
      b.color(0.12, 0.13, 0.095).emissive(0.015, FLICKER.NONE);
      setQ(0, bx0, 0.045, bz0); setQ(1, bx1, 0.045, bz0); setQ(2, bx1, 0.045, bz1); setQ(3, bx0, 0.045, bz1); qa(b, 0, 1, 0);
      setQ(0, cx0, 0.045, cz0); setQ(1, bx0, 0.045, cz0); setQ(2, bx0, 0.045, cz1); setQ(3, cx0, 0.045, cz1); qa(b, 0, 1, 0);
      b.emissive(0, 0);
      b.timeless().vanish(0.2, 0.6, M_RISE, 0.45, BY_D);
      const qh = 0.4;
      b.surface(SURF.STONE).ao(0.9);
      const quay = (x0, z0, x1, z1, sd) => {
        const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 4.5)), ax = Math.abs(x1 - x0) > Math.abs(z1 - z0);
        for (let i = 0; i < n; i++) {
          const g = 0.88 + 0.18 * hsh(i, sd, 3), t = (i + 0.5) / n, hl = L / n * 0.5 - 0.06;
          b.color(0.5 * g, 0.45 * g, 0.36 * g);
          b.box(lerp(x0, x1, t), qh * 0.5, lerp(z0, z1, t), ax ? hl : 1, qh * 0.5 + 0.02, ax ? 1 : hl, false);
        }
      };
      quay(bx0 - 2, bz0 - 1, bx1 + 2, bz0 - 1, 1); quay(bx0 - 2, bz1 + 1, bx1 + 2, bz1 + 1, 2);
      quay(bx1 + 1, bz0, bx1 + 1, bz1, 3);
      quay(bx0 - 1, bz0, bx0 - 1, cz0 - 2, 4); quay(bx0 - 1, cz1 + 2, bx0 - 1, bz1, 5);
      quay(cx0, cz0 - 1, bx0 - 2, cz0 - 1, 6); quay(cx0, cz1 + 1, bx0 - 2, cz1 + 1, 7);
      // barges: four bring Tura limestone while the works go on; two stay after
      for (let i = 0; i < 4; i++) {
        if (i < 2) b.timeless().vanish(0.1 + 0.12 * i, 0.2 + 0.12 * i, M_RISE, 3, BY_D); else works(b, 0, T_CLEAR + 0.02, 4);
        const inCanal = i === 3;
        const bz = inCanal ? HB_Z + (b.rand() - 0.5) * 1.5 : HB_Z + (i - 1) * 8 + (b.rand() - 0.5) * 0.8;
        const bx = inCanal ? -306 : HB_X - 6 + (i & 1) * 10 + (b.rand() - 0.5) * 3;
        b.push(); b.at(bx, 0.04, bz, Math.PI * 0.5 + (b.rand() - 0.5) * 0.1);
        b.color(0.21, 0.14, 0.08).surface(SURF.WOOD).ao(0.95);
        boat(b, 11, 2.6);
        if (i < 2) works(b, 0, T_CLEAR, 2); // their cargo, until the works end
        b.color(TURA_F[0] * 1.05, TURA_F[1] * 1.05, TURA_F[2] * 1.05).surface(SURF.STONE);
        b.box(0, 1.6, 1.5, 1.0, 0.7, 1.6, false); b.box(0, 1.45, -3.5, 0.9, 0.55, 1.3, false);
        if (i < 2) b.timeless().vanish(0.1 + 0.12 * i, 0.2 + 0.12 * i, M_RISE, 3, BY_D); else works(b, 0, T_CLEAR + 0.02, 4);
        crowdMat(b);
        for (let k = 0; k < 4; k++) figure(b, (b.rand() - 0.5) * 2.4, 0.9, -7 + k * 4 + b.rand(), b.rand() * 6.28, k === 0 ? 0 : 2, 1.65, rs + 300 + i * 9 + k);
        b.pop();
      }
    }
    yield;

    // ---- workers' town: mud-brick galleries, bakeries, granaries; lived in throughout the
    // works, abandoned and sanded over early in the decay
    {
      const tx0 = -292, tz0 = 74;
      const tc = TOWN;
      const townIn = (i) => { b.timeless().pivot(0, 0, 0).appear(0.01 + 0.08 * hsh(i, 1, 77), 0.04 + 0.08 * hsh(i, 1, 77), M_GROW, 0, BY_B).vanish(0.12 + 0.2 * hsh(i, 2, 77), 0.3 + 0.25 * hsh(i, 2, 77), M_GROW, 0, BY_D); };
      b.surface(SURF.EARTH).ao(1);
      for (let side = 0; side < 4; side++) {
        const horiz = side < 2, L0 = horiz ? -292.6 : 74, L1 = horiz ? -207.4 : side === 2 ? 135 : 115;
        const fixed = side === 0 ? 73 : side === 1 ? 135 : side === 2 ? -292.6 : -207.4;
        for (let p0 = L0; p0 < L1 - 1;) {
          const len = Math.min(L1 - p0, 6 + 6 * hsh(side, p0 | 0, 31)), p1 = p0 + len, h = 1.1 * (0.8 + 0.4 * hsh(side, p0 | 0, 32));
          const c = (p0 + p1) * 0.5, hl = len * 0.5 - 0.05;
          townIn(side * 100 + (p0 | 0));
          if (horiz) tbox(b, c, h, fixed, hl, h, 0.6, tc, 1.0);
          else tbox(b, fixed, h, c, 0.6, h, hl, tc, 1.0);
          p0 = p1 + (hsh(side, p0 | 0, 33) > 0.8 ? 3 : 0.1);
        }
      }
      for (let blk = 0; blk < 3; blk++) {
        const bx0 = tx0 + 4 + blk * 28.5;
        for (let g = 0; g < 7; g++) {
          if (blk === 2 && g > 4) continue;
          if (blk === 1 && g === 3) continue;
          const gz = tz0 + 6 + g * 7.6, len = 11 + 1.5 * hsh(blk, g, 4);
          let x = bx0 + 1;
          const xe = bx0 + 1 + 2 * len;
          for (let hI = 0; x < xe - 1; hI++) {
            const w = Math.min(xe - x, 4.5 + 3.5 * hsh(blk * 16 + g, hI, 41));
            const hgt = 2.4 + 1.5 * hsh(blk * 16 + g, hI, 42), f = 0.9 + 0.2 * hsh(blk * 16 + g, hI, 43);
            const c = hsh(blk * 16 + g, hI, 44) > 0.65 ? TOWN2 : tc;
            townIn(1000 + blk * 100 + g * 10 + hI);
            tbox(b, x + w * 0.5, hgt * 0.5, gz, w * 0.5 - 0.06, hgt * 0.5, 3.0, c, f);
            const r = hsh(blk * 16 + g, hI, 45);
            if (r > 0.72) {
              b.color(0.2, 0.14, 0.08).surface(SURF.WOOD);
              for (let q = 0; q < 4; q++) b.beam(x + w * 0.5 + (q & 1 ? 1.3 : -1.3), hgt, gz + (q & 2 ? 1.6 : -1.6), x + w * 0.5 + (q & 1 ? 1.3 : -1.3), hgt + 1.5, gz + (q & 2 ? 1.6 : -1.6), 0.05, 0.05, 4, false);
              b.color(0.42, 0.36, 0.22).surface(SURF.THATCH);
              b.box(x + w * 0.5, hgt + 1.58, gz, 1.6, 0.08, 1.9, true);
              b.surface(SURF.EARTH);
            } else if (r > 0.5) {
              tbox(b, x + w * 0.5 + 0.8, hgt + 0.8, gz + 1.4, 1.0, 0.8, 1.0, c, f * 0.97);
            }
            x += w;
          }
        }
      }
      for (let i = 0; i < 9; i++) {
        const hx = tx0 + 6 + i * 9.5 + (hsh(i, 1, 9) - 0.5) * 2, hz = tz0 + 59 + (hsh(i, 2, 9) - 0.5) * 1.5;
        const hh = 2.3 + 0.8 * hsh(i, 3, 9);
        townIn(2000 + i);
        tbox(b, hx, hh * 0.5, hz, 3.2 + 1.2 * hsh(i, 5, 9), hh * 0.5, 2.2, tc, 0.85 + 0.25 * hsh(i, 4, 9));
      }
      for (let i = 0; i < 4; i++) {
        townIn(3000 + i);
        b.push(); b.translate(-212 - i * 6.5, 0, 126);
        col3(b, [0.4, 0.31, 0.2], 1);
        QP.set([2.3, 0, 2.3, 2.4, 1.9, 3.3, 0.9, 4.2, 0, 4.5], 0);
        b.lathe(QP.subarray(0, 10), 10);
        b.pop();
      }
      b.timeless().vanish(0.03, 0.12, M_RISE, 1.2, BY_D);
      for (let i = 0; i < 5; i++) {
        const fx = -258 + i * 3.4, fz = 104 + (i & 1) * 2.5;
        b.color(0.12, 0.08, 0.06).surface(SURF.EARTH).ao(0.9);
        b.push(); b.translate(fx, 0, fz); b.cylinder(0.8, 0.9, 8, true); b.pop();
        b.color(1.0, 0.45, 0.14).emissive(0.55, FLICKER.LIGHT0).surface(SURF.PLAIN);
        b.box(fx, 0.95, fz, 0.42, 0.05, 0.42);
        b.emissive(0, 0);
      }
      b.timeless().vanish(0.02, 0.08, M_RISE, 2, BY_D);
      crowdMat(b);
      for (let i = 0; i < 16; i++) {
        const px = -284 + b.rand() * 70, pz = 92 + (b.rand() > 0.5 ? 0 : 39) + (b.rand() - 0.5) * 3;
        figure(b, px, 0.02, pz, b.rand() * 6.28, b.rand() > 0.5 ? 2 : 0, 1.6 + 0.12 * b.rand(), rs + 400 + i);
      }
      b.timeless();
      b.glow(-252, 105, 20, sand);
    }
    yield;

    // ---- quarry: a cut limestone ridge to the south of the pyramid
    {
      b.timeless();
      b.surface(SURF.STONE).ao(0.95);
      col3(b, [lerp(0.46, br[0], 0.25), lerp(0.4, br[1], 0.25), lerp(0.3, br[2], 0.25)], 1);
      for (let i = 0; i < 4; i++) {
        b.push(); b.translate(QY_X - 60 + i * 38 + (hsh(i, 7, 1) - 0.5) * 8, -2.5, QY_Z - 14 + (hsh(i, 8, 1) - 0.5) * 6);
        b.rotateY(0.3 * (hsh(i, 9, 1) - 0.5));
        b.rock(22, 8, 13, 5, 0.18, seed * 13 + i, 4, 0.55); b.pop();
      }
      col3(b, [0.52, 0.46, 0.35], 1);
      for (let i = 0; i < 5; i++) {
        const qx = QY_X - 52 + i * 26;
        // cut faces deepen as stone is taken out
        b.timeless().appear(0.05 + 0.12 * i, 0.25 + 0.12 * i, M_RISE, 1.8, BY_B);
        b.box(qx, 1.5, QY_Z + 2, 11, 1.8, 4.5, false);
        b.box(qx, 3.0, QY_Z - 4, 11, 3.3, 3.5, false);
      }
      works(b, 0, T_CLEAR);
      stack(b, QY_X + 20, QY_Z + 16, 0.1, 2, 4, 2, rs + 11, BLOCK, 0.2);
      works(b, 0, T_CLEAR, 2);
      crowdMat(b);
      for (let i = 0; i < 14; i++) figure(b, QY_X - 55 + b.rand() * 110, 0.04, QY_Z + 9 + b.rand() * 5, b.rand() * 6.28, b.rand() > 0.6 ? 2 : 0, 1.62, rs + 500 + i);
    }
    yield;

    // ---- everything aligned to the pyramid
    b.push(); b.translate(PX, 0, PZ); b.rotateY(PSI);
    LTOP.fill(0);
    {
      // core: tan local limestone with irregular block ends, rising lift by lift
      b.timeless().pivot(0, 0, 0).reach(H).appear(0.02, T_CORE + 0.02, M_CLIP, 0, BY_B); // inner fill
      b.surface(SURF.STONE).ao(0.9);
      stepped(b, {
        a: A, h: H, top: H, inset: -BOSS, seed: seed + 1, course: 1.5,
        seg: 17, corner: 3, rough: 0.16, erode: 0, cornerErode: 0, notch: 0,
        rc: coreR, tc: CORE_T, cv: 0.05, cb: 0.12, deep: 0.08, jit: 0.9, grad: 0.3,
        tag: (bb, y1) => {
          const j = liftOf(y1);
          if (y1 > LTOP[j]) LTOP[j] = y1;
          bb.timeless().pivot(0, j * H / NL, 0).reach(H / NL).appear(j * DT, j * DT + RISEF * DT, M_CLIP, 0, BY_B);
        },
      });
      yield;

      // the dressed casing: smooth polished Tura limestone with a broad sun sheen, dressed
      // from the capstone down; stripped top-down in the decay. Shading normals are steepened
      // and turned a little (nyaw) so the two faces seen from the road separate clearly
      // without the sun shadow it lacks at distance; a faint self-light stands in for the
      // warm bounce off the desert.
      const yCap = H - 7.5;
      b.surface(SURF.POLISH).ao(0.55).emissive(0, 0);
      casing(b, {
        a: A + BOSS + 0.25, h: (A + BOSS + 0.25) * T, yCap, yLow: 0, M: 16, R: 80, dc: 0, thick: 2.0, steep: 1.45, nyaw: 0.3, split: 0.16,
        blk: 9, nB: 5, sd: seed,
        cutCol: [TURA[0] * 0.92, TURA[1] * 0.9, TURA[2] * 0.86],
        colFn: (x, y, z) => {
          const n = fbm3(x * 0.018 + 3.1, y * 0.03, z * 0.018, 3);
          // baked AO toward the foot, a touch brighter toward the polished apex
          // and toward the arrises (the dished face is shallowest there)
          const ed = A * (1 - y / H) - Math.min(Math.abs(x), Math.abs(z));
          const f = (0.84 + 0.05 * n + 0.26 * Math.pow(y / H, 0.8)) * (0.8 + 0.2 * sstep(0, 18, y)) * (0.9 + 0.1 * sstep(0, 25, ed))
            * (0.96 + 0.04 * Math.cos(y * 4.2)); // faint course lines
          // sand blown against the foot: a sandier, apricot tint fading out by ~30 m
          const sd = 1 - sstep(0, 30, y);
          CC[0] = lerp(TURA[0], SAND[0], sd * 0.55) * f; CC[1] = lerp(TURA[1], SAND[1], sd * 0.55) * f; CC[2] = lerp(TURA[2], SAND[2], sd * 0.55) * f;
        },
        rowTag: (bb, ya, yb) => {
          const ym = (ya + yb) * 0.5, td = dressT(ym);
          // stripped in the decay: quarried from the foot upward (the reachable stones go
          // first, as at Khafre, whose top casing survives), in ragged bands
          const ds = 0.44 + 0.4 * Math.pow(ym / yCap, 0.85) + 0.1 * hsh(ym * 10 | 0, 3, 91);
          // each band slides down into place from just above it, apex first (the reverse of
          // the decay's top-down stripping)
          bb.timeless().pivot(0, 0, 0).appear(td, td + 0.014, M_DROP, 5, BY_B).vanish(ds, ds + 0.03, M_SCALE, 0, BY_D);
          bb.ao(0.5 + 0.5 * sstep(0, 22, ym));
        },
      }, null);
      b.emissive(0, 0);
      // gilded capstone (electrum): set at 0.86, lowered from above; the first thing robbed
      b.timeless().appear(T_DRESS0 - 0.006, T_DRESS0 + 0.004, M_DROP, 6, BY_B).vanish(0.05, 0.1, M_DROP, 0, BY_D);
      b.color(GOLD[0], GOLD[1], GOLD[2]).surface(SURF.GILT).ao(1);
      b.push(); b.translate(0, yCap, 0);
      const w = (A + BOSS + 0.25) * (1 - yCap / H);
      b.block(w + 0.06, w + 0.06, 0.02, 0.02, H - yCap);
      b.pop();
    }
    yield;

    // rubble and sand skirt round the base: builds up as the casing is stripped
    {
      b.timeless().appear(0.45, 0.95, M_RISE, 4.2, BY_D);
      b.surface(SURF.EARTH).ao(1);
      const hFn = (xc, zc) => {
        const sq = Math.max(Math.abs(xc), Math.abs(zc));
        const f = sstep(A + 22, A - 4, sq);
        const n = fbm3(xc * 0.03 + 9, 0, zc * 0.03, 3);
        const cor = 1 + 0.8 * sstep(A * 0.7, A, Math.min(Math.abs(xc), Math.abs(zc)));
        const g = 0.85 + 0.25 * noise3(xc * 0.15, 2, zc * 0.15);
        b.color(lerp(0.5, sand[0], 0.4) * g, lerp(0.39, sand[1], 0.4) * g, lerp(0.26, sand[2], 0.4) * g);
        return 0.07 + f * (0.8 + 3.2 * n * n) * cor;
      };
      for (let s = 0; s < 4; s++) {
        const nT = 30, nO = 8, o0 = A - 6, o1 = A + 24;
        for (let i = 0; i < nT; i++) for (let j = 0; j < nO; j++) {
          const t0 = i / nT, t1 = (i + 1) / nT, oa = o0 + (o1 - o0) * j / nO, ob = o0 + (o1 - o0) * (j + 1) / nO;
          setQ(0, sx(s, t0, oa), 0, sz(s, t0, oa)); setQ(1, sx(s, t1, oa), 0, sz(s, t1, oa));
          setQ(2, sx(s, t1, ob), 0, sz(s, t1, ob)); setQ(3, sx(s, t0, ob), 0, sz(s, t0, ob));
          for (let v = 0; v < 4; v++) QP[v * 3 + 1] = hFn(QP[v * 3], QP[v * 3 + 2]);
          qac(b, 0, 1, 0, (px, py, pz) => { hFn(px, pz); });
        }
      }
      b.surface(SURF.STONE);
      for (let i = 0; i < 160; i++) {
        const s = i & 3, t = 0.03 + 0.94 * hsh(i, 1, seed), o = A + 0.5 + 18 * hsh(i, 2, seed) ** 1.6;
        const x = sx(s, t, o), z = sz(s, t, o), g = 0.85 + 0.25 * hsh(i, 3, seed), cas = hsh(i, 6, seed) < 0.35;
        const gy = hFn(x, z);
        if (cas) b.color(0.5 * g, 0.45 * g, 0.36 * g); else b.color(0.42 * g, 0.32 * g, 0.21 * g);
        b.ao(0.85);
        const r = 0.6 + 1.1 * hsh(i, 5, seed) ** 1.5;
        const td = 0.5 + 0.45 * hsh(i, 11, seed);
        b.timeless().appear(td, td + 0.04, M_RISE, 2.5, BY_D);
        b.push(); b.at(x, gy + r * 0.15, z, hsh(i, 4, seed) * 3);
        b.rotateX((hsh(i, 7, seed) - 0.5) * 0.7); b.rotateZ((hsh(i, 8, seed) - 0.5) * 0.7);
        b.box(0, 0, 0, r * (1 + 0.6 * hsh(i, 9, seed)), r * 0.65, r * (0.7 + 0.5 * hsh(i, 10, seed)), false);
        b.pop();
      }
    }

    // ---- finished complex: court, enclosure wall, mortuary temple, queens' pyramids
    {
      complex(b, 0.74, 0.8, 0.2, 0, 0.4, 0.8);
      b.surface(SURF.PLASTER).ao(1);
      col3(b, lime, 1.04);
      for (let s = 0; s < 4; s++) {
        const o0 = A - 1, o1 = A + 10.2;
        setQ(0, sx(s, 0, o0), 0.08, sz(s, 0, o0)); setQ(1, sx(s, 1, o0), 0.08, sz(s, 1, o0));
        setQ(2, sx(s, 1, o1), 0.08, sz(s, 1, o1)); setQ(3, sx(s, 0, o1), 0.08, sz(s, 0, o1));
        qa(b, 0, 1, 0);
      }
      // enclosure wall: built outward from the temple gate along its length, block by block
      // (each block rises in its own short window as the work front passes, 0.6-0.93)
      const wh = 6.5;
      b.surface(SURF.PLASTER).ao(0.85);
      const ew = A + 11.7, per = 8 * ew;
      WT[0] = 0.3; WT[1] = 0.9; WT[2] = wh + 0.5;
      WT[3] = 0; wallRun(b, -ew, 26, -ew, ew - 1.5, 3, wh, lime, 4, 0, true);
      WT[3] = 0; wallRun(b, -ew, -26, -ew, -ew + 1.5, 3, wh, lime, 5, 0, true);
      WT[3] = (ew - 26) / per; wallRun(b, -ew - 1.5, ew, ew + 1.5, ew, 3, wh, lime, 1, 0, true);
      WT[3] = (ew - 26) / per; wallRun(b, -ew - 1.5, -ew, ew + 1.5, -ew, 3, wh, lime, 2, 0, true);
      WT[3] = (ew - 26 + 2 * ew) / per; wallRun(b, ew, -ew + 1.5, ew, 0, 3, wh, lime, 3, 0, true);
      WT[3] = (ew - 26 + 2 * ew) / per; wallRun(b, ew, ew - 1.5, ew, 0, 3, wh, lime, 6, 0, true);
      const mh = 7.5;
      complex(b, 0.38, 0.45, 0.9, 0, 0.3, 0.85);
      b.surface(SURF.STONE).ao(1);
      b.heightfield(-158, -24, -124, 24, 12, 16, (x, z) => {
        const g = 0.92 + 0.16 * noise3(x * 0.45, 2.2, z * 0.45);
        b.color(0.19 * g, 0.19 * g, 0.195 * g);
        return 0.22;
      });
      complex(b, 0.4, 0.86, mh * 1.25, 0, 0.2, 0.85);
      b.surface(SURF.PLASTER).ao(0.85);
      wallRun(b, -160.6, 25.5, -117.4, 25.5, 3.2, mh, lime, 6, 0);
      wallRun(b, -160.6, -25.5, -117.4, -25.5, 3.2, mh, lime, 7, 0);
      wallRun(b, -159, -23.9, -159, -3.5, 3.2, mh, lime, 8, 0);
      wallRun(b, -159, 3.5, -159, 23.9, 3.2, mh, lime, 9, 0);
      col3(b, lime, 0.97);
      b.push(); b.translate(-122, -0.1, 0); b.block(4.5, 23.9, 3.6, 23, mh * 1.2); b.pop();
      const rh = mh * 0.78;
      b.color(0.3, 0.13, 0.1).surface(SURF.STONE).ao(0.9);
      for (let i = 0; i < 7; i++) {
        b.box(-152, rh * 0.5, -18 + i * 6, 0.55, rh * 0.5, 0.55, false);
        b.box(-145 + i * 3.6, rh * 0.5, 17.6, 0.55, rh * 0.5, 0.55, false);
        b.box(-145 + i * 3.6, rh * 0.5, -17.6, 0.55, rh * 0.5, 0.55, false);
      }
      col3(b, lime, 1.02); b.surface(SURF.PLASTER).ao(0.6);
      b.box(-155, rh + 0.35, 0, 3.4, 0.35, 23.9);
      b.box(-136.7, rh + 0.35, 20.75, 14.9, 0.35, 3.15);
      b.box(-136.7, rh + 0.35, -20.75, 14.9, 0.35, 3.15);
      // queens' pyramids (G1-a, b, c) east of the Great Pyramid: each rises in turn
      for (let q = 0; q < 3; q++) {
        const qa2 = 23.0, qh = 30.0, qx = -200, qz = -42 - q * 50;
        b.push(); b.translate(qx, 0, qz);
        // each rises in courses a little behind the main core, then is cased apex-down
        const t0 = 0.06 + 0.2 * q, tc = t0 + 0.34;
        b.timeless().pivot(0, 0, 0).reach(qh).appear(t0, tc, M_CLIP, 0, BY_B);
        b.surface(SURF.STONE).ao(0.92);
        stepped(b, {
          a: qa2, h: qh, top: qh, inset: 1.0, seed: seed + 10 + q, course: 1.7,
          seg: 12, corner: 2.5, rough: 0.12, erode: 0, cornerErode: 0, notch: 0,
          rc: coreR, tc: CORE_T, cv: 0.06, cb: 0.1, deep: 0.05, jit: 0.8, grad: 0.3,
        });
        const QM = 6;
        b.surface(SURF.POLISH).ao(0.55).emissive(0.01, FLICKER.NONE);
        casing(b, {
          a: qa2, h: qh, yCap: qh - 0.05, yLow: 0, M: QM, R: 20, dc: 0, thick: 1.3, steep: 1.45, nyaw: 0.3, sd: seed + q,
          cutCol: [TURA[0] * 0.9, TURA[1] * 0.88, TURA[2] * 0.85],
          colFn: (x, y, z) => { const f = (0.95 + 0.08 * noise3(x * 0.1 + q * 5, y * 0.1, z * 0.1) + 0.05 * y / qh) * (0.82 + 0.18 * sstep(0, 6, y)); CC[0] = TURA[0] * f; CC[1] = TURA[1] * f; CC[2] = TURA[2] * f; },
          rowTag: (bb, ya, yb) => {
            const ym = (ya + yb) * 0.5, ds = 0.46 + 0.38 * (ym / qh) + 0.1 * hsh(q, ym * 10 | 0, 92);
            const td = tc + 0.1 * (1 - ym / qh);
            bb.timeless().pivot(0, 0, 0).appear(td, td + 0.012, M_DROP, 2, BY_B).vanish(ds, ds + 0.03, M_SCALE, 0, BY_D);
          },
        }, null);
        b.emissive(0, 0);
        complex(b, tc - 0.08, tc + 0.04, 3.3, 0, 0.15, 0.5);
        col3(b, lime, 0.97); b.surface(SURF.PLASTER).ao(0.85);
        b.box(-qa2 - 5, 1.6, 0, 3.5, 1.6, 5, false);
        b.pop();
      }
    }
    yield;

    // ---- construction works: ramp, crews, block stacks on each lift's working top
    {
      // the ramp climbs with the core (same CLIP plane) and is cleared top-down while the
      // casing is dressed
      b.timeless().pivot(0, 0, 0).reach(H).appear(0.0, T_CORE, M_CLIP, 0, BY_B).vanish(T_DRESS0, T_DRESS1 + 0.005, M_CLIP, 0, BY_B);
      b.surface(SURF.EARTH).ao(0.9);
      ramp(b, H, [0.3, 0.235, 0.165]);
      // teams climbing the ramp, spaced along it: each joins once the ramp reaches it
      const nT = Math.min(9, Math.max(1, (RN / 6) | 0));
      for (let i = 0; i < nT; i++) {
        const k = Math.min(RN - 2, 2 + ((i + 0.5) * (RN - 3) / nT) | 0);
        const s = RS[k * 4] | 0, u = RS[k * 4 + 1], y = RS[k * 4 + 2], dr = RS[k * 4 + 3];
        if (Math.abs(u + dr * 14) > dOf(y) - 6 || y < 0.5) continue;
        const ty = T_CORE * (y + 2) / H, tv = Math.min(T_CLEAR, dressT(y) - 0.004);
        b.timeless().appear(ty, ty + 0.01, M_RISE, 2.2, BY_B).vanish(tv, tv + 0.01, M_RISE, 2.2, BY_B);
        rP(s, u, dOf(y) + RAMP_W * 0.5 + (hsh(i, 1, rs) - 0.5) * 3);
        team(b, QX, y + 0.04, QZ, Math.atan2(FT[s * 2] * dr, FT[s * 2 + 1] * dr), 10 + 2 * ((hsh(i, 2, rs) * 2) | 0), RAMP_G, false, rs + i * 13, i & 1 ? TURA_F : BLOCK);
      }
      // working tops: on each lift's top while it pauses, block stacks, shear-legs and crews;
      // shown when the lift has risen, swallowed by the next lift
      for (let j = 0; j < NL - 1; j++) {
        const topY = LTOP[j];
        if (topY < 2 || topY > H - 10) continue;
        const tA = j * DT + RISEF * DT, tB = (j + 1) * DT + 0.25 * RISEF * DT;
        b.timeless().appear(tA - 0.004, tA + 0.006, M_RISE, 1.4, BY_B).vanish(tB, tB + 0.004, M_POP, 0, BY_B);
        const dP = A * (1 - topY / H) + BOSS;
        b.surface(SURF.STONE).ao(0.9);
        const nB = Math.min(16, (dP * dP / 120) | 0);
        for (let i = 0; i < nB; i++) {
          const bx = (b.rand() * 2 - 1) * (dP - 3), bz = (b.rand() * 2 - 1) * (dP - 3);
          const f = 0.85 + 0.25 * b.rand();
          b.color(BLOCK[0] * f, BLOCK[1] * f, BLOCK[2] * f);
          b.push(); b.at(bx, topY - 0.05, bz, (b.rand() - 0.5) * 0.3); b.box(0, 0.55, 0, 0.8 + 0.3 * b.rand(), 0.55, 1.2, false); b.pop();
        }
        crowdMat(b);
        const nF = Math.min(6, (dP * dP / 300) | 0);
        for (let i = 0; i < nF; i++) {
          const fx = (b.rand() * 2 - 1) * (dP - 2), fz = (b.rand() * 2 - 1) * (dP - 2);
          figure(b, fx, topY - 0.05, fz, b.rand() * 6.28, b.rand() > 0.5 ? 1 : 0, 1.62, rs + 600 + j * 40 + i);
        }
        for (let s = 0; s < 4; s++) {
          const yaw = Math.atan2(FN[s * 2], FN[s * 2 + 1]);
          for (let u = -dP + 6; u < dP - 6; u += 24 + 10 * hsh(s, (u | 0) + j * 7, rs + 5)) {
            const kind = hsh(s * 131 + (u | 0), 3 + j, rs), o = dP - 2.2 - 1.5 * hsh(s, u | 0, rs + 6);
            rP(s, u, o);
            b.push(); b.at(QX, topY - 0.05, QZ, yaw);
            if (kind < 0.5) {
              b.surface(SURF.STONE).ao(0.9);
              const L = 2 + ((hsh(s, u | 0, rs + 7) * 2) | 0);
              for (let l = 0; l < L; l++) for (let jj = 0; jj < 2; jj++) {
                if (l === L - 1 && hsh(l, jj + (u | 0), rs + 8) < 0.4) continue;
                const c = (l + jj + s) & 1 ? TURA_F : BLOCK, f = 0.9 + 0.15 * hsh(l * 3 + jj, u | 0, rs + 9);
                b.color(c[0] * f, c[1] * f, c[2] * f);
                b.box((jj - 0.5) * 2.7 + (hsh(l, jj, u | 0) - 0.5) * 0.3, 0.6 + l * 1.2, 0, 1.25, 0.6, 0.8, l > 0);
              }
            } else if (kind < 0.7) {
              b.color(0.2, 0.135, 0.075).surface(SURF.WOOD).ao(0.95);
              const hh = 6 + 2 * hsh(s, u | 0, rs + 10);
              b.beam(-1.8, 0, -0.6, 0, hh, 0.4, 0.13, 0.09, 4, false);
              b.beam(1.8, 0, -0.6, 0, hh, 0.4, 0.13, 0.09, 4, false);
              b.color(0.3, 0.24, 0.15).surface(SURF.PLAIN);
              b.beam(0, hh, 0.4, 0, 1.4, 1.2, 0.03, 0.03, 4, false);
              b.color(BLOCK[0], BLOCK[1], BLOCK[2]).surface(SURF.STONE).ao(0.9);
              b.box(0, 0.6, 1.4, 1.1, 0.6, 0.75, false);
            } else {
              crowdMat(b);
              const n = 3 + ((hsh(s, u | 0, rs + 11) * 3) | 0);
              for (let i = 0; i < n; i++) figure(b, (i - n * 0.5) * 1.1, 0, (hsh(i, u | 0, rs + 12) - 0.5) * 1.4, hsh(i, s, rs + 13) * 6.28, i & 1 ? 1 : 0, 1.62, rs + 1000 + s * 50 + i + (u | 0));
            }
            b.pop();
          }
        }
      }
    }
    b.pop(); // C frame
    yield;

    // ---- construction: sledge tracks with sleepers, stack yards and hauling crews
    {
      const fx = FOOT_X, fz = FOOT_Z;
      const hx = HB_X + 24, hz = HB_Z - 4, qx = QY_X + 4, qz = QY_Z + 14;
      works(b, 0, T_CLEAR, 0.3);
      b.surface(SURF.EARTH).ao(1);
      b.color(0.27, 0.21, 0.145);
      strip(b, hx, hz, fx, fz, 5, 0.07);
      b.color(0.28, 0.22, 0.15);
      strip(b, qx, qz, fx, fz, 5, 0.075);
      b.push(); b.translate(fx, 0, fz); b.color(0.27, 0.21, 0.145); b.disc(6, 12, 1, () => 0.08); b.pop();
      b.surface(SURF.WOOD).ao(0.95);
      sleepers(b, hx, hz, fx, fz, 4.4, 2.2, 0.07);
      sleepers(b, qx, qz, fx, fz, 4.4, 2.2, 0.075);
      // stack yards: blocks are used up over the works
      stack(b, fx - 14 * CP + 22 * SP, fz + 14 * SP + 22 * CP, PSI, 3, 5, 2, rs + 21, BLOCK, 0.15);
      stack(b, hx + 8, hz - 16, 0, 3, 3, 2, rs + 22, TURA_F, 0.35);
      stack(b, qx - 22, qz + 10, 0.2, 2, 3, 3, rs + 23, BLOCK, 0.1);
      // crews on the tracks, all heading for the ramp foot
      works(b, 0, T_CLEAR - 0.02, 2);
      for (let i = 0; i < 3; i++) {
        const t = 0.18 + i * 0.27, x = lerp(hx, fx, t), z = lerp(hz, fz, t);
        team(b, x, 0.08, z, Math.atan2(fx - hx, fz - hz), 14, 0, false, rs + 100 + i, TURA_F);
      }
      for (let i = 0; i < 2; i++) {
        const t = 0.25 + i * 0.35, x = lerp(qx, fx, t), z = lerp(qz, fz, t);
        team(b, x, 0.08, z, Math.atan2(fx - qx, fz - qz), 16, 0, false, rs + 140 + i, BLOCK);
      }
      // the crew nearest the close-up camera, in full figures, starting up the ramp
      {
        const u = -0.55 * A + 3, y = 3 * RAMP_G;
        rP(0, u, dOf(y) + RAMP_W * 0.55);
        team(b, wX(QX, QZ), y + 0.04, wZ(QX, QZ), PSI, 16, RAMP_G, true, rs + 160, BLOCK);
      }
      crowdMat(b);
      for (let i = 0; i < 22; i++) {
        const nearQ = i < 10;
        const px = nearQ ? HB_X + 22 + b.rand() * 8 : fx - 30 + b.rand() * 26, pz = nearQ ? HB_Z - 10 + b.rand() * 20 : fz + 4 + b.rand() * 26;
        figure(b, px, 0.06, pz, b.rand() * 6.28, b.rand() > 0.5 ? 2 : 0, 1.6 + 0.1 * b.rand(), rs + 700 + i);
      }
    }

    // ---- causeway and valley temple (finished complex)
    {
      const ch = 6.0;
      const mx = wX(-160.5, 0), mz = wZ(-160.5, 0);
      const vx = VT_X + 15 * CP, vz = VT_Z - 15 * SP;
      // causeway: laid from the valley temple up toward the pyramid, segment by segment
      b.surface(SURF.PLASTER).ao(0.85);
      const NSEG = 14;
      for (let k = 0; k < NSEG * 2; k++) {
        const second = k >= NSEG, j = second ? k - NSEG : k, ta = 0.15 + 0.65 * k / (NSEG * 2);
        complex(b, ta, ta + 0.1, ch + 0.6, 0, 0.2 + 0.3 * hsh(k, 3, 9), 0.88);
        const x0 = second ? CW_X - 4.5 * CP : vx, z0 = second ? CW_Z + 4.5 * SP : vz, x1 = second ? mx : CW_X, z1 = second ? mz : CW_Z;
        const ax = lerp(x0, x1, j / NSEG), az = lerp(z0, z1, j / NSEG), bx = lerp(x0, x1, (j + 1) / NSEG), bz = lerp(z0, z1, (j + 1) / NSEG);
        col3(b, lime, 1);
        wallLine(b, ax, az, bx, bz, 9, -0.1, ch, 7);
        col3(b, lime, 1.07);
        wallLine(b, ax, az, bx, bz, 7, ch - 0.1, 0.5, 6.4);
      }
      const vh = 7.5;
      complex(b, 0.12, 0.5, vh + 3.2, 0, 0.18, 0.82);
      b.push(); b.translate(VT_X, -0.1, VT_Z); b.rotateY(PSI);
      b.color(0.27, 0.15, 0.12).surface(SURF.STONE).ao(0.9);
      b.block(15.35, 20.35, 15.2, 20.2, 2.3);
      col3(b, lime, 0.96); b.surface(SURF.PLASTER).ao(0.85);
      b.block(15, 20, 14.2, 19.2, vh + 0.1);
      col3(b, lime, 1.06);
      b.push(); b.translate(0, vh + 0.1, 0); b.block(14.6, 19.6, 14.4, 19.4, 0.6);
      col3(b, lime, 1.0);
      b.translate(4, 0.6, 0); b.block(8, 12, 7.6, 11.6, 2.4); b.pop();
      b.color(0.27, 0.15, 0.12).surface(SURF.STONE).ao(0.9);
      b.box(-15.3, 2.8, -8, 0.15, 2.8, 2.2, false);
      b.box(-15.3, 2.8, 8, 0.15, 2.8, 2.2, false);
      b.color(0.025, 0.022, 0.02).ao(0.2);
      b.box(-15.48, 2.4, -8, 0.05, 2.4, 1.4, false);
      b.box(-15.48, 2.4, 8, 0.05, 2.4, 1.4, false);
      b.ao(1);
      b.pop();
      // a procession of priests up the causeway's foot once it is finished
      b.timeless().appear(0.975, 0.995, M_RISE, 2, BY_B).vanish(0.02, 0.08, M_RISE, 2, BY_D);
      crowdMat(b);
      const yaw = Math.atan2(CW_X - vx, CW_Z - vz);
      for (let i = 0; i < 10; i++) {
        const t = 0.03 + i * 0.011;
        figure(b, lerp(vx, CW_X, t * 2.5) + 7 * Math.cos(yaw), 0.06, lerp(vz, CW_Z, t * 2.5) - 7 * Math.sin(yaw), yaw, 2, 1.62, rs + 800 + i);
      }
    }
    b.timeless();
    return b.counts();
  },
};
