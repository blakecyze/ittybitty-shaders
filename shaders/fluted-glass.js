// @ts-check
/**
 * ittybitty/fluted-glass
 *
 * Reeded glass over an image: vertical flutes that each act as a small
 * cylindrical lens, stretching and repeating the picture behind, with a
 * highlight and a shadow on every rib. Static: it draws once per change.
 *
 * https://ittybitty.dev/shaders/fluted-glass (MIT)
 */
import { mount } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} FlutedGlassOptions
 * @property {boolean} showHighlights The sheen and bright stripe along each rib.
 * @property {boolean} showSeams The hairline where two ribs meet.
 * @property {string} image Image behind the glass. Needs CORS headers if cross-origin.
 * @property {number} flutes Number of flutes across the canvas.
 * @property {number} angle Rotation of the flutes, in degrees.
 * @property {number} distortion How strongly each flute bends the image.
 * @property {number} frost Blur through the glass.
 * @property {number} highlight Brightness of the lit edge of each flute.
 * @property {number} shade Darkness of the shadowed edge.
 * @property {'round' | 'ribbed' | 'wave'} profile Rounded reeds, sharp V ribs, or a soft wave.
 */

/** @type {FlutedGlassOptions} */
export const defaults = {
  showHighlights: true,
  showSeams: true,
  image: '',
  flutes: 18,
  angle: 0,
  distortion: 0.6,
  frost: 0.3,
  highlight: 0.35,
  shade: 0.3,
  profile: 'round',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowHighlights;
uniform float uShowSeams;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uFlutes;
uniform float uAngle;      // radians
uniform float uDistortion;
uniform float uFrost;
uniform float uHighlight;
uniform float uShade;
uniform float uProfile;   // 0 round, 1 ribbed, 2 wave

out vec4 fragColor;

// The picture behind the glass. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(mix(vec3(0.95, 0.6, 0.4), vec3(0.25, 0.3, 0.7), uv.x), 1.0);
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

vec3 backdrop(vec2 uv, float blur) {
  return source(uv * uResolution, blur).rgb;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 across = vec2(cos(uAngle), sin(uAngle));

  // Position across the flutes: u runs -1..1 over each flute.
  float x = dot(p, across) / aspect * uFlutes;
  float u = fract(x) * 2.0 - 1.0;
  // A cylinder's surface across its width. Like a real lens, each rib shows
  // the scene behind it squeezed and mirrored about its centre line.
  float slope = u / sqrt(max(1.0 - u * u * 0.85, 0.05));
  if (uProfile > 0.5 && uProfile < 1.5) slope = sign(u) * 0.9;       // V ribs: two flat facets
  else if (uProfile > 1.5) slope = sin(u * 3.14159) * 0.8;          // wave: a soft sinusoid
  vec2 step1 = across / vec2(aspect, 1.0) / uFlutes;
  vec2 offset = step1 * slope * uDistortion * 0.9;

  // Dispersion: red bends least, blue most, so edges pick up a fine fringe.
  float blur = uFrost * 4.0;
  vec3 colour = vec3(
    backdrop(uv - offset * 0.94, blur).r,
    backdrop(uv - offset, blur).g,
    backdrop(uv - offset * 1.07, blur).b
  );
  colour = srgbToLinear(colour);

  // Glass is thicker at the joins: a little darker and greener there.
  float thick = smoothstep(0.55, 1.0, abs(u));
  colour *= mix(vec3(1.0), vec3(0.82, 0.88, 0.86), thick * (0.4 + uShade));
  // Light from the left: a soft sheen on each rib's shoulder, a crisp
  // specular stripe, and shadow on the trailing side.
  float sheen = exp(-pow((u + 0.45) * 3.2, 2.0));
  float stripe = exp(-pow((u + 0.62) * 14.0, 2.0));
  colour += uHighlight * (sheen * 0.14 + stripe * 0.5) * uShowHighlights;
  colour *= 1.0 - uShade * 0.7 * smoothstep(0.35, 1.0, u);
  // A hairline where two ribs meet.
  float seam = 1.0 - smoothstep(0.0, fwidth(x) * 1.5, min(fract(x), 1.0 - fract(x)));
  colour *= 1.0 - seam * 0.35 * uShowSeams;
  fragColor = vec4(clamp(linearToSrgb(colour), 0.0, 1.0), 1.0);
}
`;

const PROFILES = { round: 0, ribbed: 1, wave: 2 };

/** @type {import('./runtime.js').EffectSpec<FlutedGlassOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowHighlights: o.showHighlights,
      uShowSeams: o.showSeams,
      uFlutes: o.flutes,
      uAngle: (o.angle * Math.PI) / 180,
      uDistortion: o.distortion,
      uFrost: o.frost,
      uHighlight: o.highlight,
      uShade: o.shade,
      uProfile: PROFILES[o.profile] ?? 0,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<FlutedGlassOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function flutedGlass(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
