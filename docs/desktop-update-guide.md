# Gecho Desktop 更新检查与升级指南

> 适用版本：1.1.38+  
> 分支：`feature/phase3-scheduled-desktop`  
> 最后更新：2026-10-09

---

## 一、更新架构概览

```
GitHub Releases API
  └─> fetchReleaseFeed()      # 拉取 releases 列表
        └─> findMatchingAsset() # 按平台/架构匹配安装包
              └─> downloadUpdate()  # 流式下载 + 进度广播
                    └─> verifyDownloadedFile() # SHA256 + 文件格式校验
                          └─> quitAndInstall()  # 协调退出并启动安装程序
```

### 关键文件

| 文件 | 说明 |
|---|---|
| `desktop/updater.js` | 核心更新引擎：状态机、版本比较、下载器、校验器 |
| `desktop/main.js` | 主进程 IPC 注册，启动后 8 秒静默检查 |
| `desktop/preload.js` | 渲染进程 IPC 接口暴露 |
| `desktop/renderer/renderer.js` | 前端状态渲染逻辑（`renderUpdateState`） |
| `desktop/i18n.js` | 中英双语更新提示字符串 |
| `test/desktop-updater.test.js` | 端到端更新流程自动化测试 |

---

## 二、更新源格式规范

### 标准 GitHub Releases 列表（默认）

```
GET https://api.github.com/repos/gecho-ai/gecho-bridge/releases
```

返回数组，取第一个非草稿版本，必须包含：

```json
[
  {
    "tag_name": "v1.2.0",
    "draft": false,
    "prerelease": false,
    "body": "更新说明文本",
    "assets": [
      {
        "name": "Gecho-1.2.0-mac-arm64.dmg",
        "browser_download_url": "https://github.com/.../Gecho-1.2.0-mac-arm64.dmg",
        "size": 92000000
      }
    ]
  }
]
```

### 自定义 / 私有更新源（测试用）

通过环境变量覆盖：

```bash
GECHO_UPDATE_FEED_URL=http://your-update-server/releases electron desktop/main.js
```

也支持通过 IPC 选项 `feedUrl` 传入（测试时通过 `checkForUpdates({ feedUrl })` 使用）。

---

## 三、发布所需产物清单

每次发布桌面端新版本，需在 GitHub Release 中上传以下文件（按平台）：

### macOS

| 文件名格式 | 说明 |
|---|---|
| `Gecho-{version}-mac-arm64.dmg` | Apple Silicon 安装镜像 |
| `Gecho-{version}-mac-x64.dmg` | Intel 安装镜像 |

### Windows

| 文件名格式 | 说明 |
|---|---|
| `Gecho-Setup-{version}.exe` 或 `Gecho-{version}-win-x64.exe` | x64 NSIS 安装包 |
| `Gecho-{version}-win-arm64.exe` | ARM64 安装包（可选） |

> [!IMPORTANT]
> 文件名中必须含有 `arm64` / `x64` 关键词，否则 `findMatchingAsset` 无法正确匹配架构。

---

## 四、检查与升级流程

### 自动静默检查

- 桌面端启动 **8 秒后** 在后台静默检查
- 若有新版本，通过 IPC 广播 `update-status`，前端 `#update-action-wrap` 区域自动显示提示
- 不弹窗、不阻塞启动

### 手动检查入口

1. **控制面板**（renderer.js）：点击"检查更新"按钮
2. **系统托盘**：菜单 → "检查更新..."
3. **macOS GechoTray**：从 Swift 托盘菜单触发 IPC

### 更新状态流转

```
idle
 └─> checking (正在检查)
       ├─> not-available (已是最新)
       ├─> no-matching-asset (有新版但无适配包)
       ├─> available (有新版)
       │     └─> downloading (下载中)
       │           ├─> downloaded (下载完成，等待安装)
       │           │     └─> installing (启动安装并退出)
       │           └─> error (下载/校验失败，可重试)
       └─> error (检查失败，可重试)
```

### 升级方式

**macOS**（无 Developer ID 签名时）：

