# Gecho Bridge 🚀

🌐 **Gecho Bridge** is a universal MCP (Model Context Protocol) tool designed to build a bridge between your large language model (LLM) and your local browser.
After installation, whether you use **OpenClaw**, **Hermes**, or **Trae**, your AI assistant can directly control the browser to automate TikTok search, data collection, and deep business opportunity insights.

---

## ✨ Who Is It For

- 📊 **Competitor analysis**: Enter a keyword and quickly get engagement data for top TikTok videos.
- 💡 **Finding winning products**: Use deep insight tools to analyze trends in specific categories (such as "portable blender") and identify underserved blue-ocean opportunities.
- 🤖 **Automated operations**: Let a large model directly control the browser, auto-scroll, scrape data, and generate reports, eliminating tedious manual counting.

## 🚀 What It Can Do

- Automatically launch Chrome, search TikTok for a target keyword, and simulate natural human-like scrolling.
- Collect large volumes of structured data (video ID, title, likes, playback link, and more) and safely save it as JSON files.
- Run **asynchronous deep insights** based on large-scale retrieval to intelligently summarize winning-product trends and potential business opportunities.

## 🔗 Related Links

- **Official Website**: [https://gecho.ai/](https://gecho.ai/)
- **GitHub**: [https://github.com/gecho-ai/gecho-bridge](https://github.com/gecho-ai/gecho-bridge)
- **ClawHub Plugin Page**: [https://clawhub.ai/p/gecho-ai](https://clawhub.ai/p/gecho-ai)
- **Chrome Browser Extension**: [Install from Chrome Web Store](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)

## 💬 Community & Feedback

Welcome to join our community for discussion or feedback:

- **Discord Community**: [Join Discord](https://discord.gg/RFDVZMR6Tn)
- **WeCom Group**: Scan the QR code below to join

![WeCom QR Code](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)

---

## 📦 Installation & Setup

This project is built on the standard MCP protocol and can be seamlessly integrated into any AI client that supports MCP (such as OpenClaw, Hermes, and Trae).

**One key point first:**
The **Skill** on ClawHub mainly provides calling instructions for the large model. It is not the server itself. To actually search TikTok, you still need to configure the `gecho-bridge` MCP service in your client and install the browser extension.

### 0. Prerequisites
1. **Node.js**: >= 18 (must support `npm` / `npx`).
2. **Browser extension**: Please [install the Gecho browser extension here first](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb).
3. **Network and state**: Make sure your local network can access TikTok reliably, and log in to both your browser account and the browser extension.

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

---

## 🏁 Quick Start & Common Workflows

After the environment is configured and your AI client has restarted, you can directly issue instructions to the AI in natural language.

### ✅ Self-Check Before First Use
1. `gecho-bridge` MCP is configured, or the `@gecho-ai/gecho-bridge-bundle` plugin is installed.
2. The [Gecho browser extension](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb) is installed.
3. TikTok is open in Chrome and the account is logged in.
4. The Gecho extension is logged in and online, and the TikTok page is not stuck or left on a CAPTCHA page.

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
3. **Default fallback**: If not specified, data is saved to the tool's built-in `./data` directory by default.

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
