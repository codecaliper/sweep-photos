import { ARCHIVE, ARCHIVED, BIN, LOCK, LOCKED, MEDIA_MODES, PENDING, SweepDeck, TRASHED, matchesMedia } from "./deck.js";
import { formatRange, hasRange, inRange, rangeBounds, isBeforeRange, isPastRange, presetRange } from "./dates.js";
import { LOOSE, STRICT, findGroups } from "./dupes.js";
import { askWorker } from "./messaging.js";
import * as photos from "./photos-dom.js";
import { SweepOverlay } from "./overlay.js";

const STORAGE_KEY = "sweepDecisions";
const HASH_KEY = "sweepHashes";
const HELP_KEY = "sweepHelpSeen";
/** Items per select → trash round, so each Google dialog covers a batch Sweep has verified. */
const TRASH_BATCH = 100;
const RANGE_KEY = "sweepRange";
const MEDIA_KEY = "sweepMedia";
const LOW_WATER = 15;
const SCAN_LIMIT = 3000;
const SCAN_STEPS = 800;
const HASH_BATCH = 30;

let deck = null;
let overlay = null;
let mode = "deck";
let status = "";
let busy = false;
let loading = false;
let atEnd = false;
let frontier = 0;
let pageUrl = "";
let saveTimer = null;
let hashes = null;
let dupes = null;
let range = { from: null, to: null };
let lastVisible = [];
let pastRange = false;
let notFound = [];
let media = "all";
let seekingAt = "";
/** Which marked list the basket shows and acts on: bin, archive or lock. */
let basketKind = BIN;
/** The kind `notFound` belongs to (the last run's). */
let notFoundKind = BIN;

/** Wording for each basket action; the bin's matches what Sweep has always said. */
const ACTS = {
  [BIN]: {
    moved: (n) => `Moved ${n} to Google Photos Trash.`,
    none: "Nothing was moved to Trash.",
    moving: (n) => `Moving ${n} to Google Photos Trash…`,
    already: "were already in Trash",
    already1: "already moved to Trash",
    each: "trashing",
    ask: "\"Move to trash\"",
    fail: "trashed",
  },
  [ARCHIVE]: {
    moved: (n) => `Archived ${n}.`,
    none: "Nothing was archived.",
    moving: (n) => `Archiving ${n}…`,
    already: "were already archived",
    already1: "already archived",
    each: "archiving",
    ask: "to archive",
    fail: "archived",
  },
  [LOCK]: {
    moved: (n) => `Moved ${n} to the Locked Folder.`,
    none: "Nothing was moved to the Locked Folder.",
    moving: (n) => `Moving ${n} to the Locked Folder…`,
    already: "were already locked",
    already1: "already moved to the Locked Folder",
    each: "moving to the Locked Folder",
    ask: "\"Move\" to the Locked Folder",
    fail: "moved",
  },
};

/** Debounced save; `now` writes immediately (used after anything touching Google's Trash). */
function persist(now = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const save = () => {
    saveTimer = null;
    return chrome.storage.local.set({ [STORAGE_KEY]: deck.toJSON() }).catch(() => {});
  };
  if (now) return save();
  saveTimer = setTimeout(save, 250);
}

function flush() {
  if (saveTimer && deck) persist(true);
}
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

/** Claims the page for trash/duplicate work once any in-flight grid load has stopped. */
async function claimPage() {
  busy = true;
  render();
  await photos.waitFor(() => !loading, 15000, 50);
}

// The date range and the photos/videos choice together decide what Sweep and Duplicates see.
const withinRange = (item) => inRange(item.ts, range) && matchesMedia(item.kind, media);
const MEDIA_LABELS = { all: "Photos & videos", photos: "Photos only", videos: "Videos only" };

function render() {
  overlay?.render({
    mode,
    cards: deck.upcoming(3 + 6),
    stats: deck.stats(),
    totals: deck.stats(),
    canUndo: deck.canUndo,
    basket: deck.basket(basketKind),
    basketKind,
    marked: { [BIN]: deck.basket(BIN).length, [ARCHIVE]: deck.basket(ARCHIVE).length, [LOCK]: deck.basket(LOCK).length },
    loading,
    loadingText: seekText(),
    atEnd,
    busy,
    status,
    range,
    rangeLabel: formatRange(range),
    media,
    mediaLabel: MEDIA_LABELS[media],
    dupes: dupesView(),
    notFound: notFoundKind === basketKind ? notFound.filter((id) => deck.decisions[id]?.d === basketKind).length : 0,
    stoppable: eachProgress ? "Stop" : searching ? "Stop searching" : null,
    here: photos.viewKey(location.href),
  });
}

