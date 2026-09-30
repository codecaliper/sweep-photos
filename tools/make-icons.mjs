// Draws the toolbar icon (a card being swiped off a stack) at every size Chrome asks for.
// Run: node tools/make-icons.mjs
import { writeFileSync } from "node:fs";
import { encodePng } from "../e2e/fixtures.mjs";

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

/** Signed distance to a rounded rectangle centred at the origin. */
function roundedBox(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function rotate(x, y, cx, cy, degrees) {
  const a = (degrees * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)];
}

const over = (base, [r, g, b], a) => [base[0] * (1 - a) + r * a, base[1] * (1 - a) + g * a, base[2] * (1 - a) + b * a, base[3] + (1 - base[3]) * a];

/** Colour at a point in a 1x1 unit square. */
function shade(u, v) {
  let color = [0, 0, 0, 0];
  const inside = (d) => (d < 0 ? 1 : 0);
  // Background tile: blue to violet.
  if (inside(roundedBox(u - 0.5, v - 0.5, 0.5, 0.5, 0.22))) {
    const t = (u + v) / 2;
    color = [26 + 90 * t, 115 - 40 * t, 232 - 10 * t, 1];
  }
  // Back card, tilted left, faded.
  const [bx, by] = rotate(u, v, 0.44, 0.54, -12);
  if (inside(roundedBox(bx, by, 0.2, 0.26, 0.05))) color = over(color, [255, 255, 255], 0.45);
  // Front card, tilted right and shifted as if mid-swipe.
  const [fx, fy] = rotate(u, v, 0.58, 0.5, 14);
  if (inside(roundedBox(fx, fy, 0.2, 0.26, 0.05))) {
    color = over(color, [255, 255, 255], 1);
    // A little landscape: sun and hill in Google-ish colours.
    if (Math.hypot(fx - 0.07, fy + 0.12) < 0.05) color = over(color, [251, 188, 4], 1);
    if (fy > 0.1 - 0.35 * Math.abs(fx + 0.02) + 0.06 && fy < 0.22) color = over(color, [52, 168, 83], 1);
  }
  return color;
}

for (const size of SIZES) {
  const png = encodePng(size, size, (x, y) => {
    let sum = [0, 0, 0, 0];
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const [r, g, b, a] = shade((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size);
        sum = [sum[0] + r * a, sum[1] + g * a, sum[2] + b * a, sum[3] + a];
      }
    }
    const a = sum[3] / (SAMPLES * SAMPLES);
    return a ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3], a * 255] : [0, 0, 0, 0];
  }, { alpha: true });
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), png);
}
console.log(`wrote icons/icon{${SIZES.join(",")}}.png`);
