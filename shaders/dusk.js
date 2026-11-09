// @ts-check
/**
 * ittybitty/dusk
 *
 * Turns a photo, or the layers beneath, into a blue-hour memory shot wide
 * open on cheap film: thrown out of focus so lights swell into discs, a
 * twilight sky filling the dark above the horizon, the whole frame pulled
 * into cool dusk tones while warm lights keep their colour and halo, a
 * milky haze over the shadows, warm black at the edges and heavy, clumpy
 * colour grain. Brightness stands in for depth: dark shapes read as near
 * and keep most of their focus, silhouetted against lights that dissolve.
 * The pointer pulls the focus where it rests.
 *
 * https://ittybitty.dev/shaders/dusk (MIT)
 */
import { mount, gradient, linear } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} DuskOptions
 * @property {boolean} showSky A twilight sky filling the dark above the horizon.
 * @property {boolean} showGrain Film grain.
 * @property {string} image Image to work on. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} blur How far out of focus the picture is.
 * @property {number} depth How much dark shapes, read as near, keep their focus.
 * @property {number} glow Halation: light spilling around bright areas.
 * @property {number} grade How far the picture is pulled into the dusk tones.
 * @property {number} haze A milky veil lifting the shadows.
 * @property {number} fade Vignette into the shadow colour.
 * @property {number} speed How fast the focus breathes and the grain moves.
 * @property {string} cool The dusk tone the midtones take.
 * @property {string} shadow The warm black the shadows and edges fall into.
 * @property {string} light The colour lights glow.
 * @property {number} twilight Strength of the sky.
 * @property {import('./runtime.js').Gradient} sky The sky, from the top of the frame down to the horizon.
 * @property {number} horizon Height of the horizon, from the bottom of the frame.
 * @property {number} grain Film grain.
 * @property {number} grainSize Size of the grain clumps, in CSS pixels.
 * @property {boolean} interactive The pointer pulls the focus where it rests.
 */

