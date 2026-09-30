// Test data for the mock Google Photos page: a descending timeline of photos and
// videos, some of which are near-duplicates, plus a tiny PNG encoder for thumbnails.
import { deflateSync } from "node:zlib";

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

/** Google's en-GB tile label: "Photo - Landscape - 3 Sept 2026, 16:12:07". */
export function tileLabel(kind, date) {
  const when = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${kind === "video" ? "Video" : "Photo"} - Landscape - ${when}`;
}

/**
 * Items newest first, one every 9 days back from 10 Sept 2026 12:00 local time.
 * Items 3+4 and 20+21+22 are near-duplicates (same image seed); every 7th is a video.
 */
export function makeItems(count = 60) {
  const start = new Date(2026, 8, 10, 12, 0, 0).getTime();
  const dupeSeed = { 4: 3, 21: 20, 22: 20 };
  return Array.from({ length: count }, (_, i) => {
    const kind = i % 7 === 6 ? "video" : "photo";
    const date = new Date(start - i * 9 * DAY);
    return { id: `AF1QipMock${pad(i)}`, index: i, kind, seed: dupeSeed[i] ?? i, tweak: i in dupeSeed ? 6 : 0, ts: date.getTime(), label: tileLabel(kind, date) };
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes an RGB (or, with `alpha`, RGBA) pixel function as a PNG. */
export function encodePng(width, height, pixel, { alpha = false } = {}) {
  const channels = alpha ? 4 : 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      for (let c = 0; c < channels; c += 1) row[1 + x * channels + c] = Math.round(rgba[c] ?? 255);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Deterministic PRNG so every run serves identical images. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A blurry grid of random blocks, distinct per seed. `tweak` shifts brightness and
 * adds a little noise, like a re-encoded copy of the same photo.
 */
export function patternPng(seed, tweak = 0, size = 96) {
  const random = mulberry32(seed * 7919 + 17);
  const GRID = 6;
  const cells = Array.from({ length: (GRID + 1) * (GRID + 1) }, () => random() * 200 + 28);
  const noise = mulberry32(seed * 31 + tweak);
  const at = (gx, gy) => cells[Math.min(GRID, gy) * (GRID + 1) + Math.min(GRID, gx)];
  return encodePng(size, size, (x, y) => {
    const fx = (x / size) * GRID;
    const fy = (y / size) * GRID;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    const jitter = tweak ? (noise() - 0.5) * 2 : 0;
    const level = Math.max(0, Math.min(255, Math.round(top * (1 - ty) + bottom * ty + tweak + jitter)));
    return [level, Math.round(level * 0.7 + (seed % 5) * 12), 255 - level];
  });
}
