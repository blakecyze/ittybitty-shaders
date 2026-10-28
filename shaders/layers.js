// @ts-check
/**
 * ittybitty layers
 *
 * Stacks up to five effects on one canvas, fused into a single shader. Each
 * effect's GLSL is namespaced (L0_, L1_, …) and its main() becomes a
 * function of the pixel, so a layer can blend over the ones beneath it
 * (Photoshop blend modes, in premultiplied alpha, per the W3C compositing
 * spec) or, for filter effects, read them. The stack beneath a filter is
 * drawn once into a texture first, by the same program, and the filter's
 * `source()` reads that texture instead of its image: evaluating the stack
 * afresh for every sample would multiply its cost by the filter's samples.
 * A filter's blur argument is ignored over layers, as it always has been, so
 * a stack looks the same either way. Dither a mesh gradient, halftone a
 * rainbow: one extra pass per filter.
 *
 * The finished stack can be put in a shape (container.js): the element's
 * rounded box, text or an SVG path, the same for every effect.
 *
 * https://ittybitty.dev (MIT)
 */
import { mount } from './runtime.js';
import { CONTAINER, container } from './container.js';

/** @typedef {'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'add' | 'difference' | 'color-dodge'} Blend */

/**
 * @typedef {object} Layer
 * @property {import('./runtime.js').EffectSpec<any>} effect An effect module's exported `spec`.
 * @property {object} [options] The effect's options; missing ones use its defaults.
 * @property {Blend} [blend] How the layer combines with the ones beneath. Default normal.
 * @property {number} [opacity] 0 to 1. Default 1.
 * @property {boolean} [visible] Default true.
 */

export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'add', 'difference', 'color-dodge'];
export const MAX_LAYERS = 5;

// Built-ins shared by every layer; everything else is namespaced.
const SHARED = new Set(['uResolution', 'uPixelRatio']);

const COMPOSITE = /* glsl */ `
vec3 blendMode(vec3 b, vec3 s, float m) {
  if (m < 0.5) return s;
  if (m < 1.5) return b * s;
  if (m < 2.5) return b + s - b * s;
  if (m < 3.5) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m < 4.5) {
    vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
  }
  if (m < 5.5) return min(b + s, 1.0);
  if (m < 6.5) return abs(b - s);
  return min(b / max(1.0 - s, 1e-3), 1.0);
}

vec4 composite(vec4 dst, vec4 src, float mode, float opacity) {
  src *= opacity;
  if (src.a <= 0.0) return dst;
  vec3 cs = src.rgb / src.a;
  vec3 cb = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 mixed = mix(cs, blendMode(cb, cs, mode), dst.a);
  return vec4(src.a * mixed + dst.rgb * (1.0 - src.a), src.a + dst.a * (1.0 - src.a));
}
`;

/**
 * Namespace one effect's fragment shader and turn its main() into
 * `vec4 <p>main(vec2 fragCoord)`. `below` names the function that samples the
 * layers beneath, or is empty for the bottom layer.
 *
 * @param {string} source
 * @param {string} p Prefix, e.g. 'L1_'.
 * @param {string} below
 */
