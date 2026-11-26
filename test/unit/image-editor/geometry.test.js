// SPDX-License-Identifier: AGPL-3.0-or-later
// Turning, flipping, levelling and cropping: the size of the result, the matrix the shader uses, the quarter turns and the crop frame.
//   node test/unit/image-editor/geometry.test.js
const { loadPageScripts } = require('../../support/page-script');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const { editorGeometry: g } = loadPageScripts('src/features/image-editor/ui/geometry.js');

// Which source point (u, v from 0 to 1) a point of the shown picture comes from.
const source = (geometry, u, v, width = 4000, height = 3000) => { const m = g.matrix(geometry, width, height); return [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]].map((n) => Math.round(n * 1e6) / 1e6); };
const is = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const at = (rotate, flipH = false, flipV = false) => ({ ...g.neutral(), rotate, flipH, flipV });
const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
const frame = (x, y, w, h) => ({ x, y, w, h });
const close = (a, b) => ['x', 'y', 'w', 'h'].every((k) => near(a[k], b[k]));

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

console.log('crop');
const cropped = { ...g.neutral(), crop: frame(0.25, 0.5, 0.5, 0.5) };
expect('a crop sets the size of the result', is(g.outputSize(cropped, 4000, 3000), [2000, 1500]) && is(g.outputSize({ ...cropped, rotate: 90 }, 4000, 3000), [1500, 2000]));
expect('a crop of a sliver is never zero pixels', is(g.outputSize({ ...g.neutral(), crop: frame(0, 0, 0.00001, 0.00001) }, 4000, 3000), [1, 1]));
expect('a cropped picture is not neutral, and the whole picture is', !g.isNeutral(cropped) && g.isNeutral(g.neutral()) && g.isWhole(g.neutral().crop));
expect('the shown corners come from the corners of the crop', is(source(cropped, 0, 0), [0.25, 0.5]) && is(source(cropped, 1, 1), [0.75, 1]));
expect('a crop is cut from the turned picture: turned right, the crop frame is read after the turn', is(source({ ...cropped, rotate: 90 }, 0, 0), [0.5, 0.75]) && is(source({ ...cropped, rotate: 90 }, 1, 0), [0.5, 0.25]));

console.log('straighten');
expect('the middle of a levelled picture stays the middle', is(source({ ...g.neutral(), angle: 10 }, 0.5, 0.5, 100, 100), [0.5, 0.5]));
expect('a positive angle turns the picture clockwise: the shown right edge comes from a point above the middle', is(source({ ...g.neutral(), angle: 10 }, 1, 0.5, 100, 100), [0.992404, 0.413176]));
expect('the angle is applied after the turn, about the middle of the turned picture', is(source({ ...at(90), angle: 10 }, 1, 0.5, 100, 100), is(source(at(90), 0.992404, 0.413176, 100, 100), [0, 0]) ? [0, 0] : source(at(90), 0.992404, 0.413176, 100, 100)));

console.log('turning and flipping carry the frame and the level');
const framed = { ...g.neutral(), angle: 6, crop: frame(0.1, 0.2, 0.5, 0.4) };
expect('the frame turns with the picture: a quarter turn right moves it, four bring it back', is(g.rotate(framed, 1).crop, frame(0.4, 0.1, 0.4, 0.5)) && close([1, 2, 3, 4].reduce((x) => g.rotate(x, 1), framed).crop, framed.crop));
expect('a turn to the left undoes one to the right', close(g.rotate(g.rotate(framed, 1), -1).crop, framed.crop));
expect('a turn keeps the level, a flip mirrors it', g.rotate(framed, 1).angle === 6 && g.flip(framed, 'h').angle === -6 && g.flip(framed, 'v').angle === -6);
expect('a flip across mirrors the frame, a flip down mirrors it the other way', close(g.flip(framed, 'h').crop, frame(0.4, 0.2, 0.5, 0.4)) && close(g.flip(framed, 'v').crop, frame(0.1, 0.4, 0.5, 0.4)));
expect('two flips of one axis give back the frame and the level', is(g.flip(g.flip(framed, 'h'), 'h'), framed));
expect('a frame is tidied to a millionth', g.tidy(frame(0.12345678, 0.2, 0.3, 0.4)).x === 0.123457);
expect('no level stays 0 and not -0 after a flip', Object.is(g.flip(g.neutral(), 'h').angle, 0));
expect('a frame of a set shape swaps between portrait and landscape when turned, a free or square one does not', g.rotate({ ...g.neutral(), aspect: '3:2' }, 1).portrait === true && g.rotate({ ...g.neutral(), aspect: 'free' }, 1).portrait === false && g.rotate({ ...g.neutral(), aspect: '1:1', portrait: true }, 1).portrait === true);

