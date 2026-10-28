// @ts-check
/**
 * ittybitty/page-curl
 *
 * The page, an image or the layers beneath, peels back from a corner. The
 * sheet wraps around a cylinder along a fold line: points before the line
 * lie flat, points past it roll over the cylinder and come back flipped,
 * showing the paper's reverse. For each pixel the shader solves which part
 * of the sheet lands there, topmost first (the flat back, the far side of
 * the roll, its near side, the flat front), and where none does, what is
 * underneath shows through, your page or a colour. The roll is shaded as a
 * curved surface, the reverse carries the print faintly through the paper,
 * and the curl casts a soft shadow on what it reveals.
 *
 * The corner follows the pointer, peeling further the further it is drawn,
 * and when left alone breathes gently at rest.
 *
 * https://ittybitty.dev/shaders/page-curl (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} PageCurlOptions
 * @property {boolean} showUnder What lies underneath the page. Off, the page peels away from nothing, over your page.
 * @property {boolean} showShadow The shadow the curl casts.
 * @property {boolean} showThrough The print showing faintly through the back of the paper.
 * @property {string} image The page. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'bottom-right' | 'top-right' | 'bottom-left' | 'top-left'} corner Corner the page peels from.
 * @property {number} curl How far the page peels at rest.
 * @property {number} radius How tightly the page rolls.
 * @property {number} speed How fast the corner breathes at rest. 0 holds it still.
 * @property {string} back Colour of the back of the paper.
 * @property {string} under Colour underneath the page.
 * @property {boolean} interactive The corner follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {PageCurlOptions} */
