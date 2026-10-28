// @ts-check
/**
 * ittybitty/force-field
 *
 * A sci-fi energy shield: a lattice of hexagons, faint until energy flows
 * through it, glowing brightest at its rim. The pointer brushes it into
 * light, and every click lands as an impact, a bright flash with a ripple of
 * hexagons lighting up as it spreads. As a dome it floats over the scene;
 * as a panel it fills its container, fitting buttons and cards.
 *
 * https://ittybitty.dev/shaders/force-field (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} ForceFieldOptions
 * @property {boolean} showBackground The colour behind the shield. Off, only the shield is drawn, over the page.
 * @property {boolean} showLattice The hexagonal cells and the energy rolling through them.
 * @property {boolean} showRim The bright edge where the shield turns away.
 * @property {boolean} showImpacts Flashes and shockwaves where it is struck.
 * @property {'dome' | 'panel'} shape A floating dome, or a panel that fills its container.
 * @property {number} speed How fast energy flows through the lattice.
 * @property {number} size Size of the hexagons.
 * @property {number} strength Overall brightness of the shield.
 * @property {number} flow Energy flowing across the lattice.
 * @property {number} impacts Strength of the flash and ripple when clicked.
 * @property {string} colour Colour of the shield.
 * @property {string} background Colour behind the shield.
 * @property {boolean} interactive The pointer lights the shield and clicks land as impacts.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer within about 10 ms.
 */

/** @type {ForceFieldOptions} */
export const defaults = {
  showBackground: true,
  showLattice: true,
  showRim: true,
  showImpacts: true,
  shape: 'dome',
  speed: 0.6,
  size: 1,
  strength: 0.8,
  flow: 0.6,
  impacts: 0.8,
  colour: '#3fd0ff',
  background: '#070b14',
  interactive: true,
  responsiveness: 0.7,
};

const IMPACTS = 4;

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uShowLattice;
uniform float uShowRim;
uniform float uShowImpacts;
uniform float uPixelRatio;
uniform float uTime;
uniform float uForm;     // 0 dome, 1 panel
uniform float uSize;
uniform float uStrength;
uniform float uFlow;
uniform float uImpacts;
uniform vec3 uColour;     // linear RGB
uniform vec3 uBackground;
uniform float uInteractive;
uniform float uTransparent;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform vec4 uImpact[${IMPACTS}];   // xy position (0..1), z age in seconds, w strength

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

