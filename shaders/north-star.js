// @ts-check
/**
 * ittybitty/north-star
 *
 * North Star: lava-lamp blobs of colour drifting through a long-exposure
 * light leak, after the gradient atmospheres of Cohere's visual identity:
 * soft bodies that rise, bud and melt into one another, smeared along a
 * flowing direction, with bloom, fine light streaks and a film grain. In
 * focus a blob holds a crisp, oily edge; out of focus it melts into the
 * gradient around it. Every colour comes from one ordered palette, blended
 * in OKLCH, so neighbours meet through light rather than mud.
 *
 * Four passes keep it cheap: the lava field at half resolution in the flow's
 * own frame, a blur along the flow for the long exposure, a quarter-
 * resolution pass for everything smooth (ripple, bloom, streaks, leaks), and
 * a full-resolution composite for grain, stipple and colour fringing. The
 * blobs' motion is worked out once per frame on the CPU, and the field is
 * redrawn every other frame: the lava moves slowly enough that no one sees.
 *
 * https://ittybitty.dev/shaders/north-star (MIT)
 */
import { mount, linear, oklab } from './runtime.js';

/** @typedef {[position: number, color: string][]} Stops */

/**
 * @typedef {object} NorthStarOptions
 * @property {Stops} colors The palette, from cool to hot. Stops placed very close together meet with a hard, oily edge.
 * @property {number} bias Where the background sits on the palette: higher is warmer, and new blobs are born warmer too.
 * @property {number} speed How fast the lava moves.
 * @property {number} angle Direction of the flow, in degrees.
 * @property {number} stretch How far the light is drawn out along the flow.
 * @property {number} blobs How many blobs float through.
 * @property {number} size Size of the blobs.
 * @property {number} wobble How irregular and changing the blobs' outlines are.
 * @property {number} focus How much blobs away from the focal plane blur.
 * @property {number} smear Length of the long-exposure smear.
 * @property {number} glow Bloom around the brightest light.
 * @property {number} grain Strength of the film grain.
 * @property {number} variation A different arrangement of blobs and streaks.
 * @property {boolean} showStreaks Fine streaks of light along the flow.
 * @property {number} streaks Strength of the light streaks.
 * @property {boolean} showLeaks Warm flares drifting in from the edges.
 * @property {number} leaks Strength of the light leaks.
 * @property {boolean} showLens Lens character: ripple, colour fringing and scattered grain.
 * @property {number} distortion How much the light ripples, as if seen through moving glass.
 * @property {boolean} showBands Broad bands of colour across the flow, behind the blobs.
 * @property {number} bend How much the bands bend and sway along the flow.
 */

/** @type {NorthStarOptions} */
export const defaults = {
  colors: [
    [0, '#0b6a80'], [0.1, '#1a8fd0'], [0.2, '#2cc6e0'], [0.31, '#c7f1c5'], [0.42, '#f6f6f2'], [0.5, '#f6f4ee'], [0.56, '#f8f6ac'],
    [0.63, '#f9c1a0'], [0.7, '#fa915e'], [0.79, '#f7170a'], [0.88, '#f61a0a'], [0.9, '#d8e6b0'], [0.91, '#0f1f19'],
  ],
  bias: 0.24,
  speed: 0.5,
  angle: -41,
  stretch: 3.6,
  blobs: 14,
  size: 0.25,
  wobble: 0.24,
  focus: 0.45,
  smear: 0.25,
  glow: 0.12,
  grain: 0.035,
  variation: 2,
  showStreaks: true,
  streaks: 0.18,
  showLeaks: true,
  leaks: 0.2,
  showLens: true,
  distortion: 0.088,
  showBands: true,
  bend: 1,
};

// Stops this close or closer meet with a hard, oily edge rather than a blend.
const HARD_GAP = 0.021;
// The background bias the hard run's rarity is tuned at.
const POOL_BIAS = 0.24;
// How the field's values spread across the palette: fitted so the colours
// cover the frame in the same proportions as the look this was tuned to.
const MAP_IN = [-0.4803, -0.0246, 0.129, 0.293, 0.3963, 0.4458, 0.504, 0.5569, 0.6115, 0.6494, 0.6913, 0.7363, 0.7808, 0.8304, 0.8935, 1.2939];
const MAP_OUT = [0, 0.132, 0.172, 0.244, 0.272, 0.34, 0.372, 0.404, 0.5, 0.53, 0.564, 0.604, 0.634, 0.734, 0.786, 0.916];

// Fixed character: the parts of the look that are not options.
const RIPPLE_SCALE = 3.07;
const SWAY = 0.42;
const BASE = [-0.5, 0, 0.56]; // background: tilt across, tilt along, band strength
const SPREAD = 0.36;
const LOBES = 1.21;
const LIFE = 0.074;
const SHARP = 0.006;
const FOCUS_SPEED = 0.09;
const CHROMA = 1.15;
const BLOOM_SOFT = 0.12;
const BLOOM_THRESHOLD = 0.65;
const HALATION = 0.2;
const STREAK_COUNT = 4;
const STREAK_WIDTH = 0.03;
const STREAK_LENGTH = 0.6;
const LEAK_SIZE = 0.5;
const LEAK_SPEED = 0.06;
const LEAK_WARMTH = 0.6;
const STIPPLE = [1.6, 0.55, 0.72]; // patch scale, mask low, mask high
const DIFFUSION = 0.006;
const FRINGING = 0.006;
const CLARITY = 0.9;
const FIELD_SCALE = 0.5;
const FIELD_EVERY = 2;
const N = 14;

