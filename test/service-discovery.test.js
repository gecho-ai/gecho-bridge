const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getServiceBaseUrl, publishServiceEndpoint, removeServiceEndpoint, isBridgeInfo, getServiceEnvironment } = require("../service-discovery");

test("service discovery honors explicit port and restricts metadata to loopback integer ports", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-endpoint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(getServiceBaseUrl({ dataDir: dir }), "http://127.0.0.1:18793");
  publishServiceEndpoint({ dataDir: dir, port: 18795, pid: 100 });
  assert.equal(getServiceEnvironment({ dataDir: dir, env: { CUSTOM: "preserved" } }).GECHO_HTTP_PORT, "18795");
  assert.equal(getServiceBaseUrl({ dataDir: dir }), "http://127.0.0.1:18795");
  assert.equal(getServiceBaseUrl({ dataDir: dir, port: "19000" }), "http://127.0.0.1:19000");
  removeServiceEndpoint({ dataDir: dir, pid: 101 });
  assert.equal(getServiceBaseUrl({ dataDir: dir }), "http://127.0.0.1:18795");
  removeServiceEndpoint({ dataDir: dir, pid: 100 });
  assert.equal(getServiceBaseUrl({ dataDir: dir }), "http://127.0.0.1:18793");
  assert.equal(isBridgeInfo({ status: "ok" }), false);
  assert.equal(isBridgeInfo({ status: "ok", serviceProtocolVersion: 2, packageVersion: "1.1.38" }), true);
});
