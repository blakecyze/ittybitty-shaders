// @ts-check
/**
 * ittybitty/edge-glow
 *
 * A band of soft, flowing colour that hugs the edges of the canvas, the
 * way a phone lights its whole screen border while its assistant listens.
 * The light is built as a stack of glows round a rounded rectangle, each
 * wider and softer than the last: a thin bright rim at the very edge, a
 * band of saturated colour, and a haze that bleeds inward. The colours
 * travel round the border and swell unevenly, and when the glow wakes, a
 * wave of light sweeps in from one side and settles into the border.
 * The middle stays clear, so it sits over any page.
 *
 * https://ittybitty.dev/shaders/edge-glow (MIT)
 */
import { mount, linear } from './runtime.js';

/**
 * @typedef {object} EdgeGlowOptions
 * @property {boolean} showRim The thin bright line at the very edge.
 * @property {boolean} showHaze The soft light that bleeds inward.
 * @property {boolean} showWake The wave of light that sweeps in as the glow wakes.
 * @property {number} speed How fast the colours travel round the border.
 * @property {number} width How far the glow reaches in from the edge, in CSS pixels.
 * @property {number} intensity How bright the glow is.
 * @property {'container' | 'custom'} corners Follow the rounded corners of the canvas (or, if it has none, its container), or set them with `radius`.
 * @property {number} radius Corner radius, in CSS pixels, when `corners` is 'custom'.
 * @property {number} listen How much the glow swells and breathes, as if hearing a voice.
 * @property {number} wake Seconds between wakes. 0 wakes only once.
 * @property {'left' | 'right' | 'bottom'} from Side the wake sweeps in from.
 * @property {string} colourA First colour.
 * @property {string} colourB Second colour.
 * @property {string} colourC Third colour.
 * @property {string} colourD Fourth colour.
 */

