const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("MCP must not stop an incompatible service owned by the desktop", { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-mcp-owner-"));
  let child, shutdowns = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/shutdown") { shutdowns++; child.kill(); }
    res.end(JSON.stringify({ status: "ok", serviceProtocolVersion: 2, packageVersion: "0.0.1", dataDir: dir, runtime: "desktop" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { child?.kill(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const args of [["mcp-client.js"], ["bridge-service.js", "start"]]) {
    child = spawn(process.execPath, [path.join(__dirname, "..", args[0]), ...args.slice(1)], {
      env: { ...process.env, GECHO_HTTP_PORT: String(server.address().port), GECHO_DATA_DIR: dir }, stdio: "ignore",
    });
    await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  }
  assert.equal(shutdowns, 0);
});
