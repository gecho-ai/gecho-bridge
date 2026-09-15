const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} = require("electron");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const { getDefaultDataDir } = require(path.join(__dirname, "..", "data-dir.js"));
const logger = require("./logger");

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  try {
    dialog.showErrorBox("Gecho 异常提示", `主进程遇到未捕获异常：\n${error.message}\n日志文件：${logger.getLogFile()}`);
  } catch (_e) {}
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});

const SERVICE_URL = `http://127.0.0.1:${process.env.GECHO_HTTP_PORT || 18793}`;
const SERVICE_PING_URL = `${SERVICE_URL}/ping`;
const ONBOARDING_URL = `${SERVICE_URL}/onboarding`;
const { loginItemOptions, createTrayPng } = require("./platform");

let dashboardWindow = null;
let tray = null;
let macTray = null;
let macTrayOutput = "";
let macTrayStatusSignature = "";
let lastStatus = { service: "starting", extensionConnected: false };
let menuSignature = "";
let bridgeMode = "starting";
let statusTimer = null;
let quitting = false;

const mockScheduledTasks = [
  {
    id: "task-daily-trending",
    name: "每日 TikTok 热门趋势抓取",
    cron: "0 9 * * *",
    cronDesc: "每天上午 09:00",
    target: "TikTok Trending (#fyp, #viral, #trending)",
    targetCount: 50,
    status: "active",
    lastRun: "今天 09:00:12",
    lastResult: "成功 · 抓取 50 条视频",
    nextRun: "明天 09:00:00",
  },
  {
    id: "task-beauty-competitor",
    name: "美妆个护类目爆款追踪",
    cron: "0 */4 * * *",
    cronDesc: "每 4 小时一次",
    target: "关键词: skincare, makeup, beauty tips",
    targetCount: 30,
    status: "active",
    lastRun: "今天 12:00:05",
    lastResult: "成功 · 抓取 30 条视频",
    nextRun: "今天 16:00:00",
  },
  {
    id: "task-weekly-insights",
    name: "竞品周度博主与评论互动监控",
    cron: "0 10 * * 1",
    cronDesc: "每周一 10:00",
    target: "头部博主作品矩阵与粉丝互动分析",
    targetCount: 100,
    status: "paused",
    lastRun: "上周一 10:00:22",
    lastResult: "成功 · 生成分析报告",
    nextRun: "下周一 10:00:00",
  },
];

function requestJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, data: JSON.parse(body || "{}") });
        } catch (_error) {
          resolve({ ok: false, data: null });
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on("error", () => resolve({ ok: false, data: null }));
  });
}

async function getBridgeStatus() {
  const response = await requestJson(SERVICE_PING_URL);
  if (!response.ok || !response.data) {
    return { service: "stopped", bridgeMode, extensionConnected: false };
  }

  return {
    service: "running",
    bridgeMode,
    packageVersion: response.data.packageVersion || null,
    extensionConnected: Boolean(response.data.extensionConnected),
    browser: response.data.lastConnectedBrowser || null,
    profile: response.data.lastConnectedProfile || null,
    dataDir: response.data.dataDir || getDefaultDataDir(),
    startedAt: response.data.startedAt || null,
  };
}

async function startBridge() {
  const existing = await getBridgeStatus();
  if (existing.service === "running") {
    bridgeMode = "existing";
    return existing;
  }

  // 桌面助手直接承载 Bridge，不依赖 MCP/Agent，也不自动弹出 onboarding 页面。
  process.env.GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START = "0";
  require(path.join(__dirname, "..", "server.js"));
  bridgeMode = "embedded";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await getBridgeStatus();
    if (status.service === "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("Bridge service did not become ready");
}

function sendStatus(status) {
  lastStatus = status;
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send("bridge-status", status);
  }
  if (process.platform === "darwin") {
    updateMenu();
    return;
  }
  if (tray) {
    tray.setToolTip(status.service !== "running" ? "Gecho：Bridge 未运行" : status.extensionConnected ? "Gecho：浏览器已连接" : "Gecho：等待浏览器插件");
    updateMenu();
  }
}

async function refreshStatus() {
  sendStatus(await getBridgeStatus());
}

function getAutoStartEnabled() {
  return Boolean(app.getLoginItemSettings(loginItemOptions(process.platform, process.execPath)).openAtLogin);
}

