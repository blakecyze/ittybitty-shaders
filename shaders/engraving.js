// @ts-check
/**
 * ittybitty/engraving
 *
 * An image, or the layers beneath, engraved as on a banknote. Tone is cut
 * as intaglio lines: every line swells with the darkness beneath it, so
 * light areas are hairlines and shadows merge into solid ink, and the lines
 * bend with the picture's brightness, the relief engravers give a portrait.
 * The deepest shadows get a second set of lines across the first. Behind it
 * all, in a second, paler ink, a guilloché rosette of interlaced curves of
 * the kind cut by a rose-engine lathe, and a guilloché border around the
 * note. Static: one draw per change.
 *
 * https://ittybitty.dev/shaders/engraving (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';

/**
 * @typedef {object} EngravingOptions
 * @property {boolean} showPaper The paper. Off, only the ink is drawn, over the page.
 * @property {boolean} showRosette The guilloché rosette behind the engraving.
 * @property {boolean} showBorder A guilloché border around the edge.
 * @property {string} image Picture to engrave. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'waves' | 'rings' | 'straight'} lines Waving lines, rings around the middle, or straight lines.
 * @property {number} spacing Gap between engraved lines, in CSS pixels.
 * @property {number} angle Direction of the lines, in degrees.
 * @property {number} relief How far the lines bend with the picture's brightness.
 * @property {number} contrast How strongly tone is pushed towards light and dark.
 * @property {number} petals Lobes in the rosette.
 * @property {number} wear Ink spread and broken hairlines, as from a worn plate.
 * @property {string} ink Colour of the engraving.
 * @property {string} tint Colour of the rosette and border.
 * @property {string} paper Colour of the paper.
 */

