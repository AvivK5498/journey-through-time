// Game-flow check on the built game: start screen over the live scene, Drive, pause menu,
// logbook, view and mute keys, quality buttons (remembered), the ending and the loop (journey
// card, Keep driving, veil, new seed, logbook and journeys kept), the 23-event logbook (grouped by era, kept across reloads
// with every bit up to 22), the closed land bridge and ?rate=.
//   node tools/flow-test.mjs [--no-build]
import { execSync } from 'node:child_process';
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
const srv = await serveDist();
const run = await launch('chromium');
const p = run.page;
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const G = () => p.evaluate(() => { const g = window.__game, s = g.state; return { clock: s.clock, speed: s.speed, view: s.view, seed: s.seed, loop: s.loop, found: s.found, rate: s.timeRate, started: g.ui.started, paused: g.ui.paused, logbook: g.ui.logbook, veil: g.ui.veil, tier: g.quality.tier }; });
const wait = (ms) => p.waitForTimeout(ms);
try {
  await openGame(p, srv.url, '?fresh=1');
  await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await p.evaluate(() => { try { localStorage.clear(); } catch (e) { /* */ } });
  await wait(1500);
  let a = await G();
  check(!a.started && a.clock === 0, 'start screen: not started, clock 0');
  check(await p.isVisible('#jt .start.on'), 'start screen visible over the scene');
  await p.click('#jt .go');
  await wait(2500);
  a = await G();
  check(a.started && a.clock > 1 && a.speed > 30, `Drive starts the journey (clock ${a.clock.toFixed(1)})`);
  check(a.rate > 1000, `time rate in era 1 at speed: ${Math.round(a.rate)} years/s`);
  await p.keyboard.press('Escape'); await wait(300);
  const c0 = (await G()).clock; await wait(1200); a = await G();
  check(a.paused && Math.abs(a.clock - c0) < 1e-6 && a.rate === 0, 'Esc pauses (clock frozen, rate 0)');
  check(await p.isVisible('#jt .menu.on'), 'menu shown');
  await p.click('#jt .seg button[data-q="medium"]'); await wait(300);
  a = await G();
  const w = await p.evaluate(() => document.getElementById('c').width);
  check(a.tier === 'medium' && w < 2560 * 0.85, `quality Medium (canvas ${w} px wide)`);
  const saved = await p.evaluate(() => localStorage.getItem('jtt.quality'));
  check(saved === 'medium', 'quality remembered');
  await p.click('#jt .seg button[data-q="high"]'); await wait(300);
  await p.keyboard.press('Escape'); await wait(500);
  a = await G();
  check(!a.paused, 'Esc resumes');
  await p.waitForFunction(() => window.__game.state.found & 1, null, { timeout: 30000 }).catch(() => {});
  check(await p.isVisible('#jt .cap.on'), 'camp caption shown when logged');
  await p.keyboard.press('KeyL'); await wait(400); a = await G();
  check(a.logbook && await p.isVisible('#jt .log.on'), 'L opens the logbook');
  const logTxt = await p.textContent('#jt .ents');
  check(/First humans/.test(logTxt), 'camp logged in the logbook');
  await p.keyboard.press('Tab'); await wait(400); a = await G();
  check(!a.logbook, 'Tab closes the logbook');
  await p.keyboard.press('KeyC'); await wait(300); a = await G();
  const hudOp = await p.evaluate(() => getComputedStyle(document.querySelector('#jt .hud')).opacity);
  check(a.view === 1, 'C switches to first person');
  await wait(800);
  check(Number(await p.evaluate(() => getComputedStyle(document.querySelector('#jt .hud')).opacity)) < 0.05, `year counter hidden in first person (opacity ${hudOp} -> 0)`);
  await p.keyboard.press('KeyC');
  await p.keyboard.press('KeyM'); await wait(200);
  check(true, 'M toggles mute (no error)');

  // The end: from clock 284 the car parks at the home, the echo and the rewind play, the
  // journey card shows; Keep driving loops into a new seeded world (logbook and journeys kept).
  // (tools/ending-test.mjs checks the ending itself in detail.)
  await openGame(p, srv.url, '?autodrive=1&t0=292');
  await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
  const seed0 = (await G()).seed;
  await p.waitForFunction(() => window.__game.ending().phase >= 2, null, { timeout: 60000 });
  check(true, 'the car takes over for the arrival');
  await p.waitForFunction(() => window.__game.ending().phase === 7, null, { timeout: 90000 });
  a = await G();
  check(a.loop === 0 && await p.isVisible('#jt .endc.on'), 'journey card shown, no loop yet');
  await p.click('#jt .keep');
  await p.waitForFunction(() => window.__game.ui.veil > 0.3, null, { timeout: 20000 });
  check(true, 'veil fades in before the loop');
  await p.waitForFunction(() => window.__game.state.loop > 0, null, { timeout: 60000 });
  a = await G();
  check(a.clock < 2 && a.seed !== seed0, `loop: clock ${a.clock.toFixed(1)}, seed ${seed0} -> ${a.seed}`);
  await wait(4500); a = await G();
  check(a.veil < 0.05, 'veil clears after the loop');
  const j = await p.evaluate(() => localStorage.getItem('jtt.journeys'));
  check(j === '1', 'journeys completed saved');

  // Logbook persistence with 23 bits: bits 0, 13, 21 and 22 survive a reload.
  const bits = (1 << 0) | (1 << 13) | (1 << 21) | (1 << 22);
  await p.evaluate((v) => localStorage.setItem('jtt.found', String(v)), bits);
  await openGame(p, srv.url, '?autodrive=1');
  await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
  a = await G();
  check(a.found === bits, `logbook kept across a reload with bits up to 22 (found ${a.found} = ${bits})`);
  await p.keyboard.press('KeyL'); await wait(400);
  const log = await p.evaluate(() => ({ eras: [...document.querySelectorAll('#jt .ents h3')].map((h) => h.firstChild.textContent),
    n: document.querySelectorAll('#jt .ents li').length, un: document.querySelectorAll('#jt .ents li.un').length, nf: document.querySelector('#jt .nf').textContent,
    names: [...document.querySelectorAll('#jt .ents li:not(.un) .nm')].map((x) => x.textContent) }));
  check(log.n === 23 && log.un === 19 && log.nf === '4 / 23', `logbook: ${log.n} entries, ${log.un} unseen, ${log.nf}`);
  check(log.eras.length === 7 && log.eras[6] === 'Modern', `grouped by the seven eras (${log.eras.join(', ')})`);
  check(log.names.includes('Taj Mahal') && log.names.includes('Home'), `logged entries named (${log.names.join(', ')})`);
  await p.keyboard.press('KeyL'); await wait(300);

  // Land bridge: seed 1 from clock 0 has an open causeway at its first ice fork; from t0=10
  // the ice fork comes after the thaw and its causeway is closed (road ends at the shore).
  await openGame(p, srv.url, '?script=1&capture=1');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  await p.evaluate(() => window.__step(20));
  let br = await p.evaluate(() => window.__game.sites().bridges);
  check(br.length > 0 && br.some((b) => b.available), `clock 20: causeway open (${JSON.stringify(br)})`);
  await openGame(p, srv.url, '?script=1&capture=1&t0=10');
  await p.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  await p.evaluate(() => window.__step(25));
  br = await p.evaluate(() => window.__game.sites().bridges);
  check(br.length > 0 && br.every((b) => !b.available), `t0=10: causeway closed (${JSON.stringify(br)})`);

  await openGame(p, srv.url, '?autodrive=1&rate=1234');
  await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await wait(1000); a = await G();
  check(Math.round(a.rate) === 1234, '?rate= forces state.timeRate');
  if (errs.length) { fails++; console.log('page errors:', errs.slice(0, 3)); }
} finally { await run.browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
