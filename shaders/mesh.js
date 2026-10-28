// @ts-check
/**
 * ittybitty/mesh
 *
 * A grainy mesh gradient: four colours anchored near the corners, drifting
 * and folding into one another through a slow flowing warp. Colours blend in
 * OKLab, so the mixes between them stay vivid instead of turning muddy, and
 * a fine static grain gives it that printed, tactile finish.
 *
 * https://ittybitty.dev/shaders/mesh (MIT)
 */
import { mount, linear, oklab } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} MeshOptions
 * @property {number} speed How fast the colours drift.
 * @property {number} warp How much the flow folds the colours into one another.
 * @property {number} scale Zoom. Higher shows larger, calmer shapes.
 * @property {number} blend How softly neighbouring colours melt together.
 * @property {number} grain Strength of the static grain.
 * @property {string} colorA Top-left colour.
 * @property {string} colorB Top-right colour.
 * @property {string} colorC Bottom-left colour.
 * @property {string} colorD Bottom-right colour.
 * @property {'smooth' | 'bands' | 'swirl'} style Smooth blending, stepped bands of lightness, or a slow central swirl.
 * @property {boolean} interactive The colours are pulled towards the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {MeshOptions} */
export const defaults = {
  speed: 0.35,
  warp: 0.8,
  scale: 1,
  blend: 0.55,
  grain: 0.12,
  colorA: '#ff9a62',
  colorB: '#f25f9a',
  colorC: '#5a4bff',
  colorD: '#12134a',
  style: 'smooth',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform vec3 uColorA, uColorB, uColorC, uColorD; // OKLab
uniform float uWarp;
uniform float uScale;
uniform float uBlend;
uniform float uGrain;
uniform float uStyle;     // 0 smooth, 1 bands, 2 swirl
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 oklabToLinear(vec3 lab) {
  vec3 lms = mat3(
    1.0, 1.0, 1.0,
    0.3963377774, -0.1055613458, -0.0894841775,
    0.2158037573, -0.0638541728, -1.2914855480
  ) * lab;
  return mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193965, 1.7076147010
  ) * (lms * lms * lms);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Inverse-distance weight: sharper blend exponent gives more distinct areas.
float weight(vec2 p, vec2 at, float power) {
  return 1.0 / pow(dot(p - at, p - at) + 0.02, power);
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (gl_FragCoord.xy / uResolution - 0.5) * vec2(aspect, 1.0) / uScale;
  float t = uTime * 0.25;

  // The pointer pulls the colours towards itself, like a finger in paint.
  vec2 at = (uPointer - 0.5) * vec2(aspect, 1.0) / uScale;
  vec2 toward = p - at;
  p -= toward * 0.4 * exp(-dot(toward, toward) * 3.0) * uPointerActive * uInteractive;

  // Swirl: the plane turns around its centre, most near the middle.
  float r2 = dot(p, p);
  float twist = uStyle > 1.5 ? 2.2 * exp(-r2 * 1.5) * sin(t * 0.6 + 1.0) : 0.0;
  p = mat2(cos(twist), -sin(twist), sin(twist), cos(twist)) * p;

  // Flowing warp: two rounds of crossed sine waves fold the plane, so the
  // colour boundaries curl like silk rather than sliding past each other.
  for (int i = 0; i < 2; i++) {
    float f = float(i) + 1.0;
    p += uWarp * 0.22 / f * vec2(
      sin(p.y * 2.3 * f + t * 1.3 + f),
      cos(p.x * 2.0 * f - t * 1.1 + f * 1.7)
    );
  }

  // Four anchors near the corners, each drifting on its own slow orbit.
  vec2 s = vec2(0.42 * aspect, 0.38);
  vec2 a = vec2(-s.x, s.y) + 0.18 * vec2(sin(t * 0.9), cos(t * 0.7));
  vec2 b = vec2(s.x, s.y) + 0.18 * vec2(cos(t * 0.8 + 1.0), sin(t * 1.1));
  vec2 c = vec2(-s.x, -s.y) + 0.18 * vec2(cos(t * 1.2 + 2.0), sin(t * 0.6 + 1.0));
  vec2 d = vec2(s.x, -s.y) + 0.18 * vec2(sin(t * 0.7 + 3.0), cos(t * 0.9 + 2.0));

  float power = mix(0.6, 2.4, 1.0 - uBlend);
  float wa = weight(p, a, power);
  float wb = weight(p, b, power);
  float wc = weight(p, c, power);
  float wd = weight(p, d, power);
  vec3 lab = (uColorA * wa + uColorB * wb + uColorC * wc + uColorD * wd) / (wa + wb + wc + wd);

  // Bands: lightness in terraced steps, colour still continuous.
  if (uStyle > 0.5 && uStyle < 1.5) lab.x = (floor(lab.x * 9.0) + 0.5) / 9.0;
  vec3 colour = linearToSrgb(oklabToLinear(lab));
  // Static grain in CSS pixels, centred on zero so it never shifts the tone.
  float n = hash12(floor(gl_FragCoord.xy / uPixelRatio)) + hash12(gl_FragCoord.xy + 71.0) - 1.0;
  colour += n * (uGrain * 0.35 + 1.0 / 255.0);
  fragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

const STYLES = { smooth: 0, bands: 1, swirl: 2 };

/** @type {import('./runtime.js').EffectSpec<MeshOptions>} */
const base = {
  defaults,
  fragment,
  attach(ctx) {
    const p = pointer(ctx, { ease: 3 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 1.5,
  time: 8,
  speed: (o) => o.speed,
  update(o) {
    const lab = (/** @type {string} */ hex) => oklab(linear(hex));
    return {
      uColorA: lab(o.colorA),
      uColorB: lab(o.colorB),
      uColorC: lab(o.colorC),
      uColorD: lab(o.colorD),
      uWarp: o.warp,
      uScale: o.scale,
      uBlend: o.blend,
      uGrain: o.grain,
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
    };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<MeshOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function mesh(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
