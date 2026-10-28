// @ts-check
/**
 * ittybitty/diamond
 *
 * A cut gem turning slowly in a studio: real facets built from intersecting
 * planes, raytraced in one pass. Light refracts in, bounces off the pavilion
 * by total internal reflection and refracts out; where it leaves, four
 * samples of the spectrum each bend by their own index, so the edges of the
 * lights split into rainbow fire. Facets that mirror a light at the camera
 * flare into four-pointed stars. The pointer tilts and turns the stone.
 *
 * https://ittybitty.dev/shaders/diamond (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} DiamondOptions
 * @property {boolean} showBackground The backdrop behind the stone. Off, the canvas is clear around it.
 * @property {'round' | 'oval' | 'pear' | 'princess' | 'emerald'} cut The shape and facet pattern of the stone.
 * @property {string} tint Colour of the stone. White is a clear diamond.
 * @property {number} fire How far the light splits into rainbow colours.
 * @property {number} brilliance Refractive index: higher bends light more and traps more of it inside.
 * @property {number} sparkle Strength of the star-shaped glints.
 * @property {number} speed How fast the stone turns.
 * @property {number} size Width of the stone, relative to the canvas's shorter side.
 * @property {'studio' | 'dark' | 'bright' | 'coloured'} lighting Soft white studio lights, a few hard lights in the dark, a bright white studio, or coloured lights.
 * @property {string} background Colour behind the stone.
 * @property {boolean} interactive The pointer tilts and turns the stone.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {DiamondOptions} */
export const defaults = {
  showBackground: true,
  cut: 'round',
  tint: '#ffffff',
  fire: 1,
  brilliance: 2.42,
  sparkle: 0.9,
  speed: 0.4,
  size: 0.62,
  lighting: 'studio',
  background: '#050507',
  interactive: true,
  responsiveness: 0.5,
};

// Every cut is symmetric front to back (z to -z), so the shader keeps only
// one plane of each mirror pair: at most this many. A multiple of four: the
// shader reads planes four at a time.
const MAX_PLANES = 44;
const LIGHTS = 12;
const MAX_FLARES = 8;
const DIST = 7;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

#define MAX_PLANES ${MAX_PLANES}
#define MAX_FLARES ${MAX_FLARES}
#define LIGHTS ${LIGHTS}

uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uPlanes[MAX_PLANES]; // outward normal, distance from the centre; each also stands for its mirror in z
uniform float uPlaneCount;
uniform vec4 uEntry[MAX_PLANES];  // the same planes seen from the camera this frame (see the frame hook)
uniform vec4 uMirror;             // what turns those into their mirrors' (see the frame hook)
uniform vec2 uGirdle;      // radii of a smooth elliptical girdle, or zero for flat sides
uniform vec3 uGroups;      // crown: least upward tilt (cos, sin), first girdle plane
uniform vec3 uGroups2;     // pavilion: least downward tilt (cos, sin), first pavilion plane
uniform vec4 uRot[3];      // object to world rotation, by column
uniform vec4 uFlares[MAX_FLARES]; // screen position, brightness, hue
uniform float uFlareCount;
uniform float uBound;      // bounding sphere radius of the stone
uniform float uLift;       // centres the stone vertically
uniform vec3 uSigma;       // absorption per unit length, per channel
uniform float uIor;
uniform float uFire;
uniform float uSize;
uniform vec4 uLightDir[LIGHTS];   // direction the softbox lies in; w, the cosine of a cone that holds it
uniform vec4 uLightRight[LIGHTS]; // its horizontal axis over its half width
uniform vec4 uLightUp[LIGHTS];    // its vertical axis over its half height
uniform vec4 uLightCol[LIGHTS];   // colour times brightness
uniform vec4 uOctant[8];          // per octant of directions, the lights that reach it; -1 for none
uniform vec3 uAmbientTop, uAmbientBottom;
uniform vec4 uRing;        // ring light round the camera: colour times brightness, segments
uniform vec3 uBackground;
uniform float uTransparent;

out vec4 fragColor;

const float DIST = ${DIST}.0; // camera distance

float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// The studio, in world space: softboxes with crisp edges on a dark ground.
// Crisp edges matter: fire shows where a colour's slightly bent ray lands on
// a light while its neighbour's lands in the dark.
vec3 env(vec3 d) {
  vec3 c = mix(uAmbientBottom, uAmbientTop, smoothstep(-0.4, 0.9, d.y));
  // A ring light round the lens, as jewellers shoot: it lights the stone's
  // heart while the camera's own dark middle keeps contrast in it.
  if (d.z > 0.88 && d.z < 0.985) {
    float band = smoothstep(0.88, 0.895, d.z) * (1.0 - smoothstep(0.96, 0.975, d.z));
    // Its gaps follow sin(segments × the angle round the lens): the
    // imaginary part of (x + iy)^segments on the unit circle, so no atan.
    vec2 z = normalize(d.xy), zn = vec2(1.0, 0.0);
    for (int k = 0; k < int(uRing.w); k++) zn = vec2(zn.x * z.x - zn.y * z.y, zn.x * z.y + zn.y * z.x);
    float gaps = uRing.w > 0.0 ? smoothstep(-0.2, 0.2, zn.y) : 1.0;
    c += uRing.rgb * band * gaps;
  }
  // Only the softboxes whose cone reaches this octant of directions can
  // light it: two or three of the twelve, listed on the CPU, and the loop
  // goes round only those. That spares a GPU most tests, and a software
  // renderer such as SwiftShader, which runs both sides of every branch
  // whichever way it goes, most loop bodies.
  vec4 near = uOctant[(d.x > 0.0 ? 1 : 0) + (d.y > 0.0 ? 2 : 0) + (d.z > 0.0 ? 4 : 0)];
  int count = int(dot(step(0.0, near), vec4(1.0)));
  for (int k = 0; k < count; k++) {
    int i = int(near[k]);
    float z = dot(d, uLightDir[i].xyz);
    // Outside the cone round the softbox it adds exactly nothing.
    if (z <= uLightDir[i].w) continue;
    // Where the ray crosses the softbox's plane, in units of its half size.
    vec2 q = vec2(dot(d, uLightRight[i].xyz), dot(d, uLightUp[i].xyz)) / z;
    vec2 e = abs(q) - 1.0;
    float box = 1.0 - smoothstep(-0.04, 0.04, max(e.x, e.y));
    // Brighter in the middle, like a real diffuser.
    c += uLightCol[i].rgb * box * (1.0 - 0.3 * dot(q, q));
  }
  return c;
}

