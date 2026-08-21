const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildTargets,
  decideAction,
  publishTarget,
  stageSkills
} = require("../scripts/publish-modelscope-skills.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

test("ModelScope targets use the configured owner and unique skill names", () => {
  const targets = buildTargets();
  const skillNames = targets.map((target) => target.skillName);

  assert.equal(targets.length, 30);
  assert.equal(new Set(skillNames).size, skillNames.length);
  assert.ok(targets.every((target) => target.owner === "Gecho"));

  const english = targets.find(
    (target) => target.locale === "en" && target.sourceSlug === "tiktok-insight"
  );
  const chinese = targets.find(
    (target) => target.locale === "zh-CN" && target.sourceSlug === "tiktok-insight"
  );

  assert.equal(english.skillName, "tiktok-insight");
  assert.equal(chinese.skillName, "tiktok-insight-gecho");
  assert.equal(english.category, "marketing-seo");
  assert.equal(english.license, "MIT License");
});

test("ModelScope staging injects version and excludes repository metadata", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const stageDir = fs.mkdtempSync(path.join(projectRoot, "tmp/modelscope-publish-test-"));

  try {
    const sourcePath = path.join(projectRoot, "distribution-skills-zh-CN/tiktok-insight/SKILL.md");
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    const result = stageSkills({
      stageDir,
      skill: "tiktok-insight",
      locale: "zh-CN"
    });
    const target = result.targets[0];
    const stagedSkillPath = path.join(stageDir, "zh-CN", target.skillName, "SKILL.md");

    assert.equal(result.targets.length, 1);
    assert.equal(fs.existsSync(stagedSkillPath), true);
    assert.match(fs.readFileSync(stagedSkillPath, "utf8"), /^version: "1\.1\.37"$/m);
    assert.equal(
      fs.existsSync(path.join(stageDir, "zh-CN", target.skillName, "publish.json")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(stageDir, "zh-CN", target.skillName, "_meta.json")),
      false
    );
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceBefore);
    assert.equal(fs.existsSync(target.archivePath), true);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

test("ModelScope publication chooses create, update, or skip safely", () => {
  assert.equal(decideAction("1.1.37", null), "create");
  assert.equal(decideAction("1.1.37", { version: "1.1.36" }), "update");
  assert.equal(decideAction("1.1.37", { version: "1.1.37" }), "skip");
  assert.equal(decideAction("1.1.37", { version: "1.1.37" }, { force: true }), "update");
  assert.throws(
    () => decideAction("1.1.37", { version: "1.1.38" }),
    /remote version 1\.1\.38 is newer than local version 1\.1\.37/
  );
});

test("ModelScope publish uploads once and updates an existing Skill", async () => {
  const projectRoot = path.resolve(__dirname, "..");
  const stageDir = fs.mkdtempSync(path.join(projectRoot, "tmp/modelscope-api-test-"));
  const calls = [];
  let detailReads = 0;

  try {
    const staged = stageSkills({
      stageDir,
      skill: "tiktok-insight",
      locale: "en"
    });
    const target = staged.targets[0];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === "GET") {
        detailReads += 1;
        return jsonResponse({
          data: {
            id: `@${target.owner}/${target.skillName}`,
            skill_name: target.skillName,
            display_name: target.displayName,
            version: detailReads === 1 ? "1.1.36" : "1.1.37"
          }
        });
      }
      if (url.endsWith("/files/upload")) {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "Bearer test-token");
        assert.equal(init.body instanceof FormData, true);
        return jsonResponse({ data: { id: "file-123" } });
      }
      assert.equal(init.method, "PATCH");
      assert.match(url, /\/openapi\/v1\/skills\/Gecho\/tiktok-insight\/settings$/);
      const payload = JSON.parse(init.body);
      assert.equal(payload.skill_file, "file-123");
      assert.equal(payload.display_name, target.displayName);
      return jsonResponse({ data: { version: "1.1.37" } });
    };

    const result = await publishTarget(target, {
      endpoint: "https://modelscope.test",
      token: "test-token",
      fetchImpl
    });

    assert.equal(result.action, "update");
    assert.equal(result.verified.version, "1.1.37");
    assert.equal(calls.filter((call) => call.url.endsWith("/files/upload")).length, 1);
    assert.equal(calls.filter((call) => call.init.method === "PATCH").length, 1);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

test("ModelScope publish creates a missing Skill with the platform metadata", async () => {
  const projectRoot = path.resolve(__dirname, "..");
  const stageDir = fs.mkdtempSync(path.join(projectRoot, "tmp/modelscope-create-test-"));
  const calls = [];
  let detailReads = 0;

  try {
    const staged = stageSkills({
      stageDir,
      skill: "tiktok-insight",
      locale: "en"
    });
    const target = staged.targets[0];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (init.method === "GET") {
        detailReads += 1;
        if (detailReads === 1) return jsonResponse({ message: "not found" }, 404);
        return jsonResponse({
          data: {
            id: `@${target.owner}/${target.skillName}`,
            version: target.version,
            display_name: target.displayName
          }
        });
      }
      if (url.endsWith("/files/upload")) {
        return jsonResponse({ data: { id: "file-create-123" } });
      }
      assert.equal(init.method, "POST");
      assert.equal(url, "https://modelscope.test/openapi/v1/skills");
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload, {
        owner: "Gecho",
        skill_name: "tiktok-insight",
        display_name: "tiktok-insight",
        description: target.description,
        skill_file: "file-create-123",
        category: "marketing-seo",
        license: "MIT License",
        source_url: "https://github.com/gecho-ai/gecho-bridge"
      });
      return jsonResponse({ data: { id: `@${target.owner}/${target.skillName}` } });
    };

    const result = await publishTarget(target, {
      endpoint: "https://modelscope.test",
      token: "test-token",
      fetchImpl
    });

    assert.equal(result.action, "create");
    assert.equal(result.verified.version, target.version);
    assert.equal(calls.filter((call) => call.url.endsWith("/files/upload")).length, 1);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

test("ModelScope dry-run never uploads and blocks a newer remote version", async () => {
  const target = buildTargets({ skill: "tiktok-insight", locale: "en" })[0];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return jsonResponse({ data: { version: "1.1.38" } });
  };

  await assert.rejects(
    () => publishTarget(target, {
      endpoint: "https://modelscope.test",
      token: "test-token",
      fetchImpl,
      dryRun: true
    }),
    /remote version 1\.1\.38 is newer than local version 1\.1\.37/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
});
