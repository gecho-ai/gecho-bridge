# Gecho Bridge 本地定时自动化方案

日期：2026-07-18
负责人：Bridge / Extension
文档状态：macOS 二期已完成实机验收；Windows 一期链路已实测，自动唤醒在目标 S0 Modern Standby 设备上未通过

## 1. 结论与当前状态

Gecho 是一套以浏览器 Extension 为执行端的能力：无论任务从 Agent、官网还是 Extension 界面发起，只要需要复用用户浏览器登录态并读取网页，最终执行链路都应统一为：

```text
调度入口 → 本地 Bridge → 浏览器 / Extension → 目标网页 → 结果
```

基础定时能力由本地 Bridge 持有任务和调度权；Agent 只负责创建、管理或编排任务，不应成为任务必须常驻的依赖。

| 能力 | 状态 | 对用户的承诺 |
|---|---|---|
| Bridge 本地定时（单次、每日、每周） | 已实现、已实测 | 支持 |
| 浏览器关闭后启动已识别浏览器并等待插件重连 | 已实现 | 支持，仍依赖浏览器/插件/登录态可恢复 |
| 已登录会话下的锁屏采集 | macOS、Windows 均已实测 | 支持已登录且未休眠的锁屏场景；不等于自动登录或解锁 |
| 睡眠期间的错过任务处理 | 已实现 | 依 `run_once` / `skip` / `window` 策略处理 |
| macOS 自动唤醒 | 已实现、已实机验收、需用户显式授权 | 支持 macOS 普通休眠场景 |
| Windows 在线状态下的本地定时和浏览器启动 | 已实现、已实机验收 | 支持 Bridge 运行且系统未休眠的场景，包括浏览器关闭后的自动拉起 |
| Windows 休眠后补跑 | 已实现、已实机验收 | 手动或其他方式唤醒后，按 `run_once` / `skip` / `window` 策略处理错过任务 |
| Windows 自动唤醒 | 已实现实验适配、目标设备验收失败 | 暂不作通用支持承诺；目标 S0 设备会将 Task Scheduler 和原生唤醒计时器延后到人工唤醒后 |
| 合盖、完全关机、FileVault 登录前自动执行 | 未支持 | 不支持 |

## 2. 为什么由 Bridge 调度

定时自动化有三个独立问题：

1. **何时执行**：保存任务和计算下次运行时间。
2. **谁派发任务**：到点后将任务发送给 Extension。
3. **执行环境是否可用**：Bridge、浏览器和 Extension 在浏览器关闭、锁屏或休眠后能否恢复。

| 调度位置 | 优点 | 局限 | 定位 |
|---|---|---|---|
| 通用 Agent（OpenClaw/Hermes 等） | 适合 AI 动态规划 | 仍要管理本机 Bridge、浏览器和休眠 | 高级编排入口 |
| 本地 Bridge | 可持久化、可恢复、离浏览器最近 | 休眠唤醒需额外系统授权 | 基础定时主方案 |
| Extension Alarm | 实现轻 | 浏览器关闭或电脑休眠时不可靠 | 轻量补充，不做无人值守基础 |

因此，所有客户端只调用 Bridge 的同一套任务 API，Bridge 是任务定义、调度状态和运行记录的唯一所有者。

## 3. 架构与浏览器选择

```text
Bridge
 ├─ JobStore：任务、下次执行时间、运行记录
 ├─ Scheduler：到期、补跑、重启恢复
 ├─ BrowserLauncher：启动最近成功连接的 Edge / Chrome
 ├─ WebSocket Relay：等待 Extension 重连、派发任务
 └─ WakeScheduler：二期可选；登记下一次系统唤醒
                    ↓
          Browser Extension / Content Script
                    ↓
              TikTok / X / Amazon 等页面
```

### 浏览器选择规则

