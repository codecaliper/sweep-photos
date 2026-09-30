import { HASH_HEIGHT, HASH_WIDTH, dhashFromRgba } from "./src/dupes.js";
import { formatRange, searchQueryFor, sweepUrlFor } from "./src/dates.js";

const PHOTOS_URL = "https://photos.google.com/";
const HASH_CONCURRENCY = 6;

async function toggleIn(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "sweep-toggle" });
  } catch {
    // Tabs opened before the extension was installed have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "sweep-toggle" });
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-sweep") return;
  if (tab?.id && tab.url?.startsWith(PHOTOS_URL)) await toggleIn(tab.id);
  else await chrome.tabs.create({ url: PHOTOS_URL });
});

// --- the toolbar popup: pick dates, then Sweep goes there ------------------------------

/** Resolves once the tab has started and finished loading a new page. */
async function waitForLoad(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let started = false;
  const startBy = Date.now() + 3000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading") started = true;
    if (tab.status === "complete" && (started || Date.now() > startBy)) return tab;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Google Photos didn't finish loading");
}

/** Sends to the content script, which registers at document_idle, just after "complete". */
async function sendToPage(tabId, message) {
  for (let tries = 0; ; tries += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (tries === 4) await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
      if (tries >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function navigate(tab, url) {
  if (tab?.id && tab.url?.startsWith(PHOTOS_URL)) {
    if (tab.url === url) await chrome.tabs.reload(tab.id);
    else await chrome.tabs.update(tab.id, { url, active: true });
    return waitForLoad(tab.id);
  }
  const created = await chrome.tabs.create({ url, active: true });
  return waitForLoad(created.id);
}

/**
 * Opens Sweep for a date range: on Google's own search for that month or year when one fits
 * (so the grid holds only that period), else on the timeline, which Sweep jumps along.
 * `here` sweeps the tab's current page without navigating.
 */
async function startSweep({ range, media, useSearch, here, tabId }) {
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const start = { type: "sweep-start", range, media };
  if (here && tab?.url?.startsWith(PHOTOS_URL)) {
    await chrome.tabs.update(tab.id, { active: true });
    return sendToPage(tab.id, { ...start, openEmpty: true });
  }
  const url = here ? PHOTOS_URL : sweepUrlFor(range, { useSearch });
  const page = await navigate(tab, url);
  const reply = await sendToPage(page.id, { ...start, openEmpty: url === PHOTOS_URL });
  if (reply?.tiles === 0 && url !== PHOTOS_URL) {
    // Google's search found nothing for that period: look through the timeline instead.
    const timeline = await navigate(page, PHOTOS_URL);
    return sendToPage(timeline.id, {
      ...start,
      openEmpty: true,
      note: `Google Photos search for "${searchQueryFor(range)}" found nothing, so Sweep is looking through your timeline for ${formatRange(range)}.`,
    });
  }
  return reply;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only from this extension's own popup page.
  if (message?.type !== "sweep-popup-start" || sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith(PHOTOS_URL) || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  startSweep(message).then(
    (reply) => sendResponse(reply || { ok: false }),
    (error) => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

async function hashImage(url) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob(), {
      resizeWidth: HASH_WIDTH,
      resizeHeight: HASH_HEIGHT,
      resizeQuality: "high",
    });
    const canvas = new OffscreenCanvas(HASH_WIDTH, HASH_HEIGHT);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return dhashFromRgba(context.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data);
  } catch {
    return null;
  }
}

async function hashAll(items) {
  const hashes = {};
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const { id, url } = items[next];
      next += 1;
      hashes[id] = await hashImage(url);
    }
  };
  await Promise.all(Array.from({ length: HASH_CONCURRENCY }, worker));
  return hashes;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "sweep-hash" || !sender.url?.startsWith(PHOTOS_URL)) return false;
  // Only Google's image CDN, so a page message can't turn this into a general fetcher.
  const items = (message.items || []).filter(({ url }) => /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//.test(url));
  hashAll(items).then(sendResponse, () => sendResponse({}));
  return true;
});

// --- toolbar badge: how many items are waiting (bin, archive, Locked Folder) ------

const DECISIONS_KEY = "sweepDecisions";

async function updateBadge(decisions) {
  decisions ??= (await chrome.storage.local.get(DECISIONS_KEY))[DECISIONS_KEY] || {};
  const count = Object.values(decisions).filter((entry) => ["bin", "archive", "lock"].includes(entry?.d)).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  await chrome.action.setBadgeText({ text: count ? (count > 999 ? "999+" : String(count)) : "" });
  await chrome.action.setTitle({ title: count ? `Sweep — ${count} marked for the bin` : "Sweep this Google Photos view" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && DECISIONS_KEY in changes) updateBadge(changes[DECISIONS_KEY].newValue || {});
});
chrome.runtime.onStartup.addListener(() => updateBadge());
chrome.runtime.onInstalled.addListener(() => updateBadge());

