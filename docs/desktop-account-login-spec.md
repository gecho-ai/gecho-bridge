# 桌面端官网账号授权规格

状态：历史设计稿，保留 2026-10-09 当时的假设和调查，不作为当前实现状态。账号模块现已实现；请以 docs/desktop-account-authorization.md、docs/desktop-authorization-deployment-status.md 和 docs/phase3-desktop-ui-handoff.md 为准。下文“未实施”“尚未定位”等均为历史记录。

## 目标与假设

桌面端提供“登录 Gecho”，打开系统浏览器，复用官网已有登录会话；登录完成后桌面端显示用户身份并获得独立设备会话，为后续用户定时任务拉取提供身份。

假设：登录会话可由官网现有服务验证；桌面端不读取、复制浏览器 Cookie 或 localStorage。浏览器登录与桌面会话独立，官网普通退出不自动退出设备，服务端全设备撤销须使设备凭证失效。此行为需用户确认。

本次不实现任务同步、不修改本地 Bridge 认证、不修改其他 Agent 正在开发的更新模块、不发布生产服务。

## 本地核对结果与未确定项

- Bridge 当前分支为 feature/phase3-scheduled-desktop；desktop/main.js、preload.js、renderer/ 为桌面入口，尚无账号授权模块。
- veFass_homepage/index.js 实际为静态资源托管，不能据目录名字认定它是当前 Gecho 登录前端。
- ecs_wechat_login/app.py 引用 Logto 和 Google Token 验证；login_oversea/app.py 包含 Google 验证。它们不能据此直接认定为官网当前主登录服务。
- 尚未定位当前官网登录前端及其主会话签发服务，也未确认原生应用授权能力。不得把候选目录当成已确认修改目标。

实施前需明确官网登录源码仓库、分支、主身份提供方；若支持标准原生 OAuth 客户端，优先直接复用，不自建授权服务器。

## 技术路径

采用系统浏览器 + Authorization Code + PKCE S256。桌面端是公开客户端，不能内置 client secret。

1. 主进程监听 127.0.0.1 的临时随机端口，仅用于此次回调；生成 state、verifier 和 challenge。
2. 打开受信任授权地址，带 client_id、response_type=code、redirect_uri、state、code_challenge、code_challenge_method=S256。
3. 官网复用已有会话；未登录则沿用已有登录流程。首次显示设备授权确认，后续是否免确认由服务器授权策略决定。
4. 回调仅返回 code/state 或标准授权错误；验证路径、请求参数和 state 后，交换授权码。授权码短时有效、单次使用，并绑定客户端、回调和 PKCE。
5. 用访问凭证获取规范用户身份；身份来自服务器，不从浏览器回调接受任意 userId。
6. 完成、取消或超时关闭临时监听器；重复点击复用正在进行的请求，拒绝回调重放。

授权、Token、用户信息、撤销端点通过受信任配置或已验证的 OIDC discovery 确定；目前不虚构现有官网接口地址。生产请求必须 HTTPS，仅本机回调允许 HTTP；禁止任意外部 URL 注入。

依据：[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)，尤其系统浏览器、loopback redirect 和 PKCE 要求。

## 会话与界面契约

UI 状态：signedOut、authorizing、signedIn、refreshing、reauthRequired。网络故障与凭证失效分开处理；离线不立即抹除账号，但不得显示已确认在线有效。

主进程提供 login、cancelLogin、logout、getAccountStatus，向渲染进程暴露的状态只含 status、user（id/displayName/avatarUrl）、非敏感错误码；不返回 Token、verifier 或授权码。渲染用户信息使用文本输出，不拼接不可信 HTML。

主进程负责刷新并对并发刷新去重；刷新失败若为网络错误可重试，invalid_grant 则要求重登录。刷新凭证轮换必须原子保存，不得因旧刷新结果覆盖新登录账号。

长期凭证存入系统安全存储；禁止明文 JSON 和日志泄漏。具体存储实现须在核对平台能力后选择；安全存储不可用时仅内存会话，不静默降级为明文。

退出立即使本地账号失效，取消在途请求，清理凭证；尝试服务端设备会话撤销，失败需说明不能确认远端已撤销。切换账号必须重新授权，不能因浏览器换号自动更换桌面用户。未来任务同步消费者订阅身份变化、按用户隔离任务并在退出时停止同步，本次仅提供边界。

## 项目结构与验证命令

拟新增 desktop/account-login.js、desktop/account-store.js 和对应 test/desktop-account-*.test.js；界面接入 main.js、preload.js、renderer/、i18n.js。官网侧路径待确认后再列入范围。

风格：CommonJS，遵循现有 Node 测试与桌面模块；业务账号与本地服务凭证不混用。

验证命令：

```sh
node --test test/desktop-account-*.test.js
node --test test/desktop-platform.test.js test/desktop-packaging.test.js
node --check desktop/main.js
npm run desktop:pack
```

## 验收与边界

- 使用本地测试身份服务覆盖登录成功、已有浏览器会话、拒绝授权、错误 state、授权码重放、超时、取消、刷新轮换、重启恢复、退出及切换账号。
- 验证 UI/IPC 不暴露秘密；浏览器打不开和端口绑定失败可恢复。
- 真正复用官网登录须在双方接口完成后实测，不能用 mock 测试冒充真实接入完成。
- 总是保留用户现有改动；官网及登录服务分仓库验证。
- 新依赖、身份平台注册、数据库变更或跨仓库分支变更先确认。
- 不部署、不读取真实浏览器凭证、不提交密钥、不改版本、不处理更新 Agent 的工作。

## 确认后推进

先定位官网主登录实现和可复用的原生授权能力，再制定小步计划；桌面端可先用测试身份服务验证回调和会话模块，真实接入不能在官网契约缺失时声称完成。