- Bridge 从 Extension WebSocket 握手的 `User-Agent` 识别 Chrome 或 Edge，并记录最近一次成功连接的浏览器。
- 插件断开时，优先启动该已记录浏览器，再等待 Extension 重连。
- 设备第一次尚无连接记录时，默认启动 **Google Chrome**；若 Chrome 不存在，则回退 **Microsoft Edge**。
- 可用 `GECHO_BROWSER=chrome` 或 `GECHO_BROWSER=edge` 显式覆盖。
- 首次自动启动不能保证该浏览器已安装插件，因此用户仍需至少手动打开一次目标浏览器、安装 Extension 并完成网站登录。

## 4. 一期：本地定时，不主动唤醒电脑

### 能力范围

```text
创建任务 → Bridge 持久化
        → 到点时：浏览器可用则派发；浏览器关闭则启动并等待插件
        → 电脑睡眠错过：按补跑策略处理
        → 异步采集完成：保存运行记录和结果位置
```

一期不修改系统电源计划，也不要求管理员权限。它覆盖“电脑平时开着，或只是锁屏”的主要场景。

### 已实现的 API

| 接口 | 用途 |
|---|---|
| `POST /scheduled-jobs` | 创建任务 |
| `GET /scheduled-jobs`、`GET /scheduled-jobs/:id` | 查询任务、状态和下次时间 |
| `PATCH /scheduled-jobs/:id` | 修改规则、参数、补跑策略、启停 |
| `DELETE /scheduled-jobs/:id` | 删除未来计划；不取消已派发采集 |
| `GET /scheduled-jobs/:id/runs` | 查询执行记录、失败原因、关联 `asyncJobId` |
| `GET /async-status?jobId=...` | 查询异步采集结果 |

任务规则：

| `schedule.type` | 必填字段 | 含义 |
|---|---|---|
| `once` | `runAt`（ISO-8601） | 在指定时刻执行一次 |
| `daily` | `time`（`HH:mm`）、`timezone` | 每天指定时间执行 |
| `weekly` | `days`（0=周日）、`time`、`timezone` | 每周指定日期和时间执行 |

错过计划时间时：

- `run_once`：Bridge 恢复可用后补跑一次（默认）。
- `skip`：跳过本次并计算下一次运行。
- `window`：仅在 `misfireWindowMs` 窗口内补跑，超出后跳过。

一期仅开放单次、每日、每周规则；暂不开放自由 cron，避免配置和补跑行为难以解释。

### 创建任务示例

```json
{
  "action": "tiktok_influencer",
  "params": { "uniqueId": "zachking", "targetCount": 100 },
  "schedule": {
    "type": "daily",
    "time": "09:00",
    "timezone": "Asia/Shanghai"
  },
  "misfirePolicy": "window",
  "misfireWindowMs": 3600000,
  "enabled": true
}
```

任何已经由 Extension 支持的 `action` 都可以创建定时任务；是否能无人值守完成仍取决于目标网站登录态、页面变化、验证码和网络。

## 5. 已完成的验收证据

### 5.1 macOS 锁屏采集

2026-07-15，本机保持 Bridge、Edge 和 Extension 已连接后，用 macOS `Control + Command + Q` 锁屏，再发起 `tiktok_influencer` 异步任务。

| 项目 | 结果 |
|---|---|
| 账号 | `zachking` |
| 执行时间 | 22:00:03 至 22:00:36，约 33 秒 |
| 结果 | 成功写入 81 条数据 |
| 浏览器 | Edge |

结论：在 **macOS 已登录、仅锁屏且未进入休眠** 的前提下，Bridge、浏览器和 Extension 可后台完成采集。

### 5.2 macOS 本地定时采集

2026-07-17，本机创建了两次一分钟后的 `once` 任务，均由 Bridge 到点派发给 Extension，并在运行记录中关联异步结果。

