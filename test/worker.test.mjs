import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isBlockedHost, safeEqual } from '../src/worker.mjs';

const ENV = { RELAY_SECRET: 'topsecret' };

function fireReq(body, { auth = 'Bearer topsecret' } = {}) {
  return new Request('https://relay.example.com/fire', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Install a mock upstream fetch; returns a capture object. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return calls;
}

test('health', async () => {
  const res = await worker.fetch(new Request('https://r/health'), ENV);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('OPTIONS preflight', async () => {
  const res = await worker.fetch(new Request('https://r/fire', { method: 'OPTIONS' }), ENV);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
});

test('unauthorized without/with wrong secret', async () => {
  const noAuth = await worker.fetch(fireReq({ url: 'https://ex.com' }, { auth: '' }), ENV);
  assert.equal(noAuth.status, 401);
  const wrong = await worker.fetch(fireReq({ url: 'https://ex.com' }, { auth: 'Bearer nope' }), ENV);
  assert.equal(wrong.status, 401);
});

test('400 on invalid json / url / method', async () => {
  assert.equal((await worker.fetch(fireReq('{not json'), ENV)).status, 400);
  assert.equal((await worker.fetch(fireReq({ url: 'not a url' }), ENV)).status, 400);
  assert.equal((await worker.fetch(fireReq({ url: 'https://ex.com', method: 'TRACE' }), ENV)).status, 400);
  assert.equal((await worker.fetch(fireReq({ url: 'ftp://ex.com' }), ENV)).status, 400);
});

test('403 blocked private/reserved hosts', async () => {
  for (const u of [
    'http://127.0.0.1/x',
    'http://192.168.1.10/x',
    'http://10.0.0.5/x',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:8080/x',
    'http://ha.local/api',
  ]) {
    const res = await worker.fetch(fireReq({ url: u }), ENV);
    assert.equal(res.status, 403, `expected 403 for ${u}`);
  }
});

test('successful proxy returns status + body + headers', async () => {
  const calls = mockFetch(async () =>
    new Response(JSON.stringify({ hello: 'world' }), {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
    }),
  );
  const res = await worker.fetch(
    fireReq({ method: 'POST', url: 'https://api.example.com/hook', headers: { 'X-Test': '1' }, body: '{"a":1}' }),
    ENV,
  );
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.status, 201);
  assert.equal(j.statusText, 'Created');
  assert.match(j.body, /world/);
  assert.equal(j.ok, true);
  // upstream received our method/headers/body
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['X-Test'], '1');
  assert.equal(calls[0].opts.body, '{"a":1}');
});

test('relay secret is NOT forwarded upstream', async () => {
  const calls = mockFetch(async () => new Response('ok', { status: 200 }));
  await worker.fetch(
    fireReq({ method: 'GET', url: 'https://api.example.com/', headers: { Authorization: 'Bearer USERKEY' } }),
    ENV,
  );
  const sent = calls[0].opts.headers;
  // The upstream sees the user's own Authorization, never the relay secret.
  assert.equal(sent.Authorization, 'Bearer USERKEY');
  assert.notEqual(sent.Authorization, 'Bearer topsecret');
});

test('413 when request body exceeds cap', async () => {
  const env = { ...ENV, MAX_REQUEST_BYTES: '10' };
  const res = await worker.fetch(fireReq({ method: 'POST', url: 'https://ex.com', body: 'x'.repeat(50) }), env);
  assert.equal(res.status, 413);
});

test('response is truncated at cap', async () => {
  mockFetch(async () => new Response('y'.repeat(1000), { status: 200 }));
  const env = { ...ENV, MAX_RESPONSE_BYTES: '100' };
  const res = await worker.fetch(fireReq({ url: 'https://ex.com' }), env);
  const j = await res.json();
  assert.equal(j.truncated, true);
  assert.equal(j.body.length, 100);
});

test('504 on upstream timeout (abort)', async () => {
  globalThis.fetch = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const res = await worker.fetch(fireReq({ url: 'https://ex.com' }), ENV);
  assert.equal(res.status, 504);
});

test('isBlockedHost unit', () => {
  assert.equal(isBlockedHost('192.168.0.1'), true);
  assert.equal(isBlockedHost('8.8.8.8'), false);
  assert.equal(isBlockedHost('example.com'), false);
  assert.equal(isBlockedHost('::1'), true);
  assert.equal(isBlockedHost('192.168.0.1', true), false); // allowPrivate override
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
});
