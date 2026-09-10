const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gechoDesktop", {
  getStatus: () => ipcRenderer.invoke("bridge-status"),
  getAppInfo: () => ipcRenderer.invoke("app-info"),
  openOnboarding: () => ipcRenderer.invoke("open-onboarding"),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  setAutoStart: (enabled) => ipcRenderer.invoke("set-auto-start", Boolean(enabled)),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  quit: () => ipcRenderer.invoke("quit-app"),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("bridge-status", listener);
    return () => ipcRenderer.removeListener("bridge-status", listener);
  },
});
