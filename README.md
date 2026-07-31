# Gecho Bridge 🚀

**Gecho Bridge connects AI clients such as OpenClaw, Hermes, Trae, and Claude Code to a live Chrome browser through MCP and the Gecho Chrome extension.** Use it to search TikTok videos, collect structured metadata, save JSON results, and run async product, trend, competitor, and content insight workflows.

## ⚠️ Critical Prerequisite: Read Before Use

Gecho Bridge cannot work from the README, Skill page, or MCP config alone. Before the first TikTok search or insight job, all 3 items below are required:

1. **Configure Gecho Bridge MCP** in your AI client.
2. **Install the Gecho Chrome extension** and log in to your Gecho account.
3. **Log in to TikTok web in Chrome** and keep the logged-in TikTok tab open.

If any of these are missing, TikTok search and insight tools may fail even if the Skill or plugin is installed.

## 🚀 3-Step Quick Start

### Step 1: Install the Gecho Chrome extension

1. Open the [Gecho Chrome extension download page](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb).
2. Click `Add to Chrome`, then confirm `Add extension`.

### Step 2: Log in to the Gecho extension

Open the Gecho extension in Chrome, log in to your Gecho account, and keep the extension online.

### Step 3: Log in to TikTok web

Open TikTok in Chrome, log in to the TikTok web app, and keep the logged-in TikTok tab open while using Gecho.

After setup is complete, return to OpenClaw Dashboard, Hermes, or your MCP client and ask:

- "Search computers on TikTok"
- "Search hamburgers on TikTok"
- "Run TikTok insight for portable blender"

## 🔗 Official Links & Setup Help

