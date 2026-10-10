"use strict";
function createNotificationCursor() {
  let currentSession = null, cursor = 0;
  return {
    consume(session, events = []) {
      const safe = events.filter((event) => Number.isInteger(event.sequence) && event.sequence > 0 &&
        ["task-completed", "task-failed", "verification-required"].includes(event.type));
      const latest = Math.max(cursor, ...safe.map((event) => event.sequence));
      if (session !== currentSession) { currentSession = session; cursor = Math.max(0, ...safe.map((event) => event.sequence)); return []; }
      const fresh = safe.filter((event) => event.sequence > cursor);
      cursor = latest;
      return fresh;
    },
  };
}
module.exports = { createNotificationCursor };
