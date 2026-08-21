#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  distributionRoots,
  loadPlatformRegistry,
  resolvePlatformTarget
} = require("./publish-config.js");

const projectRoot = path.resolve(__dirname, "..");
const defaultStageDir = path.join(projectRoot, "tmp", "tencent-skillhub-publish");
const sourceDefinitions = distributionRoots;

function usage() {
  return `Usage:
  ./scripts/publish-tencent-skillhub.sh [stage|dry-run|publish] [options]

Modes:
  stage       Create Tencent SkillHub-only copies (default).
  dry-run     Create copies, then run the official CLI with --dry-run.
  publish     Create copies, then publish them explicitly.

Options:
  --skill <slug>          Only process one source slug.
  --locale <all|en|zh-CN> Process English, Chinese, or both (default: all).
  --stage-dir <path>      Generated directory (must be inside this project).
  --version <version>     Override the version from package.json.
  --host <url>            SkillHub API host (default: https://api.skillhub.cn).
  --cli <path>            Official skillhub executable (default: skillhub).
  --key <key>             Tencent SkillHub key; sk-ent-* uses team publishing.
  --org-id <id>           Team organization ID (normally derived from sk-ent-*).
  --category-ids <ids>    Comma-separated team category IDs for a new Skill.
  --changelog <text>      Changelog for publish mode.
  --json                  Pass --json to the official CLI.
  -h, --help              Show this help.

Environment variables:
  TENCENT_SKILLHUB_STAGE_DIR, TENCENT_SKILLHUB_VERSION,
  TENCENT_SKILLHUB_HOST,
  TENCENT_SKILLHUB_CLI, TENCENT_SKILLHUB_KEY, TENCENT_SKILLHUB_ORG_ID,
  TENCENT_SKILLHUB_CATEGORY_IDS

Examples:
  ./scripts/publish-tencent-skillhub.sh stage
  ./scripts/publish-tencent-skillhub.sh dry-run --skill tiktok-insight
  ./scripts/publish-tencent-skillhub.sh publish --locale zh-CN
`;
}

function detectPublishMode(key) {
  if (!key) return "session";
  if (key.startsWith("sk-ent-")) return "enterprise";
  if (key.startsWith("skh_")) return "community";
  return "invalid";
}

function parseCategoryIds(value) {
  if (!value) return null;
  const ids = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length > 0 ? ids.map((id) => /^\d+$/.test(id) ? Number(id) : id) : null;
}

function buildEnterpriseRequest(target, orgId, existing, metadata) {
  const basePath = `/api/v1/orgs/${encodeURIComponent(orgId)}/skills`;
  const commonPayload = {
    version: target.version,
    displayName: target.displayName,
    summary: metadata.summary,
    changelog: metadata.changelog
  };

  if (Array.isArray(metadata.categoryIds)) commonPayload.categoryIds = metadata.categoryIds;
  if (metadata.iconUrl) commonPayload.iconUrl = metadata.iconUrl;

  if (existing) {
    return {
      method: "POST",
      path: `${basePath}/${encodeURIComponent(target.publishedSlug)}/versions`,
      payload: commonPayload
    };
  }

  return {
    method: "POST",
    path: basePath,
    payload: {
      slug: target.publishedSlug,
      ...commonPayload,
      tags: Array.isArray(metadata.tags) ? metadata.tags : []
    }
  };
}

function parseArgs(argv) {
  const args = [...argv];
  let mode = "stage";
  if (args[0] && !args[0].startsWith("-")) {
    mode = args.shift();
  }

  if (!["stage", "dry-run", "publish"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}\n\n${usage()}`);
  }

  const options = {
    mode,
    skill: null,
    locale: "all",
    stageDir: process.env.TENCENT_SKILLHUB_STAGE_DIR || defaultStageDir,
    version: process.env.TENCENT_SKILLHUB_VERSION || null,
    host: process.env.TENCENT_SKILLHUB_HOST || null,
    cli: process.env.TENCENT_SKILLHUB_CLI || null,
    key: process.env.TENCENT_SKILLHUB_KEY || null,
    orgId: process.env.TENCENT_SKILLHUB_ORG_ID || null,
    categoryIds: parseCategoryIds(process.env.TENCENT_SKILLHUB_CATEGORY_IDS),
    changelog: "",
    json: false
  };

  function nextValue(flag) {
    const value = args.shift();
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} requires a value`);
    }
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
      case "--host":
        options.host = nextValue(flag);
        break;
      case "--cli":
        options.cli = nextValue(flag);
        break;
      case "--key":
        options.key = nextValue(flag);
        break;
      case "--org-id":
        options.orgId = nextValue(flag);
        break;
      case "--category-ids":
        options.categoryIds = parseCategoryIds(nextValue(flag));
        break;
      case "--changelog":
        options.changelog = nextValue(flag);
        break;
      case "--json":
        options.json = true;
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
  const platformRegistry = loadPlatformRegistry();
  const tencentPlatform = platformRegistry.platforms["tencent-skillhub"];
  if (!tencentPlatform) {
    throw new Error("tencent-skillhub is missing from config/publish-platforms.json");
  }
  options.host = options.host || tencentPlatform.host;
  options.cli = options.cli || tencentPlatform.cli || "skillhub";
  if (!/^https?:\/\//.test(options.host)) {
    throw new Error(`--host must be an http(s) URL (got ${options.host})`);
  }

  return options;
}

