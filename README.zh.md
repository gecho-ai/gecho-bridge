# Gecho Bridge 🚀

🌐 **Gecho Bridge** 是一款通用的 MCP（Model Context Protocol）工具，旨在为你的大语言模型（LLM）与本地浏览器之间搭建一座桥梁。
安装后，无论是使用 **OpenClaw**、**Hermes** 还是 **Trae**，你的 AI 助手都能直接控制浏览器，自动化完成 TikTok 搜索、数据抓取与深度商机洞察。

---

## ✨ 适合谁用

- 📊 **分析竞品**：输入关键词，快速获取 TikTok 前排高赞视频的各项互动数据。
- 💡 **寻找爆款**：使用深度洞察工具分析特定品类（如 "portable blender"）的流行趋势，捕捉未被满足的市场蓝海。
- 🤖 **自动化运营**：让大模型直接指挥浏览器，自动翻页抓取并生成数据报表，免去繁琐的手动统计。

## 🚀 能做什么

- 自动唤起 Chrome 并在 TikTok 搜索指定关键词，模拟真人自然滚动加载。
- 抓取海量结构化数据（视频 ID、标题、点赞量、播放链接等）并自动安全落盘为 JSON 文件。
- 执行基于大数据检索的**异步深度洞察**，智能提炼爆款趋势与潜在商机。

## 🔗 相关链接

