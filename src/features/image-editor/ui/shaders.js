// SPDX-License-Identifier: AGPL-3.0-or-later
// The shader that draws a picture: one triangle that covers the canvas, and a fragment shader that finds, for every canvas pixel, the
// source pixel under it, through the picture's turn and flips. A classic script that adds window.editorShaders.
window.editorShaders = {
  vertex: `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`,
  // uCanvas: the canvas in pixels. uOrigin: where the shown picture's top-left corner is on it. uOut: the shown picture in pixels, after
  // the turn. uZoom: canvas pixels for each picture pixel. uGeom: from a point of the shown picture to the source's, both from 0 to 1.
  // uFlip: the canvas is read back with readPixels, which starts at the bottom row, so rows are counted from the bottom. The texture
  // is sampled before the bounds test so the mipmap level comes from every pixel's neighbours.
  fragment: `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uOut;
uniform float uZoom;
uniform mat3 uGeom;
uniform float uFlip;
out vec4 colour;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uFlip > 0.5 ? gl_FragCoord.y : uCanvas.y - gl_FragCoord.y);
  vec2 shown = (pixel - uOrigin) / (uZoom * uOut);
  vec4 c = texture(uSource, (uGeom * vec3(shown, 1.0)).xy);
  colour = (shown.x < 0.0 || shown.y < 0.0 || shown.x > 1.0 || shown.y > 1.0) ? vec4(0.0) : c;
}`,
};
