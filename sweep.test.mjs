import assert from "node:assert/strict";
import { SweepDeck, KEEP, BIN, TRASHED, ARCHIVE, ARCHIVED, LOCK, LOCKED, matchesMedia } from "./src/deck.js";
import { formatRange, hasRange, rangeBounds, inRange, isBeforeRange, isPastRange, parseLabelDate, presetRange, searchQueryFor, sweepUrlFor, monthRange } from "./src/dates.js";
import { RELOAD_HINT, askWorker } from "./src/messaging.js";
import { LOOSE, STRICT, dhashFromRgba, findGroups, hamming } from "./src/dupes.js";
import {
  isTrashButtonLabel,
  isTrashConfirmLabel,
  parseLabel,
  parseSelectedCount,
  photoIdFromHref,
  sizedImageUrl,
  videoUrls,
  urlFromBackground,
} from "./src/photos-dom.js";

const item = (id) => ({ id, href: `https://photos.google.com/photo/${id}`, thumb: `https://lh3.googleusercontent.com/pw/${id}=w256-h171-no`, label: `Photo - ${id}`, kind: "photo" });
let clock = 0;
const tick = () => ++clock;

// --- archive and Locked Folder ------------------------------------------------------
{
  const deck = new SweepDeck({}, tick);
  deck.add(["a", "b", "c", "d"].map(item));
  assert.equal(deck.archive("a"), "a");
  assert.equal(deck.lock("b"), "b");
  assert.equal(deck.bin("c"), "c");
  assert.deepEqual(deck.basket(ARCHIVE).map((e) => e.id), ["a"]);
  assert.deepEqual(deck.basket(LOCK).map((e) => e.id), ["b"]);
  assert.deepEqual(deck.basket().map((e) => e.id), ["c"], "the default basket is still the bin");
  assert.equal(deck.basket(LOCK)[0].thumb, item("b").thumb, "locked marks keep a thumbnail for the basket");
  assert.equal(deck.stats().toArchive, 1);
  assert.equal(deck.stats().toLock, 1);
  deck.undo();
  deck.undo();
  assert.equal(deck.current.id, "b", "undo takes back a lock mark");
  assert.equal(deck.lock("b"), "b");
  assert.equal(deck.unmark("a"), true, "archive marks can be unmarked");
  assert.equal(deck.current.id, "a");
  deck.archive("a");
  deck.markDone(["a"], ARCHIVED);
  deck.markDone(["b"], LOCKED);
  assert.deepEqual(deck.basket(ARCHIVE), []);
  assert.equal(deck.stats().archived, 1);
  assert.equal(deck.stats().locked, 1);
  assert.equal(deck.unmark("a"), false, "done actions can't be unmarked");

  // Reloaded: an archived photo seen again (e.g. in an album) stays decided; a locked one that is
  // back in the library was restored, so it gets a fresh decision.
  const again = new SweepDeck(deck.toJSON(), tick);
  again.add(["a", "b"].map(item));
  assert.deepEqual(again.upcoming(5).map((x) => x.id), ["b"]);
  const marked = new SweepDeck({ z: { d: LOCK, at: 1 } }, tick);
  marked.add([{ ...item("z"), ts: 5 }]);
  assert.equal(marked.basket(LOCK)[0].ts, 5, "a pending lock is refreshed from the grid like a bin mark");
  assert.equal(marked.remaining, 0);
}

// --- popup: Google search for a range ---------------------------------------------------
assert.equal(searchQueryFor({ from: "2020-01-01", to: "2020-01-30" }), "January 2020");
assert.equal(searchQueryFor({ from: "2020-03-05", to: "2020-11-02" }), "2020");
assert.equal(searchQueryFor({ from: "2019-12-20", to: "2020-01-05" }), null, "spans years: the timeline instead");
assert.equal(searchQueryFor({ from: "2020-01-01", to: null }), null);
assert.equal(searchQueryFor({ from: null, to: null }), null);
assert.equal(sweepUrlFor({ from: "2020-01-01", to: "2020-01-30" }), "https://photos.google.com/search/January%202020");
assert.equal(sweepUrlFor({ from: "2020-01-01", to: "2020-01-30" }, { useSearch: false }), "https://photos.google.com/");
assert.equal(sweepUrlFor({ from: null, to: null }), "https://photos.google.com/");
assert.deepEqual(monthRange("2020-02"), { from: "2020-02-01", to: "2020-02-29" });
assert.equal(monthRange(""), null);

