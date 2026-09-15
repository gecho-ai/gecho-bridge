const $ = (id) => document.getElementById(id);

let toastTimer = null;
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

function renderStatus(status) {
  const running = status.service === "running";
  const connected = status.extensionConnected;
  const badge = $("service-badge");
  if (badge) {
    badge.textContent = running ? (connected ? "浏览器已连接" : "等待浏览器插件") : "Bridge 未运行";
    badge.className = `badge ${connected ? "ready" : running ? "pending" : "error"}`;
  }
  if ($("service-status")) $("service-status").textContent = running ? "运行中" : "未运行";
  if ($("extension-status")) $("extension-status").textContent = connected ? "已连接" : "未连接";
  if ($("browser-status")) $("browser-status").textContent = status.browser || "—";
  if ($("profile-status")) $("profile-status").textContent = status.profile || "—";
}

function renderTasks(tasks) {
  const listContainer = $("tasks-list");
  if (!listContainer) return;

  const totalCount = tasks.length;
  const activeCount = tasks.filter((t) => t.status === "active").length;
  const badge = $("task-stats-badge");
  if (badge) {
    badge.textContent = `${totalCount} 个任务已配置 (${activeCount} 个运行中)`;
  }

  listContainer.innerHTML = "";
  tasks.forEach((task) => {
    const card = document.createElement("div");
    card.className = `task-card ${task.status === "paused" ? "paused" : ""}`;
    card.id = `card-${task.id}`;

    const isRunning = task.status === "running";
    const isActive = task.status === "active";
    const statusText = isRunning ? "执行中" : isActive ? "运行中" : "已暂停";
    const statusClass = isRunning ? "running" : isActive ? "active" : "paused";

    card.innerHTML = `
      <div class="task-card-top">
        <div class="task-name-group">
          <span class="task-name">${task.name}</span>
          <span class="task-status-pill ${statusClass}" id="pill-${task.id}">${statusText}</span>
        </div>
        <div class="task-timing">下次触发：${task.nextRun || "未设定"}</div>
      </div>

      <div class="task-meta-grid">
        <div class="meta-item">
          <span class="meta-label">调度周期:</span>
          <span class="meta-value highlight">${task.cronDesc} <span style="opacity:0.6;font-size:11px;">(${task.cron})</span></span>
        </div>
        <div class="meta-item">
          <span class="meta-label">抓取目标:</span>
          <span class="meta-value">${task.target} · ${task.targetCount} 条</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">上次执行:</span>
          <span class="meta-value" id="lastrun-${task.id}">${task.lastRun || "—"}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">上次结果:</span>
          <span class="meta-value" id="lastres-${task.id}">${task.lastResult || "—"}</span>
        </div>
      </div>

      <div class="task-card-bottom">
        <span style="font-size:11px;color:#9ca1b3;">ID: ${task.id}</span>
        <div class="task-actions">
          <button class="btn-task primary-task" id="run-${task.id}">立即执行</button>
          <button class="btn-task" id="toggle-${task.id}">${isActive ? "暂停任务" : "恢复任务"}</button>
        </div>
      </div>
    `;

    listContainer.appendChild(card);

    // 绑定立即运行
    const runBtn = card.querySelector(`#run-${task.id}`);
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.textContent = "执行中...";
      const pill = card.querySelector(`#pill-${task.id}`);
      if (pill) {
        pill.textContent = "执行中";
        pill.className = "task-status-pill running";
      }
      showToast(`已触发任务 [${task.name}]`);

      try {
        const res = await window.gechoDesktop.runScheduledTaskNow(task.id);
        if (res.success && res.task) {
          card.querySelector(`#lastrun-${task.id}`).textContent = res.task.lastRun;
          card.querySelector(`#lastres-${task.id}`).textContent = res.task.lastResult;
          showToast(`任务 [${task.name}] 执行完成！`);
        } else {
          showToast(`执行失败: ${res.error || "未知错误"}`);
        }
      } catch (err) {
        showToast(`执行出错: ${err.message}`);
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "立即执行";
        if (pill) {
          pill.textContent = task.status === "active" ? "运行中" : "已暂停";
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
        renderTasks(updatedTasks);
        showToast(`已${task.status === "active" ? "暂停" : "启用"}任务 [${task.name}]`);
      } catch (err) {
        showToast(`操作失败: ${err.message}`);
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

async function init() {
  const info = await window.gechoDesktop.getAppInfo();
  if ($("version")) $("version").textContent = `Gecho Desktop ${info.version} · ${info.platform}`;
  if ($("auto-start")) $("auto-start").checked = info.autoStart;

  $("onboarding-btn")?.addEventListener("click", () => window.gechoDesktop.openOnboarding());
  $("data-dir-btn")?.addEventListener("click", () => window.gechoDesktop.openDataDir());
  $("export-logs-btn")?.addEventListener("click", () => window.gechoDesktop.exportDiagnostics());
  $("hide")?.addEventListener("click", () => window.gechoDesktop.hideWindow());
  $("quit")?.addEventListener("click", () => window.gechoDesktop.quit());
  $("auto-start")?.addEventListener("change", (event) => window.gechoDesktop.setAutoStart(event.target.checked));

  $("create-task-btn")?.addEventListener("click", () => {
    showToast("提示：可视化创建定时任务功能正在开发中");
  });

  window.gechoDesktop.onStatus(renderStatus);
  await refresh();
  await loadScheduledTasks();
}

init();

