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
const crypto = require("crypto");
const { spawn } = require("child_process");
const packageJson = require("./package.json");

const WS_PORT = Number(process["env"].GECHO_WS_PORT || 18792);
const HTTP_PORT = Number(process["env"].GECHO_HTTP_PORT || 18793);
const SERVICE_PROTOCOL_VERSION = 2;
const SERVICE_STARTED_AT = Date.now();
const DEFAULT_DATA_DIR = path.join(__dirname, "data");
const JOBS_DIR = process["env"].GECHO_DATA_DIR || DEFAULT_DATA_DIR;
const JOBS_STORE_PATH = path.join(JOBS_DIR, ".async_jobs.json");
const JOB_DETAILS_DIR = path.join(JOBS_DIR, "jobs");
const REQUEST_INDEX_PATH = path.join(JOBS_DIR, ".async_request_index.json");
const BROWSER_CONNECTION_PATH = path.join(JOBS_DIR, ".browser_connection.json");
const SCHEDULED_JOBS_STORE_PATH = path.join(JOBS_DIR, ".scheduled_jobs.json");
const WAKE_SCHEDULER_STATE_PATH = path.join(JOBS_DIR, ".wake_scheduler_state.json");
const WAKE_SCHEDULER_SETTINGS_PATH = path.join(JOBS_DIR, ".wake_scheduler_settings.json");
const JOB_TTL_MS = Number(process["env"].GECHO_JOB_TTL_MS || 3 * 24 * 60 * 60 * 1000); // 默认 3 天
const MAX_PERSISTED_JOBS = Number(process["env"].GECHO_MAX_PERSISTED_JOBS || 2000);
const CLEANUP_INTERVAL_MS = Number(process["env"].GECHO_CLEANUP_INTERVAL_MS || 10 * 60 * 1000);
const EXTENSION_CONNECT_TIMEOUT_MS = Math.max(1000, Number(process["env"].GECHO_EXTENSION_CONNECT_TIMEOUT_MS || 30000));
const EXTENSION_CONNECT_POLL_MS = 500;
const EXTENSION_READY_GRACE_MS = Math.max(0, Number(process["env"].GECHO_EXTENSION_READY_GRACE_MS || 1500));
const AUTO_LAUNCH_BROWSER = process["env"].GECHO_AUTO_LAUNCH_BROWSER !== "0";
const AUTO_LAUNCH_BROWSER_DRY_RUN = process["env"].GECHO_AUTO_LAUNCH_BROWSER_DRY_RUN === "1";
const AUTO_LAUNCH_BROWSER_COOLDOWN_MS = Math.max(0, Number(process["env"].GECHO_AUTO_LAUNCH_BROWSER_COOLDOWN_MS || 10000));
const MAX_SCHEDULED_RUNS_PER_JOB = Math.max(10, Number(process["env"].GECHO_MAX_SCHEDULED_RUNS_PER_JOB || 100));
const SCHEDULE_MISFIRE_GRACE_MS = Math.max(0, Number(process["env"].GECHO_SCHEDULE_MISFIRE_GRACE_MS || 30000));
// GECHO_WAKE_SCHEDULER_* remains available for internal development and CI.
// User-facing enablement is persisted below and always runs via the restricted
// root-owned helper installed by `gecho-bridge wake enable`.
const WAKE_SCHEDULER_ENV_ENABLED = process["env"].GECHO_WAKE_SCHEDULER_ENABLED === "1";
const WAKE_SCHEDULER_DRY_RUN = process["env"].GECHO_WAKE_SCHEDULER_DRY_RUN === "1";
const WAKE_SCHEDULER_LEAD_MS = Math.max(10000, Number(process["env"].GECHO_WAKE_SCHEDULER_LEAD_MS || 10000));
const WAKE_HELPER_OWNER = "com.gecho-ai.gecho-bridge";
const WAKE_SCHEDULER_OWNER = String(process["env"].GECHO_WAKE_SCHEDULER_OWNER || WAKE_HELPER_OWNER);
const WAKE_SCHEDULER_USE_SUDO = process["env"].GECHO_WAKE_SCHEDULER_USE_SUDO === "1";
const PMSET_PATH = process["env"].GECHO_PMSET_PATH || "/usr/bin/pmset";
const WAKE_HELPER_PATH = "/usr/local/libexec/gecho-bridge-wake";
const WINDOWS_WAKE_HELPER_PATH = path.join(__dirname, "windows-wake-helper.ps1");
const WINDOWS_NATIVE_WAKE_TIMER_PATH = path.join(__dirname, "windows-native-wake-timer.ps1");
const WINDOWS_NATIVE_WAKE_TIMER_ENABLED = process["env"].GECHO_WINDOWS_NATIVE_WAKE_TIMER === "1";
const WINDOWS_WAKE_GUARD_SECONDS = Math.min(3600, Math.max(30, Number(process["env"].GECHO_WINDOWS_WAKE_GUARD_SECONDS || 450)));

let extensionSocket = null;
let wss = null;
let lastExtensionConnectedAt = 0;
let lastBrowserConnection = null;
let browserLaunchPromise = null;
let lastBrowserLaunchAt = 0;
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

// --- 异步任务管理 ---
const asyncJobs = new Map();
const requestIndex = new Map();
const ASYNC_ATTEMPT_TIMEOUT_MS = 360000; // 单次尝试 6 分钟
const WAKE_EXECUTION_GUARD_MS = Math.max(
  60000,
  Number(process["env"].GECHO_WAKE_EXECUTION_GUARD_MS || ASYNC_ATTEMPT_TIMEOUT_MS + EXTENSION_CONNECT_TIMEOUT_MS + 60000)
);
let persistJobsTimer = null;
let persistRequestIndexTimer = null;
let cleanupTimer = null;
let writeQueue = Promise.resolve();

// 本地定时任务（第一期验证版）：先支持可持久化的单次执行。
// cron、重复规则和补跑策略会建立在同一份任务存储之上。
const scheduledJobs = new Map();
let scheduledJobsTimer = null;
let persistScheduledJobsTimer = null;
let wakeSchedulerSyncTimer = null;
let wakeSchedulerSyncPromise = null;
let windowsNativeWakeTimer = null;
let wakeSchedulerState = {
  registeredWakeAt: null,
  registeredForJobId: null,
  lastSyncAt: null,
  lastError: "",
  lastAction: "not_initialized"
};
let wakeSchedulerSettings = {
  enabled: false,
  executionMode: "helper",
  updatedAt: null
};
const wakeExecutionGuards = new Map();

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

function getOpenExtensionSocket() {
  if (extensionSocket && extensionSocket.readyState === 1) {
    return extensionSocket;
  }

  // Chrome can briefly create overlapping WebSocket connections while an
  // extension service worker is starting or reconnecting. Do not rely on a
  // single mutable reference in that window: recover an open client directly
  // from the WebSocket server before declaring the extension disconnected.
  if (wss) {
    for (const socket of wss.clients) {
      if (socket.readyState === 1) {
        extensionSocket = socket;
        return socket;
      }
    }
  }

  return null;
}

