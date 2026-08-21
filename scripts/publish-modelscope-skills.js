#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  listDistributionSkills,
  loadPlatformRegistry,
  projectRoot,
  resolvePlatformTarget
} = require("./publish-config.js");

const defaultStageDir = path.join(projectRoot, "tmp", "modelscope-publish");
const maxArchiveBytes = 5 * 1024 * 1024;
const distributionRoots = [
  { root: "distribution-skills", locale: "en" },
  { root: "distribution-skills-zh-CN", locale: "zh-CN" }
];

function usage() {
  return `Usage:
  ./scripts/publish-modelscope-skills.sh [stage|dry-run|publish|verify] [options]

Modes:
  stage       Create ModelScope-specific copies and ZIP archives (default).
  dry-run     Create copies and show planned create/update/skip actions.
  publish     Create copies and publish or update Skills through OpenAPI.
  verify      Query published Skills and verify their configured identity/version.

Options:
  --skill <slug>          Only process one source slug.
  --locale <all|en|zh-CN> Process English, Chinese, or both (default: all).
  --stage-dir <path>      Generated directory inside this project.
  --version <version>     Override the version read from _meta.json.
  --endpoint <url>        ModelScope endpoint (default: https://modelscope.cn).
  --force                 Update even when the remote version equals the local version.
  --no-validate           Skip repository Skill validation.
  -h, --help              Show this help.

Environment variables:
  MODELSCOPE_API_KEY, MODELSCOPE_ENDPOINT, MODELSCOPE_STAGE_DIR,
  MODELSCOPE_VERSION, MODELSCOPE_FORCE, SKILL_VALIDATE
`;
}

function parseArgs(argv) {
  const args = [...argv];
  let mode = "stage";
  if (args[0] && !args[0].startsWith("-")) mode = args.shift();
  if (!["stage", "dry-run", "publish", "verify"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}\n\n${usage()}`);
  }

  const options = {
    mode,
    skill: null,
    locale: "all",
    stageDir: process.env.MODELSCOPE_STAGE_DIR || defaultStageDir,
    version: process.env.MODELSCOPE_VERSION || null,
    endpoint: process.env.MODELSCOPE_ENDPOINT || null,
    force: process.env.MODELSCOPE_FORCE === "1",
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
      case "--endpoint":
        options.endpoint = nextValue(flag);
        break;
      case "--force":
        options.force = true;
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
  const platform = loadPlatformRegistry().platforms.modelscope;
  if (!platform) throw new Error("modelscope is missing from config/publish-platforms.json");
  options.endpoint = options.endpoint || platform.host || "https://modelscope.cn";
  if (!/^https?:\/\//.test(options.endpoint)) {
    throw new Error(`--endpoint must be an http(s) URL (got ${options.endpoint})`);
  }
  options.endpoint = options.endpoint.replace(/\/$/, "");
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${label} at ${path.relative(projectRoot, filePath)}: ${error.message}`);
  }
}

function readPackageVersion() {
  return readJson(path.join(projectRoot, "package.json"), "package.json").version;
}

