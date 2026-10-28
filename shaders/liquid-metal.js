// @ts-check
/**
 * ittybitty/liquid-metal
 *
 * Molten chrome: a slow, viscous surface reflecting a soft photo studio,
 * with bright softbox highlights rolling across its folds.
 *
 * https://ittybitty.dev/shaders/liquid-metal (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} LiquidMetalOptions
 * @property {number} speed How fast the metal flows.
 * @property {number} scale Size of the folds.
 * @property {number} flow How much the surface folds over itself.
 * @property {number} contrast Contrast of the reflections.
 * @property {number} warmth Colour temperature of the studio light, cool to warm.
 * @property {string} tint Colour of the metal. Grey for chrome.
 * @property {'chrome' | 'gradient' | 'thermal'} finish Chrome reflections, recoloured through a gradient, or thermal.
 * @property {import('./runtime.js').Gradient} palette Shadow to highlight, for the gradient finish.
 * @property {boolean} interactive The surface swells under the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {LiquidMetalOptions} */
export const defaults = {
  speed: 0.35,
  scale: 1,
  flow: 0.9,
  contrast: 1.1,
  warmth: 0.5,
  tint: '#c9ccd6',
  finish: 'chrome',
  palette: [
    [0, '#10131f'],
    [0.5, '#6a4bff'],
    [1, '#ffd9f0'],
  ],
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uScale;
uniform float uFlow;
uniform float uContrast;
uniform float uWarmth;
uniform vec3 uTint;       // linear RGB
uniform float uFinish;    // 0 chrome, 1 gradient, 2 thermal
uniform float uInteractive;
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

// Where the pointer presses, in surface units.
vec2 press;
float pressing;

// The surface: a plane folded by a few rounds of crossed sine waves.
float height(vec2 p, float t) {
  vec2 d = p - press;
  float bulge = 0.9 * pressing * exp(-dot(d, d) * 1.2);
  for (int i = 1; i < 5; i++) {
    float f = float(i);
    p += uFlow * 0.4 / f * vec2(sin(p.y * 1.25 * f + t + f), cos(p.x * 1.05 * f - t * 0.9 + f * 1.7));
  }
  return 0.5 * sin(p.x * 1.1 + p.y * 0.8) + 0.3 * sin(length(p) * 1.4 - t * 0.7) + bulge;
}

// The same surface with its gradient: (height, d/dx, d/dy). The derivative
// is carried through each fold (rx, ry are the gradients of p.x and p.y),
// so one pass replaces three samples for the slope.
vec3 heightGrad(vec2 p0, float t) {
  vec2 d = p0 - press;
  float bulge = 0.9 * pressing * exp(-dot(d, d) * 1.2);
  vec2 p = p0;
  vec2 rx = vec2(1.0, 0.0);
  vec2 ry = vec2(0.0, 1.0);
  for (int i = 1; i < 5; i++) {
    float f = float(i);
    float s = uFlow * 0.4 / f;
    float a = p.y * 1.25 * f + t + f;
    float b = p.x * 1.05 * f - t * 0.9 + f * 1.7;
    vec2 ca = vec2(cos(a), sin(a));
    vec2 cb = vec2(cos(b), sin(b));
    p += s * vec2(ca.y, cb.x);
    vec2 nrx = rx + s * 1.25 * f * ca.x * ry;
    ry -= s * 1.05 * f * cb.y * rx;
    rx = nrx;
  }
  float u = p.x * 1.1 + p.y * 0.8;
  float len = length(p);
  float l = len * 1.4 - t * 0.7;
  float h = 0.5 * sin(u) + 0.3 * sin(l) + bulge;
  vec2 g = 0.5 * cos(u) * (1.1 * rx + 0.8 * ry)
    + 0.42 * cos(l) * (p.x * rx + p.y * ry) / max(len, 1e-4)
    - 2.4 * bulge * d;
  return vec3(h, g);
}

// A studio: dark floor, bright ceiling, and two long softboxes.
vec3 studio(vec3 r) {
  vec3 warm = mix(vec3(0.8, 0.88, 1.0), vec3(1.0, 0.86, 0.7), uWarmth);
  vec3 cool = mix(vec3(0.7, 0.8, 1.0), vec3(0.95, 0.9, 0.85), uWarmth);
  vec3 c = mix(vec3(0.06), cool * 0.7, smoothstep(-0.5, 0.7, r.y));
  c += warm * 2.6 * exp(-pow((r.y - 0.42) * 7.0, 2.0));
  c += cool * 1.4 * exp(-pow((r.x + 0.55) * 9.0, 2.0)) * smoothstep(-0.2, 0.3, r.y);
  c += warm * 0.8 * exp(-pow((r.x - 0.7) * 12.0, 2.0));
  return c;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Distance to the stack's shape in CSS pixels, negative inside; layers.js
// supplies it. Alone there is no shape, so the metal fills the canvas.
// @edge
float shapeEdge(vec2 frag) {
  return 1e4;
}
// @end

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * 3.0 / uScale;
  float t = uTime * 0.4;
  press = (uPointer * uResolution - 0.5 * uResolution) / uResolution.y * 3.0 / uScale;
  pressing = uPointerActive * uInteractive;

  vec2 slope = heightGrad(p, t).yz;
  vec3 n = normalize(vec3(-slope * 0.55, 1.0));

  // In a shaped stack (layers.js), the metal is cast in the shape: its
  // distance field is the bevel, so the rim curves over. Alone, it fills.
  float coverage = 1.0;
  float edge = shapeEdge(gl_FragCoord.xy);
  if (edge < 1e3) {
    coverage = clamp(0.5 - edge * uPixelRatio, 0.0, 1.0);
    if (coverage <= 0.0) {
      fragColor = vec4(0.0);
      return;
    }
    vec2 gb = vec2(shapeEdge(gl_FragCoord.xy + vec2(1.0, 0.0)) - shapeEdge(gl_FragCoord.xy - vec2(1.0, 0.0)),
                   shapeEdge(gl_FragCoord.xy + vec2(0.0, 1.0)) - shapeEdge(gl_FragCoord.xy - vec2(0.0, 1.0)));
    // The bevel: a rounded shoulder, steepest at the outline and easing
    // flat over a stroke's width, so the rim curves rather than steps.
    float depth = clamp(-edge / 26.0, 0.0, 1.0);
    float bevel = (1.0 - depth) * (1.0 - depth);
    n = normalize(n + vec3(normalize(gb + 1e-6) * bevel * 0.9, 0.0));
  }

  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  vec3 colour = studio(r) * uTint;
  float fresnel = pow(1.0 - n.z, 3.0);
  colour += fresnel * 0.6 * uTint;

  colour = 1.0 - exp(-colour * 1.4);
  colour = pow(colour, vec3(uContrast));
  // Recolour: the reflection's brightness through a gradient, or a heat ramp.
  float lum = dot(colour, vec3(0.2126, 0.7152, 0.0722));
  if (uFinish > 1.5) {
    colour = clamp(vec3(lum * 3.0 - 1.4, lum * 2.6 - 0.9, lum * 3.2 - 2.2), 0.0, 1.0) + vec3(0.05, 0.0, 0.18) * (1.0 - lum);
  } else if (uFinish > 0.5) {
    colour = max(oklabToLinear(stops(lum)), 0.0);
  }
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour * coverage, coverage);
}
`;

const FINISHES = { chrome: 0, gradient: 1, thermal: 2 };

/** @type {import('./runtime.js').EffectSpec<LiquidMetalOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.25,
  time: 6,
  speed: (o) => o.speed,
  attach(ctx) {
    const p = pointer(ctx, { ease: 6 });
    return { frame: p.frame, destroy: p.destroy };
  },
  update(o) {
    return {
      uScale: o.scale,
      uFlow: o.flow,
      uContrast: o.contrast,
      uWarmth: o.warmth,
      uTint: linear(o.tint),
      uFinish: FINISHES[o.finish] ?? 0,
      uInteractive: o.interactive,
      ...gradient(o.palette),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<LiquidMetalOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function liquidMetal(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
