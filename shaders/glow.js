// @ts-check
/**
 * ittybitty/glow
 *
 * Two soft lights drifting slowly around a centre point: a quiet, luminous
 * field for behind cards, product shots and pricing tables. Lights add in
 * linear space and roll off with a soft shoulder, so overlaps bloom
 * naturally instead of clipping to a flat blob.
 *
 * https://ittybitty.dev/shaders/glow (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

export const defaults = {
  /** The colour behind the glow. Off, only the glow is drawn, over the page. */
  showBackground: true,
  speed: 0.3,
  intensity: 0.85,
  size: 0.32,
  spread: 0.4,
  x: 0.5,
  y: 0.5,
  colorA: '#5b6cff',
  colorB: '#ff7a59',
  background: '#0d0d10',
  /** @type {'orbs' | 'ring' | 'band'} Two drifting orbs, a halo ring, or a horizontal band of light. */
  shape: /** @type {'orbs' | 'ring' | 'band'} */ ('orbs'),
  /** The lights drift towards the pointer. */
  interactive: true,
  responsiveness: 0.5,
};

/**
 * @typedef {typeof defaults & {
 *   shape: 'orbs' | 'ring' | 'band',
 * }} GlowOptions
 */

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uCentre;     // 0..1 across the canvas, y down
uniform vec3 uColorA;     // linear RGB
uniform vec3 uColorB;
uniform vec3 uBackground;
uniform float uIntensity;
uniform float uSize;      // light radius, in units of canvas height
uniform float uSpread;    // how far the lights drift apart
uniform float uShape;     // 0 orbs, 1 ring, 2 band
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// A light with a Gaussian core and a long, gentle tail, like real glow.
float light(vec2 p, vec2 at) {
  float d2 = dot(p - at, p - at) / (uSize * uSize);
  return 0.8 * exp(-d2 * 2.0) + 0.2 / (1.0 + d2 * 6.0);
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(gl_FragCoord.x / uResolution.y, 1.0 - gl_FragCoord.y / uResolution.y);
  // The glow leans towards the pointer.
  vec2 centre = mix(uCentre, vec2(uPointer.x, 1.0 - uPointer.y), 0.6 * uPointerActive * uInteractive) * vec2(aspect, 1.0);

  // Lissajous paths on unrelated periods, so the pair never visibly repeats.
  float t = uTime;
  vec2 a = centre + uSpread * vec2(sin(t * 0.61) * 0.8, cos(t * 0.43) * 0.5) - vec2(uSpread * 0.3, 0.0);
  vec2 b = centre + uSpread * vec2(cos(t * 0.37 + 1.3) * 0.8, sin(t * 0.53 + 0.4) * 0.5) + vec2(uSpread * 0.3, 0.0);

  vec3 glow;
  if (uShape < 0.5) {
    glow = uColorA * light(p, a) + uColorB * light(p, b);
  } else if (uShape < 1.5) {
    // A ring: light falls off either side of a circle, its colour turning around it.
    vec2 q = p - centre;
    float r = abs(length(q) - uSize * (1.0 + 0.08 * sin(t * 0.7)));
    float k = 0.8 * exp(-r * r / (uSize * uSize * 0.05)) + 0.2 / (1.0 + r * r / (uSize * uSize * 0.02));
    float turn = 0.5 + 0.5 * sin(atan(q.y, q.x) + t * 0.5);
    glow = mix(uColorA, uColorB, turn) * k;
  } else {
    // A band: a soft horizontal ribbon that undulates slowly.
    float y = centre.y + uSpread * 0.3 * sin(p.x * 2.2 + t * 0.6) + 0.05 * sin(p.x * 5.1 - t);
    float r = (p.y - y) / uSize;
    float k = 0.8 * exp(-r * r * 3.0) + 0.2 / (1.0 + r * r * 8.0);
    glow = mix(uColorA, uColorB, 0.5 + 0.5 * sin(p.x * 1.3 - t * 0.4)) * k;
  }
  // Soft shoulder per channel: overlaps brighten towards white, never clip.
  vec3 light = 1.0 - exp(-uIntensity * 1.4 * glow);
  if (uTransparent > 0.5) {
    vec3 c = linearToSrgb(light);
    fragColor = vec4(c, max(c.r, max(c.g, c.b)));
    return;
  }
  vec3 colour = linearToSrgb(uBackground + light);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const SHAPES = { orbs: 0, ring: 1, band: 2 };

/** @type {import('./runtime.js').EffectSpec<GlowOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const p = pointer(ctx, { ease: 3 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 1,
  time: 4,
  speed: (o) => o.speed,
  update(o) {
    return {
      uCentre: [o.x, o.y],
      uColorA: linear(o.colorA),
      uColorB: linear(o.colorB),
      uBackground: linear(o.background),
      uIntensity: o.intensity,
      uSize: o.size,
      uSpread: o.spread,
      uShape: SHAPES[o.shape] ?? 0,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<GlowOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function glow(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
