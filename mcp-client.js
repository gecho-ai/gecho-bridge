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
const SUPPORTED_TOOL_NAMES = new Set([
  "tiktok_search",
  "tiktok_insight",
  "check_insight_status",
  "tiktok_influencer",
  "tiktok_shop_search",
  "tiktok_product",
  "x_search",
  "x_post_detail",
  "amazon_search",
  "amazon_product",
  "amazon_reviews"
]);

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
  if ((toolName === "tiktok_insight" || toolName === "tiktok_influencer" || toolName === "check_insight_status") && (text.includes("Not found") || text.includes("HTTP 404"))) {
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
            targetCount: { type: "number", description: "预期采集的数量，默认 100", default: 100 },
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
      },
      {
        name: "tiktok_influencer",
        description: "获取指定 TikTok 达人主页发布的所有视频 data。(同步工具：会自动滚动采集并直接返回结果，建议 targetCount 不超过 500)",
        inputSchema: {
          type: "object",
          properties: {
            uniqueId: { type: "string", description: "达人的 unique_id (例如: 'zachking')" },
            targetCount: { type: "number", description: "预期采集的视频数量，默认 100", default: 100 }
          },
          required: ["uniqueId"]
        }
      },
      {
        name: "tiktok_shop_search",
        description: "在 TikTok Shop 中搜索关键词，获取返回的所有商品信息。支持自动下滑获取更多数据。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: 'lulu clothes')" },
            targetCount: { type: "number", description: "预期获取的商品数量，默认 100，设为更高值以获取更多数据", default: 100 },
            save_dir: { type: "string", description: "可选的保存目录绝对路径（请提供文件夹路径，不要带 .json 等文件后缀，例如: '/Users/xxx/data'）" }
          },
          required: ["query"]
        }
      },
      {
        name: "tiktok_product",
        description: "获取 TikTok Shop 商品详情页的完整数据（标题、价格、SKU、描述、销量、评价等）。",
        inputSchema: {
          type: "object",
          properties: {
            product_url: { type: "string", description: "商品详情页 URL 或 商品 ID (例如: '1731523855832879280' 或 'https://shop.tiktok.com/us/pdp/...') " },
            save_dir: { type: "string", description: "可选的保存目录绝对路径" }
          },
          required: ["product_url"]
        }
      },
      {
        name: "x_search",
        description: "在 X (Twitter) 上搜索关键词，采集推文内容、互动数及作者信息。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: 'trump')" },
            targetCount: { type: "number", description: "预期采集的推文数量，默认 100", default: 100 },
            save_dir: { type: "string", description: "可选的保存目录绝对路径" }
          },
          required: ["query"]
        }
      },
      {
        name: "x_post_detail",
        description: "获取 X (Twitter) 某条推文的详情，包括主推文内容及大量评论。",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "推文详情页 URL (例如: 'https://x.com/user/status/123...')" },
            targetCount: { type: "number", description: "预期采集的评论数量，默认 100", default: 100 },
            save_dir: { type: "string", description: "可选的保存目录绝对路径" }
          },
          required: ["url"]
        }
      },
      {
        name: "amazon_search",
        description: "在 Amazon 上搜索关键词，自动采集多页商品信息（支持自动翻页）。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: 'clothes')" },
            targetPages: { type: "number", description: "预期采集的页数，默认 5 (约100条)", default: 5 },
            save_dir: { type: "string", description: "可选的保存目录绝对路径" }
          },
          required: ["query"]
        }
      },
      {
        name: "amazon_product",
        description: "获取 Amazon 商品详情页的完整数据（标题、价格、描述、变体、规格等）。",
        inputSchema: {
          type: "object",
          properties: {
            product_url: { type: "string", description: "商品详情页 URL 或 ASIN (例如: 'B0CXJJHY8B' 或 'https://www.amazon.com/dp/...') " },
            save_dir: { type: "string", description: "可选的保存目录绝对路径" }
          },
          required: ["product_url"]
        }
      },
      {
        name: "amazon_reviews",
        description: "在 Amazon 专用评论页采集评论，支持多页自动翻页。",
        inputSchema: {
          type: "object",
          properties: {
            product_url: { type: "string", description: "商品详情页 URL 或 ASIN (例如: 'B0CXJJHY8B' 或 'https://www.amazon.com/product-reviews/...') " },
            targetCount: { type: "number", description: "预期采集的评论数量，默认 100", default: 100 },
            save_dir: { type: "string", description: "可选的保存目录绝对路径" }
          },
          required: ["product_url"]
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

  // 只转发已在 ListTools 中公开的官方工具，避免未文档化能力暴露出去
  if (SUPPORTED_TOOL_NAMES.has(toolName) && toolName !== "check_insight_status") {
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
      const isAsyncTool = toolName === "tiktok_insight";
      const targetUrl = isAsyncTool ? `${SERVICE_BASE_URL}/async-action` : HTTP_SERVICE_URL;
      
      process.stderr.write(`[Debug] Requesting ${targetUrl} for ${toolName}\n`);

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

      // console.error(`[Debug] toolName: ${toolName}, jobId: ${serviceResponse.jobId}`);

      process.stderr.write(`[Debug] toolName: ${toolName}, serviceResponse: ${JSON.stringify(serviceResponse)}\n`);

      // 鲁棒性修复：只要 serviceResponse 中包含 jobId，不论什么工具都按异步处理返回给 MCP
      if (serviceResponse.jobId) {
        const anticipatedPath = serviceResponse.savePath || "";
        const actionDesc = toolName === "tiktok_insight" ? "深度洞察任务" : 
                           toolName === "tiktok_influencer" ? "达人采集任务" : "异步采集任务";
        const pathMsg = anticipatedPath ? `\n\n📂 预期保存路径: ${anticipatedPath}\n(请在任务自动结束后前往该文件查看完整数据)` : "";
        
        return {
          content: [
            {
              type: "text",
              text: `✅ ${actionDesc}已启动。\n\n任务 ID (job_id): ${serviceResponse.jobId}${pathMsg}\n\n请使用 \`check_insight_status\` 工具并传入上述 jobId 来查询执行结果。建议你先等待 30-60 秒再进行第一次查询。`
            }
          ]
        };
      }

      // 如果不是异步启动，且响应成功，则校验数据
      const result = serviceResponse.data;
      if (serviceResponse.success && result === undefined) {
         // 针对某些同步接口可能只返回 success: true 的情况 (虽然目前 search 接口通常返回 data)
         return { content: [{ type: "text", text: "✅ 操作执行成功。" }] };
      }

      if (typeof result === 'object' && result !== null && result.error) {
        return { content: [{ type: "text", text: `❌ 业务错误: ${result.error}` }], isError: true };
      }

      if (!Array.isArray(result)) {
        // 如果不是数组也不是异步 jobId，记录更多上下文以便调试
        const rawResponse = JSON.stringify(serviceResponse).slice(0, 200);
        return { 
          content: [{ 
            type: "text", 
            text: `❌ 异常: 插件未返回数组格式的结果。\n工具: ${toolName}\n响应摘要: ${rawResponse}` 
          }], 
          isError: true 
        };
      }

      const savePath = serviceResponse.savePath || "";
      const saveLine = savePath
        ? `📂 数据已存: ${savePath}\n\n`
        : "";
      
      if (toolName === "tiktok_product" && result.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `✅ [${toolName}] 商品详情获取成功！\n` +
                    saveLine +
                    JSON.stringify(result[0], null, 2)
            }
          ]
        };
      }

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
