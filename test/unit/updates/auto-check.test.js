// SPDX-License-Identifier: AGPL-3.0-or-later
// "Check automatically": checks when it is on and due, tells the user once per version, never downloads.   node test/autoupdate-test.js
const { AutoUpdate, DAY } = require('../src/main/autoUpdate');

const { expect, failed } = require('./support/expect');
const finish = require('./support/finish');
const tick = () => new Promise((r) => setImmediate(r));

// A clock and a set of timers the test drives by hand.
function rig(initial = {}, results = []) {
  const clock = { t: 10 * DAY };
  const stored = { autoUpdate: false, lastUpdateCheck: 0, updateNotified: '', ...initial };
  const timers = []; const calls = { check: 0, notified: [] };
  const au = new AutoUpdate({
    getSettings: () => stored,
    setSettings: (p) => Object.assign(stored, p),
    check: async () => { calls.check++; const r = results.shift() ?? { state: 'uptodate' }; if (r instanceof Error) throw r; return r; },
    onAvailable: (r) => calls.notified.push(r.latest),
    now: () => clock.t,
    timers: { set: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; }, clear: (t) => { t.cleared = true; } },
  });
  const live = () => timers.filter((t) => !t.cleared);
  const fire = async () => { const t = live().at(-1); t.cleared = true; await t.fn(); await tick(); };
  return { au, stored, clock, timers, calls, live, fire };
}
const NEW = (v) => ({ state: 'available', latest: v, url: `https://github.com/o/r/releases/download/v${v}/Pomelo-Setup-x64.exe`, current: '0.1.0' });

(async () => {
  console.log('off (the default): Pomelo makes no update request on its own');
  { const r = rig(); r.au.apply(); expect('nothing is scheduled', r.live().length === 0); expect('nothing was checked', r.calls.check === 0); }

  console.log('on: checks shortly after start, then once a day');
  {
    const r = rig({ autoUpdate: true }, [{ state: 'uptodate' }, { state: 'uptodate' }]);
    r.au.apply();
    expect('a check is scheduled about 30 seconds out', r.live().length === 1 && r.live()[0].ms === 30000, String(r.live()[0]?.ms));
    await r.fire();
    expect('it checked once and remembered when', r.calls.check === 1 && r.stored.lastUpdateCheck === r.clock.t);
    expect('the next check is a day away', r.live().length === 1 && r.live()[0].ms === DAY, String(r.live()[0]?.ms));
    expect('no notice when up to date', r.calls.notified.length === 0 && r.au.available === null);
  }

  console.log('on, but checked a few hours ago: waits out the rest of the day');
  {
    const r = rig({ autoUpdate: true });
    r.stored.lastUpdateCheck = r.clock.t - 5 * 60 * 60 * 1000;
    r.au.apply();
    expect('the first check waits 19 hours, not 30 seconds', Math.abs(r.live()[0].ms - 19 * 60 * 60 * 1000) < 1000, String(r.live()[0].ms));
  }

  console.log('an update is found');
  {
    const r = rig({ autoUpdate: true }, [NEW('0.2.0'), NEW('0.2.0'), NEW('0.3.0')]);
    r.au.apply();
    await r.fire();
    expect('the user is told, once', r.calls.notified.join() === '0.2.0');
    expect('Settings can show the Download button straight away', r.au.available?.latest === '0.2.0' && /^https:\/\/github\.com\//.test(r.au.available.url));
    await r.fire();
    expect('the same version is not announced again the next day', r.calls.notified.join() === '0.2.0');
    await r.fire();
    expect('a newer version is', r.calls.notified.join() === '0.2.0,0.3.0');
  }

  console.log('failing quietly');
  {
    const r = rig({ autoUpdate: true }, [{ state: 'error', message: 'offline' }, new Error('boom'), { state: 'uptodate' }]);
    r.au.apply();
    await r.fire();
    expect('offline: no notice, and it does not count as a check', r.calls.notified.length === 0 && r.stored.lastUpdateCheck === 0);
    expect('it tries again in a couple of hours, not a day', r.live()[0].ms === 2 * 60 * 60 * 1000, String(r.live()[0].ms));
    await r.fire();
    expect('even a thrown error is swallowed', r.live().length === 1 && r.calls.check === 2);
    await r.fire();
    expect('and it recovers', r.stored.lastUpdateCheck === r.clock.t);
  }

  console.log('switching it off stops everything');
  {
    const r = rig({ autoUpdate: true });
    r.au.apply();
    r.stored.autoUpdate = false;
    r.au.apply();
    expect('the pending check is cancelled', r.live().length === 0);
    const t = r.timers[0]; await t.fn(); await tick();
    expect('and a check that was already due does nothing', r.calls.check === 0);
  }

  console.log('a manual check teaches it too');
  {
    const r = rig();
    r.au.remember(NEW('0.2.0'));
    expect('available is remembered', r.au.available.latest === '0.2.0');
    r.au.remember({ state: 'uptodate' });
    expect('and forgotten when up to date', r.au.available === null);
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall good');
  finish();
})();
