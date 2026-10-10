"use strict";
const { normalizeActionResult, isHardActionResultFailure } = require("./action-result");
function resultEventType(result) {
  const normalized = normalizeActionResult(result);
  if (["CAPTCHA_REQUIRED", "VERIFICATION_REQUIRED"].includes(normalized.errorCode)) return "verification-required";
  return isHardActionResultFailure(normalized) || normalized.data?.error ? "task-failed" : "task-completed";
}
function createDesktopEvents(limit = 50) {
  let sequence = 0;
  const events = [];
  return {
    add(type, reference) {
      if (!["task-completed", "task-failed", "verification-required"].includes(type)) return;
      const safeReference = String(reference || "").slice(0, 120);
      if (events.some((event) => event.type === type && event.reference === safeReference)) return;
      events.push({ sequence: ++sequence, type, reference: safeReference });
      if (events.length > limit) events.shift();
    },
    list: () => events.map((event) => ({ ...event })),
  };
}
module.exports = { createDesktopEvents, resultEventType };
