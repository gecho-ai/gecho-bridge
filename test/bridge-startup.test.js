const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildStartupDescriptor,
  createMacLaunchAgentPlist,
  createSystemdUserUnit,
  createWindowsTaskArgs,
  getStartupStatus,
  installStartup,
  uninstallStartup,
  writeStartupConfig
} = require("../bridge-startup.js");

const common = {
  homeDir: "/Users/test-user",
  nodePath: "/opt/node/bin/node",
  servicePath: "/Applications/Gecho Bridge/server.js",
  dataDir: "/Users/test-user/Library/Application Support/Gecho/Bridge",
  httpPort: 18793,
  wsPort: 18792,
  websiteUrl: "https://gecho.ai/",
  allowedOrigins: "https://gecho.ai"
};

test("startup descriptors cover macOS, Linux and Windows without embedding secrets", () => {
  const mac = buildStartupDescriptor({ ...common, platform: "darwin" });
  assert.equal(mac.kind, "launch_agent");
  assert.match(mac.path, /LaunchAgents/);
  assert.match(createMacLaunchAgentPlist({ ...common, label: mac.label }), /KeepAlive/);
  assert.match(createMacLaunchAgentPlist({ ...common, label: mac.label }), /Applications\/Gecho Bridge\/server.js/);
  assert.doesNotMatch(
    createMacLaunchAgentPlist({ ...common, label: mac.label, apiToken: "do-not-write" }),
    /do-not-write/
  );

  const linux = buildStartupDescriptor({ ...common, platform: "linux" });
  assert.equal(linux.kind, "systemd_user");
  assert.match(linux.path, /systemd\/user/);
  const systemdUnit = createSystemdUserUnit({ ...common, unitName: linux.unitName, apiToken: "do-not-write" });
  assert.match(systemdUnit, /Restart=on-failure/);
  assert.doesNotMatch(systemdUnit, /do-not-write/);

  const windows = buildStartupDescriptor({ ...common, platform: "win32" });
  assert.equal(windows.kind, "windows_task");
  const args = createWindowsTaskArgs({ ...common, taskName: windows.taskName });
  assert.deepEqual(args.slice(0, 4), ["/Create", "/TN", windows.taskName, "/TR"]);
  assert.ok(args.includes("/SC"));
  assert.ok(args.includes("ONLOGON"));
  assert.ok(!args.includes("do-not-write"));
});

test("writes a macOS startup definition to the requested user directory", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-startup-"));
  try {
    const descriptor = writeStartupConfig({
      ...common,
      platform: "darwin",
      homeDir: tempHome,
      servicePath: path.join(tempHome, "server.js"),
      dataDir: path.join(tempHome, "data")
    });
    assert.equal(descriptor.kind, "launch_agent");
    assert.equal(fs.existsSync(descriptor.path), true);
    assert.match(fs.readFileSync(descriptor.path, "utf8"), /RunAtLoad/);
    assert.equal((fs.statSync(descriptor.path).mode & 0o777).toString(8), "600");
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("install and uninstall use only the current user's startup target", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-startup-lifecycle-"));
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = {
    ...common,
    platform: "darwin",
    homeDir: tempHome,
    servicePath: path.join(tempHome, "server.js"),
    dataDir: path.join(tempHome, "data"),
    runCommand
  };

  try {
    const installed = installStartup(options);
    assert.equal(installed.status, "installed");
    assert.equal(calls[0].command, "launchctl");
    assert.deepEqual(calls[0].args.slice(0, 2), ["bootout", `gui/${process.getuid()}`]);
    assert.deepEqual(calls[1].args.slice(0, 2), ["bootstrap", `gui/${process.getuid()}`]);
    assert.equal(getStartupStatus(options).configured, true);

    const removed = uninstallStartup(options);
    assert.equal(removed.status, "uninstalled");
    assert.equal(fs.existsSync(installed.descriptor.path), false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
