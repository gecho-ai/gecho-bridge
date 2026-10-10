const test = require("node:test");
const assert = require("node:assert/strict");
const { createDesktopEvents } = require("../desktop-events");
const { createNotificationCursor } = require("../desktop/notifications");
test("notifications ignore old events, deduplicate polling and omit task payloads", () => {
  const events = createDesktopEvents(3);
  events.add("task-completed", "old", { cookie: "private" });
  const cursor = createNotificationCursor();
  assert.deepEqual(cursor.consume("one", events.list()), []);
  events.add("task-failed", "new");
  assert.equal(cursor.consume("one", events.list()).length, 1);
  assert.deepEqual(cursor.consume("one", events.list()), []);
  assert.deepEqual(cursor.consume("two", events.list()), []);
  events.add("task-completed", "another");
  events.add("verification-required", "captcha");
  assert.equal(events.list().length, 3);
  assert.equal(JSON.stringify(events.list()).includes("private"), false);
  assert.equal(cursor.consume("two", events.list()).length, 2);
});
