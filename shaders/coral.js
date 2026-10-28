// @ts-check
/**
 * ittybitty/coral
 *
 * Coral: Gray–Scott reaction–diffusion growing living patterns across the
 * canvas, the way Turing imagined spots and stripes form. Two chemicals
 * spread at different rates and one feeds on the other; depending on how
 * fast it is fed and how fast it dies, the same few lines grow coral,
 * dividing cells, zebra stripes, mazes or worms. It starts from a handful of
 * seeds and never settles: the feed and kill rates drift slowly across the
 * canvas so different patterns meet, and now and then a patch is wiped or
 * reseeded so new growth fronts keep running. The pointer clears a path for
 * the pattern to grow back into, and pressing seeds new growth.
 *
 * The chemistry runs on a small grid (a few hundred cells across), stepped
 * several times a frame, and is then lit at full resolution with smooth
 * bicubic sampling: the concentration becomes a relief, shaded as enamel,
 * wet coral or embossed foil, coloured by a gradient.
 *
 * https://ittybitty.dev/shaders/coral (MIT)
 */
import { mount, gradient, linear, oklab } from './runtime.js';
import { pointer } from './pointer.js';

/** @typedef {[position: number, color: string][]} Stops */

/**
 * @typedef {object} CoralOptions
 * @property {'coral' | 'spots' | 'stripes' | 'maze' | 'worms' | 'mixed'} pattern Which pattern grows; mixed lets several meet across the canvas.
 * @property {number} speed How fast the pattern grows.
 * @property {number} scale Size of the features.
 * @property {Stops} colors Colour by concentration, from bare ground to the thickest growth.
 * @property {'flat' | 'enamel' | 'glossy' | 'embossed'} lighting How the growth is lit.
 * @property {number} relief How deep the relief looks under the light.
 * @property {number} glow A soft glow along the growing edges.
 * @property {number} evolve How restless it is: drifting patterns, patches wiped and reseeded.
 * @property {number} variation A different arrangement of seeds.
 * @property {boolean} interactive The pointer clears a path the pattern grows back into; pressing seeds new growth.
 * @property {number} brush Size of the pointer's brush.
 */

/** @type {CoralOptions} */
export const defaults = {
  pattern: 'coral',
  speed: 1,
  scale: 1,
  colors: [[0, '#0a1f2e'], [0.3, '#145a66'], [0.55, '#d9483a'], [0.8, '#ff8f6b'], [1, '#ffdcc4']],
  lighting: 'glossy',
  relief: 1,
  glow: 0,
  evolve: 0.5,
  variation: 0,
  interactive: true,
  brush: 1,
};

// Sim steps per second of effect time, at speed 1, and how many one frame may
// run (a seek may catch up further, once).
const RATE = 300;
const MAX_STEPS = 16;
const MAX_CATCH_UP = 2400;
// Steps run before the first frame, so it opens on growth, not dots; and
// where time stands still (reduced motion, a paused redraw), how far it may
// grow anyway, a little each frame, so the still frame shows a full pattern.
const WARM_UP = 420;
const STILL_GROWTH = 2400;
// CSS pixels per cell at scale 1, and the grid's limits on its long side.
const CELL = 3;
const MIN_CELLS = 96;
const MAX_CELLS = 512;

// Feed and kill rates for each pattern (Karl Sims's scheme: diffusion 1 and
// 0.5, unit time step), plus how strongly diffusion follows a swirling
// direction, which lines stripes up like a zebra's.
const PATTERNS = {
  coral: [0.0545, 0.062, 0],
  spots: [0.035, 0.064, 0],
  stripes: [0.026, 0.055, 0.8],
  maze: [0.029, 0.057, 0],
  worms: [0.05, 0.0635, 0],
  mixed: [0.0545, 0.062, 0],
};
const LIGHTING = { flat: 0, enamel: 1, glossy: 2, embossed: 3 };

const PASS_VERTEX = '#version 300 es\nvoid main(){vec2 p=vec2(gl_VertexID&1,gl_VertexID>>1)*4.0-1.0;gl_Position=vec4(p,0,1);}';

// Shared by the passes that read the chemistry. Each cell's A and B are half
// floats packed into one uint, and four cells across share a texel: a step
// then fetches three texels a row for four cells instead of three each, and
// an integer target renders on every device, with or without float targets.
const STATE = /* glsl */ `precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uState;
uniform vec2 uSize;        // the grid, in cells
ivec2 wrap(ivec2 c) { ivec2 s = ivec2(uSize); return (c + s) % s; }
vec2 S(ivec2 c) {
  c = wrap(c);
  return unpackHalf2x16(texelFetch(uState, ivec2(c.x >> 2, c.y), 0)[c.x & 3]);
}
// Half floats rounded towards zero, bit for bit as Apple GPUs store them in a
// half-float target: the rounding steers how fast the growth spreads, and
// the patterns were tuned on those. Every device now grows them alike.
uint toHalf(float f) {
  uint b = floatBitsToUint(f);
  uint e = (b >> 23) & 0xffu;
  if (e < 113u) return uint(f * 16777216.0);
  return ((e - 112u) << 10) | ((b & 0x7fffffu) >> 13);
}
uint E(vec2 v) { v = clamp(v, 0.0, 1.0); return toHalf(v.x) | (toHalf(v.y) << 16); }
float hash12(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
`;

