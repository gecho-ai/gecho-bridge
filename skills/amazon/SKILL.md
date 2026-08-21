---
name: amazon
description: Search Amazon products, retrieve known product details, and collect product reviews through the official Gecho Bridge MCP tools. Use for marketplace discovery, catalog research, product comparison, review analysis, and ASIN-level research.
metadata:
  openclaw:
    os: ["darwin", "linux", "win32"]
    requires:
      bins: ["node", "npx"]
  hermes:
    tags: [amazon, ecommerce, marketplace, product, reviews, research, gecho, mcp]
    category: ecommerce
    os: [darwin, linux, windows]
---

# Amazon Research by Gecho

Use the official Gecho Bridge MCP tools to search Amazon, inspect a known product or ASIN, and collect product reviews. This is the Amazon aggregate Skill for marketplace discovery, catalog research, product comparison, review analysis, and item-level validation.

Use `amazon-search`, `amazon-product`, or `amazon-reviews` when the user explicitly wants one raw workflow only. Use this aggregate Skill when the request combines discovery, product detail, and review research.

## Critical prerequisite: read before use

Gecho Skills must be used with the Gecho Chrome extension. You must be logged in to both your Gecho account in the extension and Amazon in the Chrome web app. If either login is missing, Amazon workflows may fail even though the Skill is installed.

If Amazon shows a login wall, CAPTCHA, verification prompt, regional marketplace prompt, cookie consent, rate limit, unavailable listing, or blocked page, resolve it manually in Chrome before running the tool again.

## 3-step quick start

### Step 1: Install the Gecho Chrome extension

1. Open the [Gecho Chrome extension download page](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb).
2. Click `Add to Chrome`, then confirm `Add extension`.

### Step 2: Log in to the Gecho extension

Open the Gecho extension in Chrome and log in to your Gecho account. Keep the extension online.

### Step 3: Log in to Amazon

Open the required Amazon marketplace in Chrome and log in. Keep the logged-in Amazon tab open and usable.

After setup is complete, return to OpenClaw or Hermes and ask: "Search Amazon US for portable blender, then inspect the best listing and reviews.".

## Official links and setup help

