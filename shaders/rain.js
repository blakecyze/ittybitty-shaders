// @ts-check
/**
 * ittybitty/rain
 *
 * Rain on a pane of glass in front of an image, or in front of the layers
 * beneath. Beads cling to the glass and act as tiny lenses, each showing the
 * scene flipped and sharp while the glass around them is fogged; heavier
 * drops run down in lanes, wobbling, eating the beads in their way and
 * leaving a clear, wet streak behind. The liquid can be water, blood, mud or
 * any colour. Transparent, it becomes rain on the page itself.
 *
 * https://ittybitty.dev/shaders/rain (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} RainOptions
 * @property {boolean} showImage The picture behind the glass. Off, only the drops are drawn, over the page.
 * @property {boolean} showDrops The raindrops and the trails they leave.
 * @property {boolean} showFog The mist on the dry glass between the drops.
 * @property {string} image Scene behind the glass. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} speed How fast the drops run.
 * @property {number} amount How much rain: running drops and beads together.
 * @property {number} size Size of the drops.
 * @property {number} fog How misted the dry glass is.
 * @property {number} refraction How strongly drops bend the scene behind them.
 * @property {'water' | 'blood' | 'mud' | 'custom'} liquid What is running down the glass.
 * @property {string} color Colour of a custom liquid.
 * @property {number} opacity How opaque the liquid is: 0 clear, 1 fully coloured.
 */

