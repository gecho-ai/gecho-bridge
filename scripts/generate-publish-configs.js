#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const {
  listDistributionSkills,
  projectRoot,
  resolvePlatformTarget
} = require("./publish-config.js");

function firstHeading(skillDirectory) {
  const skillFile = ["SKILL.md", "skill.md"]
    .map((name) => path.join(skillDirectory, name))
    .find((filePath) => fs.existsSync(filePath));
  const text = fs.readFileSync(skillFile, "utf8");
  const match = text.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : path.basename(skillDirectory);
}

function existingChineseDisplayName(skillDirectory) {
  const configPath = path.join(skillDirectory, "skillhub-publish.json");
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return typeof config.displayName === "string" && config.displayName.trim()
    ? config.displayName.trim()
    : null;
}

function writeMissingConfigs() {
  let created = 0;
  for (const skill of listDistributionSkills()) {
    const configPath = path.join(skill.directory, "publish.json");
    if (fs.existsSync(configPath)) continue;

    const displayName = skill.locale === "zh-CN"
      ? (existingChineseDisplayName(skill.directory) || firstHeading(skill.directory))
      : firstHeading(skill.directory);
    const sourceSlug = skill.sourceSlug;
    const isChinese = skill.locale === "zh-CN";

    const tencentTarget = {
      slug: isChinese ? sourceSlug : `${sourceSlug}-en`,
      displayName,
      mode: isChinese ? "update-or-create" : "create"
    };

    const config = {
      schemaVersion: 1,
      sourceSlug,
      locale: skill.locale,
      platforms: {
        clawhub: {
          slug: isChinese ? `${sourceSlug}-zh-cn` : sourceSlug,
          displayName
        },
        "tencent-skillhub": tencentTarget,
        "aily-skillhub": { ...tencentTarget },
        modelscope: {
          slug: isChinese ? `${sourceSlug}-gecho` : sourceSlug,
          displayName
        }
      }
    };

    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    created += 1;
    console.log(`created ${path.relative(projectRoot, configPath)}`);
  }
  console.log(`Created ${created} publish config(s).`);
}

function checkConfigs() {
  const skills = listDistributionSkills();
    const platforms = ["clawhub", "tencent-skillhub", "aily-skillhub", "modelscope"];
  const seen = new Map(platforms.map((platform) => [platform, new Set()]));
  for (const skill of skills) {
    for (const platform of platforms) {
      const target = resolvePlatformTarget(skill.directory, platform);
      if (seen.get(platform).has(target.slug)) {
        throw new Error(`${platform}: duplicate slug ${target.slug}`);
      }
      seen.get(platform).add(target.slug);
    }
  }
  console.log(`Validated ${skills.length} Skill config(s) across ${platforms.length} platforms.`);
}

if (process.argv.includes("--check")) {
  try {
    checkConfigs();
  } catch (error) {
    console.error(`Publish config check failed: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  try {
    writeMissingConfigs();
  } catch (error) {
    console.error(`Publish config generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
