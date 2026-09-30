// Classic content script: stays tiny and lazily loads the ES-module app on first use.
(() => {
  if (globalThis.__sweepPhotosLoaded) return;
  globalThis.__sweepPhotosLoaded = true;

  let app;
  const load = () => (app ||= import(chrome.runtime.getURL("src/main.js")));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Sent by the worker to a helper window showing one marked photo's page.
    if (message?.type === "sweep-trash-here") {
      load()
        .then((module) => module.trashHere(message.id, message.action))
        .then((outcome) => sendResponse({ outcome }))
        .catch((error) => {
          console.error("[sweep]", error);
          sendResponse({ outcome: "error", error: String(error) });
        });
      return true;
    }
    // From the toolbar popup, via the worker: open Sweep here with these dates.
    if (message?.type === "sweep-start") {
      load()
        .then((module) => module.start(message))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error("[sweep]", error);
          sendResponse({ ok: false, error: String(error) });
        });
      return true;
    }
    if (message?.type !== "sweep-toggle") return false;
    load()
      .then((module) => module.toggle())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("[sweep]", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  });
})();
