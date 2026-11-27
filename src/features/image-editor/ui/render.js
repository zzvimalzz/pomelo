// SPDX-License-Identifier: AGPL-3.0-or-later
// The WebGL2 side of the editor: a picture becomes a texture, and a frame draws it into the canvas at a zoom and a place. Only the pixels
// on screen are ever computed, whatever the picture's size. Saving draws the same shader at full size into a canvas that is not shown. A classic script that adds window.editorRender.
(() => {
  const { vertex, fragment } = window.editorShaders;
  const geometryOf = window.editorGeometry;
  const MIPMAP_BELOW = 0.5;
  const ADJUSTMENTS = Object.keys(window.editorModel.RANGES);

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
    const uniform = Object.fromEntries(['uSource', 'uCanvas', 'uOrigin', 'uOut', 'uZoom', 'uGeom', 'uFlip', 'uVeil', 'uOn', 'uGain', 'uTone', 'uContrast', 'uColour'].map((name) => [name, gl.getUniformLocation(prog, name)]));
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

    // The adjustments of an edit as the shader wants them. White balance is scaled to keep the luminance, so Temperature and Tint change
    // the colour and not the brightness.
    function adjustments(edit) {
      const t = edit.temperature / 100, n = edit.tint / 100;
      const balance = [1 + 0.3 * t, 1 - 0.25 * n, 1 - 0.3 * t];
      const scale = 2 ** edit.exposure / (0.2126 * balance[0] + 0.7152 * balance[1] + 0.0722 * balance[2]);
      const black = -edit.blacks / 100 * 0.15;
      gl.uniform1f(uniform.uOn, ADJUSTMENTS.some((key) => edit[key] !== 0) ? 1 : 0);
      gl.uniform3f(uniform.uGain, ...balance.map((v) => v * scale));
      gl.uniform4f(uniform.uTone, edit.highlights / 100 * 0.35, edit.shadows / 100 * 0.35, black, 1 - edit.whites / 100 * 0.15);
      gl.uniform1f(uniform.uContrast, edit.contrast / 100);
      gl.uniform2f(uniform.uColour, edit.vibrance / 100, 1 + edit.saturation / 100);
    }

    // picture: { texture, width, height }; edit: the picture's turn, flips, level and crop (its geometry) and its adjustments; zoom: target
    // pixels for each picture pixel; x, y: the shown picture's top-left corner on the target; flip: draw the rows from the bottom, for
    // reading the pixels back; veil: how much of what the crop leaves out is drawn round it, darkened (0 to 1); size: the target, the
    // canvas unless given. A null picture clears the canvas.
    function draw(picture, { edit, zoom, x, y, flip = false, veil = 0, size = [canvas.width, canvas.height] }) {
      gl.viewport(0, 0, size[0], size[1]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!picture) return;
      const { geometry } = edit;
      gl.bindTexture(gl.TEXTURE_2D, picture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, zoom < MIPMAP_BELOW ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.uniform2f(uniform.uCanvas, size[0], size[1]);
      gl.uniform2f(uniform.uOrigin, x, y);
      // In the crop view the frame is not rounded to whole pixels: at a large zoom it would move in steps.
      gl.uniform2f(uniform.uOut, ...(veil ? geometryOf.cutSize : geometryOf.outputSize)(geometry, picture.width, picture.height));
      gl.uniform1f(uniform.uZoom, zoom);
      gl.uniformMatrix3fv(uniform.uGeom, false, geometryOf.matrix(geometry, picture.width, picture.height));
      gl.uniform1f(uniform.uFlip, flip ? 1 : 0);
      gl.uniform1f(uniform.uVeil, veil);
      adjustments(edit);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function read(width, height) {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }

    // The picture as the edit shows it, at most `longest` pixels along its long side, as { width, height, rgba } with the top row first.
    // It is drawn off screen, so the canvas is left as it was.
    function sample(picture, edit, longest) {
      const [w, h] = geometryOf.outputSize(edit.geometry, picture.width, picture.height);
      const k = Math.min(1, longest / Math.max(w, h));
      const width = Math.max(1, Math.round(w * k)), height = Math.max(1, Math.round(h * k));
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      const target = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      draw(picture, { edit, zoom: width / w, x: 0, y: 0, flip: true, size: [width, height] });
      const rgba = read(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(target);
      gl.deleteTexture(texture);
      return { width, height, rgba };
    }

    const release = () => gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { fits: (width, height) => width <= maxSide && height <= maxSide, upload, drop: (texture) => gl.deleteTexture(texture), draw, read, sample, release };
  }

  // picture: { width, height, pixels }. Returns the picture as it is shown, as { width, height, rgba } with the top row first. The
  // pixels are read in the task that draws them, because the browser may clear a canvas after it has been shown.
  function exportPixels(picture, edit) {
    const [width, height] = geometryOf.outputSize(edit.geometry, picture.width, picture.height);
    const renderer = create(new OffscreenCanvas(width, height));
    if (!renderer) throw new Error('no WebGL2');
    try {
      const texture = renderer.upload(picture.width, picture.height, picture.pixels);
      renderer.draw({ texture, width: picture.width, height: picture.height }, { edit, zoom: 1, x: 0, y: 0, flip: true });
      return { width, height, rgba: renderer.read(width, height) };
    } finally {
      renderer.release();
    }
  }

  window.editorRender = { create, exportPixels };
})();
