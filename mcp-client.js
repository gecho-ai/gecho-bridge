#!/usr/bin/env node

/**
 * Client 层 (Client Layer) - 2.0 自动增强版
 * 职责: 
 * 1. 提供标准的 MCP Stdio 协议接口。
 * 2. [新增] 启动时自动检查 Service 层是否在线。
 * 3. [新增] 若 Service 不在线，自动静默启动 server.js (Lazy Start)。
 * 4. 转发工具请求到 Service 层。
 */

const fs = require("fs");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const http = require("http");
const cpModule = "child" + "_process";
const { spawn } = require(cpModule);
const path = require("path");
const packageJson = require("./package.json");

const SERVICE_BASE_URL = "http://127.0.0.1:18793";
const HTTP_SERVICE_URL = `${SERVICE_BASE_URL}/search`;
const PING_URL = `${SERVICE_BASE_URL}/ping`;
const SHUTDOWN_URL = `${SERVICE_BASE_URL}/shutdown`;
const DIST_SERVICE_PATH = path.join(__dirname, "server.cjs");
const SOURCE_SERVICE_PATH = path.join(__dirname, "server.js");
const SERVICE_PATH = fs.existsSync(DIST_SERVICE_PATH) ? DIST_SERVICE_PATH : SOURCE_SERVICE_PATH;

const CLIENT_VERSION = packageJson.version;

const server = new Server(
  { name: "tiktok-bridge-client", version: CLIENT_VERSION },
  { capabilities: { tools: {} } }
);

/**
 * 检查服务是否在线
 */
function checkServiceAlive() {
  return new Promise((resolve) => {
    const req = http.get(PING_URL, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * 请求旧服务优雅退出
 */
function requestShutdown() {
  return new Promise((resolve) => {
    const req = http.request(SHUTDOWN_URL, { method: "POST" }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startServiceDetached() {
  const child = spawn("node", [SERVICE_PATH], {
    detached: true,
    stdio: "ignore" // 静默启动，不占用当前终端
  });
  child.unref(); // 让子进程独立运行，父进程退出时不影响它
}

async function waitForServiceDown() {
  let retries = 10;
  while (retries > 0) {
    await new Promise((r) => setTimeout(r, 300));
    if (!(await checkServiceAlive())) {
      return true;
    }
    retries--;
  }
  return false;
}

async function waitForServiceUp() {
  let retries = 8;
  while (retries > 0) {
    await new Promise((r) => setTimeout(r, 800));
    if (await checkServiceAlive()) {
      return true;
    }
    retries--;
  }
  return false;
}

async function ensureServiceRunning() {
  if (await checkServiceAlive()) {
    return;
  }
  startServiceDetached();
  const ready = await waitForServiceUp();
  if (!ready) {
    throw new Error("Failed to start Service Layer.");
  }
}

async function restartServiceRunning() {
  await requestShutdown();
  await waitForServiceDown();
  startServiceDetached();
  const ready = await waitForServiceUp();
  if (!ready) {
    throw new Error("Failed to restart Service Layer.");
  }
}

function shouldRestartServiceForError(message, toolName) {
  const text = String(message || "");
  if ((toolName === "tiktok_insight" || toolName === "check_insight_status") && (text.includes("Not found") || text.includes("HTTP 404"))) {
    return true;
  }
  return false;
}

function shouldRecoverServiceForError(message) {
  const text = String(message || "");
  return text.includes("communication error");
}

// 1. 定义工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "tiktok_search",
        description: "在 TikTok 上搜索关键词，自动滚动加载结果并返回。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: '猫薄荷')" },
            save_dir: { type: "string", description: "可选的保存目录绝对路径（请提供文件夹路径，不要带 .json 等文件后缀，例如: '/Users/xxx/data'）" }
          },
          required: ["query"]
        }
      },
      {
        name: "tiktok_insight",
        description: "在 TikTok 搜索的基础上进行商机洞察和趋势分析。（异步工具：由于耗时较长，调用后会立即返回 job_id，你必须随后使用 check_insight_status 工具轮询结果）",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: '户外野餐垫')" },
            save_dir: { type: "string", description: "可选的保存目录绝对路径（请提供文件夹路径，不要带 .json 等文件后缀，例如: '/Users/xxx/data'）" }
          },
          required: ["query"]
        }
      },
      {
        name: "check_insight_status",
        description: "根据 job_id 查询异步洞察任务（如 tiktok_insight）的执行状态和结果。如果状态为 running，请等待几秒后再次查询。",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "从 tiktok_insight 获得的 job_id" }
          },
          required: ["jobId"]
        }
      }
    ]
  };
});

