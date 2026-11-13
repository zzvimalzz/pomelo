// SPDX-License-Identifier: AGPL-3.0-or-later
// Fidelity harness for PDF -> DOCX (and the round trips). Converts PDFs with Pomelo's real converter, prints the
// DOCX back to PDF with LibreOffice, and compares the two PDFs (text, positions, fonts, images, links, shapes).
//
//   npx electron test/fidelity/make-samples.js        once, draws the sample PDFs
//   node test/fidelity/run.js                         every PDF in test/fidelity/out/pdf
//   node test/fidelity/run.js C:\path\a.pdf C:\dir    your own files or folders
//   node test/fidelity/run.js --roundtrip             also docx -> pdf -> docx and pdf -> docx -> pdf
//   node test/fidelity/run.js --min 0.9               exit 1 when any file scores below 0.9
//   node test/fidelity/run.js --word C:\dir            print with Microsoft Word instead (pages, recall, order, visual)
//   node test/fidelity/run.js --out C:\scratch         keep the results somewhere else than test/fidelity/out
//
// Needs the optional engines (LibreOffice, or Word with --word, and the PDF engine). LibreOffice lays pages out
// differently from Word, so treat its numbers as a proxy; --word shows what a Word user sees. Results: report.json
// and side-by-side page images in the out folder.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const convert = require('../../src/features/conversion');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(value('--out', path.join(__dirname, 'out')));
const inputs = args.filter((a, i) => !a.startsWith('--') && !['--min', '--out'].includes(args[i - 1]));
const WORD_LIMIT_MS = 120000;

const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => (v == null ? '  -  ' : (v * 100).toFixed(1).padStart(5));

function listPdfs() {
  const roots = inputs.length ? inputs : [path.join(OUT, 'pdf')];
  return roots.flatMap((r) => {
    if (!fs.existsSync(r)) return [];
    return fs.statSync(r).isDirectory() ? fs.readdirSync(r).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(r, f)) : [r];
  });
}

