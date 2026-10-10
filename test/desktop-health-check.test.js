const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const { runHealthChecks } = require("../desktop/health-check");

test("health checks reject unrelated HTTP services and do not probe external sites by default", async (t) => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ status: "ok", extensionConnected: true })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const results = await runHealthChecks({ servicePort: server.address().port, dataDir: os.tmpdir() });
  assert.notEqual(results.find((x) => x.id === "bridge-service").status, "ok");
  assert.notEqual(results.find((x) => x.id === "extension-handshake").status, "ok");
  assert.equal(results.some((x) => x.id.startsWith("connectivity-")), false);
});

test("health checks recognize the Bridge protocol and connected extension", async (t) => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ status: "ok", serviceProtocolVersion: 1, packageVersion: "1.1.38", extensionConnected: true })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const results = await runHealthChecks({ servicePort: server.address().port, dataDir: os.tmpdir() });
  assert.equal(results.find((x) => x.id === "bridge-service").status, "ok");
  assert.equal(results.find((x) => x.id === "extension-handshake").status, "ok");
});
