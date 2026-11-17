// Ad-hoc captures (dev helper): node tools/look.mjs [--small] <out.png> <query | t=seconds[&view=1]> ...
// A query is opened as a pose page; t=... renders the scripted drive at that time (extra
// params after t are passed through, e.g. 't=30&view=1&hide=grass'). Files go to
// reports/shots/ (or $LOOK_DIR); --small also writes a 1280-wide copy next to it.
import { ROOT, serveDist, launch, openGame } from './browser.mjs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
const small = process.argv.includes('--small');
const args = process.argv.slice(2).filter((a) => a !== '--small');
const dir = process.env.LOOK_DIR || join(ROOT, 'reports/shots');
const srv = await serveDist();
const run = await launch('chromium');
const errs = [];
run.page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
try {
  for (let i = 0; i < args.length; i += 2) {
    const a = args[i + 1];
    if (a.startsWith('t=')) {
      const p = new URLSearchParams(a);
      const t = Number(p.get('t'));
      p.delete('t');
      const r = await openGame(run.page, srv.url, `?script=1&capture=1&view=${p.get('view') || 0}&` + p.toString());
      if (r.error) throw new Error(r.error);
      await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
      for (let k = 0; k < 4; k++) await run.page.evaluate((t) => window.__step(t), t);
    } else {
      const r = await openGame(run.page, srv.url, a);
      if (r.error) throw new Error(r.error);
      await run.page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
    }
    const out = join(dir, args[i]);
    await run.page.screenshot({ path: out });
    if (small) execSync(`sips -Z 1280 '${out}' --out '${out.replace(/\.png$/, '_s.png')}'`, { stdio: 'ignore' });
    console.log('wrote', out, errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ').slice(0, 1500) : '');
    errs.length = 0;
  }
} finally { await run.browser.close(); srv.close(); }
