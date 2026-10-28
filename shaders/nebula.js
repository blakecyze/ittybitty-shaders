// @ts-check
/**
 * ittybitty/nebula
 *
 * A slow drift through a stellar nursery. Clouds of glowing gas are marched
 * front to back, so they both shine and hide what lies behind them, and
 * lanes of dust stand out dark against them. A handful of bright young stars
 * sit inside the clouds: they light the gas around them, glow through it and
 * wear the diffraction spikes of a space telescope, over a dense field of
 * pin-sharp stars.
 *
 * The gas is soft, so it is marched at a quarter of the resolution, half
 * its rows each frame in turn, and smoothed as it is scaled up; the stars
 * are drawn over it at full resolution, so they stay crisp.
 *
 * https://ittybitty.dev/shaders/nebula (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} NebulaOptions
 * @property {'hubble' | 'webb' | 'emission' | 'cosmic' | 'aurora' | 'custom'} palette The colours of the glowing gas, after a telescope's filters or your own pair.
 * @property {string} colorA Colour of the outer, cooler gas (Custom palette).
 * @property {string} colorB Colour of the hot gas near the stars (Custom palette).
 * @property {'pillars' | 'cliffs' | 'clouds'} form Towering pillars of dust, a ridge of cliffs, or open clouds.
 * @property {number} density How much gas fills the view.
 * @property {number} glow Brightness of the gas and stars.
 * @property {number} dust How many dark lanes of dust cut through the gas.
 * @property {number} turbulence How much the gas billows and folds.
 * @property {number} stars How many stars.
 * @property {boolean} spikes Diffraction spikes on the brightest stars.
 * @property {number} speed How fast you travel.
 * @property {'drift' | 'pan' | 'orbit'} camera Drift forwards into the gas, slide past it, or circle a cluster of stars.
 * @property {boolean} interactive The pointer steers the view.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {NebulaOptions} */
export const defaults = {
  palette: 'hubble',
  colorA: '#ff3d6e',
  colorB: '#3ad6ff',
  form: 'pillars',
  density: 0.45,
  glow: 1,
  dust: 0.4,
  turbulence: 0.7,
  stars: 0.6,
  spikes: true,
  speed: 0.4,
  camera: 'drift',
  interactive: true,
  responsiveness: 0.4,
};

// The gas: marched at low resolution by a pass of its own. Writes the light
// it gives off (squashed into 0..1, as c / (1 + c)) and, in alpha, how much
// of what lies behind still shows through. It is built for one form and one
// camera at a time (FORM and CAMERA, see volumeSource) rather than branching
// on them: a software renderer runs every branch whichever way it goes.
const VOLUME = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uColA;    // outer gas, linear
uniform vec3 uColB;    // hot gas near stars, linear
uniform vec3 uCore;    // star light, linear
uniform vec3 uDustCol; // lit dust, linear
uniform vec3 uTravel;  // how far the nebula has moved past (drift, pan)
uniform mat2 uTurn;    // how far it has turned (orbit)
uniform float uDensity;
uniform float uDust;
uniform float uWarp;
uniform vec2 uSteer;
uniform vec4 uLight[4];     // xyz: position in view space
uniform vec4 uLightCol[4];  // rgb: colour, black when out of play
uniform sampler3D uNoise;
uniform float uRow;    // which rows this draw marches: 0 even, 1 odd

out vec4 fragColor;

#define STEPS 32
const float FOCAL = 1.15;
// The nebula fills a deep slab in front of the camera, from NEAR to DEEP.
// The camera never enters it: its motion is the gas streaming through the
// slab instead, fading in at the back and dissolving as it comes close, so
// nothing ever smears across the lens.
const float NEAR = 5.0;
const float DEEP = 19.0;
const vec3 CENTRE = vec3(0.0, 0.0, 12.0);

// A hash without sine, stable across GPUs (after Dave Hoskins, MIT).
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// Turns each octave so the layers never line up with the noise's grid.
const mat3 TURN = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Four independent channels of smooth noise, tiling, from a small 3D
// texture: one read costs less than a single octave of noise in code.
vec4 nz(vec3 p) {
  return textureLod(uNoise, p, 0.0);
}

// How the nebula moves past the camera (see travel() below).
vec3 toNebula(vec3 p) {
#if CAMERA == 2
  vec3 c = p - CENTRE;
  c.xz = uTurn * c.xz;
  return c + CENTRE;
#else
  return p + uTravel;
#endif
}

vec4 broad(vec3 q) {
  return nz(q * 0.026 + vec3(0.31, 0.12, 0.73));
}
// Gas and dust. A broad layer decides where the clouds are at all, and its
// other channels bend the finer layers, so the gas billows and streams
// rather than sitting in blobs. Returns gas, dust (both about 0 to 1) and a
// coarse version of the gas, for the haze.
vec4 field(vec3 q, float octaves, vec4 b, float least) {
  float tt = uTime * 0.004;
  vec3 r = q * vec3(0.16, 0.115, 0.16) + (b.gba - 0.5) * uWarp * 0.3 + vec3(tt, 0.0, -tt);
  float gas = 0.0, dust = 0.0, coarse = 0.5, a = 0.5, used = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= octaves) break;
    vec4 n = nz(r);
    float w = clamp(octaves - float(i), 0.0, 1.0);
    gas += a * mix(0.5, n.r, w);
    dust += a * mix(0.5, 1.0 - abs(n.g * 2.0 - 1.0), w);
    used += a;
    a *= 0.5;
    if (i == 1) {
      coarse = gas / used;
      // Stop once the finer octaves could no longer lift it into anything
      // visible: most of a cloudy region is still empty.
      if (gas + (0.9375 - used) < least * 0.9375) break;
    }
    r = TURN * r * 2.07 + (n.ba - 0.5).xyx * uWarp * 0.06;
  }
  // Octaves left out stand in at their average.
  gas += (0.9375 - used) * 0.5;
  dust += (0.9375 - used) * 0.5;
  return vec4(gas / 0.9375, dust / 0.9375, coarse, 0.0);
}

