// @ts-check
/**
 * ittybitty/water
 *
 * Clear water seen from above: a moving surface bends the view of the floor
 * beneath it, focuses sunlight into shimmering caustics, absorbs light with
 * depth, and catches glints where the waves face the sun.
 *
 * Everything is one pass: no textures, no simulation, no history.
 *
 * https://ittybitty.dev/shaders/water (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} WaterOptions
 * @property {boolean} showFloor The pool floor and the water over it. Off, only the light is drawn, over the page.
 * @property {boolean} showCaustics Sunlight focused into shimmering lines on the floor.
 * @property {boolean} showSheen The sky caught on the surface of the waves.
 * @property {boolean} showGlints The sun glinting off the crests.
 * @property {number} speed How fast the surface moves.
 * @property {number} scale Size of the waves and caustic cells.
 * @property {number} refraction How strongly the surface bends the floor.
 * @property {number} caustics Brightness of the focused light on the floor.
 * @property {number} depth How much light the water absorbs.
 * @property {number} glints Sun sparkle on the wave crests.
 * @property {'tiles' | 'sand' | 'stone'} floor What lies beneath the water.
 * @property {string} water Colour of the water.
 * @property {boolean} interactive The pointer sends ripples across the surface.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {WaterOptions} */
export const defaults = {
  showFloor: true,
  showCaustics: true,
  showSheen: true,
  showGlints: true,
  speed: 0.5,
  scale: 1,
  refraction: 0.6,
  caustics: 0.8,
  depth: 0.45,
  glints: 0.5,
  floor: 'tiles',
  water: '#2fb6c7',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowFloor;
uniform float uShowCaustics;
uniform float uShowSheen;
uniform float uShowGlints;
uniform float uPixelRatio;
uniform float uTime;
uniform float uScale;
uniform float uRefraction;
uniform float uCaustics;
uniform float uDepth;
uniform float uGlints;
uniform float uFloor;     // 0 tiles, 1 sand, 2 stone
uniform vec3 uWater;      // linear RGB
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

vec2 rippleAt;
float rippling;

out vec4 fragColor;

// Hashes without sine, stable across GPUs (after Dave Hoskins, MIT).
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

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// Surface height: directional swells with analytic slope, plus a noise chop.
// Returns (height, d/dx, d/dy).
vec3 surface(vec2 p, float t) {
  vec3 h = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float f = float(i);
    float angle = f * 2.39996;               // golden angle: no two swells align
    vec2 dir = vec2(cos(angle), sin(angle));
    float k = 1.6 + f * 0.9;                 // wavenumber
    float amp = 0.12 / (1.0 + f * 0.8);
    float phase = dot(dir, p) * k + t * sqrt(k) * 1.4 + f * 1.7;
    h += amp * vec3(sin(phase), dir * k * cos(phase));
  }
  float n = noise(p * 3.1 + t * 0.4);
  h.x += 0.05 * n;
  // Ripples spreading from the pointer.
  vec2 d = p - rippleAt;
  float r = length(d) + 1e-4;
  float fade = exp(-r * 2.5) * rippling;
  float phase = r * 26.0 - t * 7.0;
  h.x += 0.03 * fade * sin(phase);
  h.yz += 0.03 * fade * 26.0 * cos(phase) * d / r;
  return h;
}

// A sharp filament with a soft halo, like focused light on a pool floor.
float filament(float e) {
  return exp(-e * 34.0) * 1.3 + 0.1 * exp(-e * 6.0);
}

// Caustic network: bright where cell edges of a warped, drifting Voronoi
// field meet, which reads like light focused by a moving surface.
float causticLayer(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = hash22(i + g);
      o = 0.5 + 0.42 * sin(t + 6.2831 * o);
      vec2 v = g + o - f;
      float d = dot(v, v);
      d2 = min(d2, max(d1, d));
      d1 = min(d1, d);
    }
  }
  // Squared distances in the loop; roots only once, at the end.
  return filament(sqrt(d2) - sqrt(d1));
}

// The same network for red, green and blue, each sampled a hair apart for
// the fringe of refracted sunlight. One pass over the cells serves all three.
vec3 causticRGB(vec2 p, float t, float shift) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec3 d1 = vec3(8.0);
  vec3 d2 = vec3(8.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = g + 0.5 + 0.42 * sin(t + 6.2831 * hash22(i + g)) - f;
      vec2 a = o - vec2(shift, 0.0);
      vec2 c = o + vec2(shift, 0.0);
      vec3 d = vec3(dot(a, a), dot(o, o), dot(c, c));
      d2 = min(d2, max(d1, d));
      d1 = min(d1, d);
    }
  }
  vec3 e = sqrt(d2) - sqrt(d1);
  return vec3(filament(e.x), filament(e.y), filament(e.z));
}

