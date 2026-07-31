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

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

function renderOnboardingPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gecho 浏览器准备</title><style>
:root{--ink:#16171c;--muted:#777b88;--line:#e6e7eb;--panel:#fafafa;--cyan:#21d9ee;--violet:#7557f7}*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.wrap{max-width:900px;margin:0 auto;padding:72px 28px 56px}.brand{display:flex;justify-content:center;margin-bottom:30px}.mark{position:relative;width:60px;height:60px;transform:rotate(-8deg)}.mark i{position:absolute;display:block;width:32px;height:22px;border-radius:7px 16px 7px 16px;background:linear-gradient(135deg,#42e5fa,#1688ee);box-shadow:0 4px 12px #33d9f866}.mark i:first-child{left:3px;top:10px;transform:rotate(-21deg)}.mark i:last-child{right:2px;bottom:5px;transform:rotate(78deg);background:linear-gradient(135deg,#9b57f6,#2c51e9)}h1{text-align:center;font-size:38px;line-height:1.2;margin:0 0 14px;letter-spacing:-1px}.lead{text-align:center;color:var(--muted);font-size:19px;line-height:1.65;margin:0 auto;max-width:620px}.status{display:flex;align-items:center;gap:11px;margin:42px auto 22px;max-width:680px;padding:18px 20px;border:1px solid var(--line);border-radius:16px;background:#fff}.dot{width:11px;height:11px;background:#1d1e24;border-radius:50%;flex:0 0 auto}.status-copy{font-size:16px;font-weight:650}.meta{margin-left:auto;color:var(--muted);font-size:13px}.steps{display:grid;gap:12px;margin:20px auto 40px;max-width:680px}.step{display:flex;align-items:flex-start;gap:14px;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.num{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#1d1e24;color:#fff;font-size:13px;font-weight:700;flex:0 0 auto}.step strong{display:block;font-size:15px;margin-bottom:3px}.step span{display:block;color:var(--muted);font-size:14px;line-height:1.5}.actions{display:flex;gap:12px;justify-content:center;margin:26px 0 48px}.button{border:0;border-radius:10px;background:#1b1c22;color:#fff;padding:12px 18px;font-size:15px;font-weight:650;cursor:pointer}.button.secondary{background:#fff;color:#25262d;border:1px solid var(--line)}.notice{border:1px solid #dedfe4;border-radius:22px;padding:26px 28px;background:#fcfcfd}.notice h2{font-size:18px;margin:0 0 16px}.notice ul{margin:0;padding-left:23px;color:var(--muted);line-height:2;font-size:15px}.notice b{color:#25262d}@media(max-width:600px){.wrap{padding:48px 18px}h1{font-size:31px}.meta{display:none}.actions{flex-direction:column}.button{width:100%}}</style></head>
<body><main class="wrap"><div class="brand"><div class="mark"><i></i><i></i></div></div><h1 id="title">正在准备 Gecho 浏览器环境</h1><p class="lead" id="lead">请不要离开此页面，完成扩展安装后任务会自动继续。</p><section class="status"><i class="dot" id="dot"></i><div class="status-copy" id="status">正在检测浏览器扩展…</div><div class="meta" id="browser"></div></section><section class="steps"><div class="step"><div class="num">1</div><div><strong>在扩展商店确认安装 Gecho</strong><span>点击下方按钮打开官方商店，并确认“添加至 Chrome”权限。</span></div></div><div class="step"><div class="num">2</div><div><strong>保持浏览器打开</strong><span>Bridge 会自动检测扩展连接，无需返回 Trae 或再次执行任务。</span></div></div><div class="step"><div class="num">3</div><div><strong>自动继续当前任务</strong><span>扩展连接成功后，Bridge 会打开任务页面并继续原来的操作。</span></div></div></section><div class="actions"><button class="button" id="store">安装 Gecho 扩展</button><button class="button secondary" id="recheck">重新检测</button></div><div class="actions" id="resources" style="margin-top:-26px"><button class="button secondary" id="website" hidden>访问官网</button><button class="button secondary" id="tutorial" hidden>查看教程</button></div><p class="lead" id="feedback" aria-live="polite"></p><section class="notice"><h2>● 提升连接成功率的注意事项</h2><ul><li>请使用安装 Gecho 扩展的同一个浏览器和 Profile。</li><li>请确认 Gecho 扩展已登录，并保持浏览器窗口打开。</li><li>如平台要求登录、验证或 CAPTCHA，请先在浏览器中手动完成。</li></ul></section></main><script>const $=id=>document.getElementById(id);let state={};function setLink(id,url){const el=$(id);el.hidden=!url;if(url)el.onclick=()=>window.open(url,'_blank')}async function refresh(message=''){try{const r=await fetch('/onboarding/status');state=await r.json();$('status').textContent=state.message||'正在检测浏览器扩展…';$('browser').textContent=state.browser?('浏览器：'+state.browser.toUpperCase()):'';const ready=state.stage==='ready';$('dot').style.background=ready?'#28b76b':'#1d1e24';$('title').textContent=ready?'扩展已连接，正在继续任务':'请完成 Gecho 扩展安装';$('lead').textContent=ready?'浏览器环境已准备完成，请稍候。':'完成扩展安装后，Bridge 会自动打开任务页面并继续。';$('store').disabled=ready;$('store').textContent=ready?'已连接':'安装 Gecho 扩展';setLink('website',state.websiteUrl);setLink('tutorial',state.tutorialUrl);if(message)$('feedback').textContent=message}catch(_){$('feedback').textContent='暂时无法连接 Bridge，请保持此页面打开后重试。'}}$('store').onclick=()=>{if(state.storeUrl){window.open(state.storeUrl,'_blank');$('feedback').textContent='已打开扩展商店，请确认安装。'}};$('recheck').onclick=async()=>{const r=await fetch('/onboarding/recheck',{method:'POST'});const s=await r.json();refresh(s.extensionConnected?'检测成功：扩展已连接。':'暂未检测到扩展，请完成安装或确认扩展已启用。')};refresh();setInterval(refresh,1500);</script></body></html>`;
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
    // 只有本次确实由 Bridge 拉起 onboarding 时，才在扩展就绪后打开任务页。
    // 已连接的日常调用不改动用户当前的浏览器标签页。
    if (launch.launched && launch.targetUrls?.includes(getOnboardingUrl()) && /^https?:/.test(taskTargetUrl)) {
      try {
        const child = openExternalUrl(taskTargetUrl, browser);
        child.unref();
        traceBridgeEvent("task_page_opened_after_onboarding", { action, browser, url: taskTargetUrl });
      } catch (e) {
        traceBridgeEvent("task_page_open_failed_after_onboarding", { action, browser, message: e.message });
      }
    }
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
      storeUrl: getExtensionStoreUrl(preferredBrowser),
      websiteUrl: GECHO_WEBSITE_URL || null,
      tutorialUrl: GECHO_TUTORIAL_URL || null,
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
});

process.on("SIGTERM", () => gracefulShutdown("sigterm"));
process.on("SIGINT", () => gracefulShutdown("sigint"));
