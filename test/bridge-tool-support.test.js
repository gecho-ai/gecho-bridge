const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const mcpClientSource = fs.readFileSync(path.join(projectRoot, "mcp-client.js"), "utf8");
const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

test("YouTube Shorts and Facebook Reels are public Bridge tools", () => {
  const supportedMatch = mcpClientSource.match(
    /const SUPPORTED_TOOL_NAMES = new Set\(\[([\s\S]*?)\]\);/
  );
  assert.ok(supportedMatch, "SUPPORTED_TOOL_NAMES should be declared");
  assert.match(supportedMatch[1], /"youtube_shorts_search"/);
  assert.match(supportedMatch[1], /"facebook_reels_search"/);

  for (const toolName of ["youtube_shorts_search", "facebook_reels_search"]) {
    const toolStart = mcpClientSource.indexOf(`name: "${toolName}"`);
    assert.notEqual(toolStart, -1, `${toolName} should have a ListTools entry`);
    const nextToolStart = mcpClientSource.indexOf('\n        name: "', toolStart + 1);
    const toolText = mcpClientSource.slice(
      toolStart,
      nextToolStart === -1 ? undefined : nextToolStart
    );
    assert.match(toolText, /`?query`?/);
    assert.match(toolText, /collectionMode/);
    assert.match(toolText, /resultLimit/);
    assert.match(toolText, /targetCount/);
    assert.match(toolText, /default:\s*200/);
    assert.match(toolText, /maximum:\s*200/);
    assert.match(toolText, /save_dir/);
  }
});

test("new platform routes point browser onboarding at the correct sites", () => {
  assert.match(serverSource, /youtube_shorts_search[\s\S]{0,180}youtube\.com/);
  assert.match(serverSource, /facebook_reels_search[\s\S]{0,180}facebook\.com/);
});

test("npm package includes both localized distribution Skill roots", () => {
  assert.ok(packageJson.files.includes("distribution-skills"));
  assert.ok(packageJson.files.includes("distribution-skills-zh-CN"));
});

test("action result envelopes preserve metadata and distinguish hard failures", () => {
  const {
    createActionResultEnvelope,
    isHardActionResultFailure,
    normalizeActionResult
  } = require(path.join(projectRoot, "action-result.js"));

  const partial = createActionResultEnvelope({
    data: [{ id: "1" }],
    meta: { status: "partial", reason: "detail_failed" },
    errorCode: "DETAIL_PARTIAL",
    errorMessage: "部分详情失败"
  });
  assert.deepEqual(partial, {
    data: [{ id: "1" }],
    meta: { status: "partial", reason: "detail_failed" },
    errorCode: "DETAIL_PARTIAL",
    errorMessage: "部分详情失败"
  });
  assert.equal(isHardActionResultFailure(partial), false);

  const failed = createActionResultEnvelope({
    data: [],
    meta: { status: "empty", reason: "not_logged_in" },
    errorCode: "NOT_LOGGED_IN",
    errorMessage: "请先登录"
  });
  assert.equal(isHardActionResultFailure(failed), true);

  assert.deepEqual(normalizeActionResult([{ id: "legacy" }]), {
    data: [{ id: "legacy" }]
  });
});
