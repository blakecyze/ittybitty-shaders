// @ts-check
/**
 * ittybitty/heatmap
 *
 * A word, or a picture, seen through a thermal camera: heat radiates,
 * shimmers and flows, and maps through a thermal palette. From an image,
 * brightness is heat, and the map can sit over the photo as an overlay.
 * As a layer, image mode reads the layers beneath. The blur is free:
 * mipmaps, read at a few levels of detail.
 *
 * https://ittybitty.dev/shaders/heatmap (MIT)
 */
import { mount, gradient } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} HeatmapOptions
 * @property {boolean} showBackground The coolest tones. Off, they are see-through, so only the heat is drawn over the page.
 * @property {'text' | 'image'} source Heat from a shape, or from a picture's brightness. The shape is the stack's (layers.js: a word, an outline or the element's box); alone, the word itty.
 * @property {string} image Picture to heat. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} amount How much the thermal map covers the picture, from the plain photo to full thermal.
 * @property {number} speed How fast the heat flows.
 * @property {number} spread How far heat radiates from the letters.
 * @property {number} turbulence How much the heat shimmers.
 * @property {number} contrast Contrast of the heat.
 * @property {import('./runtime.js').Gradient} palette Cold to hot.
 * @property {'thermal' | 'contours' | 'pixels'} style Smooth heat, isotherm lines, or a low-resolution thermal sensor.
 * @property {boolean} interactive The pointer is warm: heat blooms where it goes.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {HeatmapOptions} */
