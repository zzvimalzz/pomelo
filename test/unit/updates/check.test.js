// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercises the update checker against a local fake release server.   node test/unit/updates/check.test.js
const http = require('http');
const updater = require('../../../src/features/updates/check');

const routes = {
  '/gh-newer': { tag_name: 'v9.9.9', html_url: 'https://github.com/o/r/releases/tag/v9.9.9', body: 'Faster conversions', assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/x' }, { name: 'Pomelo-Setup-9.9.9.exe', browser_download_url: 'https://github.com/o/r/releases/download/v9.9.9/Pomelo-Setup-9.9.9.exe' }] },
  '/gh-same': { tag_name: 'v0.1.0', html_url: 'https://github.com/o/r/releases/tag/v0.1.0', assets: [] },
  '/gh-older': { tag_name: 'v0.0.9', assets: [] },
  '/generic-newer': { version: '1.2.0', url: 'https://example.test/download', notes: 'Notes' },
  '/bad-json': { unexpected: true },
};

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/server-error') { res.statusCode = 500; return res.end('boom'); }
    if (req.url === '/missing') { res.statusCode = 404; return res.end('{}'); }
    if (req.url === '/not-json') { res.setHeader('content-type', 'text/html'); return res.end('<html>'); }
    const body = routes[req.url];
    if (!body) { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const check = (p, current = '0.1.0') => updater.check({ feed: base + p, current });

  console.log('version comparison');
  for (const [a, b, want] of [['1.0.0', '1.0.0', 0], ['1.0.1', '1.0.0', 1], ['0.9.9', '1.0.0', -1], ['v2.0', '1.9.9', 1], ['1.10.0', '1.9.0', 1],
    ['1.0.0-beta.1', '1.0.0', 0]]) {   // known behaviour, not a goal: SemVer ranks a pre-release below its release (-1). Flip this when compareVersions is made SemVer-correct
    expect(`${a} vs ${b}`, updater.compareVersions(a, b) === want);
  }

  console.log('feeds');
  let r = await check('/gh-newer');
  expect('GitHub release newer -> available', r.state === 'available' && r.latest === '9.9.9', JSON.stringify({ latest: r.latest, url: r.url }));
  expect('picks the Setup installer asset', /Pomelo-Setup-9\.9\.9\.exe$/.test(r.url || ''));
  r = await check('/gh-same');       expect('same version -> uptodate', r.state === 'uptodate');
  r = await check('/gh-older');      expect('older release -> uptodate', r.state === 'uptodate');
  r = await check('/generic-newer'); expect('generic feed newer -> available', r.state === 'available' && r.latest === '1.2.0' && r.url === 'https://example.test/download');
  r = await check('/missing');       expect('404 (no releases yet) -> uptodate with a note', r.state === 'uptodate' && /No releases/.test(r.note || ''));
  r = await check('/server-error');  expect('500 -> error', r.state === 'error', r.message);
  r = await check('/not-json');      expect('non-JSON -> error', r.state === 'error', r.message);
  r = await check('/bad-json');      expect('unexpected JSON shape -> error', r.state === 'error', r.message);
  r = await updater.check({ feed: 'http://127.0.0.1:1/none', current: '0.1.0' });
  expect('server unreachable -> error', r.state === 'error', r.message);
  r = await updater.check({ feed: null, current: '0.1.0' });
  expect('no feed configured -> unconfigured (no request)', r.state === 'unconfigured');

  console.log('download link safety');
  for (const url of ['http://github.com/o/r', 'https://evil.example/x.exe', 'javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'nonsense']) {
    const opened = [];
    const out = await updater.openDownload(url, async (u) => opened.push(u));
    expect(`refuses ${url}`, out.ok === false && opened.length === 0, out.message);
  }
  {
    const opened = [];
    const out = await updater.openDownload('https://github.com/o/r/releases/latest', async (u) => opened.push(u));
    expect('opens a GitHub link through the function it is given', out.ok === true && opened.join() === 'https://github.com/o/r/releases/latest');
  }

  server.close();
  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();
