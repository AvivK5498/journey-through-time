// Passages between biomes (round three): checks over many seeds.
//   node tools/tunnel-test.mjs [--build] [--page=tunnel.html] [--seeds=1-20] [--dt=0.4] [--part=drive,roam]
//                              [--browser=brave|chromium] [--roam-seeds=1-4]
// --build writes a private build to dist/tunnel.html (dist/index.html is left alone) and tests it;
// --page=index.html tests the deliverable; --page=index.r2-final.html measures the round-two build
// ("before": only the pop-in and biome-in-view counts apply, it has no passages).
//
// drive (scripted autopilot, capture mode, one frame every --dt s over the 300 s journey):
//   - every road that changes biome has a passage (edgeTunS) once its fork is planned, a strait
//     road has none, no other road has one; the ridge stands on both sides of each passage
//     (>= 15 m above the road 40 m to either side, checked once it is near the camera) and no ridge stands on a road that does not
//     change biome (ridge >= 4 m 12 m from its centre line, away from passage cuttings);
//   - the car passes every passage on the road: never further than 1 m inside its wall limit, no
//     wall contact (autopilot);
//   - biome in view: fixed world points (a 150 m lattice) within 1.5 km of the camera and in front
//     of it keep their biome (argmax of the JS mirror's weights) from one frame to the next (fails
//     within 600 m; further changes, as new territories fade in, are counted);
//   - pop-ins: a landmark or a passage mesh first shown within 600 m of the car, a road built
//     within 600 m, a road dropped while its biome territory still showed (graph eviction).
// roam (free drive, autopilot off, real time):
//   - from the parent's side, the player drives full throttle straight at the ridge at offsets of
//     60-480 m from the road and along it (to go round): the car never reaches ground of the other
//     side's biome;
//   - injected steering inside a passage (hard left / right while driving through): the car stays
//     between the walls, never climbs, and comes out on the far side.
// Exit 1 on any failure (or a page error).
import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { ROOT, serveDist, launch } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const range = (s) => { const [a, b] = s.split('-').map(Number); return Array.from({ length: (b || a) - a + 1 }, (_, i) => a + i); };
const SEEDS = range(arg('seeds', '1-20'));
const ROAM_SEEDS = range(arg('roam-seeds', '1-4'));
const DT = Number(arg('dt', '0.4'));
const PARTS = arg('part', 'drive,roam').split(',');
let PAGE = arg('page', 'tunnel.html');
const BEFORE = !PAGE.startsWith('tunnel') && PAGE !== 'index.html';

