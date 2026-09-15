const test = require("node:test");
const assert = require("node:assert/strict");
const { loginItemOptions, createTrayPng } = require("../desktop/platform");

test("Windows login startup preserves the installed executable path and starts hidden", () => {
  const executable = "C:\\Users\\测试用户\\AppData\\Local\\Programs\\Gecho\\Gecho.exe";
  assert.deepEqual(loginItemOptions("win32", executable), { path: executable, args: ["--hidden"] });
  assert.deepEqual(loginItemOptions("darwin", executable), {});
});

test("Windows tray icon is a valid PNG with a visible payload", () => {
  const png = createTrayPng("win32");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 50);
});

test("macOS tray icon is a valid visible PNG", () => {
  const png = createTrayPng("darwin");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 50);
});

test("macOS GechoTray source code avoids autosaveName and sets accessory policy before run", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const swiftSource = fs.readFileSync(
    path.join(__dirname, "..", "desktop", "macos-tray", "GechoTray.swift"),
    "utf8"
  );
  assert.equal(swiftSource.includes("autosaveName"), false, "Must not set autosaveName to avoid restoring offscreen coordinates");
  assert.ok(swiftSource.includes("setActivationPolicy(.accessory)"), "Must set accessory policy");
  assert.ok(swiftSource.includes("purgeLegacyAutosavePositions"), "Must purge legacy autosave coordinates");
  assert.ok(swiftSource.includes("removePersistentDomain"), "Must remove legacy bundle ID persistent domain");
  assert.ok(swiftSource.includes("strongDelegate"), "Must hold strong reference to delegate");
});

test("desktop platform includes open dashboard menu and scheduled tasks panel", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const swiftSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "macos-tray", "GechoTray.swift"), "utf8");
  assert.ok(swiftSource.includes("打开面板"), "GechoTray must include '打开面板' menu item");
  assert.ok(swiftSource.includes("open-dashboard"), "GechoTray must send 'open-dashboard' command");

  const mainSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.ok(mainSource.includes("openDashboardWindow"), "main.js must define openDashboardWindow");
  assert.ok(mainSource.includes("get-scheduled-tasks"), "main.js must support get-scheduled-tasks IPC");
  assert.ok(mainSource.includes("mockScheduledTasks"), "main.js must provide mockScheduledTasks");
  assert.ok(mainSource.includes("icon.png"), "main.js must set brand icon on window");

  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  assert.ok(preloadSource.includes("getScheduledTasks"), "preload.js must expose getScheduledTasks");

  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "index.html"), "utf8");
  assert.ok(htmlSource.includes("tasks-list"), "index.html must include tasks-list element");
  assert.ok(htmlSource.includes("brand-logo"), "index.html must display brand logo");
});

test("desktop application and tray icon assets exist and are valid", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const assetsDir = path.join(__dirname, "..", "desktop", "assets");
  assert.ok(fs.existsSync(path.join(assetsDir, "icon.png")), "App icon PNG exists");
  assert.ok(fs.existsSync(path.join(assetsDir, "icon.icns")), "macOS App icon ICNS exists");
  assert.ok(fs.existsSync(path.join(assetsDir, "icon.ico")), "Windows App icon ICO exists");
  assert.ok(fs.existsSync(path.join(assetsDir, "tray-iconTemplate.png")), "macOS Tray template icon exists");
  assert.ok(fs.existsSync(path.join(assetsDir, "tray-iconTemplate@2x.png")), "macOS Tray template @2x icon exists");
  assert.ok(fs.existsSync(path.join(assetsDir, "tray-win-16.png")), "Windows Tray icon exists");
});

test("macOS GechoTray binary launches, emits ready and responds to shutdown", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Test only runs on macOS");
    return;
  }
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const binaryPath = path.join(
    __dirname,
    "..",
    "desktop",
    "macos-tray",
    "GechoTray.app",
    "Contents",
    "MacOS",
    "GechoTray"
  );
  if (!fs.existsSync(binaryPath)) {
    t.skip("GechoTray binary not built yet. Run npm run desktop:build-native first.");
    return;
  }

  const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for ready")), 3000);
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes('"type":"ready"')) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    assert.equal(ready, true);

    child.stdin.write(JSON.stringify({
      type: "status",
      version: "1.1.37",
      serviceLabel: "运行中",
      extensionConnected: true,
      browser: "chrome",
      autoStart: false
    }) + "\n");

    const exitCode = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
    });
    assert.equal(exitCode, 0);
  } finally {
    if (!child.killed) child.kill();
  }
});

test("macOS GechoTray automatically terminates when parent stdin pipe closes (P1 fix)", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Test only runs on macOS");
    return;
  }
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const binaryPath = path.join(
    __dirname,
    "..",
    "desktop",
    "macos-tray",
    "GechoTray.app",
    "Contents",
    "MacOS",
    "GechoTray"
  );
  if (!fs.existsSync(binaryPath)) {
    t.skip("GechoTray binary not built yet");
    return;
  }

  const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for ready")), 3000);
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes('"type":"ready"')) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Abruptly close stdin to simulate parent death
    child.stdin.end();

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("GechoTray did not exit after stdin closed")), 3000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
  } finally {
    if (!child.killed) child.kill();
  }
});
