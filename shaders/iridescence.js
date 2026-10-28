// @ts-check
/**
 * ittybitty/iridescence
 *
 * Thin-film interference, the colours of oil on water and holographic foil.
 * The film's thickness drifts across the surface and tilts with the pointer,
 * so colours slide past as you move, like turning a card in the light.
 *
 * https://ittybitty.dev/shaders/iridescence (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} IridescenceOptions
 * @property {number} speed How fast the film drifts.
 * @property {number} scale Size of the colour bands.
 * @property {number} thickness Film thickness: shifts which colours appear.
 * @property {number} range How many colour bands fit across the surface.
 * @property {number} intensity Strength of the interference colours.
 * @property {number} tilt How much the pointer shifts the colours.
 * @property {string} base Colour of the surface under the film.
 * @property {'oil' | 'foil' | 'bubble'} style Oil on water, holographic foil with glitter, or a soap bubble's swirling rings.
 * @property {boolean} interactive Moving the pointer tilts the surface.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {IridescenceOptions} */
export const defaults = {
  speed: 0.3,
  scale: 1,
  thickness: 0.5,
  range: 0.7,
  intensity: 0.85,
  tilt: 0.6,
  base: '#1b1d2a',
  style: 'oil',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uScale;
uniform float uThickness;
uniform float uRange;
uniform float uIntensity;
uniform float uTilt;
uniform vec3 uBase;       // linear RGB
uniform float uStyle;     // 0 oil, 1 foil, 2 bubble
uniform float uInteractive;

out vec4 fragColor;

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

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * 2.0 / uScale;
  float t = uTime * 0.3;

  // Film thickness: smooth flowing variation plus a pointer-driven tilt.
  vec2 w = vec2(noise(p * 1.3 + t), noise(p * 1.3 - t + 4.0));
  float film = noise(p * 1.1 + w * 1.4) * 0.7 + noise(p * 3.0 - w) * 0.3;
  vec2 tilt = (uPointer - 0.5) * uPointerActive * uTilt * uInteractive;
  // Bubble: thickness in swirling rings, as a soap film drains.
  if (uStyle > 1.5) film = mix(film, fract(length(p) * 0.9 + w.x * 0.8 - t * 0.2), 0.7);
  float view = dot(uv - 0.5, vec2(0.8, 0.6)) + dot(tilt, uv - 0.5) * 2.0 + dot(tilt, vec2(1.0, 0.7));
  float d = uThickness * 2.0 + film * uRange * 2.2 + view * uRange;

  // Interference as a pearlescent cycle (pink, lilac, cyan, gold), with each
  // channel phase-shifted the way wavelengths are: foil, not a test card.
  vec3 film3 = vec3(0.62, 0.58, 0.66) + vec3(0.38, 0.32, 0.34) * cos(6.28318 * (d + vec3(0.0, 0.14, 0.3)));
  // The film shows most where the surface catches the light.
  float catchLight = smoothstep(0.02, 0.6, noise(p * 0.7 - t * 0.4 + w * 0.6));
  float sheen = catchLight * (0.35 + 0.65 * pow(noise(p * 2.0 + t * 0.2), 2.0));

  vec3 colour = uBase * (0.8 + 0.4 * catchLight) + film3 * uIntensity * sheen;
  if (uStyle > 0.5 && uStyle < 1.5) {
    // Foil: glitter that flashes as the surface tilts.
    vec2 cell = floor(gl_FragCoord.xy / 3.0);
    float g = hash12(cell);
    float flash = step(0.985, g) * pow(0.5 + 0.5 * sin(g * 90.0 + dot(tilt, vec2(40.0, 25.0)) + t * 6.0), 8.0);
    colour += film3 * flash * 2.5 * uIntensity;
  }
  colour = 1.0 - exp(-colour * 1.3);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const STYLES = { oil: 0, foil: 1, bubble: 2 };

/** @type {import('./runtime.js').EffectSpec<IridescenceOptions>} */
const base = {
  defaults,
  fragment,
  dpr: 1,
  time: 7,
  speed: (o) => o.speed,
  update(o) {
    return {
      uScale: o.scale,
      uThickness: o.thickness,
      uRange: o.range,
      uIntensity: o.intensity,
      uTilt: o.tilt,
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      uBase: linear(o.base),
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 5 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<IridescenceOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function iridescence(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