function say(message) {
  status = message;
  render();
}

// --- date range ------------------------------------------------------------------

/** Scroll guards that stop past the range and jump over photos newer than it. */
function rangeGuards() {
  const ordered = () => [...deck.items.values()].map((item) => item.ts ?? null);
  return {
    onItems(items) {
      // Range decisions use only what's on screen, not tiles Google keeps rendered off-screen.
      lastVisible = photos.readOnScreen();
      return deck.add(items);
    },
    until: () => {
      pastRange = isPastRange(ordered(), lastVisible.map((item) => item.ts ?? null), range);
      return pastRange;
    },
    canSkip: (visible) => isBeforeRange(ordered(), visible.map((item) => item.ts ?? null), range),
    seek: () => photos.seekBefore(rangeBounds(range).end, {
      log: trace,
      onProbe: (at) => {
        seekingAt = at;
        render();
      },
    }).finally(() => { seekingAt = ""; }),
  };
}

function seekText() {
  const what = media === "videos" ? "videos" : media === "photos" ? "photos" : "";
  if (!hasRange(range)) return what ? `Looking for ${what}…` : "Loading more from Google Photos…";
  if (seekingAt) return `Jumping to ${formatRange(range)}… (at ${seekingAt})`;
  const at = lastVisible.at(-1)?.date;
  return `Looking for ${formatRange(range)}…${at ? ` (at ${at})` : ""}`;
}

function scopeText() {
  const parts = [hasRange(range) ? formatRange(range) : "", media !== "all" ? MEDIA_LABELS[media] : ""].filter(Boolean);
  return parts.length ? `Showing ${parts.join(" · ")}` : "";
}

function applyRange(next) {
  range = { from: next?.from || null, to: next?.to || null };
  if (range.from && range.to && range.from > range.to) range = { from: range.to, to: range.from };
  chrome.storage.local.set({ [RANGE_KEY]: range });
  deck.setFilter(withinRange);
  // Big jumps may have skipped photos outside the old range, so walk from the top again.
  frontier = 0;
  atEnd = false;
  pastRange = false;
  lastVisible = [];
}

async function topUp() {
  if (loading || busy || atEnd || mode !== "deck" || !overlay?.open || deck.remaining >= LOW_WATER) return;
  loading = true;
  render();
  try {
    const scroller = photos.findScroller();
    if (scroller && scroller.scrollTop < frontier) scroller.scrollTop = frontier;
    const guards = rangeGuards();
    const result = await photos.harvest((items) => {
      const wasEmpty = deck.remaining === 0;
      const added = guards.onItems(items);
      // Only while the deck is empty: show seek progress, or the first card as soon as it arrives.
      if (wasEmpty) render();
      return added;
    }, { until: () => busy || guards.until(), canSkip: guards.canSkip, seek: guards.seek });
    frontier = photos.findScroller()?.scrollTop || frontier;
    atEnd = result.atEnd || pastRange;
    persist();
  } finally {
    loading = false;
    render();
  }
  // Long runs of already-kept or out-of-range photos yield nothing new; keep going until the grid ends.
  if (!atEnd && deck.remaining < LOW_WATER) setTimeout(topUp, 0);
}