export async function privateBuild() {
  const esbuild = await import('esbuild');
  const minifyWgsl = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([{}()[\];,:=<>*&|!@])\s*/g, '$1').trim();
  const wgsl = { name: 'wgsl', setup(b) { b.onLoad({ filter: /src[\\/].*\.js$/ }, async (a) => { const c = await readFile(a.path, 'utf8'); if (!c.includes('/* wgsl */')) return null; return { contents: c.replace(/\/\* wgsl \*\/ `([^`]*)`/g, (_, x) => '`' + minifyWgsl(x) + '`'), loader: 'js' }; }); } };
  const r = await esbuild.build({ absWorkingDir: ROOT, entryPoints: ['src/main.js'], bundle: true, format: 'esm', target: 'es2022', minify: true, write: false, legalComments: 'none', plugins: [wgsl], logLevel: 'warning' });
  const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const tpl = await readFile(ROOT + 'template.html', 'utf8');
  await writeFile(ROOT + 'dist/tunnel.html', tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>'));
}
if (process.argv.includes('--build')) { await privateBuild(); PAGE = 'tunnel.html'; }

const srv = await serveDist();
const run = await launch(arg('browser', 'brave'));
const p = run.page;
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const wait = (ms) => p.waitForTimeout(ms);

// --------------------------------------------------------------------------------- drive
const totals = { seeds: 0, seamRoads: 0, withPassage: 0, straitSeams: 0, wrongPassage: 0, ridgeMissing: 0, ridgeOnRoad: 0, passed: 0, contacts: 0, maxL: 0,
  biomeFlips: 0, flipSamples: 0, landmarkPops: 0, tunnelPops: 0, roadPops: 0, evicted: 0, evictNear: 1e9, examples: [] };
async function driveSeed(seed) {
  await p.goto(srv.url + `${PAGE}?script=1&capture=1&seed=${seed}&fresh=1`);
  await p.waitForFunction(() => window.__captureReady || window.__gpuError, null, { timeout: 120000 });
  const has = await p.evaluate(() => !!window.__tunnel);
  const seen = new Map(); // fixed point key -> last label
  const siteStage = new Map(), shownTunnels = new Set(), edgeVer = new Map(), checkedTun = new Set(), checkedRoad = new Set();
  let passing = null;
  if (has) await p.evaluate(() => { window.__tunnel.TC[4] = 0; window.__tunnel.TC[5] = 0; });
  for (let t = 0; t <= 300; t += DT) {
    const o = await p.evaluate(async ({ t, has }) => {
      await window.__step(t);
      const W = window.__world, S = window.__game, d = window.__drive.pose(), cam = S.camera;
      const ex = cam.eye[0], ez = cam.eye[2];
      let fx = cam.target[0] - ex, fz = cam.target[2] - ez; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      // fixed lattice points in view
      const pts = [];
      const L = 150, R = 1500;
      for (let gx = Math.floor((ex - R) / L); gx <= Math.ceil((ex + R) / L); gx++) for (let gz = Math.floor((ez - R) / L); gz <= Math.ceil((ez + R) / L); gz++) {
        const x = gx * L, z = gz * L, dx = x - ex, dz = z - ez, r = Math.hypot(dx, dz);
        if (r > R || r < 30 || (dx * fx + dz * fz) / r < 0.64) continue;
        const g = W.groundAt(x, z); let b = 0; for (let k = 1; k < 7; k++) if (g.bio[k] > g.bio[b]) b = k;
        pts.push([gx, gz, b, Math.round(r), +g.bio[b].toFixed(2)]);
      }
      // a landmark's mesh arriving (planned / building -> live); its window opening is history
      const sites = S.sites().sites.filter((s) => !s.home).map((s) => [s.ev + ':' + s.edge + ':' + s.x, Math.hypot(s.x - d.x, s.z - d.z), s.stage]);
      const out = { pts, sites, d, clock: S.state.clock };
      if (has) {
        const T = window.__tunnel;
        out.tun = T.info().tunnels.map((u) => [u.edge + ':' + u.s, u.stage, Math.hypot(u.x - d.x, u.z - d.z), u.edge, u.style]);
        out.edges = T.edges();
        out.tc = Array.from(T.TC);
        out.g = T.graph();
      }
      return out;
    }, { t, has });
    // biome in view
    for (const [gx, gz, b, r, w] of o.pts) {
      const k = gx + ',' + gz, prev = seen.get(k);
      totals.flipSamples++;
      if (prev !== undefined && prev !== b) { totals.biomeFlips++; if (r < 1000) totals.nearFlips = (totals.nearFlips || 0) + 1; if (r < 600) totals.closeFlips = (totals.closeFlips || 0) + 1; if (totals.examples.length < 12) totals.examples.push(`seed ${seed} clock ${o.clock.toFixed(1)}: biome ${prev}->${b} at ${r} m`); }
      seen.set(k, b);
    }
    // keep only points seen this frame (a point leaving view and coming back may legitimately differ)
    const now = new Set(o.pts.map(([gx, gz]) => gx + ',' + gz));
    for (const k of [...seen.keys()]) if (!now.has(k)) seen.delete(k);
    for (const [k, dist, stage] of o.sites) {
      const was = siteStage.get(k); siteStage.set(k, stage);
      if (stage === 'live' && was !== 'live' && t > 2 && dist < 600) { totals.landmarkPops++; totals.examples.push(`seed ${seed} clock ${o.clock.toFixed(1)}: landmark ${k} built ${dist.toFixed(0)} m from the car`); }
    }
    if (!has) continue;
    for (const [k, stage, dist] of o.tun) if (stage === 3 && !shownTunnels.has(k)) { shownTunnels.add(k); if (t > 2 && dist < 600) { totals.tunnelPops++; totals.examples.push(`seed ${seed} clock ${o.clock.toFixed(1)}: passage ${k} built ${dist.toFixed(0)} m from the car`); } }
    for (const E of o.edges) {
      const key = E.e + ':' + E.ver;
      if (!edgeVer.has(key)) {
        edgeVer.set(key, 1);
        if (t > 2) { const dm = await p.evaluate(({ e, x, z }) => window.__tunnel.edgeDist(e, x, z), { e: E.e, x: o.d.x, z: o.d.z }); if (dm < 600) { totals.roadPops++; totals.examples.push(`seed ${seed}: road ${E.e} built ${dm.toFixed(0)} m from the car`); } }
      }
      // seam rules, once the road is fully present (its fork planned) and the label map has drawn it
      if (E.bio < 1 || (checkedRoad.has(key) && (E.tunS < 0 || checkedTun.has(key)))) continue;
      const ready = (edgeVer.get(key) || 1) + 1; edgeVer.set(key, ready);
      if (ready < 10) continue;
      const first = !checkedRoad.has(key);
      checkedRoad.add(key);
      const seam = E.region !== E.parent && E.seam !== 0;
      if (first && E.seam === 1) { totals.seamRoads++; if (E.tunS >= 0) totals.withPassage++; else { fails++; console.log(`FAIL seed ${seed}: seam road ${E.e} has no passage`); } }
      else if (first && E.seam === 2) totals.straitSeams++;
      if (first && E.seam !== 1 && E.tunS >= 0) { totals.wrongPassage++; fails++; console.log(`FAIL seed ${seed}: road ${E.e} (seam ${E.seam}) has a passage`); }
      if (E.region !== E.parent && E.seam === 0 && !E.cur) { /* the root or a debug lock */ }
      // ridge physically there / not on other roads
      const r = await p.evaluate(({ E }) => {
        const T = window.__tunnel, W = window.__world, out = { tun: null, onRoad: [] };
        if (E.tunS >= 0) {
          const c = T.at(E.e, E.tunS, 0), lo = W.groundAt(...T.at(E.e, E.tunS, -40).filter((_, i) => i === 0 || i === 2)).h, hi = W.groundAt(...T.at(E.e, E.tunS, 40).filter((_, i) => i === 0 || i === 2)).h;
          out.tun = [lo - c[1], hi - c[1]];
          const q = T.at(E.e, E.tunS, 40); out.dbg = T.ridge(q[0], q[2]); out.dbg.slot = T.info().slots.filter((v, i) => i % 12 === 11).includes(E.e);
        }
        for (let s = 40; s < E.len - 40; s += 25) {
          if (E.tunS >= 0 && Math.abs(s - E.tunS) < E.tunH + 160) continue;
          for (const lat of [-12, 12]) {
            const q = T.at(E.e, s, lat), rg = T.ridge(q[0], q[2]);
            if (rg.ridge > 4) { out.onRoad.push([Math.round(s), lat, +rg.ridge.toFixed(1), +rg.map.toFixed(1), rg.ze, Math.round(rg.za), Math.round(rg.zl), Math.round(rg.rd)]); break; }
          }
        }
        return out;
      }, { E });
      if (r.tun && r.dbg.slot) { checkedTun.add(key); const ok = r.tun[0] > 15 && r.tun[1] > 15; if (!ok) { totals.ridgeMissing++; console.log(`  seed ${seed}: passage on road ${E.e}: ground 40 m to the sides ${r.tun.map((v) => v.toFixed(1))} m over the road ${JSON.stringify(r.dbg)}`); } }
      if (first && r.onRoad.length) { totals.ridgeOnRoad++; if (totals.examples.length < 30) totals.examples.push(`seed ${seed}: ridge beside road ${E.e} (${seam ? 'seam' : 'same biome'}) at s ${r.onRoad.slice(0, 3).map((v) => v.join('/')).join(', ')} (passage s ${E.tunS.toFixed(0)})`); }
    }
    // passing through
    if (o.tc[0] >= 0 && Math.abs(o.tc[1]) < 40) passing = passing || { start: o.clock };
    else if (passing && o.tc[0] < 0) { totals.passed++; passing = null; }
    if (o.tc[4] > (totals.lastC || 0)) console.log(`  seed ${seed} clock ${o.clock.toFixed(1)}: wall contact in passage slot ${o.tc[0]} a ${o.tc[1].toFixed(1)} l ${o.tc[2].toFixed(2)}`);
    totals.lastC = o.tc[4];
    totals.contacts = Math.max(totals.contacts, o.tc[4]);
    totals.maxL = Math.max(totals.maxL, o.tc[5]);
    if (o.g) { totals.evicted = Math.max(totals.evicted, 0) + 0; totals.evictLast = o.g; }
  }
  if (has) { const g = totals.evictLast; totals.evicted += g.evictBio; totals.evictNear = Math.min(totals.evictNear, g.evictNear); }
  totals.seeds++; totals.lastC = 0;
}

// --------------------------------------------------------------------------------- roam
const roam = { attempts: 0, crossed: 0, passThrough: 0, passOk: 0, maxL: 0, climbed: 0, notes: [] };
async function roamSeed(seed) {
  await p.goto(srv.url + `${PAGE}?autodrive=1&fresh=1&ending=0&seed=${seed}`);
  await p.waitForFunction(() => window.__jt && window.__tunnel, null, { timeout: 120000 });
  await wait(1500);
  // the first passage on the autopilot's route: wait until the car's road or the next one has one
  let tun = null;
  for (let k = 0; k < 120 && !tun; k++) {
    tun = await p.evaluate(() => {
      const T = window.__tunnel, d = window.__drive.pose();
      const E = T.edges().filter((e) => e.tunS >= 0 && e.bio > 0.99 && e.pres > 0.99);
      let best = null;
      for (const e of E) { const c = T.at(e.e, e.tunS, 0); const dd = Math.hypot(c[0] - d.x, c[2] - d.z); if (dd > 300 && dd < 2500 && (!best || dd < best.dd)) best = { e: e.e, s: e.tunS, h: e.tunH, parent: e.parent, region: e.region, dd }; }
      return best;
    });
    if (!tun) await wait(1000);
  }
  if (!tun) { roam.notes.push(`seed ${seed}: no passage found`); return; }
  await p.keyboard.press('KeyP'); // autopilot off
  // Attempts: from the parent's side, 70 m before the passage's ridge line, at lateral offsets, heading
  // straight across (toward the own side) or along the ridge outward (going round).
  const offs = [60, 140, 260, 380, 480, -100, -220, -420];
  for (const lat of offs) {
    for (const mode of ['across', 'round']) {
      const st = await p.evaluate(({ tun, lat, mode }) => {
        const T = window.__tunnel;
        const a = T.at(tun.e, tun.s - tun.h - 70, lat), c = T.at(tun.e, tun.s, 0);
        const h = mode === 'across' ? c[3] : c[3] + (lat > 0 ? 1 : -1) * 1.2;
        window.__drive.place(a[0], a[2], h, 8);
        return { x: a[0], z: a[2] };
      }, { tun, lat, mode });
      await p.keyboard.down('KeyW');
      let crossed = false, maxClimb = 0;
      for (let k = 0; k < 24; k++) {
        await wait(500);
        if (mode === 'round' && k === 10) { await p.evaluate(({ tun, lat }) => { /* turn across after running along it */ }, { tun, lat }); await p.keyboard.down(lat > 0 ? 'KeyA' : 'KeyD'); }
        if (mode === 'round' && k === 13) await p.keyboard.up(lat > 0 ? 'KeyA' : 'KeyD');
        const r = await p.evaluate(({ tun }) => {
          const d = window.__drive.pose(), g = window.__world.groundAt(d.x, d.z), T = window.__tunnel;
          let b = 0; for (let i = 1; i < 7; i++) if (g.bio[i] > g.bio[b]) b = i;
          const rg = T.ridge(d.x, d.z);
          return { b, w: g.bio[b], inPass: T.TC[0] >= 0 && Math.abs(T.TC[2]) < 8, ridge: rg.ridge, x: d.x, z: d.z };
        }, { tun });
        if (r.b === tun.region && r.w > 0.9 && !r.inPass) crossed = true;
        if (r.ridge > maxClimb) maxClimb = r.ridge;
      }
      await p.keyboard.up('KeyW');
      roam.attempts++;
      if (crossed) { roam.crossed++; roam.notes.push(`seed ${seed}: crossed (${mode}, lateral ${lat} m)`); }
      if (maxClimb > roam.climbed) roam.climbed = maxClimb;
    }
  }
  // injected steering through the passage
  for (const side of ['KeyA', 'KeyD']) {
    await p.evaluate(({ tun }) => { const T = window.__tunnel, a = T.at(tun.e, tun.s - tun.h - 60, 0); window.__drive.place(a[0], a[2], a[3], 30); T.TC[4] = 0; T.TC[5] = 0; }, { tun });
    await p.keyboard.down('KeyW');
    let maxUp = 0, out = false;
    for (let k = 0; k < 16; k++) {
      if (k % 4 === 0) await p.keyboard.down(side); if (k % 4 === 2) await p.keyboard.up(side);
      await wait(400);
      const r = await p.evaluate(({ tun }) => { const d = window.__drive.pose(), T = window.__tunnel, c = T.at(tun.e, tun.s, 0); const a = (d.x - c[0]) * Math.cos(c[3]) + (d.z - c[2]) * Math.sin(c[3]); return { a, y: window.__jt.car && window.__game.carPose[1] - c[1], l: Array.from(T.TC) }; }, { tun });
      if (r.a > tun.h + 30) out = true;
      if (Math.abs(r.l[1]) < tun.h && r.y > maxUp) maxUp = r.y;
    }
    await p.keyboard.up('KeyW'); await p.keyboard.up(side);
    const tc = await p.evaluate(() => Array.from(window.__tunnel.TC));
    roam.passThrough++;
    if (out && maxUp < 1.6 && tc[5] <= 1.001) roam.passOk++;
    else roam.notes.push(`seed ${seed}: steering ${side} through the passage: out ${out}, highest ${maxUp.toFixed(2)} m over the road, |lateral| / limit ${tc[5].toFixed(3)}`);
    roam.maxL = Math.max(roam.maxL, tc[5]);
  }
}

try {
  if (PARTS.includes('drive')) {
    for (const s of SEEDS) { const t0 = Date.now(); await driveSeed(s); console.log(`seed ${s}: ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
    console.log(JSON.stringify({ ...totals, examples: undefined, evictLast: undefined }));
    for (const e of totals.examples.slice(0, 30)) console.log('  ' + e);
    console.log(`biome changes of ground in view: ${totals.biomeFlips} in ${totals.flipSamples} point samples (${totals.nearFlips || 0} within 1 km)`);
    console.log(`appearing within 600 m: landmarks ${totals.landmarkPops}, passages ${totals.tunnelPops}, roads ${totals.roadPops}; roads dropped with their territory showing ${totals.evicted} (nearest ${totals.evictNear === 1e9 ? '-' : totals.evictNear.toFixed(0) + ' m'})`);
    if (!BEFORE) {
      check(totals.seamRoads > 0 && totals.withPassage === totals.seamRoads, `every biome-changing road has a passage (${totals.withPassage}/${totals.seamRoads}; strait roads ${totals.straitSeams} without)`);
      check(totals.wrongPassage === 0, 'no other road has a passage');
      check(totals.ridgeMissing === 0, `the ridge stands beside every passage (${totals.ridgeMissing} short)`);
      check(totals.ridgeOnRoad === 0, `no ridge beside a road away from its passage (${totals.ridgeOnRoad} roads)`);
      check(totals.passed > 0 && totals.maxL <= 1.0001 && totals.contacts === 0, `the autopilot passes ${totals.passed} passages between the walls (largest |lateral| / limit ${totals.maxL.toFixed(3)}, contacts ${totals.contacts})`);
      check(!totals.closeFlips, `the biome of ground in view within 600 m never changes (${totals.biomeFlips} changes further out, ${totals.nearFlips || 0} within 1 km, while new territories fade in)`);
      check(totals.landmarkPops + totals.tunnelPops + totals.roadPops === 0, 'nothing appears within 600 m of the car');
    }
  }
  if (PARTS.includes('roam') && !BEFORE) {
    for (const s of ROAM_SEEDS) await roamSeed(s);
    for (const n of roam.notes) console.log('  ' + n);
    check(roam.attempts > 0 && roam.crossed === 0, `off-road the player never reaches the other side (${roam.attempts} attempts, highest ridge ground reached ${roam.climbed.toFixed(1)} m)`);
    check(roam.passThrough > 0 && roam.passOk === roam.passThrough, `steering hard inside a passage the car stays between the walls and comes out (${roam.passOk}/${roam.passThrough})`);
  }
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? ': ' + pageErrors.slice(0, 3).join(' | ') : ''}`);
} catch (e) { console.log('FAIL', e.stack || e.message); fails++; }
await run.browser.close(); srv.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
