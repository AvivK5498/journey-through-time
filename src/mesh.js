// Tiny procedural mesh builder (load time only; allocates freely, never per frame).
// Vertex format (32 bytes): position xyz, normal xyz, material id, extra (part id / AO).
// Shapes are parametric surfaces (u, v) -> point with numerically derived normals, placed
// with a current 3x4 transform.

export const VERTEX_LAYOUT = [{
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
  ],
}];

export class MeshBuilder {
  constructor() {
    this.v = []; // flat floats, 8 per vertex
    this.i = [];
    this.m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; // 3x3 (columns) + translation
    this.mat = 0;
    this.extra = 0;
  }
  get count() { return this.v.length / 8; }
  // Sets the transform: rotation by yaw (about y), pitch (about x), roll (about z), then
  // translation; scale s (number or [x, y, z]) is applied first.
  place(tx = 0, ty = 0, tz = 0, yaw = 0, pitch = 0, roll = 0, s = 1) {
    const [sx, sy, sz] = typeof s === 'number' ? [s, s, s] : s;
    const cy = Math.cos(yaw), sY = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry * Rx * Rz
    const Rz = [cr, sr, 0, -sr, cr, 0, 0, 0, 1];
    const Rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
    const Ry = [cy, 0, -sY, 0, 1, 0, sY, 0, cy];
    const mul = (a, b) => { const o = []; for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]; return o; };
    const R = mul(Ry, mul(Rx, Rz));
    this.m = [R[0] * sx, R[1] * sx, R[2] * sx, R[3] * sy, R[4] * sy, R[5] * sy, R[6] * sz, R[7] * sz, R[8] * sz, tx, ty, tz];
    this.ns = [sx, sy, sz];
    return this;
  }
  xf(p) {
    const m = this.m;
    return [m[0] * p[0] + m[3] * p[1] + m[6] * p[2] + m[9], m[1] * p[0] + m[4] * p[1] + m[7] * p[2] + m[10], m[2] * p[0] + m[5] * p[1] + m[8] * p[2] + m[11]];
  }
  xn(n) {
    const m = this.m, s = this.ns || [1, 1, 1];
    // inverse-transpose for scaled axes: divide by scale squared along each axis
    const a = n[0] / (s[0] * s[0]), b = n[1] / (s[1] * s[1]), c = n[2] / (s[2] * s[2]);
    const x = m[0] * a + m[3] * b + m[6] * c, y = m[1] * a + m[4] * b + m[7] * c, z = m[2] * a + m[5] * b + m[8] * c;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }
  vert(p, n, mat = this.mat, extra = this.extra) {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], mat, extra);
    return this.count - 1;
  }
  // Parametric surface f(u, v) -> [x, y, z] in local space, u in [0,1] (nu segments),
  // v in [0,1] (nv segments). Normals from finite differences (flip with `flip`).
  surface(nu, nv, f, { flip = false, closeU = false } = {}) {
    const base = this.count;
    const e = 1e-3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        const p = f(u, v);
        const u0 = Math.max(0, u - e), u1 = Math.min(1, u + e), v0 = Math.max(0, v - e), v1 = Math.min(1, v + e);
        let pu0 = f(u0, v), pu1 = f(u1, v);
        if (closeU && (u === 0 || u === 1)) { pu0 = f(1 - e, v); pu1 = f(e, v); }
        let du = sub(pu1, pu0), dv = sub(f(u, v1), f(u, v0));
        // Poles: fall back to a neighbouring row for the degenerate direction.
        if (len(du) < 1e-7) du = sub(f(u1, v > 0.5 ? v - 0.02 : v + 0.02), f(u0, v > 0.5 ? v - 0.02 : v + 0.02));
        let n = norm(cross(du, dv));
        if (flip) n = [-n[0], -n[1], -n[2]];
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
  // Ellipsoid-ish blob centred at the origin with radii r and an optional displacement.
  blob(rx, ry, rz, nu = 16, nv = 10, disp = null, squashBelow = 1) {
    return this.surface(nu, nv, (u, v) => {
      const th = u * Math.PI * 2, ph = v * Math.PI;
      let x = Math.sin(ph) * Math.cos(th), y = Math.cos(ph), z = Math.sin(ph) * Math.sin(th);
      const k = disp ? 1 + disp(x, y, z) : 1;
      return [x * rx * k, y * ry * k * (y < 0 ? squashBelow : 1), z * rz * k];
    }, { closeU: true });
  }
  // Superellipsoid (rounded box) with half-extents and squareness e (0.1 boxy .. 1 round).
  rbox(hx, hy, hz, e = 0.25, nu = 20, nv = 12) {
    const sp = (w, m) => Math.sign(w) * Math.pow(Math.abs(w), m);
    return this.surface(nu, nv, (u, v) => {
      const th = u * Math.PI * 2 - Math.PI, ph = v * Math.PI - Math.PI / 2;
      const cp = Math.cos(ph), sP = Math.sin(ph);
      return [hx * sp(cp, e) * sp(Math.cos(th), e), -hy * sp(sP, e), hz * sp(cp, e) * sp(Math.sin(th), e)];
    }, { closeU: true });
  }
  // Tube along a path: path(t) -> [x, y, z], radius(t). Ends capped by converging.
  tube(path, radius, nu = 8, nv = 8) {
    return this.surface(nu, nv, (u, t) => {
      const p = path(t);
      const q = path(Math.min(1, t + 0.01)), q0 = path(Math.max(0, t - 0.01));
      const tg = norm(sub(q, q0));
      const ref = Math.abs(tg[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const b1 = norm(cross(tg, ref)), b2 = cross(tg, b1);
      const a = u * Math.PI * 2, r = radius(t);
      return [p[0] + (b1[0] * Math.cos(a) + b2[0] * Math.sin(a)) * r, p[1] + (b1[1] * Math.cos(a) + b2[1] * Math.sin(a)) * r, p[2] + (b1[2] * Math.cos(a) + b2[2] * Math.sin(a)) * r];
    }, { closeU: true });
  }
  // Surface of revolution about +y: profile(v) -> [radius, y], with angular wobble(theta, v).
  lathe(profile, nu = 16, nv = 12, wobble = null) {
    return this.surface(nu, nv, (u, v) => {
      const th = u * Math.PI * 2;
      const [r0, y] = profile(v);
      const r = r0 * (wobble ? 1 + wobble(th, v) : 1);
      return [Math.cos(th) * r, y, Math.sin(th) * r];
    }, { closeU: true, flip: true });
  }
  // Torus around the local z axis (ring in the xy plane): major radius R, minor r.
  torus(R, r, nu = 32, nv = 10) {
    return this.surface(nu, nv, (u, v) => {
      const a = u * Math.PI * 2, b = v * Math.PI * 2;
      const rr = R + r * Math.cos(b);
      return [Math.cos(a) * rr, Math.sin(a) * rr, r * Math.sin(b)];
    }, { closeU: true });
  }
  // Cylinder along local z from z0 to z1 with radius r (capped).
  cyl(r, z0, z1, nu = 16, caps = true) {
    this.surface(nu, 1, (u, v) => { const a = u * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r, z0 + (z1 - z0) * v]; }, { closeU: true });
    if (caps) {
      for (const [z, s] of [[z0, -1], [z1, 1]]) {
        const c = this.vert(this.xf([0, 0, z]), this.xn([0, 0, s]));
        const ring = [];
        for (let i = 0; i <= nu; i++) { const a = i / nu * Math.PI * 2; ring.push(this.vert(this.xf([Math.cos(a) * r, Math.sin(a) * r, z]), this.xn([0, 0, s]))); }
        for (let i = 0; i < nu; i++) { if (s > 0) this.i.push(c, ring[i], ring[i + 1]); else this.i.push(c, ring[i + 1], ring[i]); }
      }
    }
    return this;
  }
  // Flat quad from corner p0 along edges ea, eb; front side (and n) is cross(ea, eb).
  quad(p0, ea, eb, n) {
    const a = this.vert(this.xf(p0), this.xn(n));
    const b = this.vert(this.xf(add(p0, ea)), this.xn(n));
    const c = this.vert(this.xf(add(add(p0, ea), eb)), this.xn(n));
    const d = this.vert(this.xf(add(p0, eb)), this.xn(n));
    this.i.push(a, b, c, a, c, d);
    return this;
  }
  build() { return { vertices: new Float32Array(this.v), indices: new Uint32Array(this.i) }; }
}

export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function len(a) { return Math.hypot(a[0], a[1], a[2]); }
export function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// Concatenates several built meshes into one buffer pair; returns ranges for drawIndexed.
export function packMeshes(list) {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.vertices.length; ni += m.indices.length; }
  const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
  const ranges = [];
  let ov = 0, oi = 0;
  for (const m of list) {
    vertices.set(m.vertices, ov);
    indices.set(m.indices, oi);
    ranges.push({ firstIndex: oi, indexCount: m.indices.length, baseVertex: ov / 8 });
    ov += m.vertices.length; oi += m.indices.length;
  }
  return { vertices, indices, ranges };
}
