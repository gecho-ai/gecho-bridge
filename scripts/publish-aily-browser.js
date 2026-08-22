#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { listDistributionSkills, projectRoot, resolvePlatformTarget } = require("./publish-config.js");

const DEFAULT_PACKAGE_DIR = path.join(projectRoot, "tmp", "manual-skill-packages");
const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_URL = "https://aily.feishu.cn/market/skills";
const DEFAULT_TIMEOUT = 120000;
const SUPPORTED_LOCALES = new Set(["all", "en", "zh-CN"]);

function usage() {
  return `Usage:
  node scripts/publish-aily-browser.js dry-run [options]
  node scripts/publish-aily-browser.js publish [options]

Options:
  --skill <slug>             Only process one source Skill slug.
  --locale <all|en|zh-CN>    Process one locale. Default: all.
  --package-dir <path>       Manual ZIP directory. Default: tmp/manual-skill-packages.
  --endpoint <url>           Edge CDP endpoint. Default: http://127.0.0.1:9222.
  --url <url>                Aily Skill market URL.
  --limit <n>                Process at most n items.
  --timeout <ms>             Browser action timeout. Default: 120000.
  --continue-on-error        Continue with the next item after a failed upload.
  --report <path>            JSON report path.
  -h, --help                 Show this help.

Before publish:
  1. Quit Edge and relaunch it with --remote-debugging-port=9222.
  2. Log in to Aily in that Edge profile.
  3. Run the dry-run command and check displayName/archive mapping.
`;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
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
  const options = {
    mode: "publish",
    skill: null,
    locale: "all",
    packageDir: process.env.AILY_PACKAGE_DIR || DEFAULT_PACKAGE_DIR,
    endpoint: process.env.AILY_CDP_ENDPOINT || DEFAULT_ENDPOINT,
    url: process.env.AILY_URL || DEFAULT_URL,
    limit: null,
    timeout: DEFAULT_TIMEOUT,
    continueOnError: false,
    report: process.env.AILY_REPORT || path.join(projectRoot, "tmp", "aily-browser-publish", "results.json")
  };

  let index = 0;
  if (argv[0] === "dry-run" || argv[0] === "publish") {
    options.mode = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--skill":
        options.skill = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--locale":
        options.locale = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--package-dir":
        options.packageDir = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--endpoint":
        options.endpoint = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--url":
        options.url = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--timeout":
        options.timeout = parsePositiveInteger(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--continue-on-error":
        options.continueOnError = true;
        break;
      case "--report":
        options.report = takeValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!SUPPORTED_LOCALES.has(options.locale)) {
    throw new Error(`locale must be one of: all, en, zh-CN (got ${options.locale})`);
  }
  return options;
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function readManifest(packageDir) {
  const directory = resolveProjectPath(packageDir);
  const manifestPath = path.join(directory, "manifest.tsv");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manual package manifest not found: ${path.relative(projectRoot, manifestPath)}`);
  }

  const lines = fs.readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = lines[0].split("\t");
  const requiredHeaders = ["source_root", "slug", "locale", "version", "archive"];
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) {
      throw new Error(`manifest.tsv is missing required column: ${header}`);
    }
  }

  return lines.slice(1).map((line, lineIndex) => {
    const values = line.split("\t");
    const row = Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex] || ""]));
    if (!row.source_root || !row.slug || !row.locale || !row.version || !row.archive) {
      throw new Error(`manifest.tsv line ${lineIndex + 2} contains an empty required field`);
    }
    return row;
  });
}

function buildQueue({
  packageDir = DEFAULT_PACKAGE_DIR,
  skill = null,
  locale = "all",
  limit = null
} = {}) {
  if (!SUPPORTED_LOCALES.has(locale)) {
    throw new Error(`locale must be one of: all, en, zh-CN (got ${locale})`);
  }

  const directory = resolveProjectPath(packageDir);
  const manifest = readManifest(directory);
  const manifestByKey = new Map(
    manifest.map((row) => [`${row.source_root}/${row.slug}/${row.locale}`, row])
  );
  const skills = listDistributionSkills()
    .filter((entry) => !skill || entry.sourceSlug === skill)
    .filter((entry) => locale === "all" || entry.locale === locale);

  if (skills.length === 0) {
    throw new Error(`no distribution Skills matched${skill ? ` --skill ${skill}` : ""}${locale !== "all" ? ` --locale ${locale}` : ""}`);
  }

  const queue = skills.map((entry) => {
    const row = manifestByKey.get(`${entry.sourceRoot}/${entry.sourceSlug}/${entry.locale}`);
    if (!row) {
      throw new Error(`manifest.tsv has no archive for ${entry.sourcePath}`);
    }
    const archivePath = path.join(directory, row.archive);
    if (!fs.existsSync(archivePath)) {
      throw new Error(`archive listed in manifest does not exist: ${path.relative(projectRoot, archivePath)}`);
    }
    const target = resolvePlatformTarget(entry.directory, "aily-skillhub");
    return {
      sourceRoot: entry.sourceRoot,
      sourceSlug: entry.sourceSlug,
      sourcePath: entry.sourcePath,
      locale: entry.locale,
      version: row.version,
      archive: row.archive,
      archivePath,
      displayName: target.displayName,
      publishedSlug: target.slug
    };
  });

  return limit ? queue.slice(0, limit) : queue;
}

function printQueue(queue) {
  if (queue.length === 0) {
    console.log("No Skills to process.");
    return;
  }
  console.log(`Aily queue (${queue.length}):`);
  for (const item of queue) {
    console.log([
      `- ${item.sourcePath}`,
      `locale=${item.locale}`,
      `version=${item.version}`,
      `archive=${item.archive}`,
      `displayName=${item.displayName}`,
      `slug=${item.publishedSlug}`
    ].join(" | "));
  }
}

async function connectToEdge(endpoint) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (error) {
    throw new Error("playwright-core is not installed; run npm install first");
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (error) {
    throw new Error(`cannot connect to Edge CDP at ${endpoint}; relaunch Edge with --remote-debugging-port=9222: ${error.message}`);
  }

  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith("https://aily.feishu.cn/")) || pages[0];
  if (!page) {
    throw new Error("Edge CDP is connected, but no browser page is available");
  }
  return { browser, page };
}

async function clickText(page, text, options = {}) {
  const locator = page.getByText(text, { exact: true }).last();
  await locator.waitFor({ state: "visible", timeout: options.timeout });
  await locator.click();
}

async function uploadArchive(page, archivePath, timeout) {
  const newButton = page.getByRole("button", { name: "新建", exact: true });
  await newButton.waitFor({ state: "visible", timeout });
  await newButton.click();
  await clickText(page, "上传技能", { timeout });

  const fileInput = page.locator('input[type="file"]');
  if (await fileInput.count()) {
    const visibleInput = fileInput.last();
    await visibleInput.setInputFiles(archivePath);
  } else {
    const chooser = page.waitForEvent("filechooser", { timeout });
    await clickText(page, "点击选择文件", { timeout });
    await (await chooser).setFiles(archivePath);
  }

  await page.getByText("请确认新版本信息", { exact: true }).waitFor({ state: "visible", timeout });
}

async function findDisplayNameInput(page, sourceSlug, timeout) {
  const inputs = page.locator("input:visible");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await inputs.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const input = inputs.nth(index);
      const value = await input.inputValue().catch(() => "");
      if (value === sourceSlug || value.includes(sourceSlug)) return input;
    }
    if (count > 0) return inputs.last();
    await page.waitForTimeout(100);
  }
  throw new Error(`display name input not found for ${sourceSlug}`);
}

async function publishOne(page, item, timeout) {
  await uploadArchive(page, item.archivePath, timeout);
  const displayNameInput = await findDisplayNameInput(page, item.sourceSlug, timeout);
  await displayNameInput.fill(item.displayName);

  const completeButton = page.getByRole("button", { name: "完成", exact: true }).last();
  await completeButton.waitFor({ state: "visible", timeout });
  await completeButton.click();

  await page.getByText(item.displayName, { exact: true }).first().waitFor({ state: "visible", timeout });
  return {
    sourcePath: item.sourcePath,
    sourceSlug: item.sourceSlug,
    locale: item.locale,
    version: item.version,
    archive: item.archive,
    displayName: item.displayName,
    publishedSlug: item.publishedSlug,
    status: "published"
  };
}

function writeReport(reportPath, report) {
  const absolutePath = resolveProjectPath(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(report, null, 2) + "\n");
  return absolutePath;
}

async function run(options) {
  const startedAt = new Date().toISOString();
  const queue = buildQueue(options);
  printQueue(queue);
  if (options.mode === "dry-run") return { queue, results: [] };

  const { browser, page } = await connectToEdge(options.endpoint);
  page.setDefaultTimeout(options.timeout);
  if (!page.url().startsWith(options.url)) {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeout });
  }

  const results = [];
  try {
    for (const item of queue) {
      console.log(`Publishing ${item.sourcePath} -> ${item.displayName}`);
      try {
        const result = await publishOne(page, item, options.timeout);
        results.push(result);
        console.log(`Published ${item.sourcePath} (${item.version})`);
      } catch (error) {
        const result = {
          sourcePath: item.sourcePath,
          sourceSlug: item.sourceSlug,
          locale: item.locale,
          version: item.version,
          archive: item.archive,
          displayName: item.displayName,
          publishedSlug: item.publishedSlug,
          status: "failed",
          error: error.message
        };
        results.push(result);
        console.error(`Failed ${item.sourcePath}: ${error.message}`);
        if (!options.continueOnError) throw error;
      }
    }
  } finally {
    const reportPath = writeReport(options.report, {
      platform: "aily-skillhub",
      mode: options.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      results
    });
    console.log(`Report: ${reportPath}`);
    // For a connected browser Playwright disconnects from the remote browser;
    // it does not force-quit the user's existing Edge process.
    await browser.close().catch(() => {});
  }

  return { queue, results };
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  await run(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildQueue,
  connectToEdge,
  parseArgs,
  publishOne,
  readManifest,
  run,
  writeReport
};
