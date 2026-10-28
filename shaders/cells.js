// @ts-check
/**
 * ittybitty/cells
 *
 * A living Voronoi network, drawn the way Cohere's identity draws it: fine
 * dotted hairlines on near-black, each cell's outline rounded where three
 * cells meet, so every junction opens into a tiny curved triangle. The seeds
 * drift on slow orbits, now and then a cell pinches in two like a dividing
 * cell and later heals, and parts of the network fade in and out. Sparks of
 * light run along the edges like signals through nerves, drawn solid and
 * bright over the dots, and the colour drifts across the network in slow
 * washes. Behind it, a dark backdrop, the page itself, or an iridescent
 * pastel wash seen through the cells like frosted glass.
 *
 * The pointer gently magnifies the cells beneath it and lights them up, and
 * a click sends a ring of light out through the network.
 *
 * https://ittybitty.dev/shaders/cells (MIT)
 */
import { mount, linear, gradient } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} CellsOptions
 * @property {boolean} showBackground The backdrop. Off, only the network is drawn, over the page.
 * @property {boolean} showPulses Sparks of light running along the edges.
 * @property {number} speed How fast the cells drift and divide.
 * @property {number} size How large the cells are.
 * @property {number} jitter How irregular the cells are, from a neat grid to a wild tangle.
 * @property {number} rounding How much each corner is rounded where cells meet.
 * @property {number} width Thickness of the lines, in CSS pixels.
 * @property {number} dots How much the lines break into dots, from solid to finely dotted.
 * @property {number} glow How much the lines glow.
 * @property {number} network How much of the network is lit at once.
 * @property {number} division How often cells split in two and later heal.
 * @property {number} fill How strongly each cell is tinted from its edges inwards.
 * @property {import('./runtime.js').Gradient} colors The colours the lines drift through.
 * @property {'solid' | 'iridescent'} backdrop A plain colour, or a pastel iridescent wash seen through the cells.
 * @property {string} background Colour behind the network.
 * @property {number} pulses How many edges carry a spark.
 * @property {number} pulseSpeed How fast the sparks run.
 * @property {boolean} interactive The pointer magnifies and lights the cells, and a click sends a ring of light through them.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {CellsOptions} */
export const defaults = {
  showBackground: true,
  showPulses: true,
  speed: 0.5,
  size: 1,
  jitter: 0.85,
  rounding: 0.75,
  width: 1.2,
  dots: 0.85,
  glow: 0.12,
  network: 0.55,
  division: 0.3,
  fill: 0,
  colors: [
    [0, '#79ed68'],
    [0.48, '#79ed68'],
    [0.52, '#c46ee0'],
    [1, '#c46ee0'],
  ],
  backdrop: 'solid',
  background: '#07080f',
  pulses: 0.15,
  pulseSpeed: 1,
  interactive: true,
  responsiveness: 0.5,
};

const CLICKS = 4;
// The 3×3 grid squares around a pixel, in the order they are weighed.
const NINE = [-1, 0, 1].flatMap((j) => [-1, 0, 1].map((i) => [i, j]));

