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

test("desktop platform provides structured logger and export diagnostics capability", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const logger = require("../desktop/logger");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-logger-test-"));
  try {
    logger.init(tmpDir);
    logger.info("Test info message");
    logger.warn("Test warn message");
    logger.error("Test error message", new Error("Sample error"));

    const logFile = logger.getLogFile();
    assert.ok(fs.existsSync(logFile), "Log file must be created");
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("[INFO] Test info message"), "Log file must include INFO log");
    assert.ok(content.includes("[WARN] Test warn message"), "Log file must include WARN log");
    assert.ok(content.includes("[ERROR] Test error message"), "Log file must include ERROR log");

    const diag = logger.exportDiagnostics({
      appVersion: "1.1.37-test",
      platform: process.platform,
      bridgeStatus: { service: "running" },
      dataDir: tmpDir,
    });
    assert.equal(diag.success, true, "Diagnostics export must succeed");
    assert.ok(fs.existsSync(diag.reportPath), "Diagnostics report file must exist");
    const diagText = fs.readFileSync(diag.reportPath, "utf8");
    assert.ok(diagText.includes("Gecho Desktop Diagnostics Report"), "Must have title header");
    assert.ok(diagText.includes("1.1.37-test"), "Must include app version");
  } finally {
    logger.init();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const swiftSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "macos-tray", "GechoTray.swift"), "utf8");
  assert.ok(swiftSource.includes("导出诊断日志"), "GechoTray must include '导出诊断日志'");
  assert.ok(swiftSource.includes("export-diagnostics"), "GechoTray must send 'export-diagnostics' command");

  const mainSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.ok(mainSource.includes("handleExportDiagnostics"), "main.js must define handleExportDiagnostics");
  assert.ok(mainSource.includes("export-diagnostics"), "main.js must handle export-diagnostics IPC");

  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  assert.ok(preloadSource.includes("exportDiagnostics"), "preload.js must expose exportDiagnostics");

  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "index.html"), "utf8");
  assert.ok(htmlSource.includes("export-logs-btn"), "index.html must have export-logs-btn");
});

test("desktop platform supports Windows double-click, second-instance window focus and network banner", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const mainSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.ok(mainSource.includes('tray.on("double-click"'), "main.js must listen for tray double-click on Windows");
  assert.ok(mainSource.includes('app.on("second-instance"'), "main.js must handle second-instance event");

  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "index.html"), "utf8");
  assert.ok(htmlSource.includes("network-banner"), "index.html must include network-banner");

  const cssSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "style.css"), "utf8");
  assert.ok(cssSource.includes(".network-banner"), "style.css must define .network-banner styles");
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

test("desktop platform supports internationalization (i18n) across tray and dashboard", () => {
  const i18n = require("../desktop/i18n");
  const fs = require("node:fs");
  const path = require("node:path");

  // Verify dictionaries
  assert.ok(i18n.translations["zh-CN"], "zh-CN translations must exist");
  assert.ok(i18n.translations["en-US"], "en-US translations must exist");
  assert.equal(typeof i18n.translations["zh-CN"].appTitle, "string");
  assert.equal(typeof i18n.translations["en-US"].appTitle, "string");

  // Verify switching and translation interpolation
  i18n.setLocale("zh-CN");
  assert.equal(i18n.getLocale(), "zh-CN");
  assert.equal(i18n.t("trayOpenDashboard"), "打开面板");
  assert.equal(i18n.t("tasksCount", { total: 5, active: 2 }), "5 个任务已配置 (2 个运行中)");

  i18n.setLocale("en-US");
  assert.equal(i18n.getLocale(), "en-US");
  assert.equal(i18n.t("trayOpenDashboard"), "Open Dashboard");
  assert.equal(i18n.t("tasksCount", { total: 5, active: 2 }), "5 tasks configured (2 active)");

  // Reset to zh-CN for safety
  i18n.setLocale("zh-CN");

  // Verify preload IPC exposure
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  assert.ok(preloadSource.includes("getLocale"), "preload.js must expose getLocale");
  assert.ok(preloadSource.includes("setLocale"), "preload.js must expose setLocale");
  assert.ok(preloadSource.includes("getTranslations"), "preload.js must expose getTranslations");

  // Verify renderer UI
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "index.html"), "utf8");
  assert.ok(htmlSource.includes("lang-toggle-btn"), "index.html must have lang-toggle-btn");
  assert.ok(htmlSource.includes("data-i18n"), "index.html must use data-i18n");

  // Verify Swift tray supports dynamic localization keys
  const swiftSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "macos-tray", "GechoTray.swift"), "utf8");
  assert.ok(swiftSource.includes("trayOpenDashboard"), "GechoTray must read trayOpenDashboard dynamically");
  assert.ok(swiftSource.includes("trayQuit"), "GechoTray must read trayQuit dynamically");
});

test("desktop platform supports version comparison and update checker", () => {
  const { compareVersions, checkForUpdates } = require("../desktop/updater");
  const fs = require("node:fs");
  const path = require("node:path");

  // Version comparisons
  assert.equal(compareVersions("1.1.37", "1.1.38"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.38"), 1);
  assert.equal(compareVersions("v2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.1.37", "1.1.37"), 0);
  assert.equal(compareVersions("1.1.37-beta", "1.1.37"), 0);

  // Preload integration
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  assert.ok(preloadSource.includes("checkForUpdates"), "preload.js must expose checkForUpdates");

  // Main integration
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.ok(mainSource.includes("check-for-updates"), "main.js must handle check-for-updates IPC");
  assert.ok(mainSource.includes("trayCheckUpdate"), "main.js must include trayCheckUpdate");

  // macOS Tray integration
  const swiftSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "macos-tray", "GechoTray.swift"), "utf8");
  assert.ok(swiftSource.includes("trayCheckUpdate"), "GechoTray.swift must include trayCheckUpdate");
  assert.ok(swiftSource.includes("check-for-updates"), "GechoTray.swift must send check-for-updates");

  // HTML Dashboard integration
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "index.html"), "utf8");
  assert.ok(htmlSource.includes("check-update-btn"), "index.html must include check-update-btn");
});

test("desktop platform provides local security token generation, persistence and verification", () => {
  const security = require("../desktop/security");
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-sec-test-"));
  try {
    const token1 = security.getOrCreateLocalToken(tmpDir);
    assert.equal(typeof token1, "string");
    assert.equal(token1.length, 64, "Token should be 32 bytes hex encoded (64 chars)");

    const tokenFile = path.join(tmpDir, security.TOKEN_FILENAME);
    assert.ok(fs.existsSync(tokenFile), "local-token.json must exist");

    // Reading again should return identical persisted token
    const token2 = security.getOrCreateLocalToken(tmpDir);
    assert.equal(token2, token1, "Token must be persisted and reused");

    // Verification
    assert.equal(security.verifyToken(token1, token1), true);
    assert.equal(security.verifyToken(token1, "invalid-token-string"), false);
    assert.equal(security.verifyToken("", token1), false);
    assert.equal(security.verifyToken(token1, null), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Preload integration
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  assert.ok(preloadSource.includes("getLocalToken"), "preload.js must expose getLocalToken");

  // Main integration
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.ok(mainSource.includes("get-local-token"), "main.js must handle get-local-token IPC");
  assert.ok(mainSource.includes("GECHO_LOCAL_TOKEN"), "main.js must inject GECHO_LOCAL_TOKEN");
});
