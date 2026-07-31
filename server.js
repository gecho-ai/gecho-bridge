#!/usr/bin/env node

/**
 * Service 层 (Service Layer)
 * 职责: 
 * 1. 维持与 Chrome 扩展的 WebSocket 连接 (端口 18792)。
 * 2. 暴露 HTTP API (端口 18793) 供 Client 层调用。
 * 3. 负责数据的抓取、清洗和本地持久化。
 */

const { WebSocketServer } = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const packageJson = require("./package.json");

const WS_PORT = Number(process["env"].GECHO_WS_PORT || 18792);
const HTTP_PORT = Number(process["env"].GECHO_HTTP_PORT || 18793);
const ONBOARDING_PATH = "/onboarding";
const SERVICE_PROTOCOL_VERSION = 2;
const SERVICE_STARTED_AT = Date.now();
const DEFAULT_DATA_DIR = path.join(__dirname, "data");
const JOBS_DIR = process["env"].GECHO_DATA_DIR || DEFAULT_DATA_DIR;
const JOBS_STORE_PATH = path.join(JOBS_DIR, ".async_jobs.json");
const JOB_DETAILS_DIR = path.join(JOBS_DIR, "jobs");
const REQUEST_INDEX_PATH = path.join(JOBS_DIR, ".async_request_index.json");
const BROWSER_CONNECTION_PATH = path.join(JOBS_DIR, ".browser_connection.json");
const ONBOARDING_STATE_PATH = path.join(JOBS_DIR, ".extension_onboarding.json");
const GECHO_EXTENSION_ID = "pjkaeenpekolahdbccjfenjcmanemlbj";
const CHROME_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/gecho/${GECHO_EXTENSION_ID}`;
// Gecho is currently distributed through Chrome Web Store. Edge can install
// this listing after the user confirms Edge's one-time "allow other stores"
// prompt, so do not send users to an unrelated Edge Add-ons search page.
const EDGE_EXTENSION_STORE_URL = CHROME_EXTENSION_STORE_URL;
const GECHO_WEBSITE_URL = String(process["env"].GECHO_WEBSITE_URL || "https://gecho.ai/").trim();
const GECHO_TUTORIAL_URL = String(process["env"].GECHO_TUTORIAL_URL || "").trim();
const JOB_TTL_MS = Number(process["env"].GECHO_JOB_TTL_MS || 3 * 24 * 60 * 60 * 1000); // 默认 3 天
const MAX_PERSISTED_JOBS = Number(process["env"].GECHO_MAX_PERSISTED_JOBS || 2000);
const CLEANUP_INTERVAL_MS = Number(process["env"].GECHO_CLEANUP_INTERVAL_MS || 10 * 60 * 1000);
const EXTENSION_CONNECT_TIMEOUT_MS = Math.max(1000, Number(process["env"].GECHO_EXTENSION_CONNECT_TIMEOUT_MS || 30000));
const EXTENSION_RECONNECT_PROBE_TIMEOUT_MS = Math.max(1000, Number(process["env"].GECHO_EXTENSION_RECONNECT_PROBE_TIMEOUT_MS || 10000));
const EXTENSION_ONBOARDING_TIMEOUT_MS = Math.max(5000, Number(process["env"].GECHO_EXTENSION_ONBOARDING_TIMEOUT_MS || 120000));
const EXTENSION_CONNECT_POLL_MS = 500;
const EXTENSION_READY_GRACE_MS = Math.max(0, Number(process["env"].GECHO_EXTENSION_READY_GRACE_MS || 1500));
const AUTO_LAUNCH_BROWSER = process["env"].GECHO_AUTO_LAUNCH_BROWSER !== "0";
const AUTO_OPEN_ONBOARDING_ON_FIRST_START = process["env"].GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START !== "0";
const AUTO_CLOSE_LAUNCHED_BROWSER = process["env"].GECHO_AUTO_CLOSE_LAUNCHED_BROWSER !== "0";
const AUTO_LAUNCH_BROWSER_DRY_RUN = process["env"].GECHO_AUTO_LAUNCH_BROWSER_DRY_RUN === "1";
const AUTO_LAUNCH_BROWSER_COOLDOWN_MS = Math.max(0, Number(process["env"].GECHO_AUTO_LAUNCH_BROWSER_COOLDOWN_MS || 10000));

let extensionSocket = null;
let wss = null;
const extensionConnections = new Map();
let extensionConnectionCounter = 1;
let lastExtensionConnectedAt = 0;
let lastBrowserConnection = null;
let browserLaunchPromise = null;
let lastBrowserLaunchAt = 0;
let lastStoreOpenAt = 0;
let lastOnboardingPageOpenAt = 0;
let firstStartOnboardingOpenedAt = 0;
let onboardingRuntime = { stage: "idle", updatedAt: Date.now() };
const bridgeOwnedBrowserSessions = new Map();
let bridgeBrowserSessionCounter = 1;
const pendingRequests = new Map();
let requestIdCounter = 1;
let shuttingDown = false;
let lastDispatchedRequestId = "";
const BRIDGE_TRACE_LIMIT = 100;
const bridgeTrace = [];

function traceBridgeEvent(event, details = {}) {
  bridgeTrace.push({ at: Date.now(), event, ...details });
  if (bridgeTrace.length > BRIDGE_TRACE_LIMIT) bridgeTrace.shift();
}

function updateOnboardingRuntime(update) {
  onboardingRuntime = { ...onboardingRuntime, ...update, updatedAt: Date.now() };
  traceBridgeEvent("onboarding_state_changed", { stage: onboardingRuntime.stage, browser: onboardingRuntime.browser || "" });
}

// --- 异步任务管理 ---
const asyncJobs = new Map();
const requestIndex = new Map();
const ASYNC_ATTEMPT_TIMEOUT_MS = 360000; // 单次尝试 6 分钟
let persistJobsTimer = null;
let persistRequestIndexTimer = null;
let cleanupTimer = null;
let writeQueue = Promise.resolve();

function ensureJobsDirReady() {
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
  }
}

function ensureJobDetailsDirReady() {
  ensureJobsDirReady();
  if (!fs.existsSync(JOB_DETAILS_DIR)) {
    fs.mkdirSync(JOB_DETAILS_DIR, { recursive: true });
  }
}

function getJobDetailPath(jobId) {
  return path.join(JOB_DETAILS_DIR, `${jobId}.json`);
}

function writeFileAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (e) {
    // Windows 上 rename 覆盖已存在文件可能失败，降级为先删后改名
    if (e && (e.code === "EEXIST" || e.code === "EPERM")) {
      try { fs.unlinkSync(targetPath); } catch (_ignore) {}
      fs.renameSync(tmpPath, targetPath);
    } else {
      try { fs.unlinkSync(tmpPath); } catch (_ignore) {}
      throw e;
    }
  }
}

function enqueueWrite(task, label = "write_task") {
  writeQueue = writeQueue
    .then(async () => {
      await task();
    })
    .catch((e) => {
      console.error(`Write queue task failed [${label}]:`, e.message);
    });
  return writeQueue;
}

async function writeFileAtomicAsync(targetPath, content) {
  const fsp = fs.promises;
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, content, "utf8");
  try {
    await fsp.rename(tmpPath, targetPath);
  } catch (e) {
    if (e && (e.code === "EEXIST" || e.code === "EPERM")) {
      try { await fsp.unlink(targetPath); } catch (_ignore) {}
      await fsp.rename(tmpPath, targetPath);
    } else {
      try { await fsp.unlink(tmpPath); } catch (_ignore) {}
      throw e;
    }
  }
}

function getOpenExtensionConnection(preferredBrowser = "") {
  const normalizedBrowser = normalizeBrowserName(preferredBrowser);
  const candidates = Array.from(extensionConnections.values())
    .filter((connection) => connection.socket.readyState === 1)
    .filter((connection) => !normalizedBrowser || connection.browser === normalizedBrowser)
    .sort((a, b) => b.connectedAt - a.connectedAt);
  return candidates[0] || null;
}

function getOpenExtensionSocket(preferredBrowser = "") {
  const connection = getOpenExtensionConnection(preferredBrowser);
  extensionSocket = connection?.socket || null;
  return extensionSocket;
}

function isExtensionConnected(preferredBrowser = "") {
  return !!getOpenExtensionSocket(preferredBrowser);
}

function normalizeBrowserName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "edge" || normalized === "microsoft-edge" || normalized === "msedge") return "edge";
  if (normalized === "chrome" || normalized === "google-chrome") return "chrome";
  return "";
}

function detectBrowserFromUserAgent(userAgent) {
  const value = String(userAgent || "");
  if (/\bEdg\//i.test(value)) return "edge";
  if (/\bChrome\//i.test(value) && !/\b(?:OPR|Edg)\//i.test(value)) return "chrome";
  return "";
}

function loadLastBrowserConnection() {
  try {
    if (!fs.existsSync(BROWSER_CONNECTION_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(BROWSER_CONNECTION_PATH, "utf8") || "{}");
    const browser = normalizeBrowserName(parsed?.browser);
    if (!browser) return null;
    return {
      browser,
      detectedAt: Number(parsed.detectedAt || 0) || 0,
      profileId: normalizeProfileId(parsed.profileId),
      profileDisplayName: String(parsed.profileDisplayName || "").slice(0, 120),
      installationId: String(parsed.installationId || "").slice(0, 160),
      extensionVersion: String(parsed.extensionVersion || "").slice(0, 80)
    };
  } catch (e) {
    console.warn(`Failed to load last browser connection: ${e.message}`);
    return null;
  }
}

function normalizeProfileId(value) {
  const profileId = String(value || "").trim();
  return /^(Default|Profile [0-9]+)$/.test(profileId) ? profileId : "";
}

function persistLastBrowserConnection(browser, details = {}) {
  const normalized = normalizeBrowserName(browser);
  if (!normalized) return;
  lastBrowserConnection = {
    ...(lastBrowserConnection || {}),
    browser: normalized,
    detectedAt: Date.now(),
    profileId: normalizeProfileId(details.profileId) || lastBrowserConnection?.profileId || "",
    profileDisplayName: String(details.profileDisplayName || lastBrowserConnection?.profileDisplayName || "").slice(0, 120),
    installationId: String(details.installationId || lastBrowserConnection?.installationId || "").slice(0, 160),
    extensionVersion: String(details.extensionVersion || lastBrowserConnection?.extensionVersion || "").slice(0, 80)
  };
  try {
    ensureJobsDirReady();
    writeFileAtomic(BROWSER_CONNECTION_PATH, JSON.stringify(lastBrowserConnection));
  } catch (e) {
    console.warn(`Failed to persist last browser connection: ${e.message}`);
  }
}

function loadOnboardingState() {
  try {
    if (!fs.existsSync(ONBOARDING_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(ONBOARDING_STATE_PATH, "utf8") || "{}");
  } catch (_e) {
    return {};
  }
}

function persistOnboardingState(update) {
  try {
    ensureJobsDirReady();
    const state = { ...loadOnboardingState(), ...update };
    writeFileAtomic(ONBOARDING_STATE_PATH, JSON.stringify(state));
    return state;
  } catch (e) {
    console.warn(`Failed to persist onboarding state: ${e.message}`);
    return null;
  }
}

function getExtensionStoreUrl(browser) {
  return normalizeBrowserName(browser) === "edge"
    ? EDGE_EXTENSION_STORE_URL
    : CHROME_EXTENSION_STORE_URL;
}

function openExternalUrl(url, browser = "") {
  if (process.platform === "darwin") {
    const appName = normalizeBrowserName(browser) === "edge" ? "Microsoft Edge" : "Google Chrome";
    // 指定浏览器应用打开 URL，避免系统把商店页交给另一个默认浏览器或放到后台。
    return spawn("open", ["-a", appName, url], { detached: true, stdio: "ignore" });
  }
  if (process.platform === "win32") {
    const normalized = normalizeBrowserName(browser);
    const executable = normalized === "edge" ? "msedge.exe" : "chrome.exe";
    const browserPath = getWindowsBrowserExecutable(normalized);
    if (browserPath) return spawn(browserPath, [url], { detached: true, windowsHide: true, stdio: "ignore" });
    return spawn("cmd.exe", ["/d", "/s", "/c", "start", "", executable, url], { detached: true, windowsHide: true, stdio: "ignore" });
  }
  const normalized = normalizeBrowserName(browser);
  const executable = normalized === "edge" ? "microsoft-edge" : "google-chrome";
  return spawn(findFirstCommand([executable]) || "xdg-open", [url], { detached: true, stdio: "ignore" });
}

function getOnboardingUrl() {
  return `http://127.0.0.1:${HTTP_PORT}${ONBOARDING_PATH}`;
}

