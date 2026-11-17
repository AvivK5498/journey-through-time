// Event-moment ("witness") check on the built game: at each of the four landmarks the E
// prompt appears, E starts the moment (time slowed, drive input ignored, letterbox and big
// caption, event logged), the camera leaves the car and comes back to the driving rig of the
// view it started from; E again and a drive key end it early; no page errors. Round three: the
// moment lasts ~10 s (held shot ~1.8-8.3 s, the camera still drifting), and --shots captures the
// held shot with its caption at 1920x1080 and 2560x1440 into reports/round3/witness/ (Giza, the
// longest caption; then the shortest caption, Trinity's text set into the same frame).
//   node tools/witness-test.mjs [--no-build] [--only=camp,cave,gobekli,giza] [--shots]
//                               [--page=index.html] (JT_BROWSER=brave to use Brave)
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, serveDist, launch, openGame as openGame0 } from './browser.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const PAGE = arg('page', 'index.html');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(ROOT, 'reports/round3/witness');
// (browser.mjs openGame, on any built page)
async function openGame(page, base, query) {
  if (PAGE === 'index.html') return openGame0(page, base, query);
  await page.goto(base + PAGE + query);
  await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 30000 });
}

// t0: journey clock to start at (autodrive follows history to the landmark); view; how to end.
const CASES = [
  { name: 'camp', ev: 0, t0: 0, view: 0, end: 'auto' },
  { name: 'camp-fp', ev: 0, t0: 0, view: 1, end: 'auto' },
  { name: 'camp-E', ev: 0, t0: 0, view: 0, end: 'E' },
  { name: 'cave', ev: 1, t0: 0, view: 1, end: 'W' },
  { name: 'gobekli', ev: 2, t0: 0, view: 0, end: 'auto' },
  { name: 'giza', ev: 3, t0: 80, view: 0, end: 'auto' },
].filter((c) => !ONLY || ONLY.includes(c.name) || ONLY.includes(c.name.split('-')[0]));

const srv = await serveDist();
const run = await launch(process.env.JT_BROWSER || 'chromium').catch(() => launch('brave'));
let p = run.page;
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const wait = (ms) => p.waitForTimeout(ms);
const G = () => p.evaluate(() => {
  const g = window.__game, s = g.state, c = g.camera, q = g.carPose;
  const dx = c.eye[0] - q[0], dy = c.eye[1] - q[1], dz = c.eye[2] - q[2];
  return { clock: s.clock, view: s.view, found: s.found, on: g.witness.on, scale: g.witness.scale, w: g.witness.w, cand: g.witnessIO[0], candEv: g.witnessIO[1],
    prompt: g.witnessUI.prompt, wit: document.getElementById('jt').classList.contains('wit'), eyeCar: Math.hypot(dx, dy, dz), fov: c.fovY, up: c.up[1],
    promptVis: getComputedStyle(document.querySelector('#jt .wp')).opacity };
});

// Captures of the held shot at both sizes: the real (longest) caption, then the shortest
// caption's text set into the same letterbox (layout check for a one-line explanation).
async function shots(pg) {
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
    await pg.setViewportSize({ width: w, height: h });
    await pg.waitForTimeout(250);
    await pg.screenshot({ path: join(SHOT_DIR, `witness_long_giza_${w}x${h}.png`) });
    const m = await pg.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel), b = e.getBoundingClientRect(); return { px: parseFloat(getComputedStyle(e).fontSize), h: Math.round(b.height), lines: Math.round(b.height / parseFloat(getComputedStyle(e).lineHeight)) }; };
      return { year: r('#jt .wy span'), name: r('#jt .wc .nm'), text: r('#jt .wc .tx'), bar: Math.round(document.querySelector('#jt .lb.b').getBoundingClientRect().height) };
    });
    console.log(`     ${w}x${h} long:  year ${m.year.px}px, name ${m.name.px}px, text ${m.text.px}px in ${m.text.lines} line(s), lower bar ${m.bar}px (${(100 * m.bar / h).toFixed(1)}% of the height)`);
  }
  const saved = await pg.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const old = [q('#jt .wy span').textContent, q('#jt .wc .nm').textContent, q('#jt .wc .tx').textContent];
    q('#jt .wy span').textContent = '1945'; q('#jt .wc .nm').textContent = 'Trinity test';
    q('#jt .wc .tx').textContent = 'The first nuclear weapon is tested in the New Mexico desert.';
    return old;
  });
  for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
    await pg.setViewportSize({ width: w, height: h });
    await pg.waitForTimeout(250);
    await pg.screenshot({ path: join(SHOT_DIR, `witness_short_trinity-text_${w}x${h}.png`) });
  }
  await pg.evaluate((o) => { const q = (s) => document.querySelector(s); q('#jt .wy span').textContent = o[0]; q('#jt .wc .nm').textContent = o[1]; q('#jt .wc .tx').textContent = o[2]; }, saved);
  await pg.setViewportSize({ width: 2560, height: 1440 });
}

