// @ts-check
/**
 * ittybitty/decode
 *
 * A picture that decodes itself: it starts as a few big squares, and each
 * square splits into four, then four again, until the image is sharp, the
 * way a progressive image arrives over a slow line. The splitting is smart:
 * squares with detail inside them split first and flat areas stay chunky a
 * little longer, so the shapes in the picture appear before its sky. The
 * squares can show the picture's own colours, flat tones or dithered tones
 * through your palette.
 *
 * It decodes once, or loops, restarting or running backwards, with a choice
 * of easing. Clicking replays it. It reads an image, or as a layer, the
 * layers beneath. Only the big squares weigh the picture's detail, the
 * sharp picture is a single read, and once a single decode finishes it stops
 * drawing altogether.
 *
 * https://ittybitty.dev/shaders/decode (MIT)
 */
import { mount, gradient } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} DecodeOptions
 * @property {boolean} showGaps Thin lines between the big squares.
 * @property {boolean} showFlash A brief lift of light as each square splits.
 * @property {boolean} showFinal Ends on the true picture. Off, it stays in tones.
 * @property {string} image The picture to decode. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'raw' | 'tones' | 'dithered'} style The picture's own colour, flat tones, or dithered tones through the palette.
 * @property {number} levels Tones from darkest to lightest.
 * @property {number} start Size of the first squares, in CSS pixels.
 * @property {number} duration Seconds from the first squares to the sharp picture.
 * @property {'linear' | 'in' | 'out' | 'in-out' | 'bounce'} easing How the decoding speeds up and slows down.
 * @property {'off' | 'restart' | 'reverse'} loop Decode once, start over, or run backwards and forwards.
 * @property {number} hold Seconds the sharp picture stays before the loop carries on.
 * @property {number} smart How much the picture's detail decides which squares split first, 0 to 1.
 * @property {number} scatter How randomly squares split within each size, 0 to 1.
 * @property {number} dot Dither dot size in CSS pixels. 0 scales the dots with the squares.
 * @property {boolean} interactive Clicking replays the decode.
 * @property {import('./runtime.js').Gradient} palette Tones from dark to light, for tones and dithered.
 */

/** @type {DecodeOptions} */
export const defaults = {
  showGaps: false,
  showFlash: true,
  showFinal: true,
  image: '',
  style: 'raw',
  levels: 4,
  start: 128,
  duration: 2.4,
  easing: 'linear',
  loop: 'restart',
  hold: 1.5,
  smart: 0.7,
  scatter: 0.4,
  dot: 0,
  interactive: true,
  palette: [
    [0, '#16131f'],
    [1, '#f2ede2'],
  ],
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uShowGaps;
uniform float uShowFlash;
uniform float uShowFinal;
uniform float uStyle;       // 0 raw, 1 tones, 2 dithered
uniform float uLevels;
uniform float uStart;       // CSS pixels
uniform float uDuration;
uniform float uEasing;      // 0 linear, 1 in, 2 out, 3 in-out, 4 bounce
uniform float uLoop;        // 0 off, 1 restart, 2 reverse
uniform float uHold;
uniform float uSmart;
uniform float uScatter;
uniform float uDot;         // CSS pixels, 0 scales with the squares
uniform float uClock;       // seconds since this run began
uniform float uReduced;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5; // OKLab colour, position

out vec4 fragColor;

// The picture being decoded; blur is the square's size in device pixels, so
// each square reads the picture's average over its area from the mipmaps.
// In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A soft sunset with a dark hill, so there is something to decode.
    vec3 c = mix(vec3(0.98, 0.62, 0.36), vec3(0.24, 0.2, 0.52), uv.y);
    c = mix(c, vec3(1.0, 0.92, 0.7), smoothstep(0.16, 0.1, length((uv - vec2(0.64, 0.55)) * vec2(uResolution.x / uResolution.y, 1.0))));
    c = mix(c, vec3(0.1, 0.09, 0.2), step(uv.y, 0.3 + 0.08 * sin(uv.x * 5.0 + 1.0)));
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  float texels = uImageSize.y * s.y / uResolution.y;
  return vec4(textureLod(uImage, (uv - 0.5) * s + 0.5, log2(max(blur * texels, 1.0))).rgb, 1.0);
}
// @end

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

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

float bounce(float x) {
  if (x < 1.0 / 2.75) return 7.5625 * x * x;
  if (x < 2.0 / 2.75) { x -= 1.5 / 2.75; return 7.5625 * x * x + 0.75; }
  if (x < 2.5 / 2.75) { x -= 2.25 / 2.75; return 7.5625 * x * x + 0.9375; }
  x -= 2.625 / 2.75;
  return 7.5625 * x * x + 0.984375;
}

float ease(float x) {
  if (uEasing < 0.5) return x;
  if (uEasing < 1.5) return x * x * x;
  if (uEasing < 2.5) return 1.0 - pow(1.0 - x, 3.0);
  if (uEasing < 3.5) return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5;
  return bounce(x);
}

// How far through decoding, 0 (first squares) to 1 (sharp).
float progress() {
  if (uReduced > 0.5) return 1.0;
  float t = uClock;
  float d = max(uDuration, 0.05);
  if (uLoop < 0.5) return ease(min(t / d, 1.0));
  if (uLoop < 1.5) return ease(min(mod(t, d + uHold) / d, 1.0));
  float a = mod(t, 2.0 * (d + uHold));
  return a < d + uHold ? ease(min(a / d, 1.0)) : 1.0 - ease(min((a - d - uHold) / d, 1.0));
}

