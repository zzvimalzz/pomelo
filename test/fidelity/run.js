// SPDX-License-Identifier: AGPL-3.0-or-later
// Fidelity harness for PDF -> DOCX (and the round trips). Converts PDFs with Pomelo's real converter, prints the
// DOCX back to PDF with LibreOffice, and compares the two PDFs (text, positions, fonts, images, links, shapes).
//
//   npx electron test/fidelity/make-samples.js        once, draws the sample PDFs
//   node test/fidelity/run.js                         every PDF in test/fidelity/out/pdf
//   node test/fidelity/run.js C:\path\a.pdf C:\dir    your own files or folders
//   node test/fidelity/run.js --roundtrip             also docx -> pdf -> docx and pdf -> docx -> pdf
//   node test/fidelity/run.js --min 0.9               exit 1 when any file scores below 0.9
//
// Needs the optional engines (LibreOffice and the PDF engine). Pages are rendered by LibreOffice, not Word, so
// treat the numbers as a faithful proxy rather than a promise about Word. Results: test/fidelity/out/report.json
// and side-by-side page images in test/fidelity/out/png/.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const convert = require('../../src/main/convert');

const OUT = path.join(__dirname, 'out');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--min');

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

function compare(python, original, rendered, tag) {
  const script = path.join(__dirname, 'compare.py');
  const r = spawnSync(python, ['-W', 'ignore', script, original, rendered, path.join(OUT, 'png'), tag], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'compare failed').split('\n').filter(Boolean).slice(-2).join(' '));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

(async () => {
  const engines = convert.detectEngines();
  if (!engines.soffice || !engines.pdf) {
    console.error('The fidelity harness needs LibreOffice and the PDF engine (Settings > Advanced > Conversion engines).');
    process.exit(2);
  }
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
    const rendered = renderDocx(engines.soffice, docx, dir);
    if (!rendered) { rows.push(`${pad(name, 16)} could not render ${path.basename(docx)}`); continue; }
    try {
      const m = compare(engines.pdf, src, rendered, name);
      m.seconds = +seconds.toFixed(1);
      report[name] = m;
      const t = m.text;
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