| 计划时间（北京时间） | 结果 | 结果文件 |
|---|---|---|
| 10:54:49 | 完成 78 条，约 9 秒 | `/tmp/gecho-schedule-test/tiktok_influencer_zachking_results.json` |
| 11:00:14 | 完成 49 条，约 15 秒 | `/tmp/gecho-schedule-test-2/tiktok_influencer_zachking_results.json` |

本轮覆盖创建、持久化、到点触发、异步派发、Extension 回传、运行记录和结果落盘。该轮没有将锁屏作为验收条件；锁屏结论以 5.1 为准。

### 5.3 macOS 普通休眠后的自动唤醒与采集

2026-07-17，本机在普通休眠状态下完成二期端到端验收。任务创建时 Bridge 与 Extension 无需预先保持连接；Bridge 在唤醒后自动恢复浏览器/Extension 链路。

| 项目 | 结果 |
|---|---|
| 任务 | `tiktok_influencer`，账号 `zachking`，目标 10 条 |
| 计划唤醒 | 16:25:01，任务前 10 秒 |
| 系统证据 | `pmset -g log` 记录 `Wake from Deep Idle`，时间为 16:25:01 |
| 计划任务时间 | 16:25:11 |
| Bridge 派发 | 16:25:20，自动启动/等待浏览器 Extension 后派发 |
| 防休眠 | `caffeinate -i` 在派发期间生效，任务完成后自动退出 |
| 结果 | 16:25:34 完成，写入 62 条数据 |

结论：在 macOS 用户会话已登录、设备处于普通休眠且未合盖的条件下，Bridge 可以自动唤醒系统、恢复浏览器 Extension 通信并完成定时采集。

### 5.4 Windows 活跃状态下的定时与浏览器自动恢复

2026-07-17，在 Windows 活跃状态下创建一次性任务，并在执行前关闭浏览器、断开 Extension。到点后 Bridge 自动拉起 Edge，等待 Extension 重连并完成采集。

| 项目 | 结果 |
|---|---|
| 任务 ID | `schedule-1784298751113-1` |
| 计划时间 | 22:37:31.021 |
| 恢复链路 | Edge 原本关闭且 Extension 断连；Bridge 到点自动启动 Edge 并等待重连 |
| 结果 | 22:37:47 完成，写入 62 条数据 |
| 结果文件 | `data/windows-schedule-test/tiktok_influencer_zachking_results.json` |

结论：Windows 未休眠时，本地定时、浏览器自动拉起、Extension 重连、派发、回传和结果落盘链路通过。该轮传入 `targetCount: 10` 却返回 62 条，是独立的下游参数/采集数量问题，不影响本轮调度结论。

### 5.5 Windows 锁屏采集

2026-07-17，在保持用户登录的前提下使用 `Win + L` 锁屏，让一次性任务跨过计划时间。

| 项目 | 结果 |
|---|---|
| 任务 ID | `schedule-1784299530945-4` |
| 计划时间 | 22:48:30.857 |
| Bridge 开始 | 22:48:30.871，约晚 14 毫秒 |
| 派发 | 22:48:33.542 |
| 完成 | 22:48:45.995，写入 33 条数据 |
| 结果文件 | `data/windows-lockscreen-test/tiktok_influencer_zachking_results.json` |

结论：Windows **已登录、仅锁屏且未休眠** 时任务可正常执行。锁屏是否设置密码不改变后台调度结论；关键是用户会话仍保持登录。注销、切换到尚未登录的会话或需要自动解锁不在支持范围内。

### 5.6 Windows 休眠后的 `run_once` 补跑

2026-07-17，使用 Windows Kernel-Power 事件确认设备确实进入 Modern Standby，并让任务计划时间落在休眠区间内。

| 项目 | 结果 |
|---|---|
| 进入 Modern Standby | 23:12:58 |
| 计划任务时间 | 23:15:03.566 |
| 人工唤醒 | 23:21:30，系统记录唤醒源为鼠标输入 |
| Bridge 开始 | 23:21:29.373，比计划时间晚 385.807 秒 |
| 调度结果 | 唤醒后按 `run_once` 补跑；后续前端/采集异常不计入本轮调度验收 |

