const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ScheduledTaskStore } = require("../scheduled-task-store.js");

function taskInput(overrides = {}) {
  return {
    taskRef: "flywheel-123",
    taskVersion: 1,
    entryUrl: "https://gecho.ai/flywheel/tasks/flywheel-123",
    schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
    enabled: true,
    ...overrides
  };
}

test("persists tasks and restores them after a new store is created", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-scheduled-store-"));
  const filePath = path.join(tempDir, "scheduled-tasks.json");
  const nowMs = Date.parse("2026-09-11T00:00:00.000Z");

  try {
    const first = new ScheduledTaskStore({ filePath, now: () => nowMs });
    const created = first.create(taskInput(), nowMs);
    first.appendRun(created.id, {
      id: "trigger-run-1",
      triggerId: "trigger-1",
      status: "dispatched",
      scheduledFor: created.nextRunAt,
      startedAt: nowMs,
      completedAt: nowMs + 500
    });

    const restored = new ScheduledTaskStore({ filePath, now: () => nowMs });
    const loaded = restored.get(created.id);
    assert.equal(loaded.taskRef, "flywheel-123");
    assert.equal(loaded.taskVersion, 1);
    assert.equal(loaded.runs.length, 1);
    assert.equal(loaded.runs[0].status, "dispatched");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upsert updates the same taskRef instead of creating a duplicate", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-scheduled-store-"));
  const filePath = path.join(tempDir, "scheduled-tasks.json");
  const nowMs = Date.parse("2026-09-11T00:00:00.000Z");

  try {
    const store = new ScheduledTaskStore({ filePath, now: () => nowMs });
    const first = store.upsert(taskInput(), nowMs);
    const second = store.upsert(taskInput({
      taskVersion: 2,
      schedule: { type: "daily", time: "10:00", timezone: "Asia/Shanghai" }
    }), nowMs);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(first.job.id).taskVersion, 2);
    assert.equal(store.get(first.job.id).schedule.time, "10:00");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("caps run history and supports pausing a task", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-scheduled-store-"));
  const filePath = path.join(tempDir, "scheduled-tasks.json");
  const nowMs = Date.parse("2026-09-11T00:00:00.000Z");

  try {
    const store = new ScheduledTaskStore({ filePath, maxRuns: 2, now: () => nowMs });
    const created = store.create(taskInput(), nowMs);
    store.appendRun(created.id, { id: "run-1", status: "skipped" });
    store.appendRun(created.id, { id: "run-2", status: "dispatched" });
    store.appendRun(created.id, { id: "run-3", status: "failed" });
    const paused = store.update(created.id, { enabled: false }, nowMs);

    assert.equal(paused.status, "paused");
    assert.equal(paused.nextRunAt, null);
    assert.deepEqual(paused.runs.map((run) => run.id), ["run-2", "run-3"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
