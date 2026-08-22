const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildQueue,
  parseArgs,
  readManifest
} = require("../scripts/publish-aily-browser.js");

test("Aily browser publisher parses safe defaults and filters", () => {
  const options = parseArgs([
    "dry-run",
    "--skill",
    "tiktok-shop-search",
    "--locale",
    "zh-CN",
    "--endpoint",
    "http://127.0.0.1:9333",
    "--limit",
    "2",
    "--continue-on-error"
  ]);

  assert.equal(options.mode, "dry-run");
  assert.equal(options.skill, "tiktok-shop-search");
  assert.equal(options.locale, "zh-CN");
  assert.equal(options.endpoint, "http://127.0.0.1:9333");
  assert.equal(options.limit, 2);
  assert.equal(options.continueOnError, true);
});

test("Aily browser publisher reads the manual package manifest", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aily-browser-manifest-"));
  const archiveName = "tiktok-shop-search-zh-CN-v1.1.37.zip";
  fs.writeFileSync(
    path.join(tempRoot, "manifest.tsv"),
    [
      "source_root\tslug\tlocale\tversion\tarchive",
      `distribution-skills-zh-CN\ttiktok-shop-search\tzh-CN\t1.1.37\t${archiveName}`
    ].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(tempRoot, archiveName), "test archive");

  try {
    const manifest = readManifest(tempRoot);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].archive, archiveName);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Aily browser publisher maps the configured displayName to each archive", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aily-browser-queue-"));
  const archiveName = "tiktok-shop-search-zh-CN-v1.1.37.zip";
  fs.writeFileSync(
    path.join(tempRoot, "manifest.tsv"),
    [
      "source_root\tslug\tlocale\tversion\tarchive",
      `distribution-skills-zh-CN\ttiktok-shop-search\tzh-CN\t1.1.37\t${archiveName}`
    ].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(tempRoot, archiveName), "test archive");

  try {
    const queue = buildQueue({
      packageDir: tempRoot,
      skill: "tiktok-shop-search",
      locale: "zh-CN"
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].archivePath, path.join(tempRoot, archiveName));
    assert.equal(queue[0].displayName, "TikTok Shop 商品搜索【Gecho 官方】");
    assert.equal(queue[0].publishedSlug, "tiktok-shop-search");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Aily browser publisher rejects invalid locale and limits", () => {
  assert.throws(() => parseArgs(["--locale", "fr"]), /locale must be/);
  assert.throws(() => parseArgs(["--limit", "0"]), /limit must be/);
});
