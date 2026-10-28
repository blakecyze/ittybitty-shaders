// @ts-check
/**
 * ittybitty/liquid-glass
 *
 * A slab of liquid glass over an image: its rounded bevel bends the picture
 * beneath, splits colour at the edges, frosts the interior, and catches a rim
 * of light. It follows the pointer, or drifts when there is none.
 *
 * https://ittybitty.dev/shaders/liquid-glass (MIT)
 */
import { mount } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} LiquidGlassOptions
 * @property {boolean} showImage The picture around the glass. Off, only the glass is drawn, over the page.
 * @property {boolean} showGlass The glass shape bending the picture.
 * @property {string} image Image behind the glass. Needs CORS headers if cross-origin.
 * @property {number} speed Drift speed when there is no pointer. 0 holds it centred.
 * @property {number} width Width of the glass, relative to canvas height.
 * @property {number} height Height of the glass, relative to canvas height.
 * @property {number} radius Corner radius, relative to the glass's shorter side.
 * @property {number} refraction How strongly the bevel bends the image.
 * @property {number} dispersion Colour splitting at the edges.
 * @property {number} frost Blur inside the glass.
 * @property {boolean} follow Follow the pointer.
 * @property {'pill' | 'circle' | 'blob'} shape The glass's form: a rounded bar, a circle, or drops that melt together. In a shaped stack (layers.js) the stack's shape is the glass instead.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {LiquidGlassOptions} */
export const defaults = {
  showImage: true,
  showGlass: true,
  image: '',
  speed: 0.3,
  width: 0.62,
  height: 0.36,
  radius: 1,
  refraction: 0.7,
  dispersion: 0.4,
  frost: 0.25,
  follow: true,
  shape: 'pill',
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uShowImage;
uniform float uShowGlass;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uFollow;
uniform vec2 uSize;        // glass size, in canvas heights
uniform float uRadius;
uniform float uRefraction;
uniform float uDispersion;
uniform float uFrost;
uniform float uShape;     // 0 pill, 1 circle, 2 blob

out vec4 fragColor;

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The picture behind the glass. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) return vec4(mix(vec3(0.9, 0.86, 0.8), vec3(0.3, 0.35, 0.5), uv.y), 1.0);
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

// Distance to the stack's shape in CSS pixels, negative inside; layers.js
// supplies it, and then the shape is the glass. Alone there is none.
// @edge
float glassEdge(vec2 frag) {
  return 1e4;
}
// @end

// The glass outline: a rounded bar, a circle, or three drops melting together.
vec2 H;
float R;
float T;
float shape(vec2 q) {
  if (uShape < 0.5) return sdRoundRect(q, H, R);
  float s = min(H.x, H.y);
  if (uShape < 1.5) return length(q) - s;
  vec2 a = vec2(sin(T * 0.8), cos(T * 0.6)) * s * 0.55;
  vec2 b = vec2(cos(T * 0.7 + 2.0), sin(T * 0.9 + 1.0)) * s * 0.6;
  float d1 = length(q - a) - s * 0.62;
  float d2 = length(q - b) - s * 0.55;
  float d3 = length(q + a * 0.8) - s * 0.5;
  float k = s * 0.45;
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  float m = mix(d2, d1, h) - k * h * (1.0 - h);
  h = clamp(0.5 + 0.5 * (d3 - m) / k, 0.0, 1.0);
  return mix(d3, m, h) - k * h * (1.0 - h);
}

