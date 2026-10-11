const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("desktop runtime: isolated IPC, diagnostics, preferences, theme and renderer lifecycle", { skip: process.env.GECHO_DESKTOP_RUNTIME_TEST !== "1", timeout: 45000 }, async (t) => {
  const { _electron } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-desktop-runtime-"));
  const server = http.createServer((_req, res) => res.end("[]"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const application = await _electron.launch({
    args: [path.join(__dirname, "helpers/desktop-runtime-entry.js")],
    env: { ...process.env, GECHO_TEST_USER_DATA_DIR: dir, GECHO_DATA_DIR: dir,
      GECHO_HTTP_PORT: String(await freePort()), GECHO_WS_PORT: String(await freePort()),
      GECHO_AUTO_LAUNCH_BROWSER: "0", GECHO_UPDATE_FEED_URL: `http://127.0.0.1:${server.address().port}` },
  });
  t.after(async () => { await application.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await application.evaluate(async ({ app }) => { await app.whenReady(); app.emit("second-instance"); });
  const window = await application.firstWindow();
  const errors = [];
  window.on("pageerror", (error) => errors.push(error.message));
  await window.waitForSelector("#version");
  await window.waitForFunction(() => /Gecho Desktop \d+\./.test(document.querySelector("#version").textContent));
  await window.waitForFunction(() => document.querySelector('#account-status').textContent.includes('not configured'));
  assert.equal(await window.locator('#account-login').isDisabled(), true);
  await window.locator("#health-check-btn").click();
  await window.waitForFunction(() => document.querySelectorAll("#health-results li").length >= 4);
  assert.ok((await window.locator("#health-results").innerText()).includes("Bridge 运行正常"));
  await window.locator("#desktop-notifications").uncheck();
  await window.waitForFunction(() => document.querySelector("#system-feedback").textContent.includes("Saved"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "desktop-preferences.json"), "utf8")).notifications, false);
  await window.emulateMedia({ colorScheme: "dark" });
  assert.equal(await window.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(22, 24, 32)");
  assert.equal(await window.locator(".task-meta-grid").first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(28, 31, 40)");
  assert.equal(await window.locator("#update-action-wrap").isVisible(), false);
  const output = path.join(__dirname, "../tmp/desktop-verification");
  fs.mkdirSync(output, { recursive: true });
  await window.screenshot({ path: path.join(output, "control-panel-dark.png"), fullPage: true });
  await window.emulateMedia({ colorScheme: "light" });
  await window.screenshot({ path: path.join(output, "control-panel-light.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await window.locator("#hide").click();
  await application.evaluate(async ({ BrowserWindow }) => {
    for (let i = 0; i < 20 && BrowserWindow.getAllWindows().length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  await application.evaluate(({ app }) => app.emit("second-instance"));
  const reopened = await application.firstWindow();
  await reopened.waitForSelector("#version");
});

test('desktop account UI: authorize, callback, session-only warning and sign out', {
  skip: process.env.GECHO_DESKTOP_RUNTIME_TEST !== '1', timeout: 45000,
}, async (t) => {
  const { _electron } = require('playwright-core');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gecho-account-runtime-'));
  let revoked = false;
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain synthetic test request */ }
    if (req.url === '/token') res.end(JSON.stringify({ access_token: 'runtime-access', refresh_token: 'runtime-refresh', token_type: 'Bearer', expires_in: 900 }));
    else if (req.url === '/me') res.end('{"id":"runtime-user"}');
    else if (req.url === '/revoke') { revoked = true; res.end('{}'); }
    else res.end('[]');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}`;
  const application = await _electron.launch({ args: [path.join(__dirname, 'helpers/desktop-runtime-entry.js')],
    env: { ...process.env, GECHO_TEST_USER_DATA_DIR: directory, GECHO_DATA_DIR: directory,
      GECHO_HTTP_PORT: String(await freePort()), GECHO_WS_PORT: String(await freePort()),
      GECHO_AUTO_LAUNCH_BROWSER: '0', GECHO_UPDATE_FEED_URL: baseUrl, GECHO_ACCOUNT_AUTH_URL: baseUrl } });
  t.after(async () => { await application.close(); provider.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await application.evaluate(async ({ app, shell, safeStorage }) => {
    await app.whenReady();
    // Keep tests off personal browser sessions and OS credential storage.
    shell.openExternal = async url => { global.__syntheticAuthorizationUrl = url; };
    safeStorage.isEncryptionAvailable = () => false;
    app.emit('second-instance');
  });
  const window = await application.firstWindow();
  const errors = [];
  window.on('pageerror', error => errors.push(error.message));
  await window.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed out'));
  await window.locator('#account-login').click();
  await window.waitForFunction(() => document.querySelector('#account-login').textContent.includes('Continue'));
  const authorization = new URL(await application.evaluate(() => global.__syntheticAuthorizationUrl));
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: 'runtime-code', state: authorization.searchParams.get('state') }).toString();
  assert.equal((await fetch(callback)).status, 200);
  await window.waitForFunction(() => document.querySelector('#account-status').textContent.includes('runtime-user'));
  assert.ok((await window.locator('#account-status').innerText()).includes('This session only'));
  assert.equal(await window.locator('#account-login').isVisible(), false);
  await window.locator('#account-logout').click();
  await window.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed out'));
  assert.equal(revoked, true);
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(path.join(directory, 'desktop-account.bin')), false);
});
