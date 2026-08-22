#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  listDistributionSkills,
  loadPlatformRegistry,
  projectRoot,
  resolvePlatformTarget
} = require("./publish-config.js");

const defaultStageDir = path.join(projectRoot, "tmp", "clawhub-publish");
const textExtensions = new Set([
  "md", "mdx", "txt", "json", "json5", "yaml", "yml", "toml", "js", "cjs", "mjs",
  "ts", "tsx", "jsx", "py", "sh", "ps1", "psm1", "psd1", "r", "rb", "go", "rs",
  "swift", "kt", "java", "cs", "cpp", "c", "h", "hpp", "sql", "csv", "tsv", "ini",
  "cfg", "conf", "env", "properties", "dat", "xml", "html", "css", "scss", "sass", "svg"
]);

function usage() {
  return `Usage:
  ./scripts/publish-clawhub-skills.sh [stage|dry-run|publish] [options]

Modes:
  stage       Create ClawHub-specific copies (default).
  dry-run     Compare copies with ClawHub and show publish commands.
  publish     Publish changed copies with their configured identity.

Options:
  --skill <slug>          Only process one source slug.
  --locale <all|en|zh-CN> Process English, Chinese, or both (default: all).
  --stage-dir <path>      Generated directory (must be inside this project).
  --version <version>     Override the package version used for publication.
  --registry <url>        ClawHub registry URL.
  --cli <path>            ClawHub executable (default: clawhub).
  --changelog <text>      Changelog for publish mode.
  --tags <tags>           Comma-separated tags (default: latest).
  --no-validate           Skip repository Skill validation.
  -h, --help              Show this help.

Examples:
  ./scripts/publish-clawhub-skills.sh stage
  ./scripts/publish-clawhub-skills.sh dry-run --skill tiktok-insight --locale zh-CN
  ./scripts/publish-clawhub-skills.sh publish --locale zh-CN
`;
}

function parseArgs(argv) {
  const args = [...argv];
  let mode = "stage";
  if (args[0] && !args[0].startsWith("-")) mode = args.shift();
  if (!["stage", "dry-run", "publish"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}\n\n${usage()}`);
  }

  const options = {
    mode,
    skill: null,
    locale: "all",
    stageDir: process.env.CLAWHUB_STAGE_DIR || defaultStageDir,
    version: process.env.CLAWHUB_VERSION || null,
    registry: process.env.CLAWHUB_REGISTRY || null,
    cli: process.env.CLAWHUB_CLI || "clawhub",
    changelog: process.env.CLAWHUB_CHANGELOG || "",
    tags: process.env.CLAWHUB_TAGS || "latest",
    validate: process.env.SKILL_VALIDATE !== "0"
  };

  function nextValue(flag) {
    const value = args.shift();
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
    return value;
  }

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--skill":
        options.skill = nextValue(flag);
        break;
      case "--locale":
        options.locale = nextValue(flag);
        break;
      case "--stage-dir":
        options.stageDir = nextValue(flag);
        break;
      case "--version":
        options.version = nextValue(flag);
        break;
      case "--registry":
        options.registry = nextValue(flag);
        break;
      case "--cli":
        options.cli = nextValue(flag);
        break;
      case "--changelog":
        options.changelog = nextValue(flag);
        break;
      case "--tags":
        options.tags = nextValue(flag);
        break;
      case "--no-validate":
        options.validate = false;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}\n\n${usage()}`);
    }
  }

  if (!["all", "en", "zh-CN"].includes(options.locale)) {
    throw new Error(`--locale must be all, en, or zh-CN (got ${options.locale})`);
  }
  const registry = loadPlatformRegistry().platforms.clawhub;
  if (!registry) throw new Error("clawhub is missing from config/publish-platforms.json");
  options.registry = options.registry || registry.registry;
  options.owner = registry.owner;
  if (!/^https?:\/\//.test(options.registry)) {
    throw new Error(`--registry must be an http(s) URL (got ${options.registry})`);
  }
  return options;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return packageJson.version;
}

function validSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function buildTargets(options = {}) {
  const locale = options.locale || "all";
  const version = options.version || readPackageVersion();
  const targets = [];
  const seen = new Map();

  for (const skill of listDistributionSkills()) {
    if (locale !== "all" && skill.locale !== locale) continue;
    if (options.skill && options.skill !== skill.sourceSlug) continue;

    const platformTarget = resolvePlatformTarget(skill.directory, "clawhub");
    if (!validSlug(platformTarget.slug)) {
      throw new Error(`invalid ClawHub slug: ${platformTarget.slug}`);
    }
    if (seen.has(platformTarget.slug)) {
      const previous = seen.get(platformTarget.slug);
      throw new Error(
        `duplicate ClawHub slug ${platformTarget.slug}: ${previous.sourcePath} and ${skill.sourcePath}`
      );
    }

    const target = {
      sourceRoot: skill.sourceRoot,
      sourcePath: skill.sourcePath,
      sourceDirectory: skill.directory,
      sourceSlug: skill.sourceSlug,
      locale: skill.locale,
      publishedSlug: platformTarget.slug,
      displayName: platformTarget.displayName,
      version,
      stagePath: null
    };
    seen.set(target.publishedSlug, target);
    targets.push(target);
  }

  if (targets.length === 0) {
    const filter = options.skill ? ` for --skill ${options.skill}` : "";
    throw new Error(`no publishable Skills found${filter}`);
  }
  return targets;
}

function assertSafeStageDir(stageDir) {
  const resolved = path.resolve(projectRoot, stageDir);
  const prefix = `${projectRoot}${path.sep}`;
  if (!resolved.startsWith(prefix) || resolved === projectRoot) {
    throw new Error(`stage directory must be inside the project: ${resolved}`);
  }
  for (const root of ["distribution-skills", "distribution-skills-zh-CN"]) {
    const sourceRoot = path.join(projectRoot, root);
    if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error(`stage directory cannot be inside a Skill source root: ${resolved}`);
    }
  }
  return resolved;
}

function copyFilter(sourcePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) return true;
  const parts = relativePath.split(path.sep);
  const baseName = path.basename(sourcePath);
  if (parts.some((part) => part === ".git" || part === ".idea" || part === ".codex-plugin")) return false;
  if (baseName === ".DS_Store" || baseName.startsWith(".skillatlas-")) return false;
  if (baseName === "publish.json" || baseName === "skillhub-publish.json") return false;
  if (baseName.endsWith(".zip")) return false;
  return true;
}

function stageSkills(options = {}) {
  const stageDir = assertSafeStageDir(options.stageDir || defaultStageDir);
  const targets = buildTargets(options);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const target of targets) {
    const stagedDirectory = path.join(stageDir, target.locale, target.publishedSlug);
    fs.mkdirSync(path.dirname(stagedDirectory), { recursive: true });
    fs.cpSync(target.sourceDirectory, stagedDirectory, {
      recursive: true,
      filter: (sourcePath) => copyFilter(sourcePath, target.sourceDirectory)
    });
    target.stagePath = path.relative(projectRoot, stagedDirectory);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version: targets[0].version,
    platform: "clawhub",
    owner: loadPlatformRegistry().platforms.clawhub.owner,
    targets: targets.map((target) => ({
      sourceRoot: target.sourceRoot,
      sourcePath: target.sourcePath,
      locale: target.locale,
      sourceSlug: target.sourceSlug,
      publishedSlug: target.publishedSlug,
      displayName: target.displayName,
      version: target.version,
      stagePath: target.stagePath
    }))
  };
  const manifestPath = path.join(stageDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { stageDir, manifestPath, targets, manifest };
}

function buildPublishOptions(target, options = {}) {
  return {
    slug: target.publishedSlug,
    name: target.displayName,
    owner: options.owner,
    version: options.version || target.version,
    tags: options.tags || "latest"
  };
}

function fileExtension(filePath) {
  const name = path.basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isLikelyText(buffer) {
  if (buffer.subarray(0, 4096).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, 4096));
    return true;
  } catch {
    return false;
  }
}