/** A `#rrggbb` colour as sRGB 0 to 1, for the plain backdrop. */
const srgb = (/** @type {string} */ hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
// How far each twin moves from the middle when a cell has fully divided.
const SPLIT = 0.19;
// Grid squares carry on past the edge of the canvas by this many, so the
// 3×3 search and the pointer's lens never read outside the seed texture.
const ORIGIN = [12, 3];

/** A stable hash of a grid square and a salt, 0 to 1. */
function hash(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ s) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Place every seed for time t into data (RGBA per grid square): its offset in
 * the square, drifting on a slow orbit, and the split offset of its twins.
 * Done here rather than in the shader, where each pixel would work out nine
 * squares' worth of hashes and orbits for itself.
 * @param {Float32Array} data
 * @param {number} w
 * @param {number} h
 * @param {number} t
 * @param {number} jitter
 * @param {number} division
 */
function placeSeeds(data, w, h, t, jitter, division) {
  const r = 0.05 + 0.08 * jitter;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = i + ORIGIN[0];
      const y = j + ORIGIN[1];
      const o = (j * w + i) * 4;
      const a = hash(x, y, 1), b = hash(x, y, 2), c = hash(x, y, 3), d = hash(x, y, 4);
      // Slow, independent orbits: the whole network breathes rather than slides.
      data[o] = 0.5 + (a - 0.5) * 0.76 * jitter + r * Math.sin(t * (0.35 + 0.4 * c) + 6.2832 * hash(x, y, 5));
      data[o + 1] = 0.5 + (b - 0.5) * 0.76 * jitter + r * Math.cos(t * (0.3 + 0.45 * d) + 6.2832 * hash(x, y, 6));
      data[o + 2] = data[o + 3] = 0;
      if (hash(x, y, 7) >= division) continue;
      const phase = (((t * 0.035 + hash(x, y, 8) * 7) % 1) + 1) % 1;
      const e = smooth(0.04, 0.4, phase) * (1 - smooth(0.72, 0.98, phase));
      const angle = 6.2832 * c + t * 0.15;
      data[o + 2] = Math.cos(angle) * e * SPLIT;
      data[o + 3] = Math.sin(angle) * e * SPLIT;
    }
  }
}

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform vec4 uStop0, uStop1, uStop2, uStop3, uStop4, uStop5; // OKLab colour, position
uniform float uStopCount; // from gradient(); unused stops repeat the last, so the shader needs no count
uniform vec4 uRampA, uRampK; // each stop's position, and 1 / the gap to the next, for the first four gaps
uniform vec2 uRamp4;         // the same for the last gap
uniform vec3 uBackground;  // linear
uniform vec3 uBackgroundSrgb;
uniform float uTransparent;
uniform float uPulsesOn;
uniform float uCells;      // cells across the height
uniform sampler2D uSeeds; // per grid square: centre offset, split offset (half precision is plenty)
uniform vec2 uSeedOrigin;
uniform float uRound;
uniform float uWidth;      // CSS px
uniform float uDots;
uniform float uGlow;
uniform float uNetwork;
uniform float uFill;
uniform float uIridescent;
uniform float uPulses;
uniform float uPulseSpeed;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform vec4 uRings[${CLICKS}]; // rings of light from clicks: centre (in heights), radius, strength (0 when done)

out vec4 fragColor;

// Hashes without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec4 hash42(vec2 p) {
  vec4 q = fract(p.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}

vec3 oklabToLinear(vec3 lab) {
  vec3 lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480) * lab;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010) * (lms * lms * lms);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Unrolled: unused stops repeat the last colour, so no loop is needed.
vec3 ramp(float x) {
  vec4 t = clamp((x - uRampA) * uRampK, 0.0, 1.0);
  vec3 c = mix(uStop0.rgb, uStop1.rgb, t.x);
  c = mix(c, uStop2.rgb, t.y);
  c = mix(c, uStop3.rgb, t.z);
  c = mix(c, uStop4.rgb, t.w);
  return oklabToLinear(mix(c, uStop5.rgb, clamp((x - uRamp4.x) * uRamp4.y, 0.0, 1.0)));
}

// The seeds of one grid square, worked out on the CPU once a frame (see
// placeSeeds): a mother, and a daughter that splits off it now and then.
// While they sit together they carve the same region as the mother alone, so
// a division starts and ends without a jump. Returns the pair's separation,
// 0 when the square is not dividing.
vec4 seed(vec2 g) {
  return texelFetch(uSeeds, ivec2(g - uSeedOrigin), 0);
}

// Weigh grid square g, with seeds v, as this pixel's nearest or runner-up:
// their squared distances, positions, the nearest's square and which twin.
// (Plain values rather than a struct, so layers.js can namespace them.)
void nearest(vec2 g, vec4 v, vec2 p, inout float best, inout float second, inout vec2 sa, inout vec2 s2, inout vec2 ga, inout float da) {
  vec2 m = g + v.xy + v.zw;
  vec2 tw = m - 2.0 * v.zw;
  float dm = dot(p - m, p - m);
  float dd = v.z == 0.0 && v.w == 0.0 ? 1e9 : dot(p - tw, p - tw);
  float near1 = min(dm, dd);
  vec2 at = dm <= dd ? m : tw;
  if (near1 < best) {
    second = best; s2 = sa;
    best = near1; sa = at; ga = g; da = dm <= dd ? 0.0 : 1.0;
  } else if (near1 < second) {
    second = near1; s2 = at;
  }
  // The far twin of a pair can be the runner-up too.
  float far1 = max(dm, dd);
  if (far1 < second && far1 < 1e8) { second = far1; s2 = dm <= dd ? tw : m; }
}

