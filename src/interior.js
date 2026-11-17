// First-person cockpit of the time machine: sculpted dash (leather roll and brows, walnut
// fascia, brushed black-nickel instrument panel), brass-bezel speedometer, the YEAR counter (rolling
// mechanical drums + era plate drum), a deliberately out-of-period 2010-style double-DIN head
// unit with a backlit dot-matrix LCD, a three-spoke wrapped steering wheel, the roadster
// windscreen, door tops and the bonnet ornaments. Procedural mesh in car-local space
// (x = LEFT, y up, z forward; see car.js), own shading on top of the frame's sun, sky
// ambient, shadows and atmosphere.
//
// Exports
//   initInterior()      async, load time (pipelines, mesh, font atlas, LCD texture)
//   prepareInterior()   per frame, after uploadCar() (car matrices are current)
//   setLevels(arr)      head-unit level bars: a Float32Array(8) of 0..1 band levels. Pass the
//                       music engine's live `levels` array once (it is re-read every frame) or
//                       call it every frame; both are allocation-free.
//
// Rendering
//   - Main pass: one indexed draw (opaque) + two blended glass draws (windscreen, gauge
//     glasses) in the transparent phase; drawn in both views (the chase camera sees into the
//     cockpit), but only first person runs the cockpit shadow pre-pass.
//   - Drawn first in the main pass (registered before any await), so the dash occludes the world.
//   - Cockpit shadow map: 2048^2 depth16 ortho map fitted in CAR-LOCAL space around the
//     cockpit (1.2 mm texels), so dash shadows are crisp and stay put while the car moves;
//     combined (min) with the world cascade for terrain / trees / car body. In third person
//     the interior casts into the world cascade instead.
//   - Text: the LCD uses the raw 5x7 dots (dotfont.js); printed lettering (dials, drums,
//     buttons) uses a rounded-stroke distance atlas baked from the same font at load time.
//   - Per frame the CPU writes one 576-byte uniform; the LCD texture (256x32 r8) is rewritten
//     only when its text changes (era / biome / elapsed second). Marquee and bars are shader
//     side. No per-frame allocations and no strings.
//
// Debug URL flags (all optional): hide=...interior... (or ...iglass: no glass), fakeaudio=1 (animated bars),
//   year=N (pin state.year), yearclock=1 (year/era from state.clock via the design anchors,
//   for captures before time.js exists), era=N, biome=N, sunrel=<azimuth rel. to the car
//   heading>,<elevation> (radians), icam=hu|gauges|wheel (close-up cameras).

import { gpu, addDrawable, addPrePass, mainPipeline, shadowPipeline, tsw } from './gpu.js';
import { MAIN_HEADER, SHADOW_HEADER } from './shaders/common.js';
import { MeshBuilder } from './mesh.js';
import { state, env, updateSun } from './state.js';
import { camera, updateCamera } from './camera.js';
import { ERA_NAMES, eraAt } from './world/time.js';
import { bodyMat, pose, partMat } from './car.js';
import {
  GLYPH_COUNT, glyphIndex, glyphRow, toGlyphs, runWidth, drawRun, drawGlyph, drawSmall, smallWidth,
} from './dotfont.js';

// ---------------------------------------------------------------------------------
// Layout (car-local metres). The driver sits at x = +0.36.

const DRIVER_X = 0.36;
const FT = 1.035; // fascia top at the centreline
const FK = 0.25; // fascia lean: z = FZ0 + (y - FT) * FK (bottom closer to the driver)
const FZ0 = 0.14;
const FB = 0.845; // fascia bottom
const fz = (y) => FZ0 + (y - FT) * FK;
const bump = (d, w) => { const t = Math.min(1, Math.abs(d) / w); return 0.5 + 0.5 * Math.cos(Math.PI * t); };
// Fascia top edge: a tall brow over the driver's instruments and a lower one on the passenger side.
const ytop = (x) => FT + 0.06 * bump(x - DRIVER_X, 0.3) + 0.022 * bump(x + 0.36, 0.24);
const FCU = 1 / Math.hypot(1, FK), FSU = FK / Math.hypot(1, FK);
const fasciaFrame = (x, y, dz = 0) => ({ o: [x, y + FSU * dz, fz(y) - FCU * dz], R: [-1, 0, 0], U: [0, FCU, FSU], N: [0, FSU, -FCU] });

const SPEEDO_X = 0.455, YEAR_X = 0.265, GAUGE_Y = 0.975;
const HU_Y = 0.95;
// Steering wheel: centre, plane tilted 30 degrees; normal points back-up at the driver.
const WHEEL = { o: [DRIVER_X, 1.005, -0.165], R: [-1, 0, 0], U: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], N: [0, Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)] };
const SCREEN_RAKE = 0.38, SCR_W = 0.56, SCR_H = 0.40, SCR_RC = 0.085;
const SCREEN = { o: [0, 1.05, 0.47], R: [-1, 0, 0], U: [0, Math.cos(SCREEN_RAKE), -Math.sin(SCREEN_RAKE)], N: [0, -Math.sin(SCREEN_RAKE), -Math.cos(SCREEN_RAKE)] };

// LCD: 140 x 35 dots at 0.92 mm (row layout: see lcdState in the shader).
const LCD_W = 140, LCD_H = 35, LCD_PITCH = 0.00092;
const LCD_TEX_W = 256, LCD_TEX_H = 32;
const LCD_X = 0.015, LCD_Y = 0.0105; // LCD centre on the head-unit face

// Year counter drums.
const DRUM_R = 0.034, DRUM_W = 0.0155, DRUM_GAP = 0.001, PLATE_W = 0.024, DIGIT_H = 0.016, DRUM_WH = 0.0215;

// Material ids (WGSL switch in fs()).
const M = {
  LEATHER: 0, WOOD: 1, TURNED: 2, BRASS: 3, COPPER: 4, PAINT: 5, PIANO: 6, BUTTON: 7, ALU: 8,
  SPEEDO: 9, YEARFACE: 10, DRUM: 11, PLATE: 12, LCD: 13, RIM: 14, MATTE: 15, NEEDLE: 16,
  DOOR: 17, KNOB: 18, SLOT: 19, WGLASS: 20, GGLASS: 21, PORT: 22, GLOW: 23, STRAP: 24, PRINT: 25,
  SPOKE: 26, EMBLEM: 27, CARPET: 28,
};

// Printed labels (monospace in the stroke atlas). Index = decal id for BUTTON / PRINT.
const LABELS = ['SRC', '1', '2', '3', '4', '5', '6', 'DISP', 'VOL', 'CD · MP3 · USB · AUX', 'km/h', 'YEAR', 'YEARS', 'AGO', 'BCE', 'CE'];
const L_VOL = 8, L_BOTTOM = 9, L_KMH = 10, L_YEAR = 11, L_YEARS = 12, L_AGO = 13, L_BCE = 14, L_CE = 15;

// ---------------------------------------------------------------------------------
// Mesh builder with uv, part, decal and AO per vertex. Vertex: pos f32x3, nrm f32x3,
// uv f32x2, ids u8x4 (material, part, decal, ao) = 36 bytes.

const VLAYOUT = [{
  arrayStride: 36,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
    { shaderLocation: 3, offset: 32, format: 'uint8x4' },
  ],
}];

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class IB extends MeshBuilder {
  constructor() { super(); this.part = 0; this.dec = 0; this.ao = 255; this.uvf = null; this.cu = 0; this.cv = 0; }
  get count() { return this.v.length / 12; }
  set(mat, { part = 0, dec = 0, ao = 1, uvf = null } = {}) { this.mat = mat; this.part = part; this.dec = dec; this.ao = Math.round(ao * 255); this.uvf = uvf; return this; }
  vert(p, n) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], this.cu, this.cv, this.mat, this.part, this.dec, this.ao); return this.count - 1; }
  surface(nu, nv, f, { flip = false, closeU = false } = {}) {
    const base = this.count, e = 1e-3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        const p = f(u, v);
        const u0 = Math.max(0, u - e), u1 = Math.min(1, u + e), v0 = Math.max(0, v - e), v1 = Math.min(1, v + e);
        let pu0 = f(u0, v), pu1 = f(u1, v);
        if (closeU && (u === 0 || u === 1)) { pu0 = f(1 - e, v); pu1 = f(e, v); }
        let du = vsub(pu1, pu0);
        const dv = vsub(f(u, v1), f(u, v0));
        if (vlen(du) < 1e-7) { const vv = v > 0.5 ? v - 0.02 : v + 0.02; du = vsub(f(u1, vv), f(u0, vv)); }
        let n = vnorm(vcross(du, dv));
        if (flip) n = [-n[0], -n[1], -n[2]];
        if (this.uvf) { const t = this.uvf(p, u, v); this.cu = t[0]; this.cv = t[1]; } else { this.cu = u; this.cv = v; }
        this.vert(this.xf(p), this.xn(n));
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        if (flip) this.i.push(a, c, b, b, c, d); else this.i.push(a, b, c, b, d, c);
      }
    }
    return this;
  }
  // Flat rectangle w x h centred at the origin, normal +z.
  rect(w, h, nu = 1, nv = 1) { return this.surface(nu, nv, (u, v) => [(u - 0.5) * w, (v - 0.5) * h, 0]); }
  // Disc (optionally domed) of radius r at z, normal +z.
  disc(r, z, nu = 48, nr = 6, dome = 0) {
    return this.surface(nu, nr, (u, v) => { const a = u * Math.PI * 2; return [Math.cos(a) * r * v, Math.sin(a) * r * v, z + dome * (1 - v * v)]; }, { closeU: true, flip: true });
  }
  // Surface of revolution about local z: prof(v) -> [radius, z]. Normal outward/up for a
  // profile running from the axis-side lip outward (flip chooses).
  revZ(prof, nu, nv, flip = true) {
    return this.surface(nu, nv, (u, v) => { const a = u * Math.PI * 2; const [r, z] = prof(v); return [Math.cos(a) * r, Math.sin(a) * r, z]; }, { closeU: true, flip });
  }
  // Tube along path(t) with a fixed reference direction (no twist), radius(t).
  tubeRef(path, radius, ref, nu = 10, nv = 24, flip = false) {
    return this.surface(nu, nv, (u, t) => {
      const p = path(t);
      const tg = vnorm(vsub(path(Math.min(1, t + 0.002)), path(Math.max(0, t - 0.002))));
      const b1 = vnorm(vcross(tg, ref)), b2 = vcross(tg, b1);
      const a = u * Math.PI * 2, r = radius(t);
      return [p[0] + (b1[0] * Math.cos(a) + b2[0] * Math.sin(a)) * r, p[1] + (b1[1] * Math.cos(a) + b2[1] * Math.sin(a)) * r, p[2] + (b1[2] * Math.cos(a) + b2[2] * Math.sin(a)) * r];
    }, { closeU: true, flip });
  }
  // Re-express every vertex added since `start` from frame-local (x, y, z) to car-local.
  frameFrom(start, F) {
    const v = this.v, { o, R, U, N } = F;
    for (let k = start; k < this.count; k++) {
      const b = k * 12;
      const x = v[b], y = v[b + 1], z = v[b + 2], nx = v[b + 3], ny = v[b + 4], nz = v[b + 5];
      for (let c = 0; c < 3; c++) {
        v[b + c] = o[c] + R[c] * x + U[c] * y + N[c] * z;
        v[b + 3 + c] = R[c] * nx + U[c] * ny + N[c] * nz;
      }
    }
    return this;
  }
  pack() {
    const n = this.count;
    const buf = new ArrayBuffer(n * 36), f = new Float32Array(buf), b = new Uint8Array(buf);
    for (let k = 0; k < n; k++) {
      const s = k * 12;
      for (let c = 0; c < 8; c++) f[k * 9 + c] = this.v[s + c];
      for (let c = 0; c < 4; c++) b[k * 36 + 32 + c] = this.v[s + 8 + c];
    }
    return { vertices: new Uint8Array(buf), indices: new Uint32Array(this.i), count: n };
  }
}

// Tapered tube radius: full r with rounded ends over `end` metres of a path of length L.
const taper = (r, L, end = 0.012) => (t) => r * Math.sqrt(Math.max(0, Math.min(1, Math.min(t, 1 - t) * L / end)) * (2 - Math.min(1, Math.min(t, 1 - t) * L / end)));

// Polyline/arc path with arclength parameterisation: segs of [x, y, z] points (dense).
function arcPath(pts) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + vlen(vsub(pts[i], pts[i - 1])));
  const tot = L[L.length - 1];
  const f = (t) => {
    const s = Math.min(tot, Math.max(0, t * tot));
    let i = 1;
    while (i < L.length - 1 && L[i] < s) i++;
    const k = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
    const a = pts[i - 1], b = pts[i];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };
  f.len = tot;
  return f;
}

// Bonnet top height (car.js bonnet: superellipsoid centre (0, 0.80, 1.28), half (0.50, 0.17, 0.92), e 0.32).
function bonnetY(x, z) {
  const q = 1 - Math.pow(Math.abs(x / 0.5), 6.25) - Math.pow(Math.abs((z - 1.28) / 0.92), 6.25);
  return 0.80 + 0.17 * Math.pow(Math.max(0, q), 0.16);
}

