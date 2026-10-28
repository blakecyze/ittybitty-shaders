// @ts-check
/**
 * ittybitty/pebbles
 *
 * Big, smooth glass pebbles, dark as obsidian, piled up and cropped by the
 * frame. Light glows through their bodies in deep colour, everything behind
 * a pebble shows through it bent and softened, and thin bright lines trace
 * their rims where the light grazes them. They drift, turn and breathe
 * slowly, the pointer nudges them aside, and the light follows it.
 *
 * Each pebble is a rounded superellipse in screen space with a domed height
 * field, so a single pass is enough: the frontmost pebble at a pixel looks
 * through to the pebbles and backdrop behind it at a refracted offset,
 * re-evaluated with soft edges for the frosting, rather than reading back
 * an earlier render.
 *
 * https://ittybitty.dev/shaders/pebbles (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} PebblesOptions
 * @property {number} speed How fast the pebbles drift, turn and breathe.
 * @property {number} count How many pebbles there are, 1 to 8.
 * @property {number} size How large the pebbles are.
 * @property {number} roundness From soft rounded squares to round pebbles.
 * @property {number} clarity How much light the glass lets through. Low is dark as obsidian.
 * @property {number} frost How frosted the glass is: how softly it blurs what is behind it.
 * @property {number} refraction How strongly the glass bends what is behind it.
 * @property {number} rim Brightness of the thin lines and glow along the rims.
 * @property {number} grain Strength of the film grain.
 * @property {import('./runtime.js').Gradient} backdrop The light behind the pebbles, from top left to bottom right.
 * @property {string} glass The colour the glass lets through. Darker absorbs more.
 * @property {string} glowColor The light glowing inside the pebbles. Black for none.
 * @property {boolean} depth Pebbles further back fall softly out of focus and into shadow.
 * @property {boolean} interactive The pointer nudges the pebbles and the light follows it.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {PebblesOptions} */
export const defaults = {
  speed: 0.5,
  count: 3,
  size: 1,
  roundness: 0.35,
  clarity: 0.6,
  frost: 0.75,
  refraction: 0.7,
  rim: 0.3,
  grain: 0.12,
  backdrop: [
    [0, '#01655b'],
    [0.5, '#5a5646'],
    [1, '#c42414'],
  ],
  glass: '#504a44',
  glowColor: '#a00c06',
  depth: false,
  interactive: true,
  responsiveness: 0.5,
};

const MAX = 8;
// Uniform vectors per pebble (see the frame hook for what each holds).
const STRIDE = 5;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
// Per pebble, worked out on the CPU each frame so no pixel repeats it:
// centre, half size; cos, sin, exponent, taper per height; 1 / exponent,
// dome exponent, smaller half size, bounding reject; density, blur width,
// where its inner light pools; that light's colour, shadow from depth.
uniform vec4 uPebbles[${MAX * STRIDE}];
uniform float uCount;
uniform vec4 uRampA, uRampK; // each stop's position, and 1 / the gap to the next, for the first four gaps
uniform vec2 uRamp4;         // the same for the last gap
uniform vec3 uBack0;         // the first stop in LMS (OKLab before its cube)
uniform vec4 uBackD[5];      // the step to each next stop, in LMS
uniform vec3 uAbsorbRGB; // the glass colour as absorption, -log of its transmittance, plus grey from clarity
uniform float uPoolAbsorb; // how the inner light is swallowed by thickness
uniform vec2 uLight;     // where the light is, in scene units
uniform vec3 uSheen;     // the sheen where the dome faces the light
uniform vec3 uRimLine;   // the thin rim line
uniform vec3 uFringe;    // the warm fringe inside it
uniform vec3 uGlossCol;  // glossy streaks
uniform float uFrost;
uniform float uRefraction;
uniform float uRim;
uniform float uGloss;   // glossy streaks, from rim light, dulled by frosting
uniform float uChroma;  // how far red and blue part when refracted
uniform float uGrain;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}


vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec2 gBack; // the backdrop's direction across the frame
float gPx;  // a device pixel, in scene units

