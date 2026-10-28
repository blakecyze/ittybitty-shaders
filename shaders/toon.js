// @ts-check
/**
 * ittybitty/toon
 *
 * Turns an image, or the layers beneath, into a comic panel: confident ink
 * outlines where colour and light change, flat bands of tone, and optional
 * halftone dots or hatching in the shadows. Static: one draw per change.
 *
 * https://ittybitty.dev/shaders/toon (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} ToonOptions
 * @property {boolean} showPaper The paper. Off, with the colour off too, only the ink is drawn, over the page.
 * @property {boolean} showColour The flat bands of colour. Off, a colouring book: lines on paper.
 * @property {boolean} showShading Dots or hatching in the shadows.
 * @property {boolean} showLines The inked outlines.
 * @property {string} image Picture to ink. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} lines Thickness of the ink lines.
 * @property {number} detail How much small detail gets a line.
 * @property {number} bands Flat tones from shadow to light.
 * @property {'flat' | 'dots' | 'hatch'} shading Shadows as flat colour, halftone dots or pen hatching.
 * @property {number} saturation Strength of the colour.
 * @property {string} ink Colour of the lines.
 * @property {string} paper Colour of the paper, showing through the lightest tones.
 */

/** @type {ToonOptions} */
export const defaults = {
  showPaper: true,
  showColour: true,
  showShading: true,
  showLines: true,
  image: '',
  lines: 1,
  detail: 0.5,
  bands: 4,
  shading: 'dots',
  saturation: 1.25,
  ink: '#16110e',
  paper: '#fbf6ea',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowPaper;
uniform float uShowColour;
uniform float uShowShading;
uniform float uShowLines;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uLines;
uniform float uDetail;
uniform float uBands;
uniform float uShading;   // 0 flat, 1 dots, 2 hatch
uniform float uSaturation;
uniform vec3 uInk;        // linear RGB
uniform vec3 uPaper;

out vec4 fragColor;

// The picture being inked. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    vec2 d = (uv - vec2(0.5, 0.45)) * vec2(uResolution.x / uResolution.y, 1.0);
    float ball = smoothstep(0.3, 0.29, length(d));
    vec3 c = mix(vec3(0.85, 0.82, 0.76), vec3(0.9, 0.35, 0.25) * (0.5 + 0.8 * clamp(dot(normalize(vec3(d, 0.3)), vec3(-0.5, 0.6, 0.6)), 0.0, 1.0)), ball);
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  // Smooth first, so lines follow shapes rather than every bit of texture.
  float blur = mix(2.5, 0.5, uDetail);
  vec3 base = srgbToLinear(source(px, blur).rgb);

  // Outlines: colour differences across the two diagonals, a line-width apart.
  // Four samples do the work of a nine-sample Sobel for lines this soft.
  float w = uLines * uPixelRatio * 1.2;
  vec3 tl = source(px + vec2(-w, w), blur).rgb, tr = source(px + vec2(w, w), blur).rgb;
  vec3 bl = source(px + vec2(-w, -w), blur).rgb, br = source(px + vec2(w, -w), blur).rgb;
  float edge = (length(tr - bl) + length(tl - br)) * 3.4;
  float threshold = mix(0.9, 0.25, uDetail);
  float line = smoothstep(threshold, threshold * 1.6, edge);

  // Tone: brightness in a few flat bands, colour kept and pushed a little.
  // Bands are cut from a softer copy, so their edges follow smooth contours
  // rather than the compression blocks of the source image.
  float l = luma(srgbToLinear(source(px, blur + 2.0).rgb));
  // Stepped, with each step's edge smoothed over a pixel, so bands never stair-step.
  float x = pow(l, 0.8) * uBands;
  float fw = max(fwidth(x), 1e-3);
  float band = (floor(x) + smoothstep(0.5 - fw, 0.5 + fw, fract(x))) / uBands;
  vec3 hue = base / max(luma(base), 1e-3);
  hue = mix(vec3(1.0), hue, uSaturation);
  vec3 flat_ = clamp(hue * band, 0.0, 1.0);
  // Printed on the paper: the paper's tint shows through every colour.
  // Premultiplied colour and coverage: without colour or paper, only the
  // ink is left, over the page.
  float alpha = max(uShowColour, uShowPaper);
  vec3 colour = mix(uPaper, flat_ * uPaper, uShowColour) * alpha;

  // Shadows: printed dots or pen hatching instead of flat dark colour.
  vec2 css = px / uPixelRatio;
  float shade = 1.0 - smoothstep(0.1, 0.55, l);
  shade *= uShowShading;
  if (uShading > 0.5 && uShading < 1.5) {
    mat2 turn = mat2(0.707, 0.707, -0.707, 0.707);
    vec2 g = fract(turn * css / 6.0) - 0.5;
    float dot_ = smoothstep(0.1, 0.0, length(g) - shade * 0.5);
    colour = mix(colour * 1.35, uInk, dot_ * shade * 0.85);
    alpha = mix(alpha, 1.0, dot_ * shade * 0.85);
  } else if (uShading > 1.5) {
    float hatch = smoothstep(0.35, 0.0, abs(fract((css.x + css.y) / 5.0) - 0.5) - (0.5 - shade * 0.45));
    float cross = smoothstep(0.35, 0.0, abs(fract((css.x - css.y) / 5.0) - 0.5) - (0.5 - max(shade - 0.5, 0.0) * 0.9));
    colour = mix(colour * 1.35, uInk, max(hatch, cross) * shade);
    alpha = mix(alpha, 1.0, max(hatch, cross) * shade);
  }

  line *= uShowLines;
  colour = mix(colour, uInk, line);
  alpha = mix(alpha, 1.0, line);
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

const SHADING = { flat: 0, dots: 1, hatch: 2 };

/** @type {import('./runtime.js').EffectSpec<ToonOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowPaper: o.showPaper,
      uShowColour: o.showColour,
      uShowShading: o.showShading,
      uShowLines: o.showLines,
      uLines: o.lines,
      uDetail: o.detail,
      uBands: o.bands,
      uShading: SHADING[o.shading] ?? 0,
      uSaturation: o.saturation,
      uInk: linear(o.ink),
      uPaper: linear(o.paper),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<ToonOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function toon(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
