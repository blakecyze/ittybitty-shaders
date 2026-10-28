// @ts-check
/**
 * <ittybitty-shader>: any ittybitty effect as one HTML element.
 *
 *   <script type="module" src="./ittybitty-shader.js"></script>
 *   <ittybitty-shader effect="rain" liquid="blood" amount="0.8"></ittybitty-shader>
 *
 * Put the effect files (rain.js and what it imports) next to this one. The
 * element fills its own box, so size it with CSS like any div. Every
 * attribute other than `effect` and the shape's is an option, in kebab-case:
 * numbers, true and false, and JSON for gradients are parsed; change an
 * attribute and the shader updates. Works in plain HTML and in any framework.
 *
 * Shape: put the effect in a shape with `shape` and `shape-*` attributes,
 * the options of layers.js's `shape` (see container.js), in kebab-case:
 *
 *   <ittybitty-shader effect="mesh" shape="text" shape-text="itty" shape-font="serif"></ittybitty-shader>
 *   <ittybitty-shader effect="mesh" shape="star" shape-gloss="0.6"></ittybitty-shader>
 *
 * `shape` is element (the host's own box: it inherits the host's
 * border-radius, so all four corners follow yours), text, path (with
 * shape-path), or a ready-made outline: circle, star, heart or blob. A shape
 * mounts the effect through layers.js, so add layers.js and container.js too.
 *
 * https://ittybitty.dev (MIT)
 */

/** kebab-case attribute to camelCase option. */
const camel = (/** @type {string} */ s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** @param {string} value */
function parse(value) {
  if (value === 'true' || value === '') return true;
  if (value === 'false') return false;
  if (/^-?\d*\.?\d+(e-?\d+)?$/i.test(value)) return Number(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

const RUNTIME = new Set(['dpr', 'fps', 'adaptive', 'reducedMotion']);
// Shape settings that are words, kept as written (a text of "42" stays text).
const WORDS = new Set(['text', 'font', 'path', 'fit']);
const isShape = (/** @type {string} */ name) => name === 'shape' || name.startsWith('shape-');

/** @typedef {{ layers: Function, container: { SHAPE_PATHS: Record<string, string>, shapeDefaults: object } }} Shaping */

// Safe to import where there is no DOM (server rendering, tests).
const Base = /** @type {typeof HTMLElement} */ (globalThis.HTMLElement ?? class {});

export class IttybittyShader extends Base {
  /** @type {null | { set(o: object): void, pause(): void, resume(): void, destroy(): void, shape?(o: object): void }} */
  fx = null;
  /** @type {HTMLCanvasElement} */
  canvas;
  #observer = new MutationObserver(() => this.#apply());
  #loading = '';
  #token = 0;
  /** @type {null | Shaping} */
  #shaping = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{display:block;position:relative;border-radius:inherit}canvas{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:inherit;pointer-events:none}::slotted(*){position:relative}</style><canvas part="canvas"></canvas><slot></slot>';
    this.canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('canvas'));
  }

  /** The options the attributes describe. */
  get options() {
    /** @type {Record<string, unknown>} */
    const o = {};
    for (const { name, value } of this.attributes) if (name !== 'effect' && name !== 'class' && name !== 'style' && name !== 'id' && !isShape(name)) o[camel(name)] = parse(value);
    return o;
  }

  /** The shape the attributes describe, or null for the whole box. */
  get shape() {
    const kind = this.getAttribute('shape');
    if (!kind || kind === 'none') return null;
    /** @type {Record<string, unknown>} */
    const o = { kind };
    for (const { name, value } of this.attributes) {
      if (!name.startsWith('shape-')) continue;
      const key = camel(name.slice(6));
      o[key] = WORDS.has(key) ? value : parse(value);
    }
    return o;
  }

  /** A ready-made outline by name becomes its path; every field is sent, so a removed attribute falls back to its default. */
  #resolve(/** @type {Record<string, unknown>} */ shape) {
    const { SHAPE_PATHS, shapeDefaults } = /** @type {Shaping} */ (this.#shaping).container;
    const named = SHAPE_PATHS[/** @type {string} */ (shape.kind)];
    return { ...shapeDefaults, ...shape, ...(named ? { kind: 'path', path: named } : {}) };
  }

  connectedCallback() {
    this.#observer.observe(this, { attributes: true });
    this.#start();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
    this.fx?.destroy();
    this.fx = null;
    this.#shaping = null;
    this.#loading = '';
    this.#token++;
  }

  async #start(again = false) {
    const effect = this.getAttribute('effect') ?? '';
    if (!/^[a-z-]+$/.test(effect) || (effect === this.#loading && !again)) return;
    this.#loading = effect;
    const token = ++this.#token;
    this.fx?.destroy();
    this.fx = null;
    this.#shaping = null;
    // Effects live next to this file. The base goes through a variable so
    // bundlers do not try to copy every matching file.
    const base = import.meta.url;
    const url = (/** @type {string} */ name) => new URL('./' + name + '.js', base).href;
    const shape = this.shape;
    const [mod, layers, container] = await Promise.all([
      import(/* @vite-ignore */ url(effect)),
      shape ? import(/* @vite-ignore */ url('layers')) : null,
      shape ? import(/* @vite-ignore */ url('container')) : null,
    ]);
    if (token !== this.#token || !this.isConnected) return;
    if (layers && container && shape) {
      // In a shape: one layer through layers.js, which puts it in the shape.
      this.#shaping = { layers: layers.layers, container };
      const options = this.options;
      /** @type {Record<string, unknown>} */
      const runtime = {};
      for (const k of RUNTIME) if (k in options) (runtime[k] = options[k]), delete options[k];
      const h = layers.layers(this.canvas, [{ effect: mod.spec, options }], { ...runtime, shape: this.#resolve(shape) });
      this.fx = {
        set: (/** @type {object} */ o) => h.set(0, { options: o }),
        shape: (/** @type {object} */ o) => h.shape(o),
        pause: h.pause,
        resume: h.resume,
        destroy: h.destroy,
      };
    } else {
      this.fx = mod[camel(effect)](this.canvas, this.options);
    }
    this.dispatchEvent(new Event('ready'));
  }

  #apply() {
    const shape = this.shape;
    if (this.getAttribute('effect') !== this.#loading) return this.#start();
    // A shape added or taken away starts again; so does one set while loading.
    if (!this.fx || !!shape !== !!this.#shaping) {
      if (this.fx || shape) this.#start(true);
      return;
    }
    const o = this.options;
    for (const k of RUNTIME) delete o[k];
    this.fx?.set(o);
    if (shape) this.fx?.shape?.(this.#resolve(shape));
  }
}

if (globalThis.customElements && !customElements.get('ittybitty-shader')) customElements.define('ittybitty-shader', IttybittyShader);
