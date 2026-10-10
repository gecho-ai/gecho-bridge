"use strict";
const fs = require("node:fs");
const path = require("node:path");
const defaults = { browser: "", profile: "Default", autoRecover: false, notifications: true, shortcut: false };
function createPreferences(dataDir) {
  const file = path.join(dataDir, "desktop-preferences.json");
  let value = { ...defaults };
  try { value = normalize(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (_) {}
  function normalize(input) {
    return {
      browser: ["chrome", "edge", "brave", "arc"].includes(input.browser) ? input.browser : "",
      profile: /^(Default|Profile \d+)$/.test(input.profile) ? input.profile : "Default",
      autoRecover: input.autoRecover === true,
      notifications: input.notifications !== false,
      shortcut: input.shortcut === true,
    };
  }
  return {
    get: () => ({ ...value }),
    set(patch) {
      const next = normalize({ ...value, ...patch });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      value = next;
      return this.get();
    },
  };
}
module.exports = { createPreferences };
