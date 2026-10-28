// @ts-check
/**
 * ittybitty/sakura
 *
 * Cherry blossom petals drifting through the air in depth. Each petal is a
 * notched, five-lobed-looking sakura petal that tumbles as it falls: it
 * narrows as it turns edge-on, catches the light as it faces you, and blurs
 * the further it is from the focal plane. A soft breeze carries them
 * sideways; the pointer sends gusts through them.
 *
 * https://ittybitty.dev/shaders/sakura (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} SakuraOptions
 * @property {boolean} showSky The sky behind. Off, only the petals are drawn, over the page.
 * @property {boolean} showFar The small, faint petals in the distance.
 * @property {boolean} showNear The large petals drifting close by.
 * @property {number} speed How fast the petals fall.
 * @property {number} amount How many petals.
 * @property {number} size Size of the petals.
 * @property {number} wind Strength of the breeze.
 * @property {number} depth How strongly petals away from the focal plane blur.
 * @property {string} petal Colour of the petals.
 * @property {string} blush Colour at the base of each petal.
 * @property {string} top Colour of the sky at the top.
 * @property {string} bottom Colour of the sky at the bottom.
 * @property {boolean} interactive The pointer sends gusts through the petals.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {SakuraOptions} */
export const defaults = {
  showSky: true,
  showFar: true,
  showNear: true,
  speed: 0.5,
  amount: 0.6,
  size: 1,
  wind: 0.5,
  depth: 0.6,
  petal: '#ffd9e4',
  blush: '#f39ab4',
  top: '#bcd8f0',
  bottom: '#fbe7ee',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowFar;
uniform float uShowNear;
uniform float uPixelRatio;
uniform float uTime;
uniform float uAmount;
uniform float uSize;
uniform float uWind;
uniform float uDepth;
uniform vec3 uPetal;      // linear RGB
uniform vec3 uBlush;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

vec4 hash42(vec2 p) {
  vec4 q = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// A sakura petal in its own space (y along the petal, base at y = -1):
// a rounded teardrop with the notch at its tip. Signed distance, roughly
// in petal widths.
float petalShape(vec2 p) {
  p.x = abs(p.x);
  // Teardrop: wide near the tip, narrowing to the base.
  float w = 0.62 * sqrt(max(0.0, 1.0 - p.y * p.y)) * (0.75 + 0.25 * p.y);
  float d = p.x - w;
  d = max(d, abs(p.y) - 1.0);
  // The notch: a small cut at the tip.
  float notch = 0.18 - length(vec2(p.x, p.y - 1.02) * vec2(1.0, 1.4));
  return max(d, notch);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime;
  float px = 1.0 / uResolution.y;

  vec3 colour = mix(uBottom, uTop, smoothstep(0.0, 1.0, uv.y));
  float alpha = 0.0;

  // The pointer: gusts push petals away from it, fading with distance.
  vec2 hand = vec2(uPointer.x * aspect, uPointer.y);
  float gusting = uPointerActive * uInteractive;

  // Four layers of depth, far to near. In each, a grid of cells, at most one
  // petal per cell, falling and swaying with its own phase.
  for (int layer = 0; layer < 4; layer++) {
    float z = float(layer) / 3.0;                         // 0 far, 1 near
    if ((layer < 2 ? uShowFar : uShowNear) < 0.5) continue;
    float scale = mix(0.022, 0.07, z * z) * uSize;        // petal size
    float cell = scale * 5.0;
    float fall = mix(0.05, 0.14, z) * (0.5 + uAmount * 0.3);
    // Wind carries the whole layer; nearer layers move faster.
    vec2 drift = vec2(t * (0.02 + 0.08 * uWind) * mix(0.6, 1.4, z), -t * fall);
    vec2 q = p - drift;
    // Gust: displace sample space around the pointer, more for near petals.
    vec2 away = p - hand;
    q -= normalize(away + 1e-4) * 0.08 * exp(-dot(away, away) * 6.0) * gusting * mix(0.4, 1.0, z);

    vec2 id = floor(q / cell);
    vec2 f = fract(q / cell) - 0.5;
    // Blur: petals far from the middle layer are out of focus.
    float blur = uDepth * abs(z - 0.55) * 1.4;
    for (int j = 0; j < 4; j++) {
      // The cell and its neighbours, so petals near an edge are not cut.
      vec2 o = vec2(float(j & 1), float(j >> 1)) - step(0.0, -f) * 1.0;
      vec2 cid = id + o;
      vec4 h = hash42(cid + float(layer) * 17.3);
      // Fewer petals far away, so the distance reads as air, not confetti.
      if (h.w > uAmount * mix(0.45, 0.9, z)) continue;
      // Sway and spin, each petal on its own clock.
      float ph = h.x * 6.2831;
      vec2 centre = o + (h.yz - 0.5) * 0.6 + vec2(0.35 * sin(t * (0.7 + h.x) + ph), 0.0);
      vec2 d = (f - centre) * cell / scale;
      float spin = t * (0.6 + h.y * 1.2) * (h.z > 0.5 ? 1.0 : -1.0) + ph;
      // Tumbling: the petal turns about its long axis, so its width swings.
      float turn = cos(t * (0.9 + h.w * 1.3) + ph * 1.7);
      float c = cos(spin), s = sin(spin);
      vec2 r = mat2(c, s, -s, c) * d;
      // A petal turned edge-on still shows its curve: never thinner than a third.
      float w = 0.34 + 0.66 * abs(turn);
      r.x /= w;
      float sd = petalShape(r) * w;
      float soft = (1.5 * px / scale) * cell + blur * 0.35;
      float cover = smoothstep(soft, -soft, sd);
      if (cover <= 0.0) continue;
      // Shade: blush at the base, light where the petal faces you.
      float base = smoothstep(0.2, -0.9, r.y);
      vec3 col = mix(uPetal, uBlush, base * 0.75);
      col *= 0.8 + 0.28 * w;
      // Fine veins fanning from the base, and light glowing through the thin
      // tip of the petal.
      float vein = smoothstep(0.08, 0.0, abs(fract(atan(r.x, r.y + 1.1) * 5.0) - 0.5)) * smoothstep(-1.0, 0.2, r.y);
      col = mix(col, uBlush, vein * 0.12);
      col += (uPetal * 0.25 + 0.05) * smoothstep(0.1, 0.9, r.y) * (1.0 - base);
      // Nearer petals are a touch more saturated; far ones take the air's colour.
      col = mix(mix(uBottom, uTop, uv.y), col, mix(0.55, 1.0, z));
      float a = cover * mix(0.7, 1.0, z) * (1.0 - blur * 0.35);
      colour = mix(colour, col, a);
      alpha = max(alpha, a);
    }
  }

  vec3 c = pow(max(colour, 0.0), vec3(1.0 / 2.2));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    fragColor = vec4(c * alpha, alpha);
    return;
  }
  fragColor = vec4(c, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<SakuraOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 12,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowFar: o.showFar,
      uShowNear: o.showNear,
      uAmount: o.amount,
      uSize: o.size,
      uWind: o.wind,
      uDepth: o.depth,
      uPetal: linear(o.petal),
      uBlush: linear(o.blush),
      uTop: linear(o.top),
      uBottom: linear(o.bottom),
      uInteractive: o.interactive,
      uTransparent: !o.showSky,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SakuraOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function sakura(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
