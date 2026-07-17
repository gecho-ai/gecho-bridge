# Gecho 本地定时自动化方案

日期：2026-07-17  
状态：第一期已实现

## 1. 结论

Gecho 不需要拆成“通用 Agent + Bridge + 插件”“官网 Web + 插件”“插件独立使用”三套独立产品。它们只是同一套 Extension 能力的不同入口。

所有需要用户浏览器登录态、打开目标网站、读取页面数据的任务，最终都应由浏览器 Extension 执行：

```text
调度器 → Bridge → 浏览器/Extension → 目标页 Content Script → 采集结果
```

基础定时采集建议由 **本地 Bridge** 负责调度；通用 Agent 仅用于需要 AI 动态规划的高级任务。Extension 定时仅作为浏览器已长期运行时的轻量补充，不能承担无人值守调度。

## 2. 问题拆分

定时自动化涉及三个相互独立的问题：

1. **何时执行**：保存任务和下次执行时间。
2. **谁发起执行**：到点后向 Extension 派发采集任务。
3. **执行环境如何可用**：电脑睡眠、浏览器关闭或插件断开时，如何恢复 Bridge、浏览器与 Extension。

当前 Bridge 已具备部分第三项能力：当插件断开且 Bridge 已记录最近连接的浏览器时，Bridge 可自动启动该浏览器并等待 Extension 重连。

## 3. 三种调度位置

| 方案 | 调度者 | 浏览器关闭时 | 电脑睡眠时 | 复杂度 | 建议用途 |
|---|---|---|---|---|---|
| 通用 Agent 定时 | OpenClaw/Hermes/其他 Agent | Agent 还需管理本地浏览器与 Bridge | 还要处理系统唤醒 | 高 | 需要 AI 动态决定任务内容、频率或后续动作 |
| Bridge 本地定时 | 本地 Bridge | 可由 Bridge 启动已识别的浏览器 | 可进一步接入系统唤醒 | 中 | 基础定时采集的主方案 |
| Extension 定时 | 浏览器 Extension Alarm | 浏览器未运行时不可靠 | 无法唤醒电脑 | 低 | 浏览器通常持续打开的轻量提醒或任务 |

结论：基础定时采集应采用 **Bridge 本地定时**，而不是依赖通用 Agent。

## 4. 目标架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Bridge                                                       │
│  ├─ JobStore：任务、下次执行时间、运行记录、失败重试          │
│  ├─ Scheduler：计算到期任务                                  │
│  ├─ WakeScheduler：向操作系统登记下一次唤醒事件（可选）      │
│  ├─ BrowserLauncher：启动最近成功连接的 Edge/Chrome          │
│  └─ WebSocket Relay：等待 Extension 重连并派发任务           │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 Browser Extension / Content Script
                              │
                              ▼
                       TikTok / X / Amazon 等网页