export const defaults = {
  showUnder: true,
  showShadow: true,
  showThrough: true,
  image: '',
  corner: 'bottom-right',
  curl: 0.22,
  radius: 0.5,
  speed: 0.5,
  back: '#f3efe7',
  under: '#2a2622',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uShowUnder;
uniform float uShowShadow;
uniform float uShowThrough;
uniform vec2 uCorner;       // 0 or 1 in x and y
uniform float uCurl;
uniform float uRadius;
uniform vec3 uBack;         // linear RGB
uniform vec3 uUnder;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

// The page. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A page of type: a title, lines of text, a picture block.
    vec2 q = uv * vec2(uResolution.x / uResolution.y, 1.0);
    vec3 c = vec3(0.97, 0.95, 0.91);
    float margin = step(0.08, uv.x) * step(uv.x, 0.92);
    float line = step(0.5, fract(q.y * 38.0)) * step(0.1, uv.y) * step(uv.y, 0.72) * margin;
    float words = step(0.18, fract(sin(floor(q.x * 9.0) * 12.9 + floor(q.y * 38.0) * 78.2) * 43758.5));
    c = mix(c, vec3(0.3, 0.28, 0.26), line * words * 0.55 * step(0.05, fract(q.y * 38.0) - 0.45));
    c = mix(c, vec3(0.12, 0.11, 0.1), step(0.8, uv.y) * step(uv.y, 0.86) * step(0.08, uv.x) * step(uv.x, 0.6));
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

bool onPage(vec2 q) {
  return q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0;
}

void main() {
  vec2 res = uResolution;
  float aspect = res.x / res.y;
  // Work in a square-unit space: x across (0..aspect), y up (0..1).
  vec2 k = vec2(aspect, 1.0);
  vec2 p = gl_FragCoord.xy / res * k;
  vec2 corner = uCorner * k;

  // Where the corner is drawn to: at rest, a little way in along the
  // diagonal, breathing; with the pointer, towards the pointer.
  vec2 inward = normalize(k * 0.5 - corner);
  float breathe = 0.02 * sin(uTime * 1.3) + 0.01 * sin(uTime * 2.9 + 1.0);
  vec2 target = corner + inward * (uCurl + breathe) * 2.4;
  if (uInteractive > 0.5 && uPointerActive > 0.01) {
    vec2 ptr = uPointer * k;
    // Keep the corner from being pulled right off the page.
    ptr = clamp(ptr, vec2(0.02), k - 0.02);
    target = mix(target, ptr, uPointerActive);
  }

  // The fold: halfway from the corner to where it is drawn, facing it.
  vec2 dir = normalize(corner - target + 1e-5);
  float r = mix(0.03, 0.2, uRadius) * clamp(length(corner - target) * 2.0, 0.2, 1.0);
  vec2 mid = (corner + target) * 0.5 + dir * r * 0.5;
  float d = dot(p - mid, dir);

  // Candidates, topmost first. u is the distance along the sheet from the
  // fold line; the sheet point is where the pixel came from.
  vec3 colour = vec3(0.0);
  float alpha = 0.0;
  bool found = false;
  float PI = 3.14159265;
  float light = 1.0;
  bool back = false;
  vec2 sheet = vec2(0.0);

  // 1. The flat back, flipped over, lying on top of everything.
  if (d < 0.0) {
    float u = PI * r - d;
    sheet = p + dir * (u - d);
    if (onPage(sheet / k)) { found = true; back = true; light = 0.94; }
  }
  // 2. The far side of the roll.
  if (!found && d >= 0.0 && d <= r) {
    float a = asin(clamp(d / r, -1.0, 1.0));
    float u = PI * r - a * r;
    sheet = p + dir * (u - d);
    if (onPage(sheet / k)) { found = true; back = true; light = 0.72 + 0.28 * cos(a); }
  }
  // 3. The near side of the roll.
  if (!found && d >= 0.0 && d <= r) {
    float a = asin(clamp(d / r, -1.0, 1.0));
    float u = a * r;
    sheet = p + dir * (u - d);
    if (onPage(sheet / k)) { found = true; back = false; light = 0.55 + 0.45 * cos(a); }
  }
  // 4. The flat front.
  if (!found && d < 0.0) {
    sheet = p;
    found = true;
    back = false;
    light = 1.0;
  }

  vec2 css = gl_FragCoord.xy / uPixelRatio;
  if (found) {
    vec2 spx = sheet / k * res;
    if (back) {
      // The reverse: plain paper, with the print showing faintly through
      // it, mirrored, as it does through a real sheet held to the light.
      vec3 c = uBack * (0.985 + 0.03 * hash12(floor(css * 0.7)));
      if (uShowThrough > 0.5) {
        vec3 print = srgbToLinear(source(spx, 2.5).rgb);
        c *= mix(vec3(1.0), print, 0.22);
      }
      colour = c * light;
    } else {
      colour = srgbToLinear(source(spx, 0.0).rgb) * light;
    }
    // The flat front darkens slightly in the shadow of the roll above it.
    if (!back && d < 0.0 && uShowShadow > 0.5) colour *= 1.0 - 0.3 * exp(d / (r * 0.8));
    alpha = 1.0;
  } else {
    // Revealed: underneath, shadowed where the curl hangs over it. The
    // shadow is darkest right by the roll and fades away from it.
    vec3 c = uUnder;
    float a = uShowUnder;
    if (uShowShadow > 0.5) {
      float sh = exp(-(d - r) / (r * 1.6)) * 0.75;
      c *= 1.0 - sh;
      a = max(a, sh * 0.7);
    }
    colour = c;
    alpha = a;
  }
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

const CORNERS = { 'bottom-right': [1, 0], 'top-right': [1, 1], 'bottom-left': [0, 0], 'top-left': [0, 1] };

/** @type {import('./runtime.js').EffectSpec<PageCurlOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 3,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowUnder: o.showUnder,
      uShowShadow: o.showShadow,
      uShowThrough: o.showThrough,
      uCorner: CORNERS[o.corner] ?? CORNERS['bottom-right'],
      uCurl: o.curl,
      uRadius: o.radius,
      uBack: linear(o.back),
      uUnder: linear(o.under),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 8 });
    return {
      update: (o) => image.set(o.image),
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
 * @param {Partial<PageCurlOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function pageCurl(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
