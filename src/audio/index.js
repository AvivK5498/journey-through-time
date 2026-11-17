// Generative music + car/ambience sound. Main-thread side: builds the worklet from
// a Blob URL (single-file build friendly) and forwards game state as k-rate
// AudioParams, so per-frame set() calls allocate nothing and post no messages.
// Values are sent as integers (blends in 1/1000, speed in 1/20 m/s): V8 boxes a
// non-integer double written to AudioParam.value, an int32 it does not.
import proc from './worklet.js';
import data from './data.js';

const NAMES = ['era', 'eb', 'ba', 'bb', 'bbl', 'spd', 'surf'];

export function create(over) {
  let ctx, node, out, an, fd, bins;
  const prm = [], sent = new Int32Array(7).fill(-1), levels = new Float32Array(8);
  return {
    levels,
    // Call from a user gesture. Pass an (Offline)AudioContext to render elsewhere.
    async start(c) {
      if (ctx) { if (ctx.state != 'running' && ctx.resume) await ctx.resume(); return; }
      ctx = c || new AudioContext({ latencyHint: 'playback' });
      const url = URL.createObjectURL(new Blob(['(' + proc + ')()'], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'jtt-audio', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: over ? Object.assign({}, data, over) : data });
      out = ctx.createGain(); an = ctx.createAnalyser();
      an.fftSize = 1024; an.smoothingTimeConstant = 0.75;
      node.connect(out).connect(ctx.destination);
      out.connect(an);
      for (let i = 0; i < 7; i++) prm[i] = node.parameters.get(NAMES[i]);
      fd = new Uint8Array(an.frequencyBinCount);
      bins = new Int16Array(9);
      for (let b = 0; b < 9; b++) bins[b] = Math.min(fd.length - 1, Math.round(60 * Math.pow(200, b / 8) * an.fftSize / ctx.sampleRate));
      if (!c && ctx.state != 'running') await ctx.resume();
    },
    // eraIdx and biome ids are 0-based indexes into data.eras / data.bios; surface 0 trail, 1 dirt, 2 stone (3 and up count as stone).
    set(eraIdx, eraBlend, biomeA, biomeB, biomeBlend, speed, surface) {
      if (!node) return;
      // inlined on purpose: passing doubles into a helper call would box them
      let q;
      if ((q = eraIdx | 0) != sent[0]) prm[0].value = sent[0] = q;
      if ((q = eraBlend * 1000 + 0.5 | 0) != sent[1]) prm[1].value = sent[1] = q;
      if ((q = biomeA | 0) != sent[2]) prm[2].value = sent[2] = q;
      if ((q = biomeB | 0) != sent[3]) prm[3].value = sent[3] = q;
      if ((q = biomeBlend * 1000 + 0.5 | 0) != sent[4]) prm[4].value = sent[4] = q;
      if ((q = speed * 20 + 0.5 | 0) != sent[5]) prm[5].value = sent[5] = q;
      if ((q = surface | 0) != sent[6]) prm[6].value = sent[6] = q;
    },
    stinger(id) { if (node) node.port.postMessage(id); },
    loopRestart() { if (node) node.port.postMessage(-1); },
    // The ending: the arrangement drops away over a bar, then the opening motif returns alone
    // on the first era's lead instrument and rings out on the tonic. loopRestart() ends it.
    finale() { if (node) node.port.postMessage(-2); },
    mute(m) { if (out) out.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05); },
    // Refreshes `levels` (8 log-spaced bands, 60 Hz-12 kHz, 0..1).
    readLevels() {
      if (!an) return levels;
      an.getByteFrequencyData(fd);
      for (let b = 0; b < 8; b++) {
        let s = 0, n = 0;
        for (let k = bins[b]; k <= bins[b + 1]; k++) { s += fd[k]; n++; }
        levels[b] = Math.min(1, Math.max(0, (s / n / 255 - 0.25) * 1.5));
      }
      return levels;
    },
  };
}

export default create();
