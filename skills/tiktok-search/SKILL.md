---
name: tiktok-search
description: Professional TikTok keyword search and data extraction tool. Automates browsing and scraping via Chrome extension.
---

# TikTok Search 🚀

A specialized tool for searching and extracting video metadata from TikTok. It bridges your local Chrome browser via an extension to perform automated searches, scrolling, and data collection.

## Tools

### `tiktok_search`

Executes a keyword search, auto-scrolls to load results, and returns metadata.

**Parameters:**

- `query` (string, required): The search keyword or phrase (e.g., "cooking tips", "travel vlogs").
- `save_dir` (string, optional): Absolute path to save the results JSON. *Best Practice: Always proactively generate a safe, timestamped absolute path in the current workspace (e.g., `/absolute/path/to/workspace/tiktok_travel_vlogs_1690000000.json`) so the user doesn't lose the raw data.*

**Returns:**

A JSON array containing video IDs, titles, like counts, play URLs, and author info.

### `tiktok_insight`

Performs business insight and trend analysis based on TikTok search results.

**Parameters:**

- `query` (string, required): The search keyword or phrase (e.g., "outdoor picnic mat").
- `save_dir` (string, optional): Absolute path to save the results JSON.

**Returns:**

A JSON array with analyzed insights and trends based on the search query.

## Prerequisites Check & Environment Setup

Before calling, ensure the following prerequisites are met:
1. **Node.js**: Installed in the local environment.
2. **Gecho TikTok Extension & Active Tab**: The **USER** must have Chrome open locally with the extension active and a TikTok tab open. 

**⚠️ CRITICAL AGENT INSTRUCTION:**
You (the Agent) MUST NOT attempt to install Chrome, open browsers, or use tools like `browser_navigate` to fulfill these prerequisites. Do NOT check for Chrome yourself. Your ONLY responsibility is to call the MCP tool.

## Execution Rules & Constraints (CRITICAL)

You MUST strictly adhere to the following rules when calling the MCP tools:
1. **Single Tool Call Limit**: You MUST NOT execute more than ONE tool call (`tiktok_search` OR `tiktok_insight`) per conversational turn. You MUST wait for the user's feedback before initiating another search or insight request.
2. **Strict Tool Binding (No Fallbacks)**: You MUST ONLY use the EXACT tools specified (`tiktok_search` or `tiktok_insight`) for TikTok searches. You are **STRICTLY FORBIDDEN** from using built-in browser tools (like `browser_navigate`, `puppeteer`, etc.), generic WebSearch, Bing, Google, or writing Python scrapers to visit TikTok.com. 
3. **Fail Fast & Explicit Reporting**: If the MCP tool fails, times out, or throws an error (e.g., `params is not defined`), you MUST STOP immediately. Do NOT offer alternative web search solutions. You MUST output the raw error message to the user.
4. **No Parallel Execution**: Since this tool controls an active Chrome tab, it is strictly single-threaded. You MUST NEVER execute multiple `tiktok_search` tool calls in parallel simultaneously. You must wait for one search to completely finish before starting another.
5. **Anti-Hallucination (No Fake Data)**: You MUST base your final response ONLY on the exact data returned by the tool. If the tool returns empty results (`[]`), you MUST NOT hallucinate or guess. Inform the user exactly what the tool returned.
6. **Anti-Spam (No Infinite Loops)**: NEVER call the tool repeatedly with the exact same `query` if it fails or returns empty results.
7. **No Retries**: If a call fails due to a timeout, network error, or any other reason, you MUST STOP immediately and return the error to the user. DO NOT retry.
8. **Output Summarization (Avoid Chat Spam)**: If the tool returns a large number of results (e.g., 200 videos), DO NOT print the entire raw JSON array in your chat response. You must summarize the top 3-5 results, and utilize the `save_dir` parameter to save the full dataset to the user's disk.

## Troubleshooting & Error Handling (Decision Tree)

If the `tiktok_search` tool execution fails, follow this decision tree to assist the user:

1. **Error: "Chrome extension not found/connected"**
   - → Inform the user: *"Please ensure the Gecho TikTok Chrome extension is installed, enabled, and you have an active TikTok tab open in Chrome."*
2. **Error: "Timeout" or "No results found"**
   - → Ask the user: *"Are you currently facing a CAPTCHA or login prompt on the active TikTok page? Please resolve it in your browser and try again."*
3. **Error: "Tool not found"**
   - → Inform the user: *"The tool is not registered. Please ensure the Gecho Bridge Plugin is installed and active."*

## Example Usage & Standard Operating Procedure (SOP)

When a user requests a TikTok search, follow this exact 4-step workflow:
1. **Determine Path**: Proactively generate a valid absolute path for `save_dir` based on the user's OS and current workspace.
2. **Execute**: Call `tiktok_search` with the `query` and `save_dir`.
3. **Process**: Wait for the JSON array.
4. **Report**: Inform the user where the raw JSON file was saved, and output a concise Markdown summary table (Title, Likes, Author, URL) for the top 3-5 videos only.

Example:
"Find trending videos for 'travel vlogs'"
→ Action: Call `tiktok_search` with `query="travel vlogs"` and `save_dir="/path/to/workspace/travel_vlogs_results.json"`

## Limitations

- Requires an active user session in Chrome.
- Only works via the MCP tool interface.