"use strict";
function createDesktopEvents(limit = 50) {
  let sequence = 0;
  const events = [];
  return {
    add(type, reference) {
      if (!["task-completed", "task-failed", "verification-required"].includes(type)) return;
      events.push({ sequence: ++sequence, type, reference: String(reference || "").slice(0, 120) });
      if (events.length > limit) events.shift();
    },
    list: () => events.map((event) => ({ ...event })),
  };
}
module.exports = { createDesktopEvents };
