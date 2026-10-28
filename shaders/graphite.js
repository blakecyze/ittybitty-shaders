// @ts-check
/**
 * ittybitty/graphite
 *
 * A pencil drawing of an image, or the layers beneath, after the sketch
 * shaders of flockaroo and others. Soft contour lines come from the
 * difference between two blurs of the picture, drawn twice a hair apart as
 * a quick hand does. Shading is short strokes that follow the forms: the
 * stroke direction runs along the picture's contours, taken from a very
 * soft copy so it turns smoothly, and blended between a few fixed angles so
 * strokes never break. Where strokes cross, the lead catches on the tooth
 * of the paper and skips. Static: one draw per change.
 *
 * https://ittybitty.dev/shaders/graphite (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} GraphiteOptions
 * @property {boolean} showPaper The paper. Off, only the graphite is drawn, over the page.
 * @property {boolean} showOutlines Contour lines.
 * @property {boolean} showShading Strokes that shade the forms.
 * @property {string} image Picture to draw. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} pressure How dark the graphite goes.
 * @property {number} strokes Length of the shading strokes.
 * @property {number} spacing Gap between strokes, in CSS pixels.
 * @property {number} follow How closely strokes follow the forms, rather than one hatching angle.
 * @property {number} angle Hatching direction where there are no forms to follow, in degrees.
 * @property {number} tooth Roughness of the paper, where the lead skips.
 * @property {number} shake The fine tremor of a hand along each stroke.
 * @property {number} variance How loosely the hand keeps length, angle, placement and pressure.
 * @property {string} lead Colour of the graphite.
 * @property {string} paper Colour of the paper.
 */

/** @type {GraphiteOptions} */
export const defaults = {
  showPaper: true,
  showOutlines: true,
  showShading: true,
  image: '',
  pressure: 0.9,
  strokes: 0.5,
  spacing: 3.5,
  follow: 0.6,
  angle: 55,
  tooth: 0.5,
  shake: 0.3,
  variance: 0.5,
  lead: '#2b2d33',
  paper: '#f4f1ea',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uShowPaper;
uniform float uShowOutlines;
uniform float uShowShading;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uPressure;
uniform float uStrokes;
uniform float uSpacing;
uniform float uFollow;
uniform float uAngle;     // radians
uniform float uTooth;
uniform float uShake;
uniform float uVariance;
uniform vec3 uLead;       // linear RGB
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

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float lum(vec2 px, float blur) {
  return luma(source(px, blur).rgb);
}

// Strokes at angle a: rows of short marks, each its own length and offset,
// soft at the ends like a pencil lifted off the paper. Returns how much
// graphite a stroke lays here, given how dark the tone wants to be.
float strokes(vec2 css, float a, float seed, float tone) {
  vec2 dir = vec2(cos(a), sin(a));
  vec2 q = vec2(dot(css, dir), dot(css, vec2(-dir.y, dir.x))) / uSpacing;
  float row = floor(q.y);
  // The hand trembles along each stroke.
  q.y += uShake * 0.14 * (noise(vec2(q.x * 1.1, row * 5.3 + seed)) - 0.5);
  // Length: variance spreads it from even to anything from a flick to a
  // long drag.
  float len = mix(4.0, 18.0, uStrokes) * mix(1.0, 0.35 + 1.3 * hash11(row * 3.7 + seed), 0.3 + 0.7 * uVariance);
  float along = q.x / len + hash11(row * 1.3 + seed);
  float mark = floor(along);
  float t = fract(along);
  // Strokes start with a firm touch and trail off, some more than others.
  float trail = mix(0.6, 0.25 + 0.5 * hash12(vec2(mark + 7.0, row)), uVariance);
  float ends = smoothstep(0.0, 0.18, t) * smoothstep(1.0, trail, t);
  // Each stroke tilts a little, and sits a little off its row.
  float tilt = uVariance * 0.5 * (hash12(vec2(mark + 13.0, row + seed)) - 0.5) * (t - 0.5);
  float y = fract(q.y) - 0.5 - (0.15 + 0.25 * uVariance) * (hash12(vec2(mark, row + seed)) - 0.5) - tilt;
  // A pencil line is heavier in the middle of its width.
  float body = exp(-y * y * 14.0);
  // Each stroke has its own threshold: darker tones get more strokes, and
  // light ones none, leaving the paper bare.
  float threshold = 0.2 + 0.75 * hash12(vec2(row - seed, mark));
  float pressed = smoothstep(threshold, threshold + 0.06, tone);
  float force = mix(0.8, 0.35 + 0.65 * hash12(vec2(mark + seed, row)), 0.4 + 0.6 * uVariance);
  return body * ends * pressed * force;
}

// Brightness, blurred over a ring of radius r around px: a blur that also
// works in a layer stack, where the source has no blur of its own.
float ring(vec2 px, float rad) {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    s += lum(px + vec2(cos(a), sin(a)) * rad, 0.0);
  }
  return s / 8.0;
}

