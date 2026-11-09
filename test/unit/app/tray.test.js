// SPDX-License-Identifier: AGPL-3.0-or-later
// The tray menu against a fake Electron: its entries, what each one does, and the grey icon while Pomelo is paused.
const path = require('path');
const Module = require('module');
const { expect } = require('../../support/expect');
const finish = require('../../support/finish');

const picture = (bytes) => ({ bytes, getSize: () => ({ width: 2, height: 1 }), toBitmap: () => Buffer.from(bytes), resize: () => picture(bytes) });
let tray;
class Tray {
  constructor(image) { this.image = image; this.handlers = {}; tray = this; }
  setToolTip() {}
  on(event, fn) { this.handlers[event] = fn; }
  setImage(image) { this.image = image; }
  setContextMenu(menu) { this.menu = menu; }
}
const fakeElectron = {
  Tray,
  Menu: { buildFromTemplate: (template) => template },
  nativeImage: { createFromPath: () => picture([200, 100, 50, 255, 0, 0, 0, 0]), createFromBitmap: (buf, size) => ({ ...picture([...buf]), size }) },
};
const realLoad = Module._load;
Module._load = (request, ...rest) => (request === 'electron' ? fakeElectron : realLoad(request, ...rest));
const { createTray } = require(path.join(__dirname, '..', '..', '..', 'src', 'app', 'tray'));
Module._load = realLoad;

const settings = { enabled: true, openAtLogin: false };
const changes = [];
const opened = [];
let quit = 0;
const menu = createTray({ icon: 'tray.png', getSettings: () => settings, onChange: (p) => changes.push(p), onOpen: (t) => opened.push(t), onQuit: () => { quit++; } });
menu.refreshMenu();

const labels = () => tray.menu.filter((i) => i.type !== 'separator').map((i) => i.label);
const item = (label) => tray.menu.find((i) => i.label === label);
expect('the menu lists the status, the two switches, Settings, the guide, updates and Quit', labels().join('|') === 'Pomelo  ·  Running|Enabled|Start with Windows|Settings|How Pomelo works|Check for updates|Quit Pomelo', labels().join('|'));
expect('the status line is not clickable', item('Pomelo  ·  Running').enabled === false);
expect('the switches show what is stored', item('Enabled').checked === true && item('Start with Windows').checked === false);

item('Enabled').click({ checked: false });
item('Start with Windows').click({ checked: true });
expect('a switch reports its new value', JSON.stringify(changes) === JSON.stringify([{ enabled: false }, { openAtLogin: true }]), JSON.stringify(changes));

item('Settings').click();
item('How Pomelo works').click();
item('Check for updates').click();
tray.handlers.click();
expect('each entry opens its own section, and a click on the icon opens Settings', JSON.stringify(opened) === JSON.stringify([undefined, { page: 'help' }, { page: 'updates', check: true }, undefined]), JSON.stringify(opened));
item('Quit Pomelo').click();
expect('Quit quits', quit === 1);

const normal = tray.image;
settings.enabled = false;
menu.refreshMenu();
const [b, g, r, a] = tray.image.bytes;
expect('paused: the status says so and the icon is a different, grey, see-through picture', labels()[0] === 'Pomelo  ·  Paused' && tray.image !== normal && b === g && g === r && a < 255, JSON.stringify(tray.image.bytes));
settings.enabled = true;
menu.refreshMenu();
expect('running again: the normal icon is back', tray.image === normal);

finish();
