// @ts-check
/**
 * ittybitty/rainbow
 *
 * A crown of spectral light rays hanging from the top edge. Each ray takes its
 * hue from its angle, so the fan reads as a spectrum, and the light dissolves
 * into the page colour through OKLab rather than sRGB alpha, so hues keep
 * their character as they fade instead of passing through grey.
 *
 * Soft and low-frequency, so it renders at half resolution by default.
 *
 * https://ittybitty.dev/shaders/rainbow (MIT)
 */
import { mount, linear, oklab, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} RainbowOptions
 * @property {number} speed How fast the fan wanders and the colours drift.
 * @property {number} intensity Overall strength of the light.
 * @property {number} spread Width of the fan, in radians.
 * @property {number} reach How far down the canvas the light falls.
 * @property {number} width Width of the lit area.
 * @property {number} sway A slow wave travelling down each ray.
 * @property {number} chroma Colourfulness. 0 is white light.
 * @property {number} definition Low melts rays into a glow; high carves them apart.
 * @property {'spectrum' | 'solid' | 'gradient'} palette Hue per ray, one colour, or your gradient across the fan.
 * @property {string} color Colour for the solid palette.
 * @property {import('./runtime.js').Gradient} gradient Stops for the gradient palette, left to right across the fan.
 * @property {string} background The page colour the light fades into.
 * @property {'top' | 'bottom' | 'centre'} origin Hang from the top, rise from the bottom, or radiate from the centre as a halo.
 * @property {boolean} interactive The fan leans towards the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {RainbowOptions} */