const actions = {
  keep(id) {
    if (!deck.keep(id)) return;
    status = "";
    persist();
    render();
    topUp();
  },
  bin(id) {
    decide("bin", id);
  },
  archive(id) {
    decide("archive", id);
  },
  lock(id) {
    decide("lock", id);
  },
  undo() {
    deck.undo();
    persist();
    render();
  },
  unmark(id) {
    deck.unmark(id);
    persist();
    render();
  },
  openBasket(kind) {
    // Opens on the list that has something in it, unless one is asked for.
    basketKind = PENDING[kind] ? kind : [BIN, ARCHIVE, LOCK].find((k) => deck.basket(k).length) || BIN;
    mode = "basket";
    status = "";
    render();
  },
  basketKind(kind) {
    if (busy || !PENDING[kind]) return;
    basketKind = kind;
    status = "";
    render();
  },
  closeBasket() {
    mode = "deck";
    status = "";
    render();
    topUp();
  },
  close() {
    overlay.hide();
  },
  trash: () => moveBasket(basketKind),
  stopTrash() {
    if (searching) {
      stopSearch = true;
      say("Stopping the search…");
      return;
    }
    stopRequested = true;
    say("Stopping after this photo…");
  },
  forgetNotFound() {
    if (busy || !notFound.length) return;
    const count = notFound.length;
    // Treated as done: a trashed or locked one that turns up in the grid again is offered afresh.
    deck.markDone(notFound, PENDING[notFoundKind]);
    notFound = [];
    persist(true);
    status = `Cleared ${count} from the list. Any that are still in your library will come back for a fresh decision.`;
    render();
  },
  forgetKept() {
    if (busy || loading) return;
    const count = deck.forgetKept();
    persist(true);
    frontier = 0;
    atEnd = false;
    pastRange = false;
    lastVisible = photos.readGridItems();
    deck.add(lastVisible);
    status = count ? `${count} kept photos will come back for review.` : "No keep decisions to forget.";
    overlay.toggleHelp(false);
    render();
    topUp();
  },
  clearHashes() {
    if (busy) return;
    hashes = {};
    chrome.storage.local.remove(HASH_KEY);
    status = "Duplicate cache cleared.";
    render();
  },
  findDupes,
  dupeToggle(id) {
    if (!dupes?.choice.has(id)) return;
    dupes.choice.set(id, dupes.choice.get(id) === "keep" ? "bin" : "keep");
    render();
  },
  dupeApply() {
    const ids = currentGroup();
    if (!ids) return;
    const keep = ids.filter((id) => dupes.choice.get(id) === "keep");
    const bin = ids.filter((id) => dupes.choice.get(id) === "bin");
    deck.resolveGroup(keep, bin);
    persist(true);
    advanceGroup(true);
  },
  dupeKeepAll() {
    const ids = currentGroup();
    if (!ids) return;
    deck.resolveGroup(ids, []);
    persist(true);
    advanceGroup(true);
  },
  dupeSkip() {
    if (currentGroup()) advanceGroup(false);
  },
  dupeBack() {
    const last = dupes?.log.pop();
    if (!last) return;
    if (last.resolved && deck.lastIsGroup) deck.undo();
    persist();
    showGroup(last.index);
  },
  dupeLoose() {
    if (!dupes || dupes.phase === "scanning" || dupes.phase === "hashing") return;
    dupes.loose = !dupes.loose;
    dupes.groups = buildGroups();
    dupes.log = [];
    showGroup(0);
  },
  exitDupes() {
    mode = "deck";
    status = "";
    render();
    topUp();
  },
  openRange() {
    if (busy) return;
    mode = "range";
    status = "";
    render();
  },
  setRange(next) {
    applyRange(typeof next === "string" ? presetRange(next) : next);
    mode = "deck";
    status = hasRange(range) ? `Showing ${formatRange(range)}` : "";
    render();
    topUp();
  },
  cycleMedia() {
    if (busy) return;
    media = MEDIA_MODES[(MEDIA_MODES.indexOf(media) + 1) % MEDIA_MODES.length];
    chrome.storage.local.set({ [MEDIA_KEY]: media });
    deck.setFilter(withinRange);
    atEnd = false;
    status = MEDIA_LABELS[media];
    render();
    topUp();
  },
  closeRange() {
    mode = "deck";
    render();
    topUp();
  },
};

// --- duplicate finder ----------------------------------------------------------

function currentGroup() {
  return dupes?.phase === "review" ? dupes.groups[dupes.index] : null;
}

function showGroup(index) {
  dupes.index = index;
  const ids = dupes.groups[index];
  dupes.phase = ids ? "review" : "done";
  // Keep the first (Google lists newest first); everything else is a proposed bin.
  dupes.choice = new Map((ids || []).map((id, i) => [id, i === 0 ? "keep" : "bin"]));
  render();
}