/** @type {DuskOptions} */
export const defaults = {
  showSky: true,
  showGrain: true,
  image: '',
  blur: 0.5,
  depth: 0.8,
  glow: 0.8,
  grade: 0.7,
  haze: 0.3,
  fade: 0.6,
  speed: 0.4,
  cool: '#2f4f8f',
  shadow: '#170e0b',
  light: '#ff7a2c',
  twilight: 0.8,
  sky: [
    [0, '#14305e'],
    [0.5, '#3e64a6'],
    [0.78, '#a17aa8'],
    [1, '#ff8b45'],
  ],
  horizon: 0.42,
  grain: 0.5,
  grainSize: 1.5,
  interactive: true,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uBlur;
uniform float uDepth;
uniform float uGlow;
uniform float uGrade;
uniform float uHaze;
uniform float uFade;
uniform float uTwilight;
uniform float uHorizon;
uniform float uGrain;
uniform float uGrainSize;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform vec3 uCool;       // linear RGB
uniform vec3 uShadow;
uniform vec3 uLight;
uniform vec3 uLightCore;  // the pale centre of a light, worked out in JavaScript

out vec4 fragColor;

const int TAPS = 24;
const float GOLDEN = 2.39996323;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
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

// How far away something seems, from 0 near to 1 far, judged by its
// brightness against the picture as a whole: dark masses read as near, the
// way a silhouette stands in front of a lit sky, and bright ones as far.
float farness(float l, float whole) {
  return smoothstep(0.3, 1.2, l / (whole + 0.01));
}

// How far the blur reaches at a pixel, given how far away it seems: near
// things keep their shape as Depth rises, and where the pointer rests the
// picture is pulled into focus.
float blurAt(vec2 px, float far, float lens) {
  vec2 n = (px / uResolution - uPointer) * vec2(uResolution.x / uResolution.y, 1.0);
  float focus = exp(-dot(n, n) / 0.035) * uPointerActive * uInteractive;
  return lens * (1.0 - 0.9 * focus) * (1.0 - uDepth * (1.0 - far));
}

// How warm a colour reads: red leading blue, and bright enough to be a light.
float warmth(vec3 c) {
  return smoothstep(0.1, 0.6, (c.r - c.b) / max(c.r, 1e-3)) * smoothstep(0.01, 0.12, luma(c));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;
  vec2 uv = px / uResolution;
  float t = uTime;
  float span = max(uResolution.x, uResolution.y);
  float aspect = uResolution.x / uResolution.y;

  // The widest the blur gets: the lens wide open, breathing slowly and only
  // a little, the way a hand-held lens hunts.
  float lens = uBlur * 0.04 * span * (1.0 + 0.04 * sin(t * 0.5));
  // Depth from brightness: near things keep their shape. Nearness is judged
  // on the darker of a close and a wider look, so a dark shape stays near
  // right up to the lights around it.
  float whole = luma(srgbToLinear(source(px, 12.0).rgb));
  vec3 around = srgbToLinear(source(px, 5.0).rgb);
  float here = farness(min(luma(srgbToLinear(source(px, 4.0).rgb)), luma(around)), whole);
  float size = blurAt(px, here, lens);

  // Defocus, gathered as if each tap had scattered its own disc: every pixel
  // looks out to the full lens, and a tap counts only where its own blur
  // reaches this far. So the discs of lights spill over whatever is in focus
  // instead of stopping at its edge, and a tap behind this pixel reaches no
  // further than this pixel's own blur, so near shapes hide the glow behind
  // them. A tap that does not count adds the average so far, which neither
  // darkens nor tints. Bright taps weigh far more, so lights spread into
  // round discs. The pattern turns from one 2×2 block of pixels to the next
  // so its rings dissolve into the grain: turning it per pixel would scatter
  // the lookups within a block, and the GPU would read a far coarser level.
  vec3 col = srgbToLinear(source(px, log2(max(size * 0.5, 1.0))).rgb);
  if (lens >= 0.75) {
    float lod = log2(max(lens * 3.0 / sqrt(float(TAPS)), 1.0));
    float spin = hash12(floor(px * 0.5)) * 6.2832;
    float band = lens * 0.15 + 1.0;
    float lc = luma(col);
    float total = 1.0 + lc * lc * 14.0;
    vec3 sum = col * total;
    for (int i = 0; i < TAPS; i++) {
      float k = (float(i) + 0.5) / float(TAPS);
      float a = float(i) * GOLDEN + spin;
      float d = sqrt(k) * lens;
      vec2 at = px + vec2(cos(a), sin(a)) * d;
      vec3 c = srgbToLinear(source(at, lod).rgb);
      float l = luma(c);
      float there = farness(l, whole);
      float reach = blurAt(at, there, lens);
      if (there > here) reach = min(reach, size * 2.0);
      float m = smoothstep(d - band, d + band, reach);
      float w = 1.0 + m * l * l * 14.0;
      sum += mix(sum / total, c, m) * w;
      total += w;
    }
    col = sum / total;
  }
  float l = luma(col);

  // The neighbourhood: lights are what stands out from it, and empty sky is
  // what is dark across a wide area.
  vec3 local = around * 0.4 + srgbToLinear(source(px, 6.5).rgb) * 0.6;
  float wide = luma(srgbToLinear(source(px, 8.5).rgb));

  // The dusk cast: shadows toward warm black and midtones toward the cool
  // tone, keeping each pixel's brightness, a little darker overall, with some
  // of the photo's own colour carried through. Lights burn the light colour
  // with a pale core, and lights that are already warm are spared, so lamps
  // keep their own amber.
  float bright = sqrt(l);
  float tone = bright * (1.0 - uGrade * 0.22);
  vec3 hue = mix(uShadow / max(luma(uShadow), 1e-4), uCool / max(luma(uCool), 1e-4), smoothstep(0.0, 0.45, tone));
  // Normalised to unit brightness the tones are lurid: take them only part way.
  vec3 graded = mix(vec3(1.0), hue, 0.6) * tone * tone;
  graded += (col - l) * 0.35;
  vec3 lamp = mix(uLight * 0.9, uLightCore * 1.15, smoothstep(0.55, 0.92, bright));
  // Only what stands out from its own surroundings is a light: a lamp is,
  // but a bright sky, however much brighter than the ground, is not.
  graded = mix(graded, lamp, smoothstep(0.15, 0.65, bright) * smoothstep(0.0, 0.15, l - luma(local) * 1.3));
  col = mix(col, max(graded, 0.0), uGrade * (1.0 - warmth(col) * 0.75));

  // The sky: twilight fills the dark above the horizon, deep at the top and
  // glowing warm where it meets the land. Screened in, so lights always
  // shine through it, and thinner where the neighbourhood is lit, so the
  // shapes of buildings and trees stay as darker silhouettes.
  float above = smoothstep(uHorizon - 0.1, uHorizon + 0.08, uv.y);
  float down = clamp((1.0 - uv.y) / max(1.0 - uHorizon, 1e-3), 0.0, 1.0);
  vec3 sky = oklabToLinear(stops(down + 0.03 * sin(t * 0.23)));
  float empty = 1.0 - smoothstep(0.01, 0.2, luma(local)) * 0.6;
  if (uTwilight > 0.0) col = 1.0 - (1.0 - min(col, 1.0)) * (1.0 - min(sky * above * empty * uTwilight, 1.0));

  // Haze: a milky veil over the shadows, the colour of the sky behind it.
  vec3 fog = mix(uCool, sky, uTwilight * 0.6) * 0.6;
  col = mix(col, max(col, fog), uHaze * 0.45 * (1.0 - smoothstep(0.2, 0.7, tone)));

  // Halation: a wide halo wherever the neighbourhood is brighter than a
  // wider area around it, glowing the light colour with a paler core. A
  // bright sky or a daylit photo has nothing standing out, so it is not
  // washed over.
  float spill = max(luma(local) - wide * 1.3 - 0.005, 0.0);
  if (spill > 0.0 && uGlow > 0.0) {
    vec3 tint = mix(uLight, uLightCore, smoothstep(0.08, 0.4, spill));
    col += tint * (spill * 1.6 + spill * spill * 10.0) * uGlow;
  }

  // Fade into the shadow colour at the edges, heaviest at the foot.
  vec2 v = (uv - 0.5) * vec2(aspect, 1.0);
  float edge = smoothstep(0.3, 1.0, length(v * vec2(0.85, 1.15))) + (1.0 - uv.y) * (1.0 - uv.y) * 0.4;
  col = mix(col, uShadow, clamp(edge * uFade, 0.0, 0.92));

  vec3 c = linearToSrgb(col);

  // Film grain: crisp specks a grain-size across, from two offset grids so
  // they clump unevenly instead of sitting on a lattice. Mostly brightness
  // with a little colour, as heavy in the shadows as in the midtones, and
  // new at a steady 24 a second at the default drift.
  vec2 g = css / uGrainSize;
  vec2 seed = floor(t * 60.0) * vec2(17.3, 41.9);
  vec2 a = floor(g) + seed;
  vec2 b = floor(g + 0.5) + seed + 71.3;
  float mono = hash12(a) + hash12(b) - 1.0;
  vec3 tint = vec3(hash12(a + 3.1), hash12(a + 9.7), hash12(b + 5.3)) - 0.5;
  float mid = 1.0 - abs(luma(c) * 2.0 - 1.0);
  c += (mono + tint * 0.35) * max(uGrain, 0.012) * 0.11 * (0.65 + 0.35 * mid);
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<DuskOptions>} */
export const spec = {
  defaults,
  fragment,
  // All blur and grain: extra pixels would cost four times as much and show nothing.
  dpr: 1,
  speed: (o) => o.speed,
  update(o) {
    const light = linear(o.light);
    return {
      uBlur: o.blur,
      uDepth: o.depth,
      uGlow: o.glow,
      uGrade: o.grade,
      uHaze: o.haze,
      uFade: o.fade,
      uTwilight: o.showSky ? o.twilight : 0,
      uHorizon: o.horizon,
      uGrain: o.showGrain ? o.grain : 0,
      uGrainSize: o.grainSize,
      uInteractive: o.interactive,
      uCool: linear(o.cool),
      uShadow: linear(o.shadow),
      uLight: light,
      uLightCore: light.map((v, i) => v + ([1, 0.9, 0.72][i] - v) * 0.7),
      ...gradient(o.sky),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 4 });
    // Everything drifts slowly and the grain is film's 24 frames a second,
    // so 24 fps looks the same as 60 at under half the work. Full rate only
    // while the pointer pulls the focus, and for a second after it settles.
    let movedAt = -Infinity;
    const fps = () => {
      const now = performance.now();
      if (p.over && (p.velocity[0] !== 0 || p.velocity[1] !== 0) && ctx.options?.().interactive) movedAt = now;
      return now - movedAt < 1000 ? 0 : 24;
    };
    return {
      update: (o) => image.set(o.image),
      frame: p.frame,
      fps,
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
 * @param {Partial<DuskOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function dusk(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
