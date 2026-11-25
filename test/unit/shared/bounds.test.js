// SPDX-License-Identifier: AGPL-3.0-or-later
// Where an app window opens: its saved place when that is still on a screen, otherwise the middle of the main screen.
//   node test/unit/shared/bounds.test.js
const { startBounds, MIN } = require('../../../src/shared/core/bounds');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const main = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 1280, height: 1000 };
const small = { x: 0, y: 0, width: 1024, height: 700 };
const is = (got, want) => JSON.stringify(got) === JSON.stringify(want);

console.log('no saved place');
expect('it opens in the middle of the main screen at 1200 x 800', is(startBounds(null, [main]), { x: 360, y: 120, width: 1200, height: 800, maximised: false }), JSON.stringify(startBounds(null, [main])));
expect('the middle of a screen that does not start at 0, 0', is(startBounds(undefined, [{ x: -1920, y: 0, width: 1920, height: 1040 }, right]), { x: -1560, y: 120, width: 1200, height: 800, maximised: false }));
expect('on a screen smaller than that it fills the screen', is(startBounds(null, [small]), { x: 0, y: 0, width: 1024, height: 700, maximised: false }));
expect('anything stored that is not a place is no place', [{}, 'x', 5, { x: 1, y: 2, width: '900', height: 700 }, { x: NaN, y: 0, width: 900, height: 700 }].every((v) => is(startBounds(v, [main]), startBounds(null, [main]))));

console.log('a saved place');
const NOW = Date.UTC(2026, 10, 22, 12);
const HOUR = 3600 * 1000;
const placed = { x: 100, y: 50, width: 1000, height: 700, maximised: false };
const saved = { ...placed, savedAt: NOW - HOUR };
const bounds = (value, areas) => startBounds(value, areas, NOW);
expect('a place on the screen is kept', is(bounds(saved, [main]), placed));
expect('and so is a maximised window, whose place is the one it returns to', is(bounds({ ...saved, maximised: true }, [main]), { ...placed, maximised: true }));
expect('a window on the second screen is kept while that screen is there', is(bounds({ ...saved, x: 2000 }, [main, right]), { ...placed, x: 2000 }));
expect('and opens in the middle of the main screen when it is not', is(bounds({ ...saved, x: 2000 }, [main]), bounds(null, [main])));
expect('a window whose title row is off the top or the bottom is lost', is(bounds({ ...saved, y: -30 }, [main]), bounds(null, [main])) && is(bounds({ ...saved, y: 1020 }, [main]), bounds(null, [main])));
expect('a window with 100 px of its title row on a screen can still be dragged', is(bounds({ ...saved, x: -900 }, [main]), { ...placed, x: -900 }) && is(bounds({ ...saved, x: -901 }, [main]), bounds(null, [main])));
expect('a size under the minimum is raised to it', is(bounds({ ...saved, width: 300, height: 200 }, [main]), { ...placed, width: MIN.width, height: MIN.height }));
expect('numbers are rounded to whole pixels', is(bounds({ x: 100.4, y: 50.6, width: 1000.2, height: 700.7, savedAt: NOW }, [main]), { x: 100, y: 51, width: 1000, height: 701, maximised: false }));

console.log('how long a place is kept');
expect('a place saved just under 24 hours ago is kept', is(bounds({ ...saved, savedAt: NOW - 24 * HOUR + 1000 }, [main]), placed));
expect('one saved 24 hours ago or more is forgotten, and the window opens at the default size', is(bounds({ ...saved, savedAt: NOW - 24 * HOUR }, [main]), bounds(null, [main])) && is(bounds({ ...saved, savedAt: NOW - 30 * 24 * HOUR }, [main]), bounds(null, [main])));
expect('a maximised window is forgotten too, so the next one is windowed', is(bounds({ ...saved, maximised: true, savedAt: NOW - 25 * HOUR }, [main]), bounds(null, [main])) && bounds(null, [main]).maximised === false);
expect('a place saved before the time was stored counts as old', is(bounds(placed, [main]), bounds(null, [main])));
expect('a time that is not a number counts as old', [undefined, null, '1', NaN, Infinity].every((v) => is(bounds({ ...placed, savedAt: v }, [main]), bounds(null, [main]))));
expect('a clock set back by a day does not keep a place for ever', is(bounds({ ...saved, savedAt: NOW + 2 * 24 * HOUR }, [main]), bounds(null, [main])));

finish();
