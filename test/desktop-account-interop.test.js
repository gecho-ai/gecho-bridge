const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAccountClient } = require('../desktop/account-login');

test('desktop PKCE client interoperates with service-layer consent, refresh and revocation', {
  skip: !process.env.GECHO_DESKTOP_SERVICE_LAYER, timeout: 30000,
}, async (t) => {
  const directory = process.env.GECHO_DESKTOP_SERVICE_LAYER;
  const processHandle = spawn('python3', [path.join(directory, 'tests/helpers/desktop_auth_server.py')], {
    cwd: directory, env: { ...process.env, PYTHONPATH: directory }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => processHandle.kill());
  const port = await new Promise((resolve, reject) => {
    let output = '';
    processHandle.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/READY:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    processHandle.once('exit', code => reject(new Error(`Test backend exited: ${code}`)));
  });
  let saved, authorization, code;
  const root = `http://127.0.0.1:${port}/service_layer/desktop-auth`;
  const store = { load: () => saved, save: value => { saved = value; return true; }, clear: () => { saved = null; } };
  const client = createAccountClient({ baseUrl: root, store, openExternal: async url => { authorization = url; } });
  t.after(() => client.cancel());
  await client.login();
  const page = await fetch(authorization, { headers: { Cookie: 'token=test-website-cookie' } });
  assert.equal(page.status, 200);
  const ticket = (await page.text()).match(/name="ticket" value="([^"]+)"/)[1];
  const consent = await fetch(root + '/consent', { method: 'POST', redirect: 'manual',
    headers: { Origin: 'https://example.test', Cookie: 'token=test-website-cookie', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, decision: 'approve' }) });
  assert.equal(consent.status, 302);
  const callback = consent.headers.get('location');
  code = new URL(callback).searchParams.get('code');
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(client.status().user.id, 'interop-user');
  const replay = await fetch(root + '/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: 'gecho-desktop', code,
      redirect_uri: new URL(authorization).searchParams.get('redirect_uri'), code_verifier: 'x'.repeat(43) }) });
  assert.equal(replay.status, 400);
  const restored = createAccountClient({ baseUrl: root, store, openExternal: async () => {} });
  await restored.restore();
  const access = await restored.accessToken();
  assert.equal(restored.status().user.id, 'interop-user');
  await restored.logout();
  assert.equal((await fetch(root + '/me', { headers: { Authorization: `Bearer ${access}` } })).status, 401);
});