function readPackageVersion() {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return packageJson.version;
}

function getSkillFile(skillDirectory) {
  for (const fileName of ["SKILL.md", "skill.md"]) {
    const filePath = path.join(skillDirectory, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function readFrontmatter(text, filePath) {
  const match = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) {
    throw new Error(`missing YAML frontmatter in ${filePath}`);
  }
  return match;
}

function validSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function buildTargets(options = {}) {
  const locale = options.locale || "all";
  const version = options.version || readPackageVersion();
  const targets = [];
  const seenPublishedSlugs = new Map();

  for (const definition of sourceDefinitions) {
    if (locale !== "all" && locale !== definition.locale) continue;

    const rootDirectory = path.join(projectRoot, definition.root);
    if (!fs.existsSync(rootDirectory)) {
      throw new Error(`Skill root not found: ${definition.root}`);
    }

    const entries = fs.readdirSync(rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const sourceSlug = entry.name;
      const sourceDirectory = path.join(rootDirectory, sourceSlug);
      const skillFile = getSkillFile(sourceDirectory);
      if (!skillFile) continue;
      if (options.skill && options.skill !== sourceSlug) continue;

      const platformTarget = resolvePlatformTarget(sourceDirectory, "tencent-skillhub");
      const publishedSlug = platformTarget.slug;
      if (!validSlug(publishedSlug)) {
        throw new Error(`invalid Tencent SkillHub slug: ${publishedSlug}`);
      }
      if (seenPublishedSlugs.has(publishedSlug)) {
        const previous = seenPublishedSlugs.get(publishedSlug);
        throw new Error(
          `duplicate Tencent SkillHub slug ${publishedSlug}: ${previous.sourcePath} and ${path.relative(projectRoot, sourceDirectory)}`
        );
      }

      const target = {
        sourceRoot: definition.root,
        sourcePath: path.relative(projectRoot, sourceDirectory),
        sourceDirectory,
        sourceSlug,
        locale: definition.locale,
        publishedSlug,
        displayName: platformTarget.displayName,
        mode: platformTarget.mode || "create",
        namespace: platformTarget.namespace,
        categoryIds: Array.isArray(platformTarget.categoryIds)
          ? platformTarget.categoryIds
          : options.categoryIds,
        iconUrl: platformTarget.iconUrl,
        tags: Array.isArray(platformTarget.tags) ? platformTarget.tags : undefined,
        version
      };
      seenPublishedSlugs.set(publishedSlug, target);
      targets.push(target);
    }
  }

  if (targets.length === 0) {
    const filter = options.skill ? ` for --skill ${options.skill}` : "";
    throw new Error(`no publishable Skills found${filter}`);
  }

  return targets;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function upsertFrontmatter(text, fields, filePath = "SKILL.md") {
  const match = readFrontmatter(text, filePath);
  const eol = match[1];
  const lines = match[2].split(/\r?\n/);
  const missing = [];

  for (const [key, value] of Object.entries(fields)) {
    const lineIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
    const replacement = `${key}: ${yamlScalar(value)}`;
    if (lineIndex === -1) {
      missing.push(replacement);
    } else {
      lines[lineIndex] = replacement;
    }
  }

  if (missing.length > 0) {
    lines.unshift(...missing);
  }

  return `---${eol}${lines.join(eol)}${eol}---${match[3]}${text.slice(match[0].length)}`;
}

function parseFrontmatterScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
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
    if (!field) continue;
    fields[field[1]] = parseFrontmatterScalar(field[2]);
  }
  return fields;
}

const publishExcludedDirectories = new Set([
  ".git",
  ".idea",
  ".vscode",
  ".codex-plugin",
  "node_modules",
  "__pycache__"
]);

function shouldUploadSkillFile(fileName) {
  return fileName !== ".DS_Store" &&
    fileName !== "Thumbs.db" &&
    !fileName.endsWith(".pyc") &&
    !fileName.endsWith(".zip") &&
    fileName !== "publish.json" &&
    fileName !== "skillhub-publish.json";
}

function collectSkillFiles(skillDirectory) {
  const rootDirectory = path.resolve(skillDirectory);
  if (!fs.existsSync(rootDirectory) || !fs.statSync(rootDirectory).isDirectory()) {
    throw new Error(`staged Skill directory not found: ${rootDirectory}`);
  }

  const files = [];
  function walk(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join("/");
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!publishExcludedDirectories.has(entry.name)) walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !shouldUploadSkillFile(entry.name)) continue;
      files.push({ path: relativePath, data: fs.readFileSync(absolutePath) });
    }
  }

  walk(rootDirectory);
  if (!files.some((file) => file.path.toLowerCase() === "skill.md")) {
    throw new Error(`staged Skill directory must contain SKILL.md: ${rootDirectory}`);
  }
  return files;
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const raw = await response.text();
  let body = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw: raw.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const detail = body && typeof body === "object"
      ? body.error || body.message || body.raw || ""
      : "";
    const error = new Error(`SkillHub enterprise request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function verifyEnterpriseKey(host, key, fetchImpl = fetch) {
  const body = await requestJson(fetchImpl, `${host.replace(/\/$/, "")}/api/v1/registry/verify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  });
  if (!body || body.orgId === undefined || body.orgId === null) {
    throw new Error("SkillHub enterprise key verification did not return orgId");
  }
  return body;
}

