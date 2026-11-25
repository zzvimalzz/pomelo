// SPDX-License-Identifier: AGPL-3.0-or-later
// The view settings of the image editor: only valid fields are kept.   node test/unit/image-editor/view.test.js
const { cleanView } = require('../../../src/features/image-editor/view');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const is = (got, want) => JSON.stringify(got) === JSON.stringify(want);

expect('valid sections and panel are kept', is(cleanView({ sections: ['light', 'curve'], panel: false }), { sections: ['light', 'curve'], panel: false }));
expect('a section listed twice is kept once', is(cleanView({ sections: ['light', 'light'] }), { sections: ['light'] }));
expect('an empty list is valid: every section closed', is(cleanView({ sections: [] }), { sections: [] }));
expect('a section that does not exist spoils the list', is(cleanView({ sections: ['light', 'bogus'], panel: true }), { panel: true }));
expect('panel must be a boolean', is(cleanView({ panel: 'yes' }), {}) && is(cleanView({ panel: 1 }), {}));
expect('a window place and unknown keys are not part of the view', is(cleanView({ window: { x: 1 }, zoom: 3, panel: true }), { panel: true }));
expect('anything that is not an object is no view', [null, undefined, 'x', 5, []].every((v) => is(cleanView(v), {})));
finish();
