# 官网三期：Bridge、桌面端与定时任务交接

更新：2026-10-18。面向产品及协助产品开发 UI 的 AI，不要求阅读历史聊天。

交接编号：交接-20261018-01；状态：待接收；上一编号：无。
整理者：Codex，交接整理负责人；宿主会话标识：未知。接收者：产品与其指定的 AI，尚未认领。
初次整理只核对代码、运行针对性测试并写文档。随后用户明确要求提交并推送当前分支；本次整理提交与文档，不发布应用、不调整线上配置。完成交接后暂停本任务修改，等待接收者或用户继续。

## 1. 项目是什么

Gecho Bridge 是浏览器扩展与外部调用方之间的本地中枢。三期增加独立桌面运行、账号授权和本地定时触发，让任务不必依赖某个 MCP 会话持续存活。

职责划分：

| 部分 | 职责 | 不负责 |
|---|---|---|
| 官网与服务层 | 业务任务定义、账号、完整飞轮编排、最终业务结果 | 保证用户电脑一直开机 |
| 桌面主进程 | 托盘、Bridge 生命周期、授权凭证、更新、自检与系统集成 | 在 UI 中重写云端业务 |
| 本地调度器 | 保存时间规则，到点向插件发送任务引用，记录触发结果 | 直接完成采集、分析、脚本或视频生成 |
| 浏览器扩展 | 接收指令，衔接真实浏览器及官网执行 | 由 Bridge 自动推定最终业务成功 |
| 桌面面板 | 展示状态和承接用户操作；当前为功能验证 UI | 当前视觉、布局或信息架构不是定稿 |

目标链路：官网任务 → 同步到本机 → 本地到点触发 → 扩展/官网执行 → 官网保存业务结果。当前尚未完成整个链路。

## 2. 开发进度：不要把原型当成业务完成

| 模块 | 当前实现 | 尚未完成或验收的部分 |
|---|---|---|
| 桌面基础 | Electron 主进程、托盘、单实例、本地 Bridge 启停与归属保护；关闭面板销毁窗口，托盘继续运行 | 产品级面板设计；Windows 真机验收 |
| 环境守护 | 浏览器/Profile 探测与选择、有限失联恢复、活动采集防空闲休眠、唤醒连接刷新 | 真实扩展恢复与休眠唤醒验收；不能承诺合盖后继续执行 |
| 排障与系统偏好 | 自检、诊断导出、日志轮转与脱敏、通知、快捷键、主题、开机启动设置 | 产品整理入口、文案及反馈层级 |
| 更新 | 检查稳定版本、匹配平台/架构、下载进度、失败处理和安装交接 | 真实发布源和安装包的跨版本升级验收；不能把检查通过当作升级成功 |
| 桌面账号 | 登录/继续/取消/退出、PKCE 本机回调、加密凭证保存、刷新及重启恢复；主进程可提供访问凭证 | 真实官网登录态授权闭环未验收；昵称/头像资料未接入，当前只有服务端用户 ID |
| 本地定时引擎 | once/daily/weekly、时区、补跑策略、持久化、幂等更新、暂停、立即触发、历史与并发保护 | 不负责业务最终结果；不能唤醒已关机电脑 |
| 桌面任务面板 | 卡片、暂停/恢复、立即执行的交互原型 | 仍连接 main.js 中 mockScheduledTasks，不是实际调度器；“新建任务”只弹提示 |
| 官网任务同步 | 已有本地 HTTP 接口，官网可主动 upsert 本地任务 | 未见授权后按账号拉取云端任务、持续同步或跨端冲突处理的实现 |

最重要的断点：UI 任务操作没有接上本地真实调度器；账号授权没有接上云端任务同步。UI 里显示“成功抓取”目前只是演示字符串。

打包风险：当前 package.json 的 build.files 列出了 scheduled-task-store.js 和 scheduled-task-scheduler.js，但未显式列出两者 require 的 scheduled-task.js。需要功能开发核对实际 asar 内容并补齐/验证依赖，不能把源码测试通过等同于安装包可运行。本次未重建或启动安装包，尚未确认实际产物是否缺失。

### 账号线上状态的证据边界

2026-10-11 最后一次发布记录：服务层修订 309 成功，健康检查 200，原有未登录接口 401；桌面授权接口 503，授权配置未恢复，同域转发受 CDN 权限限制。不是服务仍发布失败。

本次没有重新查生产配置，以上为历史验证，不代表 10 月 18 日的实时状态。账号联调前须重新确认 Cookie 实际域、同域授权路由和后端开关。后端 Python 3.8 启动修复不等于账号授权已跑通。

## 3. 产品可以从哪里开始改

当前是原生 HTML/CSS/JavaScript + Electron preload IPC，没有 React/Vue 构建层。先沿用当前结构做一页薄改动，不需要为了设计面板先重构桌面架构。

