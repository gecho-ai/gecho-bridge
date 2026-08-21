#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const expectedVersion = packageJson.version;

const skillRoots = [
  "skills",
  "skills-zh-CN",
  "distribution-skills",
  "distribution-skills-zh-CN"
];

const expectedSourceSkills = ["amazon", "tiktok-search", "tiktok-shop", "x"];
const expectedDistributionSkills = [
  "amazon",
  "amazon-product",
  "amazon-reviews",
  "amazon-search",
  "tiktok-influencer",
  "tiktok-insight",
  "tiktok-product",
  "tiktok-search",
  "tiktok-shop",
  "tiktok-shop-search",
  "tiktok-video",
  "tiktok-video-search",
  "x",
  "x-post-detail",
  "x-search"
];

const expectedToolsBySkill = {
  amazon: ["amazon_search", "amazon_product", "amazon_reviews"],
  "amazon-product": ["amazon_product"],
  "amazon-reviews": ["amazon_reviews"],
  "amazon-search": ["amazon_search"],
  "tiktok-influencer": ["tiktok_influencer"],
  "tiktok-insight": ["tiktok_insight", "check_insight_status"],
  "tiktok-product": ["tiktok_product"],
  "tiktok-search": [
    "tiktok_search",
    "tiktok_video",
    "tiktok_influencer",
    "tiktok_insight",
    "check_insight_status"
  ],
  "tiktok-shop": ["tiktok_shop_search", "tiktok_product"],
  "tiktok-shop-search": ["tiktok_shop_search"],
  "tiktok-video": ["tiktok_video"],
  "tiktok-video-search": ["tiktok_search"],
  x: ["x_search", "x_post_detail"],
  "x-post-detail": ["x_post_detail"],
  "x-search": ["x_search"]
};

const expectedParameters = {
  tiktok_search: ["query", "targetCount", "save_dir"],
  tiktok_insight: ["query", "save_dir"],
  check_insight_status: ["jobId"],
  tiktok_influencer: ["uniqueId", "targetCount", "save_dir"],
  tiktok_shop_search: ["query", "targetCount", "save_dir"],
  tiktok_product: ["product_url", "save_dir"],
  tiktok_video: ["url", "targetCount", "save_dir"],
  x_search: ["query", "targetCount", "save_dir"],
  x_post_detail: ["url", "targetCount", "save_dir"],
  amazon_search: ["query", "marketplace", "targetPages", "save_dir"],
  amazon_product: ["product_url", "marketplace", "save_dir"],
  amazon_reviews: ["product_url", "marketplace", "targetCount", "save_dir"]
};

const toolInvariants = {
  tiktok_search: [/100/],
  tiktok_insight: [/jobId/i, /asynchronous|异步/i],
  check_insight_status: [/jobId/i],
  tiktok_influencer: [/100/, /500/],
  tiktok_shop_search: [/100/],
  tiktok_video: [/200/, /comments|评论/i],
  x_search: [/100/],
  x_post_detail: [/100/, /repl(y|ies)|回复/i],
  amazon_search: [/US/i, /5/],
  amazon_product: [/US/i, /ASIN/i],
  amazon_reviews: [/US/i, /100/, /ASIN/i]
};

const errors = [];
const addError = (message) => errors.push(message);

function relative(filePath) {
  return path.relative(projectRoot, filePath);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    addError(`${relative(filePath)}: invalid ${label}: ${error.message}`);
    return null;
  }
}

