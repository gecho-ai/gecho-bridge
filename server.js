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

// --- WebSocket Server (与插件通信) ---
const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

wss.on("connection", (ws) => {
  console.log("✅ Chrome Extension connected to Service Layer");
  extensionSocket = ws;

  ws.on("message", (message) => {
    try {
      const parsed = JSON.parse(message);
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
  res.setHeader("Content-Type", "application/json");

  // 健康检查接口
  if (req.method === "GET" && req.url === "/ping") {
    return res.end(JSON.stringify({ status: "ok" }));
  }

  if (req.method === "POST" && req.url === "/search") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { query } = JSON.parse(body);
        if (!query) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "Missing query" }));
        }

        if (!extensionSocket || extensionSocket.readyState !== 1) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ error: "Extension not connected" }));
        }

        console.log(`🔍 Processing search request for: [${query}]`);
        const requestId = `svc-${Date.now()}-${requestIdCounter++}`;
        
        const result = await new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({ error: "Scraping timeout (120s)" });
          }, 120000);

          pendingRequests.set(requestId, { resolve, timeoutId });

          extensionSocket.send(JSON.stringify({
            method: "execute_action",
            params: { action: "search", params: { query } },
            requestId: requestId
          }));
        });

        // 持久化存储
        if (Array.isArray(result) && result.length > 0) {
          const dataDir = path.join(__dirname, "..", "data");
          if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
          const fixedPath = path.join(dataDir, `${query}_search_results.json`);
          fs.writeFileSync(fixedPath, JSON.stringify(result, null, 2), "utf8");
        }

        res.end(JSON.stringify({ success: true, data: result }));
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
