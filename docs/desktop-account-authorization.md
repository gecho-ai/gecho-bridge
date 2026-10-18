# 桌面账号授权：实现与启用

更新：2026-10-18；Bridge 1.1.38，feature/phase3-scheduled-desktop。部署进展以 docs/desktop-authorization-deployment-status.md 为准；下文测试记录为 10 月 11 日的历史验证。

## 用户流程

桌面点击登录 → 系统浏览器打开后端授权页 → 复用官网 token Cookie → 确认授权 → 浏览器跳转本机随机端口 → 桌面以授权码和 PKCE 换取独立设备会话。

未登录时，后端页面提供官网入口；登录后回到桌面点击继续授权，复用同一个未超时请求。授权等待5分钟；可以取消或拒绝。退出清理本地凭证并尝试服务端撤销，网络失败明确提示远端撤销尚未确认。官网普通退出与设备授权独立。

## 已实现

- 主进程执行授权、state/PKCE 校验、单次本机回调、刷新去重、退出和重启恢复。回调只监听127.0.0.1，不使用 Bridge 固定端口。
- 主进程的 accessToken() 为后续任务同步提供身份；不把 Token、授权码或 verifier 通过 IPC 交给渲染界面。
- 刷新凭证使用 Electron safeStorage 加密后原子保存，并绑定服务端地址。安全存储不可用或 Linux basic_text 时只保留内存，不降级明文。
- 已轮换凭证在请求用户信息前保存，暂时网络故障不会导致新刷新凭证丢失；无效授权要求重登录。账号来自服务端验证，当前展示JWT subject/openid，未新增昵称查询。
- 控制面板提供登录、继续、取消、退出和账号状态，明确离线未验证、仅本次会话有效及配置缺失。

## 启用

1. 服务层应用 db/desktop_auth.sql，并按服务层 docs/desktop-authorization.md 配置开关、共享数据库、官网同域地址和可信客户端IP来源。
2. 授权路由必须部署到官网 Cookie 所在域名下，透传 HTML、302、Cookie 和 Origin。API域名与官网页面域名不同的情况下，需要同域网关转发；不能跨域读取 Cookie。
3. 源码开发可配置 GECHO_ACCOUNT_AUTH_URL=https://官网实际域名/service_layer/desktop-auth。安装包通过 build.extraMetadata 提供默认正式地址，环境变量优先；二者都没有时按钮禁用。配置了地址不等于线上授权服务已启用。账号存储遵循 GECHO_DATA_DIR，未指定时使用默认数据目录。

实现阶段未修改官网 gecho-web 前端。随后已建表并成功发布服务层代码，但授权配置和同域入口尚未收尾；真实账号授权未验收。desktop-account-login-spec.md 保留为历史设计稿，不作为当前状态。提交/推送代码与开启线上授权是两件不同的事。

## 验证

GECHO_DESKTOP_RUNTIME_TEST=1 GECHO_DESKTOP_SERVICE_LAYER=/绝对路径/vefass_service_layer node --test test/*.test.js

116项全部通过，无失败或跳过：包括错误state、回调取消、凭证轮换故障、无安全存储时禁止明文、真实Python服务层HTTP互操作，以及隔离Electron中的登录/回调/退出界面操作。

Mac arm64和Windows x64应用目录构建通过。服务层另有42项相关回归，包含临时MySQL实例的并发单次消费与轮换。没有使用真实用户凭证；运行测试不会连接生产数据库。测试界面中的系统浏览器与安全存储使用隔离替代，不打开用户日常浏览器或操作真实账号。

仍需部署后实测真实官网Cookie、系统浏览器回调及各平台系统安全存储。官网业务定时任务同步不在本次实现中；这里只提供可用于后续拉取的账号会话。
