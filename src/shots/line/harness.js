// Dev harness for `line` (not part of the reel): `node tools/render.mjs --test "x/../line/harness" ...`
// loads this module as the timeline, so `line` can be rendered and timed while neighbouring shots are
// mid-edit. [0,96) is a stand-in for point's OUT spec (§5.1: uniform VERM, postOut {}).
import line from '../line.js';
import * as sys from '../_sys.js';

const pointOut = {
  id: 'point-standin',
  init(ctx) { this.prog = ctx.program(`${sys.SYS_GLSL} out vec4 o; void main(){ o = vec4(VERM, 1.0); }`, 'point-standin'); },
  render(ctx, s) { ctx.draw(this.prog, {}, s.target); ctx.setPost(s, {}); },
  postOut: {},
};

export const timeline = [
  { id: 'point', start: 0, end: 96, overlap: 0, module: pointOut },
  { id: 'line', start: 96, end: 168, overlap: 0, module: line },
];
export default line;