function listHashableFiles(root, current = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const relativePath = path.join(current, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...listHashableFiles(root, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "publish.json" || entry.name === "skillhub-publish.json") continue;
    const bytes = fs.readFileSync(absolutePath);
    const extension = fileExtension(relativePath);
    if ((extension && !textExtensions.has(extension)) || (!extension && !isLikelyText(bytes))) continue;
    files.push({ path: relativePath.split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  return files;
}

function fingerprintSkill(directory) {
  const files = listHashableFiles(directory)
    .sort((left, right) => left.path.localeCompare(right.path));
  const payload = files.map((file) => `${file.path}:${file.sha256}`).join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function resolveRemote(registry, target, fingerprint) {
  const url = new URL("/api/v1/resolve", registry);
  url.searchParams.set("slug", target.publishedSlug);
  url.searchParams.set("hash", fingerprint);
  const response = await fetch(url);
  if (response.status === 404) return { match: null, latestVersion: null };
  if (!response.ok) throw new Error(`ClawHub resolve failed for ${target.publishedSlug}: HTTP ${response.status}`);
  const body = await response.json();
  return {
    match: body.match?.version || null,
    latestVersion: body.latestVersion?.version || null
  };
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function prepareCandidates(staged, options) {
  const candidates = [];
  for (const target of staged.targets) {
    const directory = path.join(projectRoot, target.stagePath);
    const fingerprint = fingerprintSkill(directory);
    const remote = await resolveRemote(options.registry, target, fingerprint);
    const status = remote.match ? "synced" : remote.latestVersion ? "update" : "new";
    if (status === "update" && compareVersions(target.version, remote.latestVersion) <= 0) {
      throw new Error(
        `${target.publishedSlug}: local version ${target.version} must be greater than ClawHub ${remote.latestVersion}`
      );
    }
    candidates.push({ ...target, directory, fingerprint, status, latestVersion: remote.latestVersion });
  }
  return candidates;
}

function splitCommand(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runCommand(commandParts, args) {
  const result = spawnSync(commandParts[0], [...commandParts.slice(1), ...args], { stdio: "inherit" });
  if (result.error) throw new Error(`failed to run ${commandParts.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${commandParts.join(" ")} exited with status ${result.status}`);
}

function runCli(mode, options, candidates) {
  const commandParts = splitCommand(options.cli);
  const versionResult = spawnSync(commandParts[0], [...commandParts.slice(1), "--version"], { stdio: "ignore" });
  if (versionResult.error) throw new Error(`ClawHub CLI not found: ${options.cli}`);

  const actionable = candidates.filter((candidate) => candidate.status !== "synced");
  for (const candidate of candidates.filter((item) => item.status === "synced")) {
    console.log(`  synced ${candidate.locale}/${candidate.publishedSlug}`);
  }
  for (const target of actionable) {
    const publishOptions = buildPublishOptions(target, options);
    const args = [
      "skill", "publish", target.directory,
      "--slug", publishOptions.slug,
      "--name", publishOptions.name,
      "--owner", publishOptions.owner,
      "--version", publishOptions.version,
      "--tags", publishOptions.tags
    ];
    if (options.changelog) args.push("--changelog", options.changelog);
    const command = [options.cli, ...args].map(shellQuote).join(" ");
    if (mode === "dry-run") {
      console.log(`  ${target.status} ${target.locale}/${target.publishedSlug}: ${command}`);
    } else {
      console.log(`Publishing ${target.locale}/${target.publishedSlug}`);
      runCommand(commandParts, args);
    }
  }
  console.log(`${mode === "dry-run" ? "Would publish" : "Published"} ${actionable.length} Skill(s).`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.validate) {
    const validation = spawnSync(
      process.execPath,
      [path.join(projectRoot, "scripts/validate-skills.js")],
      { stdio: "inherit" }
    );
    if (validation.status !== 0) throw new Error("Skill validation failed");

    const configCheck = spawnSync(
      process.execPath,
      [path.join(projectRoot, "scripts/generate-publish-configs.js"), "--check"],
      { stdio: "inherit" }
    );
    if (configCheck.status !== 0) {
      throw new Error("platform publish config check failed");
    }
  }

  const staged = stageSkills(options);
  console.log(`Stage directory: ${staged.stageDir}`);
  console.log(`Manifest:        ${staged.manifestPath}`);
  console.log(`Staged Skills:   ${staged.targets.length}`);
  if (options.mode === "stage") return;

  const candidates = await prepareCandidates(staged, options);
  runCli(options.mode, options, candidates);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ClawHub publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPublishOptions,
  buildTargets,
  fingerprintSkill,
  stageSkills
};
