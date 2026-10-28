// @ts-check
/**
 * ittybitty container
 *
 * Puts a whole stack in a shape: the element's own rounded box (its size and
 * all four CSS corner radii, so cards, pills, buttons and circles just work),
 * some text, or an SVG path. Applied once to the finished picture by
 * layers.js, so it works the same for every effect: each layer is cut to
 * the shape, and the finish lights the result once.
 *
 * Text and paths become a signed distance field, built on the CPU once per
 * change (a Felzenszwalb distance transform of the outline), so the edge is
 * crisp at any size and the finish can light it like an object: an edge
 * that catches the light, a rim, a gloss across the top and a soft inner
 * shadow, all off by default. The box needs no texture: its distance is
 * exact.
 *
 * https://ittybitty.dev (MIT)
 */

/**
 * @typedef {object} ShapeOptions
 * @property {'none' | 'element' | 'text' | 'path'} [kind] What the stack fills. Default none: the whole canvas.
 * @property {string} [text] The text, for kind 'text'.
 * @property {string} [font] A font for the text: 'sans', 'serif', 'mono', 'rounded', or any CSS font family the page has loaded. Default 'sans'.
 * @property {string} [path] An SVG path in a 0 0 100 100 box, for kind 'path'.
 * @property {'contain' | 'cover'} [fit] How text or a path fits the canvas. Default contain.
 * @property {number} [padding] Space kept clear round the shape, in CSS pixels.
 * @property {number} [edgeLight] Light caught along the lit edge, 0 to 1.5.
 * @property {number} [rim] A hairline highlight right at the edge, 0 to 1.5.
 * @property {number} [gloss] A soft reflection across the top, 0 to 1.5.
 * @property {number} [innerShadow] Shade along the far edge, 0 to 1.5.
 */

/** @type {Required<ShapeOptions>} */
export const shapeDefaults = {
  kind: 'none',
  text: 'itty',
  font: 'sans',
  path: '',
  fit: 'contain',
  padding: 24,
  edgeLight: 0,
  rim: 0,
  gloss: 0,
  innerShadow: 0,
};

/** Ready-made paths, in a 0 0 100 100 box. */
export const SHAPE_PATHS = {
  circle: 'M50 2a48 48 0 1 0 0.01 0Z',
  star: 'M50 4 L62 37 L97 38 L69 59 L79 93 L50 73 L21 93 L31 59 L3 38 L38 37 Z',
  heart: 'M50 90 C20 70 3 52 3 31 C3 15 15 4 29 4 C39 4 46 10 50 18 C54 10 61 4 71 4 C85 4 97 15 97 31 C97 52 80 70 50 90 Z',
  blob: 'M52 4 C75 4 96 19 96 45 C96 72 77 96 49 96 C22 96 4 77 4 52 C4 25 27 4 52 4 Z',
};

const FONTS = {
  sans: '800 SIZE ui-sans-serif, system-ui, -apple-system, sans-serif',
  serif: '700 SIZE ui-serif, Georgia, "Times New Roman", serif',
  mono: '700 SIZE ui-monospace, Menlo, Consolas, monospace',
  rounded: '800 SIZE ui-rounded, "SF Pro Rounded", "Nunito", ui-sans-serif, sans-serif',
};

// The field: the outline's glyph size in texels, and how far the distance
// reaches each side of the edge (room for glows round it, and depth inside).
const TEXT_SIZE = 220;
const PATH_SIZE = 320;
const SPREAD = 48;
// "Unreached" in the distance transform: finite, so the arithmetic never meets Infinity - Infinity.
const FAR = 1e20;

