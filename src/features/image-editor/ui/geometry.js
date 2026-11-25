// SPDX-License-Identifier: AGPL-3.0-or-later
// How a picture is turned and flipped: the geometry object of an edit, the size of the result, and the matrix the shader uses to find,
// for a point of the result, the point of the source it shows. The picture is turned first and then flipped, so a flip stays on the
// same side of the screen when the picture is turned. A classic script that adds window.editorGeometry.
(() => {
  const neutral = () => ({ rotate: 0, flipH: false, flipV: false });
  const isNeutral = (g) => g.rotate === 0 && !g.flipH && !g.flipV;
  const outputSize = (g, width, height) => (g.rotate % 180 ? [height, width] : [width, height]);

  // Rows of a 3 x 3 matrix on (u, v, 1), where u and v run from 0 to 1 across the picture.
  const UNDO_TURN = {
    0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    90: [0, 1, 0, -1, 0, 1, 0, 0, 1],
    180: [-1, 0, 1, 0, -1, 1, 0, 0, 1],
    270: [0, -1, 1, 1, 0, 0, 0, 0, 1],
  };
  const times = (a, b) => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; });

  // Column-major, as WebGL wants it. The flip is undone first, then the turn.
  function matrix(g) {
    const flip = [g.flipH ? -1 : 1, 0, g.flipH ? 1 : 0, 0, g.flipV ? -1 : 1, g.flipV ? 1 : 0, 0, 0, 1];
    const rows = times(UNDO_TURN[g.rotate], flip);
    return Float32Array.from([0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => rows[i]));
  }

  // One visual quarter turn to the right (dir 1) or left (-1). With one flip on, the stored turn runs the other way.
  const rotate = (g, dir) => ({ ...g, rotate: (g.rotate + (g.flipH !== g.flipV ? -dir : dir) * 90 + 360) % 360 });
  const flip = (g, axis) => (axis === 'h' ? { ...g, flipH: !g.flipH } : { ...g, flipV: !g.flipV });

  window.editorGeometry = { neutral, isNeutral, outputSize, matrix, rotate, flip };
})();