const COMMON = /* glsl */ `#version 300 es
precision highp float;
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float hash12(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// Field storage: OKLab and temperature packed into 0..1, linearly, so
// filtering stays exact and every device can render to it (RGBA8).
vec4 encF(vec4 v) { return vec4(v.x, v.yz * 1.25 + 0.5, (v.w + 1.0) / 3.0); }
vec4 decF(vec4 e) { return vec4(e.x, (e.yz - 0.5) * 0.8, e.w * 3.0 - 1.0); }
vec3 unlab(vec3 c) {
  vec3 l = vec3(c.x + 0.3963377774 * c.y + 0.2158037573 * c.z,
                c.x - 0.1055613458 * c.y - 0.0638541728 * c.z,
                c.x - 0.0894841775 * c.y - 1.2914855480 * c.z);
  l = l * l * l;
  return vec3(4.0767416621 * l.x - 3.3077115913 * l.y + 0.2309699292 * l.z,
             -1.2684380046 * l.x + 2.6097574011 * l.y - 0.3413193965 * l.z,
             -0.0041960863 * l.x - 0.7034186147 * l.y + 1.7076248565 * l.z);
}
`;

// Pass 1: the lava, in the flow's frame (x along the flow), OKLab + temperature.
const FIELD = /* glsl */ `${COMMON}
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uBox;          // the flow-space rectangle this texture covers
uniform vec4 uBase;         // background: bias, tilt across, tilt along, bands
uniform float uBend;        // how much the bands bend
uniform vec2 uLava;         // blob count, wobble
uniform vec4 uBA[${N}];     // lobe 1 centre, lobe 2 centre
uniform vec4 uBB[${N}];     // lobe 3 centre, lobe 1 radius, lobe 2 radius
uniform vec4 uBC[${N}];     // lobe 3 radius, merge radius, life, wobble phase
uniform vec4 uBD[${N}];     // edge softness, temperature, reach, -
uniform vec4 uBE[${N}];     // shading direction, centroid
uniform vec4 uQ0[${N}], uQ1[${N}], uQ2[${N}], uQ3[${N}]; // shade across the blob, a cubic in OKLab (w: chroma)
uniform sampler2D uLut;     // background colour by temperature (OKLCH)
uniform vec2 uLutRange;
out vec4 fragColor;

float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

void main() {
  vec2 q = uBox.xy + gl_FragCoord.xy / uResolution * uBox.zw;
  float T = uTime;
  // Background: broad bands across the flow, bending slowly along it.
  float bend = uBend * (0.9 * sin(q.x * 1.1 + T * 0.13) + 0.5 * sin(q.x * 2.3 - T * 0.19 + 1.7));
  float f = uBase.x + uBase.y * q.y + uBase.z * q.x
    + uBase.w * (sin(q.y * 4.2 + bend + T * 0.08) + 0.35 * sin(q.x * 1.3 + T * 0.21) * sin(q.y * 1.9 - T * 0.17));
  vec3 bg = texture(uLut, vec2(clamp((f - uLutRange.x) / (uLutRange.y - uLutRange.x), 0.0, 1.0) * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).xyz;
  vec3 bgLab = vec3(bg.x, bg.y * cos(bg.z), bg.y * sin(bg.z));
  // Blobs melt together: a weighted mix of every blob covering this point.
  vec3 sum = vec3(0.0);
  float wsum = 0.0, csum = 0.0, amax = 0.0;
  for (int i = 0; i < ${N}; i++) {
    if (float(i) >= uLava.x) break;
    if (length(q - uBE[i].zw) > uBD[i].z) continue;
    vec2 c1 = uBA[i].xy, c2 = uBA[i].zw, c3 = uBB[i].xy;
    float r1 = uBB[i].z, r2 = uBB[i].w, r3 = uBC[i].x, k = uBC[i].y;
    // Amoeba: two slow octaves of deformation in the blob's own space.
    float ph = uBC[i].w + T * 0.4;
    vec2 lq = (q - c1) / (r1 + 0.02);
    vec2 qw = q + uLava.y * r1 * (vec2(sin(lq.y * 1.7 + ph), sin(lq.x * 1.9 - ph * 1.1))
      + 0.5 * vec2(sin(lq.y * 3.3 - lq.x * 1.1 + ph * 1.7), sin(lq.x * 3.1 + lq.y * 0.9 - ph * 1.4)));
    float d = smin(smin(length(qw - c1) - r1, length(qw - c2) - r2, k), length(qw - c3) - r3, k * 0.8);
    float s = uBD[i].x;
    float a = smoothstep(s, -s, d) * uBC[i].z;
    float g = smoothstep(-1.0, 1.0, dot(q - c1, uBE[i].xy));
    vec3 lab = uQ0[i].xyz + g * (uQ1[i].xyz + g * (uQ2[i].xyz + g * uQ3[i].xyz));
    float w = a * a;
    sum += w * lab;
    wsum += w;
    csum += w * mix(uQ0[i].w, uQ1[i].w, g);
    amax = max(amax, a);
    f = mix(f, uBD[i].y, a);
  }
  vec3 lab = bgLab;
  if (wsum > 0.0) {
    float wb = (1.0 - amax) * (1.0 - amax) + 1e-3;
    lab = (sum + wb * bgLab) / (wsum + wb);
    // Colour cancelled in the melt comes back as light, never as grey.
    float lost = (csum + wb * bg.y) / (wsum + wb) - length(lab.yz);
    lab.x = min(lab.x + 1.4 * lost, max(lab.x, 0.96));
  }
  fragColor = encF(vec4(lab, f));
}
`;

