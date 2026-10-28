// @ts-check
/**
 * ittybitty/lagoon
 *
 * Stylised water in the manner of hand-painted adventure games: flat, bright
 * colour stepped into bands, crisp shapes instead of gradients, and light
 * treated as graphic marks. Two views.
 *
 * From above, the surface bends whatever lies beneath it: a sandy lagoon
 * floor with sandbars breaking the surface, an image, or the layers below.
 * Colour steps from turquoise shallows to deep blue with depth; caustics
 * trace bright lines with a rainbow rim; foam rolls in rings around the
 * sandbars; the sun glints off the waves as four-pointed stars. The pointer
 * stirs a small wave simulation (ripple.js): it drags a V-shaped wake, and
 * clicks send out rings. With the water's colour off it is clear water:
 * only refraction and light, over an image, the layers beneath or the page.
 *
 * At the horizon, open water under a painted sky: toon clouds with lit tops
 * and shaded bellies, a bank of cumulus on the horizon, far islands in the
 * haze, and a sea that steps from deep blue to sky reflection with angle,
 * carrying white wave lines and a path of sparkling stars.
 *
 * One pass, plus a small simulation step while the water is stirred.
 *
 * https://ittybitty.dev/shaders/lagoon (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';
import { ripple } from './ripple.js';

/**
 * @typedef {object} LagoonOptions
 * @property {boolean} showWater The lagoon floor and the colour of the water. Off, clear water: only its refraction and light, over an image, the layers beneath or the page.
 * @property {boolean} showFoam Foam around the sandbars and on the wave lines.
 * @property {boolean} showCaustics Sunlight focused into a bright web on the floor.
 * @property {boolean} showSparkles Star-shaped glints where the sun catches the waves.
 * @property {boolean} showClouds Clouds in the sky, at the horizon.
 * @property {boolean} showIslands Far islands on the horizon.
 * @property {'above' | 'horizon'} view Looking straight down, or out to the horizon.
 * @property {string} image Floor seen through the water from above. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead. Empty for a sandy lagoon.
 * @property {number} speed How fast the water moves.
 * @property {number} scale Size of the waves and everything on the floor.
 * @property {number} depth How deep the water is: how quickly the floor fades to blue.
 * @property {number} refraction How strongly the surface bends the floor.
 * @property {number} caustics Brightness of the caustic web.
 * @property {number} foam How much foam there is.
 * @property {number} sparkle How many glints, and how bright.
 * @property {string} shallow Colour of shallow water.
 * @property {string} deep Colour of deep water.
 * @property {string} sky Colour of the sky.
 * @property {boolean} interactive From above, the pointer drags a wake and clicks send out ripples. At the horizon, it turns your head.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {LagoonOptions} */
export const defaults = {
  showWater: true,
  showFoam: true,
  showCaustics: true,
  showSparkles: true,
  showClouds: true,
  showIslands: true,
  view: 'above',
  image: '',
  speed: 0.6,
  scale: 1,
  depth: 0.6,
  refraction: 0.6,
  caustics: 0.8,
  foam: 0.6,
  sparkle: 0.7,
  shallow: '#35e0cf',
  deep: '#1250b4',
  sky: '#5fb8ff',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uView;         // 0 above, 1 horizon
uniform float uScale;
uniform float uDepth;
uniform float uRefraction;
uniform float uCaustics;
uniform float uFoam;
uniform float uSparkle;
uniform vec3 uShallow;       // linear RGB
uniform vec3 uDeep;
uniform vec3 uSky;
uniform float uShowWater;
uniform float uShowFoam;
uniform float uShowCaustics;
uniform float uShowSparkles;
uniform float uShowClouds;
uniform float uShowIslands;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform sampler2D uRipple;   // the pointer's ripples: height, velocity, slope
uniform float uRippleReady;

out vec4 fragColor;

const float UNITS = 11.0;    // world units across the canvas height, from above
const vec3 SAND = vec3(0.8, 0.64, 0.4);
const vec3 WHITE = vec3(1.0, 0.99, 0.95);

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
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 5.1;
    a *= 0.5;
  }
  return v;
}

// Worley cells that drift over time. x: distance to the nearest point,
// y: gap to the second nearest (small along cell edges), zw: the cell id.
vec4 cells(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = 0.5 + 0.42 * sin(t + 6.2831 * hash22(i + g));
      float d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; id = i + g; } else if (d < d2) d2 = d;
    }
  }
  return vec4(d1, d2 - d1, id);
}

