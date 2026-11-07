// @ts-check
/**
 * ittybitty/afterimage
 *
 * Turns a photo, or the layers beneath, into a long-exposure dream: the frame
 * smeared along a direction of travel with lights trailing furthest, smudged
 * and ghosted into a double exposure, washed into cool tones while anything
 * warm burns hot, haloed, vignetted and buried in moving film grain. The
 * smear can pan, shake, zoom or swirl, and the pointer drags the picture
 * where it passes.
 *
 * https://ittybitty.dev/shaders/afterimage (MIT)
 */
import { mount, gradient, linear } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} AfterimageOptions
 * @property {boolean} showGrain Film grain.
 * @property {boolean} showFringe Red and blue edges split along the motion.
 * @property {boolean} showLeak A warm light leak drifting in from the edge.
 * @property {string} image Image to work on. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'pan' | 'shake' | 'zoom' | 'swirl'} mode The movement: a pan, a handheld shake, a zoom toward the centre, or a swirl around it.
 * @property {number} smear Length of the motion blur.
 * @property {number} angle Direction of travel, in degrees from horizontal.
 * @property {number} softness Out-of-focus blur under the smear.
 * @property {number} smudge How far the picture is pushed around, like a thumb on wet paint.
 * @property {number} ghost A second, offset exposure.
 * @property {number} glow Halation: light spilling around bright areas.
 * @property {number} heat How strongly warm colours burn hot.
 * @property {number} grain Film grain.
 * @property {number} fringe How far the colours split.
 * @property {number} leak Strength of the light leak.
 * @property {number} fade Vignette into the shadow colour.
 * @property {number} speed How fast the smudge drifts and the grain moves.
 * @property {import('./runtime.js').Gradient} palette The cool tones, shadow to highlight.
 * @property {string} hot The colour warm lights burn to.
 * @property {boolean} interactive The pointer drags the picture where it passes, and centres a zoom or swirl.
 */

/** @type {AfterimageOptions} */
export const defaults = {
  showGrain: true,
  showFringe: true,
  showLeak: false,
  image: '',
  mode: 'pan',
  smear: 0.6,
  angle: 6,
  softness: 0.55,
  smudge: 0.5,
  ghost: 0.45,
  glow: 0.7,
  heat: 1,
  grain: 0.6,
  fringe: 0.5,
  leak: 0.6,
  fade: 0.55,
  speed: 0.4,
  palette: [
    [0, '#1b1a50'],
    [0.36, '#2e4fa6'],
    [0.7, '#4f9ac6'],
    [1, '#c2e8de'],
  ],
  hot: '#ff4a26',
  interactive: true,
};

const MODES = { pan: 0, shake: 1, zoom: 2, swirl: 3 };

