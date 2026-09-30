import { sizedImageUrl, videoUrls } from "./photos-dom.js";

/** How far the card must travel, as a fraction of its width, to commit. Same as Sweep. */
const COMMIT_FRACTION = 0.26;
const MAX_TILT_DEGREES = 11;
const FLING_VELOCITY = 0.6; // px per ms
const STACK_DEPTH = 3;
const PREFETCH_AHEAD = 6;
/** A trackpad swipe ends once wheel events pause this long (ms). */
const WHEEL_IDLE = 140;
/** Momentum events after a committed trackpad swipe are ignored for this long (ms). */
const WHEEL_COOLDOWN = 450;

const SHORTCUTS = [
  ["← or D", "Bin"],
  ["→ or K", "Keep"],
  ["↑ or A", "Archive"],
  ["↓ or L", "Locked Folder"],
  ["Z or Backspace", "Undo"],
  ["Space or P", "Play / pause a video"],
  ["Enter", "Open in Google Photos"],
  ["V", "Photos, videos or both"],
  ["R", "Date range"],
  ["F", "Find duplicates"],
  ["B", "Review the bin"],
  ["?", "This help"],
  ["Esc", "Close"],
];

/** Where each decision flings the card, and the stamp it shows on the way. */
const FLINGS = {
  keep: { x: 1, y: 0, stamp: "--keep" },
  bin: { x: -1, y: 0, stamp: "--bin" },
  archive: { x: 0, y: -1, stamp: "--archiving" },
  lock: { x: 0, y: 1, stamp: "--locking" },
};

/** What each marked list is called, and what its action button does. */
const KINDS = {
  bin: { tab: "🗑 Bin", title: "Marked for bin", button: (n) => `Move ${n} to Google Photos Trash`, style: "danger", verb: "trashes",
    note: "No second prompt: Sweep selects them in Google Photos and confirms Google's \"Move to trash\" for you. They stay recoverable in Google Photos Trash for 60 days, and are removed from your synced devices and shared albums." },
  archive: { tab: "🗄 Archive", title: "Marked for archive", button: (n) => `Archive ${n}`, style: "archive", verb: "archives",
    note: "Sweep selects them and uses Google's ⋮ → Archive. Archived photos leave your Photos timeline but stay in albums, search and the Archive page, where you can unarchive them." },
  lock: { tab: "🔒 Locked", title: "Marked for the Locked Folder", button: (n) => `Move ${n} to Locked Folder`, style: "lock", verb: "moves",
    note: "Sweep selects them and uses Google's ⋮ → Move to Locked Folder, pressing only Google's \"Move\". Locked items leave your library, albums and shared albums; Google may ask you to verify it's you, which you answer yourself." },
};

/** Positions a card mid-swipe and fades in the KEEP/BIN stamp. */
function pose(card, dx, dy = 0) {
  const progress = Math.max(-1, Math.min(1, dx / (card.offsetWidth * COMMIT_FRACTION)));
  card.style.transform = dx || dy ? `translate(${dx}px, ${dy}px) rotate(${progress * MAX_TILT_DEGREES}deg)` : "";
  card.style.setProperty("--keep", Math.max(0, progress));
  card.style.setProperty("--bin", Math.max(0, -progress));
}

// Google Photos enforces Trusted Types, so innerHTML is off-limits: build nodes directly.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "style") Object.assign(element.style, value);
    else if (key === "data") Object.assign(element.dataset, value);
    else if (key in element && typeof value !== "string") element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

