#!/usr/bin/env node

const os = require("os");
const path = require("path");

/**
 * Return a stable per-user data directory that is independent of the npm/npx
 * installation path. This is important for one-time onboarding state because
 * npx may install different package versions into different cache folders.
 */
function getDefaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Gecho", "Bridge");
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Gecho", "Bridge");
  }

  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "gecho", "bridge");
}

module.exports = { getDefaultDataDir };
