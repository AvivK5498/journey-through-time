// JS allocation probe for the steady-state frame loop.
//   node tools/alloc.mjs ['?script=1'] [WARM=ms env, default 15000]
// Starts the dev build (unminified, so function names are readable), lets the page warm up
// so hot functions are optimised, then samples every heap allocation (including ones the
// GC already collected) for 5 s and prints the top allocating call stacks.
// Expected residue: WebGPU wrapper objects created inside renderFrame (encoder, passes,
// command buffer, canvas texture), which JS cannot avoid.
import { launch } from './browser.mjs';
import { spawn } from 'node:child_process';

const dev = spawn('node', ['build.mjs', '--dev'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT: '5199' } });
await new Promise((r) => dev.stdout.on('data', (d) => { if (String(d).includes('dev server')) r(); }));
const { browser, page } = await launch();
try {
  await page.goto('http://localhost:5199/' + (process.argv[2] || ''));
  await page.waitForTimeout(Number(process.env.WARM || 15000));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await page.waitForTimeout(5000);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const agg = new Map();
  (function walk(n, stack) {
    const s = stack.concat(`${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber}`);
    const key = s.slice(-3).join(' < ');
    if (n.selfSize) agg.set(key, (agg.get(key) || 0) + n.selfSize);
    for (const c of n.children) walk(c, s);
  })(profile.head, []);
  console.log('bytes in 5 s (sampled estimate)\tstack (innermost last)');
  console.log([...agg].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v}\t${k}`).join('\n'));
} finally {
  await browser.close();
  dev.kill();
}
