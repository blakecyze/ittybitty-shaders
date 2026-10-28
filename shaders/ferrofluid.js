// @ts-check
/**
 * ittybitty/ferrofluid
 *
 * A glossy pool of magnetic fluid on a studio floor. Bring the pointer (the
 * magnet) near and the fluid gathers into a mound that bristles into a crown
 * of sharp cones, each leaning towards the magnet; move away and they melt
 * back into the pool. Clicking surges the field for a moment. With no
 * pointer, a wandering magnet pulses the crown up and down on its own.
 *
 * It is a heightfield, raymarched inside the thin slab the fluid can occupy,
 * so the march is short; pixels whose ray never comes near the pool skip it,
 * and rays that miss the magnet's reach march only the pool's shallow layer.
 * The surface is a mirror for a procedural studio of softboxes, neon tubes or
 * a sunset sky.
 *
 * https://ittybitty.dev/shaders/ferrofluid (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} FerrofluidOptions
 * @property {boolean} showBackground The floor under the pool. Off, only the fluid and its shadow are drawn, over the page.
 * @property {number} speed How fast the idle magnet wanders and the pool breathes.
 * @property {number} spikes How tall the spikes grow.
 * @property {number} density How closely the spikes pack, 0 to 1.
 * @property {number} strength How strongly the magnet pulls the fluid.
 * @property {number} reach How far the magnet's pull spreads.
 * @property {boolean} interactive The pointer is the magnet, and a click surges it.
 * @property {number} responsiveness How quickly the fluid follows the pointer, 0 to 1. Lower feels thicker.
 * @property {string} fluid Colour of the fluid.
 * @property {number} mirror How metallic the surface is: 0 is glossy black ink, 1 is a tinted mirror.
 * @property {number} iridescence Oily rainbow sheen in the reflections.
 * @property {'studio' | 'neon' | 'sunset'} environment What the surface reflects.
 * @property {string} light Colour of the main light in the reflections.
 * @property {string} background Colour of the floor.
 */

/** @type {FerrofluidOptions} */
export const defaults = {
  showBackground: true,
  speed: 0.5,
  spikes: 0.75,
  density: 0.5,
  strength: 0.8,
  reach: 0.7,
  interactive: true,
  responsiveness: 0.4,
  fluid: '#0a0a0c',
  mirror: 0,
  iridescence: 0.1,
  environment: 'studio',
  light: '#fff4e6',
  background: '#d6d3ce',
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
uniform float uSpikes;      // spike height, world units
uniform float uSpacing;     // distance between spikes
uniform vec3 uFluid;        // linear RGB
uniform float uMirror;
uniform float uIridescence;
uniform float uEnv;         // 0 studio, 1 neon, 2 sunset
uniform vec3 uLight;
uniform vec3 uBackground;
uniform float uTransparent;
uniform float uBurst;       // seconds since the last click
// Per-frame state, worked out once on the CPU rather than for every pixel.
uniform vec2 uMagnet;       // where the fluid gathers (eased, viscous)
uniform vec2 uAim;          // where the spikes point (the pointer itself)
uniform float uPull;        // magnet strength now, with the click surge
uniform float uReachNow;    // radius of the pull now, with the click surge
uniform float uRing;        // height of the click's ring, 0 once it has died away
uniform vec4 uPoolA;        // centres of the pool's discs, in pool() space: 1 and 2
uniform vec4 uPoolB;        // 3 and 4
uniform vec4 uPoolC;        // 5, and the magnet
uniform vec2 uPoolShift;    // the pool's drift towards the magnet
uniform float uPoolMagnet;  // radius of the fluid drawn in under the magnet, in pool() space

out vec4 fragColor;

const float POOL = 0.05;    // resting depth of the pool
const float MOUND = 0.2;   // how high the fluid heaps under the magnet

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Filmic curve for the fluid's highlights (Narkowicz's ACES fit).
vec3 tonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float gEnvelope;  // set by height(): the most the spikes there could reach
float gSteep;     // set by height(): the steepest the surface there can be

