// One landmark, found in a real drive and captured: the tool every landmark worker runs.
//   node tools/landmark-shot.mjs --key=<event key> [--seed=N] [--seeds=4] [--module=<path>]
//        [--at=<clock>[,<clock>..]] [--no-late]
// Builds the game with a private registry (the stable five: camp, cave, gobekli, giza, home,
// plus ONLY this key's module) to dist/lm-<key>.html, so a sibling's half-written module cannot
// break the build and parallel runs never share a file. --module points the key at another file
// (e.g. src/world/landmarks/example.js for an event without a module yet).
// Then drives (autopilot, real time) from shortly before the event's placement window (22 clock-s) in its
// region and landmass (?t0, ?biome=N&biomelock=1, ?startland=1 for the far one), trying seeds
// until the landmark is placed ahead, and writes 1920x1080 PNGs to
// reports/round2/landmarks/<key>/:
// (distances are along the road to the point abreast of the landmark's origin)
//   approach_far   chase view, ~300 m
//   first_person   driver's eye, ~120 m
//   approach_near  chase view, ~80 m
//   witness        the middle of the E-key event moment (at the drive's own clock)
//   late           same moment with the landmark's state at the end of its log window (or
//                  after its built step: Trinity, Apollo), when that state differs
//   at_<clock>     same moment at each --at clock
// Prints the seed, clock and distance per capture, the triangle counts, a road-corridor check
// of the placed build against the real roads, and page errors. Exit code 1 when the landmark
// never appears.
import * as esbuild from 'esbuild';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, serveDist, launch } from './browser.mjs';
import { EVENTS, landmarkState } from '../src/world/time.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const die = (m) => { console.error(`\nLANDMARK-SHOT FAILED: ${m}\n`); process.exit(1); };
const KEY = arg('key', '');
const E = EVENTS.find((e) => e.key === KEY);
if (!E) die(`--key must be an event key (${EVENTS.filter((e) => e.place).map((e) => e.key).join(', ')})`);
const STABLE = ['camp', 'cave', 'gobekli', 'giza', 'home'];
const LM = join(ROOT, 'src/world/landmarks');
const MOD = resolve(process.cwd(), arg('module', join(LM, `${KEY}.js`)));
if (!existsSync(MOD)) die(`no module at ${MOD} (write it, or pass --module=<path>)`);
const SEED0 = parseInt(arg('seed', '1'), 10) || 1;
const NSEEDS = parseInt(arg('seeds', '4'), 10) || 4;
const ATS = arg('at', '').split(',').filter(Boolean).map(Number).filter((v) => isFinite(v));
const LATE = !argv.includes('--no-late');
const OUT = join(ROOT, 'reports/round2/landmarks', KEY);
mkdirSync(OUT, { recursive: true });

// --- build (private registry; nothing shared is written)
const exportName = (k) => k.replace(/-/g, '_');
const registry = STABLE.filter((k) => k !== KEY).map((k) => `export { default as ${exportName(k)} } from ${JSON.stringify(join(LM, `${k}.js`))};`)
  .concat(`export { default as ${exportName(KEY)} } from ${JSON.stringify(MOD)};`).join('\n');
// The entry: the game plus a check hook that rebuilds this module as sites.js did and measures it
// against the live roads (world space, every vertex above 5 cm; rig parts at their bind pose).
const entry = `
import './src/main.js';
import def from ${JSON.stringify(MOD)};
import { LandmarkBuilder, buildLandmark, checkLandmark, roadOffset } from './src/world/landmarks/kit.js';
import { nearestRoad } from './src/world/graph.js';
window.__lmOff = roadOffset(def); // distances below are along the road: sqrt(d^2 - offset^2)
window.__lmCheck = (seed, region, pos) => {
  const b = new LandmarkBuilder();
  const c = buildLandmark(def, b, 1, 0, seed, region);
  const warnings = checkLandmark(def, b);
  const f = b.f, cy = Math.cos(pos[3]), sy = Math.sin(pos[3]), q = new Float64Array(8);
  const clear = def.straddlesRoad ? 6 : 6.5;
  let near = 0, minD = 1e9, tested = 0;
  const step = Math.max(1, Math.floor(b.nv / 30000));
  for (let i = 0; i < b.nv; i += step) {
    const x = f[i * 8], y = f[i * 8 + 1], z = f[i * 8 + 2];
    if (!(y > 0.05) || (def.straddlesRoad && y > 6)) continue;
    q[5] = cy * x + sy * z + pos[0]; q[6] = -sy * x + cy * z + pos[2];
    nearestRoad(q, 0); tested++;
    if (q[0] < minD) minD = q[0];
    if (q[0] < clear) near++;
  }
  return { triangles: c.triangles, a2c: c.a2c, fx: c.fx, vertices: c.vertices, maxY: +b.bounds.maxY.toFixed(1), maxR: +b.bounds.maxR.toFixed(1),
    radius: def.radius, straddles: !!def.straddlesRoad, roadOffset: roadOffset(def), clear, near, tested, step, minD: +minD.toFixed(2), warnings };
};
`;
const res = await esbuild.build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'landmark-shot-entry.js', loader: 'js' },
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'warning', minify: false,
  plugins: [{ name: 'registry', setup(b) {
    b.onResolve({ filter: /landmarks[\\/]index\.js$/ }, (a) => (a.importer && /sites\.js$/.test(a.importer) ? { path: 'registry', namespace: 'lm' } : null));
    b.onLoad({ filter: /.*/, namespace: 'lm' }, () => ({ contents: registry, resolveDir: LM, loader: 'js' }));
  } }],
}).catch((e) => die(`build: ${e.message}`));
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = (await import('node:fs')).readFileSync(join(ROOT, 'template.html'), 'utf8');
const PAGE = `lm-${KEY}.html`;
mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist', PAGE), tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>'));
console.log(`built dist/${PAGE} (registry: ${STABLE.filter((k) => k !== KEY).join(', ')} + ${KEY} -> ${MOD.replace(ROOT, '')})`);

