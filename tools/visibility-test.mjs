// Landmark visibility from the road: for each landmark the autopilot drives past (seeds and
// landmass options below), over the last 400 m of road before the point abreast of it, the
// fraction of the approach during which its bounding volume is inside the chase camera's view
// and not hidden (at least half of five points on it - centre, top, the two sides, low - have
// a clear line from the eye over the terrain and past the settlement buildings standing then,
// window.__settle.occluders), and its on-screen height (px at 1080p) at 300, 150 and 80 m.
// Trees and grass are not in the measure (no CPU copy of them): see the captures.
//   node tools/visibility-test.mjs [--seeds=1-8] [--no-build] [--before (no sight wedges, old placement)] [--json=out.json]
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
import { EVENTS } from '../src/world/time.js';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const [a, b] = arg('seeds', '1-8').split('-').map(Number);
const srv = await serveDist();
const run = await launch('chromium');
const per = {};
try {
  for (const land of [-1, 2]) {
    for (let seed = a; seed <= (b || a); seed++) {
      await openGame(run.page, srv.url, `?script=1&capture=1&seed=${seed}${land >= 0 ? '&land=' + land : ''}${process.argv.includes('--before') ? '&nosight=1&noclear=1' : ''}`);
      await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
      const res = await run.page.evaluate(() => {
        const g = window.__game, D = window.__drive, W = window.__world, ST = window.__settle;
        const cam = g.camera, recs = {}, visited = new Set();
        let sites = [], occ = [], occAt = -1e9;
        const proj = (x, y, z) => { const m = cam.viewProj; const w = m[3] * x + m[7] * y + m[11] * z + m[15]; return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w]; };
        const clear = (ex, ey, ez, px, py, pz) => {
          for (let k = 1; k < 14; k++) { const t = k / 14 * 0.88; const x = ex + (px - ex) * t, z = ez + (pz - ez) * t, y = ey + (py - ey) * t; if (W.groundAt(x, z).h > y) return false; }
          for (const o of occ) {
            const c = Math.cos(o[2]), s = Math.sin(o[2]);
            const lx0 = (ex - o[0]) * c + (ez - o[1]) * s, lz0 = -(ex - o[0]) * s + (ez - o[1]) * c;
            const lx1 = (px - o[0]) * c + (pz - o[1]) * s, lz1 = -(px - o[0]) * s + (pz - o[1]) * c;
            let t0 = 0, t1 = 1;
            for (const [p0, p1, h] of [[lx0, lx1, o[3]], [lz0, lz1, o[4]]]) {
              const dd = p1 - p0;
              if (Math.abs(dd) < 1e-9) { if (Math.abs(p0) > h) { t0 = 2; break; } continue; }
              let ta = (-h - p0) / dd, tb = (h - p0) / dd; if (ta > tb) [ta, tb] = [tb, ta];
              t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
            }
            if (t0 > t1 || t0 > 1) continue;
            const gy = W.groundAt(o[0], o[1]).h, y = ey + (py - ey) * t0;
            if (y < gy + o[5]) return false;
          }
          return true;
        };
        for (let t = 0; t <= 302; t += 0.25) {
          const clock = g.dryStep(t);
          const p = D.pose(); visited.add(p.cur);
          if (Math.round(t * 4) % 4 === 0) sites = g.sites().sites.filter((s) => s.stage === 'live' && s.visible && !s.home && s.top > 0);
          const dist = g.state.distance;
          for (const s of sites) {
            const d = s.journey - dist;
            if (d < 0 || d > 400) continue;
            if (Math.abs(clock - occAt) > 0.9) { occ = ST.occluders(cam.eye[0], cam.eye[2], 900, clock); occAt = clock; }
            const key = s.ev + ':' + s.edge + ':' + s.s;
            const r = recs[key] || (recs[key] = { ev: s.ev, id: s.id, edge: s.edge, n: 0, vis: 0, inView: 0, h: {} });
            const [ox, oy, oz] = s.pos, H = s.top, R = Math.max(4, 0.5 * s.foot);
            const ex = cam.eye[0], ey = cam.eye[1], ez = cam.eye[2];
            let vx = ox - ex, vz = oz - ez; const vl = Math.hypot(vx, vz) || 1; vx /= vl; vz /= vl;
            const P = [[ox, oy + 0.5 * H, oz], [ox, oy + 0.85 * H, oz], [ox - vz * R * 0.6, oy + 0.35 * H, oz + vx * R * 0.6], [ox + vz * R * 0.6, oy + 0.35 * H, oz - vx * R * 0.6], [ox, oy + 0.15 * H, oz]];
            let inV = 0, ok = 0;
            for (const q of P) { const n = proj(q[0], q[1], q[2]); if (n[2] > 0 && Math.abs(n[0]) < 0.97 && Math.abs(n[1]) < 0.97) { inV++; if (clear(ex, ey, ez, q[0], q[1], q[2])) ok++; } }
            r.n++; if (inV > 0) r.inView++; if (inV > 0 && ok >= Math.max(1, Math.ceil(inV / 2))) r.vis++;
            for (const D0 of [300, 150, 80]) if (Math.abs(d - D0) < 6 && r.h[D0] === undefined) { const a0 = proj(ox, oy, oz), a1 = proj(ox, oy + H, oz); r.h[D0] = a0[2] > 0 && a1[2] > 0 ? Math.round(Math.abs(a1[1] - a0[1]) / 2 * 1080) : 0; }
          }
        }
        return Object.values(recs).filter((r) => visited.has(r.edge) && r.n > 20);
      });
      for (const r of res) (per[r.id] || (per[r.id] = [])).push(r);
    }
  }
  console.log('landmark          runs  in view  seen (in view, unoccluded)  height px @300 / 150 / 80 m');
  const out = {};
  for (const k of EVENTS.map((e) => e.key)) {
    const L = per[k]; if (!L) continue;
    const f = (x) => (x / L.length);
    const inV = f(L.reduce((s, r) => s + r.inView / r.n, 0)), vis = f(L.reduce((s, r) => s + r.vis / r.n, 0));
    const hh = [300, 150, 80].map((D0) => { const v = L.map((r) => r.h[D0]).filter((x) => x !== undefined).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : '-'; });
    out[k] = { runs: L.length, inView: +inV.toFixed(2), seen: +vis.toFixed(2), px: hh };
    console.log(`  ${k.padEnd(16)} ${String(L.length).padStart(4)}  ${(inV * 100).toFixed(0).padStart(5)}%  ${(vis * 100).toFixed(0).padStart(5)}%                      ${hh.join(' / ')}`);
  }
  if (arg('json', '')) writeFileSync(arg('json', ''), JSON.stringify(out, null, 1));
} finally { await run.browser.close(); srv.close(); }
