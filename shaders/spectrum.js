// @ts-check
/**
 * ittybitty/spectrum
 *
 * Spectrum: light split by a prism and smeared across film. A few soft
 * beams of light arc through the frame; each is broken into its wavelengths,
 * and every wavelength lands a little further across the beam, so it opens
 * into a band of colour, violet on one side and red on the other,
 * recombining where the colours overlap again. On the way the light passes
 * through rough glass: broad folds that break the bands into patches, and a
 * fine streaky texture, dragged out along the light, that bends them and
 * varies the dispersion from place to place, so the colours mottle and
 * smear like a long exposure. A violet glow spilling past the fan, a deep
 * backdrop and film grain finish it.
 *
 * The spectrum is worked out on the CPU, sixteen wavelengths sampled from a
 * palette of OKLCH knots that mimics how film or a sensor records a
 * spectrum. The shader samples each beam once per wavelength: one pass,
 * no textures.
 *
 * https://ittybitty.dev/shaders/spectrum (MIT)
 */
import { mount, linear } from './runtime.js';
import { pointer } from './pointer.js';

/**
 * @typedef {object} SpectrumOptions
 * @property {number} speed How fast the light drifts.
 * @property {number} angle Direction the light is dragged in, in degrees.
 * @property {number} beams How many beams of light pass through.
 * @property {number} width How broad each beam is.
 * @property {number} dispersion How widely each beam fans out into its colours.
 * @property {'film' | 'vivid' | 'cool' | 'warm'} palette How the spectrum is recorded: soft film greens, vivid sensor primaries, or only its cool or warm half.
 * @property {number} hue Turns every colour of the spectrum around the colour wheel.
 * @property {boolean} glass Rough glass between the light and the film.
 * @property {number} mottle How rough the glass is: how much it bends and mottles the light.
 * @property {number} texture Size of the glass's texture. Higher is finer.
 * @property {number} smear How far the texture is dragged out along the light, like a long exposure.
 * @property {number} crinkle Creases the glass into small flat facets, like crumpled cellophane, each bending the light its own way.
 * @property {number} intensity Brightness of the light. High values burn the overlaps to white.
 * @property {string} backdrop The dark field behind the light.
 * @property {number} grain Strength of the film grain.
 * @property {boolean} interactive The light follows the pointer, as if moving the prism.
 * @property {number} responsiveness How closely it follows the pointer, 0 to 1. At 1 it tracks the pointer exactly.
 */

/** @type {SpectrumOptions} */
export const defaults = {
  speed: 0.3,
  angle: -50,
  beams: 1,
  width: 0.18,
  dispersion: 1.6,
  palette: 'film',
  hue: 0,
  glass: true,
  mottle: 0.15,
  texture: 1.5,
  smear: 0.5,
  crinkle: 0,
  intensity: 1.4,
  backdrop: '#1a3c44',
  grain: 0.06,
  interactive: true,
  responsiveness: 0.5,
};

// Wavelengths sampled per beam. More is smoother and slower.
const N = 16;

/**
 * GLSL for the Gaussians \`exp2(-(x - i dx)^2)\`, four at a time into \`e\`,
 * given x and dx, calling \`use(run)\` for the GLSL that adds each four
 * in. Neighbouring Gaussians differ by a factor that itself changes by a
 * constant factor, exp2(-2 dx^2), so only the first of every four needs an
 * exp2 of its own; the rest are products. A fresh start every four keeps a
 * far-off start from underflowing to nothing while samples further along
 * still count: with dx at most 1.6 (a beam is never narrower than 0.75 of
 * the gap between wavelengths), three samples on from an underflowed one
 * are still below 2^-40.
 * @param {number} runs Fours of samples.
 * @param {(run: number) => string} use
 */
