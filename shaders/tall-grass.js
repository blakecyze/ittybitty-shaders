// @ts-check
/**
 * ittybitty/tall-grass
 *
 * A meadow of tall grass under a wide sky, with the wind made visible:
 * gusts roll across the field in waves, bending the blades and catching the
 * light, row upon row receding into haze. Realistic, with backlit tips
 * glowing against a low sun; cartoon, in flat two-tone blades with inked
 * edges; or pixel, in chunky blocks. The pointer parts the grass as it
 * moves through, and a swipe sends a gust.
 *
 * https://ittybitty.dev/shaders/tall-grass (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} TallGrassOptions
 * @property {boolean} showGround The dense growth and green hills beneath the blades. Off, the blades stand alone.
 * @property {boolean} showSky The sky behind. Off, the field stands on the page.
 * @property {boolean} showSun The sun and its glow.
 * @property {boolean} showGrass The blades and the dense growth beneath them.
 * @property {boolean} showSeeds The seed heads on the tips of some blades.
 * @property {'realistic' | 'cartoon' | 'pixel'} style Realistic blades, flat cartoon shading, or chunky pixels.
 * @property {number} speed How fast the gusts roll across.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} wind How strongly the grass bends.
 * @property {number} density How thick the grass grows.
 * @property {number} height How tall the grass stands.
 * @property {number} plumes How many blades carry seed heads.
 * @property {number} sun Height of the sun, from dusk to midday.
 * @property {string} grass Colour of the grass.
 * @property {string} plume Colour of the seed heads.
 * @property {string} sky Colour of the sky.
 * @property {string} horizon Colour of the sky at the horizon.
 * @property {boolean} interactive The pointer parts the grass, and a swipe sends a gust.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {TallGrassOptions} */
export const defaults = {
  showGround: true,
  showSky: true,
  showSun: true,
  showGrass: true,
  showSeeds: true,
  style: 'realistic',
  speed: 0.6,
  zoom: 1,
  wind: 0.6,
  density: 0.6,
  height: 0.6,
  plumes: 0.3,
  sun: 0.25,
  grass: '#5f8a2e',
  plume: '#f2e6c8',
  sky: '#6f93c4',
  horizon: '#f6d7a8',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uShowGround;
uniform float uShowSky;
uniform float uShowSun;
uniform float uShowGrass;
uniform float uShowSeeds;
uniform float uPixelRatio;
uniform float uTime;
uniform float uStyle;     // 0 realistic, 1 cartoon, 2 pixel
uniform float uWind;
uniform float uDensity;
uniform float uHeight;
uniform float uPlumes;
uniform float uSun;
uniform vec3 uGrass;      // linear RGB
uniform vec3 uPlume;
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform float uInteractive;
uniform vec2 uPointer;
uniform vec2 uPointerFlow;
uniform float uPointerActive;

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

// Ordered dithering for the pixel style: a 4 by 4 Bayer threshold.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(dot(a, vec2(0.5, a.y * 0.75)));
}

float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

