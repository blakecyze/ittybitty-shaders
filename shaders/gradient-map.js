// @ts-check
/**
 * ittybitty/gradient-map
 *
 * The classic gradient map: an image's lightness, from shadow to highlight,
 * replaced by your gradient. On its own it maps an image; as a layer it maps
 * everything beneath it, so any effect can be recoloured. Smooth, or
 * posterised into flat steps. Static: one draw per change.
 *
 * https://ittybitty.dev/shaders/gradient-map (MIT)
 */
import { mount, gradient } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} GradientMapOptions
 * @property {string} image Image to map. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'smooth' | 'steps'} style A continuous gradient, or flat posterised steps.
 * @property {number} steps Number of flat tones, for the steps style.
 * @property {number} contrast Contrast of the lightness before mapping.
 * @property {number} brightness Brightness before mapping.
 * @property {boolean} reverse Map highlights to the start of the gradient instead.
 * @property {import('./runtime.js').Gradient} palette Shadow to highlight.
 */

/** @type {GradientMapOptions} */
export const defaults = {
  image: '',
  style: 'smooth',
  steps: 5,
  contrast: 1.1,
  brightness: 0,
  reverse: false,
  palette: [
    [0, '#1a1036'],
    [0.45, '#d4336f'],
    [0.8, '#ffb86b'],
    [1, '#fff6e0'],
  ],
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uStyle;     // 0 smooth, 1 steps
uniform float uSteps;
uniform float uContrast;
uniform float uBrightness;
uniform float uReverse;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;

out vec4 fragColor;

// The picture being mapped. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(vec3(uv.x * 0.85 + uv.y * 0.15), 1.0);
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

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

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec4 src = source(gl_FragCoord.xy, 0.0);
  float lum = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  lum = clamp((lum - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
  if (uReverse > 0.5) lum = 1.0 - lum;
  if (uStyle > 0.5) lum = (floor(lum * uSteps * 0.999) + 0.5) / uSteps;
  vec3 colour = linearToSrgb(oklabToLinear(stops(lum)));
  if (uStyle < 0.5) colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<GradientMapOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uStyle: o.style === 'steps',
      uSteps: o.steps,
      uContrast: o.contrast,
      uBrightness: o.brightness,
      uReverse: o.reverse,
      ...gradient(o.palette),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0);
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<GradientMapOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function gradientMap(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
