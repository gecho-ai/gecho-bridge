#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

const skillRoots = [
  "skills",
  "skills-zh-CN",
  "distribution-skills",
  "distribution-skills-zh-CN"
];

function createVersionTarget(relativePath) {
  return {
    relativePath,
    apply(data) {
      data.version = version;
    }
  };
}

function discoverSkillMetadata(root) {
  const absoluteRoot = path.join(projectRoot, root);
  if (!fs.existsSync(absoluteRoot)) {
    return [];
  }

  const metadataPaths = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectory = path.join(absoluteRoot, entry.name);
    const hasSkillFile = ["SKILL.md", "skill.md"].some((fileName) =>
      fs.existsSync(path.join(skillDirectory, fileName))
    );
    if (!hasSkillFile) {
      continue;
    }

    const relativePath = path.join(root, entry.name, "_meta.json");
    if (!fs.existsSync(path.join(projectRoot, relativePath))) {
      throw new Error(`Missing _meta.json for Skill: ${path.join(root, entry.name)}`);
    }
    metadataPaths.push(relativePath);
  }

  return metadataPaths.sort().map(createVersionTarget);
}

const targets = [
  createVersionTarget(".claude-plugin/plugin.json"),
  createVersionTarget("openclaw.plugin.json"),
  ...skillRoots.flatMap(discoverSkillMetadata)
];

for (const target of targets) {
  const filePath = path.join(projectRoot, target.relativePath);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const previousVersion = data.version;
  target.apply(data);
  if (previousVersion !== data.version) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Synced ${target.relativePath} -> ${version}`);
  } else {
    console.log(`Already current ${target.relativePath} -> ${version}`);
  }
}
