// SPDX-License-Identifier: AGPL-3.0-or-later
// The Pomelo icon drawn in the wheel's centre for the files being dragged: a file or folder in the colour of its format, with the
// format's own picture (wheel-glyphs.js) and its name as text.
(() => {
  const GROUP_COLOR = { doc: '#2b6cd4', pdf: '#e5483d', sheet: '#1e9e5a', slide: '#e8793a', image: '#8a5cf0',
    folder: '#e0a030', video: '#0e7490', audio: '#0ca678', subtitle: '#d99100', archive: '#6c757d' };
  const EXT_COLOR = {
    doc: '#1e4fa3', rtf: '#2f8fcf', odt: '#1a9ab5', txt: '#6b7280', md: '#475569', html: '#e8590c', epub: '#0f9d8a',
    xls: '#16803f', ods: '#2eaa7b', csv: '#4f9d2d', tsv: '#0f8f75', ppt: '#d4552b',
    jpg: '#e64980', webp: '#2f9bd6', bmp: '#6f6bd8', gif: '#c026d3', tiff: '#7a4fbf', avif: '#0aa89e', heic: '#3b5bdb', svg: '#f08c00',
    vtt: '#c77d0a', '7z': '#5f3dc4', tar: '#8d6748', gz: '#c2700b', rar: '#a23bb5',
    mov: '#3b6fd4', mkv: '#0c8599', webm: '#1098ad', avi: '#7048e8', wmv: '#1971c2', m4v: '#364fc7', mpg: '#5c7cfa', flv: '#e03131',
    wav: '#12b886', ogg: '#2f9e44', m4a: '#20a39e', flac: '#099268', opus: '#0b9a7a', aiff: '#087f5b', wma: '#1b9aaa', aac: '#51a64e',
  };

  const FILE_W = 44, FILE_H = 56, FILE_CUT = 14, FILE_R = 8;
  const FOLDER_W = 58, FOLDER_H = 44, FOLDER_TOP = 14;

  const roundedRect = (x, y, w, h, r) => `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;

  function sheetPath(x, y) {
    const right = x + FILE_W, bottom = y + FILE_H;
    return `M${x + FILE_R} ${y}H${right - FILE_CUT}L${right} ${y + FILE_CUT}V${bottom - FILE_R}Q${right} ${bottom} ${right - FILE_R} ${bottom}H${x + FILE_R}Q${x} ${bottom} ${x} ${bottom - FILE_R}V${y + FILE_R}Q${x} ${y} ${x + FILE_R} ${y}Z`;
  }

  function folderBackPath(x, y) {
    const right = x + FOLDER_W, bottom = y + FOLDER_H;
    return `M${x + 6} ${y}H${x + 20}Q${x + 24} ${y} ${x + 27} ${y + 4}L${x + 29} ${y + 7}H${right - 6}Q${right} ${y + 7} ${right} ${y + 13}V${bottom - 6}Q${right} ${bottom} ${right - 6} ${bottom}H${x + 6}Q${x} ${bottom} ${x} ${bottom - 6}V${y + 6}Q${x} ${y} ${x + 6} ${y}Z`;
  }

  function folderIcon(s, x, y, color) {
    s.path('', folderBackPath(x, y), color);
    s.path('shade', folderBackPath(x, y));
    const front = roundedRect(x, y + FOLDER_TOP, FOLDER_W, FOLDER_H - FOLDER_TOP, 6);
    s.path('', front, color);
    s.path('', front, 'url(#sheen)');
    s.path('edge', `M${x + 6} ${y + FOLDER_TOP + 0.6}H${x + FOLDER_W - 6}`);
  }

  function fileIcon(s, x, y, color, info, cx) {
    s.path('', sheetPath(x, y), color);
    s.path('', sheetPath(x, y), 'url(#sheen)');
    const fx = x + FILE_W - FILE_CUT;
    s.path('fold', `M${fx} ${y}V${y + FILE_CUT - 2}Q${fx} ${y + FILE_CUT} ${fx + 2} ${y + FILE_CUT}H${x + FILE_W}Z`);
    const glyph = window.pomeloGlyphs[info.ext];
    glyph?.(s, cx, y + 25, color);
    s.text('badge', cx, y + (glyph ? 50 : 41), (info.ext || '?').toUpperCase().slice(0, 4));
  }

  // Draws the icon centred on (cx, cy) into `parent`, with `count` files stacked behind it. `el(tag, attrs, parent)` makes SVG
  // elements. Returns the icon's top left corner.
  function draw(el, parent, info, cx, cy) {
    const folder = info.group === 'folder';
    const w = folder ? FOLDER_W : FILE_W, h = folder ? FOLDER_H : FILE_H;
    const x = cx - w / 2, y = folder ? cy - 36 : cy - 46;
    const color = EXT_COLOR[info.ext] || GROUP_COLOR[info.group] || '#8e8e93';
    const s = {
      rect: (cls, rx, ry, rw, rh, r = 0, opacity = 1, fill) => el('rect', { class: cls, x: rx, y: ry, width: rw, height: rh, rx: r, opacity, ...(fill && { fill }) }, parent),
      path: (cls, d, fill) => el('path', { class: cls, d, ...(fill && { fill }) }, parent),
      circle: (cls, ccx, ccy, r, fill) => el('circle', { class: cls, cx: ccx, cy: ccy, r, ...(fill && { fill }) }, parent),
      text: (cls, tx, ty, text) => { el('text', { class: cls, x: tx, y: ty }, parent).textContent = text; },
    };
    if (info.count > 1) {
      [[-13, 0.34], [11, 0.58]].slice(info.count > 2 ? 0 : 1).forEach(([deg, opacity]) => {
        el('path', { d: (folder ? folderBackPath : sheetPath)(x, y), fill: color, opacity, transform: `rotate(${deg} ${cx} ${y + h / 2})` }, parent);
      });
    }
    if (folder) folderIcon(s, x, y, color);
    else fileIcon(s, x, y, color, info, cx);
    return { x, y };
  }

  // The gradient the icons use for their sheen. Add it once to each page that draws icons; `el` makes SVG elements.
  function addDefs(el, svg) {
    const gradient = el('linearGradient', { id: 'sheen', x1: 0, y1: 0, x2: 0, y2: 1 }, el('defs', {}, svg));
    el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.34 }, gradient);
    el('stop', { offset: 0.55, 'stop-color': '#fff', 'stop-opacity': 0 }, gradient);
    el('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.16 }, gradient);
  }

  window.pomeloIcons = { draw, addDefs };
})();
