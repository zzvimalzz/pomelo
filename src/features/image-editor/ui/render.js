// SPDX-License-Identifier: AGPL-3.0-or-later
// The WebGL2 side of the editor: a picture becomes a texture, and a frame draws it into the canvas at a zoom and a place. Only the pixels
// on screen are ever computed, whatever the picture's size. Saving draws the same shader at full size into a canvas that is not shown. A classic script that adds window.editorRender.
(() => {
  const { vertex, fragment } = window.editorShaders;
  const geometryOf = window.editorGeometry;
  const MIPMAP_BELOW = 0.5;

  function program(gl) {
    const build = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const p = gl.createProgram();
    gl.attachShader(p, build(gl.VERTEX_SHADER, vertex));
    gl.attachShader(p, build(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // Null when the page has no WebGL2.
  function create(canvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const prog = program(gl);
    const uniform = Object.fromEntries(['uSource', 'uCanvas', 'uOrigin', 'uOut', 'uZoom', 'uGeom', 'uFlip', 'uVeil'].map((name) => [name, gl.getUniformLocation(prog, name)]));
    const maxSide = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.useProgram(prog);
    gl.uniform1i(uniform.uSource, 0);
    gl.clearColor(0, 0, 0, 0);

    // Mipmaps are built once; below 50 % zoom plain linear filtering aliases badly, above it the mipmaps only blur.
    function upload(width, height, pixels) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return texture;
    }

    // picture: { texture, width, height }; geometry: its turn, flips, level and crop; zoom: canvas pixels for each picture pixel; x, y: the
    // shown picture's top-left corner on the canvas; flip: draw the rows from the bottom, for reading the pixels back; veil: how much of
    // what the crop leaves out is drawn round it, darkened (0 to 1). A null picture clears the canvas.
    function draw(picture, geometry, zoom, x, y, flip = false, veil = 0) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!picture) return;
      gl.bindTexture(gl.TEXTURE_2D, picture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, zoom < MIPMAP_BELOW ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.uniform2f(uniform.uCanvas, canvas.width, canvas.height);
      gl.uniform2f(uniform.uOrigin, x, y);
      gl.uniform2f(uniform.uOut, ...geometryOf.outputSize(geometry, picture.width, picture.height));
      gl.uniform1f(uniform.uZoom, zoom);
      gl.uniformMatrix3fv(uniform.uGeom, false, geometryOf.matrix(geometry, picture.width, picture.height));
      gl.uniform1f(uniform.uFlip, flip ? 1 : 0);
      gl.uniform1f(uniform.uVeil, veil);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function read(width, height) {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }

    const release = () => gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { fits: (width, height) => width <= maxSide && height <= maxSide, upload, drop: (texture) => gl.deleteTexture(texture), draw, read, release };
  }

  // picture: { width, height, pixels }. Returns the picture as it is shown, as { width, height, rgba } with the top row first. The
  // pixels are read in the task that draws them, because the browser may clear a canvas after it has been shown.
  function exportPixels(picture, geometry) {
    const [width, height] = geometryOf.outputSize(geometry, picture.width, picture.height);
    const renderer = create(new OffscreenCanvas(width, height));
    if (!renderer) throw new Error('no WebGL2');
    try {
      const texture = renderer.upload(picture.width, picture.height, picture.pixels);
      renderer.draw({ texture, width: picture.width, height: picture.height }, geometry, 1, 0, 0, true);
      return { width, height, rgba: renderer.read(width, height) };
    } finally {
      renderer.release();
    }
  }

  window.editorRender = { create, exportPixels };
})();