// Contour lines by extended difference of Gaussians (Winnemöller, 2012):
// one soft line on the dark side of each edge, fading with its strength.
float contour(vec2 px) {
  float r = uPixelRatio;
  float narrow = mix(lum(px, 0.0), ring(px, 1.2 * r), 0.5);
  float wide = ring(px, 3.2 * r);
  return smoothstep(0.01, 0.06, wide - narrow);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;
  float r = uPixelRatio;

  // Tone as the eye sees it, softened so strokes follow forms, not pixels.
  // The lightest tones stay bare paper, as a draughtsman leaves them.
  float l = lum(px, 2.0);
  float tone = smoothstep(0.18, 0.85, 1.0 - l);

  // Direction of the forms: the gradient of a very soft copy, turned a
  // quarter so strokes run along contours. Where there is no clear form,
  // the hand falls back to its own hatching angle. A slow drift gives each
  // patch of strokes its own slightly different angle, as a hand does.
  float e = 14.0 * r;
  float soft = 7.0;
  vec2 g = vec2(lum(px + vec2(e, 0.0), soft) - lum(px - vec2(e, 0.0), soft), lum(px + vec2(0.0, e), soft) - lum(px - vec2(0.0, e), soft));
  float form = smoothstep(0.03, 0.12, length(g)) * uFollow;
  // Directions are lines, not arrows: blend them as doubled angles, so
  // turning past a half-turn never jumps.
  float along = atan(g.x, -g.y);
  vec2 v = mix(vec2(cos(2.0 * uAngle), sin(2.0 * uAngle)), vec2(cos(2.0 * along), sin(2.0 * along)), form);
  float target = mod(atan(v.y, v.x) * 0.5 + (noise(css * 0.012) - 0.5) * 0.8 * uVariance, 3.14159);
  // Strokes are drawn on the two nearest of eight fixed angles and blended,
  // so they stay straight and unbroken while their direction turns.
  float steps = target / 0.3927;
  float k = floor(steps);
  float f = smoothstep(0.35, 0.65, fract(steps));
  float k1 = mod(k + 1.0, 8.0);
  float shade = 0.0;
  if (uShowShading > 0.5) {
    float a = strokes(css, k * 0.3927, k * 13.0, tone);
    float b = f > 0.0 ? strokes(css, k1 * 0.3927, k1 * 13.0, tone) : 0.0;
    shade = mix(a, b, f);
    // Darker tones get a second layer across the first, at one steady angle.
    float cross_ = strokes(css, uAngle + 1.15, 91.0, (tone - 0.4) / 0.6);
    shade = max(shade, cross_ * 0.85);
  }

  // Contours: a searching line. The first pass trembles; a second, fainter
  // one wanders further with variance; both lighten and lift off here and
  // there as the pressure of the hand changes.
  float line = 0.0;
  if (uShowOutlines > 0.5) {
    vec2 tremor = (vec2(noise(css * 0.5), noise(css * 0.5 + 9.0)) - 0.5) * uShake * 1.6 * r;
    line = contour(px + tremor);
    if (uVariance > 0.2) {
      vec2 drift = (vec2(noise(css * 0.03 + 2.0), noise(css * 0.03 + 7.0)) - 0.5) * uVariance * 5.0 * r;
      line = max(line, contour(px + tremor + drift) * 0.5 * (uVariance - 0.2));
    }
    line *= (0.55 + 0.45 * noise(css * 0.03 + 5.0)) * smoothstep(0.1, 0.3, noise(css * 0.04 + 3.0) + 0.45 - uVariance * 0.3);
  }

  // The paper's tooth: graphite catches on the raised grain and skips
  // the hollows, more the lighter the pressure.
  float grain = noise(css * 1.7) * 0.6 + noise(css * 4.3) * 0.4;
  float catches = mix(1.0, smoothstep(0.2, 0.7, grain + tone * 0.35), uTooth);
  // Blended graphite under the strokes: a soft tone rubbed into the tooth.
  float smudge = smoothstep(0.3, 1.0, tone) * 0.4;
  float graphite = clamp((max(shade * 0.9, line * 0.9) + smudge) * catches * uPressure, 0.0, 1.0);

  // Graphite has a slight sheen: the darkest marks lean silver, not black.
  vec3 lead = mix(uLead, uLead + 0.06, graphite * graphite);
  vec3 paper = uPaper * (0.97 + 0.03 * grain);
  float alpha = max(uShowPaper, graphite);
  vec3 colour = mix(paper * uShowPaper, lead, graphite);
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<GraphiteOptions>} */
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
      uShowShading: o.showShading,
      uPressure: o.pressure,
      uStrokes: o.strokes,
      uSpacing: o.spacing,
      uFollow: o.follow,
      uAngle: (o.angle * Math.PI) / 180,
      uTooth: o.tooth,
      uShake: o.shake,
      uVariance: o.variance,
      uLead: linear(o.lead),
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
 * @param {Partial<GraphiteOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function graphite(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
