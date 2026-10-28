// @ts-check
/**
 * ittybitty/koi
 *
 * A koi pond seen from above. Fish glide in slow, winding loops, their bodies
 * flexing as they swim and their tails sweeping side to side, each patterned
 * in orange, white and black like real koi. They cast soft shadows on the
 * pond floor, slip under lily pads, and dart away from the pointer, which
 * sends ripples across the surface.
 *
 * https://ittybitty.dev/shaders/koi (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} KoiOptions
 * @property {boolean} showWater The pond floor and its caustic light. Off, the fish swim over the page.
 * @property {boolean} showShadows Shadows the fish and lily pads cast on the floor.
 * @property {boolean} showFish The koi themselves, fins and all.
 * @property {boolean} showPads Lily pads floating on the surface.
 * @property {boolean} showGlints Light glinting off the surface.
 * @property {number} speed How fast the fish swim.
 * @property {number} count How many fish.
 * @property {number} size Size of the fish.
 * @property {number} pads How many lily pads float on the surface.
 * @property {number} ripples Ripples and light on the water.
 * @property {string} water Colour of the water.
 * @property {string} orange The koi's orange.
 * @property {number} variation How much the fish differ: 0 all alike, kohaku in exactly your orange; higher mixes in other varieties and shades.
 * @property {string} pad Colour of the lily pads.
 * @property {boolean} interactive Fish flee the pointer, which ripples the water.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {KoiOptions} */
export const defaults = {
  showWater: true,
  showShadows: true,
  showFish: true,
  showPads: true,
  showGlints: true,
  speed: 0.6,
  count: 6,
  size: 1,
  pads: 0.5,
  ripples: 0.6,
  water: '#12302e',
  orange: '#ff6a1f',
  variation: 0.5,
  pad: '#3f7a3a',
  interactive: true,
  responsiveness: 0.5,
};

const MAX_FISH = 10;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowWater;
uniform float uShowShadows;
uniform float uShowFish;
uniform float uShowPads;
uniform float uShowGlints;
uniform float uTime;
uniform float uCount;
uniform float uSize;
uniform float uPads;
uniform float uRipples;
uniform vec3 uWater;      // linear RGB
uniform vec3 uOrange;
uniform float uVariation;
uniform vec3 uPad;
uniform float uInteractive;
uniform vec2 uPointer;
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

float aspect;
vec2 hand;
float fleeing;

// Each fish's spine: ten points from snout to tail tip, two to a vec4,
// worked out on the CPU from the path the fish has actually swum.
uniform vec4 uSpine[${MAX_FISH * 5}];
// Per fish: tail-beat phase, speed (0 resting to 1 sprinting).
uniform vec4 uFish[${MAX_FISH}];
uniform vec4 uBounds[${MAX_FISH}];

vec2 spinePoint(int i, int k) {
  vec4 v = uSpine[i * 5 + k / 2];
  return (k & 1) == 0 ? v.xy : v.zw;
}

// The nearest point on fish i's spine. Returns the distance to it, where
// along it the point sits (0 at the snout, 1 at the tip of the tail fin,
// running on past the tail), and the signed distance across it. dir is the
// direction the fish faces.
vec3 spine(vec2 p, int i, out vec2 dir) {
  vec2 prev = spinePoint(i, 0);
  dir = normalize(prev - spinePoint(i, 1) + 1e-6);
  float best = 1e3;
  float along = 0.0;
  vec2 nearest = vec2(0.0);
  vec2 tangent = vec2(1.0, 0.0);
  for (int k = 1; k <= 9; k++) {
    vec2 cur = spinePoint(i, k);
    vec2 pa = p - prev;
    vec2 ba = cur - prev;
    float h = dot(pa, ba) / max(dot(ba, ba), 1e-8);
    // The last segment runs on past the tail, for the fin.
    h = clamp(h, 0.0, k == 9 ? 4.0 : 1.0);
    vec2 off = pa - ba * h;
    float d = dot(off, off);
    if (d < best) {
      best = d;
      along = (float(k - 1) + h) / 9.0;
      nearest = off;
      tangent = ba;
    }
    prev = cur;
  }
  tangent = normalize(tangent);
  return vec3(sqrt(best), along, dot(nearest, vec2(-tangent.y, tangent.x)));
}

