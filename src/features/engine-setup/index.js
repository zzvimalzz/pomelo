// SPDX-License-Identifier: AGPL-3.0-or-later
// Installing and removing the optional engines (PDF, OCR, HEIC, LibreOffice, Pandoc): from the Settings page, and from the
// command line for the Windows installer. The rest of the app uses only this file.
const { createInstaller } = require('./installer');
const { parse, run, fileProgress } = require('./cli');
const { registerEngineSetupIpc } = require('./engine-setup.ipc');

module.exports = { createInstaller, parseCommandLine: parse, runCommandLine: run, fileProgress, registerEngineSetupIpc };
