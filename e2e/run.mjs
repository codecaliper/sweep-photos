// End-to-end tests: loads the unpacked extension into Chrome for Testing and drives
// it against a local HTTPS mock of Google Photos. photos.google.com and
// lh3.googleusercontent.com are proxied to the mock server, so the content script,
// service-worker hashing and video streaming all run exactly as in production.
//
//   npm run e2e            (HEADFUL=1 to watch, CHROME_PATH=... to pick a binary)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { makeItems, patternPng } from "./fixtures.mjs";
import { RUNTIME_FILES } from "../tools/runtime-files.mjs";

const fixtureTs = new Map(makeItems(300).map((item) => [item.id, item.ts]));

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-e2e-"));

// Load a copy of just the runtime files, so e2e/node_modules never ends up in the extension.
const EXTENSION = path.join(work, "extension");
for (const entry of RUNTIME_FILES) {
  const from = path.resolve(here, "..", entry);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(EXTENSION, entry), { recursive: true });
}

// --- fixtures --------------------------------------------------------------------

function selfSignedCert() {
  const key = path.join(work, "key.pem");
  const cert = path.join(work, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=photos.google.com",
    "-addext", "subjectAltName=DNS:photos.google.com,DNS:lh3.googleusercontent.com", "-keyout", key, "-out", cert], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function testClip() {
  const clip = path.join(work, "clip.mp4");
  try {
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-t", "3",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip], { stdio: "ignore" });
    return fs.readFileSync(clip);
  } catch {
    return null;
  }
}

const mp4 = testClip();
const mockScript = fs.readFileSync(path.join(here, "mock-photos.js"));
const MAX_ITEMS = 300;
const byId = new Map(makeItems(MAX_ITEMS).map((item) => [item.id, item]));

// Google's side of Trash, shared by every mock tab (grid and single-photo pages).
const trashed = new Set();
const archived = new Set();
const locked = new Set();
const trashLog = [];
const photoLoads = new Map();
const videoRequests = [];
const searches = [];

const shell = (items, viewer = null) => `<!doctype html><html><head><meta charset="utf-8"><title>Photos - Google Photos</title>
<style>
  body { margin: 0; font: 14px system-ui; }
  #bar { position: fixed; inset: 0 0 auto; height: 48px; display: flex; gap: 8px; align-items: center; padding: 0 12px; background: #fff; z-index: 2; }
  #scroll { position: fixed; inset: 48px 0 0; overflow-y: auto; }
  #spacer { position: relative; }
  .tile { position: absolute; width: 176px; height: 176px; }
  .tile a, .tile img { display: block; width: 100%; height: 100%; }
  .tile [role=checkbox] { position: absolute; top: 6px; left: 6px; width: 20px; height: 20px; background: #fff8; }
  [role=menu] { position: fixed; top: 48px; right: 12px; background: #fff; border: 1px solid #ccc; }
  [role=menuitem] { padding: 8px 16px; cursor: pointer; }
  [role=dialog] { position: fixed; inset: 30% 30% auto; background: #fff; border: 1px solid #333; padding: 20px; z-index: 3; }
</style></head><body>
<script type="application/json" id="items">${JSON.stringify(items)}</script>
<script type="application/json" id="viewer">${JSON.stringify(viewer)}</script>
<script src="/__mock/app.js"></script></body></html>`;

function handle(request, response) {
  const host = request.headers.host?.split(":")[0];
  const url = new URL(request.url, `https://${host}`);
  if (host === "lh3.googleusercontent.com") {
    const [, id, options] = url.pathname.match(/^\/pw\/([^=]+)=(.*)$/) || [];
    const item = byId.get(id);
    if (!item) return response.writeHead(404).end();
    if (/^(m\d+|dv)$/.test(options)) {
      videoRequests.push(`${id}=${options}`);
      // Only the 360p rendition exists, so the player has to fall back through the list.
      if (item.kind !== "video" || options !== "m18" || !mp4) return response.writeHead(404).end();
      return response.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length }).end(mp4);
    }
    return response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }).end(patternPng(item.seed, item.tweak));
  }
  if (url.pathname === "/__mock/trash" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { ids, from, action = "trash" } = JSON.parse(body || "{}");
      for (const id of ids || []) ({ trash: trashed, archive: archived, lock: locked })[action].add(id);
      trashLog.push(`${action === "trash" ? "" : `${action}-`}${from}:${(ids || []).length}`);
      response.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === "/__mock/app.js") return response.writeHead(200, { "content-type": "text/javascript" }).end(mockScript);
  if (url.pathname === "/favicon.ico") return response.writeHead(404).end();
  // Same Trusted Types policy as the real site: any innerHTML in the overlay would throw.
  response.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'" });
  const photo = url.pathname.match(/\/photo\/([A-Za-z0-9_-]+)$/)?.[1];
  if (photo) {
    const status = !byId.has(photo) || locked.has(photo) ? "missing" : trashed.has(photo) ? "trashed" : archived.has(photo) ? "archived" : "live";
    photoLoads.set(photo, (photoLoads.get(photo) || 0) + 1);
    // ?flaky=1: the first load ignores the trash button, like a throttled background tab.
    const deaf = url.searchParams.has("flaky") && photoLoads.get(photo) === 1;
    return response.end(shell([], { id: photo, status, confirm: url.searchParams.get("confirm"), deaf, verify: url.searchParams.has("verify") }));
  }
  const count = Math.min(Number(url.searchParams.get("n")) || 60, MAX_ITEMS);
  // Google's search for "January 2020" or "2020": only that period, newest first.
  const search = url.pathname.match(/^\/search\/(.+)$/)?.[1];
  if (search) {
    searches.push(decodeURIComponent(search));
    const [, monthName, year] = decodeURIComponent(search).match(/^(?:([A-Za-z]+) )?(\d{4})$/) || [];
    const matches = (item) => {
      const date = new Date(item.ts);
      return year && date.getFullYear() === Number(year)
        && (!monthName || date.toLocaleString("en-GB", { month: "long" }) === monthName);
    };
    return response.end(shell(makeItems(MAX_ITEMS).filter((item) => matches(item) && !trashed.has(item.id))));
  }
  // Archived photos leave the timeline but stay in albums; locked ones leave everywhere.
  const album = url.pathname.startsWith("/album/");
  response.end(shell(makeItems(count).filter((item) => !trashed.has(item.id) && !locked.has(item.id) && (album || !archived.has(item.id)))));
}

