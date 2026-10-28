// @ts-check
/**
 * ittybitty texture helper
 *
 * Feeds an image, a canvas or an image URL to a sampler uniform. Only the
 * effects that read images import it. Alongside `<name>` the shader receives
 * `<name>Size` (pixels) and `<name>Ready` (0 until the first upload).
 *
 * https://ittybitty.dev (MIT)
 */

/**
 * @typedef {object} TextureOptions
 * @property {boolean} [mipmaps] Build mipmaps, so shaders can blur cheaply with a LOD bias.
 * @property {boolean} [repeat] Tile instead of clamping at the edges.
 */

/**
 * @param {import("./runtime.js").Context} ctx
 * @param {string} name Sampler uniform name, e.g. 'uImage'.
 * @param {number} unit Texture unit, 0 to 7.
 * @param {TextureOptions} [options]
 */
export function texture(ctx, name, unit, options = {}) {
  const { gl } = ctx;
  unit = ctx.textureUnit(unit);
  /** @type {WebGLTexture | null} */
  let tex = null;
  /** @type {TexImageSource | null} */
  let source = null;
  let url = '';
  let token = 0;

  const upload = () => {
    if (!source) return;
    if (!tex) tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const wrap = options.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (options.mipmaps) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    const s = /** @type {{ width: number, height: number, naturalWidth?: number, naturalHeight?: number }} */ (source);
    ctx.sampler(name, unit);
    ctx.uniform(`${name}Size`, [s.naturalWidth || s.width, s.naturalHeight || s.height]);
    ctx.uniform(`${name}Ready`, 1);
    ctx.invalidate();
  };

  return {
    /**
     * Use an image URL, an element or a canvas. The same URL is not reloaded.
     * @param {string | TexImageSource | null} next
     */
    set(next) {
      if (typeof next === 'string') {
        if (next === url) return;
        url = next;
        const mine = ++token;
        if (!next) return;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
          if (mine !== token) return;
          source = img;
          upload();
        };
        img.src = next;
      } else {
        url = '';
        token++;
        source = next;
        upload();
      }
    },
    /** Re-upload after the canvas's contents changed. */
    refresh: upload,
    /** Re-create after a WebGL context restore. */
    restore() {
      tex = null;
      upload();
    },
    destroy() {
      token++;
      if (tex) gl.deleteTexture(tex);
      tex = null;
      source = null;
    },
  };
}
