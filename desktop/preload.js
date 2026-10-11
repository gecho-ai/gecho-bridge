const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gechoDesktop", {
  getAccountStatus: () => ipcRenderer.invoke('account-status'),
  loginAccount: () => ipcRenderer.invoke('account-login'),
  cancelAccountLogin: () => ipcRenderer.invoke('account-cancel'),
  logoutAccount: () => ipcRenderer.invoke('account-logout'),
  onAccountStatus: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('account-status', listener);
    return () => ipcRenderer.removeListener('account-status', listener);
  },
  getStatus: () => ipcRenderer.invoke("bridge-status"),
  getBrowserEnvironment: () => ipcRenderer.invoke("browser-environment"),
  setPreferences: (patch) => ipcRenderer.invoke("set-desktop-preferences", patch),
  launchBrowser: () => ipcRenderer.invoke("launch-selected-browser"),
  getAppInfo: () => ipcRenderer.invoke("app-info"),
  openOnboarding: () => ipcRenderer.invoke("open-onboarding"),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  exportDiagnostics: () => ipcRenderer.invoke("export-diagnostics"),
  runHealthCheck: (checkNetwork = false) => ipcRenderer.invoke("run-health-check", { checkNetwork: Boolean(checkNetwork) }),
  setAutoStart: (enabled) => ipcRenderer.invoke("set-auto-start", Boolean(enabled)),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  quit: () => ipcRenderer.invoke("quit-app"),
  getScheduledTasks: () => ipcRenderer.invoke("get-scheduled-tasks"),
  toggleScheduledTask: (taskId) => ipcRenderer.invoke("toggle-scheduled-task", taskId),
  runScheduledTaskNow: (taskId) => ipcRenderer.invoke("run-scheduled-task-now", taskId),
  getLocale: () => ipcRenderer.invoke("get-locale"),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  getTranslations: (locale) => ipcRenderer.invoke("get-translations", locale),
  checkForUpdates: (options) => ipcRenderer.invoke("check-for-updates", options),
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  downloadUpdate: (options) => ipcRenderer.invoke("download-update", options),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  getLocalToken: () => ipcRenderer.invoke("get-local-token"),
  onUpdateStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("update-status", listener);
    return () => ipcRenderer.removeListener("update-status", listener);
  },
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("bridge-status", listener);
    return () => ipcRenderer.removeListener("bridge-status", listener);
  },
});
