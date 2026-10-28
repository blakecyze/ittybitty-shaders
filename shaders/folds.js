// @ts-check
/**
 * ittybitty/folds
 *
 * A few huge sheets of dark, glossy material seen very close and out of
 * focus, like a macro shot of folded glass or a curved screen. Each sheet
 * curls away from its edge, so a broad, soft highlight rolls across it and
 * sinks into deep black, and where one sheet lies over another a thin sliver
 * of light catches the fold. Sheets further back are more out of focus, and
 * a fine grain gives it a photographic finish.
 *
 * https://ittybitty.dev/shaders/folds (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} FoldsOptions
 * @property {number} speed How fast the sheets drift and the light slides over them.
 * @property {number} sheets How many sheets are layered, from two to six.
 * @property {number} gloss Size of the highlights. Higher is a broader, softer light.
 * @property {number} edge Brightness of the thin line of light along each fold.
 * @property {number} softness How far out of focus the sheets behind and in front are.
 * @property {number} curvature How tightly each sheet curls away from its edge.
 * @property {number} angle Where the key light comes from, in degrees.
 * @property {number} exposure Overall brightness of the light.
 * @property {number} grain Strength of the film grain.
 * @property {string} light Colour of the key light.
 * @property {string} accent Colour of the second light, from the other side.
 * @property {string} shadow Colour of the material where no light reaches it.
 * @property {boolean} interactive The light follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {FoldsOptions} */