// A square's colour in the chosen style; local is the position within the
// square. Scaled, a dithered square holds one 4×4 dither tile, so it still
// reads as a square and the dots shrink as the squares do; fixed, fine dots
// hold still across the page while the squares change beneath them.
vec3 styled(vec3 c, vec2 px, vec2 local, float size) {
  if (uStyle < 0.5) return c;
  float steps = max(uLevels - 1.0, 1.0);
  float v = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0) * steps;
  float threshold = 0.5;
  if (uStyle > 1.5) threshold = uDot > 0.0 ? bayer8(px / max(uDot * uPixelRatio, 1.0)) : bayer4(local / max(size * 0.25, uPixelRatio));
  float level = min(floor(v) + step(threshold, fract(v)), steps);
  return linearToSrgb(oklabToLinear(stops(level / steps)));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float p = progress();
  // Square sizes halve from the first, rounded to a power of two in CSS
  // pixels, down to 2; after the last split the picture is sharp. The grid
  // hangs from the top-left corner, so squares line up with the edges.
  float firstCss = exp2(max(floor(log2(max(uStart, 2.0)) + 0.5), 1.0));
  float n = log2(firstCss);
  float first = firstCss * uPixelRatio;
  vec2 corner0 = vec2(0.0, uResolution.y);
  vec2 axis = vec2(1.0, -1.0);
  vec2 q = (px - corner0) * axis;

  float size = 0.0;
  float born = 0.0;
  vec2 cell = vec2(0.0);
  if (p < 1.0) {
    size = first;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= n) break;
      cell = floor(q / size);
      // When this square splits: its place in the order of sizes, nudged
      // earlier where its two diagonal quarters differ, and scattered.
      float half_ = size * 0.5;
      vec2 corner = cell * size;
      // Only squares big enough for their order to show read the picture;
      // the small ones go by scatter alone.
      float detail = 0.5;
      if (uSmart > 0.0 && size >= 16.0) {
        vec3 a = source(corner0 + (corner + half_ * 0.5) * axis, half_).rgb;
        vec3 b = source(corner0 + (corner + half_ * 1.5) * axis, half_).rgb;
        detail = min(length(a - b) * 2.5, 1.0);
      }
      float nudge = uScatter * (hash13(vec3(cell, float(i) * 17.0)) - 0.5) + uSmart * (0.5 - detail);
      // Even steps: each size holds for the same time, and the sharp
      // picture arrives one step before the end.
      float splits = (float(i) + 1.0 + clamp(nudge, -0.49, 0.49)) / (n + 1.0);
      if (p < splits) break;
      born = splits;
      size = half_;
    }
  }

  // Ending on the true picture, the tones dissolve into its colour over the
  // last stretch rather than snapping to it.
  float colour = uShowFinal * smoothstep(0.7, 1.0, p);
  vec3 c;
  if (size < 1.5) {
    // Sharp: one read of the picture.
    c = source(px, 1.0).rgb;
    c = mix(styled(c, px, q, 1.0), c, colour);
  } else {
    cell = floor(q / size);
    vec2 f = q - cell * size;
    vec3 raw = source(corner0 + (cell + 0.5) * size * axis, size).rgb;
    c = mix(styled(raw, px, f, size), raw, colour);
    if (uShowGaps > 0.5 && size >= 8.0) {
      float edge = min(min(f.x, f.y), size - 1.0 - max(f.x, f.y));
      c *= edge < max(uPixelRatio, 1.0) ? 0.82 : 1.0;
    }
    // Each big square lifts a little as it appears, and settles; small ones
    // do not, or the last splits would sparkle like noise.
    c += uShowFlash * 0.14 * exp(-(p - born) * n * 9.0) * step(0.0001, born) * smoothstep(6.0, 40.0, size);
  }
  fragColor = vec4(c, 1.0);
}
`;

const STYLES = { raw: 0, tones: 1, dithered: 2 };
const EASINGS = { linear: 0, in: 1, out: 2, 'in-out': 3, bounce: 4 };
const LOOPS = { off: 0, restart: 1, reverse: 2 };

/** @type {import('./runtime.js').EffectSpec<DecodeOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 2,
  // Loops animate; a single decode drives itself and stops when sharp.
  speed: (o) => (o.loop === 'off' ? 0 : 1),
  update(o) {
    return {
      uShowGaps: o.showGaps,
      uShowFlash: o.showFlash,
      uShowFinal: o.showFinal,
      uStyle: STYLES[o.style] ?? 0,
      uLevels: o.levels,
      uStart: o.start,
      uDuration: o.duration,
      uEasing: EASINGS[o.easing] ?? 0,
      uLoop: LOOPS[o.loop] ?? 1,
      uHold: o.hold,
      uSmart: o.smart,
      uScatter: o.scatter,
      uDot: o.dot,
      ...gradient(o.palette),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The clock runs only while the effect draws, so a decode offscreen
    // waits for its canvas to come into view.
    let clock = 0;
    const down = (/** @type {PointerEvent} */ event) => {
      if (!ctx.options?.().interactive) return;
      const r = ctx.canvas.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
      clock = 0;
      ctx.invalidate();
    };
    addEventListener('pointerdown', down, { passive: true });
    return {
      update(o) {
        image.set(o.image);
        clock = 0;
      },
      frame(dt) {
        clock += dt;
        ctx.uniform('uClock', clock);
        ctx.uniform('uReduced', reduced);
        const o = /** @type {DecodeOptions | undefined} */ (ctx.options?.());
        if (!reduced && o?.loop === 'off' && clock < o.duration + 0.1) ctx.invalidate();
      },
      restore: image.restore,
      destroy() {
        removeEventListener('pointerdown', down);
        image.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<DecodeOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function decode(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
