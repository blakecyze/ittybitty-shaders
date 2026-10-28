// @ts-check
/**
 * ittybitty/dither
 *
 * Soft, flowing shapes rendered through a strict palette with ordered
 * dithering: the few-colour look of Playdate games and Obra Dinn, or text
 * mode, drawn in ASCII, braille or block characters.
 *
 * https://ittybitty.dev/shaders/dither (MIT)
 */
import { mount, gradient } from './runtime.js';
import { pointer } from './pointer.js';
import { glyphs } from './glyphs.js';

/**
 * @typedef {'bayer' | 'noise' | 'lines' | 'dots' | 'ascii' | 'braille' | 'blocks'} Pattern
 * @typedef {object} DitherOptions
 * @property {boolean} showBackground The darkest tone. Off, it is left clear, to overlay anything.
 * @property {number} speed How fast the shapes flow.
 * @property {number} scale Size of the shapes.
 * @property {number} warp How much the shapes curl.
 * @property {number} pixel Dither cell size in CSS pixels. Characters draw at four times this.
 * @property {Pattern} pattern Threshold pattern, or a character set.
 * @property {number} levels Tones from darkest to lightest.
 * @property {boolean} interactive The pointer magnifies the field beneath it.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 * @property {import('./runtime.js').Gradient} palette Tones from dark to light.
 */

/** @type {DitherOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.4,
  scale: 1,
  warp: 0.8,
  pixel: 3,
  pattern: 'bayer',
  levels: 4,
  interactive: true,
  responsiveness: 0.5,
  palette: [
    [0, '#15131f'],
    [0.4, '#3d2c8d'],
    [0.75, '#e0607e'],
    [1, '#fbe3c4'],
  ],
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uScale;
uniform float uWarp;
uniform float uPixel;
uniform float uPattern;   // 0 bayer, 1 noise, 2 lines, 3 dots, 4+ characters
uniform float uLevels;
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform sampler2D uGlyphs;
uniform float uGlyphsCount;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;

out vec4 fragColor;

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

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

vec3 tone(float x) {
  return linearToSrgb(oklabToLinear(stops(x)));
}

// Brightness to colour. Characters choose a glyph by density; the other
// patterns choose between two neighbouring levels per cell.
vec4 quantise(float v, vec2 px, float size) {
  v = clamp(v, 0.0, 1.0);
  float steps = max(uLevels - 1.0, 1.0);
  if (uPattern > 3.5) {
    float n = max(uGlyphsCount, 2.0);
    vec2 f = fract(px / size);
    float g = min(floor(v * n), n - 1.0);
    float ink = texture(uGlyphs, vec2((g + f.x) / n, f.y)).r;
    float level = floor(v * steps + 0.5) / steps;
    vec3 fg = tone(max(level, 1.0 / steps));
    if (uTransparent > 0.5) return vec4(fg * ink, ink);
    return vec4(mix(tone(0.0), fg, ink), 1.0);
  }
  vec2 cell = floor(px / size);
  float threshold;
  if (uPattern < 0.5) threshold = bayer8(cell);
  else if (uPattern < 1.5) threshold = fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
  else if (uPattern < 2.5) threshold = fract((cell.x + cell.y) * 0.25 + 0.125);
  else threshold = length(fract(px / size) - 0.5) * 1.41;
  float scaled = v * steps;
  float level = floor(scaled) + step(threshold, fract(scaled));
  if (uTransparent > 0.5 && level < 0.5) return vec4(0.0);
  return vec4(tone(level / steps), 1.0);
}

void main() {
  float glyph = uPattern > 3.5 ? 4.0 : 1.0;
  float size = max(uPixel * uPixelRatio * glyph, 1.0);
  vec2 cell = floor(gl_FragCoord.xy / size);
  // Evaluate the field once per cell, not per pixel: cheaper and crisper.
  vec2 p = ((cell + 0.5) * size - 0.5 * uResolution) / uResolution.y / uScale;
  float t = uTime * 0.3;

  // The pointer is a lens: the field swells beneath it.
  vec2 at = (uPointer * uResolution - 0.5 * uResolution) / uResolution.y / uScale;
  vec2 d = p - at;
  p -= d * 0.45 * exp(-dot(d, d) * 5.0) * uPointerActive * uInteractive;

  // Folded sine flow: a few rounds of domain warping give liquid shapes.
  for (int i = 1; i < 4; i++) {
    float f = float(i);
    p += uWarp * 0.3 / f * vec2(sin(p.y * 1.7 * f + t + f * 1.3), cos(p.x * 1.5 * f - t * 0.8 + f * 2.1));
  }
  float v = 0.5 + 0.5 * sin(p.x * 1.4 + p.y * 1.1 + t * 0.6);
  v = mix(v, 0.5 + 0.5 * sin(length(p) * 2.2 - t), 0.35);

  fragColor = quantise(v, gl_FragCoord.xy, size);
}
`;

const PATTERNS = { bayer: 0, noise: 1, lines: 2, dots: 3, ascii: 4, braille: 5, blocks: 6 };

/** @type {import('./runtime.js').EffectSpec<DitherOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 10,
  speed: (o) => o.speed,
  update(o) {
    return {
      uScale: o.scale,
      uWarp: o.warp,
      uPixel: o.pixel,
      uPattern: PATTERNS[o.pattern] ?? 0,
      uLevels: o.levels,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
      ...gradient(o.palette),
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 8 });
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
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<DitherOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function dither(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
