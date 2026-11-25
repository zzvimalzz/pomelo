// SPDX-License-Identifier: AGPL-3.0-or-later
// A field for a whole number with its own minus and plus buttons, so no browser spin arrows show. A classic script: load it after dom.js
// and icons.js, it adds window.pomeloUi.numberField.
(() => {
  const { el, icon } = window.pomeloUi;

  // Returns { el, input, set(n) }: `el` is what goes in the page, `input` is the text field (read its value, set aria-invalid on it),
  // and set(n) clamps n to min and max, shows it and calls onInput. onInput(text) runs on every change, typed or stepped, with text as typed
  // (digits only, possibly empty or out of range: the caller decides what that means). ArrowUp and ArrowDown step by 1, PageUp, PageDown
  // and Shift by 10.
  function numberField({ label, min, max, value = '', onInput }) {
    const input = el('input', 'num-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = String(value);
    input.setAttribute('role', 'spinbutton');
    input.setAttribute('aria-label', label);
    input.setAttribute('aria-valuemin', String(min));
    input.setAttribute('aria-valuemax', String(max));
    const announce = () => input.setAttribute('aria-valuenow', input.value);
    announce();

    const set = (n) => {
      input.value = String(Math.min(max, Math.max(min, n)));
      announce();
      onInput?.(input.value);
    };
    const step = (by) => {
      const now = Number(input.value);
      set(input.value !== '' && Number.isInteger(now) ? now + by : max);
    };

    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '');
      if (digits !== input.value) input.value = digits;
      announce();
      onInput?.(input.value);
    });
    input.addEventListener('keydown', (e) => {
      const by = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (!by || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      step(e.shiftKey ? by * 10 : by);
    });

    const button = (name, text, by) => {
      const b = el('button', 'num-step');
      b.type = 'button';
      b.tabIndex = -1;
      b.title = text;
      b.setAttribute('aria-label', text);
      b.innerHTML = icon(name);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.onclick = () => step(by);
      return b;
    };
    const wrap = el('div', 'numfield');
    wrap.append(button('minus', 'Decrease', -1), input, button('plus', 'Increase', 1));
    return { el: wrap, input, set };
  }

  window.pomeloUi.numberField = numberField;
})();
