// SPDX-License-Identifier: AGPL-3.0-or-later
// Built-in converters for spreadsheets: XLSX, XLS, ODS, CSV and TSV (SheetJS) to each other, to JSON, HTML and PDF.
const fs = require('fs');
const { uniquePath } = require('../../engine-kit/outputs');
const { extsInGroup } = require('../../catalog/formats');
const { wrapHtml } = require('../../lib/html');
const { htmlToPdf } = require('../../lib/print-pdf');
const { escapeHtml: esc } = require('../../../../shared/core/text');
const { readText } = require('../../../../shared/node/fs');

const SHEET_EXT = extsInGroup('sheet');

function readWorkbook(src, from) {
  const XLSX = require('xlsx');
  if (from === 'xlsx' || from === 'ods') {         // both are ZIP packages; anything else is a renamed file, not a workbook
    const head = Buffer.alloc(2);
    const fd = fs.openSync(src, 'r');
    try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error(`This is not a valid .${from} file`);
  }
  if (from === 'csv' || from === 'tsv') {
    let t = readText(src);
    const head = t.split('\n', 1)[0];
    const FS = [',', ';', '\t', '|'].map((c) => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    return XLSX.read(t, { type: 'string', FS: from === 'tsv' ? '\t' : FS });
  }
  return XLSX.readFile(src, { cellDates: true });
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'Sheet';

function sheetsToHtml(wb, title) {
  const XLSX = require('xlsx');
  const many = wb.SheetNames.length > 1;
  const css = 'td{font-size:9pt}th,td{white-space:nowrap}h2{break-before:page}h2:first-child{break-before:auto}';
  const body = wb.SheetNames.map((n) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
    const table = `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    return (many ? `<h2>${esc(n)}</h2>` : '') + table;
  }).join('');
  return wrapHtml(body, title, css);
}

async function run({ src, from, to, dir, base }) {
  const XLSX = require('xlsx');
  const wb = readWorkbook(src, from);
  if (to === 'xlsx' || to === 'xls' || to === 'ods') {
    const out = uniquePath(dir, base, to);
    fs.writeFileSync(out, XLSX.write(wb, { bookType: to === 'xls' ? 'biff8' : to, type: 'buffer', cellDates: true }));
    return [out];
  }
  if (to === 'csv' || to === 'tsv') {
    const FS = to === 'tsv' ? '\t' : ',';
    return wb.SheetNames.map((n) => {
      const out = uniquePath(dir, wb.SheetNames.length > 1 ? `${base} - ${safe(n)}` : base, to);
      fs.writeFileSync(out, '\uFEFF' + XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS }), 'utf8');   // BOM: Excel opens UTF-8 correctly
      return out;
    });
  }
  if (to === 'json') {
    const data = Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null })]));
    const out = uniquePath(dir, base, 'json');
    fs.writeFileSync(out, JSON.stringify(wb.SheetNames.length === 1 ? data[wb.SheetNames[0]] : data, null, 2), 'utf8');
    return [out];
  }
  const html = sheetsToHtml(wb, base);
  const out = uniquePath(dir, base, to);
  if (to === 'html') { fs.writeFileSync(out, html, 'utf8'); return [out]; }
  const widest = Math.max(...wb.SheetNames.map((n) => XLSX.utils.decode_range(wb.Sheets[n]['!ref'] || 'A1').e.c + 1));
  await htmlToPdf(html, out, { landscape: widest > 7 });
  return [out];
}

const SHEET_TO = ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'html', 'json', 'pdf'];

module.exports = { reads: (from) => SHEET_EXT.includes(from), writes: () => SHEET_TO, run };
