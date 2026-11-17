// Dev probe: node tools/probe.mjs '<query>' t1,t2,... [shotPrefix]
// Opens ?script=1&capture=1<query>, steps to each time, prints clock / events / sites, and
// optionally writes reports/shots/<prefix>_<t>.png.
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
import { join } from 'node:path';
const [query = '', times = '0', prefix] = process.argv.slice(2);
const srv = await serveDist();
const run = await launch('chromium');
const errs = [];
run.page.on('pageerror', (e) => errs.push(e.message));
try {
  const r = await openGame(run.page, srv.url, `?script=1&capture=1${query}`);
  if (r.error) throw new Error(r.error);
  await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
  for (const t of times.split(',').map(Number)) {
    await run.page.evaluate((t) => window.__step(t), t);
    await run.page.evaluate((t) => window.__step(t), t);
    const info = await run.page.evaluate(() => { const s = window.__game.state; return { clock: +s.clock.toFixed(2), year: Math.round(s.year), era: s.eraIdx, biome: [s.biomeA, s.biomeB, +s.biomeBlend.toFixed(2)], found: s.found, rate: Math.round(s.timeRate), surf: +s.surface.toFixed(2), route: window.__game.route(), ...window.__game.sites() }; });
    console.log('t=' + t, JSON.stringify(info));
    if (prefix) await run.page.screenshot({ path: join(ROOT, 'reports/shots', `${prefix}_${t}.png`) });
  }
  if (errs.length) console.log('ERRORS', errs.slice(0, 5));
} finally { await run.browser.close(); srv.close(); }
