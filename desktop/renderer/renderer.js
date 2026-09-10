const $ = (id) => document.getElementById(id);

function renderStatus(status) {
  const running = status.service === "running";
  const connected = status.extensionConnected;
  $("service-badge").textContent = running ? (connected ? "浏览器已连接" : "等待浏览器插件") : "Bridge 未运行";
  $("service-badge").className = `badge ${connected ? "ready" : running ? "pending" : "error"}`;
  $("service-status").textContent = running ? "运行中" : "未运行";
  $("extension-status").textContent = connected ? "已连接" : "未连接";
  $("browser-status").textContent = status.browser || "—";
  $("profile-status").textContent = status.profile || "—";
}

async function refresh() {
  try {
    renderStatus(await window.gechoDesktop.getStatus());
  } catch (_error) {
    renderStatus({ service: "stopped", extensionConnected: false });
  }
}

async function init() {
  const info = await window.gechoDesktop.getAppInfo();
  $("version").textContent = `Gecho Desktop ${info.version} · ${info.platform}`;
  $("auto-start").checked = info.autoStart;
  $("onboarding").addEventListener("click", () => window.gechoDesktop.openOnboarding());
  $("data-dir").addEventListener("click", () => window.gechoDesktop.openDataDir());
  $("hide").addEventListener("click", () => window.gechoDesktop.hideWindow());
  $("quit").addEventListener("click", () => window.gechoDesktop.quit());
  $("auto-start").addEventListener("change", (event) => window.gechoDesktop.setAutoStart(event.target.checked));
  window.gechoDesktop.onStatus(renderStatus);
  await refresh();
}

init();