async function getEnterpriseSkill(host, orgId, slug, key, fetchImpl = fetch) {
  const url = `${host.replace(/\/$/, "")}/api/v1/orgs/${encodeURIComponent(String(orgId))}/skills/${encodeURIComponent(slug)}`;
  try {
    return await requestJson(fetchImpl, url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      }
    });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function extractCategoryIds(skill) {
  const categoryIds = Array.isArray(skill?.categoryIds) ? skill.categoryIds : [];
  if (categoryIds.length > 0) return categoryIds;
  const detail = skill?.skill || skill;
  if (Array.isArray(detail?.categories)) {
    return detail.categories.map((category) => category?.id).filter((id) => id !== undefined && id !== null);
  }
  if (detail?.category?.id !== undefined && detail.category.id !== null) {
    return [detail.category.id];
  }
  return [];
}

async function getEnterpriseCategories(host, orgId, key, fetchImpl = fetch) {
  const url = `${host.replace(/\/$/, "")}/api/v1/orgs/${encodeURIComponent(String(orgId))}/categories`;
  const body = await requestJson(fetchImpl, url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  return Array.isArray(body?.categories) ? body.categories : [];
}

function loadStoredEnterpriseCredential(host) {
  const credentialsPath = path.join(os.homedir(), ".skillhub", "credentials.json");
  if (!fs.existsSync(credentialsPath)) return null;

  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  } catch {
    return null;
  }
  const stored = Object.values(credentials.orgs || {}).filter((entry) => {
    return entry && typeof entry.apiKey === "string" && entry.apiKey.startsWith("sk-ent-") &&
      (!entry.host || entry.host === host);
  });
  if (stored.length > 1) {
    throw new Error("multiple Tencent enterprise credentials match this host; set TENCENT_SKILLHUB_KEY explicitly");
  }
  if (stored.length !== 1) return null;
  const entry = stored[0];
  return {
    key: entry.apiKey,
    orgId: entry.orgId === undefined ? null : String(entry.orgId)
  };
}

