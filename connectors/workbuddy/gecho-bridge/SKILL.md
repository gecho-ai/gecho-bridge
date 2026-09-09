---
name: gecho-tiktok
description: 使用 Gecho Bridge MCP 在已登录的浏览器中执行 TikTok、X 和 Amazon 数据采集与分析任务。
---

# Gecho Bridge

通过 Gecho Bridge MCP 调用浏览器扩展，在用户自己的浏览器登录环境中执行数据采集和分析任务。

## 使用前提

1. 安装 [Gecho 浏览器扩展](https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj)。
2. 在扩展中登录 Gecho 账号并保持在线。
3. 在浏览器中登录需要访问的平台，并保持相关页面可用。

Gecho Bridge 使用本机浏览器会话，不要求把账号密码写入 Connector 配置。遇到登录、验证码或平台验证时，由用户在浏览器中完成。

## 工具选择

- `tiktok_search`：按关键词搜索 TikTok 视频并返回视频、创作者、互动指标和链接。
- `tiktok_insight`：启动 TikTok 产品、趋势、竞品和内容洞察任务；返回 `job_id` 后使用 `check_insight_status` 查询。
- `tiktok_influencer`：采集指定 TikTok 达人的视频数据。
- `tiktok_shop_search`：搜索 TikTok Shop 商品。
- `tiktok_product`：获取 TikTok Shop 商品详情。
- `tiktok_video`：获取单条 TikTok 视频详情、评论和回复。
- `x_search`、`x_post_detail`：采集 X 搜索结果或单条帖子详情。
- `amazon_search`、`amazon_product`、`amazon_reviews`：采集 Amazon 商品和评论数据。

## 调用规则

- 使用用户原始关键词或 URL，不要擅自改写查询条件。
- 同一轮只运行一个采集任务，不要并行调用多个抓取工具。
- 长任务返回 `job_id` 后，等待一段时间再查询状态。
- 出现扩展未连接、登录墙、验证码或超时时，先提示用户处理浏览器状态，再重试。
- 不要在回复、日志或配置中输出账号密码、Access Token 或其他凭证。

## 支持

- 官网：https://gecho.ai/
- 项目与完整配置说明：https://github.com/gecho-ai/gecho-bridge
- Chrome 扩展：https://chromewebstore.google.com/detail/pjkaeenpekolahdbccjfenjcmanemlbj