// Half-width of the body at u along it: a rounded snout, widest a third of
// the way back, tapering to a slim stem where the tail fin joins.
float bodyWidth(float u, float w) {
  float x = clamp(u / 0.8, 0.0, 1.0);
  return w * mix(0.55, 1.0, smoothstep(0.0, 0.3, x)) * mix(1.0, 0.18, pow(smoothstep(0.3, 1.0, x), 0.8)) * step(u, 0.82);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime;
  float px = 1.0 / uResolution.y;
  hand = vec2(uPointer.x * aspect, uPointer.y);
  fleeing = uPointerActive * uInteractive;

  // The surface: slow ripples bend the view of the floor, and rings spread
  // from the pointer.
  // Parts that are switched off are skipped outright, not drawn and hidden.
  vec2 ripple = uRipples > 0.0 ? (vec2(noise(p * 9.0 + t * 0.3), noise(p * 9.0 + 5.0 - t * 0.25)) - 0.5) * 0.006 * uRipples : vec2(0.0);
  if (fleeing > 0.0) {
    vec2 hd = p - hand;
    float hr = length(hd);
    ripple += hd / (hr + 1e-4) * sin(hr * 90.0 - t * 8.0) * exp(-hr * 9.0) * 0.004 * fleeing;
  }
  vec2 q = p + ripple;

  // The pond floor: dark, with pebbles and dappled light.
  // Premultiplied colour and coverage, so any part can stand alone over the
  // page: the floor is the only opaque part.
  vec3 colour = vec3(0.0);
  float alpha = 0.0;
  if (uShowWater > 0.5) {
    mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
    float floorTex = noise(turn * q * 22.0) * 0.6 + noise(turn * turn * q * 55.0) * 0.4;
    colour = uWater * (0.65 + 0.55 * floorTex);
    alpha = 1.0;
    // Caustics: sunlight focused by the rippled surface into a drifting net
    // of bright lines on the bottom, where two moving noise fields meet.
    if (uRipples > 0.0) {
      vec2 cq = turn * q * 14.0;
      float c1 = noise(cq + vec2(t * 0.25, 0.0));
      float c2 = noise(cq * 1.2 + vec2(4.0, -t * 0.2));
      float caustic = pow(max(1.0 - abs(c1 - c2) * 3.0, 0.0), 5.0);
      colour += uWater * caustic * 1.1 * uRipples;
    }
  }

  // Fish: shadows on the floor first, then the fish themselves.
  float len = 0.17 * uSize;
  float bw = len * 0.13;                                   // half-width at the widest
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    if (fi >= uCount || (uShowFish < 0.5 && uShowShadows < 0.5)) break;
    vec4 bounds = uBounds[i];
    if (any(lessThan(q, bounds.xy - px)) || any(greaterThan(q, bounds.zw + px))) continue;
    // A fish never reaches further than its own length from its head: skip
    // pixels outside that circle (with room for the shadow and fins).
    vec2 headAt = spinePoint(i, 0);
    vec4 state = uFish[i];
    vec2 fromHead = q - headAt;
    float reach = len * 1.25 + 0.03;
    if (dot(fromHead, fromHead) > reach * reach) continue;
    vec2 dir;
    if (uShowShadows > 0.5) {
      // Shadow on the floor, offset and soft.
      vec3 ss = spine(q - vec2(0.014, -0.02), i, dir);
      // The shadow follows the body and the fan of the tail.
      float sv = clamp((ss.y - 0.72) / 0.28, 0.0, 1.0);
      float shadowFin = bw * (0.2 + 1.25 * pow(sv, 0.85)) * step(0.72, ss.y) * step(ss.y, 0.95);
      float shadow = smoothstep(0.012, -0.004, ss.x - max(bodyWidth(ss.y, bw), shadowFin * 0.8)) * 0.4;
      colour *= 1.0 - shadow;
      alpha = mix(alpha, 1.0, shadow);
    }
    if (uShowFish < 0.5) continue;
    vec3 sp = spine(q, i, dir);
    float u = sp.y;
    float an = sp.z / bw;                                  // across, in body half-widths
    vec2 side = vec2(-dir.y, dir.x);

    // Pectoral fins: two translucent fans behind the head, flapping.
    // The fins scull gently at rest and tuck in when the fish sprints.
    float flap = 0.25 * sin(state.x * 0.5 + fi * 3.0) * (1.0 - state.y) - 0.35 * state.y;
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      float fs = float(sgn);
      vec2 root = headAt - dir * len * 0.24 + side * fs * bw * 0.75;
      vec2 fdir = normalize(-dir * (0.9 - flap) + side * fs * (0.8 + flap));
      vec2 fd = q - root - fdir * bw * 0.75;
      vec2 fl = vec2(dot(fd, fdir), dot(fd, vec2(-fdir.y, fdir.x)));
      float fe = length(fl / vec2(bw * 0.85, bw * 0.48)) - 1.0;
      float fin = smoothstep(0.08, -0.08, fe);
      float rays = 0.85 + 0.15 * sin(atan(fl.y, fl.x + bw) * 30.0);
      fin *= 0.42 * uShowFish;
      colour = mix(colour, vec3(0.92, 0.9, 0.86) * rays, fin);
      alpha = mix(alpha, 1.0, fin);
    }

    // The tail fin: a broad, translucent fan with a forked end.
    float v = (u - 0.72) / 0.28;
    float wf = bw * (0.2 + 1.25 * pow(clamp(v, 0.0, 1.0), 0.85));
    // Rounded lobes either side of a shallow fork.
    float fa = clamp(abs(sp.z) / max(wf, 1e-4), 0.0, 1.0);
    float fork = 0.7 + 0.45 * fa - 0.3 * fa * fa;
    float vaa = px / (0.28 * len);
    float tailFin = step(0.0, v) * smoothstep(wf + px, wf - px, abs(sp.z)) * smoothstep(vaa, -vaa, v - fork);
    float tailRays = 0.8 + 0.2 * sin(sp.z / max(wf, 1e-4) * 14.0);

    // The body.
    float sd = sp.x - bodyWidth(u, bw);
    float body = smoothstep(px, -px, sd) * step(u, 0.82);
    if (body <= 0.0 && tailFin <= 0.0) continue;

    // Variety: kohaku (red on white), tancho (a red crown), sanke (red and
    // black on white), ogon (metallic gold) and chagoi (bronze).
    // Variation: up to halfway, more fish take other varieties than kohaku;
    // beyond it, each fish's red also drifts warmer or deeper, lighter or
    // darker, as real koi do.
    float kind = hash11(fi * 8.1 + 0.3);
    if (hash11(fi * 2.7 + 5.0) >= uVariation * 2.0) kind = 0.2;
    vec3 white = vec3(0.96, 0.94, 0.9);
    float drift = (hash11(fi * 4.9 + 1.0) - 0.5) * 2.0 * smoothstep(0.5, 1.0, uVariation);
    vec3 red = mix(uOrange, drift > 0.0 ? vec3(1.0, 0.62, 0.12) : vec3(0.62, 0.05, 0.05), abs(drift) * 0.55);
    red *= 1.0 + (hash11(fi * 6.3 + 2.0) - 0.5) * 0.5 * smoothstep(0.5, 1.0, uVariation);
    vec2 bp = vec2(u * 5.0, an * 0.7) + fi * 13.0;
    // Red patches keep to the back, away from the flanks.
    float hi = smoothstep(0.46, 0.54, noise(bp) * 0.9 + 0.3 * (1.0 - an * an) - 0.12);
    hi = max(hi, smoothstep(0.2, 0.14, u) * smoothstep(0.8, 0.5, abs(an)));   // red head
    vec3 skin;
    float sheen = 0.18;
    if (kind < 0.35) skin = mix(white, red, hi);
    else if (kind < 0.47) skin = mix(white, red, smoothstep(bw * 0.5, bw * 0.4, length(vec2((u - 0.12) * len, sp.z))));
    else if (kind < 0.72) {
      float sumi = smoothstep(0.64, 0.7, noise(bp * 1.9 + 7.0)) * smoothstep(0.1, 0.2, u);
      skin = mix(mix(white, red, hi), vec3(0.04, 0.04, 0.05), sumi);
    }
    else if (kind < 0.87) { skin = mix(red, vec3(1.0, 0.82, 0.35), 0.55); sheen = 0.45; }
    else { skin = vec3(0.32, 0.2, 0.1); sheen = 0.3; }
    // Scales: a faint net of diamonds along the back.
    float s1 = abs(fract(u * 36.0 + an * 1.6) - 0.5);
    float s2 = abs(fract(u * 36.0 - an * 1.6) - 0.5);
    skin *= 1.0 - 0.1 * smoothstep(0.08, 0.0, min(s1, s2)) * smoothstep(0.15, 0.3, u) * smoothstep(0.8, 0.6, u);
    // Round the body: lit along the spine, darker down the flanks, with a
    // sheen along the back.
    float round_ = clamp(1.0 - an * an, 0.0, 1.0);
    skin *= 0.55 + 0.5 * sqrt(round_);
    skin += vec3(1.0, 0.97, 0.9) * exp(-an * an * 10.0) * sheen * smoothstep(0.75, 0.3, u);
    // Eyes.
    float eye = smoothstep(0.16, 0.1, length(vec2((u - 0.07) * len / bw, abs(an) - 0.6)));
    skin = mix(skin, vec3(0.03), eye);
    // Just under the surface: a touch of the water's colour.
    skin = mix(skin, uWater, 0.12);

    // Tail fin first (it sits behind the body), translucent, tinted by the
    // fish's own colour.
    vec3 finCol = mix(vec3(0.92, 0.9, 0.86), skin, 0.35) * tailRays;
    tailFin *= 0.55 * (1.0 - body) * uShowFish;
    body *= uShowFish;
    colour = mix(colour, finCol, tailFin);
    alpha = mix(alpha, 1.0, tailFin);
    colour = mix(colour, skin, body);
    alpha = mix(alpha, 1.0, body);
  }

  // Lily pads floating on the surface, casting shadows, with a notch cut in.
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    if (fi >= uPads * 6.0 || uShowPads < 0.5) break;
    vec2 c = vec2(aspect * hash11(fi * 3.3 + 1.0), hash11(fi * 6.1 + 2.0));
    c += vec2(sin(t * 0.1 + fi), cos(t * 0.08 + fi)) * 0.01;
    float r = 0.05 + 0.05 * hash11(fi * 2.2);
    vec2 d = p - c;
    float distance = length(d);
    if (distance > r + max(px, 0.023)) continue;
    if (uShowShadows > 0.5) {
      vec2 ds = d - vec2(0.008, -0.012);
      float padShadow = 0.5 * smoothstep(0.008, -0.004, length(ds) - r) * uShowShadows * uShowPads;
      colour *= 1.0 - padShadow;
      alpha = mix(alpha, 1.0, padShadow);
    }
    if (distance > r + px) continue;
    float ang = atan(d.y, d.x) + fi;
    float notch = smoothstep(0.1, 0.0, abs(mod(ang, 6.2831) - 0.3)) * step(distance, r);
    float on = smoothstep(px, -px, distance - r) * (1.0 - notch);
    // Veins radiating from the centre, and a lighter rim.
    float vein = smoothstep(0.06, 0.0, abs(fract(ang * 16.0 / 6.2831) - 0.5)) * smoothstep(0.0, r, distance);
    vec3 leaf = uPad * (0.8 + 0.3 * noise(d * 60.0)) * (1.0 - vein * 0.25) + uPad * smoothstep(r * 0.8, r, distance) * 0.3;
    on *= uShowPads;
    colour = mix(colour, leaf, on);
    alpha = mix(alpha, 1.0, on);
  }

  // Light glinting off the surface: small round sparkles that come and go.
  if (uShowGlints > 0.5 && uRipples > 0.0) {
    vec2 gcell = floor(p * 45.0);
    vec2 gf = fract(p * 45.0) - 0.5;
    float gh = hash12(gcell + floor(t * 0.7 + hash12(gcell) * 3.0) * 11.0);
    float glint = step(0.994, gh) * exp(-dot(gf, gf) * 80.0) * uRipples * 0.5;
    colour += vec3(0.7, 0.8, 0.8) * glint;
    alpha = min(alpha + glint, 1.0);
  }

  // Back from premultiplied for the sRGB curve, then premultiplied again.
  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** Deterministic 0..1 noise from a number, for the school's starting state. */