function openOnboardingPage(browser) {
  if (!normalizeBrowserName(browser)) return { opened: false, reason: "browser_unknown" };
  if (Date.now() - lastOnboardingPageOpenAt < 3000) return { opened: false, reason: "cooldown" };
  try {
    const child = openExternalUrl(getOnboardingUrl(), browser);
    child.unref();
    lastOnboardingPageOpenAt = Date.now();
    traceBridgeEvent("onboarding_page_opened", { browser });
    return { opened: true, url: getOnboardingUrl() };
  } catch (e) {
    return { opened: false, reason: e.message };
  }
}

function maybeOpenOnboardingOnFirstStart() {
  if (!AUTO_OPEN_ONBOARDING_ON_FIRST_START || !AUTO_LAUNCH_BROWSER) {
    return { opened: false, reason: "disabled" };
  }

  const state = loadOnboardingState();
  // completedAt 兼容旧版本：已经完成过一次扩展连接的用户，不再被首次引导打扰。
  if (state.onboardingAutoOpenedAt || state.completedAt) {
    return { opened: false, reason: "already_opened" };
  }

  const browser = getBrowserToLaunch();
  if (!browser) return { opened: false, reason: "browser_unknown" };

  const result = AUTO_LAUNCH_BROWSER_DRY_RUN
    ? { opened: true, url: getOnboardingUrl(), dryRun: true }
    : openOnboardingPage(browser);
  if (!result.opened) return result;

  const openedAt = Date.now();
  firstStartOnboardingOpenedAt = openedAt;
  persistOnboardingState({
    onboardingAutoOpenedAt: openedAt,
    onboardingAutoOpenedBrowser: browser,
    onboardingAutoOpenedUrl: getOnboardingUrl()
  });
  updateOnboardingRuntime({
    stage: isExtensionConnected(browser) ? "ready" : "idle",
    browser,
    onboardingAutoOpenedAt: openedAt
  });
  traceBridgeEvent("onboarding_auto_opened_on_first_start", {
    browser,
    url: getOnboardingUrl(),
    dryRun: !!result.dryRun
  });
  return { ...result, browser };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

function renderOnboardingPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gecho · 浏览器准备中心</title><style>
:root{--ink:#171820;--muted:#747887;--line:#e6e7ed;--soft:#f7f8fb;--green:#19a86b;--cyan:#36d9ed;--violet:#7959f6}*{box-sizing:border-box}body{margin:0;background:radial-gradient(720px 420px at 76% -5%,#e8e5ff 0,rgba(232,229,255,0) 72%),#fff;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.page{max-width:1120px;margin:0 auto;padding:28px 30px 64px}.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:64px}.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:760;letter-spacing:-.3px}.mark{position:relative;width:30px;height:30px;transform:rotate(-8deg)}.mark i{position:absolute;display:block;width:18px;height:12px;border-radius:4px 10px 4px 10px;background:linear-gradient(135deg,#45e5f7,#1588ee);box-shadow:0 3px 8px #33d9f866}.mark i:first-child{left:1px;top:5px;transform:rotate(-21deg)}.mark i:last-child{right:0;bottom:3px;transform:rotate(78deg);background:linear-gradient(135deg,#a25af7,#2e54ed)}.badge{display:flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:#ffffffb8;color:#565a67;font-size:12px}.pulse{width:7px;height:7px;border-radius:50%;background:#1f2028;box-shadow:0 0 0 0 rgba(31,32,40,.25);animation:pulse 1.8s infinite}@keyframes pulse{70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}.hero{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(310px,.88fr);gap:42px;align-items:center}.eyebrow{color:#6c55e7;font-size:13px;font-weight:750;letter-spacing:.08em}.hero h1{max-width:630px;margin:16px 0 18px;font-size:50px;line-height:1.12;letter-spacing:-2.4px}.hero h1 em{font-style:normal;background:linear-gradient(105deg,#1b9de8,#7655f1);background-clip:text;-webkit-background-clip:text;color:transparent}.hero-copy{max-width:570px;margin:0;color:var(--muted);font-size:18px;line-height:1.75}.hero-actions{display:flex;align-items:center;gap:18px;margin-top:30px}.button{display:inline-flex;justify-content:center;align-items:center;min-height:48px;padding:0 20px;border:1px solid transparent;border-radius:12px;font:700 15px inherit;text-decoration:none;cursor:pointer;transition:transform .18s,box-shadow .18s}.button:hover{transform:translateY(-1px)}.button.primary{background:#1b1c23;color:#fff;box-shadow:0 10px 24px #25263126}.button.primary:hover{box-shadow:0 14px 28px #25263135}.button.ghost{padding:0;border:0;background:transparent;color:#555966}.button:disabled{opacity:.55;cursor:default;transform:none}.task-card{position:relative;overflow:hidden;padding:26px;border:1px solid var(--line);border-radius:22px;background:#ffffffde;box-shadow:0 20px 55px #26263a0e}.task-card:after{content:"";position:absolute;width:180px;height:180px;right:-95px;top:-96px;border-radius:50%;background:linear-gradient(135deg,#c9f4fa,#d9d0ff);filter:blur(1px)}.card-kicker{position:relative;z-index:1;color:#6f7380;font-size:13px;font-weight:700}.task-name{position:relative;z-index:1;margin:12px 0 20px;font-size:22px;font-weight:760;letter-spacing:-.6px}.task-rule{height:1px;background:var(--line);margin:0 -2px 19px}.live-status{display:flex;align-items:flex-start;gap:10px}.live-dot{width:9px;height:9px;margin-top:6px;border-radius:50%;background:#1d1e24;flex:0 0 auto}.live-copy strong{display:block;font-size:14px;margin-bottom:4px}.live-copy span{display:block;color:var(--muted);font-size:13px;line-height:1.55}.task-note{position:relative;z-index:1;margin:22px 0 0;padding:12px 13px;border-radius:10px;background:var(--soft);color:#696d7a;font-size:13px;line-height:1.55}.section{margin-top:76px}.section-title{margin:0 0 8px;font-size:25px;letter-spacing:-.8px}.section-lead{margin:0;color:var(--muted);font-size:15px;line-height:1.65}.progress{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:25px}.progress-card{position:relative;min-height:155px;padding:20px;border:1px solid var(--line);border-radius:17px;background:#fff}.progress-card:before{content:"";position:absolute;top:0;left:20px;right:20px;height:2px;border-radius:99px;background:#e7e8ed}.progress-card.active:before{background:linear-gradient(90deg,var(--cyan),var(--violet))}.progress-card.done:before{background:var(--green)}.step-top{display:flex;align-items:center;justify-content:space-between;color:#838793;font-size:12px;font-weight:700}.step-icon{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#eff0f4;color:#737784;font-size:13px}.active .step-icon{background:#e7e4ff;color:#644be7}.done .step-icon{background:#def5e9;color:#168652}.step-title{margin:17px 0 6px;font-size:16px;font-weight:740}.step-copy{color:var(--muted);font-size:13px;line-height:1.55}.benefits{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:25px}.benefit{padding:21px;border-radius:17px;background:var(--soft);border:1px solid #eff0f3}.benefit-num{color:#785bee;font-size:12px;font-weight:800;letter-spacing:.08em}.benefit h3{margin:14px 0 8px;font-size:16px}.benefit p{margin:0;color:var(--muted);font-size:13px;line-height:1.6}.support{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:50px;padding:22px 24px;border:1px solid var(--line);border-radius:17px;background:#fff}.support strong{display:block;font-size:15px;margin-bottom:5px}.support span{color:var(--muted);font-size:13px;line-height:1.5}.support-links{display:flex;align-items:center;gap:17px;flex:0 0 auto}.text-link{border:0;padding:0;background:none;color:#4b4f5b;font:650 13px inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}.feedback{min-height:20px;margin:15px 0 0;color:#666b77;font-size:13px;text-align:left}@media(max-width:780px){.page{padding:22px 20px 48px}.nav{margin-bottom:46px}.hero{grid-template-columns:1fr;gap:30px}.hero h1{font-size:42px}.progress,.benefits{grid-template-columns:1fr}.section{margin-top:55px}.support{align-items:flex-start;flex-direction:column}.hero-actions{align-items:flex-start;flex-direction:column;gap:13px}}@media(max-width:430px){.badge{display:none}.hero h1{font-size:36px;letter-spacing:-1.6px}.hero-copy{font-size:16px}.button.primary{width:100%}}</style></head>
<body><main class="page"><nav class="nav"><div class="brand"><span class="mark"><i></i><i></i></span><span>Gecho</span></div><div class="badge"><i class="pulse" id="pulse"></i><span id="nav-status">浏览器准备中</span></div></nav><section class="hero"><div><div class="eyebrow">首次使用 · 浏览器连接</div><h1 id="title">让 AI 在你的<em>真实浏览器</em>中完成任务</h1><p class="hero-copy" id="lead">安装 Gecho 扩展后，AI 将在你已登录的浏览器环境中完成检索、采集与分析。当前任务会自动继续，无需回到 Trae 再次执行。</p><div class="hero-actions"><a class="button primary" id="store" target="_blank" rel="noopener">安装 Gecho 扩展</a><button class="button ghost" id="recheck" type="button">重新检测连接</button></div><p class="feedback" id="feedback" aria-live="polite"></p></div><aside class="task-card"><div class="card-kicker">当前正在准备</div><div class="task-name" id="task-name">浏览器自动化任务</div><div class="task-rule"></div><div class="live-status"><i class="live-dot" id="live-dot"></i><div class="live-copy"><strong id="status">正在检测 Gecho 扩展…</strong><span id="status-detail">请在当前浏览器完成安装，连接成功后会自动继续。</span></div></div><p class="task-note" id="task-note">请使用安装扩展的同一个浏览器 Profile；如需登录平台，请先在浏览器中完成。</p></aside></section><section class="section"><h2 class="section-title">准备好后，任务将自动继续</h2><p class="section-lead">无需手动复制链接或重新发起请求，Bridge 会在扩展连接后完成后续步骤。</p><div class="progress"><article class="progress-card" id="step-browser"><div class="step-top"><span>步骤 01</span><i class="step-icon">✓</i></div><h3 class="step-title">启动正确的浏览器</h3><p class="step-copy" id="browser-copy">正在识别 Chrome 或 Edge。</p></article><article class="progress-card" id="step-extension"><div class="step-top"><span>步骤 02</span><i class="step-icon">⌁</i></div><h3 class="step-title">安装并连接扩展</h3><p class="step-copy">点击上方安装按钮，在官方商店确认“添加至 Chrome”。</p></article><article class="progress-card" id="step-task"><div class="step-top"><span>步骤 03</span><i class="step-icon">→</i></div><h3 class="step-title">继续当前任务</h3><p class="step-copy" id="task-copy">扩展就绪后自动打开任务页面并执行。</p></article></div></section><section class="section"><h2 class="section-title">Gecho 如何帮助你工作</h2><p class="section-lead">连接的是你的浏览器环境，因此可以在保留登录状态与人工控制的前提下执行任务。</p><div class="benefits"><article class="benefit"><div class="benefit-num">01 / 浏览器上下文</div><h3>保留登录状态</h3><p>在你自己的 Chrome 或 Edge Profile 中执行，避免重复登录与环境丢失。</p></article><article class="benefit"><div class="benefit-num">02 / 自动恢复</div><h3>任务不中断</h3><p>首次安装完成后，等待中的任务会自动恢复，无需回到对话重新发起。</p></article><article class="benefit"><div class="benefit-num">03 / 始终可控</div><h3>需要时人工接管</h3><p>登录、验证码或平台验证仍由你在浏览器中确认，过程清晰可见。</p></article></div></section><footer class="support"><div><strong>需要进一步了解 Gecho？</strong><span>可访问官网了解产品与支持信息；连接问题也可在此页重新检测。</span></div><div class="support-links"><a class="text-link" id="website" target="_blank" rel="noopener" hidden>访问官网</a><a class="text-link" id="tutorial" target="_blank" rel="noopener" hidden>使用教程</a></div></footer></main><script>const $=id=>document.getElementById(id);let state={};const taskNames={tiktok_search:'TikTok 搜索任务',tiktok_video_search:'TikTok 视频搜索任务',amazon_search:'Amazon 搜索任务',x_search:'X 搜索任务',search:'平台搜索任务'};function setLink(id,url){const el=$(id);el.hidden=!url;el.href=url||'#'}function setStep(id,mode){const el=$(id);el.classList.toggle('done',mode==='done');el.classList.toggle('active',mode==='active')}function taskName(action){return taskNames[action]||'浏览器自动化任务'}function render(message=''){const ready=state.stage==='ready';const hasBrowser=!!state.browser;const waiting=state.stage==='waiting_user_install_or_enable'||state.stage==='extension_not_connected';$('task-name').textContent=taskName(state.action);$('status').textContent=state.message||'正在检测 Gecho 扩展…';$('nav-status').textContent=ready?'浏览器已连接':waiting?'等待扩展连接':'浏览器准备中';$('live-dot').style.background=ready?'#19a86b':'#1d1e24';$('pulse').style.background=ready?'#19a86b':'#1d1e24';$('title').innerHTML=ready?'浏览器已<em>准备就绪</em>':'让 AI 在你的<em>真实浏览器</em>中完成任务';$('lead').textContent=ready?'Gecho 扩展已连接。Bridge 正在打开任务页面并继续当前操作。':'安装 Gecho 扩展后，AI 将在你已登录的浏览器环境中完成检索、采集与分析。当前任务会自动继续，无需回到 Trae 再次执行。';$('status-detail').textContent=ready?'连接已确认，当前任务将自动继续。':waiting?'请在官方商店完成安装，并保持浏览器窗口打开。':'Bridge 正在启动浏览器并检测扩展。';$('store').href=state.storeUrl||'#';$('store').style.pointerEvents=ready?'none':'auto';$('store').style.opacity=ready?'.55':'1';$('store').textContent=ready?'扩展已连接':'安装 Gecho 扩展';$('browser-copy').textContent=hasBrowser?('已选择 '+state.browser.toUpperCase()+'，请使用此浏览器完成安装。'):'正在识别 Chrome 或 Edge。';$('task-copy').textContent=ready?'正在打开任务页面并继续执行。':'扩展就绪后自动打开任务页面并执行。';setStep('step-browser',hasBrowser?'done':'active');setStep('step-extension',ready?'done':'active');setStep('step-task',ready?'active':'');setLink('website',state.websiteUrl);setLink('tutorial',state.tutorialUrl);if(message)$('feedback').textContent=message}async function refresh(message=''){try{const r=await fetch('/onboarding/status');state=await r.json();render(message)}catch(_){$('feedback').textContent='暂时无法连接 Bridge，请保持此页面打开后重试。'}}$('store').onclick=()=>{$('feedback').textContent='已打开官方扩展商店，请确认安装。'};$('recheck').onclick=async()=>{const r=await fetch('/onboarding/recheck',{method:'POST'});const s=await r.json();refresh(s.extensionConnected?'检测成功：扩展已连接。':'暂未检测到扩展，请完成安装或确认扩展已启用。')};refresh();setInterval(refresh,1500);</script></body></html>`;
}

function findFirstExistingPath(paths) {
  return paths.find((candidate) => {
    try {
      return !!candidate && fs.existsSync(candidate);
    } catch (_e) {
      return false;
    }
  }) || "";
}

function findFirstCommand(commands) {
  const pathEntries = String(process["env"].PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process["env"].PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const command of commands) {
    for (const entry of pathEntries) {
      for (const extension of extensions) {
        const executable = path.join(entry, process.platform === "win32" ? `${command}${extension}` : command);
        if (fs.existsSync(executable)) return executable;
      }
    }
  }
  return "";
}

function getWindowsBrowserExecutable(browser) {
  const normalized = normalizeBrowserName(browser);
  const executable = normalized === "edge" ? "msedge.exe" : "chrome.exe";
  const vendorPath = normalized === "edge" ? ["Microsoft", "Edge", "Application"] : ["Google", "Chrome", "Application"];
  const roots = [
    process["env"].LOCALAPPDATA,
    process["env"].PROGRAMFILES,
    process["env"]["PROGRAMFILES(X86)"]
  ].filter(Boolean);

  return findFirstExistingPath(roots.map((root) => path.join(root, ...vendorPath, executable)));
}

function isBrowserInstalled(browser) {
  const normalized = normalizeBrowserName(browser);
  if (!normalized) return false;

  if (process.platform === "darwin") {
    const appName = normalized === "edge" ? "Microsoft Edge.app" : "Google Chrome.app";
    return !!findFirstExistingPath([
      path.join("/Applications", appName),
      path.join("/System/Applications", appName)
    ]);
  }

  if (process.platform === "win32") {
    return !!getWindowsBrowserExecutable(normalized);
  }

  return !!findFirstCommand(
    normalized === "edge"
      ? ["microsoft-edge", "microsoft-edge-stable"]
      : ["google-chrome", "google-chrome-stable"]
  );
}

function getBrowserToLaunch() {
  const configured = normalizeBrowserName(process["env"].GECHO_BROWSER);
  if (configured) return configured;
  if (lastBrowserConnection?.browser) return lastBrowserConnection.browser;

  // First use: prefer Chrome. If it is not installed, use Edge as a fallback.
  if (isBrowserInstalled("chrome")) return "chrome";
  if (isBrowserInstalled("edge")) return "edge";
  return "";
}

function getBrowserTargetUrl(action) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (normalizedAction.includes("tiktok") || normalizedAction === "search") {
    return "https://www.tiktok.com/";
  }
  if (normalizedAction.includes("amazon")) {
    return "https://www.amazon.com/";
  }
  if (normalizedAction.includes("x_") || normalizedAction === "x_search") {
    return "https://x.com/";
  }
  return "about:blank";
}

function isBrowserRunning(browser) {
  const normalized = normalizeBrowserName(browser);
  if (!normalized) return false;
  try {
    if (process.platform === "darwin") {
      const executable = normalized === "edge"
        ? "/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        : "/Google Chrome.app/Contents/MacOS/Google Chrome";
      return spawnSync("pgrep", ["-f", executable], { stdio: "ignore" }).status === 0;
    }
    if (process.platform === "win32") {
      const executable = normalized === "edge" ? "msedge.exe" : "chrome.exe";
      const result = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${executable}`, "/NH"], { encoding: "utf8", windowsHide: true });
      return String(result.stdout || "").toLowerCase().includes(executable);
    }
    const executable = normalized === "edge" ? "microsoft-edge" : "google-chrome";
    return spawnSync("pgrep", ["-f", executable], { stdio: "ignore" }).status === 0;
  } catch (_e) {
    return false;
  }
}

