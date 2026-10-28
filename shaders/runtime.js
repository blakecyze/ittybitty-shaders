// @ts-check
/**
 * ittybitty runtime
 *
 * Draws one fullscreen fragment shader into a canvas with WebGL2 and keeps it
 * cheap: the backing store follows the canvas size with a capped pixel ratio,
 * rendering stops when the canvas is offscreen or the tab is hidden, reduced
 * motion shows a still frame, and nothing is allocated per frame.
 *
 * Built-in uniforms available to every shader:
 *   uniform vec2  uResolution;  // backing-store size in device pixels
 *   uniform float uPixelRatio;  // device pixels per CSS pixel actually used
 *   uniform float uTime;        // effect time in seconds, scaled by speed
 *
 * https://ittybitty.dev (MIT)
 */

/**
 * Numbers are floats, booleans become 0 or 1, arrays of 2 to 4 are vectors,
 * and a longer Float32Array fills a `vec4[]` uniform array.
 * @typedef {number | boolean | ArrayLike<number>} UniformValue
 */

/**
 * What an effect's `attach` hook receives, for helpers such as texture.js
 * and pointer.js that need the GL context or per-frame work.
 * @typedef {object} Context
 * @property {WebGL2RenderingContext} gl
 * @property {HTMLCanvasElement} canvas
 * @property {(name: string, value: UniformValue) => void} uniform Set a uniform on the current program.
 * @property {(name: string, unit: number) => void} sampler Point a sampler uniform at a texture unit.
 * @property {() => void} invalidate Request a redraw, even while paused or still.
 * @property {(unit: number) => number} textureUnit Map a helper's texture unit to a free one.
 * @property {() => Record<string, unknown>} [options] The effect's current options, for helpers that read them.
 */

/**
 * @template {object} O
 * @typedef {object} Hooks
 * @property {(options: O) => void} [update] After options change.
 * @property {(dt: number, time: number) => void} [frame] Before each draw: wall-clock dt and effect time, in seconds. Must not allocate.
 * @property {() => void} [restore] After the WebGL context is restored.
 * @property {() => void} [destroy] On destroy().
 * @property {() => number} [fps] A frame-rate cap that may change from frame to frame, such as
 *   full rate only while the pointer is over the canvas. 0 for none. Fixed caps still apply.
 */

/**
 * @template {object} O
 * @typedef {object} EffectSpec
 * @property {string} fragment GLSL ES 3.00 fragment shader.
 * @property {O} [defaults] The effect's default options, for layers.js.
 * @property {(options: O, canvas: HTMLCanvasElement) => Record<string, UniformValue>} update
 *   Maps options to uniforms. Called on mount and on every `set()`, never per frame.
 * @property {(options: O) => number} [speed] Time multiplier. 0 renders a still frame.
 * @property {(options: O) => number} [fps] Frame-rate cap. Omit for display rate.
 * @property {number} [time] Effect time of the first frame, in seconds.
 * @property {number} [dpr] Default device-pixel-ratio cap.
 * @property {boolean} [alpha] Transparent canvas (premultiplied alpha).
 * @property {(context: Context) => Hooks<O>} [attach] Optional extras: textures, pointer, live inputs.
 */

/**
 * @typedef {object} RuntimeOptions
 * @property {number} [dpr] Maximum device pixel ratio for the backing store.
 * @property {number} [fps] Frame-rate cap. Omit for the display's rate.
 * @property {boolean} [adaptive] Lower the resolution while frames run late, and restore it when they recover.
 * @property {boolean} [reducedMotion] Override the `prefers-reduced-motion` media query.
 */

/**
 * @typedef {'running' | 'paused' | 'still' | 'hidden' | 'offscreen' | 'lost' | 'unsupported' | 'destroyed'} Status
 */

/**
 * @template {object} O
 * @typedef {object} Effect
 * @property {(options: Partial<O>) => void} set Update options. Re-renders if not animating.
 * @property {() => void} pause Stop animating. The current frame stays visible.
 * @property {() => void} resume Animate again, even when reduced motion is preferred.
 * @property {(seconds: number) => void} seek Jump to an effect time and draw it.
 * @property {() => void} destroy Stop everything and release GPU resources.
 * @property {Status} status Why the effect is, or is not, rendering.
 * @property {number} frames Frames drawn so far.
 * @property {number} time Current effect time in seconds.
 * @property {number} scale Adaptive resolution scale, 1 when at full quality.
 */

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * Mount a fullscreen shader effect on a canvas.
 *
 * @template {object} O
 * @param {HTMLCanvasElement} canvas
 * @param {EffectSpec<O>} spec
 * @param {O & RuntimeOptions} options
 * @returns {Effect<O>}
 */
