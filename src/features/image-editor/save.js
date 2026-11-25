// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving an edited picture: the page renders the pixels and the main process checks them, encodes them in a temp file and puts that
// where it belongs, over the original or at a path the user picks. No Electron in here.
const fs = require('fs');
const path = require('path');
const { fileIdentity, replaceFile, withTempFile } = require('#shared/node/fs');
const { WRITABLE } = require('./limits');
const { check } = require('./save-options');

const FREE_MARGIN = 64 * 1048576;
const SPELLINGS = { jpg: ['jpg', 'jpeg'], tiff: ['tiff', 'tif'] };

const WHY_NOT_SAVED = {
  locked: ({ name }) => `${name} is open in another program. Close it there, or save a copy.`,
  'read-only': ({ name }) => `${name} is read-only. Save a copy instead.`,
  'no-space': ({ name, drive }) => `There is not enough free space on ${drive} to save ${name}.`,
};

const driveOf = (file) => path.parse(path.resolve(file)).root.replace(/\$/, '');

// images: the open pictures (images.js). writeImage(rgba, out, format, options) and uniquePath(dir, base, ext) are the conversion
// feature's. chooseSavePath(suggested, format): ask the user where a copy goes, and resolve the path or null. show(file): open a file
// as a tab and resolve whether it is open now. notify({ title, detail }) and log(...) as in index.js.
function createSave({ images, writeImage, uniquePath, chooseSavePath, show, notify, log }) {
  // Resolves { ok: true }, with `copy: true` when the copy is open as a tab of its own, or { stop } with 'changed' (another program changed the file: the page asks what to do), 'cancelled',
  // 'busy' or 'failed'; a stop that needs saying has been said in the corner of the screen. Throws when the page sent nonsense.
  async function save(token, rgba, raw) {
    const image = images.get(token);
    const options = check(raw);
    if (!(rgba instanceof Uint8Array) || rgba.length !== options.width * options.height * 4) throw new Error('bad pixels');
    const format = options.format === 'same' ? image.ext : options.format;
    const replacing = options.mode === 'replace';
    if (!WRITABLE.includes(format) || (replacing && (options.format !== 'same' || options.longEdge))) throw new Error('cannot save that way');
    if (image.saving) return { stop: 'busy' };
    image.saving = true;
    try {
      return await write(image, rgba, options, format, replacing);
    } catch (e) {
      log('cannot save image:', e.code || e.message);
      notify({ title: "Can't save", detail: `${image.name} could not be written.` });
      return { stop: 'failed' };
    } finally {
      image.saving = false;
    }
  }

  async function write(image, rgba, options, format, replacing) {
    let target = image.file;
    if (!replacing) {
      const suggested = uniquePath(path.dirname(image.file), `${path.basename(image.file, path.extname(image.file))} (edited)`, format);
      target = await chooseSavePath(suggested, format);
      if (!target) return { stop: 'cancelled' };
      if (!(SPELLINGS[format] ?? [format]).includes(path.extname(target).slice(1).toLowerCase())) target = uniquePath(path.dirname(target), path.basename(target), format);
    }
    const original = path.resolve(target).toLowerCase() === image.key;
    const name = path.basename(target);
    const free = await fs.promises.statfs(path.dirname(target));
    if (free.bavail * free.bsize < rgba.length + FREE_MARGIN) return stopped('no-space', name, target);

    const expected = original ? image.identity : await fileIdentity(target).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    const metadataFrom = await fs.promises.access(image.file).then(() => image.file, () => undefined);
    const result = await withTempFile(format, async (temp) => {
      await writeImage(rgba, temp, format, { width: options.width, height: options.height, quality: options.quality ?? undefined, longEdge: options.longEdge, metadataFrom });
      return replaceFile(temp, target, expected, () => true);
    });
    if (result.stop) return stopped(result.stop, name, target);
    if (original) { image.identity = result.identity; return { ok: true }; }
    return { ok: true, copy: replacing ? undefined : await show(target) };
  }

  function stopped(why, name, target) {
    const detail = WHY_NOT_SAVED[why]?.({ name, drive: driveOf(target) });
    if (detail) notify({ title: "Can't save", detail });
    return { stop: why };
  }

  return { save };
}

module.exports = { createSave };