function getBrowserWindowCount(browser) {
  if (process.platform !== "darwin") return null;
  if (!isBrowserRunning(browser)) return 0;
  const appName = normalizeBrowserName(browser) === "edge" ? "Microsoft Edge" : "Google Chrome";
  try {
    const result = spawnSync("osascript", ["-e", `tell application \"${appName}\" to count windows`], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const count = Number(String(result.stdout || "").trim());
    return Number.isFinite(count) ? count : null;
  } catch (_e) {
    return null;
  }
}

function retainBridgeOwnedBrowser(preferredSessionId = "", browser = "") {
  let session = preferredSessionId ? bridgeOwnedBrowserSessions.get(preferredSessionId) : null;
  if (!session && browser) {
    session = Array.from(bridgeOwnedBrowserSessions.values())
      .filter((candidate) => candidate.browser === browser)
      .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  }
  if (!session) return "";
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
  }
  session.activeTaskCount += 1;
  return session.id;
}

function closeBrowserApplication(browser, closeMode = "application") {
  const normalized = normalizeBrowserName(browser);
  if (!normalized) return;
  if (process.platform === "darwin") {
    if (closeMode === "window") {
      const appName = normalized === "edge" ? "Microsoft Edge" : "Google Chrome";
      spawn("osascript", ["-e", `tell application \"${appName}\" to close front window`], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    const executable = normalized === "edge"
      ? "/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      : "/Google Chrome.app/Contents/MacOS/Google Chrome";
    spawn("pkill", ["-TERM", "-f", executable], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    const executable = normalized === "edge" ? "msedge.exe" : "chrome.exe";
    spawn("taskkill", ["/IM", executable, "/T", "/F"], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    return;
  }
  const executable = normalized === "edge" ? "microsoft-edge" : "google-chrome";
  spawn("pkill", ["-TERM", "-f", executable], { detached: true, stdio: "ignore" }).unref();
}

function releaseBridgeOwnedBrowser(sessionId, reason) {
  const session = sessionId ? bridgeOwnedBrowserSessions.get(sessionId) : null;
  if (!session) return;
  session.activeTaskCount = Math.max(0, session.activeTaskCount - 1);
  if (!AUTO_CLOSE_LAUNCHED_BROWSER || session.activeTaskCount > 0 || session.closeTimer) return;
  traceBridgeEvent("bridge_browser_closing", { browser: session.browser, reason });
  session.closeTimer = setTimeout(() => {
    if (session.activeTaskCount === 0) {
      closeBrowserApplication(session.browser, session.closeMode);
      bridgeOwnedBrowserSessions.delete(session.id);
    }
  }, 300);
  session.closeTimer.unref?.();
}

function getBrowserLaunchSpec(browser, targetUrls = ["about:blank"]) {
  const normalized = normalizeBrowserName(browser);
  const appName = normalized === "edge" ? "Microsoft Edge" : "Google Chrome";
  const profileId = normalizeProfileId(lastBrowserConnection?.profileId);
  const profileArgs = profileId ? ["--profile-directory", profileId] : [];
  const urls = (Array.isArray(targetUrls) ? targetUrls : [targetUrls])
    .filter((url) => typeof url === "string" && /^(https?:|about:)/.test(url));
  const launchUrls = urls.length > 0 ? urls : ["about:blank"];

  if (!normalized) return null;

  if (process.platform === "darwin") {
    // When no specific profile is required, hand URLs to the app directly.
    // macOS/Chrome then opens them as tabs in the existing front window (or in
    // one newly-created window) instead of silently ignoring --args for an
    // already-running Chrome process.
    if (!profileId) {
      return {
        command: "open",
        args: ["-a", appName, ...launchUrls]
      };
    }
    return {
      command: "open",
      args: ["-a", appName, "--args", ...profileArgs, "--new-window", ...launchUrls]
    };
  }

  if (process.platform === "win32") {
    const browserPath = getWindowsBrowserExecutable(normalized);
    if (browserPath) {
      return {
        command: browserPath,
        args: [...profileArgs, "--new-window", ...launchUrls]
      };
    }

    const executable = normalized === "edge" ? "msedge" : "chrome";
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", executable, ...profileArgs, "--new-window", ...launchUrls]
    };
  }

  const executable = findFirstCommand(
    normalized === "edge"
      ? ["microsoft-edge", "microsoft-edge-stable"]
      : ["google-chrome", "google-chrome-stable"]
  ) || (normalized === "edge" ? "microsoft-edge" : "google-chrome");

  return {
    command: executable,
    args: [...profileArgs, "--new-window", ...launchUrls]
  };
}

async function launchBrowserForExtension(action, targetUrlsOverride = null) {
  if (!AUTO_LAUNCH_BROWSER) {
    return { attempted: false, launched: false, reason: "disabled" };
  }

  const browser = getBrowserToLaunch();
  const targetUrls = targetUrlsOverride || [getBrowserTargetUrl(action)];
  const spec = getBrowserLaunchSpec(browser, targetUrls);
  if (!spec) {
    return { attempted: false, launched: false, reason: "browser_unknown" };
  }

  if (browserLaunchPromise) return browserLaunchPromise;
  if (Date.now() - lastBrowserLaunchAt < AUTO_LAUNCH_BROWSER_COOLDOWN_MS) {
    return { attempted: false, launched: false, browser, reason: "cooldown" };
  }
  lastBrowserLaunchAt = Date.now();
  const browserWasRunning = isBrowserRunning(browser);
  const browserWindowCount = getBrowserWindowCount(browser);

  // 首次启动已经打开了 onboarding 时，后续 Agent 紧接着发起任务不要再
  // 打开第二个 onboarding 标签页；沿用当前浏览器窗口即可。
  const requestedOnboarding = targetUrls.includes(getOnboardingUrl());
  if (requestedOnboarding && browserWasRunning && firstStartOnboardingOpenedAt && Date.now() - firstStartOnboardingOpenedAt < 10 * 60 * 1000) {
    traceBridgeEvent("onboarding_page_reused_for_action", { browser, url: getOnboardingUrl() });
    return { attempted: true, launched: true, browser, targetUrls, browserWasRunning, browserWindowCount, reusedExistingOnboarding: true };
  }

  browserLaunchPromise = new Promise((resolve) => {
    if (AUTO_LAUNCH_BROWSER_DRY_RUN) {
      console.log(`🧪 Browser launch dry run: ${browser}`);
      resolve({ attempted: true, launched: true, browser, targetUrls, browserWasRunning, dryRun: true });
      return;
    }

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        // A detached Windows process starts in a separate process group. That
        // extra isolation is not needed for a GUI browser after unref(), and
        // can prevent an extension service worker from reconnecting when the
        // bridge itself was started by a desktop MCP host.
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true
      });
    } catch (e) {
      resolve({ attempted: true, launched: false, browser, reason: e.message });
      return;
    }

    child.once("error", (e) => {
      resolve({ attempted: true, launched: false, browser, reason: e.message });
    });
    child.once("spawn", () => {
      child.unref();
      console.log(`🌐 Started ${browser} while waiting for the extension connection (${targetUrls.join(", ")})`);
      let bridgeBrowserSessionId = "";
      const ownsLaunchedWindow = process.platform === "darwin"
        ? browserWindowCount === 0
        : !browserWasRunning;
      if (ownsLaunchedWindow) {
        const session = {
          id: `bridge-browser-${Date.now()}-${bridgeBrowserSessionCounter++}`,
          browser,
          activeTaskCount: 0,
          startedAt: Date.now(),
          closeMode: process.platform === "darwin" ? "window" : "application",
          closeTimer: null
        };
        bridgeOwnedBrowserSessions.set(session.id, session);
        bridgeBrowserSessionId = session.id;
      }
      resolve({ attempted: true, launched: true, browser, targetUrls, browserWasRunning, browserWindowCount, bridgeBrowserSessionId });
    });
  });

  try {
    return await browserLaunchPromise;
  } finally {
    browserLaunchPromise = null;
  }
}