// --- browser ----------------------------------------------------------------------

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const bundled = puppeteer.executablePath();
    if (fs.existsSync(bundled)) return bundled;
  } catch {}
  const cache = path.join(os.homedir(), ".cache/puppeteer/chrome");
  for (const build of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
    const candidates = [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-linux64/chrome",
    ].map((relative) => path.join(cache, build, relative));
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
  }
  throw new Error("Chrome for Testing not found: run `npx puppeteer browsers install chrome` or set CHROME_PATH.");
}

const server = https.createServer(selfSignedCert(), handle);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// Chrome's proxy tunnels both hosts to the mock; anything else is refused, so the
// tests can never touch the real Google Photos.
const MOCKED = new Set(["photos.google.com:443", "lh3.googleusercontent.com:443"]);
const proxy = http.createServer((request, response) => response.writeHead(403).end());
proxy.on("connect", (request, client, head) => {
  if (!MOCKED.has(request.url)) {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = net.connect(port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  executablePath: chromePath(),
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    `--proxy-server=127.0.0.1:${proxy.address().port}`,
    "--proxy-bypass-list=<-loopback>",
    "--ignore-certificate-errors",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,900",
    // CI runners (Ubuntu 24.04) block the user namespaces Chrome's sandbox needs.
    ...(process.env.CI ? ["--no-sandbox"] : []),
  ],
});

/** The extension's service worker, once its chrome.* bindings are ready (it may have restarted). */
async function extensionWorker() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const target = browser.targets().find((candidate) => candidate.type() === "service_worker" && candidate.url().endsWith("/background.js"));
    const worker = await target?.worker().catch(() => null);
    if (worker && await worker.evaluate(() => Boolean(globalThis.chrome?.storage?.local)).catch(() => false)) return worker;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The extension's service worker never became ready");
}

// --- helpers ------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pageCount = 0;

async function openPhotos(pathname = "/", { firstRun = false, alreadyTrashed = [], alreadyArchived = [], empty = false } = {}) {
  trashed.clear();
  archived.clear();
  locked.clear();
  trashLog.length = 0;
  photoLoads.clear();
  videoRequests.length = 0;
  searches.length = 0;
  for (const trashedId of alreadyTrashed) trashed.add(trashedId);
  for (const archivedId of alreadyArchived) archived.add(archivedId);
  // A clean profile each time; the first-run help is pre-dismissed unless a scenario wants it.
  await (await extensionWorker()).evaluate(async (seen) => {
    await chrome.storage.local.clear();
    if (seen) await chrome.storage.local.set({ sweepHelpSeen: true });
  }, !firstRun);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.problems = [];
  page.logs = [];
  page.on("pageerror", (error) => page.problems.push(String(error)));
  page.on("console", (message) => {
    if (/\[sweep\]/.test(message.text())) page.logs.push(message.text());
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) page.problems.push(message.text());
  });
  // A unique query string so the worker can find exactly this tab.
  pageCount += 1;
  await page.goto(`https://photos.google.com${pathname}${pathname.includes("?") ? "&" : "?"}tab=${pageCount}`);
  if (empty) await page.waitForFunction(() => window.__mock);
  else await page.waitForSelector(".tile a");
  return page;
}

