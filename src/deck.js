// Pure swipe-deck state. No DOM and no chrome.* so it can be tested with plain node.
// Mirrors Sweep's SweepViewModel: a swipe only records a decision; nothing is deleted here.

export const KEEP = "keep";
export const BIN = "bin";
export const TRASHED = "trashed";
export const ARCHIVE = "archive";
export const ARCHIVED = "archived";
export const LOCK = "lock";
export const LOCKED = "locked";

/** Marked-but-not-yet-done decisions, and what each becomes once Google has carried it out. */
export const PENDING = { [BIN]: TRASHED, [ARCHIVE]: ARCHIVED, [LOCK]: LOCKED };
const isPending = (d) => Object.hasOwn(PENDING, d);

export const MEDIA_MODES = ["all", "videos", "photos"];

/** "all" | "photos" | "videos" filter on an item's kind. */
export function matchesMedia(kind, media) {
  if (media === "videos") return kind === "video";
  if (media === "photos") return kind !== "video";
  return true;
}

export class SweepDeck {
  /** @param {Record<string, {d: string, at: number}>} decisions persisted from a previous session */
  constructor(decisions = {}, now = () => Date.now()) {
    this.decisions = { ...decisions };
    this.now = now;
    this.items = new Map();
    this.queue = [];
    this.index = 0;
    this.history = [];
    this.filter = () => true;
  }

  /**
   * Limits which items are offered for review (e.g. a date range). Items outside it
   * are still remembered, so widening the filter brings them back without rescanning.
   */
  setFilter(filter) {
    this.filter = filter || (() => true);
    // Only decided items stay in the reviewed prefix; undone ones are re-offered if they match.
    const reviewed = this.queue.slice(0, this.index).filter((id) => this.decisions[id]);
    const seen = new Set(reviewed);
    const pending = [...this.items.values()]
      .filter((item) => !seen.has(item.id) && !this.decisions[item.id] && this.filter(item))
      .map((item) => item.id);
    this.queue = [...reviewed, ...pending];
    this.index = reviewed.length;
  }

  /** Adds grid items in page order. Returns how many became reviewable. */
  add(items) {
    let added = 0;
    for (const item of items) {
      if (!item?.id || this.items.has(item.id)) continue;
      this.items.set(item.id, item);
      const decision = this.decisions[item.id];
      if (decision?.d === TRASHED || decision?.d === LOCKED) {
        // Still in the library after we sent it to trash or the Locked Folder: that was
        // undone or failed, so it deserves a fresh decision rather than silently vanishing.
        delete this.decisions[item.id];
      } else if (isPending(decision?.d)) {
        this.decisions[item.id] = { ...decision, ...snapshot(item) };
        continue;
      } else if (decision) {
        continue;
      }
      if (!this.filter(item)) continue;
      this.queue.push(item.id);
      added += 1;
    }
    return added;
  }

  get current() {
    return this.items.get(this.queue[this.index]) || null;
  }

  upcoming(count = 3) {
    return this.queue.slice(this.index, this.index + count).map((id) => this.items.get(id));
  }

  get remaining() {
    return this.queue.length - this.index;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  /**
   * `expectedId` guards against stale input: a fling animation that commits after
   * the top card changed (undo, filter change) must not decide a different item.
   */
  keep(expectedId) {
    return this.#decide(KEEP, expectedId);
  }

  bin(expectedId) {
    return this.#decide(BIN, expectedId);
  }

  archive(expectedId) {
    return this.#decide(ARCHIVE, expectedId);
  }

  lock(expectedId) {
    return this.#decide(LOCK, expectedId);
  }

  #decide(d, expectedId) {
    const item = this.current;
    if (!item || (expectedId !== undefined && item.id !== expectedId)) return null;
    const previous = this.decisions[item.id];
    this.decisions[item.id] = isPending(d) ? { d, at: this.now(), ...snapshot(item) } : { d, at: this.now() };
    this.history.push({ id: item.id, previous });
    this.index += 1;
    return item.id;
  }

  undo() {
    const last = this.history.pop();
    if (!last) return null;
    if (last.group) return this.#undoGroup(last);
    if (last.previous) this.decisions[last.id] = last.previous;
    else delete this.decisions[last.id];

    if (this.queue[this.index - 1] === last.id && this.#offered(last.id)) {
      this.index -= 1;
    } else {
      this.#requeue(last.id);
    }
    return last.id;
  }

