const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));

test("desktop build points at the standalone Electron entry", () => {
  assert.equal(packageJson.build.extraMetadata.main, "desktop/main.js");
  assert.equal(packageJson.build.productName, "Gecho");
  assert.ok(packageJson.devDependencies.electron);
  assert.ok(packageJson.devDependencies["electron-builder"]);
});

test("desktop runtime files are included", () => {
  for (const relativePath of [
    "desktop/main.js",
    "desktop/preload.js",
    "desktop/renderer/index.html",
    "desktop/renderer/renderer.js",
    "desktop/renderer/style.css",
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, relativePath)), true, relativePath);
  }
});
