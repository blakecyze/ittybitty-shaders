// @ts-check
/**
 * ittybitty ripple helper
 *
 * A small wave simulation the pointer can disturb, the way interactive water
 * is usually done (Evan Wallace's WebGL Water, three.js's GPGPU water, the
 * jQuery Ripples plugin): a height field in a texture, stepped by the wave
 * equation a fixed number of times a second. Pressing the surface along the
 * pointer's path leaves a wake behind it, V-shaped when it moves quickly; a
 * click presses harder, and the rings run out and fade. The cost is one
 * small pass per step however much is going on, and nothing when the water
 * is still.
 *
 * The shader receives `<name>` (r: height, g: velocity, b and a: the slope
 * across and up) and `<name>Ready`, 0 where the device cannot render to
 * half-float textures (the water then simply ignores the pointer).
 *
 * https://ittybitty.dev (MIT)
 */

const RIPPLE_VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const RIPPLE_STEP = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uAspect;
uniform vec4 uBrush;       // from, to (0..1)
uniform vec2 uPress;       // radius (canvas heights), depth
out vec4 state;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uState, uv);
  float l = texture(uState, uv - vec2(uTexel.x, 0.0)).r;
  float r = texture(uState, uv + vec2(uTexel.x, 0.0)).r;
  float d = texture(uState, uv - vec2(0.0, uTexel.y)).r;
  float u = texture(uState, uv + vec2(0.0, uTexel.y)).r;
  // Each point accelerates towards the average of its neighbours; a little
  // friction lets the rings die away, and a slow pull levels the surface.
  float avg = (l + r + d + u) * 0.25;
  s.g += (avg - s.r) * 2.0;
  s.g *= 0.994;
  // A touch of smoothing stops the grid's own jitter building up, so rings
  // stay clean instead of scratchy.
  s.r = mix(s.r + s.g, avg, 0.04) * 0.999;
  // Fade out near the edges instead of bouncing back.
  vec2 edge = min(uv, 1.0 - uv) / (uTexel * 6.0);
  s.r *= clamp(min(edge.x, edge.y), 0.0, 1.0);
  // Press along the segment the pointer moved over since the last step.
  if (uPress.y != 0.0) {
    vec2 k = vec2(uAspect, 1.0);
    vec2 pa = uv * k - uBrush.xy * k;
    vec2 ba = (uBrush.zw - uBrush.xy) * k;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    float x = length(pa - ba * t) / uPress.x;
    if (x < 1.0) s.r -= uPress.y * (0.5 + 0.5 * cos(3.14159 * x));
  }
  state = vec4(s.r, s.g, r - l, u - d);
}`;

/**
 * @param {import("./runtime.js").Context} ctx
 * @param {string} name Sampler uniform name, e.g. 'uRipple'.
 * @param {number} unit Texture unit, 0 to 7.
 * @param {{ cells?: number, rate?: number }} [options] Cells across the shorter side, and steps per second.
 */
export function ripple(ctx, name, unit, options = {}) {
  const { gl, canvas } = ctx;
  unit = ctx.textureUnit(unit);
  const cells = options.cells ?? 256;
  const rate = options.rate ?? 120;
  const ready = `${name}Ready`;
  /** @type {WebGLProgram | null} */
  let program = null;
  /** @type {(WebGLTexture | null)[]} */
  let textures = [null, null];
  /** @type {(WebGLFramebuffer | null)[]} */
  let buffers = [null, null];
  /** @type {Record<string, WebGLUniformLocation | null>} */
  let at = {};
  let current = 0;
  let width = 0;
  let height = 0;
  let ok = false;
  let owed = 0;
  // Energy left in the water: stepping stops once it has all died away.
  let stirred = 0;
  // Pending presses: the segment moved since the last step, and its depth.
  const brush = [0, 0, 0, 0];
  let depth = 0;
  let radius = 0.02;
  let drop = 0;
  const dropAt = [0, 0];

  const build = () => {
    ok = false;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.shaderSource(vs, RIPPLE_VERTEX);
    gl.compileShader(vs);
    gl.shaderSource(fs, RIPPLE_STEP);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    at = {};
    for (const u of ['uState', 'uTexel', 'uAspect', 'uBrush', 'uPress']) at[u] = gl.getUniformLocation(program, u);
    ok = true;
  };

  const size = () => {
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1) || 1;
    const w = Math.round(aspect >= 1 ? cells * aspect : cells);
    const h = Math.round(aspect >= 1 ? cells : cells / aspect);
    if (w === width && h === height && textures[0]) return;
    width = w;
    height = h;
    for (let i = 0; i < 2; i++) {
      if (textures[i]) gl.deleteTexture(textures[i]);
      if (buffers[i]) gl.deleteFramebuffer(buffers[i]);
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      textures[i] = tex;
      buffers[i] = fb;
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  build();

  return {
    /**
     * Press the surface along the pointer's path since the last call.
     * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 From and to, 0..1 across the canvas, 0 at the bottom.
     * @param {number} strength How hard, 0..1.
     * @param {number} size Radius of the press, in canvas heights.
     */
    stroke(x0, y0, x1, y1, strength, size) {
      if (depth === 0) {
        brush[0] = x0;
        brush[1] = y0;
      }
      brush[2] = x1;
      brush[3] = y1;
      depth = Math.max(depth, strength);
      radius = size;
      stirred = 1;
      ctx.invalidate();
    },
    /** A single hard press, as from a click. @param {number} x @param {number} y 0..1. @param {number} strength */
    drop(x, y, strength) {
      dropAt[0] = x;
      dropAt[1] = y;
      drop = strength;
      stirred = 1;
      ctx.invalidate();
    },
    /**
     * Step the simulation for a frame's worth of time. Call from the effect's
     * frame hook; it restores the effect's program, framebuffer and viewport.
     * @param {number} dt Seconds since the last frame.
     * @returns {boolean} Whether the water is still moving.
     */
    frame(dt) {
      if (!ok) {
        ctx.uniform(ready, 0);
        return false;
      }
      size();
      if (!ok || stirred <= 0) return false;
      owed = Math.min(owed + dt * rate, 6);
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (owed >= 1) {
        const effect = gl.getParameter(gl.CURRENT_PROGRAM);
        gl.useProgram(program);
        gl.uniform1i(at.uState, unit);
        gl.uniform2f(at.uTexel, 1 / width, 1 / height);
        gl.uniform1f(at.uAspect, width / height);
        gl.viewport(0, 0, width, height);
        while (owed >= 1) {
          owed -= 1;
          if (drop > 0) {
            gl.uniform4f(at.uBrush, dropAt[0], dropAt[1], dropAt[0], dropAt[1]);
            gl.uniform2f(at.uPress, 0.02, drop * 3.0);
            drop = 0;
          } else if (depth > 0) {
            gl.uniform4f(at.uBrush, brush[0], brush[1], brush[2], brush[3]);
            gl.uniform2f(at.uPress, radius, depth * 0.45);
            brush[0] = brush[2];
            brush[1] = brush[3];
            depth = 0;
          } else {
            gl.uniform2f(at.uPress, radius, 0);
          }
          gl.bindTexture(gl.TEXTURE_2D, textures[current]);
          gl.bindFramebuffer(gl.FRAMEBUFFER, buffers[1 - current]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          current = 1 - current;
        }
        gl.useProgram(effect);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, textures[current]);
      ctx.sampler(name, unit);
      ctx.uniform(ready, 1);
      // Rings last a few seconds; keep drawing until they have gone.
      stirred -= dt / 8;
      ctx.invalidate();
      return true;
    },
    /** Re-create after a WebGL context restore. */
    restore() {
      textures = [null, null];
      buffers = [null, null];
      width = height = 0;
      build();
    },
    destroy() {
      for (let i = 0; i < 2; i++) {
        if (textures[i]) gl.deleteTexture(textures[i]);
        if (buffers[i]) gl.deleteFramebuffer(buffers[i]);
      }
      if (program) gl.deleteProgram(program);
      program = null;
      ok = false;
    },
  };
}