async function publishEnterpriseTarget(target, context = {}) {
  const key = String(context.key || "").trim();
  if (detectPublishMode(key) !== "enterprise") {
    throw new Error("team publishing requires a Tencent enterprise key starting with sk-ent-");
  }
  const host = String(context.host || "https://api.skillhub.cn").replace(/\/$/, "");
  const rootDirectory = path.resolve(context.projectRoot || projectRoot);
  let orgId = context.orgId ? String(context.orgId) : "";
  if (!orgId) {
    const verified = await verifyEnterpriseKey(host, key, context.fetchImpl || fetch);
    orgId = String(verified.orgId);
  }

  const stagedDirectory = path.resolve(rootDirectory, target.stagePath);
  const stagedSkillFile = getSkillFile(stagedDirectory);
  if (!stagedSkillFile) throw new Error(`staged Skill is missing SKILL.md: ${stagedDirectory}`);
  const frontmatter = readFrontmatterFields(fs.readFileSync(stagedSkillFile, "utf8"), stagedSkillFile);
  const files = collectSkillFiles(stagedDirectory);
  const existing = await getEnterpriseSkill(host, orgId, target.publishedSlug, key, context.fetchImpl || fetch);

  if (target.mode === "create" && existing) {
    throw new Error(`Tencent SkillHub team Skill already exists: ${target.publishedSlug}; use update-or-create or update mode to publish a version`);
  }
  if (target.mode === "update" && !existing) {
    throw new Error(`Tencent SkillHub team Skill does not exist: ${target.publishedSlug}; use create or update-or-create mode`);
  }

  const inheritedCategoryIds = extractCategoryIds(existing);
  const categoryIds = target.categoryIds ||
    (inheritedCategoryIds.length > 0 ? inheritedCategoryIds : context.categoryIds);
  if (!existing && (!Array.isArray(categoryIds) || categoryIds.length === 0)) {
    let categoryHint = "";
    try {
      const categories = await getEnterpriseCategories(host, orgId, key, context.fetchImpl || fetch);
      categoryHint = categories
        .map((category) => `${category.displayNameZh || category.name || category.id}=${category.id}`)
        .filter((item) => !item.endsWith("=undefined"))
        .join(", ");
    } catch {
      // The validation error below is still actionable when the category endpoint is unavailable.
    }
    throw new Error(
      `new Tencent SkillHub team Skill requires category IDs: ${target.publishedSlug}` +
      (categoryHint ? `; available categories: ${categoryHint}` : "; pass --category-ids <id[,id...]> or configure platforms.tencent-skillhub.categoryIds")
    );
  }
  const request = buildEnterpriseRequest(target, orgId, Boolean(existing), {
    summary: frontmatter.description || frontmatter.summary || "",
    changelog: context.changelog || "",
    categoryIds,
    iconUrl: target.iconUrl,
    tags: target.tags
  });
  const form = new FormData();
  form.append("payload", JSON.stringify(request.payload));
  for (const file of files) {
    const type = file.path.toLowerCase().endsWith(".md") ? "text/markdown" : "application/octet-stream";
    form.append("files", new Blob([file.data], { type }), file.path);
  }

  const response = await requestJson(context.fetchImpl || fetch, `${host}${request.path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    },
    body: form
  });
  return {
    orgId,
    existing: Boolean(existing),
    request,
    response
  };
}

function assertSafeStageDir(stageDir) {
  const resolvedStageDir = path.resolve(projectRoot, stageDir);
  const projectPrefix = `${projectRoot}${path.sep}`;
  if (!resolvedStageDir.startsWith(projectPrefix)) {
    throw new Error(`stage directory must be inside the project: ${resolvedStageDir}`);
  }
  if (resolvedStageDir === projectRoot) {
    throw new Error("refusing to use the project root as the stage directory");
  }

  for (const definition of sourceDefinitions) {
    const sourceDirectory = path.join(projectRoot, definition.root);
    if (resolvedStageDir === sourceDirectory || resolvedStageDir.startsWith(`${sourceDirectory}${path.sep}`)) {
      throw new Error(`stage directory cannot be inside a Skill source root: ${resolvedStageDir}`);
    }
  }
  return resolvedStageDir;
}

function copyFilter(sourcePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) return true;
  const parts = relativePath.split(path.sep);
  const baseName = path.basename(sourcePath);
  if (parts.includes(".git") || parts.includes(".idea") || parts.includes(".codex-plugin")) return false;
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

    const stagedSkillFile = getSkillFile(stagedDirectory);
    const stagedText = fs.readFileSync(stagedSkillFile, "utf8");
    const updatedText = upsertFrontmatter(stagedText, {
      slug: target.publishedSlug,
      version: target.version,
      displayName: target.displayName
    }, stagedSkillFile);
    fs.writeFileSync(stagedSkillFile, updatedText);
    target.stagePath = path.relative(projectRoot, stagedDirectory);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version: targets[0].version,
    platform: "tencent-skillhub",
    namespace: targets[0].namespace,
    targets: targets.map((target) => ({
      sourceRoot: target.sourceRoot,
      sourcePath: target.sourcePath,
      locale: target.locale,
      sourceSlug: target.sourceSlug,
      publishedSlug: target.publishedSlug,
      displayName: target.displayName,
      mode: target.mode,
      version: target.version,
      stagePath: target.stagePath
    }))
  };
  const manifestPath = path.join(stageDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { stageDir, manifestPath, targets, manifest };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function runCli(mode, options, staged) {
  const versionResult = spawnSync(options.cli, ["--version"], { stdio: "ignore" });
  if (versionResult.error) {
    throw new Error(`Tencent SkillHub CLI not found: ${options.cli}. Install it from https://skillhub.cn/install/skillhub.md`);
  }

  if (mode === "publish" && options.key) {
    runCommand(options.cli, [
      "login",
      "--key",
      options.key,
      "--host",
      options.host
    ]);
  } else if (mode === "publish") {
    console.warn("TENCENT_SKILLHUB_KEY is not set; publish will use the CLI's existing login session.");
  }

  for (const target of staged.targets) {
    const args = ["publish", path.join(projectRoot, target.stagePath), "--host", options.host];
    if (mode === "dry-run") args.push("--dry-run");
    if (options.json) args.push("--json");
    if (mode === "publish" && options.changelog) args.push("--changelog", options.changelog);

    console.log(`${mode === "dry-run" ? "Dry-running" : "Publishing"} ${target.locale}/${target.publishedSlug}`);
    runCommand(options.cli, args);
  }
}