export const defaults = {
  speed: 0.3,
  sheets: 4,
  gloss: 0.3,
  edge: 0.6,
  softness: 0.5,
  curvature: 1,
  angle: 150,
  exposure: 1,
  grain: 0.5,
  light: '#6ea8f0',
  accent: '#8c86e8',
  shadow: '#030409',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform vec3 uLight, uAccent, uShadow; // linear
uniform float uEdge;
uniform float uExposure;
uniform float uGrain;
// Worked out once a frame on the CPU (see frameUniforms below).
uniform vec4 uView;     // zoom, gloss sharpness, sheet count, unused
uniform vec4 uDirs;     // key light direction, accent light direction
uniform vec3 uHk, uHa;  // half vectors of the two lights, times the sharpness
uniform vec4 uPools;    // the key's pool centre, the accent's upper pool
uniform vec2 uPoolB;    // the accent's lower pool
// The sheets in play, front first. 0: edge centre, edge direction.
// 1: bend, defocus, tilt at the edge (with its slow breathing), wobble phase.
// 2: total turn, how quickly it turns, curl along the edge and its offset.
uniform vec4 uS0[6], uS1[6], uS2[6];

out vec4 fragColor;

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  // pow, as exp2 and log2: the same, and cheaper on a software renderer.
  return mix(c * 12.92, 1.055 * exp2(log2(c) * (1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  float px = uView.x / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  float sharp = uView.y;

  // Two big soft lights low over the surface: the key, and an accent from
  // the far side. Each falls off across the frame, so its pool is uneven;
  // the accent is a tall softbox, two pools with darkness between.
  vec2 dk = p - uPools.xy;
  vec2 da = p - uPools.zw;
  vec2 db = p - uPoolB;
  float kPool = 0.03 + 2.0 * exp(-dot(dk, dk) * 1.8);
  float aPool = 0.01 + 1.8 * exp(-dot(da, da) * 5.0) + 3.5 * exp(-dot(db, db) * 5.0);
  // Away from its centre the key light takes on the accent's hue, the way
  // a big softbox's spill picks up the room.
  vec3 key = mix(uAccent, uLight, smoothstep(0.05, 0.75, kPool));
  vec3 rimColour = mix(key, vec3(1.0), 0.35) * (1.6 * uEdge);

  // Front to back: what each sheet shows, through whatever lies in front,
  // until a sheet covers the pixel entirely and nothing behind can show.
  vec3 col = vec3(0.0);
  float through = 1.0;
  // Tested at the end, not the start: a software renderer runs a loop's
  // body once more, with every pixel masked off, to find out a test at the
  // start has failed. There are always at least two sheets.
  int count = int(uView.z);
  for (int i = 0; ; ) {
    vec4 A = uS0[i];
    vec4 B = uS1[i];
    vec2 tg = A.zw;
    vec2 n = vec2(tg.y, -tg.x);
    vec2 q = p - A.xy;
    float s = dot(q, tg);
    // Signed distance to a gently bent edge, positive inside the sheet,
    // and the edge's normal, which share one square root.
    float bs = B.x * s;
    float r = inversesqrt(1.0 + 4.0 * bs * bs);
    float d = (dot(q, n) - bs * s) * r;
    // Out of focus by depth: the further back, the wider the edge blur.
    float w = 1.5 * px + B.y;
    // Unless neither the sheet nor its shadow reaches here.
    if (d > -0.07 - w) {
      vec2 g = (n - 2.0 * bs * tg) * r;
      float cover = smoothstep(-w, w, d);

      // The sheet curls away from its edge: tilted towards outside at the
      // edge, turning through facing us and on, then flattening out. The
      // light slides slowly across each fold as it breathes.
      vec4 C = uS2[i];
      float di = max(d, 0.0);
      float th = B.z - C.x * tanh(di * C.y) + 0.18 * sin(s * 2.1 + B.w);
      float ph = clamp(C.z * s - C.w, -1.2, 1.2);
      vec3 N = normalize(vec3(tg * sin(ph) - g * sin(th), cos(th) * cos(ph)));

      float sk = exp(dot(N, uHk) - sharp) * kPool;
      float sa = exp(dot(N, uHa) - sharp) * aPool;
      // A thin sliver of light where the sheet folds over the edge, brightest
      // where the edge faces a light.
      float face = max(-dot(g, uDirs.xy), 0.0) * kPool + 0.6 * max(-dot(g, uDirs.zw), 0.0) * aPool;
      float rim = exp(-di / (2.5 * px + w * 0.6)) * face / (1.0 + w * 40.0);
      vec3 lit = key * (sk * 1.6) + uAccent * (sa * 0.6) + rimColour * rim;

      col += (through * cover) * (uShadow + lit * uExposure);
      // A soft contact shadow on whatever lies behind, just outside the edge.
      float open = 1.0 - cover;
      through *= open * (1.0 - 0.45 * smoothstep(-0.07 - w, 0.0, d) * open);
    }
    if (++i >= count || through <= 0.0) break;
  }
  col += through * uShadow;

  // Film-like roll-off per channel: saturated in the mid-tones, paling
  // towards white in the highlights.
  col = 1.0 - exp(-col * 1.15);
  vec3 colour = linearToSrgb(col);
  // Static grain in CSS pixels, strongest in the mid-tones, centred on zero.
  float n = hash12(floor(gl_FragCoord.xy / uPixelRatio)) + hash12(gl_FragCoord.xy + 71.0) - 1.0;
  float l = dot(colour, vec3(0.3, 0.5, 0.2));
  colour += n * (uGrain * 0.22 * (0.25 + 1.4 * l * (1.0 - l)) + 1.0 / 255.0);
  fragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

// Six sheets, back to front. RANK says which come first as the count
// rises: the front fold, the dome behind it, then the rest; five and six
// add huge, blurred sheets right in front of the lens.
const RANK = [4, 2, 1, 3, 5, 6];
// Each sheet's own phase for its drift and wobble.
const PHASE = [2, 3, 4, 5, 0, 1];
// Per sheet: edge centre (x, y in screen heights), edge direction
// (radians), bend; defocus, tilt at the edge, total turn, how quickly it
// turns; curl along the edge and where it is level, so a sheet can dome.
const SHEETS = [
  [0.2, 0.0, -2.09, 0.1, 0.1, -0.4, 0.4, 2.0, 0.2, 0.0],
  [-0.25, 0.31, -1.63, 0.1, 0.012, 0.35, 0.92, 3.4, 0.75, 0.45],
  [-0.4, 0.0, 1.08, 0.06, 0.0, 0.78, 1.7, 5.2, -0.15, 0.0],
  [0.55, 0.0, 0.42, 0.18, 0.22, -0.1, 0.75, 2.2, 0.3, 0.0],
  [-0.5, -0.3, -0.64, 0.3, 0.3, 0.6, 1.3, 2.5, 0.4, 0.0],
  [0.55, 0.34, 2.62, 0.3, 0.26, 0.5, 1.3, 2.5, 0.4, 0.0],
];

/**
 * The light rig and each sheet's place this frame: everything that is the
 * same for every pixel, worked out once here rather than per pixel.
 * Writes into `out`, which holds the uniforms by name; allocates nothing.
 * @param {FoldsOptions} o
 * @param {number} time Effect time in seconds.
 * @param {number} width Drawing buffer size, for the framing.
 * @param {number} height
 * @param {number} px Eased pointer, 0..1 across.
 * @param {number} py Eased pointer, 0..1 up.
 * @param {number} active How far the pointer is over the canvas, 0..1.
 * @param {Frame} out
 */
function frameUniforms(o, time, width, height, px, py, active, out) {
  // Framed for landscape; narrower frames pull back a little, so a phone
  // still sees the folds meet rather than one sliver of a single sheet.
  const zoom = Math.max(1, (1.6 * height) / width) ** 0.7;
  const aspect = (width / height) * zoom;
  const t = time * 0.2;
  const follow = (o.interactive ? 1 : 0) * active;
  // The pointer swings the key round towards itself.
  const a = (o.angle * Math.PI) / 180 - follow * (px - 0.5) * 1.2;
  const kx = Math.cos(a), ky = Math.sin(a);
  const ax = -Math.cos(a - 0.4), ay = -Math.sin(a - 0.4);
  const sharp = 32 + (5 - 32) * o.gloss;
  out.uView[0] = zoom;
  out.uView[1] = sharp;
  out.uDirs[0] = kx; out.uDirs[1] = ky; out.uDirs[2] = ax; out.uDirs[3] = ay;
  half(kx, ky, sharp, out.uHk);
  half(ax, ay, sharp, out.uHa);
  const m = follow * 0.6;
  const kAx = kx * 0.55 * aspect * (1 - m) + (px - 0.5) * aspect * m;
  const kAy = ky * 0.9 * (1 - m) + (py - 0.5) * zoom * m;
  out.uPools[0] = kAx; out.uPools[1] = kAy;
  out.uPools[2] = -0.75 * kAx; out.uPools[3] = 1.3 * kAy;
  out.uPoolB[0] = -1.1 * kAx; out.uPoolB[1] = -1.3 * kAy;

  // The sheets in play, front first, each drifting and turning a little on
  // its own clock.
  const curve = o.curvature;
  let n = 0;
  for (let i = 5; i >= 0; i--) {
    if (RANK[i] > o.sheets + 0.5) continue;
    const S = SHEETS[i];
    const fi = PHASE[i];
    const ang = S[2] + 0.12 * (Math.sin(t * 0.41 + fi * 1.1) - Math.sin(fi * 1.1));
    const k = n * 4;
    out.uS0[k] = S[0] + 0.09 * (Math.sin(t * 0.7 + fi * 1.7) - Math.sin(fi * 1.7));
    out.uS0[k + 1] = S[1] + 0.09 * (Math.cos(t * 0.53 + fi * 2.3) - Math.cos(fi * 2.3));
    out.uS0[k + 2] = Math.cos(ang);
    out.uS0[k + 3] = Math.sin(ang);
    out.uS1[k] = S[3] * curve;
    out.uS1[k + 1] = o.softness * S[4];
    out.uS1[k + 2] = S[5] + 0.22 * (Math.sin(t * 0.45 + fi * 1.3) - Math.sin(fi * 1.3));
    out.uS1[k + 3] = t * 0.9 + fi * 2.0;
    out.uS2[k] = S[6];
    out.uS2[k + 1] = (S[7] * curve) / S[6];
    out.uS2[k + 2] = S[8] * curve;
    out.uS2[k + 3] = S[8] * curve * S[9];
    n++;
  }
  out.uView[2] = n;
}

/**
 * Half vector between a light low over the surface and the viewer, scaled
 * by the gloss sharpness.
 * @param {number} x @param {number} y @param {number} sharp @param {Float32Array} out
 */
function half(x, y, sharp, out) {
  const l = 1 / Math.hypot(x * 0.95, y * 0.95, 0.3);
  const hx = x * 0.95 * l, hy = y * 0.95 * l, hz = 0.3 * l + 1;
  const k = sharp / Math.hypot(hx, hy, hz);
  out[0] = hx * k;
  out[1] = hy * k;
  out[2] = hz * k;
}

/** @typedef {{ uView: Float32Array, uDirs: Float32Array, uHk: Float32Array, uHa: Float32Array, uPools: Float32Array, uPoolB: Float32Array, uS0: Float32Array, uS1: Float32Array, uS2: Float32Array }} Frame */

/** @type {import('./runtime.js').EffectSpec<FoldsOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    // The pointer's eased values, caught on their way to the shader: the
    // lights and sheets are worked out here, once per frame.
    const look = [0.5, 0.5, 0];
    const p = pointer(
      {
        ...ctx,
        uniform(name, value) {
          if (name === 'uPointer') {
            const v = /** @type {ArrayLike<number>} */ (value);
            look[0] = v[0];
            look[1] = v[1];
          } else if (name === 'uPointerActive') look[2] = Number(value);
        },
      },
      { ease: 2.5 },
    );
    /** @type {Frame} */
    const out = {
      uView: new Float32Array(4),
      uDirs: new Float32Array(4),
      uHk: new Float32Array(3),
      uHa: new Float32Array(3),
      uPools: new Float32Array(4),
      uPoolB: new Float32Array(2),
      uS0: new Float32Array(24),
      uS1: new Float32Array(24),
      uS2: new Float32Array(24),
    };
    let o = defaults;
    return {
      update(next) {
        o = next;
      },
      frame(dt, time) {
        p.frame(dt);
        frameUniforms(o, time, ctx.canvas.width, ctx.canvas.height, look[0], look[1], look[2], out);
        for (const name in out) ctx.uniform(name, out[/** @type {keyof Frame} */ (name)]);
      },
      destroy: p.destroy,
    };
  },
  dpr: 1.5,
  time: 0,
  speed: (o) => o.speed,
  update(o) {
    return {
      uLight: linear(o.light),
      uAccent: linear(o.accent),
      uShadow: linear(o.shadow),
      uEdge: o.edge,
      uExposure: o.exposure,
      uGrain: o.grain,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<FoldsOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function folds(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
