// Example landmark: a ring of standing stones around a campfire. It exists to show the
// contract (internal_docs/LANDMARKS.md) end to end; it is not one of the slice's events.
//
// built: stones still lying on rollers waiting to be raised appear as built < 1; people
// haul one in. decay: stones lean, sink and fall, lichen darkens them, the fire dies out
// (lights off past decay 0.45) and the people leave.
//
// Motion demos (internal_docs/LANDMARKS.md "Motion"), each a rigid part on its own rig that
// animate() places every frame: (a) a hand-cart circling the ring on a real-time loop,
// (b) a sky lantern whose height, size and glow follow decay as a timeline, (c) a beacon on a
// rock 450 m out to sea (or inland, +x, where there is no sea) with a smoke column, and
// (d) a brief white flash at the beacon every 8 s.

import { SURF, POSE, FLICKER, loop, seg, ease, pathAt } from './kit.js';

const CART_PATH = [12, 0, 0, 0, 0, 12, -12, 0, 0, 0, 0, -12]; // closed loop round the ring (m)
const P = new Float64Array(5); // pathAt output (module scratch: animate allocates nothing)

const N_STONES = 11;
const RING_R = 9;

export default {
  id: 'example-stones',
  name: 'Standing stones',
  caption: 'Stones raised around a fire',
  year: -3000,
  radius: 14, // everything stays within 14 m of the origin
  pad: 15, // flatten 15 m around the origin (road edge 18.1 m away at its widest, the highway)
  straddlesRoad: false, // road centre line at x = -(14 + 8) = -22, travel toward -z
  lights: [
    { pos: [0, 0.6, 0], color: [1.0, 0.52, 0.2], intensity: 45, range: 22, flicker: 0.7 },
  ],
  detail: { at: [0, 0.5, 0], from: [-3.2, 2.0, 2.6] }, // viewer close-up: the hearth
  reach: 480, // rigs travel up to 480 m from the origin (the beacon): keeps them drawn

  build(b, built, decay, seed) {
    // Trampled earth floor, darker toward the hearth; the fire lights it because it is
    // landmark geometry (terrain does not receive landmark lights).
    b.surface(SURF.EARTH).ao(1);
    b.disc(12.5, 40, 8, (x, z) => {
      const r = Math.hypot(x, z);
      const t = Math.min(1, r / 12.5);
      const k = 0.85 + 0.15 * t;
      b.color(0.2 * k, 0.15 * k, 0.1 * k);
      // 2 cm above the pad, feathered down to 1 cm at the rim
      return 0.02 - 0.01 * t * t;
    });

    // Stones
    const fallen = decay;
    for (let i = 0; i < N_STONES; i++) {
      const a = (i / N_STONES) * Math.PI * 2 + 0.2;
      const jitter = b.rand();
      const h = 2.4 + 1.3 * b.rand(), w = 0.55 + 0.25 * b.rand(), d = 0.35 + 0.15 * b.rand();
      const raised = i / N_STONES < built;
      const lean = (b.rand() - 0.5) * 0.08 + (b.rand() - 0.5) * 0.7 * decay;
      const falls = b.rand() < fallen * 0.6;
      const sink = 0.25 + 0.6 * decay * b.rand();
      const g = 0.32 + 0.08 * jitter;
      // lichen / weathering darkens and greens with decay
      b.color(g * (1 - 0.35 * decay), g * (0.97 - 0.2 * decay), g * (0.9 - 0.3 * decay)).surface(SURF.STONE).ao(0.95);
      b.push();
      b.at(Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R, -a + Math.PI / 2);
      if (raised && !falls) {
        b.rotateZ(lean);
        b.translate(0, h * 0.5 - sink, 0);
        b.rock(w, h * 0.5, d, 6, 0.16, seed * 31 + i, 6, 0.1);
      } else {
        // lying on the ground (unraised: on two log rollers; fallen: half sunk)
        // after rotateZ(pi/2) local +x points up: lift by the stone's thickness
        b.rotateZ(Math.PI / 2 + (b.rand() - 0.5) * 0.1);
        b.translate(raised ? w * 0.45 : w + 0.18, 0, 0);
        b.rock(w, h * 0.5, d, 6, 0.16, seed * 31 + i, 6, 0.1);
        b.pop(); b.push();
        if (!raised) {
          b.at(Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R, -a + Math.PI / 2);
          b.color(0.2, 0.14, 0.09).surface(SURF.WOOD);
          b.beam(-0.9, 0.09, -0.7, -0.9, 0.09, 0.7, 0.09);
          b.beam(0.9, 0.09, -0.7, 0.9, 0.09, 0.7, 0.09);
        }
      }
      b.pop();
    }

    // Hearth: lit while the place is in use.
    const lit = Math.max(0, Math.min(1, 1 - decay * 2.2));
    b.fire(0, 0.02, 0, 1.0, 1, lit);

    // Seats: two logs by the fire
    b.color(0.16, 0.11, 0.07).surface(SURF.WOOD).ao(0.9);
    b.beam(-3.0, 0.18, -1.0, -2.9, 0.18, 1.1, 0.18, 0.16, 8);
    b.beam(1.2, 0.18, 2.5, 2.6, 0.18, 1.3, 0.17, 0.15, 8);

    // People: silhouettes in hide colours. Fewer as the place decays.
    if (decay < 0.35) {
      b.color(0.11, 0.075, 0.05).surface(SURF.HIDE).ao(1);
      b.push(); b.at(-2.1, 0, 0.1, -Math.PI / 2); b.human(POSE.SIT, 1.65, seed + 1); b.pop();
      b.push(); b.at(1.7, 0, 1.75, Math.PI * 0.75); b.human(POSE.SIT, 1.6, seed + 2); b.pop();
      b.push(); b.at(0.5, 0, -2.4, 0); b.human(POSE.KNEEL, 1.7, seed + 3); b.pop();
      b.push(); b.at(-4.5, 0, -3.5, 0.6); b.human(POSE.STAND, 1.75, seed + 4); b.pop();
      if (built < 1) { // a crew hauling the next stone in on a rope
        b.push(); b.at(-6, 0, 6.5, -2.2);
        for (let k = 0; k < 3; k++) { b.push(); b.translate((k - 1) * 0.6, 0, k * 1.1); b.human(POSE.HAUL, 1.7, seed + 10 + k); b.pop(); }
        b.color(0.3, 0.24, 0.15).surface(SURF.PLAIN);
        b.beam(0, 1.25, 3.0, 0.2, 1.2, -0.6, 0.02, 0.02, 4, false);
        b.pop();
      }
    }

    // A torch on a post by the entrance (independent flicker, no light slot of its own).
    if (decay < 0.5) {
      b.color(0.14, 0.1, 0.07).surface(SURF.WOOD).ao(1);
      b.beam(-11, 0, 3.5, -11, 2.0, 3.5, 0.06, 0.05, 6);
      b.color(1.0, 0.5, 0.15).emissive(0.9 * lit, FLICKER.OWN).surface(SURF.PLAIN);
      b.push(); b.translate(-11, 2.0, 3.5); b.ellipsoid(0.1, 0.22 * (0.3 + 0.7 * lit), 0.1, 2); b.pop();
      b.emissive(0, 0);
    }

    // (a) rig 1: a hand-cart, built facing +z around its own origin
    b.timeless().rig(1);
    b.color(0.22, 0.15, 0.09).surface(SURF.WOOD).ao(1);
    b.box(0, 0.6, 0, 0.42, 0.1, 0.7);
    b.beam(0, 0.6, 0.7, 0, 0.75, 1.6, 0.04, 0.04, 5); // shaft
    b.color(0.12, 0.09, 0.06);
    for (const sx of [-0.5, 0.5]) { b.push(); b.translate(sx, 0.38, 0); b.rotateZ(Math.PI / 2); b.translate(0, -0.05, 0); b.cylinder(0.38, 0.1, 10); b.pop(); }
    // (b) rig 2: a sky lantern (no shadow); its glow is scaled by a.gain
    b.rig(2, false);
    b.color(1.0, 0.62, 0.3).emissive(0.6, FLICKER.OWN).surface(SURF.PLAIN);
    b.push(); b.translate(0, 0.5, 0); b.ellipsoid(0.35, 0.5, 0.35, 2); b.pop();
    b.emissive(0, 0);
    // (c) rig 3: a beacon on a rock (far: no shadow), fire and a tall smoke column
    b.rig(3, false);
    b.color(0.3, 0.29, 0.27).surface(SURF.STONE).ao(1);
    b.push(); b.translate(0, -1, 0); b.rock(9, 4, 7, 3, 0.25, seed + 5, 3, 0.3); b.pop();
    b.color(0.16, 0.12, 0.08).surface(SURF.WOOD);
    b.beam(0, 2, 0, 0, 14, 0, 0.5, 0.35, 6);
    b.flames(0, 14, 0, 3.5, FLICKER.OWN, seed);
    b.smoke(0, 16, 0, { count: 30, size: 3, rise: 60, density: 0.35, color: [0.3, 0.31, 0.36], src: FLICKER.OWN });
    // (d) rig 4: the flash (FX layer; brightness = a.gain(4, ...), 0 most of the time)
    b.rig(4, false);
    b.flash(0, 16, 0, 25, 80);
    b.rig(0);
    return b.counts();
  },

  // Every drawn frame (allocation-free): a.t real seconds, a.built / a.decay the live state,
  // a.seaX / a.seaZ the local direction to the sea and a.seaY its level (-1e4: no sea).
  animate(a) {
    pathAt(CART_PATH, loop(a.t, 24), P, true);
    a.set(1, P[0], 0.02, P[2], P[3]);
    const k = seg(a.decay, 0.05, 0.55); // the lantern's timeline: rises and fades as the place empties
    a.set(2, 0, 1.2 + 60 * ease(k), 0, 0, 0, 0, 1 + 2 * k).gain(2, 1 - k).show(2, k < 1);
    const sea = a.seaY > -1000, dx = sea ? a.seaX : 1, dz = sea ? a.seaZ : 0;
    const y = sea ? a.seaY : 0;
    a.set(3, dx * 450, y, dz * 450, 0);
    const f = loop(a.t, 8);
    a.set(4, dx * 450, y, dz * 450).gain(4, f < 0.06 ? 1 - f / 0.06 : 0);
  },
};
