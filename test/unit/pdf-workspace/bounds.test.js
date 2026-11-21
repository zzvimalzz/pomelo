// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the workspace window opens: its saved place when that is still on a screen, otherwise the middle of the main screen.
//   node test/unit/pdf-workspace/bounds.test.js
const { startBounds, MIN } = require('../../../src/features/pdf-workspace/bounds');
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
const saved = { x: 100, y: 50, width: 1000, height: 700, maximised: false };
expect('a place on the screen is kept', is(startBounds(saved, [main]), saved));
expect('and so is a maximised window, whose place is the one it returns to', is(startBounds({ ...saved, maximised: true }, [main]), { ...saved, maximised: true }));
expect('a window on the second screen is kept while that screen is there', is(startBounds({ ...saved, x: 2000 }, [main, right]), { ...saved, x: 2000, maximised: false }));
expect('and opens in the middle of the main screen when it is not', is(startBounds({ ...saved, x: 2000 }, [main]), startBounds(null, [main])));
expect('a window whose title row is off the top or the bottom is lost', is(startBounds({ ...saved, y: -30 }, [main]), startBounds(null, [main])) && is(startBounds({ ...saved, y: 1020 }, [main]), startBounds(null, [main])));
expect('a window with 100 px of its title row on a screen can still be dragged', is(startBounds({ ...saved, x: -900 }, [main]), { ...saved, x: -900, maximised: false }) && is(startBounds({ ...saved, x: -901 }, [main]), startBounds(null, [main])));
expect('a size under the minimum is raised to it', is(startBounds({ ...saved, width: 300, height: 200 }, [main]), { ...saved, width: MIN.width, height: MIN.height, maximised: false }));
expect('numbers are rounded to whole pixels', is(startBounds({ x: 100.4, y: 50.6, width: 1000.2, height: 700.7 }, [main]), { x: 100, y: 51, width: 1000, height: 701, maximised: false }));

finish();
