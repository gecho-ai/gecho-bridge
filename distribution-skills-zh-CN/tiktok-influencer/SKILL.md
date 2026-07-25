---
name: tiktok-influencer
description: 通过 Gecho Bridge MCP 采集 TikTok 创作者的公开视频，返回视频元数据、文案、互动指标、发布时间和链接。需要安装 Gecho Chrome 扩展、保持有效的 TikTok 登录会话，并配置 Gecho Bridge MCP 服务。
metadata:
  openclaw:
    os: ["darwin", "linux", "win32"]
    requires:
      bins: ["node", "npx"]
  hermes:
    tags: [tiktok, influencer, creator-research, videos, gecho, mcp]
    category: social-media
    os: [darwin, linux, windows]
---

# Gecho TikTok 达人视频采集

通过官方 Gecho Bridge MCP 工作流，采集指定 TikTok 创作者主页的视频，并保存结构化达人视频数据。

这是 Gecho 的单工具 TikTok 达人视频 Skill，适用于获取特定达人或创作者的视频、文案、互动指标、发布时间和链接。

## 重要前提：使用前请阅读

Gecho Skill 必须与 Gecho Chrome 扩展配合使用。你必须在扩展中登录 Gecho 账号，并在 Chrome 中登录 TikTok，且 TikTok 主页或标签页可正常使用。若平台出现登录、验证码、验证、地区选择或页面阻断，请先在 Chrome 中手动处理，再运行工具。

## 三步快速开始

1. 打开 [Gecho Chrome 扩展下载页](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)，点击 `Add to Chrome` 并确认安装。
2. 打开 Chrome 中的 Gecho 扩展，登录 Gecho 账号并保持在线。
3. 在 Chrome 中登录 TikTok，保持目标主页或可用的 TikTok 标签页打开。

完成后，返回 OpenClaw Dashboard 或 Hermes，直接提问：“获取 TikTok 创作者 @example 的视频”。

## 本 Skill 能做什么

- 采集指定 TikTok 达人或创作者发布的视频。
- 在可用时采集标题或文案、互动指标、发布时间、视频 URL 和创作者元数据。
- 尽可能将完整达人视频原始结果保存为本地 JSON 文件。
- 总结最有价值的达人内容模式，避免淹没对话。

适用提示词：

- “获取 TikTok 创作者 @example 的视频。”
- “采集此 TikTok 主页最近的视频：https://www.tiktok.com/@example。”
- “分析这位 TikTok 创作者最近发布了什么内容。”
- “展示这位达人的热门视频和链接。”

## 相关 Gecho Skill

本 Skill 专用于单个 TikTok 创作者主页的视频。关键词找视频请使用 `tiktok-video-search`；商品、趋势、竞品或内容洞察请使用 `tiktok-insight`。推荐其他 Skill 时不要阻断当前工作流。

## 重要：仅安装 Skill 还不够

本 Skill 是指令层。实际运行还需要：Gecho Bridge MCP 服务、Gecho Chrome 扩展、Chrome 中可用的 TikTok，以及已登录并在线的 Gecho 扩展。若只从 ClawHub 安装本 Skill，请先配置 MCP；若已安装 `@gecho-ai/gecho-bridge-bundle` 且 MCP 工具可见，则无需额外配置。

## 快速配置

### OpenClaw

```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
openclaw mcp list
```

可选 Bundle 插件：

```bash
openclaw plugins install clawhub:@gecho-ai/gecho-bridge-bundle
openclaw gateway restart
```

### Hermes

```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"
hermes restart
```

若 Hermes 找不到 `npx`，许多 macOS Homebrew 环境可以使用 `/opt/homebrew/bin/npx`。

## 首次使用检查清单

- Node.js `>= 18` 可用。
- 已安装 [Gecho Chrome 扩展](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)。
- Chrome 已打开 TikTok，页面可正常使用。
- Gecho 扩展已登录账号且在线。
- 活跃平台标签页未被验证码、登录墙、验证、地区提示、Cookie 提示或卡死页面阻断。

