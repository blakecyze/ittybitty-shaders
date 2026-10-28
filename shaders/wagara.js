// @ts-check
/**
 * ittybitty/wagara
 *
 * Traditional Japanese patterns, drawn crisply at any size: seigaiha (waves
 * of the blue sea), asanoha (hemp leaf), shippō (seven treasures) and
 * kikkō (tortoiseshell). A slow shimmer of light travels across them, as
 * over woven silk or gold leaf, and the pointer can lift it into a sheen.
 *
 * https://ittybitty.dev/shaders/wagara (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} WagaraOptions
 * @property {boolean} showBackground The ground colour behind the pattern. Off, only the lines are drawn, over the page.
 * @property {'seigaiha' | 'asanoha' | 'shippo' | 'kikko'} pattern Which traditional pattern.
 * @property {number} speed How fast the shimmer travels.
 * @property {number} scale Size of the pattern.
 * @property {number} weight Thickness of the lines.
 * @property {number} shimmer Strength of the travelling light.
 * @property {string} ground Colour of the ground.
 * @property {string} line Colour of the pattern.
 * @property {string} highlight Colour of the shimmer.
 * @property {boolean} interactive The pointer lifts the pattern into a sheen.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {WagaraOptions} */
export const defaults = {
  showBackground: true,
  pattern: 'seigaiha',
  speed: 0.4,
  scale: 1,
  weight: 0.5,
  shimmer: 0.6,
  ground: '#1b2a4a',
  line: '#e9dcc0',
  highlight: '#ffd88a',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uPattern;   // 0 seigaiha, 1 asanoha, 2 shippo, 3 kikko
uniform float uScale;
uniform float uWeight;
uniform float uShimmer;
uniform vec3 uGround;     // linear RGB
uniform vec3 uLine;
uniform vec3 uHighlight;
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

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// Seigaiha: overlapping fans of concentric arcs, row upon row, each row
// offset by half a fan. Lower rows sit in front of higher ones. Distance to
// the nearest arc line, in cell units.
float seigaiha(vec2 p) {
  // Rows are a quarter-cell apart; fans have radius 0.5, so each row's fans
  // cover the gaps left by the row in front of them.
  float base = floor(p.y * 4.0);
  for (int row = -2; row <= 0; row++) {
    float ry = base + float(row);
    float off = 0.5 * mod(ry, 2.0);
    float cx = floor(p.x - off + 0.5) + off;
    for (int col = -1; col <= 1; col++) {
      vec2 c = vec2(cx + float(col), ry * 0.25);
      vec2 d = p - c;
      float r = length(d);
      if (d.y < 0.0 || r > 0.5) continue;
      float ring = abs(fract(r * 8.0 + 0.5) - 0.5) / 8.0;
      return min(ring, 0.5 - r);
    }
  }
  return 1.0;
}

// Asanoha: an equilateral triangle grid, each triangle split by lines from
// its corners to its centre, which together form the hemp-leaf star.
float asanoha(vec2 p) {
  const float h = 0.8660254;                 // sqrt(3) / 2
  vec2 q = vec2(p.x - 0.5 * p.y / h, p.y / h);
  vec2 cell = floor(q);
  vec2 f = fract(q);
  vec2 a = f.x + f.y < 1.0 ? vec2(0.0) : vec2(1.0);
  vec2 corners[3] = vec2[3](cell + a, cell + vec2(1.0, 0.0), cell + vec2(0.0, 1.0));
  vec2 P[3];
  for (int i = 0; i < 3; i++) P[i] = vec2(corners[i].x + 0.5 * corners[i].y, corners[i].y * h);
  vec2 g = (P[0] + P[1] + P[2]) / 3.0;
  float d = min(min(segment(p, P[0], g), segment(p, P[1], g)), segment(p, P[2], g));
  d = min(d, min(min(segment(p, P[0], P[1]), segment(p, P[1], P[2])), segment(p, P[2], P[0])));
  return d;
}

// Shippō: overlapping circles on a square grid, each touching its
// neighbours' centres, forming petals.
float shippo(vec2 p) {
  vec2 f = fract(p) - 0.5;
  vec2 g = fract(p + 0.5) - 0.5;
  return min(abs(length(f) - 0.5), abs(length(g) - 0.5));
}

// Kikkō: a hexagonal tortoiseshell with a smaller hexagon inside each cell.
float kikko(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(g);
  float hexd = max(dot(q, normalize(s)), q.x);
  return min(abs(hexd - 0.5), abs(hexd - 0.3));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 css = gl_FragCoord.xy / uPixelRatio;
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  float t = uTime;
  // The pattern is sized in CSS pixels, so it keeps its scale on any screen.
  float cell = 64.0 * uScale;
  vec2 p = css / cell;

  float d;
  if (uPattern < 0.5) d = seigaiha(p);
  else if (uPattern < 1.5) d = asanoha(p * 1.2);
  else if (uPattern < 2.5) d = shippo(p * 1.3);
  else d = kikko(p * 1.4);

  // Line coverage, antialiased at the pixel.
  float w = mix(0.008, 0.04, uWeight);
  float aa = 1.0 / cell;
  float line = smoothstep(w + aa, w - aa, d);

  // The shimmer: a soft diagonal band of light drifting across, catching
  // the lines, and a glow around the pointer.
  float band = exp(-pow((fract((uv.x * aspect + uv.y) * 0.35 - t * 0.08) - 0.5) * 6.0, 2.0));
  vec2 hand = uPointer * vec2(aspect, 1.0);
  float near = exp(-dot(uv * vec2(aspect, 1.0) - hand, uv * vec2(aspect, 1.0) - hand) * 12.0) * uPointerActive * uInteractive;
  float lift = band * uShimmer + near * 0.8;
  vec3 ink = mix(uLine, uHighlight, clamp(lift, 0.0, 1.0));
  ink *= 0.9 + lift * 0.6;

  vec3 colour = mix(uGround * (1.0 + near * 0.15), ink, line);
  vec3 c = linearToSrgb(colour);
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    fragColor = vec4(linearToSrgb(ink) * line, line);
    return;
  }
  fragColor = vec4(c, 1.0);
}
`;

const PATTERNS = { seigaiha: 0, asanoha: 1, shippo: 2, kikko: 3 };

/** @type {import('./runtime.js').EffectSpec<WagaraOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 3,
  speed: (o) => o.speed,
  update(o) {
    return {
      uPattern: PATTERNS[o.pattern] ?? 0,
      uScale: o.scale,
      uWeight: o.weight,
      uShimmer: o.shimmer,
      uGround: linear(o.ground),
      uLine: linear(o.line),
      uHighlight: linear(o.highlight),
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
 * @param {Partial<WagaraOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function wagara(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