// --- the drive
const ev = E.id, far = E.land === 1;
// The root road (~800 m, ~20 clock-s) never carries a landmark: start so the first fork comes
// just before the placement window opens.
const t0 = Math.max(0, E.w0 - 22);
// The "late" clock: after a built step, part-way through what follows; else the end of the log
// window. Captured only when the state there differs from the drive's own.
const st = (c) => { const o = new Float64Array(3); landmarkState(ev, c, o); return [+o[0].toFixed(3), +o[1].toFixed(3)]; };
const lateClock = E.b0 >= 0 && E.b0 === E.b1 && E.d1 > E.d0 ? +(E.d0 + 0.45 * (E.d1 - E.d0)).toFixed(1) : +(E.t1 - 0.5).toFixed(1);
console.log(`event ${ev} ${KEY}: region ${E.region}, ${far ? 'far' : 'near'} landmass, placed ${E.w0}-${E.w1}, logged ${E.t0}-${E.t1}; drive from clock ${t0}`);

const srv = await serveDist();
const run = await launch('chromium');
const ctx = await run.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
let failed = null, found = false;
const errors = [];
const near = (p) => p.evaluate((ev) => {
  const g = window.__game, s = g.sites().sites.find((x) => x.ev === ev && x.stage === 'live');
  if (!s) return null;
  const c = g.carPose, h = Math.hypot(s.pos[0] - c[0], s.pos[2] - c[2]);
  return { d: Math.sqrt(Math.max(0, h * h - window.__lmOff * window.__lmOff)), clock: g.state.clock, s };
}, ev);
// Waits until the car is within `dist` m of the origin (closing). Returns the reading or null.
async function reach(p, dist, timeout) {
  const ok = await p.waitForFunction(([ev, dist]) => {
    const g = window.__game, s = g.sites().sites.find((x) => x.ev === ev && x.stage === 'live');
    const h = Math.hypot(s.pos[0] - g.carPose[0], s.pos[2] - g.carPose[2]);
    return !!s && s.visible && h * h - window.__lmOff * window.__lmOff <= dist * dist;
  }, [ev, dist], { timeout, polling: 30 }).then(() => true).catch(() => false);
  return ok ? near(p) : null;
}
const fmt = (r) => `clock ${r.clock.toFixed(1)}, ${Math.round(r.d)} m`;
try {
  for (let seed = SEED0; seed < SEED0 + NSEEDS && !found; seed++) {
    const p = await ctx.newPage();
    const pageErr = [];
    p.on('pageerror', (e) => pageErr.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') pageErr.push(m.text()); });
    await p.bringToFront();
    const q = `?autodrive=1&fresh=1&ending=0&view=0&seed=${seed}&t0=${t0}&biome=${E.region}&biomelock=1${far ? '&startland=1&land=2' : '&land=0'}`;
    await p.goto(srv.url + PAGE + q);
    await p.waitForFunction(() => window.__game || window.__gpuError, null, { timeout: 60000 });
    const gerr = await p.evaluate(() => window.__gpuError || null);
    if (gerr) throw new Error(gerr);
    // placed, ahead and live
    const placed = await p.waitForFunction((ev) => window.__game.sites().sites.some((x) => x.ev === ev && x.stage === 'live'), ev, { timeout: 45000, polling: 200 }).then(() => true).catch(() => false);
    if (!placed) { console.log(`seed ${seed}: not placed within 45 s (clock ${(await p.evaluate(() => window.__game.state.clock)).toFixed(1)}); next seed`); errors.push(...pageErr); await p.close(); continue; }
    let r = await near(p);
    console.log(`seed ${seed}: placed at clock ${r.clock.toFixed(1)}, ${Math.round(r.d)} m from the car (pass clock ${r.s.passClock}, yaw ${r.s.yaw})`);
    const shots = [];
    const shot = async (name, rr) => { await p.screenshot({ path: join(OUT, `${name}.png`) }); shots.push(`${name}: ${fmt(rr)}`); console.log(`  ${name}.png  ${fmt(rr)}`); };
    if (r.d > 300) { r = await reach(p, 300, 90000); if (r) await shot('approach_far', r); }
    else console.log(`  (approach_far skipped: placed only ${Math.round(r.d)} m ahead)`);
    if (r) { // driver's eye at ~120 m, chase again at ~80 m
      if (r.d > 125) { r = await reach(p, 135, 60000); if (r) { await p.keyboard.press('KeyC'); r = await reach(p, 120, 20000); if (r) await shot('first_person', r); await p.keyboard.press('KeyC'); } }
      if (r && r.d > 82) { r = await reach(p, 80, 30000); if (r) await shot('approach_near', r); }
    }
    if (!r) { console.log(`seed ${seed}: the car never came near (another road?); next seed`); errors.push(...pageErr); await p.close(); continue; }
    found = true;
    // Witness: E as soon as the prompt offers this event, the held shot at ~3 s.
    const prompt = await p.waitForFunction((ev) => window.__game.witnessIO[0] >= 0 && window.__game.witnessIO[1] === ev, ev, { timeout: 20000, polling: 50 }).then(() => true).catch(() => false);
    if (!prompt) console.log('  no witness prompt for this event (witness, late and --at skipped)');
    else {
      await p.keyboard.press('KeyE');
      await p.waitForTimeout(3000);
      r = await near(p); await shot('witness', r);
      const own = st(r.clock);
      const extra = [];
      if (LATE && JSON.stringify(st(lateClock)) !== JSON.stringify(own)) extra.push(['late', lateClock]);
      for (const c of ATS) extra.push([`at_${c}`, c]);
      for (const [name, c] of extra) {
        await p.evaluate((c) => { window.__game.siteClock[0] = c; }, c);
        await p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
        await p.waitForTimeout(120);
        r = await near(p);
        const s = st(c);
        await p.screenshot({ path: join(OUT, `${name}.png`) });
        console.log(`  ${name}.png  state at clock ${c} (built ${s[0]}, decay ${s[1]}); drive ${fmt(r)}`);
      }
      await p.evaluate(() => { window.__game.siteClock[0] = -1; });
      if (!extra.some((x) => x[0] === 'late')) console.log(`  (late skipped: the state at clock ${lateClock} is the same as the witness's)`);
    }
    const s = (await near(p)).s;
    const chk = await p.evaluate(([seed, region, pos]) => window.__lmCheck(seed, region, pos), [s.seed, s.region, s.pos]);
    console.log(`\nseed ${seed}: ${KEY} placed at (${s.pos.map((v) => v.toFixed(1)).join(', ')}) yaw ${s.yaw}, region ${s.region}`);
    console.log(`triangles ${chk.triangles} (reveal/fade ${chk.a2c}) + fx ${chk.fx}, vertices ${chk.vertices}; in game: ${s.triangles} + fx ${s.fxTriangles}${s.satellites ? `, satellites ${s.satellites} (${s.satTriangles} tris)` : ''}`);
    console.log(`height ${chk.maxY} m, reach ${chk.maxR} m (radius ${chk.radius}), ${chk.straddles ? 'straddles the road' : `road ${chk.roadOffset} m from the origin`}`);
    console.log(chk.near
      ? `ROAD CORRIDOR: ${chk.near} of ${chk.tested} tested vertices above 5 cm lie within ${chk.clear} m of a road centre line (closest ${chk.minD} m)`
      : `road corridor clear: no vertex above 5 cm within ${chk.clear} m of any road (closest ${chk.minD} m; ${chk.tested} vertices tested${chk.step > 1 ? `, every ${chk.step}th` : ''})`);
    for (const w of chk.warnings) console.log(`contract: ${w}`);
    errors.push(...pageErr);
    await p.close();
  }
} catch (e) { failed = e; } finally {
  await run.browser.close();
  srv.close();
}
const uniq = [...new Set(errors)];
console.log(uniq.length ? `\n${uniq.length} page error(s):\n  ${uniq.slice(0, 12).join('\n  ')}` : '\npage errors: none');
if (failed) die(failed.message);
if (!found) die(`${KEY} never appeared ahead of the car on seeds ${SEED0}-${SEED0 + NSEEDS - 1} (try --seed=, check its biome / window in time.js EVENTS, or that build() runs)`);
console.log(`captures in ${OUT.replace(ROOT, '')}/`);
if (uniq.length) process.exitCode = 2;