async function toggleSweep(page) {
  await page.bringToFront();
  const result = await (await extensionWorker()).evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    if (!tab) return "no tab";
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "sweep-toggle" });
    } catch (error) {
      return String(error);
    }
  }, page.url());
  if (!result?.ok) throw new Error(`Toggle failed: ${JSON.stringify(result)}`);
}

/** Snapshot of the overlay and the mock page. */
function ui(page) {
  return page.evaluate(() => {
    const root = document.querySelector("sweep-photos")?.shadowRoot;
    const text = (selector) => root?.querySelector(selector)?.textContent?.trim() || "";
    const video = root?.querySelector(".card.top video");
    return {
      open: Boolean(root?.querySelector(".app:not([hidden])")),
      top: root?.querySelector(".card.top")?.dataset.id || null,
      counts: text(".counts"),
      bin: text(".basket-chip"),
      status: text(".status"),
      pill: root?.querySelector(".pill:not([hidden])")?.textContent || "",
      heading: text(".stage h2"),
      elsewhere: text(".elsewhere"),
      help: root?.querySelector(".help:not([hidden])") ? [...root.querySelectorAll(".help .totals")].map((p) => p.textContent.trim()).join(" · ") || "open" : null,
      video: video ? { src: video.currentSrc, time: video.currentTime, paused: video.paused, hidden: video.hidden, ready: video.readyState } : null,
      mock: window.__mock.state(),
      dialog: document.querySelector("[role=dialog]")?.textContent || null,
    };
  });
}

async function until(page, predicate, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await ui(page);
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}. Last state: ${JSON.stringify(last, null, 2)}`);
}

async function click(page, selector) {
  await page.evaluate((target) => {
    const element = document.querySelector("sweep-photos").shadowRoot.querySelector(target);
    if (!element) throw new Error(`No ${target} in the overlay`);
    element.click();
  }, selector);
}

async function press(page, key, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press(key);
    await sleep(320);
  }
}

const id = (n) => `AF1QipMock${String(n).padStart(2, "0")}`;

async function oldRangeJump(path, first = 280, last = 282) {
  const page = await openPhotos(path);
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    const day = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    await press(page, "r");
    await page.evaluate(([from, to]) => {
      const inputs = document.querySelector("sweep-photos").shadowRoot.querySelectorAll("input[type=date]");
      inputs[0].value = from;
      inputs[1].value = to;
    }, [day(fixtureTs.get(id(last))), day(fixtureTs.get(id(first)))]);
    const started = Date.now();
    await click(page, '[data-action="applyRange"]');
    await until(page, (s) => s.top === id(first), "first card in an old range", 30000);
    const took = Date.now() - started;
    const seeks = page.logs.filter((line) => /\[sweep\] seek:/.test(line));
    assert.equal(seeks.length, 1, `jumped once: ${page.logs.join("\n")}`);
    assert.ok(took < 12000, `reached in ${took} ms`);
    await press(page, "k", 3);
    const end = await until(page, (s) => /Nothing left in/.test(s.heading), "range exhausted");
    assert.match(end.counts, /^3 reviewed/, "nothing in range was skipped by the jump");
    return page;
}

/** Opens the toolbar popup as a page, aimed at the Google Photos tab `page`. */
async function openPopup(page) {
  const worker = await extensionWorker();
  const target = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  const extensionId = new URL(worker.url()).host;
  const popup = await browser.newPage();
  popup.problems = [];
  popup.on("pageerror", (error) => popup.problems.push(String(error)));
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${target}`);
  await popup.waitForSelector("#go");
  return popup;
}

async function popupPlan(popup) {
  return popup.$eval("#plan", (element) => element.textContent);
}

/** Waits until Sweep's overlay is open on whatever page the Photos tab navigated to. */
async function sweepOpenOn(page, predicate, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = await ui(page);
      if (predicate(state)) return state;
    } catch {
      // Mid-navigation.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what} at ${page.url()}`);
}

// --- scenarios --------------------------------------------------------------------------