function getSkillFile(skillDirectory) {
  for (const fileName of ["SKILL.md", "skill.md"]) {
    const filePath = path.join(skillDirectory, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function validateSkillDirectory(rootName, entry) {
  const skillDirectory = path.join(projectRoot, rootName, entry.name);
  const skillFile = getSkillFile(skillDirectory);
  if (!skillFile) return null;

  const skillPath = relative(skillFile);
  const text = fs.readFileSync(skillFile, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) {
    addError(`${skillPath}: missing YAML frontmatter`);
  } else {
    const nameMatch = frontmatter[1].match(/^name:\s*([^\s]+)\s*$/m);
    const descriptionMatch = frontmatter[1].match(/^description:\s*\S.*$/m);
    if (!nameMatch || nameMatch[1] !== entry.name) {
      addError(`${skillPath}: frontmatter name must match ${entry.name}`);
    }
    if (!descriptionMatch) {
      addError(`${skillPath}: missing frontmatter description`);
    }
  }

  const metadataPath = path.join(skillDirectory, "_meta.json");
  if (!fs.existsSync(metadataPath)) {
    addError(`${relative(skillDirectory)}: missing _meta.json`);
  } else {
    const metadata = readJson(metadataPath, "_meta.json");
    if (metadata) {
      if (metadata.slug !== entry.name) {
        addError(`${relative(metadataPath)}: slug must match ${entry.name}`);
      }
      if (metadata.version !== expectedVersion) {
        addError(`${relative(metadataPath)}: version ${metadata.version} must match ${expectedVersion}`);
      }
    }
  }

  if (rootName.endsWith("-zh-CN")) {
    const publishPath = path.join(skillDirectory, "skillhub-publish.json");
    if (!fs.existsSync(publishPath)) {
      addError(`${relative(skillDirectory)}: missing skillhub-publish.json`);
    } else {
      const publishMetadata = readJson(publishPath, "skillhub-publish.json");
      if (publishMetadata) {
        if (publishMetadata.slug !== entry.name) {
          addError(`${relative(publishPath)}: slug must match ${entry.name}`);
        }
        if (publishMetadata.locale !== "zh-CN") {
          addError(`${relative(publishPath)}: locale must be zh-CN`);
        }
      }
    }
  }

  return { name: entry.name, file: skillFile, text };
}

function discoverSkills(rootName) {
  const rootDirectory = path.join(projectRoot, rootName);
  if (!fs.existsSync(rootDirectory)) {
    addError(`${rootName}: missing Skill root`);
    return [];
  }

  return fs.readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => validateSkillDirectory(rootName, entry))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sorted(values) {
  return [...values].sort();
}

function assertSkillSet(rootName, skills, expected) {
  const actual = sorted(skills.map((skill) => skill.name));
  const required = sorted(expected);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    addError(`${rootName}: Skills=${actual.join(",")} expected=${required.join(",")}`);
  }
}

function getToolHeadings(text) {
  return [...text.matchAll(/^###\s+`([^`]+)`\s*$/gm)].map((match) => match[1]);
}

function getToolSections(text) {
  const headings = [...text.matchAll(/^###\s+`([^`]+)`\s*$/gm)];
  return headings.map((heading, index) => ({
    name: heading[1],
    text: text.slice(heading.index, index + 1 < headings.length ? headings[index + 1].index : text.length)
  }));
}

function validateToolDocumentation(skill) {
  const expectedTools = expectedToolsBySkill[skill.name];
  if (!expectedTools) {
    addError(`${relative(skill.file)}: no expected tool mapping for ${skill.name}`);
    return;
  }

  const actualTools = getToolHeadings(skill.text);
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    addError(`${relative(skill.file)}: tools=${actualTools.join(",")} expected=${expectedTools.join(",")}`);
  }

  for (const section of getToolSections(skill.text)) {
    for (const parameter of expectedParameters[section.name] || []) {
      if (!section.text.includes(`\`${parameter}\``)) {
        addError(`${relative(skill.file)}: ${section.name} missing parameter ${parameter}`);
      }
    }
    for (const invariant of toolInvariants[section.name] || []) {
      if (!invariant.test(section.text)) {
        addError(`${relative(skill.file)}: ${section.name} missing invariant ${invariant}`);
      }
    }
  }
}

function structuralSignature(text) {
  return JSON.stringify({
    h2: [...text.matchAll(/^##\s+/gm)].length,
    h3: [...text.matchAll(/^###\s+/gm)].length,
    fences: [...text.matchAll(/^```/gm)].length + [...text.matchAll(/^~~~/gm)].length,
    tables: [...text.matchAll(/^\|/gm)].length,
    tools: getToolHeadings(text)
  });
}

function validateCommonGuidance(skill) {
  const checks = [
    ["OpenClaw MCP setup", /openclaw mcp set/],
    ["OpenClaw MCP verification", /openclaw mcp list/],
    ["Hermes setup", /hermes mcp add/],
    ["Bundle guidance", /openclaw plugins install/],
    ["Website", /gecho\.ai/],
    ["GitHub", /github\.com\/gecho-ai\/gecho-bridge/],
    ["Discord", /discord\.gg\/RFDVZMR6Tn/],
    ["WeCom support", /qywx\.jpg/],
    ["1:1 support", /wx\.jpg/],
    ["Chrome extension", /chromewebstore\.google\.com/],
    ["setup-missing guidance", /setup-missing|缺少配置时的响应/i],
    ["troubleshooting", /Troubleshooting|故障排查/],
    ["no local probing", /local shell probes|本地 Shell 探测/]
  ];
  for (const [label, pattern] of checks) {
    if (!pattern.test(skill.text)) {
      addError(`${relative(skill.file)}: missing ${label}`);
    }
  }

  const setupHeading = skill.text.match(/## Setup-missing response|## 缺少配置时的响应/);
  if (setupHeading) {
    const setupText = skill.text.slice(setupHeading.index);
    const nextHeading = setupText.search(/\n##\s+/);
    const setupSection = nextHeading >= 0 ? setupText.slice(0, nextHeading) : setupText;
    const templateStart = setupSection.search(/````markdown|```markdown/);
    const responseTemplate = templateStart >= 0 ? setupSection.slice(templateStart) : setupSection;
    const recommendsBundleInstall = responseTemplate
      .split(/\r?\n/)
      .some((line) => /openclaw plugins install/.test(line) && !/不要|must not|do not|not recommend/i.test(line));
    if (recommendsBundleInstall) {
      addError(`${relative(skill.file)}: setup-missing response must not recommend openclaw plugins install`);
    }
  }
}

function validateExactSourceDistribution(sourceSkills, distributionSkills, sourceRoot, distributionRoot) {
  const distributionByName = new Map(distributionSkills.map((skill) => [skill.name, skill]));
  for (const sourceSkill of sourceSkills) {
    const distributionSkill = distributionByName.get(sourceSkill.name);
    if (!distributionSkill) continue;
    if (sourceSkill.text !== distributionSkill.text) {
      addError(`${sourceRoot}/${sourceSkill.name} and ${distributionRoot}/${sourceSkill.name} differ`);
    }
  }
}

function validateBilingualParity(englishSkills, chineseSkills) {
  const englishByName = new Map(englishSkills.map((skill) => [skill.name, skill]));
  const chineseByName = new Map(chineseSkills.map((skill) => [skill.name, skill]));
  for (const name of expectedDistributionSkills) {
    const english = englishByName.get(name);
    const chinese = chineseByName.get(name);
    if (!english || !chinese) continue;
    if (structuralSignature(english.text) !== structuralSignature(chinese.text)) {
      addError(`distribution-skills/${name} and distribution-skills-zh-CN/${name} are structurally misaligned`);
    }
  }
}

function validateBridgeToolList() {
  const clientPath = path.join(projectRoot, "mcp-client.js");
  const client = fs.readFileSync(clientPath, "utf8");
  const supportedMatch = client.match(/const SUPPORTED_TOOL_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  if (!supportedMatch) {
    addError("mcp-client.js: cannot find SUPPORTED_TOOL_NAMES");
    return;
  }
  const supportedTools = [...supportedMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const listStart = client.indexOf("server.setRequestHandler(ListToolsRequestSchema");
  const listEnd = client.indexOf("// 2. 转发工具请求到 Service 层");
  const listBlock = client.slice(listStart, listEnd);
  const publicTools = [...listBlock.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
  const expectedPublic = sorted([...new Set([...supportedTools, "check_insight_status"])]);
  const actualPublic = sorted([...new Set(publicTools)]);
  if (JSON.stringify(expectedPublic) !== JSON.stringify(actualPublic)) {
    addError(`mcp-client.js: public tools=${actualPublic.join(",")} expected=${expectedPublic.join(",")}`);
  }
}

function main() {
  const discovered = Object.fromEntries(skillRoots.map((rootName) => [rootName, discoverSkills(rootName)]));

  assertSkillSet("skills", discovered.skills, expectedSourceSkills);
  assertSkillSet("skills-zh-CN", discovered["skills-zh-CN"], expectedSourceSkills);
  assertSkillSet("distribution-skills", discovered["distribution-skills"], expectedDistributionSkills);
  assertSkillSet("distribution-skills-zh-CN", discovered["distribution-skills-zh-CN"], expectedDistributionSkills);

  for (const rootName of skillRoots) {
    for (const skill of discovered[rootName]) {
      validateToolDocumentation(skill);
      validateCommonGuidance(skill);
    }
  }

  validateExactSourceDistribution(
    discovered.skills,
    discovered["distribution-skills"],
    "skills",
    "distribution-skills"
  );
  validateExactSourceDistribution(
    discovered["skills-zh-CN"],
    discovered["distribution-skills-zh-CN"],
    "skills-zh-CN",
    "distribution-skills-zh-CN"
  );
  validateBilingualParity(discovered["distribution-skills"], discovered["distribution-skills-zh-CN"]);
  validateBridgeToolList();

  if (errors.length > 0) {
    console.error(`Skill validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  const total = skillRoots.reduce((sum, rootName) => sum + discovered[rootName].length, 0);
  console.log(`Skill validation passed: ${total} Skill directories, version ${expectedVersion}.`);
}

main();
