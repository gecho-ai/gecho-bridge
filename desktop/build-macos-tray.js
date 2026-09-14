"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  process.exit(0);
}

const root = path.join(__dirname, "macos-tray");
const appRoot = path.join(root, "GechoTray.app");
const contents = path.join(appRoot, "Contents");
const binaryDir = path.join(contents, "MacOS");
const binary = path.join(binaryDir, "GechoTray");

fs.mkdirSync(binaryDir, { recursive: true });
fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });

const result = spawnSync("swiftc", [
  path.join(root, "GechoTray.swift"),
  "-o",
  binary,
], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

fs.copyFileSync(path.join(root, "Info.plist"), path.join(contents, "Info.plist"));

const assetsDir = path.join(__dirname, "assets");
if (fs.existsSync(assetsDir)) {
  for (const file of fs.readdirSync(assetsDir)) {
    if (file.startsWith("tray-icon")) {
      fs.copyFileSync(path.join(assetsDir, file), path.join(contents, "Resources", file));
    }
  }
}

fs.chmodSync(binary, 0o755);
console.log(`Built ${path.relative(process.cwd(), appRoot)}`);
