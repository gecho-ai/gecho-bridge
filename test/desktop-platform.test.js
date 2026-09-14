const test = require("node:test");
const assert = require("node:assert/strict");
const { loginItemOptions, createTrayPng } = require("../desktop/platform");

test("Windows login startup preserves the installed executable path and starts hidden", () => {
  const executable = "C:\\Users\\测试用户\\AppData\\Local\\Programs\\Gecho\\Gecho.exe";
  assert.deepEqual(loginItemOptions("win32", executable), { path: executable, args: ["--hidden"] });
  assert.deepEqual(loginItemOptions("darwin", executable), {});
});

test("Windows tray icon is a valid PNG with a visible payload", () => {
  const png = createTrayPng("win32");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 50);
});

test("macOS tray icon is a valid visible PNG", () => {
  const png = createTrayPng("darwin");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 50);
});