// Signed distance to the edge of the pool, in the floor plane: a few slow,
// wobbling discs melted together, plus fluid drawn in under the magnet.
// The discs' wobble is worked out once a frame, on the CPU.
float pool(vec2 p) {
  float t = uTime * 0.25;
  p = (p - uPoolShift) * 1.32;
  float d = length(p - uPoolA.xy) - 0.82;
  d = smin(d, length(p - uPoolA.zw) - 0.5, 0.45);
  d = smin(d, length(p - uPoolB.xy) - 0.52, 0.45);
  d = smin(d, length(p - uPoolB.zw) - 0.42, 0.4);
  d = smin(d, length(p - uPoolC.xy) - 0.4, 0.4);
  // The rim breathes with a slow ripple, so it never looks cut out.
  d += 0.03 * sin(p.x * 3.1 + p.y * 1.7 + t * 2.0) * sin(p.y * 3.7 - p.x * 1.3 - t * 1.6);
  d = smin(d, length(p - uPoolC.zw) - uPoolMagnet, 0.5);
  return d / 1.32;
}

// One spike per lattice point: 1 at each tip, 0 in the hollows.
float spike(vec2 p) {
  vec2 q = p * (7.2552 / uSpacing); // 4π/√3 puts neighbours uSpacing apart
  // cos(y) + cos(0.866x - y/2) + cos(-0.866x - y/2), with two cosines.
  float c = cos(0.5 * q.y);
  float w = 2.0 * c * (c + cos(0.8660254 * q.x)) - 1.0;
  float u = clamp((w + 1.5) / 4.5, 0.0, 1.0);
  // Rounded peaks become points; slightly concave flanks below them.
  float a = 1.0 - sqrt(1.0 - u);
  return a * sqrt(a); // a^1.5
}

// Height of the fluid above the floor. A march that is still well above
// the spikes' envelope only needs that, so when the ray at this point is that
// far above, the envelope is returned instead and the spikes are skipped.
float height(vec2 p, float ray, out float edge) {
  // Deep inside the pool, past the bead and where the spikes are full
  // height, the edge's exact distance no longer matters. The middle disc or
  // the magnet's alone can prove a point is that deep (melting more discs
  // in, and the ripple, can only move the edge so far), which is far cheaper
  // than the whole pool.
  vec2 ps = (p - uPoolShift) * 1.32;
  edge = min(length(ps - uPoolA.xy) - 0.79, length(ps - uPoolC.zw) - uPoolMagnet) / 1.32;
  if (edge > -0.14) edge = pool(p);
  gEnvelope = 0.0;
  gSteep = 1.5;
  if (edge > 0.0) return 0.0;
  // Surface tension rounds the rim into a bead, flat across the middle.
  float s = clamp(-edge / 0.09, 0.0, 1.0);
  float h = POOL * (1.0 - (1.0 - s) * (1.0 - s));
  float t = uTime;
  h += 0.004 * s * (sin(p.x * 7.0 + t * 0.9) * sin(p.y * 6.0 - t * 0.7));

  vec2 dm = p - uMagnet;
  float r2 = dot(dm, dm);
  float reach = uReachNow * 1.35;
  // The click sends a ring through the pool.
  if (uRing > 0.0) {
    float ring = length(dm) - uBurst * 1.6;
    h += uRing * s * s * s * exp(-ring * ring * 150.0);
  }
  gEnvelope = h;
  if (r2 > reach * reach) return h;

  // The fluid heaps into a mound under the magnet.
  float m = 1.0 - r2 / (reach * reach);
  h += MOUND * uPull * m * m * s;
  gEnvelope = h;

  // Spikes on a hexagonal lattice, the pattern real ferrofluid settles
  // into. Three crossed waves peak on the lattice with soft saddles between;
  // reshaping the peaks gives each one a conical point.
  float x = sqrt(r2) / uReachNow;
  if (x >= 1.0) return h;
  float f = 1.0 - x * x;
  float tall = uSpikes * uPull * f * sqrt(f) * smoothstep(0.0, -0.14, edge);
  tall *= 1.0 + 0.12 * sin(p.x * 9.0 + t * 1.3) * sin(p.y * 8.0 - t * 1.1);
  gEnvelope = h + tall * 1.08;
  gSteep = 1.5 + 2.4 * tall / uSpacing;
  if (ray - gEnvelope > 0.004) return gEnvelope;
  // Spikes lean towards the pointer, the outer ones most; the lean grows
  // towards the tip, so the bases stay put.
  vec2 toward = uAim - p;
  vec2 lean = toward / (length(toward) + 0.2) * uSpacing * 0.42 * smoothstep(0.05, 0.8, x);
  float c = spike(p);
  c = spike(p - lean * c * c);
  return h + tall * c;
}

