// Everything that knows about Google Photos' markup lives here. There is no public
// API for deleting from a user's library, so Sweep drives the web UI the same way a
// person would: select items in the grid, then press Google's own trash button.
//
// Google does not publish this markup and it changes. The selectors are kept loose
// (roles, aria-labels, URL shapes) rather than generated class names.

import { bisectScroll, parseLabelDate, placeVisible } from "./dates.js";

const PHOTO_LINK = 'a[href*="photo/"]';
const PHOTO_ID = /\/photo\/([A-Za-z0-9_-]+)/;
// Exact labels only: a loose match could hit "Empty trash" or a dialog's own button.
const TRASH_LABEL = /^(move to (trash|bin)|delete|bin|trash)$/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- pure parsing (unit tested) ---------------------------------------------

export function photoIdFromHref(href) {
  return String(href || "").match(PHOTO_ID)?.[1] || null;
}

/**
 * The Google Photos view a URL belongs to, for "marked in another view" hints:
 * "/" for the main timeline, "/album/<id>", "/search/<term>", ... with any open photo dropped.
 */
export function viewKey(href) {
  try {
    const path = new URL(href, "https://photos.google.com/").pathname.replace(/\/photo\/[^/]*$/, "").replace(/\/+$/, "");
    return path || "/";
  } catch {
    return "/";
  }
}

/** "Photo - Landscape - 3 Sept 2026, 16:12:07" -> { kind: "photo", date: "3 Sept 2026, 16:12:07" } */
export function parseLabel(label) {
  const parts = String(label || "").split(/\s+[-–]\s+/).map((part) => part.trim()).filter(Boolean);
  return {
    kind: /video/i.test(parts[0] || "") ? "video" : "photo",
    date: parts.length > 1 ? parts[parts.length - 1] : "",
  };
}

