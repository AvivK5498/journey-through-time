// Landmark registry: one line per landmark module. The export name is the event's `key` in
// src/world/time.js EVENTS with '-' written as '_' (key 'great-wall' -> export great_wall).
// sites.js places an event only when its module is registered here (?placeholders=1 stands
// example.js in for the missing ones). See internal_docs/LANDMARKS.md "Registering".
export { default as camp } from './camp.js';
export { default as cave } from './cave.js';
export { default as gobekli } from './gobekli.js';
export { default as giza } from './giza.js';
export { default as home } from './home.js'; // the ending (never planned: sites.js placeHome)
export { default as mongol_camp } from './mongol-camp.js';
export { default as timbuktu } from './timbuktu.js';
export { default as great_wall } from './great-wall.js';
export { default as stonehenge } from './stonehenge.js';
export { default as parthenon } from './parthenon.js';
export { default as cathedral } from './cathedral.js';
export { default as fleet_1492 } from './fleet-1492.js';
export { default as great_zimbabwe } from './great-zimbabwe.js';
export { default as machu_picchu } from './machu-picchu.js';
export { default as mill_town } from './mill-town.js';
export { default as railroad } from './railroad.js';
export { default as taj_mahal } from './taj-mahal.js';
export { default as first_flight } from './first-flight.js';
export { default as trenches } from './trenches.js';
export { default as megacity } from './megacity.js';
export { default as glacier } from './glacier.js';
export { default as trinity } from './trinity.js';
export { default as apollo } from './apollo.js';