float height(vec2 p) {
  float e;
  return height(p, 0.0, e);
}

// Neon tube: a soft glowing bar between two directions on the sky.
float tube(vec3 d, vec3 a, vec3 b, float w) {
  vec3 ab = b - a;
  float t = clamp(dot(d - a, ab) / dot(ab, ab), 0.0, 1.0);
  float e = length(d - a - ab * t);
  return exp(-e * e / (w * w)) + 0.15 * exp(-e / (w * 6.0));
}

// Rounded rectangle light, lit across its face, in a 2D projection.
float box(vec2 p, vec2 size, float soft) {
  vec2 q = abs(p) - size;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, d);
}

// What the surface reflects, in linear HDR.
vec3 environment(vec3 d) {
  float el = d.y;
  float az = atan(d.x, d.z); // 0 towards the camera, ±π behind the pool
  vec3 col;
  if (uEnv < 0.5) {
    // Studio: a dim cove, a large softbox behind the pool that lays a sheet
    // of light across its surface, two overhead panels, and tall strips all
    // round at eye level: the lights that draw a line down every spike.
    col = mix(vec3(0.02), vec3(0.07), smoothstep(-0.2, 0.6, el));
    col += uLight * 0.18 * exp(-abs(el - 0.08) * 8.0);
    col = mix(uBackground * 0.4, col, smoothstep(-0.12, 0.02, el));
    float back = atan(d.x, -d.z);
    col += uLight * 3.0 * box(vec2(abs(back + 0.12) - 0.2, el - 0.62), vec2(0.17, 0.16), 0.012);
    vec2 over = d.xz / max(d.y, 0.05);
    col += uLight * 8.0 * box(over - vec2(-0.25, -0.1), vec2(0.38, 0.24), 0.03) * step(0.0, d.y);
    col += uLight * 5.0 * box(over - vec2(0.55, 0.1), vec2(0.12, 0.42), 0.02) * step(0.0, d.y);
    float strips = box(vec2(abs(az) - 0.55, el - 0.08), vec2(0.05, 0.3), 0.02)
      + box(vec2(abs(az) - 1.55, el - 0.1), vec2(0.08, 0.36), 0.025)
      + 0.6 * box(vec2(abs(az) - 2.4, el - 0.12), vec2(0.06, 0.35), 0.025);
    col += mix(vec3(1.0), uLight, 0.5) * 3.5 * strips;
  } else if (uEnv < 1.5) {
    // Neon: a dark room ringed with coloured tubes. Upright tubes all round
    // draw coloured lines down the spikes; two long ones behind the pool
    // lie across its surface.
    vec3 other = mix(vec3(uLight.b, uLight.r, uLight.g), vec3(0.05, 0.75, 1.0), 0.6);
    float back = atan(d.x, -d.z);
    col = vec3(0.01, 0.008, 0.02) + 0.25 * mix(other, uLight, smoothstep(-1.0, 1.0, d.x)) * exp(-abs(el - 0.1) * 5.0);
    float side = sign(d.x);
    vec3 a = mix(uLight, other, step(0.0, side));
    vec3 b = mix(other, uLight, step(0.0, side));
    float ring = box(vec2(abs(az) - 0.55, el - 0.08), vec2(0.025, 0.32), 0.03);
    float ring2 = box(vec2(abs(az) - 1.5, el - 0.1), vec2(0.03, 0.4), 0.035);
    float ring3 = box(vec2(abs(az) - 2.4, el - 0.12), vec2(0.03, 0.35), 0.035);
    col += 16.0 * (a * ring + b * ring2 + a * ring3);
    col += 2.2 * mix(uLight, other, smoothstep(-0.9, 0.9, back)) * box(vec2(back, el - 0.62), vec2(0.8, 0.22), 0.25);
    col += 14.0 * uLight * box(vec2(back + 0.05, el - 0.55), vec2(0.7, 0.035), 0.025);
    col += 14.0 * other * box(vec2(back - 0.05, el - 0.78), vec2(0.6, 0.035), 0.025);
    vec2 over = d.xz / max(d.y, 0.05);
    col += 10.0 * other * box(over - vec2(-0.4, 0.0), vec2(0.02, 0.6), 0.02) * step(0.0, d.y);
    col += 10.0 * uLight * box(over - vec2(0.4, 0.0), vec2(0.02, 0.6), 0.02) * step(0.0, d.y);
  } else {
    // Sunset: a deep sky warming to the horizon, and a low sun behind the pool.
    vec3 zenith = vec3(0.05, 0.06, 0.22);
    vec3 horizon = uLight * 2.2;
    col = mix(horizon, mix(vec3(0.5, 0.12, 0.3), zenith, smoothstep(0.25, 0.7, el)), smoothstep(0.0, 0.3, el));
    col += uLight * 3.0 * exp(-max(el, 0.0) * 7.0);
    vec3 sun = normalize(vec3(-0.35, 0.5, -1.0));
    float s = max(dot(d, sun), 0.0);
    col += mix(uLight, vec3(1.0), 0.5) * (smoothstep(0.997, 0.998, s) * 40.0 + pow(s, 30.0) * 3.0);
    col = mix(uBackground * 0.2 + horizon * 0.08, col, smoothstep(-0.12, 0.02, el));
  }
  return col;
}

