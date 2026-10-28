// @ts-check
/**
 * ittybitty/rays
 *
 * Soft shafts of light from a single source, like sun through a high window.
 * The source can sit anywhere, including off-canvas; rays always fan towards
 * the middle of the canvas, so any origin gives a usable composition.
 *
 * https://ittybitty.dev/shaders/rays (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} RaysOptions
 * @property {boolean} showBackground The colour behind the light. Off, only the light is drawn, over the page.
 * @property {number} speed How fast the shafts drift.
 * @property {number} intensity Brightness of the light.
 * @property {number} originX Source position across the canvas; 0 is the left edge.
 * @property {number} originY Source position down the canvas; below 0 is above the top.
 * @property {number} spread Width of the beam, in radians.
 * @property {number} softness Crisp shafts at 0, diffuse light at 1.
 * @property {number} length How far the light carries before it fades.
 * @property {'solid' | 'gradient'} palette One colour, or a gradient across the beam.
 * @property {string} color Colour of the light for the solid palette.
 * @property {import('./runtime.js').Gradient} gradient Stops across the beam, left to right.
 * @property {string} background Colour of the unlit canvas.
 * @property {'shafts' | 'streaks' | 'dust'} style Broad shafts, fine streaks, or shafts with dust drifting through them.
 * @property {boolean} interactive The light source follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {RaysOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.4,
  intensity: 0.9,
  originX: 0.25,
  originY: -0.2,
  spread: 0.5,
  softness: 0.6,
  length: 0.5,
  palette: 'solid',
  color: '#fff1dc',
  gradient: [
    [0, '#ffb38a'],
    [0.5, '#fff1dc'],
    [1, '#9cc3ff'],
  ],
  background: '#101114',
  style: 'shafts',
  interactive: false,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uOrigin;     // 0..1 across the canvas, y down; may sit outside
uniform vec3 uBackground; // linear RGB
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5; // OKLab colour, position
uniform float uStopCount; // 1 for a solid colour
uniform float uIntensity;
uniform float uSpread;
uniform float uSoftness;
uniform float uLength;
uniform float uStyle;     // 0 shafts, 1 streaks, 2 dust
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

// Hashes without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// Piecewise-linear gradient through up to six OKLab stops.
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
  vec3 lms = mat3(
    1.0, 1.0, 1.0,
    0.3963377774, -0.1055613458, -0.0894841775,
    0.2158037573, -0.0638541728, -1.2914855480
  ) * lab;
  return mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193965, 1.7076147010
  ) * (lms * lms * lms);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Units of canvas height, y down, so the look holds at any aspect ratio.
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(gl_FragCoord.x / uResolution.y, 1.0 - gl_FragCoord.y / uResolution.y);
  // The pointer, when enabled, becomes the light source.
  vec2 origin = mix(uOrigin, vec2(uPointer.x, 1.0 - uPointer.y), uPointerActive * uInteractive) * vec2(aspect, 1.0);
  vec2 axis = normalize(vec2(0.5 * aspect, 0.5) - origin + vec2(0.0, 1e-4));

  vec2 d = p - origin;
  float dist = length(d);
  // Signed angle away from the axis that points at the centre of the canvas.
  float angle = atan(axis.x * d.y - axis.y * d.x, dot(axis, d));

  float t = uTime;
  // Shafts: angular noise at three scales. Each drifts at its own pace, and
  // the finest also varies along the ray so the light never looks painted on.
  float s = 0.5 * noise(angle * 11.0 + t * 0.21)
          + 0.3 * noise(angle * 23.0 - t * 0.33 + 7.0)
          + 0.2 * noise(angle * 47.0 + dist * 1.5 - t * 0.5);
  // Only the brighter part of the noise becomes a shaft, so they stay sparse,
  // and each shaft gets its own brightness so they never read as stripes.
  float edge = mix(0.03, 0.3, uSoftness);
  float shafts = smoothstep(0.55 - edge, 0.55 + edge, s);
  shafts *= 0.35 + 0.65 * noise(angle * 5.0 - t * 0.12 + 3.0);
  if (uStyle > 0.5 && uStyle < 1.5) {
    // Streaks: many fine, bright lines instead of a few broad shafts.
    float fine = noise(angle * 140.0 + t * 0.4) * noise(angle * 61.0 - t * 0.25 + 9.0);
    shafts = pow(smoothstep(0.25, 0.8, fine), 2.0) * (0.6 + 0.8 * shafts);
  }

  float window = exp(-angle * angle / (uSpread * uSpread));
  float falloff = exp(-dist / uLength) * smoothstep(0.0, 0.1, dist);
  // Haze: light scattered between the shafts, plus a bloom at the source.
  float haze = 0.2 * window * exp(-dist / uLength);
  float bloom = 0.3 * exp(-dist * dist * 24.0);

  float light = uIntensity * (shafts * window * falloff + haze + bloom);
  if (uStyle > 1.5) {
    // Dust: motes drifting slowly, visible only where the light catches them.
    vec2 q = p * 70.0 + vec2(t * 0.6, -t * 1.1);
    vec2 cell = floor(q);
    float h = hash12(cell);
    float mote = step(0.9, h) * smoothstep(0.32, 0.0, length(fract(q) - 0.5 + 0.2 * (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5)));
    light += uIntensity * mote * (0.5 + 0.5 * sin(t * 2.0 + h * 40.0)) * window * falloff * (0.3 + shafts) * 3.0;
  }
  // Soft shoulder instead of clipping, so the brightest shafts keep texture.
  // Colour runs across the beam, so a gradient fans out with the shafts.
  vec3 tint = max(oklabToLinear(stops(clamp(0.5 + angle / (2.0 * uSpread), 0.0, 1.0))), 0.0);
  vec3 glow = tint * (1.0 - exp(-1.3 * light));
  if (uTransparent > 0.5) {
    vec3 c = linearToSrgb(glow);
    fragColor = vec4(c, max(c.r, max(c.g, c.b)));
    return;
  }
  vec3 colour = linearToSrgb(uBackground + glow);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const STYLES = { shafts: 0, streaks: 1, dust: 2 };

/** @type {import('./runtime.js').EffectSpec<RaysOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const p = pointer(ctx, { ease: 5 });
    return { frame: p.frame, destroy: p.destroy };
  },
  time: 30,
  speed: (o) => o.speed,
  update(o) {
    return {
      uOrigin: [o.originX, o.originY],
      ...gradient(o.palette === 'solid' ? [[0, o.color]] : o.gradient),
      uBackground: linear(o.background),
      uIntensity: o.intensity,
      uSpread: o.spread,
      uSoftness: o.softness,
      uLength: o.length,
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<RaysOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function rays(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