console.log('the frame stays inside the levelled picture');
const whole = frame(0, 0, 1, 1);
expect('the whole picture fits at no angle and not at 10 degrees', g.inside(whole, 0, 4000, 3000) && !g.inside(whole, 10, 4000, 3000));
const shrunk = g.shrinkInside(whole, 10, 4000, 3000);
const a10 = 10 * Math.PI / 180, scale = Math.min(1, 4000 / (4000 * Math.cos(a10) + 3000 * Math.sin(a10)), 3000 / (4000 * Math.sin(a10) + 3000 * Math.cos(a10)));
expect('a frame is shrunk about its centre by the largest amount that fits', g.inside(shrunk, 10, 4000, 3000) && near(shrunk.w, scale, 1e-3) && near(shrunk.h, scale, 1e-3) && near(shrunk.x + shrunk.w / 2, 0.5) && near(shrunk.y + shrunk.h / 2, 0.5), JSON.stringify(shrunk));
expect('every angle up to 45 degrees leaves a frame that fits, in both directions', [-45, -30, -7.5, 7.5, 30, 45].every((angle) => g.inside(g.shrinkInside(whole, angle, 4000, 3000), angle, 4000, 3000)));
expect('a frame in a corner, which cannot fit where it is, is moved to the middle and shrunk', g.inside(g.shrinkInside(frame(0.7, 0.7, 0.3, 0.3), 30, 4000, 3000), 30, 4000, 3000));
const stopped = g.limit(frame(0.2, 0.2, 0.5, 0.5), frame(0.2, 0.2, 0.9, 0.9), 10, 4000, 3000);
expect('a frame dragged outside stops at the edge on the way', g.inside(stopped, 10, 4000, 3000) && stopped.w > 0.5 && stopped.w < 0.9);
expect('a frame dragged to a place that fits is let through as it is', g.limit(frame(0.2, 0.2, 0.3, 0.3), frame(0.25, 0.25, 0.3, 0.3), 10, 4000, 3000).x === 0.25);

console.log('aspect ratios');
const ratio = (aspect, portrait = false, w = 4000, h = 3000) => g.ratioOf({ ...g.neutral(), aspect, portrait }, w, h);
expect('free has no ratio, square is 1, and the others are wide or tall', ratio('free') === null && ratio('1:1') === 1 && ratio('1:1', true) === 1 && ratio('3:2') === 1.5 && near(ratio('3:2', true), 2 / 3) && near(ratio('16:9'), 16 / 9) && near(ratio('4:5', true), 0.8) && near(ratio('4:5'), 1.25));
expect('the original ratio is the turned picture\'s, and tall when portrait is on', near(ratio('original'), 4 / 3) && near(ratio('original', true), 3 / 4) && near(ratio('original', false, 3000, 4000), 4 / 3));
const square = g.fitRatio(whole, 1, 0, 4000, 3000);
expect('the largest square in a 4000 by 3000 picture is 3000 by 3000, centred', close(square, frame(0.125, 0, 0.75, 1)) && is(g.outputSize({ ...g.neutral(), crop: square }, 4000, 3000), [3000, 3000]));
const wide = g.fitRatio(frame(0.1, 0.1, 0.5, 0.5), 16 / 9, 0, 4000, 3000);
expect('a wide frame fits the width of the frame it is in and keeps its middle', near(wide.w * 4000 / (wide.h * 3000), 16 / 9) && near(wide.w, 0.5) && near(wide.x + wide.w / 2, 0.35) && near(wide.y + wide.h / 2, 0.35));
expect('with no ratio the frame is left as it is', g.fitRatio(frame(0.1, 0.1, 0.5, 0.5), null, 0, 4000, 3000).w === 0.5);
expect('a level shrinks the frame of a set shape and keeps the shape', (() => { const f = g.fitRatio(g.shrinkInside(whole, 10, 4000, 3000), 1, 10, 4000, 3000); return g.inside(f, 10, 4000, 3000) && near(f.w * 4000, f.h * 3000, 0.5); })());

