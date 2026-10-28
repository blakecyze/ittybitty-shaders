// @ts-check
/**
 * ittybitty/sumi-e
 *
 * Mountains painted in ink wash: ridge behind ridge, each a single tone of
 * diluted ink, darkest along its crest and bleeding softly downward, fading
 * into mist as they recede. The brush's dry edge breaks along the ridgelines;
 * the ranges drift past at their own depths.
 *
 * https://ittybitty.dev/shaders/sumi-e (MIT)
 */
import { mount, linear } from './runtime.js';

/**
 * @typedef {object} SumiEOptions
 * @property {boolean} showPaper The paper behind the painting. Off, the ink sits on the page.
 * @property {boolean} showMountains The ranges of ink-washed mountains.
 * @property {boolean} showMist Mist rising between the ranges.
 * @property {number} speed How fast the ranges drift past.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} ranges How many ridges recede into the distance.
 * @property {number} height How tall and steep the peaks are.
 * @property {number} mist How much mist fills the valleys.
 * @property {number} brush How broken and dry the brush edges are.
 * @property {boolean} showSun A pale sun behind the mountains.
 * @property {string} ink Colour of the ink.
 * @property {string} paper Colour of the paper.
 * @property {string} accent Colour of the sun.
 */

/** @type {SumiEOptions} */
export const defaults = {
  showPaper: true,
  showMountains: true,
  showMist: true,
  speed: 0.2,
  zoom: 1,
  ranges: 5,
  height: 0.6,
  mist: 0.6,
  brush: 0.5,
  showSun: true,
  ink: '#1c1c22',
  paper: '#f1ebdf',
  accent: '#c8372d',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uShowPaper;
uniform float uShowMountains;
uniform float uShowMist;
uniform float uPixelRatio;
uniform float uTime;
uniform float uRanges;
uniform float uHeight;
uniform float uMist;
uniform float uBrush;
uniform float uSun;
uniform vec3 uInk;        // linear RGB
uniform vec3 uPaper;
uniform vec3 uAccent;

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

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// A ridgeline: sharp, craggy peaks built from folded noise, as the brush
// sketches them.
float ridge(float x, float seed) {
  float h = 0.0;
  float a = 0.55;
  float f = 1.0;
  for (int i = 0; i < 5; i++) {
    float n = noise1(x * f + seed * 17.0);
    h += a * (1.0 - abs(n * 2.0 - 1.0));   // folded: sharp peaks
    f *= 2.1;
    a *= 0.48;
  }
  return h;
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
  vec2 uv = zoomed(gl_FragCoord.xy) / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 css = zoomed(gl_FragCoord.xy) / uPixelRatio;
  float t = uTime;
  float px = 1.0 / (uResolution.y * uZoom);

  // Paper, with its fibres.
  float fibre = uShowPaper > 0.0 ? noise(css * vec2(0.08, 0.3)) * 0.5 + noise(css * 0.2) * 0.5 : 0.0;
  // Premultiplied colour and coverage: with the paper off, the ink and the
  // sun sit on the page.
  vec3 paper = uPaper * (0.96 + 0.04 * fibre);
  vec3 colour = paper * uShowPaper;
  float alpha = uShowPaper;

  // A pale sun, washed in faintly behind everything.
  if (uSun > 0.5) {
    float d = length(p - vec2(aspect * 0.7, 0.72));
    float disc = smoothstep(0.09 + px, 0.09 - px, d) * 0.7;
    colour = mix(colour, mix(uPaper, uAccent, 0.55), disc);
    alpha = mix(alpha, 1.0, disc);
  }

  // Ranges, far to near. Each is a wash of ink: darkest at its crest,
  // bleeding down into paler ink, and the whole range paler with distance.
  float n = uRanges;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (fi >= n || uShowMountains < 0.5) break;
    float z = fi / max(n - 1.0, 1.0);                     // 0 far, 1 near
    float scale = mix(0.9, 0.35, z);
    // Everything about a range, texture included, lives in its own
    // coordinates, so it all drifts together without swimming.
    float x = p.x * scale + t * mix(0.01, 0.05, z) + fi * 3.7;
    float base = mix(0.55, 0.05, z);
    float top = base + ridge(x * 2.2, fi) * mix(0.18, 0.42, z) * (0.4 + uHeight);
    // A gentle wobble of the hand along the ridgeline.
    float edge = top + (noise1(x * 90.0 + fi * 7.0) - 0.5) * 0.004 * uBrush;
    float fw = max(fwidth(p.y - edge), px) * 0.8;
    float inside = smoothstep(fw, -fw, p.y - edge);
    if (inside <= 0.0) continue;
    // Ink tone: strong at the crest, bleeding downward into a pale wash;
    // valleys fill with mist.
    float depth = edge - p.y;
    float below = depth / max(edge - base + 0.1, 0.05);
    float tone = mix(0.95, 0.25, smoothstep(0.0, 0.6, below));
    tone *= 1.0 - uMist * 0.6 * smoothstep(0.3, 1.0, below);
    // Dry brush: just under the crest the ink breaks into streaks that run
    // along the ridge, where the bristles skipped over the paper.
    if (depth < 0.05 && uBrush != 0.0) {
      float streak = noise(vec2(x * 140.0, depth * 160.0 / scale + fi * 11.0));
      float skip = smoothstep(0.45, 0.75, noise(vec2(x * 9.0, fi * 3.0)));   // where the brush ran dry
      float band = smoothstep(0.003, 0.01, depth) * smoothstep(0.035 * skip + 0.005, 0.0, depth - 0.01);
      tone *= 1.0 - uBrush * 0.55 * band * skip * smoothstep(0.5, 0.75, streak);
    }
    // Wet ink pools unevenly.
    tone *= 0.88 + 0.24 * noise(vec2(x * 3.0, p.y * 4.0) + fi * 5.0);
    // Distance: far ranges are pale grey, near ones nearly black.
    float strength = mix(0.18, 0.95, z) * tone;
    // A range hides what is behind it: paper-toned where the ink is pale, or
    // with the paper off, a wash of ink over the page.
    colour = mix(colour, paper * uShowPaper * (1.0 - strength) + uInk * strength, inside);
    alpha = mix(alpha, uShowPaper * (1.0 - strength) + strength, inside);
    // Mist rising between this range and the one in front.
    if (uShowMist > 0.0 && uMist != 0.0 && p.y < base + 0.12) {
      float mist = uMist * smoothstep(base + 0.12, base, p.y) * (0.4 + 0.6 * noise(vec2(x * 3.0 + t * 0.02, p.y * 8.0 + fi * 5.0)));
      float veil = mist * 0.7 * (1.0 - z * 0.6) * uShowMist;
      colour = mix(colour, paper * uShowPaper, veil);
      alpha = mix(alpha, uShowPaper, veil);
    }
  }

  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<SumiEOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 10,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uShowPaper: o.showPaper,
      uShowMountains: o.showMountains,
      uShowMist: o.showMist,
      uRanges: o.ranges,
      uHeight: o.height,
      uMist: o.mist,
      uBrush: o.brush,
      uSun: o.showSun,
      uInk: linear(o.ink),
      uPaper: linear(o.paper),
      uAccent: linear(o.accent),
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SumiEOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function sumiE(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
