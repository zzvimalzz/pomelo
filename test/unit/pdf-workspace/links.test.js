// SPDX-License-Identifier: AGPL-3.0-or-later
// Which addresses a link in a PDF may open: web pages and mail addresses only, as the URL parser reads them.
//   node test/unit/pdf-workspace/links.test.js
const { linkTarget } = require('../../../src/features/pdf-workspace/links');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

console.log('addresses that may be opened');
expect('a web page is opened as it is', linkTarget('https://example.com/a?b=1#c') === 'https://example.com/a?b=1#c');
expect('http is allowed', linkTarget('http://example.com/') === 'http://example.com/');
expect('a mail address is allowed with its subject', linkTarget('mailto:a@example.com?subject=Hi') === 'mailto:a@example.com?subject=Hi');
expect('the address is what the parser reads: the scheme and host are lower case, a bare host gets its slash', linkTarget('HTTPS://Example.COM') === 'https://example.com/');
expect('a host written in another alphabet is shown in the form the browser will use', linkTarget('https://\u0430pple.com/') === 'https://xn--pple-43d.com/');
expect('a quote and a space are escaped, so nothing can end the address early', linkTarget('https://example.com/a b"c') === 'https://example.com/a%20b%22c');
expect('a name and password in the address are kept, so the card can show them', linkTarget('https://user:secret@example.com/') === 'https://user:secret@example.com/');
expect('leading spaces and a line break inside the scheme do not hide it', linkTarget('  https://example.com/') === 'https://example.com/' && linkTarget('ht\ntps://example.com/') === 'https://example.com/');

console.log('addresses that do nothing');
const refused = ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'blob:https://example.com/x', 'ftp://example.com/', 'tel:+60123456789',
  'ms-msdt:/id PCWDiagnostic', 'vbscript:msgbox(1)', 'about:blank', 'cmd.exe', 'C:\\Windows\\System32\\calc.exe', '\\\\server\\share\\a.exe', '//example.com/x', '/relative/path', 'example.com', '', 'https://', 'http://exa mple.com/'];
for (const url of refused) expect(`${JSON.stringify(url)} is refused`, linkTarget(url) === null, String(linkTarget(url)));
expect('anything that is not text is refused', [undefined, null, 5, {}, [], ['https://example.com/'], { href: 'https://example.com/' }, true].every((v) => linkTarget(v) === null));
expect('an address over 8 192 characters is refused', linkTarget(`https://example.com/${'a'.repeat(8192)}`) === null && linkTarget(`https://example.com/${'a'.repeat(8000)}`) !== null);

finish();
