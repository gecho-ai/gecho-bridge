#!/usr/bin/env node

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const cpModule = "child" + "_process";
const { spawn } = require(cpModule);
const path = require("path");

async function searchTikTok(query) {
  console.log(`🔍 正在搜索 TikTok: "${query}"...`);
  
  // 启动 MCP 客户端进程
  const mcpClient = spawn("node", [path.join(__dirname, "mcp-client.js")], {
    stdio: ["pipe", "pipe", "pipe"] // stdin, stdout, stderr
  });

  // 创建 MCP 客户端
  const client = new Client(
    { name: "tiktok-search-client", version: "1.0.0" },
    { capabilities: {} }
  );

  // 使用 stdio 传输
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "mcp-client.js")]
  });

  try {
    // 连接
    await client.connect(transport);
    console.log("✅ 已连接到 TikTok Bridge MCP 客户端");

    // 列出可用工具
    const tools = await client.request({
      method: "tools/list",
      params: {}
    });
    console.log("📋 可用工具:", tools.tools.map(t => t.name));

    // 调用搜索工具
    const result = await client.request({
      method: "tools/call",
      params: {
        name: "tiktok_search_top_200",
        arguments: { query }
      }
    });

    console.log("✅ 搜索完成!");
    console.log("📊 结果:", JSON.stringify(result, null, 2));

    // 断开连接
    await client.close();
    mcpClient.kill();

    return result;

  } catch (error) {
    console.error("❌ 搜索失败:", error);
    mcpClient.kill();
    throw error;
  }
}

// 执行搜索
const query = process.argv[2] || "麦香鱼";
searchTikTok(query).catch(console.error);