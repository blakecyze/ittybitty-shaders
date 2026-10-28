// @ts-check
/**
 * ittybitty/papercut
 *
 * A layered cut-paper scene, the kind built in a shadow box: sheets of
 * coloured card cut into hills, peaks, waves or a forest, stacked one in
 * front of another with a little space between. Each sheet has the grain
 * of card, a cut edge that catches the light, and throws a soft shadow onto
 * the sheet behind it; colours run from the palest at the back to the
 * deepest at the front, as distance does. The pointer shifts the sheets by
 * their depth, so the box has real parallax, and the scene drifts slowly.
 *
 * https://ittybitty.dev/shaders/papercut (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} PapercutOptions
 * @property {boolean} showSky The sky card at the back. Off, the scene stands over your page.
 * @property {boolean} showSun A sun, or a moon, cut from card.
 * @property {boolean} showShadows The shadow each sheet casts on the one behind it.
 * @property {boolean} showGrain The grain of the card.
 * @property {'hills' | 'mountains' | 'waves' | 'forest'} scene What the sheets are cut into.
 * @property {number} layers How many sheets, 3 to 8.
 * @property {number} depth How far apart the sheets stand: deeper shadows and more parallax.
 * @property {number} speed How fast the scene drifts. 0 holds it still.
 * @property {number} seed Cuts a different scene.
 * @property {string} sky Colour of the sky card.
 * @property {string} far Colour of the sheet at the back.
 * @property {string} near Colour of the sheet at the front.
 * @property {boolean} interactive The sheets shift with the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {PapercutOptions} */
export const defaults = {
  showSky: true,
  showSun: true,
  showShadows: true,
  showGrain: true,
  scene: 'hills',
  layers: 6,
  depth: 0.6,
  speed: 0.3,
  seed: 3,
  sky: '#f6d7b0',
  far: '#e9a07a',
  near: '#3b2a4a',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uShowSky;
uniform float uShowSun;
uniform float uShowShadows;
uniform float uShowGrain;
uniform float uScene;       // 0 hills, 1 mountains, 2 waves, 3 forest
uniform float uLayers;
uniform float uDepth;
uniform float uSeed;
uniform vec3 uSky;          // linear RGB
uniform vec3 uFar;
uniform vec3 uNear;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

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

float noise1(float x, float salt) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i + salt), hash11(i + 1.0 + salt), f * f * (3.0 - 2.0 * f));
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// The top edge of sheet i (0 at the back) at x, in canvas heights. Each
// scene cuts its card differently; nearer sheets sit lower and are cut
// with bolder shapes.
float edge(float x, float i, float n, float t) {
  float k = i / max(n - 1.0, 1.0);
  float salt = uSeed * 17.0 + i * 31.7;
  float base = mix(0.62, 0.16, k);
  if (uScene < 0.5) {
    // Hills: long, soft rolls.
    float f = 1.6 + k * 1.5;
    return base + (noise1(x * f + salt, salt) - 0.5) * 0.2 + (noise1(x * f * 2.3 + salt, salt + 3.0) - 0.5) * 0.06;
  }
  if (uScene < 1.5) {
    // Mountains: ridges, sharp at the peaks, softer as they come nearer.
    float f = 2.4 + k * 1.2;
    float r = 1.0 - abs(noise1(x * f + salt, salt) * 2.0 - 1.0);
    float r2 = 1.0 - abs(noise1(x * f * 2.7 + salt, salt + 5.0) * 2.0 - 1.0);
    return base - 0.06 + r * mix(0.3, 0.12, k) + r2 * 0.05;
  }
  if (uScene < 2.5) {
    // Waves: swells rolling across, each sheet at its own pace, with a
    // curling crest.
    float f = 5.0 + k * 3.0;
    float ph = x * f + salt + t * (0.4 + k * 0.6);
    float w = sin(ph) * 0.5 + 0.5;
    float crest = pow(w, 3.0);
    return base - 0.04 + w * 0.05 + crest * 0.035 + (noise1(x * 3.0 + salt, salt) - 0.5) * 0.06;
  }
  // Forest: far sheets are wooded hills; nearer ones carry rows of pines,
  // taller the nearer they are.
  float ground = base - 0.04 + (noise1(x * 2.0 + salt, salt) - 0.5) * 0.06;
  if (k < 0.4) return ground + (noise1(x * 5.0 + salt, salt + 2.0) - 0.5) * 0.03;
  float w = mix(0.045, 0.09, k);
  float top = ground;
  // Two trees can overlap a cell edge, so look at this cell and its
  // neighbours.
  for (int c = -1; c <= 1; c++) {
    float cell = floor(x / w) + float(c);
    if (hash11(cell * 3.1 + salt) < 0.35) continue;
    float cx = (cell + 0.5 + (hash11(cell + salt) - 0.5) * 0.6) * w;
    float hgt = w * (1.8 + 1.6 * hash11(cell * 1.7 + salt)) * (0.6 + 0.6 * k);
    float dx = abs(x - cx);
    // A pine: three stacked triangles, each narrower and higher, and a
    // short trunk.
    // Tiers from the bottom up, each narrower and higher, so the tree
    // narrows to its tip, each tier's skirt flaring past the one above.
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float apex = ground + hgt * (0.5 + 0.25 * fj);
      float half_ = w * (0.48 - 0.12 * fj);
      float slope = hgt * 0.42 / half_;
      if (dx < half_) top = max(top, apex - dx * slope);
    }
    // A short trunk under the lowest tier.
    if (dx < w * 0.05) top = max(top, ground + hgt * 0.25);
  }
  return top;
}

