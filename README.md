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
3. **Paste the relay.** Select all the starter code in the editor and delete it,
   then paste the entire worker — either the full listing under
   [The worker code](#the-worker-code) below, or the same file at
   [`src/worker.mjs`](src/worker.mjs). Click **Deploy**.
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

### The worker code

This is the whole relay — paste it verbatim into the Cloudflare editor in step 3.
It is identical to [`src/worker.mjs`](src/worker.mjs); if the two ever differ,
the file is the source of truth.

```js
/**
 * Fire relay — a stateless HTTP fetch-proxy.
 *
 * The Fire glasses plugin runs in a WebView, so it can't read cross-origin
 * responses (CORS) or use arbitrary methods/headers against non-CORS hosts.
 * This Worker makes the request server-side (no CORS there) and returns the
 * result to the app WITH permissive CORS headers, so the app gets real status
 * codes and bodies.
 *
 * This is the SELF-HOSTED build: a single shared secret (env RELAY_SECRET)
 * authorizes callers. No accounts, no billing, no request logging.
 *
 * Contract:
 *   POST /fire       Authorization: Bearer <RELAY_SECRET>
 *                    body: { method, url, headers?, body? }
 *     -> 200 { ok, status, statusText, headers, body, truncated }
 *        401 unauthorized · 400 bad request · 403 blocked host
 *        413 too large · 502 upstream failed · 504 timeout
 *   OPTIONS /fire     CORS preflight
 *   GET /health       { ok: true }
 *
 * Security notes:
 * - The incoming Authorization (the relay secret) is NEVER forwarded upstream;
 *   the upstream request's headers come only from the spec's `headers`.
 * - SSRF guard blocks private/reserved/metadata IP literals. (A Cloudflare edge
 *   Worker can't reach a home LAN anyway — local endpoints are fired directly
 *   from the phone, not through the relay.)
 */

const DEFAULTS = {
  MAX_REQUEST_BYTES: 128 * 1024,
  MAX_RESPONSE_BYTES: 256 * 1024,
  TIMEOUT_MS: 10_000,
};

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const HOP_BY_HOP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

/** True if the host is a private/reserved/metadata address we must not proxy to. */
export function isBlockedHost(hostname, allowPrivate = false) {
  if (!hostname) return true;
  if (allowPrivate) return false;
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') {
    return true;
  }

  // IPv6 literal
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // link-local
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
    return false;
  }

  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 255 || b > 255) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                          // multicast / reserved
    return false;
  }

  return false; // ordinary hostname (edge can't route to a private LAN regardless)
}

function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  const entries = Array.isArray(h)
    ? h.map((x) => [x && x.name, x && x.value])
    : Object.entries(h);
  for (const [k, v] of entries) {
    if (!k) continue;
    const key = String(k);
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = String(v ?? '');
  }
  return out;
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/** Constant-time-ish string compare to avoid trivial timing leaks. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readCapped(res, cap) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const t = await res.text();
    return { text: t.length > cap ? t.slice(0, cap) : t, truncated: t.length > cap };
  }
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > cap) {
      chunks.push(value.slice(0, cap - size));
      truncated = true;
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return { text: new TextDecoder().decode(buf), truncated };
}

async function handleFire(request, env, cors) {
  const secret = env.RELAY_SECRET;
  if (!secret) return json({ error: 'relay misconfigured: RELAY_SECRET is not set' }, 500, cors);

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(token, secret)) return json({ error: 'unauthorized' }, 401, cors);

  const allowPrivate = String(env.ALLOW_PRIVATE) === 'true';
  const maxReq = Number(env.MAX_REQUEST_BYTES) || DEFAULTS.MAX_REQUEST_BYTES;
  const maxRes = Number(env.MAX_RESPONSE_BYTES) || DEFAULTS.MAX_RESPONSE_BYTES;
  const timeoutMs = Number(env.TIMEOUT_MS) || DEFAULTS.TIMEOUT_MS;

  let spec;
  try { spec = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400, cors); }

  const method = String(spec.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return json({ error: `method not allowed: ${method}` }, 400, cors);

  let url;
  try { url = new URL(String(spec.url)); } catch { return json({ error: 'invalid url' }, 400, cors); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return json({ error: 'only http(s) urls are allowed' }, 400, cors);
  }
  if (isBlockedHost(url.hostname, allowPrivate)) {
    return json({ error: 'blocked host (private/reserved). Fire local endpoints directly from the phone, not via the relay.' }, 403, cors);
  }

  const headers = normalizeHeaders(spec.headers);
  const bodyless = method === 'GET' || method === 'HEAD';
  const body = bodyless || spec.body == null || spec.body === '' ? undefined : String(spec.body);
  if (body && byteLength(body) > maxReq) {
    return json({ error: `request body exceeds ${maxReq} bytes` }, 413, cors);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url.toString(), { method, headers, body, redirect: 'follow', signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    return json(
      { error: aborted ? 'upstream timeout' : 'upstream fetch failed', detail: String((err && err.message) || err) },
      aborted ? 504 : 502,
      cors,
    );
  }
  clearTimeout(timer);

  const { text, truncated } = await readCapped(res, maxRes);
  const resHeaders = {};
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() !== 'set-cookie') resHeaders[k] = v;
  }

  return json(
    { ok: res.ok, status: res.status, statusText: res.statusText, headers: resHeaders, body: text, truncated },
    200,
    cors,
  );
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders((env && env.ALLOWED_ORIGIN) || '*');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    if (url.pathname === '/fire' && request.method === 'POST') return handleFire(request, env, cors);
    return json({ error: 'not found' }, 404, cors);
  },
};
```

## Deploy — with the CLI (if you already have Node)

```bash
cd relay
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