// Step a 0..1 value into n flat bands with antialiased edges.
float toon(float x, float n) {
  float y = x * n;
  float w = fwidth(y) * 0.8 + 0.02;
  return (floor(y) + smoothstep(0.5 - w, 0.5 + w, fract(y))) / n;
}

// A four-pointed star centred on q (in cell units), radius r.
float star(vec2 q, float r) {
  vec2 a = abs(q) / r;
  float core = max(0.0, 1.0 - length(q) / (r * 0.3));
  float rays = exp(-a.x * 12.0) * max(0.0, 1.0 - a.y) + exp(-a.y * 12.0) * max(0.0, 1.0 - a.x);
  return clamp(core * core * 1.5 + rays * rays, 0.0, 1.0);
}

// Wind ripples: twelve small waves fanned around one direction, each
// shorter and quicker than the last. Returns height and slope (x, z).
vec3 ripples(vec2 p, float t) {
  vec3 r = vec3(0.0);
  float len = 2.6;
  // A slow drift of the whole field, so the trains never lock into a grid.
  p += 0.6 * vec2(noise(p * 0.25 + t * 0.05), noise(p * 0.25 + 7.0 - t * 0.04)) - 0.3;
  for (int i = 0; i < 12; i++) {
    float a = 0.5 + (fract(float(i) * 0.618) - 0.5) * (1.4 + 0.3 * float(i));
    vec2 d = vec2(cos(a), sin(a));
    float k = 6.2831 / len;
    float ph = k * dot(d, p) - sqrt(9.8 * k) * 0.45 * t + float(i) * 1.7;
    r += len * 0.013 * vec3(sin(ph), k * cos(ph) * d);
    len *= 0.78 + 0.08 * fract(float(i) * 0.37);
  }
  return r;
}

vec3 surfaceNormal(vec2 p, float t, float strength) {
  vec3 s = ripples(p, t);
  return normalize(vec3(-s.y * strength, 1.0, -s.z * strength));
}

// Value noise and its slope, worked out exactly: one lookup gives both.
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i);
  float b = hash12(i + vec2(1, 0));
  float c = hash12(i + vec2(0, 1));
  float d = hash12(i + vec2(1, 1));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}

// The water at rest, from above: two layers of soft noise drifting across
// each other, as stylised water scrolls two normal maps. Returns the slope.
vec2 calm(vec2 p, float t) {
  vec2 a = noised(p * 0.9 + vec2(t * 0.22, t * 0.07)).yz * 0.9;
  vec2 b = noised(p * 1.7 - vec2(t * 0.1, -t * 0.2) + 4.0).yz * 0.85;
  return (a + b) * 0.12;
}

// The pointer's ripples at a pixel: height and slope from the simulation.
vec3 stirred(vec2 px) {
  if (uRippleReady < 0.5 || uInteractive < 0.5) return vec3(0.0);
  vec4 r = texture(uRipple, px / uResolution);
  return vec3(r.r, r.ba * 10.0);
}

// World position of a pixel, seen from above.
vec2 world(vec2 px) {
  return (px - 0.5 * uResolution) / uResolution.y * UNITS / uScale;
}

// How deep the lagoon floor lies at p: below 0 is a sandbar above water.
float bed(vec2 p) {
  return (fbm(p * 0.16 + vec2(3.1, 7.7)) - 0.34) * 2.6;
}

// The lagoon floor at depth d: rippled sand, and weed in the deeps.
vec3 seabed(vec2 p, float d) {
  vec3 c = SAND;
  // Ripples in the sand, bent by the currents.
  float r = sin(dot(p, vec2(0.35, 0.94)) * 7.0 + noise(p * 0.9) * 6.0);
  c *= 0.84 + 0.2 * smoothstep(-0.3, 0.7, r);
  // Darker sand and weed with depth.
  c = mix(c, vec3(0.62, 0.62, 0.42), smoothstep(0.3, 0.9, d) * 0.5);
  float weed = smoothstep(0.6, 0.72, noise(p * 0.9 + 11.0)) * smoothstep(0.35, 0.7, d);
  c = mix(c, vec3(0.2, 0.42, 0.22), weed * 0.8);
  return c;
}

