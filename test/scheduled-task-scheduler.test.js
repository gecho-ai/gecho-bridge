const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ScheduledTaskStore } = require("../scheduled-task-store.js");
const { ScheduledTaskScheduler } = require("../scheduled-task-scheduler.js");

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

function withStore(nowMs, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-scheduled-scheduler-"));
  const store = new ScheduledTaskStore({
    filePath: path.join(tempDir, "scheduled-tasks.json"),
    now: () => nowMs
  });
  return Promise.resolve()
    .then(() => callback(store))
    .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));
}

test("dispatches a due task and advances the next daily run without owning the workflow", async () => {
  const createdAt = Date.parse("2026-09-11T00:00:00.000Z");
  const dueAt = Date.parse("2026-09-12T01:00:00.000Z");
  await withStore(dueAt, async (store) => {
    const created = store.create(taskInput(), createdAt);
    const dispatched = [];
    const scheduler = new ScheduledTaskScheduler({
      store,
      now: () => dueAt,
      idFactory: (() => {
        let index = 0;
        return (prefix) => `${prefix}-${++index}`;
      })(),
      dispatchTask: async (task, run) => {
        dispatched.push({ task, run });
        return { requestId: "bridge-request-1", accepted: true };
      }
    });

    await scheduler.runDue(dueAt);
    const task = store.get(created.id);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].task.taskRef, "flywheel-123");
    assert.equal(dispatched[0].run.source, "schedule");
    assert.equal(task.runs[0].status, "dispatched");
    assert.equal(task.runs[0].requestId, "bridge-request-1");
    assert.equal(task.status, "scheduled");
    assert.equal(task.enabled, true);
    assert.equal(task.nextRunAt, "2026-09-13T01:00:00.000Z");
  });
});

test("records trigger failure while keeping a recurring task scheduled", async () => {
  const createdAt = Date.parse("2026-09-11T00:00:00.000Z");
  const dueAt = Date.parse("2026-09-12T01:00:00.000Z");
  await withStore(dueAt, async (store) => {
    const created = store.create(taskInput(), createdAt);
    const scheduler = new ScheduledTaskScheduler({
      store,
      now: () => dueAt,
      dispatchTask: async () => {
        const error = new Error("extension not connected");
        error.code = "EXTENSION_DISCONNECTED";
        throw error;
      }
    });

    await scheduler.runDue(dueAt);
    const task = store.get(created.id);
    assert.equal(task.runs[0].status, "failed");
    assert.equal(task.runs[0].errorCode, "EXTENSION_DISCONNECTED");
    assert.equal(task.status, "scheduled");
    assert.equal(task.enabled, true);
    assert.match(task.lastError, /extension not connected/);
  });
});

test("skips a missed one-time task according to its policy", async () => {
  const createdAt = Date.parse("2026-09-11T00:00:00.000Z");
  const scheduledFor = Date.parse("2026-09-11T01:00:00.000Z");
  const nowMs = Date.parse("2026-09-11T05:00:00.000Z");
  await withStore(nowMs, async (store) => {
    const created = store.create(taskInput({
      schedule: { type: "once", runAt: new Date(scheduledFor).toISOString() },
      misfirePolicy: "skip"
    }), createdAt);
    const scheduler = new ScheduledTaskScheduler({
      store,
      now: () => nowMs,
      misfireGraceMs: 0,
      dispatchTask: async () => {
        throw new Error("should not dispatch");
      }
    });

    await scheduler.runDue(nowMs);
    const task = store.get(created.id);
    assert.equal(task.runs[0].status, "skipped");
    assert.equal(task.runs[0].reason, "MISSED_SCHEDULE");
    assert.equal(task.enabled, false);
    assert.equal(task.status, "skipped");
    assert.equal(task.nextRunAt, null);
  });
});

test("manual run does not consume the future schedule", async () => {
  const nowMs = Date.parse("2026-09-11T00:00:00.000Z");
  await withStore(nowMs, async (store) => {
    const created = store.create(taskInput(), nowMs);
    const originalNextRunAt = created.nextRunAt;
    const scheduler = new ScheduledTaskScheduler({
      store,
      now: () => nowMs,
      dispatchTask: async (_task, run) => ({ accepted: true, triggerId: run.triggerId })
    });

    await scheduler.runNow(created.id);
    const task = store.get(created.id);
    assert.equal(task.runs[0].source, "manual");
    assert.equal(task.runs[0].status, "dispatched");
    assert.equal(task.enabled, true);
    assert.equal(task.nextRunAt, originalNextRunAt);
  });
});

test("prevents overlapping manual and scheduled triggers for one task", async () => {
  const nowMs = Date.parse("2026-09-11T00:00:00.000Z");
  await withStore(nowMs, async (store) => {
    const created = store.create(taskInput(), nowMs);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const scheduler = new ScheduledTaskScheduler({
      store,
      now: () => nowMs,
      dispatchTask: async () => pending
    });

    const first = scheduler.runNow(created.id);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => scheduler.runNow(created.id),
      (error) => error.code === "SCHEDULED_TASK_RUNNING"
    );
    release({ accepted: true });
    await first;
  });
});