// The backdrop: the gradient laid diagonally, top left to bottom right,
// blended in OKLab. Blending is done a step past it, in LMS, which is a
// linear map of OKLab and so blends the same; each stop's step is added in
// as far as x has got through its gap.
vec3 backdrop(vec2 p) {
  float x = clamp(0.5 + dot(p, gBack), 0.0, 1.0);
  vec4 t = clamp((x - uRampA) * uRampK, 0.0, 1.0);
  vec3 lms = uBack0 + uBackD[0].xyz * t.x + uBackD[1].xyz * t.y + uBackD[2].xyz * t.z + uBackD[3].xyz * t.w + uBackD[4].xyz * clamp((x - uRamp4.x) * uRamp4.y, 0.0, 1.0);
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010) * (lms * lms * lms);
}

// One pebble's shape at p: signed distance to its rim (scene units, negative
// inside), returned, and the outward direction, how steep the dome is, its
// thickness and the pebble's smaller half size. (Plain values rather than a
// struct, so layers.js can namespace everything when pebbles are stacked.)
float shape(int i, vec2 p, out vec2 dir, out float slope, out float t, out float m) {
  vec4 A = uPebbles[i * ${STRIDE}];
  vec4 B = uPebbles[i * ${STRIDE} + 1];
  vec4 C = uPebbles[i * ${STRIDE} + 2];
  vec2 d = p - A.xy;
  vec2 q = vec2(B.x * d.x + B.y * d.y, B.x * d.y - B.y * d.x);
  // A gentle taper, wider at one end: a pebble, not a pill.
  vec2 is = 1.0 / vec2(A.z * (1.0 + B.w * q.y), A.w);
  vec2 u = abs(q) * is + 1e-5;
  m = C.z;
  dir = vec2(0.0);
  slope = 0.0;
  t = 0.0;
  // Cheap reject outside the bounding box, padded for the softest frost.
  if (max(u.x, u.y) > C.w) return 1.0;
  // The superellipse's powers from shared logarithms: r = S^(1/n).
  vec2 un = exp2(B.z * log2(u));
  float lr = log2(un.x + un.y) * C.x;
  float r = exp2(lr);
  // Gradient of r, for a true distance near the rim and the dome's normal.
  vec2 g = r * un * is * sign(q) / ((un.x + un.y) * u);
  float ig = inversesqrt(max(dot(g, g), 1e-10));
  float gl = 1.0 / ig;
  vec2 dl = g * ig;
  dir = vec2(B.x * dl.x - B.y * dl.y, B.y * dl.x + B.x * dl.y);
  // A domed slab: flat across the middle, rounding off over the rim.
  // Rounder pebbles are domed more, squarer ones flatter on top.
  float rk = exp2(C.y * min(lr, 0.0));
  t = sqrt(max(1.0 - rk, 0.0));
  slope = 0.275 * C.y * m * rk * gl / (max(r, 1e-3) * max(t, 0.03));
  return (r - 1.0) * ig;
}