async function runEnterprisePublish(options, staged) {
  let key = options.key;
  let orgId = options.orgId;
  if (!key) {
    const stored = loadStoredEnterpriseCredential(options.host.replace(/\/$/, ""));
    if (stored) {
      key = stored.key;
      orgId = orgId || stored.orgId;
      console.log("Using the stored Tencent SkillHub enterprise credential.");
    }
  }
  if (detectPublishMode(key) !== "enterprise") {
    throw new Error("team publishing requires TENCENT_SKILLHUB_KEY or --key with a sk-ent-... enterprise key");
  }

  if (!orgId) {
    console.log("Verifying Tencent SkillHub enterprise key...");
    const verified = await verifyEnterpriseKey(options.host, key);
    orgId = String(verified.orgId);
  }

  for (const target of staged.targets) {
    console.log(`Enterprise publishing ${target.locale}/${target.publishedSlug} (${target.mode})`);
    const result = await publishEnterpriseTarget(target, {
      host: options.host,
      key,
      orgId,
      projectRoot,
      changelog: options.changelog,
      categoryIds: options.categoryIds
    });
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        orgId: result.orgId,
        slug: target.publishedSlug,
        version: target.version,
        action: result.existing ? "version" : "create",
        response: result.response
      }));
    } else {
      const action = result.existing ? "version submitted" : "Skill submitted";
      const status = result.response && (result.response.status || result.response.reviewStatus || "accepted");
      console.log(`✓ ${action}: ${target.publishedSlug}@${target.version} (${status})`);
    }
  }
}

function printSummary(staged) {
  console.log(`Stage directory: ${staged.stageDir}`);
  console.log(`Manifest:        ${staged.manifestPath}`);
  console.log(`Staged Skills:   ${staged.targets.length}`);
  for (const target of staged.targets) {
    console.log(`  ${target.locale}\t${target.sourceSlug} -> ${target.publishedSlug}\t${target.mode}\t${target.displayName}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const staged = stageSkills(options);
  printSummary(staged);
  if (options.mode !== "stage") {
    const publishMode = detectPublishMode(options.key);
    if (options.mode === "publish" && publishMode === "enterprise") {
      await runEnterprisePublish(options, staged);
    } else {
      if (options.mode === "publish" && publishMode === "invalid") {
        throw new Error("invalid Tencent SkillHub key; use skh_... for community publishing or sk-ent-... for team publishing");
      }
      runCli(options.mode, options, staged);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Tencent SkillHub publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildEnterpriseRequest,
  buildTargets,
  detectPublishMode,
  publishEnterpriseTarget,
  stageSkills,
  upsertFrontmatter
};
