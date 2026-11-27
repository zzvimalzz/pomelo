// SPDX-License-Identifier: AGPL-3.0-or-later
// The shader that draws a picture: one triangle that covers the canvas, and a fragment shader that finds, for every canvas pixel, the
// source pixel under it, through the picture's turn, flips, level and crop. A classic script that adds window.editorShaders.
window.editorShaders = {
  vertex: `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`,
  // uCanvas: the canvas in pixels. uOrigin: where the shown picture's top-left corner is on it. uOut: the shown picture in pixels, after
  // the turn and crop. uZoom: canvas pixels for each picture pixel. uGeom: from a point of the shown picture to the source's, both from
  // 0 to 1. uFlip: the canvas is read back with readPixels, which starts at the bottom row, so rows are counted from the bottom.
  // uVeil: how much of what lies outside the shown picture is drawn, darkened: 0 for none of it, 1 in the crop view. Inside the shown
  // picture a point may stray a source pixel past the source's edge, so rounding leaves no clear rim on a levelled one; outside it the
  // picture ends at its own edge. The texture is sampled before the bounds tests so the mipmap level comes from every pixel's
  // neighbours.
  // uOn: 1 when any adjustment is off its neutral value; a picture with none goes through untouched, not through a round trip that could
  // move a value by one. uGain: white balance and exposure, a multiplier of the linear light. uTone: the highlights and shadows lift, then
  // the black point and the white point. uContrast, and uColour: the vibrance and the factor of the saturation.
  fragment: `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uOut;
uniform float uZoom;
uniform mat3 uGeom;
uniform float uFlip;
uniform float uVeil;
uniform float uOn;
uniform vec3 uGain;
uniform vec4 uTone;
uniform float uContrast;
uniform vec2 uColour;
out vec4 colour;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 toLinear(vec3 s) { return mix(s / 12.92, pow((s + 0.055) / 1.055, vec3(2.4)), step(0.04045, s)); }
vec3 toSrgb(vec3 l) { l = max(l, 0.0); return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l)); }
vec3 rgbToHsl(vec3 c) {
  float high = max(c.r, max(c.g, c.b)), low = min(c.r, min(c.g, c.b)), l = (high + low) * 0.5, d = high - low, h = 0.0, s = 0.0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2.0 - high - low) : d / (high + low);
    h = high == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : high == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  }
  return vec3(h / 6.0, s, l);
}
float hueToChannel(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hslToRgb(vec3 c) {
  if (c.y <= 0.0) return vec3(c.z);
  float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y, p = 2.0 * c.z - q;
  return vec3(hueToChannel(p, q, c.x + 1.0 / 3.0), hueToChannel(p, q, c.x), hueToChannel(p, q, c.x - 1.0 / 3.0));
}
vec3 adjust(vec3 s) {
  vec3 p = toSrgb(toLinear(s) * uGain);
  float l = dot(p, LUMA);
  p += uTone.x * smoothstep(0.5, 1.0, l) + uTone.y * (1.0 - smoothstep(0.0, 0.5, l));
  p = (p - uTone.z) / (uTone.w - uTone.z);
  p += uContrast * (p - 0.5) * max(1.0 - abs(2.0 * p - 1.0), 0.0);
  p = clamp(p, 0.0, 1.0);
  if (uColour.x != 0.0 || uColour.y != 1.0) {
    vec3 hsl = rgbToHsl(p);
    hsl.y += uColour.x * (1.0 - hsl.y) * hsl.y * (uColour.x > 0.0 ? 1.0 : 2.0);
    hsl.y = clamp(hsl.y * uColour.y, 0.0, 1.0);
    p = hslToRgb(hsl);
  }
  return p;
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uFlip > 0.5 ? gl_FragCoord.y : uCanvas.y - gl_FragCoord.y);
  vec2 shown = (pixel - uOrigin) / (uZoom * uOut);
  vec2 at = (uGeom * vec3(shown, 1.0)).xy;
  vec4 c = texture(uSource, at);
  if (uOn > 0.5) c.rgb = adjust(c.rgb);
  bool kept = shown.x >= 0.0 && shown.y >= 0.0 && shown.x <= 1.0 && shown.y <= 1.0;
  vec2 slack = kept ? 1.0 / vec2(textureSize(uSource, 0)) : vec2(0.0);
  bool clear = any(lessThan(at, -slack)) || any(greaterThan(at, 1.0 + slack));
  colour = clear ? vec4(0.0) : kept ? c : vec4(c.rgb * (1.0 - 0.55 * uVeil), c.a * uVeil);
}`,
};