function isExtensionConnected() {
  return !!getOpenExtensionSocket();
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
      detectedAt: Number(parsed.detectedAt || 0) || 0
    };
  } catch (e) {
    console.warn(`Failed to load last browser connection: ${e.message}`);
    return null;
  }
}

function persistLastBrowserConnection(browser) {
  const normalized = normalizeBrowserName(browser);
  if (!normalized) return;
  lastBrowserConnection = { browser: normalized, detectedAt: Date.now() };
  try {
    ensureJobsDirReady();
    writeFileAtomic(BROWSER_CONNECTION_PATH, JSON.stringify(lastBrowserConnection));
  } catch (e) {
    console.warn(`Failed to persist last browser connection: ${e.message}`);
  }
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

function getBrowserLaunchSpec(browser) {
  const normalized = normalizeBrowserName(browser);
  const appName = normalized === "edge" ? "Microsoft Edge" : "Google Chrome";

  if (!normalized) return null;

  if (process.platform === "darwin") {
    return {
      command: "open",
      args: ["-a", appName, "--args", "--new-window", "about:blank"]
    };
  }

  if (process.platform === "win32") {
    const browserPath = getWindowsBrowserExecutable(normalized);
    if (browserPath) {
      return {
        command: browserPath,
        args: ["--new-window", "about:blank"]
      };
    }

    const executable = normalized === "edge" ? "msedge" : "chrome";
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", executable, "--new-window", "about:blank"]
    };
  }

  const executable = findFirstCommand(
    normalized === "edge"
      ? ["microsoft-edge", "microsoft-edge-stable"]
      : ["google-chrome", "google-chrome-stable"]
  ) || (normalized === "edge" ? "microsoft-edge" : "google-chrome");

  return {
    command: executable,
    args: ["--new-window", "about:blank"]
  };
}

async function launchBrowserForExtension() {
  if (!AUTO_LAUNCH_BROWSER) {
    return { attempted: false, launched: false, reason: "disabled" };
  }

  const browser = getBrowserToLaunch();
  const spec = getBrowserLaunchSpec(browser);
  if (!spec) {
    return { attempted: false, launched: false, reason: "browser_unknown" };
  }

  if (browserLaunchPromise) return browserLaunchPromise;
  if (Date.now() - lastBrowserLaunchAt < AUTO_LAUNCH_BROWSER_COOLDOWN_MS) {
    return { attempted: false, launched: false, browser, reason: "cooldown" };
  }
  lastBrowserLaunchAt = Date.now();

  browserLaunchPromise = new Promise((resolve) => {
    if (AUTO_LAUNCH_BROWSER_DRY_RUN) {
      console.log(`🧪 Browser launch dry run: ${browser}`);
      resolve({ attempted: true, launched: true, browser, dryRun: true });
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
      console.log(`🌐 Started ${browser} while waiting for the extension connection`);
      resolve({ attempted: true, launched: true, browser });
    });
  });

  try {
    return await browserLaunchPromise;
  } finally {
    browserLaunchPromise = null;
  }
}

function waitForExtensionConnection(timeoutMs = EXTENSION_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (isExtensionConnected()) return resolve(true);

    let waited = 0;
    const checkTimer = setInterval(() => {
      waited += EXTENSION_CONNECT_POLL_MS;
      if (isExtensionConnected()) {
        clearInterval(checkTimer);
        resolve(true);
      } else if (waited >= timeoutMs) {
        clearInterval(checkTimer);
        resolve(false);
      }
    }, EXTENSION_CONNECT_POLL_MS);
  });
}

async function waitForExtensionReadyGracePeriod() {
  const remainingMs = Math.max(0, EXTENSION_READY_GRACE_MS - (Date.now() - lastExtensionConnectedAt));
  if (remainingMs === 0) return isExtensionConnected();

  traceBridgeEvent("extension_ready_grace_wait_started", { remainingMs });
  await new Promise(resolve => setTimeout(resolve, remainingMs));
  const connected = isExtensionConnected();
  traceBridgeEvent("extension_ready_grace_wait_finished", { connected });
  return connected;
}

async function ensureExtensionConnection(action) {
  if (isExtensionConnected()) {
    traceBridgeEvent("extension_already_connected", { action });
    return { connected: true, launch: { attempted: false, launched: false, reason: "already_connected" } };
  }

  traceBridgeEvent("extension_connection_wait_started", { action });
  const launch = await launchBrowserForExtension();
  console.log(
    `⏳ Extension not connected yet. Waiting up to ${EXTENSION_CONNECT_TIMEOUT_MS / 1000}s ` +
    `(action: ${action}, browser: ${launch.browser || "unknown"})`
  );
  const connected = await waitForExtensionConnection();
  const ready = connected && await waitForExtensionReadyGracePeriod();
  traceBridgeEvent("extension_connection_wait_finished", {
    action,
    connected: ready,
    browser: launch.browser || "",
    launchReason: launch.reason || ""
  });
  return { connected: ready, launch };
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
  if ((next.status === "completed" || next.status === "error") && next.scheduledJobId) {
    completeScheduledRunFromAsyncJob(next);
  }
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

function saveScheduledJobsToDiskNow() {
  try {
    ensureJobsDirReady();
    const payload = {
      savedAt: Date.now(),
      jobs: Object.fromEntries(scheduledJobs)
    };
    enqueueWrite(
      async () => {
        await writeFileAtomicAsync(SCHEDULED_JOBS_STORE_PATH, JSON.stringify(payload));
      },
      "persist_scheduled_jobs"
    );
  } catch (e) {
    console.error("Failed to persist scheduled jobs:", e.message);
  }
}

function schedulePersistScheduledJobs() {
  if (persistScheduledJobsTimer) return;
  persistScheduledJobsTimer = setTimeout(() => {
    persistScheduledJobsTimer = null;
    saveScheduledJobsToDiskNow();
  }, 100);
}

function writeScheduledJob(jobId, patch) {
  const previous = scheduledJobs.get(jobId);
  if (!previous) return null;
  const next = { ...previous, ...patch, updatedAt: Date.now() };
  scheduledJobs.set(jobId, next);
  schedulePersistScheduledJobs();
  return next;
}

function parseScheduleTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function getDefaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch (e) {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }
}

function normalizeMisfirePolicy(payload = {}, fallback = {}) {
  const policy = String(payload.misfirePolicy ?? fallback.misfirePolicy ?? "run_once").trim().toLowerCase();
  if (!["run_once", "skip", "window"].includes(policy)) {
    throw new Error("misfirePolicy must be one of: run_once, skip, window");
  }
  const rawWindow = payload.misfireWindowMs ?? fallback.misfireWindowMs ?? 60 * 60 * 1000;
  const misfireWindowMs = Number(rawWindow);
  if (policy === "window" && (!Number.isFinite(misfireWindowMs) || misfireWindowMs < 0)) {
    throw new Error("misfireWindowMs must be a non-negative number for misfirePolicy=window");
  }
  return policy === "window" ? { misfirePolicy: policy, misfireWindowMs } : { misfirePolicy: policy };
}

