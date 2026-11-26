// SPDX-License-Identifier: AGPL-3.0-or-later
// How a picture is turned, flipped, levelled and cropped: the geometry object of an edit, the size of the result, the matrix the shader
// uses to find, for a point of the result, the point of the source it shows, and the maths of the crop frame. The picture is turned and
// flipped first, then levelled by the straighten angle about its centre, then cut by the crop frame, a rectangle kept as fractions of
// the turned picture. A classic script that adds window.editorGeometry.
(() => {
  const neutral = () => ({ rotate: 0, flipH: false, flipV: false, angle: 0, aspect: 'free', portrait: false, crop: { x: 0, y: 0, w: 1, h: 1 } });
  const isWhole = (c) => c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
  const isNeutral = (g) => g.rotate === 0 && !g.flipH && !g.flipV && g.angle === 0 && isWhole(g.crop);
  const turnedSize = (g, width, height) => (g.rotate % 180 ? [height, width] : [width, height]);
  const outputSize = (g, width, height) => {
    const [w, h] = turnedSize(g, width, height);
    return [Math.max(1, Math.round(g.crop.w * w)), Math.max(1, Math.round(g.crop.h * h))];
  };

  // Rows of a 3 x 3 matrix on (u, v, 1), where u and v run from 0 to 1 across the picture.
  const UNDO_TURN = {
    0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    90: [0, 1, 0, -1, 0, 1, 0, 0, 1],
    180: [-1, 0, 1, 0, -1, 1, 0, 0, 1],
    270: [0, -1, 1, 1, 0, 0, 0, 0, 1],
  };
  const times = (a, b) => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; });

  // Column-major, as WebGL wants it. From a point of the result: through the crop to pixels from the turned picture's centre, level
  // them back by the straighten angle, then undo the flip and the turn.
  function matrix(g, width, height) {
    const [w, h] = turnedSize(g, width, height);
    const flip = [g.flipH ? -1 : 1, 0, g.flipH ? 1 : 0, 0, g.flipV ? -1 : 1, g.flipV ? 1 : 0, 0, 0, 1];
    const a = g.angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const level = [cos, sin, 0, -sin, cos, 0, 0, 0, 1];
    const fromCrop = [w * g.crop.w, 0, w * (g.crop.x - 0.5), 0, h * g.crop.h, h * (g.crop.y - 0.5), 0, 0, 1];
    const toTurned = [1 / w, 0, 0.5, 0, 1 / h, 0.5, 0, 0, 1];
    const rows = times(times(times(UNDO_TURN[g.rotate], flip), toTurned), times(level, fromCrop));
    return Float32Array.from([0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => rows[i]));
  }

  // A frame is kept to a millionth, so a turn or a flip done twice gives back exactly what it started with and Undo sees no change.
  const tidy = (c) => ({ x: Math.round(c.x * 1e6) / 1e6, y: Math.round(c.y * 1e6) / 1e6, w: Math.round(c.w * 1e6) / 1e6, h: Math.round(c.h * 1e6) / 1e6 });
  const turnRight = (c) => tidy({ x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w });
  const turnLeft = (c) => tidy({ x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w });
  const mirrorAcross = (c) => tidy({ ...c, x: 1 - c.x - c.w });
  const mirrorDown = (c) => tidy({ ...c, y: 1 - c.y - c.h });

  // One visual quarter turn to the right (dir 1) or left (-1). With one flip on, the stored turn runs the other way. The crop frame
  // turns with the picture, and a frame of a set ratio swaps between portrait and landscape.
  const rotate = (g, dir) => ({
    ...g,
    rotate: (g.rotate + (g.flipH !== g.flipV ? -dir : dir) * 90 + 360) % 360,
    crop: dir > 0 ? turnRight(g.crop) : turnLeft(g.crop),
    portrait: g.aspect === 'free' || g.aspect === '1:1' ? g.portrait : !g.portrait,
  });
  // A flip mirrors the level too: a picture that leans right leans left once it is mirrored.
  const flip = (g, axis) => ({
    ...g,
    flipH: axis === 'h' ? !g.flipH : g.flipH,
    flipV: axis === 'v' ? !g.flipV : g.flipV,
    angle: g.angle ? -g.angle : 0,
    crop: axis === 'h' ? mirrorAcross(g.crop) : mirrorDown(g.crop),
  });

  // Whether a frame (fractions of a turned picture of w by h pixels) lies inside that picture levelled by `angle` degrees. A hundredth
  // of a pixel of slack keeps a frame that touches the edge from being refused by rounding.
  function inside(c, angle, w, h) {
    const a = angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    return [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]].every(([x, y]) => {
      const dx = x * w - w / 2, dy = y * h - h / 2;
      return Math.abs(dx * cos + dy * sin) <= w / 2 + 0.01 && Math.abs(-dx * sin + dy * cos) <= h / 2 + 0.01;
    });
  }
  const between = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });

  // The frame `to` if it fits, else the furthest point on the way there from the frame `from`, which fits.
  function limit(from, to, angle, w, h) {
    if (inside(to, angle, w, h)) return to;
    let low = 0, high = 1;
    for (let i = 0; i < 18; i++) { const mid = (low + high) / 2; if (inside(between(from, to, mid), angle, w, h)) low = mid; else high = mid; }
    return between(from, to, low);
  }

  // The frame, shrunk about its centre until it fits; centred first when even a speck of it does not fit where it is.
  function shrinkInside(c, angle, w, h) {
    if (inside(c, angle, w, h)) return c;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const scaled = (k) => ({ x: cx - c.w * k / 2, y: cy - c.h * k / 2, w: c.w * k, h: c.h * k });
    if (!inside(scaled(0.001), angle, w, h)) return shrinkInside({ x: 0.5 - c.w / 2, y: 0.5 - c.h / 2, w: c.w, h: c.h }, angle, w, h);
    let low = 0, high = 1;
    for (let i = 0; i < 18; i++) { const mid = (low + high) / 2; if (inside(scaled(mid), angle, w, h)) low = mid; else high = mid; }
    return scaled(low);
  }

  // Width over height of the frame the aspect asks for, or null for a free one.
  function ratioOf(g, w, h) {
    const base = { free: null, original: w / h, '1:1': 1, '4:5': 4 / 5, '3:2': 3 / 2, '16:9': 16 / 9 }[g.aspect];
    if (!base || g.aspect === '1:1') return base;
    const wide = Math.max(base, 1 / base);
    return g.portrait ? 1 / wide : wide;
  }

  // The largest frame of that ratio inside the frame c, centred on it.
  function fitRatio(c, ratio, angle, w, h) {
    if (!ratio) return c;
    const width = Math.min(c.w * w, c.h * h * ratio), height = width / ratio;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    return shrinkInside({ x: cx - width / w / 2, y: cy - height / h / 2, w: width / w, h: height / h }, angle, w, h);
  }

  const clamp = (v, low, high) => Math.min(Math.max(v, low), high);

  // The frame moved by dx, dy (fractions of the turned picture), kept inside the levelled picture. Along the picture's own axes the
  // places its centre may take form a rectangle, so a frame pushed against a tilted edge slides along it.
  function moveFrame(c, dx, dy, angle, w, h) {
    const a = angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const halfW = c.w * w / 2, halfH = c.h * h / 2;
    const roomU = Math.max(0, w / 2 - halfW * Math.abs(cos) - halfH * Math.abs(sin));
    const roomV = Math.max(0, h / 2 - halfW * Math.abs(sin) - halfH * Math.abs(cos));
    const px = (c.x + dx) * w + halfW - w / 2, py = (c.y + dy) * h + halfH - h / 2;
    const u = clamp(px * cos + py * sin, -roomU, roomU), v = clamp(-px * sin + py * cos, -roomV, roomV);
    return { x: (u * cos - v * sin + w / 2 - halfW) / w, y: (u * sin + v * cos + h / 2 - halfH) / h, w: c.w, h: c.h };
  }

  // The frame after one of its handles ('nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w') is dragged by dx, dy pixels of the turned
  // picture. With a ratio, the opposite corner (or the middle of the opposite side) stays put and the frame keeps its shape.
  function resizeFrame(c, handle, dx, dy, ratio, w, h) {
    const least = Math.min(40, w / 4, h / 4);
    let [x0, y0, x1, y1] = [c.x * w, c.y * h, (c.x + c.w) * w, (c.y + c.h) * h];
    const from = { x0, y0, x1, y1 };
    if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - least);
    if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + least, w);
    if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - least);
    if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + least, h);
    if (!ratio) return { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h };

    const side = handle.length === 1;
    const heightLed = side && 'ns'.includes(handle);
    const anchorX = handle.includes('e') ? from.x0 : from.x1, anchorY = handle.includes('s') ? from.y0 : from.y1;
    const roomW = side ? w : handle.includes('e') ? w - anchorX : anchorX;
    const roomH = side ? h : handle.includes('s') ? h - anchorY : anchorY;
    let width = heightLed ? (y1 - y0) * ratio : side ? x1 - x0 : Math.max(x1 - x0, (y1 - y0) * ratio);
    width = clamp(width, Math.max(least, least * ratio), Math.min(roomW, roomH * ratio));
    const height = width / ratio;
    if (side) {
      const centreX = (from.x0 + from.x1) / 2, centreY = (from.y0 + from.y1) / 2;
      if (heightLed) { x0 = clamp(centreX - width / 2, 0, w - width); y0 = handle === 'n' ? from.y1 - height : from.y0; }
      else { y0 = clamp(centreY - height / 2, 0, h - height); x0 = handle === 'w' ? from.x1 - width : from.x0; }
    } else {
      x0 = handle.includes('w') ? anchorX - width : anchorX;
      y0 = handle.includes('n') ? anchorY - height : anchorY;
    }
    return { x: x0 / w, y: y0 / h, w: width / w, h: height / h };
  }

  window.editorGeometry = { neutral, isNeutral, isWhole, tidy, turnedSize, outputSize, matrix, rotate, flip, inside, between, limit, shrinkInside, ratioOf, fitRatio, moveFrame, resizeFrame };
})();
