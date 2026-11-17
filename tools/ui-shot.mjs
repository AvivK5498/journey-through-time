// Screenshots every UI state of ui-test.html at 2560x1440 into reports/ui/<state>.png.
//   node tools/ui-shot.mjs [state ...]
// Serves the project root (ES modules straight from src/), launches Playwright's Chromium
// headed like tools/shots.mjs (no WebGPU is used by this page).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { launch, ROOT } from './browser.mjs';

const OUT = join(ROOT, 'reports/ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const srv = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0]));
  const file = join(ROOT, p === '/' ? 'ui-test.html' : p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(file));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://localhost:${srv.address().port}/ui-test.html`;

mkdirSync(OUT, { recursive: true });
const run = await launch('chromium');
try {
  await run.page.goto(base + '?cap=1');
  await run.page.waitForFunction(() => window.__ready);
  const all = await run.page.evaluate(() => window.__states);
  const want = process.argv.slice(2).length ? process.argv.slice(2) : all;
  for (const s of want) {
    await run.page.goto(`${base}?cap=1&s=${s}`);
    await run.page.waitForFunction(() => window.__ready);
    await run.page.evaluate(() => document.fonts.ready);
    const file = join(OUT, `${s}.png`);
    await run.page.screenshot({ path: file });
    console.log('wrote', file);
  }
} finally {
  await run.browser.close();
  srv.close();
}