// The starting state: clean ground with a scattering of small seeds.
const INIT = /* glsl */ `#version 300 es
${STATE}
uniform float uSeed;
out uvec4 o;
vec2 seeded(vec2 c) {
  // One chance of a seed per patch of about 26 cells, at a random spot in
  // it, with a ragged outline so growth branches instead of ringing out.
  float G = 26.0;
  vec2 cell = floor(c / G);
  vec2 off = vec2(uSeed * 17.13 + 31.7, uSeed * 7.31 + 57.3);
  float b = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = cell + vec2(i, j);
    if (hash12(g * 1.618 + off) > 0.5) continue;
    vec2 at = (g + 0.15 + 0.7 * vec2(hash12(g * 2.17 + off + 5.0), hash12(g * 3.03 + off + 9.0))) * G;
    vec2 dv = c - at;
    float ang = atan(dv.y, dv.x);
    float r = (3.0 + 4.0 * hash12(g + off + 2.0)) * (1.0 + 0.35 * sin(ang * 3.0 + 6.2832 * hash12(g + off)));
    b = max(b, smoothstep(r, r * 0.4, length(dv)) * (0.6 + 0.4 * hash12(c + off)));
  }
  return vec2(1.0 - 0.5 * b, 0.5 * b);
}
void main() {
  vec2 c = vec2(floor(gl_FragCoord.x) * 4.0 + 0.5, gl_FragCoord.y);
  o = uvec4(E(seeded(c)), E(seeded(c + vec2(1, 0))), E(seeded(c + vec2(2, 0))), E(seeded(c + vec2(3, 0))));
}`;

// Scale the state onto a grid of another size (on resize), nearest cell.
const COPY = /* glsl */ `#version 300 es
${STATE}
uniform vec2 uTo;
out uvec4 o;
void main() {
  vec2 c = vec2(floor(gl_FragCoord.x) * 4.0 + 0.5, gl_FragCoord.y);
  uvec4 r;
  for (int k = 0; k < 4; k++) r[k] = E(S(ivec2((c + vec2(k, 0)) / uTo * uSize)));
  o = r;
}`;

