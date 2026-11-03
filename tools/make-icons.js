// SPDX-License-Identifier: AGPL-3.0-or-later
// Draws the Pomelo logo, the tray icon, the Windows .ico and the installer artwork with sharp.   npm run icons
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// The mark: a pomelo cut open, which is also Pomelo's wheel. Eight flat pink segments with an open centre; the one the
// cursor would drop on is green. No gradients or effects, so it stays crisp from 16 px to 512 px and on light or dark.
const PINK = '#e8506f';
const GREEN = '#93a92f';
const CHARCOAL = '#232328';
const SHAPE = { r1: 44, r2: 116, gap: 10, round: 6 };           // inner radius, outer radius, gap between segments, corner radius
const SHAPE_SMALL = { r1: 40, r2: 118, gap: 15, round: 8 };     // tray size: fewer, bolder details

const P = (r, a) => `${(128 + r * Math.cos(a)).toFixed(2)} ${(128 + r * Math.sin(a)).toFixed(2)}`;

// One segment: an annular sector whose straight edges run parallel to the radius, so the gap to its neighbour has the
// same width everywhere. Corners are rounded by stroking the path with the fill colour (the path is inset by `round`).
function segment(i, { r1, r2, gap, round }) {
  const mid = (Math.PI / 4) * i - Math.PI / 2 + Math.PI / 8;
  const d = gap / 2 + round;
  const [R1, R2] = [r1 + round, r2 - round];
  const edge = (R, side) => mid + side * (Math.PI / 8 - Math.asin(d / R));
  return `M${P(R1, edge(R1, -1))} L${P(R2, edge(R2, -1))} A${R2} ${R2} 0 0 1 ${P(R2, edge(R2, 1))} L${P(R1, edge(R1, 1))} A${R1} ${R1} 0 0 0 ${P(R1, edge(R1, -1))}Z`;
}

const svg = (size, { shape = SHAPE, pink = PINK, green = GREEN } = {}) => {
  const segments = Array.from({ length: 8 }, (_, i) => {
    const colour = i === 1 ? green : pink;
    return `<path d="${segment(i, shape)}" fill="${colour}" stroke="${colour}" stroke-width="${shape.round * 2}" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">${segments}</svg>`;
};

// A Windows .ico holding PNG images (Windows Vista and later). Used for Pomelo.exe and the installer.
async function ico(sizes) {
  const pngs = await Promise.all(sizes.map((s) => sharp(Buffer.from(svg(256, s < 48 ? { shape: SHAPE_SMALL } : {}))).resize(s, s).png().toBuffer()));
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = sizes[i] % 256;                                   // 256 is stored as 0
    head.writeUInt16LE(1, e + 4);                                            // colour planes
    head.writeUInt16LE(32, e + 6);                                           // bits per pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs]);
}

(async () => {
  const root = path.join(__dirname, '..');
  const assets = (n) => path.join(root, 'assets', n);
  await sharp(Buffer.from(svg(512))).png().toFile(assets('icon.png'));
  await sharp(Buffer.from(svg(256, { shape: SHAPE_SMALL }))).resize(32, 32).png().toFile(assets('tray.png'));
  await sharp(Buffer.from(svg(256))).resize(128, 128).png().toFile(path.join(root, 'src', 'renderer', 'logo.png'));   // settings window header
  fs.writeFileSync(assets('icon.ico'), await ico([16, 24, 32, 48, 64, 128, 256]));

  // Installer artwork: the tall panel on the first and last page (flat charcoal, mark on top) and the small corner logo.
  const panel = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="328" height="628"><rect width="328" height="628" fill="${CHARCOAL}"/></svg>`);
  const logo = await sharp(Buffer.from(svg(256))).resize(200, 200).png().toBuffer();
  fs.mkdirSync(path.join(root, 'installer'), { recursive: true });
  await sharp(panel).composite([{ input: logo, left: 64, top: 110 }]).png().toFile(path.join(root, 'installer', 'wizard-large.png'));
  // The corner logo sits in a 110 px canvas (55 px at 100% scale) with the mark at about half its size, so it stays quiet.
  const small = await sharp(Buffer.from(svg(256))).resize(60, 60).png().toBuffer();
  await sharp({ create: { width: 110, height: 110, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: small, left: 25, top: 25 }]).png().toFile(path.join(root, 'installer', 'wizard-small.png'));
  console.log('icons written');
})();
