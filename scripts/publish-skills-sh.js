#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { listDistributionSkills, projectRoot } = require("./publish-config.js");

const DEFAULT_REPO = "gecho-ai/gecho-bridge";
const DEFAULT_BRANCH = "main";
const DEFAULT_AGENT = "universal";
const SUPPORTED_LOCALES = new Set(["all", "en", "zh-CN"]);

function usage() {
  return `Usage:
  ./scripts/publish-skills-sh.sh dry-run [options]
  ./scripts/publish-skills-sh.sh publish [options]

Description:
  skills.sh has no separate publish API. This script performs the official
  public-install flow for each Skill so the skills CLI can ingest the source
  and skills.sh can collect its anonymous install telemetry.

Modes:
  dry-run                 Print the GitHub source URLs without installing.
  publish                 Install each selected Skill in an isolated temp dir.

Options:
  --skill <slug>          Only process one source Skill slug.
  --locale <all|en|zh-CN> Process English, Chinese, or both (default: all).
  --agent <name>          Agent target for the temporary install (default: universal).
  --repo <owner/repo>     GitHub repository (default: gecho-ai/gecho-bridge).
  --branch <name>         Git branch or tag (default: main).
  --limit <n>             Process at most n matching Skills.
  --work-dir <path>       Base directory for temporary install workspaces.
  --report <path>         Write a JSON result report to this path.
  --fail-fast             Stop after the first failed Skill.
  --continue-on-error     Continue after failures (default behavior).
  -h, --help              Show this help.

Examples:
  npm run skill:skills-sh:dry-run
  npm run skill:skills-sh:publish
  npm run skill:skills-sh:publish -- --skill tiktok-video-search --locale zh-CN
  ./scripts/publish-skills-sh.sh publish --limit 1

Notes:
  - The source Skill directories are not moved or modified.
  - The default workspaces are created under the system temp directory.
  - Existing user installations are not updated by this script; use
    \`npx skills update\` in the consuming project.
`;
}

function takeValue(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let mode = "publish";
  if (args[0] && !args[0].startsWith("-")) mode = args.shift();
  if (!["dry-run", "publish"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}\n\n${usage()}`);
  }

  const options = {
    mode,
    skill: null,
    locale: "all",
    agent: process.env.SKILLS_SH_AGENT || DEFAULT_AGENT,
    repo: process.env.SKILLS_SH_REPO || DEFAULT_REPO,
    branch: process.env.SKILLS_SH_BRANCH || DEFAULT_BRANCH,
    limit: null,
    workDir: process.env.SKILLS_SH_WORK_DIR || null,
    report: process.env.SKILLS_SH_REPORT || null,
    continueOnError: true
  };

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--skill":
        options.skill = takeValue(args, flag);
        break;
      case "--locale":
        options.locale = takeValue(args, flag);
        break;
      case "--agent":
        options.agent = takeValue(args, flag);
        break;
      case "--repo":
        options.repo = takeValue(args, flag);
        break;
      case "--branch":
        options.branch = takeValue(args, flag);
        break;
      case "--limit":
        options.limit = parsePositiveInteger(takeValue(args, flag), flag);
        break;
      case "--work-dir":
        options.workDir = takeValue(args, flag);
        break;
      case "--report":
        options.report = takeValue(args, flag);
        break;
      case "--fail-fast":
        options.continueOnError = false;
        break;
      case "--continue-on-error":
        options.continueOnError = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}\n\n${usage()}`);
    }
  }

  if (!SUPPORTED_LOCALES.has(options.locale)) {
    throw new Error(`locale must be one of: all, en, zh-CN (got ${options.locale})`);
  }
  if (!/^[^/]+\/[^/]+$/.test(options.repo)) {
    throw new Error(`repo must use owner/repo format (got ${options.repo})`);
  }
  if (!options.agent.trim()) throw new Error("agent requires a value");
  if (!options.branch.trim()) throw new Error("branch requires a value");
  return options;
}

function buildSourceUrl(repo, branch, sourcePath) {
  const encodedPath = sourcePath
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const encodedBranch = encodeURIComponent(branch).replace(/%2F/g, "/");
  return `https://github.com/${repo}/tree/${encodedBranch}/${encodedPath}`;
}

