// @ts-check
/**
 * ittybitty/black-hole
 *
 * A black hole with a glowing accretion disc, rendered by bending each ray of
 * light around it. That bending is what makes the famous look: the far side
 * of the disc is lensed up and over the top of the shadow, and a thin photon
 * ring hugs its edge. The disc spins, brighter on the side coming towards
 * you. Behind it, stars (or your image) are pulled into an Einstein ring.
 *
 * https://ittybitty.dev/shaders/black-hole (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';
import { texture } from './texture.js';

/**
 * @typedef {object} BlackHoleOptions
 * @property {boolean} showSky The stars (or your image) behind, bent around the hole. Off, the hole floats over the page.
 * @property {boolean} showDisc The glowing accretion disc.
 * @property {boolean} showHole The black shadow of the event horizon.
 * @property {number} speed How fast the disc spins.
 * @property {number} tilt How far the disc is tipped towards you.
 * @property {number} size Size of the black hole in the frame.
 * @property {number} disc Brightness of the accretion disc.
 * @property {number} doppler How much brighter the approaching side is.
 * @property {number} stars How many stars.
 * @property {number} quality Steps along each ray: more is smoother and heavier.
 * @property {'stars' | 'image'} background Lens a starfield, or your image.
 * @property {string} image Image to lens. Needs CORS headers if cross-origin.
 * @property {string} hot Colour of the disc's hot inner edge.
 * @property {string} cool Colour of the disc's cooler outer reaches.
 * @property {boolean} interactive The pointer orbits the view.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {BlackHoleOptions} */
export const defaults = {
  showSky: true,
  showDisc: true,
  showHole: true,
  speed: 0.4,
  tilt: 0.12,
  size: 1,
  disc: 1,
  doppler: 0.6,
  stars: 0.6,
  quality: 0.5,
  background: 'stars',
  image: '',
  hot: '#fff1d6',
  cool: '#ff7a2e',
  interactive: true,
  responsiveness: 0.4,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowSky;
uniform float uShowDisc;
uniform float uShowHole;
uniform float uTime;
uniform float uTilt;
uniform float uSize;
uniform float uDisc;
uniform float uDoppler;
uniform float uStars;
uniform float uSteps;
uniform float uBackground;  // 0 stars, 1 image
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform vec3 uHot;        // linear RGB
uniform vec3 uCool;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

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

// What lies behind, seen along direction d after the ray escapes.
// Value noise that repeats every 'period' cells in x.
float pnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  return mix(mix(hash12(vec2(x0, i.y)), hash12(vec2(x1, i.y)), u.x), mix(hash12(vec2(x0, i.y + 1.0)), hash12(vec2(x1, i.y + 1.0)), u.x), u.y);
}

