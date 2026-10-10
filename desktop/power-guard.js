"use strict";

function createPowerGuard(blocker) {
  let id = null;
  const dispose = () => {
    if (id !== null && blocker.isStarted(id)) blocker.stop(id);
    id = null;
  };
  return {
    sync(active) {
      if (!active) return dispose();
      if (id === null || !blocker.isStarted(id)) id = blocker.start("prevent-app-suspension");
    },
    dispose,
  };
}

module.exports = { createPowerGuard };