export function namespace(source, p, below) {
  let body = source
    .replace(/^#version.*$/m, '')
    .replace(/^precision .*;\s*$/gm, '')
    .replace(/^out vec4 fragColor;\s*$/m, '')
    .replace(/^uniform (?:vec2 uResolution|float uPixelRatio);\s*$/gm, '');

  // Edge effects (a `// @edge` block) run along the stack's shape when it
  // has one, instead of the canvas's edge; their own distance stays the
  // fallback. Only the name and arguments are needed, not the body.
  body = body.replace(/\/\/ @edge\s*\nfloat (\w+)\(([^)]*)\)([\s\S]*?)\/\/ @end/, (_, name, args, rest) => {
    const call = args
      .split(',')
      .map((/** @type {string} */ a) => a.trim().split(/\s+/).pop())
      .join(', ');
    return `float ${name}Own(${args})${rest}float ${name}(${args}) {\n  return uIbShape > 0.5 ? ibDistance(gl_FragCoord.xy) / uPixelRatio : ${name}Own(${call});\n}\n`;
  });

  // Filters: swap the image source for the stack beneath.
  if (below) {
    body = body.replace(
      /\/\/ @source[\s\S]*?\/\/ @end/,
      // Transparent areas below read as white paper, not black.
      `vec4 source(vec2 px, float blur) {\n  vec4 b = ${below}(px, blur);\n  return vec4(b.rgb + (1.0 - b.a), 1.0);\n}`,
    );
  }

  const names = new Set();
  for (const m of body.matchAll(/^uniform\s+\w+\s+([^;]+);/gm)) {
    for (const n of m[1].split(',')) names.add(n.trim().replace(/\[.*$/, ''));
  }
  for (const m of body.matchAll(/^(?:float|int|bool|void|vec[234]|mat[234])\s+(\w+)\s*\(/gm)) if (m[1] !== 'main') names.add(m[1]);
  for (const m of body.matchAll(/^const\s+\w+\s+(\w+)/gm)) names.add(m[1]);
  for (const m of body.matchAll(/^(?:float|int|bool|vec[234]|mat[234])\s+(\w+)\s*;/gm)) names.add(m[1]);
  for (const n of names) if (!SHARED.has(n)) body = body.replace(new RegExp(`\\b${n}\\b`, 'g'), p + n);
  if (below) body = body.replace(new RegExp(`\\b${p}${below}\\b`, 'g'), below);

  body = body.replace(/\bgl_FragCoord\b/g, `${p}FC`);
  const start = body.search(/void main\(\)\s*\{/);
  let depth = 0;
  let end = start;
  for (let i = body.indexOf('{', start); i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const main = body
    .slice(start, end)
    .replace(/void main\(\)\s*\{/, `vec4 ${p}main(vec2 fragCoord) {\n  ${p}FC = vec4(fragCoord, 0.0, 1.0);\n  vec4 fragColor = vec4(0.0);`)
    .replace(/\breturn;/g, 'return fragColor;');
  return `vec4 ${p}FC;\n${body.slice(0, start)}${main}  return fragColor;\n}\n${body.slice(end + 1)}`;
}

/**
 * The fused fragment shader for a list of effect specs, bottom first.
 * @param {import('./runtime.js').EffectSpec<any>[]} specs
 */
export function compose(specs) {
  const filters = filterIndices(specs);
  let src = `#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nuniform float uPixelRatio;\nuniform float uPass;\nout vec4 fragColor;\n${COMPOSITE}\n${CONTAINER}`;
  specs.forEach((spec, i) => {
    const filter = filters.includes(i);
    // An edge effect draws round the shape, so it is not cut to it.
    const out = /\/\/ @edge\b/.test(spec.fragment) ? `L${i}_main(px)` : `ibClip(L${i}_main(px), px)`;
    src += `\n// Layer ${i}\nuniform float uBlend${i};\nuniform float uOpacity${i};\n`;
    if (filter) {
      // The stack beneath, drawn into a texture before this frame's final pass.
      src += `uniform sampler2D uStage${i};\nvec4 stage${i}(vec2 px, float blur) {\n  return textureLod(uStage${i}, px / uResolution, 0.0);\n}\n`;
    }
    src += namespace(spec.fragment, `L${i}_`, filter ? `stage${i}` : i > 0 ? `stack${i - 1}` : '');
    if (filter) {
      // A hidden filter skips its pass, so then the stack is evaluated here.
      src += `vec4 stack${i}(vec2 px) {\n  if (uOpacity${i} <= 0.0) return stack${i - 1}(px);\n  vec4 under = textureLod(uStage${i}, px / uResolution, 0.0);\n  return composite(under, ${out}, uBlend${i}, uOpacity${i});\n}\n`;
    } else {
      src += `vec4 stack${i}(vec2 px) {\n  vec4 under = ${i > 0 ? `stack${i - 1}(px)` : 'vec4(0.0)'};\n  if (uOpacity${i} <= 0.0) return under;\n  return composite(under, ${out}, uBlend${i}, uOpacity${i});\n}\n`;
    }
  });
  // uPass 0 draws the whole stack; uPass i draws the stack beneath filter i.
  const passes = filters.map((i) => `  if (uPass > ${i - 0.5} && uPass < ${i + 0.5}) { fragColor = stack${i - 1}(gl_FragCoord.xy); return; }\n`).join('');
  // Each layer is cut to the shape as it goes on; the finish lights the result once.
  return `${src}\nvoid main() {\n${passes}  fragColor = ibFinish(stack${specs.length - 1}(gl_FragCoord.xy));\n}\n`;
}

/**
 * Layers that read the stack beneath them: filters (effects with a
 * `// @source` block) above the bottom layer.
 * @param {import('./runtime.js').EffectSpec<any>[]} specs
 */
export function filterIndices(specs) {
  return specs.flatMap((s, i) => (i > 0 && /\/\/ @source/.test(s.fragment) ? [i] : []));
}

/**
 * The texture each filter reads: the stack beneath it, drawn by the same
 * program with uPass set to the filter's index, before the final pass.
 * Half-float where the device can render to it, so a filter that stretches
 * contrast (a dither, say) finds no banding; eight-bit otherwise.
 *
 * Each is drawn at the resolution the layers beneath need, not the whole
 * stack's: a sharp filter on top (a dither at a pixel ratio of 2) no longer
 * makes a soft, heavy effect beneath it render at 2 as well. The ratio is
 * the canvas's, scaled by the layers' cap against the stack's, but never
 * below their own cap or above the canvas's, so 1x screens, the resolution
 * override and adaptive resolution all behave as before.
 * @param {import('./runtime.js').Context} ctx
 * @param {number[]} filters Layer indices of the filters, bottom first.
 * @param {number[]} caps Resolution cap of the layers beneath each filter.
 * @param {number} top Resolution cap of the whole stack.
 */
function filterStages(ctx, filters, caps, top) {
  const { gl, canvas } = ctx;
  const half = !!gl.getExtension('EXT_color_buffer_float');
  // Units above the ten the layers' own textures can use.
  const units = filters.map((_, k) => 10 + k);
  /** @type {{ tex: WebGLTexture | null, fbo: WebGLFramebuffer | null, w: number, h: number }[]} */
  let targets = filters.map(() => ({ tex: null, fbo: null, w: 0, h: 0 }));
  filters.forEach((f, k) => ctx.sampler(`uStage${f}`, units[k]));

  const release = () => {
    for (const t of targets) {
      if (t.tex) gl.deleteTexture(t.tex);
      if (t.fbo) gl.deleteFramebuffer(t.fbo);
    }
    targets = filters.map(() => ({ tex: null, fbo: null, w: 0, h: 0 }));
  };

  // CSS width, measured only when the canvas's backing size changes, since
  // reading layout every frame would be wasteful.
  let css = 0;
  let sized = -1;

  return {
    /** @param {{ visible: boolean, opacity: number }[]} layers */
    draw(layers) {
      if (!filters.length) return;
      if (canvas.width !== sized) {
        sized = canvas.width;
        css = Math.max(1, canvas.clientWidth || canvas.width);
      }
      const ratio = canvas.width / css;
      let scaled = false;
      filters.forEach((f, k) => {
        const own = Math.min(ratio, Math.max(caps[k], (ratio * caps[k]) / top));
        const s = own / ratio;
        const w = Math.max(1, Math.round(canvas.width * s));
        const h = Math.max(1, Math.round(canvas.height * s));
        if (!layers[f].visible || layers[f].opacity <= 0) return;
        const t = targets[k];
        gl.activeTexture(gl.TEXTURE0 + units[k]);
        if (!t.tex || t.w !== w || t.h !== h) {
          t.tex ??= gl.createTexture();
          t.fbo ??= gl.createFramebuffer();
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          if (t.w) {
            // Storage is immutable: a new size needs a new texture.
            gl.deleteTexture(t.tex);
            t.tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t.tex);
          }
          gl.texStorage2D(gl.TEXTURE_2D, 1, half ? gl.RGBA16F : gl.RGBA8, w, h);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
          t.w = w;
          t.h = h;
        }
        // Unbound while it is drawn into, so it is never read and written at once.
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.viewport(0, 0, w, h);
        if (s < 1 || scaled) {
          ctx.uniform('uResolution', [w, h]);
          ctx.uniform('uPixelRatio', w / css);
          scaled = true;
        }
        ctx.uniform('uPass', f);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
      });
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (scaled) {
        ctx.uniform('uResolution', [canvas.width, canvas.height]);
        ctx.uniform('uPixelRatio', ratio);
      }
      ctx.uniform('uPass', 0);
    },
    restore() {
      // The context was lost with everything in it: start again.
      targets = filters.map(() => ({ tex: null, fbo: null, w: 0, h: 0 }));
      filters.forEach((f, k) => ctx.sampler(`uStage${f}`, units[k]));
    },
    destroy: release,
  };
}

/**
 * @param {HTMLCanvasElement} canvas Sized with CSS.
 * @param {Layer[]} list Bottom layer first, at most five.
 * @param {import('./runtime.js').RuntimeOptions & { shape?: import('./container.js').ShapeOptions }} [runtime]
 *   Performance settings, and the shape the stack fills (default: the whole canvas).
 */
export function layers(canvas, list, runtime = {}) {
  const { shape: startShape, ...perf } = runtime;
  if (!list.length || list.length > MAX_LAYERS) throw new Error(`ittybitty: 1 to ${MAX_LAYERS} layers`);
  const specs = list.map((l) => l.effect);
  const filters = filterIndices(specs);
  const state = list.map((l) => ({
    options: { ...l.effect.defaults, ...l.options },
    blend: l.blend ?? 'normal',
    opacity: l.opacity ?? 1,
    visible: l.visible ?? true,
  }));
  // Effects may style their own canvas (grain sets a blend mode); in a stack
  // the layer's blend does that job, so give them a stand-in.
  const standIn = /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ ({ style: {} }));
  const times = specs.map((s) => s.time ?? 0);
  let lastTime = 0;

  /** @type {import('./runtime.js').EffectSpec<{ layers: typeof state, shape?: import('./container.js').ShapeOptions }>} */
  const spec = {
    fragment: compose(specs),
    alpha: true,
    dpr: Math.max(...specs.map((s) => s.dpr ?? 1.5)),
    speed: (o) => (o.layers.some((l, i) => l.visible && (specs[i].speed ? specs[i].speed(l.options) : 1) !== 0) ? 1 : 0),
    update(o) {
      /** @type {Record<string, import('./runtime.js').UniformValue>} */
      const out = {};
      o.layers.forEach((l, i) => {
        const u = specs[i].update(l.options, standIn);
        for (const k in u) out[SHARED.has(k) ? k : `L${i}_${k}`] = u[k];
        out[`uBlend${i}`] = Math.max(0, BLENDS.indexOf(l.blend));
        out[`uOpacity${i}`] = l.visible ? l.opacity : 0;
      });
      return out;
    },
    attach(ctx) {
      const hooks = specs.map((s, i) =>
        s.attach
          ? s.attach({
              ...ctx,
              uniform: (n, v) => ctx.uniform(SHARED.has(n) ? n : `L${i}_${n}`, v),
              sampler: (n, unit) => ctx.sampler(`L${i}_${n}`, unit),
              textureUnit: (unit) => i * 2 + unit,
              options: () => current.layers[i].options,
            })
          : {},
      );
      const top = Math.max(...specs.map((s) => s.dpr ?? 1.5));
      const caps = filters.map((f) => Math.max(...specs.slice(0, f).map((s) => s.dpr ?? 1.5)));
      const stages = filterStages(ctx, filters, caps, top);
      // The shape's field takes the last texture unit, clear of the layers' and the filters'.
      const box = container(ctx, ctx.gl.getParameter(ctx.gl.MAX_TEXTURE_IMAGE_UNITS) - 1);
      return {
        update: (o) => {
          o.layers.forEach((l, i) => hooks[i].update?.(l.options));
          box.update(o.shape);
        },
        frame(dt, time) {
          // Each layer keeps its own clock, so speeds stay independent.
          const step = time - lastTime;
          lastTime = time;
          for (let i = 0; i < specs.length; i++) {
            const rate = specs[i].speed;
            times[i] += step * (rate ? rate(current.layers[i].options) : 1);
            ctx.uniform(`L${i}_uTime`, times[i]);
            hooks[i].frame?.(dt, times[i]);
          }
          stages.draw(current.layers);
        },
        // The stack may slow down only as far as every visible layer allows:
        // one that wants full rate (no cap) keeps the whole stack at it.
        fps() {
          let most = 0;
          for (let i = 0; i < specs.length; i++) {
            if (!current.layers[i].visible) continue;
            const own = hooks[i].fps?.() ?? 0;
            if (own === 0) return 0;
            most = Math.max(most, own);
          }
          return most;
        },
        restore: () => {
          box.restore();
          stages.restore();
          hooks.forEach((h) => h.restore?.());
        },
        destroy: () => {
          box.destroy();
          stages.destroy();
          hooks.forEach((h) => h.destroy?.());
        },
      };
    },
  };

  /** @type {{ layers: typeof state, shape?: import('./container.js').ShapeOptions }} */
  let current = { layers: state, shape: startShape };
  const fx = mount(canvas, spec, { ...perf, ...current });

  return {
    /**
     * Change one layer's options, or its blend, opacity and visibility.
     * @param {number} index
     * @param {{ options?: object, blend?: Blend, opacity?: number, visible?: boolean }} next
     */
    set(index, next) {
      current = {
        ...current,
        layers: current.layers.map((l, i) => (i === index ? { ...l, ...next, options: { ...l.options, ...next.options } } : l)),
      };
      fx.set(current);
    },
    /**
     * Put the stack in a shape, or change it; `{ kind: 'none' }` fills the canvas again.
     * @param {import('./container.js').ShapeOptions} next
     */
    shape(next) {
      current = { ...current, shape: { ...current.shape, ...next } };
      fx.set(current);
    },
    /**
     * Change performance settings.
     * @param {import('./runtime.js').RuntimeOptions} next
     */
    configure(next) {
      fx.set(/** @type {any} */ (next));
    },
    pause: fx.pause,
    resume: fx.resume,
    seek: fx.seek,
    destroy: fx.destroy,
    get status() {
      return fx.status;
    },
    get frames() {
      return fx.frames;
    },
    get time() {
      return fx.time;
    },
    get scale() {
      return fx.scale;
    },
  };
}
