#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { projectRoot } = require("./publish-config.js");

// WorkBuddy Connector package shape and MCP configuration follow the official
// documentation: https://open.workbuddy.cn/docs/connector
const platformName = "workbuddy-connector";
const defaultOutputDir = path.join(projectRoot, "tmp", "workbuddy-connector");
const configPath = path.join(projectRoot, "config", "workbuddy-connector.json");
const markerFile = ".workbuddy-connector-stage.json";
const maxArchiveBytes = 20 * 1024 * 1024;
const requiredArchiveEntries = [
  "connector-meta.json",
  "mcp.json",
  "icon.svg",
  "skills/gecho-tiktok/SKILL.md"
];

function usage() {
  return `Usage:
  node ./scripts/package-workbuddy-connector.js [package|dry-run] [options]

Modes:
  package     Create and validate an uploadable Connector ZIP (default).
  dry-run     Same as package; explicitly documents that no upload occurs.

Options:
  --output-dir <path>  Generated directory (must be under tmp/workbuddy-connector*).
  --version <version>  Version to pin in mcp.json (default: package.json version).
  -h, --help           Show this help.

The generated ZIP is for the WorkBuddy Open Platform Connector upload page.
This script does not log in, upload, or submit a review request.
`;
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

function parseArgs(argv) {
  const args = [...argv];
  let mode = "package";
  if (args[0] && !args[0].startsWith("-")) mode = args.shift();
  if (!["package", "dry-run"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}\n\n${usage()}`);
  }

  const options = {
    mode,
    outputDir: process.env.WORKBUDDY_CONNECTOR_OUTPUT_DIR || defaultOutputDir,
    version: process.env.WORKBUDDY_CONNECTOR_VERSION || null
  };

  const nextValue = (flag) => {
    const value = args.shift();
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
    return value;
  };

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--output-dir": options.outputDir = nextValue(flag); break;
      case "--version": options.version = nextValue(flag); break;
      case "-h":
      case "--help": options.help = true; break;
      default: throw new Error(`Unknown option: ${flag}\n\n${usage()}`);
    }
  }
  return options;
}

function assertSafeOutputDir(outputDir) {
  const resolved = path.resolve(projectRoot, outputDir);
  const temporaryRoot = path.join(projectRoot, "tmp");
  const relative = path.relative(temporaryRoot, resolved);
  const topLevel = relative.split(path.sep)[0];
  const isDedicatedTemporaryDirectory = relative
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && /^workbuddy-connector(?:$|-)/.test(topLevel);

  if (!isDedicatedTemporaryDirectory) {
    throw new Error(`output directory must be inside a dedicated temporary directory under tmp/workbuddy-connector*: ${resolved}`);
  }
  return resolved;
}

function isOwnedOutputDir(outputDir) {
  const markerPath = path.join(outputDir, markerFile);
  if (!fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return marker.schemaVersion === 1 && marker.platform === platformName;
  } catch (_error) {
    return false;
  }
}

function assertOutputDirCanBeRebuilt(outputDir) {
  if (!fs.existsSync(outputDir)) return;
  const stats = fs.lstatSync(outputDir);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwnedOutputDir(outputDir)) {
    throw new Error(`output directory is not owned by the WorkBuddy Connector packager: ${outputDir}`);
  }
}

function assertVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid package version: ${version}`);
  }
}

function loadConnectorConfig() {
  const config = readJson(configPath, "WorkBuddy Connector config");
  if (config.schemaVersion !== 1) throw new Error("WorkBuddy Connector config must use schemaVersion 1");
  for (const field of [
    "source", "type", "name", "name_zh", "name_en",
    "description", "description_zh", "description_en",
    "examples_zh", "examples_en", "minWorkbuddyVersion",
    "serverName", "npmRegistry", "skillPath", "iconPath"
  ]) {
    if (config[field] === undefined || config[field] === null || config[field] === "") {
      throw new Error(`WorkBuddy Connector config is missing ${field}`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.source)) {
    throw new Error(`WorkBuddy Connector source must be lowercase kebab-case: ${config.source}`);
  }
  if (config.type !== "mcp") throw new Error(`WorkBuddy Connector type must be mcp: ${config.type}`);
  for (const examplesField of ["examples_zh", "examples_en"]) {
    if (!Array.isArray(config[examplesField]) || config[examplesField].length < 2) {
      throw new Error(`${examplesField} must contain at least two examples`);
    }
  }
  if (!Number.isInteger(config.timeout) || config.timeout <= 0) {
    throw new Error("WorkBuddy Connector timeout must be a positive integer");
  }
  return config;
}

function resolveProjectFile(relativePath, label) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relativeToProject = path.relative(projectRoot, absolutePath);
  if (!relativeToProject || relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
    throw new Error(`${label} must be inside the project: ${relativePath}`);
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`${label} not found: ${relativePath}`);
  }
  return absolutePath;
}

function readConnectorIcon(iconPath) {
  const extension = path.extname(iconPath).toLowerCase();
  if (extension === ".svg") return fs.readFileSync(iconPath, "utf8");
  if (extension !== ".png") {
    throw new Error(`Connector icon must be an SVG or 512x512 PNG: ${path.relative(projectRoot, iconPath)}`);
  }

  const png = fs.readFileSync(iconPath);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`Connector icon is not a valid PNG: ${path.relative(projectRoot, iconPath)}`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 512 || height !== 512) {
    throw new Error(`Connector PNG icon must be 512x512: ${width}x${height}`);
  }

  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return [
    '<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">',
    `  <image href="${dataUri}" width="512" height="512" preserveAspectRatio="xMidYMid slice"/>`,
    '</svg>',
    ""
  ].join("\n");
}