function buildInterior() {
  const m = new IB();
  const g = new IB(); // windscreen glass
  const gg = new IB(); // gauge glasses
  let s0;

  // --- fascia (walnut), full width, leaning toward the driver at the bottom
  m.set(M.WOOD, { uvf: (p) => [p[0], p[1]] }).place();
  m.surface(72, 18, (u, v) => { const x = 0.665 - 1.33 * u; const yt = ytop(x); const y = yt + (FB - yt) * v; return [x, y, fz(y)]; }, { flip: true });

  // --- leather top roll along the fascia edge (stitched), dash top, painted cowl
  const rollPath = arcPath(Array.from({ length: 121 }, (_, k) => { const x = 0.668 - 1.336 * k / 120; const yt = ytop(x); return [x, yt + 0.006, fz(yt) - 0.008]; }));
  m.set(M.LEATHER, { dec: 1, uvf: (p, u, t) => [t * rollPath.len, u] }).place();
  m.tubeRef(rollPath, taper(0.024, rollPath.len, 0.03), [0, 0, 1], 18, 120);
  m.set(M.LEATHER, { uvf: (p) => [p[0], p[2]] }).place();
  m.surface(72, 14, (u, v) => {
    const x = 0.69 - 1.38 * u, yt = ytop(Math.max(-0.668, Math.min(0.668, x)));
    const zr = fz(yt) - 0.008;
    const z = zr + (0.44 - zr) * v;
    const sv = v * v * (3 - 2 * v);
    let y = yt + 0.028 + (1.052 - yt - 0.028) * sv;
    y -= 0.05 * Math.pow(smooth(0.6, 0.70, Math.abs(x)), 2);
    return [x, y, z];
  });
  m.set(M.PAINT).place();
  m.surface(72, 10, (u, v) => {
    const x = 0.705 - 1.41 * u, z = 0.43 + 0.30 * v;
    let y = 1.052 - 0.09 * v * v;
    y -= 0.07 * Math.pow(smooth(0.58, 0.705, Math.abs(x)), 2);
    return [x, y, z];
  });

  // --- engine-turned instrument panel behind the two dials
  s0 = m.count;
  m.set(M.TURNED, { uvf: (p) => [p[0], p[1]] }).place(0, 0, 0.0022).rbox(0.196, 0.094, 0.0022, 0.1, 48, 12);
  m.frameFrom(s0, fasciaFrame(DRIVER_X, GAUGE_Y));
  // fine brass inlay around it
  s0 = m.count;
  {
    const w = 0.199, h = 0.097, rc = 0.012, pts = [];
    const corner = (cx, cy, a0) => { for (let k = 0; k <= 8; k++) { const a = a0 + k / 8 * Math.PI / 2; pts.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc, 0.0012]); } };
    corner(w - rc, h - rc, 0); corner(-w + rc, h - rc, Math.PI / 2); corner(-w + rc, -h + rc, Math.PI); corner(w - rc, -h + rc, Math.PI * 1.5);
    pts.push(pts[0]);
    const path = arcPath(pts);
    m.set(M.BRASS).place().tubeRef(path, () => 0.0018, [0, 0, 1], 6, 160);
  }
  m.frameFrom(s0, fasciaFrame(DRIVER_X, GAUGE_Y));

  // --- the two dials
  for (const [gx, kind] of [[SPEEDO_X, 0], [YEAR_X, 1]]) {
    const F = fasciaFrame(gx, GAUGE_Y);
    s0 = m.count;
    // bezel: knurled brass ring
    m.set(M.BRASS, { dec: 1 }).place();
    m.revZ((v) => [0.0705 + 0.016 * v, (1 - v) * 0.0135 + Math.sin(Math.PI * v) * 0.0085 + 0.0045], 96, 14);
    // dial face
    if (kind === 0) m.set(M.SPEEDO, { uvf: (p) => [p[0], p[1]] }).place().disc(0.0712, 0.012, 64, 8);
    else m.set(M.YEARFACE, { uvf: (p) => [p[0], p[1]] }).place().disc(0.0712, 0.012, 64, 8);
    // back plate (closes the gauge body against the panel)
    m.set(M.MATTE).place().revZ((v) => [0.0868, 0.0045 * (1 - v)], 48, 1);
    if (kind === 0) {
      // hub cap
      // domed brass cap with a stepped collar
      m.set(M.BRASS).place(0, 0, 0.0158).revZ((v) => [0.0066 * Math.sin(v * Math.PI / 2), 0.0042 * Math.cos(v * Math.PI / 2)], 40, 10, false);
      m.place(0, 0, 0.0128).cyl(0.0082, 0.0, 0.0032, 40);
    } else {
      // drum window: black backing, drums, brass frame and separators
      const ww = 6 * (DRUM_W + DRUM_GAP) + PLATE_W + 0.004, wh = DRUM_WH;
      m.set(M.MATTE, { ao: 0.4 }).place(0, 0, 0.0052).rect(ww + 0.004, wh + 0.004);
      let x = -ww / 2 + 0.0015;
      const zc = 0.0100 - DRUM_R;
      for (let d = 0; d < 7; d++) {
        const w = d < 6 ? DRUM_W : PLATE_W;
        if (d === 6) x += 0.001;
        else if (d === 0) x += 0.0005;
        const cx = x + w / 2;
        m.set(d < 6 ? M.DRUM : M.PLATE, { dec: d, uvf: (p, u) => [(u - 0.5) * 2.4 / (Math.PI * 2), p[0] - cx] }).place();
        m.surface(28, 2, (u, v) => { const a = (u - 0.5) * 2.4; return [x + v * w, Math.sin(a) * DRUM_R, zc + Math.cos(a) * DRUM_R]; }, { flip: true });
        x += w + DRUM_GAP;
      }
      // frame (covers the cut edge of the face) and separators
      m.set(M.BRASS).place(0, wh / 2 + 0.0012, 0.0128).rbox(ww / 2 + 0.0024, 0.0016, 0.0009, 0.3, 24, 6);
      m.place(0, -wh / 2 - 0.0012, 0.0128).rbox(ww / 2 + 0.0024, 0.0016, 0.0009, 0.3, 24, 6);
      m.place(-ww / 2 - 0.0012, 0, 0.0128).rbox(0.0016, wh / 2 + 0.0024, 0.0009, 0.3, 6, 16);
      m.place(ww / 2 + 0.0012, 0, 0.0128).rbox(0.0016, wh / 2 + 0.0024, 0.0009, 0.3, 6, 16);
      const sep6 = -ww / 2 + 0.0015 + 6 * (DRUM_W + DRUM_GAP) + 0.0015 - DRUM_GAP / 2;
      m.place(sep6, 0, 0.0115).rbox(0.0007, wh / 2, 0.0007, 0.5, 4, 8);
    }
    m.frameFrom(s0, F);
    // needle (part 2), built pointing +y around the origin; the matrix carries the frame
    if (kind === 0) {
      m.set(M.NEEDLE, { part: 2 }).place();
      m.surface(10, 24, (u, v) => {
        const y = -0.0185 + v * 0.0825;
        // round counterweight (r 4.2 mm at y -0.0125) on a slim neck, then a long taper to a fine point
        const cw = Math.sqrt(Math.max(0, 0.0042 * 0.0042 - (y + 0.0125) * (y + 0.0125)));
        const w = y < 0 ? Math.max(cw, 0.0011 + 0.0007 * Math.max(0, 1 + y / 0.006)) : 0.0019 * Math.pow(1 - y / 0.064, 0.85) + 0.00025;
        const a = u * Math.PI * 2;
        return [Math.cos(a) * w, y, Math.sin(a) * 0.0007];
      }, { closeU: true, flip: true });
    }
    s0 = gg.count;
    gg.set(M.GGLASS).place().disc(0.0712, 0.0195, 48, 6, 0.0035);
    gg.frameFrom(s0, F);
  }

  // --- head unit (double-DIN, glossy black)
  {
    const F = fasciaFrame(0, HU_Y);
    s0 = m.count;
    m.set(M.MATTE, { ao: 0.5 }).place(0, 0, 0.002).rbox(0.0955, 0.0555, 0.004, 0.2, 24, 10); // recess surround
    m.set(M.PIANO).place(0, 0, 0.0075).rbox(0.0915, 0.0515, 0.0085, 0.09, 40, 16);
    // LCD (active area centred at (0.015, 0.012)), cover flush with the face
    const lw = LCD_W * LCD_PITCH, lh = LCD_H * LCD_PITCH, lx = LCD_X, ly = LCD_Y;
    m.set(M.LCD, { uvf: (p) => [(p[0] + lw / 2) / lw, (lh / 2 - p[1]) / lh] }).place(lx, ly, 0.0162).surface(1, 1, (u, v) => [(u - 0.5) * (lw + 0.006), (v - 0.5) * (lh + 0.006), 0]);
    // disc slot
    m.set(M.SLOT, { uvf: (p) => [p[0], p[1]] }).place(0.015, 0.0395, 0.0162).rect(0.122, 0.0062);
    // volume knob
    m.set(M.KNOB, { uvf: (p, u, v) => [u, v] }).place(-0.0705, 0.0115, 0.0);
    m.revZ((v) => [0.0128 - 0.0006 * v, 0.016 + 0.0145 * v], 72, 3, false);
    m.set(M.ALU, { dec: 1, uvf: (p) => [p[0], p[1]] }).place(-0.0705, 0.0115, 0.0);
    m.revZ((v) => [0.0122 * Math.cos(v * Math.PI / 2), 0.0305 + 0.0012 * Math.sin(v * Math.PI / 2)], 72, 6, false);
    m.set(M.PRINT, { dec: L_VOL, uvf: (p) => [p[0] / 0.00034, -p[1] / 0.00034] }).place(-0.0705, -0.0058, 0.0162).rect(0.012, 0.0032);
    // buttons
    for (let k = 0; k < 8; k++) {
      const cx = -0.0518 + 0.0072 + k * 0.0168;
      m.set(M.BUTTON, { dec: k, uvf: (p) => [p[0] / 0.00042, -p[1] / 0.00042] }).place(cx, -0.0262, 0.0172).rbox(0.0072, 0.0055, 0.0022, 0.28, 20, 10);
    }
    // USB and AUX
    m.set(M.PORT, { dec: 0, uvf: (p) => [p[0], p[1]] }).place(-0.0705, -0.0225, 0.0162).rect(0.0145, 0.0072);
    m.set(M.PORT, { dec: 1, uvf: (p) => [p[0], p[1]] }).place(-0.0705, -0.0375, 0.0162).rect(0.0095, 0.0095);
    m.set(M.PRINT, { dec: L_BOTTOM, uvf: (p) => [p[0] / 0.0003, -p[1] / 0.0003] }).place(0.015, -0.0425, 0.0162).rect(0.04, 0.0028);
    m.set(M.ALU).place(0.0, -0.0478, 0.0158).rbox(0.088, 0.0007, 0.0007, 0.5, 24, 4);
    // thin satin-silver trim ring just inside the faceplate edge, and a chrome lip round the LCD
    const ring = (hw, hh, rc, z, r, seg) => {
      const pts = [];
      const corner = (cx, cy, a0) => { for (let k = 0; k <= 8; k++) { const a = a0 + k / 8 * Math.PI / 2; pts.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc, z]); } };
      corner(hw - rc, hh - rc, 0); corner(-hw + rc, hh - rc, Math.PI / 2); corner(-hw + rc, -hh + rc, Math.PI); corner(hw - rc, -hh + rc, Math.PI * 1.5);
      pts.push(pts[0]);
      m.set(M.ALU).place().tubeRef(arcPath(pts), () => r, [0, 0, 1], 6, seg);
    };
    ring(0.0905, 0.0505, 0.006, 0.0163, 0.0010, 160);
    { const s1 = m.count; ring(lw / 2 + 0.0034, lh / 2 + 0.0034, 0.002, 0.0164, 0.0006, 120); for (let k = s1; k < m.count; k++) { m.v[k * 12] += lx; m.v[k * 12 + 1] += ly; } }
    m.frameFrom(s0, F);
  }

  // --- glovebox knob and grab handle on the passenger side
  s0 = m.count;
  m.set(M.BRASS).place(0, 0, 0.002).rbox(0.026, 0.0085, 0.003, 0.3, 24, 8); // escutcheon plate
  for (const sx of [-1, 1]) m.place(sx * 0.017, 0, 0.004).cyl(0.0032, 0.0, 0.009, 12);
  m.place(0, 0, 0.0125).rbox(0.021, 0.0034, 0.0032, 0.35, 20, 8); // pull bar
  m.set(M.MATTE).place(0.0, -0.0042, 0.0052).rbox(0.0016, 0.0024, 0.0005, 0.5, 8, 4); // key slot
  m.frameFrom(s0, fasciaFrame(-0.36, 0.938));
  s0 = m.count;
  {
    const path = arcPath(Array.from({ length: 41 }, (_, k) => { const t = k / 40; return [(t - 0.5) * 0.25, 0, 0.026 * Math.pow(Math.sin(Math.PI * t), 0.35)]; }));
    m.set(M.BRASS).place().tubeRef(path, taper(0.0075, path.len, 0.006), [0, 1, 0], 10, 40);
  }
  m.frameFrom(s0, fasciaFrame(-0.36, 1.005));

  // --- leather knee roll along the bottom edge of the fascia (closes it off above the footwell)
  {
    const kp = arcPath(Array.from({ length: 81 }, (_, k) => { const x = 0.655 - 1.31 * k / 80; return [x, FB - 0.004, fz(FB) - 0.012]; }));
    m.set(M.LEATHER, { dec: 1, uvf: (p, u, t) => [t * kp.len, u] }).place();
    m.tubeRef(kp, taper(0.02, kp.len, 0.02), [0, 0, 1], 14, 80);
  }
  // --- steering column and wheel
  s0 = m.count;
  // leather column shroud from the fascia to just behind the wheel boss
  m.set(M.LEATHER, { ao: 0.8 }).place().revZ((v) => [0.036 - 0.012 * v + 0.004 * Math.sin(v * Math.PI), -0.27 + 0.2 * v], 32, 8, false);
  m.set(M.MATTE).place(0, 0, -0.30).cyl(0.022, 0.0, 0.26, 16, false);
  m.set(M.BRASS).place(0, 0, -0.052).cyl(0.026, 0.0, 0.012, 24);
  m.frameFrom(s0, WHEEL);
  // wheel (part 1): rim, three spokes (9, 3, 6 o'clock), hub, horn boss
  m.set(M.RIM, { part: 1 }).place().torus(0.17, 0.0145, 128, 16);
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    m.set(M.SPOKE, { part: 1, uvf: (p) => [p[0] + 0.0875, p[1]] });
    // spoke along local +x, dished toward the hub (back, -z)
    m.place(Math.cos(a) * 0.0875, Math.sin(a) * 0.0875, -0.013, -0.0, 0, a, 1);
    const sb = m.count;
    m.surface(24, 14, (u, v) => {
      const x = (u - 0.5) * 0.16;
      const w = 0.016 - 0.005 * (u) ;
      const b = v * Math.PI * 2;
      return [x, Math.cos(b) * w, Math.sin(b) * 0.0028];
    }, { closeU: true, flip: true });
    // tilt the spoke so it rises from the hub (z -0.03) to the rim (z 0)
    for (let k = sb; k < m.count; k++) {
      const o = k * 12;
      const r = Math.hypot(m.v[o], m.v[o + 1]);
      m.v[o + 2] += -0.03 * (1 - Math.min(1, Math.max(0, (r - 0.03) / 0.135))) + 0.013;
    }
  }
  m.set(M.BRASS, { part: 1 }).place(0, 0, -0.03).revZ((v) => [0.04 - 0.008 * v * v, -0.03 * (1 - v) + 0.008 * v], 48, 6, false);
  m.set(M.EMBLEM, { part: 1, uvf: (p) => [p[0], p[1]] }).place().disc(0.032, -0.0215, 48, 6, 0.003);

  // --- carpet over the tub top (footwells and floor), tucked under the fascia and doors
  m.set(M.CARPET, { uvf: (p) => [p[0], p[2]] }).place();
  m.surface(24, 24, (u, v) => { const x = 0.645 - 1.29 * u, z = 0.22 - 1.3 * v; return [x, 0.884 + 0.004 * Math.sin(Math.PI * u), z]; });

  // --- door tops: leather coaming roll, inner panel, outer skin, brass trim
  for (const s of [1, -1]) {
    const path = arcPath(Array.from({ length: 41 }, (_, k) => { const t = k / 40; const z = 0.30 - 1.38 * t; return [s * 0.668, 1.0 - 0.02 * t + 0.01 * Math.sin(Math.PI * t), z]; }));
    m.set(M.DOOR).place().tubeRef(path, taper(0.028, path.len, 0.03), [0, 1, 0], 16, 60);
    m.set(M.DOOR, { dec: 1, uvf: (p) => [p[2], p[1]] }).place();
    m.surface(30, 6, (u, v) => [s * 0.643, 1.0 - 0.13 * v, 0.30 - 1.38 * u], { flip: s < 0 });
    m.set(M.PAINT).place();
    m.surface(30, 4, (u, v) => [s * 0.697, 0.995 - 0.13 * v, 0.30 - 1.38 * u], { flip: s > 0 });
    const trim = arcPath(Array.from({ length: 41 }, (_, k) => { const t = k / 40; const z = 0.30 - 1.38 * t; return [s * 0.699, 0.982 - 0.02 * t + 0.01 * Math.sin(Math.PI * t), z]; }));
    m.set(M.BRASS).place().tubeRef(trim, taper(0.0045, trim.len, 0.01), [0, 1, 0], 8, 60);
  }

  // --- windscreen: brass channel, frame tube (rounded top corners), stanchion brackets, glass
  {
    const W = SCR_W, H = SCR_H, rc = SCR_RC;
    const pts = [[-W, 0.0, 0]];
    for (let k = 0; k <= 12; k++) { const a = Math.PI - k / 12 * Math.PI / 2; pts.push([-W + rc + Math.cos(a) * rc, H - rc + Math.sin(a) * rc, 0]); }
    for (let k = 0; k <= 12; k++) { const a = Math.PI / 2 - k / 12 * Math.PI / 2; pts.push([W - rc + Math.cos(a) * rc, H - rc + Math.sin(a) * rc, 0]); }
    pts.push([W, 0, 0]);
    const outline = arcPath(pts);
    s0 = m.count;
    m.set(M.BRASS).place().tubeRef(outline, taper(0.0105, outline.len, 0.004), [0, 0, 1], 12, 140);
    const base = arcPath([[-W - 0.02, 0.004, 0], [W + 0.02, 0.004, 0]]);
    m.place().tubeRef(base, taper(0.013, base.len, 0.01), [0, 0, 1], 12, 40);
    for (const sx of [-1, 1]) {
      m.place(sx * W, 0.07, 0, 0, 0, 0).rbox(0.017, 0.045, 0.013, 0.35, 16, 10);
      m.place(sx * W, 0.07, 0.0, 0, 0, 0).cyl(0.006, -0.02, 0.02, 12);
    }
    m.frameFrom(s0, SCREEN);
    // glass: fan inside the outline
    s0 = g.count;
    g.set(M.WGLASS).place();
    const inset = [];
    for (let k = 0; k <= 60; k++) { const p = outline(k / 60); inset.push([p[0] * 0.995, Math.max(0.006, p[1] - 0.006 * Math.sign(p[1] - 0.2)), 0]); }
    const c = g.vert([0, H * 0.45, 0], [0, 0, 1]);
    const ring = inset.map((p) => g.vert(p, [0, 0, 1]));
    for (let k = 0; k < ring.length - 1; k++) g.i.push(c, ring[k], ring[k + 1]);
    g.i.push(c, ring[ring.length - 1], ring[0]);
    g.frameFrom(s0, SCREEN);
  }

  // --- bonnet ornaments: piano hinge, louvres, strap with buckle, radiator cap + hourglass mascot
  {
    const hinge = arcPath(Array.from({ length: 61 }, (_, k) => { const z = 0.46 + 1.66 * k / 60; return [0, bonnetY(0, z) + 0.004, z]; }));
    m.set(M.BRASS).place().tubeRef(hinge, taper(0.0065, hinge.len, 0.01), [1, 0, 0], 10, 80);
    for (const s of [1, -1]) {
      // pressed louvres: a painted hood rising from the panel at its front edge to a lip 9 mm
      // high at the back, over a dark slot that faces the driver
      for (let k = 0; k < 7; k++) {
        const z0 = 0.78 + k * 0.095, xc = s * 0.31, L = 0.15, D = 0.036, H = 0.009;
        const end = (u) => Math.pow(Math.sin(Math.PI * u), 0.45);
        const hood = (u, v) => { const x = xc + (u - 0.5) * L; const z = z0 + D / 2 - v * D; const h = H * end(u) * Math.sin(v * Math.PI / 2); return [x, bonnetY(x, z) + 0.0008 + h, z]; };
        m.set(M.PAINT).place().surface(24, 8, hood, { flip: s < 0 });
        // rounded lip along the back edge
        const lip = arcPath(Array.from({ length: 25 }, (_, q) => { const u = 0.04 + 0.92 * q / 24; return hood(u, 1); }));
        m.set(M.PAINT).place().tubeRef(lip, taper(0.0014, lip.len, 0.004), [0, 1, 0], 8, 24);
        // the slot: dark curtain from the lip down to the panel
        m.set(M.MATTE, { ao: 0.15 }).place().surface(24, 2, (u, v) => { const p = hood(u, 1); const y0 = bonnetY(p[0], p[2]); return [p[0], p[1] + (y0 - p[1]) * v, p[2] + 0.0005]; });
      }
    }
    const zs = 1.66;
    m.set(M.STRAP, { uvf: (p) => [p[0], p[2] - zs] }).place();
    m.surface(60, 2, (u, v) => { const x = -0.515 + 1.03 * u; const z = zs + (v - 0.5) * 0.04; return [x, bonnetY(x * 0.985, z) + 0.0035, z]; }, { flip: true });
    m.set(M.BRASS).place(0.24, bonnetY(0.24, zs) + 0.006, zs).rbox(0.022, 0.003, 0.026, 0.25, 12, 6);
    m.set(M.STRAP).place(0.27, bonnetY(0.27, zs) + 0.0085, zs).rbox(0.012, 0.002, 0.019, 0.4, 8, 4);
    // radiator cap and mascot (grille surround top at y 1.01, z 2.21)
    const cy = 1.012, cz = 2.205;
    m.set(M.BRASS).place(0, cy, cz, 0, -Math.PI / 2, 0).cyl(0.03, 0, 0.022, 32);
    m.place(0, cy + 0.022, cz).blob(0.03, 0.006, 0.03, 32, 8);
    const hy = cy + 0.034;
    for (const sy of [0, 1]) m.place(0, hy + sy * 0.072, cz, 0, -Math.PI / 2, 0).cyl(0.022, -0.003, 0.003, 32);
    for (let k = 0; k < 3; k++) { const a = k * Math.PI * 2 / 3 + 0.3; m.place(Math.cos(a) * 0.019, hy + 0.036, cz + Math.sin(a) * 0.019, 0, -Math.PI / 2, 0).cyl(0.0022, -0.036, 0.036, 8); }
    m.set(M.GLOW).place(0, hy + 0.036, cz).lathe((v) => { const y = (v - 0.5) * 0.066; const t = Math.abs(y) / 0.033; return [0.0025 + 0.014 * Math.pow(Math.sin(Math.min(1, t) * Math.PI * 0.62), 1.3), y]; }, 32, 16);
    for (const s of [1, -1]) {
      m.set(M.BRASS).place(0, hy + 0.05, cz - 0.004);
      m.surface(20, 6, (u, v) => {
        const span = 0.02 + 0.075 * u;
        const chord = 0.034 * (1 - 0.75 * u) * (1 + 0.15 * Math.sin(v * Math.PI * 5) * u);
        return [s * span, 0.012 * u * u + 0.004 * Math.sin(v * Math.PI), (v - 0.25) * chord - 0.02 * u * u];
      }, { flip: s < 0 });
      m.surface(20, 6, (u, v) => {
        const span = 0.02 + 0.075 * u;
        const chord = 0.034 * (1 - 0.75 * u) * (1 + 0.15 * Math.sin(v * Math.PI * 5) * u);
        return [s * span, 0.012 * u * u + 0.004 * Math.sin(v * Math.PI) - 0.0025, (v - 0.25) * chord - 0.02 * u * u];
      }, { flip: s > 0 });
    }
  }

  return { m: m.pack(), g: g.pack(), gg: gg.pack() };
}

