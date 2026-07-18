const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const SERVICE_BASE_URL = process.env.GECHO_SERVICE_URL || "http://127.0.0.1:18793";
const HELPER_SOURCE_PATH = path.join(__dirname, "libexec", "gecho-bridge-wake");
const HELPER_PATH = "/usr/local/libexec/gecho-bridge-wake";
const SUDOERS_PATH = "/etc/sudoers.d/gecho-bridge-wake";
const DEFAULT_DATA_DIR = process.env.GECHO_DATA_DIR || path.join(__dirname, "data");
const WINDOWS_WAKE_HELPER_PATH = path.join(__dirname, "windows-wake-helper.ps1");

function printUsage() {
  process.stdout.write(`Usage:\n  gecho-bridge wake enable\n  gecho-bridge wake status\n  gecho-bridge wake disable\n  gecho-bridge wake uninstall\n\n`);
}

function requestJson(urlPath, method = "GET") {
  return new Promise((resolve) => {
    const url = new URL(urlPath, SERVICE_BASE_URL);
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body || "{}"); } catch (_e) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: parsed });
      });
    });
    req.on("error", () => resolve({ ok: false, statusCode: 0, body: {} }));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: {} });
    });
    req.end();
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      reject(new Error((stderr || stdout || `${path.basename(command)} exited with code ${code}`).trim()));
    });
  });
}

function getWindowsWakeTaskName(dataDir) {
  const identity = crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 12);
  return `GechoBridge-WakeNext-${identity}`;
}

function getPowerShellExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runWindowsWakeHelper(mode, dataDir) {
  if (!fs.existsSync(WINDOWS_WAKE_HELPER_PATH)) return Promise.reject(new Error(`bundled Windows wake helper is missing: ${WINDOWS_WAKE_HELPER_PATH}`));
  return runCapture(getPowerShellExecutable(), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_WAKE_HELPER_PATH,
    "-Mode", mode,
    "-TaskName", getWindowsWakeTaskName(dataDir)
  ]);
}

function assertSupportedPlatform() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("wake scheduling is currently supported on macOS and Windows only");
  }
}

