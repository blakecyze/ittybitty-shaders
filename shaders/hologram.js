// @ts-check
/**
 * ittybitty/hologram
 *
 * Any image, or the layers beneath, as a projected hologram: rebuilt from its
 * brightness in a single glowing colour, sliced into fine scanlines, with a
 * brighter band sweeping through it, edges picking up a fresnel glow, and the
 * signal glitching now and then: a slice jumps sideways, the colours split.
 *
 * https://ittybitty.dev/shaders/hologram (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} HologramOptions
 * @property {boolean} showBackground The dark behind the projection. Off, only the projection is drawn, glowing over the page.
 * @property {boolean} showScanlines The fine horizontal lines of the projection.
 * @property {string} image Picture to project. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} speed How fast the scan moves and the signal flickers.
 * @property {number} lines Strength of the scanlines.
 * @property {number} glitch How often and how hard the signal glitches.
 * @property {number} glow Glow around bright parts and edges.
 * @property {number} opacity How solid the projection is.
 * @property {string} colour Colour of the projection.
 * @property {string} background Colour behind the projection.
 * @property {boolean} interactive The projection tilts and glitches towards the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {HologramOptions} */
export const defaults = {
  showBackground: true,
  showScanlines: true,
  image: '',
  speed: 1,
  lines: 0.6,
  glitch: 0.4,
  glow: 0.6,
  opacity: 0.8,
  colour: '#4fd8ff',
  background: '#040810',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowScanlines;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uLines;
uniform float uGlitch;
uniform float uGlow;
uniform float uOpacity;
uniform vec3 uColour;     // linear RGB
uniform vec3 uBackground;
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;

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

// The picture being projected. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A rotating wireframe-ish orb, so the effect reads with no image.
    vec2 d = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    float r = length(d);
    float ring = smoothstep(0.012, 0.0, abs(r - 0.28)) + smoothstep(0.35, 0.0, r) * 0.35;
    float lat = smoothstep(0.08, 0.0, abs(fract(d.y * 12.0 + 0.5) - 0.5)) * step(r, 0.28);
    return vec4(vec3(ring + lat * 0.5), 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uResolution;
  float t = uTime;
  vec2 css = px / uPixelRatio;

  // Glitches: short bursts where horizontal slices jump sideways.
  float burst = step(1.0 - uGlitch * 0.35, hash11(floor(t * 6.0)));
  float slice = floor(uv.y * 24.0 + hash11(floor(t * 13.0)) * 24.0);
  float jump = burst * (hash11(slice + floor(t * 20.0)) - 0.5) * 0.08 * step(0.6, hash11(slice * 3.1 + floor(t * 7.0)));
  // The pointer draws the interference towards it.
  if (uInteractive * uPointerActive > 0.0) {
    float near = exp(-pow((uv.y - uPointer.y) * 12.0, 2.0)) * uPointerActive * uInteractive;
    jump += near * sin(uv.y * 400.0 + t * 30.0) * 0.004;
  }
  vec2 at = px + vec2(jump * uResolution.x, 0.0);

  // Colour split: the red and blue parts of the signal drift apart.
  float split = (0.0015 + burst * 0.006) * uResolution.x;
  float lr = luma(source(at + vec2(split, 0.0), 0.0).rgb);
  float lg = luma(source(at, 0.0).rgb);
  float lb = luma(source(at - vec2(split, 0.0), 0.0).rgb);
  // Edges glow: where brightness changes, as a fresnel rim would.
  float soft = luma(source(at, 2.5).rgb);
  float edge = clamp(abs(lg - soft) * 6.0, 0.0, 1.0);

  // A hologram is mostly empty light: forms are drawn by their edges and
  // their brightest parts, while flat areas stay faint and see-through.
  // Brightness is taken relative to the picture's local average, so a pale
  // background does not flood the projection.
  float local = luma(source(at, 5.5).rgb);
  float fill = max(lg - local, 0.0) * 1.8 + lg * 0.1;
  vec3 holo = uColour * (fill + edge * (0.6 + uGlow)) + vec3(lr - lg, 0.0, lb - lg) * 0.3 * uColour.b;
  holo += uColour * soft * uGlow * 0.12;

  // Scanlines, fine and a little uneven, and a bright band sweeping upward.
  float scan = 0.55 + 0.45 * sin(css.y * 3.14159 * 0.66);
  holo *= mix(1.0, scan, uLines * uShowScanlines);
  float band = exp(-pow((fract(uv.y - t * 0.12) - 0.5) * 18.0, 2.0));
  holo *= 1.0 + band * 0.8;
  // Flicker: the whole projection breathes and stutters.
  holo *= 0.88 + 0.12 * hash11(floor(t * 24.0)) - burst * 0.2;
  holo *= uOpacity;

  vec3 colour = uBackground + holo;
  colour = 1.0 - exp(-colour * 1.3);
  vec3 c = linearToSrgb(colour);
  c += (hash12(px + t) - 0.5) * 0.025;
  if (uTransparent > 0.5) {
    vec3 lc = linearToSrgb(1.0 - exp(-holo * 1.3));
    fragColor = vec4(lc, max(lc.r, max(lc.g, lc.b)));
    return;
  }
  fragColor = vec4(c, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<HologramOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 3,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowScanlines: o.showScanlines,
      uLines: o.lines,
      uGlitch: o.glitch,
      uGlow: o.glow,
      uOpacity: o.opacity,
      uColour: linear(o.colour),
      uBackground: linear(o.background),
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
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
 * @param {Partial<HologramOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function hologram(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
