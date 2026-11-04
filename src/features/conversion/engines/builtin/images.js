// SPDX-License-Identifier: AGPL-3.0-or-later
// Built-in converters for images (sharp): PNG, JPG, WebP, AVIF, TIFF, BMP, GIF, SVG and HEIC to each other and to PDF.
// BMP is read through Electron's nativeImage, which is why this file may require electron.
const fs = require('fs');
const { uniquePath } = require('../../engine-kit/outputs');
const { extsInGroup } = require('../../catalog/formats');
const { sharpFrom } = require('../../lib/image-input');

async function sharpInput(src, from, animated = false) {
  const sharp = require('sharp');
  if (from === 'bmp') {   // libvips has no BMP reader; Chromium does
    const img = require('electron').nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('Could not read this BMP');
    return sharp(img.toPNG());
  }
  if (from === 'heic') {  // WASM libheif decoder
    const png = await require('heic-convert')({ buffer: fs.readFileSync(src), format: 'PNG' });
    return sharp(Buffer.from(png));
  }
  return sharpFrom(src, from, { animated });
}

async function toBmp(img) {
  const { data, info } = await img.flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rowSize = Math.ceil((info.width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * info.height);
  buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(info.width, 18); buf.writeInt32LE(info.height, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(rowSize * info.height, 34);
  for (let y = 0; y < info.height; y++) {
    const rowStart = 54 + (info.height - 1 - y) * rowSize;
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 3;
      buf[rowStart + x * 3] = data[s + 2]; buf[rowStart + x * 3 + 1] = data[s + 1]; buf[rowStart + x * 3 + 2] = data[s];
    }
  }
  return buf;
}

async function imageToPdf(img, out) {
  const { PDFDocument } = require('pdf-lib');
  const png = await img.png().toBuffer({ resolveWithObject: true });
  const doc = await PDFDocument.create();
  const embedded = await doc.embedPng(png.data);
  const k = Math.min(0.75, 842 / Math.max(png.info.width, png.info.height));   // px -> pt, capped to ~A4
  const page = doc.addPage([png.info.width * k, png.info.height * k]);
  page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  fs.writeFileSync(out, await doc.save());
}

async function run({ src, from, to, dir, base }) {
  const moving = (from === 'gif' || from === 'webp') && (to === 'gif' || to === 'webp');   // keep every frame; other targets take the first
  const img = await sharpInput(src, from, moving);
  const out = uniquePath(dir, base, to);
  if (to === 'bmp') fs.writeFileSync(out, await toBmp(img));
  else if (to === 'pdf') await imageToPdf(img, out);
  else if (to === 'jpg') await img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toFile(out);
  else if (to === 'png') await img.png().toFile(out);
  else if (to === 'webp') await img.webp({ quality: 90 }).toFile(out);
  else if (to === 'avif') await img.avif({ quality: 60 }).toFile(out);
  else if (to === 'tiff') await img.tiff({ compression: 'lzw' }).toFile(out);
  else if (to === 'gif') await img.gif({ effort: 7 }).toFile(out);
  return [out];
}

const IMG_FROM = extsInGroup('image');
const IMG_TO = ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'pdf'];

module.exports = { reads: (from) => IMG_FROM.includes(from), writes: () => IMG_TO, run };
