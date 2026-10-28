// @ts-check
/**
 * ittybitty/holo-card
 *
 * Any image as a holographic trading card. The card is drawn in perspective
 * inside the canvas and tilts as if pressed where the pointer is, so the
 * light's reflection slides across it towards the pointer. A foil layer
 * catches that light: its colours come from the angle between the light, the
 * card and the eye, so they shift as the card turns, and it is strongest in
 * the picture's mid-tones, as printed foil is. Seven foils: diagonal rainbow,
 * a starfield, fine glitter, vertical sun pillars, a diamond crosshatch,
 * cracked ice and etched gold. With nothing to follow it sways gently.
 *
 * https://ittybitty.dev/shaders/holo-card (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} HoloCardOptions
 * @property {boolean} showBackground The colour behind the card. Off, only the card and its shadow are drawn.
 * @property {boolean} showBorder A printed frame around the picture. Off, the picture runs to the card's edges.
 * @property {boolean} showShadow The soft shadow the card casts.
 * @property {string} image Picture on the card. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'rainbow' | 'cosmos' | 'glitter' | 'sunpillar' | 'radiant' | 'ice' | 'gold'} foil The foil's pattern.
 * @property {boolean} reverse Foil on the frame instead of the picture. Without a frame, on the picture's greyer parts.
 * @property {number} strength How strongly the foil shows.
 * @property {number} glare Brightness of the light's reflection.
 * @property {number} tilt How far the card tilts, in degrees.
 * @property {number} scale Size of the foil's pattern.
 * @property {number} etch How deeply the picture is embossed into the foil.
 * @property {number} hue Turns the foil's colours around the colour wheel.
 * @property {number} size Card height as a share of the canvas.
 * @property {number} radius Roundness of the card's corners.
 * @property {number} border Width of the frame.
 * @property {string} borderColour Colour of the frame.
 * @property {string} background Colour behind the card.
 * @property {number} speed How fast the card sways and the foil twinkles.
 * @property {boolean} interactive The card tilts towards the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {HoloCardOptions} */
