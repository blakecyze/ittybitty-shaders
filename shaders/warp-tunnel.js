// @ts-check
/**
 * ittybitty/warp-tunnel
 *
 * Streaks of light rushing out of a vanishing point: gentle drift at low
 * speed, full hyperspace when pushed. Each streak takes its colour from your
 * palette, and the tunnel can twist as it goes.
 *
 * https://ittybitty.dev/shaders/warp-tunnel (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} WarpTunnelOptions
 * @property {boolean} showBackground The dark behind the streaks. Off, only the light is drawn, over the page.
 * @property {number} speed Travel speed.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} density Number of streak lanes around the tunnel.
 * @property {number} length Length of each streak.
 * @property {number} twist How much the tunnel spirals.
 * @property {number} x Vanishing point across the canvas.
 * @property {number} y Vanishing point down the canvas.
 * @property {import('./runtime.js').Gradient} palette Streak colours.
 * @property {string} background Colour of space.
 * @property {'streaks' | 'stars' | 'rings'} style Streaks of light, a starfield, or glowing tunnel rings.
 * @property {boolean} interactive Steer: the vanishing point follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {WarpTunnelOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.6,
  zoom: 1,
  density: 90,
  length: 0.5,
  twist: 0.15,
  x: 0.5,
  y: 0.5,
  palette: [
    [0, '#7cc6ff'],
    [0.5, '#f5f2ff'],
    [1, '#b48cff'],
  ],
  background: '#05050a',
  style: 'streaks',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uTime;
uniform float uDensity;
uniform float uLength;
uniform float uTwist;
uniform vec2 uCentre;      // 0..1, y down
uniform vec3 uBackground;  // linear RGB
uniform float uStyle;      // 0 streaks, 1 stars, 2 rings
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;

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

// Zoom about the middle of the canvas: a pixel, or a point in 0..1 canvas
// space (such as the pointer), as the zoomed view sees it.
vec2 zoomed(vec2 fc) {
  return (fc - 0.5 * uResolution) / uZoom + 0.5 * uResolution;
}

vec2 zoomedUv(vec2 uv) {
  return (uv - 0.5) / uZoom + 0.5;
}

void main() {
  // Steering: the vanishing point eases towards the pointer.
  vec2 centre = mix(vec2(uCentre.x, 1.0 - uCentre.y), zoomedUv(uPointer), 0.7 * uPointerActive * uInteractive) * uResolution;
  vec2 d = (zoomed(gl_FragCoord.xy) - centre) / uResolution.y;
  float r = length(d);
  float depth = 0.25 / max(r, 1e-3);          // tunnel depth: large near the centre
  float t = uTime;

  float angle = atan(d.y, d.x) / 6.28318 + 0.5 + depth * uTwist * 0.1 + t * uTwist * 0.05;
  vec3 light = vec3(0.0);
  // Two interleaved layers of lanes so streaks never line up.
  for (int layer = 0; layer < 2; layer++) {
    float lanes = uDensity * (layer == 0 ? 1.0 : 0.63);
    float a = angle * lanes + float(layer) * 0.5;
    float lane = floor(a);
    float seed = hash11(lane + float(layer) * 91.7);
    float across = abs(fract(a) - 0.5) * 2.0;
    float width = 1.0 - smoothstep(0.0, 0.35, across);
    float z = fract(depth * 0.35 - t * (0.4 + seed * 0.6) + seed * 9.0);
    float streak = smoothstep(0.0, 0.02, z) * (1.0 - smoothstep(0.0, uLength * 0.5, z));
    if (uStyle > 0.5 && uStyle < 1.5) {
      // Stars: short points instead of trails, twinkling.
      streak = smoothstep(0.0, 0.01, z) * (1.0 - smoothstep(0.0, 0.03 + uLength * 0.03, z));
      width = 1.0 - smoothstep(0.0, 0.18, across);
    }
    float on = step(0.55, hash11(lane * 1.7 + float(layer) * 13.0));
    light += max(oklabToLinear(stops(seed)), 0.0) * streak * width * on;
  }
  if (uStyle > 1.5) {
    // Rings: bands of light rushing outward along the tunnel.
    float ring = fract(depth * 0.9 - t * 0.6);
    float band = smoothstep(0.0, 0.04, ring) * (1.0 - smoothstep(0.04, 0.04 + uLength * 0.3, ring));
    light = max(oklabToLinear(stops(fract(depth * 0.05 + angle))), 0.0) * band * 0.9;
  }
  // Streaks brighten as they approach; the centre stays dark.
  light *= smoothstep(0.02, 0.35, r) * 1.8;
  vec3 add = 1.0 - exp(-light);
  if (uTransparent > 0.5) {
    vec3 c = linearToSrgb(add);
    fragColor = vec4(c, max(c.r, max(c.g, c.b)));
    return;
  }
  vec3 colour = linearToSrgb(uBackground + add);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const STYLES = { streaks: 0, stars: 1, rings: 2 };

/** @type {import('./runtime.js').EffectSpec<WarpTunnelOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const p = pointer(ctx, { ease: 2.5 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 1.5,
  time: 5,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uDensity: o.density,
      uLength: o.length,
      uTwist: o.twist,
      uCentre: [o.x, o.y],
      uBackground: linear(o.background),
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
      ...gradient(o.palette),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<WarpTunnelOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function warpTunnel(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