export const defaults = {
  showBackground: true,
  source: 'text',
  image: '',
  amount: 1,
  speed: 0.6,
  spread: 0.6,
  turbulence: 0.5,
  contrast: 1.1,
  style: 'thermal',
  interactive: true,
  responsiveness: 0.5,
  palette: [
    [0, '#07051a'],
    [0.25, '#3a0ca3'],
    [0.5, '#d62f6b'],
    [0.75, '#ff9f1c'],
    [1, '#fff4c2'],
  ],
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uText;
uniform vec2 uTextSize;
uniform float uSpread;
uniform float uTurbulence;
uniform float uContrast;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uStopCount;
uniform float uStyle;     // 0 thermal, 1 contours, 2 pixels
uniform float uSource;    // 0 text, 1 image
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uAmount;
uniform float uTransparent;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

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

// The picture being heated. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(vec3(1.0 - length((uv - 0.5) * vec2(1.6, 1.0))), 1.0);
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

float luma(vec4 c) {
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
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

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Distance to the stack's shape in CSS pixels, negative inside; layers.js
// supplies it, and then the shape is what is warm. Alone, the text option is.
// @edge
float heatEdge(vec2 frag) {
  return 1e4;
}
// @end

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  // Pixels: sample a coarse sensor grid, like a real thermal camera.
  if (uStyle > 1.5) {
    vec2 grid = vec2(64.0, 64.0 * uResolution.y / uResolution.x);
    uv = (floor(uv * grid) + 0.5) / grid;
  }
  // Contain the text texture in the canvas.
  float ca = uResolution.x / uResolution.y;
  float ta = uTextSize.x / max(uTextSize.y, 1.0);
  vec2 tuv = (uv - 0.5) * (ca > ta ? vec2(ca / ta, 1.0) : vec2(1.0, ta / ca)) + 0.5;

  float t = uTime;
  // Heat shimmer: the sample point wobbles upward like hot air.
  vec2 wobble = (vec2(noise(uv * 6.0 + vec2(0.0, -t)), noise(uv * 6.0 + vec2(5.0, -t * 1.2))) - 0.5) * 0.02 * uTurbulence;
  vec2 q = tuv + wobble;

  // Radiated heat: the same picture at increasing levels of blur.
  float heat;
  if (uSource > 0.5) {
    // Brightness is heat; the blurred copies make it glow outward and rise.
    vec2 px = (uv + wobble) * uResolution;
    float sharp = luma(source(px, 0.0));
    float mid = luma(source(px, 2.0 + uSpread * 2.0));
    float wide = luma(source(px + vec2(0.0, -0.02 * uResolution.y), 4.0 + uSpread * 2.5));
    heat = (sharp * 0.75 + mid * 0.35 + wide * 0.3 * uSpread) * 1.2;
  } else if (heatEdge(gl_FragCoord.xy) < 1e3) {
    // The stack's shape: its distance field stands in for the blurred copies,
    // in units of the canvas height so the heat spreads the same at any size.
    vec2 at = gl_FragCoord.xy + wobble * uResolution;
    float h = uResolution.y / uPixelRatio;
    float d = heatEdge(at) / h;
    float sharp = clamp(0.5 - heatEdge(at) * uPixelRatio, 0.0, 1.0);
    float body = smoothstep(0.0, 0.06, -d);
    float mid = exp(-max(d, 0.0) / (0.035 * (1.0 + uSpread * 1.6)));
    float wide = exp(-max(heatEdge(at + vec2(0.0, -0.03) * uResolution.y) / h, 0.0) / (0.09 * (1.0 + uSpread * 2.0)));
    float core = sharp * (0.25 + 0.75 * body);
    heat = core * 0.95 + mid * 0.28 + wide * (0.22 + uSpread * 0.35);
    heat += 0.07 * noise(uv * vec2(2.0, 1.5) + vec2(t * 0.05, 0.0)) + 0.05 * (1.0 - uv.y);
  } else {
    // Explicit mip levels, so the heat spreads the same at any canvas size.
    // Levels are relative to a 384px-tall texture, so the look holds at any texture size.
    float base = log2(uTextSize.y / 384.0);
    float sharp = textureLod(uText, q, base + 0.6).r;
    // The letters are warm bodies: a slightly blurred copy inside the shape
    // is hottest where the stroke is thickest and cooler towards its edges.
    float body = textureLod(uText, q, base + 4.6).r;
    float mid = textureLod(uText, q, base + 3.4 + uSpread * 1.6).r;
    float wide = textureLod(uText, q + vec2(0.0, -0.03), base + 5.2 + uSpread * 2.0).r;
    float core = sharp * (0.25 + 0.75 * smoothstep(0.3, 0.9, body));
    // Heat bleeds into the air, rising a little, then fades into the room.
    heat = core * 0.95 + mid * 0.28 + wide * (0.22 + uSpread * 0.35);
    // A cool room with faint uneven warmth, never a flat black.
    heat += 0.07 * noise(uv * vec2(2.0, 1.5) + vec2(t * 0.05, 0.0)) + 0.05 * (1.0 - uv.y);
    // Cool to nothing across the margin around the word, so the heat never
    // meets the canvas edge.
    vec2 inPx = min(tuv, 1.0 - tuv) * uTextSize;
    heat *= smoothstep(0.0, 1.0, min(inPx.x, inPx.y) / (0.19 * uTextSize.y));
  }
  heat *= 0.85 + 0.3 * noise(uv * 3.0 + vec2(t * 0.3, -t * 0.6)) * uTurbulence + 0.15;
  // A warm hand: heat where the pointer is.
  vec2 hand = (uv - uPointer) * vec2(uResolution.x / uResolution.y, 1.0);
  heat += 0.9 * exp(-dot(hand, hand) * 40.0) * uPointerActive * uInteractive;
  heat = clamp(pow(clamp(heat, 0.0, 1.5) / 1.5, 1.0 / uContrast), 0.0, 1.0);
  if (uStyle > 0.5 && uStyle < 1.5) {
    // Contours: isotherm lines over a dimmed map.
    float f = heat * 12.0;
    float line = 1.0 - smoothstep(0.0, 1.5, abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-4));
    heat = mix(heat * 0.35, heat, line);
  }

  vec3 colour = linearToSrgb(max(oklabToLinear(stops(heat)), 0.0));
  // Sensor character: fine, flickering noise, like a real thermal camera.
  colour += (hash12(floor(gl_FragCoord.xy / max(uPixelRatio, 1.0)) + floor(t * 24.0)) - 0.5) * 0.035;
  // Overlay: the thermal map over the original picture.
  if (uSource > 0.5 && uAmount < 1.0) colour = mix(source(gl_FragCoord.xy, 0.0).rgb, colour, uAmount);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    // Fade in over the coolest tones only, so the halo around the heat stays.
    float a = smoothstep(0.0, 0.14, heat);
    fragColor = vec4(colour * a, a);
    return;
  }
  fragColor = vec4(colour, 1.0);
}
`;

/** A CSS font with the size put in: '800 Inter' becomes '800 120px Inter'. */
const sized = (/** @type {string} */ font, /** @type {number} */ size) => {
  const m = /^((?:(?:normal|italic|oblique|bold|bolder|lighter|small-caps|\d{3})\s+)*)(.*)$/.exec(font.trim()) ?? ['', '', font];
  return `${m[1]}${size}px ${m[2] || 'sans-serif'}`;
};

// Tall enough to stay sharp on a large heading at a pixel ratio of 2.
const HEIGHT = 768;
const SIZE = HEIGHT * 0.62;

/**
 * Draw the word, white on black, into a canvas the shader reads as heat.
 * The canvas takes the word's proportions, with a margin for the heat to
 * spread into, so long words are not shrunk into a strip.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {string} font
 */
function paint(canvas, text, font) {
  const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  c.font = sized(font, SIZE);
  const margin = HEIGHT * 0.19;
  canvas.width = Math.min(4096, Math.max(HEIGHT, Math.ceil(c.measureText(text || ' ').width + 2 * margin)));
  canvas.height = HEIGHT;
  c.fillStyle = '#000';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  let size = SIZE;
  c.font = sized(font, size);
  const width = c.measureText(text).width;
  if (width > canvas.width - 2 * margin) {
    size *= (canvas.width - 2 * margin) / width;
    c.font = sized(font, size);
  }
  c.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.04);
}

const STYLES = { thermal: 0, contours: 1, pixels: 2 };

// The word heated when there is no stack shape to heat.
const WORD = 'itty';
const FONT = '900 ui-sans-serif, system-ui, sans-serif';

/** @type {import('./runtime.js').EffectSpec<HeatmapOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1,
  time: 4,
  speed: (o) => o.speed,
  update(o) {
    return {
      uSpread: o.spread,
      uTurbulence: o.turbulence,
      uContrast: o.contrast,
      uStyle: STYLES[o.style] ?? 0,
      uInteractive: o.interactive,
      uSource: o.source === 'image',
      uAmount: o.amount,
      uTransparent: !o.showBackground,
      ...gradient(o.palette),
    };
  },
  attach(ctx) {
    const source = document.createElement('canvas');
    const tex = texture(ctx, 'uText', 0, { mipmaps: true });
    const image = texture(ctx, 'uImage', 1, { mipmaps: true });
    const p = pointer(ctx, { ease: 6 });
    let current = '';
    return {
      update(o) {
        if (o.source === 'image') image.set(o.image);
        // Alone (no stack shape), the word itty is what is warm.
        if (current) return;
        current = WORD;
        paint(source, WORD, FONT);
        tex.set(source);
      },
      frame: p.frame,
      restore() {
        tex.restore();
        image.restore();
      },
      destroy() {
        tex.destroy();
        image.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<HeatmapOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function heatmap(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
