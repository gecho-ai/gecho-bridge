#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  distributionRoots,
  loadPlatformRegistry,
  projectRoot,
  resolvePlatformTarget
} = require("./publish-config.js");

const platformName = "workbuddy";
const defaultStageDir = path.join(projectRoot, "tmp", "workbuddy-publish");
const maxArchiveBytes = 3 * 1024 * 1024;
const maxDisplayNameCharacters = 30;
const stageMarkerFile = ".workbuddy-stage.json";
const stageMarker = {
  schemaVersion: 1,
  platform: platformName,
  managedBy: "publish-workbuddy-skills.js"
};

function usage() {
  return `Usage:
  node ./scripts/publish-workbuddy-skills.js [stage|package|dry-run] [options]

Modes:
  stage       Create WorkBuddy-only Skill copies (default).
  package     Create copies and uploadable ZIP files.
  dry-run     Create and validate ZIP files without network or platform upload.

Options:
  --skill <slug>          Only process one source slug.
  --locale <all|en|zh-CN> Process English, Chinese, or both (default: all).
  --stage-dir <path>      Generated directory (must be a tmp/workbuddy-publish* path).
  --version <version>     Override the version from package.json.
  -h, --help              Show this help.

The generated ZIPs are for manual upload to the WorkBuddy Open Platform.
This script intentionally has no publish or login command.
`;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return packageJson.version;
}

