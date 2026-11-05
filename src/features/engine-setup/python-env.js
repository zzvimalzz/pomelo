// SPDX-License-Identifier: AGPL-3.0-or-later
// The private Python environment of the PDF, OCR and HEIC engine: find (or add) a Python, build root/pyenv, install the packages
// of python/requirements.txt, check they import and fetch the OCR models.
const fs = require('fs');
const path = require('path');
const { PACKS } = require('./packs');
const { wingetInstall } = require('./winget');
const { removeDirReliably } = require('../../shared/node/fs');
const { lastMeaningfulLine } = require('../../shared/node/process');
const { inApp, pyenvPython, scriptPath } = require('../../shared/node/paths');

const requirementsFile = () => inApp('python', 'requirements.txt');

// A Python the engine's packages ship wheels for (3.9 to 3.13). A newer one (a pre-release such as 3.15 is what `py -3` can
// pick) has no ONNX Runtime yet, so it is skipped and Python 3.12 is added instead, for this user only.
async function findSystemPython(run) {
  for (const [cmd, args] of [['py', ['-3.12']], ['py', ['-3.13']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []], ['py', ['-3']]]) {
    const r = await run(cmd, [...args, '-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1]); print(sys.executable)']);
    if (r.code !== 0) continue;
    const [version, exe] = r.out.trim().split(/\r?\n/).slice(-2);
    if (+version >= 309 && +version <= 313 && exe && fs.existsSync(exe.trim())) return exe.trim();   // skips the Microsoft Store stub, which prints nothing useful
  }
  return null;
}

async function installPython({ run, root, note, manifest }) {
  let py = await findSystemPython(run);
  if (!py) {
    const runtime = PACKS.python.runtime;
    await wingetInstall(run, { ...runtime, args: ['--scope', 'user'] }, note);
    manifest.record({ winget: runtime });
    const known = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
    py = fs.existsSync(known) ? known : await findSystemPython(run);
    if (!py) throw new Error('Python was installed but could not be found. Restart Pomelo and try again');
  }
  const env = path.join(root, 'pyenv');
  try {
    await removeDirReliably(env);                                                          // an older environment (other package versions) is rebuilt, not patched
    note('Creating a private Python environment…', 0.05);
    let r = await run(py, ['-m', 'venv', env]);
    if (r.code !== 0) throw new Error(`Could not create the Python environment: ${lastMeaningfulLine(r.out)}`);
    manifest.record({ pyenv: true });
    note('Downloading the PDF, OCR and HEIC components…', 0.1);
    r = await run(pyenvPython(root), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirementsFile()], { onLine: (l) => note(l.slice(0, 90)) });
    if (r.code !== 0) throw new Error(`Could not download the components: ${lastMeaningfulLine(r.out)}`);
    note('Checking the components…', 0.85);
    r = await run(pyenvPython(root), ['-W', 'ignore', '-c', `import ${PACKS.python.check}`]);
    if (r.code !== 0) throw new Error(`The components did not start: ${lastMeaningfulLine(r.out)}`);
    note('Downloading the text-recognition models…', 0.92);
    await run(pyenvPython(root), ['-W', 'ignore', scriptPath('ocr_warmup.py')], { timeout: 10 * 60 * 1000 });     // best effort: a scan fetches them itself when it first needs them
  } catch (e) {
    fs.rmSync(env, { recursive: true, force: true });                              // no half-installed environment left behind
    throw e;
  }
}

module.exports = { installPython };
