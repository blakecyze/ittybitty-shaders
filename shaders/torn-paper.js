// @ts-check
/**
 * ittybitty/torn-paper
 *
 * The page, an image or the layers beneath, torn open. A tear is ragged at
 * two scales, a wandering line and a fine jag, and where paper tears, its
 * printed skin comes away from the white core beneath: one edge of every
 * tear shows a band of bare white paper, wider where the tear ran at a
 * slant, fringed with loose fibres that stick out past the edge. The torn
 * pieces lift a little and cast soft shadows onto what they reveal.
 *
 * Torn in two, a hole torn through the middle (it follows the pointer), or
 * a strip ripped off one edge. Static: one draw per change, or while the
 * pointer moves the hole.
 *
 * https://ittybitty.dev/shaders/torn-paper (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} TornPaperOptions
 * @property {boolean} showUnder What lies underneath. Off, the tear opens onto your page.
 * @property {boolean} showShadow The shadows the torn edges cast.
 * @property {boolean} showFibres Loose fibres along the torn edges.
 * @property {string} image The page. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'split' | 'hole' | 'strip'} tear Torn in two, a hole through the middle, or a strip off one edge.
 * @property {number} open How far the tear opens.
 * @property {number} jag How ragged the tear is.
 * @property {number} angle Direction of the tear, in degrees.
 * @property {number} core Width of the white paper core showing along the torn edge.
 * @property {number} seed Picks a different tear.
 * @property {string} under Colour underneath.
 * @property {string} paper Colour of the paper's core.
 * @property {boolean} interactive The hole follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {TornPaperOptions} */
