// @ts-check
/**
 * ittybitty/surface
 *
 * Open water seen from straight above. The surface is a sum of wind waves
 * and a finer chop, with optional rain rings, all with exact slopes. It
 * mirrors a sky with drifting clouds, or your own image, distorted by those
 * slopes, and weighs reflection against the water's own colour the way real
 * water does: more mirror where the waves tilt, more depth where they are
 * flat. Transparent, it becomes a film of reflections over anything.
 *
 * https://ittybitty.dev/shaders/surface (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} SurfaceOptions
 * @property {boolean} showWater The colour of the water itself. Off, only the reflections and glints are drawn, over the page.
 * @property {boolean} showReflections The sky, clouds or image mirrored in the water.
 * @property {boolean} showGlints Sunlight glinting off the ripples.
 * @property {number} speed How fast the water moves.
 * @property {number} scale Size of the waves.
 * @property {number} waves Height of the wind waves.
 * @property {number} chop Fine ripples over the waves.
 * @property {number} wind Direction the wind blows, in degrees.
 * @property {number} rain Raindrops landing on the surface.
 * @property {number} reflection How much the surface mirrors what is above it.
 * @property {number} sun Brightness of the sun's glints.
 * @property {'sky' | 'image'} source Reflect a sky with drifting clouds, or your image.
 * @property {string} image Image to reflect. Needs CORS headers if cross-origin.
 * @property {string} sky Colour of the reflected sky.
 * @property {string} clouds Colour of the reflected clouds.
 * @property {string} water Colour of the water itself.
 * @property {boolean} interactive The pointer drags ripples through the water.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {SurfaceOptions} */
export const defaults = {
  showWater: true,
  showReflections: true,
  showGlints: true,
  speed: 0.5,
  scale: 1,
  waves: 0.6,
  chop: 0.5,
  wind: 30,
  rain: 0,
  reflection: 0.7,
  sun: 0.6,
  source: 'sky',
  image: '',
  sky: '#5f9fd8',
  clouds: '#f4f6f8',
  water: '#0b3346',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowReflections;
uniform float uShowGlints;
uniform float uPixelRatio;
uniform float uTime;
uniform float uWaves;
uniform float uChop;
uniform vec2 uWind;       // unit direction
uniform vec4 uWave[5];    // xy frequency vector, z speed, w amplitude
uniform float uRain;
uniform float uReflection;
uniform float uSun;
uniform float uSource;    // 0 sky, 1 image
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform vec3 uSky;        // linear RGB
uniform vec3 uClouds;
uniform vec3 uWater;
uniform float uTransparent;
uniform float uInteractive;
uniform float uScale;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec2 hash22(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

const mat2 TURN = mat2(0.8, 0.6, -0.6, 0.8);
const mat2 TURN2 = mat2(0.28, 0.96, -0.96, 0.28);
const float UNIT = 400.0; // CSS pixels per unit of surface

// Value noise with its analytic gradient: (value, d/dx, d/dy).
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Quintic: a smooth gradient too, so no grid shows in the ripples.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1, 0));
  float c = hash12(i + vec2(0, 1));
  float d = hash12(i + vec2(1, 1));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}

float noise(vec2 p) {
  return noised(p).x;
}

// Slope of the surface at p: wind waves fanned around the wind, a fine chop,
// rain rings, and a wake behind the pointer. Only the slope matters from above.
vec2 slope(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 side = vec2(-uWind.y, uWind.x);
  // Wind waves: long crests across the wind, each at its own pace.
  if (uWaves != 0.0) {
    for (int i = 0; i < 5; i++) {
      float f = float(i);
      vec4 wave = uWave[i];
      float phase = dot(wave.xy, p) - t * wave.z + f * 2.1;
      g += wave.xy * (wave.w * cos(phase));
    }
  }
  g *= uWaves * 0.14;
  // Chop: three octaves of noise, carried along by the wind.
  // Ripples carry the look from above: their tilted faces catch the sky.
  if (uChop != 0.0) {
    vec3 n1 = noised(p * 6.0 - uWind * t * 0.9);
    // The finer octave is turned off the grid, and its slope turned back.
    vec3 n2 = noised(TURN * p * 14.0 + side * t * 0.7 + 3.0);
    // The finest ripples, turned again: detail a 2× screen can show.
    vec3 n3 = noised(TURN2 * p * 31.0 - uWind * t * 1.4 + 7.0);
    g += (n1.yz * 6.0 + (n2.yz * TURN) * 14.0 * 0.35 + (n3.yz * TURN2) * 31.0 * 0.12) * uChop * 0.02;
  }
  // Rain: in each cell, a drop lands at its own moment and a ring spreads.
  if (uRain > 0.0) {
    vec2 rp = p * 3.0;
    vec2 cell = floor(rp);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 c = cell + vec2(x, y);
        vec2 h = hash22(c);
        float cycle = t * 0.9 + h.x * 7.0;
        float age = fract(cycle);
        // Not every cell gets a drop each cycle: that is what rain amount sets.
        if (hash12(c + floor(cycle)) > uRain) continue;
        vec2 d = rp - (c + 0.2 + 0.6 * hash22(c + floor(cycle) * 1.7));
        float r = length(d) + 1e-4;
        float front = r - age * 1.4;
        float ring = cos(front * 38.0) * exp(-front * front * 60.0) * (1.0 - age) * (1.0 - age);
        g += d / r * ring * 0.25;
      }
    }
  }
  // Wake: ripples spreading from the pointer.
  if (uPointerActive * uInteractive > 0.0) {
    vec2 d = p - uPointer * uResolution / uPixelRatio / UNIT * 3.0 / uScale;
    float r = length(d) + 1e-4;
    g += d / r * cos(r * 22.0 - t * 6.0) * exp(-r * 2.2) * 0.08 * uPointerActive * uInteractive;
  }
  return g;
}