// What is known of this pixel's cell before its edges are weighed. One to
// a line, so layers.js can namespace them.
vec2 gP;
vec2 gSa;
vec2 gGa;
float gDa;
float gIdA;
float gDmin;
float gReach;
float gK;
float gIK;  // 1 / k
float gIGk; // 1 / the glow's falloff
float gT;
float gThin;

// The outline so far: a smooth minimum over the bisectors (nearest gM, and
// the sum gS of exp(-(d - m) / k), kept relative to it), how much of it is
// lit, the glow summed over every lit edge, and the edge this pixel belongs
// to (its score, midpoint, direction along it and hash).
float gM;
float gS;
float gVis;
float gGlow;
float gBest;
vec2 gMid;
vec2 gTan;
float gHash;

// The bisector between this pixel's seed and grid square g, with seeds v:
// its distance (positive inside this cell), normal and midpoint, and e the
// square's separation. From a neighbour's side a dividing pair is one
// region, so take the nearer of its two bisectors (a hard minimum, so the
// pair never doubles the line); from inside the pair, the other twin is the
// furrow. Far off (1e9) when there is none, or it is too faint to draw.
float bisect(vec2 g, vec4 v, out vec2 nrm, out vec2 mid, out float e) {
  e = length(v.zw) * (1.0 / ${SPLIT});
  vec2 sm = g + v.xy + v.zw;
  vec2 sd = sm - 2.0 * v.zw;
  bool own = g == gGa;
  nrm = vec2(1.0, 0.0);
  mid = vec2(0.0);
  if (own && e <= 0.0) return 1e9;
  vec2 sb = own ? (gDa > 0.5 ? sm : sd) : sm;
  vec2 dv = sb - gSa;
  float len = length(dv);
  if (len < 1e-4) return 1e9;
  nrm = dv / len;
  mid = 0.5 * (gSa + sb);
  float dj = dot(mid - gP, nrm);
  if (!own && e > 0.0) {
    vec2 dv2 = sd - gSa;
    vec2 nrm2 = dv2 / max(length(dv2), 1e-4);
    vec2 mid2 = 0.5 * (gSa + sd);
    float dj2 = dot(mid2 - gP, nrm2);
    if (dj2 < dj) { dj = dj2; nrm = nrm2; mid = mid2; }
  }
  // The furrow of a dividing cell fades in as the twins part.
  if (own && smoothstep(0.03, 0.3, e) < 1e-3) return 1e9;
  return dj;
}

// Whether square g's bisector could be near enough to be an edge of this
// cell: a cheaper, slightly generous form of bisect's test (no unit normal,
// no furrow fade), which edge then makes exactly.
bool reaches(vec2 g, vec4 v) {
  bool own = g == gGa;
  bool split = v.z != 0.0 || v.w != 0.0;
  vec2 sm = g + v.xy + v.zw;
  vec2 sd = sm - 2.0 * v.zw;
  vec2 sb = own && gDa < 0.5 ? sd : sm;
  vec2 dv = sb - gSa;
  vec2 dv2 = sd - gSa;
  float dj = dot(0.5 * (gSa + sb) - gP, dv) * inversesqrt(max(dot(dv, dv), 1e-8));
  float dj2 = dot(0.5 * (gSa + sd) - gP, dv2) * inversesqrt(max(dot(dv2, dv2), 1e-8));
  if (!own && split) dj = min(dj, dj2);
  return (split || !own) && dj <= gDmin + gReach + 1e-4;
}

