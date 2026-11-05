// SPDX-License-Identifier: AGPL-3.0-or-later
// Pandoc (GPL-2.0), used when installed (or shipped alongside the app): document markup conversion, run as a separate process.
const path = require('path');
const { uniquePath } = require('../../engine-kit/outputs');
const { run } = require('../../engine-kit/run');
const { findExe } = require('#shared/node/which');

const PD_READ = { docx: 'docx', odt: 'odt', rtf: 'rtf', md: 'markdown', html: 'html', epub: 'epub' };
const PD_WRITE = { docx: ['docx'], odt: ['odt'], rtf: ['rtf', '-s'], md: ['gfm', '--wrap=none'], html: ['html5', '--embed-resources', '--standalone'], txt: ['plain', '--wrap=none'], epub: ['epub3'] };

module.exports = {
  name: 'pandoc',
  detect: () => ({ pandoc: findExe('pandoc.exe', ['Pandoc', 'pandoc', '']) }),
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
