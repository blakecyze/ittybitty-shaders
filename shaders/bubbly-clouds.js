// @ts-check
/**
 * ittybitty/bubbly-clouds
 *
 * Big, puffy cartoon clouds in a bright blue sky, the kind that open a
 * certain animated sitcom: a flat base, a scalloped row of round puffs along
 * the top, flat white with a crescent of soft blue shade under each puff. Watch them drift past side-on,
 * recede to the horizon, or fly straight through them.
 *
 * https://ittybitty.dev/shaders/bubbly-clouds (MIT)
 */
import { mount, linear } from './runtime.js';

/**
 * @typedef {object} BubblyCloudsOptions
 * @property {boolean} showShading The soft blue shade on the undersides. Off, clouds are flat white.
 * @property {boolean} showSky The sky behind. Off, only the clouds are drawn, over the page.
 * @property {boolean} showClouds The clouds themselves.
 * @property {number} speed How fast the clouds move.
 * @property {number} count How many clouds.
 * @property {number} size Size of the clouds.
 * @property {number} bubbles How many puffs make up each cloud.
 * @property {number} farShade How much darker distant clouds are: 0 fades them into the sky.
 * @property {number} softness From crisp cel shading to soft and painted.
 * @property {'side' | 'horizon' | 'flight'} view Drifting past side-on, receding to the horizon, or flying through them.
 * @property {string} top Colour of the sky overhead.
 * @property {string} horizon Colour of the sky at the horizon.
 * @property {string} cloud Colour of the sunlit side of the clouds.
 * @property {string} shade Colour of the clouds in shadow.
 * @property {number} outline Width of an inked outline, as in a storybook. 0 for none.
 * @property {string} line Colour of the outline.
 */