// ---------------------------------------------------------------------------------
// Rounded-stroke distance atlas from the 5x7 font (load time). 16 x 5 cells of 7 x 9 dots
// (1-dot margin), 8 texels per dot; texel = distance to the glyph skeleton in dots / 2.

const ATLAS_TPD = 8, ATLAS_COLS = 16, ATLAS_ROWS = 5;
const ATLAS_W = ATLAS_COLS * 7 * ATLAS_TPD, ATLAS_H = ATLAS_ROWS * 9 * ATLAS_TPD;

function bakeAtlas() {
  const W = ATLAS_W, H = ATLAS_H, T = ATLAS_TPD;
  const lv = new Uint8Array(W * H).fill(255);
  for (let g = 0; g < GLYPH_COUNT; g++) {
    const lit = (c, r) => c >= 0 && c < 5 && r >= 0 && r < 7 && (glyphRow(g, r) & (16 >> c)) !== 0;
    const segs = [];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (!lit(c, r)) continue;
      const x = c + 0.5, y = r + 0.5;
      let n = 0;
      if (lit(c + 1, r)) { segs.push([x, y, x + 1, y]); n++; }
      if (lit(c, r + 1)) { segs.push([x, y, x, y + 1]); n++; }
      const full = lit(c + 1, r) && lit(c, r + 1) && lit(c + 1, r + 1);
      if (lit(c + 1, r + 1) && (full || (!lit(c + 1, r) && !lit(c, r + 1)))) { segs.push([x, y, x + 1, y + 1]); n++; }
      if (lit(c - 1, r + 1) && !lit(c - 1, r) && !lit(c, r + 1)) { segs.push([x, y, x - 1, y + 1]); n++; }
      if (full) segs.push([x + 1, y, x, y + 1]);
      if (!n && !lit(c - 1, r) && !lit(c, r - 1) && !lit(c - 1, r - 1) && !lit(c + 1, r - 1)) segs.push([x, y, x, y]);
    }
    const ox = (g % ATLAS_COLS) * 7 * T, oy = Math.floor(g / ATLAS_COLS) * 9 * T;
    for (let ty = 0; ty < 9 * T; ty++) {
      for (let tx = 0; tx < 7 * T; tx++) {
        const px = (tx + 0.5) / T - 1, py = (ty + 0.5) / T - 1;
        let d = 9;
        for (const [ax, ay, bx, by] of segs) {
          const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
          const l2 = vx * vx + vy * vy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / l2)) : 0;
          const dx = wx - vx * t, dy = wy - vy * t;
          const dd = Math.sqrt(dx * dx + dy * dy);
          if (dd < d) d = dd;
        }
        lv[(oy + ty) * W + ox + tx] = Math.min(255, Math.round(d / 2 * 255));
      }
    }
  }
  const levels = [{ w: W, h: H, data: lv }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const p = levels[levels.length - 1];
    const w = Math.max(1, p.w >> 1), h = Math.max(1, p.h >> 1);
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += p.data[Math.min(p.h - 1, y * 2 + (k >> 1)) * p.w + Math.min(p.w - 1, x * 2 + (k & 1))];
      d[y * w + x] = (s + 2) >> 2;
    }
    levels.push({ w, h, data: d });
  }
  return levels;
}

// ---------------------------------------------------------------------------------
// WGSL

function labelTables() {
  const txt = [], lbl = [];
  for (const s of LABELS) {
    const codes = toGlyphs(s);
    lbl.push(`vec2i(${txt.length}, ${codes.length})`);
    for (const c of codes) txt.push(c);
  }
  return `
var<private> TXT: array<i32, ${txt.length}> = array<i32, ${txt.length}>(${txt.join(', ')});
var<private> LBL: array<vec2i, ${lbl.length}> = array<vec2i, ${lbl.length}>(${lbl.join(', ')});
`;
}

const IU_STRUCT = /* wgsl */ `
struct IU {
  body: mat4x4f,    // car local -> world
  wheel: mat4x4f,   // part 1 (steering wheel) -> car local
  needle: mat4x4f,  // part 2 (speedometer needle) -> car local
  light: mat4x4f,   // car local -> cockpit shadow clip
  sunL: vec4f,      // sun direction in car local; w = cockpit shadow map on
  drum: array<vec4f, 2>,  // drum positions (digits, continuous), 0..5 digits (left first), 6 plate
  blur: array<vec4f, 2>,  // drum motion blur (digits)
  lcdA: vec4f,      // line-1 marquee offset, line-2 offset, line-1 period, line-2 period
  lcdB: vec4f,      // backlight, glow, -, -
  lv: array<vec4f, 2>,    // bar heights (dots)
  pk: array<vec4f, 2>,    // peak-hold heights (dots)
  misc: vec4f,      // core glow, time, debug, daylight in a passage (1 outside)
  spin: array<vec4f, 2>,  // fast drums: displayed spin position (digits), capped speed
  sw: array<vec4f, 2>,    // fast drums: weight of the spin display (0 = true position)
  clip: mat4x4f,    // car local -> clip, multiplied on the CPU in doubles: world positions far
                    // from the origin lose ~0.3 mm per vertex in f32, which z-fought the LCD
                    // against the faceplate 0.2 mm behind it
  lead: array<vec4f, 2>,  // drums showing a leading zero (0..1, eased), 0..5 left first
};
const IDENT = mat4x4f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f, @location(3) ids: vec4u };
`;

const PART_FN = /* wgsl */ `
fn partM(p: u32) -> mat4x4f {
  if (p == 1u) { return U.wheel; }
  if (p == 2u) { return U.needle; }
  return IDENT;
}
`;

const INTERIOR_WGSL = () => MAIN_HEADER + IU_STRUCT + /* wgsl */ `
@group(1) @binding(0) var<uniform> U: IU;
@group(1) @binding(1) var ishadow: texture_depth_2d;
@group(1) @binding(2) var ishSamp: sampler_comparison;
@group(1) @binding(3) var lcdTex: texture_2d<f32>;
@group(1) @binding(4) var atlas: texture_2d<f32>;
@group(1) @binding(5) var aSamp: sampler;
` + PART_FN + labelTables() + /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) lp: vec3f,
  @location(3) ln: vec3f,
  @location(4) uv: vec2f,
  @location(5) @interpolate(flat) ids: vec4u,
  @location(6) amb: vec3f,
};

@vertex fn vs(v: VIn) -> VOut {
  let M = partM(v.ids.y);
  var o: VOut;
  let lp = (M * vec4f(v.pos, 1.0)).xyz;
  let ln = (M * vec4f(v.nrm, 0.0)).xyz;
  let w = U.body * vec4f(lp, 1.0);
  o.wp = w.xyz;
  o.n = (U.body * vec4f(ln, 0.0)).xyz;
  o.lp = lp;
  o.ln = ln;
  o.uv = v.uv;
  o.ids = v.ids;
  let wn = normalize(o.n);
  // + light bounced off the ground all round the open cockpit (snow makes this strong): the
  // dash and the door cards see the sunlit land over the door tops and the bonnet.
  let gE = F.ambient.rgb * (sunIlluminance() * max(F.sunDir.y, 0.0) + skyRadiance(vec3f(0.0, 1.0, 0.0)) * PI);
  o.amb = skyAmbient(wn) + gE * 0.3 * (1.0 - 0.6 * abs(wn.y));
  o.pos = U.clip * vec4f(lp, 1.0);
  return o;
}