try {
  for (const c of CASES) {
    console.log(`-- ${c.name} (event ${c.ev}, t0 ${c.t0}, view ${c.view}, end ${c.end})`);
    // A fresh page per case (a second navigation of one page kept the previous journey).
    await p.close(); p = await run.browser.contexts()[0].newPage(); await p.bringToFront(); p.on('pageerror', (e) => errs.push(e.message));
    const e0 = errs.length;
    await openGame(p, srv.url, `?autodrive=1&seed=1&fresh=1&t0=${c.t0}&view=${c.view}`);
    await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
    // Wait for the prompt for this landmark.
    const got = await p.waitForFunction((ev) => window.__game.witnessIO[0] >= 0 && window.__game.witnessIO[1] === ev, c.ev, { timeout: 140000, polling: 100 }).then(() => true).catch(() => false);
    if (!got) { check(false, `prompt for event ${c.ev} never offered (clock ${(await G()).clock.toFixed(1)})`); console.log(JSON.stringify(await p.evaluate(() => window.__game.sites().sites))); continue; }
    await wait(700);
    let a = await G();
    check(a.prompt && Number(a.promptVis) > 0.5, `prompt shown (clock ${a.clock.toFixed(1)}, opacity ${a.promptVis})`);
    const before = a;
    const rig0 = a.eyeCar;
    const c0 = a.clock; await wait(1000); const rate0 = (await G()).clock - c0;
    await p.keyboard.press('KeyE');
    const tPress = Date.now();
    await wait(300);
    a = await G();
    check(a.on && a.wit, `E starts the moment (letterbox ${a.wit})`);
    check(!a.prompt, 'prompt hidden during the moment');
    await wait(1700);
    a = await G();
    check((a.found >> c.ev) & 1, `event ${c.ev} logged (found ${a.found})`);
    check(a.scale < 0.2, `time slowed (scale ${a.scale.toFixed(3)})`);
    check(a.view === 0, `third-person body shown while the camera is away (view ${a.view})`);
    check(a.eyeCar > 20, `camera away from the car (${a.eyeCar.toFixed(1)} m)`);
    check(a.fov < 0.8, `narrow lens (${a.fov.toFixed(2)})`);
    const c1 = a.clock; await wait(1000); const b = await G(); const rate1 = b.clock - c1;
    check(rate1 < rate0 * 0.25 + 0.02, `clock ${rate0.toFixed(2)} -> ${rate1.toFixed(3)} s per s`);
    // The held shot (auto cases): still on at ~7 s from the press, fully framed, and drifting.
    if (c.end === 'auto') {
      const e1 = await p.evaluate(() => Array.from(window.__game.camera.eye));
      await wait(3600); // ~7.3 s after the press
      a = await G();
      const e2 = await p.evaluate(() => Array.from(window.__game.camera.eye));
      const moved = Math.hypot(e2[0] - e1[0], e2[1] - e1[1], e2[2] - e1[2]);
      check(a.on && a.wit && a.w > 0.99, `shot still held at ~7 s (w ${a.w.toFixed(2)}, letterbox ${a.wit})`);
      check(moved > 0.3, `camera drifts during the hold (${moved.toFixed(2)} m in 3.6 s)`);
      if (SHOTS && c.name === 'giza') await shots(p);
    }
    // Drive input is ignored: hold throttle briefly (W ends it early only in the 'W' case).
    if (c.end === 'E') { await p.keyboard.press('KeyE'); }
    else if (c.end === 'W') { await p.keyboard.down('KeyW'); await wait(100); await p.keyboard.up('KeyW'); }
    if (c.end !== 'auto') {
      await wait(400);
      a = await G();
      check(!a.wit, `${c.end} ends it early (letterbox off, w ${a.w.toFixed(2)})`);
      await p.waitForFunction(() => !window.__game.witness.on, null, { timeout: 4000 }).catch(() => {});
    } else {
      await p.waitForFunction(() => !window.__game.witness.on, null, { timeout: 9000, polling: 50 }).catch(() => {});
      const total = (Date.now() - tPress) / 1000;
      check(total > 8.8 && total < 11.5, `moment lasts ~10 s (${total.toFixed(1)} s)`);
    }
    await wait(250);
    a = await G();
    check(!a.on && a.scale === 1, 'moment over, time at normal speed');
    check(a.view === c.view, `back in the starting view (${a.view})`);
    check(Math.abs(a.eyeCar - rig0) < (c.view ? 0.6 : 3), `camera back on the driving rig (${a.eyeCar.toFixed(2)} m from the car, was ${rig0.toFixed(2)})`);
    check(Math.abs(a.up - 1) < 1e-6, 'horizon level');
    // Once witnessed, no nagging.
    await wait(600);
    a = await G();
    check(!(a.cand >= 0 && a.candEv === c.ev), 'no prompt again for the same landmark');
    check(errs.length === e0, `no page errors${errs.length > e0 ? ': ' + errs.slice(e0).join(' | ') : ''}`);
    void before;
  }
} finally {
  await run.browser.close();
  srv.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