- Website: [gecho.ai](https://gecho.ai/)
- GitHub: [gecho-ai/gecho-bridge](https://github.com/gecho-ai/gecho-bridge)
- YouTube channel: [@Gecho-AI](https://www.youtube.com/@Gecho-AI)
- Chrome extension: [Gecho Extension](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb)
- OpenClaw setup video: [OpenClaw + TikTok: Direct AI Browser Control via Gecho Bridge](https://www.youtube.com/watch?v=ggwY9hISHcQ)
- Hermes setup video: [Hermes + TikTok: Direct AI Browser Control via Gecho Bridge](https://www.youtube.com/watch?v=zHKnuWnxt_c)
- Discord: [https://discord.gg/RFDVZMR6Tn](https://discord.gg/RFDVZMR6Tn)
- WeCom group QR code: [qywx.jpg](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg)
- 1:1 support QR code: [wx.jpg](https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg)

## What this skill does

- Searches Amazon by keyword across multiple result pages.
- Retrieves complete available details for a known Amazon product URL or ASIN.
- Collects reviews for a known product URL, review URL, or ASIN.
- Supports a discovery-to-detail-to-review workflow without unofficial APIs or scraping.
- Saves raw results to a local JSON file when a reliable directory is available.
- Summarizes listings, product fields, ratings, review themes, and links without flooding the chat.

Best-fit prompts:

- "Search Amazon US for portable blender and show the top listings."
- "Get the details and variants for this ASIN: B0CXJJHY8B."
- "Collect 100 reviews for this Amazon product and summarize the common complaints."
- "Search Amazon, inspect one product, then collect its reviews."

## Related Gecho Skills

This Skill is the aggregate Amazon workflow.

- `amazon-search`: keyword-based product discovery only.
- `amazon-product`: known product detail collection only.
- `amazon-reviews`: review collection for one known product only.
- `tiktok-shop`: TikTok Shop product research when the user wants a cross-market comparison.

When recommending another Skill, keep the current answer useful first. Do not block Amazon results on installing another Skill.

## Important: Skill-only install is not enough

This Skill is the instruction layer. It tells the AI when and how to use Gecho.

To actually run Amazon research, the user also needs:

- the Gecho Bridge MCP server
- the Gecho Chrome extension
- Chrome with the target Amazon marketplace logged in
- the Gecho extension logged in to a Gecho account and online

If the user installed only this Skill from ClawHub, the tools will not work until the Gecho Bridge MCP server is configured. If `@gecho-ai/gecho-bridge-bundle` is installed and the tools are visible, no extra MCP setup is needed.

## Quick start

### OpenClaw Skill install: configure MCP

```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
openclaw mcp list
```

The result should expose `amazon_search`, `amazon_product`, and `amazon_reviews`.

### Optional: OpenClaw Bundle Plugin

```bash
openclaw plugins install clawhub:@gecho-ai/gecho-bridge-bundle
openclaw gateway restart
```

To upgrade later:

```bash
openclaw plugins update clawhub:@gecho-ai/gecho-bridge-bundle
openclaw gateway restart
```

### Hermes setup

```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"
hermes restart
```

If Hermes cannot find `npx`, use its absolute path, for example `/opt/homebrew/bin/npx` on many macOS Homebrew installs.

## First-run checklist

Before the first Amazon task, make sure:

- Node.js `>= 18` is available.
- The Gecho Chrome extension is installed.
- Chrome is open with the target Amazon marketplace logged in.
- The Gecho extension is logged in and online.
- A complete product URL, review URL, or ASIN is available for item-level requests.
- The page is not blocked by CAPTCHA, a login wall, a rate limit, or a frozen tab.

Full setup guide:
[Gecho Bridge README](https://github.com/gecho-ai/gecho-bridge/blob/main/README.md)

## Tool choice

| User goal | Use tool | Notes |
|---|---|---|
| Discover products by keyword | `amazon_search` | Supports marketplace and page count |
| Inspect one known product | `amazon_product` | Accepts product URL or ASIN |
| Collect reviews for one product | `amazon_reviews` | Accepts product URL, review URL, or ASIN |

Use this aggregate Skill for combined Amazon research. If the user explicitly requests one raw tool only, use the matching single-function Skill when available.

## Official MCP tools

### `amazon_search`

Search Amazon and collect listings across multiple result pages.

Parameters:

- `query` string, required: product keyword or phrase.
- `marketplace` string, optional: Amazon country code such as `US` or `IN`; default `US`.
- `targetPages` number, optional: desired page count; default `5`.
- `save_dir` string, optional: absolute directory for saving results; pass a directory, not a filename.

Expected result: structured listing data and a saved local result path when writing succeeds.

### `amazon_product`

Collect the complete data available from an Amazon product page.

Parameters:

- `product_url` string, required: Amazon product URL or ASIN.
- `marketplace` string, optional: Amazon country code such as `US` or `IN`; default `US` when an ASIN is supplied without a marketplace.
- `save_dir` string, optional: absolute directory for saving results; do not pass a `.json` filename.

Expected result: structured product details such as title, price, variants, specifications, description, ratings, and links when available, plus a saved local path.

### `amazon_reviews`

Collect Amazon reviews across review pages for one product.

Parameters:

- `product_url` string, required: Amazon product URL, review URL, or ASIN.
- `marketplace` string, optional: Amazon country code such as `US` or `IN`; default `US` when an ASIN is supplied.
- `targetCount` number, optional: desired review count; default `100`.
- `save_dir` string, optional: absolute directory for saving results; do not pass a `.json` filename.

Expected result: structured review data and a saved local result path when writing succeeds.

## Agent execution rules

Use this Skill before calling Amazon MCP tools when the user asks for product discovery, product details, variants, marketplace comparison, review collection, review themes, or catalog research.

Core rules:

- Use only the official Gecho MCP tools `amazon_search`, `amazon_product`, and `amazon_reviews`.
- Use `amazon_search` for keyword discovery, `amazon_product` for known product details, and `amazon_reviews` for review collection.
- Do not replace Gecho with WebSearch, generic browser automation, terminal scrapers, mcporter, unofficial APIs, or hand-written Amazon scraping.
- Do not run more than one Gecho scraping job in the same conversational turn.
- Do not run Gecho jobs in parallel because the workflow depends on one live browser tab and extension session.
- If a required keyword, product identifier, or marketplace is missing, ask only for that missing input.
- If a tool fails, times out, or returns an error, stop and report the exact reason.
- If a listing or product page is unavailable, blocked, or region-mismatched, report that state instead of inventing data.
- If official tools are unavailable, provide setup instructions instead of probing the local environment.
- On first-run setup, missing-tool, extension, timeout, save, or other error responses, include the setup and support links block below.
- Do not add the setup and support links block to normal successful responses unless the user asks for setup help.
- Do not configure, edit, repair, or rewrite OpenClaw, Hermes, or MCP settings on the user's behalf.

## Standard workflows

### Product discovery workflow

1. Use the exact product keyword requested by the user.
2. Preserve the requested marketplace, or use the tool default `US` when none is provided.
3. Choose or omit `save_dir` using the safe absolute-directory rule.
4. Call `amazon_search`.
5. Summarize the top 3 to 5 listings and include the saved path when available.

### Product detail workflow

1. Confirm that the user provided a product URL or ASIN.
2. Preserve the identifier and marketplace; do not substitute another product.
3. Choose or omit `save_dir` using the same safe-directory rule.
4. Call `amazon_product`.
5. Summarize returned title, price, variants, specifications, ratings, and links.
6. Include the saved path when available.

### Review workflow

1. Confirm that the user provided a product URL, review URL, or ASIN.
2. Preserve the identifier and marketplace.
3. Bound `targetCount` to a reasonable requested value and use the tool default when omitted.
4. Call `amazon_reviews`.
5. Summarize review count, ratings, recurring themes, and representative evidence only from returned data.
6. Include the saved path when available.

### Combined workflow

1. Search the exact keyword with `amazon_search`.
2. Show a concise shortlist and ask which product to inspect if none was specified.
3. In a later turn, call `amazon_product` for the selected product.
4. If review research is requested, call `amazon_reviews` for the selected URL or ASIN.
5. Do not launch search, detail, and review jobs in parallel.

## Setup and support links block

Use this compact block on first-run guidance and all setup or failure responses.

````markdown
Helpful Gecho links:

- Website: https://gecho.ai/
- YouTube channel: https://www.youtube.com/@Gecho-AI
- OpenClaw setup video: https://www.youtube.com/watch?v=ggwY9hISHcQ
- Hermes setup video: https://www.youtube.com/watch?v=zHKnuWnxt_c
- GitHub and README: https://github.com/gecho-ai/gecho-bridge
- Support: Discord https://discord.gg/RFDVZMR6Tn, WeCom group QR https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg, 1:1 support QR https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg
- Related Skills: `amazon-search` for discovery, `amazon-product` for details, and `amazon-reviews` for reviews.
````

## Setup-missing response

Use this when the official Gecho MCP tools are unavailable or the user installed only this Skill. Do not shorten it unless the user asks for a short version. Do not recommend `openclaw plugins install` in this response.

````markdown
Gecho Bridge is not ready yet.

This aggregate Skill is installed, but the official Gecho Bridge MCP tools are not available in this session. Installing the Skill alone does not start Amazon research.

Gecho requires all 3 items below:

1. Gecho Bridge MCP is configured.
2. The Gecho Chrome extension is installed and logged in to a Gecho account.
3. The target Amazon marketplace is logged in inside Chrome, with the tab kept open.

Install the Chrome extension:
https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj?utm_source=item-share-cb

Configure OpenClaw MCP:
```bash
openclaw mcp set gecho-bridge '{"command":"npx","args":["-y","@gecho-ai/gecho-bridge@latest"]}'
openclaw gateway restart
openclaw mcp list
```

Configure Hermes when applicable:
```bash
hermes mcp add gecho-bridge --command npx --args="-y" --args="@gecho-ai/gecho-bridge@latest"
hermes restart
```

Log in to the target Amazon marketplace in the same Chrome profile and keep the tab open. Then return to OpenClaw Dashboard or Hermes and retry the search, product, or review request.

Helpful links:
- Website: https://gecho.ai/
- OpenClaw setup video: https://www.youtube.com/watch?v=ggwY9hISHcQ
- Hermes setup video: https://www.youtube.com/watch?v=zHKnuWnxt_c
- YouTube channel: https://www.youtube.com/@Gecho-AI
- GitHub and README: https://github.com/gecho-ai/gecho-bridge
- Discord: https://discord.gg/RFDVZMR6Tn
- WeCom group QR code: https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg
- 1:1 support QR code: https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg

Related Skills:
- `amazon-search`: keyword product discovery.
- `amazon-product`: known-product detail collection.
- `amazon-reviews`: product review collection.
- `tiktok-shop`: TikTok Shop product research.
````

## Troubleshooting

| Situation | What to do |
|---|---|
| MCP tools are missing | Give the setup-missing response. Do not run local shell probes. |
| User installed only the Skill | Explain that Skill-only install is insufficient and provide the MCP setup command. |
| Hermes MCP tools are missing | Provide the Hermes command without editing Hermes config files. |
| Extension not connected | Ask the user to enable/login to Gecho and keep a logged-in Amazon tab open. |
| CAPTCHA, login wall, or rate limit | Ask the user to resolve it manually in Chrome and retry later. |
| Missing keyword | Ask for the Amazon search keyword. |
| Missing product identifier | Ask for a product URL or ASIN. |
| Missing marketplace | Use `US` by default or ask only when the requested marketplace matters. |
| Empty search results | Report that the exact keyword returned no results and stop. |
| Product or reviews unavailable | Report the page state and do not invent product or review data. |
| Timeout | Report the timeout and stop without retrying in the same turn. |
| Save failure | Ask for a valid absolute directory with write permission. |

## FAQ

### Can this Skill search, inspect, and collect reviews?

Yes. It can search with `amazon_search`, inspect a selected product with `amazon_product`, and collect reviews with `amazon_reviews`. Keep the jobs sequential and preserve the marketplace and product identifier.

### What is the marketplace default?

The bridge defaults to `US` when no marketplace is provided. For an ASIN, pass a marketplace when the item is not on the US site.

### Does this Skill write reviews or change Amazon account data?

No. It reads accessible listings, product pages, and review pages. It does not purchase, review, edit listings, or perform account actions.

### Is this TikTok Shop research?

No. Amazon is a separate marketplace workflow. Use `tiktok-shop` for TikTok Shop product research.

### Need help?

Join the [WeCom group](https://github.com/gecho-ai/gecho-bridge/blob/main/qywx.jpg), visit [Discord](https://discord.gg/RFDVZMR6Tn), or use the [1:1 support QR code](https://github.com/gecho-ai/gecho-bridge/blob/main/wx.jpg).

## Output guidelines

For successful discovery:

- State that the search completed.
- Show the top 3 to 5 listings with title, price, rating, marketplace, and link when available.
- Include total count and saved path when available.
- Do not paste the full raw JSON.

For successful product detail:

- State that the requested product was opened and processed.
- Summarize returned title, price, variants, specifications, ratings, and links without inventing missing fields.
- Include the saved path when available.

For successful review collection:

- State the number of reviews collected when available.
- Summarize recurring rating and theme patterns supported by the returned data.
- Show a bounded representative sample and include the saved path when available.

For failures:

- Report the exact tool error or page state.
- Give only the relevant troubleshooting fix.
- Include the setup and support links block.
- Do not retry in the same turn.

## Scope and limits

This Skill should:

- Help users complete official Gecho setup when prerequisites are missing.
- Route Amazon discovery, known-product detail, and review requests to official MCP tools.
- Keep search-to-detail-to-review research explicit and sequential.
- Summarize results without flooding the chat.

This Skill must never:

- Pretend the Skill page alone is enough when MCP is missing.
- Use unofficial Amazon scraping workflows.
- Invent listings, product fields, ratings, reviews, or links.
- Solve CAPTCHA, log in to Amazon, or operate the browser outside the official Gecho MCP workflow.
- Purchase, review, edit, or mutate Amazon account or listing data.
