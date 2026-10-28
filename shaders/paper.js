// @ts-check
/**
 * ittybitty/paper
 *
 * A sheet of paper, printed with an image or the layers beneath, built as a
 * real surface rather than a filter laid over the top. Everything comes from
 * one height field: the tooth of the stock, laid rows from the mould, folds
 * that alternate valley and mountain, and a crumple of flat facets meeting
 * at sharp creases, from a few large ones to fine wrinkles. From that one
 * surface come three things. The light: one low light from a chosen angle,
 * shading in the paper's own shadow colour, never grey mud. The print: the
 * picture bends with the sheet, kinking at every fold. And the sheet itself:
 * cut to its picture, it lies on the page as an object, its edges deckled
 * or clean, bent by its folds, casting a soft shadow.
 *
 * Fibres, age (yellowing, foxing, a cup ring) and nine stocks, from
 * hot-pressed to kraft board, finish it. Static: one draw per change, or
 * while the pointer moves the light.
 *
 * https://ittybitty.dev/shaders/paper (MIT)
 */
import { mount, linear } from './runtime.js';
import { texture } from './texture.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} PaperOptions
 * @property {boolean} showSheet Cut the paper to a sheet lying on the page, with its own edges and shadow. Off, the paper fills the canvas.
 * @property {boolean} showFibres Fibres through the paper.
 * @property {boolean} showFolds Fold lines, alternating valley and mountain.
 * @property {boolean} showCrumple Crumpled facets and creases.
 * @property {boolean} showAge Yellowing, foxing and the ring of a cup.
 * @property {string} image Picture printed on the paper. Needs CORS headers if cross-origin. As a layer, the layers beneath are used instead.
 * @property {'cold' | 'hot' | 'rough' | 'laid' | 'kraft' | 'newsprint' | 'vellum' | 'recycled' | 'washi'} stock The paper: watercolour stocks, laid, kraft, newsprint, vellum, recycled or washi.
 * @property {number} texture How strongly the surface of the stock shows.
 * @property {number} scale Size of every pattern on the sheet.
 * @property {number} folds How deep the folds are.
 * @property {'half' | 'letter' | 'quarter' | 'map'} layout In half, in thirds like a letter, in quarters, or in a grid like a map.
 * @property {number} crumple How deeply crumpled.
 * @property {number} creases How many facets across the sheet: a few broad ones to fine wrinkles.
 * @property {number} age How old: yellowing, foxing and stains.
 * @property {number} distortion How far the picture bends with the paper. Negative bends it the other way.
 * @property {number} light Direction the light comes from, in degrees.
 * @property {number} seed Rearranges every pattern: creases, fibres, stains, edges.
 * @property {string} colour Colour of the paper.
 * @property {string} shadow Colour the paper shades to, away from the light.
 * @property {boolean} interactive The light follows the pointer.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {PaperOptions} */
export const defaults = {
  showSheet: true,
  showFibres: true,
  showFolds: true,
  showCrumple: true,
  showAge: false,
  image: '',
  stock: 'cold',
  texture: 0.5,
  scale: 1,
  folds: 0.5,
  layout: 'letter',
  crumple: 0.3,
  creases: 2.5,
  age: 0.5,
  distortion: 0.6,
  light: 135,
  seed: 1,
  colour: '#f7f4ee',
  shadow: '#b9b3a8',
  interactive: true,
  responsiveness: 0.5,
};

export const fragment = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uImageReady;
uniform float uShowSheet;
uniform float uShowFibres;
uniform float uShowFolds;
uniform float uShowCrumple;
uniform float uShowAge;
uniform float uStock;       // 0 cold, 1 hot, 2 rough, 3 laid, 4 kraft, 5 newsprint, 6 vellum, 7 recycled, 8 washi
uniform float uTexture;
uniform float uScale;
uniform float uFolds;
uniform vec2 uGrid;         // panels across and down
uniform float uCrumple;
uniform float uCreases;
uniform float uAge;
uniform float uDistortion;
uniform float uSlopeBound;
uniform float uLight;       // radians
uniform float uSeed;
uniform vec3 uColour;       // linear RGB
uniform vec3 uShadow;
uniform float uInteractive;
uniform vec2 uPointer;
uniform float uPointerActive;

out vec4 fragColor;