// --- parsing ------------------------------------------------------------------
assert.equal(photoIdFromHref("https://photos.google.com/photo/AF1QipN_x-9"), "AF1QipN_x-9");
assert.equal(photoIdFromHref("https://photos.google.com/album/ALB1/photo/AF1Qip2"), "AF1Qip2", "album links resolve to the photo id");
assert.equal(photoIdFromHref("https://photos.google.com/albums"), null);

assert.deepEqual(parseLabel("Photo - Landscape - 3 Sept 2026, 16:12:07"), { kind: "photo", date: "3 Sept 2026, 16:12:07" });
assert.deepEqual(parseLabel("Video - Portrait - 1 Jan 2025, 09:00:00"), { kind: "video", date: "1 Jan 2025, 09:00:00" });
assert.deepEqual(parseLabel(""), { kind: "photo", date: "" });

assert.equal(urlFromBackground('url("https://lh3.googleusercontent.com/pw/abc=w256-h171-no")'), "https://lh3.googleusercontent.com/pw/abc=w256-h171-no");
assert.equal(urlFromBackground("url(https://x.test/a)"), "https://x.test/a");
assert.equal(urlFromBackground("none"), null);

assert.equal(
  sizedImageUrl("https://lh3.googleusercontent.com/pw/AP1Gcz-_x=w256-h171-k-no?authuser=0", 1600, 1200),
  "https://lh3.googleusercontent.com/pw/AP1Gcz-_x=w1600-h1200-no?authuser=0",
);
assert.equal(sizedImageUrl("https://lh3.googleusercontent.com/pw/AP1Gcz", 800, 600.4), "https://lh3.googleusercontent.com/pw/AP1Gcz=w800-h600-no");
assert.equal(sizedImageUrl("https://lh3.googleusercontent.com/a=b/path", 10, 10), "https://lh3.googleusercontent.com/a=b/path=w10-h10-no", "'=' in an earlier path segment is left alone");

assert.equal(parseSelectedCount("Photos\n12 selected\nShare"), 12);
assert.equal(parseSelectedCount("1,204 selected"), 1204);
assert.equal(parseSelectedCount("Photos Explore Sharing"), null);

// --- deck: swiping only records decisions ---------------------------------------
{
  const deck = new SweepDeck({}, tick);
  assert.equal(deck.add([item("a"), item("b"), item("c"), item("a")]), 3, "duplicates are ignored");
  assert.equal(deck.current.id, "a");

  deck.keep();
  deck.bin();
  assert.equal(deck.current.id, "c");
  assert.deepEqual(deck.basket().map((entry) => entry.id), ["b"]);
  assert.equal(deck.basket()[0].thumb, item("b").thumb, "binned entries carry a thumbnail for the basket");
  assert.deepEqual(deck.stats(), { kept: 1, binned: 1, trashed: 0, toArchive: 0, archived: 0, toLock: 0, locked: 0, loaded: 3, remaining: 1, reviewed: 2 });

  assert.equal(deck.undo(), "b");
  assert.equal(deck.current.id, "b");
  assert.equal(deck.basket().length, 0, "undo removes the mark");
  assert.equal(deck.undo(), "a");
  assert.equal(deck.decisions.a, undefined);
  assert.equal(deck.undo(), null);
}

// --- deck: unmark puts the item back on top -------------------------------------
{
  const deck = new SweepDeck({}, tick);
  deck.add([item("a"), item("b"), item("c")]);
  deck.bin();
  deck.keep();
  assert.equal(deck.current.id, "c");
  assert.ok(deck.unmark("a"));
  assert.equal(deck.current.id, "a", "unmarked item is reviewed next");
  assert.equal(deck.remaining, 2);
  assert.equal(deck.undo(), "b", "history no longer contains the unmarked item");
  assert.equal(deck.current.id, "b");
  assert.equal(deck.unmark("zzz"), false);
}

// --- deck: persisted decisions ----------------------------------------------------
{
  const saved = {
    kept: { d: KEEP, at: 1 },
    old: { d: BIN, at: 2, thumb: "https://old" },
    gone: { d: TRASHED, at: 3 },
  };
  const deck = new SweepDeck(saved, tick);
  assert.deepEqual(deck.basket().map((entry) => entry.id), ["old"], "basket survives a reload before the grid is scrolled");

  assert.equal(deck.add([item("kept"), item("old"), item("gone"), item("new")]), 2);
  assert.deepEqual(deck.upcoming().map((entry) => entry.id), ["gone", "new"], "trashed items that reappear need a fresh decision");
  assert.equal(deck.basket()[0].thumb, item("old").thumb, "basket thumbnail refreshed from the live grid");
  assert.equal(saved.kept.d, KEEP, "constructor does not mutate its input");
}

