// @ts-check
/**
 * ittybitty/dither-image
 *
 * Ordered dithering for images: pixelate, quantise luminance to a few
 * levels, and map each level through your palette. It draws once per change
 * and never animates, so a page full of dithered images costs nothing at rest.
 *
 * https://ittybitty.dev/shaders/dither-image (MIT)
 */
import { mount, gradient } from './runtime.js';
import { texture } from './texture.js';
import { glyphs } from './glyphs.js';

/**
 * @typedef {object} DitherImageOptions
 * @property {boolean} showBackground The darkest tone. Off, it is left clear, to overlay anything.
 * @property {string} image Image URL. Needs CORS headers if it is on another origin.
 * @property {number} pixel Dither cell size in CSS pixels.
 * @property {'bayer' | 'noise' | 'lines' | 'dots' | 'ascii' | 'braille' | 'blocks'} pattern Threshold pattern, or a character set.
 * @property {number} levels Tones between darkest and lightest, inclusive.
 * @property {number} contrast Contrast before dithering.
 * @property {number} brightness Brightness before dithering.
 * @property {'cover' | 'contain'} fit How the image fills the canvas.
 * @property {import('./runtime.js').Gradient} palette Tones from dark to light.
 */

/** @type {DitherImageOptions} */
export const defaults = {
  showBackground: true,
  image: '',
  pixel: 2,
  pattern: 'bayer',
  levels: 2,
  contrast: 1.35,
  brightness: 0.08,
  fit: 'cover',
  palette: [
    [0, '#1d1c26'],
    [1, '#efe9dc'],
  ],
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uPixel;
uniform float uPattern;   // 0 bayer, 1 noise, 2 lines, 3 dots, 4+ characters
uniform float uTransparent;
uniform sampler2D uGlyphs;
uniform float uGlyphsCount;
uniform float uLevels;
uniform float uContrast;
uniform float uBrightness;
uniform float uContain;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5; // OKLab colour, position
uniform float uStopCount;

out vec4 fragColor;

// 8×8 Bayer threshold, computed rather than looked up.
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

// The picture being dithered. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(vec3(uv.x * 0.8 + uv.y * 0.2), 1.0);
  // Fit: cover crops, contain letterboxes in white.
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 cover = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  vec2 contain = ca > ia ? vec2(ca / ia, 1.0) : vec2(1.0, ia / ca);
  vec2 tuv = (uv - 0.5) * (uContain > 0.5 ? contain : cover) + 0.5;
  if (any(lessThan(tuv, vec2(0.0))) || any(greaterThan(tuv, vec2(1.0)))) return vec4(1.0);
  return vec4(texture(uImage, tuv, blur).rgb, 1.0);
}
// @end

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
  float lum = dot(source((cell + 0.5) * size, 0.0).rgb, vec3(0.2126, 0.7152, 0.0722));
  lum = clamp((lum - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
  fragColor = quantise(lum, gl_FragCoord.xy, size);
}
`;

const PATTERNS = { bayer: 0, noise: 1, lines: 2, dots: 3, ascii: 4, braille: 5, blocks: 6 };

/** @type {import('./runtime.js').EffectSpec<DitherImageOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uPixel: o.pixel,
      uPattern: PATTERNS[o.pattern] ?? 0,
      uLevels: o.levels,
      uContrast: o.contrast,
      uBrightness: o.brightness,
      uContain: o.fit === 'contain',
      uTransparent: !o.showBackground,
      ...gradient(o.palette),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0);
    const g = glyphs(ctx, 'uGlyphs', 1);
    return {
      update(o) {
        image.set(o.image);
        if (o.pattern === 'ascii' || o.pattern === 'braille' || o.pattern === 'blocks') g.set(o.pattern);
      },
      restore() {
        image.restore();
        g.restore();
      },
      destroy() {
        image.destroy();
        g.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<DitherImageOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function ditherImage(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