// One step of Gray–Scott, for the four cells of a texel. It is built in
// variants (see stepSource): one per kind of pattern, each with and without
// the brush, rather than branching on uniforms, since a software renderer
// runs every branch whichever way it goes.
const STEP = /* glsl */ `${STATE}
uniform vec4 uFK;          // feed, kill, anisotropy, spatial variety
uniform float uT;          // slow clock for the drifting rates
uniform vec2 uPeriod;      // noise periods across and up, so the wrap is seamless
uniform vec4 uBrush;       // from, to, in cells
uniform vec2 uBrushP;      // radius in cells, mode: 1 seeds, -1 erodes, 0 off
uniform vec4 uDrop;        // centre in cells, radius, mode
out uvec4 o;

// Value noise that tiles over the grid, so the wrapped edges never show.
float vnoise(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 i1 = mod(i + 1.0, period);
  i = mod(i, period);
  return mix(mix(hash12(i), hash12(vec2(i1.x, i.y)), u.x), mix(hash12(vec2(i.x, i1.y)), hash12(i1), u.x), u.y);
}

void stamp(inout vec2 v, float d, float r, float mode, float n) {
  float s = smoothstep(r, r * 0.55, d);
  // Seeding clears the ground and scatters fresh specks, so new growth
  // blooms outwards even inside an established pattern; eroding just clears.
  float speck = step(0.92, n);
  vec2 to = mode > 0.5 ? vec2(1.0 - 0.5 * speck, 0.5 * speck) : vec2(1.0, 0.0);
  v = mix(v, to, s);
}

// The cell at c, from its 3x3 neighbourhood: the row below (b0, b1, b2), its
// own row (m0, v, m2) and the row above (a0, a1, a2). Plain arguments rather
// than an array: software renderers keep arrays in memory, and pay for it.
vec2 react(vec2 b0, vec2 b1, vec2 b2, vec2 m0, vec2 v, vec2 m2, vec2 a0, vec2 a1, vec2 a2, ivec2 c) {
  // Karl Sims's 3x3 Laplacian: 0.2 for edges, 0.05 for corners.
  vec2 lap = 0.2 * (b1 + m0 + m2 + a1) + 0.05 * (b0 + b2 + a0 + a2) - v;

  vec2 p = vec2(c) + 0.5;
  vec2 uv = p / uSize;
  vec2 q = uv * uPeriod;
  float slow = uT;
  float n1 = vnoise(q + vec2(slow, -0.7 * slow), uPeriod);
  float n2 = vnoise(q * 2.0 + vec2(-0.6 * slow, slow) + 7.0, uPeriod * 2.0);
  vec2 fk = uFK.xy;
#if MIXED
  {
    // Wander along the living band of the feed–kill map: maze, coral, worms,
    // with dividing spots branching off; the boundaries between them grow
    // stranger things still.
    float x = clamp(n1 * 1.5 - 0.25, 0.0, 1.0) * 2.0;
    vec2 a = mix(vec2(0.029, 0.057), vec2(0.0545, 0.062), clamp(x, 0.0, 1.0));
    a = mix(a, vec2(0.05, 0.0635), clamp(x - 1.0, 0.0, 1.0));
    fk = mix(a, vec2(0.035, 0.064), smoothstep(0.62, 0.8, n2) * 0.9);
  }
#else
  // Stripes sit close to where the growth floods solid, so they vary less.
  fk += uFK.w * (1.0 - 0.8 * uFK.z) * vec2(0.004, 0.0012) * (vec2(n1, n2) - 0.5);
#endif

  // Stripes: diffusion stronger along a slowly swirling direction, sampled
  // between the neighbours already fetched.
#if STRIPES
  {
    vec2 pd = max(floor(uPeriod * 0.8), 1.0);
    float th = 6.2832 * vnoise(uv * pd + 3.0 + 0.3 * slow, pd);
    vec2 d = vec2(cos(th), sin(th));
    vec2 ad = abs(d);
    bool l = d.x < 0.0, u = d.y >= 0.0;
    vec2 fwd = mix(mix(v, l ? m0 : m2, ad.x), u ? mix(a1, l ? a0 : a2, ad.x) : mix(b1, l ? b0 : b2, ad.x), ad.y);
    vec2 bwd = mix(mix(v, l ? m2 : m0, ad.x), u ? mix(b1, l ? b2 : b0, ad.x) : mix(a1, l ? a2 : a0, ad.x), ad.y);
    lap = mix(lap, 0.5 * (fwd + bwd - 2.0 * v), uFK.z);
    // With diffusion this lopsided, growth can flood into a solid sheet that
    // never breaks up again. A sheet is thick all around, where a stripe is
    // not: there, kill a little faster until it splits into stripes.
    // (Eight cells four away, round the compass.)
    float far = S(c + ivec2(4, 0)).y + S(c + ivec2(3, 3)).y + S(c + ivec2(0, 4)).y + S(c + ivec2(-3, 3)).y
      + S(c + ivec2(-4, 0)).y + S(c + ivec2(-3, -3)).y + S(c + ivec2(0, -4)).y + S(c + ivec2(3, -3)).y;
    fk.y += 0.012 * smoothstep(0.24, 0.3, far / 8.0) * smoothstep(0.24, 0.3, v.y);
  }
#endif

  float a = v.x, b = v.y;
  float abb = a * b * b;
  a += 1.0 * lap.x - abb + fk.x * (1.0 - a);
  b += 0.5 * lap.y + abb - (fk.y + fk.x) * b;
  v = vec2(a, b);

#if TOUCH
  if (uBrushP.y != 0.0) {
    vec2 pa = p - uBrush.xy, ba = uBrush.zw - uBrush.xy;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    stamp(v, length(pa - ba * t), uBrushP.x, uBrushP.y, hash12(p + uT * 91.0));
  }
  if (uDrop.w != 0.0) {
    vec2 dd = abs(p - uDrop.xy);
    dd = min(dd, uSize - dd);
    stamp(v, length(dd), uDrop.z, uDrop.w, hash12(floor(p / 3.0) + uDrop.xy));
  }
#endif
  return v;
}

vec2 U(uint u) { return unpackHalf2x16(u); }

void main() {
  // This texel's four cells read six cells across in each of three rows:
  // the last of the texel to the left, these four, and the first of the
  // texel to the right. The grid is a whole number of texels across, so the
  // wrap lands on whole texels too.
  ivec2 t = ivec2(gl_FragCoord.xy);
  int tw = int(uSize.x) >> 2, th = int(uSize.y);
  int xl = t.x == 0 ? tw - 1 : t.x - 1, xr = t.x == tw - 1 ? 0 : t.x + 1;
  int yb = t.y == 0 ? th - 1 : t.y - 1, ya = t.y == th - 1 ? 0 : t.y + 1;
  uvec4 m = texelFetch(uState, ivec2(t.x, yb), 0);
  vec2 b0 = U(texelFetch(uState, ivec2(xl, yb), 0).w), b1 = U(m.x), b2 = U(m.y), b3 = U(m.z), b4 = U(m.w);
  vec2 b5 = U(texelFetch(uState, ivec2(xr, yb), 0).x);
  m = texelFetch(uState, t, 0);
  vec2 m0 = U(texelFetch(uState, ivec2(xl, t.y), 0).w), m1 = U(m.x), m2 = U(m.y), m3 = U(m.z), m4 = U(m.w);
  vec2 m5 = U(texelFetch(uState, ivec2(xr, t.y), 0).x);
  m = texelFetch(uState, ivec2(t.x, ya), 0);
  vec2 a0 = U(texelFetch(uState, ivec2(xl, ya), 0).w), a1 = U(m.x), a2 = U(m.y), a3 = U(m.z), a4 = U(m.w);
  vec2 a5 = U(texelFetch(uState, ivec2(xr, ya), 0).x);
  ivec2 c = ivec2(t.x * 4, t.y);
  o = uvec4(
    E(react(b0, b1, b2, m0, m1, m2, a0, a1, a2, c)),
    E(react(b1, b2, b3, m1, m2, m3, a1, a2, a3, c + ivec2(1, 0))),
    E(react(b2, b3, b4, m2, m3, m4, a2, a3, a4, c + ivec2(2, 0))),
    E(react(b3, b4, b5, m3, m4, m5, a3, a4, a5, c + ivec2(3, 0))));
}`;

