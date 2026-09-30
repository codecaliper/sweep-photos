// Content-script -> service-worker messaging that survives MV3 worker restarts.
// Chrome idles the worker out after ~30s (e.g. during a long duplicate scan); a
// message that lands while it is shutting down fails with "Receiving end does not
// exist", and a fresh send a moment later wakes a new worker.

const TRANSIENT = /receiving end does not exist|message port closed/i;
const INVALIDATED = /extension context invalidated/i;

export const RELOAD_HINT = "Sweep was updated or reloaded. Refresh this Google Photos tab to keep going.";

export async function askWorker(message, {
  send = (m) => chrome.runtime.sendMessage(m),
  alive = () => Boolean(globalThis.chrome?.runtime?.id),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tries = 4,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send(message);
    } catch (error) {
      const text = String(error?.message || error);
      if (INVALIDATED.test(text) || !alive()) throw new Error(RELOAD_HINT);
      if (attempt >= tries || !TRANSIENT.test(text)) throw error;
      await sleep(300 * attempt);
    }
  }
}
