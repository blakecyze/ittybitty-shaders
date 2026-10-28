// @ts-check
/**
 * ittybitty/bokeh
 *
 * Out-of-focus lights drifting in depth, the way a fast lens sees a city at
 * night wide open. Each light is a disc the shape of the aperture, sized by
 * its distance from the focal plane, with a lens's real character: bright
 * soap-bubble rims and faint onion rings, purple and green fringes that swap
 * sides either side of focus, and cat's-eye discs clipped into lemons
 * towards the corners. Lights that land in focus shrink to pinpoints with
 * tiny star flares. The focus slowly breathes, and the pointer pulls it.
 *
 * Each light is drawn as a sprite, one small octagon, added into an offscreen
 * buffer; the effect's own pass then tones that light and lays it over the
 * backdrop. So each pixel only shades the few lights that actually reach it.
 *
 * https://ittybitty.dev/shaders/bokeh (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} BokehOptions
 * @property {boolean} showBackground The dark backdrop. Off, only the lights are drawn, over the page.
 * @property {number} speed How fast the lights drift and the focus breathes.
 * @property {number} drift Which way the lights float, from falling (-1) to rising (1).
 * @property {number} twinkle How much each light flickers and pulses.
 * @property {'circle' | 'hexagon' | 'octagon' | 'heart' | 'star'} aperture The shape of the lens opening, which every out-of-focus light takes.
 * @property {number} density How many lights there are.
 * @property {number} size How large the out-of-focus discs grow.
 * @property {number} focus The distance in focus, from near to far.
 * @property {number} breathing How far the focus slowly racks back and forth.
 * @property {number} glow Brightness of the lights. Where they overlap they bloom to white.
 * @property {number} fringe Purple and green colour fringes on the disc edges.
 * @property {number} catsEye How much discs towards the edges are clipped into lemon shapes.
 * @property {import('./runtime.js').Gradient} palette The colours the lights are drawn from.
 * @property {string} background Colour behind the lights.
 * @property {boolean} interactive The pointer pulls focus (up is farther) and gently tilts the scene.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {BokehOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.4,
  drift: 0.3,
  twinkle: 0.15,
  aperture: 'circle',
  density: 0.65,
  size: 0.8,
  focus: 0.15,
  breathing: 0.4,
  glow: 1,
  fringe: 0.5,
  catsEye: 0.5,
  palette: [
    [0, '#ff9a2e'],
    [0.3, '#ffd36e'],
    [0.55, '#ffe6b8'],
    [0.8, '#ff4b2b'],
    [1, '#3d9bff'],
  ],
  background: '#05060b',
  interactive: true,
  responsiveness: 0.5,
};

// Shared by the light sprites' two stages.
const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uResolution;
uniform float uTime;
uniform float uFocusNow;    // the distance in focus this frame, breathing and pointer included
uniform vec4 uLayer;        // this layer: index, depth, cell size, cells across
uniform vec4 uPlace;        // this layer: drift and parallax offset (xy), first cell (zw)
uniform float uDensity;
uniform float uSize;
uniform float uGlow;
uniform float uFringe;
uniform float uCatsEye;
uniform float uTwinkle;
uniform vec4 uColours[6];   // linear palette colours, in order
uniform float uColourCount;
uniform sampler2D uShape;   // the aperture's signed distance, for u from -1.5 to 1.5
uniform vec4 uSpikes[2];    // normals of the four flare lines, two per vec4
`;

// One sprite per cell: where the cell's light is, how large, and how bright.
const SPRITE_VERTEX = COMMON + /* glsl */ `
flat out vec4 vAt;          // centre (xy), radius, glare reach past the disc
flat out vec4 vLens;        // cat's-eye offset (xy), edge softness, fringe
flat out vec4 vLook;        // in focus 0 to 1, onion ring phase, disc and glare strength
flat out vec4 vColour;      // colour times brightness (rgb), brightness (a)
flat out float vCell;       // cell size, for the flare's length

// Hashes without sine, stable across GPUs (after Dave Hoskins, MIT).
vec4 hash43(vec3 p) {
  vec4 q = fract(p.xyzx * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}

// Each light takes one of the palette's own colours, nudged a little towards
// the next, so a string of fairy lights reads as distinct colours rather
// than every blend in between.
vec3 lightColour(float h, float k) {
  int i = min(int(h * uColourCount), int(uColourCount) - 1);
  int j = min(i + 1, int(uColourCount) - 1);
  return mix(uColours[i].rgb, uColours[j].rgb, k * 0.3);
}

void main() {
  float fl = uLayer.x;
  float zl = uLayer.y;
  float cs = uLayer.z;
  float t = uTime;
  int across = int(uLayer.w);
  vec2 cell = uPlace.zw + vec2(float(gl_InstanceID % across), float(gl_InstanceID / across));
  vec4 h = hash43(vec3(cell, fl * 17.0 + 3.0));
  vAt = vec4(0.0);
  vLens = vec4(0.0);
  vLook = vec4(0.0);
  vColour = vec4(0.0);
  vCell = cs;
  if (h.x > uDensity) {
    // No light in this cell: a sprite shrunk to a point, off screen.
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  // A slow wander of its own, like a firefly, within its cell.
  vec2 ph = fract(h.yz * 31.7 + h.w * 7.3);
  vec2 wander = 0.07 * vec2(sin(t * (0.3 + ph.x * 0.5) + ph.y * 6.28), cos(t * (0.25 + ph.y * 0.45) + ph.x * 6.28));
  // Its centre on screen, in units of the shorter side from the middle.
  vec2 c = (cell + 0.18 + 0.64 * h.yz + wander) * cs - uPlace.xy;

  float focus = uFocusNow;
  float z = zl + (h.w - 0.5) * 0.14;
  float def = abs(z - focus);
  float r = 0.0035 * uSize + 0.2 * uSize * def;
  float sharp = 1.0 - smoothstep(0.0, 0.03, def);
  // How far the glow reaches past the disc: further for a pinpoint, whose
  // flare and glare carry it.
  float span = cs * (0.09 + 0.22 * sharp);
  float reach = 1.12 * r + span;
  vec4 g = hash43(vec3(cell + 41.7, fl * 11.0 + 9.0));

  float px = 1.0 / min(uResolution.x, uResolution.y);
  float halfDiag = 0.5 * length(uResolution) * px;
  // Mechanical vignetting: towards the frame's edges the rear of the lens
  // clips each disc, leaving a cat's-eye that wraps round the centre.
  vec2 clip = c / halfDiag * uCatsEye * 1.5;
  // Soft edge: never sharper than a pixel and a half at this size.
  float w = max(1.5 * px / r, 0.035);
  // Spherochromatism: green rims one side of focus, purple the other.
  float e = uFringe * 0.022 * sign(z - focus) * smoothstep(0.02, 0.2, def);
  // Spread over its area, a light dims as it defocuses, much as a lens
  // spreads the same light over a larger disc.
  float energy = uGlow * 0.01 / pow(r + 0.006, 1.4) * (0.35 + 1.3 * h.w * h.w);
  // Twinkle: some lights pulse slowly, fireflies blink.
  float tw = 0.5 + 0.5 * sin(t * (0.6 + 2.2 * g.z) + g.w * 6.28);
  energy *= mix(1.0, tw * tw * 1.6, uTwinkle);

  vAt = vec4(c, r, span);
  vLens = vec4(clip, w, e);
  vLook = vec4(sharp, g.x * 6.28, 1.0 - sharp * 0.6, 0.07 + 0.2 * sharp);
  vColour = vec4(lightColour(g.x, g.y) * energy, energy);

  // An octagon round the glow's reach, not a square: a sixth fewer pixels
  // to shade. Drawn as a strip, its vertices zigzag across: 0, 1, 7, 2, 6…
  int k = gl_VertexID;
  int v = k == 0 ? 0 : (k & 1) == 1 ? (k + 1) / 2 : 8 - k / 2;
  float a = float(v) * 0.7853982 + 0.3926991;
  vec2 corner = vec2(cos(a), sin(a)) * 1.0823922; // circumscribes the circle
  // A small sprite keeps the square (its vertices pair up on the corners):
  // each seam between triangles shades a few pixels twice, and in a few
  // pixels across that outweighs the corners saved.
  if (reach < 16.0 * px) corner = sign(corner);
  gl_Position = vec4((c + corner * reach) / px / (0.5 * uResolution), 0.0, 1.0);
}
`;

