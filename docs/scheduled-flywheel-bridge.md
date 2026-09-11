# 自动飞轮：Bridge 定时触发接口

状态：Bridge 定时触发链路、独立运行和用户级开机启动已开发，并通过本地集成测试。

## 1. Bridge 负责什么

官网负责保存飞轮任务和完整业务编排。Bridge 只负责：

1. 保存任务的 `taskRef`、版本、入口地址和执行时间。
2. 到点后启动或唤回浏览器，等待 Gecho 插件连接。
3. 给插件发送一次 `start_flywheel_task` 指令。
4. 记录“已发送 / 已接收 / 失败”，不等待脚本或视频最终结果。

插件页面是否准备好、官网如何执行一键成片、采集商品或视频评论，均不放在 Bridge 中。

```text
官网保存任务 → 本机 Bridge 保存时间
                       ↓ 到点
             Bridge → 浏览器插件 → 官网一键成片入口
                       ↓
              官网继续负责业务结果
```

## 2. 任务数据

```json
{
  "taskRef": "flywheel-123",
  "taskVersion": 3,
  "entryUrl": "https://gecho.ai/flywheel/tasks/flywheel-123",
  "schedule": {
    "type": "daily",
    "time": "09:00",
    "timezone": "Asia/Shanghai"
  },
  "enabled": true
}
```

支持三种时间规则：

- `once`：指定 `runAt` 执行一次；
- `daily`：每天指定时间；
- `weekly`：指定星期和时间，`days` 使用 `0`（周日）到 `6`（周六）。

电脑或 Bridge 错过执行时间时，默认补跑一次；也可以用 `misfirePolicy=skip` 跳过，或用 `window` 配置补跑窗口。

## 3. 官网调用接口

Bridge 默认监听 `http://127.0.0.1:18793`。

| 方法 | 地址 | 用途 |
|---|---|---|
| `PUT` | `/scheduled-jobs/task-ref/{taskRef}` | 官网保存或更新任务，幂等接口 |
| `POST` | `/scheduled-jobs` | 创建新任务 |
| `GET` | `/scheduled-jobs` | 查询任务列表 |
| `GET` | `/scheduled-jobs/{id}` | 查询单个任务 |
| `PATCH` | `/scheduled-jobs/{id}` | 修改或暂停任务 |
| `DELETE` | `/scheduled-jobs/{id}` | 删除任务 |
| `POST` | `/scheduled-jobs/{id}/run` | 立即触发一次，用于测试或手动执行 |
| `GET` | `/scheduled-jobs/{id}/runs` | 查询触发记录 |

官网保存任务时推荐使用 `PUT`：同一个 `taskRef` 重复保存只会更新原任务，不会产生多个定时器。

```http
PUT http://127.0.0.1:18793/scheduled-jobs/task-ref/flywheel-123
Origin: https://gecho.ai
Content-Type: application/json
```

返回的 `job.id` 是 Bridge 本地记录 ID；官网应继续使用自己的 `taskRef` 作为业务主键。

## 4. 到点触发协议

Bridge 向插件发送：

```json
{
  "method": "execute_action",
  "requestId": "scheduled-...",
  "params": {
    "action": "start_flywheel_task",
    "params": {
      "taskRef": "flywheel-123",
      "taskVersion": 3,
      "triggerId": "trigger-...",
      "entryUrl": "https://gecho.ai/flywheel/tasks/flywheel-123"
    }
  }
}
```

插件只需要尽快返回一次即时确认，例如：

```json
{
  "method": "action_result",
  "requestId": "scheduled-...",
  "data": { "accepted": true }
}
```

`triggerId` 是本次触发的唯一标识，官网可用它关联自己的执行记录。Bridge 不会根据插件后续页面操作更新业务结果。

## 5. 当前边界与配置

- Bridge 数据保存在 `GECHO_DATA_DIR/.scheduled_tasks.json`，重启后自动恢复。
- 运行记录默认保留最近 100 次。
- 官网跨域请求只允许 `GECHO_WEBSITE_URL` 的 Origin，可通过 `GECHO_SCHEDULED_ALLOWED_ORIGINS` 增加开发环境地址。
- 如果配置 `GECHO_BRIDGE_API_TOKEN`，官网请求还必须携带 Bearer Token 或 `X-Gecho-Bridge-Token`。
- 当前不包含系统睡眠唤醒、Bridge 桌面安装器和最终视频/脚本结果回传。

## 6. Bridge 独立运行与开机启动

Bridge 不再必须依赖 MCP 进程才能运行。可以直接使用独立服务命令：

```bash
npm run server:start       # 启动本机 Bridge 服务
npm run server:status      # 查看服务和定时任务状态
npm run server:restart     # 重启服务
npm run server:stop        # 停止服务
```

如果需要用户登录系统后自动运行，可以显式安装用户级启动项：

```bash
npx gecho-bridge-server install
npx gecho-bridge-server startup-status
npx gecho-bridge-server uninstall
```

各系统对应的实现是：

- macOS：用户 `LaunchAgent`，登录后启动并保持 Bridge 运行；
- Linux：用户级 `systemd` service，不需要 root 权限；
- Windows：当前用户的登录启动任务（Task Scheduler）。

安装命令会根据当前 Node 可执行文件和当前 Bridge 安装路径生成配置；升级 Node 或迁移安装目录后，应重新执行 `install`。生成的启动配置只写入非敏感运行参数，不会把 `GECHO_BRIDGE_API_TOKEN` 写入 plist、systemd unit 或 Windows 任务参数。需要 API Token 时，应由外部安全运行环境注入。

这部分只保证 Bridge 在用户登录后持续运行，不负责唤醒已经睡眠的电脑，也不包含桌面助手 UI、安装器和系统级守护进程。

## 7. 已验证

本地集成测试已验证：

- 同一 `taskRef` 保存两次不会重复创建任务；
- 非白名单 Origin 被拒绝；
- WebSocket 插件收到 `start_flywheel_task`，并返回即时确认；
- 手动触发记录为 `dispatched`；
- Bridge 重启后任务、版本和运行记录仍可查询；
- 时间规则、时区、错过执行、暂停和并发保护测试通过。
- 独立服务可以启动、查看状态、重启和停止；
- macOS LaunchAgent、Linux systemd user unit、Windows 登录任务的配置生成通过测试；
- 启动配置文件使用用户权限写入，且不会写入 API Token。
