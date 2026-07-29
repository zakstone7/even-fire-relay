# Fire relay (self-hosted)

A tiny, stateless HTTP fetch-proxy for the
[Fire](https://github.com/zakstone7/even-fire) Even G2 plugin.

Fire runs in a WebView, so it can't read cross-origin responses (CORS) or use
arbitrary methods/headers against non-CORS hosts. This relay makes the request
**server-side** (no CORS there) and returns the real result to the app. Deploy
it to **your own Cloudflare account** and it's yours — nobody else can see your
requests or secrets.

## What it does / doesn't

- ✅ Proxies one HTTP request per call and returns `{ status, statusText, headers, body }`.
- ✅ Auth by a single shared secret you set (`RELAY_SECRET`).
- ✅ CORS-correct (the app can read the response), size + timeout caps, SSRF guard.
- ❌ No accounts, no billing, no request logging, no persistence.
- ❌ Can't reach your LAN (`192.168.x`, `localhost`, …) — those are blocked and
  should be fired **directly from the phone** in the app (per-trigger "use relay = off").

## Cost

This runs on **Cloudflare Workers' free tier**: 100,000 requests/day, no credit
card, and **no egress charges**. A personal relay never comes close to the
limit, so in practice it is free. That is the cheapest option there is — a relay
is just a fetch-proxy, so anything with a free serverless tier works, but
Cloudflare needs no card and the deploy below needs no tools.

## Deploy — easiest way (no CLI, works from your phone)

You don't need Node, `wrangler`, or a terminal. The whole thing is one file you
paste into Cloudflare's web dashboard. ~5 minutes, start to finish.

1. **Make a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>
   (no card needed).
2. **Create a Worker.** In the dashboard sidebar, open **Build → Compute
   (Workers)** (older accounts show it as **Workers & Pages**). Click **Create
   application**, then choose the **Hello World** starter. Give it a name (e.g.
   `fire-relay` — this becomes your URL), then **Deploy**, then **Edit code**.
3. **Paste the relay.** Open [`src/worker.mjs`](src/worker.mjs) in this repo and
   hit **"Copy raw file"** (the copy icon at the top-right of the file view).
   Back in the Cloudflare editor, select all the starter code, delete it, and
   paste. Click **Deploy**.
4. **Set your secret.** Leave the editor. On the Worker's page go to **Settings →
   Variables and Secrets → Add**, type **`RELAY_SECRET`** as the name, pick a
   long random value, choose **Encrypt** (a "Secret", not plaintext), and
   **Deploy**. Use any password generator, or your phone's password manager
   "suggest strong password" — 30+ characters. Save this value; you'll paste it
   into the app.
5. **Grab your URL.** It's shown on the Worker's page:
   `https://fire-relay.<your-subdomain>.workers.dev`. Tap it and append
   `/health` — you should see `{"ok":true}`. That confirms it's live.

In the Fire app → phone settings → **Relay**:

- **Relay URL** = your Worker URL (e.g. `https://fire-relay.you.workers.dev`)
- **Relay secret** = the `RELAY_SECRET` you chose in step 4

Then set **use relay = on** per Raw trigger you want routed through it. Done.

> Updating later: to pull in a newer `worker.mjs`, repeat step 3 (paste + Deploy).
> Your secret and URL stay put.

## Deploy — with the CLI (if you already have Node)

```bash
git clone https://github.com/zakstone7/even-fire-relay
cd even-fire-relay
npm install
npx wrangler login
# set a long random secret (e.g. `openssl rand -base64 32`):
npx wrangler secret put RELAY_SECRET
npm run deploy
```

Wrangler prints your Worker URL, then configure the app exactly as above.

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

Everything below has a sane default — you never need to set any of these to get
going. To change one, add it as a plaintext **Variable** in the dashboard
(**Settings → Variables and Secrets**, same place as the secret), or as a `[vars]`
entry in `wrangler.toml` if you use the CLI.

| var | default | meaning |
| --- | --- | --- |
| `ALLOWED_ORIGIN` | `*` | CORS allow-origin |
| `MAX_REQUEST_BYTES` | `131072` | max request body |
| `MAX_RESPONSE_BYTES` | `262144` | max response bytes returned |
| `TIMEOUT_MS` | `10000` | upstream timeout |
| `ALLOW_PRIVATE` | `false` | allow private/reserved hosts (leave off) |

`RELAY_SECRET` is the one thing you *must* set, and it's a **Secret** (encrypted),
not a plaintext Variable.

## Test

```bash
npm test        # node --test, no Cloudflare account needed
```
