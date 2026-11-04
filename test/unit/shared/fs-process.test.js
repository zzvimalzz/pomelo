// SPDX-License-Identifier: AGPL-3.0-or-later
// shared/node/fs.js and process.js: temp files and folders clean up after themselves, text decodes whatever its encoding, and the
// two runners keep their promises (runCapture rejects with a useful line, runStatus never throws).
const fs = require('fs');
const path = require('path');
const { withTempFile, withTempDir, readText, dirBytes, removeDirReliably } = require('../../../src/shared/node/fs');
const { runCapture, runStatus, lastMeaningfulLine, parsePercent, killAll } = require('../../../src/shared/node/process');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');
const tmp = require('../../support/tmp');

const node = (code, opts) => [process.execPath, ['-e', code], opts];
const rejection = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {
  console.log('temp files and folders');
  {
    let seen;
    await withTempFile('txt', async (f) => { seen = f; fs.writeFileSync(f, 'x'); });
    expect('a temp file is removed afterwards', !fs.existsSync(seen));
    await withTempFile('txt', async (f) => { seen = f; });
    expect('and so is one the callback never created', !fs.existsSync(seen));
    const e = await rejection(withTempFile('txt', async (f) => { seen = f; fs.writeFileSync(f, 'x'); throw new Error('boom'); }));
    expect('on an error it is removed and the error still reaches the caller', !fs.existsSync(seen) && e?.message === 'boom');
    let dir;
    const value = await withTempDir(async (d) => { dir = d; fs.writeFileSync(path.join(d, 'a.txt'), 'x'); return 42; });
    expect('a temp folder is removed with its contents, and the result is passed on', !fs.existsSync(dir) && value === 42);
    await rejection(withTempDir(async (d) => { dir = d; throw new Error('boom'); }));
    expect('also when the callback throws', !fs.existsSync(dir));
  }

  console.log('reading text');
  {
    const dir = tmp.dir('fsp');
    const write = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
    expect('UTF-8', readText(write('a.txt', 'héllo €')) === 'héllo €');
    expect('UTF-8 with a BOM loses the BOM', readText(write('b.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo')]))) === 'héllo');
    expect('UTF-16 little endian with a BOM', readText(write('c.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo', 'utf16le')]))) === 'héllo');
    const be = Buffer.from('héllo', 'utf16le').swap16();
    expect('UTF-16 big endian with a BOM', readText(write('d.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), be]))) === 'héllo');
    expect('anything else is read as Windows-1252', readText(write('e.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))) === 'café');
  }

  console.log('folders');
  {
    const dir = tmp.dir('fsp');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a'), '12345');
    fs.writeFileSync(path.join(dir, 'sub', 'b'), '123');
    expect('dirBytes adds up every file below', dirBytes(dir) === 8);
    expect('dirBytes of a folder that is not there is 0', dirBytes(path.join(dir, 'nope')) === 0);
    expect('removeDirReliably removes a folder and says so', (await removeDirReliably(dir)) === true && !fs.existsSync(dir));
    expect('and says so for one that was never there', (await removeDirReliably(dir)) === true);
  }

  console.log('reading program output');
  {
    expect('lastMeaningfulLine takes the last line with words', lastMeaningfulLine('Starting up\n  42%\nValueError: bad page\n---\n') === 'ValueError: bad page');
    expect('and skips logger chatter', lastMeaningfulLine('Real problem here\n[INFO] still going\n[WARNING] careful') === 'Real problem here');
    expect('and has a fallback', lastMeaningfulLine('12\n34', 'nothing') === 'nothing' && lastMeaningfulLine('') === 'unknown error');
    expect('parsePercent reads 45% as 0.45', parsePercent('  45% 3 + file.txt') === 0.45);
    expect('and 123 MB / 369 MB as a third', Math.abs(parsePercent('Downloading 123 MB / 369 MB') - 1 / 3) < 1e-9);
    expect('and says nothing for a line without progress', parsePercent('Scanning the drive') === undefined);
    expect('and never goes past 100%', parsePercent('150%') === 1);
  }

  console.log('running programs');
  {
    expect('runCapture resolves with stdout', (await runCapture(...node("console.log('hello')"))).trim() === 'hello');
    const lines = [];
    await runCapture(...node("console.log('one'); console.error('two')", { onLine: (l) => lines.push(l) }));
    expect('and reports each line while it runs', lines.sort().join() === 'one,two');
    const e = await rejection(runCapture(...node("console.error('[INFO] chatter'); console.error('Real failure: no good'); process.exit(3)")));
    expect('it rejects with the last meaningful line when the program fails', e?.message === 'Real failure: no good', e?.message);
    const missing = await rejection(runCapture('pomelo-no-such-program.exe', []));
    expect('it rejects when the program does not exist', !!missing);
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = rejection(runCapture(...node('setTimeout(() => {}, 30000)', { signal: ac.signal })));
    setTimeout(() => ac.abort(), 300);
    const aborted = await pending;
    expect('aborting kills the program and rejects, within a second or two', !!aborted && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
    expect('a signal that is already aborted rejects without starting anything', !!(await rejection(runCapture(...node("console.log('x')", { signal: AbortSignal.abort() })))));

    const ok = await runStatus(...node("console.log('fine')"));
    expect('runStatus gives the exit code and the output', ok.code === 0 && ok.out.trim() === 'fine');
    const bad = await runStatus(...node("console.error('nope'); process.exit(7)"));
    expect('a failing program is a result, not an exception', bad.code === 7 && /nope/.test(bad.out));
    const none = await runStatus('pomelo-no-such-program.exe', []);
    expect('a program that cannot start is code -1 with the reason', none.code === -1 && /ENOENT/.test(none.out), none.out);
    const progress = [];
    await runStatus(...node("console.log('Downloading 10 MB / 20 MB'); console.log('..'); console.log('45%')", { onLine: (l) => progress.push(l) }));
    expect('runStatus passes on lines with words or progress numbers only', progress.join('|') === 'Downloading 10 MB / 20 MB|45%', progress.join('|'));
    killAll();
  }

  finish();
})();
