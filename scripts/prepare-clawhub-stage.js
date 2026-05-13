#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// This script rewrites metadata only inside the staged publish directory.
// The repo stays on the npm-facing name/version, while ClawHub can publish
// under a different package name, version, or display name.
const stageDir = process.argv[2];

if (!stageDir) {
  console.error("Usage: node ./scripts/prepare-clawhub-stage.js <stage-dir>");
  process.exit(1);
}

const clawhubName = process.env.CLAWHUB_NAME;
const clawhubVersion = process.env.CLAWHUB_VERSION;
const clawhubDisplayName = process.env.CLAWHUB_DISPLAY_NAME;

function readJsonIfExists(relativePath) {
  const filePath = path.join(stageDir, relativePath);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    filePath,
    data: JSON.parse(fs.readFileSync(filePath, "utf8"))
  };
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function toPluginId(packageName) {
  // OpenClaw plugin ids use a flat dash-separated id, not npm scoped syntax.
  return packageName.replace(/^@/, "").replace(/[\/@]/g, "-");
}

const updates = [];

// Keep staged npm metadata aligned with the ClawHub publish identity.
const stagedPackageJson = readJsonIfExists("package.json");
if (stagedPackageJson) {
  if (clawhubName) {
    stagedPackageJson.data.name = clawhubName;
    updates.push(`package.json name -> ${clawhubName}`);
  }
  if (clawhubVersion) {
    stagedPackageJson.data.version = clawhubVersion;
    updates.push(`package.json version -> ${clawhubVersion}`);
  }
  writeJson(stagedPackageJson.filePath, stagedPackageJson.data);
}

// Some tooling still reads package-lock.json from the staged artifact, so we
// mirror the same overrides there to avoid mixed names or versions.
const stagedPackageLockJson = readJsonIfExists("package-lock.json");
if (stagedPackageLockJson) {
  if (clawhubName) {
    stagedPackageLockJson.data.name = clawhubName;
    if (stagedPackageLockJson.data.packages && stagedPackageLockJson.data.packages[""]) {
      stagedPackageLockJson.data.packages[""].name = clawhubName;
    }
    updates.push(`package-lock.json name -> ${clawhubName}`);
  }
  if (clawhubVersion) {
    stagedPackageLockJson.data.version = clawhubVersion;
    if (stagedPackageLockJson.data.packages && stagedPackageLockJson.data.packages[""]) {
      stagedPackageLockJson.data.packages[""].version = clawhubVersion;
    }
    updates.push(`package-lock.json version -> ${clawhubVersion}`);
  }
  writeJson(stagedPackageLockJson.filePath, stagedPackageLockJson.data);
}

// ClawHub / Claude metadata should match the published package identity too.
const stagedClaudePlugin = readJsonIfExists(".claude-plugin/plugin.json");
if (stagedClaudePlugin) {
  if (clawhubName) {
    stagedClaudePlugin.data.name = clawhubName;
    updates.push(`.claude-plugin/plugin.json name -> ${clawhubName}`);
  }
  if (clawhubVersion) {
    stagedClaudePlugin.data.version = clawhubVersion;
    updates.push(`.claude-plugin/plugin.json version -> ${clawhubVersion}`);
  }
  if (clawhubDisplayName) {
    stagedClaudePlugin.data.displayName = clawhubDisplayName;
    updates.push(`.claude-plugin/plugin.json displayName -> ${clawhubDisplayName}`);
  }
  writeJson(stagedClaudePlugin.filePath, stagedClaudePlugin.data);
}

// OpenClaw plugin metadata needs both a package name and a derived runtime id.
const stagedOpenClawPlugin = readJsonIfExists("openclaw.plugin.json");
if (stagedOpenClawPlugin) {
  if (clawhubName) {
    stagedOpenClawPlugin.data.name = clawhubName;
    stagedOpenClawPlugin.data.id = toPluginId(clawhubName);
    updates.push(`openclaw.plugin.json name -> ${clawhubName}`);
    updates.push(`openclaw.plugin.json id -> ${stagedOpenClawPlugin.data.id}`);
  }
  if (clawhubVersion) {
    stagedOpenClawPlugin.data.version = clawhubVersion;
    updates.push(`openclaw.plugin.json version -> ${clawhubVersion}`);
  }
  if (clawhubDisplayName) {
    stagedOpenClawPlugin.data.displayName = clawhubDisplayName;
    updates.push(`openclaw.plugin.json displayName -> ${clawhubDisplayName}`);
  }
  writeJson(stagedOpenClawPlugin.filePath, stagedOpenClawPlugin.data);
}

if (updates.length === 0) {
  console.log("No staged ClawHub metadata overrides requested.");
  process.exit(0);
}

console.log("Applied staged ClawHub metadata overrides:");
for (const update of updates) {
  console.log(`- ${update}`);
}
