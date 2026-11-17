// Music tables. Everything the worklet plays comes from here: adding eras or
// biomes means adding rows, not code. Passed to the worklet as processorOptions.
//
// Instrument row: [alg, octave(semitones), gain, attack s, decay tau s, release tau s,
//                  bright, vib, pan, reverb send, delay send, fixed Hz (drums, noise)]
// alg: 0 membrane drum (vib = pitch bend), 1 breathy flute / ney (vib = vibrato),
// 2 plucked string (Karplus-Strong), 3 reed pipe, 4 brass, 5 FM bell / kalimba /
// marimba (vib = FM ratio), 6 noise hit (fixed Hz = high-pass corner), 7 bowed string
// (detuned saws, vibrato), 8 choir pad (formant band), 9 synth saw pair,
// 10 electric bass (saw + sine), 11 piano (additive).
//
// Part row: [instrument, role, pattern ('.' rest, 1-9 velocity, up to 16 steps), octave, keep, degrees, flags]
// role: 0 the biome's melody (its own 8-bar theme, with ornaments), 1 arpeggio over the
// chord, 2 low call on phrase starts, 3 drum, 4 the "Journey through time" motif only
// (era instrument; when the loop restarts it plays the whole theme), 6 pad (sustained
// chord, `degrees` = chord offsets from the bar's root), 7 line (hits step through
// `degrees`, restarting each bar). keep=1: still plays after loopRestart().
// flags: 1 = acoustic (faded by the era's `ac`, so modern eras thin out hand drums),
// 2 = no random ghost hits.
// Era parts fade with era weight, biome parts with biome weight; all fades run
// across one bar starting on a bar line.
const FL = 0, DRL = 1, DRS = 2, SHK = 3, FRM = 4, RIM = 5, LYR = 6, HRP = 7, RED = 8, BRL = 9, BEL = 10, DEEP = 11,
  LUT = 12, BWL = 13, CHO = 14, HPS = 15, STR = 16, PNO = 17, BRS = 18, STM = 19, CLK = 20, EBS = 21, SYL = 22, SYP = 23,
  KCK = 24, SNR = 25, HAT = 26, NEY = 27, OUD = 28, KAL = 29, MAR = 30, TLK = 31, BWS = 32, FFL = 33, FID = 34, RFD = 35,
  PAN = 36, STL = 37, HOO = 38;

// "step:degree:length" per bar (steps of the biome's bar length), joined into one flat theme.
const theme = (bl, bars) => {
  const o = [];
  bars.forEach((b, i) => b.split(' ').forEach((t) => { const [a, d, l] = t.split(':').map(Number); o.push(i * bl + a, d, l); }));
  return o;
};
// "step:degree:length:velocity" -> flat sting rows for one instrument
const S = (inst, str) => str.split(' ').flatMap((t) => { const [a, d, l, v] = t.split(':').map(Number); return [a, inst, d, l, v || 7]; });
// a run of identical hits: from step a to b every k steps
const R = (inst, deg, a, b, k, v1, v2 = v1) => { const o = []; for (let s = a; s <= b; s += k) o.push(s, inst, deg, 1, Math.round(v1 + (v2 - v1) * (s - a) / Math.max(1, b - a))); return o; };

// The motif, in degrees of each biome's scale: -3 0 4 5 4. Every biome theme opens with it
// (bars 0 and 4) and every era plays it on its own instrument, so it is one piece.
const MOT = '0:-3:2 2:0:2 4:4:6 10:5:2 12:4:4';
const MOT12 = '0:-3:2 2:0:2 4:4:4 8:5:2 10:4:2';