function normalizeSchedule(schedule = {}) {
  const type = String(schedule.type || "").trim().toLowerCase();
  if (type === "once") {
    const runAtMs = Date.parse(String(schedule.runAt || ""));
    if (!Number.isFinite(runAtMs)) throw new Error("schedule.runAt must be a valid ISO-8601 timestamp");
    return { type: "once", runAt: new Date(runAtMs).toISOString() };
  }

  if (type !== "daily" && type !== "weekly") {
    throw new Error("schedule.type must be one of: once, daily, weekly");
  }

  const time = parseScheduleTime(schedule.time);
  if (!time) throw new Error("schedule.time must use HH:mm (24-hour) format");
  const timezone = String(schedule.timezone || getDefaultTimeZone());
  assertTimeZone(timezone);

  if (type === "daily") return { type, time: time.text, timezone };

  const days = Array.isArray(schedule.days) ? Array.from(new Set(schedule.days.map(Number))).sort((a, b) => a - b) : [];
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("schedule.days must contain weekday numbers 0 (Sunday) through 6 (Saturday)");
  }
  return { type, time: time.text, timezone, days };
}

function getZonedMinuteParts(timestamp, timezone, formatter) {
  const parts = formatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdayMap[values.weekday]
  };
}

function calculateNextRunAtMs(schedule, afterMs = Date.now()) {
  if (schedule?.type === "once") {
    const runAtMs = Date.parse(String(schedule.runAt || ""));
    return Number.isFinite(runAtMs) && runAtMs > afterMs ? runAtMs : 0;
  }

  if (schedule?.type !== "daily" && schedule?.type !== "weekly") return 0;
  const time = parseScheduleTime(schedule.time);
  if (!time) return 0;
  const timezone = String(schedule.timezone || getDefaultTimeZone());
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone
  });
  const acceptedDays = schedule.type === "weekly" ? new Set(schedule.days || []) : null;
  const start = Math.floor(afterMs / 60000) * 60000 + 60000;
  const horizon = start + 9 * 24 * 60 * 60000;
  for (let candidate = start; candidate <= horizon; candidate += 60000) {
    const parts = getZonedMinuteParts(candidate, timezone, formatter);
    if (parts.hour !== time.hour || parts.minute !== time.minute) continue;
    if (!acceptedDays || acceptedDays.has(parts.weekday)) return candidate;
  }
  return 0;
}

function getScheduledRunAtMs(job) {
  const nextRunAtMs = Date.parse(String(job?.nextRunAt || ""));
  if (Number.isFinite(nextRunAtMs)) return nextRunAtMs;
  const legacyRunAtMs = Date.parse(String(job?.schedule?.runAt || ""));
  return Number.isFinite(legacyRunAtMs) ? legacyRunAtMs : 0;
}

function getPublicScheduledJob(job) {
  if (!job || typeof job !== "object") return job;
  const { runs = [], ...summary } = job;
  return {
    ...summary,
    nextRunAt: job.enabled && job.status === "scheduled" ? job.nextRunAt || null : null,
    runCount: runs.length,
    latestRun: runs.length ? runs[runs.length - 1] : null
  };
}

function getScheduledRuns(job) {
  return Array.isArray(job?.runs) ? job.runs.slice().reverse() : [];
}

function getNextScheduledJobForWake() {
  return Array.from(scheduledJobs.values())
    .filter((job) => job.enabled && job.status === "scheduled" && getScheduledRunAtMs(job) > Date.now())
    .sort((a, b) => getScheduledRunAtMs(a) - getScheduledRunAtMs(b))[0] || null;
}

function formatPmsetDate(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear() % 100)} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isWakeSchedulerEnabled() {
  return WAKE_SCHEDULER_ENV_ENABLED || wakeSchedulerSettings.enabled === true;
}

function usesWakeHelper() {
  return process.platform === "darwin" && !WAKE_SCHEDULER_ENV_ENABLED && wakeSchedulerSettings.enabled === true && WAKE_SCHEDULER_OWNER === WAKE_HELPER_OWNER;
}

function saveWakeSchedulerSettings() {
  try {
    ensureJobsDirReady();
    writeFileAtomic(WAKE_SCHEDULER_SETTINGS_PATH, JSON.stringify(wakeSchedulerSettings));
  } catch (e) {
    console.error("Failed to persist wake scheduler settings:", e.message);
  }
}

