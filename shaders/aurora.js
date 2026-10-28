// @ts-check
/**
 * ittybitty/aurora
 *
 * The northern lights over a starry sky: curtains of light folding slowly
 * across the heavens, traced through a stack of altitudes so they have real
 * depth. Like the real thing, they glow green low down, shading to violet
 * and red up high, and are combed into fine vertical rays.
 *
 * https://ittybitty.dev/shaders/aurora (MIT)
 */
import { mount, linear } from './runtime.js';

/**
 * @typedef {object} AuroraOptions
 * @property {boolean} showSky The night sky. Off, only the lights and stars are drawn, over the page.
 * @property {boolean} showStars The stars behind the lights.
 * @property {boolean} showLights The curtains of the aurora.
 * @property {number} speed How fast the curtains fold and drift.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} intensity Brightness of the lights.
 * @property {number} height How tall the curtains reach.
 * @property {number} folds How much the curtains ripple and fold.
 * @property {number} rays Strength of the fine vertical rays.
 * @property {number} stars How many stars.
 * @property {string} low Colour of the curtains' base.
 * @property {string} high Colour of the curtains' upper reaches.
 * @property {string} sky Colour of the night sky.
 */

/** @type {AuroraOptions} */
export const defaults = {
  showSky: true,
  showStars: true,
  showLights: true,
  speed: 0.4,
  zoom: 1,
  intensity: 1,
  height: 0.6,
  folds: 0.6,
  rays: 0.6,
  stars: 0.6,
  low: '#35ff9a',
  high: '#9a4dff',
  sky: '#050a18',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uShowStars;
uniform float uShowLights;
uniform float uTime;
uniform float uIntensity;
uniform float uHeight;
uniform float uFolds;
uniform float uRays;
uniform float uStars;
uniform vec3 uLow;        // linear RGB
uniform vec3 uHigh;
uniform vec3 uSky;
uniform float uTransparent;

out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// Where the curtain stands on the ground, as a line z = curtain(x): a slow
// meander with folds that travel along it.
float curtain(float x, float t, float k) {
  return 2.4 + k * 1.6
    + 1.1 * sin(x * 0.32 + t * 0.25 + k * 2.0) * uFolds
    + 0.45 * sin(x * 0.9 - t * 0.45 + 1.3 + k) * uFolds
    + 0.3 * (noise1(x * 0.7 + t * 0.15 + k * 5.0) - 0.5) * uFolds;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Zoom about the middle of the canvas: a pixel, or a point in 0..1 canvas
// space (such as the pointer), as the zoomed view sees it.
vec2 zoomed(vec2 fc) {
  return (fc - 0.5 * uResolution) / uZoom + 0.5 * uResolution;
}

vec2 zoomedUv(vec2 uv) {
  return (uv - 0.5) / uZoom + 0.5;
}

void main() {
  vec2 uv = (zoomed(gl_FragCoord.xy) - 0.5 * uResolution) / uResolution.y;
  float t = uTime;
  // Looking out and up at the northern sky.
  vec3 rd = normalize(vec3(uv.x, uv.y + 0.35, 1.0));

  // The night sky: deepest overhead, a faint glow near the horizon.
  vec3 sky = uSky * (0.6 + 0.8 * smoothstep(0.6, -0.1, rd.y)) + uLow * 0.012 * smoothstep(0.35, 0.0, rd.y);
  // Stars: fixed to the sky, twinkling a little, fewer near the horizon.
  vec2 sp = rd.xy / max(rd.z, 0.1) * 90.0;
  vec2 cell = floor(sp);
  float h = hash12(cell);
  vec2 d = fract(sp) - (0.2 + 0.6 * vec2(hash12(cell + 7.1), hash12(cell + 3.3)));
  float star = step(1.0 - uStars * 0.06, h) * exp(-dot(d, d) * 90.0) * (0.6 + 0.4 * sin(t * 3.0 + h * 40.0)) * smoothstep(0.02, 0.2, rd.y) * uShowStars;
  vec3 colour = sky + vec3(0.9, 0.93, 1.0) * star;

  // The curtains: step up through the altitudes they fill. At each, the ray
  // meets a horizontal slice; light where the slice crosses the curtain line.
  vec3 light = vec3(0.0);
  if (rd.y > 0.0 && uShowLights > 0.5) {
    const int LAYERS = 36;
    // One even offset per pixel (interleaved gradient noise): the slices
    // blend into a continuous sheet without speckle.
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float base = 1.0;
    float top = base + 0.6 + uHeight * 1.6;
    // The curtains never stray outside this band of depth (their waves add
    // up to at most 1.7 × folds), so slices outside it cannot be lit.
    float zlo = 2.4 - 1.7 * uFolds - 0.45;
    float zhi = min(4.0 + 1.7 * uFolds + 0.45, 14.0);
    float band = 1.7 * abs(uFolds) + 0.45;
    vec3 slice = rd / rd.y;
    for (int i = 0; i < LAYERS; i++) {
      float f = (float(i) + ign) / float(LAYERS);
      float alt = mix(base, top, f);
      vec3 p = slice * alt;
      if (p.z > zhi) break;
      if (p.z < zlo) continue;
      // Two curtains, the far one fainter. Each is a thin sheet of light.
      // Most slices of most pixels are far from both: skip those early.
      float d1 = 1.0, d2 = 1.0;
      if (abs(p.z - 2.4) <= band) d1 = abs(p.z - curtain(p.x, t, 0.0));
      if (abs(p.z - 4.0) <= band) d2 = abs(p.z - curtain(p.x, t, 1.0));
      if (min(d1, d2) > 0.45) continue;
      float sheet = exp(-d1 * d1 * 70.0) + 0.55 * exp(-d2 * d2 * 70.0);
      // Rays: fine vertical striations along the curtain, drifting sideways.
      float r1 = noise1(p.x * 26.0 + t * 0.6);
      float r2 = noise1(p.x * 7.0 - t * 0.25);
      float ray = mix(1.0, 0.15 + 2.2 * pow(r1, 3.0) * (0.4 + r2), uRays);
      // A crisp, bright lower edge, fading up into the high reaches.
      float fall = smoothstep(0.0, 0.03, f) * (0.35 + 0.65 * exp(-f * 5.0)) * pow(1.0 - f, 1.2);
      // The hottest part of the lower edge runs almost white.
      vec3 hue = mix(uLow, uHigh, smoothstep(0.25, 0.9, f)) + vec3(0.6, 1.0, 0.8) * exp(-f * 30.0) * 0.4;
      light += hue * sheet * ray * fall;
    }
    light *= uIntensity * 0.3 * smoothstep(0.0, 0.08, rd.y);
    colour += light;
  }

  colour = 1.0 - exp(-colour * 1.2);
  vec3 c = linearToSrgb(colour);
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    // Light over the page: premultiplied, alpha from its brightest channel.
    vec3 lc = linearToSrgb(1.0 - exp(-(light + vec3(star)) * 1.2));
    fragColor = vec4(lc, max(lc.r, max(lc.g, lc.b)));
    return;
  }
  fragColor = vec4(c, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<AuroraOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 8,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uShowStars: o.showStars,
      uShowLights: o.showLights,
      uIntensity: o.intensity,
      uHeight: o.height,
      uFolds: o.folds,
      uRays: o.rays,
      uStars: o.stars,
      uLow: linear(o.low),
      uHigh: linear(o.high),
      uSky: linear(o.sky),
      uTransparent: !o.showSky,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<AuroraOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function aurora(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