function readSkillVersion(skillDirectory) {
  const metadataPath = path.join(skillDirectory, "_meta.json");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`missing _meta.json: ${path.relative(projectRoot, metadataPath)}`);
  }
  const version = readJson(metadataPath, "_meta.json").version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid Skill version in ${path.relative(projectRoot, metadataPath)}: ${version}`);
  }
  return version;
}

function readFrontmatter(text, filePath) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`missing YAML frontmatter in ${path.relative(projectRoot, filePath)}`);
  return { header: match[1], prefix: match[0], body: text.slice(match[0].length) };
}

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readDescription(skillDirectory) {
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const text = fs.readFileSync(skillPath, "utf8");
  const { header } = readFrontmatter(text, skillPath);
  const lines = header.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description:\s*/.test(line));
  if (index === -1) throw new Error(`missing description in ${path.relative(projectRoot, skillPath)}`);
  const value = lines[index].replace(/^description:\s*/, "");
  if (value === ">-" || value === ">" || value === "|" || value === "|-") {
    const continuation = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!/^\s+/.test(lines[cursor])) break;
      continuation.push(lines[cursor].trim());
    }
    return continuation.join(" ").trim();
  }
  return parseScalar(value);
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function upsertFrontmatter(text, fields, filePath) {
  const parsed = readFrontmatter(text, filePath);
  const lines = parsed.header.split(/\r?\n/);
  const missing = [];

  for (const [key, value] of Object.entries(fields)) {
    const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
    const replacement = `${key}: ${yamlScalar(value)}`;
    if (index === -1) missing.push(replacement);
    else lines[index] = replacement;
  }

  if (missing.length > 0) lines.unshift(...missing);
  return `---\n${lines.join("\n")}\n---\n${parsed.body}`;
}

function validSkillName(skillName) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName);
}

function assertSafeStageDir(stageDir) {
  const resolved = path.resolve(projectRoot, stageDir);
  const prefix = `${projectRoot}${path.sep}`;
  if (!resolved.startsWith(prefix) || resolved === projectRoot) {
    throw new Error(`stage directory must be inside the project: ${resolved}`);
  }
  for (const definition of distributionRoots) {
    const root = path.join(projectRoot, definition.root);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`stage directory cannot be inside a Skill source root: ${resolved}`);
    }
  }
  return resolved;
}

function shouldCopy(sourcePath, sourceRoot) {
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  const baseName = path.basename(sourcePath);
  if (parts.some((part) => [".git", ".idea", ".vscode", ".codex-plugin", "node_modules", "__pycache__"].includes(part))) return false;
  if ([".DS_Store", "Thumbs.db", "publish.json", "skillhub-publish.json", "_meta.json"].includes(baseName)) return false;
  if (baseName.startsWith(".skillatlas-") || baseName.endsWith(".zip")) return false;
  return true;
}

function runZip(sourceDirectory, archivePath) {
  const result = spawnSync("zip", ["-q", "-X", "-r", archivePath, "."], {
    cwd: sourceDirectory,
    encoding: "utf8"
  });
  if (result.error) throw new Error(`zip is required to package ModelScope Skills: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`zip failed for ${sourceDirectory}: ${result.stderr || result.status}`);

  const check = spawnSync("unzip", ["-t", archivePath], { encoding: "utf8" });
  if (check.error || check.status !== 0) throw new Error(`invalid ModelScope archive: ${archivePath}`);
  const listing = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  const entries = (listing.stdout || "").split(/\r?\n/).filter(Boolean);
  const rootFiles = entries.filter((entry) => !entry.includes("/") && !entry.endsWith("/"));
  if (listing.error || listing.status !== 0 || rootFiles.length !== 1 || rootFiles[0] !== "SKILL.md") {
    throw new Error(`ModelScope archive must contain SKILL.md at its root: ${archivePath}`);
  }
  if (fs.statSync(archivePath).size > maxArchiveBytes) {
    throw new Error(`ModelScope archive exceeds 5 MB: ${archivePath}`);
  }
}

