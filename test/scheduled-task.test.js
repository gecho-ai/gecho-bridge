const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_TRIGGER_ACTION,
  calculateNextRunAtMs,
  createTriggerPayload,
  normalizeMisfirePolicy,
  normalizeSchedule,
  normalizeScheduledTask,
  shouldDispatchMissedRun
} = require("../scheduled-task.js");

test("normalizes a daily schedule and calculates the next run in its timezone", () => {
  const schedule = normalizeSchedule({
    type: "daily",
    time: "09:00",
    timezone: "Asia/Shanghai"
  });

  assert.deepEqual(schedule, {
    type: "daily",
    time: "09:00",
    timezone: "Asia/Shanghai"
  });

  const after = Date.parse("2026-09-11T08:30:00.000Z");
  assert.equal(
    new Date(calculateNextRunAtMs(schedule, after)).toISOString(),
    "2026-09-12T01:00:00.000Z"
  );
});

test("normalizes weekly days and rejects invalid schedule values", () => {
  assert.deepEqual(
    normalizeSchedule({
      type: "weekly",
      time: "09:05",
      timezone: "UTC",
      days: [5, 1, 5]
    }),
    { type: "weekly", time: "09:05", timezone: "UTC", days: [1, 5] }
  );

  assert.throws(
    () => normalizeSchedule({ type: "daily", time: "9:00", timezone: "UTC" }),
    /HH:mm/
  );
  assert.throws(
    () => normalizeSchedule({ type: "daily", time: "09:00", timezone: "Not/AZone" }),
    /Invalid timezone/
  );
  assert.throws(
    () => normalizeSchedule({ type: "weekly", time: "09:00", timezone: "UTC", days: [7] }),
    /weekday numbers/
  );
});

test("normalizes the website-owned flywheel task contract", () => {
  const task = normalizeScheduledTask({
    taskRef: "flywheel-123",
    taskVersion: 4,
    entryUrl: "https://gecho.ai/flywheel/tasks/flywheel-123",
    schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
    enabled: true
  });

  assert.equal(task.taskRef, "flywheel-123");
  assert.equal(task.taskVersion, 4);
  assert.equal(task.triggerAction, DEFAULT_TRIGGER_ACTION);
  assert.equal(task.enabled, true);
  assert.match(task.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.throws(
    () => normalizeScheduledTask({
      taskRef: "flywheel-123",
      entryUrl: "https://example.com/task",
      schedule: { type: "daily", time: "09:00", timezone: "UTC" }
    }),
    /entryUrl must belong to the configured Gecho website origin/
  );
});

test("builds a trigger payload without business workflow data", () => {
  const task = normalizeScheduledTask({
    taskRef: "flywheel-123",
    taskVersion: 4,
    entryUrl: "https://gecho.ai/flywheel/tasks/flywheel-123",
    schedule: { type: "once", runAt: "2026-09-12T01:00:00.000Z" }
  }, { nowMs: Date.parse("2026-09-11T00:00:00.000Z") });

  const payload = createTriggerPayload(task, "trigger-abc");
  assert.deepEqual(payload, {
    action: DEFAULT_TRIGGER_ACTION,
    params: {
      taskRef: "flywheel-123",
      taskVersion: 4,
      triggerId: "trigger-abc",
      entryUrl: "https://gecho.ai/flywheel/tasks/flywheel-123"
    }
  });
});

test("misfire policy controls whether a late task is dispatched", () => {
  assert.deepEqual(
    shouldDispatchMissedRun({ misfirePolicy: "skip" }, 1000, 5000, { graceMs: 0 }),
    { dispatch: false, reason: "MISSED_SCHEDULE" }
  );
  assert.deepEqual(
    shouldDispatchMissedRun({ misfirePolicy: "window", misfireWindowMs: 5000 }, 1000, 5000, { graceMs: 0 }),
    { dispatch: true }
  );
  assert.deepEqual(
    shouldDispatchMissedRun(normalizeMisfirePolicy({}), 1000, 5000, { graceMs: 0 }),
    { dispatch: true }
  );
});