function getMacTrayPath() {
  const relativePath = path.join("desktop", "macos-tray", "GechoTray.app", "Contents", "MacOS", "GechoTray");
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", relativePath) : path.join(__dirname, "macos-tray", "GechoTray.app", "Contents", "MacOS", "GechoTray");
}

function macTrayStatusPayload() {
  return {
    type: "status",
    version: app.getVersion(),
    serviceLabel: lastStatus.service === "running" ? "运行中" : lastStatus.service === "starting" ? "启动中" : "未运行",
    extensionConnected: Boolean(lastStatus.extensionConnected),
    browser: lastStatus.browser || "—",
    autoStart: getAutoStartEnabled(),
  };
}

function sendMacTrayStatus() {
  if (!macTray?.stdin?.writable) return;
  const payload = macTrayStatusPayload();
  const signature = JSON.stringify(payload);
  if (signature === macTrayStatusSignature) return;
  macTrayStatusSignature = signature;
  macTray.stdin.write(`${JSON.stringify(payload)}\n`);
}

function openDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "Gecho 控制面板",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  dashboardWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  dashboardWindow.once("ready-to-show", () => {
    dashboardWindow.show();
    dashboardWindow.focus();
  });

  dashboardWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });
}

function handleExportDiagnostics() {
  logger.info("Exporting diagnostics report...");
  const result = logger.exportDiagnostics({
    appVersion: app.getVersion(),
    platform: process.platform,
    bridgeStatus: lastStatus,
    dataDir: lastStatus.dataDir || getDefaultDataDir(),
  });
  if (result.success) {
    logger.info("Diagnostics exported successfully to:", result.reportPath);
    shell.showItemInFolder(result.reportPath);
    dialog.showMessageBox({
      type: "info",
      title: "诊断日志已导出",
      message: `诊断报告已成功生成并保存：\n${result.fileName}\n\n已自动打开所在目录。如遇问题可将该文件发送给技术支持人员。`,
      buttons: ["好的"],
    });
  } else {
    logger.error("Failed to export diagnostics:", result.error);
    dialog.showErrorBox("导出失败", `生成诊断文件失败：${result.error}`);
  }
  return result;
}

function registerIpc() {
  ipcMain.handle("bridge-status", () => getBridgeStatus());
  ipcMain.handle("app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    autoStart: getAutoStartEnabled(),
    dataDir: lastStatus.dataDir || getDefaultDataDir(),
  }));
  ipcMain.handle("open-onboarding", () => shell.openExternal(ONBOARDING_URL));
  ipcMain.handle("open-data-dir", () => shell.openPath(lastStatus.dataDir || getDefaultDataDir()));
  ipcMain.handle("export-diagnostics", () => handleExportDiagnostics());
  ipcMain.handle("set-auto-start", (_event, enabled) => {
    try {
      app.setLoginItemSettings({
        ...loginItemOptions(process.platform, process.execPath),
        openAtLogin: Boolean(enabled),
      });
      macTrayStatusSignature = "";
      sendMacTrayStatus();
      menuSignature = "";
      updateMenu();
      return getAutoStartEnabled();
    } catch (err) {
      dialog.showErrorBox("自动启动设置失败", err.message);
      return getAutoStartEnabled();
    }
  });
  ipcMain.handle("hide-window", () => dashboardWindow?.hide());
  ipcMain.handle("quit-app", () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle("get-scheduled-tasks", () => mockScheduledTasks);
  ipcMain.handle("toggle-scheduled-task", (_event, taskId) => {
    const task = mockScheduledTasks.find((t) => t.id === taskId);
    if (task) {
      task.status = task.status === "active" ? "paused" : "active";
    }
    return mockScheduledTasks;
  });
  ipcMain.handle("run-scheduled-task-now", async (_event, taskId) => {
    const task = mockScheduledTasks.find((t) => t.id === taskId);
    if (!task) return { success: false, error: "未找到指定任务" };
    const nowStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    task.lastRun = `刚刚 (${nowStr})`;
    task.lastResult = `成功 · 抓取 ${task.targetCount} 条视频 (手动执行)`;
    return { success: true, task };
  });
}

