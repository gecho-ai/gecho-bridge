#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

const targets = [
  {
    relativePath: ".claude-plugin/plugin.json",
    apply(data) {
      data.version = version;
    }
  },
  {
    relativePath: "openclaw.plugin.json",
    apply(data) {
      data.version = version;
    }
  },
  {
    relativePath: "skills/tiktok-search/_meta.json",
    apply(data) {
      data.version = version;
    }
  },
  {
    relativePath: "distribution-skills/tiktok-video-search/_meta.json",
    apply(data) {
      data.version = version;
    }
  },
  {
    relativePath: "distribution-skills/tiktok-insight/_meta.json",
    apply(data) {
      data.version = version;
    }
  }
];

for (const target of targets) {
  const filePath = path.join(projectRoot, target.relativePath);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  target.apply(data);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Synced ${target.relativePath} -> ${version}`);
}
