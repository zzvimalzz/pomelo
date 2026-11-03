// SPDX-License-Identifier: AGPL-3.0-or-later
// How well does a PDF survive conversion into every other format?   node test/fidelity/formats.js [pdf|dir ...] [--to md,html,...]
//   txt md html epub xlsx : words kept (recall), words invented (precision), order, links, headings, lists, tables
//   png jpg               : one image per page, at the right size, looking like the page
//   pptx doc rtf odt      : printed back to PDF with LibreOffice and compared like the Word output (run.js)
// Needs the optional engines. Results: test/fidelity/out/formats.json
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const convert = require('../../src/main/convert');

const OUT = path.join(__dirname, 'out');
const args = process.argv.slice(2);
const toArg = args.indexOf('--to');
const TARGETS = toArg >= 0 ? args[toArg + 1].split(',') : ['txt', 'md', 'html', 'epub', 'xlsx', 'png', 'jpg', 'pptx', 'doc', 'rtf', 'odt'];
const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--to');
const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => (v == null ? '  -  ' : (v * 100).toFixed(0).padStart(4) + '%');

function pdfs() {
  const roots = inputs.length ? inputs : [path.join(OUT, 'pdf')];
  return roots.flatMap((r) => (fs.existsSync(r) ? (fs.statSync(r).isDirectory() ? fs.readdirSync(r).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(r, f)) : [r]) : []));
}

const py = (engines, script, ...a) => {
  const r = spawnSync(engines.pdf, ['-W', 'ignore', path.join(__dirname, script), ...a], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'failed').split('\n').filter(Boolean).slice(-1)[0]);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

function renderToPdf(soffice, file, dir) {
  const profile = 'file:///' + path.join(OUT, 'lo_profile').replace(/\\/g, '/');
  const outDir = path.join(dir, 'rendered');
  fs.mkdirSync(outDir, { recursive: true });
  spawnSync(soffice, ['--headless', '--norestore', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', outDir, file], { windowsHide: true, timeout: 240000 });
  const pdf = path.join(outDir, path.basename(file).replace(/\.[^.]+$/, '.pdf'));
  return fs.existsSync(pdf) ? pdf : null;
}

(async () => {
  const engines = convert.detectEngines();
  if (!engines.pdf) { console.error('Needs the PDF engine.'); process.exit(2); }
  const work = path.join(OUT, 'work-formats');
  fs.rmSync(work, { recursive: true, force: true });
  const report = {};
  for (const pdf of pdfs()) {
    const name = path.basename(pdf, '.pdf');
    console.log(`\n${name}`);
    report[name] = {};
    for (const to of TARGETS) {
      const dir = path.join(work, name, to);
      fs.mkdirSync(dir, { recursive: true });
      const src = path.join(dir, `${name}.pdf`);
      fs.copyFileSync(pdf, src);
      const t0 = Date.now();
      let line;
      try {
        const outs = await convert.convertFile(src, to);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        let m;
        if (['pptx', 'doc', 'rtf', 'odt'].includes(to)) {
          const rendered = engines.soffice && renderToPdf(engines.soffice, outs[0], dir);
          if (!rendered) throw new Error('could not be opened by LibreOffice');
          const r = spawnSync(engines.pdf, ['-W', 'ignore', path.join(__dirname, 'compare.py'), src, rendered], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
          m = JSON.parse(r.stdout.trim().split('\n').pop());
          line = `score ${pct(m.score)}  text ${pct(m.text.text)}  pos ${pct(m.text.pos_4pt)}  family ${pct(m.text.font_family)}  visual ${pct(m.visual.similarity)}  links ${m.links.count.join('/')}  pages ${m.pages.join('/')}`;
          if (m.text.missing.length) line += `\n${pad('', 19)}missing: ${m.text.missing.slice(0, 3).join(' | ').slice(0, 120)}`;
        } else {
          const target = outs.length > 1 ? path.dirname(outs[0]) : outs[0];     // several page images land in one folder
          m = py(engines, 'eval_format.py', to, src, target);
          if (to === 'png' || to === 'jpg') line = `files ${m.files}/${m.pages_expected}  look ${pct(m.look)}  ${m.first_size_px && m.first_size_px.join('x')}px for a ${m.page_size_pt.join('x')}pt page`;
          else {
            line = `recall ${pct(m.recall)}  precision ${pct(m.precision)}  order ${pct(m.order)}`;
            if (m.links) line += `  links ${m.links.out}/${m.pdf_links}`;
            if (m.structure) line += `  headings ${m.structure.headings}/${m.pdf_headings}  lists ${m.structure.list_items}/${m.pdf_bullets}  tables ${m.structure.tables}/${m.pdf_tables}`;
            if (m.table_cells) line += `  table cells ${m.table_cells.found ?? '-'}/${m.table_cells.pdf} sheets ${m.sheets}`;
            if (m.missing && m.missing.length && m.recall < 0.97) line += `\n${pad('', 19)}missing: ${m.missing.slice(0, 8).join(' ')}`;
          }
        }
        m.seconds = +secs;
        report[name][to] = m;
        line += `  ${secs}s`;
      } catch (e) {
        line = `FAILED: ${e.message.slice(0, 140)}`;
        report[name][to] = { error: e.message };
      }
      console.log(`  ${pad(to, 5)} ${line}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'formats.json'), JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