export const defaults = {
  speed: 0.6,
  intensity: 1.1,
  spread: 1,
  reach: 0.85,
  width: 1.5,
  sway: 0.35,
  chroma: 1,
  definition: 1,
  palette: 'spectrum',
  color: '#ff8a5c',
  gradient: [
    [0, '#6f6cff'],
    [0.5, '#ff7ab8'],
    [1, '#ffc15e'],
  ],
  background: '#f5f4f1',
  origin: 'top',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform vec3 uBackground; // page colour in OKLab
uniform float uDark;      // 1 on dark backgrounds, 0 on light
uniform float uIntensity;
uniform float uSpread;
uniform float uReach;
uniform float uWidth;
uniform float uSway;
uniform float uChroma;
uniform float uDefinition;
uniform float uSpectrum; // 1: hue per ray; 0: sample the stops below
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5; // OKLab colour, position
uniform float uStopCount;
uniform float uOrigin;    // 0 top, 1 bottom, 2 centre
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

const float TAU = 6.28318530718;

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

// Smooth 1D value noise in 0..1.
float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
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

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // CSS pixels, y running down from the top edge.
  vec2 size = uResolution / uPixelRatio;
  vec2 coord = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uPixelRatio;
  // Rising from the bottom is hanging from the top, upside down.
  if (uOrigin > 0.5 && uOrigin < 1.5) coord.y = size.y - coord.y;
  float halo = step(1.5, uOrigin);
  float lean = uPointerActive * uInteractive;
  vec2 pointerCss = vec2(uPointer.x, uOrigin > 0.5 && uOrigin < 1.5 ? uPointer.y : 1.0 - uPointer.y) * size;

  // The light lives in an ellipse hanging from the top centre: 0 at the top
  // edge, 1 at its rim. Narrow screens widen it so the crown spans the width.
  float narrow = 1.0 - smoothstep(480.0, 900.0, size.x);
  vec2 radius = vec2(0.5 * size.x * uWidth * (1.0 + 0.5 * narrow), size.y * uReach);
  float field = length(vec2(coord.x - 0.5 * size.x, coord.y) / radius);
  // Halo: a round field around the centre instead.
  vec2 centre = mix(0.5 * size, pointerCss, 0.35 * lean);
  float haloRadius = 0.5 * min(size.x, size.y) * uReach * 1.4 * uWidth / 1.5;
  field = mix(field, length(coord - centre) / haloRadius, halo);
  if (field >= 1.0) {
    fragColor = vec4(0.0);
    return;
  }

  // The source sits above the top edge and wanders on two unrelated periods,
  // so the fan never settles square.
  float t = uTime;
  float wander = sin(t * 0.21) * 0.6 + sin(t * 0.13 + 1.7) * 0.4;
  float sourceX = mix((0.5 + 0.05 * wander) * size.x, mix(0.5 * size.x, pointerCss.x, 0.8), lean);
  vec2 toCoord = mix(coord - vec2(sourceX, -0.2 * size.y), coord - centre, halo);
  float dist = length(toCoord);
  float angle = atan(toCoord.x, toCoord.y); // 0 points straight down

  // Sway: a slow wave travelling down each ray bends its angle.
  float a = angle + uSway * 0.06 * sin(t * 1.6 + dist * 0.012 - angle * 2.0);

  // Beams: two octaves of angular noise drifting in opposite directions.
  float beams = 0.62 * noise(a * 10.0 + t * 0.35) + 0.38 * noise(a * 23.0 - t * 0.5 + 17.0);
  beams = smoothstep(0.1, 0.95, beams);
  // Definition below 1 melts beams into a glow; above 1 carves them sharper.
  beams = max(mix(0.5, beams, uDefinition), 0.0);
  float window = mix(exp(-a * a / (uSpread * uSpread)), 1.0, halo);
  float rays = beams * window;

  // Spectrum: hue follows the angle and drifts slowly across the fan (OKLCH).
  // Otherwise the fan samples your stops left to right, keeping their colour
  // but lifting the brightest rays the same way.
  float crest = smoothstep(0.55, 0.9, rays);
  float hue = TAU * (angle * mix(0.55, 1.0 / TAU, halo) + t * 0.02);
  float chroma = uChroma * mix(0.19, 0.17, uDark) * (1.0 - 0.35 * crest * uDark);
  vec3 lab = vec3(mix(0.72, 0.78, uDark), chroma * cos(hue), chroma * sin(hue));
  if (uSpectrum < 0.5) {
    lab = stops(clamp(0.5 + angle / (2.0 * uSpread), 0.0, 1.0));
    lab.yz *= uChroma * (1.0 - 0.35 * crest * uDark);
  }
  lab.x += crest * mix(0.04, 0.08, uDark);

  // (1 - x^2)^3 leaves the top gently and meets the rim with zero slope.
  float falloff = 1.0 - field * field;
  falloff = falloff * falloff * falloff;
  float energy = max(uIntensity * rays * falloff, 0.0);
  // On dark pages a soft shoulder keeps texture in the brightest rays.
  float strength = mix(min(energy, 1.0), 1.0 - exp(-1.4 * energy), uDark);

  // Fade into the page in OKLab. On dark pages lightness falls away faster
  // than chroma, so the tail sinks into the page as a deep tint of its hue
  // rather than a grey fog.
  vec3 mixed = vec3(
    mix(uBackground.x, lab.x, mix(strength, pow(strength, 1.7), uDark)),
    mix(uBackground.yz, lab.yz, mix(strength, pow(strength, 0.75), uDark))
  );
  vec3 colour = linearToSrgb(oklabToLinear(mixed));
  // Dither to stop 8-bit banding in the long, soft fade.
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

  // Mostly opaque: the OKLab mix carries the fade, alpha only the faint tail.
  float coverage = clamp(strength * 12.0, 0.0, 1.0);
  fragColor = vec4(clamp(colour, 0.0, 1.0) * coverage, coverage);
}
`;

const ORIGINS = { top: 0, bottom: 1, centre: 2 };

/** @type {import('./runtime.js').EffectSpec<RainbowOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    const p = pointer(ctx, { ease: 2.5 });
    return { frame: p.frame, destroy: p.destroy };
  },
  alpha: true,
  dpr: 0.75,
  time: 12,
  speed: (o) => o.speed,
  update(o) {
    const background = oklab(linear(o.background));
    return {
      uBackground: background,
      uDark: background[0] < 0.6 ? 1 : 0,
      uIntensity: o.intensity,
      uSpread: o.spread,
      uReach: o.reach,
      uWidth: o.width,
      uSway: o.sway,
      uChroma: o.chroma,
      uDefinition: o.definition,
      uOrigin: ORIGINS[o.origin] ?? 0,
      uInteractive: o.interactive,
      uSpectrum: o.palette === 'spectrum',
      ...gradient(o.palette === 'solid' ? [[0, o.color]] : o.gradient),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS; place it over a page of `background` colour.
 * @param {Partial<RainbowOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function rainbow(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