// --- trashing photos one at a time, from their own pages ------------------------------
// For marked photos that aren't in the grid the user is on (another album, another view),
// each photo's page is opened in a helper and the content script there presses Google's
// own trash button. The helper is an inactive tab tucked into a collapsed "Sweep" tab
// group, so nothing pops up. Background tabs are throttled, so if Google's page doesn't
// react there, that photo is retried in a small visible window, which is kept for the rest.

let helper = null; // { mode: "tab" | "window", tabId, windowId }
let preferWindow = false;

/** Only a photo page on photos.google.com for exactly this id. */
function photoPageUrl(id, href) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ""))) return null;
  try {
    const url = new URL(href);
    if (url.origin + "/" === PHOTOS_URL && url.pathname.endsWith(`/photo/${id}`)) return url.href;
  } catch {}
  return `${PHOTOS_URL}photo/${id}`;
}

async function waitForTab(tabId, id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url?.includes(`/photo/${id}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The photo page didn't load");
}

async function createHelperTab(url, opener) {
  const tab = await chrome.tabs.create({ url, active: false, windowId: opener.windowId, index: opener.index + 1 });
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: opener.windowId } });
    await chrome.tabGroups.update(groupId, { title: "Sweep", color: "grey", collapsed: true });
  } catch {
    // No tab groups (older Chrome or permission missing): an inactive tab still works.
  }
  return { mode: "tab", tabId: tab.id, windowId: tab.windowId };
}

async function createHelperWindow(url, opener) {
  const openerWindow = await chrome.windows.get(opener.windowId).catch(() => null);
  const width = 520;
  const base = { url, type: "popup", width, height: 720, focused: false };
  const beside = openerWindow ? { left: Math.max(0, openerWindow.left + openerWindow.width - width - 24), top: openerWindow.top + 80 } : {};
  // Chrome rejects bounds that are mostly off-screen (odd monitor layouts); then let it place the window.
  const created = await chrome.windows.create({ ...base, ...beside }).catch(() => chrome.windows.create(base));
  return { mode: "window", tabId: created.tabs[0].id, windowId: created.id };
}

async function openInHelper(url, opener) {
  const mode = preferWindow ? "window" : "tab";
  if (helper && helper.mode === mode) {
    try {
      await chrome.tabs.update(helper.tabId, { url });
      return helper.tabId;
    } catch {
      helper = null;
    }
  }
  await closeHelper();
  helper = mode === "window" ? await createHelperWindow(url, opener) : await createHelperTab(url, opener);
  return helper.tabId;
}

async function attempt({ id, href, action = "bin" }, opener) {
  const url = photoPageUrl(id, href);
  if (!url) return "missing";
  const tabId = await openInHelper(url, opener);
  await waitForTab(tabId, id);
  // The content script registers at document_idle, just after "complete".
  for (let tries = 0; ; tries += 1) {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: "sweep-trash-here", id, action });
      return reply?.outcome || "unverified";
    } catch (error) {
      if (tries >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function trashOne(message, opener) {
  let outcome;
  try {
    outcome = await attempt(message, opener);
  } catch (error) {
    if (preferWindow) throw error;
    outcome = "error";
  }
  // Retrying is safe: a photo that did go to Trash shows Restore ("already-trashed"), an
  // archived one offers Unarchive ("already"), and a locked one is gone ("missing").
  if (!preferWindow && (outcome === "unverified" || outcome === "error")) {
    preferWindow = true;
    outcome = await attempt(message, opener);
  }
  // Google asked something unexpected: show it, so the user can answer.
  if (outcome === "needs-user" && helper) await revealHelper();
  return outcome;
}

async function revealHelper() {
  const { tabId, windowId, mode } = helper;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.groupId >= 0) await chrome.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (mode === "window") await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  helper = null; // It's the user's now; the next run makes a fresh helper.
}

async function closeHelper() {
  const current = helper;
  helper = null;
  if (!current) return;
  if (current.mode === "window") await chrome.windows.remove(current.windowId).catch(() => {});
  else await chrome.tabs.remove(current.tabId).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (helper?.tabId === tabId) helper = null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab || !sender.url?.startsWith(PHOTOS_URL) || sender.tab.id === helper?.tabId) return false;
  if (message?.type === "sweep-trash-one") {
    trashOne(message, sender.tab).then(
      (outcome) => sendResponse({ outcome }),
      (error) => sendResponse({ outcome: "error", error: String(error?.message || error) }),
    );
    return true;
  }
  if (message?.type === "sweep-trash-close") {
    preferWindow = false;
    closeHelper().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
