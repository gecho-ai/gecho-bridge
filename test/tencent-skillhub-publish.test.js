const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildTargets,
  buildEnterpriseRequest,
  detectPublishMode,
  publishEnterpriseTarget,
  resolvePublishOptions,
  stageSkills,
  upsertFrontmatter
} = require("../scripts/publish-tencent-skillhub.js");

test("Tencent publish mode distinguishes team API keys from community sessions", () => {
  assert.equal(detectPublishMode("sk-ent-example"), "enterprise");
  assert.equal(detectPublishMode("skh_example"), "community");
  assert.equal(detectPublishMode(""), "session");
});

test("saved enterprise credentials select the team publishing path", () => {
  const resolved = resolvePublishOptions({
    mode: "publish",
    host: "https://api.skillhub.cn",
    key: null,
    orgId: null
  }, {
    key: "sk-ent-example",
    orgId: "12345"
  });

  assert.equal(resolved.key, "sk-ent-example");
  assert.equal(resolved.orgId, "12345");
  assert.equal(resolved.credentialSource, "stored");
});

test("explicit community mode does not reuse a saved enterprise credential", () => {
  const resolved = resolvePublishOptions({
    mode: "publish",
    host: "https://api.skillhub.cn",
    key: null,
    orgId: null,
    community: true
  }, {
    key: "sk-ent-example",
    orgId: "12345"
  });

  assert.equal(resolved.key, null);
  assert.equal(resolved.credentialSource, undefined);
});

test("existing team Skills publish a version instead of creating a new slug", () => {
  const target = {
    publishedSlug: "gecho-tiktok-video-search",
    displayName: "TikTok 爆款视频搜索、数据采集与达人发现【Gecho 官方】",
    version: "1.1.37"
  };

  assert.deepEqual(
    buildEnterpriseRequest(target, "org-5hp80lfg", true, {
      summary: "通过 Gecho Bridge MCP 搜索 TikTok 视频。",
      changelog: "更新测试"
    }),
    {
      method: "POST",
      path: "/api/v1/orgs/org-5hp80lfg/skills/gecho-tiktok-video-search/versions",
      payload: {
        version: "1.1.37",
        displayName: "TikTok 爆款视频搜索、数据采集与达人发现【Gecho 官方】",
        summary: "通过 Gecho Bridge MCP 搜索 TikTok 视频。",
        changelog: "更新测试"
      }
    }
  );
});

test("new team Skills publish through the team creation endpoint", () => {
  const target = {
    publishedSlug: "tiktok-video-search-en",
    displayName: "TikTok Video Search by Gecho",
    version: "1.1.37"
  };

  assert.deepEqual(
    buildEnterpriseRequest(target, "org-5hp80lfg", false, {
      summary: "Search TikTok videos by keyword.",
      changelog: "Initial team publication"
    }),
    {
      method: "POST",
      path: "/api/v1/orgs/org-5hp80lfg/skills",
      payload: {
        slug: "tiktok-video-search-en",
        displayName: "TikTok Video Search by Gecho",
        version: "1.1.37",
        summary: "Search TikTok videos by keyword.",
        changelog: "Initial team publication",
        tags: []
      }
    }
  );
});