// What is printed on the sheet: an image, or in a layer stack the layers
// below. Alpha 0 where nothing is printed.
// @source
vec4 source(vec2 px, float blur) {
  if (uImageReady < 0.5) return vec4(0.0);
  vec2 uv = px / uResolution;
  return vec4(texture(uImage, clamp(uv, 0.0, 1.0), blur).rgb, 1.0);
}
// @end

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
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.7;
    a *= 0.5;
  }
  return v;
}

// Share lattice values across the three surface samples without changing
// the interpolation or the octaves when a sample crosses a lattice edge.
vec3 noise(vec2 p, vec2 px, vec2 py) {
  vec2 i = floor(p);
  if (any(notEqual(i, floor(px))) || any(notEqual(i, floor(py)))) {
    return vec3(noise(p), noise(px), noise(py));
  }
  vec3 fx = vec3(fract(p.x), fract(px.x), fract(py.x));
  vec3 fy = vec3(fract(p.y), fract(px.y), fract(py.y));
  vec3 ux = fx * fx * (3.0 - 2.0 * fx);
  vec3 uy = fy * fy * (3.0 - 2.0 * fy);
  return mix(mix(vec3(hash12(i)), vec3(hash12(i + vec2(1, 0))), ux),
             mix(vec3(hash12(i + vec2(0, 1))), vec3(hash12(i + vec2(1, 1))), ux), uy);
}

vec3 fbm(vec2 p, vec2 px, vec2 py) {
  vec3 v = vec3(0.0);
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p, px, py);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.7;
    px = mat2(1.6, 1.2, -1.2, 1.6) * px + 3.7;
    py = mat2(1.6, 1.2, -1.2, 1.6) * py + 3.7;
    a *= 0.5;
  }
  return v;
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Crumpled facets: every point lies on one flat face of a Voronoi cell,
// each face rising or sinking to its own depth, so neighbours meet at sharp
// creases folded either way. Points stay mid-cell, so no edge is unstable.
float facets(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 mo = vec2(0.0);
  vec2 mid = vec2(0.0);
  float md = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = vec2(x, y);
      vec2 o = c + 0.1 + 0.8 * hash22(i + c + seed) - f;
      float d = dot(o, o);
      if (d < md) { md = d; mo = o; mid = i + c; }
    }
  }
  float edge = 8.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 c = vec2(x, y);
      vec2 o = c + 0.1 + 0.8 * hash22(i + c + seed) - f;
      vec2 diff = o - mo;
      if (dot(diff, diff) > 0.01) edge = min(edge, dot(0.5 * (mo + o), normalize(diff)));
    }
  }
  return (hash12(mid + seed + 4.2) - 0.45) * 2.0 * edge;
}

// Nearby height samples usually share a cell, so its sites and crease
// directions can be reused. Crossing a cell keeps the separate searches.
vec3 facets(vec2 p, vec2 px, vec2 py, float seed) {
  vec2 i = floor(p);
  if (any(notEqual(i, floor(px))) || any(notEqual(i, floor(py)))) {
    return vec3(facets(p, seed), facets(px, seed), facets(py, seed));
  }
  vec2 f = fract(p);
  vec2 dx = px - p;
  vec2 dy = py - p;
  vec2 mo = vec2(0.0);
  vec2 mid = vec2(0.0);
  vec2 midx = vec2(0.0);
  vec2 midy = vec2(0.0);
  vec3 md = vec3(8.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = vec2(x, y);
      vec2 o = c + 0.1 + 0.8 * hash22(i + c + seed) - f;
      vec3 d = vec3(dot(o, o), dot(o - dx, o - dx), dot(o - dy, o - dy));
      if (d.x < md.x) { md.x = d.x; mo = o; mid = i + c; }
      if (d.y < md.y) { md.y = d.y; midx = i + c; }
      if (d.z < md.z) { md.z = d.z; midy = i + c; }
    }
  }
  if (any(notEqual(mid, midx)) || any(notEqual(mid, midy))) {
    return vec3(facets(p, seed), facets(px, seed), facets(py, seed));
  }
  vec3 edge = vec3(8.0);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 c = vec2(x, y);
      vec2 o = c + 0.1 + 0.8 * hash22(i + c + seed) - f;
      vec2 diff = o - mo;
      if (dot(diff, diff) > 0.01) {
        vec2 n = normalize(diff);
        float d = dot(0.5 * (mo + o), n);
        edge = min(edge, vec3(d, d - dot(dx, n), d - dot(dy, n)));
      }
    }
  }
  return (hash12(mid + seed + 4.2) - 0.45) * 2.0 * edge;
}

