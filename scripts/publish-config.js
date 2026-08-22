const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const platformRegistryPath = path.join(projectRoot, "config", "publish-platforms.json");
const publishConfigFileName = "publish.json";
const distributionRoots = [
  { root: "distribution-skills", locale: "en" },
  { root: "distribution-skills-zh-CN", locale: "zh-CN" }
];

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${label} at ${path.relative(projectRoot, filePath)}: ${error.message}`);
  }
}

function loadPlatformRegistry() {
  const registry = readJson(platformRegistryPath, "platform registry");
  if (registry.schemaVersion !== 1 || !registry.platforms || typeof registry.platforms !== "object") {
    throw new Error("config/publish-platforms.json must contain schemaVersion 1 and platforms");
  }
  return registry;
}

function getSkillFile(skillDirectory) {
  for (const fileName of ["SKILL.md", "skill.md"]) {
    const filePath = path.join(skillDirectory, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function getDistributionDefinition(skillDirectory) {
  const relativePath = path.relative(projectRoot, skillDirectory);
  const rootName = relativePath.split(path.sep)[0];
  const definition = distributionRoots.find((item) => item.root === rootName);
  if (!definition) {
    throw new Error(`Skill is outside a distribution root: ${relativePath}`);
  }
  return definition;
}

function listDistributionSkills() {
  const skills = [];
  for (const definition of distributionRoots) {
    const rootDirectory = path.join(projectRoot, definition.root);
    if (!fs.existsSync(rootDirectory)) {
      throw new Error(`Skill root not found: ${definition.root}`);
    }
    for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(rootDirectory, entry.name);
      if (!getSkillFile(directory)) continue;
      skills.push({
        directory,
        sourcePath: path.relative(projectRoot, directory),
        sourceRoot: definition.root,
        sourceSlug: entry.name,
        locale: definition.locale
      });
    }
  }
  return skills.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function loadSkillPublishConfig(skillDirectory) {
  const absoluteDirectory = path.resolve(projectRoot, skillDirectory);
  const configPath = path.join(absoluteDirectory, publishConfigFileName);
  if (!fs.existsSync(configPath)) {
    throw new Error(`missing ${publishConfigFileName} in ${path.relative(projectRoot, absoluteDirectory)}`);
  }

  const config = readJson(configPath, publishConfigFileName);
  const definition = getDistributionDefinition(absoluteDirectory);
  const sourceSlug = path.basename(absoluteDirectory);
  if (config.schemaVersion !== 1) {
    throw new Error(`${path.relative(projectRoot, configPath)} must use schemaVersion 1`);
  }
  if (config.sourceSlug !== sourceSlug) {
    throw new Error(`${path.relative(projectRoot, configPath)} sourceSlug must be ${sourceSlug}`);
  }
  const metadataPath = path.join(absoluteDirectory, "_meta.json");
  if (fs.existsSync(metadataPath)) {
    const metadata = readJson(metadataPath, "_meta.json");
    if (metadata.slug !== sourceSlug) {
      throw new Error(`${path.relative(projectRoot, metadataPath)} slug must be ${sourceSlug}`);
    }
  }
  if (config.locale !== definition.locale) {
    throw new Error(`${path.relative(projectRoot, configPath)} locale must be ${definition.locale}`);
  }
  if (!config.platforms || typeof config.platforms !== "object") {
    throw new Error(`${path.relative(projectRoot, configPath)} must contain platforms`);
  }
  return config;
}

function resolvePlatformTarget(skillDirectory, platformName) {
  const absoluteDirectory = path.resolve(projectRoot, skillDirectory);
  const config = loadSkillPublishConfig(absoluteDirectory);
  const platformTarget = config.platforms[platformName];
  if (!platformTarget || platformTarget.enabled === false) {
    throw new Error(`${path.relative(projectRoot, absoluteDirectory)} has no enabled ${platformName} config`);
  }
  if (typeof platformTarget.slug !== "string" || !platformTarget.slug.trim()) {
    throw new Error(`${path.relative(projectRoot, absoluteDirectory)} ${platformName} config is missing slug`);
  }
  if (typeof platformTarget.displayName !== "string" || !platformTarget.displayName.trim()) {
    throw new Error(`${path.relative(projectRoot, absoluteDirectory)} ${platformName} config is missing displayName`);
  }

  const registry = loadPlatformRegistry();
  const platform = registry.platforms[platformName];
  if (!platform) {
    throw new Error(`platform ${platformName} is missing from config/publish-platforms.json`);
  }

  return {
    ...platformTarget,
    platform: platformName,
    sourceSlug: config.sourceSlug,
    locale: config.locale,
    sourcePath: path.relative(projectRoot, absoluteDirectory),
    namespace: platformTarget.namespace || platform.namespace || ""
  };
}

module.exports = {
  distributionRoots,
  listDistributionSkills,
  loadPlatformRegistry,
  loadSkillPublishConfig,
  projectRoot,
  resolvePlatformTarget
};