function updateWakeSchedulerSettings(patch) {
  wakeSchedulerSettings = {
    ...wakeSchedulerSettings,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  saveWakeSchedulerSettings();
  return wakeSchedulerSettings;
}

function loadWakeSchedulerSettings() {
  try {
    if (!fs.existsSync(WAKE_SCHEDULER_SETTINGS_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(WAKE_SCHEDULER_SETTINGS_PATH, "utf8") || "{}");
    wakeSchedulerSettings = {
      ...wakeSchedulerSettings,
      enabled: parsed.enabled === true,
      executionMode: process.platform === "win32" ? "task_scheduler" : "helper",
      updatedAt: parsed.updatedAt || null
    };
  } catch (e) {
    console.error("Failed to load wake scheduler settings:", e.message);
  }
}

function saveWakeSchedulerState() {
  try {
    ensureJobsDirReady();
    enqueueWrite(
      async () => {
        await writeFileAtomicAsync(WAKE_SCHEDULER_STATE_PATH, JSON.stringify(wakeSchedulerState));
      },
      "persist_wake_scheduler_state"
    );
  } catch (e) {
    console.error("Failed to persist wake scheduler state:", e.message);
  }
}

function updateWakeSchedulerState(patch) {
  wakeSchedulerState = { ...wakeSchedulerState, ...patch, updatedAt: Date.now() };
  saveWakeSchedulerState();
  return wakeSchedulerState;
}

function loadWakeSchedulerState() {
  try {
    if (!fs.existsSync(WAKE_SCHEDULER_STATE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(WAKE_SCHEDULER_STATE_PATH, "utf8") || "{}");
    wakeSchedulerState = {
      ...wakeSchedulerState,
      registeredWakeAt: parsed.registeredWakeAt || null,
      registeredForJobId: parsed.registeredForJobId || null,
      lastSyncAt: parsed.lastSyncAt || null,
      lastError: parsed.lastError || "",
      lastAction: parsed.lastAction || "restored"
    };
  } catch (e) {
    console.error("Failed to load wake scheduler state:", e.message);
  }
}

function getWakeSchedulerPlan() {
  const nextJob = getNextScheduledJobForWake();
  if (!nextJob) return { nextJob: null, wakeAt: null, reason: "no_pending_scheduled_job" };
  const scheduledFor = getScheduledRunAtMs(nextJob);
  const wakeAt = scheduledFor - WAKE_SCHEDULER_LEAD_MS;
  if (wakeAt <= Date.now()) {
    return {
      nextJob,
      wakeAt: null,
      reason: "next_job_is_too_soon_to_register_a_wake_event",
      scheduledFor
    };
  }
  return { nextJob, wakeAt, scheduledFor, reason: "ready" };
}

function getWakeSchedulerStatus() {
  const plan = getWakeSchedulerPlan();
  const supported = process.platform === "darwin" || process.platform === "win32";
  const ownerValid = /^[A-Za-z0-9._-]+$/.test(WAKE_SCHEDULER_OWNER);
  const windowsTaskName = getWindowsWakeTaskName();
  return {
    supported,
    enabled: isWakeSchedulerEnabled(),
    configuredByUser: wakeSchedulerSettings.enabled === true,
    executionMode: process.platform === "win32" && wakeSchedulerSettings.enabled
      ? "task_scheduler"
      : (WAKE_SCHEDULER_ENV_ENABLED
      ? "development_environment"
      : (wakeSchedulerSettings.enabled ? (usesWakeHelper() ? "restricted_helper" : "configuration_error") : "disabled")),
    dryRun: WAKE_SCHEDULER_DRY_RUN,
    useSudoNonInteractive: usesWakeHelper() || WAKE_SCHEDULER_USE_SUDO,
    owner: WAKE_SCHEDULER_OWNER,
    leadMs: WAKE_SCHEDULER_LEAD_MS,
    pmsetPath: PMSET_PATH,
    helperPath: WAKE_HELPER_PATH,
    windowsTaskName: process.platform === "win32" ? windowsTaskName : null,
    windowsWakeHelperPath: process.platform === "win32" ? WINDOWS_WAKE_HELPER_PATH : null,
    windowsNativeWakeTimerPath: process.platform === "win32" ? WINDOWS_NATIVE_WAKE_TIMER_PATH : null,
    nativeTimerEnabled: process.platform === "win32" ? WINDOWS_NATIVE_WAKE_TIMER_ENABLED : false,
    nativeTimerActive: process.platform === "win32" ? !!windowsNativeWakeTimer : false,
    nativeTimerWakeAt: process.platform === "win32" ? windowsNativeWakeTimer?.wakeAt || null : null,
    windowsWakeGuardSeconds: process.platform === "win32" ? WINDOWS_WAKE_GUARD_SECONDS : null,
    helperOwnerCompatible: WAKE_SCHEDULER_OWNER === WAKE_HELPER_OWNER,
    ownerValid,
    executionGuardMs: WAKE_EXECUTION_GUARD_MS,
    activeExecutionGuards: wakeExecutionGuards.size,
    nextJob: plan.nextJob ? { id: plan.nextJob.id, action: plan.nextJob.action, nextRunAt: plan.nextJob.nextRunAt } : null,
    plannedWakeAt: plan.wakeAt ? new Date(plan.wakeAt).toISOString() : null,
    planReason: plan.reason,
    registeredWakeAt: wakeSchedulerState.registeredWakeAt,
    registeredForJobId: wakeSchedulerState.registeredForJobId,
    lastSyncAt: wakeSchedulerState.lastSyncAt,
    lastAction: wakeSchedulerState.lastAction,
    lastError: wakeSchedulerState.lastError
  };
}

function startWakeExecutionGuard(runId) {
  if (process.platform !== "darwin" || !isWakeSchedulerEnabled() || wakeExecutionGuards.has(runId)) return null;
  const seconds = Math.ceil(WAKE_EXECUTION_GUARD_MS / 1000);
  try {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-t", String(seconds)], {
      stdio: "ignore",
      windowsHide: true
    });
    wakeExecutionGuards.set(runId, child);
    traceBridgeEvent("wake_execution_guard_started", { runId, seconds });
    child.once("error", (error) => {
      if (wakeExecutionGuards.get(runId) === child) wakeExecutionGuards.delete(runId);
      traceBridgeEvent("wake_execution_guard_error", { runId, message: error.message });
    });
    child.once("exit", (code, signal) => {
      if (wakeExecutionGuards.get(runId) === child) wakeExecutionGuards.delete(runId);
      traceBridgeEvent("wake_execution_guard_finished", { runId, code, signal });
    });
    return child;
  } catch (error) {
    traceBridgeEvent("wake_execution_guard_error", { runId, message: error.message });
    return null;
  }
}

function stopWakeExecutionGuard(runId, reason) {
  const child = wakeExecutionGuards.get(runId);
  if (!child) return false;
  wakeExecutionGuards.delete(runId);
  try { child.kill("SIGTERM"); } catch (_e) {}
  traceBridgeEvent("wake_execution_guard_stopped", { runId, reason });
  return true;
}

function stopAllWakeExecutionGuards(reason) {
  for (const runId of wakeExecutionGuards.keys()) stopWakeExecutionGuard(runId, reason);
}

function runPmset(args) {
  if (WAKE_SCHEDULER_DRY_RUN) {
    return Promise.resolve({ dryRun: true, command: usesWakeHelper() || WAKE_SCHEDULER_USE_SUDO ? "sudo" : PMSET_PATH, args });
  }

  const helperMode = usesWakeHelper();
  let command = WAKE_SCHEDULER_USE_SUDO ? "sudo" : PMSET_PATH;
  let commandArgs = WAKE_SCHEDULER_USE_SUDO ? ["-n", PMSET_PATH, ...args] : args;
  if (helperMode) {
    const isCancel = args[0] === "schedule" && args[1] === "cancel";
    const isSchedule = args[0] === "schedule" && args[1] === "wake";
    const date = isCancel ? args[3] : args[2];
    const owner = isCancel ? args[4] : args[3];
    if ((!isCancel && !isSchedule) || owner !== WAKE_SCHEDULER_OWNER || !date) {
      return Promise.reject(new Error("Wake helper only accepts Gecho one-time wake schedule or cancel operations"));
    }
    command = "/usr/bin/sudo";
    commandArgs = ["-n", WAKE_HELPER_PATH, isCancel ? "cancel" : "schedule", date];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      const error = new Error((stderr || stdout || `pmset exited with code ${code}`).trim());
      error.code = code;
      reject(error);
    });
  });
}

function getWindowsWakeTaskName() {
  const identity = crypto.createHash("sha256").update(path.resolve(JOBS_DIR)).digest("hex").slice(0, 12);
  return `GechoBridge-WakeNext-${identity}`;
}

function getPowerShellExecutable() {
  const systemRoot = process["env"].SystemRoot || process["env"].WINDIR || "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

function runWindowsWakeHelper(mode, extra = {}) {
  if (!fs.existsSync(WINDOWS_WAKE_HELPER_PATH)) {
    return Promise.reject(new Error(`Windows wake helper is missing: ${WINDOWS_WAKE_HELPER_PATH}`));
  }
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_WAKE_HELPER_PATH,
    "-Mode", mode,
    "-TaskName", getWindowsWakeTaskName()
  ];
  if (extra.wakeAt) args.push("-WakeAt", extra.wakeAt);
  if (extra.guardSeconds) args.push("-GuardSeconds", String(extra.guardSeconds));
  return new Promise((resolve, reject) => {
    const child = spawn(getPowerShellExecutable(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error((stderr || stdout || `Windows wake helper exited with code ${code}`).trim()));
      try { resolve(JSON.parse(stdout.trim() || "{}")); } catch (_e) { resolve({ stdout: stdout.trim() }); }
    });
  });
}

