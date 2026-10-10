const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fetchUpdateJson, downloadFile, safeUpdateUrl, safeAssetName, launchInstaller } = require("../desktop/update-transport");
const { EventEmitter } = require("node:events");

test("update transport rejects unsafe URLs and archive traversal names", () => {
  for (const url of ["http://example.com/a", "file:///tmp/a", "https://user:secret@example.com/a"]) assert.throws(() => safeUpdateUrl(url));
  assert.equal(safeUpdateUrl("https://github.com/a").hostname, "github.com");
  for (const name of ["../evil.exe", "..\\evil.exe", "/evil.exe"]) assert.throws(() => safeAssetName(name));
});

test("update transport follows relative redirects, bounds loops and rejects truncated downloads", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-updater-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/json" }); res.end(); }
    else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
    else if (req.url === "/truncated") { res.writeHead(200, { "content-length": 100 }); res.write("short"); setImmediate(() => res.destroy()); }
    else res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await fetchUpdateJson(`${base}/redirect`), { ok: true });
  await assert.rejects(fetchUpdateJson(`${base}/loop`), /redirect/i);
  await assert.rejects(downloadFile(`${base}/truncated`, path.join(dir, "installer")), /aborted|reset|premature/i);
  assert.equal(fs.existsSync(path.join(dir, "installer")), false);
});

test("installer launch failure never runs cleanup and macOS opening keeps app alive", async () => {
  let cleaned = false;
  await assert.rejects(launchInstaller("/tmp/Gecho.exe", { platform: "win32", spawnFn: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("launch failed"))); return child;
  }, cleanup: () => { cleaned = true; } }), /launch failed/);
  assert.equal(cleaned, false);
  const result = await launchInstaller("/tmp/Gecho.dmg", { platform: "darwin", openPath: async () => "" });
  assert.equal(result.shouldQuit, false);
  await assert.rejects(launchInstaller("/tmp/Gecho.dmg", { platform: "darwin", openPath: async () => "open failed" }), /open failed/);
});
