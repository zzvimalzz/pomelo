// SPDX-License-Identifier: AGPL-3.0-or-later
// EPUB reading and writing without external tools (JSZip). Pandoc is preferred when installed; this is the fallback.
const path = require('path');
const JSZip = require('jszip');
const { escapeHtml: esc } = require('../../shared/core/text');

const attr = (tag, name) => { const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag); return m ? m[1] : null; };
const bodyOf = (html) => { const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html); return m ? m[1] : html; };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

// ---- read ---------------------------------------------------------------------------------------
// -> { title, body }: the book's chapters in reading order as one HTML body, images inlined as data: URIs.
async function read(file) {
  const zip = await JSZip.loadAsync(require('fs').readFileSync(file));
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('Not a valid EPUB (no container.xml)');
  const opfPath = attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] || '', 'full-path');
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) throw new Error('Not a valid EPUB (package document missing)');
  const baseDir = path.posix.dirname(opfPath);
  const resolve = (href) => path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, decodeURI(href.split('#')[0])));

  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) manifest[attr(m[0], 'id')] = { href: attr(m[0], 'href'), type: attr(m[0], 'media-type') };
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map((m) => manifest[attr(m[0], 'idref')]).filter(Boolean);
  const title = (/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] || 'Untitled').replace(/<[^>]+>/g, '').trim();

  let body = '';
  for (const item of spine) {
    if (!/x?html/.test(item.type || '')) continue;
    const chapterPath = resolve(item.href);
    let html = await zip.file(chapterPath)?.async('string');
    if (!html) continue;
    html = bodyOf(html);
    const chapterDir = path.posix.dirname(chapterPath);
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
    for (const img of imgs) {
      const src = attr(img[0], 'src');
      if (!src || /^(data:|https?:)/i.test(src)) continue;
      const entry = zip.file(path.posix.normalize(path.posix.join(chapterDir, decodeURI(src))));
      if (!entry) continue;
      const ext = path.posix.extname(src).slice(1).toLowerCase();
      html = html.replace(img[0], img[0].replace(src, `data:${MIME[ext] || 'image/png'};base64,${await entry.async('base64')}`));
    }
    body += html + '\n';
  }
  if (!body.trim()) throw new Error('This EPUB has no readable chapters');
  return { title, body };
}

// ---- write --------------------------------------------------------------------------------------
// Make an HTML fragment valid XHTML (void elements closed, entities numeric) and pull data: images out into files.
function tidy(fragment, images) {
  let html = fragment
    .replace(/<br\s*>/gi, '<br/>').replace(/<hr\s*>/gi, '<hr/>').replace(/&nbsp;/g, '&#160;')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    let t = tag.replace(/\s*\/?>$/, '');
    const m = /src\s*=\s*["']data:image\/(\w+);base64,([^"']+)["']/i.exec(t);
    if (m) {
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const name = `images/img${images.length + 1}.${ext}`;
      images.push({ name, ext, data: m[2] });
      t = t.replace(m[0], `src="${name}"`);
    }
    if (!/\balt\s*=/i.test(t)) t += ' alt=""';
    return t + '/>';
  });
  return html;
}

const xhtml = (title, inner) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${inner}</body></html>`;

const CSS = 'body{font-family:serif;line-height:1.5;margin:1em}h1,h2,h3{font-family:sans-serif;line-height:1.2}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #999;padding:.2em .4em}pre{white-space:pre-wrap}';

// html: a full document or fragment. Chapters start at each <h1> when there are several.
async function write(html, { title, author = 'Unknown' }, out) {
  const images = [];
  const body = tidy(bodyOf(html), images);
  const parts = body.split(/(?=<h1[\s>])/i).filter((p) => p.trim());
  const chapters = (parts.length > 1 ? parts : [body]).map((inner, i) => ({
    id: `c${i + 1}`, file: `chapter${i + 1}.xhtml`, inner,
    title: (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(inner)?.[1] || (i === 0 ? title : `Part ${i + 1}`)).replace(/<[^>]+>/g, '').trim() || title,
  }));

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/style.css', CSS);
  chapters.forEach((c) => zip.file(`OEBPS/${c.file}`, xhtml(c.title, c.inner)));
  images.forEach((im) => zip.file(`OEBPS/${im.name}`, im.data, { base64: true }));
  zip.file('OEBPS/nav.xhtml', xhtml(title, `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li><a href="${c.file}">${esc(c.title)}</a></li>`).join('')}</ol></nav>`).replace('<nav ', '<nav xmlns:epub="http://www.idpf.org/2007/ops" '));
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:pomelo:${esc(title)}"/></head><docTitle><text>${esc(title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join('')}</navMap></ncx>`);
  const imageItems = images.map((im, i) => `<item id="img${i + 1}" href="${im.name}" media-type="${MIME[im.ext] || 'image/png'}"/>`).join('');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:pomelo:${Date.now()}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${chapters.map((c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('')}${imageItems}</manifest><spine toc="ncx">${chapters.map((c) => `<itemref idref="${c.id}"/>`).join('')}</spine></package>`);
  require('fs').writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

module.exports = { read, write };
