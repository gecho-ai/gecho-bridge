#!/usr/bin/env node

/**
 * Client 层 (Client Layer) - 2.0 自动增强版
 * 职责: 
 * 1. 提供标准的 MCP Stdio 协议接口。
 * 2. [新增] 启动时自动检查 Service 层是否在线。
 * 3. [新增] 若 Service 不在线，自动静默启动 server.js (Lazy Start)。
 * 4. 转发工具请求到 Service 层。
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const HTTP_SERVICE_URL = "http://127.0.0.1:18793/search";
const SERVICE_PATH = path.join(__dirname, "server.js");

const server = new Server(
  { name: "tiktok-bridge-client", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

/**
 * 检查服务是否在线
 */
function checkServiceAlive() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:18793/ping", (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * 自动拉起 Service 层
 */
async function ensureServiceRunning() {
  const alive = await checkServiceAlive();
  if (alive) {
    console.error("🐷 Service Layer is already running.");
    return;
  }

  console.error("🐷 Service Layer not found. Starting it automatically...");
  
  const child = spawn("node", [SERVICE_PATH], {
    detached: true,
    stdio: "ignore" // 静默启动，不占用当前终端
  });

  child.unref(); // 让子进程独立运行，父进程退出时不影响它

  // 等待服务启动成功
  let retries = 5;
  while (retries > 0) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkServiceAlive()) {
      console.error("✅ Service Layer started successfully.");
      return;
    }
    retries--;
  }
  throw new Error("Failed to start Service Layer after 5s.");
}

// 1. 定义工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "tiktok_search_top_200",
        description: "在 TikTok 上搜索关键词，自动滚动加载至少 200 条结果，并全部返回。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: '猫薄荷')" }
          },
          required: ["query"]
        }
      }
    ]
  };
});

// 2. 转发工具请求到 Service 层
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "tiktok_search_top_200") {
    const { query } = request.params.arguments;

    try {
      const requestService = () => new Promise((resolve, reject) => {
        const req = http.request(HTTP_SERVICE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        }, (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => {
            let parsed = {};
            try {
              parsed = JSON.parse(body || "{}");
            } catch (_e) {
              parsed = {};
            }
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed.data);
            }
          });
        });

        req.on("error", () => reject(new Error("Service Layer communication error")));
        req.write(JSON.stringify({
          query,
          query_b64: Buffer.from(String(query), "utf8").toString("base64")
        }));
        req.end();
      });

      let result;
      try {
        result = await requestService();
      } catch (firstError) {
        if (String(firstError.message || "").includes("communication error")) {
          await ensureServiceRunning();
          await new Promise(r => setTimeout(r, 800));
          result = await requestService();
        } else {
          throw firstError;
        }
      }

      if (result.error) {
        return { content: [{ type: "text", text: `❌ 错误: ${result.error}` }], isError: true };
      }

      const top20 = Array.isArray(result) ? result.slice(0, 20) : [];
      return {
        content: [
          { 
            type: "text", 
            text: `✅ 抓取完成！共获取 ${Array.isArray(result) ? result.length : 0} 条数据。\n` +
                  `📂 完整结果已保存在本地 data 目录。\n\n` +
                  `以下是点赞最高的前 20 条结果：\n` +
                  JSON.stringify(top20, null, 2) 
          }
        ]
      };
    } catch (e) {
      return { 
        content: [{ type: "text", text: `❌ 转发失败: ${e.message}.` }], 
        isError: true 
      };
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
    console.error("🐷 TikTok Bridge MCP Client is running (STDIO)");
  } catch (e) {
    console.error(`❌ Client initialization failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