function waitForExtensionConnection(timeoutMs = EXTENSION_CONNECT_TIMEOUT_MS, preferredBrowser = "") {
  return new Promise((resolve) => {
    if (isExtensionConnected(preferredBrowser)) return resolve(true);

    let waited = 0;
    const checkTimer = setInterval(() => {
      waited += EXTENSION_CONNECT_POLL_MS;
      if (isExtensionConnected(preferredBrowser)) {
        clearInterval(checkTimer);
        resolve(true);
      } else if (waited >= timeoutMs) {
        clearInterval(checkTimer);
        resolve(false);
      }
    }, EXTENSION_CONNECT_POLL_MS);
  });
}

async function waitForExtensionReadyGracePeriod(preferredBrowser = "") {
  const remainingMs = Math.max(0, EXTENSION_READY_GRACE_MS - (Date.now() - lastExtensionConnectedAt));
  if (remainingMs === 0) return isExtensionConnected(preferredBrowser);

  traceBridgeEvent("extension_ready_grace_wait_started", { remainingMs });
  await new Promise(resolve => setTimeout(resolve, remainingMs));
  const connected = isExtensionConnected(preferredBrowser);
  traceBridgeEvent("extension_ready_grace_wait_finished", { connected });
  return connected;
}

async function ensureExtensionConnection(action) {
  const preferredBrowser = getBrowserToLaunch();
  const existingConnection = getOpenExtensionConnection(preferredBrowser);
  if (existingConnection) {
    updateOnboardingRuntime({ stage: "ready", action, browser: existingConnection.browser });
    traceBridgeEvent("extension_already_connected", { action });
    return { connected: true, socket: existingConnection.socket, browser: existingConnection.browser, launch: { attempted: false, launched: false, reason: "already_connected" } };
  }

  traceBridgeEvent("extension_connection_wait_started", { action });
  const browserToLaunch = preferredBrowser;
  // 安装状态不能靠旧的本地记录判断：用户可能卸载、禁用，或换了 Profile。
  // 未连接时始终先进入 onboarding，不要抢先打开业务页。这样用户能清楚地
  // 看到安装与连接状态，而不是在 TikTok/Amazon 的空白任务页里迷失。
  const initialTargetUrls = [getOnboardingUrl()];
  const launch = await launchBrowserForExtension(action, initialTargetUrls);
  let onboarding = null;
  let phase = "browser_starting";
  updateOnboardingRuntime({ stage: "browser_starting", action, browser: launch.browser || browserToLaunch });
  console.log(
    `⏳ Extension not connected yet. Waiting up to ${EXTENSION_RECONNECT_PROBE_TIMEOUT_MS / 1000}s ` +
    `(action: ${action}, browser: ${launch.browser || "unknown"})`
  );
  let connected = await waitForExtensionConnection(Math.min(EXTENSION_CONNECT_TIMEOUT_MS, EXTENSION_RECONNECT_PROBE_TIMEOUT_MS), launch.browser);

  if (!connected && launch.browser) {
    phase = "waiting_user_install_or_enable";
    // 商店页只应由用户在 onboarding 中主动打开：自动打开会抢焦点、产生
    // 重复标签页，也让“为什么突然打开页面”变得不清楚。
    onboarding = { opened: false, url: getExtensionStoreUrl(launch.browser), reason: "user_action_required" };
    if (!launch.launched) openOnboardingPage(launch.browser);
    updateOnboardingRuntime({
      stage: "waiting_user_install_or_enable",
      action,
      browser: launch.browser,
      storeUrl: onboarding.url,
      onboardingUrl: getOnboardingUrl()
    });
    console.log(
      `🧩 Extension not connected. Onboarding is open; waiting up to ` +
      `${EXTENSION_ONBOARDING_TIMEOUT_MS / 1000}s for installation or enablement.`
    );
    traceBridgeEvent("extension_onboarding_wait_started", {
      action,
      browser: launch.browser,
      storeUrl: onboarding.url,
      onboardingUrl: getOnboardingUrl(),
      timeoutMs: EXTENSION_ONBOARDING_TIMEOUT_MS
    });
    connected = await waitForExtensionConnection(EXTENSION_ONBOARDING_TIMEOUT_MS, launch.browser);
  }

  const ready = connected && await waitForExtensionReadyGracePeriod(launch.browser);
  const selectedConnection = ready ? getOpenExtensionConnection(launch.browser) : null;
  if (ready) {
    persistOnboardingState({ completedAt: Date.now(), completedBrowser: lastBrowserConnection?.browser || launch.browser || "" });
    phase = "ready";
    const browser = selectedConnection?.browser || launch.browser;
    const taskTargetUrl = getBrowserTargetUrl(action);
    // 任务页由扩展根据 action 统一打开。Bridge 不再额外打开 TikTok 首页，
    // 避免出现“首页 + 搜索页”两个重复标签页。
    traceBridgeEvent("task_page_delegated_to_extension", { action, browser, expectedUrl: taskTargetUrl });
    updateOnboardingRuntime({ stage: "ready", action, browser, taskTargetUrl });
  } else if (!launch.browser) {
    phase = "browser_not_found";
    updateOnboardingRuntime({ stage: "extension_not_connected", action, browser: "" });
  } else {
    phase = "extension_not_connected";
    updateOnboardingRuntime({ stage: "extension_not_connected", action, browser: launch.browser });
  }
  traceBridgeEvent("extension_connection_wait_finished", {
    action,
    connected: ready,
    phase,
    browser: launch.browser || "",
    launchReason: launch.reason || ""
  });
  return { connected: ready && !!selectedConnection, socket: selectedConnection?.socket || null, browser: selectedConnection?.browser || launch.browser || "", launch, onboarding, phase };
}

