import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, isBlockedHost, safeEqual } from '../netlify/functions/fire.mjs';

const SECRET = 'test-secret-abc';
const env = { RELAY_SECRET: SECRET };
const bearer = { authorization: `Bearer ${SECRET}` };

function req(path, init) {
  return new Request(`https://relay.test${path}`, init);
}

test('health', async () => {
  const r = await handleRequest(req('/health', { method: 'GET' }), env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('OPTIONS preflight', async () => {
  const r = await handleRequest(req('/fire', { method: 'OPTIONS' }), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('missing/blank secret env → 500', async () => {
  const r = await handleRequest(req('/fire', { method: 'POST', headers: bearer, body: '{}' }), {});
  assert.equal(r.status, 500);
});

test('bad token → 401', async () => {
  const r = await handleRequest(
    req('/fire', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' }),
    env,
  );
  assert.equal(r.status, 401);
});

test('invalid JSON → 400', async () => {
  const r = await handleRequest(req('/fire', { method: 'POST', headers: bearer, body: 'not json' }), env);
  assert.equal(r.status, 400);
});

test('blocked private host → 403', async () => {
  const r = await handleRequest(
    req('/fire', { method: 'POST', headers: bearer, body: JSON.stringify({ url: 'http://192.168.1.1/' }) }),
    env,
  );
  assert.equal(r.status, 403);
});

test('unknown route → 404', async () => {
  const r = await handleRequest(req('/nope', { method: 'GET' }), env);
  assert.equal(r.status, 404);
});

test('successful proxy returns envelope; secret not leaked upstream', async () => {
  const orig = globalThis.fetch;
  let sawAuth = 'MISSING';
  globalThis.fetch = async (_url, init) => {
    sawAuth = (init.headers && (init.headers.authorization ?? init.headers.Authorization)) || 'NONE';
    return new Response('hello world', { status: 200, statusText: 'OK' });
  };
  try {
    const r = await handleRequest(
      req('/fire', {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ method: 'POST', url: 'https://example.com/x', headers: { 'X-Test': '1' }, body: 'hi' }),
      }),
      env,
    );
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.status, 200);
    assert.equal(j.body, 'hello world');
    assert.equal(sawAuth, 'NONE'); // relay secret never forwarded
  } finally {
    globalThis.fetch = orig;
  }
});

test('isBlockedHost unit', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.0.5', '169.254.169.254', '::1', 'foo.local']) {
    assert.equal(isBlockedHost(h), true, `${h} should be blocked`);
  }
  for (const h of ['example.com', 'maker.ifttt.com', '8.8.8.8']) {
    assert.equal(isBlockedHost(h), false, `${h} should be allowed`);
  }
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
});
