const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAccountAuthUrl } = require('../desktop/account-config');

test('account configuration uses packaged metadata but permits explicit overrides', () => {
  assert.equal(resolveAccountAuthUrl({}, {}), null);
  assert.equal(resolveAccountAuthUrl({}, { desktopAccountAuthUrl: 'https://example.test/auth' }), 'https://example.test/auth');
  assert.equal(resolveAccountAuthUrl({ GECHO_ACCOUNT_AUTH_URL: 'http://127.0.0.1:1234' },
    { desktopAccountAuthUrl: 'https://example.test/auth' }), 'http://127.0.0.1:1234');
});

test('desktop builds include the official same-origin authorization endpoint', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.build.extraMetadata.desktopAccountAuthUrl, 'https://www.gecho.ai/service_layer/desktop-auth');
});