// --- deck: trash is final ---------------------------------------------------------
{
  const deck = new SweepDeck({}, tick);
  deck.add([item("a"), item("b")]);
  deck.bin();
  deck.bin();
  deck.markTrashed(["a"]);
  assert.deepEqual(deck.basket().map((entry) => entry.id), ["b"]);
  assert.equal(deck.decisions.a.d, TRASHED);
  assert.equal(deck.undo(), "b");
  assert.equal(deck.undo(), null, "a trashed item cannot be undone from the deck");
  assert.deepEqual(JSON.parse(JSON.stringify(deck)).a.d, TRASHED, "decisions serialise for chrome.storage");
}

// --- auto-confirm only ever clicks "Move to trash" --------------------------------
assert.ok(isTrashConfirmLabel("Move to trash"));
assert.ok(isTrashConfirmLabel("  Move  to bin "));
assert.ok(!isTrashConfirmLabel("Delete permanently"), "permanent deletion is never auto-confirmed");
assert.ok(!isTrashConfirmLabel("Delete"));
assert.ok(!isTrashConfirmLabel("Cancel"));
assert.ok(!isTrashConfirmLabel(null));
assert.ok(isTrashButtonLabel("Move to trash") && isTrashButtonLabel("Delete") && isTrashButtonLabel("Bin"));
assert.ok(!isTrashButtonLabel("Delete album"), "album deletion is never a trash button");
assert.ok(!isTrashButtonLabel("Remove from album"));
assert.ok(!isTrashButtonLabel("Delete permanently"));
assert.ok(!isTrashButtonLabel(""));

// --- duplicate hashing and grouping -------------------------------------------------
{
  const rgba = (shade) => {
    const data = new Uint8ClampedArray(9 * 8 * 4);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const v = shade(x, y);
        data.set([v, v, v, 255], (y * 9 + x) * 4);
      }
    }
    return data;
  };
  assert.equal(dhashFromRgba(rgba((x) => 255 - x * 20)), "ffffffffffffffff", "left-brighter gradient sets every bit");
  assert.equal(dhashFromRgba(rgba((x) => x * 20)), "0000000000000000");
  assert.equal(dhashFromRgba(rgba((x, y) => (y === 0 ? 255 - x * 20 : x * 20))), "ff00000000000000", "row 0 is the high byte");

  assert.equal(hamming("ffffffffffffffff", "0000000000000000"), 64);
  assert.equal(hamming("f0f0f0f0f0f0f0f0", "f0f0f0f0f0f0f0f1"), 1);
  assert.equal(hamming("8000000000000000", "0000000000000001"), 2, "high and low words both counted");

  const groups = findGroups([
    { id: "a", hash: "1234567812345678" },
    { id: "x", hash: "edcba987edcba987" },
    { id: "b", hash: "1234567812345679" }, // 1 bit from a
    { id: "c", hash: "123456781234567e" }, // 3 bits from b, 2 from a
    { id: "flat1", hash: "0000000000000000" },
    { id: "flat2", hash: "0000000000000000" },
    { id: "nohash", hash: null },
    { id: "far", hash: "12345678123400ff" }, // 8 bits from a, 6 from c
  ], STRICT);
  assert.deepEqual(groups, [["a", "b", "c"]], "transitive, ordered, flat and missing hashes ignored");
  assert.deepEqual(findGroups([{ id: "a", hash: "1234567812345678" }, { id: "far", hash: "12345678123400ff" }], LOOSE), [["a", "far"]], "loose also matches near-duplicates");
  assert.deepEqual(findGroups([{ id: "z", hash: "ffff000000000000" }, { id: "y", hash: "0000ffff00000000" }, { id: "w", hash: "ffff000000000001" }], STRICT), [["z", "w"]]);
}

