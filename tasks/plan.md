# WorkBuddy 开放平台 Connector 打包计划

## 目标

生成一个可以上传到 WorkBuddy 开放平台“发布连接器”页面的 ZIP。连接器使用现有公开 npm 包提供的 MCP Stdio 服务，不改变现有 Skill、ClawHub 或腾讯 SkillHub 的发布流程。

## 已确认的约束

- Connector 根目录必须包含 `connector-meta.json`、`mcp.json` 和图标文件。
- MCP 连接器只配置一个 MCP Server；当前 Bridge 的一个 Stdio Server 暴露多个工具，符合这一约束。
- WorkBuddy 支持本地 Stdio；远程 MCP 才要求 HTTPS 的 SSE 或 Streamable HTTP。
- 连接器 ZIP 仅生成到 `tmp/`，不上传、不提交审核。

## 任务列表

### 阶段 1：打包基础

- [x] 增加 WorkBuddy Connector 配置模板。
- [x] 增加专用打包与校验脚本。
- [x] 增加针对根目录结构、JSON、版本和 ZIP 内容的测试。

### 检查点：打包基础

- [x] 专用测试通过。
- [x] ZIP 可通过 `unzip -t` 校验。
- [x] ZIP 根目录包含平台要求的文件。
- [x] 现有 Skill 发布测试不受影响。

### 阶段 2：生成上传包

- [x] 使用当前 npm 包版本生成 Connector ZIP。
- [x] 输出清单，确认没有密钥、源码临时文件或平台 Skill 发布元数据。
- [x] 保留 ZIP 路径，供用户手动上传。

## 风险

- Bridge 当前依赖本机浏览器扩展和本地端口，Connector 能否在 WorkBuddy 用户端正常启动需要实际安装测试。
- 部分工具执行时间可能超过 WorkBuddy 官方建议的单次 30 秒响应时间，首次上传只验证解析和启动；正式审核前需要评估异步化。
- Buddy 应用内置连接器要求 OAuth，这不属于本次本地 Stdio Connector 的范围。

## 参考

- https://open.workbuddy.cn/docs/connector
- https://open.workbuddy.cn/docs/buddy-app
