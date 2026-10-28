// @ts-check
/**
 * ittybitty/stained-glass
 *
 * Turns any image, or the layers beneath, into a stained-glass window: the
 * picture is cut into panes of glass, each one flat, rich colour with the
 * gentle mottling of real cathedral glass, held together by dark lead came.
 * Light glows through, strongest where the sun would fall, and the glass
 * picks up a faint sheen.
 *
 * https://ittybitty.dev/shaders/stained-glass (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} StainedGlassOptions
 * @property {boolean} showGlass The coloured panes. Off, only the lead is drawn, over the page.
 * @property {boolean} showLead The dark lead lines between the panes.
 * @property {string} image Picture to set in glass. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {number} panes Size of the panes: smaller for finer detail.
 * @property {number} lead Width of the lead lines.
 * @property {number} saturation Richness of the glass colours.
 * @property {number} mottle The uneven texture inside each pane.
 * @property {number} glow Light glowing through the glass.
 * @property {string} came Colour of the lead.
 * @property {boolean} interactive The light moves with the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {StainedGlassOptions} */
export const defaults = {
  showGlass: true,
  showLead: true,
  image: '',
  panes: 0.5,
  lead: 0.5,
  saturation: 1.4,
  mottle: 0.5,
  glow: 0.6,
  came: '#1a1714',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowGlass;
uniform float uShowLead;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uPanes;
uniform float uLead;
uniform float uSaturation;
uniform float uMottle;
uniform float uGlow;
uniform vec3 uCame;       // linear RGB
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

vec2 hash22(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
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

// The picture being set in glass. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A rose window: a gold centre, rings of deep blue and ruby, petals of
    // green and amber radiating out, as in a cathedral.
    vec2 d = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    float a = atan(d.y, d.x);
    float r = length(d);
    float petal = 0.5 + 0.5 * cos(a * 8.0);
    vec3 c = vec3(0.05, 0.12, 0.45);                                   // deep blue ground
    c = mix(c, vec3(0.62, 0.06, 0.1), step(0.18, r) * step(r, 0.26));  // ruby ring
    c = mix(c, mix(vec3(0.1, 0.45, 0.2), vec3(0.95, 0.62, 0.1), petal), step(0.26, r) * step(r, 0.42) * step(0.45, petal));
    c = mix(c, vec3(0.62, 0.06, 0.1), step(0.42, r) * step(r, 0.46));
    c = mix(c, vec3(1.0, 0.8, 0.3), step(r, 0.1));                     // gold centre
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

void main() {
  vec2 css = gl_FragCoord.xy / uPixelRatio;
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  // Panes in CSS pixels, so the window keeps its scale.
  float size = mix(14.0, 70.0, uPanes);
  vec2 p = css / size;

  // Voronoi panes: nearest and second-nearest seed, for the pane and its lead.
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 seed = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = hash22(i + g) * 0.85 + 0.075;
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        seed = i + g + o;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  // Distance to the lead line between this pane and its neighbour.
  float edge = (sqrt(d2) - sqrt(d1)) * 0.5 * size;
  // Glaziers also run lead along the outlines of the picture: add lines
  // where the image changes sharply.
  vec2 dpx = vec2(1.5 * uPixelRatio, 0.0);
  vec3 sa = source(gl_FragCoord.xy + dpx, 1.5).rgb, sb = source(gl_FragCoord.xy - dpx, 1.5).rgb;
  vec3 sc = source(gl_FragCoord.xy + dpx.yx, 1.5).rgb, sd = source(gl_FragCoord.xy - dpx.yx, 1.5).rgb;
  float outline = length(sa - sb) + length(sc - sd);

  // Each pane takes one colour: the picture sampled at the pane's centre,
  // pushed richer, as coloured glass would be.
  vec2 centre = seed * size * uPixelRatio;
  vec3 glass = srgbToLinear(source(centre, 1.0).rgb);
  float grey = dot(glass, vec3(0.2126, 0.7152, 0.0722));
  glass = max(mix(vec3(grey), glass, uSaturation), 0.0);
  // Pale areas are not clear glass: they take a soft tint of their own,
  // varying pane to pane, as antique glass does.
  // Pick from an antique palette: amber, straw, pale blue, sage.
  float pick = hash12(seed * 13.0);
  vec3 tint = pick < 0.35 ? vec3(1.0, 0.78, 0.4) : pick < 0.6 ? vec3(0.98, 0.92, 0.66) : pick < 0.85 ? vec3(0.62, 0.78, 1.0) : vec3(0.72, 0.9, 0.7);
  float neutral = 1.0 - smoothstep(0.03, 0.2, length(glass - grey));
  glass = mix(glass, grey * tint * 1.1, neutral * smoothstep(0.15, 0.6, grey));
  // Cathedral glass is never flat: bubbles, streaks and thickness vary.
  float mottle = noise(css * 0.08 + seed * 7.0) * 0.6 + noise(css * 0.3 + seed * 3.0) * 0.4;
  glass *= 1.0 + (mottle - 0.5) * 0.5 * uMottle;
  // Light through the glass: brighter where the sun is behind it.
  vec2 lightAt = mix(vec2(0.7, 0.8), uPointer, uPointerActive * uInteractive);
  float sun = exp(-length((uv - lightAt) * vec2(aspect, 1.0)) * 1.8);
  glass *= 0.55 + uGlow * (0.4 + 1.3 * sun);
  // Each pane is a little darker at its edges, where the glass is held.
  glass *= mix(0.65, 1.0, smoothstep(0.0, 6.0, edge));

  // Lead came: dark, slightly rounded, with a dull highlight along its top.
  float width = mix(0.6, 3.5, uLead);
  float lead = max(smoothstep(width + 0.8, width - 0.8, edge), smoothstep(0.25, 0.5, outline) * step(0.5, uImageReady));
  vec3 came = uCame * (1.0 + 0.8 * smoothstep(width, 0.0, edge) * smoothstep(0.0, width, edge));

  // Premultiplied, so the glass or the lead can stand alone.
  float glassA = (1.0 - lead) * uShowGlass;
  float leadA = lead * uShowLead;
  float alpha = glassA + leadA;
  vec3 colour = (1.0 - exp(-glass * 1.4)) * glassA + (1.0 - exp(-came * 1.4)) * leadA;
  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<StainedGlassOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowGlass: o.showGlass,
      uShowLead: o.showLead,
      uPanes: o.panes,
      uLead: o.lead,
      uSaturation: o.saturation,
      uMottle: o.mottle,
      uGlow: o.glow,
      uCame: linear(o.came),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 4 });
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
 * @param {Partial<StainedGlassOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function stainedGlass(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