  /**
   * Decides a whole duplicate group at once; undone as a unit. Decisions carry
   * `dup: true` so a group reviewed once is not offered again.
   */
  resolveGroup(keepIds, binIds) {
    const ids = [...keepIds, ...binIds];
    const previous = Object.fromEntries(ids.map((id) => [id, this.decisions[id]]));
    const at = this.now();
    for (const id of keepIds) this.decisions[id] = { d: KEEP, at, dup: true };
    for (const id of binIds) {
      const item = this.items.get(id);
      this.decisions[id] = { d: BIN, at, dup: true, ...(item ? snapshot(item) : this.decisions[id]) };
    }
    const decided = new Set(ids);
    this.queue = [...this.queue.slice(0, this.index), ...this.queue.slice(this.index).filter((id) => !decided.has(id))];
    this.history.push({ group: ids, previous });
    return ids;
  }

  get lastIsGroup() {
    return Boolean(this.history.at(-1)?.group);
  }

  #undoGroup(entry) {
    for (const id of entry.group) {
      if (entry.previous[id]) this.decisions[id] = entry.previous[id];
      else delete this.decisions[id];
    }
    for (const id of [...entry.group].reverse()) {
      if (!this.decisions[id]) this.#requeue(id);
    }
    return entry.group;
  }

  /** Takes an item back out of the basket (bin, archive or locked) and puts it at the top of the deck. */
  unmark(id) {
    if (!isPending(this.decisions[id]?.d)) return false;
    delete this.decisions[id];
    this.history = this.history.filter((entry) => !mentions(entry, id));
    this.#requeue(id);
    return true;
  }

  /** Whether an undecided item belongs in the deck under the current filter. */
  #offered(id) {
    const item = this.items.get(id);
    return Boolean(item) && this.filter(item);
  }

  /** Puts an undecided item back on top, or out of the pending queue if the filter excludes it. */
  #requeue(id) {
    if (this.#offered(id)) {
      this.#moveToFront(id);
      return;
    }
    const position = this.queue.indexOf(id);
    if (position === -1) return;
    this.queue.splice(position, 1);
    if (position < this.index) this.index -= 1;
  }

  /**
   * Forgets the items of the previous page (album, search) but keeps every decision,
   * so a new view starts with its own grid order and nothing from the old one.
   */
  resetView() {
    this.items = new Map();
    this.queue = [];
    this.index = 0;
    this.history = [];
  }

  /** Drops every keep decision so those items are offered again; returns how many. */
  forgetKept() {
    const kept = Object.keys(this.decisions).filter((id) => this.decisions[id].d === KEEP);
    for (const id of kept) delete this.decisions[id];
    this.resetView();
    return kept.length;
  }

  #moveToFront(id) {
    const position = this.queue.indexOf(id);
    if (position !== -1) {
      this.queue.splice(position, 1);
      if (position < this.index) this.index -= 1;
    }
    this.queue.splice(this.index, 0, id);
  }

  /** Items marked for one action (bin by default), oldest decision first. */
  basket(kind = BIN) {
    return Object.entries(this.decisions)
      .filter(([, entry]) => entry.d === kind)
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => a.at - b.at);
  }

  /** Records a confirmed trash. These can no longer be undone from the deck. */
  markTrashed(ids) {
    this.markDone(ids, TRASHED);
  }

  /** Records that Google carried out an action (trashed, archived, locked); no longer undoable. */
  markDone(ids, done) {
    const finished = new Set(ids);
    const at = this.now();
    for (const id of finished) this.decisions[id] = { d: done, at };
    this.history = this.history.filter((entry) => ![...finished].some((id) => mentions(entry, id)));
  }

  stats() {
    let kept = 0;
    let binned = 0;
    let trashed = 0;
    const count = {};
    for (const entry of Object.values(this.decisions)) {
      if (entry.d === KEEP) kept += 1;
      else if (entry.d === BIN) binned += 1;
      else if (entry.d === TRASHED) trashed += 1;
      count[entry.d] = (count[entry.d] || 0) + 1;
    }
    return {
      kept,
      binned,
      trashed,
      toArchive: count[ARCHIVE] || 0,
      archived: count[ARCHIVED] || 0,
      toLock: count[LOCK] || 0,
      locked: count[LOCKED] || 0,
      loaded: this.items.size, remaining: this.remaining, reviewed: this.history.length };
  }

  toJSON() {
    return this.decisions;
  }
}

const mentions = (entry, id) => (entry.group ? entry.group.includes(id) : entry.id === id);

// Binned items are shown in the basket even in a later session, before the grid
// has scrolled back to them, so they carry enough to render a thumbnail.
function snapshot(item) {
  const kept = { thumb: item.thumb, href: item.href, label: item.label, kind: item.kind };
  if (item.from) kept.from = item.from;
  if (typeof item.ts === "number") kept.ts = item.ts;
  return kept;
}
