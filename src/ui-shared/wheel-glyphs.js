// SPDX-License-Identifier: AGPL-3.0-or-later
// The small white picture drawn on the wheel's centre icon, one for every format Pomelo reads (see wheel-icons.js).
(() => {
  // Each is drawn around (cx, cy), about 22 wide and 20 high. `s` draws: `g` is solid, `gl` is a line, `thin` is a thinner line.
  const dot = (s, x, y, r = 1.8) => s.circle('g', x, y, r);

  window.pomeloGlyphs = {
    docx: (s, cx, cy) => { s.rect('g', cx - 7, cy - 8, 12, 3.4, 1.7); s.rect('g', cx - 10, cy - 1, 20, 2.6, 1.3); s.rect('g', cx - 10, cy + 4.5, 13, 2.6, 1.3); },
    doc: (s, cx, cy) => { for (let i = 0; i < 4; i++) { s.rect('g', cx - 10, cy - 8 + i * 4.6, 9, 2.2, 1.1); s.rect('g', cx + 1, cy - 8 + i * 4.6, 9, 2.2, 1.1); } },
    rtf: (s, cx, cy) => s.text('gt', cx, cy + 6, 'Aa'),
    odt: (s, cx, cy) => [-6, 0, 6].forEach((y) => { dot(s, cx - 8, cy + y, 1.7); s.rect('g', cx - 4, cy + y - 1.1, 14, 2.2, 1.1); }),
    txt: (s, cx, cy) => { for (let i = 0; i < 4; i++) s.rect('g', cx - 10, cy - 8 + i * 4.6, i === 3 ? 12 : 20, 2.2, 1.1); },
    md: (s, cx, cy) => {
      s.path('gl', `M${cx - 10} ${cy + 6}V${cy - 6}L${cx - 5} ${cy + 1}L${cx} ${cy - 6}V${cy + 6}`);
      s.path('gl', `M${cx + 6.5} ${cy - 6}V${cy + 5}M${cx + 3} ${cy + 1.5}L${cx + 6.5} ${cy + 5.5}L${cx + 10} ${cy + 1.5}`);
    },
    html: (s, cx, cy) => s.path('gl', `M${cx - 4} ${cy - 6}L${cx - 10} ${cy}L${cx - 4} ${cy + 6}M${cx + 4} ${cy - 6}L${cx + 10} ${cy}L${cx + 4} ${cy + 6}M${cx + 1.5} ${cy - 8}L${cx - 1.5} ${cy + 8}`),
    epub: (s, cx, cy) => {
      s.path('g', `M${cx - 1} ${cy - 5}Q${cx - 6} ${cy - 8} ${cx - 11} ${cy - 6}V${cy + 5}Q${cx - 6} ${cy + 3} ${cx - 1} ${cy + 6}Z`);
      s.path('g', `M${cx + 1} ${cy - 5}Q${cx + 6} ${cy - 8} ${cx + 11} ${cy - 6}V${cy + 5}Q${cx + 6} ${cy + 3} ${cx + 1} ${cy + 6}Z`);
    },
    pdf: (s, cx, cy) => s.path('g round', `M${cx - 5.5} ${cy - 9}H${cx + 5.5}V${cy + 9}L${cx} ${cy + 4.5}L${cx - 5.5} ${cy + 9}Z`),

    xlsx: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 8, 20, 16, 2);
      s.path('gl thin', `M${cx - 3.3} ${cy - 8}V${cy + 8}M${cx + 3.3} ${cy - 8}V${cy + 8}M${cx - 10} ${cy - 2.7}H${cx + 10}M${cx - 10} ${cy + 2.7}H${cx + 10}`);
    },
    xls: (s, cx, cy) => s.path('gl', `M${cx + 6} ${cy - 8}H${cx - 6}L${cx + 1} ${cy}L${cx - 6} ${cy + 8}H${cx + 6}`),
    ods: (s, cx, cy) => { s.circle('gl', cx, cy, 8.5); s.path('g', `M${cx} ${cy}V${cy - 8.5}A8.5 8.5 0 0 1 ${cx + 8.5} ${cy}Z`); },
    csv: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 8, 20, 16, 2);
      s.rect('g', cx - 10, cy - 8, 20, 5.5, 2);
      s.path('gl thin', `M${cx} ${cy - 2.5}V${cy + 8}M${cx - 10} ${cy + 2.7}H${cx + 10}`);
    },
    tsv: (s, cx, cy) => [-6, 0, 6].forEach((y) => {
      s.rect('g', cx - 10, cy + y - 1.1, 3, 2.2, 0.8);
      s.path('gl thin', `M${cx - 4.5} ${cy + y}H${cx + 3.5}M${cx + 1} ${cy + y - 2.2}L${cx + 3.5} ${cy + y}L${cx + 1} ${cy + y + 2.2}`);
      s.rect('g', cx + 7, cy + y - 1.1, 3, 2.2, 0.8);
    }),

    pptx: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 8, 20, 13, 2);
      s.path('gl thin', `M${cx} ${cy + 5}V${cy + 8.5}M${cx - 4} ${cy + 8.5}H${cx + 4}`);
      [3.5, 6, 8.5].forEach((h, i) => s.rect('g', cx - 6.5 + i * 4.5, cy + 3.5 - h, 3, h, 0.8));
    },
    ppt: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 8, 20, 13, 2);
      s.path('gl thin', `M${cx} ${cy + 5}V${cy + 8.5}M${cx - 4} ${cy + 8.5}H${cx + 4}`);
      s.rect('g', cx - 6, cy - 4.5, 12, 2.6, 1.3);
      s.rect('g', cx - 4, cy, 8, 2, 1);
    },

    png: (s, cx, cy) => {
      s.circle('g', cx - 5, cy - 4, 2.6);
      s.path('g', `M${cx - 11} ${cy + 8}L${cx - 3} ${cy - 1}L${cx + 1} ${cy + 3}L${cx + 5} ${cy - 2}L${cx + 11} ${cy + 8}Z`);
    },
    jpg: (s, cx, cy, color) => {
      s.rect('g', cx - 10, cy - 5, 20, 14, 3);
      s.rect('g', cx - 4, cy - 8.5, 8, 4.5, 1.5);
      s.circle('', cx, cy + 2, 4.8, color);
      dot(s, cx, cy + 2, 2.2);
    },
    webp: (s, cx, cy) => {
      s.circle('gl thin', cx, cy, 8.5);
      s.path('gl thin', `M${cx} ${cy - 8.5}C${cx - 6} ${cy - 3} ${cx - 6} ${cy + 3} ${cx} ${cy + 8.5}M${cx} ${cy - 8.5}C${cx + 6} ${cy - 3} ${cx + 6} ${cy + 3} ${cx} ${cy + 8.5}M${cx - 8.5} ${cy}H${cx + 8.5}`);
    },
    bmp: (s, cx, cy) => { for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) s.rect('g', cx - 10 + c * 5, cy - 10 + r * 5, 4.2, 4.2, 0.6); },
    gif: (s, cx, cy) => {
      s.path('gl', `M${cx + 7} ${cy - 3.5}A8 8 0 1 0 ${cx + 8} ${cy + 1.5}`);
      s.path('g', `M${cx + 3} ${cy - 10}L${cx + 9.5} ${cy - 3.5}L${cx + 2.5} ${cy - 2.5}Z`);
    },
    tiff: (s, cx, cy) => { s.rect('g', cx - 10, cy - 1, 17, 9, 2, 0.45); s.rect('g', cx - 7, cy - 5, 17, 9, 2, 0.7); s.rect('g', cx - 4, cy - 9, 17, 9, 2); },
    avif: (s, cx, cy) => {
      s.path('gl thin', `M${cx - 8} ${cy - 3}L${cx - 4} ${cy - 8}H${cx + 4}L${cx + 8} ${cy - 3}L${cx} ${cy + 8}Z`);
      s.path('gl thin', `M${cx - 8} ${cy - 3}H${cx + 8}M${cx - 2.5} ${cy - 3}L${cx} ${cy + 8}L${cx + 2.5} ${cy - 3}`);
    },
    heic: (s, cx, cy) => { s.circle('gl', cx, cy, 8.5); s.circle('gl thin', cx, cy, 4.6); dot(s, cx, cy, 1.5); },
    svg: (s, cx, cy) => {
      s.path('gl', `M${cx - 10} ${cy + 6}C${cx - 6} ${cy - 10} ${cx + 2} ${cy + 10} ${cx + 10} ${cy - 6}`);
      s.rect('g', cx - 12, cy + 4, 4, 4, 1);
      s.rect('g', cx + 8, cy - 8, 4, 4, 1);
    },

    srt: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 7.5, 20, 15, 3);
      s.rect('g', cx - 6.5, cy, 13, 2.2, 1.1);
      s.rect('g', cx - 4.5, cy + 3.8, 9, 2.2, 1.1);
    },
    vtt: (s, cx, cy) => {
      s.path('gl thin', `M${cx - 10} ${cy - 8}H${cx + 10}V${cy + 3}H${cx + 2}L${cx - 3} ${cy + 8}V${cy + 3}H${cx - 10}Z`);
      s.rect('g', cx - 6.5, cy - 4.5, 13, 2.2, 1.1);
      s.rect('g', cx - 6.5, cy - 0.8, 8, 2.2, 1.1);
    },

    zip: (s, cx, cy, color) => {
      for (let i = 0; i < 4; i++) s.rect('g', cx - 5 + (i % 2) * 5, cy - 20 + i * 5, 5, 3.4, 0.8);
      s.rect('g', cx - 5, cy - 1, 10, 12, 3);
      s.circle('', cx, cy + 5, 2.2, color);
    },
    '7z': (s, cx, cy) => {
      s.path('gl thin', `M${cx} ${cy - 9}L${cx + 8.5} ${cy - 4.5}V${cy + 4.5}L${cx} ${cy + 9}L${cx - 8.5} ${cy + 4.5}V${cy - 4.5}Z`);
      s.path('gl thin', `M${cx - 8.5} ${cy - 4.5}L${cx} ${cy}L${cx + 8.5} ${cy - 4.5}M${cx} ${cy}V${cy + 9}`);
    },
    tar: (s, cx, cy) => { s.rect('gl thin', cx - 10, cy - 7, 20, 14, 2.5); s.rect('g', cx - 2.5, cy - 7, 5, 14); },
    gz: (s, cx, cy) => s.path('gl', `M${cx - 6} ${cy - 9}L${cx} ${cy - 3.5}L${cx + 6} ${cy - 9}M${cx - 6} ${cy + 9}L${cx} ${cy + 3.5}L${cx + 6} ${cy + 9}M${cx - 9} ${cy}H${cx + 9}`),
    rar: (s, cx, cy) => [0.95, 0.7, 0.45].forEach((o, i) => s.rect('g', cx - 10, cy - 8 + i * 5.7, 20, 4.6, 2, o)),

    mp4: (s, cx, cy) => s.path('g round', `M${cx - 4.5} ${cy - 8}L${cx + 8} ${cy}L${cx - 4.5} ${cy + 8}Z`),
    mov: (s, cx, cy) => { s.circle('gl', cx, cy, 9); s.path('g', `M${cx - 3} ${cy - 4.5}L${cx + 5} ${cy}L${cx - 3} ${cy + 4.5}Z`); },
    mkv: (s, cx, cy, color) => {
      s.rect('g', cx - 10, cy - 9, 20, 18, 2);
      for (let i = 0; i < 4; i++) { s.rect('', cx - 8.6, cy - 7.4 + i * 4.6, 2.6, 2.6, 0.6, 1, color); s.rect('', cx + 6, cy - 7.4 + i * 4.6, 2.6, 2.6, 0.6, 1, color); }
      s.rect('', cx - 4.2, cy - 5.5, 8.4, 11, 1.2, 1, color);
    },
    webm: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 8, 20, 14, 2.5);
      s.path('g', `M${cx - 2.5} ${cy - 4}L${cx + 4} ${cy - 1}L${cx - 2.5} ${cy + 2}Z`);
      s.rect('g', cx - 4, cy + 8, 8, 2, 1);
    },
    avi: (s, cx, cy, color) => {
      s.rect('g', cx - 10, cy - 3, 20, 12, 2);
      s.rect('g', cx - 10, cy - 8, 20, 4, 1);
      [-7, -1.5, 4].forEach((x) => s.path('', `M${cx + x} ${cy - 8}h2.6l-2.2 4h-2.6z`, color));
    },
    wmv: (s, cx, cy) => { s.rect('g', cx - 10, cy - 5, 13, 11, 2.5); s.path('g', `M${cx + 4} ${cy - 1}L${cx + 10} ${cy - 5}V${cy + 6}L${cx + 4} ${cy + 2}Z`); },
    m4v: (s, cx, cy) => {
      s.rect('gl thin', cx - 10, cy - 5, 20, 14, 2.5);
      s.path('gl thin', `M${cx - 4} ${cy - 9}L${cx} ${cy - 5}L${cx + 4} ${cy - 9}`);
      dot(s, cx + 6, cy + 0.5, 1.3); dot(s, cx + 6, cy + 4.5, 1.3);
    },
    mpg: (s, cx, cy) => { s.circle('gl', cx, cy, 9); [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]].forEach(([x, y]) => dot(s, cx + x, cy + y, 1.8)); dot(s, cx, cy, 1.4); },
    flv: (s, cx, cy) => s.path('g round', `M${cx + 2} ${cy - 9}L${cx - 6} ${cy + 1}H${cx}L${cx - 2} ${cy + 9}L${cx + 6} ${cy - 2}H${cx + 1}Z`),

    mp3: (s, cx, cy) => [6, 12, 18, 11, 6].forEach((h, i) => s.rect('g', cx - 11.5 + i * 5, cy - h / 2, 3, h, 1.5)),
    wav: (s, cx, cy) => s.path('gl', `M${cx - 10} ${cy}Q${cx - 7.5} ${cy - 10} ${cx - 5} ${cy}T${cx} ${cy}T${cx + 5} ${cy}T${cx + 10} ${cy}`),
    ogg: (s, cx, cy) => { s.circle('g', cx - 2, cy + 5.5, 3.4); s.rect('g', cx + 0.4, cy - 9, 2, 14.5); s.path('gl', `M${cx + 2.4} ${cy - 9}Q${cx + 7} ${cy - 7} ${cx + 7.5} ${cy - 2}`); },
    m4a: (s, cx, cy) => {
      s.path('gl', `M${cx - 8} ${cy + 2}V${cy - 1}A8 8 0 0 1 ${cx + 8} ${cy - 1}V${cy + 2}`);
      s.rect('g', cx - 10.5, cy + 1, 5, 8, 2); s.rect('g', cx + 5.5, cy + 1, 5, 8, 2);
    },
    flac: (s, cx, cy) => [[-6, -4], [0, 3], [6, -1]].forEach(([x, y]) => { s.path('gl thin', `M${cx + x} ${cy - 9}V${cy + 9}`); s.rect('g', cx + x - 2.4, cy + y - 1.7, 4.8, 3.4, 1); }),
    opus: (s, cx, cy) => {
      s.path('g', `M${cx - 9} ${cy - 3}H${cx - 5}L${cx} ${cy - 8}V${cy + 8}L${cx - 5} ${cy + 3}H${cx - 9}Z`);
      s.path('gl', `M${cx + 3.5} ${cy - 3.5}Q${cx + 6} ${cy} ${cx + 3.5} ${cy + 3.5}M${cx + 6.5} ${cy - 6.5}Q${cx + 11} ${cy} ${cx + 6.5} ${cy + 6.5}`);
    },
    aiff: (s, cx, cy) => { s.circle('gl', cx, cy, 9); s.circle('gl thin', cx, cy, 5); dot(s, cx, cy, 1.6); },
    wma: (s, cx, cy) => {
      s.rect('g', cx - 3.5, cy - 9, 7, 11, 3.5);
      s.path('gl', `M${cx - 7} ${cy - 1}A7 7 0 0 0 ${cx + 7} ${cy - 1}M${cx} ${cy + 6}V${cy + 9}M${cx - 4} ${cy + 9}H${cx + 4}`);
    },
    aac: (s, cx, cy) => {
      dot(s, cx - 6.5, cy + 6, 3); dot(s, cx + 4, cy + 4, 3);
      s.rect('g', cx - 4.5, cy - 7, 2, 13); s.rect('g', cx + 6, cy - 9, 2, 13);
      s.path('g', `M${cx - 4.5} ${cy - 7}L${cx + 8} ${cy - 9.5}V${cy - 6}L${cx - 4.5} ${cy - 3.5}Z`);
    },
  };
})();
