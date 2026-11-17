// Scripted full 300 s journey (plus the finale and the loop back to the dawn) for
// audio-test.html and tools/audio-check.mjs. Not imported by the game.
// Every era and every biome is visited, with 6 s biome blends and 4 s era blends.
export const LEN = 316;
const ERA_END = [40, 80, 120, 165, 210, 255, 300];
// [clock where a 6 s blend into this biome starts, biome]
const BIO = [[0, 0], [20, 1], [46, 2], [70, 0], [80, 2], [105, 3], [125, 4], [150, 5], [170, 6], [195, 3], [215, 4], [235, 5], [258, 6], [280, 0]];
// [time, stinger id] (-1 = loopRestart, -2 = finale)
export const EVENTS = [[1, 0], [30, 1], [55, 2], [101, 3], [112, 4], [132, 5], [142, 6], [158, 7], [176, 8], [186, 9], [196, 10], [205, 11], [222, 12],
  [231, 13], [242, 14], [248, 15], [263, 16], [270, 17], [276, 18], [284, 19], [289, 20], [293, -2], [300, -1], [308, 21]];
// Windows (start, end) that contain a transition, for the click detector: era blends,
// biome blends, stingers, the finale, the loop restart; each runs ~2 bars past the change.
export const WINDOWS = [];
ERA_END.slice(0, 6).forEach((e) => WINDOWS.push([e - 4, e + 9]));
BIO.slice(1).forEach(([t]) => WINDOWS.push([t, t + 14]));
EVENTS.forEach(([t]) => WINDOWS.push([t, t + 8]));

// Fills o = {era, eb, ba, bb, bbl, spd, surf} for journey time t (seconds).
export function journey(t, o) {
  const c = t >= 300 ? t - 300 : t;
  let e = 0;
  while (e < 6 && c >= ERA_END[e]) e++;
  o.era = e;
  o.eb = e < 6 ? Math.max(0, Math.min(1, (c - (ERA_END[e] - 4)) / 4)) : 0;
  // era boundaries: the era index flips at the end of the blend, as in the game
  if (e < 6 && o.eb >= 1) { o.era = e + 1; o.eb = 0; }
  let i = 0;
  while (i + 1 < BIO.length && BIO[i + 1][0] <= t) i++;
  const k = (t - BIO[i][0]) / 6;
  o.bb = BIO[i][1];
  o.ba = i && k < 1 ? BIO[i - 1][1] : o.bb;
  o.bbl = o.ba == o.bb ? 0 : k;
  const dip = Math.max(0, 1 - Math.abs(((c + 15) % 30) - 15) / 4);
  o.spd = (t >= 300 ? 34 : 40 * Math.min(1, c / 6)) * (1 - 0.3 * dip);
  o.surf = Math.min(3, o.era);
  return o;
}