export function urlFromBackground(style) {
  return String(style || "").match(/url\((['"]?)(.*?)\1\)/)?.[2] || null;
}

/** Swaps the "=..." options suffix of a googleusercontent URL. */
function withOptions(url, options) {
  if (!url) return url;
  const queryAt = url.indexOf("?");
  const base = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? "" : url.slice(queryAt);
  const equals = base.lastIndexOf("=");
  const root = equals > base.lastIndexOf("/") && /^[a-z0-9-]*$/i.test(base.slice(equals + 1))
    ? base.slice(0, equals)
    : base;
  return `${root}=${options}${query}`;
}

/** Rewrites a googleusercontent thumbnail URL to ask for a bigger rendition. */
export function sizedImageUrl(url, width, height) {
  return withOptions(url, `w${Math.round(width)}-h${Math.round(height)}-no`);
}

/** Google's video renditions on a thumbnail's base URL: 720p, 1080p, 360p MP4, then the original. */
export const VIDEO_RENDITIONS = ["m22", "m37", "m18", "dv"];

/**
 * Candidate stream URLs for a video tile, in the order the <video> element tries them
 * (with the user's Google cookies). 720p comes first: it fills the card and starts much
 * sooner than 1080p. `preferred` (the rendition that last worked) moves to the front, so
 * later videos skip the ones this library doesn't have.
 */
export function videoUrls(thumb, preferred = null) {
  if (!thumb) return [];
  const order = VIDEO_RENDITIONS.includes(preferred) ? [preferred, ...VIDEO_RENDITIONS.filter((r) => r !== preferred)] : VIDEO_RENDITIONS;
  return order.map((options) => withOptions(thumb, options));
}

/** Reads Google Photos' "12 selected" counter. Returns null when it is not showing. */
export function parseSelectedCount(text) {
  const match = String(text || "").match(/(\d[\d,.\s]*)\s+selected/i);
  return match ? Number(match[1].replace(/\D/g, "")) : null;
}

// --- DOM reading ---------------------------------------------------------------

export function isVisible(element) {
  if (!element?.isConnected || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

function visiblePhotoLinks() {
  return [...document.querySelectorAll(PHOTO_LINK)].filter((link) => photoIdFromHref(link.href) && isVisible(link));
}

export function findThumb(link) {
  const scopes = [link, link.parentElement].filter(Boolean);
  for (const scope of scopes) {
    for (const element of [scope, ...scope.querySelectorAll("*")]) {
      const background = urlFromBackground(element.style?.backgroundImage);
      if (background?.startsWith("http")) return background;
      if (element.tagName === "IMG" && element.src?.startsWith("http")) return element.src;
    }
  }
  return null;
}

/** Visible, loaded grid items in reading order (top-to-bottom, left-to-right). */
export function readGridItems() {
  const seen = new Set();
  const found = [];
  for (const link of visiblePhotoLinks()) {
    const id = photoIdFromHref(link.href);
    if (seen.has(id)) continue;
    const thumb = findThumb(link);
    if (!thumb) continue;
    seen.add(id);
    const label = link.getAttribute("aria-label") || "";
    const rect = link.getBoundingClientRect();
    found.push({ id, href: link.href, from: viewKey(location.href), thumb, label, ...parseLabel(label), ts: parseLabelDate(label), top: rect.top, left: rect.left, bottom: rect.bottom });
  }
  return found
    .sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left))
    .map(({ top, left, bottom, ...item }) => item);
}

/**
 * Only the tiles actually on screen. Google keeps screens of tiles rendered above and below
 * the viewport, and old ones linger for a moment after a jump, so date decisions (how far to
 * jump, whether the range is passed) must not look at those.
 */
export function readOnScreen(scroller = findScroller()) {
  const box = scroller && scroller !== document.scrollingElement
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: innerHeight };
  const onScreen = new Set();
  for (const link of visiblePhotoLinks()) {
    const rect = link.getBoundingClientRect();
    if (rect.bottom > box.top + 1 && rect.top < box.bottom - 1) onScreen.add(photoIdFromHref(link.href));
  }
  return readGridItems().filter((item) => onScreen.has(item.id));
}

export function findScroller() {
  const start = visiblePhotoLinks()[0];
  for (let element = start?.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (/(auto|scroll)/.test(overflowY) && element.scrollHeight > element.clientHeight + 10) return element;
  }
  return document.scrollingElement;
}

function linkFor(id) {
  return visiblePhotoLinks().find((link) => photoIdFromHref(link.href) === id) || null;
}

export function isOnPage(id) {
  return Boolean(linkFor(id));
}

export function selectedCount() {
  return parseSelectedCount(document.body.innerText);
}

/**
 * Scrolls the grid, handing every newly loaded batch to onItems (which returns how
 * many were new). Stops once `want` new items arrived, `until()` says so, or the
 * grid ends. While `canSkip(visibleItems)` holds, it scrolls in big jumps; if a
 * jump lands somewhere it can't vouch for, it backs up and walks normally.
 */
/**
 * On a newest-first grid, jumps straight to just before the first photo older than `bound`
 * by bisecting the scroll position (a dozen or so probes, instead of scrolling through
 * years of photos). Leaves the grid at a screen that's still entirely newer than `bound`.
 */
export async function seekBefore(bound, { log = () => {}, onProbe = () => {} } = {}) {
  const scroller = findScroller();
  if (!scroller) return false;
  const started = Date.now();
  const extent = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  let previous = "";
  // Scrolls, then waits until this position's own tiles are on screen, dated, and have stopped
  // changing: right after a jump the screen can still show the old position's tiles, or none yet.
  const settle = async (position) => {
    scroller.scrollTop = position;
    let last = "";
    let steady = 0;
    let screen = [];
    const settled = await waitFor(() => {
      screen = readOnScreen(scroller).filter((item) => typeof item.ts === "number");
      const key = screen.map((item) => item.id).join(",");
      steady = key && key === last ? steady + 1 : 0;
      last = key;
      return steady >= 2 && (key !== previous || moved < 2) ? key : null;
    }, 4000, 120);
    previous = settled || previous;
    return settled ? screen : null;
  };
  let moved = 0;
  const probe = async (position) => {
    moved = Math.abs(scroller.scrollTop - position);
    const settled = await settle(position);
    const screen = settled || [];
    onProbe(screen.at(-1)?.date || "");
    const place = settled ? placeVisible(screen.map((item) => item.ts), bound) : "unknown";
    log(`seek probe ${Math.round(position)}: ${place}${screen[0] ? ` (${screen[0].date} … ${screen.at(-1).date})` : ""}`);
    return place;
  };
  const from = scroller.scrollTop;
  const { position, probes } = await bisectScroll({ probe, from, extent, step: scroller.clientHeight });
  moved = Math.abs(scroller.scrollTop - position);
  await settle(position);
  log(`seek: ${probes} probes, ${Math.round(from)} → ${Math.round(position)} in ${Date.now() - started} ms`);
  return position > from;
}

export async function harvest(onItems, { want = 40, maxSteps = 12, until = () => false, canSkip = () => false, seek = null } = {}) {
  let visible = readGridItems();
  // Far from the range: jump there in one go rather than scrolling screen by screen.
  if (seek && canSkip(readOnScreen()) && await seek()) visible = readGridItems();
  let added = onItems(visible);
  let stuck = 0;
  for (let step = 0; step < maxSteps && added < want; step += 1) {
    if (until()) return { added, atEnd: false };
    const scroller = findScroller();
    if (!scroller) return { added, atEnd: true };
    const before = scroller.scrollTop;
    const skipping = canSkip(readOnScreen(scroller));
    scroller.scrollTop = before + scroller.clientHeight * (skipping ? 5 : 0.85);
    await sleep(stuck || skipping ? 900 : 450);
    visible = readGridItems();
    if (skipping && !canSkip(readOnScreen(scroller))) {
      scroller.scrollTop = before + scroller.clientHeight * 0.85;
      await sleep(900);
      visible = readGridItems();
    }
    added += onItems(visible);
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    stuck = scroller.scrollTop === before && atBottom ? stuck + 1 : 0;
    if (stuck >= 2) return { added, atEnd: true };
  }
  return { added, atEnd: false };
}

// --- DOM actions ---------------------------------------------------------------

export function clickLikeUser(element) {
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  element.dispatchEvent(new MouseEvent("mouseover", init));
  element.dispatchEvent(new PointerEvent("pointerdown", init));
  element.dispatchEvent(new MouseEvent("mousedown", init));
  element.dispatchEvent(new PointerEvent("pointerup", init));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.dispatchEvent(new MouseEvent("click", init));
}

function checkboxFor(link) {
  const inside = link.querySelector('[role="checkbox"]');
  if (inside) return inside;
  for (let element = link.parentElement, depth = 0; element && depth < 5; element = element.parentElement, depth += 1) {
    const boxes = element.querySelectorAll('[role="checkbox"]');
    if (boxes.length > 1 || element.querySelectorAll(PHOTO_LINK).length > 1) return null;
    if (boxes.length === 1) return boxes[0];
  }
  return null;
}

const isChecked = (box) => box.getAttribute("aria-checked") === "true";

/** Any ticked grid checkbox on screen: a selection exists even if the counter can't be read. */
export function anyChecked() {
  return [...document.querySelectorAll('[role="checkbox"][aria-checked="true"]')].some(isVisible);
}

/**
 * Whether Google Photos currently has a selection. `null` from the counter only means
 * "no counter shown", so ticked checkboxes are checked too.
 */
export function hasSelection() {
  return (selectedCount() || 0) > 0 || anyChecked();
}

export { dialogOpen as isDialogOpen };

/** Scrolls from the top of the grid ticking the checkbox of every wanted item. */
/** Scrolls without a new marked item before selecting gives up and leaves the rest to one-by-one. */
const SELECT_IDLE_SCROLLS = 80;
/** Marked items seen but not tickable, with none ticked, before deciding ticking doesn't work here. */
const SELECT_BROKEN_AFTER = 3;

/**
 * Scrolls from the top of the grid ticking the checkbox of every wanted item.
 *
 * It stops early rather than walking a whole library:
 * - `olderThan` (ms): the grid is newest-first and everything visible is older, so they're not here
 * - SELECT_IDLE_SCROLLS scrolls in a row without meeting a wanted item
 * - ticking fails repeatedly and nothing got ticked (Google changed its markup)
 * - `shouldStop()` returns true (the user pressed Stop searching)
 * Unticked items come back as `missing`, so the caller can try another route for them.
 */
export async function selectItems(ids, { onProgress = () => {}, limit = Infinity, olderThan = null, newerThan = null, shouldStop = () => false, log = () => {} } = {}) {
  const wanted = new Set(ids);
  const target = Math.min(wanted.size, limit);
  const selected = new Set();
  const seen = new Set();
  const scanned = new Set();
  let scroller = findScroller();
  if (scroller) scroller.scrollTop = 0;
  await sleep(700);
  // Newest-first timeline: skip straight past everything newer than the newest marked photo.
  if (newerThan !== null) await seekBefore(newerThan, { log });

  let stuck = 0;
  let idle = 0;
  let failed = 0;
  let reason = "end";
  let at = "";
  while (selected.size < target) {
    if (shouldStop()) {
      reason = "stopped";
      break;
    }
    let met = false;
    const links = visiblePhotoLinks();
    for (const link of links) {
      if (selected.size >= target) break;
      const id = photoIdFromHref(link.href);
      scanned.add(id);
      if (!wanted.has(id) || selected.has(id)) continue;
      if (!seen.has(id)) met = true;
      seen.add(id);
      const box = checkboxFor(link);
      if (box && !isChecked(box)) {
        link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        clickLikeUser(box);
        // Wait for Google to reflect it; a second click before then would deselect.
        await waitFor(() => isChecked(box), 800, 60);
      }
      if (box && isChecked(box)) selected.add(id);
      else failed += 1;
    }
    const dates = links.map((link) => parseLabelDate(link.getAttribute("aria-label") || ""));
    at = parseLabel(links.at(-1)?.getAttribute("aria-label") || "").date || at;
    onProgress(selected.size, target, { scanned: scanned.size, at });
    if (selected.size >= target) break;
    if (!selected.size && failed >= SELECT_BROKEN_AFTER) {
      reason = "untickable";
      break;
    }
    if (olderThan !== null && dates.length && dates.every((ts) => ts !== null && ts < olderThan)) {
      reason = "past";
      break;
    }
    idle = met ? 0 : idle + 1;
    if (idle >= SELECT_IDLE_SCROLLS) {
      reason = "idle";
      break;
    }

    scroller = findScroller();
    if (!scroller) break;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + scroller.clientHeight * 0.8;
    await sleep(stuck ? 900 : 450);
    stuck = scroller.scrollTop === before ? stuck + 1 : 0;
    if (stuck >= 3) break;
  }
  // Stopped at the limit: the rest of the grid wasn't walked, so nothing else can be called missing.
  const limited = selected.size >= limit && selected.size < wanted.size;
  const missing = limited ? [] : [...wanted].filter((id) => !selected.has(id));
  // "unselectable": on the page but Sweep couldn't tick it; "absent": never seen at all.
  return {
    selected: [...selected],
    missing,
    unselectable: missing.filter((id) => seen.has(id)),
    absent: missing.filter((id) => !seen.has(id)),
    limited,
    reason: limited ? "limit" : selected.size >= target ? "done" : reason,
  };
}

/** True for toolbar labels that mean "move the selection to trash" (never album deletion). */
export function isTrashButtonLabel(text) {
  const label = String(text || "").replace(/\s+/g, " ").trim();
  if (!label || /album|permanent/i.test(label)) return false;
  return TRASH_LABEL.test(label);
}

export function findTrashButton() {
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
  const label = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || "").trim();
  // Never a button inside a dialog or menu: those are confirmations, not the toolbar action.
  return buttons.find((button) => isTrashButtonLabel(label(button)) && !button.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) || null;
}

const MORE_OPTIONS = /^more options$/i;

/** A visible "Move to trash" / "Move to bin" item in an open menu (never "Remove from album"). */
export function findTrashMenuItem() {
  const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')].filter(isVisible);
  return items.find((item) => {
    const lines = String(item.innerText || item.textContent || "").split("\n");
    return isTrashConfirmLabel(item.getAttribute("aria-label")) || isTrashConfirmLabel(item.textContent) || lines.some(isTrashConfirmLabel);
  }) || null;
}

function pressEscape() {
  const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", init));
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keyup", init));
}

/** Google Photos' own "#" (Shift+3) shortcut: move the current selection to trash. */
export function pressTrashShortcut() {
  const init = { key: "#", code: "Digit3", keyCode: 51, which: 51, shiftKey: true, bubbles: true, cancelable: true, composed: true };
  const target = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: 35 }));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

