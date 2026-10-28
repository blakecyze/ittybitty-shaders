// @ts-check
/**
 * ittybitty pointer helper
 *
 * Tracks the pointer relative to the canvas and hands the shader:
 *   uniform vec2  uPointer;       // eased position, 0..1 across, 0 at the bottom
 *   uniform vec2  uPointerTarget; // latest position, carried on between events
 *   uniform vec2  uPointerVelocity; // canvas widths and heights per second
 *   uniform vec2  uPointerFlow;     // the same as a gust: quick to rise, slow to die away
 *   uniform float uPointerActive; // eases to 1 while the pointer is over the canvas
 *
 * Still effects redraw only while the pointer is moving or settling. An
 * effect's `responsiveness` option (0..1) scales how closely it follows:
 * 0.5 is the effect's own feel, each 0.125 doubles or halves it, and 1
 * tracks the pointer within about 10 ms.
 *
 * https://ittybitty.dev (MIT)
 */

/**
 * @param {import("./runtime.js").Context} ctx
 * @param {{ ease?: number }} [options] Easing rate per second; higher follows faster.
 */
export function pointer(ctx, options = {}) {
  const ease = options.ease ?? 10;
  const target = [0.5, 0.5];
  const smooth = [0.5, 0.5];
  // The last reported position, when it came, and the pointer's velocity
  // (canvas widths and heights per second), filtered over a few events.
  const raw = [0.5, 0.5];
  const velocity = [0, 0];
  // The same movement as a gust: it rises as quickly as the pointer speeds
  // up, then dies away over half a second or so, the way air keeps moving.
  const flow = [0, 0];
  let at = 0;
  let over = 0;
  let active = 0;

  // The canvas's place on the page, measured only when it may have moved:
  // measuring on every event would force the browser to redo layout.
  /** @type {DOMRect | { left: number, top: number, width: number, height: number } | null} */
  let rect = null;
  const remeasure = () => {
    rect = null;
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(remeasure) : null;
  observer?.observe(ctx.canvas);

  /** @param {{ clientX: number, clientY: number, timeStamp: number }} e */
  const sample = (e) => {
    rect ??= ctx.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    const t = e.timeStamp || performance.now();
    const dt = (t - at) / 1000;
    if (over && at > 0 && dt > 0.0005 && dt < 0.1) {
      // Filtered over about 30 ms: steady, yet quick to follow a change.
      const k = 1 - Math.exp(-dt / 0.03);
      velocity[0] += ((x - raw[0]) / dt - velocity[0]) * k;
      velocity[1] += ((y - raw[1]) / dt - velocity[1]) * k;
    } else if (dt >= 0.1) {
      velocity[0] = velocity[1] = 0;
    }
    raw[0] = x;
    raw[1] = y;
    at = t;
    over = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? 1 : 0;
  };

  /** @param {PointerEvent} e */
  const move = (e) => {
    // Every movement the browser saw since the last event, not just the
    // last: steadier velocity, and nothing lost between frames.
    const all = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (all.length) for (const c of all) sample(c);
    else sample(e);
    ctx.invalidate();
  };
  const leave = () => {
    over = 0;
    velocity[0] = velocity[1] = 0;
    ctx.invalidate();
  };

  addEventListener('pointermove', move, { passive: true });
  addEventListener('scroll', remeasure, { passive: true, capture: true });
  addEventListener('resize', remeasure, { passive: true });
  document.documentElement.addEventListener('pointerleave', leave);

  return {
    /** @param {number} dt */
    frame(dt) {
      // Pointer events come at their own rate, often slower than frames:
      // between them, carry the position on along its velocity (for at most
      // a frame or so), so motion stays smooth at the display's rate instead
      // of moving on one frame and stopping the next.
      const since = at > 0 ? Math.max(0, performance.now() - at) / 1000 : 1;
      if (since > 0.08) velocity[0] = velocity[1] = 0;
      const ahead = Math.min(since, 0.02);
      target[0] = raw[0] + velocity[0] * ahead;
      target[1] = raw[1] + velocity[1] * ahead;
      const r = ctx.options?.().responsiveness;
      // At the maximum it follows within about 10 ms: exact to the eye, but
      // smooth, because pointer events arrive out of step with frames and
      // snapping to each one makes motion stutter.
      const rate = typeof r === 'number' ? (r >= 0.999 ? 100 : Math.min(100, ease * 2 ** ((r - 0.5) * 8))) : ease;
      const k = 1 - Math.exp(-rate * dt);
      smooth[0] += (target[0] - smooth[0]) * k;
      smooth[1] += (target[1] - smooth[1]) * k;
      active += (over - active) * (1 - Math.exp(-4 * dt));
      for (let i = 0; i < 2; i++) {
        const rising = Math.abs(velocity[i]) > Math.abs(flow[i]);
        flow[i] += (velocity[i] - flow[i]) * (1 - Math.exp(-dt / (rising ? 0.04 : 0.45)));
      }
      ctx.uniform('uPointer', smooth);
      ctx.uniform('uPointerTarget', target);
      ctx.uniform('uPointerVelocity', velocity);
      ctx.uniform('uPointerFlow', flow);
      ctx.uniform('uPointerActive', active);
      // Keep drawing until everything has settled.
      if (Math.abs(target[0] - smooth[0]) + Math.abs(target[1] - smooth[1]) + Math.abs(over - active) + Math.abs(velocity[0]) + Math.abs(velocity[1]) + Math.abs(flow[0]) + Math.abs(flow[1]) > 1e-3) ctx.invalidate();
    },
    /** Latest position (carried on between events) and whether the pointer is over the canvas. */
    get target() {
      return target;
    },
    /** Velocity in canvas widths and heights per second. */
    get velocity() {
      return velocity;
    },
    get over() {
      return over === 1;
    },
    destroy() {
      removeEventListener('pointermove', move);
      removeEventListener('scroll', remeasure, { capture: true });
      removeEventListener('resize', remeasure);
      document.documentElement.removeEventListener('pointerleave', leave);
      observer?.disconnect();
    },
  };
}
