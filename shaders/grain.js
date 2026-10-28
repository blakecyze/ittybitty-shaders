// @ts-check
/**
 * ittybitty/grain
 *
 * Static film grain as a transparent overlay. The canvas is mid-grey where
 * the grain is neutral and blends onto whatever sits beneath it with a CSS
 * blend mode, so it adds tooth to flat fills and breaks up gradient banding.
 *
 * It never animates: one draw on mount and one per change, then the GPU is
 * idle. Motion-safe by construction.
 *
 * https://ittybitty.dev/shaders/grain (MIT)
 */
import { mount } from './runtime.js';

/**
 * @typedef {object} GrainOptions
 * @property {number} amount Opacity of the grain layer, 0 to 1.
 * @property {number} size Grain size in CSS pixels.
 * @property {boolean} colour Per-channel grain instead of monochrome.
 * @property {'soft-light' | 'overlay' | 'normal'} blend CSS blend mode onto the content below.
 * @property {'film' | 'paper' | 'digital' | 'scanlines'} type Soft film grain, paper fibres, blocky sensor noise, or scanlines.
 */

/** @type {GrainOptions} */
export const defaults = {
  amount: 0.35,
  size: 1.2,
  colour: false,
  blend: 'soft-light',
  type: 'film',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uAmount;
uniform float uSize;   // grain size in CSS pixels
uniform float uColour; // 0 monochrome, 1 per-channel grain
uniform float uType;   // 0 film, 1 paper, 2 digital, 3 scanlines

out vec4 fragColor;

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
vec3 hash32(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

// Smoothly interpolated lattice noise, so grain larger than a pixel reads as
// soft clumps rather than square blocks.
vec3 grain(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash32(i), hash32(i + vec2(1.0, 0.0)), f.x),
    mix(hash32(i + vec2(0.0, 1.0)), hash32(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  vec2 p = gl_FragCoord.xy / (uPixelRatio * uSize);
  // Two unrelated samples averaged pull the distribution towards the middle, like film.
  vec3 n = 0.5 * (grain(p + 173.0) + grain(p * 1.9 - 311.0));
  if (uType > 0.5 && uType < 1.5) {
    // Paper: long fibres laid mostly one way, over a faint tooth.
    vec3 fibre = grain(vec2(p.x * 0.12 + p.y * 0.05, p.y * 1.6) + 40.0);
    n = mix(n, fibre, 0.6);
  } else if (uType > 1.5 && uType < 2.5) {
    // Digital: square sensor blocks, noise per channel.
    n = hash32(floor(p) + 7.0);
  } else if (uType > 2.5) {
    // Scanlines: fine horizontal lines, gently noisy.
    n = vec3(0.5 + 0.35 * sin(gl_FragCoord.y / (uPixelRatio * uSize) * 3.14159) + (n.r - 0.5) * 0.4);
  }
  float mono = (n.r + n.g + n.b) / 3.0;
  vec3 value = mix(vec3(mono), n, uColour);
  // Mid-grey is neutral under soft-light and overlay; stretch around it.
  vec3 colour = clamp(0.5 + (value - 0.5) * 2.6, 0.0, 1.0);
  fragColor = vec4(colour * uAmount, uAmount);
}
`;

const TYPES = { film: 0, paper: 1, digital: 2, scanlines: 3 };

/** @type {import('./runtime.js').EffectSpec<GrainOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  // Static: the runtime draws once and again only when an option changes.
  speed: () => 0,
  update(o, canvas) {
    canvas.style.mixBlendMode = o.blend;
    return {
      uAmount: o.amount,
      uSize: o.size,
      uColour: o.colour,
      uType: TYPES[o.type] ?? 0,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS, positioned over the content to texture.
 * @param {Partial<GrainOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function grain(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