// Light from the bright stars falling on a point, with a soft falloff so
// each sits in its own glowing bubble.
vec3 starlight(vec3 p) {
  vec3 l = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 d = p - uLight[k].xyz;
    l += uLightCol[k].xyz / (1.0 + dot(d, d) * 0.7);
  }
  return l;
}
float regionOf(float r) {
  return smoothstep(0.5, 0.74, r + (uDensity - 0.5) * 0.55);
}
float gasThreshold(float r) {
  return mix(0.7, 0.5, uDensity) + (1.0 - regionOf(r)) * 0.25;
}
float gasDensity(float x, float thr) {
  return smoothstep(thr - 0.2, thr + 0.45, x);
}
// One sample of the volume at a point p in view space: emitted colour per
// unit length, plus the gas, haze and dust, which the march turns into
// extinction.
vec3 sampleVolume(vec3 p, out float gas, out float haze, out float dust) {
  gas = 0.0;
  haze = 0.0;
  dust = 0.0;
  // In from the back of the slab, and dissolving as it nears the front.
  float fade = smoothstep(NEAR, NEAR + 3.0, p.z) * smoothstep(DEEP, DEEP - 4.0, p.z);
  vec3 q = toNebula(p);
  vec4 b = broad(q);
  // Circling, the clouds gather into one nebula round the centre, with
  // dark sky about it.
#if CAMERA == 2
  b.r *= smoothstep(8.0, 4.0, length(q - CENTRE) + (b.g - 0.5) * 6.0);
#endif
#if FORM == 2
  // The pillar standing in this cell of the floor, if any.
  vec2 cell = floor(q.xz / 6.0);
  vec3 hc = hash33(vec3(cell, 4.0));
  vec2 c = (cell + 0.5 + (hc.xy - 0.5) * 0.4) * 6.0;
  float top = -1.0 + hc.z * 3.0;
  vec2 off = q.xz - c - vec2(0.3, 0.12) * (q.y - top);
  float above = q.y - top;
#endif
  // Open space between the clouds costs one texture read. So does the
  // open sky well clear of a ridge or a pillar, but for its faint haze.
  if (regionOf(b.r) < 0.002) {
#if FORM == 0
    return vec3(0.0);
#else
#if FORM == 1
    float away = p.y - (-3.0 + 0.14 * p.z + 1.4 * (b.g - 0.5) * 2.0) - 1.3;
#else
    float radius = 0.7 + 0.1 * (top - q.y);
    float away = (above > 0.0 ? length(vec3(off, above * 1.2)) : length(off)) - radius - 0.9;
    away = hc.z < 0.25 ? 1.0 : away;
#endif
    if (away > 0.0) {
      haze = 0.025 * fade;
      return uColB * haze * 0.12;
    }
#endif
  }
  float thr = gasThreshold(b.r);
  vec4 f = field(q, mix(3.4, 2.2, smoothstep(7.0, DEEP, p.z)), b, thr - 0.25);
  gas = gasDensity(f.x, thr);
  // A thin glowing haze fills the cloudy regions around the denser clouds.
  haze = regionOf(b.r) * smoothstep(0.42, 0.78, f.z) * 0.25;
  // Dust lies in lanes through the clouds, never out in open space.
  dust = smoothstep(0.8 - uDust * 0.16, 0.95 - uDust * 0.12, f.y) * smoothstep(0.0, 0.3, uDust)
    * regionOf(b.r) * smoothstep(-0.25, 0.1, f.x - thr);
  float rim = 0.0;

  float lift = 0.0;
  float shade = 1.0;
#if FORM == 1
  {
    // Cliffs: a ragged ridge of dark, dusty gas across the lower view, its
    // crest burning where the starlight eats into it, hot gas above.
    float h = -3.0 + 0.14 * p.z + 1.4 * (b.g - 0.5) * 2.0 + 1.6 * (f.x - 0.5);
    float y = p.y - h;
    float below = smoothstep(0.25, -0.25, y);
    rim = exp(-abs(y - 0.1) * 5.0) * smoothstep(0.35, 0.65, f.x);
    dust = max(dust * 0.3, below * (0.3 + 0.6 * uDust) * smoothstep(0.3, 0.55, f.y));
    gas = mix(gas * 0.45, 0.35, below);
    haze = (haze + 0.025 * smoothstep(-1.0, 3.0, y)) * (1.0 - below);
    lift = 1.0 - below;
    shade = 1.0 - 0.85 * below;
  }
#elif FORM == 2
  {
    // Pillars: tall leaning columns of dust rising from below, with rounded
    // heads lit at the rim, standing in hot glowing gas.
    float radius = 0.7 + 0.1 * (top - q.y) + 0.9 * (f.x - 0.5);
    float sd = above > 0.0 ? length(vec3(off, above * 1.2)) - radius : length(off) - radius;
    float stand = step(0.3, hc.z);
    float pillar = smoothstep(0.15, -0.25, sd) * stand;
    rim = smoothstep(0.22, 0.0, abs(sd + 0.05)) * stand * smoothstep(-3.5, 0.3, above);
    dust = max(dust * 0.4, pillar * (1.0 + uDust));
    gas = max(gas * 0.15, pillar * 0.4);
    haze += 0.025 * (1.0 - pillar);
    lift = 0.6 * (1.0 - pillar) - 0.8 * pillar;
    shade = 1.0 - 0.5 * pillar;
  }
#endif
  // The brightest star has blown a cavity in the gas around itself; the
  // cavity's wall is where its light is caught.
  float toStar = length(p - uLight[0].xyz) + (f.x - 0.5) * 3.0;
  float wall = 0.0;
#if FORM == 0
  gas *= smoothstep(1.6, 3.2, toStar);
  haze *= smoothstep(0.5, 2.5, toStar);
  wall = exp(-(toStar - 3.0) * (toStar - 3.0) * 0.6);
  float solid = fade;
#else
  // Solid forms come right up to the front, so they never look like ghosts.
  float solid = smoothstep(NEAR, NEAR + 1.0, p.z) * smoothstep(DEEP, DEEP - 4.0, p.z);
#endif
  gas = mix(gas * fade, gas * solid, 1.0 - lift);
  haze *= fade;
  dust *= solid;
  rim *= solid;

  // Where the fine detail stands above the broad shape, the gas is a
  // knot or a crest catching the light; where it sinks below, a hollow in
  // shadow. Cheap, and it gives the clouds their texture.
  float facing = clamp(0.75 + (f.x - f.z) * 2.5, 0.15, 1.3);

  vec3 light = starlight(p);
  float lum = dot(light, vec3(0.3, 0.5, 0.2));
  // Gas near the hot stars is more ionised: it shifts towards the second
  // colour, as oxygen glows teal inside a shell of red hydrogen.
  float ion = smoothstep(0.45, 1.05, b.b * 0.8 + (f.x - 0.5) * 1.2 + 1.2 * lum + 0.4 * lift);
  vec3 gasCol = mix(uColA, uColB, ion);
  // Brightness varies hugely from place to place, as in real nebulae:
  // faint wisps, and knots that burn almost white.
  float hot = exp(6.0 * (b.r - 0.58));
  float glow = 0.16 + 0.8 * hot + 3.5 * lum + 1.2 * wall * length(uLightCol[0].xyz);
  // Clouds glow on the side facing the star and fall dark in their own
  // shadow.
  vec3 cloudCol = mix(gasCol * 0.12, gasCol, smoothstep(0.2, 0.8, facing)) * facing;
  vec3 emit = gas * shade * cloudCol * glow + haze * gasCol * glow * 0.5 + light * gas * facing * lum * 0.4;
  // Dust glows only where starlight catches its edges.
  emit += uDustCol * dust * facing * (0.02 + 0.4 * lum);
  // Rims of the ridge and the pillars burn where starlight eats into them.
  emit += mix(uColA, uCore, 0.3) * rim * (0.25 + 2.0 * lum + 0.3 * hot);
  return emit;
}

