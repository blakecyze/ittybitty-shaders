// @ts-check
/**
 * ittybitty/crosshatch
 *
 * Pen-and-ink crosshatching of an image, or the layers beneath. Tone is
 * built the way an illustrator builds it, and the way Praun et al.'s tonal
 * art maps encode it: layers of parallel strokes, each set at a new angle,
 * switched on one after another as the tone darkens, so every darker tone
 * keeps all the strokes of the lighter ones. Strokes are broken into dashes
 * of varied length with tapered ends and a slight wobble, so no two rows
 * line up, and ink outlines follow the edges. Static: one draw per change.
 *
 * https://ittybitty.dev/shaders/crosshatch (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} CrosshatchOptions
 * @property {boolean} showPaper The paper. Off, only the ink is drawn, over the page.
 * @property {boolean} showOutlines Ink outlines where the picture changes.
 * @property {string} image Picture to draw. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} spacing Gap between strokes, in CSS pixels.
 * @property {number} sets How many sets of strokes build up the darkest tones, 1 to 4.
 * @property {number} angle Direction of the first set of strokes, in degrees.
 * @property {number} weight Thickness of the strokes.
 * @property {number} wobble How much the hand wanders over the length of a stroke.
 * @property {number} shake The fine tremor of a hand along each stroke.
 * @property {number} variance How loosely the hand keeps spacing, length, angle and pressure.
 * @property {number} follow How far strokes curve to follow the forms, rather than keeping one angle.
 * @property {number} contrast How strongly tone is pushed towards light and dark.
 * @property {number} colour How much of the picture's colour tints the ink.
 * @property {string} ink Colour of the ink.
 * @property {string} paper Colour of the paper.
 */