const trashStarted = () => dialogOpen() || !hasSelection();

function pressKey(target, key, code, keyCode, extra = {}) {
  const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, ...extra };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/**
 * Starts "move selection to trash" the way Google's UI allows on this page:
 *  1. the toolbar trash icon (library, search, favourites)
 *  2. the ⋮ More options menu → "Move to trash" (albums hide the icon there)
 *  3. the "#" keyboard shortcut
 * A route only counts once Google reacts (its dialog opens or the selection clears);
 * otherwise the next one is tried. Returns the route used, or null. Only ever starts
 * Google's own trash flow; the confirmation dialog is handled by confirmTrash().
 */
export async function startTrash({ buttonWaitMs = 3000, reactMs = 2500, log = () => {} } = {}) {
  const button = await waitFor(findTrashButton, buttonWaitMs);
  if (button) {
    log("route: toolbar button", button.getAttribute("aria-label"));
    clickLikeUser(button);
    if (await waitFor(trashStarted, reactMs)) return "button";
    log("toolbar button: no reaction");
  }

  const menus = [...document.querySelectorAll('button, [role="button"]')]
    .filter((element) => isVisible(element) && MORE_OPTIONS.test((element.getAttribute("aria-label") || element.getAttribute("title") || "").trim()))
    .reverse();
  log("more-options buttons", menus.length);
  for (const menu of menus) {
    clickLikeUser(menu);
    const item = await waitFor(findTrashMenuItem, 1500);
    if (!item) {
      log("menu without a trash item", [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible).map((el) => el.textContent.trim()));
      pressEscape();
      await sleep(300);
      continue;
    }
    log("route: menu item", item.textContent.trim());
    clickLikeUser(item);
    if (await waitFor(trashStarted, reactMs)) return "menu";
    // Some menus only act on keyboard activation.
    item.focus?.();
    pressKey(item, "Enter", "Enter", 13);
    if (await waitFor(trashStarted, reactMs)) return "menu";
    log("menu item: no reaction");
    pressEscape();
    await sleep(300);
  }

  if (!selectedCount()) return null;
  log("route: # shortcut");
  pressTrashShortcut();
  return (await waitFor(trashStarted, 3000)) ? "shortcut" : null;
}