function ensureSafeUserName() {
  const user = os.userInfo().username;
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error("current macOS username cannot be represented safely in sudoers");
  return user;
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_e) { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function settingsPath(dataDir) {
  return path.join(dataDir, ".wake_scheduler_settings.json");
}

function statePath(dataDir) {
  return path.join(dataDir, ".wake_scheduler_state.json");
}

function formatPmsetDate(isoDate) {
  const date = new Date(isoDate);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear() % 100)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function getRunningBridge() {
  const result = await requestJson("/ping");
  return result.ok ? result.body : null;
}

async function installHelper() {
  if (!fs.existsSync(HELPER_SOURCE_PATH)) throw new Error(`bundled Wake Helper is missing: ${HELPER_SOURCE_PATH}`);
  const user = ensureSafeUserName();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-bridge-wake-"));
  const helperTempPath = path.join(tempDir, "gecho-bridge-wake");
  const sudoersTempPath = path.join(tempDir, "gecho-bridge-wake.sudoers");
  fs.copyFileSync(HELPER_SOURCE_PATH, helperTempPath);
  fs.writeFileSync(
    sudoersTempPath,
    `${user} ALL=(root) NOPASSWD: ${HELPER_PATH} *\n`,
    { mode: 0o600 }
  );

  try {
    process.stdout.write("A macOS administrator password may be requested once to install the restricted Wake Helper.\n");
    await run("/usr/bin/sudo", ["/usr/bin/install", "-d", "-o", "root", "-g", "wheel", "-m", "755", path.dirname(HELPER_PATH)]);
    await run("/usr/bin/sudo", ["/usr/bin/install", "-o", "root", "-g", "wheel", "-m", "755", helperTempPath, HELPER_PATH]);
    await run("/usr/bin/sudo", ["/usr/sbin/visudo", "-cf", sudoersTempPath]);
    await run("/usr/bin/sudo", ["/usr/bin/install", "-o", "root", "-g", "wheel", "-m", "440", sudoersTempPath, SUDOERS_PATH]);
    await runCapture("/usr/bin/sudo", ["-n", HELPER_PATH, "status"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeEnabledSetting(dataDir, enabled) {
  const previous = readJson(settingsPath(dataDir), {});
  writeJsonAtomic(settingsPath(dataDir), {
    ...previous,
    enabled,
    executionMode: process.platform === "win32" ? "task_scheduler" : "helper",
    updatedAt: new Date().toISOString()
  });
}

async function enable() {
  assertSupportedPlatform();
  const bridge = await getRunningBridge();
  if (!bridge) {
    throw new Error("Bridge is not running. Start the MCP client first, then run `gecho-bridge wake enable` so the setting is saved beside the scheduled jobs it manages.");
  }
  if (!bridge.wakeScheduler || (process.platform === "darwin" && !bridge.wakeScheduler.helperPath)) {
    throw new Error("The running Bridge version does not support wake scheduling. Restart or upgrade the MCP client before enabling it.");
  }
  if (process.platform === "darwin") await installHelper();
  const dataDir = bridge.dataDir;
  writeEnabledSetting(dataDir, true);

  const result = await requestJson("/wake-scheduler/enable", "POST");
  if (result.ok) {
    process.stdout.write(`Wake scheduling enabled. ${result.body.wakeScheduler?.plannedWakeAt ? `Next wake: ${result.body.wakeScheduler.plannedWakeAt}` : "Create a future scheduled job to register a wake event."}\n`);
  } else {
    process.stdout.write("Wake scheduling settings were saved, but the running Bridge does not support live reload. Restart Bridge to apply them.\n");
  }
}

async function disable({ uninstall = false } = {}) {
  assertSupportedPlatform();
  const bridge = await getRunningBridge();
  const dataDir = bridge?.dataDir || DEFAULT_DATA_DIR;
  if (bridge) {
    const result = await requestJson("/wake-scheduler/disable", "POST");
    if (result.ok) {
      // The current Bridge cancels the event before persisting disabled state.
      writeEnabledSetting(dataDir, false);
    } else {
      if (process.platform === "darwin") {
        const state = readJson(statePath(dataDir), {});
        const date = formatPmsetDate(state.registeredWakeAt);
        if (date) {
          try { await runCapture("/usr/bin/sudo", ["-n", HELPER_PATH, "cancel", date]); } catch (_e) {}
        }
      }
      writeEnabledSetting(dataDir, false);
      process.stdout.write("The running Bridge does not support live reload; restart it to pick up the disabled setting.\n");
    }
  } else {
    if (process.platform === "win32") {
      try { await runWindowsWakeHelper("remove", dataDir); } catch (_e) {}
    } else if (process.platform === "darwin") {
      const state = readJson(statePath(dataDir), {});
      const date = formatPmsetDate(state.registeredWakeAt);
      if (date) {
        try { await runCapture("/usr/bin/sudo", ["-n", HELPER_PATH, "cancel", date]); } catch (_e) {}
      }
    }
    writeEnabledSetting(dataDir, false);
  }

  if (uninstall && process.platform === "darwin") {
    await run("/usr/bin/sudo", ["/bin/rm", "-f", SUDOERS_PATH, HELPER_PATH]);
    process.stdout.write("Wake scheduling disabled and the restricted Helper was removed.\n");
  } else if (process.platform === "darwin") {
    process.stdout.write("Wake scheduling disabled. The Helper remains installed; run `gecho-bridge wake uninstall` to remove it and revoke passwordless access.\n");
  } else {
    process.stdout.write("Wake scheduling disabled and Gecho's Task Scheduler wake task was removed.\n");
  }
}

async function status() {
  assertSupportedPlatform();
  const bridge = await getRunningBridge();
  let helperReady = false;
  let helperError = "";
  if (process.platform === "win32") {
    try {
      await runWindowsWakeHelper("status", bridge?.dataDir || DEFAULT_DATA_DIR);
      helperReady = true;
    } catch (error) {
      helperError = error.message;
    }
  } else if (process.platform === "darwin") {
    try {
      await runCapture("/usr/bin/sudo", ["-n", HELPER_PATH, "status"]);
      helperReady = true;
    } catch (error) {
      helperError = error.message;
    }
  }
  const dataDir = bridge?.dataDir || DEFAULT_DATA_DIR;
  const settings = readJson(settingsPath(dataDir), { enabled: false });
  process.stdout.write(JSON.stringify({
    bridgeRunning: !!bridge,
    dataDir,
    enabled: settings.enabled === true,
    helperPath: process.platform === "darwin" ? HELPER_PATH : bridge?.wakeScheduler?.windowsWakeHelperPath || null,
    helperReady,
    helperError: helperReady ? "" : helperError,
    wakeScheduler: bridge?.wakeScheduler || null
  }, null, 2) + "\n");
}

async function main(args) {
  const command = args[0] || "help";
  if (["help", "--help", "-h"].includes(command)) return printUsage();
  if (command === "enable") return enable();
  if (command === "status") return status();
  if (command === "disable") return disable();
  if (command === "uninstall") return disable({ uninstall: true });
  printUsage();
  throw new Error(`unknown wake command: ${command}`);
}

module.exports = { main };
