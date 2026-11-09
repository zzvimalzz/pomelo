// SPDX-License-Identifier: AGPL-3.0-or-later
// The wheel's geometry, shared by the wheel page and the animation on the Settings Help page: a 400 x 400 box, outer radius 160, inner 68, a gap of
// 3 degrees between segments, each inset by 5 and rounded by a stroke of its own colour.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const CX = 200, CY = 200, R_OUT = 160, R_IN = 68, GAP_DEG = 3, PAD = 5;

  const svg = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent?.appendChild(n);
    return n;
  };
  const pt = (r, deg) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)];

  function segmentPath(mid, step) {
    const ro = R_OUT - PAD, ri = R_IN + PAD;
    const half = step / 2 - GAP_DEG / 2;
    const off = (r) => (PAD / r) * (180 / Math.PI);
    const [a0o, a1o] = [mid - half + off(ro), mid + half - off(ro)];
    const [a0i, a1i] = [mid - half + off(ri), mid + half - off(ri)];
    const large = a1o - a0o > 180 ? 1 : 0;
    const [x0, y0] = pt(ro, a0o), [x1, y1] = pt(ro, a1o), [x2, y2] = pt(ri, a1i), [x3, y3] = pt(ri, a0i);
    return `M${x0} ${y0} A${ro} ${ro} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${ri} ${ri} 0 ${large} 0 ${x3} ${y3}Z`;
  }

  window.pomeloWheelShapes = { CX, CY, R_OUT, R_IN, svg, pt, segmentPath };
})();
