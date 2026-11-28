// SPDX-License-Identifier: AGPL-3.0-or-later
// The history of one picture's edits: the five rules that decide what Undo steps through, and when a picture has changes.
//   node test/unit/image-editor/model.test.js
const { loadPageScripts } = require('../../support/page-script');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const { editorGeometry: g, editorModel: model } = loadPageScripts('src/features/image-editor/ui/geometry.js', 'src/features/image-editor/ui/model.js');
const pushed = (edit) => { const h2 = model.createHistory(); h2.commit(edit, 'x'); return h2; };

const turned = (history, dir) => history.commit({ ...history.current(), geometry: g.rotate(history.current().geometry, dir) }, 'rotate');
const flipped = (history, axis) => history.commit({ ...history.current(), geometry: g.flip(history.current().geometry, axis) }, `flip-${axis}`);
const withGeometry = (rotate) => ({ geometry: { ...g.neutral(), rotate } });

console.log('a new history');
let h = model.createHistory();
expect('nothing to undo or redo, nothing changed, and the picture is neutral', !h.canUndo() && !h.canRedo() && !h.dirty() && h.isNeutral());

console.log('rule 1: a change that equals what is shown does nothing, and keeps redo');
turned(h, 1);
h.undo();
h.commit(model.neutral(), 'rotate');
expect('committing the shown state leaves redo available', h.canRedo() && !h.canUndo());

console.log('rule 2: a change drops what could be redone');
h = model.createHistory();
turned(h, 1);
h.undo();
flipped(h, 'h');
expect('undo then a new change: redo is gone', !h.canRedo() && h.canUndo());

console.log('rule 3: arriving at an earlier state drops the steps in between');
h = model.createHistory();
for (let n = 0; n < 4; n++) turned(h, 1);
expect('rotate right four times: nothing to undo, and the picture is not changed', !h.canUndo() && h.isNeutral() && !h.dirty());
h = model.createHistory();
flipped(h, 'h');
flipped(h, 'h');
expect('flip across twice: nothing to undo', !h.canUndo());
h = model.createHistory();
turned(h, 1);
flipped(h, 'v');
turned(h, -1);
h.commit(model.neutral(), 'reset');
expect('turning, flipping, turning back and then flipping back leaves nothing to undo', !h.canUndo() && h.isNeutral());

console.log('rule 4: the same control again folds into its step');
h = model.createHistory();
h.commit(withGeometry(90), 'rotate');
h.commit(withGeometry(180), 'rotate');
h.undo();
expect('two turns with the same control are one step', h.isNeutral() && !h.canUndo());
h = model.createHistory();
for (const exposure of [0.5, 0.8, 0.9]) h.commit({ ...model.neutral(), exposure }, 'Exposure');
expect('Exposure 0.5, 0.8 and 0.9 in a row are one entry, holding the last', h.current().exposure === 0.9 && (h.undo(), h.isNeutral() && !h.canUndo()));
h = model.createHistory();
h.commit({ ...model.neutral(), exposure: 0.5 }, 'Exposure');
h.commit({ ...model.neutral(), exposure: 0.5, contrast: 3 }, 'Contrast');
h.commit({ ...model.neutral(), exposure: 0.8, contrast: 3 }, 'Exposure');
h.undo();
expect('a different control in between makes a new step', h.current().exposure === 0.5 && h.current().contrast === 3);
h = model.createHistory();
h.commit({ ...model.neutral(), contrast: 20 }, 'Contrast');
h.commit(model.neutral(), 'Contrast');
expect('Contrast 20 and then back to 0: its entry is gone', !h.canUndo() && h.isNeutral());

console.log('rule 5: otherwise a new step, and at most 100');
h = model.createHistory();
for (let n = 1; n <= 150; n++) h.commit({ ...model.neutral(), exposure: n }, `k${n}`);
let steps = 0;
while (h.canUndo()) { h.undo(); steps++; }
expect('a hundred entries are kept', steps === 99, String(steps));

console.log('the adjustments');
const flat = model.neutral();
expect('every adjustment starts at 0, inside a range that holds 0', Object.entries(model.RANGES).every(([key, [low, high]]) => flat[key] === 0 && low < 0 && high > 0));
expect('Exposure runs from -4 to 4 by hundredths, the rest from -100 to 100 by ones', JSON.stringify(model.RANGES.exposure) === '[-4,4,0.01]' && Object.entries(model.RANGES).every(([key, range]) => key === 'exposure' || JSON.stringify(range) === '[-100,100,1]'));
expect('a picture with an adjustment is not neutral, and putting it back is', (() => { const edited = model.createHistory(); edited.commit({ ...model.neutral(), saturation: -100 }, 'Saturation'); const was = edited.isNeutral(); edited.commit(model.neutral(), 'Saturation'); return !was && edited.isNeutral(); })());

console.log('curves, colour mixer and colour grading');
const base = model.neutral();
expect('a picture starts with straight curves, no colour moved and no grading', JSON.stringify(base.curve) === JSON.stringify({ rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] }) && model.BANDS.length === 8 && model.BANDS.every((band) => JSON.stringify(base.mixer[band]) === '{"hue":0,"sat":0,"lum":0}') && model.REGIONS.every((region) => base.grading[region].amount === 0) && base.grading.balance === 0);
expect('the parts of one neutral edit are not shared with another', model.neutral().curve.rgb !== base.curve.rgb && model.neutral().mixer.red !== base.mixer.red);
expect('only the geometry is left out when asking whether an edit is adjusted', !model.adjusted(base) && !model.adjusted({ ...base, geometry: { ...base.geometry, rotate: 90 } }));
expect('a curve point, a mixer move, a grading amount and a balance each make it adjusted', [
  { ...base, curve: { ...base.curve, g: [[0, 0], [0.5, 0.6], [1, 1]] } },
  { ...base, mixer: { ...base.mixer, aqua: { hue: 0, sat: 5, lum: 0 } } },
  { ...base, grading: { ...base.grading, shadows: { hue: 200, amount: 30 } } },
  { ...base, grading: { ...base.grading, balance: -20 } },
].every(model.adjusted));
expect('a curve point makes the picture changed, and taking it out makes it neutral again', (() => { const edited = pushed({ ...base, curve: { ...base.curve, rgb: [[0, 0], [0.5, 0.6], [1, 1]] } }); const was = !edited.isNeutral() && edited.dirty(); edited.commit(base, 'x'); return was && edited.isNeutral(); })());
h = model.createHistory();
for (const hue of [10, 20, 30]) h.commit({ ...base, grading: { ...base.grading, highlights: { hue, amount: 40 } } }, 'grading-highlights');
h.undo();
expect('three drags of one wheel in a row are one step', !h.canUndo() && h.isNeutral());

console.log('changes');
h = model.createHistory();
turned(h, 1);
expect('a change makes the picture changed', h.dirty() && !h.isNeutral());
h.markSaved();
expect('saving makes it unchanged again', !h.dirty());
h.undo();
expect('undoing after a save makes it changed: the file has the edit', h.dirty() && h.isNeutral());
h.redo();
expect('redo to the saved state makes it unchanged', !h.dirty());
finish();