// The colour of pebble i over what is seen through it.
vec3 shade(int i, float sd, vec2 dir, float slope, float t, float m, vec2 p, vec3 behind, float w) {
  vec3 N = vec3(dir * slope, 1.0) * inversesqrt(1.0 + slope * slope);
  vec4 D = uPebbles[i * ${STRIDE} + 3]; // density, blur width, pool
  vec4 E = uPebbles[i * ${STRIDE} + 4]; // light colour, shadow
  // Light through the glass, absorbed more where it is thicker.
  float thick = D.x * (0.2 + 1.2 * t * t);
  vec3 body = behind * exp(-uAbsorbRGB * thick);
  // A pool of light inside, on the side facing the light (turned a little
  // differently in each pebble): it scatters through the body, bright
  // where the glass is thin and swallowed where it is thick. Its colour
  // takes on the backdrop on that side too.
  vec2 dp = p - D.zw;
  body += E.rgb * (1.8 * exp(-2.0 * dot(dp, dp) / (m * m) - thick * uPoolAbsorb));
  // The outside reflects a dim, darkened version of the backdrop.
  float z = 1.0 - N.z;
  float z2 = z * z;
  float f = 0.04 + 0.96 * z2 * z2 * z;
  vec3 env = backdrop(p + N.xy * 0.4) * 0.12;
  vec3 col = mix(body, env, f * 0.85);
  // A soft sheen where the dome faces the light.
  vec2 lp = uLight - p;
  float ll = dot(lp, lp);
  vec3 H = normalize(vec3(lp, 0.9) * inversesqrt(ll + 0.81) + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(N, H), 0.0);
  float n3 = nh * nh * nh;
  float n6 = n3 * n3;
  float n12 = n6 * n6;
  float n24 = n12 * n12;
  col += uSheen * n24;
  // Light caught inside the rim, in a luminous band along the edge.
  float ld = max(dot(dir, lp), 0.0) * inversesqrt(ll);
  float lit = 0.1 + 0.9 * ld * sqrt(ld);
  float band = exp(min(sd, 0.0) / (0.07 * m + w));
  col += E.rgb * (band * lit * uRim * 0.6);
  // The thin rim line, where light grazes the edge, brighter facing the
  // light; just inside it a warm fringe, the way thick glass splits colour.
  float lw = max(1.3 * gPx, w);
  float e = max(-sd, 0.0);
  float line = exp(-e / lw) * (1.3 * gPx / lw);
  float fw = 2.0 * gPx + w;
  float fringe = exp(-abs(e - 3.5 * gPx - w) / fw) * (2.0 * gPx / fw);
  col += uRimLine * (line * lit);
  col += uFringe * (fringe * (1.0 - lit * 0.5));
  // Glossy streaks: an arc of reflected light just inside the rim on the
  // lit side, and a small hot highlight where the dome mirrors the light.
  if (uGloss > 0.001) {
    float sw = 0.022 * m + w;
    float a = (e - 0.09 * m) / sw;
    float arc = exp(-a * a) * lit * lit * (0.6 * gPx / sw + 0.4);
    float h2 = n24 * n24;
    float h8 = h2 * h2;
    h8 *= h8;
    float hot = h8 * h8 * h8 * n24; // n24^25 = nh^600
    col += uGlossCol * (arc * 0.6 + hot * 0.5);
  }
  // Pebbles out of focus sit further back, in the shadow of those in front.
  return col * E.w;
}