vec3 backdrop(vec2 uv, float blur) {
  return source(uv * uResolution, blur).rgb;
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = uv * vec2(aspect, 1.0);

  float t = uTime * 0.5;
  vec2 drift = vec2(0.5 + 0.18 * sin(t * 0.7), 0.5 + 0.12 * sin(t * 1.1));
  vec2 centre = mix(drift, uPointer, uPointerActive * uFollow) * vec2(aspect, 1.0);

  vec2 half_ = 0.5 * uSize;
  float r = uRadius * min(half_.x, half_.y);
  H = half_;
  R = r;
  T = t;
  vec2 q = p - centre;
  float d = shape(q);
  float bevel = min(half_.x, half_.y) * 0.3;
  float edge = clamp(1.0 + d / bevel, 0.0, 1.0);            // 1 at the rim, 0 inside
  float e = 1e-3;
  vec2 grad = vec2(shape(q + vec2(e, 0.0)) - d, shape(q + vec2(0.0, e)) - d) / e;
  float shadow = 0.28 * exp(-max(d + 0.02, 0.0) * 22.0) * step(0.0, d);
  float shaped = glassEdge(gl_FragCoord.xy);
  if (shaped < 1e3) {
    // The stack's shape is the glass: its distance field, in canvas heights,
    // is the outline and, a little way in, the glass's full thickness.
    float h = uResolution.y / uPixelRatio;
    d = shaped / h;
    vec2 g = vec2(glassEdge(gl_FragCoord.xy + vec2(1.0, 0.0)) - glassEdge(gl_FragCoord.xy - vec2(1.0, 0.0)),
                  glassEdge(gl_FragCoord.xy + vec2(0.0, 1.0)) - glassEdge(gl_FragCoord.xy - vec2(0.0, 1.0)));
    grad = normalize(g + 1e-6);
    edge = 1.0 - smoothstep(0.0, 0.05, -d);
    // A soft shadow, offset down and right.
    float caster = glassEdge(gl_FragCoord.xy + vec2(-6.0, 12.0) * uPixelRatio) / h;
    shadow = 0.28 * exp(-max(caster + 0.01, 0.0) * 22.0) * step(0.0, d);
    q = (uv - 0.5) * vec2(aspect, 1.0) * 0.3;
  }

  // Soft shadow the glass casts on the image.
  // Premultiplied: without the picture around it, the glass floats on the page.
  vec3 colour = backdrop(uv, 0.0) * uShowImage;
  float alpha = uShowImage;
  colour *= 1.0 - shadow;

  if (d < 0.0) {
    // Bevel: the outer band of the glass tilts, the middle is flat.
    float tilt = edge * edge;
    // Refraction pulls the image inward at the rim; the flat centre magnifies slightly.
    vec2 offset = -grad * tilt * uRefraction * 0.05 - q / aspect * 0.04 * uRefraction;
    offset.x /= aspect;
    float blur = uFrost * 4.0;
    vec3 glass = vec3(
      backdrop(uv + offset * (1.0 + uDispersion * 0.35), blur).r,
      backdrop(uv + offset, blur).g,
      backdrop(uv + offset * (1.0 - uDispersion * 0.35), blur).b
    );
    // A clear, slightly brightened body with a lit rim and a darker far edge.
    glass = glass * 1.03 + 0.015;
    float light = dot(grad, normalize(vec2(-0.6, 0.8)));
    glass += vec3(1.0) * pow(edge, 10.0) * max(light, 0.0) * 0.6;
    glass -= vec3(0.1) * pow(edge, 6.0) * max(-light, 0.0);
    float aa = clamp(-d * uResolution.y, 0.0, 1.0);
    aa *= uShowGlass;
    colour = mix(colour, glass, aa);
    alpha = mix(alpha, 1.0, aa);
  }
  fragColor = vec4(clamp(colour, 0.0, 1.0) * (alpha > 0.0 ? 1.0 : 0.0), alpha);
}
`;

const SHAPES = { pill: 0, circle: 1, blob: 2 };

/** @type {import('./runtime.js').EffectSpec<LiquidGlassOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 3,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowImage: o.showImage,
      uShowGlass: o.showGlass,
      uSize: [o.width, o.height],
      uRadius: o.radius,
      uRefraction: o.refraction,
      uDispersion: o.dispersion,
      uFrost: o.frost,
      uFollow: o.follow,
      uShape: SHAPES[o.shape] ?? 0,
    };
  },
  attach(ctx) {
    // Mipmaps make the frost a cheap LOD bias instead of a blur pass.
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 8 });
    return {
      update(o) {
        image.set(o.image);
      },
      frame: p.frame,
      restore: image.restore,
      destroy() {
        image.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<LiquidGlassOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function liquidGlass(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