export const defaults = {
  showUnder: true,
  showShadow: true,
  showFibres: true,
  image: '',
  tear: 'split',
  open: 0.35,
  jag: 0.6,
  angle: 8,
  core: 0.6,
  seed: 1,
  under: '#1f2a33',
  paper: '#faf7f0',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uShowUnder;
uniform float uShowShadow;
uniform float uShowFibres;
uniform float uTear;        // 0 split, 1 hole, 2 strip
uniform float uOpen;
uniform float uJag;
uniform float uAngle;       // radians
uniform float uCore;
uniform float uSeed;
uniform vec3 uUnder;        // linear RGB
uniform vec3 uPaper;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

// The page. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A poster: bold colour fields, so the torn edges read clearly.
    vec3 c = mix(vec3(0.93, 0.36, 0.2), vec3(0.98, 0.78, 0.25), smoothstep(0.2, 0.9, uv.x + uv.y * 0.3));
    float band = step(0.62, uv.y) * step(uv.y, 0.7);
    c = mix(c, vec3(0.1, 0.12, 0.2), band);
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  float a = hash12(vec2(i, uSeed));
  float b = hash12(vec2(i + 1.0, uSeed));
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// The torn line's offset at position x along it (canvas heights): a slow
// wander, a medium jag and a fine tooth, as paper tears.
float ragged(float x, float salt) {
  float y = (noise(x * 3.0 + salt) - 0.5) * 0.08;
  y += (noise(x * 14.0 + salt * 3.0) - 0.5) * 0.03 * uJag;
  y += (noise(x * 60.0 + salt * 7.0) - 0.5) * 0.008 * uJag;
  y += (noise(x * 220.0 + salt * 11.0) - 0.5) * 0.003 * uJag;
  return y;
}

// Signed distance (canvas heights) from a point to a piece's torn edge,
// negative inside the piece, and a slow value along the edge (for the
// width of its white core). One piece of the page per call.
// How far a piece has moved, in canvas heights, so its print travels with it.
vec2 moved(int which) {
  if (uTear > 0.5) return vec2(0.0);
  vec2 nrm = vec2(-sin(uAngle), cos(uAngle));
  return nrm * uOpen * 0.06 * (which == 0 ? 1.0 : -1.0);
}

vec2 piece(vec2 p) {
  if (uTear < 0.5) {
    // Split: the edge runs across the page; each half moves away from it.
    vec2 dir = vec2(cos(uAngle), sin(uAngle));
    vec2 nrm = vec2(-dir.y, dir.x);
    float gap = uOpen * 0.12;
    vec2 q = p - vec2(0.5 * uResolution.x / uResolution.y, 0.5);
    float x = dot(q, dir);
    float y = dot(q, nrm);
    // Both halves share one tear line, which is what makes them fit.
    float edge = ragged(x, 0.0);
    return vec2(edge - y + gap * 0.5, x);
  }
  if (uTear < 1.5) {
    // Hole: a ragged loop around the middle, or the pointer. Only one piece:
    // the page, outside the loop.
    vec2 c = vec2(0.5 * uResolution.x / uResolution.y, 0.5);
    if (uInteractive > 0.5) c = mix(c, uPointer * vec2(uResolution.x / uResolution.y, 1.0), uPointerActive);
    vec2 d = p - c;
    float a = atan(d.y, d.x);
    float r = uOpen * 0.35 + 0.03;
    // Round the loop, wrapping so its ends meet: the raggedness is read at
    // the angle and at a full turn on, blended across the seam.
    float u = (a / 6.2831 + 0.5) * 4.0 * (0.5 + r * 3.0);
    float span = 4.0 * (0.5 + r * 3.0);
    float wob = mix(ragged(u, 3.0), ragged(u - span, 3.0), smoothstep(span * 0.75, span, u));
    return vec2(r + wob * 0.5 - length(d), a * r);
  }
  // Strip: ripped off along the top edge.
  float x = p.x;
  float edge = 1.0 - uOpen * 0.4 + ragged(x, 5.0);
  return vec2(p.y - edge, x);
}

void main() {
  vec2 res = uResolution;
  float aspect = res.x / res.y;
  vec2 p = gl_FragCoord.xy / res.y;
  float px1 = 1.0 / res.y * uPixelRatio;

  vec3 colour = uUnder;
  float alpha = uShowUnder;

  // What the tear reveals: underneath, shadowed near the torn edges.
  float shade = 0.0;
  int pieces = uTear < 0.5 ? 2 : 1;
  if (uShowShadow > 0.5) {
    // The split halves share their torn line, including its offset shadow.
    float sd = piece(p + vec2(-0.006, 0.01)).x;
    if (pieces == 2) sd = min(sd, uOpen * 0.12 - sd);
    shade = exp(-max(sd, 0.0) / 0.012) * 0.55;
  }
  colour *= 1.0 - shade;
  alpha = max(alpha, shade * 0.8);

  vec2 edge = piece(p);
  for (int i = 0; i < 2; i++) {
    if (i >= pieces) break;
    vec2 sd = i == 0 ? edge : vec2(uOpen * 0.12 - edge.x, edge.y);
    if (sd.x >= max(px1, 0.0078)) continue;
    // The white core along the edge: wider in places, as the printed skin
    // peels back further where the tear ran at a slant.
    // One side of a tear keeps most of the core, the other a sliver.
    float side = i == 0 ? 1.0 : 0.35;
    float coreW = uCore * side * (0.008 + 0.045 * pow(noise(sd.y * 5.0 + float(i) * 13.0), 1.4));
    // The line between print and core is itself torn, finely.
    coreW *= 0.75 + 0.5 * noise(sd.y * 180.0 + float(i) * 5.0);
    // Loose fibres: thin, curling hairs reaching past the edge.
    float fibre = 0.0;
    if (uShowFibres > 0.5 && sd.x >= 0.0 && sd.x < 0.0078) {
      float along = sd.y * 700.0;
      float cell = floor(along);
      float len = 0.006 * (0.3 + hash12(vec2(cell, float(i) + uSeed)));
      // Each fibre leans and curls a little as it leaves the edge.
      float lean = (hash12(vec2(cell + 7.0, float(i))) - 0.5) * 2.0;
      float thin = abs(fract(along) - 0.5 - lean * sd.x * 250.0 - 0.15 * sin(sd.x * 900.0 + cell));
      fibre = step(0.45, hash12(vec2(cell + 3.0, float(i) - uSeed))) * (1.0 - smoothstep(0.06, 0.16, thin));
      fibre *= step(0.0, sd.x) * (1.0 - smoothstep(len * 0.6, len, sd.x));
    }
    float inside = 1.0 - smoothstep(-px1, px1, sd.x);
    if (inside <= 0.0 && fibre <= 0.0) continue;
    // The piece: printed paper, the core showing along its edge, and the
    // faintest lift of light just before it.
    vec3 printed = srgbToLinear(source(gl_FragCoord.xy - moved(i) * uResolution.y, 0.0).rgb);
    float coreMask = smoothstep(-coreW - px1, -coreW + px1, sd.x);
    // Paper grain in the core, and it is a touch shaded right at the lip.
    vec3 c = printed;
    if (coreMask > 0.0) {
      vec3 core = uPaper * (0.93 + 0.07 * noise2(gl_FragCoord.xy * 0.4));
      core *= 1.0 - 0.12 * smoothstep(-coreW, 0.0, sd.x);
      c = mix(core, printed, 1.0 - coreMask);
    }
    c = mix(c, uPaper * 0.95, fibre * (1.0 - inside));
    float a = max(inside, fibre * 0.85);
    colour = mix(colour, c, a);
    alpha = max(alpha, a);
  }
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

const TEARS = { split: 0, hole: 1, strip: 2 };

/** @type {import('./runtime.js').EffectSpec<TornPaperOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowUnder: o.showUnder,
      uShowShadow: o.showShadow,
      uShowFibres: o.showFibres,
      uTear: TEARS[o.tear] ?? 0,
      uOpen: o.open,
      uJag: o.jag,
      uAngle: (o.angle * Math.PI) / 180,
      uCore: o.core,
      uSeed: o.seed * 3.17,
      uUnder: linear(o.under),
      uPaper: linear(o.paper),
      uInteractive: o.interactive && o.tear === 'hole',
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 8 });
    return {
      update: (o) => image.set(o.image),
      frame: p.frame,
      restore: image.restore,
      destroy() {
        image.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<TornPaperOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function tornPaper(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
