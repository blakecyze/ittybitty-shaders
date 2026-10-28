// @ts-check
/**
 * ittybitty/ocean
 *
 * Open sea to the horizon. Each pixel's view ray is traced onto a moving
 * surface built from thirty-two wave trains. Each train is an exponentiated
 * sine, so crests are narrow and troughs wide, and each one drags the next
 * towards its crests, so ripples gather on the peaks the way wind chop does.
 * Every train travels at the speed deep water gives its wavelength.
 *
 * Lighting follows the physically based ocean shaders of recent years:
 * Schlick Fresnel between a reflected sky (with its own clouds) and a water
 * body lit by an Atlas-style subsurface term, so crests glow where the sun
 * shines through them; a GGX sun whose roughness grows with distance, so
 * detail too small to draw still reads as a widening path of light; and
 * foam where crests pinch, trailing behind them as they pass. A camera
 * that rides the swell, aerial haze and an ACES curve finish it.
 *
 * Heavy: a traced surface and a detailed normal per pixel. It renders at a
 * pixel ratio of up to 1.5 and pairs well with adaptive resolution.
 *
 * https://ittybitty.dev/shaders/ocean (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} OceanOptions
 * @property {boolean} showSky The sky. Off, the sea sits on the page.
 * @property {boolean} showWater The sea, its foam and reflections.
 * @property {number} speed How fast the sea moves.
 * @property {number} zoom Zoom in for a closer view, or out to see more.
 * @property {number} waves Height of the swell.
 * @property {number} chop How sharp and steep the crests are.
 * @property {number} wind Direction the swell travels, in degrees.
 * @property {number} sun Height of the sun, from the horizon to overhead.
 * @property {number} foam How readily crests break into foam.
 * @property {number} clouds How much of the sky is cloud, 0 to 1.
 * @property {number} camera Height of the viewer above the water.
 * @property {string} deep Colour of deep water.
 * @property {string} sky Colour of the sky overhead.
 * @property {string} horizon Colour of the sky at the horizon.
 * @property {boolean} showSun Show the sun, its glow and the glitter it lays on the water.
 * @property {boolean} interactive Look around with the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {OceanOptions} */
export const defaults = {
  showSky: true,
  showWater: true,
  speed: 0.6,
  zoom: 1,
  waves: 0.8,
  chop: 0.55,
  wind: 20,
  sun: 0.12,
  foam: 0.5,
  clouds: 0.4,
  camera: 4,
  deep: '#041a2b',
  sky: '#1b2d55',
  horizon: '#f4a36c',
  showSun: true,
  interactive: true,
  responsiveness: 0.5,
};

const WAVES = 32;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uZoom;
uniform float uShowWater;
uniform float uTime;
uniform float uWaves;
uniform float uChop;
uniform vec2 uWind;       // unit vector the swell travels along
uniform vec3 uSunDirection;
uniform vec3 uSunLight;
uniform float uFoam;
uniform float uClouds;
uniform float uCamera;
uniform vec3 uDeep;       // linear RGB
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform float uInteractive;
uniform float uSunDisc;
uniform float uTransparent;
uniform vec4 uWave[${WAVES}]; // per train: direction, frequency, angular speed
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

const float PI = 3.14159265;
const float SCALE = 0.14;   // wave units per metre: the longest train is about 45 m
const float MEAN = 0.42;    // mean of the normalised surface, which sits at sea level
const int TRACE = 12;       // trains used to find the surface
const int DETAIL = 32;      // trains used to shade it
const float LIFT = 4.2;     // metres of height per unit of swell

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec2 hash22(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return v;
}

// Distance to the nearest cell edge of a moving Worley pattern: thin lines
// where cells meet, the lace that foam leaves on water.
float lace(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = hash22(i + g);
      o = 0.5 + 0.4 * sin(t * 0.6 + 6.2831 * o);
      vec2 delta = g + o - f;
      float d = dot(delta, delta);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
  }
  return sqrt(d2) - sqrt(d1);
}

