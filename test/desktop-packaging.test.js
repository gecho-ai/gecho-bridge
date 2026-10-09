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
    "desktop/logger.js",
    "desktop/i18n.js",
    "desktop/updater.js",
    "desktop/security.js",
    "desktop/renderer/index.html",
    "desktop/renderer/renderer.js",
    "desktop/renderer/style.css",
    "desktop/installer.nsh",
    "action-result.js",
    "scheduled-task-store.js",
    "scheduled-task-scheduler.js",
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, relativePath)), true, relativePath);
  }

  const buildFiles = packageJson.build.files;
  assert.ok(buildFiles.includes("server.js"), "build.files must include server.js");
  assert.ok(buildFiles.includes("data-dir.js"), "build.files must include data-dir.js");
  assert.ok(buildFiles.includes("action-result.js"), "build.files must include action-result.js");
  assert.ok(buildFiles.includes("scheduled-task-store.js"), "build.files must include scheduled-task-store.js");
  assert.ok(buildFiles.includes("scheduled-task-scheduler.js"), "build.files must include scheduled-task-scheduler.js");
});

test("desktop build configures NSIS clean uninstallation and user directory options", () => {
  const nsis = packageJson.build.nsis;
  assert.equal(nsis.oneClick, false, "NSIS should allow user-guided directory selection");
  assert.equal(nsis.allowToChangeInstallationDirectory, true);
  assert.equal(nsis.createDesktopShortcut, true);
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.deleteAppDataOnUninstall, false, "Must preserve user app data on uninstall");
  assert.equal(nsis.shortcutName, "Gecho");
  assert.equal(nsis.include, "desktop/installer.nsh");
});