float cover(float sd, float w) {
  return clamp(0.5 - sd / w, 0.0, 1.0);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  gPx = uPixelRatio / uResolution.y;
  gBack = vec2(0.42 * uResolution.y / uResolution.x, -0.9);

  // The frontmost pebble at this pixel.
  int front = -1;
  float fsd;
  vec2 fdir;
  float fslope, ft, fm;
  // A for loop with a break here: as a do-while, SwiftShader gets pixels
  // wrong where the front pebble changes within a 2×2 quad.
  for (int k = int(uCount) - 1; k >= 0; k--) {
    vec2 dir;
    float slope, t, m;
    float sd = shape(k, p, dir, slope, t, m);
    if (sd < 0.5 * (gPx + uPebbles[k * ${STRIDE} + 3].y)) { front = k; fsd = sd; fdir = dir; fslope = slope; ft = t; fm = m; break; }
  }

  vec3 col;
  if (front < 0) {
    col = backdrop(p);
  } else {
    // What the front pebble sees through itself: everything behind,
    // displaced by the dome's slope and softened by the frosting.
    vec2 bend = ((p - uPebbles[front * ${STRIDE}].xy) * 0.45 + fdir * (fslope * inversesqrt(1.0 + fslope * fslope) * fm * 0.35)) * uRefraction;
    // Out of focus, the pebble softens and so does all that is seen in it.
    float blur = uPebbles[front * ${STRIDE} + 3].y;
    float wf = gPx + blur;
    float soft = uFrost + gPx + blur * 0.75;
    // The looks behind it: one bent, or red and blue bent a little apart
    // when the glass splits colour; then, over the rim where the pebble is
    // only partly there, the unbent scene it sits on. Each look is the
    // backdrop with the pebbles behind the front one laid over it, back to
    // front. All of them run in one do-while loop, a pebble at a time, so
    // the costly part is written (and, in software, run) once per pebble
    // rather than once per copy; a for loop's body runs once more than it
    // repeats in software.
    float a = cover(fsd, wf);
    int looks = uChroma > 0.02 ? 2 : 1;
    int last = a < 1.0 ? looks + 1 : looks;
    int per = max(front, 1);
    int look = 0;
    int i = 0;
    vec3 behind = vec3(0.0);
    vec3 under = vec3(0.0);
    do {
      bool rim = look == looks;
      vec2 q = rim ? p : p + bend * (looks == 1 ? 1.0 : look == 0 ? 1.0 - uChroma : 1.0 + uChroma);
      if (i == 0) col = backdrop(q);
      float w = max(rim ? gPx : soft, uPebbles[i * ${STRIDE} + 3].y);
      vec2 dir;
      float slope, t, m;
      float sd = shape(i, q, dir, slope, t, m);
      float c = cover(sd, w);
      if (c > 0.0 && i < front) col = mix(col, shade(i, sd, dir, slope, t, m, q, col, w), c);
      if (++i >= per) {
        if (rim) under = col;
        else behind += looks == 1 ? col : look == 0 ? vec3(col.r, 0.5 * col.g, 0.0) : vec3(0.0, 0.5 * col.g, col.b);
        i = 0;
        look++;
      }
    } while (look < last);
    // Last, the front pebble itself over all that.
    col = mix(under, shade(front, fsd, fdir, fslope, ft, fm, p, behind, wf), a);
  }

  vec3 colour = linearToSrgb(col);
  // Film grain in CSS pixels, centred on zero so it never shifts the tone.
  float n = hash12(floor(gl_FragCoord.xy / uPixelRatio) + floor(uTime * 12.0) * 17.0) + hash12(gl_FragCoord.xy + 71.0) - 1.0;
  colour += n * (uGrain * 0.3 + 1.0 / 255.0);
  fragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

// Where each pebble rests, back to front: centre across the width and up the
// height (-0.5 to 0.5), half width and height (in heights), turn, how much
// squarer or rounder than the rest it is, how densely it absorbs (so some
// read as near-black stones and others as clearer glass), and which way its
// inner light leans, and how far out of focus it falls with depth on. The
// first three make the classic close-up; later ones, in mixed sizes, fill
// the frame around them.
const LAYOUT = [
  [0.06, -0.12, 0.34, 0.46, 0.55, 1.0, 1.3, 0.0, 0.8],
  [-0.22, -0.3, 0.5, 0.56, 0.12, 1.1, 0.8, -1.2, 1.0],
  [0.29, 0.0, 0.42, 0.78, -0.45, 0.9, 0.45, 1.0, 0.35],
  [0.25, 0.5, 0.74, 0.5, 0.15, 0.75, 3.2, -0.3, 0.0],
  [-0.4, 0.36, 0.24, 0.2, -0.5, 1.0, 1.6, 0.9, 0.7],
  [0.03, -0.6, 0.46, 0.36, 0.08, 1.05, 0.5, 0.0, 0.1],
  [-0.5, -0.12, 0.3, 0.46, 0.25, 0.9, 2.2, -0.8, 1.0],
  [0.47, -0.36, 0.18, 0.22, -0.3, 1.1, 0.9, 0.3, 0.5],
];

/**
 * The backdrop gradient's stops as the shader blends them: OKLab colour and
 * position, unused ones repeating the last.
 * @param {import('./runtime.js').Gradient} stops
 */
function rampStops(stops) {
  const g = gradient(stops);
  return [0, 1, 2, 3, 4, 5].map((i) => /** @type {number[]} */ (g[`uStop${i}`]));
}

/**
 * The backdrop's linear colour at p (scene units), as the shader works it
 * out, written into out.
 * @param {number[][]} stops @param {number} x @param {number} y @param {number} aspect @param {number[]} out
 */
function backdropAt(stops, x, y, aspect, out) {
  const at = Math.min(Math.max(0.5 + (x / aspect) * 0.42 - 0.9 * y, 0), 1);
  let L = stops[0][0];
  let A = stops[0][1];
  let B = stops[0][2];
  for (let i = 1; i < 6; i++) {
    const t = Math.min(Math.max((at - stops[i - 1][3]) / Math.max(stops[i][3] - stops[i - 1][3], 1e-4), 0), 1);
    L += (stops[i][0] - L) * t;
    A += (stops[i][1] - A) * t;
    B += (stops[i][2] - B) * t;
  }
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

/** @type {import('./runtime.js').EffectSpec<PebblesOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    // The pointer's eased position and presence, caught as it sets them, so
    // the light can be placed here once a frame rather than in every pixel.
    /** @type {ArrayLike<number>} */
    let at = [0.5, 0.5];
    let active = 0;
    const p = pointer(
      {
        ...ctx,
        uniform(name, value) {
          if (name === 'uPointer') at = /** @type {ArrayLike<number>} */ (value);
          else if (name === 'uPointerActive') active = Number(value);
          ctx.uniform(name, value);
        },
      },
      { ease: 2.5 },
    );
    const data = new Float32Array(MAX * STRIDE * 4);
    const light = [0, 0];
    const col = [0, 0, 0];
    /** @type {import('./runtime.js').Gradient | undefined} */
    let backdrop;
    /** @type {number[][]} */
    let stops = [];
    let glowHex = '';
    let glow = [0, 0, 0];
    // The pointer as the pebbles feel it: eased, so they lean rather than jump.
    const lean = [0, 0, 0];
    return {
      frame(dt, time) {
        p.frame(dt);
        const o = /** @type {PebblesOptions} */ (/** @type {unknown} */ (ctx.options?.() ?? defaults));
        if (o.backdrop !== backdrop) {
          backdrop = o.backdrop;
          stops = rampStops(o.backdrop);
        }
        if (o.glowColor !== glowHex) {
          glowHex = o.glowColor;
          glow = linear(o.glowColor);
        }
        const { width, height } = ctx.canvas;
        const aspect = width / Math.max(height, 1);
        // Light from low on the right, or from the pointer while it is over.
        const on = active * (o.interactive ? 1 : 0);
        light[0] = 0.15 * aspect + ((at[0] - 0.5) * aspect - 0.15 * aspect) * on;
        light[1] = -1.1 + (at[1] - 0.5 + 1.1) * on;
        // The layout is made for a landscape frame. A portrait one gets it
        // turned a quarter, so the pebbles still fill it at a sensible size:
        // positions are worked out across the long side, in units of the
        // short side, then mapped back to heights.
        const portrait = aspect < 1;
        const long = portrait ? 1 / aspect : aspect;
        const unit = portrait ? aspect : 1;
        // Larger on wide frames, so a few pebbles still fill them.
        const scale = o.size * Math.min(Math.max(long / 1.8, 0.75), 1.25) * unit;
        const n = 2 + (1 - o.roundness) * 4.5;
        const t = time * 0.5;
        const r = o.responsiveness;
        const k0 = 1 - Math.exp(-dt * 2.5 * 2 ** ((r - 0.5) * 8));
        const tx = (p.target[0] - 0.5) * aspect;
        const ty = p.target[1] - 0.5;
        const to = p.over && o.interactive ? 1 : 0;
        lean[0] += (tx - lean[0]) * k0;
        lean[1] += (ty - lean[1]) * k0;
        lean[2] += (to - lean[2]) * (1 - Math.exp(-dt * 3));
        const px = lean[0];
        const py = lean[1];
        const over = lean[2];
        // Keep drawing until the lean has settled, even when still.
        if (Math.abs(tx - px) + Math.abs(ty - py) + Math.abs(to - over) > 1e-3) ctx.invalidate();
        for (let i = 0; i < MAX; i++) {
          const [x, y, a, b, turn, sq, density, pool, focus] = LAYOUT[i];
          const ph = i * 1.93;
          const breathe = 1 + 0.035 * Math.sin(t * 0.9 + ph);
          const lx = (x + 0.05 * Math.sin(t * 0.53 + ph)) * long;
          const ly = y + 0.04 * Math.cos(t * 0.41 + ph * 1.3);
          let cx = (portrait ? ly : lx) * unit;
          let cy = (portrait ? lx : ly) * unit;
          // Pebbles lean away from the pointer, the nearer ones more, and
          // the one under it is nudged aside.
          const depth = 0.4 + 0.6 * (i / (MAX - 1));
          const dx = cx - px;
          const dy = cy - py;
          const near = Math.exp(-(dx * dx + dy * dy) * 4) * 0.05 / Math.max(Math.hypot(dx, dy), 0.05);
          cx += (dx * near - px * 0.04 * depth) * over;
          cy += (dy * near - py * 0.04 * depth) * over;
          const angle = turn + 0.14 * Math.sin(t * 0.37 + ph * 0.7) + (portrait ? Math.PI / 2 : 0);
          const w = a * scale * breathe;
          const h = b * scale * breathe;
          const e = Math.max(2, n * sq);
          const m = Math.min(w, h);
          const defocus = o.depth ? focus : 0;
          // The pool of light inside, on the side facing the light, turned
          // its own way in each pebble, and coloured partly by the backdrop
          // on that side.
          let lx2 = light[0] - cx + 1e-4;
          let ly2 = light[1] - cy + 1e-4;
          const len = Math.hypot(lx2, ly2);
          lx2 /= len;
          ly2 /= len;
          const pc = Math.cos(pool);
          const ps = Math.sin(pool);
          const wx = pc * lx2 - ps * ly2;
          const wy = ps * lx2 + pc * ly2;
          const poolX = cx + wx * m * 1.05;
          const poolY = cy + wy * m * 1.05;
          backdropAt(stops, poolX + wx * 0.3, poolY + wy * 0.3, aspect, col);
          const k = i * STRIDE * 4;
          data[k] = cx;
          data[k + 1] = cy;
          data[k + 2] = w;
          data[k + 3] = h;
          data[k + 4] = Math.cos(angle);
          data[k + 5] = Math.sin(angle);
          data[k + 6] = e;
          data[k + 7] = (0.12 * Math.sin(ph * 2.1)) / h;
          data[k + 8] = 1 / e;
          data[k + 9] = Math.min(Math.max(e - 0.5, 2), 4);
          data[k + 10] = m;
          data[k + 11] = 1 + 0.35 / m;
          data[k + 12] = density;
          data[k + 13] = 2 * 0.035 * scale * defocus;
          data[k + 14] = poolX;
          data[k + 15] = poolY;
          data[k + 16] = glow[0] + col[0] * 0.2;
          data[k + 17] = glow[1] + col[1] * 0.2;
          data[k + 18] = glow[2] + col[2] * 0.2;
          data[k + 19] = 1 - 0.5 * defocus;
        }
        ctx.uniform('uPebbles', data);
        ctx.uniform('uLight', light);
      },
      destroy: p.destroy,
    };
  },
  dpr: 1.5,
  time: 6,
  speed: (o) => o.speed,
  update(o) {
    const glass = linear(o.glass);
    const glow = linear(o.glowColor);
    const absorb = (1 - o.clarity) ** 2 * 5;
    const gloss = o.rim * o.rim * (1 - o.frost) ** 2;
    const rimCol = glow.map((c) => c + (1 - c) * 0.75 + 0.05);
    const stops = rampStops(o.backdrop);
    const gap = (/** @type {number} */ i) => 1 / Math.max(stops[i + 1][3] - stops[i][3], 1e-4);
    const lms = stops.map(([L, A, B]) => [L + 0.3963377774 * A + 0.2158037573 * B, L - 0.1055613458 * A - 0.0638541728 * B, L - 0.0894841775 * A - 1.291485548 * B]);
    return {
      uRampA: [stops[0][3], stops[1][3], stops[2][3], stops[3][3]],
      uRampK: [gap(0), gap(1), gap(2), gap(3)],
      uRamp4: [stops[4][3], gap(4)],
      uBack0: lms[0],
      uBackD: lms.slice(1).flatMap((c, i) => [c[0] - lms[i][0], c[1] - lms[i][1], c[2] - lms[i][2], 0]),
      uCount: Math.round(o.count),
      uAbsorbRGB: glass.map((c) => -Math.log(Math.max(c, 0.01)) + absorb),
      uPoolAbsorb: 0.6 + absorb * 0.3,
      uSheen: glow.map((c) => (c * 0.5 + 0.08) * 0.25 * o.rim),
      uRimLine: rimCol.map((c) => c * o.rim * 1.6),
      uFringe: [1, 0.12, 0.3].map((c) => c * o.rim * 0.35 * Math.max(glow[0] + glow[2], 0.3)),
      uGlossCol: rimCol.map((c) => (c * 0.8 + 0.2) * gloss),
      uFrost: 0.002 + o.frost ** 2 * 0.16,
      uRefraction: o.refraction,
      uRim: o.rim,
      uGloss: gloss,
      uChroma: 0.3 * o.refraction * (1 - o.frost) ** 2,
      uGrain: o.grain,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<PebblesOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function pebbles(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