// --- deck: duplicate groups resolve and undo as one step -----------------------------
{
  const deck = new SweepDeck({}, tick);
  deck.add([item("a"), item("b"), item("c"), item("d")]);
  deck.keep(); // a
  deck.resolveGroup(["b"], ["c", "a"]);
  assert.equal(deck.current.id, "d", "resolved items leave the swipe deck");
  assert.deepEqual(deck.basket().map((entry) => entry.id).sort(), ["a", "c"]);
  assert.ok(deck.decisions.b.dup && deck.decisions.c.dup);
  assert.equal(deck.basket().find((entry) => entry.id === "c").thumb, item("c").thumb);
  assert.ok(deck.lastIsGroup);

  deck.undo();
  assert.equal(deck.decisions.a.d, KEEP, "undo restores the earlier swipe decision");
  assert.equal(deck.decisions.b, undefined);
  assert.deepEqual(deck.upcoming(4).map((entry) => entry.id), ["b", "c", "d"], "undecided members return to the deck in order");
  assert.ok(!deck.lastIsGroup);

  deck.resolveGroup([], ["b", "c"]);
  deck.markTrashed(["b"]);
  assert.ok(!deck.lastIsGroup, "a group with a trashed member can no longer be undone");
  deck.resolveGroup(["d"], []);
  assert.ok(deck.unmark("c"));
  assert.ok(deck.lastIsGroup, "unmark only drops history entries that mention the item");
}

// --- date range ---------------------------------------------------------------
{
  const gb = parseLabelDate("Photo - Landscape - 3 Sept 2026, 16:12:07");
  assert.equal(gb, new Date(2026, 8, 3, 16, 12, 7).getTime(), "en-GB label");
  const us = parseLabelDate("Photo - Portrait - Sep 3, 2026, 4:12:07 PM");
  assert.equal(us, new Date(2026, 8, 3, 16, 12, 7).getTime(), "en-US label");
  assert.equal(parseLabelDate("Video - Jan 1, 2020, 12:05:00 AM"), new Date(2020, 0, 1, 0, 5, 0).getTime(), "12 AM is midnight");
  assert.equal(parseLabelDate("Photo - no date here"), null);
  assert.equal(parseLabelDate(""), null);

  const range = { from: "2026-09-01", to: "2026-09-03" };
  assert.ok(hasRange(range) && !hasRange({ from: null, to: null }));
  assert.ok(inRange(new Date(2026, 8, 1, 0, 0, 0).getTime(), range), "start is inclusive");
  assert.ok(inRange(new Date(2026, 8, 3, 23, 59, 59).getTime(), range), "whole end day is inclusive");
  assert.ok(!inRange(new Date(2026, 8, 4).getTime(), range));
  assert.ok(!inRange(new Date(2026, 7, 31, 23, 59).getTime(), range));
  assert.ok(!inRange(null, range), "undated items are excluded when a range is set");
  assert.ok(inRange(null, {}), "no range keeps everything");

  const today = new Date(2026, 2, 15);
  assert.deepEqual(presetRange("30d", today), { from: "2026-02-14", to: "2026-03-15" });
  assert.deepEqual(presetRange("thisYear", today), { from: "2026-01-01", to: "2026-03-15" });
  assert.deepEqual(presetRange("lastYear", today), { from: "2025-01-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("all", today), { from: null, to: null });
  assert.equal(formatRange({}), "All dates");
  assert.match(formatRange(range), /1 Sept? 2026 – 3 Sept? 2026/);

  const d = (day) => new Date(2026, 8, day).getTime();
  assert.ok(isPastRange([d(9), d(5), d(1)], [d(1)], { from: "2026-09-02" }), "descending page below the range start");
  assert.ok(!isPastRange([d(1), d(5), d(9)], [d(1)], { from: "2026-09-02" }), "ascending albums never stop early");
  assert.ok(!isPastRange([d(9), d(5)], [d(5)], { from: "2026-09-02" }));
  assert.ok(isBeforeRange([d(20), d(15)], [d(15), d(12)], { to: "2026-09-10" }), "newer than the range end can be skipped");
  assert.ok(!isBeforeRange([d(20), d(15)], [d(12), d(10)], { to: "2026-09-10" }), "end day itself is in range");
  assert.ok(!isBeforeRange([d(20), d(15)], [d(15), null], { to: "2026-09-10" }), "undated items block skipping");
  assert.ok(!isBeforeRange([d(1), d(20)], [d(20)], { to: "2026-09-10" }), "ascending pages never skip");
}

// --- deck filter --------------------------------------------------------------
{
  const deck = new SweepDeck({}, tick);
  deck.add([item("a"), item("b"), item("c"), item("d")]);
  assert.ok(deck.keep());
  deck.setFilter((it) => it.id !== "c");
  assert.deepEqual(deck.queue, ["a", "b", "d"], "reviewed prefix kept, filtered item dropped");
  assert.equal(deck.current?.id, "b");
  deck.add([item("c2")]);
  deck.setFilter((it) => it.id === "d" || it.id === "c2");
  assert.deepEqual(deck.queue, ["a", "d", "c2"]);
  deck.setFilter(null);
  assert.deepEqual(deck.queue, ["a", "b", "c", "d", "c2"], "clearing the filter restores page order");
  assert.ok(deck.bin() && deck.current?.id === "c");
}

// --- worker messaging -----------------------------------------------------------
{
  const noSleep = async () => {};
  const flaky = (failures, message) => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls <= failures) throw new Error(message);
      return { ok: true };
    };
    return { send, calls: () => calls };
  };
  const race = flaky(2, "Could not establish connection. Receiving end does not exist.");
  assert.deepEqual(await askWorker({}, { send: race.send, alive: () => true, sleep: noSleep }), { ok: true }, "retries a worker that was shutting down");
  assert.equal(race.calls(), 3);

  const dead = flaky(99, "Could not establish connection. Receiving end does not exist.");
  await assert.rejects(askWorker({}, { send: dead.send, alive: () => true, sleep: noSleep, tries: 3 }), /Receiving end/);
  assert.equal(dead.calls(), 3, "gives up after the retry budget");

  const reloaded = flaky(99, "Extension context invalidated.");
  await assert.rejects(askWorker({}, { send: reloaded.send, alive: () => true, sleep: noSleep }), (error) => error.message === RELOAD_HINT);
  assert.equal(reloaded.calls(), 1, "no retries once the extension was reloaded");

  const other = flaky(99, "boom");
  await assert.rejects(askWorker({}, { send: other.send, alive: () => true, sleep: noSleep }), /boom/);
  assert.equal(other.calls(), 1, "unrelated errors are not retried");
}

