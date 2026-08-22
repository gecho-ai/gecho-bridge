const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listDistributionSkills,
  loadPlatformRegistry,
  resolvePlatformTarget
} = require("../scripts/publish-config.js");

test("every distribution Skill has platform-specific publish identity", () => {
  const skills = listDistributionSkills();
  const platforms = ["clawhub", "tencent-skillhub", "aily-skillhub", "modelscope"];
  const registry = loadPlatformRegistry();

  assert.equal(skills.length, 30);
  for (const platform of platforms) {
    assert.ok(registry.platforms[platform]);
    const slugs = new Set();
    for (const skill of skills) {
      const target = resolvePlatformTarget(skill.directory, platform);
      assert.ok(target.slug, `${skill.directory}: missing ${platform} slug`);
      assert.ok(target.displayName, `${skill.directory}: missing ${platform} displayName`);
      assert.equal(target.sourceSlug, skill.sourceSlug);
      assert.ok(!slugs.has(target.slug), `${platform}: duplicate slug ${target.slug}`);
      slugs.add(target.slug);
    }
  }
});

test("Tencent Chinese identity follows the existing SkillHub publication", () => {
  const target = resolvePlatformTarget(
    "distribution-skills-zh-CN/tiktok-insight",
    "tencent-skillhub"
  );

  assert.equal(target.slug, "gecho-tiktok-insight");
  assert.equal(target.displayName, "TikTok 选品、趋势、竞品与内容洞察【Gecho 官方】");
  assert.equal(target.mode, "update");
});

test("Aily SkillHub mirrors Tencent SkillHub identity configuration", () => {
  for (const skill of listDistributionSkills()) {
    const tencent = resolvePlatformTarget(skill.directory, "tencent-skillhub");
    const aily = resolvePlatformTarget(skill.directory, "aily-skillhub");
    assert.deepEqual(
      { slug: aily.slug, displayName: aily.displayName, mode: aily.mode },
      { slug: tencent.slug, displayName: tencent.displayName, mode: tencent.mode }
    );
  }
});

test("ModelScope uses the public owner namespace and Chinese suffix", () => {
  const registry = loadPlatformRegistry();
  assert.equal(registry.platforms.modelscope.namespace, "Gecho");
  assert.equal(registry.platforms.modelscope.developer, "gecho-ai");

  const target = resolvePlatformTarget(
    "distribution-skills-zh-CN/tiktok-insight",
    "modelscope"
  );

  assert.equal(target.namespace, "Gecho");
  assert.equal(target.slug, "tiktok-insight-gecho");
  assert.equal(target.displayName, "TikTok 选品、趋势、竞品与内容洞察【Gecho 官方】");
});

test("confirmed English registry identities keep their remote display names", () => {
  for (const sourceSlug of [
    "tiktok-influencer",
    "tiktok-insight",
    "tiktok-search",
    "tiktok-video-search"
  ]) {
    const target = resolvePlatformTarget(`distribution-skills/${sourceSlug}`, "clawhub");
    assert.equal(target.displayName, sourceSlug);

    const modelScopeTarget = resolvePlatformTarget(
      `distribution-skills/${sourceSlug}`,
      "modelscope"
    );
    assert.equal(modelScopeTarget.displayName, sourceSlug);
  }
});

test("Tencent Chinese updates keep the existing tiktok-search display name", () => {
  const target = resolvePlatformTarget(
    "distribution-skills-zh-CN/tiktok-search",
    "tencent-skillhub"
  );

  assert.equal(
    target.displayName,
    "TikTok 全链路调研：爆款视频搜索、达人采集、选品、趋势、竞品与内容洞察【Gecho 官方】"
  );
  assert.equal(target.slug, "gecho-tiktok-search");
});

test("Tencent English identity is distinct from the existing Chinese identity", () => {
  const target = resolvePlatformTarget(
    "distribution-skills/tiktok-insight",
    "tencent-skillhub"
  );

  assert.equal(target.slug, "tiktok-insight-en");
  assert.equal(target.displayName, "TikTok Insight by Gecho");
  assert.equal(target.mode, "create");
});