/** @type {CrosshatchOptions} */
export const defaults = {
  showPaper: true,
  showOutlines: true,
  image: '',
  spacing: 5,
  sets: 4,
  angle: 35,
  weight: 0.42,
  wobble: 0.5,
  shake: 0.3,
  variance: 0.5,
  follow: 0.35,
  contrast: 1.2,
  colour: 0,
  ink: '#1a1612',
  paper: '#f7f1e3',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uShowPaper;
uniform float uShowOutlines;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uSpacing;
uniform float uSets;
uniform float uAngle;     // radians
uniform float uWeight;
uniform float uWobble;
uniform float uShake;
uniform float uVariance;
uniform float uFollow;
uniform float uContrast;
uniform float uColour;
uniform vec3 uInk;        // linear RGB
uniform vec3 uPaper;

out vec4 fragColor;

// The picture being drawn. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    vec2 d = (uv - vec2(0.5, 0.45)) * vec2(uResolution.x / uResolution.y, 1.0);
    float ball = smoothstep(0.3, 0.29, length(d));
    vec3 c = mix(vec3(0.85, 0.82, 0.76), vec3(0.9, 0.35, 0.25) * (0.5 + 0.8 * clamp(dot(normalize(vec3(d, 0.3)), vec3(-0.5, 0.6, 0.6)), 0.0, 1.0)), ball);
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

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

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// One set of hatching at angle a: rows of dashes, each dash its own length,
// offset and tilt, pressed harder where the pen lands and flicked off at
// the end. Each stroke has its own threshold within this set's band of
// tone, so a set thins out stroke by stroke towards the light instead of
// stopping at an edge. Variance loosens every regularity a hand keeps only
// roughly (spacing, length, angle, weight); shake adds a hand's tremor.
float hatch(vec2 css, float a, float seed, float tone, float start, float band) {
  if (tone <= start) return 0.0;
  vec2 dir = vec2(cos(a), sin(a));
  vec2 q = vec2(dot(css, dir), dot(css, vec2(-dir.y, dir.x))) / uSpacing;
  float row = floor(q.y + 0.5);
  // Rows sit only roughly evenly apart.
  q.y -= uVariance * 0.18 * (hash11(row * 5.1 + seed) - 0.5);
  // The hand wanders slowly along each row, and trembles quickly.
  q.y += uWobble * 0.18 * (noise(vec2(q.x * 0.08, row * 3.1 + seed)) - 0.5);
  q.y += uShake * 0.09 * (noise(vec2(q.x * 1.3, row * 7.7 + seed)) - 0.5);
  // Dashes: each row is cut into strokes of varied length.
  float len = mix(22.0, 8.0 + 34.0 * hash11(row * 7.3 + seed), 0.4 + 0.6 * uVariance);
  float along = q.x / len + hash11(row * 1.7 + seed);
  float dash = floor(along);
  float t = fract(along);
  // This stroke is drawn only where the tone is past its own threshold.
  float threshold = start + band * hash12(vec2(dash + 3.0, row - seed));
  float on = smoothstep(threshold, threshold + 0.04, tone);
  if (on <= 0.0) return 0.0;
  // Each stroke tilts a little off the set's angle.
  q.y += uVariance * 0.35 * (hash12(vec2(dash + 11.0, row + seed)) - 0.5) * (t - 0.5);
  float gap = 0.02 + (0.03 + 0.08 * uVariance) * hash12(vec2(dash, row + seed));
  float taper = smoothstep(gap, gap + 0.05, t) * smoothstep(1.0 - gap, 1.0 - gap - 0.12, t);
  // Heavier where the pen lands, lighter as it lifts away.
  float press = mix(1.0, 1.2 - 0.45 * t, 0.3 + 0.7 * uVariance);
  float weight = 1.0 + uVariance * 0.5 * (hash12(vec2(row, dash + seed)) - 0.5);
  // A pen line holds its width; it swells only a little in the shadows.
  float width = uWeight * (0.7 + 0.3 * smoothstep(start, start + band * 2.0, tone)) * taper * press * weight * on;
  // Ink edges are never quite clean: the width frays a little along the
  // stroke, and the line pales towards its end as the nib runs dry.
  width *= 0.85 + 0.3 * noise(vec2(q.x * 0.9, row * 3.3 + seed));
  float d = abs(q.y - row);
  float aa = fwidth(q.y) * 0.8;
  float dry = mix(1.0, 0.72 + 0.28 * (1.0 - t), 0.4 + 0.6 * uVariance);
  return (1.0 - smoothstep(width * 0.5 - aa, width * 0.5 + aa, d)) * dry;
}

// Every set of strokes, turned together to angle a: the first set, then
// across it, then the two diagonals, each beginning at a darker tone.
float hatching(vec2 css, float a, float seed, float tone) {
  float ink = 0.0;
  float sets = clamp(uSets, 1.0, 4.0);
  float band = 0.62 / sets;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    if (fi >= sets) break;
    float turn = fi == 1.0 ? 1.4 : fi == 2.0 ? 0.72 : fi == 3.0 ? -0.8 : 0.0;
    ink = max(ink, hatch(css, a + turn, seed + fi * 17.0, tone, 0.26 + fi * band, band * 1.3));
  }
  return ink;
}

// Brightness, blurred over a ring of radius r around px: a blur that also
// works in a layer stack, where the source has no blur of its own.
float ring(vec2 px, float r) {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    s += luma(source(px + vec2(cos(a), sin(a)) * r, 0.0).rgb);
  }
  return s / 8.0;
}

