// Passage captures (round three): for each era style (early gorge / cave, masonry, brick,
// modern) the first passage the autopilot drives through: the approach to the portal, inside
// (chase and first person), the emergence into the new biome, and a high view of the ridge.
//   node tools/tunnel-shot.mjs [--page=index.html] [--seeds=1-12] [--browser=brave]
// Writes 1920x1080 PNGs to reports/round3/tunnels/.
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, serveDist, launch } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const PAGE = arg('page', 'index.html');
const [s0, s1] = arg('seeds', '1-12').split('-').map(Number);
const OUT = join(ROOT, 'reports/round3/tunnels');
mkdirSync(OUT, { recursive: true });
const GROUPS = [[0, 1, 'gorge'], [2, 3, 'masonry'], [4, 5, 'brick'], [6, 6, 'modern']];

const srv = await serveDist();
const run = await launch(arg('browser', 'brave'));
const p = run.page;
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
async function open(seed, view) {
  await p.goto(srv.url + `${PAGE}?script=1&capture=1&seed=${seed}&view=${view}`);
  await p.waitForFunction(() => window.__captureReady || window.__gpuError, null, { timeout: 120000 });
}
const step = (t) => p.evaluate((t) => window.__step(t), t);
async function goTo(t) { for (let u = Math.max(0, t - 2); u < t; u += 0.1) await step(u); for (let k = 0; k < 3; k++) await step(t); }
async function shot(name) {
  const f = join(OUT, name + '.png');
  await p.screenshot({ path: f });
  execSync(`sips -Z 1920 '${f}' >/dev/null`);
  console.log('wrote', f);
}

const found = new Map();
for (let seed = s0; seed <= s1 && found.size < GROUPS.length; seed++) {
  await open(seed, 0);
  let prevA = null;
  for (let t = 0; t <= 300 && found.size < GROUPS.length; t += 0.5) {
    await step(t);
    const r = await p.evaluate(() => {
      const T = window.__tunnel, d = window.__drive.pose(), E = T.edges().find((e) => e.e === d.track);
      if (!E || E.tunS < 0) return null;
      const u = T.info().tunnels.find((x) => x.edge === d.track);
      const c = T.at(d.track, E.tunS, 0);
      const a = (d.x - c[0]) * Math.cos(c[3]) + (d.z - c[2]) * Math.sin(c[3]);
      return { a, lh: E.tunH, style: u ? u.style : -1, e: d.track, c, parent: E.parent, region: E.region };
    });
    if (r && prevA !== null && prevA < 0 && r.a >= 0) {
      const g = GROUPS.findIndex(([a, b]) => r.style >= a && r.style <= b);
      if (g >= 0 && !found.has(g)) { found.set(g, { seed, t: t - r.a / 40, ...r }); console.log(`${GROUPS[g][2]}: seed ${seed} t ${(t - r.a / 40).toFixed(1)} style ${r.style} ${r.parent}->${r.region}`); }
    }
    prevA = r ? r.a : null;
  }
}
for (const [g, f] of found) {
  const name = GROUPS[g][2], v = 40;
  await open(f.seed, 0);
  await goTo(f.t - (f.lh + 140) / v); await shot(`${name}_approach`);
  await goTo(f.t - 0.3); await shot(`${name}_inside`);
  await goTo(f.t + (f.lh + 25) / v); await shot(`${name}_emerge`);
  // high view of the ridge: 300 m to the side of the passage, 160 m up, looking at its middle
  const c = f.c, nx = -Math.sin(c[3]), nz = Math.cos(c[3]);
  await goTo(f.t - (f.lh + 300) / v);
  await p.evaluate(({ c, nx, nz }) => { window.__camOverride = [c[0] + nx * 380 - Math.cos(c[3]) * 120, c[1] + 190, c[2] + nz * 380 - Math.sin(c[3]) * 120, c[0], c[1] + 20, c[2], 0.9]; }, { c, nx, nz });
  for (let k = 0; k < 3; k++) await step(f.t - (f.lh + 300) / v);
  await shot(`${name}_ridge_high`);
  await p.evaluate(() => { window.__camOverride = null; });
  await open(f.seed, 1);
  await goTo(f.t - 0.3); await shot(`${name}_inside_fp`);
}
if (errs.length) console.log('page errors:', errs.slice(0, 3).join(' | '));
await run.browser.close(); srv.close();