function advanceGroup(resolved) {
  dupes.log.push({ index: dupes.index, resolved });
  showGroup(dupes.index + 1);
}

function buildGroups() {
  const candidates = [...deck.items.values()].filter((item) => {
    const decision = deck.decisions[item.id]?.d;
    return !PENDING[decision] && decision !== TRASHED && decision !== LOCKED && decision !== ARCHIVED && hashes[item.id] && withinRange(item);
  });
  return findGroups(candidates.map((item) => ({ id: item.id, hash: hashes[item.id] })), dupes.loose ? LOOSE : STRICT)
    // Groups already reviewed in full are not offered again; any new member reopens one.
    .filter((ids) => !ids.every((id) => deck.decisions[id]?.dup));
}

function dupesView() {
  if (!dupes) return null;
  const ids = currentGroup() || [];
  return {
    phase: dupes.phase,
    text: dupes.text,
    loose: dupes.loose,
    index: dupes.index,
    count: dupes.groups.length,
    canBack: dupes.log.length > 0,
    group: ids.map((id) => ({ ...deck.items.get(id), choice: dupes.choice.get(id) })),
  };
}

async function findDupes() {
  if (busy) return;
  mode = "dupes";
  status = "";
  dupes = { phase: "scanning", text: "Scanning this Google Photos view…", groups: [], index: 0, choice: new Map(), log: [], loose: dupes?.loose ?? true };
  await claimPage();

  const cancelled = () => mode !== "dupes" || !overlay.open;
  const scope = hasRange(range) ? ` in ${formatRange(range)}` : "";
  try {
    hashes ||= (await chrome.storage.local.get(HASH_KEY))[HASH_KEY] || {};

    const scroller = photos.findScroller();
    if (scroller) scroller.scrollTop = 0;
    await photos.sleep(700);
    lastVisible = [];
    pastRange = false;
    const inScope = () => [...deck.items.values()].filter(withinRange);
    const guards = rangeGuards();
    let found = 0;
    const scan = await photos.harvest((items) => {
      const added = guards.onItems(items);
      found = inScope().length;
      const at = lastVisible.at(-1)?.date;
      dupes.text = `Scanning… ${found} photos${scope} loaded${at ? ` (at ${at})` : ""}`;
      render();
      return added;
    }, {
      want: Infinity,
      maxSteps: SCAN_STEPS,
      until: () => cancelled() || found >= SCAN_LIMIT || guards.until(),
      canSkip: guards.canSkip,
      seek: guards.seek,
    });
    // The scan may have jumped over photos, so the deck walks from the top again.
    frontier = 0;
    atEnd = false;
    persist();
    if (cancelled()) return;

    dupes.phase = "hashing";
    const todo = inScope().filter((item) => !hashes[item.id]);
    for (let i = 0; i < todo.length && !cancelled(); i += HASH_BATCH) {
      dupes.text = `Comparing… ${i} / ${todo.length} fingerprinted`;
      render();
      const batch = todo.slice(i, i + HASH_BATCH).map((item) => ({ id: item.id, url: photos.sizedImageUrl(item.thumb, 64, 64) }));
      const result = await askWorker({ type: "sweep-hash", items: batch });
      for (const [id, hash] of Object.entries(result || {})) if (hash) hashes[id] = hash;
    }
    chrome.storage.local.set({ [HASH_KEY]: hashes });
    if (cancelled()) return;

    const failed = todo.filter((item) => !hashes[item.id]).length;
    const capped = found >= SCAN_LIMIT && !scan.atEnd && !pastRange
      ? ` Stopped at ${SCAN_LIMIT} — narrow the date range to check the rest.`
      : "";
    status = `${failed ? `${failed} couldn't be fingerprinted. ` : ""}${capped}`.trim();
    dupes.groups = buildGroups();
    showGroup(0);
  } catch (error) {
    console.error("[sweep]", error);
    dupes.phase = "done";
    status = `Duplicate scan failed: ${error.message}`;
  } finally {
    busy = false;
    render();
    // Esc during a scan drops back to the deck, which may need its own top-up.
    if (mode === "deck") topUp();
  }
}

function decide(kind, id) {
  if (!deck[kind](id)) return;
  status = "";
  persist();
  render();
  topUp();
}

