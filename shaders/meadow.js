// @ts-check
/**
 * ittybitty/meadow
 *
 * Short grass running out to a hazy horizon, dotted with dandelions, yellow
 * in bloom or gone to white seed clocks, swaying slowly in the wind. The
 * scene is drawn plainly and cheaply; the grade does the rest, from a
 * washed-out black and white with film grain to a saturated summer field.
 *
 * https://ittybitty.dev/shaders/meadow (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} MeadowOptions
 * @property {boolean} showFlowers The dandelions. Off, plain grass.
 * @property {boolean} showFilm The film look: grain, digital noise and faded blacks. Off, the picture is clean.
 * @property {'fog' | 'day' | 'blue' | 'golden' | 'night'} sky Grey fog, a sunny day, a pale blue sky, golden hour, or night.
 * @property {number} speed How fast the grass sways.
 * @property {number} sway Which way the wind leans the grass, and how far: left, still, or right.
 * @property {number} gusts From a steady breeze to gusts rolling across the field, the blades trembling more as it rises.
 * @property {number} zoom Zoom out to see more of the field, or in for a closer look.
 * @property {number} height How tall the grass stands.
 * @property {number} density How thickly the grass grows.
 * @property {number} flowers How many dandelions there are.
 * @property {number} clocks How many have gone to seed, from all yellow to all white.
 * @property {number} exposure Darker or brighter overall.
 * @property {number} saturation From black and white to vivid colour.
 * @property {string} tint Colour washed through the image. Neutral grey leaves it untouched.
 * @property {number} matte Lifts the blacks to a washed-out grey and softens the contrast, like faded film.
 * @property {number} grain Film grain, with the corners darkening as it rises.
 * @property {number} noise Coloured digital noise, like a dark phone video.
 * @property {string} grass Colour of the grass.
 * @property {boolean} interactive The grass parts around the pointer, like a hand brushed through it.
 */

