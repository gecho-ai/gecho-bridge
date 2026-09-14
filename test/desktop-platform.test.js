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
  assert.ok(swiftSource.includes("strongDelegate"), "Must hold strong reference to delegate");
});

test("macOS GechoTray binary launches, emits ready and responds to shutdown", async () => {
  if (process.platform !== "darwin") return;
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
  if (!fs.existsSync(binaryPath)) return;

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
