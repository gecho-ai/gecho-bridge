const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  shell,
} = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const { getDefaultDataDir } = require(path.join(__dirname, "..", "data-dir.js"));
const logger = require("./logger");
const i18n = require("./i18n");
const updater = require("./updater");
const security = require("./security");

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  try {
    dialog.showErrorBox("Gecho 异常提示", `主进程遇到未捕获异常：\n${error.message}\n日志文件：${logger.getLogFile()}`);
  } catch (_e) {}
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});

const DEFAULT_SERVICE_PORT = Number(process.env.GECHO_HTTP_PORT) || 18793;
const PORT_SEARCH_RANGE = 10; // 若默认端口被占，依次尝试 18793~18802
const { loginItemOptions, createTrayPng } = require("./platform");

// 运行时动态确定的 Bridge 端口（端口冲突时自动挑选）
let activeServicePort = DEFAULT_SERVICE_PORT;
let SERVICE_URL = `http://127.0.0.1:${activeServicePort}`;
let SERVICE_PING_URL = `${SERVICE_URL}/ping`;
let ONBOARDING_URL = `${SERVICE_URL}/onboarding`;

// powerSaveBlocker ID：有任务运行时阻止系统休眠，无活跃任务时释放
let powerSaveBlockerId = null;

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

/**
 * 探测端口是否被占用（promise-based）
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * 找到从 startPort 开始第一个可用端口，搜索 range 个
 */
async function findAvailablePort(startPort, range = PORT_SEARCH_RANGE) {
  for (let offset = 0; offset < range; offset++) {
    const port = startPort + offset;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}–${startPort + range - 1}`);
}

/**
 * 更新所有依赖 activeServicePort 的 URL 变量
 */
function applyPort(port) {
  activeServicePort = port;
  SERVICE_URL = `http://127.0.0.1:${port}`;
  SERVICE_PING_URL = `${SERVICE_URL}/ping`;
  ONBOARDING_URL = `${SERVICE_URL}/onboarding`;
  process.env.GECHO_HTTP_PORT = String(port);
}

/**
 * 根据当前是否有活跃定时任务，管理 powerSaveBlocker：
 * - 有活跃任务：启用"prevent-app-suspension"阻止睡眠
 * - 无活跃任务：释放 blocker 让系统正常休眠
 */
function syncPowerSaveBlocker(hasActiveTasks) {
  if (hasActiveTasks) {
    if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      logger.info(`Power save blocker started (id=${powerSaveBlockerId}) - active tasks detected`);
    }
  } else {
    if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      logger.info(`Power save blocker stopped (id=${powerSaveBlockerId}) - no active tasks`);
      powerSaveBlockerId = null;
    }
  }
}

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

  // 端口冲突自愈：探测可用端口再启动内嵌 Bridge
  let chosenPort;
  try {
    chosenPort = await findAvailablePort(DEFAULT_SERVICE_PORT);
  } catch (err) {
    throw new Error(`端口资源不足，无法启动 Bridge：${err.message}`);
  }

  if (chosenPort !== DEFAULT_SERVICE_PORT) {
    logger.warn(`Default port ${DEFAULT_SERVICE_PORT} is busy, using port ${chosenPort} instead`);
  }
  applyPort(chosenPort);

  // 桌面助手直接承载 Bridge，不依赖 MCP/Agent，也不自动弹出 onboarding 页面。
  process.env.GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START = "0";
  const dataDir = lastStatus.dataDir || getDefaultDataDir();
  const token = security.getOrCreateLocalToken(dataDir);
  process.env.GECHO_LOCAL_TOKEN = token;
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
  const status = await getBridgeStatus();
  sendStatus(status);
  // 检查是否有活跃定时任务，同步防休眠状态
  try {
    const { getActiveTasks } = require("../scheduled-task-store");
    const active = Array.isArray(getActiveTasks()) ? getActiveTasks() : [];
    syncPowerSaveBlocker(active.length > 0);
  } catch (_e) {
    // scheduled-task-store 未载入时忽略（Bridge 未启动等情况）
  }
}

function getAutoStartEnabled() {
  return Boolean(app.getLoginItemSettings(loginItemOptions(process.platform, process.execPath)).openAtLogin);
}

function getMacTrayPath() {
  const relativePath = path.join("desktop", "macos-tray", "GechoTray.app", "Contents", "MacOS", "GechoTray");
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", relativePath) : path.join(__dirname, "macos-tray", "GechoTray.app", "Contents", "MacOS", "GechoTray");
}

