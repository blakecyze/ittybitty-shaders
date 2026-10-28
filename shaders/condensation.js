// @ts-check
/**
 * ittybitty/condensation
 *
 * A misted-up pane over an image, or over the layers beneath. Draw on it
 * with the pointer and it wipes clear, leaving beads of water gathered along
 * the edge of each stroke; then the mist slowly creeps back. Fine droplets
 * speckle the fog, and a few larger beads cling to it.
 *
 * https://ittybitty.dev/shaders/condensation (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

const TRAIL = 64;

/**
 * @typedef {object} CondensationOptions
 * @property {boolean} showImage The picture behind the glass. Off, only the mist and drops are drawn, over the page.
 * @property {boolean} showFog The fog on the glass.
 * @property {boolean} showDrops Beads of water on the glass.
 * @property {string} image Scene behind the glass. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} fog How thick the mist is.
 * @property {number} droplets Fine droplets and beads in the mist.
 * @property {number} brush Width of a wipe.
 * @property {number} refog Seconds for the mist to creep back over a wipe.
 * @property {string} tint Colour of the mist.
 * @property {boolean} interactive Wipe the glass with the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {CondensationOptions} */
export const defaults = {
  showImage: true,
  showFog: true,
  showDrops: true,
  image: '',
  fog: 0.75,
  droplets: 0.6,
  brush: 1,
  refog: 6,
  tint: '#e9eef2',
  interactive: true,
  responsiveness: 0.9,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowImage;
uniform float uShowFog;
uniform float uShowDrops;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uFog;
uniform float uDroplets;
uniform float uBrush;
uniform vec3 uTint;       // linear RGB
uniform vec4 uWipe[${TRAIL + 1}];   // xy position (CSS px), z clearness 0..1
uniform float uWipeCount;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 hash32(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// The scene behind the glass. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A winter window: dark trees against a pale sky and a warm light.
    vec3 c = mix(vec3(0.55, 0.62, 0.7), vec3(0.85, 0.88, 0.9), uv.y);
    float trees = step(uv.y, 0.35 + 0.08 * sin(uv.x * 23.0) + 0.05 * sin(uv.x * 61.0));
    c = mix(c, vec3(0.08, 0.1, 0.1), trees);
    vec2 d = (uv - vec2(0.72, 0.28)) * vec2(uResolution.x / uResolution.y, 1.0);
    c += vec3(1.0, 0.65, 0.3) * exp(-dot(d, d) * 400.0);
    return vec4(c, 1.0);
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

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;

  // How clear the glass is here: the wiped strokes, each fading as it refogs.
  float clear = 0.0;
  // A ragged edge, as a finger leaves on real glass: one noise per pixel,
  // shared by every segment.
  float r = 26.0 * uBrush * (0.85 + 0.3 * noise(css * 0.08));
  for (int i = 1; i < ${TRAIL + 1}; i++) {
    if (float(i) >= uWipeCount) break;
    vec4 a = uWipe[i - 1];
    vec4 b = uWipe[i];
    float fade = min(a.z, b.z);
    // A break between strokes, or a stretch the mist has already covered.
    if (b.w < 0.5 || fade <= clear) continue;
    float d = segment(css, a.xy, b.xy);
    clear = max(clear, smoothstep(r, r * 0.6, d) * fade);
  }

  // The mist, uneven, thicker towards the bottom where it collects.
  float mist = uFog * (0.8 + 0.25 * noise(css * 0.006) + 0.15 * (1.0 - px.y / uResolution.y));
  mist *= 1.0 - clear;

  // Droplets: fine speckle in the mist, a few beads, and beads gathered on
  // the rim of every wipe, where the water was pushed.
  vec2 cell = floor(css / 9.0);
  vec3 h = hash32(cell);
  vec2 d = fract(css / 9.0) - (0.25 + 0.5 * h.xy);
  float fine = smoothstep(0.22, 0.12, length(d) / (0.2 + 0.8 * h.z)) * step(h.z, uDroplets * 0.8);
  float rim = smoothstep(0.0, 0.25, clear) * smoothstep(1.0, 0.55, clear);
  vec2 bcell = floor(css / 22.0);
  vec3 bh = hash32(bcell + 31.0);
  vec2 bd = fract(css / 22.0) - (0.3 + 0.4 * bh.xy);
  float bead = smoothstep(0.26, 0.2, length(bd) / (0.4 + 0.6 * bh.z)) * step(bh.z, uDroplets * 0.35 + rim * 0.8);
  float water = max(fine * mist, bead * max(mist, rim)) * uShowDrops;
  mist *= uShowFog;

  // The view: sharp where clear, a soft glow of light through the mist.
  float blur = mix(0.0, 5.5, clamp(mist * 1.3, 0.0, 1.0));
  vec2 lens = water > 0.0 ? (bead > fine ? bd : d) * 14.0 * uPixelRatio : vec2(0.0);
  // Premultiplied: without the image, the mist and drops stand alone.
  vec3 behind = uShowImage > 0.5 ? srgbToLinear(source(px - lens * water, mix(blur, 0.0, water)).rgb) : vec3(0.0);
  float alpha = uShowImage;
  vec3 colour = mix(behind, behind * 0.35 + uTint * 0.62, mist * 0.85);
  alpha = mix(alpha, 1.0, mist * 0.85);
  // Water catches the light: a bright crescent and a darker far side.
  float shine = water * smoothstep(0.0, 0.3, dot(bead > fine ? bd : d, vec2(-0.6, 0.7)));
  colour = colour * (1.0 - water * 0.25) + shine * 0.25;
  alpha = clamp(mix(alpha, 1.0, water * 0.25) + shine * 0.25, 0.0, 1.0);

  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  c += (hash12(px) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<CondensationOptions>} */
const base = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 0,
  // It never animates on its own: frames come from the pointer and the mist's return.
  speed: () => 0,
  update(o) {
    return {
      uShowImage: o.showImage,
      uShowFog: o.showFog,
      uShowDrops: o.showDrops,
      uFog: o.fog, uDroplets: o.droplets, uBrush: o.brush, uTint: linear(o.tint) };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 30 });
    // Ring of wipe points in CSS pixels: x, y, clearness, joined to the previous one.
    const trail = new Float32Array(TRAIL * 4);
    // One more slot than the trail: the live cursor, so the wipe reaches it.
    const packed = new Float32Array((TRAIL + 1) * 4);
    let head = 0;
    let count = 0;
    let lastX = -1e4;
    let lastY = -1e4;
    let back = defaults.refog;
    let on = defaults.interactive;
    let wasOver = false;
    return {
      update(o) {
        image.set(o.image);
        back = Math.max(o.refog, 0.5);
        on = o.interactive;
      },
      frame(dt) {
        p.frame(dt);
        const rect = ctx.canvas.getBoundingClientRect();
        let active = false;
        if (on && p.over) {
          const x = p.target[0] * rect.width;
          const y = p.target[1] * rect.height;
          if (Math.hypot(x - lastX, y - lastY) > 10) {
            const i = head * 4;
            trail[i] = x;
            trail[i + 1] = y;
            trail[i + 2] = 1;
            trail[i + 3] = wasOver ? 1 : 0;
            head = (head + 1) % TRAIL;
            count = Math.min(count + 1, TRAIL);
            lastX = x;
            lastY = y;
          }
          wasOver = true;
        } else {
          wasOver = false;
          lastX = lastY = -1e4;
        }
        // The mist returns: every stroke point loses clearness over time.
        for (let i = 0; i < TRAIL; i++) {
          const k = i * 4 + 2;
          if (trail[k] > 0) {
            trail[k] = Math.max(0, trail[k] - dt / back);
            active = true;
          }
        }
        // Oldest first, so consecutive points form the strokes.
        for (let n = 0; n < count; n++) {
          const from = ((head - count + n + TRAIL) % TRAIL) * 4;
          for (let k = 0; k < 4; k++) packed[n * 4 + k] = trail[from + k];
        }
        // The stretch from the last recorded point to where the pointer is
        // now, so the wipe never trails behind the cursor.
        let total = count;
        if (on && p.over && count > 0) {
          const o = count * 4;
          packed[o] = p.target[0] * rect.width;
          packed[o + 1] = p.target[1] * rect.height;
          packed[o + 2] = 1;
          packed[o + 3] = 1;
          total = count + 1;
        }
        ctx.uniform('uWipe', packed);
        ctx.uniform('uWipeCount', total);
        if (active) ctx.invalidate();
      },
      restore: image.restore,
      destroy() {
        image.destroy();
        p.destroy();
      },
    };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<CondensationOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function condensation(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
