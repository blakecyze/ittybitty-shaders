// @ts-check
/**
 * ittybitty/topography
 *
 * Contour lines of a slowly shifting landscape. Lines stay a constant width
 * at any zoom or pixel density, every few is a heavier index line, and the
 * ground takes a faint tint from its elevation.
 *
 * https://ittybitty.dev/shaders/topography (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} TopographyOptions
 * @property {boolean} showBackground The colour behind the lines. Off, only the lines are drawn, over the page.
 * @property {number} speed How fast the land shifts.
 * @property {number} scale Size of the hills.
 * @property {number} density Contour lines per unit of height.
 * @property {number} weight Line width in CSS pixels.
 * @property {number} index Every nth line is heavier.
 * @property {number} tint How strongly elevation colours the ground.
 * @property {import('./runtime.js').Gradient} palette Line and tint colours from low to high ground.
 * @property {string} background Colour of the ground.
 * @property {'lines' | 'bands' | 'dots'} style Contour lines, filled elevation bands, or dotted contours.
 * @property {boolean} interactive The pointer raises a hill beneath it.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {TopographyOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.2,
  scale: 1,
  density: 14,
  weight: 1,
  index: 5,
  tint: 0.25,
  palette: [
    [0, '#2f6f73'],
    [0.5, '#8a8f5a'],
    [1, '#c2703d'],
  ],
  background: '#f3efe6',
  style: 'lines',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uScale;
uniform float uDensity;
uniform float uWeight;
uniform float uIndex;
uniform float uTint;
uniform vec3 uBackground;
uniform float uStyle;     // 0 lines, 1 bands, 2 dots
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = turn * p * 2.03;
    a *= 0.5;
  }
  return v;
}

// Three octaves: the warp only bends the terrain, so its finest octave
// would be lost in the bending anyway.
float fbm3(vec2 p) {
  mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
  float v = 0.5 * noise(p);
  p = turn * p * 2.03;
  v += 0.25 * noise(p);
  p = turn * p * 2.03;
  return v + 0.125 * noise(p) + 0.0625 * 0.5;
}

// Unrolled: unused stops repeat the last colour, so no loop or branch is needed.
vec3 stops(float x) {
  vec3 c = uStop0.rgb;
  c = mix(c, uStop1.rgb, clamp((x - uStop0.a) / max(uStop1.a - uStop0.a, 1e-4), 0.0, 1.0));
  c = mix(c, uStop2.rgb, clamp((x - uStop1.a) / max(uStop2.a - uStop1.a, 1e-4), 0.0, 1.0));
  c = mix(c, uStop3.rgb, clamp((x - uStop2.a) / max(uStop3.a - uStop2.a, 1e-4), 0.0, 1.0));
  c = mix(c, uStop4.rgb, clamp((x - uStop3.a) / max(uStop4.a - uStop3.a, 1e-4), 0.0, 1.0));
  c = mix(c, uStop5.rgb, clamp((x - uStop4.a) / max(uStop5.a - uStop4.a, 1e-4), 0.0, 1.0));
  return c;
}

vec3 oklabToLinear(vec3 lab) {
  vec3 lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480) * lab;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010) * (lms * lms * lms);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * 2.2 / uScale;
  float t = uTime * 0.05;
  vec2 warp = vec2(fbm3(p * 0.7 + vec2(t, -t * 0.6)), fbm3(p * 0.7 + vec2(3.1 - t * 0.5, 1.7 + t)));
  // Unclamped, so there are no flat plateaus for the contour maths to choke on.
  float height = (fbm(p * 0.8 + warp * 1.3 + vec2(t * 0.3, 0.0)) - 0.2) / 0.6;
  // The pointer raises a hill, and the contours flow around it.
  vec2 hill = p - (uPointer * uResolution - 0.5 * uResolution) / uResolution.y * 2.2 / uScale;
  height += 0.45 * exp(-dot(hill, hill) * 3.0) * uPointerActive * uInteractive;

  // Distance to the nearest contour, in pixels, via screen-space derivatives.
  float f = height * uDensity;
  float d = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-5);
  float isIndex = step(abs(mod(floor(f + 0.5), uIndex)), 0.5);
  float w = uWeight * uPixelRatio * mix(0.6, 1.25, isIndex);
  float line = 1.0 - smoothstep(w - 0.5, w + 0.5, d);
  // Dotted contours: the lines broken into beads along a fine screen grid.
  if (uStyle > 1.5) line *= step(length(fract(gl_FragCoord.xy / (5.0 * uPixelRatio)) - 0.5), 0.32);

  float h01 = clamp(height, 0.0, 1.0);
  vec3 ink = max(oklabToLinear(stops(h01)), 0.0);
  // Bands: each step of elevation filled with its own flat tint.
  float fill = uStyle > 0.5 && uStyle < 1.5 ? clamp((floor(f) + 0.5) / uDensity, 0.0, 1.0) : h01;
  vec3 ground = mix(uBackground, max(oklabToLinear(stops(fill)), 0.0), (uStyle > 0.5 && uStyle < 1.5 ? 0.55 : uTint) * fill);
  float lineMix = line * mix(0.65, 1.0, isIndex);
  if (uTransparent > 0.5) {
    fragColor = vec4(linearToSrgb(ink) * lineMix, lineMix);
    return;
  }
  vec3 colour = mix(ground, ink, lineMix);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const STYLES = { lines: 0, bands: 1, dots: 2 };

/** @type {import('./runtime.js').EffectSpec<TopographyOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 2,
  time: 30,
  speed: (o) => o.speed,
  // The land moves slowly; 30 frames a second is plenty.
  fps: () => 30,
  update(o) {
    return {
      uScale: o.scale,
      uDensity: o.density,
      uWeight: o.weight,
      uIndex: o.index,
      uTint: o.tint,
      uBackground: linear(o.background),
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
      ...gradient(o.palette),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<TopographyOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function topography(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