// --- clearing items that are no longer on the page -------------------------------
{
  const deck = new SweepDeck({}, tick);
  deck.add([item("gone"), item("here")]);
  deck.bin();
  deck.bin();
  deck.markTrashed(["gone"]);
  assert.deepEqual(deck.basket().map((entry) => entry.id), ["here"], "cleared items leave the bin");
  const again = new SweepDeck(deck.toJSON(), tick);
  assert.equal(again.add([item("gone")]), 1, "a cleared item that is still in the library comes back for review");
}

// --- photos / videos filter ------------------------------------------------------
{
  assert.ok(matchesMedia("video", "videos") && !matchesMedia("photo", "videos"));
  assert.ok(matchesMedia("photo", "photos") && !matchesMedia("video", "photos"));
  assert.ok(matchesMedia("photo", "all") && matchesMedia("video", "all") && matchesMedia("video", undefined));

  const clip = (id) => ({ ...item(id), kind: "video" });
  const deck = new SweepDeck({}, tick);
  deck.add([item("p1"), clip("v1"), item("p2"), clip("v2")]);
  deck.setFilter((it) => matchesMedia(it.kind, "videos"));
  assert.deepEqual(deck.queue, ["v1", "v2"], "videos only");
  deck.bin();
  deck.setFilter((it) => matchesMedia(it.kind, "photos"));
  assert.deepEqual(deck.queue, ["v1", "p1", "p2"], "decided videos stay reviewed; photos queue behind them");
  assert.equal(deck.current?.id, "p1");
  assert.equal(deck.add([clip("v3")]), 0, "new videos are not queued while showing photos only");

  assert.deepEqual(videoUrls("https://lh3.googleusercontent.com/pw/ABC=w256-h171-no"), [
    "https://lh3.googleusercontent.com/pw/ABC=m22",
    "https://lh3.googleusercontent.com/pw/ABC=m37",
    "https://lh3.googleusercontent.com/pw/ABC=m18",
    "https://lh3.googleusercontent.com/pw/ABC=dv",
  ], "720p first: it fills the card and starts sooner than 1080p");
  assert.deepEqual(videoUrls("https://lh3.googleusercontent.com/pw/ABC=w256-h171-no", "m18").map((url) => url.split("=").pop()), ["m18", "m22", "m37", "dv"], "the rendition that last worked goes first");
  assert.deepEqual(videoUrls("https://x/pw/ABC=w1", "bogus").map((url) => url.split("=").pop()), ["m22", "m37", "m18", "dv"]);
  assert.deepEqual(videoUrls(null), []);
}