export const CONTAINER = /* glsl */ `
uniform float uIbShape;      // 0 none, 1 element, 2 outline
uniform vec4 uIbRadii;       // CSS px: top right, bottom right, top left, bottom left
uniform float uIbPad;        // CSS px
uniform sampler2D uIbField;  // signed distance, 0.5 at the edge, rising outside
uniform vec3 uIbFieldSize;   // width, height and the margin round the outline, in texels
uniform float uIbCover;      // 0 contain, 1 cover
uniform vec4 uIbFinish;      // edge light, rim, gloss, inner shadow

// Signed distance to the shape's edge in device pixels: negative inside.
float ibDistance(vec2 frag) {
  float pad = uIbPad * uPixelRatio;
  vec2 p = frag - 0.5 * uResolution;
  if (uIbShape < 1.5) {
    vec2 h = max(0.5 * uResolution - pad, vec2(1.0));
    vec2 rr = p.x > 0.0 ? uIbRadii.xy : uIbRadii.zw;
    float r = min((p.y > 0.0 ? rr.x : rr.y) * uPixelRatio, min(h.x, h.y));
    vec2 q = abs(p) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  vec2 inner = max(uIbFieldSize.xy - 2.0 * uIbFieldSize.z, vec2(1.0));
  vec2 k = max(uResolution - 2.0 * pad, vec2(1.0)) / inner;
  float s = uIbCover > 0.5 ? max(k.x, k.y) : min(k.x, k.y);
  // Texels, with y flipped: the outline was drawn top down.
  vec2 t = p / s * vec2(1.0, -1.0) + 0.5 * uIbFieldSize.xy;
  vec2 c = clamp(t, vec2(0.5), uIbFieldSize.xy - 0.5);
  float d = (texture(uIbField, c / uIbFieldSize.xy).r - 0.5) * ${(2 * SPREAD).toFixed(1)};
  // Past the field's edge, carry on outward.
  return (d + length(t - c)) * s;
}

// Cut one layer (premultiplied) to the shape.
vec4 ibClip(vec4 c, vec2 frag) {
  if (uIbShape < 0.5) return c;
  return c * clamp(0.5 - ibDistance(frag), 0.0, 1.0);
}

// Light the finished, already cut, picture like an object: only inside the
// shape, so anything drawn round it (an edge effect's glow) is left be.
vec4 ibFinish(vec4 c) {
  if (uIbShape < 0.5 || dot(uIbFinish, vec4(1.0)) <= 0.0) return c;
  vec2 frag = gl_FragCoord.xy;
  float d = ibDistance(frag);
  if (d >= 0.5) return c;
  float px = max(uPixelRatio, 1.0);
  vec2 g = vec2(ibDistance(frag + vec2(1.0, 0.0)) - ibDistance(frag - vec2(1.0, 0.0)),
                ibDistance(frag + vec2(0.0, 1.0)) - ibDistance(frag - vec2(0.0, 1.0)));
  // The bevel: a band just inside the edge, a few pixels wide, curving over.
  float bevel = 1.0 - smoothstep(0.0, 14.0 * px, -d);
  vec2 n = normalize(g + 1e-6) * bevel;
  float lit = dot(n, normalize(vec2(-0.55, 0.8)));
  vec3 rgb = c.rgb;
  // Edge light: the side facing the light catches it.
  rgb += uIbFinish.x * max(lit, 0.0) * 0.6 * c.a;
  // Inner shadow: the far side falls into shade.
  rgb *= 1.0 - uIbFinish.w * max(-lit, 0.0) * 0.5;
  // Rim: a hairline highlight right at the edge, as on glass and metal.
  rgb += uIbFinish.y * exp(d / (1.2 * px)) * 0.5 * (0.6 + 0.4 * max(lit, 0.0)) * c.a;
  // Gloss: a soft reflection across the upper part, stopping short of the edge.
  float pad = uIbPad * uPixelRatio;
  float top = clamp((frag.y - pad) / max(uResolution.y - 2.0 * pad, 1.0), 0.0, 1.0);
  rgb += uIbFinish.z * 0.24 * smoothstep(0.5, 0.95, top) * smoothstep(0.0, 10.0 * px, -d) * c.a;
  return vec4(min(rgb, vec3(c.a)), c.a);
}
`;

/** One axis of the squared Euclidean distance transform (Felzenszwalb and Huttenlocher). */
function edt1d(/** @type {Float64Array} */ f, /** @type {number} */ n, /** @type {Float64Array} */ d, /** @type {Int32Array} */ v, /** @type {Float64Array} */ z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (2 * q - 2 * r);
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  for (let q = 0, j = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const r = v[j];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

/** Squared distance from each cell to the nearest cell where grid is 0, in place. */
function edt(/** @type {Float64Array} */ grid, /** @type {number} */ w, /** @type {number} */ h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

/**
 * Draw an outline and turn it into a signed distance field: one byte per
 * texel, 0.5 at the edge, rising outside, covering SPREAD texels each way.
 * Partly covered edge texels place the edge within the texel, so it is
 * smooth, not stepped.
 * @param {{ kind: string, text: string, font: string, path: string }} o
 */
export function outlineField(o) {
  const canvas = document.createElement('canvas');
  const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  const margin = SPREAD + 4;
  if (o.kind === 'text') {
    const preset = /** @type {Record<string, string>} */ (FONTS)[o.font || 'sans'];
    const font = (preset ?? `700 SIZE ${o.font}`).replace('SIZE', `${TEXT_SIZE}px`);
    const text = o.text || ' ';
    c.font = font;
    const m = c.measureText(text);
    const ascent = m.actualBoundingBoxAscent || TEXT_SIZE * 0.75;
    const descent = m.actualBoundingBoxDescent || TEXT_SIZE * 0.2;
    const left = m.actualBoundingBoxLeft || 0;
    const right = m.actualBoundingBoxRight || m.width;
    canvas.width = Math.min(4096, Math.ceil(left + right) + 2 * margin);
    canvas.height = Math.ceil(ascent + descent) + 2 * margin;
    c.font = font;
    c.fillStyle = '#fff';
    c.textBaseline = 'alphabetic';
    c.fillText(text, margin + left, margin + ascent);
  } else {
    canvas.width = canvas.height = PATH_SIZE + 2 * margin;
    c.setTransform(PATH_SIZE / 100, 0, 0, PATH_SIZE / 100, margin, margin);
    c.fillStyle = '#fff';
    try {
      c.fill(new Path2D(o.path || SHAPE_PATHS.star));
    } catch {}
  }
  const { width: w, height: h } = canvas;
  const alpha = c.getImageData(0, 0, w, h).data;
  const outer = new Float64Array(w * h);
  const inner = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i * 4 + 3] / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = FAR;
    } else if (a <= 0) {
      outer[i] = FAR;
      inner[i] = 0;
    } else {
      // An edge texel: the edge lies part way across it.
      const off = Math.max(0, 0.5 - a);
      const offIn = Math.max(0, a - 0.5);
      outer[i] = off * off;
      inner[i] = offIn * offIn;
    }
  }
  edt(outer, w, h);
  edt(inner, w, h);
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const dist = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    data[i] = Math.max(0, Math.min(255, Math.round((0.5 + dist / (2 * SPREAD)) * 255)));
  }
  return { data, width: w, height: h, margin };
}

