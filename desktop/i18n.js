"use strict";

const translations = {
  "zh-CN": {
    appTitle: "Gecho 控制面板",
    appSubtitle: "控制面板 · 桌面助手",
    serviceRunning: "运行中",
    serviceStarting: "启动中",
    serviceStopped: "未运行",
    serviceBadgeReady: "浏览器已连接",
    serviceBadgePending: "等待浏览器插件",
    serviceBadgeError: "Bridge 未运行",
    serviceLabel: "本地 Bridge",
    extConnected: "已连接",
    extDisconnected: "未连接",
    extLabel: "浏览器插件",
    browserLabel: "当前浏览器",
    profileLabel: "Profile",
    navOnboarding: "连接引导",
    navDataDir: "数据目录",
    navExportLogs: "导出日志",
    healthTitle: "环境自检",
    healthDescription: "检查服务、插件、浏览器及磁盘；不会修改系统设置。",
    healthNetwork: "同时访问官网及 TikTok 检查网络",
    healthRun: "开始自检",
    tasksTitle: "定时抓取任务",
    tasksSubtitle: "按预设时间周期在真实浏览器环境中自动执行 TikTok 数据采集与同步",
    tasksCount: "{total} 个任务已配置 ({active} 个运行中)",
    btnCreateTask: "+ 新建任务",
    loadingTasks: "正在加载定时任务配置...",
    cronLabel: "调度周期:",
    targetLabel: "抓取目标:",
    lastRunLabel: "上次执行:",
    lastResultLabel: "上次结果:",
    nextRunLabel: "下次触发:",
    statusActive: "运行中",
    statusPaused: "已暂停",
    statusRunning: "执行中",
    btnRunNow: "立即执行",
    btnRunning: "执行中...",
    btnPause: "暂停任务",
    btnResume: "恢复任务",
    toastRunTriggered: "已触发任务 [{name}]",
    toastRunSuccess: "任务 [{name}] 执行完成！",
    toastPaused: "已暂停任务 [{name}]",
    toastResumed: "已启用任务 [{name}]",
    toastCreatePending: "提示：可视化创建定时任务功能正在开发中",
    summaryBridge: "本地 Bridge 引擎",
    summaryExt: "浏览器插件通信",
    summaryBrowser: "当前挂载浏览器",
    summaryProfile: "浏览器 Profile",
    settingsAutoStart: "开机自启动",
    settingsAutoStartDesc: "开机登录系统时静默拉起 Gecho 桌面端，常驻托盘守护采集任务。",
    btnHide: "隐藏到托盘",
    btnQuit: "退出 Gecho",
    networkOffline: "⚠️ 网络连接已断开，数据采集与服务通信可能会受到影响",
    networkRestored: "网络连接已恢复",
    networkDisconnected: "网络连接已断开",
    trayOpenDashboard: "打开面板",
    trayOpenOnboarding: "打开浏览器连接引导",
    trayOpenData: "打开数据目录",
    trayExportLogs: "导出诊断日志",
    trayCheckUpdate: "检查更新...",
    trayAutoStart: "登录时自动启动",
    trayQuit: "退出 Gecho",
    btnCheckUpdate: "检查更新",
    checkingUpdate: "正在检查更新...",
    updateAvailableTitle: "发现新版本",
    updateAvailableMsg: "发现新版本 {version}，是否前往下载？",
    updateLatestTitle: "已是最新版本",
    updateLatestMsg: "当前已是最新版本 ({version})。",
    updateErrorTitle: "检查更新失败",
    btnGoDownload: "前往下载",
    btnLater: "稍后再说",
    updateChecking: "正在检查更新...",
    updateDownloading: "正在下载更新 ({percent}%)...",
    updateDownloaded: "更新已下载完成，准备安装",
    btnInstallNow: "立即安装并重启",
    btnRetryUpdate: "重试更新",
    updateNoRelease: "当前暂无发布记录或更新源未就绪。",
    updateNoMatchingAsset: "发现新版本 {version}，但暂无适用于当前系统与架构 ({platform}-{arch}) 的安装包。",
    updateRateLimit: "GitHub 请求频率达到上限，请稍后重试。",
    updateTimeout: "检查更新超时，请检查网络连接。",
    updateOffline: "网络连接已断开，无法检查更新。",
    updateDownloadFailed: "安装包下载失败: {error}",
    updateVerifyFailed: "安装包校验失败，文件可能已损坏。",
    updateInstalling: "正在启动安装程序并退出旧版本...",
    updateDataPreservedNotice: "说明：升级将完整保留您的任务记录与历史配置。",
  },
  "en-US": {
    appTitle: "Gecho Dashboard",
    appSubtitle: "Dashboard · Desktop Assistant",
    serviceRunning: "Running",
    serviceStarting: "Starting",
    serviceStopped: "Stopped",
    serviceBadgeReady: "Browser Connected",
    serviceBadgePending: "Waiting for Extension",
    serviceBadgeError: "Bridge Stopped",
    serviceLabel: "Local Bridge",
    extConnected: "Connected",
    extDisconnected: "Disconnected",
    extLabel: "Browser Extension",
    browserLabel: "Browser",
    profileLabel: "Profile",
    navOnboarding: "Onboarding",
    navDataDir: "Data Dir",
    navExportLogs: "Export Logs",
    healthTitle: "Environment checks",
    healthDescription: "Check Bridge, extension, browser and disk without changing system settings.",
    healthNetwork: "Also check connectivity to Gecho and TikTok",
    healthRun: "Run checks",
    tasksTitle: "Scheduled Extraction Tasks",
    tasksSubtitle: "Automatically perform TikTok data extraction and sync in real browser environment",
    tasksCount: "{total} tasks configured ({active} active)",
    btnCreateTask: "+ New Task",
    loadingTasks: "Loading scheduled task configs...",
    cronLabel: "Schedule:",
    targetLabel: "Target:",
    lastRunLabel: "Last Run:",
    lastResultLabel: "Last Result:",
    nextRunLabel: "Next Run:",
    statusActive: "Active",
    statusPaused: "Paused",
    statusRunning: "Running",
    btnRunNow: "Run Now",
    btnRunning: "Running...",
    btnPause: "Pause",
    btnResume: "Resume",
    toastRunTriggered: "Triggered task [{name}]",
    toastRunSuccess: "Task [{name}] completed!",
    toastPaused: "Paused task [{name}]",
    toastResumed: "Resumed task [{name}]",
    toastCreatePending: "Notice: Visual task creator is coming soon",
    summaryBridge: "Local Bridge Engine",
    summaryExt: "Browser Extension Channel",
    summaryBrowser: "Current Browser",
    summaryProfile: "Browser Profile",
    settingsAutoStart: "Launch at Startup",
    settingsAutoStartDesc: "Silently launch Gecho on system startup and stay in system tray to guard tasks.",
    btnHide: "Minimize to Tray",
    btnQuit: "Quit Gecho",
    networkOffline: "⚠️ Network disconnected. Data extraction and sync might be affected.",
    networkRestored: "Network connection restored",
    networkDisconnected: "Network connection lost",
    trayOpenDashboard: "Open Dashboard",
    trayOpenOnboarding: "Open Connection Guide",
    trayOpenData: "Open Data Directory",
    trayExportLogs: "Export Diagnostic Logs",
    trayCheckUpdate: "Check for Updates...",
    trayAutoStart: "Start on Login",
    trayQuit: "Quit Gecho",
    btnCheckUpdate: "Check for Updates",
    checkingUpdate: "Checking for updates...",
    updateAvailableTitle: "Update Available",
    updateAvailableMsg: "A new version {version} is available. Do you want to download it?",
    updateLatestTitle: "Up to Date",
    updateLatestMsg: "Gecho is up to date ({version}).",
    updateErrorTitle: "Update Check Failed",
    btnGoDownload: "Download Now",
    btnLater: "Later",
    updateChecking: "Checking for updates...",
    updateDownloading: "Downloading update ({percent}%)...",
    updateDownloaded: "Update downloaded and ready to install",
    btnInstallNow: "Install & Restart",
    btnRetryUpdate: "Retry",
    updateNoRelease: "No release available or update feed not ready.",
    updateNoMatchingAsset: "New version {version} found, but no matching package for {platform}-{arch}.",
    updateRateLimit: "API rate limit reached. Please try again later.",
    updateTimeout: "Update check timed out. Please check your network.",
    updateOffline: "Network is offline. Cannot check for updates.",
    updateDownloadFailed: "Failed to download update: {error}",
    updateVerifyFailed: "Update package verification failed (corrupted file).",
    updateInstalling: "Launching installer and closing current version...",
    updateDataPreservedNotice: "Note: Upgrade preserves all user tasks and configurations.",
  }
};

let currentLocale = "zh-CN";

function detectSystemLocale() {
  try {
    const { app } = require("electron");
    const sysLocale = app?.getLocale?.() || "";
    if (sysLocale.toLowerCase().startsWith("en")) {
      return "en-US";
    }
  } catch (_e) {
    const envLang = process.env.LANG || process.env.LANGUAGE || "";
    if (envLang.toLowerCase().startsWith("en")) {
      return "en-US";
    }
  }
  return "zh-CN";
}

function initLocale(preferredLocale) {
  if (preferredLocale && translations[preferredLocale]) {
    currentLocale = preferredLocale;
  } else {
    currentLocale = detectSystemLocale();
  }
  return currentLocale;
}

function setLocale(locale) {
  if (translations[locale]) {
    currentLocale = locale;
  }
  return currentLocale;
}

function getLocale() {
  return currentLocale;
}

function t(key, vars = {}) {
  const dict = translations[currentLocale] || translations["zh-CN"];
  let str = dict[key] || translations["zh-CN"][key] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return str;
}

function getTranslations(locale) {
  return translations[locale] || translations[currentLocale] || translations["zh-CN"];
}

module.exports = {
  translations,
  initLocale,
  setLocale,
  getLocale,
  t,
  getTranslations,
};
