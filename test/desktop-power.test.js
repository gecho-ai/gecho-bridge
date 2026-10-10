const test = require("node:test");
const assert = require("node:assert/strict");
const { createPowerGuard } = require("../desktop/power-guard");

test("power guard blocks only active work and releases on idle or shutdown", () => {
  const live = new Set();
  let starts = 0;
  const guard = createPowerGuard({
    start: (kind) => { assert.equal(kind, "prevent-app-suspension"); live.add(++starts); return starts; },
    stop: (id) => live.delete(id),
    isStarted: (id) => live.has(id),
  });
  guard.sync(false);
  assert.equal(live.size, 0);
  guard.sync(true); guard.sync(true);
  assert.equal(starts, 1);
  guard.sync(false);
  assert.equal(live.size, 0);
  guard.sync(true); guard.dispose();
  assert.equal(live.size, 0);
});
