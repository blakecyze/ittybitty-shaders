// @ts-check
/**
 * ittybitty/fire
 *
 * Flames rising from a campfire, a torch or a wall of fire. Turbulent heat
 * rises and tears into tongues, coloured by temperature like real flame:
 * white-yellow at the hot core, orange, then deep red where it cools, with
 * embers drifting up and out. Stylised mode bands it into flat cel shades,
 * as fire looks in games.
 *
 * https://ittybitty.dev/shaders/fire (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} FireOptions
 * @property {boolean} showBackground The dark behind the fire. Off, only the fire is drawn, glowing over the page.
 * @property {boolean} showFlames The flames themselves.
 * @property {boolean} showEmbers Sparks drifting up from the fire.
 * @property {boolean} showGlow The light the fire casts on its surroundings.
 * @property {number} speed How fast the flames rise.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} height How tall the flames reach.
 * @property {number} turbulence How much the flames tear and flicker.
 * @property {number} embers Sparks drifting up from the fire.
 * @property {number} heat Temperature: from a smouldering red to a white-hot blaze.
 * @property {'campfire' | 'torch' | 'wall'} shape A campfire, a slim torch flame, or a wall of fire along the bottom.
 * @property {boolean} stylised Flat, banded cel shading, as in games.
 * @property {string} tint Tint applied to the flame's colour.
 * @property {string} background Colour behind the fire.
 * @property {boolean} interactive The pointer is a breeze: flames lean away from it, and trail after a swipe.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {FireOptions} */