export async function waitFor(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return check() || null;
}

const dialogOpen = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(isVisible);

// Exact match on purpose: a "Delete permanently" dialog must never be auto-confirmed.
const TRASH_CONFIRM = /^move to (trash|bin)$/i;

export function isTrashConfirmLabel(text) {
  return TRASH_CONFIRM.test(String(text || "").replace(/\s+/g, " ").trim());
}

/** The "Move to trash" button inside Google's visible confirmation dialog, if any. */
export function findTrashConfirm() {
  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (!isVisible(dialog)) continue;
    const button = [...dialog.querySelectorAll('button, [role="button"]')]
      .find((candidate) => isVisible(candidate) && (isTrashConfirmLabel(candidate.textContent) || isTrashConfirmLabel(candidate.getAttribute("aria-label"))));
    if (button) return button;
  }
  return null;
}

/**
 * After Google's trash button is pressed, confirms Google's "Move to trash" dialog
 * (or, with autoConfirm off or an unexpected dialog, waits for the user to). Like
 * Sweep on Android, the outcome is read back from the page rather than assumed:
 * the items must actually have left the grid.
 */
export async function confirmTrash(probeIds, { autoConfirm = true, onNeedsUser = () => {}, confirmTimeoutMs = 180000, settleMs = 10000, log = () => {}, findConfirm = findTrashConfirm, leaves = true, dialogWaitMs = 5000 } = {}) {
  const sawDialog = Boolean(await waitFor(dialogOpen, dialogWaitMs));
  if (sawDialog) {
    const button = autoConfirm ? await waitFor(findConfirm, 2000) : null;
    log("dialog buttons", [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].filter(isVisible).map((el) => el.textContent.trim()));
    if (button) clickLikeUser(button);
    else onNeedsUser();
    const closed = await waitFor(() => !dialogOpen(), button ? 15000 : confirmTimeoutMs, 300);
    if (!closed) return "timeout";
  }

  // Google removes trashed tiles asynchronously; give it time before judging. Archiving
  // only leaves the timeline (albums still show the photo), so there the cleared selection is the sign.
  const gone = () => !hasSelection() && (!leaves || !probeIds.some(isOnPage));
  if (await waitFor(gone, settleMs, 300)) return "trashed";
  const stillSelected = hasSelection();
  const stillShown = probeIds.filter(isOnPage).length;
  log("outcome", { sawDialog, stillSelected, stillShown, probed: probeIds.length });
  if (!sawDialog) return "no-dialog";
  // The selection cleared and some tiles went away: Google did trash, the grid just lags.
  if (!stillSelected && stillShown < probeIds.length) return "trashed";
  return "cancelled";
}