export const defaults = {
  showBackground: true,
  showBorder: true,
  showShadow: true,
  image: '',
  foil: 'rainbow',
  reverse: false,
  strength: 0.8,
  glare: 0.6,
  tilt: 20,
  scale: 1,
  etch: 0.4,
  hue: 0,
  size: 0.8,
  radius: 0.3,
  border: 0.35,
  borderColour: '#f1cf55',
  background: '#0e0f14',
  speed: 1,
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
uniform float uFoil;        // 0 rainbow, 1 cosmos, 2 glitter, 3 sunpillar, 4 radiant, 5 ice, 6 gold
uniform float uReverse;
uniform float uStrength;
uniform float uGlare;
uniform float uScale;
uniform float uEtch;
uniform float uHue;         // turns
uniform float uBorder;      // 0 with no frame
uniform vec3 uStock;        // the frame's colour, sRGB
uniform vec3 uBackdrop;     // the background's colour, sRGB
uniform vec4 uTurn[3];      // gold's hue turn, by column
uniform float uTransparent;
// Worked out once per frame on the CPU (see the frame hook), not per pixel:
uniform vec4 uRot[3];       // card to world rotation, by column
uniform vec4 uCard;         // half width, half height, corner radius, lift towards the eye
uniform vec4 uWindow;       // the picture's window: half width, half height, corner radius
uniform vec2 uCrop;         // how the picture fills its window
uniform vec4 uCast;         // the shadow: offset, softness, strength
uniform float uFalloff;     // light across the card, from its lean
uniform vec4 uBounds;       // a box round the card and its shadow, in the units of p in main()

out vec4 fragColor;

const float TAU = 6.2831853;
// A trading card's proportions, 63 by 88 mm.
const float CARD = 63.0 / 88.0;
// The eye's distance from the canvas, in canvas heights: close enough for a
// little perspective, far enough that the card never looks distorted.
const float EYE = 2.0;

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec2 hash22(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
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

// The picture on the card, by canvas pixel. In a layer stack this reads the
// layers below.
// @source
vec4 source(vec2 px, float blur) {
  vec2 uv = px / uResolution;
  if (uImageReady < 0.5) {
    // A night sky with a ringed planet, so the card reads with no image.
    vec2 d = (uv - vec2(0.5, 0.55)) * vec2(uResolution.x / uResolution.y, 1.0);
    vec3 sky = mix(vec3(0.05, 0.06, 0.16), vec3(0.32, 0.22, 0.5), smoothstep(-0.5, 0.6, uv.y));
    float r = length(d);
    vec3 planet = mix(vec3(0.95, 0.55, 0.35), vec3(0.45, 0.18, 0.3), smoothstep(-0.2, 0.25, d.x - d.y));
    sky = mix(sky, planet, smoothstep(0.205, 0.2, r));
    float ring = abs(length(d * vec2(1.0, 3.2) * mat2(0.94, 0.34, -0.34, 0.94)) - 0.32);
    sky = mix(sky, vec3(0.98, 0.85, 0.6), smoothstep(0.03, 0.0, ring) * step(0.0, d.y + d.x * 0.3 + (r - 0.2) * 4.0));
    return vec4(sky, 1.0);
  }
  float ca = uResolution.x / uResolution.y;
  float ia = uImageSize.x / max(uImageSize.y, 1.0);
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  return vec4(texture(uImage, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// A rounded rectangle's signed distance: negative inside.
float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The light a diffraction grating sends back: a bright, slightly pastel
// rainbow, as printed foil shows it.
vec3 spectrum(float x) {
  // cos(a + phase) for three phases, from one cos and one sin of a: the
  // phases' cos and sin are constants (TAU times 0, 0.33 and 0.67).
  float a = TAU * (x + uHue);
  vec3 c = 0.5 + 0.5 * (cos(a) * vec3(1.0, -0.4817537, -0.4817537) - sin(a) * vec3(0.0, 0.8763067, -0.8763067));
  return smoothstep(0.0, 1.0, c) * 0.85 + 0.15;
}

// Where the eye's ray meets the card, in the card's own plane.
vec2 hit(vec3 ro, vec3 rd, mat3 r) {
  vec3 o = ro * r;  // into card space (r is a rotation, so its transpose inverts it)
  vec3 d = rd * r;
  return o.xy - d.xy * o.z / d.z;
}

// Each foil: its colour, and in .a how much it lights up at this angle.
// uv runs 0 to 1 across the card, h is the half-way vector between the light
// and the eye in card space (its xy is what changes as the card turns).
//
// A software renderer such as SwiftShader runs every branch for every
// pixel, whichever foil is chosen. So the costly parts several foils share,
// value noise and the spectrum, are worked out once, outside the branches,
// at arguments the foil picks; each branch only works out its own pattern.
// The colour is then mix(base, spectrum(x) * gain + lift, amount).
vec4 foil(vec2 uv, vec2 h, float t) {
  vec2 a = uv * vec2(CARD, 1.0) / uScale;
  bool rainbow = uFoil < 0.5, cosmos = uFoil > 0.5 && uFoil < 1.5, gold = uFoil > 5.5;
  // Noise: rainbow's fine bands; the cosmos' first two octaves; gold's grain.
  vec2 q = a * 2.6 + h * 1.2;
  float n0 = 0.0, n1 = 0.0;
  if (rainbow || cosmos || gold) n0 = noise(rainbow ? a * 220.0 + h * 400.0 : cosmos ? q : vec2(a.x * 3.0, a.y * 420.0));
  if (cosmos || gold) n1 = noise(cosmos ? q * 2.1 + 3.0 : vec2(a.x * 7.0, a.y * 900.0));

  float x;                 // where the foil samples the spectrum
  vec3 base = vec3(0.0);
  float gain = 1.0, lift = 0.0, amount = 1.0;
  float shine;             // how much it lights up (.a)
  if (rainbow) {
    // Rainbow: broad diagonal bands that sweep across as the card turns,
    // over a finer second set for depth.
    x = dot(a, vec2(0.75, 1.0)) * 1.8 - dot(h, vec2(5.0, 7.0));
    // Brighter and darker bands, so it reads as streaks of light rather
    // than a wash of colour.
    float band = 0.5 + 0.5 * sin(x * TAU * 0.5 + 1.0);
    shine = band * sqrt(band) * (0.8 + 0.25 * n0);
  } else if (cosmos) {
    // Cosmos: a deep nebula strewn with stars, each catching the light at
    // its own angle, so they wink on and off as the card turns.
    float n = n0 * 0.55 + n1 * 0.3 + noise(q * 4.3 - 1.0) * 0.15;
    float cloud = smoothstep(0.3, 0.8, n);
    x = n * 1.8 - dot(h, vec2(3.0, 4.0)) + 0.6;
    float stars = 0.0;
    for (int i = 0; i < 2; i++) {
      float k = float(i);
      vec2 g = a * (34.0 + k * 30.0);
      vec2 id = floor(g);
      vec2 r = hash22(id + k * 17.0);
      vec2 o = fract(g) - 0.2 - r * 0.6;
      float s = step(0.55, hash12(id * 1.3 + k));
      vec2 tw = h * 5.0 - (r - 0.5) * 2.0;
      float facing = exp(-dot(tw, tw) * 1.5);
      float twinkle = 0.7 + 0.3 * sin(t * (1.5 + r.y * 3.0) + r.x * TAU);
      float size = mix(0.05, 0.13, r.y) * (0.6 + facing);
      float core = smoothstep(size, 0.0, length(o));
      // A four-pointed glint on the brightest.
      float cross = smoothstep(0.02, 0.0, min(abs(o.x), abs(o.y))) * smoothstep(size * 3.0, 0.0, length(o)) * facing;
      stars += s * (core + cross) * (0.35 + facing * twinkle * 2.0);
    }
    gain = 0.35 + 0.9 * cloud;
    lift = stars;
    shine = 0.5 + cloud * 0.6 + stars * 2.0;
  } else if (uFoil < 2.5) {
    // Glitter: tiny flakes, each a facet at its own angle, flashing when it
    // lines up with the light, in its own colour.
    vec2 g = a * 170.0;
    vec2 id = floor(g);
    vec2 r = hash22(id);
    vec2 f = (r - 0.5) * 0.7;
    float facing = exp(-dot(h - f, h - f) * 160.0);
    float tw = 0.7 + 0.3 * sin(t * 2.0 + r.x * 40.0);
    float flake = smoothstep(0.5, 0.1, length(fract(g) - 0.5));
    x = r.y * 0.5 - dot(h, vec2(3.0));
    base = mix(vec3(0.75, 0.78, 0.85), spectrum(dot(a, vec2(1.0, 1.4)) - dot(h, vec2(4.0, 5.0))), 0.35);
    float flash = flake * facing * tw;
    gain = 1.3;
    lift = 0.2;
    amount = min(flash * 2.0, 1.0);
    shine = 0.3 + flash * 4.0;
  } else if (uFoil < 3.5) {
    // Sun pillars: tall columns of rainbow standing up the card, crossed by
    // fine diagonal sheen lines, as on the brightest modern cards.
    float px = a.x * 4.5 - h.x * 1.5;
    float column = 0.5 + 0.5 * cos(px * TAU);
    float pillars = column * column * column;
    float lines = smoothstep(0.4, 1.0, 0.5 + 0.5 * sin((a.x + a.y) * 90.0 - h.x * 60.0 + h.y * 40.0)) * pillars;
    x = a.y * 1.6 - dot(h, vec2(2.0, 6.0)) + px * 0.12;
    gain = 0.85 + 0.3 * pillars;
    shine = 0.1 + pillars * 1.4 + lines * 0.25;
  } else if (uFoil < 4.5) {
    // Radiant: a diamond crosshatch of fine raised lines; light runs along
    // them in waves that ripple as the card turns.
    vec2 r = mat2(0.7071, 0.7071, -0.7071, 0.7071) * a * 38.0;
    vec2 cell = floor(r);
    vec2 f = abs(fract(r) - 0.5);
    float line = smoothstep(0.12, 0.0, 0.5 - max(f.x, f.y));
    float wave = 0.5 + 0.5 * sin(dot(cell, vec2(0.35, -0.22)) + dot(h, vec2(28.0, 22.0)));
    float diamond = 0.5 + 0.5 * sin(dot(cell, vec2(0.21, 0.29)) - dot(h, vec2(18.0, -14.0)));
    x = dot(cell, vec2(0.02, 0.03)) + dot(h, vec2(3.0));
    base = vec3(0.85, 0.88, 0.95);
    amount = 0.6;
    shine = line * (0.4 + wave * 1.4) + diamond * 0.35;
  } else if (uFoil < 5.5) {
    // Cracked ice: shards, each a flat mirror at its own angle, flashing in
    // turn, with bright cracks between them.
    vec2 g = a * 9.0;
    vec2 id = floor(g);
    vec2 f = fract(g);
    float d1 = 8.0;
    float d2 = 8.0;
    vec2 near = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 r = hash22(id + o);
        float d = length(o + r - f);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          near = id + o;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    vec2 r = hash22(near * 1.7 + 5.0);
    vec2 n = (r - 0.5) * 0.5;
    float facing = exp(-dot(h - n, h - n) * 40.0);
    float crack = smoothstep(0.06, 0.0, d2 - d1);
    x = r.x * 0.6 + dot(h, vec2(4.0, 3.0));
    shine = 0.25 + facing * 1.6 + crack * 0.8;
  } else {
    // Gold: brushed metal. Its grain catches the light in streaks, and broad
    // bands of reflection slide across it as the card turns.
    float brush = n0 * 0.6 + n1 * 0.4;
    x = dot(h, vec2(3.0, 5.0)) + a.y * 0.6 + a.x * 0.3;
    float bands = 0.5 + 0.5 * sin(x * TAU * 1.2);
    shine = brush * 0.35 + bands * 0.65;
  }
  return vec4(mix(base, spectrum(x) * gain + lift, amount), shine);
}

void main() {
  float t = uTime;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  // Most of the canvas is nowhere near the card or its shadow: there the
  // background is all there is. Decided for each 2×2 block of pixels as a
  // whole, from its centre, so that where the card's edge is found from
  // neighbouring pixels (fwidth, below) every neighbour is still there.
  vec2 block = (floor(gl_FragCoord.xy * 0.5) * 2.0 + 1.0 - 0.5 * uResolution) / uResolution.y;
  if (any(lessThan(block, uBounds.xy)) || any(greaterThan(block, uBounds.zw))) {
    vec3 bg = uBackdrop * (1.0 + 0.12 * exp(-dot(p, p) * 3.0));
    fragColor = uTransparent > 0.5 ? vec4(0.0) : vec4(bg + (hash12(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0, 1.0);
    return;
  }

  // The card's size, lean and lift are the same for every pixel, so the
  // frame hook works them out: see pose() below the shader.
  vec2 half_ = uCard.xy;
  float lift = uCard.w;
  mat3 rot = mat3(uRot[0].xyz, uRot[1].xyz, uRot[2].xyz);

  vec3 ro = vec3(0.0, 0.0, EYE);
  vec3 rd = normalize(vec3(p, -EYE));
  vec2 c = hit(ro, rd, rot) / lift;
  float r = uCard.z;
  float d = box(c, half_, r);
  float aa = max(fwidth(d), 1e-5);
  float inside = clamp(0.5 - d / aa, 0.0, 1.0);

  // The shadow: the card's outline cast down and away from the light,
  // further and softer the more the card leans.
  vec2 cs = hit(ro, normalize(vec3(p - uCast.xy, -EYE)), rot) / lift;
  float blur = uCast.z;
  float shadow = (1.0 - smoothstep(-blur, blur, box(cs, half_, r) + blur * 0.3)) * uCast.w;

  vec3 bg = uBackdrop;
  // A faint pool of light behind the card lifts it off the background.
  bg *= 1.0 + 0.12 * exp(-dot(p, p) * 3.0);
  bg *= 1.0 - shadow * 0.85;

  if (inside <= 0.0) {
    vec3 o = bg + (hash12(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
    fragColor = uTransparent > 0.5 ? vec4(0.0, 0.0, 0.0, shadow * 0.6) : vec4(o, 1.0);
    return;
  }

  vec2 uv = c / (2.0 * half_) + 0.5;

  // The picture, inside the frame if there is one, filling its window the
  // way a picture fills a frame: centred and cropped, never stretched.
  vec2 win = uWindow.xy;
  float frame = box(c, win, uWindow.z);
  float inArt = clamp(0.5 - frame / aa, 0.0, 1.0);
  vec2 art = c / (2.0 * win) + 0.5;
  vec2 px = (0.5 + (art - 0.5) * uCrop) * uResolution;
  vec3 img = source(px, 0.0).rgb;

  // Emboss: the picture's own shapes pressed into the foil, from the slope
  // of its blurred brightness. Faint slopes are ignored, so the soft
  // gradients of a photo do not ripple.
  vec2 e = vec2(4.0 * uPixelRatio, 0.0);
  vec2 slope = vec2(
    luma(source(px + e.xy, 2.5).rgb) - luma(source(px - e.xy, 2.5).rgb),
    luma(source(px + e.yx, 2.5).rgb) - luma(source(px - e.yx, 2.5).rgb)
  );
  slope = sign(slope) * max(abs(slope) - 0.012, 0.0) * inArt;

  // The frame: card stock in its colour, a little lighter at the top, with
  // a fine dark line where it meets the picture.
  vec3 stock = uStock * (0.92 + 0.12 * uv.y);
  stock *= 1.0 - 0.45 * smoothstep(2.0 * aa, 0.0, abs(frame));
  vec3 base = mix(stock, img, inArt);

  // Light, eye and card. The light hangs above and to the left of the eye,
  // so at rest its reflection sits towards the card's upper left.
  vec3 world = rot * vec3(c * lift, 0.0);
  vec3 v = normalize(ro - world);
  vec3 l = normalize(vec3(-0.18, 0.3, EYE) - world);
  vec3 hw = normalize(l + v) * rot; // into card space
  vec3 n = normalize(vec3(-slope * uEtch * 5.0, 1.0));
  // The surface's slant against the half-way vector: zero where the light's
  // reflection points straight at the eye. The foil and the glare both key
  // off it, so they move together as the card turns.
  vec2 h = hw.xy - n.xy * hw.z;
  float hh = dot(h, h);
  // The broad region where the light is caught: foil there comes alive,
  // elsewhere it sits back as dull metal.
  float lit = exp(-hh * 9.0);

  // How much foil, and where. Printed foil shows most in the mid-tones:
  // lost in deep shadow, washed out in white. Reverse holo puts it on the
  // frame, or without one on the picture's greyer, quieter parts.
  float lum = luma(base);
  float mid = smoothstep(0.02, 0.3, lum) * (1.0 - smoothstep(0.85, 1.0, lum) * 0.5);
  float chroma = max(base.r, max(base.g, base.b)) - min(base.r, min(base.g, base.b));
  float grey = 1.0 - smoothstep(0.06, 0.3, chroma);
  float where = uBorder > 0.0 ? mix(0.12, 1.0, inArt) : 1.0;
  if (uReverse > 0.5) where = uBorder > 0.0 ? 1.0 - inArt * 0.94 : grey;

  vec4 f = foil(uv, h, t);
  // Foil is never perfectly smooth: a fine grain in the film, shifting
  // with the angle, keeps it from reading as plastic.
  float micro = noise(uv * vec2(CARD, 1.0) * 650.0 + h * 260.0);
  float amount = uStrength * where * mid * f.a * (0.25 + 1.15 * lit) * (0.78 + 0.44 * micro);

  vec3 col;
  if (uFoil > 5.5) {
    // Gold: the picture becomes metal. Its brightness drives a gold ramp,
    // the brushed grain and the reflection of the light give it sheen, and
    // the emboss catches the light along every edge.
    vec3 dark = vec3(0.2, 0.1, 0.02);
    vec3 mid_ = vec3(0.8, 0.52, 0.12);
    vec3 hi = vec3(1.0, 0.9, 0.58);
    float k = smoothstep(0.08, 1.0, lum) * (0.45 + 0.75 * f.a) + dot(slope, vec2(-1.0, 1.0)) * uEtch * 5.0;
    k = clamp(k * (0.7 + 0.55 * lit), 0.0, 1.0);
    vec3 gold = mix(mix(dark, mid_, smoothstep(0.0, 0.55, k)), hi, smoothstep(0.55, 1.0, k));
    gold = mix(gold, gold * f.rgb * 1.5, 0.15 * lit);
    // Hue turns the metal itself: rose gold, green gold, blued steel.
    gold = clamp(gold * mat3(uTurn[0].xyz, uTurn[1].xyz, uTurn[2].xyz), 0.0, 1.0);
    float w = clamp(uStrength * where * 1.25, 0.0, 1.0);
    col = mix(base, gold, w);
  } else {
    // Foil under print: off the light it reads as slightly dull metal; in
    // the light, a colour dodge lifts the print into the foil's colour, so
    // dark lines in the print still hold while mid-tones blaze.
    vec3 fc = f.rgb;
    float m = clamp(amount, 0.0, 1.0);
    vec3 dull = base * (1.0 - 0.18 * uStrength * where * mid * (1.0 - lit));
    vec3 dodge = dull / max(1.0 - fc * (0.3 + 0.35 * lit), 0.1);
    vec3 tinted = mix(dodge, dodge * fc * 1.4, 0.45);
    col = mix(dull, tinted, m) + fc * max(amount - 1.0, 0.0) * 0.6 + fc * m * lit * 0.12;
  }
  float facing = dot(n, normalize(hw));

  // The reflection of the light: a tight hot spot inside a broad soft
  // bloom, screened over everything. The emboss breaks it up a little.
  float spot = exp(-hh * 500.0) * 0.8 + exp(-hh * 70.0) * 0.35 + exp(-hh * 10.0) * 0.12;
  vec3 glare = vec3(1.0, 0.98, 0.94) * spot * uGlare;
  col = 1.0 - (1.0 - clamp(col, 0.0, 1.0)) * (1.0 - clamp(glare, 0.0, 1.0));

  // Fresnel-ish sheen: the card catches more of the room near grazing, and
  // its cut edge picks up a fine bright line.
  float rest = 1.0 - clamp(facing, 0.0, 1.0);
  float graze = rest * rest * rest * 6.0;
  float rim = smoothstep(-2.5 * aa, -0.5 * aa, d) * (0.25 + spot * 1.2 + graze);
  col += vec3(0.9, 0.95, 1.0) * (graze * 0.08 + rim * 0.35 * uGlare);
  // A soft fall-off of light across the card: lit side brighter.
  col *= uFalloff;

  col = clamp(col, 0.0, 1.0) + (hash12(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    float a = inside + (1.0 - inside) * shadow * 0.6;
    fragColor = vec4(col * inside, a);
    return;
  }
  fragColor = vec4(mix(bg, col, inside), 1.0);
}
`;

const FOILS = { rainbow: 0, cosmos: 1, glitter: 2, sunpillar: 3, radiant: 4, ice: 5, gold: 6 };
// A trading card's proportions, and the eye's distance, as in the shader.
const CARD = 63 / 88;
const EYE = 2;

/** The shader's linearToSrgb, for colours that are the same for every pixel. */
const srgb = (/** @type {number[]} */ c) => c.map((v) => (v >= 0.0031308 ? 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055 : Math.max(v, 0) * 12.92));

/**
 * Everything about the card's pose that is the same for every pixel, once
 * per frame rather than once per pixel: its size, which way it leans (with
 * the pointer over the canvas, as if pressed where the pointer is;
 * otherwise a slow sway, so it never sits dead), its shadow and the light
 * falling across it. Fills the uniforms' arrays in place.
 * @param {HoloCardOptions} o @param {number} t Effect time. @param {number} aspect Canvas width over height.
 * @param {number[]} look Eased pointer x, y (0 to 1, 0 at the bottom) and how present it is.
 * @param {number} pixel One pixel, in the shader's units (one over the canvas height).
 * @param {{ rot: Float32Array, card: Float32Array, win: Float32Array, crop: Float32Array, cast: Float32Array, bounds: Float32Array }} out
 */
function pose(o, t, aspect, pixel, look, out) {
  // Its height as a share of the canvas, narrower if the canvas is too narrow.
  const H = o.size * Math.min(1, (aspect * 0.9) / CARD);
  const hx = 0.5 * H * CARD, hy = 0.5 * H;
  const swayX = (Math.sin(t * 0.55) + 0.35 * Math.sin(t * 1.31 + 2)) * 0.6;
  const swayY = (0.8 * Math.sin(t * 0.43 + 1.2) + 0.25 * Math.sin(t * 1.07)) * 0.6;
  let toX = ((look[0] - 0.5) * aspect) / (hx * 1.3), toY = (look[1] - 0.5) / (hy * 1.3);
  const ease = Math.sqrt(1 + (toX * toX + toY * toY) * 0.5); // eases off beyond the card instead of clamping
  toX /= ease;
  toY /= ease;
  const follow = look[2] * (o.interactive ? 1 : 0);
  const tilt = (o.tilt * Math.PI) / 180;
  const leanX = (swayX + (toX + swayX * 0.06 - swayX) * follow) * tilt;
  const leanY = (swayY + (toY + swayY * 0.06 - swayY) * follow) * tilt;
  // Turn about the vertical, then the horizontal, by column. Filled in
  // place: nothing is allocated per frame.
  const cy = Math.cos(leanX), sy = Math.sin(leanX), cx = Math.cos(-leanY), sx = Math.sin(-leanY);
  const { rot, card, win, crop, cast, bounds } = out;
  rot[0] = cy; rot[1] = 0; rot[2] = -sy;
  rot[4] = sx * sy; rot[5] = cx; rot[6] = sx * cy;
  rot[8] = cx * sy; rot[9] = -sx; rot[10] = cx * cy;
  const r = o.radius * 0.24 * hx;
  const lift = 1 + 0.035 * follow;
  card[0] = hx; card[1] = hy; card[2] = r; card[3] = lift;
  // The picture's window inside the frame, and how the picture fills it:
  // centred and cropped, never stretched.
  const bw = (o.showBorder ? o.border : 0) * 0.25 * hx;
  const wx = hx - bw, wy = hy - bw, wa = wx / wy;
  win[0] = wx; win[1] = wy; win[2] = Math.max(r - bw, r * 0.25);
  crop[0] = wa < aspect ? wa / aspect : 1;
  crop[1] = wa < aspect ? 1 : aspect / wa;
  // The shadow: the card's outline cast down and away from the light,
  // further and softer the more the card leans.
  const offX = (0.012 + leanX * 0.12) * H, offY = (-0.035 + leanY * 0.08) * H, blur = H * (0.06 + 0.04 * follow);
  cast[0] = offX; cast[1] = offY; cast[2] = blur; cast[3] = o.showShadow ? 0.75 : 0;
  // A box on screen round the card and its shadow: the corners as the eye
  // sees them, the shadow's the same moved by its offset, then a margin
  // wider than the shadow's soft edge (on the card it is 0.7 blur, and a
  // step on screen is never much more than a step on the card) and the
  // card's antialiased edge.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const u = (i & 1 ? hx : -hx) * lift, v = (i & 2 ? hy : -hy) * lift;
    const k = EYE / (EYE - (-sy * u + sx * cy * v));
    const px = (cy * u + sx * sy * v) * k, py = cx * v * k;
    x0 = Math.min(x0, px, px + offX);
    x1 = Math.max(x1, px, px + offX);
    y0 = Math.min(y0, py, py + offY);
    y1 = Math.max(y1, py, py + offY);
  }
  const margin = 1.5 * blur + 4 * pixel;
  bounds[0] = x0 - margin; bounds[1] = y0 - margin; bounds[2] = x1 + margin; bounds[3] = y1 + margin;
  // A soft fall-off of light across the card, lit side brighter: from
  // where its face points.
  return 1 + 0.6 * (-0.6 * cx * sy + 0.8 * -sx);
}

/** Gold's hue turn, by column: rose gold, green gold, blued steel. */
function turn(/** @type {number} */ hue) {
  const c = Math.cos(hue * 2 * Math.PI), s = Math.sin(hue * 2 * Math.PI);
  const grey = [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114];
  const cos = [0.701, -0.587, -0.114, -0.299, 0.413, -0.114, -0.3, -0.588, 0.886];
  const sin = [0.168, 0.330, -0.497, -0.328, 0.035, 0.292, 1.25, -1.05, -0.203];
  const m = grey.map((g, i) => g + c * cos[i] + s * sin[i]);
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0];
}

/** @type {import('./runtime.js').EffectSpec<HoloCardOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 2,
  speed: (o) => o.speed,
  update(o) {
    return {
      uFoil: FOILS[o.foil] ?? 0,
      uReverse: o.reverse,
      uStrength: o.strength,
      uGlare: o.glare,
      uScale: o.scale,
      uEtch: o.etch,
      uHue: o.hue,
      uBorder: o.showBorder ? o.border : 0,
      uStock: srgb(linear(o.borderColour)),
      uBackdrop: srgb(linear(o.background)),
      uTurn: Float32Array.from(turn(o.hue)),
      uTransparent: !o.showBackground,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    // The pointer helper's eased values, caught on their way to the shader:
    // the card's pose is worked out from them here, once per frame.
    const look = [0.5, 0.5, 0];
    const tap = {
      ...ctx,
      /** @param {string} name @param {import('./runtime.js').UniformValue} value */
      uniform(name, value) {
        if (name === 'uPointer') {
          const v = /** @type {ArrayLike<number>} */ (value);
          look[0] = v[0];
          look[1] = v[1];
        } else if (name === 'uPointerActive') look[2] = Number(value);
      },
    };
    const p = pointer(tap, { ease: 6 });
    const out = { rot: new Float32Array(12), card: new Float32Array(4), win: new Float32Array(4), crop: new Float32Array(2), cast: new Float32Array(4), bounds: new Float32Array(4) };
    return {
      update: (o) => image.set(o.image),
      frame(dt, time) {
        p.frame(dt);
        const o = /** @type {HoloCardOptions} */ (/** @type {unknown} */ (ctx.options?.() ?? defaults));
        const falloff = pose(o, time, ctx.canvas.width / ctx.canvas.height, 1 / ctx.canvas.height, look, out);
        ctx.uniform('uRot', out.rot);
        ctx.uniform('uCard', out.card);
        ctx.uniform('uWindow', out.win);
        ctx.uniform('uCrop', out.crop);
        ctx.uniform('uCast', out.cast);
        ctx.uniform('uFalloff', falloff);
        ctx.uniform('uBounds', out.bounds);
      },
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
 * @param {Partial<HoloCardOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function holoCard(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
