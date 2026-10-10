const test = require("node:test");
const assert = require("node:assert/strict");
const { createDesktopEvents, resultEventType } = require("../desktop-events");
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
  events.add("verification-required", "captcha");
  assert.equal(events.list().length, 3);
  assert.equal(JSON.stringify(events.list()).includes("private"), false);
  assert.equal(cursor.consume("two", events.list()).length, 2);
});
test("result events distinguish legacy errors and explicit verification from successful data", () => {
  assert.equal(resultEventType({ data: { error: "failure" } }), "task-failed");
  assert.equal(resultEventType({ errorCode: "CAPTCHA_REQUIRED", data: null }), "verification-required");
  assert.equal(resultEventType({ data: [] }), "task-completed");
});
