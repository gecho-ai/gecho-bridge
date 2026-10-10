"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const catalog = [
  { id: "chrome", name: "Google Chrome", mac: "Google/Chrome", win: "Google/Chrome", linux: "google-chrome", executable: "chrome.exe" },
  { id: "edge", name: "Microsoft Edge", mac: "Microsoft Edge", win: "Microsoft/Edge", linux: "microsoft-edge", executable: "msedge.exe" },
  { id: "brave", name: "Brave Browser", mac: "BraveSoftware/Brave-Browser", win: "BraveSoftware/Brave-Browser", linux: "BraveSoftware/Brave-Browser", executable: "brave.exe" },
  { id: "arc", name: "Arc", mac: "Arc/User Data" },
];

function discoverBrowsers({ platform = process.platform, home = os.homedir(), systemApplications = "/Applications", env = process.env } = {}) {
  const found = [];
  for (const browser of catalog) {
    let candidates = [], dataRoot;
    if (platform === "darwin") {
      candidates = [systemApplications, path.join(home, "Applications")].map((root) => path.join(root, `${browser.name}.app`, "Contents/MacOS", browser.name));
      dataRoot = path.join(home, "Library/Application Support", browser.mac);
    } else if (platform === "win32" && browser.win) {
      candidates = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(Boolean)
        .map((root) => path.join(root, browser.win, "Application", browser.executable));
      dataRoot = path.join(env.LOCALAPPDATA || path.join(home, "AppData/Local"), browser.win, "User Data");
    } else if (platform === "linux" && browser.linux) {
      const executable = browser.id === "brave" ? "brave-browser" : browser.linux;
      candidates = ["/usr/bin", "/opt/bin", "/usr/local/bin"].map((root) => path.join(root, executable));
      dataRoot = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), browser.linux);
    }
    const executable = candidates.find((candidate) => fs.existsSync(candidate));
    if (!executable) continue;
    let labels = {};
    try { labels = JSON.parse(fs.readFileSync(path.join(dataRoot, "Local State"), "utf8")).profile?.info_cache || {}; } catch (_) {}
    let profiles = [];
    try {
      profiles = fs.readdirSync(dataRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
        .map((entry) => ({ id: entry.name, name: String(labels[entry.name]?.name || entry.name).slice(0, 120) }));
    } catch (_) {}
    if (!profiles.length) profiles = [{ id: "Default", name: "Default" }];
    found.push({ id: browser.id, name: browser.name, executable, profiles });
  }
  return found;
}

function browserLaunchSpec(browser, profile, url) {
  if (!browser || !browser.profiles.some((entry) => entry.id === profile)) throw new Error("Browser Profile is unavailable");
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.pathname !== "/onboarding") throw new Error("Invalid connection guide URL");
  return { command: browser.executable, args: [`--profile-directory=${profile}`, "--new-window", target.href] };
}

function launchBrowser(selection, url) {
  const browser = discoverBrowsers().find((entry) => entry.id === selection?.browser);
  const spec = browserLaunchSpec(browser, selection?.profile, url);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve({ launched: true }); });
  });
}

function createRecoveryGuard({ launch, graceMs = 30000, cooldownMs = 60000, maxAttempts = 3 }) {
  let disconnectedAt = null, lastAttempt = -Infinity, attempts = 0, busy = false;
  return {
    async tick({ connected, enabled, selected, now = Date.now() }) {
      if (connected || !enabled || !selected) { disconnectedAt = null; attempts = 0; return; }
      if (disconnectedAt === null) disconnectedAt = now;
      if (busy || now - disconnectedAt < graceMs || now - lastAttempt < cooldownMs || attempts >= maxAttempts) return;
      busy = true; lastAttempt = now; attempts++;
      try { await launch(); } finally { busy = false; }
    },
  };
}

module.exports = { discoverBrowsers, browserLaunchSpec, launchBrowser, createRecoveryGuard };
