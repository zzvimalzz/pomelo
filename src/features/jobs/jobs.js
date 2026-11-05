// SPDX-License-Identifier: AGPL-3.0-or-later
// Conversion jobs and what the toast shows for them. No UI in here, so it can be tested on its own.
//
// - Conversions run in parallel (up to `concurrency`), each file x target is one job.
// - The toast shows up to `maxStack` cards, newest on top. A running card has a progress ring with a cancel (X) in it.
// - When more than `maxStack` conversions are in flight, everything collapses into ONE summary card
//   ("Converting 1/4 files", ring + X cancels what is left) until that batch is finished.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { shownProgress, remaining, guessMs } = require('./estimate');
const { middleEllipsis } = require('../../shared/core/text');

const sizeOf = (file) => { try { const st = fs.statSync(file); return st.isFile() ? st.size : 0; } catch { return 0; } };

class Jobs extends EventEmitter {
  // formats = { extOf, kinds }: the format of a file, and the extension sets guessMs needs (both from the conversion feature,
  // handed in by the app). timings: learns how long each kind of conversion takes here (see estimate.js); now: the clock, for tests.
  constructor({ convert, formats, concurrency = 3, maxStack = 3, timings = null, now = Date.now }) {
    super();
    if (!formats?.extOf || !formats.kinds) throw new Error('Jobs needs formats = { extOf, kinds }');
    this.formats = formats;
    this.convert = convert;          // async (src, to, { onProgress, signal }) => [output paths]
    this.timings = timings;
    this.now = now;
    this.ticker = null;              // redraws the cards twice a second while something runs, so the ring and the time left move
    this.concurrency = concurrency;
    this.maxStack = maxStack;
    this.items = [];                 // cards, newest first: conversion jobs and info messages
    this.batch = [];                 // conversion jobs since things were last idle (for the summary)
    this.mode = 'stack';             // 'stack' | 'summary'
    this.queue = [];
    this.running = 0;
    this.seq = 0;
  }

  active() { return this.batch.filter((j) => j.state === 'queued' || j.state === 'working'); }

  // label: what the user sees for the target, e.g. "PDF"
  addConversion(src, to, label) {
    if (!this.active().length) {                                                // a new burst starts
      if (this.mode === 'summary') this.items = this.items.filter((i) => i.kind !== 'job');   // the old summary stands in for them
      this.batch = [];
      this.mode = 'stack';
    }
    const job = { id: `job${++this.seq}`, kind: 'job', src, to, label, name: path.basename(src), key: `${src.toLowerCase()}|${to}`,
      state: 'queued', progress: null, outPath: null, error: null, controller: new AbortController() };
    this.batch.push(job);
    this.items.unshift(job);
    if (this.active().length > this.maxStack) this.mode = 'summary';
    this.trim();
    this.queue.push(job);
    this.changed();
    this.pump();
    return job.id;
  }

  addInfo({ title, detail }) {
    const info = { id: `info${++this.seq}`, kind: 'info', state: 'info', title, detail: detail || '' };
    this.items.unshift(info);
    this.trim();
    this.changed();
    return info.id;
  }

  // Cancel one job, or everything still running when the summary card's X is pressed.
  cancel(id) {
    const targets = id === 'summary' ? this.active() : this.batch.filter((j) => j.id === id && (j.state === 'queued' || j.state === 'working'));
    for (const job of targets) {
      this.queue = this.queue.filter((q) => q !== job);
      job.state = 'cancelled';
      job.controller.abort();                                                   // kills helper programs, deletes partial output
      this.items = this.items.filter((i) => i !== job);
    }
    if (targets.length) { this.changed(); this.pump(); }
  }

  // The renderer finished showing (and fading out) this card.
  remove(id) {
    if (id === 'summary') {
      if (this.active().length) return;                                       // still converting: the summary stays
      this.items = this.items.filter((i) => i.kind !== 'job');
      this.batch = [];
      this.mode = 'stack';
    } else {
      this.items = this.items.filter((i) => i.id !== id);
    }
    this.changed();
  }

  // Keep the stack within bounds by dropping the oldest cards that are already finished.
  trim() {
    if (this.mode === 'summary') return;
    for (let i = this.items.length - 1; i >= 0 && this.items.length > this.maxStack; i--) {
      if (!['queued', 'working'].includes(this.items[i].state)) this.items.splice(i, 1);
    }
  }

  // Two jobs for the same file and format would both pick the same output name, so the second waits for the first.
  pump() {
    while (this.running < this.concurrency) {
      const next = this.queue.findIndex((j) => !this.batch.some((o) => o.state === 'working' && o.key === j.key));
      if (next < 0) return;
      this.start(this.queue.splice(next, 1)[0]);
    }
  }

