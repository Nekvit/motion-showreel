// TEST ONLY: isolated timeline for developing `volume` while other shots are in flux.
//   node tools/render.mjs --test "/../volume/testcut" --frames 383,384 ...
// (index.html imports ./src/shots/_test<Name>.js; the path resolves to this file.)
// ?reallens=1 uses src/shots/lens.js instead of the stand-in.
import volume from '../volume.js';
import standIn from './lensStandIn.js';

let lens = standIn;
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('reallens') === '1') {
  lens = (await import('../lens.js')).default;
}
export const timeline = [
  { id: 'lens', start: 264, end: 384, overlap: 0, module: lens },
  { id: 'volume', start: 384, end: 480, overlap: 12, module: volume },
];