void main() {
  // The even and odd rows are drawn to textures of their own (see frame()).
  vec2 frag = vec2(gl_FragCoord.x, 2.0 * floor(gl_FragCoord.y) + uRow + 0.5);
  vec2 uv = (frag - 0.5 * uResolution) / uResolution.y;
  vec3 ro = vec3(uSteer * vec2(1.4, 0.9), 0.0);
  vec3 fwd = normalize(vec3(uSteer * vec2(0.3, 0.2), 1.0));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(fwd * FOCAL + right * uv.x + up * uv.y);

  // March the slab front to back in even steps. Each 2×2 block of pixels
  // starts at four different offsets, and the picture averages exactly such
  // blocks as it scales up, so together they march four times as finely and
  // no slices or pattern show. Dust dims blue light more than red, so the
  // edges of dark lanes redden.
  float t0 = (NEAR - ro.z) / rd.z;
  float t1 = (DEEP - ro.z) / rd.z;
  float dt = (t1 - t0) / float(STEPS);
  ivec2 cell = ivec2(frag) & 1;
  float jitter = (float(cell.x * 2 + (cell.x ^ cell.y)) + 0.5) * 0.25;
  float dist = t0 + dt * jitter;
  vec3 col = vec3(0.0);
  vec3 T = vec3(1.0);
  const vec3 REDDEN = vec3(0.8, 0.95, 1.1);
  for (int i = 0; i < STEPS; i++) {
    float gas, haze, dust;
    vec3 e = sampleVolume(ro + rd * dist, gas, haze, dust);
    vec3 sigma = gas * 0.8 + haze * 0.12 + dust * 4.0 * REDDEN + 1e-4;
    vec3 a = exp(-sigma * dt);
    // Exact integral of constant emission over the step under extinction.
    col += T * e * (1.0 - a) / sigma;
    T *= a;
    dist += dt;
    if (max(T.r, max(T.g, T.b)) < 0.03) break;
  }
  fragColor = vec4(col / (1.0 + col), dot(T, vec3(0.3, 0.4, 0.3)));
}
`;

// The march, its even and odd rows held apart, read back as one.
const ROWS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uEven, uOdd;
uniform vec2 uSize;    // the whole march
vec4 gas(int x, int y) {
  ivec2 c = clamp(ivec2(x, y), ivec2(0), ivec2(uSize) - 1);
  ivec2 r = ivec2(c.x, c.y >> 1);
  return (c.y & 1) == 0 ? texelFetch(uEven, r, 0) : texelFetch(uOdd, r, 0);
}
out vec4 o;
`;

// The march's 2x2 averages at its texel corners (clamped at the edges, as
// filtering clamps): one filtered tap of these is the average of four of
// the march, which the picture would otherwise take for every pixel.
const SMOOTH = /* glsl */ `${ROWS}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  o = 0.25 * (gas(c.x - 1, c.y - 1) + gas(c.x, c.y - 1) + gas(c.x - 1, c.y) + gas(c.x, c.y));
}`;

// How much of each bright star shows through the gas in front of it: one
// texel, rather than four taps of the gas for every pixel of the picture.
const THROUGH = /* glsl */ `${ROWS}
uniform vec4 uAt[2];   // where each star sits on the gas, 0..1 across
float through(vec2 at) {
  vec2 p = at * uSize - 0.5, f = fract(p);
  ivec2 i = ivec2(floor(p));
  float lo = mix(gas(i.x, i.y).a, gas(i.x + 1, i.y).a, f.x);
  float hi = mix(gas(i.x, i.y + 1).a, gas(i.x + 1, i.y + 1).a, f.x);
  return pow(mix(lo, hi, f.y), 0.6);
}
void main() {
  o = vec4(through(uAt[0].xy), through(uAt[0].zw), through(uAt[1].xy), through(uAt[1].zw));
}`;

// The picture: the gas scaled up and smoothed, the stars over it at full
// resolution, and the tone curve.
export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uStars;
uniform float uSpikes;
uniform float uGlow;
uniform vec2 uSteer;
uniform vec4 uStar[4];     // the bright stars: xy on screen, z spike length
uniform vec4 uStarCol[4];  // rgb: colour at full brightness, black when out of play
uniform float uStarCount;  // how many to draw: those after are all out of play
uniform vec4 uRayTurn[4];  // each star's rays turned its own way: cos 3k, sin 3k, cos k, sin k
uniform sampler2D uVolume;  // the gas, its 2x2 blocks averaged (see SMOOTH)
uniform sampler2D uThrough; // how much of each bright star shows through it
uniform float uVolumeReady;