export function mount(canvas, spec, options) {
  let opts = { ...options };
  const alpha = spec.alpha ?? false;
  const gl = canvas.getContext('webgl2', {
    alpha,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  });

  /** @type {WebGLProgram | null} */
  let program = null;
  // Shaders compile in the background where the browser allows it
  // (KHR_parallel_shader_compile): until then the program is not ready, and
  // uniforms and samplers set meanwhile wait here instead of blocking the page.
  // Extension objects belong to one context: ask again after a restore.
  let parallel = gl?.getExtension('KHR_parallel_shader_compile') ?? null;
  let ready = false;
  /** @type {WebGLShader[]} */
  let shaders = [];
  /** @type {Map<string, UniformValue>} */
  const pendingUniforms = new Map();
  /** @type {Map<string, number>} */
  const pendingSamplers = new Map();
  /** @type {Map<string, WebGLUniformLocation | null>} */
  const locations = new Map();

  let time = spec.time ?? 0;
  let speed = 1;
  let minInterval = 0;
  let last = 0;
  let lastDraw = -Infinity;
  let raf = 0;
  let timer = 0;
  let frames = 0;
  let dirty = true;
  // Adaptive resolution: a smoothed frame interval against the fastest seen.
  let scale = 1;
  let smoothed = 0;
  let fastest = Infinity;
  let slowFor = 0;
  let fastFor = 0;
  // CSS size comes from the ResizeObserver, so drawing never forces layout.
  let cssWidth = canvas.clientWidth;
  let cssHeight = canvas.clientHeight;

  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let playing = !(opts.reducedMotion ?? motionQuery.matches);
  let paused = false;
  let onscreen = true;
  let lost = false;
  let destroyed = false;

  /** @param {string} name @param {UniformValue} value */
  const uniform = (name, value) => {
    if (!gl) return;
    if (!ready) {
      pendingUniforms.set(name, value);
      return;
    }
    let loc = locations.get(name);
    if (loc === undefined) locations.set(name, (loc = gl.getUniformLocation(/** @type {WebGLProgram} */ (program), name)));
    if (loc === null) return;
    const type = uniformType(value);
    if (type === 'float') gl.uniform1f(loc, Number(value));
    else {
      const v = /** @type {ArrayLike<number>} */ (value);
      if (type === 'vec2') gl.uniform2f(loc, v[0], v[1]);
      else if (type === 'vec3') gl.uniform3f(loc, v[0], v[1], v[2]);
      else if (type === 'vec4') gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
      else gl.uniform4fv(loc, /** @type {Float32Array} */ (value));
    }
  };

  /** @type {Hooks<O>} */
  let hooks = {};

  const apply = () => {
    const uniforms = spec.update(opts, canvas);
    for (const name in uniforms) uniform(name, uniforms[name]);
    speed = spec.speed ? spec.speed(opts) : 1;
    const own = spec.fps ? spec.fps(opts) : 0;
    const cap = opts.fps ?? 0;
    const fps = own > 0 && cap > 0 ? Math.min(own, cap) : own || cap;
    minInterval = fps > 0 ? 1000 / fps : 0;
    hooks.update?.(opts);
  };

  /** @param {number} type @param {string} source */
  const compile = (type, source) => {
    const g = /** @type {WebGL2RenderingContext} */ (gl);
    const shader = /** @type {WebGLShader} */ (g.createShader(type));
    g.shaderSource(shader, source);
    g.compileShader(shader);
    return shader;
  };

  // Once linked: report errors, then use the program and send everything
  // that was set while it compiled.
  const finish = () => {
    const g = /** @type {WebGL2RenderingContext} */ (gl);
    const p = /** @type {WebGLProgram} */ (program);
    if (!g.getProgramParameter(p, g.LINK_STATUS) && !g.isContextLost()) {
      const bad = shaders.find((sh) => !g.getShaderParameter(sh, g.COMPILE_STATUS));
      throw new Error(bad ? `ittybitty: shader failed to compile\n${g.getShaderInfoLog(bad)}` : `ittybitty: program failed to link\n${g.getProgramInfoLog(p)}`);
    }
    // Shaders are no longer needed once linked.
    for (const sh of shaders) g.deleteShader(sh);
    shaders = [];
    g.useProgram(p);
    locations.clear();
    ready = true;
    // Queued values first (from helpers such as textures and the pointer),
    // then the current options on top, so the newest values win.
    for (const [name, value] of pendingUniforms) uniform(name, value);
    for (const [name, unit] of pendingSamplers) {
      const loc = g.getUniformLocation(p, name);
      if (loc) g.uniform1i(loc, unit);
    }
    pendingUniforms.clear();
    pendingSamplers.clear();
    // Force resize() to re-send the size uniforms to this program.
    canvas.width = canvas.height = 0;
    apply();
  };

  const setup = () => {
    const g = /** @type {WebGL2RenderingContext} */ (gl);
    ready = false;
    shaders = [compile(g.VERTEX_SHADER, VERTEX), compile(g.FRAGMENT_SHADER, spec.fragment)];
    program = /** @type {WebGLProgram} */ (g.createProgram());
    for (const sh of shaders) g.attachShader(program, sh);
    g.linkProgram(program);
    const ext = parallel;
    if (!ext) return finish();
    // Ask each frame whether the driver has finished; asking for the link
    // result directly would make the page wait for it.
    const poll = () => {
      if (destroyed || lost || !program) return;
      if (g.getProgramParameter(program, ext.COMPLETION_STATUS_KHR)) {
        finish();
        invalidate();
      } else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  };

  const resize = () => {
    const g = /** @type {WebGL2RenderingContext} */ (gl);
    const ratio = Math.min(devicePixelRatio || 1, opts.dpr ?? spec.dpr ?? 1.5) * scale;
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    g.viewport(0, 0, width, height);
    uniform('uResolution', [width, height]);
    uniform('uPixelRatio', width / Math.max(1, cssWidth));
    return true;
  };

  let lastHook = 0;
  const draw = () => {
    const g = /** @type {WebGL2RenderingContext} */ (gl);
    dirty = false;
    resize();
    uniform('uTime', time);
    if (hooks.frame) {
      const now = performance.now();
      hooks.frame(Math.min(Math.max(now - (lastHook || now), 0), 100) / 1000, time);
      lastHook = now;
    }
    g.drawArrays(g.TRIANGLES, 0, 3);
    frames++;
  };

  const animating = () => playing && !paused && speed !== 0;
  const visible = () => !destroyed && !lost && ready && onscreen && !document.hidden;

  /**
   * Adaptive resolution. Frames arriving well behind the fastest interval seen
   * (and slower than 60 fps) for a second mean the device is struggling: drop
   * resolution by 15%.
   * Three seconds on time: restore 10%. Arithmetic only, no allocation.
   * @param {number} interval
   * @param {number} cap The frame interval asked for, 0 for none.
   */
  const adapt = (interval, cap) => {
    if (!opts.adaptive || interval <= 0 || interval > 250) return;
    fastest = Math.min(fastest * 1.0005, interval);
    smoothed = smoothed ? smoothed * 0.9 + interval * 0.1 : interval;
    // Never below 60 fps's worth: on a 120 Hz screen, a steady 60 is smooth,
    // not a device struggling, and must not cost resolution.
    const budget = Math.max(fastest, cap, 1000 / 60);
    if (smoothed > budget * 1.3) {
      fastFor = 0;
      if ((slowFor += interval) > 1000 && scale > 0.4) {
        scale = Math.max(0.4, scale * 0.85);
        slowFor = 0;
      }
    } else if (smoothed < budget * 1.08) {
      slowFor = 0;
      if ((fastFor += interval) > 3000 && scale < 1) {
        scale = Math.min(1, scale * 1.1);
        fastFor = 0;
      }
    }
  };

  // The frame interval right now: the fixed caps, or a hook's own while it
  // asks for less.
  const interval = () => {
    const live = hooks.fps?.() ?? 0;
    return live > 0 ? Math.max(minInterval, 1000 / live) : minInterval;
  };

  /** @param {number} now */
  const frame = (now) => {
    raf = 0;
    if (!visible()) return;
    if (animating()) {
      // Clamp the step so returning to the tab does not jump the animation.
      time += (Math.min(Math.max(now - last, 0), 100) / 1000) * speed;
      const cap = interval();
      if (cap === 0) adapt(now - last, cap);
      else if (lastDraw > 0 && now - lastDraw >= cap - 1) adapt(now - lastDraw, cap);
      last = now;
      if (now - lastDraw < cap - 1) return next(now);
      lastDraw = now;
      next(now);
      draw();
    } else if (dirty) {
      draw();
    }
  };

  // With a frame-rate cap, sleep until the next frame is nearly due instead
  // of waking on every display frame (four times over at 120 Hz for 30 fps).
  /** @param {number} now */
  const next = (now) => {
    const cap = interval();
    const wait = cap > 0 ? lastDraw + cap - now - 6 : 0;
    if (wait > 4) {
      timer = window.setTimeout(() => {
        timer = 0;
        raf = requestAnimationFrame(frame);
      }, wait);
    } else raf = requestAnimationFrame(frame);
  };

  const schedule = () => {
    if (raf || timer || !visible()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(timer);
    timer = 0;
  };

  const invalidate = () => {
    dirty = true;
    schedule();
  };

  const onVisibility = () => (document.hidden ? stop() : schedule());

  /** @param {MediaQueryListEvent} e */
  const onMotion = (e) => {
    if (opts.reducedMotion !== undefined) return;
    playing = !e.matches;
    invalidate();
  };

  /** @param {Event} e */
  const onLost = (e) => {
    e.preventDefault();
    lost = true;
    program = null;
    stop();
  };

  const onRestored = () => {
    lost = false;
    parallel = gl?.getExtension('KHR_parallel_shader_compile') ?? null;
    setup();
    hooks.restore?.();
    invalidate();
  };

  const intersection = new IntersectionObserver(
    (entries) => {
      onscreen = entries[entries.length - 1].isIntersecting;
      if (onscreen) schedule();
      else stop();
    },
    { rootMargin: '64px' },
  );

  const resizer = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1].contentRect;
    cssWidth = box.width;
    cssHeight = box.height;
    // Resizing clears the canvas, so redraw in the same frame to avoid a flash.
    if (visible() && resize()) draw();
    else invalidate();
  });

  if (gl) {
    setup();
    if (spec.attach) {
      hooks = spec.attach({
        gl,
        canvas,
        uniform,
        sampler: (name, unit) => {
          if (!ready) return void pendingSamplers.set(name, unit);
          const loc = program && gl.getUniformLocation(program, name);
          if (loc) gl.uniform1i(loc, unit);
        },
        invalidate: () => invalidate(),
        textureUnit: (unit) => unit,
        options: () => opts,
      });
      hooks.update?.(opts);
    }
    intersection.observe(canvas);
    resizer.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    motionQuery.addEventListener('change', onMotion);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    schedule();
  }

  return {
    set(next) {
      if (!gl || destroyed) return;
      opts = { ...opts, ...next };
      if (program) apply();
      invalidate();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      playing = true;
      schedule();
    },
    seek(seconds) {
      time = seconds;
      // Still compiling: draw as soon as it is ready, not into nothing now.
      if (gl && program && ready && !destroyed) draw();
      else invalidate();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      intersection.disconnect();
      resizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener('change', onMotion);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      hooks.destroy?.();
      if (gl && program) gl.deleteProgram(program);
      program = null;
      locations.clear();
    },
    get status() {
      if (destroyed) return 'destroyed';
      if (!gl) return 'unsupported';
      if (lost) return 'lost';
      if (paused) return 'paused';
      if (!playing || speed === 0) return 'still';
      if (document.hidden) return 'hidden';
      if (!onscreen) return 'offscreen';
      return 'running';
    },
    get frames() {
      return frames;
    },
    get time() {
      return time;
    },
    get scale() {
      return scale;
    },
  };
}

