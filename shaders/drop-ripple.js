// @ts-check
/**
 * ittybitty/drop-ripple
 *
 * A shockwave of light through the page, the way a phone ripples its whole
 * screen when two devices touch to share. A bright bloom flares where it
 * starts; then a ring spreads out across the picture, an image or the layers
 * beneath, bending it as it passes like a wave through glass. The front of
 * the ring runs bright and splits into colour at its edges, a few weaker
 * rings follow it, and the picture behind the wave lifts a little in
 * brightness and scale before settling.
 *
 * Clicking sends a ripple out from wherever you click. Set `every` to have
 * it also ripple on a loop from an edge or the middle.
 *
 * https://ittybitty.dev/shaders/drop-ripple (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} DropRippleOptions
 * @property {boolean} showBloom The flare of light where the ripple starts.
 * @property {boolean} showRings The weaker rings that follow the first.
 * @property {boolean} showFringe Colour splitting at the edges of the wave.
 * @property {string} image The picture the ripple runs through. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'top' | 'centre' | 'bottom'} origin Where the looping ripple starts.
 * @property {number} speed How fast the ripple spreads.
 * @property {number} strength How strongly the wave bends the picture.
 * @property {number} width How broad the wave is.
 * @property {number} glow How brightly the wave front shines.
 * @property {number} every Seconds between ripples on the loop. 0 ripples only when clicked.
 * @property {string} light Colour of the light.
 * @property {boolean} interactive Clicking sends out a ripple.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {DropRippleOptions} */
export const defaults = {
  showBloom: true,
  showRings: true,
  showFringe: true,
  image: '',
  origin: 'top',
  speed: 1,
  strength: 0.6,
  width: 0.5,
  glow: 0.7,
  every: 0,
  light: '#ffffff',
  interactive: true,
  responsiveness: 0.5,
};

const CLICKS = 4;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uShowBloom;
uniform float uShowRings;
uniform float uShowFringe;
uniform float uOrigin;      // 0 top, 1 centre, 2 bottom
uniform float uStrength;
uniform float uWidth;
uniform float uGlow;
uniform float uEvery;
uniform vec3 uLight;        // linear RGB
uniform vec4 uClicks[${CLICKS}]; // position (0..1), time, 0 when unused

out vec4 fragColor;

