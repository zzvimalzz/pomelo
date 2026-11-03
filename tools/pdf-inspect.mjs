// SPDX-License-Identifier: AGPL-3.0-or-later
// Dev tool: what is inside a PDF?  node tools/pdf-inspect.mjs <file.pdf> [--render outdir]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjs = await import(pathToFileURL(path.join(root, 'legacy', 'build', 'pdf.mjs')).href);
const dir = (p) => p.split(path.sep).join('/') + '/';

const file = process.argv[2];
const renderIdx = process.argv.indexOf('--render');
const task = pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(file)), verbosity: 0,
  standardFontDataUrl: dir(path.join(root, 'standard_fonts')), cMapUrl: dir(path.join(root, 'cmaps')), cMapPacked: true,
});
const doc = await task.promise;
console.log('pages:', doc.numPages, '| info:', JSON.stringify((await doc.getMetadata()).info).slice(0, 240));
const OPS = pdfjs.OPS;
const fonts = new Map();
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const ops = await page.getOperatorList();
  const count = { img: 0, path: 0, link: 0 };
  for (const fn of ops.fnArray) {
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) count.img++;
    if (fn === OPS.constructPath) count.path++;
  }
  count.link = (await page.getAnnotations()).filter((a) => a.subtype === 'Link').length;
  for (const it of tc.items) fonts.set(it.fontName, (fonts.get(it.fontName) || 0) + it.str.length);
  const sizes = new Map();
  for (const i of tc.items) { const s = Math.round(Math.hypot(i.transform[0], i.transform[1]) * 10) / 10; sizes.set(s, (sizes.get(s) || 0) + i.str.length); }
  console.log(`p${n}: ${vp.width}x${vp.height}pt  text=${tc.items.length}  images=${count.img}  paths=${count.path}  links=${count.link}  sizes=${[...sizes].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s}pt(${c})`).join(' ')}`);
  if (n <= 2) console.log('   text:', tc.items.slice(0, 14).map((i) => JSON.stringify(i.str)).join(' '));
  if (renderIdx > 0 && n <= 6) {
    const out = process.argv[renderIdx + 1];
    fs.mkdirSync(out, { recursive: true });
    const v = page.getViewport({ scale: 1.4 });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(v.width), Math.ceil(v.height));
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: v, canvas }).promise;
    fs.writeFileSync(path.join(out, `p${n}.png`), canvas.toBuffer('image/png'));
  }
}
// real font names (what the viewer resolved)
const page1 = await doc.getPage(1);
await page1.getTextContent();
for (const [name, chars] of fonts) {
  let info = '';
  try { const f = page1.commonObjs.has(name) ? page1.commonObjs.get(name) : null; if (f) info = `${f.name} bold=${f.bold} italic=${f.italic} mono=${f.isMonospace} serif=${f.isSerifFont} fallback=${f.fallbackName}`; } catch { /* not on page 1 */ }
  console.log('font', name, chars + ' chars', info);
}
await task.destroy();