const trace = (...args) => console.info("[sweep]", ...args);

let handedBack = false;

/** Leaves Google Photos showing (e.g. with a selection to check) and explains why in a pill. */
function handBack(message) {
  handedBack = true;
  status = "";
  overlay.hide();
  overlay.pill(message);
  setTimeout(() => overlay.pill(null), 10000);
}

/** Carries out one marked list through Google's own UI: bin → Trash, archive → Archive, lock → Locked Folder. */
async function moveBasket(kind = BIN) {
  const act = ACTS[kind];
  const ids = deck.basket(kind).map((entry) => entry.id);
  if (!ids.length || busy) return;
  if (/\/trash(\/|$)/.test(location.pathname)) {
    say("This is Google Photos Trash. Open your library or the album the photos came from, then try again.");
    return;
  }
  if (photos.hasSelection()) {
    say("Google Photos already has a selection. Clear it (Esc in Google Photos) and try again.");
    return;
  }
  if (photos.isDialogOpen()) {
    say("A Google Photos dialog is open. Close it and try again.");
    return;
  }

  await claimPage();
  const moved = [];
  const movedNote = () => (moved.length ? `${moved.length} ${act.already1}. ` : "");
  // Marked in another album or view: this grid can't show them, so don't scroll it looking.
  const here = photos.viewKey(location.href);
  const elsewhere = ids.filter((id) => deck.decisions[id]?.from && deck.decisions[id].from !== here);
  const skip = new Set(elsewhere);
  const gridIds = ids.filter((id) => !skip.has(id));
  let searchNote = "";
  try {
    notFound = [];
    notFoundKind = kind;
    let pending = gridIds;
    let unselectable = [];
    stopSearch = false;
    for (let batch = 1; pending.length; batch += 1) {
      const batches = Math.ceil(pending.length / TRASH_BATCH) > 1 || batch > 1;
      const label = batches ? `batch ${batch}: ` : "";
      const show = (text) => (overlay.open ? say(text) : overlay.pill(text));
      show(batch === 1 ? `Looking for ${Math.min(pending.length, TRASH_BATCH)} marked in this view…` : `Moved ${moved.length} — looking for the next batch…`);
      searching = true;
      let result;
      try {
        result = await photos.selectItems(pending, {
          limit: TRASH_BATCH,
          olderThan: here === "/" ? oldestMarked(pending) : null,
          newerThan: here === "/" ? newestMarked(pending) : null,
          log: trace,
          shouldStop: () => stopSearch,
          onProgress: (done, total, { scanned, at }) => show(`Looking for ${label}${total} marked in this view: ${done} ticked · checked ${scanned}${at ? ` · at ${at}` : ""}…`),
        });
      } finally {
        searching = false;
      }
      const { selected } = result;
      trace(`select stopped: ${result.reason}`, { selected: selected.length, absent: result.absent.length, unselectable: result.unselectable.length });
      if (!result.limited) {
        notFound = result.absent;
        unselectable = result.unselectable;
      }
      if (result.reason === "untickable") searchNote = " Sweep couldn't tick photos in this grid, so it used each photo's page instead.";
      if (result.reason === "stopped") searchNote = " You stopped the search, so the rest were done from each photo's page.";

      if (!selected.length) break;

      // Never press delete unless Google's own counter agrees with what we selected.
      const shown = await photos.waitFor(() => photos.selectedCount(), 2000);
      if (shown !== selected.length) {
        handBack(`${movedNote()}${shown === null
          ? `Sweep ticked ${selected.length} but couldn't read Google Photos' selection count, so nothing more was deleted. Check the selection and use Google's trash button.`
          : `Google Photos shows ${shown} selected but Sweep selected ${selected.length}. Nothing more was deleted — check the selection.`}`);
        return;
      }

      const probe = selected.filter(photos.isOnPage);
      // Hidden first: while open, Sweep swallows keys, which would eat the "#" fallback.
      overlay.hide();
      overlay.pill(`${label ? `${label[0].toUpperCase()}${label.slice(1)}` : ""}${act.moving(selected.length)}`);
      const route = kind === BIN ? await photos.startTrash({ log: trace }) : await photos.startMenuAction(kind, { log: trace });
      if (!route) {
        handBack(`${movedNote()}${selected.length} selected. ${kind === BIN
          ? "Sweep couldn't find Google's trash action here — use ⋮ → Move to trash (or press #) yourself."
          : kind === ARCHIVE
            ? "Sweep couldn't find Google's Archive action here — use ⋮ → Archive (or Shift+A) yourself."
            : "Sweep couldn't find Google's Move to Locked Folder action here — use ⋮ → Move to Locked Folder yourself."}`);
        return;
      }

      const confirmOptions = {
        log: trace,
        onNeedsUser: () => overlay.pill(`Google asked something unexpected — read the dialog and choose yourself (${selected.length} items). Sweep resumes after.`),
      };
      const outcome = kind === BIN ? await photos.confirmTrash(probe, confirmOptions) : await photos.confirmAction(kind, probe, confirmOptions);
      overlay.pill(null);
      if (outcome !== "trashed") {
        status = movedNote() + (outcome === "no-dialog"
          ? `Google Photos didn't respond to "${route}" — nothing more was ${act.fail} and the rest is still marked. Details are in the page console ([sweep]).`
          : outcome === "cancelled"
            ? `${kind === BIN ? "Trash" : kind === ARCHIVE ? "Archive" : "Locked Folder move"} cancelled — the photos are still selected or still on the page, so they stay marked.`
            : "Timed out waiting for Google's dialog — the rest is still marked.");
        return;
      }
      deck.markDone(selected, PENDING[kind]);
      persist(true);
      moved.push(...selected);
      if (!result.limited || stopSearch) {
        if (result.limited) notFound = pending.filter((id) => !selected.includes(id));
        break;
      }
      const done = new Set(selected);
      pending = pending.filter((id) => !done.has(id));
    }
    // Whatever the grid couldn't reach is trashed from each photo's own page instead.
    const leftovers = [...unselectable, ...notFound, ...elsewhere];
    notFound = [];
    let note = "";
    if (leftovers.length) {
      overlay.pill(null);
      if (!overlay.open) overlay.show();
      note = await trashEach(leftovers, moved, kind);
    }
    status = `${moved.length ? act.moved(moved.length) : act.none}${note}${leftovers.length ? searchNote : ""}`;
  } catch (error) {
    console.error("[sweep]", error);
    status = `${movedNote()}Something went wrong: ${error.message}. Nothing further was ${kind === BIN ? "deleted" : act.fail}.`;
  } finally {
    frontier = 0;
    atEnd = false;
    pastRange = false;
    busy = false;
    if (!handedBack) {
      overlay.pill(null);
      if (!overlay.open) overlay.show();
    }
    handedBack = false;
    render();
  }
}