// The picture the ripple runs through. In a layer stack this reads the
// layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A dusk gradient with rows of rounded tiles, so the wave has edges to bend.
    vec3 c = mix(vec3(0.28, 0.09, 0.32), vec3(0.07, 0.05, 0.16), uv.y);
    vec2 g = uv * vec2(uResolution.x / uResolution.y, 1.0) * 5.0;
    vec2 f = fract(g) - 0.5;
    vec2 q = abs(f) - 0.28;
    float tile = 1.0 - smoothstep(0.0, 0.02, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.08);
    vec3 icon = 0.55 + 0.4 * cos(6.2831 * (floor(g.x) * 0.23 + floor(g.y) * 0.37 + vec3(0.0, 0.33, 0.67)));
    c = mix(c, icon * 0.75, tile * 0.85);
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// One ripple from origin o (canvas-height units), age a seconds. Returns
// the push to apply to the picture (xy) and the brightness of the wave (z).
// The wave is a single crest followed by a trough and weaker rings; it
// spreads quickly at first and slows, and fades as it goes.
vec3 ripple(vec2 p, vec2 o, float a) {
  if (a < 0.0 || a > 4.0) return vec3(0.0);
  vec2 d = p - o;
  float r = length(d) + 1e-4;
  vec2 dir = d / r;
  float front = 1.6 * (1.0 - exp(-a * 1.3));
  float w = 0.05 + 0.12 * uWidth;
  float x = (r - front) / w;
  float fade = exp(-a * 0.9) * smoothstep(0.0, 0.08, a);
  // The crest, and after it rings of alternating sign that die away.
  float crest = exp(-x * x);
  // Rings behind the crest bend the picture but do not shine; they die out
  // within a few wavelengths.
  float behind = max(-x, 0.0);
  float env = uShowRings * exp(-behind * 0.8) * step(x, 0.0);
  float h = crest * fade;
  // The push follows the slope of the wave: outward on its leading side,
  // inward on its trailing side, so the picture bunches and stretches.
  float slope = (-2.0 * x * crest + env * 0.5 * (2.6 * cos(x * 2.6) + 0.8 * sin(x * 2.6))) * fade;
  vec2 push = dir * slope * w * 0.8 * uStrength;
  return vec3(push, h);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 res = uResolution;
  float aspect = res.x / res.y;
  vec2 p = px / res.y;
  float t = uTime;

  vec3 total = vec3(0.0);
  float bloom = 0.0;
  // The looping ripple, from its edge.
  if (uEvery > 0.0) {
    vec2 o = vec2(aspect * 0.5, uOrigin < 0.5 ? 1.02 : uOrigin < 1.5 ? 0.5 : -0.02);
    float a = mod(t, uEvery);
    total += ripple(p, o, a);
    // The bloom pours in from where it starts: bright and tight at first,
    // then widening and fading as the wave takes over.
    float spread = 0.06 + 0.22 * smoothstep(0.0, 0.5, a);
    bloom = max(bloom, exp(-pow(length(p - o) / spread, 1.6)) * exp(-a * 3.5) * smoothstep(0.0, 0.05, a));
  }
  // Ripples sent out by clicks.
  for (int i = 0; i < ${CLICKS}; i++) {
    vec4 c = uClicks[i];
    if (c.w <= 0.0) continue;
    vec2 o = c.xy * vec2(aspect, 1.0);
    float a = t - c.z;
    total += ripple(p, o, a);
    bloom = max(bloom, exp(-length(p - o) / (0.04 + 0.2 * smoothstep(0.0, 0.4, a))) * exp(-a * 2.4) * step(0.0, a) * smoothstep(0.0, 0.05, a));
  }

  // The picture, pushed by the wave: colour splits along the push, as light
  // does through the edge of a lens.
  vec2 push = total.xy * res.y;
  float split = uShowFringe * 0.18;
  vec3 c = vec3(srgbToLinear(source(px - push * (1.0 + split), 0.0).rgb).r,
                srgbToLinear(source(px - push, 0.0).rgb).g,
                srgbToLinear(source(px - push * (1.0 - split), 0.0).rgb).b);
  // The picture lifts a little in brightness on the crest, and the front
  // itself shines.
  float h = total.z;
  // The picture lifts towards white on the crest, as if lit from within.
  c = mix(c, c * 0.6 + uLight * 0.55, clamp(max(h, 0.0), 0.0, 1.0) * 0.55 * uGlow);
  // A broad glowing band over the front, brightest at its peak.
  c += uLight * (max(h, 0.0) * 0.18 + pow(max(h, 0.0), 3.0) * 0.45) * uGlow;
  // A thin bright line right on the wave front, fringed with colour.
  float edgeLine = pow(max(h, 0.0), 6.0);
  c += uLight * edgeLine * 0.5 * uGlow;
  if (uShowFringe > 0.5) {
    float l = length(total.xy) * 60.0;
    c += vec3(0.4, 0.8, 1.0) * max(total.z - 0.3, 0.0) * l * 0.4 * uGlow;
  }
  c += uLight * bloom * uShowBloom * 1.6;
  // Bright light rolls off rather than clipping.
  c = 1.0 - exp(-c * 1.15);

  vec3 outc = linearToSrgb(c);
  outc += (hash12(px) - 0.5) / 255.0;
  fragColor = vec4(outc, 1.0);
}
`;

const ORIGINS = { top: 0, centre: 1, bottom: 2 };

/** @type {import('./runtime.js').EffectSpec<DropRippleOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 2,
  time: 0.6,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowBloom: o.showBloom,
      uShowRings: o.showRings,
      uShowFringe: o.showFringe,
      uOrigin: ORIGINS[o.origin] ?? 0,
      uStrength: o.strength,
      uWidth: o.width,
      uGlow: o.glow,
      uEvery: o.every,
      uLight: linear(o.light),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 20 });
    const clicks = new Float32Array(CLICKS * 4);
    let next = 0;
    let now = 0;
    const down = () => {
      if (!p.over || !ctx.options?.().interactive) return;
      const i = next * 4;
      clicks[i] = p.target[0];
      clicks[i + 1] = p.target[1];
      clicks[i + 2] = now;
      clicks[i + 3] = 1;
      next = (next + 1) % CLICKS;
      ctx.uniform('uClicks', clicks);
      ctx.invalidate();
    };
    addEventListener('pointerdown', down, { passive: true });
    return {
      update: (o) => image.set(o.image),
      frame(dt, time) {
        p.frame(dt);
        now = time;
        ctx.uniform('uClicks', clicks);
      },
      restore: image.restore,
      destroy() {
        removeEventListener('pointerdown', down);
        image.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<DropRippleOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function dropRipple(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
