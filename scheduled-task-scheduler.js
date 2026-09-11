"use strict";

const crypto = require("node:crypto");

const {
  DEFAULT_MISFIRE_GRACE_MS,
  calculateNextRunAtMs,
  createTriggerPayload,
  shouldDispatchMissedRun
} = require("./scheduled-task.js");

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function defaultIdFactory(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

class ScheduledTaskScheduler {
  constructor({
    store,
    dispatchTask,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    idFactory = defaultIdFactory,
    misfireGraceMs = DEFAULT_MISFIRE_GRACE_MS,
    onError = (error) => console.error("Scheduled task timer failed:", error.message)
  } = {}) {
    if (!store) throw new Error("store is required");
    if (typeof dispatchTask !== "function") throw new Error("dispatchTask is required");
    this.store = store;
    this.dispatchTask = dispatchTask;
    this.now = typeof now === "function" ? now : Date.now;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.idFactory = typeof idFactory === "function" ? idFactory : defaultIdFactory;
    this.misfireGraceMs = Math.max(0, Number(misfireGraceMs) || 0);
    this.onError = onError;
    this.timer = null;
    this.started = false;
    this.activeTaskIds = new Set();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.arm();
  }

  stop() {
    this.started = false;
    if (this.timer) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getNextRunAt() {
    return this.store
      .list()
      .filter((task) => task.enabled && task.status === "scheduled" && parseTimestamp(task.nextRunAt) > 0)
      .sort((a, b) => parseTimestamp(a.nextRunAt) - parseTimestamp(b.nextRunAt))[0]?.nextRunAt || null;
  }

  arm() {
    if (!this.started) return;
    if (this.timer) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }

    const nextRunAt = parseTimestamp(this.getNextRunAt());
    if (!nextRunAt) return;
    const delay = Math.max(0, Math.min(nextRunAt - this.now(), 2 ** 31 - 1));
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.runDue(this.now())
        .catch((error) => this.onError(error))
        .finally(() => this.arm());
    }, delay);
    this.timer.unref?.();
  }

  async runDue(nowMs = this.now()) {
    const dueTasks = this.store
      .list()
      .filter((task) => {
        const nextRunAt = parseTimestamp(task.nextRunAt);
        return task.enabled && task.status === "scheduled" && nextRunAt > 0 && nextRunAt <= nowMs;
      })
      .sort((a, b) => parseTimestamp(a.nextRunAt) - parseTimestamp(b.nextRunAt));

    const results = [];
    for (const task of dueTasks) {
      results.push(await this.runScheduledTask(task, parseTimestamp(task.nextRunAt), nowMs));
    }
    return results;
  }

  async runNow(id) {
    const task = this.store.get(id);
    if (!task) {
      const error = new Error("Scheduled task not found");
      error.code = "SCHEDULED_TASK_NOT_FOUND";
      throw error;
    }
    return this.executeTask(task, this.now(), "manual", { advanceSchedule: false });
  }

  async runScheduledTask(task, scheduledForMs, nowMs = this.now()) {
    if (this.activeTaskIds.has(task.id)) {
      return { skipped: true, reason: "TASK_ALREADY_RUNNING", taskId: task.id };
    }

    const decision = shouldDispatchMissedRun(task, scheduledForMs, nowMs, {
      graceMs: this.misfireGraceMs
    });
    if (!decision.dispatch) {
      return this.recordSkippedTask(task, scheduledForMs, decision.reason, nowMs);
    }
    return this.executeTask(task, scheduledForMs, "schedule", { advanceSchedule: true });
  }

  createRun(task, scheduledForMs, source) {
    const runId = this.idFactory("run");
    return {
      id: runId,
      triggerId: this.idFactory("trigger"),
      taskRef: task.taskRef,
      taskVersion: task.taskVersion,
      source,
      scheduledFor: new Date(scheduledForMs).toISOString(),
      status: "dispatching",
      startedAt: this.now()
    };
  }

  async executeTask(task, scheduledForMs, source, { advanceSchedule }) {
    if (this.activeTaskIds.has(task.id)) {
      const error = new Error("This scheduled task is already running");
      error.code = "SCHEDULED_TASK_RUNNING";
      throw error;
    }
    this.activeTaskIds.add(task.id);

    const run = this.createRun(task, scheduledForMs, source);
    const nextRunAtMs = advanceSchedule && task.schedule.type !== "once"
      ? calculateNextRunAtMs(task.schedule, Math.max(scheduledForMs, this.now()))
      : 0;
    const nextStatusBeforeDispatch = advanceSchedule
      ? (task.schedule.type === "once" ? "dispatching" : "scheduled")
      : task.status;
    this.store.appendRun(task.id, run);
    this.store.updateRuntime(task.id, {
      status: nextStatusBeforeDispatch,
      nextRunAt: advanceSchedule && nextRunAtMs ? new Date(nextRunAtMs).toISOString() : (advanceSchedule ? null : task.nextRunAt),
      lastError: ""
    });

    try {
      const payload = createTriggerPayload(task, run.triggerId);
      const result = await this.dispatchTask(task, { ...run, payload });
      if (result === false || (result && result.accepted === false)) {
        const error = new Error("Extension rejected the scheduled trigger");
        error.code = "TRIGGER_REJECTED";
        throw error;
      }

      const resultPatch = result && typeof result === "object"
        ? {
            requestId: result.requestId ? String(result.requestId) : "",
            acknowledged: result.accepted !== false
          }
        : { acknowledged: true };
      const completedAt = this.now();
      const completedRun = this.store.updateRun(task.id, run.id, {
        status: "dispatched",
        ...resultPatch,
        dispatchedAt: completedAt,
        completedAt
      });
      const current = this.store.get(task.id);
      const finalStatus = advanceSchedule
        ? (task.schedule.type === "once" ? "dispatched" : (current.enabled ? "scheduled" : "paused"))
        : current.status;
      const finalEnabled = advanceSchedule && task.schedule.type === "once" ? false : current.enabled;
      const finalNextRunAt = advanceSchedule
        ? (task.schedule.type === "once" ? null : current.nextRunAt)
        : current.nextRunAt;
      const finalTask = this.store.updateRuntime(task.id, {
        status: finalStatus,
        enabled: finalEnabled,
        nextRunAt: finalNextRunAt,
        lastRun: completedRun?.lastRun || null,
        lastTriggeredAt: completedAt,
        lastError: ""
      });
      return { task: finalTask, run: completedRun?.lastRun || null };
    } catch (error) {
      const failedAt = this.now();
      const failedRun = this.store.updateRun(task.id, run.id, {
        status: "failed",
        error: error.message || "Failed to dispatch scheduled task",
        errorCode: error.code || "TRIGGER_FAILED",
        completedAt: failedAt
      });
      const current = this.store.get(task.id);
      const finalStatus = advanceSchedule
        ? (task.schedule.type === "once" ? "failed" : (current.enabled ? "scheduled" : "paused"))
        : current.status;
      const finalEnabled = advanceSchedule && task.schedule.type === "once" ? false : current.enabled;
      const finalNextRunAt = advanceSchedule
        ? (task.schedule.type === "once" ? null : current.nextRunAt)
        : current.nextRunAt;
      const finalTask = this.store.updateRuntime(task.id, {
        status: finalStatus,
        enabled: finalEnabled,
        nextRunAt: finalNextRunAt,
        lastRun: failedRun?.lastRun || null,
        lastError: error.message || "Failed to dispatch scheduled task"
      });
      return { task: finalTask, run: failedRun?.lastRun || null };
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }

  recordSkippedTask(task, scheduledForMs, reason, nowMs = this.now()) {
    const run = {
      ...this.createRun(task, scheduledForMs, "schedule"),
      status: "skipped",
      reason,
      completedAt: nowMs
    };
    const nextRunAtMs = task.schedule.type === "once"
      ? 0
      : calculateNextRunAtMs(task.schedule, nowMs);
    this.store.appendRun(task.id, run);
    const finalTask = this.store.updateRuntime(task.id, {
      status: task.schedule.type === "once" ? "skipped" : (task.enabled ? "scheduled" : "paused"),
      enabled: task.schedule.type === "once" ? false : task.enabled,
      nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null,
      lastError: reason,
      lastRun: run
    });
    return { task: finalTask, run };
  }
}

module.exports = {
  ScheduledTaskScheduler
};
