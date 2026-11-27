// SPDX-License-Identifier: AGPL-3.0-or-later
// The histogram at the top of the Adjust panel: the red, green and blue values of a small copy of the picture as filled curves. They are
// multiplied over the field in light mode and added to it in dark mode, so the three overlap into grey or white. Not interactive. A
// classic script that adds window.editorHistogram.
(() => {
  const W = 288, H = 72, PAD = 6;
  const COLOURS = {
    light: ['rgba(240, 90, 90, .6)', 'rgba(70, 180, 100, .6)', 'rgba(80, 130, 240, .6)'],
    dark: ['rgba(255, 80, 80, .75)', 'rgba(70, 210, 110, .75)', 'rgba(80, 140, 255, .8)'],
  };
  const dark = matchMedia('(prefers-color-scheme: dark)');

  // A few bins on each side lend a share of their count, so a flat patch of colour does not draw a spike.
  function smoothed(bins) {
    return bins.map((_, i) => {
      let sum = 0, weight = 0;
      for (let k = -3; k <= 3; k++) {
        if (bins[i + k] === undefined) continue;
        sum += bins[i + k] * (4 - Math.abs(k));
        weight += 4 - Math.abs(k);
      }
      return sum / weight;
    });
  }

  function create(canvas) {
    let curves = null;

    function paint() {
      const d = window.devicePixelRatio || 1;
      canvas.width = W * d;
      canvas.height = H * d;
      if (!curves) return;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(d, 0, 0, d, 0, 0);
      // The first and last bins hold everything that is pure black or pure white, so they would flatten the rest.
      const top = Math.max(...curves.map((bins) => Math.max(...bins.slice(2, 254)))) || 1;
      ctx.globalCompositeOperation = dark.matches ? 'screen' : 'multiply';
      curves.forEach((bins, channel) => {
        ctx.fillStyle = COLOURS[dark.matches ? 'dark' : 'light'][channel];
        ctx.beginPath();
        ctx.moveTo(PAD, H - PAD);
        bins.forEach((count, i) => ctx.lineTo(PAD + i * (W - 2 * PAD) / 255, H - PAD - Math.sqrt(Math.min(1, count / top)) * (H - 14)));
        ctx.lineTo(W - PAD, H - PAD);
        ctx.closePath();
        ctx.fill();
      });
    }
    dark.addEventListener('change', paint);

    // rgba: the pixels of a small copy of the picture, or null to leave the histogram empty. Pixels that are mostly clear are not counted.
    function show(rgba) {
      curves = null;
      if (rgba) {
        const bins = [0, 1, 2].map(() => new Float32Array(256));
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] >= 128) for (let c = 0; c < 3; c++) bins[c][rgba[i + c]]++;
        curves = bins.map(smoothed);
      }
      paint();
    }

    paint();
    return { show };
  }

  window.editorHistogram = { create };
})();
