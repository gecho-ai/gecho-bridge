"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  calculateNextRunAtMs,
  normalizeScheduledTask
} = require("./scheduled-task.js");

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getPublicScheduledTask(task) {
  if (!task || typeof task !== "object") return task;
  const { runs = [], ...summary } = task;
  return {
    ...clone(summary),
    nextRunAt: task.enabled && task.status === "scheduled" ? task.nextRunAt || null : null,
    runCount: runs.length,
    latestRun: runs.length ? clone(runs[runs.length - 1]) : null
  };
}

class ScheduledTaskStore {
  constructor({ filePath, maxRuns = 100, now = Date.now, idFactory } = {}) {
    if (!filePath) throw new Error("filePath is required");
    this.filePath = filePath;
    this.maxRuns = Math.max(1, Number(maxRuns) || 100);
    this.now = typeof now === "function" ? now : Date.now;
    this.idFactory = typeof idFactory === "function"
      ? idFactory
      : () => `schedule-${Date.now()}-${crypto.randomUUID()}`;
    this.jobs = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8") || "{}");
    } catch (error) {
      const wrapped = new Error(`Failed to load scheduled tasks: ${error.message}`);
      wrapped.code = "SCHEDULED_TASK_STORE_CORRUPT";
      throw wrapped;
    }

    const savedJobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
    for (const [key, saved] of Object.entries(savedJobs)) {
      if (!saved || typeof saved !== "object") continue;
      try {
        const restored = this.restoreTask(saved, String(saved.id || key));
        this.jobs.set(restored.id, restored);
      } catch (error) {
        // One malformed task should not make every other local task disappear.
        console.warn(`Ignoring invalid scheduled task [${key}]: ${error.message}`);
      }
    }
  }

  restoreTask(saved, id) {
    const normalized = normalizeScheduledTask(
      { ...saved, enabled: false },
      { nowMs: this.now() }
    );
    const enabled = saved.enabled !== false;
    const savedStatus = String(saved.status || "").trim();
    const terminalOnceStatus = ["dispatched", "completed", "failed", "skipped"].includes(savedStatus)
      && normalized.schedule.type === "once";
    const status = !enabled || terminalOnceStatus
      ? (terminalOnceStatus ? savedStatus : "paused")
      : "scheduled";
    const savedNextRunAt = parseTimestamp(saved.nextRunAt);
    const fallbackNextRunAt = normalized.schedule.type === "once"
      ? parseTimestamp(normalized.schedule.runAt)
      : calculateNextRunAtMs(normalized.schedule, this.now());

    return {
      ...normalized,
      id,
      enabled: enabled && !terminalOnceStatus,
      status,
      nextRunAt: enabled && !terminalOnceStatus
        ? new Date(savedNextRunAt || fallbackNextRunAt).toISOString()
        : null,
      runs: Array.isArray(saved.runs) ? clone(saved.runs).slice(-this.maxRuns) : [],
      lastRun: saved.lastRun ? clone(saved.lastRun) : null,
      lastError: String(saved.lastError || ""),
      createdAt: Number(saved.createdAt || this.now()),
      updatedAt: Number(saved.updatedAt || this.now())
    };
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = {
      version: 1,
      savedAt: this.now(),
      jobs: Object.fromEntries(Array.from(this.jobs.entries()).map(([id, job]) => [id, job]))
    };
    fs.writeFileSync(temporaryPath, JSON.stringify(payload), "utf8");
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (_ignore) {}
      throw error;
    }
  }

  get(id) {
    return clone(this.jobs.get(String(id || ""))) || null;
  }

  list() {
    return Array.from(this.jobs.values()).map(clone);
  }

  findByTaskRef(taskRef) {
    const normalizedRef = String(taskRef || "").trim();
    return Array.from(this.jobs.values()).find((job) => job.taskRef === normalizedRef) || null;
  }

  create(input, nowMs = this.now()) {
    const normalized = normalizeScheduledTask(input, { nowMs });
    if (this.findByTaskRef(normalized.taskRef)) {
      const error = new Error("A scheduled task with this taskRef already exists");
      error.code = "SCHEDULED_TASK_EXISTS";
      throw error;
    }

    const now = this.now();
    const id = String(input.id || this.idFactory());
    if (this.jobs.has(id)) {
      const error = new Error("A scheduled task with this id already exists");
      error.code = "SCHEDULED_TASK_ID_EXISTS";
      throw error;
    }
    const job = {
      ...normalized,
      id,
      runs: [],
      lastRun: null,
      lastError: "",
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    try {
      this.save();
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }
    return clone(job);
  }

  upsert(input, nowMs = this.now()) {
    const existing = this.findByTaskRef(input?.taskRef);
    if (!existing) return { created: true, job: this.create(input, nowMs) };
    return { created: false, job: this.update(existing.id, input, nowMs) };
  }

  update(id, patch = {}, nowMs = this.now()) {
    const current = this.jobs.get(String(id || ""));
    if (!current) return null;

    const merged = {
      ...current,
      ...patch,
      schedule: patch.schedule === undefined ? current.schedule : patch.schedule,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled
    };
    const normalized = normalizeScheduledTask(merged, { nowMs });
    if (normalized.taskRef !== current.taskRef) {
      const other = this.findByTaskRef(normalized.taskRef);
      if (other && other.id !== current.id) {
        const error = new Error("A scheduled task with this taskRef already exists");
        error.code = "SCHEDULED_TASK_EXISTS";
        throw error;
      }
    }

    const next = {
      ...current,
      ...normalized,
      runs: Array.isArray(current.runs) ? current.runs.slice(-this.maxRuns) : [],
      lastRun: current.lastRun ? clone(current.lastRun) : null,
      lastError: "",
      updatedAt: this.now()
    };
    this.jobs.set(next.id, next);
    this.save();
    return clone(next);
  }

  updateRuntime(id, patch = {}) {
    const current = this.jobs.get(String(id || ""));
    if (!current) return null;
    const next = { ...current, ...clone(patch), updatedAt: this.now() };
    this.jobs.set(next.id, next);
    this.save();
    return clone(next);
  }

  remove(id) {
    const normalizedId = String(id || "");
    if (!this.jobs.has(normalizedId)) return false;
    this.jobs.delete(normalizedId);
    this.save();
    return true;
  }

  appendRun(id, run) {
    const current = this.jobs.get(String(id || ""));
    if (!current) return null;
    const runs = [...(Array.isArray(current.runs) ? current.runs : []), clone(run)]
      .slice(-this.maxRuns);
    const next = {
      ...current,
      runs,
      lastRun: clone(runs[runs.length - 1]),
      updatedAt: this.now()
    };
    this.jobs.set(next.id, next);
    this.save();
    return clone(next);
  }

  updateRun(id, runId, patch = {}) {
    const current = this.jobs.get(String(id || ""));
    if (!current) return null;
    const runs = Array.isArray(current.runs) ? current.runs : [];
    const index = runs.findIndex((run) => run.id === runId);
    if (index < 0) return null;
    const updatedRun = { ...runs[index], ...clone(patch), updatedAt: this.now() };
    const nextRuns = runs.slice();
    nextRuns[index] = updatedRun;
    const next = {
      ...current,
      runs: nextRuns,
      lastRun: clone(updatedRun),
      updatedAt: this.now()
    };
    this.jobs.set(next.id, next);
    this.save();
    return clone(next);
  }

  public(id) {
    return getPublicScheduledTask(this.get(id));
  }
}

module.exports = {
  ScheduledTaskStore,
  getPublicScheduledTask
};