// Pass 2: the long exposure, a blur along the flow (twice: short and long).
const BLUR = /* glsl */ `${COMMON}
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uLen;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 acc = vec4(0.0);
  float ws = 0.0, cs = 0.0;
  for (int k = 0; k < 5; k++) {
    float u = (float(k) + 0.5) / 5.0 - 0.5;
    float w = exp(-u * u * 6.0);
    vec4 v = decF(texture(uSrc, uv + vec2(u * uLen, 0.0)));
    acc += w * v;
    cs += w * length(v.yz);
    ws += w;
  }
  acc /= ws;
  acc.x = min(acc.x + 1.6 * (cs / ws - length(acc.yz)), max(acc.x, 0.96));
  fragColor = encF(acc);
}
`;

// Pass 3: everything smooth, at quarter resolution in screen space.
const AUX = /* glsl */ `${COMMON}
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uFlowA;        // flow angle now, stretch, ripple amount, ripple scale
uniform vec3 uStip;         // stipple mask: scale, low, high
uniform float uClarity;
uniform sampler2D uField;
uniform vec4 uBox;
uniform vec4 uBloom;        // strength, mip level, threshold, halation
uniform vec4 uLkA[2], uLkB[2];
uniform vec4 uSkA[6], uSkB[6];
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragLight;

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float T = uTime;
  // Into the flow frame, with a smooth refractive ripple.
  vec2 ql = rot(-uFlowA.x) * p;
  ql.x /= uFlowA.y;
  vec2 q = ql;
  float s = uFlowA.w, a = uFlowA.z * (1.0 - 0.6 * uClarity);
  q += a * vec2(sin(q.y * 2.1 * s + T * 0.7 + sin(q.x * 1.3 * s - T * 0.4)),
                sin(q.x * 1.7 * s - T * 0.5 + 1.3 * sin(q.y * 2.3 * s + T * 0.3)));
  q += 0.5 * a * vec2(sin(q.y * 4.3 * s - T * 0.9 + 2.0), sin(q.x * 3.7 * s + T * 0.8 + 1.0));
  float m = smoothstep(uStip.y, uStip.z, vnoise(p * uStip.x + 3.1 + 0.05 * T));
  float smear = 0.25 + 0.75 * smoothstep(0.3, 0.7, vnoise(p * 1.3 + vec2(0.04 * T, 7.0)));
  // Bloom: a blurred look at the field, its brightest light added back.
  vec3 blur = max(unlab(decF(textureLod(uField, (q - uBox.xy) / uBox.zw, uBloom.y)).xyz), 0.0);
  float lum = dot(blur, vec3(0.2126, 0.7152, 0.0722));
  vec3 add = uBloom.x * (blur * smoothstep(uBloom.z, 1.0, lum) + uBloom.w * vec3(1.0, 0.35, 0.15) * blur.r * smoothstep(0.3, 1.0, blur.r));
  // Light leaks: big warm flares drifting in from the edges.
  for (int i = 0; i < 2; i++) {
    vec2 d = (p - uLkA[i].xy) * uLkA[i].zw;
    add += uLkB[i].rgb * exp(-dot(d, d));
  }
  // Light streaks, as a brightness the composite tints with the colour below.
  float S = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uSkB[0].y) break;
    float ex = q.x - uSkA[i].x;
    float dy = (q.y - uSkA[i].y - 0.15 * ex * ex) * uSkA[i].w;
    float dx = ex * uSkA[i].z;
    S += uSkB[i].x * exp(-dx * dx) * (exp(-dy * dy) + 0.25 * exp(-dy * dy * 0.04));
  }
  fragColor = vec4((q - ql) * 2.5 + 0.5, m, smear);
  fragLight = vec4(add, S);
}
`;

// Pass 4, the effect itself: full resolution.
export const fragment = /* glsl */ `${COMMON}
uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D uField, uSmearLo, uSmearHi, uAux0, uAux1;
uniform vec4 uBox;
uniform vec4 uFlowA;        // flow angle now, stretch
uniform float uStipple;
uniform float uFringe;
uniform float uGrain;
uniform float uReady;
out vec4 fragColor;

vec2 hash22(vec2 p) { vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
vec3 linearToSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec4 field(vec2 q) { return decF(texture(uField, (q - uBox.xy) / uBox.zw)); }

void main() {
  if (uReady < 0.5) { fragColor = vec4(0.96, 0.96, 0.95, 1.0); return; }
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec2 auv = gl_FragCoord.xy / uResolution;
  vec4 A0 = texture(uAux0, auv);
  vec4 light = texture(uAux1, auv);
  // Stipple: some areas dissolve into scattered grain.
  vec2 jit = (hash22(gl_FragCoord.xy) - 0.5) * 2.0 * uStipple * (0.2 + A0.z);
  mat2 R = rot(-uFlowA.x);
  vec2 ql = R * p;
  ql.x /= uFlowA.y;
  vec2 jq = R * jit;
  jq.x /= uFlowA.y;
  vec2 q = ql + (A0.xy - 0.5) * 0.4 + jq;
  // Long exposure: blend the short and long smears.
  vec2 uv = (q - uBox.xy) / uBox.zw;
  float k = clamp((A0.w - 0.25) / 0.75, 0.0, 1.0);
  vec4 sc = mix(decF(texture(uSmearLo, uv)), decF(texture(uSmearHi, uv)), k);
  // Colour fringing: red and blue see the field slightly apart.
  vec2 ab = R * (p * uFringe);
  ab.x /= uFlowA.y;
  vec3 s0 = field(q).xyz;
  float r = max(unlab(sc.xyz + field(q + ab).xyz - s0).r, 0.0);
  float b = max(unlab(sc.xyz + field(q - ab).xyz - s0).b, 0.0);
  sc.yz *= ${CHROMA.toFixed(2)};
  vec3 g = max(unlab(sc.xyz), 0.0);
  vec3 col = vec3(r, g.g, b);
  col += light.rgb + light.a * (g + 0.4);
  // A soft shoulder, so overlapping light burns to white without clipping.
  col = col / (1.0 + max(col - 0.85, 0.0) * 0.8);
  vec3 c = linearToSrgb(col);
  c += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * uGrain;
  fragColor = vec4(c, 1.0);
}
`;

