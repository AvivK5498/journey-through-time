// Dev: step the scripted drive (capture mode) and, if a step hangs, print the JS stack (CDP pause).
//   node tools/hang-probe.mjs <from> <to> <step>
import { serveDist, launch, openGame } from './browser.mjs';
const [from, to, st] = process.argv.slice(2).map(Number);
const srv = await serveDist();
const run = await launch('chromium');
const cdp = await run.page.context().newCDPSession(run.page);
await cdp.send('Debugger.enable');
cdp.on('Debugger.paused', (e) => {
  console.log('PAUSED\n  ' + e.callFrames.slice(0, 14).map((f) => `${f.functionName} @${f.location.lineNumber}:${f.location.columnNumber}`).join('\n  '));
  run.browser.close().then(() => process.exit(0));
});
await openGame(run.page, srv.url, '?script=1&capture=1');
await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
for (let t = from; t <= to; t += st) {
  const p = run.page.evaluate((t) => window.__step(t).then(() => window.__game.state.clock), t);
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('TIMEOUT'), 30000))]);
  console.log(t, r);
  if (r === 'TIMEOUT') { await cdp.send('Debugger.pause'); await new Promise((res) => setTimeout(res, 20000)); break; }
}
await run.browser.close(); srv.close();