function gaussians(runs, use) {
  const lines = ['float r = exp2(dx * (2.0 * x - dx));', 'float rr = exp2(-2.0 * dx * dx);', 'vec4 e;'];
  for (let c = 0; c < runs; c++) {
    // r holds the factor from one sample to the next, and moves on with it.
    if (c) lines.push(`x -= 4.0 * dx;`, 'r *= rr;');
    lines.push('e.x = exp2(-x * x);', 'e.y = e.x * r;', 'r *= rr;', 'e.z = e.y * r;', 'r *= rr;', 'e.w = e.z * r;');
    if (c + 1 < runs) lines.push('r *= rr;');
    lines.push(use(c));
  }
  return `      {\n${lines.map((l) => `        ${l}`).join('\n')}\n      }`;
}

/**
 * GLSL for fractal noise of a fixed number of octaves, each octave written
 * out: a software renderer runs a loop's body once more than it is asked
 * to, and with a break, every octave it might have run.
 * @param {number} octaves
 */
function fbm(octaves) {
  let body = '';
  for (let i = 0; i < octaves; i++) {
    body += `  s += ${0.5 ** (i + 1)} * noise(p);\n`;
    if (i < octaves - 1) body += '  p = turn * p + 17.1;\n';
  }
  // A turn and a scale by 2.03 between octaves, in one matrix; each
  // octave's noise centred on zero, all at once at the start.
  return `float fbm${octaves}(vec2 p) {\n  float s = ${-0.5 * (1 - 0.5 ** octaves)};\n  mat2 turn = mat2(1.624, -1.218, 1.218, 1.624);\n${body}  return s;\n}\n`;
}

