#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_LABEL = "ai.gecho.bridge";
const DEFAULT_UNIT_NAME = "gecho-bridge.service";
const DEFAULT_TASK_NAME = "Gecho Bridge";

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")}`;
}

function windowsQuote(value) {
  return `"${String(value ?? "").replace(/"/g, '\\"')}"`;
}

function normalizedPort(value, fallback) {
  const port = Number(value || fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function defaultDataDirForPlatform(platform, homeDir) {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Gecho", "Bridge");
  }
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "Gecho", "Bridge");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"), "gecho", "bridge");
}

function resolveOptions(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const dataDir = path.resolve(options.dataDir || process.env.GECHO_DATA_DIR || defaultDataDirForPlatform(platform, homeDir));
  const servicePath = path.resolve(options.servicePath || path.join(__dirname, "server.js"));
  return {
    ...options,
    platform,
    homeDir,
    nodePath: path.resolve(options.nodePath || process.execPath),
    servicePath,
    workingDirectory: path.resolve(options.workingDirectory || path.dirname(servicePath)),
    dataDir,
    httpPort: normalizedPort(options.httpPort || process.env.GECHO_HTTP_PORT, 18793),
    wsPort: normalizedPort(options.wsPort || process.env.GECHO_WS_PORT, 18792),
    websiteUrl: String(options.websiteUrl || process.env.GECHO_WEBSITE_URL || "https://gecho.ai/").trim(),
    allowedOrigins: String(options.allowedOrigins ?? process.env.GECHO_SCHEDULED_ALLOWED_ORIGINS ?? "").trim(),
    allowLocalhost: String(options.allowLocalhost ?? process.env.GECHO_SCHEDULED_ALLOW_LOCALHOST ?? "").trim(),
    browser: String(options.browser || process.env.GECHO_BROWSER || "").trim(),
    autoLaunchBrowser: String(options.autoLaunchBrowser ?? process.env.GECHO_AUTO_LAUNCH_BROWSER ?? "").trim(),
    autoOpenOnboarding: String(options.autoOpenOnboarding ?? process.env.GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START ?? "").trim(),
    autoCloseBrowser: String(options.autoCloseBrowser ?? process.env.GECHO_AUTO_CLOSE_LAUNCHED_BROWSER ?? "").trim(),
    label: String(options.label || DEFAULT_LABEL).trim(),
    unitName: String(options.unitName || DEFAULT_UNIT_NAME).trim(),
    taskName: String(options.taskName || DEFAULT_TASK_NAME).trim()
  };
}

function buildStartupDescriptor(options = {}) {
  const resolved = resolveOptions(options);
  if (resolved.platform === "darwin") {
    return {
      kind: "launch_agent",
      scope: "user",
      label: resolved.label,
      path: path.join(resolved.homeDir, "Library", "LaunchAgents", `${resolved.label}.plist`)
    };
  }
  if (resolved.platform === "linux") {
    return {
      kind: "systemd_user",
      scope: "user",
      unitName: resolved.unitName,
      path: path.join(resolved.homeDir, ".config", "systemd", "user", resolved.unitName)
    };
  }
  if (resolved.platform === "win32") {
    return {
      kind: "windows_task",
      scope: "user",
      taskName: resolved.taskName
    };
  }
  return { kind: "unsupported", scope: "user" };
}

function safeEnvironmentEntries(options = {}) {
  const resolved = resolveOptions(options);
  const entries = [
    ["GECHO_DATA_DIR", resolved.dataDir],
    ["GECHO_HTTP_PORT", String(resolved.httpPort)],
    ["GECHO_WS_PORT", String(resolved.wsPort)],
    ["GECHO_WEBSITE_URL", resolved.websiteUrl],
    ["GECHO_SCHEDULED_ALLOWED_ORIGINS", resolved.allowedOrigins],
    ["GECHO_SCHEDULED_ALLOW_LOCALHOST", resolved.allowLocalhost],
    ["GECHO_BROWSER", resolved.browser],
    ["GECHO_AUTO_LAUNCH_BROWSER", resolved.autoLaunchBrowser],
    ["GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START", resolved.autoOpenOnboarding],
    ["GECHO_AUTO_CLOSE_LAUNCHED_BROWSER", resolved.autoCloseBrowser]
  ];
  return entries.filter(([, value]) => String(value || "").trim() !== "");
}