以下均为仓库根目录相对路径：

| 文件 | 用途与修改范围 |
|---|---|
| desktop/renderer/index.html | 面板结构；可调整模块顺序、布局、语义和视觉入口 |
| desktop/renderer/style.css | 主要视觉样式，包含主题适配 |
| desktop/renderer/renderer.js | 状态、演示任务、更新界面与多数按钮绑定 |
| desktop/renderer/account.js | 账号状态展示与授权操作绑定 |
| desktop/renderer/environment.js | 浏览器/Profile、恢复与系统偏好交互 |
| desktop/i18n.js | 中英文词典；当前部分账号和环境文案仍是直接双语文本 |
| desktop/preload.js | renderer 可用的 window.gechoDesktop 契约，修改前检查 main 和测试 |
| desktop/main.js | 窗口、IPC 和系统能力；包含演示任务，不能当作纯 UI 文件随意重写 |
| scheduled-task-store.js、scheduled-task-scheduler.js、scheduled-task.js | 真实本地定时引擎，不归视觉设计改动范围 |
| server.js | Bridge HTTP/WebSocket 及调度接口，不归视觉改动范围 |

改 HTML 的 ID 时同步调整三个 renderer 脚本和相关测试。environment.js/account.js 中有直接取元素并绑定事件的代码，删除区块却保留脚本会报错。

UI AI 不应更改服务端、PKCE、凭证保存、自动更新安全约束或采集协议。需要新能力时，先列出缺少的 IPC/业务接口，再由功能开发补齐。

## 4. 可以直接复用的界面接口

所有接口通过 window.gechoDesktop 调用；实现以 desktop/preload.js 与 desktop/main.js 为准。UI 不直接 require Node，不直接取账号 Token。

| 区域 | 方法/订阅 | 接入性质 |
|---|---|---|
| 服务状态 | getStatus、onStatus | 真实 Bridge 状态；区分服务运行与扩展连接 |
| 账号 | getAccountStatus、onAccountStatus、loginAccount、cancelAccountLogin、logoutAccount | 已实现，真实生产授权仍待联调 |
| 浏览器与偏好 | getBrowserEnvironment、setPreferences、launchBrowser | 已实现；保存偏好不等于扩展已连接 |
| 排障与系统 | runHealthCheck、exportDiagnostics、openDataDir、openOnboarding、getAppInfo、setAutoStart、hideWindow、quit | 已实现；网络自检是用户可选动作 |
| 更新 | checkForUpdates、getUpdateState、onUpdateStatus、downloadUpdate、quitAndInstall | 已实现；安装属于有副作用操作，不能在预览时自动调用 |
| 语言 | getLocale、setLocale、getTranslations | 已实现 |
| 面板任务 | getScheduledTasks、toggleScheduledTask、runScheduledTaskNow | 演示实现，尚未连接真实调度器 |

需要覆盖的状态：

- 账号：unavailable、signedOut、authorizing、refreshing、signedIn、reauthRequired；还需展示离线未验证、无法持久化、远端撤销未确认。已知主进程只提供 user.id，头像昵称不能假装来自真实账号。
- 服务：停止、运行但插件未连、插件已连；不要合并成“账号未登录”。
- 更新：idle、checking、available、downloading、downloaded、installing、not-available、no-matching-asset、error。
- 定时任务：空列表、加载、暂停、待触发、触发中、已派发、触发失败、错过跳过。dispatched 表示交付指令，不表示采集/视频已完成。

预览可以使用独立且明确标注的 demo adapter，但不得把演示数据混入真实账号、本地存储或正式任务；不得用隐藏错误、假成功替代业务联调。

## 5. 定时任务接真实数据时的契约

本地真实接口位于 /scheduled-jobs，提供列表、详情、创建/修改/删除、立即触发和运行记录；官网优先用 PUT /scheduled-jobs/task-ref/{taskRef} 幂等同步。完整协议见 docs/scheduled-flywheel-bridge.md。

核心字段是 taskRef、taskVersion、entryUrl、schedule、enabled；schedule 使用 once/daily/weekly 和 timezone。现在卡片中的 name、cron、targetCount、lastResult 是演示展示字段，不是后端已经承诺的任务字段，尤其“每四小时”原型不代表真实引擎支持任意 cron。

HTTP 端口可能因冲突改变，不能在新 UI 硬编码 18793。任务接线优先经主进程提供明确 IPC，由主进程处理实际端口、本机鉴权及真实任务模型到视图模型的转换。这个 adapter 尚未实现。

完整链路还需要功能开发明确：云端任务来源、账号隔离、同步触发/频率、删除与禁用传播、冲突策略、失败重试及最终结果查询。产品决定交互，不应由 UI AI 自行发明接口。

## 6. 本机检查点与启动

