# Gecho Windows 桌面端

当前交付：`feature/desktop` 分支的 Windows x64 验证版，与现有 Mac 桌面端功能一致。这个分支尚未合入自动飞轮定时任务实现。

## 安装和使用

安装包：`release/Gecho-1.1.37-win-x64.exe`。面向 Windows 10/11 x64；内置 Electron/Node 运行时，无需另装 Node 或 AI Agent。

双击安装到当前用户目录，桌面和开始菜单会生成 Gecho 快捷方式。启动后自动承载本地 Bridge；如果本机已有 Bridge，则复用已有服务。默认 HTTP 为 `127.0.0.1:18793`，插件 WebSocket 为 `127.0.0.1:18792`。

应用以纯托盘模式运行，不创建主窗口或任务栏窗口。点击托盘菜单可查看 Bridge、插件和浏览器状态，打开连接引导或数据目录，设置登录启动及退出。开启登录启动后在用户登录时后台启动，使用当前安装路径及 `--hidden` 参数。退出桌面端会停止由本应用承载的 Bridge；复用外部 Bridge 时不停止外部进程。

Mac 使用相同的 Electron 主进程，但状态栏图标由原生 AppKit 小组件
`desktop/macos-tray/GechoTray.app` 绘制。这样不依赖 Electron 在 macOS 26 上不稳定的
`Tray` 实现。打包配置 `LSUIElement=true`，不显示 Dock 图标，也不创建主窗口。

原生小组件只负责显示图标、状态菜单和菜单操作；Bridge 状态由 Electron 主进程每两秒同步。
菜单项点击后通过标准输入输出协议交回 Electron 处理。状态栏项目位置由 macOS 管理；如果当前
菜单栏项目过多，图标可能进入系统的隐藏/溢出区域，可以直接在菜单栏中移动它。

Mac 打包前会自动执行 `npm run desktop:build-native`，原生小组件会通过 `asarUnpack` 放在安装包
资源目录中。安装包统一输出至 `release/`。

纯托盘改动验证：桌面相关 5 个测试通过；在隔离端口启动真实 Electron，确认窗口数为 0、`app.dock.isVisible()` 为 false；生成的 Mac app 的 `LSUIElement` 为 true。Windows 的菜单和登录启动仍需真机验收。

最新人工复测的已知问题：`GechoTray` 进程和 `NSStatusItem` 都已创建，但当前机器上状态栏图标没有出现在可见菜单栏；Accessibility 读取到该菜单栏项目的位置为 `x=-1, y=981`。这部分仍需继续排查状态栏项目定位/系统恢复位置，不能把“进程存在”当作“用户能看到图标”。

数据默认放在 `%LOCALAPPDATA%\Gecho\Bridge`。卸载不主动删除任务和采集数据。当前验证版未配置 Windows 代码签名证书，安装包可能显示未知发布者，应用图标暂用 Electron 默认图标；托盘已提供可辨识的 G 图标。

## 构建

在项目目录安装依赖后执行：

```bash
npm ci
npm run desktop:dist:win
```

仅生成解包目录：`npm run desktop:pack:win`。安装包产物在 `release/`，命令明确关闭自动发布。构建配置采用 NSIS、当前用户安装和 x64 架构。

## 验证记录与验收

2026-09-14：在 macOS 26.6.2 arm64 主机验证原生状态栏组件。桌面端无主窗口、无 Dock 图标，状态栏菜单可打开，并真实显示 `Bridge：运行中`、`浏览器插件：已连接`、`浏览器：edge`。当前分支全量 `node --test test/*.test.js` 为 53 passed。新增测试覆盖含中文及空格的 Windows 安装路径、登录启动参数、托盘像素可见性。已修正桌面端关闭自动引导页面时使用的环境变量名称。

这些测试不等于 Windows 真机验收。交付后应在 Windows 10/11 检查：

1. 安装后打开 Gecho，界面显示本地 Bridge 运行中。
2. 在 Chrome/Edge 安装并登录 Gecho 插件，连接状态更新为已连接，执行一次真实搜索。
3. 启动后没有主窗口，Bridge 在线；点击托盘或再次打开快捷方式可弹出状态菜单。
4. 开启登录启动后注销再登录，应用留在托盘且 Bridge 在线；关闭此开关后下次登录不自动启动。
5. 退出 Gecho 后由其承载的 Bridge 停止；重新启动后恢复。复用外部 Bridge 的场景单独检查。

实现依据：[Electron 登录启动 API](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)、[electron-builder NSIS 配置](https://www.electron.build/nsis/)。