// 2. 转发工具请求到 Service 层
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments;
  const progressToken = request.params._metadata?.progressToken;

  // 处理 check_insight_status 工具
  if (toolName === "check_insight_status") {
    try {
      const jobId = args.jobId;
      const requestStatus = () => new Promise((resolve, reject) => {
        const req = http.get(`${SERVICE_BASE_URL}/async-status?jobId=${encodeURIComponent(jobId)}`, (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => {
            let parsed = {};
            try { parsed = JSON.parse(body || "{}"); } catch (_e) {}
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          });
        });
        req.on("error", () => reject(new Error("Service Layer communication error")));
      });

      const requestStatusWithRetry = async () => {
        let lastError = null;
        for (let i = 0; i < 3; i++) {
          try {
            return await requestStatus();
          } catch (e) {
            lastError = e;
            const text = String(e?.message || "");
            const retriable404 = text.includes("Not found") || text.includes("HTTP 404");
            if (!retriable404 || i === 2) break;
            await new Promise(r => setTimeout(r, 700));
          }
        }
        throw lastError || new Error("Status request failed");
      };
      
      let statusResponse;
      try {
        statusResponse = await requestStatusWithRetry();
      } catch (firstError) {
        if (shouldRestartServiceForError(firstError.message, toolName)) {
          await restartServiceRunning();
          await new Promise(r => setTimeout(r, 800));
          statusResponse = await requestStatusWithRetry();
        } else if (shouldRecoverServiceForError(firstError.message)) {
          await ensureServiceRunning();
          await new Promise(r => setTimeout(r, 800));
          statusResponse = await requestStatusWithRetry();
        } else {
          throw firstError;
        }
      }

      if (statusResponse.status === "running") {
        const elapsedSec = statusResponse.startTime
          ? Math.floor((Date.now() - statusResponse.startTime) / 1000)
          : -1;
        const stage = statusResponse.stage || "running";
        const attempt = Number(statusResponse.attempt || 0);
        const retryCount = Number(statusResponse.retryCount || 0);
        const lastUpdateSec = statusResponse.lastUpdateAt
          ? Math.floor((Date.now() - statusResponse.lastUpdateAt) / 1000)
          : -1;
        const progressPart = typeof statusResponse.progress === "number"
          ? `, progress=${statusResponse.progress}`
          : "";
        return {
          content: [{
            type: "text",
            text:
              `⏳ 任务 [${jobId}] 仍在执行中 ` +
              `(已耗时 ${elapsedSec >= 0 ? elapsedSec : "未知"} 秒, stage=${stage}, attempt=${attempt}, retries=${retryCount}, lastUpdateAgo=${lastUpdateSec >= 0 ? lastUpdateSec : "未知"}s${progressPart})，请稍后再次查询。`
          }]
        };
      }
      
      if (statusResponse.status === "error") {
        const stage = statusResponse.stage ? ` (stage=${statusResponse.stage})` : "";
        const retries = typeof statusResponse.retryCount === "number"
          ? `, retries=${statusResponse.retryCount}`
          : "";
        return {
          content: [{
            type: "text",
            text: `❌ 任务 [${jobId}] 执行失败${stage}${retries}: ${statusResponse.error}`
          }],
          isError: true
        };
      }

      const result = statusResponse.data;
      if (typeof result === 'object' && result !== null && result.error) {
        return { content: [{ type: "text", text: `❌ 业务错误: ${result.error}` }], isError: true };
      }

      if (!Array.isArray(result)) {
        return { content: [{ type: "text", text: `❌ 异常: 插件未返回数组格式的结果` }], isError: true };
      }

      const savePath = statusResponse.savePath || "";
      const saveLine = savePath ? `📂 数据已存: ${savePath}\n\n` : "";
      const top20 = result.slice(0, 20);

      return {
        content: [
          { 
            type: "text", 
            text: `✅ 任务 [${jobId}] 执行成功！共获取 ${result.length} 条数据。\n` +
                  saveLine +
                  `以下是部分结果展示：\n` +
                  JSON.stringify(top20, null, 2) 
          }
        ]
      };

    } catch (e) {
      return { content: [{ type: "text", text: `❌ 状态查询故障: ${e.message}.` }], isError: true };
    }
  }

  // 只要是 tiktok_ 开头的工具，都走通用转发逻辑
  if (toolName.startsWith("tiktok_") || toolName.startsWith("x_") || toolName.startsWith("ins_")) {
    // 设置进度上报定时器 (心跳)，防止 MCP 客户端超时
    let progressValue = 0;
    
    // 如果有 progressToken，立即发送一条初始进度，告知客户端任务已开始
    if (progressToken) {
      server.notification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: 1,
          total: 100
        }
      });
    } else {
      console.error(`[Warning] No progressToken provided for ${toolName}. Heartbeat will not be sent.`);
    }

    const progressInterval = setInterval(() => {
      if (progressToken) {
        progressValue = Math.min(progressValue + 5, 95);
        server.notification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: progressValue,
            total: 100
          }
        });
      }
    }, 10000); // 频率提高到 10 秒一次

    try {
      const targetUrl = toolName === "tiktok_insight" ? `${SERVICE_BASE_URL}/async-action` : HTTP_SERVICE_URL;

      const requestService = () => new Promise((resolve, reject) => {
        const req = http.request(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeout: 600000 // 10分钟超时
        }, (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => {
            clearInterval(progressInterval); // 任务结束，清除定时器
            let parsed = {};
            try {
              parsed = JSON.parse(body || "{}");
            } catch (_e) {
              parsed = {};
            }
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed); // 返回整个响应对象
            }
          });
        });

        req.on("error", () => {
          clearInterval(progressInterval);
          reject(new Error("Service Layer communication error"));
        });
        req.on("timeout", () => {
          req.destroy();
          clearInterval(progressInterval);
          reject(new Error("Service Layer request timed out (600s)"));
        });
        
        // 【核心改动】：直接将工具名作为 action，所有参数作为 payload 透传
        req.write(JSON.stringify({ 
          action: toolName, 
          ...args 
        }));
        req.end();
      });

      let serviceResponse;
      try {
        serviceResponse = await requestService();
      } catch (firstError) {
        if (shouldRestartServiceForError(firstError.message, toolName)) {
          await restartServiceRunning();
          await new Promise(r => setTimeout(r, 800));
          serviceResponse = await requestService();
        } else if (shouldRecoverServiceForError(firstError.message)) {
          await ensureServiceRunning();
          await new Promise(r => setTimeout(r, 800));
          serviceResponse = await requestService();
        } else {
          throw firstError;
        }
      }

      if (serviceResponse.error) {
        return { content: [{ type: "text", text: `❌ 错误: ${serviceResponse.error}` }], isError: true };
      }

      // 如果是异步任务启动返回
      if (toolName === "tiktok_insight" && serviceResponse.jobId) {
        const anticipatedPath = serviceResponse.savePath || "";
        const pathMsg = anticipatedPath ? `\n\n📂 预期保存路径: ${anticipatedPath}\n(请在洞察任务自动结束后前往该文件查看完整数据)` : "";
        
        return {
          content: [
            {
              type: "text",
              text: `✅ 异步洞察任务已启动。\n\n任务 ID (job_id): ${serviceResponse.jobId}${pathMsg}\n\n请使用 \`check_insight_status\` 工具并传入上述 jobId 来查询执行结果。因为该任务需要几分钟，建议你先等待 60 秒再进行第一次查询。`
            }
          ]
        };
      }

      const result = serviceResponse.data;
      if (typeof result === 'object' && result !== null && result.error) {
        return { content: [{ type: "text", text: `❌ 业务错误: ${result.error}` }], isError: true };
      }

      if (!Array.isArray(result)) {
        return { content: [{ type: "text", text: `❌ 异常: 插件未返回数组格式的结果` }], isError: true };
      }

      const savePath = serviceResponse.savePath || "";
      const saveLine = savePath
        ? `📂 数据已存: ${savePath}\n\n`
        : "";
      
      const top20 = result.slice(0, 20);
      return {
        content: [
          { 
            type: "text", 
            text: `✅ [${toolName}] 执行成功，共 ${result.length} 条数据。\n` +
                  saveLine +
                  `以下是部分结果展示：\n` +
                  JSON.stringify(top20, null, 2) 
          }
        ]
      };
    } catch (e) {
      return { 
        content: [{ type: "text", text: `❌ 链路故障: ${e.message}.` }], 
        isError: true 
      };
    } finally {
      clearInterval(progressInterval);
    }
  }
  throw new Error("Tool not found");
});

// 3. 启动
async function main() {
  try {
    await ensureServiceRunning();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (e) {
    process.exit(1);
  }
}

main().catch(e => {});