async function registerWindowsWakeEvent(wakeAt) {
  if (WAKE_SCHEDULER_DRY_RUN) return { dryRun: true, wakeAt };
  return runWindowsWakeHelper("register", { wakeAt, guardSeconds: WINDOWS_WAKE_GUARD_SECONDS });
}

async function cancelWindowsWakeEvent() {
  if (WAKE_SCHEDULER_DRY_RUN) return { dryRun: true };
  return runWindowsWakeHelper("remove");
}

function stopWindowsNativeWakeTimer(reason = "cancelled") {
  const timer = windowsNativeWakeTimer;
  if (!timer) return false;
  windowsNativeWakeTimer = null;
  try { timer.child.kill(); } catch (_e) {}
  traceBridgeEvent("windows_native_wake_timer_stopped", { reason, wakeAt: timer.wakeAt });
  return true;
}

function startWindowsNativeWakeTimer(wakeAt) {
  if (process.platform !== "win32") return Promise.resolve({ supported: false });
  if (!fs.existsSync(WINDOWS_NATIVE_WAKE_TIMER_PATH)) {
    return Promise.reject(new Error(`Windows native wake timer helper is missing: ${WINDOWS_NATIVE_WAKE_TIMER_PATH}`));
  }
  stopWindowsNativeWakeTimer("replaced");
  if (WAKE_SCHEDULER_DRY_RUN) return Promise.resolve({ dryRun: true, wakeAt });

  return new Promise((resolve, reject) => {
    const child = spawn(getPowerShellExecutable(), [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", WINDOWS_NATIVE_WAKE_TIMER_PATH,
      "-WakeAt", wakeAt,
      "-NotifyUrl", `http://127.0.0.1:${HTTP_PORT}/wake-scheduler/native-timer-fired`
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("spawn", () => {
      const timer = { child, wakeAt };
      windowsNativeWakeTimer = timer;
      traceBridgeEvent("windows_native_wake_timer_armed", { wakeAt });
      resolve({ armed: true, wakeAt });
    });
    child.once("exit", (code, signal) => {
      if (windowsNativeWakeTimer?.child === child) windowsNativeWakeTimer = null;
      traceBridgeEvent("windows_native_wake_timer_exited", {
        wakeAt,
        code,
        signal,
        message: stderr.trim()
      });
    });
  });
}

async function cancelRegisteredWakeEvent() {
  if (!wakeSchedulerState.registeredWakeAt) return { cancelled: false, reason: "nothing_registered" };
  const registeredAt = Date.parse(wakeSchedulerState.registeredWakeAt);
  if (!Number.isFinite(registeredAt) || registeredAt <= Date.now()) {
    // Windows one-time tasks remain registered after they fire. Remove this
    // package-owned task even when its wake timestamp is already in the past.
    if (process.platform === "win32") {
      stopWindowsNativeWakeTimer("expired_wake_event");
      try { await cancelWindowsWakeEvent(); } catch (_e) {}
    }
    updateWakeSchedulerState({
      registeredWakeAt: null,
      registeredForJobId: null,
      lastSyncAt: new Date().toISOString(),
      lastAction: "expired_wake_event_cleared",
      lastError: ""
    });
    return { cancelled: false, reason: "wake_event_already_elapsed" };
  }
  if (process.platform === "win32") {
    stopWindowsNativeWakeTimer("wake_event_cancelled");
    await cancelWindowsWakeEvent();
  } else {
    const date = formatPmsetDate(registeredAt);
    await runPmset(["schedule", "cancel", "wake", date, WAKE_SCHEDULER_OWNER]);
  }
  updateWakeSchedulerState({
    registeredWakeAt: null,
    registeredForJobId: null,
    lastSyncAt: new Date().toISOString(),
    lastAction: "cancelled",
    lastError: ""
  });
  return { cancelled: true };
}

async function syncWakeScheduler(reason = "scheduler_changed") {
  if (wakeSchedulerSyncPromise) return wakeSchedulerSyncPromise;
  wakeSchedulerSyncPromise = (async () => {
    const status = getWakeSchedulerStatus();
    if (!status.supported) {
      updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "unsupported_platform", lastError: "" });
      return getWakeSchedulerStatus();
    }
    if (!status.enabled) {
      updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "disabled", lastError: "" });
      return getWakeSchedulerStatus();
    }
    if (!status.ownerValid) {
      const message = "GECHO_WAKE_SCHEDULER_OWNER may only contain letters, numbers, dots, underscores, and hyphens";
      updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "invalid_owner", lastError: message });
      return getWakeSchedulerStatus();
    }
    if (process.platform === "darwin" && wakeSchedulerSettings.enabled && !status.helperOwnerCompatible && !WAKE_SCHEDULER_ENV_ENABLED) {
      const message = `Wake Helper only supports owner ${WAKE_HELPER_OWNER}`;
      updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "helper_owner_mismatch", lastError: message });
      return getWakeSchedulerStatus();
    }

    const plan = getWakeSchedulerPlan();
    if (!plan.wakeAt) {
      if (wakeSchedulerState.registeredWakeAt) await cancelRegisteredWakeEvent();
      updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: plan.reason, lastError: "" });
      return getWakeSchedulerStatus();
    }

    const desiredWakeAt = new Date(plan.wakeAt).toISOString();
    if (wakeSchedulerState.registeredWakeAt === desiredWakeAt && wakeSchedulerState.registeredForJobId === plan.nextJob.id) {
      updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "already_registered", lastError: "" });
      return getWakeSchedulerStatus();
    }

    if (wakeSchedulerState.registeredWakeAt) await cancelRegisteredWakeEvent();
    if (process.platform === "win32") {
      await registerWindowsWakeEvent(desiredWakeAt);
      if (WINDOWS_NATIVE_WAKE_TIMER_ENABLED) await startWindowsNativeWakeTimer(desiredWakeAt);
    } else {
      const pmsetDate = formatPmsetDate(plan.wakeAt);
      await runPmset(["schedule", "wake", pmsetDate, WAKE_SCHEDULER_OWNER]);
    }
    updateWakeSchedulerState({
      registeredWakeAt: desiredWakeAt,
      registeredForJobId: plan.nextJob.id,
      lastSyncAt: new Date().toISOString(),
      lastAction: WAKE_SCHEDULER_DRY_RUN ? "registered_dry_run" : "registered",
      lastError: "",
      reason
    });
    return getWakeSchedulerStatus();
  })().catch((e) => {
    const message = e.message || "Failed to synchronize macOS wake schedule";
    updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "error", lastError: message });
    return getWakeSchedulerStatus();
  }).finally(() => {
    wakeSchedulerSyncPromise = null;
  });
  return wakeSchedulerSyncPromise;
}

function queueWakeSchedulerSync(reason) {
  if (wakeSchedulerSyncTimer) clearTimeout(wakeSchedulerSyncTimer);
  wakeSchedulerSyncTimer = setTimeout(() => {
    wakeSchedulerSyncTimer = null;
    syncWakeScheduler(reason).catch(() => {});
  }, 50);
}