function extensionConnectionError(connection) {
  const launch = connection?.launch || {};
  const details = [];
  if (launch.reason === "browser_unknown") {
    details.push("Bridge has not identified a browser yet. Open Edge or Chrome with the Gecho extension once, then retry.");
  } else if (launch.reason === "disabled") {
    details.push("Automatic browser launch is disabled (GECHO_AUTO_LAUNCH_BROWSER=0).");
  } else if (launch.reason === "cooldown") {
    details.push(`${launch.browser} was started recently; it did not reconnect in time.`);
  } else if (launch.attempted && !launch.launched) {
    details.push(`Failed to start ${launch.browser || "the saved browser"}: ${launch.reason || "unknown error"}`);
  } else if (launch.attempted) {
    details.push(`${launch.browser} was started, but its extension did not connect in time.`);
  }

  if (connection?.phase === "waiting_user_install_or_enable") {
    details.push("The browser is open and Bridge waited for installation or enablement, but the extension did not reconnect.");
  }

  if (connection?.onboarding?.url) {
    details.push(`Install or enable the Gecho extension here: ${connection.onboarding.url}`);
  }

  return [
    "Extension not connected.",
    ...details,
    "Check that the Gecho extension is installed, enabled, and signed in for that browser profile."
  ].join(" ");
}

lastBrowserConnection = loadLastBrowserConnection();

function sanitizeJobForDisk(job = {}) {
  const copy = { ...job };
  // 结果大数组不落盘，避免文件膨胀与频繁 I/O
  delete copy.data;
  return copy;
}

function saveJobDetailToDisk(jobId, job) {
  try {
    if (!jobId || !job) return;
    ensureJobDetailsDirReady();
    const detailPath = getJobDetailPath(jobId);
    enqueueWrite(
      async () => {
        await writeFileAtomicAsync(detailPath, JSON.stringify(sanitizeJobForDisk(job)));
      },
      `persist_job_detail:${jobId}`
    );
  } catch (e) {
    console.error(`Failed to persist async job detail [${jobId}]:`, e.message);
  }
}

function deleteJobArtifacts(jobId) {
  const detailPath = getJobDetailPath(jobId);
  enqueueWrite(
    async () => {
      try {
        await fs.promises.unlink(detailPath);
      } catch (_e) {}
    },
    `delete_job_detail:${jobId}`
  );
}

function runJobCleanup() {
  try {
    const now = Date.now();
    const entries = Array.from(asyncJobs.entries());
    const isExpired = (job) => {
      const ts = Number(job?.lastUpdateAt || job?.completedAt || job?.createdAt || 0);
      return ts > 0 && now - ts > JOB_TTL_MS;
    };
    const isRunning = (job) => String(job?.status || "") === "running";

    // 1) TTL 清理（仅清理非 running）
    for (const [jobId, job] of entries) {
      if (!isRunning(job) && isExpired(job)) {
        asyncJobs.delete(jobId);
        deleteJobArtifacts(jobId);
      }
    }

    // 2) 数量上限清理（保留最新，优先保留 running）
    if (asyncJobs.size > MAX_PERSISTED_JOBS) {
      const sorted = Array.from(asyncJobs.entries())
        .sort((a, b) => {
          const at = Number(a[1]?.lastUpdateAt || a[1]?.createdAt || 0);
          const bt = Number(b[1]?.lastUpdateAt || b[1]?.createdAt || 0);
          return at - bt;
        });
      let needDrop = asyncJobs.size - MAX_PERSISTED_JOBS;
      for (const [jobId, job] of sorted) {
        if (needDrop <= 0) break;
        if (isRunning(job)) continue;
        asyncJobs.delete(jobId);
        deleteJobArtifacts(jobId);
        needDrop--;
      }
    }

    // 3) requestIndex 与 jobs 对齐清理
    for (const [requestId, ref] of Array.from(requestIndex.entries())) {
      if (!ref?.jobId || !asyncJobs.has(ref.jobId)) {
        requestIndex.delete(requestId);
      }
    }

    schedulePersistAsyncJobs();
    schedulePersistRequestIndex();
  } catch (e) {
    console.error("Job cleanup failed:", e.message);
  }
}

