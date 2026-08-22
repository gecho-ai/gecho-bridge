const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildPublishOptions,
  buildTargets,
  stageSkills
} = require("../scripts/publish-clawhub-skills.js");

test("ClawHub targets include distinct English and Chinese identities", () => {
  const targets = buildTargets();
  const publishedSlugs = targets.map((target) => target.publishedSlug);

  assert.equal(targets.length, 30);
  assert.equal(new Set(publishedSlugs).size, publishedSlugs.length);

  const english = targets.find(
    (target) => target.locale === "en" && target.sourceSlug === "tiktok-insight"
  );
  const chinese = targets.find(
    (target) => target.locale === "zh-CN" && target.sourceSlug === "tiktok-insight"
  );

  assert.equal(english.publishedSlug, "tiktok-insight");
  assert.equal(english.displayName, "tiktok-insight");
  assert.equal(chinese.publishedSlug, "tiktok-insight-zh-cn");
  assert.equal(chinese.displayName, "TikTok 选品、趋势、竞品与内容洞察【Gecho 官方】");
});

test("ClawHub staging uses configured slugs and excludes platform metadata", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, "tmp/clawhub-publish-test-"));

  try {
    const sourcePath = path.join(projectRoot, "distribution-skills-zh-CN/tiktok-insight/SKILL.md");
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    const result = stageSkills({
      stageDir: tempRoot,
      skill: "tiktok-insight",
      locale: "zh-CN"
    });
    const stagedPath = path.join(tempRoot, "zh-CN/tiktok-insight-zh-cn/SKILL.md");

    assert.equal(result.targets.length, 1);
    assert.equal(fs.existsSync(stagedPath), true);
    assert.equal(
      fs.existsSync(path.join(tempRoot, "zh-CN/tiktok-insight-zh-cn/publish.json")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(tempRoot, "zh-CN/tiktok-insight-zh-cn/skillhub-publish.json")),
      false
    );
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceBefore);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ClawHub publish options carry the platform identity", () => {
  const target = buildTargets({ skill: "tiktok-insight", locale: "zh-CN" })[0];
  const options = buildPublishOptions(target, {
    owner: "gecho-ai",
    version: "1.1.37",
    tags: "latest"
  });

  assert.deepEqual(options, {
    slug: "tiktok-insight-zh-cn",
    name: "TikTok 选品、趋势、竞品与内容洞察【Gecho 官方】",
    owner: "gecho-ai",
    version: "1.1.37",
    tags: "latest"
  });
});
