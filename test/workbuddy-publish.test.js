const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildTargets,
  packageSkills,
  stageSkills,
  upsertWorkbuddyFrontmatter
} = require("../scripts/publish-workbuddy-skills.js");

test("WorkBuddy target keeps a distinct stable identity and bilingual metadata", () => {
  const targets = buildTargets({
    skill: "tiktok-video-search",
    locale: "zh-CN",
    version: "1.1.37"
  });

  assert.equal(targets.length, 1);
  assert.deepEqual(
    {
      sourceSlug: targets[0].sourceSlug,
      locale: targets[0].locale,
      publishedSlug: targets[0].publishedSlug,
      displayName: targets[0].displayName,
      displayNameEn: targets[0].displayNameEn,
      author: targets[0].author,
      category: targets[0].category,
      version: targets[0].version
    },
    {
      sourceSlug: "tiktok-video-search",
      locale: "zh-CN",
      publishedSlug: "gecho-tiktok-video-search",
      displayName: "TikTok 爆款视频搜索、数据采集与达人发现【Gecho 官方】",
      displayNameEn: "TikTok Video Search by Gecho",
      author: "Gecho AI",
      category: undefined,
      version: "1.1.37"
    }
  );
});

test("WorkBuddy frontmatter adds required bilingual fields without changing the body", () => {
  const source = [
    "---",
    "name: demo",
    "description: 中文说明",
    "---",
    "",
    "# Demo",
    "",
    "Body",
    ""
  ].join("\n");

  const staged = upsertWorkbuddyFrontmatter(source, {
    name: "gecho-demo",
    display_name: "演示技能",
    display_name_en: "Demo Skill",
    description: "中文说明",
    description_zh: "中文说明",
    description_en: "English description",
    version: "1.1.37",
    author: "Gecho AI"
  });

  assert.match(staged, /^name: "gecho-demo"\n/m);
  assert.match(staged, /^display_name: "演示技能"\n/m);
  assert.match(staged, /^description_en: "English description"\n/m);
  assert.ok(staged.endsWith("# Demo\n\nBody\n"));
  assert.equal(source.includes("display_name:"), false);
});

test("WorkBuddy staging excludes platform metadata and leaves source unchanged", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, "tmp/workbuddy-publish-test-"));
  const sourcePath = path.join(projectRoot, "distribution-skills-zh-CN/tiktok-video-search/SKILL.md");

  try {
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    const result = stageSkills({
      stageDir: path.join(tempRoot, "stage"),
      skill: "tiktok-video-search",
      locale: "zh-CN",
      version: "1.1.37"
    });
    const stagedPath = path.join(tempRoot, "stage/zh-CN/skills/gecho-tiktok-video-search/SKILL.md");

    assert.equal(result.targets.length, 1);
    assert.equal(fs.existsSync(stagedPath), true);
    assert.equal(fs.existsSync(path.join(tempRoot, "stage/zh-CN/skills/gecho-tiktok-video-search/publish.json")), false);
    assert.equal(fs.existsSync(path.join(tempRoot, "stage/zh-CN/skills/gecho-tiktok-video-search/_meta.json")), false);
    assert.match(fs.readFileSync(stagedPath, "utf8"), /^display_name: /m);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceBefore);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("WorkBuddy packaging follows skills/<skill-name>/SKILL.md", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, "tmp/workbuddy-package-test-"));

  try {
    const result = packageSkills({
      stageDir: path.join(tempRoot, "stage"),
      skill: "tiktok-video-search",
      locale: "zh-CN",
      version: "1.1.37"
    });
    const archivePath = path.join(tempRoot, "stage", "archives", "tiktok-video-search-zh-CN-v1.1.37.zip");
    const listing = require("node:child_process")
      .execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);

    assert.equal(result.targets.length, 1);
    assert.equal(fs.existsSync(archivePath), true);
    assert.ok(listing.includes("skills/gecho-tiktok-video-search/SKILL.md"));
    assert.equal(listing.includes("SKILL.md"), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