let stopRequested = false;
let stopSearch = false;
let searching = false;
let eachProgress = null;
const DAY = 24 * 60 * 60 * 1000;

/** On the newest-first timeline, the search can start just above the newest marked photo. */
function newestMarked(ids) {
  const times = ids.map((id) => deck.decisions[id]?.ts);
  if (!times.length || times.some((ts) => typeof ts !== "number")) return null;
  return Math.max(...times) + 2 * DAY;
}

/** On the newest-first timeline, the grid can stop once it's older than every marked photo. */
function oldestMarked(ids) {
  const times = ids.map((id) => deck.decisions[id]?.ts);
  if (!times.length || times.some((ts) => typeof ts !== "number")) return null;
  // A day of slack: labels carry local dates and the timeline groups by day.
  return Math.min(...times) - 2 * DAY;
}

/**
 * Trashes marked photos one at a time from their own photo pages, in a helper window the
 * worker opens. Slower than the grid, but it works for photos from any album or view.
 * Returns a note for the final status line.
 */
async function trashEach(ids, moved, kind = BIN) {
  const act = ACTS[kind];
  const already = [];
  const left = [];
  let stopNote = "";
  stopRequested = false;
  let keepHelper = false;
  try {
    for (const [index, id] of ids.entries()) {
      if (stopRequested) {
        left.push(...ids.slice(index));
        stopNote = " Stopped — the rest stay marked.";
        break;
      }
      eachProgress = { done: index, total: ids.length };
      say(`Not in this view, so ${act.each} one by one in a background tab: ${index + 1} / ${ids.length}…`);
      let reply;
      try {
        reply = await askWorker({ type: "sweep-trash-one", id, href: deck.decisions[id]?.href, action: kind });
      } catch (error) {
        reply = { outcome: "error", error: error.message };
      }
      const outcome = reply?.outcome;
      trace("one by one", { id, outcome, error: reply?.error });
      if (outcome === "trashed" || outcome === "done" || outcome === "already-trashed" || outcome === "already") {
        deck.markDone([id], PENDING[kind]);
        persist(true);
        (outcome === "trashed" || outcome === "done" ? moved : already).push(id);
      } else if (outcome === "needs-user") {
        keepHelper = true;
        left.push(...ids.slice(index));
        stopNote = ` Google asked something other than ${act.ask}, so Sweep stopped and switched to that photo's tab — answer it yourself. The rest stay marked.`;
        break;
      } else if (outcome === "error") {
        left.push(...ids.slice(index));
        stopNote = ` Stopped: ${String(reply?.error || "something went wrong").replace(/\.+$/, "")}. The rest stay marked.`;
        break;
      } else {
        left.push(id);
      }
    }
  } finally {
    eachProgress = null;
    if (!keepHelper) await askWorker({ type: "sweep-trash-close" }).catch(() => {});
  }
  notFound = left;
  return [
    already.length ? ` ${already.length} ${act.already}.` : "",
    left.length && !stopNote ? ` ${left.length} couldn't be found or ${act.fail} and stay marked — "Clear not found" removes them from the list.` : "",
    stopNote,
  ].join("");
}

