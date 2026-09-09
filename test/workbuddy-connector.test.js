const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  buildConnectorFiles,
  packageConnector,
  assertSafeOutputDir
} = require("../scripts/package-workbuddy-connector.js");

test("WorkBuddy Connector files use the current package version and one Stdio MCP server", () => {
  const files = buildConnectorFiles({ version: "1.1.37" });
  const metadata = JSON.parse(files["connector-meta.json"]);
  const mcp = JSON.parse(files["mcp.json"]);

  assert.equal(metadata.source, "gecho-ai-bridge");
  assert.equal(metadata.type, "mcp");
  assert.equal(metadata.version, "1.1.37");
  assert.ok(Array.isArray(metadata.examples_zh));
  assert.ok(metadata.examples_zh.length >= 2);
  assert.ok(Array.isArray(metadata.examples_en));
  assert.ok(metadata.examples_en.length >= 2);
  assert.match(files["icon.svg"], /<svg width="512" height="512"/);
  assert.match(files["icon.svg"], /data:image\/png;base64,/);

  assert.deepEqual(Object.keys(mcp.mcpServers), ["gecho-bridge"]);
  const server = mcp.mcpServers["gecho-bridge"];
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "@gecho-ai/gecho-bridge@1.1.37"]);
  assert.deepEqual(server.runtime, { type: "node", version: "20" });
  assert.equal(server.npmRegistry, "https://registry.npmmirror.com");
  assert.equal(server.timeout, 600000);
});

test("WorkBuddy Connector package is rooted at the required files", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, "tmp/workbuddy-connector-test-"));
  const outputDir = path.join(tempRoot, "output");

  try {
    const result = packageConnector({ outputDir, version: "1.1.37" });
    assert.equal(fs.existsSync(result.archivePath), true);
    assert.ok(result.archiveSize > 0);

    const listing = execFileSync("unzip", ["-Z1", result.archivePath], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
    assert.ok(listing.includes("connector-meta.json"));
    assert.ok(listing.includes("mcp.json"));
    assert.ok(listing.includes("icon.svg"));
    assert.ok(listing.includes("skills/gecho-tiktok/SKILL.md"));
    assert.equal(listing.some((entry) => entry.startsWith("gecho-bridge/")), false);
    assert.equal(listing.some((entry) => entry.includes("_meta.json")), false);
    assert.equal(listing.some((entry) => entry.includes("publish.json")), false);
    assert.equal(listing.includes("icon.png"), false);

    const extracted = execFileSync("unzip", ["-p", result.archivePath, "mcp.json"], { encoding: "utf8" });
    const mcp = JSON.parse(extracted);
    assert.equal(mcp.mcpServers["gecho-bridge"].args[1], "@gecho-ai/gecho-bridge@1.1.37");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("WorkBuddy Connector packaging only permits dedicated temporary output directories", () => {
  const projectRoot = path.resolve(__dirname, "..");
  assert.equal(
    assertSafeOutputDir("tmp/workbuddy-connector"),
    path.join(projectRoot, "tmp/workbuddy-connector")
  );
  assert.equal(
    assertSafeOutputDir("tmp/workbuddy-connector-test/output"),
    path.join(projectRoot, "tmp/workbuddy-connector-test/output")
  );

  for (const unsafePath of [
    "tmp",
    "tmp/manual-skill-packages",
    "docs",
    ".git",
    "tmp/workbuddy-connector/../../.git"
  ]) {
    assert.throws(() => assertSafeOutputDir(unsafePath), /dedicated temporary directory/);
  }
});