function addScheduledRun(job, run) {
  const runs = [...(Array.isArray(job.runs) ? job.runs : []), run].slice(-MAX_SCHEDULED_RUNS_PER_JOB);
  return runs;
}

function updateScheduledRun(job, runId, patch) {
  const runs = Array.isArray(job.runs) ? job.runs : [];
  return runs.map((run) => run.id === runId ? { ...run, ...patch, updatedAt: Date.now() } : run);
}

function completeScheduledRunFromAsyncJob(asyncJob) {
  const scheduleId = String(asyncJob?.scheduledJobId || "");
  const runId = String(asyncJob?.scheduledRunId || "");
  if (!scheduleId || !runId) return;
  const scheduled = scheduledJobs.get(scheduleId);
  if (!scheduled) return;
  const terminal = asyncJob.status === "completed" ? "completed" : asyncJob.status === "error" ? "error" : "";
  if (!terminal) return;

  const completedAt = Number(asyncJob.completedAt || asyncJob.lastUpdateAt || Date.now());
  const runs = updateScheduledRun(scheduled, runId, {
    status: terminal,
    completedAt,
    resultCount: Array.isArray(asyncJob.data) ? asyncJob.data.length : undefined,
    savePath: asyncJob.savePath || "",
    error: terminal === "error" ? asyncJob.error || "Scheduled action failed" : ""
  });
  const nextStatus = scheduled.schedule?.type === "once"
    ? terminal
    : (scheduled.enabled ? "scheduled" : "paused");
  writeScheduledJob(scheduleId, {
    status: nextStatus,
    runs,
    lastRun: runs.find((run) => run.id === runId) || null,
    lastError: terminal === "error" ? asyncJob.error || "Scheduled action failed" : ""
  });
  stopWakeExecutionGuard(runId, `async_job_${terminal}`);
}

function recordSkippedScheduledRun(job, scheduledFor, reason) {
  const run = {
    id: `run-${Date.now()}-${requestIdCounter++}`,
    scheduledFor: new Date(scheduledFor).toISOString(),
    status: "skipped",
    startedAt: Date.now(),
    completedAt: Date.now(),
    error: reason
  };
  const nextRunAtMs = calculateNextRunAtMs(job.schedule, Date.now());
  const isOneTime = job.schedule?.type === "once";
  writeScheduledJob(job.id, {
    status: isOneTime ? "skipped" : "scheduled",
    enabled: isOneTime ? false : job.enabled,
    nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null,
    runs: addScheduledRun(job, run),
    lastRun: run,
    lastError: reason
  });
}

function shouldDispatchMissedJob(job, scheduledFor, now) {
  const lateBy = Math.max(0, now - scheduledFor);
  if (lateBy <= SCHEDULE_MISFIRE_GRACE_MS) return { dispatch: true };
  if (job.misfirePolicy === "skip") return { dispatch: false, reason: `Missed by ${lateBy}ms; policy=skip` };
  if (job.misfirePolicy === "window" && lateBy > Number(job.misfireWindowMs || 0)) {
    return { dispatch: false, reason: `Missed by ${lateBy}ms; exceeded window ${job.misfireWindowMs}ms` };
  }
  return { dispatch: true };
}

function loadScheduledJobsFromDisk() {
  try {
    if (!fs.existsSync(SCHEDULED_JOBS_STORE_PATH)) return;
    const raw = fs.readFileSync(SCHEDULED_JOBS_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const jobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
    for (const [jobId, saved] of Object.entries(jobs)) {
      if (!saved || typeof saved !== "object" || !jobId || !saved.schedule) continue;
      try {
        const schedule = normalizeSchedule(saved.schedule);
        const enabled = saved.enabled !== false;
        const status = String(saved.status || (enabled ? "scheduled" : "paused"));
        const nextRunAtMs = getScheduledRunAtMs(saved) || calculateNextRunAtMs(schedule, Date.now());
        scheduledJobs.set(jobId, {
          ...saved,
          id: String(saved.id || jobId),
          schedule,
          enabled,
          status,
          nextRunAt: enabled && status === "scheduled" && nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null,
          runs: Array.isArray(saved.runs) ? saved.runs.slice(-MAX_SCHEDULED_RUNS_PER_JOB) : []
        });
      } catch (e) {
        console.error(`Ignoring invalid scheduled job [${jobId}]:`, e.message);
      }
    }
    console.log(`♻️ Restored scheduled jobs from disk: ${scheduledJobs.size}`);
  } catch (e) {
    console.error("Failed to load scheduled jobs from disk:", e.message);
  }
}

async function startAsyncAction(payload, scheduleRef = {}) {
  const action = String(payload?.action || "").trim();
  if (!action) {
    const error = new Error("Missing action");
    error.code = "MISSING_ACTION";
    throw error;
  }

  const connection = await ensureExtensionConnection(action);
  if (!connection.connected) {
    const error = new Error(extensionConnectionError(connection));
    error.code = "EXTENSION_DISCONNECTED";
    throw error;
  }

  const jobId = `job-${Date.now()}-${requestIdCounter++}`;
  const { action: _action, ...params } = payload;
  const dataDir = payload.save_dir || process["env"].GECHO_DATA_DIR || path.join(__dirname, "data");
  const fileNameSeed = params.uniqueId || params.query || params.product_url || params.url || action;
  const safeName = toSafeFileName(fileNameSeed);
  const prefix = (params.uniqueId || params.query || params.product_url || params.url)
    ? `${toSafeFileName(action)}_`
    : "";
  const anticipatedSavePath = dataDir.toLowerCase().endsWith(".json") || dataDir.toLowerCase().endsWith(".csv")
    ? dataDir
    : path.join(dataDir, `${prefix}${safeName}_results.json`);

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
    scheduledJobId: scheduleRef.scheduleId || "",
    scheduledRunId: scheduleRef.runId || "",
    events: []
  });
  schedulePersistAsyncJobs();
  appendJobEvent(jobId, "job_created", { action });
  console.log(`🚀 Dispatching ASYNC action: [${action}], jobId: ${jobId}`);
  runAsyncAttempt({ jobId, action, params, payload, attempt: 1 });
  return { jobId, savePath: anticipatedSavePath };
}