// What lies beneath the water, from above: an image, or in a layer stack the
// layers below. Transparent when there is neither; the lagoon floor is then
// drawn by the effect itself.
// @source
vec4 source(vec2 px, float blur) {
  if (uImageReady < 0.5) return vec4(0.0);
  vec2 uv = px / uResolution;
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

// Caustics: the edges of drifting cells, thin bright lines where light
// gathers, as stylised water draws them. The same lines cut at three widths
// give a warm rim, a white core and a cool edge.
vec3 caustics(vec2 p, float t) {
  float e = cells(p, t * 0.8).y;
  return vec3(1.0 - smoothstep(0.0, 0.11, e), 1.0 - smoothstep(0.0, 0.085, e), 1.0 - smoothstep(0.0, 0.07, e));
}

const vec3 SUN_ABOVE = vec3(0.35, 1.0, 0.25);

// Sparkles: in a grid of cells, one star each where the sun catches the
// surface at the cell's own point, twinkling in and out.
float sparkle(vec2 px, float t, vec3 h) {
  vec2 grid = px / (uResolution.y * 0.045);
  vec2 cell = floor(grid);
  if (uShowSparkles < 0.5 || hash12(cell + 1.3) < 1.0 - uSparkle * 0.8) return 0.0;
  // Centred well inside the cell, so no star is cut off at its edge.
  vec2 at = 0.4 + 0.2 * hash22(cell);
  vec2 cpx = (cell + at) * uResolution.y * 0.045;
  vec2 cg = calm(world(cpx), t) + stirred(cpx).yz;
  float catchLight = smoothstep(0.6, 0.9, pow(max(dot(normalize(vec3(-cg.x, 1.0, -cg.y)), h), 0.0), 60.0));
  float twinkle = pow(max(0.0, sin(t * (2.0 + 3.0 * hash12(cell + 7.0)) + 6.28 * hash12(cell))), 3.0);
  return star(fract(grid) - at, 0.38 + 0.08 * hash12(cell + 4.0)) * catchLight * twinkle;
}

// From above. Returns colour and coverage: with the water's colour off and
// nothing beneath, only the light is drawn, over a transparent canvas.
vec4 above(vec2 px, float t) {
  vec2 p = world(px);
  vec3 sunDir = normalize(SUN_ABOVE);
  vec3 h = normalize(sunDir + vec3(0.0, 1.0, 0.0));
  vec3 rip = stirred(px);
  vec2 g = calm(p, t) + rip.yz;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

  // What lies beneath, seen through the tilted surface. An image or the
  // layers below bend each colour a little differently, so edges catch a
  // rainbow; the lagoon floor is drawn once.
  vec2 bend = -g * uRefraction * 0.05 * uResolution.y;
  vec4 under = source(px - bend, 0.0);
  bool beneath = under.a > 0.5;
  bool lagoon = !beneath && uShowWater > 0.5;
  vec2 pr = world(px - bend);
  float d = lagoon ? bed(pr) : 0.7;
  vec3 floorColour = vec3(0.0);
  if (beneath) floorColour = srgbToLinear(vec3(source(px - bend * 0.9, 0.0).r, under.g, source(px - bend * 1.12, 0.0).b));
  else if (lagoon) floorColour = seabed(pr, d);
  float water = lagoon ? max(d, 0.0) * uDepth * 1.9 : uDepth * 0.3;

  // Sandbars above the water: dry sand, darker where the waves wet it, and
  // a line of surf that laps up the beach and back.
  if (lagoon && d < 0.0) {
    vec3 c = floorColour * mix(1.0, 0.72, smoothstep(-0.14, 0.0, d + 0.02 * sin(t * 1.5 + p.x)));
    float lap = -0.06 - 0.05 * (0.5 + 0.5 * sin(t * 1.3 + dot(p, vec2(0.4, 0.3))));
    float surf = smoothstep(lap - 0.012, lap, d) * smoothstep(lap + 0.035, lap + 0.02, d) * uShowFoam;
    return vec4(mix(c, WHITE, surf * 0.95), 1.0);
  }

  // Light: caustics on the floor, bent by the surface; crisp highlights
  // where it tilts towards the sun; star glints.
  float clear = exp(-water * 2.0);
  vec3 web = caustics(p * 0.8 + g * 2.5, t) * uCaustics * uShowCaustics * mix(0.3, 1.0, clear) * 0.8;
  float glare = smoothstep(0.85, 0.9, pow(max(dot(n, h), 0.0), 240.0)) * 0.4;
  float glint = sparkle(px, t, h) * 1.8;
  // The pointer's ripples show as real ones do: through the refraction and
  // highlights above, plus a faint light and shade on their slopes.
  float lit = clamp(dot(rip.yz, vec2(-0.6, -0.8)) * 1.5, -1.0, 1.0);

  if (uShowWater < 0.5) {
    if (beneath) {
      // Clear water over an image or the layers below.
      vec3 c = (floorColour + web * 0.6) * (1.0 + 0.16 * lit);
      return vec4(c + WHITE * (glare + glint), 1.0);
    }
    // Nothing beneath: only the light, over the page. Troughs shade it a touch.
    vec3 light = web + WHITE * (glare + glint + max(lit, 0.0) * 0.12);
    float a = clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0);
    return vec4(light / max(a, 1e-3), max(a, max(-lit, 0.0) * 0.08));
  }

  // How much of the floor's light makes it back up, stepped into shelves:
  // clear over the sand, turquoise, then deep blue.
  float k = mix(1.0 - clear, 1.0 - toon(clamp(clear, 0.001, 1.0), 4.0), 0.7);
  vec3 hue = uShallow / max(max(uShallow.r, max(uShallow.g, uShallow.b)), 1e-3);
  vec3 through = (floorColour + web) * mix(vec3(1.0), hue, 0.3 + 0.7 * smoothstep(0.0, 0.5, k));
  vec3 body = mix(uShallow, uDeep, smoothstep(0.25, 1.0, k));
  vec3 c = mix(through, body, 0.05 + 0.6 * k * k + 0.2 * k) * (1.0 + 0.16 * lit) + WHITE * glare;

  // Foam: noise cut off lower towards the sandbars, so it thickens there,
  // plus rings that roll in over the shallows.
  if (lagoon) {
    float edge = 1.0 - smoothstep(0.0, 0.3, water);
    float cut = mix(0.85, 0.5, edge * uFoam);
    float froth = smoothstep(cut, cut + 0.02, noise(p * 2.6 + g * 4.0 + vec2(t * 0.2, -t * 0.12)));
    float ring = abs(fract(water * 8.0 - t * 0.35) - 0.5);
    float rings = smoothstep(0.12, 0.08, ring) * smoothstep(0.3, 0.12, water);
    c = mix(c, WHITE, clamp((froth * edge + rings) * min(uFoam * 1.6, 1.0), 0.0, 1.0) * uShowFoam * 0.95);
  }
  return vec4(c + WHITE * glint, 1.0);
}