export const fragment = /* glsl */ `#version 300 es
precision highp float;

#define N ${N}

uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uTime;
// Linear RGB per wavelength, violet to red, a channel at a time: red for
// wavelengths 0 to 3, 4 to 7 and so on, then green, then blue. Four to a
// vec4, none spare: a software renderer reads every uniform per pixel.
uniform vec4 uSpectrum[N * 3 / 4];
uniform vec2 uFlow;         // unit direction the light is dragged in
// Worked out once a frame on the CPU (see frameUniforms below): the
// pointer's shift of the light across and along, how far the bands arc,
// and how many beams there are.
uniform vec4 uMove;
// Each beam: its centre across the light, its brightness, which way its
// colours fan out.
uniform vec4 uBeam[4];
uniform float uWidth;
uniform float uDispersion;
uniform float uMottle;
uniform float uTexture;
uniform float uSmear;
uniform float uCrinkle;
uniform vec3 uBackdrop;     // linear
uniform float uGrain;
uniform float uAmp;         // how quickly each beam brightens and fades along it

out vec4 fragColor;

// Hash without sine, stable across GPUs (after Dave Hoskins, MIT).
float hash12(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// hash12 from its first step on: q = fract(p.xyx * 0.1031), given as (x, y).
float hashFrom(float x, float y) {
  vec3 q = vec3(x, y, x);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Value noise. Each corner shares its row and column with two others, so
// hash12's first step is worked out once per row and column.
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 x = fract(vec2(i.x, i.x + 1.0) * 0.1031);
  vec2 y = fract(vec2(i.y, i.y + 1.0) * 0.1031);
  float a = hashFrom(x.x, y.x);
  float b = hashFrom(x.y, y.x);
  float c = hashFrom(x.x, y.y);
  float d = hashFrom(x.y, y.y);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Centred on zero, roughly -0.5 to 0.5. One per octave count, each octave
// written out (see fbm() above).
${[2, 3, 4].map(fbm).join('\n')}
// Scales a linear colour's OKLab chroma by k. Scaling a and b, then going
// back, comes to mixing the cube-rooted cone responses towards lightness:
// OKLab's inverse maps lightness alone to (1, 1, 1).
vec3 chroma(vec3 c, float k) {
  vec3 lms = mat3(
    0.4122214708, 0.2119034982, 0.0883024619,
    0.5363325363, 0.6806995451, 0.2817188376,
    0.0514459929, 0.1073969566, 0.6299787005
  ) * c;
  // pow, as exp2 and log2: the same, and cheaper on a software renderer.
  lms = exp2(log2(max(lms, 0.0)) * (1.0 / 3.0));
  lms = mix(vec3(dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468))), lms, k);
  return mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193965, 1.7076147010
  ) * (lms * lms * lms);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  // pow, as exp2 and log2: the same, and cheaper on a software renderer.
  return mix(c * 12.92, 1.055 * exp2(log2(c) * (1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime;

  // The light's own frame: v runs along the light, u across it, which is
  // also the direction the prism fans the colours out in.
  vec2 nrm = vec2(-uFlow.y, uFlow.x);
  // The pointer moves the prism: the light slides across after it.
  float u = dot(p, nrm) - uMove.x;
  float v = dot(p, uFlow) - uMove.y;

  // The bands arc, like light thrown across a curved surface, and sway
  // slowly, with a broad wander so they never run ruler-straight. Rough
  // glass scatters the arc away.
  u += uMove.z * v * v;
  u += 0.45 * fbm3(vec2(v * 0.6 - t * 0.03, u * 0.4 + 3.0));

  // Rough glass, at two scales. Broad folds push the light about in both
  // directions, breaking the bands into patches; a fine streaky texture,
  // stretched along the drag by the smear, pushes it sideways and varies
  // how far it fans out, so the colours mottle inside each patch.
  vec2 fold = vec2(
    fbm3(vec2(u * 0.8, v * 1.0 - t * 0.04) + 11.0),
    fbm3(vec2(u * 0.9 + 4.0, v * 1.0 + t * 0.03) + 23.0)
  );
  u += uMottle * 1.2 * fold.x;
  v += uMottle * 0.6 * fold.y;
  float stretch = 1.0 + uSmear * 6.0;
  vec2 q = vec2(u * uTexture * 3.0, (v + t * 0.06) * uTexture * 3.0 / stretch);
  float rough = fbm4(q + vec2(0.0, t * 0.05));
  float rough2 = fbm2(q * 0.25 + vec2(5.2, 1.3 - t * 0.04));
  u += uMottle * 0.24 * rough;
  float spread = uDispersion * 0.55 * (1.0 + uMottle * 3.2 * rough2);
  // Crinkle: the glass creased into small flat facets (cells around
  // scattered points, stretched along the light by the smear). Each facet
  // is tilted its own way, so it shifts the light by its own amount and
  // fans it out by its own amount, with sharp creases between facets.
  float facetLight = 1.0;
  float glint = 0.0;
  if (uCrinkle > 0.0) {
    vec2 cq = vec2(u * 9.0, (v - t * 0.04) * 9.0 / (1.0 + uSmear * 4.0)) * uTexture;
    cq += 0.3 * vec2(rough, rough2);
    // Only the four nearest cells: points are kept near their cell centre,
    // so farther ones never win, at under half the cost of nine.
    vec2 cell = floor(cq - 0.5);
    // A soft-edged Voronoi: each facet's tilt weighted by closeness, so
    // the creases are crisp but not cut out.
    vec4 sum = vec4(0.0);
    float total = 0.0;
    // A loop tested at the end, so that a software renderer, which works
    // through this block even when the glass is smooth, then runs one cell
    // rather than four.
    int cells = uCrinkle > 0.0 ? 4 : 1;
    for (int n = 0; ; ) {
      vec2 c = cell + vec2(float(n & 1), float(n >> 1));
      vec2 d = cq - c - 0.25 - 0.5 * vec2(hash12(c), hash12(c + 17.3));
      float k = exp(-dot(d, d) * 9.0);
      sum += k * vec4(hash12(c + 3.1), hash12(c + 7.7), hash12(c + 2.2), dot(d, vec2(hash12(c + 11.9), hash12(c + 5.3)) - 0.5));
      total += k;
      if (++n >= cells) break;
    }
    sum /= max(total, 1e-4);
    u += uCrinkle * (0.16 * (sum.x - 0.5) + 0.06 * sum.w);
    spread *= 1.0 + uCrinkle * 0.5 * (sum.y - 0.5);
    facetLight = 1.0 + uCrinkle * 1.2 * (sum.z - 0.4);
    // A few facets catch the light square on and flash pale.
    glint = uCrinkle * smoothstep(0.7, 0.95, sum.z);
  }

  // Brighter towards where the light is heading.
  float source = exp(0.8 * v);
  // The glass also catches and loses light in patches.
  float catchLight = max(0.0, 1.0 + uMottle * (1.2 * fbm2(q * 1.4 + 9.0) + 1.6 * fold.y));

  // Each beam: a soft line across u, swaying, brightening and fading along
  // its length so the light arrives in patches. A touch of per-pixel
  // jitter in where each wavelength lands hides any stepping between them.
  float jitter = hash12(gl_FragCoord.xy + fract(t) * 91.0) - 0.5;
  // Further back along the light it is less focused, so the colours blur
  // into one another. Never narrower than the gap between wavelengths, or
  // the fan would break into separate copies of the beam.
  float w = max(uWidth * 0.5 * (1.0 + 0.6 * max(0.3 - v, 0.0)), abs(spread) * 0.75 / float(N));
  // Gaussians in base 2: exp(-x * x) is exp2(-(x * K)^2).
  const float K = 1.2011224087864498; // sqrt(log2(e))
  float iw = K / w;
  // Where the first wavelength lands, as a fraction of the fan.
  float first = (0.5 + jitter * 0.15) / float(N) - 0.5;
  float aRow = v * uAmp - t * 0.05;
  // The spectrum, read once: a software renderer pays for every uniform it
  // reads, per pixel.
${Array.from({ length: (N * 3) / 4 }, (_, i) => `  vec4 sp${i} = uSpectrum[${i}];`).join('\n')}
  // Each quarter of it summed, per channel, for the scatter.
  vec4 qR = vec4(${[0, 1, 2, 3].map((c) => `dot(sp${c}, vec4(1.0))`).join(', ')});
  vec4 qG = vec4(${[0, 1, 2, 3].map((c) => `dot(sp${c + N / 4}, vec4(1.0))`).join(', ')});
  vec4 qB = vec4(${[0, 1, 2, 3].map((c) => `dot(sp${c + N / 2}, vec4(1.0))`).join(', ')});
  vec3 light = vec3(0.0);
  // Tested at the end, not the start: a software renderer runs a loop's
  // body once more, with every pixel masked off, to find out a test at the
  // start has failed. There is always at least one beam.
  int beams = int(uMove.w);
  for (int k = 0; ; ) {
    // Beams step off past one another's red edge, each a little dimmer, so
    // one spectrum leads; with three or more, every other one is mirrored,
    // as if reflected in the glass (see frameUniforms).
    vec4 B = uBeam[k];
    float a = max((0.3 + 1.4 * noise(vec2(aRow, float(k) * 7.3))) * B.y, 0.0);
    float fan = spread * B.z;
    float du = u - B.x;
    // Unless nothing of this beam reaches here.
    if (abs(du) <= abs(fan) * 0.6 + 7.0 * w && a > 0.0) {
      // Sample the beam once per wavelength, each shifted along u by its
      // place in the spectrum: violet lands one side, red the other.
      vec3 sum = vec3(0.0);
      float x = (du - fan * first) * iw;
      float dx = fan / float(N) * iw;
${gaussians(N / 4, (c) => `sum += vec3(dot(e, sp${c}), dot(e, sp${c + N / 4}), dot(e, sp${c + N / 2}));`)}
      // A wide, faint scatter around it, as on film. It is soft enough to
      // sample four wavelengths at a time: each quarter of the spectrum,
      // a quarter as strong as the core and mostly greyed, since scattered
      // light has lost most of its colour.
      const float H = 0.3872983346207417; // sqrt(0.15)
      x = (du + fan * 0.375) * iw * H;
      dx = fan * 0.25 * iw * H;
${gaussians(1, () => 'vec3 h = vec3(dot(e, qR), dot(e, qG), dot(e, qB));\nsum += 0.1 * h + 0.05 * (h.r + h.g + h.b);')}
      // Violet spills past the edge of the fan, as a soft glow pooled in
      // the dark beside it.
      float gx = (du + fan * 0.58) / (w * 0.9 + 0.05);
      sum += vec3(sp0.x, sp${N / 4}.x, sp${N / 2}.x) * (3.0 * exp(-gx * gx));
      light += a * sum;
    }
    if (++k >= beams) break;
  }
  // Darker towards the corners, as through a lens.
  float vignette = 1.0 - 0.45 * smoothstep(0.3, 1.2, length(p * vec2(0.8, 1.2)));
  light *= catchLight * facetLight * source * vignette;
  light += glint * 0.6 * dot(light, vec3(0.33));

  // The backdrop, lifting and falling in slow pools.
  // Lighter towards the top right, deepest in the lower left.
  float pool = smoothstep(-0.35, 0.45, fbm2(p * 0.9 + vec2(t * 0.02, 4.0)) + p.y * 0.35 + p.x * 0.2);
  vec3 bg = uBackdrop * (0.25 + 1.5 * pool);

  // Light covers the backdrop rather than adding to it, so the spectral
  // colours stay pure where they fall; overlaps burn softly towards white.
  float cover = exp(-dot(light, vec3(2.0)));
  vec3 colour = 1.0 - exp(-(bg * cover + light) * 1.15);
  // Film stock: rich colour where the light is strong, muted and grey in
  // the haze and shadows around it.
  colour = linearToSrgb(chroma(colour, mix(0.65, 1.35, smoothstep(0.03, 0.3, max(light.r, max(light.g, light.b))))));

  // Film grain, strongest in the midtones, in CSS pixels.
  vec2 g = floor(gl_FragCoord.xy / uPixelRatio);
  float n = hash12(g + fract(t * 7.0) * 113.0) + hash12(g * 1.37 + 41.0) - 1.0;
  float lum = dot(colour, vec3(0.3, 0.55, 0.15));
  colour += n * (uGrain * (0.35 + 0.65 * 4.0 * lum * (1.0 - lum)) + 1.0 / 255.0);
  fragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/** OKLab to linear RGB, for building the spectrum on the CPU. */
function fromOklab(/** @type {number} */ L, /** @type {number} */ a, /** @type {number} */ b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.max(c, 0));
}

// Each palette is the spectrum as one kind of film or sensor records it,
// violet to red: knots of position, OKLCH hue, lightness, chroma and
// brightness, and what the whole spectrum adds up to (linear RGB), which is
// the colour light turns where every wavelength overlaps.
const PALETTES = {
  // Colour negative: green takes the most room, with narrow cyan and
  // yellow either side, faded ends, and overlaps that recombine into a cool
  // green rather than flat white.
  film: {
    white: [0.8, 1.2, 0.5],
    knots: [
      [0, 305, 0.48, 0.2, 0.9],
      [0.06, 268, 0.5, 0.21, 0.95],
      [0.12, 240, 0.58, 0.17, 1],
      [0.18, 205, 0.64, 0.13, 1],
      [0.26, 160, 0.64, 0.19, 1],
      [0.58, 140, 0.66, 0.21, 1],
      [0.7, 112, 0.76, 0.2, 0.9],
      [0.79, 88, 0.8, 0.18, 0.6],
      [0.9, 58, 0.72, 0.19, 0.25],
      [1, 30, 0.55, 0.19, 0.05],
    ],
  },
  // A digital sensor: broad blue, green and red with quick crossings
  // between them, and overlaps that burn to clean white.
  vivid: {
    white: [1, 1, 1],
    knots: [
      [0, 300, 0.42, 0.2, 0.8],
      [0.08, 268, 0.45, 0.24, 1],
      [0.28, 262, 0.5, 0.22, 1],
      [0.36, 215, 0.66, 0.12, 0.7],
      [0.42, 148, 0.7, 0.22, 1],
      [0.68, 140, 0.74, 0.22, 1],
      [0.73, 95, 0.84, 0.16, 0.45],
      [0.78, 50, 0.68, 0.2, 0.9],
      [0.92, 28, 0.6, 0.21, 0.9],
      [1, 15, 0.5, 0.19, 0.4],
    ],
  },
  // Only the cool half: violet through blue and teal to green.
  cool: {
    white: [0.6, 1, 1.1],
    knots: [
      [0, 292, 0.42, 0.2, 0.8],
      [0.2, 275, 0.5, 0.21, 1],
      [0.42, 235, 0.62, 0.16, 1],
      [0.6, 190, 0.72, 0.13, 1],
      [0.8, 155, 0.74, 0.2, 1],
      [1, 130, 0.78, 0.2, 0.7],
    ],
  },
  // Only the warm half: gold through orange and red to magenta.
  warm: {
    white: [1.2, 0.8, 0.6],
    knots: [
      [0, 340, 0.5, 0.2, 0.7],
      [0.2, 15, 0.58, 0.21, 1],
      [0.42, 40, 0.68, 0.19, 1],
      [0.62, 65, 0.78, 0.17, 1],
      [0.8, 90, 0.86, 0.17, 1],
      [1, 105, 0.9, 0.14, 0.6],
    ],
  },
};

/**
 * Position along a palette's knots, interpolated.
 * @param {number[][]} knots
 * @param {number} s 0 violet to 1 red.
 */
function along(knots, s) {
  let k = 1;
  while (k < knots.length - 1 && knots[k][0] < s) k++;
  const a = knots[k - 1];
  const b = knots[k];
  const f = (s - a[0]) / (b[0] - a[0]);
  return [1, 2, 3, 4].map((j) => a[j] + (b[j] - a[j]) * f);
}

// Filled on option changes, never per frame.
// A channel at a time, as the shader reads them: red for every
// wavelength, then green, then blue.
const spectrumData = new Float32Array(N * 3);

/**
 * The palette sampled at each wavelength, turned around the colour wheel,
 * then scaled per channel so the whole spectrum adds up to the palette's
 * white: where the colours overlap again they recombine into it.
 * The light's brightness is folded in here too.
 * @param {keyof typeof PALETTES} name
 * @param {number} turn Hue rotation in degrees.
 * @param {number} intensity
 */
function buildSpectrum(name, turn, intensity) {
  const { knots, white } = PALETTES[name] ?? PALETTES.film;
  const sum = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const [h, L, C, fall] = along(knots, (i + 0.5) / N);
    const a = ((h + turn) * Math.PI) / 180;
    const rgb = fromOklab(L, C * Math.cos(a), C * Math.sin(a));
    for (let c = 0; c < 3; c++) {
      spectrumData[c * N + i] = rgb[c] * fall;
      sum[c] += rgb[c] * fall;
    }
  }
  // A channel the palette barely has is not blown up to match: it would
  // tint every colour with it.
  const floor = 0.35 * Math.max(sum[0], sum[1], sum[2]);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) spectrumData[c * N + i] *= (white[c] / Math.max(sum[c], floor)) * intensity;
  }
  return spectrumData;
}

/**
 * Everything about the beams that is the same for every pixel, worked out
 * once a frame: the pointer's pull on the light, the arc, and each beam's
 * centre, brightness and direction. Allocates nothing.
 * @param {SpectrumOptions} o
 * @param {number} t Effect time in seconds.
 * @param {number} aspect Canvas width over height.
 * @param {number} px Eased pointer, 0..1 across.
 * @param {number} py Eased pointer, 0..1 up.
 * @param {number} active How far the pointer is over the canvas, 0..1.
 * @param {Float32Array} move
 * @param {Float32Array} beam
 */
function frameUniforms(o, t, aspect, px, py, active, move, beam) {
  const a = (o.angle * Math.PI) / 180;
  const fx = Math.cos(a), fy = Math.sin(a);
  // The pointer moves the prism: the light slides across after it.
  const pull = (o.interactive ? 1 : 0) * active;
  const ax = (px - 0.5) * aspect, ay = py - 0.5;
  const mottle = o.glass ? o.mottle : 0;
  const beams = Math.min(4, Math.max(1, Math.round(o.beams)));
  move[0] = (ax * -fy + ay * fx) * 0.4 * pull;
  move[1] = (ax * fx + ay * fy) * 0.3 * pull;
  move[2] = (0.25 + 0.08 * Math.sin(t * 0.05)) * Math.max(1 - mottle * 0.8, 0);
  move[3] = beams;
  // Beams step off past one another's red edge, each a little dimmer, so
  // one spectrum leads. Two keep the first near the middle; more spread
  // evenly either side, and every other one is mirrored, as if reflected
  // in the glass, so neighbours meet red to red or violet to violet.
  const many = beams > 2.5 ? 1 : 0;
  const gap = o.dispersion * (many ? 0.38 : 0.45) + o.width * 0.5;
  for (let k = 0; k < 4; k++) {
    beam[k * 4] = (k - (many ? 0.5 : 0.1) * (beams - 1)) * gap + 0.12 * Math.sin(t * 0.07 + k * 2.4);
    beam[k * 4 + 1] = 1 - 0.6 * ((k * 0.618 + 0.3) % 1);
    beam[k * 4 + 2] = 1 - 2 * (k % 2) * many;
  }
}

/** @type {import('./runtime.js').EffectSpec<SpectrumOptions>} */
export const spec = {
  defaults,
  fragment,
  attach(ctx) {
    // The pointer's eased values, caught on their way to the shader.
    const look = [0.5, 0.5, 0];
    const p = pointer(
      {
        ...ctx,
        uniform(name, value) {
          if (name === 'uPointer') {
            const v = /** @type {ArrayLike<number>} */ (value);
            look[0] = v[0];
            look[1] = v[1];
          } else if (name === 'uPointerActive') look[2] = Number(value);
        },
      },
      { ease: 2.5 },
    );
    const move = new Float32Array(4);
    const beam = new Float32Array(16);
    let o = defaults;
    return {
      update(next) {
        o = next;
      },
      frame(dt, time) {
        p.frame(dt);
        frameUniforms(o, time, ctx.canvas.width / Math.max(1, ctx.canvas.height), look[0], look[1], look[2], move, beam);
        ctx.uniform('uMove', move);
        ctx.uniform('uBeam', beam);
      },
      destroy: p.destroy,
    };
  },
  // Everything in it is soft, and the grain is drawn per CSS pixel anyway,
  // so a pixel ratio of 1 looks the same at well under half the cost.
  dpr: 1,
  time: 0,
  speed: (o) => o.speed,
  update(o) {
    const a = (o.angle * Math.PI) / 180;
    const mottle = o.glass ? o.mottle : 0;
    return {
      uSpectrum: buildSpectrum(o.palette, o.hue, o.intensity),
      uFlow: [Math.cos(a), Math.sin(a)],
      uWidth: o.width,
      uDispersion: o.dispersion,
      uMottle: mottle,
      uAmp: 1.3 + mottle * 1.5,
      uTexture: o.texture,
      uSmear: o.smear,
      uCrinkle: o.glass ? o.crinkle : 0,
      uBackdrop: linear(o.backdrop),
      uGrain: o.grain,
    };
  },
};

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Partial<SpectrumOptions> & import('./runtime.js').RuntimeOptions} [options]
 */
export function spectrum(canvas, options = {}) {
  return mount(canvas, spec, { ...defaults, ...options });
}