console.log('dragging the frame');
const box = frame(0.2, 0.2, 0.4, 0.4);
expect('moving keeps the frame inside the picture', close(g.moveFrame(box, 0.9, 0.9), frame(0.6, 0.6, 0.4, 0.4)) && close(g.moveFrame(box, -0.9, -0.9), frame(0, 0, 0.4, 0.4)) && close(g.moveFrame(box, 0.1, 0), frame(0.3, 0.2, 0.4, 0.4)));
expect('a free corner drag moves the two sides it touches', close(g.resizeFrame(box, 'se', 100, 50, null, 1000, 1000), frame(0.2, 0.2, 0.5, 0.45)) && close(g.resizeFrame(box, 'nw', -100, -50, null, 1000, 1000), frame(0.1, 0.15, 0.5, 0.45)));
expect('a free side drag moves one side', close(g.resizeFrame(box, 'e', 100, 90, null, 1000, 1000), frame(0.2, 0.2, 0.5, 0.4)) && close(g.resizeFrame(box, 'n', 90, -100, null, 1000, 1000), frame(0.2, 0.1, 0.4, 0.5)));
expect('a frame cannot be dragged out of the picture or smaller than 40 pixels', close(g.resizeFrame(box, 'se', 900, 900, null, 1000, 1000), frame(0.2, 0.2, 0.8, 0.8)) && g.resizeFrame(box, 'e', -900, 0, null, 1000, 1000).w * 1000 === 40);
const kept = g.resizeFrame(frame(0.1, 0.1, 0.4, 0.4), 'se', 100, 0, 1, 1000, 1000);
expect('a corner drag with a ratio keeps the shape and holds the opposite corner', close(kept, frame(0.1, 0.1, 0.5, 0.5)));
const kept2 = g.resizeFrame(frame(0.1, 0.1, 0.4, 0.4), 'nw', -50, 0, 1, 1000, 1000);
expect('and from the other corner', close(kept2, frame(0.05, 0.05, 0.45, 0.45)));
const side = g.resizeFrame(frame(0.1, 0.1, 0.4, 0.4), 'e', 100, 0, 1, 1000, 1000);
expect('a side drag with a ratio grows the frame about the middle of the opposite side', near(side.w, side.h) && near(side.x, 0.1) && near(side.w, 0.5) && near(side.y + side.h / 2, 0.3));
const top = g.resizeFrame(frame(0.3, 0.3, 0.4, 0.4), 'n', 0, -100, 16 / 9, 1000, 1000);
expect('a top drag with a wide ratio grows the width about the middle and holds the bottom', near(top.w * 1000 / (top.h * 1000), 16 / 9) && near(top.y + top.h, 0.7) && near(top.x + top.w / 2, 0.5), JSON.stringify(top));
expect('a drag with a ratio never leaves the picture', (() => { const f = g.resizeFrame(frame(0.1, 0.1, 0.4, 0.4), 'se', 2000, 2000, 3 / 2, 1000, 1000); return f.x + f.w <= 1.000001 && f.y + f.h <= 1.000001 && near(f.w * 1000 / (f.h * 1000), 3 / 2); })());
finish();