out vec4 fragColor;

const float FOCAL = 1.15;

// Hashes without sine, stable across GPUs (after Dave Hoskins, MIT).
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
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// Stars on a cube of directions: crisp, round, and never clipped by their cell.
vec3 starfield(vec3 d) {
  vec3 a = abs(d);
  // Size of a pixel on the cube face, worked out rather than taken from
  // derivatives, which are unreliable after the march's early exit.
  float amax = max(a.x, max(a.y, a.z));
  float pixel = 1.0 / (uResolution.y * FOCAL * amax * amax);
  vec2 uv;
  float face;
  if (a.x > a.y && a.x > a.z) { uv = d.yz / a.x; face = sign(d.x); }
  else if (a.y > a.z) { uv = d.xz / a.y; face = 2.0 + sign(d.y); }
  else { uv = d.xy / a.z; face = 5.0 + sign(d.z); }
  vec3 col = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float n = 80.0 + float(i) * 110.0;
    vec2 g = uv * n;
    vec2 id = floor(g);
    vec3 h = hash32(id + face * 131.0 + float(i) * 57.0);
    float keep = step(h.z, uStars * uStars * (0.16 + float(i) * 0.12));
    vec2 f = g - id - (0.2 + 0.6 * h.xy);
    float px = n * pixel;
    float r = length(f) / px;
    float mag = pow(hash12(id + 7.7 + face), 50.0 + float(i) * 80.0);
    float size = 0.55 + 0.9 * mag;
    vec3 tint = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.82, 0.62), h.x);
    col += keep * tint * (0.015 + 0.06 * h.y * h.y + 5.0 * mag) * exp(-r * r / (size * size));
  }
  return col;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 filmic(vec3 x) {
  x += max(max(x.r, x.g), x.b) * 0.12 * smoothstep(0.6, 3.0, max(max(x.r, x.g), x.b));
  x = 1.0 - exp(-x * 1.2);
  return x * x * (3.0 - 2.0 * x) * 0.35 + x * 0.65;
}

// The gas at a point on screen, 0..1 across. The average of four filtered
// taps of the march, half a texel either way, so its four offsets blend into
// one smooth result and the scaling up softens; that is exactly one filtered
// tap of the march's 2x2 averages at its texel corners, which SMOOTH makes.
// Light in rgb, transmittance in alpha.
vec4 gasAt(vec2 at) {
  vec2 corners = vec2(textureSize(uVolume, 0));
  vec4 s = textureLod(uVolume, (at * (corners - 1.0) + 0.5) / corners, 0.0);
  s.rgb = s.rgb / max(1.0 - s.rgb, 1e-3);
  return s;
}

// The spikes' directions, as on Webb.
const vec2 SPIKE0 = vec2(cos(1.5708), sin(1.5708));
const vec2 SPIKE1 = vec2(cos(2.618), sin(2.618));
const vec2 SPIKE2 = vec2(cos(3.6652), sin(3.6652));
float spike(vec2 d, vec2 dir, float w, float len) {
  float along = abs(dot(d, dir));
  float across = abs(dot(d, vec2(-dir.y, dir.x)));
  float x = max(1.0 - along / len, 0.0);
  return exp(-across / w) * x * x * x;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec2 at = gl_FragCoord.xy / uResolution;
  vec3 ro = vec3(uSteer * vec2(1.4, 0.9), 0.0);
  vec3 fwd = normalize(vec3(uSteer * vec2(0.3, 0.2), 1.0));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(fwd * FOCAL + right * uv.x + up * uv.y);

  vec4 gas = uVolumeReady > 0.5 ? gasAt(at) : vec4(0.0, 0.0, 0.0, 1.0);
  vec3 col = gas.rgb;

  // Faint distant glow and the starfield, behind the gas.
  vec3 sky = starfield(rd);
  float far = dot(cos(rd * 3.1 + 1.0), sin(rd.yzx * 2.3));
  sky += mix(uColA, uColB, 0.5 + 0.5 * far) * 0.01 * (0.6 + 0.4 * far);
  col += gas.a * sky;

  // The bright stars themselves: a hot core, a halo, faint rays of light
  // through the gas, and six spikes plus two short ones, as on Webb. Each
  // shows through about as much gas as lies in front of it. Where each sits
  // on screen, and how bright, is worked out once a frame (see frame()).
  float pxUv = 1.0 / uResolution.y;
  vec4 through = uVolumeReady > 0.5 ? texelFetch(uThrough, ivec2(0), 0) : vec4(1.0);
  for (int k = 0; k < 4; k++) {
    if (float(k) >= uStarCount) break;
    vec2 d = uv - uStar[k].xy;
    float r2 = dot(d, d);
    float r = sqrt(r2);
    float core = exp(-r2 / (pxUv * pxUv * 5.0)) * 4.0;
    float halo = 0.00035 / (r2 + 0.00035) + 0.25 * exp(-r * 9.0);
    float rays = 0.0;
    float spikes = 0.0;
    float len = uStar[k].z;
    if (r < 0.7) {
      // Rays at angle a: sin(7a + k) sin(11a - 2k), which is
      // (cos(4a - 3k) - cos(18a - k)) / 2, from powers of the unit vector
      // towards the pixel rather than atan and sin.
      vec2 z = d / max(r, 1e-20);
      vec2 z2 = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
      vec2 z4 = vec2(z2.x * z2.x - z2.y * z2.y, 2.0 * z2.x * z2.y);
      vec2 z8 = vec2(z4.x * z4.x - z4.y * z4.y, 2.0 * z4.x * z4.y);
      vec2 z16 = vec2(z8.x * z8.x - z8.y * z8.y, 2.0 * z8.x * z8.y);
      vec2 z18 = vec2(z16.x * z2.x - z16.y * z2.y, z16.x * z2.y + z16.y * z2.x);
      vec4 turn = uRayTurn[k];
      rays = exp(-r * 4.0) * (0.5 + 0.25 * (dot(z4, turn.xy) - dot(z18, turn.zw))) * 0.05;
    }
    if (uSpikes > 0.5 && r < len) {
      float w = pxUv * 1.1;
      spikes = spike(d, SPIKE0, w, len) + spike(d, SPIKE1, w, len) + spike(d, SPIKE2, w, len);
      float x = max(1.0 - abs(d.x) / (len * 0.45), 0.0);
      spikes += 0.5 * exp(-abs(d.y) / w) * x * x * x;
    }
    col += through[k] * uStarCol[k].rgb * (core + halo + rays + spikes * 1.4);
  }

  col *= uGlow;
  // A touch more saturation before the curve, which mutes it a little.
  col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 1.3), 0.0);
  col = filmic(col);
  vec3 outc = linearToSrgb(col);
  float n = hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5;
  outc += n * (1.5 / 255.0);
  fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