// The concentration as a relief, ready to light: height, a soft halo where
// the feed is used up, and the slope of a blurred height, so ridges read as
// rounded tubes rather than flat plateaus. It filters smoothly, and mipmaps
// for the glow.
const VIEW = /* glsl */ `#version 300 es
${STATE}
out vec4 o;
float H(vec2 v) { return clamp(v.y * 2.9, 0.0, 1.0); }
float H(uint u) { return H(unpackHalf2x16(u)); }
// The slope below is the derivative of a 5x5 binomial blur, taken every
// other cell so it spans nine: wide enough to round a whole ridge over. This
// is one row of it, dy away, weighted wj across and dwj up. Its five taps,
// every other cell from four before c to four after, always lie in the
// texel holding c and the two either side: three fetches, not five.
vec2 row(ivec2 c, int dy, float wj, float dwj) {
  int tw = int(uSize.x) >> 2, m = c.x >> 2;
  int y = wrap(ivec2(0, c.y + dy)).y;
  uvec4 t0 = texelFetch(uState, ivec2(m == 0 ? tw - 1 : m - 1, y), 0);
  uvec4 t1 = texelFetch(uState, ivec2(m, y), 0);
  uvec4 t2 = texelFetch(uState, ivec2(m == tw - 1 ? 0 : m + 1, y), 0);
  bool odd = (c.x & 1) == 1, late = (c.x & 2) == 2;
  uvec2 a = odd ? t0.yw : t0.xz, b = odd ? t1.yw : t1.xz, d = odd ? t2.yw : t2.xz;
  uvec4 r = late ? uvec4(a.y, b, d.x) : uvec4(a, b);
  float h0 = H(r.x), h1 = H(r.y), h2 = H(r.z), h3 = H(r.w), h4 = H(late ? d.y : d.x);
  // Weights 1 4 6 4 1 one way, and -1 -2 0 2 1 the other.
  return vec2(wj * (2.0 * (h3 - h1) + h4 - h0), dwj * (h0 + 4.0 * (h1 + h3) + 6.0 * h2 + h4));
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 g = row(c, -4, 1.0, -1.0) + row(c, -2, 4.0, -2.0) + row(c, 0, 6.0, 0.0) + row(c, 2, 4.0, 2.0) + row(c, 4, 1.0, 1.0);
  g /= 256.0;
  vec2 v = S(c);
  float near = H(S(c + ivec2(1, 0))) + H(S(c + ivec2(-1, 0))) + H(S(c + ivec2(0, 1))) + H(S(c + ivec2(0, -1)));
  float h = 0.5 * H(v) + 0.125 * near;
  o = vec4(h, clamp(1.0 - v.x, 0.0, 1.0), clamp(g * 0.5 + 0.5, 0.0, 1.0));
  // Rounded as a half-float target on an Apple GPU stores it, whichever
  // format holds it here, so the relief lights the same everywhere.
  vec4 tiny = floor(o * 16777216.0) / 16777216.0;
  o = mix(uintBitsToFloat(floatBitsToUint(o) & 0xffffe000u), tiny, lessThan(o, vec4(6.103515625e-5)));
}`;

