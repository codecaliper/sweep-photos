# Privacy

Sweep for Google Photos doesn't collect, send or sell any data. There's no server, no account, no analytics and no third-party code.

## What it reads

- **photos.google.com pages you open.** Sweep reads the photo grid (links, thumbnails and their date labels) to build the swipe deck, and presses Google's own buttons when you ask it to move photos to Trash, Archive or the Locked Folder.
- **Thumbnails and videos from `*.googleusercontent.com`.** These are fetched with your existing Google session to show cards, play videos and fingerprint thumbnails for the duplicate finder. The requests go only to Google.

## What it stores

Only in your browser, in `chrome.storage.local`:

- your decisions: photo IDs you kept, marked or moved, and whether each was done
- duplicate fingerprints: a 64-bit number per photo ID
- your settings: date range, photos/videos filter, whether to use Google search, and whether you've seen the help

Nothing leaves your computer. Removing the extension deletes all of it. The help panel's **Review kept again** and **Clear duplicate cache** clear parts of it.

## Permissions

| Permission | Why |
| --- | --- |
| `photos.google.com` | Show the Sweep overlay and act on the page |
| `*.googleusercontent.com` | Load thumbnails and videos, and fingerprint thumbnails for duplicates |
| `storage` | Remember your decisions and settings |
| `scripting` | Start Sweep in Google Photos tabs that were open before it was installed |
| `tabGroups` | Keep the background tab it uses for one-by-one moves in a collapsed "Sweep" group |