function createMacLaunchAgentPlist(options = {}) {
  const resolved = resolveOptions({ ...options, platform: "darwin" });
  const descriptor = buildStartupDescriptor(resolved);
  if (descriptor.kind !== "launch_agent") {
    throw new Error("macOS LaunchAgent configuration requires platform=darwin");
  }
  const programArguments = [resolved.nodePath, resolved.servicePath];
  const environmentEntries = safeEnvironmentEntries(resolved);
  const xmlArray = (values) => values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
  const xmlEnvironment = environmentEntries.length
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${environmentEntries.map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`).join("\n")}\n  </dict>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(resolved.label)}</string>
  <key>ProgramArguments</key>
  <array>
${xmlArray(programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(resolved.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>3</integer>${xmlEnvironment}
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(resolved.dataDir, "bridge-service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(resolved.dataDir, "bridge-service.error.log"))}</string>
</dict>
</plist>
`;
}

function createSystemdUserUnit(options = {}) {
  const resolved = resolveOptions({ ...options, platform: "linux" });
  const descriptor = buildStartupDescriptor(resolved);
  if (descriptor.kind !== "systemd_user") {
    throw new Error("systemd user configuration requires platform=linux");
  }
  const environmentLines = safeEnvironmentEntries(resolved)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Gecho Bridge local service
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(resolved.nodePath)} ${systemdQuote(resolved.servicePath)}
WorkingDirectory=${systemdQuote(resolved.workingDirectory)}
${environmentLines}
Restart=on-failure
RestartSec=3
StandardOutput=${systemdQuote(`append:${path.join(resolved.dataDir, "bridge-service.log")}`)}
StandardError=${systemdQuote(`append:${path.join(resolved.dataDir, "bridge-service.error.log")}`)}

[Install]
WantedBy=default.target
`;
}

function createWindowsTaskArgs(options = {}) {
  const resolved = resolveOptions({ ...options, platform: "win32" });
  return [
    "/Create",
    "/TN",
    resolved.taskName,
    "/TR",
    `${windowsQuote(resolved.nodePath)} ${windowsQuote(resolved.servicePath)}`,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F"
  ];
}

function writeStartupConfig(options = {}) {
  const resolved = resolveOptions(options);
  const descriptor = buildStartupDescriptor(resolved);
  if (descriptor.kind === "unsupported") {
    const error = new Error(`Unsupported platform: ${resolved.platform}`);
    error.code = "STARTUP_PLATFORM_UNSUPPORTED";
    throw error;
  }
  if (descriptor.kind === "windows_task") return descriptor;

  fs.mkdirSync(path.dirname(descriptor.path), { recursive: true, mode: 0o700 });
  fs.mkdirSync(resolved.dataDir, { recursive: true, mode: 0o700 });
  const contents = descriptor.kind === "launch_agent"
    ? createMacLaunchAgentPlist(resolved)
    : createSystemdUserUnit(resolved);
  fs.writeFileSync(descriptor.path, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(descriptor.path, 0o600);
  return descriptor;
}

function runCommand(command, args, options = {}) {
  const runner = options.runCommand || spawnSync;
  const result = runner(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || "").trim();
    const error = new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
    error.code = "STARTUP_COMMAND_FAILED";
    error.status = result?.status;
    throw error;
  }
  return result;
}

function runCommandBestEffort(command, args, options = {}) {
  try {
    return { ok: true, result: runCommand(command, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function currentGuiTarget() {
  if (typeof process.getuid !== "function") {
    const error = new Error("Current user id is unavailable");
    error.code = "STARTUP_USER_ID_UNAVAILABLE";
    throw error;
  }
  return `gui/${process.getuid()}`;
}

function installStartup(options = {}) {
  const resolved = resolveOptions(options);
  const descriptor = writeStartupConfig(resolved);
  if (descriptor.kind === "launch_agent") {
    const target = currentGuiTarget();
    runCommandBestEffort("launchctl", ["bootout", target, descriptor.path], resolved);
    runCommand("launchctl", ["bootstrap", target, descriptor.path], resolved);
    return { status: "installed", descriptor, active: true };
  }
  if (descriptor.kind === "systemd_user") {
    runCommand("systemctl", ["--user", "daemon-reload"], resolved);
    runCommand("systemctl", ["--user", "enable", "--now", descriptor.unitName], resolved);
    return { status: "installed", descriptor, active: true };
  }
  if (descriptor.kind === "windows_task") {
    runCommand("schtasks.exe", createWindowsTaskArgs(resolved), resolved);
    return { status: "installed", descriptor, active: true };
  }
  const error = new Error(`Unsupported platform: ${resolved.platform}`);
  error.code = "STARTUP_PLATFORM_UNSUPPORTED";
  throw error;
}

function uninstallStartup(options = {}) {
  const resolved = resolveOptions(options);
  const descriptor = buildStartupDescriptor(resolved);
  if (descriptor.kind === "launch_agent") {
    runCommandBestEffort("launchctl", ["bootout", currentGuiTarget(), descriptor.path], resolved);
    fs.rmSync(descriptor.path, { force: true });
    return { status: "uninstalled", descriptor, active: false };
  }
  if (descriptor.kind === "systemd_user") {
    runCommandBestEffort("systemctl", ["--user", "disable", "--now", descriptor.unitName], resolved);
    fs.rmSync(descriptor.path, { force: true });
    runCommandBestEffort("systemctl", ["--user", "daemon-reload"], resolved);
    return { status: "uninstalled", descriptor, active: false };
  }
  if (descriptor.kind === "windows_task") {
    runCommandBestEffort("schtasks.exe", ["/Delete", "/TN", descriptor.taskName, "/F"], resolved);
    return { status: "uninstalled", descriptor, active: false };
  }
  const error = new Error(`Unsupported platform: ${resolved.platform}`);
  error.code = "STARTUP_PLATFORM_UNSUPPORTED";
  throw error;
}

function getStartupStatus(options = {}) {
  const resolved = resolveOptions(options);
  const descriptor = buildStartupDescriptor(resolved);
  if (descriptor.kind === "unsupported") return { status: "unsupported", descriptor, configured: false, active: false };

  if (descriptor.kind === "launch_agent") {
    const configured = fs.existsSync(descriptor.path);
    const active = configured && runCommandBestEffort("launchctl", ["print", `${currentGuiTarget()}/${descriptor.label}`], resolved).ok;
    return { status: configured ? "configured" : "not configured", descriptor, configured, active };
  }
  if (descriptor.kind === "systemd_user") {
    const configured = fs.existsSync(descriptor.path);
    const enabled = runCommandBestEffort("systemctl", ["--user", "is-enabled", descriptor.unitName], resolved).ok;
    const active = runCommandBestEffort("systemctl", ["--user", "is-active", descriptor.unitName], resolved).ok;
    return { status: configured ? "configured" : "not configured", descriptor, configured, enabled, active };
  }
  const queried = runCommandBestEffort("schtasks.exe", ["/Query", "/TN", descriptor.taskName], resolved);
  return { status: queried.ok ? "configured" : "not configured", descriptor, configured: queried.ok, active: queried.ok };
}

module.exports = {
  buildStartupDescriptor,
  createMacLaunchAgentPlist,
  createSystemdUserUnit,
  createWindowsTaskArgs,
  getStartupStatus,
  installStartup,
  uninstallStartup,
  writeStartupConfig
};
