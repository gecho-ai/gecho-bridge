#!/usr/bin/env node

// 🐷 1.1 MCP 标准格式: 引入 MCP SDK 核心类。StdioServerTransport 是最通用的通信方式。
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");

// 🐷 1.2 桥接技术栈: 引入 WebSocketServer，用于与 Chrome 扩展建立双向通信。
const { WebSocketServer } = require("ws");

// 🐷 1.3 桥接逻辑: 初始化 WebSocket 服务器变量。
const WS_PORT = 18792;
let extensionSocket = null;
let wss = null;

// 🐷 1.4 改造点: 增加一个 Map 来存储等待中的请求回调，实现“请求-响应”模式。
// 参考了 mcp-chrome-bridge/dist/native-messaging-host.js [L114] 的设计。
const pendingRequests = new Map();
let requestIdCounter = 1;

/**
 * 🐷 1.4.1 异步等待插件连接的辅助函数
 * 逻辑: 每隔 500ms 检查一次 extensionSocket，最多等待 timeoutMs。
 * 解决问题: MCP 启动瞬间插件可能还在重连空窗期。
 */
async function waitForExtension(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (extensionSocket && extensionSocket.readyState === 1) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function initWss() {
  if (wss) return wss;
  
  wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
  
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ 错误: 端口 ${WS_PORT} 已被占用!`);
      console.error(`这通常是因为另一个 tiktok_bridge 进程正在运行。`);
      console.error(`请执行以下命令清理残留进程后重试:`);
      console.error(`lsof -i :${WS_PORT} | grep LISTEN | awk '{print $2}' | xargs kill -9\n`);
    } else {
      console.error("WebSocket Server Error:", err);
    }
    process.exit(1);
  });

  wss.on("connection", (ws) => {
    console.error("Chrome Extension connected to Bridge!");
    extensionSocket = ws;

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        
        // 🐷 监控所有来自插件的消息
        const method = data.method || data.action || "unknown";
        const requestId = data.requestId || data.id || "no-id";
        console.error(`🐷 [BRIDGE_RECEIVE_RAW] 收到原始消息. Method: ${method}, ID: ${requestId}`);

        // 🐷 5.1 响应处理: 处理 execute_action 的回传结果
        if (method === "search_result" || method === "SEARCH_RESULT_DATA" || method === "action_result") {
          // 兼容多种数据包装格式
          const finalData = data.params || data.data || (data.method ? data : null);
          
          if (requestId && pendingRequests.has(requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(requestId);
            clearTimeout(timeoutId);
            pendingRequests.delete(requestId);
            
            console.error(`🐷 [BRIDGE_SUCCESS] 成功匹配 RequestId: ${requestId}, 准备返回给 MCP`);
            resolve(finalData);
          } else {
            console.error(`🐷 [BRIDGE_MISMATCH] 收到数据但无法匹配 RequestId: ${requestId}`);
          }
        }
      } catch (e) {
        console.error("🐷 [BRIDGE_ERROR] 解析插件消息失败:", e);
      }
    });

    ws.on("close", () => {
      console.error("Chrome Extension disconnected.");
      extensionSocket = null;
    });
  });
  return wss;
}

// 🐷 2.1 MCP 标准格式: 创建 MCP Server 实例，定义服务器名称和版本。
const server = new Server(
  {
    name: "tiktok-bridge",
    version: "1.0.0",
  },
  {
    capabilities: {
      // 🐷 2.2 MCP 标准格式: 声明支持“工具 (Tools)”功能。
      tools: {},
    },
  }
);

// 🐷 3.1 Skills 标准格式: 定义工具列表。这是 AI 模型能理解的“技能”描述。
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        // 🐷 3.2 Skills 标准格式: 工具名称和描述。
        name: "tiktok_search_top_200",
        description: "在 TikTok 上搜索关键词，自动滚动加载至少 200 条结果，并全部返回。",
        // 🐷 3.3 Skills 标准格式: 输入参数 Schema。
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词 (例如: '猫薄荷')"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "tiktok_shop_search",
        description: "在 TikTok Shop 中搜索关键词，获取返回的所有商品信息。支持自动下滑获取更多数据。",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词 (例如: 'lulu clothes')"
            },
            targetCount: {
              type: "number",
              description: "预期获取的商品数量，默认 500，设为更高值以获取更多数据",
              default: 500
            }
          },
          required: ["query"]
        }
      }
    ]
  };
});

// 🐷 4.1 MCP 标准格式: 处理具体的工具调用请求。
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  if (toolName === "tiktok_search_top_200" || toolName === "tiktok_shop_search") {
    const { query } = request.params.arguments;
    const action = toolName === "tiktok_shop_search" ? "tiktok_shop_search" : "search";

    // 🐷 4.2 桥接逻辑: 参考 mcp-chrome-bridge/dist/server/index.js [L48] 的逻辑，先确保连接就绪。
    // 增加 10s 的异步等待窗口，防止插件重连期间直接报错。
    const isConnected = await waitForExtension(10000);
    if (!isConnected) {
      return {
        content: [{ type: "text", text: "错误: Chrome 插件未连接，请确保插件已开启并显示 ON。" }],
        isError: true
      };
    }

    // 🐷 4.3 改造点: 发送带 requestId 的指令并等待插件回传。
    // 参考了 mcp-chrome-bridge/dist/native-messaging-host.js [L114] 的设计。
    const result = await new Promise((resolve, reject) => {
      const requestId = `mcp-${Date.now()}-${requestIdCounter++}`;
      
      console.error(`🐷 [BRIDGE_CALL] 发送指令: ${action}, ID: ${requestId}. 正在等待插件响应...`);
      
      const timeoutId = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          console.error(`❌ [BRIDGE_TIMEOUT] 响应超时 (30s). ID: ${requestId}`);
          resolve({ error: "抓取超时 (30s)，请检查浏览器是否已停止滚动或查看控制台日志" });
        }
      }, 30000); // 🐷 进一步缩短到 30 秒，与用户预期一致

      pendingRequests.set(requestId, { resolve, reject, timeoutId });

      const payload = {
        method: "execute_action",
        params: { action: action, params: { query } },
        requestId: requestId // 🐷 关键: 发送请求 ID
      };
      extensionSocket.send(JSON.stringify(payload));
    });

    // 🐷 4.5 改造点: 将抓取到的 200+ 条完整数据持久化存储到本地文件夹
    let savedPath = "";
    if (Array.isArray(result) && result.length > 0) {
      const dataDir = path.join(__dirname, "..", "data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      // 1. 生成固定文件名 (适配 OpenClaw 预期)
      const prefix = toolName === "tiktok_shop_search" ? "shop_" : "";
      const fixedFilename = `${prefix}${query}_search_results.json`;
      const fixedPath = path.join(dataDir, fixedFilename);
      fs.writeFileSync(fixedPath, JSON.stringify(result, null, 2), "utf8");
      
      // 2. 生成带时间戳的备份
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFilename = `${prefix}${query}_${timestamp}.json`;
      const backupPath = path.join(dataDir, backupFilename);
      fs.writeFileSync(backupPath, JSON.stringify(result, null, 2), "utf8");
      
      savedPath = fixedPath;
      console.error(`🐷 数据已保存至: ${fixedPath} (备份: ${backupFilename})`);
    }

    // 🐷 4.6 MCP 标准格式: 返回抓取到的前 20 条高赞视频给 AI，并告知存储路径。
    const top20 = Array.isArray(result) ? result.slice(0, 20) : [];
    const dataType = toolName === "tiktok_shop_search" ? "商品" : "视频";
    
    return {
      content: [
        { 
          type: "text", 
          text: `✅ 抓取完成！共获取 ${Array.isArray(result) ? result.length : 0} 条${dataType}数据。\n` +
                `📂 原始数据已存储至: ${savedPath}\n\n` +
                `以下是销量/热度最高的前 20 条结果：\n` +
                JSON.stringify(top20, null, 2) 
        }
      ]
    };
  }

  throw new Error("Tool not found");
});

// 🐷 5.1 启动模式检测: 支持 MCP 模式和 CLI 直接调用模式
// 参考了 mcp-chrome-bridge/dist/cli.js 的思路，支持多模式启动。
async function run() {
  const args = process.argv.slice(2);
  let toolName = "";
  let query = "cat";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tool" && i + 1 < args.length) {
      toolName = args[i + 1];
      i++;
    } else if (args[i] === "--query" && i + 1 < args.length) {
      query = args[i + 1];
      i++;
    } else if (i === 0 && !args[i].startsWith("--")) {
      toolName = args[i];
    } else if (i === 1 && !args[i].startsWith("--")) {
      query = args[i];
    }
  }

  const isCliMode = toolName === "tiktok_search_top_200" || toolName === "search";

  if (isCliMode) {
    // 🐷 CLI 模式: 简化后的逻辑，复用 pendingRequests。
    console.error(`🐷 CLI 模式启动: 正在搜索 [${query}]...`);
    initWss();
    
    // 等待插件连接
    const isConnected = await waitForExtension(15000);
    if (!isConnected) {
      console.error("❌ 错误: 插件未连接，请确保插件已开启。");
      process.exit(1);
    }

    const requestId = `cli-${Date.now()}`;
    const result = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve({ error: "抓取超时 (300s)" });
      }, 300000);

      pendingRequests.set(requestId, { resolve, timeoutId });

      extensionSocket.send(JSON.stringify({
        method: "execute_action",
        params: { action: "search", params: { query } },
        requestId: requestId
      }));
    });

    // 保存结果并退出
    if (Array.isArray(result)) {
      const dataDir = path.join(__dirname, "..", "data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const filePath = path.join(dataDir, `${query}_search_results.json`);
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
      console.error(`🐷 数据已保存至: ${filePath}`);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.error("❌ 抓取失败:", result.error || "未知错误");
    }
    process.exit(0);
  } else {
    // 🐷 标准 MCP 模式 (STDIO)
    initWss();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🐷 TikTok Bridge MCP Server 已启动 (STDIO 模式)");
  }
}

// 🐷 修改后的启动入口
run().catch((error) => {
  console.error("Status: Error");
  console.error("Error details:", error);
  process.exit(1);
});