const rnd = (/** @type {number} */ n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * The school, simulated on the CPU: each fish wanders in slow loops, keeps
 * to the pond and out of the others' way, swims in bursts and glides, and
 * turns and sprints away from the pointer. Its body follows the path its
 * head has actually swum, with a wave running down it that beats faster the
 * harder it swims. Deterministic in effect time, so seeking replays it.
 *
 * @param {import('./runtime.js').Context} ctx
 * @param {{ target: number[], over: boolean }} pointerState
 */
function school(ctx, pointerState) {
  const POINTS = 10;
  const TRAIL = 72;
  const STEP = 0.008;                                     // trail spacing, pond units
  const spineOut = new Float32Array(MAX_FISH * POINTS * 2);
  const fishOut = new Float32Array(MAX_FISH * 4);
  const boundsOut = new Float32Array(MAX_FISH * 4);
  const trail = new Float32Array(MAX_FISH * TRAIL * 2);
  const head = new Float32Array(MAX_FISH * 2);
  const state = new Float32Array(MAX_FISH * 4);           // heading, speed, beat, thrust
  const count = new Int32Array(MAX_FISH);
  const start = new Int32Array(MAX_FISH);
  // Each fish keeps the same wandering and burst rhythms throughout the swim.
  const rhythms = new Float64Array(MAX_FISH * 4);
  for (let i = 0; i < MAX_FISH; i++) {
    rhythms[i * 4] = 0.21 + 0.2 * rnd(i * 2.1);
    rhythms[i * 4 + 1] = 0.57 + 0.3 * rnd(i * 4.4);
    rhythms[i * 4 + 2] = 0.16 + 0.08 * rnd(i * 9.1);
    rhythms[i * 4 + 3] = rnd(i * 6.6);
  }
  let simTime = 0;
  let aspect = 1.6;

  // The pond's width in units of its height, from the canvas as laid out.
  const measure = () => {
    const c = ctx.canvas;
    const w = c.clientWidth || c.width;
    const h = c.clientHeight || c.height;
    return w > 0 && h > 0 ? w / h : 1.6;
  };

  // When the canvas changes shape, stretch the school with it.
  const fit = () => {
    const next = measure();
    if (Math.abs(next - aspect) < 1e-4) return;
    const k = next / aspect;
    for (let i = 0; i < MAX_FISH; i++) head[i * 2] *= k;
    for (let j = 0; j < trail.length; j += 2) trail[j] *= k;
    aspect = next;
  };

  const reset = () => {
    aspect = measure();
    for (let i = 0; i < MAX_FISH; i++) {
      const x = aspect * (0.15 + 0.7 * rnd(i * 3.1));
      const y = 0.15 + 0.7 * rnd(i * 7.7);
      const a = rnd(i * 5.3) * Math.PI * 2;
      head[i * 2] = x;
      head[i * 2 + 1] = y;
      state[i * 4] = a;
      state[i * 4 + 1] = 0.05;
      state[i * 4 + 2] = rnd(i * 1.3) * 6;
      state[i * 4 + 3] = 0;
      // A straight trail behind it to start from.
      for (let k = 0; k < TRAIL; k++) {
        const j = (i * TRAIL + k) * 2;
        trail[j] = x - Math.cos(a) * STEP * (TRAIL - k);
        trail[j + 1] = y - Math.sin(a) * STEP * (TRAIL - k);
      }
      count[i] = TRAIL;
      start[i] = 0;
    }
    simTime = 0;
  };

  /** @param {number} dt @param {boolean} live */
  const step = (dt, live) => {
    const o = /** @type {any} */ (ctx.options?.() ?? {});
    const len = 0.17 * (o.size ?? 1);
    const base = len * 0.45;
    const flee = live && pointerState.over && o.interactive !== false;
    const hx = pointerState.target[0] * aspect;
    const hy = pointerState.target[1];
    const t = simTime;
    for (let i = 0; i < MAX_FISH; i++) {
      const x = head[i * 2];
      const y = head[i * 2 + 1];
      let a = state[i * 4];
      let v = state[i * 4 + 1];
      // Where it would like to go: straight on, bent by a slow wander.
      let dx = Math.cos(a);
      let dy = Math.sin(a);
      const wander = Math.sin(t * rhythms[i * 4] + i * 1.7) * 0.8 + Math.sin(t * rhythms[i * 4 + 1] + i * 4.1) * 0.45;
      // Keep to the pond: turn back from the edges.
      const margin = 0.12 + len * 0.5;
      const ex = x < margin ? (margin - x) / margin : x > aspect - margin ? -(x - aspect + margin) / margin : 0;
      const ey = y < margin ? (margin - y) / margin : y > 1 - margin ? -(y - 1 + margin) / margin : 0;
      dx += ex * 3;
      dy += ey * 3;
      // Give the others room.
      for (let j = 0; j < MAX_FISH; j++) {
        if (j === i) continue;
        const ox = x - head[j * 2];
        const oy = y - head[j * 2 + 1];
        const d2 = ox * ox + oy * oy;
        const r = len * 0.9;
        if (d2 < r * r && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          dx += (ox / d) * (1 - d / r) * 1.5;
          dy += (oy / d) * (1 - d / r) * 1.5;
        }
      }
      // Flee the pointer: turn away and sprint.
      let fright = 0;
      if (flee) {
        const fx = x - hx;
        const fy = y - hy;
        const d = Math.hypot(fx, fy);
        const reach = 0.16 + len * 0.6;
        if (d < reach) {
          fright = (1 - d / reach) ** 2;
          dx += (fx / (d + 1e-6)) * fright * 8;
          dy += (fy / (d + 1e-6)) * fright * 8;
        }
      }
      // Turn towards where it wants to go, no faster than a fish can.
      const want = Math.atan2(dy, dx);
      let diff = want - a;
      diff -= Math.round(diff / (Math.PI * 2)) * Math.PI * 2;
      const maxTurn = 1.4 + fright * 6;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, diff * 2.5)) + wander * 0.5 * (1 - fright);
      a += turn * dt;
      // Burst and glide: a few strong beats, then coasting.
      const cycle = (t * rhythms[i * 4 + 2] + rhythms[i * 4 + 3]) % 1;
      const thrust = Math.max(cycle < 0.35 ? 1 : 0, fright);
      const target = base * (0.45 + 0.8 * thrust + 3.2 * fright);
      v += (target - v) * (1 - Math.exp(-dt * (fright > 0 ? 6 : 1.2)));
      const nx = x + Math.cos(a) * v * dt;
      const ny = y + Math.sin(a) * v * dt;
      head[i * 2] = nx;
      head[i * 2 + 1] = ny;
      state[i * 4] = a;
      state[i * 4 + 1] = v;
      // The tail beats faster the harder it swims, and barely at all in a glide.
      state[i * 4 + 2] += dt * Math.PI * 2 * (0.6 + 2.6 * (v / base) * (0.35 + 0.65 * thrust));
      state[i * 4 + 3] += (thrust + Math.abs(turn) * 0.15 - state[i * 4 + 3]) * (1 - Math.exp(-dt * 3));
      // Lay down the trail the body will follow.
      const last = ((start[i] + count[i] - 1) % TRAIL) * 2 + i * TRAIL * 2;
      if (Math.hypot(nx - trail[last], ny - trail[last + 1]) >= STEP) {
        const next = ((start[i] + count[i]) % TRAIL) * 2 + i * TRAIL * 2;
        trail[next] = nx;
        trail[next + 1] = ny;
        if (count[i] < TRAIL) count[i]++;
        else start[i] = (start[i] + 1) % TRAIL;
      }
    }
  };

  // The spine: walk back from the head along the trail, sampling points
  // evenly by length, then add the swimming wave across it.
  const write = () => {
    const o = /** @type {any} */ (ctx.options?.() ?? {});
    const len = 0.17 * (o.size ?? 1);
    const base = len * 0.45;
    for (let i = 0; i < MAX_FISH; i++) {
      let px = head[i * 2];
      let py = head[i * 2 + 1];
      let k = 0;
      let walked = 0;
      let want = 0;
      const out = i * POINTS * 2;
      spineOut[out] = px;
      spineOut[out + 1] = py;
      k = 1;
      want = len / (POINTS - 1);
      for (let n = count[i] - 1; n >= 0 && k < POINTS; n--) {
        const j = ((start[i] + n) % TRAIL) * 2 + i * TRAIL * 2;
        const qx = trail[j];
        const qy = trail[j + 1];
        let seg = Math.hypot(qx - px, qy - py);
        while (k < POINTS && walked + seg >= want) {
          const f = (want - walked) / Math.max(seg, 1e-9);
          px += (qx - px) * f;
          py += (qy - py) * f;
          seg -= want - walked;
          walked = want;
          spineOut[out + k * 2] = px;
          spineOut[out + k * 2 + 1] = py;
          k++;
          want = (len * k) / (POINTS - 1);
        }
        walked += seg;
        px = qx;
        py = qy;
      }
      for (; k < POINTS; k++) {
        spineOut[out + k * 2] = px;
        spineOut[out + k * 2 + 1] = py;
      }
      // The wave: small at the head, sweeping wide at the tail.
      const beat = state[i * 4 + 2];
      const effort = 0.35 + 0.65 * state[i * 4 + 3];
      for (k = POINTS - 1; k >= 0; k--) {
        const u = k / (POINTS - 1);
        const a = out + Math.max(k - 1, 0) * 2;
        const b = out + Math.min(k + 1, POINTS - 1) * 2;
        let tx = spineOut[a] - spineOut[b];
        let ty = spineOut[a + 1] - spineOut[b + 1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const sway = len * (0.012 + 0.1 * u * u) * effort * Math.sin(beat - u * 5.5);
        spineOut[out + k * 2] += -ty * sway;
        spineOut[out + k * 2 + 1] += tx * sway;
      }
      // Bound the bent spine and its extended tail, with room for the soft
      // shadow and the pectoral fins reaching back from the head.
      const margin = len * 0.13 * 1.45 + 0.032;
      let minX = spineOut[out] - len * 0.56;
      let minY = spineOut[out + 1] - len * 0.56;
      let maxX = spineOut[out] + len * 0.56;
      let maxY = spineOut[out + 1] + len * 0.56;
      for (k = 0; k <= POINTS; k++) {
        const j = out + Math.min(k, POINTS - 1) * 2;
        const x = spineOut[j] + (k === POINTS ? 3 * (spineOut[j] - spineOut[j - 2]) : 0);
        const y = spineOut[j + 1] + (k === POINTS ? 3 * (spineOut[j + 1] - spineOut[j - 1]) : 0);
        minX = Math.min(minX, x - margin);
        minY = Math.min(minY, y - margin);
        maxX = Math.max(maxX, x + margin);
        maxY = Math.max(maxY, y + margin);
      }
      boundsOut[i * 4] = minX;
      boundsOut[i * 4 + 1] = minY;
      boundsOut[i * 4 + 2] = maxX;
      boundsOut[i * 4 + 3] = maxY;
      fishOut[i * 4] = beat;
      fishOut[i * 4 + 1] = Math.min(1, Math.max(0, (state[i * 4 + 1] - base) / (base * 2.5)));
    }
    ctx.uniform('uSpine', spineOut);
    ctx.uniform('uFish', fishOut);
    ctx.uniform('uBounds', boundsOut);
  };

  reset();
  return {
    /** @param {number} time Effect time. */
    frame(time) {
      fit();
      // Seeking back, or far ahead: replay from the start, a little coarser.
      if (time < simTime - 1e-6 || time - simTime > 30) {
        reset();
        while (simTime + 1 / 30 <= time) {
          step(1 / 30, false);
          simTime += 1 / 30;
        }
      }
      while (simTime + 1 / 60 <= time) {
        step(1 / 60, true);
        simTime += 1 / 60;
      }
      write();
    },
  };
}

/** @type {import('./runtime.js').EffectSpec<KoiOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 20,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowWater: o.showWater,
      uShowShadows: o.showShadows,
      uShowFish: o.showFish,
      uShowPads: o.showPads,
      uShowGlints: o.showGlints,
      uCount: o.count,
      uSize: o.size,
      uPads: o.pads,
      uRipples: o.ripples,
      uWater: linear(o.water),
      uOrange: linear(o.orange),
      uVariation: o.variation,
      uPad: linear(o.pad),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const p = pointer(ctx, { ease: 4 });
    const fish = school(ctx, p);
    return {
      frame(dt, time) {
        p.frame(dt);
        fish.frame(time);
      },
      destroy: p.destroy,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<KoiOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function koi(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
