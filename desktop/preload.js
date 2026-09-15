const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gechoDesktop", {
  getStatus: () => ipcRenderer.invoke("bridge-status"),
  getAppInfo: () => ipcRenderer.invoke("app-info"),
  openOnboarding: () => ipcRenderer.invoke("open-onboarding"),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  exportDiagnostics: () => ipcRenderer.invoke("export-diagnostics"),
  setAutoStart: (enabled) => ipcRenderer.invoke("set-auto-start", Boolean(enabled)),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  quit: () => ipcRenderer.invoke("quit-app"),
  getScheduledTasks: () => ipcRenderer.invoke("get-scheduled-tasks"),
  toggleScheduledTask: (taskId) => ipcRenderer.invoke("toggle-scheduled-task", taskId),
  runScheduledTaskNow: (taskId) => ipcRenderer.invoke("run-scheduled-task-now", taskId),
  getLocale: () => ipcRenderer.invoke("get-locale"),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  getTranslations: (locale) => ipcRenderer.invoke("get-translations", locale),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("bridge-status", listener);
    return () => ipcRenderer.removeListener("bridge-status", listener);
  },
});