/** @type {EdgeGlowOptions} */
export const defaults = {
  showRim: true,
  showHaze: true,
  showWake: true,
  speed: 1,
  width: 16,
  intensity: 1,
  corners: 'container',
  radius: 48,
  listen: 0.6,
  wake: 6,
  from: 'right',
  colourA: '#ff5a2e',
  colourB: '#ff3fa4',
  colourC: '#b04dff',
  colourD: '#4f78ff',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uShowRim;
uniform float uShowHaze;
uniform float uShowWake;
uniform float uWidth;       // CSS pixels
uniform float uIntensity;
uniform vec4 uRadii;        // CSS pixels: top right, bottom right, top left, bottom left
uniform float uListen;
uniform float uWake;        // seconds between wakes
uniform float uFrom;        // 0 left, 1 right, 2 bottom
uniform vec3 uA;            // linear RGB
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uD;

out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// Noise that loops round the border: read on a circle, so the start and
// end of the loop meet without a seam. f is roughly features per loop.
float loop(float u, float f, float drift) {
  float a = u * 6.2831;
  return noise2(vec2(cos(a), sin(a)) * f * 0.16 + drift);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Signed distance to a rounded rectangle, negative inside.
// A rounded box with its own radius at each corner (p is y-up).
float roundedBox(vec2 p, vec2 half_, vec4 radii) {
  vec2 rr = p.x > 0.0 ? radii.xy : radii.zw;
  float r = p.y > 0.0 ? rr.x : rr.y;
  vec2 q = abs(p) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The edge the glow hugs, in CSS pixels, negative inside. In a shaped
// stack (layers.js) the stack's shape stands in for it.
// @edge
float edgeDistance(vec2 p, vec2 size) {
  return roundedBox(p, size * 0.5, min(uRadii, vec4(min(size.x, size.y) * 0.5)));
}
// @end

// The four colours round a loop, blended smoothly, u in 0..1.
vec3 palette(float u) {
  u = fract(u) * 4.0;
  float f = fract(u);
  f = f * f * (3.0 - 2.0 * f);
  int k = int(floor(u));
  vec3 a = k == 0 ? uA : k == 1 ? uB : k == 2 ? uC : uD;
  vec3 b = k == 0 ? uB : k == 1 ? uC : k == 2 ? uD : uA;
  return mix(a, b, f);
}

void main() {
  vec2 css = gl_FragCoord.xy / uPixelRatio;
  vec2 size = uResolution / uPixelRatio;
  vec2 p = css - size * 0.5;
  float t = uTime;

  // Distance in from the edge, and where round the border this point is.
  float d = -edgeDistance(p, size);
  float around = atan(p.y * size.x / size.y, p.x) / 6.2831 + 0.5;

  // The wake: a wave of light sweeping in from one side, then settling.
  float cycle = uWake > 0.0 ? mod(t, uWake) : t;
  float wakeT = cycle / 1.1;
  float along = uFrom < 0.5 ? css.x / size.x : uFrom < 1.5 ? 1.0 - css.x / size.x : css.y / size.y;
  // First a luminous haze floods across the whole screen from that side
  // (0 to 0.45), then draws back into the edges (to 1), leaving the glow.
  float front = smoothstep(0.0, 0.45, wakeT) * 1.5 - 0.25;
  float wash = uShowWake * smoothstep(front + 0.2, front - 0.1, along) * (1.0 - smoothstep(0.35, 1.0, wakeT)) * step(0.0, wakeT);
  // As it draws back, the light gathers towards the edges before fading.
  float gather = smoothstep(0.35, 0.8, wakeT);
  float wave = uShowWake * exp(-pow((along - front) / 0.12, 2.0)) * step(wakeT, 0.6);
  // The glow grows in as the haze draws back into the edges.
  float present = uShowWake > 0.5 && uWake > 0.0 ? smoothstep(0.3, 0.9, wakeT) : 1.0;

  // Listening: the band swells unevenly round the border, as with a voice.
  float voice = 0.55 + 0.45 * noise1(t * 3.1) * noise1(t * 1.7 + 4.0) * 1.8;
  float swell = 1.0 + uListen * (0.55 * loop(around, 9.0, t * 0.5) + 0.35 * (voice - 0.5));

  // Colour travels round the border; two copies at different speeds blend,
  // so the bands never march in lockstep.
  // Colour lies in distinct patches: the position round the border is
  // warped by slow noise, so patches stretch, bunch and slide.
  float warp = around * 2.0 + 0.3 * (loop(around, 6.0, t * 0.25) - 0.5) + t * 0.07;
  vec3 hue = palette(warp);
  hue = mix(hue, palette(around - t * 0.05 + 0.4), 0.2);
  // As on the phone, the top leans warm (orange into pink) and the lower
  // sides cool (violet into blue); the travelling colour rides over that.
  float up = css.y / size.y;
  hue = mix(hue, mix(uD, uA, smoothstep(0.1, 0.95, up)), 0.35);
  hue = mix(hue, uB, 0.25 * smoothstep(0.3, 0.7, up) * (1.0 - smoothstep(0.7, 0.95, up)));

  // Hot spots and dimmer stretches travel round with the colour.
  float hot = 0.6 + 0.75 * loop(around, 11.0, -t * 0.35) * loop(around, 4.0, t * 0.15 + 7.0) * 1.6;
  float w = uWidth * swell;
  // A stack of glows, narrow to wide: rim, band, haze.
  float rim = exp(-max(d, 0.0) / 1.2) * uShowRim;
  float band = exp(-max(d, 0.0) / (w * 0.28));
  float mid = exp(-max(d, 0.0) / (w * 1.0));
  float haze = exp(-max(d, 0.0) / (w * 2.4)) * uShowHaze;
  // Deep, saturated colour in the band itself.
  vec3 deep = hue * hue * 1.4;
  vec3 light = (deep * band * 1.5 + hue * mid * 0.5 + hue * haze * 0.16) * hot;
  // A hairline right at the edge runs white-hot where the glow is strongest.
  light += mix(hue, vec3(1.0), 0.25 + 0.55 * smoothstep(1.0, 1.6, hot)) * rim * 1.3;
  // The wake is a bright, whiter sweep through the band.
  // As it passes, the wake floods further in than the band itself.
  light *= present;
  // The wake: a lilac-white haze over the whole screen, fading from its
  // middle outward as it gathers back to the edges, and a brighter crest
  // where it is flooding in.
  // Strongest towards the edges even at its fullest, and gathering in
  // towards them as it goes.
  float reach = mix(min(size.x, size.y) * 0.45, w * 3.5, gather);
  float haze2 = exp(-max(d, 0.0) / reach);
  vec3 lilac = mix(vec3(0.95, 0.72, 1.0), mix(uB, uC, 0.5), 0.3);
  // Faint over the middle, bright at the edges, with a near-white line
  // right along them while the wash is up.
  light += lilac * wash * (0.12 + 0.88 * haze2 * haze2) * 0.42;
  light += mix(lilac, vec3(1.0), 0.6) * wash * rim * 0.9;
  light += mix(hue, vec3(1.0), 0.5) * wave * band * 0.8;
  light *= uIntensity;
  // Outside the canvas edge there is nothing.
  light *= step(0.0, d);

  float a = clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0);
  vec3 c = linearToSrgb(light / max(a, 1e-4));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c * a, a);
}
`;

const FROM = { left: 0, right: 1, bottom: 2 };

/**
 * The rounded corners the glow follows: the canvas's own, or if it has none,
 * its container's, as CSS draws them (a percentage is of the width).
 * @param {HTMLCanvasElement} canvas
 * @returns {[number, number, number, number]} top right, bottom right, top left, bottom left
 */
function containerRadii(canvas) {
  const read = (/** @type {Element} */ el) => {
    const s = getComputedStyle(el);
    const w = el.getBoundingClientRect().width;
    const px = (/** @type {string} */ v) => {
      const first = v.split(' ')[0];
      return first.endsWith('%') ? (parseFloat(first) / 100) * w : parseFloat(first) || 0;
    };
    return /** @type {[number, number, number, number]} */ ([
      px(s.borderTopRightRadius),
      px(s.borderBottomRightRadius),
      px(s.borderTopLeftRadius),
      px(s.borderBottomLeftRadius),
    ]);
  };
  const own = read(canvas);
  if (own.some((r) => r > 0) || !canvas.parentElement) return own;
  return read(canvas.parentElement);
}

/** @type {import('./runtime.js').EffectSpec<EdgeGlowOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1,
  time: 0.2,
  speed: (o) => o.speed,
  update(o, canvas) {
    return {
      uShowRim: o.showRim,
      uShowHaze: o.showHaze,
      uShowWake: o.showWake,
      uWidth: o.width,
      uIntensity: o.intensity,
      // Without a page to read (an export), the set radius stands in.
      uRadii: o.corners === 'container' && canvas?.isConnected ? containerRadii(canvas) : [o.radius, o.radius, o.radius, o.radius],
      uListen: o.listen,
      uWake: o.wake,
      uFrom: FROM[o.from] ?? 1,
      uA: linear(o.colourA),
      uB: linear(o.colourB),
      uC: linear(o.colourC),
      uD: linear(o.colourD),
    };
  },
  // Following the container: the corners are read from the real canvas here
  // (in a stack, update() above only sees a stand-in), on every change and
  // whenever the canvas or its container is resized.
  attach(ctx) {
    let follow = defaults.corners === 'container';
    let radius = defaults.radius;
    const sync = () => {
      const r = follow && ctx.canvas.isConnected ? containerRadii(ctx.canvas) : [radius, radius, radius, radius];
      ctx.uniform('uRadii', r);
      ctx.invalidate();
    };
    const watch = new ResizeObserver(sync);
    watch.observe(ctx.canvas);
    if (ctx.canvas.parentElement) watch.observe(ctx.canvas.parentElement);
    return {
      update(o) {
        follow = o.corners === 'container';
        radius = o.radius;
        sync();
      },
      destroy() {
        watch.disconnect();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<EdgeGlowOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function edgeGlow(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
