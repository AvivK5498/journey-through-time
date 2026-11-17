// Independent integration test of the slice (tester round 1). Read-only on the game: it
// serves a frozen copy of dist/index.html (reports/test/build/index.html, copied once by
// `snap`) and drives it headed on the real GPU like tools/browser.mjs.
//   node tools/slice-test.mjs <test> [args]
// Tests: snap | start | clock | surface | audio | headunit | landmarks <seed> | dry |
//        bridge-find <seed> | shot <query> <t> <name> | pose <query> <name> | loop | ui |
//        alloc <view> | perf <view> <from>
// Results: reports/test/<test>*.json, images in reports/test/img/.
import { createServer } from 'node:http';
import { readFile, copyFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ROOT, CHROME_ARGS, isSoftwareAdapter } from './browser.mjs';
import * as TM from '../src/world/time.js';

const OUT = join(ROOT, 'reports/test');
const IMG = join(OUT, 'img');
const BUILD = join(OUT, 'build');
await mkdir(IMG, { recursive: true });
await mkdir(BUILD, { recursive: true });
const [cmd, ...args] = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

if (cmd === 'snap') {
  await copyFile(join(ROOT, 'dist/index.html'), join(BUILD, 'index.html'));
  const s = await stat(join(ROOT, 'dist/index.html'));
  log('snapshot of dist/index.html, mtime', s.mtime.toISOString(), 'bytes', s.size);
  process.exit(0);
}

function serve() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (p !== '/' && p !== '/index.html') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(join(BUILD, 'index.html')));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://localhost:${srv.address().port}/index.html`, close: () => srv.close() }));
  });
}

// Hooks installed before the page's scripts: WebGPU uncaptured errors / device loss, and the
// AudioContext + analyser the game creates (the audio module keeps them in a closure).
const INIT = () => {
  window.__T = { errs: [], ctxs: [], ans: [] };
  if (window.GPUAdapter) {
    const rd = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...a) {
      const d = await rd.apply(this, a);
      d.addEventListener('uncapturederror', (e) => { window.__T.errs.push('uncaptured: ' + e.error.message); console.error('[GPU uncaptured] ' + e.error.message); });
      d.lost.then((i) => { window.__T.errs.push('lost: ' + i.reason + ' ' + i.message); console.error('[GPU lost] ' + i.message); });
      return d;
    };
  }
  const AC = window.AudioContext;
  if (AC) {
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__T.ctxs.push(this); } };
    const ca = BaseAudioContext.prototype.createAnalyser;
    BaseAudioContext.prototype.createAnalyser = function () { const a = ca.call(this); window.__T.ans.push(a); return a; };
  }
};

async function open(query, { extraArgs = [], context = null } = {}) {
  const srv = await serve();
  let browser = null, ctx = context;
  if (!ctx) {
    browser = await chromium.launch({ headless: false, args: [...CHROME_ARGS, '--autoplay-policy=no-user-gesture-required', ...extraArgs] });
    ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(INIT);
  }
  const page = await ctx.newPage();
  const consoleLog = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { consoleLog.push(`[${m.type()}] ${m.text()}`); } });
  page.on('pageerror', (e) => consoleLog.push('[pageerror] ' + e.message));
  await page.goto(srv.url + query);
  await page.waitForFunction(() => window.__game || window.__gpuError, null, { timeout: 60000 });
  const info = await page.evaluate(() => ({ gpu: window.__gpu || null, err: window.__gpuError || null }));
  if (info.err) throw new Error('gpu: ' + info.err);
  if (isSoftwareAdapter(info.gpu)) throw new Error('software adapter ' + JSON.stringify(info.gpu));
  const close = async () => { if (browser) await browser.close(); srv.close(); };
  return { page, ctx, browser, srv, consoleLog, info, close };
}

