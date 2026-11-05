// SPDX-License-Identifier: AGPL-3.0-or-later
// Logic tests for the toast stack and the "Converting 1/4 files" summary.   node test/unit/jobs/jobs.test.js
const { Jobs } = require('../../../src/features/jobs/jobs');
const { timingFormats } = require('../../../src/features/conversion');

const { expect, failed } = require('../../support/expect');
const finish = require('../../support/finish');
const tick = () => new Promise((r) => setImmediate(r));

// A convert function whose jobs finish only when the test says so.
function controlled() {
  const pending = [];
  const fn = (src, to, { onProgress, signal }) => new Promise((resolve, reject) => {
    pending.push({ src, to, onProgress, signal, resolve: () => resolve([`C:/out/${src.split('/').pop().split('.')[0]}.${to}`]), reject });
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  });
  return { fn, pending };
}
// A clock the test moves by hand, so estimated progress and "time left" are exact.
const clock = { t: 1_000_000 };
const make = (extra = {}) => { const c = controlled(); const jobs = new Jobs({ convert: c.fn, formats: timingFormats, concurrency: 3, maxStack: 3, now: () => clock.t, ...extra }); return { jobs, c }; };
const titles = (jobs) => jobs.view().cards.map((x) => x.title);

(async () => {
  console.log('one conversion');
  {
    const { jobs, c } = make();
    jobs.addConversion('C:/a/report.docx', 'pdf', 'PDF');
    await tick();
    let v = jobs.view();
    expect('shows one card in stack mode', v.mode === 'stack' && v.cards.length === 1);
    expect('card says Converting to PDF…, with the percentage from the first moment', v.cards[0].title === 'Converting to PDF…' && v.cards[0].detail === 'report.docx · 0%', v.cards[0].detail);
    c.pending[0].onProgress(0.5);
    expect('progress is shown', jobs.view().cards[0].progress === 0.5 && /50%/.test(jobs.view().cards[0].detail));
    c.pending[0].resolve(); await tick();
    v = jobs.view();
    expect('finishes as a done card with the output name', v.cards[0].state === 'done' && v.cards[0].title === 'report.pdf' && v.cards[0].outPath === 'C:/out/report.pdf');
  }

  console.log('same file to two targets at once, plus a third');
  {
    const { jobs, c } = make();
    jobs.addConversion('C:/a/clip.mov', 'mp4', 'MP4');
    jobs.addConversion('C:/a/clip.mov', 'gif', 'GIF');
    jobs.addConversion('C:/a/clip.mov', 'mp3', 'MP3');
    await tick();
    expect('all three run at the same time', c.pending.length === 3);
    expect('stack of 3, newest on top', jobs.view().mode === 'stack' && titles(jobs).join('|') === 'Converting to MP3…|Converting to GIF…|Converting to MP4…');
  }

  console.log('a 4th conversion collapses everything into one summary');
  {
    const { jobs, c } = make();
    for (const [f, to] of [['a.docx', 'pdf'], ['b.docx', 'pdf'], ['c.docx', 'pdf'], ['d.docx', 'pdf']]) jobs.addConversion('C:/x/' + f, to, 'PDF');
    await tick();
    let v = jobs.view();
    expect('summary mode with a single card', v.mode === 'summary' && v.cards.length === 1);
    expect('only 3 run in parallel, the 4th waits', c.pending.length === 3);
    expect('title reads "Converting 0/4 files"', v.cards[0].title === 'Converting 0/4 files', v.cards[0].title);
    expect('detail: 3 in progress, 1 waiting', /3 in progress · 1 waiting/.test(v.cards[0].detail), v.cards[0].detail);
    expect('summary has a progress ring (the cancel X sits in it)', v.cards[0].ring === true && v.cards[0].state === 'working');
    c.pending[0].resolve(); await tick(); await tick();
    v = jobs.view();
    expect('after one finishes: "Converting 1/4 files"', v.cards[0].title === 'Converting 1/4 files', v.cards[0].title);
    expect('the waiting job started', c.pending.length === 4);
    c.pending[1].onProgress(0.5);
    expect('ring progress = (1 done + 0.5)/4', Math.abs(jobs.view().cards[0].progress - 1.5 / 4) < 1e-9, String(jobs.view().cards[0].progress));
    for (const p of c.pending.slice(1)) p.resolve();
    await tick(); await tick();
    v = jobs.view();
    expect('all done: "4 files converted", clickable', v.cards[0].state === 'done' && v.cards[0].title === '4 files converted' && !!v.cards[0].outPath, v.cards[0].title);
    jobs.remove('summary');
    expect('dismissing the summary clears the batch', jobs.view().cards.length === 0 && jobs.mode === 'stack');
  }

  console.log('failures are counted');
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/x/${f}.docx`, 'pdf', 'PDF');
    await tick();
    c.pending[0].reject(new Error('boom')); c.pending[1].resolve(); c.pending[2].resolve(); await tick(); await tick();
    c.pending[3].resolve(); await tick(); await tick();
    const card = jobs.view().cards[0];
    expect('3 converted · 1 failed', card.title === '3 converted · 1 failed' && card.state === 'done', card.title);
  }
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/x/${f}.docx`, 'pdf', 'PDF');
    await tick();
    c.pending.slice(0, 3).forEach((p) => p.reject(new Error('no engine')));
    await tick(); await tick(); c.pending[3].reject(new Error('no engine')); await tick(); await tick();
    const card = jobs.view().cards[0];
    expect('all failed -> error card with the reason', card.state === 'error' && /no engine/.test(card.detail), card.title + ' | ' + card.detail);
  }

  console.log('stack housekeeping');
  {
    const { jobs, c } = make();
    jobs.addConversion('C:/x/a.docx', 'pdf', 'PDF');
    await tick(); c.pending[0].resolve(); await tick(); await tick();
    jobs.addInfo({ title: "Can't convert .lnk", detail: 'x' });
    jobs.addConversion('C:/x/b.docx', 'pdf', 'PDF');
    jobs.addConversion('C:/x/c.docx', 'pdf', 'PDF');
    await tick();
    const v = jobs.view();
    expect('never more than 3 cards; oldest finished card dropped', v.cards.length === 3 && v.mode === 'stack', titles(jobs).join(' | '));
    expect('newest first', /Converting to PDF/.test(v.cards[0].title) && v.cards[2].title === "Can't convert .lnk");
    jobs.remove(v.cards[2].id);
    expect('remove() takes a card away', jobs.view().cards.length === 2);
  }
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/x/${f}.docx`, 'pdf', 'PDF');
    await tick();
    c.pending.slice(0, 3).forEach((p) => p.resolve()); await tick(); await tick();
    c.pending[3].resolve(); await tick(); await tick();
    expect('summary is showing', jobs.mode === 'summary');
    jobs.addConversion('C:/x/e.docx', 'pdf', 'PDF'); await tick();
    expect('a new conversion after a finished batch starts a fresh stack', jobs.mode === 'stack' && jobs.view().cards.length === 1 && jobs.view().cards[0].title === 'Converting to PDF…', titles(jobs).join(' | '));
  }

  console.log('a message you can click');
  {
    const { jobs } = make();
    const clicked = [];
    const plain = jobs.addInfo({ title: 'Plain', detail: 'x' });
    const button = jobs.addInfo({ title: 'Update your Pomelo to v0.2.0', detail: 'Click to open Pomelo', onClick: () => clicked.push('opened') });
    const cards = jobs.view().cards;
    expect('a card with onClick is marked clickable, a plain one is not', cards.find((x) => x.id === button).clickable === true && cards.find((x) => x.id === plain).clickable === false);
    jobs.activate(plain);
    expect('clicking a plain card does nothing', clicked.length === 0);
    jobs.activate(button);
    expect('clicking the button card runs its action', clicked.join() === 'opened');
    jobs.activate('info999');
    expect('an unknown id is ignored', clicked.length === 1);
  }

  console.log('progress is always a number, and the time left is honest');
  {
    const { jobs, c } = make();
    jobs.addConversion('C:/x/slow.docx', 'pdf', 'PDF');
    await tick();
    const first = jobs.view().cards[0];
    expect('a job that reports nothing starts at 0% with a ring, not a spinner', first.progress === 0 && first.ring === true && /· 0%/.test(first.detail), first.detail);
    clock.t += 3000;
    const a = jobs.view().cards[0];
    expect('with no report from the engine the figure still moves with time', a.progress > 0.05 && a.progress < 0.99 && new RegExp(`· ${Math.round(a.progress * 100)}%`).test(a.detail), a.detail);
    clock.t += 5000;
    const b = jobs.view().cards[0];
    expect('and never goes backwards', b.progress > a.progress, `${a.progress} -> ${b.progress}`);
    expect('an estimate says how long is left, in words', /about \d+ s left|finishing up|almost done|min/.test(b.detail), b.detail);
    c.pending[0].onProgress(0.2);
    expect('a measured figure below the estimate does not pull the ring back', jobs.view().cards[0].progress >= b.progress);
    clock.t += 20000;
    c.pending[0].onProgress(0.9);
    const d = jobs.view().cards[0];
    expect('a measured figure above it takes over', d.progress === 0.9 && /· 90% · /.test(d.detail), d.detail);
    c.pending[0].resolve(); await tick();
  }
  {
    const { jobs, c } = make();
    jobs.addConversion('C:/x/clip.mov', 'mp4', 'MP4');
    await tick();
    clock.t += 10000;
    c.pending[0].onProgress(0.25);
    const left = jobs.view().cards[0].detail;
    expect('measured 25% after 10 s means about 30 s left', /· 25% · about (2\d|3\d|4\d) s left/.test(left), left);
    clock.t += 10000;
    c.pending[0].onProgress(0.5);
    expect('the estimate follows the pace', /· 50% · about (1\d|2\d) s left/.test(jobs.view().cards[0].detail), jobs.view().cards[0].detail);
    c.pending[0].resolve(); await tick();
  }
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/x/${f}.mov`, 'mp4', 'MP4');
    await tick();
    clock.t += 10000;
    c.pending[0].onProgress(0.5);
    const s = jobs.view().cards[0];
    expect('the summary shows its percentage too', /^\d+% · /.test(s.detail), s.detail);
    c.pending.forEach((p) => p.resolve()); await tick(); await tick();
  }

  console.log('cancelling');
  {
    const { jobs, c } = make();
    jobs.addConversion('C:/x/a.docx', 'pdf', 'PDF');
    jobs.addConversion('C:/x/b.docx', 'pdf', 'PDF');
    await tick();
    expect('running cards carry a ring (so they can be cancelled)', jobs.view().cards.every((x) => x.ring === true));
    const oldest = jobs.view().cards[1];
    jobs.cancel(oldest.id); await tick();
    expect('the cancel signal reaches the converter', c.pending[0].signal.aborted === true && c.pending[1].signal.aborted === false);
    expect('the cancelled card disappears at once', jobs.view().cards.length === 1 && /^b\.docx/.test(jobs.view().cards[0].detail));
    c.pending[1].resolve(); await tick(); await tick();
    expect('the other job still finishes normally', jobs.view().cards[0].state === 'done');
  }
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/x/${f}.docx`, 'pdf', 'PDF');
    await tick();
    const fourth = jobs.batch[3];
    jobs.cancel(fourth.id); await tick();
    expect('a waiting job can be cancelled before it starts', c.pending.length === 3 && fourth.state === 'cancelled');
    expect('the summary no longer counts it', jobs.view().cards[0].title === 'Converting 0/3 files', jobs.view().cards[0].title);
  }
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd', 'e']) jobs.addConversion(`C:/x/${f}.docx`, 'pdf', 'PDF');
    await tick();
    c.pending[0].resolve(); await tick(); await tick();
    jobs.cancel('summary'); await tick(); await tick();
    expect('X on the summary cancels everything still running', jobs.active().length === 0 && c.pending.slice(1).every((p) => p.signal.aborted));
    const card = jobs.view().cards[0];
    expect('what already finished is kept', card.state === 'done' && /^1 files? converted/.test(card.title), card.title);
  }
  {
    const { jobs, c } = make();
    for (const f of ['a', 'b', 'c', 'd']) jobs.addConversion(`C:/x/${f}.docx`, 'pdf', 'PDF');
    await tick();
    jobs.cancel('summary'); await tick(); await tick();
    expect('cancelling everything leaves nothing to show', jobs.view().cards.length === 0 && c.pending.every((p) => p.signal.aborted));
    jobs.addConversion('C:/x/e.docx', 'pdf', 'PDF'); await tick();
    expect('and new conversions start fresh afterwards', jobs.view().cards.length === 1 && jobs.mode === 'stack');
  }

  console.log('what is timed: the format, not how the file was spelled');
  {
    const recorded = [];
    const { jobs, c } = make({ timings: { expected: () => 1000, record: (from, to) => recorded.push(`${from}>${to}`) } });
    for (const f of ['C:/p/photo.JPEG', 'C:/p/scan.tif', 'C:/p/README']) jobs.addConversion(f, 'pdf', 'PDF');
    await tick();
    c.pending.forEach((p) => p.resolve());
    await tick(); await tick();
    expect('aliases and capitals are one format (jpeg is jpg, tif is tiff)', recorded.includes('jpg>pdf') && recorded.includes('tiff>pdf'), recorded.join(' '));
    expect('a file with no extension is not taken for a folder', !recorded.includes('folder>pdf') && recorded.includes('>pdf'), recorded.join(' '));
  }

  console.log(failed() ? `\n${failed()} failed` : '\nall passed');
  finish();
})();