function getSkillFile(skillDirectory) {
  for (const fileName of ["SKILL.md", "skill.md"]) {
    const filePath = path.join(skillDirectory, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function readFrontmatter(text, filePath = "SKILL.md") {
  const match = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) throw new Error(`missing YAML frontmatter in ${filePath}`);
  return match;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function readFrontmatterFields(text, filePath = "SKILL.md") {
  const match = readFrontmatter(text, filePath);
  const fields = {};
  for (const line of match[2].split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.trim().startsWith("#")) continue;
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) fields[field[1]] = parseScalar(field[2]);
  }
  return fields;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function upsertWorkbuddyFrontmatter(text, fields, filePath = "SKILL.md") {
  const match = readFrontmatter(text, filePath);
  const eol = match[1];
  const lines = match[2].split(/\r?\n/);
  const missing = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    const lineIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
    const replacement = `${key}: ${yamlScalar(value)}`;
    if (lineIndex === -1) missing.push(replacement);
    else lines[lineIndex] = replacement;
  }

  if (missing.length > 0) lines.unshift(...missing);
  return `---${eol}${lines.join(eol)}${eol}---${match[3]}${text.slice(match[0].length)}`;
}

function addWorkbuddyPromptSection(text, locale, filePath = "SKILL.md") {
  const heading = locale === "zh-CN" ? "## 试试这样问我" : "## Try asking me";
  const promptHeading = locale === "zh-CN"
    ? /^适用(?:的)?提示词：\s*$/m
    : /^Best-fit prompts:\s*$/m;
  if (!promptHeading.test(text)) {
    throw new Error(`missing prompt examples in ${filePath}`);
  }
  return text.replace(promptHeading, heading);
}

function parseArgs(argv) {
  const args = [...argv];
  let mode = "stage";
  if (args[0] && !args[0].startsWith("-")) mode = args.shift();
  if (!["stage", "package", "dry-run"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}\n\n${usage()}`);
  }

  const options = {
    mode,
    skill: null,
    locale: "all",
    stageDir: process.env.WORKBUDDY_STAGE_DIR || defaultStageDir,
    version: process.env.WORKBUDDY_VERSION || null
  };

  const nextValue = (flag) => {
    const value = args.shift();
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
    return value;
  };

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--skill": options.skill = nextValue(flag); break;
      case "--locale": options.locale = nextValue(flag); break;
      case "--stage-dir": options.stageDir = nextValue(flag); break;
      case "--version": options.version = nextValue(flag); break;
      case "-h":
      case "--help": options.help = true; break;
      default: throw new Error(`Unknown option: ${flag}\n\n${usage()}`);
    }
  }

  if (!["all", "en", "zh-CN"].includes(options.locale)) {
    throw new Error(`--locale must be all, en, or zh-CN (got ${options.locale})`);
  }
  return options;
}

function assertSafeStageDir(stageDir) {
  const resolved = path.resolve(projectRoot, stageDir);
  const temporaryRoot = path.join(projectRoot, "tmp");
  const relativeToTemporaryRoot = path.relative(temporaryRoot, resolved);
  const topLevelDirectory = relativeToTemporaryRoot.split(path.sep)[0];
  const isDedicatedTemporaryDirectory = relativeToTemporaryRoot
    && !relativeToTemporaryRoot.startsWith("..")
    && !path.isAbsolute(relativeToTemporaryRoot)
    && /^workbuddy-publish(?:$|-)/.test(topLevelDirectory);

  if (!isDedicatedTemporaryDirectory) {
    throw new Error(`stage directory must be inside a dedicated temporary directory under tmp/workbuddy-publish*: ${resolved}`);
  }
  for (const definition of distributionRoots) {
    const sourceRoot = path.join(projectRoot, definition.root);
    if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error(`stage directory cannot be inside a Skill source root: ${resolved}`);
    }
  }
  return resolved;
}

function isOwnedStageDir(stageDir) {
  const markerPath = path.join(stageDir, stageMarkerFile);
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      return marker.schemaVersion === stageMarker.schemaVersion
        && marker.platform === stageMarker.platform
        && marker.managedBy === stageMarker.managedBy;
    } catch {
      return false;
    }
  }

  // Accept a directory produced by the previous version of this script so the
  // first safe rerun can migrate it to the marker-based ownership check.
  const manifestPath = path.join(stageDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.schemaVersion === 1 && manifest.platform === platformName;
  } catch {
    return false;
  }
}

function assertOwnedStageDir(stageDir) {
  if (!fs.existsSync(stageDir)) return;
  const stats = fs.lstatSync(stageDir);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwnedStageDir(stageDir)) {
    throw new Error(`stage directory is not owned by the WorkBuddy publisher: ${stageDir}`);
  }
}

function writeStageMarker(stageDir) {
  fs.writeFileSync(path.join(stageDir, stageMarkerFile), `${JSON.stringify(stageMarker, null, 2)}\n`);
}

function loadSourceDescription(sourceDirectory) {
  const skillFile = getSkillFile(sourceDirectory);
  if (!skillFile) throw new Error(`missing SKILL.md in ${sourceDirectory}`);
  const fields = readFrontmatterFields(fs.readFileSync(skillFile, "utf8"), skillFile);
  if (!fields.description) throw new Error(`missing description in ${path.relative(projectRoot, skillFile)}`);
  return { skillFile, description: fields.description };
}

function listSourceDirectories() {
  const result = [];
  for (const definition of distributionRoots) {
    const rootDirectory = path.join(projectRoot, definition.root);
    if (!fs.existsSync(rootDirectory)) throw new Error(`Skill root not found: ${definition.root}`);
    for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(rootDirectory, entry.name);
      if (getSkillFile(directory)) {
        result.push({ ...definition, sourceSlug: entry.name, directory });
      }
    }
  }
  return result;
}

function buildTargets(options = {}) {
  const locale = options.locale || "all";
  const version = options.version || readPackageVersion();
  const sources = listSourceDirectories();
  const bySlugAndLocale = new Map(sources.map((source) => [`${source.sourceSlug}/${source.locale}`, source]));
  const registry = loadPlatformRegistry();
  const platform = registry.platforms[platformName];
  if (!platform) throw new Error(`platform ${platformName} is missing from config/publish-platforms.json`);

  return sources
    .filter((source) => locale === "all" || source.locale === locale)
    .filter((source) => !options.skill || source.sourceSlug === options.skill)
    .sort((left, right) => {
      const leftPath = path.relative(projectRoot, left.directory);
      const rightPath = path.relative(projectRoot, right.directory);
      return leftPath.localeCompare(rightPath);
    })
    .map((source) => {
      const target = resolvePlatformTarget(source.directory, platformName);
      const english = bySlugAndLocale.get(`${source.sourceSlug}/en`);
      const chinese = bySlugAndLocale.get(`${source.sourceSlug}/zh-CN`);
      const englishTarget = english ? resolvePlatformTarget(english.directory, platformName) : target;
      const chineseTarget = chinese ? resolvePlatformTarget(chinese.directory, platformName) : target;
      const current = loadSourceDescription(source.directory);
      const englishDescription = english ? loadSourceDescription(english.directory).description : current.description;
      const chineseDescription = chinese ? loadSourceDescription(chinese.directory).description : current.description;

      return {
        sourceRoot: source.root,
        sourcePath: path.relative(projectRoot, source.directory),
        sourceDirectory: source.directory,
        sourceSlug: source.sourceSlug,
        locale: source.locale,
        publishedSlug: target.slug,
        displayName: target.displayName,
        displayNameEn: target.displayNameEn || englishTarget.displayName,
        author: target.author || platform.author || "Gecho AI",
        category: target.category,
        description: current.description,
        descriptionZh: chineseDescription,
        descriptionEn: englishDescription,
        version,
        stagePath: null
      };
    });
}

const excludedDirectories = new Set([".git", ".idea", ".vscode", ".codex-plugin", "node_modules", "__pycache__"]);

function copyFilter(sourcePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) return true;
  const baseName = path.basename(sourcePath);
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => excludedDirectories.has(part))) return false;
  if (baseName === ".DS_Store" || baseName === "Thumbs.db" || baseName.startsWith(".skillatlas-")) return false;
  if (["publish.json", "skillhub-publish.json", "_meta.json"].includes(baseName)) return false;
  if (baseName.endsWith(".zip")) return false;
  return true;
}

function validateWorkbuddyFields(fields, filePath) {
  for (const required of ["name", "display_name", "display_name_en", "description", "description_zh", "description_en", "version", "author"]) {
    if (!fields[required]) throw new Error(`WorkBuddy package is missing ${required}: ${filePath}`);
  }
  for (const field of ["display_name", "display_name_en"]) {
    const length = [...String(fields[field])].length;
    if (length > maxDisplayNameCharacters) {
      throw new Error(`WorkBuddy ${field} exceeds ${maxDisplayNameCharacters} characters (${length}): ${filePath}`);
    }
  }
}

function stageSkills(options = {}) {
  const stageDir = assertSafeStageDir(options.stageDir || defaultStageDir);
  const targets = buildTargets(options);
  if (targets.length === 0) throw new Error("no publishable WorkBuddy Skills found");

  assertOwnedStageDir(stageDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  writeStageMarker(stageDir);

  for (const target of targets) {
    const stagedDirectory = path.join(stageDir, target.locale, "skills", target.publishedSlug);
    fs.mkdirSync(path.dirname(stagedDirectory), { recursive: true });
    fs.cpSync(target.sourceDirectory, stagedDirectory, {
      recursive: true,
      filter: (sourcePath) => copyFilter(sourcePath, target.sourceDirectory)
    });

    const stagedSkillFile = getSkillFile(stagedDirectory);
  const sourceText = fs.readFileSync(stagedSkillFile, "utf8");
    const stagedText = addWorkbuddyPromptSection(upsertWorkbuddyFrontmatter(sourceText, {
      name: target.publishedSlug,
      display_name: target.displayName,
      display_name_en: target.displayNameEn,
      description: target.description,
      description_zh: target.descriptionZh,
      description_en: target.descriptionEn,
      category: target.category,
      version: target.version,
      author: target.author
    }, stagedSkillFile), target.locale, stagedSkillFile);
    fs.writeFileSync(stagedSkillFile, stagedText);
    validateWorkbuddyFields(readFrontmatterFields(stagedText, stagedSkillFile), stagedSkillFile);
    target.stagePath = path.relative(projectRoot, stagedDirectory);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version: targets[0].version,
    platform: platformName,
    targets: targets.map((target) => ({
      sourcePath: target.sourcePath,
      sourceSlug: target.sourceSlug,
      locale: target.locale,
      publishedSlug: target.publishedSlug,
      displayName: target.displayName,
      displayNameEn: target.displayNameEn,
      version: target.version,
      stagePath: target.stagePath
    }))
  };
  const manifestPath = path.join(stageDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { stageDir, manifestPath, targets, manifest };
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error) throw new Error(`${command} is required: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim() || result.status}`);
  }
  return result;
}

function packageSkills(options = {}) {
  const staged = stageSkills(options);
  const archiveDirectory = path.join(staged.stageDir, "archives");
  fs.mkdirSync(archiveDirectory, { recursive: true });

  for (const target of staged.targets) {
    const archiveName = `${target.sourceSlug}-${target.locale}-v${target.version}.zip`;
    const archivePath = path.join(archiveDirectory, archiveName);
    const packageRoot = path.join(staged.stageDir, target.locale, "skills", target.publishedSlug);
    runChecked("zip", ["-q", "-X", "-r", archivePath, "."], { cwd: packageRoot });
    runChecked("unzip", ["-t", archivePath], { stdio: "ignore" });
    const archiveSize = fs.statSync(archivePath).size;
    if (archiveSize > maxArchiveBytes) {
      throw new Error(`WorkBuddy ZIP exceeds 3MB (${archiveSize} bytes): ${archivePath}`);
    }
    const listing = runChecked("unzip", ["-Z1", archivePath]).stdout.split(/\r?\n/).filter(Boolean);
    const expectedEntry = "SKILL.md";
    if (!listing.includes(expectedEntry)) {
      throw new Error(`WorkBuddy entry ${expectedEntry} is missing from ZIP: ${archivePath}`);
    }
    target.archivePath = path.relative(projectRoot, archivePath);
  }

  staged.manifest.archives = staged.targets.map((target) => ({
    locale: target.locale,
    publishedSlug: target.publishedSlug,
    archivePath: target.archivePath
  }));
  fs.writeFileSync(staged.manifestPath, `${JSON.stringify(staged.manifest, null, 2)}\n`);
  return staged;
}

function printSummary(result, packaged) {
  console.log(`Stage directory: ${result.stageDir}`);
  console.log(`Manifest:        ${result.manifestPath}`);
  console.log(`WorkBuddy Skills: ${result.targets.length}`);
  for (const target of result.targets) {
    const archive = packaged ? `\t${target.archivePath}` : "";
    console.log(`  ${target.locale}\t${target.sourceSlug} -> ${target.publishedSlug}${archive}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  const packaged = options.mode === "package" || options.mode === "dry-run";
  const result = packaged ? packageSkills(options) : stageSkills(options);
  printSummary(result, packaged);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`WorkBuddy Skill packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertSafeStageDir,
  addWorkbuddyPromptSection,
  buildTargets,
  packageSkills,
  stageSkills,
  upsertWorkbuddyFrontmatter,
  validateWorkbuddyFields
};