const FORMS = { clouds: 0, cliffs: 1, pillars: 2 };
const CAMERAS = { drift: 0, pan: 1, orbit: 2 };

/** Outer gas, hot gas, starlight and lit dust, after each telescope's look. */
const PALETTES = {
  hubble: ['#ffa53a', '#1fc3c7', '#e6f6ff', '#8a4a1c'],
  webb: ['#ff7a2e', '#5aa0ff', '#fff2dc', '#b4622a'],
  emission: ['#ff2a4f', '#ff8fb0', '#ffe8f0', '#7a1f2a'],
  cosmic: ['#3653ff', '#9b6bff', '#dcefff', '#3a3f9a'],
  aurora: ['#15e08a', '#2bd6ff', '#eafff6', '#1d6a5a'],
};

/** @param {NebulaOptions} o */
function colours(o) {
  const pal = o.palette === 'custom' ? [o.colorA, o.colorB, '#f4f8ff', o.colorA] : (PALETTES[o.palette] ?? PALETTES.hubble);
  const dust = linear(pal[3]);
  return {
    uColA: linear(pal[0]),
    uColB: linear(pal[1]),
    uCore: linear(pal[2]),
    uDustCol: o.palette === 'custom' ? dust.map((c) => c * 0.4) : dust,
  };
}

/**
 * A number from 0 to 1 as an IEEE half float.
 * @param {number} v
 */
function half(v) {
  if (v < 6.2e-5) return 0;
  const e = Math.floor(Math.log2(v));
  const m = Math.round((v / 2 ** e - 1) * 1024);
  return ((e + 15) << 10) + m;
}

/**
 * Four channels of smooth, tiling value noise in a 64³ volume, eight cells
 * across, built once on the CPU. Lattice values are eased with a quintic,
 * so the texture's own linear filtering never shows a crease, and stored as
 * half floats, since 8 bits would show as terraces where the shader folds
 * the noise into ridges.
 * @returns {Uint16Array}
 */
function noiseVolume() {
  const N = 64;
  const C = 8;
  const S = N / C;
  let seed = 7;
  const lattice = new Float32Array(C * C * C * 4);
  for (let i = 0; i < lattice.length; i++) {
    seed = (seed * 16807) % 2147483647;
    lattice[i] = seed / 2147483647;
  }
  const ease = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    const t = i / S;
    ease[i] = t * t * t * (t * (t * 6 - 15) + 10);
  }
  const out = new Uint16Array(N * N * N * 4);
  /** @param {number} x @param {number} y @param {number} z @param {number} c */
  const at = (x, y, z, c) => lattice[(((z % C) * C + (y % C)) * C + (x % C)) * 4 + c];
  let o = 0;
  for (let z = 0; z < N; z++) {
    const z0 = (z / S) | 0, wz = ease[z % S];
    for (let y = 0; y < N; y++) {
      const y0 = (y / S) | 0, wy = ease[y % S];
      for (let x = 0; x < N; x++) {
        const x0 = (x / S) | 0, wx = ease[x % S];
        for (let c = 0; c < 4; c++) {
          const a = at(x0, y0, z0, c) + (at(x0 + 1, y0, z0, c) - at(x0, y0, z0, c)) * wx;
          const b = at(x0, y0 + 1, z0, c) + (at(x0 + 1, y0 + 1, z0, c) - at(x0, y0 + 1, z0, c)) * wx;
          const d = at(x0, y0, z0 + 1, c) + (at(x0 + 1, y0, z0 + 1, c) - at(x0, y0, z0 + 1, c)) * wx;
          const e = at(x0, y0 + 1, z0 + 1, c) + (at(x0 + 1, y0 + 1, z0 + 1, c) - at(x0, y0 + 1, z0 + 1, c)) * wx;
          const lo = a + (b - a) * wy;
          const hi = d + (e - d) * wy;
          out[o++] = half(lo + (hi - lo) * wz);
        }
      }
    }
  }
  return out;
}

/** @type {Uint16Array | null} */
let volume = null;
/** @type {Float32Array | null} */
let volumeFull = null;

/** An IEEE half float's value. @param {number} h */
const fromHalf = (h) => ((h & 1023) / 1024 + (h >> 10 ? 1 : 0)) * 2 ** (Math.max(h >> 10, 1) - 15);

/**
 * Whether the context renders in software (SwiftShader, llvmpipe). Those
 * filter full floats far faster than half floats, where a GPU filters half
 * floats at full rate and full floats at half.
 * @param {WebGL2RenderingContext} gl
 */
function software(gl) {
  let name = String(gl.getParameter(gl.RENDERER));
  if (name === 'WebKit WebGL') {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  }
  return /swiftshader|llvmpipe|softpipe|software/i.test(name);
}

// Where the bright stars sit, the same as the volume's slab and motion.
const NEAR = 5;
const DEEP = 19;
const SPAN = DEEP + 3 - NEAR;
const CENTRE_Z = 12;
// Fixed per star: across, up, along, tint, brightness.
const STARS = [
  [0.21, 0.63, 0.12, 0.3, 0.85],
  [0.78, 0.35, 0.57, 0.9, 0.4],
  [0.44, 0.82, 0.33, 0.1, 0.65],
  [0.63, 0.18, 0.86, 0.6, 0.95],
];
/** @param {number} a @param {number} b @param {number} x */
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** @param {number} x @param {number} m */
const wrap = (x, m) => ((x % m) + m) % m;