// The surface, normalised to roughly 0..1. Each train is exp(sin) shaped,
// sharpened by chop, and pulls the sample point along its slope before the
// next train is read, which crowds small waves onto big crests. Trains too
// fine to resolve at this distance (blur, in wave units) fade to their mean.
float waves(vec2 p, float t, int count, float blur) {
  vec2 q = p * SCALE;
  float drag = mix(0.1, 0.48, uChop);
  float sharp = mix(0.65, 1.7, uChop);
  float amp = 1.0;
  float sum = 0.0;
  float total = 0.0;
  for (int i = 0; i < ${WAVES}; i++) {
    if (i >= count) break;
    vec4 w = uWave[i];
    float x = dot(w.xy, q) * w.z - t * w.w;
    float e = exp(sharp * (sin(x) - 1.0));
    float keep = 1.0 - smoothstep(0.6, 2.4, blur * w.z);
    sum += amp * mix(MEAN, e, keep);
    total += amp;
    q -= w.xy * (e * sharp * cos(x)) * amp * drag * keep;
    amp *= 0.8;
  }
  return sum / total;
}

float height(vec2 p, float t, int count, float blur) {
  return (waves(p, t, count, blur) - MEAN) * uWaves * LIFT;
}

// Clouds on a flat layer overhead, lit from the sun's side with a silver
// edge towards it. Returns colour and coverage.
vec4 cloudLayer(vec3 d, vec3 s, vec3 sky, float t) {
  if (uClouds <= 0.0 || d.y <= 0.0) return vec4(0.0);
  vec2 p = d.xz / (d.y + 0.06) * 0.9 + uWind * t * 0.02;
  float den = fbm(p);
  float cover = smoothstep(0.66 - uClouds * 0.36, 0.84 - uClouds * 0.3, den);
  if (cover == 0.0) return vec4(0.0);
  // Self-shadow: denser towards the sun means a darker underside.
  float toward = fbm(p + s.xz * 0.35 / (s.y + 0.2));
  float lit = exp(-max(toward - den + 0.08, 0.0) * 6.0);
  float mu = max(dot(d, s), 0.0);
  vec3 sun = uSunLight;
  vec3 base = mix(uSky, uHorizon, 0.35) * 0.5;
  vec3 c = base + sun * (0.04 + 0.3 * lit) + sun * pow(mu, 6.0) * 0.9 * (1.0 - cover * 0.6);
  // Thin out towards the horizon, where the layer is seen edge on.
  return vec4(c, cover * smoothstep(0.0, 0.14, d.y));
}