// The earlier of best and where a ray, seen from above (starting at rel from
// a circle's centre, along dir), is first inside the circle past t = from.
float enter(vec2 rel, vec2 dir, float radius, float from, float best) {
  float a = dot(dir, dir);
  float b = dot(rel, dir);
  float disc = b * b - a * (dot(rel, rel) - radius * radius);
  if (disc <= 0.0) return best;
  float sq = sqrt(disc);
  return (sq - b) / a > from ? min(best, max((-b - sq) / a, from)) : best;
}

vec3 keyDirection() {
  return uEnv < 1.5 ? normalize(vec3(-0.25, 1.0, 0.45)) : normalize(vec3(-0.35, 0.5, -1.0));
}

void main() {
  vec2 res = uResolution;
  // Fit at least 2.4 units across and 2 deep, so phones still see the pool.
  float unit = min(res.y, res.x / 1.2);
  vec2 sp = (gl_FragCoord.xy - 0.5 * res) / unit;

  // A camera above the pool looking down at it (mirrored by project() in
  // the module, which places the magnet).
  vec3 ro = vec3(0.0, 2.05, 2.45);
  vec3 ta = vec3(0.0, 0.0, -0.04);
  vec3 fw = normalize(ta - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  const float focal = 1.9;
  float t = uTime;
  vec3 rd = normalize(fw * focal + rt * sp.x + up * sp.y);
  float down = -rd.y;
  float across = length(rd.xz);

  // The fluid lives between the floor and this height. Away from the
  // magnet it is no higher than the pool's bead, its ripple and the click's
  // ring, and the mound only rises within its reach; so a ray that never
  // comes near the spikes starts where it first drops into one of those.
  // One that does starts from the top as ever: the march's path among the
  // spikes decides which of the finest tips it catches.
  float top = POOL + 0.04 + MOUND * uPull + uSpikes * uPull * 1.15;
  float low = POOL + 0.007 + uRing;
  float t0 = (ro.y - top) / down;
  float t1 = ro.y / down;
  float start = enter(ro.xz - uMagnet, rd.xz, uReachNow + 0.01, t0, t1);
  if (start >= t1) {
    start = (ro.y - low) / down;
    start = enter(ro.xz - uMagnet, rd.xz, uReachNow * 1.35 + 0.01, (ro.y - low - MOUND * uPull) / down, start);
  } else start = t0;
  vec3 floorHit = ro + rd * t1;

  // The floor's contact shadow is looked up away from the light; the same
  // lookup tells whether the ray could reach the pool at all.
  vec3 L = keyDirection();
  vec2 off = -L.xz / max(L.y, 0.3) * 0.06;
  float shadowEdge = pool(floorHit.xz - off);
  float span = (t1 - start) * across;

  float hitT = t1;
  float hitH = 0.0;
  float hitEdge = 1.0;
  bool known = false;
  bool fluid = false;
  if (shadowEdge < 1.25 * (span + length(off)) + 0.05) {
    // March down through the slab. Above the spikes' envelope the surface
    // is gentle, so steps can be long; among the spikes they shrink to the
    // local slope; outside the pool they jump to its edge. A crossing is
    // then refined by bisection. The height last found at the hit is kept
    // for the normal.
    float near = start;
    float far = start;
    float gap = 1.0;
    for (int i = 0; i < 72; i++) {
      vec3 q = ro + rd * far;
      float e;
      float h = height(q.xz, q.y, e);
      gap = q.y - h;
      if (gap < 0.0006 * far) {
        hitH = h;
        hitEdge = e;
        known = true;
        break;
      }
      // Outside the pool, a ray that reaches the bare floor before it could
      // reach the pool's edge has missed it.
      if (e > 0.0 && q.y * across < e / 1.25 * down) {
        far = t1;
        hitEdge = e;
        known = true;
        break;
      }
      near = far;
      float over = q.y - gEnvelope;
      float step = over > 0.004 ? over / (down + across) + 0.002 : gap / (down + gSteep * across);
      far += max(step, e / (1.25 * across));
      if (far > t1) { far = t1; break; }
    }
    if (gap < 0.0) {
      for (int i = 0; i < 5; i++) {
        float mid = 0.5 * (near + far);
        vec3 q = ro + rd * mid;
        float e;
        float h = height(q.xz, 0.0, e);
        if (q.y - h < 0.0) {
          far = mid;
          hitH = h;
          hitEdge = e;
        } else near = mid;
      }
    }
    hitT = far;
    if (!known) hitEdge = pool((ro + rd * hitT).xz);
    fluid = hitEdge < 0.0;
  }

  vec3 p = ro + rd * hitT;
  vec3 colour;
  float alpha = 1.0;
  if (fluid) {
    // Normal from the heightfield, sampled about a pixel wide.
    float eps = 0.7 * hitT / (focal * unit) * uPixelRatio + 0.0015;
    float h0 = known ? hitH : height(p.xz);
    float hx = height(p.xz + vec2(eps, 0.0));
    float hz = height(p.xz + vec2(0.0, eps));
    vec3 n = normalize(vec3(h0 - hx, eps, h0 - hz));
    vec3 v = -rd;
    vec3 r = reflect(rd, n);
    float ndv = clamp(dot(n, v), 0.0, 1.0);

    // Valleys between spikes see less of the room.
    float lift = p.y - POOL;
    float ao = mix(0.35, 1.0, smoothstep(-0.02, 0.18, lift + n.y * 0.1));
    ao *= mix(0.6, 1.0, smoothstep(-0.3, 0.6, r.y));

    vec3 f0 = mix(vec3(0.045), uFluid, uMirror);
    vec3 fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);
    // Rays reflected downwards mostly see the pool around them, itself a
    // mirror of the room: one cheap bounce instead of a second march.
    vec3 env = environment(vec3(r.x, abs(r.y), r.z));
    if (r.y < 0.0) {
      vec3 f1 = mix(vec3(0.06), uFluid, uMirror);
      env *= f1 + (1.0 - f1) * pow(1.0 - min(-r.y * 1.4, 1.0), 5.0);
    }
    // Oily thin film: hue shifts with the angle and the surface's height.
    if (uIridescence > 0.0) {
      float film = 1.6 * ndv + 3.0 * p.y + 0.4 * sin(p.x * 5.0 + p.z * 3.0 + t * 0.4);
      vec3 hue = 0.5 + 0.5 * cos(6.2832 * (film + vec3(0.0, 0.33, 0.67)));
      env *= mix(vec3(1.0), hue * 1.7, uIridescence);
    }
    float diffuse = max(dot(n, L), 0.0);
    vec3 base = uFluid * (0.18 + 0.7 * diffuse) * (1.0 - uMirror);
    colour = base * (1.0 - fres) + env * fres * ao;
    // A crisp glint from the key light on every tip.
    vec3 hv = normalize(L + v);
    float spec = pow(max(dot(n, hv), 0.0), 600.0) * 30.0;
    colour += spec * uLight * mix(vec3(1.0), uFluid * 2.0 + 0.2, uMirror) * mix(1.0, 0.0, step(1.5, uEnv) * 0.6);
    colour = tonemap(colour * 1.05);
    colour = linearToSrgb(colour);
  } else {
    // Floor with a soft contact shadow, cast down and away from the light.
    float d = shadowEdge;
    float shade = 0.5 * exp(-max(d, 0.0) * 20.0) + 0.25 * exp(-max(d, 0.0) * 4.0);
    shade = clamp(shade, 0.0, 0.75);
    if (uTransparent > 0.5) {
      colour = vec3(0.0);
      alpha = shade * 0.8;
    } else {
      colour = linearToSrgb(uBackground * (1.0 - shade));
    }
  }
  colour += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(clamp(colour, 0.0, 1.0) * alpha, alpha);
}
`;

const ENVIRONMENTS = { studio: 0, neon: 1, sunset: 2 };

// The shader's camera: from (0, 2.05, 2.45) towards (0, 0, -0.04), so its
// right is +x and its up lies in the y-z plane. Focal length 1.9.
const CAM_Y = 2.05;
const CAM_Z = 2.45;
const FW = (() => {
  const l = Math.hypot(2.05, 2.49);
  return [-2.05 / l, -2.49 / l]; // y, z
})();

/**
 * Where the camera's ray through a screen point (in units from the middle)
 * meets the plane just above the floor where the magnet acts. @param {number[]} out
 * @param {number} x @param {number} y
 */
function project(out, x, y) {
  // fw * focal + right * x + up * y, with up = (0, -fw.z, fw.y).
  const dy = FW[0] * 1.9 - FW[1] * y;
  const dz = FW[1] * 1.9 + FW[0] * y;
  const k = (CAM_Y - 0.08) / -dy;
  out[0] = x * k;
  out[1] = CAM_Z + dz * k;
}

/** GLSL's smoothstep. @param {number} a @param {number} b @param {number} x */
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** @type {import('./runtime.js').EffectSpec<FerrofluidOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1.5,
  time: 4,
  speed: (o) => o.speed,
  update(o) {
    return {
      uSpikes: 0.7 * o.spikes,
      uSpacing: 0.24 - 0.15 * o.density,
      uFluid: linear(o.fluid),
      uMirror: o.mirror,
      uIridescence: o.iridescence,
      uEnv: ENVIRONMENTS[o.environment] ?? 0,
      uLight: linear(o.light),
      uBackground: linear(o.background),
      uTransparent: !o.showBackground,
    };
  },
  attach(ctx) {
    const { canvas } = ctx;
    // The pointer's eased and latest positions, caught on their way to the
    // shader, so the magnet can be worked out here once a frame.
    const eased = [0.5, 0.5];
    const latest = [0.5, 0.5];
    let active = 0;
    const p = pointer(
      {
        ...ctx,
        uniform(name, value) {
          const v = /** @type {ArrayLike<number>} */ (value);
          if (name === 'uPointer') {
            eased[0] = v[0];
            eased[1] = v[1];
          } else if (name === 'uPointerTarget') {
            latest[0] = v[0];
            latest[1] = v[1];
          } else if (name === 'uPointerActive') active = Number(value);
        },
      },
      { ease: 3 },
    );
    /** @type {FerrofluidOptions} */
    let o = defaults;
    const mag = [0, 0];
    const aim = [0, 0];
    const magnet = new Float32Array(2);
    const aimAt = new Float32Array(2);
    const shift = new Float32Array(2);
    const discs = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
    // A click surges the field: quick to rise, slow to settle.
    let surge = 0;
    let goal = 0;
    let burst = 10;
    const down = () => {
      if (!p.over || !ctx.options?.().interactive) return;
      goal = 1;
      burst = 0;
      ctx.invalidate();
    };
    addEventListener('pointerdown', down, { passive: true });
    return {
      update(next) {
        o = next;
      },
      frame(dt, t) {
        p.frame(dt);
        surge += (goal - surge) * (1 - Math.exp(-dt * 14));
        goal *= Math.exp(-dt * 3.5);
        burst = Math.min(burst + dt, 10);
        if (surge > 1e-3 || burst < 3) ctx.invalidate();

        // The magnet: the pointer projected onto the pool, or a wandering one.
        const unit = Math.min(canvas.height, canvas.width / 1.2);
        const sx = canvas.width / unit;
        const sy = canvas.height / unit;
        project(mag, (eased[0] - 0.5) * sx, (eased[1] - 0.5) * sy);
        project(aim, (latest[0] - 0.5) * sx, (latest[1] - 0.5) * sy);
        // The fluid follows only so far from the middle; the spikes still
        // point at the pointer itself.
        const fit = Math.max(1, Math.hypot(mag[0] / 0.85, mag[1] / (mag[1] < 0 ? 0.36 : 0.42)));
        const live = o.interactive ? active : 0;
        const idleX = 0.55 * Math.sin(t * 0.31) + 0.18 * Math.sin(t * 0.73 + 1.0);
        const idleY = 0.28 * Math.sin(t * 0.23 + 2.0) + 0.1 * Math.cos(t * 0.61);
        const aheadX = 0.55 * Math.sin(t * 0.31 + 0.25) + 0.18 * Math.sin(t * 0.73 + 1.6);
        const aheadY = 0.28 * Math.sin(t * 0.23 + 2.2) + 0.1 * Math.cos(t * 0.61 + 0.5);
        const idlePull = 0.4 + 0.6 * smoothstep(-0.9, 0.5, Math.sin(t * 0.55));
        magnet[0] = idleX + (mag[0] / fit - idleX) * live;
        magnet[1] = idleY + (mag[1] / fit - idleY) * live;
        aimAt[0] = aheadX + (aim[0] - aheadX) * live;
        aimAt[1] = aheadY + (aim[1] - aheadY) * live;
        const pull = o.strength * (idlePull + (1 - idlePull) * live) * (1 + 0.4 * surge);
        const reach = (0.3 + 0.5 * o.reach) * (1 + 0.22 * surge);
        // The whole pool drifts a little towards the magnet.
        const k = 0.22 / (1 + Math.hypot(magnet[0], magnet[1]) * 0.22 * 1.5);
        shift[0] = magnet[0] * k;
        shift[1] = magnet[1] * k;

        // The pool's discs wobble slowly; pool() works 1.32× larger.
        const w = t * 0.25;
        discs[0][0] = 0.05 * Math.sin(w * 1.3);
        discs[0][1] = 0.04 * Math.cos(w);
        discs[0][2] = -0.72 + 0.08 * Math.sin(w * 0.9 + 1.0);
        discs[0][3] = 0.12;
        discs[1][0] = 0.78;
        discs[1][1] = -0.08 + 0.07 * Math.cos(w * 1.1);
        discs[1][2] = 0.15 + 0.06 * Math.cos(w * 0.7);
        discs[1][3] = -0.62;
        discs[2][0] = -0.25;
        discs[2][1] = 0.6 + 0.05 * Math.sin(w * 1.2 + 2.0);
        discs[2][2] = (magnet[0] - shift[0]) * 1.32;
        discs[2][3] = (magnet[1] - shift[1]) * 1.32;

        ctx.uniform('uMagnet', magnet);
        ctx.uniform('uAim', aimAt);
        ctx.uniform('uPull', pull);
        ctx.uniform('uReachNow', reach);
        ctx.uniform('uBurst', burst);
        // Gone below a hundred-thousandth of a unit, the ring is skipped.
        const ring = 0.03 * Math.exp(-burst * 1.8);
        ctx.uniform('uRing', ring > 1e-5 ? ring : 0);
        ctx.uniform('uPoolA', discs[0]);
        ctx.uniform('uPoolB', discs[1]);
        ctx.uniform('uPoolC', discs[2]);
        ctx.uniform('uPoolShift', shift);
        ctx.uniform('uPoolMagnet', 1.32 * (0.1 + 0.85 * reach * pull));
      },
      destroy() {
        removeEventListener('pointerdown', down);
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<FerrofluidOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function ferrofluid(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