// ---- The horizon view -----------------------------------------------------

const vec3 SUN_HORIZON = vec3(0.35, 0.16, 1.0);

// The painted sky: a band of light at the horizon, a sun with soft rings.
vec3 skyBase(vec3 d) {
  vec3 s = normalize(SUN_HORIZON);
  vec3 low = mix(uSky, WHITE, 0.45);
  vec3 c = mix(low, uSky * 0.78, toon(smoothstep(0.0, 0.55, d.y), 6.0));
  float mu = dot(d, s);
  c += WHITE * 0.25 * smoothstep(0.97, 0.995, mu);
  c += WHITE * 0.2 * smoothstep(0.992, 0.996, mu);
  c = mix(c, WHITE * 1.1, smoothstep(0.9988, 0.9991, mu));
  return c;
}

// Toon clouds on a flat layer: crisp edges, lit tops towards the sun,
// shaded bellies, a bright rim. Plus a bank of cumulus on the horizon.
vec4 cloudsAt(vec3 d, float t) {
  if (uShowClouds < 0.5 || d.y <= 0.0) return vec4(0.0);
  vec3 s = normalize(SUN_HORIZON);
  vec3 lit = WHITE;
  vec3 shade = mix(uSky, vec3(0.75, 0.8, 0.95), 0.55);
  // Layer overhead.
  vec2 p = d.xz / (d.y + 0.05) * 0.6 + vec2(t * 0.01, 0.0);
  float den = fbm(p);
  float body = smoothstep(0.56, 0.575, den);
  float top = smoothstep(0.02, 0.0, fbm(p + s.xz * 0.08) - den);
  vec3 c = mix(shade, lit, top);
  float a = body * smoothstep(0.02, 0.12, d.y);
  // The horizon bank: a bumpy silhouette of rounded tops.
  float az = atan(d.x, d.z);
  float rim = 0.05 + 0.06 * fbm(vec2(az * 5.0, 1.0)) + 0.035 * abs(sin(az * 23.0 + fbm(vec2(az * 9.0, 4.0)) * 5.0));
  float bank = smoothstep(rim + 0.002, rim - 0.002, d.y);
  float bankLit = smoothstep(rim - 0.05, rim - 0.02, d.y);
  vec3 bc = mix(shade, lit, max(bankLit, 0.25 + 0.5 * smoothstep(0.0, 1.0, dot(normalize(d.xz), normalize(s.xz)))));
  c = mix(c, bc, bank);
  return vec4(c, max(a, bank * 0.97));
}

