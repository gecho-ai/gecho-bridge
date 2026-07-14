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
const packageJson = require("./package.json");

const WS_PORT = 18792;
const HTTP_PORT = 18793;
const SERVICE_PROTOCOL_VERSION = 2;
const SERVICE_STARTED_AT = Date.now();
const DEFAULT_DATA_DIR = path.join(__dirname, "data");
const JOBS_DIR = process["env"].GECHO_DATA_DIR || DEFAULT_DATA_DIR;
const JOBS_STORE_PATH = path.join(JOBS_DIR, ".async_jobs.json");
const JOB_DETAILS_DIR = path.join(JOBS_DIR, "jobs");
const REQUEST_INDEX_PATH = path.join(JOBS_DIR, ".async_request_index.json");
const JOB_TTL_MS = Number(process["env"].GECHO_JOB_TTL_MS || 3 * 24 * 60 * 60 * 1000); // 默认 3 天
const MAX_PERSISTED_JOBS = Number(process["env"].GECHO_MAX_PERSISTED_JOBS || 2000);
const CLEANUP_INTERVAL_MS = Number(process["env"].GECHO_CLEANUP_INTERVAL_MS || 10 * 60 * 1000);

let extensionSocket = null;
const pendingRequests = new Map();
let requestIdCounter = 1;
let shuttingDown = false;
let lastDispatchedRequestId = "";

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

function runAsyncAttempt({ jobId, action, params, payload, attempt }) {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    updateJob(jobId, {
      status: "error",
      stage: "extension_disconnected",
      error: "Extension not connected during async dispatch"
    });
    return;
  }

  const requestId = `${jobId}:a${attempt}`;
  lastDispatchedRequestId = requestId;
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
const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

wss.on("connection", (ws) => {
  console.log("✅ Chrome Extension connected to Service Layer");
  extensionSocket = ws;

  ws.on("message", (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.method === "action_progress" && parsed.requestId) {
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
    console.log("❌ Chrome Extension disconnected");
    extensionSocket = null;
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
      dataDir: JOBS_DIR
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

        if (!extensionSocket || extensionSocket.readyState !== 1) {
          // 如果尚未连接，提供更友好的等待机制而不是直接报错
          console.log(`⏳ Extension not connected yet. Waiting for connection... (action: ${action})`);
          
          const maxWaitMs = 15000; // 最多等待 15 秒
          const checkIntervalMs = 500;
          let waited = 0;
          
          await new Promise((resolve) => {
            const checkTimer = setInterval(() => {
              waited += checkIntervalMs;
              if (extensionSocket && extensionSocket.readyState === 1) {
                clearInterval(checkTimer);
                resolve();
              } else if (waited >= maxWaitMs) {
                clearInterval(checkTimer);
                resolve(); // 等待超时后继续往下走，下面依然会判断并抛出错误
              }
            }, checkIntervalMs);
          });
          
          if (!extensionSocket || extensionSocket.readyState !== 1) {
            res.statusCode = 503;
            return res.end(JSON.stringify({ 
              error: "Extension not connected. Chrome 插件未连接。\n请检查：\n1. Chrome 是否保持打开状态\n2. Gecho TikTok Bridge 插件是否仍在运行（扩展图标是否亮着）\n3. TikTok tab 是否活跃（最好在 tiktok.com 页面上）\n如果插件刚启动，请等待几秒后再试。" 
            }));
          }
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
      try {
        const payload = JSON.parse(body);
        const action = payload.action;
        
        if (!action) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "Missing action" }));
        }

        if (!extensionSocket || extensionSocket.readyState !== 1) {
          // 如果尚未连接，提供更友好的等待机制而不是直接报错
          console.log(`⏳ Extension not connected yet. Waiting for connection... (action: ${action})`);
          
          const maxWaitMs = 15000; // 最多等待 15 秒
          const checkIntervalMs = 500;
          let waited = 0;
          
          await new Promise((resolve) => {
            const checkTimer = setInterval(() => {
              waited += checkIntervalMs;
              if (extensionSocket && extensionSocket.readyState === 1) {
                clearInterval(checkTimer);
                resolve();
              } else if (waited >= maxWaitMs) {
                clearInterval(checkTimer);
                resolve(); 
              }
            }, checkIntervalMs);
          });
          
          if (!extensionSocket || extensionSocket.readyState !== 1) {
            res.statusCode = 503;
            return res.end(JSON.stringify({ 
              error: "Extension not connected. Chrome 插件未连接。\n请检查：\n1. Chrome 是否保持打开状态\n2. Gecho TikTok Bridge 插件是否仍在运行（扩展图标是否亮着）\n3. TikTok tab 是否活跃（最好在 tiktok.com 页面上）\n如果插件刚启动，请等待几秒后再试。" 
            }));
          }
        }

        console.log(`🚀 Dispatching action: [${action}]`);
        const requestId = `svc-${Date.now()}-${requestIdCounter++}`;
        lastDispatchedRequestId = requestId;
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