// ---- CPU side ----

const f32 = Math.fround;
const fract = (/** @type {number} */ x) => f32(x - Math.floor(x));
/** The shader's hash, emulated in float32 so layouts match. @param {number} p */
function hash11(p) {
  p = fract(f32(f32(p) * f32(0.1031)));
  p = f32(p * f32(p + f32(33.33)));
  p = f32(p * f32(p + p));
  return fract(p);
}
const smooth = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;
const wrap = (/** @type {number} */ d) => d - TAU * Math.floor((d + Math.PI) / TAU);

/**
 * The palette: stops in OKLCH with their positions and hardness, and where
 * the hard run at the hot end begins (blobs reach past it only rarely).
 * @param {NorthStarOptions} o
 */
function palette(o) {
  const sorted = [...o.colors].sort((a, b) => a[0] - b[0]);
  if (!sorted.length) sorted.push([0, '#ffffff']);
  const lch = sorted.map(([, hex]) => {
    const [L, a, b] = oklab(/** @type {[number, number, number]} */ (linear(hex)));
    return [L, Math.hypot(a, b), Math.atan2(b, a)];
  });
  const pos = sorted.map(([at]) => at);
  const hard = pos.map((at, i) => (i > 0 && at - pos[i - 1] <= HARD_GAP ? 0.9 : 0));
  const first = hard.findIndex((h) => h > 0);
  return { lch, pos, hard, edge: first > 0 ? pos[first - 1] : 2 };
}

/** Temperature to palette position, through the fitted proportions. @param {number} x */
function remap(x) {
  let out = MAP_OUT[0];
  for (let i = 0; i < 15; i++) {
    if (x < MAP_IN[i]) break;
    out = MAP_OUT[i] + (MAP_OUT[i + 1] - MAP_OUT[i]) * Math.min(1, Math.max(0, (x - MAP_IN[i]) / Math.max(MAP_IN[i + 1] - MAP_IN[i], 1e-5)));
  }
  return out;
}

/** OKLCH colour at a palette position, into `out`. @param {ReturnType<typeof palette>} pal @param {number} x @param {number[]} out */
function rampLch(pal, x, out) {
  const { lch, pos, hard } = pal;
  let i = 1;
  if (x <= pos[0] || pos.length < 2) { out[0] = lch[0][0]; out[1] = lch[0][1]; out[2] = lch[0][2]; return out; }
  while (i < pos.length - 1 && x >= pos[i]) i++;
  const a = pos[i - 1], b = pos[i], h = hard[i];
  let k = Math.min(1, Math.max(0, (x - a) / Math.max(b - a, 1e-4)));
  k = k * k * (3 - 2 * k) * (1 - h) + smooth(0.5 - 0.5 * (1 - h) - 0.02, 0.5 + 0.5 * (1 - h) + 0.02, k) * h;
  const A = lch[i - 1], B = lch[i];
  const h0 = A[1] < 0.02 ? B[2] : A[2], h1 = B[1] < 0.02 ? h0 : B[2];
  out[0] = A[0] + (B[0] - A[0]) * k;
  out[1] = A[1] + (B[1] - A[1]) * k;
  out[2] = h0 + wrap(h1 - h0) * k;
  return out;
}

/** Mix two OKLCH colours the way the look wants (opposite hues meet in light), as OKLab. */
function mixToLab(/** @type {number[]} */ a, /** @type {number[]} */ b, /** @type {number} */ k, /** @type {number[]} */ out) {
  const h0 = a[1] < 0.02 ? b[2] : a[2], h1 = b[1] < 0.02 ? h0 : b[2];
  const dh = wrap(h1 - h0);
  const L = a[0] + (b[0] - a[0]) * k, C = a[1] + (b[1] - a[1]) * k, H = h0 + dh * k;
  out[0] = L; out[1] = C * Math.cos(H); out[2] = C * Math.sin(H);
  if (Math.abs(dh) <= 1.5) return out;
  const ax = a[1] * Math.cos(a[2]), ay = a[1] * Math.sin(a[2]), bx = b[1] * Math.cos(b[2]), by = b[1] * Math.sin(b[2]);
  const w = 4 * k * (1 - k) * smooth(1.5, 2.4, Math.abs(dh));
  const mL = L + (Math.max(a[0], b[0], 0.93) - L) * w;
  const mx = (ax + (bx - ax) * k) * (1 - 0.75 * w), my = (ay + (by - ay) * k) * (1 - 0.75 * w);
  if (Math.abs(dh) > 2.6) { out[0] = mL; out[1] = mx; out[2] = my; return out; }
  const s = smooth(1.9, 2.6, Math.abs(dh));
  out[0] = Math.max(L, mL) + (mL - Math.max(L, mL)) * s;
  out[1] = out[1] + (mx - out[1]) * s;
  out[2] = out[2] + (my - out[2]) * s;
  return out;
}

