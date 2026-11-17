// Biome review captures (round two): for each new biome (3 forest, 4 steppe, 5 mountains,
// 6 coast) a chase view on the road, a first-person view, a view 300 m off the road and the
// first fork where the biome meets an old one, at 1920x1080, into reports/round2/biomes/.
// Also checks the car's ground (JS mirror) against the GPU terrain at the car and around it.
//   node tools/biome-shot.mjs [--biomes=3,4,5,6] [--t=14] [--page=index.html]
// (--page=biomes.html uses the private build from tools/biome-build.mjs.)
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const BIOMES = arg('biomes', '3,4,5,6').split(',').map(Number);
const T = Number(arg('t', '14'));
const PAGE = arg('page', 'index.html');
const NAMES = ['savannah', 'ice', 'desert', 'forest', 'steppe', 'mountains', 'coast'];
const dir = join(ROOT, 'reports/round2/biomes');
mkdirSync(dir, { recursive: true });

const srv = await serveDist();
const run = await launch('chromium');
const page = run.page;
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
async function open(q) {
  await page.goto(srv.url + PAGE + q);
  await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 30000 });
  const e = await page.evaluate(() => window.__gpuError || null);
  if (e) throw new Error(e);
  await page.waitForFunction(() => window.__ready, null, { timeout: 90000 });
  await page.waitForTimeout(600);
}
async function shot(name) {
  const out = join(dir, name);
  await page.screenshot({ path: out });
  execSync(`sips -Z 1920 '${out}'`, { stdio: 'ignore' });
  console.log('wrote', out, errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ').slice(0, 800) : '');
  errs.length = 0;
}
// GPU vs JS ground at the car and on rings around it (on and off the road).
async function groundCheck() {
  return page.evaluate(async () => {
    const c = window.__game.carPose;
    const pts = [[c[0], c[2]]];
    for (const r of [4, 12, 40, 120, 250, 380]) for (let k = 0; k < 8; k++) pts.push([c[0] + Math.cos(k * 0.785) * r, c[2] + Math.sin(k * 0.785) * r]);
    const gpu = await window.__world.groundCheck(pts);
    let max = 0, at = null, sum = 0;
    const js = pts.map(([x, z]) => window.__world.groundAt(x, z).h);
    pts.forEach((p, i) => { const d = Math.abs(gpu[i] - js[i]); sum += d; if (d > max) { max = d; at = { p, gpu: gpu[i], js: js[i], r: Math.round(Math.hypot(p[0] - c[0], p[1] - c[2])) }; } });
    return { carY: c[1], carGpu: gpu[0], carJs: js[0], maxDiff: +max.toFixed(3), meanDiff: +(sum / pts.length).toFixed(3), worst: at };
  });
}

const report = {};
try {
  for (const b of BIOMES) {
    const nm = NAMES[b];
    const R = report[nm] = {};
    const base = `&biome=${b}&biomelock=1&pt=${T}`;
    await open(`?pose=0${base}`);
    await shot(`${nm}_chase.png`);
    R.ground = await groundCheck();
    R.bio = await page.evaluate(() => { const c = window.__game.carPose; return window.__world.groundAt(c[0], c[2]).bio.map((v) => +v.toFixed(2)); });
    // 300 m off the road: on the land side for the coast; camera 2.5 m above the ground there.
    const side = b === 6 ? await page.evaluate(() => (window.__world.sea[2] > 0 ? 1 : -1)) : 1;
    const cam = await page.evaluate(({ side }) => {
      const c = window.__game.carPose, h = c[3];
      // Eye = car - dir(h + yaw) * back; with back = 300 and yaw = +-pi/2 the eye is beside the road.
      let yaw = Math.PI / 2;
      let ex = c[0] - Math.cos(h + yaw) * 300, ez = c[2] - Math.sin(h + yaw) * 300;
      // Coast: keep to the land (the sea side is the +sea[2] z direction).
      if (side && Math.sign(ez - c[2]) === Math.sign(window.__world.sea[2])) { yaw = -yaw; ex = c[0] - Math.cos(h + yaw) * 300; ez = c[2] - Math.sin(h + yaw) * 300; }
      const g = window.__world.groundAt(ex, ez);
      return { yaw, up: g.h - c[1] + (side ? 5 : 2.5), look: g.h - c[1] + (side ? -8 : 6) };
    }, { side: b === 6 });
    // The coast looks from the land across the road to the sea; the others along the land.
    const lookYaw = b === 6 ? cam.yaw * 0.75 : cam.yaw > 0 ? 0.35 : -0.35;
    await open(`?pose=0${base}&pcam=1,${cam.yaw.toFixed(3)},300,${cam.up.toFixed(2)},${lookYaw.toFixed(3)},1400,${cam.look.toFixed(2)},1.0`);
    await shot(`${nm}_offroad.png`);
    await open(`?pose=5${base}`);
    await shot(`${nm}_first.png`);
    // Fork: the first seed whose first fork offers an old biome next to this one.
    let found = null;
    for (let seed = 1; seed <= 24 && !found; seed++) {
      await page.goto(srv.url + PAGE + `?pose=1&biome=${b}&seed=${seed}`);
      await page.waitForFunction(() => window.__ready || window.__gpuError, null, { timeout: 90000 });
      const ex = await page.evaluate(() => { const d = window.__drive; const g = window.__jt.graph; return d.exits(d.edge(g.prev >= 0 ? g.prev : g.cur).to).map((e) => e.region); });
      if (ex.some((r) => r < 3) && ex.includes(b)) found = { seed, regions: ex };
    }
    if (found) {
      await open(`?pose=1&biome=${b}&seed=${found.seed}`);
      await shot(`${nm}_fork.png`);
      R.fork = found;
    } else R.fork = 'no seed in 1..24 with an old biome at the first fork';
    console.log(nm, JSON.stringify(R));
  }
} finally {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await run.browser.close(); srv.close();
}