function handleMacTrayCommand(message) {
  switch (message.command) {
    case "open-dashboard":
      openDashboardWindow();
      break;
    case "open-onboarding":
      shell.openExternal(ONBOARDING_URL);
      break;
    case "open-data":
      shell.openPath(lastStatus.dataDir || getDefaultDataDir());
      break;
    case "export-diagnostics":
      handleExportDiagnostics();
      break;
    case "toggle-autostart":
      app.setLoginItemSettings({
        ...loginItemOptions(process.platform, process.execPath),
        openAtLogin: Boolean(message.enabled),
      });
      macTrayStatusSignature = "";
      sendMacTrayStatus();
      break;
    case "quit":
      app.quit();
      break;
    default:
      break;
  }
}

function startMacTray() {
  const helperPath = getMacTrayPath();
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Mac 状态栏组件不存在：${helperPath}。请先执行 npm run desktop:build-native。`);
  }

  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  macTray = child;
  macTrayOutput = "";
  macTrayStatusSignature = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    macTrayOutput += chunk;
    let newlineIndex = macTrayOutput.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = macTrayOutput.slice(0, newlineIndex).trim();
      macTrayOutput = macTrayOutput.slice(newlineIndex + 1);
      newlineIndex = macTrayOutput.indexOf("\n");
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === "ready") {
          macTrayStatusSignature = "";
          sendMacTrayStatus();
        }
        if (message.type === "command") handleMacTrayCommand(message);
      } catch (_error) {
        console.warn("Ignoring malformed Mac tray message");
      }
    }
  });
  child.on("error", (error) => {
    console.error("Mac tray helper failed", error);
  });
  child.on("exit", () => {
    if (macTray !== child) return;
    macTray = null;
    macTrayStatusSignature = "";
    if (!quitting) {
      setTimeout(() => {
        if (!macTray && !quitting) startMacTray();
      }, 1000).unref?.();
    }
  });
  sendMacTrayStatus();
}

function stopMacTray() {
  const child = macTray;
  macTray = null;
  if (!child) return;
  try {
    child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    child.stdin.end();
  } catch (_error) {
    // The helper may already have exited.
  }
  setTimeout(() => child.kill(), 250).unref?.();
}

function updateMenu() {
  if (process.platform === "darwin") {
    sendMacTrayStatus();
    return;
  }
  if (!tray) return;
  const autoStart = getAutoStartEnabled();
  const signature = JSON.stringify([lastStatus, autoStart]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Gecho ${app.getVersion()}`, enabled: false },
    { label: `Bridge：${lastStatus.service === "running" ? "运行中" : lastStatus.service === "starting" ? "启动中" : "未运行"}`, enabled: false },
    { label: `浏览器插件：${lastStatus.extensionConnected ? "已连接" : "未连接"}`, enabled: false },
    { label: `浏览器：${lastStatus.browser || "—"}`, enabled: false },
    { type: "separator" },
    { label: "打开面板", click: () => openDashboardWindow() },
    { label: "打开浏览器连接引导", click: () => shell.openExternal(ONBOARDING_URL) },
    { label: "打开数据目录", click: () => shell.openPath(lastStatus.dataDir || getDefaultDataDir()) },
    { label: "导出诊断日志", click: () => handleExportDiagnostics() },
    { label: "登录时自动启动", type: "checkbox", checked: autoStart, click: (item) => {
      try {
        app.setLoginItemSettings({ ...loginItemOptions(process.platform, process.execPath), openAtLogin: item.checked });
      } catch (error) {
        dialog.showErrorBox("自动启动设置失败", error.message);
      }
      menuSignature = "";
      updateMenu();
    } },
    { type: "separator" },
    { label: "退出 Gecho", click: () => app.quit() },
  ]));
}

function createTray() {
  if (process.platform === "darwin") {
    startMacTray();
    return;
  }
  const image = nativeImage.createFromBuffer(createTrayPng(process.platform));
  tray = new Tray(image);
  tray.setToolTip("Gecho");
  updateMenu();
  if (process.platform === "win32") tray.on("click", () => tray.popUpContextMenu());
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => tray?.popUpContextMenu());
  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("ai.gecho.desktop");
    registerIpc();
    try {
      createTray();
      if (process.platform === "darwin") app.dock.hide();
      await startBridge();
      await refreshStatus();
      statusTimer = setInterval(refreshStatus, 2000);
    } catch (error) {
      dialog.showErrorBox("Gecho 启动失败", error.message);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    stopMacTray();
    if (statusTimer) clearInterval(statusTimer);
  });
}
