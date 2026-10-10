const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverBrowsers, browserLaunchSpec, createRecoveryGuard } = require("../desktop/browser-manager");

test("browser discovery reads profile labels without accepting traversal paths", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-browser-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "");
  const root = path.join(home, "Library/Application Support/Google/Chrome");
  fs.mkdirSync(path.join(root, "Default"), { recursive: true });
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: {
    Default: { name: "Personal" }, "../escape": { name: "Unsafe" }
  } } }));
  const browsers = discoverBrowsers({ platform: "darwin", home, systemApplications: path.join(home, "missing") });
  assert.equal(browsers.length, 1);
  assert.deepEqual(browsers[0].profiles, [{ id: "Default", name: "Personal" }]);
  const spec = browserLaunchSpec(browsers[0], "Default", "http://127.0.0.1:18793/onboarding");
  assert.ok(spec.args.includes("--profile-directory=Default"));
  assert.throws(() => browserLaunchSpec(browsers[0], "../escape", "https://evil.test"));
});

test("recovery waits for disconnect grace and caps attempts until a connection returns", async () => {
  let calls = 0;
  const guard = createRecoveryGuard({ launch: async () => { calls++; }, graceMs: 10, cooldownMs: 20, maxAttempts: 2 });
  await guard.tick({ connected: false, enabled: true, selected: true, now: 0 });
  await guard.tick({ connected: false, enabled: true, selected: true, now: 11 });
  await guard.tick({ connected: false, enabled: true, selected: true, now: 12 });
  await guard.tick({ connected: false, enabled: true, selected: true, now: 32 });
  await guard.tick({ connected: false, enabled: true, selected: true, now: 100 });
  assert.equal(calls, 2);
  await guard.tick({ connected: true, enabled: true, selected: true, now: 101 });
  await guard.tick({ connected: false, enabled: false, selected: true, now: 102 });
  assert.equal(calls, 2);
});
