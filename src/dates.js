// Date parsing and range checks. Pure, so it can be tested with plain node.
//
// Google Photos puts the capture date in each grid item's aria-label, formatted for
// the account's locale: "Photo - Landscape - 3 Sept 2026, 16:12:07" (en-GB) or
// "Photo - Landscape - Sep 3, 2026, 4:12:07 PM" (en-US). English month names only.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const monthIndex = (name) => MONTHS.indexOf(String(name).slice(0, 3).toLowerCase());

/** Local-time epoch ms for the date in a label, or null if there isn't one. */
export function parseLabelDate(text) {
  const value = String(text || "");
  let day;
  let month;
  let year;

  const dayFirst = value.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  const monthFirst = value.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (dayFirst && monthIndex(dayFirst[2]) !== -1) {
    [day, month, year] = [Number(dayFirst[1]), monthIndex(dayFirst[2]), Number(dayFirst[3])];
  } else if (monthFirst && monthIndex(monthFirst[1]) !== -1) {
    [day, month, year] = [Number(monthFirst[2]), monthIndex(monthFirst[1]), Number(monthFirst[3])];
  } else {
    return null;
  }
  if (day < 1 || day > 31) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  const time = value.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (time) {
    hours = Number(time[1]) % 24;
    minutes = Number(time[2]);
    seconds = Number(time[3] || 0);
    const meridiem = time[4]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  }
  return new Date(year, month, day, hours, minutes, seconds).getTime();
}

/** "2026-09-03" -> local midnight epoch ms; `plusDays` walks calendar days, so DST is handled. */
function dayStart(iso, plusDays = 0) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, month - 1, day + plusDays).getTime();
}

/** Epoch-ms bounds for an {from, to} range of "YYYY-MM-DD" strings; `to` is inclusive. */
export function rangeBounds(range) {
  return {
    start: range?.from ? dayStart(range.from) : -Infinity,
    end: range?.to ? dayStart(range.to, 1) : Infinity,
  };
}

export const hasRange = (range) => Boolean(range?.from || range?.to);

/** Undated items are left out whenever a range is set, since there's nothing to test. */
export function inRange(ts, range) {
  if (!hasRange(range)) return true;
  if (ts === null || ts === undefined) return false;
  const { start, end } = rangeBounds(range);
  return ts >= start && ts < end;
}

const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function presetRange(name, today = new Date()) {
  const year = today.getFullYear();
  const daysAgo = (n) => isoDay(new Date(year, today.getMonth(), today.getDate() - n));
  switch (name) {
    case "30d": return { from: daysAgo(29), to: isoDay(today) };
    case "90d": return { from: daysAgo(89), to: isoDay(today) };
    case "thisYear": return { from: `${year}-01-01`, to: isoDay(today) };
    case "lastYear": return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default: return { from: null, to: null };
  }
}

export function formatRange(range) {
  if (!hasRange(range)) return "All dates";
  const format = (iso) => new Date(dayStart(iso)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  if (range.from && range.to) return `${format(range.from)} – ${format(range.to)}`;
  return range.from ? `From ${format(range.from)}` : `Until ${format(range.to)}`;
}

/**
 * The main Photos timeline is newest-first, so in that order a visible item older
 * than the range start means nothing further down can be in range. Albums may be
 * oldest-first, so this only fires when the page has been seen to be descending.
 */
export function isPastRange(orderedTimestamps, visibleTimestamps, range) {
  if (!range?.from) return false;
  const known = orderedTimestamps.filter((ts) => ts !== null);
  const visible = visibleTimestamps.filter((ts) => ts !== null);
  if (known.length < 2 || !visible.length || known[0] < known[known.length - 1]) return false;
  return visible[visible.length - 1] < rangeBounds(range).start;
}

/**
 * True when everything visible is newer than the range end on a descending page,
 * so the grid can be scrolled in big jumps without skipping anything in range.
 */
export function isBeforeRange(orderedTimestamps, visibleTimestamps, range) {
  if (!range?.to || !visibleTimestamps.length || visibleTimestamps.some((ts) => ts === null)) return false;
  const known = orderedTimestamps.filter((ts) => ts !== null);
  if (known.length >= 2 && known[0] < known[known.length - 1]) return false;
  if (visibleTimestamps[0] < visibleTimestamps[visibleTimestamps.length - 1]) return false;
  return Math.min(...visibleTimestamps) >= rangeBounds(range).end;
}

/**
 * Where a screenful of a newest-first grid sits relative to `bound` (ms):
 * "newer" (all at or after it), "older" (all before it), "inside" (straddles it),
 * or "unknown" (nothing dated on screen yet).
 */
export function placeVisible(timestamps, bound) {
  const dated = timestamps.filter((ts) => typeof ts === "number");
  if (!dated.length) return "unknown";
  if (Math.min(...dated) >= bound) return "newer";
  if (Math.max(...dated) < bound) return "older";
  return "inside";
}

/**
 * Binary search over scroll positions of a newest-first grid for the last position whose
 * screen is still entirely newer than the target date. Landing there (never past it) means
 * walking on from it can't skip anything in range. `probe(pos)` scrolls, waits for tiles and
 * returns placeVisible(); `extent()` is the current scrollable height (it can grow as Google
 * learns more of the library).
 */
export async function bisectScroll({ probe, from, extent, step, maxProbes = 32 }) {
  let lo = from;
  let ceiling = extent();
  let hi = ceiling;
  let probes = 0;
  while (probes < maxProbes) {
    if (hi - lo <= step) {
      // Converged against the bottom of the grid, which may have grown meanwhile: widen and carry on.
      const grown = extent();
      if (hi < ceiling || grown <= ceiling) break;
      ceiling = grown;
      hi = grown;
    }
    const mid = Math.round((lo + hi) / 2);
    const place = await probe(mid);
    probes += 1;
    if (place === "newer") {
      lo = mid;
    } else if (place === "older" || place === "inside") {
      hi = mid;
    } else {
      break;
    }
  }
  return { position: lo, probes };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A Google Photos search that covers the whole range, or null when none fits. Google's
 * search understands a month ("January 2020") or a year ("2020"), which cuts the grid down
 * to that period at once; Sweep's own date filter then trims it to the exact days.
 */
export function searchQueryFor(range) {
  if (!range?.from || !range?.to) return null;
  const [fromYear, fromMonth] = range.from.split("-").map(Number);
  const [toYear, toMonth] = range.to.split("-").map(Number);
  if (!fromYear || fromYear !== toYear) return null;
  if (fromMonth === toMonth) return `${MONTH_NAMES[fromMonth - 1]} ${fromYear}`;
  return String(fromYear);
}

/** The Google Photos URL to sweep a range from: its search page when one fits, else the timeline. */
export function sweepUrlFor(range, { useSearch = true } = {}) {
  const query = useSearch ? searchQueryFor(range) : null;
  return query ? `https://photos.google.com/search/${encodeURIComponent(query)}` : "https://photos.google.com/";
}

/** { from, to } for an <input type="month"> value such as "2020-01". */
export function monthRange(value) {
  const [year, month] = String(value || "").split("-").map(Number);
  if (!year || !month) return null;
  return { from: isoDay(new Date(year, month - 1, 1)), to: isoDay(new Date(year, month, 0)) };
}
