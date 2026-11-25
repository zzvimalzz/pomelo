// SPDX-License-Identifier: AGPL-3.0-or-later
// Turning and flipping: the size of the result, the matrix the shader uses and the quarter turns.   node test/unit/image-editor/geometry.test.js
const { loadPageScripts } = require('../../support/page-script');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const { editorGeometry: g } = loadPageScripts('src/features/image-editor/ui/geometry.js');

// Which source point (u, v from 0 to 1) a point of the shown picture comes from.
const source = (geometry, u, v) => { const m = g.matrix(geometry); return [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]].map((n) => Math.round(n * 1e6) / 1e6); };
const is = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const at = (rotate, flipH = false, flipV = false) => ({ rotate, flipH, flipV });

console.log('size');
expect('a picture left alone keeps its size, a quarter turn swaps it', is(g.outputSize(g.neutral(), 4000, 3000), [4000, 3000]) && is(g.outputSize(at(90), 4000, 3000), [3000, 4000]) && is(g.outputSize(at(180), 4000, 3000), [4000, 3000]) && is(g.outputSize(at(270, true), 4000, 3000), [3000, 4000]));
expect('only the neutral geometry is neutral', g.isNeutral(g.neutral()) && !g.isNeutral(at(90)) && !g.isNeutral(at(0, true)) && !g.isNeutral(at(0, false, true)));

console.log('where each corner of the result comes from');
expect('unchanged: the shown top-left is the source top-left', is(source(g.neutral(), 0, 0), [0, 0]) && is(source(g.neutral(), 1, 0), [1, 0]));
expect('turned right: the shown top-right is the source top-left, and the shown top-left is the source bottom-left', is(source(at(90), 1, 0), [0, 0]) && is(source(at(90), 0, 0), [0, 1]));
expect('turned 180: corners swap', is(source(at(180), 0, 0), [1, 1]) && is(source(at(180), 1, 1), [0, 0]));
expect('turned left (270): the source top-left is shown bottom-left', is(source(at(270), 0, 1), [0, 0]) && is(source(at(270), 0, 0), [1, 0]));
expect('flipped across: left and right swap', is(source(at(0, true), 0.25, 0.5), [0.75, 0.5]));
expect('flipped down: top and bottom swap', is(source(at(0, false, true), 0.25, 0.25), [0.25, 0.75]));
expect('turned and then flipped across: the shown left edge is the source bottom edge reversed', is(source(at(90, true), 0, 0), [0, 0]) && is(source(at(90, true), 1, 0), [0, 1]));

console.log('turning');
expect('four quarter turns to the right are no turn', is([1, 2, 3, 4].reduce((x) => g.rotate(x, 1), g.neutral()), g.neutral()));
expect('a turn to the left undoes one to the right', is(g.rotate(g.rotate(g.neutral(), 1), -1), g.neutral()));
expect('with one flip on, a turn to the right is stored as the other way, so it still looks like a turn to the right', is(g.rotate(at(0, true), 1), at(270, true)) && is(g.rotate(at(0, false, true), -1), at(90, false, true)));
expect('with both flips on, a turn to the right is stored as it is', is(g.rotate(at(0, true, true), 1), at(90, true, true)));
expect('a flip twice is no flip', is(g.flip(g.flip(g.neutral(), 'h'), 'h'), g.neutral()) && is(g.flip(g.neutral(), 'v'), at(0, false, true)));
finish();