// --- one photo at a time, from its own page -------------------------------------------

const RESTORE_LABEL = /^restore$/i;

/** A visible "Restore" button means this photo page is showing an item already in Trash. */
function restoreButton() {
  const label = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").replace(/\s+/g, " ").trim();
  return [...document.querySelectorAll('button, [role="button"]')].find((button) => isVisible(button) && RESTORE_LABEL.test(label(button))) || null;
}

/**
 * On a photos.google.com/photo/<id> page, moves that one photo to Trash with the viewer's
 * own trash button and Google's "Move to trash" confirmation. The result is read back from
 * the page: Google leaves the photo's page once it has been trashed.
 *
 * Returns "trashed", "already-trashed" (the page shows Restore), "missing" (no such photo
 * here), "needs-user" (Google asked something other than Move to trash), or "unverified".
 */
export async function trashOpenPhoto(id, { log = () => {}, buttonWaitMs = 8000, settleMs = 10000 } = {}) {
  const here = () => photoIdFromHref(location.href) === id;
  if (!await waitFor(here, 3000, 100)) {
    log("one: not on its page", { id, at: location.pathname });
    return "missing";
  }
  const found = await waitFor(() => (restoreButton() ? "restore" : findTrashButton()), buttonWaitMs, 150);
  if (found === "restore") return "already-trashed";
  if (!found) {
    log("one: no trash button", { id });
    return "missing";
  }
  if (dialogOpen()) return "needs-user";

  log("one: pressing", { id, label: found.getAttribute("aria-label") });
  clickLikeUser(found);
  const reacted = await waitFor(() => (dialogOpen() ? "dialog" : !here() ? "left" : null), 5000, 100);
  if (reacted === "left") return "trashed";
  if (!reacted) return "unverified";

  const confirm = await waitFor(findTrashConfirm, 3000, 100);
  if (!confirm) {
    log("one: unexpected dialog, left for the user", { id });
    return "needs-user";
  }
  clickLikeUser(confirm);
  // Google moves on to the next photo (or back to the grid) once the item is in Trash.
  const done = await waitFor(() => !here() || restoreButton(), settleMs, 150);
  log("one: outcome", { id, done: Boolean(done), at: location.pathname });
  return done ? "trashed" : "unverified";
}

