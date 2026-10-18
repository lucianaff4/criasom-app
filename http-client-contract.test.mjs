import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PlatformClient } from '../client/platform-client.mjs';

// In-memory fetch fixtures only: no HTTP listener, PHP execution or service connection.
const csrf = 'a'.repeat(64);
const challenge = '1'.repeat(32);
const user = {id: 'student_demo', email: 'student@example.invalid'};
const session = (authenticated = true, capabilities = ['app', 'course:penta']) => ({authenticated, user: authenticated ? user : null, csrf, capabilities: authenticated ? capabilities : []});
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
const configured = fetchImpl => { const c = new PlatformClient({fetchImpl}); c.user = user; c.csrf = csrf; c.capabilities = ['app']; return c; };

test('machine-readable contract fixes transport, cookie, limits and backend-only webhook', async () => {
  const c = JSON.parse(await readFile(new URL('../contracts/http-contract.json', import.meta.url), 'utf8'));
  assert.equal(c.basePath, '/api/v1');
  assert.equal(c.transport.cookies.Secure, true); assert.equal(c.transport.cookies.HttpOnly, true);
  assert.equal(c.transport.cookies.SameSite, 'Lax'); assert.equal(c.transport.cookies.prefix, '__Host-');
  assert.equal(c.transport.cookies.Domain, null); assert.equal(c.transport.cookies.Path, '/');
  assert.equal(c.limits.requestBodyUtf8Bytes, 131072); assert.equal(c.limits.stateDataJsonUtf8Bytes, 65536);
  assert.equal(c.routes.find(r => r.path === '/webhooks/hotmart').clientAvailable, false);
  assert.ok(Array.isArray(c.routes[0].authenticatedExample.capabilities));
  assert.equal(c.routes.find(r => r.path === '/resources/{id}').unavailableStatus, 404);
});

test('anonymous context, code, refreshed account, state, protected bytes and logout follow the contract', async () => {
  const calls = [];
  const fixtures = [
    ['/session', 'GET', () => json(session(false))],
    ['/auth/request-code', 'POST', () => json({accepted: true, challenge_id: challenge, expires_in: 600}, 202)],
    ['/auth/confirm-code', 'POST', () => json({authenticated: true})],
    ['/session', 'GET', () => json(session())],
    ['/state/repertoire', 'GET', () => json({revision: 0, data: {favorites: []}})],
    ['/state/repertoire', 'POST', () => json({revision: 1, data: {favorites: ['song_demo']}})],
    ['/resources/penta-page-1', 'GET', () => new Response('%PDF-fixture', {headers: {'content-type': 'application/pdf'}})],
    ['/auth/logout', 'POST', () => json({signed_out: true})],
  ];
  const client = new PlatformClient({fetchImpl: async (url, init) => {
    const [route, method, response] = fixtures[calls.length];
    assert.equal(url, '/api/v1' + route); assert.equal(init.method, method);
    calls.push({url, init}); return response();
  }});
  assert.equal((await client.refreshSession()).authenticated, false);
  assert.equal((await client.requestCode(user.email)).challenge_id, challenge);
  assert.deepEqual((await client.confirmCode(challenge, '12345678')).user, user);
  const before = await client.loadState('repertoire');
  assert.equal(before.revision, 0);
  assert.equal((await client.saveState('repertoire', before.revision, {favorites: ['song_demo']})).revision, 1);
  const pdf = await client.resource('penta-page-1'); assert.equal(pdf.type, 'application/pdf'); assert.equal(await pdf.text(), '%PDF-fixture');
  assert.deepEqual(await client.logout(), {signed_out: true}); assert.equal(client.user, null); assert.equal(client.csrf, null);
  assert.deepEqual(client.capabilities, []); assert.equal(calls.length, fixtures.length);
  for (const {init} of calls) {
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined);
    if (init.method === 'POST') assert.equal(init.headers['X-CSRF-Token'], csrf);
    else { assert.equal(init.body, undefined); assert.equal(init.headers['X-CSRF-Token'], undefined); }
  }
  assert.deepEqual(JSON.parse(calls[1].init.body), {email: user.email});
  assert.deepEqual(JSON.parse(calls[2].init.body), {challenge_id: challenge, code: '12345678'});
  assert.deepEqual(JSON.parse(calls[5].init.body), {expected_revision: 0, data: {favorites: ['song_demo']}});
});

test('anonymous session with a non-null user is invalid and clears the old account', async () => {
  let clears = 0;
  const client = new PlatformClient({fetchImpl: async () => json({...session(false), user}), onClear: () => clears++});
  client.user = user; client.csrf = csrf;
  await assert.rejects(client.refreshSession(), /Invalid session response/);
  assert.equal(client.user, null); assert.equal(client.csrf, null); assert.equal(clears, 1);
});

