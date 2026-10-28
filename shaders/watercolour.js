// @ts-check
/**
 * ittybitty/watercolour
 *
 * Turns an image, or the layers beneath, into a watercolour painting: soft
 * washes that bleed past their edges, pigment pooling darker where a wash
 * dries, the grain of cold-pressed paper, and fine granulation where pigment
 * settles into its hollows. Static: it paints once per change.
 *
 * https://ittybitty.dev/shaders/watercolour (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} WatercolourOptions
 * @property {boolean} showPaper The paper. Off, only the washes are drawn, over the page.
 * @property {boolean} showEdges The darker rims where each wash dried.
 * @property {string} image Image to paint. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} wash Softness of the washes: how much detail dissolves.
 * @property {number} bleed How far colour runs past its edges.
 * @property {number} edges Pigment pooling at the edge of each wash.
 * @property {number} granulation Speckle where pigment settles into the paper.
 * @property {number} paper Texture of the paper.
 * @property {number} saturation Strength of the colour.
 * @property {string} tint Colour of the paper.
 * @property {number} seed Paints the same picture with a different hand.
 */

/** @type {WatercolourOptions} */
export const defaults = {
  showPaper: true,
  showEdges: true,
  image: '',
  wash: 0.55,
  bleed: 0.5,
  edges: 0.6,
  granulation: 0.4,
  paper: 0.5,
  saturation: 1.1,
  tint: '#f7f2e8',
  seed: 1,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowPaper;
uniform float uShowEdges;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uWash;
uniform float uBleed;
uniform float uEdges;
uniform float uGranulation;
uniform float uPaper;
uniform float uSaturation;
uniform vec3 uTint;       // linear RGB
uniform float uSeed;

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

float fbm(vec2 p) {
  return noise(p) * 0.5 + noise(p * 2.07 + 3.1) * 0.3 + noise(p * 4.3 + 7.7) * 0.2;
}

// The picture being painted. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(mix(vec3(0.95, 0.55, 0.3), vec3(0.2, 0.35, 0.7), uv.x * 0.7 + uv.y * 0.3), 1.0);
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  // Texture in CSS pixels, so paper and pigment keep their scale.
  vec2 css = px / uPixelRatio + uSeed * 91.7;

  // Bleed: the wash is sampled through a slow, wandering distortion.
  vec2 wander = (vec2(fbm(css * 0.012), fbm(css * 0.012 + 5.3)) - 0.5) * uBleed * 60.0 * uPixelRatio;
  float blurWash = 1.5 + uWash * 3.0;
  vec3 wash = srgbToLinear(source(px + wander, blurWash).rgb);
  vec3 wider = srgbToLinear(source(px + wander * 1.4, blurWash + 1.6).rgb);

  // Watercolour is transparent pigment on paper: it can only darken, so
  // work in absorbance (1 - colour) and add pigment rather than paint.
  vec3 pigment = 1.0 - wash;
  float grey = dot(pigment, vec3(0.333));
  pigment = max(mix(vec3(grey), pigment, uSaturation), 0.0);
  // Pale tones are left as bare paper; washes settle into a few soft layers.
  pigment = pow(pigment, vec3(1.3));
  float depth = dot(pigment, vec3(0.333));
  float layered = mix(depth, floor(depth * 4.0 + 0.5) / 4.0, 0.35);
  pigment *= layered / max(depth, 1e-3);

  // Pooling: where a wash is darker than its surroundings, pigment gathers
  // at the drying edge, a darker rim just inside the shape.
  vec3 pool = max((1.0 - wider) - pigment, 0.0);
  vec3 rim = max(pigment - (1.0 - wider), 0.0);
  pigment += (rim * 2.6 + pool * 0.2) * uEdges * uShowEdges;

  // The paper: cold-pressed tooth, and granulation in its hollows.
  float tooth = fbm(css * 0.12) * 0.65 + noise(css * 0.6) * 0.35;
  float hollow = smoothstep(0.3, 0.8, tooth);
  // Granulation shows in heavier washes; thin washes stay clean.
  pigment *= 1.0 + (hollow - 0.5) * uGranulation * 0.5 * smoothstep(0.05, 0.4, dot(pigment, vec3(0.333)));
  pigment *= 0.85 + 0.3 * fbm(css * 0.02);             // uneven flooding of each wash
  vec3 paper = uTint * (1.0 - uPaper * 0.12 * (1.0 - tooth));

  // Even the darkest wash lets some paper through.
  vec3 colour = paper * (1.0 - clamp(pigment, 0.0, 0.88));
  // Without the paper, the wash covers the page as much as it absorbs.
  float alpha = mix(clamp(max(pigment.r, max(pigment.g, pigment.b)) / 0.88, 0.0, 1.0), 1.0, uShowPaper);
  vec3 c = linearToSrgb(colour);
  c += (hash12(px) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<WatercolourOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowPaper: o.showPaper,
      uShowEdges: o.showEdges,
      uWash: o.wash,
      uBleed: o.bleed,
      uEdges: o.edges,
      uGranulation: o.granulation,
      uPaper: o.paper,
      uSaturation: o.saturation,
      uTint: linear(o.tint),
      uSeed: o.seed,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<WatercolourOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function watercolour(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
