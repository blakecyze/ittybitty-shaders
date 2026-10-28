// @ts-check
/**
 * ittybitty/dither-haze
 *
 * A page background that is almost flat: a scatter of dithered ink whose
 * density drifts like weather, thick in some places and gone in others. It
 * gives a plain background texture and depth without competing with content.
 *
 * https://ittybitty.dev/shaders/dither-haze (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { glyphs } from './glyphs.js';

/**
 * @typedef {object} DitherHazeOptions
 * @property {boolean} showBackground The paper behind the ink. Off, only the ink is drawn, over the page.
 * @property {number} speed How fast the haze drifts. 0 is static.
 * @property {number} density Average amount of ink.
 * @property {number} variation How much the density varies across the page.
 * @property {number} scale Size of the dense and sparse areas.
 * @property {number} pixel Dither cell size in CSS pixels.
 * @property {'bayer' | 'noise' | 'lines' | 'dots' | 'ascii' | 'braille' | 'blocks'} pattern Dots, lines or characters.
 * @property {boolean} interactive The pointer wipes the haze away where it passes.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 * @property {string} ink Colour of the dots.
 * @property {string} background Colour of the page.
 */

/** @type {DitherHazeOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.15,
  density: 0.2,
  variation: 0.8,
  scale: 1,
  pixel: 2,
  pattern: 'noise',
  interactive: true,
  responsiveness: 0.5,
  ink: '#bdb6a8',
  background: '#f5f4f1',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uDensity;
uniform float uVariation;
uniform float uScale;
uniform float uPixel;
uniform float uPattern;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uTransparent;
uniform sampler2D uGlyphs;
uniform float uGlyphsCount;
uniform vec3 uInk;        // linear RGB
uniform vec3 uBackground;

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

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Two-tone dithering: background or ink per pixel, by pattern or character.
vec4 twoTone(float v, vec2 px, float size, vec3 bg, vec3 fg) {
  v = clamp(v, 0.0, 1.0);
  float ink;
  if (uPattern > 3.5) {
    float n = max(uGlyphsCount, 2.0);
    vec2 f = fract(px / size);
    ink = texture(uGlyphs, vec2((min(floor(v * n), n - 1.0) + f.x) / n, f.y)).r;
  } else {
    vec2 cell = floor(px / size);
    float threshold;
    if (uPattern < 0.5) threshold = bayer8(cell);
    else if (uPattern < 1.5) threshold = fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
    else if (uPattern < 2.5) threshold = fract((cell.x + cell.y) * 0.25 + 0.125);
    else threshold = length(fract(px / size) - 0.5) * 1.41;
    ink = step(threshold, v - 0.001);
  }
  vec3 c = linearToSrgb(mix(bg, fg, ink));
  if (uTransparent > 0.5) return vec4(linearToSrgb(fg) * ink, ink);
  return vec4(c, 1.0);
}

void main() {
  float size = max(uPixel * uPixelRatio * (uPattern > 3.5 ? 4.0 : 1.0), 1.0);
  vec2 cell = floor(gl_FragCoord.xy / size);
  vec2 p = cell * size / uResolution.y / uScale * 2.5;
  float t = uTime * 0.2;

  // Two octaves of drifting noise decide how much ink each area gets.
  float n = 0.65 * noise(p + vec2(t, t * 0.4)) + 0.35 * noise(p * 2.3 - vec2(t * 0.7, 0.0) + 5.0);
  float density = clamp(uDensity + (n - 0.5) * 1.6 * uVariation * (0.4 + uDensity), 0.0, 1.0);

  // The pointer wipes a soft clearing through the haze.
  vec2 at = uPointer * uResolution;
  float wipe = exp(-dot(cell * size - at, cell * size - at) / (140.0 * 140.0 * uPixelRatio * uPixelRatio));
  density *= 1.0 - wipe * uPointerActive * uInteractive;

  fragColor = twoTone(density, gl_FragCoord.xy, size, uBackground, uInk);
}
`;

const PATTERNS = { bayer: 0, noise: 1, lines: 2, dots: 3, ascii: 4, braille: 5, blocks: 6 };

/** @type {import('./runtime.js').EffectSpec<DitherHazeOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 20,
  speed: (o) => o.speed,
  // Haze moves slowly; 20 frames a second is indistinguishable and a third of the work.
  fps: () => 20,
  update(o) {
    return {
      uDensity: o.density,
      uVariation: o.variation,
      uScale: o.scale,
      uPixel: o.pixel,
      uPattern: PATTERNS[o.pattern] ?? 1,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
      uInk: linear(o.ink),
      uBackground: linear(o.background),
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 6 });
    const g = glyphs(ctx, 'uGlyphs', 0);
    return {
      update(o) {
        if (o.pattern === 'ascii' || o.pattern === 'braille' || o.pattern === 'blocks') g.set(o.pattern);
      },
      frame: p.frame,
      restore: g.restore,
      destroy() {
        p.destroy();
        g.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS; usually fixed behind the page.
 * @param {Partial<DitherHazeOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function ditherHaze(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
