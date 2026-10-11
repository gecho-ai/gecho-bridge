const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountClient } = require('../desktop/account-login');
const { createAccountStore } = require('../desktop/account-store');

test('account flow validates state, keeps secrets out of status, refreshes and revokes', async (t) => {
  let opened, verifier, revoked = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      const body = JSON.parse(raw); verifier = body.code_verifier || verifier;
      res.end(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 900, token_type: 'Bearer' }));
    } else if (req.url === '/me') res.end(JSON.stringify({ id: 'user-1' }));
    else { revoked = true; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let saved;
  const client = createAccountClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    openExternal: async (url) => { opened = new URL(url); },
    store: { load: () => null, save: data => { saved = data; return true; }, clear: () => { saved = null; } } });
  t.after(() => client.cancel());
  await client.login();
  const callback = new URL(opened.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: 'test-code', state: 'bad' }).toString();
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set('state', opened.searchParams.get('state'));
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(client.status().status, 'signedIn');
  assert.equal(client.status().user.id, 'user-1');
  assert.ok(verifier.length >= 43);
  assert.ok(saved.refreshToken);
  assert.ok(!JSON.stringify(client.status()).includes('secret'));
  const restored = createAccountClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    openExternal: async () => {}, store: { load: () => saved, save: () => true, clear: () => {} } });
  await restored.restore();
  assert.equal(restored.status().status, 'signedIn');
  await restored.logout();
  assert.equal(restored.status().status, 'signedOut');
  assert.equal(revoked, true);
});

test('account cancellation closes listener and unsafe URL cannot be configured', async () => {
  let opened;
  assert.throws(() => createAccountClient({ baseUrl: 'http://example.test', store: {}, openExternal: () => {} }));
  const client = createAccountClient({ baseUrl: 'https://example.test/service_layer/desktop-auth',
    store: { load: () => null }, openExternal: async url => { opened = new URL(url); } });
  await client.login();
  client.cancel();
  assert.equal(client.status().status, 'signedOut');
  await assert.rejects(fetch(opened.searchParams.get('redirect_uri')));
});

test('account store never falls back to plaintext storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gecho-account-test-'));
  try {
    const store = createAccountStore(dir, { isEncryptionAvailable: () => false });
    assert.equal(store.save({ refreshToken: 'test-secret' }), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transient identity outage retains the rotated refresh credential', async (t) => {
  let saved, opened, count = 0, revoked = false;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    if (req.url === '/token') {
      count += 1;
      res.end(JSON.stringify({ access_token: `access-${count}`, refresh_token: `refresh-${count}`, expires_in: 1, token_type: 'Bearer' }));
    } else if (req.url === '/me' && count === 2) { res.writeHead(503); res.end('{}'); }
    else if (req.url === '/me') res.end('{"id":"user-1"}');
    else { revoked = true; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const store = { load: () => saved, save: data => { saved = data; return true; }, clear: () => { saved = null; } };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createAccountClient({ baseUrl, store, openExternal: async url => { opened = new URL(url); } });
  t.after(() => client.cancel());
  await client.login();
  const callback = new URL(opened.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: opened.searchParams.get('state'), code: 'test-code' }).toString();
  await fetch(callback);
  await assert.rejects(client.accessToken());
  assert.equal(saved.refreshToken, 'refresh-2');
  assert.equal(revoked, false);
  const restored = createAccountClient({ baseUrl, store, openExternal: async () => {} });
  await restored.restore();
  assert.equal(restored.status().status, 'signedIn');
  assert.equal(saved.refreshToken, 'refresh-3');
});
