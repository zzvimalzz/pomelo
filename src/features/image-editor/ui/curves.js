// SPDX-License-Identifier: AGPL-3.0-or-later
// Curve maths: a smooth line through a few points that never dips between two points that rise, and the table the shader reads for the
// four curves of an edit. Nothing here touches the page. A classic script that adds window.editorCurves.
(() => {
  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);

  // A monotone cubic (Fritsch and Carlson) through points [x, y] with x from 0 to 1, as a function of x. The slope at each point is the
  // mean of the slopes either side, cut back where it would make the line overshoot.
  function through(points) {
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    const n = sorted.length, xs = sorted.map((p) => p[0]), ys = sorted.map((p) => p[1]);
    if (n === 2) return (x) => ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / ((xs[1] - xs[0]) || 1);
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / ((xs[i + 1] - xs[i]) || 1e-6);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (x) => {
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = (xs[i + 1] - xs[i]) || 1e-6, t = clamp((x - xs[i]) / h, 0, 1), t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  const table = (points) => {
    const f = through(points);
    return Float32Array.from({ length: 256 }, (_, i) => clamp(f(i / 255), 0, 1));
  };

  // The 256 x 1 RGBA table of an edit's curve, `curve` being { rgb, r, g, b }: each channel's own curve applied to what the RGB curve
  // made of the value.
  function lut({ rgb, r, g, b }) {
    const all = table(rgb), own = [r, g, b].map(table);
    const out = new Uint8Array(1024);
    for (let v = 0; v < 256; v++) {
      const base = Math.round(all[v] * 255);
      for (let c = 0; c < 3; c++) out[v * 4 + c] = Math.round(own[c][base] * 255);
      out[v * 4 + 3] = 255;
    }
    return out;
  }

  window.editorCurves = { through, table, lut };
})();
