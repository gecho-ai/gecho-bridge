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
const http = require("node:http");
const path = require("node:path");

const { getDefaultDataDir } = require(path.join(__dirname, "..", "data-dir.js"));

const SERVICE_URL = `http://127.0.0.1:${process.env.GECHO_HTTP_PORT || 18793}`;
const SERVICE_PING_URL = `${SERVICE_URL}/ping`;
const ONBOARDING_URL = `${SERVICE_URL}/onboarding`;
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let mainWindow = null;
let tray = null;
let quitting = false;
let bridgeMode = "starting";
let statusTimer = null;

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
  process.env.GECHO_AUTO_OPEN_ON_FIRST_START = "0";
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge-status", status);
  }
  if (tray) {
    tray.setToolTip(status.extensionConnected ? "Gecho：浏览器已连接" : "Gecho：等待浏览器插件");
  }
}

async function refreshStatus() {
  sendStatus(await getBridgeStatus());
}

function getAutoStartEnabled() {
  return Boolean(app.getLoginItemSettings().openAtLogin);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Gecho",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip("Gecho");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Gecho", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "退出 Gecho", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => mainWindow?.show());
}

function registerIpc() {
  ipcMain.handle("bridge-status", () => getBridgeStatus());
  ipcMain.handle("app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    autoStart: getAutoStartEnabled(),
    dataDir: getDefaultDataDir(),
  }));
  ipcMain.handle("open-onboarding", () => shell.openExternal(ONBOARDING_URL));
  ipcMain.handle("open-data-dir", () => shell.openPath(getDefaultDataDir()));
  ipcMain.handle("set-auto-start", (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return getAutoStartEnabled();
  });
  ipcMain.handle("hide-window", () => mainWindow?.hide());
  ipcMain.handle("quit-app", () => { quitting = true; app.quit(); });
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => mainWindow?.show());
  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("ai.gecho.desktop");
    registerIpc();
    try {
      await startBridge();
      createWindow();
      createTray();
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
    if (statusTimer) clearInterval(statusTimer);
  });
}