vec3 floorColour(vec2 p) {
  if (uFloor < 0.5) {
    // Pool tiles with soft grout, and a faint per-tile tone variation.
    vec2 tile = p * 7.0;
    vec2 g = abs(fract(tile) - 0.5);
    float grout = smoothstep(0.462, 0.495, max(g.x, g.y));
    float tone = 0.94 + 0.06 * hash12(floor(tile));
    return mix(vec3(0.9, 0.95, 0.95) * tone, vec3(0.7, 0.78, 0.8), grout * 0.8);
  }
  if (uFloor < 1.5) {
    // Sand: soft ripples and speckle.
    float r = sin(p.x * 9.0 + noise(p * 2.0) * 4.0) * 0.5 + 0.5;
    float speck = hash12(floor(p * 220.0));
    return vec3(0.84, 0.76, 0.6) * (0.9 + 0.08 * r + 0.05 * speck);
  }
  // Stone: large pebbles of varied tone.
  vec2 cell = floor(p * 3.0);
  vec2 f = fract(p * 3.0);
  float d = 8.0;
  float tone = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = hash22(cell + g);
      float dd = length(g + o - f);
      if (dd < d) {
        d = dd;
        tone = hash12(cell + g + 9.0);
      }
    }
  }
  return mix(vec3(0.5, 0.52, 0.5), vec3(0.78, 0.76, 0.7), tone) * (1.0 - 0.4 * smoothstep(0.35, 0.7, d));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Sized in CSS pixels (400 per unit), not relative to the canvas: a bigger
  // canvas shows more pool, not a magnified one.
  vec2 p = gl_FragCoord.xy / uPixelRatio / 400.0 / uScale;
  float t = uTime;
  rippleAt = uPointer * uResolution / uPixelRatio / 400.0 / uScale * 2.4;
  rippling = uPointerActive * uInteractive;

  vec3 s = surface(p * 2.4, t);
  vec2 slope = s.yz;

  // Refraction: the floor is seen through the tilted surface.
  vec2 floorP = p + slope * uRefraction * 0.12;
  vec3 ground = floorColour(floorP);

  // Caustics on a curved, drifting domain so cells never look polygonal,
  // with a slight per-channel offset for the fringe of refracted sunlight.
  vec2 cp = floorP * 5.0 + slope * 0.6;
  // Two sine warps at different sizes: cheaper than warping by noise.
  cp += 0.55 * sin(cp.yx * vec2(0.45, 0.52) + vec2(t * 0.15, -t * 0.12));
  cp += 0.25 * sin(cp.yx * vec2(1.3, 1.1) + vec2(-t * 0.2, t * 0.17) + 1.7);
  float ct = t * 0.8;
  vec3 fine = causticRGB(cp, ct, 0.02);
  // A second, larger network drifts across the first. Where the two meet the
  // light concentrates, as real caustics brighten where filaments cross.
  float broad = causticLayer(cp * 0.43 + 3.1, ct * 0.6);
  // Filaments brighten and fade along their length, never uniformly lit.
  float along = 0.45 + 0.9 * noise(cp * 0.9 - t * 0.35);
  vec3 caustic = fine * along * (0.4 + 0.9 * broad) + 0.18 * broad * broad;

  caustic *= uShowCaustics;
  // The surface: a touch of sky reflection on steep faces, and sun glints.
  vec3 n = normalize(vec3(-slope * 0.35, 1.0));
  float fresnel = pow(1.0 - n.z, 2.0);
  vec3 sheen = (vec3(0.75, 0.88, 1.0) * fresnel * 2.0 + vec3(0.8, 0.9, 1.0) * 0.06 * smoothstep(-0.05, 0.25, s.x)) * uShowSheen;
  vec3 sun = normalize(vec3(0.35, 0.45, 1.0));
  float spec = pow(max(dot(n, normalize(sun + vec3(0.0, 0.0, 1.0))), 0.0), 600.0);
  vec3 glints = vec3(1.0, 0.97, 0.9) * spec * uGlints * 6.0 * uShowGlints;

  if (uShowFloor < 0.5) {
    // Only the light: caustics, sheen and glints, over the page.
    vec3 c = linearToSrgb(1.0 - exp(-(caustic * uCaustics * vec3(1.0, 0.97, 0.9) * 1.6 + sheen * 0.4 + glints)));
    fragColor = vec4(c, max(c.r, max(c.g, c.b)));
    return;
  }
  vec3 light = ground * (0.42 + caustic * uCaustics * 1.5);

  // Absorption: deeper water takes on more of its own colour. Depth also
  // varies gently across the view, as a real pool floor slopes.
  vec2 uv = gl_FragCoord.xy / uResolution;
  // Shallow near the top of the view, deeper towards the bottom, with a slow
  // unevenness, as a real pool floor slopes to its deep end.
  float depth = uDepth * (0.6 + 0.8 * smoothstep(0.1, 1.0, 1.0 - uv.y) + 0.12 * sin(p.x * 1.7 + 2.0) * sin(p.y * 1.3));
  vec3 transmit = pow(max(uWater, 0.001), vec3(depth * 1.5));
  vec3 colour = light * transmit * mix(1.1, 1.8, uDepth);
  // Light scattered in the water itself: a faint haze of its own colour.
  colour += uWater * uWater * 0.08 * depth;

  // Surface: the sky caught on steep faces as the swell rolls, and glints.
  colour += sheen + glints;

  colour = 1.0 - exp(-colour * 1.25); // soft shoulder
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const FLOORS = { tiles: 0, sand: 1, stone: 2 };

/** @type {import('./runtime.js').EffectSpec<WaterOptions>} */
const base = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const p = pointer(ctx, { ease: 12 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 1.5,
  time: 6,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowFloor: o.showFloor,
      uShowCaustics: o.showCaustics,
      uShowSheen: o.showSheen,
      uShowGlints: o.showGlints,
      uScale: o.scale,
      uRefraction: o.refraction,
      uCaustics: o.caustics,
      uDepth: o.depth,
      uGlints: o.glints,
      uFloor: FLOORS[o.floor] ?? 0,
      uWater: linear(o.water),
      uInteractive: o.interactive,
    };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<WaterOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function water(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
