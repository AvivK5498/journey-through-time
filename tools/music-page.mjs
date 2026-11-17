// Builds the music audition page: dist/music.html (standalone, no network) and a copy
// at share/music.html. Buttons for era 0-6 and biome 0-6 (any combination), stingers
// 4-22 and the original four, finale, loop restart, mute, and a readout of what plays.
// Usage: node tools/music-page.mjs   then open http://localhost:8766/music.html
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = `
import audio from './src/audio/index.js';
import data from './src/audio/data.js';
const $ = (s) => document.querySelector(s);
const STING = ['0 First camp', '1 Cave paintings', '2 Gobekli Tepe', '3 Giza', '4 Stonehenge', '5 Great Wall', '6 Parthenon', '7 Gothic cathedral',
  '8 Mongol encampment', '9 Timbuktu', '10 Great Zimbabwe', '11 1492 fleet', '12 Machu Picchu', '13 Taj Mahal', '14 Steam mill', '15 Railroad',
  '16 First flight', '17 Trench line', '18 Trinity', '19 Apollo', '20 Melting glacier', '21 Megacity', '22 The home'];
const ERAS = ['0 Origins', '1 First farmers', '2 Ancient empires', '3 Connected world', '4 Sail and science', '5 Industry', '6 Modern'];
const st = { era: 0, bio: 0, speed: 0, started: false, muted: false, last: '' };
let t0 = performance.now(), bars = 0;
function mk(parent, items, fn, cls) {
  const els = items.map((t, i) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => fn(i); if (cls) b.className = cls; $(parent).appendChild(b); return b; });
  return els;
}
async function ensure() { if (!st.started) { await audio.start(); st.started = true; $('#start').hidden = true; } }
function apply() {
  audio.set(st.era, 0, st.bio, st.bio, 0, st.speed, Math.min(3, st.era));
  t0 = performance.now();
  mark();
  show();
}
const eraB = mk('#eras', ERAS, async (i) => { await ensure(); st.era = i; apply(); }, 'era');
const bioB = mk('#bios', data.bios.map((b, i) => i + ' ' + b.n), async (i) => { await ensure(); st.bio = i; apply(); }, 'bio');
mk('#sting', STING, async (i) => { await ensure(); audio.stinger(i); st.last = 'stinger ' + STING[i]; show(); });
$('#finale').onclick = async () => { await ensure(); audio.finale(); st.last = 'finale() called: the arrangement drops away, the motif returns on the flute'; show(); };
$('#loop').onclick = async () => { await ensure(); audio.loopRestart(); st.last = 'loopRestart(): back to the dawn, drum and flute'; show(); };
$('#mute').onclick = () => { st.muted = !st.muted; audio.mute(st.muted); $('#mute').textContent = st.muted ? 'Unmute' : 'Mute'; show(); };
$('#start').onclick = async () => { await ensure(); apply(); };
$('#speed').oninput = (e) => { st.speed = +e.target.value; $('#spv').textContent = st.speed + ' m/s'; if (st.started) apply(); };
function mark() { eraB.forEach((b, i) => b.classList.toggle('on', i == st.era)); bioB.forEach((b, i) => b.classList.toggle('on', i == st.bio)); }
function show() {
  const b = data.bios[st.bio], e = data.eras[st.era];
  $('#now').innerHTML = '<b>Era ' + st.era + '</b> ' + e.n + ' &nbsp;&middot;&nbsp; <b>Biome ' + st.bio + '</b> ' + b.n + '<br>' + b.mode +
    ' &middot; ' + b.bpm + ' bpm &middot; ' + (b.bl == 12 ? '6/8 (12 steps)' : '4/4 (16 steps)') + ' &middot; ' + e.parts.length + ' era parts + ' + b.parts.length + ' biome parts' +
    '<br><span class="dim">' + (st.started ? (st.muted ? 'muted. ' : '') + (st.last || 'playing; changes land on the next bar line') : 'press Start (browsers need a click before sound)') + '</span>';
}
const bars_ = $('#lv'); for (let i = 0; i < 8; i++) bars_.appendChild(document.createElement('i'));
function tick() {
  if (st.started) { audio.readLevels(); for (let i = 0; i < 8; i++) bars_.children[i].style.height = Math.round(audio.levels[i] * 100) + '%'; }
  $('#clk').textContent = st.started ? ((performance.now() - t0) / 1000).toFixed(0) + ' s since last change' : '';
  requestAnimationFrame(tick);
}
mark(); show(); tick();
`;
const r = await esbuild.build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'music-page.js' }, bundle: true, minify: true, write: false, format: 'iife', target: 'es2022' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journey through time: music</title>
<style>
  :root { --bg: #15130f; --panel: #211e18; --ink: #efe6d2; --dim: #a39a86; --acc: #e0a64a; --bar: #7fc4a4; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 0 0 8px; color: var(--dim); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
  p.sub { color: var(--dim); margin: 0 0 16px; }
  section { background: var(--panel); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button { background: #2c2820; color: var(--ink); border: 1px solid #4a4335; border-radius: 6px; padding: 7px 12px; font: inherit; cursor: pointer; }
  button:hover { border-color: var(--acc); }
  button.on { background: var(--acc); color: #1a1408; border-color: var(--acc); font-weight: 600; }
  button.main { background: var(--acc); color: #1a1408; border-color: var(--acc); font-weight: 600; }
  .dim { color: var(--dim); }
  #now { min-height: 4.4em; }
  #lv { display: flex; gap: 5px; height: 46px; align-items: flex-end; margin-top: 10px; }
  #lv i { flex: 1; background: var(--bar); border-radius: 2px; min-height: 2px; transition: height 60ms linear; }
  input[type=range] { accent-color: var(--acc); width: 220px; }
</style>
</head>
<body>
<main>
  <h1>Journey through time: music</h1>
  <p class="sub">Pick any era and any biome. Changes land on the next bar line, exactly as in the game. The same short motif opens every combination.</p>
  <section>
    <div class="row"><button id="start" class="main">Start</button><button id="mute">Mute</button><button id="finale">finale()</button><button id="loop">loopRestart()</button>
      <label class="dim">engine speed <input id="speed" type="range" min="0" max="40" value="0"> <span id="spv">0 m/s</span></label></div>
    <div id="now" style="margin-top:12px"></div>
    <div class="dim" id="clk"></div>
    <div id="lv"></div>
  </section>
  <section><h2>Era (instrumentation)</h2><div class="row" id="eras"></div></section>
  <section><h2>Biome (melody, rhythm, lead instrument)</h2><div class="row" id="bios"></div></section>
  <section><h2>Landmark stingers (event id)</h2><div class="row" id="sting"></div></section>
</main>
<script>${js}</script>
</body>
</html>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'share'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/music.html'), html);
fs.copyFileSync(path.join(root, 'dist/music.html'), path.join(root, 'share/music.html'));
console.log(`dist/music.html and share/music.html: ${(html.length / 1024).toFixed(1)} KB`);
