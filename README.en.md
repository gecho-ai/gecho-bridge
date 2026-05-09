# Gecho Bridge 🚀

🌐 **Gecho Bridge** is a universal MCP (Model Context Protocol) tool designed to bridge your large language model (LLM) and your local browser.
After installation, whether you use **OpenClaw**, **Hermes**, or **Trae**, your AI assistant can directly control the browser to automate TikTok search, data scraping, and deep opportunity insights.

---

## ✨ Who Is It For

- 📊 **Competitor analysis**: Input a keyword and quickly get engagement data from top TikTok posts.
- 💡 **Finding winning products**: Use deep insight tools to analyze trends in specific niches (for example, "portable blender") and discover underserved opportunities.
- 🤖 **Automated operations**: Let your AI model control the browser, scroll automatically, scrape results, and generate reports without manual counting.

## 🚀 What It Can Do

- Launch Chrome automatically, search TikTok with a target keyword, and simulate natural human-like scrolling.
- Collect large-scale structured data (video ID, title, likes, video link, and more) and safely save it as JSON files.
- Run **asynchronous deep insights** powered by large-scale retrieval to summarize trends and potential business opportunities.

## 🔗 Links

- **Official Website**: [https://gecho.ai/](https://gecho.ai/)
- **ClawHub Plugin Page**: [https://clawhub.ai/plugins/gecho-bridge](https://clawhub.ai/plugins/gecho-bridge)
- **Chrome Extension**: [Install from Chrome Web Store](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)

---

## 📦 Installation & Setup

This project follows the standard MCP protocol and can be integrated with any MCP-compatible AI client (such as OpenClaw, Hermes, and Trae).

### 0. Prerequisites
1. **Node.js**: >= 18 (with `npm` / `npx` support).
2. **Browser extension**: [Install the Gecho Chrome Extension first](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb).
3. **Network and account state**: Ensure stable access to TikTok, keep your TikTok account logged in, and keep the extension online.

### Option 1: One-Click Setup in OpenClaw (ClawHub)
ClawHub provides two installation paths: `Skill` and `Plugin`.

#### Path A: Skill Install (MCP Required First)
Skill installation executes through MCP, so you must configure MCP first:
```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
```
*After configuration, run `openclaw mcp list` to verify status.*
*Then return to ClawHub and install the Skill.*

#### Path B: Plugin Install (Recommended)
```bash
openclaw plugins install @gecho-ai/gecho-bridge
openclaw gateway restart
```
*To upgrade later, run `openclaw plugins update @gecho-ai/gecho-bridge`.*

### Option 2: One-Click Setup in Hermes (Hermes Skill Hub)
Use the following commands to add the service in Hermes and restart:
```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"
hermes restart
```
*After restart, run `hermes mcp list` to verify installation status.*

### Option 3: Manual Setup for Trae / Claude Desktop and Other MCP Clients
In clients that support manual MCP configuration, open `mcp.json` or `claude_desktop_config.json` and add:
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

After setup is complete and your AI client has restarted, you can directly use natural language commands.

### 🔍 Basic Search (`tiktok_search`)
Best for quick retrieval and collection of video data.
**Example prompts:**
- *"Search TikTok for 'portable blender' and return the top 10 by likes."*
- *"Search 'cat toy' and save full results to /Users/yourname/gecho-data."*

**Execution flow:**
1. AI triggers the local Gecho browser extension to search and auto-scroll.
2. After scraping, large-scale results are automatically saved locally.
3. AI summarizes the top 20 high-like results in your chat.

### 📈 Deep Insight (`tiktok_insight`)
Best for category research and trend analysis.
**Example prompts:**
- *"Run tiktok_insight for 'outdoor picnic mat'."*
- *"Compare hot video styles and engagement between 'desk setup' and 'minimal desk'."*

**Execution flow:**
1. The plugin starts an asynchronous insight job and immediately returns a `jobId`.
2. **⚠️ Important**: Deep insights involve heavy scraping and AI analysis, and usually take **more than 5 minutes**. During execution, **do not close the browser extension or related TikTok pages**.
3. After waiting, ask AI: *"Use check_insight_status to query the previous job status"* to get the final report.

---

## ⚙️ Storage Configuration

To better manage your data assets, scraped results should be persisted to disk. The plugin supports the following priority order:

1. **Session-level (highest priority)**: In chat, ask AI to set `save_dir` directly (must be an absolute path).
2. **Global-level**: Set the environment variable `GECHO_DATA_DIR` as the default save directory.
3. **Fallback default**: If not specified, data is saved to the built-in `./data` directory.

*(Note: All output filenames are automatically sanitized to avoid write failures from invalid characters.)*

---

## 🛠️ Troubleshooting

### 1. How do I confirm the plugin is loaded? (OpenClaw example)
Run:
```bash
openclaw plugins info @gecho-ai/gecho-bridge
```
If installation succeeds, you should see `Status: loaded` and `MCP servers: gecho-tiktok-search`.

### 2. Error: Extension not connected
- Check whether the Gecho Chrome extension is enabled.
- Make sure your TikTok account is logged in, and the TikTok page is not crashed or unresponsive.

### 3. Error: Request timeout
- Check whether TikTok displays a CAPTCHA challenge; if so, solve it manually first.
- If results are too sparse for the keyword or network is unstable, try a more specific keyword and retry.

### 4. Error: Failed to save results
- Check whether `save_dir` provided to AI is a valid absolute path.
- Confirm your current system user has write permissions for the target directory.

---

## 🧑‍💻 Local Development

For developers who want to build on top of this project:
```bash
git clone https://github.com/gecho-ai/bridge.git
cd bridge
npm install
npm run server
```

**Two-layer architecture:**
- **Client layer** (`mcp-client.js`): Standard MCP STDIO integration for communication with OpenClaw/Hermes/Trae and tool schema declarations.
- **Service layer** (`server.js`): Local resident service that communicates with the browser extension over WebSocket and executes scraping plus persistence. (Supports lazy start and only launches when needed.)

## License

MIT
