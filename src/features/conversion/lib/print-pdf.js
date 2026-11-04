// SPDX-License-Identifier: AGPL-3.0-or-later
// Printing an HTML page to PDF in a hidden Electron window. The page is built from a user's document, so the window runs offline.
const fs = require('fs');
const { withTempFile } = require('../../../shared/node/fs');

// The page that gets printed is built from a user's document, so it must not be able to call out to the internet
// (remote images, tracking pixels). Local files stay readable.
let printSession;
function offlineSession() {
  if (!printSession) {
    printSession = require('electron').session.fromPartition('pomelo-print');
    printSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
  }
  return printSession;
}

async function htmlToPdf(html, out, { landscape = false } = {}) {
  const { BrowserWindow } = require('electron');
  await withTempFile('html', async (file) => {
    fs.writeFileSync(file, html, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, session: offlineSession() } });
    try {
      await win.loadFile(file);
      const buf = await win.webContents.printToPDF({
        pageSize: 'A4', landscape, printBackground: true, preferCSSPageSize: true,   // a document that states its own page size keeps it
        margins: { top: 0.7, bottom: 0.7, left: 0.8, right: 0.8 },
      });
      fs.writeFileSync(out, buf);
    } finally {
      win.destroy();
    }
  });
}

module.exports = { htmlToPdf };
