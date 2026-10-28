// @ts-check
/**
 * ittybitty/orb
 *
 * The glowing, breathing sphere of voice and AI interfaces: currents of
 * colour turning inside, a bright rim, and a halo. Drive `level` from an
 * audio meter (effect.set({ level })) and it swells and churns as you speak.
 *
 * Transparent outside the orb, so it sits on any background.
 *
 * https://ittybitty.dev/shaders/orb (MIT)
 */
import { mount, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} OrbOptions
 * @property {boolean} showOrb The sphere and its moving currents.
 * @property {boolean} showHalo The glow around the sphere.
 * @property {number} speed How fast the currents turn.
 * @property {number} size Radius, relative to the canvas's shorter side.
 * @property {number} energy Brightness of the currents.
 * @property {number} turbulence How busy the currents are.
 * @property {number} rim Brightness of the edge.
 * @property {number} glow Size of the halo.
 * @property {number} level Live input, 0 to 1: swells and excites the orb.
 * @property {import('./runtime.js').Gradient} palette Colours of the currents.
 * @property {'sphere' | 'ring' | 'wave'} style A glowing sphere, a halo ring, or a voice waveform.
 * @property {boolean} interactive The orb's currents lean towards the pointer, as if listening.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {OrbOptions} */
export const defaults = {
  showOrb: true,
  showHalo: true,
  speed: 0.6,
  size: 0.32,
  energy: 1,
  turbulence: 0.6,
  rim: 0.6,
  glow: 0.5,
  level: 0,
  style: 'sphere',
  interactive: true,
  responsiveness: 0.5,
  palette: [
    [0, '#3b2bff'],
    [0.45, '#b04bff'],
    [0.75, '#ff6fb1'],
    [1, '#ffd0a8'],
  ],
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowOrb;
uniform float uShowHalo;
uniform float uTime;
uniform float uSize;
uniform float uEnergy;
uniform float uTurbulence;
uniform float uRim;
uniform float uGlow;
uniform float uLevel;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;
uniform float uStyle;     // 0 sphere, 1 ring, 2 wave
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

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

// Tone, alpha and output, shared by the sphere and the halo-only path.
vec4 finish(vec3 colour, float inside) {
  colour = 1.0 - exp(-colour * 1.2);
  float alpha = clamp(inside + max(max(colour.r, colour.g), colour.b) * (1.0 - inside), 0.0, 1.0);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * alpha;
  return vec4(colour, alpha);
}

void main() {
  float t = uTime;
  float breathe = 1.0 + 0.025 * sin(t * 1.3) + 0.12 * uLevel;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y) / (uSize * breathe);
  // Listening: the currents lean towards the pointer.
  vec2 look = (uPointer - 0.5) * uResolution / min(uResolution.x, uResolution.y) / uSize;
  p -= clamp(look, -1.5, 1.5) * 0.12 * uPointerActive * uInteractive;
  float r = length(p);

  // Outside the sphere (and its ring) only the halo shows: skip the currents,
  // which is most of the canvas.
  if (uStyle < 1.5 && r > (uStyle > 0.5 ? 1.3 : 1.0)) {
    float halo = exp(-(r - 1.0) * mix(14.0, 3.0, uGlow)) * (0.5 + 0.5 * uLevel);
    fragColor = finish(max(oklabToLinear(stops(0.5)), 0.0) * halo * uGlow * 1.4 * uShowHalo, 0.0);
    return;
  }

  // Inside: currents on the sphere's surface. The z term curves the flow so
  // it reads as a ball rather than a disc.
  float z = sqrt(max(1.0 - r * r, 0.0));
  vec2 q = p / (0.6 + z) * 1.6;
  float busy = uTurbulence * (1.0 + uLevel);
  vec2 w = vec2(noise(q * 1.5 + vec2(t * 0.35, 0.0)), noise(q * 1.5 + vec2(0.0, -t * 0.3) + 5.0));
  float n = noise(q * (1.2 + busy) + w * (1.0 + busy * 1.5) + t * 0.2);
  float swirl = 0.5 + 0.5 * sin(atan(p.y, p.x) * 2.0 + n * 5.0 - t * 0.8);
  // The swirl fades out at the centre, where its angle is undefined.
  float x = clamp(mix(n, swirl, 0.45 * smoothstep(0.0, 0.6, r)) + (p.y * 0.25), 0.0, 1.0);

  vec3 current = max(oklabToLinear(stops(x)), 0.0);
  float edge = pow(1.0 - z, 2.5);
  vec3 body = current * (0.35 + 0.9 * uEnergy * (0.6 + 0.4 * n));
  body += (current * 1.4 + 0.25) * edge * uRim;

  float inside = 1.0 - smoothstep(0.985, 1.0, r);
  if (uStyle > 0.5 && uStyle < 1.5) {
    // Ring: only a band near the rim glows, turning with the currents.
    float band = exp(-pow((r - 0.82) / (0.1 + 0.05 * uLevel), 2.0));
    body = current * band * (0.8 + uEnergy) + current * 0.15 * inside;
    inside = band;
  } else if (uStyle > 1.5) {
    // Wave: a voice waveform, its amplitude following the level.
    float amp = (0.18 + 0.5 * uLevel) * (1.0 - smoothstep(0.4, 1.0, abs(p.x)));
    float y = amp * sin(p.x * 7.0 - t * 3.0) * sin(p.x * 3.1 + t * 1.3);
    float line = exp(-pow((p.y - y) / 0.05, 2.0)) + 0.4 * exp(-pow((p.y + y * 0.6) / 0.04, 2.0));
    body = max(oklabToLinear(stops(0.5 + 0.5 * sin(p.x * 2.0 + t))), 0.0) * line * (0.8 + uEnergy);
    inside = clamp(line, 0.0, 1.0) * (1.0 - smoothstep(0.9, 1.1, abs(p.x)));
  }
  // Halo: soft light outside the sphere, tinted by the palette's middle.
  float halo = exp(-max(r - 1.0, 0.0) * mix(14.0, 3.0, uGlow)) * (1.0 - inside) * (0.5 + 0.5 * uLevel);
  vec3 haloColour = max(oklabToLinear(stops(0.5)), 0.0) * halo * uGlow * 1.4 * uShowHalo;
  inside *= uShowOrb;

  fragColor = finish(body * inside + haloColour, inside);
}
`;

const STYLES = { sphere: 0, ring: 1, wave: 2 };

/** @type {import('./runtime.js').EffectSpec<OrbOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    const p = pointer(ctx, { ease: 3 });
    return { frame: p.frame, destroy: p.destroy };
  },
  alpha: true,
  dpr: 1.5,
  time: 4,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowOrb: o.showOrb,
      uShowHalo: o.showHalo,
      uSize: o.size,
      uEnergy: o.energy,
      uTurbulence: o.turbulence,
      uRim: o.rim,
      uGlow: o.glow,
      uLevel: o.level,
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      ...gradient(o.palette),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS; transparent around the orb.
 * @param {Partial<OrbOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function orb(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