async function dispatchScheduledJob(scheduleId, scheduledFor = Date.now()) {
  const scheduled = scheduledJobs.get(scheduleId);
  if (!scheduled || scheduled.status !== "scheduled" || !scheduled.enabled) return;

  const runId = `run-${Date.now()}-${requestIdCounter++}`;
  const run = {
    id: runId,
    scheduledFor: new Date(scheduledFor).toISOString(),
    status: "dispatching",
    startedAt: Date.now()
  };
  const nextRunAtMs = calculateNextRunAtMs(scheduled.schedule, scheduledFor);
  const isOneTime = scheduled.schedule?.type === "once";

  writeScheduledJob(scheduleId, {
    status: isOneTime ? "dispatching" : "scheduled",
    nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null,
    dispatchedAt: Date.now(),
    runs: addScheduledRun(scheduled, run),
    lastRun: run
  });
  console.log(`⏰ Running scheduled job: ${scheduleId} (${scheduled.action})`);
  startWakeExecutionGuard(runId);

  try {
    const result = await startAsyncAction({ action: scheduled.action, ...scheduled.params }, { scheduleId, runId });
    const latest = scheduledJobs.get(scheduleId);
    const runs = updateScheduledRun(latest, runId, {
      status: "dispatched",
      asyncJobId: result.jobId,
      savePath: result.savePath,
      dispatchedAt: Date.now()
    });
    writeScheduledJob(scheduleId, {
      status: isOneTime ? "dispatched" : "scheduled",
      asyncJobId: result.jobId,
      savePath: result.savePath,
      runs,
      lastRun: runs.find((item) => item.id === runId) || null
    });
  } catch (e) {
    stopWakeExecutionGuard(runId, "scheduled_dispatch_error");
    const latest = scheduledJobs.get(scheduleId);
    const runs = updateScheduledRun(latest, runId, {
      status: "error",
      error: e.message || "Failed to dispatch scheduled job",
      completedAt: Date.now()
    });
    writeScheduledJob(scheduleId, {
      status: isOneTime ? "error" : "scheduled",
      runs,
      lastRun: runs.find((item) => item.id === runId) || null,
      lastError: e.message || "Failed to dispatch scheduled job"
    });
    console.error(`Scheduled job failed [${scheduleId}]:`, e.message);
  }
}

function armScheduledJobsTimer() {
  if (scheduledJobsTimer) {
    clearTimeout(scheduledJobsTimer);
    scheduledJobsTimer = null;
  }

  const now = Date.now();
  const dueJobs = Array.from(scheduledJobs.values())
    .filter((job) => job.enabled && job.status === "scheduled" && getScheduledRunAtMs(job) > 0)
    .sort((a, b) => getScheduledRunAtMs(a) - getScheduledRunAtMs(b));
  if (!dueJobs.length) {
    queueWakeSchedulerSync("no_pending_scheduled_jobs");
    return;
  }

  const delay = Math.max(0, Math.min(getScheduledRunAtMs(dueJobs[0]) - now, 2 ** 31 - 1));
  scheduledJobsTimer = setTimeout(async () => {
    scheduledJobsTimer = null;
    const dueAt = Date.now();
    const jobs = Array.from(scheduledJobs.values())
      .filter((job) => job.enabled && job.status === "scheduled" && getScheduledRunAtMs(job) <= dueAt);
    for (const job of jobs) {
      const scheduledFor = getScheduledRunAtMs(job);
      const missed = shouldDispatchMissedJob(job, scheduledFor, dueAt);
      if (missed.dispatch) {
        await dispatchScheduledJob(job.id, scheduledFor);
      } else {
        recordSkippedScheduledRun(job, scheduledFor, missed.reason);
      }
    }
    armScheduledJobsTimer();
  }, delay);
  queueWakeSchedulerSync("scheduler_armed");
}

function createScheduledJob(payload) {
  const action = String(payload?.action || "").trim();
  if (!action) throw new Error("Missing action");
  const schedule = normalizeSchedule(payload?.schedule);
  const nextRunAtMs = calculateNextRunAtMs(schedule, Date.now());
  if (!nextRunAtMs) throw new Error("The schedule does not have a future execution time");

  const id = `schedule-${Date.now()}-${requestIdCounter++}`;
  const job = {
    id,
    action,
    params: payload?.params && typeof payload.params === "object" ? payload.params : {},
    schedule,
    ...normalizeMisfirePolicy(payload),
    enabled: payload?.enabled !== false,
    status: "scheduled",
    nextRunAt: new Date(nextRunAtMs).toISOString(),
    runs: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  scheduledJobs.set(id, job);
  schedulePersistScheduledJobs();
  armScheduledJobsTimer();
  return getPublicScheduledJob(job);
}

function updateScheduledJobDefinition(jobId, payload) {
  const previous = scheduledJobs.get(jobId);
  if (!previous) return null;
  const action = payload.action === undefined ? previous.action : String(payload.action || "").trim();
  if (!action) throw new Error("Missing action");
  const schedule = payload.schedule === undefined ? previous.schedule : normalizeSchedule(payload.schedule);
  const enabled = payload.enabled === undefined ? previous.enabled : payload.enabled !== false;
  const params = payload.params === undefined
    ? previous.params
    : (payload.params && typeof payload.params === "object" ? payload.params : {});
  const misfire = normalizeMisfirePolicy(payload, previous);
  const nextRunAtMs = enabled ? calculateNextRunAtMs(schedule, Date.now()) : 0;
  if (enabled && !nextRunAtMs) throw new Error("The schedule does not have a future execution time");
  const next = writeScheduledJob(jobId, {
    action,
    params,
    schedule,
    ...misfire,
    enabled,
    status: enabled ? "scheduled" : "paused",
    nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null,
    lastError: ""
  });
  armScheduledJobsTimer();
  return getPublicScheduledJob(next);
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
    }
  });

  extensionSocket.send(JSON.stringify({
    method: "execute_action",
    params: { action: action, params: params },
    requestId
  }));
}