- **官网**：[https://gecho.ai/](https://gecho.ai/)
- **GitHub**：[https://github.com/gecho-ai/gecho-bridge](https://github.com/gecho-ai/gecho-bridge)
- **ClawHub 插件页**：[https://clawhub.ai/p/gecho-ai](https://clawhub.ai/p/gecho-ai)
- **Chrome 浏览器扩展**：[前往 Chrome 网上应用店下载](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)

## 💬 交流与反馈

欢迎加入我们的社区进行交流或反馈问题：

- **Discord 社区**：[点击加入 Discord](https://discord.gg/RFDVZMR6Tn)
- **企业微信群**：扫描下方二维码加入（若图片未显示，请 [点击此处查看二维码](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)）

![企业微信二维码](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)

---

## 📦 安装与配置

本项目基于标准 MCP 协议开发，可以无缝接入任何支持 MCP 的 AI 客户端（如 OpenClaw、Hermes、Trae 等）。

**先说明一个关键点：**
ClawHub 上的 **Skill** 主要提供给大模型的调用指令，本身不是服务端。想要真正搜索 TikTok，你还需要把 `gecho-bridge` MCP 服务配置到客户端里，并安装浏览器扩展。

### 0. 前置环境要求
1. **Node.js**：>= 18（需支持 `npm` / `npx`）。
2. **浏览器扩展**：请先[点击此处安装 Gecho 浏览器扩展](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)。
3. **网络与状态**：确保本地网络可稳定访问 TikTok，并在浏览器中登录账号，登录浏览器扩展。

### 方式一：在 OpenClaw 中一键安装 (ClawHub)
ClawHub 中有两种安装方式：`Skill` 与 `Plugin`。

#### 方案 A：Skill 安装（需先配置 MCP）
如果你安装的是 ClawHub 上的 **Skill**，请注意：**只安装 Skill 页面还不够**。Skill 安装后会通过 MCP 调用执行，因此需要先完成以下 MCP 配置：
```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
```
*配置后，可通过 `openclaw mcp list` 检查状态。*
*完成 MCP 配置后，再回到 ClawHub 使用 Skill 即可。*

#### 方案 B：Plugin 安装（推荐）
```bash
openclaw plugins install clawhub:@gecho-ai/gecho-bridge-bundle
openclaw gateway restart
```
*这是更省心的安装方式。安装完成后，一般不需要再单独配置 Skill 所依赖的 MCP。*
*如需升级已安装的版本，使用 `openclaw plugins update clawhub:@gecho-ai/gecho-bridge-bundle` 即可。*
*插件会在需要时自动启动本地 Gecho Service。如果是先打开了客户端、后打开浏览器扩展，建议再执行一次 `openclaw gateway restart` 重新建立连接。*

### 方式二：在 Hermes 中一键配置 (Hermes Skill Hub)
你可以通过以下命令将服务快捷添加到 Hermes 并重启：
```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"

hermes restart
```
*重启后，可通过 `hermes mcp list` 检查安装状态。*
*仅供参考：如果你的机器已经安装了 Node，但 Hermes 仍提示 `npx` 或 `node` 不存在，这通常是 Hermes 自身 shell/PATH 环境的问题，不是 Gecho Bridge 的问题。在 macOS + Homebrew 下，一个常见绕过方式是改用绝对路径注册 MCP：`hermes mcp add gecho-bridge --command /opt/homebrew/bin/npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"`，然后执行 `hermes restart`。*

### 方式三：在 Trae / Claude Desktop 等通用客户端配置
在支持手动配置的 MCP 客户端中，打开对应的 `mcp.json` 或 `claude_desktop_config.json` 文件，添加如下节点：
```json
{
  "mcpServers": {
    "gecho-bridge": {
      "command": "npx",
      "args": ["-y", "@gecho-ai/gecho-bridge@latest"]
    }
  }
}
```

### 方式四：在 Claude Code 中一键配置
你可以通过以下命令将服务快捷添加到 Claude Code 中：
```bash
claude mcp add gecho-bridge -- npx -y @gecho-ai/gecho-bridge@latest
```
- 默认情况下，该配置保存在**项目级别**（`.claude/settings.json`）。
- 可以添加 `--scope user` 使其对所有项目生效，或使用 `--scope local` 仅在当前目录生效。
- 添加完成后，使用 `claude mcp list` 验证服务是否注册成功。
- 如果 MCP 工具没有立即出现，请重启 Claude Code。

---

## 🏁 快速开始与常见流程

环境配置完毕并重启 AI 客户端后，你可以直接通过自然语言向 AI 下达指令。

### ✅ 首次使用前自检
1. 已配置 `gecho-bridge` MCP，或已安装 `@gecho-ai/gecho-bridge-bundle` Plugin。
2. 已安装 [Gecho 浏览器扩展](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)。
3. Chrome 中已打开 TikTok 并登录账号。
4. Gecho 扩展已登录并处于在线状态，TikTok 页面未卡住或未停在验证码页面。

### 🔍 基础搜索 (`tiktok_search`)
适用于快速检索和收集视频数据。
**你可以这样说：**
- *"帮我搜索 TikTok 关键词 'portable blender'，返回点赞最高的前 10 条"*
- *"搜索 'cat toy'，并把完整结果保存到 /Users/yourname/gecho-data"*

**执行流程：**
1. AI 唤起本地浏览器的 Gecho 扩展进行搜索和自动滚动。
2. 抓取完成后，海量数据会自动落盘到本地。
3. AI 会在会话中为你精简总结前 20 条高赞结果。

### 📈 深度洞察 (`tiktok_insight`)
适用于品类调研和趋势分析。
**你可以这样说：**
- *"请对 'outdoor picnic mat' 做 tiktok_insight 分析"*
- *"对比 'desk setup' 和 'minimal desk' 的热视频风格与互动量"*

**执行流程：**
1. 插件会下发异步洞察任务，并立即返回一个 `jobId`。
2. **⚠️ 注意**：洞察分析涉及深度抓取和 AI 运算，耗时通常会**超过 5 分钟**。在执行期间，**请务必不要关闭浏览器插件或相关的 TikTok 页面**。
3. 等待一段时间后，对 AI 说：*“用 check_insight_status 查询刚才任务的执行状态”* 来获取最终的分析报告。
4. 如果返回 `running`，说明任务还在处理，请继续等待后再次查询。

---

## ⚙️ 存储配置

为了更好地管理数据资产，抓取的海量结果需要落盘保存。插件支持以下优先级配置方式：

1. **会话级（最高优先级）**：直接在对话时让 AI 指定 `save_dir`（必须为绝对路径）。
2. **全局级**：配置环境变量 `GECHO_DATA_DIR` 来指定默认的数据保存目录。
3. **默认回退**：若未指定，默认保存在工具自带的 `./data` 目录下。

*(注：所有保存的文件名均会自动进行安全化处理，避免非法字符导致写入失败。)*

---

## 🛠️ 排障指南

### 1. 如何确认插件已加载？（以 OpenClaw 为例）
执行：
```bash
openclaw plugins info @gecho-ai/gecho-bridge-bundle
```
如果安装成功，你应看到 `Status: loaded` 以及 `MCP servers: gecho-tiktok-search`。

### 2. 关于本地后台服务的说明
- Gecho Bridge 会在需要时自动拉起本地服务，用来让 MCP 客户端和浏览器扩展通信。
- 这个服务只监听 `127.0.0.1`，在你使用插件期间保持可用属于正常行为。
- 如果你重启了 Chrome 或扩展，随后请求开始失败，先执行一次 `openclaw gateway restart`，再重试。

### 3. 报错：提示扩展未连接
- 检查 Chrome 浏览器中的 Gecho 扩展是否已开启。
- 确认当前浏览器环境中已登录 TikTok 账号，且 TikTok 页面未处于崩溃或无响应状态。

### 4. 报错：请求超时
- 检查 TikTok 页面是否弹出了人机验证码（CAPTCHA），如果是，请手动滑动解决。
- 若目标关键词本身结果极少或网络卡顿，可尝试更换更具体的关键词后重试。

### 5. 报错：无法保存结果
- 检查你让 AI 指定的 `save_dir` 是否为合法的绝对路径。
- 确认当前系统用户是否具有该目标目录的写入权限。

---

## 🧑‍💻 本地开发

对于希望基于本工具进行二次开发的开发者：
```bash
git clone https://github.com/gecho-ai/bridge.git
cd bridge
npm install
npm run server
```

**双层架构说明：**
- **Client 层** (`mcp-client.js`)：标准 MCP STDIO 接入层，负责与 OpenClaw/Hermes/Trae 等客户端通信，并声明 Tools 规范。
- **Service 层** (`server.js`)：本地常驻服务层，负责与浏览器扩展通过 WebSocket 通信，执行实际抓取与落盘。（支持 Lazy Start 机制，仅在需要时自动拉起）。

## License

MIT