/** Called in the helper window, on one marked photo's own page. */
export function trashHere(id, action = BIN) {
  return photos.actOnOpenPhoto(id, PENDING[action] ? action : BIN, { log: trace });
}

async function ensureDeck() {
  if (!deck) {
    const stored = await chrome.storage.local.get([STORAGE_KEY, RANGE_KEY, MEDIA_KEY]);
    deck = new SweepDeck(stored[STORAGE_KEY] || {});
    range = stored[RANGE_KEY] || range;
    if (MEDIA_MODES.includes(stored[MEDIA_KEY])) media = stored[MEDIA_KEY];
    deck.setFilter(withinRange);
  }
  overlay ||= new SweepOverlay(actions);
}

async function openOverlay() {
  // A different album or search is a different grid to walk.
  if (location.href !== pageUrl) {
    pageUrl = location.href;
    deck.resetView();
    dupes = null;
    notFound = [];
    frontier = 0;
    atEnd = false;
    pastRange = false;
  }
  mode = "deck";
  status = scopeText();
  overlay.show();
  if (!(await chrome.storage.local.get(HELP_KEY))[HELP_KEY]) {
    chrome.storage.local.set({ [HELP_KEY]: true });
    overlay.toggleHelp(true);
  }
  lastVisible = photos.readGridItems();
  deck.add(lastVisible);
  render();
  topUp();
}

export async function toggle() {
  await ensureDeck();
  if (overlay.open) {
    overlay.hide();
    return;
  }
  await openOverlay();
}

/**
 * Opened from the toolbar popup: sweep this page with the dates and media chosen there.
 * Returns how many photos the page shows, so the popup's worker can fall back to the
 * timeline when a Google search found nothing.
 */
export async function start({ range: next = null, media: nextMedia = null, note = "", openEmpty = false } = {}) {
  await ensureDeck();
  if (busy) {
    const text = "Sweep is still busy with the last job. Try again when it's finished.";
    if (overlay.open) say(text);
    else overlay.pill(text);
    return { tiles: -1, busy: true };
  }
  const tiles = (await photos.waitFor(() => photos.readGridItems().length, 10000, 150)) || 0;
  // With nowhere else to try, open anyway so the user sees why the deck is empty.
  if (!tiles && !openEmpty) return { tiles: 0 };
  if (!tiles && !note) note = "There are no photos on this page. Open the timeline, an album or a search, then start Sweep again.";
  if (MEDIA_MODES.includes(nextMedia)) {
    media = nextMedia;
    chrome.storage.local.set({ [MEDIA_KEY]: media });
  }
  applyRange(next);
  if (overlay.open) overlay.hide();
  await openOverlay();
  if (note) say(note);
  return { tiles };
}