function buildTargets({ skill = null, locale = "all", repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, limit = null } = {}) {
  if (!SUPPORTED_LOCALES.has(locale)) {
    throw new Error(`locale must be one of: all, en, zh-CN (got ${locale})`);
  }

  const targets = listDistributionSkills()
    .filter((entry) => locale === "all" || entry.locale === locale)
    .filter((entry) => !skill || entry.sourceSlug === skill)
    .map((entry) => ({
      sourceRoot: entry.sourceRoot,
      sourcePath: entry.sourcePath,
      sourceSlug: entry.sourceSlug,
      locale: entry.locale,
      repo,
      branch,
      sourceUrl: buildSourceUrl(repo, branch, entry.sourcePath)
    }));

  if (targets.length === 0) {
    const filters = [
      skill ? ` --skill ${skill}` : "",
      locale !== "all" ? ` --locale ${locale}` : ""
    ].join("");
    throw new Error(`no distribution Skills matched${filters}`);
  }

  return limit ? targets.slice(0, limit) : targets;
}

function buildCommand(target, { agent = DEFAULT_AGENT } = {}) {
  return {
    command: "npx",
    args: [
      "--yes",
      "skills",
      "add",
      target.sourceUrl,
      "--agent",
      agent,
      "--copy",
      "--yes"
    ]
  };
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function createWorkDir(workDir) {
  if (!workDir) return fs.mkdtempSync(path.join(os.tmpdir(), "gecho-skills-sh-"));
  const resolved = resolveProjectPath(workDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function runCommand(command, args, cwd, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function expectedInstallPath(workspace, target) {
  return path.join(workspace, ".agents", "skills", target.sourceSlug, "SKILL.md");
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function printQueue(targets) {
  console.log(`skills.sh queue (${targets.length}):`);
  for (const target of targets) {
    console.log(`- ${target.sourcePath} | locale=${target.locale} | ${target.sourceUrl}`);
  }
}

function writeReport(reportPath, report) {
  const absolutePath = resolveProjectPath(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`);
  return absolutePath;
}

async function run(options, dependencies = {}) {
  const targets = buildTargets(options);
  printQueue(targets);
  if (options.mode === "dry-run") return { targets, results: [] };

  const runDir = createWorkDir(options.workDir);
  console.log(`Work directory: ${runDir}`);
  const results = [];
  const spawnImpl = dependencies.spawnImpl || spawn;

  for (const target of targets) {
    const workspace = fs.mkdtempSync(path.join(runDir, `${target.locale}-${target.sourceSlug}-`));
    const command = buildCommand(target, options);
    console.log(`Installing ${target.sourcePath}`);
    console.log(`  ${formatCommand(command.command, command.args)}`);

    try {
      const execution = await runCommand(command.command, command.args, workspace, spawnImpl);
      if (execution.code !== 0) {
        const details = [execution.stdout, execution.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`skills CLI exited with code ${execution.code}${details ? `: ${details}` : ""}`);
      }

      const installedPath = expectedInstallPath(workspace, target);
      if (!fs.existsSync(installedPath)) {
        throw new Error(`CLI succeeded but installed SKILL.md was not found at ${path.relative(workspace, installedPath)}`);
      }

      results.push({
        sourcePath: target.sourcePath,
        sourceSlug: target.sourceSlug,
        locale: target.locale,
        sourceUrl: target.sourceUrl,
        workspace,
        status: "installed"
      });
      console.log(`  OK ${target.sourcePath}`);
    } catch (error) {
      const result = {
        sourcePath: target.sourcePath,
        sourceSlug: target.sourceSlug,
        locale: target.locale,
        sourceUrl: target.sourceUrl,
        workspace,
        status: "failed",
        error: error.message
      };
      results.push(result);
      console.error(`  FAIL ${target.sourcePath}: ${error.message}`);
      if (!options.continueOnError) break;
    }
  }

  const summary = {
    platform: "skills.sh",
    mode: options.mode,
    repo: options.repo,
    branch: options.branch,
    workDir: runDir,
    total: results.length,
    installed: results.filter((result) => result.status === "installed").length,
    failed: results.filter((result) => result.status === "failed").length,
    results
  };
  if (options.report) {
    summary.reportPath = writeReport(options.report, summary);
    console.log(`Report: ${summary.reportPath}`);
  }
  console.log(`Summary: installed=${summary.installed} failed=${summary.failed}`);
  return summary;
}

if (require.main === module) {
  try {
    const options = parseArgs();
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    run(options).then((summary) => {
      if (summary.failed > 0) process.exitCode = 1;
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  buildCommand,
  buildSourceUrl,
  buildTargets,
  expectedInstallPath,
  parseArgs,
  runCommand
};