// The light a sprite adds to each pixel it covers.
const SPRITE_FRAGMENT = COMMON + /* glsl */ `
flat in vec4 vAt;
flat in vec4 vLens;
flat in vec4 vLook;
flat in vec4 vColour;
flat in float vCell;
out vec4 fragColor;

void main() {
  float px = 1.0 / min(uResolution.x, uResolution.y);
  vec2 d = (gl_FragCoord.xy - 0.5 * uResolution) * px - vAt.xy;
  float r = vAt.z;
  float span = vAt.w;
  float dist = length(d);
  // The sprite's corners lie beyond the glow's reach: nothing to add there.
  if (dist > 1.12 * r + span) {
    fragColor = vec4(0.0);
    return;
  }
  vec2 u = d / r;
  float lu = dist / r;
  // The aperture's shape, looked up rather than worked out: one fetch
  // whatever the shape. Beyond the stored square, carry on outwards from
  // its edge, so a pinpoint's wide glare keeps the aperture's shape.
  float shape = textureLod(uShape, u * (min(1.0, 1.45 / lu) / 3.0) + 0.5, 0.0).r + max(lu - 1.45, 0.0);
  float sd = max(shape, length(u + vLens.xy) - 1.35);

  float w = vLens.z;
  float e = vLens.w;
  vec3 disc = 1.0 - smoothstep(-w, w, vec3(sd) - vec3(-e, e, -e));
  // Soap-bubble bokeh: brightest at the rim, with faint onion rings.
  float rim = 0.55 + 0.75 * smoothstep(-0.32, 0.0, sd) + 0.01 * sin(lu * 26.0 + vLook.y);
  // A faint glare halo around every light, so it glows rather than sits flat.
  float o = 1.0 - clamp(max(sd, 0.0) * r / span, 0.0, 1.0);
  vec3 l = vColour.rgb * (disc * rim * vLook.z + vLook.w * o * o * o);
  // In focus: a hard pinpoint with tiny star flares from the blades.
  float sharp = vLook.x;
  if (sharp > 0.001) {
    vec2 dd = d / px;
    float dp = dist / px;
    float core = exp(-dp * dp * 0.35) * 2.5 + exp(-dp * 0.35) * 0.25;
    // Distance to the nearest flare line, one per pair of opposite spikes.
    float perp = min(min(abs(dot(dd, uSpikes[0].xy)), abs(dot(dd, uSpikes[0].zw))), min(abs(dot(dd, uSpikes[1].xy)), abs(dot(dd, uSpikes[1].zw))));
    float flare = exp(-perp * 1.3) * exp(-dist / (vCell * 0.06)) * 0.7;
    // Whitened towards the core: 60% white, at the light's brightness.
    l += (0.4 * vColour.rgb + 0.6 * vColour.a) * (core + flare) * sharp * 0.18;
  }
  fragColor = vec4(l, 1.0);
}
`;