```

### 4.1 BrowserLauncher 的当前约束

- Bridge 通过 Extension WebSocket 握手的 `User-Agent` 识别 Edge 或 Chrome，并保存最近一次成功连接的浏览器。
- 插件未连接时，Bridge 启动该浏览器并等待 Extension 重连。
- 首次尚未连接过的设备，Bridge 默认启动已安装的 **Google Chrome**；若未安装 Chrome，则回退启动 Microsoft Edge。首次启动后仍需要用户确认目标浏览器已安装 Gecho Extension。
- 可通过高级配置 `GECHO_BROWSER=chrome` 或 `GECHO_BROWSER=edge` 覆盖默认选择；已成功连接过时，则优先使用最近一次记录的浏览器。
- 多浏览器同时安装插件时，应在产品层明确“默认自动化浏览器”，避免最后连接的浏览器覆盖用户预期。

### 4.2 已验证：已登录状态下的锁屏采集

2026-07-15 在本机完成了一次端到端验证：先保持 Bridge、Edge 和 Extension 已连接，再使用 macOS 的 `Control + Command + Q` 锁定屏幕；锁屏后由 Bridge 发起 `tiktok_influencer` 异步任务。

| 项目 | 结果 |
|---|---|
| 任务 | `tiktok_influencer`，账号 `zachking` |
| 执行时间 | 22:00:03 至 22:00:36（约 33 秒） |
| 结果 | 成功完成，返回 81 条数据并写入本地文件 |
| 浏览器 | Edge |

因此，第一期可以支持并表述为：**在 macOS 已登录、屏幕锁定但电脑未睡眠时，Bridge + 浏览器 Extension 可以继续完成后台采集。**

该验证不覆盖“合盖”。合上 MacBook 盖子通常会令设备进入睡眠，Bridge、浏览器及 Extension 会暂停；它不是单纯的锁屏。外接电源和显示器的合盖模式可能保持运行，但不应作为普通用户的默认能力承诺。

### 4.3 已验证：Bridge 本地定时执行

2026-07-17 在本机最新 Bridge 上创建了两次一分钟后的 `once` 定时任务。两次都由 Bridge 到点自行派发到 Extension，并通过任务运行记录关联异步采集结果。

| 计划时间（北京时间） | 任务 | 执行结果 | 结果文件 |
|---|---|---|---|
| 10:54:49 | `tiktok_influencer`，`zachking` | 完成，78 条，约 9 秒 | `/tmp/gecho-schedule-test/tiktok_influencer_zachking_results.json` |
| 11:00:14 | `tiktok_influencer`，`zachking` | 完成，49 条，约 15 秒 | `/tmp/gecho-schedule-test-2/tiktok_influencer_zachking_results.json` |

本轮验证覆盖：创建任务、持久化、到点触发、异步派发、Extension 回传、运行记录和结果落盘。锁屏执行的结论仍以 4.2 中已明确确认的测试为准；本轮未将锁屏状态作为验收条件记录。

## 5. 分期方案

### 第一期：定时但不主动唤醒电脑

目标：先提供无需管理员权限的稳定定时能力。

```text
Bridge 保存任务
→ 到点时电脑醒着或仅锁屏：启动浏览器、等待插件、执行采集
→ 到点时电脑睡眠：记录 missed / pending
→ 下次 Bridge 恢复、用户唤醒电脑或浏览器重连：按策略补跑
```

已实现：

- JobStore：任务定义、参数、时区、下一次运行时间、状态与最近 100 次运行记录持久化到 Bridge 数据目录。
- Scheduler：支持单次、每日、每周规则；Bridge 重启后恢复未完成计划。
- 执行策略：`run_once`（默认立即补跑）、`skip`（跳过）、`window`（仅在时间窗口内补跑）。
- 可观察性：任务列表、下一次执行时间、执行历史、关联异步任务 ID、Extension 连接状态与失败原因。
- 执行器：到点后复用已有异步 action 链路；插件断开时自动启动已识别浏览器并等待 Extension 重连。

优点：不需要系统权限，不依赖 Agent，能够覆盖大多数“电脑平时开着”的用户。

### 第二期：macOS 定时唤醒（可选授权）

目标：支持 Mac 睡眠状态下的无人值守任务。

```text
Bridge 计算最近一次待执行任务
→ 提前向 macOS 登记唤醒时间
→ macOS 唤醒
→ Bridge 恢复或由 LaunchAgent 启动
→ Bridge 拉起浏览器，等待 Extension
→ 下发采集任务并保存结果
```

macOS 可通过 `pmset schedule` 或 `pmset repeat` 登记 wake/poweron 事件。注意：

- `pmset` 修改电源计划需要管理员权限；纯 npm 包不能静默获取该权限。
- `repeat` 只支持一组重复的开机/关机事件；多个业务任务必须由 Bridge 汇总为“下一次唤醒时间”，而不是每个任务各自注册重复计划。
- 必须以一次性、明确的用户授权方式安装特权 Helper/LaunchDaemon，或每次由用户授权；前者体验更好，但安装与安全审计成本更高。
- 睡眠唤醒可作为目标；完全关机、FileVault 登录前、未进入用户桌面会话时，无法可靠运行浏览器 Extension。
- 唤醒后必须等待网络、浏览器、Extension 重连；任务不能假设唤醒瞬间即可执行。

建议产品交互：提供“允许 Gecho 为定时任务唤醒此 Mac”的开关，默认关闭，首次开启时由系统弹出管理员授权。

### 第三期：Windows 定时唤醒

目标：通过 Windows Task Scheduler 创建带 `WakeToRun` 的任务。

注意：是否能唤醒取决于硬件和系统是否允许 wake timer；应在安装/设置时做能力检测，并提供失败提示。Windows Task Scheduler 的 `WakeToRun` 会在任务到期时唤醒电脑，但屏幕可能保持关闭。

## 6. 不在首期范围内

- 从完全关机且 FileVault/Windows 登录界面停留状态自动进入用户桌面。
- 无需任何授权地修改操作系统电源计划。
- 用 Extension Alarm 作为睡眠唤醒方案。
- 将基础定时任务强制绑定到 OpenClaw/Hermes 等通用 Agent。

## 7. 关键验收标准

第一期：

1. Bridge 重启后仍能恢复待执行任务。
2. 浏览器关闭时，Bridge 能启动已识别浏览器并等到 Extension 连接。
3. Extension 未连接、登录失效、页面 CAPTCHA、采集超时等状态可区分并记录。
4. 电脑睡眠期间错过的任务按用户选择的补跑策略执行。
5. 在已登录、仅锁屏且不休眠的 macOS 会话中，任务可以正常执行；合盖睡眠不属于第一期支持范围。
6. 本机已完成两次 Bridge 单次定时任务实测，均成功派发并完成 TikTok influencer 采集（详见 4.3）。

第二期：

1. 用户明确授权后，Mac 从普通睡眠状态可在计划时间前唤醒。
2. 唤醒后 Bridge、浏览器与 Extension 都通过健康检查后才派发任务。
3. 无法唤醒、无法登录或未连接 Extension 时，任务有可解释的失败记录，不无限重试。

## 8. 用户如何设置定时任务

Bridge 应是任务定义、任务状态和调度执行的唯一所有者；不同客户端只负责创建和管理任务，不能各自维护一套定时器。这样即使 Agent、官网或 Extension 不在运行，已创建任务仍由本地 Bridge 按计划执行。

Bridge 已实现第一期本地调度：任务持久化到 Bridge 数据目录；到点后复用现有的“启动浏览器 / 等待 Extension / 异步采集”链路；Bridge 重启后会恢复未完成计划。调度器只保存 `action + params`，因此任何已由 Extension 支持的采集 action 都可定时；实际能否无人值守完成仍取决于登录态、页面和验证码等条件。

第一期 API：

| 接口 | 用途 | 当前状态 |
|---|---|
| `POST /scheduled-jobs` | 创建任务 | 已实现 |
| `GET /scheduled-jobs`、`GET /scheduled-jobs/:id` | 查询任务与下次时间 | 已实现 |
| `PATCH /scheduled-jobs/:id` | 修改任务、规则、参数、补跑策略、启用或停用 | 已实现 |
| `DELETE /scheduled-jobs/:id` | 删除未来计划 | 已实现；不会中断已派发的采集 |
| `GET /scheduled-jobs/:id/runs` | 查询执行记录与失败原因 | 已实现；记录关联 `asyncJobId`，再用 `/async-status?jobId=` 获取采集结果 |

支持的规则：

| `schedule.type` | 字段 | 含义 |
|---|---|---|
| `once` | `runAt`（ISO-8601） | 在指定时刻执行一次 |
| `daily` | `time`（`HH:mm`）、`timezone` | 每天本地时区的指定时间执行 |
| `weekly` | `days`（0=周日至6=周六）、`time`、`timezone` | 每周指定星期和时间执行 |

创建一次性任务的请求示例：

```json
{
  "action": "tiktok_influencer",
  "params": {
    "uniqueId": "zachking",
    "targetCount": 100
  },
  "schedule": {
    "type": "once",
    "runAt": "2026-07-17T10:00:00+08:00"
  },
  "enabled": true
}
```

每日任务示例：

```json
{
  "action": "tiktok_influencer",
  "params": { "uniqueId": "zachking", "targetCount": 100 },
  "schedule": { "type": "daily", "time": "09:00", "timezone": "Asia/Shanghai" },
  "misfirePolicy": "window",
  "misfireWindowMs": 3600000,
  "enabled": true
}
```

`misfirePolicy` 定义电脑睡眠、Bridge 未运行等原因错过计划时间后的行为：

- `run_once`：Bridge 恢复可用后补跑一次。
- `skip`：跳过本次，计算下一个计划时间。
- `window`：仅在 `misfireWindowMs` 指定窗口内补跑；超出则跳过。

第一期不开放自由 cron 表达式；单次、每日和每周规则覆盖产品界面需要的主路径，避免用户配置难以解释的复杂表达式。若后续有高级用户需求，再新增 cron 兼容层。

### 8.1 配置入口的分期

| 入口 | 用户如何设置 | 适合阶段 | 说明 |
|---|---|---|---|
| Agent | 用户直接说“每天 9 点采集某账号”，Agent 调用 Bridge API | 第一期 | 开发成本最低；任务创建后不依赖 Agent 常驻。 |
| 命令行 | 通过 curl 或后续 CLI 调用 Bridge API | 第一期 | 适合测试、排障和高级用户。 |
| Extension 设置页 | 在插件内选择任务、频率、时区与补跑策略 | 第二期 | 体验更直观，但需要前端开发。 |
| 官网 | 在网页管理任务，再与本机 Bridge 配对 | 后续 | 需要设计本机配对、鉴权与跨域访问，不能直接假设官网可访问用户 localhost。 |

第一期建议先完成通用 Bridge API，并提供 Agent/命令行入口；任务模型和执行策略稳定后，再为 Extension 或官网增加可视化管理界面。

## 9. 建议决策

1. 第一期已完成：Bridge 本地 Scheduler + 醒着/锁屏执行 + 睡眠后按策略补跑。
2. “自动启动已识别浏览器并等待插件重连”已作为第一期执行器能力。
3. macOS 自动唤醒仍单独作为第二期、显式授权的桌面端能力；不要把它伪装成无权限的 npm 功能。
4. 通用 Agent 保留为高级编排入口，不作为基础调度依赖。

## 参考

- 本机 `man pmset`：`pmset` 需要 root 修改设置，支持 `wakeorpoweron`；重复事件仅允许一组开机/关机计划。
- [Windows Task Scheduler: WakeToRun](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-waketorun)
- [Windows wake timers / powercfg](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options)