结论：Windows 休眠期间 Bridge 进程和用户态计时器暂停；人工唤醒后，错过的任务会按 `run_once` 策略补跑。本轮验证的是“休眠后补跑”，不是“Bridge 自动唤醒 Windows”。此前仅观察到黑屏、但任务仍在计划时间准点执行的两轮，不足以证明电脑已经休眠，因此不作为休眠测试证据。

### 5.7 Windows Task Scheduler 自动唤醒实验

Bridge 已实现 Windows Task Scheduler 适配：只维护 Gecho 自己的下一条一次性任务，任务 XML 包含 `<WakeToRun>true</WakeToRun>`，使用当前已登录用户的 `InteractiveToken` 和最低权限运行，不保存用户密码。实测时还确认当前交流电源计划已允许唤醒计时器。

| 轮次 | 休眠进入 | 计划唤醒 / 计划任务 | 实际恢复 | 结果 |
|---|---|---|---|---|
| 1 | 07-17 23:55:24 | 23:59:21 / 23:59:31 | 07-18 00:11:13，鼠标输入 | 未自动唤醒；Bridge 人工唤醒后开始，任务约晚 701.969 秒 |
| 2 | 07-18 00:16:02 | 00:19:25 / 00:19:35 | 00:20:35，鼠标输入 | 开启交流电唤醒计时器并修复执行保护脚本后仍未自动唤醒；任务约晚 59 秒 |

结论：`WakeToRun` 配置本身已正确落入系统任务，但在目标 Windows 设备上没有把系统从 Modern Standby 唤醒。该适配只能保留为实验能力，不能据此向所有 Windows 用户承诺自动唤醒。

### 5.8 Windows 原生 Waitable Timer POC

为排除 Task Scheduler 层的影响，又实现了 `CreateWaitableTimer` + `SetWaitableTimer(fResume=true)` 的原生计时器 POC。

| 项目 | 结果 |
|---|---|
| 进入 Modern Standby | 07-18 00:30:36 |
| 原生计时器 | 计划 00:32:31.522 触发 |
| 计划任务时间 | 00:32:41.522 |
| 实际恢复 | 00:39:32，鼠标输入 |
| 计时器回调 | 00:39:32.278，仅在人工唤醒后返回 |
| Bridge 开始 | 00:39:32.052，任务约晚 410.530 秒 |

结论：原生 `fResume=true` 计时器在这台 S0 设备上同样被延后到人工唤醒之后，不是可用替代方案。该 POC 默认关闭，仅在显式设置 `GECHO_WINDOWS_NATIVE_WAKE_TIMER=1` 时启用，不能作为正式能力。

## 6. 设备状态与能力边界

| 设备状态 | 已验证表现 | 自动唤醒边界 |
|---|---|---|
| 已登录、屏幕锁定 | macOS、Windows 均可执行，已实测 | 不需要系统唤醒 |
| 普通休眠 | 进程与用户态定时器暂停；恢复后按补跑策略处理 | macOS 已通过；目标 Windows S0 设备未通过 |
| 合盖 | 通常会进入睡眠，不等于锁屏 | 不做默认承诺，需按平台、硬件和外接显示器单独验证 |
| 完全关机、FileVault 或登录界面 | 无法执行 | 不支持绕过登录进入桌面 |

“锁屏”不等于“合盖”：锁屏时用户会话通常仍在运行；合盖通常让 Mac 睡眠。即使二期唤醒成功，也不会绕过锁屏密码；用户必须保持 macOS 用户会话已登录。

### 6.1 Windows 当前边界

目标 Windows 设备仅支持 **S0 Low Power Idle / Modern Standby（联网待机）**，不支持 S1、S2、S3 或混合睡眠。当前实测结论如下：

