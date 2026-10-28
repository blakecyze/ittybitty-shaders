// @ts-check
/**
 * ittybitty/electric-border
 *
 * Living energy running around a card's edge: a crackling line, flickering
 * arcs and a soft glow. Place the canvas over the card, bleeding past it by
 * `inset` pixels on every side so the glow has room; it is transparent
 * except for the border (and the fill, if you set one).
 *
 * https://ittybitty.dev/shaders/electric-border (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} ElectricBorderOptions
 * @property {boolean} showBorder The bright line of the border and its arcs.
 * @property {boolean} showGlow The soft light spilling from the border.
 * @property {boolean} showFill The card colour inside the border.
 * @property {number} speed How fast the energy moves.
 * @property {number} inset Distance from the canvas edge to the card edge, in CSS pixels.
 * @property {number} radius Card corner radius, in CSS pixels.
 * @property {number} thickness Width of the core line, in CSS pixels.
 * @property {number} turbulence How much the line crackles.
 * @property {number} glow Reach of the outer glow.
 * @property {import('./runtime.js').Gradient} palette Colours around the border.
 * @property {string} fill Card colour inside the border, or empty for transparent.
 * @property {'electric' | 'neon' | 'dashes'} style Crackling energy, a smooth neon tube, or marching dashes.
 * @property {boolean} interactive The border flares nearest the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {ElectricBorderOptions} */
export const defaults = {
  showBorder: true,
  showGlow: true,
  showFill: true,
  speed: 0.8,
  inset: 32,
  radius: 20,
  thickness: 1.5,
  turbulence: 0.6,
  glow: 0.6,
  palette: [
    [0, '#6be4ff'],
    [0.5, '#8f7bff'],
    [1, '#6be4ff'],
  ],
  fill: '#0e0f14',
  style: 'electric',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowBorder;
uniform float uShowGlow;
uniform float uShowFill;
uniform float uPixelRatio;
uniform float uTime;
uniform float uInset;
uniform float uRadius;
uniform float uThickness;
uniform float uTurbulence;
uniform float uGlow;
uniform vec4 uFill;        // linear RGB, alpha 0 for none
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;
uniform float uStyle;     // 0 electric, 1 neon, 2 dashes
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Noise that repeats exactly 'cells' times around the border (u is 0..1 once
// round), so the two ends of the loop meet with no seam. 'shift' scrolls it.
float loopNoise(float u, float cells, float shift) {
  float x = u * cells + shift;
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(mod(i, cells)), hash11(mod(i + 1.0, cells)), f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
}

// Cells for a feature of the given frequency (per CSS pixel) around the loop.
float cellsFor(float perimeter, float frequency) {
  return max(floor(perimeter * frequency + 0.5), 1.0);
}

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The edge the border runs along, in CSS pixels, negative inside. In a
// shaped stack (layers.js) the stack's shape stands in for it.
// @edge
float edgeDistance(vec2 p, vec2 half_) {
  return sdRoundRect(p, half_, min(uRadius, min(half_.x, half_.y)));
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

void main() {
  // CSS pixels, centred on the card.
  vec2 size = uResolution / uPixelRatio;
  vec2 p = gl_FragCoord.xy / uPixelRatio - 0.5 * size;
  vec2 half_ = max(0.5 * size - uInset, vec2(1.0));
  float d = edgeDistance(p, half_);

  // Position around the perimeter, 0..1, for noise and colour.
  float around = atan(p.y * half_.x / half_.y, p.x) / 6.28318 + 0.5;
  float perimeter = 2.0 * (half_.x + half_.y);
  float t = uTime;

  // Crackle: two octaves of 1D noise along the edge push the line in and out.
  // Every pattern along the edge repeats a whole number of times around it, so the loop has no seam.
  float jitter = loopNoise(around, cellsFor(perimeter, 0.05), -t * 3.0) * 0.65 + loopNoise(around, cellsFor(perimeter, 0.17), t * 5.3) * 0.35;
  float flicker = 0.75 + 0.25 * loopNoise(around, cellsFor(perimeter, 0.01), t * 11.0);
  float calm = uStyle > 0.5 ? 0.0 : 1.0;
  float dd = abs(d + jitter * uTurbulence * 6.0 * calm);

  float core = exp(-dd / max(uThickness, 0.3));
  float arcs = exp(-abs(d + loopNoise(around, cellsFor(perimeter, 0.09), -t * 7.0) * uTurbulence * 12.0) / 1.2) * 0.5 * calm;
  if (uStyle > 1.5) core *= smoothstep(0.35, 0.5, abs(fract(around * cellsFor(perimeter, 1.0 / 14.0) - t * 0.8) - 0.5) * 2.0 - 0.1) * 1.3;
  if (uStyle > 0.5 && uStyle < 1.5) flicker = 0.95 + 0.05 * sin(t * 3.0);
  // The border flares where the pointer is nearest.
  vec2 at = uPointer * size - 0.5 * size;
  flicker *= 1.0 + 1.6 * exp(-dot(p - at, p - at) / 9000.0) * uPointerActive * uInteractive;
  float glow = exp(-abs(d) / (4.0 + uGlow * 22.0)) * uGlow;

  // The palette runs there and back around the loop, so its ends always meet.
  vec3 tint = max(oklabToLinear(stops(1.0 - abs(2.0 * fract(around + t * 0.05) - 1.0))), 0.0);
  vec3 light = tint * ((core * 1.6 + arcs) * uShowBorder + glow * 0.8 * uShowGlow) * flicker + vec3(1.0) * core * 0.35 * uShowBorder;

  float inside = (1.0 - smoothstep(-0.5, 0.5, d)) * uShowFill;
  // Light is emissive, so it is already premultiplied; alpha must cover it.
  vec3 colour = linearToSrgb(1.0 - exp(-(uFill.rgb * inside * uFill.a + light) * 1.3));
  float alpha = max(inside * uFill.a, max(max(colour.r, colour.g), colour.b));
  fragColor = vec4(colour, alpha);
}
`;

const STYLES = { electric: 0, neon: 1, dashes: 2 };

/** @type {import('./runtime.js').EffectSpec<ElectricBorderOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    const p = pointer(ctx, { ease: 10 });
    return { frame: p.frame, destroy: p.destroy };
  },
  alpha: true,
  dpr: 2,
  time: 1,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowBorder: o.showBorder,
      uShowGlow: o.showGlow,
      uShowFill: o.showFill,
      uInset: o.inset,
      uRadius: o.radius,
      uThickness: o.thickness,
      uTurbulence: o.turbulence,
      uGlow: o.glow,
      uFill: o.fill ? [...linear(o.fill), 1] : [0, 0, 0, 0],
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      ...gradient(o.palette),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS: the card plus `inset` pixels on every side.
 * @param {Partial<ElectricBorderOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function electricBorder(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