function loadJobDetailFromDisk(jobId) {
  try {
    if (!jobId) return null;
    const detailPath = getJobDetailPath(jobId);
    if (!fs.existsSync(detailPath)) return null;
    const raw = fs.readFileSync(detailPath, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error(`Failed to load async job detail [${jobId}] from disk:`, e.message);
    return null;
  }
}

function saveAsyncJobsToDiskNow() {
  try {
    ensureJobsDirReady();
    const payload = {
      savedAt: Date.now(),
      jobIds: Array.from(asyncJobs.keys())
    };
    enqueueWrite(
      async () => {
        await writeFileAtomicAsync(JOBS_STORE_PATH, JSON.stringify(payload));
      },
      "persist_job_ids"
    );
  } catch (e) {
    console.error("Failed to persist async jobs:", e.message);
  }
}

function saveRequestIndexToDiskNow() {
  try {
    ensureJobsDirReady();
    const payload = {
      savedAt: Date.now(),
      requests: Object.fromEntries(requestIndex)
    };
    enqueueWrite(
      async () => {
        await writeFileAtomicAsync(REQUEST_INDEX_PATH, JSON.stringify(payload));
      },
      "persist_request_index"
    );
  } catch (e) {
    console.error("Failed to persist request index:", e.message);
  }
}

function schedulePersistAsyncJobs() {
  if (persistJobsTimer) return;
  persistJobsTimer = setTimeout(() => {
    persistJobsTimer = null;
    saveAsyncJobsToDiskNow();
  }, 250);
}

function schedulePersistRequestIndex() {
  if (persistRequestIndexTimer) return;
  persistRequestIndexTimer = setTimeout(() => {
    persistRequestIndexTimer = null;
    saveRequestIndexToDiskNow();
  }, 250);
}

function loadAsyncJobsFromDisk() {
  let raw = "";
  try {
    if (!fs.existsSync(JOBS_STORE_PATH)) return;
    raw = fs.readFileSync(JOBS_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const jobIds = Array.isArray(parsed.jobIds) ? parsed.jobIds : [];
    for (const jobId of jobIds) {
      const detail = loadJobDetailFromDisk(jobId);
      if (detail && typeof detail === "object") {
        asyncJobs.set(jobId, detail);
      } else {
        asyncJobs.set(jobId, {
          status: "error",
          stage: "restored_from_jobid_only",
          jobId,
          restoredAt: Date.now(),
          error: "Job restored from disk by jobId only; detailed metadata not found."
        });
      }
    }

    // 向后兼容: 旧版本使用 jobs 对象落盘
    const legacyJobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
    for (const [jobId, job] of Object.entries(legacyJobs)) {
      if (!asyncJobs.has(jobId)) {
        asyncJobs.set(jobId, job);
      }
    }
    console.log(`♻️ Restored async jobs from disk: ${asyncJobs.size}`);
  } catch (e) {
    console.error("Failed to load async jobs from disk:", e.message);
    // 文件损坏时自动备份并重置，避免后续持续读坏文件
    try {
      if (raw && fs.existsSync(JOBS_STORE_PATH)) {
        ensureJobsDirReady();
        const backupPath = path.join(JOBS_DIR, `.async_jobs.corrupt-${Date.now()}.json`);
        fs.renameSync(JOBS_STORE_PATH, backupPath);
        console.error(`Corrupted async jobs file moved to: ${backupPath}`);
      }
    } catch (backupErr) {
      console.error("Failed to backup corrupted async jobs file:", backupErr.message);
    }
  }
}

function loadRequestIndexFromDisk() {
  try {
    if (!fs.existsSync(REQUEST_INDEX_PATH)) return;
    const raw = fs.readFileSync(REQUEST_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const requests = parsed.requests && typeof parsed.requests === "object" ? parsed.requests : {};
    for (const [requestId, ref] of Object.entries(requests)) {
      if (ref && typeof ref === "object" && ref.jobId) {
        requestIndex.set(requestId, ref);
      }
    }
    console.log(`♻️ Restored request index from disk: ${requestIndex.size}`);
  } catch (e) {
    console.error("Failed to load request index from disk:", e.message);
  }
}

function checkJobsStoreWritable() {
  try {
    ensureJobsDirReady();
    const probePath = path.join(JOBS_DIR, `.jobs_write_probe_${process.pid}`);
    fs.writeFileSync(probePath, "ok", "utf8");
    fs.unlinkSync(probePath);
  } catch (e) {
    console.error(`Jobs store is not writable: ${JOBS_DIR}`);
    console.error(`Reason: ${e.message}`);
  }
}

function getJobFromDisk(jobId) {
  try {
    if (!jobId || !fs.existsSync(JOBS_STORE_PATH)) return null;
    const detail = loadJobDetailFromDisk(jobId);
    if (detail && typeof detail === "object") {
      return detail;
    }
    const raw = fs.readFileSync(JOBS_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const jobIds = Array.isArray(parsed.jobIds) ? parsed.jobIds : [];
    if (jobIds.includes(jobId)) {
      return {
        status: "error",
        stage: "restored_from_jobid_only",
        jobId,
        restoredAt: Date.now(),
        error: "Job restored from disk by jobId only; detailed metadata not found."
      };
    }

    // 向后兼容: 旧版本 jobs 对象
    const jobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
    return jobs[jobId] || null;
  } catch (e) {
    console.error("Failed to read job from disk:", e.message);
    return null;
  }
}

function decodeBase64Utf8(value) {
  try {
    return Buffer.from(String(value || ""), "base64").toString("utf8");
  } catch (_e) {
    return "";
  }
}

function normalizeQuery(rawQuery, queryB64) {
  const queryText = String(rawQuery || "").trim();
  const decodedFromB64 = decodeBase64Utf8(queryB64).trim();
  if (decodedFromB64) {
    if (!queryText || /^[?？]+$/.test(queryText)) {
      return decodedFromB64;
    }
  }
  if (!queryText) {
    return "";
  }
  try {
    if (/%[0-9A-Fa-f]{2}/.test(queryText)) {
      return decodeURIComponent(queryText);
    }
  } catch (_e) {}
  return queryText;
}

function toSafeFileName(name) {
  const value = String(name || "").trim();
  const replaced = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  const fallback = `query_${Date.now()}`;
  const candidate = replaced || fallback;
  const upper = candidate.toUpperCase();
  const reserved = new Set([
    "CON","PRN","AUX","NUL",
    "COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9",
    "LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"
  ]);
  return reserved.has(upper) ? `${candidate}_` : candidate;
}

function updateJob(jobId, patch) {
  const prev = asyncJobs.get(jobId) || {};
  const next = { ...prev, ...patch, lastUpdateAt: Date.now() };
  asyncJobs.set(jobId, next);
  saveJobDetailToDisk(jobId, next);
  schedulePersistAsyncJobs();
  return next;
}

function appendJobEvent(jobId, message, extra = {}) {
  const prev = asyncJobs.get(jobId) || {};
  const events = Array.isArray(prev.events) ? prev.events.slice(-14) : [];
  events.push({ at: Date.now(), message, ...extra });
  const next = { ...prev, events, lastUpdateAt: Date.now() };
  asyncJobs.set(jobId, next);
  saveJobDetailToDisk(jobId, next);
  schedulePersistAsyncJobs();
}

function parseJobIdAndAttemptFromRequestId(requestId) {
  const value = String(requestId || "");
  const idx = value.lastIndexOf(":a");
  if (idx <= 0) return { jobId: "", attempt: 0 };
  const jobId = value.slice(0, idx);
  const attempt = Number(value.slice(idx + 2)) || 0;
  return { jobId, attempt };
}

function getTargetSavePathFromJob(job) {
  if (!job || typeof job !== "object") return "";
  if (job.anticipatedSavePath) return String(job.anticipatedSavePath);
  const action = String(job.action || "result");
  const query = String(job.query || action);
  const safeName = toSafeFileName(query);
  const prefix = query ? `${toSafeFileName(action)}_` : "";
  return path.join(JOBS_DIR, `${prefix}${safeName}_results.json`);
}

function finalizeAsyncJobResult(jobId, result, attempt = 0) {
  let job = asyncJobs.get(jobId);
  if (!job) {
    job = getJobFromDisk(jobId);
    if (job) asyncJobs.set(jobId, job);
  }
  if (!job) return;

  appendJobEvent(jobId, "attempt_result_received", { attempt });

  const completeWith = (savePath = "", saveWarning = "") => {
    if (Array.isArray(result)) {
      updateJob(jobId, {
        status: "completed",
        stage: "completed",
        data: result,
        savePath,
        saveWarning,
        completedAt: Date.now()
      });
      appendJobEvent(jobId, "job_completed", { count: result.length, savePath: savePath || "" });
    } else if (result && typeof result === "object" && result.error) {
      updateJob(jobId, {
        status: "error",
        stage: "business_error",
        error: result.error
      });
      appendJobEvent(jobId, "job_error", { error: String(result.error) });
    } else {
      updateJob(jobId, {
        status: "error",
        stage: "invalid_result",
        error: "Plugin returned non-array result for async insight"
      });
      appendJobEvent(jobId, "job_error", { error: "non_array_result" });
    }
  };

  if (Array.isArray(result) && result.length > 0) {
    const fixedPath = getTargetSavePathFromJob(job);
    enqueueWrite(
      async () => {
        try {
          await fs.promises.mkdir(path.dirname(fixedPath), { recursive: true });
          await fs.promises.writeFile(fixedPath, JSON.stringify(result, null, 2), "utf8");
          completeWith(fixedPath, "");
        } catch (e) {
          completeWith("", e.message || "failed_to_write_result_file");
        }
      },
      `write_result_file:${jobId}`
    );
    return;
  }

  completeWith("", "");
}

function resolveJobRefByRequestId(requestId) {
  if (!requestId) return { jobId: "", attempt: 0 };
  const persistedRef = requestIndex.get(requestId);
  if (persistedRef?.jobId) {
    return {
      jobId: String(persistedRef.jobId),
      attempt: Number(persistedRef.attempt || 0)
    };
  }
  return parseJobIdAndAttemptFromRequestId(requestId);
}

function getServiceSourceMtimeMs() {
  try {
    return Math.floor(fs.statSync(__filename).mtimeMs);
  } catch (_e) {
    return 0;
  }
}

function resolveMissingActionResultRequestId(parsed) {
  const embeddedRequestId = String(
    parsed?.data?.requestId ||
    parsed?.data?.jobId ||
    parsed?.data?.activeRequestId ||
    ""
  );
  if (embeddedRequestId && (pendingRequests.has(embeddedRequestId) || resolveJobRefByRequestId(embeddedRequestId).jobId)) {
    return embeddedRequestId;
  }

  if (lastDispatchedRequestId && pendingRequests.has(lastDispatchedRequestId)) {
    return lastDispatchedRequestId;
  }

  const pendingEntries = Array.from(pendingRequests.entries());
  if (pendingEntries.length === 1) {
    return pendingEntries[0][0];
  }

  const asyncEntries = pendingEntries.filter(([, pending]) => pending?.jobId);
  if (asyncEntries.length === 1) {
    return asyncEntries[0][0];
  }

  const insightEntries = pendingEntries.filter(([, pending]) => pending?.action === "tiktok_insight");
  if (insightEntries.length === 1) {
    return insightEntries[0][0];
  }

  const newestPending = pendingEntries
    .filter(([, pending]) => Number(pending?.startedAt || 0) > 0)
    .sort((a, b) => Number(b[1]?.startedAt || 0) - Number(a[1]?.startedAt || 0))[0];
  if (newestPending) {
    return newestPending[0];
  }

  if (lastDispatchedRequestId) {
    const lastRef = resolveJobRefByRequestId(lastDispatchedRequestId);
    if (lastRef.jobId) {
      return lastDispatchedRequestId;
    }
  }

  return "";
}

function resolveActionResultByRequestId(requestId, data, sourceLabel) {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pending.resolve(data);
    pendingRequests.delete(requestId);
    return true;
  }

  const parsedRef = resolveJobRefByRequestId(requestId);
  if (parsedRef.jobId) {
    console.warn(`WARN action_result ${sourceLabel} recovered by request ref: requestId=${requestId}, jobId=${parsedRef.jobId}`);
    finalizeAsyncJobResult(parsedRef.jobId, data, parsedRef.attempt);
    return true;
  }

  return false;
}

function hydrateJobWithDataFromFile(job) {
  if (!job || typeof job !== "object") return job;
  if (Array.isArray(job.data)) return job;
  if (job.status !== "completed" || !job.savePath) return job;
  try {
    if (!fs.existsSync(job.savePath)) return job;
    const raw = fs.readFileSync(job.savePath, "utf8");
    const data = JSON.parse(raw || "[]");
    if (!Array.isArray(data)) return job;
    return { ...job, data };
  } catch (_e) {
    return job;
  }
}

async function runAsyncAttempt({ jobId, action, params, payload, attempt }) {
  const connection = await ensureExtensionConnection(action);
  if (!connection.connected) {
    updateJob(jobId, {
      status: "error",
      stage: "extension_disconnected",
      error: extensionConnectionError(connection)
    });
    return;
  }
  const bridgeBrowserSessionId = retainBridgeOwnedBrowser(connection.launch?.bridgeBrowserSessionId, connection.browser);

  const requestId = `${jobId}:a${attempt}`;
  lastDispatchedRequestId = requestId;
  traceBridgeEvent("action_dispatched", { action, requestId, async: true });
  requestIndex.set(requestId, { jobId, attempt, updatedAt: Date.now() });
  schedulePersistRequestIndex();
  appendJobEvent(jobId, "attempt_started", { attempt, requestId });
  updateJob(jobId, {
    status: "running",
    stage: "awaiting_extension_result",
    attempt,
    activeRequestId: requestId
  });

  const timeoutId = setTimeout(() => {
    pendingRequests.delete(requestId);
    // Keep requestIndex for a while so a late extension result can still be
    // associated with its async job after the attempt timeout fires.
    schedulePersistRequestIndex();
    const job = asyncJobs.get(jobId);
    if (!job || job.status !== "running") return;
    const timedOutAttempt = Number(job.attempt || attempt);
    appendJobEvent(jobId, "attempt_timeout", { attempt: timedOutAttempt });

    updateJob(jobId, {
      status: "error",
      stage: "timed_out",
      error: `Scraping timeout (${Math.floor(ASYNC_ATTEMPT_TIMEOUT_MS / 1000)}s) for action: ${action}`,
      retryCount: 0
    });
    releaseBridgeOwnedBrowser(bridgeBrowserSessionId, "async_action_timed_out");
  }, ASYNC_ATTEMPT_TIMEOUT_MS);

  pendingRequests.set(requestId, {
    timeoutId,
    jobId,
    action,
    startedAt: Date.now(),
    resolve: (result) => {
      clearTimeout(timeoutId);
      requestIndex.delete(requestId);
      schedulePersistRequestIndex();
      finalizeAsyncJobResult(jobId, result, attempt);
      releaseBridgeOwnedBrowser(bridgeBrowserSessionId, "async_action_finished");
    }
  });

  connection.socket.send(JSON.stringify({
    method: "execute_action",
    params: { action: action, params: params },
    requestId
  }));
}

function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Service shutting down: ${reason}`);

  for (const [_requestId, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ error: "Service is shutting down" });
  }
  pendingRequests.clear();
  saveAsyncJobsToDiskNow();
  saveRequestIndexToDiskNow();
  if (persistJobsTimer) {
    clearTimeout(persistJobsTimer);
    persistJobsTimer = null;
  }
  if (persistRequestIndexTimer) {
    clearTimeout(persistRequestIndexTimer);
    persistRequestIndexTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  try {
    if (extensionSocket && extensionSocket.readyState === 1) {
      extensionSocket.close(1001, "service_shutdown");
    }
  } catch (_e) {}

  try {
    wss.close(() => {
      server.close(() => process.exit(0));
    });
  } catch (_e) {
    try {
      server.close(() => process.exit(0));
    } catch (__e) {
      process.exit(0);
    }
  }
}

// --- WebSocket Server (与插件通信) ---
wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

wss.on("connection", (ws, request) => {
  const browser = detectBrowserFromUserAgent(request?.headers?.["user-agent"]);
  const connectionId = `connection-${Date.now()}-${extensionConnectionCounter++}`;
  const connection = { id: connectionId, socket: ws, browser, connectedAt: Date.now(), installationId: "" };
  extensionConnections.set(connectionId, connection);
  if (browser) persistLastBrowserConnection(browser);
  console.log(`✅ Browser extension connected to Service Layer${browser ? ` (${browser})` : ""}`);
  extensionSocket = ws;
  lastExtensionConnectedAt = Date.now();
  traceBridgeEvent("extension_connected", { browser, connectionId, clientCount: wss.clients.size });

  ws.on("message", (message) => {
    try {
      const parsed = JSON.parse(message);
      const handshakeMethods = new Set(["gecho_extension_handshake", "extension_handshake", "handshake"]);
      if (handshakeMethods.has(parsed.method)) {
        const identity = parsed.params && typeof parsed.params === "object" ? parsed.params : parsed;
        const extensionId = String(identity.extensionId || "").trim();
        if (extensionId && extensionId !== GECHO_EXTENSION_ID) {
          traceBridgeEvent("extension_handshake_rejected", { browser, extensionId });
          ws.close(1008, "unexpected_extension_id");
          return;
        }
        const handshakeBrowser = normalizeBrowserName(identity.browser) || browser;
        if (handshakeBrowser) {
          persistLastBrowserConnection(handshakeBrowser, {
            profileId: identity.profileId || identity.profileDirectory,
            profileDisplayName: identity.profileDisplayName,
            installationId: identity.installationId || identity.profileInstallationId,
            extensionVersion: identity.extensionVersion || identity.version
          });
        }
        ws.extensionIdentity = {
          extensionId: extensionId || GECHO_EXTENSION_ID,
          extensionVersion: String(identity.extensionVersion || identity.version || "").slice(0, 80),
          profileId: normalizeProfileId(identity.profileId || identity.profileDirectory),
          installationId: String(identity.installationId || identity.profileInstallationId || "").slice(0, 160)
        };
        connection.browser = handshakeBrowser;
        connection.installationId = ws.extensionIdentity.installationId;
        traceBridgeEvent("extension_handshake", { browser: handshakeBrowser, profileId: ws.extensionIdentity.profileId });
        return;
      }
      if (parsed.method === "action_progress" && parsed.requestId) {
        traceBridgeEvent("extension_progress", { requestId: parsed.requestId });
        const pending = pendingRequests.get(parsed.requestId);
        if (!pending) {
          console.warn(`WARN action_progress requestId not found: ${parsed.requestId}`);
        }
        let jobIdForProgress = pending?.jobId || "";
        if (!jobIdForProgress) {
          const parsedRef = resolveJobRefByRequestId(parsed.requestId);
          jobIdForProgress = parsedRef.jobId;
        }
        if (jobIdForProgress) {
          updateJob(jobIdForProgress, {
            stage: "extension_processing",
            lastProgressAt: Date.now(),
            progress: parsed.progress
          });
          appendJobEvent(jobIdForProgress, "progress", { progress: parsed.progress ?? null });
        }
      }
      if (parsed.method === "action_result" && parsed.requestId) {
        traceBridgeEvent("extension_result", { requestId: parsed.requestId });
        console.log(`📩 Received result from extension (ID: ${parsed.requestId})`);
        const pending = pendingRequests.get(parsed.requestId);
        if (pending) {
          resolveActionResultByRequestId(parsed.requestId, parsed.data, "with explicit requestId");
        } else {
          const recovered = resolveActionResultByRequestId(parsed.requestId, parsed.data, "missed pending");
          if (recovered) return;
          const keys = Array.from(pendingRequests.keys());
          console.warn(`WARN action_result requestId not found in pendingRequests: ${parsed.requestId}`);
          console.warn(`WARN pendingRequests.size=${pendingRequests.size}, sampleKeys=${JSON.stringify(keys.slice(0, 10))}`);
        }
      }
      if (parsed.method === "action_result" && !parsed.requestId) {
        const recoveredRequestId = resolveMissingActionResultRequestId(parsed);
        if (recoveredRequestId) {
          console.warn(`WARN action_result missing requestId; recovered as: ${recoveredRequestId}`);
          const recovered = resolveActionResultByRequestId(recoveredRequestId, parsed.data, "missing requestId");
          if (!recovered) {
            console.warn(`WARN action_result missing requestId recovery target was stale: ${recoveredRequestId}`);
          }
        } else {
          const keys = Array.from(pendingRequests.keys());
          console.warn(
            `WARN action_result missing requestId and cannot recover (pendingRequests.size=${keys.length})`
          );
        }
      }
    } catch (e) {
      console.error("Error parsing extension message:", e);
    }
  });

  ws.on("close", () => {
    console.log("❌ Browser extension disconnected");
    extensionConnections.delete(connectionId);
    traceBridgeEvent("extension_disconnected", { browser: connection.browser, connectionId, clientCount: wss.clients.size });
    if (extensionSocket === ws) extensionSocket = null;
  });

  ws.on("error", (error) => {
    traceBridgeEvent("extension_socket_error", { message: error.message });
    console.warn(`Browser extension WebSocket error: ${error.message}`);
  });
});

loadAsyncJobsFromDisk();
loadRequestIndexFromDisk();
checkJobsStoreWritable();
runJobCleanup();
cleanupTimer = setInterval(runJobCleanup, CLEANUP_INTERVAL_MS);

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ WS Port ${WS_PORT} is in use!`);
    process.exit(1);
  } else {
    console.error("WS Error:", err);
  }
});