// --- review fixes: filters, stale flings, view reset, DST --------------------------
{
  const clip = (id) => ({ ...item(id), kind: "video" });
  const deck = new SweepDeck({}, tick);
  deck.add([item("p1"), clip("v1"), item("p2")]);
  assert.ok(deck.keep());
  deck.setFilter((it) => it.kind === "video");
  assert.equal(deck.current?.id, "v1");
  assert.equal(deck.undo(), "p1");
  assert.equal(deck.current?.id, "v1", "undo does not surface an item the filter excludes");
  deck.setFilter(null);
  assert.equal(deck.current?.id, "p1", "clearing the filter offers the undone item again");

  assert.ok(deck.bin("p1"));
  assert.equal(deck.keep("p1"), null, "a stale fling for the previous card is ignored");
  assert.equal(deck.current?.id, "v1");

  deck.setFilter((it) => it.kind === "video");
  assert.ok(deck.unmark("p1"));
  assert.equal(deck.current?.id, "v1", "unmarking an excluded item doesn't put it on top");

  deck.resetView();
  assert.equal(deck.items.size, 0);
  assert.equal(deck.current, null);
  assert.equal(deck.add([item("p2"), clip("v1")]), 1, "decisions survive a view reset; only v1 is new and matches");
}
{
  // The inclusive end day is a calendar day, so a DST change inside it doesn't shift the bound.
  const { end } = rangeBounds({ to: "2026-03-29" });
  assert.equal(end, new Date(2026, 2, 30).getTime());
  const { end: autumn } = rangeBounds({ to: "2026-10-25" });
  assert.equal(autumn, new Date(2026, 9, 26).getTime());
}

{
  const deck = new SweepDeck({}, tick);
  deck.add([item("a"), item("b"), item("c")]);
  deck.keep();
  deck.bin();
  deck.keep();
  deck.markTrashed(["b"]);
  assert.deepEqual([deck.stats().kept, deck.stats().trashed], [2, 1]);
  assert.equal(deck.forgetKept(), 2);
  assert.equal(deck.add([item("a"), item("b"), item("c")]), 3, "kept and trashed items are offered again");
  assert.equal(deck.stats().kept, 0);
}
{
  const { viewKey } = await import("./src/photos-dom.js");
  const { viewName } = await import("./src/overlay.js");
  assert.equal(viewKey("https://photos.google.com/"), "/");
  assert.equal(viewKey("https://photos.google.com/photo/AF1Qx"), "/");
  assert.equal(viewKey("https://photos.google.com/album/AbC/photo/AF1Qx?x=1"), "/album/AbC");
  assert.equal(viewKey("https://photos.google.com/search/cats/"), "/search/cats");
  assert.equal(viewName("/"), "Photos");
  assert.equal(viewName("/album/AbC"), "an album");
  assert.equal(viewName("/search/red%20cars"), "search “red cars”");
  assert.equal(viewName("/favorites"), "Favourites");
}
{
  const { placeVisible, bisectScroll } = await import("./src/dates.js");
  assert.equal(placeVisible([null], 10), "unknown");
  assert.equal(placeVisible([30, 20, 10], 10), "newer");
  assert.equal(placeVisible([9, 5], 10), "older");
  assert.equal(placeVisible([12, 8], 10), "inside");

  // A 10,000-row newest-first grid, one photo per row, dated 10000 down to 1; a screen is 10 rows.
  const screen = (top) => Array.from({ length: 10 }, (_, i) => 10000 - (top + i));
  let probes = 0;
  const probe = async (top) => { probes += 1; return placeVisible(screen(top), 2500); };
  const { position } = await bisectScroll({ probe, from: 0, extent: () => 9990, step: 10 });
  assert.equal(placeVisible(screen(position), 2500), "newer", "lands on a screen entirely newer than the bound");
  assert.ok(position > 7400, `lands close to the bound (${position})`);
  assert.ok(probes <= 12, `binary search, not a walk (${probes} probes)`);

  // A grid that grows as it's scrolled (Google learns more of the library): it widens the search.
  let size = 2000;
  const growing = await bisectScroll({
    probe: async (top) => { size = Math.min(9990, Math.max(size, top + 2000)); return placeVisible(screen(top), 2500); },
    from: 0, extent: () => size, step: 10,
  });
  assert.equal(placeVisible(screen(growing.position), 2500), "newer");
  assert.ok(growing.position > 7400, `follows a growing grid (${growing.position})`);

  // Nothing dated on screen: stop where it is rather than guess.
  const blind = await bisectScroll({ probe: async () => "unknown", from: 50, extent: () => 9990, step: 10 });
  assert.equal(blind.position, 50);
}
console.log("sweep-photos tests passed");