// --- archive and Locked Folder ---------------------------------------------------------

const ARCHIVE_LABEL = /^archive$/i;
const UNARCHIVE_LABEL = /^unarchive$/i;
const LOCK_LABEL = /^move to locked folder$/i;
// Exact: only Google's own "Move" in a dialog about the Locked Folder is ever pressed for you.
const LOCK_CONFIRM = /^(move|move to locked folder)$/i;

const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

/** A visible menu item whose label (or one of its lines) matches `pattern` exactly. */
export function findMenuItem(pattern) {
  const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')].filter(isVisible);
  return items.find((item) => {
    const lines = String(item.innerText || item.textContent || "").split("\n").map(clean);
    // Google may put a shortcut hint ("Shift+A") next to the label, so parts count too.
    return pattern.test(clean(item.getAttribute("aria-label"))) || lines.some((line) => pattern.test(line))
      || [item, ...item.querySelectorAll("*")].some((part) => pattern.test(clean(part.textContent)));
  }) || null;
}

/** The "Move" button in Google's visible "Move to Locked Folder?" dialog, if any. */
export function findLockConfirm() {
  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (!isVisible(dialog) || !/locked folder/i.test(dialog.textContent || "")) continue;
    const button = [...dialog.querySelectorAll('button, [role="button"]')]
      .find((candidate) => isVisible(candidate) && (LOCK_CONFIRM.test(clean(candidate.textContent)) || LOCK_CONFIRM.test(clean(candidate.getAttribute("aria-label")))));
    if (button) return button;
  }
  return null;
}

const MENU_ACTIONS = {
  archive: { item: ARCHIVE_LABEL, findConfirm: () => null, leaves: false },
  lock: { item: LOCK_LABEL, findConfirm: findLockConfirm, leaves: true },
};

function moreOptionsButtons() {
  return [...document.querySelectorAll('button, [role="button"]')]
    .filter((element) => isVisible(element) && MORE_OPTIONS.test(clean(element.getAttribute("aria-label") || element.getAttribute("title")))
      && !element.closest('[role="dialog"], [role="alertdialog"], [role="menu"]'))
    .reverse();
}

/** Opens each ⋮ menu in turn until one offers `pattern`; returns that item (menu left open) or null. */
async function openMenuWith(pattern, log) {
  for (const menu of moreOptionsButtons()) {
    clickLikeUser(menu);
    const item = await waitFor(() => findMenuItem(pattern), 1500);
    if (item) return item;
    log("menu without", String(pattern), [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible).map((el) => clean(el.textContent)).join(" | "));
    pressEscape();
    await sleep(300);
  }
  return null;
}

