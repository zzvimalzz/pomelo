// SPDX-License-Identifier: AGPL-3.0-or-later
// The tray icon: tooltip, click and the context menu. The icon turns grey while Pomelo is paused.
const { Tray, Menu, nativeImage } = require('electron');

// Grey and half see-through, from the same picture, so there is no second asset to keep in step.
function dimmed(image) {
  const size = image.getSize();
  const px = image.toBitmap();
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = ((px[i] + px[i + 1] + px[i + 2]) / 3) * 0.55;
    px[i + 3] *= 0.55;
  }
  return nativeImage.createFromBitmap(px, size);
}

// icon: path of the tray image. getSettings(): the stored settings. onChange(patch): a switch in the menu was flipped.
// onOpen(target): open Settings, on { page } or { page, check } for an update check. onQuit(). -> { setTooltip(text), refreshMenu() }
function createTray({ icon, getSettings, onChange, onOpen, onQuit }) {
  const normal = nativeImage.createFromPath(icon);
  const paused = dimmed(normal);
  const small = normal.resize({ width: 16, height: 16 });
  const tray = new Tray(normal);
  tray.setToolTip('Pomelo');
  tray.on('click', () => onOpen());

  const refreshMenu = () => {
    const s = getSettings();
    tray.setImage(s.enabled ? normal : paused);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Pomelo  ·  ${s.enabled ? 'Running' : 'Paused'}`, icon: small, enabled: false },
      { type: 'separator' },
      { label: 'Enabled', type: 'checkbox', checked: s.enabled, click: (i) => onChange({ enabled: i.checked }) },
      { label: 'Start with Windows', type: 'checkbox', checked: s.openAtLogin, click: (i) => onChange({ openAtLogin: i.checked }) },
      { type: 'separator' },
      { label: 'Settings', click: () => onOpen() },
      { label: 'How Pomelo works', click: () => onOpen({ page: 'help' }) },
      { label: 'Check for updates', click: () => onOpen({ page: 'updates', check: true }) },
      { type: 'separator' },
      { label: 'Quit Pomelo', click: onQuit },
    ]));
  };

  return { setTooltip: (text) => tray.setToolTip(text), refreshMenu };
}

module.exports = { createTray };
