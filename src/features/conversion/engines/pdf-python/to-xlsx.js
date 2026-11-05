// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF to Excel through the Python helper: the tables it finds, or the text as rows, one sheet each.
const fs = require('fs');
const { uniquePath } = require('../../engine-kit/outputs');
const { runHelper } = require('../../engine-kit/python');
const { withTempFile } = require('#shared/node/fs');

const isNumber = (s) => /^-?(0|[1-9]\d{0,14})([.,]\d+)?$/.test(s);

async function pdfToXlsx({ src, dir, base, engines, onProgress }) {
  const XLSX = require('xlsx');
  return withTempFile('json', async (tmp) => {
    await runHelper(engines.pdf, 'pdf_to_tables.py', [src, tmp], { src, onProgress });
    const tables = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (!tables.length) throw new Error('This PDF has no text to put in a spreadsheet');
    const wb = XLSX.utils.book_new();
    for (const t of tables) {
      const rows = t.rows.map((r) => r.map((c) => (isNumber(c) ? Number(c.replace(',', '.')) : c)));
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet['!cols'] = Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) => ({ wch: Math.min(60, Math.max(8, ...rows.map((r) => String(r[i] ?? '').length)) + 2) }));
      XLSX.utils.book_append_sheet(wb, sheet, t.kind === 'text' ? `P${t.page} text` : `P${t.page} T${t.index}`);
    }
    const out = uniquePath(dir, base, 'xlsx');
    fs.writeFileSync(out, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    return [out];
  });
}

module.exports = { pdfToXlsx };
