// Scripted-drive perf harness.
//   node tools/perf.mjs [--view=0|1|both] [--from=<clock s>] [--browser=chromium|brave] [--no-build]
//   node tools/perf.mjs --ending [--view=..] [--seed=N]   the ending's phases (reports/perf_ending.json)
// --from=N measures clock N to N+60 of the same seed-1 autopilot journey (it fast-forwards the
// drive to N first); 0, 60, 120, 180 and 240 together cover the whole 300 s journey. Writes
// reports/perf.json (or reports/perf_from<N>.json when --from is not 0). JT_QUERY adds flags
// (e.g. JT_QUERY='&placeholders=1' to stand the example landmark in for missing modules).
// Builds dist/, serves it on localhost, opens ?script=1 headed on the real GPU, waits for
// window.__perf (60 s drive + warmup), writes reports/perf.json and prints the numbers.
// Exits non-zero if the adapter is a software/fallback adapter or anything else fails.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, serveDist, launch, openGame, isSoftwareAdapter } from './browser.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const viewArg = arg('view', 'both');
const views = viewArg === 'both' ? [0, 1] : [Number(viewArg)];
const FROM = Number(arg('from', '0')) || 0;
let which = arg('browser', 'chromium');

function die(msg) { console.error(`\nPERF FAILED: ${msg}\n`); process.exit(1); }

if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });

const srv = await serveDist();
let run;
try {
  run = await launch(which);
  let probe = await openGame(run.page, srv.url, '?pose=0');
  if (which === 'chromium' && (probe.error || !probe.adapter?.timestampQuery)) {
    console.log(`Chromium: ${probe.error || 'no timestamp-query'}; falling back to Brave`);
    await run.browser.close();
    which = 'brave';
    run = await launch(which);
    probe = await openGame(run.page, srv.url, '?pose=0');
  }
  if (probe.error) die(`WebGPU init failed in ${which}: ${probe.error}`);
  if (isSoftwareAdapter(probe.adapter)) die(`software/fallback adapter: ${JSON.stringify(probe.adapter)}`);
  if (!probe.adapter.timestampQuery) die('timestamp-query is not available, GPU times cannot be measured');

  if (process.argv.includes('--ending')) {
    // The ending (src/ending.js) from clock 280 in free drive (autopilot on): GPU frame times
    // per phase (arrival, parked, echo, rewind, line), until the journey card shows.
    const SEED = Number(arg('seed', '1')) || 1;
    const out = [];
    for (const view of views) {
      console.log(`\nEnding from clock 280, seed ${SEED}, view ${view} ...`);
      await openGame(run.page, srv.url, `?autodrive=1&fresh=1&t0=280&seed=${SEED}&endperf=1&view=${view}${process.env.JT_QUERY || ''}`);
      await run.page.bringToFront();
      await run.page.waitForFunction(() => window.__endPerf || window.__gpuError, null, { timeout: 240000, polling: 1000 });
      const r = await run.page.evaluate(() => window.__endPerf || { error: window.__gpuError });
      if (r.error) die(r.error);
      if (isSoftwareAdapter(r.adapter)) die(`software/fallback adapter: ${JSON.stringify(r.adapter)}`);
      out.push(r);
      for (const [k, v] of Object.entries(r.phases)) {
        const pass = v.avg <= 11 && v.max <= 16.7 ? 'PASS' : 'FAIL';
        console.log(`  view ${view} ${k.padEnd(8)} avg ${v.avg.toFixed(3)} ms  p99 ${v.p99.toFixed(3)}  max ${v.max.toFixed(3)}  (${v.frames} frames)  [${pass}]`);
      }
    }
    mkdirSync(join(ROOT, 'reports'), { recursive: true });
    writeFileSync(join(ROOT, 'reports/perf_ending.json'), JSON.stringify({ date: new Date().toISOString(), browser: `${which} ${run.version}`, target: { avgMs: 11, maxMs: 16.7, canvas: [2560, 1440] }, runs: out }, null, 1));
    console.log('\nwrote reports/perf_ending.json');
    process.exit(0);
  }

  const results = [];
  for (const view of views) {
    console.log(`\nRunning 60 s scripted drive from clock ${FROM}, view ${view} (${view ? 'first' : 'third'} person) in ${which} ${run.version} ...`);
    await openGame(run.page, srv.url, `?script=1&from=${FROM}&view=${view}${process.env.JT_QUERY || ""}`); // JT_QUERY: extra debug flags
    await run.page.bringToFront();
    await run.page.waitForFunction(() => window.__perf || window.__gpuError, null, { timeout: 180000, polling: 1000 });
    const perf = await run.page.evaluate(() => window.__perf || { error: window.__gpuError });
    if (perf.error) die(perf.error);
    // ?grassdbg=1: per logged frame grass instance count and camera eye (debug readback).
    const gd = await run.page.evaluate(() => {
      const g = window.__grassDbg; if (!g) return null;
      const f0 = g.timing.logFrom, n = g.timing.logCount, out = { count: [], eye: [] };
      for (let i = 0; i < n; i++) { const j = (f0 + i) & 8191; out.count.push(g.count[j]); out.eye.push([g.eye[j * 4], g.eye[j * 4 + 1], g.eye[j * 4 + 2]].map((v) => Math.round(v * 100) / 100)); }
      return out;
    });
    if (gd) { perf.grassCount = gd.count; perf.grassEye = gd.eye; }
    if (isSoftwareAdapter(perf.adapter)) die(`software/fallback adapter: ${JSON.stringify(perf.adapter)}`);
    if (!perf.frames) die('no GPU timestamps were collected');
    results.push(perf);
  }

  // Per-biome breakdown: which biome dominates at the car each second of the drive (capture
  // mode, same deterministic route), then the logged frames are binned by their time.
  await openGame(run.page, srv.url, `?script=1&capture=1&from=${FROM}${process.env.JT_QUERY || ''}`);
  await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  const biomeAt = await run.page.evaluate(async () => {
    const out = [];
    for (let t = 0; t <= 60; t++) { await window.__step(t); const s = window.__jt.state; out.push(Math.max(0, Math.min(6, s.biomeBlend > 0.5 || s.biomeA === s.biomeB ? s.biomeB : s.biomeA))); }
    return out;
  });
  const NAMES = ['savannah', 'ice', 'desert', 'forest', 'steppe', 'mountains', 'coast'];
  for (const r of results) {
    const n = r.gpuMs.length, acc = NAMES.map(() => []);
    r.gpuMs.forEach((ms, i) => acc[biomeAt[Math.min(60, Math.floor(i / n * 60))]].push(ms));
    r.perBiome = {};
    acc.forEach((a, b) => {
      if (!a.length) return;
      const srt = [...a].sort((x, y) => x - y);
      r.perBiome[NAMES[b]] = { frames: a.length, avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), median: +srt[srt.length >> 1].toFixed(3) };
    });
  }
  const report = {
    date: new Date().toISOString(),
    browser: `${which} ${run.version}`,
    adapter: results[0].adapter,
    target: { avgMs: 11, maxMs: 16.7, canvas: [2560, 1440] },
    runs: results,
  };
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  const outName = FROM ? `reports/perf_from${FROM}.json` : 'reports/perf.json';
  report.from = FROM;
  writeFileSync(join(ROOT, outName), JSON.stringify(report, null, 1));

  const a = report.adapter;
  console.log(`\nBrowser : ${report.browser}`);
  console.log(`Adapter : ${a.description || a.device} (vendor ${a.vendor}, arch ${a.architecture}, fallback ${a.isFallbackAdapter})`);
  for (const r of results) {
    const gcd = r.timestampGcdNs;
    const prec = gcd >= 100000 && gcd % 100000 === 0 ? `QUANTISED (gcd ${gcd} ns)` : `gcd of timestamps ${gcd} ns`;
    const pass = r.avg <= 11 && r.max <= 16.7 ? 'PASS' : 'FAIL';
    console.log(`view ${r.view}: GPU busy avg ${r.avg.toFixed(3)} ms  p99 ${r.p99.toFixed(3)} ms  max ${r.max.toFixed(3)} ms  ` +
      `over ${r.frames} frames at ${r.canvas.join('x')}  [${pass} vs 11 / 16.7 ms]`);
    if (r.span) console.log(`        span (first pass begin -> last pass end, includes other GPU clients): avg ${r.span.avg} ms  p99 ${r.span.p99} ms  max ${r.span.max} ms`);
    if (r.perBiome) console.log('        per biome (avg / median GPU ms): ' + Object.entries(r.perBiome).map(([k, v]) => `${k} ${v.avg} / ${v.median} (${v.frames} frames)`).join(', '));
    const sorted = [...r.gpuMs].sort((x, y) => x - y);
    console.log(`        median ${sorted[sorted.length >> 1].toFixed(3)} ms (maxima are not meaningful while other GPU clients run)`);
    if (r.passAvg) console.log(`        average per pass (ms, pass order): ${r.passAvg.join(' ')}`);
    const ids = []; for (let i = 0; i < 23; i++) if ((r.found >>> i) & 1) ids.push(i);
    console.log(`        events logged by the end: [${ids.join(', ')}] (event ids, world/time.js), clock ${r.clockEnd.toFixed(1)}`);
    console.log(`        CPU frame interval avg ${r.cpuInterval.avg} ms  p99 ${r.cpuInterval.p99} ms  max ${r.cpuInterval.max} ms; timestamps: ${prec}; dropped batches ${r.droppedBatches}`);
  }
  console.log('\nwrote ' + outName);
} finally {
  if (run) await run.browser.close();
  srv.close();
}