// Weigh square g's bisector into the outline.
void edge(vec2 g, vec4 v) {
  vec2 nrm, mid;
  float e;
  float dj = bisect(g, v, nrm, mid, e);
  if (!(dj <= gDmin + gReach)) return;
  bool own = g == gGa;
  float idB = hash12(g * 1.37);
  vec2 hp = vec2(min(gIdA, idB), max(gIdA, idB)) * 113.0;
  float hE = hash12(hp + (own ? 3.7 : 0.0));
  vec2 tn = vec2(-nrm.y, nrm.x) * (gIdA < idB ? 1.0 : -1.0);
  float vl, wq = 1.0;
  if (own) {
    // The furrow of a dividing cell fades in as the twins part, right
    // across the cell, and fades out again as they heal.
    tn = vec2(-nrm.y, nrm.x) * (gDa > 0.5 ? 1.0 : -1.0);
    vl = smoothstep(0.03, 0.3, e);
    wq = vl;
  } else {
    // Edges fade in and out on their own slow cycles, and most are
    // lit only from one end, fading out partway along, so junctions
    // read as scattered forks rather than a complete mesh.
    float h2 = hash12(hp + 5.0);
    float flick = 0.5 + 0.5 * sin(gT * (0.2 + 0.25 * h2) + 6.2832 * hE);
    float need = mix(hE, 1.0 - flick, 0.6);
    vl = smoothstep(need, need + 0.08, uNetwork * 1.12);
    float uj = dot(gP - mid, tn) * (h2 < 0.5 ? 1.0 : -1.0);
    float cut = (fract(h2 * 7.13) - 0.5) * 0.9 + 0.25 * sin(gT * 0.17 + 6.2832 * h2) - (uNetwork - 0.5) * 1.6 + (gThin - 0.5) * 0.8;
    vl = max(vl * smoothstep(cut - 0.12, cut + 0.12, uj), smoothstep(0.75, 1.0, uNetwork));
  }
  // The glow, relative to the bisector between the two nearest seeds (no
  // nearer than the outline's own, so it stays in range); it is put back
  // relative to the outline once every edge is in.
  gGlow += vl * wq * exp(min(-max(dj, 0.0) * gIGk - (dj - gDmin) * (gIGk / 1.5), 80.0));
  // One exponential either way: the new bisector is nearer, so the sum is
  // rescaled to it, or it is further, and adds its own small weight.
  float x = exp(-abs(dj - gM) * gIK);
  if (dj < gM) {
    gS = gS * x + wq;
    gVis = gVis * x + vl * wq;
    gM = dj;
  } else {
    float w = x * wq;
    gS += w;
    gVis += vl * w;
  }
  // The edge this pixel belongs to, for dots and sparks.
  float score = dj - gK * log(max(wq, 1e-6));
  if (score < gBest) {
    gBest = score;
    gMid = mid;
    gTan = tn;
    gHash = hE;
  }
}

// A ring of light sent out by a click, at this pixel: a sharp front with a
// softer wake. Where it is and how strong is worked out once a frame.
float ring(vec4 r, vec2 at) {
  float x = length(at - r.xy) - r.z;
  return exp(min(x, 0.0) * 9.0 - max(x, 0.0) * 60.0) * r.w;
}

// A cheap smooth value noise, for slow washes of colour and fading.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

// The iridescent wash: pastel bands streaked on a diagonal, like the light
// side of the panels it comes from.
vec3 wash(vec2 q, float t) {
  vec2 w = q;
  w += 0.18 * vec2(sin(w.y * 2.1 + t * 0.21), sin(w.x * 1.7 - t * 0.17));
  w += 0.08 * vec2(sin(w.y * 4.3 - t * 0.13), sin(w.x * 3.9 + t * 0.19));
  float h = dot(w, vec2(0.42, 0.62)) + 0.04 * t;
  // cos(2π(h + phase)) for three phases, from one sine and cosine.
  vec2 cs = vec2(cos(6.2832 * h), sin(6.2832 * h));
  vec3 c = 0.74 + 0.26 * (cs.x * vec3(1.000000000, -0.309021186, -0.728962391) - cs.y * vec3(0.000000000, 0.951055154, -0.684553746));
  // Pastel, and leaning to the pinks, violets, blues and mints of the panels.
  c = mix(c, vec3(0.86, 0.8, 0.98), 0.25);
  float streak = 0.5 + 0.5 * sin(dot(w, vec2(-1.4, 2.4)) * 7.0 + 2.0 * sin(dot(w, vec2(2.0, 1.1)) * 2.3 + t * 0.25));
  float s2 = streak * streak;
  float s4 = s2 * s2;
  c = mix(c, vec3(0.95, 0.96, 1.0), s4 * s4 * 0.45);
  c *= 0.9 + 0.1 * streak;
  return c * c; // roughly sRGB to linear
}