// Ink lines by extended difference of Gaussians (Winnemöller, 2012): a
// narrow blur less a wide one is negative just on the dark side of each
// edge, so every edge gets one clean line rather than a band either side.
float edges(vec2 px) {
  float r = uPixelRatio;
  float narrow = mix(luma(source(px, 0.0).rgb), ring(px, 1.0 * r), 0.5);
  float wide = ring(px, 2.8 * r);
  return smoothstep(0.012, 0.045, wide - narrow);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;
  vec3 base = srgbToLinear(source(px, 1.5).rgb);

  // Tone as the eye sees it (sRGB, not linear light), from a softened copy
  // so strokes follow forms, not pixels.
  float l = luma(source(px, 2.5).rgb);
  float tone = clamp((0.5 - l) * uContrast + 0.5, 0.0, 1.0);

  // Hatching turns to follow the forms, as an illustrator curves strokes
  // round a shape: the direction of the contours, from a very soft copy.
  // Directions are lines, not arrows, so they are blended as doubled
  // angles; strokes are drawn on the two nearest of eight fixed angles and
  // blended, so they stay straight and unbroken as their direction turns.
  float e = 16.0 * uPixelRatio;
  vec2 g = vec2(luma(source(px + vec2(e, 0.0), 7.0).rgb) - luma(source(px - vec2(e, 0.0), 7.0).rgb),
                luma(source(px + vec2(0.0, e), 7.0).rgb) - luma(source(px - vec2(0.0, e), 7.0).rgb));
  float form = smoothstep(0.03, 0.12, length(g)) * uFollow;
  float along = atan(g.x, -g.y) - uAngle;
  vec2 v = mix(vec2(1.0, 0.0), vec2(cos(2.0 * along), sin(2.0 * along)), form);
  float turn = atan(v.y, v.x) * 0.5;
  float steps = turn / 0.3927;
  float k = floor(steps);
  float f = smoothstep(0.35, 0.65, fract(steps));
  float ink = hatching(css, uAngle + k * 0.3927, mod(k, 8.0) * 5.0, tone);
  if (f > 0.0) ink = mix(ink, hatching(css, uAngle + (k + 1.0) * 0.3927, mod(k + 1.0, 8.0) * 5.0, tone), f);

  // Outlines, drawn as a hand draws them: the line trembles off the edge,
  // skips in places, and with variance a second, lighter pass wanders a
  // little way from the first.
  float line = 0.0;
  if (uShowOutlines > 0.5) {
    vec2 tremor = (vec2(noise(css * 0.45), noise(css * 0.45 + 9.0)) - 0.5) * uShake * 1.6 * uPixelRatio;
    line = edges(px + tremor);
    line *= smoothstep(0.1, 0.3, noise(css * 0.05 + 4.0) + 0.45 - uVariance * 0.25);
    if (uVariance > 0.3) {
      vec2 drift = (vec2(noise(css * 0.03 + 2.0), noise(css * 0.03 + 7.0)) - 0.5) * uVariance * 4.0 * uPixelRatio;
      line = max(line, edges(px + tremor + drift) * 0.45 * (uVariance - 0.3));
    }
    // A pen line breaks up a little where the nib skips.
    line *= 0.8 + 0.2 * noise(css * 0.35);
  }
  ink = max(ink, line);

  // Ink, tinted by the picture's colour if asked, on paper with a faint grain.
  float peak = max(base.r, max(base.g, base.b));
  vec3 hue = mix(vec3(1.0), base / max(peak, 1e-3), smoothstep(0.03, 0.2, peak));
  vec3 inkColour = mix(uInk, uInk * 0.4 + hue * 0.35, uColour);
  float grain = 0.97 + 0.03 * noise(css * 0.9);
  vec3 paper = uPaper * grain;
  float alpha = max(uShowPaper, ink);
  vec3 colour = mix(paper * uShowPaper, inkColour, ink);
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<CrosshatchOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowPaper: o.showPaper,
      uShowOutlines: o.showOutlines,
      uSpacing: o.spacing,
      uSets: o.sets,
      uAngle: (o.angle * Math.PI) / 180,
      uWeight: o.weight,
      uWobble: o.wobble,
      uShake: o.shake,
      uVariance: o.variance,
      uFollow: o.follow,
      uContrast: o.contrast,
      uColour: o.colour,
      uInk: linear(o.ink),
      uPaper: linear(o.paper),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<CrosshatchOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function crosshatch(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