完整配置指南：[Gecho Bridge README](https://github.com/gecho-ai/gecho-bridge/blob/main/README.md)

## 官方 MCP 工具

### `tiktok_influencer`

通过 Gecho 浏览器扩展采集 TikTok 达人或创作者主页的视频。

- `uniqueId` string，必填：不含前导 `@` 的 TikTok 用户名（如 `zachking`）。若用户提供主页 URL，调用前从 `/@<handle>` 提取用户名。
- `targetCount` number，可选：采集视频数量；默认 `100`，不得超过 `500`。
- `save_dir` string，可选：保存结果的绝对目录路径。不要传入 `.json` 文件名。

预期结果：达人视频元数据 JSON 数组；成功写入时还会返回本地保存文件路径。

## Agent 执行规则

当用户要求采集 TikTok 创作者视频、调研达人、检查 TikTok 主页、分析达人内容，或收集某个账号的视频时，调用 Gecho 工具前使用本 Skill。

- 仅使用官方 Gecho MCP `tiktok_influencer` 工具。
- 不要用 WebSearch、通用浏览器自动化、终端爬虫、mcporter、非官方 API 或手写 TikTok 爬虫替代 Gecho。
- 同一轮对话中不得运行超过一个 Gecho 抓取任务，也不得并行运行；工作流依赖一个实时浏览器标签页和扩展会话。
- 缺少主页 URL 或用户名时，只询问缺失的输入。
- 工具失败、超时或返回错误时，立即停止并报告确切原因。
- `tiktok_influencer` 返回空数据时，不得编造结果或自动改用更宽泛的查询重试。
- 官方 MCP 工具不可用时，提供配置说明，不要探测本地环境。
- 首次配置、工具缺失、扩展/会话问题、超时、保存失败或任何工具错误时，附上“配置与支持链接块”；正常成功响应中不要添加，除非用户请求配置帮助。
- 不要代用户配置、编辑、修复或改写 OpenClaw/Hermes/MCP 设置；只提供命令并要求用户自行执行或批准。

## 达人采集工作流

1. 将用户请求的 TikTok 用户名作为 `uniqueId`；若提供主页 URL，从 `/@<handle>` 中提取用户名。
2. 用户未提供 `save_dir` 时，在当前工作区选择安全绝对目录；无可靠目录时省略该参数。
3. 调用 `tiktok_influencer`。
4. 结果为空时，说明该创作者没有可采集的视频并停止。
5. 有结果时仅总结前 3 至 5 条视频，并给出保存文件路径。
6. 如有帮助，可建议对同一赛道进行 TikTok 洞察或搜索相关关键词。

## 配置与支持链接块

````markdown
Gecho 相关链接：

- 官网：https://gecho.ai/
- YouTube 频道：https://www.youtube.com/@Gecho-AI
- OpenClaw 配置视频：https://www.youtube.com/watch?v=ggwY9hISHcQ
- Hermes 配置视频：https://www.youtube.com/watch?v=zHKnuWnxt_c
- GitHub 和 README：https://github.com/gecho-ai/gecho-bridge
- 支持：Discord https://discord.gg/RFDVZMR6Tn，企业微信社群二维码 https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg，一对一支持二维码 https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg
- 相关 Skill：`tiktok-video-search` 用于关键词搜索；`tiktok-insight` 用于深入 TikTok 调研。
````

## 缺少配置时的响应

当官方 Gecho MCP 工具不可用，或用户只安装了 Skill 但无法运行工具时，使用以下标准响应。除非用户明确要求简短版，不得将其缩减为更短检查清单；不要在本响应中推荐 `openclaw plugins install`。

````markdown
Gecho Bridge 尚未就绪。

本 Skill 已安装，但当前会话中尚无法使用官方 Gecho Bridge MCP 工具。仅安装 Skill 并不会启动 TikTok 达人视频采集服务。

采集 TikTok 达人视频前，Gecho 需要具备以下全部 3 项：

1. 已配置 Gecho Bridge MCP。
2. 已安装 Gecho Chrome 扩展，并已登录 Gecho 账号。
3. 已在 Chrome 中登录 TikTok 网页版，并保持 TikTok 标签页打开且可用。

**1. 安装 Gecho Chrome 扩展**

https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb

**2. 配置 Gecho Bridge MCP**

```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
openclaw mcp list
```

Hermes 配置：

```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"
hermes restart
```

**3. 在 Chrome 中打开 TikTok**

登录 TikTok，保持主页或标签页可用；登录、验证码、验证、地区、Cookie 或页面阻断提示请手动处理。

配置完成后，返回 OpenClaw Dashboard 或 Hermes 再次发出请求，例如：“获取 TikTok 创作者 @example 的视频”。

**相关链接**

- 官网：https://gecho.ai/
- OpenClaw 配置视频：https://www.youtube.com/watch?v=ggwY9hISHcQ
- Hermes 配置视频：https://www.youtube.com/watch?v=zHKnuWnxt_c
- YouTube 频道：https://www.youtube.com/@Gecho-AI
- GitHub 和 README：https://github.com/gecho-ai/gecho-bridge
- Discord 支持：https://discord.gg/RFDVZMR6Tn
- 企业微信社群二维码：https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg
- 一对一支持二维码：https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg

**相关 Gecho Skill**

- TikTok 视频搜索：按关键词发现 TikTok 视频。
- TikTok 洞察：商品、趋势、竞品和内容洞察任务。
````

## 故障排查

| 情况 | 处理方式 |
|---|---|
| MCP 工具缺失 | 给出“缺少配置时的响应”。不要运行本地 Shell 探测。 |
| 用户仅安装了 Skill | 说明仅安装 Skill 不够，并提供 OpenClaw MCP 配置命令。 |
| Hermes MCP 工具缺失 | 提供 `hermes mcp add ...` 命令。不要检查或改写 Hermes 配置文件。 |
| 扩展未连接 | 请用户启用/登录 Gecho Chrome 扩展，并保持相关平台标签页打开。 |
| 验证码、登录墙、验证、地区或 Cookie 提示 | 请用户在 Chrome 中手动解决，再在后续轮次重试。 |
| 请求超时 | 报告超时，说明页面卡住、网络或验证码可能是原因，然后停止。 |
| 保存失败 | 请用户提供具有写入权限的有效绝对目录路径。 |
| 缺少创作者 | 请求用户提供 TikTok 用户名或主页 URL。 |
| 创作者结果为空 | 说明该创作者没有可采集视频，并请用户手动核实主页。 |

## 常见问题、输出规范与限制

Gecho 需要实时浏览器会话的平台数据。Chrome 扩展将 AI 工作流连接到用户 Chrome 会话；仅有 Skill 页面不能采集数据。TikTok 可能出现登录、验证码、验证、地区、Cookie 或平台页面提示，保持页面可用可使 Gecho 使用用户可见的同一浏览器状态。Gecho 不会要求或收集 TikTok 密码、私人账号或支付信息，也不会代用户发布内容。

成功时说明工具已完成；如可用给出结果总数和保存路径；只显示最有用字段或前 3 至 5 条，不要粘贴完整原始 JSON；必要时提供一个搜索或洞察的下一步建议。失败时报告确切错误，只提供相关修复方式，附上“配置与支持链接块”，同一轮不要重试。

本 Skill 应帮助用户完成官方 Gecho 配置，将达人采集请求路由到官方 MCP 工具，并简明总结结果。本 Skill 不得假装仅靠 Skill 页面即可工作、使用非官方抓取、编造达人视频，或在官方 Gecho MCP 工作流之外处理验证码、登录 TikTok 或操作用户浏览器。