// The pointer's effect on a blade whose middle is at m: it parts the
// grass around it, and a swipe drives a gust along with it, both fading
// with distance.
float push(vec2 m, vec2 hand, float s, float touch, float swipe) {
  vec2 away = m - hand;
  float near = exp(-dot(away, away) / (0.03 + s * 0.03));
  return (away.x / sqrt(away.x * away.x + 0.004) * 0.6 + swipe * 0.7) * near * touch;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Zoom about the middle of the bottom edge, so the ground stays put: a
// pixel, or a point in 0..1 canvas space (such as the pointer), as the
// zoomed view sees it.
vec2 zoomed(vec2 fc) {
  vec2 anchor = vec2(0.5 * uResolution.x, 0.0);
  return (fc - anchor) / uZoom + anchor;
}

vec2 zoomedUv(vec2 uv) {
  return (uv - vec2(0.5, 0.0)) / uZoom + vec2(0.5, 0.0);
}

void main() {
  bool realistic = uStyle < 0.5;
  bool pixel = uStyle > 1.5;
  // Pixel style: the whole scene is sampled once per chunky block.
  float block = 4.0 * uPixelRatio;
  vec2 frag = pixel ? (floor(zoomed(gl_FragCoord.xy) / block) + 0.5) * block : zoomed(gl_FragCoord.xy);
  vec2 uv = frag / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime;
  float aa = pixel ? 1e-5 : 1.0 / (uResolution.y * uZoom);

  // Sky: warm at the horizon, with the sun glowing through the haze.
  float horizonY = 0.42;
  vec3 sunCol = mix(vec3(1.0, 0.62, 0.32), vec3(1.0, 0.95, 0.85), uSun);
  vec3 sky = mix(uHorizon, uSky, smoothstep(horizonY, 1.0, uv.y)) * uShowSky;
  vec2 sunAt = vec2(aspect * 0.72, mix(horizonY + 0.05, 0.85, uSun));
  // A round sun, or a square one in pixels.
  float sd = pixel ? max(abs(p.x - sunAt.x), abs(p.y - sunAt.y)) : length(p - sunAt);
  vec3 sunLight = sunCol * (exp(-length(p - sunAt) * 8.0) * (pixel ? 0.25 : 0.45) + smoothstep(0.036 + aa, 0.036 - aa, sd) * 1.4) * uShowSun;
  sky += sunLight;
  vec3 haze = mix(uHorizon, uSky, 0.15) + sunCol * 0.08;

  // Wind. Gusts roll across the field as travelling waves; the pointer
  // parts the grass around it, and a swipe drives a gust along with it.
  vec2 hand = vec2(zoomedUv(uPointer).x * aspect, zoomedUv(uPointer).y);
  float touch = uInteractive * uPointerActive;
  // A swipe: a gust from the pointer's movement, steady at any
  // responsiveness, that dies away after the pointer stops.
  float swipe = clamp(uPointerFlow.x * aspect * 0.35, -1.0, 1.0);
  // Backlight: how far the sun sits low and ahead of us.
  float backlit = smoothstep(0.7, 0.0, uSun);

  vec3 colour = vec3(0.0);
  float through = 1.0;                                     // light still passing
  // Rows from near to far. Each covers everything below its own ground, so
  // once a row's mass is reached nothing further back can show.
  const int ROWS = 11;
  for (int r = 0; r < ROWS; r++) {
    float z = float(r) / float(ROWS - 1);                  // 0 near, 1 far
    float dist = mix(1.0, 14.0, pow(z, 1.6));
    float s = 1.0 / dist;                                  // perspective scale
    float ground = horizonY - 0.5 * s;
    float len = mix(0.25, 0.8, uHeight) * s;
    float spacing = (pixel ? 0.05 : realistic ? 0.013 : 0.02) * s / (0.4 + uDensity);
    // Above this row's tallest blades: nothing of it here.
    if (p.y > ground + len * 1.1) continue;
    float fade = smoothstep(0.1, 1.0, z);                  // haze with distance
    float wave = noise(vec2(p.x / (s * 1.8) * 0.5 - t * 0.9, z * 5.0)) * 0.7 + noise(vec2(p.x / s * 1.3 - t * 1.7, z * 9.0 + 3.0)) * 0.3;
    // The mass: dense growth below the blade tips, ragged along its top.
    float massTop = ground + len * (0.3 + 0.25 * noise(vec2(p.x / s * 3.0, float(r) * 3.1)));

    // Blades too fine to draw cleanly are left to the mass.
    float spacingPx = spacing * uResolution.y * uZoom;
    // Without the ground to stand in for them, finer far blades are drawn.
    bool blades = spacingPx > (pixel ? block * 2.5 : mix(0.9, 2.0, uShowGround) * uPixelRatio);
    // Blades in three layers of height, and without the ground, a fourth of
    // short tufts that fills in around the roots. A blade's tip can lean far
    // from its root, so each layer searches around where the local wind
    // would have put the roots of blades reaching this pixel.
    float windBend = (0.2 + wave * 0.9) * uWind;
    for (int j = 0; j < 4; j++) {
      if (!blades || p.y < ground || through == 0.0 || (j == 3 && uShowGround > 0.5)) break;
      float layerLen = len * (1.0 - float(j) * 0.2);
      if (p.y > ground + layerLen * 1.1) break;
      float yEst = clamp((p.y - ground) / layerLen, 0.0, 1.0);
      // Wind and pointer vary smoothly over a few blades, so the bend is
      // worked out once for the layer: first from the wind here, then with
      // the pointer's push at the estimated roots. Each blade adds only a
      // small lean of its own, so the search around the roots can be tight.
      float bendEst = clamp(windBend, -1.2, 1.2);
      float shift = bendEst * 0.75 * layerLen * (1.0 - 0.3 * bendEst * bendEst) * yEst * yEst;
      float layerBend = windBend;
      if (touch != 0.0) layerBend += push(vec2(p.x - shift, ground + layerLen * 0.5), hand, s, touch, swipe);
      bendEst = clamp(layerBend, -1.2, 1.2);
      shift = bendEst * 0.75 * layerLen * (1.0 - 0.3 * bendEst * bendEst) * yEst * yEst;
      float id = floor((p.x - shift) / spacing + float(j) * 0.37);
      // A wider search only while the pointer is bending blades unevenly.
      float kMax = touch > 0.01 ? 5.0 : 3.0;
      for (int k = -5; k <= 5; k++) {
        if (through == 0.0) break;
        if (abs(float(k)) > kMax) continue;
        float cellId = id + float(k);
        float bid = cellId + float(r) * 173.0 + float(j) * 1031.0;
        float h = hash11(bid * 7.13 + 1.7);
        float h2 = hash11(bid * 3.71 + 11.0);
        float x0 = (cellId - float(j) * 0.37 + h) * spacing;
        float bl = layerLen * (0.9 + 0.2 * h2);
        if (p.y > ground + bl) continue;
        // The bend at this blade: the layer's wind, a small lean of its own,
        // and the pointer's push, which changes too quickly to share.
        float gust = wave;
        float bend = windBend + (h - 0.5) * 0.16;
        if (touch > 0.01) bend += push(vec2(x0, ground + bl * 0.5), hand, s, touch, swipe);
        bend += sin(t * (2.0 + h * 2.0) + h * 40.0) * 0.04 * uWind;
        bend = clamp(bend, -1.2, 1.2);
        // Bent blades stand a little lower.
        float tall = bl * (1.0 - 0.3 * bend * bend);
        float y = (p.y - ground) / tall;                   // 0 root, 1 tip
        if (y < 0.0 || y > 1.0) continue;
        float curve = bend * 0.75 * tall;
        float cx = x0 + curve * y * y;
        float slope = 2.0 * curve * y / tall;
        float w = (realistic ? 0.0065 : pixel ? 0.009 : 0.007) * s * (0.7 + 0.6 * h2) * pow(1.0 - y, realistic ? 0.75 : 1.0);
        // Without the ground, blades flare at the root, as a tuft does, so the
        // field closes up at the bottom.
        w *= 1.0 + (1.0 - uShowGround) * 2.0 * (1.0 - y) * (1.0 - y);
        float dx = (p.x - cx) / sqrt(1.0 + slope * slope);
        float a = smoothstep(w + aa, w - aa, abs(dx));
        // Seed heads on some blades: realistic, a wispy spray; otherwise a
        // round bud.
        float seed = step(1.0 - uPlumes * 0.25, hash11(bid * 5.3 + 2.0));
        float head = 0.0;
        if (seed > 0.0 && uShowSeeds > 0.0 && y >= 0.72) {
          float hy = (y - 0.72) / 0.28;
          float hw = (realistic ? 0.006 : 0.008) * s * sin(clamp(hy, 0.0, 1.0) * 3.14159);
          head = smoothstep(hw + aa, hw * 0.3, abs(dx)) * step(0.0, hy);
          if (realistic && head > 0.0) head *= 0.55 + 0.45 * noise(vec2(dx / max(hw, 1e-4) * 3.0, y * 50.0 + bid));
        }
        head *= uShowSeeds;
        a = max(a * uShowGrass, head);
        if (a <= 0.0) continue;

        vec3 c;
        vec3 base = uGrass * mix(vec3(0.85, 1.0, 0.8), vec3(1.15, 1.05, 0.75), h);   // no two blades alike
        if (realistic) {
          // Dark at the root where light can't reach, brighter and yellower
          // towards the tip; lighter where a gust lays the blades over.
          c = mix(base * 0.12, base * 1.2 + vec3(0.05, 0.04, 0.0), smoothstep(0.0, 0.85, y));
          c *= 1.0 + (gust - 0.4) * 0.5 * uWind * y;
          // Backlit by a low sun, the thin tips glow warm.
          c += sunCol * backlit * pow(y, 2.5) * 0.35 * (0.5 + h);
          c = mix(c, uPlume * mix(0.7, 1.2, y) + sunCol * backlit * 0.3, head);
        } else {
          // Flat two-tone: the side facing the sun lit, the other in shade.
          // Pixel blades are a block wide: one tone each, lighter or darker.
          float lit = pixel ? step(0.5, h) : step(0.0, dx * sign(sunAt.x - x0 + 0.001));
          c = mix(base * 0.62, base * 1.18, lit);
          c = mix(c, base * 1.35, step(0.8, y) * 0.5);   // a pale tip
          if (!pixel) {
            // An inked edge.
            float edge = smoothstep(w - 2.2 * aa, w - 0.8 * aa, abs(dx)) * (1.0 - head);
            c = mix(c, base * 0.28, edge);
          }
          c = mix(c, uPlume, head);
        }
        // Distance: into the haze, or with no sky, into the page.
        c = mix(c, haze, fade * 0.8 * uShowSky);
        a *= mix(1.0 - fade * 0.75, 1.0, uShowSky);
        colour += through * a * c;
        through *= 1.0 - a;
      }
    }
    if (through < 0.01) break;
    // The row's mass, behind its blades.
    float inMass = smoothstep(aa, -aa, p.y - massTop) * uShowGrass * uShowGround;
    if (inMass > 0.0) {
      float dep = clamp((massTop - p.y) / max(len * 0.4, 1e-3), 0.0, 1.0);
      vec3 m;
      if (realistic) {
        m = uGrass * mix(0.42, 0.16, dep) * (0.8 + 0.35 * noise(vec2(p.x / s * 120.0, p.y / s * 12.0)));
        m *= 1.0 + (wave - 0.4) * 0.4 * uWind;
      } else {
        m = uGrass * mix(0.8, 0.55, step(0.35, dep));
      }
      m = mix(m, haze, fade * 0.8 * uShowSky);
      inMass *= mix(1.0 - fade * 0.75, 1.0, uShowSky);
      colour += through * inMass * m;
      through *= 1.0 - inMass;
      if (through < 0.01) break;
    }
  }
  // Premultiplied: what the field leaves uncovered shows the sky, or with
  // the sky off, the page (and the sun, if it is on).
  colour += through * sky;
  float alpha = 1.0 - through * (1.0 - max(uShowSky, min(max(sunLight.r, max(sunLight.g, sunLight.b)), 1.0)));

  if (realistic) colour = 1.0 - exp(-colour * 1.25);
  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  if (pixel) c = floor(c * 7.0 + 0.5 + (bayer4(gl_FragCoord.xy / block) - 0.5) * 0.7) / 7.0;   // a small, dithered palette
  else c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

const STYLES = { realistic: 0, cartoon: 1, pixel: 2 };

/** @type {import('./runtime.js').EffectSpec<TallGrassOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 10,
  speed: (o) => o.speed,
  update(o) {
    return {
      uZoom: o.zoom,
      uShowGround: o.showGround,
      uShowSky: o.showSky,
      uShowSun: o.showSun,
      uShowGrass: o.showGrass,
      uShowSeeds: o.showSeeds,
      uStyle: STYLES[o.style] ?? 0,
      uWind: o.wind,
      uDensity: o.density,
      uHeight: o.height,
      uPlumes: o.plumes,
      uSun: o.sun,
      uGrass: linear(o.grass),
      uPlume: linear(o.plume),
      uSky: linear(o.sky),
      uHorizon: linear(o.horizon),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 3 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<TallGrassOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function tallGrass(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