/**
 * The bright stars at effect time t, in view space, with their colours
 * (faded to black when out of play).
 * @param {NebulaOptions} o @param {[number, number, number]} core @param {number} t
 * @param {Float32Array} pos @param {Float32Array} col
 */
function brightStars(o, core, t, pos, col) {
  const mode = CAMERAS[o.camera] ?? 0;
  const count = o.stars * 4.5;
  for (let k = 0; k < 4; k++) {
    const [hx, hy, hz, ht, hb] = STARS[k];
    let x, y, z, f;
    if (mode === 0) {
      x = (hx - 0.5) * 9 - 1.2 * Math.sin(t * 0.031);
      y = (hy - 0.5) * 5 - 0.6 * Math.sin(t * 0.023);
      z = NEAR + wrap(hz * SPAN + k * SPAN * 0.25 - t * 0.5, SPAN);
      f = smooth(NEAR + 0.5, NEAR + 3, z) * smooth(NEAR + SPAN, NEAR + SPAN - 4, z);
    } else if (mode === 1) {
      x = wrap(hx * 28 + k * 7 - t * 0.45, 28) - 14;
      y = (hy - 0.5) * 5 - 0.3 * Math.sin(t * 0.03);
      z = 5 + hz * 9;
      f = smooth(14, 9, Math.abs(x));
    } else {
      // Orbit: a cluster round the centre the view circles, the first star
      // at its heart.
      const ang = hy * 6.2832;
      const r = k === 0 ? 0 : 1.8 + 2 * hz;
      const cx = Math.cos(ang) * r, cy = Math.sin(ang) * 0.6 * r, cz = Math.sin(ang * 1.7) * r;
      const a = t * 0.06, c = Math.cos(a), s = Math.sin(a);
      x = c * cx + s * cz;
      y = cy;
      z = CENTRE_Z - s * cx + c * cz;
      f = 1;
    }
    f *= k <= count ? 1 : 0;
    pos[k * 4] = x;
    pos[k * 4 + 1] = y;
    pos[k * 4 + 2] = z;
    const warm = ht > 0.75;
    const b = (0.6 + 0.8 * hb) * f;
    col[k * 4] = (warm ? 1 : core[0]) * b;
    col[k * 4 + 1] = (warm ? 0.78 : core[1]) * b;
    col[k * 4 + 2] = (warm ? 0.55 : core[2]) * b;
  }
}

const FOCAL = 1.15;
// Each bright star's rays turned its own way (see the picture's rays).
const RAY_TURN = new Float32Array([0, 1, 2, 3].flatMap((k) => [Math.cos(3 * k), Math.sin(3 * k), Math.cos(k), Math.sin(k)]));

/**
 * The bright stars as the picture draws them, once a frame rather than for
 * every pixel: where each sits on screen (xy, as the picture's uv) and its
 * spikes' length (z), and its colour at full brightness,
 * black when it is out of play or behind the view. Also where each sits on
 * the gas texture, 0..1 across, for how much of it shows through.
 * @param {Float32Array} steer @param {Float32Array} pos @param {Float32Array} col @param {number} aspect height / width
 * @param {Float32Array} at @param {Float32Array} tint @param {Float32Array} onGas
 */
function onScreen(steer, pos, col, aspect, at, tint, onGas) {
  // The view, as the shaders build it from the pointer.
  const ox = steer[0] * 1.4, oy = steer[1] * 0.9;
  let fx = steer[0] * 0.3, fy = steer[1] * 0.2, fz = 1;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  const rl = Math.hypot(fz, fx);
  const rx = fz / rl, rz = -fx / rl;
  const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;
  for (let k = 0; k < 4; k++) {
    const x = pos[k * 4] - ox, y = pos[k * 4 + 1] - oy, z = pos[k * 4 + 2];
    const bright = Math.hypot(col[k * 4], col[k * 4 + 1], col[k * 4 + 2]);
    const depth = x * fx + y * fy + z * fz;
    if (depth < 0.3 || bright < 0.001) {
      at[k * 4] = at[k * 4 + 1] = 1e4;
      at[k * 4 + 2] = 0;
      tint.fill(0, k * 4, k * 4 + 4);
      onGas[k * 2] = onGas[k * 2 + 1] = 0.5;
      continue;
    }
    const sx = ((x * rx + z * rz) / depth) * FOCAL, sy = ((x * ux + y * uy + z * uz) / depth) * FOCAL;
    const I = (bright * 1.4) / (0.6 + depth * 0.12);
    at[k * 4] = sx;
    at[k * 4 + 1] = sy;
    at[k * 4 + 2] = 0.06 + 0.1 * I;
    for (let c = 0; c < 3; c++) tint[k * 4 + c] = (col[k * 4 + c] / bright) * I;
    onGas[k * 2] = sx * aspect + 0.5;
    onGas[k * 2 + 1] = sy + 0.5;
  }
}

const VS = '#version 300 es\nvoid main(){vec2 p=vec2(gl_VertexID&1,gl_VertexID>>1)*4.0-1.0;gl_Position=vec4(p,0,1);}';

/** The gas pass for a form and a camera (indices into FORMS and CAMERAS). @param {number} form @param {number} camera */
const volumeSource = (form, camera) => `#version 300 es\n#define FORM ${form}\n#define CAMERA ${camera}\n${VOLUME}`;

/**
 * How far the nebula has moved past the camera at effect time t: an offset
 * (drift, pan) or a turn about the centre (orbit), as the gas pass's uTravel
 * and uTurn.
 * @param {number} camera @param {number} t @param {Float32Array} offset @param {Float32Array} turn
 */
function travel(camera, t, offset, turn) {
  if (camera === 0) {
    offset[0] = 1.2 * Math.sin(t * 0.031);
    offset[1] = 0.6 * Math.sin(t * 0.023);
    offset[2] = t * 0.5;
  } else {
    offset[0] = t * 0.45;
    offset[1] = 0.3 * Math.sin(t * 0.03);
    offset[2] = 0;
  }
  const a = t * 0.06;
  turn[0] = Math.cos(a);
  turn[1] = Math.sin(a);
  turn[2] = -Math.sin(a);
  turn[3] = Math.cos(a);
}