/** @type {RainOptions} */
export const defaults = {
  showImage: true,
  showDrops: true,
  showFog: true,
  image: '',
  speed: 0.6,
  amount: 0.6,
  size: 1,
  fog: 0.5,
  refraction: 0.8,
  liquid: 'water',
  color: '#3a7bd5',
  opacity: 0.6,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowDrops;
uniform float uShowFog;
uniform float uPixelRatio;
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uAmount;
uniform float uSize;
uniform float uFog;
uniform float uRefraction;
uniform vec3 uLiquid;      // linear RGB
uniform float uOpacity;
uniform float uTransparent;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 hash32(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

// The scene behind the glass. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // No image yet: a dusk street, soft coloured lights out of focus.
    vec3 c = mix(vec3(0.05, 0.06, 0.1), vec3(0.18, 0.12, 0.2), uv.y);
    for (int i = 0; i < 7; i++) {
      vec3 h = hash32(vec2(float(i), 3.1));
      vec2 d = (uv - vec2(h.x, 0.2 + 0.5 * h.y)) * vec2(uResolution.x / uResolution.y, 1.0);
      c += mix(vec3(1.0, 0.55, 0.2), vec3(0.3, 0.6, 1.0), h.z) * 0.5 * exp(-dot(d, d) * 60.0);
    }
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

// Water on the glass at p (in drop units): x, y lens offset; z coverage;
// w how much of it is a freshly wiped streak.
vec4 glass(vec2 p, float t) {
  vec4 w = vec4(0.0);

  // Beads: one per cell at most, clinging where they landed. They swell in
  // and are wiped away again, so the pattern slowly changes.
  // Two scales of bead, offset from each other, so no grid shows.
  for (int s = 0; s < 2; s++) {
    float scale = s == 0 ? 3.0 : 7.3;
    vec2 q = p * scale + float(s) * vec2(0.37, 0.71);
    vec2 cell = floor(q);
    vec2 f = fract(q);
    vec3 h = hash32(cell + float(s) * 19.0);
    if (h.z < uAmount * (s == 0 ? 0.75 : 0.6)) {
      // Each bead lands (growing in a blink), then clings for a long while.
      float life = fract(t * 0.04 + h.x * 7.0);
      float r = (0.1 + 0.3 * h.y * h.y) * smoothstep(0.0, 0.02, life);
      vec2 d = f - (0.3 + 0.4 * h.xy);
      float k = length(d) / max(r, 1e-3);
      float bead = smoothstep(1.0, 0.85, k);
      w.xy += d / max(r, 1e-3) * bead;
      w.z = max(w.z, bead);
    }
  }

  // Runners: one lane per column, a drop sliding down in fits and starts.
  float lane = floor(p.x);
  vec3 l = hash32(vec2(lane, 17.0));
  if (l.x < uAmount * 1.1) {
    float cycle = t * (0.18 + 0.3 * l.y) + l.z * 11.0;
    float n = floor(cycle);
    float fall = fract(cycle);
    // Stick, then slip: drops catch on the glass and then run on. The path
    // only ever goes down: each step eases from rest to rest.
    float steps = 5.0 + floor(l.x * 4.0);
    float stair = (floor(fall * steps) + smoothstep(0.35, 1.0, fract(fall * steps))) / steps;
    fall = mix(fall, stair, 0.8);
    // Canvas height in drop units: each drop runs the whole pane.
    float top = uResolution.y / uPixelRatio / (110.0 * max(uSize, 0.3));
    float drop_y = top * (1.15 - fall * 1.3);
    float cx = lane + 0.5 + (hash12(vec2(lane, n)) - 0.5) * 0.3;
    // A wobble that follows the drop's path down the glass.
    // A gentle meander: drops follow the glass's invisible grain.
    float wob = 0.07 * sin(p.y * 1.9 + l.y * 20.0) + 0.025 * sin(p.y * 4.7 + l.x * 9.0);
    // A teardrop: round and heavy below, drawn out into a tail above.
    vec2 d = p - vec2(cx + wob, drop_y);
    d.y *= d.y > 0.0 ? 0.55 : 1.05;
    float r = 0.16 + 0.08 * l.y;
    float head = smoothstep(r, r * 0.75, length(d));
    // The streak behind it: clear of beads, with a thin film and a few
    // leftover droplets along it.
    float above = step(drop_y, p.y) * smoothstep(drop_y + top * 0.9, drop_y, p.y);
    float streak = smoothstep(0.065, 0.015, abs(p.x - cx - wob)) * above * 0.85;
    float left = smoothstep(0.35, 0.2, length(vec2(p.x - cx - wob, fract(p.y * 4.0 + l.x) - 0.5) * vec2(4.0, 1.0))) * streak * step(0.55, hash12(vec2(lane, floor(p.y * 4.0 + l.x))));
    w.xy = mix(w.xy, d / r * head, max(head, streak * 0.8));
    w.xy += vec2(p.x - cx - wob, 0.0) * streak * 1.5;
    w.z = max(max(w.z * (1.0 - streak), head), left);
    w.w = streak * (1.0 - head);
  }
  return w;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  // Drops keep their size in CSS pixels, whatever the canvas size.
  vec2 p = px / uPixelRatio / (110.0 * max(uSize, 0.3));
  vec4 w = glass(p, uTime) * uShowDrops;

  float cover = w.z;
  // Inside a drop the scene is refracted and sharp; the dry glass is fogged.
  vec2 bend = -w.xy * uRefraction * 28.0 * uPixelRatio * max(uSize, 0.3);
  float fog = uFog * uShowFog * (1.0 - max(cover, w.w));
  vec3 behind = srgbToLinear(source(px + bend * cover, mix(4.5 * uFog, 0.0, max(cover, w.w))).rgb);
  // Condensation whitens and dims the view through dry glass.
  vec3 scene = mix(behind, behind * 0.7 + 0.08, fog * 0.6);

  // The liquid: water barely tints; blood and mud absorb what they cover.
  // Light passing through the liquid is filtered by it, as through stained glass.
  vec3 filterColour = min(uLiquid * 1.5, vec3(1.0));
  vec3 through = mix(behind, behind * filterColour + uLiquid * 0.2, uOpacity);
  // Lens edge: drops darken at their rim, where light bends away from you.
  float rim = smoothstep(0.62, 1.0, length(w.xy)) * cover;
  through *= 1.0 - rim * 0.6;
  // A drop is a lens: it focuses light into a bright crescent on the side
  // away from the light, just inside the rim.
  float caustic = smoothstep(0.35, 0.8, dot(w.xy, vec2(0.45, -0.75))) * (1.0 - smoothstep(0.8, 0.98, length(w.xy))) * cover;
  through += caustic * 0.35 * (behind + 0.15);
  // A highlight from the light above, on the upper left of each drop.
  float spec = pow(max(dot(normalize(vec3(w.xy, 0.5)), normalize(vec3(-0.4, 0.6, 0.7))), 0.0), 40.0) * cover;
  vec3 colour = mix(scene, through, cover);
  colour = mix(colour, mix(behind, through, 0.6), w.w * 0.5);
  colour += spec * mix(vec3(0.95), uLiquid + 0.6, 0.2) * 0.9;

  if (uTransparent > 0.5) {
    // Rain on the page, drawn as light and shade so it reads on any colour:
    // a tinted body, a shadow crescent opposite the light, a thin rim and a
    // highlight. Composited front to back, premultiplied.
    float shadow = clamp(dot(w.xy, vec2(0.55, -0.75)), 0.0, 1.0) * cover;
    vec4 c = vec4(uLiquid, 1.0) * cover * (0.06 + 0.8 * uOpacity);
    vec4 dark = vec4(vec3(0.05, 0.06, 0.08), 1.0) * clamp(shadow * 0.6 + rim * 0.45 + w.w * 0.08, 0.0, 1.0);
    c = dark + c * (1.0 - dark.a);
    vec4 light = vec4(1.0) * clamp(spec * 0.9, 0.0, 1.0);
    c = light + c * (1.0 - light.a);
    fragColor = vec4(linearToSrgb(c.rgb / max(c.a, 1e-3)) * c.a, c.a);
    return;
  }
  colour = linearToSrgb(colour);
  colour += (hash12(px) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const LIQUIDS = { water: '#cfe6f2', blood: '#7a0610', mud: '#5a4028' };

/** @type {import('./runtime.js').EffectSpec<RainOptions>} */
const base = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 6,
  speed: (o) => o.speed,
  update(o) {
    const water = o.liquid === 'water';
    return {
      uShowDrops: o.showDrops,
      uShowFog: o.showFog,
      uAmount: o.amount,
      uSize: o.size,
      uFog: o.fog,
      uRefraction: o.refraction,
      uLiquid: linear(o.liquid === 'custom' ? o.color : LIQUIDS[o.liquid] ?? LIQUIDS.water),
      // Water stays nearly clear whatever the opacity says.
      uOpacity: water ? o.opacity * 0.25 : o.opacity,
      uTransparent: !o.showImage,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

// Container aware: fits its element, or text or a path, and lights the shape.
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<RainOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function rain(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