void main() {
  vec2 res = uResolution;
  float aspect = res.x / res.y;
  vec2 uv = gl_FragCoord.xy / res;
  vec2 css = gl_FragCoord.xy / uPixelRatio;
  float t = uTime;
  float n = clamp(floor(uLayers + 0.5), 3.0, 8.0);
  vec2 look = (uPointer - 0.5) * uPointerActive * uInteractive;

  vec3 colour = vec3(0.0);
  float alpha = 0.0;
  float remaining = 1.0;
  float aa = 1.0 / res.y;
  float soft = 0.01 + 0.022 * uDepth;

  // Accumulate front to back, stopping where opaque card covers the rest.
  for (int ii = 7; ii >= 0; ii--) {
    float i = float(ii);
    if (i >= n) continue;
    float k = i / max(n - 1.0, 1.0);
    vec2 shift = look * vec2(0.05, 0.025) * uDepth * (0.2 + k);
    float x = (uv.x - shift.x) * aspect + t * 0.01 * (0.3 + k);
    float y = uv.y;
    // Nothing above the tallest possible cut or its blur can reach this pixel.
    float base = mix(0.62, 0.16, k);
    float top = base + 0.13;
    if (uScene >= 0.5 && uScene < 1.5) top = base - 0.01 + mix(0.3, 0.12, k);
    if (uScene >= 2.5) top = base - 0.01 + max(0.015, mix(0.045, 0.09, k) * 3.4 * (0.6 + 0.6 * k));
    float reach = uShowShadows > 0.5 ? max(aa, abs(soft) * 1.6 - 0.008 * uDepth) : aa;
    if (y > top + shift.y + reach) continue;
    float h = edge(x, i, n, t) + shift.y;
    float inside = 1.0 - smoothstep(h - aa, h + aa, y);
    if (inside > 0.0) {
      // The sheet's colour: pale and hazy at the back, deep at the front.
      vec3 c = mix(uFar, uNear, pow(k, 0.9));
      // Card grain, and the sheet shades slightly towards its foot.
      if (uShowGrain > 0.5) c *= 0.96 + 0.06 * noise(css * 0.8 + i * 13.0) + 0.02 * noise(css * 0.07 + i * 5.0);
      c *= 1.0 - 0.1 * smoothstep(h, h - 0.35, y);
      // The cut edge catches the light: a fine bright lip along the top.
      float lip = smoothstep(h - 3.0 * aa * uPixelRatio, h - aa, y);
      c = mix(c, c + (1.0 - c) * 0.35, lip);
      colour += remaining * inside * c;
      alpha = max(alpha, inside);
      remaining *= 1.0 - inside;
      if (remaining <= 0.0) break;
    }

    // Only the uncovered part receives the shadow this sheet casts behind it.
    if (uShowShadows > 0.5) {
      vec2 at = vec2(x - 0.012 * uDepth, y + 0.008 * uDepth - shift.y);
      float sh = 0.0;
      float turn = hash12(gl_FragCoord.xy + i) * 6.2831;
      for (int k2 = 0; k2 < 8; k2++) {
        float a2 = float(k2) * 2.39996 + turn;
        float rr = soft * sqrt((float(k2) + 0.5) / 8.0) * 1.6;
        vec2 o = vec2(cos(a2), sin(a2)) * rr;
        sh += step(at.y + o.y, edge(at.x + o.x, i, n, t));
      }
      sh = sh / 8.0 * (0.35 + 0.25 * uDepth);
      remaining *= 1.0 - sh;
      alpha = max(alpha, sh);
    }
  }
  if (remaining > 0.0) {
    // The sky card, lightest at the horizon, with its sun or moon.
    vec3 sky = mix(uSky * 1.04, uSky * 0.9, uv.y);
    float skyAlpha = uShowSky;
    if (uShowSun > 0.5) {
      vec2 sc = vec2(0.68 * aspect, 0.72) - look * 0.02;
      float d = length(uv * vec2(aspect, 1.0) - sc);
      float sun = 1.0 - smoothstep(0.1, 0.1 + 1.2 / res.y, d);
      vec3 sunC = mix(uSky, vec3(1.0, 0.97, 0.9), 0.75);
      // The disc stands a little proud of the sky: a ring of shadow below it.
      float ring = (1.0 - smoothstep(0.1, 0.13, length(uv * vec2(aspect, 1.0) - sc + vec2(-0.004, 0.008)))) * (1.0 - sun);
      sky *= 1.0 - ring * 0.12 * uShowShadows;
      sky = mix(sky, sunC, sun);
      skyAlpha = max(skyAlpha, max(sun, ring * 0.12 * uShowShadows));
    }
    colour += remaining * sky;
    alpha = max(alpha, skyAlpha);
  }
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

const SCENES = { hills: 0, mountains: 1, waves: 2, forest: 3 };

/** @type {import('./runtime.js').EffectSpec<PapercutOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 5,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowSky: o.showSky,
      uShowSun: o.showSun,
      uShowShadows: o.showShadows,
      uShowGrain: o.showGrain,
      uScene: SCENES[o.scene] ?? 0,
      uLayers: o.layers,
      uDepth: o.depth,
      uSeed: o.seed,
      uSky: linear(o.sky),
      uFar: linear(o.far),
      uNear: linear(o.near),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<PapercutOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function papercut(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
