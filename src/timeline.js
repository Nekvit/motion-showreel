// Shot list (DIRECTION.md §4). Frames are global at 60 fps, [start, end).
// overlap: frames at the start of a shot during which the previous shot keeps
// rendering (past its own end, s.tail === true) and is exposed as s.prevTex.
import point from './shots/point.js';
import line from './shots/line.js';
import plane from './shots/plane.js';
import lens from './shots/lens.js';
import volume from './shots/volume.js';
import flow from './shots/flow.js';
import field from './shots/field.js';
import fullStop from './shots/full-stop.js';

export const TIMELINE = [
  { id: 'point', start: 0, end: 96, overlap: 0, module: point },
  { id: 'line', start: 96, end: 168, overlap: 0, module: line },
  { id: 'plane', start: 168, end: 264, overlap: 0, module: plane },
  { id: 'lens', start: 264, end: 384, overlap: 0, module: lens },
  { id: 'volume', start: 384, end: 480, overlap: 12, module: volume },
  { id: 'flow', start: 480, end: 576, overlap: 0, module: flow },
  { id: 'field', start: 576, end: 672, overlap: 12, module: field },
  { id: 'full-stop', start: 672, end: 900, overlap: 12, module: fullStop },
];