// The effect's own pass: tone the gathered light and lay it over the backdrop.
export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform sampler2D uLight;   // the lights, added up at full resolution
uniform float uLightScale;  // undoes the scaling on devices without float buffers
uniform vec4 uHaze;         // centres of the two haze glows
uniform vec4 uColours[6];
uniform float uColourCount;
uniform vec3 uBackground;   // linear
uniform float uTransparent;
uniform float uGlow;

out vec4 fragColor;

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// ACES fitted (after Krzysztof Narkowicz): bright overlaps roll off and
// whiten the way film and sensors do, instead of clipping to flat colour.
vec3 filmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  // Sized by the shorter side, so a portrait phone sees as many lights across as a landscape screen.
  float px = 1.0 / min(uResolution.x, uResolution.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  vec3 light = texture(uLight, gl_FragCoord.xy / uResolution).rgb * uLightScale;

  // A faint haze of the lights' own colours, as light scatters in night air:
  // two broad, slow glows, so the darkness between discs has some depth.
  vec2 a1 = uHaze.xy - p;
  vec2 a2 = uHaze.zw - p;
  light += uColours[0].rgb * 0.008 * uGlow * exp(-dot(a1, a1) * 3.0);
  light += uColours[int(uColourCount) - 1].rgb * 0.007 * uGlow * exp(-dot(a2, a2) * 3.0);

  vec3 lit = filmic(light * 1.2);
  // Screen the light over the backdrop, so the backdrop's colour stays true.
  vec3 c = 1.0 - (1.0 - uBackground) * (1.0 - lit);
  float n = (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 37.1) - 1.0) / 255.0;
  if (uTransparent > 0.5) {
    vec3 lc = linearToSrgb(lit) + n;
    fragColor = vec4(clamp(lc, 0.0, 1.0), clamp(max(lc.r, max(lc.g, lc.b)), 0.0, 1.0));
    return;
  }
  fragColor = vec4(clamp(linearToSrgb(c) + n, 0.0, 1.0), 1.0);
}
`;

const LAYERS = 5;
const MAX_COLOURS = 6;
// The aperture's shape is stored as a signed distance field this many texels
// across, covering u from -1.5 to 1.5 (u is 1 at the disc's radius).
const SHAPE = 256;
// A slight turn, as a real diaphragm rarely lines up square with the frame.
const TURN_C = 0.966;
const TURN_S = 0.259;
// Flare spikes from the diaphragm's blades: a circle gets four, a hexagon six.
const SPIKES = { circle: 4, hexagon: 6, octagon: 8, heart: 8, star: 8 };
// Without float buffers, light is stored at half, so overlaps up to twice
// full brightness still add up before the tone curve rolls them off. Rare:
// nearly every WebGL2 device can draw into half floats.
const BYTE_SCALE = 2;

/** @param {import('./runtime.js').Gradient} stops */
function palette(stops) {
  // Fresh each time: only on option changes, and instances never share it.
  const colours = new Float32Array(MAX_COLOURS * 4);
  const sorted = [...stops].sort((a, b) => a[0] - b[0]).slice(0, MAX_COLOURS);
  sorted.forEach(([, hex], i) => colours.set([...linear(hex), 0], i * 4));
  return { uColours: colours, uColourCount: Math.max(1, sorted.length) };
}

/** Normals of the flare lines: each line carries a pair of opposite spikes. @param {BokehOptions['aperture']} aperture */
function spikes(aperture) {
  const n = SPIKES[aperture] ?? 8;
  const out = new Float32Array(8);
  for (let k = 0; k < 4; k++) {
    const a = -0.26 + (Math.min(k, n / 2 - 1) * 2 * Math.PI) / n;
    out[k * 2] = -Math.sin(a);
    out[k * 2 + 1] = Math.cos(a);
  }
  return out;
}

/** GLSL's mod: always the sign of the divisor. @param {number} x @param {number} y */
const mod = (x, y) => x - y * Math.floor(x / y);

/** A regular polygon covering about the same area as the unit circle. @param {number} x @param {number} y @param {number} n */
function polygon(x, y, n) {
  const s = (2 * Math.PI) / n;
  const m = mod(Math.atan2(y, x) + s * 0.5, s) - s * 0.5;
  return ((Math.hypot(x, y) * Math.cos(m)) / Math.cos(Math.PI / n)) * 0.93 - 1;
}

/** After Inigo Quilez's heart (MIT), upright and fitted to the unit disc. @param {number} x @param {number} y */
function heart(x, y) {
  const px = Math.abs(x) * 0.56;
  const py = (y * 0.95 + 1) * 0.56;
  let d;
  if (px + py > 1) d = Math.hypot(px - 0.25, py - 0.75) - 0.35355;
  else {
    const k = 0.5 * Math.max(px + py, 0);
    d = Math.sqrt(Math.min(px * px + (py - 1) * (py - 1), (px - k) * (px - k) + (py - k) * (py - k))) * Math.sign(px - py);
  }
  return d / 0.56;
}

/** After Inigo Quilez's star (MIT): five plump points. @param {number} x @param {number} y */
function star(x, y) {
  const an = Math.PI / 5;
  const en = Math.PI / 3.2;
  const ax = Math.cos(an), ay = Math.sin(an);
  const ex = Math.cos(en), ey = Math.sin(en);
  const bn = mod(Math.atan2(x, y), 2 * an) - an;
  const l = Math.hypot(x, y);
  let qx = l * Math.cos(bn) - 1.12 * ax;
  let qy = l * Math.abs(Math.sin(bn)) - 1.12 * ay;
  const t = Math.min(Math.max(-(qx * ex + qy * ey), 0), (1.12 * ay) / ey);
  qx += ex * t;
  qy += ey * t;
  return Math.hypot(qx, qy) * Math.sign(qx);
}

/**
 * The aperture's signed distance at u = (x, y), in units of the disc's radius.
 * @param {BokehOptions['aperture']} aperture @param {number} x @param {number} y
 */
function aperture(aperture, x, y) {
  if (aperture === 'circle') return Math.hypot(x, y) - 1;
  if (aperture === 'heart') return heart(x, y);
  const rx = TURN_C * x - TURN_S * y;
  const ry = TURN_S * x + TURN_C * y;
  const round = Math.hypot(rx, ry) - 1;
  if (aperture === 'hexagon') return polygon(rx, ry, 6) * 0.88 + round * 0.12;
  // Rounded blades: an octagon with its corners softened towards a circle.
  if (aperture === 'octagon') return polygon(rx, ry, 8) * 0.55 + round * 0.45;
  return star(rx, ry);
}

/** @type {import('./runtime.js').EffectSpec<BokehOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const { gl, canvas } = ctx;
    // The pointer's eased position, caught on its way to the shader, so the
    // focus and parallax can be worked out here once a frame.
    const at = [0.5, 0.5];
    let active = 0;
    const p = pointer(
      {
        ...ctx,
        uniform(name, value) {
          if (name === 'uPointer') {
            const v = /** @type {ArrayLike<number>} */ (value);
            at[0] = v[0];
            at[1] = v[1];
          } else if (name === 'uPointerActive') active = Number(value);
        },
      },
      { ease: 2.5 },
    );
    const units = { shape: ctx.textureUnit(0), light: ctx.textureUnit(1) };
    const field = new Float32Array(SHAPE * SHAPE);
    const haze = new Float32Array(4);
    /** @type {WebGLProgram | null} */
    let sprites = null;
    /** @type {Record<string, WebGLUniformLocation | null>} */
    let loc = {};
    /** @type {WebGLTexture | null} */
    let shapeTex = null;
    /** @type {WebGLTexture | null} */
    let lightTex = null;
    /** @type {WebGLFramebuffer | null} */
    let target = null;
    let tw = 0;
    let th = 0;
    // Float buffers keep the light's full range; without them it is stored
    // in bytes, scaled down. Where it can, the light is packed into 32 bits
    // a pixel (R11F_G11F_B10F, about two significant digits, ample under
    // the dither), half the memory and bandwidth of four half floats: 9 MB
    // rather than 18 at 1920×1200.
    let float = false;
    /** @type {number} */
    let format = gl.RGBA8;
    let shape = '';
    /** @type {BokehOptions} */
    let o = defaults;
    /** @type {Record<string, import('./runtime.js').UniformValue>} */
    let shared = {};

    const build = () => {
      const full = !!gl.getExtension('EXT_color_buffer_float');
      float = full || !!gl.getExtension('EXT_color_buffer_half_float');
      format = full ? gl.R11F_G11F_B10F : float ? gl.RGBA16F : gl.RGBA8;
      const compile = (/** @type {number} */ type, /** @type {string} */ src) => {
        const s = /** @type {WebGLShader} */ (gl.createShader(type));
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const prog = /** @type {WebGLProgram} */ (gl.createProgram());
      const v = compile(gl.VERTEX_SHADER, SPRITE_VERTEX);
      const f = compile(gl.FRAGMENT_SHADER, SPRITE_FRAGMENT);
      gl.attachShader(prog, v);
      gl.attachShader(prog, f);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('bokeh:', gl.getShaderInfoLog(v) || gl.getShaderInfoLog(f) || gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        sprites = null;
      } else sprites = prog;
      gl.deleteShader(v);
      gl.deleteShader(f);
      loc = {};
      tw = th = 0;
      lightTex = null;
      target = null;
      shapeTex = null;
      shape = '';
    };
    /** @param {string} name */
    const L = (name) => (name in loc ? loc[name] : (loc[name] = gl.getUniformLocation(/** @type {WebGLProgram} */ (sprites), name)));

    // Rebuilt only when the aperture changes: a quarter of a million distances.
    /** @param {BokehOptions['aperture']} name */
    const buildShape = (name) => {
      shape = name;
      for (let j = 0; j < SHAPE; j++) {
        const y = ((j + 0.5) / SHAPE - 0.5) * 3;
        for (let i = 0; i < SHAPE; i++) field[j * SHAPE + i] = aperture(name, ((i + 0.5) / SHAPE - 0.5) * 3, y);
      }
      shapeTex ??= gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + units.shape);
      gl.bindTexture(gl.TEXTURE_2D, shapeTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, SHAPE, SHAPE, 0, gl.RED, gl.FLOAT, field);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.activeTexture(gl.TEXTURE0);
    };

    /** @param {number} w @param {number} h */
    const allocate = (w, h) => {
      if (lightTex) gl.deleteTexture(lightTex);
      if (target) gl.deleteFramebuffer(target);
      lightTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + units.light);
      gl.bindTexture(gl.TEXTURE_2D, lightTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
      target = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lightTex, 0);
      tw = w;
      th = h;
      // Should a driver refuse to draw into the packed format, four half floats.
      if (format === gl.R11F_G11F_B10F && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        format = gl.RGBA16F;
        allocate(w, h);
      }
    };

    build();

    return {
      update(next) {
        o = next;
        shared = { ...palette(o.palette), uSpikes: spikes(o.aperture) };
      },
      frame(dt, time) {
        p.frame(dt);
        if (!sprites) return;
        if (o.aperture !== shape) buildShape(o.aperture);
        const W = canvas.width;
        const H = canvas.height;
        if (W !== tw || H !== th) allocate(W, H);
        const unit = Math.min(W, H);
        const { size, drift } = o;
        // The focal plane breathes slowly; the pointer's height pulls focus
        // through the depth of the scene, bottom near and top far.
        const pull = o.interactive ? active : 0;
        const breath = Math.min(1, Math.max(0, o.focus + o.breathing * 0.42 * Math.sin(time * 0.32) * (0.7 + 0.3 * Math.sin(time * 0.11 + 1.3))));
        const pulled = Math.min(1, Math.max(0, (at[1] - 0.12) / 0.76));
        const focus = breath + (pulled - breath) * pull * 0.85;
        const tiltX = (at[0] - 0.5) * pull;
        const tiltY = (at[1] - 0.5) * pull;

        const effect = gl.getParameter(gl.CURRENT_PROGRAM);
        const blend = gl.isEnabled(gl.BLEND);
        gl.useProgram(sprites);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.activeTexture(gl.TEXTURE0 + units.shape);
        gl.bindTexture(gl.TEXTURE_2D, shapeTex);
        gl.uniform1i(L('uShape'), units.shape);
        gl.uniform2f(L('uResolution'), W, H);
        gl.uniform1f(L('uTime'), time);
        gl.uniform1f(L('uFocusNow'), focus);
        gl.uniform1f(L('uDensity'), o.density);
        gl.uniform1f(L('uSize'), size);
        gl.uniform1f(L('uGlow'), o.glow * (float ? 1 : 1 / BYTE_SCALE));
        gl.uniform1f(L('uFringe'), o.fringe);
        gl.uniform1f(L('uCatsEye'), o.catsEye);
        gl.uniform1f(L('uTwinkle'), o.twinkle);
        gl.uniform4fv(L('uColours'), /** @type {Float32Array} */ (shared.uColours));
        gl.uniform1f(L('uColourCount'), /** @type {number} */ (shared.uColourCount));
        gl.uniform4fv(L('uSpikes'), /** @type {Float32Array} */ (shared.uSpikes));
        // The screen, in units of the shorter side from the middle.
        const hw = (0.5 * W) / unit;
        const hh = (0.5 * H) / unit;
        for (let l = 0; l < LAYERS; l++) {
          const z = (l + 0.5) / LAYERS;
          // Cells sized to the largest disc the layer can make, so a light
          // never reaches more than a cell beyond its own.
          const cs = (0.0035 * size + 0.2 * size * (Math.max(z, 1 - z) + 0.07)) * 2.2;
          // Drift: nearer layers sweep past faster, as they would through a
          // window. Each layer also sits well away from the others, so they
          // never line up. Parallax pivots on the focal plane, like a camera
          // turning on its subject.
          const pace = 1.25 - z;
          const tilt = (z - focus) * 0.18;
          const sx = (Math.sin(time * 0.07 + l * 1.7) * 0.25 + time * 0.012 * (l - 2)) * pace + l * 13.7 + tiltX * tilt;
          const sy = -drift * time * 0.05 * pace + l * 7.3 + tiltY * tilt;
          // Every cell whose light could reach the screen: the cells under
          // it, and one more all round.
          const x0 = Math.floor((sx - hw) / cs) - 1;
          const y0 = Math.floor((sy - hh) / cs) - 1;
          const nx = Math.floor((sx + hw) / cs) + 1 - x0 + 1;
          const ny = Math.floor((sy + hh) / cs) + 1 - y0 + 1;
          gl.uniform4f(L('uLayer'), l, z, cs, nx);
          gl.uniform4f(L('uPlace'), sx, sy, x0, y0);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 8, nx * ny);
        }

        // Back to the effect, which reads the light.
        if (!blend) gl.disable(gl.BLEND);
        gl.useProgram(effect);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        gl.activeTexture(gl.TEXTURE0 + units.light);
        gl.bindTexture(gl.TEXTURE_2D, lightTex);
        gl.activeTexture(gl.TEXTURE0);
        ctx.sampler('uLight', units.light);
        ctx.uniform('uLightScale', float ? 1 : BYTE_SCALE);
        // The haze's two glows wander slowly, and lean a little with the pointer.
        haze[0] = 0.45 * Math.sin(time * 0.05) - tiltX * 0.1;
        haze[1] = 0.25 * Math.cos(time * 0.04) - tiltY * 0.1;
        haze[2] = -0.5 * Math.cos(time * 0.045 + 1) - tiltX * 0.1;
        haze[3] = -0.3 * Math.sin(time * 0.06 + 2) - tiltY * 0.1;
        ctx.uniform('uHaze', haze);
      },
      restore() {
        build();
      },
      destroy() {
        p.destroy();
        if (sprites) gl.deleteProgram(sprites);
        if (shapeTex) gl.deleteTexture(shapeTex);
        if (lightTex) gl.deleteTexture(lightTex);
        if (target) gl.deleteFramebuffer(target);
        sprites = null;
      },
    };
  },
  dpr: 1.5,
  time: 8,
  speed: (o) => o.speed,
  update(o) {
    return {
      // The palette's colours in order, linear, for the haze.
      ...palette(o.palette),
      uBackground: linear(o.background),
      uTransparent: !o.showBackground,
      uGlow: o.glow,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<BokehOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function bokeh(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
