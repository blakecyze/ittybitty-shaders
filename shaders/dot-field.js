// @ts-check
/**
 * ittybitty/dot-field
 *
 * A calm grid of dots that swell, brighten and push outward around the
 * pointer, with a slow wave passing through when nobody is interacting.
 *
 * https://ittybitty.dev/shaders/dot-field (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} DotFieldOptions
 * @property {boolean} showBackground The colour behind the marks. Off, only the marks are drawn, over the page.
 * @property {number} speed Speed of the idle wave. 0 is calm.
 * @property {number} spacing Distance between dots in CSS pixels.
 * @property {number} size Dot radius in CSS pixels.
 * @property {number} reach Radius of the pointer's influence in CSS pixels.
 * @property {number} swell How much dots grow near the pointer.
 * @property {string} color Colour of the dots at rest.
 * @property {string} accent Colour near the pointer.
 * @property {string} background Colour behind the dots.
 * @property {'dots' | 'squares' | 'plus' | 'dashes'} shape Shape of each mark. Dashes turn to face the pointer.
 * @property {boolean} idle A slow wave rolls through when there is no pointer.
 * @property {boolean} interactive Marks swell and lean away around the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {DotFieldOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.5,
  spacing: 22,
  size: 1.6,
  reach: 180,
  swell: 1.4,
  color: '#3a3a44',
  accent: '#8f7bff',
  background: '#101014',
  shape: 'dots',
  idle: true,
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uSpacing;
uniform float uSize;
uniform float uReach;
uniform float uSwell;
uniform vec3 uColor;       // linear RGB
uniform vec3 uAccent;
uniform vec3 uBackground;
uniform float uShape;     // 0 dots, 1 squares, 2 plus, 3 dashes
uniform float uIdle;
uniform float uInteractive;
uniform float uTransparent;

out vec4 fragColor;

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Work in CSS pixels so spacing and size mean what they say at any density.
  vec2 px = gl_FragCoord.xy / uPixelRatio;
  vec2 size = uResolution / uPixelRatio;
  vec2 cell = floor(px / uSpacing);
  vec2 centre = (cell + 0.5) * uSpacing;

  vec2 pointerPx = uPointer * size;
  float d = length(centre - pointerPx);
  float near = exp(-pow(d / uReach, 2.0)) * uPointerActive * uInteractive;

  // Idle: a broad diagonal wave rolls across the field.
  float wave = 0.5 + 0.5 * sin(dot(centre, vec2(0.006, 0.004)) * 6.2831 - uTime * 1.2);
  wave = pow(wave, 3.0) * (1.0 - uPointerActive * uInteractive) * uIdle;

  float influence = max(near, wave);
  // Dots near the pointer are pushed gently away from it.
  vec2 push = d > 0.0 ? (centre - pointerPx) / d * near * uSpacing * 0.25 : vec2(0.0);
  float radius = uSize * (1.0 + influence * uSwell);
  vec2 q = px - centre - push;
  float dist;
  if (uShape < 0.5) {
    dist = length(q);
  } else if (uShape < 1.5) {
    dist = max(abs(q.x), abs(q.y));
  } else if (uShape < 2.5) {
    vec2 a = abs(q);
    dist = max(min(a.x, a.y) * 3.0, max(a.x, a.y));
  } else {
    // Dashes turn to face the pointer, like iron filings round a magnet.
    vec2 dir = normalize(pointerPx - centre + vec2(1e-3, 0.0));
    dir = mix(vec2(1.0, 0.0), dir, max(uPointerActive * uInteractive, wave * 0.0));
    vec2 r = vec2(dot(q, dir), dot(q, vec2(-dir.y, dir.x)));
    dist = max(abs(r.x) * 0.45, abs(r.y) * 2.2);
  }
  float dot_ = 1.0 - smoothstep(radius - 0.75, radius + 0.75, dist);

  vec3 ink = mix(uColor, uAccent, influence);
  if (uTransparent > 0.5) {
    fragColor = vec4(linearToSrgb(ink) * dot_, dot_);
    return;
  }
  vec3 colour = mix(uBackground, ink, dot_);
  fragColor = vec4(linearToSrgb(colour), 1.0);
}
`;

const SHAPES = { dots: 0, squares: 1, plus: 2, dashes: 3 };

/** @type {import('./runtime.js').EffectSpec<DotFieldOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 1,
  speed: (o) => (o.idle ? o.speed : 0),
  update(o) {
    return {
      uSpacing: o.spacing,
      uSize: o.size,
      uReach: o.reach,
      uSwell: o.swell,
      uColor: linear(o.color),
      uAccent: linear(o.accent),
      uBackground: linear(o.background),
      uShape: SHAPES[o.shape] ?? 0,
      uIdle: o.idle,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 9 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<DotFieldOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function dotField(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
