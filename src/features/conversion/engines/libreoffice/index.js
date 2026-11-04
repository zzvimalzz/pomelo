// SPDX-License-Identifier: AGPL-3.0-or-later
// LibreOffice (MPL-2.0), used when installed (or shipped alongside the app): high-fidelity Office and OpenDocument conversion,
// run headless as a separate process.
const fs = require('fs');
const path = require('path');
const { OFFICE } = require('../../catalog/formats');
const { uniquePath } = require('../../engine-kit/outputs');
const { run } = require('../../engine-kit/run');
const { acquireProfile, releaseProfile, profileUrl } = require('./profiles');
const { withTempDir } = require('../../../../shared/node/fs');
const { findExe } = require('../../../../shared/node/which');

const SO_TO = { doc: ['pdf', 'docx', 'doc', 'rtf', 'odt'], sheet: ['xlsx', 'xls', 'ods', 'pdf'], slide: ['pptx', 'ppt', 'pdf'] };
const SO_FILTER = { docx: 'docx:MS Word 2007 XML', doc: 'doc:MS Word 97', rtf: 'rtf:Rich Text Format', odt: 'odt:writer8',
  xlsx: 'xlsx:Calc MS Excel 2007 XML', xls: 'xls:MS Excel 97', ods: 'ods:calc8',
  pptx: 'pptx:Impress MS PowerPoint 2007 XML', ppt: 'ppt:MS PowerPoint 97', pdf: 'pdf' };

const soGroup = (from) => Object.keys(OFFICE).find((g) => OFFICE[g].includes(from));

module.exports = {
  name: 'libreoffice',
  detect: () => ({ soffice: findExe('soffice.exe', ['LibreOffice/program', 'libreoffice/program']) }),
  supports(from, to, engines) {
    if (!engines.soffice || from === to) return false;
    if (from === 'pdf') return to === 'pptx';                  // PDF opens in Impress as editable slides (text boxes)
    const g = soGroup(from);
    return !!g && SO_TO[g].includes(to);
  },
  async run({ src, from, to, dir, base, engines }) {
    const slot = await acquireProfile();
    try {
      return await withTempDir(async (work) => {
        const importFilter = from === 'pdf' ? ['--infilter=impress_pdf_import'] : [];
        await run(engines.soffice, [`-env:UserInstallation=${profileUrl(slot)}`, '--headless', '--norestore', ...importFilter, '--convert-to', SO_FILTER[to], '--outdir', work, src], { timeout: 300000 });
        const made = fs.readdirSync(work).find((f) => f.toLowerCase().endsWith('.' + to));
        if (!made) throw new Error('LibreOffice produced no output');
        const out = uniquePath(dir, base, to);
        fs.copyFileSync(path.join(work, made), out);
        return [out];
      });
    } finally { releaseProfile(slot); }
  },
};