// A fold line at every panel boundary, alternating valley and mountain.
// Each panel tilts a little away from its creases and bows softly between
// them, so shading drifts across it rather than lying in flat bands.
float foldAxis(float u, float count) {
  if (count < 1.5) return 0.0;
  float x = u * count;
  float t = abs(fract(x * 0.5) * 2.0 - 1.0);
  float f = fract(x);
  float bow = f * (1.0 - f) * (mod(floor(x), 2.0) < 0.5 ? 1.0 : -1.0);
  return t * 0.35 + bow * 0.5;
}

// Distance to the nearest fold along one axis, in canvas pixels, and
// whether that fold is a valley (1) or a mountain (0).
vec2 foldLine(float u, float count, float span) {
  if (count < 1.5) return vec2(1e4, 0.0);
  float x = u * count;
  float k = floor(x + 0.5);
  if (k < 0.5 || k > count - 0.5) return vec2(1e4, 0.0);
  return vec2(abs(x - k) / count * span, mod(k, 2.0));
}

// The whole surface at sheet position s (0..1 across and down) and world
// position p. Heights are in units of the sheet's short side.
vec3 surface(vec2 s, vec2 p, float e, vec2 size, float short_) {
  vec2 sx = s + vec2(e, 0.0) / size * short_;
  vec2 sy = s + vec2(0.0, e) / size * short_;
  vec2 px = p + vec2(e * 1.6 / uScale, 0.0);
  vec2 py = p + vec2(0.0, e * 1.6 / uScale);
  vec3 h = vec3(0.0);
  if (uShowFolds > 0.5 && uFolds != 0.0) {
    h += vec3(foldAxis(s.x, uGrid.x) / uGrid.x + foldAxis(s.y, uGrid.y) / uGrid.y,
              foldAxis(sx.x, uGrid.x) / uGrid.x + foldAxis(sx.y, uGrid.y) / uGrid.y,
              foldAxis(sy.x, uGrid.x) / uGrid.x + foldAxis(sy.y, uGrid.y) / uGrid.y) * uFolds * 0.3;
  }
  if (uShowCrumple > 0.5 && uCrumple != 0.0) {
    vec3 wx = fbm(p * 1.5 + uSeed, px * 1.5 + uSeed, py * 1.5 + uSeed);
    vec3 wy = fbm(p * 1.5 + uSeed + 7.0, px * 1.5 + uSeed + 7.0, py * 1.5 + uSeed + 7.0);
    vec2 q = p * uCreases + 0.3 * vec2(wx.x, wy.x);
    vec2 qx = px * uCreases + 0.3 * vec2(wx.y, wy.y);
    vec2 qy = py * uCreases + 0.3 * vec2(wx.z, wy.z);
    vec3 c = facets(q, qx, qy, uSeed) + 0.2 * facets(q * 2.3 + 11.0, qx * 2.3 + 11.0, qy * 2.3 + 11.0, uSeed);
    h += c * uCrumple * 0.3 / uCreases;
  }
  // Paper never lies quite flat: a slow buckle under everything.
  h += (fbm(p * 1.2 + uSeed * 3.1, px * 1.2 + uSeed * 3.1, py * 1.2 + uSeed * 3.1) - 0.5) * 0.012;
  return h;
}

// Paper fibres: short, thin, curling strands in every direction.
float fibres(vec2 p) {
  float f = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = float(i) * 2.1 + 0.4 + uSeed;
    mat2 turn = mat2(cos(a), sin(a), -sin(a), cos(a));
    vec2 q = turn * p * vec2(0.12, 1.0) * (1.0 + float(i) * 0.3) + float(i) * 17.0;
    float strand = abs(noise(q + 0.6 * noise(q * 0.5)) - 0.5);
    f = max(f, (1.0 - smoothstep(0.0, 0.035, strand)) * smoothstep(0.55, 0.7, noise(p * 0.07 + float(i) * 5.0)));
  }
  return f;
}

