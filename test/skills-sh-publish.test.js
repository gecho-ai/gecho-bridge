const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCommand,
  buildTargets,
  parseArgs
} = require("../scripts/publish-skills-sh.js");

test("skills.sh publisher lists both distribution locales", () => {
  const targets = buildTargets();

  assert.equal(targets.length, 30);
  assert.equal(targets.filter((target) => target.locale === "en").length, 15);
  assert.equal(targets.filter((target) => target.locale === "zh-CN").length, 15);
  assert.ok(targets.every((target) => target.sourceUrl.startsWith("https://github.com/")));
  assert.ok(targets.every((target) => !target.sourceUrl.endsWith("/SKILL.md")));
});

test("skills.sh publisher filters one locale and source slug", () => {
  const targets = buildTargets({
    locale: "zh-CN",
    skill: "tiktok-video-search"
  });

  assert.deepEqual(targets.map((target) => ({
    locale: target.locale,
    sourceSlug: target.sourceSlug,
    sourcePath: target.sourcePath,
    sourceUrl: target.sourceUrl
  })), [{
    locale: "zh-CN",
    sourceSlug: "tiktok-video-search",
    sourcePath: "distribution-skills-zh-CN/tiktok-video-search",
    sourceUrl: "https://github.com/gecho-ai/gecho-bridge/tree/main/distribution-skills-zh-CN/tiktok-video-search"
  }]);
});

test("skills.sh publisher parses non-interactive options", () => {
  const options = parseArgs([
    "dry-run",
    "--skill",
    "tiktok-video-search",
    "--locale",
    "en",
    "--agent",
    "codex",
    "--work-dir",
    "/tmp/skills-sh-test",
    "--continue-on-error"
  ]);

  assert.equal(options.mode, "dry-run");
  assert.equal(options.skill, "tiktok-video-search");
  assert.equal(options.locale, "en");
  assert.equal(options.agent, "codex");
  assert.equal(options.workDir, "/tmp/skills-sh-test");
  assert.equal(options.continueOnError, true);
});

test("skills.sh publisher builds a direct GitHub subdirectory install", () => {
  const target = buildTargets({
    skill: "tiktok-video-search",
    locale: "en"
  })[0];

  assert.deepEqual(buildCommand(target, { agent: "universal" }), {
    command: "npx",
    args: [
      "--yes",
      "skills",
      "add",
      target.sourceUrl,
      "--agent",
      "universal",
      "--copy",
      "--yes"
    ]
  });
});

test("skills.sh publisher rejects invalid filters", () => {
  assert.throws(() => parseArgs(["--locale", "fr"]), /locale must be/);
  assert.throws(() => parseArgs(["--agent", ""]), /requires a value/);
  assert.throws(() => buildTargets({ skill: "not-a-real-skill" }), /no distribution Skills matched/);
});
