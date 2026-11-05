// SPDX-License-Identifier: AGPL-3.0-or-later
// The tray icon: tooltip, click and the context menu.
const { Tray, Menu, nativeImage } = require('electron');

// icon: path of the tray image. getSettings() / setEnabled(bool): the stored settings. onSettings(): open the Settings window.
// onQuit(). -> { setTooltip(text), refreshMenu() }
function createTray({ icon, getSettings, setEnabled, onSettings, onQuit }) {
  const tray = new Tray(nativeImage.createFromPath(icon));
  tray.setToolTip('Pomelo');
  tray.on('click', onSettings);

  const refreshMenu = () => {
    const s = getSettings();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Pomelo', enabled: false },
      { label: 'Drag a file, then tap Ctrl', enabled: false },
      { type: 'separator' },
      { label: 'Enabled', type: 'checkbox', checked: s.enabled, click: (i) => setEnabled(i.checked) },
      { label: 'Settings…', click: onSettings },
      { type: 'separator' },
      { label: 'Quit Pomelo', click: onQuit },
    ]));
  };

  return { setTooltip: (text) => tray.setToolTip(text), refreshMenu };
}

module.exports = { createTray };