// The stock's fine tooth: a small height, read separately so it lights the
// surface without bending the picture.
float tooth(vec2 css) {
  vec2 p = css / uScale;
  if (uStock < 0.5) return fbm(p * 0.09) * 0.7 + noise(p * 0.35) * 0.3;
  if (uStock < 1.5) return fbm(p * 0.05) * 0.25 + noise(p * 0.6) * 0.12;
  if (uStock < 2.5) return fbm(p * 0.045) * 0.6 + fbm(p * 0.14) * 0.4;
  if (uStock < 3.5) {
    float ribs = 0.5 + 0.5 * sin(p.y * 2.3 + noise(p * 0.05) * 2.0);
    float chain = 1.0 - smoothstep(0.0, 3.0, abs(mod(p.x + 3.0 * noise(p * vec2(0.002, 0.01)), 95.0) - 47.5) - 44.0);
    return ribs * 0.35 + chain * 0.3 + fbm(p * 0.08) * 0.35;
  }
  if (uStock < 4.5) return noise(p * 1.2) * 0.3 + noise(p * 2.6) * 0.2 + fbm(p * 0.05) * 0.5;
  // Newsprint: a fine, even, slightly fuzzy grain.
  if (uStock < 5.5) return noise(p * 1.4) * 0.5 + noise(p * 3.1) * 0.3 + fbm(p * 0.1) * 0.2;
  // Vellum: pressed almost glass-smooth.
  if (uStock < 6.5) return fbm(p * 0.03) * 0.2 + noise(p * 0.9) * 0.05;
  // Recycled: a lumpy, uneven tooth.
  if (uStock < 7.5) return fbm(p * 0.07) * 0.7 + noise(p * 0.35) * 0.3;
  // Washi: soft and faintly puckered; its fibres lie within the sheet.
  return fbm(p * 0.03) * 0.6 + noise(p * 0.4) * 0.15;
}

