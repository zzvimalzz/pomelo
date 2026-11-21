// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace page: asks the main process which document it was opened for, names it in the title row and shows it.
(async () => {
  if (new URLSearchParams(location.search).has('solid')) document.documentElement.classList.add('solid');
  const failure = document.getElementById('failure');

  async function show(doc) {
    try {
      await window.workspaceViewer.open(doc, document.getElementById('scroller'), document.getElementById('viewer'));
    } catch (e) {
      const locked = e && e.name === 'PasswordException';
      failure.textContent = locked ? 'This file is password-protected' : 'This file is damaged or is not a PDF';
      if (locked) {
        const unlock = window.pomeloUi.el('button', 'btn primary', 'Unlock');
        unlock.onclick = () => { failure.hidden = true; show(doc); };
        failure.append(unlock);
      }
      failure.hidden = false;
    }
  }

  const { documents: [doc], dock } = await window.workspaceApi.state();
  document.querySelector('.well').dataset.dock = dock;
  if (!doc) return;
  document.getElementById('docname').textContent = doc.name;
  document.title = `${doc.name} - Pomelo`;
  await show(doc);
})();