/** The corners of the canvas, or if it has none, its container's, in CSS px (top right, bottom right, top left, bottom left). */
export function cornerRadii(/** @type {HTMLCanvasElement} */ canvas) {
  const read = (/** @type {Element} */ el) => {
    const s = getComputedStyle(el);
    const w = el.getBoundingClientRect().width;
    const px = (/** @type {string} */ v) => {
      const first = v.split(' ')[0];
      return first.endsWith('%') ? (parseFloat(first) / 100) * w : parseFloat(first) || 0;
    };
    return [px(s.borderTopRightRadius), px(s.borderBottomRightRadius), px(s.borderTopLeftRadius), px(s.borderBottomLeftRadius)];
  };
  const own = read(canvas);
  if (own.some((r) => r > 0) || !canvas.parentElement) return own;
  return read(canvas.parentElement);
}

/**
 * Wire the shape: corners for the element, a distance field for text and
 * paths. Call from attach; forward update, restore and destroy.
 * @param {import('./runtime.js').Context} ctx
 * @param {number} unit A texture unit nothing else uses.
 */
export function container(ctx, unit) {
  const { gl, canvas } = ctx;
  /** @type {WebGLTexture | null} */
  let tex = null;
  /** @type {ReturnType<typeof outlineField> | null} */
  let field = null;
  let key = '';
  let kind = 'none';
  /** @type {Required<ShapeOptions>} */
  let opts = shapeDefaults;
  let pending = 0;

  const upload = () => {
    if (!field) return;
    tex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, field.width, field.height, 0, gl.RED, gl.UNSIGNED_BYTE, field.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    ctx.sampler('uIbField', unit);
    ctx.uniform('uIbFieldSize', [field.width, field.height, field.margin]);
    ctx.invalidate();
  };

  const build = () => {
    pending = 0;
    if (kind !== 'text' && kind !== 'path') return;
    field = outlineField(opts);
    upload();
  };

  const corners = () => {
    if (kind !== 'element') return;
    ctx.uniform('uIbRadii', cornerRadii(canvas));
    ctx.invalidate();
  };
  // Corners can change with the size (percentages) or the container's styles.
  const watch = new ResizeObserver(corners);
  watch.observe(canvas);
  if (canvas.parentElement) watch.observe(canvas.parentElement);
  // A web font that arrives late redraws the text in it.
  const fonts = () => kind === 'text' && build();
  document.fonts?.addEventListener('loadingdone', fonts);

  return {
    /** @param {ShapeOptions} [next] */
    update(next) {
      opts = { ...shapeDefaults, ...next };
      kind = opts.kind;
      ctx.uniform('uIbShape', kind === 'none' ? 0 : kind === 'element' ? 1 : 2);
      ctx.uniform('uIbPad', Math.max(0, opts.padding));
      ctx.uniform('uIbCover', opts.fit === 'cover' ? 1 : 0);
      ctx.uniform('uIbFinish', [opts.edgeLight, opts.rim, opts.gloss, opts.innerShadow]);
      ctx.uniform('uIbRadii', [0, 0, 0, 0]);
      corners();
      const next_key = kind === 'text' ? `t${opts.font}\u0000${opts.text}` : kind === 'path' ? `p${opts.path}` : '';
      if (next_key && next_key !== key) {
        key = next_key;
        // Typing builds once it pauses, not on every key.
        if (field) {
          clearTimeout(pending);
          pending = window.setTimeout(build, 90);
        } else build();
      }
      ctx.invalidate();
    },
    restore() {
      tex = null;
      upload();
    },
    destroy() {
      clearTimeout(pending);
      watch.disconnect();
      document.fonts?.removeEventListener('loadingdone', fonts);
      if (tex) gl.deleteTexture(tex);
      tex = null;
    },
  };
}
