# even-fire-relay — moved

The Fire relay now lives **inside the main app repo**, not here:

➡ **https://github.com/zakstone7/even-fire/tree/main/relay**

A separate repo added no value — Cloudflare can't import a repo, so the relay is
just one file (`_worker.js`) you download and upload to the dashboard. Keeping it
next to the app avoids drift.

This repo can be deleted.