/** @type {MeadowOptions} */
export const defaults = {
  showFlowers: true,
  showFilm: true,
  sky: 'fog',
  speed: 0.35,
  sway: 0.45,
  gusts: 0.7,
  zoom: 0.75,
  height: 0.3,
  density: 0.7,
  flowers: 0.55,
  clocks: 0.7,
  exposure: -0.3,
  saturation: 0.25,
  tint: '#8c9aa6',
  matte: 0.2,
  grain: 0.5,
  noise: 0.1,
  grass: '#4f6b2c',
  interactive: true,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uSpeed;
uniform float uSway;
uniform float uZoom;
uniform float uDirection;
uniform float uGusts;
uniform float uFlutter;
uniform float uInteractive;
uniform vec2 uPointer;
uniform vec2 uPointerFlow;
uniform float uPointerActive;
uniform float uHeight;
uniform float uDensity;
uniform float uFlowers;
uniform float uClocks;
uniform float uHorizon;
uniform float uSlope;
uniform float uFog;
uniform float uExposure;
uniform float uSaturation;
uniform vec3 uTint;       // display (sRGB) values, applied after tone mapping
uniform float uToning;
uniform float uContrast;
uniform float uFade;
uniform float uGrain;
uniform float uNoise;
uniform float uVignette;
uniform vec3 uGrass;      // linear RGB
uniform vec3 uBloom;
uniform vec3 uSkyTop;
uniform vec3 uSkyLow;
uniform vec3 uLight;      // light falling on the field from above
uniform vec3 uAmbient;    // light from the sky all round
uniform float uStars;

out vec4 fragColor;

const float CAM = 0.6;    // eye height: how far below the horizon ground at depth 1 sits
const float RATIO = 1.07; // depth from one row of grass to the next

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

// How far the grass lays over at a point of the field: soft gust fronts
// rolling diagonally across it, 0 calm to 1 a full gust.
float gust(vec2 w, float t) {
  float g = noise(w * vec2(0.35, 0.25) - vec2(t * 0.5, t * 0.22)) * 0.7;
  g += noise(w * vec2(1.1, 0.8) - vec2(t * 1.1, t * 0.4)) * 0.3;
  return smoothstep(0.2, 0.85, g);
}

// The pointer's push on grass at a point of the field (world across,
// depth): away from the hand on either side, and along with a swipe. The
// push grows from nothing at the hand, peaks a little way out and fades
// smoothly, so there is no edge to it.
float brush(vec2 at, vec2 hand, float swipe) {
  vec2 away = at - hand;
  float near = exp(-dot(away, away) / 0.03);
  return (away.x * 11.0 + swipe) * near;
}

// Fine detail fades out once a feature is narrower than a few pixels.
float detailOf(float size, float pixel) {
  return smoothstep(1.0, 3.0, size / pixel);
}

float grainAt(vec2 p, float frame) {
  return hash12(p + frame * 17.31) + hash12(p * 1.37 + frame * 3.1) - 1.0;
}

vec3 chromaAt(vec2 p, float frame) {
  return vec3(hash12(p + frame * 5.7), hash12(p + frame * 9.1 + 3.0), hash12(p + frame * 2.3 + 7.0)) - 0.5;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  float px = 1.0 / uResolution.y;          // one pixel, in screen units
  float t = uTime * uSpeed;
  float yy = p.y - uSlope * p.x;           // sheared, so the horizon tilts
  float h = uHorizon - yy;                 // how far below the horizon

  // Sky: the horizon colour fading up into the top, with slow drifting murk.
  // Below the horizon it shows only in the soft line where field meets fog.
  vec3 skyCol = vec3(0.0);
  if (h < 0.012) {
    skyCol = mix(uSkyLow, uSkyTop, smoothstep(uHorizon - 0.05, 1.05, yy));
    skyCol *= 0.92 + 0.16 * noise(vec2(p.x * 1.5 + uTime * 0.01, yy * 4.0));
    vec2 star = floor(gl_FragCoord.xy / (2.0 * uPixelRatio));
    skyCol += uStars * step(0.997, hash12(star)) * hash12(star + 7.0) * smoothstep(uHorizon, uHorizon + 0.3, yy);
    // A bank of fog sits on the horizon.
    skyCol = mix(skyCol, uSkyLow, uFog * exp(-max(-h, 0.0) * 9.0));
  }

  vec3 colour = skyCol;
  if (h > 0.0) {
    // World sizes are in zoomed units: zooming out shrinks the grass and
    // flowers against the same horizon.
    float L = CAM * mix(0.12, 0.42, uHeight);   // grass height
    float LF = L * 1.5;                         // dandelions can stand above it
    float lnR = log(RATIO);
    // Rows of grass whose roots are below this pixel, and whose tips (or
    // flowers) reach it. Each row is 7% further away than the one before;
    // the count in range is the same at every depth.
    float iHi = floor(log(CAM / h) / lnR);
    float reach = uFlowers > 0.0 ? LF : L * 1.1;   // without flowers, nothing stands above the grass
    float iLo = ceil(log(max(CAM - reach * uZoom, CAM * 0.2) / h) / lnR);
    float spacingW = mix(0.016, 0.0035, uDensity);
    // How far a blade's tip may stray from the wind's lean on its own: tied
    // to the spacing, so the search for blades stays small at any density.
    float own = min(0.6 * spacingW, 0.25 * L);
    float dirS = uDirection < 0.0 ? -1.0 : 1.0;

    // The pointer, as a place in the field at mid-blade height.
    vec2 hp = vec2((uPointer.x - 0.5) * aspect, uPointer.y);
    float hh = uHorizon - (hp.y - uSlope * hp.x);
    float hd = (CAM - 0.5 * L * uZoom) / max(hh, 0.02);
    vec2 hand = vec2(hp.x * hd, hd) / uZoom;
    float touch = uInteractive * uPointerActive * step(0.0, hh);
    float swipe = clamp(uPointerFlow.x * aspect * 0.35, -1.0, 1.0);
    float fw = 0.22;                            // one dandelion per cell, at most
    vec3 lit = uAmbient + uLight;

    vec3 acc = vec3(0.0);
    float through = 1.0;
    for (int n = 0; n < 16; n++) {
      float i = iLo + float(n);
      // One row beyond: its blades' roots may sit just below this pixel.
      if (i > iHi + 1.0 || through < 0.02) break;
      float d = pow(RATIO, i);
      float s = 1.0 / d;
      float sz = s * uZoom;                     // screen units per world unit here
      float ground = uHorizon - CAM * s;
      // Blades are drawn while wide enough to see; beyond that the ground
      // underneath stands in for them. A row with neither blades nor
      // flowers reaching this pixel is skipped before anything else of it.
      float lod = smoothstep(1.0, 3.0, spacingW * sz / px);
      bool bladesHere = lod > 0.0 && yy < ground + L * 1.1 * sz;
      bool flowersHere = uFlowers > 0.0 && yy < ground + LF * 1.3 * sz;
      if (!bladesHere && !flowersHere) continue;
      float xw = p.x / sz;                      // world position across
      // Each flower cell's roll of the dice comes first: the drift noise,
      // and the wind, are paid for only if a flower could stand here.
      float fid0 = floor(xw / fw);
      vec3 roll = vec3(1.0);
      float most = 0.0;
      if (flowersHere) {
        roll = vec3(hash11((fid0 - 1.0 + i * 71.3) * 3.17 + 0.5), hash11((fid0 + i * 71.3) * 3.17 + 0.5), hash11((fid0 + 1.0 + i * 71.3) * 3.17 + 0.5));
        most = uFlowers * clamp(0.12 * d, 0.0, 0.9) * 1.6;
        flowersHere = min(roll.x, min(roll.y, roll.z)) <= most;
      }
      if (!bladesHere && !flowersHere) continue;
      float rowGap = CAM * s * (1.0 - 1.0 / RATIO);
      float zw = d / uZoom;                     // world position into the distance
      float aw = 1.2 * px / sz;                 // one pixel, in world units
      float haze = 1.0 - exp(-d * uFog * 0.09);
      float g = gust(vec2(xw * dirS, zw), t);
      // Gusts lay the grass over, or a steady breeze holds it; either way
      // it still breathes a little.
      float bendRow = uSway * (uDirection * mix(0.5, 0.1 + 0.8 * g, uGusts) + 0.12 * sin(t * 0.7 + xw * 0.8 + zw * 0.5));
      float handNear = touch * exp(-(zw - hand.y) * (zw - hand.y) / 0.03);

      // Dandelions, one per cell where a cell has one. They grow in drifts,
      // and further rows hold more of them, as each covers more ground.
      float prob = 0.0;
      if (flowersHere) prob = uFlowers * clamp(0.12 * d, 0.0, 0.9) * smoothstep(0.3, 0.75, noise(vec2(xw * 0.35, zw * 0.35) + 17.0)) * 1.6;
      if (prob > 0.0) {
        // Seen from higher above when near, almost edge on when far.
        float squash = clamp(CAM * s * 1.3 + 0.45, 0.5, 0.9);
        for (int k = -1; k <= 1; k++) {
          float cell = fid0 + float(k);
          float fid = cell + i * 71.3;
          if ((k < 0 ? roll.x : k == 0 ? roll.y : roll.z) > prob) continue;
          float f2 = hash11(fid * 5.71 + 1.3);
          float fx = (cell + 0.15 + 0.7 * f2) * fw;
          // Out of reach to the side, however it bends: no head or stem here.
          float swing = abs(bendRow) * 0.45 + 0.05 * uSway * uFlutter + (handNear > 0.01 ? 1.5 * touch : 0.0);
          if (abs(xw - fx) > swing * 0.625 * L + 1.42 * max(0.0308, 0.55 * aw) + aw * 1.01) continue;
          float f3 = hash11(fid * 2.33 + 7.1);
          float f4 = hash11(fid * 9.13 + 3.7);
          bool clock = hash11(fid * 6.29 + 4.4) < uClocks;
          float fg = ground - f3 * rowGap;
          // Some stand clear of the grass, some are half hidden in it.
          float fh = L * (0.5 + 0.75 * f3 * f4);
          // Stiffer than the grass, nodding a little on its own.
          float bend = bendRow * 0.45 + sin(t * 1.1 + f2 * 30.0) * 0.05 * uSway * uFlutter;
          if (handNear > 0.01) bend += touch * brush(vec2(fx, zw), hand, swipe) * 0.8;
          float hx = fx + bend * 0.5 * fh;
          float hy = fh * (1.0 - 0.15 * bend * bend);
          float yw = (yy - fg) / sz;              // height above its root
          float r = (clock ? 0.018 : 0.013) * (0.6 + 0.8 * fract(f2 * 9.1));
          float rr = max(r, 0.55 * aw);
          float energy = (r * r) / (rr * rr);
          float detail = smoothstep(2.0, 6.0, r / aw);  // fine structure only where it is big enough to see
          float eu = aw / rr;                     // one pixel, in head radii
          vec2 q = vec2(xw - hx, yw - hy);
          float a = 0.0;
          vec3 c = vec3(0.0);
          if (dot(q, q) < rr * rr * 2.0) {
            if (clock) {
              // A seed clock: a sphere of fine fibres, lit from above,
              // see-through at the rim, with the seeds dark at its heart.
              float u = length(q) / rr;
              float fib = mix(0.5, 0.5 + 0.5 * sin(atan(q.y, q.x) * 37.0 + f2 * 60.0), detail);
              float rim = 1.0 - 0.06 * fib;
              float body = smoothstep(rim + eu, rim - 0.45 - eu, u);
              float strands = pow(fib, 6.0) * smoothstep(rim + 0.08, 0.5, u) * detail;
              // Translucent, and thinner on clocks the wind has half stripped.
              a = clamp(body * 0.65 + strands * 0.2, 0.0, 1.0) * mix(0.5, 1.0, f4);
              float shade = 0.55 + 0.3 * q.y / rr + 0.25 * (1.0 - sqrt(max(1.0 - u * u, 0.0)));
              c = vec3(0.86, 0.86, 0.82) * lit * shade;
              c = mix(c, uGrass * 0.4 * lit, smoothstep(0.25, 0.08, u) * 0.6 * detail);
            } else {
              // A flower: a disc of petals tilted towards us, deeper orange
              // at the heart, green sepals showing beneath the front rim.
              // Each head faces its own way: tilted and turned a little.
              float tilt = (f4 - 0.5) * 0.6;
              vec2 b = vec2(q.x + q.y * tilt, q.y / (squash * (0.7 + 0.6 * f3)));
              float u = length(b) / rr;
              float petals = mix(0.5, 0.5 + 0.5 * cos(atan(b.y, b.x) * 18.0 + f2 * 20.0), detail);
              float rim = 0.92 + 0.08 * petals;
              float disc = smoothstep(rim + eu, rim - eu, u);
              float sepal = smoothstep(0.92 + eu, 0.92 - eu, length(b + vec2(0.0, 0.2 * rr)) / rr) * detail;
              // A dome of petals, lit from above.
              vec3 petal = uBloom * (0.8 + 0.3 * f3) * lit * (0.75 + 0.25 * petals * u) * (0.7 + 0.35 * clamp(b.y / rr + 0.3, 0.0, 1.0));
              petal = mix(petal, uBloom * vec3(1.0, 0.55, 0.2) * lit * 0.7, smoothstep(0.4, 0.1, u));
              a = max(disc, sepal);
              c = mix(uGrass * 0.55 * lit, petal, disc);
            }
            a *= energy;
          }
          // The stem, bowing towards the head and thinning as it goes.
          float stemY = clamp(yw / hy, 0.0, 1.0);
          float sx = fx + (hx - fx) * stemY * stemY;
          float ws = 0.0012 * (1.2 - 0.5 * stemY);
          float wsd = max(ws, 0.5 * aw);
          float stem = smoothstep(wsd + aw, wsd - aw, abs(xw - sx)) * step(yw, hy) * ws / wsd;
          stem *= smoothstep(0.0, 0.4, stemY);   // lost among the blades at its foot
          vec3 sc = uGrass * lit * (0.25 + 0.35 * stemY);
          float sa = stem * (1.0 - a);
          c = c * a + sc * sa;
          a += sa;
          if (a <= 0.0) continue;
          c = mix(c / a, uSkyLow, haze) * a;
          acc += through * c;
          through *= 1.0 - min(a, 1.0);
        }
      }

      if (bladesHere && through > 0.02) {
        // Patches of lighter and darker grass, and clumps of taller growth.
        float tone = noise(vec2(xw * 0.6, zw * 0.6)) * 0.6 + noise(vec2(xw * 2.1, zw * 2.1)) * 0.4;
        float clump = 0.65 + 0.7 * noise(vec2(xw * 3.0, zw * 3.0) + 9.0);
        // Every blade of a row bends along the same curve, set by height above
        // the row's ground line: so where the blades reaching this pixel are
        // rooted is known exactly, and each strays from it by less than one
        // spacing. No blade is ever missed, near the hand or anywhere else.
        float hRow = max(yy - ground, 0.0) / sz;           // height above the row's ground
        float y0 = hRow / L;
        float bendEst = bendRow + sin(t * 2.4 + xw * 5.0) * 0.12 * uFlutter * (0.4 + g);
        // Near the hand, blades either side are pushed apart, so their bends
        // differ: the search widens there, where it costs nothing to look.
        float handHere = 0.0;
        if (handNear > 0.01) {
          vec2 root = vec2(xw - clamp(bendEst, -1.2, 1.2) * 0.6 * hRow * hRow / (L * clump), zw);
          bendEst += touch * brush(root, hand, swipe);
          handHere = touch * exp(-dot(root - hand, root - hand) / 0.05);
        }
        bendEst = clamp(bendEst, -1.2, 1.2);
        // A blade strays furthest at its tip: low down, neighbours suffice.
        float kLo = handHere > 0.02 ? -4.0 : -1.0 - step(0.45, y0);
        float kHi = handHere > 0.02 ? 4.0 : 1.0;
        // Two interleaved layers: tall blades, and shorter growth among them.
        for (int j = 0; j < 2; j++) {
        float lj = 1.0 - 0.35 * float(j);
        float lref = L * clump * lj;
        if (hRow > lref * 1.1) continue;                     // above this layer's tallest
        float lean = 0.6 * hRow * hRow / lref;               // sideways shift per unit of bend
        float id = floor((xw - bendEst * lean) / spacingW + 0.5 * float(j));
        for (float k = kLo; k <= kHi; k++) {
          float cell = id + k;
          float bid = cell + i * 131.7 + float(j) * 1031.0;
          float hA = hash11(bid * 7.13 + 1.7);
          float hB = fract(hA * 13.17 + 0.31);
          float hC = fract(hA * 71.31 + 0.67);
          float x0 = (cell + hA - 0.5 * float(j)) * spacingW;
          float gr = ground - hC * rowGap;
          float bl = lref * (0.4 + 0.75 * hB * hB);
          // Below its root, or above its tallest: out before its wind and pointer.
          float above = (yy - gr) / sz;
          if (above < 0.0 || above > bl) continue;
          // The wind, a flutter shared with its neighbours, and the pointer.
          float bend = bendRow + sin(t * 2.4 + x0 * 5.0) * 0.12 * uFlutter * (0.4 + g);
          if (handNear > 0.01) bend += touch * brush(vec2(x0, zw), hand, swipe);
          bend = clamp(bend, -1.2, 1.2);
          float tall = bl * (1.0 - 0.3 * bend * bend);
          float y = above / tall;                 // 0 root, 1 tip
          if (y > 1.0) continue;
          // Its own lean, more so in a gust, within a blade's spacing.
          float stray = ((hA - 0.5) + (hC - 0.5) * abs(bendRow)) * own;
          float cx = x0 + bend * lean + stray * y * y;
          float sl = 1.2 * bend * hRow / lref + 2.0 * stray * y / tall;
          // Too far to the side to touch this pixel, at its widest.
          float side = max(0.00308, 0.5 * aw) + aw;
          if ((xw - cx) * (xw - cx) > side * side * (1.0 + sl * sl)) continue;
          // Real blades are thin: drawn at least a pixel wide, and fainter
          // to match, so they neither vanish nor shimmer far off.
          float w = 0.0022 * (0.6 + 0.8 * hB) * pow(1.0 - y, 0.6);
          float wd = max(w, 0.5 * aw);
          float dx = (xw - cx) / sqrt(1.0 + sl * sl);
          float a = smoothstep(wd + aw, wd - aw, abs(dx)) * lod * w / wd;
          if (a <= 0.0) continue;
          vec3 base = uGrass * mix(vec3(0.8, 1.0, 0.75), vec3(1.15, 1.05, 0.7), hA) * (0.55 + 0.7 * fract(hC * 7.3));
          // A few blades have dried to straw.
          base = mix(base, vec3(0.3, 0.24, 0.11), step(0.94, fract(hA * 263.7)) * 0.8);
          vec3 c = base * mix(0.1, 1.0, pow(y, 0.8)) * (uAmbient + uLight * (0.6 + 0.4 * hB));
          // Rounded: one edge to the light, a bright midrib towards the tip.
          float across = clamp(dx / wd, -1.0, 1.0) * sign(hC - 0.5);
          c *= 0.75 + 0.3 * across * detailOf(w, aw);
          c *= (0.65 + 0.7 * tone) * (1.0 + (g - 0.4) * 0.6 * uSway * y);
          // The waxy blades catch the sky: pale sheen towards the tips.
          c += uSkyLow * uAmbient.g * 0.3 * y * y * hB * hB;
          c = mix(c, uSkyLow, haze);
          acc += through * a * c;
          through *= 1.0 - a;
          if (through < 0.02) break;
        }
        }
      }
    }

    // What shows between the blades: the ground in the blades' own shade,
    // as dark as their roots, and far off, where blades are finer than a
    // pixel, their average colour.
    float dm = CAM / h;
    float lodM = smoothstep(1.0, 3.0, spacingW * uZoom / dm / px);
    float xm = p.x * dm / uZoom;
    float zm = dm / uZoom;
    // Upright streaks, as massed blades read when too fine to draw singly.
    float tex = noise(vec2(xm * 30.0, zm * 6.0)) * 0.5 + noise(vec2(xm * 160.0, zm * 8.0)) * 0.5;
    float toneM = noise(vec2(xm * 0.6, zm * 0.6)) * 0.6 + noise(vec2(xm * 2.1, zm * 2.1)) * 0.4;
    vec3 under = uGrass * lit * mix(0.4, 0.1, lodM) * (0.6 + 0.8 * tex) * (0.65 + 0.7 * toneM);
    under *= 1.0 + (gust(vec2(xm, zm), t) - 0.4) * 0.4 * uSway * (1.0 - lodM);
    under = mix(under, uSkyLow, 1.0 - exp(-dm * uFog * 0.09));
    colour = acc + through * under;
    // Soften the line where field meets fog.
    colour = mix(colour, skyCol, smoothstep(0.012, 0.0, h) * uFog);
  }

  // The grade, in display space: exposure, colour, contrast, faded blacks,
  // vignette, then grain and noise over everything, as a camera would.
  colour *= exp2(uExposure * 2.0);
  colour = 1.0 - exp(-colour * 1.4);
  vec3 c = linearToSrgb(colour);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  vec3 toned = mix(2.0 * l * uTint, 1.0 - 2.0 * (1.0 - l) * (1.0 - uTint), step(0.5, l));
  c = mix(c, toned, uToning);
  c = (c - 0.5) * uContrast + 0.5;
  c = mix(vec3(uFade * 0.2), vec3(1.0 - uFade * 0.06), clamp(c, 0.0, 1.0));
  vec2 vq = uv - 0.5;
  c *= 1.0 - uVignette * smoothstep(0.2, 0.9, dot(vq, vq) * 2.2);

  // Grain: half of it fixed, like the tooth of the stock, half crossfading
  // between frames, so it shimmers rather than strobes. The noise shifts
  // colour only, never brightness.
  vec2 gp = gl_FragCoord.xy / max(uPixelRatio, 0.5);
  float ft = uTime * 12.0;
  float f0 = floor(ft);
  float fr = smoothstep(0.0, 1.0, fract(ft));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (uGrain > 0.0) {
    float grain = mix(grainAt(gp, f0), grainAt(gp, f0 + 1.0), fr) * 0.55 + grainAt(gp, -1.0) * 0.45;
    c += grain * uGrain * 0.13 * (0.35 + l * (1.0 - l) * 2.6);
  }
  if (uNoise > 0.0) {
    vec3 cn = mix(chromaAt(gp, f0), chromaAt(gp, f0 + 1.0), fr);
    c += (cn - dot(cn, vec3(0.2126, 0.7152, 0.0722))) * uNoise * 0.35 * (1.0 - l * 0.6);
  }
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// Each sky brings its own light, and its own haze over the distance.
const SKIES = {
  fog: { top: '#5d5e64', low: '#85868b', light: '#5a5a5c', ambient: '#8d8e94', stars: 0, fog: 0.6 },
  day: { top: '#5b8fd9', low: '#d6e3ec', light: '#fff1d6', ambient: '#7f9cc4', stars: 0, fog: 0.35 },
  blue: { top: '#8ab8e8', low: '#e3eef7', light: '#c9d8e6', ambient: '#a9c4de', stars: 0, fog: 0.6 },
  golden: { top: '#6fa8ee', low: '#ffd9ab', light: '#ffd08f', ambient: '#b9b4a6', stars: 0, fog: 0.25 },
  night: { top: '#03050c', low: '#121a2c', light: '#0d1426', ambient: '#141c30', stars: 0.6, fog: 0.4 },
};

/** @type {import('./runtime.js').EffectSpec<MeadowOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 1,
  time: 20,
  update(o) {
    const sky = SKIES[o.sky] ?? SKIES.fog;
    const film = o.showFilm ? 1 : 0;
    return {
      uSpeed: o.speed,
      uSway: Math.abs(o.sway),
      uDirection: Math.sign(o.sway) || 1,
      uGusts: o.gusts,
      uFlutter: (o.gusts * 4) / 7,
      uZoom: o.zoom,
      uInteractive: o.interactive,
      uHeight: o.height,
      uDensity: o.density,
      uFlowers: o.showFlowers ? o.flowers : 0,
      uClocks: o.clocks,
      uHorizon: 0.6,
      uSlope: -0.08,
      uFog: sky.fog,
      uExposure: o.exposure,
      uSaturation: o.saturation,
      uTint: srgb(o.tint),
      // A grey tint has no colour to lay over the image: no toning at all.
      uToning: isGrey(o.tint) ? 0 : 0.2,
      // Faded film: lifted blacks and softer contrast go together.
      uContrast: film ? 1.1 - 0.25 * o.matte : 1,
      uFade: o.matte * film,
      uGrain: o.grain * film,
      uNoise: o.noise * film,
      uVignette: film ? 0.15 + 0.5 * o.grain : 0,
      uGrass: linear(o.grass),
      uBloom: linear('#f4c21f'),
      uSkyTop: linear(sky.top),
      uSkyLow: linear(sky.low),
      uLight: linear(sky.light),
      uAmbient: linear(sky.ambient),
      uStars: sky.stars,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    // The grass moves well under a pixel a frame, so 30 fps looks the same
    // as 60 at half the work. Full rate only while the pointer brushes it:
    // while it moves over the grass or comes and goes, and for a second
    // after, as the grass settles. A cursor resting on it costs no more.
    let brushedAt = -Infinity;
    let wasOver = false;
    const fps = () => {
      const now = performance.now();
      const over = p.over && !!ctx.options?.().interactive;
      if (over !== wasOver || (over && (p.velocity[0] !== 0 || p.velocity[1] !== 0))) brushedAt = now;
      wasOver = over;
      return now - brushedAt < 1000 ? 0 : 30;
    };
    return { frame: p.frame, destroy: p.destroy, fps };
  },
};

/** @param {string} hex */
function isGrey(hex) {
  return hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7);
}

/** @param {string} hex */
function srgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<MeadowOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function meadow(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