function buildTargets(options = {}) {
  const locale = options.locale || "all";
  const configuredVersion = options.version || null;
  const registry = loadPlatformRegistry();
  const platform = registry.platforms.modelscope;
  const owner = platform.owner || platform.namespace;
  if (!owner) throw new Error("ModelScope owner is missing from config/publish-platforms.json");

  const targets = [];
  const seen = new Map();
  for (const skill of listDistributionSkills()) {
    if (locale !== "all" && skill.locale !== locale) continue;
    if (options.skill && options.skill !== skill.sourceSlug) continue;

    const configured = resolvePlatformTarget(skill.directory, "modelscope");
    if (!validSkillName(configured.slug)) {
      throw new Error(`invalid ModelScope skill_name: ${configured.slug}`);
    }
    if (seen.has(configured.slug)) {
      throw new Error(`duplicate ModelScope skill_name ${configured.slug}: ${seen.get(configured.slug)} and ${skill.sourcePath}`);
    }
    const version = configuredVersion || readSkillVersion(skill.directory);
    const target = {
      owner,
      sourceRoot: skill.sourceRoot,
      sourcePath: skill.sourcePath,
      sourceDirectory: skill.directory,
      sourceSlug: skill.sourceSlug,
      locale: skill.locale,
      skillName: configured.slug,
      displayName: configured.displayName,
      version,
      description: readDescription(skill.directory),
      category: configured.category || platform.category,
      license: configured.license || platform.license,
      sourceUrl: configured.sourceUrl || platform.sourceUrl,
      tags: Array.isArray(configured.tags) ? configured.tags : undefined,
      stagePath: null,
      archivePath: null
    };
    seen.set(target.skillName, skill.sourcePath);
    targets.push(target);
  }
  if (targets.length === 0) {
    const filter = options.skill ? ` for --skill ${options.skill}` : "";
    throw new Error(`no publishable ModelScope Skills found${filter}`);
  }
  return targets;
}

function stageSkills(options = {}) {
  const stageDir = assertSafeStageDir(options.stageDir || defaultStageDir);
  const targets = buildTargets(options);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const target of targets) {
    const stagedDirectory = path.join(stageDir, target.locale, target.skillName);
    fs.mkdirSync(path.dirname(stagedDirectory), { recursive: true });
    fs.cpSync(target.sourceDirectory, stagedDirectory, {
      recursive: true,
      filter: (sourcePath) => shouldCopy(sourcePath, target.sourceDirectory)
    });

    const skillPath = path.join(stagedDirectory, "SKILL.md");
    if (!fs.existsSync(skillPath)) throw new Error(`staged Skill is missing SKILL.md: ${stagedDirectory}`);
    fs.writeFileSync(skillPath, upsertFrontmatter(
      fs.readFileSync(skillPath, "utf8"),
      { version: target.version },
      skillPath
    ));

    const archivePath = path.join(stageDir, target.locale, `${target.skillName}-v${target.version}.zip`);
    runZip(stagedDirectory, archivePath);
    target.stagePath = path.relative(projectRoot, stagedDirectory);
    target.archivePath = archivePath;
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: "modelscope",
    owner: targets[0].owner,
    targets: targets.map((target) => ({
      sourcePath: target.sourcePath,
      sourceSlug: target.sourceSlug,
      locale: target.locale,
      skillName: target.skillName,
      displayName: target.displayName,
      version: target.version,
      stagePath: target.stagePath,
      archivePath: path.relative(projectRoot, target.archivePath)
    }))
  };
  const manifestPath = path.join(stageDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { stageDir, manifestPath, targets, manifest };
}

function parseVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`invalid semantic version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ""];
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] > b[3] ? 1 : -1;
}

function decideAction(localVersion, remote, options = {}) {
  if (!remote) return "create";
  const remoteVersion = remote.version;
  if (!remoteVersion) {
    if (options.force) return "update";
    throw new Error("remote Skill does not expose a version; use --force to update explicitly");
  }
  const comparison = compareVersions(localVersion, remoteVersion);
  if (comparison < 0) {
    throw new Error(`remote version ${remoteVersion} is newer than local version ${localVersion}`);
  }
  if (comparison === 0 && !options.force) return "skip";
  return "update";
}

function apiUrl(endpoint, route) {
  return `${String(endpoint).replace(/\/$/, "")}${route}`;
}

function authHeaders(token, contentType = false) {
  if (!token) throw new Error("MODELSCOPE_API_KEY is required for ModelScope API operations");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };
  if (contentType) headers["Content-Type"] = "application/json";
  return headers;
}

async function requestJson(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const wrapped = new Error(`ModelScope request could not be completed: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }

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
      ? body.message || body.error || body.raw || ""
      : "";
    const error = new Error(
      `ModelScope request failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function unwrapData(body) {
  return body && body.data !== undefined ? body.data : body;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) || null;
}

function normalizeRemoteSkill(body) {
  const data = unwrapData(body) || {};
  const skill = data.skill && typeof data.skill === "object" ? data.skill : data;
  const id = firstString(skill.id, data.id);
  const idMatch = id && id.match(/^@?([^/]+)\/(.+)$/);
  return {
    raw: body,
    id,
    owner: firstString(skill.owner, data.owner, idMatch && idMatch[1]),
    skillName: firstString(
      skill.skill_name,
      skill.skillName,
      data.skill_name,
      data.skillName,
      idMatch && idMatch[2]
    ),
    displayName: firstString(skill.display_name, skill.displayName, data.display_name, data.displayName),
    version: firstString(
      skill.version,
      skill.skill_version,
      skill.skillVersion,
      skill.latest_version,
      skill.latestVersion,
      data.version,
      data.skill_version,
      data.skillVersion,
      data.latest_version,
      data.latestVersion
    ),
    description: firstString(skill.description, data.description),
    sourceUrl: firstString(skill.source_url, skill.sourceUrl, data.source_url, data.sourceUrl)
  };
}

function skillRoute(target) {
  return `/openapi/v1/skills/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.skillName)}`;
}

async function getRemoteSkill(target, context = {}) {
  const fetchImpl = context.fetchImpl || fetch;
  try {
    const body = await requestJson(fetchImpl, apiUrl(context.endpoint, skillRoute(target)), {
      method: "GET",
      headers: authHeaders(context.token)
    });
    return normalizeRemoteSkill(body);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function buildSkillPayload(target, skillFileId, includeIdentity) {
  const payload = {};
  if (includeIdentity) {
    payload.owner = target.owner;
    payload.skill_name = target.skillName;
  }
  payload.display_name = target.displayName;
  payload.description = target.description;
  payload.skill_file = skillFileId;
  for (const [key, value] of [
    ["category", target.category],
    ["license", target.license],
    ["source_url", target.sourceUrl]
  ]) {
    if (value !== undefined && value !== null && value !== "") payload[key] = value;
  }
  if (Array.isArray(target.tags)) payload.tags = target.tags;
  return payload;
}

async function uploadSkill(target, context = {}) {
  const fetchImpl = context.fetchImpl || fetch;
  if (!target.archivePath || !fs.existsSync(target.archivePath)) {
    throw new Error(`ModelScope archive not found: ${target.archivePath || target.skillName}`);
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([fs.readFileSync(target.archivePath)], { type: "application/zip" }),
    path.basename(target.archivePath)
  );
  form.append("type", "skill");
  const body = await requestJson(fetchImpl, apiUrl(context.endpoint, "/openapi/v1/files/upload"), {
    method: "POST",
    headers: authHeaders(context.token),
    body: form
  });
  const data = unwrapData(body);
  const fileId = data && data.id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    throw new Error("ModelScope upload response did not contain data.id");
  }
  return fileId;
}

async function createSkill(target, skillFileId, context = {}) {
  const fetchImpl = context.fetchImpl || fetch;
  return requestJson(fetchImpl, apiUrl(context.endpoint, "/openapi/v1/skills"), {
    method: "POST",
    headers: authHeaders(context.token, true),
    body: JSON.stringify(buildSkillPayload(target, skillFileId, true))
  });
}

async function updateSkill(target, skillFileId, context = {}) {
  const fetchImpl = context.fetchImpl || fetch;
  return requestJson(fetchImpl, apiUrl(context.endpoint, `${skillRoute(target)}/settings`), {
    method: "PATCH",
    headers: authHeaders(context.token, true),
    body: JSON.stringify(buildSkillPayload(target, skillFileId, false))
  });
}

async function publishTarget(target, context = {}) {
  const remote = await getRemoteSkill(target, context);
  const action = decideAction(target.version, remote, { force: context.force });
  if (context.dryRun || action === "skip") {
    return { action, target, remote };
  }

  const skillFileId = await uploadSkill(target, context);
  const response = action === "create"
    ? await createSkill(target, skillFileId, context)
    : await updateSkill(target, skillFileId, context);
  const verified = await getRemoteSkill(target, context);
  if (!verified) {
    throw new Error(`ModelScope ${action} returned successfully but Skill is not readable: ${target.skillName}`);
  }
  if ((verified.owner && verified.owner !== target.owner) ||
      (verified.skillName && verified.skillName !== target.skillName)) {
    throw new Error(`ModelScope verification found the wrong Skill identity: ${target.owner}/${target.skillName}`);
  }
  if (verified.version && compareVersions(verified.version, target.version) !== 0) {
    throw new Error(
      `ModelScope verification found version ${verified.version}; expected ${target.version}: ${target.skillName}`
    );
  }
  return { action, target, remote, response, verified, skillFileId };
}

async function verifyTarget(target, context = {}) {
  const remote = await getRemoteSkill(target, context);
  if (!remote) {
    return { ok: false, target, reason: "not-found", remote: null };
  }
  const identityOk = (!remote.owner || remote.owner === target.owner) &&
    (!remote.skillName || remote.skillName === target.skillName);
  const versionOk = !remote.version || compareVersions(remote.version, target.version) === 0;
  const displayNameOk = !remote.displayName || remote.displayName === target.displayName;
  return {
    ok: identityOk && versionOk && displayNameOk,
    target,
    remote,
    reason: identityOk && versionOk && displayNameOk ? "matched" : "metadata-mismatch"
  };
}

function runValidation() {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "validate-skills.js")], {
    stdio: "inherit"
  });
  if (result.error) throw new Error(`Skill validation could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Skill validation failed with status ${result.status}`);
}

function printStageSummary(staged) {
  console.log(`Stage directory: ${staged.stageDir}`);
  console.log(`Manifest:        ${staged.manifestPath}`);
  console.log(`Staged Skills:   ${staged.targets.length}`);
  for (const target of staged.targets) {
    console.log(`  ${target.locale}\t${target.sourceSlug} -> ${target.owner}/${target.skillName}\t${target.version}`);
  }
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.validate) runValidation();

  const token = process.env.MODELSCOPE_API_KEY || "";
  const context = {
    endpoint: options.endpoint,
    token,
    force: options.force
  };

  if (options.mode === "verify") {
    const targets = buildTargets(options);
    const results = [];
    for (const target of targets) {
      const result = await verifyTarget(target, context);
      results.push(result);
      console.log(`${result.ok ? "✓" : "✗"} ${target.locale}/${target.skillName}: ${result.reason}`);
    }
    if (results.some((result) => !result.ok)) {
      throw new Error("one or more ModelScope Skills failed verification");
    }
    return;
  }

  const staged = stageSkills(options);
  printStageSummary(staged);
  if (options.mode === "stage") return;

  context.dryRun = options.mode === "dry-run";
  const results = [];
  for (const target of staged.targets) {
    const result = await publishTarget(target, context);
    results.push(result);
    console.log(`${result.action === "skip" ? "-" : "✓"} ${target.locale}/${target.skillName}: ${result.action}`);
  }
  const resultsPath = path.join(staged.stageDir, "results.json");
  fs.writeFileSync(resultsPath, `${JSON.stringify(results.map((result) => ({
    action: result.action,
    locale: result.target.locale,
    sourceSlug: result.target.sourceSlug,
    owner: result.target.owner,
    skillName: result.target.skillName,
    version: result.target.version,
    remoteVersion: result.remote && result.remote.version,
    verifiedVersion: result.verified && result.verified.version,
    skillFileId: result.skillFileId
  })), null, 2)}\n`);
  console.log(`Results:         ${resultsPath}`);
}

module.exports = {
  buildTargets,
  compareVersions,
  decideAction,
  getRemoteSkill,
  buildSkillPayload,
  publishTarget,
  parseArgs,
  stageSkills,
  updateSkill,
  uploadSkill,
  verifyTarget,
  upsertFrontmatter
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`ModelScope Skill publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}