- **Official Website**: [https://gecho.ai/](https://gecho.ai/)
- **Chrome Extension**: [Install from Chrome Web Store](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)
- **OpenClaw Setup Video**: [OpenClaw + TikTok setup tutorial](https://www.youtube.com/watch?v=ggwY9hISHcQ)
- **Hermes Setup Video**: [Hermes + TikTok setup tutorial](https://www.youtube.com/watch?v=zHKnuWnxt_c)
- **YouTube Channel**: [@Gecho-AI](https://www.youtube.com/@Gecho-AI)
- **GitHub**: [https://github.com/gecho-ai/gecho-bridge](https://github.com/gecho-ai/gecho-bridge)
- **ClawHub Plugin Page**: [https://clawhub.ai/p/gecho-ai](https://clawhub.ai/p/gecho-ai)
- **Discord Support**: [Join Discord](https://discord.gg/RFDVZMR6Tn)
- **WeCom Group**: [View group QR code](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)
- **1:1 Support**: [View personal support QR code](https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg)

| WeCom Group | 1:1 Support |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/gecho-ai/gecho-bridge/main/qywx.jpg" width="160" alt="WeCom Group QR Code" /> | <img src="https://raw.githubusercontent.com/gecho-ai/gecho-bridge/main/wx.jpg" width="160" alt="Personal Support QR Code" /> |

---

## 📦 Installation & Setup

This project is built on the standard MCP protocol and can be seamlessly integrated into any AI client that supports MCP (such as OpenClaw, Hermes, and Trae).

**One key point first:**
The **Skill** on ClawHub mainly provides calling instructions for the large model. It is not the server itself. To actually search TikTok, you still need to configure the `gecho-bridge` MCP service in your client and install the browser extension.

### 0. Prerequisites
1. **Node.js**: >= 18 (must support `npm` / `npx`).
2. **Browser extension**: Please [install the Gecho browser extension here first](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb).
3. **Gecho login**: Open the Gecho extension in Chrome and log in to your Gecho account. Keep the extension online.
4. **TikTok login**: Open TikTok in Chrome, log in to the TikTok web app, and keep the logged-in TikTok tab open.
5. **Network and state**: Make sure your local network can access TikTok reliably and the TikTok tab is not blocked by CAPTCHA, login walls, or a frozen page.

### Option 1: One-Click Installation in OpenClaw (ClawHub)
ClawHub offers two installation types: `Skill` and `Plugin`.

#### Plan A: Skill Install (MCP Must Be Configured First)
If you install the **Skill** from ClawHub, please note: **installing only the Skill page is not enough**. After installation, the Skill runs through MCP calls, so you need to complete the following MCP setup first:
```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
```
*After configuration, you can check the status with `openclaw mcp list`.*
*Once MCP is configured, go back to ClawHub and use the Skill.*

#### Plan B: Plugin Install (Recommended)
```bash
openclaw plugins install clawhub:@gecho-ai/gecho-bridge-bundle
openclaw gateway restart
```
*This is the more hassle-free installation method. After installation, you generally do not need to separately configure the MCP that the Skill depends on.*
*If you need to upgrade an installed version, use `openclaw plugins update clawhub:@gecho-ai/gecho-bridge-bundle`.*
*The plugin will automatically start a local Gecho service when needed. If the browser extension was opened after the client, run `openclaw gateway restart` once to reconnect cleanly.*

### Option 2: One-Click Setup in Hermes (Hermes Skill Hub)
You can quickly add the service to Hermes and restart it with the following commands:
```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"

hermes restart
```
*After restart, you can check the installation status with `hermes mcp list`.*
*Reference only: if Hermes reports `npx` or `node` as missing even though Node is installed on your machine, that is usually a Hermes shell/PATH issue rather than a Gecho Bridge issue. On macOS with Homebrew, one workaround is to register the MCP server with an absolute command path: `hermes mcp add gecho-bridge --command /opt/homebrew/bin/npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"` and then run `hermes restart`.*

### Option 3: Configure in General Clients Such as Trae / Claude Desktop
In MCP clients that support manual configuration, open the corresponding `mcp.json` or `claude_desktop_config.json` file and add the following node:
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

### Option 4: One-Click Setup in Claude Code
You can quickly add the service to Claude Code with the following command:
```bash
claude mcp add gecho-bridge -- npx -y @gecho-ai/gecho-bridge@latest
```
- By default, the configuration is saved at the **project level** (`.claude/settings.json`).
- Use `--scope user` to make it available for all projects, or `--scope local` for a local-only configuration.
- After adding, use `claude mcp list` to verify the server is registered.
- Restart Claude Code if the MCP tools don't appear immediately.

---

## 🏁 Quick Start & Common Workflows

After the environment is configured and your AI client has restarted, you can directly issue instructions to the AI in natural language.

### ✅ Self-Check Before First Use
1. `gecho-bridge` MCP is configured, or the `@gecho-ai/gecho-bridge-bundle` plugin is installed.
2. The [Gecho browser extension](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb) is installed.
3. TikTok is open in Chrome and the account is logged in.
4. The Gecho extension is logged in to a Gecho account and online.
5. The TikTok page is not stuck or left on a CAPTCHA page.

### 🧩 Skills

Gecho provides both an aggregate TikTok Skill and focused single-tool Skills:

- **`tiktok-search`**: the default aggregate Skill for the complete TikTok search and insight workflow. It covers `tiktok_search`, `tiktok_insight`, and `check_insight_status`.
- **`tiktok-video-search`**: a focused distribution Skill for keyword-based TikTok video search and metadata collection.
- **`tiktok-insight`**: a focused distribution Skill for TikTok product, trend, competitor, and content insight jobs, plus insight status checks.

If you only need one focused capability, use the single-tool Skills. If you want the full research workflow, use `tiktok-search`.

### 🔍 Basic Search (`tiktok_search`)
Suitable for quickly retrieving and collecting video data.
**You can say:**
- *"Search TikTok for the keyword 'portable blender' and return the top 10 by likes."*
- *"Search 'cat toy' and save the full results to /Users/yourname/gecho-data."*

**Execution flow:**
1. The AI triggers the local Gecho browser extension to perform the search and auto-scroll.
2. After scraping is complete, large volumes of data are automatically saved locally.
3. The AI summarizes the top 20 most-liked results for you in the conversation.

### 📈 Deep Insight (`tiktok_insight`)
Suitable for category research and trend analysis.
**You can say:**
- *"Please run tiktok_insight analysis for 'outdoor picnic mat'."*
- *"Compare the hot video styles and engagement of 'desk setup' and 'minimal desk'."*

**Execution flow:**
1. The plugin submits an asynchronous insight task and immediately returns a `jobId`.
2. **⚠️ Note**: Deep insight analysis involves heavy scraping and AI computation, and usually takes **more than 5 minutes**. During execution, **do not close the browser extension or the related TikTok page**.
3. After waiting for a while, say to the AI: *"Use check_insight_status to query the status of the previous task"* to get the final analysis report.
4. If it returns `running`, the task is still being processed. Please continue waiting and query again later.

---

## ⚙️ Storage Configuration

To better manage data assets, the large amount of scraped results needs to be saved to disk. The plugin supports the following priority order:

1. **Session level (highest priority)**: Ask the AI to specify `save_dir` directly during the conversation (must be an absolute path).
2. **Global level**: Configure the environment variable `GECHO_DATA_DIR` to specify the default data save directory.
3. **Default fallback**: If not specified, data is saved to Gecho's stable per-user application data directory, independent of the npm/npx cache directory.

*(Note: All saved filenames are automatically sanitized to avoid write failures caused by invalid characters.)*

---

## 🛠️ Troubleshooting

### 1. How to confirm the plugin is loaded? (Using OpenClaw as an example)
Run:
```bash
openclaw plugins info @gecho-ai/gecho-bridge-bundle
```
If installation is successful, you should see `Status: loaded` and `MCP servers: gecho-tiktok-search`.

### 2. Note about the local background service
- Gecho Bridge automatically starts a local service on demand so the MCP client can talk to the browser extension.
- This service only listens on `127.0.0.1` and is expected to stay available while you use the plugin.
- If Chrome or the extension was restarted and requests start failing, first run `openclaw gateway restart`, then try again.

### 3. Error: Extension not connected
- Check whether the Gecho extension in Chrome is enabled.
- Confirm that the TikTok account is logged in in the current browser environment, and that the TikTok page is not crashed or unresponsive.

### 4. Error: Request timeout
- Check whether a TikTok CAPTCHA challenge has appeared. If so, solve it manually first.
- If the target keyword has very few results or the network is unstable, try a more specific keyword and retry.

### 5. Error: Failed to save results
- Check whether the `save_dir` you asked the AI to specify is a valid absolute path.
- Confirm that the current system user has write permission for the target directory.

---

## ❓ FAQ

### Why is the Chrome extension required? Can't I just use the web page?

Gecho needs real-time platform data from a live browser session, such as TikTok videos and other platform data in Gecho workflows. The Chrome extension connects the AI workflow to your logged-in Chrome session; the Skill page alone cannot collect this data.

### Why do I need to log in to TikTok? Can I use it without login?

TikTok limits content access for logged-out users. After you log in, the extension can access the complete data available in your browser session, such as video captions/scripts, comments, engagement data, and other signals when available.

Gecho does not ask for or collect your TikTok password, private account information, or publish anything on your behalf.

### Need help?

Join our [Discord](https://discord.gg/RFDVZMR6Tn), scan the [WeCom group QR code](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg), or scan the [personal support QR code](https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg) for 1:1 support.

---

## 🧑‍💻 Local Development

For developers who want to build on top of this tool:
```bash
git clone https://github.com/gecho-ai/bridge.git
cd bridge
npm install
npm run server
```

**Two-layer architecture description:**
- **Client layer** (`mcp-client.js`): The standard MCP STDIO integration layer, responsible for communicating with clients such as OpenClaw, Hermes, and Trae, and declaring the Tools specification.
- **Service layer** (`server.js`): The local resident service layer, responsible for communicating with the browser extension via WebSocket and executing the actual scraping and persistence. (Supports a Lazy Start mechanism and launches only when needed.)

## License

MIT
