// SPDX-License-Identifier: AGPL-3.0-or-later
// shared/node/fs.js and process.js: temp files and folders clean up after themselves, text decodes whatever its encoding, and the
// two runners keep their promises (runCapture rejects with a useful line, runStatus never throws).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withTempFile, withTempDir, makeTempDir, sweepTempDirs, readText, dirBytes, removeDirReliably, fileIdentity, replaceFile } = require('../../../src/shared/node/fs');
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

  console.log('session folders');
  {
    const tag = `fsp${process.pid}`;
    const old = makeTempDir(tag);
    const young = makeTempDir(tag);
    const other = makeTempDir(`${tag}x`);
    fs.writeFileSync(path.join(old, 'a.txt'), 'x');
    expect('makeTempDir makes an empty folder that stays', fs.statSync(young).isDirectory() && fs.readdirSync(young).length === 0);
    expect('each call gives a new folder', old !== young);
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(old, hourAgo, hourAgo);
    fs.utimesSync(other, hourAgo, hourAgo);
    sweepTempDirs(tag, 1800 * 1000);
    expect('sweepTempDirs removes an old folder with its contents', !fs.existsSync(old));
    expect('and leaves a young one alone', fs.existsSync(young));
    expect('and an old one with another tag', fs.existsSync(other));
    sweepTempDirs(tag, -1);
    expect('with an age of nothing it removes the young one too', !fs.existsSync(young));
    sweepTempDirs(`${tag}x`, 0);
    expect('and the other tag is swept on its own call', !fs.existsSync(other));
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
    const echoed = await runCapture(...node("process.stdin.setEncoding('utf8'); let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => console.log('got ' + s.trim()));", { input: 'Pa55\n' }));
    expect('input is written to the program, which sees the end of it', echoed.trim() === 'got Pa55', echoed);
    const t1 = Date.now();
    const closed = await runCapture(...node("process.stdin.resume(); process.stdin.on('end', () => console.log('stdin closed'));", { timeout: 20000 }));
    expect("without input a program's stdin is closed, so one that waits for it stops waiting", closed.trim() === 'stdin closed' && Date.now() - t1 < 10000, `${Date.now() - t1} ms`);
    killAll();
  }

  console.log('replacing a file');
  {
    const dir = tmp.dir('replace');
    const pdf = (text) => Buffer.from(`%PDF-1.4
${text}
%%EOF
`);
    const target = path.join(dir, 'Report.pdf');
    const next = path.join(dir, 'next.pdf');
    const listing = () => fs.readdirSync(dir).sort().join('|');
    const reset = () => { fs.rmSync(target, { force: true }); fs.writeFileSync(target, pdf('old')); fs.writeFileSync(next, pdf('new new')); return fileIdentity(target); };

    let expected = await reset();
    const done = await replaceFile(next, target, expected);
    expect('a file is replaced by the new bytes, and the new identity is given', fs.readFileSync(target).equals(pdf('new new')) && done.identity.size === pdf('new new').length && done.identity.ino && !done.stop, JSON.stringify(done));
    expect('the new bytes are kept in the source, and no temporary file is left', fs.readFileSync(next).equals(pdf('new new')) && listing() === 'Report.pdf|next.pdf', listing());

    expected = await reset();
    fs.appendFileSync(target, 'x');
    let before = fs.readFileSync(target);
    expect('a file another program changed is not replaced', (await replaceFile(next, target, expected)).stop === 'changed' && fs.readFileSync(target).equals(before) && listing() === 'Report.pdf|next.pdf');
    expected = await reset();
    fs.rmSync(target);
    expect('and neither is one that is gone', (await replaceFile(next, target, expected)).stop === 'changed' && !fs.existsSync(target));
    const created = await replaceFile(next, target, null);
    expect('with nothing expected the file is made', fs.readFileSync(target).equals(pdf('new new')) && !created.stop && listing() === 'Report.pdf|next.pdf');
    expect('and a file that is there already is not overwritten', (await replaceFile(next, target, null)).stop === 'changed');

    expected = await reset();
    fs.chmodSync(target, 0o444);
    expect('a read-only file is not replaced', (await replaceFile(next, target, expected)).stop === 'read-only' && fs.readFileSync(target).equals(pdf('old')));
    fs.chmodSync(target, 0o666);

    expected = await reset();
    const realStatfs = fs.promises.statfs;
    fs.promises.statfs = async () => ({ bavail: 10, bsize: 4096 });
    const full = await replaceFile(next, target, expected);
    fs.promises.statfs = realStatfs;
    expect('a full drive stops it before anything is written', full.stop === 'no-space' && fs.readFileSync(target).equals(pdf('old')) && listing() === 'Report.pdf|next.pdf');

    expected = await reset();
    fs.writeFileSync(next, Buffer.from('%PDF-1.4\nno end'));
    const broken = await rejection(replaceFile(next, target, expected));
    expect('a copy that does not end like a PDF is refused and leaves the file and the folder as they were', !!broken && fs.readFileSync(target).equals(pdf('old')) && listing() === 'Report.pdf|next.pdf', broken?.message);

    expected = await reset();
    const handle = fs.openSync(target, 'r');
    const whileOpen = await replaceFile(next, target, expected);
    const seen = Buffer.alloc(pdf('old').length);
    fs.readSync(handle, seen, 0, seen.length, 0);
    fs.closeSync(handle);
    expect('a file this program holds open is replaced, and the open handle still reads the old bytes', !whileOpen.stop && fs.readFileSync(target).equals(pdf('new new')) && seen.equals(pdf('old')), JSON.stringify(whileOpen));

    expected = await reset();
    fs.writeFileSync(`${target}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    await replaceFile(next, target, expected);
    expect('the mark of a downloaded file survives', fs.readFileSync(`${target}:Zone.Identifier`, 'utf8').includes('ZoneId=3'));

    expected = await reset();
    const holder = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open($env:POMELO_HOLD, 'Open', 'Read', 'Read'); Write-Host READY; Start-Sleep 60`], { env: { ...process.env, POMELO_HOLD: target }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    await new Promise((resolve) => holder.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(); }));
    const started = Date.now();
    const locked = await replaceFile(next, target, expected);
    const took = Date.now() - started;
    holder.kill();
    expect('a file another program holds without sharing is not replaced, and that is known within 3 s', locked.stop === 'locked' && took < 3000 && fs.readFileSync(target).equals(pdf('old')) && listing() === 'Report.pdf|next.pdf', `${locked.stop} ${took} ms ${listing()}`);
    await new Promise((resolve) => holder.on('exit', resolve));
  }

  console.log('passwords from a page');
  {
    const { passwordBuffer } = require('../../../src/shared/node/secrets');
    expect('a one-line string becomes a Buffer of its UTF-8 bytes', passwordBuffer('p\u00e4ssword').equals(Buffer.from('p\u00e4ssword', 'utf8')));
    const bad = ['', 'a\nb', 'a\rb', 'x'.repeat(4097), 5, null, undefined, {}, ['a']];
    expect('an empty, multi-line, over-long or non-string value is refused', bad.every((v) => { try { passwordBuffer(v); return false; } catch { return true; } }));
    expect('4096 characters are allowed', passwordBuffer('x'.repeat(4096)).length === 4096);
  }

  finish();
})();
