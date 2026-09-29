// Dev harness for `plane` (not part of the reel): `node tools/render.mjs --test "X/../plane/harness" --query hud=1 ...`
// loads only the neighbours, so plane can be rendered and timed while other shots are mid-edit.
// Frames are the reel's global frames.
import line from '../line.js';
import plane from '../plane.js';
import lens from '../lens.js';

const idle = { id: 'idle', init() {}, render(ctx, s) { ctx.setPost(s, {}); }, postOut: {} };
export const timeline = [
  { id: 'pre', start: 0, end: 96, overlap: 0, module: idle },
  { id: 'line', start: 96, end: 168, overlap: 0, module: line },
  { id: 'plane', start: 168, end: 264, overlap: 0, module: plane },
  { id: 'lens', start: 264, end: 384, overlap: 0, module: lens },
  { id: 'post', start: 384, end: 900, overlap: 0, module: idle },
];
export default plane;