/** @type {import('./runtime.js').EffectSpec<NebulaOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    const { gl, canvas } = ctx;
    const p = pointer(ctx, { ease: 2 });
    const units = { noise: ctx.textureUnit(0), smooth: ctx.textureUnit(1), through: ctx.textureUnit(2), even: ctx.textureUnit(3), odd: ctx.textureUnit(4) };
    // The gas pass, built for each form and camera as it is first needed,
    // and the two small passes that ready it for the picture.
    /** @type {Record<string, WebGLProgram | null>} */
    let progs = {};
    /** @type {Record<string, Record<string, WebGLUniformLocation | null>>} */
    let locs = {};
    /** @type {WebGLTexture | null} */
    let noise = null;
    /** Render targets: the march, its corner averages, and the stars' share through it. */
    /** @type {Record<string, { t: WebGLTexture | null, f: WebGLFramebuffer | null }>} */
    let targets = {};
    let gw = 0, gh = 0;
    let format = 0;
    // Reuse: the frame the gas was last marched for, and which rows go next.
    let fresh = false;
    let marchedAt = 0;
    let row = 0;
    const marchedSteer = new Float32Array(2);
    const moved = new Float32Array(3);
    const turned = new Float32Array(4);
    // The pointer, eased here rather than in the shader, since both passes
    // need it.
    const steer = new Float32Array(2);
    const smoothed = [0.5, 0.5];
    let active = 0;
    const lightPos = new Float32Array(16);
    const lightCol = new Float32Array(16);
    // The bright stars as the picture draws them, and where they sit on the gas.
    const starAt = new Float32Array(16);
    const starCol = new Float32Array(16);
    const onGas = new Float32Array(8);
    /** @type {ReturnType<typeof colours> | null} */
    let tint = null;

    const L = (/** @type {string} */ key, /** @type {string} */ n) => (n in locs[key] ? locs[key][n] : (locs[key][n] = gl.getUniformLocation(/** @type {WebGLProgram} */ (progs[key]), n)));
    /** A program, built the first time it is asked for; null if it will not build. */
    const program = (/** @type {string} */ key, /** @type {() => string} */ source) => {
      if (!(key in progs)) {
        const sh = (/** @type {number} */ type, /** @type {string} */ src) => {
          const s = /** @type {WebGLShader} */ (gl.createShader(type));
          gl.shaderSource(s, src);
          gl.compileShader(s);
          return s;
        };
        const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, source());
        /** @type {WebGLProgram | null} */
        let made = gl.createProgram();
        gl.attachShader(made, v);
        gl.attachShader(made, f);
        gl.linkProgram(made);
        if (!gl.getProgramParameter(made, gl.LINK_STATUS)) {
          if (!gl.isContextLost()) console.warn(`nebula ${key}:`, gl.getShaderInfoLog(f));
          gl.deleteProgram(made);
          made = null;
        }
        gl.deleteShader(v);
        gl.deleteShader(f);
        progs[key] = made;
        locs[key] = {};
      }
      return progs[key];
    };
    const build = () => {
      progs = {};
      locs = {};
      targets = {};
      gw = gh = 0;
      fresh = false;
      // The corner averages and the stars' share in full floats where the
      // device renders and filters them, else half floats, else 8 bits.
      const renders = gl.getExtension('EXT_color_buffer_float');
      const full = renders && gl.getExtension('OES_texture_float_linear');
      format = full ? gl.RGBA32F : renders || gl.getExtension('EXT_color_buffer_half_float') ? gl.RGBA16F : gl.RGBA8;
      volume ??= noiseVolume();
      noise = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + units.noise);
      gl.bindTexture(gl.TEXTURE_3D, noise);
      if (software(gl) && gl.getExtension('OES_texture_float_linear')) {
        // The same half-float values, held as full floats for a software
        // renderer, which filters those far faster.
        volumeFull ??= Float32Array.from(volume, fromHalf);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, 64, 64, 64, 0, gl.RGBA, gl.FLOAT, volumeFull);
      } else gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 64, 64, 64, 0, gl.RGBA, gl.HALF_FLOAT, volume);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    };
    /** A filtered render target on a texture unit, replacing any of that name. */
    const target = (/** @type {string} */ name, /** @type {number} */ unit, /** @type {number} */ fmt, /** @type {number} */ w, /** @type {number} */ h) => {
      const old = targets[name];
      if (old) {
        gl.deleteTexture(old.t);
        gl.deleteFramebuffer(old.f);
      }
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      targets[name] = { t, f };
    };
    /** Draw a pass into a target. */
    const pass = (/** @type {string} */ name, /** @type {number} */ w, /** @type {number} */ h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[name].f);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    /** Point a pass at the march's rows. */
    const rowsOf = (/** @type {string} */ name, /** @type {number} */ w, /** @type {number} */ h) => {
      gl.uniform1i(L(name, 'uEven'), units.even);
      gl.uniform1i(L(name, 'uOdd'), units.odd);
      gl.uniform2f(L(name, 'uSize'), w, h);
    };
    build();

    return {
      update(o) {
        tint = colours(o);
        fresh = false;
      },
      frame(dt, time) {
        p.frame(dt);
        const o = /** @type {NebulaOptions} */ (ctx.options?.() ?? defaults);
        tint ??= colours(o);
        // The same easing as the pointer helper's, at this effect's rate.
        const r = o.responsiveness;
        const rate = r >= 0.999 ? 100 : Math.min(100, 2 * 2 ** ((r - 0.5) * 8));
        const k = 1 - Math.exp(-rate * dt);
        smoothed[0] += (p.target[0] - smoothed[0]) * k;
        smoothed[1] += (p.target[1] - smoothed[1]) * k;
        active += ((p.over ? 1 : 0) - active) * (1 - Math.exp(-4 * dt));
        const on = o.interactive ? active : 0;
        steer[0] = (smoothed[0] - 0.5) * on;
        steer[1] = (smoothed[1] - 0.5) * on;
        if (Math.abs(p.target[0] - smoothed[0]) + Math.abs(p.target[1] - smoothed[1]) + Math.abs((p.over ? 1 : 0) - active) > 1e-3) ctx.invalidate();
        brightStars(o, /** @type {[number, number, number]} */ (tint.uCore), time, lightPos, lightCol);
        const W = canvas.width, H = canvas.height;
        onScreen(steer, lightPos, lightCol, H / W, starAt, starCol, onGas);
        ctx.uniform('uSteer', steer);
        ctx.uniform('uStar', starAt);
        ctx.uniform('uStarCol', starCol);
        let count = 0;
        for (let i = 0; i < 4; i++) if (starCol[i * 4] + starCol[i * 4 + 1] + starCol[i * 4 + 2] > 0) count = i + 1;
        ctx.uniform('uStarCount', count);
        const form = FORMS[o.form] ?? 0, camera = CAMERAS[o.camera] ?? 0;
        const key = `volume${form}${camera}`;
        const smooth = program('smooth', () => SMOOTH), through = program('through', () => THROUGH);
        if (!program(key, () => volumeSource(form, camera)) || !smooth || !through) {
          ctx.uniform('uVolumeReady', 0);
          return;
        }

        // The gas pass, at a quarter of the canvas's resolution, its even
        // and odd rows drawn to textures of their own. While time runs on
        // smoothly they are marched by turns, each kept a frame for the
        // other: the gas drifts far less than a texel in that time, and the
        // picture blends every 2x2 block anyway, so it shows no seam, at
        // half the cost. After a jump, a resize, a change of options or a
        // sweep of the pointer, both are marched; when nothing moves, neither.
        const effect = gl.getParameter(gl.CURRENT_PROGRAM);
        const screen = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const w = Math.max(2, Math.ceil(W / 4)), h = Math.max(2, Math.ceil(H / 4));
        if (w !== gw || h !== gh) {
          target('even', units.even, gl.RGBA8, w, Math.ceil(h / 2));
          target('odd', units.odd, gl.RGBA8, w, Math.floor(h / 2));
          target('smooth', units.smooth, format, w + 1, h + 1);
          target('through', units.through, format, 1, 1);
          gw = w;
          gh = h;
          fresh = false;
        }
        const swept = Math.abs(steer[0] - marchedSteer[0]) + Math.abs(steer[1] - marchedSteer[1]) > 0.003;
        const step = time - marchedAt;
        const rows = !fresh || swept || !(step >= 0) || step > 0.1 ? 2 : step > 0 || steer[0] !== marchedSteer[0] || steer[1] !== marchedSteer[1] ? 1 : 0;
        fresh = true;
        marchedAt = time;
        marchedSteer.set(steer);
        if (rows > 0) {
          gl.useProgram(progs[key]);
          gl.uniform2f(L(key, 'uResolution'), w, h);
          gl.uniform1f(L(key, 'uTime'), time);
          gl.uniform3fv(L(key, 'uColA'), tint.uColA);
          gl.uniform3fv(L(key, 'uColB'), tint.uColB);
          gl.uniform3fv(L(key, 'uCore'), tint.uCore);
          gl.uniform3fv(L(key, 'uDustCol'), tint.uDustCol);
          travel(camera, time, moved, turned);
          gl.uniform3fv(L(key, 'uTravel'), moved);
          gl.uniformMatrix2fv(L(key, 'uTurn'), false, turned);
          gl.uniform1f(L(key, 'uDensity'), o.density);
          gl.uniform1f(L(key, 'uDust'), o.dust);
          gl.uniform1f(L(key, 'uWarp'), o.turbulence);
          gl.uniform2fv(L(key, 'uSteer'), steer);
          gl.uniform4fv(L(key, 'uLight'), lightPos);
          gl.uniform4fv(L(key, 'uLightCol'), lightCol);
          gl.uniform1i(L(key, 'uNoise'), units.noise);
          gl.activeTexture(gl.TEXTURE0 + units.noise);
          gl.bindTexture(gl.TEXTURE_3D, noise);
          for (let i = 0; i < rows; i++) {
            row = 1 - row;
            gl.uniform1f(L(key, 'uRow'), row);
            pass(row ? 'odd' : 'even', w, row ? Math.floor(h / 2) : Math.ceil(h / 2));
          }
          // Its corner averages, and the stars' share through it.
          gl.activeTexture(gl.TEXTURE0 + units.even);
          gl.bindTexture(gl.TEXTURE_2D, targets.even.t);
          gl.activeTexture(gl.TEXTURE0 + units.odd);
          gl.bindTexture(gl.TEXTURE_2D, targets.odd.t);
          gl.useProgram(smooth);
          rowsOf('smooth', w, h);
          pass('smooth', w + 1, h + 1);
          gl.useProgram(through);
          rowsOf('through', w, h);
          gl.uniform4fv(L('through', 'uAt'), onGas);
          pass('through', 1, 1);
        }
        // Back to the picture.
        gl.useProgram(effect);
        gl.bindFramebuffer(gl.FRAMEBUFFER, screen);
        gl.viewport(0, 0, W, H);
        gl.activeTexture(gl.TEXTURE0 + units.smooth);
        gl.bindTexture(gl.TEXTURE_2D, targets.smooth.t);
        gl.activeTexture(gl.TEXTURE0 + units.through);
        gl.bindTexture(gl.TEXTURE_2D, targets.through.t);
        gl.activeTexture(gl.TEXTURE0);
        ctx.sampler('uVolume', units.smooth);
        ctx.sampler('uThrough', units.through);
        ctx.uniform('uVolumeReady', 1);
      },
      restore() {
        build();
      },
      destroy() {
        p.destroy();
        for (const k in progs) if (progs[k]) gl.deleteProgram(progs[k]);
        for (const k in targets) {
          gl.deleteTexture(targets[k].t);
          gl.deleteFramebuffer(targets[k].f);
        }
        if (noise) gl.deleteTexture(noise);
        progs = {};
        targets = {};
      },
    };
  },
  // The stars want every pixel; the gas is marched at a quarter of this.
  dpr: 1,
  time: 20,
  speed: (o) => o.speed,
  update(o) {
    const c = colours(o);
    return {
      uRayTurn: RAY_TURN,
      uColA: c.uColA,
      uColB: c.uColB,
      uStars: o.stars,
      uSpikes: o.spikes,
      uGlow: o.glow,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<NebulaOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function nebula(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
