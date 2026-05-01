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

const WS_PORT = 18792;
const HTTP_PORT = 18793;

let extensionSocket = null;
const pendingRequests = new Map();
let requestIdCounter = 1;
let shuttingDown = false;

// --- 异步任务管理 ---
const asyncJobs = new Map();
const ASYNC_ATTEMPT_TIMEOUT_MS = 360000; // 单次尝试 6 分钟

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
  return next;
}

function appendJobEvent(jobId, message, extra = {}) {
  const prev = asyncJobs.get(jobId) || {};
  const events = Array.isArray(prev.events) ? prev.events.slice(-14) : [];
  events.push({ at: Date.now(), message, ...extra });
  asyncJobs.set(jobId, { ...prev, events, lastUpdateAt: Date.now() });
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
  appendJobEvent(jobId, "attempt_started", { attempt, requestId });
  updateJob(jobId, {
    status: "running",
    stage: "awaiting_extension_result",
    attempt,
    activeRequestId: requestId
  });

  const timeoutId = setTimeout(() => {
    pendingRequests.delete(requestId);
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
    resolve: (result) => {
      clearTimeout(timeoutId);
      const job = asyncJobs.get(jobId);
      if (!job || job.status !== "running") return;

      appendJobEvent(jobId, "attempt_result_received", { attempt });

      let savePath = "";
      let saveWarning = "";
      if (Array.isArray(result) && result.length > 0) {
        let dataDir = payload.save_dir || process["env"].GECHO_DATA_DIR || path.join(__dirname, "data");
        let fixedPath;
        const safeName = toSafeFileName(params.query || action);
        const prefix = params.query ? `${toSafeFileName(action)}_` : "";
        
        if (dataDir.toLowerCase().endsWith(".json") || dataDir.toLowerCase().endsWith(".csv")) {
          // 如果传入的 save_dir 误填成了文件路径，则将其作为最终文件路径，并提取所在目录
          fixedPath = dataDir;
          dataDir = path.dirname(fixedPath);
        } else {
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
        if (pending?.jobId) {
          updateJob(pending.jobId, {
            stage: "extension_processing",
            lastProgressAt: Date.now(),
            progress: parsed.progress
          });
          appendJobEvent(pending.jobId, "progress", { progress: parsed.progress ?? null });
        }
      }
      if (parsed.method === "action_result" && parsed.requestId) {
        console.log(`📩 Received result from extension (ID: ${parsed.requestId})`);
        const pending = pendingRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pending.resolve(parsed.data);
          pendingRequests.delete(parsed.requestId);
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
    return res.end(JSON.stringify({ status: "ok" }));
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
      if (!jobId || !asyncJobs.has(jobId)) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Job not found" }));
      }
      return res.end(JSON.stringify(asyncJobs.get(jobId)));
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
        const safeName = toSafeFileName(params.query || action);
        const prefix = params.query ? `${toSafeFileName(action)}_` : "";
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
        // 通用透传逻辑：将 payload 中的所有参数（除去 action）作为 params 传给插件
        const { action: _a, ...params } = payload;
        const result = await new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({ error: `Scraping timeout (600s) for action: ${action}` });
          }, 600000);

          pendingRequests.set(requestId, { resolve, timeoutId });


          
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
          const safeName = toSafeFileName(params.query || action);
          const prefix = params.query ? `${toSafeFileName(action)}_` : "";
          
          if (dataDir.toLowerCase().endsWith(".json") || dataDir.toLowerCase().endsWith(".csv")) {
            // 如果传入的 save_dir 误填成了文件路径，则将其作为最终文件路径，并提取所在目录
            fixedPath = dataDir;
            dataDir = path.dirname(fixedPath);
          } else {
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
