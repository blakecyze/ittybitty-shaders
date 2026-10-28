// @ts-check
/**
 * ittybitty/clouds
 *
 * A sky of real clouds: a layer of vapour marched through in a few dozen
 * steps, lit by the sun with light scattering forward through thin edges
 * (the silver lining) and absorbed in thick cores, over a physically shaded
 * sky. The clouds drift and slowly change shape. The pointer tilts the view.
 *
 * Heavier than most effects, by design; adaptive resolution is recommended.
 *
 * https://ittybitty.dev/shaders/clouds (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} CloudsOptions
 * @property {boolean} showSky The sky behind. Off, only the clouds are drawn, over the page.
 * @property {boolean} showSun The sun and its glow.
 * @property {boolean} showClouds The clouds themselves.
 * @property {boolean} showBolt The lightning bolts, when there is lightning.
 * @property {number} speed How fast the clouds drift.
 * @property {number} cover How much of the sky is cloud.
 * @property {number} density How thick and dark the clouds are.
 * @property {number} scale Size of the clouds.
 * @property {number} sun Height of the sun, from sunset to midday.
 * @property {number} quality Steps through the clouds: more is softer and heavier.
 * @property {string} sky Colour of the sky overhead.
 * @property {string} horizon Colour of the sky at the horizon.
 * @property {string} light Colour of the sunlight.
 * @property {boolean} interactive The pointer tilts the view.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 * @property {'horizon' | 'overhead' | 'above'} view Looking out to the horizon, straight up into the sky, or flying above a sea of clouds.
 * @property {number} lightning How often lightning flashes inside the clouds; 0 for none.
 */

/** @type {CloudsOptions} */
export const defaults = {
  showSky: true,
  showSun: true,
  showClouds: true,
  showBolt: true,
  speed: 0.4,
  cover: 0.5,
  density: 0.6,
  scale: 1,
  sun: 0.35,
  quality: 0.6,
  sky: '#3f7bd0',
  horizon: '#bcd7ee',
  light: '#fff4e2',
  interactive: true,
  responsiveness: 0.4,
  view: 'horizon',
  lightning: 0,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowSun;
uniform float uShowClouds;
uniform float uShowBolt;
uniform float uTime;
uniform float uCover;
uniform float uDensity;
uniform float uScale;
uniform float uSun;
uniform float uSteps;
uniform vec3 uSky;        // linear RGB
uniform vec3 uHorizon;
uniform vec3 uLight;
uniform float uInteractive;
uniform float uTransparent;
uniform float uView;      // 0 horizon, 1 overhead, 2 above
uniform float uLightning;
uniform float uClock;     // seconds, for lightning (not scaled by speed)
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

// Cloud density at p. A low-frequency shape decides where clouds are; finer
// noise then erodes their edges into billows, so each cloud has a defined
// body and a crisp, cauliflower outline.
// The cloud layer's coarse shape at p, before erosion: above 0 inside a
// cloud. q is the point in noise space, for erode().
float shapeAt(vec3 p, float t, out vec3 q) {
  q = p * 1.1 / uScale + vec3(t * 0.6, 0.0, t * 0.25);
  float base = noise(q * 0.5) * 0.65 + noise(q * 1.1 + 7.0) * 0.35;
  float h = clamp((p.y - 3.0) / 1.4, 0.0, 1.0);
  // Flat bases, rounded tops: the layer's profile.
  float profile = smoothstep(0.0, 0.08, h) * smoothstep(1.0, 0.35, h);
  return base * profile - (1.0 - uCover) * 0.62 - 0.12;
}

// Coarse density: the shape alone, for light samples.
float coarse(vec3 p, float t) {
  vec3 q;
  return clamp(shapeAt(p, t, q) * 5.0, 0.0, 1.0) * uDensity * 3.0;
}

// Full density from a shape already found: finer billows carve the edges,
// more strongly near the edge. One octave close to the viewer's scale does
// most of the work.
float erode(float shape, vec3 q, float t) {
  float detail = noise(q * 3.1 + vec3(0.0, t * 0.2, 0.0));
  shape -= (1.0 - detail) * 0.22 * (1.0 - smoothstep(0.0, 0.3, shape));
  return clamp(shape * 9.0, 0.0, 1.0) * uDensity * 3.5;
}

vec3 skyColour(vec3 rd, vec3 sun) {
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uSky, pow(up, 0.55));
  float s = max(dot(rd, sun), 0.0);
  return c;
}

