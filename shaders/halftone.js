// @ts-check
/**
 * ittybitty/halftone
 *
 * An image as print: a single ink of dots that grow with darkness, or four
 * rotated CMYK screens overprinting on paper. Static: one draw per change.
 *
 * https://ittybitty.dev/shaders/halftone (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} HalftoneOptions
 * @property {boolean} showBackground The unprinted paper (mono only). Off, only the dots are drawn, over the page.
 * @property {string} image Image to print. Needs CORS headers if cross-origin.
 * @property {'mono' | 'cmyk'} mode One ink, or four-colour process.
 * @property {'dots' | 'lines' | 'squares' | 'crosses'} shape Shape of the screen.
 * @property {number} size Dot spacing in CSS pixels.
 * @property {number} angle Screen angle in degrees (mono), or rotation of all screens (CMYK).
 * @property {number} contrast Contrast before screening.
 * @property {number} softness Edge softness of the dots.
 * @property {string} ink Ink colour for mono.
 * @property {string} paper Paper colour.
 */

/** @type {HalftoneOptions} */
export const defaults = {
  showBackground: true,
  image: '',
  mode: 'mono',
  shape: 'dots',
  size: 7,
  angle: 45,
  contrast: 1.2,
  softness: 0.5,
  ink: '#1f2a44',
  paper: '#f3eee4',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uCmyk;
uniform float uShape;      // 0 dots, 1 lines, 2 squares, 3 crosses
uniform float uTransparent;
uniform float uSize;
uniform float uAngle;     // radians
uniform float uContrast;
uniform float uSoftness;
uniform vec3 uInk;        // linear RGB
uniform vec3 uPaper;

out vec4 fragColor;

// The picture being printed. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(uv.x, 0.5 + 0.5 * sin(uv.y * 6.0), 1.0 - uv.x, 1.0);
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

vec3 tone(vec2 px) {
  return clamp((source(px, 0.0).rgb - 0.5) * uContrast + 0.5, 0.0, 1.0);
}

// Coverage of one screen: a dot centred in each rotated cell, sized so its
// area matches the ink amount. Samples the image at the cell centre.
float screen(vec2 px, float angle, int channel) {
  float size = uSize * uPixelRatio;
  mat2 r = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  vec2 g = r * px / size;
  vec2 centre = transpose(r) * ((floor(g) + 0.5) * size);
  vec3 c = tone(centre);
  float amount;
  if (channel < 0) {
    amount = 1.0 - dot(c, vec3(0.2126, 0.7152, 0.0722));
  } else {
    float k = 1.0 - max(c.r, max(c.g, c.b));
    vec3 cmy = (1.0 - c - k) / max(1.0 - k, 1e-3);
    amount = channel == 0 ? cmy.x : channel == 1 ? cmy.y : channel == 2 ? cmy.z : k;
  }
  // Each shape is sized so its inked area matches the amount.
  amount = clamp(amount, 0.0, 1.0);
  vec2 f = fract(g) - 0.5;
  float d;
  float edge;
  if (uShape < 0.5) {
    d = length(f);
    edge = sqrt(amount) * 0.5642;          // circle of area = amount
  } else if (uShape < 1.5) {
    d = abs(f.y);
    edge = amount * 0.5;                   // line of thickness = amount
  } else if (uShape < 2.5) {
    d = max(abs(f.x), abs(f.y));
    edge = sqrt(amount) * 0.5;             // square of area = amount
  } else {
    d = min(abs(f.x), abs(f.y));
    edge = (1.0 - sqrt(1.0 - amount)) * 0.5; // two bars covering = amount
  }
  float aa = (0.5 + uSoftness * 2.0) / size;
  return 1.0 - smoothstep(edge - aa, edge + aa, d);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 colour;
  if (uCmyk < 0.5) {
    float ink = screen(px, uAngle, -1);
    if (uTransparent > 0.5) {
      fragColor = vec4(linearToSrgb(uInk) * ink, ink);
      return;
    }
    colour = mix(uPaper, uInk, ink);
  } else {
    // Classic screen angles: C 15°, M 75°, Y 0°, K 45°. Inks multiply on paper.
    const float D = 0.0174533;
    colour = uPaper;
    colour *= mix(vec3(1.0), vec3(0.0, 0.62, 0.9), screen(px, uAngle + 15.0 * D, 0));
    colour *= mix(vec3(1.0), vec3(0.9, 0.05, 0.45), screen(px, uAngle + 75.0 * D, 1));
    colour *= mix(vec3(1.0), vec3(1.0, 0.92, 0.0), screen(px, uAngle, 2));
    colour *= mix(vec3(1.0), vec3(0.08), screen(px, uAngle + 45.0 * D, 3));
  }
  fragColor = vec4(linearToSrgb(colour), 1.0);
}
`;

const SHAPES = { dots: 0, lines: 1, squares: 2, crosses: 3 };

/** @type {import('./runtime.js').EffectSpec<HalftoneOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uCmyk: o.mode === 'cmyk',
      uShape: SHAPES[o.shape] ?? 0,
      uTransparent: !o.showBackground,
      uSize: o.size,
      uAngle: (o.angle * Math.PI) / 180,
      uContrast: o.contrast,
      uSoftness: o.softness,
      uInk: linear(o.ink),
      uPaper: linear(o.paper),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0);
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<HalftoneOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function halftone(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