const scenarios = {
  async "swipe, undo and bin count"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.open && s.top === id(0), "first card");
    await press(page, "k");
    await until(page, (s) => s.top === id(1), "keep advances");
    await press(page, "d");
    await until(page, (s) => s.top === id(2) && s.bin.includes("1"), "bin advances and counts");
    await press(page, "z");
    await until(page, (s) => s.top === id(1) && s.bin.includes("0"), "undo restores the card");
    await press(page, "Escape");
    await until(page, (s) => !s.open, "Esc closes");
    return page;
  },

  async "trash from the library via the toolbar button"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "k");
    await press(page, "d", 3);
    await until(page, (s) => s.bin.includes("3"), "three binned");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /Moved 3/.test(s.status), "trash outcome");
    assert.equal(done.mock.remaining, 57);
    assert.deepEqual(done.mock.log, ["toolbar-trash", "confirm", "trashed:3"]);
    assert.ok(done.bin.includes("0"));
    return page;
  },

  async "trash inside an album via the ⋮ menu, never Remove from album"() {
    const page = await openPhotos("/album/MOCK");
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "d", 2);
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /Moved 2/.test(s.status), "album trash outcome");
    assert.ok(!done.mock.log.includes("REMOVED-FROM-ALBUM"));
    assert.ok(done.mock.log.includes("menu-trash") && done.mock.log.includes("confirm"));
    assert.equal(done.mock.remaining, 58);
    return page;
  },

  async "an existing Google selection blocks trashing"() {
    const page = await openPhotos();
    await page.waitForSelector('[role="checkbox"]');
    await page.evaluate(() => document.querySelectorAll('[role="checkbox"]')[10].click());
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "d");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /already has a selection/.test(s.status), "refusal");
    assert.deepEqual(done.mock.log, []);
    assert.equal(done.mock.remaining, 60);
    return page;
  },

  async "an unreadable selection count fails closed"() {
    const page = await openPhotos("/?nocount=1");
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "d", 2);
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /couldn't read/.test(s.pill), "hand-back");
    assert.ok(!done.mock.log.includes("confirm"));
    assert.equal(done.mock.remaining, 60);
    return page;
  },

  async "Sweep refuses to trash from the Trash page"() {
    const page = await openPhotos("/trash");
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "d");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /This is Google Photos Trash/.test(s.status), "refusal");
    assert.deepEqual(done.mock.log, []);
    return page;
  },

  async "a big bin is trashed in verified batches of 100"() {
    const page = await openPhotos("/?n=250");
    // 230 marked straight into storage: pressing D that often would take minutes.
    await (await extensionWorker()).evaluate(async (ids) => {
      const decisions = Object.fromEntries(ids.map((id, at) => [id, { d: "bin", at }]));
      await chrome.storage.local.set({ sweepDecisions: decisions });
    }, Array.from({ length: 230 }, (_, n) => id(n + 10)));
    await toggleSweep(page);
    await until(page, (s) => /Bin \(230\)/.test(s.bin), "bin loaded");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /Moved 230/.test(s.status), "all batches", 120000);
    assert.equal(done.mock.remaining, 20);
    assert.deepEqual(done.mock.log.filter((line) => line.startsWith("trashed:")), ["trashed:100", "trashed:100", "trashed:30"]);
    assert.ok(done.bin.includes("0"));
    return page;
  },

  async "photos marked in another view are trashed one by one from their own pages"() {
    const page = await openPhotos("/?n=20", { alreadyTrashed: [id(31)] });
    const other = (n) => ({ d: "bin", at: n, from: "/album/OTHER", href: `https://photos.google.com/album/OTHER/photo/${id(n)}` });
    await (await extensionWorker()).evaluate(async (decisions) => chrome.storage.local.set({ sweepDecisions: decisions }), {
      [id(3)]: { d: "bin", at: 1, from: "/" },
      [id(25)]: other(2),
      [id(26)]: other(3),
      [id(31)]: other(4),
      AF1QipMockZZ: { d: "bin", at: 5, from: "/album/OTHER" },
    });
    await toggleSweep(page);
    await until(page, (s) => /Bin \(5\)/.test(s.bin), "bin loaded");
    await press(page, "b");
    const basket = await until(page, (s) => /4 were marked in another view/.test(s.elsewhere), "other-view note");
    assert.match(basket.elsewhere, /an album \(4\)/);
    await click(page, '[data-action="trash"]');
    const worker = await extensionWorker();
    const helperSeen = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        const tabs = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://photos.google.com/*photo/*" })).map((t) => ({ active: t.active, groupId: t.groupId })));
        if (tabs.length) return tabs[0];
        await sleep(100);
      }
      return null;
    })();
    assert.ok(helperSeen, "a helper tab was opened");
    assert.equal(helperSeen.active, false, "the helper tab stays in the background");
    assert.ok(helperSeen.groupId >= 0, "the helper tab is tucked into a tab group");
    const done = await until(page, (s) => /Moved 3 to Google Photos Trash/.test(s.status), "one-by-one outcome", 90000);
    assert.match(done.status, /1 were already in Trash/);
    assert.match(done.status, /1 couldn't be found/);
    assert.deepEqual(trashLog, ["grid:1", "photo:1", "photo:1"]);
    assert.ok(!trashLog.includes("PERMANENT"));
    assert.ok(done.bin.includes("1"), "only the missing one stays marked");
    const leftover = await worker.evaluate(async () => ({
      popups: (await chrome.windows.getAll({ windowTypes: ["popup"] })).length,
      photoTabs: (await chrome.tabs.query({ url: "https://photos.google.com/*photo/*" })).length,
    }));
    assert.deepEqual(leftover, { popups: 0, photoTabs: 0 }, "no window popped up and the helper tab is closed afterwards");
    return page;
  },

  async "the search stops once the timeline is older than every marked photo"() {
    const page = await openPhotos("/?n=300");
    await (await extensionWorker()).evaluate(async (decisions) => chrome.storage.local.set({ sweepDecisions: decisions }), {
      [id(20)]: { d: "bin", at: 1, from: "/", ts: fixtureTs.get(id(20)) },
      // Marked here but no longer in the grid (e.g. deleted elsewhere); it was dated like item 30.
      AF1QipMockZZ: { d: "bin", at: 2, from: "/", ts: fixtureTs.get(id(30)) },
    });
    await toggleSweep(page);
    await until(page, (s) => /Bin \(2\)/.test(s.bin), "bin loaded");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /Moved 1 to Google Photos Trash/.test(s.status), "outcome", 60000);
    assert.match(done.status, /1 couldn't be found/);
    assert.ok(page.logs.some((line) => /select stopped: past/.test(line)), `stopped at the date bound: ${page.logs.join("\n")}`);
    return page;
  },

  async "Stop searching hands the rest to one by one"() {
    const page = await openPhotos("/?n=300");
    // Old-style marks: no view or date recorded, and not in this grid.
    const marks = Object.fromEntries([0, 1, 2].map((n) => [`AF1QipMockX${n}`, { d: "bin", at: n }]));
    await (await extensionWorker()).evaluate(async (decisions) => chrome.storage.local.set({ sweepDecisions: decisions }), marks);
    await toggleSweep(page);
    await until(page, (s) => /Bin \(3\)/.test(s.bin), "bin loaded");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    await until(page, (s) => /checked \d+/.test(s.status), "search progress");
    await click(page, '[data-action="stopTrash"]');
    const done = await until(page, (s) => /You stopped the search/.test(s.status), "stopped", 60000);
    assert.match(done.status, /3 couldn't be found/);
    return page;
  },

  async "a photo that doesn't react in the background tab is retried in a window"() {
    const page = await openPhotos("/?n=20");
    await (await extensionWorker()).evaluate(async (decisions) => chrome.storage.local.set({ sweepDecisions: decisions }), {
      [id(25)]: { d: "bin", at: 1, from: "/album/OTHER", href: `https://photos.google.com/photo/${id(25)}?flaky=1` },
    });
    await toggleSweep(page);
    await until(page, (s) => /Bin \(1\)/.test(s.bin), "bin loaded");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /Moved 1 to Google Photos Trash/.test(s.status), "outcome after retry", 90000);
    assert.deepEqual(trashLog, ["photo:1"]);
    assert.equal(photoLoads.get(id(25)), 2, "tried once in the tab, once in the window");
    assert.ok(done.bin.includes("0"));
    const popups = await (await extensionWorker()).evaluate(async () => (await chrome.windows.getAll({ windowTypes: ["popup"] })).length);
    assert.equal(popups, 0, "the fallback window is closed afterwards");
    return page;
  },

  async "one by one stops at an unexpected dialog and leaves it for the user"() {
    const page = await openPhotos("/?n=20");
    await (await extensionWorker()).evaluate(async (decisions) => chrome.storage.local.set({ sweepDecisions: decisions }), {
      [id(25)]: { d: "bin", at: 1, from: "/album/OTHER", href: `https://photos.google.com/photo/${id(25)}?confirm=permanent` },
      [id(26)]: { d: "bin", at: 2, from: "/album/OTHER" },
    });
    await toggleSweep(page);
    await until(page, (s) => /Bin \(2\)/.test(s.bin), "bin loaded");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /answer it yourself/.test(s.status), "hand-over", 60000);
    assert.deepEqual(trashLog, []);
    assert.ok(done.bin.includes("2"));
    const worker = await extensionWorker();
    const helpers = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://photos.google.com/*photo/*" })).map((t) => ({ id: t.id, active: t.active })));
    assert.equal(helpers.length, 1, "the helper tab stays open with Google's question");
    assert.equal(helpers[0].active, true, "and is brought to the front");
    await worker.evaluate(async (tabId) => chrome.tabs.remove(tabId), helpers[0].id);
    return page;
  },

  async "a Delete permanently dialog is left for the user"() {
    const page = await openPhotos("/?confirm=permanent");
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "d");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    await until(page, (s) => /unexpected/i.test(s.pill), "hand-over message");
    await sleep(1500);
    let state = await ui(page);
    assert.ok(state.dialog?.includes("Delete permanently"), "dialog is still waiting for the user");
    assert.ok(!state.mock.log.includes("PERMANENT"));
    await page.click("#cancel");
    state = await until(page, (s) => /cancelled/i.test(s.status), "cancel is reported", 20000);
    assert.equal(state.mock.remaining, 60);
    assert.ok(state.bin.includes("1"), "the item stays marked");
    return page;
  },

  async "duplicate finder groups near-identical images"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "f");
    const first = await until(page, (s) => /Duplicate group 1 of/.test(s.heading), "first duplicate group", 40000);
    const members = await page.evaluate(() => [...document.querySelector("sweep-photos").shadowRoot.querySelectorAll("[data-action=dupeToggle]")].map((el) => el.dataset.id));
    assert.match(first.heading, /of 2/, `expected two groups, got "${first.heading}" starting with ${members}`);
    assert.deepEqual(members.sort(), [id(3), id(4)]);
    await press(page, "Enter");
    const second = await until(page, (s) => /Duplicate group 2 of 2/.test(s.heading), "second group");
    const next = await page.evaluate(() => [...document.querySelector("sweep-photos").shadowRoot.querySelectorAll("[data-action=dupeToggle]")].map((el) => el.dataset.id));
    assert.deepEqual(next.sort(), [id(20), id(21), id(22)]);
    assert.ok(second.bin.includes("1"), "applying group 1 binned the copy");
    return page;
  },

  async "date range limits the deck"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "r");
    await page.evaluate(() => {
      const inputs = document.querySelector("sweep-photos").shadowRoot.querySelectorAll("input[type=date]");
      inputs[0].value = "2026-08-01";
      inputs[1].value = "2026-09-01";
    });
    await click(page, '[data-action="applyRange"]');
    await until(page, (s) => s.top === id(1), "first in-range card");
    await press(page, "k", 4);
    const end = await until(page, (s) => /Nothing left in/.test(s.heading), "range exhausted");
    assert.match(end.counts, /^4 reviewed/);
    return page;
  },

  async "archive and Locked Folder buttons, carried out from the library's ⋮ menu"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "ArrowUp");
    await until(page, (s) => s.top === id(1), "↑ archives");
    await click(page, '.controls [data-action="lock"]');
    await until(page, (s) => s.top === id(2), "🔒 marks for the Locked Folder");
    await press(page, "a");
    await press(page, "l");
    await press(page, "d");
    await press(page, "z");
    await press(page, "k");
    await until(page, (s) => s.top === id(5) && /Marked \(4\)/.test(s.bin), "four marked, undo took back the bin");
    await press(page, "b");
    const basket = await until(page, (s) => /Marked for archive · 2/.test(s.heading), "basket opens on the archive list");
    assert.match(basket.heading, /Marked for archive/);
    await click(page, '[data-action="trash"]');
    const archivedDone = await until(page, (s) => /Archived 2\./.test(s.status), "archive outcome");
    assert.ok(archivedDone.mock.log.includes("menu-archive"), archivedDone.mock.log.join());
    assert.ok(!archivedDone.mock.log.includes("toolbar-trash") && !archivedDone.mock.log.includes("confirm"), "nothing was trashed");
    await click(page, '[data-action="basketKind"][data-kind="lock"]');
    await until(page, (s) => /Locked Folder · 2/.test(s.heading), "lock list");
    await click(page, '[data-action="trash"]');
    const lockedDone = await until(page, (s) => /Moved 2 to the Locked Folder\./.test(s.status), "lock outcome");
    assert.ok(lockedDone.mock.log.includes("lock-confirm"));
    assert.deepEqual(trashLog, ["archive-grid:2", "lock-grid:2"]);
    assert.equal(lockedDone.mock.remaining, 56);
    assert.match(lockedDone.bin, /Bin \(0\)/);
    await press(page, "?");
    const help = await until(page, (s) => /2 archived/.test(s.help || ""), "totals in help");
    assert.match(help.help, /2 in the Locked Folder/);
    return page;
  },

  async "archiving in an album keeps the photos there and still verifies"() {
    const page = await openPhotos("/album/MOCK");
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "a", 2);
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const done = await until(page, (s) => /Archived 2\./.test(s.status), "archive outcome");
    assert.ok(!done.mock.log.includes("REMOVED-FROM-ALBUM"));
    assert.ok(done.mock.log.includes("menu-archive"), done.mock.log.join());
    assert.equal(done.mock.remaining, 60, "archived photos stay in the album");
    return page;
  },

  async "Google's verify-it's-you step for the Locked Folder is left for the user"() {
    const page = await openPhotos("/?verify=1");
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "l");
    await press(page, "b");
    await click(page, '[data-action="trash"]');
    const asked = await until(page, (s) => /unexpected/i.test(s.pill), "hand-over", 20000);
    assert.match(asked.dialog, /Verify it's you/);
    assert.ok(!asked.mock.log.includes("VERIFY-PRESSED"), "Sweep never answers it");
    await page.click("#cancel");
    const done = await until(page, (s) => /Locked Folder move cancelled/.test(s.status), "cancelled", 30000);
    assert.deepEqual(trashLog, []);
    assert.match(done.bin, /Marked \(1\)/, "still marked");
    return page;
  },

  async "archive and Locked Folder one by one for photos marked in another view"() {
    const page = await openPhotos("/?n=20", { alreadyArchived: [id(27)] });
    const other = (d, n) => ({ d, at: n, from: "/album/OTHER", href: `https://photos.google.com/album/OTHER/photo/${id(n)}` });
    await (await extensionWorker()).evaluate(async (decisions) => chrome.storage.local.set({ sweepDecisions: decisions }), {
      [id(25)]: other("archive", 25),
      [id(27)]: other("archive", 27),
      [id(26)]: other("lock", 26),
    });
    await toggleSweep(page);
    await press(page, "b");
    await until(page, (s) => /Marked for archive · 2/.test(s.heading), "archive list");
    await click(page, '[data-action="trash"]');
    const archivedDone = await until(page, (s) => /Archived 1\./.test(s.status), "archive one by one", 60000);
    assert.match(archivedDone.status, /1 were already archived/);
    await click(page, '[data-action="basketKind"][data-kind="lock"]');
    await click(page, '[data-action="trash"]');
    await until(page, (s) => /Moved 1 to the Locked Folder\./.test(s.status), "lock one by one", 60000);
    assert.deepEqual(trashLog, ["archive-photo:1", "lock-photo:1"]);
    return page;
  },

  async "the popup picks a month, opens Google's search for it and starts sweeping"() {
    const page = await openPhotos("/?n=300");
    const popup = await openPopup(page);
    const target = new Date(fixtureTs.get(id(150)));
    const month = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    await popup.$eval("#month", (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, month);
    const monthName = target.toLocaleString("en-GB", { month: "long" });
    assert.match(await popupPlan(popup), new RegExp(`search “${monthName} ${target.getFullYear()}”`));
    await popup.click('#media [data-media="photos"]');
    await popup.click("#go");
    const state = await sweepOpenOn(page, (s) => s.open && s.top, "Sweep open on the search page");
    assert.deepEqual(searches, [`${monthName} ${target.getFullYear()}`]);
    assert.match(page.url(), /\/search\//);
    const inMonth = [...fixtureTs].filter(([, ts]) => new Date(ts).getMonth() === target.getMonth() && new Date(ts).getFullYear() === target.getFullYear()).map(([key]) => key);
    assert.ok(inMonth.includes(state.top), `first card ${state.top} is in the month`);
    assert.match(state.status, new RegExp(`Showing .*${target.getFullYear()}.*Photos only`));
    const saved = await (await extensionWorker()).evaluate(() => chrome.storage.local.get(["sweepRange", "sweepMedia"]));
    assert.equal(saved.sweepMedia, "photos");
    assert.equal(saved.sweepRange.from.slice(0, 7), month);
    assert.deepEqual(popup.problems, []);
    await popup.close();
    return page;
  },

  async "a range across years uses the timeline, and an empty search falls back to it"() {
    const page = await openPhotos("/?n=300");
    let popup = await openPopup(page);
    await popup.$eval("#from", (input) => { input.value = "1999-12-01"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await popup.$eval("#to", (input) => { input.value = "1999-12-31"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.match(await popupPlan(popup), /search “December 1999”/);
    await popup.click("#go");
    const state = await sweepOpenOn(page, (s) => s.open && /found nothing/.test(s.status), "fallback note");
    assert.deepEqual(searches, ["December 1999"]);
    assert.equal(new URL(page.url()).pathname, "/", "back on the timeline");
    assert.match(state.status, /looking through your timeline/);
    await popup.close();

    // Like clicking the toolbar icon again: a fresh popup, remembering the last dates.
    popup = await openPopup(page);
    assert.equal(await popup.$eval("#from", (input) => input.value), "1999-12-01");
    await popup.$eval("#from", (input) => { input.value = "2025-12-01"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await popup.$eval("#to", (input) => { input.value = "2026-01-31"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.match(await popupPlan(popup), /timeline and jumps/);
    await popup.click("#go");
    await sweepOpenOn(page, (s) => s.open && s.top && /Showing 1 Dec 2025/.test(s.status), "timeline sweep");
    assert.deepEqual(searches, ["December 1999"], "no search for a range across years");
    await popup.close();
    return page;
  },

  async "Sweep the page I'm on keeps the album and applies the dates"() {
    const page = await openPhotos("/album/MOCK");
    const popup = await openPopup(page);
    await popup.click('#presets [data-preset="all"]');
    await popup.click('#media [data-media="videos"]');
    await popup.click("#here");
    const state = await sweepOpenOn(page, (s) => s.open && s.top === id(6), "videos in the album");
    assert.match(page.url(), /\/album\/MOCK/);
    assert.match(state.status, /Videos only/);
    await popup.close();
    return page;
  },

  async "Sweep the page I'm on explains an empty page instead of doing nothing"() {
    const page = await openPhotos("/search/Nothing%20here", { empty: true });
    const popup = await openPopup(page);
    await popup.click("#here");
    const state = await sweepOpenOn(page, (s) => s.open && /no photos on this page/.test(s.status), "empty-page note", 20000);
    assert.equal(state.top, null);
    assert.deepEqual(page.problems, []);
    await popup.close();
    return page;
  },

  async "an old date range is reached by jumping, not by scrolling through everything"() {
    return oldRangeJump("/?n=300");
  },

  async "the jump isn't fooled by off-screen or lingering tiles"() {
    return oldRangeJump("/?n=300&lag=1", 120, 122);
  },

  async "first-run help, ? key and settings"() {
    const page = await openPhotos("/", { firstRun: true });
    await toggleSweep(page);
    await until(page, (s) => s.help && s.top === id(0), "help shown on first run");
    await press(page, "ArrowRight");
    await until(page, (s) => !s.help && s.top === id(1), "a swipe key closes help and still keeps");
    await press(page, "?");
    await until(page, (s) => s.help, "? reopens help");
    await press(page, "Escape");
    await until(page, (s) => !s.help && s.open, "help closes with Esc, overlay stays");
    await press(page, "ArrowLeft");
    await until(page, (s) => s.top === id(2) && s.bin.includes("1"), "arrow left bins");
    await press(page, "k");
    await press(page, "?");
    await until(page, (s) => /2 kept · 1 in the bin/.test(s.help || ""), "totals in help");
    await click(page, '[data-action="forgetKept"]');
    await until(page, (s) => !s.help && s.top === id(0) && /2 kept photos will come back/.test(s.status), "kept photos come back");
    return page;
  },

  async "two-finger trackpad swipe flings the card"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await page.mouse.move(640, 450);
    // A trackpad sends its events in one quick burst; awaiting each round trip can leave
    // gaps longer than the gesture's idle timeout on a slow machine.
    const swipe = (deltaX) => Promise.all(Array.from({ length: 12 }, () => page.mouse.wheel({ deltaX })));
    await swipe(40);
    await until(page, (s) => s.top === id(1) && s.bin.includes("1"), "swipe left bins");
    await sleep(600);
    await swipe(-40);
    await until(page, (s) => s.top === id(2) && s.bin.includes("1"), "swipe right keeps");
    await sleep(600);
    // A small nudge springs back.
    await page.mouse.wheel({ deltaX: 30 });
    await sleep(500);
    const state = await ui(page);
    assert.equal(state.top, id(2));
    return page;
  },

  async "toolbar badge counts the bin"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "d", 3);
    const badge = async () => (await extensionWorker()).evaluate(() => chrome.action.getBadgeText({}));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await badge() !== "3") await sleep(150);
    assert.equal(await badge(), "3");
    return page;
  },

  async "videos only, and playback on the card"() {
    const page = await openPhotos();
    await toggleSweep(page);
    await until(page, (s) => s.top === id(0), "first card");
    await press(page, "v");
    await until(page, (s) => s.top === id(6), "first video");
    if (!mp4) {
      console.log("    (ffmpeg not found: skipping playback)");
      return page;
    }
    // Buffering starts as soon as the card is shown, before play is pressed.
    const buffered = await until(page, (s) => s.video?.ready >= 3 && s.video.hidden, "video buffered before play");
    assert.equal(buffered.video.paused, true, "not playing yet");
    const pressed = Date.now();
    await press(page, "Space");
    const playing = await until(page, (s) => s.video && !s.video.hidden && s.video.time > 0.2, "video playback");
    assert.match(playing.video.src, /=m18$/, "falls back to the rendition that exists");
    assert.ok(Date.now() - pressed < 2500, "starts straight away");
    await press(page, "k");
    await until(page, (s) => s.top === id(13), "next video after keep");
    const next = await until(page, (s) => s.video?.ready >= 1, "next video buffering");
    assert.match(next.video.src, /=m18$/, "the next video asks for the rendition that worked first");
    const first = videoRequests.filter((r) => r.startsWith(`${id(6)}=`));
    assert.ok(first.includes(`${id(6)}=m22`), `the first video tried 720p first: ${first}`);
    const later = videoRequests.filter((r) => r.startsWith(`${id(13)}=`));
    assert.deepEqual([...new Set(later)], [`${id(13)}=m18`], "no wasted requests for the next video");
    return page;
  },
};

// --- run --------------------------------------------------------------------------------

const only = process.argv.slice(2).join(" ").toLowerCase();
let failed = 0;
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !name.toLowerCase().includes(only)) continue;
    const started = Date.now();
    let page;
    try {
      page = await run();
      assert.deepEqual(page.problems, [], "no page errors (including Trusted Types violations)");
      console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${name}\n${String(error.stack || error).replace(/^/gm, "      ")}`);
    } finally {
      await page?.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
  server.close();
  proxy.close();
  fs.rmSync(work, { recursive: true, force: true });
}
if (failed) {
  console.log(`${failed} e2e scenario(s) failed`);
  process.exit(1);
}
console.log("sweep-photos e2e passed");
