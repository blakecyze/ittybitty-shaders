// @ts-check
/**
 * ittybitty/slats
 *
 * Light falling across a row of slats: long diagonal bars that catch a soft
 * glow and fade into the dark at their ends, where the light breaks up into
 * grain. The unlit slats keep a thin bright edge. The glow drifts slowly
 * along them, the slats slide, and the pointer carries the light.
 *
 * https://ittybitty.dev/shaders/slats (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} SlatsOptions
 * @property {boolean} showBackground The dark behind the slats. Off, only the light is drawn, over the page.
 * @property {boolean} showSlats The lit faces of the slats.
 * @property {boolean} showEdges The thin bright edge along each slat.
 * @property {boolean} showGrain The grain where light fades into dark.
 * @property {number} speed How fast the light drifts and the slats slide.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} angle Angle of the slats, in degrees.
 * @property {number} count How many slats across the canvas.
 * @property {number} width How far the glow reaches along the slats.
 * @property {number} softness How softly each slat's edges fade.
 * @property {number} glow Size of the pool of light.
 * @property {number} grain How strongly the light breaks up into grain.
 * @property {string} colour Colour of the lit slats.
 * @property {string} highlight Colour where the light is brightest.
 * @property {string} shadow Colour the light falls to in the grain.
 * @property {string} background Colour behind the slats.
 * @property {boolean} interactive The light follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {SlatsOptions} */
export const defaults = {
  showBackground: true,
  showSlats: true,
  showEdges: true,
  showGrain: true,
  speed: 0.4,
  zoom: 1,
  angle: -50,
  count: 13,
  width: 0.5,
  softness: 0.35,
  glow: 0.25,
  grain: 0.6,
  colour: '#d8122c',
  highlight: '#ff9aa8',
  shadow: '#16223e',
  background: '#07080b',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uPixelRatio;
uniform float uTime;
uniform float uShowSlats;
uniform float uShowEdges;
uniform float uShowGrain;
uniform float uTransparent;
uniform float uAngle;
uniform float uCount;
uniform float uWidth;
uniform float uSoftness;
uniform float uGlow;
uniform float uGrain;
uniform vec3 uColour;     // linear RGB
uniform vec3 uHighlight;
uniform vec3 uShadow;
uniform vec3 uBackground;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

// How much of each period a slat fills: they lie close, with a thin gap.
const float SLAT = 0.94;

out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

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
  vec2 uv = zoomed(gl_FragCoord.xy) / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = uTime;

  // Slat space: u runs across the slats, v along them.
  float a = radians(uAngle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 across = vec2(dir.y, -dir.x);
  float u = dot(p, across);
  float v = dot(p, dir);

  // Which slat, and where across it: 0 at its shadowed edge, 1 at its lit
  // edge, where the next slat begins. Slats lie close together, each one
  // resting slightly over the next and shading it.
  float period = 1.6 / max(uCount, 1.0);
  float su = u / period + 0.5;
  float id = floor(su);
  float x = fract(su);
  float h = hash11(id * 7.31 + 3.0);
  float px = 1.0 / (uResolution.y * uZoom * period);
  float soft = mix(px * 1.5, 0.12, uSoftness);
  float face = smoothstep(0.0, soft, x) * smoothstep(1.0, 1.0 - max(soft, 1.0 - SLAT), x);
  // The shadow the neighbouring slat casts along this one's lower edge.
  float shade = mix(0.55, 1.0, smoothstep(0.0, 0.35, x));

  // Where the light falls: a broad pool, drifting on its own or following
  // the pointer, stretched along the slats. Each slat catches it a little
  // further along or short of its neighbours, so the ends of the lit area
  // step and bulge, and they sway slowly.
  vec2 wander = vec2(sin(t * 0.21) * 0.1, cos(t * 0.17) * 0.06) * vec2(aspect, 1.0);
  vec2 hand = (zoomedUv(uPointer) - 0.5) * vec2(aspect, 1.0);
  vec2 centre = mix(wander, hand, uPointerActive * uInteractive);
  vec2 d = p - centre;
  float size = mix(0.25, 0.85, uGlow);
  // Each slat catches the light along its own stretch: a capsule with
  // rounded ends, longest through the middle of the pool and shorter
  // towards its sides, each a little further along or short of its
  // neighbours, swaying slowly.
  float offset = (h - 0.5) * size * 0.6 + (noise(vec2(id * 3.1, t * 0.25)) - 0.5) * size * 0.6;
  float dcSlat = id * period - dot(centre, across);
  float k = dcSlat / (size * 1.4);
  float half_ = size * 0.55 * mix(0.3, 1.7, uWidth) * sqrt(max(1.0 - k * k, 0.0)) * (0.75 + 0.5 * noise(vec2(id * 5.7, t * 0.2)));
  float al = dot(d, dir) + offset;
  vec2 q = vec2(max(abs(al) - half_, 0.0), (x - 0.5 * SLAT) * period);
  float cap = length(q) - 0.5 * SLAT * period;
  float pool = length(vec2(dot(d, dir) / size, dot(d, across) / (size * 1.4)));
  // Flat, full light inside; a soft blur of an edge that breaks up.
  float fr = size * 0.3;
  float lit = half_ > 0.0 ? smoothstep(fr, -fr * 0.35, cap + (noise(vec2(v * 9.0, id)) - 0.5) * fr * 0.5) : 0.0;

  // Grain: in the fading edge the light scatters into fine specks, and
  // passes through a cool shadow tone on its way to the dark. None in full
  // light or full dark.
  float n = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0;
  float fringe = 4.0 * lit * (1.0 - lit);
  float speck = clamp(lit + n * uGrain * uShowGrain * 0.8 * fringe, 0.0, 1.0);
  float light = speck * face * uShowSlats;

  // The heart of the light slowly warms towards the highlight and back.
  float pulse = 0.5 + 0.5 * sin(t * 0.35);
  vec3 red = mix(uColour, uHighlight, smoothstep(0.7, 0.0, pool) * (0.1 + 0.45 * pulse)) * shade;
  vec3 lc = mix(uShadow * 1.6, red, smoothstep(0.1, 0.55, speck));
  float cover = smoothstep(0.0, 0.2, light);
  vec3 colour = uBackground * (1.0 - uTransparent);
  float alpha = 1.0 - uTransparent;
  colour = mix(colour, lc * mix(0.55, 1.0, speck), cover);
  alpha = mix(alpha, 1.0, cover);

  // The rim: a hairline along each slat's lit edge, catching light well
  // beyond the pool, strongest near it.
  float rim = exp(-pow((x - SLAT) / (1.2 * px), 2.0));
  rim *= smoothstep(1.45, 1.0, pool) * (1.0 - lit) * uShowEdges;
  colour += uColour * rim * 0.7;
  alpha = min(alpha + rim * 0.7, 1.0);

  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  c += (hash12(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<SlatsOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 8,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uShowSlats: o.showSlats,
      uShowEdges: o.showEdges,
      uShowGrain: o.showGrain,
      uTransparent: !o.showBackground,
      uAngle: o.angle,
      uCount: o.count,
      uWidth: o.width,
      uSoftness: o.softness,
      uGlow: o.glow,
      uGrain: o.grain,
      uColour: linear(o.colour),
      uHighlight: linear(o.highlight),
      uShadow: linear(o.shadow),
      uBackground: linear(o.background),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SlatsOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function slats(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
