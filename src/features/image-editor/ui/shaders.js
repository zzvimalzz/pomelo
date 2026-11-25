// SPDX-License-Identifier: AGPL-3.0-or-later
// The shader that draws a picture: one triangle that covers the canvas, and a fragment shader that finds, for every canvas pixel, the
// picture pixel under it. A classic script that adds window.editorShaders.
window.editorShaders = {
  vertex: `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`,
  // uCanvas: the canvas in pixels. uOrigin: where the picture's top-left corner is on it. uImage: the picture in pixels. uZoom: canvas
  // pixels for each picture pixel. The texture is sampled before the bounds test so the mipmap level comes from every pixel's neighbours.
  fragment: `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uImage;
uniform float uZoom;
out vec4 colour;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 uv = (pixel - uOrigin) / (uZoom * uImage);
  vec4 c = texture(uSource, uv);
  colour = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : c;
}`,
};
