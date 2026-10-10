# Gecho Desktop 更新指南

适用版本：1.1.38；更新：2026-10-11

## 检查与选择

启动后后台检查，也可从控制面板或托盘手动检查。更新源由主进程配置，渲染进程不能覆盖下载地址、安装路径或更新源。

GitHub Releases 列表排除草稿和预发布，按语义版本选择最新稳定版；安装包匹配当前系统和架构。推荐明确命名：Gecho-{version}-mac-arm64.dmg、Gecho-{version}-mac-x64.dmg、Gecho-{version}-win-x64.exe。

GECHO_UPDATE_FEED_URL 可在启动环境中配置自定义更新源。远程源和下载必须使用 HTTPS；HTTP 仅允许本机回环测试地址。URL 不允许携带用户名密码，HTTPS 重定向不得降级为 HTTP。

## 下载与校验

下载到独立临时目录，限制重定向次数、请求时间和文件大小（最大 512MB），拒绝异常文件名，流式下载失败清理未完成文件。

有大小信息时校验文件大小；有 asset.sha256、GitHub asset.digest 或内部测试提供的预期哈希时校验 SHA256。不会自动从发布说明或 checksums.txt 提取哈希。安装前再次校验；文件头检查不等同于数字签名认证。

## 安装行为

| 系统 | 行为 |
|---|---|
| macOS | 打开下载的 DMG，用户手动将应用拖入 Applications 替换；不会因打开镜像就自动退出或声称升级完成 |
| Windows | 启动交互式安装程序，确认进程成功启动后退出桌面端；不是静默安装，也不把进程启动当作安装成功 |

安装启动失败会显示错误并保留当前应用运行，允许重试。安装程序执行后的覆盖、回滚和重新启动取决于安装器，不能承诺所有失败都不影响原安装目录。

## 开发验证

node --test test/desktop-updater.test.js test/desktop-update-safety.test.js

GECHO_DESKTOP_RUNTIME_TEST=1 node --test test/desktop-runtime.test.js

自动测试使用隔离目录和本机测试更新源，不发布 Release。真实跨版本升级及 Windows 安装行为仍需真机验收。