- **活跃和锁屏：已通过。** Bridge 运行且 Windows 未休眠时，定时任务可在计划时间执行；浏览器关闭时可自动拉起 Edge 并等待 Extension 重连。锁屏有无密码不影响已经登录的后台会话，但 Bridge 不会自动输入密码、登录或解锁。
- **休眠后补跑：已通过。** 任务时间落在真实 Modern Standby 区间内时，人工唤醒后会按 `run_once` 等错过任务策略处理。
- **自动唤醒：未通过。** Task Scheduler `WakeToRun` 与 `SetWaitableTimer(fResume=true)` 均在人工唤醒后才继续，不能在本机按时唤醒系统；即使交流电源计划已启用唤醒计时器，结果也没有改变。
- **关机和未登录状态：不支持。** 当前交互式用户必须保持登录；不覆盖注销、登录界面、BitLocker 启动前或完全关机。

判断是否真的休眠必须查看系统 Kernel-Power 进入/退出 Modern Standby 事件；**屏幕变黑不等于已经休眠**。产品默认应只承诺“活跃/锁屏准点执行”和“系统恢复后的策略化补跑”。Windows 自动唤醒适配保留为实验能力，并按设备单独验证。

若业务要求锁屏后仍严格准点，可提供显式的 `keep_awake` 模式：在任务前阻止系统进入真实休眠，允许锁屏和屏幕关闭，到点后直接执行。但这不是“休眠后自动唤醒”，会增加待机耗电，当前尚未作为正式调度模式完成验收。真正的外部唤醒只能另行评估 Wake-on-LAN、BIOS/UEFI RTC 等方案，它们不属于只依赖 Bridge 的能力。

## 7. 二期：macOS 自动唤醒（已实现并通过实机验收）

二期是一期的增强，而不是另一套采集系统：

```text
系统在任务前从普通休眠唤醒
        ↓
一期链路：Bridge → 浏览器 / Extension → 采集 → 保存结果
```

### 已实现的授权与执行链路

Bridge 的 `WakeScheduler` 默认关闭。启用后，它只针对**最近一次待执行任务**登记一次性 `pmset schedule wake`，任务变更时更新计划；使用专属 owner，只取消自身记录的事件，不使用 `pmset repeat` 或 `pmset cancelall`。

用户通过下列 CLI 显式管理这项系统级能力：

```bash
gecho-bridge wake enable
gecho-bridge wake status
gecho-bridge wake disable
gecho-bridge wake uninstall
```

执行前必须先启动一次已配置的 MCP 客户端，使 Bridge 正在运行；CLI 会通过运行中的 Bridge 找到实际任务数据目录。若 Bridge 通过 `npx` 配置而不是全局安装，请使用同一版本的包执行，例如：`npx -y @gecho-ai/gecho-bridge@<版本号> wake enable`。

首次执行 `wake enable` 时，CLI 会请求一次 macOS 管理员授权，安装 root-owned 的受限 Helper 和仅指向该 Helper 的 sudoers 规则。此后 Bridge 只能通过 Helper 登记、取消或查询 **Gecho 自己** 的一次性 wake 事件；它不能执行任意 shell 命令，也不能取消其他应用的唤醒计划。`wake disable` 停止后续计划并取消已登记事件；`wake uninstall` 会额外删除 Helper 和 sudoers 规则。

已完成 dry-run 与真实端到端验证。实际验收中，`pmset` 在任务前 10 秒将设备从 Deep Idle 唤醒；Bridge 在任务到点后自动启动 `caffeinate -i`，保持系统运行直至浏览器 Extension 回传采集结果。该能力仍需用户显式授权，且仅承诺普通休眠场景。

开发配置：

