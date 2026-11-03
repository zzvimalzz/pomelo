// SPDX-License-Identifier: AGPL-3.0-or-later
// Open-source command-line engines, used when installed (or shipped alongside the app):
//   LibreOffice (MPL-2.0) - high-fidelity Office/OpenDocument conversion, headless
//   Pandoc (GPL-2.0)      - document markup conversion, run as a separate process
const fs = require('fs');
const path = require('path');
const { run, tempPath, uniquePath } = require('../convert/util');

// ---- LibreOffice ----------------------------------------------------------------------------
const SO_FROM = { doc: ['docx', 'doc', 'rtf', 'odt'], sheet: ['xlsx', 'xls', 'ods'], slide: ['pptx', 'ppt'] };
const SO_TO = { doc: ['pdf', 'docx', 'doc', 'rtf', 'odt'], sheet: ['xlsx', 'xls', 'ods', 'pdf'], slide: ['pptx', 'ppt', 'pdf'] };
const SO_FILTER = { docx: 'docx:MS Word 2007 XML', doc: 'doc:MS Word 97', rtf: 'rtf:Rich Text Format', odt: 'odt:writer8',
  xlsx: 'xlsx:Calc MS Excel 2007 XML', xls: 'xls:MS Excel 97', ods: 'ods:calc8',
  pptx: 'pptx:Impress MS PowerPoint 2007 XML', ppt: 'ppt:MS PowerPoint 97', pdf: 'pdf' };
const soGroup = (from) => Object.keys(SO_FROM).find((g) => SO_FROM[g].includes(from));

const soffice = {
  name: 'libreoffice',
  supports(from, to, engines) {
    if (!engines.soffice || from === to) return false;
    if (from === 'pdf') return to === 'pptx';                  // PDF opens in Impress as editable slides (text boxes)
    const g = soGroup(from);
    return !!g && SO_TO[g].includes(to);
  },
  async run({ src, from, to, dir, base, engines }) {
    const work = tempPath('d');
    fs.mkdirSync(work);
    try {
      // A private profile dir avoids clashing with a LibreOffice the user already has open.
      const profile = 'file:///' + path.join(work, 'profile').split(path.sep).join('/');
      const importFilter = from === 'pdf' ? ['--infilter=impress_pdf_import'] : [];
      await run(engines.soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', ...importFilter, '--convert-to', SO_FILTER[to], '--outdir', work, src], { timeout: 300000 });
      const made = fs.readdirSync(work).find((f) => f.toLowerCase().endsWith('.' + to));
      if (!made) throw new Error('LibreOffice produced no output');
      const out = uniquePath(dir, base, to);
      fs.copyFileSync(path.join(work, made), out);
      return [out];
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  },
};

// ---- Pandoc ---------------------------------------------------------------------------------
const PD_READ = { docx: 'docx', odt: 'odt', rtf: 'rtf', md: 'markdown', html: 'html', epub: 'epub' };
const PD_WRITE = { docx: ['docx'], odt: ['odt'], rtf: ['rtf', '-s'], md: ['gfm', '--wrap=none'], html: ['html5', '--embed-resources', '--standalone'], txt: ['plain', '--wrap=none'], epub: ['epub3'] };

const pandoc = {
  name: 'pandoc',
  supports: (from, to, engines) => !!engines.pandoc && from !== to && !!PD_READ[from] && !!PD_WRITE[to],
  async run({ src, from, to, dir, base, engines }) {
    const [fmt, ...flags] = PD_WRITE[to];
    const out = uniquePath(dir, base, to);
    // Pandoc downloads remote images by itself. Point its proxy at a dead port so nothing ever leaves the machine;
    // local images next to the file still work (cwd is the source folder).
    const offline = { http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
    await run(engines.pandoc, ['-f', PD_READ[from], '-t', fmt, ...flags, '-o', out, src], { timeout: 120000, cwd: path.dirname(src), env: offline });
    return [out];
  },
};

module.exports = { soffice, pandoc };
