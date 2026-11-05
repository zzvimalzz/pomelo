// SPDX-License-Identifier: AGPL-3.0-or-later
// Pomelo started again by an in-app update (--updated[=<version>]): add the engines the new version expects, say how it went,
// and drop the downloaded installer.

// True when this start followed an update that landed: --updated alone, or --updated=<version> with the running version.
function updatedStart(argv, current) {
  const flag = argv.find((a) => a.startsWith('--updated'));
  if (!flag) return false;
  const wanted = flag.split('=')[1];
  return !wanted || wanted === current;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// argv: the command line. current: the running version. notify({ title, detail }): shows a message.
// engines: { missing(): [{ key, label }], add(key, note): { ok, message } }  what an installed engine pack lacks (see
//   engine-setup), and a way to install it; note(text, fraction) reports progress.
// ui: the Downloader window ({ show, update, close }), which shows the engines being added.
// -> true when this start followed an update, whether or not it landed.
async function reportUpdate({ argv, current, notify, cleanup, log, engines, ui, sleep = pause }) {
  const flag = argv.find((a) => a.startsWith('--updated'));
  if (!flag) return false;
  cleanup();
  if (!updatedStart(argv, current)) {
    log('update did not install; still on', current, 'wanted', flag.split('=')[1]);
    notify({ title: 'The update could not be installed', detail: `Pomelo is still on version ${current}. Open Settings from the tray icon and try again.` });
    return true;
  }

  const todo = engines.missing();
  const added = [];
  const failed = [];
  if (todo.length) {
    ui.show({ inactive: true });                 // the user pressed Download a minute ago and may be busy with something else
    for (const [i, engine] of todo.entries()) {
      let within;                                // how far this engine is, once it says
      const tell = (note) => ui.update({ phase: 'engines', current, latest: current, note: note || `Adding ${engine.label}`, fraction: within === undefined ? undefined : (i + within) / todo.length });
      tell();
      const r = await engines.add(engine.key, (text, fraction) => { if (Number.isFinite(fraction)) within = fraction; tell(text); }).catch((e) => ({ ok: false, message: e.message }));
      log('update: engine', engine.key, r.ok ? 'added' : `failed: ${r.message}`);
      (r.ok ? added : failed).push(engine.label);
    }
    if (failed.length) ui.update({ phase: 'done', current, latest: current, title: 'Updated, with one thing left', message: `${failed.join(', ')} could not be added. You can add it in Settings, Advanced.` });
    else { ui.update({ phase: 'done', current, latest: current, message: `Added ${added.join(' and ')}` }); await sleep(1800); ui.close(); }
  }

  const detail = ['The update is installed.', added.length && `Added ${added.join(' and ')}.`, failed.length && `${failed.join(', ')} could not be added. Open Settings, Advanced to try again.`].filter(Boolean).join(' ');
  notify({ title: `Pomelo is now on version ${current}`, detail });
  return true;
}

module.exports = { reportUpdate, updatedStart };
