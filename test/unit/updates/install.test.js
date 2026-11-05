// SPDX-License-Identifier: AGPL-3.0-or-later
// Updating from inside Pomelo: where it may download from, that a bad or partial download is thrown away, and the command
// that is run.   node test/updateinstall-test.js
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { allowedUrl, download, installCommand, launch } = require('../src/main/updateInstall');

const { expect, failed } = require('./support/expect');
const finish = require('./support/finish');
const tmp = require('./support/tmp');
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const BODY = crypto.randomBytes(3 * 1024 * 1024);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');

(async () => {
  console.log('where a download may come from');
  const none = {};
  expect('GitHub over https', allowedUrl('https://github.com/zzvimalzz/pomelo/releases/download/v1/Pomelo-Setup-x64.exe', none));
  expect('GitHub release storage over https', allowedUrl('https://objects.githubusercontent.com/x', none));
  expect('plain http is refused', !allowedUrl('http://github.com/x', none));
  expect('another host is refused', !allowedUrl('https://example.com/Pomelo-Setup-x64.exe', none));
  expect('a look-alike host is refused', !allowedUrl('https://github.com.evil.example/x', none) && !allowedUrl('https://evilgithubusercontent.com/x', none));
  expect('not a url is refused', !allowedUrl('Pomelo-Setup-x64.exe', none) && !allowedUrl('', none));
  expect('a configured feed host is allowed over https', allowedUrl('https://updates.example.org/a.exe', { feedHost: 'updates.example.org' }));
  expect('http to the feed host only while testing', !allowedUrl('http://127.0.0.1:1/a.exe', { feedHost: '127.0.0.1:1' }) && allowedUrl('http://127.0.0.1:1/a.exe', { feedHost: '127.0.0.1:1', testing: true }));

  const server = http.createServer((req, res) => {
    if (req.url === '/ok' || req.url === '/slow') {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.end(BODY);
    } else if (req.url === '/short') {            // the connection ends before all bytes arrived
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.write(BODY.subarray(0, 1000));
      setTimeout(() => res.destroy(), 30);
    } else if (req.url === '/tampered') {
      const b = Buffer.from(BODY); b[1234] ^= 1;
      res.writeHead(200, { 'Content-Length': b.length });
      res.end(b);
    } else if (req.url === '/hop') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
    } else if (req.url === '/go') {
      res.writeHead(302, { Location: 'https://example.com/elsewhere.exe' });
      res.end();
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${server.address().port}`;
  const rules = { feedHost: host, testing: true };
  const base = `http://${host}`;
  const dir = tmp.dir('ui-test');
  const go = (p, extra = {}) => download({ url: base + p, sha256: SHA, size: BODY.length, dir, rules, ...extra });

  console.log('download');
  const seen = [];
  const file = await go('/ok', { onProgress: (p) => seen.push(p) });
  expect('the verified installer is saved', fs.existsSync(file) && fs.readFileSync(file).equals(BODY));
  expect('no .part file is left', !fs.readdirSync(dir).some((f) => f.endsWith('.part')));
  expect('progress is reported and ends at 100%', seen.length > 0 && seen.at(-1).fraction === 1 && seen.every((p, i) => i === 0 || p.received >= seen[i - 1].received));
  expect('the total is known', seen.at(-1).total === BODY.length);

  let e = await rejects(go('/tampered'));
  expect('a download that does not match its checksum is refused', e && /checksum/.test(e.message), e?.message);
  expect('and nothing is kept', !fs.existsSync(dir) || fs.readdirSync(dir).length === 0);

  e = await rejects(go('/short'));
  expect('a cut-off download is refused', !!e, e?.message);
  expect('and nothing is kept (cut off)', !fs.existsSync(dir) || fs.readdirSync(dir).length === 0);

  e = await rejects(go('/missing'));
  expect('a 404 is reported', e && /404/.test(e.message), e?.message);

  e = await rejects(download({ url: base + '/ok', sha256: '', size: BODY.length, dir, rules }));
  expect('no checksum, no install', e && /checksum/.test(e.message), e?.message);

  e = await rejects(download({ url: 'https://example.com/Pomelo-Setup-x64.exe', sha256: SHA, dir, rules }));
  expect('an unexpected address is refused before any request', e && /unexpected address/.test(e.message), e?.message);

  e = await rejects(go('/go'));
  expect('a redirect to another host is refused', e && /redirected/.test(e.message), e?.message);

  expect('a redirect within allowed hosts is followed', (await go('/hop').catch(() => null)) !== null);

  const ctl = new AbortController();
  e = await rejects(go('/slow', { signal: ctl.signal, onProgress: () => ctl.abort() }));
  expect('it can be cancelled', e && e.name === 'AbortError', e?.message);

  console.log('what is run');
  const cmd = installCommand('C:\\Temp\\pomelo-update\\Pomelo-Setup-x64.exe', 'C:\\Users\\a b\\AppData\\Local\\Programs\\Pomelo\\Pomelo.exe', 'C:\\Temp\\u.log', '0.2.0');
  expect('silent, no restart, no optional tasks', /\/SILENT/.test(cmd) && /\/NORESTART/.test(cmd) && /\/TASKS= /.test(cmd) && /\/SUPPRESSMSGBOXES/.test(cmd));
  expect('waits for the installer, then starts Pomelo hidden', cmd.indexOf('/wait') < cmd.indexOf('Pomelo.exe"') && /--hidden --updated=0\.2\.0$/.test(cmd));
  expect('paths with spaces are quoted', cmd.includes('"C:\\Users\\a b\\AppData\\Local\\Programs\\Pomelo\\Pomelo.exe"'));
  expect('a strange version is not put on the command line', !/--updated=/.test(installCommand('a.exe', 'p.exe', null, '1.0 & calc')));
  const calls = [];
  launch('C:\\x\\setup.exe', 'C:\\x\\Pomelo.exe', { version: '0.2.0', spawn: (...a) => { calls.push(a); return { unref() { calls.push('unref'); } }; } });
  expect('it is started detached and let go', calls[0][0] === 'cmd.exe' && calls[0][2].detached === true && calls[0][2].stdio === 'ignore' && calls.includes('unref'));

  server.close();
  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();