- 仓库本机路径：/Users/wangzhiguang/createPlux/gecho-ai/gecho-bridge；其他机器以实际 clone 路径为准。
- 分支：feature/phase3-scheduled-desktop；版本：1.1.38。
- 账号地址及存储修正检查点：f677c89；此前基础提交 506e5fc。这是未合并的功能分支，不要直接切 main 开始改 UI。
- desktop/main.js、package.json、desktop/account-config.js 及对应测试已纳入 f677c89。早期账号 spec 标为历史设计稿；部署状态稿已改正为“服务层 309 发布成功、真实桌面授权仍待完成”，不再误写仍运行 304。
- 本交接和授权相关文档单独形成 docs 提交。远程分支为 origin/feature/phase3-scheduled-desktop；接手先 git fetch origin，再通过 git log/status 核对实际最新提交，不依赖本文自指 HEAD。
- tmp/release-v1.1.38-progress.md 是其他平台 Skill 发布的本机临时记录，不属于本次桌面代码交接，保留本机但不加入本次提交。不能将它尚未跟踪误解为桌面功能漏提交。

接手先检查 git status，再 npm ci。启动命令：npm run desktop:dev；打包但不发布：npm run desktop:pack。Mac 开发启动会构建原生托盘；浏览器直接打开 HTML 不等于完整 Electron 运行环境。

建议隔离开发数据，避免触碰日常 Bridge 数据：

```sh
GECHO_DATA_DIR="$(mktemp -d -t gecho-ui-dev)" npm run desktop:dev
```

这只隔离 Bridge/账号/偏好数据，不代表完全隔离 Electron userData 或单实例锁。若已有 Gecho 运行，不要强制杀进程；先确认运行归属，真实 Electron 测试使用现有隔离测试入口。

开发源码不会因为 build.extraMetadata 配了授权地址就自动启用登录。需要真实授权时，由功能负责人确认 GECHO_ACCOUNT_AUTH_URL；UI 预览可显示 unavailable 或使用明确的隔离模拟状态，不把配置缺失当视觉问题处理。

## 7. 验证与验收

2026-10-18 本次执行以下针对性测试：17 项通过，无失败、无跳过；包括 HTTP/插件模拟联调、自动到点派发、重启恢复、并发与账号地址配置。

```sh
node --test test/scheduled-task.test.js test/scheduled-task-store.test.js test/scheduled-task-scheduler.test.js test/scheduled-task-http.test.js test/desktop-account-config.test.js
```

历史真实 Electron、授权互操作与守护能力测试见 docs/desktop-hardening.md、docs/desktop-account-authorization.md；本次没有重跑全量桌面测试，没有新增截图或真实用户授权验收。历史测试总数不同对应不同切片，不应直接视为今天全量通过。

提交前补充验证（2026-10-18）：node --test test/*.test.js 共 118 项，115 通过、3 项按现有开关跳过、0 失败。本次没有启用这些可选的真实 Electron/服务层互操作测试，不把自动跳过记录成已通过。

UI 修改后至少验证：

1. 真实 Electron 中打开/关闭/重开面板，重新订阅不重复；无脚本报错。
2. 窄窗口、深浅主题、中英文、键盘焦点和长错误文案可用。
3. 账号、扩展和网络状态分别表达；异常不显示假成功。
4. 浏览器选择、偏好保存、自检及更新错误/进度展示仍可用。
5. 演示任务明确标注；接真实数据前不显示“成功采集 N 条”。
6. 不放开 contextIsolation，不开启 nodeIntegration，不新增任意执行/文件访问 IPC；不把刷新凭证或官网 Cookie 暴露给 UI。已有 getLocalToken 是本机 Bridge 凭证，不是官网账号 Token，视觉改动不应新增读取或展示它。

## 8. 推荐交接顺序与首轮 AI 指令

产品先确认面板主要解决“任务管理”还是“本地引擎状态”，以及任务创建留在官网还是桌面；这些是待决策项，不必先定所有视觉细节。

首轮只做面板视觉与状态表达 → 产品验收 → 功能开发把任务 IPC 接到真实调度器 → 独立完成官网授权与任务同步联调。UI 工作不需要等授权问题全部解决。

可交给产品 AI：

> 先读 docs/phase3-desktop-ui-handoff.md，核对分支、工作区和 desktop/preload.js。请根据我提供的设计要求迭代 desktop/renderer 与 i18n 面板，不重写桌面主进程、调度器、鉴权或更新模块，不覆盖已有未提交改动。第一步给出面板信息架构及需要展示的真实/演示状态；随后只实现一个可验收的 UI 切片，保留既有 IPC 契约。缺少业务接口时列出缺口，不自行假造成功响应。完成后给出改动文件、真实 Electron 验证结果和未完成项。不要发布、推送或操作生产配置。

下一位接收者核对工作区后，在本文件追加接收人/工具、时间和本轮范围；开始业务接口开发前重新确认负责人，避免多个 AI 同时改 main.js。