| 项目 | 说明 |
|---|---|
| `GECHO_WAKE_SCHEDULER_ENABLED=1` | 开启原型 |
| `GECHO_WAKE_SCHEDULER_DRY_RUN=1` | 只计算命令，建议开发时启用 |
| `GECHO_WAKE_SCHEDULER_LEAD_MS=10000` | 任务前 10 秒登记唤醒；最低 10 秒，避免系统过早再次休眠 |
| `GECHO_WAKE_EXECUTION_GUARD_MS=450000` | 任务派发时以 `caffeinate -i` 暂时阻止空闲休眠；默认 7.5 分钟，采集完成即提前释放 |
| `GET /wake-scheduler/status` | 查看计划和错误 |
| `POST /wake-scheduler/refresh` | 重新计算下一次计划 |
| `POST /wake-scheduler/cancel` | 取消 Bridge 自己登记的事件 |

### 用户授权流程

不需要先开发桌面 App：

```text
用户手动执行 gecho-bridge wake enable
        ↓
首次管理员授权
        ↓
安装 root-owned、功能受限的 Wake Helper
        ↓
Bridge 通过 Helper 维护 Gecho 自己的一次性 wake 事件
```

Helper 仅允许“登记 Gecho 唤醒”“取消 Gecho 唤醒”“查询状态”三类固定操作；不得接受任意 shell 命令，也不得使用 `cancelall`。用户可通过 `wake status` 查看状态、通过 `wake disable` 停用计划，并通过 `wake uninstall` 撤销本功能安装的 sudoers 授权。

真实验收时需在正常睡眠（非合盖）下验证：任务前 10 秒登记唤醒 → macOS 唤醒 → Bridge 立即通过 `caffeinate -i` 保持运行 → 浏览器/Extension 恢复 → 任务完成并留存运行记录。网络、浏览器启动和插件重连均应设有可解释的超时与失败记录。

## 8. 用户流程

### 一期

1. 安装 Bridge 和浏览器 Extension。
2. 至少手动打开一次已安装 Extension 的 Chrome 或 Edge，并完成目标网站登录。
3. 通过 Agent、命令行或后续 Extension 设置页创建定时任务。
4. 用任务列表、`/runs`、关联 `asyncJobId` 或结果文件查看执行结果。

任务创建后不依赖 Agent 常驻。浏览器首次未被识别时默认优先 Chrome；建议用户确认自动化使用的浏览器和登录态。

### 二期

完成一期配置后，用户主动开启“允许 Gecho 唤醒此 Mac”，完成一次管理员授权。Bridge 只在下一次任务前登记唤醒；唤醒以后仍由一期负责浏览器恢复、Extension 重连和采集。

## 9. OpenClaw / ClawHub 发布边界

一期 Skill 或插件只调用 Bridge 的采集与定时 API，不执行 `sudo`、不安装 Wake Helper、也不修改系统电源计划。自动唤醒必须是用户在本机显式开启的 Bridge 能力，不能由 Agent 根据自然语言任务自动取得管理员权限。

一期正式发布包必须从不包含二期特权代码的干净提交构建。当前一期提交 `0772575` 不包含 `pmset`、`sudo` 或 WakeScheduler；二期开发代码不得混入一期包。OpenClaw 的本机 `security audit` 只审计本机配置，不能替代对最终发布包的实际扫描；发布前仍需在干净包上执行对应的安全检查。

## 10. 下一步

1. 将一期 API、任务列表和运行记录接入 Extension 管理界面。
2. 对浏览器启动、Extension 重连、登录失效和验证码补充清晰错误码与用户提示。
3. 补充不同 Mac 型号、电池/外接电源和浏览器状态下的回归测试。
4. Windows 正式能力默认限定为活跃/锁屏执行和系统恢复后的补跑；Task Scheduler 与原生 Waitable Timer 继续保持实验开关，不作为通用能力宣传。
5. 如有严格准点需求，单独设计并验收用户显式开启的 `keep_awake` 模式；Wake-on-LAN、BIOS/UEFI RTC 作为需要外部条件的独立方案评估。
