// @ts-check
/**
 * ittybitty/metaballs
 *
 * Gooey blobs that drift, merge and pinch apart. Finished flat, as soft
 * glass, or as chrome; the surface normal comes straight from the field's
 * analytic gradient, so shading costs almost nothing extra.
 *
 * https://ittybitty.dev/shaders/metaballs (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} MetaballsOptions
 * @property {boolean} showBackground The colour behind the blobs. Off, only the blobs are drawn, over the page.
 * @property {number} speed How fast the blobs drift.
 * @property {number} count Number of blobs, 2 to 8.
 * @property {number} size Size of each blob.
 * @property {number} goo How readily blobs merge.
 * @property {'flat' | 'glass' | 'chrome' | 'outline'} finish Surface finish, or just the outline.
 * @property {boolean} interactive One blob follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 * @property {string} colorA Colour at the top.
 * @property {string} colorB Colour at the bottom.
 * @property {string} background Colour behind the blobs.
 */

/** @type {MetaballsOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.4,
  count: 6,
  size: 0.14,
  goo: 0.6,
  finish: 'glass',
  colorA: '#ff8a5c',
  colorB: '#7b5cff',
  background: '#f1eee8',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uCount;
uniform float uSize;
uniform float uGoo;
uniform float uFinish;    // 0 flat, 1 glass, 2 chrome
uniform vec3 uColorA;     // linear RGB
uniform vec3 uColorB;
uniform vec3 uBackground;
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// The blobs' centres, computed once per pixel and shared by the field and its shadow.
vec2 centres[8];

void place(float aspect, float t) {
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    vec2 c = vec2(
      aspect * (0.5 + 0.34 * sin(t * (0.5 + fi * 0.13) + fi * 2.1)),
      0.5 + 0.3 * cos(t * (0.6 + fi * 0.11) + fi * 1.3)
    );
    // The first blob follows the pointer.
    if (i == 0) c = mix(c, uPointer * vec2(aspect, 1.0), uPointerActive * uInteractive);
    centres[i] = c;
  }
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = gl_FragCoord.xy / uResolution.y;
  float t = uTime * 0.5;
  place(aspect, t);

  // Field f = Σ r²/d², and its exact gradient, in one loop.
  float f = 0.0;
  float fShadow = 0.0;
  vec2 grad = vec2(0.0);
  float r2 = uSize * uSize;
  vec2 ps = p + vec2(-0.012, 0.022);
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uCount) break;
    // The contact shadow's field, down and to the right, in the same pass.
    vec2 ds = ps - centres[i];
    fShadow += r2 / (dot(ds, ds) + 1e-5);
    vec2 d = p - centres[i];
    float dd = dot(d, d) + 1e-5;
    f += r2 / dd;
    grad -= 2.0 * r2 * d / (dd * dd);
  }

  // Goo sets the iso-level: lower merges earlier and thicker.
  float level = mix(1.6, 0.7, uGoo);
  float edge = fwidth(f);
  float inside = smoothstep(level - edge, level + edge, f);

  vec3 base = mix(uColorB, uColorA, clamp(p.y, 0.0, 1.0));
  // One continuous surface: the field becomes a dome, 0 at the edge and
  // rising smoothly inside, so no highlight gathers at each ball's centre.
  float s = clamp(1.0 - level / max(f, 1e-4), 1e-3, 1.0);
  float h = sqrt(s);
  vec2 slope = (0.5 / h) * (level / (f * f)) * grad;
  vec3 n = normalize(vec3(-slope * uSize * 1.4, 1.0));
  vec3 light = normalize(vec3(-0.45, 0.6, 0.66));
  vec3 colour;
  if (uFinish < 0.5) {
    colour = base;
  } else if (uFinish < 1.5) {
    // Glossy liquid: wrapped light, a studio window mirrored in the surface,
    // a fresnel rim, one crisp highlight, and light glowing through thin edges.
    float wrap = max(dot(n, light) * 0.5 + 0.5, 0.0);
    vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
    float window = smoothstep(0.55, 0.75, r.y) * smoothstep(0.1, -0.25, r.x) * smoothstep(0.95, 0.75, r.y);
    float spec = pow(max(dot(r, light), 0.0), 24.0);
    float rim = pow(1.0 - n.z, 3.0);
    float thin = 1.0 - smoothstep(0.0, 0.35, h);
    colour = base * (0.55 + 0.6 * wrap);
    colour += mix(base, vec3(1.0), 0.5) * thin * 0.35;
    colour += vec3(1.0) * (window * 0.35 + spec * 0.35);
    colour = mix(colour, mix(base, vec3(1.0), 0.65), rim * 0.55);
  } else if (uFinish > 2.5) {
    // Outline: a crisp line along the surface, and nothing inside.
    float line = 1.0 - smoothstep(0.0, 1.5 * edge, abs(f - level) - edge);
    colour = base;
    inside = line;
  } else {
    vec3 r = reflect(vec3(0, 0, -1), n);
    float sky = smoothstep(-0.3, 0.8, r.y);
    colour = mix(base * 0.15, mix(base, vec3(1.0), 0.6), sky) + exp(-pow((r.y - 0.4) * 8.0, 2.0)) * 0.9;
  }
  if (uTransparent > 0.5) {
    fragColor = vec4(linearToSrgb(colour) * inside, inside);
    return;
  }
  // A soft contact shadow on the page, down and to the right of the light.
  float shade = smoothstep(level * 0.35, level * 1.1, fShadow);
  vec3 ground = uBackground * (1.0 - 0.18 * shade * step(0.5, uFinish) * step(uFinish, 2.5));
  colour = mix(ground, colour, inside);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const FINISHES = { flat: 0, glass: 1, chrome: 2, outline: 3 };

/** @type {import('./runtime.js').EffectSpec<MetaballsOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  attach(ctx) {
    const p = pointer(ctx, { ease: 6 });
    return { frame: p.frame, destroy: p.destroy };
  },
  dpr: 1.5,
  time: 2,
  speed: (o) => o.speed,
  update(o) {
    return {
      uCount: o.count,
      uSize: o.size,
      uGoo: o.goo,
      uFinish: FINISHES[o.finish] ?? 0,
      uColorA: linear(o.colorA),
      uColorB: linear(o.colorB),
      uBackground: linear(o.background),
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<MetaballsOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function metaballs(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