// The sun: a bright disc and the glow around it.
vec3 sunLight(vec3 rd, vec3 sun) {
  float s = max(dot(rd, sun), 0.0);
  return uLight * (pow(s, 8.0) * 0.25 + pow(s, 900.0) * 6.0) * uShowSun;
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

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// Lightning: time is cut into slots; some slots hold a strike, which
// flickers in two or three strobes. Returns brightness, and where it is.
float flash(out vec3 at, out float seed) {
  float slot = mix(7.0, 1.4, uLightning);
  float k = floor(uClock / slot);
  float tau = uClock - k * slot;
  seed = k;
  at = vec3((hash11(k * 3.7) - 0.5) * 12.0, 3.25, 7.0 + hash11(k * 9.1) * 12.0);
  if (uLightning <= 0.0 || hash11(k * 1.9) > 0.35 + 0.65 * uLightning) return 0.0;
  float start = hash11(k * 5.3) * max(slot - 1.2, 0.1);
  float x = tau - start;
  if (x < 0.0 || x > 1.2) return 0.0;
  // A main strike, then after-strokes flickering over half a second, each
  // a little dimmer: how real lightning reads to the eye.
  float strobe = exp(-pow((x - 0.05) * 12.0, 2.0))
    + 0.8 * exp(-pow((x - 0.24) * 16.0, 2.0))
    + 0.55 * exp(-pow((x - 0.46) * 14.0, 2.0))
    + 0.3 * exp(-pow((x - 0.7) * 12.0, 2.0));
  return strobe + 0.2 * exp(-x * 3.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime * 0.25;
  vec2 look = (uPointer - 0.5) * uPointerActive * uInteractive;
  // The camera. Horizon: on the ground, looking up past the horizon.
  // Overhead: lying on the grass, looking straight up. Above: flying high
  // over the cloud layer, looking out and down.
  float camY = uView > 1.5 ? 6.2 : uView > 0.5 ? -3.0 : 0.0;
  float tilt = uView > 1.5 ? -0.22 : 0.42;
  vec3 rd = uView > 0.5 && uView < 1.5
    ? normalize(vec3(uv.x + look.x * 0.3, 0.85, uv.y + 0.1 + look.y * 0.3))
    : normalize(vec3(uv.x + look.x * 0.3, uv.y + tilt + look.y * 0.2, 1.0));
  vec3 ro = vec3(0.0, camY, t * (uView > 1.5 ? 1.5 : 0.0));
  vec3 sun = normalize(vec3(0.35, mix(0.06, 0.8, uSun), 1.0));
  // Warmer, dimmer light when the sun is low.
  vec3 light = uLight * mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(0.0, 0.5, uSun));

  vec3 flashAt;
  float flashSeed;
  float bolt = flash(flashAt, flashSeed);
  flashAt.z += ro.z;
  vec3 flashColour = vec3(0.75, 0.82, 1.0) * bolt;

  // Below the horizon: haze thickening towards the ground; seen from above,
  // the distant land and sea under the clouds.
  vec3 sunGlow = sunLight(vec3(rd.x, max(rd.y, 0.0), rd.z), sun) * step(0.0, rd.y);
  vec3 sky = skyColour(vec3(rd.x, max(rd.y, 0.0), rd.z), sun) + sunGlow;
  if (rd.y < 0.0 && camY > 0.0) sky = mix(sky, mix(uHorizon * 0.6, vec3(0.1, 0.15, 0.22), 0.7), smoothstep(0.0, 0.2, -rd.y));
  sky += flashColour * 0.08;
  vec3 colour = sky;
  vec3 scattered = vec3(0.0);
  float alpha = 0.0;

  bool up = rd.y > 0.01 && camY < 3.0;
  bool down = rd.y < -0.01 && camY > 4.4;
  if ((up || down) && uShowClouds > 0.5) {
    // March through the cloud layer, 3 to 4.4 units up, no further than
    // the distance where it melts into haze.
    float t0 = ((up ? 3.0 : 4.4) - camY) / rd.y;
    float t1 = min(((up ? 4.4 : 3.0) - camY) / rd.y, t0 + 14.0);
    int steps = int(uSteps);
    float dt = (t1 - t0) / float(steps);
    // Interleaved gradient noise: an even, fine pattern that hides banding
    // without the visible grain of white noise.
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float march = t0 + dt * ign;
    float transmit = 1.0;
    // Forward scattering: clouds glow where you look towards the sun.
    float mu = dot(rd, sun);
    float phase = 0.8 * (1.0 - 0.36) / pow(1.0 + 0.36 - 1.2 * mu, 1.5) / 12.566 + 0.2 * 0.08;
    for (int i = 0; i < 64; i++) {
      if (i >= steps || transmit < 0.03 || march > t1) break;
      vec3 p = ro + rd * march;
      // Clear air: the coarse shape first, and a long stride if empty.
      // Erosion only carves, so where the shape is empty so is the cloud;
      // inside, the shape's noise is reused rather than sampled again.
      vec3 q;
      float shape = shapeAt(p, t, q);
      if (shape <= 0.0) {
        // The shape changes smoothly, so the further outside a cloud, the
        // further it is safe to stride before one can begin.
        march += dt * clamp(1.5 - shape * 10.0, 2.0, 4.0);
        continue;
      }
      float d = erode(shape, q, t);
      if (d > 0.01) {
        // Light reaching this point: one sample towards the sun.
        float toward = coarse(p + sun * 0.25, t) * 2.0;
        float beer = exp(-toward * 1.1);
        // Powder: thin edges are darker from inside, bright at their skin.
        float powder = 1.0 - exp(-d * 3.0);
        vec3 lit = light * beer * mix(1.0, powder, 0.5) * (phase * 12.0 + 1.9);
        // Skylight from above; the bases, facing the ground, are greyer.
        float hgt = clamp((p.y - 3.0) / 1.4, 0.0, 1.0);
        vec3 ambient = mix(vec3(0.32, 0.34, 0.4), mix(uHorizon, uSky, 0.4), hgt) * (0.35 + 0.5 * hgt);
        // Lightning lights the cloud from inside, falling off with distance.
        vec3 strike = bolt > 0.001 ? flashColour * 5.0 * exp(-length(p - flashAt) * 0.85) : vec3(0.0);
        float absorb = exp(-d * dt * 1.1);
        scattered += transmit * (lit + ambient + strike) * (1.0 - absorb);
        transmit *= absorb;
      }
      march += dt;
    }
    // Far clouds melt into the haze at the horizon.
    float fade = smoothstep(0.015, 0.2, abs(rd.y));
    transmit = mix(1.0, transmit, fade);
    scattered *= fade;
    colour = sky * transmit + scattered;
    alpha = 1.0 - transmit;
  }

  // The bolt itself, from the cloud base down to the ground, when the flash
  // is at its brightest. Drawn in screen space along a jagged path.
  vec3 boltLight = vec3(0.0);
  if (bolt > 0.2 && abs(uView - 1.0) > 0.5 && uShowBolt > 0.5) {
    vec3 rel = flashAt - ro;
    float z = rel.z;
    if (z > 0.5) {
      float topY = (3.0 - camY) / z - tilt;
      float bottomY = (0.0 - camY) / z - tilt;
      float k = (uv.y - bottomY) / (topY - bottomY);
      if (k > 0.0 && k < 1.0) {
        float x = rel.x / z;
        x += (noise1(k * 7.0 + flashSeed * 11.0) - 0.5) * 0.05 + (noise1(k * 29.0 + flashSeed) - 0.5) * 0.014;
        float w = abs(uv.x - x) * uResolution.y;
        float core = exp(-w * w * 0.35) + 0.25 * exp(-w * 0.12);
        boltLight = vec3(0.85, 0.9, 1.0) * core * min(bolt, 1.0) * 3.0 * smoothstep(1.0, 0.9, k);
      }
    }
  }
  colour += boltLight;

  if (uTransparent > 0.5) {
    // The clouds' own light, and the sun and bolts showing through, over
    // whatever the page is.
    vec3 through = sunGlow * (1.0 - alpha) + boltLight;
    float a = clamp(alpha + max(through.r, max(through.g, through.b)), 0.0, 1.0);
    vec3 c = linearToSrgb(1.0 - exp(-(scattered + through) / max(a, 1e-3) * 1.3));
    fragColor = vec4(c * a, a);
    return;
  }
  colour = 1.0 - exp(-colour * 1.3);
  colour = linearToSrgb(colour);
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(colour, 1.0);
}
`;

const VIEWS = { horizon: 0, overhead: 1, above: 2 };

/** @type {import('./runtime.js').EffectSpec<CloudsOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 0.75,
  time: 10,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowSun: o.showSun,
      uShowClouds: o.showClouds,
      uShowBolt: o.showBolt,
      uCover: o.cover,
      uDensity: o.density,
      uScale: o.scale,
      uSun: o.sun,
      uSteps: Math.round(12 + o.quality * 34),
      uSky: linear(o.sky),
      uHorizon: linear(o.horizon),
      uLight: linear(o.light),
      uInteractive: o.interactive,
      uTransparent: !o.showSky,
      uView: VIEWS[o.view] ?? 0,
      uLightning: o.lightning,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 2 });
    // Lightning keeps real time, so storms flash even when clouds drift slowly.
    let clock = 0;
    let storm = false;
    return {
      update: (o) => (storm = o.lightning > 0),
      frame(dt) {
        p.frame(dt);
        clock += dt;
        ctx.uniform('uClock', clock);
        if (storm) ctx.invalidate();
      },
      destroy: p.destroy,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<CloudsOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function clouds(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
