// @ts-check
/**
 * ittybitty/ink
 *
 * Ink that pours from the pointer and curls away like smoke in water. The
 * last 24 pointer positions are kept as a trail; each blooms, drifts and
 * fades on its own. Without a pointer, an invisible hand draws slow loops.
 *
 * One pass, no fluid solver: it looks like fluid, costs like a gradient.
 *
 * https://ittybitty.dev/shaders/ink (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} InkOptions
 * @property {boolean} showBackground The paper behind the ink. Off, only the ink is drawn, over the page.
 * @property {number} speed Speed of the idle hand when there is no pointer.
 * @property {number} size Size of each drop of ink.
 * @property {number} spread How far the ink blooms as it ages.
 * @property {number} fade How quickly the ink disappears.
 * @property {number} curl How much the ink curls as it spreads.
 * @property {import('./runtime.js').Gradient} palette Colour from fresh (left) to old (right).
 * @property {string} background Colour of the water.
 * @property {boolean} idle Draw slow loops when there is no pointer.
 * @property {'ink' | 'smoke' | 'paint'} style Soft ink, glowing smoke, or flat paint with crisp edges.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {InkOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.6,
  size: 0.07,
  spread: 1.2,
  fade: 0.8,
  curl: 0.7,
  palette: [
    [0, '#ffe3a3'],
    [0.35, '#ff5c8a'],
    [0.7, '#6a3bff'],
    [1, '#1b1840'],
  ],
  background: '#0b0b12',
  idle: true,
  style: 'ink',
  responsiveness: 0.5,
};

const TRAIL = 24;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
// Live drops only, two vec4s each, prepared once per frame in JavaScript:
// (x, y, flow, 0) and (weight, falloff, age, 0).
uniform vec4 uDrops[${TRAIL * 2}];
uniform float uDropCount;
uniform vec3 uBackground;         // linear RGB
uniform float uStyle;             // 0 ink, 1 smoke, 2 paint
uniform float uTransparent;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;

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

void main() {
  vec2 p = gl_FragCoord.xy / uResolution.y;
  float t = uTime;

  // Curl: a smooth flow field bends the sample point, more for older ink.
  vec2 flow = vec2(noise(p * 3.0 + t * 0.2), noise(p * 3.0 + 7.3 - t * 0.2)) - 0.5;

  float density = 0.0;
  float age = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    if (float(i) >= uDropCount) break;
    vec4 a = uDrops[i * 2];
    vec4 b = uDrops[i * 2 + 1];
    vec2 q = p + flow * a.z - a.xy;
    float w = b.x * exp2(-dot(q, q) * b.y);
    density += w;
    age += w * b.z;
  }
  age /= max(density, 1e-4);

  vec3 ink = max(oklabToLinear(stops(clamp(age * 0.45, 0.0, 1.0))), 0.0);
  float cover = 1.0 - exp(-density * 1.6);
  if (uStyle > 1.5) cover = smoothstep(0.42, 0.5, cover);          // paint: flat, crisp
  vec3 colour = uStyle > 0.5 && uStyle < 1.5
    ? uBackground + ink * cover * 1.4                               // smoke: light added
    : mix(uBackground, ink, cover);
  if (uTransparent > 0.5) {
    vec3 c = linearToSrgb(ink);
    fragColor = vec4(c * cover, cover);
    return;
  }
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const STYLES = { ink: 0, smoke: 1, paint: 2 };

/** @type {import('./runtime.js').EffectSpec<InkOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1,
  time: 3,
  // Without the idle hand, nothing moves until the pointer does.
  speed: (o) => (o.idle ? o.speed : 0),
  update(o) {
    return {
      uStyle: STYLES[o.style] ?? 0,
      uTransparent: !o.showBackground,
      uBackground: linear(o.background),
      ...gradient(o.palette),
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 20 });
    // Ring buffer of drops, allocated once.
    const trail = new Float32Array(TRAIL * 4);
    const drops = new Float32Array(TRAIL * 8);
    let size = defaults.size;
    let spread = defaults.spread;
    let fade = defaults.fade;
    let curl = defaults.curl;
    let head = 0;
    let lastX = -1;
    let lastY = -1;
    let clock = 0;
    let speed = defaults.speed;
    let idle = defaults.idle;
    // Everything about a drop that does not depend on the pixel, computed
    // here once per frame rather than per pixel. Returns the live count.
    const pack = () => {
      let n = 0;
      for (let i = 0; i < TRAIL; i++) {
        const age = trail[i * 4 + 2];
        const strength = trail[i * 4 + 3];
        if (strength <= 0) continue;
        const grow = 1 + age * spread;
        const r = size * grow;
        const o = n * 8;
        drops[o] = trail[i * 4];
        drops[o + 1] = trail[i * 4 + 1];
        drops[o + 2] = curl * 0.15 * Math.min(age, 3);
        drops[o + 4] = (strength * Math.exp(-age * fade)) / grow;
        drops[o + 5] = Math.LOG2E / (r * r);
        drops[o + 6] = age;
        n++;
      }
      ctx.uniform('uDrops', drops);
      ctx.uniform('uDropCount', n);
      return n;
    };
    const drop = (/** @type {number} */ x, /** @type {number} */ y) => {
      const i = head * 4;
      trail[i] = x;
      trail[i + 1] = y;
      trail[i + 2] = 0;
      trail[i + 3] = 1;
      head = (head + 1) % TRAIL;
      lastX = x;
      lastY = y;
    };
    return {
      update(o) {
        speed = o.speed;
        idle = o.idle;
        size = o.size;
        spread = o.spread;
        fade = o.fade;
        curl = o.curl;
        pack();
      },
      frame(dt) {
        p.frame(dt);
        const aspect = ctx.canvas.width / Math.max(ctx.canvas.height, 1);
        let x;
        let y;
        if (p.over) {
          x = p.target[0] * aspect;
          y = p.target[1];
        } else if (!idle) {
          x = lastX;
          y = lastY;
        } else {
          // The idle hand: slow, overlapping loops.
          clock += dt * speed;
          x = aspect * (0.5 + 0.32 * Math.sin(clock * 0.9) * Math.cos(clock * 0.31));
          y = 0.5 + 0.28 * Math.sin(clock * 1.3 + 1);
        }
        if (Math.hypot(x - lastX, y - lastY) > 0.02) drop(x, y);
        for (let i = 0; i < TRAIL; i++) {
          trail[i * 4 + 2] += dt;
          if (!(trail[i * 4 + 2] < 8)) trail[i * 4 + 3] = 0;
        }
        if (pack()) ctx.invalidate();
      },
      destroy: p.destroy,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<InkOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function ink(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