// Far islands: toon hills in the haze, lit on the sun's side.
vec4 islandsAt(vec3 d) {
  if (uShowIslands < 0.5 || d.y < -0.01) return vec4(0.0);
  float az = atan(d.x, d.z);
  float ridge = max(0.0, fbm(vec2(az * 3.0 + 1.7, 0.5)) - 0.5) * 0.16;
  ridge += max(0.0, fbm(vec2(az * 9.0, 3.0)) - 0.55) * 0.03 * step(0.001, ridge);
  if (d.y > ridge) return vec4(0.0);
  float slope = fbm(vec2(az * 3.0 + 1.72, 0.5)) - fbm(vec2(az * 3.0 + 1.68, 0.5));
  vec3 haze = mix(uSky, WHITE, 0.55);
  vec3 hill = mix(uDeep, vec3(0.25, 0.55, 0.45), 0.5);
  vec3 c = mix(hill, haze, 0.55) * (slope > 0.0 ? 1.12 : 0.9);
  return vec4(c, 1.0);
}

vec3 skyAll(vec3 d, float t) {
  vec3 c = skyBase(d);
  vec4 cl = cloudsAt(d, t);
  c = mix(c, cl.rgb, cl.a);
  vec4 il = islandsAt(d);
  return mix(c, il.rgb, il.a);
}

vec3 horizon(vec2 px, float t) {
  vec2 uv = (px - 0.5 * uResolution) / uResolution.y;
  vec2 look = (uPointer - 0.5) * uPointerActive * uInteractive;
  vec3 rd = normalize(vec3(uv.x, uv.y - 0.12 + look.y * 0.2, 1.4));
  float yaw = look.x * 0.5;
  rd.xz = mat2(cos(yaw), -sin(yaw), sin(yaw), cos(yaw)) * rd.xz;
  vec3 s = normalize(SUN_HORIZON);

  if (rd.y >= 0.0) return skyAll(rd, t);

  // The sea: a flat plane shaded by the rolling surface.
  vec3 ro = vec3(0.0, 2.0, t * 0.8);
  float dist = ro.y / -rd.y;
  vec2 p = ro.xz + rd.xz * dist;
  vec2 sp = p * 0.55 / uScale;
  float far = smoothstep(8.0, 70.0, dist);
  vec3 n = surfaceNormal(sp, t, mix(0.4, 0.1, far));

  // Colour by angle: looking down, deep blue lit turquoise on wave faces;
  // towards the horizon, the sky. Stepped, not blended.
  // Reflections follow a calmer surface than the shading does, so the sky
  // lies on the water in broad sheets instead of rings.
  vec3 calm = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.7));
  float facing = max(dot(calm, -rd), 0.0);
  float fres = mix(pow(1.0 - facing, 5.0), toon(pow(1.0 - facing, 5.0), 3.0), 0.5);
  float litFace = toon(clamp((dot(n, normalize(vec3(s.x, 0.6, s.z))) - 0.55) * 3.0, 0.0, 0.999), 2.0);
  vec3 body = mix(uDeep, uShallow, litFace * 0.75);
  vec3 r = reflect(rd, calm);
  r.y = abs(r.y);
  vec3 c = mix(body, skyAll(r, t) * 0.95, fres);

  // Wave lines: white crests drawn as thin strokes, thinning with distance.
  vec2 lp = sp * vec2(1.0, 1.8);
  float wave = noise(lp * 1.2 + vec2(t * 0.25, 0.0) + n.xz);
  float lineCut = mix(0.8, 0.9, far) - uFoam * 0.08;
  float fw = fwidth(wave);
  float crest = smoothstep(lineCut - fw, lineCut, wave) * smoothstep(lineCut + 0.035 + fw, lineCut + 0.035, wave);
  crest *= 1.0 - smoothstep(0.1, 0.9, far);
  c = mix(c, WHITE, crest * uShowFoam * 0.9);

  // The sun's path: crisp highlights and, in the path, twinkling stars.
  vec3 glossy = reflect(rd, normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.35)));
  float spec = pow(max(dot(glossy, s), 0.0), 400.0);
  c += WHITE * smoothstep(0.3, 0.36, spec) * 0.85;
  vec2 g = px / (uResolution.y * 0.03);
  vec2 cell = floor(g);
  vec2 at = hash22(cell);
  vec2 q = fract(g) - at;
  float path = exp(-pow(atan(rd.x, rd.z) - atan(s.x, s.z), 2.0) * 40.0 / (0.3 + 3.0 * far));
  float twinkle = max(0.0, sin(t * (3.0 + 3.0 * hash12(cell + 7.0)) + 6.28 * hash12(cell)));
  float glint = star(q, 0.5) * path * twinkle * step(1.0 - uSparkle * 0.6, hash12(cell + 1.3));
  c += WHITE * glint * uShowSparkles * 1.6;

  // Haze towards the horizon.
  vec3 haze = mix(uSky, WHITE, 0.62);
  return mix(c, haze, smoothstep(30.0, 160.0, dist) * 0.85);
}