export default {
  ton: 62, // tonic D4
  inst: [
    [1, 12, 0.3, 0.07, 4, 0.16, 0.45, 0.5, -0.18, 0.32, 0.26, 0], // 0 breathy flute
    [0, 0, 0.5, 0.001, 0.2, 0.05, 0.22, 1.1, -0.3, 0.12, 0, 96], // 1 hand drum, low
    [0, 0, 0.4, 0.001, 0.08, 0.03, 0.6, 0.4, 0.38, 0.12, 0, 230], // 2 hand drum, slap
    [6, 0, 0.15, 0.003, 0.04, 0.02, 0.6, 0, 0.55, 0.08, 0, 0], // 3 shaker
    [0, 0, 0.5, 0.001, 0.4, 0.1, 0.3, 0.6, 0.05, 0.2, 0, 64], // 4 frame drum
    [6, 0, 0.17, 0.002, 0.11, 0.05, 0.25, 0, -0.42, 0.14, 0, 0], // 5 jingle / rim
    [2, 0, 1, 0.004, 0.5, 0.15, 0.62, 0, 0.24, 0.3, 0.18, 0], // 6 plucked lyre
    [2, 0, 0.85, 0.004, 0.75, 0.25, 0.42, 0, -0.26, 0.42, 0.12, 0], // 7 harp
    [3, 12, 0.32, 0.035, 4, 0.12, 0.55, 0.35, 0.1, 0.3, 0.22, 0], // 8 reed pipe
    [4, -24, 0.32, 0.16, 5, 0.45, 0.45, 0.2, -0.12, 0.5, 0.08, 0], // 9 low brass
    [5, 12, 0.18, 0.002, 1.3, 0.5, 0.55, 3.5, 0.42, 0.6, 0.4, 0], // 10 glass bell
    [0, 0, 0.45, 0.001, 0.55, 0.15, 0.2, 0.8, 0, 0.22, 0, 50], // 11 deep drum
    [2, 0, 0.9, 0.004, 0.9, 0.2, 0.5, 0, -0.2, 0.3, 0.12, 0], // 12 lute
    [7, -12, 0.2, 0.28, 6, 0.5, 0.3, 0.8, -0.1, 0.45, 0.05, 0], // 13 bowed, low
    [8, 0, 0.16, 0.5, 8, 0.8, 0.4, 0.8, 0.05, 0.7, 0.1, 0], // 14 choir pad
    [2, 0, 0.9, 0.002, 0.35, 0.08, 0.92, 0, 0.18, 0.22, 0.1, 0], // 15 harpsichord
    [7, 0, 0.14, 0.18, 6, 0.4, 0.45, 0.9, 0.2, 0.5, 0.05, 0], // 16 strings
    [11, 0, 0.5, 0.002, 1.2, 0.2, 0.5, 0, 0, 0.3, 0.08, 0], // 17 piano
    [4, -12, 0.3, 0.05, 2.5, 0.25, 0.7, 0, 0.1, 0.4, 0.06, 0], // 18 brass section
    [6, 0, 0.12, 0.004, 0.07, 0.03, 0.2, 0, 0.1, 0.12, 0, 1100], // 19 steam chuff
    [0, 0, 0.4, 0.001, 0.07, 0.02, 0.8, 1.5, -0.2, 0.1, 0, 140], // 20 machine clank
    [10, -24, 0.45, 0.004, 0.22, 0.06, 0.6, 0, 0, 0.04, 0, 0], // 21 electric bass
    [9, 12, 0.18, 0.01, 1.5, 0.2, 0.6, 0.8, 0.12, 0.3, 0.3, 0], // 22 synth lead
    [9, 0, 0.1, 0.35, 6, 0.6, 0.3, 0.5, -0.15, 0.55, 0.1, 0], // 23 synth pad
    [0, 0, 0.7, 0.001, 0.14, 0.03, 0.12, 4.5, 0, 0.03, 0, 52], // 24 kick
    [0, 0, 0.45, 0.001, 0.09, 0.03, 0.95, 0.3, 0.05, 0.2, 0, 190], // 25 snare
    [6, 0, 0.12, 0.001, 0.025, 0.01, 0.9, 0, 0.25, 0.05, 0, 7500], // 26 hat
    [1, 12, 0.3, 0.04, 4, 0.15, 0.75, 0.9, 0.12, 0.35, 0.25, 0], // 27 ney
    [2, 0, 0.8, 0.003, 0.7, 0.2, 0.4, 0, -0.2, 0.3, 0.14, 0], // 28 oud
    [5, 12, 0.22, 0.002, 0.75, 0.2, 0.3, 5.2, 0.15, 0.4, 0.3, 0], // 29 kalimba
    [5, 0, 0.3, 0.002, 0.35, 0.1, 0.12, 4, -0.1, 0.25, 0.1, 0], // 30 marimba
    [0, 0, 0.35, 0.001, 0.12, 0.04, 0.45, 1.6, 0.3, 0.1, 0, 330], // 31 talking drum
    [7, 0, 0.2, 0.7, 6, 0.8, 0.25, 0.8, 0.1, 0.8, 0.08, 0], // 32 bowed, soft and slow
    [1, 12, 0.28, 0.03, 4, 0.12, 0.3, 0.7, 0.1, 0.25, 0.15, 0], // 33 folk flute
    [7, 0, 0.14, 0.05, 3, 0.2, 0.7, 1, -0.2, 0.3, 0.1, 0], // 34 fiddle
    [7, 0, 0.2, 0.04, 3, 0.15, 0.9, 1.3, 0.05, 0.3, 0.12, 0], // 35 rough fiddle
    [1, 12, 0.32, 0.06, 4, 0.2, 0.95, 0.15, 0, 0.55, 0.2, 0], // 36 panpipe
    [5, 12, 0.2, 0.002, 0.55, 0.2, 0.4, 2, 0.18, 0.4, 0.3, 0], // 37 steel bell
    [0, 0, 0.5, 0.001, 0.05, 0.02, 0.3, 0.6, -0.1, 0.1, 0, 120], // 38 hoof
  ],
  // Index = state.eraIdx. ac: how much of the acoustic hand-drum layers of the biome stays.
  eras: [
    { n: 'Origins', drone: 1, ac: 1, parts: [
      [FL, 4, '', 0, 1],
      [DRL, 3, '9..5..7.9.5..6..', 0, 1],
      [DRS, 3, '..6...5.4.6...57', 0, 0],
    ] },
    { n: 'First farmers', drone: 0.5, ac: 1, parts: [
      [LYR, 4, '', 0, 0],
      [LYR, 1, '6.3.5.3.6.3.5.3.', -12, 0],
      [FRM, 3, '9.....5.7.......', 0, 0],
      [RIM, 3, '....7.......7.4.', 0, 0],
    ] },
    { n: 'Ancient empires', drone: 0.45, ac: 1, parts: [
      [RED, 4, '', 0, 0],
      [HRP, 1, '6.4.5.3.6.4.5.4.', -12, 0],
      [BRL, 6, '9...............', 12, 0, [0, 4]],
      [BRL, 2, '9...............', 0, 0],
      [DEEP, 3, '9.......7...5...', 0, 0],
      [RIM, 3, '..4...4...4...45', 0, 0],
    ] },
    { n: 'Connected world', drone: 0.45, ac: 0.9, parts: [
      [LUT, 4, '', 0, 0],
      [LUT, 1, '5.3.4.3.5.3.4.3.', -12, 0],
      [BWL, 6, '9...............', 0, 0, [0, 4]],
      [CHO, 6, '9.......6.......', 0, 0, [0, 2, 4]],
      [FRM, 3, '9.....5...6...5.', 0, 0, null, 1],
      [RIM, 3, '..5...5...5...55', 0, 0],
    ] },
    { n: 'Sail and science', drone: 0.2, ac: 0.75, parts: [
      [HPS, 4, '', 0, 0],
      [HPS, 1, '6.4.6.4.5.4.5.4.', 0, 0],
      [STR, 6, '9.......7.......', 0, 0, [0, 2, 4]],
      [BWL, 7, '8.......6.......', -12, 0, [0, 4]],
      [RIM, 3, '..4...4...4...45', 0, 0],
    ] },
    { n: 'Industry', drone: 0.2, ac: 0.55, parts: [
      [PNO, 4, '', 0, 0],
      [PNO, 1, '5.3.4.3.5.3.4.3.', 0, 0],
      [STR, 6, '9...............', 0, 0, [0, 2, 4]],
      [BRS, 6, '....7.......7...', 0, 0, [0, 4]],
      [STM, 3, '9.5.7.5.9.5.7.5.', 0, 0, null, 2],
      [CLK, 3, '7...7...7...7...', 0, 0, null, 2],
    ] },
    { n: 'Modern', drone: 0, ac: 0.2, parts: [
      [SYL, 4, '', 0, 0],
      [EBS, 7, '9..7..5.9..7.5.7', 0, 0, [0, 0, 4, 0, 0, 4, 3, 0]],
      [SYP, 6, '9...............', 0, 0, [0, 2, 4]],
      [SYL, 1, '6.6.6.6.6.6.6.6.', 12, 0],
      [KCK, 3, '9...9...9...9...', 0, 0, null, 2],
      [SNR, 3, '....9.......9...', 0, 0, null, 2],
      [HAT, 3, '5.7.5.7.5.7.5.7.', 0, 0, null, 2],
    ] },
  ],
  // Index = state.biomeA / biomeB. mel: 7-degree map for the theme; sc: map for
  // chords, arps and lines; roots: chord root degree per theme bar; ch: chord degrees;
  // dens: drum density; rev: reverb feedback; bl: steps per bar (12 = 6/8 lilt);
  // orn: ornament kind per theme note (0 none, 1 grace above, 2 mordent, 3 slide up
  // into the note, 4 slide down, 5 grace below), cycled over 8 notes;
  // amb: ambience [crickets, wind howl, water, birds, base wind].
  bios: [
    { n: 'Savannah', mode: 'major pentatonic, kalimba and polyrhythm', bpm: 104, sw: 0.1, dens: 1, rev: 0.74, drone: 0,
      mel: [0, 2, 4, 5, 7, 9, 11], sc: [0, 2, 4, 5, 7, 9, 11], bl: 16, orn: [0, 0, 0, 0, 0, 0, 0, 0],
      roots: [0, 0, 3, 4, 0, 3, 4, 0], ch: [0, 2, 4, 7],
      amb: [1, 0, 0, 0.7, 0.3],
      thm: theme(16, [MOT, '0:2:3 3:4:1 4:2:2 6:1:2 8:2:4 12:0:2 14:1:2', '0:0:2 2:1:2 4:2:4 8:4:3 11:2:1 12:1:2 14:0:2', '0:1:6 6:0:2 8:-3:4 12:-2:2 14:-3:2',
        MOT, '0:5:3 3:4:1 4:5:2 6:7:2 8:5:4 12:4:2 14:2:2', '0:4:2 2:2:2 4:1:2 6:2:2 8:4:4 12:5:2 14:4:2', '0:2:4 4:1:2 6:0:2 8:1:2 10:0:2 12:0:4']),
      parts: [
        [KAL, 0, '', 0, 0],
        [MAR, 1, '5.3.4.3.5.3.4.3.', 0, 0, null, 1],
        [MAR, 7, '9..6..7...5..6..', -24, 0, [0, 0, 4, 0, 4], 1],
        [SHK, 3, '5272527252725272', 0, 0, null, 1],
        [DRS, 3, '6..6..6..6..6..6', 0, 0, null, 1],
        [DRL, 3, '9.....7...5.7...', 0, 0, null, 1],
        [TLK, 3, '....5.....3...4.', 0, 0, null, 1],
      ] },
    { n: 'Ice', mode: 'lydian, glassy bells, bowed tone', bpm: 88, sw: 0, dens: 0.55, rev: 0.88, drone: 0.3,
      mel: [0, 2, 4, 6, 7, 9, 11], sc: [0, 2, 4, 6, 7, 9, 11], bl: 16, orn: [0, 0, 0, 0, 0, 0, 0, 0],
      roots: [0, 0, 4, 4, 0, 0, 5, 4], ch: [0, 4, 7, 11],
      amb: [0, 1, 0, 0, 0.8],
      thm: theme(16, [MOT, '0:5:6 8:4:4 12:2:4', '0:4:4 6:5:2 8:7:8', '0:6:4 4:5:4 8:4:2 10:2:2 12:0:4',
        MOT, '0:7:6 6:6:2 8:5:4 12:4:4', '0:3:4 4:4:4 8:5:4 12:7:4', '0:6:8 8:4:4 12:0:4']),
      parts: [
        [BEL, 0, '', 0, 0],
        [BWS, 6, '9...............', -12, 0, [0, 4, 7]],
        [BEL, 1, '4...2...3.......', 0, 0, null, 1],
        [RIM, 3, '5...5...5...5...', 0, 0, null, 3],
        [FRM, 3, '7.......5.......', 0, 0, null, 3],
      ] },
    { n: 'River desert', mode: 'Hijaz, oud, ney and maqsum', bpm: 96, sw: 0.04, dens: 0.85, rev: 0.8, drone: 0.4,
      mel: [0, 1, 4, 5, 7, 8, 10], sc: [0, 1, 4, 5, 7, 8, 10], bl: 16, orn: [3, 1, 0, 2, 4, 1, 0, 3],
      roots: [0, 0, 3, 0, 0, 3, 1, 0], ch: [0, 2, 4, 7],
      amb: [0.3, 0, 1, 0.4, 0.5],
      thm: theme(16, [MOT, '0:2:3 3:1:1 4:2:2 6:3:2 8:4:4 12:3:2 14:2:2', '0:1:2 2:0:2 4:1:2 6:2:2 8:1:4 12:0:4', '0:2:4 4:3:2 6:4:2 8:5:4 12:4:2 14:3:2',
        MOT, '0:7:3 3:6:1 4:5:2 6:4:2 8:5:4 12:4:2 14:3:2', '0:4:2 2:3:2 4:2:2 6:1:2 8:2:4 12:1:2 14:0:2', '0:1:2 2:0:2 4:-1:2 6:0:2 8:0:8']),
      parts: [
        [NEY, 0, '', 0, 0],
        [OUD, 7, '9.5.6.5.9.5.6.5.', -12, 0, [0, 1, 2, 1, 0, 1, 3, 2], 1],
        [DRL, 3, '9.......8.......', 0, 0, null, 3],
        [DRS, 3, '..7...6.....7...', 0, 0, null, 3],
        [RIM, 3, '4.2.4.2.4.2.4.2.', 0, 0, null, 3],
      ] },
    { n: 'Forest', mode: 'Dorian, folk flute and fiddle, 6/8', bpm: 120, sw: 0, dens: 0.9, rev: 0.7, drone: 0.15,
      mel: [0, 2, 3, 5, 7, 9, 10], sc: [0, 2, 3, 5, 7, 9, 10], bl: 12, orn: [1, 0, 0, 5, 0, 1, 0, 0],
      roots: [0, 0, 3, 0, 0, 6, 3, 0], ch: [0, 2, 4, 7],
      amb: [0.2, 0.2, 0.1, 1, 0.5],
      thm: theme(12, [MOT12, '0:4:2 2:2:2 4:4:2 6:5:3 9:4:1 10:2:2', '0:2:2 2:1:2 4:0:2 6:1:2 8:2:2 10:1:2', '0:2:6 6:4:2 8:2:2 10:1:2',
        MOT12, '0:7:2 2:5:2 4:4:2 6:5:3 9:4:1 10:2:2', '0:4:2 2:5:2 4:7:2 6:8:3 9:7:1 10:5:2', '0:4:2 2:2:2 4:1:2 6:0:6']),
      parts: [
        [FFL, 0, '', 0, 0],
        [FID, 6, '5...........', 0, 0, [0, 4]],
        [LUT, 7, '8.....6...5.', -12, 0, [0, 4, 0], 1],
        [FRM, 3, '9.....6...3.', 0, 0, null, 3],
        [RIM, 3, '..3...3...3.', 0, 0, null, 3],
      ] },
    { n: 'Steppe', mode: 'pentatonic, galloping, rough fiddle over a drone fifth', bpm: 112, sw: 0, dens: 1, rev: 0.6, drone: 0.7,
      mel: [0, 2, 5, 7, 9, 12, 14], sc: [0, 2, 3, 5, 7, 8, 10], bl: 16, orn: [3, 0, 4, 0, 0, 3, 0, 4],
      roots: [0, 0, 5, 6, 0, 0, 5, 6], ch: [0, 2, 4, 7],
      amb: [0, 0.4, 0, 0, 1],
      thm: theme(16, [MOT, '0:4:2 2:2:1 3:1:1 4:2:2 6:1:1 7:0:1 8:1:4 12:2:2 14:1:2', '0:0:2 2:1:1 3:2:1 4:3:2 6:2:1 7:1:1 8:2:4 12:3:2 14:2:2', '0:1:2 2:0:1 3:-3:1 4:0:4 8:-3:4 12:0:4',
        MOT, '0:4:2 2:3:1 3:4:1 4:4:2 6:3:1 7:2:1 8:3:4 12:4:2 14:3:2', '0:2:2 2:3:1 3:4:1 4:7:4 8:4:2 10:3:1 11:4:1 12:2:4', '0:1:2 2:0:1 3:1:1 4:2:2 6:1:1 7:0:1 8:0:8']),
      parts: [
        [RFD, 0, '', 0, 0],
        [RFD, 6, '9...............', -12, 0, [0, 4]],
        [HOO, 3, '8.558.558.558.55', 0, 0, null, 3],
        [DRL, 3, '9.......7.......', 0, 0, null, 3],
        [FRM, 3, '....7.......7...', 0, 0, null, 3],
      ] },
    { n: 'Mountains', mode: 'major, wide leaps, panpipe, horn call', bpm: 84, sw: 0.03, dens: 0.7, rev: 0.9, drone: 0.5,
      mel: [0, 2, 4, 5, 7, 9, 11], sc: [0, 2, 4, 5, 7, 9, 11], bl: 16, orn: [0, 0, 3, 0, 0, 0, 3, 0],
      roots: [0, 0, 3, 4, 0, 3, 4, 0], ch: [0, 4, 7, 9],
      amb: [0, 0.8, 0.3, 0.1, 0.9],
      thm: theme(16, [MOT, '0:7:6 6:4:2 8:5:8', '0:2:4 4:4:4 8:7:8', '0:5:4 4:4:2 6:2:2 8:0:8',
        MOT, '0:7:4 4:9:4 8:7:4 12:4:4', '0:4:4 4:7:4 8:4:2 10:2:2 12:4:4', '0:2:4 4:1:4 8:0:8']),
      parts: [
        [PAN, 0, '', 0, 0],
        [BRL, 2, '9...............', 0, 0],
        [HRP, 1, '6...4...5...4...', 0, 0, null, 1],
        [DEEP, 3, '9.......6...4...', 0, 0, null, 3],
        [FRM, 3, '..........5.5...', 0, 0, null, 3],
      ] },
    { n: 'Coast', mode: 'major, rolling arpeggios, steel bell', bpm: 116, sw: 0.05, dens: 0.9, rev: 0.78, drone: 0,
      mel: [0, 2, 4, 5, 7, 9, 11], sc: [0, 2, 4, 5, 7, 9, 11], bl: 16, orn: [0, 1, 0, 0, 0, 1, 0, 0],
      roots: [0, 4, -2, 3, 0, 4, 3, 0], ch: [0, 2, 4, 7],
      amb: [0, 0.2, 1, 0.1, 0.6],
      thm: theme(16, [MOT, '0:2:2 2:4:2 4:5:2 6:7:2 8:5:2 10:4:2 12:2:4', '0:4:2 2:5:2 4:7:4 8:5:2 10:4:2 12:2:2 14:1:2', '0:2:2 3:4:1 4:2:2 6:1:2 8:0:6 14:1:2',
        MOT, '0:7:2 2:8:2 4:7:2 6:5:2 8:4:4 12:5:2 14:4:2', '0:5:2 2:4:2 4:2:2 6:4:2 8:5:4 12:7:4', '0:4:2 2:2:2 4:1:2 6:2:2 8:0:8']),
      parts: [
        [STL, 0, '', 0, 0],
        [LYR, 1, '7353635373536353', 0, 0, null, 1],
        [MAR, 7, '8...6...8...6...', -12, 0, [0, 4, 0, 4], 1],
        [SHK, 3, '5.5.5.5.5.5.5.5.', 0, 0, null, 3],
        [FRM, 3, '9...5...9...5...', 0, 0, null, 3],
        [RIM, 3, '..5...5...5...55', 0, 0, null, 3],
      ] },
  ],
  // finale(): the arrangement drops away over a bar, then the motif returns alone on the
  // first era's lead instrument (i), in the first biome's scale, and ends on the tonic.
  fin: { i: FL, mel: [0, 2, 4, 5, 7, 9, 11], n: [0, -3, 2, 2, 0, 2, 4, 4, 6, 10, 5, 2, 12, 4, 4] },
  // Scale used for each flourish (biome index of its place); -1 = the biome playing now.
  stm: [-1, -1, -1, -1, 3, 5, 6, 3, 4, 2, 0, 6, 5, 2, 3, 4, 6, 3, 2, 6, 1, 0, 0],
  // Landmark flourishes, index = event id: [step, instrument, degree, length, velocity 1-9]
  sting: [
    [0, 1, 0, 1, 6, 1, 1, 0, 1, 4, 2, 1, 0, 1, 5, 3, 1, 0, 1, 7, 4, 0, -3, 2, 7, 6, 0, 0, 2, 7, 8, 0, 4, 10, 9, 8, 2, 0, 1, 8],
    [0, 10, 7, 8, 8, 0, 0, 7, 6, 8, 4, 10, 4, 8, 5, 6, 0, 5, 2, 6, 8, 0, 4, 10, 7, 8, 10, 2, 8, 5],
    [0, 4, 0, 2, 9, 3, 4, 0, 2, 6, 6, 4, 0, 2, 8, 8, 6, 4, 2, 7, 9, 6, 5, 2, 7, 10, 6, 7, 8, 8, 10, 4, 0, 1, 7, 8, 5, 0, 1, 6],
    [0, 9, 0, 4, 9, 0, 11, 0, 1, 9, 4, 9, 4, 4, 8, 8, 9, 7, 10, 9, 8, 11, 0, 1, 9,
      0, 7, 0, 1, 6, 1, 7, 1, 1, 6, 2, 7, 2, 1, 6, 3, 7, 4, 1, 6, 4, 7, 5, 1, 7, 5, 7, 7, 1, 7, 6, 7, 8, 1, 7, 7, 7, 9, 1, 8],
    // 4 Stonehenge: deep drum, bowed fifth, folk flute call
    [...S(DEEP, '0:0:4:9 8:0:4:7 16:0:4:8 24:0:4:6'), ...S(BWL, '0:0:28:6 0:4:28:5'), ...S(FFL, '6:4:4:7 10:5:2:6 12:4:2:6 16:2:12:7')],
    // 5 Great Wall: horn calls over a war drum, panpipe answer
    [...S(BRL, '0:0:8:8 8:4:8:8'), ...S(PAN, '8:4:4:7 12:7:4:7 16:9:12:8'), ...S(DEEP, '0:0:4:9 4:0:4:6 8:0:4:7 12:0:4:6 16:0:4:9 20:0:4:7 24:0:4:9')],
    // 6 Parthenon: harp run, bells, lyre
    [...S(HRP, '0:0:2:6 2:2:2:6 4:4:2:6 6:7:2:6 8:9:2:7 10:7:2:6 12:4:6:7'), ...S(BEL, '12:7:8:6 16:9:12:7'), ...S(LYR, '16:4:4:6 18:5:4:6 20:7:8:7')],
    // 7 Gothic cathedral: choir chords, tolling bell
    [...S(CHO, '0:0:14:8 0:4:14:7 0:7:14:6 14:2:16:8 14:5:16:7 14:9:16:6'), ...S(BEL, '0:-5:4:7 8:-5:4:6 16:-5:4:7 24:-5:4:6')],
    // 8 Mongol encampment: hoofbeats, rough fiddle, drum
    [...R(HOO, 0, 0, 28, 4, 8), ...R(HOO, 0, 2, 30, 4, 5), ...R(HOO, 0, 3, 31, 4, 5),
      ...S(RFD, '0:0:3:8 4:2:2:7 6:3:2:7 8:4:8:8 16:3:4:7 20:2:4:7 24:0:8:8'), ...S(DRL, '0:0:2:9 8:0:2:8 16:0:2:9 24:0:2:8')],
    // 9 Timbuktu: oud phrase and ney over a drum
    [...S(OUD, '0:0:2:8 2:2:2:6 4:3:2:6 6:4:4:7 12:3:2:6 14:2:2:6 16:1:2:7 18:0:12:8'), ...S(NEY, '8:4:6:7 16:5:4:7 20:4:12:8'),
      ...S(DRL, '0:0:2:8 8:0:2:7 16:0:2:8'), ...S(DRS, '4:0:2:6 12:0:2:6 20:0:2:6')],
    // 10 Great Zimbabwe: kalimba and marimba over djembe
    [...S(KAL, '0:0:2:7 2:2:2:6 4:4:2:7 6:5:2:6 8:7:4:8 12:5:2:6 14:4:2:6 16:2:2:7 18:4:2:6 20:7:8:8'), ...S(MAR, '0:-3:6:7 8:0:6:6 16:-2:6:7 24:0:8:7'),
      ...S(DRL, '0:0:2:8 6:0:2:6 12:0:2:7 18:0:2:6 24:0:2:8'), ...S(DRS, '3:0:1:6 9:0:1:6 15:0:1:6 21:0:1:6')],
    // 11 the 1492 fleet: brass fanfare, drum, bells
    [...S(BRS, '0:0:6:8 6:4:6:8 12:7:12:9'), ...S(DEEP, '0:0:4:9 12:0:4:8 18:0:4:9'), ...S(BEL, '12:7:8:7 16:9:8:7 20:11:12:8')],
    // 12 Machu Picchu: panpipe, choir, harp
    [...S(PAN, '0:4:6:7 6:5:2:6 8:7:12:8 20:5:4:7 24:4:8:7'), ...S(CHO, '0:0:28:7 0:4:28:6'), ...S(HRP, '8:0:2:6 10:2:2:6 12:4:2:6 14:7:2:6 16:9:2:6 18:7:2:6 20:4:2:6 22:2:2:6')],
    // 13 Taj Mahal: slow ney, oud chords, bells
    [...S(NEY, '0:4:8:7 8:5:4:7 12:4:4:7 16:2:6:7 22:1:2:6 24:0:12:8'), ...S(BEL, '0:7:8:6 8:4:8:5 16:2:8:6 24:0:8:6'),
      ...S(OUD, '0:0:6:7 0:2:6:6 0:4:6:6 16:0:6:7 16:1:6:6 16:3:6:6')],
    // 14 steam mill: chuffing, piano, clank
    [...R(STM, 0, 0, 30, 2, 5, 8), ...S(PNO, '0:0:2:7 2:2:2:6 4:4:2:7 6:5:2:6 8:4:4:8 12:2:2:6 14:0:2:6 16:4:4:8 20:5:4:7 24:7:8:8'), ...S(CLK, '0:0:1:7 8:0:1:6 16:0:1:7 24:0:1:6')],
    // 15 railroad: an accelerating locomotive and a brass call
    [...R(STM, 0, 0, 30, 2, 5, 9), ...R(CLK, 0, 0, 28, 4, 5, 8), ...S(BRS, '8:0:4:8 12:2:4:7 16:4:12:8')],
    // 16 first flight: strings lift, piano climbs, bell
    [...S(STR, '0:0:16:6 0:4:16:5 16:2:14:7 16:5:14:6'), ...S(PNO, '0:0:2:6 2:2:2:6 4:4:2:6 6:5:2:6 8:7:2:7 10:8:2:7 12:9:2:7 14:11:2:8 16:12:8:8'), ...S(BEL, '16:7:12:7')],
    // 17 trench line: muffled drum, low bowed cluster, a lone snare
    [...S(DEEP, '0:0:4:9 8:0:4:6 12:0:4:6 16:0:4:8'), ...S(BWL, '0:0:30:6 0:1:30:5'), ...S(SNR, '4:0:1:5 6:0:1:4 20:0:1:5'), ...S(BEL, '24:-1:8:5')],
    // 18 Trinity: sub thump, held cluster, a ticking clock, one bell
    [...S(DEEP, '0:0:6:9'), ...S(BWL, '0:0:30:7 0:1:30:6'), ...S(SYP, '6:0:26:6 6:4:26:5 6:7:26:5'), ...R(HAT, 0, 0, 16, 4, 4), ...S(BEL, '20:7:12:6')],
    // 19 Apollo: countdown ticks, then bass, brass and kick
    [...R(HAT, 0, 0, 15, 4, 5, 8), ...S(EBS, '16:0:4:9 20:0:4:8 24:0:4:9 28:4:4:8'), ...S(BRS, '16:0:8:8 16:4:8:8 24:4:8:9 24:7:8:8'),
      ...S(KCK, '16:0:2:9 20:0:2:8 24:0:2:9 28:0:2:8'), ...S(SNR, '18:0:1:6 26:0:1:6')],
    // 20 melting glacier: falling bell drops over a bowed tone
    [...S(BEL, '0:11:6:6 4:9:6:6 8:7:6:6 12:5:6:6 16:4:6:5 20:2:6:5 24:0:12:6'), ...S(BWS, '0:0:28:6 0:4:28:5')],
    // 21 megacity: synth arpeggio, bass, drum machine
    [...S(SYL, '0:0:2:7 2:4:2:6 4:7:2:7 6:4:2:6 8:0:2:7 10:5:2:6 12:9:2:7 14:5:2:6 16:0:2:7 18:4:2:6 20:7:2:7 22:4:2:6 24:0:4:8'),
      ...S(EBS, '0:0:4:9 8:0:4:8 16:3:4:9 24:0:4:8'), ...S(KCK, '0:0:2:9 8:0:2:9 16:0:2:9 24:0:2:9'), ...S(SNR, '8:0:1:8 24:0:1:8'), ...R(HAT, 0, 0, 30, 2, 5)],
    // 22 the home: the motif on piano, strings and a bell
    [...S(PNO, '0:-3:2:7 2:0:2:7 4:4:6:8 10:5:2:7 12:4:4:7 16:0:16:8'), ...S(STR, '0:0:30:5 0:2:30:5 0:4:30:5'), ...S(BEL, '16:7:12:6')],
  ],
};