// --- HTTP Server (供 Client 层调用) ---
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "GET" && req.url === ONBOARDING_PATH) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(renderOnboardingPage());
  }

  if (req.method === "GET" && req.url === "/onboarding/status") {
    const preferredBrowser = normalizeBrowserName(onboardingRuntime.browser) || getBrowserToLaunch();
    const connected = !!getOpenExtensionConnection(preferredBrowser);
    const stage = connected ? "ready" : onboardingRuntime.stage;
    const messages = {
      idle: "正在检测浏览器扩展…",
      browser_starting: "正在启动浏览器…",
      waiting_user_install_or_enable: "请在扩展商店确认安装 Gecho 扩展。",
      ready: "扩展已连接，正在继续你的任务。",
      extension_not_connected: "扩展暂未连接；请确认已安装、启用并登录。"
    };
    return res.end(JSON.stringify({
      stage,
      browser: preferredBrowser || null,
      extensionConnected: connected,
      action: onboardingRuntime.action || null,
      storeUrl: getExtensionStoreUrl(preferredBrowser),
      websiteUrl: GECHO_WEBSITE_URL || null,
      tutorialUrl: GECHO_TUTORIAL_URL || null,
      onboardingAutoOpenedAt: onboardingRuntime.onboardingAutoOpenedAt || null,
      message: messages[stage] || "正在准备浏览器环境…",
      updatedAt: onboardingRuntime.updatedAt
    }));
  }

  if (req.method === "POST" && req.url === "/onboarding/open-store") {
    const browser = normalizeBrowserName(onboardingRuntime.browser) || getBrowserToLaunch();
    const url = getExtensionStoreUrl(browser);
    // 用户主动点击时不受自动打开冷却限制，确保按钮每次都有明确反馈。
    let result;
    try {
      const child = openExternalUrl(url, browser);
      child.unref();
      lastStoreOpenAt = Date.now();
      const state = loadOnboardingState();
      persistOnboardingState({ storeOpenedAt: lastStoreOpenAt, storeUrl: url, browser, storeOpenCount: Number(state.storeOpenCount || 0) + 1 });
      traceBridgeEvent("extension_store_opened_by_user", { browser, url });
      result = { opened: true, url };
    } catch (e) {
      result = { opened: false, reason: e.message, url };
    }
    return res.end(JSON.stringify({ success: !!result.url, ...result }));
  }

  if (req.method === "POST" && req.url === "/onboarding/recheck") {
    const browser = normalizeBrowserName(onboardingRuntime.browser) || getBrowserToLaunch();
    const connection = getOpenExtensionConnection(browser);
    if (connection) updateOnboardingRuntime({ stage: "ready", browser: connection.browser });
    return res.end(JSON.stringify({ extensionConnected: !!connection, browser, stage: connection ? "ready" : onboardingRuntime.stage }));
  }

  // 健康检查接口
  if (req.method === "GET" && req.url === "/ping") {
    return res.end(JSON.stringify({
      status: "ok",
      serviceProtocolVersion: SERVICE_PROTOCOL_VERSION,
      packageVersion: packageJson.version,
      pid: process.pid,
      cwd: process.cwd(),
      servicePath: __filename,
      startedAt: SERVICE_STARTED_AT,
      sourceMtimeMs: getServiceSourceMtimeMs(),
      dataDir: JOBS_DIR,
      extensionConnected: isExtensionConnected(),
      lastConnectedBrowser: lastBrowserConnection?.browser || null,
      lastConnectedProfile: lastBrowserConnection?.profileId || null,
      extensionOnboarding: loadOnboardingState(),
      onboardingAutoOpen: {
        enabled: AUTO_OPEN_ONBOARDING_ON_FIRST_START,
        openedAt: loadOnboardingState().onboardingAutoOpenedAt || null
      },
      autoBrowserLaunch: {
        enabled: AUTO_LAUNCH_BROWSER,
        browser: getBrowserToLaunch() || null
      },
      bridgeTrace: bridgeTrace.slice(-30)
    }));
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    res.end(JSON.stringify({ status: "ok", message: "shutdown accepted" }));
    setTimeout(() => gracefulShutdown("remote_shutdown"), 20).unref?.();
    return;
  }

  // --- 新增异步任务查询接口 ---
  if (req.method === "GET" && req.url.startsWith("/async-status")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const jobId = url.searchParams.get("jobId");
      if (!jobId) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Job not found" }));
      }

      let job = asyncJobs.get(jobId);
      if (!job) {
        const diskJob = getJobFromDisk(jobId);
        if (diskJob) {
          console.log(`♻️ /async-status fallback hit disk for jobId=${jobId}`);
          asyncJobs.set(jobId, diskJob);
          job = diskJob;
        }
      }

      if (!job) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Job not found" }));
      }

      const hydratedJob = hydrateJobWithDataFromFile(job);
      return res.end(JSON.stringify(hydratedJob));
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- 新增异步任务启动接口 ---
  if (req.method === "POST" && req.url === "/async-action") {
    if (shuttingDown) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: "Service is shutting down" }));
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const action = payload.action;
        
        if (!action) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "Missing action" }));
        }

        const connection = await ensureExtensionConnection(action);
        if (!connection.connected) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ error: extensionConnectionError(connection) }));
        }

        const jobId = `job-${Date.now()}-${requestIdCounter++}`;
        console.log(`🚀 Dispatching ASYNC action: [${action}], jobId: ${jobId}`);
        const { action: _a, ...params } = payload;

        // 预先计算保存路径，以便立刻返回给客户端
        let dataDir = payload.save_dir || process["env"].GECHO_DATA_DIR || path.join(__dirname, "data");
        let anticipatedSavePath = "";
        const fileNameSeed = params.uniqueId || params.query || params.product_url || params.url || action;
        const safeName = toSafeFileName(fileNameSeed);
        const prefix = (params.uniqueId || params.query || params.product_url || params.url)
          ? `${toSafeFileName(action)}_`
          : "";
        if (dataDir.toLowerCase().endsWith(".json") || dataDir.toLowerCase().endsWith(".csv")) {
          anticipatedSavePath = dataDir;
        } else {
          anticipatedSavePath = path.join(dataDir, `${prefix}${safeName}_results.json`);
        }

        asyncJobs.set(jobId, {
          status: "running",
          stage: "queued",
          action,
          query: params.query || "",
          startTime: Date.now(),
          createdAt: Date.now(),
          retryCount: 0,
          attempt: 0,
          lastUpdateAt: Date.now(),
          anticipatedSavePath,
          events: []
        });
        schedulePersistAsyncJobs();
        appendJobEvent(jobId, "job_created", { action });

        runAsyncAttempt({ jobId, action, params, payload, attempt: 1 });

        return res.end(JSON.stringify({ success: true, jobId, savePath: anticipatedSavePath }));
      } catch (e) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && (req.url === "/search" || req.url === "/action")) {
    if (shuttingDown) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: "Service is shutting down" }));
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      let bridgeBrowserSessionId = "";
      try {
        const payload = JSON.parse(body);
        const action = payload.action;
        
        if (!action) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "Missing action" }));
        }

        const connection = await ensureExtensionConnection(action);
        if (!connection.connected) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ error: extensionConnectionError(connection) }));
        }
        bridgeBrowserSessionId = retainBridgeOwnedBrowser(connection.launch?.bridgeBrowserSessionId, connection.browser);

        console.log(`🚀 Dispatching action: [${action}]`);
        const requestId = `svc-${Date.now()}-${requestIdCounter++}`;
        lastDispatchedRequestId = requestId;
        traceBridgeEvent("action_dispatched", { action, requestId, async: false });
        // 通用透传逻辑：将 payload 中的所有参数（除去 action）作为 params 传给插件
        const { action: _a, ...params } = payload;
        const result = await new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({ error: `Scraping timeout (600s) for action: ${action}` });
            releaseBridgeOwnedBrowser(bridgeBrowserSessionId, "sync_action_timed_out");
          }, 600000);

          pendingRequests.set(requestId, {
            resolve,
            timeoutId,
            action,
            startedAt: Date.now()
          });


          
          connection.socket.send(JSON.stringify({
            method: "execute_action",
            params: { 
              action: action, 
              params: params 
            },
            requestId: requestId
          }));
        });

        // 持久化存储
        let savePath = "";
        let saveWarning = "";
        if (Array.isArray(result) && result.length > 0) {
          let dataDir = payload.save_dir || process["env"].GECHO_DATA_DIR || path.join(__dirname, "data");
          let fixedPath;
          if (dataDir.toLowerCase().endsWith(".json") || dataDir.toLowerCase().endsWith(".csv")) {
            // 如果传入的 save_dir 误填成了文件路径，则将其作为最终文件路径，并提取所在目录
            fixedPath = dataDir;
            dataDir = path.dirname(fixedPath);
          } else {
            const fileNameSeed = params.uniqueId || params.query || params.product_url || params.url || action;
            const safeName = toSafeFileName(fileNameSeed);
            const prefix = (params.uniqueId || params.query || params.product_url || params.url)
              ? `${toSafeFileName(action)}_`
              : "";
            fixedPath = path.join(dataDir, `${prefix}${safeName}_results.json`);
          }
  
          if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
          
          try {
            fs.writeFileSync(fixedPath, JSON.stringify(result, null, 2), "utf8");
            savePath = fixedPath;
          } catch (e) {
            saveWarning = e.message;
          }
        }
        res.end(JSON.stringify({ success: true, data: result, savePath, saveWarning }));
        releaseBridgeOwnedBrowser(bridgeBrowserSessionId, "sync_action_finished");
      } catch (e) {
        releaseBridgeOwnedBrowser(bridgeBrowserSessionId, "sync_action_failed");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`🚀 TikTok Bridge Service Layer is running:`);
  console.log(`   - WebSocket (Extension): ws://127.0.0.1:${WS_PORT}`);
  console.log(`   - HTTP API (Client): http://127.0.0.1:${HTTP_PORT}`);

  // 等 HTTP 服务真正监听后再打开 onboarding，确保浏览器打开页面时不会遇到
  // 连接拒绝；状态写入成功后，后续 Agent 重复拉起 Bridge 不会再次打开。
  const startupOnboardingTimer = setTimeout(() => {
    try {
      const result = maybeOpenOnboardingOnFirstStart();
      if (result.opened) {
        console.log(`🧭 First-start onboarding opened in ${result.browser || "the selected browser"}`);
      } else if (result.reason !== "already_opened") {
        console.log(`ℹ️ First-start onboarding not opened: ${result.reason}`);
      }
    } catch (e) {
      console.warn(`Failed to open first-start onboarding: ${e.message}`);
    }
  }, 250);
  startupOnboardingTimer.unref?.();
});

process.on("SIGTERM", () => gracefulShutdown("sigterm"));
process.on("SIGINT", () => gracefulShutdown("sigint"));