test('incorrect OTP uses 422 and permits a second confirmation with the same anonymous CSRF', async () => {
  const calls = [];
  const fixtures = [
    ['/session', 'GET', () => json(session(false))],
    ['/auth/request-code', 'POST', () => json({accepted: true, challenge_id: challenge, expires_in: 600}, 202)],
    ['/auth/confirm-code', 'POST', () => json({error: 'invalid_code'}, 422)],
    ['/auth/confirm-code', 'POST', () => json({authenticated: true})],
    ['/session', 'GET', () => json(session())],
  ];
  const client = new PlatformClient({fetchImpl: async (url, init) => {
    const [route, method, response] = fixtures[calls.length];
    assert.equal(url, '/api/v1' + route); assert.equal(init.method, method);
    calls.push({url, init}); return response();
  }});
  await client.refreshSession(); await client.requestCode(user.email);
  const anonymousEpoch = client.epoch;
  await assert.rejects(client.confirmCode(challenge, '00000000'), /Operation unavailable/);
  assert.equal(client.csrf, csrf); assert.equal(client.user, null); assert.equal(client.epoch, anonymousEpoch);
  assert.equal(calls.length, 3); // Invalid code must not trigger a session refresh.
  assert.equal((await client.confirmCode(challenge, '12345678')).authenticated, true);
  assert.equal(calls[2].init.headers['X-CSRF-Token'], csrf);
  assert.equal(calls[3].init.headers['X-CSRF-Token'], csrf);
  assert.equal(JSON.parse(calls[2].init.body).code, '00000000');
  assert.equal(JSON.parse(calls[3].init.body).code, '12345678');
  assert.equal(calls.length, 5);
});

test('state round trip preserves empty objects and numeric string map keys in JSON bytes', async () => {
  const sourceDataJson = '{"settings":{},"map":{"0":"x"}}';
  const beforeJson = '{"revision":0,"data":' + sourceDataJson + '}';
  const afterJson = '{"revision":1,"data":' + sourceDataJson + '}';
  const payload = value => new Response(value, {headers: {'content-type': 'application/json'}});
  let count = 0;
  const client = configured(async (url, init) => {
    assert.equal(url, '/api/v1/state/preferences'); count++;
    if (count === 1) { assert.equal(init.method, 'GET'); return payload(beforeJson); }
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"expected_revision":0,"data":' + sourceDataJson + '}');
    return payload(afterJson);
  });
  const before = await client.loadState('preferences');
  assert.equal(JSON.stringify(before.data), sourceDataJson);
  assert.equal(Array.isArray(before.data.settings), false); assert.equal(Array.isArray(before.data.map), false);
  assert.deepEqual(Object.keys(before.data.map), ['0']);
  const after = await client.saveState('preferences', before.revision, before.data);
  assert.equal(JSON.stringify(after), afterJson); assert.equal(JSON.stringify(after.data), sourceDataJson);
  assert.equal(count, 2);
});

test('malformed session shapes, identity, scopes and CSRF fail closed', async () => {
  const malformed = [null, [], {}, {...session(), authenticated: 'true'}, {...session(), user: null},
    {...session(), user: {id: 'student_demo'}}, {...session(), user: {...user, id: '../other'}},
    {...session(), csrf: 'a'.repeat(32)}, {...session(), csrf: 'x'.repeat(64)},
    {...session(), capabilities: {scopes: ['app']}}, {...session(), capabilities: [true]},
    {...session(false), capabilities: ['app']}];
  for (const payload of malformed) {
    const c = configured(async () => json(payload));
    await assert.rejects(c.refreshSession(), /Invalid session response/);
    assert.equal(c.user, null); assert.deepEqual(c.capabilities, []);
  }
  const absent = session(false); delete absent.user;
  assert.equal((await new PlatformClient({fetchImpl: async () => json(absent)}).refreshSession()).authenticated, false);
});

test('request-code requires exact safe response, including HTTP202 and no OTP leakage', async () => {
  const safe = {accepted: true, challenge_id: challenge, expires_in: 600};
  for (const payload of [null, {...safe, accepted: false}, {...safe, challenge_id: 'short'}, {...safe, expires_in: 300}, {...safe, code: '12345678'}]) {
    await assert.rejects(configured(async () => json(payload, 202)).requestCode(user.email), /Invalid code request response/);
  }
  await assert.rejects(configured(async () => json(safe, 200)).requestCode(user.email), /Invalid server response/);
});

test('invalid confirmation acknowledgement never triggers session refresh or accepts a token', async () => {
  for (const payload of [{authenticated: false}, {authenticated: true, cookie_token: 'forbidden'}, null]) {
    let calls = 0;
    const c = configured(async () => { calls++; return json(payload); });
    await assert.rejects(c.confirmCode(challenge, '12345678'), /Invalid code confirmation response/);
    assert.equal(calls, 1);
  }
});

test('invalid code/email inputs and backend-only route are rejected before fetch', async () => {
  let calls = 0; const c = configured(async () => { calls++; throw new Error('unexpected fetch'); });
  await assert.rejects(c.requestCode('bad email'), /Invalid email/);
  await assert.rejects(c.confirmCode('../challenge', '12345678'), /Invalid code confirmation/);
  await assert.rejects(c.confirmCode(challenge, '1234'), /Invalid code confirmation/);
  await assert.rejects(c.confirmCode(challenge, 12345678), /Invalid code confirmation/);
  await assert.rejects(c.request('/webhooks/hotmart', {method: 'POST', body: {}}), /Invalid API path/);
  await assert.rejects(c.request('/session', {method: 'DELETE'}), /Invalid API method/);
  assert.equal(calls, 0);
});

