// SPDX-License-Identifier: AGPL-3.0-or-later
// The curve maths: a line that never dips between points that rise, and the table of the four curves of an edit.
//   node test/unit/image-editor/curves.test.js
const { loadPageScripts } = require('../../support/page-script');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const { editorCurves: curves } = loadPageScripts('src/features/image-editor/ui/curves.js');
const identity = [[0, 0], [1, 1]];
const lutOf = (patch) => curves.lut({ rgb: identity, r: identity, g: identity, b: identity, ...patch });

console.log('the line through points');
const f = curves.through([[0, 0], [0.5, 0.75], [1, 1]]);
expect('it passes through every point', f(0) === 0 && Math.abs(f(0.5) - 0.75) < 1e-9 && Math.abs(f(1) - 1) < 1e-9);
expect('two points make a straight line', Math.abs(curves.through(identity)(0.3) - 0.3) < 1e-9);

console.log('the table');
const rising = [[0, 0], [0.1, 0.05], [0.2, 0.5], [0.3, 0.52], [0.7, 0.55], [0.8, 0.95], [1, 1]];
const table = curves.table(rising);
let dips = 0;
for (let i = 1; i < 256; i++) if (table[i] < table[i - 1]) dips++;
expect('no entry is lower than the one before it for points that only rise, even with sudden steps', dips === 0, `${dips} dips`);
expect('every entry stays between 0 and 1 even when the points sit on the edges', Array.from(curves.table([[0, 1], [0.5, 0], [1, 1]])).every((v) => v >= 0 && v <= 1));
const lifted = lutOf({ rgb: [[0, 0], [0.5, 0.75], [1, 1]] });
expect('a curve through (0.5, 0.75) maps 128 to 191 within 1', Math.abs(lifted[128 * 4] - 191) <= 1, String(lifted[128 * 4]));
expect('and does the same to each of red, green and blue', lifted[128 * 4 + 1] === lifted[128 * 4] && lifted[128 * 4 + 2] === lifted[128 * 4]);
expect('and leaves black and white where they were', lifted[0] === 0 && lifted[255 * 4] === 255);
const plain = lutOf({});
expect('no curve is the identity, with every alpha opaque', Array.from({ length: 256 }, (_, v) => [0, 1, 2].every((c) => plain[v * 4 + c] === v) && plain[v * 4 + 3] === 255).every(Boolean));
const red = lutOf({ r: [[0, 0], [0.5, 0.75], [1, 1]] });
expect('the red curve moves red and leaves green and blue', red[128 * 4] > 128 && red[128 * 4 + 1] === 128 && red[128 * 4 + 2] === 128);
const both = lutOf({ rgb: [[0, 0], [0.5, 0.75], [1, 1]], r: [[0, 0], [0.5, 0.25], [1, 1]] });
expect('the red curve works on what the RGB curve made of the value', Math.abs(both[128 * 4] - Math.round(curves.table([[0, 0], [0.5, 0.25], [1, 1]])[lifted[128 * 4]] * 255)) <= 1 && both[128 * 4 + 1] === lifted[128 * 4]);
finish();