/** Human name for a viewKey: "/" -> "Photos", "/album/x" -> "an album", "/search/cats" -> "search “cats”". */
export function viewName(key) {
  const [, kind, rest] = String(key || "/").match(/^\/(?:u\/\d+\/)?([^/]*)\/?(.*)$/) || [];
  if (!kind) return "Photos";
  if (kind === "album" || kind === "share") return "an album";
  if (kind === "search") return `search “${decodeURIComponent(rest || "")}”`;
  if (kind === "favorites") return "Favourites";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function cardImage(thumb) {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  return sizedImageUrl(thumb, Math.min(innerWidth * scale, 2400), Math.min(innerHeight * scale, 2400));
}

export class SweepOverlay {
  /** @param {{keep, bin, undo, close, openBasket, closeBasket, unmark, trash}} actions */
  constructor(actions) {
    this.actions = actions;
    this.open = false;
    this.flinging = false;
    this.view = null;
    this.helpOpen = false;
    this.wheel = { dx: 0, last: -Infinity, timer: 0, lockedUntil: 0 };

    this.host = h("sweep-photos");
    Object.assign(this.host.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" });
    const root = this.host.attachShadow({ mode: "open" });

    this.backdrop = h("div", { class: "backdrop" });
    this.counts = h("span", { class: "counts" });
    this.basketChip = h("button", { class: "chip basket-chip", type: "button", data: { action: "basket" } });
    this.dupesChip = h("button", { class: "chip", type: "button", title: "Find duplicates (F)", data: { action: "findDupes" } }, "Duplicates");
    this.rangeChip = h("button", { class: "chip", type: "button", title: "Date range (R)", data: { action: "openRange" } });
    this.mediaChip = h("button", { class: "chip", type: "button", title: "Photos, videos or both (V)", data: { action: "cycleMedia" } });
    this.stage = h("main", { class: "stage" });
    this.controls = h("footer", { class: "controls" });
    this.status = h("p", { class: "status", "aria-live": "polite" });
    this.app = h("div", { class: "app", hidden: true },
      this.backdrop,
      h("header", { class: "bar" },
        h("div", { class: "brand" }, h("strong", {}, "Sweep"), this.counts),
        h("div", { class: "bar-actions" },
          this.mediaChip,
          this.rangeChip,
          this.dupesChip,
          this.basketChip,
          h("button", { class: "icon", type: "button", title: "Help & settings (?)", "aria-label": "Help", data: { action: "help" } }, "?"),
          h("button", { class: "icon", type: "button", title: "Close (Esc)", "aria-label": "Close", data: { action: "close" } }, "✕"))),
      this.stage,
      this.controls,
      this.status,
      this.helpEl = h("aside", { class: "help", hidden: true, role: "dialog", "aria-label": "Sweep help" }));
    this.pillEl = h("div", { class: "pill", hidden: true });

    root.append(h("link", { rel: "stylesheet", href: chrome.runtime.getURL("src/overlay.css") }), this.app, this.pillEl);
    root.addEventListener("click", (event) => this.#onClick(event));
    this.app.addEventListener("wheel", (event) => this.#onWheel(event), { passive: false });
    this.onKey = (event) => this.#onKey(event);
    document.documentElement.append(this.host);
  }

  show() {
    this.open = true;
    this.app.hidden = false;
    window.addEventListener("keydown", this.onKey, true);
  }

  hide() {
    this.open = false;
    this.app.hidden = true;
    window.removeEventListener("keydown", this.onKey, true);
  }

  pill(text) {
    this.pillEl.hidden = !text;
    this.pillEl.textContent = text || "";
  }

  render(view) {
    this.view = view;
    const { stats } = view;
    this.counts.textContent = `${stats.reviewed} reviewed · ${stats.remaining} to go${view.loading ? " · loading…" : ""}`;
    const marked = view.marked || { bin: view.basket.length };
    const others = (marked.archive || 0) + (marked.lock || 0);
    this.basketChip.textContent = others ? `Marked (${(marked.bin || 0) + others})` : `Bin (${marked.bin || 0})`;
    this.basketChip.disabled = view.busy;
    this.dupesChip.disabled = view.busy;
    this.dupesChip.hidden = view.mode !== "deck";
    this.rangeChip.textContent = `📅 ${view.rangeLabel}`;
    this.rangeChip.classList.toggle("on", view.rangeLabel !== "All dates");
    this.rangeChip.disabled = view.busy;
    this.rangeChip.hidden = view.mode !== "deck";
    this.mediaChip.textContent = view.media === "videos" ? "🎬 Videos only" : view.media === "photos" ? "🖼 Photos only" : "🖼🎬 All";
    this.mediaChip.classList.toggle("on", view.media !== "all");
    this.mediaChip.disabled = view.busy;
    this.mediaChip.hidden = view.mode !== "deck";
    this.status.textContent = view.status || "";
    this.status.hidden = !view.status;
    if (this.helpOpen) this.#renderHelp(view);

    if (view.mode === "basket") this.#renderBasket(view);
    else if (view.mode === "dupes") this.#renderDupes(view);
    else if (view.mode === "range") this.#renderRange(view);
    else this.#renderDeck(view);
  }

  // --- date range -------------------------------------------------------------------

  #renderRange(view) {
    this.backdrop.style.backgroundImage = "none";
    const from = h("input", { type: "date", value: view.range.from || "", max: view.range.to || undefined });
    const to = h("input", { type: "date", value: view.range.to || "", min: view.range.from || undefined });
    from.addEventListener("change", () => { to.min = from.value; });
    to.addEventListener("change", () => { from.max = to.value; });
    const apply = () => this.actions.setRange({ from: from.value || null, to: to.value || null });
    this.applyRange = apply;

    const preset = (name, label) => h("button", { class: "chip", type: "button", data: { action: "setRange", preset: name } }, label);
    this.stage.replaceChildren(h("section", { class: "range" },
      h("h2", {}, "Date range"),
      h("p", {}, "Sweep and Duplicates only show photos taken in this range. Leave a side empty for no limit."),
      h("div", { class: "row presets" },
        preset("30d", "Last 30 days"),
        preset("90d", "Last 90 days"),
        preset("thisYear", "This year"),
        preset("lastYear", "Last year"),
        preset("all", "All dates")),
      h("div", { class: "range-fields" },
        h("label", {}, h("span", {}, "From"), from),
        h("label", {}, h("span", {}, "To"), to)),
      h("div", { class: "row" },
        h("button", { class: "chip", type: "button", data: { action: "closeRange" } }, "Cancel"),
        h("button", { class: "primary", type: "button", data: { action: "applyRange" } }, "Apply")),
      h("p", { class: "hint" }, "On the main Photos timeline, Sweep jumps over newer photos and stops once it passes the start date. Older ranges take a little longer to reach.")));
    this.controls.replaceChildren();
    this.controls.hidden = true;
  }

  // --- duplicates -------------------------------------------------------------------

  #renderDupes(view) {
    const dupes = view.dupes;
    this.backdrop.style.backgroundImage = "none";
    const back = h("button", { class: "chip", type: "button", data: { action: "exitDupes" } }, "← Back to deck");

    if (dupes.phase === "scanning" || dupes.phase === "hashing") {
      this.stage.replaceChildren(h("div", { class: "empty" },
        h("div", { class: "spinner" }),
        h("p", {}, dupes.text),
        h("p", { class: "hint" }, "Sweep scrolls through this view and fingerprints each thumbnail. Fingerprints are cached, so later scans are quicker."),
        back));
      this.controls.hidden = true;
      return;
    }

    const looseToggle = h("button", {
      class: `chip ${dupes.loose ? "on" : ""}`,
      type: "button",
      title: "Similar also matches burst shots and near-identical photos; off matches only exact re-uploads",
      data: { action: "dupeLoose" },
    }, dupes.loose ? "Similar: on" : "Similar: off");

    if (dupes.phase === "done") {
      const marked = view.basket.length;
      this.stage.replaceChildren(h("div", { class: "empty" },
        h("h2", {}, `${dupes.count ? "All duplicate groups reviewed" : "No duplicates found"}${view.rangeLabel !== "All dates" ? ` · ${view.rangeLabel}` : ""}`),
        h("p", {}, marked
          ? `${marked} marked for bin. Nothing is deleted until you confirm from the bin.`
          : "Try turning Similar on, widening the date range, or opening another album or search."),
        h("div", { class: "row" },
          back,
          looseToggle,
          dupes.canBack ? h("button", { class: "chip", type: "button", data: { action: "dupeBack" } }, "↺ Previous group") : null,
          marked ? h("button", { class: "primary", type: "button", data: { action: "basket" } }, `Review bin (${marked})`) : null)));
      this.controls.hidden = true;
      return;
    }

    const binning = dupes.group.filter((item) => item.choice === "bin").length;
    const tiles = dupes.group.map((item, i) => h("button", {
      class: `dupe ${item.choice}`,
      type: "button",
      title: item.choice === "keep" ? "Click to bin" : "Click to keep",
      data: { action: "dupeToggle", id: item.id },
    },
    h("img", { src: sizedImageUrl(item.thumb, 900, 900), alt: item.label || "", draggable: "false" }),
    h("span", { class: "dupe-key" }, String(i + 1)),
    h("span", { class: "dupe-state" }, item.choice === "keep" ? "KEEP" : "BIN"),
    h("span", { class: "dupe-meta" },
      item.kind === "video" ? "▶ " : "",
      item.date || item.label || "",
      h("a", { href: item.href, target: "_blank", rel: "noopener" }, "Open ↗"))));

    this.stage.replaceChildren(h("section", { class: "dupes" },
      h("div", { class: "basket-head" },
        h("div", {},
          h("h2", {}, `Duplicate group ${dupes.index + 1} of ${dupes.count}${view.rangeLabel !== "All dates" ? ` · ${view.rangeLabel}` : ""}`),
          h("p", {}, `${dupes.group.length} look alike. Click a photo (or press its number) to switch keep/bin.`)),
        h("div", { class: "row" }, looseToggle, back)),
      h("div", { class: `dupe-grid n${Math.min(dupes.group.length, 4)}` }, tiles)));

    this.controls.replaceChildren(
      h("button", { class: "round small", type: "button", title: "Previous group (Z)", "aria-label": "Previous group", disabled: !dupes.canBack, data: { action: "dupeBack" } }, "↺"),
      h("button", { class: "chip", type: "button", title: "Skip (S) — ask again next scan", data: { action: "dupeSkip" } }, "Skip"),
      h("button", { class: "chip", type: "button", title: "Keep all (A) — not duplicates", data: { action: "dupeKeepAll" } }, "Keep all"),
      h("button", { class: `primary ${binning ? "danger" : ""}`, type: "button", title: "Apply (Enter)", data: { action: "dupeApply" } },
        binning ? `Bin ${binning}, keep ${dupes.group.length - binning}` : "Keep all"));
    this.controls.hidden = false;
  }

  // --- deck ---------------------------------------------------------------------

  #renderDeck(view) {
    const cards = view.cards.slice(0, STACK_DEPTH);
    const top = cards[0];
    this.backdrop.style.backgroundImage = top ? `url("${sizedImageUrl(top.thumb, 64, 64)}")` : "none";

    if (!top) {
      const binCount = Object.values(view.marked || { bin: view.basket.length }).reduce((sum, n) => sum + n, 0);
      const ranged = view.rangeLabel !== "All dates";
      this.stage.replaceChildren(view.loading
        ? h("div", { class: "empty" }, h("div", { class: "spinner" }), h("p", {}, view.loadingText))
        : h("div", { class: "empty" },
          h("h2", {}, ranged ? `Nothing left in ${view.rangeLabel}` : "Nothing left to review"),
          h("p", {}, binCount
            ? "Open the bin to send what you marked to Google Photos Trash, Archive or the Locked Folder."
            : ranged
              ? "Try a different date range, or open an album or search in Google Photos."
              : "Scroll somewhere else in Google Photos, or open an album, and start again."),
          h("div", { class: "row" },
            ranged ? h("button", { class: "chip", type: "button", data: { action: "openRange" } }, "Change dates") : null,
            binCount ? h("button", { class: "primary", type: "button", data: { action: "basket" } }, `Review bin (${binCount})`) : null)));
    } else {
      // A background top-up must not rebuild the card the user is dragging or flinging.
      const shown = this.stage.querySelector(".card.top");
      if (shown && shown.dataset.id === top.id) {
        // Same card on top: keep it (it may be mid-drag or playing a video) and only refresh the stack behind.
        const behind = cards.slice(1).map((item) => item.id).join(",");
        const current = [...this.stage.querySelectorAll(".card.under")].reverse().map((card) => card.dataset.id).join(",");
        if (behind !== current) {
          this.stage.querySelectorAll(".card.under").forEach((card) => card.remove());
          shown.before(...cards.slice(1).map((item, index) => this.#card(item, index + 1)).reverse());
        }
      } else {
        // Back-to-front so the current card is painted on top.
        this.stage.replaceChildren(...cards.map((item, depth) => this.#card(item, depth)).reverse());
        const card = this.stage.querySelector(".card.top");
        this.#bindDrag(card);
        if (top.kind === "video") this.#prepareVideo(card, top);
      }
    }

    this.controls.replaceChildren(
      h("button", { class: "round bin", type: "button", title: "Bin (←)", "aria-label": "Bin", disabled: !top, data: { action: "bin" } }, "✕"),
      h("button", { class: "round small archive", type: "button", title: "Archive (↑ or A)", "aria-label": "Archive", disabled: !top, data: { action: "archive" } }, "🗄"),
      h("button", { class: "round small", type: "button", title: "Undo (Z)", "aria-label": "Undo", disabled: !view.canUndo, data: { action: "undo" } }, "↺"),
      h("button", { class: "round small lock", type: "button", title: "Locked Folder (↓ or L)", "aria-label": "Locked Folder", disabled: !top, data: { action: "lock" } }, "🔒"),
      h("button", { class: "round keep", type: "button", title: "Keep (→)", "aria-label": "Keep", disabled: !top, data: { action: "keep" } }, "♥"));
    this.controls.hidden = false;

    view.cards.slice(STACK_DEPTH, STACK_DEPTH + PREFETCH_AHEAD).forEach((item) => {
      new Image().src = cardImage(item.thumb);
    });
  }

  #card(item, depth) {
    const src = cardImage(item.thumb);
    const isTop = depth === 0;
    return h("article", {
      class: `card ${isTop ? "top" : "under"}`,
      data: { id: item.id },
      style: isTop ? {} : { transform: `translateY(${depth * 14}px) scale(${1 - depth * 0.04})`, opacity: String(1 - depth * 0.25) },
    },
    h("img", { class: "fill", src, alt: "", draggable: "false" }),
    h("img", { class: "photo", src, alt: item.label || "", draggable: "false" }),
    isTop && item.kind === "video" ? h("button", { class: "play", type: "button", title: "Play (Space)", "aria-label": "Play video", data: { action: "play" } }, "▶") : null,
    isTop ? h("span", { class: "stamp stamp-keep" }, "KEEP") : null,
    isTop ? h("span", { class: "stamp stamp-bin" }, "BIN") : null,
    isTop ? h("span", { class: "stamp stamp-archive" }, "ARCHIVE") : null,
    isTop ? h("span", { class: "stamp stamp-lock" }, "LOCK") : null,
    h("div", { class: "meta" },
      item.kind === "video" ? h("span", { class: "badge" }, "▶ Video") : null,
      h("span", {}, item.date || item.label || ""),
      isTop ? h("a", { class: "open", href: item.href, target: "_blank", rel: "noopener" }, "Open ↗") : null));
  }

  /**
   * Starts buffering the top video card as soon as it's shown, hidden behind the poster, so
   * pressing play starts at once instead of only then beginning the download.
   */
  #prepareVideo(card, item) {
    if (card.querySelector("video")) return card.querySelector("video");
    const sources = videoUrls(item.thumb, this.rendition).map((src) => h("source", { src, type: "video/mp4" }));
    const video = h("video", {
      class: "photo", controls: true, playsinline: true, loop: true, preload: "auto", hidden: true,
      poster: card.querySelector("img.photo")?.src || "",
    }, sources);
    // Remember which rendition this library serves, so the next video asks for it first.
    video.addEventListener("loadedmetadata", () => {
      this.rendition = new URL(video.currentSrc).pathname.split("=").pop() || this.rendition;
    });
    // Every rendition failed (not signed in, or Google changed the URLs): offer Google Photos instead.
    sources.at(-1)?.addEventListener("error", () => {
      video.dataset.failed = "1";
      if (!video.hidden) this.#videoFailed(video, item);
    });
    card.querySelector("img.photo")?.before(video);
    return video;
  }

  #videoFailed(video, item) {
    video.replaceWith(h("div", { class: "video-fail" },
      h("p", {}, "This video can't be played here."),
      h("a", { class: "chip", href: item.href, target: "_blank", rel: "noopener" }, "Play in Google Photos ↗")));
  }

  /** Swaps the top video card's poster for its (already buffering) player; Space/P or the ▶ button. */
  togglePlay() {
    const card = this.stage.querySelector(".card.top");
    const item = this.view?.cards?.[0];
    if (!card || !item || item.kind !== "video" || card.dataset.id !== item.id) return;
    const video = card.querySelector("video") || this.#prepareVideo(card, item);
    if (!video.hidden) {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      return;
    }
    card.querySelector("img.photo")?.remove();
    card.querySelector(".play")?.remove();
    card.classList.add("playing");
    if (video.dataset.failed) {
      this.#videoFailed(video, item);
      return;
    }
    video.hidden = false;
    video.play().catch(() => {});
  }

  #bindDrag(card) {
    if (!card) return;
    let start = null;
    let last = null;

    const move = (dx, dy) => pose(card, dx, dy);

    card.addEventListener("pointerdown", (event) => {
      if (this.flinging || event.button !== 0 || event.target.closest("a, button")) return;
      // Leave the player's control bar (seek, volume) to the video itself.
      const video = event.target.closest("video");
      if (video && event.clientY > video.getBoundingClientRect().bottom - 64) return;
      card.setPointerCapture(event.pointerId);
      card.classList.add("dragging");
      start = { x: event.clientX, y: event.clientY };
      last = { x: event.clientX, t: event.timeStamp, v: 0 };
    });

    card.addEventListener("pointermove", (event) => {
      if (!start) return;
      const dt = Math.max(1, event.timeStamp - last.t);
      last = { x: event.clientX, t: event.timeStamp, v: (event.clientX - last.x) / dt };
      move(event.clientX - start.x, (event.clientY - start.y) * 0.4);
    });

    // A drag that started on the video must not also toggle play/pause on release.
    card.addEventListener("click", (event) => {
      if (card.dataset.dragged === "1" && event.target.closest("video")) event.preventDefault();
      card.dataset.dragged = "";
    }, true);

    const release = (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      card.dataset.dragged = Math.abs(dx) > 6 ? "1" : "";
      start = null;
      card.classList.remove("dragging");
      const fast = Math.abs(last.v) > FLING_VELOCITY && Math.abs(dx) > 40;
      if (Math.abs(dx) > card.offsetWidth * COMMIT_FRACTION || fast) {
        this.fling(dx > 0 ? "keep" : "bin");
      } else {
        pose(card, 0);
      }
    };
    card.addEventListener("pointerup", release);
    card.addEventListener("pointercancel", release);
  }

  /** Two-finger horizontal trackpad swipes (and shift+wheel) move and fling the top card. */
  #onWheel(event) {
    if (this.view?.mode !== "deck" || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    // Stop Chrome's swipe-to-go-back while Sweep is using the gesture.
    event.preventDefault();
    const card = this.stage.querySelector(".card.top");
    if (!card || this.flinging || event.timeStamp < this.wheel.lockedUntil) return;
    const scale = event.deltaMode === 1 ? 16 : 1;
    // One gesture is judged by the events' own timestamps: a busy page can deliver them late,
    // which a wall-clock timer would mistake for the end of the swipe.
    if (event.timeStamp - this.wheel.last > WHEEL_IDLE) this.wheel.dx = 0;
    this.wheel.last = event.timeStamp;
    this.wheel.dx -= event.deltaX * scale;
    clearTimeout(this.wheel.timer);
    if (Math.abs(this.wheel.dx) > card.offsetWidth * COMMIT_FRACTION) {
      const decision = this.wheel.dx > 0 ? "keep" : "bin";
      this.wheel = { dx: 0, last: -Infinity, timer: 0, lockedUntil: event.timeStamp + WHEEL_COOLDOWN };
      this.fling(decision);
      return;
    }
    card.classList.add("dragging");
    pose(card, this.wheel.dx);
    // Only the spring-back is timed; the distance resets from timestamps above.
    this.wheel.timer = setTimeout(() => {
      card.classList.remove("dragging");
      pose(card, 0);
    }, WHEEL_IDLE);
  }

  // --- help & settings ----------------------------------------------------------

  toggleHelp(force = !this.helpOpen) {
    this.helpOpen = force;
    this.helpEl.hidden = !force;
    if (force && this.view) this.#renderHelp(this.view);
  }

  #renderHelp(view) {
    const { kept, binned, trashed, toArchive, archived, toLock, locked } = view.totals || {};
    const button = (action, label, title) => h("button", { class: "chip", type: "button", title, disabled: view.busy, data: { action } }, label);
    this.helpEl.replaceChildren(
      h("div", { class: "help-head" },
        h("h2", {}, "Sweep"),
        h("button", { class: "icon", type: "button", "aria-label": "Close help", data: { action: "help" } }, "✕")),
      h("p", {}, "Swipe or drag a card — left to bin, right to keep. On a trackpad, swipe two fingers sideways. The 🗄 and 🔒 buttons (or ↑ / ↓) mark a photo for Archive or the Locked Folder instead. Nothing happens in Google Photos until you open the bin and confirm; binned photos go to Google Photos Trash, where Google keeps them for 60 days."),
      h("table", { class: "keys" }, SHORTCUTS.map(([key, what]) => h("tr", {}, h("td", {}, h("kbd", {}, key)), h("td", {}, what)))),
      h("h3", {}, "Your sweep"),
      h("p", { class: "totals" }, `${kept ?? 0} kept · ${binned ?? 0} in the bin · ${trashed ?? 0} moved to Trash`),
      toArchive || archived || toLock || locked
        ? h("p", { class: "totals" }, `${toArchive ?? 0} to archive · ${archived ?? 0} archived · ${toLock ?? 0} to lock · ${locked ?? 0} in the Locked Folder`)
        : null,
      h("div", { class: "row" },
        button("forgetKept", "Review kept again", "Forget your keep decisions so those photos come back to the deck"),
        button("clearHashes", "Clear duplicate cache", "Forget saved thumbnail fingerprints; the next duplicate scan re-reads every thumbnail")),
      h("p", { class: "hint" }, "Everything Sweep remembers stays in this browser profile. It never uploads your photos anywhere."));
  }

  /** Animates the top card off-screen, then applies the decision. */
  fling(decision) {
    const card = this.stage.querySelector(".card.top");
    if (!card || this.flinging) return;
    this.flinging = true;
    const id = card.dataset.id;
    const { x, y, stamp } = FLINGS[decision];
    card.classList.add("flinging");
    card.style.setProperty(stamp, 1);
    card.style.transform = y
      ? `translate(0, ${y * innerHeight}px) scale(.8)`
      : `translate(${x * innerWidth}px, 40px) rotate(${x * MAX_TILT_DEGREES * 2}deg)`;
    setTimeout(() => {
      this.flinging = false;
      // Passing the id means a card that changed mid-animation (e.g. a re-render) isn't decided by mistake.
      this.actions[decision](id);
    }, 220);
  }

  // --- basket -------------------------------------------------------------------

  #renderBasket(view) {
    this.backdrop.style.backgroundImage = "none";
    const count = view.basket.length;
    const kind = KINDS[view.basketKind] || KINDS.bin;
    const marked = view.marked || { bin: count };
    const tabs = h("div", { class: "row tabs", role: "tablist" }, Object.entries(KINDS).map(([key, spec]) => h("button", {
      class: `chip ${key === (view.basketKind || "bin") ? "on" : ""}`, type: "button", role: "tab", disabled: view.busy,
      "aria-selected": String(key === (view.basketKind || "bin")), data: { action: "basketKind", kind: key },
    }, `${spec.tab} ${marked[key] || 0}`)));
    const tiles = view.basket.map((entry) => h("button", {
      class: "tile", type: "button", title: "Unmark", disabled: view.busy, data: { action: "unmark", id: entry.id },
    },
    h("img", { src: sizedImageUrl(entry.thumb, 360, 360), alt: entry.label || "", loading: "lazy" }),
    entry.kind === "video" ? h("span", { class: "badge" }, "▶") : null,
    h("span", { class: "unmark" }, "Unmark")));

    // Marked in another album or view: the grid here can't reach them, so they go one by one.
    const elsewhere = new Map();
    for (const entry of view.basket) {
      if (entry.from && entry.from !== view.here) elsewhere.set(entry.from, (elsewhere.get(entry.from) || 0) + 1);
    }
    const away = [...elsewhere.values()].reduce((sum, n) => sum + n, 0);
    const elsewhereNote = away ? h("p", { class: "elsewhere" },
      `${away} ${away === 1 ? "was" : "were"} marked in another view. Sweep ${kind.verb} ${away === 1 ? "it" : "those"} one by one from each photo's own page in a background tab, which is slower — or open `,
      ...[...elsewhere.keys()].slice(0, 3).flatMap((key, i) => [
        i ? ", " : "",
        h("a", { href: new URL(key, "https://photos.google.com/").href, target: "_self" }, `${viewName(key)} (${elsewhere.get(key)})`),
      ]),
      " and do it from there.") : null;

    this.stage.replaceChildren(h("section", { class: "basket" },
      h("div", { class: "basket-head" },
        h("div", {},
          tabs,
          h("h2", {}, `${kind.title} · ${count}`),
          h("p", {}, "Nothing has happened in Google Photos yet. Tap a photo to unmark it."),
          elsewhereNote),
        h("div", { class: "row" },
          view.notFound ? h("button", {
            class: "chip", type: "button", disabled: view.busy, data: { action: "forgetNotFound" },
            title: "Remove the marked photos Sweep couldn't find on this page (e.g. already trashed)",
          }, `Clear ${view.notFound} not found`) : null,
          h("a", { class: "chip", href: "https://photos.google.com/trash", target: "_blank", rel: "noopener" }, "Open Trash ↗"),
          h("button", { class: "chip", type: "button", disabled: view.busy, data: { action: "closeBasket" } }, "← Back to deck"))),
      count ? h("div", { class: "grid" }, tiles) : h("div", { class: "empty" }, h("p", {}, "Nothing marked here."))));

    this.controls.replaceChildren(...(count ? [h("div", { class: "trash-box" },
      view.stoppable
        ? h("button", { class: "chip", type: "button", data: { action: "stopTrash" } }, view.stoppable)
        : h("button", { class: `primary ${kind.style}`, type: "button", disabled: view.busy, data: { action: "trash" } },
          view.busy ? "Working…" : kind.button(count)),
      h("p", {}, kind.note))] : []));
    this.controls.hidden = !count;
  }

  // --- input ----------------------------------------------------------------------

  #onClick(event) {
    if (event.target.closest("a")) return;
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const { action, id } = target.dataset;
    if (FLINGS[action]) this.fling(action);
    else if (action === "help") this.toggleHelp();
    else if (action === "basket") this.actions.openBasket();
    else if (action === "basketKind") this.actions.basketKind(target.dataset.kind);
    else if (action === "unmark" || action === "dupeToggle") this.actions[action](id);
    else if (action === "setRange") this.actions.setRange(target.dataset.preset);
    else if (action === "play") this.togglePlay();
    else if (action === "applyRange") this.applyRange?.();
    else this.actions[action]?.();
  }

  #onDupesKey(key, handled) {
    const dupes = this.view.dupes;
    if (key === "escape") {
      handled();
      this.actions.exitDupes();
      return;
    }
    if (dupes?.phase !== "review") return;
    const number = Number(key);
    if (number >= 1 && number <= Math.min(9, dupes.group.length)) {
      handled();
      this.actions.dupeToggle(dupes.group[number - 1].id);
    } else if (key === "enter") {
      handled();
      this.actions.dupeApply();
    } else if (key === "s") {
      handled();
      this.actions.dupeSkip();
    } else if (key === "a") {
      handled();
      this.actions.dupeKeepAll();
    } else if (key === "z" || key === "backspace") {
      handled();
      this.actions.dupeBack();
    }
  }

  #onKey(event) {
    if (!this.open || event.isComposing) return;
    // Swallow everything so Google Photos' own shortcuts (e.g. "#" = delete) never fire underneath.
    // Default actions still run, so typing into the date inputs keeps working.
    event.stopPropagation();
    const key = event.key.toLowerCase();
    const handled = () => event.preventDefault();
    const inBasket = this.view?.mode === "basket";

    if (this.helpOpen) {
      // Help never blocks sweeping: Esc or ? just close it, any other key closes it and still acts.
      this.toggleHelp(false);
      if (key === "escape" || key === "?") {
        handled();
        return;
      }
    }
    if (key === "?" && this.view?.mode !== "range") {
      handled();
      this.toggleHelp(true);
      return;
    }

    if (this.view?.mode === "range") {
      if (key === "escape") {
        handled();
        this.actions.closeRange();
      } else if (key === "enter") {
        handled();
        this.applyRange?.();
      }
      return;
    }

    if (this.view?.mode === "dupes") {
      this.#onDupesKey(key, handled);
    } else if (key === "escape") {
      handled();
      if (inBasket && !this.view.busy) this.actions.closeBasket();
      else this.actions.close();
    } else if (inBasket) {
      return;
    } else if (this.flinging) {
      // Undo, filters and mode switches wait until the flung card has landed.
      handled();
    } else if (key === "arrowleft" || key === "d") {
      handled();
      this.fling("bin");
    } else if (key === "arrowright" || key === "k") {
      handled();
      this.fling("keep");
    } else if (key === "arrowup" || key === "a") {
      handled();
      this.fling("archive");
    } else if (key === "arrowdown" || key === "l") {
      handled();
      this.fling("lock");
    } else if (key === "z" || key === "backspace") {
      handled();
      this.actions.undo();
    } else if (key === "b") {
      handled();
      this.actions.openBasket();
    } else if (key === "f") {
      handled();
      this.actions.findDupes();
    } else if (key === "r") {
      handled();
      this.actions.openRange();
    } else if (key === "v") {
      handled();
      this.actions.cycleMedia();
    } else if (key === " " || key === "p") {
      handled();
      this.togglePlay();
    } else if (key === "enter") {
      handled();
      const link = this.stage.querySelector(".card.top .open");
      if (link) window.open(link.href, "_blank", "noopener");
    }
  }
}