void main() {
  float t = uTime;
  vec4 o = uView < 0.5 ? above(gl_FragCoord.xy, t) : vec4(horizon(gl_FragCoord.xy, t), 1.0);
  // A painter's palette: a touch more saturated than life.
  vec3 c = max(mix(vec3(dot(o.rgb, vec3(0.2126, 0.7152, 0.0722))), o.rgb, 1.2), 0.0);
  c = linearToSrgb(clamp(c, 0.0, 1.2));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(clamp(c, 0.0, 1.0) * o.a, o.a);
}
`;

const VIEWS = { above: 0, horizon: 1 };

/** @type {import('./runtime.js').EffectSpec<LagoonOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 12,
  speed: (o) => o.speed,
  update(o) {
    return {
      uView: VIEWS[o.view] ?? 0,
      uScale: o.scale,
      uDepth: o.depth,
      uRefraction: o.refraction,
      uCaustics: o.caustics,
      uFoam: o.foam,
      uSparkle: o.sparkle,
      uShallow: linear(o.shallow),
      uDeep: linear(o.deep),
      uSky: linear(o.sky),
      uShowWater: o.showWater,
      uShowFoam: o.showFoam,
      uShowCaustics: o.showCaustics,
      uShowSparkles: o.showSparkles,
      uShowClouds: o.showClouds,
      uShowIslands: o.showIslands,
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const water = ripple(ctx, 'uRipple', 1);
    const p = pointer(ctx, { ease: 3 });
    const last = [0, 0];
    let tracking = false;
    const stirs = () => {
      const o = ctx.options?.();
      return Boolean(o?.interactive) && o?.view !== 'horizon';
    };
    const down = () => {
      if (p.over && stirs()) water.drop(p.target[0], p.target[1], 1);
    };
    addEventListener('pointerdown', down, { passive: true });
    return {
      update: (o) => image.set(o.image),
      frame(dt) {
        p.frame(dt);
        // Press the water along the path the pointer took since last frame,
        // harder the faster it moves.
        const [x, y] = p.target;
        if (p.over && stirs()) {
          if (tracking) {
            const aspect = ctx.canvas.clientWidth / Math.max(ctx.canvas.clientHeight, 1);
            const speed = Math.hypot(p.velocity[0] * aspect, p.velocity[1]);
            if (speed > 0.02) water.stroke(last[0], last[1], x, y, Math.min(1, speed * 0.6), 0.008);
          }
          tracking = true;
        } else {
          tracking = false;
        }
        last[0] = x;
        last[1] = y;
        water.frame(dt);
      },
      restore() {
        image.restore();
        water.restore();
      },
      destroy() {
        removeEventListener('pointerdown', down);
        image.destroy();
        water.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<LagoonOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function lagoon(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