fn hash2(p: vec2f) -> f32 { var q = fract(p * vec2f(123.34, 456.21)); q += dot(q, q + 45.32); return fract(q.x * q.y); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var k = 0; k < 4; k++) { s += a * vnoise(q); q = q * 2.03 + vec2f(17.1, 3.7); a *= 0.5; }
  return s;
}
fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
// Filtered box mask: 1 inside [lo, hi] with AA width w.
fn band(x: f32, lo: f32, hi: f32, w: f32) -> f32 { return sat((x - lo) / w + 0.5) * sat((hi - x) / w + 0.5); }

// Ink coverage of glyph g at q (dots, y down, 5x7 box at 0..5 x 0..7), fq = dots per pixel,
// rad = stroke radius in dots.
fn glyphInk(g: i32, q: vec2f, fq: f32, rad: f32) -> f32 {
  if (g < 0 || q.x < -0.9 || q.x > 5.9 || q.y < -0.9 || q.y > 7.9) { return 0.0; }
  let cell = vec2f(f32(g % 16), f32(g / 16));
  let t = (cell * vec2f(7.0, 9.0) + q + 1.0) / vec2f(112.0, 45.0);
  let lod = log2(max(fq * 8.0, 1.0));
  let d = textureSampleLevel(atlas, aSamp, t, lod).r * 2.0;
  return sat(0.5 - (d - rad) / max(fq * 1.2, 0.03));
}
// Monospace label k centred at the origin of p (dots, y down).
fn labelInk(k: i32, p: vec2f, fq: f32, rad: f32) -> f32 {
  let L = LBL[k];
  let x = p.x + f32(L.y) * 3.0 - 0.5;
  let i = i32(floor(x / 6.0));
  if (i < 0 || i >= L.y) { return 0.0; }
  return glyphInk(TXT[L.x + i], vec2f(x - f32(i) * 6.0, p.y + 3.5), fq, rad);
}
fn pow10i(n: i32) -> i32 { return select(select(1, 10, n == 1), select(100, 1000, n == 3), n >= 2); }

// --- cockpit shadow (car-local ortho map), 2x2 bilinear PCF
fn shadowInt(lp: vec3f, nl: vec3f) -> f32 {
  if (U.sunL.w < 0.5) { return 1.0; }
  let ndl = dot(nl, U.sunL.xyz);
  let p = U.light * vec4f(lp + nl * 0.0018 * (1.0 + 2.0 * (1.0 - abs(ndl))), 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  if (max(abs(p.x), abs(p.y)) >= 0.98 || p.z <= 0.0 || p.z >= 1.0) { return 1.0; }
  let st = 1.0 / 2048.0;
  // 4 bilinear-filtered compare taps (an effective 3x3-texel tent)
  var s = 0.0;
  s += textureSampleCompareLevel(ishadow, ishSamp, uv + vec2f(-0.75, -0.75) * st, p.z - 0.0004);
  s += textureSampleCompareLevel(ishadow, ishSamp, uv + vec2f(0.75, -0.75) * st, p.z - 0.0004);
  s += textureSampleCompareLevel(ishadow, ishSamp, uv + vec2f(-0.75, 0.75) * st, p.z - 0.0004);
  s += textureSampleCompareLevel(ishadow, ishSamp, uv + vec2f(0.75, 0.75) * st, p.z - 0.0004);
  return s * 0.25;
}

// How much of the cockpit tub surrounds a point (1 deep inside, 0 outside).
fn cockpit(lp: vec3f) -> f32 {
  return (1.0 - smoothstep(0.60, 0.72, abs(lp.x))) * smoothstep(-1.15, -0.95, lp.z) * (1.0 - smoothstep(0.32, 0.46, lp.z)) * (1.0 - smoothstep(1.04, 1.16, lp.y));
}
fn cavity(lp: vec3f, nl: vec3f) -> f32 {
  let c = cockpit(lp);
  let depth = sat((1.10 - lp.y) / 0.28);
  let down = sat(-nl.y);
  let back = sat(nl.z) * (1.0 - smoothstep(0.1, 0.3, lp.z)); // faces pointing forward under the dash
  // fascia faces sit under the leather brow: less sky the further below its edge
  let brow = smoothstep(0.02, 0.10, lp.z) * (1.0 - smoothstep(0.3, 0.45, lp.z)) * sat((ytopW(lp.x) - lp.y) / 0.16);
  return mix(1.0, (1.0 - 0.55 * depth) * (1.0 - 0.45 * down) * (1.0 - 0.4 * back) * (1.0 - 0.2 * brow), c);
}

fn envSky(r: vec3f) -> vec3f {
  let sky = skyRadiance(normalize(vec3f(r.x, max(r.y, 0.02), r.z)));
  let gnd = F.ambient.rgb * (sunIlluminance() * max(F.sunDir.y, 0.0) + skyRadiance(vec3f(0.0, 1.0, 0.0)) * PI) / PI;
  return mix(gnd, sky, smoothstep(-0.12, 0.05, r.y));
}
// Environment seen in direction r (world) / rl (car local) from lp: the sky, unless the ray
// goes back into the cockpit, where it sees warm dark leather lit by the ambient.
fn envI(r: vec3f, rl: vec3f, lp: vec3f, amb: vec3f) -> vec3f {
  let c = cockpit(lp);
  let open = smoothstep(-0.2, 0.45, rl.y) * (1.0 - 0.6 * sat(-rl.z) * (1.0 - smoothstep(0.2, 0.7, rl.y)));
  let inner = vec3f(0.07, 0.04, 0.03) * (amb + sunIlluminance() * max(F.sunDir.y, 0.0) * 0.5) / PI;
  return mix(envSky(r), inner, c * (1.0 - open));
}

fn toLocal(d: vec3f) -> vec3f {
  return vec3f(dot(d, U.body[0].xyz), dot(d, U.body[1].xyz), dot(d, U.body[2].xyz));
}
fn toWorld(d: vec3f) -> vec3f { return (U.body * vec4f(d, 0.0)).xyz; }

// --- LCD (140 x 35 dots). Strict rows: y 2-6 small 'NOW PLAYING:' label (+ source at the
// right), y 8-14 title, y 17-23 era · biome, y 26-32 play icon + time (left) and level bars
// (right, x 80-134, 6 dots tall on the status baseline: y 27-32, peak dots from y 26). Texture rows: 0-6 title, 8-14 era, 16-22 status,
// 24-28 small label row.
fn lcdState(c: vec2i) -> f32 {
  let x = c.x; let y = c.y;
  if (x < 2 || y < 2 || x >= 138 || y >= 33) { return 0.0; }
  if (y <= 6) { return textureLoad(lcdTex, vec2i(x - 2, y - 2 + 24), 0).r; }
  if (y >= 8 && y <= 14) {
    let P = i32(U.lcdA.z);
    let sx = (x - 2 + i32(U.lcdA.x)) % P;
    if (sx < 256) { return textureLoad(lcdTex, vec2i(sx, y - 8), 0).r; }
    return 0.0;
  }
  if (y >= 17 && y <= 23) {
    let P = i32(U.lcdA.w);
    let sx = (x - 2 + i32(U.lcdA.y)) % P;
    if (sx < 256) { return textureLoad(lcdTex, vec2i(sx, y - 17 + 8), 0).r; }
    return 0.0;
  }
  if (y >= 26 && x >= 80 && x < 136) {
    let bx = x - 80;
    let k = bx / 7;
    if (bx % 7 >= 5) { return 0.0; }
    let h = i32(U.lv[k / 4][k % 4]);
    let pk = i32(U.pk[k / 4][k % 4]);
    if (y >= 33 - h) { return 1.0; }
    if (pk > 0 && y == 32 - pk) { return 0.8; }
    return 0.0;
  }
  if (y >= 26 && x < 66) { return textureLoad(lcdTex, vec2i(x - 2, y - 26 + 16), 0).r; }
  return 0.0;
}

// Returns emitted radiance of the LCD at uv (0..1, v down); fq = dots per pixel.
fn lcdEmit(uv: vec2f, fq: f32) -> vec3f {
  let p = uv * vec2f(140.0, 35.0);
  let inside = band(uv.x, 0.0, 1.0, fq / 140.0) * band(uv.y, 0.0, 1.0, fq / 35.0);
  let c0 = vec2i(floor(p));
  var lit = 0.0; var grid = 0.0; var glow = 0.0;
  let aa = max(fq, 0.04);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = c0 + vec2i(dx, dy);
      let s = lcdState(c);
      let d = p - (vec2f(c) + 0.5);
      let q = abs(d) - vec2f(0.42 - 0.17);
      let sdf = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.17;
      let cov = sat(0.5 - sdf / aa);
      lit += s * cov; grid += cov;
      glow += s * exp(-dot(d, d) * 0.9);
    }
  }
  let far = smoothstep(0.55, 1.3, fq);
  let sC = lcdState(c0);
  lit = mix(lit, sC * 0.7, far);
  grid = mix(min(grid, 1.0), 0.7, far);
  let bl = U.lcdB.x;
  let bg = vec3f(0.006, 0.02, 0.085);
  let ghost = vec3f(0.012, 0.035, 0.13);
  let on = vec3f(0.80, 0.93, 1.0) * 1.25;
  // slight backlight falloff toward the edges (LED edge-lit panel)
  let fall = 0.85 + 0.15 * (1.0 - pow(abs(uv.x * 2.0 - 1.0), 3.0));
  var e = (bg + grid * ghost) * fall + lit * (on - ghost * grid) * 1.0 + glow * vec3f(0.06, 0.16, 0.5) * U.lcdB.y;
  return e * bl * inside + bg * 0.3 * bl * (1.0 - inside);
}

// --- dial prints
fn speedoInk(p: vec2f, fw: f32) -> f32 {
  let r = length(p);
  let ang = atan2(p.x, p.y);
  let kmh = (ang + 2.2689) / 4.5379 * 240.0;
  var ink = 0.0;
  let k = round(kmh / 10.0);
  if (k >= 0.0 && k <= 24.0) {
    let arc = (kmh - k * 10.0) / 240.0 * 4.5379 * r;
    let major = fract(k * 0.5) < 0.25;
    let w = select(0.00034, 0.00078, major);
    let r0 = select(0.0648, 0.0598, major);
    ink = max(ink, band(arc, -w, w, fw) * band(r, r0, 0.0702, fw));
  }
  // scale ring
  if (kmh > -1.0 && kmh < 241.0) { ink = max(ink, band(r, 0.0698, 0.0706, fw)); }
  // numerals every 40 km/h
  let j = round(kmh / 40.0);
  if (j >= 0.0 && j <= 6.0) {
    let aj = j / 6.0 * 4.5379 - 2.2689;
    let dt = 0.00106;
    let val = i32(j * 40.0);
    let len = select(select(3, 2, val < 100), 1, val < 10);
    // inset each numeral by its own half extent along the radius so it clears the major ticks
    let rc = 0.0566 - f32(len) * 3.0 * dt * abs(sin(aj)) - 3.5 * dt * abs(cos(aj));
    let c = rc * vec2f(sin(aj), cos(aj));
    let q = vec2f(p.x - c.x, c.y - p.y) / dt;
    let x = q.x + f32(len) * 3.0 - 0.5;
    let i = i32(floor(x / 6.0));
    if (i >= 0 && i < len) {
      let digit = (val / pow10i(len - 1 - i)) % 10;
      ink = max(ink, glyphInk(26 + digit, vec2f(x - f32(i) * 6.0, q.y + 3.5), fw / dt, 0.50));
    }
  }
  ink = max(ink, labelInk(${L_KMH}, vec2f(p.x, -p.y - 0.027) / 0.00085, fw / 0.00085, 0.5));
  return ink;
}

// --- drums: digit d of the year (dec 0..5), plate (dec 6)
// Numerals on a drum at position pos (digits) with a vertical motion smear of bl digits.
fn drumDigits(pos: f32, bl: f32, a: f32, uv: vec2f, fq: f32) -> f32 {
  let pitch = 0.6283185;                  // 36 degrees per digit
  let dotS = ${DIGIT_H / 7};
  let b = min(bl, 0.3);                   // a short smear between two visible numerals
  let taps = select(1, 6, b > 0.03);
  var ink = 0.0;
  for (var s = 0; s < taps; s++) {
    let o = select(0.0, (f32(s) / 5.0 - 0.5) * b, taps > 1);
    let t = pos + o - a / pitch;
    let n = round(t);
    let digit = ((i32(n) % 10) + 10) % 10;
    let q = vec2f(2.5 + uv.y / dotS, 3.5 + (t - n) * (pitch * ${DRUM_R} / dotS));
    ink += glyphInk(26 + digit, q, fq, 0.45);
  }
  return ink / f32(taps);
}
fn drumInk(dec: u32, uv: vec2f, fw: vec2f) -> f32 {
  let a = uv.x * 6.2831853;               // angle around the axis (0 = facing out)
  let pitch = 0.6283185;
  let dotS = ${DIGIT_H / 7};
  let fq = max(fw.x * 6.2831853 * ${DRUM_R} , fw.y) / dotS;
  if (dec < 6u) {
    // Every drum always shows numerals: fast drums crossfade to a capped-speed spin.
    let w = U.sw[dec / 4u][dec % 4u];
    var ink = 0.0;
    if (w < 0.999) { ink = drumDigits(U.drum[dec / 4u][dec % 4u], U.blur[dec / 4u][dec % 4u], a, uv, fq) * (1.0 - w); }
    if (w > 0.001) { let sp = U.spin[dec / 4u][dec % 4u]; let fr = fract(sp); ink += drumDigits(sp, 0.22 * smoothstep(0.01, 0.1, min(fr, 1.0 - fr)), a, uv, fq) * w; }
    return ink;
  }
  let t = U.drum[1].z - a / pitch;
  let n = i32(round(t));
  let yo = (t - round(t)) * pitch * ${DRUM_R};
  if (n == 0) { return labelInk(${L_AGO}, vec2f(uv.y, yo) / 0.00118, fq * dotS / 0.00118, 0.42); }
  if (n == 1) { return labelInk(${L_BCE}, vec2f(uv.y, yo) / 0.00118, fq * dotS / 0.00118, 0.42); }
  if (n == 2) { return labelInk(${L_CE}, vec2f(uv.y, yo) / 0.00118, fq * dotS / 0.00118, 0.42); }
  return 0.0;
}
// Drum curvature falloff: numerals fade into shadow toward the slot edges (angle a).
fn drumShade(uvx: f32) -> f32 {
  // the slot shows about +-0.32 rad of each drum: lit on the crown, rolling into shadow above and below
  let a = abs(uvx * 6.2831853);
  return (1.0 - 0.9 * smoothstep(0.12, 0.34, a)) * (0.55 + 0.45 * cos(min(a * 3.0, 1.5)));
}

struct Mat { base: vec3f, rough: f32, metal: f32, coat: f32, emit: vec3f, nl: vec3f, ao: f32 };

