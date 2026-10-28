// @ts-check
/**
 * ittybitty/swoosh
 *
 * Satin ribbons of light sweeping through the dark. Each ribbon twists as it
 * travels, so it narrows to an edge and opens out again, catching a hot
 * highlight across its curve and throwing a soft glow on the dark around it.
 * Finished with fine, static film grain.
 *
 * https://ittybitty.dev/shaders/swoosh (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

export const defaults = {
  /** The colour behind the ribbons. Off, only the ribbons are drawn, over the page. */
  showBackground: true,
  speed: 0.25,
  zoom: 1,
  ribbons: 3,
  width: 0.075,
  flow: 1,
  twist: 1,
  glow: 0.5,
  grain: 0.5,
  angle: -18,
  color: '#ff3d00',
  highlight: '#ffb27a',
  background: '#0c0908',
  /** The ribbons bend away from the pointer. */
  interactive: true,
  responsiveness: 0.5,
};

/** @typedef {typeof defaults} SwooshOptions */

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uTime;
uniform float uRibbons;
uniform float uWidth;     // half-width of a ribbon, in units of canvas height
uniform float uFlow;      // how far the ribbons swing
uniform float uTwist;
uniform float uGlow;
uniform float uGrain;
uniform float uAngle;     // radians
uniform vec3 uColor;      // linear RGB
uniform vec3 uHighlight;
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

// Zoom about the middle of the canvas: a pixel, or a point in 0..1 canvas
// space (such as the pointer), as the zoomed view sees it.
vec2 zoomed(vec2 fc) {
  return (fc - 0.5 * uResolution) / uZoom + 0.5 * uResolution;
}

vec2 zoomedUv(vec2 uv) {
  return (uv - 0.5) / uZoom + 0.5;
}

void main() {
  vec2 uv = (zoomed(gl_FragCoord.xy) - 0.5 * uResolution) / uResolution.y;
  float t = uTime;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 p = mat2(c, s, -s, c) * uv;

  // The pointer presses the ribbons aside, like a hand through fabric.
  if (uInteractive * uPointerActive > 0.0) {
    vec2 at = mat2(c, s, -s, c) * ((zoomedUv(uPointer) - 0.5) * vec2(uResolution.x / uResolution.y, 1.0));
    vec2 d = p - at;
    p.y += sign(d.y) * 0.12 * exp(-dot(d, d) * 9.0) * uPointerActive;
  }

  float px = 1.5 / uResolution.y;
  vec3 light = vec3(0.0);   // glow thrown on the dark
  vec3 colour = uBackground;
  float cover = 0.0;
  float count = floor(uRibbons + 0.5);

  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float ph = fi * 2.17 + 0.6;
    float lane = (fi - (count - 1.0) * 0.5) * 0.16;
    float x = p.x;
    // A long swing and a shorter ripple, each at its own pace.
    float centre = lane
      + uFlow * (0.24 * sin(x * 1.25 + t * 0.55 + ph) + 0.09 * sin(x * 2.9 - t * 0.4 + ph * 1.7));
    // The twist: the ribbon's visible width runs from an edge to full face.
    float turn = cos(x * 1.7 * uTwist + t * 0.45 + ph * 1.3);
    float face = abs(turn);
    float w = uWidth * (0.12 + 0.88 * face);
    float d = p.y - centre;
    float across = clamp(d / w, -1.0, 1.0) * sign(turn);

    // Light on a curved band: brightest at its crest, a hot line where the
    // curve faces the light, darker as it turns edge-on.
    float round = 1.0 - across * across;
    float body = 0.04 + 0.96 * round * round;
    float spec = pow(max(1.0 - abs(across - 0.35) * 3.2, 0.0), 10.0);
    vec3 ribbon = uColor * body * mix(0.06, 1.0, face * face) + uHighlight * spec * 2.2 * face;
    // Edge-on sections glint along their thin line.
    ribbon += mix(uColor, uHighlight, 0.45) * pow(1.0 - face, 3.0) * 1.1 * round;

    // Silk, not plastic: the edges feather out rather than cut.
    float inside = smoothstep(w + px, w * 0.7 - px, abs(d));
    light += uColor * uGlow * 0.14 * exp(-max(abs(d) - w, 0.0) * 16.0) * face;
    colour = mix(colour, ribbon, inside);
    cover = max(cover, inside);
  }

  colour += light * (1.0 - cover);
  // Soft shoulder, so highlights bloom instead of clipping.
  colour = colour / (1.0 + max(max(colour.r, colour.g), colour.b) * 0.35);
  vec3 srgb = linearToSrgb(colour);
  // Static grain: the pattern never moves, so it reads as texture, not noise.
  srgb += (hash12(gl_FragCoord.xy) - 0.5) * uGrain * 0.12;
  if (uTransparent > 0.5) {
    float a = clamp(max(cover, max(max(light.r, light.g), light.b)), 0.0, 1.0);
    fragColor = vec4(srgb * a, a);
    return;
  }
  fragColor = vec4(srgb, 1.0);
}
`;

/** @type {import('./runtime.js').EffectSpec<SwooshOptions>} */
const base = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 8,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uRibbons: o.ribbons,
      uWidth: o.width,
      uFlow: o.flow,
      uTwist: o.twist,
      uGlow: o.glow,
      uGrain: o.grain,
      uAngle: (o.angle * Math.PI) / 180,
      uColor: linear(o.color),
      uHighlight: linear(o.highlight),
      uBackground: linear(o.background),
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SwooshOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function swoosh(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