/** Google Photos' Shift+A shortcut: archive the current selection. */
function pressArchiveShortcut() {
  const target = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
  pressKey(target, "A", "KeyA", 65, { shiftKey: true });
}

/**
 * Starts "Archive" or "Move to Locked Folder" for the current grid selection from Google's
 * ⋮ More options menu (archive falls back to Google's Shift+A). Counts only once Google
 * reacts: a dialog opens or the selection clears. Returns the route used, or null.
 */
export async function startMenuAction(kind, { reactMs = 2500, log = () => {} } = {}) {
  const spec = MENU_ACTIONS[kind];
  const item = await openMenuWith(spec.item, log);
  if (item) {
    log(`route: menu item ${clean(item.textContent)}`);
    clickLikeUser(item);
    if (await waitFor(trashStarted, reactMs)) return "menu";
    item.focus?.();
    pressKey(item, "Enter", "Enter", 13);
    if (await waitFor(trashStarted, reactMs)) return "menu";
    log("menu item: no reaction");
    pressEscape();
    await sleep(300);
  }
  if (kind !== "archive" || !selectedCount()) return null;
  log("route: Shift+A shortcut");
  pressArchiveShortcut();
  return (await waitFor(trashStarted, 3000)) ? "shortcut" : null;
}

/** confirmTrash for archive / Locked Folder: presses only that action's own confirmation. */
export function confirmAction(kind, probeIds, options = {}) {
  const { findConfirm, leaves } = MENU_ACTIONS[kind];
  return confirmTrash(probeIds, { ...options, findConfirm, leaves, dialogWaitMs: kind === "archive" ? 1500 : 5000 });
}

/**
 * On a photo's own page, archives it or moves it to the Locked Folder from the viewer's ⋮
 * menu. Returns "done", "already" (archive: the menu offers Unarchive), "missing",
 * "needs-user" (Google asked something else, e.g. to verify it's you) or "unverified".
 */
export async function actOnOpenPhoto(id, kind, { log = () => {}, buttonWaitMs = 8000, settleMs = 10000 } = {}) {
  if (kind === "bin") return trashOpenPhoto(id, { log, buttonWaitMs, settleMs });
  const spec = MENU_ACTIONS[kind];
  const here = () => photoIdFromHref(location.href) === id;
  if (!await waitFor(here, 3000, 100)) return "missing";
  if (!await waitFor(() => moreOptionsButtons().length, buttonWaitMs, 150)) {
    log("one: no ⋮ menu", { id });
    return "missing";
  }
  if (dialogOpen()) return "needs-user";
  const pattern = kind === "archive" ? new RegExp(`${ARCHIVE_LABEL.source}|${UNARCHIVE_LABEL.source}`, "i") : spec.item;
  const item = await openMenuWith(pattern, log);
  if (!item) return "missing";
  if (kind === "archive" && findMenuItem(UNARCHIVE_LABEL) && !findMenuItem(ARCHIVE_LABEL)) {
    pressEscape();
    return "already";
  }
  clickLikeUser(findMenuItem(spec.item) || item);
  const reacted = await waitFor(() => (dialogOpen() ? "dialog" : !here() ? "left" : null), kind === "archive" ? 1500 : 5000, 100);
  if (reacted === "left") return "done";
  if (reacted === "dialog") {
    const confirm = await waitFor(spec.findConfirm, 3000, 100);
    if (!confirm) {
      log(`one: unexpected dialog, left for the user: ${id}`);
      return "needs-user";
    }
    clickLikeUser(confirm);
    await waitFor(() => !dialogOpen(), 5000, 100);
  }
  if (kind === "lock") {
    // Locked photos leave the library, so Google moves on from this page.
    return (await waitFor(() => !here(), settleMs, 150)) ? "done" : "unverified";
  }
  // Archived photos stay open; reading the menu back shows Unarchive once it took effect.
  for (let tries = 0; tries < 3; tries += 1) {
    await sleep(600);
    const back = await openMenuWith(new RegExp(`${ARCHIVE_LABEL.source}|${UNARCHIVE_LABEL.source}`, "i"), log);
    const archived = Boolean(findMenuItem(UNARCHIVE_LABEL));
    if (back) pressEscape();
    if (archived) return "done";
  }
  return "unverified";
}