fn bumpW(d: f32, w: f32) -> f32 { return 0.5 + 0.5 * cos(PI * min(1.0, abs(d) / w)); }
// Fascia top edge height (mirror of ytop() in JS).
fn ytopW(x: f32) -> f32 { return ${FT} + 0.06 * bumpW(x - ${DRIVER_X}, 0.3) + 0.022 * bumpW(x + 0.36, 0.24); }
fn sdRect(p: vec2f, h: vec2f, r: f32) -> f32 { let q = abs(p) - h + r; return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r; }
// Head-unit face coordinates (metres, x right as seen by the driver, y up the face).
fn huLocal(lp: vec3f) -> vec2f { return vec2f(-lp.x, dot(lp - vec3f(0.0, ${HU_Y}, ${fz(HU_Y)}), vec3f(0.0, ${FCU}, ${FSU}))); }
// Blue LCD light spilling onto the faceplate around the screen.
fn lcdSpill(lp: vec3f) -> vec3f {
  let q = huLocal(lp) - vec2f(${LCD_X}, ${LCD_Y});
  let d = sdRect(q, vec2f(${LCD_W * LCD_PITCH / 2 + 0.003}, ${LCD_H * LCD_PITCH / 2 + 0.003}), 0.002);
  let k = select(0.0, exp(-d / 0.0075), d > 0.0);
  return vec3f(0.010, 0.032, 0.11) * k * U.lcdB.x;
}
// Contact shadow on the fascia around inset parts (fascia x, y in car-local).
fn fasciaAO(p: vec2f) -> f32 {
  let dh = sdRect(p - vec2f(0.0, ${HU_Y}), vec2f(0.0955, ${0.0555 * FCU}), 0.008);
  let dg = sdRect(p - vec2f(${DRIVER_X}, ${GAUGE_Y}), vec2f(0.199, ${0.097 * FCU}), 0.012);
  let dr = ytopW(p.x) - p.y; // below the leather roll
  var ao = 1.0 - 0.55 * exp(-max(dh, 0.0) / 0.005) - 0.45 * exp(-max(dg, 0.0) / 0.005);
  ao *= 0.72 + 0.28 * smoothstep(0.0, 0.05, dr);
  return max(ao, 0.2);
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  // Derivatives first (uniform control flow).
  let duvx = dpdx(i.uv); let duvy = dpdy(i.uv);
  let fwuv = abs(duvx) + abs(duvy);
  let fwp = length(dpdx(i.lp)) + length(dpdy(i.lp)); // metres per pixel
  var nl = normalize(i.ln);
  if (!ff) { nl = -nl; }
  let mat = i.ids.x;
  let dec = i.ids.z;
  var S: Mat;
  S.base = vec3f(0.5); S.rough = 0.5; S.metal = 0.0; S.coat = 0.0; S.emit = vec3f(0.0); S.nl = nl; S.ao = f32(i.ids.w) / 255.0;
  let fineFade = 1.0 - smoothstep(0.0006, 0.002, fwp); // fades sub-pixel detail

  switch (mat) {
    case 0u, 17u, 24u: { // leathers: dash (dark brown), door (oxblood), strap (tan)
      var col = vec3f(0.068, 0.038, 0.024);
      if (mat == 17u) { col = vec3f(0.085, 0.034, 0.024); }
      if (mat == 24u) { col = vec3f(0.16, 0.075, 0.035); }
      // three scales: fine grain (~1.4 mm), pebble (~4 mm, readable from the seat) and broad
      // wear / sheen patches; each fades out before it can alias
      let gp = i.lp * 700.0;
      let n1 = vnoise(gp.xz + gp.y * 0.7) ;
      let n2 = vnoise(gp.yz * 1.3 + 7.0);
      let grain = (n1 * 0.6 + n2 * 0.4);
      let mp = i.lp * 420.0;
      let m1 = vnoise(mp.xz + mp.y * 0.7 + 31.0);
      let m2 = vnoise(mp.yz * 1.1 + 3.0);
      let midFade = 1.0 - smoothstep(0.0009, 0.003, fwp);
      let wear = vnoise(i.lp.xz * 7.0 + i.lp.y * 3.0) * 0.7 + 0.15;
      S.base = col * (0.85 + 0.3 * grain * fineFade + 0.15 * (1.0 - fineFade) + 0.10 * (m1 - 0.5) * midFade + 0.14 * (wear - 0.5));
      S.rough = 0.70 + 0.10 * grain * fineFade + 0.08 * (m1 - 0.5) * midFade - 0.14 * (wear - 0.5);
      S.nl = normalize(nl + (vec3f(n1, n2, n1 * n2) - 0.5) * 0.12 * fineFade + (vec3f(m1, m2, 1.0 - m1) - 0.5) * 0.07 * midFade);
      S.coat = 0.0;
      if (dec == 0u && mat == 0u) {
        // dash top: a welted seam across the width (z 0.27) with a row of stitches each side
        let dz = i.uv.y - 0.27;
        let fz2 = max(fwuv.y, 0.0003);
        let welt = band(dz, -0.0016, 0.0016, fz2);
        let st = band(fract(i.uv.x / 0.0065), 0.15, 0.7, fwuv.x / 0.0065) * (band(dz, -0.0062, -0.0046, fz2) + band(dz, 0.0046, 0.0062, fz2));
        S.nl = normalize(S.nl - vec3f(0.0, 0.0, sign(dz)) * 0.45 * (1.0 - smoothstep(0.0, 0.005, abs(dz))));
        S.base = mix(S.base, S.base * 0.4, welt);
        S.base = mix(S.base, vec3f(0.36, 0.28, 0.19), st * 0.85 * midFade);
        S.rough = mix(S.rough, 0.85, st);
      }
      if (dec == 1u && mat == 17u) {
        // pleated door card: vertical rolls every 7.5 cm with stitched seams, darker low down
        let z = i.uv.x / 0.075;
        let f = fract(z);
        let roll = sin(f * PI);
        S.nl = normalize(S.nl + vec3f(0.0, 0.0, 1.0) * cos(f * PI) * 0.35);
        let seam = 1.0 - smoothstep(0.0, 0.05 + fwuv.x / 0.075, min(f, 1.0 - f));
        let stitch = band(fract(i.uv.y / 0.006), 0.2, 0.75, fwuv.y / 0.006) * band(min(f, 1.0 - f), 0.07, 0.1, fwuv.x / 0.075);
        S.base *= (0.75 + 0.25 * roll) * (1.0 - 0.5 * seam);
        S.base = mix(S.base, vec3f(0.30, 0.22, 0.15), stitch * 0.7 * fineFade);
        S.ao *= 0.55 + 0.45 * smoothstep(0.86, 1.0, i.uv.y);
      }
      if (dec == 1u && mat == 0u) {
        // stitched seam along the roll, toward the driver
        let around = i.uv.y;
        let seam = band(abs(fract(around + 0.1) - 0.5), -1.0, 0.012, fwuv.y);
        let stitch = band(fract(i.uv.x / 0.0055), 0.15, 0.75, fwuv.x / 0.0055) * band(abs(fract(around + 0.1) - 0.5), 0.022, 0.034, fwuv.y);
        S.base = mix(S.base, S.base * 0.45, seam);
        S.base = mix(S.base, vec3f(0.42, 0.33, 0.22), stitch * 0.9);
      }
    }
    case 1u: { // straight-grain walnut under a deep clear lacquer
      let p = i.uv;
      let wav = fbm(vec2f(p.x * 9.0, p.y * 30.0));
      let fig = vnoise(vec2f(p.x * 60.0, p.y * 420.0));
      let gy = p.y + 0.0035 * wav + 0.0012 * sin(p.x * 23.0 + wav * 4.0);
      let ring = fract(gy * 520.0 + fig * 0.6);
      let line = smoothstep(0.0, 0.3, ring) * smoothstep(1.0, 0.55, ring);
      let pores = vnoise(vec2f(p.x * 2200.0, gy * 9000.0));
      let lineF = mix(0.6, line, fineFade);
      let tone = sat(0.30 + 0.45 * lineF + 0.25 * (wav - 0.5) - 0.15 * pores * fineFade);
      S.base = mix(vec3f(0.045, 0.021, 0.011), vec3f(0.20, 0.10, 0.05), tone);
      S.rough = 0.45; S.coat = 1.0;
      S.ao *= fasciaAO(p);
      // glovebox lid: 1.5 mm panel gap, rounded bevel catching the light
      let gb = vec2f(-p.x - 0.36, p.y - 0.905);
      let sd = sdRect(gb, vec2f(0.20, 0.055), 0.012);
      let aw = max(fwp * 1.2, 0.0004);
      let gap = 1.0 - sat(abs(sd) / aw - 0.75);
      let qa = abs(gb) - vec2f(0.20, 0.055);
      let gdir = select(vec2f(0.0, sign(gb.y)), vec2f(sign(gb.x), 0.0), qa.x > qa.y);
      let bevel = (1.0 - smoothstep(0.0, 0.004, -sd)) * step(sd, 0.0);
      S.nl = normalize(S.nl + (vec3f(-gdir.x, 0.0, 0.0) + vec3f(0.0, ${FCU}, ${FSU}) * gdir.y) * 0.7 * bevel);
      S.base *= 1.0 - 0.9 * gap; S.coat *= 1.0 - gap; S.ao *= 1.0 - 0.6 * gap;
      S.ao *= 1.0 - 0.45 * exp(-max(sd, 0.0) / 0.003) * step(0.0, sd);
    }
    case 2u: { // instrument panel: satin black-nickel with fine horizontal brushing
      let pf = 1.0 - smoothstep(0.0003, 0.0012, fwp); // brushing fades before it can alias
      let st = vnoise(vec2f(i.uv.x * 35.0, i.uv.y * 3200.0)) * 0.6 + vnoise(vec2f(i.uv.x * 9.0, i.uv.y * 900.0)) * 0.4;
      let Up = vec3f(0.0, ${FCU}, ${FSU});
      S.nl = normalize(nl + Up * (st - 0.5) * 0.06 * pf);
      S.base = vec3f(0.36, 0.35, 0.34) * (0.9 + 0.2 * mix(0.5, st, pf)); S.metal = 1.0; S.rough = 0.3 + 0.08 * st * pf;
    }
    case 3u, 4u, 26u: { // brass (+ drilled spokes), copper
      let pat = vnoise(i.lp.xz * 90.0 + i.lp.y * 30.0);
      S.base = select(vec3f(0.80, 0.57, 0.27), vec3f(0.82, 0.42, 0.26), mat == 4u) * (0.88 + 0.12 * pat);
      S.metal = 1.0; S.rough = 0.17 + 0.12 * pat;
      if (dec == 1u) { // bezel knurling on the outer flank
        let kn = sin(i.uv.x * 6.2831853 * 160.0);
        let flank = band(i.uv.y, 0.55, 0.97, fwuv.y);
        let vis = 1.0 - smoothstep(0.12, 0.3, fwuv.x * 160.0);
        S.rough += 0.1 * flank * abs(kn) * vis;
        S.base *= 1.0 - 0.25 * flank * (0.5 + 0.5 * kn) * vis;
      }
      if (mat == 26u) { // three lightening holes per spoke
        var hole = 0.0; var rim = 0.0;
        for (var k = 0; k < 3; k++) {
          let c = 0.058 + f32(k) * 0.03;
          let rr = 0.0052 - f32(k) * 0.0009;
          let d = length(vec2f(i.uv.x - c, i.uv.y)) - rr;
          hole = max(hole, sat(0.5 - d / max(fwp, 0.0002)));
          rim = max(rim, sat(1.0 - abs(d + 0.0006) / max(fwp * 1.2, 0.0006)));
        }
        S.base = mix(S.base, vec3f(0.01), hole); S.metal = 1.0 - hole; S.rough = mix(S.rough, 0.9, hole);
        S.ao *= 1.0 - 0.7 * hole;
        S.base = mix(S.base, S.base * 1.15, rim);
      }
    }
    case 5u: { S.base = vec3f(0.012, 0.085, 0.082); S.rough = 0.35; S.coat = 1.0; } // car paint
    case 6u: { // satin black faceplate: a soft sheen, brighter on the rounded bevel
      let hq = huLocal(i.lp);
      let bev = smoothstep(0.0905 - 0.006, 0.0915, abs(hq.x)) + smoothstep(0.0515 - 0.006, 0.0515, abs(hq.y));
      S.base = vec3f(0.065, 0.066, 0.07) * (1.0 + 0.6 * sat(bev)); S.rough = 0.3; S.coat = 0.55; S.emit = lcdSpill(i.lp);
    }
    case 7u: { // soft-touch button with printed label
      S.base = vec3f(0.07); S.rough = 0.42; S.coat = 0.25;
      let ink = labelInk(i32(dec), i.uv, max(fwuv.x, fwuv.y), 0.36);
      S.base = mix(S.base, vec3f(0.60, 0.61, 0.63), ink);
      S.emit = vec3f(0.05, 0.13, 0.42) * ink * U.lcdB.x * 0.55 + lcdSpill(i.lp) * 0.6; // key backlight
    }
    case 25u: { // print on the satin faceplate
      S.base = vec3f(0.065, 0.066, 0.07); S.rough = 0.3; S.coat = 0.55; S.emit = lcdSpill(i.lp);
      let ink = labelInk(i32(dec), i.uv, max(fwuv.x, fwuv.y), 0.34);
      S.base = mix(S.base, vec3f(0.45, 0.46, 0.48), ink); S.coat = 1.0 - 0.5 * ink;
      S.emit += vec3f(0.05, 0.13, 0.42) * ink * U.lcdB.x * 0.25; // faint legend backlight
    }
    case 8u: { // aluminium (knob cap: concentric brushing + indicator)
      S.base = vec3f(0.86, 0.87, 0.89); S.metal = 1.0; S.rough = 0.2;
      if (dec == 1u) {
        let r = length(i.uv);
        S.rough = 0.16 + 0.12 * vnoise(vec2f(r * 6000.0, 0.5)) * fineFade;
        let ind = band(i.uv.x, -0.0006, 0.0006, fwp) * band(i.uv.y, 0.0055, 0.0105, fwp);
        S.base = mix(S.base, vec3f(0.02), ind); S.metal = 1.0 - ind;
      }
    }
    case 9u: { // speedometer face: ivory enamel, black print
      let rf = length(i.uv);
      S.base = vec3f(0.56, 0.51, 0.40) * (1.0 - 0.18 * smoothstep(0.02, 0.07, rf)); S.rough = 0.42; S.coat = 0.4;
      S.ao *= 0.35 + 0.65 * (1.0 - smoothstep(0.058, 0.0712, rf)); // the brass ring's inner shadow
      let ink = speedoInk(i.uv, fwp);
      S.base = mix(S.base, vec3f(0.018), ink);
    }
    case 10u: { // year face: black enamel, ivory print, drum window cut out
      let ww = ${(6 * (DRUM_W + DRUM_GAP) + PLATE_W + 0.004) / 2};
      if (abs(i.uv.x) < ww + 0.0006 && abs(i.uv.y) < ${DRUM_WH / 2} + 0.0006) { discard; }
      let r = length(i.uv);
      let ang = atan2(i.uv.x, i.uv.y);
      // guilloche: a fine engine-turned rosette (two interfering wave rings), faded before it aliases
      let gf = 1.0 - smoothstep(0.00025, 0.0007, fwp);
      let g1 = sin(r * 2600.0 + sin(ang * 24.0) * 2.2);
      let g2 = sin(r * 2600.0 - sin(ang * 24.0 + 0.6) * 2.2);
      let guil = (0.5 + 0.25 * (g1 + g2)) * gf * smoothstep(0.012, 0.016, abs(i.uv.y)) * (1.0 - smoothstep(0.058, 0.061, r));
      S.base = vec3f(0.022, 0.024, 0.030) * (0.75 + 0.55 * guil + 0.25 * (1.0 - gf)); S.rough = 0.26 + 0.12 * guil; S.coat = 0.6;
      S.ao *= 0.35 + 0.65 * (1.0 - smoothstep(0.058, 0.0712, r));
      var ink = band(r, 0.0655, 0.0662, fwp) + band(r, 0.0612, 0.0615, fwp) * 0.6;
      // 60 minute-style ticks between the two rings, every fifth one longer
      let tk = ang / 6.2831853 * 60.0;
      let tki = round(tk);
      let tlong = abs(tki - 5.0 * round(tki / 5.0)) < 0.5;
      ink = max(ink, band((tk - tki) * 6.2831853 / 60.0 * r, -select(0.00028, 0.0005, tlong), select(0.00028, 0.0005, tlong), fwp) * band(r, select(0.0632, 0.0618, tlong), 0.0655, fwp) * 0.8);
      // unit label above the window: YEAR (BCE / CE) or YEARS (... AGO), crossfading with the plate
      let wAgo = 1.0 - sat(U.drum[1].z);
      let lq = vec2f(i.uv.x, 0.0335 - i.uv.y) / 0.00105;
      ink = max(ink, mix(labelInk(${L_YEAR}, lq, fwp / 0.00105, 0.38), labelInk(${L_YEARS}, lq, fwp / 0.00105, 0.38), wAgo));
      // little hourglass mark under the window
      let hp = vec2f(i.uv.x, i.uv.y + 0.033);
      let hg = band(abs(hp.y), 0.0, 0.0062, fwp) * band(abs(hp.x), -1.0, 0.0012 + abs(hp.y) * 0.62, fwp);
      let hgi = band(abs(hp.y), 0.0, 0.0050, fwp) * band(abs(hp.x), -1.0, abs(hp.y) * 0.62 - 0.0001, fwp);
      ink = max(ink, hg - hgi * 0.85);
      S.base = mix(S.base, vec3f(0.62, 0.52, 0.32), sat(ink));
    }
    case 11u: { // digit drums: black, white numerals (leading zeros dimmed)
      let ink = drumInk(dec, i.uv, fwuv) * (1.0 - 0.85 * U.lead[dec / 4u][dec % 4u]);
      S.base = mix(vec3f(0.024), vec3f(0.80, 0.78, 0.72), ink) * drumShade(i.uv.x); S.rough = 0.32;
      S.ao *= 0.8 * drumShade(i.uv.x);
    }
    case 12u: { // era plate drum: ivory, black letters
      let ink = drumInk(6u, i.uv, fwuv);
      S.base = mix(vec3f(0.66, 0.59, 0.43), vec3f(0.02), ink) * drumShade(i.uv.x); S.rough = 0.35;
      S.ao *= 0.85 * drumShade(i.uv.x);
    }
    case 13u: { // LCD under its cover glass
      S.base = vec3f(0.004); S.rough = 0.06; S.coat = 1.0;
      S.emit = lcdEmit(i.uv, max(fwuv.x * 140.0, fwuv.y * 35.0));
    }
    case 14u: { // steering rim: helically wrapped leather
      // stitched leather wrap: smooth hide with one cross-stitched seam on the inner face of the
      // rim (uv.y = 0.5 is the inner equator), fine grain fading with distance; no repeating ribs
      let gp = i.lp * 700.0;
      let n1 = vnoise(gp.xz + gp.y * 0.7);
      let n2 = vnoise(gp.yz * 1.3 + 7.0);
      let wear = vnoise(vec2f(i.uv.x * 40.0, i.uv.y * 3.0));
      S.base = vec3f(0.080, 0.044, 0.028) * (0.88 + 0.24 * (n1 * 0.6 + n2 * 0.4) * fineFade + 0.2 * (wear - 0.5));
      S.rough = 0.58 + 0.1 * n1 * fineFade - 0.12 * (wear - 0.5); S.coat = 0.0;
      S.nl = normalize(nl + (vec3f(n1, n2, n1 * n2) - 0.5) * 0.1 * fineFade);
      let dv = i.uv.y - 0.5;
      let fv = max(fwuv.y, 0.001);
      let seam = band(dv, -0.006, 0.006, fv);
      let sp = i.uv.x * 220.0;
      let sf = fract(sp + dv * 18.0); let sb = fract(sp - dv * 18.0);
      let svis = 1.0 - smoothstep(0.2, 0.45, fwuv.x * 220.0);
      let stitch = max(band(sf, 0.1, 0.55, fwuv.x * 220.0), band(sb, 0.1, 0.55, fwuv.x * 220.0)) * band(dv, -0.03, 0.03, fv) * svis;
      S.base = mix(S.base * (1.0 - 0.5 * seam), vec3f(0.34, 0.26, 0.17), stitch * 0.8);
    }
    case 15u: { S.base = vec3f(0.018); S.rough = 0.7; } // matte black
    case 28u: { // floor: varnished teak slats (fore-aft) with black caulking, a bound carpet mat per footwell
      let p = i.uv; // (x, z) car local
      let sw = 0.058;
      let sx = p.x / sw;
      let si = floor(sx);
      let sfr = fract(sx);
      let aw = max(fwuv.x / sw, 0.002);
      let caulk = 1.0 - band(sfr, 0.06, 0.94, aw * 1.5);
      let tone = hash2(vec2f(si, 3.0));
      let gr = fbm(vec2f(sx * 3.0 + si * 7.1, p.y * 9.0));
      let line = vnoise(vec2f(sx * 40.0 + gr * 6.0, p.y * 2.0 + si)) * fineFade + 0.5 * (1.0 - fineFade);
      let wood = mix(vec3f(0.16, 0.085, 0.04), vec3f(0.30, 0.17, 0.08), sat(0.25 + 0.5 * tone + 0.4 * (gr - 0.5) + 0.2 * (line - 0.5)));
      S.base = mix(wood, vec3f(0.012), caulk); S.rough = mix(0.38, 0.8, caulk); S.coat = 0.5 * (1.0 - caulk);
      S.ao *= 1.0 - 0.5 * caulk;
      // carpet mats with a stitched tan binding
      let mq = vec2f(abs(p.x) - 0.36, p.y + 0.12);
      let md = sdRect(mq, vec2f(0.19, 0.26), 0.03);
      let mat_in = sat(0.5 - md / max(fwp, 0.0005));
      let bind = band(md, -0.012, 0.0, max(fwp, 0.0005));
      let pile = vnoise(p * 900.0) * fineFade + 0.5 * (1.0 - fineFade);
      let mc = mix(vec3f(0.035, 0.028, 0.024) * (0.8 + 0.4 * pile), vec3f(0.17, 0.10, 0.05), bind);
      S.base = mix(S.base, mc, mat_in); S.rough = mix(S.rough, 0.92, mat_in); S.coat *= 1.0 - mat_in;
    }
    case 16u: { S.base = vec3f(0.62, 0.07, 0.02); S.rough = 0.3; S.coat = 0.8; } // needle
    case 18u: { // knurled aluminium knob flank
      let kn = sin(i.uv.x * 6.2831853 * 90.0);
      let vis = 1.0 - smoothstep(0.25, 0.5, fwuv.x * 90.0);
      S.base = vec3f(0.80, 0.81, 0.83) * (1.0 - 0.3 * vis * (0.5 + 0.5 * kn)); S.metal = 1.0; S.rough = 0.25 + 0.15 * vis * abs(kn);
    }
    case 19u: { // disc slot: dark gap with a bright lip
      let y = abs(i.uv.y);
      let gap = band(y, -1.0, 0.0011, fwp) * band(abs(i.uv.x), -1.0, 0.0585, fwp);
      let lip = band(y, 0.0011, 0.0019, fwp) * band(abs(i.uv.x), -1.0, 0.0595, fwp);
      S.base = mix(vec3f(0.032), vec3f(0.0), gap); S.rough = mix(0.14, 0.9, gap); S.coat = 1.0 - gap;
      S.base = mix(S.base, vec3f(0.75), lip); S.metal = lip; S.coat *= 1.0 - lip;
      S.ao *= 1.0 - 0.9 * gap;
    }
    case 22u: { // USB port (dec 0) and AUX jack (dec 1)
      S.base = vec3f(0.032); S.rough = 0.14; S.coat = 1.0;
      let p = i.uv;
      if (dec == 0u) {
        let shell = band(abs(p.x), -1.0, 0.0062, fwp) * band(abs(p.y), -1.0, 0.0024, fwp);
        let hole = band(abs(p.x), -1.0, 0.0054, fwp) * band(abs(p.y), -1.0, 0.0017, fwp);
        let tongue = band(abs(p.x), -1.0, 0.0047, fwp) * band(p.y, 0.0, 0.0012, fwp);
        S.base = mix(S.base, vec3f(0.65), shell); S.metal = shell;
        S.base = mix(S.base, vec3f(0.006), hole); S.metal *= 1.0 - hole; S.rough = mix(S.rough, 0.8, hole);
        S.base = mix(S.base, vec3f(0.55, 0.56, 0.6), tongue); S.metal *= 1.0 - tongue; S.rough = mix(S.rough, 0.5, tongue);
        S.coat *= 1.0 - shell;
        S.ao *= 1.0 - 0.6 * (hole - tongue);
      } else {
        let r = length(p);
        let ring = band(r, 0.0016, 0.0034, fwp);
        let hole = band(r, -1.0, 0.0016, fwp);
        S.base = mix(S.base, vec3f(0.8), ring); S.metal = ring; S.rough = mix(S.rough, 0.18, ring);
        S.base = mix(S.base, vec3f(0.0), hole); S.coat *= 1.0 - ring - hole; S.ao *= 1.0 - 0.8 * hole;
      }
    }
    case 23u: { // glowing glass core of the mascot
      S.base = vec3f(0.02, 0.05, 0.06); S.rough = 0.05; S.coat = 1.0;
      S.emit = vec3f(0.2, 0.85, 1.0) * U.misc.x * (0.35 + 0.25 * sin(i.lp.y * 260.0 - U.misc.y * 5.0));
    }
    case 27u: { // horn boss: brass with an engraved hourglass and ring
      S.base = vec3f(0.80, 0.57, 0.27); S.metal = 1.0; S.rough = 0.2;
      let p = i.uv; let r = length(p);
      var en = band(r, 0.0262, 0.0272, fwp);
      let hg = band(abs(p.y), 0.0, 0.0125, fwp) * band(abs(p.x), -1.0, 0.0018 + abs(p.y) * 0.75, fwp);
      let hgi = band(abs(p.y), 0.0, 0.0108, fwp) * band(abs(p.x), -1.0, abs(p.y) * 0.75 - 0.0001, fwp);
      en = max(en, sat(hg - hgi));
      en = max(en, band(abs(p.y), 0.0118, 0.0132, fwp) * band(abs(p.x), -1.0, 0.0115, fwp));
      S.base = mix(S.base, vec3f(0.12, 0.07, 0.03), en); S.rough = mix(S.rough, 0.6, en);
    }
    default: {}
  }

  // ---- lighting
  let n = normalize(toWorld(S.nl));
  let v = normalize(F.camPos - i.wp);
  let nv = max(dot(n, v), 1e-3);
  let sunC = sunIlluminance();
  let ndl = max(dot(n, F.sunDir), 0.0);
  var sh = 0.0;
  var shI = 1.0;
  if (ndl > 0.0) { shI = shadowInt(i.lp, S.nl); if (shI > 0.0) { sh = min(shadowAt(i.wp, n), shI); } }
  // A cockpit part that blocks the sun (wheel, roll, hoop) also hides a slice of sky near it:
  // darken the ambient and reflections in its shadow so the shadow reads on metal and gloss too.
  let shOcc = mix(1.0, shI, sat(ndl * 4.0));
  let occ = cavity(i.lp, S.nl) * S.ao * mix(0.6, 1.0, shOcc);
  // warm bounce from the sunlit seats, legs and door cards inside the open tub: keeps the
  // footwell and the lower fascia dark but readable (never a black void)
  let bounce = sunC * max(F.sunDir.y, 0.05) * 0.045 * vec3f(1.0, 0.78, 0.62) * cockpit(i.lp) * mix(1.0, 0.6, S.ao);
  var col = S.base * (1.0 - S.metal) * (sunC * ndl * sh + i.amb * occ + bounce) / PI;
  let r = reflect(-v, n);
  let env = envI(r, toLocal(r), i.lp, i.amb) * mix(1.0, occ, 0.6) * mix(0.45, 1.0, shOcc);
  let hv = normalize(v + F.sunDir);
  let nh = max(dot(n, hv), 0.0);
  let a = max(S.rough * S.rough, 0.004);
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = min(a2 / (PI * dd * dd), 3000.0);
  let f0 = mix(vec3f(0.04), S.base, S.metal);
  let fr = f0 + (max(vec3f(1.0 - S.rough), f0) - f0) * pow(1.0 - nv, 5.0);
  col += fr * (sunC * D * ndl * sh * 0.25 / max(nv, 0.25) + env * mix(1.0, 0.25, S.rough));
  if (S.coat > 0.0) {
    let fc = (0.04 + 0.96 * pow(1.0 - nv, 5.0)) * S.coat;
    let ac = 0.0016;
    let dc = nh * nh * (ac - 1.0) + 1.0;
    let Dc = min(ac / (PI * dc * dc), 1500.0);
    col = col * (1.0 - fc) + fc * (env + sunC * Dc * ndl * sh * 0.25 / max(nv, 0.25));
  }
  col *= U.misc.w; // inside a passage (world/tunnel.js via car.js): daylight falls away; gauges and screen stay lit
  col += S.emit;
  if (U.misc.z > 0.5) { // debug: ?ishdbg=1 shows the cockpit shadow (red) and world shadow (green)
    return vec4f(shadowInt(i.lp, S.nl), shadowAt(i.wp, n), ndl, 1.0) * 3.0;
  }
  // (aerial perspective is negligible within a few metres: skip it for the cockpit seen from inside)
  if (dot(i.wp - F.camPos, i.wp - F.camPos) > 9.0) { col = applyFog(col, i.wp); }
  return vec4f(min(col, vec3f(64.0)), 1.0);
}