/**
 * The step for a kind of pattern ('plain', 'mixed' or 'stripes'), with the
 * brush and drops (touch) or without.
 * @param {string} kind @param {boolean} touch
 */
const stepSource = (kind, touch) =>
  `#version 300 es\n#define MIXED ${kind === 'mixed' ? 1 : 0}\n#define STRIPES ${kind === 'stripes' ? 1 : 0}\n#define TOUCH ${touch ? 1 : 0}\n${STEP}`;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uView;
uniform vec2 uViewSize;
uniform float uReady;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5;
uniform float uLighting;    // 0 flat, 1 enamel, 2 glossy, 3 embossed
uniform float uRelief;
uniform float uGlow;
uniform vec3 uGlowColor;   // OKLab

out vec4 fragColor;

float hash12(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

// Unrolled: unused stops repeat the last colour, so no loop is needed.
vec3 ramp(float x) {
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
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Cubic B-spline from four bilinear taps (Sigg and Hadwiger): smooth curves
// from a coarse grid, without the blockiness of plain filtering.
vec4 bicubic(vec2 uv) {
  vec2 p = uv * uViewSize - 0.5;
  vec2 i = floor(p), f = p - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / uViewSize;
  vec2 h1 = (i + 1.5 + w3 / g1) / uViewSize;
  return g0.y * (g0.x * texture(uView, h0) + g1.x * texture(uView, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(uView, vec2(h0.x, h1.y)) + g1.x * texture(uView, h1));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float grain = hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5;
  if (uReady < 0.5) {
    fragColor = vec4(linearToSrgb(oklabToLinear(ramp(0.0))) + grain / 255.0, 1.0);
    return;
  }
  vec4 v = bicubic(uv);
  float h = v.r;
  vec2 g = (v.ba - 0.5) * 2.0;
  float slope = length(g);
  // Slope per cell, steepened by relief: the grid's size on screen does not
  // matter, so every scale reads with the same depth.
  vec3 n = normalize(vec3(-g * (6.5 * uRelief), 1.0));
  vec3 base = max(oklabToLinear(ramp(h)), 0.0);
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 r = reflect(-V, n);
  // Ambient occlusion: ground hemmed in by growth sits in its shadow, more
  // so where the growth has drained the feed around it.
  float near = textureLod(uView, uv, 2.5).r;
  float ao = 1.0 - min(uRelief, 1.5) * (1.0 - smoothstep(0.0, 0.55, h)) * (0.45 * smoothstep(0.1, 0.6, near) + 0.2 * v.g);
  vec3 col = base;
  if (uLighting > 2.5) {
    // Embossed foil: metallic, lit low from the top left, so highlights take
    // the colour; a cool fill from the far side keeps shadowed walls alive.
    vec3 L = normalize(vec3(-0.55, 0.6, 0.58));
    float nl = dot(n, L), rl = max(dot(r, L), 0.0);
    col = base * (0.22 + 0.95 * max(nl, 0.0)) * ao;
    col += base * (0.9 * pow(rl, 10.0) + 2.2 * pow(rl, 60.0));
    col += vec3(1.0, 0.96, 0.88) * 0.35 * pow(rl, 300.0);
    col += base * 0.2 * max(-nl, 0.0) * vec3(0.7, 0.8, 1.0);
  } else if (uLighting > 1.5) {
    // Glossy and wet: the body colour under a clear skin, a window-shaped
    // highlight and a sky that brightens at grazing angles.
    vec3 L = normalize(vec3(-0.4, 0.5, 0.8));
    float nl = dot(n, L), rl = max(dot(r, L), 0.0);
    float diff = 0.45 + 0.55 * max(nl, 0.0);
    col = base * diff * ao * 1.1;
    float wet = smoothstep(0.15, 0.55, h);
    float fres = 0.02 + 0.98 * pow(1.0 - max(n.z, 0.0), 5.0);
    vec3 sky = mix(vec3(0.3, 0.38, 0.5), vec3(1.25), smoothstep(-0.4, 0.7, r.y - 0.3 * r.x));
    col += sky * fres * (0.25 + 0.75 * wet);
    col += vec3(1.0) * (1.0 * smoothstep(0.86, 0.97, rl) + 0.25 * pow(rl, 10.0)) * wet;
  } else if (uLighting > 0.5) {
    // Enamel: soft wrapped light, a broad porcelain sheen, and light passing
    // through the thin walls of each ridge.
    vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
    float nl = dot(n, L), rl = max(dot(r, L), 0.0);
    col = base * (0.62 + 0.38 * nl) * mix(1.0, ao, 0.7);
    col += vec3(1.0, 0.97, 0.93) * (0.12 * pow(rl, 6.0) + 0.6 * pow(rl, 60.0)) * smoothstep(0.1, 0.4, h);
    col += base * base * 0.6 * smoothstep(0.1, 0.5, slope) * (1.0 - h);
  }
  // Glow: light along the growing edges, and a soft halo around the growth.
  if (uGlow > 0.0) {
    float edge = smoothstep(0.04, 0.3, slope);
    float halo = textureLod(uView, uv, 3.0).r;
    vec3 gc = max(oklabToLinear(uGlowColor), 0.0);
    col += uGlow * (edge * edge * mix(base, gc, 0.6) * 1.4 + halo * halo * gc * 0.18);
  }
  // A soft shoulder, so highlights burn to white instead of clipping.
  col = col / (1.0 + max(col - 0.9, 0.0) * 0.9);
  fragColor = vec4(linearToSrgb(col) + grain * (1.5 / 255.0), 1.0);
}
`;

/** The lightest colour in the gradient, in OKLab: the glow's colour. @param {Stops} stops */
const brightest = (stops) => {
  let best = [0, 0, 0];
  for (const [, hex] of stops) {
    const lab = oklab(linear(hex));
    if (lab[0] >= best[0]) best = lab;
  }
  return best;
};

/**
 * Whether the context renders in software (SwiftShader, llvmpipe).
 * @param {WebGL2RenderingContext} gl
 */
function software(gl) {
  let name = String(gl.getParameter(gl.RENDERER));
  if (name === 'WebKit WebGL') {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  }
  return /swiftshader|llvmpipe|softpipe|software/i.test(name);
}

const hash = (/** @type {number} */ n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** @type {import('./runtime.js').EffectSpec<CoralOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 1.5,
  speed: (o) => o.speed,
  update(o) {
    return {
      ...gradient(o.colors),
      uLighting: LIGHTING[o.lighting] ?? 2,
      uRelief: o.lighting === 'flat' ? 0 : o.relief,
      uGlow: o.glow,
      uGlowColor: brightest(o.colors),
    };
  },
  attach(ctx) {
    const { gl, canvas } = ctx;
    const pt = pointer(ctx, { ease: 14 });
    const units = { state: ctx.textureUnit(2), view: ctx.textureUnit(1) };
    /** @type {Record<string, WebGLProgram | null>} */
    let prog = {};
    /** @type {Record<string, Record<string, WebGLUniformLocation | null>>} */
    let loc = {};
    let ok = false;
    let viewFormat = 0;
    /** @type {(WebGLTexture | null)[]} */
    let tex = [null, null, null];
    /** @type {(WebGLFramebuffer | null)[]} */
    let fbo = [null, null, null];
    let cur = 0, gw = 0, gh = 0, viewLevels = 1;
    let fresh = true;
    let warm = 0;
    let grown = 0;
    let lastTime = -1;
    let owed = 0;
    let dropClock = 0.6;
    let drops = 0;
    let seed = -1;
    // This frame's step uniforms: period, feed and kill (4), clock, brush
    // (4 + 2) and drop (4); set on whichever variant of the step runs.
    const su = new Float32Array(16);
    // The brush: last position seen, and a press waiting to bloom.
    const last = [0, 0];
    const viewSize = new Float32Array(2);
    let had = false;
    let bloom = false;

    const program = (/** @type {string} */ src, /** @type {string} */ name) => {
      const sh = (/** @type {number} */ t, /** @type {string} */ s) => { const x = /** @type {WebGLShader} */ (gl.createShader(t)); gl.shaderSource(x, s); gl.compileShader(x); return x; };
      const p = /** @type {WebGLProgram} */ (gl.createProgram());
      const v = sh(gl.VERTEX_SHADER, PASS_VERTEX), f = sh(gl.FRAGMENT_SHADER, src);
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        if (!gl.isContextLost()) console.warn(`coral ${name}:`, gl.getShaderInfoLog(f));
        gl.deleteShader(v); gl.deleteShader(f);
        return null;
      }
      gl.deleteShader(v); gl.deleteShader(f);
      return p;
    };
    const L = (/** @type {string} */ p, /** @type {string} */ n) => (loc[p][n] ??= gl.getUniformLocation(/** @type {WebGLProgram} */ (prog[p]), n));

    /** A grid-sized texture and its framebuffer; false if it cannot be drawn to. */
    const target = (/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ format, /** @type {boolean} */ linear, levels = 1) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + units.state);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      return { t, f, complete };
    };

    const release = () => {
      for (const t of tex) if (t) gl.deleteTexture(t);
      for (const f of fbo) if (f) gl.deleteFramebuffer(f);
      tex = [null, null, null];
      fbo = [null, null, null];
      gw = gh = 0;
    };

    const build = () => {
      // The chemistry is integer, which every device renders. The relief is
      // filtered: in full floats for a software renderer, which filters those
      // far faster (a GPU is the other way round); otherwise in half floats
      // where the device renders them, and RGBA8 where it does not.
      const full = software(gl) && gl.getExtension('EXT_color_buffer_float') && gl.getExtension('OES_texture_float_linear');
      const half = full || gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
      viewFormat = full ? gl.RGBA32F : half ? gl.RGBA16F : gl.RGBA8;
      prog = { init: program(INIT, 'init'), copy: program(COPY, 'copy'), view: program(VIEW, 'view') };
      loc = { init: {}, copy: {}, view: {} };
      ok = !!(prog.init && prog.copy && prog.view);
      fresh = true;
    };

    /** The step for a kind of pattern, with or without the brush, built the first time it is needed; '' if it will not build. */
    const stepFor = (/** @type {string} */ kind, /** @type {boolean} */ touch) => {
      const name = `${touch ? 'touch' : 'step'}-${kind}`;
      if (!(name in prog)) {
        prog[name] = program(stepSource(kind, touch), name);
        loc[name] = {};
      }
      return prog[name] ? name : '';
    };

    /** Ready a step program with this frame's uniforms. */
    const prepare = (/** @type {string} */ name) => {
      use(name, gw, gh);
      gl.uniform2f(L(name, 'uPeriod'), su[0], 3);
      gl.uniform4f(L(name, 'uFK'), su[1], su[2], su[3], su[4]);
      gl.uniform1f(L(name, 'uT'), su[5]);
      gl.uniform4f(L(name, 'uBrush'), su[6], su[7], su[8], su[9]);
      gl.uniform2f(L(name, 'uBrushP'), su[10], su[11]);
      gl.uniform4f(L(name, 'uDrop'), su[12], su[13], su[14], su[15]);
    };

    /** Point a program at the state texture `from`, ready to draw. */
    const use = (/** @type {string} */ name, /** @type {number} */ w, /** @type {number} */ h) => {
      gl.useProgram(prog[name]);
      gl.uniform1i(L(name, 'uState'), units.state);
      gl.uniform2f(L(name, 'uSize'), w, h);
    };

    /** (Re)size the grid to the canvas, carrying the pattern over. */
    const size = (/** @type {CoralOptions} */ o) => {
      const cw = canvas.clientWidth || canvas.width || 1, ch = canvas.clientHeight || canvas.height || 1;
      const long = Math.max(cw, ch);
      const cells = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(long / (CELL * o.scale))));
      // A whole number of texels across, four cells each.
      const w = 4 * Math.max(2, Math.round((cw >= ch ? cells : (cells * cw) / ch) / 4));
      const h = Math.max(8, Math.round(cw >= ch ? (cells * ch) / cw : cells));
      if (w === gw && h === gh && tex[0]) return true;
      const a = target(w / 4, h, gl.RGBA32UI, false), b = target(w / 4, h, gl.RGBA32UI, false);
      viewLevels = Math.max(1, Math.min(5, Math.floor(Math.log2(Math.min(w, h))) + 1));
      const v = target(w, h, viewFormat, true, viewLevels);
      if (!a.complete || !b.complete || !v.complete) {
        for (const x of [a, b, v]) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); }
        ok = false;
        return false;
      }
      if (tex[0] && !fresh) {
        // Carry the pattern over to the new grid.
        use('copy', gw, gh);
        gl.uniform2f(L('copy', 'uTo'), w, h);
        gl.activeTexture(gl.TEXTURE0 + units.state);
        gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.f);
        gl.viewport(0, 0, w / 4, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else fresh = true;
      release();
      tex = [a.t, b.t, v.t];
      fbo = [a.f, b.f, v.f];
      cur = 0;
      gw = w;
      gh = h;
      return true;
    };

    const down = (/** @type {PointerEvent} */ e) => {
      if (!pt.over || e.button > 0) return;
      bloom = true;
      ctx.invalidate();
    };
    addEventListener('pointerdown', down, { passive: true });

    build();

    return {
      update(o) {
        const s = Math.round(o.variation);
        if (seed !== -1 && s !== seed) fresh = true;
        seed = s;
      },
      frame(dt, time) {
        pt.frame(dt);
        const o = /** @type {CoralOptions} */ (ctx.options?.() ?? defaults);
        if (!ok) { ctx.uniform('uReady', 0); return; }
        const effect = gl.getParameter(gl.CURRENT_PROGRAM);
        if (!size(o)) { ctx.uniform('uReady', 0); gl.useProgram(effect); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); return; }
        // The chemistry's passes draw a texel for every four cells across.
        gl.viewport(0, 0, gw / 4, gh);
        gl.activeTexture(gl.TEXTURE0 + units.state);

        // How many steps this frame owes: effect time, so speed and seeking
        // both carry through; a jump forward catches up in one go.
        let steps = 0;
        const d = lastTime < 0 ? 0 : time - lastTime;
        lastTime = time;
        if (fresh) {
          use('init', gw, gh);
          gl.uniform1f(L('init', 'uSeed'), Math.round(o.variation));
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[0]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          cur = 0;
          fresh = false;
          warm = WARM_UP;
          grown = 0;
          owed = 0;
        }
        if (d > 0.25) steps = Math.min(MAX_CATCH_UP, Math.round(d * RATE));
        else if (d > 0) {
          owed += d * RATE;
          steps = Math.min(MAX_STEPS, Math.floor(owed));
          owed = Math.min(owed - steps, 1);
        } else if (d === 0 && grown < STILL_GROWTH) {
          steps = Math.min(120, STILL_GROWTH - grown);
          ctx.invalidate();
        }
        steps += warm;
        warm = 0;
        grown += steps;

        if (steps > 0) {
          const pat = PATTERNS[o.pattern] ?? PATTERNS.coral;
          const kind = o.pattern === 'mixed' ? 'mixed' : pat[2] > 0 ? 'stripes' : 'plain';
          su[0] = Math.max(1, Math.round((3 * gw) / gh));
          su[1] = pat[0];
          su[2] = pat[1];
          su[3] = pat[2];
          su[4] = o.evolve;
          su[5] = time * (0.004 + 0.02 * o.evolve);
          // The brush: from where the pointer was to where it is, in cells.
          const tx = pt.target[0] * gw, ty = pt.target[1] * gh;
          const brushR = 14 * o.brush * Math.min(1.6, Math.max(0.8, gh / 260));
          let mode = 0;
          if (o.interactive && pt.over) {
            const moved = had && Math.hypot(tx - last[0], ty - last[1]) > 0.05;
            if (moved) mode = -1;
          }
          if (!had || !o.interactive || !pt.over) { last[0] = tx; last[1] = ty; }
          had = pt.over;
          su[6] = last[0];
          su[7] = last[1];
          su[8] = tx;
          su[9] = ty;
          su[10] = brushR * 0.8;
          su[11] = mode;
          last[0] = tx;
          last[1] = ty;
          // Restlessness: now and then a patch is wiped or reseeded.
          dropClock += Math.max(0, Math.min(d, 0.25)) * o.evolve * 0.9;
          let drop = false;
          su[12] = su[13] = su[14] = su[15] = 0;
          if (bloom && o.interactive && pt.over) {
            // A press: a bloom of new growth under the pointer.
            su[12] = tx;
            su[13] = ty;
            su[14] = brushR * 1.3;
            su[15] = 1;
            drop = true;
          } else if (dropClock >= 1) {
            dropClock -= 1;
            drops++;
            const k = drops + Math.round(o.variation) * 101;
            su[12] = hash(k + 0.1) * gw;
            su[13] = hash(k + 0.2) * gh;
            su[14] = (0.05 + 0.07 * hash(k + 0.3)) * Math.min(gw, gh);
            su[15] = drops % 3 === 0 ? 1 : -1;
            drop = true;
          }
          bloom = false;
          // The brush runs every step while it moves; a drop, the first only.
          // Otherwise the step without them, which is cheaper.
          const quiet = stepFor(kind, false), touched = stepFor(kind, true);
          if (!quiet || !touched) { ok = false; ctx.uniform('uReady', 0); gl.useProgram(effect); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); return; }
          let current = '';
          for (let i = 0; i < steps; i++) {
            const name = mode !== 0 || (drop && i === 0) ? touched : quiet;
            if (name !== current) {
              if (i > 0) su[12] = su[13] = su[14] = su[15] = 0;
              prepare(name);
              current = name;
            } else if (i === 1 && drop) gl.uniform4f(L(name, 'uDrop'), 0, 0, 0, 0);
            gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - cur]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            cur = 1 - cur;
          }
        }

        // The relief to light, with mipmaps for the glow.
        use('view', gw, gh);
        gl.viewport(0, 0, gw, gh);
        gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0 + units.view);
        gl.bindTexture(gl.TEXTURE_2D, tex[2]);
        if (viewLevels > 1) gl.generateMipmap(gl.TEXTURE_2D);
        gl.activeTexture(gl.TEXTURE0);

        gl.useProgram(effect);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        ctx.sampler('uView', units.view);
        viewSize[0] = gw;
        viewSize[1] = gh;
        ctx.uniform('uViewSize', viewSize);
        ctx.uniform('uReady', 1);
      },
      restore() {
        tex = [null, null, null];
        fbo = [null, null, null];
        gw = gh = 0;
        lastTime = -1;
        build();
      },
      destroy() {
        removeEventListener('pointerdown', down);
        pt.destroy();
        release();
        for (const k in prog) if (prog[k]) gl.deleteProgram(prog[k]);
        ok = false;
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<CoralOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function coral(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
