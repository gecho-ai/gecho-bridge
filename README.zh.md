# Gecho Bridge 🚀

**Gecho Bridge 通过 MCP 和 Gecho Chrome 扩展，把 OpenClaw、Hermes、Trae、Claude Code 等 AI 客户端连接到真实 Chrome 浏览器。** 你可以用它搜索 TikTok 视频、采集结构化元数据、保存 JSON 结果，并运行异步的产品、趋势、竞品和内容洞察工作流。

## ⚠️ 重要前置：使用前必看

Gecho Bridge 不能只靠 README、Skill 页面或 MCP 配置单独运行。首次搜索 TikTok 或运行洞察任务前，必须同时满足下面 3 个条件：

1. **在 AI 客户端中配置 Gecho Bridge MCP**。
2. **安装 Gecho Chrome 扩展**，并在扩展中登录 Gecho 账号。
3. **在 Chrome 中登录 TikTok 网页版**，并保持已登录的 TikTok 标签页打开。

如果任一条件缺失，即使 Skill 或 Plugin 已安装，TikTok 搜索和洞察功能也可能无法正常运行。

## 🚀 3 步快速上手

### 第一步：安装 Gecho Chrome 扩展

1. 打开 [Gecho Chrome 扩展下载页](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)。
2. 点击 `添加至 Chrome`，然后确认 `添加扩展程序`。

### 第二步：登录 Gecho 扩展

在 Chrome 中打开 Gecho 扩展，登录 Gecho 账号，并保持扩展在线。

### 第三步：登录 TikTok 网页版

在 Chrome 中打开 TikTok 网页版并登录账号，使用 Gecho 时保持已登录的 TikTok 标签页打开。

完成后，回到 OpenClaw Dashboard、Hermes 或其他 MCP 客户端，直接发送：

- “Search 电脑 on TikTok”
- “Search 汉堡 on TikTok”
- “Run TikTok insight for portable blender”

## 🔗 官方链接与安装帮助

- **官网**：[https://gecho.ai/](https://gecho.ai/)
- **Chrome 扩展**：[前往 Chrome 网上应用店下载](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)
- **OpenClaw 安装教程**：[OpenClaw + TikTok 安装视频](https://www.youtube.com/watch?v=ggwY9hISHcQ)
- **Hermes 安装教程**：[Hermes + TikTok 安装视频](https://www.youtube.com/watch?v=zHKnuWnxt_c)
- **YouTube 主页**：[@Gecho-AI](https://www.youtube.com/@Gecho-AI)
- **GitHub**：[https://github.com/gecho-ai/gecho-bridge](https://github.com/gecho-ai/gecho-bridge)
- **ClawHub 插件页**：[https://clawhub.ai/p/gecho-ai](https://clawhub.ai/p/gecho-ai)
- **Discord 支持**：[点击加入 Discord](https://discord.gg/RFDVZMR6Tn)
- **企业微信群**：[查看群二维码](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)
- **1 对 1 客服**：[查看客服二维码](https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg)

| 企业微信群 | 1 对 1 客服 |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/gecho-ai/gecho-bridge/main/qywx.jpg" width="160" alt="企业微信群二维码" /> | <img src="https://raw.githubusercontent.com/gecho-ai/gecho-bridge/main/wx.jpg" width="160" alt="1 对 1 客服二维码" /> |

---

## 📦 安装与配置

本项目基于标准 MCP 协议开发，可以无缝接入任何支持 MCP 的 AI 客户端（如 OpenClaw、Hermes、Trae 等）。

**先说明一个关键点：**
ClawHub 上的 **Skill** 主要提供给大模型的调用指令，本身不是服务端。想要真正搜索 TikTok，你还需要把 `gecho-bridge` MCP 服务配置到客户端里，并安装浏览器扩展。

### 0. 前置环境要求
1. **Node.js**：>= 18（需支持 `npm` / `npx`）。
2. **浏览器扩展**：请先[点击此处安装 Gecho 浏览器扩展](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)。
3. **Gecho 登录**：在 Chrome 中打开 Gecho 扩展，并登录 Gecho 账号，保持扩展在线。
4. **TikTok 登录**：在 Chrome 中打开 TikTok 网页版并登录账号，保持已登录的 TikTok 标签页打开。
5. **网络与状态**：确保本地网络可稳定访问 TikTok，且 TikTok 页面没有停在验证码、登录墙或卡死状态。

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
4. Gecho 扩展已登录 Gecho 账号并处于在线状态。
5. TikTok 页面未卡住或未停在验证码页面。

### 🧩 Skills 说明

Gecho 同时提供 TikTok 聚合 Skill 和单工具分发 Skill：

- **`tiktok-search`**：默认聚合 Skill，适合完整 TikTok 搜索 + 洞察工作流，覆盖 `tiktok_search`、`tiktok_insight` 和 `check_insight_status`。
- **`tiktok-video-search`**：单工具分发 Skill，适合按关键词搜索 TikTok 视频并采集元数据。
- **`tiktok-insight`**：单工具分发 Skill，适合 TikTok 产品、趋势、竞品和内容洞察任务，并支持查询洞察任务状态。

如果只需要某个单点能力，可以使用单工具 Skill；如果需要完整研究流程，建议使用 `tiktok-search`。

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

## ❓ 常见问题（FAQ）

### 为什么一定要装 Chrome 插件？不能直接在网页用吗？

Gecho 需要从真实浏览器会话中获取实时平台数据，例如 TikTok 视频以及 Gecho 工作流中的其他平台数据。Chrome 扩展负责把 AI 工作流连接到你已登录的 Chrome 会话；仅靠 Skill 页面本身无法完成这些数据获取。

### 为什么还要登录 TikTok？不登录不能用吗？

TikTok 对未登录用户的内容访问权限有限。登录后，扩展才能访问你浏览器会话中可见的完整数据，例如视频文案/脚本、评论、互动数据以及其他可用信号。

Gecho 不会索取或收集你的 TikTok 密码、隐私信息，也不会代表你发布任何内容。

### 还有问题？

欢迎加入 [Discord](https://discord.gg/RFDVZMR6Tn)、扫描 [企业微信群二维码](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)，或扫描 [1 对 1 客服二维码](https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg) 获取支持。

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