// Glass: premultiplied. Reflection is added; the screen absorbs a little (alpha) and its
// slight green-grey tint is folded into the added colour of what it absorbs.
@fragment fn fsGlass(i: VOut) -> @location(0) vec4f {
  var n = normalize(i.n);
  let v = normalize(F.camPos - i.wp);
  if (dot(n, v) < 0.0) { n = -n; }
  let nv = max(dot(n, v), 0.0);
  let fr = 0.045 + 0.955 * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  var c = envI(r, toLocal(r), i.lp, i.amb) * fr;
  let hv = normalize(v + F.sunDir);
  let nh = max(dot(n, hv), 0.0);
  c += sunIlluminance() * pow(nh, 3000.0) * 6.0 * fr;
  var absorb = 0.05;
  if (i.ids.x == 20u) {
    // faint dust / haze on the screen, lit by the sun
    let h = fbm(i.lp.xy * 9.0 + i.lp.z * 3.0);
    c += (sunIlluminance() * pow(max(dot(F.sunDir, -v), 0.0), 4.0) * 0.008 + i.amb * 0.012) * h * h;
    // screen coordinates: edges of the pane catch light along the brass frame
    let sp = vec2f(-i.lp.x, dot(i.lp - vec3f(${SCREEN.o.join(', ')}), vec3f(${SCREEN.U.join(', ')})));
    let sd = sdRect(sp - vec2f(0.0, ${SCR_H / 2}), vec2f(${SCR_W}, ${SCR_H / 2}), ${SCR_RC});
    let edge = exp(-abs(sd) / 0.012);
    c += (envSky(r) * 0.10 + sunIlluminance() * 0.004 * max(dot(n, F.sunDir), 0.0)) * edge;
    // two soft diagonal sheens of reflected sky (stylised glass cue), strongest high on the pane
    let dg = sp.x * 1.1 + sp.y;
    let s1 = (dg - 0.22) / 0.035; let s2 = (dg - 0.34) / 0.016;
    let sheen = (exp(-s1 * s1) + 0.6 * exp(-s2 * s2)) * smoothstep(0.02, 0.3, sp.y);
    let skyUp = envSky(toWorld(normalize(vec3f(0.0, 1.0, -0.4))));
    // (scene radiance ~ 0.1 x sun illuminance for the sunlit grass behind the pane)
    let glint = sunIlluminance() * vec3f(1.0, 0.97, 0.92) * 0.011 + skyUp * 0.03;
    c += skyUp * 0.008 + glint * sheen * 2.5;
    // the polished cut edge of the pane, just proud of the brass channel, catches the sky
    let ew = 0.0008; // ~1 px at the screen's distance from the eye
    let cut = sat(1.0 - abs(sd + 0.0135) / ew) ;
    c += (glint * 4.0 + sunIlluminance() * 0.01 * max(dot(n, F.sunDir), 0.0)) * cut;
    // slight green-grey tint: scattered sky light inside the glass
    c += i.amb * vec3f(0.45, 0.62, 0.58) * 0.02;
    absorb = 0.21 + 0.10 * edge + 0.05 * sheen;
  } else {
    // gauge glass: a soft crescent sheen near the upper rim (uv: x = angle / 2pi, y = radius)
    let ang = i.uv.x * 6.2831853;
    let cres = smoothstep(0.55, 0.85, i.uv.y) * (1.0 - smoothstep(0.92, 1.0, i.uv.y)) * pow(max(cos(ang - 2.1), 0.0), 3.0);
    // + a faint reflected ring of the brass bezel just inside the rim
    let bz = smoothstep(0.86, 0.97, i.uv.y) * (1.0 - smoothstep(0.97, 1.0, i.uv.y));
    c += envSky(normalize(toWorld(vec3f(0.0, 1.0, -0.3)))) * 0.11 * cres + envSky(r) * 0.03 + vec3f(0.8, 0.57, 0.27) * i.amb * 0.02 * bz;
    absorb = 0.08 + 0.12 * cres;
  }
  return vec4f(min(c, vec3f(48.0)), absorb);
}
`;

const SHADOW_LOCAL_WGSL = IU_STRUCT + /* wgsl */ `
@group(0) @binding(0) var<uniform> U: IU;
` + PART_FN + /* wgsl */ `
@vertex fn vsLocal(v: VIn) -> @builtin(position) vec4f {
  return U.light * (partM(v.ids.y) * vec4f(v.pos, 1.0));
}
`;

const SHADOW_WORLD_WGSL = () => SHADOW_HEADER + IU_STRUCT + /* wgsl */ `
@group(1) @binding(0) var<uniform> U: IU;
` + PART_FN + /* wgsl */ `
@vertex fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  return F.lightViewProj * (U.body * (partM(v.ids.y) * vec4f(v.pos, 1.0)));
}
`;

// ---------------------------------------------------------------------------------
// Runtime state (all preallocated)

const Q = new URLSearchParams(location.search);
const HIDE = /[?&]hide=[^&]*interior/.test(location.search);
const FAKE = Q.get('fakeaudio') === '1';
const DBG = new Float64Array(6); // [0] year pinned?, [1] year, [2] era (-1), [3] biome (-1), [4] sun az rel, [5] sun el
DBG[0] = Q.has('year') ? 1 : 0; DBG[1] = Number(Q.get('year')) || 0;
DBG[2] = Q.has('era') ? Number(Q.get('era')) : -1;
DBG[3] = Q.has('biome') ? Number(Q.get('biome')) : -1;
const YEARCLOCK = Q.get('yearclock') === '1';
const SUNREL = Q.has('sunrel');
if (SUNREL) { const s = Q.get('sunrel').split(','); DBG[4] = Number(s[0]) || 0; DBG[5] = Number(s[1]) || 0.3; }
const ISHDBG = Q.get('ishdbg') === '1';
const NOGLASS = /[?&]hide=[^&]*iglass/.test(location.search);
const ICAM = { hu: 1, gauges: 2, wheel: 3 }[Q.get('icam')] || 0;

const UF = new Float32Array(152);
const leadW = new Float64Array(6);
const spinPos = new Float64Array(6);
const SPIN_LO = 4, SPIN_HI = 9; // drum rates (digits/s) over which a drum crossfades to the capped spin
const SPIN_HZ = 6; // shown spin speed of fast drums, numerals per second
const levelsIn = new Float32Array(8);
let levelSrc = null;
const shown = new Float32Array(8), peak = new Float32Array(8), peakT = new Float64Array(8);
const T = new Float64Array(14); // [0] prev time, [1] shown V, [2] from V, [3] transition t0, [4] from plate, [5] plate, [6] prev V, [7] rate, [8] year mode, [9] last LCD second, [10] now, [11] dt, [12] drum spin clock
T[8] = -1; T[9] = -1;

const lcdData = new Uint8Array(LCD_TEX_W * LCD_TEX_H);
let lcdDirty = true;
let line1W = 0, line2W = 0, eraShown = -1, bioShown = -1;
const ERA_CODES = ERA_NAMES.map(toGlyphs); // the seven eras (world/time.js)
const BIOME_CODES = ['Savannah', 'Ice', 'Desert', 'Forest', 'Steppe', 'Mountains', 'Coast'].map(toGlyphs); // biome index 0-6
const SEP_CODES = toGlyphs(' · ');
const LINE1 = toGlyphs('Journey through time');
const line2 = new Int16Array(64);
const G_PLAY = glyphIndex(62), G_COLON = glyphIndex(58), G_0 = glyphIndex(48);

let ready = false;
let pipe, glassPipe, shWorldPipe, shLocalPipe;
let vbuf, ibuf, ubuf, bgMain, bgU, lcdTexG;
let nOpaque = 0, firstW = 0, nW = 0, baseW = 0, firstG = 0, nG = 0, baseG = 0;
const shPass = { colorAttachments: [], depthStencilAttachment: { view: null, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: undefined };
const lcdLayout = { offset: 0, bytesPerRow: LCD_TEX_W };
const lcdSize = [LCD_TEX_W, LCD_TEX_H];
let lcdDest = null;

export function setLevels(arr) { levelSrc = arr; }


// Registered synchronously at the start of initInterior (the callbacks wait for `ready`), so
// the cockpit is the first drawable of the main pass: it then hides the terrain, grass and
// props behind the dash from the depth test instead of being drawn over them.
function register() {
  if (HIDE) return;
  addPrePass({
    pre(enc) {
      if (!ready || state.view !== 1) return;
      shPass.timestampWrites = tsw();
      const p = enc.beginRenderPass(shPass);
      p.setPipeline(shLocalPipe); p.setBindGroup(0, bgU);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32');
      p.drawIndexed(nOpaque);
      p.end();
    },
  });
  addDrawable({
    shadow(p) {
      if (!ready || state.view !== 0) return;
      p.setPipeline(shWorldPipe); p.setBindGroup(1, bgU);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32'); p.drawIndexed(nOpaque);
    },
    main(p) {
      if (!ready) return;
      p.setPipeline(pipe); p.setBindGroup(1, bgMain);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32'); p.drawIndexed(nOpaque);
    },
    transparent(p) {
      if (!ready || NOGLASS) return;
      p.setPipeline(glassPipe); p.setBindGroup(1, bgMain);
      p.setVertexBuffer(0, vbuf); p.setIndexBuffer(ibuf, 'uint32');
      p.drawIndexed(nW, 1, firstW, baseW);
      p.drawIndexed(nG, 1, firstG, baseG);
    },
  });
}

export async function initInterior() {
  register();
  const d = gpu.device;
  const { m, g, gg } = buildInterior();
  // One vertex buffer: opaque, windscreen glass, gauge glass; one index buffer.
  const vb = new Uint8Array(m.vertices.length + g.vertices.length + gg.vertices.length);
  vb.set(m.vertices, 0); vb.set(g.vertices, m.vertices.length); vb.set(gg.vertices, m.vertices.length + g.vertices.length);
  const ib = new Uint32Array(m.indices.length + g.indices.length + gg.indices.length);
  ib.set(m.indices, 0); ib.set(g.indices, m.indices.length); ib.set(gg.indices, m.indices.length + g.indices.length);
  nOpaque = m.indices.length;
  firstW = m.indices.length; nW = g.indices.length; baseW = m.count;
  firstG = firstW + nW; nG = gg.indices.length; baseG = m.count + g.count;
  vbuf = d.createBuffer({ size: vb.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(vbuf, 0, vb);
  ibuf = d.createBuffer({ size: ib.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ibuf, 0, ib);
  ubuf = d.createBuffer({ size: UF.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Textures: cockpit shadow map, LCD dots, glyph atlas (mipmapped).
  const shTex = d.createTexture({ size: [2048, 2048], format: 'depth16unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  shPass.depthStencilAttachment.view = shTex.createView();
  lcdTexG = d.createTexture({ size: [LCD_TEX_W, LCD_TEX_H], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  lcdDest = { texture: lcdTexG };
  const lv = bakeAtlas();
  const atlas = d.createTexture({ size: [ATLAS_W, ATLAS_H], format: 'r8unorm', mipLevelCount: lv.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  lv.forEach((l, k) => d.queue.writeTexture({ texture: atlas, mipLevel: k }, l.data, { bytesPerRow: l.w }, [l.w, l.h]));
  const aSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const cmpSamp = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });

  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, FR = GPUShaderStage.FRAGMENT;
  const bglU = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
  const bglMain = d.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: FR, texture: { sampleType: 'depth' } },
    { binding: 2, visibility: FR, sampler: { type: 'comparison' } },
    { binding: 3, visibility: FR, texture: { sampleType: 'float' } },
    { binding: 4, visibility: FR, texture: { sampleType: 'float' } },
    { binding: 5, visibility: FR, sampler: { type: 'filtering' } },
  ] });
  bgU = d.createBindGroup({ layout: bglU, entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  bgMain = d.createBindGroup({ layout: bglMain, entries: [
    { binding: 0, resource: { buffer: ubuf } },
    { binding: 1, resource: shTex.createView() },
    { binding: 2, resource: cmpSamp },
    { binding: 3, resource: lcdTexG.createView() },
    { binding: 4, resource: atlas.createView() },
    { binding: 5, resource: aSamp },
  ] });

  const mod = d.createShaderModule({ label: 'interior', code: INTERIOR_WGSL() });
  const smodL = d.createShaderModule({ label: 'interior-sh-local', code: SHADOW_LOCAL_WGSL });
  const smodW = d.createShaderModule({ label: 'interior-sh-world', code: SHADOW_WORLD_WGSL() });
  const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  [pipe, glassPipe, shWorldPipe, shLocalPipe] = await Promise.all([
    mainPipeline({ label: 'interior', module: mod, layouts: [bglMain], buffers: VLAYOUT, cullMode: 'none' }),
    mainPipeline({ label: 'interior-glass', module: mod, fragment: 'fsGlass', layouts: [bglMain], buffers: VLAYOUT, cullMode: 'none', depthWrite: false, blend }),
    shadowPipeline({ label: 'interior-sh', module: smodW, vertex: 'vsShadow', layouts: [bglU], buffers: VLAYOUT }),
    d.createRenderPipelineAsync({
      label: 'interior-sh-local',
      layout: d.createPipelineLayout({ bindGroupLayouts: [bglU] }),
      vertex: { module: smodL, entryPoint: 'vsLocal', buffers: VLAYOUT },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth16unorm', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5, depthBiasClamp: 0 },
    }),
  ]);

  // static LCD text: small 'NOW PLAYING:' label + source, and the title
  drawSmall(lcdData, LCD_TEX_W, 0, 24, 'NOW PLAYING:', 255);
  drawSmall(lcdData, LCD_TEX_W, 136 - smallWidth('USB'), 24, 'USB', 150);
  line1W = runWidth(LINE1);
  drawRun(lcdData, LCD_TEX_W, 0, 0, LINE1, LINE1.length, 255);
}

// ---------------------------------------------------------------------------------
// Per frame

// Writes frame(F) * RotZ(FA[0]) * T(0, 0, FA[1]) into UF at `off` (car-local, column-major).
// (Doubles travel in FA: passing them as arguments would box them every frame.)
const FA = new Float64Array(2);
function frameMat(off, F) {
  const c = Math.cos(FA[0]), s = Math.sin(FA[0]), R = F.R, Uv = F.U, N = F.N, o = F.o, dz = FA[1];
  for (let k = 0; k < 3; k++) {
    UF[off + k] = R[k] * c + Uv[k] * s;
    UF[off + 4 + k] = -R[k] * s + Uv[k] * c;
    UF[off + 8 + k] = N[k];
    UF[off + 12 + k] = o[k] + N[k] * dz;
  }
  UF[off + 3] = 0; UF[off + 7] = 0; UF[off + 11] = 0; UF[off + 15] = 1;
}
const SPEEDO_F = fasciaFrame(SPEEDO_X, GAUGE_Y);

// Design anchors (clock s, year) used only by the ?yearclock=1 debug flag.
const ANCH = [0, -300000, 30, -40000, 40, -10000, 55, -9000, 80, -3000, 85, -2650, 100, -2500, 120, 500, 165, 1450, 210, 1750, 255, 1914, 300, 2026];
const YA = new Float64Array(1);
function yearAt() {
  const c = state.clock;
  YA[0] = ANCH[ANCH.length - 1];
  if (c <= 0) { YA[0] = ANCH[1]; return; }
  for (let k = 2; k < ANCH.length; k += 2) if (c <= ANCH[k]) { const t = (c - ANCH[k - 2]) / (ANCH[k] - ANCH[k - 2]); YA[0] = ANCH[k - 1] + (ANCH[k + 1] - ANCH[k - 1]) * t; return; }
}

function updateLcdText() {
  // line 2: era · biome (only when either changes)
  let era = DBG[2] >= 0 ? DBG[2] : state.eraIdx;
  if (YEARCLOCK && DBG[2] < 0) era = eraAt(state.clock);
  era = Math.max(0, Math.min(ERA_CODES.length - 1, era | 0));
  let bio = DBG[3] >= 0 ? DBG[3] : (state.biomeBlend > 0.5 ? state.biomeB : state.biomeA);
  bio = Math.max(0, Math.min(BIOME_CODES.length - 1, bio | 0));
  if (era !== eraShown || bio !== bioShown) {
    eraShown = era; bioShown = bio;
    let n = 0;
    const e = ERA_CODES[era], b = BIOME_CODES[bio];
    for (let k = 0; k < e.length; k++) line2[n++] = e[k];
    for (let k = 0; k < SEP_CODES.length; k++) line2[n++] = SEP_CODES[k];
    for (let k = 0; k < b.length; k++) line2[n++] = b[k];
    line2W = runWidth(line2, n);
    lcdData.fill(0, 8 * LCD_TEX_W, 15 * LCD_TEX_W);
    drawRun(lcdData, LCD_TEX_W, 0, 8, line2, n, 255);
    lcdDirty = true;
  }
  // status: play icon + elapsed journey time mm:ss
  const sec = Math.max(0, Math.floor(state.clock));
  if (sec !== T[9]) {
    T[9] = sec;
    lcdData.fill(0, 16 * LCD_TEX_W, 23 * LCD_TEX_W);
    drawGlyph(lcdData, LCD_TEX_W, 0, 16, G_PLAY, 255);
    const mm = Math.floor(sec / 60) % 100, ss = sec % 60;
    let x = 9;
    x = drawGlyph(lcdData, LCD_TEX_W, x, 16, G_0 + Math.floor(mm / 10), 255) + 1;
    x = drawGlyph(lcdData, LCD_TEX_W, x, 16, G_0 + mm % 10, 255) + 1;
    x = drawGlyph(lcdData, LCD_TEX_W, x, 16, G_COLON, 255) + 1;
    x = drawGlyph(lcdData, LCD_TEX_W, x, 16, G_0 + Math.floor(ss / 10), 255) + 1;
    drawGlyph(lcdData, LCD_TEX_W, x, 16, G_0 + ss % 10, 255);
    lcdDirty = true;
  }
  if (lcdDirty) {
    lcdDirty = false;
    gpu.device.queue.writeTexture(lcdDest, lcdData, lcdLayout, lcdSize);
  }
}

function marquee(off, w, phase) {
  const now = T[10] + phase * 0.8;
  const avail = 136;
  if (w <= avail) { UF[off] = 0; UF[off + 2] = 100000; return; }
  // (fallback only: every current title / era · biome line fits) dot-step scroll with a
  // 28-dot gap before the wrap and a 3 s hold on the left-aligned text each cycle
  const P = Math.min(256, w + 28), speed = 14, pause = 3.0;
  const cyc = P / speed + pause;
  const tc = now - Math.floor(now / cyc) * cyc;
  UF[off] = tc < pause ? 0 : Math.floor((tc - pause) * speed) % P;
  UF[off + 2] = P;
}

function updateLevels() {
  const now = T[10], dt = T[11];
  if (FAKE) {
    const now = T[10] + state.clock * 3.17 + DBG[1] * 0.0131; // differs between fixed poses that share state.time
    const beat = now * 1.75;
    const ph = beat - Math.floor(beat);
    const kick = Math.exp(-ph * 7);
    const hp = beat * 2 + 0.5, hat = Math.exp(-(hp - Math.floor(hp)) * 12);
    for (let k = 0; k < 8; k++) {
      const wob = 0.5 + 0.5 * Math.sin(now * (1.1 + k * 0.63) + k * 1.9) * Math.sin(now * 0.31 + k * 0.7);
      let v = (0.62 - k * 0.05) * (0.45 + 0.55 * wob);
      if (k < 3) v += kick * (0.42 - k * 0.12);
      if (k > 5) v += hat * 0.3;
      levelsIn[k] = Math.min(1, Math.max(0, v));
    }
  } else if (levelSrc) {
    for (let k = 0; k < 8; k++) { const v = levelSrc[k]; levelsIn[k] = v > 0 ? (v < 1 ? v : 1) : 0; }
  } else levelsIn.fill(0);
  for (let k = 0; k < 8; k++) {
    const L = levelsIn[k];
    // (dt = 0: a still pose re-rendering one instant: show the level itself, no hold)
    // (branch-free selects: see the allocation note in prepareInterior)
    const fall = Math.max(L, shown[k] - dt * 1.8), cUp = L > shown[k], still = dt === 0;
    shown[k] = cUp ? L : still ? L : fall;
    peak[k] = still ? L : peak[k];
    const s2 = shown[k], p2 = peak[k], cPk = s2 >= p2;
    const decay = Math.max(s2, p2 - dt * 0.9), held = now - peakT[k] > 0.7;
    peak[k] = cPk ? s2 : held ? decay : p2;
    peakT[k] = cPk ? now : peakT[k];
    const h = Math.round(shown[k] * 6), pk = Math.round(peak[k] * 6);
    UF[92 + k] = h;
    UF[100 + k] = pk > h ? pk : 0;
  }
}

const tmp3 = new Float64Array(3);
function carPoint(x, y, z) { // debug cameras only
  const b = bodyMat;
  tmp3[0] = b[0] * x + b[4] * y + b[8] * z + b[12];
  tmp3[1] = b[1] * x + b[5] * y + b[9] * z + b[13];
  tmp3[2] = b[2] * x + b[6] * y + b[10] * z + b[14];
}

export function prepareInterior() {
  if (!ready) { ready = !!pipe; if (!ready) return; }
  const now = state.time;
  let dt = now - T[0];
  T[0] = now;
  if (!(dt > 0) || dt > 0.25) dt = 0;
  T[10] = now; T[11] = dt;

  // Debug: sun relative to the car, close-up cameras (debug flags only).
  if (SUNREL) {
    env.sunAzimuth = pose[3] + DBG[4]; env.sunElevation = DBG[5]; updateSun();
    updateCamera(camera);
  }
  if (ICAM) {
    if (ICAM === 1) { carPoint(0.13, 1.06, -0.16); camera.eye[0] = tmp3[0]; camera.eye[1] = tmp3[1]; camera.eye[2] = tmp3[2]; carPoint(0.0, HU_Y, fz(HU_Y)); camera.fovY = 0.34; }
    else if (ICAM === 2) { carPoint(0.36, 1.13, -0.22); camera.eye[0] = tmp3[0]; camera.eye[1] = tmp3[1]; camera.eye[2] = tmp3[2]; carPoint(0.355, GAUGE_Y, fz(GAUGE_Y)); camera.fovY = 0.5; }
    else { carPoint(0.30, 1.30, -0.62); camera.eye[0] = tmp3[0]; camera.eye[1] = tmp3[1]; camera.eye[2] = tmp3[2]; carPoint(0.36, 1.03, -0.1); camera.fovY = 0.75; }
    camera.target[0] = tmp3[0]; camera.target[1] = tmp3[1]; camera.target[2] = tmp3[2];
    updateCamera(camera);
  }

  UF.set(bodyMat, 0);
  // clip = viewProj * body (column-major), in doubles
  const VP = camera.viewProj, BM = bodyMat;
  for (let c = 0; c < 4; c++) {
    const b0 = BM[c * 4], b1 = BM[c * 4 + 1], b2 = BM[c * 4 + 2], b3 = BM[c * 4 + 3];
    for (let r = 0; r < 4; r++) UF[128 + c * 4 + r] = VP[r] * b0 + VP[4 + r] * b1 + VP[8 + r] * b2 + VP[12 + r] * b3;
  }
  // steering wheel: variable ratio so the wheel visibly turns at cruising speed
  const v = Math.abs(pose[16]);
  const sp = Math.max(v, 2);
  const maxSteer = Math.min(0.55, Math.atan(2.7 * 10 / (sp * sp)));
  const u = Math.max(-1.25, Math.min(1.25, pose[6] / maxSteer));
  const lock = 1.5 + 2.6 * Math.max(0, Math.min(1, 1 - (v - 4) / 16));
  FA[0] = -u * lock; FA[1] = 0; frameMat(16, WHEEL);
  // speedometer needle (0..240 km/h over 260 degrees), slight flutter
  const kmh = v * 3.6;
  const th = (-130 + Math.min(kmh, 250) / 240 * 260) * Math.PI / 180 + Math.sin(now * 29) * 0.004 * Math.min(1, kmh / 60);
  FA[0] = -th; FA[1] = 0.0146; frameMat(32, SPEEDO_F);

  // cockpit shadow: ortho in car-local space around the cockpit
  const b = bodyMat, sd = env.sunDir;
  let lx = sd[0] * b[0] + sd[1] * b[1] + sd[2] * b[2];
  let ly = sd[0] * b[4] + sd[1] * b[5] + sd[2] * b[6];
  let lz = sd[0] * b[8] + sd[1] * b[9] + sd[2] * b[10];
  const ll = 1 / Math.sqrt(lx * lx + ly * ly + lz * lz); lx *= ll; ly *= ll; lz *= ll;
  // ax = normalize(cross(sun, up)), ay = cross(ax, sun)
  let ax = -lz, ay = 0, az = lx;
  let al = Math.sqrt(ax * ax + az * az);
  if (al < 1e-3) { ax = 1; az = 0; al = 1; }
  ax /= al; az /= al;
  const bx = ay * lz - az * ly, by = az * lx - ax * lz, bz = ax * ly - ay * lx;
  const R = 1.26, Dz = 2.5, cx = 0, cy = 1.06, cz = -0.22;
  UF[48] = ax / R; UF[52] = ay / R; UF[56] = az / R; UF[60] = -(ax * cx + ay * cy + az * cz) / R;
  UF[49] = bx / R; UF[53] = by / R; UF[57] = bz / R; UF[61] = -(bx * cx + by * cy + bz * cz) / R;
  UF[50] = -lx / (2 * Dz); UF[54] = -ly / (2 * Dz); UF[58] = -lz / (2 * Dz); UF[62] = 0.5 + (lx * cx + ly * cy + lz * cz) / (2 * Dz);
  UF[51] = 0; UF[55] = 0; UF[59] = 0; UF[63] = 1;
  UF[64] = lx; UF[65] = ly; UF[66] = lz; UF[67] = state.view === 1 ? 1 : 0;

  // year counter
  if (YEARCLOCK) yearAt();
  const year = DBG[0] ? DBG[1] : YEARCLOCK ? YA[0] : state.year;
  // (Allocation note: the rarely taken paths below (era flip, fast drums) only select values
  // computed unconditionally. A binary op or compare first reached inside a rare branch deopts
  // the optimised code ("insufficient type feedback"), and back in the interpreter every double
  // is a heap allocation until it re-optimises many seconds later.)
  const cM0 = year < -10000, cM1 = year < 0;
  const mode = cM0 ? 0 : cM1 ? 1 : 2;
  const vBce = 2000 - year, vNeg = -year;
  const Vt = mode === 0 ? vBce : mode === 1 ? vNeg : year;
  if (T[8] < 0) { T[8] = mode; T[1] = Vt; T[5] = mode; T[3] = -1; T[6] = Vt; }
  {
    const flip = mode !== T[8];
    T[2] = flip ? T[1] : T[2]; T[4] = flip ? T[5] : T[4]; T[3] = flip ? now : T[3]; T[8] = mode;
    const t3 = T[3], w = (now - t3) / 0.9;
    const s = w * w * (3 - 2 * w);
    const v1 = T[2] + (Vt - T[2]) * s, v5 = T[4] + (mode - T[4]) * s;
    const a1 = t3 >= 0, a2 = w < 1, a3 = w >= 0, a4 = dt > 0;
    // frozen time (pose, pause): show the target, never a stale mid-flip
    const active = a1 ? (a2 ? (a3 ? a4 : false) : false) : false;
    T[3] = active ? t3 : -1;
    T[1] = active ? v1 : Vt; T[5] = active ? v5 : mode;
  }
  if (dt > 0) { const rate = (T[1] - T[6]) / dt; T[7] += (rate - T[7]) * Math.min(1, dt * 12); }
  T[6] = T[1];
  const V = Math.max(0, T[1]);
  const dir = T[7] < 0 ? -1 : 1;
  T[12] += dt * SPIN_HZ;
  const spinTick = Math.floor(T[12]), sfr = T[12] - spinTick;
  const sfe0 = (sfr - 0.8) / 0.2;
  const sfe = Math.max(0, sfe0); // (= sfr < 0.8 ? 0 : sfe0, but never a Smi 0 that later deopts as "not a Smi")
  const spinEase = sfe * sfe * (3 - 2 * sfe);
  let p10 = 1;
  for (let k = 0; k < 6; k++) {
    let pos;
    // geared like a real counter: the units drum rests on each numeral and flicks over in the
    // last 30 % of the year; higher drums carry during that same flick
    const q = Math.floor(V / p10);
    const low = V - q * p10;
    const fl = Math.max(0, Math.min(1, (low - (p10 - 1) - 0.7) / 0.3));
    pos = q - Math.floor(q / 10) * 10 + fl * fl * (3 - 2 * fl);
    // A drum turning faster than the eye can follow shows numerals scrolling past at a
    // capped speed (crossfaded in as its true rate climbs), never a blank grey blur.
    const r = Math.abs(T[7]) / p10; // digits per second
    const wr = (r - SPIN_LO) / (SPIN_HI - SPIN_LO), cLo = r < SPIN_LO, cHi = r > SPIN_HI;
    const w = Math.min(1, Math.max(0, wr)); // (= cLo ? 0 : cHi ? 1 : wr, always a double)
    // all spinning drums tick together on one shared clock (SPIN_HZ numerals a second), each
    // resting on a numeral and flicking to the next in the last 20 % of the tick
    const sp0 = pos - dir * spinTick;
    spinPos[k] = w === 0 ? sp0 : spinPos[k];
    let sp = spinPos[k] + dir * (spinTick + spinEase);
    sp -= Math.floor(sp / 10) * 10;
    UF[68 + 5 - k] = pos;
    UF[76 + 5 - k] = r / 60;
    UF[112 + 5 - k] = w === 0 ? pos : sp;
    UF[120 + 5 - k] = w * w * (3 - 2 * w);
    // leading zeros (never the units drum) fade back so 476 CE reads as 476, not 000476
    const lt = k > 0 && V < p10 - 0.5 ? 1 : 0;
    leadW[k] = dt === 0 ? lt : leadW[k] + (lt - leadW[k]) * Math.min(1, dt * 5);
    UF[144 + 5 - k] = leadW[k];
    p10 *= 10;
  }
  UF[74] = T[5]; UF[82] = 0; UF[75] = 0; UF[83] = 0;

  // LCD
  updateLcdText();
  marquee(84, line1W, 0);
  marquee(85, line2W, 1);
  UF[88] = 1.0; UF[89] = 1.0;
  updateLevels();
  UF[108] = partMat[8 * 16] || 1.6; UF[109] = now; UF[110] = ISHDBG ? 1 : 0; UF[111] = partMat[8 * 16 + 2] || 1;
  gpu.device.queue.writeBuffer(ubuf, 0, UF);
}