/**
 * How a value is uploaded: numbers and booleans as one float (true is 1),
 * arrays of 2 to 4 as a vector, longer arrays as a `vec4[]`. The runtime and
 * anything that exports its uniforms share this, so they never disagree.
 *
 * @param {UniformValue} value
 * @returns {'float' | 'vec2' | 'vec3' | 'vec4' | 'vec4[]'}
 */
export function uniformType(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return 'float';
  return value.length === 2 ? 'vec2' : value.length === 3 ? 'vec3' : value.length === 4 ? 'vec4' : 'vec4[]';
}

/**
 * The numbers a value uploads as, in the shape `uniformType` names.
 *
 * @param {UniformValue} value
 * @returns {number | number[]}
 */
export function uniformData(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  return Array.from(value);
}

/**
 * Convert a `#rrggbb` colour to linear-light RGB, ready for blending in a shader.
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function linear(hex) {
  const n = parseInt(hex.slice(1), 16);
  /** @param {number} c */
  const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/**
 * Linear RGB to OKLab (Björn Ottosson), for perceptually even colour mixing.
 * Runs on option changes only, never per pixel.
 *
 * @param {[number, number, number]} rgb
 * @returns {[number, number, number]}
 */
export function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** @typedef {[position: number, color: string][]} Gradient */

/** Most stops a gradient can have; matches the uStop0…uStop5 uniforms. */
export const MAX_STOPS = 6;

/**
 * Pack gradient stops as uniforms `uStop0`…`uStop5` (OKLab colour, position)
 * and `uStopCount`. A single stop is a solid colour.
 *
 * @param {Gradient} stops
 * @returns {Record<string, UniformValue>}
 */
export function gradient(stops) {
  const sorted = [...stops].sort((a, b) => a[0] - b[0]).slice(0, MAX_STOPS);
  /** @type {Record<string, UniformValue>} */
  const out = { uStopCount: sorted.length };
  sorted.forEach(([position, color], i) => {
    out[`uStop${i}`] = [...oklab(linear(color)), position];
  });
  // Unused stops repeat the last colour past the end, so shaders can blend
  // through all six without a loop or a count.
  const last = /** @type {number[]} */ (out[`uStop${sorted.length - 1}`]);
  for (let i = sorted.length; i < MAX_STOPS; i++) out[`uStop${i}`] = [last[0], last[1], last[2], 2];
  return out;
}
