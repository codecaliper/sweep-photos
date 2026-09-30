// Duplicate detection by perceptual hash. Pure functions only: this module is
// imported by both the service worker (hashing) and the content script (grouping).
//
// dHash: shrink to 9x8 greyscale and record, per row, whether each pixel is
// brighter than its right neighbour. 64 bits that survive re-encoding, resizing
// and small exposure changes, so re-uploads and burst shots land a few bits apart.

export const HASH_WIDTH = 9;
export const HASH_HEIGHT = 8;
export const STRICT = 4;
export const LOOSE = 10;

// A flat image (all black, all white, a blank screenshot) hashes to all zeros and
// would "match" every other flat image, so it carries no signal.
const NO_SIGNAL = "0000000000000000";

/** @param {ArrayLike<number>} rgba 9x8 RGBA pixels, row-major */
export function dhashFromRgba(rgba) {
  const grey = new Float64Array(HASH_WIDTH * HASH_HEIGHT);
  for (let i = 0; i < grey.length; i += 1) {
    grey[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  let hex = "";
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    let byte = 0;
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      const i = y * HASH_WIDTH + x;
      byte = (byte << 1) | (grey[i] > grey[i + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function popcount(value) {
  let x = value >>> 0;
  let count = 0;
  while (x) {
    x &= x - 1;
    count += 1;
  }
  return count;
}

const split = (hex) => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];

export function hamming(a, b) {
  const [aHi, aLo] = split(a);
  const [bHi, bLo] = split(b);
  return popcount(aHi ^ bHi) + popcount(aLo ^ bLo);
}

/**
 * Groups entries whose hashes are within `threshold` bits, transitively.
 * @param {{id: string, hash: string}[]} entries in display order
 * @returns {string[][]} groups of 2+ ids, each in display order, ordered by first member
 */
export function findGroups(entries, threshold) {
  const usable = entries.filter((entry) => /^[0-9a-f]{16}$/.test(entry?.hash || "") && entry.hash !== NO_SIGNAL);
  const hi = new Uint32Array(usable.length);
  const lo = new Uint32Array(usable.length);
  usable.forEach((entry, i) => {
    [hi[i], lo[i]] = split(entry.hash);
  });

  const parent = usable.map((_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      if (popcount(hi[i] ^ hi[j]) + popcount(lo[i] ^ lo[j]) > threshold) continue;
      const a = root(i);
      const b = root(j);
      // Lower index wins, so every group is rooted at its first member.
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }

  const groups = new Map();
  usable.forEach((entry, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(entry.id);
  });
  return [...groups.values()].filter((ids) => ids.length > 1);
}
