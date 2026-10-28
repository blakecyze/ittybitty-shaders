// @ts-check
/**
 * ittybitty/dissolve
 *
 * An image, or the layers beneath, burning away: a ragged edge eats across
 * it, glowing like an ember, charring the picture just ahead of it and
 * leaving nothing (or your background) behind. The classic game effect for
 * defeat, teleport and reveal. Plays on a loop, holds at a set point, or
 * burns where the pointer goes.
 *
 * https://ittybitty.dev/shaders/dissolve (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} DissolveOptions
 * @property {boolean} showBackground The colour left behind. Off, the burned-away parts show the page.
 * @property {boolean} showPicture The picture being burned away.
 * @property {boolean} showEmbers The glowing, burning edge and its glow.
 * @property {string} image Picture that burns away. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'smoulder' | 'loop' | 'hold' | 'pointer'} mode Smoulder in spots that burn and heal forever, burn and reform on a loop, hold at the progress below, or burn around the pointer.
 * @property {number} speed How fast the loop plays.
 * @property {number} progress How much has burned away, for Hold.
 * @property {'noise' | 'upward' | 'radial'} pattern Burn in ragged patches, sweep upward, or spread from the centre.
 * @property {number} scale Size of the burning patches.
 * @property {number} edge Width of the glowing edge.
 * @property {number} char How far the scorching reaches ahead of the edge.
 * @property {string} glow Colour of the burning edge.
 * @property {string} background What is left behind: shown when not transparent.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {DissolveOptions} */
export const defaults = {
  showBackground: true,
  showPicture: true,
  showEmbers: true,
  image: '',
  mode: 'smoulder',
  speed: 0.5,
  progress: 0.5,
  pattern: 'noise',
  scale: 1,
  edge: 0.5,
  char: 0.5,
  glow: '#ff7a1a',
  background: '#0c0908',
  responsiveness: 0.6,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowPicture;
uniform float uShowEmbers;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uMode;      // 0 loop, 1 hold, 2 pointer
uniform float uProgress;
uniform float uPattern;   // 0 noise, 1 upward, 2 radial
uniform float uScale;
uniform float uEdge;
uniform float uChar;
uniform vec3 uGlow;       // linear RGB
uniform vec3 uBackground;
uniform float uTransparent;
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

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

// The picture that burns. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(mix(vec3(0.95, 0.9, 0.82), vec3(0.3, 0.45, 0.75), uv.y * 0.8 + uv.x * 0.2), 1.0);
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
  vec2 uv = px / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 css = px / uPixelRatio;

  // Burn order: the value at which each point catches. Lower burns first.
  float n = 0.0;
  float order = 0.0;
  if (uMode < 2.5) {
    n = fbm(css * 0.012 / uScale);
    if (uPattern < 0.5) order = n;
    else if (uPattern < 1.5) order = uv.y * 0.75 + n * 0.25;
    else order = length((uv - 0.5) * vec2(aspect, 1.0)) * 0.9 + n * 0.3;
  }

  // How far the burn has got, from 0 (whole) to just past 1 (gone).
  float burn;
  if (uMode < 0.5) {
    // Burn away, pause, reform, pause: a smooth loop.
    float c = fract(uTime * 0.12);
    burn = smoothstep(0.05, 0.45, c) * smoothstep(0.95, 0.55, c) * 1.15;
  } else if (uMode > 2.5) {
    // Smoulder: holes open in spots, flare, and heal over again, somewhere
    // new each time, forever. The burn order drifts slowly, and a broad,
    // slower field decides where the fire is eating at the moment.
    order = fbm(css * 0.012 / uScale + vec2(uTime * 0.06, -uTime * 0.045));
    burn = 0.3 + 0.32 * noise(css * 0.0035 / uScale + vec2(uTime * 0.14, uTime * 0.1)) * (0.6 + 0.4 * uProgress * 2.0);
  } else if (uMode < 1.5) {
    burn = uProgress * 1.15;
  } else {
    // Around the pointer, the picture burns away; it reforms behind it.
    vec2 d = p - vec2(uPointer.x * aspect, uPointer.y);
    burn = uPointerActive * (1.15 - length(d) * 3.2 + n * 0.25);
    order = 0.5 + n * 0.1;
  }

  // How far the burn front has passed this point: below 0 untouched, from
  // 0 to width burning, beyond width burned away.
  float width = 0.01 + uEdge * 0.035;
  float x = burn - order;
  float aa = fwidth(x) + 1e-4;
  float gone = smoothstep(width - aa, width + aa, x);
  float burning = smoothstep(-aa, aa, x) * (1.0 - gone);
  // Scorch: browning just ahead of the front.
  float scorch = smoothstep(-0.02 - uChar * 0.15, 0.0, x) * (1.0 - gone);

  vec3 pic = uShowPicture > 0.0 ? srgbToLinear(source(px, 0.0).rgb) : vec3(0.0);
  pic = mix(pic, pic * vec3(0.3, 0.18, 0.1), scorch * 0.9);
  // The burning band: white-hot at the leading line, cooling through the
  // glow colour to dark ash where it meets the burned-away side.
  float heat = clamp(1.0 - x / width, 0.0, 1.0);
  vec3 ember = mix(vec3(0.05, 0.03, 0.02), uGlow * 2.2, smoothstep(0.0, 0.5, heat)) + vec3(1.0, 0.85, 0.55) * smoothstep(0.75, 1.0, heat) * 1.4;
  ember *= 0.8 + 0.4 * noise(css * 0.2 + uTime * 6.0);
  // Premultiplied colour and coverage, so each part can stand alone.
  vec3 colour = pic * uShowPicture;
  float alpha = uShowPicture;
  colour = mix(colour, ember * uShowEmbers, burning);
  alpha = mix(alpha, uShowEmbers, burning);

  // A soft glow the embers throw onto the empty side.
  float halo = gone * exp(-(x - width) * 70.0) * uShowEmbers;
  if (uTransparent < 0.5) {
    colour = mix(colour, uBackground + uGlow * halo * 0.4, gone);
    alpha = mix(alpha, 1.0, gone);
  } else {
    colour = mix(colour, uGlow * 0.6 * halo * 0.25, gone);
    alpha = mix(alpha, halo * 0.25, gone);
  }
  vec3 c = linearToSrgb(1.0 - exp(-colour / max(alpha, 1e-4) * 1.1));
  c += (hash12(px) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

const MODES = { loop: 0, hold: 1, pointer: 2, smoulder: 3 };
const PATTERNS = { noise: 0, upward: 1, radial: 2 };

/** @type {import('./runtime.js').EffectSpec<DissolveOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  // Starts about half burned, so a still frame shows both the picture and
  // the burning edge.
  time: 1.9,
  speed: (o) => (o.mode === 'loop' || o.mode === 'smoulder' ? o.speed : o.mode === 'pointer' ? 1 : 0),
  update(o) {
    return {
      uShowPicture: o.showPicture,
      uShowEmbers: o.showEmbers,
      uMode: MODES[o.mode] ?? 0,
      uProgress: o.progress,
      uPattern: PATTERNS[o.pattern] ?? 0,
      uScale: o.scale,
      uEdge: o.edge,
      uChar: o.char,
      uGlow: linear(o.glow),
      uBackground: linear(o.background),
      uTransparent: !o.showBackground,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 10 });
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
 * @param {Partial<DissolveOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function dissolve(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
