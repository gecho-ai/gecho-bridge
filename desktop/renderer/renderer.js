const $ = (id) => document.getElementById(id);

let currentLocale = "zh-CN";
let dict = {};
let cachedStatus = null;
let cachedTasks = [];
let cachedUpdateState = null;
let toastTimer = null;
let updateFadeTimer = null;

function t(key, vars = {}) {
  let str = (dict && dict[key]) || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return str;
}

function showToast(message) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2400);
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key && dict[key]) {
      el.textContent = dict[key];
    }
  });

  const langBtn = $("lang-toggle-btn");
  if (langBtn) {
    langBtn.textContent = currentLocale === "zh-CN" ? "EN" : "中";
    langBtn.title = currentLocale === "zh-CN" ? "Switch to English" : "切换为中文";
  }

  if (cachedStatus) renderStatus(cachedStatus);
  if (cachedTasks && cachedTasks.length > 0) renderTasks(cachedTasks);
  if (cachedUpdateState) renderUpdateState(cachedUpdateState);
}

function renderStatus(status) {
  cachedStatus = status;
  const running = status.service === "running";
  const connected = status.extensionConnected;
  const badge = $("service-badge");
  if (badge) {
    badge.textContent = running
      ? (connected ? t("serviceBadgeReady") : t("serviceBadgePending"))
      : t("serviceBadgeError");
    badge.className = `badge ${connected ? "ready" : running ? "pending" : "error"}`;
  }
  if ($("service-status")) {
    $("service-status").textContent = running ? t("serviceRunning") : t("serviceStopped");
  }
  if ($("extension-status")) {
    $("extension-status").textContent = connected ? t("extConnected") : t("extDisconnected");
  }
  if ($("browser-status")) $("browser-status").textContent = status.browser || "—";
  if ($("profile-status")) $("profile-status").textContent = status.profile || "—";
}

function renderTasks(tasks) {
  cachedTasks = tasks;
  const listContainer = $("tasks-list");
  if (!listContainer) return;

  const totalCount = tasks.length;
  const activeCount = tasks.filter((t) => t.status === "active").length;
  const badge = $("task-stats-badge");
  if (badge) {
    badge.textContent = t("tasksCount", { total: totalCount, active: activeCount });
  }

  listContainer.innerHTML = "";
  tasks.forEach((task) => {
    const card = document.createElement("div");
    card.className = `task-card ${task.status === "paused" ? "paused" : ""}`;
    card.id = `card-${task.id}`;

    const isRunning = task.status === "running";
    const isActive = task.status === "active";
    const statusText = isRunning ? t("statusRunning") : isActive ? t("statusActive") : t("statusPaused");
    const statusClass = isRunning ? "running" : isActive ? "active" : "paused";
    const nextRunText = task.nextRun || "—";

    card.innerHTML = `
      <div class="task-card-top">
        <div class="task-name-group">
          <span class="task-name">${task.name}</span>
          <span class="task-status-pill ${statusClass}" id="pill-${task.id}">${statusText}</span>
        </div>
        <div class="task-timing">${t("nextRunLabel")} ${nextRunText}</div>
      </div>

      <div class="task-meta-grid">
        <div class="meta-item">
          <span class="meta-label">${t("cronLabel")}</span>
          <span class="meta-value highlight">${task.cronDesc} <span style="opacity:0.6;font-size:11px;">(${task.cron})</span></span>
        </div>
        <div class="meta-item">
          <span class="meta-label">${t("targetLabel")}</span>
          <span class="meta-value">${task.target} · ${task.targetCount}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">${t("lastRunLabel")}</span>
          <span class="meta-value" id="lastrun-${task.id}">${task.lastRun || "—"}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">${t("lastResultLabel")}</span>
          <span class="meta-value" id="lastres-${task.id}">${task.lastResult || "—"}</span>
        </div>
      </div>

      <div class="task-card-bottom">
        <span style="font-size:11px;color:#9ca1b3;">ID: ${task.id}</span>
        <div class="task-actions">
          <button class="btn-task primary-task" id="run-${task.id}">${t("btnRunNow")}</button>
          <button class="btn-task" id="toggle-${task.id}">${isActive ? t("btnPause") : t("btnResume")}</button>
        </div>
      </div>
    `;

    listContainer.appendChild(card);

    // 绑定立即运行
    const runBtn = card.querySelector(`#run-${task.id}`);
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.textContent = t("btnRunning");
      const pill = card.querySelector(`#pill-${task.id}`);
      if (pill) {
        pill.textContent = t("statusRunning");
        pill.className = "task-status-pill running";
      }
      showToast(t("toastRunTriggered", { name: task.name }));

      try {
        const res = await window.gechoDesktop.runScheduledTaskNow(task.id);
        if (res.success && res.task) {
          card.querySelector(`#lastrun-${task.id}`).textContent = res.task.lastRun;
          card.querySelector(`#lastres-${task.id}`).textContent = res.task.lastResult;
          showToast(t("toastRunSuccess", { name: task.name }));
        } else {
          showToast(res.error || "Error");
        }
      } catch (err) {
        showToast(err.message);
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = t("btnRunNow");
        if (pill) {
          pill.textContent = task.status === "active" ? t("statusActive") : t("statusPaused");
          pill.className = `task-status-pill ${task.status === "active" ? "active" : "paused"}`;
        }
      }
    });

    // 绑定暂停/恢复
    const toggleBtn = card.querySelector(`#toggle-${task.id}`);
    toggleBtn.addEventListener("click", async () => {
      toggleBtn.disabled = true;
      try {
        const updatedTasks = await window.gechoDesktop.toggleScheduledTask(task.id);
        const wasActive = task.status === "active";
        renderTasks(updatedTasks);
        showToast(wasActive ? t("toastPaused", { name: task.name }) : t("toastResumed", { name: task.name }));
      } catch (err) {
        showToast(err.message);
      } finally {
        toggleBtn.disabled = false;
      }
    });
  });
}

