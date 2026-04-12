# Gecho Bridge 🚀

Gecho Bridge is an MCP (Model Context Protocol) server that connects AI Agents (like Claude Desktop, Cursor, or OpenClaw) to TikTok via a Chrome extension. It allows your AI models to search and retrieve TikTok video metadata directly from the browser.

## Features

- **Automated Search**: Search TikTok with keywords and auto-scroll to fetch results.
- **Data Retrieval**: Get video IDs, titles, like counts, and play URLs.
- **Dual-Layer Architecture**: A lightweight MCP Client that automatically manages a persistent Service Layer.
- **Lazy Start**: The bridge automatically starts the background service when needed.

## Installation

### 1. Install via npm
```bash
npm install -g @gecho-ai/gecho-bridge
```

### 2. Install Chrome Extension
Ensure you have the Gecho TikTok Extension installed and active in your Chrome browser. The bridge communicates with this extension via WebSocket.

## Configuration

### Claude Desktop
Add the following to your `claude_desktop_config.json`:

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

### Cursor
Go to Settings -> MCP.
Add a new MCP server:
- **Name**: gecho-bridge
- **Type**: command
- **Command**: `npx -y @gecho-ai/gecho-bridge@latest`

## Usage

Once configured, you can ask your AI:

- "Search TikTok for 'cooking recipes'"
- "Find trending TikTok videos about AI agents"

## Development

If you want to run the bridge locally from source:

```bash
git clone https://github.com/gecho-ai/bridge.git
cd bridge
npm install
node mcp-client.js
```

## Architecture

- **Service Layer (server.js)**: Maintains the WebSocket connection with the Chrome extension (Port 18792) and exposes an HTTP API (Port 18793).
- **Client Layer (mcp-client.js)**: Implements the MCP Stdio protocol and forwards requests to the Service Layer.

## License

MIT