void main() {
  vec2 res = uResolution;
  float aspect = res.x / res.y;
  vec2 q = gl_FragCoord.xy / res.y;
  float t = uTime;
  float on = uInteractive * uPointerActive;

  // The pointer pulls the cells towards it, magnifying them like a lens.
  vec2 at = uPointer * vec2(aspect, 1.0);
  vec2 toward = q - at;
  float near = exp(-dot(toward, toward) * 9.0);
  q -= toward * 0.32 * near * on;

  vec2 p = q * uCells + vec2(13.7, 4.1);
  // Device pixels per cell unit, from the derivative so the lens is honoured.
  float unitPx = 1.0 / max(length(fwidth(p)) * 0.7071, 1e-5);
  float css = uPixelRatio;
  float glowPx = (1.0 + 3.0 * uGlow) * css;
  float reachPx = max(glowPx * 7.0, 10.0 * css);

  // Nearest seed and the runner-up, among the 3×3 grid squares around this
  // pixel. The bisector between them is never nearer than the true outline,
  // so it tells cheaply whether a line could be anywhere close.
  // Written out square by square rather than looped: a software renderer
  // runs a loop's body once more than it repeats, and the seeds are
  // fetched once here for the edges below too.
  vec2 cell = floor(p);
${NINE.map(([i, j], c) => `  vec4 v${c} = seed(cell + vec2(${i}, ${j}));`).join('\n')}
  float best = 1e9, second = 1e9;
  vec2 sa = vec2(0.0), s2 = vec2(0.0), ga = cell;
  float da = 0.0;
${NINE.map(([i, j], c) => `  nearest(cell + vec2(${i}, ${j}), v${c}, p, best, second, sa, s2, ga, da);`).join('\n')}
  // Twins share their mother's id, so an edge looks the same from both sides.
  float idA = hash12(ga * 1.37);
  vec2 dv2 = s2 - sa;
  // An upper bound on the distance to the outline, and a lower bound: no
  // bisector is nearer than half the gap between the two nearest seeds.
  float dmin = dot(0.5 * (sa + s2) - p, dv2 * inversesqrt(max(dot(dv2, dv2), 1e-8)));
  float dlow = 0.5 * (sqrt(second) - sqrt(best));

  float k = mix(0.002, 0.05, uRound);
  float d = dmin;                   // cell units, positive inside the outline
  float vis = 0.0;
  float visGlow = 0.0;
  float glowSum = 0.0;
  float lit = 0.0;
  float dpx = dlow * unitPx;        // device px from the line, at least
  vec2 eMid = vec2(0.0), eTan = vec2(1.0, 0.0);
  float eHash = 0.0;
  // Most pixels sit well inside a cell, far from any line: they skip the rest.
  if (dpx < reachPx || uFill > 0.0) {
    // Distance to this cell's outline: a smooth minimum over the nearby
    // bisectors, so the corners round off instead of meeting in a point.
    // The network thins out in slow drifting patches, as in the panels.
    float thin = vnoise(p * 0.45 + vec2(t * 0.03, -t * 0.02));
    float reach = max(8.0 * k, 8.0 * glowPx / unitPx);
    // The glow sums every lit edge's own falloff, so it stays smooth where
    // the nearest edge changes from one to another. Bisectors well beyond
    // the nearest are not edges of this cell at all, and are let go.
    float gk = glowPx / unitPx;
    gP = p; gSa = sa; gGa = ga; gDa = da; gIdA = idA; gDmin = dmin; gReach = reach; gK = k; gIK = 1.0 / k; gIGk = 1.0 / gk; gT = t; gThin = thin;
    gM = 1e9;
    gS = 0.0;
    gVis = 0.0;
    gGlow = 0.0;
    gBest = 1e9;
    gMid = eMid;
    gTan = eTan;
    gHash = eHash;
    // Only the squares whose bisectors reach are weighed in full: a cheap
    // pass over all nine marks them, then they are taken lowest first (the
    // same order as all nine would be), so a pixel pays for the few edges
    // near it rather than for all nine.
    int marks = ${NINE.map(([i, j], c) => `(reaches(cell + vec2(${i}, ${j}), v${c}) ? ${1 << c} : 0)`).join(' | ')};
    do {
      int bit = marks & -marks;
      marks ^= bit;
      int c = int(log2(float(max(bit, 1))) + 0.5);
      vec2 g = cell + vec2(float(c % 3 - 1), float(c / 3 - 1));
      if (bit != 0) edge(g, seed(g));
    } while (marks != 0);
    float m = gM;
    float s = gS;
    eMid = gMid;
    eTan = gTan;
    eHash = gHash;
    vis = smoothstep(0.08, 0.7, gVis / max(s, 1e-6));
    glowSum = gGlow * exp(min((m - dmin) / (1.5 * gk), 80.0));
    visGlow = min(glowSum, 1.0) * step(0.0, d + 1.0 / unitPx);
    d = m - k * log(max(s, 1e-30));
    dpx = abs(d) * unitPx;
    float u = dot(p - eMid, eTan);  // along the edge, cell units

    // Sparks: a bright head with a fading tail, running along some edges.
    float spark = 0.0;
    if (uPulsesOn > 0.5) {
      float hs = hash12(vec2(eHash * 71.0, 3.3));
      float dir = hs < 0.5 ? 1.0 : -1.0;
      float pos = mix(-0.9, 0.9, fract(t * uPulseSpeed * 0.3 + eHash * 13.0));
      float x = (u * dir - pos);
      spark = exp(min(x, 0.0) * 5.0 - max(x, 0.0) * 40.0) * step(hash12(vec2(eHash * 31.0, 9.1)), uPulses);
    }
    // Rings of light sent out by clicks.
    vec2 fc = gl_FragCoord.xy / res.y;
    float rings = ${Array.from({ length: CLICKS }, (_, i) => `ring(uRings[${i}], fc)`).join(' + ')};
    lit = clamp(spark + rings, 0.0, 1.0) * smoothstep(6.0 * css, 0.0, dpx);
    eMid.x = u; // carried on for the dots below
  }
  float u = eMid.x;
  float shown = max(vis, lit);

  // Layers, premultiplied, from the back: cell tint, glow, line.
  vec3 P = vec3(0.0);
  float A = 0.0;
  if (max(shown, visGlow) > 1e-3 || uFill > 0.0) {
    // Colour drifts across the network in slow washes.
    float cx = vnoise(p * 0.3 + vec2(t * 0.05, t * 0.03)) * 1.4 - 0.2;
    vec3 lc = ramp(clamp(cx, 0.0, 1.0));
    if (uFill > 0.0) {
      float hf = hash12(ga * 2.71);
      vec3 fc = ramp(clamp(cx + (hf - 0.5) * 0.5, 0.0, 1.0));
      // Not tied to which edges are lit: that changes from edge to edge
      // across the cell and would cut the tint into wedges.
      float fa = uFill * (0.08 + 0.45 * exp(-max(d, 0.0) * 6.0));
      P = fc * fa; A = fa;
    }
    if (max(shown, visGlow) > 1e-3) {
      // Line coverage: a solid hairline, or round dots along it. Lit parts are solid.
      float hw = 0.5 * uWidth * css;
      float solid = clamp(hw + 0.5 - dpx, 0.0, 1.0);
      float pitch = max(4.5, uWidth * 3.8) * css;
      float along = (fract(u * unitPx / pitch + eHash * 7.0) - 0.5) * pitch;
      float r0 = max(hw * 1.1, 0.8 * css);
      float dotc = clamp(r0 + 0.5 - length(vec2(dpx, along)), 0.0, 1.0);
      float core = mix(solid, dotc, uDots * (1.0 - lit)) * shown * step(0.0, d + 0.5 / unitPx);

      float lantern = 1.0 + 1.2 * near * on;
      vec3 hot = mix(lc, vec3(1.0), 0.35) * 1.6;
      vec3 coreC = mix(lc * (1.0 + 0.4 * uDots), hot, lit) * lantern;
      float halo = uGlow * 0.4 * visGlow + exp(-dpx / (glowPx + lit * css)) * lit * (uGlow * 0.4 + 0.25) * step(0.0, d + 1.0 / unitPx);
      halo = clamp(halo * lantern, 0.0, 1.0);
      P = lc * halo + P * (1.0 - halo); A = halo + A * (1.0 - halo);
      float ca = clamp(core, 0.0, 1.0);
      P = coreC * ca + P * (1.0 - ca); A = ca + A * (1.0 - ca);
    }
  }

  float n = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  bool clear = uTransparent > 0.5;
  if (A <= 0.0 && (clear || uIridescent < 0.5)) {
    fragColor = clear ? vec4(0.0) : vec4(uBackgroundSrgb + n, 1.0);
    return;
  }
  // Over the page, the colour unpremultiplied; else over the backdrop. One
  // conversion to sRGB serves both.
  vec3 col = P / max(A, 1e-4);
  if (!clear) {
    vec3 bg = uBackground;
    if (uIridescent > 0.5) {
      // Each cell refracts the wash a little differently, like frosted glass.
      vec2 shift = (vec2(hash12(ga + da * 3.0), hash12(ga + 7.0 + da)) - 0.5) * 0.05;
      bg = wash(q + shift, t);
    }
    col = P + bg * (1.0 - A);
  }
  vec3 c = linearToSrgb(col) + n;
  fragColor = clear ? vec4(clamp(c, 0.0, 1.0) * A, A) : vec4(c, 1.0);
}
`;

const BACKDROPS = { solid: 0, iridescent: 1 };

/** @type {import('./runtime.js').EffectSpec<CellsOptions>} */
export const spec = {
  defaults,
  fragment,
  dpr: 1.5,
  alpha: true,
  time: 6,
  speed: (o) => o.speed,
  update(o) {
    const g = gradient(o.colors);
    const at = (/** @type {number} */ i) => /** @type {number[]} */ (g[`uStop${i}`])[3];
    const gap = (/** @type {number} */ i) => 1 / Math.max(at(i + 1) - at(i), 1e-4);
    return {
      ...g,
      uRampA: [at(0), at(1), at(2), at(3)],
      uRampK: [gap(0), gap(1), gap(2), gap(3)],
      uRamp4: [at(4), gap(4)],
      uBackground: linear(o.background),
      uBackgroundSrgb: srgb(o.background),
      uTransparent: !o.showBackground,
      uPulsesOn: o.showPulses,
      uCells: 6.5 / o.size,
      uRound: o.rounding,
      uWidth: o.width,
      uDots: o.dots,
      uGlow: o.glow,
      uNetwork: o.network,
      uFill: o.fill,
      uIridescent: (BACKDROPS[o.backdrop] ?? 0) === 1,
      uPulses: o.pulses,
      uPulseSpeed: o.pulseSpeed,
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const { gl, canvas } = ctx;
    const unit = ctx.textureUnit(0);
    const p = pointer(ctx, { ease: 4 });
    /** @type {WebGLTexture | null} */
    let tex = null;
    let data = new Float32Array(0);
    let tw = 0;
    let th = 0;
    const clicks = new Float32Array(CLICKS * 4);
    const rings = new Float32Array(CLICKS * 4);
    let next = 0;
    let clock = 0;
    let ringing = 0;
    const down = () => {
      if (!p.over || !ctx.options?.().interactive) return;
      const i = next * 4;
      clicks[i] = p.target[0];
      clicks[i + 1] = p.target[1];
      clicks[i + 2] = clock;
      clicks[i + 3] = 1;
      next = (next + 1) % CLICKS;
      ringing = 4;
      ctx.invalidate();
    };
    addEventListener('pointerdown', down, { passive: true });
    return {
      frame(dt, time) {
        p.frame(dt);
        // Enough grid squares to cover the canvas, plus a margin.
        const o = /** @type {CellsOptions} */ (/** @type {unknown} */ (ctx.options?.() ?? defaults));
        const n = 6.5 / o.size;
        const w = Math.min(512, Math.ceil((n * canvas.width) / Math.max(1, canvas.height)) + 5);
        const h = Math.ceil(n) + 5;
        if (w * h * 4 > data.length) data = new Float32Array(w * h * 4);
        placeSeeds(data, w, h, time, o.jitter, o.division);
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (!tex) {
          tex = gl.createTexture();
          tw = th = 0;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        if (w !== tw || h !== th) {
          tw = w;
          th = h;
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data, 0);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data, 0);
        }
        ctx.sampler('uSeeds', unit);
        ctx.uniform('uSeedOrigin', ORIGIN);
        // Rings run on the wall clock, so they still spread when speed is 0.
        clock += dt;
        const aspect = canvas.width / Math.max(1, canvas.height);
        for (let i = 0; i < CLICKS; i++) {
          const a = clock - clicks[i * 4 + 2];
          const live = clicks[i * 4 + 3] > 0 && a >= 0 && a <= 4;
          rings[i * 4] = clicks[i * 4] * aspect;
          rings[i * 4 + 1] = clicks[i * 4 + 1];
          rings[i * 4 + 2] = a * 0.55;
          rings[i * 4 + 3] = live ? smooth(4, 1, a) * smooth(0, 0.05, a) : 0;
        }
        ctx.uniform('uRings', rings);
        if (ringing > 0) {
          ringing -= dt;
          ctx.invalidate();
        }
      },
      restore() {
        tex = null;
      },
      destroy() {
        if (tex) gl.deleteTexture(tex);
        tex = null;
        removeEventListener('pointerdown', down);
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<CellsOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function cells(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
