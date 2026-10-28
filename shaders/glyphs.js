// @ts-check
/**
 * ittybitty glyphs
 *
 * A strip of characters, darkest to densest, drawn once into a texture so a
 * shader can render text-mode dithering: one texture read per pixel.
 * The shader receives `<name>` (the atlas) and `<name>Count`.
 *
 * https://ittybitty.dev (MIT)
 */
import { texture } from './texture.js';

/** Character ramps, from empty to full. */
export const GLYPHS = {
  ascii: ' .:-=+*#%@',
  braille: '⠀⠁⠃⠇⡇⣇⣧⣷⣿',
  blocks: ' ░▒▓█',
};

const CELL = 48;

/**
 * @param {import("./runtime.js").Context} ctx
 * @param {string} name Sampler uniform name, e.g. 'uGlyphs'.
 * @param {number} unit
 */
export function glyphs(ctx, name, unit) {
  const tex = texture(ctx, name, unit);
  const canvas = document.createElement('canvas');
  let current = '';
  return {
    /** @param {keyof typeof GLYPHS} set */
    set(set) {
      const chars = [...(GLYPHS[set] ?? GLYPHS.ascii)];
      if (set === current) return;
      current = set;
      canvas.width = CELL * chars.length;
      canvas.height = CELL;
      const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      c.fillStyle = '#000';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = '#fff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `${CELL * 0.92}px ui-monospace, Menlo, Consolas, "Apple Braille", "Segoe UI Symbol", monospace`;
      chars.forEach((ch, i) => c.fillText(ch, CELL * (i + 0.5), CELL * 0.54));
      tex.set(canvas);
      ctx.uniform(`${name}Count`, chars.length);
    },
    restore: tex.restore,
    destroy: tex.destroy,
  };
}
