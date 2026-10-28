// @ts-check
/**
 * ittybitty/lake
 *
 * A still lake at the edge of the day: a sky, a far line of hills and
 * trees, and water that mirrors them, broken by slow ripples and the
 * darker streaks where wind touches the surface. Mist gathers on the far
 * shore, and the sun lays a path across the water. The pointer drops
 * ripples in the lake.
 *
 * https://ittybitty.dev/shaders/lake (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} LakeOptions
 * @property {boolean} showSky The sky, shore and mist above the water. Off, the lake sits on the page.
 * @property {boolean} showWater The lake and its reflections.
 * @property {number} speed How fast the water moves.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} ripples Size of the ripples breaking the reflection.
 * @property {number} streaks Wind streaks: bands of rougher water across the lake.
 * @property {number} mist Mist over the far shore.
 * @property {number} sun Height of the sun, from setting to high.
 * @property {string} sky Colour of the sky overhead.
 * @property {string} horizon Colour of the sky at the horizon.
 * @property {string} land Colour of the far shore.
 * @property {string} water Tint of the water.
 * @property {'hills' | 'none' | 'image'} shore The far shore: wooded hills, open water to the horizon, or your own silhouette.
 * @property {string} image Silhouette for the Image shore: a PNG or SVG with transparency, sitting on the horizon. Needs CORS headers if cross-origin.
 * @property {number} shoreSize Height of the image shore.
 * @property {boolean} showSun Show the sun, its glow and its path on the water.
 * @property {boolean} interactive The pointer drops ripples in the lake.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {LakeOptions} */
export const defaults = {
  showSky: true,
  showWater: true,
  speed: 0.5,
  zoom: 1,
  ripples: 0.6,
  streaks: 0.6,
  mist: 0.35,
  sun: 0.18,
  sky: '#3b5a8c',
  horizon: '#f6c7a1',
  land: '#1d2430',
  water: '#1a2c3a',
  shore: 'hills',
  image: '',
  shoreSize: 0.35,
  showSun: true,
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uShowWater;
uniform float uTime;
uniform float uRipples;
uniform float uStreaks;
uniform float uMist;
uniform float uSun;
uniform vec3 uSky;        // linear RGB
uniform vec3 uHorizon;
uniform vec3 uLand;
uniform vec3 uWater;
uniform float uInteractive;
uniform float uShore;     // 0 hills, 1 none, 2 image
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uShoreSize;
uniform float uSunDisc;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

const float HORIZON = 0.0; // horizon height in view units

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
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 7.1;
    a *= 0.5;
  }
  return v;
}

// Value noise with its analytic gradient: (value, d/dx, d/dy).
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i);
  float b = hash12(i + vec2(1, 0));
  float c = hash12(i + vec2(0, 1));
  float d = hash12(i + vec2(1, 1));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}

// fbm and its gradient in one pass, for the ripples' slope.
vec3 fbmd(vec2 p) {
  vec3 v = vec3(0.0);
  float a = 0.5;
  float s = 1.0;
  for (int i = 0; i < 4; i++) {
    vec3 n = noised(p);
    v += a * vec3(n.x, n.yz * s);
    p = p * 2.03 + 7.1;
    s *= 2.03;
    a *= 0.5;
  }
  return v;
}

vec3 sunDir() {
  return normalize(vec3(0.15, mix(0.02, 0.6, uSun), 1.0));
}

// Height of the far shore above the horizon at this sideways angle: soft
// hills, with a ragged edge of trees along the top.
float shore(float x) {
  float hills = 0.035 + 0.05 * fbm(vec2(x * 1.6, 3.0)) + 0.03 * smoothstep(0.3, 0.9, fbm(vec2(x * 0.7, 9.0)));
  float trees = 0.012 * pow(noise(vec2(x * 90.0, 1.0)), 2.0) + 0.006 * noise(vec2(x * 260.0, 4.0));
  return hills + trees;
}