/**
 * @param {NorthStarOptions} o
 * @param {number} T Effect time (already scaled by speed).
 * @param {ReturnType<typeof palette>} pal The palette.
 * @param {Record<string, Float32Array>} u Per-frame uniform arrays, filled in place.
 */
function blobs(o, T, pal, u) {
  const stretch = o.stretch;
  const focus = 0.5 + 0.5 * Math.sin(T * FOCUS_SPEED);
  const clarity = CLARITY * smooth(0.6, 0.95, Math.sin(T * 0.11 + 1) * 0.5 + 0.5);
  const seed = Math.round(o.variation);
  const A = [0, 0, 0], B = [0, 0, 0], tmp = [0, 0, 0];
  const n = Math.min(N, Math.round(o.blobs));
  for (let i = 0; i < n; i++) {
    const fi = f32(i + f32(seed * 13));
    const depth = (i + 0.5) / n;
    // Each blob lives a while: swells in, wanders, dissolves, is reborn elsewhere.
    const rate = LIFE * (0.6 + 0.8 * hash11(f32(fi + 21)));
    const cyc = T * rate + hash11(f32(fi + 23));
    const gen = Math.floor(cyc), ph = cyc - gen;
    const life = smooth(0, 0.25, ph) * smooth(1, 0.7, ph);
    const gi = f32(fi + f32(gen * f32(17.31)));
    const hx = (hash11(f32(gi * f32(1.7))) - 0.5) * (2.3 / stretch);
    const hy = (hash11(f32(f32(gi * f32(3.1)) + f32(0.4))) - 0.5) * 1.3;
    let cx = hx, cy = hy;
    for (let k = 1; k <= 3; k++) {
      const wf = (0.07 + 0.12 * hash11(f32(f32(fi * k) + 5))) * k * 0.7;
      cx += (0.3 / stretch / k) * Math.sin(T * wf + fi * 2.3 * k);
      cy += (0.22 / k) * Math.cos(T * wf * 1.13 + fi * 1.1 * k);
    }
    const hr = hash11(f32(gi + 2));
    const r = o.size * (0.25 + 1.5 * hr * hr) * (0.55 + 0.45 * life);
    const h4 = hash11(f32(fi + 4));
    const a0 = fi * 3.7 + T * (0.05 + 0.08 * h4);
    const s1 = r * LOBES * (0.5 + 0.5 * Math.sin(T * (0.13 + 0.1 * h4) + fi));
    const s2 = r * LOBES * (0.5 + 0.5 * Math.sin(T * (0.11 + 0.1 * hash11(f32(fi + 6))) + fi * 1.7));
    const c1x = cx + Math.cos(a0) * s1, c1y = cy + Math.sin(a0) * s1;
    const c2x = cx - Math.cos(a0) * s1 * 0.8, c2y = cy - Math.sin(a0) * s1 * 0.8;
    const c3x = cx + Math.cos(a0 + 2.1) * s2, c3y = cy + Math.sin(a0 + 2.1) * s2;
    const r1 = r * (0.75 + 0.25 * Math.sin(T * 0.3 + fi)), r2 = r * (0.65 + 0.3 * hash11(f32(fi + 7)));
    const r3 = r * (0.45 + 0.3 * hash11(f32(fi + 8))) * (0.6 + 0.4 * Math.sin(T * 0.23 + fi * 2));
    const K = r * 0.9;
    let soft = SHARP + o.focus * Math.abs(depth - focus) * (1 - 0.85 * clarity);
    // Colour is fixed at birth, so a blob never snaps as it drifts.
    const birth = rate > 0 ? (gen - hash11(f32(fi + 23))) / rate : T;
    const bend = o.bend * (0.9 * Math.sin(hx * 1.1 + birth * 0.13) + 0.5 * Math.sin(hx * 2.3 - birth * 0.19 + 1.7));
    const bands = o.showBands ? BASE[2] : 0;
    const base = o.bias + BASE[0] * hy + BASE[1] * hx + bands * (Math.sin(hy * 4.2 + bend + birth * 0.08) + 0.35 * Math.sin(hx * 1.3 + birth * 0.21) * Math.sin(hy * 1.9 - birth * 0.17));
    const temp = base + (hash11(f32(f32(gi * f32(7.7)) + 1)) - 0.5) * 2 * SPREAD;
    let pos = remap(temp);
    // The hard run at the hot end (a dark pool, say) is rare: most hot
    // blobs stop just short of it. How rare is judged at the default bias,
    // so raising the bias warms everything without filling it with pools.
    const edge = pal.edge;
    const pool = remap(temp - (o.bias - POOL_BIAS)) > edge + 0.004 && hash11(f32(gi * f32(3.3))) <= 0.2;
    if (pos > edge + 0.004 && !pool) pos = edge - 0.035;
    rampLch(pal, pos, A);
    const side = hash11(f32(gi * f32(2.1))) < 0.5 ? -1 : 1;
    let posB = remap(temp + side * SPREAD * 0.8);
    if (posB > edge - 0.005 && pos < edge + 0.004) posB = edge - 0.025;
    rampLch(pal, posB, B);
    soft = soft + (SHARP * 1.5 - soft) * smooth(0.5, 0.3, A[0]);
    if (A[0] < 0.4) { B[0] = A[0]; B[1] = A[1]; B[2] = A[2]; }
    // The shade across the blob, as a cubic in OKLab through four exact points.
    const pts = [0, 1 / 3, 2 / 3, 1].map((t) => [...mixToLab(A, B, t, tmp)]);
    const gx = (c1x + c2x + c3x) / 3, gy = (c1y + c2y + c3y) / 3;
    const reach = Math.max(Math.hypot(c1x - gx, c1y - gy) + r1, Math.hypot(c2x - gx, c2y - gy) + r2, Math.hypot(c3x - gx, c3y - gy) + r3) + K * 0.25 + o.wobble * r1 * 1.5 + soft;
    const ga = fi * 1.9 + T * 0.07;
    const j = i * 4;
    u.uBA.set([c1x, c1y, c2x, c2y], j);
    u.uBB.set([c3x, c3y, r1, r2], j);
    u.uBC.set([r3, K, life, fi * 1.31], j);
    u.uBD.set([soft, temp, life > 0 ? reach : -1e3, 0], j);
    u.uBE.set([Math.cos(ga) / r, Math.sin(ga) / r, gx, gy], j);
    for (let c = 0; c < 3; c++) {
      const [p0, p1, p2, p3] = [pts[0][c], pts[1][c], pts[2][c], pts[3][c]];
      u.uQ0[j + c] = p0;
      u.uQ1[j + c] = (-11 * p0 + 18 * p1 - 9 * p2 + 2 * p3) / 2;
      u.uQ2[j + c] = (18 * p0 - 45 * p1 + 36 * p2 - 9 * p3) / 2;
      u.uQ3[j + c] = (-9 * p0 + 27 * p1 - 27 * p2 + 9 * p3) / 2;
    }
    u.uQ0[j + 3] = A[1];
    u.uQ1[j + 3] = B[1];
  }
  return n;
}