export const defaults = {
  showBackground: true,
  showFlames: true,
  showEmbers: true,
  showGlow: true,
  speed: 1,
  zoom: 1,
  height: 0.6,
  turbulence: 0.6,
  embers: 0.5,
  heat: 0.6,
  shape: 'campfire',
  stylised: false,
  tint: '#ffffff',
  background: '#0b0605',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uShowFlames;
uniform float uShowEmbers;
uniform float uShowGlow;
uniform float uTime;
uniform float uHeight;
uniform float uTurbulence;
uniform float uEmbers;
uniform float uHeat;
uniform float uShape;     // 0 campfire, 1 torch, 2 wall
uniform float uStylised;
uniform vec3 uTint;       // linear RGB
uniform vec3 uBackground;
uniform float uInteractive;
uniform float uTransparent;
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

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// Rising turbulence: each octave scrolls upward faster than the last, so
// small wisps race up through the slower, larger billows.
float fbm(vec2 p, float t) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p - vec2(0.0, t * (1.2 + float(i) * 0.6)));
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// Flame colour by temperature, 0 (cooling) to 1 (white-hot core): a
// blackbody-like ramp from deep red through orange and yellow to white.
vec3 blackbody(float k) {
  vec3 c = vec3(0.0);
  c += vec3(0.6, 0.05, 0.01) * smoothstep(0.0, 0.3, k);
  c += vec3(0.5, 0.24, 0.0) * smoothstep(0.2, 0.55, k);
  c += vec3(0.3, 0.5, 0.14) * smoothstep(0.45, 0.8, k);
  c += vec3(0.15, 0.25, 0.5) * smoothstep(0.8, 1.0, k);
  return c * mix(0.6, 2.4, k * k);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

uniform vec2 uPointerFlow;

// Zoom about the middle of the bottom edge, so the ground stays put: a
// pixel, or a point in 0..1 canvas space (such as the pointer), as the
// zoomed view sees it.
vec2 zoomed(vec2 fc) {
  vec2 anchor = vec2(0.5 * uResolution.x, 0.0);
  return (fc - anchor) / uZoom + anchor;
}

vec2 zoomedUv(vec2 uv) {
  return (uv - vec2(0.5, 0.0)) / uZoom + vec2(0.5, 0.0);
}

void main() {
  vec2 uv = zoomed(gl_FragCoord.xy) / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  float t = uTime;
  float base = 0.05;
  bool wall = uShape > 1.5;
  bool torch = uShape > 0.5 && !wall;
  float width = torch ? 0.075 : 0.22;
  float tall = mix(0.25, 1.0, uHeight) * (torch ? 0.75 : 1.0);
  float y = max(p.y - base, 0.0) / tall;                   // 0 base, 1 tip

  // Wind from the pointer, so the whole fire moves as one: a steady lean
  // away from the pointer when it is near, and a gust that follows the
  // pointer's movement, trailing the flames after a swipe.
  float blow = uInteractive * uPointerActive;
  vec2 hand = vec2((zoomedUv(uPointer).x - 0.5) * aspect, zoomedUv(uPointer).y);
  float dx = hand.x - (wall ? p.x : 0.0);
  float away = -dx / sqrt(dx * dx + 0.03) * exp(-dx * dx * 3.0) * smoothstep(tall * 1.6 + base, 0.0, hand.y);
  // A swipe: a gust from the pointer's movement, steady at any
  // responsiveness, that dies away after the pointer stops.
  float swipe = clamp(uPointerFlow.x * aspect * 0.35, -1.0, 1.0);
  float wind = clamp(away * 0.6 + swipe, -1.2, 1.2) * blow;

  float heat = 0.0;
  // Even the tallest tongue ends below this height.
  if (uShowFlames > 0.0 && (y < 1.8 || 0.4 + uTurbulence * 0.9 < 0.0)) {
    // Rising turbulence displaces the flame sideways, more towards the tips,
    // so tongues lick and twist rather than stand straight.
    vec2 q = vec2(p.x * 5.0, p.y * 3.2);
    float sway = (fbm(q * 0.7 + vec2(3.1, 0.0), t * 0.9) - 0.5) * 4.0;
    // Finer licks ride on top, racing upward, so every edge flickers.
    float lick = (fbm(q * 2.2 + vec2(8.3, 0.0), t * 2.4) - 0.5) * 4.0;
    float x = p.x - ((sway * 0.3 + lick * 0.12) * uTurbulence * y + wind * 0.45 * y * (0.4 + y)) * tall;

    // Density of fuel burning at this point: a teardrop per flame, broad at
    // the base and narrowing to a tip. Nothing outside the flames.
    float d = 0.0;
    if (wall) {
      // A row of tongues of uneven height, each rising and falling.
      float reach = 0.55 + 0.45 * noise(vec2(x * 6.0, t * 0.7)) + 0.25 * noise(vec2(x * 17.0, t * 1.3));
      d = smoothstep(1.3, 0.1, y / reach) * 1.1;
    } else {
      float count = torch ? 1.0 : 5.0;
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        if (fi >= count) break;
        float u = count > 1.0 ? fi / (count - 1.0) - 0.5 : 0.0;
        float h = hash12(vec2(fi, 3.7));
        // Taller in the middle; each flame on its own clock.
        float reach = torch ? 1.0 : mix(0.35, 1.15, pow(1.0 - abs(u) * 1.8, 1.5)) * (0.85 + 0.3 * h);
        float yi = y / reach;
        float cx = u * width * 1.5 + (h - 0.5) * 0.04 + sin(t * (1.5 + h) + fi * 2.0) * 0.012 * yi;
        float w = (torch ? width : width * 0.42) * mix(1.0, 0.18, clamp(yi, 0.0, 1.0)) * (0.9 + 0.3 * sin(min(yi, 1.0) * 3.14159));
        float across = (x - cx) / w;
        d += exp(-across * across * 2.2) * smoothstep(1.3, 0.1, yi) * (torch ? 1.2 : 0.95);
      }
    }
    // Round off the base, as flames spring from the fuel, not a straight line.
    d *= smoothstep(-0.04, 0.03, p.y - base + 0.03 * noise(vec2(p.x * 8.0, 1.0)));

    // Turbulence only subtracts density, so empty air needs no more noise.
    if (d * 1.3 > 0.02 || 0.4 + uTurbulence * 0.9 < 0.0) {
      // Turbulence eats into the flame, more strongly higher up, tearing the
      // tips into tongues that pinch off as wisps.
      // Two scales: broad billows, and fine licks that tear the tips.
      float n = fbm(q + vec2(sway * 0.4, 0.0), t * 1.4) * 0.5 + fbm(q * 2.3 + 5.0, t * 2.6) * 0.5;
      // Only ever subtracts, so empty air never catches.
      d = d * 1.3 - smoothstep(0.25, 0.75, n) * (0.15 + y * y * 1.8) * (0.4 + uTurbulence * 0.9);
      // Temperature: the density, hottest in the core low down.
      heat = smoothstep(0.02, 1.3, d) * mix(0.55, 1.0, smoothstep(0.7, 0.0, y));
      // Brighter and dimmer streaks rising through the body.
      heat *= 0.8 + 0.4 * smoothstep(0.3, 0.7, n);
    }
  }

  // Outside the branches above, so the derivative below is well defined.
  float k = clamp(heat * mix(0.5, 1.0, uHeat), 0.0, 1.0);
  float soft = smoothstep(0.0, 0.04, k);
  if (uStylised > 0.5) {
    // Cel shading, as in games: three flat bands with clean edges. The
    // edges stay crisp at any scale because the bands are cut on the
    // smooth field, antialiased over a pixel.
    float aa = fwidth(k) * 1.2 + 1e-4;
    float band = smoothstep(0.1 - aa, 0.1 + aa, k) * 0.38 + smoothstep(0.35 - aa, 0.35 + aa, k) * 0.28 + smoothstep(0.62 - aa, 0.62 + aa, k) * 0.28;
    k = band;
    soft = smoothstep(0.1 - aa, 0.1 + aa, heat * mix(0.5, 1.0, uHeat));
  }
  vec3 flame = blackbody(k) * uTint * soft * uShowFlames;

  // Embers: small bright sparks drifting up and swaying, fading as they cool.
  vec3 sparks = vec3(0.0);
  if (uEmbers > 0.0 && uShowEmbers > 0.5) {
    for (int i = 0; i < 2; i++) {
      float s = 18.0 + float(i) * 13.0;
      vec2 e = vec2((p.x - wind * 0.3 * p.y) * s, (p.y - t * (0.25 + float(i) * 0.1)) * s);
      e.x += sin(e.y * 0.35 + float(i) * 3.0) * 1.2;
      vec2 cell = floor(e);
      vec2 h = hash22(cell + float(i) * 31.0);
      if (h.x < uEmbers * 0.12) {
        vec2 ed = fract(e) - h;
        float life = smoothstep(1.1, 0.1, (p.y - base) / tall) * (wall ? 1.0 : smoothstep(width * 2.0 + 0.1, 0.0, abs(p.x)));
        sparks += vec3(1.0, 0.45, 0.1) * exp(-dot(ed, ed) * 90.0) * life * 3.0;
      }
    }
  }

  // Glow: light the fire casts on its surroundings, flickering with it.
  float flicker = 0.85 + 0.15 * noise(vec2(t * 3.0, 0.5));
  float glow = wall ? exp(-max(p.y - base, 0.0) * 3.0) : exp(-length(vec2(p.x, (p.y - base - tall * 0.2) * 1.3)) * (torch ? 5.0 : 3.5));
  vec3 spill = vec3(0.9, 0.3, 0.08) * glow * 0.14 * flicker * mix(0.6, 1.2, uHeat) * uTint * uShowGlow;

  vec3 light = flame + sparks;
  vec3 colour = uBackground + spill + light;
  colour = 1.0 - exp(-colour * 1.3);
  vec3 c = linearToSrgb(colour);
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    vec3 lc = linearToSrgb(1.0 - exp(-(light + spill) * 1.3));
    fragColor = vec4(lc, max(lc.r, max(lc.g, lc.b)));
    return;
  }
  fragColor = vec4(c, 1.0);
}
`;

const SHAPES = { campfire: 0, torch: 1, wall: 2 };

/** @type {import('./runtime.js').EffectSpec<FireOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 6,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uShowFlames: o.showFlames,
      uShowEmbers: o.showEmbers,
      uShowGlow: o.showGlow,
      uHeight: o.height,
      uTurbulence: o.turbulence,
      uEmbers: o.embers,
      uHeat: o.heat,
      uShape: SHAPES[o.shape] ?? 0,
      uStylised: o.stylised,
      uTint: linear(o.tint),
      uBackground: linear(o.background),
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 5 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<FireOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function fire(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
