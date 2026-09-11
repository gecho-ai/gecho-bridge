"use strict";

const DEFAULT_TRIGGER_ACTION = "start_flywheel_task";
const DEFAULT_MISFIRE_POLICY = "run_once";
const DEFAULT_MISFIRE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MISFIRE_GRACE_MS = 30 * 1000;

function getDefaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function parseScheduleTime(value) {
  const text = String(value || "").trim();
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return null;
  }
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function assertTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch (_error) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function normalizeMisfirePolicy(payload = {}, fallback = {}) {
  const policy = String(
    payload.misfirePolicy ?? fallback.misfirePolicy ?? DEFAULT_MISFIRE_POLICY
  ).trim().toLowerCase();
  if (!["run_once", "skip", "window"].includes(policy)) {
    throw new Error("misfirePolicy must be one of: run_once, skip, window");
  }

  const rawWindow = payload.misfireWindowMs
    ?? fallback.misfireWindowMs
    ?? DEFAULT_MISFIRE_WINDOW_MS;
  const misfireWindowMs = Number(rawWindow);
  if (policy === "window" && (!Number.isFinite(misfireWindowMs) || misfireWindowMs < 0)) {
    throw new Error("misfireWindowMs must be a non-negative number for misfirePolicy=window");
  }

  return policy === "window"
    ? { misfirePolicy: policy, misfireWindowMs }
    : { misfirePolicy: policy };
}

function normalizeSchedule(schedule = {}) {
  const type = String(schedule.type || "").trim().toLowerCase();
  if (type === "once") {
    const runAtMs = Date.parse(String(schedule.runAt || ""));
    if (!Number.isFinite(runAtMs)) {
      throw new Error("schedule.runAt must be a valid ISO-8601 timestamp");
    }
    return { type: "once", runAt: new Date(runAtMs).toISOString() };
  }

  if (type !== "daily" && type !== "weekly") {
    throw new Error("schedule.type must be one of: once, daily, weekly");
  }

  const time = parseScheduleTime(schedule.time);
  if (!time) throw new Error("schedule.time must use HH:mm (24-hour) format");
  const timezone = String(schedule.timezone || getDefaultTimeZone()).trim();
  assertTimeZone(timezone);

  if (type === "daily") return { type, time: time.text, timezone };

  const days = Array.isArray(schedule.days)
    ? Array.from(new Set(schedule.days.map(Number))).sort((a, b) => a - b)
    : [];
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("schedule.days must contain weekday numbers 0 (Sunday) through 6 (Saturday)");
  }
  return { type, time: time.text, timezone, days };
}

function getZonedMinuteParts(timestamp, timezone, formatter) {
  const parts = formatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdayMap[values.weekday]
  };
}

function calculateNextRunAtMs(schedule, afterMs = Date.now()) {
  if (schedule?.type === "once") {
    const runAtMs = Date.parse(String(schedule.runAt || ""));
    return Number.isFinite(runAtMs) && runAtMs > afterMs ? runAtMs : 0;
  }

  if (schedule?.type !== "daily" && schedule?.type !== "weekly") return 0;
  const time = parseScheduleTime(schedule.time);
  if (!time) return 0;
  const timezone = String(schedule.timezone || getDefaultTimeZone());
  assertTimeZone(timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone
  });
  const acceptedDays = schedule.type === "weekly" ? new Set(schedule.days || []) : null;
  const start = Math.floor(afterMs / 60000) * 60000 + 60000;
  const horizon = start + 9 * 24 * 60 * 60000;

  for (let candidate = start; candidate <= horizon; candidate += 60000) {
    const parts = getZonedMinuteParts(candidate, timezone, formatter);
    if (parts.hour !== time.hour || parts.minute !== time.minute) continue;
    if (!acceptedDays || acceptedDays.has(parts.weekday)) return candidate;
  }
  return 0;
}