function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Service shutting down: ${reason}`);
  stopAllWakeExecutionGuards("bridge_shutdown");
  stopWindowsNativeWakeTimer("bridge_shutdown");

  for (const [_requestId, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ error: "Service is shutting down" });
  }
  pendingRequests.clear();
  saveAsyncJobsToDiskNow();
  saveRequestIndexToDiskNow();
  saveScheduledJobsToDiskNow();
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
  if (scheduledJobsTimer) {
    clearTimeout(scheduledJobsTimer);
    scheduledJobsTimer = null;
  }
  if (persistScheduledJobsTimer) {
    clearTimeout(persistScheduledJobsTimer);
    persistScheduledJobsTimer = null;
  }
  if (wakeSchedulerSyncTimer) {
    clearTimeout(wakeSchedulerSyncTimer);
    wakeSchedulerSyncTimer = null;
  }

  try {
    if (extensionSocket && extensionSocket.readyState === 1) {
      extensionSocket.close(1001, "service_shutdown");
    }
  } catch (_e) {}

  const exitAfterPendingWrites = () => {
    writeQueue.finally(() => process.exit(0));
  };

  try {
    wss.close(() => {
      server.close(exitAfterPendingWrites);
    });
  } catch (_e) {
    try {
      server.close(exitAfterPendingWrites);
    } catch (__e) {
      exitAfterPendingWrites();
    }
  }
}

// --- WebSocket Server (与插件通信) ---
wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

wss.on("connection", (ws, request) => {
  const browser = detectBrowserFromUserAgent(request?.headers?.["user-agent"]);
  if (browser) persistLastBrowserConnection(browser);
  console.log(`✅ Browser extension connected to Service Layer${browser ? ` (${browser})` : ""}`);
  extensionSocket = ws;
  lastExtensionConnectedAt = Date.now();
  traceBridgeEvent("extension_connected", { browser, clientCount: wss.clients.size });

  ws.on("message", (message) => {
    try {
      const parsed = JSON.parse(message);
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
    traceBridgeEvent("extension_disconnected", { clientCount: wss.clients.size });
    if (extensionSocket === ws) extensionSocket = null;
  });

  ws.on("error", (error) => {
    traceBridgeEvent("extension_socket_error", { message: error.message });
    console.warn(`Browser extension WebSocket error: ${error.message}`);
  });
});

loadAsyncJobsFromDisk();
loadRequestIndexFromDisk();
loadScheduledJobsFromDisk();
loadWakeSchedulerSettings();
loadWakeSchedulerState();
checkJobsStoreWritable();
runJobCleanup();
cleanupTimer = setInterval(runJobCleanup, CLEANUP_INTERVAL_MS);
armScheduledJobsTimer();

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
      autoBrowserLaunch: {
        enabled: AUTO_LAUNCH_BROWSER,
        browser: getBrowserToLaunch() || null
      },
      scheduler: {
        total: scheduledJobs.size,
        enabled: Array.from(scheduledJobs.values()).filter((job) => job.enabled).length,
        nextRunAt: Array.from(scheduledJobs.values())
          .filter((job) => job.enabled && job.status === "scheduled" && job.nextRunAt)
          .sort((a, b) => getScheduledRunAtMs(a) - getScheduledRunAtMs(b))[0]?.nextRunAt || null
      },
      wakeScheduler: getWakeSchedulerStatus(),
      bridgeTrace: bridgeTrace.slice(-30)
    }));
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    res.end(JSON.stringify({ status: "ok", message: "shutdown accepted" }));
    setTimeout(() => gracefulShutdown("remote_shutdown"), 20).unref?.();
    return;
  }

  if (req.method === "GET" && req.url === "/wake-scheduler/status") {
    return res.end(JSON.stringify(getWakeSchedulerStatus()));
  }

  if (req.method === "POST" && req.url === "/wake-scheduler/native-timer-fired") {
    traceBridgeEvent("windows_native_wake_timer_fired", { wakeAt: windowsNativeWakeTimer?.wakeAt || null });
    updateWakeSchedulerState({
      nativeTimerFiredAt: new Date().toISOString(),
      lastAction: "native_timer_fired",
      lastError: ""
    });
    return res.end(JSON.stringify({ success: true }));
  }

  if (req.method === "POST" && req.url === "/wake-scheduler/refresh") {
    const status = await syncWakeScheduler("manual_refresh");
    return res.end(JSON.stringify(status));
  }

  if (req.method === "POST" && req.url === "/wake-scheduler/enable") {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Wake scheduling is only available on macOS and Windows" }));
    }
    updateWakeSchedulerSettings({ enabled: true, executionMode: process.platform === "win32" ? "task_scheduler" : "helper" });
    const status = await syncWakeScheduler("user_enabled");
    return res.end(JSON.stringify({ success: true, wakeScheduler: status }));
  }

  if (req.method === "POST" && req.url === "/wake-scheduler/disable") {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Wake scheduling is only available on macOS and Windows" }));
    }
    let cancelResult = { cancelled: false, reason: "nothing_registered" };
    try {
      cancelResult = await cancelRegisteredWakeEvent();
    } catch (e) {
      updateWakeSchedulerState({ lastAction: "disable_cancel_error", lastError: e.message || "Failed to cancel wake event" });
    }
    updateWakeSchedulerSettings({ enabled: false, executionMode: process.platform === "win32" ? "task_scheduler" : "helper" });
    updateWakeSchedulerState({ lastSyncAt: new Date().toISOString(), lastAction: "disabled_by_user" });
    return res.end(JSON.stringify({ success: true, ...cancelResult, wakeScheduler: getWakeSchedulerStatus() }));
  }

  if (req.method === "POST" && req.url === "/wake-scheduler/reload") {
    loadWakeSchedulerSettings();
    const status = await syncWakeScheduler("settings_reloaded");
    return res.end(JSON.stringify({ success: true, wakeScheduler: status }));
  }

  if (req.method === "POST" && req.url === "/wake-scheduler/cancel") {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Wake scheduling is only available on macOS and Windows" }));
    }
    if (!isWakeSchedulerEnabled()) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: "Wake scheduler is disabled. Run `gecho-bridge wake enable` first." }));
    }
    try {
      const result = await cancelRegisteredWakeEvent();
      return res.end(JSON.stringify({ success: true, ...result, wakeScheduler: getWakeSchedulerStatus() }));
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: e.message, wakeScheduler: getWakeSchedulerStatus() }));
    }
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

  if (req.method === "GET" && req.url === "/scheduled-jobs") {
    const jobs = Array.from(scheduledJobs.values())
      .sort((a, b) => getScheduledRunAtMs(a) - getScheduledRunAtMs(b))
      .map(getPublicScheduledJob);
    return res.end(JSON.stringify({ jobs }));
  }

  const scheduledRunsPath = req.url.match(/^\/scheduled-jobs\/([^/?]+)\/runs$/);
  if (req.method === "GET" && scheduledRunsPath) {
    const job = scheduledJobs.get(decodeURIComponent(scheduledRunsPath[1]));
    if (!job) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Scheduled job not found" }));
    }
    return res.end(JSON.stringify({ runs: getScheduledRuns(job) }));
  }

  const scheduledJobPath = req.url.match(/^\/scheduled-jobs\/([^/?]+)$/);
  if (req.method === "GET" && scheduledJobPath) {
    const job = scheduledJobs.get(decodeURIComponent(scheduledJobPath[1]));
    if (!job) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Scheduled job not found" }));
    }
    return res.end(JSON.stringify(getPublicScheduledJob(job)));
  }

  if (req.method === "DELETE" && scheduledJobPath) {
    const jobId = decodeURIComponent(scheduledJobPath[1]);
    if (!scheduledJobs.has(jobId)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Scheduled job not found" }));
    }
    scheduledJobs.delete(jobId);
    schedulePersistScheduledJobs();
    armScheduledJobsTimer();
    return res.end(JSON.stringify({ success: true, id: jobId }));
  }

  if (req.method === "PATCH" && scheduledJobPath) {
    const jobId = decodeURIComponent(scheduledJobPath[1]);
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const job = updateScheduledJobDefinition(jobId, JSON.parse(body));
        if (!job) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "Scheduled job not found" }));
        }
        return res.end(JSON.stringify({ success: true, job }));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/scheduled-jobs") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const job = createScheduledJob(JSON.parse(body));
        res.statusCode = 201;
        res.end(JSON.stringify({ success: true, job }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- 异步任务启动接口 ---
  if (req.method === "POST" && req.url === "/async-action") {
    if (shuttingDown) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: "Service is shutting down" }));
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const result = await startAsyncAction(JSON.parse(body));
        return res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        res.statusCode = e.code === "EXTENSION_DISCONNECTED" ? 503 : 400;
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
          }, 600000);

          pendingRequests.set(requestId, {
            resolve,
            timeoutId,
            action,
            startedAt: Date.now()
          });


          
          extensionSocket.send(JSON.stringify({
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
      } catch (e) {
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