test("enterprise publishing updates an existing Skill with payload and files", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tencent-skillhub-enterprise-"));
  const stagePath = path.join(projectRoot, "zh-CN", "demo");
  fs.mkdirSync(path.join(stagePath, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(stagePath, "SKILL.md"),
    "---\nname: demo\ndescription: Demo team Skill summary\n---\n\n# Demo\n"
  );
  fs.writeFileSync(path.join(stagePath, "references", "guide.md"), "Guide\n");

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") {
      return new Response(JSON.stringify({
        slug: "demo",
        version: "1.1.36",
        skill: { categories: [{ id: 7, displayNameZh: "数据分析" }] }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ slug: "demo", version: "1.1.37", status: "pending" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const result = await publishEnterpriseTarget({
      publishedSlug: "demo",
      displayName: "Demo team Skill",
      version: "1.1.37",
      mode: "update-or-create",
      stagePath: path.relative(projectRoot, stagePath)
    }, {
      host: "https://skillhub.test",
      key: "sk-ent-example",
      orgId: "org-test",
      projectRoot,
      changelog: "Update team Skill",
      fetchImpl
    });

    assert.equal(result.existing, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://skillhub.test/api/v1/orgs/org-test/skills/demo");
    assert.equal(calls[1].url, "https://skillhub.test/api/v1/orgs/org-test/skills/demo/versions");
    assert.equal(calls[1].init.headers.Authorization, "Bearer sk-ent-example");

    const form = calls[1].init.body;
    const payload = JSON.parse(form.get("payload"));
    assert.deepEqual(payload, {
      version: "1.1.37",
      displayName: "Demo team Skill",
      summary: "Demo team Skill summary",
      changelog: "Update team Skill",
      categoryIds: [7]
    });
    const uploadedFiles = form.getAll("files");
    assert.deepEqual(uploadedFiles.map((file) => file.name).sort(), ["SKILL.md", "references/guide.md"]);
    assert.equal(await uploadedFiles.find((file) => file.name === "SKILL.md").text(),
      "---\nname: demo\ndescription: Demo team Skill summary\n---\n\n# Demo\n");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("enterprise publishing derives the org ID from the enterprise key", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tencent-skillhub-verify-"));
  const stagePath = path.join(projectRoot, "en", "demo");
  fs.mkdirSync(stagePath, { recursive: true });
  fs.writeFileSync(path.join(stagePath, "SKILL.md"), "---\ndescription: Demo\n---\n\n# Demo\n");

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/registry/verify")) {
      return new Response(JSON.stringify({ orgId: 12345, orgOrgId: "org-test" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (init.method === "GET") return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ slug: "demo-en", version: "1.1.37" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const result = await publishEnterpriseTarget({
      publishedSlug: "demo-en",
      displayName: "Demo team Skill EN",
      version: "1.1.37",
      mode: "create",
      categoryIds: [42],
      stagePath: path.relative(projectRoot, stagePath)
    }, {
      host: "https://skillhub.test",
      key: "sk-ent-example",
      projectRoot,
      fetchImpl
    });

    assert.equal(result.orgId, "12345");
    assert.equal(calls[0].url, "https://skillhub.test/api/v1/registry/verify");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ent-example");
    assert.equal(calls[1].url, "https://skillhub.test/api/v1/orgs/12345/skills/demo-en");
    assert.equal(calls[2].url, "https://skillhub.test/api/v1/orgs/12345/skills");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("new enterprise Skills fail before upload when team categories are missing", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tencent-skillhub-category-"));
  const stagePath = path.join(projectRoot, "en", "demo");
  fs.mkdirSync(stagePath, { recursive: true });
  fs.writeFileSync(path.join(stagePath, "SKILL.md"), "---\ndescription: Demo\n---\n\n# Demo\n");

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/skills/demo")) return new Response(null, { status: 404 });
    if (url.endsWith("/categories")) {
      return new Response(JSON.stringify({ categories: [{ id: 9, displayNameZh: "数据分析" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ slug: "demo" }), { status: 201 });
  };

  await assert.rejects(
    publishEnterpriseTarget({
      publishedSlug: "demo",
      displayName: "Demo team Skill",
      version: "1.1.37",
      mode: "create",
      stagePath: path.relative(projectRoot, stagePath)
    }, {
      host: "https://skillhub.test",
      key: "sk-ent-example",
      orgId: "org-test",
      projectRoot,
      fetchImpl
    }),
    /requires category IDs: demo; available categories: 数据分析=9/
  );
  assert.equal(calls.some(({ init }) => init.method === "POST"), false);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("Tencent SkillHub target slugs are unique across English and Chinese skills", () => {
  const targets = buildTargets();
  const publishedSlugs = targets.map((target) => target.publishedSlug);

  assert.equal(targets.length, 30);
  assert.equal(new Set(publishedSlugs).size, publishedSlugs.length);
  assert.equal(
    targets.find((target) => target.locale === "en" && target.sourceSlug === "tiktok-insight").publishedSlug,
    "tiktok-insight-en"
  );
  assert.equal(
    targets.find((target) => target.locale === "zh-CN" && target.sourceSlug === "tiktok-insight").publishedSlug,
    "gecho-tiktok-insight"
  );
});

test("Tencent frontmatter fields are added without changing the skill body", () => {
  const source = "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n\nBody\n";
  const staged = upsertFrontmatter(source, {
    slug: "demo-zh-cn",
    version: "1.1.37",
    displayName: "演示技能"
  });

  assert.match(staged, /^---\nslug: "demo-zh-cn"\nversion: "1.1.37"\ndisplayName: "演示技能"\n/);
  assert.ok(staged.endsWith("# Demo\n\nBody\n"));
  assert.equal(source, "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n\nBody\n");
});

test("staging writes unique copies and leaves the source frontmatter unchanged", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, "tmp/tencent-skillhub-test-"));

  try {
    const sourcePath = path.join(projectRoot, "distribution-skills-zh-CN/tiktok-insight/SKILL.md");
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    const result = stageSkills({
      stageDir: path.join(tempRoot, "stage"),
      skill: "tiktok-insight",
      locale: "zh-CN"
    });
    const stagedPath = path.join(tempRoot, "stage/zh-CN/gecho-tiktok-insight/SKILL.md");
    const staged = fs.readFileSync(stagedPath, "utf8");

    assert.equal(result.targets.length, 1);
    assert.match(staged, /^slug: "gecho-tiktok-insight"/m);
    assert.match(staged, /^version: "1.1.37"/m);
    assert.equal(fs.existsSync(path.join(tempRoot, "stage/zh-CN/gecho-tiktok-insight/publish.json")), false);
    assert.equal(fs.existsSync(path.join(tempRoot, "stage/zh-CN/gecho-tiktok-insight/skillhub-publish.json")), false);
    assert.notEqual(staged, sourceBefore);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceBefore);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
