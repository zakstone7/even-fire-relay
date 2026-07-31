# Fire relay (self-hosted)

A tiny, stateless HTTP fetch-proxy for the
[Fire](https://github.com/zakstone7/even-fire) Even G2 plugin.

Fire runs in a WebView, so it can't read cross-origin responses (CORS) or use
arbitrary methods/headers against non-CORS hosts. This relay makes the request
**server-side** (no CORS there) and returns the real result to the app. Deploy
it to **your own free Netlify account** and it's yours — nobody else can see
your requests or secrets.

## Deploy in one tap (from your phone)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/zakstone7/even-fire-relay)

Tapping the button:

1. Asks you to authorize **Netlify** and **GitHub** (free accounts; no card).
2. **Copies this repo into your own GitHub** and deploys it to your Netlify.
3. **Prompts you for `RELAY_SECRET`** — enter a long random string (32+ chars;
   a password manager's "suggest strong password" is perfect) and keep it.
4. Gives you a site URL, e.g. `https://your-name.netlify.app`.

Then, in the Fire app → **Relay**:

- **Relay URL** = your Netlify site URL
- **Relay secret** = the `RELAY_SECRET` you entered

Turn on **use relay** per Raw trigger. Check it's live by opening
`https://your-name.netlify.app/health` → `{"ok":true}`.

> No computer, no CLI, no file downloads. Everything above works in a phone
> browser.

## What it does / doesn't

- ✅ Proxies one HTTP request per call and returns `{ status, statusText, headers, body }`.
- ✅ Auth by a single shared secret you set (`RELAY_SECRET`).
- ✅ CORS-correct (the app can read the response), size + timeout caps, SSRF guard.
- ❌ No accounts, no billing, no request logging, no persistence.
- ❌ Can't reach your LAN (`192.168.x`, `localhost`, …) — those are blocked and
  should be fired **directly from the phone** in the app (per-trigger "use relay = off").

## Cost

Runs on **Netlify's free tier**: **125,000 function invocations/month** (plus
100 hrs runtime and 100 GB bandwidth). A personal relay — one call per trigger
fire — stays far under that, so in practice it's free.

## API

```
POST /fire        Authorization: Bearer <RELAY_SECRET>
                  { "method": "POST", "url": "https://…", "headers": { … }, "body": "…" }
  200  { ok, status, statusText, headers, body, truncated }
  401  unauthorized      403  blocked host (private/reserved)
  400  bad request       413  request too large
  502  upstream failed   504  upstream timeout

OPTIONS /fire     CORS preflight
GET /health       { ok: true }
```

The incoming `Authorization` (your relay secret) is **never** forwarded upstream —
the upstream request's headers come only from the `headers` you send.

## Config (all optional)

Set these as site **Environment variables** in Netlify (Site settings →
Environment variables). Only `RELAY_SECRET` is required.

| var | default | meaning |
| --- | --- | --- |
| `RELAY_SECRET` | — (**required**) | shared secret; the app sends it as `Bearer` |
| `ALLOWED_ORIGIN` | `*` | CORS allow-origin |
| `MAX_REQUEST_BYTES` | `131072` | max request body |
| `MAX_RESPONSE_BYTES` | `262144` | max response bytes returned |
| `TIMEOUT_MS` | `10000` | upstream timeout |
| `ALLOW_PRIVATE` | `false` | allow private/reserved hosts (leave off) |

## Test

```bash
npm test        # node --test, no Netlify account needed
```

## Prefer Cloudflare instead?

The same relay is available as a Cloudflare Worker in the app repo under
[`relay/`](https://github.com/zakstone7/even-fire/tree/HEAD/relay) (upload
`_worker.js` via the dashboard). Netlify's one-tap button is the easier path on
a phone.

## Files

- `netlify/functions/fire.mjs` — the whole relay (Netlify Function; serves
  `/fire` + `/health` via `config.path`).
- `netlify.toml` — no-op build + the `RELAY_SECRET` deploy prompt.
- `public/index.html` — a friendly landing page at the site root.
- `test/fire.test.mjs` — the test suite.