// The sky seen along d. The sun disc is optional so reflections leave it
// to the specular term, which filters it properly.
vec3 skyColour(vec3 d, bool disc, float t) {
  vec3 s = uSunDirection;
  float up = clamp(d.y, 0.0, 1.0);
  float mu = dot(d, s);
  // The horizon glows on the sun's side and cools away from it.
  float side = pow(0.5 + 0.5 * dot(normalize(d.xz + 1e-4), normalize(s.xz + 1e-4)), 2.0);
  vec3 low = mix(mix(uSky, uHorizon, 0.45), uHorizon, side);
  vec3 c = mix(low, uSky, 1.0 - exp(-up * 7.0));
  vec3 sun = uSunLight;
  // Forward scattering around the sun (Henyey-Greenstein) and a wide glow.
  float g = 0.76;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / (4.0 * PI);
  c += uSunDisc * sun * (hg * 0.12 + pow(max(mu, 0.0), 8.0) * 0.12);
  vec4 cl = cloudLayer(d, s, c, t);
  c = mix(c, cl.rgb, cl.a);
  if (disc) c += uSunDisc * sun * (smoothstep(0.99972, 0.99986, mu) * 14.0 + pow(max(mu, 0.0), 600.0) * 1.5) * (1.0 - cl.a * 0.9);
  return c;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
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

  // Camera: rides the swell a little, rising, falling and rolling with it.
  vec3 ro = vec3(0.0, 0.0, t * 1.2);
  float bob = height(ro.xz, t, 4, 0.0);
  float roll = (height(ro.xz + vec2(1.5, 0.0), t, 4, 0.0) - height(ro.xz - vec2(1.5, 0.0), t, 4, 0.0)) * 0.035;
  ro.y = uCamera + bob * 0.55;
  uv = mat2(cos(roll), -sin(roll), sin(roll), cos(roll)) * uv;

  // The pointer turns the head.
  vec2 look = (zoomedUv(uPointer) - 0.5) * uPointerActive * uInteractive;
  float yaw = look.x * 0.5;
  float pitch = -0.2 + look.y * 0.25 + (height(ro.xz + vec2(0.0, 2.0), t, 4, 0.0) - bob) * 0.02;
  vec3 rd = normalize(vec3(uv.x, uv.y + pitch, 1.3));
  rd.xz = mat2(cos(yaw), -sin(yaw), sin(yaw), cos(yaw)) * rd.xz;

  vec3 colour;
  float alpha = 1.0;
  if (rd.y >= -0.002) {
    colour = skyColour(rd, true, t);
    alpha = 1.0 - uTransparent;
  } else if (uShowWater < 0.5) {
    colour = vec3(0.0);
    alpha = 0.0;
  } else {
    // Trace between the highest crest and the lowest trough: step to the
    // first point below the surface, so near crests hide what is behind
    // them, then refine by regula falsi.
    float top = uWaves * LIFT * (1.0 - MEAN);
    float bottom = -uWaves * LIFT * MEAN;
    float t0 = max((ro.y - top) / -rd.y, 0.0);
    float t1 = min((ro.y - bottom) / -rd.y, 6000.0);
    float h0 = (ro + rd * t0).y - height((ro + rd * t0).xz, t, TRACE, 0.0);
    float h1 = h0;
    float ta = t0;
    float tb = t1;
    for (int i = 1; i <= 10; i++) {
      tb = mix(t0, t1, pow(float(i) / 10.0, 2.0));
      h1 = (ro + rd * tb).y - height((ro + rd * tb).xz, t, TRACE, 0.0);
      if (h1 < 0.0) break;
      ta = tb;
      h0 = h1;
    }
    float tm = tb;
    for (int i = 0; i < 6; i++) {
      tm = mix(ta, tb, h0 / max(h0 - h1, 1e-4));
      float hm = (ro + rd * tm).y - height((ro + rd * tm).xz, t, TRACE, 0.0);
      if (hm < 0.0) { tb = tm; h1 = hm; } else { ta = tm; h0 = hm; }
    }
    vec3 p = ro + rd * tm;

    // How much ground one pixel covers here, stretched at grazing angles.
    float pixel = tm / (uResolution.y * 1.3 * uZoom) / sqrt(max(-rd.y, 0.02));
    float blur = pixel * SCALE;

    // Normal and curvature from central differences on the detailed surface.
    float e = 0.05 + pixel * 0.5;
    float hc = height(p.xz, t, DETAIL, blur);
    float hx0 = height(p.xz - vec2(e, 0.0), t, DETAIL, blur);
    float hx1 = height(p.xz + vec2(e, 0.0), t, DETAIL, blur);
    float hz0 = height(p.xz - vec2(0.0, e), t, DETAIL, blur);
    float hz1 = height(p.xz + vec2(0.0, e), t, DETAIL, blur);
    vec3 n = normalize(vec3(hx0 - hx1, 2.0 * e, hz0 - hz1));
    float pinch = -(hx0 + hx1 + hz0 + hz1 - 4.0 * hc) / (e * e);

    vec3 s = uSunDirection;
    vec3 v = -rd;
    vec3 sun = uSunLight;
    float nv = max(dot(n, v), 0.02);
    float ns = max(dot(n, s), 0.0);
    float crest = smoothstep(0.3, 0.85, hc / max(uWaves * LIFT, 1e-3) + MEAN);

    // Reflection: the sky and its clouds, without the disc.
    vec3 r = reflect(rd, n);
    r.y = abs(r.y);
    float fresnel = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    vec3 reflected = skyColour(r, false, t);

    // Sun: GGX, rougher with distance, standing in for the waves too small
    // to draw, so the path of light widens towards the horizon.
    float rough = 0.025 + 0.2 * smoothstep(0.0, 3.0, pixel);
    float a2 = rough * rough;
    vec3 hv = normalize(s + v);
    float nh = max(dot(n, hv), 0.0);
    float dist = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
    float fs = 0.02 + 0.98 * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
    float k = rough * 0.5;
    float vis = 1.0 / ((nv * (1.0 - k) + k) * (ns * (1.0 - k) + k));
    vec3 glitter = uSunDisc * sun * dist * fs * vis * ns * 0.25;

    // Water body: ambient deep colour from the sky, plus light scattered
    // up through the water (after the Atlas GDC talk): strongest through
    // high crests seen against the sun, some everywhere facing the viewer.
    vec3 ambient = mix(uHorizon, uSky, 0.5) * 0.5 + 0.1;
    // Light through the water turns green-blue, leaning to the deep colour.
    vec3 glow = mix(vec3(0.02, 0.36, 0.32), normalize(uDeep + 1e-4) * 0.4, 0.3);
    float through = 2.4 * crest * crest * pow(max(dot(s, rd), 0.0), 4.0) * pow(0.5 - 0.5 * dot(s, n), 3.0);
    float facing = 0.35 * nv * nv;
    vec3 body = uDeep * ambient * 1.4
      + glow * sun * (through + facing * 0.25 + ns * 0.04)
      + glow * ambient * crest * 0.12;

    // Foam: where crests pinch, and trailing behind them. Crests seen at
    // earlier times left foam that fades as it drifts.
    float fresh = smoothstep(0.45, 0.85, crest) * smoothstep(0.0, 0.35, pinch / max(uWaves, 0.2));
    float trail = 0.0;
    if (uFoam > 0.0) {
      for (int i = 1; i <= 3; i++) {
        float back = float(i) * 0.9;
        float c = waves(p.xz, t - back, 6, blur);
        trail = max(trail, smoothstep(0.55, 0.8, c) * exp(-float(i) * 0.55));
      }
    }
    float amount = clamp((fresh * 1.4 + trail * 0.7) * uFoam, 0.0, 1.0);
    float foam = 0.0;
    if (amount > 0.0) {
      // Far off, the pattern averages out instead of shimmering.
      float pattern = 0.55;
      if (pixel < 2.0) {
        // Lace at two scales, its lines warped and broken so no cell reads.
        vec2 fp = p.xz * 0.9 + uWind * t * 0.2;
        fp += (vec2(noise(fp * 1.1), noise(fp * 1.1 + 17.0)) - 0.5) * 1.1;
        float web = max(1.0 - smoothstep(0.0, 0.14, lace(fp, t)), 0.8 * (1.0 - smoothstep(0.0, 0.18, lace(fp * 2.3 + 5.0, t))));
        pattern = web * (0.45 + 0.55 * noise(fp * 2.7)) + noise(fp * 5.3) * 0.3;
        pattern = mix(pattern, 0.55, smoothstep(0.3, 2.0, pixel));
      }
      foam = smoothstep(1.0 - amount, 1.0 - amount + 0.25, pattern) * amount;
    }
    // Bubbles below the foam lighten the water around it.
    body += glow * sun * amount * 0.08;

    colour = mix(body, reflected, fresnel) + glitter;
    vec3 foamColour = vec3(0.92, 0.95, 0.96) * (sun * (0.25 + 0.6 * ns) + ambient * 0.9);
    colour = mix(colour, foamColour, foam * 0.92);

    // Air between the viewer and far water: haze the colour of the horizon
    // in that direction, sun glow included.
    float air = 1.0 - exp(-tm * 0.0011);
    if (uTransparent > 0.5) alpha = 1.0 - air;
    else colour = mix(colour, skyColour(normalize(vec3(rd.x, 0.001, rd.z)), false, t), air);
  }

  colour = aces(colour * 0.75);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour * alpha, alpha);
}
`;

/** Same hash as the shader once used, so the sea keeps its shape. */
const hash11 = (/** @type {number} */ p) => {
  p = (p * 0.1031) % 1;
  p *= p + 33.33;
  p *= p + p;
  return p % 1;
};

const trains = new Float32Array(WAVES * 4);
/**
 * Trains fan around the wind at golden-angle steps, so no two align. Long
 * swells keep close to the wind; short chop spreads wider, as it does at
 * sea. Frequencies rise by 1.18 a train, each travelling at the speed deep
 * water gives its wavelength (ω = √(gk)).
 * @param {number} wind Radians.
 */
function trainsFor(wind) {
  let f = 1;
  for (let i = 0; i < WAVES; i++) {
    const spread = 0.3 + 0.9 * (i / (WAVES - 1));
    const a = wind + (((i * 2.39996) % 6.28318) - 3.14159) * spread * 0.5 + (hash11(i * 7.31) - 0.5) * 0.25;
    const k = f * 0.14; // matches SCALE in the shader: wavenumber in radians per metre
    trains.set([Math.cos(a), Math.sin(a), f, Math.sqrt(9.8 * k)], i * 4);
    f *= 1.18;
  }
  return trains;
}

/** @type {import('./runtime.js').EffectSpec<OceanOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 20,
  speed: (o) => o.speed,
  update(o) {
    const wind = (o.wind * Math.PI) / 180;
    const deep = linear(o.deep);
    const sky = linear(o.sky);
    const horizon = linear(o.horizon);
    const sunHeight = 0.03 * (1 - o.sun) + 0.95 * o.sun;
    const sunLength = Math.hypot(sunHeight, 1);
    const sunDirection = [0, sunHeight / sunLength, 1 / sunLength];
    // A low sun is dimmer and redder; under a dark sky it becomes the moon.
    const m = 1 / (Math.max(sunDirection[1], 0) + 0.04);
    const luminance = (horizon[0] + sky[0]) * 0.2126 + (horizon[1] + sky[1]) * 0.7152 + (horizon[2] + sky[2]) * 0.0722;
    const day = Math.max(0, Math.min(1, (luminance - 0.015) / (0.12 - 0.015)));
    const blend = day * day * (3 - 2 * day);
    const transmission = 1 - 0.7 * o.clouds * o.clouds;
    const sunLight = [0.28, 0.7, 1.7].map((extinction, i) =>
      (([0.5, 0.62, 0.9][i] * 0.45) * (1 - blend) + Math.exp(-extinction * 0.12 * m) * 3.2 * blend) * transmission);
    return {
      uZoom: o.zoom,
      uShowWater: o.showWater,
      uWaves: o.waves,
      uChop: o.chop,
      uWind: [Math.cos(wind), Math.sin(wind)],
      uWave: trainsFor(wind),
      uSunDirection: sunDirection,
      uSunLight: sunLight,
      uFoam: o.foam,
      uClouds: o.clouds,
      uCamera: o.camera,
      uDeep: deep,
      uSky: sky,
      uHorizon: horizon,
      uInteractive: o.interactive,
      uSunDisc: o.showSun,
      uTransparent: !o.showSky,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 2 });
    return { frame: p.frame, destroy: p.destroy };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<OceanOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function ocean(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
