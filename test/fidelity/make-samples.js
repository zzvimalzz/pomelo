// SPDX-License-Identifier: AGPL-3.0-or-later
// Prints the HTML samples in test/fidelity/samples/ to PDF with Chromium (the same engine Pomelo's own
// "to PDF" uses), so the fidelity harness has PDFs with real-world layouts to convert:
//   npx electron test/fidelity/make-samples.js            -> test/fidelity/out/pdf/*.pdf
// The images the samples use are drawn here (no binary files are committed).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const HERE = __dirname;
const SAMPLES = path.join(HERE, 'samples');
const ASSETS = path.join(HERE, 'out', 'assets');
const OUT = path.join(HERE, 'out', 'pdf');

const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

async function drawAssets() {
  fs.mkdirSync(ASSETS, { recursive: true });
  // a "photo": sky, sun, hills (JPEG, so it is a real DCT image in the PDF)
  await sharp(svg(960, 540, `
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b6cb0"/><stop offset="0.7" stop-color="#f6ad55"/></linearGradient></defs>
    <rect width="960" height="540" fill="url(#s)"/><circle cx="700" cy="330" r="70" fill="#fff5c2"/>
    <path d="M0 400 Q200 280 400 380 T800 360 T960 400 V540 H0Z" fill="#2f855a"/><path d="M0 470 Q250 380 520 460 T960 450 V540 H0Z" fill="#276749"/>`)).jpeg({ quality: 88 }).toFile(path.join(ASSETS, 'photo.jpg'));
  // a chart with transparency (PNG)
  await sharp(svg(800, 420, `
    <rect width="800" height="420" fill="none"/>
    <g stroke="#cbd5e0" stroke-width="1"><path d="M60 40V360H760"/><path d="M60 280H760M60 200H760M60 120H760" stroke-dasharray="4 6"/></g>
    <rect x="110" y="220" width="70" height="140" fill="#e8506f"/><rect x="230" y="150" width="70" height="210" fill="#93a92f"/>
    <rect x="350" y="100" width="70" height="260" fill="#e8506f"/><rect x="470" y="180" width="70" height="180" fill="#93a92f"/><rect x="590" y="70" width="70" height="290" fill="#e8506f"/>
    <path d="M145 210 L265 140 L385 90 L505 170 L625 60" fill="none" stroke="#1a202c" stroke-width="4"/>
    <g fill="#1a202c"><circle cx="145" cy="210" r="6"/><circle cx="265" cy="140" r="6"/><circle cx="385" cy="90" r="6"/><circle cx="505" cy="170" r="6"/><circle cx="625" cy="60" r="6"/></g>`)).png().toFile(path.join(ASSETS, 'chart.png'));
  // a logo with an alpha channel
  await sharp(svg(240, 240, `<circle cx="120" cy="120" r="108" fill="#2d3748"/><path d="M120 40 L190 160 H50Z" fill="#f6e05e"/><circle cx="120" cy="150" r="26" fill="#2d3748"/>`)).png().toFile(path.join(ASSETS, 'logo.png'));
  // a QR-ish block pattern
  let cells = '';
  for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if (((x * 7 + y * 13 + x * y) % 5) < 2 || (x < 7 && y < 7 && (x % 6 === 0 || y % 6 === 0 || (x > 1 && x < 5 && y > 1 && y < 5)))) cells += `<rect x="${x * 10}" y="${y * 10}" width="10" height="10"/>`;
  await sharp(svg(210, 210, `<rect width="210" height="210" fill="#fff"/><g fill="#000">${cells}</g>`)).png().toFile(path.join(ASSETS, 'qr.png'));
}

async function print(file) {
  const win = new BrowserWindow({ show: false, width: 1000, height: 1400, webPreferences: { offscreen: false } });
  const html = fs.readFileSync(path.join(SAMPLES, file), 'utf8').replaceAll('{{ASSETS}}', 'file:///' + ASSETS.replace(/\\/g, '/'));
  const tmp = path.join(HERE, 'out', file);
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  const buf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(path.join(OUT, file.replace(/\.html$/, '.pdf')), buf);
  win.destroy();
  fs.rmSync(tmp, { force: true });
  console.log('  wrote', file.replace(/\.html$/, '.pdf'));
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await drawAssets();
  for (const f of fs.readdirSync(SAMPLES).filter((n) => n.endsWith('.html'))) await print(f);
  app.exit(0);
});