// What the water mirrors, looking up along r from p.
vec3 above(vec2 p, vec3 r, float t) {
  vec2 q = p * 0.12 + r.xy / max(r.z, 0.2) * 0.2;
  if (uSource > 0.5) {
    if (uImageReady < 0.5) return uSky;
    // The image covers the view, mirrored, and moves with the reflection.
    vec2 uv = gl_FragCoord.xy / uResolution;
    float ca = uResolution.x / uResolution.y;
    float ia = uImageSize.x / max(uImageSize.y, 1.0);
    vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
    uv = (uv - 0.5) * s + 0.5 + r.xy / max(r.z, 0.2) * 0.08;
    return texture(uImage, clamp(vec2(uv.x, 1.0 - uv.y), 0.0, 1.0)).rgb;
  }
  // Sky: deepest overhead, paler towards the horizon, with soft clouds.
  vec3 sky = mix(uSky, mix(uSky, vec3(1.0), 0.35), smoothstep(0.9, 0.4, r.z));
  vec2 c = q * 5.5 + vec2(t * 0.05, t * 0.02);
  float cloud = noise(c) * 0.55 + noise(c * 2.1 + 5.0) * 0.3 + noise(c * 4.3 + 9.0) * 0.15;
  cloud = smoothstep(0.46, 0.88, cloud);
  return mix(sky, uClouds, cloud * 0.9);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Sized in CSS pixels, not relative to the canvas: a bigger canvas shows
  // more water, not magnified water.
  vec2 p = gl_FragCoord.xy / uPixelRatio / UNIT * 3.0 / uScale;
  float t = uTime;

  vec2 g = slope(p, t);
  vec3 n = normalize(vec3(-g, 1.0));
  // Looking straight down: the reflected ray tilts with the surface.
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);

  // More mirror where the waves tilt, more depth where the water lies flat.
  float tilt = clamp((1.0 - n.z) * 22.0, 0.0, 1.0);
  float mirror = uReflection * mix(0.12, 1.0, tilt * tilt * (3.0 - 2.0 * tilt));

  vec3 reflected = uShowReflections > 0.0 ? above(p, r, t) * uShowReflections : vec3(0.0);
  // The water's own colour, a little lighter where light scatters up through crests.
  // Faces turned towards the light are brighter, those turned away darker,
  // which is what shows the shape of the waves.
  vec2 lightDir = normalize(vec2(0.3, 0.45));
  float relief = clamp(1.0 + dot(g, lightDir) * 1.5, 0.6, 1.4);
  vec3 body = uWater * relief * (0.8 + 0.6 * smoothstep(0.0, 0.08, dot(g, uWind)));

  vec3 sunDir = normalize(vec3(0.3, 0.45, 1.0));
  float glint = (pow(max(dot(r, sunDir), 0.0), 320.0) * 9.0 + pow(max(dot(r, sunDir), 0.0), 40.0) * 0.2) * uShowGlints;
  vec3 colour = mix(body, reflected * relief, mirror) + vec3(1.0, 0.97, 0.9) * glint * uSun;

  if (uTransparent > 0.5) {
    // A film over the page, drawn in light and shade: ripple faces turned to
    // the light carry the reflection and glints, faces turned away darken a
    // little with the water's colour, and flat water barely tints the page.
    float shade = dot(g, lightDir) * 5.0;
    float bright = clamp(clamp(shade, 0.0, 1.0) * uReflection * uShowReflections + glint * uSun, 0.0, 1.0);
    float dark = clamp(-shade, 0.0, 1.0) * 0.45 + 0.06;
    float a = bright + dark * (1.0 - bright);
    vec3 film = (reflected * 1.3 + vec3(1.0, 0.97, 0.9) * glint * uSun) * bright + uWater * dark * (1.0 - bright);
    vec3 c = linearToSrgb(1.0 - exp(-film / max(a, 1e-3) * 1.2));
    fragColor = vec4(c * a, a);
    return;
  }
  colour = 1.0 - exp(-colour * 1.2);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<SurfaceOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 10,
  speed: (o) => o.speed,
  update(o) {
    const a = (o.wind * Math.PI) / 180;
    const wind = [Math.cos(a), Math.sin(a)];
    const waves = [];
    for (let i = 0; i < 5; i++) {
      const spread = ((i * 0.618) % 1 - 0.5) * 1.2;
      const x = wind[0] - wind[1] * spread;
      const y = wind[1] + wind[0] * spread;
      const length = Math.hypot(x, y);
      const k = 1.3 * Math.pow(1.55, i);
      waves.push((x / length) * k, (y / length) * k, Math.sqrt(k) * 1.6, 0.5 / Math.pow(1.7, i));
    }
    return {
      uShowReflections: o.showReflections,
      uShowGlints: o.showGlints,
      uWaves: o.waves,
      uChop: o.chop,
      uWind: wind,
      uWave: waves,
      uRain: o.rain,
      uReflection: o.reflection,
      uSun: o.sun,
      uSource: o.source === 'image',
      uSky: linear(o.sky),
      uClouds: linear(o.clouds),
      uWater: linear(o.water),
      uTransparent: !o.showWater,
      uInteractive: o.interactive,
      uScale: o.scale,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 8 });
    const image = texture(ctx, 'uImage', 0);
    return {
      update: (o) => o.source === 'image' && image.set(o.image),
      frame: p.frame,
      restore: image.restore,
      destroy() {
        p.destroy();
        image.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SurfaceOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function surface(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