const S = (p) => p.evaluate(() => {
  const s = window.__game.state;
  return { clock: +s.clock.toFixed(3), year: Math.round(s.year), era: s.eraIdx, eraBlend: +s.eraBlend.toFixed(3), speed: +s.speed.toFixed(2), timeRate: Math.round(s.timeRate),
    view: s.view, found: s.found, loop: s.loop, seed: s.seed, biomeA: s.biomeA, biomeB: s.biomeB, biomeBlend: +s.biomeBlend.toFixed(2), surface: +(+s.surface).toFixed(2), off: +(+s.offRoad).toFixed(2),
    yr: document.querySelector('#jt .yr')?.textContent, eraLbl: document.querySelector('#jt .when .lbl')?.textContent,
    ui: { ...window.__game.ui }, frame: s.frame };
});
async function shot(page, name) { const f = join(IMG, name + '.jpg'); await page.screenshot({ path: f, type: 'jpeg', quality: 85 }); return f; }
async function save(name, obj) { await writeFile(join(OUT, name + '.json'), JSON.stringify(obj, null, 1)); log('wrote', join(OUT, name + '.json')); }
const gpuErrs = (p) => p.evaluate(() => window.__T.errs.slice());

// capture mode helpers
async function capOpen(q) {
  const r = await open('?script=1&capture=1&' + q);
  await r.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  return r;
}
async function stepTo(page, t, n = 3) { for (let k = 0; k < n; k++) await page.evaluate((t) => window.__step(t), t); }