  async start(job) {
    job.state = 'working';
    job.startedAt = this.now();
    job.from = this.formats.extOf(job.src);
    job.size = sizeOf(job.src);
    job.expected = this.timings ? this.timings.expected(job.from, job.to, job.size, this.formats.kinds) : guessMs(job.from, job.to, job.size, this.formats.kinds);
    this.running++;
    this.startTicker();
    this.changed();
    try {
      const outs = await this.convert(job.src, job.to, { signal: job.controller.signal, onProgress: (f) => { if (job.state === 'working' && Number.isFinite(f)) { job.progress = Math.max(job.progress || 0, Math.min(1, f)); this.changed(); } } });
      if (job.state === 'working') {
        job.outPath = outs[0];
        job.state = 'done';
        this.timings?.record(job.from, job.to, job.size, this.now() - job.startedAt);
      }
    } catch (e) {
      if (job.state === 'working') { job.error = e.message; job.state = 'error'; }
    } finally {
      this.running--;
      this.trim();
      this.changed();
      this.pump();
    }
  }

  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (!this.batch.some((j) => j.state === 'working')) { clearInterval(this.ticker); this.ticker = null; return; }
      this.changed();
    }, 500);
    this.ticker.unref?.();
  }

  // { value 0..1, left: text or null } for a running job, from what the engine reported or from the clock.
  measure(job) {
    const elapsed = this.now() - job.startedAt;
    job.shown = shownProgress(job.progress, elapsed, job.expected, job.shown || 0);
    const r = remaining({ reported: job.progress, elapsed, expected: job.expected, previous: job.leftMs });
    job.leftMs = r.ms;
    return { value: job.shown, left: r.text };
  }

  changed() { this.emit('change', this.view()); }

  // What to draw: { mode, cards: [{ id, state, title, detail, progress, outPath, ring? }] }, newest first.
  view() {
    if (this.mode === 'summary') {
      const infos = this.items.filter((i) => i.kind === 'info').slice(0, this.maxStack - 1).map(infoCard);
      const summary = this.summaryCard();
      return { mode: 'summary', cards: summary ? [summary, ...infos] : infos };
    }
    return { mode: 'stack', cards: this.items.slice(0, this.maxStack).map((i) => (i.kind === 'info' ? infoCard(i) : jobCard(i, this))) };
  }

  summaryCard() {
    const b = this.batch.filter((j) => j.state !== 'cancelled');
    if (!b.length) return null;
    const total = b.length;
    const finished = b.filter((j) => j.state === 'done' || j.state === 'error');
    const failed = b.filter((j) => j.state === 'error');
    const ok = finished.length - failed.length;
    const working = b.filter((j) => j.state === 'working');
    const queued = b.filter((j) => j.state === 'queued');
    const partial = working.reduce((sum, j) => sum + this.measure(j).value, 0);
    const progress = Math.min(1, (finished.length + partial) / total);
    const firstOut = b.find((j) => j.state === 'done');
    const base = { id: 'summary', ring: true, progress };
    if (working.length || queued.length) {
      // time left for the whole batch: the pace so far, once there is a pace to speak of
      const began = Math.min(...b.filter((j) => j.startedAt).map((j) => j.startedAt));
      const left = Number.isFinite(began) ? remaining({ reported: progress, elapsed: this.now() - began, expected: 0, previous: this.batchLeft }) : { ms: null, text: null };
      this.batchLeft = left.ms;
      return { ...base, state: 'working', title: `Converting ${finished.length}/${total} files`,
        detail: [`${Math.round(progress * 100)}%`, left.text, `${working.length} in progress${queued.length ? ` · ${queued.length} waiting` : ''}${failed.length ? ` · ${failed.length} failed` : ''}`].filter(Boolean).join(' · ') };
    }
    if (failed.length === total) return { ...base, state: 'error', title: 'Conversion failed', detail: failed[0].error || 'Nothing could be converted' };
    return { ...base, state: 'done', title: failed.length ? `${ok} converted · ${failed.length} failed` : `${ok} files converted`,
      detail: 'Saved next to the originals · click to show', outPath: firstOut && firstOut.outPath };
  }
}

function infoCard(i) { return { id: i.id, state: 'info', title: i.title, detail: i.detail, progress: null, outPath: '' }; }

// "name · 42% · about 12 s left". The name is shortened in the middle so the figures are never the part that is cut off.
function jobCard(j, jobs) {
  if (j.state === 'queued') return { id: j.id, state: 'working', ring: true, title: `Waiting to convert to ${j.label}`, detail: `${j.name} · 0%`, progress: 0, outPath: '' };
  if (j.state === 'working') {
    const m = jobs.measure(j);
    const detail = [middleEllipsis(j.name, 30), `${Math.round(m.value * 100)}%`, m.left].filter(Boolean).join(' · ');
    return { id: j.id, state: 'working', ring: true, title: `Converting to ${j.label}…`, detail, progress: m.value, outPath: '' };
  }
  if (j.state === 'done') return { id: j.id, state: 'done', title: path.basename(j.outPath), detail: 'Saved next to the original · click to show', progress: null, outPath: j.outPath };
  return { id: j.id, state: 'error', title: 'Conversion failed', detail: `${j.name}: ${j.error}`, progress: null, outPath: '' };
}

module.exports = { Jobs };