// How much of direction d the far shore covers (x), and how high up the
// land it is looking, 0 at the waterline to 1 at the top (y).
vec2 land(vec3 d, float soft) {
  if (uShore > 1.5) {
    // Image: the silhouette spans the view and sits on the horizon. Blurred
    // mip levels soften it in the rippled reflection.
    if (uImageReady < 0.5 || d.y < 0.0) return vec2(0.0);
    float aspect = uResolution.x / uResolution.y;
    float u = d.x / d.z * 1.5 / aspect + 0.5;
    float h = aspect * uImageSize.y / max(uImageSize.x, 1.0) * uShoreSize;
    float v = d.y / d.z * 1.5 / h;
    if (u < 0.0 || u > 1.0 || v > 1.0) return vec2(0.0);
    return vec2(texture(uImage, vec2(u, v), soft * 500.0).a, v);
  }
  if (uShore > 0.5) return vec2(0.0);
  // The noise octaves sum to at most 0.9375, bounding the highest ridge.
  if (d.y > 0.13 + soft) return vec2(0.0);
  float ridge = shore(d.x / max(d.z, 0.1));
  return vec2(smoothstep(ridge + soft, ridge - soft, d.y), clamp(d.y / max(ridge, 1e-3), 0.0, 1.0));
}

// Everything above the water, seen along a direction: colour, and how much
// of it is land or mist rather than open sky (for the transparent sky).
// Reflections pass a softer edge, since ripples blur what the water mirrors.
vec4 scene(vec3 d, float soft) {
  vec3 s = sunDir();
  float up = max(d.y, 0.0);
  vec3 sky = mix(uHorizon, uSky, pow(up * 1.6, 0.5));
  float sunAmount = max(dot(d, s), 0.0);
  vec3 warm = mix(vec3(1.0, 0.62, 0.4), vec3(1.0, 0.95, 0.88), uSun);
  sky += uSunDisc * warm * (pow(sunAmount, 12.0) * 0.3 + smoothstep(0.9995, 0.9998, sunAmount) * 4.0);
  // Thin clouds, lit from below near the sun.
  float cloud = smoothstep(0.55, 0.85, fbm(vec2(d.x / max(d.y + 0.06, 0.02), 1.0 / max(d.y + 0.06, 0.02)) * 0.6));
  sky = mix(sky, mix(uHorizon * 1.15, vec3(1.0), 0.3) + uSunDisc * warm * pow(sunAmount, 4.0) * 0.4, cloud * 0.5 * smoothstep(0.0, 0.15, d.y));

  vec2 l = land(d, soft);
  // Aerial perspective: the shore takes on the colour of the air, most near the water.
  vec3 shoreColour = mix(uLand, uHorizon, 0.18 + 0.4 * uMist * (1.0 - l.y));
  vec3 c = mix(sky, shoreColour, l.x);
  // Mist hugging the far shore.
  float mist = uMist * 0.6 * exp(-max(d.y, 0.0) * 40.0);
  c = mix(c, uHorizon * 1.05, mist);
  return vec4(c, max(l.x, mist));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Zoom about the middle of the canvas: a pixel, or a point in 0..1 canvas
// space (such as the pointer), as the zoomed view sees it.
vec2 zoomed(vec2 fc) {
  return (fc - 0.5 * uResolution) / uZoom + 0.5 * uResolution;
}

vec2 zoomedUv(vec2 uv) {
  return (uv - 0.5) / uZoom + 0.5;
}

void main() {
  vec2 uv = (zoomed(gl_FragCoord.xy) - 0.5 * uResolution) / uResolution.y;
  float t = uTime;
  vec3 rd = normalize(vec3(uv.x, uv.y - 0.04, 1.5));

  vec3 colour;
  float alpha = 1.0;
  if (rd.y >= HORIZON) {
    vec4 above = scene(rd, 0.0015);
    colour = above.rgb;
    if (uTransparent > 0.5) alpha = above.a;
  } else if (uShowWater < 0.5) {
    colour = vec3(0.0);
    alpha = 0.0;
  } else {
    // Where the view ray meets the water, one unit below the eye.
    float dist = 1.0 / -rd.y;
    vec2 p = rd.xz * dist;

    // Ripples: slow noise waves, finer in the wind streaks and calm between.
    float band = uStreaks != 0.0 ? smoothstep(0.35, 0.75, noise(vec2(p.x * 0.04, p.y * 0.35 + t * 0.02))) : 0.0;
    float rough = mix(0.35, 1.0, band * uStreaks + (1.0 - uStreaks) * 0.5);
    vec2 q = p * vec2(0.9, 2.2) * 2.0;
    vec2 slope = uRipples != 0.0 ? fbmd(q + vec2(t * 0.25, t * 0.4)).yz : vec2(0.0);
    slope *= uRipples * rough * 0.08;

    // Rings from the pointer, spreading on the water.
    vec2 at = vec2(0.0);
    float pr = 0.0;
    if (uPointerActive * uInteractive > 0.0 && zoomedUv(uPointer).y < 0.5) {
      vec2 puv = (zoomedUv(uPointer) * uResolution - 0.5 * uResolution) / uResolution.y;
      vec3 pd = normalize(vec3(puv.x, puv.y - 0.04, 1.5));
      at = pd.xz / -min(pd.y, -1e-3);
      vec2 dd = p - at;
      float r = length(dd * vec2(1.0, 0.45)) + 1e-4;
      float ring = sin(r * 18.0 - t * 5.0) * exp(-r * 1.2);
      slope += dd / r * ring * 0.05 * uPointerActive * uInteractive;
    }

    // Fade the detail with distance, so far water is a clean mirror rather
    // than a shimmer of aliased lines.
    slope *= exp(-dist * 0.09);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 r = reflect(rd, n);
    r.y = max(r.y, 0.001);
    float fresnel = 0.03 + 0.97 * pow(1.0 - max(n.y * -rd.y + dot(n.xz, -rd.xz), 0.0), 5.0);
    fresnel = clamp(fresnel, 0.35, 1.0);
    vec3 mirror = scene(r, 0.004 + uRipples * 0.01).rgb;
    colour = mix(uWater, mirror, fresnel);
    // The sun's path: glints on ripples facing it.
    vec3 s = sunDir();
    colour += uSunDisc * vec3(1.0, 0.9, 0.75) * pow(max(dot(r, s), 0.0), 300.0) * 3.0 * (0.5 + rough);
    // Mist settles on the water near the far shore too.
    colour = mix(colour, uHorizon, uMist * 0.35 * exp(-(-rd.y) * 60.0));
    // With a transparent sky, the far water fades out at the horizon too.
    if (uTransparent > 0.5) alpha = smoothstep(0.0, 0.06, -rd.y);
  }

  colour = 1.0 - exp(-colour * 1.35);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour * alpha, alpha);
}
`;

const SHORES = { hills: 0, none: 1, image: 2 };

/** @type {import('./runtime.js').EffectSpec<LakeOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 12,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uShowWater: o.showWater,
      uRipples: o.ripples,
      uStreaks: o.streaks,
      uMist: o.mist,
      uSun: o.sun,
      uSky: linear(o.sky),
      uHorizon: linear(o.horizon),
      uLand: linear(o.land),
      uWater: linear(o.water),
      uShore: SHORES[o.shore] ?? 0,
      uShoreSize: o.shoreSize,
      uSunDisc: o.showSun,
      uTransparent: !o.showSky,
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 20 });
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return {
      update: (o) => o.shore === 'image' && image.set(o.image),
      frame: p.frame,
      restore: image.restore,
      destroy() {
        p.destroy();
        image.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<LakeOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function lake(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
