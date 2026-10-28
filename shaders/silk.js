// @ts-check
/**
 * ittybitty/silk
 *
 * Heavy satin folding slowly under a soft key light. A long, anisotropic
 * sheen slides along each fold, the way light runs down real silk.
 *
 * https://ittybitty.dev/shaders/silk (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} SilkOptions
 * @property {number} speed How fast the cloth moves.
 * @property {number} scale Size of the folds.
 * @property {number} depth How deep the folds are.
 * @property {number} sheen Strength of the highlight along the folds.
 * @property {number} angle Direction of the folds, in degrees.
 * @property {string} color Colour of the silk.
 * @property {'satin' | 'velvet' | 'crushed'} style Satin sheen along the folds, velvet glow at the edges, or crushed creases.
 * @property {boolean} interactive The cloth lifts where the pointer passes beneath it.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {SilkOptions} */
export const defaults = {
  speed: 0.3,
  scale: 1,
  depth: 0.7,
  sheen: 0.8,
  angle: 30,
  color: '#6d3a5c',
  style: 'satin',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uScale;
uniform float uDepth;
uniform float uSheen;
uniform float uAngle;     // radians
uniform vec3 uColor;      // linear RGB
uniform float uStyle;     // 0 satin, 1 velvet, 2 crushed
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

vec2 lift;
float lifting;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Folds run mostly along one direction and ripple slowly across it.
float folds(vec2 p, float t) {
  float h = 0.0;
  h += sin(p.x * 1.3 + sin(p.y * 0.6 + t * 0.7) * 1.4 + t * 0.4) * 0.55;
  h += sin(p.x * 2.6 + sin(p.y * 1.1 - t * 0.5) * 1.1 - t * 0.3 + 1.7) * 0.25;
  h += sin(p.x * 5.1 + p.y * 0.4 + sin(p.y * 1.7 + t * 0.6) + 3.1) * 0.08;
  // Crushed: fine creases on top of the folds.
  if (uStyle > 1.5) h += 0.06 * sin(p.x * 11.0 + sin(p.y * 4.0) * 2.0) * sin(p.y * 7.0 + p.x * 3.0);
  vec2 d = p - lift;
  return h + 0.7 * lifting * exp(-dot(d, d) * 0.9);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * 4.0 / uScale;
  float c = cos(uAngle), s = sin(uAngle);
  p = mat2(c, -s, s, c) * p;
  float t = uTime * 0.5;
  lift = mat2(c, -s, s, c) * ((uPointer * uResolution - 0.5 * uResolution) / uResolution.y * 4.0 / uScale);
  lifting = uPointerActive * uInteractive;

  float e = 0.01;
  float h = folds(p, t);
  vec2 slope = vec2(folds(p + vec2(e, 0.0), t) - h, folds(p + vec2(0.0, e), t) - h) / e;
  vec3 n = normalize(vec3(-slope * uDepth, 1.0));

  vec3 light = normalize(vec3(-0.4, 0.5, 0.75));
  float diffuse = max(dot(n, light), 0.0);
  // Anisotropic sheen: highlights stretch along the fold (y) direction.
  vec3 h2 = normalize(light + vec3(0.0, 0.0, 1.0));
  float across = dot(n.xz, h2.xz);
  float sheen = pow(max(across, 0.0), 10.0) * uSheen;
  float occlusion = 0.55 + 0.45 * smoothstep(-0.9, 0.6, h);

  vec3 colour = uColor * (0.12 + 1.25 * diffuse * diffuse) * occlusion;
  if (uStyle > 0.5 && uStyle < 1.5) {
    // Velvet: pile catches light at grazing angles; faces turned to you go deep.
    float rim = pow(1.0 - n.z, 1.6);
    colour = uColor * (0.08 + 0.5 * diffuse) * occlusion + mix(uColor, vec3(1.0), 0.35) * rim * uSheen * 2.2;
  } else {
    colour += mix(uColor, vec3(1.0), 0.7) * sheen * 1.4 * occlusion;
  }
  colour = 1.0 - exp(-colour * 1.5);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const STYLES = { satin: 0, velvet: 1, crushed: 2 };

/** @type {import('./runtime.js').EffectSpec<SilkOptions>} */
const base = {
  defaults,
  fragment,
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 1,
  time: 5,
  speed: (o) => o.speed,
  update(o) {
    return {
      uScale: o.scale,
      uDepth: o.depth,
      uSheen: o.sheen,
      uAngle: (o.angle * Math.PI) / 180,
      uColor: linear(o.color),
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
    };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SilkOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function silk(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