/** @param {number[]} lab OKLab, to linear RGB: the shader's own conversion. */
const fromOklab = ([L, a, b]) => {
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((v) => v * v * v);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uMode;      // 0 pan, 1 shake, 2 zoom, 3 swirl
uniform float uSmear;
uniform vec2 uDirection;  // unit vector of travel
uniform float uSoftness;
uniform float uSmudge;
uniform float uGhost;
uniform float uGlow;
uniform float uHeat;
uniform float uGrain;
uniform float uFringe;
uniform float uLeak;
uniform float uFade;
uniform float uInteractive;
uniform vec2 uPointer;
uniform vec2 uPointerFlow;
uniform float uPointerActive;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform vec3 uHot;        // linear RGB
// The same at every pixel, so worked out once per change in JavaScript.
uniform vec3 uHotLow;     // the hot colour where a light is dimmest
uniform vec3 uHotHigh;    // and its pale core where brightest
uniform vec3 uVeil;       // the milky veil laid over the cool tones
uniform float uVeilMix;
uniform vec3 uShadow;     // what the edges fade into

out vec4 fragColor;

const int TAPS = 20;

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

// The picture being worked on. In a layer stack this reads the layers below.
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

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// How warm a colour reads: red leading blue, and bright enough to be a light.
float warmth(vec3 c) {
  float l = luma(c);
  return smoothstep(0.12, 0.65, (c.r - c.b) / max(c.r, 1e-3)) * smoothstep(0.004, 0.08, l);
}

// Cool tones from the gradient; warm colours burn toward the hot colour,
// with a paler core where they are brightest.
vec3 recolour(vec3 lin) {
  float tone = clamp((pow(luma(lin), 0.4545) - 0.45) * 1.25 + 0.47, 0.0, 1.0);
  vec3 cool = oklabToLinear(stops(tone));
  // A milky veil over the cool tones, as if the lens were fogged.
  cool = mix(cool, uVeil, uVeilMix);
  // Only lights burn: dim warm areas fall back into the cool shadows.
  vec3 hot = mix(uHotLow, uHotHigh, smoothstep(0.4, 0.9, tone));
  float burn = warmth(lin) * smoothstep(0.18, 0.5, tone);
  return mix(cool, hot, clamp(burn * uHeat, 0.0, 1.0));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;
  vec2 uv = px / uResolution;
  float t = uTime;
  float span = max(uResolution.x, uResolution.y);

  // The direction of travel. A pan or shake has one; a zoom runs toward the
  // centre and a swirl around it, both longer further out. The centre is
  // the middle, or the pointer while it is over the picture.
  vec2 centre = mix(vec2(0.5), uPointer, uPointerActive * uInteractive) * uResolution;
  vec2 rel = px - centre;
  float far = length(rel);
  vec2 radial = rel / max(far, 1e-3);
  far /= span;
  vec2 dir = uDirection;
  float reach = 1.0;
  float behind = -0.3;
  if (uMode > 2.5) { dir = vec2(-radial.y, radial.x); reach = far * 2.0; behind = -0.5; }
  else if (uMode > 1.5) { dir = radial; reach = far * 2.2; behind = 0.0; }
  else if (uMode > 0.5) { reach = 0.35; behind = -1.0; }
  vec2 across = vec2(-dir.y, dir.x);

  // The pointer drags whatever it passes, fading as it slows.
  vec2 near = px - uPointer * uResolution;
  float touch = exp(-dot(near, near) / (span * span * 0.025)) * uPointerActive * uInteractive;
  vec2 drag = uPointerFlow * uResolution * 0.18 * touch;

  // Smudge: a slow, wandering push, stretched along the direction of travel.
  vec2 push = drag * 0.4;
  if (uSmudge > 0.0) {
    vec2 field = vec2(fbm(css * 0.004 + vec2(t * 0.04, 0.0)), fbm(css * 0.004 + vec2(5.2, t * 0.03))) - 0.5;
    push += (dir * field.x * 2.2 + across * field.y * 0.8) * uSmudge * 0.035 * span;
  }

  // Smear: taps trail mostly behind, and bright taps weigh more, so lights
  // streak furthest while dark areas only soften.
  float lod = 1.5 + uSoftness * 3.5;
  vec2 path = dir * uSmear * 0.22 * span * reach + drag;
  vec2 from = px + push;
  float fall = 0.55 * (1.0 + behind);
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float k = (float(i) + 0.5) / float(TAPS);
    vec2 step_ = path * mix(behind, 1.0, k);
    // A shake wanders: a looping handheld path that doubles and triples the image.
    if (uMode > 0.5 && uMode < 1.5) step_ = path * sin(k * 9.4) + vec2(-path.y, path.x) * 0.45 * sin(k * 14.1 + 0.8);
    vec3 c = srgbToLinear(source(from - step_, lod + 1.0).rgb);
    float w = (1.0 - k * fall) * (0.25 + luma(c) * 3.0);
    sum += c * w;
    total += w;
  }
  vec3 smear = sum / total;
  // The subject keeps its shape: a softer copy in place, with the smear
  // laid over it and bright trails lightening whatever they pass.
  float stillLod = 0.5 + uSoftness * 2.5;
  vec3 still = srgbToLinear(source(from, stillLod).rgb);
  float hold = clamp(1.0 - uSmear * 0.6, 0.25, 1.0);
  vec3 col = mix(smear, still, hold * 0.6) + max(smear - still, 0.0) * 0.5;

  // Ghost: a second exposure, offset back along the path, that only lightens.
  if (uGhost > 0.0) {
    vec2 offset = dir * span * 0.07 * min(reach, 1.0) - across * span * 0.012;
    vec3 ghost = srgbToLinear(source(px + push * 1.6 - offset, lod + 1.0).rgb);
    col = mix(col, max(col, ghost), uGhost * 0.7) + ghost * uGhost * 0.12;
  }

  vec3 colour = recolour(col);

  // Fringe: red and blue each read the picture a little further along the
  // path, so edges split into colour the way a cheap lens does.
  if (uFringe > 0.0) {
    vec2 split = (dir * min(reach, 1.0) * span * 0.012 + drag * 0.08) * uFringe;
    vec3 ahead = srgbToLinear(source(from + split, lod).rgb);
    vec3 back = srgbToLinear(source(from - split, lod).rgb);
    vec3 shift = (ahead - back) * 0.5;
    // Flat areas have nothing to split; edges are a small part of the frame.
    if (max(abs(shift.r), max(abs(shift.g), abs(shift.b))) > 1e-5) {
      colour.r = recolour(max(col + shift, 0.0)).r;
      colour.b = recolour(max(col - shift, 0.0)).b;
    }
  }

  // Halation: a wide halo around bright areas, hot where the light is warm.
  if (uGlow > 0.0) {
    vec3 wide = srgbToLinear(source(from - path * 0.4, 7.0).rgb);
    float spill = max(luma(wide) - 0.12, 0.0);
    // Most of a night scene is too dark to spill: no halo to colour.
    if (spill > 0.0) colour += (recolour(wide) * 0.9 + uHot * warmth(wide) * uHeat * 0.8) * spill * uGlow;
  }

  // Fade into the shadow colour at the edges, heaviest at the foot.
  float aspect = uResolution.x / uResolution.y;
  vec2 v = (uv - 0.5) * vec2(aspect, 1.0);
  float edge = smoothstep(0.35, 1.0, length(v * vec2(0.85, 1.15))) + (1.0 - uv.y) * (1.0 - uv.y) * 0.35;
  colour = mix(colour, uShadow, clamp(edge * uFade, 0.0, 0.9));

  // Light leak: warm light bleeding in from the right edge, drifting slowly,
  // screened over the frame so it never clips.
  if (uLeak > 0.0) {
    vec2 at = vec2(aspect + 0.1, 0.62 + 0.18 * sin(t * 0.11));
    vec2 d = (uv * vec2(aspect, 1.0) - at) * vec2(0.55, 1.0);
    float band = exp(-pow(uv.x - 0.9 - 0.06 * sin(t * 0.07 + 1.3), 2.0) * 40.0) * 0.35;
    float light = (exp(-dot(d, d) * 9.0) + band) * uLeak;
    vec3 tint = mix(uHot, vec3(1.0, 0.75, 0.4), 0.35 + 0.3 * exp(-dot(d, d) * 14.0));
    colour = 1.0 - (1.0 - min(colour, 1.0)) * (1.0 - min(tint * light, 1.0));
  }

  vec3 c = linearToSrgb(colour);

  // Film grain: changes every frame, strongest in the midtones, a little colour.
  if (uGrain > 0.0) {
    vec2 g = floor(css) + floor(t * 24.0) * vec2(17.3, 41.9);
    float mono = hash12(g) + hash12(g + 71.3) - 1.0;
    vec3 tint = vec3(hash12(g + 3.1), hash12(g + 9.7), hash12(g + 5.3)) - 0.5;
    c += (mono + tint * 0.5) * uGrain * 0.12 * (0.5 + sqrt(luma(c)));
  }
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<AfterimageOptions>} */
export const spec = {
  defaults,
  fragment,
  // All blur and grain: extra pixels would cost four times as much and show nothing.
  dpr: 1,
  speed: (o) => o.speed,
  update(o) {
    const a = (o.angle * Math.PI) / 180;
    const stops = /** @type {Record<string, number[]>} */ (gradient(o.palette));
    // The gradient at its middle, blended stop to stop as the shader's stops() does.
    let mid = stops.uStop0;
    for (let i = 1; i < 6; i++) {
      const [p, q] = [stops[`uStop${i - 1}`], stops[`uStop${i}`]];
      const k = Math.min(Math.max((0.5 - p[3]) / Math.max(q[3] - p[3], 1e-4), 0), 1);
      mid = mid.map((v, j) => v + (q[j] - v) * k);
    }
    const hot = linear(o.hot);
    return {
      uMode: MODES[o.mode] ?? 0,
      uSmear: o.smear,
      uDirection: [Math.cos(a), Math.sin(a)],
      uSoftness: o.softness,
      uSmudge: o.smudge,
      uGhost: o.ghost,
      uGlow: o.glow,
      uHeat: o.heat,
      uGrain: o.showGrain ? o.grain : 0,
      uFringe: o.showFringe ? o.fringe : 0,
      uLeak: o.showLeak ? o.leak : 0,
      uInteractive: o.interactive,
      uFade: o.fade,
      uHot: hot,
      uHotLow: hot.map((v) => v * 0.7),
      uHotHigh: hot.map((v, i) => (v + ([1, 0.6, 0.22][i] - v) * 0.55) * 1.2),
      uVeil: fromOklab(mid),
      uVeilMix: 0.1 + o.glow * 0.08,
      uShadow: fromOklab(stops.uStop0).map((v) => v * 0.6),
      ...stops,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 8 });
    return {
      update: (o) => image.set(o.image),
      frame: p.frame,
      restore: image.restore,
      destroy() {
        image.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<AfterimageOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function afterimage(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
