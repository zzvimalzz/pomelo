// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace page: asks the main process which document it was opened for, names it in the title row and shows it.
(async () => {
  if (new URLSearchParams(location.search).has('solid')) document.documentElement.classList.add('solid');
  const failure = document.getElementById('failure');
  try {
    const [doc] = (await window.workspaceApi.state()).documents;
    if (!doc) return;
    document.getElementById('docname').textContent = doc.name;
    document.title = `${doc.name} - Pomelo`;
    await window.workspaceViewer.open(doc, document.getElementById('scroller'), document.getElementById('viewer'));
  } catch (e) {
    failure.textContent = e && e.name === 'PasswordException' ? 'This file is password-protected' : 'This file is damaged or is not a PDF';
    failure.hidden = false;
  }
})();
