// @ts-check
/**
 * ittybitty/dither-light
 *
 * A pool of dithered light that follows the pointer across a dark surface,
 * like a torch on a 1-bit screen. Without a pointer it drifts on its own.
 * When the pointer rests and the drift is off, it stops drawing entirely.
 *
 * https://ittybitty.dev/shaders/dither-light (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { glyphs } from './glyphs.js';

/**
 * @typedef {object} DitherLightOptions
 * @property {boolean} showBackground The dark behind the light. Off, only the light is drawn, over the page.
 * @property {number} speed How fast the light drifts when there is no pointer. 0 holds it still.
 * @property {number} size Radius of the light, relative to canvas height.
 * @property {number} softness How gradually the light falls off.
 * @property {number} intensity Brightness at the centre.
 * @property {number} pixel Dither cell size in CSS pixels.
 * @property {'bayer' | 'noise' | 'lines' | 'dots' | 'ascii' | 'braille' | 'blocks'} pattern Dots, lines or characters.
 * @property {'circle' | 'cone' | 'scan'} shape A round pool, a torch beam, or a horizontal scanning band.
 * @property {boolean} interactive Follow the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 * @property {string} light Colour of the light.
 * @property {string} background Colour of the unlit surface.
 */

/** @type {DitherLightOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.5,
  size: 0.45,
  softness: 0.7,
  intensity: 1,
  pixel: 3,
  pattern: 'bayer',
  shape: 'circle',
  interactive: true,
  responsiveness: 0.5,
  light: '#f3eadb',
  background: '#121216',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform vec2 uPointer;       // 0..1, y up
uniform float uPointerActive;
uniform float uSize;
uniform float uSoftness;
uniform float uIntensity;
uniform float uPixel;
uniform float uPattern;
uniform float uShape;
uniform float uInteractive;
uniform float uTransparent;
uniform sampler2D uGlyphs;
uniform float uGlyphsCount;
uniform vec3 uLight;         // linear RGB
uniform vec3 uBackground;

out vec4 fragColor;

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
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (cell + 0.5) * size / uResolution.y;

  // Idle drift on a slow figure of eight; the pointer takes over when present.
  float t = uTime * 0.4;
  vec2 drift = vec2(0.5 + 0.3 * sin(t), 0.5 + 0.2 * sin(t * 2.0));
  vec2 centre = mix(drift, uPointer, uPointerActive * uInteractive) * vec2(aspect, 1.0);

  float d;
  if (uShape < 0.5) {
    d = length(p - centre) / uSize;
  } else if (uShape < 1.5) {
    // A torch beam from below the bottom edge, aimed at the centre point:
    // narrow at the source, widening with distance, fading past its target.
    vec2 source = vec2(0.5 * aspect, -0.35);
    vec2 axis = normalize(centre - source);
    vec2 q = p - source;
    float along = max(dot(q, axis), 1e-3);
    float across = abs(axis.x * q.y - axis.y * q.x);
    float reach = length(centre - source) + uSize;
    d = across / (along * uSize * 0.9) + smoothstep(reach * 0.7, reach * 1.2, along);
  } else {
    d = abs(p.y - centre.y) / (uSize * 0.5);
  }
  float light = uIntensity * pow(clamp(1.0 - d, 0.0, 1.0), mix(0.6, 2.5, uSoftness));
  // A faint ambient level keeps the surface from reading as pure black.
  light = max(light, uTransparent > 0.5 ? 0.0 : 0.035);

  fragColor = twoTone(light, gl_FragCoord.xy, size, uBackground, uLight);
}
`;

const PATTERNS = { bayer: 0, noise: 1, lines: 2, dots: 3, ascii: 4, braille: 5, blocks: 6 };
const SHAPES = { circle: 0, cone: 1, scan: 2 };

/** @type {import('./runtime.js').EffectSpec<DitherLightOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 2,
  speed: (o) => o.speed,
  update(o) {
    return {
      uSize: o.size,
      uSoftness: o.softness,
      uIntensity: o.intensity,
      uPixel: o.pixel,
      uPattern: PATTERNS[o.pattern] ?? 0,
      uShape: SHAPES[o.shape] ?? 0,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
      uLight: linear(o.light),
      uBackground: linear(o.background),
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 12 });
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
 * @param {Partial<DitherLightOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function ditherLight(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