function getConfiguredWebsiteOrigin() {
  const raw = String(process.env.GECHO_WEBSITE_URL || "https://gecho.ai/").trim();
  try {
    return new URL(raw).origin;
  } catch (_error) {
    return "https://gecho.ai";
  }
}

function normalizeEntryUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("entryUrl is required");

  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    throw new Error("entryUrl must be a valid URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("entryUrl must use http or https");
  }

  const configuredOrigin = getConfiguredWebsiteOrigin();
  const allowLocal = process.env.GECHO_ALLOW_LOCAL_ENTRY_URL === "1";
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.origin !== configuredOrigin && !(allowLocal && isLocal)) {
    throw new Error("entryUrl must belong to the configured Gecho website origin");
  }
  return parsed.toString();
}

function normalizeTaskRef(value) {
  const taskRef = String(value || "").trim();
  if (!taskRef) throw new Error("taskRef is required");
  if (taskRef.length > 200) throw new Error("taskRef must be 200 characters or fewer");
  return taskRef;
}

function normalizeTaskVersion(value) {
  const taskVersion = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(taskVersion) || taskVersion < 1) {
    throw new Error("taskVersion must be a positive integer");
  }
  return taskVersion;
}

function normalizeScheduledTask(input = {}, { nowMs = Date.now() } = {}) {
  const taskRef = normalizeTaskRef(input.taskRef);
  const taskVersion = normalizeTaskVersion(input.taskVersion);
  const triggerAction = String(input.triggerAction || DEFAULT_TRIGGER_ACTION).trim();
  if (triggerAction !== DEFAULT_TRIGGER_ACTION) {
    throw new Error(`triggerAction must be ${DEFAULT_TRIGGER_ACTION}`);
  }
  const entryUrl = normalizeEntryUrl(input.entryUrl);
  const schedule = normalizeSchedule(input.schedule);
  const misfire = normalizeMisfirePolicy(input);
  const enabled = input.enabled !== false;
  const nextRunAtMs = enabled ? calculateNextRunAtMs(schedule, nowMs) : 0;
  if (enabled && !nextRunAtMs) {
    throw new Error("The schedule does not have a future execution time");
  }

  return {
    taskRef,
    taskVersion,
    entryUrl,
    triggerAction,
    schedule,
    ...misfire,
    enabled,
    status: enabled ? "scheduled" : "paused",
    nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null
  };
}

function createTriggerPayload(task, triggerId) {
  const normalizedTriggerId = String(triggerId || "").trim();
  if (!normalizedTriggerId) throw new Error("triggerId is required");
  return {
    action: task.triggerAction || DEFAULT_TRIGGER_ACTION,
    params: {
      taskRef: task.taskRef,
      taskVersion: task.taskVersion,
      triggerId: normalizedTriggerId,
      entryUrl: task.entryUrl
    }
  };
}

function shouldDispatchMissedRun(task, scheduledForMs, nowMs = Date.now(), { graceMs = DEFAULT_MISFIRE_GRACE_MS } = {}) {
  const lateBy = Math.max(0, nowMs - scheduledForMs);
  if (lateBy <= Math.max(0, Number(graceMs) || 0)) return { dispatch: true };
  if (task.misfirePolicy === "skip") {
    return { dispatch: false, reason: "MISSED_SCHEDULE" };
  }
  if (task.misfirePolicy === "window" && lateBy > Number(task.misfireWindowMs || 0)) {
    return { dispatch: false, reason: "MISSED_SCHEDULE" };
  }
  return { dispatch: true };
}

module.exports = {
  DEFAULT_MISFIRE_GRACE_MS,
  DEFAULT_MISFIRE_POLICY,
  DEFAULT_TRIGGER_ACTION,
  calculateNextRunAtMs,
  createTriggerPayload,
  normalizeMisfirePolicy,
  normalizeSchedule,
  normalizeScheduledTask,
  shouldDispatchMissedRun
};
