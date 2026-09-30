# Contributing

Thanks for helping. Sweep deletes people's photos, so changes are held to one rule: **when unsure, stop and leave it to the user.** Never click a Google button that isn't positively identified, and verify every action against what the page shows afterwards.

## Setup

```bash
git clone https://github.com/codecaliper/sweep-photos
cd sweep-photos
(cd e2e && npm ci)
```

Load the folder with **Load unpacked** in `chrome://extensions` and press ↻ after each change.

## Before opening a pull request

```bash
npm run check && npm test && npm run e2e
```

- **Google changed its UI:** fix it in `src/photos-dom.js`, which holds all of Sweep's knowledge of Google's markup. Then update the mock in `e2e/run.mjs` to match, so the tests keep describing the real site.
- **New behaviour:** add a unit test in `sweep.test.mjs` for pure logic, and an e2e scenario for anything that touches the page.
- **New files Chrome loads:** add them to `tools/runtime-files.mjs`, or they won't be packaged.
- Google Photos enforces Trusted Types: build DOM with the `h()` helper in `src/overlay.js`, never `innerHTML`.
- Keep the README in step with what users see.

## Releasing

Bump `version` in both `manifest.json` and `package.json`, merge, then push a matching tag:

```bash
git tag v0.9.1 && git push origin v0.9.1
```

CI tests it and publishes a GitHub release with the zip.