function macTrayStatusPayload() {
  const t = (k, vars) => i18n.t(k, vars);
  return {
    type: "status",
    version: app.getVersion(),
    locale: i18n.getLocale(),
    serviceTitle: t("serviceLabel"),
    serviceLabel: lastStatus.service === "running" ? t("serviceRunning") : lastStatus.service === "starting" ? t("serviceStarting") : t("serviceStopped"),
    extensionTitle: t("extLabel"),
    extensionConnected: Boolean(lastStatus.extensionConnected),
    extensionStatusLabel: lastStatus.extensionConnected ? t("extConnected") : t("extDisconnected"),
    browserTitle: t("browserLabel"),
    browser: lastStatus.browser || "—",
    autoStart: getAutoStartEnabled(),
    trayOpenDashboard: t("trayOpenDashboard"),
    trayOpenOnboarding: t("trayOpenOnboarding"),
    trayOpenData: t("trayOpenData"),
    trayExportLogs: t("trayExportLogs"),
    trayCheckUpdate: t("trayCheckUpdate"),
    trayAutoStart: t("trayAutoStart"),
    trayQuit: t("trayQuit"),
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
    if (quitting) return; // 真正退出时直接销毁
    // 关闭控制面板时 destroy 渲染进程，释放 Chromium 内存（~60-120MB）
    // 下次从托盘打开时重新创建，成本极低（< 200ms）
    event.preventDefault();
    dashboardWindow.destroy();
    dashboardWindow = null;
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
  ipcMain.handle("check-for-updates", (_event, options) => updater.checkForUpdates({ manual: true, ...options }));
  ipcMain.handle("get-update-state", () => updater.getUpdateState());
  ipcMain.handle("download-update", (_event, options) => updater.downloadUpdate(options));
  ipcMain.handle("quit-and-install", () => updater.quitAndInstall({
    cleanupCallback: () => {
      quitting = true;
      stopMacTray();
    },
  }));
  ipcMain.handle("get-local-token", () => process.env.GECHO_LOCAL_TOKEN || "");
  ipcMain.handle("get-locale", () => i18n.getLocale());
  ipcMain.handle("set-locale", (_event, locale) => {
    const updated = i18n.setLocale(locale);
    menuSignature = "";
    macTrayStatusSignature = "";
    updateMenu();
    return updated;
  });
  ipcMain.handle("get-translations", (_event, locale) => i18n.getTranslations(locale));
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
    case "check-for-updates":
      updater.checkForUpdates({ manual: true });
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
  const t = (k) => i18n.t(k);
  const autoStart = getAutoStartEnabled();
  const signature = JSON.stringify([lastStatus, autoStart, i18n.getLocale()]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Gecho ${app.getVersion()}`, enabled: false },
    { label: `${t("serviceLabel")}：${lastStatus.service === "running" ? t("serviceRunning") : lastStatus.service === "starting" ? t("serviceStarting") : t("serviceStopped")}`, enabled: false },
    { label: `${t("extLabel")}：${lastStatus.extensionConnected ? t("extConnected") : t("extDisconnected")}`, enabled: false },
    { label: `${t("browserLabel")}：${lastStatus.browser || "—"}`, enabled: false },
    { type: "separator" },
    { label: t("trayOpenDashboard"), click: () => openDashboardWindow() },
    { label: t("trayOpenOnboarding"), click: () => shell.openExternal(ONBOARDING_URL) },
    { label: t("trayOpenData"), click: () => shell.openPath(lastStatus.dataDir || getDefaultDataDir()) },
    { label: t("trayExportLogs"), click: () => handleExportDiagnostics() },
    { label: t("trayCheckUpdate"), click: () => updater.checkForUpdates({ manual: true }) },
    { label: t("trayAutoStart"), type: "checkbox", checked: autoStart, click: (item) => {
      try {
        app.setLoginItemSettings({ ...loginItemOptions(process.platform, process.execPath), openAtLogin: item.checked });
      } catch (error) {
        dialog.showErrorBox("自动启动设置失败", error.message);
      }
      menuSignature = "";
      updateMenu();
    } },
    { type: "separator" },
    { label: t("trayQuit"), click: () => app.quit() },
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
  if (process.platform === "win32") {
    tray.on("click", () => tray.popUpContextMenu());
    tray.on("double-click", () => openDashboardWindow());
  }
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    openDashboardWindow();
    tray?.popUpContextMenu();
  });
  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("ai.gecho.desktop");
    i18n.initLocale();
    registerIpc();
    try {
      createTray();
      if (process.platform === "darwin") app.dock.hide();
      updater.onStateChange((state) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send("update-status", state);
        }
      });
      await startBridge();
      await refreshStatus();
      statusTimer = setInterval(refreshStatus, 2000);
      // 启动 8 秒后进行一次静默后台版本检查，不打扰用户
      setTimeout(() => {
        if (!quitting) {
          updater.checkForUpdates({ manual: false }).catch(() => {});
        }
      }, 8000).unref?.();
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
    // 退出前释放防休眠锁
    if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
  });
}
