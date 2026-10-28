// @ts-check
/**
 * ittybitty/crt
 *
 * An image, or the layers beneath, played back on an old screen. CRT: a
 * curved tube, glowing phosphor stripes, scanlines that thin in the dark and
 * swell in the light, and a soft bloom. VHS: colour bleeding sideways,
 * tracking bands rolling up the picture, and tape noise.
 *
 * https://ittybitty.dev/shaders/crt (MIT)
 */
import { mount } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} CrtOptions
 * @property {boolean} showFrame The curved, darkened edges of the tube.
 * @property {boolean} showScanlines The horizontal lines of the beam.
 * @property {boolean} showMask The red, green and blue stripes of the screen.
 * @property {boolean} showBloom Bright areas glowing into their neighbours.
 * @property {boolean} showNoise Grain, flicker and tape tracking.
 * @property {string} image Picture to play. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'crt' | 'vhs'} style A tube monitor, or a worn videotape.
 * @property {number} speed How fast the picture flickers and rolls.
 * @property {number} curvature How curved the tube is.
 * @property {number} scanlines Strength of the scanlines.
 * @property {number} mask Strength of the phosphor stripes.
 * @property {number} bleed Colour bleeding sideways.
 * @property {number} noise Static and tape noise.
 * @property {number} bloom Glow around bright areas.
 * @property {number} lines Scanlines on the screen, top to bottom.
 */

/** @type {CrtOptions} */
export const defaults = {
  showFrame: true,
  showScanlines: true,
  showMask: true,
  showBloom: true,
  showNoise: true,
  image: '',
  style: 'crt',
  speed: 1,
  curvature: 0.5,
  scanlines: 0.6,
  mask: 0.45,
  bleed: 0.35,
  noise: 0.3,
  bloom: 0.5,
  lines: 240,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowFrame;
uniform float uShowScanlines;
uniform float uShowMask;
uniform float uShowBloom;
uniform float uShowNoise;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uStyle;     // 0 crt, 1 vhs
uniform float uCurvature;
uniform float uScanlines;
uniform float uMask;
uniform float uBleed;
uniform float uNoise;
uniform float uBloom;
uniform float uLines;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// The picture on the screen. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // Colour bars, the test card every screen has shown.
    float bar = floor(uv.x * 7.0);
    vec3 c = vec3[7](vec3(0.75), vec3(0.75, 0.75, 0.0), vec3(0.0, 0.75, 0.75), vec3(0.0, 0.75, 0.0), vec3(0.75, 0.0, 0.75), vec3(0.75, 0.0, 0.0), vec3(0.0, 0.0, 0.75))[int(clamp(bar, 0.0, 6.0))];
    return vec4(mix(c, vec3(uv.x), step(uv.y, 0.25)), 1.0);
  }
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

vec3 sampleAt(vec2 uv, float blur) {
  return srgbToLinear(source(uv * uResolution, blur).rgb);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float t = uTime;
  bool vhs = uStyle > 0.5;

  // The tube: a barrel bulge, with the corners rounding off into black.
  vec2 c = uv * 2.0 - 1.0;
  float k = uCurvature * (vhs ? 0.25 : 1.0);
  c *= 1.0 + dot(c, c) * 0.08 * k;
  vec2 screen = c * 0.5 + 0.5;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.012 + 0.02 * k), screen) * smoothstep(vec2(0.0), vec2(0.012 + 0.02 * k), 1.0 - screen);
  float inside = mix(1.0, edge.x * edge.y, uShowFrame);

  // VHS: the picture jitters sideways line by line, and tracking bands
  // roll slowly up the frame, smearing what they cross.
  float line = floor(screen.y * uLines);
  vec2 at = screen;
  float band = 0.0;
  if (vhs) {
    float roll = fract(screen.y * 0.9 - t * 0.07);
    band = smoothstep(0.0, 0.03, roll) * smoothstep(0.09, 0.03, roll);
    at.x += (hash12(vec2(line, floor(t * 20.0))) - 0.5) * 0.004 * uNoise * uShowNoise;
    at.x += band * 0.03 * sin(screen.y * 120.0 + t * 30.0) * uNoise * uShowNoise;
  }

  // Colour bleed: chroma is carried at lower resolution than brightness, so
  // it smears sideways, most on tape.
  float spread = uBleed * (vhs ? 0.012 : 0.004);
  vec3 col;
  col.r = sampleAt(at + vec2(spread, 0.0), 0.5).r;
  col.g = sampleAt(at, 0.0).g;
  col.b = sampleAt(at - vec2(spread, 0.0), 0.5).b;
  if (vhs) {
    // Tape keeps less detail and lifts the blacks a little.
    vec3 soft = sampleAt(at + vec2(spread * 0.5, 0.0), 2.0);
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), soft, 0.55) * 0.92 + 0.02;
    col = mix(col, col * vec3(1.05, 0.98, 1.08), 0.5);
  }

  // Bloom: bright areas glow into their neighbours.
  vec3 glow = sampleAt(at, 4.5);
  col += glow * glow * uBloom * 0.6 * uShowBloom;

  // Scanlines: each line a beam, thinner in the dark and wider in the light.
  float y = fract(screen.y * uLines) - 0.5;
  float bright = clamp(dot(col, vec3(0.3)), 0.0, 1.0);
  float width = mix(0.18, 0.42, bright);
  float beam = exp(-y * y / (width * width));
  col *= mix(1.0, beam * 1.25, uScanlines * uShowScanlines);

  // Phosphor stripes: red, green and blue columns, a few pixels wide.
  if (!vhs) {
    float column = mod(floor(gl_FragCoord.x / max(uPixelRatio, 1.0)), 3.0);
    vec3 stripe = vec3(column < 0.5 ? 1.0 : 0.0, column > 0.5 && column < 1.5 ? 1.0 : 0.0, column > 1.5 ? 1.0 : 0.0);
    col *= mix(vec3(1.0), stripe * 2.2 + 0.25, uMask * 0.6 * uShowMask);
  }

  // Noise, flicker and a vignette.
  float n = hash12(gl_FragCoord.xy + fract(t * 60.0) * 311.0);
  float noiseAmount = uNoise * uShowNoise;
  col += (n - 0.5) * noiseAmount * (vhs ? 0.12 : 0.06);
  col += band * n * noiseAmount * 0.4;
  col *= 1.0 - 0.03 * noiseAmount * sin(t * 50.0);
  col *= 1.0 - dot(c, c) * 0.18 * uShowFrame;

  vec3 colour = linearToSrgb(col * inside);
  fragColor = vec4(colour, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<CrtOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 2,
  time: 3,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowFrame: o.showFrame,
      uShowScanlines: o.showScanlines,
      uShowMask: o.showMask,
      uShowBloom: o.showBloom,
      uShowNoise: o.showNoise,
      uStyle: o.style === 'vhs',
      uCurvature: o.curvature,
      uScanlines: o.scanlines,
      uMask: o.mask,
      uBleed: o.bleed,
      uNoise: o.noise,
      uBloom: o.bloom,
      uLines: o.lines,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<CrtOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function crt(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