1. 下载 DMG 到临时目录
2. 校验大小与 SHA256（如有）
3. 执行 `hdiutil attach xxx.dmg` 挂载
4. 提示用户将 `.app` 拖入 `/Applications` 替换
5. 调用 `app.quit()` 关闭托盘（含 GechoTray 子进程）

**Windows**：

1. 下载 `.exe` 安装包到临时目录
2. 校验大小与 MZ 头（PE 格式）
3. 执行 `Gecho-Setup-x.x.x.exe /S --updated` 静默覆盖安装
4. NSIS customCheckAppRunning hook 协调关闭进程树
5. 安装完成后自动重新启动

### 用户数据保护

- 安装目录与数据目录分离；NSIS 构建配置 `${APPDATA}/Gecho` 保存任务记录
- 升级后任务记录、历史配置完整保留
- 若安装失败，原版本文件不受影响，可继续使用

---

## 五、错误处理与重试

| 错误码 | 触发条件 | 用户提示 | 处理方式 |
|---|---|---|---|
| `NO_RELEASES` | API 返回空列表 | "暂无发布记录" | 可重试 |
| `NO_MATCHING_ASSET` | 有新版但无适配包 | 提示版本与平台 | 等待官方上传 |
| `RATE_LIMIT` | GitHub 403 限流 | "频率超限，请稍后" | 可重试 |
| `TIMEOUT` | 请求超时（8s） | "超时，检查网络" | 可重试 |
| `OFFLINE` | 网络断开 | "网络未连接" | 网络恢复后重试 |
| `DOWNLOAD_FAILED` | 下载中断 | 含错误信息 | 可重试，删除临时文件 |
| `VERIFICATION_FAILED` | 哈希/格式不匹配 | "文件校验失败" | 重新下载 |

---

## 六、测试验证状态

| 测试项目 | 测试文件 | 状态 |
|---|---|---|
| 版本比较（SemVer + 预发布）| `test/desktop-updater.test.js` | ✅ 自动通过 |
| 平台/架构资产匹配 | `test/desktop-updater.test.js` | ✅ 自动通过 |
| 空 Release / 限流错误分类 | `test/desktop-updater.test.js` | ✅ 自动通过 |
| 检查+下载+进度+校验全链路 | `test/desktop-updater.test.js` | ✅ 自动通过（本地 Mock HTTP 服务器）|
| 无适配包时正确识别 | `test/desktop-updater.test.js` | ✅ 自动通过 |
| i18n 字典完整性 | `test/desktop-platform.test.js` | ✅ 自动通过 |
| 打包文件清单 | `test/desktop-packaging.test.js` | ✅ 自动通过 |
| 真实 macOS 升级安装 | 手动 | ⏳ 待生产 Release 上传后验证 |
| 真实 Windows NSIS 安装 | 手动 | ⏳ 待生产 Release 上传后验证 |

运行全量桌面端测试：

```bash
node --test test/desktop-packaging.test.js test/desktop-platform.test.js test/desktop-updater.test.js
```

---

## 七、还需要的外部条件（人工操作）

### 立即可行

1. **上传 GitHub Release**：在 `gecho-ai/gecho-bridge` 创建新版本 Release，按照上述命名规范上传安装包
2. **获取 SHA256 哈希**：`shasum -a 256 Gecho-x.x.x-mac-arm64.dmg`，写入 Release 描述或 `checksums.txt`
3. **验证更新链路**：设置 `GECHO_UPDATE_FEED_URL` 指向测试 Release API，运行桌面端完整验证

### 若需签名静默升级（可选，非必须）

- **macOS**：申请 Apple Developer ID Application 证书并启用 Notarization
- **Windows**：申请 EV 代码签名证书
- 签名配置写入 `electron-builder.yml` 或环境变量 `CSC_*` 系列

---

## 八、调试与常用命令

```bash
# 使用自定义更新源启动桌面端（开发调试）
GECHO_UPDATE_FEED_URL=http://localhost:8080/releases npm run desktop:dev

# 本地打包（不发布）
npm run desktop:pack          # macOS
npm run desktop:pack:win      # Windows x64

# 运行所有桌面端测试
node --test test/desktop-packaging.test.js test/desktop-platform.test.js test/desktop-updater.test.js
```