function buildConnectorFiles(options = {}) {
  const config = loadConnectorConfig();
  const packageJson = readJson(path.join(projectRoot, "package.json"), "package.json");
  const version = options.version || packageJson.version;
  assertVersion(version);

  const metadata = {
    source: config.source,
    type: config.type,
    version,
    name: config.name,
    name_zh: config.name_zh,
    name_en: config.name_en,
    description: config.description,
    description_zh: config.description_zh,
    description_en: config.description_en,
    examples_zh: config.examples_zh,
    examples_en: config.examples_en,
    minWorkbuddyVersion: config.minWorkbuddyVersion
  };
  const mcp = {
    mcpServers: {
      [config.serverName]: {
        type: "stdio",
        command: "npx",
        args: ["-y", `${packageJson.name}@${version}`],
        runtime: { type: "node", version: "20" },
        npmRegistry: config.npmRegistry,
        timeout: config.timeout
      }
    }
  };

  const skillPath = resolveProjectFile(config.skillPath, "Connector Skill");
  const iconPath = resolveProjectFile(config.iconPath, "Connector icon");
  return {
    "connector-meta.json": `${JSON.stringify(metadata, null, 2)}\n`,
    "mcp.json": `${JSON.stringify(mcp, null, 2)}\n`,
    "icon.svg": readConnectorIcon(iconPath),
    "skills/gecho-tiktok/SKILL.md": fs.readFileSync(skillPath, "utf8")
  };
}

function writeConnectorFiles(stageRoot, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(stageRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error) throw new Error(`${command} is required: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim() || result.status}`);
  }
  return result;
}

function validateStage(stageRoot, version) {
  for (const entry of requiredArchiveEntries) {
    const filePath = path.join(stageRoot, entry);
    if (!fs.existsSync(filePath)) throw new Error(`required Connector entry is missing: ${entry}`);
  }

  const metadata = readJson(path.join(stageRoot, "connector-meta.json"), "connector-meta.json");
  const mcp = readJson(path.join(stageRoot, "mcp.json"), "mcp.json");
  if (metadata.version !== version) throw new Error(`Connector metadata version mismatch: ${metadata.version}`);
  if (!mcp.mcpServers || Object.keys(mcp.mcpServers).length !== 1) {
    throw new Error("mcp.json must configure exactly one MCP Server");
  }
  const server = mcp.mcpServers[Object.keys(mcp.mcpServers)[0]];
  if (server.type !== "stdio" || server.command !== "npx") {
    throw new Error("WorkBuddy Connector MCP Server must use npx Stdio");
  }
  if (!Array.isArray(server.args) || server.args.length !== 2 || !server.args[1].endsWith(`@${version}`)) {
    throw new Error("mcp.json must pin the MCP package to the Connector version");
  }
  if (JSON.stringify({ metadata, mcp }).match(/(?:sk-(?:ent|h)-|Bearer\s+\S{12,})/i)) {
    throw new Error("Connector metadata contains a possible hard-coded credential");
  }
}

function packageConnector(options = {}) {
  const outputDir = assertSafeOutputDir(options.outputDir || defaultOutputDir);
  const version = options.version || readPackageVersion();
  assertVersion(version);
  const files = buildConnectorFiles({ version });

  assertOutputDirCanBeRebuilt(outputDir);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, markerFile), `${JSON.stringify({
    schemaVersion: 1,
    platform: platformName,
    version
  }, null, 2)}\n`);

  const stageRoot = path.join(outputDir, "stage");
  writeConnectorFiles(stageRoot, files);
  validateStage(stageRoot, version);

  const archivePath = path.join(outputDir, `gecho-bridge-workbuddy-v${version}.zip`);
  runChecked("zip", ["-q", "-X", "-r", archivePath, "."], { cwd: stageRoot });
  runChecked("unzip", ["-t", archivePath], { stdio: "ignore" });

  const archiveSize = fs.statSync(archivePath).size;
  if (archiveSize > maxArchiveBytes) {
    throw new Error(`WorkBuddy Connector ZIP exceeds 20MB (${archiveSize} bytes): ${archivePath}`);
  }
  const listing = runChecked("unzip", ["-Z1", archivePath]).stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of requiredArchiveEntries) {
    if (!listing.includes(entry)) throw new Error(`Connector entry is missing from ZIP: ${entry}`);
  }
  if (listing.some((entry) => entry.startsWith("stage/") || entry === markerFile)) {
    throw new Error("generated ZIP contains staging-only paths");
  }

  const manifest = {
    schemaVersion: 1,
    platform: platformName,
    generatedAt: new Date().toISOString(),
    version,
    archive: path.relative(projectRoot, archivePath),
    archiveSize,
    entries: listing
  };
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDir, stageRoot, archivePath, archiveSize, manifestPath, listing, manifest };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  const result = packageConnector(options);
  console.log(`Output directory: ${result.outputDir}`);
  console.log(`Archive:          ${result.archivePath}`);
  console.log(`Archive size:     ${result.archiveSize} bytes`);
  console.log(`Manifest:         ${result.manifestPath}`);
  console.log("No upload or review submission was performed.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`WorkBuddy Connector packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertSafeOutputDir,
  buildConnectorFiles,
  packageConnector
};