test('state reads require bounded structured data and nonnegative safe revision', async () => {
  for (const payload of [null, [], {revision: -1, data: {}}, {revision: 1.5, data: {}}, {revision: Number.MAX_SAFE_INTEGER + 1, data: {}},
    {revision: 0, data: null}, {revision: 0, data: 'text'}, {revision: 0, data: {text: 'x'.repeat(65536)}}]) {
    await assert.rejects(configured(async () => json(payload)).loadState('study'), /Invalid state response/);
  }
  assert.deepEqual(await configured(async () => json({revision: 0, data: []})).loadState('preferences'), {revision: 0, data: []});
  await assert.rejects(configured(async () => { throw new Error('unexpected fetch'); }).loadState('../other'), /Invalid state reference/);
});

test('state writes validate type, UTF-8 byte limit and revision before transport', async () => {
  let calls = 0; const c = configured(async () => { calls++; throw new Error('unexpected fetch'); });
  for (const value of [null, 1, 'text', {text: 'é'.repeat(32768)}]) await assert.rejects(c.saveState('study', 0, value), /Invalid state data/);
  await assert.rejects(c.saveState('unknown', 0, {}), /Invalid state reference/);
  await assert.rejects(c.saveState('study', -1, {}), /Invalid state reference/);
  await assert.rejects(c.request('/state/study', {method: 'POST', body: {x: 'x'.repeat(131072)}}), /Request body too large/);
  assert.equal(calls, 0);
});

test('missing and denied resources produce the same unavailable result without fallback', async () => {
  const errors = [];
  for (const message of ['not_found', 'denied']) {
    const c = configured(async () => json({error: message}, 404));
    await assert.rejects(c.resource('penta-page-1'), error => { errors.push(error.message); return error.message === 'Operation unavailable'; });
  }
  assert.equal(errors[0], errors[1]);
  await assert.rejects(configured(async () => json({}, 403)).loadState('study'), /Access denied/);
});

test('409 never retries or overwrites another device and malformed success is rejected', async () => {
  let calls = 0;
  const c = configured(async () => { calls++; return json({revision: 5, data: {private: true}}, 409); });
  await assert.rejects(c.saveState('study', 3, {}), /State changed/); assert.equal(calls, 1);
  await assert.rejects(configured(async () => json({ok: true})).saveState('study', 0, {}), /Invalid state response/);
});

test('revoked session aborts the active epoch and clears private capabilities', async () => {
  const c = configured(async () => json({}, 401)); const signal = c.controller.signal; const epoch = c.epoch;
  await assert.rejects(c.loadState('repertoire'), /Sign-in required/);
  assert.equal(signal.aborted, true); assert.equal(c.epoch, epoch + 1); assert.equal(c.user, null); assert.deepEqual(c.capabilities, []);
});

test('scope revocation from the same account invalidates an in-flight private response', async () => {
  let release;
  const c = configured(async url => url.endsWith('/session') ? json(session(true, [])) : new Promise(r => release = r));
  const pending = c.loadState('study');
  const next = await c.refreshSession(); assert.deepEqual(next.capabilities, []);
  release(json({revision: 1, data: {oldAccountState: true}}));
  await assert.rejects(pending, /Session changed/); assert.equal(c.user.id, user.id);
});

test('epoch check after delayed JSON decoding prevents old session restoration', async () => {
  let release; let bodyStarted;
  const started = new Promise(r => bodyStarted = r);
  const c = configured(async () => ({status: 200, ok: true, headers: new Headers({'content-type': 'application/json'}),
    json: () => { bodyStarted(); return new Promise(r => release = r); }}));
  const pending = c.refreshSession(); await started; c.clear(); release(session());
  await assert.rejects(pending, /Session changed/); assert.equal(c.user, null);
});

test('epoch check after delayed blob decoding prevents old protected bytes escaping', async () => {
  let release; let bodyStarted;
  const started = new Promise(r => bodyStarted = r);
  const c = configured(async () => ({status: 200, ok: true, headers: new Headers({'content-type': 'application/pdf'}),
    blob: () => { bodyStarted(); return new Promise(r => release = r); }}));
  const pending = c.resource('penta-page-1'); await started; c.clear(); release(new Blob(['private fixture']));
  await assert.rejects(pending, /Session changed/);
});

test('HTML or malformed logout response is not represented as successful logout', async () => {
  const html = configured(async () => new Response('<html>error</html>', {headers: {'content-type': 'text/html'}}));
  await assert.rejects(html.refreshSession(), /Invalid server response/);
  assert.equal(html.user, null);
  const c = configured(async () => json({signed_out: false}));
  await assert.rejects(c.logout(), /Invalid logout response/); assert.equal(c.user, null); assert.equal(c.csrf, null);
});