/** @type {BubblyCloudsOptions} */
export const defaults = {
  showShading: true,
  showSky: true,
  showClouds: true,
  speed: 0.4,
  count: 8,
  size: 1,
  bubbles: 0.6,
  farShade: 0,
  softness: 0.5,
  view: 'side',
  top: '#2f7fe4',
  horizon: '#a8d8ff',
  cloud: '#ffffff',
  shade: '#a9c4ec',
  outline: 0,
  line: '#3d5f9e',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowShading;
uniform float uFarShade;
uniform float uShowClouds;
uniform float uTime;
uniform float uCount;
uniform float uSize;
uniform float uBubbles;
uniform float uSoftness;
uniform float uView;      // 0 side, 1 horizon, 2 flight
uniform vec3 uTop;        // linear RGB
uniform vec3 uHorizon;
uniform vec3 uCloud;
uniform vec3 uShade;
uniform vec3 uLine;
uniform float uOutline;
uniform float uTransparent;

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

// Smooth union: puffs meet in a slight curve rather than a sharp notch.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// One cloud at q (in cloud units, centred on x = 0, flat base on y = 0),
// drawn the way a cartoonist draws one: a flat base under a scalloped row
// of round puffs, tallest in the middle, all one flat white shape. Shade
// sits along the underside, away from the sun: it is the part of the cloud
// that the same shape, nudged towards the sun, no longer covers, so every
// puff gets its own crescent where it bulges out. Returns colour and coverage.
vec4 cloud(vec2 q, float seed, float aa) {
  float nt = 3.0 + floor(uBubbles * 4.0 * (0.7 + 0.3 * hash11(seed * 5.1)) + 0.5);
  float w = 1.0 + 0.35 * hash11(seed * 2.9);            // half-width
  vec2 sun = vec2(-0.05, 0.2);
  // The body: a long, fully rounded capsule, so the cloud's base is soft.
  vec2 bd = abs(q - vec2(0.0, 0.17)) - vec2(w * 0.72, 0.0);
  float d = length(max(bd, 0.0)) + min(max(bd.x, bd.y), 0.0) - 0.16;
  vec2 bs = abs(q - sun - vec2(0.0, 0.17)) - vec2(w * 0.72, 0.0);
  float ds = length(max(bs, 0.0)) + min(max(bs.x, bs.y), 0.0) - 0.16;
  // Gentle, shallow puffs along the underside, blended in softly, so the
  // belly is rounded rather than cut straight.
  float nb = nt - 1.0;
  for (int j = 0; j < 6; j++) {
    float fj = float(j);
    if (fj >= nb) break;
    float s = ((fj + 0.5) / nb * 2.0 - 1.0) * 0.8;
    vec2 c = vec2(s * w, 0.14 + (hash11(seed * 3.3 + fj * 5.7) - 0.5) * 0.03);
    float r = 0.15 + 0.03 * hash11(seed * 9.1 + fj);
    d = smin(d, length(q - c) - r, 0.08);
    ds = smin(ds, length(q - sun - c) - r, 0.08);
  }
  float spacing = 2.0 / nt;
  for (int j = 0; j < 7; j++) {
    float fj = float(j);
    if (fj >= nt) break;
    float s = ((fj + 0.5) * spacing - 1.0) * 0.9;
    float h1 = hash11(seed * 13.7 + fj * 3.1);
    float h2 = hash11(seed * 7.3 + fj * 11.9);
    float bell = 1.0 - s * s;
    float r = mix(0.24, 0.5, bell) * (0.85 + 0.3 * h1);
    vec2 c = vec2(s * w + (h2 - 0.5) * 0.08, mix(0.2, 0.44, bell) + (h1 - 0.5) * 0.08);
    d = smin(d, length(q - c) - r, 0.03);
    ds = smin(ds, length(q - sun - c) - r, 0.03);
  }
  float line = uOutline * 0.035;
  float edge = mix(aa, 0.14, uSoftness * uSoftness);
  float lit = mix(1.0, smoothstep(edge, -edge, ds), uShowShading);
  // Softer clouds are painted: they grade gently darker towards the base.
  vec3 top = mix(uCloud, uShade, smoothstep(0.8, 0.0, q.y) * 0.3 * uSoftness * uShowShading);
  vec3 colour = mix(uShade, top, lit);
  colour = mix(uLine, colour, smoothstep(-aa, aa, -d - line) * step(aa, line) + step(line, aa));
  return vec4(colour, smoothstep(aa, -aa, d));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float t = uTime;

  vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 1.0, uv.y));
  vec3 colour = sky;
  float alpha = 0.0;

  // Draw far to near. Each cloud has a place in the world and a screen size;
  // the view decides how the world maps to the screen. In the perspective
  // views, draw slots hold fixed depth bands and clouds advance through
  // them, so drawing in slot order is always far to near.
  float n = uCount;
  float travel = uTime * (uView > 1.5 ? 0.22 : 0.05);
  float moved = floor(travel * n);
  float within = fract(travel * n);
  for (int i = 13; i >= 0; i--) {
    float fi = float(i);
    if (fi >= n || uShowClouds < 0.5) continue;
    float order;
    float seed;
    vec2 at;
    float scale;
    float haze;
    float life = 1.0;
    if (uView < 0.5) {
      // Side: layers drifting across, nearer ones larger and faster.
      order = 1.0 - fi / max(n - 1.0, 1.0);
      seed = fi + 1.0;
      scale = uSize * mix(0.08, 0.19, order) * (0.85 + 0.3 * hash11(seed * 5.3));
      float span = aspect + 4.0 * scale;
      float x = mod(hash11(seed * 1.3) * span + t * mix(0.015, 0.05, order), span) - span * 0.5;
      at = vec2(x, mix(-0.35, 0.3, hash11(seed * 9.1)));
      haze = 1.0 - order;
    } else {
      // Horizon and flight: this slot's depth, from far (1) to near (0).
      float z01 = (fi + 1.0 - within) / n;
      seed = fi + moved + 1.0;
      float z = mix(0.3, 6.0, z01);
      float x = (hash11(seed * 1.3) - 0.5) * (uView > 1.5 ? 8.0 : 6.0);
      // Horizon: clouds float on a ceiling above eye level, meeting the
      // horizon in the distance; flight: all around the camera.
      float y = uView > 1.5 ? (hash11(seed * 9.1) - 0.5) * 2.4 : 0.9 + hash11(seed * 9.1) * 0.7;
      at = vec2(x, y) / z * 0.8;
      if (uView < 1.5) at.y -= 0.38;
      scale = uSize * 0.4 / z;
      // Emerge out of the distant haze, gradually, over the farthest third
      // of the journey, and melt away just before reaching the camera.
      life = smoothstep(1.0, 0.62, z01);
      life *= life * (3.0 - 2.0 * life);
      life *= smoothstep(0.0, 0.1, z01);
      if (life <= 0.0) continue;
      haze = smoothstep(1.5, 6.0, z);
    }
    vec2 q = (p - at) / scale;
    // Clouds fit within about 3.6 wide and 1.1 tall: skip pixels outside.
    if (abs(q.x) > 1.9 || q.y < -0.1 || q.y > 1.15) continue;
    float aa = 1.4 / (uResolution.y * scale);
    vec4 c = cloud(q, seed, aa);
    if (c.w <= 0.0) continue;
    // Distance: far clouds soften into the sky.
    vec3 body = mix(c.rgb, sky, haze * 0.45 * (1.0 - uFarShade));
    // Far shade: distant clouds sink towards the shade colour, darker.
    body = mix(body, uShade * 0.62, haze * uFarShade * 0.85);
    // A cloud still emerging is part sky: it takes the sky's colour and is
    // only partly there, so it condenses out of the haze, never pops in.
    body = mix(sky, body, life);
    float cover = c.w * life;
    colour = mix(colour, body, cover);
    alpha = max(alpha, cover);
  }

  vec3 outc = pow(max(colour, 0.0), vec3(1.0 / 2.2));
  outc += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    fragColor = vec4(outc * alpha, alpha);
    return;
  }
  fragColor = vec4(outc, 1.0);
}
`;

const VIEWS = { side: 0, horizon: 1, flight: 2 };

/** @type {import('./runtime.js').EffectSpec<BubblyCloudsOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 20,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowShading: o.showShading,
      uFarShade: o.farShade,
      uShowClouds: o.showClouds,
      uCount: o.count,
      uSize: o.size,
      uBubbles: o.bubbles,
      uSoftness: o.softness,
      uView: VIEWS[o.view] ?? 0,
      uTop: linear(o.top),
      uHorizon: linear(o.horizon),
      uCloud: linear(o.cloud),
      uShade: linear(o.shade),
      uLine: linear(o.line),
      uOutline: o.outline,
      uTransparent: !o.showSky,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<BubblyCloudsOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function bubblyClouds(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
