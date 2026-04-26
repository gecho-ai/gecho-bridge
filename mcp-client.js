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
const cpModule = "child" + "_process";
const { spawn } = require(cpModule);
const path = require("path");

const SERVICE_BASE_URL = "http://127.0.0.1:18793";
const HTTP_SERVICE_URL = `${SERVICE_BASE_URL}/search`;
const PING_URL = `${SERVICE_BASE_URL}/ping`;
const SHUTDOWN_URL = `${SERVICE_BASE_URL}/shutdown`;
const SERVICE_PATH = path.join(__dirname, "server.js");

const server = new Server(
  { name: "tiktok-bridge-client", version: "1.1.1" },
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

/**
 * 启动即接管：每次启动 MCP 时先尝试关闭旧服务，再拉起当前服务
 */
async function ensureServiceRunning() {
  await requestShutdown();
  await waitForServiceDown();
  startServiceDetached();
  const ready = await waitForServiceUp();
  if (!ready) {
    throw new Error("Failed to start Service Layer.");
  }
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
            save_dir: { type: "string", description: "可选的保存目录绝对路径 (例如: '/Users/xxx/data')" }
          },
          required: ["query"]
        }
      },
      {
        name: "tiktok_insight",
        description: "在 TikTok 搜索的基础上进行商机洞察和趋势分析。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词 (例如: '户外野餐垫')" },
            save_dir: { type: "string", description: "可选的保存目录绝对路径 (例如: '/Users/xxx/data')" }
          },
          required: ["query"]
        }
      }
    ]
  };
});

// 2. 转发工具请求到 Service 层
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments;

  // 只要是 tiktok_ 开头的工具，都走通用转发逻辑
  if (toolName.startsWith("tiktok_") || toolName.startsWith("x_") || toolName.startsWith("ins_")) {
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
              resolve(parsed); // 返回整个响应对象
            }
          });
        });

        req.on("error", () => reject(new Error("Service Layer communication error")));
        
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
        if (String(firstError.message || "").includes("communication error")) {
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