// Printed into its own folder: the PDF it prints has the same file name as the PDF being converted.
function renderDocx(soffice, docx, dir) {
  const profile = 'file:///' + path.join(OUT, 'lo_profile').replace(/\\/g, '/');
  const outDir = path.join(dir, 'rendered');
  fs.mkdirSync(outDir, { recursive: true });
  spawnSync(soffice, ['--headless', '--norestore', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', outDir, docx], { windowsHide: true, timeout: 180000 });
  const pdf = path.join(outDir, path.basename(docx).replace(/\.docx$/i, '.pdf'));
  return fs.existsSync(pdf) ? pdf : null;
}

function wordInstalled() {
  return spawnSync('reg', ['query', 'HKCR\\Word.Application\\CLSID'], { windowsHide: true }).status === 0;
}

// Each file gets its own Word, so one that hangs costs that file only. The script reports the process id of the
// Word it started; that is the only process killed on a timeout.
function printWithWord(docx, dir) {
  const outDir = path.join(dir, 'rendered');
  fs.mkdirSync(outDir, { recursive: true });
  const pdf = path.join(outDir, path.basename(docx).replace(/\.docx$/i, '.pdf'));
  fs.rmSync(pdf, { force: true });
  const script = path.join(__dirname, 'word-print.ps1');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Docx', docx, '-Pdf', pdf], { encoding: 'utf8', windowsHide: true, timeout: WORD_LIMIT_MS });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    const pid = /WORD_PID (\d+)/.exec(r.stdout || '');
    if (pid) spawnSync('taskkill', ['/PID', pid[1], '/F', '/FI', 'IMAGENAME eq WINWORD.EXE'], { windowsHide: true });
    throw new Error(`Word took longer than ${WORD_LIMIT_MS / 1000} s` + (pid ? ' and was stopped' : ' before it reported its process id, so check Task Manager for a Word of the script\'s that is still running'));
  }
  if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error(`Word could not print it: ${(r.stderr || r.stdout || 'no output').trim().split('\n').pop()}`);
  return pdf;
}

function compareScript(python, scriptArgs) {
  const r = spawnSync(python, ['-W', 'ignore', path.join(__dirname, 'compare.py'), ...scriptArgs], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'compare failed').split('\n').filter(Boolean).slice(-2).join(' '));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const compare = (python, original, rendered, tag, docx) => compareScript(python, [original, rendered, path.join(OUT, 'png'), tag, ...(docx ? [docx] : [])]);

(async () => {
  const word = flag('--word');
  const engines = convert.detectEngines();
  if (!engines.pdf || (!word && !engines.soffice)) {
    console.error(`The fidelity harness needs ${word ? 'the PDF engine' : 'LibreOffice and the PDF engine'} (Settings > Advanced > Conversion engines).`);
    process.exit(2);
  }
  if (word && !wordInstalled()) { console.log('skip: Microsoft Word is not installed'); return; }
  const pdfs = listPdfs();
  if (!pdfs.length) { console.error('No PDFs found. Run: npx electron test/fidelity/make-samples.js'); process.exit(2); }
  const work = path.join(OUT, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const report = {};
  const rows = [];
  for (const pdf of pdfs) {
    const name = path.basename(pdf, '.pdf');
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, path.basename(pdf));
    fs.copyFileSync(pdf, src);
    const t0 = Date.now();
    let docx;
    try { [docx] = await convert.convertFile(src, 'docx'); } catch (e) { rows.push(`${pad(name, 16)} CONVERSION FAILED: ${e.message}`); report[name] = { error: e.message }; continue; }
    const seconds = (Date.now() - t0) / 1000;
    let xml = null;
    if (word) {
      try { xml = compareScript(engines.pdf, ['--docx-words', src, docx]); } catch (e) { xml = { recall: null, missing: [], error: e.message }; }
    }
    let rendered;
    try { rendered = word ? printWithWord(docx, dir) : renderDocx(engines.soffice, docx, dir); } catch (e) { rows.push(`${pad(name, 16)} ${e.message}  xml ${pct(xml && xml.recall)}`); report[name] = { error: e.message, docx_words: xml }; continue; }
    if (!rendered) { rows.push(`${pad(name, 16)} could not render ${path.basename(docx)}`); continue; }
    try {
      const m = compare(engines.pdf, src, rendered, name, word && docx);
      m.seconds = +seconds.toFixed(1);
      if (xml) m.docx_words = xml;
      report[name] = m;
      const t = m.text;
      if (word) {
        const c = m.check;
        rows.push(`${pad(name, 16)} pages ${m.pages.join('/')}  size ${c.size_ok}/${m.pages[0]}  recall ${pct(c.recall)}  order ${pct(c.order)}  visual ${pct(c.visual)}  xml ${pct(xml.recall)}  tb ${pct(xml.tb)}  tables ${xml.tables}  headings ${xml.headings}  exact ${xml.exact}  hidden ${xml.hidden}  ${m.seconds}s`);
        if (xml.hidden) rows.push(`${pad('', 16)} hidden: ${xml.hidden_words.slice(0, 12).join(' ').slice(0, 150)}`);
        if (xml.missing.length) rows.push(`${pad('', 16)} not in the document: ${xml.missing.slice(0, 6).join(' | ').slice(0, 150)}`);
        continue;
      }
      rows.push(`${pad(name, 16)} ${pct(m.score)}  text ${pct(t.text)}  pos<=4pt ${pct(t.pos_4pt)}  family ${pct(t.font_family)}  size ${pct(t.font_size)}  b/i ${pct((t.bold + t.italic) / 2)}  colour ${pct(t.colour)}  visual ${pct(m.visual.similarity)}  img ${m.images.count.join('/')} ${pct(m.images.placement_iou)}  links ${m.links.count.join('/')}  pages ${m.pages.join('/')}  ${m.seconds}s`);
      if (t.missing.length) rows.push(`${pad('', 16)} missing: ${t.missing.slice(0, 4).join(' | ').slice(0, 150)}`);
    } catch (e) { rows.push(`${pad(name, 16)} compare failed: ${e.message}`); report[name] = { error: e.message }; }

    if (flag('--roundtrip') && docx) {
      // docx -> pdf (LibreOffice) -> docx again
      const rt = path.join(dir, 'rt'); fs.mkdirSync(rt, { recursive: true });
      const d2 = path.join(rt, `${name}.docx`); fs.copyFileSync(docx, d2);
      try {
        const [p2] = await convert.convertFile(d2, 'pdf');
        const [d3] = await convert.convertFile(p2, 'docx');
        const r3 = renderDocx(engines.soffice, d3, rt);
        const m = compare(engines.pdf, src, r3, `${name}_roundtrip`);
        report[`${name}:roundtrip`] = m;
        rows.push(`${pad('  round trip', 16)} ${pct(m.score)}  text ${pct(m.text.text)}  pos<=4pt ${pct(m.text.pos_4pt)}  visual ${pct(m.visual.similarity)}`);
      } catch (e) { rows.push(`${pad('  round trip', 16)} failed: ${e.message}`); }
    }
  }

  console.log(`\n${pad('sample', 16)} score`);
  console.log(rows.join('\n'));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const scores = Object.entries(report).filter(([k, v]) => !k.includes(':') && v.score != null).map(([, v]) => v.score);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  console.log(`\nmean score ${pct(mean)}  (${scores.length} files)`);
  const min = parseFloat(value('--min', '0'));
  if (min && scores.some((s) => s < min)) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