// Fresnel reflectance of an unpolarised dielectric, from the cosines of the
// angles of incidence (cosI, from the side the light comes from) and of
// refraction, eta = n1 / n2.
float reflectance(float cosI, float cosT, float eta) {
  float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

float fresnel(float cosI, float eta) {
  float s2 = eta * eta * (1.0 - cosI * cosI);
  if (s2 >= 1.0) return 1.0;
  return reflectance(cosI, sqrt(1.0 - s2), eta);
}

// Seen from the camera, whether the ray crosses a plane later on its way in
// than the last found (den < 0: it crosses inwards), or sooner on its way
// out. Steps along the ray are compared as fractions kept whole.
void crossing(float den, float num, int i, inout float inNum, inout float inDen, inout int at, inout float outNum, inout float outDen) {
  if (den < 0.0) { if (num * inDen > inNum * den) { inNum = num; inDen = den; at = i; } }
  else if (num * outDen < outNum * den) { outNum = num; outDen = den; }
}

// Plane i of the full list: each stored plane, then its mirror in z.
vec3 facetNormal(int i) {
  return uPlanes[i / 2].xyz * vec3(1.0, 1.0, i % 2 == 1 ? -1.0 : 1.0);
}

// From a point inside the stone, the facet the ray leaves through. Planes
// come sorted crown, girdle, pavilion: a ray heading steeply down cannot
// leave through the crown, nor one heading steeply up through the pavilion,
// so those groups are skipped. That roughly halves the work.
float exitFacet(vec3 p, vec3 d, out vec3 n) {
  float best = 1e9;
  n = vec3(0.0, 1.0, 0.0);
  float side = sqrt(max(1.0 - d.y * d.y, 0.0));
  int from = dot(uGroups.xy, vec2(d.y, side)) > 0.0 ? 0 : int(uGroups.z);
  int to = dot(uGroups2.xy, vec2(-d.y, side)) > 0.0 ? int(uPlaneCount) : int(uGroups2.z);
  // The nearest plane ahead, as a fraction kept whole: comparing
  // num / den < bestNum / bestDen as a cross product (both dens positive)
  // saves a division per plane, and only the winner's normal is looked up.
  // Planes go four at a time, so their loads are issued together rather
  // than each waited on in turn: on a GPU that wait, not the arithmetic,
  // is most of the cost. Groups start on a multiple of four (see finish()),
  // so a few planes either side are tried too, which is harmless: the
  // nearest plane ahead is the nearest of any set that holds it. Past the
  // last plane the list is zero, and a zero normal is never ahead.
  // Each plane is tried with its mirror in z: one load for two, and they
  // share the x and y terms. Planes facing straight along x are their own
  // mirror and are simply tried twice. Hits count mirrors as odd.
  float bestNum = 1e9, bestDen = 1.0;
  int hit = -1;
  for (int i = from; i < to; i += 4) {
    for (int k = 0; k < 4; k++) {
      vec4 pl = uPlanes[i + k];
      float dxy = dot(pl.xy, d.xy), dz = pl.z * d.z;
      float pxy = pl.w - dot(pl.xy, p.xy), pz = pl.z * p.z;
      float den = dxy + dz, num = pxy - pz;
      if (den > 1e-5 && num * bestDen < bestNum * den) { bestNum = num; bestDen = den; hit = 2 * (i + k); }
      den = dxy - dz;
      num = pxy + pz;
      if (den > 1e-5 && num * bestDen < bestNum * den) { bestNum = num; bestDen = den; hit = 2 * (i + k) + 1; }
    }
  }
  if (hit >= 0) { best = bestNum / bestDen; n = facetNormal(hit); }
  if (uGirdle.x > 0.0) {
    // The far side of the elliptical cylinder the round girdle lies on.
    vec2 q = p.xz / uGirdle, v = d.xz / uGirdle;
    float a = dot(v, v), b = dot(q, v), c = dot(q, q) - 1.0;
    float t = (-b + sqrt(max(b * b - a * c, 0.0))) / max(a, 1e-6);
    if (t < best) {
      best = t;
      vec2 h = (p.xz + d.xz * t) / (uGirdle * uGirdle);
      n = normalize(vec3(h.x, 0.0, h.y));
    }
  }
  return max(best, 0.0);
}

// Four narrow samples of the spectrum, red to violet, as linear RGB. Each
// channel sums to one across them, so light that does not split stays white.
const vec3 W0 = vec3(0.571, 0.029, 0.0);
const vec3 W1 = vec3(0.314, 0.5, 0.0);
const vec3 W2 = vec3(0.0, 0.471, 0.375);
const vec3 W3 = vec3(0.115, 0.0, 0.625);

float luma(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }

// One sample of the spectrum leaving through a facet: where its refracted
// ray points, times the share Fresnel lets through. refract() and fresnel()
// both start from the same Snell term, so it is worked out once here.
// cosI is the ray against the outward normal, eta the index inside over out.
vec3 transmit(vec3 d, vec3 n, float cosI, float eta, mat3 toWorld) {
  float k = 1.0 - eta * eta * (1.0 - cosI * cosI);
  if (k <= 0.0) return vec3(0.0); // total internal reflection
  float cosT = sqrt(k);
  return env(toWorld * (eta * d + (cosT - eta * cosI) * n)) * (1.0 - reflectance(cosI, cosT, eta));
}

// Light leaving the stone at a facet, the ray inside heading out through it.
// Each sample of the spectrum bends by its own index, so where a light's
// edge falls between them it splits into a rainbow: that is the fire. The
// two ends of the spectrum go first; only where they see different light
// are the middle two worth trying. All four go round one loop, so the
// shader holds one copy of transmit() and the env() within it: a software
// renderer such as SwiftShader runs every line of a shader for every pixel,
// stone or not, but a loop's body only once more than it goes round.
vec3 leave(vec3 d, vec3 n, float cosI, mat3 toWorld) {
  vec3 e0 = vec3(0.0), e3 = vec3(0.0), sum = vec3(0.0);
  bool split = false;
  int count = 2;
  for (int j = 0; j < count; j++) {
    // Red, violet, then the two between.
    float at = j == 0 ? -1.5 : j == 1 ? 1.5 : j == 2 ? -0.5 : 0.5;
    vec3 e = transmit(d, n, cosI, uIor + at * uFire, toWorld);
    sum += (j == 0 ? W0 : j == 1 ? W3 : j == 2 ? W1 : W2) * e;
    if (j == 0) e0 = e;
    if (j == 1) {
      e3 = e;
      float l0 = luma(e0), l3 = luma(e3);
      // Both ends of the spectrum see the same: no split, skip the middle.
      split = abs(l0 - l3) >= 0.02 + 0.04 * (l0 + l3);
      if (split) count = 4;
    }
  }
  return split ? sum : 0.5 * (e0 + e3);
}

// The light's path through the stone, from just inside the entry facet:
// out through a facet where it can, mirrored back in where it cannot.
vec3 trace(vec3 p, vec3 d, mat3 toWorld) {
  vec3 through = vec3(1.0);
  vec3 light = vec3(0.0);
  vec3 n;
  float i0 = uIor - 1.5 * uFire;
  for (int k = 0; k < 4; k++) {
    float t = exitFacet(p, d, n);
    p += d * t;
    through *= exp(-uSigma * t);
    // The red end bends least, so if it is trapped every colour is: then
    // the facet is a perfect mirror and nothing leaves. Otherwise its
    // reflectance is what stays inside.
    float cosI = dot(d, n);
    float k0 = 1.0 - i0 * i0 * (1.0 - cosI * cosI);
    float f = 1.0;
    if (k0 > 0.0) {
      f = reflectance(cosI, sqrt(k0), i0);
      light += through * leave(d, n, cosI, toWorld);
    }
    through *= f;
    d = reflect(d, n);
    if (max(through.r, max(through.g, through.b)) < 0.03) break;
  }
  // Whatever is still trapped leaks out roughly the way it is heading.
  light += through * env(toWorld * d) * 0.6;
  return light;
}

// Whether a pixel at q from a star (in units of its reach) is near its
// core or one of its rays.
bool nearStar(vec2 q) {
  vec2 aq = abs(q);
  vec2 dq = abs(vec2(q.x + q.y, q.x - q.y));
  return dot(q, q) <= 0.09 || min(aq.x, aq.y) <= 0.012 || min(dq.x, dq.y) <= 0.01 / 0.7071;
}

// A four-pointed star seen at q from its centre, its rays tinted by hue.
vec3 star(vec2 q, float hue) {
  vec2 aq = abs(q);
  vec2 dq = abs(vec2(q.x + q.y, q.x - q.y)) * 0.7071;
  float dist = length(q);
  float core = exp(-dist * dist * 1400.0) * 4.0 + exp(-dist * 30.0) * 0.35;
  // Each ray is narrow across and long along: one exponential of both.
  float rays = exp(-aq.y * 700.0 - aq.x * 7.0) + exp(-aq.x * 700.0 - aq.y * 7.0);
  rays += 0.4 * (exp(-dq.y * 900.0 - dq.x * 12.0) + exp(-dq.x * 900.0 - dq.y * 12.0));
  // Rays break into a faint spectrum towards their tips.
  vec3 tint = 0.65 + 0.35 * cos(6.2832 * (dist * 3.0 + hue + vec3(0.0, 0.33, 0.67)));
  return core + rays * tint * 1.6;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  float focal = 0.5 * uSize * DIST / uBound;
  float px = 1.0 / min(uResolution.x, uResolution.y);

  // Orientation, worked out once per frame on the CPU along with the glints.
  mat3 toWorld = mat3(uRot[0].xyz, uRot[1].xyz, uRot[2].xyz);
  mat3 toObject = transpose(toWorld);

  vec3 roW = vec3(0.0, 0.0, DIST);
  vec3 rayW = vec3(uv, -focal);
  vec3 lift = vec3(0.0, uLift, 0.0);
  vec3 ro = toObject * roW + lift;
  // The ray unnormalised, r, steps s = t / |r| along it: the planes are
  // met in the same order, so entry needs no normalising.
  vec3 r = toObject * rayW;
  vec3 rd = r * inversesqrt(dot(rayW, rayW));

  vec3 colour = vec3(0.0);
  float cover = 0.0;

  // Bounding sphere first: most of the canvas never touches the stone.
  vec3 oc = ro - lift;
  float b = dot(oc, rd);
  float disc = b * b - dot(oc, oc) + uBound * uBound;
  if (disc > 0.0) {
    // Entry is the last plane the ray crosses inwards, exit the first it
    // crosses outwards. Seen from the camera each plane is an affine
    // function of the pixel (uEntry, set per frame), and the steps along
    // the ray are compared as fractions kept whole: no division per plane.
    // A plane's mirror in z differs from it by its own nz times terms the
    // same for every plane: its normal against the ray by -nz * zr, the
    // camera's distance inside it by nz * uMirror.w.
    float inNum = 1e9, inDen = -1.0, outNum = 1e9, outDen = 1.0;
    int at = -1;
    float zr = dot(uMirror.xy, uv) + uMirror.z;
    // Four at a time, as in exitFacet; zero entries past the last change nothing.
    for (int i = 0; i < int(uPlaneCount); i += 4) {
      for (int k = 0; k < 4; k++) {
        vec4 e = uEntry[i + k];
        float nz = uPlanes[i + k].z;
        float den = dot(e.xy, uv) + e.z;
        crossing(den, e.w, 2 * (i + k), inNum, inDen, at, outNum, outDen);
        crossing(den - nz * zr, e.w + nz * uMirror.w, 2 * (i + k) + 1, inNum, inDen, at, outNum, outDen);
      }
    }
    float sIn = inNum / inDen, sOut = outNum / outDen;
    vec3 nIn = at >= 0 ? facetNormal(at) : vec3(0.0, 1.0, 0.0);
    if (uGirdle.x > 0.0) {
      vec2 q = ro.xz / uGirdle, v = r.xz / uGirdle;
      float a = dot(v, v), b = dot(q, v), c = dot(q, q) - 1.0;
      float h = b * b - a * c;
      if (h < 0.0) sOut = -1e9;
      else {
        h = sqrt(h);
        float s0 = (-b - h) / a;
        sOut = min(sOut, (-b + h) / a);
        if (s0 > sIn) {
          sIn = s0;
          vec2 g = (ro.xz + r.xz * s0) / (uGirdle * uGirdle);
          nIn = normalize(vec3(g.x, 0.0, g.y));
        }
      }
    }
    // The gap between entry and exit, against a pixel's width there, gives
    // a soft edge to the silhouette.
    float gap = (sOut - sIn) / (px * sIn / focal);
    if (gap > 0.0 && sIn > 0.0) {
      cover = clamp(gap * 0.5, 0.0, 1.0);
      vec3 p = ro + r * sIn;
      float cosI = -dot(rd, nIn);
      float f = fresnel(cosI, 1.0 / uIor);
      // The surface mirror: crisp reflections on the facets.
      vec3 surface = env(toWorld * reflect(rd, nIn)) * f;
      vec3 inner = trace(p, refract(rd, nIn, 1.0 / uIor), toWorld);
      colour = surface + inner * (1.0 - f);
    }
  }

  // Glints: facets that mirror a light straight at the camera flare into
  // four-pointed stars, the way a real stone's sparkle catches a lens. Which
  // facets flash, and how brightly, is found on the CPU each frame.
  vec3 flare = vec3(0.0);
  float reach = 1.0 / (uSize * 0.9);
  // Most of the canvas is nowhere near a star's core or its rays: a cheap
  // test notes the few stars near this pixel, then only those are drawn. A
  // GPU skipped the far ones anyway; a software renderer, which runs a loop
  // body once more than it goes round whatever the branches inside, now
  // runs the costly one once or twice instead of once per star.
  ivec4 near = ivec4(0);
  int found = 0;
  for (int i = 0; i < int(uFlareCount); i++) {
    if (!nearStar(uv * reach - uFlares[i].xy)) continue;
    if (found < 4) near[found] = i;
    found++;
  }
  // More than four near at once: all of them, each tested again.
  int todo = found > 4 ? int(uFlareCount) : found;
  for (int k = 0; k < todo; k++) {
    vec4 f = uFlares[found > 4 ? k : near[k]];
    vec2 q = uv * reach - f.xy;
    if (nearStar(q)) flare += f.z * star(q, f.w);
  }

  // Tone: soft shoulder per channel so bright light whitens, fire stays rich.
  colour = 1.0 - exp(-colour * 1.1);
  flare = 1.0 - exp(-flare);
  vec3 bg = uBackground * (1.0 - uTransparent);
  vec3 lin = colour * cover + bg * (1.0 - cover);
  lin = lin + flare * (1.0 - lin);
  float alpha = mix(1.0, clamp(cover + max(max(flare.r, flare.g), flare.b), 0.0, 1.0), uTransparent);
  vec3 outc = linearToSrgb(lin);
  outc += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * alpha;
  fragColor = vec4(outc, alpha);
}
`;

// ---------------------------------------------------------------------------
// Cuts. Each is a convex solid: a list of planes (outward normal and distance)
// plus glint anchors (a point on a crown facet and its normal). The stone
// sits with its girdle in the xz plane and its table facing +y.

const DEG = Math.PI / 180;

/**
 * @typedef {{ planes: number[], glints: number[], bound: number, lift: number, girdle: number[], groups: number[], groups2: number[] }} Cut
 */

/** @param {number[]} list @param {number[]} n @param {number[]} p Point on the plane. */
function plane(list, n, p) {
  const l = Math.hypot(n[0], n[1], n[2]);
  const x = n[0] / l, y = n[1] / l, z = n[2] / l;
  list.push(x, y, z, x * p[0] + y * p[1] + z * p[2]);
}

/**
 * A facet tilted `tilt` from horizontal, facing azimuth `phi`, through the
 * point at distance `r` along `phi` and height `y`.
 * @param {number[]} list @param {number} phi @param {number} tilt @param {number} r @param {number} y @param {boolean} [down] On the pavilion.
 */
function facet(list, phi, tilt, r, y, down = false) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const n = [Math.sin(tilt) * c, (down ? -1 : 1) * Math.cos(tilt), Math.sin(tilt) * s];
  plane(list, n, [r * c, y, r * s]);
  return n;
}

/** Height of a facet plane above the point at distance `r` along `phi`. */
function heightOn(/** @type {number[]} */ list, /** @type {number} */ i, /** @type {number} */ r, /** @type {number} */ phi) {
  const [x, y, z, h] = list.slice(i * 4, i * 4 + 4);
  return (h - x * r * Math.cos(phi) - z * r * Math.sin(phi)) / y;
}

/**
 * Measures the solid by probing vertical lines through it, then returns it
 * centred: the vertical middle of the stone, and a sphere that holds it.
 * @param {number[]} planes @param {number[]} glints @param {number} reach Widest support.
 * @param {number[]} [girdle] Radii of a smooth elliptical girdle, if it has one.
 * @returns {Cut}
 */
function finish(planes, glints, reach, girdle = [0, 0]) {
  let lo = Infinity, hi = -Infinity;
  /** @type {number[][]} */ const ends = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = (i / n * 2 - 1) * reach, z = (j / n * 2 - 1) * reach;
      let a = -Infinity, b = Infinity;
      if (girdle[0] > 0 && (x / girdle[0]) ** 2 + (z / girdle[1]) ** 2 > 1) continue;
      for (let k = 0; k < planes.length; k += 4) {
        const [nx, ny, nz, h] = planes.slice(k, k + 4);
        const rest = h - nx * x - nz * z;
        if (Math.abs(ny) < 1e-6) { if (rest < 0) { b = -Infinity; break; } }
        else if (ny > 0) b = Math.min(b, rest / ny);
        else a = Math.max(a, rest / ny);
      }
      if (!(a < b)) continue;
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
      ends.push([x, a, z], [x, b, z]);
    }
  }
  const lift = (lo + hi) / 2;
  let bound = 0;
  for (const [x, y, z] of ends) bound = Math.max(bound, Math.hypot(x, y - lift, z));
  // Sort crown, girdle, pavilion, and note how shallow each group gets.
  /** @type {number[][]} */ const list = [];
  for (let k = 0; k < planes.length; k += 4) list.push(planes.slice(k, k + 4));
  const group = (/** @type {number[]} */ p) => (p[1] > 1e-3 ? 0 : p[1] < -1e-3 ? 2 : 1);
  list.sort((a, b) => group(a) - group(b));
  const crown = list.filter((p) => group(p) === 0);
  const up = Math.min(...crown.map((p) => p[1]));
  const down = Math.min(...list.filter((p) => group(p) === 2).map((p) => -p[1]));
  // Keep one of each mirror pair in z (the shader makes the other); a plane
  // facing along x is its own mirror, and the shader simply tries it twice.
  const flat = (/** @type {number[]} */ p) => Math.abs(p[2]) < 1e-9;
  const mirror = (/** @type {number[]} */ p) => [p[0], p[1], -p[2], p[3]];
  const half = list.filter((p) => p[2] > 0 || flat(p));
  for (const p of half) {
    const m = mirror(p);
    if (!flat(p) && !list.some((q) => q.every((v, i) => Math.abs(v - m[i]) < 1e-6))) throw new Error('diamond: a cut is not symmetric front to back');
  }
  const before = (/** @type {number} */ g) => half.filter((p) => group(p) < g).length;
  return {
    planes: half.flat(),
    glints,
    bound: bound + 0.02,
    lift,
    girdle,
    // Where the girdle starts, rounded down to the shader's groups of four.
    groups: [up, Math.sqrt(1 - up * up) + 1e-3, before(1) - (before(1) % 4)],
    groups2: [down, Math.sqrt(1 - down * down) + 1e-3, before(2)],
  };
}

/**
 * A brilliant pattern over any convex outline, given as its support function
 * (how far the outline reaches in each direction): table, eight bezels, eight
 * stars, sixteen upper girdles, a girdle, eight pavilion mains and sixteen
 * lower girdles. Round brilliant proportions: table 56%, crown 34.5°,
 * pavilion 40.8°.
 * @param {(phi: number) => number} support
 * @param {number | number[]} girdle Number of flat sides, or the radii of a smooth elliptical girdle.
 * @param {number} [girdleTurn] Turns the girdle's flats, in fractions of a side.
 * @returns {Cut}
 */
function brilliant(support, girdle, girdleTurn = 0.5) {
  const girdleSides = typeof girdle === 'number' ? girdle : 0;
  const g = 0.02;
  const crown = 34.5 * DEG, pavilion = 40.8 * DEG;
  /** @type {number[]} */ const planes = [];
  /** @type {number[]} */ const glints = [];
  let dmin = Infinity, dmax = 0;
  for (let i = 0; i < 360; i++) {
    const d = support(i * DEG);
    dmin = Math.min(dmin, d);
    dmax = Math.max(dmax, d);
  }
  const top = g + 0.44 * dmin * Math.tan(crown);
  /** @param {number[]} p @param {number[]} n */
  const glint = (p, n) => glints.push(p[0], p[1], p[2], 0, n[0], n[1], n[2], 0);

  plane(planes, [0, 1, 0], [0, top, 0]);
  glint([0.1 * dmin, top, -0.15 * dmin], [0, 1, 0]);
  glint([-0.2 * dmin, top, 0.1 * dmin], [0, 1, 0]);
  for (let k = 0; k < 8; k++) {
    const phi = k * 45 * DEG;
    const d = support(phi);
    const i = planes.length / 4;
    const n = facet(planes, phi, crown, d, g);
    // Halfway up the bezel.
    const r = d - 0.5 * (top - g) / Math.tan(crown);
    glint([r * Math.cos(phi), heightOn(planes, i, r, phi), r * Math.sin(phi)], n);
  }
  // Stars: shallow facets from each corner of the table.
  for (let k = 0; k < 8; k++) {
    const phi = (k + 0.5) * 45 * DEG;
    const ra = support(phi - 22.5 * DEG) - (top - g) / Math.tan(crown);
    const rb = support(phi + 22.5 * DEG) - (top - g) / Math.tan(crown);
    const r = (0.5 * (ra + rb)) / Math.cos(22.5 * DEG);
    const n = facet(planes, phi, 21 * DEG, r, top);
    const rg = r + 0.12 * dmin;
    glint([rg * Math.cos(phi), top - 0.12 * dmin * Math.tan(21 * DEG), rg * Math.sin(phi)], n);
  }
  // Upper girdle facets, either side of each star.
  for (let k = 0; k < 16; k++) {
    const phi = (k + 0.5) * 22.5 * DEG;
    const d = support(phi);
    const i = planes.length / 4;
    const n = facet(planes, phi, 39 * DEG, d, g);
    const r = d - 0.05 * dmin;
    if (k % 2 === 0) glint([r * Math.cos(phi), heightOn(planes, i, r, phi), r * Math.sin(phi)], n);
  }
  for (let k = 0; k < girdleSides; k++) {
    const phi = (k + girdleTurn) * (360 / girdleSides) * DEG;
    const d = support(phi);
    plane(planes, [Math.cos(phi), 0, Math.sin(phi)], [d * Math.cos(phi), 0, d * Math.sin(phi)]);
  }
  // Pavilion mains all meet at one culet, so on a long or square outline
  // each is as steep as its reach needs; lower girdles a touch steeper.
  const depth = g + Math.tan(pavilion) * Math.sqrt(dmin * dmax);
  for (let k = 0; k < 8; k++) {
    const phi = k * 45 * DEG;
    facet(planes, phi, Math.atan((depth - g) / support(phi)), 0, -depth, true);
  }
  for (let k = 0; k < 16; k++) {
    const phi = (k + 0.5) * 22.5 * DEG;
    const d = support(phi);
    facet(planes, phi, Math.atan((depth - g) / d) + 0.8 * DEG, d, -g, true);
  }
  return finish(planes, glints, dmax, typeof girdle === 'number' ? undefined : girdle);
}

/**
 * A step cut over an octagon (a rectangle with clipped corners): rows of
 * long facets parallel to the girdle, like stairs, on crown and pavilion.
 * @param {number} a Half length. @param {number} b Half width. @param {number} clip Corner cut.
 * @returns {Cut}
 */
function step(a, b, clip) {
  const g = 0.02;
  /** @type {number[]} */ const planes = [];
  /** @type {number[]} */ const glints = [];
  const sides = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
    const phi = deg * DEG;
    const c = Math.cos(phi), s = Math.sin(phi);
    const d = deg % 90 === 0 ? (deg % 180 === 0 ? a : b) : (a + b) * Math.SQRT1_2 - clip;
    return { phi, d, c, s };
  });
  for (const { c, s, d } of sides) plane(planes, [c, 0, s], [d * c, 0, d * s]);
  // Crown: three steps, steeper at the girdle, shallower towards the table.
  const crown = [
    [48, 0.1],
    [36, 0.1],
    [24, 0.1],
  ];
  let y = g;
  let inset = 0;
  for (const [deg, w] of crown) {
    for (const { phi, d } of sides) {
      const i = planes.length / 4;
      const n = facet(planes, phi, deg * DEG, d - inset, y);
      const r = d - inset - w * 0.5;
      glints.push(r * Math.cos(phi), heightOn(planes, i, r, phi), r * Math.sin(phi), 0, n[0], n[1], n[2], 0);
    }
    y += w * Math.tan(deg * DEG);
    inset += w;
  }
  plane(planes, [0, 1, 0], [0, y, 0]);
  glints.push(0.2, y, 0.05, 0, 0, 1, 0, 0, -0.3, y, -0.1, 0, 0, 1, 0, 0);
  // Pavilion: four steps falling to a keel.
  const pav = [
    [56, 0.16],
    [48, 0.16],
    [42, 0.16],
    [36, 1],
  ];
  y = -g;
  inset = 0;
  for (const [deg, w] of pav) {
    for (const { phi, d } of sides) facet(planes, phi, deg * DEG, d - inset, y, true);
    y -= w * Math.tan(deg * DEG);
    inset += w;
  }
  return finish(planes, glints, Math.max(a, b));
}

/** Support function of an ellipse. */
const ellipse = (/** @type {number} */ a, /** @type {number} */ b) => (/** @type {number} */ phi) => Math.hypot(a * Math.cos(phi), b * Math.sin(phi));

/** @type {Record<DiamondOptions['cut'], Cut>} */
const CUTS = {
  round: brilliant(() => 1, [1, 1]),
  oval: brilliant(ellipse(1.18, 0.84), [1.18, 0.84]),
  // A teardrop: the outline round a circle and a point beyond it.
  pear: brilliant((phi) => Math.max(0.82 - 0.22 * Math.cos(phi), 1.18 * Math.cos(phi)), 24),
  // A square, its corners just softened by the diagonal girdle flats.
  princess: brilliant((phi) => Math.min(0.76 * (Math.abs(Math.cos(phi)) + Math.abs(Math.sin(phi))), 1.03), 8, 0),
  emerald: step(1.12, 0.78, 0.16),
};

/** Packed once per cut, so changing options never allocates per frame. */
const PACKED = Object.fromEntries(
  Object.entries(CUTS).map(([key, cut]) => {
    const planes = new Float32Array(MAX_PLANES * 4);
    planes.set(cut.planes.slice(0, MAX_PLANES * 4));
    if (cut.planes.length > MAX_PLANES * 4) throw new Error(`diamond: the ${key} cut has too many facets`);
    planes.set(cut.planes);
    return [key, { planes, count: cut.planes.length / 4, glints: Float32Array.from(cut.glints), bound: cut.bound, lift: cut.lift, girdle: cut.girdle, groups: cut.groups, groups2: cut.groups2 }];
  }),
);

// ---------------------------------------------------------------------------
// Lighting. Each light is a softbox: direction it lies in, its half size
// (as a tangent), and colour times brightness, all in world space where the
// camera looks down -z.

/** @typedef {[number, number, number, number, number]} Light x, y, z of its direction, half width, half height (tangents) */

// One layout of softboxes for every style, scattered around the stone and
// mostly in front, so its facets show a mosaic of light and dark.
/** @type {Light[]} */
const LAYOUT = [
  [0, 1, 0.1, 0.22, 0.1],
  [-1, 0.2, 0.4, 0.05, 0.8],
  [1, 0.1, 0.4, 0.05, 0.8],
  [-0.45, 0.6, 0.8, 0.12, 0.12],
  [0.5, 0.45, 0.8, 0.1, 0.18],
  [0, -0.45, 1, 0.3, 0.04],
  [-0.7, -0.2, 0.7, 0.08, 0.08],
  [0.75, -0.35, 0.6, 0.06, 0.1],
  [-0.5, 0.4, -0.8, 0.2, 0.1],
  [0.6, 0.1, -0.8, 0.05, 0.4],
  [0.1, 0.8, -0.6, 0.25, 0.05],
  [0.15, 0.15, 1, 0.05, 0.05],
];

/**
 * @param {number} scale Softbox size.
 * @param {(i: number) => number[]} colour Linear colour times brightness of light i.
 * @param {number[]} top Ambient light from above. @param {number[]} bottom From below.
 * @param {number[]} ring Ring light round the camera: colour times brightness, and how many segments.
 */
function rig(scale, colour, top, bottom, ring) {
  const dir = new Float32Array(LIGHTS * 4);
  const right = new Float32Array(LIGHTS * 4);
  const up = new Float32Array(LIGHTS * 4);
  const col = new Float32Array(LIGHTS * 4);
  const glow = new Float32Array(LIGHTS);
  LAYOUT.forEach(([x, y, z, w, h], i) => {
    const l = Math.hypot(x, y, z);
    const n = [x / l, y / l, z / l];
    // Horizontal axis: up × n, then the vertical one completes the frame.
    const rl = Math.hypot(n[2], n[0]) || 1;
    const r = [n[2] / rl, 0, -n[0] / rl];
    const u = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
    dir.set(n, i * 4);
    // The softbox lights only directions within 1.04 of its half size on
    // each axis (its soft edge), so within this cone round its direction;
    // a hair wider, so rounding never clips it.
    dir[i * 4 + 3] = 1 / Math.hypot(1, 1.05 * scale * Math.hypot(w, h));
    right.set(r.map((v) => v / (w * scale)), i * 4);
    up.set(u.map((v) => v / (h * scale)), i * 4);
    const c = colour(i);
    col.set(c, i * 4);
    // How bright the light looks in a glint.
    glow[i] = Math.min(1, (c[0] + c[1] + c[2]) / 9);
  });
  // Which lights each octant of directions can see: a light's cone lies
  // wholly on one side of an axis plane when its direction's component
  // along that axis exceeds the sine of its half angle.
  const octant = new Float32Array(32).fill(-1);
  for (let i = 0; i < LIGHTS; i++) {
    const sin = Math.sqrt(1 - dir[i * 4 + 3] ** 2);
    const sides = [0, 1, 2].map((k) => (dir[i * 4 + k] > sin ? [1] : dir[i * 4 + k] < -sin ? [0] : [0, 1]));
    for (const x of sides[0]) for (const y of sides[1]) for (const z of sides[2]) {
      const o = (x + 2 * y + 4 * z) * 4;
      const slot = octant.subarray(o, o + 4).indexOf(-1);
      if (slot < 0) throw new Error('diamond: more than four lights in one octant');
      octant[o + slot] = i;
    }
  }
  return { dir, glow, uniforms: { uOctant: octant, uLightDir: dir, uLightRight: right, uLightUp: up, uLightCol: col, uAmbientTop: top, uAmbientBottom: bottom, uRing: ring } };
}

const HUES = ['#ff3d9a', '#2fc8ff', '#ffd36b', '#7a5bff', '#40ffb0', '#ff7a3d'].map((hex) => linear(hex));

const RIGS = {
  studio: rig(1, (i) => Array(3).fill(i === 0 || i > 7 ? 4 : 6), [0.035, 0.035, 0.04], [0, 0, 0], [3, 3, 3, 6]),
  dark: rig(0.35, (i) => Array(3).fill(i % 3 === 1 ? 0 : 22), [0.002, 0.002, 0.003], [0, 0, 0], [6, 6, 6, 3]),
  bright: rig(1.3, (i) => Array(3).fill(i === 0 || i > 7 ? 5 : 7), [0.55, 0.55, 0.57], [0.12, 0.12, 0.12], [2, 2, 2, 6]),
  coloured: rig(1.1, (i) => HUES[i % HUES.length].map((c) => c * 6 + 0.4), [0.02, 0.01, 0.035], [0, 0, 0.006], [4, 2.5, 5, 6]),
};

/** @type {import('./runtime.js').EffectSpec<DiamondOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    // The pointer helper's eased values, caught on their way to the shader:
    // the orientation and glints are worked out here, once per frame.
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
    const p = pointer(tap, { ease: 3 });
    const rot = new Float32Array(12);
    const entry = new Float32Array(MAX_PLANES * 4);
    const mirror = new Float32Array(4);
    const flares = new Float32Array(MAX_FLARES * 4);
    // Scratch for the brightest glints this frame: power and index.
    const best = new Float32Array(MAX_FLARES * 2);
    return {
      destroy: p.destroy,
      frame(dt, time) {
        p.frame(dt);
        const o = /** @type {DiamondOptions} */ (/** @type {unknown} */ (ctx.options?.() ?? defaults));
        const cut = PACKED[o.cut] ?? PACKED.round;
        const lights = RIGS[o.lighting] ?? RIGS.studio;
        const on = o.interactive ? look[2] : 0;
        // A slow turn about the stone's axis, tilted towards the camera so
        // the table shows; the pointer tips and turns it further.
        const yaw = time * 0.5 + (look[0] - 0.5) * on * 2.4;
        const pitch = 1.12 + 0.14 * Math.sin(time * 0.31) + (look[1] - 0.5) * on * 1.4;
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
        // rotX(pitch) * rotY(yaw), column by column.
        rot[0] = cy; rot[1] = sx * sy; rot[2] = -cx * sy;
        rot[4] = 0; rot[5] = cx; rot[6] = sx;
        rot[8] = sy; rot[9] = -sx * cy; rot[10] = cx * cy;
        ctx.uniform('uRot', rot);

        // Each plane as the camera sees it: for the pixel's ray (uv, -focal)
        // in world space, the plane's normal against the ray is
        // uv · (x, y) + z, and w is the camera's distance inside the plane.
        // That leaves two multiply-adds per plane per pixel for the entry.
        const focal = (0.5 * o.size * DIST) / cut.bound;
        const ox = DIST * rot[2], oy = DIST * rot[6] + cut.lift, oz = DIST * rot[10];
        // A plane's mirror in z has nz negated: its normal against the ray
        // drops by 2 nz times the object's z axis against it, and the
        // camera's distance inside it grows by 2 nz oz.
        mirror[0] = 2 * rot[8];
        mirror[1] = 2 * rot[9];
        mirror[2] = -2 * rot[10] * focal;
        mirror[3] = 2 * oz;
        ctx.uniform('uMirror', mirror);
        for (let i = 0; i < cut.count * 4; i += 4) {
          const nx = cut.planes[i], ny = cut.planes[i + 1], nz = cut.planes[i + 2];
          entry[i] = rot[0] * nx + rot[4] * ny + rot[8] * nz;
          entry[i + 1] = rot[1] * nx + rot[5] * ny + rot[9] * nz;
          entry[i + 2] = -(rot[2] * nx + rot[6] * ny + rot[10] * nz) * focal;
          entry[i + 3] = cut.planes[i + 3] - (nx * ox + ny * oy + nz * oz);
        }
        // Clear what a bigger cut left behind: the shader reads in fours.
        entry.fill(0, cut.count * 4);
        ctx.uniform('uEntry', entry);

        // Glints: each crown facet mirrors the lights; the brightest few,
        // as seen from the camera, flare.
        best.fill(0);
        const g = cut.glints;
        for (let i = 0; i < g.length; i += 8) {
          const px = g[i], py = g[i + 1] - cut.lift, pz = g[i + 2];
          const ax = rot[0] * px + rot[4] * py + rot[8] * pz;
          const ay = rot[1] * px + rot[5] * py + rot[9] * pz;
          const az = rot[2] * px + rot[6] * py + rot[10] * pz;
          const nx = rot[0] * g[i + 4] + rot[4] * g[i + 5] + rot[8] * g[i + 6];
          const ny = rot[1] * g[i + 4] + rot[5] * g[i + 5] + rot[9] * g[i + 6];
          const nz = rot[2] * g[i + 4] + rot[6] * g[i + 5] + rot[10] * g[i + 6];
          let vx = -ax, vy = -ay, vz = DIST - az;
          const vl = Math.hypot(vx, vy, vz);
          vx /= vl; vy /= vl; vz /= vl;
          const nv = nx * vx + ny * vy + nz * vz;
          if (nv < 0.05) continue;
          // The view ray mirrored by the facet.
          const rx = 2 * nv * nx - vx, ry = 2 * nv * ny - vy, rz = 2 * nv * nz - vz;
          let power = 0;
          for (let l = 0; l < LIGHTS; l++) {
            const c = rx * lights.dir[l * 4] + ry * lights.dir[l * 4 + 1] + rz * lights.dir[l * 4 + 2];
            if (c > 0.97) power += lights.glow[l] * c ** 300;
          }
          // A flicker per facet, so neighbours never flash in step.
          power *= 0.65 + 0.35 * Math.sin(time * 3.1 + i * 0.61);
          // Keep the brightest few, smallest first out.
          let slot = -1;
          let low = power;
          for (let k = 0; k < MAX_FLARES; k++) if (best[k * 2] < low) { low = best[k * 2]; slot = k; }
          if (slot >= 0) { best[slot * 2] = power; best[slot * 2 + 1] = i; }
        }
        let count = 0;
        for (let k = 0; k < MAX_FLARES; k++) {
          const power = best[k * 2] * o.sparkle;
          if (power < 0.01) continue;
          const i = best[k * 2 + 1];
          const px = g[i], py = g[i + 1] - cut.lift, pz = g[i + 2];
          const ax = rot[0] * px + rot[4] * py + rot[8] * pz;
          const ay = rot[1] * px + rot[5] * py + rot[9] * pz;
          const az = rot[2] * px + rot[6] * py + rot[10] * pz;
          const scale = focal / (DIST - az);
          // Where the star sits, in units of its reach (see the shader).
          flares[count * 4] = (ax * scale) / (o.size * 0.9);
          flares[count * 4 + 1] = (ay * scale) / (o.size * 0.9);
          flares[count * 4 + 2] = power;
          flares[count * 4 + 3] = i * 0.137;
          count++;
        }
        ctx.uniform('uFlares', flares);
        ctx.uniform('uFlareCount', count);
      },
    };
  },
  dpr: 1.5,
  time: 2,
  speed: (o) => o.speed,
  // Always an alpha canvas, so the backdrop can switch off without remounting.
  alpha: true,
  update(o) {
    const cut = PACKED[o.cut] ?? PACKED.round;
    const tint = linear(o.tint);
    // Beer-Lambert: the tint is the colour after about one stone's width.
    const sigma = tint.map((c) => -Math.log(Math.max(c, 0.003)) * 0.6);
    return {
      uPlanes: cut.planes,
      uPlaneCount: cut.count,
      uGirdle: cut.girdle,
      uGroups: cut.groups,
      uGroups2: cut.groups2,
      uBound: cut.bound,
      uLift: cut.lift,
      uSigma: sigma,
      uIor: o.brilliance,
      uFire: o.fire * 0.045,
      uSize: o.size,
      ...(RIGS[o.lighting] ?? RIGS.studio).uniforms,
      uBackground: linear(o.background),
      uTransparent: !o.showBackground,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<DiamondOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function diamond(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
