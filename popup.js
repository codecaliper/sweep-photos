import { formatRange, hasRange, monthRange, presetRange, searchQueryFor } from "./src/dates.js";

const RANGE_KEY = "sweepRange";
const MEDIA_KEY = "sweepMedia";
const SEARCH_KEY = "sweepUseSearch";
const PENDING = ["bin", "archive", "lock"];

const $ = (id) => document.getElementById(id);
const from = $("from");
const to = $("to");
const month = $("month");
const year = $("year");
const useSearch = $("useSearch");

let media = "all";

function range() {
  return { from: from.value || null, to: to.value || null };
}

function setRange(next, source = null) {
  from.value = next?.from || "";
  to.value = next?.to || "";
  if (source !== "month") month.value = "";
  if (source !== "year") year.value = "";
  update();
}

function update() {
  const current = range();
  const query = useSearch.checked ? searchQueryFor(current) : null;
  $("plan").textContent = !hasRange(current)
    ? "Sweeps your whole Photos timeline, newest first."
    : query
      ? `Opens Google Photos search “${query}”, then sweeps ${formatRange(current)}.`
      : `Opens your Photos timeline and jumps straight to ${formatRange(current)}.`;
  document.querySelectorAll("#media button").forEach((button) => button.classList.toggle("on", button.dataset.media === media));
  document.querySelectorAll("#presets button").forEach((button) => {
    const preset = presetRange(button.dataset.preset);
    button.classList.toggle("on", preset.from === current.from && preset.to === current.to);
  });
}

$("presets").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) setRange(presetRange(button.dataset.preset));
});
$("media").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  media = button.dataset.media;
  update();
});
month.addEventListener("input", () => {
  if (month.value && Number(month.value.slice(0, 4)) >= 1900) setRange(monthRange(month.value), "month");
});
year.addEventListener("input", () => {
  const value = Number(year.value);
  if (value >= 1900 && value <= 2100) setRange({ from: `${value}-01-01`, to: `${value}-12-31` }, "year");
});
for (const input of [from, to]) input.addEventListener("input", () => { month.value = ""; year.value = ""; update(); });
useSearch.addEventListener("change", update);

async function go(here) {
  let current = range();
  if (current.from && current.to && current.from > current.to) current = { from: current.to, to: current.from };
  await chrome.storage.local.set({ [RANGE_KEY]: current, [MEDIA_KEY]: media, [SEARCH_KEY]: useSearch.checked });
  $("go").disabled = true;
  $("error").hidden = true;
  // For tests, ?tab=<id> picks the Google Photos tab; normally it's the one this popup came from.
  const tabId = Number(new URLSearchParams(location.search).get("tab")) || undefined;
  const sent = chrome.runtime.sendMessage({ type: "sweep-popup-start", range: current, media, useSearch: useSearch.checked, here, tabId });
  if (!tabId) {
    // The worker carries on without the popup, which Chrome closes once the page takes focus.
    sent.catch(() => {});
    setTimeout(() => window.close(), 150);
    return;
  }
  const reply = await sent.catch((error) => ({ ok: false, error: String(error) }));
  $("go").disabled = false;
  if (!reply?.ok) {
    $("error").textContent = reply?.error || "Sweep couldn't start on that page.";
    $("error").hidden = false;
  }
}

$("go").addEventListener("click", () => go(false));
$("here").addEventListener("click", () => go(true));
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.target.closest("button")) go(false);
});

const stored = await chrome.storage.local.get([RANGE_KEY, MEDIA_KEY, SEARCH_KEY, "sweepDecisions"]);
media = ["all", "photos", "videos"].includes(stored[MEDIA_KEY]) ? stored[MEDIA_KEY] : "all";
useSearch.checked = stored[SEARCH_KEY] !== false;
setRange(stored[RANGE_KEY]);
const marked = Object.values(stored.sweepDecisions || {}).filter((entry) => PENDING.includes(entry?.d)).length;
$("marked").textContent = marked ? `${marked} marked, waiting in the bin` : "";