/** @type {EngravingOptions} */
export const defaults = {
  showPaper: true,
  showRosette: true,
  showBorder: true,
  image: '',
  lines: 'waves',
  spacing: 3,
  angle: 20,
  relief: 0.6,
  contrast: 1.3,
  petals: 12,
  wear: 0.3,
  ink: '#1e3a2f',
  tint: '#9dbba6',
  paper: '#efeadb',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uShowPaper;
uniform float uShowRosette;
uniform float uShowBorder;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uLines;     // 0 waves, 1 rings, 2 straight
uniform float uSpacing;
uniform float uAngle;     // radians
uniform float uRelief;
uniform float uContrast;
uniform float uPetals;
uniform float uWear;
uniform vec3 uInk;        // linear RGB
uniform vec3 uTint;
uniform vec3 uPaper;

out vec4 fragColor;

// The picture being engraved. In a layer stack this reads the layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    vec2 d = (uv - vec2(0.5, 0.45)) * vec2(uResolution.x / uResolution.y, 1.0);
    float ball = smoothstep(0.3, 0.29, length(d));
    vec3 c = mix(vec3(0.85, 0.82, 0.76), vec3(0.9, 0.35, 0.25) * (0.5 + 0.8 * clamp(dot(normalize(vec3(d, 0.3)), vec3(-0.5, 0.6, 0.6)), 0.0, 1.0)), ball);
    return vec4(c, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

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

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// An engraved line of the given width (0..1 of the spacing) at phase x,
// antialiased: its ink coverage.
float cut(float x, float width) {
  float d = abs(fract(x) - 0.5);
  float aa = fwidth(x) * 0.75;
  return 1.0 - smoothstep(width * 0.5 - aa, width * 0.5 + aa, d);
}

// A thin guilloché line at distance d (in CSS pixels) from its curve.
float hair(float d) {
  return 1.0 - smoothstep(0.25, 0.75, abs(d));
}

// The rosette: bands of interlaced curves r = R + a·sin(nθ + φ), each band
// several curves a step of phase apart, as a rose-engine lathe cuts them.
// Distance to each curve is divided by its slope, so every line is the
// same even hairline however steeply it swings.
float rosette(vec2 p, float size) {
  float r = length(p);
  if (r >= size * 0.95) return 0.0;
  float th = atan(p.y, p.x);
  float ink = 0.0;
  for (int band = 0; band < 3; band++) {
    float fb = float(band);
    float R = size * (0.38 + 0.25 * fb);
    float amp = size * (0.05 + 0.025 * fb);
    float n = uPetals + fb * 4.0;
    for (int k = 0; k < 10; k++) {
      float ph = float(k) / 10.0 * 6.2831 / n;
      float x = n * (th + ph);
      float curve = R + amp * sin(x) + amp * 0.3 * sin(2.0 * x + fb);
      float dcurve = amp * n * cos(x) + amp * 0.6 * n * cos(2.0 * x + fb);
      float d = (r - curve) / sqrt(1.0 + dcurve * dcurve / max(r * r, 1.0));
      ink = max(ink, hair(d));
    }
  }
  // Fine concentric rings fill the heart of the rosette.
  float rings = abs(fract(r / size * 26.0) - 0.5) * size / 26.0;
  ink = max(ink, hair(rings * 1.2) * 0.8 * smoothstep(size * 0.3, size * 0.22, r));
  return ink * smoothstep(size * 0.95, size * 0.85, r);
}

// A guilloché band: sine ribbons woven along a straight edge, t across the
// band (CSS pixels from its centre) and s along it.
float band(float t, float s, float width) {
  if (abs(t) > width * 0.5) return 0.0;
  float ink = 0.0;
  for (int k = 0; k < 5; k++) {
    float ph = float(k) * 1.2566;
    ink = max(ink, hair(t - width * 0.42 * sin(s * 0.09 + ph)));
  }
  return ink * step(abs(t), width * 0.5);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;
  vec2 size = uResolution / uPixelRatio;
  vec2 c = css - size * 0.5;

  // Tone as the eye sees it, softened a little so lines stay smooth.
  float l = luma(source(px, 1.5).rgb);
  float tone = clamp((0.5 - l) * uContrast + 0.5, 0.0, 1.0);
  float soft = luma(source(px, 4.0).rgb);

  // The field of engraved lines: its phase counts lines across the plate.
  vec2 dir = vec2(cos(uAngle), sin(uAngle));
  vec2 across = vec2(-dir.y, dir.x);
  float phase;
  if (uLines < 0.5) {
    // Waves: parallel lines rolling gently along their length.
    phase = dot(c, across) / uSpacing + 1.6 * sin(dot(c, dir) / (uSpacing * 28.0));
  } else if (uLines < 1.5) {
    // Rings around the middle, as engravers cut round a portrait.
    phase = length(c * vec2(1.0, 1.15)) / uSpacing;
  } else {
    phase = dot(c, across) / uSpacing;
  }
  // Relief: lines bend with brightness, so forms rise out of the plate.
  phase += uRelief * 3.0 * soft;
  // Line width grows with darkness; hairlines never quite vanish.
  float width = mix(0.04, 0.95, pow(tone, 1.15));
  // Wear: ink spreads unevenly along each line, and a tired plate prints
  // its finest hairlines broken.
  float blot = noise(css * vec2(0.9, 0.35) + 5.0);
  width *= 1.0 + uWear * 0.5 * (blot - 0.5);
  // In the highlights the hairlines break off, leaving bare paper.
  float engraved = cut(phase, width) * smoothstep(0.04, 0.16, tone);
  engraved *= 1.0 - uWear * smoothstep(0.55, 0.8, noise(css * 0.4 + 11.0)) * smoothstep(0.5, 0.1, tone);
  // Deepest shadows: a second set of lines across the first.
  float crossing = dot(c, dir) / (uSpacing * 1.4) + uRelief * 2.0 * soft;
  engraved = max(engraved, cut(crossing, mix(0.0, 0.7, smoothstep(0.62, 1.0, tone))) * step(0.62, tone));

  // The tint layer: rosette and border, printed first and paler, fading
  // where the engraving is dark so the picture stays clear.
  float tint = 0.0;
  float s = min(size.x, size.y);
  if (uShowRosette > 0.5) {
    // The rosette sits to one side, as on a note, clear of the picture's
    // middle. A faint wavy security pattern runs behind everything.
    tint = max(tint, rosette(c - vec2(size.x * 0.27, size.y * 0.02), s * 0.36));
    float wave = dot(c, across) / (uSpacing * 2.2) + 2.5 * sin(dot(c, dir) / (s * 0.07)) + 1.2 * sin(dot(c, dir) / (s * 0.023) + 1.3);
    tint = max(tint, cut(wave, 0.12) * 0.45);
    // Printed first and paler: it gives way wherever the engraving is dark.
    tint *= 1.0 - smoothstep(0.08, 0.4, tone);
  }
  float frame = 0.0;
  if (uShowBorder > 0.5) {
    float bw = clamp(s * 0.06, 14.0, 40.0);
    vec2 edge = size * 0.5 - abs(c);
    // Distance in from the nearer edge, and the position along it.
    bool side = edge.x < edge.y;
    float t = (side ? edge.x : edge.y) - bw * 0.6;
    float along = side ? c.y : c.x;
    float b = band(t, along, bw);
    // Solid rules on both sides of the band.
    float rule = hair((side ? edge.x : edge.y) - bw * 0.1) + hair((side ? edge.x : edge.y) - bw * 1.12);
    tint = max(tint, b);
    frame = min(rule, 1.0);
    // Inside the border only: the engraving stops at the frame.
    engraved *= smoothstep(bw * 1.15, bw * 1.3, min(edge.x, edge.y));
    tint *= step(bw * 0.05, min(edge.x, edge.y));
  }

  // Paper with fine fibres; the ink sits slightly raised, a touch darker
  // at its core as intaglio does.
  float fibre = noise(css * vec2(0.6, 2.2)) * 0.5 + noise(css * 1.7) * 0.5;
  vec3 paper = uPaper * (0.96 + 0.05 * fibre);
  float ink = max(engraved, frame);
  vec3 colour = mix(paper * uShowPaper, uTint, tint * 0.9 * (1.0 - ink));
  colour = mix(colour, uInk * (0.9 + 0.1 * fibre), ink);
  float alpha = max(uShowPaper, max(ink, tint * 0.9));
  fragColor = vec4(linearToSrgb(colour / max(alpha, 1e-4)) * alpha, alpha);
}
`;

const LINES = { waves: 0, rings: 1, straight: 2 };

/** @type {import('./runtime.js').EffectSpec<EngravingOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    return {
      uShowPaper: o.showPaper,
      uShowRosette: o.showRosette,
      uShowBorder: o.showBorder,
      uLines: LINES[o.lines] ?? 0,
      uSpacing: o.spacing,
      uAngle: (o.angle * Math.PI) / 180,
      uRelief: o.relief,
      uContrast: o.contrast,
      uPetals: o.petals,
      uWear: o.wear,
      uInk: linear(o.ink),
      uTint: linear(o.tint),
      uPaper: linear(o.paper),
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    return { update: (o) => image.set(o.image), restore: image.restore, destroy: image.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<EngravingOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function engraving(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
