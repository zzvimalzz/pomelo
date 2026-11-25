// SPDX-License-Identifier: AGPL-3.0-or-later
// Built-in converters for images (sharp): PNG, JPG, WebP, AVIF, TIFF, BMP, GIF, SVG and HEIC to each other and to PDF.
// BMP is read through Electron's nativeImage, which is why this file may require electron.
const fs = require('fs');
const { uniquePath } = require('../../engine-kit/outputs');
const { extsInGroup, extOf } = require('../../catalog/formats');
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

const QUALITY = { jpg: 92, webp: 90, avif: 60 };

// The one place that turns a picture into a file of each format. mozjpeg is 15 % smaller and about fifteen times slower than plain
// libjpeg, so only the converter uses it.
async function encode(img, to, out, { quality = QUALITY[to], mozjpeg = true } = {}) {
  if (to === 'bmp') fs.writeFileSync(out, await toBmp(img));
  else if (to === 'jpg') await img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg }).toFile(out);
  else if (to === 'png') await img.png().toFile(out);
  else if (to === 'webp') await img.webp({ quality }).toFile(out);
  else if (to === 'avif') await img.avif({ quality }).toFile(out);
  else if (to === 'tiff') await img.tiff({ compression: 'lzw' }).toFile(out);
  else if (to === 'gif') await img.gif({ effort: 7 }).toFile(out);
}

async function run({ src, from, to, dir, base }) {
  const moving = (from === 'gif' || from === 'webp') && (to === 'gif' || to === 'webp');   // keep every frame; other targets take the first
  const img = await sharpInput(src, from, moving);
  const out = uniquePath(dir, base, to);
  if (to === 'pdf') await imageToPdf(img, out);
  else await encode(img, to, out);
  return [out];
}

// A picture for the image editor: upright (EXIF orientation applied), sRGB, 8 bits a channel with an alpha channel. It refuses an
// animated picture and one over the limits before any pixel is decoded.
async function readImage(src, { maxPixels, maxEdge }) {
  const img = await sharpInput(src, extOf(src));
  const { width, height, pages = 1, hasAlpha } = await img.metadata();
  if (pages > 1) throw Object.assign(new Error('animated image'), { code: 'ANIMATED' });
  if (width * height > maxPixels || Math.max(width, height) > maxEdge) throw Object.assign(new Error('image too large'), { code: 'TOO_LARGE' });
  const { data, info } = await img.rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, hasAlpha };
}

const EXIF_FORMATS = ['jpg', 'png', 'webp', 'avif'];

// Writes the editor's RGBA pixels (width x height, straight alpha) as `to`, scaled so the long edge is `longEdge` when that is smaller.
// When `metadataFrom` is a picture that can carry EXIF the tags are copied from it and the orientation is set upright: the pixels go
// over an 8 x 8 corner of the original, which keeps the original's metadata without decoding all of it.
async function writeImage(rgba, out, to, { width, height, quality, longEdge, metadataFrom }) {
  const sharp = require('sharp');
  let pixels = rgba;
  let raw = { width, height, channels: 4 };
  if (longEdge && longEdge < Math.max(width, height)) {
    const k = longEdge / Math.max(width, height);
    raw = { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), channels: 4 };
    pixels = await sharp(rgba, { raw: { width, height, channels: 4 } }).resize(raw.width, raw.height, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
  }
  let img = sharp(pixels, { raw });
  if (metadataFrom && EXIF_FORMATS.includes(extOf(metadataFrom)) && EXIF_FORMATS.includes(to)) {
    if (to === 'jpg') {   // sharp flattens before it composites, so an alpha channel here would reach the JPEG encoder unflattened
      const flat = await img.flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
      pixels = flat.data;
      raw = { ...raw, channels: flat.info.channels };
    }
    const { width: sw, height: sh } = await sharp(metadataFrom).metadata();
    img = sharp(metadataFrom).extract({ left: 0, top: 0, width: Math.min(8, sw), height: Math.min(8, sh) })
      .resize(raw.width, raw.height, { fit: 'fill', kernel: 'nearest' }).ensureAlpha()
      .composite([{ input: pixels, raw, blend: 'source' }]).keepExif().withMetadata({ orientation: 1 });
  }
  await encode(img, to, out, { quality, mozjpeg: false });
}

const IMG_FROM = extsInGroup('image');
const IMG_TO = ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'pdf'];

module.exports = { reads: (from) => IMG_FROM.includes(from), writes: () => IMG_TO, run, readImage, writeImage, QUALITY };