async function loadScheduledTasks() {
  try {
    if (window.gechoDesktop.getScheduledTasks) {
      const tasks = await window.gechoDesktop.getScheduledTasks();
      renderTasks(tasks || []);
    }
  } catch (err) {
    console.error("Failed to load tasks", err);
  }
}

async function refresh() {
  try {
    renderStatus(await window.gechoDesktop.getStatus());
  } catch (_error) {
    renderStatus({ service: "stopped", extensionConnected: false });
  }
}

async function setLanguage(newLocale) {
  currentLocale = newLocale;
  if (window.gechoDesktop?.setLocale) {
    await window.gechoDesktop.setLocale(newLocale);
  }
  if (window.gechoDesktop?.getTranslations) {
    dict = await window.gechoDesktop.getTranslations(newLocale);
  }
  applyI18n();
}

async function init() {
  if (window.gechoDesktop?.getLocale) {
    currentLocale = await window.gechoDesktop.getLocale();
  }
  if (window.gechoDesktop?.getTranslations) {
    dict = await window.gechoDesktop.getTranslations(currentLocale);
  }
  applyI18n();

  const info = await window.gechoDesktop.getAppInfo();
  if ($("version")) $("version").textContent = `Gecho Desktop ${info.version} · ${info.platform}`;
  if ($("auto-start")) $("auto-start").checked = info.autoStart;

  $("lang-toggle-btn")?.addEventListener("click", async () => {
    const next = currentLocale === "zh-CN" ? "en-US" : "zh-CN";
    await setLanguage(next);
  });

  $("onboarding-btn")?.addEventListener("click", () => window.gechoDesktop.openOnboarding());
  $("data-dir-btn")?.addEventListener("click", () => window.gechoDesktop.openDataDir());
  $("export-logs-btn")?.addEventListener("click", () => window.gechoDesktop.exportDiagnostics());
  $("check-update-btn")?.addEventListener("click", async () => {
    const btn = $("check-update-btn");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = t("checkingUpdate");
    try {
      const res = await window.gechoDesktop.checkForUpdates();
      if (!res?.success) {
        if (res?.errorCode === "NO_RELEASES") {
          showToast(t("updateNoRelease"));
        } else if (res?.errorCode === "RATE_LIMIT") {
          showToast(t("updateRateLimit"));
        } else if (res?.errorCode === "OFFLINE") {
          showToast(t("updateOffline"));
        } else {
          showToast(res?.error || t("updateErrorTitle"));
        }
      } else if (!res.updateAvailable) {
        showToast(t("updateLatestMsg", { version: res.currentVersion }));
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  });
  $("health-check-btn")?.addEventListener("click", async () => {
    const button = $("health-check-btn");
    button.disabled = true;
    const list = $("health-results");
    list.replaceChildren();
    try {
      const results = await window.gechoDesktop.runHealthCheck($("health-network").checked);
      for (const result of results) {
        const item = document.createElement("li");
        item.textContent = `${result.status.toUpperCase()} · ${result.label}：${result.detail}${result.suggestion ? ` — ${result.suggestion}` : ""}`;
        list.appendChild(item);
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("hide")?.addEventListener("click", () => window.gechoDesktop.hideWindow());
  $("quit")?.addEventListener("click", () => window.gechoDesktop.quit());
  $("auto-start")?.addEventListener("change", (event) => window.gechoDesktop.setAutoStart(event.target.checked));

  $("create-task-btn")?.addEventListener("click", () => {
    showToast(t("toastCreatePending"));
  });

  function updateNetworkBanner() {
    const banner = $("network-banner");
    if (!banner) return;
    if (navigator.onLine === false) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  window.addEventListener("online", () => {
    updateNetworkBanner();
    showToast(t("networkRestored"));
  });
  window.addEventListener("offline", () => {
    updateNetworkBanner();
    showToast(t("networkDisconnected"));
  });
  updateNetworkBanner();

  if (window.gechoDesktop.onUpdateStatus) {
    window.gechoDesktop.onUpdateStatus((state) => {
      renderUpdateState(state);
    });
  }
  if (window.gechoDesktop.getUpdateState) {
    try {
      const initialState = await window.gechoDesktop.getUpdateState();
      renderUpdateState(initialState);
    } catch (_e) {
      // ignore
    }
  }

  window.gechoDesktop.onStatus(renderStatus);
  await refresh();
  await loadScheduledTasks();
}

function renderUpdateState(state) {
  if (!state) return;
  cachedUpdateState = state;

  const wrap = $("update-action-wrap");
  const msg = $("update-msg");
  const progressBar = $("update-progress-bar");
  const progressFill = $("update-progress-fill");
  const actionBtn = $("update-action-btn");

  if (!wrap || !msg || !progressBar || !progressFill || !actionBtn) return;
  clearTimeout(updateFadeTimer);

  switch (state.status) {
    case "checking":
      wrap.classList.remove("hidden");
      msg.textContent = t("updateChecking");
      progressBar.classList.add("hidden");
      actionBtn.classList.add("hidden");
      break;

    case "available":
      wrap.classList.remove("hidden");
      msg.textContent = t("updateAvailableMsg", { version: state.latestVersion });
      progressBar.classList.add("hidden");
      actionBtn.classList.remove("hidden");
      actionBtn.disabled = false;
      actionBtn.textContent = t("btnGoDownload");
      actionBtn.onclick = async () => {
        actionBtn.disabled = true;
        try {
          await window.gechoDesktop.downloadUpdate();
        } catch (err) {
          showToast(err.message);
        }
      };
      break;

    case "downloading": {
      wrap.classList.remove("hidden");
      const pct = Math.round(state.progress?.percent || 0);
      msg.textContent = t("updateDownloading", { percent: pct });
      progressBar.classList.remove("hidden");
      progressFill.style.width = `${pct}%`;
      actionBtn.classList.add("hidden");
      break;
    }

    case "downloaded":
      wrap.classList.remove("hidden");
      msg.textContent = `${t("updateDownloaded")} · ${t("updateDataPreservedNotice")}`;
      progressBar.classList.add("hidden");
      actionBtn.classList.remove("hidden");
      actionBtn.disabled = false;
      actionBtn.textContent = t("btnInstallNow");
      actionBtn.onclick = async () => {
        actionBtn.disabled = true;
        try {
          await window.gechoDesktop.quitAndInstall();
        } catch (err) {
          showToast(err.message);
        }
      };
      break;

    case "installing":
      wrap.classList.remove("hidden");
      msg.textContent = t("updateInstalling");
      progressBar.classList.add("hidden");
      actionBtn.classList.remove("hidden");
      actionBtn.disabled = true;
      actionBtn.textContent = t("btnInstallNow");
      break;

    case "not-available":
      wrap.classList.remove("hidden");
      msg.textContent = t("updateLatestMsg", { version: state.currentVersion });
      progressBar.classList.add("hidden");
      actionBtn.classList.add("hidden");
      updateFadeTimer = setTimeout(() => {
        wrap.classList.add("hidden");
      }, 5000);
      break;

    case "no-matching-asset":
      wrap.classList.remove("hidden");
      msg.textContent = t("updateNoMatchingAsset", {
        version: state.latestVersion,
        platform: state.platform,
        arch: state.arch,
      });
      progressBar.classList.add("hidden");
      actionBtn.classList.add("hidden");
      break;

    case "error": {
      wrap.classList.remove("hidden");
      progressBar.classList.add("hidden");
      let errMsg = state.error || t("updateErrorTitle");
      if (state.errorCode === "OFFLINE") errMsg = t("updateOffline");
      else if (state.errorCode === "TIMEOUT") errMsg = t("updateTimeout");
      else if (state.errorCode === "RATE_LIMIT") errMsg = t("updateRateLimit");
      else if (state.errorCode === "NO_RELEASES") errMsg = t("updateNoRelease");
      else if (state.errorCode === "DOWNLOAD_FAILED") errMsg = t("updateDownloadFailed", { error: state.error || "" });
      else if (state.errorCode === "VERIFICATION_FAILED") errMsg = t("updateVerifyFailed");

      msg.textContent = errMsg;
      actionBtn.classList.remove("hidden");
      actionBtn.disabled = false;
      actionBtn.textContent = t("btnRetryUpdate");
      actionBtn.onclick = async () => {
        actionBtn.disabled = true;
        try {
          await window.gechoDesktop.checkForUpdates();
        } catch (err) {
          showToast(err.message);
        }
      };
      break;
    }

    case "idle":
    default:
      wrap.classList.add("hidden");
      break;
  }
}

init();