/** @type {import('./runtime.js').EffectSpec<NorthStarOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 1.5,
  time: 12,
  speed: (o) => o.speed,
  update(o) {
    return { uGrain: o.grain, uStipple: o.showLens ? DIFFUSION : 0, uFringe: o.showLens ? FRINGING : 0 };
  },
  attach(ctx) {
    const { gl, canvas } = ctx;
    /** @type {Record<string, WebGLProgram | null>} */
    const prog = { field: null, blur: null, aux: null };
    /** @type {Record<string, Record<string, WebGLUniformLocation | null>>} */
    const loc = { field: {}, blur: {}, aux: {} };
    const VS = '#version 300 es\nvoid main(){vec2 p=vec2(gl_VertexID&1,gl_VertexID>>1)*4.0-1.0;gl_Position=vec4(p,0,1);}';
    let ok = false;
    /** @type {(WebGLTexture | null)[]} */
    let tex = [];
    /** @type {(WebGLFramebuffer | null)[]} */
    let fbo = [];
    let fw = 0, fh = 0, aw = 0, ah = 0, frame = 0, lastTime = -1;
    const lastBox = new Float32Array(4);
    let lutSig = '';
    /** @type {ReturnType<typeof palette>} */
    let pal = palette(defaults);
    const units = { field: ctx.textureUnit(1), lo: ctx.textureUnit(2), hi: ctx.textureUnit(3), a0: ctx.textureUnit(4), a1: ctx.textureUnit(5), lut: ctx.textureUnit(6) };
    /** @type {Record<string, Float32Array>} */
    const U = {};
    for (const k of ['uBA', 'uBB', 'uBC', 'uBD', 'uBE', 'uQ0', 'uQ1', 'uQ2', 'uQ3']) U[k] = new Float32Array(N * 4);
    const skA = new Float32Array(24), skB = new Float32Array(24), lkA = new Float32Array(8), lkB = new Float32Array(8);
    const lut = new Float32Array(1024 * 4);
    const box = new Float32Array(4);

    const program = (/** @type {string} */ src, /** @type {string} */ name) => {
      const sh = (/** @type {number} */ t, /** @type {string} */ s) => { const x = /** @type {WebGLShader} */ (gl.createShader(t)); gl.shaderSource(x, s); gl.compileShader(x); return x; };
      const p = /** @type {WebGLProgram} */ (gl.createProgram());
      const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, src);
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      gl.deleteShader(v); gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(`north-star ${name}:`, gl.getShaderInfoLog(f)); return null; }
      return p;
    };
    const L = (/** @type {string} */ p, /** @type {string} */ n) => (loc[p][n] ??= gl.getUniformLocation(/** @type {WebGLProgram} */ (prog[p]), n));
    const texture = (/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ unit, mip = false) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const target = (/** @type {(WebGLTexture | null)[]} */ ts) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      ts.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      if (ts.length > 1) gl.drawBuffers(ts.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      return fb;
    };
    const release = () => { tex.forEach((t) => gl.deleteTexture(t)); fbo.forEach((f) => gl.deleteFramebuffer(f)); tex = []; fbo = []; fw = fh = aw = ah = 0; };
    const allocField = (/** @type {number} */ w, /** @type {number} */ h) => {
      for (const i of [0, 1, 2]) { if (tex[i]) gl.deleteTexture(tex[i]); if (fbo[i]) gl.deleteFramebuffer(fbo[i]); }
      tex[0] = texture(w, h, units.field, true);
      tex[1] = texture(Math.max(1, Math.ceil(w / 2)), h, units.lo);
      tex[2] = texture(Math.max(1, Math.ceil(w / 2)), h, units.hi);
      fbo[0] = target([tex[0]]); fbo[1] = target([tex[1]]); fbo[2] = target([tex[2]]);
      fw = w; fh = h; frame = 0;
    };
    const allocAux = (/** @type {number} */ w, /** @type {number} */ h) => {
      for (const i of [3, 4]) if (tex[i]) gl.deleteTexture(tex[i]);
      if (fbo[3]) gl.deleteFramebuffer(fbo[3]);
      tex[3] = texture(w, h, units.a0); tex[4] = texture(w, h, units.a1);
      fbo[3] = target([tex[3], tex[4]]);
      aw = w; ah = h;
    };
    const build = () => {
      prog.field = program(FIELD, 'field'); prog.blur = program(BLUR, 'blur'); prog.aux = program(AUX, 'aux');
      loc.field = {}; loc.blur = {}; loc.aux = {};
      tex[5] = gl.createTexture();
      ok = !!(prog.field && prog.blur && prog.aux);
      lutSig = '';
    };
    const updateLut = (/** @type {NorthStarOptions} */ o) => {
      const sig = JSON.stringify(o.colors) + o.bias;
      if (sig === lutSig) return;
      lutSig = sig;
      pal = palette(o);
      const c = [0, 0, 0];
      let prev = null;
      for (let i = 0; i < 1024; i++) {
        // The background reaches the hard run only where it would at the
        // default bias; elsewhere it stops at the colour just before it.
        const f = -2 + (5 * i) / 1023;
        let at = remap(f);
        if (at > pal.edge && remap(f - (o.bias - POOL_BIAS)) <= pal.edge) at = pal.edge - 0.001;
        rampLch(pal, at, c);
        let h = c[2];
        if (prev !== null) { while (h - prev > Math.PI) h -= TAU; while (h - prev < -Math.PI) h += TAU; }
        prev = h;
        lut.set([c[0], c[1], h, 0], i * 4);
      }
      gl.activeTexture(gl.TEXTURE0 + units.lut);
      gl.bindTexture(gl.TEXTURE_2D, tex[5]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, 1, 0, gl.RGBA, gl.FLOAT, lut);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    build();

    return {
      // Any change redraws the field on the next frame, never a stale one.
      update(o) { frame = 0; if (ok) updateLut(o); },
      frame(_dt, time) {
        const o = /** @type {NorthStarOptions} */ (ctx.options?.() ?? defaults);
        if (!ok) { ctx.uniform('uReady', 0); return; }
        updateLut(o);
        const W = canvas.width, H = canvas.height;
        const T = time;
        const angle = (o.angle * Math.PI) / 180;
        const flowA = angle + SWAY * (0.6 * Math.sin(T * 0.071) + 0.4 * Math.sin(T * 0.137 + 1));
        const clarity = CLARITY * smooth(0.6, 0.95, Math.sin(T * 0.11 + 1) * 0.5 + 0.5);
        const seed = Math.round(o.variation);
        const distortion = o.showLens ? o.distortion : 0;
        const smearMax = o.smear * (1 - 0.7 * clarity);
        const effect = gl.getParameter(gl.CURRENT_PROGRAM);
        // The flow-space box the screen covers, with room for the ripple.
        const asp = W / Math.max(H, 1), st = o.stretch;
        const cA = Math.abs(Math.cos(flowA)), sA = Math.abs(Math.sin(flowA));
        const mx = (cA * asp / 2 + sA / 2) / st + distortion * 1.6 + 0.02 + o.smear * 0.15, my = sA * asp / 2 + cA / 2 + distortion * 1.6 + 0.02;
        const D = FIELD_SCALE * H;
        const needW = Math.max(1, Math.ceil(2 * mx * D)), needH = Math.max(1, Math.ceil(2 * my * D));
        const resize = !fw || needW > fw || needH > fh || needW < fw * 0.75 || needH < fh * 0.75;
        if (resize) allocField(Math.ceil(needW * 1.1), Math.ceil(needH * 1.1));
        // Redraw the field every other frame; a still frame or a jump in time
        // (a seek, a paused redraw) always gets a fresh one.
        const fresh = resize || frame++ % FIELD_EVERY === 0 || Math.abs(time - lastTime) > 0.1 || time === lastTime;
        lastTime = time;
        if (fresh) {
          const kx = fw / needW, ky = fh / needH;
          box[2] = 2 * mx * kx; box[3] = 2 * my * ky; box[0] = -box[2] / 2; box[1] = -box[3] / 2;
          lastBox.set(box);
          const n = blobs(o, T, pal, U);
          // Pass 1: the field.
          gl.useProgram(prog.field);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[0]);
          gl.viewport(0, 0, fw, fh);
          gl.uniform2f(L('field', 'uResolution'), fw, fh);
          gl.uniform1f(L('field', 'uTime'), T);
          gl.uniform4fv(L('field', 'uBox'), box);
          gl.uniform4f(L('field', 'uBase'), o.bias, BASE[0], BASE[1], o.showBands ? BASE[2] : 0);
          gl.uniform1f(L('field', 'uBend'), o.bend);
          gl.uniform2f(L('field', 'uLava'), n, o.wobble);
          for (const k in U) gl.uniform4fv(L('field', k), U[k]);
          gl.uniform1i(L('field', 'uLut'), units.lut);
          gl.uniform2f(L('field', 'uLutRange'), -2, 3);
          gl.activeTexture(gl.TEXTURE0 + units.lut);
          gl.bindTexture(gl.TEXTURE_2D, tex[5]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.activeTexture(gl.TEXTURE0 + units.field);
          gl.bindTexture(gl.TEXTURE_2D, tex[0]);
          gl.generateMipmap(gl.TEXTURE_2D);
          // Pass 2: the long exposure, short and long.
          gl.useProgram(prog.blur);
          const bw = Math.max(1, Math.ceil(fw / 2));
          gl.viewport(0, 0, bw, fh);
          gl.uniform2f(L('blur', 'uResolution'), bw, fh);
          gl.uniform1i(L('blur', 'uSrc'), units.field);
          for (const k of [1, 2]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[k]);
            gl.uniform1f(L('blur', 'uLen'), ((k === 1 ? 0.25 : 1) * smearMax) / box[2]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          }
        }
        box.set(lastBox);
        // Streaks and leaks, placed once per frame.
        const sk = Math.min(6, STREAK_COUNT);
        for (let i = 0; i < 6; i++) {
          const fi = f32(i + f32(seed * 7));
          const y0 = (hash11(f32(fi * f32(5.1))) - 0.5) * 1.1 + 0.08 * Math.sin(T * 0.2 + fi);
          const x0 = ((hash11(f32(fi * f32(2.3))) - 0.5) * 1.2) / st + (0.3 / st) * Math.sin(T * 0.07 + fi * 2);
          const len = (STREAK_LENGTH * (0.5 + hash11(f32(fi + 1)))) / st, w = STREAK_WIDTH * (0.4 + hash11(f32(fi + 6)));
          const life = 0.5 + 0.5 * Math.sin(T * (0.15 + 0.1 * hash11(f32(fi + 3))) + fi * 4);
          skA.set([x0, y0, 1 / len, 1 / w], i * 4);
          skB.set([o.streaks * life, i === 0 && o.showStreaks ? sk : 0, 0, 0], i * 4);
        }
        const leak = o.showLeaks ? o.leaks : 0;
        for (let i = 0; i < 2; i++) {
          const fi = f32(i + f32(seed * 3)), ph = T * LEAK_SPEED + fi * 3.1;
          const on = smooth(0.55, 1, 0.5 + 0.5 * Math.sin(ph));
          const k = LEAK_WARMTH * hash11(f32(fi + 4));
          lkA.set([(hash11(f32(fi + 1)) < 0.5 ? -1 : 1) * (0.75 + 0.2 * Math.sin(ph * 0.7)), 0.5 * Math.sin(ph * 0.5 + fi), 1 / (LEAK_SIZE * 1.4), 1 / (LEAK_SIZE * 0.8)], i * 4);
          lkB.set([leak * on, leak * on * (0.9 - 0.45 * k), leak * on * (0.8 - 0.65 * k), 0], i * 4);
        }
        // Pass 3: aux, quarter resolution.
        const w4 = Math.max(2, Math.ceil(W / 4)), h4 = Math.max(2, Math.ceil(H / 4));
        if (w4 !== aw || h4 !== ah) allocAux(w4, h4);
        gl.useProgram(prog.aux);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[3]);
        gl.viewport(0, 0, aw, ah);
        gl.uniform2f(L('aux', 'uResolution'), aw, ah);
        gl.uniform1f(L('aux', 'uTime'), T);
        gl.uniform4f(L('aux', 'uFlowA'), flowA, st, distortion, RIPPLE_SCALE);
        gl.uniform3f(L('aux', 'uStip'), STIPPLE[0], STIPPLE[1], STIPPLE[2]);
        gl.uniform1f(L('aux', 'uClarity'), clarity);
        gl.uniform1i(L('aux', 'uField'), units.field);
        gl.uniform4fv(L('aux', 'uBox'), box);
        gl.uniform4f(L('aux', 'uBloom'), o.glow, Math.max(0, Math.log2(Math.max(1e-3, BLOOM_SOFT * 0.6 * D))), BLOOM_THRESHOLD, HALATION);
        gl.uniform4fv(L('aux', 'uLkA'), lkA); gl.uniform4fv(L('aux', 'uLkB'), lkB);
        gl.uniform4fv(L('aux', 'uSkA'), skA); gl.uniform4fv(L('aux', 'uSkB'), skB);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // Back to the effect for the composite.
        gl.useProgram(effect);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        [[units.field, 0], [units.lo, 1], [units.hi, 2], [units.a0, 3], [units.a1, 4]].forEach(([unit, i]) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex[i]);
        });
        gl.activeTexture(gl.TEXTURE0);
        ctx.sampler('uField', units.field);
        ctx.sampler('uSmearLo', units.lo);
        ctx.sampler('uSmearHi', units.hi);
        ctx.sampler('uAux0', units.a0);
        ctx.sampler('uAux1', units.a1);
        ctx.uniform('uBox', box);
        ctx.uniform('uFlowA', [flowA, st, 0, 0]);
        ctx.uniform('uReady', 1);
      },
      restore() { tex = []; fbo = []; fw = fh = aw = ah = 0; build(); },
      destroy() {
        release();
        if (tex[5]) gl.deleteTexture(tex[5]);
        for (const k in prog) if (prog[k]) gl.deleteProgram(prog[k]);
        ok = false;
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<NorthStarOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function northStar(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