const R = {};
try {
  if (cmd === 'start') {
    // 1: start screen over live scene, Drive starts, no errors.
    const r = await open('?fresh=1');
    await wait(3000);
    const a = await S(r.page);
    const startOn = await r.page.evaluate(() => document.querySelector('#jt .start').classList.contains('on'));
    const f1 = await shot(r.page, 'start_screen');
    await wait(2000);
    const a2 = await S(r.page);
    // the scene behind is live: compare two canvas grabs
    const c1 = await r.page.locator('#c').screenshot({ type: 'png', clip: undefined });
    await wait(1500);
    const c2 = await r.page.locator('#c').screenshot({ type: 'png' });
    const same = Buffer.compare(c1, c2) === 0;
    await r.page.click('#jt .go');
    await wait(4000);
    const b = await S(r.page);
    const f2 = await shot(r.page, 'after_drive');
    await wait(3000);
    const c = await S(r.page);
    R.start = { beforeDrive: a, beforeDrive2s: a2, startOn, canvasChangedWhileOnStart: !same, afterDrive4s: b, afterDrive7s: c, shots: [f1, f2], gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save('t1_start', R.start);
    await r.close();
  } else if (cmd === 'clock') {
    // 2: clock only advances while moving; era change at 40 / 80; HUD label.
    const t0 = Number(args[0] || 36);
    const r = await open(`?autodrive=1&fresh=1&t0=${t0}`);
    await wait(1500);
    const samples = [];
    const check = (s) => {
      const exp = { era: TM.eraAt(s.clock), year: Math.round(TM.yearAt(s.clock)), blend: +TM.eraBlendAt(s.clock).toFixed(3) };
      // HUD label: yearLabel of the state's year (memoised path) and of the clock's year
      const lab = TM.yearLabel(s.year);
      return { ...s, exp, eraOk: exp.era === s.era, yearOk: Math.abs(exp.year - s.year) <= Math.max(2, Math.abs(TM.yearAt(s.clock + 0.05) - TM.yearAt(s.clock))), hudOk: lab === s.yr, hudEraOk: s.eraLbl === TM.ERA_NAMES[s.era] };
    };
    for (let i = 0; i < 6; i++) { samples.push(check(await S(r.page))); await wait(1000); }
    // stop the car
    await r.page.keyboard.down('KeyS');
    await wait(4000);
    const stopA = await S(r.page);
    await wait(3000);
    const stopB = await S(r.page);
    await r.page.keyboard.up('KeyS');
    await wait(2500);
    const after = await S(r.page);
    // run through the second era change (if t0 near 76) by sampling
    for (let i = 0; i < 10; i++) { samples.push(check(await S(r.page))); await wait(1000); }
    R.clock = { t0, samples, stopped: { stopA, stopB, clockDelta: +(stopB.clock - stopA.clock).toFixed(4), timeRateWhileStopped: stopB.timeRate }, afterRelease: after, gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save('t2_clock_t0_' + t0, R.clock);
    await r.close();
  } else if (cmd === 'shot') {
    // generic capture-mode shot: shot '<query>' <t> <name>
    const [q, t, name] = args;
    const r = await capOpen(q);
    await stepTo(r.page, Number(t), 4);
    const s = await S(r.page);
    const sites = await r.page.evaluate(() => window.__game.sites());
    const f = await shot(r.page, name);
    const cap = await r.page.evaluate(() => ({ on: document.querySelector('#jt .cap').classList.contains('on'), nm: document.querySelector('#jt .cap .nm').textContent }));
    await save('shot_' + name, { q, t, state: s, sites, cap, file: f, gpuErrs: await gpuErrs(r.page), console: r.consoleLog });
    await r.close();
  } else if (cmd === 'pose') {
    const [q, name] = args;
    const r = await open(q);
    await r.page.waitForFunction(() => window.__ready, null, { timeout: 90000 });
    const s = await S(r.page);
    const sites = await r.page.evaluate(() => window.__game.sites());
    const f = await shot(r.page, name);
    await save('pose_' + name, { q, state: s, sites, file: f, gpuErrs: await gpuErrs(r.page), console: r.consoleLog });
    await r.close();
  } else if (cmd === 'landmarks') {
    // 5 + 6: autopilot route of a seed in capture mode: step 0..120, record logs, captions,
    // site pass clocks, and captures on approach and beside each landmark.
    const seed = Number(args[0] || 1);
    const route = args[1] ? '&route=' + args[1] : '';
    const view = args[2] || '0';
    const tag = `s${seed}${args[1] ? '_r' + args[1].replace(/,/g, '') : ''}_v${view}`;
    const r = await capOpen(`seed=${seed}&view=${view}${route}`);
    const logs = [];
    const sitesSeen = {};
    let prevFound = 0;
    for (let t = 0; t <= 120; t += 0.5) {
      await stepTo(r.page, t, 1);
      const st = await r.page.evaluate(() => ({ found: window.__game.state.found, clock: window.__game.state.clock, edge: window.__game.state.edge, sites: window.__game.sites().sites,
        cap: document.querySelector('#jt .cap').classList.contains('on') ? document.querySelector('#jt .cap .nm').textContent : null }));
      for (const s of st.sites) {
        const k = s.id + '@' + s.edge;
        if (!sitesSeen[k]) sitesSeen[k] = { ...s, firstSeenClock: +st.clock.toFixed(1), onCarEdgeAt: [] };
        if (s.edge === st.edge && sitesSeen[k].onCarEdgeAt.length < 1) sitesSeen[k].onCarEdgeAt.push(+st.clock.toFixed(1));
        sitesSeen[k].visibleEver = sitesSeen[k].visibleEver || s.visible;
        sitesSeen[k].stage = s.stage;
      }
      if (st.found !== prevFound) { logs.push({ bits: st.found ^ prevFound, clock: +st.clock.toFixed(2), caption: st.cap }); prevFound = st.found; }
    }
    // the sites the car actually drove past (on its edge)
    const passed = Object.values(sitesSeen).filter((s) => s.onCarEdgeAt.length);
    const caps = [];
    for (const s of passed) {
      for (const dt of [-7, -3, 0]) {
        const t = s.passClock + dt;
        if (t < 0) continue;
        await stepTo(r.page, t, 4);
        const f = await shot(r.page, `lm_${tag}_${s.id}_${dt}`);
        const vis = await r.page.evaluate((id) => window.__game.sites().sites.filter((x) => x.id === id).map((x) => ({ visible: x.visible, stage: x.stage, edge: x.edge })), s.id);
        caps.push({ id: s.id, t, dt, file: f, vis, edge: (await S(r.page)).clock });
      }
    }
    R.lm = { seed, route: args[1] || 'autopilot', view, routeInfo: await r.page.evaluate(() => window.__game.route()), logs, finalFound: prevFound, sites: Object.values(sitesSeen), passed: passed.map((s) => s.id), caps, gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save('t5_landmarks_' + tag, R.lm);
    await r.close();
  } else if (cmd === 'dry') {
    // dryRun per seed (autopilot) with optional route
    const out = [];
    for (const sr of args) {
      const [seed, route] = sr.split(':');
      const r = await capOpen(`seed=${seed}` + (route ? '&route=' + route : ''));
      const d = await r.page.evaluate((s) => window.__game.dryRun(s), Number(seed));
      out.push({ seed: Number(seed), route: route || 'autopilot', ...d, gpuErrs: await gpuErrs(r.page) });
      log(JSON.stringify(out[out.length - 1]));
      await r.close();
    }
    await save('t5_dry_' + args.join('_').replace(/[:,]/g, '-'), out);
  } else if (cmd === 'bridge-find') {
    // walk the route (capture mode, 1 s steps) and record bridges and the car's edge
    const seed = Number(args[0] || 1);
    const route = args[1] ? '&route=' + args[1] : '';
    const r = await capOpen(`seed=${seed}${route}`);
    const rows = [];
    for (let t = 0; t <= Number(args[2] || 70); t += 1) {
      await stepTo(r.page, t, 1);
      rows.push(await r.page.evaluate(() => { const g = window.__game, s = g.state, si = g.sites(); return { clock: +s.clock.toFixed(1), edge: s.edge, edgeS: Math.round(s.edgeS), region: si.cur.region, off: +(+s.offRoad).toFixed(2), speed: +s.speed.toFixed(1), y: +window.__jt.car.v.toFixed(1), route: g.route().exits, bridges: si.bridges, strait: si.strait }; }));
    }
    const onBridge = rows.filter((x) => x.bridges.some((b) => b.edge === x.edge));
    await save(`t7_bridge_s${seed}${args[1] ? '_r' + args[1].replace(/,/g, '') : ''}`, { seed, route: args[1] || 'autopilot', onBridge: onBridge.map((x) => ({ clock: x.clock, edgeS: x.edgeS, off: x.off, speed: x.speed, strait: x.strait })), rows, gpuErrs: await gpuErrs(r.page), console: r.consoleLog });
    await r.close();
  } else if (cmd === 'audio') {
    // 4: audio context running after Drive, levels, mute.
    const r = await open('?fresh=1');
    await wait(2500);
    const pre = await r.page.evaluate(() => ({ ctxs: window.__T.ctxs.length }));
    await r.page.click('#jt .go');
    await wait(4000);
    const rms = () => r.page.evaluate(async () => {
      const a = window.__T.ans[0];
      if (!a) return null;
      const buf = new Float32Array(a.fftSize);
      let mx = 0;
      for (let k = 0; k < 10; k++) {
        a.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        mx = Math.max(mx, Math.sqrt(s / buf.length));
        await new Promise((r) => setTimeout(r, 50));
      }
      return +mx.toFixed(5);
    });
    const st = await r.page.evaluate(() => ({ ctxs: window.__T.ctxs.map((c) => c.state), ans: window.__T.ans.length, sampleRate: window.__T.ctxs[0]?.sampleRate }));
    const on1 = await rms();
    await r.page.keyboard.press('KeyM');
    await wait(1200);
    const muted = await rms();
    await r.page.keyboard.press('KeyM');
    await wait(1200);
    const on2 = await rms();
    // view 1 levels array the head unit reads: band levels via the analyser the same way
    await r.page.keyboard.press('KeyC');
    await wait(1500);
    const bands = await r.page.evaluate(() => { const a = window.__T.ans[0]; const fd = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(fd); let mx = 0, sum = 0; for (const v of fd) { mx = Math.max(mx, v); sum += v; } return { max: mx, mean: +(sum / fd.length).toFixed(1) }; });
    const f = await shot(r.page, 'audio_fp');
    R.audio = { pre, st, rmsOn: on1, rmsMuted: muted, rmsUnmuted: on2, freqBins: bands, file: f, gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save('t4_audio', R.audio);
    await r.close();
  } else if (cmd === 'loop') {
    // 8: loop at 120 s, logbook kept, journeys++, second loop, reload persists.
    const t0 = Number(args[0] || 100);
    const r = await open(`?autodrive=1&t0=${t0}`);
    const tl = [];
    const t1 = Date.now();
    let shotVeil = null, prev = null, loops = [];
    while (Date.now() - t1 < 1000 * Number(args[1] || 170)) {
      const s = await S(r.page);
      tl.push({ t: ((Date.now() - t1) / 1000).toFixed(1), clock: s.clock, seed: s.seed, loop: s.loop, found: s.found, veil: +s.ui.veil.toFixed(2) });
      if (!shotVeil && s.clock > 119.2 && s.ui.veil > 0.5) shotVeil = await shot(r.page, 'loop_veil');
      if (prev && s.loop !== prev.loop) {
        loops.push({ before: prev, after: s, storage: await r.page.evaluate(() => ({ found: localStorage.getItem('jtt.found'), journeys: localStorage.getItem('jtt.journeys') })) });
        await wait(1200);
        loops[loops.length - 1].shotAfter = await shot(r.page, 'loop_after_' + s.loop);
      }
      prev = s;
      if (loops.length >= 2) break;
      await wait(s.clock > 117 && s.clock < 121 ? 150 : 1000);
    }
    await r.page.keyboard.press('KeyL');
    await wait(800);
    const lb = await r.page.evaluate(() => ({ open: window.__game.ui.logbook, nf: document.querySelector('#jt .nf').textContent, nj: document.querySelector('#jt .nj').textContent, names: [...document.querySelectorAll('#jt .ents .nm')].map((e) => e.textContent) }));
    const fLb = await shot(r.page, 'loop_logbook');
    const before = await S(r.page);
    await r.page.reload();
    await r.page.waitForFunction(() => window.__game, null, { timeout: 60000 });
    await wait(1500);
    const afterReload = await S(r.page);
    await r.page.keyboard.press('KeyL');
    await wait(800);
    const lb2 = await r.page.evaluate(() => ({ nf: document.querySelector('#jt .nf').textContent, nj: document.querySelector('#jt .nj').textContent }));
    const fLb2 = await shot(r.page, 'loop_logbook_reload');
    R.loop = { t0, loops, logbook: lb, before, afterReload, logbookAfterReload: lb2, files: [shotVeil, fLb, fLb2], timeline: tl.filter((x, i) => i % 3 === 0 || x.veil > 0), gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save('t8_loop', R.loop);
    await r.close();
  } else if (cmd === 'ui') {
    // 9: C, HUD in fp, Esc pause, L logbook, quality.
    const r = await open('?fresh=1');
    await wait(2000);
    await r.page.click('#jt .go');
    await wait(2500);
    const hudOp = () => r.page.evaluate(() => ({ view: window.__game.state.view, fp: document.getElementById('jt').classList.contains('fp'), when: getComputedStyle(document.querySelector('#jt .hud')).opacity }));
    const v0 = await hudOp();
    await r.page.keyboard.press('KeyC'); await wait(1200);
    const v1 = await hudOp();
    const f1 = await shot(r.page, 'ui_fp');
    await r.page.keyboard.press('KeyC'); await wait(1200);
    const v2 = await hudOp();
    const f0 = await shot(r.page, 'ui_tp');
    // Esc
    await r.page.keyboard.press('Escape'); await wait(800);
    const p1 = await S(r.page); await wait(2000); const p2 = await S(r.page);
    const fm = await shot(r.page, 'ui_menu');
    await r.page.keyboard.press('Escape'); await wait(1500);
    const p3 = await S(r.page);
    // L
    await r.page.keyboard.press('KeyL'); await wait(800);
    const l1 = await S(r.page);
    const fl = await shot(r.page, 'ui_logbook');
    await wait(1500); const l1b = await S(r.page);
    await r.page.keyboard.press('KeyL'); await wait(800);
    const l2 = await S(r.page);
    // quality
    const cw = () => r.page.evaluate(() => ({ w: document.getElementById('c').width, h: document.getElementById('c').height, tier: window.__game.quality.tier, saved: localStorage.getItem('jtt.quality') }));
    const q0 = await cw();
    await r.page.keyboard.press('Escape'); await wait(600);
    await r.page.click('#jt .seg button[data-q="low"]'); await wait(1500);
    const q1 = await cw();
    await r.page.click('#jt .seg button[data-q="medium"]'); await wait(1500);
    const q2 = await cw();
    await r.page.keyboard.press('Escape'); await wait(1500);
    const fq = await shot(r.page, 'ui_medium');
    await r.page.reload();
    await r.page.waitForFunction(() => window.__game, null, { timeout: 60000 });
    await wait(2000);
    const q3 = await cw();
    const seg = await r.page.evaluate(() => [...document.querySelectorAll('#jt .seg button.on')].map((b) => b.dataset.q));
    R.ui = { v0, v1, v2, pause: { p1, p2, clockDelta: +(p2.clock - p1.clock).toFixed(4), resumed: p3 }, logbook: { l1, l1b, l2, clockDeltaWhileOpen: +(l1b.clock - l1.clock).toFixed(4) }, quality: { q0, q1, q2, afterReload: q3, segOn: seg }, files: [f1, f0, fm, fl, fq], gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save('t9_ui', R.ui);
    await r.close();
  } else if (cmd === 'alloc') {
    // 11: steady-state allocation over 20 s of driving, no fork crossing.
    const view = args[0] || '0';
    const seed = args[1] || '1';
    const r = await open(`?fresh=1&seed=${seed}&view=${view}`, { extraArgs: ['--enable-precise-memory-info'] });
    await wait(2000);
    await r.page.click('#jt .go');
    // wait for a fork crossing then measure right after it (forks are ~30 s apart)
    const commits0 = await r.page.evaluate(() => window.__jt.graph.commits);
    const tStart = Date.now();
    while (Date.now() - tStart < 60000) { const c = await r.page.evaluate(() => window.__jt.graph.commits); if (c !== commits0) break; await wait(250); }
    await wait(3000); // just past the fork (edge planning, builds)
    const cdp = await r.ctx.newCDPSession(r.page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const before = await r.page.evaluate(() => ({ frame: window.__game.state.frame, commits: window.__jt.graph.commits, builds: window.__game.sites().builds, heap: performance.memory.usedJSHeapSize, clock: window.__game.state.clock }));
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await wait(20000);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const after = await r.page.evaluate(() => ({ frame: window.__game.state.frame, commits: window.__jt.graph.commits, builds: window.__game.sites().builds, heap: performance.memory.usedJSHeapSize, clock: window.__game.state.clock }));
    let total = 0;
    const agg = new Map();
    (function walk(n, stack) {
      const s = stack.concat(`${n.callFrame.functionName || '(anon)'}@${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`);
      if (n.selfSize) { total += n.selfSize; const key = s.slice(-4).join(' < '); agg.set(key, (agg.get(key) || 0) + n.selfSize); }
      for (const c of n.children) walk(c, s);
    })(profile.head, []);
    const frames = after.frame - before.frame;
    R.alloc = { view, before, after, frames, sampledBytes: total, bytesPerFrame: +(total / frames).toFixed(1), heapDelta: after.heap - before.heap, heapDeltaPerFrame: +((after.heap - before.heap) / frames).toFixed(1),
      forkCrossed: after.commits !== before.commits, buildsDuring: after.builds - before.builds,
      top: [...agg].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ bytes: v, stack: k })), gpuErrs: await gpuErrs(r.page), console: r.consoleLog.slice(0, 30) };
    await save('t11_alloc_v' + view, R.alloc);
    await r.close();
  } else if (cmd === 'perf') {
    // 12: scripted drive (seed 1, autopilot), 2560x1440, GPU timestamp busy time.
    const view = args[0] || '0', from = args[1] || '0';
    const r = await open(`?script=1&view=${view}&from=${from}`);
    await r.page.waitForFunction(() => window.__perf, null, { timeout: 200000, polling: 1000 });
    const p = await r.page.evaluate(() => window.__perf);
    const g = p.gpuMs.slice().sort((a, b) => a - b);
    const sp = p.spanMs.slice().sort((a, b) => a - b);
    R.perf = { view: +view, from: +from, avg: p.avg, median: p.median, p90: g[Math.floor(g.length * 0.9)], spanAvg: p.span.avg, spanMedian: p.span.median, frames: p.frames, passAvg: p.passAvg, adapter: p.adapter, canvas: p.canvas, found: p.found, clockEnd: p.clockEnd, cpuInterval: p.cpuInterval, gpuErrs: await gpuErrs(r.page), console: r.consoleLog };
    await save(`t12_perf_v${view}_from${from}`, R.perf);
    await r.close();
  } else {
    log('unknown test', cmd);
    process.exit(2);
  }
} catch (e) {
  console.error('TEST ERROR', e);
  process.exit(1);
}
process.exit(0);
