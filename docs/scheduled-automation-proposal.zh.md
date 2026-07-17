# Gecho Bridge 本地定时自动化方案

日期：2026-07-17
负责人：Bridge / Extension
文档状态：一期、二期均已实现并完成 macOS 实机验收

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
| 已登录会话下的锁屏采集 | 已实测 | 支持 macOS 锁屏但不休眠的场景 |
| 睡眠期间的错过任务处理 | 已实现 | 依 `run_once` / `skip` / `window` 策略处理 |
| macOS 自动唤醒 | 已实现、已实机验收、需用户显式授权 | 支持 macOS 普通休眠场景 |
| Windows 在线状态下的本地定时和浏览器启动 | 已实现、待 Windows 实机验收 | 支持 Bridge 运行且系统未休眠的场景 |
| Windows 自动唤醒 | 未实现 | 当前不支持，后续评估 Task Scheduler `WakeToRun` |
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

### 5.1 锁屏采集

2026-07-15，本机保持 Bridge、Edge 和 Extension 已连接后，用 macOS `Control + Command + Q` 锁屏，再发起 `tiktok_influencer` 异步任务。

| 项目 | 结果 |
|---|---|
| 账号 | `zachking` |
| 执行时间 | 22:00:03 至 22:00:36，约 33 秒 |
| 结果 | 成功写入 81 条数据 |
| 浏览器 | Edge |

结论：在 **macOS 已登录、仅锁屏且未进入休眠** 的前提下，Bridge、浏览器和 Extension 可后台完成采集。

### 5.2 本地定时采集

2026-07-17，本机创建了两次一分钟后的 `once` 任务，均由 Bridge 到点派发给 Extension，并在运行记录中关联异步结果。

| 计划时间（北京时间） | 结果 | 结果文件 |
|---|---|---|
| 10:54:49 | 完成 78 条，约 9 秒 | `/tmp/gecho-schedule-test/tiktok_influencer_zachking_results.json` |
| 11:00:14 | 完成 49 条，约 15 秒 | `/tmp/gecho-schedule-test-2/tiktok_influencer_zachking_results.json` |

本轮覆盖创建、持久化、到点触发、异步派发、Extension 回传、运行记录和结果落盘。该轮没有将锁屏作为验收条件；锁屏结论以 5.1 为准。

### 5.3 普通休眠后的自动唤醒与采集

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

## 6. 设备状态与能力边界

| 设备状态 | 一期表现 | 二期目标 / 边界 |
|---|---|---|
| 已登录、屏幕锁定 | 可执行，已实测 | 不需要系统唤醒 |
| 普通休眠 | 进程与定时器暂停，到期后按补跑策略处理 | 在任务前 10 秒唤醒，随即继续一期链路 |
| 合盖 | 通常会进入睡眠，不等于锁屏 | 不做默认承诺，需按硬件/外接显示器单独验证 |
| 完全关机、FileVault 或登录界面 | 无法执行 | 不支持绕过登录进入桌面 |

“锁屏”不等于“合盖”：锁屏时用户会话通常仍在运行；合盖通常让 Mac 睡眠。即使二期唤醒成功，也不会绕过锁屏密码；用户必须保持 macOS 用户会话已登录。

### 6.1 Windows 当前边界

当前 Bridge 的任务持久化、单次/每日/每周调度、错过任务策略、异步运行记录，以及 Windows 下 Chrome / Edge 的路径探测和启动逻辑均可复用。因此在 **Bridge 已运行且 Windows 未休眠** 的条件下，定时任务到点后可以自动启动已识别的浏览器，并等待 Extension 恢复连接后执行。

但二期的系统唤醒代码当前只实现了 macOS 的 `pmset`：Windows 尚未创建 Task Scheduler 任务，也没有启用 `WakeToRun`。因此现阶段不得承诺 Windows 休眠后的准点自动执行；设备被用户唤醒后，任务仅按一期的 `run_once` / `skip` / `window` 策略处理。

Windows 锁屏也不能在发布前承诺为正式能力。它依赖当前交互式用户会话、浏览器与 Extension 未被组策略或电源策略终止；它不等于自动解锁桌面。Windows 实机测试至少应覆盖：Chrome 和 Edge 启动、无页签恢复、锁屏、普通休眠后的补跑、登录态失效和 Extension 断连。

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
4. 在 Windows 实机验证当前一期链路（Chrome / Edge、锁屏、休眠补跑）；验证通过后再评估 Windows Task Scheduler 的 `WakeToRun` 实现。