vec3 sky(vec3 d) {
  if (uBackground > 0.5 && uImageReady > 0.5) {
    vec2 sph = vec2(atan(d.x, d.z), asin(clamp(d.y, -1.0, 1.0)));
    vec2 uv = vec2(sph.x / 6.28318 + 0.5, sph.y / 3.14159 + 0.5);
    uv = fract(uv * vec2(2.0, 1.0));
    return pow(texture(uImage, uv).rgb, vec3(2.2)) * 0.8;
  }
  // Stars on a 3D grid of directions. Each is a point in its own direction,
  // measured by angle, so it stays round wherever it is on the sky.
  vec3 q = d * 60.0;
  vec3 cell = floor(q);
  float h = hash12(cell.xy + cell.z * 17.3);
  // Tiny, so lensing leaves them as points or short arcs, not long streaks.
  vec3 stars = vec3(0.0);
  if (h >= 1.0 - uStars * 0.1) {
    vec3 at = normalize(cell + 0.5 + (vec3(hash12(cell.yz + 3.1), hash12(cell.zx + 5.7), h) - 0.5) * 0.7);
    vec3 sep = (d - at) * 60.0;
    float star = exp(-dot(sep, sep) * 900.0) * (0.8 + 6.0 * h * h * h);
    stars = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash12(cell.xz + 9.1)) * star;
  }
  // A faint band of the galaxy, tilted well away from the line through the
  // hole, so lensing bends it into arcs rather than rings.
  vec3 gd = vec3(d.x * 0.8 + d.y * 0.6, d.y * 0.8 - d.x * 0.6, d.z);
  gd = vec3(gd.x, gd.y * 0.7 + gd.z * 0.71, gd.z * 0.7 - gd.y * 0.71);
  vec2 gs = vec2(atan(gd.x, gd.z), asin(clamp(gd.y, -1.0, 1.0)));
  float band = exp(-pow(gs.y * 3.2 + sin(gs.x * 2.0) * 0.25, 2.0));
  float dust = noise(gs * 5.0) * 0.6 + noise(gs * 13.0) * 0.4;
  vec3 neb = mix(vec3(0.004, 0.005, 0.012), vec3(0.022, 0.017, 0.028), dust) * band * smoothstep(0.25, 0.7, dust + 0.2);
  return neb + stars;
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime;

  // Camera orbiting the hole, looking at it, slightly above the disc plane.
  vec2 look = (uPointer - 0.5) * uPointerActive * uInteractive;
  float yaw = look.x * 1.2;
  float pitch = uTilt + look.y * 0.4;
  float dist = 16.0 / uSize;
  vec3 ro = dist * vec3(sin(yaw) * cos(pitch), sin(pitch), -cos(yaw) * cos(pitch));
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw * 1.6 + rt * uv.x + up * uv.y);

  // March the photon, bending it towards the hole. With the Schwarzschild
  // radius at 1, a photon's acceleration is -1.5 h^2 r / |r|^5.
  vec3 p = ro;
  vec3 v = rd;
  vec3 hvec = cross(p, v);
  float h2 = dot(hvec, hvec);
  vec3 colour = vec3(0.0);
  float transmit = 1.0;
  bool captured = false;
  int steps = int(uSteps);
  float closest = 1e3;
  for (int i = 0; i < 300; i++) {
    if (i >= steps) break;
    float r2 = dot(p, p);
    float r = sqrt(r2);
    closest = min(closest, r);
    if (r < 1.0) {
      captured = true;
      break;
    }
    if (r > dist * 1.6 && dot(p, v) > 0.0) break;
    // Smaller steps near the hole, where the bending is strongest.
    // Far out the path is nearly straight: longer strides, so every ray that
    // escapes gets clear of the hole within the step budget and leaves in
    // its final direction (a ray stopped mid-bend shows as rings in the sky).
    float dt = clamp(0.06 * r * (1.0 + r * 0.12), 0.03, 4.0);
    vec3 acc = -1.5 * h2 * p / (r2 * r2 * r);
    vec3 prev = p;
    v += acc * dt;
    p += v * dt;
    // The disc has thickness: a faint glowing haze just above and below it,
    // which the ray gathers as it passes close to the plane.
    // Only near the plane: further out the haze is below one part in fifty.
    if (uShowDisc > 0.5 && abs(p.y) < 0.6) {
      float rr0 = length(p.xz);
      if (rr0 > 2.6 && rr0 < 9.0) {
        float haze = exp(-abs(p.y) * 7.0) * smoothstep(9.0, 4.0, rr0) * smoothstep(2.6, 3.4, rr0);
        colour += transmit * uCool * haze * pow(2.6 / rr0, 1.5) * dt * 0.09 * uDisc;
      }
    }
    // Crossing the disc plane (y = 0) between the inner and outer edges.
    if (uShowDisc > 0.5 && prev.y * p.y < 0.0) {
      vec3 hit = mix(prev, p, prev.y / (prev.y - p.y));
      float rr = length(hit.xz);
      if (rr > 2.6 && rr < 9.0) {
        // Gas: fine filaments sheared into arcs by the orbit, the inner
        // parts turning faster (Kepler), so the streaks wind as they go.
        // Texture is laid out around the ring, so it must wrap seamlessly:
        // angle measured in whole cells around the circle, and each noise
        // lattice repeats after exactly that many cells.
        float ang = atan(hit.z, hit.x);
        float spin = t * 1.8 / pow(rr, 1.5);
        float around = fract((ang + spin) / 6.28318);
        float gas = pnoise(vec2(around * 32.0, rr * 1.6), 32.0) * 0.45
          + pnoise(vec2(around * 64.0, rr * 4.96) + 7.0, 64.0) * 0.3
          + pnoise(vec2(around * 128.0, rr * 11.7) + 3.0, 128.0) * 0.25;
        gas = smoothstep(0.2, 0.85, gas);
        // Temperature falls off as r^-3/4 from the hot inner edge.
        float temp = pow(2.6 / rr, 0.75);
        // Doppler beaming: gas orbiting towards us is brighter and bluer,
        // gas receding dimmer and redder. Orbital speed is sqrt(0.5 / r).
        vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
        float beta = sqrt(0.5 / rr);
        float cosT = dot(orbit, -normalize(v));
        float doppler = mix(1.0, sqrt(1.0 - beta * beta) / (1.0 - beta * cosT), uDoppler);
        // Gravitational redshift: light climbing out from near the hole.
        float shift = doppler * sqrt(1.0 - 1.0 / rr);
        float heat = temp * shift * 1.15;
        vec3 col = mix(uCool * 0.35, uCool, smoothstep(0.15, 0.55, heat));
        col = mix(col, uHot, smoothstep(0.5, 0.95, heat));
        col = mix(col, vec3(1.0, 0.95, 0.85), smoothstep(1.0, 1.7, heat));
        col *= temp * temp * shift * shift * shift * (0.35 + 1.1 * gas) * 1.6;
        // Soft inner and outer edges; the gas thins into gaps between streaks.
        float a = smoothstep(2.6, 3.2, rr) * smoothstep(9.0, 6.5, rr) * (0.55 + 0.4 * gas);
        colour += transmit * col * a * uDisc * 1.4;
        transmit *= 1.0 - a * 0.9;
      }
    }
  }
  // The photon ring: light that skimmed the photon sphere (r = 1.5) on its
  // way past, a thin bright line hugging the shadow.
  if (!captured && uShowHole > 0.5) {
    float ring = exp(-abs(closest - 1.5) * 18.0) * smoothstep(1.0, 1.35, closest);
    colour += transmit * mix(uHot, vec3(1.0), 0.5) * ring * 0.9 * uDisc;
  }
  // Bloom: the brightest light spreads a soft glow around the disc.
  if (!captured) colour += uCool * 0.03 * exp(-length(uv) * 2.4) * uDisc * uShowDisc;

  // Premultiplied colour and coverage, so each part can stand alone.
  float alpha = 1.0 - transmit;
  if (captured && uShowHole > 0.5) alpha += transmit;
  else {
    // Without the hole, its shadow shows the sky straight behind.
    colour += transmit * sky(captured ? rd : normalize(v)) * uShowSky;
    alpha += transmit * uShowSky;
  }

  colour = 1.0 - exp(-colour * 1.0);
  vec3 c = linearToSrgb(colour / max(alpha, 1e-4));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c * alpha, alpha);
}
`;

/** @type {import('./runtime.js').EffectSpec<BlackHoleOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 1,
  time: 5,
  speed: (o) => o.speed,
  update(o) {
    return {
      uShowSky: o.showSky,
      uShowDisc: o.showDisc,
      uShowHole: o.showHole,
      uTilt: o.tilt,
      uSize: o.size,
      uDisc: o.disc,
      uDoppler: o.doppler,
      uStars: o.stars,
      uSteps: Math.round(50 + o.quality * 120),
      uBackground: o.background === 'image',
      uHot: linear(o.hot),
      uCool: linear(o.cool),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0);
    const p = pointer(ctx, { ease: 3 });
    return {
      update: (o) => o.background === 'image' && image.set(o.image),
      frame: p.frame,
      restore: image.restore,
      destroy() {
        image.destroy();
        p.destroy();
      },
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<BlackHoleOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function blackHole(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