// Where the light comes from: its angle, or with the pointer, the pointer's
// side of the sheet. Low, so every fold and crease shows.
vec3 lightDir() {
  vec2 d = vec2(cos(uLight), sin(uLight));
  if (uInteractive > 0.5 && uPointerActive > 0.01) {
    vec2 p = (uPointer - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    d = normalize(mix(d, p + 1e-4, uPointerActive));
  }
  return normalize(vec3(d, 0.7));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 css = px / uPixelRatio;
  vec2 res = uResolution;
  float aspect = res.x / res.y;

  // The sheet: cut to its picture's shape, set in from the canvas edges, or
  // the whole canvas. Its rectangle in canvas uv.
  vec2 half_ = vec2(0.5);
  if (uShowSheet > 0.5) {
    float ia = uImageReady > 0.5 ? uImageSize.x / max(uImageSize.y, 1.0) : aspect * 0.8;
    vec2 fit = ia > aspect ? vec2(1.0, aspect / ia) : vec2(ia / aspect, 1.0);
    half_ = fit * 0.41;
  }
  vec2 uv = px / res;
  // Sheet position, 0..1 across and down it, and world position in units of
  // its short side, so patterns belong to the sheet, not the canvas.
  vec2 s = (uv - 0.5) / (half_ * 2.0) + 0.5;
  vec2 size = half_ * 2.0 * vec2(aspect, 1.0);
  float short_ = min(size.x, size.y);
  vec2 p = (s - 0.5) * size / short_ * (1.6 / uScale);

  vec3 l = lightDir();
  float shadowA = 0.0;
  if (uShowSheet > 0.5) {
    vec2 off = -l.xy / l.z * (0.012 + 0.02 * (uFolds * uShowFolds + uCrumple * uShowCrumple));
    vec2 sp = abs((uv - 0.5) * vec2(aspect, 1.0) - off * vec2(1.0, 1.0)) - size * 0.5;
    float sd = max(sp.x, sp.y);
    shadowA = (1.0 - smoothstep(-0.01, 0.035, sd)) * 0.28;
    // Beyond the greatest possible bend and deckle, only the shadow can show.
    vec2 d = abs((s - 0.5) * size) - size * 0.5;
    float margin = abs(uDistortion) * 0.03 * uSlopeBound * short_ + 4.95 * uPixelRatio / res.y;
    if (max(d.x, d.y) > margin) {
      fragColor = vec4(0.0, 0.0, 0.0, shadowA);
      return;
    }
  }

  // Slope of the surface, from the shared height field.
  float e = 0.0025;
  vec3 h = surface(s, p, e, size, short_);
  vec2 slope = (h.yz - h.x) / e;

  // The picture bends with the sheet: it shifts along the slope, most where
  // the paper tilts, kinking at every crease and fold.
  vec2 bend = slope * uDistortion * 0.03;
  vec2 sb = s + bend / size * short_;

  // The sheet's edge: bent by the same folds, deckled on textured stocks.
  float inside = 1.0;
  if (uShowSheet > 0.5) {
    vec2 edgeP = (sb - 0.5) * size;
    // Clean-cut stocks have straight edges; mould-made ones are deckled.
    float rough = (uStock > 0.5 && uStock < 1.5) || (uStock > 4.5 && uStock < 6.5) ? 0.0 : 1.0;
    float deckle = 0.0;
    if (rough > 0.5) deckle = ((fbm(css * 0.06 + uSeed) - 0.5) * 6.0 + (noise(css * 0.5 + uSeed) - 0.5) * 1.5) / res.y * uPixelRatio;
    vec2 d2 = abs(edgeP) - size * 0.5;
    float dist = max(d2.x, d2.y) + deckle;
    float aa = 1.2 * uPixelRatio / res.y;
    inside = 1.0 - smoothstep(-aa, aa, dist);
  }

  if (inside == 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, shadowA);
    return;
  }

  // Lighting: the big surface and the stock's fine tooth together.
  float t0 = 0.0;
  vec2 tg = vec2(0.0);
  if (uTexture != 0.0) {
    t0 = tooth(css);
    tg = vec2(tooth(css + vec2(1.0, 0.0)) - t0, tooth(css + vec2(0.0, 1.0)) - t0);
  }
  vec3 n = normalize(vec3(-slope * 1.6 - tg * uTexture * 3.5, 1.0));
  float lit = dot(n, l) - l.z;

  // Paper colour: the stock, fibres, and age.
  vec3 paper = uColour * (0.97 + 0.06 * (t0 - 0.5) * uTexture);
  if (uStock > 4.5 && uStock < 5.5) {
    // Newsprint: cheap pulp, faintly grey and uneven, with dark specks.
    paper *= 0.97 + 0.05 * fbm(css * 0.02 / uScale + uSeed);
    vec2 cell = floor(css * 0.6 + uSeed);
    paper = mix(paper, paper * 0.55, step(0.992, hash12(cell)) * (1.0 - smoothstep(0.1, 0.35, length(fract(css * 0.6) - 0.5))));
  } else if (uStock > 5.5 && uStock < 6.5) {
    // Vellum: the cloudy formation of its fibres, seen as if through it.
    paper *= 0.965 + 0.06 * fbm(css * 0.012 / uScale + uSeed);
  } else if (uStock > 6.5 && uStock < 7.5) {
    // Recycled: grey mottling and flecks of colour from the paper it was,
    // small and many, each a torn scrap rather than a dot.
    paper *= 0.93 + 0.1 * fbm(css * 0.03 / uScale + uSeed);
    vec2 cp = css / uScale * 0.09 + uSeed;
    vec2 cell = floor(cp);
    vec2 fo = fract(cp) - 0.5 + 0.25 * (vec2(noise(cp * 3.0), noise(cp * 3.0 + 4.0)) - 0.5);
    float fleck = step(0.9, hash12(cell)) * (1.0 - smoothstep(0.08, 0.2, length(fo * vec2(1.0, 1.8))));
    // Faded scraps: ink and dye long since washed out, some near grey.
    vec3 hue = 0.72 + 0.16 * cos(6.2831 * (hash12(cell + 7.0) + vec3(0.0, 0.33, 0.67)));
    hue = mix(hue, vec3(0.6), step(0.5, hash12(cell + 2.0)));
    paper = mix(paper, paper * hue, fleck * 0.7);
  } else if (uStock > 7.5) {
    // Washi: long, silky fibres seen within a cloudy sheet: soft, pale
    // strands curving across it, thicker clumps of pulp between them.
    paper *= 0.95 + 0.08 * fbm(css * 0.008 / uScale + uSeed);
    float silk = 0.0;
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 1.7 + uSeed;
      mat2 turn = mat2(cos(a), sin(a), -sin(a), cos(a));
      vec2 q = turn * css / uScale * vec2(0.004, 0.09) + float(i) * 9.0;
      // Each strand wanders and curls along its length.
      q.y += 1.6 * (noise(vec2(q.x * 3.0, float(i))) - 0.5) + 0.8 * sin(q.x * 9.0 + float(i));
      float strand = abs(noise(q + 1.2 * noise(q * 0.4)) - 0.5);
      silk += (1.0 - smoothstep(0.0, 0.05, strand)) * smoothstep(0.4, 0.65, noise(css / uScale * 0.01 + float(i) * 3.0));
    }
    paper = mix(paper, paper * 1.04 + 0.02, clamp(silk, 0.0, 1.0) * 0.8);
    paper = mix(paper, paper * 0.95, smoothstep(0.6, 0.8, fbm(css * 0.02 / uScale + uSeed + 5.0)) * 0.5);
  } else if (uStock > 3.5) {
    // Kraft: streaked with the grain of its pulp and flecked with bark.
    paper *= 1.0 + (noise(css * vec2(0.03, 0.4) / uScale) - 0.5) * 0.14;
    vec2 cell = floor(css * 0.5 + uSeed);
    paper = mix(paper, paper * 0.4, step(0.985, hash12(cell)) * (1.0 - smoothstep(0.1, 0.4, length(fract(css * 0.5) - 0.5))));
  }
  if (uShowFibres > 0.5) {
    float f = fibres(css / uScale * 0.5);
    paper = mix(paper, paper * (uStock > 3.5 && uStock < 4.5 ? 0.7 : 0.9), f * 0.55);
  }
  float yellow = 0.0;
  if (uShowAge > 0.5) {
    // Yellowing, patchy and strongest towards the edges; rust-coloured
    // foxing gathered in clusters; the dried rim of a cup.
    vec2 ed = min(s, 1.0 - s) * size;
    float nearEdge = 1.0 - smoothstep(0.0, 0.12, min(ed.x, ed.y));
    yellow = uAge * (0.45 + 0.55 * fbm(css * 0.004 + uSeed)) + nearEdge * 0.4 * uAge;
    paper = mix(paper, paper * vec3(0.93, 0.8, 0.58), clamp(yellow, 0.0, 1.0));
    float cluster = smoothstep(0.62 - uAge * 0.2, 0.85, fbm(css * 0.012 + uSeed * 1.7));
    vec2 cell = floor(css / 7.0);
    vec2 at = (cell + 0.2 + 0.6 * hash22(cell + uSeed)) * 7.0;
    float speck = step(0.55, hash12(cell - uSeed)) * (1.0 - smoothstep(0.4, 1.4 + 1.6 * hash12(cell + 9.0), length(css - at)));
    paper = mix(paper, paper * vec3(0.9, 0.8, 0.66), cluster * 0.35 * uAge);
    paper = mix(paper, paper * vec3(0.62, 0.42, 0.26), speck * cluster * 0.85 * uAge);
    vec2 c = (hash22(vec2(3.1, uSeed)) * 0.5 + 0.25) * size;
    float R = short_ * 0.16;
    float rr = length((s - 0.5) * size + size * 0.5 - c) + 0.004 * (noise(s * 40.0) - 0.5);
    float rim = exp(-pow((rr - R) / 0.004, 2.0)) * smoothstep(0.25, 0.6, noise(vec2(atan(s.y - 0.5, s.x - 0.5) * 3.0, uSeed)));
    paper = mix(paper, paper * vec3(0.72, 0.55, 0.38), rim * 0.8 * uAge);
  }

  // The print: ink sits in the paper, darkening it as a filter would, so
  // white in the picture is the paper itself. On textured stock it skips a
  // little on the raised grain. Distortion moves where it is read from.
  vec4 printed = vec4(0.0);
  if (uImageReady > 0.5) {
    vec2 iuv = uShowSheet > 0.5 ? sb : 0.5 + (sb - 0.5) * vec2(1.0, 1.0);
    if (uShowSheet < 0.5) {
      float ia = uImageSize.x / max(uImageSize.y, 1.0);
      vec2 cover = ia > aspect ? vec2(aspect / ia, 1.0) : vec2(1.0, ia / aspect);
      iuv = 0.5 + (sb - 0.5) * cover;
    }
    printed = vec4(srgbToLinear(texture(uImage, clamp(iuv, 0.0, 1.0), 0.4).rgb), 1.0);
  } else {
    vec4 under = source(sb * res, 0.4);
    printed = vec4(srgbToLinear(under.rgb), under.a);
  }
  vec3 ink = mix(vec3(1.0), printed.rgb, printed.a);
  float skip = smoothstep(0.72, 0.9, t0) * uTexture * 0.2 * (uStock > 0.5 && uStock < 1.5 ? 0.3 : 1.0);
  ink = mix(ink, vec3(1.0), skip);
  // Age fades and warms the print with the paper.
  ink = mix(ink, mix(vec3(1.0), ink * vec3(1.0, 0.94, 0.85), 0.7), yellow * 0.4);
  vec3 col = paper * ink;

  // Shade in the paper's own shadow colour, and lift towards white where a
  // face turns to the light: paper is matte and never goes grey.
  vec3 tint = uShadow / max(max(uColour.r, max(uColour.g, uColour.b)), 1e-3);
  float dark = smoothstep(0.0, 0.5, -lit);
  float bright = smoothstep(0.0, 0.5, lit);
  col = mix(col, col * tint, dark);
  // Dark ink does not glare: the lift is for the paper showing through.
  float light_ = dot(ink, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, col + (1.0 - col) * 0.35, bright * light_);

  // The creases themselves: a valley fold is a fine dark line, a mountain
  // fold a pale ridge. Fibres broke along them.
  if (uShowFolds > 0.5 && uFolds > 0.0) {
    vec2 fx = foldLine(sb.x, uGrid.x, half_.x * 2.0 * res.x);
    vec2 fy = foldLine(sb.y, uGrid.y, half_.y * 2.0 * res.y);
    vec2 f = fx.x < fy.x ? fx : fy;
    float line = 1.0 - smoothstep(0.4 * uPixelRatio, 1.3 * uPixelRatio, f.x);
    float halo = 1.0 - smoothstep(0.0, 5.0 * uPixelRatio, f.x);
    float wear = smoothstep(0.3, 0.7, noise(css * 0.03 + uSeed));
    if (f.y > 0.5) col = mix(col, col * tint, (line * 0.7 + halo * 0.15) * min(uFolds * 1.5, 1.0));
    else col = mix(col, mix(col, uColour * 1.1, 0.6), (line * 0.6 + halo * 0.1 * wear) * min(uFolds * 1.5, 1.0));
  }

  // Composite: the sheet over its soft shadow, over the page.
  float alpha = uShowSheet > 0.5 ? inside : 1.0;
  vec3 outc = linearToSrgb(col) * alpha;
  float a = alpha + shadowA * (1.0 - alpha);
  fragColor = vec4(outc, a);
}
`;

const STOCKS = { cold: 0, hot: 1, rough: 2, laid: 3, kraft: 4, newsprint: 5, vellum: 6, recycled: 7, washi: 8 };
/** Panels across and down for each fold layout. */
const LAYOUTS = { half: [2, 1], letter: [1, 3], quarter: [2, 2], map: [4, 3] };

/** @type {import('./runtime.js').EffectSpec<PaperOptions>} */
export const spec = {
  defaults,
  fragment,
  alpha: true,
  dpr: 2,
  speed: () => 0,
  update(o) {
    // Facet distance has unit slope; the warp and buckle keep all four
    // octaves. These bounds leave room for their steepest possible slopes.
    const slope = (o.showFolds ? 0.255 * Math.abs(o.folds) : 0)
      + (o.showCrumple && o.crumple !== 0
        ? 0.3 * 1.1 * 1.46 * Math.abs(o.crumple) * (Math.abs(o.creases) + 4) / Math.abs(o.creases) * 1.6 / Math.abs(o.scale)
        : 0)
      + 0.1 / Math.abs(o.scale);
    return {
      uShowSheet: o.showSheet,
      uShowFibres: o.showFibres,
      uShowFolds: o.showFolds,
      uShowCrumple: o.showCrumple,
      uShowAge: o.showAge,
      uStock: STOCKS[o.stock] ?? 0,
      uTexture: o.texture,
      uScale: o.scale,
      uFolds: o.folds,
      uGrid: LAYOUTS[o.layout] ?? LAYOUTS.letter,
      uCrumple: o.crumple,
      uCreases: o.creases,
      uAge: o.age,
      uDistortion: o.distortion,
      uSlopeBound: slope,
      uLight: (o.light * Math.PI) / 180,
      uSeed: o.seed * 7.31,
      uColour: linear(o.colour),
      uShadow: linear(o.shadow),
      uInteractive: o.interactive,
    };
  },
  attach(ctx) {
    const image = texture(ctx, 'uImage', 0, { mipmaps: true });
    const p = pointer(ctx, { ease: 6 });
    return {
      update: (o) => image.set(o.image),
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
 * @param {Partial<PaperOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function paper(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