// Hexagonal tiling: returns (distance to the cell's edge, 0 at the edge and
// 0.5 at its centre; and the cell's id).
vec3 hex(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = p - g;
  vec2 q = abs(g);
  float edge = 0.5 - max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
  return vec3(edge, id);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = uTime;

  // The surface: a dome curves the lattice around a sphere, a panel is flat.
  vec2 lattice = p;
  float cover = 1.0;
  float rimLight = 0.0;
  float facing = 1.0;
  if (uForm < 0.5) {
    float r = length(p) / 0.42;
    cover = smoothstep(1.0 + 2.0 / uResolution.y, 1.0, r);
    float z = sqrt(max(1.0 - r * r, 0.0));
    // Map through the sphere, so hexagons compress towards the rim.
    lattice = p / (0.35 + z * 0.65);
    rimLight = pow(1.0 - z, 3.0);
    facing = z;
  } else {
    rimLight = pow(max(abs(p.x) / (aspect * 0.5), abs(p.y) / 0.5), 28.0) * 0.8;
  }

  vec2 css = lattice * uResolution.y / uPixelRatio;
  vec3 h = hex(lattice * 14.0 / uSize);
  float line = smoothstep(0.06, 0.0, h.x);
  float cellGlow = smoothstep(0.5, 0.0, h.x);

  // Energy: slow waves of light rolling across the lattice, cell by cell.
  // Bands of energy sweeping diagonally across, broken up cell by cell.
  float sweep = fract(dot(h.yz, vec2(0.035, 0.02)) - t * 0.18 + noise(h.yz * 0.12) * 0.25);
  float pulse = (exp(-pow((sweep - 0.5) * 16.0, 2.0)) * (0.5 + 0.5 * hash12(h.yz))) * uFlow;
  // Scattered cells flicker on and off.
  float flicker = step(0.985, hash12(h.yz + floor(t * 3.0))) * 0.6;

  // The pointer: nearby cells light up as it brushes the surface.
  vec2 hand = (uPointer - 0.5) * vec2(aspect, 1.0);
  float near = exp(-dot(p - hand, p - hand) * 160.0) * uPointerActive * uInteractive;

  // Impacts: a hot flash where it lands and a ring of cells lighting up as
  // the shockwave spreads, fading as it goes.
  float hit = 0.0;
  for (int i = 0; i < ${IMPACTS}; i++) {
    vec4 im = uImpact[i];
    if (im.w <= 0.0) continue;
    vec2 at = (im.xy - 0.5) * vec2(aspect, 1.0);
    float d = length(p - at);
    float age = im.z;
    float ring = exp(-pow((d - age * 0.7) * 22.0, 2.0)) * exp(-age * 2.4) * 1.6;
    float flash = exp(-d * d * 300.0) * exp(-age * 5.0) * 3.0;
    hit += (ring + flash) * im.w;
  }
  hit *= uImpacts * uShowImpacts;

  // Nearly clear at rest: faint lines, and a bright rim where the surface
  // turns away. Energy lights whole cells as it passes through them.
  float energy = pulse * 0.7 + flicker + near * 1.1 + hit * 2.2;
  vec3 colour = uColour * ((line * (0.12 + energy * 0.9) + cellGlow * cellGlow * energy * 0.35) * max(uShowLattice, uShowImpacts * min(hit, 1.0)) + rimLight * 1.1 * uShowRim) * uStrength;
  // Where the dome faces you it is almost clear; its rim is dense with light.
  colour *= cover;
  float alpha = clamp(max(max(colour.r, colour.g), colour.b), 0.0, 1.0);

  vec3 outc = uBackground * (1.0 - uTransparent) + colour;
  outc = 1.0 - exp(-outc * 1.3);
  vec3 c = linearToSrgb(outc);
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uTransparent > 0.5) {
    vec3 lc = linearToSrgb(1.0 - exp(-colour * 1.3));
    fragColor = vec4(lc, max(lc.r, max(lc.g, lc.b)));
    return;
  }
  fragColor = vec4(c, 1.0);
}
`;

const base = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  time: 5,
  speed: (/** @type {ForceFieldOptions} */ o) => o.speed,
  update(/** @type {ForceFieldOptions} */ o) {
    return {
      uShowLattice: o.showLattice,
      uShowRim: o.showRim,
      uShowImpacts: o.showImpacts,
      uForm: o.shape === 'panel' ? 1 : 0,
      uSize: o.size,
      uStrength: o.strength,
      uFlow: o.flow,
      uImpacts: o.impacts,
      uColour: linear(o.colour),
      uBackground: linear(o.background),
      uInteractive: o.interactive,
      uTransparent: !o.showBackground,
    };
  },
  attach(/** @type {import('./runtime.js').Context} */ ctx) {
    const p = pointer(ctx, { ease: 10 });
    // Impacts: where and when the last few clicks landed.
    const impacts = new Float32Array(IMPACTS * 4);
    let next = 0;
    let on = defaults.interactive;
    /** @param {PointerEvent} e */
    const down = (e) => {
      if (!on) return;
      const r = ctx.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = 1 - (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      impacts.set([x, y, 0, 1], next * 4);
      next = (next + 1) % IMPACTS;
      ctx.invalidate();
    };
    addEventListener('pointerdown', down, { passive: true });
    return {
      update: (/** @type {ForceFieldOptions} */ o) => (on = o.interactive),
      frame(/** @type {number} */ dt) {
        p.frame(dt);
        let live = false;
        for (let i = 0; i < IMPACTS; i++) {
          if (impacts[i * 4 + 3] <= 0) continue;
          impacts[i * 4 + 2] += dt;
          if (impacts[i * 4 + 2] > 2.5) impacts[i * 4 + 3] = 0;
          else live = true;
        }
        ctx.uniform('uImpact', impacts);
        if (live) ctx.invalidate();
      },
      destroy() {
        removeEventListener('pointerdown', down);
        p.destroy();
      },
    };
  },
};

// Container aware: as a panel it fits its element's shape and corners.
/** @type {import('./runtime.js').EffectSpec<ForceFieldOptions>} */
export const spec = base;

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<ForceFieldOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function forceField(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
